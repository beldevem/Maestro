import { log, redact } from './log.js';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { codeHostFor, missingCredentials } from './adapters/codehost/index.js';
import { pmFor } from './adapters/pm/index.js';
import { docPageIds, docsContextFor } from './adapters/docs/index.js';
import { FigmaClient, fileKeyFrom } from './adapters/design/figma.js';
import { askAssistant, askGlobalAssistant, describeAction, proposedActionSchema, type ProposedAction } from './agents/assistant.js';
import { approveDraft, backlogItemSchema, cleanItems, draftBacklog } from './agents/planner.js';
import type { CodingAgent } from './agents/coding-agent.js';
import type { Store } from './db.js';
import { bus, type BusEvent } from './events.js';
import { NotReadyError, Orchestrator } from './orchestrator.js';
import { git } from './proc.js';
import { budgetState, dailyCaps, perRunCaps, startOfToday, userOverCap } from './budget.js';
import { threadKey, titleFrom, type ChatThread, type Spent, type UserRow } from './db.js';
import { addUsage, eurPerUsd } from './usage.js';
import { checkFolder, listDirs } from './fsbrowse.js';
import { selfCheck } from './selfcheck.js';
import { appError, AppError, classify } from './errors.js';
import { generatePassword, verifyPassword } from './auth/passwords.js';
import { SYSTEM, type Role, type SessionUser } from './auth/roles.js';
import { Auth, AuthError, clearedCookie, COOKIE, readCookie, sessionCookie, sessionUser } from './auth/sessions.js';
import { actionsOf, can, CHAT_ACTION_RIGHTS, neededRoles, RIGHTS, seesAllProjects, type Action } from './auth/policy.js';
import { ROUTE_RULES, type Scope } from './auth/routes.js';
import { AUDIT_RULES, NOT_AUDITED } from './auth/audit.js';
import { DESIGN_DIR } from './adapters/design/index.js';
import { readBaseMemory } from './memory.js';
import { testConnection } from './connection-tests.js';
import { invalidSetting, NUMBER_SETTINGS } from './settings.js';
import { CLI_PRESETS, cliInstalled } from './agents/providers/cli.js';
import { chooseModel, getProvider, listProviders, projectRoles, providerSchema, ROLES, saveProviders, type ProviderConfig } from './agents/providers/config.js';
import { listModels } from './agents/providers/openai.js';
import { CLAUDE_MODELS, claudeLoginStatus, OPENAI_PRESETS } from './agents/providers/presets.js';
import { modelProblem } from './agents/providers/validate.js';
import { run as runProc } from './proc.js';
import { TEMPLATES, templateById, workflowFor } from './templates.js';
import { computeMetrics } from './metrics.js';
import { KNOWN_SECRETS, type SecretStore } from './secrets.js';
import type { Agent } from './types.js';
import { blockedBy, checkReady, parseWorkflow, validateWorkflow } from './workflow.js';

export interface ServerDeps {
  store: Store;
  secrets: SecretStore;
  agent: CodingAgent;
  orchestrator: Orchestrator;
  reposDir: string;
  dashboardDir?: string;
  /** Tests only: every request acts as this user, without logging in. */
  actAs?: SessionUser;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The logged-in user (set from the session cookie). */
    user?: SessionUser;
    /** The hash of the session that made this request. */
    sessionHash?: string;
  }
}

/** Routes that work without a session. */
const PUBLIC = new Set(['/api/health', '/api/ready', '/api/auth/status', '/api/auth/login', '/api/auth/setup']);
/** What a user who must choose a new password may still do. */
const BEFORE_PASSWORD_CHANGE = new Set(['/api/auth/status', '/api/auth/password', '/api/auth/logout']);

const codeHostSchema = z.object({
  provider: z.enum(['github', 'gitlab', 'bitbucket', 'local']),
  repo: z.string().optional(),
  baseUrl: z.string().optional(),
  localPath: z.string().optional(),
  defaultBranch: z.string().default('main'),
});
const pmSchema = z.object({ provider: z.enum(['manual', 'jira', 'trello']), settings: z.record(z.string(), z.string()).default({}) });
const designSchema = z.object({ provider: z.enum(['none', 'figma']), settings: z.record(z.string(), z.string()).default({}) });
const docsSchema = z.object({ provider: z.enum(['none', 'confluence']), settings: z.record(z.string(), z.string()).default({}) });
const projectSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(''),
  codeHost: codeHostSchema,
  pm: pmSchema.default({ provider: 'manual', settings: {} }),
  design: designSchema.default({ provider: 'none', settings: {} }),
  docs: docsSchema.default({ provider: 'none', settings: {} }),
  context: z.string().default(''),
  requirements: z.string().default(''),
  bestPractices: z.string().default(''),
  workflowYaml: z.string().optional(),
  /** Fills the workflow gates, best practices and context that were left empty. */
  template: z.string().optional(),
});
const ticketSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  acceptanceCriteria: z.string().default(''),
  size: z.string().optional(),
  labels: z.array(z.string()).default([]),
});
const agentSchema = z.object({
  provider: z.string().default(''),
  name: z.string().trim().min(1),
  role: z.enum(['worker', 'orchestrator', 'reviewer', 'planner', 'assistant']).default('worker'),
  model: z.string().default(''),
});

const NONE: Spent = { usd: 0, usage: null };
function sumSpent(values: Iterable<Spent>): Spent {
  let usd = 0;
  const usages = [];
  for (const v of values) {
    usd += v.usd;
    usages.push(v.usage);
  }
  return { usd, usage: addUsage(...usages) };
}

/** Host names the engine answers to: this machine, plus any listed in MAESTRO_ALLOWED_HOSTS (comma separated). */
export function allowedHosts(): Set<string> {
  const extra = (process.env.MAESTRO_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return new Set(['localhost', '127.0.0.1', '[::1]', '::1', ...extra]);
}

function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  const h = hostHeader.trim().toLowerCase();
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
}

export async function buildServer(d: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Every route, as "METHOD /path", so a test can check that each has a permission rule.
  const routes: string[] = [];
  app.addHook('onRoute', (o) => {
    for (const m of [o.method].flat()) if (m !== 'HEAD' && o.url.startsWith('/api/')) routes.push(`${m} ${o.url}`);
  });
  app.decorate('maestroRoutes', routes);
  await app.register(cors, { origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] });

  // The engine can run commands on this machine, so only this machine may drive it:
  // a foreign Host header means DNS rebinding, and a foreign Origin on a write means another site posting here.
  const hosts = allowedHosts();
  app.addHook('onRequest', async (req, reply) => {
    if (!hosts.has(hostnameOf(req.headers.host))) {
      return reply.status(403).send({ error: 'Maestro only answers on this machine (set MAESTRO_ALLOWED_HOSTS to allow another host name).' });
    }
    const origin = req.headers.origin;
    if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      let originHost = '';
      try {
        originHost = new URL(origin).hostname.toLowerCase();
      } catch {
        // Unparsable origins (including "null") are refused below.
      }
      if (!hosts.has(originHost) && !hosts.has(`[${originHost}]`)) {
        return reply.status(403).send({ error: 'Requests from other sites are not allowed.' });
      }
    }
  });

  // Who is asking: the session cookie, checked against the database on every request.
  const auth = new Auth(d.store);
  app.addHook('onRequest', async (req, reply) => {
    if (d.actAs) {
      req.user = d.actAs;
      return;
    }
    const found = auth.resolve(readCookie(req.headers.cookie, COOKIE));
    if (found) {
      req.user = found.user;
      req.sessionHash = found.idHash;
    }
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || PUBLIC.has(path)) return;
    if (!req.user) return reply.status(401).send({ error: 'Log in to continue.', code: 'unauthorized' });
    if (req.user.mustChangePassword && !BEFORE_PASSWORD_CHANGE.has(path)) {
      return reply.status(403).send({ error: 'Choose a new password first.', code: 'password_change_required' });
    }
  });
  const secure = (req: { protocol: string }) => req.protocol === 'https';

  // What they may do: every API route has a rule (ROUTE_RULES); a route without one is refused.
  const projectOf = (scope: Scope | undefined, params: Record<string, string>): string | null => {
    if (!scope || !params.id) return null;
    if (scope === 'project') return params.id;
    if (scope === 'run') return d.store.getRun(params.id)?.projectId ?? null;
    return d.store.getDraft(params.id)?.projectId ?? null;
  };
  app.addHook('preHandler', async (req, reply) => {
    const url = req.routeOptions.url;
    if (!url?.startsWith('/api/')) return;
    const rule = ROUTE_RULES[`${req.method === 'HEAD' ? 'GET' : req.method} ${url}`];
    if (!rule) return reply.status(403).send({ error: 'This route has no permission rule.', code: 'forbidden' });
    if (rule.action === 'public' || rule.action === 'session') return;
    const user = req.user!;
    const projectId = projectOf(rule.scope, req.params as Record<string, string>);
    if (can(user, rule.action, projectId, d.store)) return;
    // Someone who could do this, but not in a project they can't see: the project doesn't exist for them.
    if (projectId && RIGHTS[rule.action].some((r) => user.roles.includes(r))) {
      return reply.status(404).send({ error: 'Project not found.', code: 'not_found' });
    }
    return reply.status(403).send({ error: `This needs ${neededRoles(rule.action)}.`, code: 'forbidden', needs: RIGHTS[rule.action] });
  });
  /** The projects a user can see: all for a Tech Lead, else those they're a member of. */
  const visibleTo = (user: SessionUser | undefined) => {
    const all = d.store.listProjects();
    if (!user) return [];
    if (seesAllProjects(user)) return all;
    const mine = d.store.memberProjectIds(user.id);
    return all.filter((p) => mine.has(p.id));
  };
  const visibleIds = (user: SessionUser | undefined) => new Set(visibleTo(user).map((p) => p.id));
  // The activity log: every change that succeeded, with the user behind it (rules in auth/audit.ts).
  app.addHook('onResponse', async (req, reply) => {
    const url = req.routeOptions.url;
    if (!url?.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const key = `${req.method} ${url}`;
    const params = (req.params ?? {}) as Record<string, string>;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      if (key === 'POST /api/auth/login') {
        // Logins, and refused logins (by email; never the password).
        const ok = reply.statusCode < 400;
        const u = typeof body.email === 'string' ? d.store.getUserByEmail(body.email) : undefined;
        d.store.addAudit({ userId: u?.id ?? 'anonymous', action: ok ? 'auth.login' : 'auth.login_failed', targetType: 'user', targetId: u?.id, detail: ok ? null : { email: String(body.email ?? '').slice(0, 254), status: reply.statusCode, address: req.ip } });
        return;
      }
      if (reply.statusCode >= 400 || NOT_AUDITED.has(key)) return;
      const rule = AUDIT_RULES[key];
      const userId = req.user?.id ?? (key === 'POST /api/auth/setup' ? d.store.getUserByEmail(String(body.email ?? ''))?.id : undefined) ?? 'anonymous';
      const routeRule = ROUTE_RULES[key];
      const projectId = routeRule?.scope ? projectOf(routeRule.scope, params) : null;
      d.store.addAudit({
        userId,
        action: rule?.action ?? key,
        targetType: rule?.target ?? null,
        targetId: (rule?.id ? rule.id(params, body) : params.id) ?? null,
        projectId: projectId ?? (url.startsWith('/api/projects/:id') ? params.id : null),
        detail: rule?.detail?.(params, body) ?? null,
      });
    } catch (e) {
      log.error('Could not write the activity log', { route: key, error: e as Error });
    }
  });

  /** Inside a route: refuse unless the user may do `action` (on `projectId`). */
  const must = (req: { user?: SessionUser }, action: Action, projectId?: string | null) => {
    if (!can(req.user, action, projectId, d.store)) throw Object.assign(new Error(`This needs ${neededRoles(action)}.`), { statusCode: 403 });
  };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; '), code: 'invalid_input' });
    if (err instanceof NotReadyError) return reply.status(409).send({ error: err.message, code: 'ticket_not_ready', reasons: err.reasons, hint: 'Fix what is listed, or start it anyway.' });
    if (err instanceof AuthError) return reply.status(err.statusCode).send({ error: err.message, code: err.code });
    // Known kinds of failure get a code and a fix; anything else keeps its own message.
    const known = classify(err);
    const status = known?.statusCode ?? (err as { statusCode?: number }).statusCode ?? 400;
    const message = redact(known?.message ?? (err instanceof Error ? err.message : String(err)));
    const code = known?.code ?? (status === 404 ? 'not_found' : status === 403 ? 'forbidden' : status === 409 ? 'conflict' : status === 429 ? 'limit_reached' : status >= 500 ? 'internal' : 'invalid_request');
    if (status >= 500) log.error('Request failed', { method: req.method, url: req.url.split('?')[0], status, code, error: message });
    else log.debug('Request refused', { method: req.method, url: req.url.split('?')[0], status, code, error: message });
    return reply.status(status).send({ error: message, code, ...(known?.hint ? { hint: redact(known.hint) } : {}) });
  });

  /** A local folder must exist and be a git repository; remote hosts need their repository name. */
  const checkCodeHost = (c: z.infer<typeof codeHostSchema>) => {
    if (c.provider === 'local') {
      const path = c.localPath?.trim() ?? '';
      if (!path) throw appError('folder_missing', 'Give the folder of the local repository.', 400, 'Use Browse… next to the folder path.');
      if (!isAbsolute(path)) throw appError('folder_relative', `${path} is not a full path.`, 400, 'Start it with / (for example /home/you/projects/app), or use Browse….');
      if (!existsSync(path)) {
        throw appError('folder_missing', `${path} doesn't exist${existsSync('/.dockerenv') ? ' inside the container' : ''}.`, 400,
          existsSync('/.dockerenv') ? 'Put the repository under PROJECTS_DIR (mounted in Docker), or mount its folder in docker-compose.override.yml.' : 'Check the path, or use Browse….');
      }
      if (!statSync(path).isDirectory()) throw appError('folder_missing', `${path} is a file, not a folder.`, 400);
      if (!existsSync(join(path, '.git'))) throw appError('not_git_repo', `${path} isn't a git repository.`, 400, 'Run "git init" there and make a first commit, then save again.');
    } else if (!c.repo?.trim()) {
      throw appError('repo_missing', `Give the ${c.provider === 'github' ? 'GitHub repository (owner/name)' : c.provider === 'gitlab' ? 'GitLab project path (group/project)' : 'Bitbucket repository (workspace/repo)'}.`, 400);
    } else if (!/^[\w.-]+(\/[\w.-]+)+$/.test(c.repo.trim())) {
      throw appError('repo_invalid', `"${c.repo}" doesn't look like a repository path.`, 400, 'Use the form owner/name, as in the repository URL.');
    }
  };
  const project = (id: string) => {
    const p = d.store.getProject(id);
    if (!p) throw Object.assign(new Error('Project not found.'), { statusCode: 404 });
    return p;
  };
  const draft = (id: string) => {
    const dr = d.store.getDraft(id);
    if (!dr) throw Object.assign(new Error('Draft not found.'), { statusCode: 404 });
    return dr;
  };
  const repoDir = (p: ReturnType<typeof project>) => (p.codeHost.provider === 'local' ? p.codeHost.localPath ?? '' : join(d.reposDir, p.id));
  const planning = new Set<string>();
  /** Runs the planner once per project at a time and stores the draft. */
  const plan = async (p: ReturnType<typeof project>, userId: string | null) => {
    const personal = userOverCap(d.store, userId);
    if (personal) throw Object.assign(new Error(personal), { statusCode: 429 });
    if (planning.has(p.id)) throw Object.assign(new Error('The planner is already working on this project.'), { statusCode: 409 });
    const budget = budgetState(d.store, p.id);
    if (budget.over) throw new Error(`${p.name} has reached its daily budget of ${budget.over}.`);
    planning.add(p.id);
    try {
      const tickets = await pmFor(p, d.store, d.secrets).listTickets();
      // Planning reads the code, so a remote repository is cloned first; without it the planner works from the requirements alone.
      const repo = await codeHostFor(p, d.secrets, d.reposDir).ensureRepo(p).catch((e: Error) => {
        log.error(`Planning ${p.name} without the code: ${e.message}`);
        return '';
      });
      const cwd = repo && existsSync(repo) ? repo : tmpdir();
      const docs = await docsContextFor(p, d.secrets);
      const memory = repo ? await readBaseMemory(repo, parseWorkflow(p.workflowYaml).base_branch, p.codeHost.provider === 'local') : '';
      const draft = await draftBacklog(d, p, tickets, cwd, { docs, memory });
      d.store.addSpend(p.id, null, 'planner', draft.costUsd, draft.usage, userId);
      return draft;
    } finally {
      planning.delete(p.id);
    }
  };

  const agentAction = (a: Agent, action: 'pause' | 'resume' | 'unblock' | undefined) => {
    if (action === 'pause' && a.state !== 'available') throw new Error('Only an available agent can be paused; stop its run first.');
    const next =
      action === 'pause' ? { state: 'paused' as const, note: 'Paused by you' }
      : action === 'resume' && a.state === 'paused' ? { state: 'available' as const, note: '' }
      : action === 'unblock' && a.state === 'blocked' ? { state: 'available' as const, currentRunId: null, note: '' }
      : null;
    if (!next) throw new Error(`Can't ${action} an agent that is ${a.state}.`);
    const updated = d.store.updateAgent(a.id, next)!;
    bus.publish({ type: 'agent', agent: updated });
    return updated;
  };

  /** Proposed actions can be confirmed for an hour; each runs at most once. */
  const PROPOSAL_TTL_MS = 60 * 60_000;
  /** The project an action is for: the chat's own project, else the one the action names (or the only one there is). */
  const actionProject = (scope: ReturnType<typeof project> | null, a: ProposedAction, user?: SessionUser) => {
    if (scope) return scope;
    const all = user ? visibleTo(user) : d.store.listProjects();
    const name = 'project' in a ? a.project?.trim().toLowerCase() : undefined;
    const found = name ? all.find((x) => x.name.toLowerCase() === name) : all.length === 1 ? all[0] : undefined;
    if (!found) throw new Error(name ? `No project called "${'project' in a ? a.project : ''}".` : 'Say which project this is for.');
    return found;
  };
  /** The chat only offers what the asker could confirm (a Project Manager never gets agent work). */
  const allowedProposals = (user: SessionUser | undefined, actions: ProposedAction[]) =>
    actions.filter((a) => user && RIGHTS[CHAT_ACTION_RIGHTS[a.type] ?? 'settings.manage'].some((r) => user.roles.includes(r)));
  /** Confirming a chat proposal needs the right to do it, in that project. */
  const mayConfirm = (user: SessionUser | undefined, scope: ReturnType<typeof project> | null, a: ProposedAction) => {
    const action = CHAT_ACTION_RIGHTS[a.type];
    if (!action) throw Object.assign(new Error('Unknown proposal.'), { statusCode: 400 });
    must({ user }, action, a.type === 'pause_agent' || a.type === 'resume_agent' ? null : actionProject(scope, a, user).id);
  };
  const runAction = async (scope: ReturnType<typeof project> | null, a: ProposedAction, by: string | null = null): Promise<{ message: string; runId?: string }> => {
    if (a.type === 'pause_agent' || a.type === 'resume_agent') {
      const agent = d.store.listAgents().find((x) => x.name.toLowerCase() === a.agentName.toLowerCase());
      if (!agent) throw new Error(`No agent called ${a.agentName}.`);
      agentAction(agent, a.type === 'pause_agent' ? 'pause' : 'resume');
      return { message: `${agent.name} is ${a.type === 'pause_agent' ? 'paused' : 'available again'}.` };
    }
    const p = actionProject(scope, a);
    const pm = pmFor(p, d.store, d.secrets);
    switch (a.type) {
      case 'create_ticket': {
        const t = await pm.createTicket({ title: a.title, description: a.description, acceptanceCriteria: a.acceptanceCriteria, size: a.size ?? undefined, labels: a.labels });
        return { message: `Created ${t.key}.` };
      }
      case 'assign': {
        const run = await d.orchestrator.start(p.id, a.ticketKey, { startedBy: by, trigger: 'chat' });
        return { message: `${a.ticketKey} is assigned to ${d.store.getAgent(run.agentId)?.name ?? 'a worker'}.`, runId: run.id };
      }
      case 'move_ticket':
        if (!(await pm.getTicket(a.ticketKey))) throw new Error(`Ticket ${a.ticketKey} not found.`);
        await pm.moveTicket(a.ticketKey, a.status);
        void d.orchestrator.tick();
        return { message: `Moved ${a.ticketKey} to ${a.status.replace('_', ' ')}.` };
      case 'plan_backlog':
        void plan(p, by).catch((e) => log.error(`Planning from chat failed: ${(e as Error).message}`));
        return { message: 'The planner is working; the draft shows up on the Board when it is done.' };
    }
  };

  // Folder picker for local-folder projects: subfolders only, inside the allowed roots
  app.get<{ Querystring: { path?: string; hidden?: string } }>('/api/fs/dirs', async (req) => {
    const q = z.object({ path: z.string().max(4096).optional(), hidden: z.enum(['0', '1', 'true', 'false']).optional() }).parse(req.query);
    return listDirs(q.path, { hidden: q.hidden === '1' || q.hidden === 'true' });
  });
  app.get<{ Querystring: { path?: string } }>('/api/fs/check', async (req) => {
    const { path } = z.object({ path: z.string().min(1).max(4096) }).parse(req.query);
    return checkFolder(path);
  });

  // Accounts: first-run setup, login, logout, your own password
  app.get('/api/auth/status', async (req) => ({ setupNeeded: d.store.countUsers() === 0, user: req.user ?? null }));
  app.post('/api/auth/setup', async (req, reply) => {
    const body = z.object({ email: z.string().max(254), name: z.string().max(100), password: z.string().max(256) }).parse(req.body);
    // Only the very first account is made here; after that, Project Managers add people.
    if (d.store.countUsers() > 0) throw new AuthError('Maestro is already set up. Log in instead.', 409, 'already_set_up');
    const u = await auth.createUser({ ...body, roles: ['pm', 'lead'] });
    d.store.claimUnowned(u.id);
    log.info('First account created', { user: u.email });
    reply.header('set-cookie', sessionCookie(auth.startSession(u.id, req.headers['user-agent'] ?? null), secure(req)));
    return { user: sessionUser(u) };
  });
  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ email: z.string().max(254), password: z.string().max(256) }).parse(req.body);
    try {
      const u = await auth.login(body.email, body.password, req.ip);
      reply.header('set-cookie', sessionCookie(auth.startSession(u.id, req.headers['user-agent'] ?? null), secure(req)));
      log.info('Logged in', { user: u.email });
      return { user: sessionUser(u) };
    } catch (e) {
      if (e instanceof AuthError) log.warn('Login refused', { email: body.email, reason: e.code, address: req.ip });
      throw e;
    }
  });
  app.post('/api/auth/logout', async (req, reply) => {
    auth.endSession(readCookie(req.headers.cookie, COOKIE));
    reply.header('set-cookie', clearedCookie(secure(req)));
    return { ok: true };
  });
  /** Changes your own password; your other browsers are logged out. */
  app.post('/api/auth/password', async (req) => {
    const body = z.object({ current: z.string().max(256), next: z.string().max(256) }).parse(req.body);
    const u = d.store.getUser(req.user!.id);
    if (!u || !(await verifyPassword(body.current, u.passwordHash))) throw new AuthError('Your current password is wrong.', 400, 'bad_credentials');
    if (body.current === body.next) throw new AuthError('Choose a password different from the current one.', 400, 'same_password');
    await auth.setPassword(u.id, body.next, { keepSession: req.sessionHash });
    return { user: sessionUser(d.store.getUser(u.id)!) };
  });

  // People (Project Managers manage them) and who belongs to which project
  const roleList = z.array(z.enum(['pm', 'lead', 'dev'])).min(1, 'Give at least one role.').transform((r) => [...new Set(r)]);
  const activeManagers = () => d.store.listUsers().filter((u) => !u.deactivatedAt && u.roles.includes('pm'));
  /** Maestro always keeps one active Project Manager, so someone can still manage people. */
  const keepAManager = (userId: string, after: { roles?: Role[]; deactivated?: boolean }) => {
    const left = activeManagers().filter((u) => u.id !== userId);
    const stays = !after.deactivated && (after.roles ?? d.store.getUser(userId)?.roles ?? []).includes('pm');
    if (!left.length && !stays) throw Object.assign(new Error('Maestro needs at least one Project Manager. Give the role to someone else first.'), { statusCode: 409 });
  };
  const userView = (u: UserRow) => ({
    id: u.id, email: u.email, name: u.name, roles: u.roles, active: !u.deactivatedAt, mustChangePassword: u.mustChangePassword,
    locked: !!u.lockedUntil && Date.parse(u.lockedUntil) > Date.now(), lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
    projects: [...d.store.memberProjectIds(u.id)],
  });
  const person = (id: string) => {
    const u = d.store.getUser(id);
    if (!u) throw Object.assign(new Error('User not found.'), { statusCode: 404 });
    return u;
  };
  /** Project Managers get everyone in full and every project (to add people to them); others get names and roles. */
  app.get('/api/users', async (req) => {
    const users = d.store.listUsers();
    if (can(req.user, 'users.manage')) return { users: users.map(userView), projects: d.store.listProjects().map((p) => ({ id: p.id, name: p.name })) };
    return { users: users.filter((u) => !u.deactivatedAt).map((u) => ({ id: u.id, name: u.name, roles: u.roles, active: true })) };
  });
  /** Adds a person with a one-time password, shown once, which they replace at first login. */
  app.post('/api/users', async (req) => {
    const body = z.object({ email: z.string().max(254), name: z.string().max(100), roles: roleList, projects: z.array(z.string()).default([]) }).parse(req.body);
    const password = generatePassword();
    const u = await auth.createUser({ ...body, password, mustChangePassword: true });
    for (const pid of body.projects) if (d.store.getProject(pid)) d.store.addMember(pid, u.id, req.user!.id);
    return { user: userView(u), password };
  });
  app.patch<{ Params: { id: string } }>('/api/users/:id', async (req) => {
    const u = person(req.params.id);
    const body = z.object({ name: z.string().trim().min(1).max(100).optional(), roles: roleList.optional(), active: z.boolean().optional() }).parse(req.body);
    if (body.active === false && u.id === req.user!.id) throw Object.assign(new Error("You can't deactivate your own account."), { statusCode: 409 });
    keepAManager(u.id, { roles: body.roles, deactivated: body.active === false || (body.active === undefined && !!u.deactivatedAt) });
    const lostRole = body.roles && u.roles.some((r) => !body.roles!.includes(r));
    d.store.updateUser(u.id, { name: body.name, roles: body.roles, deactivatedAt: body.active === undefined ? undefined : body.active ? null : new Date().toISOString() });
    // Fewer rights, or no access at all: their sessions end (yours too if it's you, except this one).
    if (lostRole || body.active === false) d.store.deleteUserSessions(u.id, u.id === req.user!.id ? req.sessionHash : undefined);
    return userView(d.store.getUser(u.id)!);
  });
  app.post<{ Params: { id: string } }>('/api/users/:id/reset-password', async (req) => {
    const u = person(req.params.id);
    const password = generatePassword();
    await auth.setPassword(u.id, password, { mustChange: true });
    return { password };
  });
  /** Deleting deactivates: the person can't log in, and the activity log still shows who did what. */
  app.delete<{ Params: { id: string } }>('/api/users/:id', async (req) => {
    const u = person(req.params.id);
    if (u.id === req.user!.id) throw Object.assign(new Error("You can't delete your own account."), { statusCode: 409 });
    keepAManager(u.id, { deactivated: true });
    d.store.updateUser(u.id, { deactivatedAt: new Date().toISOString() });
    d.store.deleteUserSessions(u.id);
    for (const pid of d.store.memberProjectIds(u.id)) d.store.removeMember(pid, u.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/members', async (req) => {
    const p = project(req.params.id);
    return d.store.listMembers(p.id).flatMap((m) => {
      const u = d.store.getUser(m.userId);
      return u && !u.deactivatedAt ? [{ userId: u.id, name: u.name, roles: u.roles, addedAt: m.addedAt }] : [];
    });
  });
  app.put<{ Params: { id: string; userId: string } }>('/api/projects/:id/members/:userId', async (req) => {
    const p = project(req.params.id);
    const u = person(req.params.userId);
    if (u.deactivatedAt) throw Object.assign(new Error(`${u.name}'s account is deactivated.`), { statusCode: 409 });
    d.store.addMember(p.id, u.id, req.user!.id);
    return { ok: true };
  });
  app.delete<{ Params: { id: string; userId: string } }>('/api/projects/:id/members/:userId', async (req) => {
    const p = project(req.params.id);
    d.store.removeMember(p.id, person(req.params.userId).id);
    return { ok: true };
  });

  /** The activity log: everyone's for Project Managers and Tech Leads (in the projects they see), your own otherwise. */
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/activity', async (req) => {
    const q = z.object({
      userId: z.string().optional(), projectId: z.string().optional(), action: z.string().max(60).optional(),
      since: z.string().datetime().optional(), until: z.string().datetime().optional(),
      before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(req.query);
    const all = can(req.user, 'activity.viewAll');
    const userId = all ? q.userId : req.user!.id;
    if (q.projectId) seenProject(req.user, q.projectId);
    const entries = d.store.listAudit({ ...q, userId, projectIds: seesAllProjects(req.user!) ? undefined : visibleIds(req.user) });
    const names = new Map(d.store.listUsers().map((u) => [u.id, u.name]));
    const projectNames = new Map(d.store.listProjects().map((p) => [p.id, p.name]));
    return entries.map((e) => ({
      ...e,
      userName: e.userId === SYSTEM ? 'Maestro' : e.userId === 'anonymous' ? 'Someone (not logged in)' : names.get(e.userId) ?? 'Removed user',
      projectName: e.projectId ? projectNames.get(e.projectId) ?? 'Removed project' : null,
    }));
  });

  /**
   * Usage per person in the projects the asker sees (plus cross-project chat): tokens, USD (for the ≈ € estimate),
   * runs they started and how many succeeded. Without usage.viewAll, only your own row.
   */
  const usageByUser = (user: SessionUser, sinceIso: string, projectId?: string) => {
    const ids = projectId ? new Set([projectId]) : new Set([...visibleIds(user), ...(projectId ? [] : [GLOBAL])]);
    const spend = d.store.spendByUser(sinceIso, ids);
    const runs = d.store.listAllRuns(projectId).filter((r) => r.startedAt >= sinceIso && ids.has(r.projectId));
    const people = new Map(d.store.listUsers().map((u) => [u.id, u]));
    const who = new Set([...spend.keys(), ...runs.map((r) => r.startedBy ?? SYSTEM)]);
    const rows = [...who].map((id) => {
      const mine = runs.filter((r) => (r.startedBy ?? SYSTEM) === id);
      const finished = mine.filter((r) => !['running', 'reviewing'].includes(r.status));
      const ok = finished.filter((r) => r.readyAt || ['in_review', 'done'].includes(r.status));
      const u = people.get(id);
      return {
        userId: id, name: id === SYSTEM ? 'Maestro (reviewer, automatic)' : u?.name ?? 'Removed user', roles: u?.roles ?? [], active: id === SYSTEM || (!!u && !u.deactivatedAt),
        usd: spend.get(id)?.usd ?? 0, usage: spend.get(id)?.usage ?? null, runs: mine.length, successRate: finished.length ? ok.length / finished.length : null,
      };
    });
    const visible = can(user, 'usage.viewAll') ? rows : rows.filter((r) => r.userId === user.id);
    return visible.sort((a, b) => (b.usage ? b.usage.input + b.usage.output + b.usage.cache : 0) - (a.usage ? a.usage.input + a.usage.output + a.usage.cache : 0) || b.runs - a.runs);
  };
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/usage/users', async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(0).max(3650).default(0), projectId: z.string().optional(), today: z.enum(['1', 'true']).optional() }).parse(req.query);
    if (q.projectId) seenProject(req.user, q.projectId);
    const since = q.today ? startOfToday() : q.days > 0 ? new Date(Date.now() - q.days * 86_400_000).toISOString() : '';
    return usageByUser(req.user!, since, q.projectId);
  });

  /** What could stop Maestro from working, with how to fix it (Settings → System check). */
  app.get('/api/system/checks', async () => selfCheck({ store: d.store, secrets: d.secrets, home: dirname(d.reposDir), dashboardDir: d.dashboardDir }));

  /** What you may do, so the dashboard can hide or disable the rest. */
  app.get('/api/me/rights', async (req) => ({ actions: actionsOf(req.user!), seesAllProjects: seesAllProjects(req.user!), table: RIGHTS }));

  /** Liveness: the process answers. */
  app.get('/api/health', async () => ({ ok: true }));
  /** Readiness: the database answers and the engine isn't shutting down. */
  app.get('/api/ready', async (_req, reply) => {
    try {
      d.store.db.prepare('SELECT 1').get();
    } catch (e) {
      return reply.status(503).send({ ready: false, reason: `Database: ${(e as Error).message}` });
    }
    if (d.orchestrator.isStopping) return reply.status(503).send({ ready: false, reason: 'Shutting down.' });
    return { ready: true, schema: d.store.schemaVersion() };
  });

  // Projects
  app.get('/api/projects', async (req) => visibleTo(req.user));
  app.get('/api/templates', async () => TEMPLATES.map(({ id, name, description, bestPractices, gates }) => ({ id, name, description, bestPractices, gates })));
  app.post('/api/projects', async (req) => {
    const { template: templateId, ...body } = projectSchema.parse(req.body);
    const template = templateById(templateId);
    if (templateId && !template) throw new Error(`Unknown template "${templateId}".`);
    if (template) {
      body.workflowYaml ||= workflowFor(template);
      body.bestPractices ||= template.bestPractices;
      body.context ||= template.context;
    }
    if (body.workflowYaml) {
      const v = validateWorkflow(body.workflowYaml);
      if (!v.ok) throw appError('workflow_invalid', `Workflow config: ${v.error}`, 400, 'Fix the YAML on the Workflow tab; the default workflow is in the user guide.');
    }
    checkCodeHost(body.codeHost);
    return d.store.createProject(body);
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req) => project(req.params.id));
  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    project(req.params.id);
    // partial() still fills in defaults, so keep only the fields the request sent; otherwise saving one tab resets the others.
    const sent = Object.keys((req.body ?? {}) as object);
    const patch = Object.fromEntries(
      Object.entries(projectSchema.partial().parse(req.body)).filter(([k]) => sent.includes(k) && k !== 'template'),
    ) as Partial<z.infer<typeof projectSchema>>;
    if (patch.workflowYaml !== undefined) {
      const v = validateWorkflow(patch.workflowYaml);
      if (!v.ok) throw appError('workflow_invalid', `Workflow config: ${v.error}`, 400, 'Fix the YAML; the default workflow is in the user guide.');
    }
    if (patch.codeHost) checkCodeHost(patch.codeHost);
    return d.store.updateProject(req.params.id, patch);
  });
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    const busy = d.store.listRuns(req.params.id).filter((r) => d.orchestrator.isActive(r.id) || ['running', 'reviewing'].includes(r.status));
    if (busy.length) throw appError('project_busy', `${busy.length} run${busy.length === 1 ? ' is' : 's are'} still working in this project (${busy.map((r) => r.ticketKey).join(', ')}).`, 409, 'Stop them on the run page first, then delete the project.');
    d.store.deleteProject(req.params.id);
    return { ok: true };
  });

  // Tickets (live in the project's PM tool)
  app.get<{ Params: { id: string } }>('/api/projects/:id/tickets', async (req) => {
    const p = project(req.params.id);
    const wf = parseWorkflow(p.workflowYaml);
    const tickets = await pmFor(p, d.store, d.secrets).listTickets();
    const deps = d.store.dependencies(p.id);
    const blocked = blockedBy(tickets, deps, wf.orchestration.dependency_ready_when);
    return tickets.map((t) => ({ ...t, notReady: checkReady(wf, t), dependsOn: deps.get(t.key) ?? [], blockedBy: blocked.get(t.key) ?? [] }));
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/tickets', async (req) => {
    const p = project(req.params.id);
    return pmFor(p, d.store, d.secrets).createTicket(ticketSchema.parse(req.body));
  });
  app.post<{ Params: { id: string; key: string }; Body: { agentId?: string; force?: boolean } }>(
    '/api/projects/:id/tickets/:key/start',
    async (req) => d.orchestrator.start(req.params.id, req.params.key, { ...z.object({ agentId: z.string().optional(), force: z.boolean().optional() }).parse(req.body ?? {}), startedBy: req.user!.id, trigger: 'manual' }),
  );
  // Projects without a PM tool have nowhere else to move tickets, e.g. to done after review.
  app.post<{ Params: { id: string; key: string } }>('/api/projects/:id/tickets/:key/status', async (req) => {
    const p = project(req.params.id);
    if (p.pm.provider !== 'manual') throw new Error(`Change the ticket's status in ${p.pm.provider === 'jira' ? 'Jira' : 'Trello'}.`);
    const { status } = z.object({ status: z.enum(['todo', 'in_progress', 'in_review', 'done']) }).parse(req.body);
    if (!d.store.getManualTicket(p.id, req.params.key)) throw Object.assign(new Error('Ticket not found.'), { statusCode: 404 });
    d.store.setManualTicketStatus(p.id, req.params.key, status);
    void d.orchestrator.tick();
    return d.store.getManualTicket(p.id, req.params.key);
  });

  // Auto-assign toggle for the board
  app.get<{ Params: { id: string } }>('/api/projects/:id/auto-assign', async (req) => ({
    enabled: d.orchestrator.autoAssignEnabled(project(req.params.id)),
  }));
  app.put<{ Params: { id: string } }>('/api/projects/:id/auto-assign', async (req) => {
    const p = project(req.params.id);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    d.store.setSetting(`autoAssign.${p.id}`, String(enabled));
    // Runs it starts are attributed to whoever switched it on.
    if (enabled) d.store.setSetting(`autoAssignBy.${p.id}`, req.user!.id);
    if (enabled) void d.orchestrator.tick();
    return { enabled };
  });

  // Planner: drafts a backlog you review before any ticket is created
  app.post<{ Params: { id: string } }>('/api/projects/:id/plan', async (req) => {
    return plan(project(req.params.id), req.user!.id);
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id/drafts', async (req) => d.store.listDrafts(project(req.params.id).id));
  app.patch<{ Params: { id: string } }>('/api/drafts/:id', async (req) => {
    const dr = draft(req.params.id);
    if (dr.status !== 'draft') throw Object.assign(new Error(`This draft is already ${dr.status}.`), { statusCode: 409 });
    if (dr.createdKeys.some(Boolean)) throw Object.assign(new Error('Some tickets were already created from this draft; approve it again to finish.'), { statusCode: 409 });
    const { items } = z.object({ items: z.array(backlogItemSchema) }).parse(req.body);
    return d.store.updateDraft(dr.id, { items: cleanItems(items) });
  });
  app.post<{ Params: { id: string } }>('/api/drafts/:id/approve', async (req) => {
    const dr = draft(req.params.id);
    if (dr.status !== 'draft') throw Object.assign(new Error(`This draft is already ${dr.status}.`), { statusCode: 409 });
    const result = await approveDraft(d.store, pmFor(project(dr.projectId), d.store, d.secrets), dr);
    if (!result.error) void d.orchestrator.tick();
    return result;
  });
  app.post<{ Params: { id: string } }>('/api/drafts/:id/discard', async (req) => {
    const dr = draft(req.params.id);
    if (dr.status !== 'draft') throw Object.assign(new Error(`This draft is already ${dr.status}.`), { statusCode: 409 });
    return d.store.updateDraft(dr.id, { status: 'discarded' });
  });

  // Runs
  app.get<{ Querystring: { projectId?: string } }>('/api/runs', async (req) => {
    const ids = visibleIds(req.user);
    return d.store.listRuns(req.query.projectId).filter((r) => ids.has(r.projectId));
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req) => {
    const run = d.store.getRun(req.params.id);
    if (!run) throw Object.assign(new Error('Run not found.'), { statusCode: 404 });
    return { ...run, active: d.orchestrator.isActive(run.id), events: d.store.listEvents(run.id), reviews: d.store.listReviews(run.id) };
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/merge', async (req) => d.orchestrator.mergeLocal(req.params.id));
  app.post<{ Params: { id: string } }>('/api/runs/:id/reviews', async (req) => {
    const body = z
      .object({
        verdict: z.enum(['approve', 'changes_requested']),
        summary: z.string().default(''),
        comments: z.array(z.object({ file: z.string().nullable().default(null), line: z.number().int().positive().nullable().default(null), body: z.string().min(1) })).default([]),
      })
      .parse(req.body);
    if (body.verdict === 'changes_requested' && !body.summary.trim() && !body.comments.length) throw new Error('Say what to change.');
    return d.orchestrator.humanReview(req.params.id, body);
  });

  // Pull requests (and local branches) waiting for or going through review
  app.get('/api/pull-requests', async (req) => {
    const projects = new Map(visibleTo(req.user).map((p) => [p.id, p.name]));
    return d.store
      .listRuns()
      .filter((r) => projects.has(r.projectId))
      .filter((r) => r.prUrl || ['reviewing', 'in_review'].includes(r.status) || (r.status === 'running' && r.reviewRounds > 0))
      .map((r) => {
        const reviews = d.store.listReviews(r.id);
        const agentReview = reviews.filter((x) => x.source === 'agent').at(-1);
        return {
          ...r,
          projectName: projects.get(r.projectId) ?? 'Removed project',
          reviewerVerdict: agentReview?.verdict ?? null,
          openComments: d.store.pendingFeedback(r.id).reduce((n, x) => n + Math.max(1, x.comments.length), 0),
          reviewCount: reviews.length,
        };
      });
  });
  app.post('/api/pull-requests/poll', async () => {
    await d.orchestrator.pollPullRequests();
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/diff', async (req) => {
    const run = d.store.getRun(req.params.id);
    if (!run || !existsSync(run.worktree)) throw Object.assign(new Error('The run has no worktree any more.'), { statusCode: 404 });
    const p = project(run.projectId);
    const base = parseWorkflow(p.workflowYaml).base_branch;
    // The whole change against where the run started: every commit (including review fixes) plus what isn't committed yet.
    const from = run.baseRef ?? base;
    const paths = ['--', '.', `:(exclude)${DESIGN_DIR}`];
    const [commits, diff, untracked] = await Promise.all([
      git(run.worktree, ['log', '--format=%h %s', `${from}..HEAD`]),
      git(run.worktree, ['diff', '--stat', '--patch', from, ...paths]),
      git(run.worktree, ['ls-files', '--others', '--exclude-standard', ...paths]),
    ]);
    const parts = [
      commits && `Commits:\n${commits}`,
      untracked && `New files not committed yet:\n${untracked}`,
      diff,
    ];
    return { base, diff: parts.filter(Boolean).join('\n\n') };
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/stop', async (req) => ({ stopped: d.orchestrator.stop(req.params.id) }));
  app.post<{ Params: { id: string } }>('/api/projects/:id/cleanup', async (req) => ({
    removed: await d.orchestrator.cleanupFinished(0, project(req.params.id).id),
  }));
  app.delete<{ Params: { id: string } }>('/api/runs/:id/worktree', async (req) => {
    const run = d.store.getRun(req.params.id);
    if (!run) throw Object.assign(new Error('Run not found.'), { statusCode: 404 });
    await d.orchestrator.cleanup(run, project(run.projectId));
    return { ok: true };
  });

  /** Rejects an unknown provider, or a model the provider doesn't offer. */
  const checkChoice = async (c: { provider: string; model?: string }) => {
    const p = getProvider(d.store, c.provider);
    if (!p) throw new Error(`No AI provider called "${c.provider}".`);
    const problem = await modelProblem(p, c.model ?? '', () => listModels(p, p.apiKeySecret ? d.secrets.get(p.apiKeySecret) : undefined));
    if (problem) throw new Error(problem);
  };

  // Agents
  app.get('/api/agents', async () => d.store.listAgents());
  app.post('/api/agents', async (req) => {
    const body = agentSchema.parse(req.body);
    await checkChoice({ provider: body.provider || chooseModel(d.store, 'worker').provider, model: body.model });
    return d.store.createAgent(body);
  });
  app.patch<{ Params: { id: string } }>('/api/agents/:id', async (req) => {
    const patch = agentSchema.partial().parse(req.body);
    const before = d.store.getAgent(req.params.id);
    if (!before) throw Object.assign(new Error('Agent not found.'), { statusCode: 404 });
    if (patch.provider !== undefined || patch.model !== undefined) {
      const provider = (patch.provider ?? before.provider) || chooseModel(d.store, 'worker').provider;
      await checkChoice({ provider, model: patch.model ?? before.model ?? '' });
    }
    const a = d.store.updateAgent(req.params.id, patch);
    if (a) bus.publish({ type: 'agent', agent: a });
    return a;
  });
  app.post<{ Params: { id: string }; Body: { action: 'pause' | 'resume' | 'unblock' } }>('/api/agents/:id/action', async (req) => {
    const a = d.store.getAgent(req.params.id);
    if (!a) throw Object.assign(new Error('Agent not found.'), { statusCode: 404 });
    return agentAction(a, z.object({ action: z.enum(['pause', 'resume', 'unblock']) }).parse(req.body ?? {}).action);
  });
  app.delete<{ Params: { id: string } }>('/api/agents/:id', async (req) => {
    const a = d.store.getAgent(req.params.id);
    if (!a) throw Object.assign(new Error('Agent not found.'), { statusCode: 404 });
    const busy = ['working', 'running_checks', 'addressing_review', 'waiting_review'].includes(a.state) || (a.currentRunId && d.orchestrator.isActive(a.currentRunId));
    if (busy) throw Object.assign(new Error(`${a.name} is working on a ticket; stop its run before deleting it.`), { statusCode: 409 });
    d.store.deleteAgent(req.params.id);
    return { ok: true };
  });

  // Project memory (.maestro/memory.md). Edits wait here and are committed with the next ticket.
  app.get<{ Params: { id: string } }>('/api/projects/:id/memory', async (req) => {
    const p = project(req.params.id);
    const pending = d.store.getSetting(`memory.${p.id}`);
    if (pending !== undefined) return { content: pending, pending: true };
    // Only read what is already on disk: viewing the Knowledge tab must not clone the repository.
    const path = repoDir(p);
    const content = existsSync(path) ? await readBaseMemory(path, parseWorkflow(p.workflowYaml).base_branch, p.codeHost.provider === 'local') : '';
    return { content, pending: false };
  });
  app.put<{ Params: { id: string } }>('/api/projects/:id/memory', async (req) => {
    const p = project(req.params.id);
    const { content } = z.object({ content: z.string() }).parse(req.body);
    d.store.setSetting(`memory.${p.id}`, content);
    return { content, pending: true };
  });
  app.delete<{ Params: { id: string } }>('/api/projects/:id/memory', async (req) => {
    d.store.deleteSetting(`memory.${project(req.params.id).id}`);
    return { ok: true };
  });

  // Chat (kept per project)
  app.get<{ Params: { id: string } }>('/api/projects/:id/chat', async (req) => d.store.listChat(project(req.params.id).id));
  app.delete<{ Params: { id: string } }>('/api/projects/:id/chat', async (req) => {
    d.store.clearChat(project(req.params.id).id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/chat', async (req) => {
    const p = project(req.params.id);
    const { message } = z.object({ message: z.string().trim().min(1, 'Write a question first.').max(20_000, 'Keep a message under 20,000 characters; attach less context or split it.') }).parse(req.body);
    const personal = userOverCap(d.store, req.user!.id);
    if (personal) throw Object.assign(new Error(personal), { statusCode: 429 });
    const history = d.store.listChat(p.id, 20).map(({ role, content }) => ({ role, content }));
    const warnings: string[] = [];
    const tickets = await pmFor(p, d.store, d.secrets).listTickets().catch((e: Error) => {
      warnings.push(`Couldn't read the tickets of ${p.name} (${redact(e.message).slice(0, 160)}), so the answer leaves them out.`);
      return [];
    });
    const reply = await askAssistant(d, p, tickets, repoDir(p), history, message);
    d.store.addSpend(p.id, null, 'chat', reply.costUsd, reply.usage, req.user!.id);
    d.store.addChatMessage(p.id, 'user', message, null, req.user!.id);
    const answer = d.store.addChatMessage(p.id, 'assistant', reply.answer, reply.model);
    answer.actions = allowedProposals(req.user, reply.actions).map((action) => d.store.addChatAction(p.id, answer.id, { type: action.type, summary: describeAction(action), action }, req.user!.id));
    return { ...answer, answer: reply.answer, costUsd: reply.costUsd, usage: reply.usage, warnings };
  });
  app.post<{ Params: { id: string; actionId: string } }>('/api/projects/:id/chat/actions/:actionId', async (req) => {
    const p = project(req.params.id);
    const stored = d.store.getChatAction(p.id, req.params.actionId);
    const fresh = stored && Date.now() - new Date(stored.createdAt).getTime() < PROPOSAL_TTL_MS;
    // Checked before the proposal is used up, so a refusal leaves it for someone who may confirm it.
    if (stored && fresh) mayConfirm(req.user, p, proposedActionSchema.parse(stored.action));
    if (!stored || !fresh || !d.store.claimChatAction(stored.id, 'done')) {
      throw Object.assign(new Error('This proposal has expired or was already used. Ask again.'), { statusCode: 404 });
    }
    try {
      const result = await runAction(p, proposedActionSchema.parse(stored.action), req.user!.id);
      d.store.finishChatAction(stored.id, 'done', result.message, result.runId ?? null);
      return result;
    } catch (e) {
      d.store.finishChatAction(stored.id, 'failed', (e as Error).message);
      throw e;
    }
  });
  app.delete<{ Params: { id: string; actionId: string } }>('/api/projects/:id/chat/actions/:actionId', async (req) => {
    const p = project(req.params.id);
    const stored = d.store.getChatAction(p.id, req.params.actionId);
    if (stored && d.store.claimChatAction(stored.id, 'dismissed')) d.store.finishChatAction(stored.id, 'dismissed', 'Dismissed');
    return { ok: true };
  });

  // Chat across all projects: several conversations, each with its own project focus and model
  const GLOBAL = '';
  /** Your own conversation (conversations are private); 404 for anyone else's. */
  const thread = (id: string, user: SessionUser | undefined) => {
    const t = d.store.getThread(id);
    if (!t || !user || t.userId !== user.id) throw Object.assign(new Error('Conversation not found.'), { statusCode: 404 });
    return t;
  };
  /** A project the user can see; 404 otherwise, as if it didn't exist. */
  const seenProject = (user: SessionUser | undefined, id: string) => {
    const p = project(id);
    if (!can(user, 'project.view', p.id, d.store)) throw Object.assign(new Error('Project not found.'), { statusCode: 404 });
    return p;
  };
  /** The model a conversation uses: its own choice when that provider still exists, else the Chat role's assignment. */
  const chatChoice = (t: ChatThread) => (t.model?.provider && getProvider(d.store, t.model.provider) ? t.model : null);
  const modelSchema = z.object({ provider: z.string().min(1), model: z.string().default('') });
  const threadPatch = z.object({
    title: z.string().trim().min(1).max(80).optional(),
    projectId: z.string().min(1).nullable().optional(),
    model: modelSchema.nullable().optional(),
  });
  const checkThreadPatch = async (body: z.infer<typeof threadPatch>, user: SessionUser | undefined) => {
    if (body.projectId) seenProject(user, body.projectId);
    if (body.model) await checkChoice(body.model);
  };
  app.get('/api/chat/threads', async (req) => d.store.listThreads(req.user!.id));
  app.post('/api/chat/threads', async (req) => {
    const body = threadPatch.parse(req.body ?? {});
    await checkThreadPatch(body, req.user);
    return d.store.createThread({ ...body, userId: req.user!.id });
  });
  app.get<{ Params: { id: string } }>('/api/chat/threads/:id', async (req) => {
    const t = thread(req.params.id, req.user);
    return { thread: t, messages: d.store.listChat(threadKey(t.id)) };
  });
  app.patch<{ Params: { id: string } }>('/api/chat/threads/:id', async (req) => {
    const t = thread(req.params.id, req.user);
    const body = threadPatch.parse(req.body ?? {});
    await checkThreadPatch(body, req.user);
    return d.store.updateThread(t.id, body);
  });
  app.delete<{ Params: { id: string } }>('/api/chat/threads/:id', async (req) => {
    d.store.deleteThread(thread(req.params.id, req.user).id);
    return { ok: true };
  });
  app.get<{ Querystring: { threadId?: string } }>('/api/chat/models', async (req) => {
    const groups = await Promise.all(
      listProviders(d.store).map(async (p) => {
        const hint = p.kind === 'cli' ? 'Slow for chat, and it may not follow the answer format.' : p.kind === 'openai' && p.structuredOutput === 'prompt' ? 'No JSON mode: answers may come out malformed.' : '';
        if (p.kind === 'claude') return { provider: p.id, name: p.name, kind: p.kind, models: CLAUDE_MODELS, hint, error: '' };
        if (p.kind === 'cli') return { provider: p.id, name: p.name, kind: p.kind, models: [''], hint, error: cliInstalled(p.cli?.command ?? '') ? '' : `${p.cli?.command} is not installed.` };
        try {
          const models = await Promise.race([
            listModels(p, p.apiKeySecret ? d.secrets.get(p.apiKeySecret) : undefined),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no answer within 5 seconds')), 5000)),
          ]);
          return { provider: p.id, name: p.name, kind: p.kind, models, hint, error: '' };
        } catch (e) {
          return { provider: p.id, name: p.name, kind: p.kind, models: [], hint, error: `${p.name} is unreachable (${(e as Error).message}). Is it running?` };
        }
      }),
    );
    const t = req.query.threadId ? d.store.getThread(req.query.threadId) : undefined;
    return { groups, current: t ? chatChoice(t) : null, default: chooseModel(d.store, 'assistant') };
  });
  /** Asks in a conversation; without a threadId a new conversation starts. Its title comes from the first question. */
  app.post('/api/chat', async (req) => {
    const { message, projectId, threadId } = z.object({ message: z.string().trim().min(1, 'Write a question first.').max(20_000, 'Keep a message under 20,000 characters; attach less context or split it.'), projectId: z.string().nullable().optional(), threadId: z.string().optional() }).parse(req.body);
    const personal = userOverCap(d.store, req.user!.id);
    if (personal) throw Object.assign(new Error(personal), { statusCode: 429 });
    if (projectId) seenProject(req.user, projectId);
    let t = threadId ? thread(threadId, req.user) : d.store.createThread({ projectId: projectId ?? null, userId: req.user!.id });
    if (projectId !== undefined && (projectId ?? null) !== t.projectId) t = d.store.updateThread(t.id, { projectId: projectId ?? null })!;
    // A focus on a project the user no longer sees is dropped.
    const scope = t.projectId && can(req.user, 'project.view', t.projectId, d.store) ? project(t.projectId) : null;
    const key = threadKey(t.id);
    const history = d.store.listChat(key, 20).map(({ role, content }) => ({ role, content }));
    const warnings: string[] = [];
    const digests = await Promise.all(
      visibleTo(req.user).map(async (p) => ({
        project: p,
        tickets: await pmFor(p, d.store, d.secrets).listTickets().catch((e: Error) => {
          warnings.push(`Couldn't read the tickets of ${p.name} (${redact(e.message).slice(0, 160)}), so the answer leaves them out.`);
          return [];
        }),
      })),
    );
    const reply = await askGlobalAssistant(d, digests, scope, scope ? repoDir(scope) : '', history, message, chatChoice(t) ?? undefined);
    // Questions across all projects count toward the overall spend, not a project's budget.
    d.store.addSpend(scope ? scope.id : GLOBAL, null, 'chat', reply.costUsd, reply.usage, req.user!.id);
    d.store.addChatMessage(key, 'user', message, null, req.user!.id);
    const answer = d.store.addChatMessage(key, 'assistant', reply.answer, reply.model);
    answer.actions = allowedProposals(req.user, reply.actions).map((action) => d.store.addChatAction(key, answer.id, { type: action.type, summary: describeAction(action), action }, req.user!.id));
    const updated = d.store.updateThread(t.id, { ...(t.messages === 0 && t.title === 'New chat' ? { title: titleFrom(message) } : {}), touch: true })!;
    return { ...answer, answer: reply.answer, costUsd: reply.costUsd, usage: reply.usage, thread: updated, warnings };
  });
  app.post<{ Params: { actionId: string } }>('/api/chat/actions/:actionId', async (req) => {
    const stored = d.store.getThreadAction(req.params.actionId, req.user!.id);
    const fresh = stored && Date.now() - new Date(stored.createdAt).getTime() < PROPOSAL_TTL_MS;
    if (stored && fresh) mayConfirm(req.user, null, proposedActionSchema.parse(stored.action));
    if (!stored || !fresh || !d.store.claimChatAction(stored.id, 'done')) {
      throw Object.assign(new Error('This proposal has expired or was already used. Ask again.'), { statusCode: 404 });
    }
    try {
      const result = await runAction(null, proposedActionSchema.parse(stored.action), req.user!.id);
      d.store.finishChatAction(stored.id, 'done', result.message, result.runId ?? null);
      return result;
    } catch (e) {
      d.store.finishChatAction(stored.id, 'failed', (e as Error).message);
      throw e;
    }
  });
  app.delete<{ Params: { actionId: string } }>('/api/chat/actions/:actionId', async (req) => {
    const stored = d.store.getThreadAction(req.params.actionId, req.user!.id);
    if (stored && d.store.claimChatAction(stored.id, 'dismissed')) d.store.finishChatAction(stored.id, 'dismissed', 'Dismissed');
    return { ok: true };
  });

  // Overview for the dashboard home: what is happening, what needs you, what it costs
  app.get('/api/overview', async (req) => {
    const today = startOfToday();
    const projects = visibleTo(req.user);
    const seen = new Set(projects.map((p) => p.id));
    const runs = d.store.listRuns().filter((r) => seen.has(r.projectId));
    const names = new Map(projects.map((p) => [p.id, p.name]));
    const spendToday = d.store.spendByProject(today);
    const spendWeek = d.store.spendByProject(new Date(Date.now() - 7 * 86_400_000).toISOString());
    const perProject = await Promise.all(
      projects.map(async (p) => {
        const tickets = await Promise.race([
          pmFor(p, d.store, d.secrets).listTickets(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
        ]).catch(() => null);
        const counts = { todo: 0, in_progress: 0, in_review: 0, done: 0 };
        for (const t of tickets ?? []) counts[t.status] += 1;
        const mine = runs.filter((r) => r.projectId === p.id);
        return {
          id: p.id, name: p.name, description: p.description, codeHost: p.codeHost.provider, pm: p.pm.provider,
          tickets: tickets ? counts : null,
          running: mine.filter((r) => ['running', 'reviewing'].includes(r.status)).length,
          inReview: mine.filter((r) => r.status === 'in_review').length,
          blocked: mine.filter((r) => r.status === 'blocked').length,
          spendToday: spendToday.get(p.id) ?? NONE, dailyCaps: dailyCaps(d.store, p.id),
          autoAssign: d.orchestrator.autoAssignEnabled(p),
        };
      }),
    );
    const brief = (r: (typeof runs)[number]) => ({
      runId: r.id, projectId: r.projectId, projectName: names.get(r.projectId) ?? 'Removed project', ticketKey: r.ticketKey,
      ticketTitle: r.ticketTitle, status: r.status, prUrl: r.prUrl, checks: r.checks, error: r.error, costUsd: r.costUsd, usage: r.usage,
      since: r.endedAt ?? r.startedAt,
    });
    return {
      projects: perProject,
      agents: d.store.listAgents(),
      active: runs.filter((r) => ['running', 'reviewing'].includes(r.status)).map(brief),
      needsYou: [
        ...runs.filter((r) => r.status === 'blocked').map((r) => ({ ...brief(r), why: 'blocked' as const })),
        ...runs.filter((r) => r.status === 'in_review').map((r) => ({ ...brief(r), why: 'review' as const })),
        ...runs.filter((r) => r.status === 'failed' && (r.endedAt ?? '') >= today).map((r) => ({ ...brief(r), why: 'failed' as const })),
      ],
      spend: {
        today: sumSpent([...spendToday].filter(([id]) => seen.has(id) || (id === GLOBAL && seesAllProjects(req.user!))).map(([, v]) => v)),
        last7Days: sumSpent([...spendWeek].filter(([id]) => seen.has(id) || (id === GLOBAL && seesAllProjects(req.user!))).map(([, v]) => v)),
        perRunCaps: perRunCaps(d.store),
        byUser: usageByUser(req.user!, today).filter((r) => r.usage || r.usd > 0),
        dailyCapsDefault: dailyCaps(d.store, ''),
      },
      alertsUnread: d.store.listAlerts(50).filter((a) => !a.read && (!a.projectId || seen.has(a.projectId))).length,
      activity: d.store.recentEvents(60).filter((e) => seen.has(e.projectId)).slice(0, 15).map((e) => ({ ...e, projectName: names.get(e.projectId) ?? 'Removed project' })),
    };
  });

  // Alerts: blocked, failed, budget reached, ready for review
  app.get('/api/alerts', async (req) => {
    const ids = visibleIds(req.user);
    const alerts = d.store.listAlerts(100).filter((a) => !a.projectId || ids.has(a.projectId)).slice(0, 50);
    return { alerts, unread: alerts.filter((a) => !a.read).length };
  });
  app.post('/api/alerts/read', async (req) => {
    const { ids } = z.object({ ids: z.array(z.number().int()).optional() }).parse(req.body ?? {});
    d.store.markAlertsRead(ids);
    return { ok: true };
  });

  // Metrics from the runs, for one project or all
  app.get<{ Querystring: { projectId?: string; days?: string } }>('/api/metrics', async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(0).max(3650).default(0) }).parse(req.query);
    const since = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : '';
    const ids = visibleIds(req.user);
    if (req.query.projectId && !ids.has(req.query.projectId)) throw Object.assign(new Error('Project not found.'), { statusCode: 404 });
    const runs = d.store.listAllRuns(req.query.projectId).filter((r) => r.startedAt >= since && ids.has(r.projectId));
    return computeMetrics(runs, (id) => d.store.listReviews(id));
  });

  // Spend and budgets
  app.get('/api/spend', async (req) => {
    const today = d.store.spendByProject(startOfToday());
    const week = d.store.spendByProject(new Date(Date.now() - 7 * 86_400_000).toISOString());
    const total = d.store.spendByProject();
    return visibleTo(req.user).map((p) => ({
      projectId: p.id, name: p.name,
      today: today.get(p.id) ?? NONE, last7Days: week.get(p.id) ?? NONE, total: total.get(p.id) ?? NONE,
      dailyCaps: dailyCaps(d.store, p.id),
      own: { tokens: d.store.getSetting(`budget.dailyTokens.${p.id}`) ?? null, eur: d.store.getSetting(`budget.dailyEur.${p.id}`) ?? null },
    }));
  });
  /** A project's own daily caps; null goes back to the default from Settings, a missing field stays as it is. */
  app.put<{ Params: { id: string } }>('/api/projects/:id/budget', async (req) => {
    const p = project(req.params.id);
    const body = z.object({ dailyTokens: z.number().int().min(0).nullable().optional(), dailyEur: z.number().min(0).nullable().optional() }).parse(req.body);
    for (const [field, key] of [['dailyTokens', `budget.dailyTokens.${p.id}`], ['dailyEur', `budget.dailyEur.${p.id}`]] as const) {
      const v = body[field];
      if (v === null) d.store.deleteSetting(key);
      else if (v !== undefined) d.store.setSetting(key, String(v));
    }
    void d.orchestrator.tick();
    return { dailyCaps: dailyCaps(d.store, p.id) };
  });
  /** The rough USD → EUR rate the dashboard uses for estimates. */
  app.get('/api/currency', async () => ({ eurPerUsd: eurPerUsd(d.store) }));

  // AI providers: Claude, any OpenAI-compatible API, or a coding CLI; and which one each role uses
  const providerView = (p: ProviderConfig) => ({
    ...p,
    keySet: p.apiKeySecret ? !!d.secrets.get(p.apiKeySecret) : false,
    installed: p.kind === 'cli' ? cliInstalled(p.cli?.command ?? '') : undefined,
    claudeLogin: p.kind === 'claude' ? claudeLoginStatus() : undefined,
    warnings: [
      ...(p.kind === 'openai' && p.structuredOutput === 'prompt' ? ['Without a JSON mode, the planner, reviewer and chat rely on the model following instructions; pick models that do.'] : []),
      ...(p.kind === 'cli' ? ['CLI agents apply their own permissions and report no cost. Chat and planning through a CLI are slow and less reliable; prefer an API provider for those roles.'] : []),
    ],
  });
  const rolesView = () => Object.fromEntries(ROLES.map((r) => [r, chooseModel(d.store, r)]));
  app.get('/api/providers', async () => ({
    providers: listProviders(d.store).map(providerView),
    roles: rolesView(),
    presets: { openai: OPENAI_PRESETS, cli: CLI_PRESETS.map((c) => ({ ...c, installed: cliInstalled(c.command) })), claudeModels: CLAUDE_MODELS },
    inDocker: existsSync('/.dockerenv'),
  }));
  app.put<{ Params: { id: string } }>('/api/providers/:id', async (req) => {
    const body = providerSchema.parse({ ...(req.body as object), id: req.params.id });
    if (body.kind === 'openai' && !/^https?:\/\//.test(body.baseUrl)) throw new Error('The base URL must start with http:// or https://.');
    if (body.kind === 'cli' && !body.cli?.command) throw new Error('Set the command to run.');
    const all = listProviders(d.store);
    saveProviders(d.store, all.some((p) => p.id === body.id) ? all.map((p) => (p.id === body.id ? body : p)) : [...all, body]);
    return providerView(body);
  });
  app.delete<{ Params: { id: string } }>('/api/providers/:id', async (req) => {
    const id = req.params.id;
    const roles = ROLES.filter((r) => (d.store.getSetting(`provider.${r}`) || 'claude') === id);
    const workers = d.store.listAgents().filter((a) => a.provider === id).map((a) => a.name);
    const projects = d.store.listProjects().filter((p) => Object.values(projectRoles(d.store, p.id)).some((c) => c?.provider === id)).map((p) => `project ${p.name}`);
    if (roles.length || workers.length || projects.length) {
      throw Object.assign(new Error(`It is still used by ${[...roles.map((r) => `the ${r === 'assistant' ? 'chat' : r} role`), ...workers, ...projects].join(', ')}; choose another provider there first.`), { statusCode: 409 });
    }
    saveProviders(d.store, listProviders(d.store).filter((p) => p.id !== id));
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/providers/:id/test', async (req) => {
    const p = getProvider(d.store, req.params.id);
    if (!p) throw Object.assign(new Error('Provider not found.'), { statusCode: 404 });
    const key = p.apiKeySecret ? d.secrets.get(p.apiKeySecret) : undefined;
    if (p.kind === 'claude') return key ? testConnection('anthropic', d.secrets) : { ok: claudeLoginStatus().valid, message: claudeLoginStatus().message };
    if (p.kind === 'cli') {
      const cmd = p.cli?.command ?? '';
      if (!cliInstalled(cmd)) return { ok: false, message: `${cmd || 'The command'} is not installed where Maestro runs${existsSync('/.dockerenv') ? ' (inside the container)' : ''}.` };
      const v = await runProc(cmd, ['--version'], { cwd: tmpdir(), timeoutMs: 20_000 });
      return { ok: v.code === 0, message: v.code === 0 ? `${cmd} ${v.output.trim().split('\n')[0]}` : `${cmd} --version failed.` };
    }
    try {
      const models = await listModels(p, key);
      return { ok: true, message: `Connected: ${models.length} model${models.length === 1 ? '' : 's'} available.`, models };
    } catch (e) {
      const msg = (e as Error).message;
      const hint = /fetch failed|ECONNREFUSED/i.test(msg) ? ' Is the server running and reachable from Maestro?' : '';
      return { ok: false, message: `${msg}${hint}` };
    }
  });
  app.get<{ Params: { id: string } }>('/api/providers/:id/models', async (req) => {
    const p = getProvider(d.store, req.params.id);
    if (!p) throw Object.assign(new Error('Provider not found.'), { statusCode: 404 });
    if (p.kind === 'claude') return CLAUDE_MODELS;
    if (p.kind === 'cli') return [];
    return listModels(p, p.apiKeySecret ? d.secrets.get(p.apiKeySecret) : undefined);
  });
  const choiceSchema = z.object({ provider: z.string().min(1), model: z.string().default('') });

  app.put('/api/roles', async (req) => {
    const body = z.object(Object.fromEntries(ROLES.map((r) => [r, choiceSchema.optional()]))).parse(req.body);
    for (const [role, c] of Object.entries(body)) {
      if (!c) continue;
      await checkChoice(c);
      d.store.setSetting(`provider.${role}`, c.provider);
      d.store.setSetting(`model.${role}`, c.model.trim());
    }
    return rolesView();
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id/roles', async (req) => projectRoles(d.store, project(req.params.id).id));
  app.put<{ Params: { id: string } }>('/api/projects/:id/roles', async (req) => {
    const p = project(req.params.id);
    const body = z.object(Object.fromEntries(ROLES.map((r) => [r, choiceSchema.nullable().optional()]))).parse(req.body);
    const current = projectRoles(d.store, p.id);
    for (const [role, c] of Object.entries(body)) {
      if (c === null) delete current[role as keyof typeof current];
      else if (c) {
        await checkChoice(c);
        current[role as keyof typeof current] = { provider: c.provider, model: c.model.trim() };
      }
    }
    d.store.setSetting(`roles.${p.id}`, JSON.stringify(current));
    return current;
  });

  // Settings
  app.get('/api/settings', async () => {
    const set = new Set(d.secrets.names());
    return {
      settings: {
        'model.worker': 'claude-sonnet-5-5',
        'model.assistant': 'claude-sonnet-5-5',
        'model.planner': 'claude-opus-5-5',
        'model.reviewer': 'claude-opus-5-5',
        ...Object.fromEntries(Object.entries(NUMBER_SETTINGS).map(([k, v]) => [k, String(v.fallback)])),
        // Per-project values (auto-assign toggle, pending memory) have their own endpoints.
        ...Object.fromEntries(Object.entries(d.store.allSettings()).filter(([k]) => !/^(autoAssign|autoAssignBy|memory|budget\.daily|budget\.dailyTokens|budget\.dailyEur|roles)\./.test(k) && !['providers', 'chat.model'].includes(k))),
      },
      secrets: KNOWN_SECRETS.map((s) => ({ ...s, set: set.has(s.name) || !!process.env[s.name] })),
      secretsBackend: d.secrets.kind,
    };
  });
  app.put('/api/settings', async (req) => {
    const body = z.record(z.string(), z.string()).parse(req.body);
    const problems = Object.entries(body).map(([k, v]) => invalidSetting(k, v)).filter(Boolean);
    if (problems.length) throw new Error(problems.join(' '));
    for (const [k, v] of Object.entries(body)) d.store.setSetting(k, v);
    return { ok: true };
  });
  app.post<{ Params: { provider: string } }>('/api/settings/test/:provider', async (req) => {
    const provider = z.enum(['anthropic', 'github', 'gitlab', 'bitbucket', 'trello', 'figma']).parse(req.params.provider);
    return testConnection(provider, d.secrets);
  });
  app.put<{ Params: { name: string } }>('/api/secrets/:name', async (req) => {
    const { value } = z.object({ value: z.string().min(1) }).parse(req.body);
    d.secrets.set(req.params.name, value);
    return { ok: true };
  });
  app.delete<{ Params: { name: string } }>('/api/secrets/:name', async (req) => {
    d.secrets.delete(req.params.name);
    return { ok: true };
  });

  // Connection checks
  app.post<{ Params: { id: string } }>('/api/projects/:id/check', async (req) => {
    const p = project(req.params.id);
    const result: Record<string, { ok: boolean; message: string }> = {};
    try {
      const path = await codeHostFor(p, d.secrets, d.reposDir).ensureRepo(p);
      const missing = missingCredentials(p, d.secrets);
      result.codeHost = missing ? { ok: false, message: `Repository at ${path}, but: ${missing}` } : { ok: true, message: `Repository ready at ${path}` };
    } catch (e) {
      result.codeHost = { ok: false, message: (e as Error).message };
    }
    try {
      const n = (await pmFor(p, d.store, d.secrets).listTickets()).length;
      result.pm = { ok: true, message: `${n} tickets found` };
    } catch (e) {
      result.pm = { ok: false, message: (e as Error).message };
    }
    if (p.design.provider === 'figma') {
      const file = fileKeyFrom(p.design.settings['file']);
      const token = d.secrets.get('FIGMA_TOKEN');
      if (!token) result.design = { ok: false, message: 'Add the Figma token in Settings.' };
      else if (!file) result.design = { ok: true, message: 'Token set. No file on the project: only tickets that link a frame get designs.' };
      else {
        try {
          const o = await new FigmaClient(token).fileOverview(file);
          result.design = { ok: true, message: `"${o.name}": ${o.pages.length} pages` };
        } catch (e) {
          result.design = { ok: false, message: (e as Error).message };
        }
      }
    }
    if (p.docs.provider === 'confluence') {
      try {
        const ids = docPageIds(p);
        const text = ids.length ? await docsContextFor({ ...p, docs: { ...p.docs, settings: { ...p.docs.settings, pages: ids[0] } }, requirements: '', context: '' }, d.secrets) : null;
        result.docs = !ids.length
          ? { ok: true, message: 'No pages listed yet; pages linked in tickets are read when a worker starts.' }
          : text?.includes('(Could not be read')
            ? { ok: false, message: text.split('\n')[1].replace(/^\(|\)$/g, '') }
            : { ok: true, message: `Read "${text?.split('\n')[0].replace(/^### /, '')}"${ids.length > 1 ? ` (${ids.length} pages in all)` : ''}` };
      } catch (e) {
        result.docs = { ok: false, message: (e as Error).message };
      }
    }
    return result;
  });

  // Live updates
  // Same-origin only: no CORS header here, so other web pages can't read agent activity from this machine.
  const streams = new Set<import('node:http').ServerResponse>();
  // On shutdown, end the open streams so closing the server doesn't wait for them; browsers reconnect.
  app.addHook('preClose', async () => {
    for (const s of streams) s.end();
  });
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    // Something must be sent for the browser to report the stream as open.
    reply.raw.write(': connected\n\n');
    const user = req.user!;
    const runProject = new Map<string, string | null>();
    /** The project an event is about; null for things everyone sees (workers, alerts with no project). */
    const projectOfEvent = (e: BusEvent): string | null => {
      const x = (e as { run?: { projectId?: string }; event?: { runId?: string }; review?: { runId?: string }; alert?: { projectId?: string | null } });
      if (e.type === 'run') return x.run?.projectId ?? null;
      if (e.type === 'alert') return x.alert?.projectId ?? null;
      const runId = e.type === 'run_event' ? x.event?.runId : e.type === 'review' ? x.review?.runId : undefined;
      if (!runId) return null;
      if (!runProject.has(runId)) runProject.set(runId, d.store.getRun(runId)?.projectId ?? null);
      return runProject.get(runId)!;
    };
    // Only events about projects this user can see.
    const send = (e: BusEvent) => {
      const projectId = projectOfEvent(e);
      if (projectId && !can(user, 'project.view', projectId, d.store)) return;
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    bus.on('event', send);
    req.raw.on('close', () => {
      streams.delete(reply.raw);
      clearInterval(ping);
      bus.off('event', send);
    });
  });

  // Built dashboard
  if (d.dashboardDir && existsSync(d.dashboardDir)) {
    await app.register(fastifyStatic, { root: d.dashboardDir, wildcard: false });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.status(404).send({ error: 'Not found' }) : reply.sendFile('index.html'),
    );
  }
  return app;
}

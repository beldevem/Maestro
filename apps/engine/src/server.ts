import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { budgetState, dailyCap, perRunCap, startOfToday, usd } from './budget.js';
import { DESIGN_DIR } from './adapters/design/index.js';
import { readBaseMemory } from './memory.js';
import { testConnection } from './connection-tests.js';
import { invalidSetting } from './settings.js';
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
}

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
  name: z.string().trim().min(1),
  role: z.enum(['worker', 'orchestrator', 'reviewer', 'planner', 'assistant']).default('worker'),
  model: z.string().default(''),
});

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

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (err instanceof NotReadyError) return reply.status(409).send({ error: err.message, reasons: err.reasons });
    const status = (err as { statusCode?: number }).statusCode ?? 400;
    return reply.status(status).send({ error: err instanceof Error ? err.message : String(err) });
  });

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
  const plan = async (p: ReturnType<typeof project>) => {
    if (planning.has(p.id)) throw Object.assign(new Error('The planner is already working on this project.'), { statusCode: 409 });
    const budget = budgetState(d.store, p.id);
    if (budget.over) throw new Error(`${p.name} has reached its daily budget of ${usd(budget.cap)}.`);
    planning.add(p.id);
    try {
      const tickets = await pmFor(p, d.store, d.secrets).listTickets();
      // Planning reads the code, so a remote repository is cloned first; without it the planner works from the requirements alone.
      const repo = await codeHostFor(p, d.secrets, d.reposDir).ensureRepo(p).catch((e: Error) => {
        console.error(`Planning ${p.name} without the code: ${e.message}`);
        return '';
      });
      const cwd = repo && existsSync(repo) ? repo : tmpdir();
      const docs = await docsContextFor(p, d.secrets);
      const memory = repo ? await readBaseMemory(repo, parseWorkflow(p.workflowYaml).base_branch, p.codeHost.provider === 'local') : '';
      const draft = await draftBacklog(d, p, tickets, cwd, { docs, memory });
      d.store.addSpend(p.id, null, 'planner', draft.costUsd);
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
  const actionProject = (scope: ReturnType<typeof project> | null, a: ProposedAction) => {
    if (scope) return scope;
    const all = d.store.listProjects();
    const name = 'project' in a ? a.project?.trim().toLowerCase() : undefined;
    const found = name ? all.find((x) => x.name.toLowerCase() === name) : all.length === 1 ? all[0] : undefined;
    if (!found) throw new Error(name ? `No project called "${'project' in a ? a.project : ''}".` : 'Say which project this is for.');
    return found;
  };
  const runAction = async (scope: ReturnType<typeof project> | null, a: ProposedAction): Promise<{ message: string; runId?: string }> => {
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
        const run = await d.orchestrator.start(p.id, a.ticketKey);
        return { message: `${a.ticketKey} is assigned to ${d.store.getAgent(run.agentId)?.name ?? 'a worker'}.`, runId: run.id };
      }
      case 'move_ticket':
        if (!(await pm.getTicket(a.ticketKey))) throw new Error(`Ticket ${a.ticketKey} not found.`);
        await pm.moveTicket(a.ticketKey, a.status);
        void d.orchestrator.tick();
        return { message: `Moved ${a.ticketKey} to ${a.status.replace('_', ' ')}.` };
      case 'plan_backlog':
        void plan(p).catch((e) => console.error(`Planning from chat failed: ${(e as Error).message}`));
        return { message: 'The planner is working; the draft shows up on the Board when it is done.' };
    }
  };

  app.get('/api/health', async () => ({ ok: true }));

  // Projects
  app.get('/api/projects', async () => d.store.listProjects());
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
      if (!v.ok) throw new Error(`Workflow config: ${v.error}`);
    }
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
      if (!v.ok) throw new Error(`Workflow config: ${v.error}`);
    }
    return d.store.updateProject(req.params.id, patch);
  });
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
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
    async (req) => d.orchestrator.start(req.params.id, req.params.key, req.body ?? {}),
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
    if (enabled) void d.orchestrator.tick();
    return { enabled };
  });

  // Planner: drafts a backlog you review before any ticket is created
  app.post<{ Params: { id: string } }>('/api/projects/:id/plan', async (req) => {
    return plan(project(req.params.id));
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
  app.get<{ Querystring: { projectId?: string } }>('/api/runs', async (req) => d.store.listRuns(req.query.projectId));
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
  app.get('/api/pull-requests', async () => {
    const projects = new Map(d.store.listProjects().map((p) => [p.id, p.name]));
    return d.store
      .listRuns()
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

  // Agents
  app.get('/api/agents', async () => d.store.listAgents());
  app.post('/api/agents', async (req) => d.store.createAgent(agentSchema.parse(req.body)));
  app.patch<{ Params: { id: string } }>('/api/agents/:id', async (req) => {
    const patch = agentSchema.partial().parse(req.body);
    const a = d.store.updateAgent(req.params.id, patch);
    if (a) bus.publish({ type: 'agent', agent: a });
    return a;
  });
  app.post<{ Params: { id: string }; Body: { action: 'pause' | 'resume' | 'unblock' } }>('/api/agents/:id/action', async (req) => {
    const a = d.store.getAgent(req.params.id);
    if (!a) throw Object.assign(new Error('Agent not found.'), { statusCode: 404 });
    return agentAction(a, req.body?.action);
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
    const { message } = z.object({ message: z.string().min(1) }).parse(req.body);
    const history = d.store.listChat(p.id, 20).map(({ role, content }) => ({ role, content }));
    const tickets = await pmFor(p, d.store, d.secrets).listTickets().catch(() => []);
    const reply = await askAssistant(d, p, tickets, repoDir(p), history, message);
    d.store.addSpend(p.id, null, 'chat', reply.costUsd);
    d.store.addChatMessage(p.id, 'user', message);
    const answer = d.store.addChatMessage(p.id, 'assistant', reply.answer);
    answer.actions = reply.actions.map((action) => d.store.addChatAction(p.id, answer.id, { type: action.type, summary: describeAction(action), action }));
    return { ...answer, answer: reply.answer, costUsd: reply.costUsd };
  });
  app.post<{ Params: { id: string; actionId: string } }>('/api/projects/:id/chat/actions/:actionId', async (req) => {
    const p = project(req.params.id);
    const stored = d.store.getChatAction(p.id, req.params.actionId);
    const fresh = stored && Date.now() - new Date(stored.createdAt).getTime() < PROPOSAL_TTL_MS;
    if (!stored || !fresh || !d.store.claimChatAction(stored.id, 'done')) {
      throw Object.assign(new Error('This proposal has expired or was already used. Ask again.'), { statusCode: 404 });
    }
    try {
      const result = await runAction(p, proposedActionSchema.parse(stored.action));
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

  // Chat across all projects (stored as the project-less thread); an optional projectId puts one project in focus
  const GLOBAL = '';
  app.get('/api/chat', async () => d.store.listChat(GLOBAL));
  app.delete('/api/chat', async () => {
    d.store.clearChat(GLOBAL);
    return { ok: true };
  });
  app.post('/api/chat', async (req) => {
    const { message, projectId } = z.object({ message: z.string().min(1), projectId: z.string().optional() }).parse(req.body);
    const scope = projectId ? project(projectId) : null;
    const history = d.store.listChat(GLOBAL, 20).map(({ role, content }) => ({ role, content }));
    const digests = await Promise.all(
      d.store.listProjects().map(async (p) => ({ project: p, tickets: await pmFor(p, d.store, d.secrets).listTickets().catch(() => []) })),
    );
    const reply = await askGlobalAssistant(d, digests, scope, scope ? repoDir(scope) : '', history, message);
    if (scope) d.store.addSpend(scope.id, null, 'chat', reply.costUsd);
    d.store.addChatMessage(GLOBAL, 'user', message);
    const answer = d.store.addChatMessage(GLOBAL, 'assistant', reply.answer);
    answer.actions = reply.actions.map((action) => d.store.addChatAction(GLOBAL, answer.id, { type: action.type, summary: describeAction(action), action }));
    return { ...answer, answer: reply.answer, costUsd: reply.costUsd };
  });
  app.post<{ Params: { actionId: string } }>('/api/chat/actions/:actionId', async (req) => {
    const stored = d.store.getChatAction(GLOBAL, req.params.actionId);
    const fresh = stored && Date.now() - new Date(stored.createdAt).getTime() < PROPOSAL_TTL_MS;
    if (!stored || !fresh || !d.store.claimChatAction(stored.id, 'done')) {
      throw Object.assign(new Error('This proposal has expired or was already used. Ask again.'), { statusCode: 404 });
    }
    try {
      const result = await runAction(null, proposedActionSchema.parse(stored.action));
      d.store.finishChatAction(stored.id, 'done', result.message, result.runId ?? null);
      return result;
    } catch (e) {
      d.store.finishChatAction(stored.id, 'failed', (e as Error).message);
      throw e;
    }
  });
  app.delete<{ Params: { actionId: string } }>('/api/chat/actions/:actionId', async (req) => {
    const stored = d.store.getChatAction(GLOBAL, req.params.actionId);
    if (stored && d.store.claimChatAction(stored.id, 'dismissed')) d.store.finishChatAction(stored.id, 'dismissed', 'Dismissed');
    return { ok: true };
  });

  // Overview for the dashboard home: what is happening, what needs you, what it costs
  app.get('/api/overview', async () => {
    const today = startOfToday();
    const runs = d.store.listRuns();
    const projects = d.store.listProjects();
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
          spendToday: spendToday.get(p.id) ?? 0, dailyCap: dailyCap(d.store, p.id),
          autoAssign: d.orchestrator.autoAssignEnabled(p),
        };
      }),
    );
    const brief = (r: (typeof runs)[number]) => ({
      runId: r.id, projectId: r.projectId, projectName: names.get(r.projectId) ?? 'Removed project', ticketKey: r.ticketKey,
      ticketTitle: r.ticketTitle, status: r.status, prUrl: r.prUrl, checks: r.checks, error: r.error, costUsd: r.costUsd,
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
        today: [...spendToday.values()].reduce((a, b) => a + b, 0),
        last7Days: [...spendWeek.values()].reduce((a, b) => a + b, 0),
        perRunCap: perRunCap(d.store),
        dailyCapDefault: dailyCap(d.store, ''),
      },
      alertsUnread: d.store.listAlerts(50).filter((a) => !a.read).length,
      activity: d.store.recentEvents(15).map((e) => ({ ...e, projectName: names.get(e.projectId) ?? 'Removed project' })),
    };
  });

  // Alerts: blocked, failed, budget reached, ready for review
  app.get('/api/alerts', async () => {
    const alerts = d.store.listAlerts(50);
    return { alerts, unread: alerts.filter((a) => !a.read).length };
  });
  app.post('/api/alerts/read', async (req) => {
    const { ids } = z.object({ ids: z.array(z.number().int()).optional() }).parse(req.body ?? {});
    d.store.markAlertsRead(ids);
    return { ok: true };
  });

  // Metrics from the runs, for one project or all
  app.get<{ Querystring: { projectId?: string; days?: string } }>('/api/metrics', async (req) => {
    const days = Number(req.query.days ?? 0);
    const since = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : '';
    const runs = d.store.listAllRuns(req.query.projectId).filter((r) => r.startedAt >= since);
    return computeMetrics(runs, (id) => d.store.listReviews(id));
  });

  // Spend and budgets
  app.get('/api/spend', async () => {
    const today = d.store.spendByProject(startOfToday());
    const week = d.store.spendByProject(new Date(Date.now() - 7 * 86_400_000).toISOString());
    const total = d.store.spendByProject();
    return d.store.listProjects().map((p) => ({
      projectId: p.id, name: p.name,
      today: today.get(p.id) ?? 0, last7Days: week.get(p.id) ?? 0, total: total.get(p.id) ?? 0,
      dailyCap: dailyCap(d.store, p.id), ownCap: d.store.getSetting(`budget.daily.${p.id}`) !== undefined,
    }));
  });
  app.put<{ Params: { id: string } }>('/api/projects/:id/budget', async (req) => {
    const p = project(req.params.id);
    const { dailyUsd } = z.object({ dailyUsd: z.number().min(0).nullable() }).parse(req.body);
    if (dailyUsd === null) d.store.deleteSetting(`budget.daily.${p.id}`);
    else d.store.setSetting(`budget.daily.${p.id}`, String(dailyUsd));
    void d.orchestrator.tick();
    return { dailyCap: dailyCap(d.store, p.id) };
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
        maxConcurrentRuns: '3',
        'budget.perRunUsd': '5',
        'budget.projectDailyUsd': '0',
        'worktrees.keepDays': '3',
        // Per-project values (auto-assign toggle, pending memory) have their own endpoints.
        ...Object.fromEntries(Object.entries(d.store.allSettings()).filter(([k]) => !/^(autoAssign|memory|budget\.daily)\./.test(k))),
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
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    // Something must be sent for the browser to report the stream as open.
    reply.raw.write(': connected\n\n');
    const send = (e: BusEvent) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    bus.on('event', send);
    req.raw.on('close', () => {
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

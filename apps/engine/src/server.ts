import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { codeHostFor } from './adapters/codehost/index.js';
import { pmFor } from './adapters/pm/index.js';
import { docsContextFor } from './adapters/docs/index.js';
import { askAssistant, describeAction, type ProposedAction } from './agents/assistant.js';
import { approveDraft, backlogItemSchema, cleanItems, draftBacklog } from './agents/planner.js';
import type { CodingAgent } from './agents/coding-agent.js';
import type { Store } from './db.js';
import { bus, type BusEvent } from './events.js';
import { NotReadyError, Orchestrator } from './orchestrator.js';
import { git } from './proc.js';
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
  name: z.string().min(1),
  description: z.string().default(''),
  codeHost: codeHostSchema,
  pm: pmSchema.default({ provider: 'manual', settings: {} }),
  design: designSchema.default({ provider: 'none', settings: {} }),
  docs: docsSchema.default({ provider: 'none', settings: {} }),
  context: z.string().default(''),
  requirements: z.string().default(''),
  bestPractices: z.string().default(''),
  workflowYaml: z.string().optional(),
});
const ticketSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  acceptanceCriteria: z.string().default(''),
  size: z.string().optional(),
  labels: z.array(z.string()).default([]),
});
const agentSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['worker', 'orchestrator', 'reviewer', 'planner', 'assistant']).default('worker'),
  model: z.string().default(''),
});

export async function buildServer(d: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] });

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
    planning.add(p.id);
    try {
      const tickets = await pmFor(p, d.store, d.secrets).listTickets();
      const cwd = existsSync(repoDir(p)) ? repoDir(p) : tmpdir();
      const docs = await docsContextFor(p, d.secrets);
      return await draftBacklog(d, p, tickets, cwd, docs);
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

  /** Actions the chat proposed, kept until you confirm or they expire; each runs at most once. */
  const proposals = new Map<string, { projectId: string; action: ProposedAction; expires: number }>();
  const PROPOSAL_TTL_MS = 60 * 60_000;
  const runAction = async (p: ReturnType<typeof project>, a: ProposedAction): Promise<{ message: string; runId?: string }> => {
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
      case 'pause_agent':
      case 'resume_agent': {
        const agent = d.store.listAgents().find((x) => x.name.toLowerCase() === a.agentName.toLowerCase());
        if (!agent) throw new Error(`No agent called ${a.agentName}.`);
        agentAction(agent, a.type === 'pause_agent' ? 'pause' : 'resume');
        return { message: `${agent.name} is ${a.type === 'pause_agent' ? 'paused' : 'available again'}.` };
      }
    }
  };

  app.get('/api/health', async () => ({ ok: true }));

  // Projects
  app.get('/api/projects', async () => d.store.listProjects());
  app.post('/api/projects', async (req) => {
    const body = projectSchema.parse(req.body);
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
      Object.entries(projectSchema.partial().parse(req.body)).filter(([k]) => sent.includes(k)),
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
    const committed = run.status === 'in_review';
    const diff = committed
      ? await git(run.worktree, ['show', '--stat', '--patch', '--format=%s%n', 'HEAD'])
      : await git(run.worktree, ['diff', 'HEAD']);
    return { base, diff };
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/stop', async (req) => ({ stopped: d.orchestrator.stop(req.params.id) }));
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
    if (a?.currentRunId && d.orchestrator.isActive(a.currentRunId)) throw new Error('Stop this agent\'s run before removing it.');
    d.store.deleteAgent(req.params.id);
    return { ok: true };
  });

  // Chat
  app.post<{ Params: { id: string } }>('/api/projects/:id/chat', async (req) => {
    const p = project(req.params.id);
    const body = z
      .object({ message: z.string().min(1), history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).default([]) })
      .parse(req.body);
    const tickets = await pmFor(p, d.store, d.secrets).listTickets().catch(() => []);
    const reply = await askAssistant(d, p, tickets, repoDir(p), body.history, body.message);
    const now = Date.now();
    for (const [id, x] of proposals) if (x.expires < now) proposals.delete(id);
    const actions = reply.actions.map((action) => {
      const id = randomUUID();
      proposals.set(id, { projectId: p.id, action, expires: now + PROPOSAL_TTL_MS });
      return { id, type: action.type, summary: describeAction(action), action };
    });
    return { answer: reply.answer, costUsd: reply.costUsd, actions };
  });
  app.post<{ Params: { id: string; actionId: string } }>('/api/projects/:id/chat/actions/:actionId', async (req) => {
    const p = project(req.params.id);
    const proposal = proposals.get(req.params.actionId);
    if (!proposal || proposal.projectId !== p.id || proposal.expires < Date.now()) {
      throw Object.assign(new Error('This proposal has expired or was already used. Ask again.'), { statusCode: 404 });
    }
    proposals.delete(req.params.actionId);
    return runAction(p, proposal.action);
  });
  app.delete<{ Params: { id: string; actionId: string } }>('/api/projects/:id/chat/actions/:actionId', async (req) => {
    proposals.delete(req.params.actionId);
    return { ok: true };
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
        ...d.store.allSettings(),
      },
      secrets: KNOWN_SECRETS.map((s) => ({ ...s, set: set.has(s.name) || !!process.env[s.name] })),
    };
  });
  app.put('/api/settings', async (req) => {
    const body = z.record(z.string(), z.string()).parse(req.body);
    for (const [k, v] of Object.entries(body)) d.store.setSetting(k, v);
    return { ok: true };
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
      result.codeHost = { ok: true, message: `Repository ready at ${path}` };
    } catch (e) {
      result.codeHost = { ok: false, message: (e as Error).message };
    }
    try {
      const n = (await pmFor(p, d.store, d.secrets).listTickets()).length;
      result.pm = { ok: true, message: `${n} tickets found` };
    } catch (e) {
      result.pm = { ok: false, message: (e as Error).message };
    }
    return result;
  });

  // Live updates
  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
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

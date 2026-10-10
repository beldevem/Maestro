import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { codeHostFor } from './adapters/codehost/index.js';
import { pmFor } from './adapters/pm/index.js';
import { askAssistant } from './agents/assistant.js';
import type { CodingAgent } from './agents/coding-agent.js';
import type { Store } from './db.js';
import { bus, type BusEvent } from './events.js';
import { NotReadyError, Orchestrator } from './orchestrator.js';
import { git } from './proc.js';
import { KNOWN_SECRETS, type SecretStore } from './secrets.js';
import { checkReady, parseWorkflow, validateWorkflow } from './workflow.js';

export interface ServerDeps {
  store: Store;
  secrets: SecretStore;
  agent: CodingAgent;
  orchestrator: Orchestrator;
  reposDir: string;
  dashboardDir?: string;
}

const codeHostSchema = z.object({
  provider: z.enum(['github', 'local']),
  repo: z.string().optional(),
  localPath: z.string().optional(),
  defaultBranch: z.string().default('main'),
});
const pmSchema = z.object({ provider: z.enum(['manual', 'jira', 'trello']), settings: z.record(z.string(), z.string()).default({}) });
const designSchema = z.object({ provider: z.enum(['none', 'figma']), settings: z.record(z.string(), z.string()).default({}) });
const projectSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  codeHost: codeHostSchema,
  pm: pmSchema.default({ provider: 'manual', settings: {} }),
  design: designSchema.default({ provider: 'none', settings: {} }),
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
    const patch = projectSchema.partial().parse(req.body);
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
    return tickets.map((t) => ({ ...t, notReady: checkReady(wf, t) }));
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/tickets', async (req) => {
    const p = project(req.params.id);
    return pmFor(p, d.store, d.secrets).createTicket(ticketSchema.parse(req.body));
  });
  app.post<{ Params: { id: string; key: string }; Body: { agentId?: string; force?: boolean } }>(
    '/api/projects/:id/tickets/:key/start',
    async (req) => d.orchestrator.start(req.params.id, req.params.key, req.body ?? {}),
  );

  // Runs
  app.get<{ Querystring: { projectId?: string } }>('/api/runs', async (req) => d.store.listRuns(req.query.projectId));
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req) => {
    const run = d.store.getRun(req.params.id);
    if (!run) throw Object.assign(new Error('Run not found.'), { statusCode: 404 });
    return { ...run, active: d.orchestrator.isActive(run.id), events: d.store.listEvents(run.id) };
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
    const action = req.body?.action;
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
    const cwd = p.codeHost.provider === 'local' ? p.codeHost.localPath ?? '' : join(d.reposDir, p.id);
    return askAssistant(d, p, tickets, cwd, body.history, body.message);
  });

  // Settings
  app.get('/api/settings', async () => {
    const set = new Set(d.secrets.names());
    return {
      settings: {
        'model.worker': 'claude-sonnet-5-5',
        'model.assistant': 'claude-sonnet-5-5',
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

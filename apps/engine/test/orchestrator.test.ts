import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentOutcome, AgentTask, CodingAgent } from '../src/agents/coding-agent.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { git } from '../src/proc.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

const WORKFLOW = `base_branch: main
pull_before_start: false
quality_gates:
  - name: greeting
    run: node -e "process.exit(require('fs').readFileSync('hello.txt','utf8').trim()==='hello'?0:1)"
max_fix_attempts: 2
`;

/** Writes hello.txt: wrong on the first try, right once asked to fix (unless `never` is set). Approves as reviewer. */
class FakeAgent implements CodingAgent {
  calls: AgentTask[] = [];
  reviews: AgentTask[] = [];
  constructor(private readonly never = false) {}
  async run(task: AgentTask): Promise<AgentOutcome> {
    if (task.outputSchema) {
      this.reviews.push(task);
      return { sessionId: 'review', text: '', costUsd: 0.02, ok: true, structured: { verdict: 'approve', summary: 'Looks right.', comments: [] } };
    }
    this.calls.push(task);
    const fixing = task.prompt.includes('quality gate failed');
    writeFileSync(join(task.cwd, 'hello.txt'), fixing && !this.never ? 'hello\n' : 'helo\n');
    task.onMessage?.({ kind: 'tool', text: 'Write hello.txt' });
    return { sessionId: 'session-1', text: 'Added hello.txt', costUsd: 0.01, ok: true };
  }
}

const settled = (s: string) => !['running', 'reviewing'].includes(s);

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('worker run end to end on a local repo', () => {
  let home: string;
  let repo: string;
  let store: Store;
  let secrets: SecretStore;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'maestro-'));
    repo = join(home, 'app');
    mkdirSync(repo);
    await git(repo, ['init', '-b', 'main']);
    writeFileSync(join(repo, 'README.md'), '# app\n');
    await git(repo, ['add', '.']);
    await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
    store = new Store(join(home, 'db.sqlite'));
    secrets = new SecretStore(join(home, 'secrets.json'));
  });
  afterEach(() => store.db.close());

  function setup(agent: CodingAgent) {
    const orchestrator = new Orchestrator({ store, secrets, agent, reposDir: join(home, 'repos'), worktreesDir: join(home, 'wt') });
    const project = store.createProject({
      name: 'Demo', description: '', codeHost: { provider: 'local', localPath: repo, defaultBranch: 'main' },
      pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} },
      context: 'A demo app.', requirements: '', bestPractices: 'Keep it small.', workflowYaml: WORKFLOW,
    });
    const worker = store.createAgent({ name: 'Worker 1', role: 'worker', model: '' });
    return { orchestrator, project, worker };
  }

  it('fixes a failing gate, commits on the ticket branch and moves the ticket to review', async () => {
    const agent = new FakeAgent();
    const { orchestrator, project, worker } = setup(agent);
    const ticket = store.createManualTicket(project.id, 'DEM', { title: 'Say hello', description: '', acceptanceCriteria: 'hello.txt says hello', labels: [] });

    const run = await orchestrator.start(project.id, ticket.key);
    expect(run.branch).toBe('feat/DEM-1-say-hello');
    await waitFor(() => settled(store.getRun(run.id)!.status));

    const done = store.getRun(run.id)!;
    expect(done.status).toBe('in_review');
    expect(done.attempts).toBe(1);
    expect(agent.calls).toHaveLength(2);
    expect(agent.calls[1].resume).toBe('session-1');
    expect(agent.calls[0].systemPrompt).toContain('Keep it small.');
    expect(agent.reviews).toHaveLength(1);
    expect(agent.reviews[0].allowedTools).not.toContain('Write');
    expect(store.listReviews(run.id).map((r) => r.verdict)).toEqual(['approve']);
    expect(done.costUsd).toBeCloseTo(0.04);
    expect(await git(repo, ['log', '-1', '--format=%s', done.branch])).toBe('feat: say hello [DEM-1]');
    expect(readFileSync(join(done.worktree, 'hello.txt'), 'utf8')).toBe('hello\n');
    expect(store.getManualTicket(project.id, ticket.key)!.status).toBe('in_review');
    expect(store.getAgent(worker.id)!.state).toBe('available');
    expect(store.listEvents(run.id).some((e) => e.kind === 'gate' && e.message.startsWith('FAIL'))).toBe(true);
  });

  it('starts a local project from your local branch, even when its remote copy is behind', async () => {
    const remote = join(home, 'remote.git');
    await git(home, ['clone', '--bare', '-q', repo, remote]);
    await git(repo, ['remote', 'add', 'origin', remote]);
    await git(repo, ['fetch', '-q', 'origin']);
    writeFileSync(join(repo, 'local.txt'), 'unpushed\n');
    await git(repo, ['add', '.']);
    await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'unpushed work']);
    const { orchestrator, project } = setup(new FakeAgent());
    const ticket = store.createManualTicket(project.id, 'DEM', { title: 'Say hello', description: '', acceptanceCriteria: 'x', labels: [] });
    const run = await orchestrator.start(project.id, ticket.key);
    expect(run.baseRef).toBe('main');
    expect(readFileSync(join(run.worktree, 'local.txt'), 'utf8')).toBe('unpushed\n');
    await waitFor(() => settled(store.getRun(run.id)!.status));
  });

  it('blocks the agent when the gate keeps failing', async () => {
    const { orchestrator, project, worker } = setup(new FakeAgent(true));
    const ticket = store.createManualTicket(project.id, 'DEM', { title: 'Say hello', description: '', acceptanceCriteria: 'x', labels: [] });
    const run = await orchestrator.start(project.id, ticket.key);
    await waitFor(() => settled(store.getRun(run.id)!.status));
    expect(store.getRun(run.id)!.status).toBe('blocked');
    expect(store.getAgent(worker.id)!.state).toBe('blocked');
  });

  it('refuses tickets that are not ready, unless forced', async () => {
    const { orchestrator, project } = setup(new FakeAgent());
    const ticket = store.createManualTicket(project.id, 'DEM', { title: 'Vague', description: '', acceptanceCriteria: '', labels: [] });
    await expect(orchestrator.start(project.id, ticket.key)).rejects.toThrow(/Acceptance criteria/);
    const run = await orchestrator.start(project.id, ticket.key, { force: true });
    await waitFor(() => settled(store.getRun(run.id)!.status));
  });

  it('serves the same flow over the API', async () => {
    const agent = new FakeAgent();
    const orchestrator = new Orchestrator({ store, secrets, agent, reposDir: join(home, 'repos'), worktreesDir: join(home, 'wt') });
    store.createAgent({ name: 'Worker 1', role: 'worker', model: '' });
    const app = await buildServer({ store, secrets, agent, orchestrator, reposDir: join(home, 'repos') });

    const created = await app.inject({
      method: 'POST', url: '/api/projects',
      payload: { name: 'Api demo', codeHost: { provider: 'local', localPath: repo, defaultBranch: 'main' }, workflowYaml: WORKFLOW },
    });
    expect(created.statusCode).toBe(200);
    const projectId = created.json().id;

    const t = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/tickets`, payload: { title: 'Say hello', acceptanceCriteria: 'hello' } });
    expect(t.json().key).toBe('API-1');

    const started = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/tickets/API-1/start`, payload: {} });
    expect(started.statusCode).toBe(200);
    const runId = started.json().id;
    await waitFor(() => settled(store.getRun(runId)!.status));

    const run = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(run.json().status).toBe('in_review');
    const diff = await app.inject({ method: 'GET', url: `/api/runs/${runId}/diff` });
    expect(diff.json().diff).toContain('+hello');

    await app.inject({ method: 'PUT', url: '/api/secrets/GITHUB_TOKEN', payload: { value: 'secret-value' } });
    const settings = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(settings.body).not.toContain('secret-value');
    expect(settings.json().secrets.find((s: { name: string }) => s.name === 'GITHUB_TOKEN').set).toBe(true);

    await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}`, payload: { pm: { provider: 'jira', settings: { projectKey: 'API' } }, design: { provider: 'figma', settings: { file: 'F1' } } } });
    await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}`, payload: { context: 'Only the knowledge tab.' } });
    const kept = store.getProject(projectId)!;
    expect(kept.context).toBe('Only the knowledge tab.');
    expect(kept.pm).toEqual({ provider: 'jira', settings: { projectKey: 'API' } });
    expect(kept.design.provider).toBe('figma');

    const bad = await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}`, payload: { workflowYaml: 'max_fix_attempts: lots' } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});

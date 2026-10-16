import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentOutcome, AgentTask, CodingAgent } from '../src/agents/coding-agent.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { git } from '../src/proc.js';
import { SecretStore } from '../src/secrets.js';
import type { Project } from '../src/types.js';

const WORKFLOW = `base_branch: main
pull_before_start: false
quality_gates: []
review:
  enabled: false
orchestration:
  auto_assign: true
  max_parallel: 3
`;

/** Holds every run open until release() so the test can look at what runs in parallel. */
class HeldAgent implements CodingAgent {
  calls: AgentTask[] = [];
  private waiting: (() => void)[] = [];
  async run(task: AgentTask): Promise<AgentOutcome> {
    this.calls.push(task);
    writeFileSync(join(task.cwd, 'work.txt'), `${task.prompt}\n`);
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    return { sessionId: 's', text: 'Done', costUsd: 0.01, ok: true };
  }
  release(): void {
    this.waiting.splice(0).forEach((r) => r());
  }
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('auto-assign', () => {
  let home: string;
  let repo: string;
  let store: Store;
  let agent: HeldAgent;
  let orchestrator: Orchestrator;
  let project: Project;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'maestro-auto-'));
    repo = join(home, 'app');
    mkdirSync(repo);
    await git(repo, ['init', '-b', 'main']);
    writeFileSync(join(repo, 'README.md'), '# app\n');
    await git(repo, ['add', '.']);
    await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
    store = new Store(join(home, 'db.sqlite'));
    agent = new HeldAgent();
    orchestrator = new Orchestrator({ store, secrets: new SecretStore(join(home, 's.json')), agent, reposDir: join(home, 'repos'), worktreesDir: join(home, 'wt') });
    project = store.createProject({
      name: 'Auto', description: '', codeHost: { provider: 'local', localPath: repo, defaultBranch: 'main' },
      pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} },
      context: '', requirements: '', bestPractices: '', workflowYaml: WORKFLOW,
    });
    for (const n of [1, 2, 3]) store.createAgent({ name: `Worker ${n}`, role: 'worker', model: '' });
  });
  afterEach(async () => {
    store.setSetting(`autoAssign.${project.id}`, 'false');
    agent.release();
    await waitFor(() => store.listRuns().every((r) => r.status !== 'running'));
    await orchestrator.tick();
    store.db.close();
  });

  const ticket = (title: string, labels: string[]) =>
    store.createManualTicket(project.id, 'AUT', { title, description: '', acceptanceCriteria: 'works', size: 'S', labels });
  const running = () => store.listRuns(project.id).filter((r) => r.status === 'running').map((r) => r.ticketKey).sort();

  it('starts independent ready tickets in parallel and respects deps and areas', async () => {
    const api = ticket('Add endpoint', ['area:api']);
    const ui = ticket('Add page', ['area:ui']);
    const api2 = ticket('Add second endpoint', ['area:api']);
    const after = ticket('Wire page to endpoint', ['area:web']);
    store.addDependency(project.id, after.key, api.key);
    ticket('Too vague', []);
    store.db.prepare("UPDATE manual_tickets SET acceptance_criteria = '' WHERE key = 'AUT-5'").run();

    const started = await orchestrator.tick();
    expect(started.map((r) => r.ticketKey)).toEqual([api.key, ui.key]);
    expect(running()).toEqual([api.key, ui.key]);
    await waitFor(() => agent.calls.length === 2);
    expect(store.listRuns(project.id).find((r) => r.ticketKey === api.key)!.area).toBe('api');
    expect(new Set(store.listRuns(project.id).map((r) => r.agentId)).size).toBe(2);

    // A second tick changes nothing while both run.
    expect(await orchestrator.tick()).toEqual([]);

    // When the first two finish, the second api ticket is free to go; the dependent one waits for done.
    agent.release();
    const statusOf = (key: string) => store.listRuns(project.id).find((r) => r.ticketKey === key)?.status;
    await waitFor(() => statusOf(api.key) === 'in_review' && statusOf(ui.key) === 'in_review' && running().includes(api2.key));
    expect(running()).toEqual([api2.key]);

    store.setManualTicketStatus(project.id, api.key, 'done');
    await orchestrator.tick();
    expect(running()).toEqual([api2.key, after.key].sort());
    expect(store.getManualTicket(project.id, 'AUT-5')!.status).toBe('todo');
  });

  it('never gives one worker two tickets when starts race', async () => {
    for (const a of store.listAgents().slice(1)) store.deleteAgent(a.id);
    const one = ticket('One', ['area:a']);
    const two = ticket('Two', ['area:b']);
    const results = await Promise.allSettled([orchestrator.start(project.id, one.key), orchestrator.start(project.id, two.key)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: "no_free_worker", message: "Every worker is busy or paused." });
    expect(store.listRuns(project.id)).toHaveLength(1);
  });

  it('starts a ticket once when it is started twice at the same time', async () => {
    const one = ticket('One', ['area:a']);
    const results = await Promise.allSettled([orchestrator.start(project.id, one.key), orchestrator.start(project.id, one.key)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(store.listRuns(project.id)).toHaveLength(1);
    expect(store.listAgents().filter((a) => a.state === 'available')).toHaveLength(2);
  });

  it('frees the worker when setting up the run fails', async () => {
    store.updateProject(project.id, { codeHost: { provider: 'local', localPath: join(home, 'gone'), defaultBranch: 'main' } });
    const one = ticket('One', ['area:a']);
    await expect(orchestrator.start(project.id, one.key)).rejects.toThrow(/Folder not found/);
    expect(store.listAgents().every((a) => a.state === 'available')).toBe(true);
  });

  it('honours max_parallel and the global limit', async () => {
    store.setSetting('maxConcurrentRuns', '1');
    ticket('One', ['area:a']);
    ticket('Two', ['area:b']);
    expect((await orchestrator.tick()).map((r) => r.ticketKey)).toEqual(['AUT-1']);
  });

  it('does nothing when the board toggle turns auto-assign off', async () => {
    store.setSetting(`autoAssign.${project.id}`, 'false');
    ticket('One', ['area:a']);
    expect(await orchestrator.tick()).toEqual([]);
    expect(store.listRuns(project.id)).toHaveLength(0);
    expect(orchestrator.autoAssignEnabled(project)).toBe(false);
  });

  it('is off by default for workflows without an orchestration section', async () => {
    store.updateProject(project.id, { workflowYaml: 'base_branch: main\npull_before_start: false\n' });
    ticket('One', ['area:a']);
    expect(await orchestrator.tick()).toEqual([]);
  });
});

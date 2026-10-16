import { ADMIN } from './users.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CodeHostAdapter, PullRequestStatus, ReviewToPost } from '../src/adapters/codehost/types.js';
import { combineChecks } from '../src/adapters/codehost/github.js';
import type { AgentOutcome, AgentTask, CodingAgent } from '../src/agents/coding-agent.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { git } from '../src/proc.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import type { Project } from '../src/types.js';

const WORKFLOW = (maxRounds = 2) => `base_branch: main
pull_before_start: false
quality_gates:
  - name: greeting
    run: node -e "process.exit(require('fs').readFileSync('hello.txt','utf8').startsWith('hello')?0:1)"
review:
  max_rounds: ${maxRounds}
`;

type Verdict = { verdict: 'approve' | 'changes_requested'; summary: string; comments: { file: string | null; line: number | null; body: string }[] };
const approve: Verdict = { verdict: 'approve', summary: 'Good.', comments: [] };
const changes: Verdict = { verdict: 'changes_requested', summary: 'Needs a name.', comments: [{ file: 'hello.txt', line: 1, body: 'Greet someone by name.' }] };

/** Worker writes hello.txt and adds a line per feedback round; reviewer answers from a script (approve when it runs out). */
class ScriptedAgent implements CodingAgent {
  worker: AgentTask[] = [];
  reviewer: AgentTask[] = [];
  constructor(private readonly verdicts: Verdict[] = []) {}
  async run(task: AgentTask): Promise<AgentOutcome> {
    if (task.outputSchema) {
      this.reviewer.push(task);
      return { sessionId: 'r', text: '', costUsd: 0.05, ok: true, structured: this.verdicts.shift() ?? approve };
    }
    this.worker.push(task);
    const file = join(task.cwd, 'hello.txt');
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    writeFileSync(file, task.prompt.includes('Review feedback') ? `${before}name line ${this.worker.length}\n` : 'hello\n');
    return { sessionId: 'worker-session', text: `Summary ${this.worker.length}`, costUsd: 0.01, ok: true };
  }
}

/** Behaves like GitHub: PR number 7, records posted reviews, and serves a PR status the test sets. */
class FakeGitHub implements CodeHostAdapter {
  readonly provider = 'github';
  posted: ReviewToPost[] = [];
  pushes = 0;
  status: PullRequestStatus = { state: 'open', checks: 'pending', headSha: 'abc', feedback: [] };
  constructor(private readonly repo: string) {}
  async ensureRepo(): Promise<string> { return this.repo; }
  async syncBase(): Promise<void> {}
  async pushBranch(): Promise<void> { this.pushes += 1; }
  async openPullRequest() { return { url: 'https://github.com/o/r/pull/7', number: 7 }; }
  async postReview(_p: Project, pr: number, review: ReviewToPost) {
    expect(pr).toBe(7);
    this.posted.push(review);
    return { externalIds: [`review:${this.posted.length}`] };
  }
  async pullRequestStatus(): Promise<PullRequestStatus> { return this.status; }
}

const settled = (s: string) => !['running', 'reviewing'].includes(s);
async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('review loop', () => {
  let home: string;
  let repo: string;
  let store: Store;
  let secrets: SecretStore;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'maestro-review-'));
    repo = join(home, 'app');
    mkdirSync(repo);
    await git(repo, ['init', '-b', 'main']);
    writeFileSync(join(repo, 'README.md'), '# app\n');
    await git(repo, ['add', '.']);
    await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
    store = new Store(join(home, 'db.sqlite'));
    secrets = new SecretStore(join(home, 's.json'));
  });
  afterEach(() => store.db.close());

  function setup(agent: CodingAgent, opts: { maxRounds?: number; github?: FakeGitHub } = {}) {
    const orchestrator = new Orchestrator({
      store, secrets, agent, reposDir: join(home, 'repos'), worktreesDir: join(home, 'wt'),
      codeHostFor: opts.github ? () => opts.github! : undefined,
    });
    const project = store.createProject({
      name: 'Demo', description: '', codeHost: { provider: opts.github ? 'github' : 'local', localPath: repo, repo: 'o/r', defaultBranch: 'main' },
      pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} },
      context: '', requirements: '', bestPractices: 'Greet by name.', workflowYaml: WORKFLOW(opts.maxRounds),
    });
    const worker = store.createAgent({ name: 'Worker 1', role: 'worker', model: '' });
    const ticket = store.createManualTicket(project.id, 'DEM', { title: 'Say hello', description: '', acceptanceCriteria: 'hello.txt greets', labels: [] });
    return { orchestrator, project, worker, ticket };
  }

  it('fixes what the reviewer asks for on the same branch and session, then waits for you', async () => {
    const agent = new ScriptedAgent([changes, approve]);
    const { orchestrator, worker, ticket } = setup(agent);
    const run = await orchestrator.start(store.listProjects()[0].id, ticket.key);
    await waitFor(() => settled(store.getRun(run.id)!.status));

    const done = store.getRun(run.id)!;
    expect(done.status).toBe('in_review');
    expect(done.reviewRounds).toBe(1);
    expect(agent.reviewer).toHaveLength(2);
    expect(agent.reviewer[0].systemPrompt).toContain('hello.txt greets');
    expect(agent.reviewer[0].systemPrompt).toContain(`git diff ${done.baseRef}...HEAD`);
    expect(agent.worker).toHaveLength(2);
    expect(agent.worker[1].resume).toBe('worker-session');
    expect(agent.worker[1].prompt).toContain('hello.txt:1: Greet someone by name.');
    expect(await git(repo, ['log', '--format=%s', `main..${done.branch}`])).toBe('fix: address review feedback [DEM-1]\nfeat: say hello [DEM-1]');
    // The run's diff is the whole change, not just the last commit.
    const app = await buildServer({ actAs: ADMIN, store, secrets, agent, orchestrator, reposDir: join(home, 'repos') });
    const diff = (await app.inject({ method: 'GET', url: `/api/runs/${run.id}/diff` })).json().diff as string;
    expect(diff).toContain('fix: address review feedback [DEM-1]');
    expect(diff).toContain('feat: say hello [DEM-1]');
    expect(diff).toContain('+hello');
    expect(diff).toContain('+name line 2');
    await app.close();
    const reviews = store.listReviews(run.id);
    expect(reviews.map((r) => [r.verdict, r.addressed])).toEqual([['changes_requested', true], ['approve', true]]);
    expect(store.getAgent(worker.id)!.state).toBe('available');
  });

  it('blocks the ticket for you when the review rounds run out', async () => {
    const agent = new ScriptedAgent([changes, changes, changes]);
    const { orchestrator, project, worker, ticket } = setup(agent, { maxRounds: 1 });
    const run = await orchestrator.start(project.id, ticket.key);
    await waitFor(() => settled(store.getRun(run.id)!.status));
    expect(store.getRun(run.id)!.status).toBe('blocked');
    expect(store.getRun(run.id)!.error).toContain('after 1 review rounds');
    expect(agent.reviewer).toHaveLength(2);
    expect(store.getAgent(worker.id)!.state).toBe('blocked');
  });

  it('takes your review in Maestro: changes go back to the worker, approval finishes the ticket', async () => {
    const agent = new ScriptedAgent();
    const { orchestrator, project, ticket } = setup(agent);
    const app = await buildServer({ actAs: ADMIN, store, secrets, agent, orchestrator, reposDir: join(home, 'repos') });
    const run = await orchestrator.start(project.id, ticket.key);
    await waitFor(() => settled(store.getRun(run.id)!.status));

    const asked = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/reviews`, payload: { verdict: 'changes_requested', summary: 'Use my name.' } });
    expect(asked.statusCode).toBe(200);
    await waitFor(() => agent.worker.length === 2 && settled(store.getRun(run.id)!.status));
    expect(agent.worker[1].prompt).toContain('Use my name.');
    expect(agent.reviewer[0].systemPrompt).not.toContain('Change requests from people');
    expect(agent.reviewer[1].systemPrompt).toContain('## Change requests from people (check each was handled)\n- You (the owner): Use my name.');
    expect(store.getRun(run.id)!.status).toBe('in_review');
    expect(store.pendingFeedback(run.id)).toEqual([]);

    const approved = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/reviews`, payload: { verdict: 'approve' } });
    expect(approved.statusCode).toBe(200);
    const final = store.getRun(run.id)!;
    expect(final.status).toBe('done');
    expect(store.getManualTicket(project.id, ticket.key)!.status).toBe('done');
    expect(existsSync(final.worktree)).toBe(false);

    const detail = (await app.inject({ method: 'GET', url: `/api/runs/${run.id}` })).json();
    expect(detail.reviews.map((r: { source: string }) => r.source)).toEqual(['agent', 'human', 'agent', 'human']);

    // Deleting the project removes what Maestro recorded for it.
    await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` });
    expect(store.getRun(run.id)).toBeUndefined();
    expect(store.listReviews(run.id)).toEqual([]);
    expect(store.listEvents(run.id)).toEqual([]);
    expect(store.listAlerts()).toEqual([]);
    expect(store.spendByProject().size).toBe(0);
    await app.close();
  });

  it('picks a blocked run up again with your guidance and publishes it once the gates pass', async () => {
    // Gets the greeting wrong until you say how; then it is right.
    const tasks: AgentTask[] = [];
    const agent: CodingAgent = {
      async run(task: AgentTask): Promise<AgentOutcome> {
        tasks.push(task);
        if (task.outputSchema) return { sessionId: 'r', text: '', costUsd: 0, ok: true, structured: approve };
        writeFileSync(join(task.cwd, 'hello.txt'), task.prompt.includes('Spell it h-e-l-l-o') ? 'hello\n' : 'helo\n');
        return { sessionId: 'worker-session', text: 'Tried.', costUsd: 0, ok: true };
      },
    };
    const github = new FakeGitHub(repo);
    const { orchestrator, project, worker, ticket } = setup(agent, { github });
    const app = await buildServer({ actAs: ADMIN, store, secrets, agent, orchestrator, reposDir: join(home, 'repos') });
    const run = await orchestrator.start(project.id, ticket.key);
    await waitFor(() => settled(store.getRun(run.id)!.status));
    expect(store.getRun(run.id)!.status).toBe('blocked');
    expect(store.getRun(run.id)!.prNumber).toBeNull();
    expect(store.getAgent(worker.id)!.state).toBe('blocked');

    const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/reviews`, payload: { verdict: 'changes_requested', summary: 'Spell it h-e-l-l-o.' } });
    expect(res.statusCode).toBe(200);
    await waitFor(() => store.getRun(run.id)!.status === 'in_review' && !!store.getRun(run.id)!.readyAt && !orchestrator.isActive(run.id));

    const done = store.getRun(run.id)!;
    expect(done.error).toBeNull();
    expect(done.prNumber).toBe(7);
    expect(await git(repo, ['log', '--format=%s', `main..${done.branch}`])).toBe('feat: say hello [DEM-1]');
    expect(tasks.filter((t) => !t.outputSchema).at(-1)!.resume).toBe('worker-session');
    expect(store.getAgent(worker.id)!.state).toBe('available');
    expect(store.getManualTicket(project.id, ticket.key)!.status).toBe('in_review');
    await app.close();
  });

  it('after an engine restart, a published run that was addressing feedback goes back to review and the feedback is retried', async () => {
    const agent = new ScriptedAgent();
    const { orchestrator, project, ticket } = setup(agent);
    const run = await orchestrator.start(project.id, ticket.key);
    await waitFor(() => settled(store.getRun(run.id)!.status));
    store.addReview({ runId: run.id, source: 'human', verdict: 'changes_requested', summary: 'Shout it.', comments: [] });
    // As if the engine died mid-fix: running, published, feedback not yet addressed.
    store.updateRun(run.id, { status: 'running' });
    const fresh = new Orchestrator({ store, secrets, agent, reposDir: join(home, 'repos'), worktreesDir: join(home, 'wt') });
    fresh.recover();
    expect(store.getRun(run.id)!.status).toBe('in_review');
    await fresh.tick();
    await waitFor(() => agent.worker.length === 2 && settled(store.getRun(run.id)!.status));
    expect(agent.worker[1].prompt).toContain('Shout it.');
    expect(store.getRun(run.id)!.status).toBe('in_review');
  });

  it('posts reviews on the PR and follows it: checks, change requests and the merge', async () => {
    const agent = new ScriptedAgent([changes]);
    const github = new FakeGitHub(repo);
    const { orchestrator, project, ticket } = setup(agent, { github });
    const run = await orchestrator.start(project.id, ticket.key);
    await waitFor(() => settled(store.getRun(run.id)!.status));
    expect(store.getRun(run.id)!.prNumber).toBe(7);
    expect(github.posted.map((p) => p.verdict)).toEqual(['changes_requested', 'approve']);
    expect(github.posted[0].comments[0]).toEqual({ file: 'hello.txt', line: 1, body: 'Greet someone by name.' });
    expect(github.pushes).toBe(2);

    github.status = {
      state: 'open', checks: 'failure', headSha: 'def',
      feedback: [
        { externalId: 'review:99', author: 'belgacem', verdict: 'changes_requested', body: 'Please add a test.', file: null, line: null, createdAt: '2026-10-10T10:00:00Z' },
        { externalId: 'review:98', author: 'belgacem', verdict: 'comment', body: 'Nice start.', file: null, line: null, createdAt: '2026-10-10T09:00:00Z' },
      ],
    };
    await orchestrator.pollPullRequests();
    expect(store.getRun(run.id)!.checks).toBe('failure');
    await waitFor(() => agent.worker.length === 3 && settled(store.getRun(run.id)!.status));
    expect(agent.worker[2].prompt).toContain('belgacem');
    expect(agent.worker[2].prompt).toContain('Please add a test.');
    expect(github.pushes).toBe(3);

    // The same feedback seen again is not handled twice.
    await orchestrator.pollPullRequests();
    expect(agent.worker).toHaveLength(3);

    github.status = { ...github.status, state: 'merged', checks: 'success' };
    await orchestrator.pollPullRequests();
    expect(store.getRun(run.id)!.status).toBe('done');
    expect(store.getManualTicket(project.id, ticket.key)!.status).toBe('done');
  });

  it('follows the PR of a blocked run: a change request unblocks it, a merge finishes it', async () => {
    const github = new FakeGitHub(repo);
    const agent = new ScriptedAgent([changes, changes]);
    const { orchestrator, project, worker, ticket } = setup(agent, { github, maxRounds: 0 });
    const run = await orchestrator.start(project.id, ticket.key);
    await waitFor(() => settled(store.getRun(run.id)!.status));
    expect(store.getRun(run.id)!.status).toBe('blocked');

    github.status = { ...github.status, feedback: [{ externalId: 'review:7', author: 'bel', verdict: 'changes_requested', body: 'Do it like this.', file: null, line: null, createdAt: '2026-10-10T10:00:00Z' }] };
    await orchestrator.pollPullRequests();
    await waitFor(() => agent.worker.length === 2 && settled(store.getRun(run.id)!.status));
    expect(agent.worker[1].prompt).toContain('Do it like this.');

    github.status = { ...github.status, state: 'merged' };
    await orchestrator.pollPullRequests();
    expect(store.getRun(run.id)!.status).toBe('done');
    expect(store.getAgent(worker.id)!.state).toBe('available');
  });

  it('stops the run when the PR is closed without merging', async () => {
    const github = new FakeGitHub(repo);
    const { orchestrator, project, ticket } = setup(new ScriptedAgent(), { github });
    const run = await orchestrator.start(project.id, ticket.key);
    await waitFor(() => settled(store.getRun(run.id)!.status));
    github.status = { ...github.status, state: 'closed' };
    await orchestrator.pollPullRequests();
    expect(store.getRun(run.id)!.status).toBe('stopped');
  });
});

describe('CI checks', () => {
  it('combines check runs and commit statuses', () => {
    expect(combineChecks([], { state: 'pending', statuses: [] })).toBe('none');
    expect(combineChecks([{ status: 'completed', conclusion: 'success' }], { state: 'pending', statuses: [] })).toBe('success');
    expect(combineChecks([{ status: 'in_progress', conclusion: null }], { state: 'success', statuses: [{}] })).toBe('pending');
    expect(combineChecks([{ status: 'completed', conclusion: 'skipped' }], { state: 'failure', statuses: [{}] })).toBe('failure');
  });
});

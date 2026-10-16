import { ADMIN } from './users.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentOutcome, AgentTask, CodingAgent } from '../src/agents/coding-agent.js';
import { budgetState, startOfToday } from '../src/budget.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { git } from '../src/proc.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

const GATE = `quality_gates:
  - name: greeting
    run: node -e "process.exit(require('fs').readFileSync('hello.txt','utf8').trim()==='hello'?0:1)"
`;

/** Writes the wrong greeting first and the right one when asked to fix; each call costs `cost` USD and `tokens` input tokens. */
class CostlyAgent implements CodingAgent {
  tasks: AgentTask[] = [];
  constructor(private readonly cost: number, private readonly ok = true, private readonly tokens = 0) {}
  async run(task: AgentTask): Promise<AgentOutcome> {
    this.tasks.push(task);
    const usage = this.tokens ? { input: this.tokens, output: 0, cache: 0 } : null;
    if (task.outputSchema) return { sessionId: 'r', text: '', costUsd: this.cost, usage, ok: true, structured: { verdict: 'approve', summary: '', comments: [] } };
    writeFileSync(join(task.cwd, 'hello.txt'), task.prompt.includes('quality gate failed') ? 'hello\n' : 'helo\n');
    return this.ok ? { sessionId: 's', text: 'Done', costUsd: this.cost, usage, ok: true } : { sessionId: 's', text: '', costUsd: this.cost, usage, ok: false, error: 'API overloaded' };
  }
}

async function setup(agent: CodingAgent, workflow = `pull_before_start: false\n${GATE}`) {
  const home = mkdtempSync(join(tmpdir(), 'maestro-budget-'));
  const repo = join(home, 'app');
  mkdirSync(repo);
  await git(repo, ['init', '-b', 'main']);
  writeFileSync(join(repo, 'README.md'), '# app\n');
  await git(repo, ['add', '.']);
  await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
  const store = new Store(join(home, 'db.sqlite'));
  const secrets = new SecretStore(join(home, 's.json'));
  const orchestrator = new Orchestrator({ store, secrets, agent, reposDir: home, worktreesDir: join(home, 'wt') });
  const app = await buildServer({ actAs: ADMIN, store, secrets, agent, orchestrator, reposDir: home });
  const p = store.createProject({
    name: 'Budgeted', description: '', codeHost: { provider: 'local', localPath: repo, defaultBranch: 'main' },
    pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} }, context: '', requirements: '', bestPractices: '',
    workflowYaml: workflow,
  });
  store.createAgent({ name: 'W', role: 'worker', model: '' });
  const ticket = (title = 'Say hello') => store.createManualTicket(p.id, 'BUD', { title, description: '', acceptanceCriteria: 'hello', labels: [] });
  const finish = async (runId: string) => {
    const until = Date.now() + 10_000;
    while (['running', 'reviewing'].includes(store.getRun(runId)!.status) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    return store.getRun(runId)!;
  };
  return { app, store, orchestrator, p, ticket, finish };
}

describe('budgets', () => {
  it('passes the tokens left in the run budget to each call, and skips the reviewer once they are used', async () => {
    const agent = new CostlyAgent(0, true, 600_000);
    const { store, orchestrator, p, ticket, finish } = await setup(agent);
    store.setSetting('budget.perRunTokens', '1000000');
    const run = await finish((await orchestrator.start(p.id, ticket().key)).id);
    expect(run.status).toBe('in_review');
    expect(agent.tasks.map((t) => t.maxTokens)).toEqual([1_000_000, 400_000]);
    expect(agent.tasks.some((t) => t.outputSchema)).toBe(false);
    expect(store.listEvents(run.id).some((e) => e.message.includes('Skipping the reviewer agent'))).toBe(true);
    expect(run.usage).toEqual({ input: 1_200_000, output: 0, cache: 0 });
    expect(store.spendSince(p.id, startOfToday())).toEqual({ usd: 0, usage: { input: 1_200_000, output: 0, cache: 0 } });
  });

  it('turns an optional euro cap into the USD left for each call', async () => {
    const agent = new CostlyAgent(0.6);
    const { store, orchestrator, p, ticket, finish } = await setup(agent);
    store.setSetting('currency.eurPerUsd', '0.9');
    store.setSetting('budget.perRunEur', '0.9');
    await finish((await orchestrator.start(p.id, ticket().key)).id);
    expect(agent.tasks[0].maxBudgetUsd).toBeCloseTo(1);
    expect(agent.tasks[1].maxBudgetUsd).toBeCloseTo(0.4);
  });

  it('blocks a run at whichever cap it reaches first', async () => {
    const tokens = await setup(new CostlyAgent(0, true, 600_000));
    tokens.store.setSetting('budget.perRunTokens', '500000');
    const r1 = await tokens.finish((await tokens.orchestrator.start(tokens.p.id, tokens.ticket().key)).id);
    expect(r1.status).toBe('blocked');
    expect(r1.error).toBe('This run reached its budget of 500k tokens (Settings).');
    expect(tokens.store.listAlerts().map((a) => a.kind)).toEqual(['budget']);

    const euros = await setup(new CostlyAgent(0.6));
    euros.store.setSetting('budget.perRunEur', '0.45');
    const r2 = await euros.finish((await euros.orchestrator.start(euros.p.id, euros.ticket().key)).id);
    expect(r2.status).toBe('blocked');
    expect(r2.error).toBe('This run reached its budget of ≈ €0.45 (Settings).');
  });

  it('stops new work and pauses auto-assign at the daily token cap, with one alert a day', async () => {
    const { app, store, orchestrator, p, ticket } = await setup(new CostlyAgent(0.1), `pull_before_start: false\nquality_gates: []\norchestration:\n  auto_assign: true\n`);
    const t = ticket();
    store.addSpend(p.id, null, 'planner', 0, { input: 4000, output: 1000, cache: 0 });
    await app.inject({ method: 'PUT', url: `/api/projects/${p.id}/budget`, payload: { dailyTokens: 5000 } });
    expect(budgetState(store, p.id)).toMatchObject({ caps: { tokens: 5000, eur: 0 }, tokensLeft: 0, over: '5k tokens' });

    await expect(orchestrator.start(p.id, t.key)).rejects.toThrow(/daily budget of 5k tokens/);
    expect(await orchestrator.tick()).toEqual([]);
    expect(await orchestrator.tick()).toEqual([]);
    expect(store.listAlerts().filter((a) => a.kind === 'budget')).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/plan` })).json().error).toMatch(/daily budget/);

    const spend = (await app.inject({ method: 'GET', url: '/api/spend' })).json();
    expect(spend[0]).toMatchObject({ name: 'Budgeted', today: { usd: 0, usage: { input: 4000, output: 1000, cache: 0 } }, dailyCaps: { tokens: 5000 }, own: { tokens: '5000', eur: null } });

    await app.inject({ method: 'PUT', url: `/api/projects/${p.id}/budget`, payload: { dailyTokens: null } });
    expect(budgetState(store, p.id).over).toBeNull();
    await app.close();
  });

  it('blocks instead of failing when the agent stops at a limit, so you can continue it', async () => {
    const limit = (error: string): CodingAgent => ({
      async run(): Promise<AgentOutcome> {
        return { sessionId: 's1', text: '', costUsd: 0.2, ok: false, error };
      },
    });
    for (const error of ['Agent stopped: error_max_budget_usd', 'Agent stopped: error_max_budget_tokens']) {
      const budget = await setup(limit(error));
      const r1 = await budget.finish((await budget.orchestrator.start(budget.p.id, budget.ticket().key)).id);
      expect(r1.status).toBe('blocked');
      expect(r1.sessionId).toBe('s1');
      expect(budget.store.listAlerts()[0].kind).toBe('budget');
    }

    const turns = await setup(limit('Agent stopped: error_max_turns'));
    const r2 = await turns.finish((await turns.orchestrator.start(turns.p.id, turns.ticket().key)).id);
    expect(r2.status).toBe('blocked');
    expect(r2.error).toMatch(/used all its turns/);
  });

  it('applies the default daily caps to projects without their own', async () => {
    const { store, p } = await setup(new CostlyAgent(0));
    store.setSetting('budget.projectDailyTokens', '100');
    store.addSpend(p.id, null, 'chat', 0, { input: 80, output: 30, cache: 0 });
    expect(budgetState(store, p.id).over).toBe('100 tokens');
    store.setSetting('budget.projectDailyTokens', '0');
    store.setSetting('budget.projectDailyEur', '1');
    store.addSpend(p.id, null, 'chat', 1.2);
    expect(budgetState(store, p.id).over).toBe('≈ €1.00');
  });
});

describe('alerts', () => {
  it('tells you when a change is ready and when a run fails, and can be marked read', async () => {
    const ok = await setup(new CostlyAgent(0.01));
    const run = await ok.finish((await ok.orchestrator.start(ok.p.id, ok.ticket().key)).id);
    expect(run.status).toBe('in_review');
    expect(ok.store.listAlerts()[0]).toMatchObject({ kind: 'ready', message: 'BUD-1 is ready for your review.', runId: run.id, read: false });

    const bad = await setup(new CostlyAgent(0.01, false));
    await bad.finish((await bad.orchestrator.start(bad.p.id, bad.ticket().key)).id);
    const res = (await bad.app.inject({ method: 'GET', url: '/api/alerts' })).json();
    expect(res.unread).toBe(1);
    expect(res.alerts[0]).toMatchObject({ kind: 'failed', message: 'BUD-1 failed: API overloaded' });
    await bad.app.inject({ method: 'POST', url: '/api/alerts/read', payload: {} });
    expect((await bad.app.inject({ method: 'GET', url: '/api/alerts' })).json().unread).toBe(0);
    await ok.app.close();
    await bad.app.close();
  });
});

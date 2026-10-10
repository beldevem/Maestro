import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentOutcome, AgentTask, CodingAgent } from '../src/agents/coding-agent.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { git } from '../src/proc.js';
import { SecretStore } from '../src/secrets.js';

const agent: CodingAgent = {
  async run(task: AgentTask): Promise<AgentOutcome> {
    if (!task.outputSchema) writeFileSync(join(task.cwd, 'feature.txt'), 'new\n');
    return { sessionId: 's', text: 'Done', costUsd: 0, ok: true, structured: { verdict: 'approve', summary: '', comments: [] } };
  },
};

async function readyRun() {
  const home = mkdtempSync(join(tmpdir(), 'maestro-merge-'));
  const repo = join(home, 'app');
  mkdirSync(repo);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@t']);
  await git(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'README.md'), '# app\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'init']);
  const store = new Store(join(home, 'db.sqlite'));
  const orchestrator = new Orchestrator({ store, secrets: new SecretStore(join(home, 's.json')), agent, reposDir: home, worktreesDir: join(home, 'wt') });
  const p = store.createProject({
    name: 'Merge', description: '', codeHost: { provider: 'local', localPath: repo, defaultBranch: 'main' },
    pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} }, context: '', requirements: '', bestPractices: '',
    workflowYaml: 'pull_before_start: false\nquality_gates: []\n',
  });
  store.createAgent({ name: 'W', role: 'worker', model: '' });
  const t = store.createManualTicket(p.id, 'MRG', { title: 'Add feature', description: '', acceptanceCriteria: 'x', labels: [] });
  const run = await orchestrator.start(p.id, t.key);
  const until = Date.now() + 10_000;
  while (store.getRun(run.id)!.status !== 'in_review' && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  return { repo, store, orchestrator, run: store.getRun(run.id)!, p };
}

describe('merge for local projects', () => {
  it('merges into the checked-out base when it is clean and finishes the ticket', async () => {
    const { repo, store, orchestrator, run, p } = await readyRun();
    const done = await orchestrator.mergeLocal(run.id);
    expect(done.status).toBe('done');
    expect(await git(repo, ['log', '-1', '--format=%s', 'main'])).toBe('Merge MRG-1: Add feature');
    expect(await git(repo, ['show', 'main:feature.txt'])).toBe('new');
    expect(store.getManualTicket(p.id, 'MRG-1')!.status).toBe('done');
  });

  it('refuses when the checked-out base has uncommitted changes, touching nothing', async () => {
    const { repo, orchestrator, run } = await readyRun();
    writeFileSync(join(repo, 'README.md'), '# app, edited\n');
    await expect(orchestrator.mergeLocal(run.id)).rejects.toThrow(/uncommitted changes/);
    expect(await git(repo, ['status', '--porcelain'])).toBe('M README.md');
    expect(await git(repo, ['log', '-1', '--format=%s', 'main'])).toBe('init');
  });

  it('aborts a conflicting merge and leaves the base as it was', async () => {
    const { repo, orchestrator, run } = await readyRun();
    writeFileSync(join(repo, 'feature.txt'), 'different\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'conflicting work']);
    await expect(orchestrator.mergeLocal(run.id)).rejects.toThrow(/does not merge cleanly/);
    expect(await git(repo, ['status', '--porcelain'])).toBe('');
    expect(await git(repo, ['log', '-1', '--format=%s', 'main'])).toBe('conflicting work');
  });

  it('fast-forwards a base that is not checked out', async () => {
    const { repo, orchestrator, run } = await readyRun();
    await git(repo, ['checkout', '-q', '-b', 'elsewhere']);
    await orchestrator.mergeLocal(run.id);
    expect(await git(repo, ['rev-parse', 'main'])).toBe(await git(repo, ['rev-parse', run.branch]));
    expect(await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('elsewhere');
  });
});

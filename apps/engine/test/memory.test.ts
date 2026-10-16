import { ADMIN } from './users.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentOutcome, AgentTask, CodingAgent } from '../src/agents/coding-agent.js';
import { Store } from '../src/db.js';
import { appendLearnings, extractLearnings, memoryForPrompt } from '../src/memory.js';
import { Orchestrator } from '../src/orchestrator.js';
import { git } from '../src/proc.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

describe('learnings', () => {
  it('splits the Learnings section off a reply', () => {
    expect(extractLearnings('Added the form.\n\n## Learnings\n- Tests run with `npm test -- --run`\n- Styles live in src/ui\n')).toEqual({
      summary: 'Added the form.',
      learnings: ['Tests run with `npm test -- --run`', 'Styles live in src/ui'],
    });
    expect(extractLearnings('Done.\n\nLearnings:\nNone')).toEqual({ summary: 'Done.', learnings: [] });
    expect(extractLearnings('Done.\n## Learnings\n1. One\n## Notes\nKeep this')).toEqual({ summary: 'Done.\n\n## Notes\nKeep this', learnings: ['One'] });
    expect(extractLearnings('No section')).toEqual({ summary: 'No section', learnings: [] });
  });

  it('appends new learnings under the ticket and skips known ones', () => {
    const day = new Date('2026-10-10T12:00:00Z');
    const first = appendLearnings('', 'APP-1', ['Use pnpm'], day);
    expect(first).toBe('# Project memory\n\nLearnings Maestro agents recorded while working on this repository. Edit freely.\n\n## 2026-10-10 · APP-1\n- Use pnpm\n');
    expect(appendLearnings(first, 'APP-2', ['use PNPM'], day)).toBe(first);
    expect(appendLearnings(first, 'APP-2', ['Use pnpm', 'API lives in api/'], day)).toContain('## 2026-10-10 · APP-2\n- API lives in api/\n');
  });

  it('keeps the newest part for prompts', () => {
    const long = `old ${'x'.repeat(9000)} newest`;
    expect(memoryForPrompt(long).endsWith('newest')).toBe(true);
    expect(memoryForPrompt(long).startsWith('…(older entries left out)')).toBe(true);
  });
});

describe('memory in runs', () => {
  async function setup(reply: (task: AgentTask) => { text: string; write: boolean }) {
    const home = mkdtempSync(join(tmpdir(), 'maestro-memory-'));
    const repo = join(home, 'app');
    mkdirSync(join(repo, '.maestro'), { recursive: true });
    await git(repo, ['init', '-b', 'main']);
    writeFileSync(join(repo, '.maestro/memory.md'), '# Project memory\n\n- The CLI entry is bin/greet.js\n');
    await git(repo, ['add', '.']);
    await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
    const store = new Store(join(home, 'db.sqlite'));
    const secrets = new SecretStore(join(home, 's.json'));
    const tasks: AgentTask[] = [];
    const agent: CodingAgent = {
      async run(task: AgentTask): Promise<AgentOutcome> {
        tasks.push(task);
        const r = reply(task);
        if (r.write) writeFileSync(join(task.cwd, 'greet.txt'), 'hi\n');
        return { sessionId: 's', text: r.text, costUsd: 0, ok: true };
      },
    };
    const orchestrator = new Orchestrator({ store, secrets, agent, reposDir: home, worktreesDir: join(home, 'wt') });
    const app = await buildServer({ actAs: ADMIN, store, secrets, agent, orchestrator, reposDir: home });
    const p = store.createProject({
      name: 'Greeter', description: '', codeHost: { provider: 'local', localPath: repo, defaultBranch: 'main' },
      pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} }, context: '', requirements: '', bestPractices: '',
      workflowYaml: 'pull_before_start: false\nquality_gates: []\nreview:\n  enabled: false\n',
    });
    store.createAgent({ name: 'W', role: 'worker', model: '' });
    const t = store.createManualTicket(p.id, 'GRE', { title: 'Greet', description: '', acceptanceCriteria: 'greets', labels: [] });
    const finish = async (runId: string) => {
      const until = Date.now() + 10_000;
      while (['running', 'reviewing'].includes(store.getRun(runId)!.status) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      return store.getRun(runId)!;
    };
    return { app, store, orchestrator, p, t, tasks, repo, finish };
  }

  it('reads the memory, commits your edit and the learnings with the ticket', async () => {
    const { app, store, orchestrator, p, t, tasks, repo, finish } = await setup(() => ({ text: 'Added greet.txt.\n\n## Learnings\n- Greetings go in greet.txt', write: true }));
    const shown = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}/memory` })).json();
    expect(shown).toEqual({ content: '# Project memory\n\n- The CLI entry is bin/greet.js', pending: false });
    await app.inject({ method: 'PUT', url: `/api/projects/${p.id}/memory`, payload: { content: '# Project memory\n\n- The CLI entry is bin/greet.js\n- Say hi, never hello\n' } });
    expect((await app.inject({ method: 'GET', url: '/api/settings' })).json().settings[`memory.${p.id}`]).toBeUndefined();

    const run = await orchestrator.start(p.id, t.key);
    const done = await finish(run.id);
    expect(done.status).toBe('in_review');
    expect(tasks[0].systemPrompt).toContain('## Project memory (.maestro/memory.md');
    expect(tasks[0].systemPrompt).toContain('Say hi, never hello');
    expect(tasks[0].systemPrompt).toContain('"## Learnings"');

    const committed = await git(repo, ['show', `${done.branch}:.maestro/memory.md`]);
    expect(committed).toContain('- Say hi, never hello');
    expect(committed).toMatch(/## \d{4}-\d{2}-\d{2} · GRE-1\n- Greetings go in greet.txt/);
    expect(store.getSetting(`memory.${p.id}`)).toBeUndefined();
    expect(store.listEvents(run.id).some((e) => e.message.includes('Added to .maestro/memory.md'))).toBe(true);
    await app.close();
  });

  it('shows empty memory for a remote project that is not cloned yet, without cloning it', async () => {
    const { app, store } = await setup(() => ({ text: '', write: false }));
    const remote = store.createProject({
      name: 'Remote', description: '', codeHost: { provider: 'github', repo: 'someone/not-cloned', defaultBranch: 'main' },
      pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} }, context: '', requirements: '', bestPractices: '',
    });
    const res = await app.inject({ method: 'GET', url: `/api/projects/${remote.id}/memory` });
    expect(res.json()).toEqual({ content: '', pending: false });
    await app.close();
  });

  it('does not count a memory edit as the worker changing something', async () => {
    const { app, store, orchestrator, p, t, finish } = await setup(() => ({ text: 'Nothing to do.', write: false }));
    await app.inject({ method: 'PUT', url: `/api/projects/${p.id}/memory`, payload: { content: 'edited' } });
    const done = await finish((await orchestrator.start(p.id, t.key)).id);
    expect(done.status).toBe('blocked');
    expect(store.getSetting(`memory.${p.id}`)).toBe('edited');
    await app.close();
  });
});

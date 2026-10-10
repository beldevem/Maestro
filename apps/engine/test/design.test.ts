import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { designContextFor, isUiTicket } from '../src/adapters/design/index.js';
import { fileKeyFrom, figmaLinks } from '../src/adapters/design/figma.js';
import type { AgentOutcome, AgentTask, CodingAgent } from '../src/agents/coding-agent.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { git } from '../src/proc.js';
import { SecretStore } from '../src/secrets.js';
import type { Project, Ticket } from '../src/types.js';

const FRAME = {
  id: '12:34', name: 'Login screen', type: 'FRAME',
  children: [
    { id: '1', name: 'Header', type: 'FRAME', children: [{ id: '2', name: 'title', type: 'TEXT', characters: 'Welcome back' }] },
    { id: '3', name: 'Button', type: 'INSTANCE', children: [{ id: '4', name: 'label', type: 'TEXT', characters: 'Sign in' }] },
  ],
};

/** Answers like the Figma API and records what was asked. */
function fakeFigma(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://api.figma.com')) expect((init?.headers as Record<string, string>)['X-Figma-Token']).toBe('figma-secret');
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/nodes?')) return json({ name: 'App designs', nodes: { '12:34': { document: FRAME } } });
    if (url.includes('/images/')) return json({ images: { '12:34': 'https://figma-cdn.example/login.png' } });
    if (url.includes('figma-cdn.example')) return new Response(Buffer.from('PNGDATA'), { status: 200 });
    if (url.includes('?depth=2')) return json({ name: 'App designs', document: { id: '0', name: 'doc', type: 'DOCUMENT', children: [{ id: 'p', name: 'Screens', type: 'CANVAS', children: [{ id: 'f', name: 'Home', type: 'FRAME' }, { id: 'g', name: 'Login screen', type: 'FRAME' }] }] } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function project(file = ''): Project {
  return {
    id: 'p1', name: 'Demo', description: '', codeHost: { provider: 'local', localPath: '/x', defaultBranch: 'main' },
    pm: { provider: 'manual', settings: {} }, design: { provider: 'figma', settings: { file } },
    context: '', requirements: '', bestPractices: '', workflowYaml: '', createdAt: '',
  };
}
const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  key: 'DEM-1', title: 'Login page', description: '', acceptanceCriteria: 'matches the design', status: 'todo', labels: [], ...over,
});
function secrets(home: string, token = true): SecretStore {
  const s = new SecretStore(join(home, 's.json'));
  if (token) s.set('FIGMA_TOKEN', 'figma-secret');
  return s;
}

describe('Figma links', () => {
  it('finds file and frame links in text', () => {
    expect(figmaLinks('See https://www.figma.com/design/AbC123/App?node-id=12-34&t=x and https://figma.com/file/Zz9/Other.')).toEqual([
      { fileKey: 'AbC123', nodeId: '12:34' },
      { fileKey: 'Zz9', nodeId: null },
    ]);
    expect(figmaLinks('https://www.figma.com/design/AbC123/App?node-id=12%3A34')).toEqual([{ fileKey: 'AbC123', nodeId: '12:34' }]);
    expect(fileKeyFrom('https://www.figma.com/design/AbC123/App')).toBe('AbC123');
    expect(fileKeyFrom('AbC123')).toBe('AbC123');
    expect(fileKeyFrom('')).toBeNull();
  });
  it('knows UI tickets by label', () => {
    expect(isUiTicket({ labels: ['area:ui'] })).toBe(true);
    expect(isUiTicket({ labels: ['Frontend'] })).toBe(true);
    expect(isUiTicket({ labels: ['area:api'] })).toBe(false);
  });
});

describe('design context', () => {
  it('fetches the linked frame: names, text and a PNG in .maestro/design', async () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-design-'));
    const text = await designContextFor(
      project(), ticket({ description: 'Build it like https://www.figma.com/design/AbC123/App?node-id=12-34' }), home, secrets(home), fakeFigma(),
    );
    expect(text).toContain('### Login screen (App designs)');
    expect(text).toContain('- Welcome back');
    expect(text).toContain('- Sign in');
    expect(text).toContain('Contains: Header, Button');
    expect(readFileSync(join(home, '.maestro/design/AbC123-12-34.png'), 'utf8')).toBe('PNGDATA');
    expect(readFileSync(join(home, '.maestro/design/context.md'), 'utf8')).toContain('Login screen');
  });

  it('gives UI tickets the project file overview when they link nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-design-'));
    const text = await designContextFor(project('https://www.figma.com/design/File1/App'), ticket({ labels: ['area:ui'] }), home, secrets(home), fakeFigma());
    expect(text).toContain('- Page "Screens": Home, Login screen');
  });

  it('adds nothing for other tickets, and asks for a token when one is needed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-design-'));
    const calls: string[] = [];
    expect(await designContextFor(project('File1'), ticket({ labels: ['area:api'] }), home, secrets(home), fakeFigma(calls))).toBeNull();
    expect(calls).toEqual([]);
    const noToken = mkdtempSync(join(tmpdir(), 'maestro-design-'));
    await expect(designContextFor(project('File1'), ticket({ labels: ['ui'] }), noToken, secrets(noToken, false), fakeFigma())).rejects.toThrow(/Figma token/);
  });
});

describe('design context in a worker run', () => {
  it('tells the worker and keeps the design files out of the commit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-design-run-'));
    const repo = join(home, 'app');
    mkdirSync(repo);
    await git(repo, ['init', '-b', 'main']);
    writeFileSync(join(repo, 'README.md'), '# app\n');
    await git(repo, ['add', '.']);
    await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
    const store = new Store(join(home, 'db.sqlite'));
    const prompts: AgentTask[] = [];
    const agent: CodingAgent = {
      async run(task: AgentTask): Promise<AgentOutcome> {
        prompts.push(task);
        if (!task.outputSchema) writeFileSync(join(task.cwd, 'login.html'), '<h1>Welcome back</h1>\n');
        return { sessionId: 's', text: 'ok', costUsd: 0, ok: true, structured: { verdict: 'approve', summary: '', comments: [] } };
      },
    };
    const orchestrator = new Orchestrator({ store, secrets: secrets(home), agent, reposDir: join(home, 'r'), worktreesDir: join(home, 'wt'), fetch: fakeFigma() });
    const p = store.createProject({
      ...project(), codeHost: { provider: 'local', localPath: repo, defaultBranch: 'main' }, workflowYaml: 'pull_before_start: false\nquality_gates: []\n',
    });
    store.createAgent({ name: 'W', role: 'worker', model: '' });
    const t = store.createManualTicket(p.id, 'DEM', { title: 'Login page', description: 'https://www.figma.com/design/AbC123/App?node-id=12-34', acceptanceCriteria: 'as designed', labels: [] });
    const run = await orchestrator.start(p.id, t.key);
    const until = Date.now() + 10_000;
    while (['running', 'reviewing'].includes(store.getRun(run.id)!.status) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));

    expect(store.getRun(run.id)!.status).toBe('in_review');
    expect(prompts[0].prompt).toContain('## Design (from Figma)');
    expect(prompts[0].prompt).toContain('Welcome back');
    expect(existsSync(join(run.worktree, '.maestro/design/context.md'))).toBe(true);
    expect(await git(repo, ['show', '--name-only', '--format=', run.branch])).toBe('login.html');
    store.db.close();
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../src/agents/providers/config.js';
import { describeSchema, exampleFor, extractJson, listModels, matchesSchema, OpenAICompatibleAgent, withoutJson } from '../src/agents/providers/openai.js';
import { checkCommand, globToRegex } from '../src/agents/providers/tools.js';

const cfg = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'local', name: 'Local', kind: 'openai', baseUrl: 'http://llm.test/v1', apiKeySecret: '', structuredOutput: 'json_schema',
  prices: { 'coder-1': { input: 1, output: 2 } }, ...over,
});

type Reply = { content?: string | null; tool_calls?: { name: string; args: object }[]; usage?: { prompt_tokens: number; completion_tokens: number } };

/** A chat completions server that answers from a script and records each request body. */
function scripted(replies: Reply[]) {
  const bodies: any[] = [];
  let n = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('http://llm.test/v1/chat/completions');
    bodies.push(JSON.parse(String(init!.body)));
    const r = replies[n++] ?? { content: 'done' };
    const message = {
      role: 'assistant', content: r.content ?? null,
      ...(r.tool_calls ? { tool_calls: r.tool_calls.map((t, i) => ({ id: `c${n}-${i}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}),
    };
    return new Response(JSON.stringify({ choices: [{ message }], usage: r.usage ?? { prompt_tokens: 1000, completion_tokens: 500 } }), { status: 200 });
  }) as typeof fetch;
  return { impl, bodies };
}

const ALL = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(node:*)', 'Bash(npm test:*)'];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'maestro-oai-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/greet.js'), 'export const greet = () => "Hello";\n');
  return { root, repo, sessions: join(root, 'sessions') };
}

describe('OpenAI-compatible agent loop', () => {
  it('reads, edits and writes through tools until the model answers, and tracks cost', async () => {
    const { repo, sessions } = workspace();
    const server = scripted([
      { tool_calls: [{ name: 'list_files', args: { pattern: 'src/**/*.js' } }] },
      { tool_calls: [{ name: 'read_file', args: { path: 'src/greet.js' } }] },
      { tool_calls: [
        { name: 'edit_file', args: { path: 'src/greet.js', old_string: '() => "Hello"', new_string: '(name) => `Hello, ${name}!`' } },
        { name: 'write_file', args: { path: 'test/greet.test.js', content: 'ok\n' } },
      ] },
      { content: 'Greeting takes a name now.' },
    ]);
    const seen: string[] = [];
    const out = await new OpenAICompatibleAgent(cfg(), 'k', sessions, server.impl).run({
      cwd: repo, prompt: 'Greet by name', systemPrompt: 'You are a worker.', model: 'coder-1', allowedTools: ALL,
      onMessage: (m) => seen.push(`${m.kind}:${m.text}`),
    });
    expect(out).toMatchObject({ ok: true, text: 'Greeting takes a name now.' });
    expect(out.costUsd).toBeCloseTo(4 * (1000 * 1 + 500 * 2) / 1e6);
    expect(readFileSync(join(repo, 'src/greet.js'), 'utf8')).toBe('export const greet = (name) => `Hello, ${name}!`;\n');
    expect(readFileSync(join(repo, 'test/greet.test.js'), 'utf8')).toBe('ok\n');
    expect(seen).toContain('tool:list_files src/**/*.js');
    // What the model saw from its tools.
    const toolMsgs = server.bodies[3].messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
    expect(toolMsgs[0]).toBe('src/greet.js');
    expect(toolMsgs[1]).toBe('1\texport const greet = () => "Hello";\n2\t');
    expect(toolMsgs.slice(2)).toEqual(['Edited src/greet.js.', 'Wrote test/greet.test.js.']);
    expect(server.bodies[0].tools.map((t: any) => t.function.name)).toEqual(['read_file', 'list_files', 'grep', 'write_file', 'edit_file', 'run_command']);
    expect(server.bodies[0].messages[0].content).toContain('You are a worker.');
  });

  it('runs allowed commands and refuses others, chaining and paths outside the worktree', async () => {
    const { root, repo, sessions } = workspace();
    writeFileSync(join(root, 'secret.txt'), 'top secret');
    symlinkSync(root, join(repo, 'escape'));
    const server = scripted([
      { tool_calls: [
        { name: 'run_command', args: { command: 'node -e "console.log(6*7)"' } },
        { name: 'run_command', args: { command: 'rm -rf src' } },
        { name: 'run_command', args: { command: 'node -v; rm -rf src' } },
        { name: 'read_file', args: { path: '../secret.txt' } },
        { name: 'read_file', args: { path: 'escape/secret.txt' } },
        { name: 'write_file', args: { path: '/tmp/evil.txt', content: 'x' } },
      ] },
      { content: 'ok' },
    ]);
    await new OpenAICompatibleAgent(cfg(), undefined, sessions, server.impl).run({ cwd: repo, prompt: 'p', systemPrompt: 's', model: 'm', allowedTools: ALL });
    const results = server.bodies[1].messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
    expect(results[0]).toBe('exit code 0\n42\n');
    expect(results[1]).toMatch(/^Error: Not allowed\. Commands must start with one of: node, npm test/);
    expect(results[2]).toMatch(/^Error: Chaining, pipes/);
    expect(results.slice(3)).toEqual(['Error: ../secret.txt is outside the worktree.', 'Error: escape/secret.txt is outside the worktree.', 'Error: /tmp/evil.txt is outside the worktree.']);
    expect(existsSync(join(repo, 'src/greet.js'))).toBe(true);
    expect(existsSync('/tmp/evil.txt')).toBe(false);
  });

  it('only offers the tools that are allowed (a read-only reviewer cannot write)', async () => {
    const { repo, sessions } = workspace();
    const server = scripted([{ tool_calls: [{ name: 'write_file', args: { path: 'x.txt', content: 'x' } }] }, { content: 'ok' }]);
    await new OpenAICompatibleAgent(cfg(), undefined, sessions, server.impl).run({ cwd: repo, prompt: 'p', systemPrompt: 's', model: 'm', allowedTools: ['Read', 'Glob', 'Grep'] });
    expect(server.bodies[0].tools.map((t: any) => t.function.name)).toEqual(['read_file', 'list_files', 'grep']);
    expect(server.bodies[1].messages.at(-1).content).toBe('Error: Writing files is not allowed here.');
    expect(existsSync(join(repo, 'x.txt'))).toBe(false);
  });

  it('returns structured output, retrying once with JSON mode when the answer is not JSON', async () => {
    const { repo, sessions } = workspace();
    const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
    const direct = scripted([{ content: 'Here you go:\n```json\n{"verdict":"approve"}\n```' }]);
    const a = await new OpenAICompatibleAgent(cfg(), undefined, sessions, direct.impl).run({ cwd: repo, prompt: 'p', systemPrompt: 's', model: 'm', allowedTools: [], outputSchema: schema });
    expect(a.structured).toEqual({ verdict: 'approve' });
    expect(direct.bodies[0].messages[0].content).toContain('reply with ONLY one JSON object');
    expect(direct.bodies[0].messages[0].content).not.toContain('"properties"');
    expect(direct.bodies[0].response_format).toEqual({ type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } });
    expect(direct.bodies[0].tools).toBeUndefined();

    const retry = scripted([{ content: 'Looks good to me.' }, { content: '{"verdict":"changes_requested"}' }]);
    const b = await new OpenAICompatibleAgent(cfg(), undefined, sessions, retry.impl).run({ cwd: repo, prompt: 'p', systemPrompt: 's', model: 'm', allowedTools: [], outputSchema: schema });
    expect(b.structured).toEqual({ verdict: 'changes_requested' });
    expect(retry.bodies[1].response_format).toEqual({ type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } });

    const promptOnly = scripted([{ content: 'nope' }, { content: '{"verdict":"approve"}' }]);
    await new OpenAICompatibleAgent(cfg({ structuredOutput: 'prompt' }), undefined, sessions, promptOnly.impl).run({ cwd: repo, prompt: 'p', systemPrompt: 's', model: 'm', allowedTools: [], outputSchema: schema });
    expect(promptOnly.bodies[1].response_format).toBeUndefined();
  });

  it('stops at its turn and budget limits the way the orchestrator expects', async () => {
    const { repo, sessions } = workspace();
    const loop = scripted(Array.from({ length: 10 }, () => ({ tool_calls: [{ name: 'list_files', args: { pattern: '*' } }] })));
    const turns = await new OpenAICompatibleAgent(cfg(), undefined, sessions, loop.impl).run({ cwd: repo, prompt: 'p', systemPrompt: 's', model: 'm', allowedTools: ALL, maxTurns: 3 });
    expect(turns).toMatchObject({ ok: false, error: 'Agent stopped: error_max_turns' });
    const pricey = scripted(Array.from({ length: 10 }, () => ({ tool_calls: [{ name: 'list_files', args: { pattern: '*' } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } })));
    const budget = await new OpenAICompatibleAgent(cfg(), undefined, sessions, pricey.impl).run({ cwd: repo, prompt: 'p', systemPrompt: 's', model: 'coder-1', allowedTools: ALL, maxBudgetUsd: 2.5 });
    expect(budget).toMatchObject({ ok: false, error: 'Agent stopped: error_max_budget_usd' });
    expect(budget.costUsd).toBe(3);
  });

  it('resumes a session so a fix round continues the same conversation', async () => {
    const { repo, sessions } = workspace();
    const first = scripted([{ content: 'Did it.' }]);
    const a = await new OpenAICompatibleAgent(cfg(), undefined, sessions, first.impl).run({ cwd: repo, prompt: 'Do it', systemPrompt: 's', model: 'm', allowedTools: [] });
    const second = scripted([{ content: 'Fixed.' }]);
    await new OpenAICompatibleAgent(cfg(), undefined, sessions, second.impl).run({ cwd: repo, prompt: 'The test failed', systemPrompt: 's', model: 'm', allowedTools: [], resume: a.sessionId! });
    expect(second.bodies[0].messages.map((m: any) => `${m.role}:${m.content}`)).toEqual(['system:s', 'user:Do it', 'assistant:Did it.', 'user:The test failed']);
  });

  it('explains a refused key and a missing model', async () => {
    const { repo, sessions } = workspace();
    const refused = (async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch;
    const r = await new OpenAICompatibleAgent(cfg(), 'bad', sessions, refused).run({ cwd: repo, prompt: 'p', systemPrompt: 's', model: 'm', allowedTools: [] });
    expect(r).toMatchObject({ ok: false, error: 'Local refused the API key (401).' });
    const noModel = await new OpenAICompatibleAgent(cfg(), undefined, sessions, refused).run({ cwd: repo, prompt: 'p', systemPrompt: 's', model: '', allowedTools: [] });
    expect(noModel.error).toBe('Choose a model for Local in Settings.');
  });
});

describe('helpers', () => {
  it('finds JSON in replies', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('text\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('so: {"a":3} ok')).toEqual({ a: 3 });
    expect(extractJson('no json')).toBeUndefined();
  });
  it('matches globs and checks commands', () => {
    expect(globToRegex('src/**/*.ts').test('src/a/b.ts')).toBe(true);
    expect(globToRegex('src/**/*.ts').test('src/b.ts')).toBe(true);
    expect(globToRegex('*.md').test('docs/a.md')).toBe(false);
    expect(checkCommand('npm test -- --run', ['npm test'])).toBeNull();
    expect(checkCommand('npm testx', ['npm test'])).toMatch(/Not allowed/);
    expect(checkCommand('node $(whoami)', ['node'])).toMatch(/Chaining/);
  });
  it('lists models from /models', async () => {
    const impl = (async () => new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }] }), { status: 200 })) as unknown as typeof fetch;
    expect(await listModels(cfg(), undefined, impl)).toEqual(['a', 'b']);
  });
});

describe('structured answers from weaker models', () => {
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string', description: 'Your reply' }, actions: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['assign', null] } } } } },
    required: ['answer', 'actions'],
  };
  const run = async (replies: Reply[], over: Partial<ProviderConfig> = {}) => {
    const { repo, sessions } = workspace();
    const server = scripted(replies);
    const out = await new OpenAICompatibleAgent(cfg(over), undefined, sessions, server.impl).run({ cwd: repo, prompt: 'p', systemPrompt: 's', model: 'm', allowedTools: [], outputSchema: schema });
    return { out, server };
  };

  it('describes the fields in words instead of pasting the schema', async () => {
    const { server } = await run([{ content: '{"answer":"hi","actions":[]}' }]);
    const sys = server.bodies[0].messages[0].content as string;
    expect(sys).toContain('{"answer":"...","actions":[]}');
    expect(sys).toContain('- answer (string): Your reply');
    expect(sys).not.toContain('"properties"');
  });

  it('retries when the model echoes the schema, and accepts the corrected answer', async () => {
    const echo = `You are talking with Maestro.\n${JSON.stringify(schema)}`;
    const { out, server } = await run([{ content: echo }, { content: '{"answer":"I run on qwen3-coder.","actions":[]}' }]);
    expect(out.structured).toEqual({ answer: 'I run on qwen3-coder.', actions: [] });
    expect(server.bodies).toHaveLength(2);
    expect(server.bodies[1].messages.at(-1).content).toContain('not the schema');
  });

  it('accepts prose with JSON and fenced JSON when the shape is right', async () => {
    expect((await run([{ content: 'Sure! {"answer":"a","actions":[]} hope that helps' }])).out.structured).toEqual({ answer: 'a', actions: [] });
    expect((await run([{ content: '```json\n{"answer":"b","actions":[]}\n```' }])).out.structured).toEqual({ answer: 'b', actions: [] });
    expect((await run([{ content: '{"answer":3,"actions":[]}' }, { content: '{"answer":"c","actions":[]}' }])).out.structured).toEqual({ answer: 'c', actions: [] });
  });

  it('shows only the plain text when the model never gets it right, never the JSON', async () => {
    const { out } = await run([{ content: `I am Maestro.\n${JSON.stringify(schema)}` }, { content: JSON.stringify(schema) }]);
    expect(out.structured).toBeUndefined();
    expect(out.text).toBe('I am Maestro.');
  });

  it('turns schemas into examples and checks shapes', () => {
    expect(exampleFor(schema)).toEqual({ answer: '...', actions: [] });
    expect(matchesSchema({ answer: 'x', actions: [] }, schema)).toBe(true);
    expect(matchesSchema(schema, schema)).toBe(false);
    expect(matchesSchema({ answer: 'x' }, schema)).toBe(false);
    expect(withoutJson('Hi.\n```json\n{"a":1}\n```\nBye {"b":2}')).toBe('Hi.\n\nBye');
    expect(describeSchema(schema)).toBe('- answer (string): Your reply\n- actions (array)\n  - type (string, one of assign) (optional)');
  });
});

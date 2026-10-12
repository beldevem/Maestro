import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentOutcome, AgentTask, CodingAgent } from '../coding-agent.js';
import type { ProviderConfig } from './config.js';
import { parseAllowed, runTool, toolDefinitions } from './tools.js';

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface Completion {
  choices: { message: Message; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const LOOP_RULES = `
## Working with tools
- Use the tools to look at the repository and to make changes; paths are relative to the repository root.
- Read a file before editing it, and edit with exact text from the file.
- Run commands only through run_command, one at a time, and only those it allows.
- When you are done, stop calling tools and reply with your final answer.`;

/** Finds JSON in a reply: the whole text, a ```json block, or the outermost {...}. */
export function extractJson(text: string): unknown {
  const tries = [text.trim(), /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text)?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const t of tries) {
    if (!t) continue;
    try {
      return JSON.parse(t);
    } catch {
      // try the next form
    }
  }
  return undefined;
}

/**
 * Maestro's own agent loop for any OpenAI-compatible chat completions API (OpenAI, Ollama, LM Studio,
 * vLLM, OpenRouter, GitHub Models...): the model calls file and command tools confined to the worktree
 * until it answers. Conversations are kept per session so a fix round can resume where the last one ended.
 */
export class OpenAICompatibleAgent implements CodingAgent {
  constructor(
    private readonly cfg: ProviderConfig,
    private readonly apiKey: string | undefined,
    private readonly sessionsDir: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private price(model: string): { input: number; output: number } {
    return this.cfg.prices[model] ?? this.cfg.prices['*'] ?? { input: 0, output: 0 };
  }

  private async complete(body: Record<string, unknown>, signal?: AbortSignal): Promise<Completion> {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      if (res.status === 401 || res.status === 403) throw new Error(`${this.cfg.name} refused the API key (${res.status}).`);
      if (/tool/i.test(text) && res.status === 400) throw new Error(`${this.cfg.name}: this model does not seem to support tool calling (${text}).`);
      throw new Error(`${this.cfg.name} answered ${res.status}: ${text}`);
    }
    return (await res.json()) as Completion;
  }

  async run(task: AgentTask): Promise<AgentOutcome> {
    if (!this.cfg.baseUrl) return { sessionId: null, text: '', costUsd: 0, ok: false, error: `Set the base URL of ${this.cfg.name} in Settings.` };
    if (!task.model) return { sessionId: null, text: '', costUsd: 0, ok: false, error: `Choose a model for ${this.cfg.name} in Settings.` };
    mkdirSync(this.sessionsDir, { recursive: true });
    const sessionId = task.resume ?? randomUUID();
    const file = join(this.sessionsDir, `${sessionId.replace(/[^\w-]/g, '')}.json`);
    const history: Message[] = task.resume && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    const allowed = parseAllowed(task.allowedTools);
    const tools = toolDefinitions(allowed);
    const jsonRule = task.outputSchema
      ? `\n\n## Your final answer\nWhen you are done, reply with ONLY a JSON object (no prose) that matches this JSON schema:\n${JSON.stringify(task.outputSchema)}`
      : '';
    const system: Message = { role: 'system', content: `${task.systemPrompt}${tools.length ? LOOP_RULES : ''}${jsonRule}` };
    history.push({ role: 'user', content: task.prompt });

    const p = this.price(task.model);
    let cost = 0;
    const addUsage = (u?: Completion['usage']) => {
      cost += ((u?.prompt_tokens ?? 0) * p.input + (u?.completion_tokens ?? 0) * p.output) / 1_000_000;
    };
    const save = () => writeFileSync(file, JSON.stringify(history));
    const maxTurns = task.maxTurns ?? 80;
    const out = (o: Partial<AgentOutcome>): AgentOutcome => {
      save();
      return { sessionId, text: '', costUsd: cost, ok: false, ...o };
    };

    try {
      let text = '';
      for (let turn = 0; ; turn++) {
        if (task.signal?.aborted) return out({ error: 'aborted' });
        if (turn >= maxTurns) return out({ error: 'Agent stopped: error_max_turns' });
        if (task.maxBudgetUsd && cost >= task.maxBudgetUsd) return out({ error: 'Agent stopped: error_max_budget_usd' });
        const res = await this.complete(
          { model: task.model, messages: [system, ...history], ...(tools.length ? { tools, tool_choice: 'auto' } : {}) },
          task.signal,
        );
        addUsage(res.usage);
        const msg = res.choices?.[0]?.message;
        if (!msg) return out({ error: `${this.cfg.name} returned no message.` });
        history.push({ role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
        if (msg.content?.trim()) task.onMessage?.({ kind: 'agent', text: msg.content.trim() });
        if (!msg.tool_calls?.length) {
          text = msg.content ?? '';
          break;
        }
        for (const call of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || '{}');
          } catch {
            args = {};
          }
          task.onMessage?.({ kind: 'tool', text: `${call.function.name} ${String(args.path ?? args.pattern ?? args.command ?? '')}`.trim() });
          const result = await runTool(call.function.name, args, { cwd: task.cwd, allowed, signal: task.signal, commandTimeoutMs: 10 * 60_000 });
          history.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
      }

      let structured: unknown;
      if (task.outputSchema) {
        structured = extractJson(text);
        if (structured === undefined) {
          // One retry that asks for the JSON alone, with the API's JSON mode where the provider has it.
          history.push({ role: 'user', content: 'Reply again with ONLY the JSON object that matches the schema, nothing else.' });
          const format =
            this.cfg.structuredOutput === 'json_schema' ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: task.outputSchema } } }
            : this.cfg.structuredOutput === 'json_object' ? { response_format: { type: 'json_object' } }
            : {};
          const res = await this.complete({ model: task.model, messages: [system, ...history], ...format }, task.signal);
          addUsage(res.usage);
          const retry = res.choices?.[0]?.message?.content ?? '';
          history.push({ role: 'assistant', content: retry });
          structured = extractJson(retry);
          if (structured !== undefined) text = retry;
        }
      }
      save();
      return { sessionId, text, costUsd: cost, ok: true, ...(structured !== undefined ? { structured } : {}) };
    } catch (e) {
      if (task.signal?.aborted) return out({ error: 'aborted' });
      return out({ error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** The models an OpenAI-compatible server offers (GET /models). */
export async function listModels(cfg: ProviderConfig, apiKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(`${cfg.baseUrl.replace(/\/+$/, '')}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
  if (res.status === 401 || res.status === 403) throw new Error('The API key was refused.');
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  const body = (await res.json()) as { data?: { id: string }[]; models?: { id?: string; name?: string }[] };
  return (body.data ?? body.models ?? []).map((m) => (m as { id?: string; name?: string }).id ?? (m as { name?: string }).name ?? '').filter(Boolean).sort();
}

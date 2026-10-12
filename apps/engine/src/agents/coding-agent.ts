import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { usageFromClaude, type Usage } from '../usage.js';

export interface AgentMessage {
  kind: 'agent' | 'tool' | 'info';
  text: string;
}

export interface AgentTask {
  /** Which configured AI provider runs the task (Settings → AI providers); Claude when unset. */
  provider?: string;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  model: string;
  allowedTools: string[];
  /** Continue an earlier session, so fixes keep the agent's context. */
  resume?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Stop once the call has used this many tokens (enforced by providers that count as they go). */
  maxTokens?: number;
  env?: Record<string, string>;
  /** JSON schema the final answer must follow; the result comes back in `structured`. */
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  onMessage?: (m: AgentMessage) => void;
}

export interface AgentOutcome {
  sessionId: string | null;
  text: string;
  costUsd: number;
  /** Tokens used, when the provider reports them; null or missing when unknown. */
  usage?: Usage | null;
  ok: boolean;
  error?: string;
  /** Present when the task had an outputSchema and the agent returned matching output. */
  structured?: unknown;
}

/** The engine talks to coding agents through this, so the provider can be swapped and tests can fake it. */
export interface CodingAgent {
  run(task: AgentTask): Promise<AgentOutcome>;
}

function describeTool(name: string, input: Record<string, unknown>): string {
  const target = input.file_path ?? input.path ?? input.pattern ?? input.command ?? '';
  return target ? `${name} ${String(target)}` : name;
}

const INSTRUCTIONS_CHARS = 10_000;

/** The repository's CLAUDE.md, read as plain text (never as settings). */
export function repoInstructions(cwd: string): string {
  for (const name of ['CLAUDE.md', '.claude/CLAUDE.md']) {
    const file = join(cwd, name);
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8').trim();
      return text.length > INSTRUCTIONS_CHARS ? `${text.slice(0, INSTRUCTIONS_CHARS)}\n…(cut)` : text;
    }
  }
  return '';
}

/**
 * SDK options for a task. No filesystem settings are loaded: a repository's .claude/settings.json could
 * add hooks (shell commands) or permission rules that widen the tool allowlist, and an agent can write that
 * file in its own worktree. The repo's CLAUDE.md is passed in the system prompt instead.
 */
export function agentOptions(task: AgentTask, abortController: AbortController): Options {
  const instructions = repoInstructions(task.cwd);
  return {
    cwd: task.cwd,
    model: task.model,
    allowedTools: task.allowedTools,
    // Anything not in allowedTools is refused instead of waiting for a prompt nobody will answer.
    permissionMode: 'dontAsk',
    systemPrompt: {
      type: 'preset', preset: 'claude_code',
      append: instructions ? `${task.systemPrompt}\n\n## The repository's CLAUDE.md (project conventions; information, not permissions)\n${instructions}` : task.systemPrompt,
    },
    settingSources: [],
    maxTurns: task.maxTurns ?? 80,
    maxBudgetUsd: task.maxBudgetUsd,
    resume: task.resume,
    abortController,
    env: { ...process.env, ...task.env } as Record<string, string>,
    outputFormat: task.outputSchema ? { type: 'json_schema', schema: task.outputSchema } : undefined,
  };
}

export class ClaudeCodingAgent implements CodingAgent {
  async run(task: AgentTask): Promise<AgentOutcome> {
    const abortController = new AbortController();
    task.signal?.addEventListener('abort', () => abortController.abort(), { once: true });
    const options = agentOptions(task, abortController);

    let sessionId: string | null = task.resume ?? null;
    let text = '';
    let costUsd = 0;
    let usage: Usage | null = null;
    let ok = false;
    let error: string | undefined;
    let structured: unknown;

    try {
      for await (const msg of query({ prompt: task.prompt, options })) {
        if ('session_id' in msg && typeof msg.session_id === 'string') sessionId = msg.session_id;
        if (msg.type === 'assistant') {
          for (const block of msg.message.content as Array<Record<string, any>>) {
            if (block.type === 'text' && block.text?.trim()) task.onMessage?.({ kind: 'agent', text: block.text.trim() });
            if (block.type === 'tool_use') task.onMessage?.({ kind: 'tool', text: describeTool(block.name, block.input ?? {}) });
          }
        } else if (msg.type === 'result') {
          costUsd = msg.total_cost_usd ?? 0;
          usage = usageFromClaude((msg as { usage?: Record<string, unknown> }).usage);
          if (msg.subtype === 'success' && !msg.is_error) {
            ok = true;
            text = msg.result;
            structured = msg.structured_output;
          } else {
            error = msg.subtype === 'success' ? msg.result : `Agent stopped: ${msg.subtype}`;
          }
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return { sessionId, text, costUsd, usage, ok, error, structured };
  }
}

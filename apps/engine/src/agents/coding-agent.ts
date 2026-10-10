import { query, type Options } from '@anthropic-ai/claude-agent-sdk';

export interface AgentMessage {
  kind: 'agent' | 'tool' | 'info';
  text: string;
}

export interface AgentTask {
  cwd: string;
  prompt: string;
  systemPrompt: string;
  model: string;
  allowedTools: string[];
  /** Continue an earlier session, so fixes keep the agent's context. */
  resume?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onMessage?: (m: AgentMessage) => void;
}

export interface AgentOutcome {
  sessionId: string | null;
  text: string;
  costUsd: number;
  ok: boolean;
  error?: string;
}

/** The engine talks to coding agents through this, so the provider can be swapped and tests can fake it. */
export interface CodingAgent {
  run(task: AgentTask): Promise<AgentOutcome>;
}

function describeTool(name: string, input: Record<string, unknown>): string {
  const target = input.file_path ?? input.path ?? input.pattern ?? input.command ?? '';
  return target ? `${name} ${String(target)}` : name;
}

export class ClaudeCodingAgent implements CodingAgent {
  async run(task: AgentTask): Promise<AgentOutcome> {
    const abortController = new AbortController();
    task.signal?.addEventListener('abort', () => abortController.abort(), { once: true });

    const options: Options = {
      cwd: task.cwd,
      model: task.model,
      allowedTools: task.allowedTools,
      // Anything not in allowedTools is refused instead of waiting for a prompt nobody will answer.
      permissionMode: 'dontAsk',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: task.systemPrompt },
      settingSources: ['project'],
      maxTurns: task.maxTurns ?? 80,
      maxBudgetUsd: task.maxBudgetUsd,
      resume: task.resume,
      abortController,
      env: { ...process.env, ...task.env } as Record<string, string>,
    };

    let sessionId: string | null = task.resume ?? null;
    let text = '';
    let costUsd = 0;
    let ok = false;
    let error: string | undefined;

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
          if (msg.subtype === 'success' && !msg.is_error) {
            ok = true;
            text = msg.result;
          } else {
            error = msg.subtype === 'success' ? msg.result : `Agent stopped: ${msg.subtype}`;
          }
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return { sessionId, text, costUsd, ok, error };
  }
}

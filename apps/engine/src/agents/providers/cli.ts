import { spawnSync } from 'node:child_process';
import { run, tail } from '../../proc.js';
import type { AgentOutcome, AgentTask, CodingAgent } from '../coding-agent.js';
import type { ProviderConfig } from './config.js';
import { extractJson } from './openai.js';

export interface CliPreset {
  id: string;
  name: string;
  command: string;
  args: string[];
  modelArgs: string[];
  install: string;
  auth: string;
}

/**
 * Coding CLIs run non-interactively in the worktree. Their flags change between versions, so every field is
 * editable in Settings; these follow each tool's documented non-interactive mode.
 */
export const CLI_PRESETS: CliPreset[] = [
  { id: 'copilot', name: 'GitHub Copilot CLI', command: 'copilot', args: ['-p', '{prompt}', '--allow-all-tools'], modelArgs: ['--model', '{model}'],
    install: 'npm install -g @github/copilot', auth: 'Sign in once with `copilot` (or set GH_TOKEN / GITHUB_TOKEN with Copilot access).' },
  { id: 'codex', name: 'OpenAI Codex CLI', command: 'codex', args: ['exec', '--full-auto', '{prompt}'], modelArgs: ['--model', '{model}'],
    install: 'npm install -g @openai/codex', auth: 'Sign in once with `codex login`, or set OPENAI_API_KEY.' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['-p', '{prompt}', '--yolo'], modelArgs: ['--model', '{model}'],
    install: 'npm install -g @google/gemini-cli', auth: 'Sign in once with `gemini`, or set GEMINI_API_KEY.' },
  { id: 'aider', name: 'Aider', command: 'aider', args: ['--message', '{prompt}', '--yes-always', '--no-auto-commits', '--no-check-update'], modelArgs: ['--model', '{model}'],
    install: 'python -m pip install aider-install && aider-install', auth: 'Set the API key of the model provider Aider uses (e.g. OPENAI_API_KEY).' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', args: ['run', '{prompt}'], modelArgs: ['--model', '{model}'],
    install: 'npm install -g opencode-ai', auth: 'Configure a provider with `opencode auth login`.' },
  { id: 'custom', name: 'Custom command', command: '', args: ['{prompt}'], modelArgs: [], install: '', auth: '' },
];

/** Whether a command is on PATH (and so can run). */
export function cliInstalled(command: string): boolean {
  if (!command) return false;
  const res = spawnSync('sh', ['-c', `command -v ${JSON.stringify(command)}`], { encoding: 'utf8' });
  return res.status === 0 && !!res.stdout.trim();
}

/** Fills {prompt} and {model} in an argument template. */
export function cliArgs(cfg: NonNullable<ProviderConfig['cli']>, prompt: string, model: string): string[] {
  const fill = (a: string) => a.replaceAll('{prompt}', prompt).replaceAll('{model}', model);
  return [...cfg.args.map(fill), ...(model ? cfg.modelArgs.map(fill) : [])];
}

/**
 * Runs a coding CLI in the worktree with Maestro's instructions and the ticket as the prompt. The CLI applies
 * its own permissions; Maestro still runs the quality gates, commits, reviews and enforces budgets around it.
 * Cost is not known for CLIs, so runs record $0.
 */
export class CliAgent implements CodingAgent {
  constructor(private readonly cfg: ProviderConfig) {}

  async run(task: AgentTask): Promise<AgentOutcome> {
    const cli = this.cfg.cli;
    if (!cli?.command) return { sessionId: null, text: '', costUsd: 0, ok: false, error: `Set the command of ${this.cfg.name} in Settings.` };
    if (!cliInstalled(cli.command)) {
      return { sessionId: null, text: '', costUsd: 0, ok: false, error: `${cli.command} is not installed where Maestro runs (for Docker: inside the container).` };
    }
    const jsonRule = task.outputSchema ? `\n\nWhen you are done, reply with ONLY a JSON object (no prose) that matches this JSON schema:\n${JSON.stringify(task.outputSchema)}` : '';
    const prompt = `${task.systemPrompt}${jsonRule}\n\n---\n\n${task.prompt}`;
    task.onMessage?.({ kind: 'info', text: `Running ${cli.command} in the worktree.` });
    const res = await run(cli.command, cliArgs(cli, prompt, task.model), {
      cwd: task.cwd, env: { ...task.env, CI: 'true' }, timeoutMs: cli.timeoutMinutes * 60_000, signal: task.signal,
    });
    const text = tail(res.output.trim(), 20_000);
    if (text) task.onMessage?.({ kind: 'agent', text: tail(text, 2000) });
    if (task.signal?.aborted) return { sessionId: null, text, costUsd: 0, ok: false, error: 'aborted' };
    if (res.timedOut) return { sessionId: null, text, costUsd: 0, ok: false, error: `${cli.command} did not finish within ${cli.timeoutMinutes} minutes.` };
    if (res.code !== 0) return { sessionId: null, text, costUsd: 0, ok: false, error: `${cli.command} exited with code ${res.code}: ${tail(text, 600)}` };
    const structured = task.outputSchema ? extractJson(text) : undefined;
    return { sessionId: null, text, costUsd: 0, ok: true, ...(structured !== undefined ? { structured } : {}) };
  }
}

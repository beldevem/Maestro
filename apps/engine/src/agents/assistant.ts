import { existsSync } from 'node:fs';
import type { Store } from '../db.js';
import type { SecretStore } from '../secrets.js';
import type { Project, Ticket } from '../types.js';
import type { CodingAgent } from './coding-agent.js';
import { projectKnowledge } from './prompts.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Answers questions about a project from its knowledge, tickets, runs and (read-only) its code. */
export async function askAssistant(
  deps: { store: Store; secrets: SecretStore; agent: CodingAgent },
  project: Project,
  tickets: Ticket[],
  cwd: string,
  history: ChatTurn[],
  message: string,
): Promise<{ answer: string; costUsd: number }> {
  const runs = deps.store.listRuns(project.id).slice(0, 15);
  const agents = deps.store.listAgents();
  const system = `You are Maestro's assistant for one project. Answer briefly and concretely from the material below and, when useful, by reading the repository (read-only).

${projectKnowledge(project)}

## Tickets
${tickets.map((t) => `- ${t.key} [${t.status}] ${t.title}`).join('\n') || '(none)'}

## Recent runs
${runs.map((r) => `- ${r.ticketKey} ${r.status}${r.error ? ` (${r.error})` : ''}${r.prUrl ? ` ${r.prUrl}` : ''} by ${agents.find((a) => a.id === r.agentId)?.name ?? 'unknown'}`).join('\n') || '(none)'}

## Agents
${agents.map((a) => `- ${a.name} (${a.role}): ${a.state}${a.note ? `, ${a.note}` : ''}`).join('\n') || '(none)'}`;

  const transcript = history.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n\n');
  const key = deps.secrets.get('ANTHROPIC_API_KEY');
  const out = await deps.agent.run({
    cwd: existsSync(cwd) ? cwd : process.cwd(),
    prompt: transcript ? `${transcript}\n\nUser: ${message}` : message,
    systemPrompt: system,
    model: deps.store.getSetting('model.assistant') || 'claude-sonnet-5-5',
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 15,
    env: key ? { ANTHROPIC_API_KEY: key } : {},
  });
  if (!out.ok) throw new Error(out.error ?? 'The assistant could not answer.');
  return { answer: out.text, costUsd: out.costUsd };
}

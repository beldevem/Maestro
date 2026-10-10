import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { Store } from '../db.js';
import type { SecretStore } from '../secrets.js';
import type { Project, Ticket } from '../types.js';
import type { CodingAgent } from './coding-agent.js';
import { projectKnowledge } from './prompts.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

const STATUSES = ['todo', 'in_progress', 'in_review', 'done'] as const;

/** What the assistant may propose. Nothing runs until you confirm it in the chat. */
export const proposedActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create_ticket'),
    title: z.string().min(1),
    description: z.string().default(''),
    acceptanceCriteria: z.string().default(''),
    size: z.enum(['XS', 'S', 'M', 'L', 'XL']).nullish(),
    labels: z.array(z.string()).default([]),
  }),
  z.object({ type: z.literal('assign'), ticketKey: z.string().min(1) }),
  z.object({ type: z.literal('move_ticket'), ticketKey: z.string().min(1), status: z.enum(STATUSES) }),
  z.object({ type: z.literal('plan_backlog') }),
  z.object({ type: z.literal('pause_agent'), agentName: z.string().min(1) }),
  z.object({ type: z.literal('resume_agent'), agentName: z.string().min(1) }),
]);
export type ProposedAction = z.infer<typeof proposedActionSchema>;

const ACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['create_ticket', 'assign', 'move_ticket', 'plan_backlog', 'pause_agent', 'resume_agent'] },
    title: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    acceptanceCriteria: { type: ['string', 'null'] },
    size: { type: ['string', 'null'], enum: ['XS', 'S', 'M', 'L', 'XL', null] },
    labels: { type: ['array', 'null'], items: { type: 'string' } },
    ticketKey: { type: ['string', 'null'] },
    status: { type: ['string', 'null'], enum: [...STATUSES, null] },
    agentName: { type: ['string', 'null'] },
  },
  required: ['type'],
  additionalProperties: false,
};

export const CHAT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: 'Your reply to the user, in plain text' },
    actions: { type: 'array', items: ACTION_JSON_SCHEMA, description: 'Actions to propose; empty unless the user asked for something to be done' },
  },
  required: ['answer', 'actions'],
  additionalProperties: false,
};

/** One line describing an action, for the confirm card. */
export function describeAction(a: ProposedAction): string {
  switch (a.type) {
    case 'create_ticket': return `Create ticket "${a.title}"${a.size ? ` (${a.size})` : ''}`;
    case 'assign': return `Assign ${a.ticketKey} to a free worker`;
    case 'move_ticket': return `Move ${a.ticketKey} to ${a.status.replace('_', ' ')}`;
    case 'plan_backlog': return 'Run the planner to draft a backlog';
    case 'pause_agent': return `Pause ${a.agentName}`;
    case 'resume_agent': return `Resume ${a.agentName}`;
  }
}

/** Keeps the valid actions; drops nulls the schema needs for optional fields and anything malformed. */
export function parseActions(raw: unknown): ProposedAction[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a) => {
    const clean = Object.fromEntries(Object.entries(a ?? {}).filter(([, v]) => v !== null));
    const parsed = proposedActionSchema.safeParse(clean);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Answers questions about a project from its knowledge, tickets, runs and (read-only) its code, and may propose actions. */
export async function askAssistant(
  deps: { store: Store; secrets: SecretStore; agent: CodingAgent },
  project: Project,
  tickets: Ticket[],
  cwd: string,
  history: ChatTurn[],
  message: string,
): Promise<{ answer: string; costUsd: number; actions: ProposedAction[] }> {
  const runs = deps.store.listRuns(project.id).slice(0, 15);
  const agents = deps.store.listAgents();
  const system = `You are Maestro's assistant for one project. Answer briefly and concretely from the material below and, when useful, by reading the repository (read-only).

${projectKnowledge(project)}

## Tickets
${tickets.map((t) => `- ${t.key} [${t.status}] ${t.title}`).join('\n') || '(none)'}

## Recent runs
${runs.map((r) => `- ${r.ticketKey} ${r.status}${r.error ? ` (${r.error})` : ''}${r.prUrl ? ` ${r.prUrl}` : ''} by ${agents.find((a) => a.id === r.agentId)?.name ?? 'unknown'}`).join('\n') || '(none)'}

## Agents
${agents.map((a) => `- ${a.name} (${a.role}): ${a.state}${a.note ? `, ${a.note}` : ''}`).join('\n') || '(none)'}

## Actions
When the user asks you to do something, propose it as actions instead of saying it is done; the user confirms each one in the chat before it runs. You can propose:
- create_ticket (title, description, acceptanceCriteria, size XS-XL, labels)
- assign (ticketKey): give a ticket to a free worker
- move_ticket (ticketKey, status: todo, in_progress, in_review or done)
- plan_backlog: run the planner on the requirements
- pause_agent / resume_agent (agentName, exactly as listed above)
Use exact ticket keys and agent names from the lists. Propose nothing when the user only asks a question. Your answer should say what you propose, not claim it happened.
Return your reply in the requested structured format.`;

  const transcript = history.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n\n');
  const key = deps.secrets.get('ANTHROPIC_API_KEY');
  const out = await deps.agent.run({
    cwd: existsSync(cwd) ? cwd : process.cwd(),
    prompt: transcript ? `${transcript}\n\nUser: ${message}` : message,
    systemPrompt: system,
    model: deps.store.getSetting('model.assistant') || 'claude-sonnet-5-5',
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 15,
    outputSchema: CHAT_JSON_SCHEMA,
    env: key ? { ANTHROPIC_API_KEY: key } : {},
  });
  if (!out.ok) throw new Error(out.error ?? 'The assistant could not answer.');
  const data = (out.structured ?? null) as { answer?: unknown; actions?: unknown } | null;
  if (data && typeof data.answer === 'string') return { answer: data.answer, costUsd: out.costUsd, actions: parseActions(data.actions) };
  return { answer: out.text, costUsd: out.costUsd, actions: [] };
}

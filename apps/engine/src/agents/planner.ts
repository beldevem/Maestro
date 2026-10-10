import { z } from 'zod';
import type { PmAdapter } from '../adapters/pm/index.js';
import type { Store } from '../db.js';
import type { SecretStore } from '../secrets.js';
import type { BacklogDraft, BacklogItem, Project, Ticket } from '../types.js';
import type { CodingAgent } from './coding-agent.js';
import { plannerSystemPrompt, type ExtraKnowledge } from './prompts.js';

const SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;

export const backlogItemSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().default(''),
  acceptanceCriteria: z.union([z.string(), z.array(z.string()).transform((a) => a.map((l) => `- ${l}`).join('\n'))]).default(''),
  size: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.enum(SIZES)).default('M'),
  labels: z.array(z.string()).default([]),
  dependsOn: z.array(z.number().int()).default([]),
});
const backlogSchema = z.object({ tickets: z.array(backlogItemSchema) });

/** JSON schema handed to the agent for structured output; mirrors backlogItemSchema. */
export const BACKLOG_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          acceptanceCriteria: { type: 'string', description: 'One testable statement per line, each starting with "- "' },
          size: { type: 'string', enum: [...SIZES] },
          labels: { type: 'array', items: { type: 'string' } },
          dependsOn: { type: 'array', items: { type: 'integer' }, description: 'Indexes of earlier tickets in this list' },
        },
        required: ['title', 'description', 'acceptanceCriteria', 'size', 'labels', 'dependsOn'],
        additionalProperties: false,
      },
    },
  },
  required: ['tickets'],
  additionalProperties: false,
};

/** Keeps only dependencies on earlier items, without repeats, so the list can be created in order. */
export function cleanItems(items: z.input<typeof backlogItemSchema>[]): BacklogItem[] {
  return items.map((raw, i) => {
    const item = backlogItemSchema.parse(raw);
    return { ...item, dependsOn: [...new Set(item.dependsOn)].filter((d) => d >= 0 && d < i) };
  });
}

/** Reads the backlog from structured output, or from the first ```json block of the text. */
export function parseBacklog(structured: unknown, text: string): BacklogItem[] {
  let data = structured;
  if (data === undefined || data === null) {
    const block = /```json\s*\n([\s\S]*?)```/i.exec(text);
    if (!block) throw new Error('The planner returned no backlog.');
    try {
      data = JSON.parse(block[1]);
    } catch {
      throw new Error('The planner returned a backlog that is not valid JSON.');
    }
  }
  const { tickets } = backlogSchema.parse(Array.isArray(data) ? { tickets: data } : data);
  return cleanItems(tickets);
}

export async function draftBacklog(
  deps: { store: Store; secrets: SecretStore; agent: CodingAgent },
  project: Project,
  existingTickets: Ticket[],
  cwd: string,
  extra: ExtraKnowledge = {},
): Promise<BacklogDraft> {
  const key = deps.secrets.get('ANTHROPIC_API_KEY');
  const out = await deps.agent.run({
    cwd,
    prompt: 'Draft the backlog for this project now.',
    systemPrompt: plannerSystemPrompt(project, existingTickets, extra),
    model: deps.store.getSetting('model.planner') || 'claude-opus-5-5',
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 40,
    outputSchema: BACKLOG_JSON_SCHEMA,
    env: key ? { ANTHROPIC_API_KEY: key } : {},
  });
  if (!out.ok) throw new Error(out.error ?? 'The planner stopped without a backlog.');
  return deps.store.createDraft(project.id, parseBacklog(out.structured, out.text), out.costUsd);
}

export interface ApproveResult {
  draft: BacklogDraft;
  created: Ticket[];
  error: string | null;
}

/**
 * Creates the draft's tickets in the PM tool in list order and records their dependencies.
 * If a create fails, what was created stays, the error is recorded, and approving again carries on from there.
 */
export async function approveDraft(store: Store, pm: PmAdapter, draft: BacklogDraft): Promise<ApproveResult> {
  if (draft.status !== 'draft') throw new Error(`This draft is already ${draft.status}.`);
  const keys = draft.items.map((_, i) => draft.createdKeys[i] ?? null);
  const created: Ticket[] = [];
  let error: string | null = null;

  for (const [i, item] of draft.items.entries()) {
    if (keys[i]) continue;
    const depKeys = item.dependsOn.map((d) => keys[d]).filter((k): k is string => !!k);
    const description = depKeys.length ? `${item.description.trim()}\n\nDepends on: ${depKeys.join(', ')}`.trim() : item.description;
    try {
      const ticket = await pm.createTicket({
        title: item.title, description, acceptanceCriteria: item.acceptanceCriteria, size: item.size, labels: item.labels,
      });
      keys[i] = ticket.key;
      created.push(ticket);
      for (const k of depKeys) store.addDependency(draft.projectId, ticket.key, k);
    } catch (e) {
      error = `Stopped at "${item.title}": ${e instanceof Error ? e.message : String(e)}`;
      break;
    }
  }

  const updated = store.updateDraft(draft.id, {
    createdKeys: keys,
    error,
    ...(error ? {} : { status: 'approved' as const, approvedAt: new Date().toISOString() }),
  })!;
  return { draft: updated, created, error };
}

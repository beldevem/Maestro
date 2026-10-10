import YAML from 'yaml';
import { z } from 'zod';
import type { Ticket } from './types.js';

export const DEFAULT_WORKFLOW_YAML = `# How agents build on this project. Edit freely.
base_branch: main
pull_before_start: true            # fetch and start from the latest base branch
branch_pattern: "{type}/{key}-{slug}"
commit_convention: conventional    # feat: add login form [KEY-42]

definition_of_ready:
  require_acceptance_criteria: true
  max_size: M                      # tickets sized L or XL must be split first

quality_gates:                     # run in order in the ticket's worktree
  - name: install
    run: npm ci
  - name: lint
    run: npm run lint --if-present
  - name: test
    run: npm test --if-present
  - name: build
    run: npm run build --if-present
gate_timeout_minutes: 15
max_fix_attempts: 3

allowed_commands:                  # extra shell commands agents may run while coding
  - npm run
  - npx

definition_of_done:
  - All quality gates pass
  - Tests added or updated for the change
  - PR describes the change and links the ticket
  - Reviewed and approved by you

pull_request:
  draft: true

orchestration:
  auto_assign: false               # assign ready tickets to free workers on their own (the board toggle overrides this)
  dependency_ready_when: done      # or in_review: start a ticket once what it depends on is in review
  max_parallel: 2                  # tickets of this project worked on at once
  one_per_area: true               # never two running tickets with the same area: label
`;

const gateSchema = z.object({ name: z.string(), run: z.string() });

export const workflowSchema = z.object({
  base_branch: z.string().default('main'),
  pull_before_start: z.boolean().default(true),
  branch_pattern: z.string().default('{type}/{key}-{slug}'),
  commit_convention: z.enum(['conventional', 'plain']).default('conventional'),
  definition_of_ready: z
    .object({
      require_acceptance_criteria: z.boolean().default(true),
      max_size: z.string().default('M'),
    })
    .default({ require_acceptance_criteria: true, max_size: 'M' }),
  quality_gates: z.array(gateSchema).default([]),
  gate_timeout_minutes: z.number().positive().default(15),
  max_fix_attempts: z.number().int().min(0).default(3),
  allowed_commands: z.array(z.string()).default([]),
  definition_of_done: z.array(z.string()).default([]),
  pull_request: z.object({ draft: z.boolean().default(true) }).default({ draft: true }),
  orchestration: z
    .object({
      auto_assign: z.boolean().default(false),
      dependency_ready_when: z.enum(['done', 'in_review']).default('done'),
      max_parallel: z.number().int().min(1).default(2),
      one_per_area: z.boolean().default(true),
    })
    .default({ auto_assign: false, dependency_ready_when: 'done', max_parallel: 2, one_per_area: true }),
});

export type Workflow = z.infer<typeof workflowSchema>;

export function parseWorkflow(yamlText: string): Workflow {
  return workflowSchema.parse(YAML.parse(yamlText) ?? {});
}

export function validateWorkflow(yamlText: string): { ok: true } | { ok: false; error: string } {
  try {
    parseWorkflow(yamlText);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function slugify(text: string, max = 40): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

export function ticketType(ticket: Pick<Ticket, 'labels'>): 'feat' | 'fix' | 'chore' | 'docs' {
  const labels = ticket.labels.map((l) => l.toLowerCase());
  if (labels.some((l) => l === 'bug' || l === 'fix')) return 'fix';
  if (labels.includes('docs')) return 'docs';
  if (labels.includes('chore')) return 'chore';
  return 'feat';
}

export function branchName(pattern: string, ticket: Pick<Ticket, 'key' | 'title' | 'labels'>): string {
  return pattern
    .replaceAll('{type}', ticketType(ticket))
    .replaceAll('{key}', ticket.key)
    .replaceAll('{slug}', slugify(ticket.title));
}

export function commitMessage(wf: Workflow, ticket: Pick<Ticket, 'key' | 'title' | 'labels'>): string {
  const subject = ticket.title.trim().replace(/\.$/, '');
  return wf.commit_convention === 'conventional'
    ? `${ticketType(ticket)}: ${subject.charAt(0).toLowerCase()}${subject.slice(1)} [${ticket.key}]`
    : `${subject} [${ticket.key}]`;
}

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL'];

/** Definition of Ready: returns the reasons a ticket is not ready (empty when ready). */
export function checkReady(wf: Workflow, ticket: Ticket): string[] {
  const reasons: string[] = [];
  if (wf.definition_of_ready.require_acceptance_criteria && !ticket.acceptanceCriteria.trim()) {
    reasons.push('Acceptance criteria are missing.');
  }
  if (ticket.size) {
    const size = SIZE_ORDER.indexOf(ticket.size.toUpperCase());
    const max = SIZE_ORDER.indexOf(wf.definition_of_ready.max_size.toUpperCase());
    if (size >= 0 && max >= 0 && size > max) reasons.push(`Size ${ticket.size} is above the limit of ${wf.definition_of_ready.max_size}; split it first.`);
  }
  if (ticket.status === 'done') reasons.push('Ticket is already done.');
  return reasons;
}

/** The part of the code a ticket touches, from its `area:<name>` label. */
export function ticketArea(ticket: Pick<Ticket, 'labels'>): string | null {
  const label = ticket.labels.find((l) => /^area:./i.test(l.trim()));
  return label ? label.trim().slice(5).trim().toLowerCase() : null;
}

/**
 * Dependencies of each ticket that are not satisfied yet. A dependency whose ticket is no longer
 * listed by the PM tool (deleted, or past its listing limit) does not block.
 */
export function blockedBy(
  tickets: Pick<Ticket, 'key' | 'status'>[],
  deps: Map<string, string[]>,
  readyWhen: Workflow['orchestration']['dependency_ready_when'],
): Map<string, string[]> {
  const status = new Map(tickets.map((t) => [t.key, t.status]));
  const ok = (s: Ticket['status']) => s === 'done' || (readyWhen === 'in_review' && s === 'in_review');
  const result = new Map<string, string[]>();
  for (const t of tickets) {
    result.set(t.key, (deps.get(t.key) ?? []).filter((k) => status.has(k) && !ok(status.get(k)!)));
  }
  return result;
}

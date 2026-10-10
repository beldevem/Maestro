import type { Ticket, TicketStatus } from '../../types.js';

export interface NewTicket {
  title: string;
  description: string;
  acceptanceCriteria: string;
  size?: string;
  labels: string[];
}

/** What the engine needs from any PM tool (Jira, Trello, ...). The PM tool stays the source of truth. */
export interface PmAdapter {
  readonly provider: string;
  listTickets(): Promise<Ticket[]>;
  getTicket(key: string): Promise<Ticket | undefined>;
  createTicket(input: NewTicket): Promise<Ticket>;
  moveTicket(key: string, status: TicketStatus): Promise<void>;
  comment(key: string, text: string): Promise<void>;
}

/** Acceptance criteria are kept in the description under this heading for tools with no dedicated field. */
export const AC_HEADING = 'Acceptance criteria';

export function joinDescription(description: string, acceptanceCriteria: string): string {
  const ac = acceptanceCriteria.trim();
  return ac ? `${description.trim()}\n\n${AC_HEADING}:\n${ac}`.trim() : description.trim();
}

export function splitDescription(text: string): { description: string; acceptanceCriteria: string } {
  const match = new RegExp(`(^|\\n)#*\\s*${AC_HEADING}:?\\s*\\n`, 'i').exec(text);
  if (!match) return { description: text.trim(), acceptanceCriteria: '' };
  return {
    description: text.slice(0, match.index).trim(),
    acceptanceCriteria: text.slice(match.index + match[0].length).trim(),
  };
}

/** Pulls a size such as "size:M" or "M" out of labels. */
export function sizeFromLabels(labels: string[]): string | undefined {
  for (const l of labels) {
    const m = /^(?:size[:\-_ ])?(XS|S|M|L|XL)$/i.exec(l.trim());
    if (m) return m[1].toUpperCase();
  }
  return undefined;
}

import type { Ticket, TicketStatus } from '../../types.js';
import { joinDescription, sizeFromLabels, splitDescription, type NewTicket, type PmAdapter } from './types.js';

export interface JiraSettings {
  baseUrl: string;      // https://your-team.atlassian.net
  projectKey: string;   // MAE
  email: string;
  issueType?: string;   // Task
  /** Jira status names per Maestro status, comma separated alternatives. */
  statusTodo?: string;
  statusInProgress?: string;
  statusInReview?: string;
  statusDone?: string;
}

const DEFAULT_STATUS: Record<TicketStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review,Review,Code Review',
  done: 'Done',
};

type Adf = { type: string; text?: string; content?: Adf[] };

/**
 * Atlassian Document Format to plain text: one line per paragraph (so it round-trips with textToAdf),
 * "- " and "1. " for lists, fenced code blocks.
 */
export function adfToText(node: Adf | null | undefined): string {
  if (!node) return '';
  const inner = () => (node.content ?? []).map(adfToText).join('');
  switch (node.type) {
    case 'text': return node.text ?? '';
    case 'hardBreak': return '\n';
    case 'paragraph':
    case 'heading': return `${inner()}\n`;
    case 'codeBlock': return `\`\`\`\n${inner()}\n\`\`\`\n`;
    case 'bulletList':
    case 'orderedList':
      return (node.content ?? [])
        .map((item, i) => `${node.type === 'bulletList' ? '-' : `${i + 1}.`} ${adfToText(item).trim().replace(/\n/g, '\n  ')}\n`)
        .join('');
    default: return inner();
  }
}

export function textToAdf(text: string): Adf {
  return {
    type: 'doc',
    // @ts-expect-error ADF needs a version field on the root
    version: 1,
    content: text.split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })),
  };
}

export class JiraPm implements PmAdapter {
  readonly provider = 'jira';

  constructor(
    private readonly s: JiraSettings,
    private readonly token: () => string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.token();
    if (!token) throw new Error('Add a Jira API token in Settings.');
    if (!this.s.baseUrl || !this.s.email || !this.s.projectKey) throw new Error('Set the Jira URL, email and project key on the project.');
    const res = await this.fetchImpl(`${this.s.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.s.email}:${token}`).toString('base64')}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
    if (!res.ok) throw new Error(`Jira ${init.method ?? 'GET'} ${path} failed (${res.status}): ${await res.text()}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  private statusNames(status: TicketStatus): string[] {
    const configured = {
      todo: this.s.statusTodo, in_progress: this.s.statusInProgress, in_review: this.s.statusInReview, done: this.s.statusDone,
    }[status];
    return (configured || DEFAULT_STATUS[status]).split(',').map((n) => n.trim().toLowerCase());
  }

  private toStatus(category: string, name: string): TicketStatus {
    const lower = name.toLowerCase();
    for (const s of ['in_review', 'done', 'in_progress', 'todo'] as TicketStatus[]) {
      if (this.statusNames(s).includes(lower)) return s;
    }
    return category === 'done' ? 'done' : category === 'indeterminate' ? 'in_progress' : 'todo';
  }

  private toTicket(issue: any): Ticket {
    const { description, acceptanceCriteria } = splitDescription(adfToText(issue.fields.description).trim());
    const labels: string[] = issue.fields.labels ?? [];
    return {
      key: issue.key,
      title: issue.fields.summary,
      description,
      acceptanceCriteria,
      status: this.toStatus(issue.fields.status?.statusCategory?.key ?? '', issue.fields.status?.name ?? ''),
      size: sizeFromLabels(labels),
      labels,
      url: `${this.s.baseUrl.replace(/\/$/, '')}/browse/${issue.key}`,
    };
  }

  /** Every issue of the project in rank order, following Jira's page tokens (up to 1,000 issues). */
  async listTickets(): Promise<Ticket[]> {
    const jql = encodeURIComponent(`project = "${this.s.projectKey}" ORDER BY rank ASC`);
    const issues: any[] = [];
    let token: string | undefined;
    do {
      const page = await this.call<{ issues: any[]; nextPageToken?: string; isLast?: boolean }>(
        `/rest/api/3/search/jql?jql=${jql}&maxResults=100&fields=summary,description,status,labels${token ? `&nextPageToken=${encodeURIComponent(token)}` : ''}`,
      );
      issues.push(...page.issues);
      token = page.isLast === false || (page.isLast === undefined && page.nextPageToken) ? page.nextPageToken : undefined;
    } while (token && issues.length < 1000);
    return issues.map((i) => this.toTicket(i));
  }

  async getTicket(key: string): Promise<Ticket | undefined> {
    const issue = await this.call<any>(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,labels`);
    return issue ? this.toTicket(issue) : undefined;
  }

  async createTicket(input: NewTicket): Promise<Ticket> {
    const labels = input.size ? [...input.labels, `size:${input.size}`] : input.labels;
    const created = await this.call<{ key: string }>('/rest/api/3/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: this.s.projectKey },
          summary: input.title,
          issuetype: { name: this.s.issueType || 'Task' },
          description: textToAdf(joinDescription(input.description, input.acceptanceCriteria)),
          labels: labels.map((l) => l.replace(/\s+/g, '-')),
        },
      }),
    });
    return (await this.getTicket(created.key))!;
  }

  async moveTicket(key: string, status: TicketStatus): Promise<void> {
    const { transitions } = await this.call<{ transitions: { id: string; name: string; to: { name: string } }[] }>(
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    );
    const wanted = this.statusNames(status);
    const t = transitions.find((t) => wanted.includes(t.to.name.toLowerCase()) || wanted.includes(t.name.toLowerCase()));
    if (!t) return; // No matching transition from the current status; leave the ticket where it is.
    await this.call(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: t.id } }),
    });
  }

  async comment(key: string, text: string): Promise<void> {
    await this.call(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: textToAdf(text) }),
    });
  }
}

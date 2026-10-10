import type { Ticket, TicketStatus } from '../../types.js';
import { joinDescription, sizeFromLabels, splitDescription, type NewTicket, type PmAdapter } from './types.js';

export interface TrelloSettings {
  boardId: string;
  listTodo: string;
  listInProgress: string;
  listInReview: string;
  listDone: string;
}

const API = 'https://api.trello.com/1';

export class TrelloPm implements PmAdapter {
  readonly provider = 'trello';

  constructor(
    private readonly s: TrelloSettings,
    private readonly creds: () => { key?: string; token?: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}, params: Record<string, string> = {}): Promise<T> {
    const { key, token } = this.creds();
    if (!key || !token) throw new Error('Add a Trello API key and token in Settings.');
    const qs = new URLSearchParams({ ...params, key, token });
    const res = await this.fetchImpl(`${API}${path}?${qs}`, { ...init, headers: { Accept: 'application/json', ...init.headers } });
    if (!res.ok) throw new Error(`Trello ${init.method ?? 'GET'} ${path} failed (${res.status}): ${await res.text()}`);
    return (await res.json()) as T;
  }

  private listFor(status: TicketStatus): string {
    const id = { todo: this.s.listTodo, in_progress: this.s.listInProgress, in_review: this.s.listInReview, done: this.s.listDone }[status];
    if (!id) throw new Error(`Set the Trello list for "${status}" on the project.`);
    return id;
  }

  private statusFor(listId: string): TicketStatus {
    if (listId === this.s.listDone) return 'done';
    if (listId === this.s.listInReview) return 'in_review';
    if (listId === this.s.listInProgress) return 'in_progress';
    return 'todo';
  }

  private toTicket(card: any): Ticket {
    const { description, acceptanceCriteria } = splitDescription(card.desc ?? '');
    const labels: string[] = (card.labels ?? []).map((l: { name: string }) => l.name).filter(Boolean);
    return {
      key: card.shortLink ?? card.id,
      title: card.name,
      description,
      acceptanceCriteria,
      status: this.statusFor(card.idList),
      size: sizeFromLabels(labels),
      labels,
      url: card.shortUrl ?? card.url,
    };
  }

  async listTickets(): Promise<Ticket[]> {
    if (!this.s.boardId) throw new Error('Set the Trello board id on the project.');
    const cards = await this.call<any[]>(`/boards/${this.s.boardId}/cards/open`, {}, { fields: 'name,desc,idList,labels,shortLink,shortUrl,idShort' });
    return cards.map((c) => this.toTicket(c));
  }

  async getTicket(key: string): Promise<Ticket | undefined> {
    const card = await this.call<any>(`/cards/${encodeURIComponent(key)}`, {}, { fields: 'name,desc,idList,labels,shortLink,shortUrl,idShort' });
    return card ? this.toTicket(card) : undefined;
  }

  /** Trello labels are board objects: find each by name, creating the ones the board doesn't have. */
  private async labelIds(names: string[]): Promise<string[]> {
    if (!names.length) return [];
    const existing = await this.call<{ id: string; name: string }[]>(`/boards/${this.s.boardId}/labels`, {}, { fields: 'name', limit: '1000' });
    const ids: string[] = [];
    for (const name of [...new Set(names)]) {
      const found = existing.find((l) => l.name.toLowerCase() === name.toLowerCase());
      if (found) ids.push(found.id);
      else ids.push((await this.call<{ id: string }>('/labels', { method: 'POST' }, { name, color: 'null', idBoard: this.s.boardId })).id);
    }
    return ids;
  }

  async createTicket(input: NewTicket): Promise<Ticket> {
    const idList = this.listFor('todo');
    const labels = input.size ? [...input.labels, `size:${input.size}`] : input.labels;
    const idLabels = await this.labelIds(labels);
    const card = await this.call<any>('/cards', { method: 'POST' }, {
      idList,
      name: input.title,
      desc: joinDescription(input.description, input.acceptanceCriteria),
      ...(idLabels.length ? { idLabels: idLabels.join(',') } : {}),
    });
    return this.toTicket(card);
  }

  async moveTicket(key: string, status: TicketStatus): Promise<void> {
    await this.call(`/cards/${encodeURIComponent(key)}`, { method: 'PUT' }, { idList: this.listFor(status) });
  }

  async comment(key: string, text: string): Promise<void> {
    await this.call(`/cards/${encodeURIComponent(key)}/actions/comments`, { method: 'POST' }, { text });
  }
}

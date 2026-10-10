import type { Store } from '../../db.js';
import type { Ticket, TicketStatus } from '../../types.js';
import type { NewTicket, PmAdapter } from './types.js';

/** Tickets typed into Maestro, for projects that have no PM tool. */
export class ManualPm implements PmAdapter {
  readonly provider = 'manual';

  constructor(
    private readonly store: Store,
    private readonly projectId: string,
    private readonly prefix: string,
  ) {}

  async listTickets(): Promise<Ticket[]> {
    return this.store.listManualTickets(this.projectId);
  }
  async getTicket(key: string): Promise<Ticket | undefined> {
    return this.store.getManualTicket(this.projectId, key);
  }
  async createTicket(input: NewTicket): Promise<Ticket> {
    return this.store.createManualTicket(this.projectId, this.prefix, input);
  }
  async moveTicket(key: string, status: TicketStatus): Promise<void> {
    this.store.setManualTicketStatus(this.projectId, key, status);
  }
  async comment(): Promise<void> {
    // Run logs already hold the history for manual tickets.
  }
}

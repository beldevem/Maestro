import type { Store } from '../../db.js';
import type { SecretStore } from '../../secrets.js';
import type { Project } from '../../types.js';
import { JiraPm, type JiraSettings } from './jira.js';
import { ManualPm } from './manual.js';
import { TrelloPm, type TrelloSettings } from './trello.js';
import type { PmAdapter } from './types.js';

export type { PmAdapter, NewTicket } from './types.js';

export function ticketPrefix(project: Project): string {
  const letters = project.name.replace(/[^A-Za-z]/g, '').toUpperCase();
  return (letters.slice(0, 3) || 'MAE').padEnd(3, 'X');
}

export function pmFor(project: Project, store: Store, secrets: SecretStore): PmAdapter {
  const s = project.pm.settings ?? {};
  switch (project.pm.provider) {
    case 'jira':
      return new JiraPm(s as unknown as JiraSettings, () => secrets.get('JIRA_API_TOKEN'));
    case 'trello':
      return new TrelloPm(s as unknown as TrelloSettings, () => ({ key: secrets.get('TRELLO_API_KEY'), token: secrets.get('TRELLO_TOKEN') }));
    case 'manual':
    default:
      return new ManualPm(store, project.id, ticketPrefix(project));
  }
}

import type { SecretStore } from '../../secrets.js';
import type { Project } from '../../types.js';
import { ConfluenceClient, confluenceLinks, pageIdFrom } from './confluence.js';

const MAX_PAGE_CHARS = 15_000;
const MAX_TOTAL_CHARS = 40_000;

/** Page ids set on the project (one URL or id per line) plus any Confluence links in `extraText`. */
export function docPageIds(project: Project, extraText = ''): string[] {
  if (project.docs?.provider !== 'confluence') return [];
  const listed = (project.docs.settings['pages'] ?? '').split(/[\n,]/).map(pageIdFrom).filter((id): id is string => !!id);
  return [...new Set([...listed, ...confluenceLinks(`${project.requirements}\n${project.context}\n${extraText}`)])];
}

/**
 * Reads the project's Confluence pages (and pages linked in `extraText`, e.g. a ticket) as text for agent prompts.
 * Uses the Jira site and email when the project's PM tool is Jira, else the docs settings, with the Atlassian token.
 * Returns null when there are no pages; pages that fail are named in the text instead of failing the run.
 */
export async function docsContextFor(project: Project, secrets: SecretStore, extraText = '', fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const ids = docPageIds(project, extraText);
  if (!ids.length) return null;
  const s = project.docs.settings;
  const baseUrl = s['baseUrl'] || (project.pm.provider === 'jira' ? project.pm.settings['baseUrl'] : '');
  const email = s['email'] || (project.pm.provider === 'jira' ? project.pm.settings['email'] : '');
  const token = secrets.get('JIRA_API_TOKEN');
  if (!baseUrl || !email) throw new Error('Set the Confluence site URL and email on the project (or use Jira as the PM tool).');
  if (!token) throw new Error('Add the Atlassian API token in Settings to read Confluence pages.');

  const client = new ConfluenceClient(baseUrl, email, token, fetchImpl);
  const parts: string[] = [];
  let total = 0;
  for (const id of ids) {
    if (total >= MAX_TOTAL_CHARS) {
      parts.push(`(More pages were left out to keep this short: ${ids.slice(ids.indexOf(id)).join(', ')}.)`);
      break;
    }
    try {
      const page = await client.page(id);
      const text = page.text.length > MAX_PAGE_CHARS ? `${page.text.slice(0, MAX_PAGE_CHARS)}\n…(cut)` : page.text;
      total += text.length;
      parts.push(`### ${page.title}\n${text}`);
    } catch (e) {
      parts.push(`### Page ${id}\n(Could not be read: ${(e as Error).message})`);
    }
  }
  return parts.join('\n\n');
}

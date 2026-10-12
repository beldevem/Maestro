import { httpFetch } from '../../http.js';
/** A Confluence page id from a page URL (…/pages/12345/Title or ?pageId=12345) or a bare id. */
export function pageIdFrom(ref: string): string | null {
  const v = ref.trim();
  if (/^\d+$/.test(v)) return v;
  const m = /\/pages\/(\d+)/.exec(v) ?? /[?&]pageId=(\d+)/.exec(v);
  return m ? m[1] : null;
}

/** Confluence page links in free text (tickets, requirements). */
export function confluenceLinks(text: string): string[] {
  const ids = [...text.matchAll(/https:\/\/[^\s)>\]]+\/wiki\/[^\s)>\]]+/g)].map((m) => pageIdFrom(m[0])).filter((id): id is string => !!id);
  return [...new Set(ids)];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

/** Confluence storage format (XHTML) to readable plain text with headings, lists and table rows kept. */
export function storageToText(html: string): string {
  return html
    .replace(/<ac:structured-macro[^>]*ac:name="(?:toc|children|jira)"[\s\S]*?<\/ac:structured-macro>/g, '')
    .replace(/<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>/g, (_, code) => `\n\`\`\`\n${code}\n\`\`\`\n`)
    .replace(/<h([1-6])[^>]*>/g, (_, n) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/h[1-6]>/g, '\n\n')
    .replace(/<li[^>]*>/g, '\n- ')
    .replace(/<\/(p|div|ul|ol|table|blockquote)>/g, '\n')
    .replace(/<(br|hr)\s*\/?>/g, '\n')
    .replace(/<\/t[hd]>/g, ' | ')
    .replace(/<tr[^>]*>/g, '\n| ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (all, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? all,
    )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ConfluencePage {
  id: string;
  title: string;
  text: string;
}

/** Read-only Confluence Cloud client, using the same Atlassian account and API token as Jira. */
export class ConfluenceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly email: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = httpFetch,
  ) {}

  async page(id: string): Promise<ConfluencePage> {
    const root = this.baseUrl.replace(/\/+$/, '').replace(/\/wiki$/, '');
    const res = await this.fetchImpl(`${root}/wiki/api/v2/pages/${id}?body-format=storage`, {
      headers: { Authorization: `Basic ${Buffer.from(`${this.email}:${this.token}`).toString('base64')}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Confluence page ${id} could not be read (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const page = (await res.json()) as { id: string; title: string; body?: { storage?: { value?: string } } };
    return { id: page.id, title: page.title, text: storageToText(page.body?.storage?.value ?? '') };
  }
}

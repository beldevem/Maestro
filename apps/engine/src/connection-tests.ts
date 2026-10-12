import type { SecretStore } from './secrets.js';
import { httpFetch } from './http.js';

export type TestableProvider = 'anthropic' | 'github' | 'gitlab' | 'bitbucket' | 'trello' | 'figma';

/**
 * Tries the saved token against the provider's "who am I" endpoint (free, no agent cost)
 * and says who it signs in as, or why it failed.
 */
export async function testConnection(provider: TestableProvider, secrets: SecretStore, fetchImpl: typeof fetch = httpFetch): Promise<{ ok: boolean; message: string }> {
  const need = (name: string) => {
    const v = secrets.get(name);
    if (!v) throw new Error(`No ${name} saved yet.`);
    return v;
  };
  const get = async (url: string, headers: Record<string, string>) => {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers } });
    if (res.status === 401 || res.status === 403) throw new Error('The token was refused. Check it and its permissions.');
    if (!res.ok) throw new Error(`The service answered ${res.status}.`);
    return (await res.json()) as Record<string, any>;
  };
  try {
    switch (provider) {
      case 'anthropic': {
        const r = await get('https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': need('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' });
        return { ok: true, message: `API key works${r.data?.[0]?.id ? `; models such as ${r.data[0].id} are available` : ''}.` };
      }
      case 'github': {
        const r = await get('https://api.github.com/user', { Authorization: `Bearer ${need('GITHUB_TOKEN')}`, 'X-GitHub-Api-Version': '2022-11-28' });
        return { ok: true, message: `Signed in to GitHub as ${r.login}.` };
      }
      case 'gitlab': {
        const r = await get('https://gitlab.com/api/v4/user', { 'PRIVATE-TOKEN': need('GITLAB_TOKEN') });
        return { ok: true, message: `Signed in to GitLab as ${r.username}. (Self-managed instances are checked from the project.)` };
      }
      case 'bitbucket': {
        const basic = Buffer.from(`${need('BITBUCKET_USERNAME')}:${need('BITBUCKET_APP_PASSWORD')}`).toString('base64');
        const r = await get('https://api.bitbucket.org/2.0/user', { Authorization: `Basic ${basic}` });
        return { ok: true, message: `Signed in to Bitbucket as ${r.display_name ?? r.username}.` };
      }
      case 'trello': {
        const qs = new URLSearchParams({ key: need('TRELLO_API_KEY'), token: need('TRELLO_TOKEN'), fields: 'username' });
        const r = await get(`https://api.trello.com/1/members/me?${qs}`, {});
        return { ok: true, message: `Signed in to Trello as ${r.username}.` };
      }
      case 'figma': {
        const r = await get('https://api.figma.com/v1/me', { 'X-Figma-Token': need('FIGMA_TOKEN') });
        return { ok: true, message: `Signed in to Figma as ${r.handle ?? r.email}.` };
      }
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

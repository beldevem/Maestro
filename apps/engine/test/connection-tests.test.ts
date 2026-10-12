import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testConnection } from '../src/connection-tests.js';
import { SecretStore } from '../src/secrets.js';
import { fakeApi } from './fake-api.js';

const secrets = (values: Record<string, string>) => {
  const s = new SecretStore(join(mkdtempSync(join(tmpdir(), 'maestro-conn-')), 's.json'));
  for (const [k, v] of Object.entries(values)) s.set(k, v);
  return s;
};

describe('test connection', () => {
  it('says who a token signs in as', async () => {
    const api = fakeApi({ 'GET https://api.github.com/user': [200, { login: 'beldevem' }], 'GET https://api.figma.com/v1/me': [200, { handle: 'Bel' }] });
    expect(await testConnection('github', secrets({ GITHUB_TOKEN: 'ghp' }), api.impl)).toEqual({ ok: true, message: 'Signed in to GitHub as beldevem.' });
    expect(api.calls[0].headers.Authorization).toBe('Bearer ghp');
    expect(await testConnection('figma', secrets({ FIGMA_TOKEN: 'f' }), api.impl)).toEqual({ ok: true, message: 'Signed in to Figma as Bel.' });
  });

  it('explains refused, missing and failing tokens', async () => {
    const api = fakeApi({ 'GET https://api.github.com/user': [401, {}], 'GET https://gitlab.com/api/v4/user': [502, {}] });
    expect(await testConnection('github', secrets({ GITHUB_TOKEN: 'bad' }), api.impl)).toEqual({ ok: false, message: 'The token was refused. Check it and its permissions.' });
    expect(await testConnection('gitlab', secrets({ GITLAB_TOKEN: 'x' }), api.impl)).toEqual({ ok: false, message: 'The service answered 502.' });
    expect(await testConnection('trello', secrets({ TRELLO_API_KEY: 'k' }), api.impl)).toEqual({ ok: false, message: 'No TRELLO_TOKEN saved yet.' });
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generatePassword, hashPassword, passwordProblem, verifyPassword } from '../src/auth/passwords.js';
import { Auth, IDLE_MS, ABSOLUTE_MS } from '../src/auth/sessions.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { resetPassword } from '../src/user-reset.js';

const PASSWORD = 'correct horse battery';

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'maestro-auth-'));
  const store = new Store(join(home, 'db.sqlite'));
  const secrets = new SecretStore(join(home, 's.json'));
  const agent = { run: async () => ({ sessionId: '', text: '', costUsd: 0, ok: true }) };
  const app = await buildServer({ store, secrets, agent, orchestrator: new Orchestrator({ store, secrets, agent, reposDir: home, worktreesDir: home }), reposDir: home });
  /** Calls the API as a browser would: keeps the session cookie. */
  const browser = () => {
    let cookie = '';
    return async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
      const res = await app.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
      const set = res.headers['set-cookie'];
      if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0];
      return res;
    };
  };
  return { home, store, app, browser };
}

describe('passwords', () => {
  it('hashes with a per-password salt and checks in constant time', async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword('wrong horse battery', a)).toBe(false);
    expect(await verifyPassword(PASSWORD, 'garbage')).toBe(false);
  });
  it('asks for at least 12 characters, and generates readable one-time passwords', () => {
    expect(passwordProblem('short')).toMatch(/12 characters/);
    expect(passwordProblem('aaaaaaaaaaaaaa')).toMatch(/repeated/);
    expect(passwordProblem(PASSWORD)).toBeNull();
    expect(generatePassword()).toMatch(/^[a-zA-Z2-9]{5}(-[a-zA-Z2-9]{5}){3}$/);
  });
});

describe('first run, login and logout', () => {
  it('sets up the first account as Project Manager and Tech Lead, owning what exists, once', async () => {
    const { app, store, browser } = await setup();
    // Data from before accounts existed.
    const p = store.createProject({ name: 'Shop', description: '', codeHost: { provider: 'local', localPath: '/x', defaultBranch: 'main' }, pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} }, context: '', requirements: '', bestPractices: '' });
    store.addSpend(p.id, null, 'chat', 0, { input: 10, output: 1, cache: 0 });
    const t = store.createThread();
    store.addChatMessage(`chat:${t.id}`, 'user', 'hi');

    const as = browser();
    expect((await as('GET', '/api/projects')).statusCode).toBe(401);
    expect((await as('GET', '/api/auth/status')).json()).toEqual({ setupNeeded: true, user: null });
    expect((await as('POST', '/api/auth/setup', { email: 'me@x.io', name: 'Me', password: 'short' })).json().error).toMatch(/12 characters/);
    const res = await as('POST', '/api/auth/setup', { email: 'me@x.io', name: 'Me', password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toMatch(/maestro_session=.+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000/);
    expect(res.json().user).toMatchObject({ email: 'me@x.io', roles: ['pm', 'lead'], mustChangePassword: false });
    expect((await as('GET', '/api/projects')).statusCode).toBe(200);

    const id = res.json().user.id;
    const row = (sql: string) => store.db.prepare(sql).get() as Record<string, unknown>;
    expect(row('SELECT user_id FROM spend').user_id).toBe(id);
    expect(row('SELECT user_id FROM chat_threads').user_id).toBe(id);
    expect(row("SELECT user_id FROM chat_messages WHERE role = 'user'").user_id).toBe(id);
    expect(row('SELECT user_id FROM project_members').user_id).toBe(id);

    expect((await browser()('POST', '/api/auth/setup', { email: 'evil@x.io', name: 'Evil', password: PASSWORD })).statusCode).toBe(409);
    await app.close();
  });

  it('logs in, keeps the session only in a hash, and logs out', async () => {
    const { app, store, browser } = await setup();
    await browser()('POST', '/api/auth/setup', { email: 'me@x.io', name: 'Me', password: PASSWORD });
    const as = browser();
    expect((await as('POST', '/api/auth/login', { email: 'nobody@x.io', password: PASSWORD })).json()).toEqual({ error: 'Wrong email or password.', code: 'bad_credentials' });
    const ok = await as('POST', '/api/auth/login', { email: 'ME@x.io', password: PASSWORD });
    expect(ok.statusCode).toBe(200);
    const cookieId = String(ok.headers['set-cookie']).split(';')[0].split('=')[1];
    expect(JSON.stringify(store.db.prepare('SELECT * FROM sessions').all())).not.toContain(decodeURIComponent(cookieId));
    expect((await as('GET', '/api/auth/status')).json().user.email).toBe('me@x.io');
    const out = await as('POST', '/api/auth/logout');
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie: `maestro_session=${cookieId}` } })).statusCode).toBe(401);
    // Health checks need no session.
    expect((await app.inject({ method: 'GET', url: '/api/ready' })).statusCode).toBe(200);
    await app.close();
  });

  it('locks an account for 15 minutes after 5 wrong passwords', async () => {
    const { app, browser } = await setup();
    await browser()('POST', '/api/auth/setup', { email: 'me@x.io', name: 'Me', password: PASSWORD });
    const as = browser();
    for (let i = 0; i < 4; i++) expect((await as('POST', '/api/auth/login', { email: 'me@x.io', password: 'wrong password!' })).statusCode).toBe(401);
    const locked = await as('POST', '/api/auth/login', { email: 'me@x.io', password: 'wrong password!' });
    expect(locked.statusCode).toBe(423);
    expect(locked.json().error).toMatch(/locked for 15 minutes/);
    expect((await as('POST', '/api/auth/login', { email: 'me@x.io', password: PASSWORD })).json().error).toMatch(/locked until/);
    await app.close();
  });
});

describe('sessions', () => {
  it('end after 7 idle days, or 30 days in all', async () => {
    const { store } = await setup();
    let now = Date.parse('2026-10-01T00:00:00Z');
    const auth = new Auth(store, () => now);
    const u = await auth.createUser({ email: 'a@x.io', name: 'A', password: PASSWORD, roles: ['dev'] });
    const s = auth.startSession(u.id, null);
    now += IDLE_MS - 120_000;
    expect(auth.resolve(s)?.user.email).toBe('a@x.io');
    now += IDLE_MS - 120_000;
    expect(auth.resolve(s)).not.toBeNull();
    now += IDLE_MS + 1;
    expect(auth.resolve(s)).toBeNull();

    const s2 = auth.startSession(u.id, null);
    for (let d = 0; d < 5; d++) {
      now += 5 * 86_400_000;
      expect(auth.resolve(s2)).not.toBeNull();
    }
    // Used every 5 days, it still ends 30 days after login.
    now += 5 * 86_400_000;
    expect(auth.resolve(s2)).toBeNull();
  });

  it('a password change ends your other sessions; a deactivated user is logged out', async () => {
    const { app, store, browser } = await setup();
    const first = browser();
    await first('POST', '/api/auth/setup', { email: 'me@x.io', name: 'Me', password: PASSWORD });
    const second = browser();
    await second('POST', '/api/auth/login', { email: 'me@x.io', password: PASSWORD });
    expect((await first('POST', '/api/auth/password', { current: 'nope nope nope', next: 'a new long password' })).json().error).toMatch(/current password is wrong/);
    expect((await first('POST', '/api/auth/password', { current: PASSWORD, next: 'a new long password' })).statusCode).toBe(200);
    expect((await first('GET', '/api/projects')).statusCode).toBe(200);
    expect((await second('GET', '/api/projects')).statusCode).toBe(401);

    store.updateUser(store.getUserByEmail('me@x.io')!.id, { deactivatedAt: new Date().toISOString() });
    expect((await first('GET', '/api/projects')).statusCode).toBe(401);
    await app.close();
  });
});

describe('recovery from the command line', () => {
  it('prints a one-time password that must be changed at login', async () => {
    const { app, store, browser } = await setup();
    await browser()('POST', '/api/auth/setup', { email: 'me@x.io', name: 'Me', password: PASSWORD });
    const other = browser();
    await other('POST', '/api/auth/login', { email: 'me@x.io', password: PASSWORD });
    const { password } = await resetPassword(store, 'me@x.io');
    await expect(resetPassword(store, 'ghost@x.io')).rejects.toThrow(/No account with the email ghost@x.io. Accounts: me@x.io/);
    expect((await other('GET', '/api/projects')).statusCode).toBe(401);

    const as = browser();
    expect((await as('POST', '/api/auth/login', { email: 'me@x.io', password: PASSWORD })).statusCode).toBe(401);
    const res = await as('POST', '/api/auth/login', { email: 'me@x.io', password });
    expect(res.json().user.mustChangePassword).toBe(true);
    const blocked = await as('GET', '/api/projects');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('password_change_required');
    expect((await as('POST', '/api/auth/password', { current: password, next: 'my own new password' })).json().user.mustChangePassword).toBe(false);
    expect((await as('GET', '/api/projects')).statusCode).toBe(200);
    await app.close();
  });
});

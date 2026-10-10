import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodingAgent } from '../src/agents/coding-agent.js';
import { dailyCap, perRunCap } from '../src/budget.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { numberSetting } from '../src/settings.js';

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'maestro-settings-'));
  const store = new Store(join(home, 'db.sqlite'));
  const secrets = new SecretStore(join(home, 's.json'));
  const agent: CodingAgent = { run: async () => ({ sessionId: null, text: '', costUsd: 0, ok: true }) };
  const orchestrator = new Orchestrator({ store, secrets, agent, reposDir: home, worktreesDir: home });
  return { store, orchestrator, app: await buildServer({ store, secrets, agent, orchestrator, reposDir: home }) };
}

describe('number settings', () => {
  it('refuses values that are not valid numbers, with a message', async () => {
    const { app, store } = await setup();
    for (const [key, value, message] of [
      ['maxConcurrentRuns', 'null', 'maxConcurrentRuns must be a number.'],
      ['maxConcurrentRuns', '0', 'maxConcurrentRuns must be at least 1.'],
      ['budget.perRunUsd', '', 'budget.perRunUsd must be a number.'],
      ['worktrees.keepDays', '1.5', 'worktrees.keepDays must be a whole number.'],
    ]) {
      const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: { 'model.worker': 'm', [key]: value } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(message);
    }
    expect(store.getSetting('model.worker')).toBeUndefined();
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { maxConcurrentRuns: '2', 'budget.perRunUsd': '0.5' } })).statusCode).toBe(200);
    await app.close();
  });

  it('never turns a limit off when a stored value is broken', async () => {
    const { store, orchestrator } = await setup();
    for (const v of ['null', '', 'abc', '-4']) {
      store.setSetting('maxConcurrentRuns', v);
      store.setSetting('budget.perRunUsd', v);
      store.setSetting('budget.projectDailyUsd', v);
      expect(orchestrator.maxConcurrent()).toBe(3);
      expect(perRunCap(store)).toBe(5);
      expect(dailyCap(store, 'p')).toBe(0);
    }
    store.setSetting('worktrees.keepDays', 'null');
    expect(numberSetting(store, 'worktrees.keepDays')).toBe(3);
    store.setSetting('budget.daily.p', 'null');
    store.setSetting('budget.projectDailyUsd', '7');
    expect(dailyCap(store, 'p')).toBe(7);
  });
});

import { ADMIN, gitFolder } from './users.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodingAgent } from '../src/agents/coding-agent.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { TEMPLATES, workflowFor } from '../src/templates.js';
import { DEFAULT_WORKFLOW_YAML, parseWorkflow } from '../src/workflow.js';

describe('project templates', () => {
  it('each makes a valid workflow with its own gates and the default rest', () => {
    const defaults = parseWorkflow(DEFAULT_WORKFLOW_YAML);
    for (const t of TEMPLATES) {
      const wf = parseWorkflow(workflowFor(t));
      expect(wf.quality_gates).toEqual(t.gates);
      expect(wf.allowed_commands).toEqual(t.allowedCommands);
      expect({ ...wf, quality_gates: [], allowed_commands: [] }).toEqual({ ...defaults, quality_gates: [], allowed_commands: [] });
    }
  });

  it('fills a new project from a template without overriding what you typed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-tpl-'));
    const store = new Store(join(home, 'db.sqlite'));
    const secrets = new SecretStore(join(home, 's.json'));
    const agent: CodingAgent = { run: async () => ({ sessionId: null, text: '', costUsd: 0, ok: true }) };
    const app = await buildServer({ actAs: ADMIN, store, secrets, agent, orchestrator: new Orchestrator({ store, secrets, agent, reposDir: home, worktreesDir: home }), reposDir: home });
    const codeHost = { provider: 'local', localPath: gitFolder(), defaultBranch: 'main' };

    const list = (await app.inject({ method: 'GET', url: '/api/templates' })).json();
    expect(list.map((t: { id: string }) => t.id)).toEqual(['node-api', 'angular', 'python']);

    const ng = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Web', codeHost, template: 'angular', context: 'Our shop front.' } })).json();
    expect(ng.context).toBe('Our shop front.');
    expect(ng.bestPractices).toContain('Standalone components');
    expect(parseWorkflow(ng.workflowYaml).quality_gates.map((g: { name: string }) => g.name)).toEqual(['install', 'lint', 'test', 'build']);
    expect(ng.template).toBeUndefined();

    const bad = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'X', codeHost, template: 'cobol' } });
    expect(bad.statusCode).toBe(400);
    await app.close();
    store.db.close();
  });
});

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCodingAgent } from './agents/coding-agent.js';
import { ensureHome, HOST, paths, PORT } from './config.js';
import { Store } from './db.js';
import { Orchestrator } from './orchestrator.js';
import { SecretStore } from './secrets.js';
import { buildServer } from './server.js';

ensureHome();
const store = new Store(paths.db);
const secrets = SecretStore.open(paths.secrets);
console.log(`Secrets are kept in ${secrets.kind === 'keychain' ? 'the system keychain' : paths.secrets}.`);
if (secrets.migrated.length) console.log(`Moved ${secrets.migrated.join(', ')} from ${paths.secrets} into the keychain.`);
const agent = new ClaudeCodingAgent();
const orchestrator = new Orchestrator({ store, secrets, agent, reposDir: paths.repos, worktreesDir: paths.worktrees });
orchestrator.recover();

if (store.listAgents().length === 0) {
  store.createAgent({ name: 'Worker 1', role: 'worker', model: '' });
  store.createAgent({ name: 'Worker 2', role: 'worker', model: '' });
}

const here = dirname(fileURLToPath(import.meta.url));
const dashboardDir = join(here, '../../dashboard/dist/dashboard/browser');
const app = await buildServer({ store, secrets, agent, orchestrator, reposDir: paths.repos, dashboardDir });
await app.listen({ port: PORT, host: HOST });
console.log(`Maestro engine on http://${HOST}:${PORT}`);

// Auto-assign: pick up ready tickets for projects that have it on.
setInterval(() => void orchestrator.tick(), 15_000);
void orchestrator.tick();
// No webhooks on a local machine: poll open pull requests for reviews, CI checks and merges.
setInterval(() => void orchestrator.pollPullRequests(), 60_000);

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCodingAgent } from './agents/coding-agent.js';
import { migrateProviders } from './agents/providers/config.js';
import { ProviderRouter } from './agents/providers/router.js';
import { ensureHome, HOST, MAESTRO_HOME, paths, PORT } from './config.js';
import { selfCheck } from './selfcheck.js';
import { IDLE_MS } from './auth/sessions.js';
import { Store } from './db.js';
import { log } from './log.js';
import { Orchestrator } from './orchestrator.js';
import { SecretStore } from './secrets.js';
import { buildServer } from './server.js';

/** Stops at startup with what went wrong and how to fix it, instead of a stack trace. */
function fatal(what: string, e: unknown, hint: string): never {
  log.error(`${what}: ${e instanceof Error ? e.message : String(e)}`);
  log.error(`How to fix: ${(e as { hint?: string })?.hint ?? hint}`);
  process.exit(1);
}

try {
  ensureHome();
} catch (e) {
  fatal(`Maestro can't use its data folder ${MAESTRO_HOME}`, e, 'Check that the folder exists and belongs to the user running Maestro (in Docker: MAESTRO_UID/MAESTRO_GID in .env).');
}
let store: Store;
try {
  store = new Store(paths.db);
} catch (e) {
  fatal(`Maestro can't open its database ${paths.db}`, e, /locked|busy/i.test(String(e)) ? 'Another Maestro engine is using this data folder; stop it first.' : 'Restore a backup of maestro.db (see docs/user-guide.md, Backups), or move the damaged file away to start empty.');
}
let secrets: SecretStore;
try {
  secrets = SecretStore.open(paths.secrets);
  secrets.names();
} catch (e) {
  fatal("Maestro can't read its secrets", e, `Fix or remove ${paths.secrets}, then re-enter your tokens in Settings.`);
}
// Load every secret once, so the logger can mask their values wherever they turn up.
for (const name of secrets.names()) secrets.get(name);
log.info(`Secrets are kept in ${secrets.kind === 'keychain' ? 'the system keychain' : paths.secrets}.`);
if (secrets.migrated.length) log.info(`Moved ${secrets.migrated.join(', ')} from ${paths.secrets} into the keychain.`);
// Installs from before AI providers existed keep working: Claude for every role.
migrateProviders(store);
const agent = new ProviderRouter(store, secrets, paths.sessions, new ClaudeCodingAgent());
const orchestrator = new Orchestrator({ store, secrets, agent, reposDir: paths.repos, worktreesDir: paths.worktrees });
orchestrator.recover();

if (store.listAgents().length === 0) {
  store.createAgent({ name: 'Worker 1', role: 'worker', model: '' });
  store.createAgent({ name: 'Worker 2', role: 'worker', model: '' });
}

const here = dirname(fileURLToPath(import.meta.url));
const dashboardDir = join(here, '../../dashboard/dist/dashboard/browser');
const app = await buildServer({ store, secrets, agent, orchestrator, reposDir: paths.repos, dashboardDir });
try {
  await app.listen({ port: PORT, host: HOST });
} catch (e) {
  fatal(`Maestro can't listen on ${HOST}:${PORT}`, e, (e as { code?: string }).code === 'EADDRINUSE' ? `Something else uses port ${PORT}: stop it, or set MAESTRO_PORT to another port.` : 'Check MAESTRO_HOST and MAESTRO_PORT.');
}
// What could get in the way, in the log now and in Settings → System check.
void selfCheck({ store, secrets, home: MAESTRO_HOME, dashboardDir }).then((checks) => {
  for (const c of checks.filter((x) => x.level !== 'ok')) (c.level === 'error' ? log.error : log.warn)(`${c.label}: ${c.message}${c.hint ? ` ${c.hint}` : ''}`);
});
log.info(`Maestro engine on http://${HOST}:${PORT}`, { schema: store.schemaVersion() });

const loops = [
  // Auto-assign: pick up ready tickets for projects that have it on.
  setInterval(() => void orchestrator.tick(), 15_000),
  // No webhooks on a local machine: poll open pull requests for reviews, CI checks and merges.
  setInterval(() => void orchestrator.pollPullRequests(), 60_000),
  // Worktrees of finished runs (each may hold its own node_modules) go after worktrees.keepDays (default 3; -1 keeps them).
  setInterval(() => void orchestrator.cleanupFinished(), 3_600_000),
  // Expired and long-idle sessions.
  setInterval(() => store.pruneSessions(new Date(Date.now() - IDLE_MS).toISOString()), 3_600_000),
];
void orchestrator.tick();
void orchestrator.cleanupFinished();

/** SIGTERM (docker stop) or Ctrl-C: stop the loops and new requests, let running agents stop, close the database. */
let exiting = false;
async function shutdown(signal: string): Promise<void> {
  if (exiting) return;
  exiting = true;
  log.info(`${signal} received, shutting down.`);
  for (const t of loops) clearInterval(t);
  const stopped = await orchestrator.shutdown(10_000);
  if (stopped) log.info(`Stopped ${stopped} running run${stopped === 1 ? '' : 's'}; they are picked up again on the next start.`);
  // Open event streams never finish on their own: give requests 5 seconds, then go.
  await Promise.race([app.close().catch((e: Error) => log.warn('Closing the server failed', { error: e })), new Promise((r) => setTimeout(r, 5000))]);
  store.close();
  log.info('Bye.');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log.error('Unhandled rejection', { error: e instanceof Error ? e : String(e) }));

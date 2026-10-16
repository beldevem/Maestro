import { accessSync, constants, existsSync, statfsSync } from 'node:fs';
import { cliInstalled } from './agents/providers/cli.js';
import { listProviders } from './agents/providers/config.js';
import { listModels } from './agents/providers/openai.js';
import { claudeLoginStatus } from './agents/providers/presets.js';
import { browseRoots } from './fsbrowse.js';
import type { Store } from './db.js';
import { run } from './proc.js';
import type { SecretStore } from './secrets.js';

export interface Check {
  id: string;
  label: string;
  level: 'ok' | 'warning' | 'error';
  message: string;
  hint?: string;
}

const ok = (id: string, label: string, message: string): Check => ({ id, label, level: 'ok', message });
const warn = (id: string, label: string, message: string, hint?: string): Check => ({ id, label, level: 'warning', message, hint });
const fail = (id: string, label: string, message: string, hint?: string): Check => ({ id, label, level: 'error', message, hint });

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms / 1000} seconds`)), ms).unref?.())]);

/** What could stop Maestro from working, with how to fix it. Runs at startup and from Settings → System check. */
export async function selfCheck(d: { store: Store; secrets: SecretStore; home: string; dashboardDir?: string }): Promise<Check[]> {
  const checks: Check[] = [];
  const inDocker = existsSync('/.dockerenv');

  try {
    accessSync(d.home, constants.W_OK);
    checks.push(ok('data_dir', 'Data folder', `${d.home} is writable.`));
  } catch {
    checks.push(fail('data_dir', 'Data folder', `${d.home} is not writable.`, inDocker ? 'Set MAESTRO_UID/MAESTRO_GID in .env to the owner of that folder.' : 'Check the folder\'s owner and permissions.'));
  }
  try {
    const free = statfsSync(d.home);
    const gb = (free.bavail * free.bsize) / 1e9;
    checks.push(gb < 1 ? warn('disk', 'Disk space', `Only ${gb.toFixed(1)} GB free where Maestro keeps its data.`, 'Remove finished worktrees (Runs tab) or free space; at 0 Maestro can no longer save.') : ok('disk', 'Disk space', `${gb.toFixed(0)} GB free.`));
  } catch {
    // statfs isn't available everywhere; nothing to report.
  }
  try {
    const r = d.store.db.prepare('PRAGMA quick_check').get() as { quick_check: string };
    checks.push(r.quick_check === 'ok' ? ok('database', 'Database', `OK (schema ${d.store.schemaVersion()}).`) : fail('database', 'Database', `The database reports a problem: ${r.quick_check}.`, 'Stop Maestro and restore a backup (user guide, Backups).'));
  } catch (e) {
    checks.push(fail('database', 'Database', `The database can't be read: ${(e as Error).message}.`, 'Stop Maestro and restore a backup (user guide, Backups).'));
  }
  try {
    const n = d.secrets.names().length;
    checks.push(ok('secrets', 'Secrets', `${n} saved (${d.secrets.kind === 'keychain' ? 'system keychain' : 'secrets file'}).`));
  } catch (e) {
    checks.push(fail('secrets', 'Secrets', (e as Error).message, (e as { hint?: string }).hint));
  }
  const git = await run('git', ['--version'], { cwd: d.home, timeoutMs: 5000 }).catch(() => null);
  checks.push(git && git.code === 0 ? ok('git', 'git', git.output.trim()) : fail('git', 'git', 'git is not installed or not on the PATH.', 'Install git; workers need it for branches, worktrees and commits.'));
  if (d.dashboardDir !== undefined) {
    checks.push(existsSync(d.dashboardDir) ? ok('dashboard', 'Dashboard', 'Built.') : warn('dashboard', 'Dashboard', 'The dashboard is not built, so only the API answers.', 'Run "npm run build" (Docker builds it for you).'));
  }
  const roots = browseRoots();
  checks.push(roots.length ? ok('folders', 'Project folders', `The folder picker shows ${roots.join(', ')}.`) : warn('folders', 'Project folders', 'No folder to browse for local projects.', inDocker ? 'Set PROJECTS_DIR in .env (it is mounted at the same path).' : 'Set MAESTRO_BROWSE_ROOTS.'));
  for (const p of d.store.listProjects().filter((x) => x.codeHost.provider === 'local')) {
    const path = p.codeHost.localPath ?? '';
    if (!existsSync(path)) checks.push(fail(`project_${p.id}`, `Project ${p.name}`, `Its folder ${path} is missing${inDocker ? ' inside the container' : ''}.`, inDocker ? 'Mount that folder (under PROJECTS_DIR), or change the path on the project\'s Connectors tab.' : 'Restore the folder or change the path on the project\'s Connectors tab.'));
  }
  const workers = d.store.listAgents().filter((a) => a.role === 'worker');
  checks.push(workers.length ? ok('workers', 'Workers', `${workers.length} worker${workers.length === 1 ? '' : 's'}.`) : warn('workers', 'Workers', 'There are no workers, so no ticket can be started.', 'Add one on the Workers page.'));

  for (const p of listProviders(d.store)) {
    const label = `AI provider ${p.name}`;
    if (p.kind === 'claude') {
      const login = claudeLoginStatus();
      const key = p.apiKeySecret ? !!d.secrets.get(p.apiKeySecret) : false;
      checks.push(key || login.valid ? ok(`provider_${p.id}`, label, key ? 'API key saved.' : login.message) : warn(`provider_${p.id}`, label, 'No API key and no valid Claude Code login.', 'Add an Anthropic API key in Settings → AI providers, or log in to Claude Code.'));
    } else if (p.kind === 'cli') {
      const cmd = p.cli?.command ?? '';
      checks.push(cliInstalled(cmd) ? ok(`provider_${p.id}`, label, `${cmd} is installed.`) : warn(`provider_${p.id}`, label, `${cmd} is not installed${inDocker ? ' in the container' : ''}.`, inDocker ? 'Add it to EXTRA_NPM_CLIS in .env and rebuild.' : `Install ${cmd}.`));
    } else {
      try {
        const models = await within(listModels(p, p.apiKeySecret ? d.secrets.get(p.apiKeySecret) : undefined), 5000);
        checks.push(ok(`provider_${p.id}`, label, `Reachable, ${models.length} model${models.length === 1 ? '' : 's'}.`));
      } catch (e) {
        const local = /localhost|127\.0\.0\.1/.test(p.baseUrl);
        checks.push(warn(`provider_${p.id}`, label, `${p.baseUrl} can't be reached (${(e as Error).message}).`, inDocker && local ? 'From the container, localhost is the container itself: use host networking (docker-compose.local-ai.yml) or host.docker.internal.' : 'Check that it is running and that the base URL is right.'));
      }
    }
  }
  return checks;
}

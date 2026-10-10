import type { Project } from '../../types.js';
import type { SecretStore } from '../../secrets.js';
import { GitHubCodeHost } from './github.js';
import { LocalCodeHost } from './local.js';
import type { CodeHostAdapter } from './types.js';

export type { CodeHostAdapter } from './types.js';

export function codeHostFor(project: Project, secrets: SecretStore, reposDir: string): CodeHostAdapter {
  switch (project.codeHost.provider) {
    case 'github':
      return new GitHubCodeHost(() => secrets.get('GITHUB_TOKEN'), reposDir);
    case 'local':
      return new LocalCodeHost();
    default:
      throw new Error(`Code host "${(project.codeHost as { provider: string }).provider}" is not supported yet.`);
  }
}

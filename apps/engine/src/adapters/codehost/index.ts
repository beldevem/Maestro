import type { Project } from '../../types.js';
import type { SecretStore } from '../../secrets.js';
import { BitbucketCodeHost } from './bitbucket.js';
import { GitHubCodeHost } from './github.js';
import { GitLabCodeHost } from './gitlab.js';
import { LocalCodeHost } from './local.js';
import type { CodeHostAdapter } from './types.js';

export type { CodeHostAdapter } from './types.js';

/** What is missing to push and open pull requests for this project, or null. Checked before any agent work. */
export function missingCredentials(project: Project, secrets: SecretStore): string | null {
  switch (project.codeHost.provider) {
    case 'github':
      return secrets.get('GITHUB_TOKEN') ? null : 'Add a GitHub token in Settings first: the run would end without a pull request.';
    case 'gitlab':
      return secrets.get('GITLAB_TOKEN') ? null : 'Add a GitLab token in Settings first: the run would end without a merge request.';
    case 'bitbucket':
      return secrets.get('BITBUCKET_USERNAME') && secrets.get('BITBUCKET_APP_PASSWORD')
        ? null
        : 'Add your Bitbucket username and app password in Settings first: the run would end without a pull request.';
    default:
      return null;
  }
}

export function codeHostFor(project: Project, secrets: SecretStore, reposDir: string): CodeHostAdapter {
  switch (project.codeHost.provider) {
    case 'github':
      return new GitHubCodeHost(() => secrets.get('GITHUB_TOKEN'), reposDir);
    case 'gitlab':
      return new GitLabCodeHost(() => secrets.get('GITLAB_TOKEN'), reposDir);
    case 'bitbucket':
      return new BitbucketCodeHost(() => {
        const user = secrets.get('BITBUCKET_USERNAME');
        const secret = secrets.get('BITBUCKET_APP_PASSWORD');
        return user && secret ? { user, secret } : undefined;
      }, reposDir);
    case 'local':
      return new LocalCodeHost();
    default:
      throw new Error(`Code host "${(project.codeHost as { provider: string }).provider}" is not supported yet.`);
  }
}

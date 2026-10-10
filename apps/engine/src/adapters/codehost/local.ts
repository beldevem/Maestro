import { existsSync } from 'node:fs';
import { git } from '../../proc.js';
import type { Project } from '../../types.js';
import type { CodeHostAdapter, PullRequestRef } from './types.js';

/**
 * A plain git repository on this machine. Branches stay local and you review the diff in Maestro.
 * If the repo has an `origin` remote and `pushLocalBranches` is on, branches are pushed there too.
 */
export class LocalCodeHost implements CodeHostAdapter {
  readonly provider = 'local';

  async ensureRepo(project: Project): Promise<string> {
    const path = project.codeHost.localPath;
    if (!path) throw new Error('This project has no local folder set.');
    if (!existsSync(path)) throw new Error(`Folder not found: ${path}`);
    await git(path, ['rev-parse', '--git-dir']).catch(() => {
      throw new Error(`${path} is not a git repository. Run "git init" there and make a first commit.`);
    });
    return path;
  }

  async syncBase(repoPath: string, base: string): Promise<void> {
    const remotes = await git(repoPath, ['remote']);
    if (remotes.split('\n').includes('origin')) {
      await git(repoPath, ['fetch', 'origin', base]).catch(() => undefined);
    }
  }

  async pushBranch(): Promise<void> {
    // Local projects keep branches local.
  }

  async openPullRequest(): Promise<PullRequestRef> {
    return { url: null, number: null };
  }
}

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Folders the folder picker may show: MAESTRO_BROWSE_ROOTS (comma separated), else your home folder. */
export function browseRoots(env = process.env): string[] {
  const listed = (env.MAESTRO_BROWSE_ROOTS ?? '').split(',').map((r) => r.trim()).filter(Boolean);
  const roots = (listed.length ? listed : [homedir()]).filter((r) => existsSync(r)).map((r) => realpathSync(r));
  return [...new Set(roots)];
}

const MAX_ENTRIES = 500;

export interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  hasPackageJson: boolean;
  hidden: boolean;
}

export interface DirListing {
  /** '' when listing the roots themselves. */
  path: string;
  parent: string | null;
  roots: string[];
  crumbs: { name: string; path: string }[];
  dirs: DirEntry[];
  isGitRepo: boolean;
  /** The checked-out branch when `path` is a git repository. */
  branch: string | null;
  truncated: boolean;
}

export class OutsideRootsError extends Error {
  statusCode = 403;
  constructor(path: string, roots: string[]) {
    super(
      `${path} is outside the folders Maestro can see (${roots.join(', ')}). ` +
        'In Docker, put the repository under PROJECTS_DIR or mount its folder in docker-compose.override.yml and add it to MAESTRO_BROWSE_ROOTS.',
    );
  }
}

const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** The real path of `p` (symlinks followed), or an error when it is missing or outside every root. */
export function resolveInRoots(p: string, roots: string[]): string {
  if (!isAbsolute(p)) throw Object.assign(new Error('Give an absolute folder path.'), { statusCode: 400 });
  const abs = resolve(p);
  if (!existsSync(abs)) throw Object.assign(new Error(`${abs} does not exist (or Maestro can't see it).`), { statusCode: 404 });
  const real = realpathSync(abs);
  if (!roots.some((r) => inside(r, real))) throw new OutsideRootsError(abs, roots);
  if (!statSync(real).isDirectory()) throw Object.assign(new Error(`${abs} is not a folder.`), { statusCode: 400 });
  return real;
}

const isGitRepo = (dir: string) => existsSync(join(dir, '.git'));

/** The branch checked out in a repository, read from .git/HEAD (no git process). */
export function currentBranch(dir: string): string | null {
  try {
    let gitDir = join(dir, '.git');
    if (statSync(gitDir).isFile()) gitDir = resolve(dir, readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim());
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null;
  } catch {
    return null;
  }
}

/** Subfolders of `path` (never files), or the roots when no path is given. */
export function listDirs(path: string | undefined, opts: { hidden?: boolean; roots?: string[] } = {}): DirListing {
  const roots = opts.roots ?? browseRoots();
  if (!roots.length) throw Object.assign(new Error('No folders to browse: set MAESTRO_BROWSE_ROOTS.'), { statusCode: 404 });
  if (!path && roots.length > 1) {
    return {
      path: '', parent: null, roots, crumbs: [], isGitRepo: false, branch: null, truncated: false,
      dirs: roots.map((r) => ({ name: r, path: r, isGitRepo: isGitRepo(r), hasPackageJson: existsSync(join(r, 'package.json')), hidden: false })),
    };
  }
  const dir = resolveInRoots(path || roots[0], roots);
  const root = roots.find((r) => inside(r, dir))!;
  const names: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!opts.hidden && e.name.startsWith('.')) continue;
    if (e.isDirectory()) names.push(e.name);
    else if (e.isSymbolicLink()) {
      // A link counts only when it points to a folder inside the roots.
      try {
        const real = realpathSync(join(dir, e.name));
        if (statSync(real).isDirectory() && roots.some((r) => inside(r, real))) names.push(e.name);
      } catch {
        // A broken link is skipped.
      }
    }
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  const dirs = names.slice(0, MAX_ENTRIES).map((name) => {
    const p = join(dir, name);
    return { name, path: p, isGitRepo: isGitRepo(p), hasPackageJson: existsSync(join(p, 'package.json')), hidden: name.startsWith('.') };
  });
  const crumbs: DirListing['crumbs'] = [];
  for (let p = dir; ; p = dirname(p)) {
    crumbs.unshift({ name: p === root ? root : basename(p), path: p });
    if (p === root || dirname(p) === p) break;
  }
  return {
    path: dir,
    parent: dir === root ? (roots.length > 1 ? '' : null) : dirname(dir),
    roots,
    crumbs,
    dirs,
    isGitRepo: isGitRepo(dir),
    branch: isGitRepo(dir) ? currentBranch(dir) : null,
    truncated: names.length > MAX_ENTRIES,
  };
}

/** What the project form needs to know about a typed or picked folder. */
export function checkFolder(path: string, roots = browseRoots()): { path: string; isGitRepo: boolean; branch: string | null } {
  const dir = resolveInRoots(path, roots);
  return { path: dir, isGitRepo: isGitRepo(dir), branch: isGitRepo(dir) ? currentBranch(dir) : null };
}



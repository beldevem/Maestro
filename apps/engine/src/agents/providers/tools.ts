import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { run, tail } from '../../proc.js';

/** What a model may do in the worktree, from the same allowlist the Claude agents get. */
export interface Allowed {
  read: boolean;
  write: boolean;
  edit: boolean;
  glob: boolean;
  grep: boolean;
  /** Command prefixes from Bash(<prefix>:*) entries. */
  commands: string[];
}

export function parseAllowed(allowedTools: string[]): Allowed {
  const has = (n: string) => allowedTools.includes(n);
  return {
    read: has('Read'),
    write: has('Write'),
    edit: has('Edit') || has('MultiEdit'),
    glob: has('Glob'),
    grep: has('Grep'),
    commands: allowedTools.map((t) => /^Bash\((.+):\*\)$/.exec(t)?.[1]?.trim()).filter((c): c is string => !!c),
  };
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.maestro-sessions', 'dist', '.angular', 'coverage', '__pycache__', '.venv']);
const MAX_READ = 60_000;
const MAX_OUTPUT = 8_000;
const MAX_LIST = 400;

export class ToolError extends Error {}

/** A path inside the worktree, refusing anything that resolves outside it (including through symlinks). */
export function inside(root: string, p: string): string {
  if (!p || typeof p !== 'string') throw new ToolError('A path is required.');
  const base = realpathSync(root);
  const full = resolve(base, p);
  const check = (x: string) => x === base || x.startsWith(base + sep);
  if (!check(full)) throw new ToolError(`${p} is outside the worktree.`);
  // The nearest existing ancestor must also be inside after following symlinks.
  let probe = full;
  while (!existsSync(probe)) probe = dirname(probe);
  if (!check(realpathSync(probe))) throw new ToolError(`${p} is outside the worktree.`);
  return full;
}

function walk(root: string, out: string[] = [], dir = root): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= 5000) break;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, out, join(dir, e.name));
    } else if (e.isFile()) out.push(relative(root, join(dir, e.name)));
  }
  return out;
}

/** Glob to a regex: ** spans folders, * and ? stay within one. */
export function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}

/** Refuses commands outside the allowlist, and any chaining, redirection or substitution. */
export function checkCommand(command: string, allowed: string[]): string | null {
  const cmd = command.trim();
  if (!cmd) return 'Empty command.';
  if (/[;&|`<>\n\r]|\$\(/.test(cmd)) return 'Chaining, pipes, redirection and substitution are not allowed; run one command at a time.';
  const ok = allowed.some((p) => cmd === p || cmd.startsWith(`${p} `));
  return ok ? null : `Not allowed. Commands must start with one of: ${allowed.join(', ') || '(none)'}.`;
}

export interface ToolContext {
  cwd: string;
  allowed: Allowed;
  signal?: AbortSignal;
  commandTimeoutMs: number;
}

/** OpenAI-style function definitions for what is allowed. */
export function toolDefinitions(a: Allowed): object[] {
  const fn = (name: string, description: string, properties: Record<string, object>, required: string[]) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
  });
  const str = (description: string) => ({ type: 'string', description });
  const tools: object[] = [];
  if (a.read) tools.push(fn('read_file', 'Read a text file in the repository. Paths are relative to the repository root.', { path: str('File path'), offset: { type: 'integer', description: 'First line (1-based), optional' }, limit: { type: 'integer', description: 'Number of lines, optional' } }, ['path']));
  if (a.glob) tools.push(fn('list_files', 'List files matching a glob such as "src/**/*.ts" (node_modules and .git are skipped).', { pattern: str('Glob pattern') }, ['pattern']));
  if (a.grep) tools.push(fn('grep', 'Search file contents with a regular expression. Returns file:line: text.', { pattern: str('Regular expression'), glob: str('Optional glob to limit the files') }, ['pattern']));
  if (a.write) tools.push(fn('write_file', 'Create or overwrite a file with the given content.', { path: str('File path'), content: str('Full file content') }, ['path', 'content']));
  if (a.edit) tools.push(fn('edit_file', 'Replace an exact piece of text in a file. old_string must appear exactly once unless replace_all is true.', { path: str('File path'), old_string: str('Exact text to replace'), new_string: str('Replacement text'), replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']));
  if (a.commands.length) tools.push(fn('run_command', `Run one shell command in the repository root. Allowed commands start with: ${a.commands.join(', ')}. No pipes, chaining or redirection.`, { command: str('The command') }, ['command']));
  return tools;
}

/** Runs one tool call and returns what the model sees (errors included, as text). */
export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const { cwd, allowed } = ctx;
  try {
    switch (name) {
      case 'read_file': {
        if (!allowed.read) throw new ToolError('Reading files is not allowed here.');
        const file = inside(cwd, String(args.path));
        if (!existsSync(file) || !statSync(file).isFile()) throw new ToolError(`${args.path} does not exist.`);
        const lines = readFileSync(file, 'utf8').split('\n');
        const start = Math.max(1, Number(args.offset) || 1);
        const end = args.limit ? start - 1 + Number(args.limit) : lines.length;
        const text = lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join('\n');
        return text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n…(cut; read with offset and limit)` : text || '(empty file)';
      }
      case 'list_files': {
        if (!allowed.glob) throw new ToolError('Listing files is not allowed here.');
        const re = globToRegex(String(args.pattern || '**/*'));
        const files = walk(realpathSync(cwd)).filter((f) => re.test(f.split(sep).join('/')));
        return files.length ? `${files.slice(0, MAX_LIST).join('\n')}${files.length > MAX_LIST ? `\n…and ${files.length - MAX_LIST} more` : ''}` : 'No files match.';
      }
      case 'grep': {
        if (!allowed.grep) throw new ToolError('Searching is not allowed here.');
        let re: RegExp;
        try {
          re = new RegExp(String(args.pattern));
        } catch {
          throw new ToolError('That is not a valid regular expression.');
        }
        const only = args.glob ? globToRegex(String(args.glob)) : null;
        const hits: string[] = [];
        for (const f of walk(realpathSync(cwd))) {
          if (only && !only.test(f.split(sep).join('/'))) continue;
          const full = join(cwd, f);
          if (statSync(full).size > 2_000_000) continue;
          readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
            if (hits.length < 200 && re.test(line)) hits.push(`${f}:${i + 1}: ${line.slice(0, 300)}`);
          });
        }
        return hits.length ? hits.join('\n') : 'No matches.';
      }
      case 'write_file': {
        if (!allowed.write) throw new ToolError('Writing files is not allowed here.');
        const file = inside(cwd, String(args.path));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, String(args.content ?? ''));
        return `Wrote ${args.path}.`;
      }
      case 'edit_file': {
        if (!allowed.edit) throw new ToolError('Editing files is not allowed here.');
        const file = inside(cwd, String(args.path));
        if (!existsSync(file)) throw new ToolError(`${args.path} does not exist.`);
        const text = readFileSync(file, 'utf8');
        const oldS = String(args.old_string ?? '');
        if (!oldS) throw new ToolError('old_string is empty.');
        const count = text.split(oldS).length - 1;
        if (count === 0) throw new ToolError('old_string was not found; read the file and copy the text exactly.');
        if (count > 1 && !args.replace_all) throw new ToolError(`old_string appears ${count} times; add more context or set replace_all.`);
        writeFileSync(file, args.replace_all ? text.split(oldS).join(String(args.new_string ?? '')) : text.replace(oldS, () => String(args.new_string ?? '')));
        return `Edited ${args.path}.`;
      }
      case 'run_command': {
        const command = String(args.command ?? '');
        const refused = checkCommand(command, allowed.commands);
        if (refused) throw new ToolError(refused);
        const res = await run(command, [], { cwd, shell: true, timeoutMs: ctx.commandTimeoutMs, signal: ctx.signal, env: { CI: 'true' } });
        return `exit code ${res.timedOut ? 'timeout' : res.code}\n${tail(res.output, MAX_OUTPUT)}`;
      }
      default:
        throw new ToolError(`There is no tool called ${name}.`);
    }
  } catch (e) {
    if (e instanceof ToolError) return `Error: ${e.message}`;
    return `Error: ${(e as Error).message}`;
  }
}

import { spawn } from 'node:child_process';

export interface ProcResult {
  code: number;
  output: string;
  timedOut: boolean;
}

/** Run a command and capture combined output. `shell` runs the string through the system shell. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; shell?: boolean; signal?: AbortSignal } ,
): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: opts.shell ?? false,
      signal: opts.signal,
    });
    let output = '';
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', (err) => {
      output += `\n${err.message}`;
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, output, timedOut });
    });
  });
}

export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const res = await run('git', args, { cwd, env });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed:\n${res.output.trim()}`);
  return res.output.trim();
}

export function tail(text: string, maxChars = 6000): string {
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}

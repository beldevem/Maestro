import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { run, tail } from './proc.js';
import type { Workflow } from './workflow.js';

export interface GateResult {
  name: string;
  command: string;
  passed: boolean;
  output: string;
  durationMs: number;
}

export interface GateOptions {
  /** The docker CLI, for tests. */
  dockerBin?: string;
}

/**
 * `docker run` arguments for one gate: the worktree mounted at /work, the repository's git folder
 * mounted read-only at its own path (so git works inside), and your user id so files stay yours.
 */
export function dockerArgs(wf: Workflow, cwd: string, command: string, name: string, gitCommonDir?: string): string[] {
  const { uid, gid } = userInfo();
  return [
    'run', '--rm', '--name', name,
    '-v', `${cwd}:/work`, '-w', '/work',
    ...(gitCommonDir ? ['-v', `${gitCommonDir}:${gitCommonDir}:ro`] : []),
    ...(uid >= 0 ? ['--user', `${uid}:${gid}`] : []),
    '-e', 'CI=true', '-e', 'HOME=/tmp',
    ...(wf.sandbox.network ? [] : ['--network', 'none']),
    wf.sandbox.image, 'sh', '-c', command,
  ];
}

/** Run the project's quality gates in order (in a container when the workflow says so); stops at the first failure. */
export async function runGates(
  wf: Workflow,
  cwd: string,
  onGate?: (r: GateResult) => void,
  signal?: AbortSignal,
  opts: GateOptions = {},
): Promise<{ passed: boolean; results: GateResult[] }> {
  const results: GateResult[] = [];
  const docker = opts.dockerBin ?? 'docker';
  const sandboxed = wf.sandbox.type === 'docker';
  let gitCommonDir: string | undefined;

  if (sandboxed && wf.quality_gates.length) {
    const check = await run(docker, ['version', '--format', '{{.Server.Version}}'], { cwd, timeoutMs: 15_000 });
    if (check.code !== 0) {
      const result: GateResult = {
        name: wf.quality_gates[0].name, command: wf.quality_gates[0].run, passed: false, durationMs: 0,
        output: `The workflow runs gates in Docker, but Docker is not available:\n${tail(check.output, 1000)}`,
      };
      onGate?.(result);
      return { passed: false, results: [result] };
    }
    const common = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
    if (common.code === 0) gitCommonDir = common.output.trim();
  }

  for (const gate of wf.quality_gates) {
    const started = Date.now();
    const name = `maestro-gate-${randomUUID().slice(0, 8)}`;
    const timeoutMs = wf.gate_timeout_minutes * 60_000;
    const res = sandboxed
      ? await run(docker, dockerArgs(wf, cwd, gate.run, name, gitCommonDir), { cwd, timeoutMs, signal })
      : await run(gate.run, [], { cwd, shell: true, timeoutMs, signal, env: { CI: 'true' } });
    // Stopping the docker CLI does not always stop the container.
    if (sandboxed && (res.timedOut || signal?.aborted)) await run(docker, ['kill', name], { cwd, timeoutMs: 15_000 });
    const result: GateResult = {
      name: gate.name,
      command: gate.run,
      passed: res.code === 0 && !res.timedOut,
      output: tail(res.timedOut ? `${res.output}\nTimed out after ${wf.gate_timeout_minutes} minutes.` : res.output),
      durationMs: Date.now() - started,
    };
    results.push(result);
    onGate?.(result);
    if (!result.passed) return { passed: false, results };
  }
  return { passed: true, results };
}

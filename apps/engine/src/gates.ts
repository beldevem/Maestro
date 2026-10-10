import { run, tail } from './proc.js';
import type { Workflow } from './workflow.js';

export interface GateResult {
  name: string;
  command: string;
  passed: boolean;
  output: string;
  durationMs: number;
}

/** Run the project's quality gates in order; stops at the first failure. */
export async function runGates(
  wf: Workflow,
  cwd: string,
  onGate?: (r: GateResult) => void,
  signal?: AbortSignal,
): Promise<{ passed: boolean; results: GateResult[] }> {
  const results: GateResult[] = [];
  for (const gate of wf.quality_gates) {
    const started = Date.now();
    const res = await run(gate.run, [], { cwd, shell: true, timeoutMs: wf.gate_timeout_minutes * 60_000, signal, env: { CI: 'true' } });
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

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dockerArgs, runGates } from '../src/gates.js';
import { git } from '../src/proc.js';
import { parseWorkflow } from '../src/workflow.js';

/** Logs each call; `run` executes the `sh -c` command here (in the cwd) like a container would in /work. */
function fakeDocker(home: string, opts: { down?: boolean } = {}): { bin: string; calls: () => string[][] } {
  const log = join(home, 'docker.log');
  writeFileSync(log, '');
  const bin = join(home, 'docker');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
${opts.down ? "if (args[0] === 'version') { process.stderr.write('Cannot connect to the Docker daemon'); process.exit(1); }" : ''}
if (args[0] === 'run') {
  const r = require('child_process').spawnSync('sh', ['-c', args[args.length - 1]], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

const sandboxed = (extra = '') => parseWorkflow(`quality_gates:
  - name: has-readme
    run: test -f README.md
  - name: fails
    run: exit 3
sandbox:
  type: docker
  image: node:24-slim
${extra}`);

describe('docker sandbox', () => {
  it('is off by default', () => {
    expect(parseWorkflow('base_branch: main').sandbox).toEqual({ type: 'none', image: 'node:24', network: true });
  });

  it('builds a container run with the worktree, git folder and your user', () => {
    const { uid, gid } = userInfo();
    const args = dockerArgs(sandboxed('  network: false'), '/wt/run1', 'npm test', 'maestro-gate-x', '/repo/.git');
    expect(args).toEqual([
      'run', '--rm', '--name', 'maestro-gate-x', '-v', '/wt/run1:/work', '-w', '/work', '-v', '/repo/.git:/repo/.git:ro',
      '--user', `${uid}:${gid}`, '-e', 'CI=true', '-e', 'HOME=/tmp', '--network', 'none', 'node:24-slim', 'sh', '-c', 'npm test',
    ]);
  });

  it('runs each gate through docker and stops at the first failure', async () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-sandbox-'));
    const repo = join(home, 'app');
    mkdirSync(repo);
    await git(repo, ['init', '-b', 'main']);
    writeFileSync(join(repo, 'README.md'), '# app\n');
    const docker = fakeDocker(home);
    const res = await runGates(sandboxed(), repo, undefined, undefined, { dockerBin: docker.bin });
    expect(res.passed).toBe(false);
    expect(res.results.map((r) => [r.name, r.passed])).toEqual([['has-readme', true], ['fails', false]]);
    const runs = docker.calls().filter((c) => c[0] === 'run');
    expect(runs).toHaveLength(2);
    expect(runs[0]).toContain(`${repo}:/work`);
    expect(runs[0]).toContain(`${join(repo, '.git')}:${join(repo, '.git')}:ro`);
    expect(runs[0].slice(-4)).toEqual(['node:24-slim', 'sh', '-c', 'test -f README.md']);
  });

  it('fails clearly when Docker is not available', async () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-sandbox-'));
    const docker = fakeDocker(home, { down: true });
    const res = await runGates(sandboxed(), home, undefined, undefined, { dockerBin: docker.bin });
    expect(res.passed).toBe(false);
    expect(res.results[0].output).toContain('Docker is not available');
    expect(res.results[0].output).toContain('Cannot connect to the Docker daemon');
    expect(docker.calls().some((c) => c[0] === 'run')).toBe(false);
  });
});

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretStore } from '../src/secrets.js';

/** A stand-in for libsecret's secret-tool: one file per secret name in `dir`. */
function fakeSecretTool(home: string, opts: { broken?: boolean } = {}): string {
  const dir = join(home, 'keyring');
  mkdirSync(dir, { recursive: true });
  const bin = join(home, 'secret-tool');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const dir = ${JSON.stringify(dir)};
const [cmd, ...rest] = process.argv.slice(2);
${opts.broken ? "process.stderr.write('Cannot autolaunch D-Bus without X11'); process.exit(1);" : ''}
const args = rest.filter((a) => !a.startsWith('--'));
const attrs = {};
for (let i = 0; i + 1 < args.length; i += 2) attrs[args[i]] = args[i + 1];
const file = attrs.name && path.join(dir, attrs.name);
if (cmd === 'lookup') { if (fs.existsSync(file)) process.stdout.write(fs.readFileSync(file, 'utf8')); else process.exit(1); }
else if (cmd === 'store') { fs.writeFileSync(file, fs.readFileSync(0, 'utf8')); }
else if (cmd === 'clear') { if (fs.existsSync(file)) fs.unlinkSync(file); }
else if (cmd === 'search') { for (const n of fs.readdirSync(dir)) process.stdout.write('[/' + n + ']\\nlabel = Maestro: ' + n + '\\nattribute.service = maestro\\nattribute.name = ' + n + '\\n'); }
`);
  chmodSync(bin, 0o755);
  return bin;
}

describe('secrets', () => {
  it('keeps secrets in a file readable only by you when there is no keychain', () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-secrets-'));
    const file = join(home, 'secrets.json');
    const s = new SecretStore(file, { backend: 'auto', secretTool: join(home, 'missing-secret-tool') });
    expect(s.kind).toBe('file');
    s.set('GITHUB_TOKEN', 'ghp_1');
    expect(s.get('GITHUB_TOKEN')).toBe('ghp_1');
    expect(s.names()).toEqual(['GITHUB_TOKEN']);
    expect((statSync(file).mode & 0o777).toString(8)).toBe('600');
  });

  it('falls back to the file when secret-tool cannot reach a keychain', () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-secrets-'));
    const s = new SecretStore(join(home, 'secrets.json'), { backend: 'auto', secretTool: fakeSecretTool(home, { broken: true }) });
    expect(s.kind).toBe('file');
  });

  it('uses the keychain through secret-tool when it works', () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-secrets-'));
    const s = new SecretStore(join(home, 'secrets.json'), { backend: 'auto', secretTool: fakeSecretTool(home) });
    expect(s.kind).toBe('keychain');
    s.set('FIGMA_TOKEN', 'figd_multi\nline');
    expect(readFileSync(join(home, 'keyring', 'FIGMA_TOKEN'), 'utf8')).toBe('figd_multi\nline');
    expect(s.get('FIGMA_TOKEN')).toBe('figd_multi\nline');
    expect(s.names()).toEqual(['FIGMA_TOKEN']);
    s.delete('FIGMA_TOKEN');
    expect(s.get('FIGMA_TOKEN')).toBeUndefined();
    expect(s.names()).toEqual([]);
    expect(existsSync(join(home, 'secrets.json'))).toBe(false);
  });

  it('moves secrets.json into the keychain once and removes the file', () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-secrets-'));
    const file = join(home, 'secrets.json');
    writeFileSync(file, JSON.stringify({ GITHUB_TOKEN: 'ghp_old', JIRA_API_TOKEN: 'atl' }));
    const bin = fakeSecretTool(home);
    const s = new SecretStore(file, { backend: 'auto', secretTool: bin });
    expect(s.migrated.sort()).toEqual(['GITHUB_TOKEN', 'JIRA_API_TOKEN']);
    expect(existsSync(file)).toBe(false);
    expect(s.get('GITHUB_TOKEN')).toBe('ghp_old');
    expect(new SecretStore(file, { backend: 'auto', secretTool: bin }).migrated).toEqual([]);
  });

  it('lets environment variables win', () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-secrets-'));
    const s = new SecretStore(join(home, 'secrets.json'));
    s.set('MAESTRO_TEST_SECRET', 'stored');
    process.env.MAESTRO_TEST_SECRET = 'from-env';
    try {
      expect(s.get('MAESTRO_TEST_SECRET')).toBe('from-env');
    } finally {
      delete process.env.MAESTRO_TEST_SECRET;
    }
  });
});

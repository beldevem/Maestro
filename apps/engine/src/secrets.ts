import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/** Where secret values are kept. */
interface SecretBackend {
  readonly kind: 'keychain' | 'file';
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
  names(): string[];
}

/** A JSON file readable only by you (mode 600). The fallback when there is no keychain. */
class FileBackend implements SecretBackend {
  readonly kind = 'file';
  constructor(private readonly file: string) {}

  read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    return JSON.parse(readFileSync(this.file, 'utf8'));
  }
  write(data: Record<string, string>): void {
    writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
  get(name: string): string | undefined {
    return this.read()[name];
  }
  set(name: string, value: string): void {
    this.write({ ...this.read(), [name]: value });
  }
  delete(name: string): void {
    const data = this.read();
    delete data[name];
    this.write(data);
  }
  names(): string[] {
    return Object.keys(this.read());
  }
}

/**
 * The desktop keychain (GNOME Keyring, KWallet via the Secret Service) through libsecret's `secret-tool`,
 * so no native npm module is needed. Values are cached in memory after the first read.
 */
class SecretToolBackend implements SecretBackend {
  readonly kind = 'keychain';
  private readonly cache = new Map<string, string | undefined>();
  private nameList: string[] | null = null;

  constructor(private readonly bin: string) {}

  private run(args: string[], input?: string): { code: number; out: string; err: string } {
    const res = spawnSync(this.bin, args, { input, encoding: 'utf8', timeout: 10_000 });
    if (res.error) throw new Error(`secret-tool failed: ${res.error.message}`);
    return { code: res.status ?? 1, out: res.stdout ?? '', err: res.stderr ?? '' };
  }

  get(name: string): string | undefined {
    if (this.cache.has(name)) return this.cache.get(name);
    const res = this.run(['lookup', 'service', 'maestro', 'name', name]);
    const value = res.code === 0 && res.out ? res.out.replace(/\n$/, '') : undefined;
    this.cache.set(name, value);
    return value;
  }
  set(name: string, value: string): void {
    const res = this.run(['store', `--label=Maestro: ${name}`, 'service', 'maestro', 'name', name], value);
    if (res.code !== 0) throw new Error(`Could not save ${name} in the keychain: ${res.err.trim() || `exit ${res.code}`}`);
    this.cache.set(name, value);
    this.nameList = null;
  }
  delete(name: string): void {
    this.run(['clear', 'service', 'maestro', 'name', name]);
    this.cache.set(name, undefined);
    this.nameList = null;
  }
  names(): string[] {
    if (!this.nameList) {
      const res = this.run(['search', '--all', 'service', 'maestro']);
      const text = `${res.out}\n${res.err}`;
      this.nameList = [...new Set([...text.matchAll(/^attribute\.name = (.+)$/gm)].map((m) => m[1].trim()))];
    }
    return this.nameList;
  }

  /** True when secret-tool runs and can reach a keychain (a lookup of a missing key exits 1 quietly). */
  static usable(bin: string): boolean {
    const res = spawnSync(bin, ['lookup', 'service', 'maestro', 'name', '__maestro_probe__'], { encoding: 'utf8', timeout: 10_000 });
    return !res.error && (res.status === 0 || res.status === 1) && !/error|cannot|failed/i.test(res.stderr ?? '');
  }
}

export interface SecretStoreOptions {
  /** auto picks the keychain when secret-tool works; MAESTRO_SECRETS=file|keychain overrides. */
  backend?: 'auto' | 'keychain' | 'file';
  secretTool?: string;
}

/**
 * Secrets for connectors. Values never leave the engine through the API; only names are listed.
 * Environment variables with the same name win over stored values.
 */
export class SecretStore {
  private readonly backend: SecretBackend;
  /** Set when stored secrets were moved from the file into the keychain on startup. */
  readonly migrated: string[] = [];

  constructor(private readonly file: string, opts: SecretStoreOptions = {}) {
    const want = opts.backend ?? 'file';
    const bin = opts.secretTool ?? 'secret-tool';
    const keychain = want === 'keychain' || (want === 'auto' && SecretToolBackend.usable(bin));
    this.backend = keychain ? new SecretToolBackend(bin) : new FileBackend(file);
    if (keychain) this.migrated = this.migrateFromFile();
  }

  /** Picks the keychain when available, unless MAESTRO_SECRETS says otherwise. */
  static open(file: string): SecretStore {
    const env = process.env.MAESTRO_SECRETS;
    return new SecretStore(file, { backend: env === 'file' || env === 'keychain' ? env : 'auto' });
  }

  get kind(): 'keychain' | 'file' {
    return this.backend.kind;
  }

  /** One-time move of secrets.json into the keychain: each value is read back before it leaves the file. */
  private migrateFromFile(): string[] {
    const file = new FileBackend(this.file);
    const data = file.read();
    const moved: string[] = [];
    for (const [name, value] of Object.entries(data)) {
      this.backend.set(name, value);
      if (this.backend.get(name) === value) {
        moved.push(name);
        delete data[name];
      }
    }
    if (!moved.length) return [];
    if (Object.keys(data).length) file.write(data);
    else unlinkSync(this.file);
    return moved;
  }

  /** An empty environment variable (as docker compose passes an unset one) counts as unset. */
  get(name: string): string | undefined {
    return process.env[name] || this.backend.get(name);
  }
  set(name: string, value: string): void {
    this.backend.set(name, value);
  }
  delete(name: string): void {
    this.backend.delete(name);
  }
  names(): string[] {
    return this.backend.names();
  }
}

/** Secrets the dashboard knows how to ask for. */
export const KNOWN_SECRETS = [
  { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', help: 'Optional if you are signed in to Claude Code on this machine.' },
  { name: 'GITHUB_TOKEN', label: 'GitHub token', help: 'Fine-grained token with Contents and Pull requests read/write.' },
  { name: 'GITLAB_TOKEN', label: 'GitLab token', help: 'Personal or project access token with the api and write_repository scopes.' },
  { name: 'BITBUCKET_USERNAME', label: 'Bitbucket username', help: 'Your Bitbucket username (not the email), used with the app password.' },
  { name: 'BITBUCKET_APP_PASSWORD', label: 'Bitbucket app password', help: 'With Repositories and Pull requests read and write.' },
  { name: 'JIRA_API_TOKEN', label: 'Atlassian API token', help: 'From id.atlassian.com, for Jira and Confluence, used with the email set on the project.' },
  { name: 'TRELLO_API_KEY', label: 'Trello API key', help: 'From trello.com/power-ups/admin.' },
  { name: 'TRELLO_TOKEN', label: 'Trello token', help: 'Generated for your API key.' },
  { name: 'FIGMA_TOKEN', label: 'Figma token', help: 'Personal access token, read-only use.' },
];

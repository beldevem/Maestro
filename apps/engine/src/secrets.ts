import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';

/**
 * MVP secret store: a JSON file readable only by you (mode 600) in ~/.maestro.
 * Values never leave the engine through the API; only names are listed.
 * Planned: move to the OS keychain.
 */
export class SecretStore {
  constructor(private readonly file: string) {}

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    return JSON.parse(readFileSync(this.file, 'utf8'));
  }
  private write(data: Record<string, string>): void {
    writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
  get(name: string): string | undefined {
    return process.env[name] ?? this.read()[name];
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

/** Secrets the dashboard knows how to ask for. */
export const KNOWN_SECRETS = [
  { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', help: 'Optional if you are signed in to Claude Code on this machine.' },
  { name: 'GITHUB_TOKEN', label: 'GitHub token', help: 'Fine-grained token with Contents and Pull requests read/write.' },
  { name: 'JIRA_API_TOKEN', label: 'Atlassian API token', help: 'From id.atlassian.com, for Jira and Confluence, used with the email set on the project.' },
  { name: 'TRELLO_API_KEY', label: 'Trello API key', help: 'From trello.com/power-ups/admin.' },
  { name: 'TRELLO_TOKEN', label: 'Trello token', help: 'Generated for your API key.' },
  { name: 'FIGMA_TOKEN', label: 'Figma token', help: 'Personal access token, read-only use.' },
];

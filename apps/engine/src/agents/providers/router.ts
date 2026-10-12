import type { Store } from '../../db.js';
import type { SecretStore } from '../../secrets.js';
import type { AgentOutcome, AgentTask, CodingAgent } from '../coding-agent.js';
import { CliAgent } from './cli.js';
import { getProvider } from './config.js';
import { OpenAICompatibleAgent } from './openai.js';

/**
 * The one CodingAgent the engine uses: it sends each task to the provider named on it (Claude by default),
 * so the orchestrator, gates, reviews, budgets and chat work the same whichever AI does the work.
 */
export class ProviderRouter implements CodingAgent {
  constructor(
    private readonly store: Store,
    private readonly secrets: SecretStore,
    private readonly sessionsDir: string,
    private readonly claude: CodingAgent,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async run(task: AgentTask): Promise<AgentOutcome> {
    const id = task.provider || 'claude';
    const cfg = getProvider(this.store, id);
    if (!cfg) return { sessionId: null, text: '', costUsd: 0, ok: false, error: `No AI provider called "${id}"; check Settings → AI providers.` };
    const key = cfg.apiKeySecret ? this.secrets.get(cfg.apiKeySecret) : undefined;
    switch (cfg.kind) {
      case 'claude':
        return this.claude.run({ ...task, env: { ...task.env, ...(key ? { ANTHROPIC_API_KEY: key } : {}) } });
      case 'openai':
        return new OpenAICompatibleAgent(cfg, key, this.sessionsDir, this.fetchImpl).run(task);
      case 'cli':
        return new CliAgent(cfg).run(task);
    }
  }
}

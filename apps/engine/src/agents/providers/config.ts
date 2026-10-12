import { z } from 'zod';
import type { Store } from '../../db.js';

/** The agent roles a provider and model can be chosen for. */
export const ROLES = ['worker', 'reviewer', 'planner', 'assistant'] as const;
export type Role = (typeof ROLES)[number];

const price = z.object({ input: z.number().min(0), output: z.number().min(0) });

export const providerSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'Use lowercase letters, digits and dashes.'),
  name: z.string().trim().min(1).max(60),
  /**
   * claude: the Claude Agent SDK (API key or the Claude Code login).
   * openai: any OpenAI-compatible chat completions API, driven by Maestro's own agent loop.
   * cli: a coding CLI run non-interactively in the worktree.
   */
  kind: z.enum(['claude', 'openai', 'cli']),
  /** openai: e.g. https://api.openai.com/v1 or http://localhost:11434/v1 */
  baseUrl: z.string().trim().default(''),
  /** Name of the secret holding the API key (optional for local servers). */
  apiKeySecret: z.string().trim().default(''),
  /** openai: how to ask for JSON when a role needs structured output. */
  structuredOutput: z.enum(['json_schema', 'json_object', 'prompt']).default('json_schema'),
  /** USD per million tokens, by model; "*" for any other model. Defaults to 0 (local models). */
  prices: z.record(z.string(), price).default({}),
  /** cli: the command and its argument template ({prompt}, {model} are filled in). */
  cli: z
    .object({
      preset: z.string().default('custom'),
      command: z.string().trim().min(1),
      args: z.array(z.string()).default([]),
      /** Added only when a model is chosen, e.g. ["--model", "{model}"]. */
      modelArgs: z.array(z.string()).default([]),
      timeoutMinutes: z.number().positive().default(30),
    })
    .optional(),
});
export type ProviderConfig = z.infer<typeof providerSchema>;

export const CLAUDE_PROVIDER: ProviderConfig = {
  id: 'claude', name: 'Claude', kind: 'claude', baseUrl: '', apiKeySecret: 'ANTHROPIC_API_KEY', structuredOutput: 'json_schema', prices: {},
};

/** The default models of the Claude provider, per role (what Maestro used before providers existed). */
const CLAUDE_DEFAULTS: Record<Role, string> = {
  worker: 'claude-sonnet-5-5', reviewer: 'claude-opus-5-5', planner: 'claude-opus-5-5', assistant: 'claude-sonnet-5-5',
};

export function listProviders(store: Store): ProviderConfig[] {
  const raw = store.getSetting('providers');
  if (!raw) return [CLAUDE_PROVIDER];
  try {
    return z.array(providerSchema).parse(JSON.parse(raw));
  } catch {
    return [CLAUDE_PROVIDER];
  }
}

export function getProvider(store: Store, id: string): ProviderConfig | undefined {
  return listProviders(store).find((p) => p.id === id);
}

export function saveProviders(store: Store, providers: ProviderConfig[]): void {
  store.setSetting('providers', JSON.stringify(providers));
}

/**
 * Installs from before providers existed: one "Claude" provider assigned to every role, keeping the models
 * that were set. Runs once; does nothing when providers are already configured.
 */
export function migrateProviders(store: Store): void {
  if (store.getSetting('providers')) return;
  saveProviders(store, [CLAUDE_PROVIDER]);
  for (const role of ROLES) if (!store.getSetting(`provider.${role}`)) store.setSetting(`provider.${role}`, 'claude');
}

export interface Choice {
  provider: string;
  model: string;
}

/** Per-project overrides, by role. */
export function projectRoles(store: Store, projectId: string): Partial<Record<Role, Choice>> {
  try {
    return JSON.parse(store.getSetting(`roles.${projectId}`) ?? '{}');
  } catch {
    return {};
  }
}

/**
 * Which provider and model a role uses: the worker's own choice, then the project's, then the default for the role.
 * A model left empty falls back to the next level, then to the Claude defaults when the provider is Claude.
 */
export function chooseModel(store: Store, role: Role, opts: { projectId?: string; agent?: { provider?: string; model?: string } } = {}): Choice {
  const project = opts.projectId ? projectRoles(store, opts.projectId)[role] : undefined;
  const provider = opts.agent?.provider || project?.provider || store.getSetting(`provider.${role}`) || 'claude';
  const sameAsRole = provider === (store.getSetting(`provider.${role}`) || 'claude');
  const model =
    opts.agent?.model ||
    (project?.provider === provider ? project.model : '') ||
    (sameAsRole ? store.getSetting(`model.${role}`) ?? '' : '') ||
    (provider === 'claude' ? CLAUDE_DEFAULTS[role] : '');
  return { provider, model };
}

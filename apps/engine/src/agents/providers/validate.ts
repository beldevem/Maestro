import type { ProviderConfig } from './config.js';
import { CLAUDE_MODELS } from './presets.js';

/**
 * Checks that `model` is one the provider offers. An empty model means "the provider's default"
 * and is always fine. CLIs accept whatever their own config allows, so they are not checked.
 * An OpenAI-compatible server is asked for its list; when it can't be reached the choice is kept,
 * since the server may simply be off right now.
 * Returns an error message, or '' when the choice is fine.
 */
export async function modelProblem(p: ProviderConfig, model: string, fetchModels: () => Promise<string[]>, timeoutMs = 4000): Promise<string> {
  const m = model.trim();
  if (!m || p.kind === 'cli') return '';
  if (p.kind === 'claude') return CLAUDE_MODELS.includes(m) ? '' : `${p.name} doesn't offer "${m}". Pick one of: ${CLAUDE_MODELS.join(', ')}.`;
  let models: string[];
  try {
    models = await Promise.race([
      fetchModels(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs).unref?.()),
    ]);
  } catch {
    return '';
  }
  if (models.length === 0 || models.includes(m)) return '';
  return `${p.name} doesn't offer "${m}". Available: ${models.slice(0, 8).join(', ')}${models.length > 8 ? ', …' : ''}.`;
}

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderConfig } from './config.js';

export interface OpenAIPreset {
  id: string;
  name: string;
  baseUrl: string;
  /** Where Maestro runs in Docker, local servers on the host are reached differently. */
  dockerBaseUrl?: string;
  needsKey: boolean;
  keyHint: string;
  structuredOutput: ProviderConfig['structuredOutput'];
}

/** OpenAI-compatible services Maestro knows how to set up. Any other works through "Custom". */
export const OPENAI_PRESETS: OpenAIPreset[] = [
  { id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', dockerBaseUrl: 'http://host.docker.internal:11434/v1', needsKey: false, keyHint: 'No key needed.', structuredOutput: 'json_schema' },
  { id: 'lmstudio', name: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', dockerBaseUrl: 'http://host.docker.internal:1234/v1', needsKey: false, keyHint: 'No key needed. Start the server in LM Studio (Developer tab).', structuredOutput: 'json_schema' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true, keyHint: 'An API key from platform.openai.com.', structuredOutput: 'json_schema' },
  { id: 'github-models', name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference', needsKey: true, keyHint: 'A GitHub token with the models:read permission. Model names look like openai/gpt-4.1.', structuredOutput: 'json_object' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, keyHint: 'An API key from openrouter.ai.', structuredOutput: 'json_schema' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true, keyHint: 'An API key from console.groq.com.', structuredOutput: 'json_object' },
  { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', needsKey: true, keyHint: 'An API key from console.mistral.ai.', structuredOutput: 'json_object' },
  { id: 'vllm', name: 'vLLM / llama.cpp server (local)', baseUrl: 'http://localhost:8000/v1', dockerBaseUrl: 'http://host.docker.internal:8000/v1', needsKey: false, keyHint: 'Usually no key.', structuredOutput: 'json_schema' },
  { id: 'custom', name: 'Other OpenAI-compatible API', baseUrl: '', needsKey: false, keyHint: 'Azure OpenAI, Together, Fireworks, DeepSeek... Base URL ends in /v1 for most.', structuredOutput: 'prompt' },
];

/** Claude models the Claude provider offers. */
export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'];

/** Whether the Claude Code login on this machine (or the container's shared one) is usable. Never reads out tokens. */
export function claudeLoginStatus(): { found: boolean; valid: boolean; message: string } {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const file = join(dir, '.credentials.json');
  if (!existsSync(file)) return { found: false, valid: false, message: 'No Claude Code login found. Run `claude`, then /login, or add an API key.' };
  try {
    const o = JSON.parse(readFileSync(file, 'utf8')).claudeAiOauth ?? {};
    const refreshUntil = Number(o.refreshTokenExpiresAt) || 0;
    const until = Number(o.expiresAt) || 0;
    if (until > Date.now()) return { found: true, valid: true, message: 'Claude Code login is active.' };
    if (o.refreshToken && until !== 0 && (!refreshUntil || refreshUntil > Date.now())) return { found: true, valid: true, message: 'Claude Code login will refresh on next use.' };
    return { found: true, valid: false, message: 'The Claude Code login has expired. Run `claude`, then /login, on this machine.' };
  } catch {
    return { found: true, valid: false, message: 'The Claude Code login file could not be read.' };
  }
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from './proc.js';

/** Project memory lives in the repo, so it is versioned and reviewed with the code. */
export const MEMORY_FILE = '.maestro/memory.md';
const HEADER = '# Project memory\n\nLearnings Maestro agents recorded while working on this repository. Edit freely.\n';
const PROMPT_CHARS = 8000;

/** The memory on the base branch, or ''. A local folder's own branch wins; a clone reads its remote's copy first. */
export async function readBaseMemory(repoPath: string, base: string, preferLocal = false): Promise<string> {
  const [first, second] = preferLocal ? [base, `origin/${base}`] : [`origin/${base}`, base];
  return (await readMemoryAt(repoPath, first)) || readMemoryAt(repoPath, second);
}

/** The memory on a ref (e.g. the base branch), or '' when there is none. */
export function readMemoryAt(repoPath: string, ref: string): Promise<string> {
  return git(repoPath, ['show', `${ref}:${MEMORY_FILE}`]).catch(() => '');
}

export function readMemoryFile(worktree: string): string {
  const file = join(worktree, MEMORY_FILE);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

export function writeMemoryFile(worktree: string, content: string): void {
  const file = join(worktree, MEMORY_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`);
}

/** The most recent part of the memory, for prompts. */
export function memoryForPrompt(content: string): string {
  const text = content.trim();
  return text.length > PROMPT_CHARS ? `…(older entries left out)\n${text.slice(-PROMPT_CHARS)}` : text;
}

/** Splits the "Learnings" section off a worker's reply. "None" means no learnings. */
export function extractLearnings(reply: string): { summary: string; learnings: string[] } {
  const m = /(^|\n)\s*(?:#{1,6}\s*Learnings|\*\*Learnings:?\*\*|Learnings:)\s*:?\s*\n?/i.exec(reply);
  if (!m) return { summary: reply.trim(), learnings: [] };
  const before = reply.slice(0, m.index).trim();
  const rest = reply.slice(m.index + m[0].length);
  const end = /\n\s*#{1,6}\s/.exec(rest);
  const section = end ? rest.slice(0, end.index) : rest;
  const after = end ? rest.slice(end.index).trim() : '';
  const learnings = section
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l && !/^none\.?$/i.test(l) && !/^n\/a$/i.test(l));
  return { summary: [before, after].filter(Boolean).join('\n\n'), learnings };
}

/** Adds new learnings under a dated heading for the ticket; ones already in the memory are skipped. */
export function appendLearnings(content: string, ticketKey: string, learnings: string[], date = new Date()): string {
  const known = content.toLowerCase();
  const fresh = [...new Set(learnings)].filter((l) => !known.includes(l.toLowerCase()));
  if (!fresh.length) return content;
  const base = content.trim() ? content.trimEnd() : HEADER.trimEnd();
  return `${base}\n\n## ${date.toISOString().slice(0, 10)} · ${ticketKey}\n${fresh.map((l) => `- ${l}`).join('\n')}\n`;
}

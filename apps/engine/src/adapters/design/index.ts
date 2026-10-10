import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretStore } from '../../secrets.js';
import type { Project, Ticket } from '../../types.js';
import { ticketArea } from '../../workflow.js';
import { FigmaClient, fileKeyFrom, figmaLinks, type FigmaLink } from './figma.js';

/** Where design files go in the worktree. Never committed. */
export const DESIGN_DIR = '.maestro/design';
const UI_LABELS = ['ui', 'frontend', 'design', 'ux'];
const MAX_TEXTS = 60;

export function isUiTicket(ticket: Pick<Ticket, 'labels'>): boolean {
  const area = ticketArea(ticket);
  return ticket.labels.some((l) => UI_LABELS.includes(l.trim().toLowerCase())) || (!!area && ['ui', 'web', 'frontend', 'app'].includes(area));
}

/**
 * Fetches design context for a ticket: the Figma frames it links (names, text and a PNG each),
 * or for UI tickets in a project with a Figma file set, the file's pages and frames.
 * Writes the files under .maestro/design/ in the worktree and returns the text for the worker's prompt,
 * or null when there is nothing to add.
 */
export async function designContextFor(
  project: Project,
  ticket: Ticket,
  worktree: string,
  secrets: SecretStore,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (project.design.provider !== 'figma') return null;
  const ticketText = `${ticket.description}\n${ticket.acceptanceCriteria}`;
  const linked = figmaLinks(ticketText);
  const projectFile = fileKeyFrom(project.design.settings['file']);
  if (!linked.length && !(projectFile && isUiTicket(ticket))) return null;

  const token = secrets.get('FIGMA_TOKEN');
  if (!token) throw new Error('This ticket has Figma design context, but no Figma token is set in Settings.');
  const figma = new FigmaClient(token, fetchImpl);
  const dir = join(worktree, DESIGN_DIR);
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];

  const withNodes = linked.filter((l): l is FigmaLink & { nodeId: string } => !!l.nodeId);
  const byFile = new Map<string, string[]>();
  for (const l of withNodes) byFile.set(l.fileKey, [...(byFile.get(l.fileKey) ?? []), l.nodeId]);
  for (const [fileKey, ids] of byFile) {
    const { fileName, frames } = await figma.nodes(fileKey, ids);
    const images = await figma.pngs(fileKey, ids).catch(() => new Map<string, Buffer>());
    for (const f of frames) {
      const png = images.get(f.id);
      const pngName = `${fileKey}-${f.id.replace(/[^0-9A-Za-z]+/g, '-')}.png`;
      if (png) writeFileSync(join(dir, pngName), png);
      lines.push(
        `### ${f.name} (${fileName})`,
        png ? `Image: ${DESIGN_DIR}/${pngName}` : 'No image export available.',
        f.parts.length ? `Contains: ${f.parts.join(', ')}` : '',
        f.texts.length ? `Text:\n${f.texts.slice(0, MAX_TEXTS).map((t) => `- ${t.replace(/\n/g, ' ')}`).join('\n')}` : '',
        '',
      );
    }
  }

  const overviewKeys = [...new Set([...linked.filter((l) => !l.nodeId).map((l) => l.fileKey), ...(withNodes.length || linked.length ? [] : [projectFile!])])];
  for (const key of overviewKeys) {
    const o = await figma.fileOverview(key);
    lines.push(`### File: ${o.name}`, ...o.pages.map((p) => `- Page "${p.name}": ${p.frames.slice(0, 40).join(', ') || '(empty)'}`), '');
  }

  const text = lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n').trim();
  if (!text) return null;
  writeFileSync(join(dir, 'context.md'), `# Design context for ${ticket.key}\n\n${text}\n`);
  return text;
}

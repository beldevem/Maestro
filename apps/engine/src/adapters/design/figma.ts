const API = 'https://api.figma.com/v1';

export interface FigmaLink {
  fileKey: string;
  /** API node id ("12:34"), or null for the whole file. */
  nodeId: string | null;
}

/** Finds Figma links (file, design or proto URLs, with an optional node-id) in text. */
export function figmaLinks(text: string): FigmaLink[] {
  const links: FigmaLink[] = [];
  const re = /https:\/\/(?:www\.)?figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]+)[^\s)>\]]*/g;
  for (const m of text.matchAll(re)) {
    const node = /[?&]node-id=([0-9]+[-:%3A]+[0-9]+)/i.exec(m[0]);
    const nodeId = node ? decodeURIComponent(node[1]).replace('-', ':') : null;
    if (!links.some((l) => l.fileKey === m[1] && l.nodeId === nodeId)) links.push({ fileKey: m[1], nodeId });
  }
  return links;
}

/** A file key, or a Figma URL, as typed on the project. */
export function fileKeyFrom(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  return figmaLinks(v)[0]?.fileKey ?? (/^[A-Za-z0-9]+$/.test(v) ? v : null);
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  characters?: string;
  children?: FigmaNode[];
}

export interface FrameSummary {
  id: string;
  name: string;
  /** Names of the frames and components inside, one level down. */
  parts: string[];
  /** Text shown in the frame, in document order. */
  texts: string[];
}

export function summarizeNode(node: FigmaNode): FrameSummary {
  const texts: string[] = [];
  const walk = (n: FigmaNode) => {
    if (n.type === 'TEXT' && n.characters?.trim()) texts.push(n.characters.trim());
    n.children?.forEach(walk);
  };
  walk(node);
  const parts = (node.children ?? []).filter((c) => ['FRAME', 'COMPONENT', 'INSTANCE', 'GROUP', 'SECTION', 'COMPONENT_SET'].includes(c.type)).map((c) => c.name);
  return { id: node.id, name: node.name, parts, texts: [...new Set(texts)] };
}

/** Read-only Figma REST client. */
export class FigmaClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, { headers: { 'X-Figma-Token': this.token } });
    if (!res.ok) throw new Error(`Figma GET ${path.split('?')[0]} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  /** The file's name and its pages with their top-level frames. */
  async fileOverview(fileKey: string): Promise<{ name: string; pages: { name: string; frames: string[] }[] }> {
    const file = await this.get<{ name: string; document: FigmaNode }>(`/files/${fileKey}?depth=2`);
    return {
      name: file.name,
      pages: (file.document.children ?? []).map((p) => ({ name: p.name, frames: (p.children ?? []).map((f) => f.name) })),
    };
  }

  async nodes(fileKey: string, ids: string[]): Promise<{ fileName: string; frames: FrameSummary[] }> {
    const res = await this.get<{ name: string; nodes: Record<string, { document: FigmaNode } | null> }>(
      `/files/${fileKey}/nodes?ids=${encodeURIComponent(ids.join(','))}`,
    );
    return { fileName: res.name, frames: Object.values(res.nodes).filter((n): n is { document: FigmaNode } => !!n).map((n) => summarizeNode(n.document)) };
  }

  /** PNG exports of the nodes, as bytes per node id. */
  async pngs(fileKey: string, ids: string[]): Promise<Map<string, Buffer>> {
    const res = await this.get<{ images: Record<string, string | null> }>(`/images/${fileKey}?ids=${encodeURIComponent(ids.join(','))}&format=png&scale=1`);
    const out = new Map<string, Buffer>();
    for (const [id, url] of Object.entries(res.images)) {
      if (!url) continue;
      const img = await this.fetchImpl(url);
      if (img.ok) out.set(id, Buffer.from(await img.arrayBuffer()));
    }
    return out;
  }
}

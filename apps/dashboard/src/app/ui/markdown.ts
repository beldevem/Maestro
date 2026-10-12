const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s: string): string {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
}

/**
 * A small, safe markdown renderer for chat answers: everything is HTML-escaped first, then fenced code,
 * inline code, bold, italics, bullet and numbered lists, headings and paragraphs are formatted. No links or raw HTML.
 */
export function renderMarkdown(text: string): string {
  const out: string[] = [];
  const parts = escape(text ?? '').split(/^```[^\n]*\n?/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(`<pre><code>${part.replace(/\n$/, '')}</code></pre>`);
      return;
    }
    let list: 'ul' | 'ol' | null = null;
    const para: string[] = [];
    const flush = () => {
      if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`);
      para.length = 0;
    };
    const close = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    for (const line of part.split('\n')) {
      const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
      const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      const head = /^#{1,6}\s+(.*)$/.exec(line);
      if (bullet || num) {
        flush();
        const want = bullet ? 'ul' : 'ol';
        if (list !== want) {
          close();
          out.push(`<${want}>`);
          list = want;
        }
        out.push(`<li>${inline((bullet ?? num)![1])}</li>`);
      } else if (head) {
        flush();
        close();
        out.push(`<p><strong>${inline(head[1])}</strong></p>`);
      } else if (!line.trim()) {
        flush();
        close();
      } else {
        close();
        para.push(line);
      }
    }
    flush();
    close();
  });
  return out.join('');
}

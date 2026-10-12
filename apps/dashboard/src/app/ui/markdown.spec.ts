import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('escapes HTML so answers cannot inject markup', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)> **hi**')).toBe('<p>&lt;img src=x onerror=alert(1)&gt; <strong>hi</strong></p>');
  });
  it('formats code blocks, inline code and lists', () => {
    expect(renderMarkdown('Run:\n```bash\nnpm test\n```\n- one `a`\n- two\n\n1. first')).toBe(
      '<p>Run:</p><pre><code>npm test</code></pre><ul><li>one <code>a</code></li><li>two</li></ul><ol><li>first</li></ol>',
    );
  });
});

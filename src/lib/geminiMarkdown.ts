export type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; language: string; code: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'quote'; text: string }
  | { type: 'rule' };

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isTableDivider(line: string): boolean {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|');
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = () => {
    const text = paragraph.join(' ').trim();
    if (text) blocks.push({ type: 'paragraph', text });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = /^```([^`]*)$/.exec(trimmed);
    if (fence) {
      flushParagraph();
      const language = fence[1].trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', language, code: code.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      flushParagraph();
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quote.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', text: quote.join(' ') });
      continue;
    }

    if (index + 1 < lines.length && trimmed.includes('|') && isTableDivider(lines[index + 1])) {
      flushParagraph();
      const headers = tableCells(trimmed);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    const unordered = /^[-*+]\s+(.+)$/.exec(trimmed);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const items: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index].trim();
        const match = isOrdered
          ? /^\d+[.)]\s+(.+)$/.exec(candidate)
          : /^[-*+]\s+(.+)$/.exec(candidate);
        if (!match) break;
        items.push(match[1].trim());
        index += 1;
      }
      blocks.push({ type: 'list', ordered: isOrdered, items });
      continue;
    }

    paragraph.push(trimmed);
    index += 1;
  }

  flushParagraph();
  return blocks;
}

export function inlineMarkdown(value: string): string {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return html;
}

export function markdownToSafeHtml(markdown: string): string {
  return parseMarkdown(markdown)
    .map((block) => {
      switch (block.type) {
        case 'heading':
          return `<h${block.level}>${inlineMarkdown(block.text)}</h${block.level}>`;
        case 'paragraph':
          return `<p>${inlineMarkdown(block.text)}</p>`;
        case 'quote':
          return `<blockquote>${inlineMarkdown(block.text)}</blockquote>`;
        case 'rule':
          return '<hr />';
        case 'code':
          return `<div class="code-card"><div class="code-label">${escapeHtml(
            block.language || 'command',
          )}</div><pre><code>${escapeHtml(block.code)}</code></pre></div>`;
        case 'list': {
          const tag = block.ordered ? 'ol' : 'ul';
          return `<${tag}>${block.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</${tag}>`;
        }
        case 'table':
          return `<div class="table-wrap"><table><thead><tr>${block.headers
            .map((cell) => `<th>${inlineMarkdown(cell)}</th>`)
            .join('')}</tr></thead><tbody>${block.rows
            .map(
              (row) =>
                `<tr>${block.headers
                  .map((_, index) => `<td>${inlineMarkdown(row[index] ?? '')}</td>`)
                  .join('')}</tr>`,
            )
            .join('')}</tbody></table></div>`;
      }
    })
    .join('\n');
}

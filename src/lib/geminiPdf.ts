'use client';

import { escapeHtml, markdownToSafeHtml, parseMarkdown } from './geminiMarkdown';
import { htmlToPdfBlob } from './htmlToPdf';

function toc(markdown: string): string {
  const headings = parseMarkdown(markdown).filter(
    (block): block is Extract<ReturnType<typeof parseMarkdown>[number], { type: 'heading' }> =>
      block.type === 'heading' && block.level <= 3,
  );
  if (headings.length === 0) return '';
  return `<section class="toc avoid-break"><h2>目次</h2><ol>${headings
    .map((entry) => `<li class="level-${entry.level}">${escapeHtml(entry.text)}</li>`)
    .join('')}</ol></section>`;
}

export function buildGeminiPdfHtml(options: {
  title: string;
  chatDate: string;
  markdown: string;
  createdAt?: string;
  documentType?: string;
}): string {
  const created = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(options.createdAt ? new Date(options.createdAt) : new Date());

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    color: #1b2632;
    background: #ffffff;
    font-family: "Noto Sans JP", "Yu Gothic", "Hiragino Kaku Gothic ProN", sans-serif;
    font-size: 10.5pt;
    line-height: 1.72;
    overflow-wrap: anywhere;
  }
  .document { width: 100%; }
  .cover {
    min-height: 255mm;
    padding: 26mm 18mm 18mm;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    page-break-after: always;
    background: linear-gradient(145deg, #f7fbff 0%, #ffffff 62%);
  }
  .cover-mark {
    width: 56px; height: 7px; border-radius: 999px; background: #377d9b; margin-bottom: 16mm;
  }
  .cover h1 { margin: 0; font-size: 25pt; line-height: 1.35; letter-spacing: .02em; color: #163244; }
  .cover .subtitle { margin-top: 7mm; color: #506372; font-size: 12pt; }
  .meta-grid { border-top: 1px solid #cbd8df; padding-top: 7mm; display: grid; gap: 2mm; color: #526572; }
  main { padding: 14mm 16mm 18mm; }
  h1, h2, h3, h4 { color: #173f55; break-after: avoid; page-break-after: avoid; }
  h1 { font-size: 22pt; margin: 0 0 9mm; }
  h2 { font-size: 16pt; margin: 12mm 0 4mm; padding: 2.5mm 0 2.5mm 4mm; border-left: 5px solid #377d9b; background: #f1f7fa; }
  h3 { font-size: 13pt; margin: 8mm 0 3mm; padding-bottom: 1.5mm; border-bottom: 1px solid #cad8df; }
  h4 { font-size: 11.5pt; margin: 6mm 0 2mm; }
  p { margin: 0 0 3.2mm; }
  strong { color: #b13a35; }
  em { color: #225a78; }
  code { font-family: "SFMono-Regular", Consolas, monospace; background: #eef3f6; padding: .15em .35em; border-radius: 4px; font-size: .92em; }
  ul, ol { margin: 2mm 0 4mm 6mm; padding-left: 5mm; }
  li { margin: 1.2mm 0; }
  blockquote {
    margin: 4mm 0; padding: 4mm 5mm; border-left: 5px solid #5b88a2;
    background: #f3f8fb; color: #284b5e; break-inside: avoid; page-break-inside: avoid;
  }
  .code-card {
    margin: 4mm 0 5mm; border: 1px solid #a9bac4; border-radius: 8px; overflow: hidden;
    background: #19232c; color: #f5f7f9; break-inside: avoid; page-break-inside: avoid;
  }
  .code-label { padding: 1.8mm 3mm; background: #2a3944; color: #d8e4ea; font-size: 8.5pt; letter-spacing: .04em; }
  pre { margin: 0; padding: 4mm; white-space: pre-wrap; word-break: break-word; font-size: 9pt; line-height: 1.55; }
  pre code { padding: 0; color: inherit; background: transparent; }
  .table-wrap { margin: 4mm 0 6mm; overflow: hidden; break-inside: avoid; page-break-inside: avoid; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid #9fb0ba; padding: 2.3mm 2.5mm; vertical-align: top; font-size: 9.2pt; }
  th { background: #eaf2f6; color: #183f54; text-align: left; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  hr { border: 0; border-top: 1px solid #c9d5dc; margin: 8mm 0; }
  .toc { margin-bottom: 9mm; padding: 6mm; border: 1px solid #c7d6de; border-radius: 8px; background: #fbfdfe; }
  .toc h2 { margin-top: 0; }
  .toc ol { margin-bottom: 0; }
  .toc .level-3 { margin-left: 5mm; color: #526572; }
  .avoid-break { break-inside: avoid; page-break-inside: avoid; }
  .footer-note { margin-top: 12mm; padding-top: 4mm; border-top: 1px solid #d4dde2; font-size: 8.5pt; color: #71818b; }
</style>
</head>
<body>
<div class="document">
  <section class="cover">
    <div>
      <div class="cover-mark"></div>
      <h1>${escapeHtml(options.title)}</h1>
      <p class="subtitle">${escapeHtml(options.documentType || 'Gemini 学習・業務資料')}</p>
    </div>
    <div class="meta-grid">
      <div><strong>対象日：</strong>${escapeHtml(options.chatDate)}</div>
      <div><strong>作成日：</strong>${escapeHtml(created)}</div>
      <div><strong>作成元：</strong>株式ニュースフォルダー内 Gemini チャット</div>
    </div>
  </section>
  <main>
    ${toc(options.markdown)}
    ${markdownToSafeHtml(options.markdown)}
    <p class="footer-note">この資料は対象日のチャット内容をもとに再構成されています。補足事項は本文中で明示しています。</p>
  </main>
</div>
</body>
</html>`;
}

export async function createGeminiPdfBlob(options: {
  title: string;
  chatDate: string;
  markdown: string;
  documentType?: string;
}): Promise<Blob> {
  return htmlToPdfBlob(buildGeminiPdfHtml(options), {
    selector: '.document',
    avoid: ['table', 'tr', '.code-card', 'blockquote', '.avoid-break'],
  });
}

'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { inlineMarkdown, parseMarkdown } from '@/lib/geminiMarkdown';

function Inline({ text }: { text: string }) {
  return <span dangerouslySetInnerHTML={{ __html: inlineMarkdown(text) }} />;
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-[#33424e] bg-[#17212a] text-[#f3f6f8]">
      <div className="flex items-center justify-between bg-[#25323c] px-3 py-1.5 text-xs text-[#c9d5dc]">
        <span>{language || 'command'}</span>
        <button type="button" onClick={copy} className="flex min-h-8 items-center gap-1 rounded-lg px-2 active:bg-white/10">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'コピー済み' : 'コピー'}
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 py-3 text-[13px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function MarkdownContent({ markdown }: { markdown: string }) {
  const blocks = parseMarkdown(markdown);
  return (
    <div className="gemini-markdown text-[15px] leading-relaxed text-ink dark:text-[#e6eaef]">
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        if (block.type === 'heading') {
          const classes =
            block.level === 1
              ? 'mt-5 mb-2 text-xl font-bold'
              : block.level === 2
                ? 'mt-5 mb-2 border-l-4 border-brand-400 pl-2 text-lg font-semibold'
                : 'mt-4 mb-1.5 text-base font-semibold';
          return (
            <div key={key} className={classes}>
              <Inline text={block.text} />
            </div>
          );
        }
        if (block.type === 'paragraph') {
          return (
            <p key={key} className="mb-3">
              <Inline text={block.text} />
            </p>
          );
        }
        if (block.type === 'code') return <CodeBlock key={key} code={block.code} language={block.language} />;
        if (block.type === 'quote') {
          return (
            <blockquote key={key} className="my-3 rounded-r-xl border-l-4 border-brand-300 bg-brand-50 px-3 py-2 text-[#315365] dark:bg-[#20303a] dark:text-[#dce6eb]">
              <Inline text={block.text} />
            </blockquote>
          );
        }
        if (block.type === 'rule') return <hr key={key} className="my-5 divider" />;
        if (block.type === 'list') {
          const Tag = block.ordered ? 'ol' : 'ul';
          return (
            <Tag key={key} className={block.ordered ? 'mb-3 list-decimal space-y-1 pl-6' : 'mb-3 list-disc space-y-1 pl-6'}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-${itemIndex}`}>
                  <Inline text={item} />
                </li>
              ))}
            </Tag>
          );
        }
        return (
          <div key={key} className="my-3 overflow-x-auto rounded-xl border divider">
            <table className="w-full min-w-[460px] border-collapse text-sm">
              <thead>
                <tr className="bg-[#eef4f7] dark:bg-[#25313a]">
                  {block.headers.map((header, cellIndex) => (
                    <th key={cellIndex} className="border divider px-3 py-2 text-left font-semibold">
                      <Inline text={header} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {block.headers.map((_, cellIndex) => (
                      <td key={cellIndex} className="border divider px-3 py-2 align-top">
                        <Inline text={row[cellIndex] ?? ''} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

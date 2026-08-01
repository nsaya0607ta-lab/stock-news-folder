'use client';

/** ニュース記事 1 件の表示（今日のニュース・検索結果で共用）。 */
import { ExternalLink } from 'lucide-react';
import { canonicalUrl } from '@/lib/stock/core/dedupe.mjs';
import type { NewsArticle } from '@/lib/stock/types';
import { CategoryBadge, ImportanceBadge, SentimentBadge, formatDate } from './StockBits';

export type ArticleHit = {
  article: NewsArticle;
  reportId: string;
  reportDate: string;
  ticker: string;
  companyName: string;
};

export function ArticleRow({ hit, onOpenReport }: { hit: ArticleHit; onOpenReport: () => void }) {
  const url = canonicalUrl(hit.article.url);
  return (
    <div className="border-b border-line px-3 py-3 last:border-b-0 dark:border-[#2a333d]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-bold text-ink dark:text-[#e6eaef]">{hit.ticker}</span>
        <span className="text-xs text-ink-sub dark:text-[#98a3b0]">{formatDate(hit.reportDate)}</span>
        <CategoryBadge category={hit.article.category} />
        <ImportanceBadge level={hit.article.importance} />
        <SentimentBadge sentiment={hit.article.sentiment} />
      </div>
      <button type="button" onClick={onOpenReport} className="mt-1 block w-full text-left">
        <span className="block break-words text-base font-semibold leading-snug text-ink dark:text-[#e6eaef]">
          {hit.article.title}
        </span>
        <span className="mt-1 block break-words text-sm leading-relaxed text-ink-sub dark:text-[#98a3b0]">
          {hit.article.summary}
        </span>
        <span className="mt-1 block break-words text-xs text-ink-faint">
          {hit.article.sourceName} ／ 公開 {hit.article.publishedAt || '確認できず'}
        </span>
      </button>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-1 inline-flex items-center gap-1 break-words text-xs text-brand-500 underline dark:text-brand-300"
        >
          <ExternalLink size={12} aria-hidden />
          元記事を開く
        </a>
      ) : null}
    </div>
  );
}

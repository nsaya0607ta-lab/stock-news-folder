'use client';

/** 株式ニュース画面で共通して使う小さな表示部品。 */
import type { ReactNode } from 'react';
import { AlertTriangle, CircleDot, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { cx } from '@/components/ui/Primitives';
import {
  CATEGORY_LABELS,
  IMPORTANCE_LABELS,
  IMPORTANCE_MARKS,
  SENTIMENT_LABELS,
  SOURCE_TIER_LABELS,
} from '@/lib/stock/core/taxonomy.mjs';
import type { NewsCategory, Sentiment } from '@/lib/stock/types';

/** 日付を「2026/08/02（日）」の形にする。 */
export function formatDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value ?? '');
  const date = new Date(`${value}T00:00:00+09:00`);
  const weekday = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', weekday: 'short' }).format(date);
  return `${value.replaceAll('-', '/')}（${weekday}）`;
}

/** ISO 日時を日本時間の「8/2 08:00」にする。 */
export function formatDateTime(value?: string): string {
  const time = Date.parse(String(value ?? ''));
  if (!Number.isFinite(time)) return '—';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(time));
}

/** 次回予定を「明日 8:00」のように短く表す。 */
export function formatNextRun(value?: string): string {
  const time = Date.parse(String(value ?? ''));
  if (!Number.isFinite(time)) return '予定なし';
  const target = new Date(time);
  const dayKey = (date: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(date);
  const clock = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  }).format(target);
  const today = dayKey(new Date());
  const tomorrow = dayKey(new Date(Date.now() + 86400000));
  const key = dayKey(target);
  if (key === today) return `本日 ${clock}`;
  if (key === tomorrow) return `明日 ${clock}`;
  return `${key.slice(5).replace('-', '/')} ${clock}`;
}

/** 絞り込み用の評価一覧。 */
export const SENTIMENT_FILTERS: { value: Sentiment; label: string }[] = [
  { value: 'positive', label: SENTIMENT_LABELS.positive },
  { value: 'neutral', label: SENTIMENT_LABELS.neutral },
  { value: 'negative', label: SENTIMENT_LABELS.negative },
];

export function ImportanceBadge({ level, className }: { level: number; className?: string }) {
  const key = level >= 3 ? 3 : level <= 1 ? 1 : 2;
  const styles: Record<number, string> = {
    3: 'border-[#c8342b] text-[#8c1d18] bg-[#fdeceb] dark:bg-[#3a1d1b] dark:text-[#ffb4ad]',
    2: 'border-[#9a6a00] text-[#7a5400] bg-[#fdf5e4] dark:bg-[#33290f] dark:text-[#f3cf86]',
    1: 'border-line text-ink-sub bg-surface dark:bg-[#1b222a] dark:text-[#98a3b0]',
  };
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold',
        styles[key],
        className,
      )}
    >
      {key === 3 ? <AlertTriangle size={12} aria-hidden /> : <CircleDot size={12} aria-hidden />}
      {IMPORTANCE_MARKS[key]} 重要度{IMPORTANCE_LABELS[key]}
    </span>
  );
}

export function SentimentBadge({ sentiment }: { sentiment: Sentiment }) {
  const map: Record<Sentiment, { icon: ReactNode; className: string }> = {
    positive: {
      icon: <TrendingUp size={12} aria-hidden />,
      className: 'border-[#087647] text-[#076a40] bg-[#e9f6ef] dark:bg-[#122f22] dark:text-[#7ddaa8]',
    },
    negative: {
      icon: <TrendingDown size={12} aria-hidden />,
      className: 'border-[#c8342b] text-[#8c1d18] bg-[#fdeceb] dark:bg-[#3a1d1b] dark:text-[#ffb4ad]',
    },
    neutral: {
      icon: <Minus size={12} aria-hidden />,
      className: 'border-line text-ink-sub bg-surface dark:bg-[#1b222a] dark:text-[#98a3b0]',
    },
  };
  const entry = map[sentiment] ?? map.neutral;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold',
        entry.className,
      )}
    >
      {entry.icon}
      {SENTIMENT_LABELS[sentiment] ?? SENTIMENT_LABELS.neutral}
    </span>
  );
}

export function CategoryBadge({ category }: { category: NewsCategory }) {
  return (
    <span className="inline-flex whitespace-nowrap rounded-full border border-line bg-surface-sub px-2 py-0.5 text-xs text-ink-sub dark:border-[#333d49] dark:bg-[#1b222a] dark:text-[#98a3b0]">
      {CATEGORY_LABELS[category] ?? CATEGORY_LABELS.other}
    </span>
  );
}

export function SourceTierLabel({ tier }: { tier: number }) {
  const key = (tier >= 1 && tier <= 5 ? tier : 5) as 1 | 2 | 3 | 4 | 5;
  return <span className="text-xs text-ink-sub dark:text-[#98a3b0]">{SOURCE_TIER_LABELS[key]}</span>;
}

/** 銘柄アイコン（ロゴ画像は使わず、ティッカーの頭文字で表す）。 */
export function TickerAvatar({ ticker, size = 44 }: { ticker: string; size?: number }) {
  const label = ticker.slice(0, 4);
  const palette = ['#2767c4', '#1d51a3', '#0f766e', '#7c3aed', '#b45309', '#be123c'];
  let hash = 0;
  for (const char of ticker) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const color = palette[hash % palette.length];
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-card font-bold text-white"
      style={{
        width: size,
        height: size,
        background: color,
        fontSize: label.length >= 4 ? size * 0.28 : size * 0.34,
        letterSpacing: '0.02em',
      }}
    >
      {label}
    </span>
  );
}

/** 一覧の状態表示（読み込み中・空・エラー）。 */
export function StateBlock({
  tone = 'empty',
  title,
  description,
  action,
}: {
  tone?: 'empty' | 'error' | 'loading';
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className={cx(
        'mx-4 my-4 rounded-card border px-4 py-8 text-center',
        tone === 'error'
          ? 'border-[#c8342b]/40 bg-[#fdeceb] dark:bg-[#2a1918]'
          : 'border-dashed border-line bg-surface dark:border-[#333d49] dark:bg-[#181e26]',
      )}
      role={tone === 'error' ? 'alert' : undefined}
    >
      <p className="text-base font-semibold text-ink dark:text-[#e6eaef]">{title}</p>
      {description ? (
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-sub dark:text-[#98a3b0]">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

/** 数値を並べる小さな統計タイル。 */
export function StatTile({
  label,
  value,
  suffix = '件',
  onClick,
  highlight,
}: {
  label: string;
  value: number;
  suffix?: string;
  onClick?: () => void;
  highlight?: boolean;
}) {
  const content = (
    <>
      <span className="block truncate text-xs text-ink-sub dark:text-[#98a3b0]">{label}</span>
      <span
        className={cx(
          'mt-0.5 block text-xl font-bold tabular-nums',
          highlight && value > 0 ? 'text-brand-500 dark:text-brand-300' : 'text-ink dark:text-[#e6eaef]',
        )}
      >
        {value}
        <span className="ml-0.5 text-xs font-normal text-ink-sub dark:text-[#98a3b0]">{suffix}</span>
      </span>
    </>
  );
  if (!onClick) {
    return <div className="card flex-1 px-3 py-2.5">{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="card flex-1 px-3 py-2.5 text-left active:bg-surface-sub dark:active:bg-[#232b35]"
    >
      {content}
    </button>
  );
}

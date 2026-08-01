'use client';

/** レポート一覧の 1 行。銘柄フォルダー・今日のニュース・検索で共通して使う。 */
import { AlertCircle, FileText, Star } from 'lucide-react';
import { cx } from '@/components/ui/Primitives';
import type { StockReportEntry } from '@/lib/stock/types';
import { ImportanceBadge, SentimentBadge, formatDate, formatDateTime } from './StockBits';

export function ReportRow({
  report,
  showTicker = false,
  onOpen,
  onToggleFavorite,
}: {
  report: StockReportEntry;
  showTicker?: boolean;
  onOpen: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <div
      className={cx(
        'flex items-start gap-2 border-b border-line px-3 py-3 last:border-b-0 dark:border-[#2a333d]',
        !report.isRead && 'bg-brand-50/60 dark:bg-[#16202e]',
      )}
    >
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="flex flex-wrap items-center gap-1.5">
          {!report.isRead ? (
            <span className="rounded-full bg-brand-500 px-1.5 py-0.5 text-[11px] font-bold text-white">
              未読
            </span>
          ) : (
            <span className="rounded-full border border-line px-1.5 py-0.5 text-[11px] text-ink-sub dark:border-[#333d49] dark:text-[#98a3b0]">
              既読
            </span>
          )}
          {showTicker ? (
            <span className="text-sm font-bold text-ink dark:text-[#e6eaef]">{report.ticker}</span>
          ) : null}
          <span className="text-xs text-ink-sub dark:text-[#98a3b0]">{formatDate(report.reportDate)}</span>
          <span className="text-xs text-ink-sub dark:text-[#98a3b0]">
            ニュース {report.articleCount} 件
          </span>
        </span>

        <span className="mt-1 block break-words text-base font-semibold leading-snug text-ink dark:text-[#e6eaef]">
          {report.headline}
        </span>

        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {report.importance > 0 ? <ImportanceBadge level={report.importance} /> : null}
          <SentimentBadge sentiment={report.sentiment} />
          {report.localFileId ? (
            <span className="inline-flex items-center gap-1 text-xs text-ink-sub dark:text-[#98a3b0]">
              <FileText size={12} aria-hidden />
              PDFあり
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-ink-sub dark:text-[#98a3b0]">
              <AlertCircle size={12} aria-hidden />
              PDFなし（内容は表示できます）
            </span>
          )}
          {report.saveError ? (
            <span className="inline-flex items-center gap-1 text-xs text-pdf">
              <AlertCircle size={12} aria-hidden />
              一部失敗
            </span>
          ) : null}
        </span>

        <span className="mt-1 block text-xs text-ink-sub dark:text-[#98a3b0]">
          作成 {formatDateTime(report.generatedAt)}
          {report.source === 'manual' ? '（手動取得）' : ''}
        </span>
      </button>

      <button
        type="button"
        onClick={onToggleFavorite}
        aria-label={report.isFavorite ? 'お気に入りを解除' : 'お気に入りに登録'}
        aria-pressed={report.isFavorite}
        className="flex h-tap w-tap shrink-0 items-center justify-center rounded-card text-ink-sub active:bg-line/60 dark:text-[#98a3b0] dark:active:bg-[#252d37]"
      >
        <Star
          size={20}
          className={report.isFavorite ? 'fill-folder text-folder' : ''}
          strokeWidth={report.isFavorite ? 2 : 1.8}
        />
      </button>
    </div>
  );
}

export function ReportListPanel({
  reports,
  showTicker,
  onOpen,
  onToggleFavorite,
}: {
  reports: StockReportEntry[];
  showTicker?: boolean;
  onOpen: (report: StockReportEntry) => void;
  onToggleFavorite: (report: StockReportEntry) => void;
}) {
  return (
    <div className="card mx-4 overflow-hidden">
      {reports.map((report) => (
        <ReportRow
          key={report.reportId}
          report={report}
          showTicker={showTicker}
          onOpen={() => onOpen(report)}
          onToggleFavorite={() => onToggleFavorite(report)}
        />
      ))}
    </div>
  );
}

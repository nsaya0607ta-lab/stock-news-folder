'use client';

/**
 * レポートの閲覧画面。
 * PDFを開かなくても内容を確認できるようにし、必要なときだけPDFを表示する。
 */
import { useEffect } from 'react';
import { ChevronLeft, ExternalLink, FileText, Star } from 'lucide-react';
import { Button, IconButton } from '@/components/ui/Primitives';
import { canonicalUrl } from '@/lib/stock/core/dedupe.mjs';
import type { StockReportEntry } from '@/lib/stock/types';
import {
  CategoryBadge,
  ImportanceBadge,
  SentimentBadge,
  SourceTierLabel,
  formatDate,
  formatDateTime,
} from './StockBits';

export function ReportDetailView({
  report,
  onClose,
  onOpenPdf,
  onToggleFavorite,
}: {
  report: StockReportEntry;
  onClose: () => void;
  onOpenPdf: () => void;
  onToggleFavorite: () => void;
}) {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[70] overflow-y-auto overscroll-contain bg-surface-sub dark:bg-[#11161c]">
      <header
        className="sticky top-0 z-10 border-b divider bg-surface/95 backdrop-blur dark:bg-[#181e26]/95"
        style={{ paddingTop: 'var(--safe-top)' }}
      >
        <div className="mx-auto flex min-h-[52px] max-w-3xl items-center gap-1 px-1.5">
          <IconButton label="閉じる" onClick={onClose}>
            <ChevronLeft size={22} />
          </IconButton>
          <div className="min-w-0 flex-1 px-1.5">
            <h1 className="truncate text-lg font-semibold text-ink dark:text-[#e6eaef]">
              {report.ticker} 日次ニュースレポート
            </h1>
            <p className="truncate text-xs text-ink-sub dark:text-[#98a3b0]">
              {formatDate(report.reportDate)} ／ ニュース {report.articleCount} 件
            </p>
          </div>
          <IconButton
            label={report.isFavorite ? 'お気に入りを解除' : 'お気に入りに登録'}
            onClick={onToggleFavorite}
          >
            <Star size={20} className={report.isFavorite ? 'fill-folder text-folder' : ''} />
          </IconButton>
        </div>
      </header>

      <main
        className="mx-auto w-full max-w-3xl px-4 pb-10 pt-4"
        style={{ paddingBottom: 'calc(var(--safe-bottom) + 40px)' }}
      >
        <section className="card p-4">
          <h2 className="text-sm font-semibold text-ink-sub dark:text-[#98a3b0]">対象銘柄</h2>
          <p className="mt-1 break-words text-lg font-bold text-ink dark:text-[#e6eaef]">
            {report.companyName}（{report.ticker}）
          </p>
          <dl className="mt-3 grid grid-cols-1 gap-1 text-xs text-ink-sub dark:text-[#98a3b0] sm:grid-cols-2">
            <div className="flex justify-between gap-2">
              <dt>作成日時</dt>
              <dd className="text-ink dark:text-[#e6eaef]">{formatDateTime(report.generatedAt)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>対象期間</dt>
              <dd className="text-ink dark:text-[#e6eaef]">
                {report.periodFrom.replaceAll('-', '/')} 〜 {report.periodTo.replaceAll('-', '/')}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>取得方法</dt>
              <dd className="text-ink dark:text-[#e6eaef]">
                {report.source === 'manual' ? '手動（今すぐ取得）' : '自動（定時取得）'}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>状態</dt>
              <dd className="text-ink dark:text-[#e6eaef]">
                {report.saveError ? '一部失敗（PDF未作成）' : report.localFileId ? '生成成功' : 'PDFなし'}
              </dd>
            </div>
          </dl>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {report.importance > 0 ? <ImportanceBadge level={report.importance} /> : null}
            <SentimentBadge sentiment={report.sentiment} />
            {report.localFileId ? (
              <Button variant="secondary" className="h-9 min-h-0 px-3 text-sm" onClick={onOpenPdf}>
                <FileText size={16} />
                PDFを表示
              </Button>
            ) : null}
          </div>
          {report.saveError ? (
            <p className="mt-2 break-words rounded-card bg-[#fdeceb] px-3 py-2 text-xs text-[#8c1d18] dark:bg-[#2a1918] dark:text-[#ffb4ad]">
              PDFの作成に失敗しました（{report.saveError}）。内容はこの画面で確認できます。
            </p>
          ) : null}
        </section>

        <h2 className="px-1 pb-2 pt-5 text-sm font-semibold text-ink-sub dark:text-[#98a3b0]">
          本日の重要ニュース要約
        </h2>
        <section className="card p-4">
          <p className="break-words text-base font-semibold leading-snug text-ink dark:text-[#e6eaef]">
            {report.headline}
          </p>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink dark:text-[#e6eaef]">
            {report.summary}
          </p>
          {report.priceComment ? (
            <p className="mt-3 rounded-card bg-surface-sub px-3 py-2 text-xs leading-relaxed text-ink-sub dark:bg-[#1b222a] dark:text-[#98a3b0]">
              <span className="font-semibold">値動きの補足（AIによる分析）：</span>
              {report.priceComment}
            </p>
          ) : null}
        </section>

        {report.quote ? (
          <>
            <h2 className="px-1 pb-2 pt-5 text-sm font-semibold text-ink-sub dark:text-[#98a3b0]">
              株価の参考情報
            </h2>
            <section className="card p-4 text-sm text-ink dark:text-[#e6eaef]">
              <p className="text-xs text-ink-sub dark:text-[#98a3b0]">
                {report.quote.marketDate.replaceAll('-', '/')} 米国市場終値（時間外を含まない）／{' '}
                {report.quote.provider}
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums">
                {report.quote.close.toFixed(2)} USD
                <span className="ml-2 text-base font-semibold">
                  {report.quote.change > 0 ? '▲ +' : report.quote.change < 0 ? '▼ −' : '― '}
                  {Math.abs(report.quote.change).toFixed(2)}（
                  {Math.abs(report.quote.changePercent).toFixed(2)}%）
                </span>
              </p>
            </section>
          </>
        ) : null}

        <h2 className="px-1 pb-2 pt-5 text-sm font-semibold text-ink-sub dark:text-[#98a3b0]">
          ニュース一覧（重要度の高い順）
        </h2>
        {report.articles.length === 0 ? (
          <section className="card p-4 text-sm leading-relaxed text-ink-sub dark:text-[#98a3b0]">
            対象期間内に、この銘柄に直接関係する重要な新規ニュースは確認できませんでした。
          </section>
        ) : (
          <div className="flex flex-col gap-2">
            {report.articles.map((article, index) => {
              const url = canonicalUrl(article.url);
              return (
                <article key={article.dedupeHash || `${index}`} className="card p-4">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-500 text-[11px] font-bold text-white">
                      {index + 1}
                    </span>
                    <CategoryBadge category={article.category} />
                    <ImportanceBadge level={article.importance} />
                    <SentimentBadge sentiment={article.sentiment} />
                  </div>
                  <h3 className="mt-2 break-words text-base font-semibold leading-snug text-ink dark:text-[#e6eaef]">
                    {article.title}
                  </h3>
                  <p className="mt-1 break-words text-xs text-ink-sub dark:text-[#98a3b0]">
                    公開 {article.publishedAt || '確認できず'} ／ {article.sourceName} ／{' '}
                    <SourceTierLabel tier={article.sourceTier} />
                  </p>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink dark:text-[#e6eaef]">
                    <span className="font-semibold">事実：</span>
                    {article.summary}
                  </p>
                  {article.keyPoints.length > 0 ? (
                    <ul className="mt-2 list-disc pl-5 text-sm leading-relaxed text-ink dark:text-[#e6eaef]">
                      {article.keyPoints.map((point) => (
                        <li key={point} className="break-words">
                          {point}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {article.priceImpact ? (
                    <p className="mt-2 rounded-card bg-surface-sub px-3 py-2 text-xs leading-relaxed text-ink-sub dark:bg-[#1b222a] dark:text-[#98a3b0]">
                      <span className="font-semibold">株価への影響が考えられるポイント（AIによる分析）：</span>
                      {article.priceImpact}
                    </p>
                  ) : null}
                  {article.duplicateSources && article.duplicateSources.length > 0 ? (
                    <p className="mt-1 break-words text-xs text-ink-sub dark:text-[#98a3b0]">
                      同内容の掲載：{article.duplicateSources.join('、')}
                    </p>
                  ) : null}
                  <p className="mt-2 break-words text-xs">
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1 text-brand-500 underline dark:text-brand-300"
                      >
                        <ExternalLink size={12} aria-hidden />
                        元記事を開く（{article.sourceHost || url}）
                      </a>
                    ) : (
                      <span className="text-ink-sub dark:text-[#98a3b0]">元記事URLを確認できません</span>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-ink-sub dark:text-[#98a3b0]">
                    取得日時 {formatDateTime(article.fetchedAt)}
                  </p>
                </article>
              );
            })}
          </div>
        )}

        <h2 className="px-1 pb-2 pt-5 text-sm font-semibold text-ink-sub dark:text-[#98a3b0]">
          今後確認すべき項目
        </h2>
        <section className="card p-4 text-sm leading-relaxed text-ink dark:text-[#e6eaef]">
          {report.watchItems.length > 0 ? (
            <ul className="list-disc pl-5">
              {report.watchItems.map((item) => (
                <li key={item} className="break-words">
                  {item}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-sub dark:text-[#98a3b0]">具体的な確認項目はありません。</p>
          )}
          {report.nextEvent.title || report.nextEvent.date ? (
            <p className="mt-3 break-words border-t border-line pt-3 text-sm dark:border-[#2a333d]">
              <span className="font-semibold">次の重要イベント：</span>
              {report.nextEvent.date || '日付未確認'} {report.nextEvent.title}
            </p>
          ) : null}
          {report.uncertainties.length > 0 ? (
            <div className="mt-3 border-t border-line pt-3 dark:border-[#2a333d]">
              <p className="text-xs font-semibold text-ink-sub dark:text-[#98a3b0]">
                確認できていないこと
              </p>
              <ul className="mt-1 list-disc pl-5 text-sm">
                {report.uncertainties.map((item) => (
                  <li key={item} className="break-words">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        {report.sources.length > 0 ? (
          <>
            <h2 className="px-1 pb-2 pt-5 text-sm font-semibold text-ink-sub dark:text-[#98a3b0]">情報源</h2>
            <section className="card p-4">
              <ul className="flex flex-col gap-1.5 text-sm">
                {report.sources.map((source) => {
                  const url = canonicalUrl(source.url);
                  if (!url) return null;
                  return (
                    <li key={url}>
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="break-words text-brand-500 underline dark:text-brand-300"
                      >
                        {source.title || url}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </section>
          </>
        ) : null}

        <p className="mt-5 rounded-card border border-line bg-surface px-4 py-3 text-xs leading-relaxed text-ink-sub dark:border-[#2a333d] dark:bg-[#181e26] dark:text-[#98a3b0]">
          <span className="font-semibold text-ink dark:text-[#e6eaef]">免責事項：</span>
          本レポートは公開情報を自動で収集・整理した情報提供資料です。事実の記載は各記事の内容にもとづき、影響の見立てはAIによる分析であり、確定した事実ではありません。
          情報の正確性・網羅性・最新性を保証するものではなく、記載内容に誤りや取得漏れが含まれる可能性があります。
          特定の銘柄の売買を推奨するものではなく、投資助言ではありません。投資判断はご自身の責任で行い、必ず一次情報をご確認ください。
        </p>
      </main>
    </div>
  );
}

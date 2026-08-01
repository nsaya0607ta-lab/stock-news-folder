'use client';

/** 複数銘柄を横断した検索と絞り込み。 */
import { useMemo, useState } from 'react';
import { Search, SlidersHorizontal } from 'lucide-react';
import { Button, IconButton, SectionTitle, Switch, cx } from '@/components/ui/Primitives';
import { Header } from '@/components/views/Header';
import { useStock } from '@/store/StockStore';
import { NEWS_CATEGORIES, CATEGORY_LABELS } from '@/lib/stock/core/taxonomy.mjs';
import type { NewsCategory, Sentiment, StockReportEntry } from '@/lib/stock/types';
import { ArticleRow, type ArticleHit } from './ArticleRow';
import { ReportListPanel } from './ReportList';
import { SENTIMENT_FILTERS, StateBlock } from './StockBits';

const fieldClass =
  'w-full rounded-card border border-line bg-surface px-3 py-2 text-base text-ink dark:border-[#333d49] dark:bg-[#1b222a] dark:text-[#e6eaef]';

export function NewsSearchView({ onOpenReport }: { onOpenReport: (report: StockReportEntry) => void }) {
  const { reports, subscriptions, toggleReportFavorite } = useStock();
  const [query, setQuery] = useState('');
  const [ticker, setTicker] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [category, setCategory] = useState<NewsCategory | ''>('');
  const [importance, setImportance] = useState(0);
  const [sentiment, setSentiment] = useState<Sentiment | ''>('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  const text = query.trim().toLowerCase();

  const matchedReports = useMemo(
    () =>
      reports.filter((report) => {
        if (ticker && report.ticker !== ticker) return false;
        if (from && report.reportDate < from) return false;
        if (to && report.reportDate > to) return false;
        if (unreadOnly && report.isRead) return false;
        if (favoriteOnly && !report.isFavorite) return false;
        if (importance > 0 && report.importance < importance) return false;
        if (sentiment && report.sentiment !== sentiment) return false;
        if (category && !report.articles.some((article) => article.category === category)) return false;
        if (!text) return true;
        const haystack = [
          report.ticker,
          report.companyName,
          report.headline,
          report.summary,
          ...report.articles.map((article) => `${article.title} ${article.summary} ${article.sourceName}`),
        ]
          .join('\n')
          .toLowerCase();
        return haystack.includes(text);
      }),
    [category, favoriteOnly, from, importance, reports, sentiment, text, ticker, to, unreadOnly],
  );

  const matchedArticles = useMemo<ArticleHit[]>(() => {
    const list: ArticleHit[] = [];
    for (const report of matchedReports) {
      for (const article of report.articles) {
        if (category && article.category !== category) continue;
        if (importance > 0 && article.importance < importance) continue;
        if (sentiment && article.sentiment !== sentiment) continue;
        if (text) {
          const haystack = `${article.title} ${article.summary} ${article.sourceName} ${report.ticker} ${report.companyName}`.toLowerCase();
          if (!haystack.includes(text)) continue;
        }
        list.push({
          article,
          reportId: report.reportId,
          reportDate: report.reportDate,
          ticker: report.ticker,
          companyName: report.companyName,
        });
      }
    }
    return list.sort(
      (a, b) =>
        b.reportDate.localeCompare(a.reportDate) || b.article.importance - a.article.importance,
    );
  }, [category, importance, matchedReports, sentiment, text]);

  const filtersActive =
    Boolean(ticker || from || to || category || sentiment) || importance > 0 || unreadOnly || favoriteOnly;

  const reset = () => {
    setTicker('');
    setFrom('');
    setTo('');
    setCategory('');
    setImportance(0);
    setSentiment('');
    setUnreadOnly(false);
    setFavoriteOnly(false);
  };

  return (
    <>
      <Header
        title="検索"
        subtitle="銘柄・企業名・記事タイトルを横断して探せます"
        right={
          <IconButton
            label="絞り込み"
            onClick={() => setShowFilters((current) => !current)}
            className={filtersActive ? 'text-brand-500 dark:text-brand-300' : undefined}
          >
            <SlidersHorizontal size={22} />
          </IconButton>
        }
      >
        <div className="px-4 pb-3">
          <div className="flex items-center gap-2 rounded-card border border-line bg-surface px-3 dark:border-[#333d49] dark:bg-[#1b222a]">
            <Search size={18} className="shrink-0 text-ink-sub" aria-hidden />
            <input
              className="min-h-tap w-full bg-transparent text-base text-ink outline-none dark:text-[#e6eaef]"
              placeholder="銘柄・企業名・記事タイトル"
              value={query}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
      </Header>

      {showFilters ? (
        <div className="card mx-4 mt-3 p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm text-ink dark:text-[#e6eaef]">銘柄</span>
              <select className={fieldClass} value={ticker} onChange={(event) => setTicker(event.target.value)}>
                <option value="">すべて</option>
                {subscriptions.map((entry) => (
                  <option key={entry.ticker} value={entry.ticker}>
                    {entry.ticker}（{entry.companyName}）
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm text-ink dark:text-[#e6eaef]">ニュースカテゴリー</span>
              <select
                className={fieldClass}
                value={category}
                onChange={(event) => setCategory(event.target.value as NewsCategory | '')}
              >
                <option value="">すべて</option>
                {NEWS_CATEGORIES.map((key) => (
                  <option key={key} value={key}>
                    {CATEGORY_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm text-ink dark:text-[#e6eaef]">開始日</span>
              <input type="date" className={fieldClass} value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm text-ink dark:text-[#e6eaef]">終了日</span>
              <input type="date" className={fieldClass} value={to} onChange={(event) => setTo(event.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm text-ink dark:text-[#e6eaef]">重要度</span>
              <select
                className={fieldClass}
                value={importance}
                onChange={(event) => setImportance(Number(event.target.value))}
              >
                <option value={0}>すべて</option>
                <option value={2}>◎高・○中のみ</option>
                <option value={3}>◎高のみ</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm text-ink dark:text-[#e6eaef]">評価</span>
              <select
                className={fieldClass}
                value={sentiment}
                onChange={(event) => setSentiment(event.target.value as Sentiment | '')}
              >
                <option value="">すべて</option>
                {SENTIMENT_FILTERS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3 dark:border-[#2a333d]">
            <span className="text-sm text-ink dark:text-[#e6eaef]">未読のみ</span>
            <Switch checked={unreadOnly} onChange={setUnreadOnly} label="未読のみ" />
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-sm text-ink dark:text-[#e6eaef]">お気に入りのみ</span>
            <Switch checked={favoriteOnly} onChange={setFavoriteOnly} label="お気に入りのみ" />
          </div>

          <Button className={cx('mt-3 w-full')} onClick={reset} disabled={!filtersActive}>
            絞り込みを解除
          </Button>
        </div>
      ) : null}

      {reports.length === 0 ? (
        <StateBlock
          title="レポートがまだありません"
          description="銘柄を追加してレポートが作成されると、ここから横断的に検索できます。"
        />
      ) : (
        <>
          <SectionTitle>レポート（{matchedReports.length} 件）</SectionTitle>
          {matchedReports.length === 0 ? (
            <StateBlock title="条件に合うレポートはありません" description="検索語や絞り込み条件を変えてお試しください。" />
          ) : (
            <ReportListPanel
              reports={matchedReports}
              showTicker
              onOpen={onOpenReport}
              onToggleFavorite={(report) => void toggleReportFavorite(report.reportId)}
            />
          )}

          <SectionTitle>ニュース（{matchedArticles.length} 件）</SectionTitle>
          {matchedArticles.length === 0 ? (
            <StateBlock title="条件に合うニュースはありません" description="カテゴリーや重要度の条件を緩めてお試しください。" />
          ) : (
            <div className="card mx-4 mb-4 overflow-hidden">
              {matchedArticles.slice(0, 200).map((hit, index) => (
                <ArticleRow
                  key={`${hit.reportId}-${hit.article.dedupeHash}-${index}`}
                  hit={hit}
                  onOpenReport={() => {
                    const report = reports.find((entry) => entry.reportId === hit.reportId);
                    if (report) onOpenReport(report);
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

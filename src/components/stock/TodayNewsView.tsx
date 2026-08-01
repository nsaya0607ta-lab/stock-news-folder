'use client';

/** 今日のニュース。追跡中の全銘柄を横断して、当日のレポート内容を表示する。 */
import { useMemo, useState } from 'react';
import { MessageSquareText, RefreshCw } from 'lucide-react';
import { Button, IconButton, SectionTitle, Spinner } from '@/components/ui/Primitives';
import { Header } from '@/components/views/Header';
import { useStock, todayKey } from '@/store/StockStore';
import type { StockReportEntry } from '@/lib/stock/types';
import { ArticleRow, type ArticleHit } from './ArticleRow';
import { ReportListPanel } from './ReportList';
import { StateBlock, formatDate } from './StockBits';

export function TodayNewsView({
  onOpenReport,
  onAskAssistant,
}: {
  onOpenReport: (report: StockReportEntry) => void;
  onAskAssistant: () => void;
}) {
  const { reports, subscriptions, importScheduled, toggleReportFavorite, cloudReady } = useStock();
  const [refreshing, setRefreshing] = useState(false);
  const today = todayKey();

  const todays = useMemo(
    () => reports.filter((entry) => entry.reportDate === today),
    [reports, today],
  );

  const hits = useMemo<ArticleHit[]>(() => {
    const list: ArticleHit[] = [];
    for (const report of todays) {
      for (const article of report.articles) {
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
      (a, b) => b.article.importance - a.article.importance || a.article.sourceTier - b.article.sourceTier,
    );
  }, [todays]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await importScheduled();
    } finally {
      setRefreshing(false);
    }
  };

  const openReportOf = (reportId: string) => {
    const report = reports.find((entry) => entry.reportId === reportId);
    if (report) onOpenReport(report);
  };

  return (
    <>
      <Header
        title="今日のニュース"
        subtitle={`${formatDate(today)} ／ ${todays.length} 銘柄 ・ ニュース ${hits.length} 件`}
        right={
          <IconButton label="最新の状態に更新" onClick={() => void refresh()} disabled={refreshing || !cloudReady}>
            {refreshing ? <Spinner className="h-5 w-5" /> : <RefreshCw size={20} />}
          </IconButton>
        }
      />

      {subscriptions.length === 0 ? (
        <StateBlock
          title="追跡中の銘柄がありません"
          description="銘柄を追加すると、毎日その銘柄のニュースがここに並びます。"
        />
      ) : todays.length === 0 ? (
        <StateBlock
          title="本日のレポートはまだありません"
          description={
            cloudReady
              ? '取得時刻を過ぎるとサーバー側で自動的に作成されます。すぐに試すときは、銘柄の設定から「今すぐ取得」を押してください。'
              : '定時取得にはクラウド連携が必要です。設定画面から連携してください。'
          }
        />
      ) : (
        <>
          <div className="px-4 pt-3">
            <Button variant="secondary" className="w-full" onClick={onAskAssistant}>
              <MessageSquareText size={18} />
              今日のニュースをAIに質問・要約する
            </Button>
          </div>

          <SectionTitle>本日のレポート</SectionTitle>
          <ReportListPanel
            reports={todays}
            showTicker
            onOpen={onOpenReport}
            onToggleFavorite={(report) => void toggleReportFavorite(report.reportId)}
          />

          <SectionTitle>ニュース（重要度の高い順）</SectionTitle>
          {hits.length === 0 ? (
            <StateBlock
              title="本日採用されたニュースはありません"
              description="対象期間内に、追跡中の銘柄に直接関係する重要な新規ニュースは確認できませんでした。"
            />
          ) : (
            <div className="card mx-4 mb-4 overflow-hidden">
              {hits.map((hit, index) => (
                <ArticleRow
                  key={`${hit.reportId}-${hit.article.dedupeHash}-${index}`}
                  hit={hit}
                  onOpenReport={() => openReportOf(hit.reportId)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

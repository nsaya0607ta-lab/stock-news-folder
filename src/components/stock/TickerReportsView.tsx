'use client';

/** 1銘柄のレポート一覧（新しい順）。 */
import { useMemo } from 'react';
import { ChevronLeft, RefreshCw, Settings2 } from 'lucide-react';
import { useApp } from '@/store/AppStore';
import { useStock } from '@/store/StockStore';
import { Button, IconButton, Spinner } from '@/components/ui/Primitives';
import { Header } from '@/components/views/Header';
import { FREQUENCY_LABELS } from '@/lib/stock/core/schedule.mjs';
import type { StockReportEntry } from '@/lib/stock/types';
import { ReportListPanel } from './ReportList';
import { StateBlock, TickerAvatar, formatNextRun } from './StockBits';

export function TickerReportsView({
  ticker,
  onOpenReport,
  onOpenSettings,
}: {
  ticker: string;
  onOpenReport: (report: StockReportEntry) => void;
  onOpenSettings: () => void;
}) {
  const { goBack, navigate } = useApp();
  const { subscriptions, reports, runNow, runningTicker, cloudReady, toggleReportFavorite } = useStock();

  const subscription = subscriptions.find((entry) => entry.ticker === ticker);
  const own = useMemo(
    () =>
      reports
        .filter((entry) => entry.ticker === ticker)
        .sort((a, b) => b.reportDate.localeCompare(a.reportDate)),
    [reports, ticker],
  );

  if (!subscription) {
    return (
      <>
        <Header
          title={ticker}
          left={
            <IconButton label="戻る" onClick={goBack}>
              <ChevronLeft size={22} />
            </IconButton>
          }
        />
        <StateBlock
          title="この銘柄は登録されていません"
          description="購読を削除した可能性があります。ホーム画面から登録し直してください。"
          action={<Button onClick={() => navigate({ view: 'home' })}>ホームへ戻る</Button>}
        />
      </>
    );
  }

  const running = runningTicker === ticker;

  return (
    <>
      <Header
        title={subscription.ticker}
        subtitle={subscription.companyName}
        left={
          <IconButton label="戻る" onClick={goBack}>
            <ChevronLeft size={22} />
          </IconButton>
        }
        right={
          <IconButton label="銘柄の設定" onClick={onOpenSettings}>
            <Settings2 size={22} />
          </IconButton>
        }
      />

      <div className="mx-4 mt-3 flex items-center gap-3 rounded-card border border-line bg-surface p-3 dark:border-[#2a333d] dark:bg-[#181e26]">
        <TickerAvatar ticker={subscription.ticker} size={48} />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink dark:text-[#e6eaef]">
            レポート {own.length} 件 ／ 未読 {own.filter((entry) => !entry.isRead).length} 件
          </p>
          <p className="mt-0.5 truncate text-xs text-ink-sub dark:text-[#98a3b0]">
            {subscription.enabled
              ? `${FREQUENCY_LABELS[subscription.frequency]} ${subscription.time}（${subscription.timeZone}）／ 次回 ${formatNextRun(subscription.nextRunAt)}`
              : '自動取得は停止中です'}
          </p>
          {subscription.lastError ? (
            <p className="mt-1 break-words text-xs text-pdf">前回のエラー：{subscription.lastError}</p>
          ) : null}
        </div>
        <Button
          variant="primary"
          className="h-9 min-h-0 shrink-0 px-3 text-sm"
          disabled={running || !cloudReady}
          onClick={() => void runNow(subscription.ticker)}
        >
          {running ? <Spinner className="h-4 w-4" /> : <RefreshCw size={16} />}
          今すぐ取得
        </Button>
      </div>

      {!cloudReady ? (
        <p className="mx-4 mt-2 text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
          「今すぐ取得」と定時取得には、設定画面でのクラウド連携（ログイン）が必要です。
        </p>
      ) : null}

      {own.length === 0 ? (
        <StateBlock
          title="まだレポートがありません"
          description={
            subscription.enabled
              ? `次回の取得予定は ${formatNextRun(subscription.nextRunAt)} です。すぐに試すときは「今すぐ取得」を押してください。`
              : 'この銘柄の自動取得は停止中です。設定から有効にするか、「今すぐ取得」を押してください。'
          }
        />
      ) : (
        <div className="mt-3">
          <ReportListPanel
            reports={own}
            onOpen={onOpenReport}
            onToggleFavorite={(report) => void toggleReportFavorite(report.reportId)}
          />
        </div>
      )}
    </>
  );
}

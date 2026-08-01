'use client';

/** 定期処理・手動実行の履歴。 */
import { useEffect, useState } from 'react';
import { ChevronLeft, RefreshCw } from 'lucide-react';
import { IconButton, Spinner, cx } from '@/components/ui/Primitives';
import { Header } from '@/components/views/Header';
import { useApp } from '@/store/AppStore';
import { useStock } from '@/store/StockStore';
import { RUN_STATUS_LABELS, type StockRunEntry } from '@/lib/stock/types';
import { StateBlock, formatDate, formatDateTime, formatNextRun } from './StockBits';

function statusClass(status: StockRunEntry['status']): string {
  if (status === 'failed') return 'border-[#c8342b] text-[#8c1d18] bg-[#fdeceb] dark:bg-[#3a1d1b] dark:text-[#ffb4ad]';
  if (status === 'success') return 'border-[#087647] text-[#076a40] bg-[#e9f6ef] dark:bg-[#122f22] dark:text-[#7ddaa8]';
  return 'border-line text-ink-sub bg-surface dark:border-[#333d49] dark:bg-[#1b222a] dark:text-[#98a3b0]';
}

export function RunHistoryView() {
  const { goBack } = useApp();
  const { runs, subscriptions, refreshRuns, cloudReady } = useStock();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  const reload = async () => {
    setLoading(true);
    try {
      await refreshRuns();
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Header
        title="実行履歴"
        subtitle={cloudReady ? 'サーバー側の定期処理と手動実行の結果' : '端末内に記録された実行結果'}
        left={
          <IconButton label="戻る" onClick={goBack}>
            <ChevronLeft size={22} />
          </IconButton>
        }
        right={
          <IconButton label="更新" onClick={() => void reload()} disabled={loading}>
            {loading ? <Spinner className="h-5 w-5" /> : <RefreshCw size={20} />}
          </IconButton>
        }
      />

      {runs.length === 0 ? (
        <StateBlock
          title="実行履歴はまだありません"
          description="定時取得または「今すぐ取得」を行うと、結果がここに残ります。"
        />
      ) : (
        <div className="card mx-4 my-3 overflow-hidden">
          {runs.map((run) => {
            const subscription = subscriptions.find((entry) => entry.ticker === run.ticker);
            return (
              <div key={run.runId} className="border-b border-line px-3 py-3 last:border-b-0 dark:border-[#2a333d]">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-bold text-ink dark:text-[#e6eaef]">{run.ticker}</span>
                  <span className="text-xs text-ink-sub dark:text-[#98a3b0]">{formatDate(run.runDate)}</span>
                  <span
                    className={cx(
                      'rounded-full border px-2 py-0.5 text-xs font-semibold',
                      statusClass(run.status),
                    )}
                  >
                    {RUN_STATUS_LABELS[run.status]}
                  </span>
                  <span className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-sub dark:border-[#333d49] dark:text-[#98a3b0]">
                    {run.trigger === 'manual' ? '手動' : '定時'}
                  </span>
                </div>
                <dl className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs text-ink-sub dark:text-[#98a3b0] sm:grid-cols-2">
                  <div className="flex justify-between gap-2">
                    <dt>開始</dt>
                    <dd className="text-ink dark:text-[#e6eaef]">{formatDateTime(run.startedAt)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>終了</dt>
                    <dd className="text-ink dark:text-[#e6eaef]">{formatDateTime(run.finishedAt)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>取得記事数</dt>
                    <dd className="tabular-nums text-ink dark:text-[#e6eaef]">{run.fetchedCount} 件</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>採用記事数</dt>
                    <dd className="tabular-nums text-ink dark:text-[#e6eaef]">{run.acceptedCount} 件</dd>
                  </div>
                  <div className="col-span-full flex justify-between gap-2">
                    <dt>次回実行予定</dt>
                    <dd className="text-ink dark:text-[#e6eaef]">
                      {formatNextRun(run.nextRunAt ?? subscription?.nextRunAt)}
                    </dd>
                  </div>
                </dl>
                {run.reportResult ? (
                  <p className="mt-1 break-words text-xs text-ink dark:text-[#e6eaef]">
                    レポート：{run.reportResult}
                  </p>
                ) : null}
                {run.saveResult ? (
                  <p className="mt-0.5 break-words text-xs text-ink dark:text-[#e6eaef]">
                    保存：{run.saveResult}
                  </p>
                ) : null}
                {run.error ? (
                  <p className="mt-1 break-words rounded-card bg-[#fdeceb] px-2 py-1 text-xs text-[#8c1d18] dark:bg-[#2a1918] dark:text-[#ffb4ad]">
                    エラー：{run.error}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

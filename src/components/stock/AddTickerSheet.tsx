'use client';

/**
 * 銘柄追加。
 * 一覧から選ぶ・ティッカー検索・企業名検索・直接入力の 4 通りに対応する。
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Plus, Search } from 'lucide-react';
import { BottomSheet } from '@/components/ui/Sheet';
import { Button, Spinner } from '@/components/ui/Primitives';
import { useApp } from '@/store/AppStore';
import { useStock } from '@/store/StockStore';
import { normalizeTicker, resolveTicker, searchTickers } from '@/lib/stock/core/tickers.mjs';
import { DEFAULT_SUBSCRIPTION, type StockSubscription } from '@/lib/stock/types';
import { SubscriptionForm, type SubscriptionDraft } from './SubscriptionForm';
import { TickerAvatar } from './StockBits';

function makeDraft(
  ticker: string,
  companyName: string,
  defaultTime: string,
  existing?: StockSubscription,
): SubscriptionDraft {
  return {
    ...DEFAULT_SUBSCRIPTION,
    time: defaultTime || DEFAULT_SUBSCRIPTION.time,
    ...(existing ?? {}),
    ticker,
    companyName,
    folderId: existing?.folderId ?? '',
    folderName: existing?.folderName ?? ticker,
  };
}

export function AddTickerSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { folders, settings, navigate } = useApp();
  const { subscriptions, saveSubscription, busy } = useStock();
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<SubscriptionDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setDraft(null);
      setError(null);
    }
  }, [open]);

  const subscribed = useMemo(() => new Set(subscriptions.map((entry) => entry.ticker)), [subscriptions]);
  const results = useMemo(() => searchTickers(query, 40), [query]);
  const typed = normalizeTicker(query);
  const canAddTyped = Boolean(typed) && !results.some((entry) => entry.ticker === typed);

  const start = (ticker: string, companyName: string) => {
    const resolved = resolveTicker(ticker, companyName);
    if (!resolved) {
      setError('ティッカーの形式が正しくありません。英数字で入力してください。');
      return;
    }
    setError(null);
    setDraft(
      makeDraft(
        resolved.ticker,
        resolved.companyName,
        settings.stockDefaultTime,
        subscriptions.find((entry) => entry.ticker === resolved.ticker),
      ),
    );
  };

  const submit = async () => {
    if (!draft) return;
    if (draft.frequency === 'weekly' && draft.weekdays.length === 0) {
      setError('取得する曜日を1つ以上選んでください。');
      return;
    }
    const saved = await saveSubscription(draft);
    if (!saved) return;
    onClose();
    navigate({ view: 'ticker', ticker: saved.ticker });
  };

  return (
    <BottomSheet
      open={open}
      title={draft ? `${draft.ticker} の設定` : '銘柄を追加'}
      description={
        draft
          ? '取得時刻や頻度を設定します。あとから変更できます。'
          : '一覧から選ぶか、ティッカー・企業名で検索してください。一覧にない銘柄も直接入力で追加できます。'
      }
      onClose={onClose}
      maxHeight="88vh"
      footer={
        draft ? (
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => setDraft(null)}>
              <ChevronLeft size={18} />
              銘柄を選び直す
            </Button>
            <Button variant="primary" className="flex-1" disabled={Boolean(busy)} onClick={() => void submit()}>
              {busy ? <Spinner className="h-4 w-4" /> : <Plus size={18} />}
              この設定で追加
            </Button>
          </div>
        ) : undefined
      }
    >
      {error ? (
        <p role="alert" className="mx-4 mt-2 rounded-card bg-[#fdeceb] px-3 py-2 text-sm text-[#8c1d18] dark:bg-[#2a1918] dark:text-[#ffb4ad]">
          {error}
        </p>
      ) : null}

      {draft ? (
        <SubscriptionForm draft={draft} folders={folders} onChange={(patch) => setDraft({ ...draft, ...patch })} />
      ) : (
        <>
          <div className="px-4 pb-2 pt-3">
            <div className="flex items-center gap-2 rounded-card border border-line bg-surface px-3 dark:border-[#333d49] dark:bg-[#1b222a]">
              <Search size={18} className="shrink-0 text-ink-sub" aria-hidden />
              <input
                className="min-h-tap w-full bg-transparent text-base text-ink outline-none dark:text-[#e6eaef]"
                placeholder="ティッカー・企業名で検索（例：NVDA、エヌビディア）"
                value={query}
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>

          {canAddTyped ? (
            <button
              type="button"
              onClick={() => start(typed as string, '')}
              className="flex min-h-tap w-full items-center gap-3 border-b border-line px-4 py-3 text-left active:bg-surface-sub dark:border-[#2a333d] dark:active:bg-[#232b35]"
            >
              <TickerAvatar ticker={typed as string} size={36} />
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold text-ink dark:text-[#e6eaef]">
                  「{typed}」を直接追加
                </span>
                <span className="block text-xs text-ink-sub dark:text-[#98a3b0]">
                  一覧にない銘柄です。次の画面で企業名を入力できます。
                </span>
              </span>
              <Plus size={18} className="shrink-0 text-brand-500" />
            </button>
          ) : null}

          {results.length === 0 && !canAddTyped ? (
            <p className="px-4 py-8 text-center text-sm text-ink-sub dark:text-[#98a3b0]">
              該当する銘柄が見つかりません。ティッカーを直接入力してください。
            </p>
          ) : null}

          {results.map((entry) => {
            const already = subscribed.has(entry.ticker);
            return (
              <button
                key={entry.ticker}
                type="button"
                onClick={() => start(entry.ticker, entry.companyName)}
                className="flex min-h-tap w-full items-center gap-3 border-b border-line px-4 py-3 text-left active:bg-surface-sub dark:border-[#2a333d] dark:active:bg-[#232b35]"
              >
                <TickerAvatar ticker={entry.ticker} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-base font-semibold text-ink dark:text-[#e6eaef]">
                      {entry.ticker}
                    </span>
                    {already ? (
                      <span className="rounded-full border border-line px-1.5 text-[11px] text-ink-sub dark:border-[#333d49] dark:text-[#98a3b0]">
                        追跡中
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-xs text-ink-sub dark:text-[#98a3b0]">
                    {entry.companyName}
                    {entry.companyNameJa ? `（${entry.companyNameJa}）` : ''}
                  </span>
                  <span className="block truncate text-xs text-ink-faint">
                    {entry.exchange} ／ {entry.sector}
                  </span>
                </span>
                <Plus size={18} className="shrink-0 text-brand-500" />
              </button>
            );
          })}
        </>
      )}
    </BottomSheet>
  );
}

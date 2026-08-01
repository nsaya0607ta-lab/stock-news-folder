'use client';

/** 追加後の銘柄設定。今すぐ取得と削除もここから行う。 */
import { useEffect, useState } from 'react';
import { RefreshCw, Save, Trash2 } from 'lucide-react';
import { BottomSheet, MenuRow } from '@/components/ui/Sheet';
import { Button, Spinner } from '@/components/ui/Primitives';
import { ConfirmDialog } from '@/components/dialogs/CommonDialogs';
import { useApp } from '@/store/AppStore';
import { useStock } from '@/store/StockStore';
import type { StockSubscription } from '@/lib/stock/types';
import { SubscriptionForm, type SubscriptionDraft } from './SubscriptionForm';
import { formatDateTime, formatNextRun } from './StockBits';

function toDraft(subscription: StockSubscription): SubscriptionDraft {
  const { ...rest } = subscription;
  return rest;
}

export function TickerSettingsSheet({
  ticker,
  onClose,
}: {
  ticker: string | null;
  onClose: () => void;
}) {
  const { folders } = useApp();
  const { subscriptions, reports, saveSubscription, removeSubscription, runNow, runningTicker, cloudReady, busy } =
    useStock();
  const subscription = subscriptions.find((entry) => entry.ticker === ticker) ?? null;

  const [draft, setDraft] = useState<SubscriptionDraft | null>(null);
  const [deleting, setDeleting] = useState<'settings' | 'all' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(subscription ? toDraft(subscription) : null);
    setError(null);
    setDeleting(null);
  }, [subscription]);

  const reportCount = reports.filter((entry) => entry.ticker === ticker).length;
  const running = runningTicker === ticker;

  const submit = async () => {
    if (!draft) return;
    if (draft.frequency === 'weekly' && draft.weekdays.length === 0) {
      setError('取得する曜日を1つ以上選んでください。');
      return;
    }
    const saved = await saveSubscription(draft);
    if (saved) onClose();
  };

  return (
    <>
      <BottomSheet
        open={Boolean(ticker) && Boolean(draft)}
        title={`${ticker ?? ''} の設定`}
        description={
          subscription
            ? `前回の取得 ${formatDateTime(subscription.lastRunAt)} ／ 次回 ${formatNextRun(subscription.nextRunAt)}`
            : undefined
        }
        onClose={onClose}
        maxHeight="88vh"
        footer={
          <div className="flex gap-2">
            <Button className="flex-1" onClick={onClose}>
              キャンセル
            </Button>
            <Button variant="primary" className="flex-1" disabled={Boolean(busy)} onClick={() => void submit()}>
              {busy ? <Spinner className="h-4 w-4" /> : <Save size={18} />}
              保存
            </Button>
          </div>
        }
      >
        {error ? (
          <p role="alert" className="mx-4 mt-2 rounded-card bg-[#fdeceb] px-3 py-2 text-sm text-[#8c1d18] dark:bg-[#2a1918] dark:text-[#ffb4ad]">
            {error}
          </p>
        ) : null}

        {subscription?.lastError ? (
          <p className="mx-4 mt-2 break-words rounded-card bg-[#fdeceb] px-3 py-2 text-xs text-[#8c1d18] dark:bg-[#2a1918] dark:text-[#ffb4ad]">
            前回のエラー：{subscription.lastError}
          </p>
        ) : null}

        <div className="px-4 pt-3">
          <Button
            variant="primary"
            className="w-full"
            disabled={running || !cloudReady || !ticker}
            onClick={() => ticker && void runNow(ticker)}
          >
            {running ? <Spinner className="h-4 w-4" /> : <RefreshCw size={18} />}
            今すぐ取得（定時実行を待たずに試す）
          </Button>
          {!cloudReady ? (
            <p className="mt-2 text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
              クラウド連携（ログイン）が有効なときだけ実行できます。設定画面から連携してください。
            </p>
          ) : null}
        </div>

        {draft ? (
          <SubscriptionForm
            draft={draft}
            folders={folders}
            onChange={(patch) => setDraft({ ...draft, ...patch })}
          />
        ) : null}

        <div className="mt-2 border-t border-line pt-2 dark:border-[#2a333d]">
          <MenuRow
            icon={<Trash2 size={20} />}
            label="この銘柄を削除"
            description={`保存済みのレポート ${reportCount} 件の扱いを選べます`}
            tone="danger"
            onClick={() => setDeleting('settings')}
          />
        </div>
      </BottomSheet>

      {/* 削除の確認：購読だけ消すか、レポートも消すかを選ぶ */}
      <BottomSheet
        open={deleting === 'settings'}
        title={`${ticker ?? ''} を削除`}
        description="過去に保存したレポートをどうするか選んでください。"
        onClose={() => setDeleting(null)}
      >
        <MenuRow
          icon={<Trash2 size={20} />}
          label="購読設定だけを削除"
          description={`自動取得を止めます。保存済みのレポート ${reportCount} 件はそのまま残します。`}
          onClick={() => {
            setDeleting(null);
            if (ticker) void removeSubscription(ticker, { deleteReports: false }).then(onClose);
          }}
        />
        <MenuRow
          icon={<Trash2 size={20} />}
          label="購読設定と過去のレポートを削除"
          description={`レポート ${reportCount} 件のPDFはごみ箱へ移動します（完全には削除されません）。`}
          tone="danger"
          onClick={() => setDeleting('all')}
        />
      </BottomSheet>

      <ConfirmDialog
        open={deleting === 'all'}
        title="過去のレポートも削除しますか？"
        description={`${ticker} の購読設定と、保存済みのレポート ${reportCount} 件を削除します。PDFはごみ箱へ移動するため、必要であれば元に戻せます。`}
        confirmLabel="削除する"
        tone="danger"
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          setDeleting(null);
          if (ticker) void removeSubscription(ticker, { deleteReports: true }).then(onClose);
        }}
      />
    </>
  );
}

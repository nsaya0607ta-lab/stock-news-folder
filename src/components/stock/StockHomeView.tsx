'use client';

/**
 * ホーム画面。追跡中の銘柄をフォルダーカードで並べる。
 */
import { useMemo } from 'react';
import { Bell, ChevronRight, Clock, History, Pause, Search, Star } from 'lucide-react';
import { useApp } from '@/store/AppStore';
import { useStock, todayKey } from '@/store/StockStore';
import { Button, IconButton, SectionTitle, cx } from '@/components/ui/Primitives';
import { Header } from '@/components/views/Header';
import { ARCHIVE_FOLDER_NAME, findRootFolder } from '@/lib/stock/folders';
import { FREQUENCY_LABELS } from '@/lib/stock/core/schedule.mjs';
import {
  ImportanceBadge,
  StateBlock,
  StatTile,
  TickerAvatar,
  formatDateTime,
  formatNextRun,
} from './StockBits';

export function StockHomeView({
  onAddTicker,
  onOpenNotifications,
  onOpenTickerSettings,
}: {
  onAddTicker: () => void;
  onOpenNotifications: () => void;
  onOpenTickerSettings: (ticker: string) => void;
}) {
  const { folders, navigate } = useApp();
  const { ready, cloudReady, subscriptions, reports, notifications } = useStock();

  const today = todayKey();
  const stats = useMemo(() => {
    const unreadNotices = notifications.filter((entry) => !entry.isRead).length;
    return {
      tickers: subscriptions.length,
      today: reports.filter((entry) => entry.reportDate === today).length,
      unread: reports.filter((entry) => !entry.isRead).length,
      favorite: reports.filter((entry) => entry.isFavorite).length,
      unreadNotices,
    };
  }, [notifications, reports, subscriptions.length, today]);

  const cards = useMemo(
    () =>
      subscriptions.map((subscription) => {
        const own = reports.filter((entry) => entry.ticker === subscription.ticker);
        return {
          subscription,
          total: own.length,
          unread: own.filter((entry) => !entry.isRead).length,
          latest: own[0],
        };
      }),
    [reports, subscriptions],
  );

  const archive = findRootFolder(folders, ARCHIVE_FOLDER_NAME);

  return (
    <>
      <Header
        title="株式ニュースフォルダー"
        subtitle={`追跡中 ${stats.tickers} 銘柄 ／ 本日のレポート ${stats.today} 件`}
        right={
          <div className="flex items-center">
            <IconButton label="検索" onClick={() => navigate({ view: 'search' })}>
              <Search size={22} />
            </IconButton>
            <IconButton label="通知履歴" onClick={onOpenNotifications} className="relative">
              <Bell size={22} />
              {stats.unreadNotices > 0 ? (
                <span className="absolute right-1.5 top-1.5 min-w-[16px] rounded-full bg-pdf px-1 text-[10px] font-bold leading-4 text-white">
                  {stats.unreadNotices > 99 ? '99+' : stats.unreadNotices}
                </span>
              ) : null}
            </IconButton>
          </div>
        }
      />

      <div className="flex gap-2 px-4 pt-3">
        <StatTile label="追跡中の銘柄" value={stats.tickers} suffix="銘柄" />
        <StatTile label="本日のレポート" value={stats.today} onClick={() => navigate({ view: 'today' })} />
      </div>
      <div className="flex gap-2 px-4 pt-2">
        <StatTile
          label="未読レポート"
          value={stats.unread}
          highlight
          onClick={() => navigate({ view: 'search' })}
        />
        <StatTile
          label="お気に入り"
          value={stats.favorite}
          onClick={() => navigate({ view: 'favorites' })}
        />
      </div>

      {!cloudReady ? (
        <div className="mx-4 mt-3 rounded-card border border-brand-200 bg-brand-50 px-4 py-3 dark:border-[#2c3d5c] dark:bg-[#16202e]">
          <p className="text-sm font-semibold text-ink dark:text-[#e6eaef]">
            定時取得にはクラウド連携が必要です
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
            ブラウザーを閉じていてもサーバー側でレポートを作るため、設定画面でクラウド連携（ログイン）を有効にしてください。
            連携するまでは、保存済みのレポートの閲覧だけができます。
          </p>
          <Button
            variant="primary"
            className="mt-3 h-9 min-h-0 px-3 text-sm"
            onClick={() => navigate({ view: 'settings' })}
          >
            設定を開く
          </Button>
        </div>
      ) : null}

      <SectionTitle
        action={
          <Button variant="ghost" className="h-9 min-h-0 px-2 text-sm" onClick={onAddTicker}>
            銘柄を追加
          </Button>
        }
      >
        銘柄フォルダー
      </SectionTitle>

      {!ready ? (
        <StateBlock tone="loading" title="読み込んでいます…" description="保存済みのレポートを確認しています。" />
      ) : cards.length === 0 ? (
        <StateBlock
          title="追跡中の銘柄がありません"
          description="下の「銘柄追加」から、ニュースを毎日受け取りたい銘柄を登録してください。銘柄ごとのフォルダーが自動で作られます。"
          action={
            <Button variant="primary" onClick={onAddTicker}>
              銘柄を追加する
            </Button>
          }
        />
      ) : (
        <div className="no-h-swipe grid grid-cols-1 gap-2 px-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map(({ subscription, total, unread, latest }) => (
            <div
              key={subscription.ticker}
              className={cx(
                'card flex flex-col gap-2 p-3',
                !subscription.enabled && 'opacity-70',
              )}
            >
              <button
                type="button"
                className="flex min-w-0 items-start gap-3 text-left"
                onClick={() => navigate({ view: 'ticker', ticker: subscription.ticker })}
              >
                <TickerAvatar ticker={subscription.ticker} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-lg font-bold text-ink dark:text-[#e6eaef]">
                      {subscription.ticker}
                    </span>
                    {unread > 0 ? (
                      <span className="shrink-0 rounded-full bg-brand-500 px-1.5 text-[11px] font-bold leading-5 text-white">
                        未読 {unread}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 line-clamp-2 break-words text-xs text-ink-sub dark:text-[#98a3b0]">
                    {subscription.companyName}
                  </span>
                </span>
                <ChevronRight size={18} className="mt-1 shrink-0 text-ink-faint" />
              </button>

              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-ink-sub dark:text-[#98a3b0]">
                <div className="flex justify-between gap-2">
                  <dt>レポート</dt>
                  <dd className="font-semibold tabular-nums text-ink dark:text-[#e6eaef]">{total} 件</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>未読</dt>
                  <dd className="font-semibold tabular-nums text-ink dark:text-[#e6eaef]">{unread} 件</dd>
                </div>
                <div className="col-span-2 flex items-center justify-between gap-2">
                  <dt className="flex items-center gap-1">
                    <Clock size={12} aria-hidden />
                    次回取得
                  </dt>
                  <dd className="truncate font-semibold text-ink dark:text-[#e6eaef]">
                    {subscription.enabled
                      ? `${formatNextRun(subscription.nextRunAt)}（${FREQUENCY_LABELS[subscription.frequency]}）`
                      : '停止中'}
                  </dd>
                </div>
                <div className="col-span-2 flex items-center justify-between gap-2">
                  <dt>最新レポート</dt>
                  <dd className="truncate text-ink dark:text-[#e6eaef]">
                    {latest ? formatDateTime(latest.generatedAt) : '未作成'}
                  </dd>
                </div>
              </dl>

              {latest ? (
                <p className="line-clamp-2 break-words text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
                  {latest.headline}
                </p>
              ) : null}

              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  {latest && latest.importance > 0 ? <ImportanceBadge level={latest.importance} /> : null}
                  {!subscription.enabled ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-ink-sub dark:border-[#333d49] dark:text-[#98a3b0]">
                      <Pause size={12} aria-hidden />
                      停止中
                    </span>
                  ) : null}
                </span>
                <Button
                  variant="ghost"
                  className="h-8 min-h-0 px-2 text-sm"
                  onClick={() => onOpenTickerSettings(subscription.ticker)}
                >
                  設定
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <SectionTitle>そのほか</SectionTitle>
      <div className="mx-4 mb-4 overflow-hidden rounded-card border border-line dark:border-[#2a333d]">
        <RowLink
          icon={<History size={18} />}
          label="実行履歴"
          description="定期処理の結果とエラーを確認します"
          onClick={() => navigate({ view: 'history' })}
        />
        <RowLink
          icon={<Star size={18} />}
          label="お気に入りレポート"
          description={`${stats.favorite} 件`}
          onClick={() => navigate({ view: 'favorites' })}
        />
        {archive ? (
          <RowLink
            icon={<ChevronRight size={18} />}
            label={ARCHIVE_FOLDER_NAME}
            description="株式と関係のない、以前のPDFはこちらにあります"
            onClick={() => navigate({ view: 'folder', folderId: archive.id })}
          />
        ) : null}
      </div>
    </>
  );
}

function RowLink({
  icon,
  label,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  description?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-tap w-full items-center gap-3 border-b border-line bg-surface px-4 py-3 text-left last:border-b-0 active:bg-surface-sub dark:border-[#2a333d] dark:bg-[#181e26] dark:active:bg-[#232b35]"
    >
      <span className="shrink-0 text-brand-500 dark:text-brand-300">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base text-ink dark:text-[#e6eaef]">{label}</span>
        {description ? (
          <span className="block truncate text-xs text-ink-sub dark:text-[#98a3b0]">{description}</span>
        ) : null}
      </span>
      <ChevronRight size={18} className="shrink-0 text-ink-faint" />
    </button>
  );
}

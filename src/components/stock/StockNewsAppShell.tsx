'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  Home,
  MessageSquareText,
  Newspaper,
  Plus,
  Settings as SettingsIcon,
  Star,
  X,
} from 'lucide-react';
import * as repo from '@/lib/repository';
import { toParentKey } from '@/lib/tree';
import type { PdfFileMeta } from '@/lib/types';
import type { StockReportEntry } from '@/lib/stock/types';
import { useApp } from '@/store/AppStore';
import { useStock } from '@/store/StockStore';
import { Button, IconButton, Spinner, cx } from '@/components/ui/Primitives';
import { Header } from '@/components/views/Header';
import { PdfViewer } from '@/components/viewer/PdfViewer';
import { StockHomeView } from './StockHomeView';
import { TickerReportsView } from './TickerReportsView';
import { TodayNewsView } from './TodayNewsView';
import { FavoriteReportsView } from './FavoriteReportsView';
import { NewsSearchView } from './NewsSearchView';
import { RunHistoryView } from './RunHistoryView';
import { ReportDetailView } from './ReportDetailView';
import { AddTickerSheet } from './AddTickerSheet';
import { TickerSettingsSheet } from './TickerSettingsSheet';
import { NotificationsSheet } from './NotificationsSheet';
import { NewsAssistantSheet } from './NewsAssistantSheet';
import { StockSettingsView } from './StockSettingsView';

export function StockNewsAppShell() {
  const app = useApp();
  const stock = useStock();
  const { files, folders, route, navigate, goBack, notify } = app;

  const [addTickerOpen, setAddTickerOpen] = useState(false);
  const [tickerSettings, setTickerSettings] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [reportDetail, setReportDetail] = useState<StockReportEntry | null>(null);
  const [viewer, setViewer] = useState<{ file: PdfFileMeta; blob: Blob } | null>(null);
  const [openingPdf, setOpeningPdf] = useState(false);

  const openPdf = useCallback(
    async (file: PdfFileMeta) => {
      setOpeningPdf(true);
      try {
        const blob = await repo.readBlob(file.id);
        if (!blob) {
          notify('PDF本体が端末にありません。レポート本文はアプリ内で確認できます。', 'info');
          return;
        }
        setViewer({ file, blob });
        await repo.markOpened(file.id).catch(() => undefined);
      } catch {
        notify('PDFを開けませんでした。', 'error');
      } finally {
        setOpeningPdf(false);
      }
    },
    [notify],
  );

  const openReport = useCallback(
    (report: StockReportEntry) => {
      setReportDetail(report);
      if (!report.isRead) void stock.setReportRead(report.reportId, true);
    },
    [stock],
  );

  const openReportPdf = useCallback(
    async (report: StockReportEntry) => {
      const file = report.localFileId
        ? files.find((entry) => entry.id === report.localFileId && !entry.deletedAt)
        : undefined;
      if (!file) {
        notify('このレポートのPDFは端末にありません。内容はレポート画面で確認できます。', 'info');
        return;
      }
      await openPdf(file);
    },
    [files, notify, openPdf],
  );

  const renderView = () => {
    switch (route.view) {
      case 'home':
        return (
          <StockHomeView
            onAddTicker={() => setAddTickerOpen(true)}
            onOpenNotifications={() => setNotificationsOpen(true)}
            onOpenTickerSettings={setTickerSettings}
          />
        );
      case 'ticker':
        return (
          <TickerReportsView
            ticker={route.ticker}
            onOpenReport={openReport}
            onOpenSettings={() => setTickerSettings(route.ticker)}
          />
        );
      case 'today':
        return <TodayNewsView onOpenReport={openReport} onAskAssistant={() => setAssistantOpen(true)} />;
      case 'favorites':
        return <FavoriteReportsView onOpenReport={openReport} />;
      case 'search':
        return <NewsSearchView onOpenReport={openReport} />;
      case 'history':
        return <RunHistoryView />;
      case 'settings':
        return <StockSettingsView onOpenNotifications={() => setNotificationsOpen(true)} />;
      case 'folder':
        return <ReadOnlyArchiveView folderId={route.folderId} onOpenPdf={openPdf} />;
      default:
        return (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-ink-sub dark:text-[#98a3b0]">
              この画面は株式ニュース専用版では使用しません。
            </p>
            <Button className="mt-3" onClick={() => navigate({ view: 'home' })}>
              ホームへ戻る
            </Button>
          </div>
        );
    }
  };

  if (!app.ready) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (app.fatalError) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center px-8 text-center">
        <div>
          <p className="text-lg font-semibold text-ink dark:text-[#e6eaef]">アプリを起動できません</p>
          <p className="mt-3 text-base leading-relaxed text-ink-sub dark:text-[#98a3b0]">
            {app.fatalError}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] overflow-x-hidden">
      <main
        className="mx-auto w-full max-w-3xl"
        style={{ paddingBottom: 'calc(var(--bottom-nav-height) + var(--safe-bottom) + 16px)' }}
      >
        {renderView()}
      </main>

      <BottomNav
        current={route.view}
        onHome={() => navigate({ view: 'home' })}
        onToday={() => navigate({ view: 'today' })}
        onAdd={() => setAddTickerOpen(true)}
        onFavorites={() => navigate({ view: 'favorites' })}
        onSettings={() => navigate({ view: 'settings' })}
      />

      {route.view !== 'settings' && route.view !== 'folder' ? (
        <button
          type="button"
          onClick={() => setAssistantOpen(true)}
          aria-label="ニュースAIアシスタントを開く"
          className="fixed right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-[#4c65a8] text-white shadow-fab active:scale-95"
          style={{ bottom: 'calc(var(--bottom-nav-height) + var(--safe-bottom) + 18px)' }}
        >
          <MessageSquareText size={24} />
        </button>
      ) : null}

      <AddTickerSheet open={addTickerOpen} onClose={() => setAddTickerOpen(false)} />
      <TickerSettingsSheet ticker={tickerSettings} onClose={() => setTickerSettings(null)} />
      <NotificationsSheet open={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
      <NewsAssistantSheet open={assistantOpen} onClose={() => setAssistantOpen(false)} />

      {reportDetail ? (
        <ReportDetailView
          report={stock.reports.find((entry) => entry.reportId === reportDetail.reportId) ?? reportDetail}
          onClose={() => setReportDetail(null)}
          onOpenPdf={() => void openReportPdf(reportDetail)}
          onToggleFavorite={() => void stock.toggleReportFavorite(reportDetail.reportId)}
        />
      ) : null}

      {viewer ? (
        <PdfViewer
          file={viewer.file}
          blob={viewer.blob}
          locked={false}
          onPageChange={() => undefined}
          onClose={() => setViewer(null)}
          onMemo={() => undefined}
          onMenu={() => undefined}
        />
      ) : null}

      {stock.busy || openingPdf ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[rgba(15,23,32,0.35)]">
          <div className="flex items-center gap-3 rounded-sheet bg-surface px-5 py-4 shadow-pop dark:bg-[#181e26]">
            <Spinner />
            <p className="text-base text-ink dark:text-[#e6eaef]">
              {openingPdf ? 'PDFを開いています…' : stock.busy}
            </p>
          </div>
        </div>
      ) : null}

      <Toasts />
    </div>
  );
}

function ReadOnlyArchiveView({
  folderId,
  onOpenPdf,
}: {
  folderId: string;
  onOpenPdf: (file: PdfFileMeta) => Promise<void>;
}) {
  const { folders, files, navigate, goBack } = useApp();
  const folder = folders.find((entry) => entry.id === folderId && !entry.deletedAt);

  const childFolders = useMemo(
    () =>
      folders
        .filter((entry) => !entry.deletedAt && toParentKey(entry.parentId) === folderId)
        .sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    [folderId, folders],
  );
  const childFiles = useMemo(
    () =>
      files
        .filter((entry) => !entry.deletedAt && toParentKey(entry.parentId) === folderId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [files, folderId],
  );

  if (!folder) {
    return (
      <>
        <Header
          title="旧PDFアーカイブ"
          left={
            <IconButton label="戻る" onClick={goBack}>
              <ChevronLeft size={22} />
            </IconButton>
          }
        />
        <div className="px-4 py-8 text-center">
          <p className="text-sm text-ink-sub dark:text-[#98a3b0]">フォルダーが見つかりません。</p>
          <Button className="mt-3" onClick={() => navigate({ view: 'home' })}>
            ホームへ戻る
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <Header
        title={folder.name}
        subtitle="読み取り専用アーカイブ"
        left={
          <IconButton label="戻る" onClick={goBack}>
            <ChevronLeft size={22} />
          </IconButton>
        }
      />
      <p className="mx-4 mt-3 rounded-card border border-line bg-surface px-3 py-2 text-xs leading-relaxed text-ink-sub dark:border-[#2a333d] dark:bg-[#181e26] dark:text-[#98a3b0]">
        以前のPDFを閲覧するための画面です。新規追加、名前変更、移動、編集、自動分類はできません。
      </p>

      {childFolders.length === 0 && childFiles.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-ink-sub dark:text-[#98a3b0]">
          このフォルダーは空です。
        </div>
      ) : (
        <div className="mx-4 mt-3 overflow-hidden rounded-card border border-line dark:border-[#2a333d]">
          {childFolders.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="flex min-h-tap w-full items-center gap-3 border-b divider bg-surface px-4 py-3 text-left last:border-b-0 dark:bg-[#181e26]"
              onClick={() => navigate({ view: 'folder', folderId: entry.id })}
            >
              <Folder size={21} className="shrink-0 fill-folder text-folder" />
              <span className="min-w-0 flex-1 truncate text-base text-ink dark:text-[#e6eaef]">
                {entry.name}
              </span>
              <ChevronRight size={18} className="shrink-0 text-ink-faint" />
            </button>
          ))}
          {childFiles.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="flex min-h-tap w-full items-center gap-3 border-b divider bg-surface px-4 py-3 text-left last:border-b-0 dark:bg-[#181e26]"
              onClick={() => void onOpenPdf(entry)}
            >
              <FileText size={21} className="shrink-0 text-pdf" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base text-ink dark:text-[#e6eaef]">{entry.name}</span>
                <span className="block text-xs text-ink-sub dark:text-[#98a3b0]">PDFを表示</span>
              </span>
              <ChevronRight size={18} className="shrink-0 text-ink-faint" />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function BottomNav({
  current,
  onHome,
  onToday,
  onAdd,
  onFavorites,
  onSettings,
}: {
  current: string;
  onHome: () => void;
  onToday: () => void;
  onAdd: () => void;
  onFavorites: () => void;
  onSettings: () => void;
}) {
  const item = (
    key: string,
    label: string,
    Icon: typeof Home,
    onClick: () => void,
    active: boolean,
  ) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className={cx(
        'flex min-h-tap flex-1 flex-col items-center justify-center gap-0.5 pt-1',
        active ? 'text-brand-500 dark:text-brand-300' : 'text-ink-sub dark:text-[#98a3b0]',
      )}
      aria-current={active ? 'page' : undefined}
    >
      <Icon size={22} strokeWidth={active ? 2.2 : 1.8} />
      <span className="text-xs">{label}</span>
    </button>
  );

  return (
    <nav
      aria-label="メインナビゲーション"
      className="fixed inset-x-0 bottom-0 z-30 border-t divider bg-surface/95 backdrop-blur dark:bg-[#181e26]/95"
      style={{ paddingBottom: 'var(--safe-bottom)' }}
    >
      <div className="mx-auto flex h-[var(--bottom-nav-height)] max-w-3xl items-stretch">
        {item('home', 'ホーム', Home, onHome, current === 'home' || current === 'ticker' || current === 'folder')}
        {item('today', '今日のニュース', Newspaper, onToday, current === 'today')}
        <div className="relative flex w-20 shrink-0 items-start justify-center">
          <button
            type="button"
            onClick={onAdd}
            aria-label="銘柄を追加"
            className="absolute -top-5 flex h-[58px] w-[58px] flex-col items-center justify-center rounded-full border-4 border-surface bg-brand-500 text-white shadow-fab active:bg-brand-600 dark:border-[#181e26]"
          >
            <Plus size={24} />
          </button>
          <span className="mt-[38px] text-xs text-ink-sub dark:text-[#98a3b0]">銘柄追加</span>
        </div>
        {item('favorites', 'お気に入り', Star, onFavorites, current === 'favorites')}
        {item('settings', '設定', SettingsIcon, onSettings, current === 'settings')}
      </div>
    </nav>
  );
}

function Toasts() {
  const { toasts, dismissToast } = useApp();
  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[90] flex flex-col items-center gap-2 px-4"
      style={{ bottom: 'calc(var(--bottom-nav-height) + var(--safe-bottom) + 20px)' }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={cx(
            'pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-card px-3 py-2.5 text-sm shadow-pop',
            toast.tone === 'error'
              ? 'bg-pdf text-white'
              : toast.tone === 'success'
                ? 'bg-brand-600 text-white'
                : 'bg-[#2c353f] text-white',
          )}
        >
          <span className="flex-1 leading-relaxed">{toast.message}</span>
          <IconButton label="閉じる" onClick={() => dismissToast(toast.id)} className="h-7 w-7 text-white">
            <X size={16} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

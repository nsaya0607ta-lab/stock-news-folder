'use client';

/**
 * 株式ニュース機能の状態管理。
 *
 * - 端末内（IndexedDB）を正としてレポートと購読設定を保持する
 * - ログインしている間は Firestore へ購読設定を写し、サーバー側の定期処理が読む
 * - 定期処理が作ったPDFは、起動時・復帰時に取り込む
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toMessage } from '@/lib/errors';
import { cloudIdToken } from '@/lib/firebaseCloud';
import { htmlToPdfBlob } from '@/lib/htmlToPdf';
import { nowIso } from '@/lib/naming';
import { getPageCount } from '@/lib/pdf';
import * as repo from '@/lib/repository';
import { activeFiles } from '@/lib/tree';
import { renderReportHtml } from '@/lib/stock/core/render.mjs';
import { reportNotificationText } from '@/lib/stock/core/report.mjs';
import { nextRunAt, reportPeriod, zonedParts } from '@/lib/stock/core/schedule.mjs';
import { normalizeTicker } from '@/lib/stock/core/tickers.mjs';
import {
  downloadReportPdf,
  deleteSubscription as deleteCloudSubscription,
  listCloudRuns,
  listPendingReports,
  markReportImported,
  pullSubscriptionStatus,
  pushManualReport,
  pushRun,
  pushSubscription,
} from '@/lib/stock/cloud';
import { ensureTickerFolder } from '@/lib/stock/folders';
import { STOCK_MIGRATION_VERSION, runStockMigration } from '@/lib/stock/migrate';
import * as stockStore from '@/lib/stock/store';
import type {
  StockNotification,
  StockReport,
  StockReportEntry,
  StockRunEntry,
  StockSubscription,
} from '@/lib/stock/types';
import { useApp } from './AppStore';
import { useCloud } from './CloudStore';

type StockContextValue = {
  ready: boolean;
  /** クラウド連携が有効で、ログインが済んでいるか。 */
  cloudReady: boolean;
  subscriptions: StockSubscription[];
  reports: StockReportEntry[];
  runs: StockRunEntry[];
  notifications: StockNotification[];
  /** 進行中の処理の説明（null なら何も動いていない）。 */
  busy: string | null;
  /** 「今すぐ取得」を実行中の銘柄。 */
  runningTicker: string | null;
  saveSubscription: (input: Partial<StockSubscription>) => Promise<StockSubscription | null>;
  removeSubscription: (ticker: string, options: { deleteReports: boolean }) => Promise<void>;
  runNow: (ticker: string) => Promise<void>;
  importScheduled: () => Promise<number>;
  refreshRuns: () => Promise<void>;
  setReportRead: (reportId: string, isRead: boolean) => Promise<void>;
  toggleReportFavorite: (reportId: string) => Promise<void>;
  readAllNotifications: () => Promise<void>;
  clearNotificationHistory: () => Promise<void>;
  enablePushNotifications: () => Promise<boolean>;
  reloadStock: () => Promise<void>;
};

const StockContext = createContext<StockContextValue | null>(null);

export function useStock(): StockContextValue {
  const value = useContext(StockContext);
  if (!value) throw new Error('StockProvider の外側で useStock が呼ばれました');
  return value;
}

/** 定期処理が作ったレポートを確認する間隔。 */
const IMPORT_INTERVAL_MS = 5 * 60_000;

export function StockProvider({ children }: { children: ReactNode }) {
  const app = useApp();
  const cloud = useCloud();
  const { ready: appReady, fatalError, notify, reload, refreshStorage, settings, updateSettings } = app;

  const [ready, setReady] = useState(false);
  const [subscriptions, setSubscriptions] = useState<StockSubscription[]>([]);
  const [reports, setReports] = useState<StockReportEntry[]>([]);
  const [runs, setRuns] = useState<StockRunEntry[]>([]);
  const [notifications, setNotifications] = useState<StockNotification[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [runningTicker, setRunningTicker] = useState<string | null>(null);

  const migrationDone = useRef(false);
  const importing = useRef(false);

  const uid = cloud?.user?.uid ?? null;
  const cloudReady = Boolean(cloud?.enabled && uid);

  const reloadStock = useCallback(async () => {
    const [subs, list, history, notices] = await Promise.all([
      stockStore.listSubscriptions(),
      stockStore.listReports(),
      stockStore.listRuns(),
      stockStore.listNotifications(),
    ]);
    setSubscriptions(subs);
    setReports(list);
    setRuns(history);
    setNotifications(notices);
  }, []);

  /* 起動時：データ移行 → 読み込み ----------------------------------- */
  useEffect(() => {
    if (!appReady || fatalError || migrationDone.current) return;
    migrationDone.current = true;
    let cancelled = false;

    void (async () => {
      try {
        const result = await runStockMigration(settings.stockMigrationVersion ?? 0);
        if (result.ran) {
          await updateSettings({ stockMigrationVersion: STOCK_MIGRATION_VERSION });
          await reload();
          const parts: string[] = [];
          if (result.movedReports > 0) parts.push(`既存レポート ${result.movedReports} 件を銘柄フォルダーへ移動`);
          if (result.archivedFolders > 0 || result.archivedFiles > 0) {
            parts.push(`旧データ ${result.archivedFolders + result.archivedFiles} 件を「旧PDFアーカイブ」へ整理`);
          }
          if (parts.length > 0) notify(`${parts.join('、')}しました。`, 'success');
          for (const message of result.messages) notify(message, 'error');
        }
      } catch (error) {
        notify(`データ移行に失敗しました：${toMessage(error)}`, 'error');
      }
      if (cancelled) return;
      await reloadStock();
      // 端末から消えたPDFへの参照を外し、一覧の「PDFなし」表示を正しく保つ。
      const snapshot = await repo.refresh();
      const ids = new Set(activeFiles(snapshot.files).map((file) => file.id));
      if ((await stockStore.detachMissingFiles(ids)) > 0) await reloadStock();
      if (!cancelled) setReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [appReady, fatalError, notify, reload, reloadStock, settings.stockMigrationVersion, updateSettings]);

  /* 通知 -------------------------------------------------------------- */
  const pushNotification = useCallback(
    async (input: { ticker: string; reportId?: string; title: string; body: string }) => {
      await stockStore.addNotification(input);
      setNotifications(await stockStore.listNotifications());
      if (settings.stockPushEnabled && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const options = { body: input.body, tag: input.reportId ?? input.ticker, icon: '/icons/icon-192.png' };
        try {
          // AndroidのPWAでは Notification のコンストラクターが使えないため、
          // Service Worker 経由の表示を先に試す。
          const registration = await navigator.serviceWorker?.ready;
          if (registration) await registration.showNotification(input.title, options);
          else new Notification(input.title, options);
        } catch {
          try {
            new Notification(input.title, options);
          } catch {
            // 通知を出せない環境でも、アプリ内の通知履歴には残っている。
          }
        }
      }
    },
    [settings.stockPushEnabled],
  );

  const enablePushNotifications = useCallback(async () => {
    if (typeof Notification === 'undefined') {
      notify('この環境では通知に対応していません。アプリ内の通知履歴でご確認ください。', 'info');
      return false;
    }
    const permission =
      Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    const granted = permission === 'granted';
    await updateSettings({ stockPushEnabled: granted });
    if (!granted) notify('通知が許可されませんでした。アプリ内の通知履歴でご確認ください。', 'info');
    return granted;
  }, [notify, updateSettings]);

  /* 購読設定 ---------------------------------------------------------- */
  const saveSubscription = useCallback(
    async (input: Partial<StockSubscription>) => {
      const ticker = normalizeTicker(input.ticker);
      if (!ticker) {
        notify('ティッカーの形式が正しくありません。英数字で入力してください。', 'error');
        return null;
      }
      try {
        setBusy(`${ticker} を保存しています…`);
        // 銘柄フォルダーは購読と同時に必ず用意する。
        const folder = input.folderId
          ? (await repo.refresh()).folders.find((entry) => entry.id === input.folderId && !entry.deletedAt)
          : undefined;
        const target = folder ?? (await ensureTickerFolder(ticker));
        const saved = await stockStore.saveSubscription({
          ...input,
          ticker,
          folderId: target.id,
          folderName: target.name,
        });
        await reload();
        await reloadStock();
        if (uid) {
          await pushSubscription(uid, saved).catch((error) => {
            notify(`クラウドへの登録に失敗しました：${toMessage(error)}`, 'error');
          });
        }
        return saved;
      } catch (error) {
        notify(toMessage(error), 'error');
        return null;
      } finally {
        setBusy(null);
      }
    },
    [notify, reload, reloadStock, uid],
  );

  const removeSubscription = useCallback(
    async (ticker: string, options: { deleteReports: boolean }) => {
      const symbol = normalizeTicker(ticker);
      if (!symbol) return;
      try {
        setBusy(`${symbol} の設定を削除しています…`);
        await stockStore.removeSubscription(symbol);
        if (uid) await deleteCloudSubscription(uid, symbol).catch(() => undefined);

        if (options.deleteReports) {
          // 過去レポートも消す場合でも、PDFはごみ箱へ移すだけにする。
          const removed = await stockStore.removeReportsOfTicker(symbol);
          for (const entry of removed) {
            if (entry.localFileId) await repo.trashFile(entry.localFileId).catch(() => undefined);
          }
          await reload();
        }
        await reloadStock();
        notify(
          options.deleteReports
            ? `${symbol} の購読と過去レポートを削除しました（PDFはごみ箱にあります）。`
            : `${symbol} の購読を停止しました。過去のレポートは残しています。`,
          'success',
        );
      } catch (error) {
        notify(toMessage(error), 'error');
      } finally {
        setBusy(null);
      }
    },
    [notify, reload, reloadStock, uid],
  );

  /* レポートの保存（手動・自動で共通） --------------------------------- */
  const storeReport = useCallback(
    async (
      report: StockReport,
      options: { folderId: string; blob: Blob | null; saveError?: string },
    ): Promise<StockReportEntry> => {
      // 同じ日に作り直した場合はファイルを増やさず、版番号を上げて内容を差し替える。
      const previous = (await stockStore.listReports()).find(
        (entry) => entry.reportId === report.reportId,
      );
      const version = previous ? (previous.version ?? 1) + 1 : (report.version ?? 1);

      let localFileId: string | undefined;
      if (options.blob) {
        const pageCount = await getPageCount(options.blob).catch(() => undefined);
        const meta = await repo.addPdf(options.blob, report.fileName, {
          parentId: options.folderId,
          // 同じ日の再生成はファイルを増やさず内容を差し替える。
          onDuplicate: 'overwrite',
          pageCount,
          origin: 'report',
          sharedFrom: '株式ニュースフォルダー',
        });
        await repo.updateFile(meta.id, {
          tags: [...new Set([report.ticker, '株式レポート'])],
          importance: report.importance >= 3 ? 3 : report.importance >= 2 ? 2 : 1,
        });
        localFileId = meta.id;
      }

      const entry: StockReportEntry = {
        ...report,
        version,
        localFileId,
        folderId: options.folderId,
        isRead: false,
        isFavorite: false,
        savedAt: nowIso(),
        saveError: options.saveError,
      };
      const saved = await stockStore.saveReport(entry);
      return saved;
    },
    [],
  );

  /* 今すぐ取得 -------------------------------------------------------- */
  const runNow = useCallback(
    async (ticker: string) => {
      const symbol = normalizeTicker(ticker);
      const subscription = subscriptions.find((entry) => entry.ticker === symbol);
      if (!symbol || !subscription) return;
      if (!cloudReady) {
        notify('「今すぐ取得」にはクラウド連携（ログイン）が必要です。設定画面から連携してください。', 'error');
        return;
      }

      const runDate = zonedParts(new Date(), subscription.timeZone).date;
      const period = reportPeriod(subscription, runDate);
      const startedAt = nowIso();
      const runId = `${symbol}_${runDate.replaceAll('-', '')}_manual`;
      setRunningTicker(symbol);
      setBusy(`${symbol} のニュースを取得しています…`);

      const recordRun = async (patch: Partial<StockRunEntry>) => {
        const entry: StockRunEntry = {
          runId,
          ticker: symbol,
          companyName: subscription.companyName,
          runDate,
          status: 'failed',
          trigger: 'manual',
          startedAt,
          finishedAt: nowIso(),
          fetchedCount: 0,
          acceptedCount: 0,
          reportResult: '',
          saveResult: '',
          nextRunAt: nextRunAt({ ...subscription, lastRunDate: runDate }) ?? undefined,
          ...patch,
        };
        await stockStore.saveRun(entry);
        setRuns(await stockStore.listRuns());
        if (uid) await pushRun(uid, entry).catch(() => undefined);
      };

      try {
        const token = await cloudIdToken();
        const response = await fetch('/api/stock/report', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            ticker: symbol,
            companyName: subscription.companyName,
            reportDate: runDate,
            periodFrom: period.from,
            periodTo: period.to,
            language: subscription.language,
            detail: subscription.detail,
            maxArticles: subscription.maxArticles,
            includeQuote: subscription.includeQuote,
          }),
        });
        const data = (await response.json().catch(() => ({}))) as { report?: StockReport; error?: string };
        if (!response.ok || !data.report) {
          throw new Error(data.error || 'ニュースを取得できませんでした。');
        }
        const report = data.report;

        // ニュースが無い日は、既定では中身のないPDFを作らない。
        if (report.articleCount === 0 && subscription.emptyDayPolicy !== 'report') {
          await recordRun({
            status: 'skipped',
            fetchedCount: report.fetchedCount,
            acceptedCount: 0,
            reportResult: '対象期間内に重要な新規ニュースはありませんでした',
            saveResult: 'レポートは作成していません',
          });
          await stockStore.patchSubscription(symbol, { lastRunDate: runDate, lastRunStatus: 'success' });
          await reloadStock();
          await pushNotification({
            ticker: symbol,
            title: `${symbol} の新着ニュースはありません`,
            body: '対象期間内に重要な新規ニュースはありませんでした。',
          });
          notify(`${symbol}：対象期間内に重要な新規ニュースはありませんでした。`, 'info');
          return;
        }

        setBusy(`${symbol} のレポートPDFを作成しています…`);
        let blob: Blob | null = null;
        let saveError: string | undefined;
        try {
          blob = await htmlToPdfBlob(renderReportHtml(report), { avoid: ['.news', '.card', 'table', 'tr'] });
        } catch (error) {
          // PDFを作れなくても、レポートの内容はアプリ内で読めるようにする。
          saveError = toMessage(error);
        }

        const folder = await ensureTickerFolder(symbol);
        const entry = await storeReport(report, { folderId: folder.id, blob, saveError });
        await stockStore.patchSubscription(symbol, { lastRunDate: runDate, lastRunStatus: 'success' });
        await reload();
        await reloadStock();
        void refreshStorage();

        await recordRun({
          status: saveError ? 'failed' : 'success',
          fetchedCount: report.fetchedCount,
          acceptedCount: report.acceptedCount,
          reportResult: `ニュース ${report.articleCount} 件を採用`,
          saveResult: saveError ? `PDFの作成に失敗（内容は保存済み）：${saveError}` : `「${folder.name}」へ保存`,
          error: saveError,
        });
        if (uid) await pushManualReport(uid, entry).catch(() => undefined);

        await pushNotification({
          ticker: symbol,
          reportId: report.reportId,
          title: `${symbol} のレポートを作成しました`,
          body: reportNotificationText(report),
        });
        notify(`${symbol} のレポートを「${folder.name}」へ保存しました。`, 'success');
      } catch (error) {
        const message = toMessage(error);
        await recordRun({ status: 'failed', reportResult: '取得に失敗', saveResult: '未保存', error: message });
        await stockStore.patchSubscription(symbol, { lastRunDate: runDate, lastRunStatus: 'failed', lastError: message });
        await reloadStock();
        notify(`${symbol} の取得に失敗しました：${message}`, 'error');
      } finally {
        setRunningTicker(null);
        setBusy(null);
      }
    },
    [cloudReady, notify, pushNotification, refreshStorage, reload, reloadStock, storeReport, subscriptions, uid],
  );

  /* 定期処理が作ったレポートの取り込み --------------------------------- */
  const importScheduled = useCallback(async (): Promise<number> => {
    if (!uid || !cloudReady || importing.current) return 0;
    importing.current = true;
    let imported = 0;
    try {
      const pending = await listPendingReports(uid);
      for (const item of pending) {
        try {
          if (!item.objectPath) continue;
          const folder = await ensureTickerFolder(item.ticker);
          const blob = await downloadReportPdf(item.objectPath);
          if (!repo.isPdf(blob, item.fileName)) continue;
          const entry = await storeReport(item, { folderId: folder.id, blob });
          if (entry.localFileId) await markReportImported(uid, item.reportId, entry.localFileId);
          await pushNotification({
            ticker: item.ticker,
            reportId: item.reportId,
            title: `${item.ticker} のレポートを作成しました`,
            body: reportNotificationText(item),
          });
          imported += 1;
        } catch (error) {
          // 1件の失敗でほかのレポートの取り込みを止めない。
          console.error('レポートの取り込みに失敗:', toMessage(error));
        }
      }
      if (imported > 0) {
        await reload();
        await reloadStock();
        void refreshStorage();
        notify(`新しいレポートを ${imported} 件取り込みました。`, 'success');
      }
    } catch (error) {
      console.error('レポート一覧の確認に失敗:', toMessage(error));
    } finally {
      importing.current = false;
    }
    return imported;
  }, [cloudReady, notify, pushNotification, refreshStorage, reload, reloadStock, storeReport, uid]);

  /** サーバー側で記録された実行結果を読み戻す。 */
  const refreshRuns = useCallback(async () => {
    if (!uid || !cloudReady) {
      setRuns(await stockStore.listRuns());
      return;
    }
    try {
      const [local, remote, status] = await Promise.all([
        stockStore.listRuns(),
        listCloudRuns(uid),
        pullSubscriptionStatus(uid),
      ]);
      const merged = new Map(local.map((entry) => [entry.runId, entry]));
      for (const entry of remote) merged.set(entry.runId, { ...merged.get(entry.runId), ...entry });
      setRuns(
        [...merged.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))),
      );
      for (const [ticker, patch] of Object.entries(status)) {
        await stockStore.patchSubscription(ticker, patch);
      }
      setSubscriptions(await stockStore.listSubscriptions());
    } catch (error) {
      console.error('実行履歴を取得できませんでした:', toMessage(error));
      setRuns(await stockStore.listRuns());
    }
  }, [cloudReady, uid]);

  /* 起動時・復帰時に取り込む ------------------------------------------ */
  useEffect(() => {
    if (!ready || !cloudReady) return;
    void importScheduled();
    void refreshRuns();
    const timer = window.setInterval(() => void importScheduled(), IMPORT_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void importScheduled();
    };
    const onOnline = () => void importScheduled();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [cloudReady, importScheduled, ready, refreshRuns]);

  /* ログイン直後に、端末内の購読設定をクラウドへ写す -------------------- */
  useEffect(() => {
    if (!ready || !uid || !cloudReady || subscriptions.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const subscription of subscriptions) {
        if (cancelled) return;
        await pushSubscription(uid, subscription).catch(() => undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 購読内容が変わったときだけ送り直す。
  }, [cloudReady, ready, subscriptions, uid]);

  /* レポートの状態 ----------------------------------------------------- */
  const setReportRead = useCallback(
    async (reportId: string, isRead: boolean) => {
      const updated = await stockStore.patchReport(reportId, { isRead });
      if (updated?.localFileId) {
        await repo.updateFile(updated.localFileId, { isRead }, { touch: false }).catch(() => undefined);
      }
      setReports(await stockStore.listReports());
    },
    [],
  );

  const toggleReportFavorite = useCallback(
    async (reportId: string) => {
      const current = (await stockStore.listReports()).find((entry) => entry.reportId === reportId);
      if (!current) return;
      const updated = await stockStore.patchReport(reportId, { isFavorite: !current.isFavorite });
      if (updated?.localFileId) {
        await repo
          .updateFile(updated.localFileId, { isFavorite: updated.isFavorite }, { touch: false })
          .catch(() => undefined);
      }
      setReports(await stockStore.listReports());
      await reload();
    },
    [reload],
  );

  const readAllNotifications = useCallback(async () => {
    await stockStore.markNotificationsRead();
    setNotifications(await stockStore.listNotifications());
  }, []);

  const clearNotificationHistory = useCallback(async () => {
    await stockStore.clearNotifications();
    setNotifications(await stockStore.listNotifications());
  }, []);

  const value = useMemo<StockContextValue>(
    () => ({
      ready,
      cloudReady,
      subscriptions,
      reports,
      runs,
      notifications,
      busy,
      runningTicker,
      saveSubscription,
      removeSubscription,
      runNow,
      importScheduled,
      refreshRuns,
      setReportRead,
      toggleReportFavorite,
      readAllNotifications,
      clearNotificationHistory,
      enablePushNotifications,
      reloadStock,
    }),
    [
      busy,
      clearNotificationHistory,
      cloudReady,
      enablePushNotifications,
      importScheduled,
      notifications,
      readAllNotifications,
      ready,
      refreshRuns,
      reloadStock,
      removeSubscription,
      reports,
      runNow,
      runningTicker,
      runs,
      saveSubscription,
      setReportRead,
      subscriptions,
      toggleReportFavorite,
    ],
  );

  return <StockContext.Provider value={value}>{children}</StockContext.Provider>;
}

/** 一覧に出すための、フォルダー単位の集計。 */
export function summarizeTicker(
  subscription: StockSubscription,
  reports: StockReportEntry[],
): {
  total: number;
  unread: number;
  latest?: StockReportEntry;
} {
  const own = reports.filter((entry) => entry.ticker === subscription.ticker);
  return {
    total: own.length,
    unread: own.filter((entry) => !entry.isRead).length,
    latest: own[0],
  };
}

/** 今日（Asia/Tokyo）の日付キー。 */
export function todayKey(timeZone = 'Asia/Tokyo'): string {
  return zonedParts(new Date(), timeZone).date;
}

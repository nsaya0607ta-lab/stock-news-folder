'use client';

/**
 * クラウド保管の実行制御。
 *
 * - ログイン状態と進捗を React 側へ配る
 * - アプリ起動時 / オンライン復帰時 / 画面表示の復帰時に対象ファイルを処理する
 * - PDF を開くときの「必要なら取得する」入り口を提供する
 *
 * クラウド保管が OFF (既定) のあいだは Firebase SDK すら読み込まないため、
 * これまでどおり完全に端末内だけで動く。
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
import {
  drainDeleteQueue,
  ensureUser,
  evictLocalCache,
  fetchFromCloud,
  isOnline,
  recoverInterrupted,
  restoreAllToDevice,
  summarize,
  uploadToCloud,
  type CloudStats,
} from '@/lib/cloudStorage';
import { dropForeignDeletes, readDeleteQueue } from '@/lib/cloudQueue';
import { canUploadNow, pickEvictCandidates, pickUploadCandidates } from '@/lib/cloudSync';
import {
  cloudSignIn,
  cloudSignOut,
  cloudSignUp,
  cloudErrorMessage,
  subscribeCloudAuth,
  type CloudUser,
} from '@/lib/firebaseCloud';
import { AppError, toMessage } from '@/lib/errors';
import { claimLocalMemos, setMemoOwnerId } from '@/lib/memos';
import { claimLocalRules } from '@/lib/classifyRules';
import { nowIso } from '@/lib/naming';
import * as repo from '@/lib/repository';
import { isInCloud, storageStateOf, type PdfFileMeta } from '@/lib/types';
import { useApp } from './AppStore';

export type CloudActivity = { phase: 'upload' | 'download'; percent: number };

/** 自動実行の最短間隔。画面の表示/非表示を繰り返しても連打にならないようにする。 */
const AUTO_SYNC_INTERVAL = 60_000;

type CloudContextValue = {
  /** クラウド保管が使える状態か (ON かつログイン済み)。 */
  active: boolean;
  enabled: boolean;
  user: CloudUser | null;
  authReady: boolean;
  syncing: boolean;
  /** 進行中のファイルごとの進捗。 */
  activity: Record<string, CloudActivity>;
  stats: CloudStats;
  pendingDeletes: number;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** PDF 本体を用意する。クラウドのみの場合はダウンロードして返す。 */
  resolveBlob: (file: PdfFileMeta) => Promise<Blob>;
  /** 端末内に本体があるか (ダウンロードは行わない)。 */
  needsDownload: (file: PdfFileMeta) => boolean;
  syncNow: () => Promise<void>;
  restoreAll: () => Promise<void>;
  retry: (fileId: string) => Promise<void>;
  /** 完全削除で予約されたクラウド側の削除をすぐ実行する。 */
  flushDeletes: () => Promise<void>;
};

const CloudContext = createContext<CloudContextValue | null>(null);

/** Provider の外側でも落ちないようにする (テストや部分描画のため)。 */
export function useCloud(): CloudContextValue | null {
  return useContext(CloudContext);
}

export function useCloudRequired(): CloudContextValue {
  const value = useContext(CloudContext);
  if (!value) throw new Error('CloudProvider の外側で useCloudRequired が呼ばれました');
  return value;
}

export function CloudProvider({ children }: { children: ReactNode }) {
  const app = useApp();
  const { files, settings, notify, reload, reloadMemos, reloadRules, updateSettings } = app;

  const [user, setUser] = useState<CloudUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [activity, setActivity] = useState<Record<string, CloudActivity>>({});
  const [pendingDeletes, setPendingDeletes] = useState(0);

  // 実行中の処理から最新の値を読むための参照。
  // これらを effect の依存に入れると、ファイル一覧が変わるたびに同期が走ってしまう。
  const latest = useRef({ settings, user });
  latest.current = { settings, user };
  const syncingRef = useRef(false);
  const recoveredRef = useRef(false);

  const stats = useMemo(() => summarize(files), [files]);

  const setProgress = useCallback((fileId: string, entry: CloudActivity | null) => {
    setActivity((current) => {
      if (!entry) {
        if (!(fileId in current)) return current;
        const next = { ...current };
        delete next[fileId];
        return next;
      }
      const previous = current[fileId];
      if (previous?.phase === entry.phase && previous.percent === entry.percent) return current;
      return { ...current, [fileId]: entry };
    });
  }, []);

  const refreshPending = useCallback(async () => {
    try {
      setPendingDeletes((await readDeleteQueue()).length);
    } catch {
      /* 参考表示なので失敗しても無視 */
    }
  }, []);

  /* ---------------------------------------------------------------- */
  /* ログイン状態                                                      */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    // 機能が OFF のあいだは Firebase SDK を読み込まない
    if (!settings.cloudEnabled) {
      setAuthReady(false);
      return;
    }
    const unsubscribe = subscribeCloudAuth((nextUser, ready) => {
      setUser(nextUser);
      setAuthReady(ready);

      // メモと自動分類ルールの持ち主を切り替える。ログイン前に作ったものは、
      // この端末を使っている本人のものとして引き継ぎ、以後は別アカウントからは
      // 見えないようにする。
      setMemoOwnerId(nextUser?.uid ?? null);
      const uid = nextUser?.uid;
      if (uid) {
        void Promise.all([claimLocalMemos(uid), claimLocalRules(uid)])
          .then(() => Promise.all([reloadMemos(), reloadRules()]))
          .catch(() => undefined);
      } else {
        void reloadMemos();
        void reloadRules();
      }
    });
    return unsubscribe;
  }, [reloadMemos, reloadRules, settings.cloudEnabled]);

  /* ---------------------------------------------------------------- */
  /* 中断された処理の後始末 (起動時に 1 回)                            */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!app.ready || app.fatalError) return;
    if (recoveredRef.current) return;
    recoveredRef.current = true;
    void (async () => {
      try {
        const fixed = await recoverInterrupted();
        if (fixed > 0) await reload();
      } catch {
        // 状態の整理に失敗しても、端末内の PDF はそのまま残っている
      }
      await refreshPending();
    })();
  }, [app.fatalError, app.ready, refreshPending, reload]);

  /* ---------------------------------------------------------------- */
  /* 同期処理                                                          */
  /* ---------------------------------------------------------------- */

  const runSync = useCallback(
    async (options: { manual?: boolean } = {}) => {
      const current = latest.current.settings;
      const manual = options.manual === true;

      if (!current.cloudEnabled) {
        if (manual) notify(new AppError('CLOUD_DISABLED').message, 'error');
        return;
      }
      if (!isOnline()) {
        if (manual) notify('オフラインのため実行できません。接続してからお試しください。', 'error');
        return;
      }
      if (syncingRef.current) {
        if (manual) notify('すでに処理中です。完了までお待ちください。', 'info');
        return;
      }

      syncingRef.current = true;
      setSyncing(true);
      try {
        let uid: string;
        try {
          uid = await ensureUser();
        } catch (error) {
          if (manual) notify(toMessage(error), 'error');
          return;
        }

        // 他アカウントの残骸を持ち越さない
        await dropForeignDeletes(uid).catch(() => undefined);

        // 完全削除済み PDF のクラウド側を片付ける (冪等・失敗しても行は残る)
        await drainDeleteQueue(uid).catch(() => undefined);
        await refreshPending();

        const snapshot = await repo.refresh();
        const gate = canUploadNow(current);

        let uploaded = 0;
        let failed = 0;

        if (gate.ok) {
          const targets = pickUploadCandidates(snapshot.files, current, { manual });
          for (const file of targets) {
            if (!isOnline()) break;
            try {
              // 本体を手放す前にサムネイルを作っておく (一覧の見た目を変えないため)
              await app.getThumbnail(file.id).catch(() => null);
              const result = await uploadToCloud(uid, file.id, (percent) =>
                setProgress(file.id, { phase: 'upload', percent }),
              );
              if (result === 'uploaded') uploaded += 1;
            } catch {
              // 端末内の PDF は残っている。状態は error として記録済み。
              failed += 1;
            } finally {
              setProgress(file.id, null);
            }
          }
        } else if (manual && gate.reason) {
          notify(gate.reason, 'info');
        }

        // 使われなくなった端末内キャッシュを「クラウドのみ」へ戻す
        const evictions = pickEvictCandidates(snapshot.files, current, { manual });
        for (const file of evictions) {
          try {
            await evictLocalCache(uid, file.id);
          } catch {
            /* 消せなければ端末内に残るだけ (安全側) */
          }
        }

        await updateSettings({ cloudLastSyncAt: nowIso() });
        await reload();
        void app.refreshStorage();

        if (manual) {
          if (uploaded === 0 && failed === 0) {
            notify('クラウドへ移動する対象のPDFはありませんでした。', 'info');
          } else {
            notify(
              `${uploaded} 件のPDFをクラウドへ移動しました${failed > 0 ? `（${failed} 件は失敗したため端末内に残しています）` : ''}`,
              failed > 0 ? 'info' : 'success',
            );
          }
        } else if (failed > 0) {
          notify(
            `${failed} 件のPDFをクラウドへ移動できませんでした。PDFは端末内に残しています。`,
            'error',
          );
        }
      } finally {
        syncingRef.current = false;
        setSyncing(false);
      }
    },
    [app, notify, refreshPending, reload, setProgress, updateSettings],
  );

  /* ---------------------------------------------------------------- */
  /* 実行タイミング                                                    */
  /* ---------------------------------------------------------------- */

  // 再描画のたびに同期が走らないよう、実行本体は参照経由で呼ぶ
  const runSyncRef = useRef(runSync);
  runSyncRef.current = runSync;
  const lastAutoSyncRef = useRef(0);

  const autoSync = useCallback(() => {
    const now = Date.now();
    if (now - lastAutoSyncRef.current < AUTO_SYNC_INTERVAL) return;
    lastAutoSyncRef.current = now;
    void runSyncRef.current();
  }, []);

  const uid = user?.uid;

  useEffect(() => {
    if (!app.ready || app.fatalError) return;
    if (!settings.cloudEnabled) return;
    if (!uid) return;

    // 1. アプリ起動時 (ログインが確認できた時点)
    const timer = setTimeout(autoSync, 1500);

    // 2. オンライン復帰時
    const onOnline = () => autoSync();
    // 3. 画面表示の復帰時 (ホーム画面版を開き直したとき)
    const onVisible = () => {
      if (document.visibilityState === 'visible') autoSync();
    };

    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [app.fatalError, app.ready, autoSync, settings.cloudEnabled, uid]);

  /* ---------------------------------------------------------------- */
  /* PDF 本体の取得                                                    */
  /* ---------------------------------------------------------------- */

  const needsDownload = useCallback((file: PdfFileMeta) => {
    return isInCloud(file) && !file.localCachedAt;
  }, []);

  const resolveBlob = useCallback(
    async (file: PdfFileMeta): Promise<Blob> => {
      // まず端末内を見る (キャッシュ済みならここで終わり = 連続して開いても通信しない)
      const local = await repo.readBlob(file.id);
      if (local) return local;

      if (!file.cloudPath || storageStateOf(file) === 'local') throw new AppError('NOT_FOUND');
      if (!isOnline()) throw new AppError('CLOUD_OFFLINE');

      const uid = await ensureUser();
      try {
        setProgress(file.id, { phase: 'download', percent: 0 });
        const blob = await fetchFromCloud(uid, file.id, (percent) =>
          setProgress(file.id, { phase: 'download', percent }),
        );
        return blob;
      } finally {
        setProgress(file.id, null);
        await reload();
      }
    },
    [reload, setProgress],
  );

  /* ---------------------------------------------------------------- */
  /* 手動操作                                                          */
  /* ---------------------------------------------------------------- */

  const retry = useCallback(
    async (fileId: string) => {
      const meta = await repo.readFileMeta(fileId);
      if (!meta) return;
      if (!isOnline()) {
        notify('オフラインのため実行できません。接続してからお試しください。', 'error');
        return;
      }
      try {
        const uid = await ensureUser();
        if (isInCloud(meta) || meta.cloudPath) {
          // クラウド側にある = 取得の再試行
          await fetchFromCloud(uid, fileId, (percent) =>
            setProgress(fileId, { phase: 'download', percent }),
          );
        } else {
          await uploadToCloud(uid, fileId, (percent) =>
            setProgress(fileId, { phase: 'upload', percent }),
          );
        }
        notify('再試行しました。', 'success');
      } catch (error) {
        notify(toMessage(error), 'error');
      } finally {
        setProgress(fileId, null);
        await reload();
      }
    },
    [notify, reload, setProgress],
  );

  /**
   * 完全削除で積まれた「クラウド側の削除」をすぐに実行する。
   * ログイン中のときだけ動き、失敗しても待ち行列に残るので次回オンライン時に再試行される。
   */
  const flushDeletes = useCallback(async () => {
    if (!latest.current.user) {
      await refreshPending();
      return;
    }
    if (isOnline()) {
      try {
        const uid = await ensureUser();
        await drainDeleteQueue(uid);
      } catch {
        /* 次回オンライン時に再試行する */
      }
    }
    await refreshPending();
  }, [refreshPending]);

  const restoreAll = useCallback(async () => {
    if (!isOnline()) {
      notify('オフラインのため実行できません。接続してからお試しください。', 'error');
      return;
    }
    if (syncingRef.current) {
      notify('すでに処理中です。完了までお待ちください。', 'info');
      return;
    }
    syncingRef.current = true;
    setSyncing(true);
    try {
      const uid = await ensureUser();
      // 戻したそばから再アップロードされないよう、自動移動を止めてから実行する
      await updateSettings({ cloudEnabled: false });
      const result = await restoreAllToDevice(uid, (done, total) => {
        if (total > 0) setProgress('__restore__', { phase: 'download', percent: Math.round((done / total) * 100) });
      });
      await drainDeleteQueue(uid).catch(() => undefined);
      await refreshPending();
      await reload();
      void app.refreshStorage();
      notify(
        result.failed > 0
          ? `${result.restored} 件を端末へ戻しました（${result.failed} 件は失敗しました。クラウド上には残っています）`
          : `${result.restored} 件のPDFを端末へ戻しました。クラウド保管はオフにしました。`,
        result.failed > 0 ? 'info' : 'success',
      );
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setProgress('__restore__', null);
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [app, notify, refreshPending, reload, setProgress, updateSettings]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      try {
        const next = await cloudSignIn(email, password);
        setUser(next);
        setAuthReady(true);
      } catch (error) {
        throw new Error(cloudErrorMessage(error));
      }
    },
    [],
  );

  const signUp = useCallback(async (email: string, password: string) => {
    try {
      const next = await cloudSignUp(email, password);
      setUser(next);
      setAuthReady(true);
    } catch (error) {
      throw new Error(cloudErrorMessage(error));
    }
  }, []);

  const signOut = useCallback(async () => {
    // ログアウトしても端末内のデータには一切触れない
    await cloudSignOut();
    setUser(null);
  }, []);

  const value = useMemo<CloudContextValue>(
    () => ({
      active: settings.cloudEnabled && Boolean(user),
      enabled: settings.cloudEnabled,
      user,
      authReady,
      syncing,
      activity,
      stats,
      pendingDeletes,
      signIn,
      signUp,
      signOut,
      resolveBlob,
      needsDownload,
      syncNow: () => runSync({ manual: true }),
      restoreAll,
      retry,
      flushDeletes,
    }),
    [
      activity,
      authReady,
      flushDeletes,
      needsDownload,
      pendingDeletes,
      resolveBlob,
      restoreAll,
      retry,
      runSync,
      settings.cloudEnabled,
      signIn,
      signOut,
      signUp,
      stats,
      syncing,
      user,
    ],
  );

  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>;
}

'use client';

/**
 * アプリ本体。画面の切り替え、ダイアログの制御、PDF の取り込み処理をまとめる。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  FilePlus2,
  FolderPlus,
  Home,
  ImagePlus,
  MessageSquareText,
  Newspaper,
  Plus,
  Settings as SettingsIcon,
  Star,
  X,
} from 'lucide-react';
import {
  applyPlan,
  moveToFolder,
  planFile,
  undoClassification,
  type ClassifyPlan,
  type ClassifyRecord,
} from '@/lib/classifyRun';
import { saveRule } from '@/lib/classifyRules';
import { AppError, toMessage } from '@/lib/errors';
import { copyToClipboard, downloadBlob, isIos, openWithOtherApp, printPdf, sharePdf } from '@/lib/device';
import { ensurePdfExtension, nextAvailableName, sanitizeName, stripPdfExtension } from '@/lib/naming';
import { getPageCount } from '@/lib/pdf';
import * as repo from '@/lib/repository';
import { clearSharedFlag, hasSharedFlag, takeSharedFiles } from '@/lib/shareTarget';
import { fetchPendingReports } from '@/lib/dailyReport';
import { collectTags } from '@/lib/search';
import {
  ROOT_ID,
  UNSORTED_ID,
  isInCloud,
  type ExplorerItem,
  type FolderColor,
  type Importance,
  type ImagePdfOptions,
  type PdfFileMeta,
  type PdfOrigin,
} from '@/lib/types';
import { ROOT_NAME, descendantFolderIds, pathString, toParentKey } from '@/lib/tree';
import { useApp } from '@/store/AppStore';
import { useCloud } from '@/store/CloudStore';
import { Button, IconButton, Spinner, cx } from '@/components/ui/Primitives';
import { BottomSheet, MenuRow } from '@/components/ui/Sheet';
import { ColorSheet, ConfirmDialog, DetailsSheet, DuplicateDialog, NameDialog, SortSheet, TagMemoSheet } from '@/components/dialogs/CommonDialogs';
import { FolderPicker } from '@/components/dialogs/FolderPicker';
import { ItemMenu, type ItemMenuActions } from '@/components/dialogs/ItemMenu';
import { ClassifyConfirmSheet, ClassifyResultSheet } from '@/components/classify/ClassifySheets';
import { ImageToPdfView, type ImagePdfSaved } from '@/components/imagepdf/ImageToPdfView';
import { RuleEditor, toDraft, type RuleDraft } from '@/components/rules/RuleEditor';
import { RulesView } from '@/components/rules/RulesView';
import { PdfViewer } from '@/components/viewer/PdfViewer';
import { MemoSheet } from '@/components/memo/MemoSheet';
import { PdfEditView } from '@/components/editor/PdfEditView';
import { VersionHistorySheet } from '@/components/editor/VersionHistorySheet';
import { Onboarding } from '@/components/Onboarding';
import { FolderView } from '@/components/views/FolderView';
import { RecentView, TrashView } from '@/components/views/CollectionViews';
import { SearchView } from '@/components/views/SearchView';
import { SettingsView } from '@/components/views/SettingsView';
import { GeminiWorkspace } from '@/components/gemini/GeminiWorkspace';
import { StockHomeView } from '@/components/stock/StockHomeView';
import { TickerReportsView } from '@/components/stock/TickerReportsView';
import { TodayNewsView } from '@/components/stock/TodayNewsView';
import { FavoriteReportsView } from '@/components/stock/FavoriteReportsView';
import { NewsSearchView } from '@/components/stock/NewsSearchView';
import { RunHistoryView } from '@/components/stock/RunHistoryView';
import { ReportDetailView } from '@/components/stock/ReportDetailView';
import { AddTickerSheet } from '@/components/stock/AddTickerSheet';
import { TickerSettingsSheet } from '@/components/stock/TickerSettingsSheet';
import { NotificationsSheet } from '@/components/stock/NotificationsSheet';
import { NewsAssistantSheet } from '@/components/stock/NewsAssistantSheet';
import { useStock } from '@/store/StockStore';
import { ARCHIVE_FOLDER_NAME, findRootFolder } from '@/lib/stock/folders';
import type { StockReportEntry } from '@/lib/stock/types';

type DuplicateChoice = 'overwrite' | 'rename' | 'cancel';

type PickerState =
  | { mode: 'import'; sources: { blob: Blob; name: string }[]; origin: PdfOrigin }
  | { mode: 'move'; item: ExplorerItem }
  | { mode: 'copy'; item: ExplorerItem }
  | null;

export function AppShell() {
  const app = useApp();
  const cloud = useCloud();
  const stock = useStock();
  const {
    files,
    folders,
    memos,
    rules,
    settings,
    route,
    navigate,
    notify,
    reload,
    reloadMemos,
    reloadRules,
    run,
    updateSettings,
    refreshStorage,
    invalidateThumbnail,
  } = app;

  const pdfInput = useRef<HTMLInputElement | null>(null);
  const importDest = useRef<string>(UNSORTED_ID);
  /** 毎朝のレポート取り込みを 1 起動につき 1 回に制限するフラグ。 */
  const dailySyncDone = useRef(false);

  const [menuItem, setMenuItem] = useState<ExplorerItem | null>(null);
  const [addSheet, setAddSheet] = useState(false);
  const [picker, setPicker] = useState<PickerState>(null);
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<ExplorerItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ExplorerItem | null>(null);
  const [colorTarget, setColorTarget] = useState<ExplorerItem | null>(null);
  const [tagTarget, setTagTarget] = useState<PdfFileMeta | null>(null);
  const [detailTarget, setDetailTarget] = useState<PdfFileMeta | null>(null);
  const [sortSheet, setSortSheet] = useState(false);
  /* --- 株式ニュース --- */
  const [addTickerOpen, setAddTickerOpen] = useState(false);
  const [tickerSettings, setTickerSettings] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [reportDetail, setReportDetail] = useState<StockReportEntry | null>(null);
  /** 設定画面からGeminiの資料作成画面を開くための合図。 */
  const [geminiSignal, setGeminiSignal] = useState(0);
  /** 画像からPDFを作成する画面 (null なら閉じている)。 */
  const [imagePdf, setImagePdf] = useState<'camera' | 'gallery' | null>(null);
  /* --- 自動分類 --- */
  /** 移動前の確認待ち。先頭から 1 件ずつ確認する。 */
  const [pendingPlans, setPendingPlans] = useState<ClassifyPlan[]>([]);
  /** 確認画面で選んでいるルール。 */
  const [pendingRuleId, setPendingRuleId] = useState<string | null>(null);
  /** 自動分類で移動したPDF (元に戻す・別フォルダーへ移動に使う)。 */
  const [classifyRecords, setClassifyRecords] = useState<ClassifyRecord[]>([]);
  /** 「別フォルダーへ移動」で移動先を選んでいるPDF。 */
  const [reclassifyTarget, setReclassifyTarget] = useState<ClassifyRecord | null>(null);
  /** 自動分類の画面から開いたルール編集。 */
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const [viewer, setViewer] = useState<{ file: PdfFileMeta; blob: Blob; page?: number } | null>(
    null,
  );
  /** ビューアーで表示中のページ (メモの「このページ」表示に使う)。 */
  const [viewerPage, setViewerPage] = useState(1);
  /** メモから「該当ページへ」を押したときのページ移動要求。 */
  const [jumpTo, setJumpTo] = useState<{ page: number; seq: number } | null>(null);
  const [memoTarget, setMemoTarget] = useState<PdfFileMeta | null>(null);
  const [editor, setEditor] = useState<{ file: PdfFileMeta; blob: Blob } | null>(null);
  const [historyTarget, setHistoryTarget] = useState<PdfFileMeta | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [emptyTrashConfirm, setEmptyTrashConfirm] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<ExplorerItem | null>(null);
  const [duplicate, setDuplicate] = useState<{
    name: string;
    suggested: string;
    remaining: number;
  } | null>(null);

  const duplicateResolver = useRef<
    ((value: { choice: DuplicateChoice; applyToAll: boolean }) => void) | null
  >(null);

  const currentFolderId = route.view === 'folder' ? route.folderId : ROOT_ID;
  const knownTags = useMemo(() => collectTags(files).map((entry) => entry.tag), [files]);

  const pathOf = useCallback(
    (item: ExplorerItem) =>
      item.kind === 'folder'
        ? pathString(folders, item.folder.id)
        : `${pathString(folders, toParentKey(item.file.parentId))} ＞ ${item.file.name}`,
    [folders],
  );

  /* ---------------------------------------------------------------- */
  /* 取り込み                                                          */
  /* ---------------------------------------------------------------- */

  const askDuplicate = useCallback(
    (name: string, suggested: string, remaining: number) =>
      new Promise<{ choice: DuplicateChoice; applyToAll: boolean }>((resolve) => {
        duplicateResolver.current = resolve;
        setDuplicate({ name, suggested, remaining });
      }),
    [],
  );

  /* ---------------------------------------------------------------- */
  /* 自動分類                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 追加された PDF にルールを当てる。
   *
   * 1 件の判定に失敗しても、ほかの PDF の処理は止めない。
   * 「移動前に確認する」ルールと「自動移動しない」ルールは、移動せずに確認待ちへ積む。
   */
  const classifyFiles = useCallback(
    async (metas: PdfFileMeta[], options: { showResult?: boolean } = {}): Promise<ClassifyRecord[]> => {
      if (!settings.classifyEnabled || rules.length === 0 || metas.length === 0) return [];
      const context = {
        rules,
        strategy: settings.classifyMultiMatch,
        textPages: settings.classifyTextPages,
      };
      const applied: ClassifyRecord[] = [];
      const confirms: ClassifyPlan[] = [];

      for (const meta of metas) {
        try {
          const plan = await planFile(meta, context);
          if (!plan || plan.alreadyThere) continue;
          if (plan.needsConfirm) {
            confirms.push(plan);
            continue;
          }
          applied.push(await applyPlan(plan));
        } catch {
          // 判定・移動に失敗しても、ほかの PDF の処理は続ける
        }
      }

      if (applied.length > 0 || confirms.length > 0) await reload();
      if (confirms.length > 0) {
        // すでに確認待ちがある場合は後ろへ積む (先に出した確認を消さない)
        setPendingPlans((current) => [...current, ...confirms]);
        setPendingRuleId((current) => current ?? confirms[0].rule.id);
      }
      if (applied.length > 0 && options.showResult !== false) {
        setClassifyRecords((current) => [...current, ...applied]);
      }
      return applied;
    },
    [reload, rules, settings.classifyEnabled, settings.classifyMultiMatch, settings.classifyTextPages],
  );

  const importSources = useCallback(
    async (
      sources: { blob: Blob; name: string }[],
      destId: string,
      origin: PdfOrigin = 'file',
    ) => {
      if (sources.length === 0) return;
      setBusy(`PDFを追加しています…（0 / ${sources.length}）`);
      const addedFiles: PdfFileMeta[] = [];
      let added = 0;
      let skipped = 0;
      let applyAll: DuplicateChoice | null = null;

      try {
        const snapshot = await repo.refresh();
        const taken = new Set(
          snapshot.files
            .filter((file) => !file.deletedAt && toParentKey(file.parentId) === destId)
            .map((file) => file.name.toLowerCase()),
        );

        for (let index = 0; index < sources.length; index += 1) {
          const source = sources[index];
          setBusy(`PDFを追加しています…（${index + 1} / ${sources.length}）`);

          if (!repo.isPdf(source.blob, source.name)) {
            notify(new AppError('NOT_PDF').message, 'error');
            skipped += 1;
            continue;
          }

          const name = ensurePdfExtension(sanitizeName(source.name) || 'untitled');
          let onDuplicate: 'rename' | 'overwrite' | 'skip' = 'rename';

          if (taken.has(name.toLowerCase())) {
            const choice =
              applyAll ??
              (await askDuplicate(
                name,
                nextAvailableName(name, taken),
                sources.length - index,
              ).then((result) => {
                if (result.applyToAll) applyAll = result.choice;
                return result.choice;
              }));
            if (choice === 'cancel') {
              skipped += 1;
              continue;
            }
            onDuplicate = choice === 'overwrite' ? 'overwrite' : 'rename';
          }

          const pageCount = await getPageCount(source.blob);
          const meta = await repo.addPdf(source.blob, name, {
            parentId: destId,
            onDuplicate,
            pageCount,
            origin,
          });
          taken.add(meta.name.toLowerCase());
          addedFiles.push(meta);
          added += 1;
        }

        await reload();
        void refreshStorage();
        const destName = destId === ROOT_ID ? ROOT_NAME : pathString(folders, destId);
        notify(
          `${added} 件のPDFを「${destName}」へ追加しました${skipped > 0 ? `（${skipped} 件は追加しませんでした）` : ''}`,
          'success',
        );
        // 追加が終わってから自動分類する (移動の結果は画面上に表示する)
        await classifyFiles(addedFiles);
      } catch (error) {
        notify(toMessage(error), 'error');
      } finally {
        setBusy(null);
        setDuplicate(null);
        duplicateResolver.current = null;
      }
    },
    [askDuplicate, classifyFiles, folders, notify, refreshStorage, reload],
  );

  /** ファイル選択 → 保存先を選ばせてから取り込む。 */
  const handlePickedFiles = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      const sources = Array.from(list).map((file) => ({ blob: file, name: file.name }));
      setPicker({ mode: 'import', sources, origin: 'file' });
    },
    [],
  );

  /* 共有メニューから届いた PDF を回収する ---------------------------- */
  useEffect(() => {
    if (!app.ready || app.fatalError) return;
    let cancelled = false;
    (async () => {
      const shared = await takeSharedFiles();
      if (cancelled || shared.length === 0) return;
      if (hasSharedFlag()) clearSharedFlag();
      setPicker({ mode: 'import', sources: shared, origin: 'share' });
    })();
    return () => {
      cancelled = true;
    };
  }, [app.fatalError, app.ready]);

  /* 毎朝の学習レポートを自動で取り込む -------------------------------- */
  useEffect(() => {
    if (!app.ready || app.fatalError) return;
    if (!settings.dailyReportEnabled) return;

    const destId = settings.dailyReportFolderId;
    if (!destId) return;
    // 取り込み先が削除・ごみ箱送りになっている場合は何もしない
    // (設定画面で選び直してもらう)
    if (destId !== ROOT_ID && !folders.some((f) => f.id === destId && !f.deletedAt)) return;

    // 1 起動につき 1 回だけ。await より先に立てて開発時の二重実行も防ぐ
    if (dailySyncDone.current) return;
    dailySyncDone.current = true;

    let cancelled = false;
    (async () => {
      const pending = await fetchPendingReports(settings.importedReports);
      if (cancelled || pending.length === 0) return;

      const imported: string[] = [];
      let added = 0;
      for (const report of pending) {
        try {
          const pageCount = await getPageCount(report.blob);
          await repo.addPdf(report.blob, report.name, {
            parentId: destId,
            onDuplicate: 'skip',
            pageCount,
            origin: 'report',
          });
          imported.push(report.id);
          added += 1;
        } catch (error) {
          // すでに同名で存在する場合 (再インストール後など) も取り込み済みとして
          // 記録し、毎回ダウンロードし直さないようにする。
          // それ以外の失敗は記録せず、次回の起動で再試行させる
          if (error instanceof AppError && error.code === 'DUPLICATE_NAME') {
            imported.push(report.id);
          }
        }
      }

      if (cancelled || imported.length === 0) return;
      await updateSettings({
        // 上限を設けないと設定が際限なく膨らむため、直近 180 件だけ残す
        importedReports: [...settings.importedReports, ...imported].slice(-180),
      });
      await reload();
      void refreshStorage();
      if (added > 0) {
        notify(`毎朝の学習レポートを ${added} 件取り込みました`, 'success');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    app.fatalError,
    app.ready,
    folders,
    notify,
    refreshStorage,
    reload,
    settings.dailyReportEnabled,
    settings.dailyReportFolderId,
    settings.importedReports,
    updateSettings,
  ]);

  /* Service Worker 登録 --------------------------------------------- */
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const timer = setTimeout(() => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // 登録に失敗してもアプリ自体は動作する
      });
    }, 1200);
    return () => clearTimeout(timer);
  }, []);

  /* ---------------------------------------------------------------- */
  /* 個々の操作                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * PDF 本体を用意する。
   * クラウド保管済みで端末内に無い場合はクラウドから取得する
   * (取得済みのものは端末内キャッシュを使うので通信しない)。
   */
  const resolveBlob = useCallback(
    async (file: PdfFileMeta): Promise<Blob> => {
      const local = await repo.readBlob(file.id);
      if (local) return local;
      if (isInCloud(file)) {
        if (!cloud) throw new AppError('CLOUD_OFFLINE');
        return cloud.resolveBlob(file);
      }
      throw new AppError('NOT_FOUND');
    },
    [cloud],
  );

  const withBlob = useCallback(
    async (file: PdfFileMeta, action: (blob: Blob) => Promise<void> | void) => {
      const fetching = isInCloud(file) && !file.localCachedAt;
      if (fetching) setBusy('クラウドからPDFを取得しています…');
      try {
        const blob = await resolveBlob(file);
        await action(blob);
      } catch (error) {
        notify(toMessage(error), 'error');
      } finally {
        if (fetching) setBusy(null);
      }
    },
    [notify, resolveBlob],
  );

  const openFile = useCallback(
    async (file: PdfFileMeta, page?: number) => {
      // 1. クラウド保管済みなら、オンライン確認 → 取得 → 検証まで resolveBlob が行う
      const fetching = isInCloud(file) && !file.localCachedAt;
      setBusy(fetching ? 'クラウドからPDFを取得しています…' : 'PDFを開いています…');
      try {
        const blob = await resolveBlob(file);
        // 2. 取得できたら通常どおりビューアーで開く (メモ・検索からはそのページを開く)
        setViewer({ file, blob, page });
        setViewerPage(page ?? 1);
        setJumpTo(null);
        // 3. 最終閲覧日時を更新する (次の自動移動の起点になる)
        await repo.markOpened(file.id);
        await reload();
      } catch (error) {
        notify(toMessage(error), 'error');
      } finally {
        setBusy(null);
      }
    },
    [notify, reload, resolveBlob],
  );

  /** PDF 編集画面を開く。編集前の本体を先に用意しておく。 */
  const openEditor = useCallback(
    async (file: PdfFileMeta) => {
      const fetching = isInCloud(file) && !file.localCachedAt;
      setBusy(fetching ? 'クラウドからPDFを取得しています…' : 'PDFを開いています…');
      try {
        // 編集の直前に、ファイルが存在するかを最新の状態で確かめる
        const latest = await repo.readFileMeta(file.id);
        if (!latest || latest.deletedAt) throw new AppError('NOT_FOUND');
        const blob = await resolveBlob(latest);
        setEditor({ file: latest, blob });
      } catch (error) {
        notify(toMessage(error), 'error');
      } finally {
        setBusy(null);
      }
    },
    [notify, resolveBlob],
  );

  /** ID から最新のメタデータを読み直して処理する (作成直後の操作で使う)。 */
  const withFile = useCallback(
    async (fileId: string, action: (file: PdfFileMeta) => void | Promise<void>) => {
      const meta = await repo.readFileMeta(fileId);
      if (!meta) {
        notify(new AppError('NOT_FOUND').message, 'error');
        return;
      }
      await action(meta);
    },
    [notify],
  );

  /**
   * 画像から作った PDF を保存する。
   * 保存 → 自動分類 → 完了画面に出す情報を返す、までをここで行う。
   */
  const saveImagePdf = useCallback(
    async (input: {
      blob: Blob;
      name: string;
      folderId: string;
      formats: string[];
      pageCount: number;
    }): Promise<ImagePdfSaved | null> => {
      try {
        const meta = await repo.addPdf(input.blob, input.name, {
          parentId: input.folderId,
          onDuplicate: 'rename',
          pageCount: input.pageCount,
          origin: 'image',
          sourceFormats: input.formats,
        });
        await reload();
        void refreshStorage();

        // 作成した PDF にもルールを適用する。結果は完了画面に出すので、
        // お知らせシートは開かない。
        const applied = await classifyFiles([meta], { showResult: false });
        const record = applied.find((entry) => entry.fileId === meta.id);
        const latest = (await repo.readFileMeta(meta.id)) ?? meta;
        return {
          fileId: meta.id,
          fileName: latest.name,
          folderPath: pathString(folders, toParentKey(latest.parentId)),
          pageCount: input.pageCount,
          size: input.blob.size,
          appliedRuleName: record?.ruleName,
        };
      } catch (error) {
        notify(toMessage(error), 'error');
        return null;
      }
    },
    [classifyFiles, folders, notify, refreshStorage, reload],
  );

  /**
   * 確認待ちの先頭 1 件を処理する。
   * @param apply true なら移動する。false は「今回だけルールを適用しない」。
   */
  const applyPending = useCallback(
    async (apply: boolean) => {
      const plan = pendingPlans[0];
      setPendingPlans((current) => current.slice(1));
      setPendingRuleId(pendingPlans[1]?.rule.id ?? null);
      if (!plan || !apply) return;
      const rule = plan.matches.find((entry) => entry.id === pendingRuleId) ?? plan.rule;
      try {
        const record = await applyPlan(plan, rule);
        await reload();
        setClassifyRecords((current) => [...current, record]);
      } catch (error) {
        notify(toMessage(error), 'error');
      }
    },
    [notify, pendingPlans, pendingRuleId, reload],
  );

  /** 指定 PDF に付いているメモの件数。 */
  const memoCountOf = useCallback(
    (fileId: string) => memos.filter((memo) => memo.fileId === fileId).length,
    [memos],
  );

  /**
   * コピーを実行する。
   * クラウド保管済みの PDF は、コピー元の実体を端末へ取り戻してから複製する。
   * (コピー先が同じクラウド保存先を指してしまうと、片方の削除でもう片方まで
   *  消えてしまうため、コピーは必ず独立した「端末内の PDF」として作る)
   */
  const copyItem = useCallback(
    async (item: ExplorerItem, destId: string) => {
      try {
        if (item.kind === 'file') {
          if (isInCloud(item.file) && !item.file.localCachedAt) {
            setBusy('クラウドからPDFを取得しています…');
            await resolveBlob(item.file);
          }
          setBusy('コピーしています…');
          await repo.copyFile(item.file.id, destId);
          await reload();
          notify('PDFをコピーしました。', 'success');
          return;
        }

        const snapshot = await repo.refresh();
        const insideIds = descendantFolderIds(
          snapshot.folders.filter((folder) => !folder.deletedAt),
          item.folder.id,
        );
        const cloudOnly = snapshot.files.filter(
          (file) =>
            !file.deletedAt &&
            insideIds.has(toParentKey(file.parentId)) &&
            isInCloud(file) &&
            !file.localCachedAt,
        );

        for (let index = 0; index < cloudOnly.length; index += 1) {
          setBusy(`クラウドからPDFを取得しています…（${index + 1} / ${cloudOnly.length}）`);
          await resolveBlob(cloudOnly[index]);
        }

        setBusy('コピーしています…');
        const result = await repo.copyFolder(item.folder.id, destId);
        await reload();
        notify(
          result.skipped > 0
            ? `フォルダーをコピーしました（PDF ${result.skipped} 件は本体を取得できずコピーしていません）`
            : 'フォルダーをコピーしました。',
          result.skipped > 0 ? 'info' : 'success',
        );
      } catch (error) {
        notify(toMessage(error), 'error');
      } finally {
        setBusy(null);
        void refreshStorage();
      }
    },
    [notify, refreshStorage, reload, resolveBlob],
  );

  /* ---------------------------------------------------------------- */
  /* 株式レポート                                                      */
  /* ---------------------------------------------------------------- */

  /** レポートを開く（開いた時点で既読にする）。 */
  const openReport = useCallback(
    (report: StockReportEntry) => {
      setReportDetail(report);
      if (!report.isRead) void stock.setReportRead(report.reportId, true);
    },
    [stock],
  );

  /** レポートに紐づくPDFをビューアーで開く。 */
  const openReportPdf = useCallback(
    async (report: StockReportEntry) => {
      const file = report.localFileId ? files.find((entry) => entry.id === report.localFileId) : undefined;
      if (!file || file.deletedAt) {
        notify('このレポートのPDFは端末にありません。内容はレポート画面で確認できます。', 'info');
        return;
      }
      await openFile(file);
    },
    [files, notify, openFile],
  );

  const handlers = useMemo(
    () => ({
      onOpen: (item: ExplorerItem) => {
        if (item.kind === 'folder') navigate({ view: 'folder', folderId: item.folder.id });
        else void openFile(item.file);
      },
      onMenu: (item: ExplorerItem) => setMenuItem(item),
    }),
    [navigate, openFile],
  );

  const menuActions = useMemo<ItemMenuActions>(() => {
    const item = menuItem;
    if (!item) {
      return {
        onOpen: () => undefined,
        onRename: () => undefined,
        onMove: () => undefined,
        onCopy: () => undefined,
        onDelete: () => undefined,
        onToggleFavorite: () => undefined,
        onCopyPath: () => undefined,
      };
    }
    return {
      onOpen: () => handlers.onOpen(item),
      onRename: () => setRenameTarget(item),
      onMove: () => setPicker({ mode: 'move', item }),
      onCopy: () => setPicker({ mode: 'copy', item }),
      onDelete: () => setDeleteTarget(item),
      onToggleFavorite: () => {
        if (item.kind === 'folder') {
          void run(
            () => repo.updateFolder(item.folder.id, { isFavorite: !item.folder.isFavorite }),
            item.folder.isFavorite ? 'お気に入りを解除しました。' : 'お気に入りに登録しました。',
          );
        } else {
          void run(
            () => repo.updateFile(item.file.id, { isFavorite: !item.file.isFavorite }),
            item.file.isFavorite ? 'お気に入りを解除しました。' : 'お気に入りに登録しました。',
          );
        }
      },
      onShare:
        item.kind === 'file'
          ? () =>
              void withBlob(item.file, async (blob) => {
                const shared = await sharePdf(blob, item.file.name);
                if (!shared) {
                  downloadBlob(blob, item.file.name);
                  notify(
                    'この端末は共有シートに対応していないため、ダウンロードで書き出しました。',
                    'info',
                  );
                }
              })
          : undefined,
      onSaveToDevice:
        item.kind === 'file'
          ? () =>
              void withBlob(item.file, async (blob) => {
                if (isIos()) {
                  // iOS は共有シートの「ファイルに保存」が正規の保存経路
                  const shared = await sharePdf(blob, item.file.name);
                  if (shared) return;
                  downloadBlob(blob, item.file.name);
                  notify('新しいタブで開きます。共有ボタンから「ファイルに保存」を選んでください。', 'info');
                  return;
                }
                downloadBlob(blob, item.file.name);
                notify('ダウンロードに保存しました。', 'success');
              })
          : undefined,
      onPrint:
        item.kind === 'file'
          ? () => void withBlob(item.file, async (blob) => printPdf(blob))
          : undefined,
      onOpenWith:
        item.kind === 'file'
          ? () =>
              void withBlob(item.file, async (blob) => {
                const ok = await openWithOtherApp(blob, item.file.name);
                if (!ok) notify('他のアプリで開けませんでした。', 'error');
              })
          : undefined,
      onCopyPath: () => {
        void copyToClipboard(pathOf(item)).then((ok) =>
          notify(ok ? 'パスをコピーしました。' : 'パスをコピーできませんでした。', ok ? 'success' : 'error'),
        );
      },
      onDetails: item.kind === 'file' ? () => setDetailTarget(item.file) : undefined,
      onTags: item.kind === 'file' ? () => setTagTarget(item.file) : undefined,
      onMemo: item.kind === 'file' ? () => setMemoTarget(item.file) : undefined,
      onEdit: item.kind === 'file' ? () => void openEditor(item.file) : undefined,
      onHistory: item.kind === 'file' ? () => setHistoryTarget(item.file) : undefined,
      onColor: item.kind === 'folder' ? () => setColorTarget(item) : undefined,
      onToggleRead:
        item.kind === 'file'
          ? () =>
              void run(
                () => repo.updateFile(item.file.id, { isRead: !item.file.isRead }, { touch: false }),
                item.file.isRead ? '未閲覧にしました。' : '閲覧済みにしました。',
              )
          : undefined,
    };
  }, [handlers, menuItem, notify, openEditor, pathOf, run, withBlob]);

  /* 削除 (ごみ箱へ) --------------------------------------------------- */
  const deleteInfo = useMemo(() => {
    if (!deleteTarget) return null;
    if (deleteTarget.kind === 'file') {
      return {
        title: 'PDFを削除しますか？',
        description: `「${deleteTarget.file.name}」をごみ箱へ移動します。${settings.trashRetentionDays > 0 ? `${settings.trashRetentionDays}日後に自動で完全削除されます。` : ''}`,
      };
    }
    const inside = files.filter(
      (file) => !file.deletedAt && toParentKey(file.parentId) === deleteTarget.folder.id,
    ).length;
    const nested = folders.filter(
      (folder) => !folder.deletedAt && toParentKey(folder.parentId) === deleteTarget.folder.id,
    ).length;
    const warning =
      inside > 0 || nested > 0
        ? `このフォルダーにはPDF ${inside} 件、サブフォルダー ${nested} 件が入っています。中身もまとめてごみ箱へ移動します。`
        : '';
    return {
      title: 'フォルダーを削除しますか？',
      description: `「${deleteTarget.folder.name}」をごみ箱へ移動します。${warning}`,
    };
  }, [deleteTarget, files, folders, settings.trashRetentionDays]);

  /* ---------------------------------------------------------------- */
  /* 画面                                                              */
  /* ---------------------------------------------------------------- */

  const openAddPdf = () => {
    setAddSheet(false);
    pdfInput.current?.click();
  };

  const renderView = () => {
    switch (route.view) {
      case 'home':
        return (
          <StockHomeView
            onAddTicker={() => setAddTickerOpen(true)}
            onOpenNotifications={() => setNotificationsOpen(true)}
            onOpenTickerSettings={(ticker) => setTickerSettings(ticker)}
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
      case 'history':
        return <RunHistoryView />;
      case 'folder':
        return (
          <FolderView
            folderId={route.folderId}
            handlers={handlers}
            onOpenSort={() => setSortSheet(true)}
            onAdd={() => setAddSheet(true)}
          />
        );
      case 'recent':
        return <RecentView handlers={handlers} />;
      case 'favorites':
        return <FavoriteReportsView onOpenReport={openReport} />;
      case 'trash':
        return (
          <TrashView
            onRestoreFolder={(id) => void run(() => repo.restoreFolder(id), '元の場所へ戻しました。')}
            onRestoreFile={(id) => void run(() => repo.restoreFile(id), '元の場所へ戻しました。')}
            onPurgeFolder={(id) => {
              const folder = folders.find((entry) => entry.id === id);
              if (folder) setPurgeTarget({ kind: 'folder', folder });
            }}
            onPurgeFile={(id) => {
              const file = files.find((entry) => entry.id === id);
              if (file) setPurgeTarget({ kind: 'file', file });
            }}
            onEmptyTrash={() => setEmptyTrashConfirm(true)}
          />
        );
      case 'search':
        return <NewsSearchView onOpenReport={openReport} />;
      case 'pdfSearch':
        return (
          <SearchView handlers={handlers} onOpenMemoHit={(file, page) => void openFile(file, page)} />
        );
      case 'settings':
        return (
          <SettingsView
            onOpenPdfArchive={() => {
              const archive = findRootFolder(folders, ARCHIVE_FOLDER_NAME);
              navigate(archive ? { view: 'folder', folderId: archive.id } : { view: 'pdfSearch' });
            }}
            onOpenPdfSearch={() => navigate({ view: 'pdfSearch' })}
            onOpenGemini={() => setGeminiSignal((current) => current + 1)}
            onOpenNotifications={() => setNotificationsOpen(true)}
          />
        );
      case 'rules':
        return <RulesView />;
      default:
        return null;
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
          <p className="text-lg font-semibold text-ink dark:text-[#e6eaef]">
            アプリを起動できません
          </p>
          <p className="mt-3 text-base leading-relaxed text-ink-sub dark:text-[#98a3b0]">
            {app.fatalError}
          </p>
        </div>
      </div>
    );
  }

  // 「＋」は下部中央の「PDF追加」ボタン 1 つに統一する。
  // 右下のフローティングボタンは廃止（同じ機能のボタンが 2 つ見える状態を解消）。

  return (
    <div className="min-h-[100dvh] overflow-x-hidden">
      <main
        className="mx-auto w-full max-w-3xl"
        style={{ paddingBottom: 'calc(var(--bottom-nav-height) + var(--safe-bottom) + 16px)' }}
      >
        {renderView()}
      </main>

      {/* PDF 選択用の隠し input */}
      <input
        ref={pdfInput}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        className="hidden"
        onChange={(event) => {
          handlePickedFiles(event.target.files);
          event.target.value = '';
        }}
      />

      <BottomNav
        current={route.view}
        onHome={() => navigate({ view: 'home' })}
        onToday={() => navigate({ view: 'today' })}
        onAdd={() => setAddTickerOpen(true)}
        onFavorites={() => navigate({ view: 'favorites' })}
        onSettings={() => navigate({ view: 'settings' })}
      />

      {/* ニュースAIアシスタント（保存済みレポートへの質問・比較・要約） */}
      {route.view !== 'settings' ? (
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

      {/* 株式ニュースの各シート */}
      <AddTickerSheet open={addTickerOpen} onClose={() => setAddTickerOpen(false)} />
      <TickerSettingsSheet ticker={tickerSettings} onClose={() => setTickerSettings(null)} />
      <NotificationsSheet open={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
      <NewsAssistantSheet open={assistantOpen} onClose={() => setAssistantOpen(false)} />

      {/* Geminiの資料作成（設定画面から開く既存機能） */}
      <GeminiWorkspace showLauncher={false} openSignal={geminiSignal} />

      {reportDetail ? (
        <ReportDetailView
          report={
            stock.reports.find((entry) => entry.reportId === reportDetail.reportId) ?? reportDetail
          }
          onClose={() => setReportDetail(null)}
          onOpenPdf={() => void openReportPdf(reportDetail)}
          onToggleFavorite={() => void stock.toggleReportFavorite(reportDetail.reportId)}
        />
      ) : null}

      {/* 追加メニュー */}
      <BottomSheet
        open={addSheet}
        title="追加"
        description={
          route.view === 'folder'
            ? `保存先の候補：${pathString(folders, currentFolderId)}`
            : undefined
        }
        onClose={() => setAddSheet(false)}
      >
        <MenuRow
          icon={<FilePlus2 size={22} />}
          label="PDFを追加"
          description="ファイルアプリから選択（複数選択できます）"
          onClick={openAddPdf}
        />
        <MenuRow
          icon={<FolderPlus size={22} />}
          label="フォルダーを作成"
          onClick={() => {
            setAddSheet(false);
            setNewFolderParent(currentFolderId);
          }}
        />
        <MenuRow
          icon={<Camera size={22} />}
          label="カメラでスキャン"
          description="撮影した書類をPDFにします"
          onClick={() => {
            setAddSheet(false);
            setImagePdf('camera');
          }}
        />
        <MenuRow
          icon={<ImagePlus size={22} />}
          label="画像からPDFを作成"
          description="複数の画像を選んで1つのPDFにまとめます"
          onClick={() => {
            setAddSheet(false);
            setImagePdf('gallery');
          }}
        />
        {isIos() ? (
          <p className="px-4 py-3 text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
            iPhone・iPadでは、SafariやChromeで開いたPDFを直接このアプリへ共有することはできません。
            共有メニューから一度「ファイル」アプリに保存し、「PDFを追加」から選択してください。
          </p>
        ) : (
          <p className="px-4 py-3 text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
            ホーム画面に追加すると、他のアプリの共有メニューに「株式ニュースフォルダー」が表示され、
            PDFを直接送れるようになります。
          </p>
        )}
      </BottomSheet>

      {/* 操作メニュー */}
      <ItemMenu
        item={menuItem}
        path={menuItem ? pathOf(menuItem) : ''}
        actions={menuActions}
        memoCount={menuItem?.kind === 'file' ? memoCountOf(menuItem.file.id) : 0}
        onClose={() => setMenuItem(null)}
      />

      {/* 保存先 / 移動先 */}
      <FolderPicker
        open={picker !== null}
        title={
          picker?.mode === 'import'
            ? '保存先のフォルダーを選択'
            : picker?.mode === 'copy'
              ? 'コピー先のフォルダーを選択'
              : '移動先のフォルダーを選択'
        }
        description={
          picker?.mode === 'import'
            ? `${picker.sources.length} 件のPDFを追加します。選ばなかった場合は「未分類」に保存します。`
            : undefined
        }
        confirmLabel={picker?.mode === 'import' ? 'ここに保存' : 'ここに移動'}
        folders={folders}
        initialFolderId={picker?.mode === 'import' ? currentFolderId : currentFolderId}
        excludeFolderId={
          picker && picker.mode !== 'import' && picker.item.kind === 'folder'
            ? picker.item.folder.id
            : undefined
        }
        onClose={() => {
          if (picker?.mode === 'import') {
            // 保存先を選ばなかった場合は「未分類」へ
            const { sources, origin } = picker;
            setPicker(null);
            void importSources(sources, UNSORTED_ID, origin);
            return;
          }
          setPicker(null);
        }}
        onCreateFolder={(parentId) => setNewFolderParent(parentId)}
        onConfirm={(folderId) => {
          const state = picker;
          setPicker(null);
          if (!state) return;
          if (state.mode === 'import') {
            importDest.current = folderId;
            void importSources(state.sources, folderId, state.origin);
            return;
          }
          const { item } = state;
          if (state.mode === 'move') {
            if (item.kind === 'folder') {
              void run(() => repo.moveFolder(item.folder.id, folderId), 'フォルダーを移動しました。');
            } else {
              void run(() => repo.moveFile(item.file.id, folderId), 'PDFを移動しました。');
            }
          } else {
            void copyItem(item, folderId);
          }
        }}
      />

      {/* 新規フォルダー */}
      <NameDialog
        open={newFolderParent !== null}
        title="新しいフォルダー"
        label="フォルダー名"
        initialValue=""
        confirmLabel="作成"
        hint={
          newFolderParent
            ? `作成場所：${newFolderParent === ROOT_ID ? ROOT_NAME : pathString(folders, newFolderParent)}`
            : undefined
        }
        onClose={() => setNewFolderParent(null)}
        onSubmit={(value) => {
          const parent = newFolderParent ?? ROOT_ID;
          setNewFolderParent(null);
          void run(() => repo.createFolder(parent, value), 'フォルダーを作成しました。');
        }}
      />

      {/* 名前変更 */}
      <NameDialog
        open={renameTarget !== null}
        title="名前を変更"
        label={renameTarget?.kind === 'folder' ? 'フォルダー名' : 'ファイル名'}
        initialValue={
          renameTarget
            ? renameTarget.kind === 'folder'
              ? renameTarget.folder.name
              : stripPdfExtension(renameTarget.file.name)
            : ''
        }
        confirmLabel="変更"
        hint={renameTarget?.kind === 'file' ? '拡張子（.pdf）は自動で付きます。' : undefined}
        onClose={() => setRenameTarget(null)}
        onSubmit={(value) => {
          const target = renameTarget;
          setRenameTarget(null);
          if (!target) return;
          if (target.kind === 'folder') {
            void run(() => repo.renameFolder(target.folder.id, value), '名前を変更しました。');
          } else {
            void run(() => repo.renameFile(target.file.id, value), '名前を変更しました。');
          }
        }}
      />

      {/* 削除確認 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteInfo?.title ?? ''}
        description={deleteInfo?.description}
        confirmLabel="ごみ箱へ移動"
        tone="danger"
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (!target) return;
          if (target.kind === 'folder') {
            void run(() => repo.trashFolder(target.folder.id), 'ごみ箱へ移動しました。');
          } else {
            void run(() => repo.trashFile(target.file.id), 'ごみ箱へ移動しました。');
          }
        }}
      />

      {/* 完全削除 */}
      <ConfirmDialog
        open={purgeTarget !== null}
        title="完全に削除しますか？"
        description={
          purgeTarget
            ? `「${purgeTarget.kind === 'folder' ? purgeTarget.folder.name : purgeTarget.file.name}」を完全に削除します。この操作は取り消せません。${
                purgeTarget.kind === 'file' && isInCloud(purgeTarget.file)
                  ? 'このPDFはクラウドに保管されています。クラウド上のPDFも削除します。'
                  : ''
              }`
            : undefined
        }
        confirmLabel="完全に削除"
        tone="danger"
        onClose={() => setPurgeTarget(null)}
        onConfirm={() => {
          const target = purgeTarget;
          setPurgeTarget(null);
          if (!target) return;
          const task =
            target.kind === 'folder'
              ? run(() => repo.purgeFolder(target.folder.id), '完全に削除しました。')
              : run(() => repo.purgeFile(target.file.id), '完全に削除しました。');
          // 端末から消えたあとで、クラウド上の実体も削除する
          void task.then(() => cloud?.flushDeletes());
          void refreshStorage();
        }}
      />

      <ConfirmDialog
        open={emptyTrashConfirm}
        title="ごみ箱を空にしますか？"
        description="ごみ箱の中のPDFとフォルダーをすべて完全に削除します。この操作は取り消せません。"
        confirmLabel="空にする"
        tone="danger"
        onClose={() => setEmptyTrashConfirm(false)}
        onConfirm={() => {
          setEmptyTrashConfirm(false);
          void run(() => repo.emptyTrash(), 'ごみ箱を空にしました。').then(async () => {
            await cloud?.flushDeletes();
            await refreshStorage();
          });
        }}
      />

      {/* 表示と並べ替え */}
      <SortSheet
        open={sortSheet}
        sortKey={settings.sortKey}
        viewMode={settings.viewMode}
        foldersFirst={settings.foldersFirst}
        onClose={() => setSortSheet(false)}
        onChange={(patch) => void updateSettings(patch)}
      />

      {/* フォルダー色 */}
      <ColorSheet
        open={colorTarget !== null}
        current={colorTarget?.kind === 'folder' ? colorTarget.folder.color : undefined}
        onClose={() => setColorTarget(null)}
        onSelect={(color: FolderColor) => {
          const target = colorTarget;
          setColorTarget(null);
          if (target?.kind !== 'folder') return;
          void run(() => repo.updateFolder(target.folder.id, { color }), '色を変更しました。');
        }}
      />

      {/* タグ・メモ */}
      <TagMemoSheet
        open={tagTarget !== null}
        file={tagTarget}
        knownTags={knownTags}
        onClose={() => setTagTarget(null)}
        onSave={(patch: { tags: string[]; memo: string; importance: Importance }) => {
          const target = tagTarget;
          setTagTarget(null);
          if (!target) return;
          void run(
            () =>
              repo.updateFile(target.id, {
                tags: patch.tags,
                memo: patch.memo,
                importance: patch.importance,
              }),
            '保存しました。',
          );
        }}
      />

      {/* 詳細情報 */}
      <DetailsSheet
        open={detailTarget !== null}
        file={detailTarget}
        path={detailTarget ? pathString(folders, toParentKey(detailTarget.parentId)) : ''}
        memoCount={detailTarget ? memoCountOf(detailTarget.id) : 0}
        onOpenMemo={() => {
          const target = detailTarget;
          setDetailTarget(null);
          if (target) setMemoTarget(target);
        }}
        onClose={() => setDetailTarget(null)}
      />

      {/* 同名ファイル */}
      <DuplicateDialog
        open={duplicate !== null}
        fileName={duplicate?.name ?? ''}
        suggestedName={duplicate?.suggested ?? ''}
        remaining={duplicate?.remaining ?? 1}
        onClose={() => {
          duplicateResolver.current?.({ choice: 'cancel', applyToAll: false });
          duplicateResolver.current = null;
          setDuplicate(null);
        }}
        onChoose={(choice, applyToAll) => {
          duplicateResolver.current?.({ choice, applyToAll });
          duplicateResolver.current = null;
          setDuplicate(null);
        }}
      />

      {/* 画像からPDFを作成 */}
      {imagePdf ? (
        <ImageToPdfView
          folders={folders}
          initialFolderId={currentFolderId}
          defaults={settings.imagePdfOptions}
          startWith={imagePdf}
          notify={notify}
          onClose={() => setImagePdf(null)}
          onSaveOptions={(next: ImagePdfOptions) => void updateSettings({ imagePdfOptions: next })}
          onSave={saveImagePdf}
          onOpenFile={(fileId) => {
            setImagePdf(null);
            void withFile(fileId, (file) => openFile(file));
          }}
          onShareFile={(fileId) =>
            void withFile(fileId, (file) =>
              withBlob(file, async (blob) => {
                const shared = await sharePdf(blob, file.name);
                if (!shared) downloadBlob(blob, file.name);
              }),
            )
          }
          onRenameFile={(fileId) =>
            void withFile(fileId, (file) => setRenameTarget({ kind: 'file', file }))
          }
          onMoveFile={(fileId) =>
            void withFile(fileId, (file) => setPicker({ mode: 'move', item: { kind: 'file', file } }))
          }
        />
      ) : null}

      {/* 自動分類：移動前の確認 */}
      <ClassifyConfirmSheet
        plan={pendingPlans[0] ?? null}
        remaining={Math.max(0, pendingPlans.length - 1)}
        folders={folders}
        selectedRuleId={pendingRuleId}
        onSelectRule={setPendingRuleId}
        onApply={() => void applyPending(true)}
        onSkip={() => void applyPending(false)}
        onEditRule={(rule) => setRuleDraft(toDraft(rule))}
      />

      {/* 自動分類：移動後のお知らせ */}
      <ClassifyResultSheet
        records={classifyRecords}
        folders={folders}
        rules={rules}
        onClose={() => setClassifyRecords([])}
        onUndo={(record) => {
          setClassifyRecords((current) =>
            current.filter((entry) => entry.fileId !== record.fileId),
          );
          void run(() => undoClassification(record), '元のフォルダーへ戻しました。');
        }}
        onMove={(record) => setReclassifyTarget(record)}
        onEditRule={(rule) => setRuleDraft(toDraft(rule))}
      />

      {/* 自動分類：ルールの編集 */}
      <RuleEditor
        open={ruleDraft !== null}
        draft={ruleDraft}
        folders={folders}
        onClose={() => setRuleDraft(null)}
        onSave={(draft) => {
          setRuleDraft(null);
          void saveRule(draft)
            .then(() => reloadRules())
            .then(() => notify('ルールを保存しました。', 'success'))
            .catch((error) => notify(toMessage(error), 'error'));
        }}
      />

      {/* 自動分類：別フォルダーへ移動 */}
      <FolderPicker
        open={reclassifyTarget !== null}
        title="移動先のフォルダーを選択"
        confirmLabel="ここに移動"
        folders={folders}
        initialFolderId={reclassifyTarget?.toParentId ?? currentFolderId}
        onClose={() => setReclassifyTarget(null)}
        onConfirm={(folderId) => {
          const target = reclassifyTarget;
          setReclassifyTarget(null);
          if (!target) return;
          void run(async () => {
            const moved = await moveToFolder(target, folderId);
            setClassifyRecords((current) =>
              current.map((entry) => (entry.fileId === moved.fileId ? moved : entry)),
            );
          }, 'PDFを移動しました。');
        }}
      />

      {/* ビューアー */}
      {viewer ? (
        <PdfViewer
          file={viewer.file}
          blob={viewer.blob}
          initialPage={viewer.page}
          jumpTo={jumpTo}
          // メモなどのシートを開いている間は、背面のPDFを動かさない
          locked={memoTarget !== null || menuItem !== null || detailTarget !== null || busy !== null}
          onPageChange={setViewerPage}
          onClose={() => {
            setViewer(null);
            setJumpTo(null);
          }}
          onMemo={() => {
            const latest = files.find((file) => file.id === viewer.file.id) ?? viewer.file;
            setMemoTarget(latest);
          }}
          onMenu={() => {
            const latest = files.find((file) => file.id === viewer.file.id) ?? viewer.file;
            setMenuItem({ kind: 'file', file: latest });
          }}
        />
      ) : null}

      {/* メモ */}
      <MemoSheet
        open={memoTarget !== null}
        file={memoTarget}
        // ビューアーで開いている PDF のメモなら、現在ページを起点にする
        currentPage={viewer && memoTarget?.id === viewer.file.id ? viewerPage : undefined}
        pageCount={memoTarget?.pageCount}
        onClose={() => setMemoTarget(null)}
        onGoToPage={(page) => {
          if (viewer && memoTarget?.id === viewer.file.id) {
            // すでに開いているPDFなら、そのページへ移動してシートを閉じる
            setJumpTo({ page, seq: Date.now() });
            setMemoTarget(null);
            return;
          }
          const target = memoTarget;
          setMemoTarget(null);
          if (target) void openFile(target, page);
        }}
      />

      {/* PDF 編集 */}
      {editor ? (
        <PdfEditView
          file={editor.file}
          blob={editor.blob}
          resolveBlob={resolveBlob}
          onClose={() => setEditor(null)}
          onSaved={async ({ mode, file, message }) => {
            setEditor(null);
            // 保存後に一覧・容量・サムネイル・検索対象を更新する
            invalidateThumbnail(file.id);
            await reload();
            await reloadMemos();
            void refreshStorage();
            // 上書き保存したPDFを開いたままにしていた場合は、新しい内容で開き直す
            if (mode === 'overwrite' && viewer?.file.id === file.id) {
              setViewer(null);
              void openFile(file);
            }
            notify(message, 'success');
          }}
        />
      ) : null}

      {/* 編集の履歴 */}
      <VersionHistorySheet
        open={historyTarget !== null}
        file={historyTarget}
        resolveBlob={resolveBlob}
        onClose={() => setHistoryTarget(null)}
        onRestored={async (file) => {
          invalidateThumbnail(file.id);
          await reload();
          void refreshStorage();
          if (viewer?.file.id === file.id) {
            setViewer(null);
            void openFile(file);
          }
        }}
      />

      {/* 初回チュートリアル */}
      {!settings.onboardingDone ? (
        <Onboarding onFinish={() => void updateSettings({ onboardingDone: true })} />
      ) : null}

      {/* 処理中（同名確認ダイアログを出している間は隠して操作をブロックしない） */}
      {busy && !duplicate ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[rgba(15,23,32,0.35)]">
          <div className="flex items-center gap-3 rounded-sheet bg-surface px-5 py-4 shadow-pop dark:bg-[#181e26]">
            <Spinner />
            <p className="text-base text-ink dark:text-[#e6eaef]">{busy}</p>
          </div>
        </div>
      ) : null}

      <Toasts />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 下部ナビゲーション                                                  */
/* ------------------------------------------------------------------ */

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
        {item(
          'home',
          'ホーム',
          Home,
          onHome,
          current === 'home' || current === 'ticker' || current === 'folder',
        )}
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

/* ------------------------------------------------------------------ */
/* トースト                                                            */
/* ------------------------------------------------------------------ */

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
          <IconButton
            label="閉じる"
            className="-my-1.5 h-8 w-8 text-white/80"
            onClick={() => dismissToast(toast.id)}
          >
            <X size={16} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

export { Button };

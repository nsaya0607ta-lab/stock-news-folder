'use client';

/** 設定画面。表示・ごみ箱・バックアップ・データ削除をまとめる。 */
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Archive,
  Bell,
  Clock,
  DatabaseBackup,
  HardDrive,
  History,
  Info,
  Moon,
  Search,
  Sparkles,
  Sunrise,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react';
import { createBackup, restoreBackup, type RestoreMode } from '@/lib/backup';
import { downloadBlob, sharePdf } from '@/lib/device';
import { wipeAll } from '@/lib/db';
import { toMessage } from '@/lib/errors';
import { formatBytes } from '@/lib/format';
import { ROOT_NAME, SORT_LABELS, pathString } from '@/lib/tree';
import { ROOT_ID, type SortKey, type ThemeMode, type ViewMode } from '@/lib/types';
import { useApp } from '@/store/AppStore';
import { useStock } from '@/store/StockStore';
import { Button, IconButton, SectionTitle, Spinner, Switch, cx } from '@/components/ui/Primitives';
import { ConfirmDialog } from '@/components/dialogs/CommonDialogs';
import { CloudSettings } from '@/components/cloud/CloudSettings';
import { FolderPicker } from '@/components/dialogs/FolderPicker';
import { BottomSheet, MenuRow } from '@/components/ui/Sheet';
import { Header } from './Header';

const VIEW_LABELS: Record<ViewMode, string> = {
  list: '一覧表示',
  grid: 'グリッド表示',
  thumbnail: 'サムネイル表示',
};

const THEME_LABELS: Record<ThemeMode, string> = {
  system: '端末の設定に合わせる',
  light: 'ライト',
  dark: 'ダーク',
};

const RETENTION_OPTIONS = [7, 14, 30, 60, 90, 0];

/** PDF 編集の履歴として残すバージョン数 (0 = 残さない)。 */
const VERSION_COUNT_OPTIONS = [0, 1, 3, 5, 10];
/** バージョンを残す期間 (0 = 期限で消さない)。 */
const VERSION_DAYS_OPTIONS = [7, 30, 90, 180, 0];

function Row({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-tap items-center justify-between gap-3 border-b divider px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-base text-ink dark:text-[#e6eaef]">{label}</p>
        {description ? (
          <p className="mt-0.5 text-xs text-ink-sub dark:text-[#98a3b0]">{description}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function SettingsView({
  onOpenPdfArchive,
  onOpenPdfSearch,
  onOpenGemini,
  onOpenNotifications,
}: {
  /** 旧PDFアーカイブを開く。 */
  onOpenPdfArchive: () => void;
  /** 旧PDF向けのファイル検索を開く。 */
  onOpenPdfSearch: () => void;
  /** Geminiの資料作成画面を開く。 */
  onOpenGemini: () => void;
  /** 通知履歴を開く。 */
  onOpenNotifications: () => void;
}) {
  const {
    settings,
    updateSettings,
    storage,
    refreshStorage,
    notify,
    reload,
    goBack,
    canGoBack,
    files,
    folders,
    rules,
    navigate,
  } = useApp();
  const restoreInput = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState<
    'view' | 'sort' | 'theme' | 'retention' | 'versionCount' | 'versionDays' | 'stockTime' | null
  >(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [restoreMode, setRestoreMode] = useState<RestoreMode>('merge');
  const [pendingRestore, setPendingRestore] = useState<File | null>(null);
  const [reportPicker, setReportPicker] = useState(false);

  const reportFolderId = settings.dailyReportFolderId;
  const reportFolderLabel = !reportFolderId
    ? '未設定（タップして選択）'
    : reportFolderId === ROOT_ID
      ? ROOT_NAME
      : folders.some((folder) => folder.id === reportFolderId && !folder.deletedAt)
        ? pathString(folders, reportFolderId)
        : '選択したフォルダーは見つかりません（選び直してください）';

  useEffect(() => {
    void refreshStorage();
  }, [refreshStorage]);

  const stock = useStock();
  const unreadNotices = stock.notifications.filter((entry) => !entry.isRead).length;

  const activeFiles = files.filter((file) => !file.deletedAt).length;
  const activeFolders = folders.filter((folder) => !folder.deletedAt).length;
  const totalBytes = files
    .filter((file) => !file.deletedAt)
    .reduce((sum, file) => sum + file.size, 0);

  const runBackup = async () => {
    setBusy('backup');
    try {
      const { blob, fileName } = await createBackup(settings);
      const shared = await sharePdf(blob, fileName).catch(() => false);
      if (!shared) downloadBlob(blob, fileName);
      notify('バックアップファイルを書き出しました。', 'success');
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const runRestore = async (file: File, mode: RestoreMode) => {
    setBusy('restore');
    try {
      const result = await restoreBackup(file, mode);
      await reload();
      await refreshStorage();
      notify(`復元しました（フォルダー ${result.folders} 件 / PDF ${result.files} 件）`, 'success');
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(null);
      setPendingRestore(null);
    }
  };

  return (
    <>
      <Header
        title="設定"
        left={
          canGoBack ? (
            <IconButton label="戻る" onClick={goBack}>
              <ArrowLeft size={22} />
            </IconButton>
          ) : undefined
        }
      />

      <SectionTitle>株式ニュース</SectionTitle>
      <div className="bg-surface dark:bg-[#181e26]">
        <Row
          label="追跡中の銘柄"
          description={
            stock.subscriptions.length === 0
              ? 'まだありません（ホーム画面の「銘柄追加」から登録できます）'
              : stock.subscriptions.map((entry) => entry.ticker).join('、')
          }
        />
        <button type="button" className="w-full text-left" onClick={() => setSheet('stockTime')}>
          <Row label="銘柄追加時の既定の取得時刻" description={settings.stockDefaultTime}>
            <Clock size={20} className="text-ink-sub" />
          </Row>
        </button>
        <Row
          label="レポート作成時に端末の通知を出す"
          description={
            settings.stockPushEnabled
              ? '許可済みです'
              : '未許可です。許可しない場合も、通知履歴から確認できます。'
          }
        >
          <Switch
            checked={settings.stockPushEnabled}
            onChange={(value) => {
              if (value) void stock.enablePushNotifications();
              else void updateSettings({ stockPushEnabled: false });
            }}
            label="レポート作成時に通知を出す"
          />
        </Row>
        <button type="button" className="w-full text-left" onClick={onOpenNotifications}>
          <Row
            label="通知履歴"
            description={unreadNotices > 0 ? `未読 ${unreadNotices} 件` : `${stock.notifications.length} 件`}
          >
            <Bell size={20} className="text-ink-sub" />
          </Row>
        </button>
        <button type="button" className="w-full text-left" onClick={() => navigate({ view: 'history' })}>
          <Row label="実行履歴" description="定期処理の結果・取得件数・エラーを確認します">
            <History size={20} className="text-ink-sub" />
          </Row>
        </button>
        <p className="px-4 pb-3 text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
          定時取得はサーバー側（GitHub Actions）で10分ごとに実行され、取得時刻を迎えた銘柄だけを処理します。
          ブラウザーを閉じていても動作しますが、下の「クラウド連携」でログインしている必要があります。
        </p>
      </div>

      <SectionTitle>PDF・そのほかの機能</SectionTitle>
      <div className="bg-surface dark:bg-[#181e26]">
        <button type="button" className="w-full text-left" onClick={onOpenPdfArchive}>
          <Row label="旧PDFアーカイブ" description="株式と関係のない、以前のPDFはこちらにまとめています">
            <Archive size={20} className="text-ink-sub" />
          </Row>
        </button>
        <button type="button" className="w-full text-left" onClick={onOpenPdfSearch}>
          <Row label="PDFを検索" description="ファイル名・本文・メモから探します">
            <Search size={20} className="text-ink-sub" />
          </Row>
        </button>
        <button type="button" className="w-full text-left" onClick={() => navigate({ view: 'recent' })}>
          <Row label="最近開いたPDF" description="直近に開いたPDFの一覧">
            <Clock size={20} className="text-ink-sub" />
          </Row>
        </button>
        <button type="button" className="w-full text-left" onClick={onOpenGemini}>
          <Row label="Geminiで資料を作成" description="チャットの内容からPDFを作る既存機能">
            <Sparkles size={20} className="text-ink-sub" />
          </Row>
        </button>
        <button type="button" className="w-full text-left" onClick={() => navigate({ view: 'trash' })}>
          <Row label="ごみ箱" description="削除したレポートとPDFはここにあります">
            <Trash2 size={20} className="text-ink-sub" />
          </Row>
        </button>
      </div>

      <SectionTitle>表示</SectionTitle>
      <div className="bg-surface dark:bg-[#181e26]">
        <button type="button" className="w-full text-left" onClick={() => setSheet('view')}>
          <Row label="表示方法" description={VIEW_LABELS[settings.viewMode]} />
        </button>
        <button type="button" className="w-full text-left" onClick={() => setSheet('sort')}>
          <Row label="並べ替え方法" description={SORT_LABELS[settings.sortKey]} />
        </button>
        <Row label="フォルダーをPDFより上に表示">
          <Switch
            checked={settings.foldersFirst}
            onChange={(value) => void updateSettings({ foldersFirst: value })}
            label="フォルダーを上に表示"
          />
        </Row>
        <button type="button" className="w-full text-left" onClick={() => setSheet('theme')}>
          <Row label="ダークモード" description={THEME_LABELS[settings.theme]}>
            <Moon size={20} className="text-ink-sub" />
          </Row>
        </button>
      </div>

      <SectionTitle>毎朝の学習レポート</SectionTitle>
      <div className="bg-surface dark:bg-[#181e26]">
        <Row
          label="自動で取り込む"
          description="毎朝5時に作成される学習レポートPDFを、アプリを開いたときに自動で追加します。"
        >
          <Switch
            checked={settings.dailyReportEnabled}
            onChange={(value) => void updateSettings({ dailyReportEnabled: value })}
            label="毎朝の学習レポートを自動で取り込む"
          />
        </Row>
        <button
          type="button"
          className="w-full text-left"
          onClick={() => setReportPicker(true)}
        >
          <Row label="取り込み先フォルダー" description={reportFolderLabel}>
            <Sunrise size={20} className="text-ink-sub" />
          </Row>
        </button>
      </div>

      <SectionTitle>自動分類</SectionTitle>
      <div className="bg-surface dark:bg-[#181e26]">
        <button type="button" className="w-full text-left" onClick={() => navigate({ view: 'rules' })}>
          <Row
            label="自動分類ルール"
            description={
              settings.classifyEnabled
                ? `${rules.length} 件のルール（PDF追加時に自動で振り分けます）`
                : `${rules.length} 件のルール（自動分類はOFFです）`
            }
          >
            <Wand2 size={20} className="text-ink-sub" />
          </Row>
        </button>
      </div>

      <CloudSettings />

      <SectionTitle>ごみ箱</SectionTitle>
      <div className="bg-surface dark:bg-[#181e26]">
        <button type="button" className="w-full text-left" onClick={() => setSheet('retention')}>
          <Row
            label="自動削除までの日数"
            description={
              settings.trashRetentionDays === 0
                ? '自動削除しない'
                : `${settings.trashRetentionDays}日後に完全削除`
            }
          />
        </button>
      </div>

      <SectionTitle>PDF編集の履歴</SectionTitle>
      <div className="bg-surface dark:bg-[#181e26]">
        <button type="button" className="w-full text-left" onClick={() => setSheet('versionCount')}>
          <Row
            label="残すバージョンの数"
            description={
              settings.versionKeepCount === 0
                ? '編集前のPDFを残さない'
                : `1つのPDFにつき最大 ${settings.versionKeepCount} 件`
            }
          />
        </button>
        <button type="button" className="w-full text-left" onClick={() => setSheet('versionDays')}>
          <Row
            label="残す期間"
            description={
              settings.versionKeepDays === 0
                ? '期限で削除しない'
                : `${settings.versionKeepDays}日を過ぎたら削除`
            }
          />
        </button>
        <p className="px-4 pb-3 text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
          PDFを上書き保存したとき、編集前のPDFをこの範囲で残します。多く残すほど端末の保存容量を使います。
        </p>
      </div>

      <SectionTitle>データ</SectionTitle>
      <div className="bg-surface dark:bg-[#181e26]">
        <Row
          label="データ使用量"
          description={
            storage
              ? `PDF ${activeFiles} 件（${formatBytes(totalBytes)}） ・ フォルダー ${activeFolders} 件\nブラウザー全体の使用量 ${formatBytes(storage.usage)}${storage.quota ? ` / 上限の目安 ${formatBytes(storage.quota)}` : ''}`
              : `PDF ${activeFiles} 件（${formatBytes(totalBytes)}） ・ フォルダー ${activeFolders} 件`
          }
        >
          <HardDrive size={20} className="text-ink-sub" />
        </Row>

        <button
          type="button"
          className="w-full text-left"
          disabled={busy !== null}
          onClick={() => void runBackup()}
        >
          <Row
            label="データのバックアップ"
            description="フォルダー構成・PDF・タグ・メモ・お気に入りをZIPで書き出します"
          >
            {busy === 'backup' ? <Spinner /> : <DatabaseBackup size={20} className="text-ink-sub" />}
          </Row>
        </button>

        <button
          type="button"
          className="w-full text-left"
          disabled={busy !== null}
          onClick={() => restoreInput.current?.click()}
        >
          <Row label="データの復元" description="バックアップZIPを読み込みます">
            {busy === 'restore' ? <Spinner /> : <Upload size={20} className="text-ink-sub" />}
          </Row>
        </button>

        <button type="button" className="w-full text-left" onClick={() => setConfirmWipe(true)}>
          <Row label="すべてのデータを削除" description="この端末のPDFとフォルダーをすべて消去します">
            <Trash2 size={20} className="text-pdf" />
          </Row>
        </button>
      </div>

      <SectionTitle>このアプリについて</SectionTitle>
      <div className="bg-surface px-4 py-3 dark:bg-[#181e26]">
        <div className="flex gap-2 text-sm text-ink-sub dark:text-[#98a3b0]">
          <Info size={18} className="mt-0.5 shrink-0" />
          <div className="space-y-2">
            <p>
              PDFはこの端末のブラウザー内（IndexedDB）に保存されます。スマートフォンのOS制限により、
              端末内のすべてのフォルダーを直接読み書きすることはできません。
            </p>
            <p>
              端末へ書き出すときは共有シートまたはダウンロードを使います。大切なPDFは定期的に
              バックアップを取ってください。
            </p>
          </div>
        </div>
      </div>

      <input
        ref={restoreInput}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) setPendingRestore(file);
        }}
      />

      {/* 毎朝の学習レポートの取り込み先 */}
      <FolderPicker
        open={reportPicker}
        title="取り込み先フォルダー"
        description="毎朝の学習レポートPDFを保存するフォルダーを選んでください。"
        confirmLabel="ここに取り込む"
        folders={folders}
        initialFolderId={settings.dailyReportFolderId ?? ROOT_ID}
        onClose={() => setReportPicker(false)}
        onConfirm={(folderId) => {
          void updateSettings({ dailyReportFolderId: folderId });
          setReportPicker(false);
        }}
      />

      {/* 表示方法 */}
      <BottomSheet open={sheet === 'view'} title="表示方法" onClose={() => setSheet(null)}>
        {(Object.keys(VIEW_LABELS) as ViewMode[]).map((mode) => (
          <MenuRow
            key={mode}
            icon={<span className={cx('h-2.5 w-2.5 rounded-full', settings.viewMode === mode ? 'bg-brand-500' : 'bg-line')} />}
            label={VIEW_LABELS[mode]}
            onClick={() => {
              void updateSettings({ viewMode: mode });
              setSheet(null);
            }}
          />
        ))}
      </BottomSheet>

      {/* 並べ替え */}
      <BottomSheet open={sheet === 'sort'} title="並べ替え方法" onClose={() => setSheet(null)}>
        {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
          <MenuRow
            key={key}
            icon={<span className={cx('h-2.5 w-2.5 rounded-full', settings.sortKey === key ? 'bg-brand-500' : 'bg-line')} />}
            label={SORT_LABELS[key]}
            onClick={() => {
              void updateSettings({ sortKey: key });
              setSheet(null);
            }}
          />
        ))}
      </BottomSheet>

      {/* テーマ */}
      <BottomSheet open={sheet === 'theme'} title="ダークモード" onClose={() => setSheet(null)}>
        {(Object.keys(THEME_LABELS) as ThemeMode[]).map((mode) => (
          <MenuRow
            key={mode}
            icon={<span className={cx('h-2.5 w-2.5 rounded-full', settings.theme === mode ? 'bg-brand-500' : 'bg-line')} />}
            label={THEME_LABELS[mode]}
            onClick={() => {
              void updateSettings({ theme: mode });
              setSheet(null);
            }}
          />
        ))}
      </BottomSheet>

      {/* 銘柄追加時の既定の取得時刻 */}
      <BottomSheet
        open={sheet === 'stockTime'}
        title="既定の取得時刻"
        description="新しく銘柄を追加するときの初期値です。追加後は銘柄ごとに変更できます。"
        onClose={() => setSheet(null)}
      >
        <label className="block px-4 py-4">
          <span className="mb-1 block text-sm text-ink dark:text-[#e6eaef]">取得時刻（Asia/Tokyo）</span>
          <input
            type="time"
            value={settings.stockDefaultTime}
            onChange={(event) => void updateSettings({ stockDefaultTime: event.target.value })}
            className="w-full rounded-card border border-line bg-surface px-3 py-2 text-base text-ink dark:border-[#333d49] dark:bg-[#1b222a] dark:text-[#e6eaef]"
          />
        </label>
        <div className="px-4 pb-4">
          <Button variant="primary" className="w-full" onClick={() => setSheet(null)}>
            閉じる
          </Button>
        </div>
      </BottomSheet>

      {/* ごみ箱の保持日数 */}
      <BottomSheet
        open={sheet === 'retention'}
        title="ごみ箱の自動削除"
        onClose={() => setSheet(null)}
      >
        {RETENTION_OPTIONS.map((days) => (
          <MenuRow
            key={days}
            icon={
              <span
                className={cx(
                  'h-2.5 w-2.5 rounded-full',
                  settings.trashRetentionDays === days ? 'bg-brand-500' : 'bg-line',
                )}
              />
            }
            label={days === 0 ? '自動削除しない' : `${days}日後`}
            onClick={() => {
              void updateSettings({ trashRetentionDays: days });
              setSheet(null);
            }}
          />
        ))}
      </BottomSheet>

      {/* PDF編集の履歴：残す数 */}
      <BottomSheet
        open={sheet === 'versionCount'}
        title="残すバージョンの数"
        description="上書き保存したときに残す、編集前のPDFの数です。"
        onClose={() => setSheet(null)}
      >
        {VERSION_COUNT_OPTIONS.map((count) => (
          <MenuRow
            key={count}
            icon={
              <span
                className={cx(
                  'h-2.5 w-2.5 rounded-full',
                  settings.versionKeepCount === count ? 'bg-brand-500' : 'bg-line',
                )}
              />
            }
            label={count === 0 ? '残さない' : `${count} 件まで`}
            onClick={() => {
              void updateSettings({ versionKeepCount: count });
              setSheet(null);
            }}
          />
        ))}
      </BottomSheet>

      {/* PDF編集の履歴：残す期間 */}
      <BottomSheet
        open={sheet === 'versionDays'}
        title="履歴を残す期間"
        onClose={() => setSheet(null)}
      >
        {VERSION_DAYS_OPTIONS.map((days) => (
          <MenuRow
            key={days}
            icon={
              <span
                className={cx(
                  'h-2.5 w-2.5 rounded-full',
                  settings.versionKeepDays === days ? 'bg-brand-500' : 'bg-line',
                )}
              />
            }
            label={days === 0 ? '期限で削除しない' : `${days}日`}
            onClick={() => {
              void updateSettings({ versionKeepDays: days });
              setSheet(null);
            }}
          />
        ))}
      </BottomSheet>

      {/* 復元方法の選択 */}
      <BottomSheet
        open={pendingRestore !== null}
        title="データの復元"
        description={pendingRestore?.name}
        onClose={() => setPendingRestore(null)}
        footer={
          <Button
            variant="primary"
            className="w-full"
            onClick={() => {
              if (pendingRestore) void runRestore(pendingRestore, restoreMode);
            }}
          >
            復元する
          </Button>
        }
      >
        <MenuRow
          icon={
            <span
              className={cx(
                'h-2.5 w-2.5 rounded-full',
                restoreMode === 'merge' ? 'bg-brand-500' : 'bg-line',
              )}
            />
          }
          label="今のデータに追加する"
          description="同じIDの項目はスキップします"
          onClick={() => setRestoreMode('merge')}
        />
        <MenuRow
          icon={
            <span
              className={cx(
                'h-2.5 w-2.5 rounded-full',
                restoreMode === 'replace' ? 'bg-brand-500' : 'bg-line',
              )}
            />
          }
          label="今のデータを消して置き換える"
          description="バックアップ時点の状態に完全に戻します"
          onClick={() => setRestoreMode('replace')}
        />
      </BottomSheet>

      <ConfirmDialog
        open={confirmWipe}
        title="すべてのデータを削除しますか？"
        description="この端末に保存されているPDF・フォルダー・タグ・メモがすべて消去されます。この操作は取り消せません。"
        confirmLabel="削除する"
        tone="danger"
        onClose={() => setConfirmWipe(false)}
        onConfirm={async () => {
          setConfirmWipe(false);
          try {
            await wipeAll();
            notify('すべてのデータを削除しました。', 'success');
            window.location.reload();
          } catch (error) {
            notify(toMessage(error), 'error');
          }
        }}
      />
    </>
  );
}

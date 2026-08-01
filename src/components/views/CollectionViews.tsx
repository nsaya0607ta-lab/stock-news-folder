'use client';

/** 最近開いたPDF / ごみ箱 の各画面（お気に入りは株式レポート用の画面へ移行）。 */
import { useMemo, useState } from 'react';
import { ArrowLeft, Clock, RotateCcw, Trash2, XCircle } from 'lucide-react';
import { daysUntilPurge, formatDateTime, formatRelative } from '@/lib/format';
import { pathString, toParentKey } from '@/lib/tree';
import type { ExplorerItem } from '@/lib/types';
import { useApp } from '@/store/AppStore';
import { ItemList } from '@/components/items/ItemList';
import { ListRow, type ItemHandlers } from '@/components/items/ItemViews';
import { Button, EmptyState, IconButton, cx } from '@/components/ui/Primitives';
import { FolderIcon, PdfIcon } from '@/components/ui/FileIcons';
import { Header } from './Header';

/* ------------------------------------------------------------------ */
/* 最近使った項目                                                      */
/* ------------------------------------------------------------------ */

export function RecentView({ handlers }: { handlers: ItemHandlers }) {
  const { files, folders, goBack, canGoBack } = useApp();
  const [tab, setTab] = useState<'opened' | 'added'>('opened');

  const list = useMemo(() => {
    const active = files.filter((file) => !file.deletedAt);
    if (tab === 'opened') {
      return active
        .filter((file) => file.lastOpenedAt)
        .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''))
        .slice(0, 100);
    }
    return [...active].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  }, [files, tab]);

  return (
    <>
      <Header
        title="最近使った項目"
        left={
          canGoBack ? (
            <IconButton label="戻る" onClick={goBack}>
              <ArrowLeft size={22} />
            </IconButton>
          ) : undefined
        }
      >
        <div className="flex border-t divider">
          {(
            [
              ['opened', '最近開いたPDF'],
              ['added', '最近追加したPDF'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cx(
                'min-h-tap flex-1 border-b-2 text-sm font-medium',
                tab === key
                  ? 'border-brand-500 text-brand-600 dark:text-brand-300'
                  : 'border-transparent text-ink-sub dark:text-[#98a3b0]',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </Header>

      {list.length === 0 ? (
        <EmptyState
          icon={<Clock size={48} strokeWidth={1.2} />}
          title={tab === 'opened' ? 'まだPDFを開いていません' : 'まだPDFがありません'}
          description="PDFを追加して開くと、ここに履歴が表示されます。"
        />
      ) : (
        <div className="bg-surface dark:bg-[#181e26]">
          {list.map((file) => (
            <ListRow
              key={file.id}
              item={{ kind: 'file', file }}
              handlers={handlers}
              subtitle={
                tab === 'opened'
                  ? `最終閲覧 ${formatRelative(file.lastOpenedAt)}`
                  : `追加 ${formatRelative(file.createdAt)}`
              }
              showLocation={pathString(folders, toParentKey(file.parentId))}
            />
          ))}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* ごみ箱                                                              */
/* ------------------------------------------------------------------ */

export function TrashView({
  onRestoreFolder,
  onRestoreFile,
  onPurgeFolder,
  onPurgeFile,
  onEmptyTrash,
}: {
  onRestoreFolder: (id: string) => void;
  onRestoreFile: (id: string) => void;
  onPurgeFolder: (id: string) => void;
  onPurgeFile: (id: string) => void;
  onEmptyTrash: () => void;
}) {
  const { files, folders, settings, goBack, canGoBack } = useApp();

  const deletedFolders = useMemo(
    () =>
      folders
        .filter((folder) => folder.deletedAt)
        // 配下ごと削除された場合、親だけを一覧に出す
        .filter((folder) => {
          const parent = toParentKey(folder.parentId);
          return !folders.some((other) => other.id === parent && other.deletedAt);
        })
        .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? '')),
    [folders],
  );

  const deletedFiles = useMemo(
    () =>
      files
        .filter((file) => file.deletedAt)
        .filter((file) => {
          const parent = toParentKey(file.parentId);
          return !folders.some((folder) => folder.id === parent && folder.deletedAt);
        })
        .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? '')),
    [files, folders],
  );

  const total = deletedFolders.length + deletedFiles.length;

  return (
    <>
      <Header
        title="ごみ箱"
        subtitle={`${settings.trashRetentionDays}日後に自動で完全削除されます`}
        left={
          canGoBack ? (
            <IconButton label="戻る" onClick={goBack}>
              <ArrowLeft size={22} />
            </IconButton>
          ) : undefined
        }
        right={
          total > 0 ? (
            <Button variant="ghost" className="h-9 min-h-0 px-2 text-sm" onClick={onEmptyTrash}>
              空にする
            </Button>
          ) : undefined
        }
      />

      {total === 0 ? (
        <EmptyState
          icon={<Trash2 size={48} strokeWidth={1.2} />}
          title="ごみ箱は空です"
          description="削除したPDFとフォルダーは、完全に消える前に一度ここへ移動します。"
        />
      ) : (
        <div className="bg-surface dark:bg-[#181e26]">
          {deletedFolders.map((folder) => (
            <TrashRow
              key={folder.id}
              icon={<FolderIcon color={folder.color} size={28} />}
              name={folder.name}
              deletedAt={folder.deletedAt}
              retentionDays={settings.trashRetentionDays}
              onRestore={() => onRestoreFolder(folder.id)}
              onPurge={() => onPurgeFolder(folder.id)}
            />
          ))}
          {deletedFiles.map((file) => (
            <TrashRow
              key={file.id}
              icon={<PdfIcon size={26} />}
              name={file.name}
              deletedAt={file.deletedAt}
              retentionDays={settings.trashRetentionDays}
              onRestore={() => onRestoreFile(file.id)}
              onPurge={() => onPurgeFile(file.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function TrashRow({
  icon,
  name,
  deletedAt,
  retentionDays,
  onRestore,
  onPurge,
}: {
  icon: React.ReactNode;
  name: string;
  deletedAt?: string;
  retentionDays: number;
  onRestore: () => void;
  onPurge: () => void;
}) {
  const remaining = daysUntilPurge(deletedAt, retentionDays);
  return (
    <div className="flex items-center gap-3 border-b divider px-4 py-2.5">
      {icon}
      <div className="min-w-0 flex-1">
        <p className="truncate text-base text-ink dark:text-[#e6eaef]">{name}</p>
        <p className="truncate text-xs text-ink-sub dark:text-[#98a3b0]">
          削除日 {formatDateTime(deletedAt)} ・ あと {remaining} 日
        </p>
      </div>
      <IconButton label="元の場所へ戻す" onClick={onRestore} className="text-brand-500">
        <RotateCcw size={20} />
      </IconButton>
      <IconButton label="完全に削除" onClick={onPurge} className="text-pdf">
        <XCircle size={20} />
      </IconButton>
    </div>
  );
}

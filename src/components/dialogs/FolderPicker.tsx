'use client';

/**
 * 移動先・保存先を選ぶためのフォルダーツリー。
 * スマートフォンではドラッグが難しいため、「選んで → ここに移動」の 2 手で完結させる。
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FolderPlus, HardDrive } from 'lucide-react';
import { ROOT_ID, type Folder } from '@/lib/types';
import { ROOT_NAME, descendantFolderIds, toParentKey } from '@/lib/tree';
import { FolderIcon } from '@/components/ui/FileIcons';
import { Button, cx } from '@/components/ui/Primitives';
import { BottomSheet } from '@/components/ui/Sheet';

type Props = {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  folders: Folder[];
  /** 選択できないフォルダー (移動元自身とその配下)。 */
  excludeFolderId?: string;
  initialFolderId?: string;
  onClose: () => void;
  onConfirm: (folderId: string) => void;
  onCreateFolder?: (parentId: string) => void;
};

export function FolderPicker({
  open,
  title,
  description,
  confirmLabel,
  folders,
  excludeFolderId,
  initialFolderId = ROOT_ID,
  onClose,
  onConfirm,
  onCreateFolder,
}: Props) {
  const [selected, setSelected] = useState(initialFolderId);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT_ID]));

  const active = useMemo(() => folders.filter((folder) => !folder.deletedAt), [folders]);
  const blocked = useMemo(
    () => (excludeFolderId ? descendantFolderIds(active, excludeFolderId) : new Set<string>()),
    [active, excludeFolderId],
  );

  // 初期選択フォルダーまでの経路を開いておく
  useEffect(() => {
    if (!open) return;
    const path = new Set<string>([ROOT_ID]);
    let cursor: string | undefined = initialFolderId;
    let guard = 0;
    while (cursor && cursor !== ROOT_ID && guard < 64) {
      path.add(cursor);
      cursor = toParentKey(active.find((folder) => folder.id === cursor)?.parentId);
      guard += 1;
    }
    setExpanded((current) => new Set([...current, ...path]));
    setSelected(initialFolderId);
  }, [active, initialFolderId, open]);

  const childrenOf = (parentId: string) =>
    active
      .filter((folder) => toParentKey(folder.parentId) === parentId)
      .sort((a, b) => a.name.localeCompare(b.name, 'ja'));

  const renderNode = (folder: Folder, depth: number) => {
    const children = childrenOf(folder.id);
    const isOpen = expanded.has(folder.id);
    const isBlocked = blocked.has(folder.id);
    return (
      <div key={folder.id}>
        <div
          className={cx(
            'flex min-h-tap items-center border-b divider',
            selected === folder.id && !isBlocked
              ? 'bg-brand-50 dark:bg-[#16233a]'
              : 'bg-transparent',
          )}
        >
          <button
            type="button"
            aria-label={isOpen ? '折りたたむ' : '展開する'}
            onClick={() => {
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(folder.id)) next.delete(folder.id);
                else next.add(folder.id);
                return next;
              });
            }}
            className="flex h-tap w-8 shrink-0 items-center justify-center text-ink-faint"
            style={{ marginLeft: depth * 16 }}
          >
            {children.length > 0 ? (
              isOpen ? (
                <ChevronDown size={18} />
              ) : (
                <ChevronRight size={18} />
              )
            ) : null}
          </button>
          <button
            type="button"
            disabled={isBlocked}
            onClick={() => setSelected(folder.id)}
            className="flex min-h-tap flex-1 items-center gap-2 py-2 pr-4 text-left disabled:opacity-35"
          >
            <FolderIcon color={folder.color} size={22} />
            <span className="truncate text-base text-ink dark:text-[#e6eaef]">{folder.name}</span>
          </button>
        </div>
        {isOpen ? children.map((child) => renderNode(child, depth + 1)) : null}
      </div>
    );
  };

  const rootChildren = childrenOf(ROOT_ID);

  return (
    <BottomSheet
      open={open}
      title={title}
      description={description}
      onClose={onClose}
      maxHeight="60vh"
      footer={
        <div className="flex gap-2">
          {onCreateFolder ? (
            <Button variant="secondary" onClick={() => onCreateFolder(selected)} className="px-3">
              <FolderPlus size={18} />
              新規
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose} className="flex-1">
            キャンセル
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            disabled={blocked.has(selected)}
            onClick={() => onConfirm(selected)}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div>
        <div
          className={cx(
            'flex min-h-tap items-center border-b divider',
            selected === ROOT_ID ? 'bg-brand-50 dark:bg-[#16233a]' : '',
          )}
        >
          <button
            type="button"
            onClick={() => setSelected(ROOT_ID)}
            className="flex min-h-tap flex-1 items-center gap-2 px-4 py-2 text-left"
          >
            <HardDrive size={20} className="text-brand-500" />
            <span className="truncate text-base font-medium text-ink dark:text-[#e6eaef]">
              {ROOT_NAME}
            </span>
          </button>
        </div>
        {rootChildren.map((folder) => renderNode(folder, 0))}
      </div>
    </BottomSheet>
  );
}

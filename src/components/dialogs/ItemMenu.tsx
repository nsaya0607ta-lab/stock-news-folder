'use client';

/** PDF / フォルダーの操作メニュー (長押し または「…」から表示)。 */
import {
  CopyPlus,
  Download,
  ExternalLink,
  Eye,
  FolderInput,
  Info,
  History,
  Link2,
  NotebookPen,
  Palette,
  PenSquare,
  Printer,
  Share2,
  SquarePen,
  Star,
  StarOff,
  Tags,
  Trash2,
} from 'lucide-react';
import type { ExplorerItem } from '@/lib/types';
import { formatBytes, formatDateTime } from '@/lib/format';
import { BottomSheet, MenuRow } from '@/components/ui/Sheet';
import { FolderIcon, PdfIcon } from '@/components/ui/FileIcons';

export type ItemMenuActions = {
  onOpen: () => void;
  onRename: () => void;
  onMove: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onToggleFavorite: () => void;
  onShare?: () => void;
  onSaveToDevice?: () => void;
  onPrint?: () => void;
  onOpenWith?: () => void;
  onCopyPath: () => void;
  onDetails?: () => void;
  onTags?: () => void;
  onColor?: () => void;
  onToggleRead?: () => void;
  /** PDF ごとのメモ。 */
  onMemo?: () => void;
  /** ページ編集画面を開く。 */
  onEdit?: () => void;
  /** 編集のバージョン履歴。 */
  onHistory?: () => void;
};

export function ItemMenu({
  item,
  path,
  actions,
  memoCount = 0,
  onClose,
}: {
  item: ExplorerItem | null;
  path: string;
  actions: ItemMenuActions;
  /** この PDF に登録されているメモの件数 (メニューに表示する)。 */
  memoCount?: number;
  onClose: () => void;
}) {
  if (!item) return null;

  const wrap = (action?: () => void) => () => {
    onClose();
    action?.();
  };

  const header =
    item.kind === 'folder' ? (
      <div className="flex items-center gap-3 border-b divider px-4 py-3">
        <FolderIcon color={item.folder.color} size={32} />
        <div className="min-w-0">
          <p className="truncate text-base font-medium text-ink dark:text-[#e6eaef]">
            {item.folder.name}
          </p>
          <p className="truncate text-xs text-ink-sub dark:text-[#98a3b0]">{path}</p>
        </div>
      </div>
    ) : (
      <div className="flex items-center gap-3 border-b divider px-4 py-3">
        <PdfIcon size={32} />
        <div className="min-w-0">
          <p className="break-all text-base font-medium text-ink dark:text-[#e6eaef]">
            {item.file.name}
          </p>
          <p className="truncate text-xs text-ink-sub dark:text-[#98a3b0]">
            {formatBytes(item.file.size)}
            {item.file.pageCount ? ` ・ ${item.file.pageCount}ページ` : ''} ・{' '}
            {formatDateTime(item.file.updatedAt)}
          </p>
          <p className="truncate text-xs text-brand-500 dark:text-brand-300">{path}</p>
        </div>
      </div>
    );

  const favorite = item.kind === 'folder' ? item.folder.isFavorite : item.file.isFavorite;

  return (
    <BottomSheet open onClose={onClose} maxHeight="76vh">
      {header}
      <div className="py-1">
        <MenuRow
          icon={item.kind === 'folder' ? <FolderInput size={20} /> : <Eye size={20} />}
          label={item.kind === 'folder' ? 'フォルダーを開く' : 'PDFを開く'}
          onClick={wrap(actions.onOpen)}
        />
        <MenuRow icon={<SquarePen size={20} />} label="名前を変更" onClick={wrap(actions.onRename)} />
        <MenuRow
          icon={<FolderInput size={20} />}
          label="別のフォルダーへ移動"
          onClick={wrap(actions.onMove)}
        />
        <MenuRow icon={<CopyPlus size={20} />} label="コピー" onClick={wrap(actions.onCopy)} />
        <MenuRow
          icon={favorite ? <StarOff size={20} /> : <Star size={20} />}
          label={favorite ? 'お気に入りを解除' : 'お気に入りに登録'}
          onClick={wrap(actions.onToggleFavorite)}
        />

        {item.kind === 'file' ? (
          <>
            <div className="my-1 border-t divider" />
            <MenuRow
              icon={<NotebookPen size={20} />}
              label="メモ"
              description={memoCount > 0 ? `${memoCount} 件のメモ` : 'ページを指定したメモを登録できます'}
              onClick={wrap(actions.onMemo)}
            />
            <MenuRow
              icon={<PenSquare size={20} />}
              label="PDFを編集"
              description="ページの並べ替え・回転・削除など"
              onClick={wrap(actions.onEdit)}
            />
            <MenuRow
              icon={<History size={20} />}
              label="編集の履歴"
              onClick={wrap(actions.onHistory)}
            />

            <div className="my-1 border-t divider" />
            <MenuRow icon={<Share2 size={20} />} label="共有" onClick={wrap(actions.onShare)} />
            <MenuRow
              icon={<Download size={20} />}
              label="端末に保存（ファイルアプリへ）"
              onClick={wrap(actions.onSaveToDevice)}
            />
            <MenuRow icon={<Printer size={20} />} label="印刷" onClick={wrap(actions.onPrint)} />
            <MenuRow
              icon={<ExternalLink size={20} />}
              label="他のアプリで開く"
              onClick={wrap(actions.onOpenWith)}
            />
            <div className="my-1 border-t divider" />
            <MenuRow
              icon={<Tags size={20} />}
              label="タグ・メモ・重要度"
              onClick={wrap(actions.onTags)}
            />
            <MenuRow
              icon={<Eye size={20} />}
              label={item.file.isRead ? '未閲覧にする' : '閲覧済みにする'}
              onClick={wrap(actions.onToggleRead)}
            />
          </>
        ) : (
          <>
            <div className="my-1 border-t divider" />
            <MenuRow
              icon={<Palette size={20} />}
              label="フォルダーの色を変更"
              onClick={wrap(actions.onColor)}
            />
          </>
        )}

        <MenuRow icon={<Link2 size={20} />} label="パスをコピー" onClick={wrap(actions.onCopyPath)} />
        {item.kind === 'file' ? (
          <MenuRow icon={<Info size={20} />} label="詳細情報" onClick={wrap(actions.onDetails)} />
        ) : null}

        <div className="my-1 border-t divider" />
        <MenuRow
          icon={<Trash2 size={20} />}
          label="削除（ごみ箱へ移動）"
          tone="danger"
          onClick={wrap(actions.onDelete)}
        />
      </div>
    </BottomSheet>
  );
}

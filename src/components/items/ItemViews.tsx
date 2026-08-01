'use client';

/**
 * 一覧表示 / グリッド表示 / サムネイル表示。
 * 表示形式が変わっても、行の情報 (名前・サイズ・更新日時など) は同じものを見せる。
 */
import { useEffect, useState } from 'react';
import { ChevronRight, MoreVertical, Star } from 'lucide-react';
import { formatBytes, formatDateTime, middleEllipsis } from '@/lib/format';
import type { ExplorerItem, Folder, PdfFileMeta } from '@/lib/types';
import { useApp } from '@/store/AppStore';
import { FolderIcon, PdfIcon } from '@/components/ui/FileIcons';
import { cx } from '@/components/ui/Primitives';
import { CloudBadge, CloudProgressBar } from '@/components/cloud/CloudBadge';
import { useLongPress } from '@/components/useLongPress';

export type ItemHandlers = {
  onOpen: (item: ExplorerItem) => void;
  onMenu: (item: ExplorerItem) => void;
};

function Thumb({ file, size }: { file: PdfFileMeta; size: number }) {
  const { getThumbnail } = useApp();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getThumbnail(file.id).then((result) => {
      if (active) setUrl(result);
    });
    return () => {
      active = false;
    };
  }, [file.id, getThumbnail]);

  if (!url) {
    return (
      <div
        className="flex items-center justify-center rounded-[4px] border border-line bg-surface-sub dark:border-[#333d49] dark:bg-[#12171d]"
        style={{ width: size, height: Math.round(size * 1.32) }}
      >
        <PdfIcon size={Math.round(size * 0.5)} />
      </div>
    );
  }
  return (
    // 生成済みのサムネイルは Blob URL のため next/image ではなく img を使う
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      className="rounded-[4px] border border-line bg-white object-cover object-top dark:border-[#333d49]"
      style={{ width: size, height: Math.round(size * 1.32) }}
    />
  );
}

function FavoriteMark({ on }: { on: boolean }) {
  if (!on) return null;
  return <Star size={15} className="shrink-0 text-folder" fill="#e8a917" aria-label="お気に入り" />;
}

/* ------------------------------------------------------------------ */
/* 一覧表示                                                            */
/* ------------------------------------------------------------------ */

export function ListRow({
  item,
  handlers,
  subtitle,
  showLocation,
}: {
  item: ExplorerItem;
  handlers: ItemHandlers;
  subtitle?: string;
  showLocation?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const press = useLongPress(
    () => handlers.onMenu(item),
    () => handlers.onOpen(item),
  );

  const name = item.kind === 'folder' ? item.folder.name : item.file.name;
  const favorite = item.kind === 'folder' ? item.folder.isFavorite : item.file.isFavorite;

  return (
    // 行全体を折り返し不可の 2 カラム構成にする。
    // 左 (タップ領域) は必ず縮み、右 (3点リーダー) は常に同じ幅で右端に残る。
    // min-w-0 を付けないと長いファイル名の分だけ行が横に伸び、
    // 3点リーダーの位置がファイル名ごとにズレて画面が横スクロールしてしまう。
    <div className="flex w-full items-stretch overflow-hidden border-b divider last:border-b-0">
      <div
        {...press}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') handlers.onOpen(item);
        }}
        className="no-callout flex min-h-[60px] min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 pr-2 text-left active:bg-surface-sub dark:active:bg-[#232b35]"
      >
        {item.kind === 'folder' ? (
          <FolderIcon color={item.folder.color} size={30} />
        ) : (
          <PdfIcon size={28} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <p
              className={cx(
                'min-w-0 text-base text-ink dark:text-[#e6eaef]',
                expanded ? 'break-all' : 'truncate',
                item.kind === 'file' && !item.file.isRead ? 'font-semibold' : 'font-normal',
              )}
              onClick={(event) => {
                if (item.kind === 'file' && name.length > 28) {
                  event.stopPropagation();
                  setExpanded((value) => !value);
                }
              }}
            >
              {expanded ? name : middleEllipsis(name, 30)}
            </p>
            <FavoriteMark on={favorite} />
            {item.kind === 'file' ? <CloudBadge file={item.file} /> : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-ink-sub dark:text-[#98a3b0]">
            {subtitle ??
              (item.kind === 'folder'
                ? formatDateTime(item.folder.updatedAt)
                : [
                    formatBytes(item.file.size),
                    item.file.pageCount ? `${item.file.pageCount}ページ` : null,
                    formatDateTime(item.file.updatedAt),
                  ]
                    .filter(Boolean)
                    .join(' ・ '))}
          </p>
          {showLocation ? (
            <p className="mt-0.5 truncate text-xs text-brand-500 dark:text-brand-300">
              {showLocation}
            </p>
          ) : null}
          {item.kind === 'file' && item.file.tags.length > 0 ? (
            <p className="mt-1 truncate text-xs text-ink-faint dark:text-[#77828f]">
              {item.file.tags.map((tag) => `#${tag}`).join(' ')}
            </p>
          ) : null}
          {item.kind === 'file' ? <CloudProgressBar file={item.file} /> : null}
        </div>
        {item.kind === 'folder' ? (
          <ChevronRight size={18} className="shrink-0 text-ink-faint" aria-hidden="true" />
        ) : null}
      </div>
      {/* 3点リーダーは常に行の右端・縦中央。ファイル名の長さに影響されない固定幅にする */}
      <button
        type="button"
        aria-label={`${name} の操作メニュー`}
        onClick={() => handlers.onMenu(item)}
        className="flex w-tap shrink-0 items-center justify-center self-stretch text-ink-sub active:bg-surface-sub dark:text-[#98a3b0] dark:active:bg-[#232b35]"
      >
        <MoreVertical size={20} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* グリッド表示                                                        */
/* ------------------------------------------------------------------ */

export function GridCell({ item, handlers }: { item: ExplorerItem; handlers: ItemHandlers }) {
  const press = useLongPress(
    () => handlers.onMenu(item),
    () => handlers.onOpen(item),
  );
  const name = item.kind === 'folder' ? item.folder.name : item.file.name;
  const favorite = item.kind === 'folder' ? item.folder.isFavorite : item.file.isFavorite;

  return (
    <div className="relative">
      <div
        {...press}
        role="button"
        tabIndex={0}
        className="no-callout card flex h-full min-h-[112px] flex-col items-center justify-center gap-2 p-3 text-center active:bg-surface-sub dark:active:bg-[#232b35]"
      >
        {item.kind === 'folder' ? <FolderIcon color={item.folder.color} size={40} /> : <PdfIcon size={38} />}
        <p className="line-clamp-2 w-full break-all text-sm text-ink dark:text-[#e6eaef]">
          {middleEllipsis(name, 24)}
        </p>
        <p className="flex items-center gap-1 text-xs text-ink-sub dark:text-[#98a3b0]">
          {item.kind === 'folder' ? '' : formatBytes(item.file.size)}
          {item.kind === 'file' ? <CloudBadge file={item.file} /> : null}
        </p>
      </div>
      <div className="pointer-events-none absolute left-1.5 top-1.5">
        <FavoriteMark on={favorite} />
      </div>
      <button
        type="button"
        aria-label={`${name} の操作メニュー`}
        onClick={() => handlers.onMenu(item)}
        className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center text-ink-faint"
      >
        <MoreVertical size={18} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* サムネイル表示                                                      */
/* ------------------------------------------------------------------ */

export function ThumbCell({ item, handlers }: { item: ExplorerItem; handlers: ItemHandlers }) {
  const press = useLongPress(
    () => handlers.onMenu(item),
    () => handlers.onOpen(item),
  );
  const name = item.kind === 'folder' ? item.folder.name : item.file.name;

  return (
    <div className="relative">
      <div
        {...press}
        role="button"
        tabIndex={0}
        className="no-callout card flex h-full flex-col items-center gap-2 p-2.5 active:bg-surface-sub dark:active:bg-[#232b35]"
      >
        {item.kind === 'folder' ? (
          <div className="flex h-[132px] w-full items-center justify-center">
            <FolderIcon color={item.folder.color} size={56} />
          </div>
        ) : (
          <Thumb file={item.file} size={100} />
        )}
        <p className="line-clamp-2 w-full break-all text-center text-sm text-ink dark:text-[#e6eaef]">
          {middleEllipsis(name, 24)}
        </p>
        <p className="flex items-center gap-1 text-xs text-ink-sub dark:text-[#98a3b0]">
          {item.kind === 'folder'
            ? ''
            : `${formatBytes(item.file.size)}${item.file.pageCount ? ` ・ ${item.file.pageCount}p` : ''}`}
          {item.kind === 'file' ? <CloudBadge file={item.file} /> : null}
        </p>
      </div>
      <button
        type="button"
        aria-label={`${name} の操作メニュー`}
        onClick={() => handlers.onMenu(item)}
        className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center text-ink-faint"
      >
        <MoreVertical size={18} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ホーム画面のフォルダーカード                                        */
/* ------------------------------------------------------------------ */

export function FolderCard({
  folder,
  count,
  updatedAt,
  onOpen,
  onMenu,
}: {
  folder: Folder;
  count: number;
  updatedAt: string;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const press = useLongPress(onMenu, onOpen);
  return (
    <div className="relative">
      <div
        {...press}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onOpen();
        }}
        className="no-callout card flex min-h-[92px] items-center gap-3 p-3 active:bg-surface-sub dark:active:bg-[#232b35]"
      >
        <FolderIcon color={folder.color} size={38} />
        <div className="min-w-0 flex-1 pr-10">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-base font-medium text-ink dark:text-[#e6eaef]">
              {folder.name}
            </p>
            <FavoriteMark on={folder.isFavorite} />
          </div>
          <p className="mt-1 text-xs text-ink-sub dark:text-[#98a3b0]">PDF {count} 件</p>
          <p className="text-xs text-ink-faint dark:text-[#77828f]">{formatDateTime(updatedAt)}</p>
        </div>
      </div>
      <button
        type="button"
        aria-label={`${folder.name} の操作メニュー`}
        onClick={onMenu}
        className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center text-ink-faint"
      >
        <MoreVertical size={18} />
      </button>
    </div>
  );
}

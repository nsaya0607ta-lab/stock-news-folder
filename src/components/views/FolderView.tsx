'use client';

/**
 * フォルダー画面。
 * パンくずリスト・1つ上へ・最上位へ・前へ戻る・フォルダー内検索を備え、
 * パソコンのエクスプローラーに近い操作感にする。
 */
import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  CornerLeftUp,
  FolderOpen,
  Home,
  ListFilter,
  Search,
  X,
} from 'lucide-react';
import { ROOT_ID, type ExplorerItem } from '@/lib/types';
import { breadcrumbs, childFiles, childFolders, sortItems } from '@/lib/tree';
import { useApp } from '@/store/AppStore';
import { ItemList } from '@/components/items/ItemList';
import type { ItemHandlers } from '@/components/items/ItemViews';
import { Button, EmptyState, IconButton, cx } from '@/components/ui/Primitives';
import { Header } from './Header';

export function FolderView({
  folderId,
  handlers,
  onOpenSort,
  onAdd,
}: {
  folderId: string;
  handlers: ItemHandlers;
  onOpenSort: () => void;
  onAdd: () => void;
}) {
  const { folders, files, settings, navigate, goBack, goForward, goUp, goHome, canGoBack, canGoForward } =
    useApp();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  const trail = useMemo(() => breadcrumbs(folders, folderId), [folders, folderId]);
  const current = folders.find((folder) => folder.id === folderId);

  const items = useMemo(() => {
    const list: ExplorerItem[] = [
      ...childFolders(folders, folderId).map((folder) => ({ kind: 'folder' as const, folder })),
      ...childFiles(files, folderId).map((file) => ({ kind: 'file' as const, file })),
    ];
    const filtered = query.trim()
      ? list.filter((item) => {
          const name = item.kind === 'folder' ? item.folder.name : item.file.name;
          return name.toLowerCase().includes(query.trim().toLowerCase());
        })
      : list;
    return sortItems(filtered, settings.sortKey, settings.foldersFirst);
  }, [files, folderId, folders, query, settings.foldersFirst, settings.sortKey]);

  return (
    <>
      <Header
        title={current?.name ?? 'フォルダー'}
        subtitle={`${items.length} 件`}
        left={
          <IconButton label="前の画面へ戻る" onClick={goBack} disabled={!canGoBack}>
            <ArrowLeft size={22} className={canGoBack ? '' : 'opacity-30'} />
          </IconButton>
        }
        right={
          <div className="flex items-center">
            <IconButton label="次の画面へ進む" onClick={goForward} disabled={!canGoForward}>
              <ArrowRight size={22} className={canGoForward ? '' : 'opacity-30'} />
            </IconButton>
            <IconButton
              label="フォルダー内を検索"
              onClick={() => {
                setSearchOpen((value) => !value);
                if (searchOpen) setQuery('');
              }}
            >
              <Search size={22} />
            </IconButton>
            <IconButton label="表示と並べ替え" onClick={onOpenSort}>
              <ListFilter size={22} />
            </IconButton>
          </div>
        }
      >
        {/* パンくずリスト */}
        <div className="flex items-center gap-0.5 border-t divider px-1 py-1">
          <IconButton label="最上位フォルダーへ" onClick={goHome} className="h-9 w-9">
            <Home size={18} />
          </IconButton>
          <IconButton label="1つ上のフォルダーへ" onClick={goUp} className="h-9 w-9">
            <CornerLeftUp size={18} />
          </IconButton>
          <nav
            aria-label="現在の位置"
            // パンくずリストは横に指で送れる必要があるため、横方向の操作を許可する
            style={{ touchAction: 'pan-x' }}
            className="hide-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap"
          >
            {trail.map((node, index) => (
              <span key={node.id} className="flex shrink-0 items-center">
                {index > 0 ? (
                  <ChevronRight size={14} className="mx-0.5 shrink-0 text-ink-faint" />
                ) : null}
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      node.id === ROOT_ID ? { view: 'home' } : { view: 'folder', folderId: node.id },
                    )
                  }
                  className={cx(
                    'min-h-[36px] rounded-[4px] px-1.5 text-sm',
                    index === trail.length - 1
                      ? 'font-semibold text-ink dark:text-[#e6eaef]'
                      : 'text-brand-500 dark:text-brand-300',
                  )}
                >
                  {node.name}
                </button>
              </span>
            ))}
          </nav>
        </div>

        {searchOpen ? (
          <div className="flex items-center gap-2 border-t divider px-3 py-2">
            <Search size={18} className="shrink-0 text-ink-faint" />
            <input
              autoFocus
              className="field h-10 py-1"
              placeholder="このフォルダー内を検索"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <IconButton
              label="検索を閉じる"
              className="h-10 w-10"
              onClick={() => {
                setQuery('');
                setSearchOpen(false);
              }}
            >
              <X size={20} />
            </IconButton>
          </div>
        ) : null}
      </Header>

      {items.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={48} strokeWidth={1.2} />}
          title={query ? '該当する項目がありません' : 'このフォルダーは空です'}
          description={
            query
              ? '別のキーワードで検索してください。'
              : '画面下中央の「PDF追加」ボタンから、PDFの追加やフォルダーの作成ができます。'
          }
          action={
            query ? null : (
              <Button variant="primary" className="mt-2" onClick={onAdd}>
                PDFを追加
              </Button>
            )
          }
        />
      ) : (
        <div className={settings.viewMode === 'list' ? 'card mx-0 my-0 rounded-none border-x-0' : ''}>
          <ItemList items={items} viewMode={settings.viewMode} handlers={handlers} />
        </div>
      )}
    </>
  );
}

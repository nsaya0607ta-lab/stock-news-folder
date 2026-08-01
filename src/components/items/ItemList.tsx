'use client';

import type { ExplorerItem, ViewMode } from '@/lib/types';
import { GridCell, ListRow, ThumbCell, type ItemHandlers } from './ItemViews';

export function ItemList({
  items,
  viewMode,
  handlers,
  locationOf,
}: {
  items: ExplorerItem[];
  viewMode: ViewMode;
  handlers: ItemHandlers;
  /** 検索結果などで保存場所を表示したいときに使う。 */
  locationOf?: (item: ExplorerItem) => string | undefined;
}) {
  const keyOf = (item: ExplorerItem) =>
    item.kind === 'folder' ? `folder-${item.folder.id}` : `file-${item.file.id}`;

  // no-h-swipe: 一覧の上で指を横に動かしても画面が左右に動かないようにする
  if (viewMode === 'grid') {
    return (
      <div className="no-h-swipe grid grid-cols-3 gap-2.5 px-4 py-3 sm:grid-cols-4 md:grid-cols-6">
        {items.map((item) => (
          <GridCell key={keyOf(item)} item={item} handlers={handlers} />
        ))}
      </div>
    );
  }

  if (viewMode === 'thumbnail') {
    return (
      <div className="no-h-swipe grid grid-cols-2 gap-2.5 px-4 py-3 sm:grid-cols-3 md:grid-cols-5">
        {items.map((item) => (
          <ThumbCell key={keyOf(item)} item={item} handlers={handlers} />
        ))}
      </div>
    );
  }

  return (
    <div className="no-h-swipe bg-surface dark:bg-[#181e26]">
      {items.map((item) => (
        <ListRow
          key={keyOf(item)}
          item={item}
          handlers={handlers}
          showLocation={locationOf?.(item)}
        />
      ))}
    </div>
  );
}

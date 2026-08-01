/**
 * フォルダー階層に関する純粋関数。
 * ストア (メモリ上のフォルダー/ファイル一覧) を受け取り、
 * パンくず・子要素・並べ替えなどを計算する。
 */
import { ROOT_ID } from './types';
import type { ExplorerItem, Folder, PdfFileMeta, SortKey } from './types';

export const ROOT_NAME = '株式ニュースフォルダー';

export function toParentKey(parentId: string | null | undefined): string {
  return parentId ?? ROOT_ID;
}

export function isRoot(id: string | null | undefined): boolean {
  return toParentKey(id) === ROOT_ID;
}

export function activeFolders(folders: Folder[]): Folder[] {
  return folders.filter((folder) => !folder.deletedAt);
}

export function activeFiles(files: PdfFileMeta[]): PdfFileMeta[] {
  return files.filter((file) => !file.deletedAt);
}

export function childFolders(folders: Folder[], parentId: string): Folder[] {
  return activeFolders(folders).filter((folder) => toParentKey(folder.parentId) === parentId);
}

export function childFiles(files: PdfFileMeta[], parentId: string): PdfFileMeta[] {
  return activeFiles(files).filter((file) => toParentKey(file.parentId) === parentId);
}

export function findFolder(folders: Folder[], id: string | null | undefined): Folder | undefined {
  if (!id || id === ROOT_ID) return undefined;
  return folders.find((folder) => folder.id === id);
}

/** ルートから対象フォルダーまでのパンくず (ルート自身を含む)。 */
export function breadcrumbs(
  folders: Folder[],
  folderId: string,
): { id: string; name: string }[] {
  const trail: { id: string; name: string }[] = [];
  let current = findFolder(folders, folderId);
  const guard = new Set<string>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    trail.unshift({ id: current.id, name: current.name });
    current = findFolder(folders, current.parentId);
  }
  return [{ id: ROOT_ID, name: ROOT_NAME }, ...trail];
}

/** 「株式ニュースフォルダー ＞ NVDA」形式の文字列パス。 */
export function pathString(folders: Folder[], folderId: string): string {
  return breadcrumbs(folders, folderId)
    .map((node) => node.name)
    .join(' ＞ ');
}

/** 自分自身と、その配下すべてのフォルダー ID。 */
export function descendantFolderIds(folders: Folder[], folderId: string): Set<string> {
  const result = new Set<string>([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      const parent = toParentKey(folder.parentId);
      if (result.has(parent) && !result.has(folder.id)) {
        result.add(folder.id);
        changed = true;
      }
    }
  }
  return result;
}

/** フォルダー配下 (サブフォルダー含む) の生きている PDF。 */
export function filesUnder(
  folders: Folder[],
  files: PdfFileMeta[],
  folderId: string,
): PdfFileMeta[] {
  const ids = descendantFolderIds(activeFolders(folders), folderId);
  return activeFiles(files).filter((file) => ids.has(toParentKey(file.parentId)));
}

/** フォルダー直下の PDF 数 (ホーム画面の表示用にサブフォルダー分も数える)。 */
export function countPdfInFolder(
  folders: Folder[],
  files: PdfFileMeta[],
  folderId: string,
): number {
  return filesUnder(folders, files, folderId).length;
}

/** フォルダーの「最終更新日時」= 自身と配下の中で最も新しい更新時刻。 */
export function folderUpdatedAt(
  folders: Folder[],
  files: PdfFileMeta[],
  folder: Folder,
): string {
  const ids = descendantFolderIds(activeFolders(folders), folder.id);
  let latest = folder.updatedAt;
  for (const child of activeFolders(folders)) {
    if (ids.has(child.id) && child.updatedAt > latest) latest = child.updatedAt;
  }
  for (const file of activeFiles(files)) {
    if (ids.has(toParentKey(file.parentId)) && file.updatedAt > latest) latest = file.updatedAt;
  }
  return latest;
}

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

export function compareItems(a: ExplorerItem, b: ExplorerItem, sortKey: SortKey): number {
  const nameOf = (item: ExplorerItem) => (item.kind === 'folder' ? item.folder.name : item.file.name);
  const updatedOf = (item: ExplorerItem) =>
    item.kind === 'folder' ? item.folder.updatedAt : item.file.updatedAt;
  const favOf = (item: ExplorerItem) =>
    item.kind === 'folder' ? item.folder.isFavorite : item.file.isFavorite;
  const orderOf = (item: ExplorerItem) =>
    (item.kind === 'folder' ? item.folder.sortOrder : item.file.sortOrder) ?? Number.MAX_SAFE_INTEGER;

  switch (sortKey) {
    case 'name':
      return collator.compare(nameOf(a), nameOf(b));
    case 'updatedDesc':
      return updatedOf(b).localeCompare(updatedOf(a));
    case 'updatedAsc':
      return updatedOf(a).localeCompare(updatedOf(b));
    case 'size': {
      const sizeOf = (item: ExplorerItem) => (item.kind === 'file' ? item.file.size : -1);
      return sizeOf(b) - sizeOf(a) || collator.compare(nameOf(a), nameOf(b));
    }
    case 'type': {
      // フォルダー → PDF の順。同種内は名前順。
      const typeOf = (item: ExplorerItem) => (item.kind === 'folder' ? 0 : 1);
      return typeOf(a) - typeOf(b) || collator.compare(nameOf(a), nameOf(b));
    }
    case 'favorite': {
      const fav = Number(favOf(b)) - Number(favOf(a));
      return fav || collator.compare(nameOf(a), nameOf(b));
    }
    case 'manual':
      return orderOf(a) - orderOf(b) || collator.compare(nameOf(a), nameOf(b));
    default:
      return 0;
  }
}

export function sortItems(
  items: ExplorerItem[],
  sortKey: SortKey,
  foldersFirst: boolean,
): ExplorerItem[] {
  const sorted = [...items].sort((a, b) => compareItems(a, b, sortKey));
  if (!foldersFirst) return sorted;
  return [
    ...sorted.filter((item) => item.kind === 'folder'),
    ...sorted.filter((item) => item.kind === 'file'),
  ];
}

export const SORT_LABELS: Record<SortKey, string> = {
  name: '名前順',
  updatedDesc: '更新日時が新しい順',
  updatedAsc: '更新日時が古い順',
  size: 'ファイルサイズ順',
  type: 'ファイル形式順',
  favorite: 'お気に入り順',
  manual: '手動並べ替え',
};

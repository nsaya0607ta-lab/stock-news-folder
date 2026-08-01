/**
 * アプリ内検索。
 *
 * 現在はメタデータ (ファイル名・フォルダー名・タグ・メモ・日付) が対象。
 * 将来 PDF 本文の全文検索を足すときは、`matchers` に本文インデックスを見る
 * 判定を追加すれば、UI 側を変更せずに検索対象を広げられる。
 */
import { memoPageLabel, memoPageSearchText } from './memos';
import { pathString, toParentKey } from './tree';
import type { Folder, PdfFileMeta, PdfMemo } from './types';

/**
 * 検索対象。
 * - `memo`   … PDF 自体に付いている 1 行メモ (従来のタグ・メモ欄)
 * - `pdfMemo`… PDF ごとのメモ (タイトル・本文・タグ・対象ページ)
 */
export type SearchField = 'name' | 'folder' | 'tag' | 'memo' | 'pdfMemo';

export type SearchFilters = {
  query: string;
  fields: SearchField[];
  /** 保存日 (createdAt) の範囲。YYYY-MM-DD。 */
  createdFrom?: string;
  createdTo?: string;
  /** 更新日 (updatedAt) の範囲。 */
  updatedFrom?: string;
  updatedTo?: string;
  onlyFavorite?: boolean;
  tags?: string[];
};

export const DEFAULT_FILTERS: SearchFilters = {
  query: '',
  fields: ['name', 'folder', 'tag', 'memo', 'pdfMemo'],
};

export type SearchHit =
  | { kind: 'folder'; folder: Folder; path: string }
  | { kind: 'file'; file: PdfFileMeta; path: string }
  /** メモの一致。`page` があれば、その PDF の該当ページを直接開ける。 */
  | { kind: 'memo'; memo: PdfMemo; file: PdfFileMeta; path: string; page?: number };

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKC')
    // ひらがな → カタカナ に寄せて、かな違いでも引っかかるようにする
    .replace(/[ぁ-ゖ]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60));
}

function inRange(iso: string | undefined, from?: string, to?: string): boolean {
  if (!from && !to) return true;
  if (!iso) return false;
  const value = iso.slice(0, 10);
  if (from && value < from) return false;
  if (to && value > to) return false;
  return true;
}

export function hasActiveFilters(filters: SearchFilters): boolean {
  return Boolean(
    filters.query.trim() ||
      filters.createdFrom ||
      filters.createdTo ||
      filters.updatedFrom ||
      filters.updatedTo ||
      filters.onlyFavorite ||
      (filters.tags && filters.tags.length > 0),
  );
}

export function searchAll(
  folders: Folder[],
  files: PdfFileMeta[],
  filters: SearchFilters,
  options: { scopeFolderIds?: Set<string>; memos?: PdfMemo[] } = {},
): SearchHit[] {
  const query = normalize(filters.query.trim());
  const fields = new Set(filters.fields);
  const scope = options.scopeFolderIds;
  const hits: SearchHit[] = [];

  const matchesText = (values: (string | undefined)[]) => {
    if (!query) return true;
    return values.some((value) => value && normalize(value).includes(query));
  };

  if (fields.has('folder')) {
    for (const folder of folders) {
      if (folder.deletedAt) continue;
      if (scope && !scope.has(folder.id)) continue;
      if (filters.onlyFavorite && !folder.isFavorite) continue;
      if (!inRange(folder.createdAt, filters.createdFrom, filters.createdTo)) continue;
      if (!inRange(folder.updatedAt, filters.updatedFrom, filters.updatedTo)) continue;
      if (filters.tags && filters.tags.length > 0) continue; // フォルダーにタグは無い
      if (!matchesText([folder.name])) continue;
      hits.push({
        kind: 'folder',
        folder,
        path: pathString(folders, toParentKey(folder.parentId)),
      });
    }
  }

  for (const file of files) {
    if (file.deletedAt) continue;
    if (scope && !scope.has(toParentKey(file.parentId))) continue;
    if (filters.onlyFavorite && !file.isFavorite) continue;
    if (!inRange(file.createdAt, filters.createdFrom, filters.createdTo)) continue;
    if (!inRange(file.updatedAt, filters.updatedFrom, filters.updatedTo)) continue;
    if (filters.tags && filters.tags.length > 0) {
      if (!filters.tags.every((tag) => file.tags.includes(tag))) continue;
    }

    const candidates: (string | undefined)[] = [];
    if (fields.has('name')) candidates.push(file.name);
    if (fields.has('tag')) candidates.push(file.tags.join(' '));
    if (fields.has('memo')) candidates.push(file.memo);
    if (fields.has('folder')) candidates.push(pathString(folders, toParentKey(file.parentId)));
    if (!matchesText(candidates)) continue;

    hits.push({ kind: 'file', file, path: pathString(folders, toParentKey(file.parentId)) });
  }

  /* PDF ごとのメモ ------------------------------------------------- */
  if (fields.has('pdfMemo') && options.memos && options.memos.length > 0) {
    const byId = new Map(files.map((file) => [file.id, file]));

    for (const memo of options.memos) {
      // メモは不変の fileId で紐付いているので、PDF を移動・改名しても必ず見つかる
      const file = byId.get(memo.fileId);
      if (!file || file.deletedAt) continue;
      if (scope && !scope.has(toParentKey(file.parentId))) continue;
      if (filters.onlyFavorite && !memo.isFavorite) continue;
      if (!inRange(memo.createdAt, filters.createdFrom, filters.createdTo)) continue;
      if (!inRange(memo.updatedAt, filters.updatedFrom, filters.updatedTo)) continue;
      if (filters.tags && filters.tags.length > 0) {
        if (!filters.tags.every((tag) => memo.tags.includes(tag))) continue;
      }

      // タイトル・本文・タグ・対象ページを対象にする
      const matched = matchesText([
        memo.title,
        memo.content,
        memo.tags.join(' '),
        memoPageLabel(memo),
        memoPageSearchText(memo),
      ]);
      if (!matched) continue;

      hits.push({
        kind: 'memo',
        memo,
        file,
        path: pathString(folders, toParentKey(file.parentId)),
        page: memo.pageStart,
      });
    }
  }

  return hits;
}

/** メモに使われているタグ一覧 (使用数の多い順)。 */
export function collectMemoTags(memos: PdfMemo[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const memo of memos) {
    for (const tag of memo.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ja'));
}

/** 登録済みのタグ一覧 (使用数の多い順)。 */
export function collectTags(files: PdfFileMeta[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (file.deletedAt) continue;
    for (const tag of file.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ja'));
}

/** タグ入力の候補として最初から並べておく例。 */
export const SUGGESTED_TAGS = ['Azure', 'Linux', 'LPIC', '業務手順', '資格勉強', '重要'];

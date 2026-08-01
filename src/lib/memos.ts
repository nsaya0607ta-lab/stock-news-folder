/**
 * PDF ごとのメモ。
 *
 * 保存先は IndexedDB の設定ストアに相乗りした「ファイル 1 件 = 1 レコード」形式
 * (`memo:<fileId>` → PdfMemo[])。専用のオブジェクトストアを足すと DB のバージョンが
 * 上がり、更新前の Service Worker が VersionError で止まってしまうため、
 * cloudQueue と同じくキー付きレコードで持つ (詳細は db.ts の readKeyed を参照)。
 *
 * 紐付けは必ず不変の `fileId` で行う。ファイル名・フォルダーは変わりうるので使わない。
 */
import { deleteKeyed, mutateKeyed, readKeyed, readKeyedByPrefix } from './db';
import { createId, nowIso } from './naming';
import { currentOwnerId, isOwnedBy, setOwnerId } from './owner';
import { LOCAL_OWNER_ID, type MemoSortKey, type PdfMemo } from './types';

const MEMO_PREFIX = 'memo:';

function memoKey(fileId: string): string {
  return `${MEMO_PREFIX}${fileId}`;
}

/* ------------------------------------------------------------------ */
/* 持ち主 (ログインユーザー)                                            */
/* ------------------------------------------------------------------ */

/**
 * 持ち主の判定は owner.ts に集約している (メモと自動分類ルールで共通)。
 * 既存の呼び出し元との互換のため、名前だけここでも公開する。
 */
export const memoOwnerId = currentOwnerId;
export const setMemoOwnerId = setOwnerId;

function isOwned(memo: PdfMemo): boolean {
  return isOwnedBy(memo.userId);
}

/** 保存されている値が壊れていても落ちないように整える。 */
function normalize(value: unknown, fileId: string): PdfMemo | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PdfMemo>;
  if (typeof raw.id !== 'string' || typeof raw.content !== 'string') return null;
  const timestamp = typeof raw.createdAt === 'string' ? raw.createdAt : nowIso();
  return {
    id: raw.id,
    userId: typeof raw.userId === 'string' && raw.userId ? raw.userId : LOCAL_OWNER_ID,
    fileId,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    content: raw.content,
    pageStart: toPage(raw.pageStart),
    pageEnd: toPage(raw.pageEnd),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    isFavorite: Boolean(raw.isFavorite),
    isReview: Boolean(raw.isReview),
    isDraft: Boolean(raw.isDraft),
    createdAt: timestamp,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : timestamp,
  };
}

function toPage(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const page = Math.floor(value);
  return page >= 1 ? page : undefined;
}

/* ------------------------------------------------------------------ */
/* 読み書き                                                            */
/* ------------------------------------------------------------------ */

/** 指定 PDF のメモ (現在の持ち主のぶんだけ)。 */
export async function listMemos(fileId: string): Promise<PdfMemo[]> {
  const stored = await readKeyed<unknown[]>(memoKey(fileId));
  if (!Array.isArray(stored)) return [];
  return stored
    .map((entry) => normalize(entry, fileId))
    .filter((memo): memo is PdfMemo => memo !== null && isOwned(memo));
}

/** すべての PDF のメモ (検索・一覧のバッジ表示に使う)。 */
export async function listAllMemos(): Promise<PdfMemo[]> {
  const rows = await readKeyedByPrefix<unknown[]>(MEMO_PREFIX);
  const memos: PdfMemo[] = [];
  for (const row of rows) {
    const fileId = row.key.slice(MEMO_PREFIX.length);
    if (!Array.isArray(row.value)) continue;
    for (const entry of row.value) {
      const memo = normalize(entry, fileId);
      if (memo && isOwned(memo)) memos.push(memo);
    }
  }
  return memos;
}

/**
 * 1 ファイル分のメモを読み → 変更 → 書き戻す。
 * 他の持ち主のメモは触らずにそのまま残す。
 */
async function mutateMemos(
  fileId: string,
  change: (mine: PdfMemo[]) => PdfMemo[],
): Promise<PdfMemo[]> {
  let result: PdfMemo[] = [];
  await mutateKeyed<unknown[]>(memoKey(fileId), (current) => {
    const all = Array.isArray(current)
      ? current.map((entry) => normalize(entry, fileId)).filter((memo): memo is PdfMemo => memo !== null)
      : [];
    const others = all.filter((memo) => !isOwned(memo));
    result = change(all.filter(isOwned));
    const next = [...others, ...result];
    return next.length > 0 ? next : undefined;
  });
  return result;
}

export type MemoInput = {
  id?: string;
  fileId: string;
  title?: string;
  content: string;
  pageStart?: number;
  pageEnd?: number;
  tags?: string[];
  isFavorite?: boolean;
  isReview?: boolean;
  /** 入力途中の自動保存なら true。明示的な「保存」では false。 */
  isDraft?: boolean;
};

/**
 * メモを保存する (新規作成 / 上書きの両対応)。
 * `id` を渡せば既存のメモを更新し、渡さなければ新しいメモを作る。
 */
export async function saveMemo(input: MemoInput): Promise<PdfMemo> {
  const timestamp = nowIso();
  const pages = normalizePageRange(input.pageStart, input.pageEnd);
  let saved: PdfMemo | null = null;

  await mutateMemos(input.fileId, (mine) => {
    const existing = input.id ? mine.find((memo) => memo.id === input.id) : undefined;
    const memo: PdfMemo = {
      id: existing?.id ?? input.id ?? createId('memo'),
      userId: existing?.userId ?? currentOwnerId(),
      fileId: input.fileId,
      title: input.title?.trim() ? input.title.trim() : undefined,
      content: input.content,
      pageStart: pages.pageStart,
      pageEnd: pages.pageEnd,
      tags: (input.tags ?? existing?.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
      isFavorite: input.isFavorite ?? existing?.isFavorite ?? false,
      isReview: input.isReview ?? existing?.isReview ?? false,
      isDraft: input.isDraft ?? false,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    saved = memo;
    return existing
      ? mine.map((entry) => (entry.id === memo.id ? memo : entry))
      : [...mine, memo];
  });

  if (!saved) throw new Error('メモを保存できませんでした。');
  return saved;
}

/** 一部の項目だけ差し替える (お気に入り・復習項目の切り替えなど)。 */
export async function patchMemo(
  fileId: string,
  memoId: string,
  patch: Partial<Omit<PdfMemo, 'id' | 'fileId' | 'userId' | 'createdAt'>>,
): Promise<PdfMemo | undefined> {
  let updated: PdfMemo | undefined;
  await mutateMemos(fileId, (mine) =>
    mine.map((memo) => {
      if (memo.id !== memoId) return memo;
      updated = { ...memo, ...patch, updatedAt: nowIso() };
      return updated;
    }),
  );
  return updated;
}

export async function deleteMemo(fileId: string, memoId: string): Promise<void> {
  await mutateMemos(fileId, (mine) => mine.filter((memo) => memo.id !== memoId));
}

/** PDF を完全削除するときに、そのメモも片付ける。 */
export async function deleteMemosOfFile(fileId: string): Promise<void> {
  await deleteKeyed(memoKey(fileId));
}

/** メモをまとめて追加する (PDF のコピー・分割・結合の引き継ぎで使う)。 */
export async function appendMemos(fileId: string, memos: PdfMemo[]): Promise<void> {
  if (memos.length === 0) return;
  await mutateMemos(fileId, (mine) => [...mine, ...memos]);
}

/**
 * ログイン直後に、ログイン前のメモを本人のものとして引き継ぐ。
 * 引き継ぎ後は、別アカウントでログインした人からは見えなくなる。
 */
export async function claimLocalMemos(uid: string): Promise<void> {
  if (!uid || uid === LOCAL_OWNER_ID) return;
  const rows = await readKeyedByPrefix<unknown[]>(MEMO_PREFIX);
  for (const row of rows) {
    const fileId = row.key.slice(MEMO_PREFIX.length);
    if (!Array.isArray(row.value)) continue;
    const hasLocal = row.value.some((entry) => {
      const memo = normalize(entry, fileId);
      return memo?.userId === LOCAL_OWNER_ID;
    });
    if (!hasLocal) continue;
    await mutateKeyed<unknown[]>(memoKey(fileId), (current) => {
      if (!Array.isArray(current)) return current;
      return current.map((entry) => {
        const memo = normalize(entry, fileId);
        if (!memo || memo.userId !== LOCAL_OWNER_ID) return entry;
        return { ...memo, userId: uid };
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* ページとの対応                                                      */
/* ------------------------------------------------------------------ */

/** 開始 > 終了 のような入力を直し、1 ページ分なら pageEnd を省く。 */
export function normalizePageRange(
  start?: number,
  end?: number,
): { pageStart?: number; pageEnd?: number } {
  const from = toPage(start);
  const to = toPage(end);
  if (from === undefined && to === undefined) return {};
  if (from === undefined) return { pageStart: to };
  if (to === undefined || to === from) return { pageStart: from };
  return from <= to ? { pageStart: from, pageEnd: to } : { pageStart: to, pageEnd: from };
}

/** PDF 全体へのメモか。 */
export function isWholeDocumentMemo(memo: PdfMemo): boolean {
  return memo.pageStart === undefined;
}

/** そのメモが指定ページに関係するか。 */
export function memoCoversPage(memo: PdfMemo, page: number): boolean {
  if (memo.pageStart === undefined) return false;
  const end = memo.pageEnd ?? memo.pageStart;
  return page >= memo.pageStart && page <= end;
}

/** 「全体メモ」「3ページ」「12〜13ページ」のような表示用ラベル。 */
export function memoPageLabel(memo: PdfMemo): string {
  if (memo.pageStart === undefined) return '全体メモ';
  const end = memo.pageEnd ?? memo.pageStart;
  return end > memo.pageStart ? `${memo.pageStart}〜${end}ページ` : `${memo.pageStart}ページ`;
}

/** 検索対象にするページ表記 (「3ページ」「p3」どちらでも引っかかるようにする)。 */
export function memoPageSearchText(memo: PdfMemo): string {
  if (memo.pageStart === undefined) return '全体メモ';
  const end = memo.pageEnd ?? memo.pageStart;
  const numbers: string[] = [];
  for (let page = memo.pageStart; page <= end && numbers.length < 64; page += 1) {
    numbers.push(`${page}ページ`, `p${page}`);
  }
  return numbers.join(' ');
}

/* ------------------------------------------------------------------ */
/* 並べ替え                                                            */
/* ------------------------------------------------------------------ */

export function sortMemos(memos: PdfMemo[], key: MemoSortKey): PdfMemo[] {
  const sorted = [...memos];
  switch (key) {
    case 'page':
      // 全体メモを先頭に、そのあとページの小さい順
      sorted.sort((a, b) => {
        const pageA = a.pageStart ?? 0;
        const pageB = b.pageStart ?? 0;
        return pageA - pageB || a.createdAt.localeCompare(b.createdAt);
      });
      break;
    case 'updatedDesc':
      sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      break;
    case 'createdDesc':
    default:
      sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      break;
  }
  return sorted;
}

/* ------------------------------------------------------------------ */
/* ページ編集にともなう紐付けの付け替え                                */
/* ------------------------------------------------------------------ */

/**
 * ページ編集後に、メモの対象ページを新しいページ番号へ付け替える。
 *
 * @param mapping 旧ページ番号 (1 始まり) → 新ページ番号。消えたページは持たない。
 *
 * 消えたページだけを指していたメモは、勝手に削除せず「PDF 全体へのメモ」として残す。
 * 範囲メモは、生き残ったページの範囲へ縮める。
 */
export async function remapMemoPages(
  fileId: string,
  mapping: Map<number, number>,
): Promise<{ moved: number; detached: number }> {
  let moved = 0;
  let detached = 0;

  await mutateMemos(fileId, (mine) =>
    mine.map((memo) => {
      if (memo.pageStart === undefined) return memo;
      const end = memo.pageEnd ?? memo.pageStart;

      const remapped: number[] = [];
      for (let page = memo.pageStart; page <= end; page += 1) {
        const next = mapping.get(page);
        if (next !== undefined) remapped.push(next);
      }

      if (remapped.length === 0) {
        // 対象ページがすべて無くなった。内容は消さずに全体メモへ移す。
        detached += 1;
        return { ...memo, pageStart: undefined, pageEnd: undefined, updatedAt: nowIso() };
      }

      const nextStart = Math.min(...remapped);
      const nextEnd = Math.max(...remapped);
      if (nextStart === memo.pageStart && nextEnd === end) return memo;

      moved += 1;
      return {
        ...memo,
        ...normalizePageRange(nextStart, nextEnd),
        updatedAt: nowIso(),
      };
    }),
  );

  return { moved, detached };
}

/**
 * 指定ページ (旧ページ番号) に紐付くメモを、別の PDF へ複製する。
 * 分割・結合で「メモを引き継ぐ」を選んだときに使う。
 *
 * @param mapping 旧ページ番号 → 引き継ぎ先での新ページ番号
 */
export async function transferMemos(
  fromFileId: string,
  toFileId: string,
  mapping: Map<number, number>,
  options: { includeWholeDocument?: boolean } = {},
): Promise<number> {
  const source = await listMemos(fromFileId);
  const timestamp = nowIso();
  const carried: PdfMemo[] = [];

  for (const memo of source) {
    if (memo.pageStart === undefined) {
      if (!options.includeWholeDocument) continue;
      carried.push({
        ...memo,
        id: createId('memo'),
        fileId: toFileId,
        userId: currentOwnerId(),
        updatedAt: timestamp,
      });
      continue;
    }

    const end = memo.pageEnd ?? memo.pageStart;
    const remapped: number[] = [];
    for (let page = memo.pageStart; page <= end; page += 1) {
      const next = mapping.get(page);
      if (next !== undefined) remapped.push(next);
    }
    if (remapped.length === 0) continue;

    carried.push({
      ...memo,
      id: createId('memo'),
      fileId: toFileId,
      userId: currentOwnerId(),
      ...normalizePageRange(Math.min(...remapped), Math.max(...remapped)),
      updatedAt: timestamp,
    });
  }

  await appendMemos(toFileId, carried);
  return carried.length;
}

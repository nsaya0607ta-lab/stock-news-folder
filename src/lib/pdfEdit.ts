/**
 * PDF のページ編集 (第 1 段階)。
 *
 * 編集中は「ページの並び」をただの配列として持ち、実際の PDF は保存するときに
 * 一度だけ組み立てる。こうすると元の PDF に一切手を触れずに済み、
 * 元に戻す / やり直すも配列のスナップショットを差し替えるだけで実現できる。
 *
 * 組み立てには pdf-lib を使う (ブラウザーだけで完結し、既存の画像→PDF 変換でも実績がある)。
 */
import { AppError } from './errors';
import { toJpegBitmap } from './imageToPdf';
import { createId } from './naming';

/** A4 縦 (ポイント)。空白ページの既定サイズ。 */
export const A4_SIZE = { width: 595.28, height: 841.89 } as const;

/** 1 回の編集で扱えるページ数の上限 (端末が固まらないようにするための保険)。 */
export const MAX_EDIT_PAGES = 2000;

/** ページの出どころ。 */
export type PageSource =
  /** 読み込み済み PDF の index ページ目 (0 始まり)。 */
  | { kind: 'doc'; docId: string; index: number }
  /** 空白ページ。 */
  | { kind: 'blank'; width: number; height: number }
  /** 画像 1 枚を 1 ページにしたもの。 */
  | { kind: 'image'; imageId: string };

/** 編集中の 1 ページ。 */
export type EditPage = {
  /** 並べ替えと React の key に使う一意な識別子。 */
  key: string;
  source: PageSource;
  /** 元の向きに加える回転 (0 / 90 / 180 / 270)。 */
  rotation: number;
  /**
   * 編集前の PDF で何ページ目だったか (1 始まり)。
   * メモの紐付けを付け替えるために使う。新しく足したページは null。
   */
  originPage: number | null;
  /**
   * アプリ内の別 PDF から取り込んだページの出どころ。
   * 結合したときに、元 PDF のメモを引き継ぐかどうかの判断に使う。
   */
  importedFrom?: { fileId: string; page: number };
};

/** 編集に使う素材 (元 PDF・追加した PDF・追加した画像)。 */
export type EditAssets = {
  /** docId → PDF のバイト列。元 PDF の docId は ORIGIN_DOC_ID。 */
  docs: Map<string, Uint8Array>;
  /** imageId → 画像のバイト列 (JPEG に統一済み)。 */
  images: Map<string, { data: Uint8Array; width: number; height: number }>;
};

export const ORIGIN_DOC_ID = 'origin';

export function createAssets(originBytes: Uint8Array): EditAssets {
  return {
    docs: new Map([[ORIGIN_DOC_ID, originBytes]]),
    images: new Map(),
  };
}

/* ------------------------------------------------------------------ */
/* ページ配列の操作 (すべて純粋関数。元の配列は変更しない)             */
/* ------------------------------------------------------------------ */

/** 元 PDF のページ数から、編集開始時のページ配列を作る。 */
export function initialPages(pageCount: number): EditPage[] {
  return Array.from({ length: pageCount }, (_, index) => ({
    key: createId('pg'),
    source: { kind: 'doc', docId: ORIGIN_DOC_ID, index } as PageSource,
    rotation: 0,
    originPage: index + 1,
  }));
}

export function movePage(pages: EditPage[], from: number, to: number): EditPage[] {
  if (from === to || from < 0 || from >= pages.length) return pages;
  const next = [...pages];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved);
  return next;
}

export function rotatePages(pages: EditPage[], keys: Set<string>, delta: number): EditPage[] {
  return pages.map((page) =>
    keys.has(page.key)
      ? { ...page, rotation: (((page.rotation + delta) % 360) + 360) % 360 }
      : page,
  );
}

export function deletePages(pages: EditPage[], keys: Set<string>): EditPage[] {
  return pages.filter((page) => !keys.has(page.key));
}

/** 選んだページのすぐ後ろへ複製を挿入する。 */
export function duplicatePages(pages: EditPage[], keys: Set<string>): EditPage[] {
  const next: EditPage[] = [];
  for (const page of pages) {
    next.push(page);
    if (keys.has(page.key)) {
      // 複製ページは「新しく足したページ」として扱う。
      // 元ページのメモが複製側にも二重に付くのを避けるため originPage は引き継がない。
      next.push({ ...page, key: createId('pg'), originPage: null });
    }
  }
  return next;
}

export function insertPages(pages: EditPage[], at: number, added: EditPage[]): EditPage[] {
  const index = Math.max(0, Math.min(pages.length, at));
  return [...pages.slice(0, index), ...added, ...pages.slice(index)];
}

export function blankPage(size: { width: number; height: number } = A4_SIZE): EditPage {
  return {
    key: createId('pg'),
    source: { kind: 'blank', width: size.width, height: size.height },
    rotation: 0,
    originPage: null,
  };
}

/** 画像を素材へ登録し、1 ページ分の EditPage を返す。 */
export async function imagePageFrom(assets: EditAssets, image: Blob): Promise<EditPage> {
  const bitmap = await toJpegBitmap(image);
  const imageId = createId('img');
  assets.images.set(imageId, bitmap);
  return {
    key: createId('pg'),
    source: { kind: 'image', imageId },
    rotation: 0,
    originPage: null,
  };
}

/**
 * 別 PDF を素材へ登録し、その全ページぶんの EditPage を返す。
 * `sourceFileId` を渡すと、結合後にその PDF のメモを引き継げるようになる。
 */
export async function pagesFromPdf(
  assets: EditAssets,
  blob: Blob,
  sourceFileId?: string,
): Promise<EditPage[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { PDFDocument } = await import('pdf-lib');
  let pageCount: number;
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    pageCount = doc.getPageCount();
  } catch (error) {
    throw new AppError('PDF_READ_FAILED', error instanceof Error ? error.message : undefined);
  }
  if (pageCount === 0) throw new AppError('PDF_READ_FAILED');

  const docId = createId('doc');
  assets.docs.set(docId, bytes);
  return Array.from({ length: pageCount }, (_, index) => ({
    key: createId('pg'),
    source: { kind: 'doc', docId, index } as PageSource,
    rotation: 0,
    // 別 PDF から持ってきたページは、この PDF の元ページではない
    originPage: null,
    importedFrom: sourceFileId ? { fileId: sourceFileId, page: index + 1 } : undefined,
  }));
}

/**
 * 取り込んだ別 PDF ごとに「元のページ番号 → 編集後のページ番号」をまとめる。
 * 結合時にメモを引き継ぐときに使う。
 */
export function buildImportMapping(pages: EditPage[]): Map<string, Map<number, number>> {
  const byFile = new Map<string, Map<number, number>>();
  pages.forEach((page, index) => {
    if (!page.importedFrom) return;
    const mapping = byFile.get(page.importedFrom.fileId) ?? new Map<number, number>();
    if (!mapping.has(page.importedFrom.page)) mapping.set(page.importedFrom.page, index + 1);
    byFile.set(page.importedFrom.fileId, mapping);
  });
  return byFile;
}

/* ------------------------------------------------------------------ */
/* メモの付け替えに使うページ対応表                                    */
/* ------------------------------------------------------------------ */

/**
 * 編集前のページ番号 → 編集後のページ番号 の対応表。
 * 消えたページは表に載らない (呼び出し側で「全体メモへ移す」などの扱いをする)。
 * 同じページが複数ある場合は、いちばん先頭の位置を採用する。
 */
export function buildPageMapping(pages: EditPage[]): Map<number, number> {
  const mapping = new Map<number, number>();
  pages.forEach((page, index) => {
    if (page.originPage === null) return;
    if (!mapping.has(page.originPage)) mapping.set(page.originPage, index + 1);
  });
  return mapping;
}

/** 編集で消えてしまう元ページの番号。 */
export function removedOriginPages(originalCount: number, pages: EditPage[]): number[] {
  const alive = new Set(
    pages.map((page) => page.originPage).filter((value): value is number => value !== null),
  );
  const removed: number[] = [];
  for (let page = 1; page <= originalCount; page += 1) {
    if (!alive.has(page)) removed.push(page);
  }
  return removed;
}

/* ------------------------------------------------------------------ */
/* 編集内容の要約 (バージョン履歴の表示に使う)                          */
/* ------------------------------------------------------------------ */

function joinPages(pages: number[], limit = 4): string {
  if (pages.length === 0) return '';
  const shown = pages.slice(0, limit).join('、');
  return pages.length > limit ? `${shown}ほか計${pages.length}` : shown;
}

/** 「3ページを回転、8ページを削除」のような日本語の要約を作る。 */
export function summarizeEdit(original: EditPage[], current: EditPage[]): string {
  const parts: string[] = [];

  const originalCount = original.filter((page) => page.originPage !== null).length;
  const removed = removedOriginPages(originalCount, current);
  if (removed.length > 0) parts.push(`${joinPages(removed)}ページを削除`);

  const rotationBefore = new Map<number, number>();
  for (const page of original) {
    if (page.originPage !== null) rotationBefore.set(page.originPage, page.rotation);
  }
  const rotated = current
    .filter(
      (page) =>
        page.originPage !== null && (rotationBefore.get(page.originPage) ?? 0) !== page.rotation,
    )
    .map((page) => page.originPage as number)
    .sort((a, b) => a - b);
  if (rotated.length > 0) parts.push(`${joinPages(rotated)}ページを回転`);

  const added = current.filter((page) => page.originPage === null).length;
  if (added > 0) parts.push(`${added}ページを追加`);

  // 並び順が変わったか (削除・追加を除いた、生き残ったページ同士の順序で判定)
  const survivors = current
    .map((page) => page.originPage)
    .filter((value): value is number => value !== null);
  const reordered = survivors.some((value, index) => index > 0 && value < survivors[index - 1]);
  if (reordered) parts.push('ページを並べ替え');

  return parts.length > 0 ? parts.join('、') : '変更なし';
}

/** ページ配列が編集前と同じか (保存が必要かの判定)。 */
export function isUnchanged(original: EditPage[], current: EditPage[]): boolean {
  if (original.length !== current.length) return false;
  return original.every((page, index) => {
    const other = current[index];
    return (
      page.key === other.key &&
      page.rotation === other.rotation &&
      page.originPage === other.originPage
    );
  });
}

/* ------------------------------------------------------------------ */
/* PDF の組み立て                                                      */
/* ------------------------------------------------------------------ */

export type BuildProgress = (done: number, total: number) => void;

/** 端末を占有しないよう、一定間隔で描画へ制御を返す。 */
async function yieldToUi(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 現在のページ配列から PDF を組み立てて返す。
 *
 * 元の PDF はここでも呼び出し側でも一切書き換えない。
 * 完成したバイト列を受け取ってから保存処理へ進むので、
 * 途中で失敗しても元の PDF は無傷のまま残る。
 */
export async function buildPdf(
  pages: EditPage[],
  assets: EditAssets,
  onProgress?: BuildProgress,
): Promise<Blob> {
  if (pages.length === 0) throw new AppError('PDF_EDIT_EMPTY');
  if (pages.length > MAX_EDIT_PAGES) throw new AppError('PDF_EDIT_TOO_LARGE');

  const { PDFDocument, degrees } = await import('pdf-lib');
  const out = await PDFDocument.create();

  // 同じ PDF からのページはまとめてコピーする (1 ページずつ読み直すと非常に遅い)
  const groups = new Map<string, { indices: number[]; slots: number[] }>();
  pages.forEach((page, slot) => {
    if (page.source.kind !== 'doc') return;
    const group = groups.get(page.source.docId) ?? { indices: [], slots: [] };
    group.indices.push(page.source.index);
    group.slots.push(slot);
    groups.set(page.source.docId, group);
  });

  const copiedBySlot = new Map<number, Awaited<ReturnType<typeof out.copyPages>>[number]>();
  for (const [docId, group] of groups) {
    const bytes = assets.docs.get(docId);
    if (!bytes) throw new AppError('PDF_READ_FAILED');
    let source;
    try {
      source = await PDFDocument.load(bytes, { ignoreEncryption: true });
    } catch (error) {
      throw new AppError('PDF_READ_FAILED', error instanceof Error ? error.message : undefined);
    }
    const total = source.getPageCount();
    const indices = group.indices.map((index) => Math.max(0, Math.min(total - 1, index)));
    const copied = await out.copyPages(source, indices);
    copied.forEach((page, position) => copiedBySlot.set(group.slots[position], page));
    await yieldToUi();
  }

  for (let slot = 0; slot < pages.length; slot += 1) {
    const entry = pages[slot];
    let added;

    if (entry.source.kind === 'doc') {
      const copied = copiedBySlot.get(slot);
      if (!copied) throw new AppError('PDF_READ_FAILED');
      added = out.addPage(copied);
    } else if (entry.source.kind === 'blank') {
      added = out.addPage([entry.source.width, entry.source.height]);
    } else {
      const image = assets.images.get(entry.source.imageId);
      if (!image) throw new AppError('IMAGE_CONVERT_FAILED');
      const embedded = await out.embedJpg(image.data);
      const margin = 24;
      const page = out.addPage([A4_SIZE.width, A4_SIZE.height]);
      const ratio = Math.min(
        (A4_SIZE.width - margin * 2) / image.width,
        (A4_SIZE.height - margin * 2) / image.height,
      );
      const width = image.width * ratio;
      const height = image.height * ratio;
      page.drawImage(embedded, {
        x: (A4_SIZE.width - width) / 2,
        y: (A4_SIZE.height - height) / 2,
        width,
        height,
      });
      added = page;
    }

    if (entry.rotation !== 0) {
      const base = added.getRotation().angle ?? 0;
      added.setRotation(degrees((((base + entry.rotation) % 360) + 360) % 360));
    }

    onProgress?.(slot + 1, pages.length);
    // 数十ページごとに描画へ譲り、大きな PDF でも操作不能にならないようにする
    if (slot % 25 === 24) await yieldToUi();
  }

  const bytes = await out.save();
  return new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
}

/**
 * 指定したページだけを取り出した PDF を作る (ページの抽出・PDF の分割で使う)。
 * `pages` は編集中の配列、`slots` は取り出す位置 (0 始まり)。
 */
export async function buildSubsetPdf(
  pages: EditPage[],
  slots: number[],
  assets: EditAssets,
  onProgress?: BuildProgress,
): Promise<Blob> {
  const picked = slots
    .filter((slot) => slot >= 0 && slot < pages.length)
    .map((slot) => pages[slot]);
  return buildPdf(picked, assets, onProgress);
}

/** 抽出・分割したあとの「元ページ → 新 PDF でのページ番号」対応表。 */
export function subsetPageMapping(pages: EditPage[], slots: number[]): Map<number, number> {
  const mapping = new Map<number, number>();
  slots.forEach((slot, position) => {
    const page = pages[slot];
    if (!page || page.originPage === null) return;
    if (!mapping.has(page.originPage)) mapping.set(page.originPage, position + 1);
  });
  return mapping;
}

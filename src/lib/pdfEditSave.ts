/**
 * PDF 編集の保存処理。
 *
 * 「元の PDF を壊さない」ことを最優先にした手順で進める。
 *
 *   1. 編集後の PDF をメモリ上で組み立てる (この時点では何も保存していない)
 *   2. 組み上がった PDF を pdf.js で開き直し、本当に読めるか検証する
 *   3. 上書き保存なら、編集前の本体をバージョン履歴へ退避する
 *   4. IndexedDB の 1 トランザクションで本体・メタデータ・サムネイルを差し替える
 *   5. メモの対象ページを新しいページ番号へ付け替える
 *
 * どこで失敗しても元の PDF はそのまま残り、編集内容は下書きとして保存される。
 */
import { deleteKeyed, readKeyed, writeKeyed } from './db';
import { AppError } from './errors';
import { getPageCount } from './pdf';
import {
  ORIGIN_DOC_ID,
  buildPdf,
  buildPageMapping,
  summarizeEdit,
  type EditAssets,
  type EditPage,
} from './pdfEdit';
import { remapMemoPages } from './memos';
import { pushVersion } from './pdfVersions';
import * as repo from './repository';
import type { PdfFileMeta } from './types';

const DRAFT_PREFIX = 'pdfedit:';

function draftKey(fileId: string): string {
  return `${DRAFT_PREFIX}${fileId}`;
}

/* ------------------------------------------------------------------ */
/* 二重実行の防止                                                      */
/* ------------------------------------------------------------------ */

/**
 * 保存処理中のファイル。
 *
 * 保存ボタンの連打や、保存中の画面回転による再実行で、
 * 同じ編集が 2 回書き込まれたりバージョン履歴が二重に積まれたりしないようにする。
 */
const saving = new Set<string>();

export function isSaving(fileId: string): boolean {
  return saving.has(fileId);
}

/* ------------------------------------------------------------------ */
/* 下書き                                                              */
/* ------------------------------------------------------------------ */

/** 追加素材を含めて下書きに残せる上限 (これを超えるとページ構成だけ残す)。 */
const MAX_DRAFT_ASSET_BYTES = 40 * 1024 * 1024;

export type EditDraft = {
  fileId: string;
  pages: EditPage[];
  /** 追加で読み込んだ PDF (元 PDF は保存しない。ファイル本体から読み直せるため)。 */
  docs: Record<string, Uint8Array>;
  images: Record<string, { data: Uint8Array; width: number; height: number }>;
  /** 素材が大きすぎて保存を見送った場合 true。復元時に案内を出す。 */
  assetsOmitted: boolean;
  savedAt: string;
};

export async function saveDraft(
  fileId: string,
  pages: EditPage[],
  assets: EditAssets,
): Promise<void> {
  const docs: Record<string, Uint8Array> = {};
  const images: Record<string, { data: Uint8Array; width: number; height: number }> = {};
  let bytes = 0;

  for (const [docId, data] of assets.docs) {
    if (docId === ORIGIN_DOC_ID) continue;
    bytes += data.byteLength;
    docs[docId] = data;
  }
  for (const [imageId, image] of assets.images) {
    bytes += image.data.byteLength;
    images[imageId] = image;
  }

  const omit = bytes > MAX_DRAFT_ASSET_BYTES;
  const draft: EditDraft = {
    fileId,
    pages,
    docs: omit ? {} : docs,
    images: omit ? {} : images,
    assetsOmitted: omit,
    savedAt: new Date().toISOString(),
  };

  // 下書きの保存に失敗しても編集は続けられる
  await writeKeyed(draftKey(fileId), draft).catch(() => undefined);
}

export async function readDraft(fileId: string): Promise<EditDraft | undefined> {
  const draft = await readKeyed<EditDraft>(draftKey(fileId)).catch(() => undefined);
  if (!draft || !Array.isArray(draft.pages) || draft.pages.length === 0) return undefined;
  return draft;
}

export async function clearDraft(fileId: string): Promise<void> {
  await deleteKeyed(draftKey(fileId)).catch(() => undefined);
}

/** 下書きから素材を組み立て直す。参照できない素材があれば false を返す。 */
export function restoreAssets(draft: EditDraft, originBytes: Uint8Array): {
  assets: EditAssets;
  complete: boolean;
} {
  const assets: EditAssets = {
    docs: new Map([[ORIGIN_DOC_ID, originBytes]]),
    images: new Map(),
  };
  for (const [docId, data] of Object.entries(draft.docs ?? {})) {
    assets.docs.set(docId, new Uint8Array(data));
  }
  for (const [imageId, image] of Object.entries(draft.images ?? {})) {
    assets.images.set(imageId, { ...image, data: new Uint8Array(image.data) });
  }

  const complete = draft.pages.every((page) => {
    if (page.source.kind === 'doc') return assets.docs.has(page.source.docId);
    if (page.source.kind === 'image') return assets.images.has(page.source.imageId);
    return true;
  });
  return { assets, complete };
}

/* ------------------------------------------------------------------ */
/* 保存                                                                */
/* ------------------------------------------------------------------ */

export type SaveMode = 'overwrite' | 'copy';

export type SavePhase = 'building' | 'verifying' | 'versioning' | 'writing' | 'relinking';

export const SAVE_PHASE_LABELS: Record<SavePhase, string> = {
  building: '編集内容を組み立てています…',
  verifying: '編集後のPDFを確認しています…',
  versioning: '編集前のPDFを保存しています…',
  writing: 'PDFを保存しています…',
  relinking: 'メモの紐付けを更新しています…',
};

export type SaveProgress = (phase: SavePhase, percent: number) => void;

export type SaveEditInput = {
  file: PdfFileMeta;
  /** 編集前の PDF 本体 (上書き保存時にバージョン履歴へ退避する)。 */
  originalBlob: Blob;
  /** 編集開始時のページ構成 (要約の作成に使う)。 */
  originalPages: EditPage[];
  pages: EditPage[];
  assets: EditAssets;
  mode: SaveMode;
  /** コピーとして保存するときのファイル名。 */
  copyName?: string;
  /** コピーの保存先フォルダー。 */
  copyParentId?: string;
  keepCount: number;
  keepDays: number;
  onProgress?: SaveProgress;
};

export type SaveEditResult = {
  mode: SaveMode;
  file: PdfFileMeta;
  pageCount: number;
  summary: string;
  /** 対象ページが変わったメモの件数。 */
  memosMoved: number;
  /** ページが無くなり「全体メモ」へ移したメモの件数。 */
  memosDetached: number;
};

/**
 * 編集内容を保存する。
 *
 * 失敗した場合は編集内容を下書きとして残したうえで例外を投げる。
 * 元の PDF・メモ・復習項目は、いかなる失敗経路でも変更しない。
 */
export async function saveEdit(input: SaveEditInput): Promise<SaveEditResult> {
  const { file, mode, pages } = input;

  if (saving.has(file.id)) throw new AppError('PDF_EDIT_IN_PROGRESS');
  saving.add(file.id);

  try {
    // 1. 組み立て (まだ何も保存しない)
    input.onProgress?.('building', 0);
    const blob = await buildPdf(pages, input.assets, (done, total) => {
      input.onProgress?.('building', Math.round((done / Math.max(1, total)) * 70));
    });

    // 2. 検証。開き直せない PDF をユーザーのデータと差し替えない。
    input.onProgress?.('verifying', 75);
    const verifiedPageCount = await getPageCount(blob);
    if (verifiedPageCount === undefined || verifiedPageCount !== pages.length) {
      throw new AppError('PDF_EDIT_VERIFY_FAILED');
    }

    const summary = summarizeEdit(input.originalPages, pages);

    if (mode === 'copy') {
      input.onProgress?.('writing', 85);
      const created = await repo.addPdf(blob, input.copyName || file.name, {
        parentId: input.copyParentId ?? file.parentId,
        onDuplicate: 'rename',
        pageCount: verifiedPageCount,
      });
      // コピー元の PDF・メモには一切触れない
      await clearDraft(file.id);
      input.onProgress?.('writing', 100);
      return {
        mode,
        file: created,
        pageCount: verifiedPageCount,
        summary,
        memosMoved: 0,
        memosDetached: 0,
      };
    }

    // 3. 編集前の本体をバージョン履歴へ退避する (差し替えの前に行う)
    input.onProgress?.('versioning', 80);
    await pushVersion({
      fileId: file.id,
      previousBlob: input.originalBlob,
      summary,
      pageCountBefore: input.originalPages.length,
      pageCountAfter: pages.length,
      sizeAfter: blob.size,
      keepCount: input.keepCount,
      keepDays: input.keepDays,
    });

    // 4. 差し替え (1 トランザクション)
    input.onProgress?.('writing', 88);
    const updated = await repo.replaceFileContent(file.id, blob, {
      pageCount: verifiedPageCount,
    });

    // 5. メモの対象ページを付け替える。メモ自体は決して削除しない。
    input.onProgress?.('relinking', 95);
    const mapping = buildPageMapping(pages);
    const { moved, detached } = await remapMemoPages(file.id, mapping);

    await clearDraft(file.id);
    input.onProgress?.('relinking', 100);

    return {
      mode,
      file: updated,
      pageCount: verifiedPageCount,
      summary,
      memosMoved: moved,
      memosDetached: detached,
    };
  } catch (error) {
    // 失敗しても編集内容は失わせない
    await saveDraft(file.id, input.pages, input.assets);
    if (error instanceof AppError) throw error;
    throw new AppError('PDF_EDIT_FAILED', error instanceof Error ? error.message : undefined);
  } finally {
    saving.delete(file.id);
  }
}

/**
 * バージョン履歴から編集前の PDF へ戻す。
 *
 * 戻す前の状態も履歴へ積むので、「戻したけれどやっぱり元に戻したい」にも対応できる。
 */
export async function restoreVersion(input: {
  file: PdfFileMeta;
  versionBlob: Blob;
  currentBlob: Blob;
  keepCount: number;
  keepDays: number;
}): Promise<PdfFileMeta> {
  const { file } = input;
  if (saving.has(file.id)) throw new AppError('PDF_EDIT_IN_PROGRESS');
  saving.add(file.id);

  try {
    const pageCount = await getPageCount(input.versionBlob);
    if (pageCount === undefined) throw new AppError('PDF_EDIT_VERIFY_FAILED');

    await pushVersion({
      fileId: file.id,
      previousBlob: input.currentBlob,
      summary: '以前のバージョンへ復元する前の状態',
      pageCountBefore: file.pageCount,
      pageCountAfter: pageCount,
      sizeAfter: input.versionBlob.size,
      keepCount: input.keepCount,
      keepDays: input.keepDays,
    });

    return await repo.replaceFileContent(file.id, input.versionBlob, { pageCount });
  } finally {
    saving.delete(file.id);
  }
}

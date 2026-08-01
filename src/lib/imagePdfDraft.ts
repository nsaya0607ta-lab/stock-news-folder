/**
 * 画像からPDFを作る途中の状態の保存。
 *
 * 作成中に画面を閉じられた・アプリが止められた場合でも、選んだ画像と並び順を
 * 失わないようにする。保存先はメモやルールと同じくキー付きレコード
 * (`image-pdf-draft`)。作成が完了した時点で必ず消す。
 *
 * 画像そのもの (Blob) を保存するため、保存は「画面を離れるとき」だけに限り、
 * 操作のたびに書き込まないようにしている。
 */
import { deleteKeyed, readKeyed, writeKeyed } from './db';
import { nowIso } from './naming';
import type { SourceImage } from './imageToPdf';
import type { ImagePdfOptions } from './types';

const DRAFT_KEY = 'image-pdf-draft';

type StoredImage = {
  id: string;
  blob: Blob;
  name: string;
  format: string;
  rotation: number;
  takenAt?: number;
  pickedOrder: number;
};

export type ImagePdfDraft = {
  savedAt: string;
  fileName: string;
  folderId: string;
  options: ImagePdfOptions;
  images: StoredImage[];
};

export async function saveImagePdfDraft(draft: {
  fileName: string;
  folderId: string;
  options: ImagePdfOptions;
  images: SourceImage[];
}): Promise<void> {
  if (draft.images.length === 0) {
    await clearImagePdfDraft();
    return;
  }
  const stored: ImagePdfDraft = {
    savedAt: nowIso(),
    fileName: draft.fileName,
    folderId: draft.folderId,
    options: draft.options,
    images: draft.images.map((image) => ({
      id: image.id,
      blob: image.blob,
      name: image.name,
      format: image.format,
      rotation: image.rotation,
      takenAt: image.takenAt,
      pickedOrder: image.pickedOrder,
    })),
  };
  // 保存できなくても作成そのものは続けられるので、失敗は握りつぶす
  await writeKeyed(DRAFT_KEY, stored).catch(() => undefined);
}

export async function readImagePdfDraft(): Promise<ImagePdfDraft | undefined> {
  try {
    const draft = await readKeyed<ImagePdfDraft>(DRAFT_KEY);
    if (!draft || !Array.isArray(draft.images) || draft.images.length === 0) return undefined;
    // 保存に失敗した項目が混ざっていても落ちないようにする
    const images = draft.images.filter((image) => image?.blob instanceof Blob);
    if (images.length === 0) return undefined;
    return { ...draft, images };
  } catch {
    return undefined;
  }
}

export async function clearImagePdfDraft(): Promise<void> {
  await deleteKeyed(DRAFT_KEY).catch(() => undefined);
}

/** 保存した下書きを、画面で扱う形へ戻す。 */
export function draftToImages(draft: ImagePdfDraft): SourceImage[] {
  return draft.images.map((image) => ({ ...image }));
}

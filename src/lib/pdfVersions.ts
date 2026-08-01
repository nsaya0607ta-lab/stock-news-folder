/**
 * PDF 編集のバージョン履歴。
 *
 * 上書き保存するとき、編集前の PDF 本体を捨てずに取っておき、あとから戻せるようにする。
 * メタデータは設定ストアのキー付きレコード (`pdfver:<fileId>`)、
 * 本体は既存の blobs ストアへ `pdfver-<versionId>` というキーで保存する
 * (新しいオブジェクトストアを作ると DB のバージョンが上がってしまうため)。
 */
import { deleteBlob, deleteKeyed, mutateKeyed, readBlob, readKeyed, writeBlob } from './db';
import { createId, nowIso } from './naming';
import { LOCAL_OWNER_ID } from './types';

const VERSION_PREFIX = 'pdfver:';
const VERSION_BLOB_PREFIX = 'pdfver-';

function versionKey(fileId: string): string {
  return `${VERSION_PREFIX}${fileId}`;
}

export function versionBlobKey(versionId: string): string {
  return `${VERSION_BLOB_PREFIX}${versionId}`;
}

export type PdfVersion = {
  id: string;
  fileId: string;
  userId: string;
  /** 「3ページを回転、8ページを削除」のような編集内容の要約。 */
  summary: string;
  /** 編集前のページ数。 */
  pageCountBefore?: number;
  /** 編集後のページ数。 */
  pageCountAfter?: number;
  /** ここに保存されている「編集前 PDF」の容量。 */
  size: number;
  /** 編集後の容量 (履歴一覧での比較用)。 */
  sizeAfter: number;
  createdAt: string;
};

export async function listVersions(fileId: string): Promise<PdfVersion[]> {
  const stored = await readKeyed<PdfVersion[]>(versionKey(fileId));
  if (!Array.isArray(stored)) return [];
  return [...stored].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * 編集前の PDF をバージョンとして保存する。
 *
 * 本体の書き込みに失敗した場合は履歴を残さない (中身の無い履歴を作らない)。
 * 保持数・保持期間を超えた古いバージョンはここで削除する。
 */
export async function pushVersion(input: {
  fileId: string;
  userId?: string;
  previousBlob: Blob;
  summary: string;
  pageCountBefore?: number;
  pageCountAfter?: number;
  sizeAfter: number;
  keepCount: number;
  keepDays: number;
}): Promise<PdfVersion | null> {
  if (input.keepCount <= 0) return null;

  const version: PdfVersion = {
    id: createId('ver'),
    fileId: input.fileId,
    userId: input.userId || LOCAL_OWNER_ID,
    summary: input.summary,
    pageCountBefore: input.pageCountBefore,
    pageCountAfter: input.pageCountAfter,
    size: input.previousBlob.size,
    sizeAfter: input.sizeAfter,
    createdAt: nowIso(),
  };

  try {
    await writeBlob(versionBlobKey(version.id), input.previousBlob);
  } catch {
    // 履歴を残せなくても、編集そのものは続行させる (履歴は付加機能)
    return null;
  }

  const dropped: string[] = [];
  await mutateKeyed<PdfVersion[]>(versionKey(input.fileId), (current) => {
    const all = Array.isArray(current) ? current : [];
    const kept = [...all, version]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .filter((entry) => {
        if (input.keepDays > 0) {
          const age = Date.now() - new Date(entry.createdAt).getTime();
          // 今回追加したぶんは期限で消さない
          if (entry.id !== version.id && age > input.keepDays * 86_400_000) return false;
        }
        return true;
      })
      .slice(0, input.keepCount);

    const keptIds = new Set(kept.map((entry) => entry.id));
    for (const entry of all) {
      if (!keptIds.has(entry.id)) dropped.push(entry.id);
    }
    return kept;
  });

  for (const id of dropped) {
    await deleteBlob(versionBlobKey(id)).catch(() => undefined);
  }
  return version;
}

/** バージョンの PDF 本体を読む (復元前の確認と復元本体の取得に使う)。 */
export async function readVersionBlob(versionId: string): Promise<Blob | undefined> {
  return readBlob(versionBlobKey(versionId));
}

export async function deleteVersion(fileId: string, versionId: string): Promise<void> {
  await mutateKeyed<PdfVersion[]>(versionKey(fileId), (current) => {
    const all = Array.isArray(current) ? current : [];
    const next = all.filter((entry) => entry.id !== versionId);
    return next.length > 0 ? next : undefined;
  });
  await deleteBlob(versionBlobKey(versionId)).catch(() => undefined);
}

/** PDF を完全削除するときに、その履歴と本体もまとめて片付ける。 */
export async function deleteVersionsOfFile(fileId: string): Promise<void> {
  const versions = await listVersions(fileId);
  await deleteKeyed(versionKey(fileId));
  for (const version of versions) {
    await deleteBlob(versionBlobKey(version.id)).catch(() => undefined);
  }
}

/** 保持期間を過ぎたバージョンを片付ける (起動時に呼ぶ)。 */
export async function pruneVersions(
  fileIds: string[],
  keepCount: number,
  keepDays: number,
): Promise<number> {
  let removed = 0;
  for (const fileId of fileIds) {
    const versions = await listVersions(fileId);
    if (versions.length === 0) continue;

    const kept = versions
      .filter((entry) => {
        if (keepDays <= 0) return true;
        return Date.now() - new Date(entry.createdAt).getTime() <= keepDays * 86_400_000;
      })
      .slice(0, Math.max(0, keepCount));

    if (kept.length === versions.length) continue;
    const keptIds = new Set(kept.map((entry) => entry.id));

    await mutateKeyed<PdfVersion[]>(versionKey(fileId), () =>
      kept.length > 0 ? kept : undefined,
    );
    for (const entry of versions) {
      if (keptIds.has(entry.id)) continue;
      await deleteBlob(versionBlobKey(entry.id)).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}

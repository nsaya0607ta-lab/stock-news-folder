/**
 * バックアップ / 復元。
 *
 * 形式は ZIP。中身は以下のとおり。
 *   backup.json      … フォルダー構成・PDF メタデータ・タグ・メモ・お気に入り
 *   files/<id>.pdf   … PDF 本体
 * ZIP なので PC でも中身を確認でき、別端末への引っ越しにも使える。
 */
import { unzip, zip } from 'fflate';
import { STORE, idb, loadAll, readBlob, tx } from './db';
import { AppError } from './errors';
import { nowIso } from './naming';
import { toParentKey } from './tree';
import { ROOT_ID, type Folder, type PdfFileMeta, type Settings } from './types';

export const BACKUP_FORMAT = 'pdf-folder-manager-backup';
export const BACKUP_VERSION = 1;

type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  settings?: Partial<Settings>;
  folders: Folder[];
  files: (PdfFileMeta & { blobPath?: string })[];
};

function zipAsync(input: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(input, { level: 6 }, (error, data) => {
      if (error) reject(new AppError('BACKUP_FAILED', error.message));
      else resolve(data);
    });
  });
}

function unzipAsync(input: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(input, (error, data) => {
      if (error) reject(new AppError('RESTORE_FAILED', error.message));
      else resolve(data);
    });
  });
}

export type BackupProgress = (done: number, total: number) => void;

/** 現在のデータをバックアップ ZIP にまとめる。 */
export async function createBackup(
  settings: Settings,
  onProgress?: BackupProgress,
): Promise<{ blob: Blob; fileName: string }> {
  const { folders, files } = await loadAll();
  const entries: Record<string, Uint8Array> = {};

  const total = files.length;
  let done = 0;
  const stored = new Set<string>();
  for (const file of files) {
    const blob = await readBlob(file.id);
    if (blob) {
      entries[`files/${file.id}.pdf`] = new Uint8Array(await blob.arrayBuffer());
      stored.add(file.id);
    }
    done += 1;
    onProgress?.(done, total);
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: nowIso(),
    settings,
    folders,
    // クラウド保管中で端末内に本体が無い PDF は、ZIP に本体を含められない。
    // フォルダー・タグ・メモ・クラウド上の保存先は残すので、復元後もクラウドから開ける。
    files: files.map((file) => ({
      ...file,
      blobPath: stored.has(file.id) ? `files/${file.id}.pdf` : undefined,
    })),
  };
  entries['backup.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

  const data = await zipAsync(entries);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return {
    blob: new Blob([buffer], { type: 'application/zip' }),
    fileName: `pdf-folder-backup-${stamp}.zip`,
  };
}

export type RestoreMode = 'replace' | 'merge';

export type RestoreResult = { folders: number; files: number };

/** バックアップ ZIP を読み込んで復元する。 */
export async function restoreBackup(
  file: Blob,
  mode: RestoreMode,
): Promise<RestoreResult> {
  let manifest: BackupManifest;
  let entries: Record<string, Uint8Array>;
  try {
    entries = await unzipAsync(new Uint8Array(await file.arrayBuffer()));
    const raw = entries['backup.json'];
    if (!raw) throw new AppError('RESTORE_FAILED');
    manifest = JSON.parse(new TextDecoder().decode(raw)) as BackupManifest;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('RESTORE_FAILED');
  }

  if (manifest.format !== BACKUP_FORMAT || !Array.isArray(manifest.folders)) {
    throw new AppError('RESTORE_FAILED');
  }

  const existing = mode === 'merge' ? await loadAll() : { folders: [], files: [] };
  const existingFolderIds = new Set(existing.folders.map((folder) => folder.id));
  const existingFileIds = new Set(existing.files.map((f) => f.id));

  await tx(
    [STORE.folders, STORE.files, STORE.blobs, STORE.thumbs],
    'readwrite',
    async (t) => {
      const folderStore = t.objectStore(STORE.folders);
      const fileStore = t.objectStore(STORE.files);
      const blobStore = t.objectStore(STORE.blobs);
      const thumbStore = t.objectStore(STORE.thumbs);

      if (mode === 'replace') {
        await idb.clear(folderStore);
        await idb.clear(fileStore);
        await idb.clear(blobStore);
        await idb.clear(thumbStore);
      }

      for (const folder of manifest.folders) {
        if (mode === 'merge' && existingFolderIds.has(folder.id)) continue;
        await idb.put(folderStore, {
          ...folder,
          parentId: toParentKey(folder.parentId),
        });
      }

      for (const meta of manifest.files) {
        if (mode === 'merge' && existingFileIds.has(meta.id)) continue;
        const { blobPath, ...rest } = meta;
        const bytes = entries[blobPath ?? `files/${meta.id}.pdf`];
        // 本体が入っていない = クラウド保管中の PDF。メタデータだけを復元する。
        // それ以外 (本体も保存先も無い) は復元しても開けないため取り込まない。
        const cloudOnly = !bytes && rest.storageState === 'cloud' && Boolean(rest.cloudPath);
        if (!bytes && !cloudOnly) continue;

        await idb.put(fileStore, {
          ...rest,
          parentId: toParentKey(rest.parentId) === ROOT_ID ? ROOT_ID : rest.parentId,
          tags: Array.isArray(rest.tags) ? rest.tags : [],
          mimeType: 'application/pdf',
          thumbState: 'none',
          // 端末内キャッシュは持ち越さない (本体は ZIP に入っていないため)
          ...(cloudOnly ? { localCachedAt: undefined } : {}),
        });

        if (!bytes) continue;
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        await idb.put(blobStore, {
          id: meta.id,
          blob: new Blob([buffer], { type: 'application/pdf' }),
        });
      }
    },
  );

  return { folders: manifest.folders.length, files: manifest.files.length };
}

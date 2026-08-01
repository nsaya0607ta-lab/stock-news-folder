/**
 * アプリのデータ操作をすべてここに集約する。
 *
 * UI からは常にこのモジュール経由でデータを触る。
 * クラウド同期を追加するときは、この層で「ローカルへ書く → 同期キューへ積む」
 * という流れに差し替えれば UI を変更せずに済む。
 */
import {
  STORE,
  deleteBlob,
  hasBlob,
  idb,
  loadAll,
  readBlob,
  readSettings,
  tx,
  wipeAll,
  writeBlob,
  writeSettings,
} from './db';
import { enqueueCloudDeletes, uidFromCloudPath } from './cloudQueue';
import { deleteMemosOfFile } from './memos';
import { deleteVersionsOfFile } from './pdfVersions';
import { AppError } from './errors';
import { createId, ensurePdfExtension, nextAvailableName, nowIso, sanitizeName } from './naming';
import {
  DEFAULT_SETTINGS,
  ROOT_ID,
  UNSORTED_ID,
  type Folder,
  type FolderColor,
  type Importance,
  type PdfFileMeta,
  type PdfOrigin,
  type Settings,
  type StorageState,
} from './types';
import { descendantFolderIds, toParentKey } from './tree';

export type Snapshot = {
  folders: Folder[];
  files: PdfFileMeta[];
  settings: Settings;
};

// 銘柄フォルダーは購読を追加したときに作るため、初回は受け皿だけを用意する。
const INITIAL_FOLDERS: { id?: string; name: string; color: FolderColor }[] = [
  { id: UNSORTED_ID, name: '未分類', color: 'gray' },
];

/* ------------------------------------------------------------------ */
/* 初期化                                                              */
/* ------------------------------------------------------------------ */

/** 初回起動時に既定フォルダーを作成し、現在のスナップショットを返す。 */
export async function bootstrap(): Promise<Snapshot> {
  const stored = await readSettings();
  const settings: Settings = { ...DEFAULT_SETTINGS, ...stored };

  let { folders, files } = await loadAll();

  if (folders.length === 0) {
    const timestamp = nowIso();
    const seeded: Folder[] = INITIAL_FOLDERS.map((entry, index) => ({
      id: entry.id ?? createId('folder'),
      parentId: ROOT_ID,
      name: entry.name,
      color: entry.color,
      isFavorite: false,
      sortOrder: index,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    await tx(STORE.folders, 'readwrite', async (t) => {
      const store = t.objectStore(STORE.folders);
      for (const folder of seeded) await idb.put(store, folder);
    });
    folders = seeded;
  } else if (!folders.some((folder) => folder.id === UNSORTED_ID)) {
    // 「未分類」は取り込み先として必ず必要なので、無ければ作り直す
    const timestamp = nowIso();
    const unsorted: Folder = {
      id: UNSORTED_ID,
      parentId: ROOT_ID,
      name: '未分類',
      color: 'gray',
      isFavorite: false,
      sortOrder: folders.length,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await putFolder(unsorted);
    folders = [...folders, unsorted];
  }

  return { folders, files, settings };
}

export async function refresh(): Promise<{ folders: Folder[]; files: PdfFileMeta[] }> {
  return loadAll();
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeSettings(settings);
}

/* ------------------------------------------------------------------ */
/* フォルダー操作                                                      */
/* ------------------------------------------------------------------ */

/**
 * コピーで作った PDF はクラウドの保存先を引き継がない。
 *
 * 同じ `cloudPath` を 2 件が共有すると、片方を完全削除したときに
 * もう片方の実体まで消えてしまう。コピーは必ず「端末内だけにある PDF」として作り、
 * 条件を満たせば後から独立した保存先へアップロードされる。
 */
const LOCAL_COPY_FIELDS = {
  storageState: 'local' as StorageState,
  cloudPath: undefined,
  cloudUploadedAt: undefined,
  cloudSize: undefined,
  cloudError: undefined,
  localCachedAt: undefined,
} satisfies CloudPatch;

async function putFolder(folder: Folder): Promise<void> {
  await tx(STORE.folders, 'readwrite', async (t) => {
    await idb.put(t.objectStore(STORE.folders), folder);
  });
}

export async function createFolder(
  parentId: string,
  rawName: string,
  color: FolderColor = 'yellow',
): Promise<Folder> {
  const name = sanitizeName(rawName);
  if (!name) throw new AppError('EMPTY_FOLDER_NAME');

  const { folders } = await loadAll();
  const siblings = folders
    .filter((folder) => !folder.deletedAt && toParentKey(folder.parentId) === parentId)
    .map((folder) => folder.name);

  const timestamp = nowIso();
  const folder: Folder = {
    id: createId('folder'),
    parentId,
    name: nextAvailableName(name, siblings),
    color,
    isFavorite: false,
    sortOrder: siblings.length,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await putFolder(folder);
  return folder;
}

export async function renameFolder(folderId: string, rawName: string): Promise<Folder> {
  const name = sanitizeName(rawName);
  if (!name) throw new AppError('EMPTY_FOLDER_NAME');

  const { folders } = await loadAll();
  const target = folders.find((folder) => folder.id === folderId);
  if (!target) throw new AppError('NOT_FOUND');

  const siblings = folders
    .filter(
      (folder) =>
        !folder.deletedAt &&
        folder.id !== folderId &&
        toParentKey(folder.parentId) === toParentKey(target.parentId),
    )
    .map((folder) => folder.name);

  const updated: Folder = {
    ...target,
    name: nextAvailableName(name, siblings),
    updatedAt: nowIso(),
  };
  await putFolder(updated);
  return updated;
}

export async function updateFolder(
  folderId: string,
  patch: Partial<Pick<Folder, 'color' | 'isFavorite' | 'sortOrder'>>,
): Promise<Folder> {
  const { folders } = await loadAll();
  const target = folders.find((folder) => folder.id === folderId);
  if (!target) throw new AppError('NOT_FOUND');
  const updated: Folder = { ...target, ...patch, updatedAt: nowIso() };
  await putFolder(updated);
  return updated;
}

/** 移動先として妥当か (自分自身・自分の配下は不可)。 */
export function canMoveFolder(folders: Folder[], folderId: string, destId: string): boolean {
  if (folderId === destId) return false;
  return !descendantFolderIds(folders, folderId).has(destId);
}

export async function moveFolder(folderId: string, destId: string): Promise<void> {
  const { folders } = await loadAll();
  const target = folders.find((folder) => folder.id === folderId);
  if (!target) throw new AppError('NOT_FOUND');
  if (!canMoveFolder(folders, folderId, destId)) throw new AppError('INVALID_MOVE');

  const siblings = folders
    .filter(
      (folder) =>
        !folder.deletedAt && folder.id !== folderId && toParentKey(folder.parentId) === destId,
    )
    .map((folder) => folder.name);

  await putFolder({
    ...target,
    parentId: destId,
    name: nextAvailableName(target.name, siblings),
    updatedAt: nowIso(),
  });
}

/** フォルダーを配下ごと複製する。 */
export async function copyFolder(
  folderId: string,
  destId: string,
): Promise<{ copied: number; skipped: number }> {
  const { folders, files } = await loadAll();
  const source = folders.find((folder) => folder.id === folderId);
  if (!source) throw new AppError('NOT_FOUND');
  if (!canMoveFolder(folders, folderId, destId)) throw new AppError('INVALID_MOVE');

  const timestamp = nowIso();
  const idMap = new Map<string, string>();
  const newFolders: Folder[] = [];
  const newFiles: { meta: PdfFileMeta; sourceId: string }[] = [];

  const siblingNames = folders
    .filter((folder) => !folder.deletedAt && toParentKey(folder.parentId) === destId)
    .map((folder) => folder.name);

  const walk = (currentId: string, newParentId: string, nameOverride?: string) => {
    const current = folders.find((folder) => folder.id === currentId);
    if (!current) return;
    const cloneId = createId('folder');
    idMap.set(currentId, cloneId);
    newFolders.push({
      ...current,
      id: cloneId,
      parentId: newParentId,
      name: nameOverride ?? current.name,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: undefined,
    });
    for (const child of folders) {
      if (!child.deletedAt && toParentKey(child.parentId) === currentId) {
        walk(child.id, cloneId);
      }
    }
    for (const file of files) {
      if (!file.deletedAt && toParentKey(file.parentId) === currentId) {
        newFiles.push({
          meta: {
            ...file,
            ...LOCAL_COPY_FIELDS,
            id: createId('file'),
            parentId: cloneId,
            createdAt: timestamp,
            updatedAt: timestamp,
            deletedAt: undefined,
          },
          sourceId: file.id,
        });
      }
    }
  };

  walk(folderId, destId, nextAvailableName(source.name, siblingNames));

  // Blob は元データを読み出して複製する
  const blobs = new Map<string, Blob>();
  for (const entry of newFiles) {
    if (!blobs.has(entry.sourceId)) {
      const blob = await readBlob(entry.sourceId);
      if (blob) blobs.set(entry.sourceId, blob);
    }
  }

  // 本体が端末内に無い PDF (クラウドのみ) は中身のないコピーを作らずに見送る。
  // 呼び出し側であらかじめ端末へ取り戻しておけば、この分岐には入らない。
  const copyable = newFiles.filter((entry) => blobs.has(entry.sourceId));
  const skipped = newFiles.length - copyable.length;

  await tx([STORE.folders, STORE.files, STORE.blobs], 'readwrite', async (t) => {
    const folderStore = t.objectStore(STORE.folders);
    const fileStore = t.objectStore(STORE.files);
    const blobStore = t.objectStore(STORE.blobs);
    for (const folder of newFolders) await idb.put(folderStore, folder);
    for (const entry of copyable) {
      await idb.put(fileStore, entry.meta);
      await idb.put(blobStore, { id: entry.meta.id, blob: blobs.get(entry.sourceId) as Blob });
    }
  });

  return { copied: copyable.length, skipped };
}

/** フォルダーを配下ごとごみ箱へ移す。 */
export async function trashFolder(folderId: string): Promise<void> {
  const { folders, files } = await loadAll();
  const target = folders.find((folder) => folder.id === folderId);
  if (!target) throw new AppError('NOT_FOUND');

  const ids = descendantFolderIds(
    folders.filter((folder) => !folder.deletedAt),
    folderId,
  );
  const timestamp = nowIso();

  await tx([STORE.folders, STORE.files], 'readwrite', async (t) => {
    const folderStore = t.objectStore(STORE.folders);
    const fileStore = t.objectStore(STORE.files);
    for (const folder of folders) {
      if (!ids.has(folder.id) || folder.deletedAt) continue;
      await idb.put(folderStore, {
        ...folder,
        deletedAt: timestamp,
        // 復元時に元の場所へ戻せるよう記録する (配下は親を保持したまま)
        restoreParentId: folder.id === folderId ? toParentKey(folder.parentId) : undefined,
        updatedAt: timestamp,
      });
    }
    for (const file of files) {
      if (file.deletedAt || !ids.has(toParentKey(file.parentId))) continue;
      // クラウド保管の処理と並行しても状態を巻き戻さないよう、最新を読み直して更新する
      const current = await idb.get<PdfFileMeta>(fileStore, file.id);
      if (!current || current.deletedAt) continue;
      await idb.put(fileStore, { ...current, deletedAt: timestamp, updatedAt: timestamp });
    }
  });
}

/** ごみ箱のフォルダーを復元する。 */
export async function restoreFolder(folderId: string): Promise<void> {
  const { folders, files } = await loadAll();
  const target = folders.find((folder) => folder.id === folderId);
  if (!target) throw new AppError('NOT_FOUND');

  const deletedAt = target.deletedAt;
  const ids = descendantFolderIds(
    folders.filter((folder) => folder.deletedAt === deletedAt || !folder.deletedAt),
    folderId,
  );

  // 復元先の親がすでに存在しない場合はルートへ戻す
  const parentExists = folders.some(
    (folder) => folder.id === target.restoreParentId && !folder.deletedAt,
  );
  const restoreParent =
    target.restoreParentId && (parentExists || target.restoreParentId === ROOT_ID)
      ? target.restoreParentId
      : ROOT_ID;

  await tx([STORE.folders, STORE.files], 'readwrite', async (t) => {
    const folderStore = t.objectStore(STORE.folders);
    const fileStore = t.objectStore(STORE.files);
    for (const folder of folders) {
      if (!ids.has(folder.id) || folder.deletedAt !== deletedAt) continue;
      await idb.put(folderStore, {
        ...folder,
        parentId: folder.id === folderId ? restoreParent : folder.parentId,
        deletedAt: undefined,
        restoreParentId: undefined,
        updatedAt: nowIso(),
      });
    }
    for (const file of files) {
      if (file.deletedAt !== deletedAt || !ids.has(toParentKey(file.parentId))) continue;
      const current = await idb.get<PdfFileMeta>(fileStore, file.id);
      if (!current) continue;
      await idb.put(fileStore, { ...current, deletedAt: undefined, updatedAt: nowIso() });
    }
  });
}

/** フォルダーを完全削除する (配下の PDF も消える)。 */
export async function purgeFolder(folderId: string): Promise<void> {
  const { folders, files } = await loadAll();
  const ids = descendantFolderIds(folders, folderId);
  const targets = files.filter((file) => ids.has(toParentKey(file.parentId)));
  const fileIds = targets.map((file) => file.id);

  // クラウド側は「端末から消えたあと」に削除する。
  // 予約だけ先に積み、実際の削除はオンライン時にまとめて行う。
  await scheduleCloudDeletes(targets);

  await tx([STORE.folders, STORE.files, STORE.blobs, STORE.thumbs], 'readwrite', async (t) => {
    const folderStore = t.objectStore(STORE.folders);
    const fileStore = t.objectStore(STORE.files);
    const blobStore = t.objectStore(STORE.blobs);
    const thumbStore = t.objectStore(STORE.thumbs);
    for (const id of ids) await idb.delete(folderStore, id);
    for (const id of fileIds) {
      await idb.delete(fileStore, id);
      await idb.delete(blobStore, id);
      await idb.delete(thumbStore, id);
    }
  });

  await purgeAttachments(fileIds);
}

/* ------------------------------------------------------------------ */
/* PDF 操作                                                            */
/* ------------------------------------------------------------------ */

export type ImportResult = {
  added: PdfFileMeta[];
  skipped: { name: string; reason: string }[];
};

export function isPdf(file: File | Blob, name?: string): boolean {
  const fileName = name ?? (file instanceof File ? file.name : '');
  if (file.type === 'application/pdf') return true;
  // 一部の端末では type が空で渡ってくるため拡張子でも判定する
  return /\.pdf$/i.test(fileName) && (file.type === '' || file.type === 'application/octet-stream');
}

/** 同名判定に使う、指定フォルダー内の PDF 名一覧。 */
export function siblingFileNames(files: PdfFileMeta[], parentId: string, excludeId?: string) {
  return files
    .filter((file) => !file.deletedAt && toParentKey(file.parentId) === parentId && file.id !== excludeId)
    .map((file) => file.name);
}

export type AddPdfOptions = {
  parentId: string;
  /** 同名衝突時の扱い。既定は自動採番。 */
  onDuplicate?: 'rename' | 'overwrite' | 'skip';
  pageCount?: number;
  /** どの経路で追加されたか (自動分類の「登録元」条件で使う)。 */
  origin?: PdfOrigin;
  /** 共有元アプリ名など (分かる場合だけ)。 */
  sharedFrom?: string;
  /** 元になったファイルの形式 (画像から作った PDF では使った画像形式)。 */
  sourceFormats?: string[];
};

export async function addPdf(
  blob: Blob,
  rawName: string,
  options: AddPdfOptions,
): Promise<PdfFileMeta> {
  const { files } = await loadAll();
  const name = ensurePdfExtension(sanitizeName(rawName) || 'untitled');
  const existingNames = siblingFileNames(files, options.parentId);
  const conflict = files.find(
    (file) =>
      !file.deletedAt &&
      toParentKey(file.parentId) === options.parentId &&
      file.name.toLowerCase() === name.toLowerCase(),
  );

  if (conflict && options.onDuplicate === 'skip') {
    throw new AppError('DUPLICATE_NAME', name);
  }

  const timestamp = nowIso();

  if (conflict && options.onDuplicate === 'overwrite') {
    const updated: PdfFileMeta = {
      ...conflict,
      size: blob.size,
      pageCount: options.pageCount ?? conflict.pageCount,
      updatedAt: timestamp,
      thumbState: 'none',
    };
    await tx([STORE.files, STORE.blobs, STORE.thumbs], 'readwrite', async (t) => {
      await idb.put(t.objectStore(STORE.files), updated);
      await idb.put(t.objectStore(STORE.blobs), { id: updated.id, blob });
      await idb.delete(t.objectStore(STORE.thumbs), updated.id);
    });
    return updated;
  }

  const meta: PdfFileMeta = {
    id: createId('file'),
    parentId: options.parentId,
    name: conflict ? nextAvailableName(name, existingNames) : name,
    size: blob.size,
    pageCount: options.pageCount,
    mimeType: 'application/pdf',
    tags: [],
    isFavorite: false,
    isRead: false,
    importance: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    thumbState: 'none',
    origin: options.origin ?? 'unknown',
    sharedFrom: options.sharedFrom,
    sourceFormats: options.sourceFormats,
  };

  await tx([STORE.files, STORE.blobs], 'readwrite', async (t) => {
    await idb.put(t.objectStore(STORE.files), meta);
    await idb.put(t.objectStore(STORE.blobs), { id: meta.id, blob });
  });
  return meta;
}

export async function renameFile(fileId: string, rawName: string): Promise<PdfFileMeta> {
  const { files } = await loadAll();
  const target = files.find((file) => file.id === fileId);
  if (!target) throw new AppError('NOT_FOUND');

  const name = ensurePdfExtension(sanitizeName(rawName));
  if (!sanitizeName(rawName)) throw new AppError('EMPTY_FILE_NAME');

  const siblings = siblingFileNames(files, toParentKey(target.parentId), fileId);
  const updated = await mergeFile(fileId, { name: nextAvailableName(name, siblings) });
  if (!updated) throw new AppError('NOT_FOUND');
  return updated;
}

/**
 * 1 つのトランザクション内で読み → 併合 → 書き戻しを行う。
 *
 * クラウド保管の処理はユーザー操作と並行して動くため、
 * 「読み出したときの古い全体像」で上書きするとタグや名前の変更が巻き戻ってしまう。
 * 必ず最新のレコードへ差分だけを当てる。
 */
async function mergeFile(
  fileId: string,
  patch: Partial<PdfFileMeta>,
  options: { touch?: boolean } = {},
): Promise<PdfFileMeta | undefined> {
  return tx(STORE.files, 'readwrite', async (t) => {
    const store = t.objectStore(STORE.files);
    const current = await idb.get<PdfFileMeta>(store, fileId);
    if (!current) return undefined;
    const updated: PdfFileMeta = {
      ...current,
      ...patch,
      updatedAt: options.touch === false ? current.updatedAt : nowIso(),
    };
    await idb.put(store, updated);
    return updated;
  });
}

export async function updateFile(
  fileId: string,
  patch: Partial<
    Pick<
      PdfFileMeta,
      'tags' | 'memo' | 'isFavorite' | 'isRead' | 'importance' | 'pageCount' | 'sortOrder' | 'thumbState'
    >
  >,
  options: { touch?: boolean } = {},
): Promise<PdfFileMeta> {
  const updated = await mergeFile(fileId, patch, options);
  if (!updated) throw new AppError('NOT_FOUND');
  return updated;
}

/**
 * PDF 本体を編集後の内容へ差し替える (「上書き保存」)。
 *
 * メタデータ・本体・サムネイルの入れ替えを 1 つのトランザクションで行うため、
 * 途中で失敗しても「新しい本体と古いページ数」のような食い違いは起きない。
 * 呼び出し側は、完成した Blob を用意し、編集前のバージョンを保存してから呼ぶこと。
 *
 * メモは fileId で紐付いているので、この差し替えでは一切影響を受けない。
 */
export async function replaceFileContent(
  fileId: string,
  blob: Blob,
  options: { pageCount?: number } = {},
): Promise<PdfFileMeta> {
  const before = await readFileMeta(fileId);
  if (!before) throw new AppError('NOT_FOUND');

  // 中身が変わった以上、クラウド上の古い PDF は同じファイルの実体ではない。
  // 紐付けを外しておかないと、次回の「端末内 Blob の削除」で編集後の本体が消え、
  // クラウドに残った編集前の PDF だけになってしまう。
  const staleCloudPath = before.cloudPath;

  const updated = await tx([STORE.files, STORE.blobs, STORE.thumbs], 'readwrite', async (t) => {
    const store = t.objectStore(STORE.files);
    const latest = await idb.get<PdfFileMeta>(store, fileId);
    if (!latest) throw new AppError('NOT_FOUND');
    const next: PdfFileMeta = {
      ...latest,
      ...LOCAL_COPY_FIELDS,
      size: blob.size,
      pageCount: options.pageCount ?? latest.pageCount,
      updatedAt: nowIso(),
      thumbState: 'none',
    };
    await idb.put(store, next);
    await idb.put(t.objectStore(STORE.blobs), { id: fileId, blob });
    await idb.delete(t.objectStore(STORE.thumbs), fileId);
    return next;
  });

  if (staleCloudPath) {
    await scheduleCloudDeletes([{ ...before, cloudPath: staleCloudPath }]);
  }
  return updated;
}

export async function markOpened(fileId: string): Promise<PdfFileMeta | undefined> {
  // 閲覧しただけで更新日時は動かさない (並べ替えの見え方を変えないため)
  return mergeFile(fileId, { isRead: true, lastOpenedAt: nowIso() }, { touch: false });
}

/* ------------------------------------------------------------------ */
/* クラウド保管                                                        */
/* ------------------------------------------------------------------ */

/** クラウド保管の状態としてだけ書き換えてよいフィールド。 */
export type CloudPatch = Partial<
  Pick<
    PdfFileMeta,
    'storageState' | 'cloudPath' | 'cloudUploadedAt' | 'cloudSize' | 'cloudError' | 'localCachedAt'
  >
>;

/**
 * クラウド保管に関する項目だけを更新する。
 * 名前・フォルダー・タグ・メモ・お気に入り・重要度・更新日時には触れない。
 */
export async function patchCloudState(
  fileId: string,
  patch: CloudPatch,
): Promise<PdfFileMeta | undefined> {
  return mergeFile(fileId, patch, { touch: false });
}

/** 単票を最新の状態で読み直す (処理直前の再確認用)。 */
export async function readFileMeta(fileId: string): Promise<PdfFileMeta | undefined> {
  return tx(STORE.files, 'readonly', async (t) =>
    idb.get<PdfFileMeta>(t.objectStore(STORE.files), fileId),
  );
}

/**
 * 端末内の PDF 本体だけを削除する。
 *
 * 呼び出し側で「クラウドへの保存と存在確認が完了し、その事実が IndexedDB へ
 * 書き込まれた」ことを確認してから使う。ここでは最後の安全確認として、
 * 保存済みメタデータが本当に `cloud` になっているかをもう一度読み直す。
 * サムネイル・メタデータ・タグ・メモは残すため、一覧の見た目は変わらない。
 */
export async function dropLocalBlob(fileId: string): Promise<boolean> {
  const meta = await readFileMeta(fileId);
  if (!meta) return false;
  if (meta.storageState !== 'cloud' || !meta.cloudPath || !meta.cloudUploadedAt) return false;
  await deleteBlob(fileId);
  return true;
}

/** クラウドから取得した PDF 本体を端末へキャッシュする。 */
export async function cacheLocalBlob(fileId: string, blob: Blob): Promise<void> {
  await writeBlob(fileId, blob);
}

export { hasBlob };

/** 完全削除するファイル群について、クラウド側の削除予約を積む。 */
/**
 * 完全削除した PDF に付いていたメモと編集履歴を片付ける。
 *
 * 呼ぶのは「PDF そのものを完全に削除するとき」だけ。
 * ごみ箱への移動・移動・名前変更・ページ編集では絶対に呼ばない
 * (メモや復習項目を勝手に消さないため)。
 */
async function purgeAttachments(fileIds: string[]): Promise<void> {
  for (const fileId of fileIds) {
    // 片付けに失敗しても本体の削除は続行する (残っても実害は無い)
    await deleteMemosOfFile(fileId).catch(() => undefined);
    await deleteVersionsOfFile(fileId).catch(() => undefined);
  }
}

async function scheduleCloudDeletes(targets: PdfFileMeta[]): Promise<void> {
  const entries = targets
    .filter((file) => Boolean(file.cloudPath))
    .map((file) => ({
      path: file.cloudPath as string,
      uid: uidFromCloudPath(file.cloudPath),
      name: file.name,
    }))
    .filter((entry) => entry.uid !== '');
  if (entries.length === 0) return;
  // 予約に失敗しても端末側の削除は続行する (クラウドのファイルが残るだけで、消失はしない)
  try {
    await enqueueCloudDeletes(entries);
  } catch {
    /* 次回の完全削除時に再度積まれる */
  }
}

/**
 * PDF を別フォルダーへ移す。
 *
 * @param options.ruleId    自動分類で移動したときのルール ID (どのルールで動いたかを残す)
 * @param options.clearRule 分類による移動を取り消すときに、その記録を消す
 */
export async function moveFile(
  fileId: string,
  destId: string,
  options: { ruleId?: string; clearRule?: boolean } = {},
): Promise<PdfFileMeta> {
  const { files } = await loadAll();
  const target = files.find((file) => file.id === fileId);
  if (!target) throw new AppError('NOT_FOUND');
  const siblings = siblingFileNames(files, destId, fileId);
  const updated = await mergeFile(fileId, {
    parentId: destId,
    name: nextAvailableName(target.name, siblings),
    ...(options.ruleId
      ? { classifiedByRuleId: options.ruleId, classifiedAt: nowIso() }
      : options.clearRule
        ? { classifiedByRuleId: undefined, classifiedAt: undefined }
        : {}),
  });
  if (!updated) throw new AppError('NOT_FOUND');
  return updated;
}

export async function copyFile(fileId: string, destId: string): Promise<PdfFileMeta> {
  const { files } = await loadAll();
  const target = files.find((file) => file.id === fileId);
  if (!target) throw new AppError('NOT_FOUND');
  const blob = await readBlob(fileId);
  if (!blob) throw new AppError('NOT_FOUND');

  const siblings = siblingFileNames(files, destId);
  const timestamp = nowIso();
  const copy: PdfFileMeta = {
    ...target,
    ...LOCAL_COPY_FIELDS,
    id: createId('file'),
    parentId: destId,
    name: nextAvailableName(target.name, siblings),
    createdAt: timestamp,
    updatedAt: timestamp,
    lastOpenedAt: undefined,
    deletedAt: undefined,
    thumbState: 'none',
  };
  await tx([STORE.files, STORE.blobs], 'readwrite', async (t) => {
    await idb.put(t.objectStore(STORE.files), copy);
    await idb.put(t.objectStore(STORE.blobs), { id: copy.id, blob });
  });
  return copy;
}

export async function trashFile(fileId: string): Promise<void> {
  const { files } = await loadAll();
  const target = files.find((file) => file.id === fileId);
  if (!target) throw new AppError('NOT_FOUND');
  await mergeFile(fileId, {
    deletedAt: nowIso(),
    restoreParentId: toParentKey(target.parentId),
  });
}

export async function restoreFile(fileId: string): Promise<void> {
  const { folders, files } = await loadAll();
  const target = files.find((file) => file.id === fileId);
  if (!target) throw new AppError('NOT_FOUND');

  const desired = target.restoreParentId ?? toParentKey(target.parentId);
  const parentAlive =
    desired === ROOT_ID || folders.some((folder) => folder.id === desired && !folder.deletedAt);
  const parentId = parentAlive ? desired : UNSORTED_ID;
  const siblings = siblingFileNames(files, parentId, fileId);

  await mergeFile(fileId, {
    parentId,
    name: nextAvailableName(target.name, siblings),
    deletedAt: undefined,
    restoreParentId: undefined,
  });
}

export async function purgeFile(fileId: string): Promise<void> {
  const meta = await readFileMeta(fileId);
  if (meta) await scheduleCloudDeletes([meta]);

  await tx([STORE.files, STORE.blobs, STORE.thumbs], 'readwrite', async (t) => {
    await idb.delete(t.objectStore(STORE.files), fileId);
    await idb.delete(t.objectStore(STORE.blobs), fileId);
    await idb.delete(t.objectStore(STORE.thumbs), fileId);
  });

  await purgeAttachments([fileId]);
}

/* ------------------------------------------------------------------ */
/* ごみ箱                                                              */
/* ------------------------------------------------------------------ */

export async function emptyTrash(): Promise<void> {
  const { folders, files } = await loadAll();
  const folderIds = folders.filter((folder) => folder.deletedAt).map((folder) => folder.id);
  const targets = files.filter((file) => file.deletedAt);
  const fileIds = targets.map((file) => file.id);

  await scheduleCloudDeletes(targets);

  await tx([STORE.folders, STORE.files, STORE.blobs, STORE.thumbs], 'readwrite', async (t) => {
    const folderStore = t.objectStore(STORE.folders);
    const fileStore = t.objectStore(STORE.files);
    const blobStore = t.objectStore(STORE.blobs);
    const thumbStore = t.objectStore(STORE.thumbs);
    for (const id of folderIds) await idb.delete(folderStore, id);
    for (const id of fileIds) {
      await idb.delete(fileStore, id);
      await idb.delete(blobStore, id);
      await idb.delete(thumbStore, id);
    }
  });

  await purgeAttachments(fileIds);
}

/** 保持期間を過ぎたごみ箱の項目を自動削除する。起動時に呼ぶ。 */
export async function purgeExpiredTrash(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const { folders, files } = await loadAll();
  const limit = Date.now() - retentionDays * 86_400_000;
  const expired = (deletedAt?: string) =>
    Boolean(deletedAt) && new Date(deletedAt as string).getTime() < limit;

  const folderIds = folders.filter((folder) => expired(folder.deletedAt)).map((f) => f.id);
  const targets = files.filter((file) => expired(file.deletedAt));
  const fileIds = targets.map((f) => f.id);
  if (folderIds.length === 0 && fileIds.length === 0) return 0;

  // 保持期間が終了したものはクラウド上のPDFも削除対象にする
  await scheduleCloudDeletes(targets);

  await tx([STORE.folders, STORE.files, STORE.blobs, STORE.thumbs], 'readwrite', async (t) => {
    const folderStore = t.objectStore(STORE.folders);
    const fileStore = t.objectStore(STORE.files);
    const blobStore = t.objectStore(STORE.blobs);
    const thumbStore = t.objectStore(STORE.thumbs);
    for (const id of folderIds) await idb.delete(folderStore, id);
    for (const id of fileIds) {
      await idb.delete(fileStore, id);
      await idb.delete(blobStore, id);
      await idb.delete(thumbStore, id);
    }
  });

  await purgeAttachments(fileIds);
  return folderIds.length + fileIds.length;
}

/* ------------------------------------------------------------------ */
/* その他                                                              */
/* ------------------------------------------------------------------ */

export { readBlob, wipeAll };

export type { Importance };

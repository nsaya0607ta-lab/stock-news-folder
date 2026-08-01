'use client';

/**
 * クラウド保管の中核。PDF 本体をクラウドへ預け、必要なときに取り戻す。
 *
 * 設計の要点
 * ----------
 * 1. **端末内の PDF を消すのは最後**
 *    アップロード → 存在確認 → サイズ照合 → IndexedDB への保存先記録、が
 *    すべて成功して初めて端末内 Blob を削除する。途中で失敗・アプリ終了が起きても
 *    端末内の PDF はそのまま残る。
 * 2. **同時に両方から消えない**
 *    クラウド側の削除は「端末側の完全削除が終わったあと」に待ち行列 (cloudQueue) 経由で行う。
 *    端末へ戻すときは逆に「端末へ保存して検証したあと」にクラウドを消す。
 * 3. **冪等**
 *    保存先パスはファイル ID から一意に決まる (`users/<uid>/pdf-cloud/<id>.pdf`)。
 *    同じ処理を何度実行しても、重複したファイルも欠損も生まれない。
 * 4. **多重実行しない**
 *    処理中のファイル ID をモジュール内で保持し、同じ対象の処理が重なった場合は
 *    実行中の Promise を共有する。
 */
import { AppError, type AppErrorCode } from './errors';
import {
  cloudPathFor,
  enqueueCloudDeletes,
  markCloudDeleteFailed,
  readDeleteQueue,
  resolveCloudDeletes,
  uidFromCloudPath,
} from './cloudQueue';
import { cloudErrorCode, cloudErrorMessage, cloudRef, requireCloudUser } from './firebaseCloud';
import { hasBlob, loadAll } from './db';
import { nowIso } from './naming';
import * as repo from './repository';
import { storageStateOf, type PdfFileMeta } from './types';

export type CloudProgress = (percent: number) => void;

/* ------------------------------------------------------------------ */
/* 多重実行の防止                                                      */
/* ------------------------------------------------------------------ */

const running = new Map<string, Promise<unknown>>();

function once<T>(key: string, task: () => Promise<T>): Promise<T> {
  const existing = running.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const job = task().finally(() => {
    running.delete(key);
  });
  running.set(key, job);
  return job;
}

export function isBusy(fileId: string): boolean {
  return running.has(`upload:${fileId}`) || running.has(`download:${fileId}`);
}

/* ------------------------------------------------------------------ */
/* 小さなヘルパー                                                      */
/* ------------------------------------------------------------------ */

export function isOnline(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.onLine !== false;
}

/** 先頭が `%PDF-` かどうか。取得した中身が本当に PDF か確認する。 */
async function looksLikePdf(blob: Blob): Promise<boolean> {
  try {
    const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
    return (
      head.length === 5 &&
      head[0] === 0x25 && // %
      head[1] === 0x50 && // P
      head[2] === 0x44 && // D
      head[3] === 0x46 && // F
      head[4] === 0x2d //   -
    );
  } catch {
    return false;
  }
}

function toAppError(error: unknown, fallback: AppErrorCode): AppError {
  if (error instanceof AppError) return error;
  const code = cloudErrorCode(error);
  if (code.includes('SIGNED_OUT') || code.includes('user-token-expired') || code.includes('unauthenticated')) {
    return new AppError('CLOUD_SIGNED_OUT');
  }
  if (code.includes('storage/unauthorized') || code.includes('permission-denied')) {
    return new AppError('CLOUD_SIGNED_OUT');
  }
  if (code.includes('storage/object-not-found')) return new AppError('CLOUD_NOT_FOUND');
  if (code.includes('storage/quota-exceeded')) return new AppError('CLOUD_QUOTA_EXCEEDED');
  return new AppError(fallback, cloudErrorMessage(error));
}

/* ------------------------------------------------------------------ */
/* 起動時の後始末                                                      */
/* ------------------------------------------------------------------ */

/**
 * 中断された処理の状態を整える。アプリ起動時に一度だけ呼ぶ。
 * ここでは PDF 本体を削除しない。状態表示を実態に合わせるだけ。
 */
export async function recoverInterrupted(): Promise<number> {
  const { files } = await loadAll();
  let fixed = 0;

  for (const file of files) {
    const state = storageStateOf(file);

    if (state === 'uploading') {
      // 送信中にアプリが終了した。端末内の PDF はそのまま残っているので、
      // 未処理の状態へ戻して次の同期で再試行させる。
      const local = await hasBlob(file.id);
      if (local) {
        await repo.patchCloudState(file.id, { storageState: 'local', cloudError: undefined });
      } else if (file.cloudPath && file.cloudUploadedAt) {
        await repo.patchCloudState(file.id, { storageState: 'cloud' });
      } else {
        await repo.patchCloudState(file.id, {
          storageState: 'error',
          cloudError: 'アップロードが中断されました。',
        });
      }
      fixed += 1;
      continue;
    }

    if (state === 'downloading') {
      await repo.patchCloudState(file.id, {
        storageState: file.cloudPath ? 'cloud' : 'local',
      });
      fixed += 1;
      continue;
    }

    if (state === 'cloud' && !file.localCachedAt && (await hasBlob(file.id))) {
      // 保存先の記録は終わったが、端末内 Blob の削除前に終了した状態。
      // 端末内のコピーは「キャッシュ」として扱い、未使用期間が過ぎたら片付ける。
      await repo.patchCloudState(file.id, { localCachedAt: nowIso() });
      fixed += 1;
    }
  }

  return fixed;
}

/* ------------------------------------------------------------------ */
/* アップロード (端末 → クラウド)                                      */
/* ------------------------------------------------------------------ */

export type UploadOutcome = 'uploaded' | 'skipped';

type CloudUploadTask = {
  on: (
    event: 'state_changed',
    next: (snapshot: { bytesTransferred: number; totalBytes: number }) => void,
    error: (error: unknown) => void,
    complete: () => void,
  ) => void;
};

type CloudFileRef = {
  put: (blob: Blob, metadata?: unknown) => CloudUploadTask;
  getMetadata: () => Promise<{ size?: number | string } | undefined>;
  getDownloadURL: () => Promise<string>;
  delete: () => Promise<void>;
};

function putWithProgress(
  ref: CloudFileRef,
  blob: Blob,
  fileId: string,
  onProgress?: CloudProgress,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const task = ref.put(blob, {
      contentType: 'application/pdf',
      // ファイル名などの個人情報はクラウド側のメタデータへ書かない
      customMetadata: { fileId },
    });
    task.on(
      'state_changed',
      (snapshot) => {
        if (!onProgress || !snapshot.totalBytes) return;
        onProgress(Math.min(99, Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100)));
      },
      (error: unknown) => reject(error),
      () => resolve(),
    );
  });
}

/** 型付きの Storage 参照を得る (compat SDK は any を返すため、ここで形を固定する)。 */
async function fileRef(path: string): Promise<CloudFileRef> {
  return (await cloudRef(path)) as CloudFileRef;
}

/**
 * 1 件の PDF をクラウドへ保管する。
 *
 * 端末内の PDF を削除するのは、次のすべてが成功したあとだけ。
 *   1. アップロード完了
 *   2. アップロードしたファイルの存在確認
 *   3. サイズの整合性確認
 *   4. 保存先情報の IndexedDB への保存
 */
export async function uploadToCloud(
  uid: string,
  fileId: string,
  onProgress?: CloudProgress,
): Promise<UploadOutcome> {
  return once(`upload:${fileId}`, async () => {
    const meta = await repo.readFileMeta(fileId);
    if (!meta) return 'skipped';
    if (meta.deletedAt) return 'skipped'; // ごみ箱の中は対象外
    const state = storageStateOf(meta);
    if (state === 'cloud' || state === 'downloading' || state === 'uploading') return 'skipped';

    // PDF 本体が端末内にあることが前提
    const blob = await repo.readBlob(fileId);
    if (!blob || blob.size === 0) return 'skipped';

    const path = cloudPathFor(uid, fileId);
    await repo.patchCloudState(fileId, { storageState: 'uploading', cloudError: undefined });
    onProgress?.(0);

    try {
      const ref = await fileRef(path);

      /* 1. アップロード ------------------------------------------------ */
      await putWithProgress(ref, blob, fileId, onProgress);

      /* 2. 存在確認 + 3. サイズの整合性確認 ---------------------------- */
      const info = await ref.getMetadata();
      const remoteSize = Number(info?.size);
      if (!info || !Number.isFinite(remoteSize)) throw new AppError('CLOUD_VERIFY_FAILED');
      if (remoteSize !== blob.size) throw new AppError('CLOUD_VERIFY_FAILED');

      /* 4. 保存先情報を IndexedDB へ保存 ------------------------------- */
      const saved = await repo.patchCloudState(fileId, {
        storageState: 'cloud',
        cloudPath: path,
        cloudUploadedAt: nowIso(),
        cloudSize: remoteSize,
        cloudError: undefined,
        localCachedAt: undefined,
      });

      if (!saved) {
        // 途中で完全削除された。クラウド側に残った実体は削除予約へ回す。
        await scheduleOrphanDelete(path, uid);
        return 'skipped';
      }
      if (saved.storageState !== 'cloud' || saved.cloudPath !== path) {
        throw new AppError('CLOUD_VERIFY_FAILED');
      }

      /* 5. ここまで全部成功。ようやく端末内の PDF 本体だけを削除する --- */
      await repo.dropLocalBlob(fileId);
      onProgress?.(100);
      return 'uploaded';
    } catch (error) {
      // 端末内の PDF 本体には一切触れていないので、ここでは状態を戻すだけ。
      const appError = toAppError(error, 'CLOUD_UPLOAD_FAILED');
      await repo.patchCloudState(fileId, {
        storageState: 'error',
        cloudError: appError.message,
      });
      throw appError;
    }
  });
}

/** 参照されなくなったクラウド上の実体を、削除待ち行列へ回す。 */
async function scheduleOrphanDelete(path: string, uid: string): Promise<void> {
  await enqueueCloudDeletes([{ path, uid }]);
}

/* ------------------------------------------------------------------ */
/* ダウンロード (クラウド → 端末)                                      */
/* ------------------------------------------------------------------ */

async function fetchWithProgress(
  url: string,
  expectedSize: number | undefined,
  onProgress?: CloudProgress,
): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    if (response.status === 404) throw new AppError('CLOUD_NOT_FOUND');
    if (response.status === 401 || response.status === 403) throw new AppError('CLOUD_SIGNED_OUT');
    throw new AppError('CLOUD_DOWNLOAD_FAILED');
  }

  const total = Number(response.headers.get('content-length')) || expectedSize || 0;
  const body = response.body;
  if (!body || !onProgress || !total) {
    // 進捗を取れない環境ではまとめて受け取る
    const blob = await response.blob();
    onProgress?.(100);
    return blob;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.byteLength;
    onProgress(Math.min(99, Math.round((received / total) * 100)));
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress(100);
  const buffer = new ArrayBuffer(merged.byteLength);
  new Uint8Array(buffer).set(merged);
  return new Blob([buffer], { type: 'application/pdf' });
}

/**
 * クラウド保管済みの PDF を取り戻す。
 * すでに端末内にある場合は通信せずそのまま返す (冪等)。
 */
export async function fetchFromCloud(
  uid: string,
  fileId: string,
  onProgress?: CloudProgress,
): Promise<Blob> {
  return once(`download:${fileId}`, async () => {
    const meta = await repo.readFileMeta(fileId);
    if (!meta) throw new AppError('NOT_FOUND');

    // 1 度取得済みならダウンロードしない
    const local = await repo.readBlob(fileId);
    if (local) return local;

    if (!meta.cloudPath) throw new AppError('NOT_FOUND');
    if (uidFromCloudPath(meta.cloudPath) !== uid) throw new AppError('CLOUD_SIGNED_OUT');
    if (!isOnline()) throw new AppError('CLOUD_OFFLINE');

    await repo.patchCloudState(fileId, { storageState: 'downloading' });
    onProgress?.(0);

    let blob: Blob;
    try {
      const ref = await fileRef(meta.cloudPath);
      const url = await ref.getDownloadURL();
      blob = await fetchWithProgress(url, meta.cloudSize, onProgress);

      /* 中身とサイズの確認 ------------------------------------------- */
      if (blob.size === 0) throw new AppError('CLOUD_VERIFY_FAILED');
      if (meta.cloudSize && blob.size !== meta.cloudSize) throw new AppError('CLOUD_VERIFY_FAILED');
      if (!(await looksLikePdf(blob))) throw new AppError('CLOUD_VERIFY_FAILED');
    } catch (error) {
      const appError = toAppError(error, 'CLOUD_DOWNLOAD_FAILED');
      // 通信の一時的な失敗は「エラー状態」として固定しない (次回タップで再試行できる)。
      const transient =
        appError.code === 'CLOUD_OFFLINE' || appError.code === 'CLOUD_DOWNLOAD_FAILED';
      await repo.patchCloudState(fileId, {
        // クラウド上の実体には触れていないので、保管済みの状態そのものは維持する
        storageState: transient ? 'cloud' : 'error',
        cloudError: transient ? undefined : appError.message,
      });
      throw appError;
    }

    /* IndexedDB へ一時保存 (失敗しても閲覧は続けられる) --------------- */
    try {
      await repo.cacheLocalBlob(fileId, blob);
      await repo.patchCloudState(fileId, {
        storageState: 'cloud',
        localCachedAt: nowIso(),
        cloudError: undefined,
      });
    } catch {
      // 端末の容量不足など。クラウド上のファイルは無事なので状態は cloud のまま。
      await repo.patchCloudState(fileId, {
        storageState: 'cloud',
        cloudError: '端末の空き容量が足りず、PDFを端末内へ保存できませんでした。',
      });
    }

    return blob;
  });
}

/* ------------------------------------------------------------------ */
/* 端末内キャッシュの片付け                                            */
/* ------------------------------------------------------------------ */

/**
 * クラウド保管済み PDF の「端末内キャッシュ」だけを消す。
 * 消す前にクラウド上の実体をもう一度確認するので、
 * クラウド側が失われている状態で端末内のコピーを消すことはない。
 */
export async function evictLocalCache(uid: string, fileId: string): Promise<boolean> {
  if (isBusy(fileId)) return false;
  return once(`evict:${fileId}`, async () => {
    const meta = await repo.readFileMeta(fileId);
    if (!meta || !meta.cloudPath || storageStateOf(meta) !== 'cloud') return false;
    if (uidFromCloudPath(meta.cloudPath) !== uid) return false;
    if (!(await hasBlob(fileId))) return false;

    try {
      const ref = await fileRef(meta.cloudPath);
      const info = await ref.getMetadata();
      const remoteSize = Number(info?.size);
      if (!Number.isFinite(remoteSize) || remoteSize === 0) return false;
      if (meta.cloudSize && remoteSize !== meta.cloudSize) return false;
    } catch {
      // 確認できないときは端末内のコピーを残す (安全側に倒す)
      return false;
    }

    const dropped = await repo.dropLocalBlob(fileId);
    if (dropped) await repo.patchCloudState(fileId, { localCachedAt: undefined });
    return dropped;
  });
}

/* ------------------------------------------------------------------ */
/* すべて端末へ戻す                                                    */
/* ------------------------------------------------------------------ */

export type RestoreAllResult = { restored: number; failed: number };

/**
 * クラウド保管中の PDF をすべて端末へ戻す。
 *
 * 「端末へ保存して中身を検証する」→「クラウド側の削除を予約する」の順に行うため、
 * 途中で失敗しても端末とクラウドの両方から同時に消えることはない。
 */
export async function restoreAllToDevice(
  uid: string,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<RestoreAllResult> {
  const { files } = await loadAll();
  const targets = files.filter((file) => Boolean(file.cloudPath) && storageStateOf(file) === 'cloud');
  let restored = 0;
  let failed = 0;

  for (let index = 0; index < targets.length; index += 1) {
    const file = targets[index];
    onProgress?.(index, targets.length, file.name);
    try {
      // 1. 端末へ取り戻す (すでに端末内にあれば通信しない)
      await fetchFromCloud(uid, file.id);
      // 2. 端末内に本体があることを確かめてから、クラウド側の記録を外す
      if (!(await hasBlob(file.id))) throw new AppError('CLOUD_DOWNLOAD_FAILED');
      const path = file.cloudPath as string;
      await repo.patchCloudState(file.id, {
        storageState: 'local',
        cloudPath: undefined,
        cloudUploadedAt: undefined,
        cloudSize: undefined,
        cloudError: undefined,
        localCachedAt: undefined,
      });
      // 3. クラウド側の削除は待ち行列へ (失敗しても次回オンライン時に再試行)
      await scheduleOrphanDelete(path, uid);
      restored += 1;
    } catch {
      failed += 1;
    }
  }

  onProgress?.(targets.length, targets.length, '');
  return { restored, failed };
}

/* ------------------------------------------------------------------ */
/* クラウド側の削除 (待ち行列)                                         */
/* ------------------------------------------------------------------ */

export type DrainResult = { deleted: number; remaining: number };

/**
 * 完全削除された PDF のクラウド上の実体を消す。
 *
 * - 端末内にまだ同じ保存先を使っている PDF がある場合は削除しない
 *   (ごみ箱からの復元やコピーで参照が生きているケースを守る)。
 * - すでに存在しない場合は「完了」として扱う (冪等)。
 * - 失敗した行は残し、次回オンライン時に再試行する。
 */
export async function drainDeleteQueue(uid: string): Promise<DrainResult> {
  return once('drain', async () => {
    const tasks = (await readDeleteQueue()).filter((task) => task.uid === uid);
    if (tasks.length === 0) return { deleted: 0, remaining: 0 };

    const { files } = await loadAll();
    const inUse = new Set(
      files.filter((file) => Boolean(file.cloudPath)).map((file) => file.cloudPath as string),
    );

    const done: string[] = [];
    let deleted = 0;

    for (const task of tasks) {
      if (inUse.has(task.path)) {
        // まだ使われている保存先は消さない (誤削除の防止)
        done.push(task.path);
        continue;
      }
      try {
        const ref = await fileRef(task.path);
        await ref.delete();
        done.push(task.path);
        deleted += 1;
      } catch (error) {
        if (cloudErrorCode(error).includes('storage/object-not-found')) {
          // すでに消えている = 目的は達成されている
          done.push(task.path);
          continue;
        }
        await markCloudDeleteFailed(task.path, cloudErrorMessage(error));
      }
    }

    await resolveCloudDeletes(done);
    const remaining = (await readDeleteQueue()).filter((task) => task.uid === uid).length;
    return { deleted, remaining };
  });
}

/* ------------------------------------------------------------------ */
/* 集計                                                                */
/* ------------------------------------------------------------------ */

export type CloudStats = {
  /** クラウド保管中の PDF 件数 (ごみ箱を除く)。 */
  cloudCount: number;
  /** ごみ箱にあるがクラウドにも残っている PDF 件数。 */
  trashedCloudCount: number;
  /** クラウド使用量の合計 (バイト)。 */
  cloudBytes: number;
  /** 端末内にキャッシュされているクラウド PDF の件数。 */
  cachedCount: number;
  /** 同期エラー件数。 */
  errorCount: number;
};

export function summarize(files: PdfFileMeta[]): CloudStats {
  let cloudCount = 0;
  let trashedCloudCount = 0;
  let cloudBytes = 0;
  let cachedCount = 0;
  let errorCount = 0;

  for (const file of files) {
    const state = storageStateOf(file);
    if (state === 'error') errorCount += 1;
    if (!file.cloudPath) continue;
    if (state !== 'cloud') continue;
    cloudBytes += file.cloudSize ?? file.size;
    if (file.deletedAt) trashedCloudCount += 1;
    else cloudCount += 1;
    if (file.localCachedAt) cachedCount += 1;
  }

  return { cloudCount, trashedCloudCount, cloudBytes, cachedCount, errorCount };
}

/** ログイン中のユーザーを取得する。期限切れならエラー。 */
export async function ensureUser(): Promise<string> {
  try {
    const user = await requireCloudUser();
    return user.uid;
  } catch (error) {
    throw toAppError(error, 'CLOUD_SIGNED_OUT');
  }
}

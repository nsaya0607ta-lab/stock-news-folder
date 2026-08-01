/**
 * IndexedDB のごく薄いラッパー。
 * ここではストアの入出力だけを扱い、アプリのルール (階層・ごみ箱など) は
 * repository.ts 側に置く。将来クラウド同期のバックエンドを足すときは、
 * repository の実装を差し替えるだけで済むようにしている。
 */
import { AppError } from './errors';
import type { Folder, PdfFileMeta, Settings } from './types';

export const DB_NAME = 'pdf-folder-manager';
export const DB_VERSION = 1;

export const STORE = {
  folders: 'folders',
  files: 'files',
  blobs: 'blobs',
  thumbs: 'thumbs',
  settings: 'settings',
  shareInbox: 'share_inbox',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

export function isIndexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

export function openDb(): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(new AppError('INDEXEDDB_UNAVAILABLE'));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE.folders)) {
        const folders = db.createObjectStore(STORE.folders, { keyPath: 'id' });
        folders.createIndex('parentId', 'parentId');
        folders.createIndex('deletedAt', 'deletedAt');
      }
      if (!db.objectStoreNames.contains(STORE.files)) {
        const files = db.createObjectStore(STORE.files, { keyPath: 'id' });
        files.createIndex('parentId', 'parentId');
        files.createIndex('deletedAt', 'deletedAt');
        files.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(STORE.blobs)) {
        db.createObjectStore(STORE.blobs, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE.thumbs)) {
        db.createObjectStore(STORE.thumbs, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE.settings)) {
        db.createObjectStore(STORE.settings, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE.shareInbox)) {
        db.createObjectStore(STORE.shareInbox, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new AppError('INDEXEDDB_UNAVAILABLE'));
    request.onblocked = () => reject(new AppError('INDEXEDDB_UNAVAILABLE'));
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });

  return dbPromise;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function tx<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  run: (transaction: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    let result: T;
    let settled = false;
    transaction.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    transaction.onerror = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error);
      }
    };
    transaction.onabort = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error ?? new AppError('UNKNOWN'));
      }
    };
    Promise.resolve(run(transaction)).then(
      (value) => {
        result = value;
      },
      (error) => {
        settled = true;
        try {
          transaction.abort();
        } catch {
          /* すでに終了している場合は無視 */
        }
        reject(error);
      },
    );
  });
}

export const idb = {
  get: <T>(store: IDBObjectStore, key: IDBValidKey) => promisify<T>(store.get(key) as IDBRequest<T>),
  getAll: <T>(store: IDBObjectStore | IDBIndex, query?: IDBKeyRange | IDBValidKey) =>
    promisify<T[]>(store.getAll(query) as IDBRequest<T[]>),
  put: (store: IDBObjectStore, value: unknown) => promisify(store.put(value as never)),
  delete: (store: IDBObjectStore, key: IDBValidKey) => promisify(store.delete(key)),
  clear: (store: IDBObjectStore) => promisify(store.clear()),
  count: (store: IDBObjectStore | IDBIndex) => promisify<number>(store.count()),
};

/* ------------------------------------------------------------------ */
/* 型付きの読み書きヘルパー                                            */
/* ------------------------------------------------------------------ */

export async function loadAll(): Promise<{ folders: Folder[]; files: PdfFileMeta[] }> {
  return tx([STORE.folders, STORE.files], 'readonly', async (t) => {
    const folders = await idb.getAll<Folder>(t.objectStore(STORE.folders));
    const files = await idb.getAll<PdfFileMeta>(t.objectStore(STORE.files));
    return { folders, files };
  });
}

export async function readSettings(): Promise<Partial<Settings>> {
  return tx(STORE.settings, 'readonly', async (t) => {
    const record = await idb.get<{ key: string; value: Partial<Settings> }>(
      t.objectStore(STORE.settings),
      'app',
    );
    return record?.value ?? {};
  });
}

export async function writeSettings(value: Settings): Promise<void> {
  await tx(STORE.settings, 'readwrite', async (t) => {
    await idb.put(t.objectStore(STORE.settings), { key: 'app', value });
  });
}

export async function readBlob(id: string): Promise<Blob | undefined> {
  return tx(STORE.blobs, 'readonly', async (t) => {
    const record = await idb.get<{ id: string; blob: Blob }>(t.objectStore(STORE.blobs), id);
    return record?.blob;
  });
}

/** PDF 本体が端末内に存在するか (Blob 全体を読まずに判定する)。 */
export async function hasBlob(id: string): Promise<boolean> {
  return tx(STORE.blobs, 'readonly', async (t) => {
    const key = await promisify(t.objectStore(STORE.blobs).getKey(id));
    return key !== undefined;
  });
}

export async function writeBlob(id: string, blob: Blob): Promise<void> {
  await tx(STORE.blobs, 'readwrite', async (t) => {
    await idb.put(t.objectStore(STORE.blobs), { id, blob });
  });
}

export async function deleteBlob(id: string): Promise<void> {
  await tx(STORE.blobs, 'readwrite', async (t) => {
    await idb.delete(t.objectStore(STORE.blobs), id);
  });
}

/**
 * 設定ストアの任意キーを読み書きする。
 * クラウド保管の「削除待ちキュー」など、設定本体とは別に更新したいデータに使う。
 * (別ストアを足すと DB バージョンが上がり、Service Worker 側の openDb と
 *  食い違って古い版が VersionError で止まるため、既存ストアに相乗りさせる)
 */
export async function readKeyed<T>(key: string): Promise<T | undefined> {
  return tx(STORE.settings, 'readonly', async (t) => {
    const record = await idb.get<{ key: string; value: T }>(t.objectStore(STORE.settings), key);
    return record?.value;
  });
}

export async function writeKeyed<T>(key: string, value: T): Promise<void> {
  await tx(STORE.settings, 'readwrite', async (t) => {
    await idb.put(t.objectStore(STORE.settings), { key, value });
  });
}

export async function deleteKeyed(key: string): Promise<void> {
  await tx(STORE.settings, 'readwrite', async (t) => {
    await idb.delete(t.objectStore(STORE.settings), key);
  });
}

/**
 * 接頭辞が一致するキー付きレコードをまとめて読む。
 * メモ (`memo:<fileId>`) のように「ファイルごとに 1 レコード」で持つデータを、
 * 検索のために横断して集めるときに使う。
 */
export async function readKeyedByPrefix<T>(
  prefix: string,
): Promise<{ key: string; value: T }[]> {
  return tx(STORE.settings, 'readonly', async (t) => {
    const rows = await idb.getAll<{ key: string; value: T }>(t.objectStore(STORE.settings));
    return rows.filter((row) => typeof row?.key === 'string' && row.key.startsWith(prefix));
  });
}

/**
 * キー付きレコードを 1 つのトランザクション内で「読み → 変更 → 書き戻し」する。
 *
 * メモは同じファイルの配列を丸ごと持つため、読んでから書くまでの間に別の操作が
 * 割り込むと、片方の変更が消えてしまう。必ず最新を読み直してから書き換える。
 * `mutate` が undefined を返した場合はレコードごと削除する。
 */
export async function mutateKeyed<T>(
  key: string,
  mutate: (current: T | undefined) => T | undefined,
): Promise<T | undefined> {
  return tx(STORE.settings, 'readwrite', async (t) => {
    const store = t.objectStore(STORE.settings);
    const record = await idb.get<{ key: string; value: T }>(store, key);
    const next = mutate(record?.value);
    if (next === undefined) {
      await idb.delete(store, key);
      return undefined;
    }
    await idb.put(store, { key, value: next });
    return next;
  });
}

export async function readThumb(id: string): Promise<Blob | undefined> {
  return tx(STORE.thumbs, 'readonly', async (t) => {
    const record = await idb.get<{ id: string; blob: Blob }>(t.objectStore(STORE.thumbs), id);
    return record?.blob;
  });
}

export async function writeThumb(id: string, blob: Blob): Promise<void> {
  await tx(STORE.thumbs, 'readwrite', async (t) => {
    await idb.put(t.objectStore(STORE.thumbs), { id, blob });
  });
}

/** 全ストアを空にする (設定画面の「すべてのデータを削除」)。 */
export async function wipeAll(): Promise<void> {
  await tx(Object.values(STORE), 'readwrite', async (t) => {
    for (const name of Object.values(STORE)) {
      await idb.clear(t.objectStore(name));
    }
  });
}

/** 端末の保存容量の見積り。 */
export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

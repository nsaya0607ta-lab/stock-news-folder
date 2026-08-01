/* eslint-disable no-restricted-globals */
/**
 * Service Worker
 *  1. アプリシェルをキャッシュしてオフライン起動できるようにする
 *  2. 他アプリの共有メニューから送られた PDF を IndexedDB へ預かる
 *
 * キャッシュ戦略:
 *  - ナビゲーション: ネットワーク優先 → 失敗したらキャッシュ
 *  - Next.js のハッシュ付き静的アセット: キャッシュ優先
 *  - 同じ URL で更新される可能性があるファイル: ネットワーク優先
 */

const CACHE_VERSION = 'v7';
const CACHE_NAME = `pdf-folder-${CACHE_VERSION}`;
const CACHE_PREFIX = 'pdf-folder-';

// 日本語 PDF が使う定義済み CMap。これが無いと文字が描画されないため、
// オフラインでも閲覧できるようにアプリシェルと一緒に先読みしておく (計 130KB 程度)。
// その他の CMap / フォントは必要になった時点で fetch → キャッシュされる。
const PDFJS_CMAPS = [
  'UniJIS-UCS2-H',
  'UniJIS-UCS2-V',
  'UniJIS-UCS2-HW-H',
  'UniJIS-UCS2-HW-V',
  'UniJIS-UTF16-H',
  'UniJIS-UTF16-V',
  '90ms-RKSJ-H',
  '90ms-RKSJ-V',
  '90msp-RKSJ-H',
  'Adobe-Japan1-UCS2',
].map((name) => `/pdfjs/cmaps/${name}.bcmap`);

const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/pdf.worker.min.mjs',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-180.png',
  ...PDFJS_CMAPS,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        // 1 つでも失敗するとインストール全体が止まるため、個別に握りつぶす
        Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => undefined))),
      )
      .then(() => self.skipWaiting()),
  );
});

async function refreshOpenClients() {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  await Promise.all(
    clients.map(async (client) => {
      try {
        const url = new URL(client.url);
        if (url.origin !== self.location.origin) return;

        // iOS のホーム画面版はアプリ終了後も古い画面を復元する場合があるため、
        // Service Worker の切り替え時に URL を変えて明示的な再ナビゲーションを行う。
        url.searchParams.set('__pwa_update', CACHE_VERSION);
        await client.navigate(url.toString());
      } catch {
        // WindowClient.navigate に未対応の環境でも更新処理自体は継続する
      }
    }),
  );
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );

      await self.clients.claim();
      await refreshOpenClients();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ------------------------------------------------------------------ */
/* 共有メニューからの受け取り                                          */
/* ------------------------------------------------------------------ */

const DB_NAME = 'pdf-folder-manager';
const DB_VERSION = 1;
const INBOX_STORE = 'share_inbox';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // アプリ側と同じ構成を作る (SW が先に開いた場合の保険)
      if (!db.objectStoreNames.contains('folders')) {
        const folders = db.createObjectStore('folders', { keyPath: 'id' });
        folders.createIndex('parentId', 'parentId');
        folders.createIndex('deletedAt', 'deletedAt');
      }
      if (!db.objectStoreNames.contains('files')) {
        const files = db.createObjectStore('files', { keyPath: 'id' });
        files.createIndex('parentId', 'parentId');
        files.createIndex('deletedAt', 'deletedAt');
        files.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings'))
        db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains(INBOX_STORE))
        db.createObjectStore(INBOX_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeSharedFiles(files) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(INBOX_STORE, 'readwrite');
    const store = transaction.objectStore(INBOX_STORE);
    files.forEach((file, index) => {
      store.put({
        id: `share-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name || 'shared.pdf',
        blob: file,
        receivedAt: new Date().toISOString(),
      });
    });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  db.close();
}

async function handleShareTarget(event) {
  try {
    const formData = await event.request.formData();
    const files = formData
      .getAll('files')
      .filter((entry) => entry && typeof entry === 'object' && 'name' in entry);
    if (files.length > 0) await storeSharedFiles(files);
  } catch {
    /* 受け取りに失敗してもアプリは開く */
  }
  return Response.redirect('/?shared=1', 303);
}

/* ------------------------------------------------------------------ */
/* キャッシュ処理                                                       */
/* ------------------------------------------------------------------ */

function canCache(response) {
  return response.ok && response.status === 200 && response.type === 'basic';
}

async function saveToCache(request, response) {
  if (!canCache(response)) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  } catch {
    // 容量不足やキャッシュ非対応のレスポンスでも、取得結果自体はそのまま返す
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  await saveToCache(request, response);
  return response;
}

async function networkFirst(request, fallbackRequest = request) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    await saveToCache(fallbackRequest, response);
    return response;
  } catch {
    const cached = await caches.match(fallbackRequest);
    if (cached) return cached;
    throw new Error('Network unavailable and no cached response exists.');
  }
}

/* ------------------------------------------------------------------ */
/* fetch                                                               */
/* ------------------------------------------------------------------ */

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(handleShareTarget(event));
    return;
  }

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // ページ本体は必ずネットワークを先に確認する。
    // オフライン時だけ、最後に取得できたトップページを使用する。
    event.respondWith(networkFirst(request, '/'));
    return;
  }

  if (url.pathname.startsWith('/_next/static/')) {
    // Next.js のビルドハッシュ付きファイルは URL が変わるため、キャッシュ優先で安全。
    event.respondWith(cacheFirst(request));
    return;
  }

  // manifest・アイコン・PDF Worker など、同じ URL のまま内容が変わるファイルは
  // ネットワーク優先にし、ホーム画面版でも最新版へ追従させる。
  event.respondWith(networkFirst(request));
});

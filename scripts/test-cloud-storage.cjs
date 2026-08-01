/* eslint-disable no-console */
/**
 * クラウド保管のふるまいを実コードで検証する。
 *
 *   node scripts/test-cloud-storage.cjs
 *
 * src/lib/*.ts をその場で CommonJS へコンパイルし、
 *   - IndexedDB … fake-indexeddb
 *   - Firebase Storage … このファイル内のメモリ実装
 * に差し替えて、実際の repository / cloudStorage / cloudSync を動かす。
 *
 * 「アップロードに失敗したとき端末内の PDF が残るか」など、
 * 手作業では再現しにくい失敗経路まで確認するのが目的。
 */
require('fake-indexeddb/auto');

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/* ------------------------------------------------------------------ */
/* 対象コードのコンパイル                                              */
/* ------------------------------------------------------------------ */

const root = path.resolve(__dirname, '..');
// node_modules の下に出力する。fflate など実際の依存を解決させるため。
const outDir = path.join(root, 'node_modules', '.cache', 'pdf-cloud-test');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

execFileSync(
  process.execPath,
  [
    path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    ...fs.readdirSync(path.join(root, 'src', 'lib')).map((name) => path.join(root, 'src', 'lib', name)),
    '--outDir',
    outDir,
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck',
    '--lib',
    'es2022,dom',
  ],
  { stdio: 'inherit' },
);

/* ------------------------------------------------------------------ */
/* Firebase Storage のメモリ実装                                       */
/* ------------------------------------------------------------------ */

const cloudFiles = new Map(); // path -> { bytes: Uint8Array, contentType }
const cloudState = {
  failUpload: false,
  failVerify: false,
  failDownload: false,
  corruptDownload: false,
  offline: false,
  uploads: 0,
  downloads: 0,
  deletes: 0,
};

function makeRef(objectPath) {
  return {
    put(blob) {
      let onComplete = () => {};
      let onError = () => {};
      const run = async () => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (cloudState.offline) throw Object.assign(new Error('offline'), { code: 'storage/retry-limit-exceeded' });
        if (cloudState.failUpload) throw Object.assign(new Error('boom'), { code: 'storage/unknown' });
        cloudState.uploads += 1;
        cloudFiles.set(objectPath, { bytes, contentType: 'application/pdf' });
      };
      setTimeout(() => {
        run().then(
          () => onComplete(),
          (error) => onError(error),
        );
      }, 0);
      return {
        on(_event, next, error, complete) {
          next({ bytesTransferred: 0, totalBytes: blob.size });
          onError = error;
          onComplete = complete;
        },
      };
    },
    async getMetadata() {
      if (cloudState.offline) throw Object.assign(new Error('offline'), { code: 'storage/retry-limit-exceeded' });
      const entry = cloudFiles.get(objectPath);
      if (!entry) throw Object.assign(new Error('not found'), { code: 'storage/object-not-found' });
      // 「アップロードは成功したがサイズが合わない」状況の再現
      return { size: cloudState.failVerify ? entry.bytes.byteLength + 1 : entry.bytes.byteLength };
    },
    async getDownloadURL() {
      if (cloudState.offline) throw Object.assign(new Error('offline'), { code: 'storage/retry-limit-exceeded' });
      if (!cloudFiles.has(objectPath)) {
        throw Object.assign(new Error('not found'), { code: 'storage/object-not-found' });
      }
      return `memory://${objectPath}`;
    },
    async delete() {
      if (cloudState.offline) throw Object.assign(new Error('offline'), { code: 'storage/retry-limit-exceeded' });
      if (!cloudFiles.has(objectPath)) {
        throw Object.assign(new Error('not found'), { code: 'storage/object-not-found' });
      }
      cloudState.deletes += 1;
      cloudFiles.delete(objectPath);
    },
  };
}

const TEST_UID = 'test-uid-1234';

// firebaseCloud を差し替える (実際の CDN 読み込みは行わない)
require.cache[require.resolve(path.join(outDir, 'firebaseCloud.js'))] = {
  id: path.join(outDir, 'firebaseCloud.js'),
  filename: path.join(outDir, 'firebaseCloud.js'),
  loaded: true,
  exports: {
    cloudRef: async (objectPath) => makeRef(objectPath),
    requireCloudUser: async () => ({ uid: TEST_UID, email: 'test@example.com' }),
    cloudErrorCode: (error) => String(error?.code ?? error?.message ?? ''),
    cloudErrorMessage: (error) => String(error?.message ?? 'error'),
    subscribeCloudAuth: () => () => {},
    cloudSignIn: async () => ({ uid: TEST_UID, email: 'test@example.com' }),
    cloudSignUp: async () => ({ uid: TEST_UID, email: 'test@example.com' }),
    cloudSignOut: async () => {},
    currentCloudUser: async () => ({ uid: TEST_UID, email: 'test@example.com' }),
    getCloudServices: async () => ({ auth: {}, storage: {} }),
  },
};

// ダウンロードは fetch を経由するため、memory:// を処理する
global.fetch = async (url) => {
  if (cloudState.offline) throw new TypeError('network error');
  if (cloudState.failDownload) throw new TypeError('network error');
  const objectPath = String(url).replace('memory://', '');
  const entry = cloudFiles.get(objectPath);
  if (!entry) {
    return { ok: false, status: 404, headers: new Map(), async blob() {} };
  }
  const bytes = cloudState.corruptDownload ? entry.bytes.slice(0, 2) : entry.bytes;
  cloudState.downloads += 1;
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(bytes.byteLength) },
    body: null,
    async blob() {
      return new Blob([bytes], { type: 'application/pdf' });
    },
  };
};

if (typeof navigator === 'undefined') {
  global.navigator = { onLine: true };
} else {
  Object.defineProperty(global.navigator, 'onLine', {
    configurable: true,
    get: () => !cloudState.offline,
  });
}

/* ------------------------------------------------------------------ */
/* 対象モジュール                                                      */
/* ------------------------------------------------------------------ */

const db = require(path.join(outDir, 'db.js'));
const repo = require(path.join(outDir, 'repository.js'));
const cloud = require(path.join(outDir, 'cloudStorage.js'));
const sync = require(path.join(outDir, 'cloudSync.js'));
const queue = require(path.join(outDir, 'cloudQueue.js'));
const backup = require(path.join(outDir, 'backup.js'));
const types = require(path.join(outDir, 'types.js'));

/* ------------------------------------------------------------------ */
/* 簡易テストランナー                                                  */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  [32m✓[0m ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  [31m✗[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n[1m${title}[0m`);
}

const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, ...new Array(200).fill(0x41),
]);

function pdfBlob(extra = 0) {
  const bytes = new Uint8Array(PDF_BYTES.length + extra);
  bytes.set(PDF_BYTES);
  return new Blob([bytes], { type: 'application/pdf' });
}

const DAY = 86_400_000;

/** 「最後に開いてから N 時間たった」状態を作る。 */
async function ageFile(fileId, hoursAgo) {
  const iso = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
  await db.tx('files', 'readwrite', async (t) => {
    const store = t.objectStore('files');
    const current = await new Promise((resolve, reject) => {
      const request = store.get(fileId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const request = store.put({
        ...current,
        lastOpenedAt: iso,
        createdAt: iso,
        // 端末内キャッシュも同じだけ過去にする (「開かないまま N 時間」の再現)
        ...(current.localCachedAt ? { localCachedAt: iso } : {}),
      });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

function settingsWith(patch) {
  return { ...types.DEFAULT_SETTINGS, cloudEnabled: true, ...patch };
}

async function autoSync(settings, options = {}) {
  const { files } = await db.loadAll();
  const targets = sync.pickUploadCandidates(files, settings, options);
  const results = [];
  for (const file of targets) {
    try {
      results.push(await cloud.uploadToCloud(TEST_UID, file.id));
    } catch {
      results.push('failed');
    }
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* テスト本体                                                          */
/* ------------------------------------------------------------------ */

async function main() {
  const snapshot = await repo.bootstrap();
  const folderId = snapshot.folders[0].id;

  /* 1. PDF を追加する ---------------------------------------------- */
  section('1. PDFを追加する');
  const added = await repo.addPdf(pdfBlob(), 'テスト資料.pdf', { parentId: folderId });
  await repo.updateFile(added.id, { tags: ['仕事', '重要'], memo: '会議用のメモ', isFavorite: true });
  const withMeta = await repo.readFileMeta(added.id);
  check('PDFが追加され本体が端末内にある', (await db.hasBlob(added.id)) === true);
  check('初期状態は local として扱われる', types.storageStateOf(withMeta) === 'local');
  check('タグ・メモ・お気に入りが保存される', withMeta.tags.length === 2 && withMeta.isFavorite === true);

  /* 2. 24時間経過した状態を再現する -------------------------------- */
  section('2. 24時間経過した状態をテスト用に再現する');
  const fresh = sync.pickUploadCandidates(
    (await db.loadAll()).files,
    settingsWith({ cloudIdleDays: 1 }),
  );
  check('追加直後は自動移動の対象にならない', fresh.length === 0);

  await ageFile(added.id, 25);
  const aged = sync.pickUploadCandidates(
    (await db.loadAll()).files,
    settingsWith({ cloudIdleDays: 1 }),
  );
  check('24時間経過すると対象になる', aged.length === 1 && aged[0].id === added.id);

  const disabled = sync.pickUploadCandidates(
    (await db.loadAll()).files,
    settingsWith({ cloudEnabled: false, cloudIdleDays: 1 }),
  );
  check('クラウド保管がOFFなら対象は0件（既定でアップロードしない）', disabled.length === 0);

  const neverMove = sync.pickUploadCandidates(
    (await db.loadAll()).files,
    settingsWith({ cloudIdleDays: 0 }),
  );
  check('「自動移動しない」を選ぶと自動では対象にならない', neverMove.length === 0);
  check(
    '「自動移動しない」でも手動実行なら対象になる',
    sync.pickUploadCandidates((await db.loadAll()).files, settingsWith({ cloudIdleDays: 0 }), {
      manual: true,
    }).length === 1,
  );

  /* 8. アップロード失敗時に端末内PDFが残る ------------------------- */
  section('8. アップロード失敗時に端末内PDFが残る');
  cloudState.failUpload = true;
  let threw = false;
  try {
    await cloud.uploadToCloud(TEST_UID, added.id);
  } catch {
    threw = true;
  }
  cloudState.failUpload = false;
  const afterFail = await repo.readFileMeta(added.id);
  check('アップロード失敗はエラーとして返る', threw);
  check('失敗しても端末内のPDF本体は残る', (await db.hasBlob(added.id)) === true);
  check('状態が error になり再試行できる', types.storageStateOf(afterFail) === 'error');
  check('失敗理由が記録される', Boolean(afterFail.cloudError));
  check('メタデータ（タグ・お気に入り）は失われない', afterFail.tags.length === 2 && afterFail.isFavorite);

  section('8-2. 存在確認・サイズ照合に失敗しても端末内PDFが残る');
  cloudState.failVerify = true;
  threw = false;
  try {
    await cloud.uploadToCloud(TEST_UID, added.id);
  } catch {
    threw = true;
  }
  cloudState.failVerify = false;
  check('サイズ不一致は失敗として扱う', threw);
  check('サイズ不一致でも端末内のPDF本体は残る', (await db.hasBlob(added.id)) === true);
  check(
    'クラウド保管済みとして記録しない',
    types.storageStateOf(await repo.readFileMeta(added.id)) !== 'cloud',
  );

  /* 3. アップロード完了後に端末のBlobだけが削除される --------------- */
  section('3. クラウドアップロード完了後に端末のBlobだけが削除される');
  const beforeSize = (await repo.readFileMeta(added.id)).size;
  const results = await autoSync(settingsWith({ cloudIdleDays: 1 }));
  const uploaded = await repo.readFileMeta(added.id);
  check('アップロードが成功する', results[0] === 'uploaded');
  check('端末内のPDF本体だけが削除される', (await db.hasBlob(added.id)) === false);
  check('メタデータは残る（一覧から消えない）', Boolean(uploaded));
  check('storageState が cloud になる', uploaded.storageState === 'cloud');
  check('cloudPath が本人のUID配下を指す', uploaded.cloudPath === `users/${TEST_UID}/pdf-cloud/${added.id}.pdf`);
  check('cloudUploadedAt / cloudSize が記録される', Boolean(uploaded.cloudUploadedAt) && uploaded.cloudSize > 0);
  check('表示用のサイズは変わらない', uploaded.size === beforeSize);
  check('ファイル名・フォルダー・タグ・メモ・お気に入りは変わらない',
    uploaded.name === 'テスト資料.pdf' &&
      uploaded.parentId === folderId &&
      uploaded.tags.join(',') === '仕事,重要' &&
      uploaded.memo === '会議用のメモ' &&
      uploaded.isFavorite === true);
  check('クラウドに実体がある', cloudFiles.has(uploaded.cloudPath));

  /* 4 / 5. 一覧から消えない・クラウドアイコン ----------------------- */
  section('4-5. 一覧からPDFが消えない / クラウド保管済みと分かる');
  const listed = (await db.loadAll()).files.filter((file) => !file.deletedAt);
  check('一覧（ごみ箱以外）にPDFが残っている', listed.some((file) => file.id === added.id));
  check('クラウド保管済みと判定できる（クラウドアイコンの表示条件）', types.isInCloud(uploaded) === true);

  /* 冪等性 ---------------------------------------------------------- */
  section('冪等性：同じ処理を何度実行しても壊れない');
  const uploadsBefore = cloudState.uploads;
  const again = await cloud.uploadToCloud(TEST_UID, added.id);
  check('保管済みPDFの再アップロードは行われない', again === 'skipped' && cloudState.uploads === uploadsBefore);
  const parallel = await Promise.all([
    cloud.fetchFromCloud(TEST_UID, added.id),
    cloud.fetchFromCloud(TEST_UID, added.id),
    cloud.fetchFromCloud(TEST_UID, added.id),
  ]);
  check('同時に3回開いてもダウンロードは1回だけ', cloudState.downloads === 1);
  check('同時実行でも同じ内容が返る', parallel.every((blob) => blob.size === parallel[0].size));

  /* 6. タップするとダウンロードされて開く -------------------------- */
  section('6. PDFをタップするとダウンロードされて開く');
  const cached = await repo.readFileMeta(added.id);
  check('端末内へキャッシュされる', (await db.hasBlob(added.id)) === true);
  check('localCachedAt が記録される', Boolean(cached.localCachedAt));
  check('クラウド上のファイルは消えない', cloudFiles.has(cached.cloudPath));
  const downloadsBefore = cloudState.downloads;
  await cloud.fetchFromCloud(TEST_UID, added.id);
  check('連続して開いても再ダウンロードしない', cloudState.downloads === downloadsBefore);

  section('6-2. キャッシュは24時間後にクラウドのみへ戻る');
  const notIdle = sync.pickEvictCandidates(
    (await db.loadAll()).files,
    settingsWith({ cloudIdleDays: 1 }),
  );
  check('開いた直後はキャッシュを消さない', notIdle.length === 0);
  await ageFile(added.id, 25);
  const evictable = sync.pickEvictCandidates(
    (await db.loadAll()).files,
    settingsWith({ cloudIdleDays: 1 }),
  );
  check('24時間使わなければ片付け対象になる', evictable.length === 1);
  await cloud.evictLocalCache(TEST_UID, added.id);
  const evicted = await repo.readFileMeta(added.id);
  check('端末内キャッシュだけ削除される', (await db.hasBlob(added.id)) === false);
  check('クラウド上のファイルは残る', cloudFiles.has(evicted.cloudPath));
  check('状態は cloud のまま', evicted.storageState === 'cloud');

  section('6-3. クラウド側を確認できないときはキャッシュを消さない');
  await cloud.fetchFromCloud(TEST_UID, added.id);
  cloudState.offline = true;
  const kept = await cloud.evictLocalCache(TEST_UID, added.id);
  cloudState.offline = false;
  check('確認が取れなければ端末内に残す', kept === false && (await db.hasBlob(added.id)) === true);
  await cloud.evictLocalCache(TEST_UID, added.id);

  /* 7. オフライン時のエラー ---------------------------------------- */
  section('7. オフライン時は適切なエラーになる');
  cloudState.offline = true;
  let offlineError = null;
  try {
    await cloud.fetchFromCloud(TEST_UID, added.id);
  } catch (error) {
    offlineError = error;
  }
  cloudState.offline = false;
  check('オフラインではエラーになる', offlineError !== null);
  check(
    'メッセージが案内どおり',
    offlineError?.message ===
      'このPDFはクラウドに保存されています。インターネットへ接続してから、もう一度開いてください。',
    offlineError?.message,
  );
  check('オフラインでも状態は cloud のまま（エラー固定しない）',
    (await repo.readFileMeta(added.id)).storageState === 'cloud');
  check('オフラインでもクラウド上のPDFは無事', cloudFiles.has(uploaded.cloudPath));

  section('7-2. 通信断・内容が壊れている場合');
  cloudState.corruptDownload = true;
  let corruptError = null;
  try {
    await cloud.fetchFromCloud(TEST_UID, added.id);
  } catch (error) {
    corruptError = error;
  }
  cloudState.corruptDownload = false;
  check('サイズが合わない取得は失敗させる', corruptError !== null);
  check('壊れたデータを端末へ保存しない', (await db.hasBlob(added.id)) === false);

  /* 9. 復元後もフォルダー・タグ・メモが維持される ------------------- */
  section('9. 端末へ戻してもフォルダー・タグ・メモが維持される');
  await cloud.fetchFromCloud(TEST_UID, added.id);
  const restored = await repo.readFileMeta(added.id);
  const blob = await repo.readBlob(added.id);
  check('PDF本体を取り戻せる', blob.size === restored.size);
  check('中身が PDF である', (await blob.slice(0, 5).text()) === '%PDF-');
  check('フォルダーが変わらない', restored.parentId === folderId);
  check('タグが変わらない', restored.tags.join(',') === '仕事,重要');
  check('メモが変わらない', restored.memo === '会議用のメモ');
  check('お気に入りが変わらない', restored.isFavorite === true);
  check('ファイル名が変わらない', restored.name === 'テスト資料.pdf');

  /* 10. ごみ箱 ------------------------------------------------------ */
  section('10. ごみ箱へ移動しても消えず、復元できる');
  await cloud.evictLocalCache(TEST_UID, added.id);
  await repo.trashFile(added.id);
  const trashed = await repo.readFileMeta(added.id);
  check('ごみ箱へ移動できる', Boolean(trashed.deletedAt));
  check('ごみ箱へ移してもクラウド上のPDFは保持される', cloudFiles.has(trashed.cloudPath));
  check('クラウドの保存先情報も保持される', trashed.storageState === 'cloud');

  await repo.restoreFile(added.id);
  const unTrashed = await repo.readFileMeta(added.id);
  check('ごみ箱から復元できる', !unTrashed.deletedAt);
  check('復元後も元のフォルダーに戻る', unTrashed.parentId === folderId);
  check('復元後もクラウドから開ける', types.isInCloud(unTrashed) === true);
  const afterRestore = await cloud.fetchFromCloud(TEST_UID, added.id);
  check('実際に取得して開ける', afterRestore.size === unTrashed.size);
  await cloud.evictLocalCache(TEST_UID, added.id);

  /* 11. 完全削除のときだけクラウドから削除される -------------------- */
  section('11. 完全削除のときだけクラウドから削除される');
  const secondary = await repo.addPdf(pdfBlob(10), '別の資料.pdf', { parentId: folderId });
  await ageFile(secondary.id, 30);
  await autoSync(settingsWith({ cloudIdleDays: 1 }));
  const secondaryMeta = await repo.readFileMeta(secondary.id);
  check('2件目もクラウドへ移動できる', secondaryMeta.storageState === 'cloud');

  await repo.trashFile(secondary.id);
  await cloud.drainDeleteQueue(TEST_UID);
  check('ごみ箱へ移しただけではクラウドから消えない', cloudFiles.has(secondaryMeta.cloudPath));

  const deletesBefore = cloudState.deletes;
  await repo.purgeFile(secondary.id);
  const queued = await queue.readDeleteQueue();
  check('完全削除でクラウド削除が予約される', queued.some((task) => task.path === secondaryMeta.cloudPath));
  await cloud.drainDeleteQueue(TEST_UID);
  check('完全削除するとクラウドからも消える', !cloudFiles.has(secondaryMeta.cloudPath));
  check('削除が実行された', cloudState.deletes === deletesBefore + 1);
  check('端末内のメタデータも消える', (await repo.readFileMeta(secondary.id)) === undefined);
  check('待ち行列が片付く', (await queue.readDeleteQueue()).length === 0);
  check('他のPDFのクラウド上の実体は無事', cloudFiles.has(unTrashed.cloudPath));

  section('11-2. クラウド削除に失敗しても記録され、次回に再試行される');
  const third = await repo.addPdf(pdfBlob(20), '三つ目.pdf', { parentId: folderId });
  await ageFile(third.id, 30);
  await autoSync(settingsWith({ cloudIdleDays: 1 }));
  const thirdMeta = await repo.readFileMeta(third.id);
  await repo.purgeFile(third.id);
  cloudState.offline = true;
  await cloud.drainDeleteQueue(TEST_UID);
  cloudState.offline = false;
  const pending = await queue.readDeleteQueue();
  check('失敗した削除は待ち行列に残る', pending.some((task) => task.path === thirdMeta.cloudPath));
  check('失敗理由が記録される', pending.some((task) => task.attempts > 0 && task.lastError));
  await cloud.drainDeleteQueue(TEST_UID);
  check('オンライン復帰後に再試行して削除される', !cloudFiles.has(thirdMeta.cloudPath));
  check('二重削除の要求は残らない', (await queue.readDeleteQueue()).length === 0);

  section('11-3. まだ使われている保存先は削除しない');
  await queue.enqueueCloudDeletes([{ path: unTrashed.cloudPath, uid: TEST_UID }]);
  await cloud.drainDeleteQueue(TEST_UID);
  check('端末内で参照中のクラウドファイルは消さない', cloudFiles.has(unTrashed.cloudPath));

  section('11-4. コピーは独立した保存先を持つ（片方の削除で両方消えない）');
  await cloud.fetchFromCloud(TEST_UID, added.id);
  const copy = await repo.copyFile(added.id, folderId);
  check('コピーはクラウドの保存先を引き継がない', !copy.cloudPath && copy.storageState === 'local');
  check('コピー元のクラウド上の実体は無事', cloudFiles.has(unTrashed.cloudPath));
  await repo.purgeFile(copy.id);
  await cloud.drainDeleteQueue(TEST_UID);
  check('コピーを完全削除してもコピー元のクラウドPDFは残る', cloudFiles.has(unTrashed.cloudPath));

  /* 中断からの復帰 -------------------------------------------------- */
  section('中断・二重実行への耐性');
  await repo.patchCloudState(added.id, { storageState: 'uploading' });
  await cloud.recoverInterrupted();
  const recovered = await repo.readFileMeta(added.id);
  check('送信中に終了した場合は未処理へ戻す', recovered.storageState === 'local' || recovered.storageState === 'cloud');
  check('端末内のPDF本体は削除されない', (await db.hasBlob(added.id)) === true);

  await repo.patchCloudState(added.id, {
    storageState: 'cloud',
    cloudPath: unTrashed.cloudPath,
    cloudUploadedAt: unTrashed.cloudUploadedAt,
    cloudSize: unTrashed.cloudSize,
    localCachedAt: undefined,
  });
  await cloud.recoverInterrupted();
  const reconciled = await repo.readFileMeta(added.id);
  check('保存先記録後に中断した場合はキャッシュ扱いにする', Boolean(reconciled.localCachedAt));
  check('この場合もPDFは消えない', (await db.hasBlob(added.id)) === true);

  /* ZIPバックアップ ------------------------------------------------- */
  section('既存機能：ZIPバックアップと復元');
  await cloud.evictLocalCache(TEST_UID, added.id);
  const local = await repo.addPdf(pdfBlob(30), '端末内だけの資料.pdf', { parentId: folderId });
  const archive = await backup.createBackup(types.DEFAULT_SETTINGS);
  check('バックアップZIPを作成できる', archive.blob.size > 0);
  const beforeRestore = await db.loadAll();
  const restoreResult = await backup.restoreBackup(archive.blob, 'replace');
  const afterZip = await db.loadAll();
  check('クラウド保管中のPDFもバックアップに含まれる', restoreResult.files === beforeRestore.files.length);
  const zipCloud = afterZip.files.find((file) => file.id === added.id);
  const zipLocal = afterZip.files.find((file) => file.id === local.id);
  check('復元後もクラウド保管中のPDFが一覧に残る', Boolean(zipCloud) && zipCloud.storageState === 'cloud');
  check('復元後もクラウドの保存先を保持する', zipCloud.cloudPath === unTrashed.cloudPath);
  check('復元後もタグ・メモが維持される', zipCloud.tags.join(',') === '仕事,重要' && zipCloud.memo === '会議用のメモ');
  check('端末内のPDFは本体ごと復元される', Boolean(zipLocal) && (await db.hasBlob(local.id)) === true);
  const reopened = await cloud.fetchFromCloud(TEST_UID, added.id);
  check('復元後もクラウドから取得して開ける', reopened.size > 0);

  /* 保持期間切れ ---------------------------------------------------- */
  section('ごみ箱の保持期間が終了したらクラウド上も削除する');
  const expiring = await repo.addPdf(pdfBlob(40), '期限切れ.pdf', { parentId: folderId });
  await ageFile(expiring.id, 30);
  await autoSync(settingsWith({ cloudIdleDays: 1 }));
  const expiringMeta = await repo.readFileMeta(expiring.id);
  await repo.trashFile(expiring.id);
  await db.tx('files', 'readwrite', async (t) => {
    const store = t.objectStore('files');
    const current = await new Promise((resolve, reject) => {
      const request = store.get(expiring.id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const request = store.put({
        ...current,
        deletedAt: new Date(Date.now() - 40 * DAY).toISOString(),
      });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
  await repo.purgeExpiredTrash(30);
  await cloud.drainDeleteQueue(TEST_UID);
  check('保持期間が過ぎたらクラウド上のPDFも削除される', !cloudFiles.has(expiringMeta.cloudPath));

  /* すべて端末へ戻す ------------------------------------------------ */
  section('すべてのクラウドPDFを端末へ戻す');
  const result = await cloud.restoreAllToDevice(TEST_UID);
  const back = await repo.readFileMeta(added.id);
  check('端末へ戻せる', result.restored >= 1 && result.failed === 0);
  check('PDF本体が端末内にある', (await db.hasBlob(added.id)) === true);
  check('状態が local に戻る', back.storageState === 'local' && !back.cloudPath);
  check('端末へ保存できたあとにクラウド側の削除を予約する',
    (await queue.readDeleteQueue()).some((task) => task.path === unTrashed.cloudPath));
  await cloud.drainDeleteQueue(TEST_UID);
  check('クラウド側も片付く', !cloudFiles.has(unTrashed.cloudPath));
  check('端末内のPDFはそのまま残る', (await db.hasBlob(added.id)) === true);

  /* 集計 ------------------------------------------------------------ */
  section('設定画面に出す集計');
  const stats = cloud.summarize((await db.loadAll()).files);
  check('クラウド保管件数を数えられる', typeof stats.cloudCount === 'number');
  check('クラウド使用量を集計できる', typeof stats.cloudBytes === 'number');
  check('同期エラー件数を集計できる', typeof stats.errorCount === 'number');

  /* まとめ ---------------------------------------------------------- */
  console.log(`\n[1m結果: ${passed} 件成功 / ${failed} 件失敗[0m`);
  if (failed > 0) {
    console.log('失敗した項目:');
    for (const label of failures) console.log(`  - ${label}`);
    process.exitCode = 1;
  }
  fs.rmSync(outDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

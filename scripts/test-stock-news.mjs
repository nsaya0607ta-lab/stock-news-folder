/* eslint-disable no-console */
/**
 * 株式ニュース機能の端末内処理を、実コードで検証する。
 *
 *   node scripts/test-stock-news.mjs
 *
 * src/lib/**\/*.ts をその場で ESM へコンパイルし、IndexedDB を fake-indexeddb に
 * 差し替えて、購読設定・レポート保存・データ移行の実装をそのまま動かす。
 * 外部APIは呼ばない。
 */
import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'node_modules', '.cache', 'stock-news-test');

/* ------------------------------------------------------------------ */
/* 対象コードのコンパイル                                              */
/* ------------------------------------------------------------------ */

// src/lib/server は「@/」別名を使うサーバー専用コードなので、この検証では対象外にする。
const SKIP_DIRS = new Set(['server']);

function listTs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : listTs(full);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

execFileSync(
  process.execPath,
  [
    path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    ...listTs(path.join(root, 'src', 'lib')),
    '--outDir',
    outDir,
    '--rootDir',
    path.join(root, 'src', 'lib'),
    '--module',
    'esnext',
    '--target',
    'es2022',
    '--moduleResolution',
    'bundler',
    '--skipLibCheck',
    '--lib',
    'es2022,dom',
  ],
  { stdio: 'inherit' },
);

// 素のESMとして読み込めるよう、拡張子の無い相対importへ .js を足す。
function fixExtensions(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      fixExtensions(full);
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    const source = fs.readFileSync(full, 'utf8').replace(
      /(from\s+['"])(\.[^'"]*?)(['"])/g,
      (match, head, specifier, tail) =>
        /\.(mjs|js|json)$/.test(specifier) ? match : `${head}${specifier}.js${tail}`,
    );
    fs.writeFileSync(full, source);
  }
}

// 共通処理（.mjs）は tsc の対象外なので、そのまま複製する。
const coreSrc = path.join(root, 'src', 'lib', 'stock', 'core');
const coreOut = path.join(outDir, 'stock', 'core');
fs.mkdirSync(coreOut, { recursive: true });
for (const name of fs.readdirSync(coreSrc)) {
  if (name.endsWith('.mjs')) fs.copyFileSync(path.join(coreSrc, name), path.join(coreOut, name));
}
fixExtensions(outDir);
fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'module' }));

const load = (name) => import(pathToFileURL(path.join(outDir, name)).href);

const repo = await load('repository.js');
const store = await load('stock/store.js');
const migrate = await load('stock/migrate.js');
const folders = await load('stock/folders.js');
const { ROOT_ID } = await load('types.js');
const { activeFiles, toParentKey } = await load('tree.js');

/* ------------------------------------------------------------------ */
/* 補助                                                                */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];

async function check(label, run) {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${label}`);
  } catch (error) {
    failures.push(label);
    console.error(`FAIL ${label}: ${error?.message ?? error}`);
  }
}

/** 最小限のPDFバイト列（repo.isPdf を通す）。 */
function pdfBlob(text = 'dummy') {
  return new Blob([`%PDF-1.4\n${text}\n%%EOF\n`], { type: 'application/pdf' });
}

function makeReport(ticker, date, overrides = {}) {
  return {
    reportId: `${ticker}_${date.replaceAll('-', '')}`,
    ticker,
    companyName: `${ticker} Inc.`,
    reportDate: date,
    periodFrom: date,
    periodTo: date,
    generatedAt: new Date().toISOString(),
    fileName: `${ticker}_日次レポート_${date.replaceAll('-', '')}.pdf`,
    language: 'ja',
    detail: 'standard',
    articleCount: 1,
    headline: '見出し',
    summary: '要約',
    priceComment: '',
    importance: 2,
    sentiment: 'neutral',
    articles: [
      {
        title: '記事',
        summary: '本文',
        keyPoints: [],
        priceImpact: '',
        publishedAt: date,
        fetchedAt: new Date().toISOString(),
        sourceName: 'Reuters',
        sourceHost: 'reuters.com',
        url: 'https://reuters.com/a',
        ticker,
        category: 'earnings',
        importance: 2,
        sentiment: 'neutral',
        sourceTier: 3,
        dedupeHash: 'aaaabbbb',
      },
    ],
    watchItems: [],
    uncertainties: [],
    nextEvent: { date: '', title: '' },
    sources: [],
    quote: null,
    fetchedCount: 1,
    acceptedCount: 1,
    source: 'scheduled',
    status: 'ready',
    version: 1,
    isRead: false,
    isFavorite: false,
    savedAt: new Date().toISOString(),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* 検証                                                                */
/* ------------------------------------------------------------------ */

await repo.bootstrap();

await check('銘柄を追加すると、同名の銘柄フォルダーが作られる', async () => {
  const folder = await folders.ensureTickerFolder('NVDA');
  const saved = await store.saveSubscription({
    ticker: 'nvda',
    companyName: 'NVIDIA Corporation',
    folderId: folder.id,
    folderName: folder.name,
    time: '08:00',
  });
  assert.equal(saved.ticker, 'NVDA');
  assert.equal(saved.time, '08:00');
  assert.equal(saved.frequency, 'daily');
  assert.equal(saved.enabled, true);
  assert.ok(saved.nextRunAt, '次回取得予定が計算される');

  const snapshot = await repo.refresh();
  const created = snapshot.folders.filter((entry) => entry.name === 'NVDA' && !entry.deletedAt);
  assert.equal(created.length, 1, 'NVDAフォルダーが1つだけ作られる');
});

await check('同じ銘柄を追加し直してもフォルダーも購読も増えない', async () => {
  const folder = await folders.ensureTickerFolder('NVDA');
  await store.saveSubscription({
    ticker: 'NVDA',
    companyName: 'NVIDIA Corporation',
    folderId: folder.id,
    folderName: folder.name,
  });
  const list = await store.listSubscriptions();
  assert.equal(list.filter((entry) => entry.ticker === 'NVDA').length, 1);
  const snapshot = await repo.refresh();
  assert.equal(snapshot.folders.filter((entry) => entry.name === 'NVDA' && !entry.deletedAt).length, 1);
});

await check('不正なティッカーは保存されない', async () => {
  await assert.rejects(() => store.saveSubscription({ ticker: 'not a ticker!!' }));
  const list = await store.listSubscriptions();
  assert.ok(list.every((entry) => /^[A-Z][A-Z0-9.-]*$/.test(entry.ticker)));
});

await check('取得を停止した銘柄は次回予定を持たない', async () => {
  const patched = await store.patchSubscription('NVDA', { enabled: false });
  assert.equal(patched.enabled, false);
  assert.equal(patched.nextRunAt, undefined);
  await store.patchSubscription('NVDA', { enabled: true });
});

await check('同じ日・同じ銘柄のレポートは重複して増えない', async () => {
  const folder = await folders.ensureTickerFolder('NVDA');
  const first = makeReport('NVDA', '2026-08-02', { folderId: folder.id });
  await store.saveReport(first);
  await store.saveReport({ ...first });
  const list = await store.listReports();
  assert.equal(list.filter((entry) => entry.reportId === 'NVDA_20260802').length, 1);
});

await check('作り直すと版が上がり、未読へ戻る／お気に入りは保持される', async () => {
  await store.patchReport('NVDA_20260802', { isRead: true, isFavorite: true });
  await store.saveReport(makeReport('NVDA', '2026-08-02', { version: 2, headline: '新しい見出し' }));
  const list = await store.listReports();
  const entry = list.find((row) => row.reportId === 'NVDA_20260802');
  assert.equal(entry.headline, '新しい見出し');
  assert.equal(entry.isRead, false, '内容が変わったら未読へ戻す');
  assert.equal(entry.isFavorite, true, 'お気に入りは引き継ぐ');
  assert.equal(list.filter((row) => row.reportId === 'NVDA_20260802').length, 1);
});

await check('同じ名前のPDFは上書きされ、フォルダー内で増えない', async () => {
  const folder = await folders.ensureTickerFolder('NVDA');
  const name = 'NVDA_日次レポート_20260802.pdf';
  await repo.addPdf(pdfBlob('v1'), name, { parentId: folder.id, onDuplicate: 'overwrite', origin: 'report' });
  await repo.addPdf(pdfBlob('v2 longer'), name, { parentId: folder.id, onDuplicate: 'overwrite', origin: 'report' });
  const snapshot = await repo.refresh();
  const inFolder = activeFiles(snapshot.files).filter(
    (file) => toParentKey(file.parentId) === folder.id && file.name === name,
  );
  assert.equal(inFolder.length, 1, 'PDFは1件のまま');
});

await check('購読を削除してもレポートを残す選択ができる', async () => {
  await store.saveSubscription({ ticker: 'RKLB', companyName: 'Rocket Lab Corporation', folderId: '', folderName: 'RKLB' });
  await store.saveReport(makeReport('RKLB', '2026-08-02'));
  await store.removeSubscription('RKLB');
  const subs = await store.listSubscriptions();
  assert.ok(!subs.some((entry) => entry.ticker === 'RKLB'));
  const reports = await store.listReports();
  assert.ok(reports.some((entry) => entry.ticker === 'RKLB'), 'レポートは残る');
});

await check('レポートも削除する選択では、購読とレポートの両方が消える', async () => {
  const removed = await store.removeReportsOfTicker('RKLB');
  assert.equal(removed.length, 1);
  const reports = await store.listReports();
  assert.ok(!reports.some((entry) => entry.ticker === 'RKLB'));
});

await check('端末から消えたPDFへの参照は自動で外れる', async () => {
  await store.saveReport(makeReport('AMD', '2026-08-02', { localFileId: 'file-missing' }));
  const changed = await store.detachMissingFiles(new Set(['file-exists']));
  assert.ok(changed >= 1);
  const entry = (await store.listReports()).find((row) => row.reportId === 'AMD_20260802');
  assert.equal(entry.localFileId, undefined);
});

await check('実行履歴と通知が記録される', async () => {
  await store.saveRun({
    runId: 'NVDA_20260802_manual',
    ticker: 'NVDA',
    companyName: 'NVIDIA Corporation',
    runDate: '2026-08-02',
    status: 'success',
    trigger: 'manual',
    startedAt: new Date().toISOString(),
    fetchedCount: 5,
    acceptedCount: 3,
    reportResult: 'ニュース 3 件を採用',
    saveResult: '「NVDA」へ保存',
  });
  const runs = await store.listRuns();
  assert.equal(runs[0].runId, 'NVDA_20260802_manual');
  assert.equal(runs[0].acceptedCount, 3);

  await store.addNotification({ ticker: 'NVDA', title: '作成しました', body: '重要ニュース3件' });
  const notices = await store.listNotifications();
  assert.equal(notices[0].isRead, false);
  await store.markNotificationsRead();
  assert.equal((await store.listNotifications())[0].isRead, true);
});

/* 移行 ------------------------------------------------------------- */

await check('移行：既存IONQレポートがIONQフォルダーへ移り、件数が一致する', async () => {
  // 移行前の状態を作る：ルート直下の旧IONQレポートと、株式と無関係なフォルダー
  const legacy = await repo.createFolder(ROOT_ID, '仕事');
  await repo.addPdf(pdfBlob('ionq1'), '投資_IQ_20260801.pdf', {
    parentId: ROOT_ID,
    onDuplicate: 'rename',
    origin: 'report',
  });
  await repo.addPdf(pdfBlob('ionq2'), '投資_IQ_20260731.pdf', {
    parentId: legacy.id,
    onDuplicate: 'rename',
    origin: 'report',
  });
  await repo.addPdf(pdfBlob('manual'), '手順書.pdf', {
    parentId: ROOT_ID,
    onDuplicate: 'rename',
    origin: 'file',
  });

  const before = activeFiles((await repo.refresh()).files).length;
  const result = await migrate.runStockMigration(0);

  assert.equal(result.ran, true);
  assert.equal(result.countsMatch, true, `件数が一致する（${result.filesBefore} → ${result.filesAfter}）`);
  assert.equal(result.filesBefore, before);
  assert.ok(result.movedReports >= 2, 'IONQレポートが移動する');
  assert.ok(result.createdSubscriptions.includes('IONQ'), 'IONQの購読が作られる');

  const snapshot = await repo.refresh();
  const ionq = snapshot.folders.find((entry) => entry.name === 'IONQ' && !entry.deletedAt);
  assert.ok(ionq, 'IONQフォルダーができる');
  const inIonq = activeFiles(snapshot.files).filter((file) => toParentKey(file.parentId) === ionq.id);
  assert.equal(inIonq.length, 2, '既存のIONQレポート2件がIONQフォルダーにある');

  const archive = snapshot.folders.find(
    (entry) => entry.name === folders.ARCHIVE_FOLDER_NAME && !entry.deletedAt,
  );
  assert.ok(archive, '旧PDFアーカイブができる');
  const archivedManual = activeFiles(snapshot.files).find((file) => file.name === '手順書.pdf');
  assert.equal(toParentKey(archivedManual.parentId), archive.id, '株式と無関係なPDFはアーカイブへ');
  const movedFolder = snapshot.folders.find((entry) => entry.name === '仕事');
  assert.equal(toParentKey(movedFolder.parentId), archive.id, '既存フォルダーはアーカイブ配下へ');
});

await check('移行：既存レポートがレポート一覧に登録され、PDFは削除されない', async () => {
  const reports = await store.listReports();
  assert.ok(reports.some((entry) => entry.reportId === 'IONQ_20260801'));
  assert.ok(reports.some((entry) => entry.reportId === 'IONQ_20260731'));
  const snapshot = await repo.refresh();
  assert.equal(snapshot.files.filter((file) => file.deletedAt).length, 0, '削除されたPDFは無い');
});

await check('移行は一度だけ実行される', async () => {
  const again = await migrate.runStockMigration(migrate.STOCK_MIGRATION_VERSION);
  assert.equal(again.ran, false);
});

/* ------------------------------------------------------------------ */

console.log(`\n${passed} 件成功 / ${failures.length} 件失敗`);
if (failures.length > 0) {
  console.error(`失敗: ${failures.join(', ')}`);
  process.exit(1);
}

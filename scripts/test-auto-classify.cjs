/* eslint-disable no-console */
/**
 * 自動分類ルールと「画像からPDFを作成」のふるまいを実コードで検証する。
 *
 *   node scripts/test-auto-classify.cjs
 *
 * src/lib/*.ts をその場で CommonJS へコンパイルし、
 *   - IndexedDB … fake-indexeddb
 *   - canvas / createImageBitmap … このファイル内の最小実装
 * に差し替えて、実際の classifyRules / classify / classifyRun / imageToPdf を動かす。
 *
 * 画面を触らずに、仕様の「動作確認」項目をそのまま確かめるのが目的。
 */
require('fake-indexeddb/auto');

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

/* ------------------------------------------------------------------ */
/* 対象コードのコンパイル                                              */
/* ------------------------------------------------------------------ */

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'node_modules', '.cache', 'pdf-classify-test');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

execFileSync(
  process.execPath,
  [
    path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    ...fs
      .readdirSync(path.join(root, 'src', 'lib'))
      .map((name) => path.join(root, 'src', 'lib', name)),
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
/* 画像まわりのブラウザー API を最小限だけ用意する                      */
/* ------------------------------------------------------------------ */

/** 指定した大きさのベースライン JPEG を組み立てる (中身は単色相当)。 */
function makeJpeg(width, height) {
  const size = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
  const dqt = Buffer.concat([Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00]), Buffer.alloc(64, 16)]);
  const sof = Buffer.concat([
    Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08]),
    size(height),
    size(width),
    Buffer.from([0x01, 0x01, 0x11, 0x00]),
  ]);
  const dcBits = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
  const dcVals = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const dht1 = Buffer.concat([
    Buffer.from([0xff, 0xc4]),
    size(2 + 1 + 16 + dcVals.length),
    Buffer.from([0x00]),
    Buffer.from(dcBits),
    Buffer.from(dcVals),
  ]);
  const acBits = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
  const acVals = Array.from({ length: 0xa2 }, (_, index) => (index % 250) + 1);
  const dht2 = Buffer.concat([
    Buffer.from([0xff, 0xc4]),
    size(2 + 1 + 16 + acVals.length),
    Buffer.from([0x10]),
    Buffer.from(acBits),
    Buffer.from(acVals),
  ]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    dqt,
    sof,
    dht1,
    dht2,
    sos,
    Buffer.from([0x54, 0xff, 0xd9]),
  ]);
}

/** Blob → 原寸。createImageBitmap の代わりに使う。 */
const imageSizes = new Map();
/** デコードに失敗させたい Blob。 */
const brokenImages = new Set();

function makeImageBlob(width, height, { broken = false, type = 'image/jpeg' } = {}) {
  const blob = new Blob([makeJpeg(width, height)], { type });
  imageSizes.set(blob, { width, height });
  if (broken) brokenImages.add(blob);
  return blob;
}

globalThis.createImageBitmap = async (blob) => {
  if (brokenImages.has(blob)) throw new Error('decode failed');
  const size = imageSizes.get(blob);
  if (!size) throw new Error('unknown image');
  return { width: size.width, height: size.height, close() {} };
};

/** canvas は「大きさを覚えて、その大きさの JPEG を返す」だけの最小実装。 */
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') return {};
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: '',
        fillRect() {},
        drawImage() {},
        translate() {},
        rotate() {},
      }),
      toBlob(callback) {
        callback(new Blob([makeJpeg(canvas.width, canvas.height)], { type: 'image/jpeg' }));
      },
    };
    return canvas;
  },
};
globalThis.URL.createObjectURL = () => 'blob:test';
globalThis.URL.revokeObjectURL = () => {};

/* ------------------------------------------------------------------ */
/* 読み込み                                                            */
/* ------------------------------------------------------------------ */

const load = (name) => require(path.join(outDir, name));

const repo = load('repository.js');
const rulesLib = load('classifyRules.js');
const classify = load('classify.js');
const classifyRun = load('classifyRun.js');
const imageToPdf = load('imageToPdf.js');
const owner = load('owner.js');
const types = load('types.js');
const { ROOT_ID, UNSORTED_ID } = types;

let failures = 0;
const results = [];

async function test(name, run) {
  try {
    await run();
    results.push(`  OK   ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`  NG   ${name}\n       ${error && error.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 準備                                                                */
/* ------------------------------------------------------------------ */

const pdfBytes = Buffer.from('%PDF-1.4\n%%EOF\n');
const pdfBlob = (size = 1024) =>
  new Blob([Buffer.concat([pdfBytes, Buffer.alloc(Math.max(0, size - pdfBytes.length))])], {
    type: 'application/pdf',
  });

let folderIds = {};

async function setup() {
  await repo.bootstrap();
  const receipts = await repo.createFolder(ROOT_ID, '書類');
  const inner = await repo.createFolder(receipts.id, '領収書');
  const manuals = await repo.createFolder(ROOT_ID, 'マニュアル');
  folderIds = { receipts: receipts.id, inner: inner.id, manuals: manuals.id };
}

async function addPdf(name, options = {}) {
  return repo.addPdf(pdfBlob(options.size ?? 1024), name, {
    parentId: options.parentId ?? UNSORTED_ID,
    pageCount: options.pageCount,
    origin: options.origin,
    sourceFormats: options.sourceFormats,
  });
}

function ruleInput(overrides) {
  return {
    name: 'テスト',
    match: 'any',
    conditions: [],
    destFolderId: folderIds.inner,
    autoMove: true,
    confirmBeforeMove: false,
    enabled: true,
    ...overrides,
  };
}

const condition = (field, extra = {}) => ({ id: `c-${field}-${Math.random()}`, field, ...extra });

const options = (rules, strategy = 'highest') => ({ rules, strategy, textPages: 3 });

/* ------------------------------------------------------------------ */
/* 自動分類ルール                                                      */
/* ------------------------------------------------------------------ */

async function clearRules() {
  for (const rule of await rulesLib.listRules()) await rulesLib.deleteRule(rule.id);
}

async function runClassifyTests() {
  await test('1. ユーザーが自動分類ルールを作成できる', async () => {
    await clearRules();
    const saved = await rulesLib.saveRule(
      ruleInput({
        name: '領収書を自動分類',
        conditions: [
          condition('nameContains', { text: '領収書' }),
          condition('contentContains', { text: '領収金額' }),
        ],
      }),
    );
    assert.equal(saved.name, '領収書を自動分類');
    assert.equal(saved.priority, 1);
    const list = await rulesLib.listRules();
    assert.equal(list.length, 1);
    assert.equal(list[0].conditions.length, 2);

    // 編集しても ID と作成日時は変わらない
    const edited = await rulesLib.saveRule({ ...ruleInput(), id: saved.id, name: '領収書', conditions: saved.conditions });
    assert.equal(edited.id, saved.id);
    assert.equal(edited.createdAt, saved.createdAt);
    assert.equal((await rulesLib.listRules()).length, 1);
  });

  await test('2. ファイル名を条件に分類できる', async () => {
    await clearRules();
    const rule = await rulesLib.saveRule(
      ruleInput({ name: '領収書', conditions: [condition('nameContains', { text: '領収書' })] }),
    );
    const hit = await addPdf('2026年7月_医療費領収書.pdf');
    const miss = await addPdf('会議メモ.pdf');

    const plan = await classifyRun.planFile(hit, options([rule]));
    assert.ok(plan, '一致するはず');
    assert.equal(plan.rule.id, rule.id);
    assert.equal(plan.toParentId, folderIds.inner);
    assert.equal(await classifyRun.planFile(miss, options([rule])), null);

    const record = await classifyRun.applyPlan(plan);
    const moved = await repo.readFileMeta(hit.id);
    assert.equal(moved.parentId, folderIds.inner);
    assert.equal(moved.classifiedByRuleId, rule.id);
    assert.equal(record.ruleName, '領収書');
  });

  await test('3. 複数条件を組み合わせられる（すべて / いずれか）', async () => {
    await clearRules();
    const file = await addPdf('請求書2026.pdf', { pageCount: 12, size: 3 * 1024 * 1024 });

    const any = await rulesLib.saveRule(
      ruleInput({
        name: 'いずれか',
        match: 'any',
        conditions: [
          condition('nameContains', { text: '領収書' }),
          condition('pageCount', { compare: 'atLeast', min: 10 }),
        ],
      }),
    );
    assert.equal(await classify.matchRule(any, { file }), true, 'いずれか一致で真');

    const all = await rulesLib.saveRule(
      ruleInput({
        name: 'すべて',
        match: 'all',
        conditions: [
          condition('nameContains', { text: '請求書' }),
          condition('pageCount', { compare: 'atLeast', min: 10 }),
          condition('size', { compare: 'atMost', max: 5 }),
        ],
      }),
    );
    assert.equal(await classify.matchRule(all, { file }), true, 'すべて一致で真');

    const allMiss = { ...all, conditions: [...all.conditions, condition('nameContains', { text: '領収書' })] };
    assert.equal(await classify.matchRule(allMiss, { file }), false, '1つ外れたら偽');
  });

  await test('4. ルールの優先順位が正しく反映される', async () => {
    await clearRules();
    const low = await rulesLib.saveRule(
      ruleInput({ name: '後', conditions: [condition('nameContains', { text: '書' })], destFolderId: folderIds.manuals }),
    );
    const high = await rulesLib.saveRule(
      ruleInput({ name: '先', conditions: [condition('nameContains', { text: '領収書' })] }),
    );
    // 作成順は 後 → 先。優先順位を入れ替える。
    await rulesLib.moveRulePriority(high.id, 'up');
    const ordered = await rulesLib.listRules();
    assert.deepEqual(ordered.map((rule) => rule.name), ['先', '後']);
    assert.deepEqual(ordered.map((rule) => rule.priority), [1, 2]);

    const file = await addPdf('医療費領収書.pdf');
    const highest = await classifyRun.planFile(file, options(ordered, 'highest'));
    assert.equal(highest.rule.name, '先');
    assert.equal(highest.matches.length, 2, '両方に一致している');

    const first = await classifyRun.planFile(file, options(ordered, 'first'));
    assert.equal(first.matches.length, 1, '最初の一致で判定を打ち切る');

    const ask = await classifyRun.planFile(file, options(ordered, 'ask'));
    assert.equal(ask.needsConfirm, true, '複数一致は確認する');
  });

  await test('5. 分類後に元へ戻せる', async () => {
    await clearRules();
    const rule = await rulesLib.saveRule(
      ruleInput({ name: '戻す確認', conditions: [condition('nameContains', { text: '契約' })] }),
    );
    const file = await addPdf('契約書.pdf', { parentId: folderIds.manuals });
    const plan = await classifyRun.planFile(file, options([rule]));
    const record = await classifyRun.applyPlan(plan);
    assert.equal((await repo.readFileMeta(file.id)).parentId, folderIds.inner);

    await classifyRun.undoClassification(record);
    const restored = await repo.readFileMeta(file.id);
    assert.equal(restored.parentId, folderIds.manuals, '元のフォルダーへ戻る');
    assert.equal(restored.classifiedByRuleId, undefined, '分類の記録も消える');
  });

  await test('6. 既存PDFへルールを一括適用できる（失敗しても止まらない）', async () => {
    await clearRules();
    const rule = await rulesLib.saveRule(
      ruleInput({ name: '一括', conditions: [condition('nameContains', { text: '一括対象' })] }),
    );
    const targets = [];
    for (let index = 0; index < 5; index += 1) {
      targets.push(await addPdf(`一括対象${index}.pdf`, { parentId: folderIds.manuals }));
    }
    targets.push(await addPdf('対象外.pdf', { parentId: folderIds.manuals }));

    const { plans, failures: planFailures } = await classifyRun.planFiles(targets, options([rule]));
    assert.equal(plans.length, 5, '対象PDF数が分かる');
    assert.equal(planFailures.length, 0);
    assert.ok(plans.every((plan) => plan.toParentId === folderIds.inner), '移動予定先が分かる');

    // 1 件は削除しておき、移動に失敗させる (ほかは成功する)
    await repo.purgeFile(targets[0].id);
    const result = await classifyRun.applyPlans(plans);
    assert.equal(result.moved.length, 4);
    assert.equal(result.failures.length, 1, '失敗したPDFは一覧で返る');
    for (const target of targets.slice(1, 5)) {
      assert.equal((await repo.readFileMeta(target.id)).parentId, folderIds.inner);
    }
  });

  await test('7. テスト実行では実際に移動されない', async () => {
    await clearRules();
    const rule = await rulesLib.saveRule(
      ruleInput({ name: 'テスト実行', conditions: [condition('nameContains', { text: 'テスト実行対象' })] }),
    );
    const file = await addPdf('テスト実行対象.pdf', { parentId: folderIds.manuals });
    const { plans } = await classifyRun.planFiles([file], options([rule]));
    assert.equal(plans.length, 1);
    assert.equal(plans[0].toParentId, folderIds.inner, '分類先が分かる');
    assert.equal(
      (await repo.readFileMeta(file.id)).parentId,
      folderIds.manuals,
      '判定だけではPDFは動かない',
    );
  });

  await test('8. PDF本文・登録元・ファイル形式・日付の条件', async () => {
    await clearRules();
    const file = await addPdf('スキャン.pdf', {
      origin: 'image',
      sourceFormats: ['heic', 'jpeg'],
      pageCount: 2,
    });

    const content = await rulesLib.saveRule(
      ruleInput({ name: '本文', conditions: [condition('contentContains', { text: '領収金額' })] }),
    );
    assert.equal(
      await classify.matchRule(content, { file, readText: async () => '合計 領収金額 12,000円' }),
      true,
    );
    assert.equal(await classify.matchRule(content, { file, readText: async () => '別の書類' }), false);
    assert.equal(await classify.matchRule(content, { file }), false, '本文を読めないときは不一致');

    const origin = await rulesLib.saveRule(
      ruleInput({ name: '登録元', conditions: [condition('origin', { text: 'image' })] }),
    );
    assert.equal(await classify.matchRule(origin, { file }), true);

    const format = await rulesLib.saveRule(
      ruleInput({ name: '形式', conditions: [condition('fileType', { text: 'heic' })] }),
    );
    assert.equal(await classify.matchRule(format, { file }), true, '元になった画像形式でも一致する');

    const today = new Date().toISOString().slice(0, 10);
    const date = await rulesLib.saveRule(
      ruleInput({ name: '追加日', conditions: [condition('addedAt', { compare: 'atLeast', from: today })] }),
    );
    assert.equal(await classify.matchRule(date, { file }), true);

    const recent = await rulesLib.saveRule(
      ruleInput({ name: '最近', conditions: [condition('createdAt', { compare: 'withinDays', days: 1 })] }),
    );
    assert.equal(await classify.matchRule(recent, { file }), true);
  });

  await test('9. 無効なルールは判定されない / 確認と自動移動の設定', async () => {
    await clearRules();
    const disabled = await rulesLib.saveRule(
      ruleInput({ name: '無効', conditions: [condition('nameContains', { text: '無効確認' })], enabled: false }),
    );
    const file = await addPdf('無効確認.pdf');
    assert.equal(await classifyRun.planFile(file, options([disabled])), null);

    await rulesLib.setRuleEnabled(disabled.id, true);
    const [enabled] = await rulesLib.listRules();
    assert.equal(enabled.enabled, true);

    const confirm = { ...enabled, confirmBeforeMove: true };
    assert.equal((await classifyRun.planFile(file, options([confirm]))).needsConfirm, true);

    const manual = { ...enabled, autoMove: false };
    assert.equal(
      (await classifyRun.planFile(file, options([manual]))).needsConfirm,
      true,
      '自動移動しないルールは勝手に動かさない',
    );
  });

  await test('10. ルールの複製・削除', async () => {
    await clearRules();
    const rule = await rulesLib.saveRule(
      ruleInput({ name: '元ルール', conditions: [condition('nameContains', { text: 'A' })] }),
    );
    const afterCopy = await rulesLib.duplicateRule(rule.id);
    assert.equal(afterCopy.length, 2);
    assert.equal(afterCopy[1].name, '元ルール のコピー');
    assert.notEqual(afterCopy[1].id, rule.id);
    assert.notEqual(afterCopy[1].conditions[0].id, rule.conditions[0].id, '条件のIDも作り直す');
    assert.deepEqual(afterCopy.map((entry) => entry.priority), [1, 2]);

    const afterDelete = await rulesLib.deleteRule(rule.id);
    assert.equal(afterDelete.length, 1);
    assert.equal(afterDelete[0].priority, 1, '削除後は優先順位を詰める');
  });

  await test('20. 別ユーザーのルールが混ざらない', async () => {
    await clearRules();
    await rulesLib.saveRule(ruleInput({ name: 'この端末のルール', conditions: [condition('nameContains', { text: 'x' })] }));

    owner.setOwnerId('uid-A');
    // ログイン前のルールは、この端末を使っている本人のものとして見える
    assert.equal((await rulesLib.listRules()).length, 1);
    await rulesLib.claimLocalRules('uid-A');
    await rulesLib.saveRule(ruleInput({ name: 'Aさんのルール', conditions: [condition('nameContains', { text: 'a' })] }));
    assert.equal((await rulesLib.listRules()).length, 2);

    owner.setOwnerId('uid-B');
    assert.equal((await rulesLib.listRules()).length, 0, 'BさんにはAさんのルールが見えない');
    await rulesLib.saveRule(ruleInput({ name: 'Bさんのルール', conditions: [condition('nameContains', { text: 'b' })] }));
    assert.deepEqual((await rulesLib.listRules()).map((rule) => rule.name), ['Bさんのルール']);

    owner.setOwnerId('uid-A');
    assert.deepEqual(
      (await rulesLib.listRules()).map((rule) => rule.name),
      ['この端末のルール', 'Aさんのルール'],
      'Aさんのルールは消えていない',
    );
    owner.setOwnerId(null);
  });
}

/* ------------------------------------------------------------------ */
/* 画像から PDF を作成                                                 */
/* ------------------------------------------------------------------ */

async function readPdf(blob, password) {
  const pdfjs = await import(path.join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs'));
  const data = new Uint8Array(await blob.arrayBuffer());
  // verbosity 0 … 試験用に作った最小 JPEG への警告を抑える
  const doc = await pdfjs.getDocument({ data, password, verbosity: 0 }).promise;
  const pages = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    const ops = await page.getOperatorList();
    const images = [];
    ops.fnArray.forEach((fn, index) => {
      if (fn !== pdfjs.OPS.paintImageXObject) return;
      const name = ops.argsArray[index][0];
      const image = page.objs.has(name) ? page.objs.get(name) : null;
      if (image) images.push({ width: image.width, height: image.height });
    });
    pages.push({ width: Math.round(viewport.width), height: Math.round(viewport.height), images });
  }
  await doc.destroy();
  return pages;
}

function source(blob, name, extra = {}) {
  return { ...imageToPdf.toSourceImage(blob, name, extra.pickedOrder ?? 0), ...extra };
}

async function runImagePdfTests() {
  await test('11/12. 枚数と容量の上限を案内する', async () => {
    assert.equal(imageToPdf.checkImageLimits(10, 1024).level, 'ok');

    const warn = imageToPdf.checkImageLimits(35, 1024);
    assert.equal(warn.level, 'warn');
    assert.ok(
      warn.message.includes('30枚程度ずつの作成をおすすめします'),
      `注意文が仕様どおりでない: ${warn.message}`,
    );

    const many = imageToPdf.checkImageLimits(51, 1024);
    assert.equal(many.level, 'split');
    assert.ok(many.message.includes('分けて作成'), '分割を案内する');

    const heavy = imageToPdf.checkImageLimits(10, 201 * 1024 * 1024);
    assert.equal(heavy.level, 'split');

    assert.equal(imageToPdf.canStartBuild(51, 1024), false);
    assert.equal(imageToPdf.canStartBuild(10, 201 * 1024 * 1024), false);
    assert.equal(imageToPdf.canStartBuild(30, 10 * 1024 * 1024), true);
    assert.equal(imageToPdf.IMAGE_PDF_LIMITS.recommended, 30);
    assert.equal(imageToPdf.IMAGE_PDF_LIMITS.max, 50);
    assert.equal(imageToPdf.IMAGE_PDF_LIMITS.totalBytes, 200 * 1024 * 1024);
  });

  await test('8/9. 複数画像を1つのPDFにでき、順番がページ順と一致する', async () => {
    const images = [
      source(makeImageBlob(400, 300), 'a.jpg', { pickedOrder: 0 }),
      source(makeImageBlob(600, 300), 'b.jpg', { pickedOrder: 1 }),
      source(makeImageBlob(300, 600), 'c.jpg', { pickedOrder: 2 }),
    ];
    const progress = [];
    const result = await imageToPdf.buildImagePdf(images, {
      ...types.DEFAULT_IMAGE_PDF_OPTIONS,
      onProgress: (state) => progress.push(`${state.done}/${state.total}`),
    });
    assert.equal(result.pageCount, 3);
    assert.equal(result.failures.length, 0);

    const pages = await readPdf(result.blob);
    assert.equal(pages.length, 3);
    assert.deepEqual(pages.map((page) => [page.width, page.height]), [
      [595, 842],
      [595, 842],
      [595, 842],
    ]);
    // 画面に並べた順どおりに埋め込まれているか (縦横比で見分ける)
    const ratios = pages.map((page) => page.images[0].width / page.images[0].height);
    assert.ok(Math.abs(ratios[0] - 400 / 300) < 0.05, `1ページ目: ${ratios[0]}`);
    assert.ok(Math.abs(ratios[1] - 600 / 300) < 0.05, `2ページ目: ${ratios[1]}`);
    assert.ok(Math.abs(ratios[2] - 300 / 600) < 0.05, `3ページ目: ${ratios[2]}`);
    // 14. 進捗が通知される
    assert.ok(progress.includes('1/3') && progress.includes('3/3'), progress.join(','));
  });

  await test('10. 画像を回転・削除・複製しても元画像は変わらない', async () => {
    const blob = makeImageBlob(400, 300);
    const before = blob.size;
    const rotated = source(blob, 'r.jpg', { rotation: 90 });
    const result = await imageToPdf.buildImagePdf([rotated], types.DEFAULT_IMAGE_PDF_OPTIONS);
    const pages = await readPdf(result.blob);
    const image = pages[0].images[0];
    assert.ok(image.height > image.width, '回転して縦長になっている');
    // 18. 元画像自体は変更・削除されない
    assert.equal(blob.size, before, '元の画像データは変わらない');
    assert.deepEqual(imageSizes.get(blob), { width: 400, height: 300 });
  });

  await test('13. 大量の画像でも同時にメモリへ展開しない', async () => {
    // 同時に開いているデコード結果の数を数える (1 枚ずつのはず)
    let open = 0;
    let peak = 0;
    const original = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async (blob) => {
      const bitmap = await original(blob);
      open += 1;
      peak = Math.max(peak, open);
      return {
        ...bitmap,
        close() {
          open -= 1;
        },
      };
    };
    try {
      const images = Array.from({ length: 30 }, (_, index) =>
        source(makeImageBlob(400 + index, 300), `m${index}.jpg`, { pickedOrder: index }),
      );
      const result = await imageToPdf.buildImagePdf(images, types.DEFAULT_IMAGE_PDF_OPTIONS);
      assert.equal(result.pageCount, 30);
      assert.equal(peak, 1, `同時に展開した画像は ${peak} 枚`);
      assert.equal(open, 0, 'すべて解放されている');
    } finally {
      globalThis.createImageBitmap = original;
    }
  });

  await test('15. エラー画像を除外して処理を続行できる', async () => {
    const images = [
      source(makeImageBlob(400, 300), 'ok1.jpg', { pickedOrder: 0 }),
      source(makeImageBlob(400, 300, { broken: true }), 'broken.heic', { pickedOrder: 1 }),
      source(makeImageBlob(400, 300), 'ok2.jpg', { pickedOrder: 2 }),
    ];
    images[1].format = 'heic';

    const asked = [];
    const result = await imageToPdf.buildImagePdf(images, {
      ...types.DEFAULT_IMAGE_PDF_OPTIONS,
      onImageError: async (failure) => {
        asked.push(failure);
        return 'skip';
      },
    });
    assert.equal(asked.length, 1, '失敗した画像だけ確認される');
    assert.ok(asked[0].reason.includes('HEIC'), 'HEICは理由を出し分ける');
    assert.equal(result.pageCount, 2, '正常な画像の結果は失われない');
    assert.equal(result.failures.length, 1);

    // 中止した場合は PDF を返さない (不完全なPDFを保存しない)
    await assert.rejects(
      imageToPdf.buildImagePdf(images, {
        ...types.DEFAULT_IMAGE_PDF_OPTIONS,
        onImageError: async () => 'abort',
      }),
      (error) => error.code === 'IMAGE_PDF_CANCELLED',
    );

    // 再試行を選ぶと、同じ画像をもう一度読む
    let attempts = 0;
    const flaky = [source(makeImageBlob(400, 300, { broken: true }), 'flaky.jpg')];
    const recovered = await imageToPdf.buildImagePdf(flaky, {
      ...types.DEFAULT_IMAGE_PDF_OPTIONS,
      onImageError: async () => {
        attempts += 1;
        brokenImages.delete(flaky[0].blob);
        return 'retry';
      },
    });
    assert.equal(attempts, 1);
    assert.equal(recovered.pageCount, 1);
  });

  await test('作成中にキャンセルできる', async () => {
    const images = Array.from({ length: 5 }, (_, index) =>
      source(makeImageBlob(400, 300), `c${index}.jpg`, { pickedOrder: index }),
    );
    let done = 0;
    await assert.rejects(
      imageToPdf.buildImagePdf(images, {
        ...types.DEFAULT_IMAGE_PDF_OPTIONS,
        onProgress: (state) => {
          done = state.done;
        },
        isCancelled: () => done >= 2,
      }),
      (error) => error.code === 'IMAGE_PDF_CANCELLED',
    );
  });

  await test('用紙サイズ・向き・1ページ複数配置', async () => {
    const images = Array.from({ length: 4 }, (_, index) =>
      source(makeImageBlob(400, 300), `p${index}.jpg`, { pickedOrder: index }),
    );

    const a3 = await imageToPdf.buildImagePdf(images.slice(0, 1), {
      ...types.DEFAULT_IMAGE_PDF_OPTIONS,
      paper: 'a3',
      orientation: 'landscape',
    });
    const a3Pages = await readPdf(a3.blob);
    assert.deepEqual([a3Pages[0].width, a3Pages[0].height], [1191, 842], 'A3 横向き');

    const auto = await imageToPdf.buildImagePdf(images.slice(0, 1), {
      ...types.DEFAULT_IMAGE_PDF_OPTIONS,
      paper: 'auto',
      marginMm: 0,
    });
    const autoPages = await readPdf(auto.blob);
    assert.ok(
      Math.abs(autoPages[0].width / autoPages[0].height - 400 / 300) < 0.05,
      '画像サイズに合わせたページ',
    );

    const twoUp = await imageToPdf.buildImagePdf(images, {
      ...types.DEFAULT_IMAGE_PDF_OPTIONS,
      imagesPerPage: 2,
    });
    const twoPages = await readPdf(twoUp.blob);
    assert.equal(twoPages.length, 2, '4枚を2枚ずつで2ページ');
    assert.equal(twoPages[0].images.length, 2);

    const fourUp = await imageToPdf.buildImagePdf(images, {
      ...types.DEFAULT_IMAGE_PDF_OPTIONS,
      imagesPerPage: 4,
    });
    const fourPages = await readPdf(fourUp.blob);
    assert.equal(fourPages.length, 1);
    assert.equal(fourPages[0].images.length, 4);
  });

  await test('画質プリセットで解像度と容量が変わる', async () => {
    const images = [source(makeImageBlob(4000, 3000), 'big.jpg')];
    const light = await imageToPdf.buildImagePdf(images, {
      ...types.DEFAULT_IMAGE_PDF_OPTIONS,
      quality: 'light',
    });
    const high = await imageToPdf.buildImagePdf(images, {
      ...types.DEFAULT_IMAGE_PDF_OPTIONS,
      quality: 'high',
    });
    const lightPages = await readPdf(light.blob);
    const highPages = await readPdf(high.blob);
    assert.equal(lightPages[0].images[0].width, 1200, '軽量は長辺1200pxへ縮小');
    assert.equal(highPages[0].images[0].width, 3000, '高画質は長辺3000pxへ縮小');

    const estimate = imageToPdf.estimateOutputBytes(
      [{ ...images[0], width: 4000, height: 3000 }],
      'light',
    );
    assert.ok(estimate > 0, '作成後の容量の目安が出る');
  });

  await test('パスワードを設定したPDFは、正しいパスワードだけで開ける', async () => {
    const images = [source(makeImageBlob(400, 300), 'secret.jpg')];
    const result = await imageToPdf.buildImagePdf(images, {
      ...types.DEFAULT_IMAGE_PDF_OPTIONS,
      password: 'open-me-123',
    });
    await assert.rejects(readPdf(result.blob), (error) => error.name === 'PasswordException');
    await assert.rejects(
      readPdf(result.blob, 'wrong'),
      (error) => error.name === 'PasswordException',
    );
    const pages = await readPdf(result.blob, 'open-me-123');
    assert.equal(pages.length, 1);
    assert.equal(pages[0].images.length, 1, '中の画像も読める');
  });

  await test('対応画像形式の判定', async () => {
    const cases = [
      ['photo.jpg', 'jpeg'],
      ['photo.JPEG', 'jpeg'],
      ['shot.png', 'png'],
      ['icon.webp', 'webp'],
      ['live.HEIC', 'heic'],
      ['live.heif', 'heif'],
    ];
    for (const [name, expected] of cases) {
      const blob = new Blob([Buffer.from('x')], { type: '' });
      assert.equal(imageToPdf.isSupportedImage(blob, name), true, name);
      assert.equal(imageToPdf.imageFormatOf(blob, name), expected, name);
    }
    const pdf = new Blob([pdfBytes], { type: 'application/pdf' });
    assert.equal(imageToPdf.isSupportedImage(pdf, 'a.pdf'), false);
  });

  await test('17. 画像から作ったPDFにも自動分類ルールが適用される', async () => {
    await clearRules();
    const rule = await rulesLib.saveRule(
      ruleInput({ name: '領収書', conditions: [condition('nameContains', { text: '領収書' })] }),
    );
    const images = [source(makeImageBlob(400, 300), 'r.jpg')];
    const built = await imageToPdf.buildImagePdf(images, types.DEFAULT_IMAGE_PDF_OPTIONS);

    // 16. 作成したPDFが指定フォルダーへ保存される
    const meta = await repo.addPdf(built.blob, '2026年7月_医療費領収書.pdf', {
      parentId: folderIds.manuals,
      pageCount: built.pageCount,
      origin: 'image',
      sourceFormats: built.formats,
    });
    assert.equal(meta.parentId, folderIds.manuals);
    assert.deepEqual(meta.sourceFormats, ['jpeg']);

    const plan = await classifyRun.planFile(meta, options([rule]));
    assert.ok(plan, 'ルールに一致する');
    const record = await classifyRun.applyPlan(plan);
    assert.equal(record.ruleName, '領収書');
    assert.equal((await repo.readFileMeta(meta.id)).parentId, folderIds.inner);
  });
}

/* ------------------------------------------------------------------ */

(async () => {
  await setup();
  console.log('自動分類ルール');
  await runClassifyTests();
  console.log(results.splice(0).join('\n'));
  console.log('\n画像からPDFを作成');
  await runImagePdfTests();
  console.log(results.splice(0).join('\n'));

  if (failures > 0) {
    console.error(`\n${failures} 件の確認に失敗しました。`);
    process.exit(1);
  }
  console.log('\nすべての確認に成功しました。');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

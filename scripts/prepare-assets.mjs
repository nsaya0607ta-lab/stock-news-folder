#!/usr/bin/env node
/**
 * ビルド前に実行される資材生成スクリプト。
 *  1. pdf.js の worker と外部データ (CMap / 標準フォント ほか) を public/ へコピーする
 *  2. アプリアイコン (PNG) を生成する
 *  3. iOS 用スプラッシュ画像を生成する
 * 生成物はリポジトリに含めず、ビルドのたびに作り直す。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, Raster, resample } from './lib/png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');

const BG = [24, 63, 128, 255]; // brand-700
const FOLDER = [232, 169, 23, 255];
const FOLDER_DARK = [201, 143, 13, 255];
const PAPER = [255, 255, 255, 255];
const PDF_RED = [200, 52, 43, 255];

const pdfjsDir = path.join(root, 'node_modules', 'pdfjs-dist');

function copyPdfWorker() {
  const src = path.join(pdfjsDir, 'legacy', 'build', 'pdf.worker.min.mjs');
  if (!fs.existsSync(src)) {
    console.warn('[prepare-assets] pdf.worker.min.mjs が見つかりません。npm install を実行してください。');
    return;
  }
  fs.copyFileSync(src, path.join(publicDir, 'pdf.worker.min.mjs'));
  console.log('[prepare-assets] pdf.worker.min.mjs をコピーしました');
}

/**
 * pdf.js が実行時に fetch する外部データを配信できるようにコピーする。
 * これが無いと日本語 PDF (定義済み CMap を使う CID フォント) の文字が
 * 描画されず、罫線などの図形だけが表示される。
 * コピー先は src/lib/pdf.ts の PDFJS_ASSET_BASE と対応させること。
 */
function copyPdfAssets() {
  const targets = [
    ['cmaps', 'cmaps'], // 定義済み CMap (UniJIS-UCS2-H など)
    ['standard_fonts', 'standard_fonts'], // 非埋め込みの標準 14 フォント
    ['wasm', 'wasm'], // JPEG2000 / JBIG2 画像デコーダー
    ['iccs', 'iccs'], // ICC カラープロファイル
  ];
  for (const [from, to] of targets) {
    const src = path.join(pdfjsDir, from);
    if (!fs.existsSync(src)) {
      console.warn(`[prepare-assets] pdfjs-dist/${from} が見つかりません。npm install を実行してください。`);
      continue;
    }
    const dest = path.join(publicDir, 'pdfjs', to);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
  }
  console.log('[prepare-assets] pdf.js の外部データ (CMap/フォント ほか) をコピーしました');
}

/** ロゴ (フォルダー + PDF 用紙) を 0..1 の相対座標で描く。 */
function drawLogo(r, size, ox = 0, oy = 0) {
  const u = size / 100;
  const X = (v) => ox + v * u;
  const Y = (v) => oy + v * u;

  // フォルダーの背面タブ
  r.fillPolygon(
    [
      [X(10), Y(30)],
      [X(40), Y(30)],
      [X(47), Y(38)],
      [X(90), Y(38)],
      [X(90), Y(46)],
      [X(10), Y(46)],
    ],
    FOLDER_DARK,
  );
  // 用紙 (PDF) — フォルダー前面より上にはみ出した部分だけが見える
  r.fillRect(X(31), Y(14), 38 * u, 34 * u, PAPER);
  r.fillRect(X(37), Y(20), 26 * u, 3.5 * u, [176, 186, 198, 255]);
  r.fillRect(X(37), Y(26.5), 26 * u, 3.5 * u, [176, 186, 198, 255]);
  r.fillRect(X(31), Y(34), 26 * u, 11 * u, PDF_RED);
  // フォルダーの前面
  r.fillPolygon(
    [
      [X(10), Y(44)],
      [X(90), Y(44)],
      [X(84), Y(84)],
      [X(16), Y(84)],
    ],
    FOLDER,
  );
}

function buildIcon(size, { maskable = false } = {}) {
  const r = new Raster(size, size, size <= 256 ? 4 : 2);
  if (maskable) {
    r.fillAll(BG);
    drawLogo(r, size * 0.62, size * 0.19, size * 0.19);
  } else {
    r.fillRoundRect(0, 0, size, size, size * 0.18, BG);
    drawLogo(r, size * 0.78, size * 0.11, size * 0.11);
  }
  return r.resolve();
}

function writePng(file, rgba, w, h) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(rgba, w, h));
}

function buildIcons() {
  const iconsDir = path.join(publicDir, 'icons');
  fs.mkdirSync(iconsDir, { recursive: true });
  for (const size of [64, 128, 180, 192, 256, 384, 512]) {
    writePng(path.join(iconsDir, `icon-${size}.png`), buildIcon(size), size, size);
  }
  writePng(path.join(iconsDir, 'icon-maskable-512.png'), buildIcon(512, { maskable: true }), 512, 512);
  // ファビコン (32px)
  writePng(path.join(iconsDir, 'favicon-32.png'), buildIcon(32), 32, 32);
  console.log('[prepare-assets] アイコンを生成しました');
}

// iPhone / iPad の代表的な解像度 (portrait)
const SPLASH_SIZES = [
  [640, 1136],
  [750, 1334],
  [828, 1792],
  [1125, 2436],
  [1170, 2532],
  [1179, 2556],
  [1206, 2622],
  [1242, 2688],
  [1284, 2778],
  [1290, 2796],
  [1320, 2868],
  [1536, 2048],
  [1668, 2388],
  [2048, 2732],
];

function buildSplash() {
  const splashDir = path.join(publicDir, 'splash');
  fs.mkdirSync(splashDir, { recursive: true });
  const logoSize = 512;
  const logo = (() => {
    const r = new Raster(logoSize, logoSize, 2);
    r.fillRoundRect(0, 0, logoSize, logoSize, logoSize * 0.18, BG);
    drawLogo(r, logoSize * 0.78, logoSize * 0.11, logoSize * 0.11);
    return r.resolve();
  })();

  for (const [w, h] of SPLASH_SIZES) {
    const canvas = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < canvas.length; i += 4) {
      canvas[i] = 244;
      canvas[i + 1] = 246;
      canvas[i + 2] = 248;
      canvas[i + 3] = 255;
    }
    const target = Math.round(Math.min(w, h) * 0.32);
    const scaled = resample(logo, logoSize, logoSize, target, target);
    const ox = Math.round((w - target) / 2);
    const oy = Math.round((h - target) / 2);
    for (let y = 0; y < target; y += 1) {
      for (let x = 0; x < target; x += 1) {
        const so = (y * target + x) * 4;
        const dof = ((y + oy) * w + x + ox) * 4;
        canvas[dof] = scaled[so];
        canvas[dof + 1] = scaled[so + 1];
        canvas[dof + 2] = scaled[so + 2];
        canvas[dof + 3] = 255;
      }
    }
    writePng(path.join(splashDir, `splash-${w}x${h}.png`), canvas, w, h);
  }
  console.log(`[prepare-assets] スプラッシュ画像を ${SPLASH_SIZES.length} 枚生成しました`);
}

fs.mkdirSync(publicDir, { recursive: true });
copyPdfWorker();
copyPdfAssets();
buildIcons();
buildSplash();

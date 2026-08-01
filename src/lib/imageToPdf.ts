/**
 * 複数の画像から 1 つの PDF を作る。
 *
 * 端末が固まらないことを最優先にしている。
 *  - 画像は 1 枚ずつ順番に読み込み、PDF へ埋め込んだらすぐ解放する
 *  - 全画像を同時に高解像度のままメモリへ展開しない
 *  - 画質設定に応じて縮小してから埋め込む (元画像には一切手を触れない)
 *  - 1 枚ごとに描画へ制御を返し、進捗を通知する
 *  - 途中で失敗した画像は、呼び出し側の判断で「除外して続行」できる
 *
 * 変換は canvas 経由で JPEG に統一する。HEIC / HEIF は端末 (iOS) が
 * デコードできればそのまま JPEG へ変換され、できない端末では
 * その画像だけを失敗として報告する (他の画像の処理は止めない)。
 */
import { releaseCanvas } from './device';
import { AppError } from './errors';
import { createId } from './naming';
import {
  DEFAULT_IMAGE_PDF_OPTIONS,
  QUALITY_PRESETS,
  type ImageLayout,
  type ImagePdfOptions,
  type PaperSize,
  type QualityPreset,
} from './types';

/* ------------------------------------------------------------------ */
/* 枚数と容量の上限                                                    */
/* ------------------------------------------------------------------ */

export const IMAGE_PDF_LIMITS = {
  /** 推奨枚数 (これを超えたら注意を表示する)。 */
  recommended: 30,
  /** 通常上限 (これを超えたら分割を案内する)。 */
  max: 50,
  /** 合計ファイル容量の上限。 */
  totalBytes: 200 * 1024 * 1024,
} as const;

/**
 * 端末の性能から「無理なく処理できそうな枚数」を見積もる。
 *
 * 枚数だけで機械的に判断せず、メモリの少ない端末では少なめに案内する。
 * deviceMemory は Chrome 系だけが返すため、取得できない端末 (iOS Safari) は
 * 推奨枚数をそのまま使う。
 */
export function safeImageCount(): number {
  if (typeof navigator === 'undefined') return IMAGE_PDF_LIMITS.recommended;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof memory === 'number' && memory > 0) {
    if (memory <= 2) return 15;
    if (memory <= 4) return 25;
  }
  return IMAGE_PDF_LIMITS.recommended;
}

export type LimitAdvice = {
  level: 'ok' | 'warn' | 'split';
  message: string;
};

/** 枚数・合計容量・端末性能から、表示する注意文を決める。 */
export function checkImageLimits(count: number, totalBytes: number): LimitAdvice {
  if (count > IMAGE_PDF_LIMITS.max) {
    return {
      level: 'split',
      message: `画像が ${count} 枚あります。1回の作成は ${IMAGE_PDF_LIMITS.max} 枚までです。${IMAGE_PDF_LIMITS.recommended}枚程度ずつに分けて作成してください。`,
    };
  }
  if (totalBytes > IMAGE_PDF_LIMITS.totalBytes) {
    return {
      level: 'split',
      message: `合計容量が上限（${Math.round(IMAGE_PDF_LIMITS.totalBytes / 1024 / 1024)}MB）を超えています。枚数を減らして分けて作成してください。`,
    };
  }
  if (count > IMAGE_PDF_LIMITS.recommended) {
    return {
      level: 'warn',
      message: `画像数が多いため、PDF作成に時間がかかる可能性があります。安定した処理のため、${IMAGE_PDF_LIMITS.recommended}枚程度ずつの作成をおすすめします`,
    };
  }
  const safe = safeImageCount();
  if (count > safe) {
    return {
      level: 'warn',
      message: `この端末では ${safe} 枚程度ずつの作成をおすすめします。枚数が多いと、作成に時間がかかることがあります。`,
    };
  }
  return { level: 'ok', message: '' };
}

/** 作成を開始してよいか (上限を超えていないか)。 */
export function canStartBuild(count: number, totalBytes: number): boolean {
  return count > 0 && count <= IMAGE_PDF_LIMITS.max && totalBytes <= IMAGE_PDF_LIMITS.totalBytes;
}

/* ------------------------------------------------------------------ */
/* 対応する画像形式                                                    */
/* ------------------------------------------------------------------ */

const EXTENSION_FORMATS: Record<string, string> = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
  heic: 'heic',
  heif: 'heif',
};

/** 画像として選べるファイルか (MIME が空の端末があるので拡張子でも見る)。 */
export function isSupportedImage(file: File | Blob, name?: string): boolean {
  const fileName = name ?? (file instanceof File ? file.name : '');
  if (file.type.startsWith('image/')) return true;
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  return extension in EXTENSION_FORMATS;
}

/** `jpeg` / `png` / `webp` / `heic` などの形式名。自動分類の条件にも使う。 */
export function imageFormatOf(file: File | Blob, name?: string): string {
  const fileName = name ?? (file instanceof File ? file.name : '');
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (extension in EXTENSION_FORMATS) return EXTENSION_FORMATS[extension];
  const subtype = file.type.split('/')[1]?.toLowerCase() ?? '';
  return EXTENSION_FORMATS[subtype] ?? subtype ?? 'image';
}

/** HEIC / HEIF は端末によってデコードできないため、案内を出し分ける。 */
export function isHeic(format: string): boolean {
  return format === 'heic' || format === 'heif';
}

/* ------------------------------------------------------------------ */
/* 選択した画像                                                        */
/* ------------------------------------------------------------------ */

/** 並べ替え画面で扱う 1 枚。元画像 (blob) には一切手を加えない。 */
export type SourceImage = {
  id: string;
  blob: Blob;
  name: string;
  format: string;
  /** 表示・PDF に反映する回転 (0 / 90 / 180 / 270)。元画像は変更しない。 */
  rotation: number;
  /** 撮影日時 (取得できた場合)。並べ替えに使う。 */
  takenAt?: number;
  /** 選択した順序 (「選択順に戻す」で使う)。 */
  pickedOrder: number;
  /** サムネイル表示時に判明する原寸 (容量の見積りに使う)。 */
  width?: number;
  height?: number;
};

export function toSourceImage(file: File | Blob, name: string, pickedOrder: number): SourceImage {
  return {
    id: createId('img'),
    blob: file,
    name,
    format: imageFormatOf(file, name),
    rotation: 0,
    takenAt: file instanceof File && file.lastModified ? file.lastModified : undefined,
    pickedOrder,
  };
}

/* ------------------------------------------------------------------ */
/* 用紙とレイアウト                                                    */
/* ------------------------------------------------------------------ */

const MM_TO_PT = 72 / 25.4;
/** 画面上の 1px を PDF の何ポイントとして扱うか (96dpi 換算)。 */
const PX_TO_PT = 72 / 96;

/** 用紙サイズ (縦向きのポイント値)。B5 は日本で一般的な JIS 規格 (182×257mm)。 */
const PAPER_SIZES: Record<Exclude<PaperSize, 'auto'>, { width: number; height: number }> = {
  a4: { width: 595.28, height: 841.89 },
  a3: { width: 841.89, height: 1190.55 },
  b5: { width: 515.91, height: 728.5 },
  letter: { width: 612, height: 792 },
};

export function paperSizeOf(
  paper: PaperSize,
  orientation: 'portrait' | 'landscape',
  image: { width: number; height: number },
): { width: number; height: number } {
  if (paper === 'auto') {
    // 画像と同じ形のページにする (余白の指定は別途 margin で加える)
    return { width: image.width * PX_TO_PT, height: image.height * PX_TO_PT };
  }
  const size = PAPER_SIZES[paper];
  return orientation === 'landscape' ? { width: size.height, height: size.width } : { ...size };
}

type Rect = { x: number; y: number; width: number; height: number };

/**
 * 1 つの枠 (ページ全体、または分割したセル) の中に画像をどう置くかを決める。
 * 返り値はページ座標系 (左下原点) の矩形。
 */
export function placeImage(
  cell: Rect,
  image: { width: number; height: number },
  layout: ImageLayout,
  marginPt: number,
): Rect {
  // 「余白あり」は指定の余白に 10mm 上乗せする
  const margin = layout === 'fill' ? 0 : layout === 'margin' ? marginPt + 10 * MM_TO_PT : marginPt;
  const box: Rect = {
    x: cell.x + margin,
    y: cell.y + margin,
    width: Math.max(1, cell.width - margin * 2),
    height: Math.max(1, cell.height - margin * 2),
  };

  const scaleContain = Math.min(box.width / image.width, box.height / image.height);
  const scaleCover = Math.max(box.width / image.width, box.height / image.height);

  let scale: number;
  if (layout === 'fill' || layout === 'crop') {
    // 枠いっぱいに広げる。はみ出した部分はページの外側になるため表示されない
    scale = scaleCover;
  } else if (layout === 'center') {
    // 原寸のまま中央へ。枠より大きいときだけ縮める
    scale = Math.min(1 * PX_TO_PT, scaleContain);
  } else {
    scale = scaleContain;
  }

  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

/** 1 ページを imagesPerPage 枚ぶんの枠に分ける。 */
export function cellsOf(
  page: { width: number; height: number },
  imagesPerPage: 1 | 2 | 4,
): Rect[] {
  if (imagesPerPage === 1) return [{ x: 0, y: 0, width: page.width, height: page.height }];
  if (imagesPerPage === 2) {
    // 縦長ページは上下 2 段、横長ページは左右 2 列にする
    if (page.height >= page.width) {
      const half = page.height / 2;
      return [
        { x: 0, y: half, width: page.width, height: half },
        { x: 0, y: 0, width: page.width, height: half },
      ];
    }
    const half = page.width / 2;
    return [
      { x: 0, y: 0, width: half, height: page.height },
      { x: half, y: 0, width: half, height: page.height },
    ];
  }
  const halfWidth = page.width / 2;
  const halfHeight = page.height / 2;
  // 左上 → 右上 → 左下 → 右下 の順に並べる
  return [
    { x: 0, y: halfHeight, width: halfWidth, height: halfHeight },
    { x: halfWidth, y: halfHeight, width: halfWidth, height: halfHeight },
    { x: 0, y: 0, width: halfWidth, height: halfHeight },
    { x: halfWidth, y: 0, width: halfWidth, height: halfHeight },
  ];
}

/* ------------------------------------------------------------------ */
/* 画像のデコード                                                      */
/* ------------------------------------------------------------------ */

type Bitmap = { data: Uint8Array; width: number; height: number };

/** createImageBitmap があればそちらを使う (メモリ効率が良く、デコードも速い)。 */
async function decode(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // 一部の端末・形式では失敗するため、img 要素で読み直す
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new AppError('IMAGE_CONVERT_FAILED'));
      element.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => {
        image.src = '';
        URL.revokeObjectURL(url);
      },
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * 画像を JPEG のバイト列へ変換する。
 *
 * 1 枚ずつ呼ばれ、終わるたびに canvas とデコード結果を解放する。
 * @param maxEdge 長辺の上限 (px)。これを超える画像は縮小する。
 * @param rotation 90 度単位の回転。canvas 上で回してから書き出す。
 */
export async function imageToJpeg(
  blob: Blob,
  { maxEdge, quality, rotation = 0 }: { maxEdge: number; quality: number; rotation?: number },
): Promise<Bitmap> {
  const decoded = await decode(blob);
  let canvas: HTMLCanvasElement | undefined;
  try {
    if (decoded.width === 0 || decoded.height === 0) throw new AppError('IMAGE_CONVERT_FAILED');

    const scale = Math.min(1, maxEdge / Math.max(decoded.width, decoded.height));
    const scaledWidth = Math.max(1, Math.round(decoded.width * scale));
    const scaledHeight = Math.max(1, Math.round(decoded.height * scale));
    const turned = rotation === 90 || rotation === 270;
    const width = turned ? scaledHeight : scaledWidth;
    const height = turned ? scaledWidth : scaledHeight;

    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new AppError('IMAGE_CONVERT_FAILED');
    // JPEG は透明を扱えないため、PNG / WebP の透明部分は白で塗る
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    if (rotation !== 0) {
      context.translate(width / 2, height / 2);
      context.rotate((rotation * Math.PI) / 180);
      context.translate(-scaledWidth / 2, -scaledHeight / 2);
    }
    context.drawImage(decoded.source, 0, 0, scaledWidth, scaledHeight);

    const jpeg = await new Promise<Blob | null>((resolve) => {
      (canvas as HTMLCanvasElement).toBlob((result) => resolve(result), 'image/jpeg', quality);
    });
    if (!jpeg) throw new AppError('IMAGE_CONVERT_FAILED');
    return { data: new Uint8Array(await jpeg.arrayBuffer()), width, height };
  } finally {
    decoded.release();
    // iOS Safari は canvas 用メモリの合計に上限がある。
    // 使い終わった canvas を毎回 0 サイズにして即座に解放する。
    if (canvas) releaseCanvas(canvas);
  }
}

/**
 * 既存の呼び出し (PDF 編集画面のページ追加) 向けの薄いラッパー。
 * 標準画質・長辺 2000px で JPEG 化する。
 */
export async function toJpegBitmap(file: Blob): Promise<Bitmap> {
  const preset = QUALITY_PRESETS.standard;
  return imageToJpeg(file, { maxEdge: preset.maxEdge, quality: preset.quality });
}

/* ------------------------------------------------------------------ */
/* 完成後の容量の見積り                                                */
/* ------------------------------------------------------------------ */

/** 画質プリセットごとの、1 画素あたりのおおよそのバイト数。 */
const BYTES_PER_PIXEL: Record<QualityPreset, number> = {
  light: 0.06,
  standard: 0.1,
  high: 0.16,
  original: 0.24,
};

/**
 * 作成後のファイル容量の目安 (バイト)。
 *
 * 原寸が分かっている画像は「縮小後の画素数 × プリセット係数」で見積もり、
 * 分からない画像は元の容量から概算する。あくまで目安として表示する。
 */
export function estimateOutputBytes(images: SourceImage[], quality: QualityPreset): number {
  const preset = QUALITY_PRESETS[quality];
  const perPixel = BYTES_PER_PIXEL[quality];
  let total = 0;
  for (const image of images) {
    if (image.width && image.height) {
      const scale = Math.min(1, preset.maxEdge / Math.max(image.width, image.height));
      const pixels = image.width * image.height * scale * scale;
      // 元の容量より大きくなることは基本的に無いので上限を掛ける
      total += Math.min(pixels * perPixel, image.blob.size * 1.1);
    } else {
      total += image.blob.size * (quality === 'original' ? 0.9 : perPixel * 6);
    }
  }
  // PDF 自体の構造ぶん
  return Math.round(total + 1024 * (images.length + 2));
}

/* ------------------------------------------------------------------ */
/* PDF の組み立て                                                      */
/* ------------------------------------------------------------------ */

export type BuildFailure = { id: string; name: string; reason: string };

/** 失敗した画像に対する判断。 */
export type FailureChoice = 'retry' | 'skip' | 'abort';

export type BuildProgress = {
  done: number;
  total: number;
  currentName: string;
};

export type BuildImagePdfOptions = ImagePdfOptions & {
  onProgress?: (progress: BuildProgress) => void;
  /** 失敗した画像の扱いを尋ねる。省略時は除外して続行。 */
  onImageError?: (failure: BuildFailure) => Promise<FailureChoice>;
  /** true になった時点で処理を中止する。 */
  isCancelled?: () => boolean;
};

export type BuildImagePdfResult = {
  blob: Blob;
  pageCount: number;
  /** 除外した画像。 */
  failures: BuildFailure[];
  /** 使った画像形式 (自動分類の「ファイル形式」条件に使う)。 */
  formats: string[];
};

/** 端末を占有しないよう、描画へ制御を返す。 */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 画像から PDF を組み立てる。
 *
 * 画像は 1 枚ずつ読み込み → 縮小 → JPEG 化 → PDF へ埋め込み → 解放、を繰り返す。
 * 中断された場合は AppError('IMAGE_PDF_CANCELLED') を投げ、PDF は返さない
 * (不完全な PDF を保存しないため)。
 */
export async function buildImagePdf(
  images: SourceImage[],
  options: BuildImagePdfOptions = DEFAULT_IMAGE_PDF_OPTIONS,
): Promise<BuildImagePdfResult> {
  if (images.length === 0) throw new AppError('IMAGE_CONVERT_FAILED');
  if (images.length > IMAGE_PDF_LIMITS.max) throw new AppError('IMAGE_PDF_TOO_MANY');

  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const preset = QUALITY_PRESETS[options.quality];
  const marginPt = Math.max(0, options.marginMm) * MM_TO_PT;
  const perPage = options.imagesPerPage;

  const failures: BuildFailure[] = [];
  const formats = new Set<string>();
  let pageCount = 0;
  let placed = 0;
  // 「複数画像を1ページに配置」のとき、書きかけのページを保持する
  let currentPage: { page: ReturnType<typeof pdf.addPage>; cells: Rect[]; used: number } | null = null;

  const cancelled = () => options.isCancelled?.() === true;

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    if (cancelled()) throw new AppError('IMAGE_PDF_CANCELLED');
    options.onProgress?.({ done: index, total: images.length, currentName: image.name });

    /** 1 枚を JPEG 化する。失敗したら呼び出し側の判断を仰ぐ。 */
    let bitmap: Bitmap | null = null;
    for (;;) {
      try {
        bitmap = await imageToJpeg(image.blob, {
          maxEdge: preset.maxEdge,
          quality: preset.quality,
          rotation: image.rotation,
        });
        break;
      } catch (error) {
        const failure: BuildFailure = {
          id: image.id,
          name: image.name,
          reason: heicHint(image, error),
        };
        const choice = options.onImageError ? await options.onImageError(failure) : 'skip';
        if (choice === 'abort') throw new AppError('IMAGE_PDF_CANCELLED');
        if (choice === 'skip') {
          failures.push(failure);
          bitmap = null;
          break;
        }
        // retry: もう一度同じ画像を試す
      }
    }
    if (!bitmap) continue;

    try {
      const embedded = await pdf.embedJpg(bitmap.data);

      if (perPage === 1) {
        const size = paperSizeOf(options.paper, options.orientation, bitmap);
        const page = pdf.addPage([size.width, size.height]);
        const rect = placeImage({ x: 0, y: 0, ...size }, bitmap, options.layout, marginPt);
        page.drawImage(embedded, rect);
        pageCount += 1;
      } else {
        if (!currentPage || currentPage.used >= perPage) {
          const size = paperSizeOf(options.paper, options.orientation, bitmap);
          const page = pdf.addPage([size.width, size.height]);
          currentPage = { page, cells: cellsOf(size, perPage), used: 0 };
          pageCount += 1;
        }
        const cell = currentPage.cells[currentPage.used];
        currentPage.page.drawImage(embedded, placeImage(cell, bitmap, options.layout, marginPt));
        currentPage.used += 1;
      }

      formats.add(image.format);
      placed += 1;
    } finally {
      // 埋め込みが済んだ時点で、この画像のバイト列への参照を手放す
      bitmap = null;
    }

    options.onProgress?.({ done: index + 1, total: images.length, currentName: image.name });
    // 1 枚ごとに描画へ譲る。大量の画像でも画面が固まらないようにする。
    await yieldToUi();
  }

  if (placed === 0) throw new AppError('IMAGE_CONVERT_FAILED');
  if (cancelled()) throw new AppError('IMAGE_PDF_CANCELLED');

  if (options.password) {
    const { encryptDocument } = await import('./pdfEncrypt');
    await encryptDocument(pdf, options.password);
  }
  // パスワード付きのときは、文字列を 1 つずつ暗号化できるようオブジェクトストリームを使わない
  const bytes = await pdf.save(options.password ? { useObjectStreams: false } : {});

  return {
    blob: new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }),
    pageCount,
    failures,
    formats: [...formats],
  };
}

/** HEIC / HEIF に対応していない端末では、その旨をはっきり伝える。 */
function heicHint(image: SourceImage, error: unknown): string {
  if (isHeic(image.format)) {
    return 'この端末ではHEIC・HEIF画像を読み込めませんでした。写真アプリからJPEGとして書き出してから追加してください。';
  }
  if (error instanceof AppError) return error.message;
  return '画像を読み込めませんでした。';
}

/* ------------------------------------------------------------------ */
/* 旧 API との互換                                                      */
/* ------------------------------------------------------------------ */

/**
 * 複数の画像を 1 つの PDF にまとめる (カメラスキャンなど、設定なしで作る経路)。
 * 既定は A4 縦・標準画質・余白ありの全体表示。
 */
export async function imagesToPdf(images: Blob[]): Promise<Blob> {
  const sources = images.map((blob, index) => toSourceImage(blob, `image-${index + 1}`, index));
  const result = await buildImagePdf(sources, DEFAULT_IMAGE_PDF_OPTIONS);
  return result.blob;
}

/**
 * 端末機能との連携。
 *
 * スマートフォンの Web アプリからは、端末内の実フォルダーを直接読み書きできない。
 * そのため書き出しは「共有シート」または「ダウンロード」に限定される。
 * ここでは各 OS で実際に動作する手段だけを扱い、できないことは呼び出し側へ
 * `false` を返して伝える。
 */
import { AppError } from './errors';

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13 以降は Macintosh を名乗るため、タッチ対応で判定する
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** ファイル共有 (Web Share API Level 2) に対応しているか。 */
export function canShareFiles(file?: File): boolean {
  if (typeof navigator === 'undefined' || !navigator.canShare || !navigator.share) return false;
  if (!file) return true;
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export function toFile(blob: Blob, name: string): File {
  return new File([blob], name, { type: 'application/pdf' });
}

/**
 * 共有シートを開く。
 * iOS では共有シートから「ファイルに保存」を選べる。
 * Android では共有先アプリの選択、または保存先の選択ができる。
 * @returns 共有シートを開けたか
 */
export async function sharePdf(blob: Blob, name: string): Promise<boolean> {
  const file = toFile(blob, name);
  if (!canShareFiles(file)) return false;
  try {
    await navigator.share({ files: [file], title: name });
    return true;
  } catch (error) {
    // ユーザーが共有シートを閉じた場合は失敗扱いにしない
    if (error instanceof DOMException && error.name === 'AbortError') return true;
    throw new AppError('SHARE_FAILED');
  }
}

/**
 * 端末へ保存する。
 * Android: ダウンロードフォルダーへ保存される。
 * iOS: 新しいタブで開き、共有シートから「ファイルに保存」を選ぶ流れになる。
 */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Safari が読み終える前に revoke すると失敗するため遅延させる
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 他アプリで開く (共有シート経由)。対応していない場合は false。 */
export async function openWithOtherApp(blob: Blob, name: string): Promise<boolean> {
  if (await sharePdf(blob, name)) return true;
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return Boolean(opened);
}

/** 印刷ダイアログを開く (非表示 iframe 経由)。 */
export async function printPdf(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  frame.src = url;
  document.body.appendChild(frame);

  await new Promise<void>((resolve) => {
    frame.onload = () => resolve();
    setTimeout(resolve, 3000);
  });

  try {
    const target = frame.contentWindow;
    if (!target) throw new AppError('PRINT_FAILED');
    target.focus();
    target.print();
  } catch {
    // iOS Safari は iframe 内 PDF の print() を許可しないため、
    // 新しいタブで開いて OS の共有メニューから印刷してもらう
    const opened = window.open(url, '_blank');
    if (!opened) throw new AppError('PRINT_FAILED');
  } finally {
    setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 60_000);
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* フォールバックへ */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * 使い捨ての canvas を解放する。
 * iOS Safari はページ全体で確保できる canvas メモリに上限があり、
 * 使い終わった canvas を放置したまま上限に達すると、それ以降の描画が
 * 無視されて「真っ白なまま何も表示されない」状態になる。
 * サイズを 0 にすると確保していたメモリが即座に解放される。
 */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/** 触覚フィードバック (対応端末のみ)。 */
export function vibrate(pattern: number | number[] = 12): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* 非対応端末では何もしない */
  }
}

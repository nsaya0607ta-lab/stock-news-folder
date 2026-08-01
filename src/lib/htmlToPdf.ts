'use client';

/**
 * ブラウザー内で HTML から PDF を作る共通処理。
 * Gemini の資料作成と、株式ニュースレポートの「今すぐ取得」で共有している。
 *
 * サーバー側の定期処理は Puppeteer を使うため、こちらは端末で即座に
 * 結果を確認したいときの経路になる。
 */

const HTML2PDF_URL =
  'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let loader: Promise<void> | null = null;

export function loadHtml2Pdf(): Promise<void> {
  if ((window as any).html2pdf) return Promise.resolve();
  if (loader) return loader;

  const promise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${HTML2PDF_URL}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener(
        'error',
        () => reject(new Error('PDF作成ライブラリを読み込めませんでした')),
        { once: true },
      );
      return;
    }

    const script = document.createElement('script');
    script.src = HTML2PDF_URL;
    script.async = true;
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener(
      'error',
      () => reject(new Error('PDF作成ライブラリを読み込めませんでした')),
      { once: true },
    );
    document.head.append(script);
  }).catch((error) => {
    loader = null;
    throw error;
  });

  loader = promise;
  return promise;
}

export type HtmlToPdfOptions = {
  /** 画面外へ置く要素の幅（用紙幅に合わせる）。 */
  width?: string;
  /** 余白 (mm)。 */
  marginMm?: number;
  /** ページ分割で分断させたくない要素のセレクター。 */
  avoid?: string[];
  /** 変換対象の要素を選ぶセレクター（省略時は全体）。 */
  selector?: string;
};

/**
 * HTML 文字列を A4 の PDF Blob に変換する。
 * `<a href>` はリンク注釈として PDF に残る（html2pdf の enableLinks）。
 */
export async function htmlToPdfBlob(html: string, options: HtmlToPdfOptions = {}): Promise<Blob> {
  await loadHtml2Pdf();
  const wrapper = document.createElement('div');
  wrapper.style.position = 'fixed';
  wrapper.style.left = '-100000px';
  wrapper.style.top = '0';
  wrapper.style.width = options.width ?? '210mm';
  wrapper.style.background = '#ffffff';
  wrapper.innerHTML = html;
  document.body.append(wrapper);

  try {
    const html2pdf = (window as any).html2pdf;
    if (!html2pdf) throw new Error('PDF作成ライブラリを読み込めませんでした');
    const target = options.selector ? wrapper.querySelector(options.selector) : wrapper;
    const worker = html2pdf()
      .set({
        margin: options.marginMm ?? 0,
        enableLinks: true,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          letterRendering: true,
          backgroundColor: '#ffffff',
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
        pagebreak: {
          mode: ['css', 'legacy'],
          avoid: options.avoid ?? ['table', 'tr', 'blockquote', '.avoid-break'],
        },
      })
      .from(target ?? wrapper);
    return (await worker.outputPdf('blob')) as Blob;
  } finally {
    wrapper.remove();
  }
}

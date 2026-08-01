'use client';

/**
 * 編集画面のページ一覧に出すサムネイル。
 *
 * 同じ PDF の同じページは 1 回だけ描画してキャッシュする (複製ページも同じ絵を使う)。
 * 大きな PDF でも固まらないよう、1 枚ずつ順番に描画する。
 */
import { useEffect, useRef, useState } from 'react';
import { openDocument, renderPageThumbnail, type PdfDocumentProxy } from '@/lib/pdf';
import type { EditAssets, EditPage } from '@/lib/pdfEdit';

/** サムネイルのキャッシュキー。 */
function thumbKey(page: EditPage): string {
  if (page.source.kind === 'doc') return `${page.source.docId}:${page.source.index}`;
  if (page.source.kind === 'image') return `img:${page.source.imageId}`;
  return `blank:${Math.round(page.source.width)}x${Math.round(page.source.height)}`;
}

export function usePageThumbs(pages: EditPage[], assets: EditAssets) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const cache = useRef(new Map<string, string>());
  const docs = useRef(new Map<string, Promise<PdfDocumentProxy | null>>());
  const running = useRef(false);
  const disposed = useRef(false);

  useEffect(() => {
    disposed.current = false;
    const urlCache = cache.current;
    const docCache = docs.current;
    return () => {
      disposed.current = true;
      for (const url of urlCache.values()) URL.revokeObjectURL(url);
      urlCache.clear();
      for (const promise of docCache.values()) {
        void promise.then((doc) => doc?.destroy()).catch(() => undefined);
      }
      docCache.clear();
    };
  }, []);

  useEffect(() => {
    if (running.current) return;

    const missing = pages.filter((page) => !cache.current.has(thumbKey(page)));
    if (missing.length === 0) return;

    running.current = true;
    void (async () => {
      try {
        for (const page of missing) {
          if (disposed.current) return;
          const key = thumbKey(page);
          if (cache.current.has(key)) continue;

          let blob: Blob | null = null;

          if (page.source.kind === 'doc') {
            const { docId, index } = page.source;
            let job = docs.current.get(docId);
            if (!job) {
              const bytes = assets.docs.get(docId);
              job = bytes
                ? // ArrayBuffer を渡すと pdf.js 側で中身を移譲されるため、複製して渡す
                  openDocument(new Blob([bytes.slice() as unknown as BlobPart], { type: 'application/pdf' }))
                    .then((doc) => doc)
                    .catch(() => null)
                : Promise.resolve(null);
              docs.current.set(docId, job);
            }
            const doc = await job;
            if (doc) blob = await renderPageThumbnail(doc, index + 1, 180);
          } else if (page.source.kind === 'image') {
            const image = assets.images.get(page.source.imageId);
            if (image) {
              blob = new Blob([image.data.slice() as unknown as BlobPart], { type: 'image/jpeg' });
            }
          }

          if (disposed.current) return;
          if (blob) {
            const url = URL.createObjectURL(blob);
            cache.current.set(key, url);
            setUrls((current) => ({ ...current, [key]: url }));
          } else {
            // 描画できないページも空白として扱い、再試行の無限ループにしない
            cache.current.set(key, '');
            setUrls((current) => ({ ...current, [key]: '' }));
          }
        }
      } finally {
        running.current = false;
      }
    })();
  }, [assets, pages, urls]);

  return (page: EditPage): string | undefined => {
    const url = urls[thumbKey(page)];
    return url || undefined;
  };
}

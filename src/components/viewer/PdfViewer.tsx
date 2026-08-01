'use client';

/**
 * 全画面 PDF ビューアー。
 * pdf.js で 1 ページずつ canvas に描画し、拡大縮小・ページ移動に対応する。
 * ピンチ中は canvas を再描画せず CSS transform だけで追従し、指を離した時に
 * 最終倍率で一度だけ高解像度描画することで、iPhoneでも滑らかに拡大できる。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  Minus,
  NotebookPen,
  Plus,
  X,
} from 'lucide-react';
import { releaseCanvas } from '@/lib/device';
import { openDocument, type PdfDocumentProxy } from '@/lib/pdf';
import { toMessage } from '@/lib/errors';
import type { PdfFileMeta } from '@/lib/types';
import { IconButton, Spinner, cx } from '@/components/ui/Primitives';

const MIN_SCALE = 0.5;
const MAX_SCALE = 5;

/**
 * canvas の上限。iOS Safari は 1 辺 4096px / 総面積 16.7M px を超えると
 * 描画結果を捨てて「真っ白なページ」になるため、安全な範囲まで解像度を落とす。
 */
const MAX_CANVAS_SIDE = 4096;
const MAX_CANVAS_AREA = 16_777_216;

function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

/** CSS サイズ (width x height) を描画できる最大のピクセル比を返す。 */
function safePixelRatio(width: number, height: number) {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const bySide = Math.min(MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / height);
  const byArea = Math.sqrt(MAX_CANVAS_AREA / (width * height));
  return Math.max(0.1, Math.min(ratio, bySide, byArea));
}

type ViewAnchor = {
  x: number;
  y: number;
  viewportX: number;
  viewportY: number;
};

type PinchState = {
  startDistance: number;
  startScale: number;
  previewScale: number;
  anchorX: number;
  anchorY: number;
  originX: number;
  originY: number;
  viewportX: number;
  viewportY: number;
};

export function PdfViewer({
  file,
  blob,
  initialPage,
  jumpTo,
  locked = false,
  onClose,
  onMenu,
  onMemo,
  onPageChange,
}: {
  file: PdfFileMeta;
  blob: Blob;
  /** 開いた直後に表示するページ (検索結果やメモから開いたとき)。 */
  initialPage?: number;
  /** 外側からのページ移動要求。同じページを続けて指定できるよう seq で判定する。 */
  jumpTo?: { page: number; seq: number } | null;
  /**
   * メモなどのシートを開いている間 true。
   * 背面の PDF が指の動きで勝手にスクロール・拡大しないようにする。
   */
  locked?: boolean;
  onClose: () => void;
  onMenu: () => void;
  onMemo: () => void;
  onPageChange?: (page: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const zoomLabelRef = useRef<HTMLSpanElement | null>(null);
  const docRef = useRef<PdfDocumentProxy | null>(null);
  const renderTask = useRef<{ promise: Promise<void>; cancel: () => void } | null>(null);
  const renderSeq = useRef(0);
  const drawnCanvas = useRef<HTMLCanvasElement | null>(null);
  const scaleRef = useRef(1);
  const anchor = useRef<ViewAnchor | null>(null);
  const pinch = useRef<PinchState | null>(null);
  const pinchFrame = useRef<number | null>(null);

  const [pageCount, setPageCount] = useState(file.pageCount ?? 0);
  const [page, setPage] = useState(Math.max(1, Math.floor(initialPage ?? 1)));
  const [scale, setScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [pageInput, setPageInput] = useState('1');

  useEffect(() => {
    scaleRef.current = scale;
    if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(scale * 100)}%`;
  }, [scale]);

  const clearPinchPreview = useCallback((labelScale = scaleRef.current) => {
    if (pinchFrame.current != null) {
      cancelAnimationFrame(pinchFrame.current);
      pinchFrame.current = null;
    }
    const content = contentRef.current;
    if (content) {
      content.style.transform = '';
      content.style.transformOrigin = '';
      content.style.willChange = '';
    }
    if (zoomLabelRef.current) {
      zoomLabelRef.current.textContent = `${Math.round(labelScale * 100)}%`;
    }
  }, []);

  /* 読み込み ---------------------------------------------------------- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const doc = await openDocument(blob);
        if (cancelled) {
          void doc.destroy();
          return;
        }
        docRef.current = doc;
        setPageCount(doc.numPages);
        setLoading(false);
      } catch (loadError) {
        if (!cancelled) {
          setError(toMessage(loadError));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      clearPinchPreview();
      renderSeq.current += 1;
      const task = renderTask.current;
      const doc = docRef.current;
      renderTask.current = null;
      docRef.current = null;
      task?.cancel();
      void Promise.resolve(task?.promise)
        .catch(() => undefined)
        .then(() => {
          if (drawnCanvas.current) releaseCanvas(drawnCanvas.current);
          drawnCanvas.current = null;
          return doc?.destroy();
        })
        .catch(() => undefined);
    };
  }, [blob, clearPinchPreview]);

  /* 拡大時の表示位置 --------------------------------------------------- */
  const captureAnchor = useCallback((viewportX?: number, viewportY?: number) => {
    const el = containerRef.current;
    if (!el) return;
    const x = viewportX ?? el.clientWidth / 2;
    const y = viewportY ?? el.clientHeight / 2;
    anchor.current = {
      x: (el.scrollLeft + x) / Math.max(1, el.scrollWidth),
      y: (el.scrollTop + y) / Math.max(1, el.scrollHeight),
      viewportX: x,
      viewportY: y,
    };
  }, []);

  const applyAnchor = useCallback(() => {
    const el = containerRef.current;
    const point = anchor.current;
    if (!el || !point) return;
    anchor.current = null;
    el.scrollLeft = Math.max(0, point.x * el.scrollWidth - point.viewportX);
    el.scrollTop = Math.max(0, point.y * el.scrollHeight - point.viewportY);
  }, []);

  /* 描画 -------------------------------------------------------------- */
  const renderPage = useCallback(async () => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!doc || !canvas || !container) return;

    const seq = renderSeq.current + 1;
    renderSeq.current = seq;

    const previous = renderTask.current;
    if (previous) {
      previous.cancel();
      await previous.promise.catch(() => undefined);
      if (seq !== renderSeq.current) return;
    }

    try {
      const target = await doc.getPage(page);
      if (seq !== renderSeq.current) return;

      const base = target.getViewport({ scale: 1 });
      const available = container.clientWidth - 16;
      const fit = available > 0 ? available / base.width : 1;
      const viewport = target.getViewport({ scale: fit * scale });
      const dpr = safePixelRatio(viewport.width, viewport.height);

      // ピンチ中の見た目の倍率と、これから描画する実倍率は同じため、同一フレーム内で
      // CSS transformを外してcanvasのCSSサイズを更新すると大きさが跳ねにくい。
      clearPinchPreview(scale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      applyAnchor();

      drawnCanvas.current = canvas;
      const context = canvas.getContext('2d');
      if (!context) return;

      const task = target.render({
        canvasContext: context,
        viewport,
        transform: [dpr, 0, 0, dpr, 0, 0],
      });
      renderTask.current = task;
      await task.promise;
      if (seq === renderSeq.current) {
        renderTask.current = null;
        target.cleanup();
      }
    } catch (renderError) {
      const message = renderError instanceof Error ? renderError.message : '';
      if (seq === renderSeq.current && !/cancel/i.test(message)) setError(toMessage(renderError));
    }
  }, [applyAnchor, clearPinchPreview, page, scale]);

  useEffect(() => {
    if (loading || error) return;
    void renderPage();
  }, [error, loading, renderPage]);

  useEffect(() => {
    const onResize = () => {
      captureAnchor();
      void renderPage();
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [captureAnchor, renderPage]);

  useEffect(() => {
    setPageInput(String(page));
    onPageChange?.(page);
  }, [onPageChange, page]);

  /* 外側からのページ移動 (メモ・検索結果から「該当ページへ」) ---------- */
  const lastJump = useRef(-1);
  useEffect(() => {
    if (!jumpTo || jumpTo.seq === lastJump.current) return;
    lastJump.current = jumpTo.seq;
    const target = Math.max(1, Math.min(pageCount || jumpTo.page, Math.floor(jumpTo.page)));
    pinch.current = null;
    clearPinchPreview();
    anchor.current = null;
    setPage(target);
    containerRef.current?.scrollTo({ top: 0, left: 0 });
  }, [clearPinchPreview, jumpTo, pageCount]);

  /** 指定ページが総ページ数を超えていた場合に収める (PDF編集後などに起こりうる)。 */
  useEffect(() => {
    if (pageCount > 0 && page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  /* シートを開いている間は背面のジェスチャーを止める -------------------- */
  const lockedRef = useRef(locked);
  useEffect(() => {
    lockedRef.current = locked;
    if (!locked) return;
    // 途中まで進んでいたピンチ操作を打ち切り、指を離した扱いにする
    pinch.current = null;
    clearPinchPreview();
  }, [clearPinchPreview, locked]);

  /* ピンチズームと指の移動 --------------------------------------------- */
  // ピンチ中はReact stateとpdf.js描画を更新しない。CSS transformをrAFで更新し、
  // 指を離した時だけsetScaleして最終倍率を一度描画する。
  const gestured = useRef(false);
  const moved = useRef(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    const content = contentRef.current;
    if (!el || !content) return;

    const applyPreview = () => {
      pinchFrame.current = null;
      const current = pinch.current;
      if (!current) return;
      const ratio = current.previewScale / current.startScale;
      content.style.willChange = 'transform';
      content.style.transformOrigin = `${current.originX}px ${current.originY}px`;
      content.style.transform = `scale(${ratio})`;
      if (zoomLabelRef.current) {
        zoomLabelRef.current.textContent = `${Math.round(current.previewScale * 100)}%`;
      }
    };

    const schedulePreview = () => {
      if (pinchFrame.current != null) return;
      pinchFrame.current = requestAnimationFrame(applyPreview);
    };

    const midpoint = (event: TouchEvent) => {
      const [a, b] = [event.touches[0], event.touches[1]];
      return {
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
        distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
      };
    };

    const onStart = (event: TouchEvent) => {
      // シートを開いている間は背面を動かさない
      if (lockedRef.current) return;
      if (event.touches.length === 1) {
        gestured.current = false;
        moved.current = false;
        touchStart.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
        return;
      }

      if (event.touches.length === 2) {
        if (event.cancelable) event.preventDefault();
        gestured.current = true;
        touchStart.current = null;

        const mid = midpoint(event);
        const rect = el.getBoundingClientRect();
        const viewportX = mid.x - rect.left;
        const viewportY = mid.y - rect.top;
        const originX = el.scrollLeft + viewportX;
        const originY = el.scrollTop + viewportY;
        const startScale = scaleRef.current;

        pinch.current = {
          startDistance: mid.distance,
          startScale,
          previewScale: startScale,
          anchorX: originX / Math.max(1, el.scrollWidth),
          anchorY: originY / Math.max(1, el.scrollHeight),
          originX,
          originY,
          viewportX,
          viewportY,
        };
      }
    };

    const onMove = (event: TouchEvent) => {
      if (lockedRef.current) return;
      if (event.touches.length === 1) {
        const start = touchStart.current;
        if (start) {
          const dx = Math.abs(event.touches[0].clientX - start.x);
          const dy = Math.abs(event.touches[0].clientY - start.y);
          if (dx > 8 || dy > 8) moved.current = true;
        }
        return;
      }

      const current = pinch.current;
      if (event.touches.length !== 2 || !current) return;
      if (event.cancelable) event.preventDefault();

      const mid = midpoint(event);
      const rect = el.getBoundingClientRect();
      current.previewScale = clampScale((current.startScale * mid.distance) / current.startDistance);
      current.viewportX = mid.x - rect.left;
      current.viewportY = mid.y - rect.top;
      anchor.current = {
        x: current.anchorX,
        y: current.anchorY,
        viewportX: current.viewportX,
        viewportY: current.viewportY,
      };
      schedulePreview();
    };

    const finishPinch = (event: TouchEvent) => {
      if (event.touches.length >= 2) return;
      const current = pinch.current;
      pinch.current = null;
      if (!current) {
        if (event.touches.length === 0) touchStart.current = null;
        return;
      }

      if (pinchFrame.current != null) {
        cancelAnimationFrame(pinchFrame.current);
        pinchFrame.current = null;
        const ratio = current.previewScale / current.startScale;
        content.style.willChange = 'transform';
        content.style.transformOrigin = `${current.originX}px ${current.originY}px`;
        content.style.transform = `scale(${ratio})`;
      }

      const finalScale = Number(clampScale(current.previewScale).toFixed(3));
      if (Math.abs(finalScale - scaleRef.current) < 0.001) {
        clearPinchPreview(scaleRef.current);
      } else {
        scaleRef.current = finalScale;
        setScale(finalScale);
      }

      if (event.touches.length === 1) {
        touchStart.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
        moved.current = true;
      } else {
        touchStart.current = null;
      }
    };

    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', finishPinch);
    el.addEventListener('touchcancel', finishPinch);

    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', finishPinch);
      el.removeEventListener('touchcancel', finishPinch);
      clearPinchPreview();
      pinch.current = null;
    };
  }, [clearPinchPreview, error, loading]);

  /** 本文のタップ。指を動かした後やピンチ直後は開閉しない。 */
  const onSurfaceClick = () => {
    if (locked) return;
    if (gestured.current || moved.current) {
      gestured.current = false;
      moved.current = false;
      return;
    }
    setChromeVisible((value) => !value);
  };

  const changePage = (delta: number) => {
    pinch.current = null;
    clearPinchPreview();
    setPage((current) => Math.min(pageCount || 1, Math.max(1, current + delta)));
    anchor.current = null;
    containerRef.current?.scrollTo({ top: 0, left: 0 });
  };

  const zoom = (delta: number) => {
    captureAnchor();
    setScale((current) => Number(clampScale(current + delta).toFixed(2)));
  };

  const resetZoom = () => {
    pinch.current = null;
    clearPinchPreview(1);
    anchor.current = null;
    scaleRef.current = 1;
    setScale(1);
    containerRef.current?.scrollTo({ top: 0, left: 0 });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // シートを開いている間は、その場でのキー操作を優先する
      if (locked) return;
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') changePage(1);
      if (event.key === 'ArrowLeft') changePage(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, onClose, pageCount]);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#20262d]">
      <div
        className={cx(
          'flex shrink-0 items-center gap-1 bg-[#171c22] px-1 transition-transform',
          chromeVisible ? 'translate-y-0' : '-translate-y-full',
        )}
        style={{ paddingTop: 'var(--safe-top)' }}
      >
        <IconButton label="閉じる" onClick={onClose} className="text-white">
          <X size={22} />
        </IconButton>
        <p className="min-w-0 flex-1 truncate text-sm text-white">{file.name}</p>
        <IconButton label="メモ" onClick={onMemo} className="text-white">
          <NotebookPen size={21} />
        </IconButton>
        <IconButton label="操作メニュー" onClick={onMenu} className="text-white">
          <MoreVertical size={22} />
        </IconButton>
      </div>

      <div
        ref={containerRef}
        onClick={onSurfaceClick}
        className={cx(
          'pdf-surface flex-1 bg-[#20262d]',
          // シート表示中は背面が動かないよう、スクロールもタップも受け付けない
          locked ? 'overflow-hidden [touch-action:none]' : 'overflow-auto',
        )}
        style={locked ? { pointerEvents: 'none' } : undefined}
      >
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="h-8 w-8 border-[#4a5563] border-t-white" />
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-8 text-center">
            <p className="text-base text-white">{error}</p>
          </div>
        ) : (
          <div
            ref={contentRef}
            className="flex min-h-full w-max min-w-full items-start justify-center p-2"
          >
            <canvas ref={canvasRef} className="block h-auto max-w-none shadow-pop" />
          </div>
        )}
      </div>

      <div
        className={cx(
          'shrink-0 bg-[#171c22] transition-transform',
          chromeVisible ? 'translate-y-0' : 'translate-y-full',
        )}
        style={{ paddingBottom: 'var(--safe-bottom)' }}
      >
        <div className="flex items-center justify-between gap-1 px-1 py-1">
          <IconButton
            label="前のページ"
            onClick={() => changePage(-1)}
            disabled={page <= 1}
            className="text-white disabled:opacity-30"
          >
            <ChevronLeft size={24} />
          </IconButton>

          <div className="flex items-center gap-1.5 text-sm text-white">
            <input
              type="number"
              inputMode="numeric"
              value={pageInput}
              min={1}
              max={pageCount || 1}
              onChange={(event) => setPageInput(event.target.value)}
              onBlur={() => {
                const value = Number(pageInput);
                if (Number.isFinite(value) && value >= 1 && value <= (pageCount || 1)) {
                  setPage(Math.floor(value));
                } else {
                  setPageInput(String(page));
                }
              }}
              aria-label="ページ番号"
              className="h-9 w-16 rounded-[4px] border border-[#3a444f] bg-[#20262d] px-2 text-center text-white"
            />
            <span className="whitespace-nowrap">/ {pageCount || '-'} ページ</span>
          </div>

          <div className="flex items-center">
            <IconButton label="縮小" onClick={() => zoom(-0.25)} className="text-white">
              <Minus size={20} />
            </IconButton>
            <button
              type="button"
              onClick={resetZoom}
              className="min-w-[52px] px-1 text-sm text-white"
              aria-label="表示倍率をリセット"
            >
              <span ref={zoomLabelRef}>{`${Math.round(scale * 100)}%`}</span>
            </button>
            <IconButton label="拡大" onClick={() => zoom(0.25)} className="text-white">
              <Plus size={20} />
            </IconButton>
          </div>

          <IconButton
            label="次のページ"
            onClick={() => changePage(1)}
            disabled={pageCount > 0 && page >= pageCount}
            className="text-white disabled:opacity-30"
          >
            <ChevronRight size={24} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

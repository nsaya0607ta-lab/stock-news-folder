'use client';

import { useCallback, useRef } from 'react';
import { vibrate } from '@/lib/device';

type Options = { delay?: number; moveTolerance?: number };

/**
 * 長押し検出。
 * タップ (短押し) と長押しを 1 つの要素で扱えるようにする。
 * 指が動いた場合はスクロール操作とみなして長押しを取り消す。
 */
export function useLongPress(
  onLongPress: () => void,
  onClick?: () => void,
  { delay = 500, moveTolerance = 12 }: Options = {},
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button && event.button !== 0) return;
      fired.current = false;
      start.current = { x: event.clientX, y: event.clientY };
      clear();
      timer.current = setTimeout(() => {
        fired.current = true;
        vibrate(14);
        onLongPress();
      }, delay);
    },
    [clear, delay, onLongPress],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!start.current) return;
      const dx = Math.abs(event.clientX - start.current.x);
      const dy = Math.abs(event.clientY - start.current.y);
      if (dx > moveTolerance || dy > moveTolerance) clear();
    },
    [clear, moveTolerance],
  );

  const onPointerUp = useCallback(() => {
    clear();
    if (!fired.current) onClick?.();
    start.current = null;
  }, [clear, onClick]);

  const onPointerCancel = useCallback(() => {
    clear();
    start.current = null;
  }, [clear]);

  const onContextMenu = useCallback((event: React.MouseEvent) => {
    // 長押しでブラウザーの標準メニューが出ないようにする
    event.preventDefault();
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onContextMenu };
}

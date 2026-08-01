'use client';

import type { ReactNode } from 'react';

/** 画面上部の固定ヘッダー。ノッチ分の余白を確保する。 */
export function Header({
  title,
  subtitle,
  left,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  left?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header
      className="sticky top-0 z-30 border-b divider bg-surface/95 backdrop-blur dark:bg-[#181e26]/95"
      style={{ paddingTop: 'var(--safe-top)' }}
    >
      <div className="flex min-h-[52px] items-center gap-1 px-1.5">
        {left}
        <div className="min-w-0 flex-1 px-1.5">
          <h1 className="truncate text-lg font-semibold text-ink dark:text-[#e6eaef]">{title}</h1>
          {subtitle ? (
            <p className="truncate text-xs text-ink-sub dark:text-[#98a3b0]">{subtitle}</p>
          ) : null}
        </div>
        {right}
      </div>
      {children}
    </header>
  );
}

'use client';

/**
 * 画面下から出るシートと、中央に出るダイアログ。
 *
 * 重なり順は、全画面のPDFビューアー (z-60) とPDF編集画面 (z-64) より前面、
 * 処理中の表示 (z-80) とトースト (z-90) より背面に置く。
 * ビューアーの操作メニューやメモをビューアーの上に出すために必要。
 */
import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton, cx } from './Primitives';

function useLockBodyScroll(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);
}

export function Backdrop({ onClick }: { onClick?: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[72] animate-fade-in bg-[rgba(15,23,32,0.45)]"
      onClick={onClick}
      aria-hidden="true"
    />
  );
}

export function BottomSheet({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  maxHeight = '82vh',
}: {
  open: boolean;
  title?: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  maxHeight?: string;
}) {
  useLockBodyScroll(open);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <>
      <Backdrop onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed inset-x-0 bottom-0 z-[74] animate-sheet-up rounded-t-sheet border-t border-line bg-surface shadow-sheet dark:border-[#2a333d] dark:bg-[#181e26]"
        style={{ paddingBottom: 'var(--safe-bottom)' }}
      >
        <div className="flex items-start justify-between gap-3 px-4 pb-2 pt-3">
          <div className="min-w-0 flex-1">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line dark:bg-[#3a444f]" />
            {title ? (
              <h2 className="truncate text-lg font-semibold text-ink dark:text-[#e6eaef]">{title}</h2>
            ) : null}
            {description ? (
              <p className="mt-1 text-sm text-ink-sub dark:text-[#98a3b0]">{description}</p>
            ) : null}
          </div>
          <IconButton label="閉じる" onClick={onClose} className="-mr-2 mt-2">
            <X size={22} />
          </IconButton>
        </div>
        <div className="sheet-scroll overflow-y-auto overscroll-contain" style={{ maxHeight }}>
          {children}
        </div>
        {footer ? (
          <div className="border-t divider px-4 py-3">{footer}</div>
        ) : null}
      </div>
    </>
  );
}

export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  useLockBodyScroll(open);
  if (!open) return null;
  return (
    <>
      <Backdrop onClick={onClose} />
      <div className="fixed inset-0 z-[74] flex items-center justify-center p-5">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="w-full max-w-sm animate-fade-in rounded-sheet border border-line bg-surface p-4 shadow-pop dark:border-[#2a333d] dark:bg-[#181e26]"
        >
          <h2 className="text-lg font-semibold text-ink dark:text-[#e6eaef]">{title}</h2>
          {description ? (
            <p className="mt-2 text-sm leading-relaxed text-ink-sub dark:text-[#98a3b0]">
              {description}
            </p>
          ) : null}
          {children ? <div className="mt-3">{children}</div> : null}
          {footer ? <div className="mt-4 flex justify-end gap-2">{footer}</div> : null}
        </div>
      </div>
    </>
  );
}

/** シート内で使う縦並びのメニュー行。 */
export function MenuRow({
  icon,
  label,
  description,
  onClick,
  tone = 'default',
  disabled,
  trailing,
}: {
  icon: ReactNode;
  label: string;
  description?: string;
  onClick?: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'flex min-h-tap w-full items-center gap-3 px-4 py-2.5 text-left transition-colors active:bg-surface-sub disabled:opacity-40 dark:active:bg-[#232b35]',
        tone === 'danger' ? 'text-pdf dark:text-[#f08a80]' : 'text-ink dark:text-[#e6eaef]',
      )}
    >
      <span className={cx('shrink-0', tone === 'danger' ? '' : 'text-ink-sub dark:text-[#98a3b0]')}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base">{label}</span>
        {description ? (
          <span className="block truncate text-xs text-ink-sub dark:text-[#98a3b0]">
            {description}
          </span>
        ) : null}
      </span>
      {trailing}
    </button>
  );
}

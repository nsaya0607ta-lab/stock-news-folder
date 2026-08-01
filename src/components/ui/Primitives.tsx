'use client';

/** 画面全体で使い回す小さな UI 部品。タップ領域は 44px 以上を確保する。 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const base =
    'inline-flex min-h-tap items-center justify-center gap-2 rounded-card px-4 text-base font-medium transition-colors disabled:opacity-45';
  const styles: Record<ButtonVariant, string> = {
    primary: 'bg-brand-500 text-white active:bg-brand-600 disabled:bg-brand-300',
    secondary:
      'border border-line bg-surface text-ink active:bg-surface-sub dark:border-[#333d49] dark:bg-[#1b222a] dark:text-[#e6eaef] dark:active:bg-[#232b35]',
    ghost: 'text-brand-500 active:bg-brand-50 dark:text-brand-300 dark:active:bg-[#1b222a]',
    danger: 'bg-pdf text-white active:bg-pdf-dark',
  };
  return (
    <button type="button" className={cx(base, styles[variant], className)} {...props}>
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex h-tap w-tap shrink-0 items-center justify-center rounded-card text-ink-sub transition-colors active:bg-line/60 dark:text-[#aab4c0] dark:active:bg-[#252d37]',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 pb-2 pt-4">
      <h2 className="text-sm font-semibold tracking-wide text-ink-sub dark:text-[#98a3b0]">
        {children}
      </h2>
      {action}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-8 py-16 text-center">
      <div className="text-ink-faint dark:text-[#6c7887]">{icon}</div>
      <p className="text-base font-medium text-ink dark:text-[#e6eaef]">{title}</p>
      {description ? (
        <p className="max-w-xs text-sm leading-relaxed text-ink-sub dark:text-[#98a3b0]">
          {description}
        </p>
      ) : null}
      {action}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'brand' | 'warn';
}) {
  const tones = {
    neutral:
      'bg-surface-sub text-ink-sub border-line dark:bg-[#232b35] dark:text-[#aab4c0] dark:border-[#333d49]',
    brand: 'bg-brand-50 text-brand-600 border-brand-100 dark:bg-[#16233a] dark:text-brand-200 dark:border-[#24354f]',
    warn: 'bg-[#fdf3e2] text-folder-dark border-[#f2ddb0] dark:bg-[#332a17] dark:text-folder-light dark:border-[#4a3d20]',
  };
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-xs font-medium',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        'inline-block h-5 w-5 animate-spin rounded-full border-2 border-line border-t-brand-500',
        className,
      )}
      role="status"
      aria-label="読み込み中"
    />
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative h-7 w-12 shrink-0 rounded-full border transition-colors',
        checked
          ? 'border-brand-500 bg-brand-500'
          : 'border-line bg-line/70 dark:border-[#3a444f] dark:bg-[#39434f]',
      )}
    >
      <span
        className={cx(
          'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[22px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

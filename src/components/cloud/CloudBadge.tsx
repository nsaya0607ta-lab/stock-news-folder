'use client';

/**
 * 一覧に出す「PDF 本体がどこにあるか」の表示。
 *
 *   端末内にある PDF … 何も表示しない
 *   クラウド保管済み … クラウドアイコン
 *   ダウンロード中   … 進捗
 *   アップロード中   … 進捗
 *   エラー           … 警告表示 (タップで再試行)
 */
import { AlertTriangle, Cloud, CloudDownload, CloudUpload } from 'lucide-react';
import { storageStateOf, type PdfFileMeta } from '@/lib/types';
import { useCloud } from '@/store/CloudStore';
import { cx } from '@/components/ui/Primitives';

function Percent({ value }: { value: number }) {
  return <span className="tabular-nums text-xs font-medium">{Math.max(0, Math.min(100, value))}%</span>;
}

export function CloudBadge({ file, className }: { file: PdfFileMeta; className?: string }) {
  const cloud = useCloud();
  const activity = cloud?.activity[file.id];
  const state = storageStateOf(file);

  if (activity) {
    const uploading = activity.phase === 'upload';
    return (
      <span
        className={cx(
          'inline-flex shrink-0 items-center gap-1 text-brand-500 dark:text-brand-300',
          className,
        )}
        aria-label={uploading ? 'クラウドへアップロード中' : 'クラウドからダウンロード中'}
        title={uploading ? 'クラウドへアップロード中' : 'クラウドからダウンロード中'}
      >
        {uploading ? <CloudUpload size={15} /> : <CloudDownload size={15} />}
        <Percent value={activity.percent} />
      </span>
    );
  }

  if (state === 'uploading' || state === 'downloading') {
    const uploading = state === 'uploading';
    return (
      <span
        className={cx(
          'inline-flex shrink-0 items-center gap-1 text-brand-500 dark:text-brand-300',
          className,
        )}
        aria-label={uploading ? 'クラウドへアップロード中' : 'クラウドからダウンロード中'}
      >
        {uploading ? <CloudUpload size={15} /> : <CloudDownload size={15} />}
        <span className="text-xs">処理中</span>
      </span>
    );
  }

  if (state === 'error') {
    const retry = cloud?.retry;
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          void retry?.(file.id);
        }}
        className={cx(
          'inline-flex min-h-0 shrink-0 items-center gap-1 rounded-[4px] px-1 py-0.5 text-pdf active:bg-[#fdecea] dark:active:bg-[#3a2220]',
          className,
        )}
        aria-label={`クラウド保管に失敗しました。タップで再試行します。${file.cloudError ?? ''}`}
        title={file.cloudError ?? 'クラウド保管に失敗しました'}
      >
        <AlertTriangle size={15} />
        <span className="text-xs font-medium">再試行</span>
      </button>
    );
  }

  if (state === 'cloud') {
    // 端末内にキャッシュがある場合も「クラウドにある」ことに変わりはないため同じ表示にする
    const cached = Boolean(file.localCachedAt);
    return (
      <Cloud
        size={15}
        className={cx('shrink-0 text-brand-500 dark:text-brand-300', className)}
        aria-label={cached ? 'クラウド保管済み（端末内にキャッシュあり）' : 'クラウド保管済み'}
        // 端末内にキャッシュがあるときだけ塗りつぶして区別できるようにする
        fill={cached ? 'currentColor' : 'none'}
      />
    );
  }

  return null;
}

/** クラウドから取得中に一覧へ出す細い進捗バー。 */
export function CloudProgressBar({ file }: { file: PdfFileMeta }) {
  const cloud = useCloud();
  const activity = cloud?.activity[file.id];
  if (!activity) return null;
  return (
    <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-line dark:bg-[#333d49]">
      <span
        className="block h-full rounded-full bg-brand-500 transition-[width]"
        style={{ width: `${Math.max(3, Math.min(100, activity.percent))}%` }}
      />
    </span>
  );
}

'use client';

/**
 * フォルダーと PDF のアイコン。
 * 絵文字は使わず、lucide-react のアイコンに色を付けて表現する。
 */
import { FileText, Folder as FolderGlyph } from 'lucide-react';
import type { FolderColor } from '@/lib/types';
import { cx } from './Primitives';

export const FOLDER_COLORS: { value: FolderColor; label: string; hex: string }[] = [
  { value: 'yellow', label: '既定（黄）', hex: '#e8a917' },
  { value: 'blue', label: '青', hex: '#2767c4' },
  { value: 'green', label: '緑', hex: '#2f8f5b' },
  { value: 'red', label: '赤', hex: '#c8342b' },
  { value: 'purple', label: '紫', hex: '#6f4bb5' },
  { value: 'gray', label: 'グレー', hex: '#7b8794' },
];

export function folderHex(color?: FolderColor): string {
  return FOLDER_COLORS.find((entry) => entry.value === color)?.hex ?? '#e8a917';
}

export function FolderIcon({
  color,
  size = 28,
  className,
}: {
  color?: FolderColor;
  size?: number;
  className?: string;
}) {
  const hex = folderHex(color);
  return (
    <FolderGlyph
      size={size}
      className={cx('shrink-0', className)}
      color={hex}
      fill={hex}
      strokeWidth={1.4}
      aria-hidden="true"
    />
  );
}

export function PdfIcon({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cx('relative inline-flex shrink-0 items-center justify-center', className)}
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      <FileText size={size} color="#c8342b" fill="#fdeceb" strokeWidth={1.5} />
      <span
        className="absolute bottom-[14%] rounded-[2px] bg-pdf px-[3px] font-bold leading-none text-white"
        style={{ fontSize: Math.max(6, size * 0.26) }}
      >
        PDF
      </span>
    </span>
  );
}

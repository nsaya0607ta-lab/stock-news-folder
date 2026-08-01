'use client';

import { useEffect, useState } from 'react';
import { Check, FilePlus2, NotebookPen, RefreshCw, X } from 'lucide-react';
import { formatBytes, formatDateTime } from '@/lib/format';
import { stripPdfExtension } from '@/lib/naming';
import { SORT_LABELS } from '@/lib/tree';
import { SUGGESTED_TAGS } from '@/lib/search';
import { storageStateOf } from '@/lib/types';
import type {
  FolderColor,
  Importance,
  PdfFileMeta,
  SortKey,
  StorageState,
  ViewMode,
} from '@/lib/types';
import { Button, Switch, cx } from '@/components/ui/Primitives';
import { BottomSheet, Dialog, MenuRow } from '@/components/ui/Sheet';
import { FOLDER_COLORS, FolderIcon } from '@/components/ui/FileIcons';

/* ------------------------------------------------------------------ */
/* 名前入力 (新規作成 / 名前変更)                                       */
/* ------------------------------------------------------------------ */

export function NameDialog({
  open,
  title,
  label,
  initialValue,
  confirmLabel,
  hint,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  label: string;
  initialValue: string;
  confirmLabel: string;
  hint?: string;
  onClose: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setError('');
    }
  }, [initialValue, open]);

  const submit = () => {
    if (!value.trim()) {
      setError(label === 'フォルダー名' ? 'フォルダー名を入力してください。' : 'ファイル名を入力してください。');
      return;
    }
    onSubmit(value.trim());
  };

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <label className="block text-sm text-ink-sub dark:text-[#98a3b0]" htmlFor="name-input">
        {label}
      </label>
      <input
        id="name-input"
        autoFocus
        className="field mt-1.5"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setError('');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
        }}
      />
      {hint ? <p className="mt-2 text-xs text-ink-sub dark:text-[#98a3b0]">{hint}</p> : null}
      {error ? <p className="mt-2 text-sm text-pdf">{error}</p> : null}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* 確認ダイアログ                                                      */
/* ------------------------------------------------------------------ */

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  tone = 'primary',
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            キャンセル
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}

/* ------------------------------------------------------------------ */
/* 同名ファイルの扱い                                                  */
/* ------------------------------------------------------------------ */

export function DuplicateDialog({
  open,
  fileName,
  suggestedName,
  remaining,
  onClose,
  onChoose,
}: {
  open: boolean;
  fileName: string;
  suggestedName: string;
  remaining: number;
  onClose: () => void;
  onChoose: (choice: 'overwrite' | 'rename' | 'cancel', applyToAll: boolean) => void;
}) {
  const [applyToAll, setApplyToAll] = useState(false);

  useEffect(() => {
    if (open) setApplyToAll(false);
  }, [open]);

  return (
    <Dialog
      open={open}
      title="同じ名前のファイルがあります"
      description={`「${fileName}」はこのフォルダーにすでに存在します。どうしますか？`}
      onClose={onClose}
    >
      <div className="overflow-hidden rounded-card border border-line dark:border-[#333d49]">
        <MenuRow
          icon={<FilePlus2 size={20} />}
          label="別名で保存"
          description={suggestedName}
          onClick={() => onChoose('rename', applyToAll)}
        />
        <div className="border-t divider" />
        <MenuRow
          icon={<RefreshCw size={20} />}
          label="上書き"
          description="既存のPDFを新しい内容に置き換えます"
          onClick={() => onChoose('overwrite', applyToAll)}
        />
        <div className="border-t divider" />
        <MenuRow
          icon={<X size={20} />}
          label="キャンセル"
          description="このファイルは追加しません"
          onClick={() => onChoose('cancel', applyToAll)}
        />
      </div>
      {remaining > 1 ? (
        <label className="mt-3 flex min-h-tap items-center justify-between gap-3">
          <span className="text-sm text-ink-sub dark:text-[#98a3b0]">
            残り {remaining - 1} 件にも同じ処理を適用する
          </span>
          <Switch checked={applyToAll} onChange={setApplyToAll} label="残りにも適用" />
        </label>
      ) : null}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* 並べ替え / 表示形式                                                 */
/* ------------------------------------------------------------------ */

const SORT_ORDER: SortKey[] = [
  'name',
  'updatedDesc',
  'updatedAsc',
  'size',
  'type',
  'favorite',
  'manual',
];

const VIEW_LABELS: Record<ViewMode, string> = {
  list: '一覧表示',
  grid: 'グリッド表示',
  thumbnail: 'サムネイル表示',
};

export function SortSheet({
  open,
  sortKey,
  viewMode,
  foldersFirst,
  onClose,
  onChange,
}: {
  open: boolean;
  sortKey: SortKey;
  viewMode: ViewMode;
  foldersFirst: boolean;
  onClose: () => void;
  onChange: (patch: { sortKey?: SortKey; viewMode?: ViewMode; foldersFirst?: boolean }) => void;
}) {
  return (
    <BottomSheet open={open} title="表示と並べ替え" onClose={onClose}>
      <div className="px-4 pb-2 pt-3">
        <p className="text-sm font-semibold text-ink-sub dark:text-[#98a3b0]">表示方法</p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {(Object.keys(VIEW_LABELS) as ViewMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onChange({ viewMode: mode })}
              className={cx(
                'min-h-tap rounded-card border px-2 text-sm',
                viewMode === mode
                  ? 'border-brand-500 bg-brand-50 text-brand-600 dark:bg-[#16233a] dark:text-brand-200'
                  : 'border-line text-ink dark:border-[#333d49] dark:text-[#e6eaef]',
              )}
            >
              {VIEW_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2 border-t divider">
        <p className="px-4 pb-1 pt-3 text-sm font-semibold text-ink-sub dark:text-[#98a3b0]">
          並べ替え
        </p>
        {SORT_ORDER.map((key) => (
          <MenuRow
            key={key}
            icon={
              <Check
                size={20}
                className={sortKey === key ? 'text-brand-500' : 'text-transparent'}
              />
            }
            label={SORT_LABELS[key]}
            onClick={() => onChange({ sortKey: key })}
          />
        ))}
      </div>

      <label className="flex min-h-tap items-center justify-between gap-3 border-t divider px-4 py-3">
        <span className="text-base text-ink dark:text-[#e6eaef]">フォルダーをPDFより上に表示</span>
        <Switch
          checked={foldersFirst}
          onChange={(value) => onChange({ foldersFirst: value })}
          label="フォルダーを上に表示"
        />
      </label>
    </BottomSheet>
  );
}

/* ------------------------------------------------------------------ */
/* フォルダー色                                                        */
/* ------------------------------------------------------------------ */

export function ColorSheet({
  open,
  current,
  onClose,
  onSelect,
}: {
  open: boolean;
  current?: FolderColor;
  onClose: () => void;
  onSelect: (color: FolderColor) => void;
}) {
  return (
    <BottomSheet open={open} title="フォルダーの色" onClose={onClose}>
      <div className="grid grid-cols-3 gap-3 p-4">
        {FOLDER_COLORS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            onClick={() => onSelect(entry.value)}
            className={cx(
              'flex min-h-[84px] flex-col items-center justify-center gap-2 rounded-card border',
              current === entry.value
                ? 'border-brand-500 bg-brand-50 dark:bg-[#16233a]'
                : 'border-line dark:border-[#333d49]',
            )}
          >
            <FolderIcon color={entry.value} size={32} />
            <span className="text-xs text-ink dark:text-[#e6eaef]">{entry.label}</span>
          </button>
        ))}
      </div>
    </BottomSheet>
  );
}

/* ------------------------------------------------------------------ */
/* タグ・メモ・重要度                                                  */
/* ------------------------------------------------------------------ */

const IMPORTANCE_LABELS: Record<Importance, string> = {
  0: '未設定',
  1: '低',
  2: '中',
  3: '高',
};

export function TagMemoSheet({
  open,
  file,
  knownTags,
  onClose,
  onSave,
}: {
  open: boolean;
  file: PdfFileMeta | null;
  knownTags: string[];
  onClose: () => void;
  onSave: (patch: { tags: string[]; memo: string; importance: Importance }) => void;
}) {
  const [tags, setTags] = useState<string[]>([]);
  const [memo, setMemo] = useState('');
  const [importance, setImportance] = useState<Importance>(0);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (open && file) {
      setTags(file.tags);
      setMemo(file.memo ?? '');
      setImportance(file.importance ?? 0);
      setDraft('');
    }
  }, [file, open]);

  if (!file) return null;

  const addTag = (value: string) => {
    const tag = value.trim().replace(/^#/, '');
    if (!tag || tags.includes(tag)) return;
    setTags((current) => [...current, tag]);
    setDraft('');
  };

  const suggestions = [...new Set([...knownTags, ...SUGGESTED_TAGS])]
    .filter((tag) => !tags.includes(tag))
    .slice(0, 12);

  return (
    <BottomSheet
      open={open}
      title="タグ・メモ・重要度"
      description={file.name}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => onSave({ tags, memo, importance })}
          >
            保存
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-4">
        <div>
          <p className="text-sm font-semibold text-ink-sub dark:text-[#98a3b0]">タグ</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setTags((current) => current.filter((value) => value !== tag))}
                className="min-h-[36px] rounded-[4px] border border-brand-200 bg-brand-50 px-2.5 text-sm text-brand-600 dark:border-[#24354f] dark:bg-[#16233a] dark:text-brand-200"
              >
                #{tag} ×
              </button>
            ))}
            {tags.length === 0 ? (
              <p className="text-sm text-ink-faint">タグはまだありません</p>
            ) : null}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              className="field"
              placeholder="タグを入力"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addTag(draft);
                }
              }}
            />
            <Button variant="secondary" onClick={() => addTag(draft)}>
              追加
            </Button>
          </div>
          {suggestions.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {suggestions.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => addTag(tag)}
                  className="min-h-[36px] rounded-[4px] border border-line px-2.5 text-sm text-ink-sub dark:border-[#333d49] dark:text-[#98a3b0]"
                >
                  + {tag}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div>
          <p className="text-sm font-semibold text-ink-sub dark:text-[#98a3b0]">重要度</p>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {([0, 1, 2, 3] as Importance[]).map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setImportance(level)}
                className={cx(
                  'min-h-tap rounded-card border text-sm',
                  importance === level
                    ? 'border-brand-500 bg-brand-50 text-brand-600 dark:bg-[#16233a] dark:text-brand-200'
                    : 'border-line text-ink dark:border-[#333d49] dark:text-[#e6eaef]',
                )}
              >
                {IMPORTANCE_LABELS[level]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-sm font-semibold text-ink-sub dark:text-[#98a3b0]" htmlFor="memo">
            メモ
          </label>
          <textarea
            id="memo"
            className="field mt-2 h-28 resize-none"
            placeholder="このPDFについてのメモ"
            value={memo}
            onChange={(event) => setMemo(event.target.value)}
          />
        </div>
      </div>
    </BottomSheet>
  );
}

/* ------------------------------------------------------------------ */
/* 詳細情報                                                            */
/* ------------------------------------------------------------------ */

const STORAGE_STATE_LABELS: Record<StorageState, string> = {
  local: 'この端末',
  uploading: 'クラウドへ保存中（端末内にもあります）',
  cloud: 'クラウド',
  downloading: 'クラウドから取得中',
  error: 'クラウド保管に失敗（端末内にあります）',
};

export function DetailsSheet({
  open,
  file,
  path,
  memoCount = 0,
  onOpenMemo,
  onClose,
}: {
  open: boolean;
  file: PdfFileMeta | null;
  path: string;
  /** この PDF に登録されているメモの件数。 */
  memoCount?: number;
  /** 詳細画面からメモを開く。 */
  onOpenMemo?: () => void;
  onClose: () => void;
}) {
  if (!file) return null;
  const rows: [string, string][] = [
    ['ファイル名', file.name],
    ['保存場所', path],
    ['サイズ', formatBytes(file.size)],
    ['ページ数', file.pageCount ? `${file.pageCount} ページ` : '不明'],
    ['形式', 'PDF (application/pdf)'],
    ['タグ', file.tags.length > 0 ? file.tags.map((tag) => `#${tag}`).join(' ') : 'なし'],
    ['重要度', IMPORTANCE_LABELS[file.importance ?? 0]],
    ['お気に入り', file.isFavorite ? 'あり' : 'なし'],
    ['閲覧状態', file.isRead ? '閲覧済み' : '未閲覧'],
    ['保存日', formatDateTime(file.createdAt)],
    ['更新日時', formatDateTime(file.updatedAt)],
    ['最終閲覧', file.lastOpenedAt ? formatDateTime(file.lastOpenedAt) : '未閲覧'],
    ['メモ（1行）', file.memo?.trim() ? file.memo : 'なし'],
    ['ページ別のメモ', memoCount > 0 ? `${memoCount} 件` : 'なし'],
    ['PDF本体の保存先', STORAGE_STATE_LABELS[storageStateOf(file)]],
    ...(file.cloudUploadedAt
      ? ([['クラウドへ保存', formatDateTime(file.cloudUploadedAt)]] as [string, string][])
      : []),
    ...(file.localCachedAt
      ? ([['端末内キャッシュ', formatDateTime(file.localCachedAt)]] as [string, string][])
      : []),
    ...(file.cloudError ? ([['クラウドの状態', file.cloudError]] as [string, string][]) : []),
    ['内部ID', file.id],
  ];

  return (
    <BottomSheet open={open} title="詳細情報" onClose={onClose}>
      {onOpenMemo ? (
        <div className="border-b divider p-4">
          <Button variant="secondary" className="w-full" onClick={onOpenMemo}>
            <NotebookPen size={18} />
            メモ{memoCount > 0 ? `（${memoCount} 件）` : ''}
          </Button>
        </div>
      ) : null}
      <dl className="divide-y divider">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-3 px-4 py-2.5">
            <dt className="w-24 shrink-0 text-sm text-ink-sub dark:text-[#98a3b0]">{label}</dt>
            <dd className="min-w-0 flex-1 break-all text-sm text-ink dark:text-[#e6eaef]">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </BottomSheet>
  );
}

export { stripPdfExtension };

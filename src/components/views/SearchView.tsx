'use client';

/** アプリ内のすべてのフォルダーと PDF を対象にした検索画面。 */
import { useMemo, useState } from 'react';
import { ArrowLeft, NotebookPen, Search, SlidersHorizontal } from 'lucide-react';
import { DEFAULT_FILTERS, collectTags, hasActiveFilters, searchAll, type SearchField, type SearchFilters } from '@/lib/search';
import { memoPageLabel } from '@/lib/memos';
import { formatDateTime } from '@/lib/format';
import type { ExplorerItem, PdfFileMeta } from '@/lib/types';
import { useApp } from '@/store/AppStore';
import { ListRow, type ItemHandlers } from '@/components/items/ItemViews';
import { Badge, Button, EmptyState, IconButton, Switch, cx } from '@/components/ui/Primitives';
import { Header } from './Header';

const FIELD_LABELS: { value: SearchField; label: string }[] = [
  { value: 'name', label: 'ファイル名' },
  { value: 'folder', label: 'フォルダー名' },
  { value: 'tag', label: 'タグ' },
  { value: 'memo', label: 'メモ（1行）' },
  { value: 'pdfMemo', label: 'ページ別のメモ' },
];

export function SearchView({
  handlers,
  onOpenMemoHit,
}: {
  handlers: ItemHandlers;
  /** メモの検索結果から、対象PDFの該当ページを直接開く。 */
  onOpenMemoHit?: (file: PdfFileMeta, page?: number) => void;
}) {
  const { folders, files, memos, goBack, canGoBack } = useApp();
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS);
  const [advanced, setAdvanced] = useState(false);

  const tags = useMemo(() => collectTags(files), [files]);

  const hits = useMemo(() => {
    if (!hasActiveFilters(filters)) return [];
    return searchAll(folders, files, filters, { memos }).slice(0, 300);
  }, [files, filters, folders, memos]);

  const patch = (value: Partial<SearchFilters>) =>
    setFilters((current) => ({ ...current, ...value }));

  const toggleField = (field: SearchField) => {
    setFilters((current) => {
      const next = current.fields.includes(field)
        ? current.fields.filter((value) => value !== field)
        : [...current.fields, field];
      return { ...current, fields: next.length > 0 ? next : [field] };
    });
  };

  return (
    <>
      <Header
        title="検索"
        left={
          canGoBack ? (
            <IconButton label="戻る" onClick={goBack}>
              <ArrowLeft size={22} />
            </IconButton>
          ) : undefined
        }
        right={
          <IconButton label="詳細条件" onClick={() => setAdvanced((value) => !value)}>
            <SlidersHorizontal size={22} className={advanced ? 'text-brand-500' : ''} />
          </IconButton>
        }
      >
        <div className="flex items-center gap-2 border-t divider px-3 py-2">
          <Search size={18} className="shrink-0 text-ink-faint" />
          <input
            autoFocus
            className="field h-10 py-1"
            placeholder="ファイル名・フォルダー名・タグ・メモ・ページ"
            value={filters.query}
            onChange={(event) => patch({ query: event.target.value })}
          />
        </div>

        {advanced ? (
          <div className="space-y-3 border-t divider px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-ink-sub dark:text-[#98a3b0]">検索対象</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {FIELD_LABELS.map((field) => (
                  <button
                    key={field.value}
                    type="button"
                    onClick={() => toggleField(field.value)}
                    className={cx(
                      'min-h-[38px] rounded-[4px] border px-3 text-sm',
                      filters.fields.includes(field.value)
                        ? 'border-brand-500 bg-brand-50 text-brand-600 dark:bg-[#16233a] dark:text-brand-200'
                        : 'border-line text-ink-sub dark:border-[#333d49] dark:text-[#98a3b0]',
                    )}
                  >
                    {field.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="text-sm text-ink-sub dark:text-[#98a3b0]">
                保存日（開始）
                <input
                  type="date"
                  className="field mt-1"
                  value={filters.createdFrom ?? ''}
                  onChange={(event) => patch({ createdFrom: event.target.value || undefined })}
                />
              </label>
              <label className="text-sm text-ink-sub dark:text-[#98a3b0]">
                保存日（終了）
                <input
                  type="date"
                  className="field mt-1"
                  value={filters.createdTo ?? ''}
                  onChange={(event) => patch({ createdTo: event.target.value || undefined })}
                />
              </label>
              <label className="text-sm text-ink-sub dark:text-[#98a3b0]">
                更新日（開始）
                <input
                  type="date"
                  className="field mt-1"
                  value={filters.updatedFrom ?? ''}
                  onChange={(event) => patch({ updatedFrom: event.target.value || undefined })}
                />
              </label>
              <label className="text-sm text-ink-sub dark:text-[#98a3b0]">
                更新日（終了）
                <input
                  type="date"
                  className="field mt-1"
                  value={filters.updatedTo ?? ''}
                  onChange={(event) => patch({ updatedTo: event.target.value || undefined })}
                />
              </label>
            </div>

            {tags.length > 0 ? (
              <div>
                <p className="text-sm font-semibold text-ink-sub dark:text-[#98a3b0]">タグで絞り込む</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {tags.map(({ tag, count }) => {
                    const on = filters.tags?.includes(tag) ?? false;
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() =>
                          patch({
                            tags: on
                              ? (filters.tags ?? []).filter((value) => value !== tag)
                              : [...(filters.tags ?? []), tag],
                          })
                        }
                        className={cx(
                          'min-h-[38px] rounded-[4px] border px-3 text-sm',
                          on
                            ? 'border-brand-500 bg-brand-50 text-brand-600 dark:bg-[#16233a] dark:text-brand-200'
                            : 'border-line text-ink-sub dark:border-[#333d49] dark:text-[#98a3b0]',
                        )}
                      >
                        #{tag} ({count})
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <label className="flex min-h-tap items-center justify-between gap-3">
              <span className="text-base text-ink dark:text-[#e6eaef]">お気に入りのみ</span>
              <Switch
                checked={Boolean(filters.onlyFavorite)}
                onChange={(value) => patch({ onlyFavorite: value })}
                label="お気に入りのみ"
              />
            </label>

            <Button variant="secondary" onClick={() => setFilters(DEFAULT_FILTERS)}>
              条件をリセット
            </Button>
          </div>
        ) : null}
      </Header>

      {!hasActiveFilters(filters) ? (
        <EmptyState
          icon={<Search size={48} strokeWidth={1.2} />}
          title="キーワードを入力してください"
          description="ファイル名・フォルダー名・タグ・メモの本文や対象ページ・保存日・更新日から検索できます。メモの結果からは該当ページを直接開けます。"
        />
      ) : hits.length === 0 ? (
        <EmptyState
          icon={<Search size={48} strokeWidth={1.2} />}
          title="該当する項目がありません"
          description="キーワードや絞り込み条件を変更してお試しください。"
        />
      ) : (
        <>
          <p className="px-4 py-2 text-sm text-ink-sub dark:text-[#98a3b0]">{hits.length} 件</p>
          <div className="bg-surface dark:bg-[#181e26]">
            {hits.map((hit) => {
              if (hit.kind === 'memo') {
                return (
                  <button
                    key={`m-${hit.memo.id}`}
                    type="button"
                    onClick={() => onOpenMemoHit?.(hit.file, hit.page)}
                    className="flex w-full items-start gap-3 border-b divider px-4 py-3 text-left active:bg-surface-sub dark:active:bg-[#232b35]"
                  >
                    <NotebookPen size={20} className="mt-0.5 shrink-0 text-ink-sub dark:text-[#98a3b0]" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={hit.memo.pageStart === undefined ? 'neutral' : 'brand'}>
                          {memoPageLabel(hit.memo)}
                        </Badge>
                        {hit.memo.isReview ? <Badge tone="warn">復習項目</Badge> : null}
                        {hit.memo.isDraft ? <Badge tone="neutral">下書き</Badge> : null}
                      </span>
                      {hit.memo.title ? (
                        <span className="mt-1 block break-words text-base font-medium text-ink dark:text-[#e6eaef]">
                          {hit.memo.title}
                        </span>
                      ) : null}
                      <span className="mt-0.5 block break-words text-sm text-ink dark:text-[#e6eaef] line-clamp-2">
                        {hit.memo.content}
                      </span>
                      <span className="mt-1 block break-all text-xs text-brand-500 dark:text-brand-300">
                        {hit.file.name}
                      </span>
                      <span className="block truncate text-xs text-ink-sub dark:text-[#98a3b0]">
                        {hit.path} ・ {formatDateTime(hit.memo.updatedAt)}
                      </span>
                    </span>
                  </button>
                );
              }

              const item: ExplorerItem =
                hit.kind === 'folder'
                  ? { kind: 'folder', folder: hit.folder }
                  : { kind: 'file', file: hit.file };
              return (
                <ListRow
                  key={hit.kind === 'folder' ? `f-${hit.folder.id}` : `p-${hit.file.id}`}
                  item={item}
                  handlers={handlers}
                  showLocation={hit.path}
                />
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

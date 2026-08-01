'use client';

/**
 * PDF ごとのメモ一覧。
 *
 * PDF 一覧の操作メニュー・詳細情報・PDF 閲覧画面のいずれからも同じシートを開く。
 * 閲覧画面から開いた場合は、はじめに現在のページのメモだけを見せる。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  ListFilter,
  Pencil,
  Plus,
  Star,
  Trash2,
} from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import { toMessage } from '@/lib/errors';
import {
  deleteMemo,
  memoCoversPage,
  memoPageLabel,
  patchMemo,
  saveMemo,
  sortMemos,
} from '@/lib/memos';
import { collectMemoTags } from '@/lib/search';
import { MEMO_SORT_LABELS, type MemoSortKey, type PdfFileMeta, type PdfMemo } from '@/lib/types';
import { useApp } from '@/store/AppStore';
import { Badge, Button, EmptyState, IconButton, cx } from '@/components/ui/Primitives';
import { BottomSheet, MenuRow } from '@/components/ui/Sheet';
import {
  MemoEditor,
  draftFromMemo,
  emptyDraft,
  hasContent,
  toMemoInput,
  type MemoDraftValue,
} from './MemoEditor';

type Mode =
  | { view: 'list' }
  | { view: 'edit'; memoId?: string }
  | { view: 'sort' };

export function MemoSheet({
  open,
  file,
  currentPage,
  pageCount,
  onClose,
  onGoToPage,
}: {
  open: boolean;
  file: PdfFileMeta | null;
  /** 閲覧画面から開いたときの表示中ページ。 */
  currentPage?: number;
  pageCount?: number;
  onClose: () => void;
  /** メモから該当ページへ移動する。閲覧画面ではページ送り、一覧ではPDFを開く。 */
  onGoToPage?: (page: number) => void;
}) {
  const { memos, settings, notify, reloadMemos, updateSettings } = useApp();
  const [mode, setMode] = useState<Mode>({ view: 'list' });
  const [draft, setDraft] = useState<MemoDraftValue>(emptyDraft());
  /**
   * 編集中のメモの ID。
   *
   * 自動保存で新しく作られた場合もここへ入れ、2 回目以降は同じメモを更新する。
   * 状態ではなく参照で持つのは、自動保存のたびに関数の実体が変わって
   * 入力欄側の後片付けが誤作動するのを避けるため。
   */
  const editingId = useRef<string | undefined>(undefined);
  /** 保存・キャンセル・削除で編集を終えた印。以後の自動保存を行わない。 */
  const finished = useRef(false);
  const [savedLabel, setSavedLabel] = useState('');
  const [onlyCurrentPage, setOnlyCurrentPage] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const fileMemos = useMemo(
    () => (file ? memos.filter((memo) => memo.fileId === file.id) : []),
    [file, memos],
  );

  const knownTags = useMemo(() => collectMemoTags(memos).map((entry) => entry.tag), [memos]);

  /* 開き直すたびに初期状態へ戻す ------------------------------------ */
  useEffect(() => {
    if (!open) return;
    setMode({ view: 'list' });
    setDraft(emptyDraft(currentPage));
    editingId.current = undefined;
    finished.current = false;
    setSavedLabel('');
    setConfirmDeleteId(null);
    // 閲覧画面から開いたときだけ、まず現在ページのメモに絞る
    setOnlyCurrentPage(currentPage !== undefined);
  }, [currentPage, file?.id, open]);

  const visible = useMemo(() => {
    const filtered =
      onlyCurrentPage && currentPage !== undefined
        ? fileMemos.filter((memo) => memoCoversPage(memo, currentPage))
        : fileMemos;
    return sortMemos(filtered, settings.memoSortKey);
  }, [currentPage, fileMemos, onlyCurrentPage, settings.memoSortKey]);

  /* 保存 -------------------------------------------------------------- */

  const autoSave = useCallback(
    async (value: MemoDraftValue) => {
      // 保存・キャンセル済みなら、入力欄を閉じるときの自動保存で新しいメモを作らない
      if (!file || finished.current || !hasContent(value)) return;
      try {
        const saved = await saveMemo({
          ...toMemoInput(value),
          id: editingId.current,
          fileId: file.id,
          // 明示的に保存されるまでは下書き扱い
          isDraft: true,
        });
        editingId.current = saved.id;
        setSavedLabel(`下書きを自動保存しました（${formatDateTime(saved.updatedAt)}）`);
        await reloadMemos();
      } catch {
        setSavedLabel('下書きを保存できませんでした。');
      }
    },
    [file, reloadMemos],
  );

  const save = useCallback(async () => {
    if (!file) return;
    try {
      // 先に印を立て、入力欄を閉じるときの自動保存で二重に作らないようにする
      finished.current = true;
      await saveMemo({
        ...toMemoInput(draft),
        id: editingId.current,
        fileId: file.id,
        isDraft: false,
      });
      await reloadMemos();
      setMode({ view: 'list' });
      editingId.current = undefined;
      setSavedLabel('');
      notify('メモを保存しました。', 'success');
    } catch (error) {
      finished.current = false;
      notify(toMessage(error), 'error');
    }
  }, [draft, file, notify, reloadMemos]);

  const remove = useCallback(
    async (memoId: string) => {
      if (!file) return;
      try {
        // 削除後に自動保存で作り直されないようにする
        finished.current = true;
        await deleteMemo(file.id, memoId);
        await reloadMemos();
        setConfirmDeleteId(null);
        editingId.current = undefined;
        setMode({ view: 'list' });
        notify('メモを削除しました。', 'success');
      } catch (error) {
        notify(toMessage(error), 'error');
      }
    },
    [file, notify, reloadMemos],
  );

  const toggle = useCallback(
    async (memo: PdfMemo, patch: Partial<Pick<PdfMemo, 'isFavorite' | 'isReview'>>, message: string) => {
      if (!file) return;
      try {
        await patchMemo(file.id, memo.id, patch);
        await reloadMemos();
        notify(message, 'success');
      } catch (error) {
        notify(toMessage(error), 'error');
      }
    },
    [file, notify, reloadMemos],
  );

  if (!file) return null;

  /* 画面 -------------------------------------------------------------- */

  if (mode.view === 'sort') {
    return (
      <BottomSheet open={open} title="メモの並べ替え" onClose={() => setMode({ view: 'list' })}>
        {(Object.keys(MEMO_SORT_LABELS) as MemoSortKey[]).map((key) => (
          <MenuRow
            key={key}
            icon={
              <Check size={20} className={settings.memoSortKey === key ? 'text-brand-500' : 'text-transparent'} />
            }
            label={MEMO_SORT_LABELS[key]}
            onClick={() => {
              void updateSettings({ memoSortKey: key });
              setMode({ view: 'list' });
            }}
          />
        ))}
      </BottomSheet>
    );
  }

  if (mode.view === 'edit') {
    const editing = mode.memoId
      ? fileMemos.find((memo) => memo.id === mode.memoId)
      : undefined;
    return (
      <BottomSheet
        open={open}
        title={editing ? 'メモを編集' : '新しいメモ'}
        description={file.name}
        onClose={() => setMode({ view: 'list' })}
        maxHeight="72vh"
      >
        <MemoEditor
          value={draft}
          onChange={setDraft}
          onAutoSave={(value) => void autoSave(value)}
          onSave={() => void save()}
          onCancel={() => {
            // 書きかけの内容は下書きとして残っている。ここでは一覧へ戻るだけ。
            finished.current = true;
            setMode({ view: 'list' });
            editingId.current = undefined;
            setSavedLabel('');
          }}
          onDelete={
            editing || editingId.current
              ? () => {
                  const id = editingId.current ?? mode.memoId;
                  if (id) void remove(id);
                }
              : undefined
          }
          knownTags={knownTags}
          pageCount={pageCount ?? file.pageCount}
          savedLabel={savedLabel}
        />
      </BottomSheet>
    );
  }

  const description =
    currentPage !== undefined
      ? `${file.name}（${currentPage}ページを表示中）`
      : file.name;

  return (
    <BottomSheet open={open} title="メモ" description={description} onClose={onClose} maxHeight="74vh">
      <div className="flex items-center justify-between gap-2 border-b divider px-4 py-2">
        <p className="min-w-0 flex-1 truncate text-sm text-ink-sub dark:text-[#98a3b0]">
          {fileMemos.length} 件のメモ
        </p>
        <IconButton label="メモの並べ替え" onClick={() => setMode({ view: 'sort' })}>
          <ListFilter size={20} />
        </IconButton>
      </div>

      {currentPage !== undefined ? (
        <div className="flex gap-2 border-b divider px-4 py-2">
          <button
            type="button"
            onClick={() => setOnlyCurrentPage(true)}
            className={cx(
              'min-h-[38px] flex-1 rounded-[4px] border px-3 text-sm',
              onlyCurrentPage
                ? 'border-brand-500 bg-brand-50 text-brand-600 dark:bg-[#16233a] dark:text-brand-200'
                : 'border-line text-ink-sub dark:border-[#333d49] dark:text-[#98a3b0]',
            )}
          >
            このページ
          </button>
          <button
            type="button"
            onClick={() => setOnlyCurrentPage(false)}
            className={cx(
              'min-h-[38px] flex-1 rounded-[4px] border px-3 text-sm',
              !onlyCurrentPage
                ? 'border-brand-500 bg-brand-50 text-brand-600 dark:bg-[#16233a] dark:text-brand-200'
                : 'border-line text-ink-sub dark:border-[#333d49] dark:text-[#98a3b0]',
            )}
          >
            すべて
          </button>
        </div>
      ) : null}

      <div className="p-4 pb-2">
        <Button
          variant="primary"
          className="w-full"
          onClick={() => {
            setDraft(emptyDraft(currentPage));
            editingId.current = undefined;
            finished.current = false;
            setSavedLabel('');
            setMode({ view: 'edit' });
          }}
        >
          <Plus size={18} />
          {currentPage !== undefined ? `${currentPage}ページにメモを追加` : 'メモを追加'}
        </Button>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<BookOpen size={44} strokeWidth={1.2} />}
          title={onlyCurrentPage ? 'このページのメモはありません' : 'メモはまだありません'}
          description={
            onlyCurrentPage
              ? '「すべて」を選ぶと、このPDFの他のメモも表示できます。'
              : 'ページを指定したメモも、PDF全体へのメモも登録できます。'
          }
        />
      ) : (
        <ul className="divide-y divider">
          {visible.map((memo) => (
            <li key={memo.id} className="px-4 py-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={memo.pageStart === undefined ? 'neutral' : 'brand'}>
                      {memoPageLabel(memo)}
                    </Badge>
                    {memo.isReview ? <Badge tone="warn">復習項目</Badge> : null}
                    {memo.isDraft ? <Badge tone="neutral">下書き</Badge> : null}
                    {memo.isFavorite ? (
                      <Star size={14} className="text-folder" fill="#e8a917" aria-label="お気に入り" />
                    ) : null}
                  </div>

                  {memo.title ? (
                    <p className="mt-1.5 break-words text-base font-medium text-ink dark:text-[#e6eaef]">
                      {memo.title}
                    </p>
                  ) : null}
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink dark:text-[#e6eaef]">
                    {memo.content}
                  </p>

                  {memo.tags.length > 0 ? (
                    <p className="mt-1.5 break-words text-xs text-brand-500 dark:text-brand-300">
                      {memo.tags.map((tag) => `#${tag}`).join(' ')}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-ink-sub dark:text-[#98a3b0]">
                    作成 {formatDateTime(memo.createdAt)} ・ 更新 {formatDateTime(memo.updatedAt)}
                  </p>
                </div>
              </div>

              {confirmDeleteId === memo.id ? (
                <div className="mt-2 rounded-card border border-line p-3 dark:border-[#333d49]">
                  <p className="text-sm text-ink dark:text-[#e6eaef]">このメモを削除しますか？</p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      variant="secondary"
                      className="flex-1"
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      キャンセル
                    </Button>
                    <Button variant="danger" className="flex-1" onClick={() => void remove(memo.id)}>
                      削除
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {memo.pageStart !== undefined && onGoToPage ? (
                    <Button
                      variant="secondary"
                      className="min-h-[40px] px-3 text-sm"
                      onClick={() => onGoToPage(memo.pageStart as number)}
                    >
                      <ArrowRight size={16} />
                      該当ページへ
                    </Button>
                  ) : null}
                  <Button
                    variant="secondary"
                    className="min-h-[40px] px-3 text-sm"
                    onClick={() => {
                      setDraft(draftFromMemo(memo));
                      editingId.current = memo.id;
                      finished.current = false;
                      setSavedLabel('');
                      setMode({ view: 'edit', memoId: memo.id });
                    }}
                  >
                    <Pencil size={16} />
                    編集
                  </Button>
                  <Button
                    variant="secondary"
                    className="min-h-[40px] px-3 text-sm"
                    onClick={() =>
                      void toggle(
                        memo,
                        { isReview: !memo.isReview },
                        memo.isReview ? '復習項目から外しました。' : '復習項目に登録しました。',
                      )
                    }
                  >
                    {memo.isReview ? '復習項目から外す' : '復習項目にする'}
                  </Button>
                  <Button
                    variant="secondary"
                    className="min-h-[40px] px-3 text-sm"
                    onClick={() =>
                      void toggle(
                        memo,
                        { isFavorite: !memo.isFavorite },
                        memo.isFavorite ? 'お気に入りを解除しました。' : 'お気に入りに登録しました。',
                      )
                    }
                  >
                    <Star size={16} />
                    {memo.isFavorite ? '解除' : 'お気に入り'}
                  </Button>
                  <Button
                    variant="secondary"
                    className="min-h-[40px] px-3 text-sm text-pdf dark:text-[#f08a80]"
                    onClick={() => setConfirmDeleteId(memo.id)}
                  >
                    <Trash2 size={16} />
                    削除
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </BottomSheet>
  );
}

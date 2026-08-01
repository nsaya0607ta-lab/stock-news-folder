'use client';

/**
 * メモの入力欄。
 *
 * 入力中の内容は一定時間ごとに下書きとして自動保存する。
 * 誤って画面を閉じても消えないようにしつつ、明示的な「保存」ボタンも残している
 * (保存を押すと下書きフラグが外れ、正式なメモになる)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Star, Trash2 } from 'lucide-react';
import { SUGGESTED_TAGS } from '@/lib/search';
import { normalizePageRange } from '@/lib/memos';
import type { PdfMemo } from '@/lib/types';
import { Button, Switch, cx } from '@/components/ui/Primitives';

/** 入力が止まってから下書きを保存するまでの待ち時間。 */
const AUTOSAVE_DELAY = 800;

export type MemoDraftValue = {
  title: string;
  content: string;
  pageStart: string;
  pageEnd: string;
  tags: string[];
  isFavorite: boolean;
  isReview: boolean;
};

export function emptyDraft(page?: number): MemoDraftValue {
  return {
    title: '',
    content: '',
    pageStart: page ? String(page) : '',
    pageEnd: '',
    tags: [],
    isFavorite: false,
    isReview: false,
  };
}

export function draftFromMemo(memo: PdfMemo): MemoDraftValue {
  return {
    title: memo.title ?? '',
    content: memo.content,
    pageStart: memo.pageStart ? String(memo.pageStart) : '',
    pageEnd: memo.pageEnd ? String(memo.pageEnd) : '',
    tags: memo.tags,
    isFavorite: memo.isFavorite,
    isReview: memo.isReview,
  };
}

/** 入力値を保存できる形へ変換する。 */
export function toMemoInput(value: MemoDraftValue) {
  const pages = normalizePageRange(
    value.pageStart ? Number(value.pageStart) : undefined,
    value.pageEnd ? Number(value.pageEnd) : undefined,
  );
  return {
    title: value.title.trim() || undefined,
    content: value.content,
    pageStart: pages.pageStart,
    pageEnd: pages.pageEnd,
    tags: value.tags,
    isFavorite: value.isFavorite,
    isReview: value.isReview,
  };
}

export function hasContent(value: MemoDraftValue): boolean {
  return Boolean(value.content.trim() || value.title.trim());
}

export function MemoEditor({
  value,
  onChange,
  onAutoSave,
  onSave,
  onCancel,
  onDelete,
  knownTags,
  pageCount,
  savedLabel,
}: {
  value: MemoDraftValue;
  onChange: (value: MemoDraftValue) => void;
  /** 下書きの自動保存。入力が止まったときに呼ばれる。 */
  onAutoSave: (value: MemoDraftValue) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  knownTags: string[];
  pageCount?: number;
  /** 「下書きを保存しました」などの状態表示。 */
  savedLabel?: string;
}) {
  const [tagDraft, setTagDraft] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);
  latest.current = value;

  /**
   * 最新の保存処理への参照。
   *
   * 親が描画されるたびに onAutoSave の実体は変わるが、それを effect の依存に入れると
   * 「描画のたびに後片付けが走り、そのたびに保存される」ことになり、
   * 同じメモが何件も作られてしまう。参照だけ差し替え、effect は 1 回だけ張る。
   */
  const autoSaveRef = useRef(onAutoSave);
  autoSaveRef.current = onAutoSave;

  /** 入力のたびにタイマーを引き直し、止まったところで下書きを保存する。 */
  const scheduleAutoSave = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (hasContent(latest.current)) autoSaveRef.current(latest.current);
    }, AUTOSAVE_DELAY);
  }, []);

  const patch = (next: Partial<MemoDraftValue>) => {
    onChange({ ...latest.current, ...next });
    scheduleAutoSave();
  };

  // 画面を閉じる・アプリが背面へ回るときも、待たずに下書きを残す
  useEffect(() => {
    const flush = () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (hasContent(latest.current)) autoSaveRef.current(latest.current);
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
      // 入力欄を閉じるときに、書きかけの内容を下書きとして残す
      flush();
    };
  }, []);

  const addTag = (raw: string) => {
    const tag = raw.trim().replace(/^#/, '');
    if (!tag || value.tags.includes(tag)) return;
    patch({ tags: [...value.tags, tag] });
    setTagDraft('');
  };

  const suggestions = [...new Set([...knownTags, ...SUGGESTED_TAGS])]
    .filter((tag) => !value.tags.includes(tag))
    .slice(0, 10);

  return (
    <div className="space-y-4 p-4">
      <div>
        <label className="text-sm font-semibold text-ink-sub dark:text-[#98a3b0]" htmlFor="memo-title">
          メモタイトル
        </label>
        <input
          id="memo-title"
          className="field mt-1.5"
          placeholder="（任意）例：rpmコマンドの注意点"
          value={value.title}
          onChange={(event) => patch({ title: event.target.value })}
        />
      </div>

      <div>
        <label className="text-sm font-semibold text-ink-sub dark:text-[#98a3b0]" htmlFor="memo-body">
          本文
        </label>
        <textarea
          id="memo-body"
          className="field mt-1.5 h-36 resize-none"
          placeholder="覚えておきたい内容を入力してください"
          value={value.content}
          onChange={(event) => patch({ content: event.target.value })}
        />
      </div>

      <div>
        <p className="text-sm font-semibold text-ink-sub dark:text-[#98a3b0]">対象ページ</p>
        <p className="mt-1 text-xs text-ink-sub dark:text-[#98a3b0]">
          空欄のままにすると、PDF全体へのメモになります。
        </p>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={pageCount || undefined}
            className="field"
            placeholder="開始"
            aria-label="対象ページ（開始）"
            value={value.pageStart}
            onChange={(event) => patch({ pageStart: event.target.value })}
          />
          <span className="shrink-0 text-sm text-ink-sub dark:text-[#98a3b0]">〜</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={pageCount || undefined}
            className="field"
            placeholder="終了（任意）"
            aria-label="対象ページ（終了）"
            value={value.pageEnd}
            onChange={(event) => patch({ pageEnd: event.target.value })}
          />
        </div>
        {value.pageStart ? (
          <button
            type="button"
            onClick={() => patch({ pageStart: '', pageEnd: '' })}
            className="mt-2 min-h-[38px] text-sm text-brand-500 dark:text-brand-300"
          >
            PDF全体へのメモにする
          </button>
        ) : null}
      </div>

      <div>
        <p className="text-sm font-semibold text-ink-sub dark:text-[#98a3b0]">タグ</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {value.tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => patch({ tags: value.tags.filter((entry) => entry !== tag) })}
              className="min-h-[36px] rounded-[4px] border border-brand-200 bg-brand-50 px-2.5 text-sm text-brand-600 dark:border-[#24354f] dark:bg-[#16233a] dark:text-brand-200"
            >
              #{tag} ×
            </button>
          ))}
          {value.tags.length === 0 ? (
            <p className="text-sm text-ink-faint">タグはまだありません</p>
          ) : null}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            className="field"
            placeholder="タグを入力"
            value={tagDraft}
            onChange={(event) => setTagDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addTag(tagDraft);
              }
            }}
          />
          <Button variant="secondary" onClick={() => addTag(tagDraft)}>
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

      <div className="space-y-1">
        <label className="flex min-h-tap items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-base text-ink dark:text-[#e6eaef]">
            <Star
              size={18}
              className={cx('shrink-0', value.isFavorite ? 'text-folder' : 'text-ink-faint')}
              fill={value.isFavorite ? '#e8a917' : 'none'}
            />
            お気に入り
          </span>
          <Switch
            checked={value.isFavorite}
            onChange={(next) => patch({ isFavorite: next })}
            label="お気に入り"
          />
        </label>

        <label className="flex min-h-tap items-center justify-between gap-3">
          <span className="min-w-0 text-base text-ink dark:text-[#e6eaef]">
            復習項目として登録
            <span className="block text-xs text-ink-sub dark:text-[#98a3b0]">
              あとで見直したいメモに印を付けます
            </span>
          </span>
          <Switch
            checked={value.isReview}
            onChange={(next) => patch({ isReview: next })}
            label="復習項目として登録"
          />
        </label>
      </div>

      {savedLabel ? (
        <p className="text-xs text-ink-sub dark:text-[#98a3b0]">{savedLabel}</p>
      ) : null}

      <div className="flex flex-col gap-2 pt-1">
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onCancel}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            onClick={onSave}
            disabled={!hasContent(value)}
          >
            保存
          </Button>
        </div>
        {onDelete ? (
          <Button variant="secondary" className="text-pdf dark:text-[#f08a80]" onClick={onDelete}>
            <Trash2 size={18} />
            このメモを削除
          </Button>
        ) : null}
      </div>
    </div>
  );
}

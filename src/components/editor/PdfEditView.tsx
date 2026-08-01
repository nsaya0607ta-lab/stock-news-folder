'use client';

/**
 * PDF 編集画面 (第 1 段階：ページ編集)。
 *
 * 編集中は「ページの並び」を配列として持つだけで、元の PDF には一切触れない。
 * 保存を選んだときにはじめて PDF を組み立て、検証してから書き込む。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy,
  FileOutput,
  FilePlus2,
  ImagePlus,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  Scissors,
  SquareStack,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { toMessage } from '@/lib/errors';
import { formatBytes, middleEllipsis } from '@/lib/format';
import { stripPdfExtension } from '@/lib/naming';
import {
  A4_SIZE,
  blankPage,
  buildImportMapping,
  buildSubsetPdf,
  createAssets,
  deletePages as removePages,
  duplicatePages,
  imagePageFrom,
  initialPages,
  insertPages,
  isUnchanged,
  movePage,
  pagesFromPdf,
  removedOriginPages,
  rotatePages,
  subsetPageMapping,
  type EditAssets,
  type EditPage,
} from '@/lib/pdfEdit';
import {
  SAVE_PHASE_LABELS,
  clearDraft,
  readDraft,
  restoreAssets,
  saveDraft,
  saveEdit,
  type SaveMode,
  type SavePhase,
} from '@/lib/pdfEditSave';
import { transferMemos } from '@/lib/memos';
import * as repo from '@/lib/repository';
import { toParentKey } from '@/lib/tree';
import type { PdfFileMeta } from '@/lib/types';
import { useApp } from '@/store/AppStore';
import { Button, IconButton, Spinner, cx } from '@/components/ui/Primitives';
import { BottomSheet, Dialog, MenuRow } from '@/components/ui/Sheet';
import { usePageThumbs } from './usePageThumbs';

type Sheet = 'insert' | 'save' | 'pickPdf' | null;

type Confirm =
  | { kind: 'discard' }
  | { kind: 'deleteWarning'; mode: SaveMode }
  | { kind: 'mergeMemos'; mode: SaveMode }
  | { kind: 'carryMemos'; action: 'extract' | 'split'; slots: number[][] }
  | null;

export function PdfEditView({
  file,
  blob,
  onClose,
  onSaved,
  resolveBlob,
}: {
  file: PdfFileMeta;
  /** 編集前の PDF 本体。 */
  blob: Blob;
  onClose: () => void;
  /** 保存できたときに呼ぶ (一覧やサムネイルの更新は呼び出し側で行う)。 */
  onSaved: (result: { mode: SaveMode; file: PdfFileMeta; message: string }) => void;
  /** アプリ内の別 PDF の本体を取り出す (結合・ページ追加で使う)。 */
  resolveBlob: (file: PdfFileMeta) => Promise<Blob>;
}) {
  const { files, folders, memos, settings, notify, reload, reloadMemos } = useApp();

  const [pages, setPages] = useState<EditPage[]>([]);
  const [past, setPast] = useState<EditPage[][]>([]);
  const [future, setFuture] = useState<EditPage[][]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState<Sheet>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<{ phase: SavePhase; percent: number } | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);

  const assets = useRef<EditAssets>(createAssets(new Uint8Array()));
  const originalPages = useRef<EditPage[]>([]);
  const imageInput = useRef<HTMLInputElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const tiles = useRef(new Map<string, HTMLElement>());
  const drag = useRef<{ pointerId: number; key: string; before: EditPage[] } | null>(null);
  /** 保存ボタンの連打で二重に走らせないための印。 */
  const savingRef = useRef(false);

  const thumbOf = usePageThumbs(pages, assets.current);
  const fileMemos = useMemo(() => memos.filter((memo) => memo.fileId === file.id), [file.id, memos]);

  /* 読み込み ---------------------------------------------------------- */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (cancelled) return;
        const next = createAssets(bytes);

        // 前回の編集が保存できずに終わっていれば、その続きから再開する
        const draft = await readDraft(file.id);
        if (!cancelled && draft) {
          const restored = restoreAssets(draft, bytes);
          if (restored.complete) {
            assets.current = restored.assets;
            originalPages.current = initialPages(file.pageCount ?? 0);
            setPages(draft.pages);
            setLoading(false);
            notify('前回保存できなかった編集内容を復元しました。', 'info');
            return;
          }
          // 素材が欠けている下書きは復元せず、破棄して最初からにする
          await clearDraft(file.id);
        }

        if (cancelled) return;
        assets.current = next;
        const { PDFDocument } = await import('pdf-lib');
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const start = initialPages(doc.getPageCount());
        originalPages.current = start;
        setPages(start);
        setLoading(false);
      } catch (error) {
        if (!cancelled) {
          notify(toMessage(error), 'error');
          onClose();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // file.id / blob が変わることは無い (編集中は同じ PDF を見続ける)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blob, file.id]);

  /* 変更の適用と履歴 -------------------------------------------------- */
  const apply = useCallback(
    (next: EditPage[]) => {
      setPast((current) => [...current.slice(-49), pages]);
      setFuture([]);
      setPages(next);
    },
    [pages],
  );

  const undo = useCallback(() => {
    setPast((current) => {
      if (current.length === 0) return current;
      const previous = current[current.length - 1];
      setFuture((forward) => [...forward, pages]);
      setPages(previous);
      return current.slice(0, -1);
    });
  }, [pages]);

  const redo = useCallback(() => {
    setFuture((current) => {
      if (current.length === 0) return current;
      const next = current[current.length - 1];
      setPast((backward) => [...backward, pages]);
      setPages(next);
      return current.slice(0, -1);
    });
  }, [pages]);

  /* 編集内容の自動保存 (画面を閉じても失わないように) ------------------ */
  useEffect(() => {
    if (loading || pages.length === 0) return;
    if (isUnchanged(originalPages.current, pages)) return;
    const timer = setTimeout(() => {
      void saveDraft(file.id, pages, assets.current);
    }, 1000);
    return () => clearTimeout(timer);
  }, [file.id, loading, pages]);

  /* ページの選択 ------------------------------------------------------ */
  const toggleSelect = (key: string) => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedSlots = useMemo(
    () =>
      pages
        .map((page, index) => (selection.has(page.key) ? index : -1))
        .filter((index) => index >= 0),
    [pages, selection],
  );

  const clearSelection = () => setSelection(new Set());

  /* 並べ替え (ドラッグ) ----------------------------------------------- */
  const indexAtPoint = (x: number, y: number): number => {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    pages.forEach((page, index) => {
      const element = tiles.current.get(page.key);
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        bestIndex = index;
        bestDistance = -1;
        return;
      }
      if (bestDistance === -1) return;
      const distance = Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2));
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return bestIndex;
  };

  /** 画面の端までドラッグしたときに一覧を送る。 */
  const autoScroll = (y: number) => {
    const element = scroller.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (y < rect.top + 72) element.scrollBy({ top: -16 });
    else if (y > rect.bottom - 72) element.scrollBy({ top: 16 });
  };

  const startDrag = (event: React.PointerEvent<HTMLElement>, key: string) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, key, before: pages };
    setDragKey(key);
  };

  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    const info = drag.current;
    if (!info || event.pointerId !== info.pointerId) return;
    event.preventDefault();
    autoScroll(event.clientY);
    const from = pages.findIndex((page) => page.key === info.key);
    const to = indexAtPoint(event.clientX, event.clientY);
    if (from < 0 || to < 0 || from === to) return;
    // ドラッグ中は履歴を積まず、指を離したときに 1 回だけまとめて積む
    setPages((current) => movePage(current, from, to));
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    const info = drag.current;
    if (!info || event.pointerId !== info.pointerId) return;
    drag.current = null;
    setDragKey(null);
    if (!isUnchanged(info.before, pages)) {
      setPast((current) => [...current.slice(-49), info.before]);
      setFuture([]);
    }
  };

  /* ページ操作 -------------------------------------------------------- */
  const insertAt = selectedSlots.length > 0 ? Math.max(...selectedSlots) + 1 : pages.length;

  const rotate = (delta: number) => {
    const keys = selection.size > 0 ? selection : new Set(pages.map((page) => page.key));
    apply(rotatePages(pages, keys, delta));
  };

  const removeSelected = () => {
    if (selection.size === 0) return;
    if (selection.size >= pages.length) {
      notify('すべてのページは削除できません。1ページ以上残してください。', 'error');
      return;
    }
    apply(removePages(pages, selection));
    clearSelection();
  };

  const duplicateSelected = () => {
    if (selection.size === 0) return;
    apply(duplicatePages(pages, selection));
    clearSelection();
  };

  const addBlank = () => {
    // 直前のページと同じ大きさに揃える (揃えられない場合は A4)
    apply(insertPages(pages, insertAt, [blankPage(A4_SIZE)]));
    setSheet(null);
  };

  const addImages = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setProgress({ phase: 'building', percent: 0 });
    try {
      const added: EditPage[] = [];
      for (const image of Array.from(list)) {
        added.push(await imagePageFrom(assets.current, image));
      }
      apply(insertPages(pages, insertAt, added));
      notify(`${added.length} ページを追加しました。`, 'success');
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setProgress(null);
    }
  };

  const addFromPdf = async (source: PdfFileMeta) => {
    setSheet(null);
    setProgress({ phase: 'building', percent: 0 });
    try {
      const sourceBlob = await resolveBlob(source);
      const added = await pagesFromPdf(assets.current, sourceBlob, source.id);
      apply(insertPages(pages, insertAt, added));
      notify(`「${source.name}」から ${added.length} ページを追加しました。`, 'success');
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setProgress(null);
    }
  };

  /* 抽出・分割 -------------------------------------------------------- */

  /** 選んだページを新しい PDF として書き出す。元の PDF は変更しない。 */
  const writeSubsets = async (groups: { slots: number[]; name: string }[], carryMemos: boolean) => {
    setProgress({ phase: 'building', percent: 0 });
    try {
      const parentId = toParentKey(file.parentId);
      let created = 0;
      let carried = 0;

      for (const group of groups) {
        const subset = await buildSubsetPdf(pages, group.slots, assets.current, (done, total) => {
          setProgress({ phase: 'building', percent: Math.round((done / Math.max(1, total)) * 100) });
        });
        const meta = await repo.addPdf(subset, group.name, {
          parentId,
          onDuplicate: 'rename',
          pageCount: group.slots.length,
        });
        created += 1;

        if (carryMemos) {
          // 元ページ → 新しい PDF でのページ番号 に付け替えて引き継ぐ
          carried += await transferMemos(file.id, meta.id, subsetPageMapping(pages, group.slots));
        }
      }

      await reload();
      await reloadMemos();
      notify(
        `${created} 件のPDFを作成しました。${carryMemos ? `メモ ${carried} 件を引き継ぎました。` : ''}`,
        'success',
      );
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setProgress(null);
    }
  };

  const askExtract = () => {
    if (selectedSlots.length === 0) {
      notify('抽出するページを選択してください。', 'error');
      return;
    }
    setConfirm({ kind: 'carryMemos', action: 'extract', slots: [selectedSlots] });
  };

  const askSplit = () => {
    if (selectedSlots.length === 0) {
      notify('分割位置にするページを選択してください。', 'error');
      return;
    }
    const at = Math.min(...selectedSlots);
    if (at === 0) {
      notify('先頭ページの前では分割できません。2ページ目以降を選択してください。', 'error');
      return;
    }
    const first = pages.map((_, index) => index).filter((index) => index < at);
    const second = pages.map((_, index) => index).filter((index) => index >= at);
    setConfirm({ kind: 'carryMemos', action: 'split', slots: [first, second] });
  };

  /* 保存 -------------------------------------------------------------- */

  const deletedPagesWithMemos = useMemo(() => {
    const removed = new Set(removedOriginPages(originalPages.current.length, pages));
    if (removed.size === 0) return [];
    return fileMemos.filter((memo) => {
      if (memo.pageStart === undefined) return false;
      const end = memo.pageEnd ?? memo.pageStart;
      for (let page = memo.pageStart; page <= end; page += 1) {
        if (!removed.has(page)) return false;
      }
      // 対象ページがすべて削除される = 紐付けが外れるメモ
      return true;
    });
  }, [fileMemos, pages]);

  /** 結合で取り込んだ、アプリ内の別 PDF (メモの引き継ぎ対象)。 */
  const mergedSources = useMemo(() => buildImportMapping(pages), [pages]);

  const runSave = useCallback(
    async (mode: SaveMode, carryMergedMemos = false) => {
      if (savingRef.current) {
        notify('保存の処理中です。完了までお待ちください。', 'info');
        return;
      }
      savingRef.current = true;
      setSheet(null);
      setConfirm(null);
      setProgress({ phase: 'building', percent: 0 });

      try {
        const result = await saveEdit({
          file,
          originalBlob: blob,
          originalPages: originalPages.current,
          pages,
          assets: assets.current,
          mode,
          copyName: `${stripPdfExtension(file.name)} (編集).pdf`,
          copyParentId: toParentKey(file.parentId),
          keepCount: settings.versionKeepCount,
          keepDays: settings.versionKeepDays,
          onProgress: (phase, percent) => setProgress({ phase, percent }),
        });

        // 結合で取り込んだ PDF のメモを、引き継ぐと答えた場合だけ複製する。
        // 取り込み元の PDF とそのメモには一切手を触れない。
        let mergedCarried = 0;
        if (carryMergedMemos) {
          for (const [sourceFileId, mapping] of mergedSources) {
            try {
              mergedCarried += await transferMemos(sourceFileId, result.file.id, mapping);
            } catch {
              // 引き継ぎに失敗しても、保存された PDF と元のメモは無事
            }
          }
          if (mergedCarried > 0) await reloadMemos();
        }

        const notes: string[] = [];
        if (mergedCarried > 0) notes.push(`結合元のメモ ${mergedCarried} 件を引き継ぎました。`);
        if (result.memosMoved > 0) notes.push(`メモ ${result.memosMoved} 件の対象ページを更新しました。`);
        if (result.memosDetached > 0) {
          notes.push(`対象ページが無くなったメモ ${result.memosDetached} 件は、PDF全体へのメモとして残しました。`);
        }

        onSaved({
          mode,
          file: result.file,
          message:
            mode === 'overwrite'
              ? `PDFを上書き保存しました。${notes.join('')}`
              : `編集内容を「${result.file.name}」として保存しました。`,
        });
      } catch (error) {
        notify(toMessage(error), 'error');
      } finally {
        savingRef.current = false;
        setProgress(null);
      }
    },
    [
      blob,
      file,
      mergedSources,
      notify,
      onSaved,
      pages,
      reloadMemos,
      settings.versionKeepCount,
      settings.versionKeepDays,
    ],
  );

  /** 削除警告のあとに通る、結合メモの確認。 */
  const afterDeleteWarning = (mode: SaveMode) => {
    if (mergedSources.size > 0) {
      setConfirm({ kind: 'mergeMemos', mode });
      return;
    }
    void runSave(mode);
  };

  const requestSave = (mode: SaveMode) => {
    // 上書きで消えるページにメモが付いているときは、先に知らせる
    if (mode === 'overwrite' && deletedPagesWithMemos.length > 0) {
      setConfirm({ kind: 'deleteWarning', mode });
      return;
    }
    afterDeleteWarning(mode);
  };

  const discard = async () => {
    await clearDraft(file.id);
    setConfirm(null);
    onClose();
  };

  const changed = !loading && !isUnchanged(originalPages.current, pages);

  /* 画面 -------------------------------------------------------------- */

  const otherPdfs = files.filter((entry) => !entry.deletedAt && entry.id !== file.id);

  return (
    <div className="fixed inset-0 z-[64] flex flex-col bg-[#20262d]">
      {/* 上部ツールバー */}
      <div
        className="flex shrink-0 items-center gap-0.5 bg-[#171c22] px-1"
        style={{ paddingTop: 'var(--safe-top)' }}
      >
        <IconButton
          label="閉じる"
          className="text-white"
          onClick={() => (changed ? setConfirm({ kind: 'discard' }) : onClose())}
        >
          <X size={22} />
        </IconButton>
        <div className="min-w-0 flex-1 px-1">
          <p className="truncate text-sm text-white">{middleEllipsis(file.name, 24)}</p>
          <p className="truncate text-xs text-[#98a3b0]">
            ページ管理 ・ {pages.length}ページ
            {selection.size > 0 ? ` ・ ${selection.size}ページ選択中` : ''}
          </p>
        </div>
        <IconButton
          label="元に戻す"
          className="text-white disabled:opacity-30"
          disabled={past.length === 0}
          onClick={undo}
        >
          <Undo2 size={20} />
        </IconButton>
        <IconButton
          label="やり直す"
          className="text-white disabled:opacity-30"
          disabled={future.length === 0}
          onClick={redo}
        >
          <Redo2 size={20} />
        </IconButton>
        <IconButton label="保存" className="text-white" onClick={() => setSheet('save')}>
          <Save size={21} />
        </IconButton>
      </div>

      {/* ページ一覧 */}
      <div ref={scroller} className="no-h-swipe flex-1 overflow-y-auto overscroll-contain p-3">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="h-8 w-8 border-[#4a5563] border-t-white" />
          </div>
        ) : (
          <ul className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
            {pages.map((page, index) => {
              const url = thumbOf(page);
              const selected = selection.has(page.key);
              return (
                <li
                  key={page.key}
                  ref={(element) => {
                    if (element) tiles.current.set(page.key, element);
                    else tiles.current.delete(page.key);
                  }}
                  className={cx(
                    'relative rounded-card border-2 bg-[#171c22] p-1 transition-opacity',
                    selected ? 'border-brand-400' : 'border-transparent',
                    dragKey === page.key ? 'opacity-50' : '',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleSelect(page.key)}
                    aria-pressed={selected}
                    aria-label={`${index + 1}ページ目${selected ? '（選択中）' : ''}`}
                    className="block w-full"
                  >
                    <span className="flex aspect-[1/1.32] items-center justify-center overflow-hidden rounded-[3px] bg-white">
                      {url ? (
                        // 生成したサムネイルは Blob URL のため next/image ではなく img を使う
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={url}
                          alt=""
                          className="max-h-full max-w-full object-contain transition-transform"
                          style={{ transform: `rotate(${page.rotation}deg)` }}
                        />
                      ) : (
                        <span className="text-xs text-ink-faint">
                          {page.source.kind === 'blank' ? '空白' : '…'}
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block text-center text-xs text-white">{index + 1}</span>
                  </button>

                  {/* ドラッグ用のつまみ (ここを持って動かす) */}
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`${index + 1}ページ目を移動`}
                    onPointerDown={(event) => startDrag(event, page.key)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    className="absolute right-0.5 top-0.5 flex h-9 w-9 touch-none items-center justify-center rounded-card bg-[rgba(23,28,34,0.82)] text-white"
                  >
                    <SquareStack size={16} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 下部ツールバー */}
      <div className="shrink-0 bg-[#171c22]" style={{ paddingBottom: 'var(--safe-bottom)' }}>
        <div className="flex items-center justify-between gap-1 px-1 py-1">
          <IconButton
            label="左に回転"
            className="text-white"
            onClick={() => rotate(-90)}
            disabled={pages.length === 0}
          >
            <RotateCcw size={21} />
          </IconButton>
          <IconButton
            label="右に回転"
            className="text-white"
            onClick={() => rotate(90)}
            disabled={pages.length === 0}
          >
            <RotateCw size={21} />
          </IconButton>
          <IconButton
            label="複製"
            className="text-white disabled:opacity-30"
            onClick={duplicateSelected}
            disabled={selection.size === 0}
          >
            <Copy size={20} />
          </IconButton>
          <IconButton
            label="削除"
            className="text-white disabled:opacity-30"
            onClick={removeSelected}
            disabled={selection.size === 0}
          >
            <Trash2 size={20} />
          </IconButton>
          <IconButton label="ページを追加" className="text-white" onClick={() => setSheet('insert')}>
            <Plus size={22} />
          </IconButton>
          <IconButton
            label="抽出"
            className="text-white disabled:opacity-30"
            onClick={askExtract}
            disabled={selection.size === 0}
          >
            <FileOutput size={20} />
          </IconButton>
          <IconButton
            label="分割"
            className="text-white disabled:opacity-30"
            onClick={askSplit}
            disabled={selection.size === 0}
          >
            <Scissors size={20} />
          </IconButton>
        </div>
        <p className="px-3 pb-1.5 text-center text-xs text-[#98a3b0]">
          {selection.size > 0
            ? 'ページをタップして選択を解除できます'
            : 'ページをタップで選択、右上のつまみで並べ替え'}
        </p>
      </div>

      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          void addImages(event.target.files);
          event.target.value = '';
        }}
      />

      {/* ページの追加 */}
      <BottomSheet
        open={sheet === 'insert'}
        title="ページを追加"
        description={`${insertAt} ページ目のうしろに追加します`}
        onClose={() => setSheet(null)}
      >
        <MenuRow icon={<FilePlus2 size={20} />} label="空白ページを追加" onClick={addBlank} />
        <MenuRow
          icon={<ImagePlus size={20} />}
          label="画像をPDFページとして追加"
          description="端末内の写真を選びます"
          onClick={() => {
            setSheet(null);
            imageInput.current?.click();
          }}
        />
        <MenuRow
          icon={<SquareStack size={20} />}
          label="別のPDFからページを追加"
          description="選んだPDFの全ページを結合します"
          onClick={() => setSheet('pickPdf')}
        />
      </BottomSheet>

      {/* 結合するPDFの選択 */}
      <BottomSheet
        open={sheet === 'pickPdf'}
        title="追加するPDFを選択"
        description="選んだPDFの全ページを、この位置へ結合します"
        onClose={() => setSheet(null)}
      >
        {otherPdfs.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-sub dark:text-[#98a3b0]">
            ほかにPDFがありません。
          </p>
        ) : (
          otherPdfs.map((entry) => (
            <MenuRow
              key={entry.id}
              icon={<FilePlus2 size={20} />}
              label={entry.name}
              description={`${formatBytes(entry.size)}${entry.pageCount ? ` ・ ${entry.pageCount}ページ` : ''}`}
              onClick={() => void addFromPdf(entry)}
            />
          ))
        )}
      </BottomSheet>

      {/* 保存方法 */}
      <BottomSheet
        open={sheet === 'save'}
        title="編集内容の保存"
        description={changed ? undefined : '変更はまだありません'}
        onClose={() => setSheet(null)}
      >
        <MenuRow
          icon={<Save size={20} />}
          label="上書き保存"
          description="編集前のPDFはバージョン履歴に残ります"
          disabled={!changed}
          onClick={() => requestSave('overwrite')}
        />
        <MenuRow
          icon={<Copy size={20} />}
          label="コピーとして保存"
          description="元のPDFはそのまま残ります"
          disabled={!changed}
          onClick={() => requestSave('copy')}
        />
        <div className="my-1 border-t divider" />
        <MenuRow
          icon={<Trash2 size={20} />}
          label="編集を破棄"
          tone="danger"
          onClick={() => {
            setSheet(null);
            setConfirm({ kind: 'discard' });
          }}
        />
      </BottomSheet>

      {/* 破棄の確認 */}
      <Dialog
        open={confirm?.kind === 'discard'}
        title="編集を破棄しますか？"
        description="この画面で行ったページの変更は保存されません。元のPDFはそのまま残ります。"
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              編集を続ける
            </Button>
            <Button variant="danger" onClick={() => void discard()}>
              破棄する
            </Button>
          </>
        }
      />

      {/* 削除されるページにメモがあるときの警告 */}
      <Dialog
        open={confirm?.kind === 'deleteWarning'}
        title="メモが付いたページを削除します"
        description={`削除するページに ${deletedPagesWithMemos.length} 件のメモが紐付いています。メモは削除しません。対象ページが無くなるため、PDF全体へのメモとして残します。`}
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              キャンセル
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const mode = confirm?.kind === 'deleteWarning' ? confirm.mode : 'overwrite';
                setConfirm(null);
                afterDeleteWarning(mode);
              }}
            >
              このまま保存
            </Button>
          </>
        }
      />

      {/* 結合したPDFのメモを引き継ぐか */}
      <Dialog
        open={confirm?.kind === 'mergeMemos'}
        title="結合元のメモを引き継ぎますか？"
        description={`他のPDFから追加したページがあります。追加元のPDFに付いていたメモを、このPDFへ引き継ぎますか？追加元のPDFとそのメモはそのまま残ります。`}
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                const mode = confirm?.kind === 'mergeMemos' ? confirm.mode : 'overwrite';
                setConfirm(null);
                void runSave(mode, false);
              }}
            >
              引き継がない
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const mode = confirm?.kind === 'mergeMemos' ? confirm.mode : 'overwrite';
                setConfirm(null);
                void runSave(mode, true);
              }}
            >
              引き継ぐ
            </Button>
          </>
        }
      />

      {/* 抽出・分割のメモ引き継ぎ確認 */}
      <Dialog
        open={confirm?.kind === 'carryMemos'}
        title={confirm?.kind === 'carryMemos' && confirm.action === 'split' ? 'PDFを分割します' : 'ページを抽出します'}
        description="対象ページに紐付いたメモを、新しいPDFへ引き継ぎますか？元のPDFとそのメモはそのまま残ります。"
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                if (confirm?.kind !== 'carryMemos') return;
                const groups = confirm.slots;
                const action = confirm.action;
                setConfirm(null);
                void writeSubsets(namesFor(file, action, groups), false);
              }}
            >
              引き継がない
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (confirm?.kind !== 'carryMemos') return;
                const groups = confirm.slots;
                const action = confirm.action;
                setConfirm(null);
                void writeSubsets(namesFor(file, action, groups), true);
              }}
            >
              引き継ぐ
            </Button>
          </>
        }
      />

      {/* 進捗 */}
      {progress ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[rgba(15,23,32,0.45)] px-8">
          <div className="w-full max-w-xs rounded-sheet bg-surface p-4 shadow-pop dark:bg-[#181e26]">
            <div className="flex items-center gap-3">
              <Spinner />
              <p className="min-w-0 flex-1 text-base text-ink dark:text-[#e6eaef]">
                {SAVE_PHASE_LABELS[progress.phase]}
              </p>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line dark:bg-[#39434f]">
              <div
                className="h-full rounded-full bg-brand-500 transition-[width]"
                style={{ width: `${Math.max(4, progress.percent)}%` }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 抽出・分割で作る PDF の名前。 */
function namesFor(
  file: PdfFileMeta,
  action: 'extract' | 'split',
  groups: number[][],
): { slots: number[]; name: string }[] {
  const base = stripPdfExtension(file.name);
  if (action === 'extract') {
    return [{ slots: groups[0], name: `${base} (抽出).pdf` }];
  }
  return groups.map((slots, index) => ({ slots, name: `${base} (${index + 1}).pdf` }));
}

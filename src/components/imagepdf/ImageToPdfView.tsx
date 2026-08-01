'use client';

/**
 * 複数の画像から 1 つの PDF を作る画面。
 *
 * 画面の流れ:
 *   選択・並べ替え (edit) → 作成中 (building) → 完了 (done)
 *
 * 元画像には一切手を触れない。回転・並べ替え・削除は、この画面が持つ配列の
 * 操作にすぎず、PDF を組み立てるときにだけ反映される。
 * 端末が固まらないよう、画像は 1 枚ずつ順番に処理する (詳細は lib/imageToPdf.ts)。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Camera,
  Check,
  Copy,
  FolderInput,
  GripVertical,
  ImagePlus,
  RotateCw,
  Settings2,
  SquareStack,
  Trash2,
  X,
} from 'lucide-react';
import { toMessage } from '@/lib/errors';
import { formatBytes } from '@/lib/format';
import {
  buildImagePdf,
  canStartBuild,
  checkImageLimits,
  estimateOutputBytes,
  isSupportedImage,
  toSourceImage,
  type BuildFailure,
  type FailureChoice,
  type SourceImage,
} from '@/lib/imageToPdf';
import {
  clearImagePdfDraft,
  draftToImages,
  readImagePdfDraft,
  saveImagePdfDraft,
} from '@/lib/imagePdfDraft';
import { ensurePdfExtension, stripPdfExtension } from '@/lib/naming';
import { ROOT_NAME, pathString } from '@/lib/tree';
import {
  LAYOUT_LABELS,
  PAPER_LABELS,
  QUALITY_LABELS,
  ROOT_ID,
  type Folder,
  type ImageLayout,
  type ImagePdfOptions,
  type PageOrientation,
  type PaperSize,
  type QualityPreset,
} from '@/lib/types';
import { Button, IconButton, Spinner, cx } from '@/components/ui/Primitives';
import { BottomSheet, Dialog } from '@/components/ui/Sheet';
import { FolderPicker } from '@/components/dialogs/FolderPicker';

/** 完了画面に表示する情報。保存は親 (AppShell) が行う。 */
export type ImagePdfSaved = {
  fileId: string;
  fileName: string;
  folderPath: string;
  pageCount: number;
  size: number;
  /** 自動分類で適用されたルール名 (適用されなければ undefined)。 */
  appliedRuleName?: string;
};

type Props = {
  folders: Folder[];
  initialFolderId: string;
  /** 前回使った作成設定。 */
  defaults: ImagePdfOptions;
  /** カメラで撮影して始めるか。 */
  startWith: 'gallery' | 'camera';
  onClose: () => void;
  onSaveOptions: (options: ImagePdfOptions) => void;
  onSave: (input: {
    blob: Blob;
    name: string;
    folderId: string;
    formats: string[];
    pageCount: number;
  }) => Promise<ImagePdfSaved | null>;
  onOpenFile: (fileId: string) => void;
  onShareFile: (fileId: string) => void;
  onRenameFile: (fileId: string) => void;
  onMoveFile: (fileId: string) => void;
  notify: (message: string, tone?: 'info' | 'error' | 'success') => void;
};

type Phase = 'edit' | 'building' | 'done';

function defaultFileName(): string {
  const now = new Date();
  const pad = (value: number) => `${value}`.padStart(2, '0');
  return `画像PDF ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export function ImageToPdfView({
  folders,
  initialFolderId,
  defaults,
  startWith,
  onClose,
  onSaveOptions,
  onSave,
  onOpenFile,
  onShareFile,
  onRenameFile,
  onMoveFile,
  notify,
}: Props) {
  const [images, setImages] = useState<SourceImage[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [phase, setPhase] = useState<Phase>('edit');
  const [options, setOptions] = useState<ImagePdfOptions>(defaults);
  const [fileName, setFileName] = useState(defaultFileName());
  const [folderId, setFolderId] = useState(initialFolderId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [folderPicker, setFolderPicker] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, currentName: '' });
  const [failure, setFailure] = useState<BuildFailure | null>(null);
  const [skipped, setSkipped] = useState<BuildFailure[]>([]);
  const [saved, setSaved] = useState<ImagePdfSaved | null>(null);
  const [restorable, setRestorable] = useState<number>(0);
  const [dragId, setDragId] = useState<string | null>(null);

  const galleryInput = useRef<HTMLInputElement | null>(null);
  const cameraInput = useRef<HTMLInputElement | null>(null);
  const urls = useRef(new Map<string, string>());
  /** 二重実行を防ぐ (ボタン連打対策)。state より先に立てる必要がある。 */
  const buildingRef = useRef(false);
  const cancelRef = useRef(false);
  const failureResolver = useRef<((choice: FailureChoice) => void) | null>(null);
  const wakeLock = useRef<{ release: () => Promise<void> } | null>(null);
  /** 画面を離れるときに下書きを保存するための最新値。 */
  const latest = useRef({ images, fileName, folderId, options });
  latest.current = { images, fileName, folderId, options };

  /* 画像の Blob URL ------------------------------------------------- */
  const urlOf = useCallback((image: SourceImage) => {
    const cached = urls.current.get(image.id);
    if (cached) return cached;
    const url = URL.createObjectURL(image.blob);
    urls.current.set(image.id, url);
    return url;
  }, []);

  useEffect(() => {
    const map = urls.current;
    return () => {
      for (const url of map.values()) URL.revokeObjectURL(url);
      map.clear();
    };
  }, []);

  /* 途中状態の復元 --------------------------------------------------- */
  useEffect(() => {
    let cancelled = false;
    void readImagePdfDraft().then((draft) => {
      if (cancelled || !draft) return;
      setRestorable(draft.images.length);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 画面を離れるとき (スリープ・アプリ切り替え) に途中状態を保存する。 */
  useEffect(() => {
    const save = () => {
      const current = latest.current;
      if (current.images.length === 0) return;
      void saveImagePdfDraft({
        fileName: current.fileName,
        folderId: current.folderId,
        options: current.options,
        images: current.images,
      });
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') save();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', save);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', save);
    };
  }, []);

  /* 画像の追加 ------------------------------------------------------- */
  const addFiles = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      const accepted: SourceImage[] = [];
      let rejected = 0;
      setImages((current) => {
        let order = current.length;
        for (const file of Array.from(list)) {
          if (!isSupportedImage(file)) {
            rejected += 1;
            continue;
          }
          accepted.push(toSourceImage(file, file.name || `image-${order + 1}`, order));
          order += 1;
        }
        return [...current, ...accepted];
      });
      if (rejected > 0) {
        notify(`${rejected} 件は画像ではないため追加しませんでした。`, 'info');
      }
    },
    [notify],
  );

  // 画面を開いた直後に、その場で選択画面を出す
  useEffect(() => {
    const timer = setTimeout(() => {
      if (startWith === 'camera') cameraInput.current?.click();
      else galleryInput.current?.click();
    }, 150);
    return () => clearTimeout(timer);
  }, [startWith]);

  /* 画像の操作 ------------------------------------------------------- */
  const targets = useCallback(
    (imageId?: string) => (imageId ? new Set([imageId]) : selected),
    [selected],
  );

  const rotate = useCallback(
    (imageId?: string) => {
      const keys = targets(imageId);
      if (keys.size === 0) return;
      setImages((current) =>
        current.map((image) =>
          keys.has(image.id) ? { ...image, rotation: (image.rotation + 90) % 360 } : image,
        ),
      );
    },
    [targets],
  );

  const duplicate = useCallback(
    (imageId?: string) => {
      const keys = targets(imageId);
      if (keys.size === 0) return;
      setImages((current) => {
        const next: SourceImage[] = [];
        for (const image of current) {
          next.push(image);
          if (keys.has(image.id)) {
            next.push({ ...image, id: `${image.id}-copy-${next.length}` });
          }
        }
        return next;
      });
    },
    [targets],
  );

  const remove = useCallback(
    (imageId?: string) => {
      const keys = targets(imageId);
      if (keys.size === 0) return;
      setImages((current) => current.filter((image) => !keys.has(image.id)));
      setSelected((current) => {
        const next = new Set(current);
        for (const key of keys) next.delete(key);
        return next;
      });
      // 複製した画像は同じ Blob を共有しているため、ここでは URL を破棄しない
      // (画面を閉じるときにまとめて解放する)
    },
    [targets],
  );

  const move = useCallback((from: number, to: number) => {
    setImages((current) => {
      if (from === to || from < 0 || from >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(Math.max(0, Math.min(next.length, to)), 0, moved);
      return next;
    });
  }, []);

  /* ドラッグでの並べ替え (iPhone でも扱えるよう、専用のつまみで操作する) --- */
  const onDragMove = useCallback(
    (event: React.PointerEvent) => {
      if (!dragId) return;
      const element = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest('[data-image-id]');
      const overId = element?.getAttribute('data-image-id');
      if (!overId || overId === dragId) return;
      setImages((current) => {
        const from = current.findIndex((image) => image.id === dragId);
        const to = current.findIndex((image) => image.id === overId);
        if (from < 0 || to < 0 || from === to) return current;
        const next = [...current];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      });
    },
    [dragId],
  );

  /* 見積り ----------------------------------------------------------- */
  const totalBytes = useMemo(
    () => images.reduce((sum, image) => sum + image.blob.size, 0),
    [images],
  );
  const advice = useMemo(
    () => checkImageLimits(images.length, totalBytes),
    [images.length, totalBytes],
  );
  const estimated = useMemo(
    () => estimateOutputBytes(images, options.quality),
    [images, options.quality],
  );
  const folderLabel = folderId === ROOT_ID ? ROOT_NAME : pathString(folders, folderId);

  /* 作成 ------------------------------------------------------------- */
  const askFailure = useCallback(
    (entry: BuildFailure) =>
      new Promise<FailureChoice>((resolve) => {
        failureResolver.current = resolve;
        setFailure(entry);
      }),
    [],
  );

  const create = useCallback(async () => {
    // 連打対策。state の更新を待たずに弾く。
    if (buildingRef.current) return;
    if (!canStartBuild(images.length, totalBytes)) {
      notify(advice.message || '画像を選択してください。', 'info');
      return;
    }
    buildingRef.current = true;
    cancelRef.current = false;
    setSkipped([]);
    setProgress({ done: 0, total: images.length, currentName: '' });
    setPhase('building');

    // 作成中に画面が消えないようにする (対応していない端末では何もしない)
    try {
      const request = (
        navigator as Navigator & {
          wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
        }
      ).wakeLock;
      wakeLock.current = (await request?.request('screen')) ?? null;
    } catch {
      wakeLock.current = null;
    }

    try {
      const result = await buildImagePdf(images, {
        ...options,
        onProgress: setProgress,
        onImageError: askFailure,
        isCancelled: () => cancelRef.current,
      });
      setSkipped(result.failures);

      const savedFile = await onSave({
        blob: result.blob,
        name: ensurePdfExtension(fileName),
        folderId,
        formats: result.formats,
        pageCount: result.pageCount,
      });
      if (!savedFile) {
        setPhase('edit');
        return;
      }
      // 作成しきったので、途中状態は残さない
      await clearImagePdfDraft();
      onSaveOptions(options);
      setSaved(savedFile);
      setPhase('done');
    } catch (error) {
      // 中止したときは、選んだ画像をそのまま残して編集画面へ戻す
      const message = toMessage(error);
      if (message) notify(message, 'error');
      else notify('PDFの作成を中止しました。', 'info');
      setPhase('edit');
    } finally {
      buildingRef.current = false;
      setFailure(null);
      failureResolver.current = null;
      void wakeLock.current?.release().catch(() => undefined);
      wakeLock.current = null;
    }
  }, [advice.message, askFailure, fileName, folderId, images, notify, onSave, onSaveOptions, options, totalBytes]);

  /* ---------------------------------------------------------------- */
  /* 完了画面                                                          */
  /* ---------------------------------------------------------------- */

  if (phase === 'done' && saved) {
    return (
      <div className="fixed inset-0 z-[64] flex flex-col bg-surface dark:bg-[#11161c]">
        <div
          className="flex items-center gap-1 border-b divider px-1.5 py-1"
          style={{ paddingTop: 'calc(var(--safe-top) + 4px)' }}
        >
          <IconButton label="閉じる" onClick={onClose}>
            <X size={22} />
          </IconButton>
          <h1 className="min-w-0 flex-1 truncate px-1.5 text-lg font-semibold text-ink dark:text-[#e6eaef]">
            PDFを作成しました
          </h1>
        </div>

        <div
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
          style={{ paddingBottom: 'calc(var(--safe-bottom) + 16px)' }}
        >
          <div className="card p-4">
            <p className="break-words text-base font-medium text-ink dark:text-[#e6eaef]">
              {saved.fileName}
            </p>
            <dl className="mt-3 space-y-1 text-sm text-ink-sub dark:text-[#98a3b0]">
              <div className="flex gap-2">
                <dt className="w-20 shrink-0">保存先</dt>
                <dd className="min-w-0 flex-1 break-words">{saved.folderPath}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0">ページ数</dt>
                <dd className="min-w-0 flex-1">{saved.pageCount} ページ</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0">ファイル容量</dt>
                <dd className="min-w-0 flex-1">{formatBytes(saved.size)}</dd>
              </div>
              {saved.appliedRuleName ? (
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0">自動分類</dt>
                  <dd className="min-w-0 flex-1 break-words">
                    {saved.appliedRuleName}ルールが適用されました
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>

          {skipped.length > 0 ? (
            <div className="card mt-3 p-4">
              <p className="text-sm font-medium text-pdf">
                除外した画像（{skipped.length} 件）
              </p>
              {skipped.map((entry) => (
                <p
                  key={entry.id}
                  className="mt-1 break-words text-xs text-ink-sub dark:text-[#98a3b0]"
                >
                  {entry.name}：{entry.reason}
                </p>
              ))}
            </div>
          ) : null}

          <div className="mt-4 space-y-2">
            <Button variant="primary" className="w-full" onClick={() => onOpenFile(saved.fileId)}>
              PDFを開く
            </Button>
            <Button variant="secondary" className="w-full" onClick={() => onRenameFile(saved.fileId)}>
              名前を変更
            </Button>
            <Button variant="secondary" className="w-full" onClick={() => onMoveFile(saved.fileId)}>
              フォルダーを変更
            </Button>
            <Button variant="secondary" className="w-full" onClick={() => onShareFile(saved.fileId)}>
              共有
            </Button>
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => {
                // 画像はそのまま残っているので、追加して作り直せる
                setSaved(null);
                setPhase('edit');
                setFileName(defaultFileName());
              }}
            >
              画像を追加して再編集
            </Button>
            <Button variant="ghost" className="w-full" onClick={onClose}>
              閉じる
            </Button>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /* 選択・並べ替え画面                                                */
  /* ---------------------------------------------------------------- */

  const selectionCount = selected.size;

  return (
    <div className="fixed inset-0 z-[64] flex flex-col bg-surface-sub dark:bg-[#11161c]">
      <div
        className="flex items-center gap-1 border-b divider bg-surface px-1.5 py-1 dark:bg-[#181e26]"
        style={{ paddingTop: 'calc(var(--safe-top) + 4px)' }}
      >
        <IconButton label="閉じる" onClick={onClose}>
          <X size={22} />
        </IconButton>
        <div className="min-w-0 flex-1 px-1.5">
          <h1 className="truncate text-lg font-semibold text-ink dark:text-[#e6eaef]">
            画像からPDFを作成
          </h1>
          <p className="truncate text-xs text-ink-sub dark:text-[#98a3b0]">
            {images.length} 枚 ・ 合計 {formatBytes(totalBytes)}
            {images.length > 0 ? ` ・ 作成後の目安 ${formatBytes(estimated)}` : ''}
          </p>
        </div>
        <IconButton label="PDFの設定" onClick={() => setSettingsOpen(true)}>
          <Settings2 size={22} />
        </IconButton>
      </div>

      <input
        ref={galleryInput}
        type="file"
        accept="image/*,.heic,.heif"
        multiple
        className="hidden"
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = '';
        }}
      />
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = '';
        }}
      />

      {/* 操作 */}
      <div className="flex gap-2 overflow-x-auto border-b divider bg-surface px-3 py-2 dark:bg-[#181e26]">
        <Button
          variant="secondary"
          className="h-10 min-h-0 shrink-0 px-3 text-sm"
          onClick={() => galleryInput.current?.click()}
        >
          <ImagePlus size={16} />
          画像を追加
        </Button>
        <Button
          variant="secondary"
          className="h-10 min-h-0 shrink-0 px-3 text-sm"
          onClick={() => cameraInput.current?.click()}
        >
          <Camera size={16} />
          撮影
        </Button>
        <Button
          variant="secondary"
          className="h-10 min-h-0 shrink-0 px-3 text-sm"
          disabled={selectionCount === 0}
          onClick={() => rotate()}
        >
          <RotateCw size={16} />
          回転
        </Button>
        <Button
          variant="secondary"
          className="h-10 min-h-0 shrink-0 px-3 text-sm"
          disabled={selectionCount === 0}
          onClick={() => duplicate()}
        >
          <Copy size={16} />
          複製
        </Button>
        <Button
          variant="secondary"
          className="h-10 min-h-0 shrink-0 px-3 text-sm"
          disabled={selectionCount === 0}
          onClick={() => remove()}
        >
          <Trash2 size={16} />
          削除
        </Button>
        <Button
          variant="secondary"
          className="h-10 min-h-0 shrink-0 px-3 text-sm"
          disabled={selectionCount === 0}
          onClick={() => setSelected(new Set())}
        >
          すべて選択解除
        </Button>
        <Button
          variant="secondary"
          className="h-10 min-h-0 shrink-0 px-3 text-sm"
          disabled={images.length < 2}
          onClick={() =>
            setImages((current) =>
              [...current].sort(
                (a, b) => (a.takenAt ?? 0) - (b.takenAt ?? 0) || a.pickedOrder - b.pickedOrder,
              ),
            )
          }
        >
          撮影日時順
        </Button>
        <Button
          variant="secondary"
          className="h-10 min-h-0 shrink-0 px-3 text-sm"
          disabled={images.length < 2}
          onClick={() =>
            setImages((current) => [...current].sort((a, b) => a.pickedOrder - b.pickedOrder))
          }
        >
          選択順に戻す
        </Button>
      </div>

      {advice.level !== 'ok' ? (
        <p
          className={cx(
            'px-4 py-2 text-xs leading-relaxed',
            advice.level === 'split'
              ? 'bg-[#fdecea] text-pdf-dark dark:bg-[#3a2320] dark:text-[#f4a9a1]'
              : 'bg-[#fdf3e2] text-folder-dark dark:bg-[#332a17] dark:text-folder-light',
          )}
        >
          {advice.message}
        </p>
      ) : null}

      {restorable > 0 && images.length === 0 ? (
        <div className="flex items-center gap-2 border-b divider bg-surface px-4 py-3 dark:bg-[#181e26]">
          <p className="min-w-0 flex-1 text-sm text-ink-sub dark:text-[#98a3b0]">
            前回の途中状態が {restorable} 枚ぶん残っています。
          </p>
          <Button
            variant="secondary"
            className="h-9 min-h-0 shrink-0 px-3 text-sm"
            onClick={() => {
              void readImagePdfDraft().then((draft) => {
                if (!draft) return;
                setImages(draftToImages(draft));
                setFileName(draft.fileName);
                setFolderId(draft.folderId);
                setOptions(draft.options);
                setRestorable(0);
              });
            }}
          >
            続きから
          </Button>
          <Button
            variant="ghost"
            className="h-9 min-h-0 shrink-0 px-2 text-sm"
            onClick={() => {
              void clearImagePdfDraft();
              setRestorable(0);
            }}
          >
            破棄
          </Button>
        </div>
      ) : null}

      {/* サムネイル一覧 */}
      <div
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3"
        onPointerMove={onDragMove}
        onPointerUp={() => setDragId(null)}
        onPointerCancel={() => setDragId(null)}
      >
        {images.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <p className="text-base text-ink dark:text-[#e6eaef]">画像が選ばれていません</p>
            <p className="mt-2 text-sm leading-relaxed text-ink-sub dark:text-[#98a3b0]">
              「画像を追加」から写真やファイルを選ぶか、「撮影」でその場で撮影できます。
              JPEG・PNG・WebP・HEIC・HEIFに対応しています。
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {images.map((image, index) => (
              <div
                key={image.id}
                data-image-id={image.id}
                className={cx(
                  'relative overflow-hidden rounded-card border bg-surface dark:bg-[#181e26]',
                  dragId === image.id
                    ? 'border-brand-500 opacity-60'
                    : selected.has(image.id)
                      ? 'border-brand-500'
                      : 'border-line dark:border-[#333d49]',
                )}
              >
                <button
                  type="button"
                  className="block w-full"
                  aria-label={`${index + 1}枚目を${selected.has(image.id) ? '選択解除' : '選択'}`}
                  onClick={() =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(image.id)) next.delete(image.id);
                      else next.add(image.id);
                      return next;
                    })
                  }
                >
                  {/* 選択直後のプレビューは Blob URL のため img を使う */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={urlOf(image)}
                    alt={`${index + 1}枚目`}
                    className="h-28 w-full object-cover"
                    style={{ transform: `rotate(${image.rotation}deg)` }}
                    onLoad={(event) => {
                      const element = event.currentTarget;
                      if (!element.naturalWidth) return;
                      setImages((current) =>
                        current.map((entry) =>
                          entry.id === image.id && !entry.width
                            ? {
                                ...entry,
                                width: element.naturalWidth,
                                height: element.naturalHeight,
                              }
                            : entry,
                        ),
                      );
                    }}
                  />
                </button>

                <span className="absolute left-1 top-1 rounded-[3px] bg-[rgba(15,23,32,0.7)] px-1.5 py-0.5 text-xs text-white">
                  {index + 1}
                </span>
                {selected.has(image.id) ? (
                  <span className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-brand-500 text-white">
                    <Check size={14} />
                  </span>
                ) : null}

                <div className="flex items-center justify-between border-t divider px-1 py-0.5">
                  <button
                    type="button"
                    aria-label={`${index + 1}枚目を並べ替え`}
                    onPointerDown={(event) => {
                      event.currentTarget.setPointerCapture(event.pointerId);
                      setDragId(image.id);
                    }}
                    onPointerUp={() => setDragId(null)}
                    className="flex h-9 w-9 items-center justify-center text-ink-sub"
                    style={{ touchAction: 'none' }}
                  >
                    <GripVertical size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label={`${index + 1}枚目を前へ`}
                    disabled={index === 0}
                    onClick={() => move(index, index - 1)}
                    className="flex h-9 w-7 items-center justify-center text-ink-sub disabled:opacity-30"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    aria-label={`${index + 1}枚目を後ろへ`}
                    disabled={index === images.length - 1}
                    onClick={() => move(index, index + 1)}
                    className="flex h-9 w-7 items-center justify-center text-ink-sub disabled:opacity-30"
                  >
                    ›
                  </button>
                  <button
                    type="button"
                    aria-label={`${index + 1}枚目を回転`}
                    onClick={() => rotate(image.id)}
                    className="flex h-9 w-9 items-center justify-center text-ink-sub"
                  >
                    <RotateCw size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label={`${index + 1}枚目を削除`}
                    onClick={() => remove(image.id)}
                    className="flex h-9 w-9 items-center justify-center text-pdf"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 作成 */}
      <div
        className="border-t divider bg-surface px-4 py-3 dark:bg-[#181e26]"
        style={{ paddingBottom: 'calc(var(--safe-bottom) + 12px)' }}
      >
        <p className="mb-2 truncate text-xs text-ink-sub dark:text-[#98a3b0]">
          {ensurePdfExtension(fileName)} ・ {folderLabel}
        </p>
        <Button
          variant="primary"
          className="w-full"
          disabled={images.length === 0 || advice.level === 'split' || phase === 'building'}
          onClick={() => void create()}
        >
          <SquareStack size={18} />
          PDFを作成（{images.length} 枚）
        </Button>
      </div>

      {/* PDF の設定 */}
      <BottomSheet
        open={settingsOpen}
        title="PDFの設定"
        description={`作成後のファイル容量の目安：${formatBytes(estimated)}`}
        onClose={() => setSettingsOpen(false)}
        footer={
          <Button variant="primary" className="w-full" onClick={() => setSettingsOpen(false)}>
            完了
          </Button>
        }
      >
        <div className="px-4 py-3">
          <p className="mb-1.5 text-sm text-ink-sub dark:text-[#98a3b0]">PDFファイル名</p>
          <input
            className="field"
            value={fileName}
            onChange={(event) => setFileName(stripPdfExtension(event.target.value))}
          />
        </div>

        <div className="px-4 py-3">
          <p className="mb-1.5 text-sm text-ink-sub dark:text-[#98a3b0]">保存先フォルダー</p>
          <button
            type="button"
            onClick={() => setFolderPicker(true)}
            className="flex min-h-tap w-full items-center gap-2 rounded-card border border-line px-3 text-left dark:border-[#333d49]"
          >
            <FolderInput size={18} className="shrink-0 text-ink-sub" />
            <span className="min-w-0 flex-1 truncate text-base text-ink dark:text-[#e6eaef]">
              {folderLabel}
            </span>
          </button>
        </div>

        <OptionRow label="用紙サイズ">
          <select
            className="field"
            aria-label="用紙サイズ"
            value={options.paper}
            onChange={(event) =>
              setOptions((current) => ({ ...current, paper: event.target.value as PaperSize }))
            }
          >
            {(Object.keys(PAPER_LABELS) as PaperSize[]).map((paper) => (
              <option key={paper} value={paper}>
                {PAPER_LABELS[paper]}
              </option>
            ))}
          </select>
        </OptionRow>

        <OptionRow label="向き">
          <div className="flex gap-2">
            {(['portrait', 'landscape'] as PageOrientation[]).map((orientation) => (
              <button
                key={orientation}
                type="button"
                disabled={options.paper === 'auto'}
                onClick={() => setOptions((current) => ({ ...current, orientation }))}
                className={cx(
                  'min-h-tap flex-1 rounded-card border px-3 text-sm disabled:opacity-40',
                  options.orientation === orientation
                    ? 'border-brand-500 bg-brand-50 text-brand-600 dark:bg-[#16233a] dark:text-brand-200'
                    : 'border-line text-ink-sub dark:border-[#333d49] dark:text-[#98a3b0]',
                )}
              >
                {orientation === 'portrait' ? '縦向き' : '横向き'}
              </button>
            ))}
          </div>
        </OptionRow>

        <OptionRow label={`余白（${options.marginMm}mm）`}>
          <input
            type="range"
            className="w-full"
            min={0}
            max={30}
            step={1}
            aria-label="余白"
            value={options.marginMm}
            onChange={(event) =>
              setOptions((current) => ({ ...current, marginMm: Number(event.target.value) }))
            }
          />
        </OptionRow>

        <OptionRow label="画像の配置方法">
          <select
            className="field"
            aria-label="画像の配置方法"
            value={options.layout}
            onChange={(event) =>
              setOptions((current) => ({ ...current, layout: event.target.value as ImageLayout }))
            }
          >
            {(Object.keys(LAYOUT_LABELS) as ImageLayout[]).map((layout) => (
              <option key={layout} value={layout}>
                {LAYOUT_LABELS[layout]}
              </option>
            ))}
          </select>
        </OptionRow>

        <OptionRow label="画質">
          <select
            className="field"
            aria-label="画質"
            value={options.quality}
            onChange={(event) =>
              setOptions((current) => ({
                ...current,
                quality: event.target.value as QualityPreset,
              }))
            }
          >
            {(Object.keys(QUALITY_LABELS) as QualityPreset[]).map((quality) => (
              <option key={quality} value={quality}>
                {QUALITY_LABELS[quality]}（目安 {formatBytes(estimateOutputBytes(images, quality))}）
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
            解像度が高すぎる画像は、PDFの閲覧に十分な大きさへ縮小して埋め込みます。元の画像は変更しません。
          </p>
        </OptionRow>

        <OptionRow label="1ページあたりの画像">
          <div className="flex gap-2">
            {([1, 2, 4] as const).map((count) => (
              <button
                key={count}
                type="button"
                onClick={() => setOptions((current) => ({ ...current, imagesPerPage: count }))}
                className={cx(
                  'min-h-tap flex-1 rounded-card border px-3 text-sm',
                  options.imagesPerPage === count
                    ? 'border-brand-500 bg-brand-50 text-brand-600 dark:bg-[#16233a] dark:text-brand-200'
                    : 'border-line text-ink-sub dark:border-[#333d49] dark:text-[#98a3b0]',
                )}
              >
                {count === 1 ? '1枚' : `${count}枚`}
              </button>
            ))}
          </div>
        </OptionRow>

        <OptionRow label="パスワード（開くときに必要）">
          <input
            className="field"
            type="password"
            autoComplete="new-password"
            placeholder="設定しない場合は空のまま"
            value={options.password ?? ''}
            onChange={(event) =>
              setOptions((current) => ({ ...current, password: event.target.value || undefined }))
            }
          />
          <p className="mt-1.5 text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
            半角の英数字と記号が使えます。忘れると開けなくなるためご注意ください。
          </p>
        </OptionRow>
      </BottomSheet>

      <FolderPicker
        open={folderPicker}
        title="保存先のフォルダーを選択"
        confirmLabel="ここに保存"
        folders={folders}
        initialFolderId={folderId}
        onClose={() => setFolderPicker(false)}
        onConfirm={(id) => {
          setFolderId(id);
          setFolderPicker(false);
        }}
      />

      {/* 作成中（失敗の確認を出している間は隠して、選択の邪魔をしない） */}
      {phase === 'building' && !failure ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[rgba(15,23,32,0.45)] px-8">
          <div className="w-full max-w-sm rounded-sheet bg-surface p-5 shadow-pop dark:bg-[#181e26]">
            <div className="flex items-center gap-3">
              <Spinner />
              <p className="text-base text-ink dark:text-[#e6eaef]">
                {progress.done} / {progress.total}枚を処理中
              </p>
            </div>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-line dark:bg-[#333d49]">
              <div
                className="h-full bg-brand-500 transition-all"
                style={{
                  width: `${progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)}%`,
                }}
              />
            </div>
            <p className="mt-2 truncate text-xs text-ink-sub dark:text-[#98a3b0]">
              {progress.currentName}
            </p>
            <Button
              variant="secondary"
              className="mt-4 w-full"
              onClick={() => {
                cancelRef.current = true;
                // 失敗の確認中なら、その場で中止を選んだことにする
                failureResolver.current?.('abort');
                failureResolver.current = null;
                setFailure(null);
              }}
            >
              キャンセル
            </Button>
          </div>
        </div>
      ) : null}

      {/* 途中で失敗した画像 */}
      <Dialog
        open={failure !== null}
        title="この画像を処理できませんでした"
        description={failure ? `${failure.name}：${failure.reason}` : undefined}
        onClose={() => {
          failureResolver.current?.('skip');
          failureResolver.current = null;
          setFailure(null);
        }}
        footer={
          <div className="flex w-full flex-col gap-2">
            <Button
              variant="primary"
              onClick={() => {
                failureResolver.current?.('retry');
                failureResolver.current = null;
                setFailure(null);
              }}
            >
              再試行
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                failureResolver.current?.('skip');
                failureResolver.current = null;
                setFailure(null);
              }}
            >
              この画像を除外して続行
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                cancelRef.current = true;
                failureResolver.current?.('abort');
                failureResolver.current = null;
                setFailure(null);
              }}
            >
              処理を中止
            </Button>
          </div>
        }
      />
    </div>
  );
}

function OptionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-t divider px-4 py-3">
      <p className="mb-1.5 text-sm text-ink-sub dark:text-[#98a3b0]">{label}</p>
      {children}
    </div>
  );
}

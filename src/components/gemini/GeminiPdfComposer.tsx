'use client';

import { ArrowLeft, FileText, Save, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cloudIdToken } from '@/lib/firebaseCloud';
import { createGeminiPdfBlob } from '@/lib/geminiPdf';
import { applyDateVariables, type GeminiMessage, type GeminiPreferences, type PdfDuplicateMode, type PdfOutlineResponse } from '@/lib/geminiTypes';
import { ensurePdfExtension, sanitizeName } from '@/lib/naming';
import { getPageCount } from '@/lib/pdf';
import * as repo from '@/lib/repository';
import { ROOT_ID, type Folder } from '@/lib/types';
import { ROOT_NAME, pathString } from '@/lib/tree';
import { useApp } from '@/store/AppStore';
import { Button, IconButton, Spinner } from '@/components/ui/Primitives';
import { MarkdownContent } from './MarkdownContent';

const PDF_COMPOSER_SETTINGS_KEY = 'pdf-manager:gemini-pdf-composer-settings:v1';
const DOCUMENT_TYPES = ['学習・復習資料', 'LPIC試験対策資料', '業務手順書', '要点まとめ'] as const;
const DUPLICATE_MODES: PdfDuplicateMode[] = ['replaceSameDate', 'overwrite', 'rename', 'skip'];

type PdfComposerSettings = {
  folderId: string;
  fileNameTemplate: string;
  titleTemplate: string;
  documentType: string;
  instructions: string;
  duplicateMode: PdfDuplicateMode;
};

const DEFAULT_PDF_COMPOSER_SETTINGS: PdfComposerSettings = {
  folderId: ROOT_ID,
  fileNameTemplate: '学習_yyyymmdd.pdf',
  titleTemplate: '学習まとめ yyyy-mm-dd',
  documentType: '学習・復習資料',
  instructions: '質問、勘違い、詰まった点を必ず整理してください。',
  duplicateMode: 'replaceSameDate',
};

function fieldClass() {
  return 'min-h-tap w-full rounded-xl border border-white/80 bg-white/90 px-3 py-2.5 text-base text-ink shadow-sm outline-none backdrop-blur-xl focus:border-brand-400 dark:border-[#39424e] dark:bg-[#181e26] dark:text-[#e6eaef]';
}

function GeminiBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden dark:hidden"
      style={{ background: 'linear-gradient(180deg, #ffffff 0%, #f8fbff 48%, #e7f1ff 100%)' }}
    >
      <div className="absolute -bottom-28 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-blue-200/35 blur-3xl" />
      <div className="absolute bottom-12 -left-14 h-56 w-56 rounded-full bg-cyan-200/25 blur-3xl" />
      <div className="absolute bottom-24 -right-16 h-64 w-64 rounded-full bg-indigo-200/20 blur-3xl" />
    </div>
  );
}

function normalizeSettings(value: unknown, folders: Folder[]): PdfComposerSettings {
  const saved = value && typeof value === 'object' ? (value as Partial<PdfComposerSettings>) : {};
  const folderId =
    typeof saved.folderId === 'string' &&
    (saved.folderId === ROOT_ID || folders.some((folder) => folder.id === saved.folderId && !folder.deletedAt))
      ? saved.folderId
      : ROOT_ID;

  return {
    folderId,
    fileNameTemplate:
      typeof saved.fileNameTemplate === 'string'
        ? saved.fileNameTemplate
        : DEFAULT_PDF_COMPOSER_SETTINGS.fileNameTemplate,
    titleTemplate:
      typeof saved.titleTemplate === 'string'
        ? saved.titleTemplate
        : DEFAULT_PDF_COMPOSER_SETTINGS.titleTemplate,
    documentType:
      typeof saved.documentType === 'string' && DOCUMENT_TYPES.includes(saved.documentType as (typeof DOCUMENT_TYPES)[number])
        ? saved.documentType
        : DEFAULT_PDF_COMPOSER_SETTINGS.documentType,
    instructions:
      typeof saved.instructions === 'string'
        ? saved.instructions
        : DEFAULT_PDF_COMPOSER_SETTINGS.instructions,
    duplicateMode:
      typeof saved.duplicateMode === 'string' && DUPLICATE_MODES.includes(saved.duplicateMode as PdfDuplicateMode)
        ? (saved.duplicateMode as PdfDuplicateMode)
        : DEFAULT_PDF_COMPOSER_SETTINGS.duplicateMode,
  };
}

export function GeminiPdfComposer({
  chatDate,
  messages,
  preferences,
  folders,
  onClose,
}: {
  chatDate: string;
  messages: GeminiMessage[];
  preferences: GeminiPreferences;
  folders: Folder[];
  onClose: () => void;
}) {
  const { reload, refreshStorage, notify } = useApp();
  const [folderId, setFolderId] = useState(DEFAULT_PDF_COMPOSER_SETTINGS.folderId);
  const [fileNameTemplate, setFileNameTemplate] = useState(DEFAULT_PDF_COMPOSER_SETTINGS.fileNameTemplate);
  const [titleTemplate, setTitleTemplate] = useState(DEFAULT_PDF_COMPOSER_SETTINGS.titleTemplate);
  const [documentType, setDocumentType] = useState(DEFAULT_PDF_COMPOSER_SETTINGS.documentType);
  const [instructions, setInstructions] = useState(DEFAULT_PDF_COMPOSER_SETTINGS.instructions);
  const [duplicateMode, setDuplicateMode] = useState<PdfDuplicateMode>(DEFAULT_PDF_COMPOSER_SETTINGS.duplicateMode);
  const [outline, setOutline] = useState<PdfOutlineResponse | null>(null);
  const [busy, setBusy] = useState<'outline' | 'pdf' | null>(null);
  const settingsLoaded = useRef(false);

  const activeFolders = useMemo(
    () => folders.filter((folder) => !folder.deletedAt).sort((a, b) => pathString(folders, a.id).localeCompare(pathString(folders, b.id), 'ja')),
    [folders],
  );
  const fileName = ensurePdfExtension(
    sanitizeName(applyDateVariables(fileNameTemplate, chatDate)) || `Gemini_${chatDate}.pdf`,
  );
  const title = applyDateVariables(titleTemplate, chatDate) || `学習まとめ ${chatDate}`;

  useEffect(() => {
    if (settingsLoaded.current) return;
    settingsLoaded.current = true;

    try {
      const raw = window.localStorage.getItem(PDF_COMPOSER_SETTINGS_KEY);
      if (!raw) return;
      const saved = normalizeSettings(JSON.parse(raw), folders);
      setFolderId(saved.folderId);
      setFileNameTemplate(saved.fileNameTemplate);
      setTitleTemplate(saved.titleTemplate);
      setDocumentType(saved.documentType);
      setInstructions(saved.instructions);
      setDuplicateMode(saved.duplicateMode);
    } catch {
      window.localStorage.removeItem(PDF_COMPOSER_SETTINGS_KEY);
    }
  }, [folders]);

  const persistSettings = (showNotification: boolean) => {
    try {
      const settings: PdfComposerSettings = {
        folderId,
        fileNameTemplate,
        titleTemplate,
        documentType,
        instructions,
        duplicateMode,
      };
      window.localStorage.setItem(PDF_COMPOSER_SETTINGS_KEY, JSON.stringify(settings));
      if (showNotification) notify('PDF作成設定を保存しました。', 'success');
    } catch {
      if (showNotification) notify('PDF作成設定を保存できませんでした。', 'error');
    }
  };

  const createOutline = async () => {
    if (messages.length === 0) {
      notify('この日のチャットにはPDF化できるメッセージがありません。', 'error');
      return;
    }
    persistSettings(false);
    setBusy('outline');
    try {
      const token = await cloudIdToken();
      const response = await fetch('/api/gemini/pdf/outline', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          chatDate,
          title,
          documentType,
          additionalInstructions: instructions,
          preferences,
          messages: messages
            .filter((message) => message.status !== 'streaming' && message.text.trim())
            .map((message) => ({ role: message.role, text: message.text })),
        }),
      });
      const data = (await response.json()) as PdfOutlineResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || '資料構成を生成できませんでした');
      setOutline(data);
    } catch (error) {
      notify(error instanceof Error ? error.message : '資料構成を生成できませんでした。', 'error');
    } finally {
      setBusy(null);
    }
  };

  const savePdf = async () => {
    if (!outline) return;
    setBusy('pdf');
    try {
      const blob = await createGeminiPdfBlob({
        title: outline.title,
        chatDate,
        markdown: outline.markdown,
        documentType,
      });
      const pageCount = await getPageCount(blob);
      const meta = await repo.addPdf(blob, fileName, {
        parentId: folderId,
        onDuplicate:
          duplicateMode === 'skip'
            ? 'skip'
            : duplicateMode === 'rename'
              ? 'rename'
              : 'overwrite',
        pageCount,
        origin: 'report',
        sharedFrom: 'Gemini',
        sourceFormats: ['chat', 'markdown'],
      });
      await repo.updateFile(meta.id, {
        tags: [...new Set([...outline.suggestedTags, 'Gemini生成', chatDate])],
        memo: `Geminiチャット（${chatDate}）から作成`,
      });
      await reload();
      await refreshStorage();
      notify(`「${fileName}」を保存しました。`, 'success');
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'PDFを保存できませんでした。', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[115] overflow-hidden bg-white dark:bg-[#11161c]">
      <GeminiBackdrop />
      <div className="relative z-10 h-full overflow-y-auto">
        <div className="mx-auto min-h-full max-w-3xl pb-10">
          <div className="sticky top-0 z-10 flex min-h-[58px] items-center gap-2 border-b border-white/60 bg-white/80 px-3 shadow-sm backdrop-blur-xl dark:border-[#2a323d] dark:bg-[#181e26]/95">
            <IconButton label="閉じる" onClick={onClose}>
              {outline ? <ArrowLeft size={22} /> : <X size={22} />}
            </IconButton>
            <h2 className="flex-1 text-lg font-semibold">PDF作成</h2>
            {outline ? (
              <Button onClick={() => void savePdf()} disabled={busy !== null}>
                <Save size={18} /> 保存
              </Button>
            ) : (
              <Button
                variant="secondary"
                className="min-h-9 px-3 text-sm"
                onClick={() => persistSettings(true)}
                disabled={busy !== null}
              >
                <Save size={17} /> 設定保存
              </Button>
            )}
          </div>

          {!outline ? (
            <div className="space-y-4 px-4 py-5">
              <div className="rounded-card border border-brand-200 bg-brand-50/90 px-4 py-3 text-sm leading-relaxed text-[#245469] shadow-sm backdrop-blur-xl dark:border-[#345563] dark:bg-[#1d3039] dark:text-[#dce9ef]">
                単なる会話ログではなく、質問・勘違い・重要点を整理した復習資料へ再構成します。
                <p className="mt-1 text-xs opacity-80">設定保存を押すと、ファイル名や追加指示などを次回も引き継ぎます。プレビュー生成時にも自動保存します。</p>
              </div>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">対象日</span>
                <input className={fieldClass()} value={chatDate} disabled />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">保存先フォルダー</span>
                <select className={fieldClass()} value={folderId} onChange={(event) => setFolderId(event.target.value)}>
                  <option value={ROOT_ID}>{ROOT_NAME}</option>
                  {activeFolders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {pathString(folders, folder.id)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">ファイル名</span>
                <input className={fieldClass()} value={fileNameTemplate} onChange={(event) => setFileNameTemplate(event.target.value)} />
                <p className="mt-1 text-xs text-ink-sub">保存名：{fileName}</p>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">PDFタイトル</span>
                <input className={fieldClass()} value={titleTemplate} onChange={(event) => setTitleTemplate(event.target.value)} />
                <p className="mt-1 text-xs text-ink-sub">表示タイトル：{title}</p>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">資料タイプ</span>
                <select className={fieldClass()} value={documentType} onChange={(event) => setDocumentType(event.target.value)}>
                  {DOCUMENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">追加指示</span>
                <textarea className={`${fieldClass()} min-h-28 resize-y`} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">同名PDFの扱い</span>
                <select className={fieldClass()} value={duplicateMode} onChange={(event) => setDuplicateMode(event.target.value as PdfDuplicateMode)}>
                  <option value="replaceSameDate">同じ日付のPDFを置き換える</option>
                  <option value="overwrite">上書き</option>
                  <option value="rename">末尾に連番を付ける</option>
                  <option value="skip">保存をスキップ</option>
                </select>
              </label>
              <Button className="w-full justify-center" onClick={() => void createOutline()} disabled={busy !== null || messages.length === 0}>
                {busy === 'outline' ? <Spinner /> : <Sparkles size={19} />}
                内容を生成してプレビュー
              </Button>
            </div>
          ) : (
            <div className="px-4 py-5">
              <div className="mb-4 flex items-center gap-2 rounded-card border border-white/70 bg-white/85 px-4 py-3 shadow-sm backdrop-blur-xl dark:border-[#2a323d] dark:bg-[#181e26]">
                <FileText size={20} className="text-brand-500" />
                <div className="min-w-0">
                  <p className="truncate font-semibold">{fileName}</p>
                  <p className="text-xs text-ink-sub">保存前のプレビューです。内容を確認してから保存してください。</p>
                </div>
              </div>
              <article className="rounded-card border border-white/70 bg-white/90 px-4 py-5 shadow-card backdrop-blur-xl dark:border-[#2a323d] dark:bg-[#181e26]">
                <h1 className="mb-1 text-2xl font-bold text-[#173f55] dark:text-[#dce9ef]">{outline.title}</h1>
                <p className="mb-6 text-sm text-ink-sub">対象日：{chatDate}</p>
                <MarkdownContent markdown={outline.markdown} />
              </article>
              <div className="mt-4 flex gap-3">
                <Button className="flex-1 justify-center" variant="secondary" onClick={() => setOutline(null)} disabled={busy !== null}>
                  条件を修正
                </Button>
                <Button className="flex-1 justify-center" onClick={() => void savePdf()} disabled={busy !== null}>
                  {busy === 'pdf' ? <Spinner /> : <Save size={18} />} 保存
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

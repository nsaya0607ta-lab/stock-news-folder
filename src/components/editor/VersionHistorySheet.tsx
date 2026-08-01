'use client';

/**
 * PDF 編集のバージョン履歴。
 * 編集日時・編集内容・編集前後のページ数・容量を並べ、過去の状態へ戻せる。
 */
import { useCallback, useEffect, useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import { toMessage } from '@/lib/errors';
import { formatBytes, formatDateTime } from '@/lib/format';
import { listVersions, readVersionBlob, type PdfVersion } from '@/lib/pdfVersions';
import { restoreVersion } from '@/lib/pdfEditSave';
import type { PdfFileMeta } from '@/lib/types';
import { useApp } from '@/store/AppStore';
import { Button, EmptyState, Spinner } from '@/components/ui/Primitives';
import { BottomSheet } from '@/components/ui/Sheet';

export function VersionHistorySheet({
  open,
  file,
  onClose,
  onRestored,
  resolveBlob,
}: {
  open: boolean;
  file: PdfFileMeta | null;
  onClose: () => void;
  onRestored: (file: PdfFileMeta) => void;
  /** 現在の PDF 本体 (復元前の状態も履歴へ残すために必要)。 */
  resolveBlob: (file: PdfFileMeta) => Promise<Blob>;
}) {
  const { settings, notify } = useApp();
  const [versions, setVersions] = useState<PdfVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    try {
      setVersions(await listVersions(file.id));
    } catch {
      setVersions([]);
    } finally {
      setLoading(false);
    }
  }, [file]);

  useEffect(() => {
    if (!open) return;
    setConfirmId(null);
    void load();
  }, [load, open]);

  const restore = async (version: PdfVersion) => {
    if (!file || busy) return;
    setBusy(true);
    try {
      const versionBlob = await readVersionBlob(version.id);
      if (!versionBlob) throw new Error('このバージョンのPDFが見つかりませんでした。');
      const currentBlob = await resolveBlob(file);
      const updated = await restoreVersion({
        file,
        versionBlob,
        currentBlob,
        keepCount: settings.versionKeepCount,
        keepDays: settings.versionKeepDays,
      });
      onRestored(updated);
      await load();
      notify('以前のバージョンへ戻しました。', 'success');
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(false);
      setConfirmId(null);
    }
  };

  if (!file) return null;

  return (
    <BottomSheet open={open} title="編集の履歴" description={file.name} onClose={onClose}>
      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Spinner />
        </div>
      ) : versions.length === 0 ? (
        <EmptyState
          icon={<History size={44} strokeWidth={1.2} />}
          title="編集の履歴はありません"
          description={
            settings.versionKeepCount > 0
              ? 'PDFを上書き保存すると、編集前のPDFがここに残ります。'
              : '設定で履歴の保持数が0になっています。設定画面から変更できます。'
          }
        />
      ) : (
        <ul className="divide-y divider">
          {versions.map((version) => (
            <li key={version.id} className="px-4 py-3">
              <p className="text-sm font-medium text-ink dark:text-[#e6eaef]">
                {formatDateTime(version.createdAt)}
              </p>
              <p className="mt-1 break-words text-sm text-ink dark:text-[#e6eaef]">
                {version.summary}
              </p>
              <p className="mt-1 text-xs text-ink-sub dark:text-[#98a3b0]">
                ページ数 {version.pageCountBefore ?? '不明'} → {version.pageCountAfter ?? '不明'}
                {' ・ '}
                容量 {formatBytes(version.size)} → {formatBytes(version.sizeAfter)}
              </p>

              {confirmId === version.id ? (
                <div className="mt-2 rounded-card border border-line p-3 dark:border-[#333d49]">
                  <p className="text-sm text-ink dark:text-[#e6eaef]">
                    このバージョンへ戻しますか？現在のPDFも履歴に残るので、あとから戻し直せます。
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      variant="secondary"
                      className="flex-1"
                      onClick={() => setConfirmId(null)}
                      disabled={busy}
                    >
                      キャンセル
                    </Button>
                    <Button
                      variant="primary"
                      className="flex-1"
                      onClick={() => void restore(version)}
                      disabled={busy}
                    >
                      {busy ? '処理中…' : '戻す'}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  className="mt-2 min-h-[40px] px-3 text-sm"
                  onClick={() => setConfirmId(version.id)}
                  disabled={busy}
                >
                  <RotateCcw size={16} />
                  このバージョンへ戻す
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </BottomSheet>
  );
}

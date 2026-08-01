'use client';

import { useCallback, useEffect, useRef } from 'react';
import { cloudRef } from '@/lib/firebaseCloud';
import { listReadyGeneratedPdfs, markGeneratedPdfImported } from '@/lib/geminiCloud';
import { getPageCount } from '@/lib/pdf';
import * as repo from '@/lib/repository';
import { ROOT_ID, UNSORTED_ID } from '@/lib/types';
import { useApp } from '@/store/AppStore';
import { useCloudRequired } from '@/store/CloudStore';

const CHECK_INTERVAL_MS = 5 * 60_000;

export function GeminiGeneratedPdfImporter() {
  const { ready, fatalError, folders, reload, refreshStorage, notify } = useApp();
  const { active, user } = useCloudRequired();
  const running = useRef(false);

  const importReady = useCallback(async () => {
    if (!ready || fatalError || !active || !user || running.current) return;
    running.current = true;
    let imported = 0;

    try {
      const generated = await listReadyGeneratedPdfs(user.uid);
      for (const item of generated) {
        try {
          const ref = await cloudRef(item.objectPath);
          const url = await ref.getDownloadURL();
          const response = await fetch(url, { cache: 'no-store' });
          if (!response.ok) continue;
          const blob = await response.blob();
          if (!repo.isPdf(blob, item.fileName)) continue;

          const folderId =
            item.folderId === ROOT_ID || folders.some((folder) => folder.id === item.folderId && !folder.deletedAt)
              ? item.folderId
              : UNSORTED_ID;
          const pageCount = await getPageCount(blob);
          const meta = await repo.addPdf(blob, item.fileName, {
            parentId: folderId,
            onDuplicate:
              item.duplicateMode === 'skip'
                ? 'skip'
                : item.duplicateMode === 'rename'
                  ? 'rename'
                  : 'overwrite',
            pageCount,
            origin: 'report',
            sharedFrom: 'Gemini自動PDF',
            sourceFormats: ['chat', 'markdown'],
          });
          await repo.updateFile(meta.id, {
            tags: [...new Set([...(item.tags ?? []), 'Gemini生成', item.chatDate])],
            memo: `Gemini自動PDF（対象日：${item.chatDate}${item.ruleName ? ` / ルール：${item.ruleName}` : ''}）`,
          });
          await markGeneratedPdfImported(user.uid, item.id, meta.id);
          imported += 1;
        } catch (error) {
          const duplicate = error instanceof Error && error.message.includes('同じ名前');
          if (duplicate && item.duplicateMode === 'skip') {
            await markGeneratedPdfImported(user.uid, item.id, 'skipped');
          } else {
            console.error('Gemini自動PDFの取り込みに失敗:', error);
          }
        }
      }

      if (imported > 0) {
        await reload();
        await refreshStorage();
        notify(`Geminiが作成したPDFを ${imported} 件取り込みました。`, 'success');
      }
    } catch (error) {
      console.error('Gemini自動PDF一覧の確認に失敗:', error);
    } finally {
      running.current = false;
    }
  }, [active, fatalError, folders, notify, ready, refreshStorage, reload, user]);

  useEffect(() => {
    void importReady();
    const timer = window.setInterval(() => void importReady(), CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void importReady();
    };
    const onOnline = () => void importReady();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [importReady]);

  return null;
}

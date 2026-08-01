'use client';

/**
 * 公開フォルダー（/ionq）にある既存のIONQレポートを取り込む。
 *
 * IONQの日次レポートは、共通の銘柄ニュース処理（scripts/stock-news）へ移行した。
 * ここでは移行前に公開されたPDFを取りこぼさないために残しており、
 * 取り込み先は他の銘柄と同じ「IONQ」フォルダーにそろえている。
 */
import { useEffect, useRef } from 'react';
import { getPageCount } from '@/lib/pdf';
import * as repo from '@/lib/repository';
import { activeFiles, toParentKey } from '@/lib/tree';
import { nowIso } from '@/lib/naming';
import { ensureTickerFolder } from '@/lib/stock/folders';
import { reportId as makeReportId } from '@/lib/stock/core/report.mjs';
import { listReports, saveReport } from '@/lib/stock/store';
import type { StockReportEntry } from '@/lib/stock/types';
import { useApp } from '@/store/AppStore';
import { useStock } from '@/store/StockStore';

const INDEX_URL = '/ionq/index.json';
const MAX_PER_RUN = 5;
const IONQ_REPORT_NAME = /^投資_IQ_(\d{4})(\d{2})(\d{2})\.pdf$/;

type IonqReportEntry = {
  id: string;
  file: string;
  name?: string;
  size?: number;
  generatedAt?: string;
};

function expectedReportName(id: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})-ionq$/.exec(id);
  if (!match) return null;
  return `投資_IQ_${match[1]}${match[2]}${match[3]}.pdf`;
}

function isEntry(value: unknown): value is IonqReportEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<IonqReportEntry>;
  const expectedName = expectedReportName(entry.id ?? '');
  if (!expectedName) return false;
  if (entry.file !== expectedName) return false;
  if (entry.name !== undefined && entry.name !== expectedName) return false;
  if (entry.size !== undefined && (!Number.isFinite(entry.size) || Number(entry.size) <= 0)) return false;
  if (entry.generatedAt !== undefined && typeof entry.generatedAt !== 'string') return false;
  return true;
}

/** 同じ日付IDでも再生成されたPDFを区別するため、公開ファイルの版を含める。 */
function reportKey(entry: IonqReportEntry): string {
  return [entry.id, entry.file, entry.size ?? '', entry.generatedAt ?? ''].join('|');
}

function reportDateOf(entry: IonqReportEntry): string {
  return entry.id.slice(0, 10);
}

/** 内訳データを持たない公開PDFを、レポート一覧に並べられる形にする。 */
function legacyEntry(input: {
  fileId: string;
  fileName: string;
  folderId: string;
  reportDate: string;
  generatedAt?: string;
}): StockReportEntry {
  return {
    reportId: makeReportId('IONQ', input.reportDate),
    ticker: 'IONQ',
    companyName: 'IonQ, Inc.',
    reportDate: input.reportDate,
    periodFrom: input.reportDate,
    periodTo: input.reportDate,
    generatedAt: input.generatedAt ?? nowIso(),
    fileName: input.fileName,
    language: 'ja',
    detail: 'standard',
    articleCount: 0,
    headline: '公開フォルダーから取り込んだIONQレポート',
    summary:
      'このレポートは、共通のニュース処理へ移行する前に公開されたPDFです。ニュースの内訳データは保存されていないため、内容はPDFでご確認ください。',
    priceComment: '',
    importance: 0,
    sentiment: 'neutral',
    articles: [],
    watchItems: [],
    uncertainties: [],
    nextEvent: { date: '', title: '' },
    sources: [],
    quote: null,
    fetchedCount: 0,
    acceptedCount: 0,
    source: 'scheduled',
    status: 'ready',
    version: 1,
    localFileId: input.fileId,
    folderId: input.folderId,
    isRead: false,
    isFavorite: false,
    savedAt: nowIso(),
  };
}

export function IonqReportImporter() {
  const { ready, fatalError, settings, updateSettings, reload, refreshStorage, notify } = useApp();
  const { ready: stockReady, reloadStock } = useStock();
  const started = useRef(false);

  useEffect(() => {
    if (!ready || !stockReady || fatalError || started.current) return;
    started.current = true;
    let cancelled = false;

    void (async () => {
      let entries: IonqReportEntry[] = [];
      try {
        const response = await fetch(INDEX_URL, { cache: 'no-store' });
        if (response.ok) {
          const data: unknown = await response.json();
          const list = Array.isArray(data) ? data : (data as { reports?: unknown })?.reports;
          if (Array.isArray(list)) entries = list.filter(isEntry);
        }
      } catch {
        // 一覧を取得できない場合は、次回起動時に再試行する。
      }
      if (cancelled || entries.length === 0) return;

      const folder = await ensureTickerFolder('IONQ');
      const importedKeys = new Set(settings.importedReports ?? []);
      const knownReports = new Set((await listReports()).map((entry) => entry.reportId));
      const snapshot = await repo.refresh();
      const localNames = new Map(
        activeFiles(snapshot.files).map((file) => [file.name.toLocaleLowerCase('ja-JP'), file]),
      );

      // 旧版でルート直下などに入ったIONQレポートを、銘柄フォルダーへそろえる。
      let relocated = 0;
      for (const file of activeFiles(snapshot.files)) {
        if (!IONQ_REPORT_NAME.test(file.name)) continue;
        if (toParentKey(file.parentId) === folder.id) continue;
        try {
          await repo.moveFile(file.id, folder.id, { clearRule: true });
          relocated += 1;
        } catch {
          // 配置変更に失敗した場合は、次回起動時に再試行する。
        }
      }

      const targets = entries
        .filter((entry) => !importedKeys.has(reportKey(entry)))
        .sort((a, b) => b.id.localeCompare(a.id))
        .slice(0, MAX_PER_RUN);

      const imported: string[] = [];
      let added = 0;

      for (const entry of targets) {
        if (cancelled) return;
        try {
          const reportDate = reportDateOf(entry);
          const existingFile = localNames.get(entry.file.toLocaleLowerCase('ja-JP'));
          let fileId = existingFile?.id;

          if (!existingFile || (entry.size && existingFile.size !== entry.size)) {
            const response = await fetch(`/ionq/${encodeURIComponent(entry.file)}`, { cache: 'no-store' });
            if (!response.ok) continue;
            const blob = await response.blob();
            if (blob.size === 0 || !repo.isPdf(blob, entry.file)) continue;
            const pageCount = await getPageCount(blob).catch(() => undefined);
            const meta = await repo.addPdf(blob, entry.file, {
              parentId: folder.id,
              onDuplicate: 'overwrite',
              pageCount,
              origin: 'report',
              sharedFrom: '株式ニュースフォルダー',
            });
            await repo.updateFile(meta.id, { tags: ['IONQ', '株式レポート'] });
            fileId = meta.id;
            added += 1;
          }

          if (fileId && !knownReports.has(makeReportId('IONQ', reportDate))) {
            await saveReport(
              legacyEntry({
                fileId,
                fileName: entry.file,
                folderId: folder.id,
                reportDate,
                generatedAt: entry.generatedAt,
              }),
            );
            knownReports.add(makeReportId('IONQ', reportDate));
          }
          imported.push(reportKey(entry));
        } catch {
          // 失敗したレポートは取り込み済みにせず、次回起動時に再試行する。
        }
      }

      if (cancelled) return;

      if (imported.length > 0) {
        const nextImported = [...new Set([...(settings.importedReports ?? []), ...imported])].slice(-240);
        await updateSettings({ importedReports: nextImported });
      }
      if (added > 0 || relocated > 0) {
        await reload();
        await reloadStock();
        void refreshStorage();
        const parts: string[] = [];
        if (added > 0) parts.push(`既存のIONQレポートを ${added} 件取り込み`);
        if (relocated > 0) parts.push(`${relocated} 件を「IONQ」フォルダーへ配置`);
        notify(`${parts.join('、')}しました`, 'success');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    fatalError,
    notify,
    ready,
    refreshStorage,
    reload,
    reloadStock,
    settings.importedReports,
    stockReady,
    updateSettings,
  ]);

  return null;
}

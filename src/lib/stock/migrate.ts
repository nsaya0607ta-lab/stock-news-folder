'use client';

/**
 * 既存データの移行。
 *
 * 方針:
 *  - 何も削除しない（移動と登録だけを行う）
 *  - 既存のIONQレポートPDFは「IONQ」フォルダーへ引き継ぐ
 *  - 株式と関係のない既存フォルダー・PDFは「旧PDFアーカイブ」の下へまとめる
 *  - 移行の前後でPDFの件数が一致することを確認する
 *
 * 失敗しても既存データはそのまま残るため、次回起動時に再試行できる。
 */
import * as repo from '../repository';
import { nowIso } from '../naming';
import { ROOT_ID, UNSORTED_ID, type Folder, type PdfFileMeta } from '../types';
import { activeFiles, activeFolders, toParentKey } from '../tree';
import { ARCHIVE_FOLDER_NAME, ensureArchiveFolder, ensureTickerFolder, findRootFolder } from './folders';
import { normalizeTicker } from './core/tickers.mjs';
import { reportId as makeReportId } from './core/report.mjs';
import { listReports, listSubscriptions, saveReport, saveSubscription } from './store';
import { DEFAULT_SUBSCRIPTION, type StockReportEntry } from './types';

/** この番号を上げると、次回起動時に移行処理をやり直す。 */
export const STOCK_MIGRATION_VERSION = 1;

/** 旧IONQレポートのファイル名（公開フォルダーから取り込んだもの）。 */
const LEGACY_IONQ_NAME = /^投資_IQ_(\d{4})(\d{2})(\d{2})\.pdf$/;
/** 新形式のレポート名。 */
const REPORT_NAME = /^([A-Z][A-Z0-9.-]{0,13})_日次レポート_(\d{4})(\d{2})(\d{2})\.pdf$/;

export type MigrationResult = {
  ran: boolean;
  movedReports: number;
  registeredReports: number;
  archivedFolders: number;
  archivedFiles: number;
  createdSubscriptions: string[];
  filesBefore: number;
  filesAfter: number;
  countsMatch: boolean;
  messages: string[];
};

/** ファイル名から「銘柄と対象日」を読み取る。 */
export function reportNameInfo(name: string): { ticker: string; date: string } | null {
  const legacy = LEGACY_IONQ_NAME.exec(name);
  if (legacy) return { ticker: 'IONQ', date: `${legacy[1]}-${legacy[2]}-${legacy[3]}` };
  const current = REPORT_NAME.exec(name);
  if (current) {
    const ticker = normalizeTicker(current[1]);
    if (ticker) return { ticker, date: `${current[2]}-${current[3]}-${current[4]}` };
  }
  return null;
}

/** 内容データを持たない既存PDFを、レポート一覧に並べられる形にする。 */
function legacyEntry(file: PdfFileMeta, ticker: string, date: string, folderId: string): StockReportEntry {
  return {
    reportId: makeReportId(ticker, date),
    ticker,
    companyName: ticker,
    reportDate: date,
    periodFrom: date,
    periodTo: date,
    generatedAt: file.createdAt,
    fileName: file.name,
    language: 'ja',
    detail: 'standard',
    articleCount: 0,
    headline: 'アプリ更新前に作成されたレポート',
    summary:
      'このレポートは、株式ニュースフォルダーへの更新前に作成されたPDFです。ニュースの内訳データは保存されていないため、内容はPDFでご確認ください。',
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
    localFileId: file.id,
    folderId,
    isRead: true,
    isFavorite: file.isFavorite,
    savedAt: nowIso(),
  };
}

function isTickerFolder(folder: Folder, tickers: Set<string>): boolean {
  return tickers.has(folder.name.trim().toUpperCase());
}

/**
 * 移行を実行する。
 * @param currentVersion 設定に保存されている実行済みバージョン
 */
export async function runStockMigration(currentVersion: number): Promise<MigrationResult> {
  const result: MigrationResult = {
    ran: false,
    movedReports: 0,
    registeredReports: 0,
    archivedFolders: 0,
    archivedFiles: 0,
    createdSubscriptions: [],
    filesBefore: 0,
    filesAfter: 0,
    countsMatch: true,
    messages: [],
  };
  if (currentVersion >= STOCK_MIGRATION_VERSION) return result;

  result.ran = true;
  const before = await repo.refresh();
  const beforeFiles = activeFiles(before.files);
  result.filesBefore = beforeFiles.length;

  /* 1. 既存のレポートPDFを銘柄ごとに仕分ける ------------------------- */
  const grouped = new Map<string, { file: PdfFileMeta; date: string }[]>();
  for (const file of beforeFiles) {
    const info = reportNameInfo(file.name);
    if (!info) continue;
    const list = grouped.get(info.ticker) ?? [];
    list.push({ file, date: info.date });
    grouped.set(info.ticker, list);
  }

  const existingReports = new Set((await listReports()).map((entry) => entry.reportId));
  const subscriptions = await listSubscriptions();
  const subscribed = new Set(subscriptions.map((entry) => entry.ticker));

  for (const [ticker, entries] of grouped) {
    try {
      const folder = await ensureTickerFolder(ticker);
      for (const { file, date } of entries) {
        if (toParentKey(file.parentId) !== folder.id) {
          await repo.moveFile(file.id, folder.id, { clearRule: true });
          result.movedReports += 1;
        }
        const id = makeReportId(ticker, date);
        if (!existingReports.has(id)) {
          await saveReport(legacyEntry(file, ticker, date, folder.id));
          existingReports.add(id);
          result.registeredReports += 1;
        }
      }
      if (!subscribed.has(ticker)) {
        // 既存のIONQレポートも、これからは共通の定期処理で更新されるようにする。
        await saveSubscription({
          ...DEFAULT_SUBSCRIPTION,
          ticker,
          companyName: ticker,
          folderId: folder.id,
          folderName: folder.name,
        });
        subscribed.add(ticker);
        result.createdSubscriptions.push(ticker);
      }
    } catch (error) {
      result.messages.push(`${ticker} の移行に失敗しました：${(error as Error).message}`);
    }
  }

  /* 2. 株式と関係のない既存データを「旧PDFアーカイブ」へまとめる ----- */
  const afterReports = await repo.refresh();
  const tickers = new Set(subscribed);
  const rootFolders = activeFolders(afterReports.folders).filter(
    (folder) => toParentKey(folder.parentId) === ROOT_ID,
  );
  const legacyFolders = rootFolders.filter(
    (folder) => !isTickerFolder(folder, tickers) && folder.name !== ARCHIVE_FOLDER_NAME,
  );
  const looseFiles = activeFiles(afterReports.files).filter(
    (file) => toParentKey(file.parentId) === ROOT_ID,
  );

  if (legacyFolders.length > 0 || looseFiles.length > 0) {
    try {
      const archive = await ensureArchiveFolder();
      for (const folder of legacyFolders) {
        try {
          await repo.moveFolder(folder.id, archive.id);
          result.archivedFolders += 1;
        } catch (error) {
          result.messages.push(`「${folder.name}」を移動できませんでした：${(error as Error).message}`);
        }
      }
      for (const file of looseFiles) {
        try {
          await repo.moveFile(file.id, archive.id, { clearRule: true });
          result.archivedFiles += 1;
        } catch (error) {
          result.messages.push(`「${file.name}」を移動できませんでした：${(error as Error).message}`);
        }
      }
    } catch (error) {
      result.messages.push(`旧PDFアーカイブを作成できませんでした：${(error as Error).message}`);
    }
  }

  /* 3. 件数の確認（1件でも減っていれば移行不成立として記録する） ----- */
  const after = await repo.refresh();
  result.filesAfter = activeFiles(after.files).length;
  result.countsMatch = result.filesAfter === result.filesBefore;
  if (!result.countsMatch) {
    result.messages.push(
      `移行前後でPDFの件数が一致しません（移行前 ${result.filesBefore} 件 / 移行後 ${result.filesAfter} 件）。`,
    );
  }
  return result;
}

/** 「未分類」フォルダーが残っているかを確認する（取り込み先の予備として使う）。 */
export function fallbackFolderId(folders: Folder[]): string {
  const unsorted = folders.find((folder) => folder.id === UNSORTED_ID && !folder.deletedAt);
  if (unsorted) return unsorted.id;
  return findRootFolder(folders, ARCHIVE_FOLDER_NAME)?.id ?? ROOT_ID;
}

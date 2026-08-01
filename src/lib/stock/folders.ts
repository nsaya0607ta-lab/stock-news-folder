'use client';

/** 銘柄フォルダーの作成と検索。 */
import * as repo from '../repository';
import { ROOT_ID, type Folder, type PdfFileMeta } from '../types';
import { activeFolders, toParentKey } from '../tree';

export const ARCHIVE_FOLDER_NAME = '旧PDFアーカイブ';

function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase('ja-JP') === b.trim().toLocaleLowerCase('ja-JP');
}

/** ルート直下から、名前が一致するフォルダーを探す。 */
export function findRootFolder(folders: Folder[], name: string): Folder | undefined {
  return activeFolders(folders).find(
    (folder) => toParentKey(folder.parentId) === ROOT_ID && sameName(folder.name, name),
  );
}

/** 銘柄フォルダー（ルート直下・ティッカー名）を用意する。 */
export async function ensureTickerFolder(ticker: string): Promise<Folder> {
  const snapshot = await repo.refresh();
  const existing = findRootFolder(snapshot.folders, ticker);
  if (existing) return existing;
  return repo.createFolder(ROOT_ID, ticker, 'blue');
}

/** 旧PDF用のアーカイブフォルダーを用意する。 */
export async function ensureArchiveFolder(): Promise<Folder> {
  const snapshot = await repo.refresh();
  const existing = findRootFolder(snapshot.folders, ARCHIVE_FOLDER_NAME);
  if (existing) return existing;
  return repo.createFolder(ROOT_ID, ARCHIVE_FOLDER_NAME, 'gray');
}

/** そのフォルダーの直下にあるPDF（ごみ箱を除く）。 */
export function filesInFolder(files: PdfFileMeta[], folderId: string): PdfFileMeta[] {
  return files.filter((file) => !file.deletedAt && toParentKey(file.parentId) === folderId);
}

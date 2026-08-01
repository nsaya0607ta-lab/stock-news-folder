'use client';

/**
 * 銘柄購読設定とレポートのクラウド同期（Firestore / Cloud Storage）。
 *
 * サーバー側の定期処理（GitHub Actions + Firebase Admin）は Firestore の
 * 購読設定だけを見て動く。ブラウザーを閉じていても実行されるのはこのため。
 * 端末内のデータが正で、ログインしている間だけクラウドへ写す。
 */
import { cloudFirestore, cloudRef } from '../firebaseCloud';
import { nowIso } from '../naming';
import type { StockReportEntry, StockRunEntry, StockSubscription } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

function userPath(uid: string, suffix: string): string {
  return `users/${uid}/${suffix}`;
}

function toIso(value: any, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value?.toDate) return value.toDate().toISOString();
  return fallback;
}

/** 定期処理が読む項目だけを送る（端末側の表示用の値は送らない）。 */
export async function pushSubscription(uid: string, subscription: StockSubscription): Promise<void> {
  const db = await cloudFirestore();
  await db
    .collection(userPath(uid, 'stockSubscriptions'))
    .doc(subscription.ticker)
    .set(
      {
        ticker: subscription.ticker,
        companyName: subscription.companyName,
        folderId: subscription.folderId,
        folderName: subscription.folderName,
        frequency: subscription.frequency,
        weekdays: subscription.weekdays,
        time: subscription.time,
        timeZone: subscription.timeZone,
        language: subscription.language,
        detail: subscription.detail,
        maxArticles: subscription.maxArticles,
        emptyDayPolicy: subscription.emptyDayPolicy,
        includeQuote: subscription.includeQuote,
        enabled: subscription.enabled,
        nextRunAt: subscription.nextRunAt ?? null,
        createdAt: subscription.createdAt,
        updatedAt: nowIso(),
      },
      { merge: true },
    );
}

export async function deleteSubscription(uid: string, ticker: string): Promise<void> {
  const db = await cloudFirestore();
  await db.collection(userPath(uid, 'stockSubscriptions')).doc(ticker).delete();
}

/** クラウド側の実行結果（最終実行日時・次回予定）を読み戻す。 */
export async function pullSubscriptionStatus(
  uid: string,
): Promise<Record<string, Partial<StockSubscription>>> {
  const db = await cloudFirestore();
  const snapshot = await db.collection(userPath(uid, 'stockSubscriptions')).get();
  const result: Record<string, Partial<StockSubscription>> = {};
  snapshot.docs.forEach((doc: any) => {
    const data = doc.data() ?? {};
    result[doc.id] = {
      lastRunAt: toIso(data.lastRunAt) || undefined,
      lastRunDate: typeof data.lastRunDate === 'string' ? data.lastRunDate : undefined,
      lastRunStatus: data.lastRunStatus,
      lastError: typeof data.lastError === 'string' ? data.lastError : undefined,
      nextRunAt: toIso(data.nextRunAt) || undefined,
    };
  });
  return result;
}

export type CloudReport = StockReportEntry & { objectPath?: string; size?: number };

/** まだ端末へ取り込んでいないレポートを取得する。 */
export async function listPendingReports(uid: string): Promise<CloudReport[]> {
  const db = await cloudFirestore();
  const snapshot = await db
    .collection(userPath(uid, 'stockReports'))
    .where('importState', '==', 'pending')
    .limit(20)
    .get();
  return snapshot.docs.map((doc: any) => {
    const data = doc.data() ?? {};
    return {
      ...data,
      reportId: doc.id,
      articles: Array.isArray(data.articles) ? data.articles : [],
      isRead: false,
      isFavorite: false,
      savedAt: nowIso(),
    } as CloudReport;
  });
}

/** 端末へ取り込んだことを記録する（保管領域の後片付けの対象になる）。 */
export async function markReportImported(uid: string, reportId: string, localFileId: string): Promise<void> {
  const db = await cloudFirestore();
  const cleanupAt = new Date(Date.now() + 3 * 86400_000);
  await db
    .collection(userPath(uid, 'stockReports'))
    .doc(reportId)
    .set({ importState: 'imported', localFileId, importedAt: nowIso(), cleanupAt }, { merge: true });
}

/** 「今すぐ取得」で作ったレポートをクラウドにも記録する（定期処理の二重生成を防ぐ）。 */
export async function pushManualReport(uid: string, report: StockReportEntry): Promise<void> {
  const db = await cloudFirestore();
  await db
    .collection(userPath(uid, 'stockReports'))
    .doc(report.reportId)
    .set(
      {
        ...stripUndefined(report),
        importState: 'imported',
        source: 'manual',
        importedAt: nowIso(),
        updatedAt: nowIso(),
      },
      { merge: true },
    );
}

export async function pushRun(uid: string, run: StockRunEntry): Promise<void> {
  const db = await cloudFirestore();
  await db
    .collection(userPath(uid, 'stockReportRuns'))
    .doc(run.runId)
    .set(stripUndefined(run), { merge: true });
}

/** サーバー側で記録された実行履歴を読む。 */
export async function listCloudRuns(uid: string, limit = 100): Promise<StockRunEntry[]> {
  const db = await cloudFirestore();
  const snapshot = await db
    .collection(userPath(uid, 'stockReportRuns'))
    .orderBy('startedAt', 'desc')
    .limit(limit)
    .get();
  return snapshot.docs.map((doc: any) => {
    const data = doc.data() ?? {};
    return {
      runId: doc.id,
      ticker: String(data.ticker ?? ''),
      companyName: String(data.companyName ?? data.ticker ?? ''),
      runDate: String(data.runDate ?? ''),
      status: data.status ?? 'success',
      trigger: data.trigger === 'manual' ? 'manual' : 'scheduled',
      startedAt: toIso(data.startedAt, nowIso()),
      finishedAt: toIso(data.finishedAt) || undefined,
      fetchedCount: Number(data.fetchedCount ?? 0),
      acceptedCount: Number(data.acceptedCount ?? 0),
      reportResult: String(data.message ?? data.reportResult ?? ''),
      saveResult: data.objectPath ? 'クラウドへ保存済み' : String(data.saveResult ?? ''),
      error: typeof data.error === 'string' ? data.error : undefined,
    } satisfies StockRunEntry;
  });
}

/** Storage に置かれたPDFを取得する。 */
export async function downloadReportPdf(objectPath: string): Promise<Blob> {
  const ref = await cloudRef(objectPath);
  const url = await ref.getDownloadURL();
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('レポートPDFを取得できませんでした');
  return response.blob();
}

/** Firestore は undefined を受け付けないため、事前に取り除く。 */
function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}

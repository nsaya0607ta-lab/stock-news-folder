'use client';

/**
 * 株式ニュース機能の端末内データ。
 *
 * 既存の設定ストア（IndexedDB）へキー付きレコードとして相乗りさせる。
 * 新しいオブジェクトストアを増やすと DB バージョンが上がり、Service Worker 側の
 * openDb と食い違って古い版が止まるため、既存の仕組みに合わせている。
 */
import { mutateKeyed, readKeyed } from '../db';
import { createId, nowIso } from '../naming';
import { nextRunAt } from './core/schedule.mjs';
import { normalizeTicker, resolveTicker } from './core/tickers.mjs';
import {
  DEFAULT_SUBSCRIPTION,
  type StockNotification,
  type StockReportEntry,
  type StockRunEntry,
  type StockSubscription,
} from './types';

const KEY_SUBSCRIPTIONS = 'stock:subscriptions';
const KEY_REPORTS = 'stock:reports';
const KEY_RUNS = 'stock:runs';
const KEY_NOTIFICATIONS = 'stock:notifications';

/** 履歴と通知は、際限なく増えないよう上限を設ける。 */
const MAX_RUNS = 300;
const MAX_NOTIFICATIONS = 120;

/* ------------------------------------------------------------------ */
/* 銘柄購読設定                                                        */
/* ------------------------------------------------------------------ */

export async function listSubscriptions(): Promise<StockSubscription[]> {
  const rows = (await readKeyed<StockSubscription[]>(KEY_SUBSCRIPTIONS)) ?? [];
  return rows
    .filter((row) => normalizeTicker(row?.ticker))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

/** 保存前に、値が想定の範囲に収まっているかを整える。 */
export function normalizeSubscription(input: Partial<StockSubscription>): StockSubscription | null {
  const resolved = resolveTicker(input.ticker, input.companyName);
  if (!resolved) return null;
  const timestamp = nowIso();
  const weekdays = Array.isArray(input.weekdays)
    ? [...new Set(input.weekdays.map(Number).filter((day) => day >= 0 && day <= 6))].sort()
    : DEFAULT_SUBSCRIPTION.weekdays;

  const subscription: StockSubscription = {
    ...DEFAULT_SUBSCRIPTION,
    ...input,
    ticker: resolved.ticker,
    companyName: resolved.companyName,
    folderId: String(input.folderId ?? ''),
    folderName: String(input.folderName ?? resolved.ticker),
    weekdays: weekdays.length > 0 ? weekdays : [1, 2, 3, 4, 5],
    time: /^\d{1,2}:\d{2}$/.test(String(input.time ?? '')) ? String(input.time) : DEFAULT_SUBSCRIPTION.time,
    maxArticles: Math.min(Math.max(Number(input.maxArticles) || DEFAULT_SUBSCRIPTION.maxArticles, 1), 20),
    createdAt: input.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  subscription.nextRunAt = nextRunAt(subscription) ?? undefined;
  return subscription;
}

/** 追加または更新する（ティッカーが一致すれば上書き）。 */
export async function saveSubscription(input: Partial<StockSubscription>): Promise<StockSubscription> {
  const subscription = normalizeSubscription(input);
  if (!subscription) throw new Error('ティッカーの形式が正しくありません。英数字で入力してください。');
  await mutateKeyed<StockSubscription[]>(KEY_SUBSCRIPTIONS, (current) => {
    const rows = current ?? [];
    const existing = rows.find((row) => row.ticker === subscription.ticker);
    const merged = existing ? { ...existing, ...subscription, createdAt: existing.createdAt } : subscription;
    return [...rows.filter((row) => row.ticker !== subscription.ticker), merged];
  });
  return subscription;
}

/** 一部の項目だけを更新する。 */
export async function patchSubscription(
  ticker: string,
  patch: Partial<StockSubscription>,
): Promise<StockSubscription | undefined> {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return undefined;
  let saved: StockSubscription | undefined;
  await mutateKeyed<StockSubscription[]>(KEY_SUBSCRIPTIONS, (current) => {
    const rows = current ?? [];
    const existing = rows.find((row) => row.ticker === symbol);
    if (!existing) return rows;
    const next = normalizeSubscription({ ...existing, ...patch, ticker: symbol });
    if (!next) return rows;
    saved = next;
    return [...rows.filter((row) => row.ticker !== symbol), next];
  });
  return saved;
}

export async function removeSubscription(ticker: string): Promise<void> {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return;
  await mutateKeyed<StockSubscription[]>(KEY_SUBSCRIPTIONS, (current) =>
    (current ?? []).filter((row) => row.ticker !== symbol),
  );
}

/* ------------------------------------------------------------------ */
/* レポート                                                            */
/* ------------------------------------------------------------------ */

export async function listReports(): Promise<StockReportEntry[]> {
  const rows = (await readKeyed<StockReportEntry[]>(KEY_REPORTS)) ?? [];
  return rows.sort((a, b) => String(b.reportDate).localeCompare(String(a.reportDate)));
}

/**
 * レポートを保存する。
 * 同じ reportId（銘柄＋対象日）なら新規に増やさず更新する（冪等性）。
 * お気に入りはユーザーの操作を必ず引き継ぎ、内容が新しい版に差し替わったときだけ
 * 未読へ戻す。
 */
export async function saveReport(entry: StockReportEntry): Promise<StockReportEntry> {
  let saved = entry;
  await mutateKeyed<StockReportEntry[]>(KEY_REPORTS, (current) => {
    const rows = current ?? [];
    const existing = rows.find((row) => row.reportId === entry.reportId);
    if (existing) {
      const renewed = (entry.version ?? 1) > (existing.version ?? 1);
      saved = {
        ...existing,
        ...entry,
        isFavorite: existing.isFavorite,
        isRead: renewed ? false : existing.isRead,
        localFileId: entry.localFileId ?? existing.localFileId,
        folderId: entry.folderId ?? existing.folderId,
      };
    } else {
      saved = entry;
    }
    return [...rows.filter((row) => row.reportId !== entry.reportId), saved];
  });
  return saved;
}

export async function patchReport(
  reportId: string,
  patch: Partial<StockReportEntry>,
): Promise<StockReportEntry | undefined> {
  let saved: StockReportEntry | undefined;
  await mutateKeyed<StockReportEntry[]>(KEY_REPORTS, (current) => {
    const rows = current ?? [];
    const existing = rows.find((row) => row.reportId === reportId);
    if (!existing) return rows;
    const next = { ...existing, ...patch };
    saved = next;
    return rows.map((row) => (row.reportId === reportId ? next : row));
  });
  return saved;
}

/** 銘柄のレポートをまとめて削除する（購読の削除時に選べる）。 */
export async function removeReportsOfTicker(ticker: string): Promise<StockReportEntry[]> {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return [];
  const removed: StockReportEntry[] = [];
  await mutateKeyed<StockReportEntry[]>(KEY_REPORTS, (current) => {
    const rows = current ?? [];
    for (const row of rows) if (row.ticker === symbol) removed.push(row);
    return rows.filter((row) => row.ticker !== symbol);
  });
  return removed;
}

/** 端末から消えたPDFへの参照を外す（ファイルを消しても一覧が壊れないようにする）。 */
export async function detachMissingFiles(existingFileIds: Set<string>): Promise<number> {
  let changed = 0;
  await mutateKeyed<StockReportEntry[]>(KEY_REPORTS, (current) => {
    const rows = current ?? [];
    return rows.map((row) => {
      if (row.localFileId && !existingFileIds.has(row.localFileId)) {
        changed += 1;
        return { ...row, localFileId: undefined };
      }
      return row;
    });
  });
  return changed;
}

/* ------------------------------------------------------------------ */
/* 実行履歴                                                            */
/* ------------------------------------------------------------------ */

export async function listRuns(): Promise<StockRunEntry[]> {
  const rows = (await readKeyed<StockRunEntry[]>(KEY_RUNS)) ?? [];
  return rows.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export async function saveRun(entry: StockRunEntry): Promise<void> {
  await mutateKeyed<StockRunEntry[]>(KEY_RUNS, (current) => {
    const rows = (current ?? []).filter((row) => row.runId !== entry.runId);
    return [entry, ...rows]
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, MAX_RUNS);
  });
}

/* ------------------------------------------------------------------ */
/* 通知                                                                */
/* ------------------------------------------------------------------ */

export async function listNotifications(): Promise<StockNotification[]> {
  const rows = (await readKeyed<StockNotification[]>(KEY_NOTIFICATIONS)) ?? [];
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function addNotification(
  input: Omit<StockNotification, 'id' | 'createdAt' | 'isRead'> & { id?: string },
): Promise<StockNotification> {
  const notification: StockNotification = {
    id: input.id ?? createId('notice'),
    ticker: input.ticker,
    reportId: input.reportId,
    title: input.title,
    body: input.body,
    createdAt: nowIso(),
    isRead: false,
  };
  await mutateKeyed<StockNotification[]>(KEY_NOTIFICATIONS, (current) => {
    const rows = (current ?? []).filter((row) => row.id !== notification.id);
    return [notification, ...rows].slice(0, MAX_NOTIFICATIONS);
  });
  return notification;
}

export async function markNotificationsRead(ids?: string[]): Promise<void> {
  await mutateKeyed<StockNotification[]>(KEY_NOTIFICATIONS, (current) =>
    (current ?? []).map((row) => (!ids || ids.includes(row.id) ? { ...row, isRead: true } : row)),
  );
}

export async function clearNotifications(): Promise<void> {
  await mutateKeyed<StockNotification[]>(KEY_NOTIFICATIONS, () => []);
}

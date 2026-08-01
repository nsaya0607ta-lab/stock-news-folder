/**
 * 株式ニュース機能のデータ型。
 *
 * 実際のレポート本体の型は、サーバー側の定期処理と共有している
 * `core/` の素のESMモジュールから読み込む（同じ形をそのまま保存する）。
 */
import type { Frequency } from './core/schedule.mjs';
import type { NewsArticle } from './core/news.mjs';
import type { StockReport } from './core/report.mjs';
import type { NewsCategory, Sentiment } from './core/taxonomy.mjs';

export type { Frequency, NewsArticle, NewsCategory, Sentiment, StockReport };

export type ReportLanguage = 'ja' | 'en';
export type ReportDetail = 'brief' | 'standard' | 'detailed';
/** ニュースが無かった日の扱い。 */
export type EmptyDayPolicy = 'skip' | 'report';

/** 銘柄購読設定（1銘柄 = 1レコード）。 */
export type StockSubscription = {
  /** 大文字のティッカー。レコードのIDも兼ねる。 */
  ticker: string;
  companyName: string;
  /** 保存先フォルダー（端末内のフォルダーID）。 */
  folderId: string;
  folderName: string;
  frequency: Frequency;
  /** frequency が weekly のときの曜日（0=日）。 */
  weekdays: number[];
  /** 取得時刻「HH:MM」。 */
  time: string;
  timeZone: string;
  language: ReportLanguage;
  detail: ReportDetail;
  /** 1レポートあたりの最大ニュース件数。 */
  maxArticles: number;
  emptyDayPolicy: EmptyDayPolicy;
  /** 株価データを併記するか。 */
  includeQuote: boolean;
  enabled: boolean;
  lastRunAt?: string;
  lastRunDate?: string;
  lastRunStatus?: 'success' | 'failed' | 'skipped';
  lastError?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
};

/** 端末に保存するレポート。生成結果に閲覧状態を足したもの。 */
export type StockReportEntry = StockReport & {
  /** 端末内のPDFファイルID（PDFがまだ無い場合は未設定）。 */
  localFileId?: string;
  folderId?: string;
  isRead: boolean;
  isFavorite: boolean;
  savedAt: string;
  /** PDFの作成に失敗した場合の理由（内容は保存できている状態）。 */
  saveError?: string;
};

/** 定期処理・手動実行の履歴。 */
export type StockRunEntry = {
  runId: string;
  ticker: string;
  companyName: string;
  runDate: string;
  status: 'running' | 'success' | 'skipped' | 'failed';
  trigger: 'scheduled' | 'manual';
  startedAt: string;
  finishedAt?: string;
  fetchedCount: number;
  acceptedCount: number;
  reportResult: string;
  saveResult: string;
  error?: string;
  nextRunAt?: string;
};

/** アプリ内通知。 */
export type StockNotification = {
  id: string;
  ticker: string;
  reportId?: string;
  title: string;
  body: string;
  createdAt: string;
  isRead: boolean;
};

export const DEFAULT_SUBSCRIPTION: Omit<
  StockSubscription,
  'ticker' | 'companyName' | 'folderId' | 'folderName' | 'createdAt' | 'updatedAt'
> = {
  frequency: 'daily',
  weekdays: [1, 2, 3, 4, 5],
  time: '08:00',
  timeZone: 'Asia/Tokyo',
  language: 'ja',
  detail: 'standard',
  maxArticles: 8,
  emptyDayPolicy: 'skip',
  includeQuote: true,
  enabled: true,
};

export const DETAIL_LABELS: Record<ReportDetail, string> = {
  brief: '簡易（要点のみ）',
  standard: '標準',
  detailed: '詳しい',
};

export const LANGUAGE_LABELS: Record<ReportLanguage, string> = {
  ja: '日本語',
  en: '英語',
};

export const EMPTY_DAY_LABELS: Record<EmptyDayPolicy, string> = {
  skip: 'レポートを作らず履歴に残す',
  report: '「ニュースなし」レポートを作る',
};

export const RUN_STATUS_LABELS: Record<StockRunEntry['status'], string> = {
  running: '実行中',
  success: '成功',
  skipped: 'スキップ',
  failed: '失敗',
};

import type { NewsCategory, Sentiment, ImportanceLevel, SourceTier } from './taxonomy.d.mts';
import type { StockQuote } from './quote.d.mts';

export type NewsArticle = {
  title: string;
  summary: string;
  keyPoints: string[];
  priceImpact: string;
  publishedAt: string;
  fetchedAt: string;
  sourceName: string;
  sourceHost: string;
  url: string;
  ticker: string;
  category: NewsCategory;
  importance: ImportanceLevel;
  sentiment: Sentiment;
  sourceTier: SourceTier;
  dedupeHash: string;
  duplicateSources?: string[];
};

export type NewsReportData = {
  headline: string;
  summary: string;
  priceComment: string;
  articles: NewsArticle[];
  watchItems: string[];
  uncertainties: string[];
  nextEvent: { date: string; title: string };
  sources: { title: string; url: string }[];
  fetchedCount: number;
  acceptedCount: number;
  fetchedAt: string;
};

export type CollectNewsInput = {
  ticker: string;
  companyName: string;
  periodFrom: string;
  periodTo: string;
  language?: string;
  detail?: string;
  maxArticles?: number;
  aliases?: string[];
};

export function geminiModel(): string;
export function collectNewsReport(
  input: CollectNewsInput,
  options?: { apiKey?: string; quote?: StockQuote | null; signal?: AbortSignal },
): Promise<NewsReportData>;
export function sanitizeArticles(
  rawArticles: unknown,
  target: { ticker: string; companyName: string; maxArticles: number; aliases?: string[] },
  sources: { title: string; url: string }[],
  fetchedAt: string,
): NewsArticle[];

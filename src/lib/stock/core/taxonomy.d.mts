export type NewsCategory =
  | 'earnings'
  | 'guidance'
  | 'product'
  | 'partnership'
  | 'ma'
  | 'financing'
  | 'regulatory'
  | 'management'
  | 'analyst'
  | 'ownership'
  | 'market'
  | 'other';

export type Sentiment = 'positive' | 'neutral' | 'negative';
export type ImportanceLevel = 1 | 2 | 3;
export type SourceTier = 1 | 2 | 3 | 4 | 5;

export const NEWS_CATEGORIES: NewsCategory[];
export const CATEGORY_LABELS: Record<NewsCategory, string>;
export const CATEGORY_SHORT: Record<NewsCategory, string>;
export function categoryLabel(value: unknown): string;
export function normalizeCategory(value: unknown): NewsCategory;

export const IMPORTANCE_LEVELS: ImportanceLevel[];
export const IMPORTANCE_LABELS: Record<ImportanceLevel, string>;
export const IMPORTANCE_MARKS: Record<ImportanceLevel, string>;
export function normalizeImportance(value: unknown): ImportanceLevel;

export const SENTIMENTS: Sentiment[];
export const SENTIMENT_LABELS: Record<Sentiment, string>;
export const SENTIMENT_MARKS: Record<Sentiment, string>;
export function normalizeSentiment(value: unknown): Sentiment;

export const SOURCE_TIER_LABELS: Record<SourceTier, string>;
export function sourceTier(url: unknown, officialDomains?: string[]): SourceTier;
export function hostOf(url: unknown): string;

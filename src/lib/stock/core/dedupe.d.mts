export function canonicalUrl(url: unknown): string;
export function isSafeUrl(url: unknown): boolean;
export function normalizeTitle(title: unknown): string;
export function hash32(value: unknown): string;
export function dedupeHash(article: { url?: unknown; title?: unknown }): string;
export function dedupeArticles<T extends { url?: unknown; title?: unknown; sourceTier?: number }>(
  articles: T[],
): (T & { url: string; dedupeHash: string; duplicateSources?: string[] })[];
export function companyTokens(companyName: unknown): string[];
export function isRelevantArticle(
  article: { title?: unknown; summary?: unknown; url?: unknown },
  ticker: unknown,
  companyName: unknown,
  extraNames?: string[],
): boolean;

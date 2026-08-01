export type CatalogEntry = {
  ticker: string;
  companyName: string;
  companyNameJa: string;
  exchange: string;
  sector: string;
  aliases: string[];
};

export type ResolvedTicker = {
  ticker: string;
  companyName: string;
  companyNameJa: string;
  exchange: string;
  sector: string;
};

export const TICKER_CATALOG: CatalogEntry[];
export function normalizeTicker(value: unknown): string | null;
export function findTicker(ticker: unknown): CatalogEntry | undefined;
export function resolveTicker(ticker: unknown, companyName?: unknown): ResolvedTicker | null;
export function searchTickers(query: string, limit?: number): CatalogEntry[];

export type StockQuote = {
  symbol: string;
  companyName: string;
  provider: string;
  currency: string;
  marketDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  previousClose: number;
  change: number;
  changePercent: number;
  averageVolume20: number;
  volumeVsAveragePercent: number;
  dayRange: number;
  closePositionPercent: number;
  fetchedAt: string;
};

export function fetchQuote(
  symbol: string,
  options?: { companyName?: string; apiKey?: string },
): Promise<StockQuote | null>;

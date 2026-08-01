/**
 * 株価データの取得（Alpha Vantage）。
 * 既存のIONQレポートで使っている取得方法をそのまま共通化したもの。
 *
 * APIキーはサーバー側の環境変数だけで扱う。取得できなかった場合は
 * 例外にせず null を返し、ニュースだけのレポートを作れるようにする。
 */

const API_URL = 'https://www.alphavantage.co/query';
const TIMEOUT_MS = 30000;

function numberField(row, key) {
  const value = Number(row?.[key]);
  return Number.isFinite(value) ? value : null;
}

function parseDay(date, row) {
  const open = numberField(row, '1. open');
  const high = numberField(row, '2. high');
  const low = numberField(row, '3. low');
  const close = numberField(row, '4. close');
  const volume = numberField(row, '5. volume');
  if (open === null || high === null || low === null || close === null || volume === null) return null;
  return { date, open, high, low, close, volume };
}

function average(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

/**
 * 直近の日足を取得する。
 * @param {string} symbol ティッカー
 * @param {{companyName?: string, apiKey?: string}} options
 * @returns {Promise<object|null>} 取得できなければ null
 */
export async function fetchQuote(symbol, options = {}) {
  const apiKey = options.apiKey || process.env.ALPHA_VANTAGE_API_KEY || process.env.STOCK_API_KEY;
  if (!apiKey || !symbol) return null;

  const url = new URL(API_URL);
  url.searchParams.set('function', 'TIME_SERIES_DAILY');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('outputsize', 'compact');
  url.searchParams.set('apikey', apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return null;

  let data;
  try {
    data = await response.json();
  } catch {
    return null;
  }
  // 利用上限に達した場合も Note / Information で返るため、静かに諦める。
  if (data?.['Error Message'] || data?.Note || data?.Information) return null;

  const series = data?.['Time Series (Daily)'];
  if (!series || typeof series !== 'object') return null;

  const dates = Object.keys(series).sort((a, b) => b.localeCompare(a));
  const allDays = dates.map((date) => parseDay(date, series[date])).filter(Boolean);
  if (allDays.length < 2) return null;

  const latest = allDays[0];
  const previous = allDays[1];
  const change = latest.close - previous.close;
  const changePercent = previous.close === 0 ? 0 : (change / previous.close) * 100;
  const averageVolume20 = average(allDays.slice(1, 21).map((day) => day.volume));
  const volumeVsAveragePercent = averageVolume20 === 0 ? 0 : (latest.volume / averageVolume20 - 1) * 100;
  const dayRange = latest.high - latest.low;
  const closePositionPercent = dayRange === 0 ? 50 : ((latest.close - latest.low) / dayRange) * 100;

  return {
    symbol,
    companyName: options.companyName || symbol,
    provider: 'Alpha Vantage',
    currency: 'USD',
    marketDate: latest.date,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    close: latest.close,
    volume: latest.volume,
    previousClose: previous.close,
    change,
    changePercent,
    averageVolume20,
    volumeVsAveragePercent,
    dayRange,
    closePositionPercent,
    fetchedAt: new Date().toISOString(),
  };
}

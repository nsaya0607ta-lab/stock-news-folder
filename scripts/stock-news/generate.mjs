/**
 * 1銘柄分の日次レポートを作る共通処理。
 *
 * 定時実行（scheduler.mjs）と、既存のIONQワークフロー（scripts/ionq-report）の
 * 両方がここを呼ぶ。銘柄固有の分岐は持たない。
 */
import { collectNewsReport } from '../../src/lib/stock/core/news.mjs';
import { fetchQuote } from '../../src/lib/stock/core/quote.mjs';
import { buildReport } from '../../src/lib/stock/core/report.mjs';
import { renderReportHtml } from '../../src/lib/stock/core/render.mjs';
import { resolveTicker } from '../../src/lib/stock/core/tickers.mjs';
import { addDays, zonedParts } from '../../src/lib/stock/core/schedule.mjs';
import { htmlToPdf } from './pdf.mjs';

/**
 * @param {{ticker: string, companyName?: string, reportDate?: string,
 *          periodFrom?: string, periodTo?: string, language?: string,
 *          detail?: string, maxArticles?: number, withQuote?: boolean,
 *          source?: 'scheduled'|'manual', version?: number}} input
 * @returns {Promise<{report: object, html: string, pdf: Buffer}>}
 */
export async function generateStockReport(input) {
  const resolved = resolveTicker(input.ticker, input.companyName);
  if (!resolved) throw new Error(`ティッカーの形式が正しくありません: ${input.ticker}`);

  const reportDate = input.reportDate || zonedParts().date;
  const periodTo = input.periodTo || reportDate;
  const periodFrom = input.periodFrom || addDays(reportDate, -1);

  // 株価は補助情報。取得できなくてもニュースレポートは作る。
  const quote = input.withQuote === false ? null : await fetchQuote(resolved.ticker, { companyName: resolved.companyName });

  const news = await collectNewsReport(
    {
      ticker: resolved.ticker,
      companyName: resolved.companyName,
      aliases: [resolved.companyNameJa].filter(Boolean),
      periodFrom,
      periodTo,
      language: input.language,
      detail: input.detail,
      maxArticles: input.maxArticles,
    },
    { quote },
  );

  const report = buildReport({
    ticker: resolved.ticker,
    companyName: resolved.companyName,
    reportDate,
    periodFrom,
    periodTo,
    language: input.language,
    detail: input.detail,
    news,
    quote,
    source: input.source,
    version: input.version,
  });

  const html = renderReportHtml(report);
  const pdf = await htmlToPdf(html);
  return { report, html, pdf };
}

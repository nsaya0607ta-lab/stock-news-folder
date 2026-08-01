import { authErrorResponse, verifyFirebaseRequest } from '@/lib/server/firebaseAuth';
import { enforceGeminiRateLimit } from '@/lib/server/geminiApi';
import { collectNewsReport } from '@/lib/stock/core/news.mjs';
import { fetchQuote } from '@/lib/stock/core/quote.mjs';
import { buildReport } from '@/lib/stock/core/report.mjs';
import { addDays, zonedParts } from '@/lib/stock/core/schedule.mjs';
import { resolveTicker } from '@/lib/stock/core/tickers.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Body = {
  ticker?: string;
  companyName?: string;
  reportDate?: string;
  periodFrom?: string;
  periodTo?: string;
  language?: string;
  detail?: string;
  maxArticles?: number;
  includeQuote?: boolean;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function safeDate(value: unknown, fallback: string): string {
  return typeof value === 'string' && DATE_PATTERN.test(value) ? value : fallback;
}

/**
 * 「今すぐ取得」用のニュース取得。
 *
 * APIキー（Gemini / Alpha Vantage）はこのサーバー処理の中だけで使い、
 * ブラウザーへは一切返さない。応答に含めるのは整形済みのレポート内容だけ。
 */
export async function POST(request: Request) {
  try {
    const user = await verifyFirebaseRequest(request);
    // 短時間の連打で外部APIを叩き続けないようにする。
    enforceGeminiRateLimit(`stock:${user.uid}`, 6, 60_000);

    const body = (await request.json()) as Body;
    const resolved = resolveTicker(body.ticker, body.companyName);
    if (!resolved) {
      return Response.json(
        { error: 'ティッカーの形式が正しくありません。英数字で入力してください。' },
        { status: 400 },
      );
    }

    const today = zonedParts().date;
    const reportDate = safeDate(body.reportDate, today);
    const periodTo = safeDate(body.periodTo, reportDate);
    const periodFrom = safeDate(body.periodFrom, addDays(reportDate, -1));

    const quote =
      body.includeQuote === false
        ? null
        : await fetchQuote(resolved.ticker, { companyName: resolved.companyName });

    const news = await collectNewsReport(
      {
        ticker: resolved.ticker,
        companyName: resolved.companyName,
        aliases: [resolved.companyNameJa].filter(Boolean),
        periodFrom,
        periodTo,
        language: body.language,
        detail: body.detail,
        maxArticles: body.maxArticles,
      },
      { quote, signal: request.signal },
    );

    const report = buildReport({
      ticker: resolved.ticker,
      companyName: resolved.companyName,
      reportDate,
      periodFrom,
      periodTo,
      language: body.language,
      detail: body.detail,
      news,
      quote,
      source: 'manual',
    });

    return Response.json({ report }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const auth = authErrorResponse(error);
    if (auth) return auth;

    const message = error instanceof Error ? error.message : '';
    if (message === 'RATE_LIMITED') {
      return Response.json(
        { error: '短時間の実行回数が多いため、1分ほど待ってからお試しください。' },
        { status: 429 },
      );
    }
    if (message.includes('GEMINI_API_KEY')) {
      return Response.json(
        { error: 'ニュース取得用のAPIキーがサーバーに設定されていません。' },
        { status: 503 },
      );
    }
    // 例外メッセージにキーが混ざらないよう、ログにも整形した文字列だけを残す。
    console.error('stock report failed:', message.replace(/key=[^&\s]+/gi, 'key=***').slice(0, 300));
    return Response.json(
      { error: 'ニュースを取得できませんでした。時間をおいて、もう一度お試しください。' },
      { status: 502 },
    );
  }
}

/**
 * レポートレコードの組み立て。
 * 定時実行（Node）と「今すぐ取得」（ブラウザー）の両方で同じ形を作る。
 */
import { compactDate } from './schedule.mjs';

/** レポートIDは「銘柄＋対象日」。同じ日・同じ銘柄なら必ず同じIDになる（冪等性の要）。 */
export function reportId(ticker, reportDate) {
  return `${String(ticker).toUpperCase()}_${compactDate(reportDate)}`;
}

/** ファイル名：銘柄_日次レポート_YYYYMMDD.pdf */
export function reportFileName(ticker, reportDate) {
  return `${String(ticker).toUpperCase()}_日次レポート_${compactDate(reportDate)}.pdf`;
}

/** 記事全体から、レポートの重要度（最大値）を求める。 */
export function aggregateImportance(articles) {
  return articles.reduce((max, article) => Math.max(max, Number(article.importance) || 1), 0) || 0;
}

/** 記事全体の傾向。重要度で重み付けし、差が小さければニュートラルとする。 */
export function aggregateSentiment(articles) {
  let score = 0;
  for (const article of articles) {
    const weight = Number(article.importance) || 1;
    if (article.sentiment === 'positive') score += weight;
    else if (article.sentiment === 'negative') score -= weight;
  }
  if (score >= 2) return 'positive';
  if (score <= -2) return 'negative';
  return 'neutral';
}

/**
 * レポートレコードを作る。
 * @param {object} input ニュース取得結果と購読設定
 */
export function buildReport(input) {
  const ticker = String(input.ticker).toUpperCase();
  const articles = Array.isArray(input.news.articles) ? input.news.articles : [];
  const reportDate = input.reportDate;

  return {
    reportId: reportId(ticker, reportDate),
    ticker,
    companyName: input.companyName,
    reportDate,
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    generatedAt: new Date().toISOString(),
    fileName: reportFileName(ticker, reportDate),
    language: input.language === 'en' ? 'en' : 'ja',
    detail: input.detail || 'standard',
    articleCount: articles.length,
    headline: input.news.headline,
    summary: input.news.summary,
    priceComment: input.news.priceComment || '',
    importance: aggregateImportance(articles),
    sentiment: aggregateSentiment(articles),
    articles,
    watchItems: input.news.watchItems ?? [],
    uncertainties: input.news.uncertainties ?? [],
    nextEvent: input.news.nextEvent ?? { date: '', title: '' },
    sources: input.news.sources ?? [],
    quote: input.quote ?? null,
    fetchedCount: input.news.fetchedCount ?? articles.length,
    acceptedCount: input.news.acceptedCount ?? articles.length,
    source: input.source === 'manual' ? 'manual' : 'scheduled',
    status: articles.length === 0 ? 'empty' : 'ready',
    version: Math.max(1, Number(input.version) || 1),
  };
}

/** 通知文（「NVDAの2026年8月2日分レポートを作成しました。重要ニュース3件」）。 */
export function reportNotificationText(report) {
  const [year, month, day] = String(report.reportDate).split('-');
  const date = `${Number(year)}年${Number(month)}月${Number(day)}日`;
  if (report.articleCount === 0) {
    return `${report.ticker}の${date}分は、重要な新規ニュースがありませんでした`;
  }
  const important = report.articles.filter((article) => Number(article.importance) >= 2).length;
  return `${report.ticker}の${date}分レポートを作成しました。重要ニュース${important || report.articleCount}件`;
}

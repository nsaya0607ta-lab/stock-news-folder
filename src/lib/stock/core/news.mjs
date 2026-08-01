/**
 * ニュース取得とレポート構造化（Gemini の Google 検索グラウンディング）。
 *
 * 既存のIONQレポートで使っていた取得方法（Gemini + google_search ツール →
 * 構造化 JSON）をそのまま踏襲し、銘柄を引数で受け取れるようにしたもの。
 * APIキーはサーバー側の環境変数だけで扱う。
 */
import { dedupeArticles, isRelevantArticle, canonicalUrl } from './dedupe.mjs';
import {
  normalizeCategory,
  normalizeImportance,
  normalizeSentiment,
  sourceTier,
  hostOf,
} from './taxonomy.mjs';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 120000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function geminiModel() {
  return (process.env.GEMINI_MODEL || 'gemini-2.5-flash').replace(/^models\//, '');
}

const REPORT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING' },
    summary: { type: 'STRING' },
    priceComment: { type: 'STRING' },
    articles: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          summary: { type: 'STRING' },
          keyPoints: { type: 'ARRAY', items: { type: 'STRING' } },
          priceImpact: { type: 'STRING' },
          publishedAt: { type: 'STRING' },
          sourceName: { type: 'STRING' },
          url: { type: 'STRING' },
          category: { type: 'STRING' },
          importance: { type: 'INTEGER' },
          sentiment: { type: 'STRING', enum: ['positive', 'neutral', 'negative'] },
        },
        required: ['title', 'summary', 'publishedAt', 'sourceName', 'url', 'category', 'importance', 'sentiment'],
      },
    },
    watchItems: { type: 'ARRAY', items: { type: 'STRING' } },
    uncertainties: { type: 'ARRAY', items: { type: 'STRING' } },
    nextEvent: {
      type: 'OBJECT',
      properties: {
        date: { type: 'STRING' },
        title: { type: 'STRING' },
      },
      required: ['date', 'title'],
    },
  },
  required: ['headline', 'summary', 'articles', 'watchItems', 'uncertainties'],
};

async function callGemini(apiKey, payload, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(`${API_BASE}/${geminiModel()}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 一時的な失敗（429・5xx）だけ再試行する。 */
async function requestWithRetry(apiKey, payload, label, signal) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await callGemini(apiKey, payload, signal);
      if (response.ok) return await response.json();
      const text = await response.text().catch(() => '');
      // APIキーは絶対にログへ出さない。ステータスと本文の先頭だけ残す。
      const error = new Error(`${label}: Gemini API error ${response.status}: ${text.slice(0, 300)}`);
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      lastError = error;
      const message = String(error?.message || '');
      if (/Gemini API error 4/.test(message) && !message.includes('429')) throw error;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
  }
  throw lastError || new Error(`${label}: Gemini APIの呼び出しに失敗しました`);
}

function responseText(data) {
  return data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim() || '';
}

function groundingSources(data) {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const seen = new Set();
  const sources = [];
  for (const chunk of chunks) {
    const url = canonicalUrl(chunk?.web?.uri);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: String(chunk.web.title || '情報源'), url });
  }
  return sources;
}

function jstDateTime() {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}

function trimText(value, maxLength) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trim()}…`;
}

function normalizeList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const text = trimText(item, maxLength);
    const key = text.replace(/\s+/g, '').toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

/** 1 段目：過去の対象期間に公開されたニュースを検索する。 */
async function searchNews(apiKey, target, signal) {
  const languageRule =
    target.language === 'en'
      ? 'Summarize in English.'
      : '結果は日本語で整理してください（原文が英語でも日本語で要約する）。';
  const prompt = [
    `現在は日本時間で ${jstDateTime()} です。`,
    `米国上場企業 ${target.companyName}（ティッカー: ${target.ticker}）に直接関係するニュースだけを検索してください。`,
    `対象期間は ${target.periodFrom} から ${target.periodTo}（日本時間）に公開・更新されたものです。`,
    '優先順位は次のとおりです。1) 企業公式IR・公式ニュースリリース、2) SECなどの公的開示、3) 信頼性の高い金融メディア、4) 大手一般ニュース、5) その他。',
    'ティッカー文字列がたまたま一致しただけの、別企業・別用語の記事は除外してください。',
    '同じ発表を転載しただけの記事、タイトルだけが異なる実質的に同じ記事は1件に統合してください。',
    '公開日時を確認できない情報は採用しないでください。',
    '株価の数値や値動きの理由を推測で作らず、ニュースの事実確認だけを行ってください。',
    `採用する記事は最大 ${target.maxArticles} 件です。`,
    '各記事について、見出し、公開日時、媒体名、URL、確認できた事実、企業への影響、不確実な点を整理してください。',
    '該当する新しいニュースが無い場合は、件数を水増しせず「対象期間内に重要な新規ニュースは確認できなかった」とだけ記載してください。',
    languageRule,
  ].join('\n');

  const data = await requestWithRetry(
    apiKey,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 6000 },
    },
    `${target.ticker}ニュース検索`,
    signal,
  );

  return { text: responseText(data), sources: groundingSources(data) };
}

function quoteText(quote) {
  if (!quote) return '（株価データは取得していません。株価に関する数値は書かないでください）';
  return JSON.stringify(
    {
      symbol: quote.symbol,
      marketDate: quote.marketDate,
      session: '米国市場の通常取引終了時点',
      afterHoursIncluded: false,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      close: quote.close,
      previousClose: quote.previousClose,
      change: quote.change,
      changePercent: quote.changePercent,
      volume: quote.volume,
      averageVolume20: quote.averageVolume20,
      provider: quote.provider,
    },
    null,
    2,
  );
}

function sourceListText(sources) {
  if (!sources.length) return '（参照URLを取得できませんでした）';
  return sources.map((source, index) => `${index + 1}. ${source.title}\n${source.url}`).join('\n');
}

/** 2 段目：検索結果を、レポート用の構造化データへ整える。 */
async function structureReport(apiKey, target, search, quote, signal) {
  const detailRule =
    target.detail === 'brief'
      ? '各記事の要約は1〜2文、要点は最大2件に抑えてください。'
      : target.detail === 'detailed'
        ? '各記事の要約は3〜4文、要点は最大4件まで記載してください。'
        : '各記事の要約は2〜3文、要点は最大3件までにしてください。';

  const prompt = [
    `以下の検索結果だけを使い、${target.companyName}（${target.ticker}）の日次ニュースレポートを作成してください。`,
    '',
    '【絶対条件】',
    '・検索結果に無い情報を作らない。URLは検索結果に出てきたものだけを使う。',
    '・事実（発表内容）とAIによる分析（影響の見立て）を混ぜない。分析は priceImpact と uncertainties に書く。',
    '・断定できないことは「〜の可能性がある」「継続確認が必要」と書く。',
    '・「買うべき」「売るべき」など投資助言にあたる表現は使わない。',
    '・対象期間内に新規ニュースが無ければ articles を空配列にし、件数を水増ししない。',
    `・articles は重要度の高い順に最大 ${target.maxArticles} 件。`,
    `・${detailRule}`,
    '',
    '【フィールドの役割】',
    '・headline：その日の最重要ニュースを 1 行（40文字以内）で表す見出し。ニュースが無ければ「重要な新規ニュースなし」。',
    '・summary：本日の重要ニュース要約を2〜4文。事実だけを述べる。',
    '・priceComment：株価データがある場合のみ、OHLCと出来高から確認できる範囲の一言。無い場合は空文字。',
    '・articles[].category：earnings / guidance / product / partnership / ma / financing / regulatory / management / analyst / ownership / market / other から1つ。',
    '・articles[].importance：1（低）〜3（高）。株価や事業への影響度で判断する。',
    '・articles[].sentiment：企業にとって positive / neutral / negative のいずれか。',
    '・articles[].priceImpact：株価への影響が考えられるポイント。断定しない。',
    '・watchItems：今後確認すべき項目を最大5件。',
    '・uncertainties：確認できていないこと・限界を最大3件。',
    '・nextEvent：すでに公表されている次の重要イベント（決算など）を1件。無ければ空文字。',
    '',
    '【株価データ（この数値以外は使わない）】',
    quoteText(quote),
    '',
    '【検索結果】',
    search.text || '（検索結果なし）',
    '',
    '【利用可能な情報源URL】',
    sourceListText(search.sources),
  ].join('\n');

  const data = await requestWithRetry(
    apiKey,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8000,
        responseMimeType: 'application/json',
        responseSchema: REPORT_SCHEMA,
      },
    },
    `${target.ticker}レポート構造化`,
    signal,
  );

  const text = responseText(data);
  if (!text) throw new Error('Geminiから構造化レポートを取得できませんでした');
  return JSON.parse(text);
}

/** 公式ドメインの推定（企業名から作る。判定に失敗しても害はない）。 */
function officialDomains(target) {
  const base = String(target.companyName || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(inc|corp|corporation|company|co|ltd|limited|plc|holdings|technologies|group|platforms|the)\b/g, '')
    .replace(/\s+/g, '');
  const domains = [];
  if (base.length >= 3) domains.push(`${base}.com`);
  const symbol = String(target.ticker || '').toLowerCase();
  if (symbol.length >= 3) domains.push(`${symbol}.com`);
  return domains;
}

/** Gemini の出力を、保存してよい形へ整える。 */
export function sanitizeArticles(rawArticles, target, sources, fetchedAt) {
  const known = new Map(sources.map((source) => [canonicalUrl(source.url), source]));
  const domains = officialDomains(target);
  const candidates = [];

  for (const item of Array.isArray(rawArticles) ? rawArticles : []) {
    const url = canonicalUrl(item?.url);
    // 検索結果に無いURLは採用しない（生成された架空のURLを保存しない）。
    if (!url || !known.has(url)) continue;
    const article = {
      title: trimText(item.title || '', 160),
      summary: trimText(item.summary || '', 400),
      keyPoints: normalizeList(item.keyPoints, 4, 120),
      priceImpact: trimText(item.priceImpact || '', 220),
      publishedAt: trimText(item.publishedAt || '', 40),
      fetchedAt,
      sourceName: trimText(known.get(url)?.title || item.sourceName || hostOf(url) || '情報源', 80),
      sourceHost: hostOf(url),
      url,
      ticker: target.ticker,
      category: normalizeCategory(item.category),
      importance: normalizeImportance(item.importance),
      sentiment: normalizeSentiment(item.sentiment),
      sourceTier: sourceTier(url, domains),
    };
    if (!article.title) continue;
    if (!isRelevantArticle(article, target.ticker, target.companyName, target.aliases ?? [])) continue;
    candidates.push(article);
  }

  return dedupeArticles(candidates)
    .sort(
      (a, b) =>
        b.importance - a.importance ||
        a.sourceTier - b.sourceTier ||
        String(b.publishedAt).localeCompare(String(a.publishedAt)),
    )
    .slice(0, target.maxArticles);
}

/**
 * ニュースを取得してレポート用データを組み立てる。
 *
 * @param {{ticker: string, companyName: string, periodFrom: string, periodTo: string,
 *          language?: string, detail?: string, maxArticles?: number, aliases?: string[]}} input
 * @param {{apiKey?: string, quote?: object|null, signal?: AbortSignal}} options
 */
export async function collectNewsReport(input, options = {}) {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY が設定されていません');

  const target = {
    ticker: input.ticker,
    companyName: input.companyName,
    aliases: input.aliases ?? [],
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    language: input.language === 'en' ? 'en' : 'ja',
    detail: ['brief', 'standard', 'detailed'].includes(input.detail) ? input.detail : 'standard',
    maxArticles: Math.min(Math.max(Number(input.maxArticles) || 8, 1), 20),
  };

  const search = await searchNews(apiKey, target, options.signal);
  const structured = await structureReport(apiKey, target, search, options.quote ?? null, options.signal);
  const fetchedAt = new Date().toISOString();
  const articles = sanitizeArticles(structured.articles, target, search.sources, fetchedAt);

  return {
    headline: articles.length
      ? trimText(structured.headline || articles[0].title, 60)
      : '対象期間内に重要な新規ニュースはありませんでした',
    summary: articles.length
      ? trimText(structured.summary || '', 600)
      : '対象期間内に、この銘柄に直接関係する重要な新規ニュースは確認できませんでした。',
    priceComment: options.quote ? trimText(structured.priceComment || '', 300) : '',
    articles,
    watchItems: normalizeList(structured.watchItems, 5, 120),
    uncertainties: normalizeList(structured.uncertainties, 3, 160),
    nextEvent: {
      date: trimText(structured.nextEvent?.date, 40),
      title: trimText(structured.nextEvent?.title, 120),
    },
    sources: search.sources.slice(0, 12),
    fetchedCount: Array.isArray(structured.articles) ? structured.articles.length : 0,
    acceptedCount: articles.length,
    fetchedAt,
  };
}

/**
 * 記事の重複排除と、銘柄との関連性チェック。
 *
 * ティッカー文字列がたまたま一致しただけの記事を採用しないよう、
 * 「企業名が出てくる」か「ティッカーが銘柄表記として出てくる」場合だけ採用する。
 */
import { hostOf } from './taxonomy.mjs';

/** 計測用パラメーターなど、内容に影響しないクエリを落とす。 */
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_|ref|ref_src|cmpid|smid|partner|guccounter)/i;

/** URL を比較可能な形へそろえる。 */
export function canonicalUrl(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.protocol = 'https:';
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    parsed.hash = '';
    const keep = [];
    for (const [key, value] of parsed.searchParams.entries()) {
      if (!TRACKING_PARAMS.test(key)) keep.push([key, value]);
    }
    parsed.search = '';
    for (const [key, value] of keep.sort((a, b) => a[0].localeCompare(b[0]))) {
      parsed.searchParams.append(key, value);
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString();
  } catch {
    return '';
  }
}

/** 保存してよい URL か（javascript: などを弾く）。 */
export function isSafeUrl(url) {
  return canonicalUrl(url) !== '';
}

/** 見出しの表記ゆれを吸収する。 */
export function normalizeTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[　\s]+/g, ' ')
    .replace(/[「」『』"'“”‘’()（）\[\]【】|｜:：;；,，.。!！?？\-–—…]/g, '')
    .trim();
}

/** 依存の無い 32bit ハッシュ（FNV-1a）。重複判定キーの生成に使う。 */
export function hash32(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 重複判定用の識別情報。
 * 同じ URL、または「同じ見出し」の転載記事を 1 件にまとめるために使う。
 */
export function dedupeHash(article) {
  const url = canonicalUrl(article?.url);
  const title = normalizeTitle(article?.title);
  return hash32(`${url}|${title}`);
}

function titleKey(article) {
  const title = normalizeTitle(article?.title);
  // 見出しの先頭 60 文字だけで比較し、媒体ごとの接尾辞の違いを無視する。
  return hash32(title.slice(0, 60));
}

/**
 * 記事一覧を重複排除する。
 * 同じ内容が複数媒体にある場合は、情報源の信頼度が高いものを残す。
 */
export function dedupeArticles(articles) {
  const byUrl = new Map();
  const byTitle = new Map();
  const result = [];

  for (const article of Array.isArray(articles) ? articles : []) {
    const url = canonicalUrl(article?.url);
    if (!url) continue;
    const key = titleKey(article);
    const existingIndex = byUrl.get(url) ?? byTitle.get(key);

    if (existingIndex === undefined) {
      const index = result.length;
      result.push({ ...article, url, dedupeHash: dedupeHash({ ...article, url }) });
      byUrl.set(url, index);
      byTitle.set(key, index);
      continue;
    }

    // すでにある記事より信頼度が高ければ差し替え、そうでなければ転載元として記録する。
    const current = result[existingIndex];
    const duplicates = [...(current.duplicateSources ?? [])];
    const host = hostOf(url);
    if (host && !duplicates.includes(host)) duplicates.push(host);

    if (Number(article?.sourceTier ?? 5) < Number(current.sourceTier ?? 5)) {
      const previousHost = hostOf(current.url);
      const merged = [...duplicates.filter((entry) => entry !== host)];
      if (previousHost && !merged.includes(previousHost)) merged.push(previousHost);
      result[existingIndex] = {
        ...article,
        url,
        dedupeHash: dedupeHash({ ...article, url }),
        duplicateSources: merged,
      };
      byUrl.set(url, existingIndex);
    } else {
      result[existingIndex] = { ...current, duplicateSources: duplicates };
    }
  }

  return result;
}

/** 企業名から、照合に使う特徴的な語を取り出す。 */
export function companyTokens(companyName) {
  const cleaned = String(companyName ?? '')
    .replace(/[,.]/g, ' ')
    .replace(/\b(inc|corp|corporation|company|co|ltd|limited|plc|holdings|technologies|group|platforms|the)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  const tokens = [cleaned.toLowerCase()];
  for (const part of cleaned.split(' ')) {
    if (part.length >= 3) tokens.push(part.toLowerCase());
  }
  return [...new Set(tokens)];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 語として含まれるか（英字の場合は単語境界で判定する）。 */
function containsName(haystack, name) {
  if (!/^[a-z0-9 .&'-]+$/i.test(name)) return haystack.includes(name);
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(name)}([^a-z0-9]|$)`, 'i').test(haystack);
}

/**
 * その記事が対象銘柄のものかを確かめる。
 *
 * - 企業名（複数語、または5文字以上の特徴的な語）が本文・見出しにある
 * - もしくは「NASDAQ: XXXX」「(XXXX)」「$XXXX」「XXXX株」の形でティッカーがある
 *
 * どちらも無ければ、ティッカーや一般語の偶然の一致とみなして採用しない。
 * （例：「meta」という一般語だけを含む記事は META の材料として採用しない）
 */
export function isRelevantArticle(article, ticker, companyName, extraNames = []) {
  const haystack = `${article?.title ?? ''}\n${article?.summary ?? ''}\n${article?.url ?? ''}`.toLowerCase();
  if (!haystack.trim()) return false;

  const names = [...companyTokens(companyName), ...extraNames.map((name) => String(name).toLowerCase())]
    // 短い一般語（meta / amd など）は単独では根拠にせず、ティッカー表記で確かめる。
    .filter((name) => name.includes(' ') || name.length >= 5);
  if (names.some((name) => containsName(haystack, name))) return true;

  const symbol = String(ticker ?? '').toLowerCase();
  if (!symbol) return false;
  const escaped = escapeRegExp(symbol);
  const patterns = [
    new RegExp(`(nasdaq|nyse|amex|otc)\\s*[::]\\s*${escaped}\\b`, 'i'),
    new RegExp(`[(（]\\s*${escaped}\\s*[)）]`, 'i'),
    new RegExp(`\\$${escaped}\\b`, 'i'),
    new RegExp(`\\b${escaped}\\s*(株|銘柄|の株価)`, 'i'),
    new RegExp(`\\bticker\\s*[::]?\\s*${escaped}\\b`, 'i'),
  ];
  return patterns.some((pattern) => pattern.test(haystack));
}

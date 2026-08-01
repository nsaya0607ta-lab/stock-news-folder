/** ニュースの分類・重要度・感情の共通語彙。サーバーと画面の両方で使う。 */

export const NEWS_CATEGORIES = [
  'earnings',
  'guidance',
  'product',
  'partnership',
  'ma',
  'financing',
  'regulatory',
  'management',
  'analyst',
  'ownership',
  'market',
  'other',
];

export const CATEGORY_LABELS = {
  earnings: '決算',
  guidance: '業績予想',
  product: '製品・技術',
  partnership: '提携・契約',
  ma: '買収・合併',
  financing: '資金調達・増資',
  regulatory: '規制・訴訟',
  management: '経営陣・人事',
  analyst: 'アナリスト評価',
  ownership: '大株主・インサイダー取引',
  market: '市場・業界動向',
  other: 'その他',
};

/** 一覧で使う短い記号（色だけに頼らないための文字表現）。 */
export const CATEGORY_SHORT = {
  earnings: '決',
  guidance: '予',
  product: '製',
  partnership: '提',
  ma: 'M&A',
  financing: '資',
  regulatory: '規',
  management: '人',
  analyst: '評',
  ownership: '株',
  market: '市',
  other: '他',
};

export function categoryLabel(value) {
  return CATEGORY_LABELS[value] ?? CATEGORY_LABELS.other;
}

export function normalizeCategory(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return NEWS_CATEGORIES.includes(text) ? text : 'other';
}

/** 重要度。3 が最も高い。 */
export const IMPORTANCE_LEVELS = [1, 2, 3];

export const IMPORTANCE_LABELS = {
  1: '低',
  2: '中',
  3: '高',
};

/** アイコンと併記する文字表現（色だけで判別させない）。 */
export const IMPORTANCE_MARKS = {
  1: '△',
  2: '○',
  3: '◎',
};

export function normalizeImportance(value) {
  const number = Math.round(Number(value));
  if (number >= 3) return 3;
  if (number <= 1) return 1;
  return Number.isFinite(number) ? 2 : 2;
}

export const SENTIMENTS = ['positive', 'neutral', 'negative'];

export const SENTIMENT_LABELS = {
  positive: 'ポジティブ',
  neutral: 'ニュートラル',
  negative: 'ネガティブ',
};

/** 記号でも判別できるようにする（赤緑の色覚差に配慮）。 */
export const SENTIMENT_MARKS = {
  positive: '＋',
  neutral: '＝',
  negative: '−',
};

export function normalizeSentiment(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return SENTIMENTS.includes(text) ? text : 'neutral';
}

/**
 * 情報源の信頼度。数字が小さいほど優先する。
 * 1 企業公式IR / 2 公的開示 / 3 主要金融メディア / 4 大手一般ニュース / 5 その他
 */
export const SOURCE_TIER_LABELS = {
  1: '企業公式・IR',
  2: '公的開示（SEC等）',
  3: '金融メディア',
  4: '一般ニュース',
  5: 'その他',
};

const GOVERNMENT_HOSTS = ['sec.gov', 'federalreserve.gov', 'ftc.gov', 'justice.gov', 'nasa.gov', 'defense.gov'];
const FINANCE_HOSTS = [
  'reuters.com', 'bloomberg.com', 'wsj.com', 'ft.com', 'cnbc.com', 'barrons.com',
  'marketwatch.com', 'investors.com', 'seekingalpha.com', 'benzinga.com', 'fool.com',
  'nikkei.com', 'quick.co.jp', 'moneyworld.jp', 'kabutan.jp', 'minkabu.jp',
  'businesswire.com', 'prnewswire.com', 'globenewswire.com', 'nasdaq.com', 'nyse.com',
];
const GENERAL_HOSTS = [
  'apnews.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com', 'washingtonpost.com', 'theguardian.com',
  'cnn.com', 'forbes.com', 'techcrunch.com', 'theverge.com', 'axios.com',
  'nhk.or.jp', 'asahi.com', 'yomiuri.co.jp', 'mainichi.jp', 'itmedia.co.jp', 'impress.co.jp',
];

/** ホスト名から情報源の信頼度を判定する。 */
export function sourceTier(url, officialDomains = []) {
  const host = hostOf(url);
  if (!host) return 5;
  const matches = (list) => list.some((domain) => host === domain || host.endsWith(`.${domain}`));
  if (officialDomains.length > 0 && matches(officialDomains)) return 1;
  if (host.endsWith('.gov') || matches(GOVERNMENT_HOSTS)) return 2;
  if (matches(FINANCE_HOSTS)) return 3;
  if (matches(GENERAL_HOSTS)) return 4;
  return 5;
}

export function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

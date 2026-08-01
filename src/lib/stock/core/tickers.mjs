/**
 * 銘柄カタログとティッカーの検証。
 *
 * サーバー側の定期処理（scripts/stock-news）とブラウザー側の銘柄追加画面の
 * 両方から読み込むため、依存のない素のESMで書いている。
 */

/** 初期候補として画面に並べる銘柄。 */
export const TICKER_CATALOG = [
  { ticker: 'IONQ', companyName: 'IonQ, Inc.', companyNameJa: 'アイオンキュー', exchange: 'NYSE', sector: '量子コンピューター', aliases: ['IonQ'] },
  { ticker: 'NVDA', companyName: 'NVIDIA Corporation', companyNameJa: 'エヌビディア', exchange: 'NASDAQ', sector: '半導体', aliases: ['Nvidia'] },
  { ticker: 'RKLB', companyName: 'Rocket Lab Corporation', companyNameJa: 'ロケット・ラボ', exchange: 'NASDAQ', sector: '宇宙・防衛', aliases: ['Rocket Lab'] },
  { ticker: 'ONDS', companyName: 'Ondas Holdings Inc.', companyNameJa: 'オンダス・ホールディングス', exchange: 'NASDAQ', sector: 'ドローン・通信', aliases: ['Ondas'] },
  { ticker: 'AAPL', companyName: 'Apple Inc.', companyNameJa: 'アップル', exchange: 'NASDAQ', sector: 'テクノロジー', aliases: ['Apple'] },
  { ticker: 'MSFT', companyName: 'Microsoft Corporation', companyNameJa: 'マイクロソフト', exchange: 'NASDAQ', sector: 'ソフトウェア', aliases: ['Microsoft'] },
  { ticker: 'GOOGL', companyName: 'Alphabet Inc.', companyNameJa: 'アルファベット（Google）', exchange: 'NASDAQ', sector: 'インターネット', aliases: ['Google', 'Alphabet'] },
  { ticker: 'AMZN', companyName: 'Amazon.com, Inc.', companyNameJa: 'アマゾン・ドット・コム', exchange: 'NASDAQ', sector: 'Eコマース・クラウド', aliases: ['Amazon'] },
  { ticker: 'META', companyName: 'Meta Platforms, Inc.', companyNameJa: 'メタ・プラットフォームズ', exchange: 'NASDAQ', sector: 'ソーシャル', aliases: ['Facebook', 'Meta'] },
  { ticker: 'TSLA', companyName: 'Tesla, Inc.', companyNameJa: 'テスラ', exchange: 'NASDAQ', sector: 'EV・エネルギー', aliases: ['Tesla'] },
  { ticker: 'AMD', companyName: 'Advanced Micro Devices, Inc.', companyNameJa: 'アドバンスト・マイクロ・デバイセズ', exchange: 'NASDAQ', sector: '半導体', aliases: ['AMD'] },
  { ticker: 'AVGO', companyName: 'Broadcom Inc.', companyNameJa: 'ブロードコム', exchange: 'NASDAQ', sector: '半導体', aliases: ['Broadcom'] },
  { ticker: 'PLTR', companyName: 'Palantir Technologies Inc.', companyNameJa: 'パランティア・テクノロジーズ', exchange: 'NASDAQ', sector: 'データ解析', aliases: ['Palantir'] },
  { ticker: 'RGTI', companyName: 'Rigetti Computing, Inc.', companyNameJa: 'リゲッティ・コンピューティング', exchange: 'NASDAQ', sector: '量子コンピューター', aliases: ['Rigetti'] },
  { ticker: 'QBTS', companyName: 'D-Wave Quantum Inc.', companyNameJa: 'D-Wave クオンタム', exchange: 'NYSE', sector: '量子コンピューター', aliases: ['D-Wave'] },
  { ticker: 'INTC', companyName: 'Intel Corporation', companyNameJa: 'インテル', exchange: 'NASDAQ', sector: '半導体', aliases: ['Intel'] },
  { ticker: 'MU', companyName: 'Micron Technology, Inc.', companyNameJa: 'マイクロン・テクノロジー', exchange: 'NASDAQ', sector: '半導体メモリー', aliases: ['Micron'] },
  { ticker: 'TSM', companyName: 'Taiwan Semiconductor Manufacturing Company Limited', companyNameJa: 'TSMC', exchange: 'NYSE', sector: '半導体受託製造', aliases: ['TSMC'] },
  { ticker: 'ASTS', companyName: 'AST SpaceMobile, Inc.', companyNameJa: 'AST スペースモバイル', exchange: 'NASDAQ', sector: '衛星通信', aliases: ['AST SpaceMobile'] },
  { ticker: 'JOBY', companyName: 'Joby Aviation, Inc.', companyNameJa: 'ジョビー・アビエーション', exchange: 'NYSE', sector: '空飛ぶクルマ', aliases: ['Joby'] },
];

const CATALOG_BY_TICKER = new Map(TICKER_CATALOG.map((entry) => [entry.ticker, entry]));

/** ティッカーとして受け付ける形式（英数字とドット・ハイフン、10文字まで）。 */
const TICKER_PATTERN = /^[A-Z][A-Z0-9]{0,8}(?:[.-][A-Z0-9]{1,4})?$/;

/**
 * 入力されたティッカーを大文字へ正規化する。
 * 形式が不正な場合は null を返す（保存も検索も行わない）。
 */
export function normalizeTicker(value) {
  const text = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!text || text.length > 14) return null;
  return TICKER_PATTERN.test(text) ? text : null;
}

/** カタログに載っている銘柄を返す（未登録なら undefined）。 */
export function findTicker(ticker) {
  const normalized = normalizeTicker(ticker);
  return normalized ? CATALOG_BY_TICKER.get(normalized) : undefined;
}

/** カタログに無い銘柄でも、必ず表示できる形にして返す。 */
export function resolveTicker(ticker, companyName) {
  const normalized = normalizeTicker(ticker);
  if (!normalized) return null;
  const known = CATALOG_BY_TICKER.get(normalized);
  const name = String(companyName ?? '').trim();
  return {
    ticker: normalized,
    companyName: name || known?.companyName || normalized,
    companyNameJa: known?.companyNameJa ?? '',
    exchange: known?.exchange ?? '',
    sector: known?.sector ?? '',
  };
}

/**
 * ティッカー・企業名・日本語名・別名を対象にした部分一致検索。
 * @param {string} query 検索語
 * @param {number} limit 返す最大件数
 */
export function searchTickers(query, limit = 20) {
  const text = String(query ?? '').trim().toLowerCase();
  if (!text) return TICKER_CATALOG.slice(0, limit);
  const scored = [];
  for (const entry of TICKER_CATALOG) {
    const haystacks = [
      entry.ticker.toLowerCase(),
      entry.companyName.toLowerCase(),
      entry.companyNameJa.toLowerCase(),
      entry.sector.toLowerCase(),
      ...entry.aliases.map((alias) => alias.toLowerCase()),
    ];
    let score = -1;
    if (entry.ticker.toLowerCase() === text) score = 100;
    else if (entry.ticker.toLowerCase().startsWith(text)) score = 80;
    else if (haystacks.some((value) => value.startsWith(text))) score = 60;
    else if (haystacks.some((value) => value.includes(text))) score = 40;
    if (score >= 0) scored.push({ entry, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.entry.ticker.localeCompare(b.entry.ticker))
    .slice(0, limit)
    .map((item) => item.entry);
}

/**
 * 日次レポートのHTML生成。
 * すべての銘柄で同じテンプレートを使う（既存のIONQレポートの体裁を踏襲）。
 *
 * 外部から来た文字列は必ずエスケープしてから埋め込む。
 * URLは http / https のものだけをリンクにする。
 */
import {
  CATEGORY_LABELS,
  IMPORTANCE_LABELS,
  IMPORTANCE_MARKS,
  SENTIMENT_LABELS,
  SENTIMENT_MARKS,
  SOURCE_TIER_LABELS,
} from './taxonomy.mjs';
import { canonicalUrl } from './dedupe.mjs';

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

const usd = new Intl.NumberFormat('ja-JP', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const integer = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });

function signedUsd(value) {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${usd.format(Math.abs(Number(value) || 0))}`;
}

function signedPercent(value) {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(Number(value) || 0).toFixed(2)}%`;
}

function dateLabel(value) {
  return String(value ?? '').replaceAll('-', '/');
}

function dateTimeLabel(value) {
  const time = Date.parse(String(value ?? ''));
  if (!Number.isFinite(time)) return String(value ?? '');
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(time));
}

/** 安全なリンク（http/https だけ）。それ以外は文字として出す。 */
function link(url, label) {
  const safe = canonicalUrl(url);
  const text = escapeHtml(label ?? url ?? '');
  if (!safe) return text;
  return `<a href="${escapeHtml(safe)}" rel="noreferrer noopener">${text}</a>`;
}

function list(items, emptyText) {
  if (!items?.length) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function importanceBadge(level) {
  const value = Number(level) || 1;
  const key = value >= 3 ? 3 : value <= 1 ? 1 : 2;
  return `<span class="badge imp-${key}">${escapeHtml(IMPORTANCE_MARKS[key])} 重要度${escapeHtml(IMPORTANCE_LABELS[key])}</span>`;
}

function sentimentBadge(sentiment) {
  const key = ['positive', 'negative'].includes(sentiment) ? sentiment : 'neutral';
  return `<span class="badge sent-${key}">${escapeHtml(SENTIMENT_MARKS[key])} ${escapeHtml(SENTIMENT_LABELS[key])}</span>`;
}

function quoteSection(quote) {
  if (!quote) {
    return `<section class="card quote-empty"><h3>株価データ</h3><p class="muted">この銘柄の株価データは取得していません。本レポートはニュースの内容のみを対象としています。</p></section>`;
  }
  const tone = quote.change > 0 ? 'up' : quote.change < 0 ? 'down' : 'flat';
  const toneMark = quote.change > 0 ? '▲ 上昇' : quote.change < 0 ? '▼ 下落' : '― 変わらず';
  return `<section class="card">
    <div class="headline">
      <div class="price">${escapeHtml(usd.format(quote.close))}</div>
      <div class="change ${tone}">${escapeHtml(toneMark)} ${escapeHtml(signedUsd(quote.change))}（${escapeHtml(signedPercent(quote.changePercent))}）</div>
    </div>
    <table class="metrics">
      <tr><th>始値</th><td>${escapeHtml(usd.format(quote.open))}</td><th>高値</th><td>${escapeHtml(usd.format(quote.high))}</td></tr>
      <tr><th>安値</th><td>${escapeHtml(usd.format(quote.low))}</td><th>出来高</th><td>${escapeHtml(integer.format(quote.volume))}株</td></tr>
    </table>
    <p class="data-note">株価対象日：${escapeHtml(dateLabel(quote.marketDate))}（米国市場の通常取引終値／時間外を含まない）　提供：${escapeHtml(quote.provider)}</p>
  </section>`;
}

function articleRow(article, index) {
  const points = article.keyPoints?.length
    ? `<div class="points"><b>要点</b>${list(article.keyPoints, '')}</div>`
    : '';
  const impact = article.priceImpact
    ? `<div class="impact"><b>株価への影響が考えられるポイント（AIによる分析）：</b>${escapeHtml(article.priceImpact)}</div>`
    : '';
  const duplicates = article.duplicateSources?.length
    ? `<div class="meta">同内容の掲載：${escapeHtml(article.duplicateSources.join('、'))}</div>`
    : '';
  return `<article class="news">
    <div class="news-head">
      <span class="num">${index + 1}</span>
      <span class="badge cat">${escapeHtml(CATEGORY_LABELS[article.category] ?? 'その他')}</span>
      ${importanceBadge(article.importance)}
      ${sentimentBadge(article.sentiment)}
    </div>
    <h3>${escapeHtml(article.title)}</h3>
    <div class="meta">公開：${escapeHtml(article.publishedAt || '確認できず')}　／　媒体：${escapeHtml(article.sourceName)}（${escapeHtml(SOURCE_TIER_LABELS[article.sourceTier] ?? 'その他')}）　／　取得：${escapeHtml(dateTimeLabel(article.fetchedAt))}</div>
    <p class="fact"><b>事実：</b>${escapeHtml(article.summary)}</p>
    ${points}
    ${impact}
    ${duplicates}
    <div class="meta url">元記事：${link(article.url, article.url)}</div>
  </article>`;
}

/**
 * レポートHTMLを作る。
 * @param {object} report buildReport の戻り値
 */
export function renderReportHtml(report) {
  const articles = Array.isArray(report.articles) ? report.articles : [];
  const newsHtml = articles.length
    ? articles.map((article, index) => articleRow(article, index)).join('')
    : `<p class="empty">対象期間内に、この銘柄に直接関係する重要な新規ニュースは確認できませんでした。</p>`;

  const nextEvent =
    report.nextEvent?.title || report.nextEvent?.date
      ? `<p><b>${escapeHtml(report.nextEvent.date || '日付未確認')}</b>　${escapeHtml(report.nextEvent.title || '')}</p>`
      : '<p class="muted">日付を確認できる次の重要イベントはありません。</p>';

  const sourceHtml = (report.sources ?? [])
    .slice(0, 8)
    .map((source) => `<li>${link(source.url, source.title || source.url)}</li>`)
    .join('');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${escapeHtml(`${report.ticker} 日次ニュースレポート ${report.reportDate}`)}</title>
<style>
  @page { size: A4; margin: 9mm 10mm 10mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { color: #17202b; font-family: "Noto Sans CJK JP", "Noto Sans JP", "Yu Gothic", "Hiragino Kaku Gothic ProN", sans-serif; font-size: 8.2pt; line-height: 1.5; }
  a { color: #1f5d9c; text-decoration: underline; overflow-wrap: anywhere; }
  header { border-bottom: 2.5px solid #1f5d9c; padding-bottom: 5px; margin-bottom: 7px; }
  .kicker { color: #1f5d9c; font-size: 6.8pt; font-weight: 800; letter-spacing: .16em; }
  h1 { margin: 2px 0 4px; font-size: 15pt; line-height: 1.18; }
  .header-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px; color: #586576; font-size: 7.2pt; }
  h2 { margin: 9px 0 4px; padding-left: 6px; border-left: 3px solid #1f5d9c; font-size: 10pt; line-height: 1.2; break-after: avoid; }
  h3 { margin: 2px 0 3px; font-size: 9pt; line-height: 1.35; }
  p { margin: 2px 0; }
  ul { margin: 2px 0 0; padding-left: 15px; }
  li { margin: 1px 0; }
  .muted { color: #647184; }
  .summary { background: #eef5fb; border-radius: 7px; padding: 7px 9px; font-size: 8.6pt; }
  .summary .head { font-weight: 800; margin-bottom: 3px; }
  .card { border: 1px solid #d9e0e8; border-radius: 7px; padding: 6px 7px; break-inside: avoid; }
  .top-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .headline { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
  .price { font-size: 15pt; font-weight: 800; line-height: 1; }
  .change { font-size: 8.6pt; font-weight: 800; }
  .change.up { color: #087647; }
  .change.down { color: #b3261e; }
  .change.flat { color: #586576; }
  .metrics { width: 100%; border-collapse: collapse; }
  .metrics th, .metrics td { border: 1px solid #d9e0e8; padding: 3px 4px; }
  .metrics th { background: #f3f6f9; color: #586576; text-align: left; font-weight: 600; }
  .metrics td { text-align: right; font-weight: 700; }
  .data-note { color: #586576; font-size: 6.9pt; margin-top: 3px; }
  .quote-empty { background: #f7f9fb; }
  .news { border: 1px solid #d9e0e8; border-left: 3px solid #9db4cc; border-radius: 6px; padding: 6px 7px; margin-bottom: 5px; break-inside: avoid; }
  .news-head { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-bottom: 2px; }
  .num { display: inline-flex; width: 15px; height: 15px; align-items: center; justify-content: center; border-radius: 999px; background: #1f5d9c; color: #fff; font-size: 6.6pt; font-weight: 800; }
  .badge { display: inline-block; border: 1px solid #c3ccd6; border-radius: 999px; padding: 0 5px; font-size: 6.6pt; font-weight: 700; background: #fff; }
  .badge.cat { background: #eef2f6; }
  .imp-3 { border-color: #b3261e; color: #8c1d18; background: #fdeceb; }
  .imp-2 { border-color: #9a6a00; color: #7a5400; background: #fdf5e4; }
  .imp-1 { border-color: #9aa5b1; color: #5a6572; }
  .sent-positive { border-color: #087647; color: #076a40; background: #e9f6ef; }
  .sent-negative { border-color: #b3261e; color: #8c1d18; background: #fdeceb; }
  .sent-neutral { border-color: #9aa5b1; color: #5a6572; }
  .meta { color: #647184; font-size: 6.8pt; margin: 1px 0; }
  .meta.url { margin-top: 2px; }
  .fact { font-size: 8pt; }
  .points b, .impact b { font-size: 7.2pt; color: #38516b; }
  .impact { margin-top: 2px; padding: 3px 5px; background: #f6f8fa; border-radius: 5px; font-size: 7.4pt; }
  .empty { padding: 10px; text-align: center; color: #647184; border: 1px dashed #c3ccd6; border-radius: 7px; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .sources { columns: 2; font-size: 7pt; }
  .disclaimer { margin-top: 7px; padding-top: 5px; border-top: 1px solid #d9e0e8; font-size: 6.8pt; color: #5a6572; line-height: 1.45; }
  .disclaimer b { color: #38516b; }
</style>
</head>
<body>
<header>
  <div class="kicker">STOCK NEWS DAILY REPORT</div>
  <h1>${escapeHtml(report.ticker)} 日次ニュースレポート</h1>
  <div class="header-grid">
    <div>対象銘柄：${escapeHtml(report.companyName)}（${escapeHtml(report.ticker)}）</div>
    <div>対象期間：${escapeHtml(dateLabel(report.periodFrom))} 〜 ${escapeHtml(dateLabel(report.periodTo))}（日本時間）</div>
    <div>作成日時：${escapeHtml(dateTimeLabel(report.generatedAt))}（Asia/Tokyo）</div>
    <div>採用ニュース：${escapeHtml(String(report.articleCount))} 件　／　総合判定：${escapeHtml(SENTIMENT_MARKS[report.sentiment] ?? '＝')} ${escapeHtml(SENTIMENT_LABELS[report.sentiment] ?? 'ニュートラル')}</div>
  </div>
</header>

<h2>本日の重要ニュース要約</h2>
<div class="summary">
  <div class="head">${escapeHtml(report.headline)}</div>
  <div>${escapeHtml(report.summary)}</div>
</div>

<h2>株価の参考情報</h2>
<div class="top-grid">
  ${quoteSection(report.quote)}
  <section class="card">
    <h3>値動きの補足（AIによる分析）</h3>
    <p>${escapeHtml(report.priceComment || '株価データを取得していないため、値動きの分析は行っていません。')}</p>
    <p class="data-note">日中の時間帯別株価および時間外取引は取得していません。値動きの理由は断定できません。</p>
  </section>
</div>

<h2>ニュース一覧（重要度の高い順）</h2>
${newsHtml}

<h2>今後の確認事項</h2>
<div class="two-col">
  <section class="card">
    <h3>今後確認すべき項目</h3>
    ${list(report.watchItems, '具体的な確認項目はありません。')}
  </section>
  <section class="card">
    <h3>次の重要イベント／確認できていないこと</h3>
    ${nextEvent}
    ${list(report.uncertainties, '特記事項なし')}
  </section>
</div>

<h2>情報源</h2>
${sourceHtml ? `<ul class="sources">${sourceHtml}</ul>` : '<p class="muted">参照URLを取得できませんでした。</p>'}

<div class="disclaimer">
  <b>免責事項：</b>本レポートは、公開情報を自動で収集・整理した情報提供資料です。事実の記載は各記事の内容にもとづき、影響の見立てはAIによる分析であり、確定した事実ではありません。
  情報の正確性・網羅性・最新性を保証するものではなく、記載内容には誤りや取得漏れが含まれる可能性があります。
  本レポートは特定の銘柄の売買を推奨するものではなく、投資助言ではありません。投資判断はご自身の責任で行い、必ず一次情報（企業のIR資料・公的開示）をご確認ください。
</div>
</body>
</html>`;
}

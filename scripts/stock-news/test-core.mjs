/**
 * 共通処理の検証（外部APIを呼ばずに、日付計算・重複排除・関連性判定・
 * レポート組み立て・HTML生成が期待どおり動くかを確認する）。
 * 実行: npm run stock-news:test
 */
import { zonedParts, isDue, nextRunAt, zonedIso, isScheduledDay, reportPeriod } from '../../src/lib/stock/core/schedule.mjs';
import { normalizeTicker, searchTickers, resolveTicker } from '../../src/lib/stock/core/tickers.mjs';
import { dedupeArticles, isRelevantArticle, canonicalUrl } from '../../src/lib/stock/core/dedupe.mjs';
import { buildReport, reportFileName, reportNotificationText } from '../../src/lib/stock/core/report.mjs';
import { renderReportHtml } from '../../src/lib/stock/core/render.mjs';

let fail = 0;
const ok = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`); if (!cond) fail++; };

// ticker
ok('normalize lower', normalizeTicker(' nvda ') === 'NVDA');
ok('reject bad', normalizeTicker('bad ticker!!') === null);
ok('accept BRK.B', normalizeTicker('brk.b') === 'BRK.B');
ok('search by name', searchTickers('エヌビディア')[0]?.ticker === 'NVDA');
ok('search by company', searchTickers('rocket')[0]?.ticker === 'RKLB');
ok('resolve unknown', resolveTicker('ZZZZ', '')?.companyName === 'ZZZZ');

// schedule
const sub = { enabled: true, frequency: 'daily', time: '08:00', timeZone: 'Asia/Tokyo' };
const at0759 = zonedParts(new Date('2026-08-01T22:59:00Z'), 'Asia/Tokyo'); // JST 07:59 Aug 2
ok('not due before time', isDue(sub, at0759) === false);
const at0801 = zonedParts(new Date('2026-08-01T23:01:00Z'), 'Asia/Tokyo'); // JST 08:01 Aug 2
ok('due after time', isDue(sub, at0801) === true);
ok('not due when done', isDue({ ...sub, lastRunDate: at0801.date, lastRunStatus: 'success' }, at0801) === false);
ok('retry when failed', isDue({ ...sub, lastRunDate: at0801.date, lastRunStatus: 'failed' }, at0801) === true);
ok('disabled never due', isDue({ ...sub, enabled: false }, at0801) === false);
ok('weekdays skips sunday', isScheduledDay({ frequency: 'weekdays' }, '2026-08-02') === false);
ok('weekdays monday ok', isScheduledDay({ frequency: 'weekdays' }, '2026-08-03') === true);
ok('weekly picks day', isScheduledDay({ frequency: 'weekly', weekdays: [3] }, '2026-08-05') === true);
ok('manual never', isScheduledDay({ frequency: 'manual' }, '2026-08-03') === false);
ok('zonedIso jst 8:00', zonedIso('2026-08-02', 480, 'Asia/Tokyo') === '2026-08-01T23:00:00.000Z');
ok('zonedIso ny dst', zonedIso('2026-08-02', 480, 'America/New_York') === '2026-08-02T12:00:00.000Z');
const next = nextRunAt(sub, new Date('2026-08-01T23:01:00Z'));
ok('nextRunAt soon', typeof next === 'string');
ok('manual no next', nextRunAt({ ...sub, frequency: 'manual' }) === null);
ok('period default', reportPeriod({}, '2026-08-02').from === '2026-08-01');
ok('period from last run', reportPeriod({ lastRunDate: '2026-07-31' }, '2026-08-02').from === '2026-07-31');

// dedupe
ok('canonical strips utm', canonicalUrl('https://www.reuters.com/a/b/?utm_source=x&id=3') === 'https://reuters.com/a/b?id=3');
ok('reject javascript url', canonicalUrl('javascript:alert(1)') === '');
const arts = [
  { title: 'NVIDIA announces new GPU', url: 'https://reuters.com/x', sourceTier: 3 },
  { title: 'NVIDIA announces new GPU!', url: 'https://randomblog.com/y', sourceTier: 5 },
  { title: 'NVIDIA announces new GPU', url: 'https://nvidianews.nvidia.com/z', sourceTier: 1 },
  { title: 'Other story', url: 'https://reuters.com/other', sourceTier: 3 },
];
const deduped = dedupeArticles(arts);
ok('dedupe merges', deduped.length === 2);
ok('dedupe keeps best tier', deduped[0].sourceTier === 1);
ok('dedupe hash present', typeof deduped[0].dedupeHash === 'string' && deduped[0].dedupeHash.length === 8);

// relevance
ok('relevant by company', isRelevantArticle({ title: 'NVIDIA beats estimates', url: 'https://a.com/1' }, 'NVDA', 'NVIDIA Corporation'));
ok('relevant by ticker form', isRelevantArticle({ title: 'Shares of (NVDA) rose', url: 'https://a.com/1' }, 'NVDA', 'NVIDIA Corporation'));
ok('irrelevant coincidence', isRelevantArticle({ title: 'The meta question about design', url: 'https://a.com/1' }, 'META', 'Meta Platforms, Inc.') === false);

// report + render
const news = {
  headline: 'テスト見出し', summary: 'まとめ', priceComment: '',
  articles: [{ title: '<script>x</script>タイトル', summary: '要約', keyPoints: ['点1'], priceImpact: '可能性がある', publishedAt: '2026-08-02', fetchedAt: new Date().toISOString(), sourceName: 'Reuters', sourceHost: 'reuters.com', url: 'https://reuters.com/a', ticker: 'NVDA', category: 'earnings', importance: 3, sentiment: 'positive', sourceTier: 3, dedupeHash: 'abcd1234' }],
  watchItems: ['見る'], uncertainties: ['不明'], nextEvent: { date: '2026-08-20', title: '決算' }, sources: [{ title: 'R', url: 'https://reuters.com/a' }],
  fetchedCount: 2, acceptedCount: 1, fetchedAt: new Date().toISOString(),
};
const rep = buildReport({ ticker: 'nvda', companyName: 'NVIDIA Corporation', reportDate: '2026-08-02', periodFrom: '2026-08-01', periodTo: '2026-08-02', news, quote: null });
ok('report id', rep.reportId === 'NVDA_20260802');
ok('file name', rep.fileName === 'NVDA_日次レポート_20260802.pdf');
ok('importance agg', rep.importance === 3);
ok('sentiment agg', rep.sentiment === 'positive');
ok('notification', reportNotificationText(rep).includes('NVDAの2026年8月2日分レポートを作成しました'));
const html = renderReportHtml(rep);
ok('html escaped', !html.includes('<script>x</script>') && html.includes('&lt;script&gt;'));
ok('html has link', html.includes('href="https://reuters.com/a"'));
ok('html disclaimer', html.includes('免責事項'));
const empty = buildReport({ ticker: 'IONQ', companyName: 'IonQ, Inc.', reportDate: '2026-08-02', periodFrom: '2026-08-01', periodTo: '2026-08-02', news: { ...news, articles: [] } });
ok('empty status', empty.status === 'empty' && empty.articleCount === 0);
ok('empty html', renderReportHtml(empty).includes('重要な新規ニュースは確認できませんでした'));

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);

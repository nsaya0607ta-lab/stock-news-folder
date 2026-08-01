/**
 * 銘柄ニュースの定期実行。
 *
 * GitHub Actions から一定間隔（既定10分ごと）で起動し、Firestore に登録された
 * 銘柄購読設定のうち「実行時刻を迎えたもの」だけを処理する。
 * ブラウザーが閉じていても動作し、1銘柄の失敗はほかの銘柄へ波及させない。
 */
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

import { generateStockReport } from './generate.mjs';
import { isDue, nextRunAt, reportPeriod, zonedParts, DEFAULT_TIME_ZONE } from '../../src/lib/stock/core/schedule.mjs';
import { reportId } from '../../src/lib/stock/core/report.mjs';
import { normalizeTicker } from '../../src/lib/stock/core/tickers.mjs';

const MAX_SUBSCRIPTIONS_PER_RUN = 60;
const MAX_GENERATIONS_PER_RUN = 8;
const MAX_ATTEMPTS = 3;
/** 中断した実行を、この時間が過ぎたら引き取り直す。 */
const STALE_RUN_MS = 30 * 60_000;

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is missing');
  const parsed = JSON.parse(raw);
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is invalid');
  }
  return {
    projectId: parsed.project_id,
    clientEmail: parsed.client_email,
    privateKey: String(parsed.private_key).replace(/\\n/g, '\n'),
  };
}

const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
if (!bucketName) throw new Error('FIREBASE_STORAGE_BUCKET is missing');

const app =
  getApps()[0] ??
  initializeApp({ credential: cert(serviceAccount()), storageBucket: bucketName });
const db = getFirestore(app);
const bucket = getStorage(app).bucket(bucketName);

/** 秘密情報を含めずに、原因だけを短く残す。 */
function errorMessage(error) {
  const text = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return text.replace(/key=[^&\s]+/gi, 'key=***').slice(0, 500);
}

/**
 * 実行権を取る。同じ銘柄・同じ日の処理が二重に走らないようにする。
 * すでに成功・スキップ済みなら false を返す（冪等性）。
 */
async function acquireRun(userRef, subscription, runDate) {
  const runRef = userRef.collection('stockReportRuns').doc(`${subscription.ticker}_${runDate.replaceAll('-', '')}`);
  const acquired = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(runRef);
    const existing = snapshot.exists ? snapshot.data() : null;
    if (existing?.status === 'success' || existing?.status === 'skipped') return false;
    if (existing?.status === 'running') {
      const updated = existing.updatedAt?.toDate?.()?.getTime?.() ?? 0;
      if (Date.now() - updated < STALE_RUN_MS) return false;
    }
    const attempt = Number(existing?.attempt || 0) + 1;
    if (attempt > MAX_ATTEMPTS) return false;
    transaction.set(
      runRef,
      {
        ticker: subscription.ticker,
        companyName: subscription.companyName ?? subscription.ticker,
        runDate,
        status: 'running',
        attempt,
        trigger: 'scheduled',
        startedAt: existing?.startedAt ?? FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        error: FieldValue.delete(),
      },
      { merge: true },
    );
    return true;
  });
  return acquired ? runRef : null;
}

/** その日のレポートがすでにある（「今すぐ取得」で作られたなど）か。 */
async function alreadyGenerated(userRef, ticker, runDate) {
  const snapshot = await userRef.collection('stockReports').doc(reportId(ticker, runDate)).get();
  return snapshot.exists;
}

async function finishRun(runRef, patch) {
  await runRef.set(
    { ...patch, finishedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

async function updateSubscription(subscriptionRef, subscription, runDate, status, error) {
  const next = nextRunAt({ ...subscription, lastRunDate: runDate, lastRunStatus: status });
  await subscriptionRef.set(
    {
      lastRunAt: FieldValue.serverTimestamp(),
      lastRunDate: runDate,
      lastRunStatus: status,
      lastError: error ? error : FieldValue.delete(),
      nextRunAt: next ?? FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/** 1銘柄を処理する。ここで投げた例外は呼び出し側で握り、ほかの銘柄へ波及させない。 */
async function processSubscription(subscriptionDoc) {
  const subscription = subscriptionDoc.data();
  const userRef = subscriptionDoc.ref.parent.parent;
  if (!userRef || userRef.parent.id !== 'users') return false;

  const ticker = normalizeTicker(subscription.ticker ?? subscriptionDoc.id);
  if (!ticker) {
    console.warn(`不正なティッカーのためスキップ: ${subscriptionDoc.ref.path}`);
    return false;
  }
  const timeZone = subscription.timeZone || DEFAULT_TIME_ZONE;
  const now = zonedParts(new Date(), timeZone);
  if (!isDue({ ...subscription, ticker }, now)) return false;

  const runDate = now.date;
  const runRef = await acquireRun(userRef, { ...subscription, ticker }, runDate);
  if (!runRef) return false;

  const uid = userRef.id;
  try {
    if (await alreadyGenerated(userRef, ticker, runDate)) {
      await finishRun(runRef, { status: 'skipped', message: 'すでに同じ日のレポートがあります' });
      await updateSubscription(subscriptionDoc.ref, { ...subscription, ticker }, runDate, 'success');
      console.log(`${uid}/${ticker}: 当日分は作成済みのためスキップ`);
      return false;
    }

    const period = reportPeriod(subscription, runDate);
    const { report, pdf } = await generateStockReport({
      ticker,
      companyName: subscription.companyName,
      reportDate: runDate,
      periodFrom: period.from,
      periodTo: period.to,
      language: subscription.language,
      detail: subscription.detail,
      maxArticles: subscription.maxArticles,
      withQuote: subscription.includeQuote !== false,
      source: 'scheduled',
    });

    // ニュースが無い日は、既定ではPDFを作らず履歴だけ残す。
    if (report.articleCount === 0 && subscription.emptyDayPolicy !== 'report') {
      await finishRun(runRef, {
        status: 'skipped',
        fetchedCount: report.fetchedCount,
        acceptedCount: 0,
        message: '対象期間内に重要な新規ニュースはありませんでした',
      });
      await updateSubscription(subscriptionDoc.ref, { ...subscription, ticker }, runDate, 'success');
      console.log(`${uid}/${ticker}: 新規ニュースなし`);
      return true;
    }

    const objectPath = `users/${uid}/stock-reports/${report.reportId}.pdf`;
    await bucket.file(objectPath).save(pdf, {
      resumable: false,
      contentType: 'application/pdf',
      metadata: {
        cacheControl: 'private,no-store',
        metadata: { reportId: report.reportId, ticker, reportDate: runDate },
      },
    });

    const reportRef = userRef.collection('stockReports').doc(report.reportId);
    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(reportRef);
      const version = Number(existing.data()?.version || 0) + 1;
      transaction.set(
        reportRef,
        {
          ...report,
          version,
          objectPath,
          size: pdf.length,
          folderTicker: ticker,
          status: 'ready',
          importState: 'pending',
          createdAt: existing.data()?.createdAt ?? FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    await finishRun(runRef, {
      status: 'success',
      fetchedCount: report.fetchedCount,
      acceptedCount: report.acceptedCount,
      reportId: report.reportId,
      fileName: report.fileName,
      objectPath,
      size: pdf.length,
    });
    await updateSubscription(subscriptionDoc.ref, { ...subscription, ticker }, runDate, 'success');
    console.log(`${uid}/${ticker}: ${report.fileName} (${report.articleCount}件 / ${Math.round(pdf.length / 1024)}KB)`);
    return true;
  } catch (error) {
    const message = errorMessage(error);
    console.error(`${uid}/${ticker} の生成に失敗:`, message);
    await finishRun(runRef, { status: 'failed', error: message }).catch(() => undefined);
    await updateSubscription(subscriptionDoc.ref, { ...subscription, ticker }, runDate, 'failed', message).catch(
      () => undefined,
    );
    return false;
  }
}

/** 端末へ取り込み済みのPDFを、保管領域から片付ける。 */
async function cleanupImportedReports() {
  const snapshot = await db
    .collectionGroup('stockReports')
    .where('importState', '==', 'imported')
    .where('cleanupAt', '<=', Timestamp.now())
    .limit(30)
    .get();
  for (const doc of snapshot.docs) {
    const objectPath = String(doc.data().objectPath || '');
    if (objectPath.includes('/stock-reports/')) {
      await bucket.file(objectPath).delete({ ignoreNotFound: true }).catch(() => undefined);
    }
    await doc.ref.set({ objectPath: FieldValue.delete(), importState: 'archived' }, { merge: true }).catch(() => undefined);
  }
  if (!snapshot.empty) console.log(`取り込み済みPDF ${snapshot.size} 件を保管領域から削除しました`);
}

async function main() {
  const now = zonedParts();
  console.log(`銘柄ニュース定期処理: ${now.date} ${now.time} ${DEFAULT_TIME_ZONE}`);
  await cleanupImportedReports().catch((error) => console.error('後片付けに失敗:', errorMessage(error)));

  const snapshot = await db
    .collectionGroup('stockSubscriptions')
    .where('enabled', '==', true)
    .limit(MAX_SUBSCRIPTIONS_PER_RUN)
    .get();
  console.log(`有効な購読=${snapshot.size}`);

  let generated = 0;
  for (const doc of snapshot.docs) {
    if (generated >= MAX_GENERATIONS_PER_RUN) {
      console.log('1回あたりの生成上限に達しました。残りは次回の起動で処理します。');
      break;
    }
    try {
      if (await processSubscription(doc)) generated += 1;
    } catch (error) {
      // 1銘柄の失敗でループ全体を止めない。
      console.error(`購読 ${doc.ref.path} の処理に失敗:`, errorMessage(error));
    }
  }
  console.log(`生成した銘柄数=${generated}`);
}

await main();

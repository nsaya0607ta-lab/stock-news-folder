# 株式ニュースフォルダー（銘柄別ニュースレポート）

追跡したい株式銘柄を登録すると、**毎日その銘柄のニュースを収集・整理した日次レポートが自動で作成され、銘柄ごとのフォルダーへ保存される**アプリです。

もともと IONQ 1 銘柄だけを対象にしていた日次レポート機能を、任意の銘柄へ拡張した共通処理に置き換えています。

---

## 1. 全体の流れ

```
GitHub Actions（10分ごと）
  └─ scripts/stock-news/scheduler.mjs
       ├─ Firestore: users/{uid}/stockSubscriptions を collectionGroup で読む
       ├─ 購読設定のタイムゾーンで「実行時刻を迎えたもの」だけ抽出
       ├─ 実行権を取得（users/{uid}/stockReportRuns/{ticker}_{yyyymmdd}）＝冪等性
       ├─ scripts/stock-news/generate.mjs
       │    ├─ quote.mjs   … Alpha Vantage（任意。失敗しても続行）
       │    ├─ news.mjs    … Gemini + Google検索グラウンディングでニュース取得
       │    │                 → 関連性チェック・重複排除・分類・重要度・感情
       │    ├─ report.mjs  … レポートレコードの組み立て
       │    ├─ render.mjs  … レポートHTMLの生成（全銘柄共通テンプレート）
       │    └─ pdf.mjs     … Puppeteer で A4 PDF 化
       ├─ Cloud Storage: users/{uid}/stock-reports/{ticker}_{yyyymmdd}.pdf
       └─ Firestore: users/{uid}/stockReports/{ticker}_{yyyymmdd}（importState: pending）

ブラウザー（アプリ）
  └─ StockProvider（src/store/StockStore.tsx）
       ├─ 起動時・復帰時・5分ごとに pending のレポートを取り込む
       │    → PDF を IndexedDB の銘柄フォルダーへ保存し、importState を imported に更新
       ├─ 「今すぐ取得」→ POST /api/stock/report（サーバー側でニュース取得）
       │    → 返ってきた内容をブラウザーで PDF 化して同じ場所へ保存
       └─ 端末内（IndexedDB）に購読設定・レポート・実行履歴・通知を保持
```

ブラウザーを閉じていても動くのは、**定期実行が GitHub Actions（サーバー側）で動いている**ためです。
クライアント側の `setTimeout` / `setInterval` は、開いている間の取り込み確認にしか使っていません。

---

## 2. 実行間隔と時刻の考え方

- 定期ジョブは 10 分間隔で「実行対象を確認」し、**実行時刻を迎えた銘柄だけ**を処理します。
  ユーザーごと・銘柄ごとに任意の時刻を設定できるのはこのためです。
- 判定はすべて購読設定のタイムゾーン（既定 `Asia/Tokyo`）で行います（`core/schedule.mjs`）。
- 取得頻度は `daily`（毎日）／`weekdays`（平日のみ）／`weekly`（曜日指定）／`manual`（手動のみ）。

### 冪等性（同じ処理が重なっても増えない仕組み）

| 対象 | キー | 動作 |
| --- | --- | --- |
| 実行 | `stockReportRuns/{ticker}_{yyyymmdd}` | `success` / `skipped` なら再実行しない。`running` は30分で引き取り直す。失敗は最大3回まで |
| レポート | `stockReports/{ticker}_{yyyymmdd}` | 同じ日は必ず同じID。既にあれば定期処理はスキップする |
| PDF | `{ticker}_日次レポート_{yyyymmdd}.pdf` | 同名なら上書き（`onDuplicate: 'overwrite'`）。ファイルは増えない |
| 記事 | `dedupeHash`（正規化URL＋見出し） | 同じURL・実質同じ見出しは1件に統合。信頼度の高い情報源を残す |

---

## 3. ニュース取得のルール

1. Gemini の Google 検索グラウンディングで、対象期間内のニュースだけを検索します。
2. 検索結果に出てきた URL 以外は採用しません（生成された架空のURLを保存しない）。
3. 銘柄との関連性を `core/dedupe.mjs` の `isRelevantArticle` で確認します。
   企業名（複数語または5文字以上の語）が本文にあるか、`NASDAQ: XXXX` `(XXXX)` `$XXXX` `XXXX株` の形でティッカーが出てくる場合だけ採用します。
   「meta」のような一般語の偶然の一致は採用しません。
4. 情報源の優先順位は次のとおりです（`core/taxonomy.mjs`）。
   1. 企業公式・IR
   2. SEC などの公的開示
   3. 信頼性の高い金融メディア
   4. 大手一般ニュース
   5. その他
5. カテゴリーは 12 種類（決算／業績予想／製品・技術／提携・契約／買収・合併／資金調達・増資／規制・訴訟／経営陣・人事／アナリスト評価／大株主・インサイダー取引／市場・業界動向／その他）。
6. 重要度（1〜3）と感情（ポジティブ／ニュートラル／ネガティブ）を各記事に付けます。
   画面上は色だけでなく、記号（◎○△／＋＝−）と文字でも判別できるようにしています。

### ニュースがない日

既定では **レポートを作らず**、実行履歴に「対象期間内に重要な新規ニュースはありませんでした」と記録します。
銘柄設定の「ニュースがない日の処理」で「ニュースなしレポートを作る」に変更できます。

---

## 4. データ構造

### Firestore

```
users/{uid}/stockSubscriptions/{TICKER}
  ticker, companyName, folderId, folderName,
  frequency, weekdays[], time, timeZone,
  language, detail, maxArticles, emptyDayPolicy, includeQuote, enabled,
  lastRunAt, lastRunDate, lastRunStatus, lastError, nextRunAt,
  createdAt, updatedAt

users/{uid}/stockReports/{TICKER}_{YYYYMMDD}
  reportId, ticker, companyName, reportDate, periodFrom, periodTo, generatedAt,
  fileName, language, detail, articleCount, headline, summary, priceComment,
  importance, sentiment,
  articles[]  … title, summary, keyPoints[], priceImpact, publishedAt, fetchedAt,
                sourceName, sourceHost, url, ticker, category, importance,
                sentiment, sourceTier, dedupeHash, duplicateSources[]
  watchItems[], uncertainties[], nextEvent, sources[], quote,
  objectPath, size, version, status, source, importState, localFileId, cleanupAt

users/{uid}/stockReportRuns/{TICKER}_{YYYYMMDD}
  ticker, companyName, runDate, status, attempt, trigger,
  startedAt, finishedAt, fetchedCount, acceptedCount,
  reportId, fileName, objectPath, size, message, error
```

### Cloud Storage

```
users/{uid}/stock-reports/{TICKER}_{YYYYMMDD}.pdf
```

作成は Firebase Admin（定期処理）だけ。本人は読み取りと削除のみ可能です。

### 端末内（IndexedDB / 既存の設定ストアに相乗り）

| キー | 内容 |
| --- | --- |
| `stock:subscriptions` | 銘柄購読設定 |
| `stock:reports` | レポート本文＋未読・お気に入り・端末内PDFのID |
| `stock:runs` | 実行履歴（最大300件） |
| `stock:notifications` | アプリ内通知（最大120件） |

PDF 本体は、これまでどおり既存の `files` / `blobs` ストアへ保存されます。

---

## 5. 必要な環境変数

### GitHub Actions（リポジトリの Secrets / Variables）

| 名前 | 種別 | 必須 | 説明 |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | Secret | ✅ | ニュース取得（Google 検索グラウンディング付き Gemini） |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Secret | ✅ | Firestore / Storage への管理者アクセス（JSON をそのまま貼る） |
| `FIREBASE_STORAGE_BUCKET` | Variable | ✅ | 既定 `my-az900-app.firebasestorage.app` |
| `GEMINI_MODEL` | Variable | 任意 | 既定 `gemini-3.6-flash` |
| `ALPHA_VANTAGE_API_KEY` | Secret | 任意 | 株価データ。未設定ならニュースのみのレポートになる |

### Vercel（pdf-manager プロジェクトの Environment Variables）

| 名前 | 必須 | 説明 |
| --- | --- | --- |
| `GEMINI_API_KEY` | ✅ | 「今すぐ取得」と AI アシスタントで使用 |
| `GEMINI_MODEL` | 任意 | 既定 `gemini-3.5-flash` |
| `ALPHA_VANTAGE_API_KEY` | 任意 | 「今すぐ取得」で株価を併記する場合 |
| `FIREBASE_WEB_API_KEY` | 任意 | ID トークン検証に使う（未設定時は公開ウェブ設定を使用） |

いずれも **サーバー側でのみ読み込み**、ブラウザーへは配信しません
（`NEXT_PUBLIC_` を付けていないため、クライアントバンドルには含まれません）。

---

## 6. Firebase 側で必要な設定

### 6-1. Firestore ルール

`firebase.json` が参照しているのは **リポジトリ直下の `firestore.rules`** です。
株式ニュース用のルール（`stockSubscriptions` / `stockReports` / `stockReportRuns`）は
このファイルにも追記済みなので、リポジトリ直下で次を実行すれば反映されます。

```bash
npx firebase-tools login
npm run deploy:rules      # = firebase deploy --only firestore:rules
```

> ⚠️ **反映前に必ず確認してください。**
> リポジトリ直下の `firestore.rules` には、Gemini 機能のルール
> （`geminiChats` / `pdfGenerationRules` / `geminiGeneratedPdfs` など）が入っていません。
> それらは `pdf-manager/firebase/gemini.firestore.rules` に別ファイルとして置かれており、
> Firebase コンソールへ手作業で反映されている可能性があります。
> この状態で `npm run deploy:rules` を実行すると、コンソール側のルールが
> リポジトリ直下の内容で**置き換わり**、Gemini 自動PDFが `permission-denied` になる恐れがあります。
>
> 安全な進め方:
> 1. Firebase コンソール（Firestore Database → ルール）で**現在のルールをコピーして保管**する
> 2. そこへ `firestore.rules` の「📈 株式ニュースフォルダー」ブロックだけを貼り足して公開する
>
> （リポジトリ直下の `firestore.rules` を正としてよい場合のみ、`npm run deploy:rules` を使ってください）

### 6-2. Storage ルール

`firebase.json` に `storage` の設定が無いため、CLI でのデプロイはできません。
`pdf-manager/firebase/pdf-cloud-storage.storage.rules` の内容を
**Firebase コンソール → Storage → Rules** に貼り付けて公開してください。
`users/{userId}/stock-reports/{fileName}` のブロックが今回の追加分です。

### 6-3. 複合インデックス（後回しで構いません）

必要なのは 1 つだけです。

| コレクショングループ | フィールド | 用途 |
| --- | --- | --- |
| `stockReports` | `importState`（昇順）＋ `cleanupAt`（昇順） | 端末へ取り込み済みのPDFを保管領域から片付ける処理 |

> このインデックスが無くても、**レポートの生成・保存・取り込みはすべて動きます**。
> 影響を受けるのは後片付け処理だけで、その場合 Actions のログにエラーと
> 「インデックスを作成する」リンクが出ます。

**推奨：リンクをクリックする**
定期処理を 1 回動かし、Actions のログに出る `https://console.firebase.google.com/...create_composite=...`
を開いて「作成」を押すのが、いちばん確実で手戻りがありません。

**または：コンソールで手作業で作る**
Firebase コンソール → Firestore Database → **インデックス** → 複合 → インデックスを作成
- コレクションID: `stockReports`
- フィールド: `importState`（昇順）→ `cleanupAt`（昇順）
- クエリのスコープ: **コレクショングループ**

**CLI は現状そのままでは使えません。**
リポジトリ直下の `firebase.json` には `firestore.indexes` の指定が無いため、
`firebase deploy --only firestore:indexes` を実行しても何も反映されません。
CLI で配りたい場合は `firebase.json` に

```json
{ "firestore": { "rules": "firestore.rules", "indexes": "pdf-manager/firebase/firestore.indexes.json" } }
```

を追記する必要がありますが、そのファイルに載っていない既存のインデックス
（このリポジトリの他機能でコンソールに手作業で作ったもの）が
削除対象として提示される場合があります。上の 2 つの方法のほうが安全です。

Firebase Authentication（メール／パスワード）が有効になっている必要があります。
定期取得はユーザー単位で動くため、**アプリの設定画面からクラウド連携（ログイン）を有効にする**ことが前提です。

---

## 7. デプロイ手順

1. `main` へマージすると Vercel が `pdf-manager` を自動デプロイします。
2. Vercel の環境変数に `GEMINI_API_KEY`（必要なら `ALPHA_VANTAGE_API_KEY`）を設定します。
3. GitHub のリポジトリ設定に、上記 Secrets / Variables を登録します。
4. Firebase のルールとインデックスをデプロイします（第 6 節）。
5. `.github/workflows/stock-news-scheduler.yml` が 10 分ごとに動き始めます。
   すぐ試したい場合は「Actions → 銘柄ニュースの定期取得 → Run workflow」で手動実行できます。

---

## 8. 検証

```bash
# 共通処理（日付計算・重複排除・関連性判定・レポート生成・HTML）— 外部APIを呼ばない
npm run stock-news:test          # リポジトリルート

# 端末内データ処理（購読・レポートの冪等性・データ移行）— fake-indexeddb で実コードを実行
cd pdf-manager && npm run test:stock

# 型チェックと本番ビルド
cd pdf-manager && npm run typecheck && npm run build
```

これらは `.github/workflows/pdf-manager-ci.yml` でも自動実行されます。

---

## 9. 既存データの移行

アプリを開いたときに 1 回だけ実行されます（`src/lib/stock/migrate.ts`）。

1. `投資_IQ_YYYYMMDD.pdf`（旧 IONQ レポート）と `TICKER_日次レポート_YYYYMMDD.pdf` を探し、
   対応する銘柄フォルダー（無ければ作成）へ移動します。
2. それらをレポート一覧へ登録します（内訳データが無いものは「アプリ更新前に作成されたレポート」として表示）。
3. 見つかった銘柄の購読設定を作成します（既定：毎日 8:00 / Asia/Tokyo / 日本語 / 標準 / 有効）。
4. 株式と関係のないフォルダーとルート直下の PDF を **「旧PDFアーカイブ」の配下へ移動**します。
5. 移行の前後で PDF の件数が一致するかを確認し、一致しない場合は画面に警告を出します。

**削除は一切行いません。** 移動と登録だけです。

### バックアップ方法（移行前に取りたい場合）

アプリの「設定 → バックアップ」から ZIP を書き出せます（`src/lib/backup.ts`）。
移行に不安がある場合は、更新前にこの手順でバックアップを取得してください。

---

## 10. IONQ の扱い

- 生成処理は共通化され、`scripts/ionq-report/generate.mjs` は共通処理を呼ぶだけになりました。
  公開フォルダー（`pdf-manager/public/ionq`）へ出力する形式・ファイル名・`index.json` は変更していません。
- `.github/workflows/ionq-report.yml` は **定期実行を停止**し、手動実行（workflow_dispatch）のみ残しています。
  同じ日のレポートが二重に作られるのを防ぐためで、IONQ も他の銘柄と同じ
  `stock-news-scheduler.yml` で処理されます。
- すでに公開済みの PDF は `IonqReportImporter` が「IONQ」フォルダーへ取り込みます（既存データは失われません）。

---

## 11. セキュリティ

- ニュース API キー（Gemini / Alpha Vantage）はサーバー側だけで使用し、応答にも含めません。
- 例外メッセージとログからは `key=` を伏せ字にしています。
- Firestore / Storage のルールで、他ユーザーの購読・レポート・PDF は読めません。
- ティッカーは `core/tickers.mjs` の正規表現で検証し、不正な値は保存しません。
- URL は `http` / `https` のみを保存・表示します（`canonicalUrl`）。
- 外部記事の HTML は保存も表示もしません。要約テキストだけを扱い、PDF 生成時は必ずエスケープします。

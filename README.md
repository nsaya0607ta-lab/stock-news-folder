# 株式ニュースフォルダー

追跡したい株式銘柄を登録すると、銘柄ごとのニュースを整理した日次レポートを作成し、フォルダーへ保存するスマートフォン向けPWAです。

## 主な機能

- 銘柄の追加・検索・有効／停止・取得時刻設定
- 銘柄別フォルダーと日次ニュースレポート
- ニュースの重複排除、カテゴリー、重要度、感情判定
- 今日のニュース、横断検索、実行履歴、通知履歴
- 保存済みニュースへのAI質問
- PDFの追加、移動、コピー、名前変更、削除、タグ、メモ
- PDFビューアー、画像からPDF作成、バックアップ／復元
- IndexedDBによる端末内保存、Firebaseによる本人専用クラウド連携
- オフライン起動、ダークモード、iPhoneセーフエリア対応

## リポジトリ構成

このリポジトリは独立したNext.jsプロジェクトです。`my-app`配下のサブディレクトリではありません。

```text
stock-news-folder/
├── src/                         Next.jsアプリ・画面・ドメイン処理
├── public/                      PWA・Service Worker・公開レポート
├── scripts/
│   ├── stock-news/              銘柄ニュースの取得・PDF生成・定期処理
│   ├── ionq-report/             IONQ公開レポート互換処理
│   └── prepare-assets.mjs       アイコン・スプラッシュ等の生成
├── firebase/                    Firestore／Storage関連設定
├── docs/                        構成・設定・運用資料
├── .github/workflows/
│   ├── ci.yml                   テスト・型チェック・本番ビルド
│   └── stock-news-scheduler.yml 定期取得
├── package.json
├── next.config.mjs
├── vercel.json
└── README.md
```

## ローカル起動

Node.js 24.xを使用します。

```bash
git clone https://github.com/nsaya0607ta-lab/stock-news-folder.git
cd stock-news-folder
npm ci
npm run dev
```

ブラウザーで `http://localhost:3000` を開きます。

## 検証

```bash
npm run stock-news:test
npm run test:stock
npm run typecheck
npm run build
```

## GitHub Actionsに必要な設定

### Secrets

- `GEMINI_API_KEY`
- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `ALPHA_VANTAGE_API_KEY`（株価を取得する場合）

### Variables

- `FIREBASE_STORAGE_BUCKET`
- `GEMINI_MODEL`（任意）

Secretsの移行が完了するまでは、`.github/workflows/stock-news-scheduler.yml`を手動実行のみにしています。設定後に10分間隔の` schedule `を有効化してください。

## Vercel

既存のVercelプロジェクト`stock-news-folder`と本番ドメインを継続利用します。

```text
https://stock-news-folder.vercel.app
```

VercelのRoot Directoryはリポジトリ直下です。サブディレクトリ指定は不要です。

## データ移行方針

- 本番ドメインを維持することで、同一オリジンのIndexedDBとPWAデータを維持します。
- 同じFirebaseプロジェクト、Firestoreパス、Cloud Storageパスを継続利用します。
- 新リポジトリ側の定期処理を有効化してから、旧`my-app`側の定期処理を停止します。
- 移行完了まで旧コードは削除しません。

詳細は[`docs/stock-news.md`](docs/stock-news.md)と[`MIGRATION.md`](MIGRATION.md)を参照してください。

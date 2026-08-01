# Geminiチャット・自動PDFの設定

この機能は、日付別チャットをFirestoreへ保存し、Gemini APIをVercelのサーバー経由で呼び出します。自動PDFはGitHub Actionsが10分ごとに作成時刻を確認して生成します。

## 1. Firestoreを有効化

Firebase Consoleで **Firestore Database → データベースを作成** を実行します。リージョンは現在のFirebase Storageと近い場所を選びます。

`firebase/gemini.firestore.rules` の内容をFirestoreのルールへ反映してください。既存ルールがある場合は、`match /users/{userId}/...` の各ブロックを既存の `match /databases/{database}/documents` 内へ追加します。

自動生成PDFの後片付けには複合インデックスが必要です。`firebase/firestore.indexes.json` をFirebase CLIで反映するか、同じ内容をFirebase Consoleのインデックス画面から作成してください。

```bash
firebase deploy --only firestore:indexes
```

## 2. Storageルールを反映

`firebase/pdf-cloud-storage.storage.rules` の内容をFirebase Consoleの **Storage → Rules** へ反映します。

追加される領域:

- `users/{uid}/gemini-temp/`：チャットへ添付したPDF・画像の一時保存
- `users/{uid}/gemini-generated/`：ブラウザーを閉じている間に作成されたPDF

## 3. Vercel環境変数

Vercelの `my-app-gllz` プロジェクトへ次を設定し、PreviewとProductionを再デプロイします。

| Key | 内容 |
|---|---|
| `GEMINI_API_KEY` | Google AI Studioで作成したGemini APIキー |
| `GEMINI_MODEL` | `gemini-3.6-flash` |
| `FIREBASE_WEB_API_KEY` | 任意。FirebaseウェブAPIキー。未設定時はアプリ内の公開設定を使用 |

Gemini APIキーはブラウザーへ公開されず、Vercel Functionsだけで使用されます。

## 4. GitHub ActionsのSecretsとVariables

GitHubリポジトリの **Settings → Secrets and variables → Actions** へ設定します。

### Secrets

| Name | 内容 |
|---|---|
| `GEMINI_API_KEY` | Vercelと同じGemini APIキー |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | FirebaseサービスアカウントJSON全文 |

### Variables

| Name | 内容 |
|---|---|
| `GEMINI_MODEL` | `gemini-3.6-flash` |
| `FIREBASE_STORAGE_BUCKET` | `my-az900-app.firebasestorage.app` |

サービスアカウントJSONは、Firebase Consoleの **プロジェクトの設定 → サービス アカウント → 新しい秘密鍵を生成** から取得します。JSONはGitHub Secrets以外へ保存しないでください。

## 5. 5日後の自動削除

チャット文書とメッセージには `expiresAt` が保存されます。アプリ起動時とGitHub Actionsの定期処理で、期限切れチャット・メッセージ・添付ファイルを削除します。

FirestoreのTTLも補助的に設定できます。

- Collection group：`geminiChats` / Field：`expiresAt`
- Collection group：`messages` / Field：`expiresAt`

TTLだけではサブコレクションやStorageファイルを削除できないため、GitHub Actionsの削除処理は残してください。

## 6. 動作確認

1. アプリでFirebaseクラウド保管へログイン
2. 右下のGeminiボタンを開く
3. 質問を送信し、ストリーミング回答を確認
4. PDF作成からプレビューし、保存先フォルダーへ保存
5. Gemini設定で、自動PDFルールを現在時刻の10〜20分後に設定
6. GitHub Actionsの `Gemini自動PDF作成` を確認
7. アプリを開き、自動生成PDFが指定フォルダーへ取り込まれることを確認

## 制限

- チャット画面に表示できるのは当日を含む直近5日
- 添付は1件15MB、1回6件まで
- チャット送信は直近50メッセージ、合計約12万文字まで
- 自動PDFの実行時刻にはGitHub Actionsの混雑による数分程度の遅れが発生する場合があります

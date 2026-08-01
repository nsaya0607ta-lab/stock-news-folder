# クラウド保管に必要な Firebase 側の設定

このフォルダーのファイルは **アプリからは読み込まれません**。Firebase コンソール / CLI で
手作業で適用してもらうための「設定内容の control 用コピー」です。

> **課金についての注意**
> このリポジトリのコードは、Firebase の課金プランやバケットの有効化を一切変更しません。
> 下の設定は必ず本人の判断で行ってください。**Cloud Storage for Firebase は
> 従量課金（Blaze）プランの有効化を求められる場合があります。**
> 詳しくは末尾「料金について」を参照してください。

## 1. Authentication（メール／パスワード）

1. Firebase コンソール → **Authentication** → **Sign-in method**
2. **メール／パスワード** を有効にする

アプリはこの認証だけを使います。管理者用の秘密鍵（サービスアカウント JSON）は
ブラウザーへ一切持ち込みません。ブラウザーに入っているのは公開用のウェブ設定
（apiKey など）だけで、これは秘密情報ではありません。実際のアクセス制御は
下のセキュリティルールが行います。

## 2. Cloud Storage を有効にする

1. Firebase コンソール → **Storage** → **始める**
2. バケット（既定では `my-az900-app.firebasestorage.app`）を作成する

## 3. セキュリティルール（必須）

`pdf-cloud-storage.storage.rules` の内容を **Storage → Rules** に貼り付けて公開します。
すでに別のルールを使っている場合は、`match /users/{userId}/pdf-cloud/{fileName}` の
ブロックだけを既存の `match /b/{bucket}/o` の中へ追加してください。

このルールが行うこと:

- `users/<自分のUID>/pdf-cloud/` の下だけ読み書き・削除できる
- 他人の UID 配下へは一切アクセスできない（一覧も不可）
- `application/pdf` 以外、200MB 以上のファイルは書き込めない
- 未ログインのアクセスはすべて拒否される（推測可能な公開 URL では読めない）

CLI から適用する場合:

```bash
firebase deploy --only storage
# firebase.json の storage.rules にこのファイルを指定しておく
```

## 4. CORS（必須）

PDF 本体をブラウザーで取得して IndexedDB へ保存するため、バケットに CORS 設定が必要です。
`pdf-cloud-storage.cors.json` の `origin` は公開ドメイン（`https://my-app-gllz.vercel.app`）に合わせてあります。
独自ドメインを足したときは、この配列へ追記してから再適用してください。

```bash
# Google Cloud SDK が必要
gcloud storage buckets update gs://my-az900-app.firebasestorage.app \
  --cors-file=pdf-cloud-storage.cors.json

# 旧 gsutil の場合
gsutil cors set pdf-cloud-storage.cors.json gs://my-az900-app.firebasestorage.app
```

CORS を設定しないと、クラウド保管済み PDF を開くときに
「クラウドからPDFを取得できませんでした」というエラーになります。
**アップロードは Firebase SDK が行うため CORS 無しでも成功しますが、その場合でも
端末内の PDF は削除されません**（取得の確認が取れるまで削除しない設計のため）。

## 5. 動作確認

1. アプリの設定画面 →「クラウド保管」を ON
2. メールアドレスとパスワードでログイン（初回は「新規登録」）
3. 「今すぐ対象ファイルをクラウドへ移動」を実行
4. Firebase コンソール → Storage で `users/<UID>/pdf-cloud/` に PDF が並ぶことを確認
5. アプリの一覧でクラウドアイコンが付き、タップすると開けることを確認

## 料金について

- **Cloud Storage for Firebase の有効化には、従量課金（Blaze）プランへの変更を
  求められる場合があります。** このリポジトリのコードはプラン変更を行いません。
  必要な場合は Firebase コンソールに表示される案内に従って、本人が判断してください。
- Blaze プランでも毎月の無料枠があります（目安：保存 5GB、ダウンロード 1GB/日、
  アップロード操作 20,000 回/日、ダウンロード操作 50,000 回/日）。
  個人が数百 MB の PDF を置く使い方であれば、通常は無料枠の範囲に収まります。
- 無料枠を超えた分は保存量・転送量・操作回数に応じた従量課金になります。
  最新の金額は <https://firebase.google.com/pricing> を確認してください。
- 予期しない請求を避けたい場合は、Google Cloud の **予算アラート** を設定してください。
- アプリ側は「同じファイルを何度もアップロードしない」「一度取得した PDF は端末内へ
  キャッシュして再ダウンロードしない」設計のため、転送量は最小限に抑えられます。

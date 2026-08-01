# my-app からの切り離し

このリポジトリは `nsaya0607ta-lab/my-app` の `pdf-manager/` と、株式ニュースの定期処理を独立リポジトリ向けに再構成したものです。

## データを維持する条件

- Vercelでは既存の `stock-news-folder` プロジェクトを継続利用する
- 本番ドメイン `https://stock-news-folder.vercel.app` を変更しない
- 同じFirebaseプロジェクトと同じコレクション・Storageパスを利用する
- 新リポジトリ側の定期処理を有効化後、旧リポジトリ側を停止する

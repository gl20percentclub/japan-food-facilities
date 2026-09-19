# gh-pages → 新ドメイン リダイレクト（有効化済み）

公開サイトは `https://gl20percentclub.github.io/japan-food-facilities/`（GitHub Pages）から
`https://food.japan-facilities.com/`（新ドメイン、S3 + CloudFront）へ移行済みです。
このディレクトリには gh-pages 側で配信するリダイレクトページのスタブが入っています。

新ドメインでのサイト配信（`deploy-s3.yml`）は開始済み・動作確認済みで、gh-pages 側の
リダイレクトも `.github/workflows/pages.yml` から有効化されています。

## なぜ `site/` に直接書き込まないか

`site/` は `.github/workflows/deploy-s3.yml` が `main` への push でそのまま新ドメイン
（S3 + CloudFront）へ同期する配信元でもあります（`aws s3 sync site/ ...`）。

ここに新ドメインへの `<meta http-equiv="refresh">` を書いたページを置いてしまうと、
新ドメイン自身のページがリダイレクトに置き換わり、**「新ドメイン → 新ドメイン」の
無限リダイレクト**になります。これが最大の事故シナリオです。

そのため `site/` はリダイレクト有効化後も書き換えず、`.github/workflows/pages.yml` が
デプロイのたびに `site/` を一時ディレクトリ（`gh-pages-dist/`、Git 管理対象外）へ
コピーし、**そのコピーだけ**をこのディレクトリの内容で上書きしてから gh-pages へ
配信しています。`site/` 自体は常に本来のページのまま残るため、`deploy-s3.yml` に
リダイレクト内容が混ざる経路は構造的にありません。詳細は `pages.yml` のコメントと
`scripts/redirect-stubs.test.js`（実際にビルド手順を実行して分離を検証している）を参照。

## 対象にしたページ・対象にしていないページ

| ファイル | 対象 | 理由 |
| --- | --- | --- |
| `index.html` | ○ | 手書きの HTML。このリポジトリで編集できる |
| `map.html` | ○ | 同上 |
| `playground.html` | ○ | 同上。新ドメインの `map.html` へ直接飛ばす（旧サイト内の再リダイレクトを経由しない） |
| `coord-quality.html` | ○ | 同上 |
| `privacy.html` | ○ | 同上 |
| `404.html` | ○ | 旧サイトの任意のパスから新ドメインへ誘導する |
| `sitemap.xml` | ○ | 手書きの HTML ではないが手動管理のファイルなのでここに置ける |
| `attribution.html` | ✗ | private リポジトリ（japan-facilities-crawler）の週次クローラーが生成して push する成果物。このリポジトリでは手編集しない方針のため、ここにも置いていない。gh-pages では `site/attribution.html` の内容がそのまま配信される |
| `llms.txt` / `llms-full.txt` | ✗ | 同上。加えてプレーンテキストなので `<meta http-equiv="refresh">` 自体が効かない（HTML として解釈されない） |
| `analytics.js` / `_headers` | ✗ | `site/` の内容がそのまま通る（リダイレクトページ自身が `analytics.js` を読み込むため必要） |

`attribution.html` / `llms.txt` / `llms-full.txt` を新ドメインへ誘導したい場合は、
private リポジトリ側の生成テンプレートを変更する必要がある（このリポジトリの担当範囲外）。

## 各ページの方式

- `<meta http-equiv="refresh" content="0; url=...">` … JS 無効でも遷移する
- `<link rel="canonical" href="...">` … 検索エンジンに新ドメインを正規 URL と伝える
- `<meta name="robots" content="noindex">` … 旧 URL 自体はインデックスさせない
- 自動で遷移しない場合のための、新URLへの可視リンク
- `analytics.js` の読み込みと `privacy.html` へのリンク（`playground.html` の既存踏襲）

`404.html` だけは対象パスが固定できないため、JavaScript で
`location.pathname + location.search` を新ドメインに付け替えて `location.replace()` する。
JS が無効な場合のフォールバックとして `<noscript>` 内に新ドメインのトップページへの
`<meta http-equiv="refresh">` と可視リンクを入れている（パスは保持できず、トップへ飛ぶ）。

## ページを追加・変更するとき

このディレクトリのファイルを変更したら `.github/workflows/pages.yml` が
`redirect-stubs/**` の変更を検知して自動で gh-pages へ再配信する
（`site/**` とは独立して、このディレクトリの変更だけでも配信が走る）。

`npm run test:unit`（`scripts/redirect-stubs.test.js` を含む）を通してから push すること。
push 後は `curl -s https://gl20percentclub.github.io/japan-food-facilities/ | grep refresh` 等で
実際に配信された内容を確認する（このリポジトリの検証原則: 編集したファイルを読み返すのではなく、
配信されているものを直接確認する）。

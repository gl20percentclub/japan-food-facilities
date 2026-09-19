# アクセス解析（GA4）と Search Console

公開サイト <https://gl20percentclub.github.io/japan-food-facilities/> の
アクセス解析まわりの構成と、**プレースホルダの差し替え手順**をまとめる。

## 構成

| ファイル | 役割 |
| --- | --- |
| `site/analytics.js` | GA4 の測定タグ。測定IDと発火条件をここ 1 か所に集約している |
| `site/privacy.html` | 外部送信の公表ページ（電気通信事業法 第27条の12） |
| `site/sitemap.xml` | Search Console に登録するサイトマップ |
| `scripts/site-analytics.test.js` | 上記の構成を固定するユニットテスト |

計測タグを入れているページ:
`index.html` / `map.html` / `playground.html` / `coord-quality.html` / `privacy.html`。

`attribution.html` には入れていない（出典表示を確認するためのページで、閲覧状況を知る
必要が薄いため）。入れる場合は生成物ではなく、生成元である private リポジトリ
（japan-facilities-crawler）の `scripts/generate/attribution.js` を編集する
（このリポジトリにはコピーを持たない）。

## 差し替えが必要なプレースホルダ

現時点では GA4 プロパティも Search Console のプロパティも作っていないため、
次の 2 つがプレースホルダのまま入っている。**どちらも差し替えるまでは無害**
（測定タグは発火せず、確認用 meta タグは Search Console 側が照合しなければ意味を持たない）。

| プレースホルダ | 場所 | 差し替える値 |
| --- | --- | --- |
| `G-XXXXXXXXXX` | `site/analytics.js` の `MEASUREMENT_ID` | GA4 の測定ID |
| `GOOGLE_SITE_VERIFICATION_TOKEN` | `site/index.html` の `google-site-verification` meta タグ | Search Console が発行する確認用トークン |

### 1. GA4 の測定IDを入れる

1. [Google アナリティクス](https://analytics.google.com/) でプロパティとウェブ
   データストリーム（URL は `https://gl20percentclub.github.io/japan-food-facilities/`）
   を作成し、`G-` で始まる測定IDを取得する。
2. `site/analytics.js` の次の行だけを書き換える。

   ```js
   var MEASUREMENT_ID = 'G-XXXXXXXXXX';
   ```

   `PLACEHOLDER_ID` の行は**変更しない**（差し替え前の値を判別するための定数）。
3. `npm run test:unit` を実行する。`site-analytics.test.js` は測定IDを
   ファイルから読むため、差し替えてもテストの書き換えは要らない
   （差し替え後は「gtag.js を読み込む」側の検査に切り替わる）。
4. main へ push すると `pages.yml` が `site/**` の変更を拾って配信する。
5. 配信後、GA4 のリアルタイムレポートにアクセスが出ることを確認する。

### 2. Search Console の所有権確認

**HTML ファイル方式は使わない。** `pages.yml` は `keep_files: true` で配信して
おり、gh-pages 上のファイル削除が反映されない。確認ファイルを置くと後から消せない
ゴミとして残り続けるため、**meta タグ方式**を使う。

1. [Search Console](https://search.google.com/search-console) で
   **URL プレフィックス** プロパティとして
   `https://gl20percentclub.github.io/japan-food-facilities/` を追加する。
2. 所有権の確認方法で「HTML タグ」を選び、表示された
   `<meta name="google-site-verification" content="...">` の `content` の値をコピーする。
3. `site/index.html` の次の meta タグの `content` を差し替える。

   ```html
   <meta name="google-site-verification" content="GOOGLE_SITE_VERIFICATION_TOKEN">
   ```

4. main へ push して配信されたあと、Search Console で「確認」を押す。
5. 確認後も meta タグは**消さない**（消すと所有権が失効する）。

### 3. サイトマップの登録

配信後、Search Console の「サイトマップ」から
`https://gl20percentclub.github.io/japan-food-facilities/sitemap.xml` を送信する。

`robots.txt` は置いていない。このサイトは `gl20percentclub.github.io` の
サブパスで配信されており、`robots.txt` はドメイン直下しか参照されないため、
`site/robots.txt` を置いても読まれない。サイトマップは Search Console から直接送信する。

**ページを追加・削除したら `site/sitemap.xml` も更新すること。**
`scripts/site-analytics.test.js` が `site/*.html` との網羅性を検査しているので、
書き忘れるとユニットテストが落ちる（`noindex` のページは対象外）。

## 測定IDの管理方針

**GA4 の測定IDはリポジトリに直書きする。** このリポジトリは public なので、
測定IDは公開される。これは意図した状態であり、漏洩ではない。

- 測定IDは「どの GA4 プロパティへ計測ヒットを送るか」を示す**送信先の識別子**であり、
  これ単体でレポートを閲覧したりデータを読み出したりはできない
  （閲覧には Google アカウントの権限が必要）。
- そもそも測定タグはブラウザで実行されるため、測定IDは閲覧者の開発者ツールから
  誰でも見える。隠す意味がない。
- 秘密にすべきなのは GA4 の**アカウント権限**と API 資格情報のほうで、
  それらはこのリポジトリには入れない。

Search Console の確認用トークンも同様に、公開されても第三者が所有権を取れる性質のものではない。

## 計測対象を減らしたい場合

ページ単位で外したいときは、そのページの次の行を削除する。

```html
<script src="./analytics.js"></script>
```

あわせて `scripts/site-analytics.test.js` の `ANALYTICS_PAGES` からも
そのページ名を外す（残っているとテストが落ちる）。
外したページからプライバシーページへのリンクは残してよい。

計測そのものをやめる場合は `site/analytics.js` を削除し、各ページの script タグと
`scripts/site-analytics.test.js` を消す。ただし `pages.yml` は `keep_files: true`
なので、**gh-pages 上の `analytics.js` は手で消す必要がある**。

## プライバシー（外部送信規律）

日本の電気通信事業法の外部送信規律（第27条の12）は、利用者の端末から外部へ情報を
送信させる場合に「**通知・公表・同意取得・オプトアウトの提供**」の**いずれか**を求める。
同意バナーは必須ではない。

当サイトは **`site/privacy.html` による公表**で対応している。
`site/analytics.js` を変更して**送信する情報が変わる場合は、`site/privacy.html` の
記載も必ず合わせて更新すること**。公表の内容と実装が食い違うと、公表した意味がなくなる。

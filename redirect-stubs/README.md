# gh-pages → 新ドメイン リダイレクトの準備（未有効化）

公開サイトを `https://gl20percentclub.github.io/japan-food-facilities/`（GitHub Pages）から
`https://food.japan-facilities.com/`（新ドメイン）へ移行するための各ページのスタブを、
**まだ配信していない状態**で置いてあるディレクトリです。

## なぜ `site/` に直接置かないか

`site/` の中身は `.github/workflows/pages.yml` が `main` への push でそのまま gh-pages へ配信します
（`paths: site/**`）。ここに新ドメインへの `<meta http-equiv="refresh">` を書いたページを置くと、
push した瞬間に利用者が新ドメインへ飛ばされます。

**現時点（このディレクトリを作った時点）では新ドメインはまだサイトを配信していません**
（`https://food.japan-facilities.com/` は HTTP 403 を返す。配信しているのは `/api/*` だけ）。
この状態でリダイレクトを有効にすると、利用者が 403 に飛ばされます。

そのため、スタブは `site/` の外（このディレクトリ）に置き、`pages.yml` の配信対象（`site/**`）に
含めないことで「用意はするが配信はしない」を実現しています。

## 対象にしたページ・対象にしていないページ

| ファイル | 対象 | 理由 |
| --- | --- | --- |
| `index.html` | ○ | 手書きの HTML。このリポジトリで編集できる |
| `map.html` | ○ | 同上 |
| `playground.html` | ○ | 同上。新ドメインの `map.html` へ直接飛ばす（旧サイト内の再リダイレクトを経由しない） |
| `coord-quality.html` | ○ | 同上 |
| `privacy.html` | ○ | 同上 |
| `404.html` | ○ | 新規追加。旧サイトの任意のパスから新ドメインへ誘導する |
| `sitemap.xml` | ○ | 手書きの HTML ではないが手動管理のファイルなのでここに置ける |
| `attribution.html` | ✗ | private リポジトリ（japan-facilities-crawler）の週次クローラーが生成して push する成果物。このリポジトリでは手編集しない方針のため、ここにも置いていない |
| `llms.txt` / `llms-full.txt` | ✗ | 同上。加えてプレーンテキストなので `<meta http-equiv="refresh">` 自体が効かない（HTML として解釈されない）。テキストの中身を新ドメイン向けに書き換えるだけでも、生成元は private リポジトリ側にあるため、このリポジトリからは対応できない |

`attribution.html` / `llms.txt` / `llms-full.txt` のリダイレクトは、private リポジトリ側の
生成テンプレートを変更する必要がある（このリポジトリの担当範囲外）。

## 各ページの方式

`site/playground.html`（`map.html` へ統合されたときに作った同種のリダイレクトページ）と
同じ方式を踏襲しています。

- `<meta http-equiv="refresh" content="0; url=...">` … JS 無効でも遷移する
- `<link rel="canonical" href="...">` … 検索エンジンに新ドメインを正規 URL と伝える
- `<meta name="robots" content="noindex">` … 旧 URL 自体はインデックスさせない
- 自動で遷移しない場合のための、新URLへの可視リンク
- `analytics.js` の読み込みと `privacy.html` へのリンク（`playground.html` の既存踏襲）

`404.html` だけは対象パスが固定できないため、JavaScript で
`location.pathname + location.search` を新ドメインに付け替えて `location.replace()` する。
JS が無効な場合のフォールバックとして `<noscript>` 内に新ドメインのトップページへの
`<meta http-equiv="refresh">` と可視リンクを入れている（パスは保持できず、トップへ飛ぶ）。

## 有効化の手順（新ドメインでの配信開始・動作確認が終わってから）

**前提: 以下がすべて満たされてから実施すること。**

1. `https://food.japan-facilities.com/` `/map.html` `/coord-quality.html` `/privacy.html` が
   200 で期待するページを返す（`curl -sI` で確認）
2. 新ドメインの `/api/*` は現行どおり配信され続けている（データ配信を壊していない）
3. 出典・ライセンス一覧（`attribution.html`）・`llms.txt` / `llms-full.txt` の新ドメインでの
   扱いが決まっている（別担当・別 PR の範囲）

満たされたら:

```bash
# 1. スタブを site/ へコピー（上書き）
cp redirect-stubs/index.html redirect-stubs/map.html redirect-stubs/playground.html \
   redirect-stubs/coord-quality.html redirect-stubs/privacy.html redirect-stubs/404.html \
   site/
cp redirect-stubs/sitemap.xml site/sitemap.xml

# 2. このディレクトリ自体は不要になるので削除してよい
git rm -r redirect-stubs

# 3. 既存テストの前提が変わるので確認・修正する
#    - scripts/site-analytics.test.js の BASE_URL・privacy.html が noindex でないことを
#      求めるアサーション・サイトマップ網羅性チェックは、gh-pages がリダイレクトだけの
#      サイトになる前提に合わせて更新が必要
#    - scripts/map-filter.test.js が map.html の中身に依存していないか確認
npm run test:unit

# 4. コミットして main へ push（pages.yml が site/** の変更を検知して gh-pages へ配信する）
```

push 後、`curl -s https://gl20percentclub.github.io/japan-food-facilities/ | grep refresh` 等で
実際に配信された内容を確認すること（このリポジトリの検証原則: 編集したファイルを読み返すのではなく、
配信されているものを直接確認する）。

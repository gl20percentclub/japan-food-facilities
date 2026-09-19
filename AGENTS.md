# AGENTS.md

AI コーディングエージェント（Claude Code / Codex 等）向けのガイド。
このリポジトリは、全国の食品営業許可・届出データを収集・正規化し、
**全件CSV**・**都道府県別CSV**・**ベクトルタイル** の3形式で配信するオープンデータプロジェクト。
現在は無償で提供しているが、提供条件は予告なく変更しうる（継続的な提供は有償サポートで対応）。
サイト・README・llms.txt で「無料」「登録不要」「レート制限なし」といった無条件の提供を約束しない。
静的ページは GitHub Pages、データ（`api/`）は S3 + CloudFront（独自ドメイン
`food.japan-facilities.com`）から配信する。

**クロール処理（取得・正規化・配信物の生成）は private リポジトリ
[japan-facilities-crawler](https://github.com/gl20percentclub/japan-facilities-crawler) が持つ。**
このリポジトリ（公開）が持つのは公開サイト（`site/`）とデータの窓口（README・ドキュメント）だけで、
`scripts/crawl.js` やデータソース定義 `config/sources.yaml` はこのリポジトリには無い
（自治体・省庁ごとの取得パターンが競争優位性のため非公開化した。詳細は「クロール処理の所有権」を参照）。

## このデータでアプリを作る場合

**まず https://gl20percentclub.github.io/japan-food-facilities/llms-full.txt を読むこと。**
データ仕様・コピペで動く利用例・注意事項がすべてまとまっている。要点だけ挙げる:

- 全件CSV: `https://food.japan-facilities.com/api/facilities-all.csv`
  - UTF-8 **BOMなし**、100万件超・数百MB（gzip 版は配信していない）。
    正確な件数・サイズは README の統計ブロック（自動生成）を参照する
  - 列: `prefecture, city, city_raw, name, name_kana, business_type, address, lat, lng, geocoding_level, phone, license_no, license_date, expire_date, sources, licenses`
- 都道府県別CSV: `https://food.japan-facilities.com/api/prefectures/{都道府県コード2桁}.csv`
  - 例 `13.csv`（東京都）/ `01.csv`（北海道）。47都道府県すべて存在し、列・内容は全件CSV と同じ。
    ファイル一覧と件数は `api/prefectures/index.json`。1県だけ必要ならこちらを使う
- ベクトルタイル（MVT）: `https://food.japan-facilities.com/api/tiles/{z}/{x}/{y}.pbf`
  - レイヤ名 `facilities`、z3–12、属性 `name` / `business_type` / `pref` / `city`
- 市区町村別 CSV/JSON や検索 API は**このリポジトリからは配信していない**。データ抽出は
  CSV（DuckDB 推奨）、地図表示はタイルを使う。ブラウザから非圧縮 CSV を直接 fetch しない
- `map.html` は統計表示と業種フィルターだけの最小構成のプレビュー地図。業種の分類は
  食品衛生法の定義（営業許可32業種＋営業届出の業種＋2021年改正前の旧法業種）に沿った
  `CATEGORY_GROUPS` が単一の情報源で、タイルの `business_type` にキーワード部分一致を
  かける（表記が自治体ごとにゆれるため完全一致では拾えない。業種欄が無い自治体もあるので
  「業種の記載なし」を別枠にしている）。検索機能は持たない（検索 API は未公開）。
  旧 `playground.html` は `map.html` へのリダイレクトだけを残した薄いページ
- 商用・非商用を問わず利用可だが出典表示が必要。ライセンスは元データの提供元ごとに異なる
  （単一ライセンスではないので「CC BY 4.0」と一括で書かない）。出典表示:
  「出典：Japan Food Facilities（各自治体・厚生労働省が公開する食品営業許可オープンデータを加工して作成）」
  ＋ 出典・ライセンス一覧 `https://gl20percentclub.github.io/japan-food-facilities/attribution.html`
  地図（ベクトルタイル）では source の `attribution` に指定する

## 開発コマンド

```bash
npm ci                  # 依存関係のインストール
npm test                # 全テスト（= npm run test:unit。PR 前に必ず通すこと）
npm run test:unit       # site/ の整合性テストと配信ワークフロー設定の検証
```

クロール（取得・正規化・配信物生成）はこのリポジトリでは実行できない。private リポジトリ
[japan-facilities-crawler](https://github.com/gl20percentclub/japan-facilities-crawler) 側で行う。

## リポジトリ構成

```
site/                   # gh-pages に配信する静的サイト（ここの中身がそのまま公開される）
site/index.html         # LP
site/map.html           # プレビュー地図
site/playground.html    # map.html へのリダイレクトだけの薄いページ
site/attribution.html   # 出典表示ページ。private リポジトリが生成して push する成果物。直接編集しない
site/llms.txt           # AI向けドキュメント。同上（直接編集しない）
site/llms-full.txt      # 同上
scripts/map-filter.test.js   # map.html の業種フィルターの整合性テスト
scripts/workflows.test.js    # 配信ワークフロー（pages.yml 等）の設定テスト
docs/COVERAGE.md        # 自治体ごとの収録状況（private リポジトリが生成して push する）
api/                    # 配信物。このリポジトリには存在しない（S3 + CloudFront から配信）
```

## 規約と注意点

- コード・コメントは日本語。すべての関数に doc コメント、非自明なロジックにインラインコメントを書く
- テストは実装と同じディレクトリに `*.test.js` として自前 assert で書き、`package.json` の `test:unit` チェーンに追加する
- 整形・生成ロジックは純粋関数として export し、テストは固定入力で検証する（既存テストの流儀に従う）
- `site/attribution.html` / `site/llms.txt` / `site/llms-full.txt` は private リポジトリ
  （japan-facilities-crawler）が生成して push する成果物。**このリポジトリでは生成できない
  （生成元・生成スクリプトが無い）ので直接編集しない。** 内容を変えたいときは private リポジトリ側
  （生成元・生成スクリプト）を変更する
- 配信ワークフローの設定は `scripts/workflows.test.js` で固定されている。
  `pages.yml` / `ci.yml` を変更したらこのテストも必ず確認する

## 配信の仕組み

- **データ（`api/`）は S3 + CloudFront で配信**する。ベース URL は
  `https://food.japan-facilities.com`（CORS 全オリジン許可済み）。
  クロールと S3 への配信は別リポジトリ
  [japan-facilities-crawler](https://github.com/gl20percentclub/japan-facilities-crawler)
  の Fargate タスクが毎週月曜 18:00 UTC に実行する。このリポジトリでは `api/` を生成も
  管理もしない（結合CSV は 430MB あり、GitHub の 100MB 制限で Git 配信できないため）
- `pages.yml`: 静的ページ（LP・地図・出典・llms.txt）の変更を main への push で
  gh-pages へ反映する。**コミット済みの `site/` をそのまま配信する（配信前の再生成はしない）。**
  `site/attribution.html` / `llms.txt` / `llms-full.txt` は private リポジトリが生成して
  このリポジトリへ push した成果物であり、pages.yml はそれをそのまま配信するだけ
- gh-pages へ配信するワークフローは `pages.yml` **1本だけ**。gh-pages へデータを配信して
  いた旧 `crawl.yml` は廃止した（週次クロールは Fargate 側に一本化。復活していないことを
  `scripts/workflows.test.js` で固定している）。生成物の生成元とのドリフトを自己修復していた
  旧 `generated-docs.yml` も、生成元が private リポジトリへ移ったことで対象が無くなったため撤去した
  （復活していないことも `scripts/workflows.test.js` で固定している）
- 配信元は `site/` だけ（`publish_dir: site`）。`site/` の中身が gh-pages のルートに
  置かれるため、公開 URL は `/index.html`・`/map.html`・`/llms.txt` のまま。
  ページを追加するときは `site/` に置く（`pages.yml` の paths は `site/**` で一括）
- かつては `publish_dir: .` で、README・docs/・config/・package.json まで配信されていた。
  さらに `.gitignore` ごと配信されると配信先の `git add --all` で `api/` が無視され、
  gh-pages のデータが全消えする事故があった。`site/` には `.gitignore` も
  `node_modules` も無いため、この危険は構造的に消えている（workflows.test.js で固定）
- `pages.yml` は `keep_files: true` のためファイル削除が反映されない。ページを削除・リネーム
  したときは gh-pages 上の旧ファイルを手動で消す

## クロール処理の所有権（private リポジトリへ移行済み）

クロール用スクリプト（取得・正規化・配信物生成のロジック）とデータソース定義
`config/sources.yaml` は、どの自治体・省庁のどのページから、どんな正規表現でファイルを見つけ、
どう正規化しているかという取得ノウハウそのものであり、**競争優位性のため非公開化した**
（private リポジトリ `gl20percentclub/japan-facilities-crawler` の ADR 0001 で決定）。
このリポジトリには `scripts/crawl.js` / `scripts/lib/` / `scripts/build/` / `scripts/generate/` /
`scripts/tools/` / `scripts/validate-api.js` / `config/sources.yaml` は**存在しない**。
週次クロールは private リポジトリの Fargate タスクが実行し、結果を
S3 + CloudFront（データ）とこのリポジトリの `site/`・README（生成ドキュメント・統計）へ push する。

- `scripts/build/tiles.js`（ベクトルタイル生成）と、それに依存していた
  `scripts/preview-map.test.js`（`map.html` とタイル生成物の整合性テスト）はこのリポジトリには
  無い。tiles.js は private リポジトリ側にも同じものが存在するため、両リポに同一ファイルを
  置くと ADR の中心原則（コピーを持たないことで巻き戻りを構造的に起こせなくする）に反する。
  そのため tiles.js に依存する検証はこのリポジトリからは行わない
  （公開リポ側でこの整合性を検証する代替手段は未決。撤去した PR の本文を参照）
- `site/attribution.html` / `site/llms.txt` / `site/llms-full.txt` は生成元が private
  リポジトリへ移ったが、公開ページとしてはこのリポジトリの `site/` に置いたまま配信する
  （**コミット済みの成果物として扱う。直接編集しない**）
- README の STATS ブロックは private リポジトリの Fargate タスクが push する（変更なし）
- 過去の事故: クローラーが自リポジトリに持っていた古い `config/sources.yaml` の
  スナップショットから `attribution.html` を生成して main に push し、旧リポジトリ名と
  ライセンス未確定で除外したソースが公開ページに巻き戻った。この事故の再発を防ぐため、
  生成元は private リポジトリ1箇所に一本化されている（このリポジトリはコピーを持たない）
- 過去の事故: 2026-08-01、Fargate クローラーが push した STATS ブロックを、同日に走った
  旧 `crawl.yml`（GitHub Actions 上のクロール）が自分の結果で上書きし、README の件数が
  実際に配信しているデータより約14万件少ない状態になった。STATS を push してよいのは
  配信データを作った主体だけ。`crawl.yml` は廃止済みで、復活しないことを
  `scripts/workflows.test.js` で固定している

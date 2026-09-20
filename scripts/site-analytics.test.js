// 公開サイト（site/）の計測タグ・外部送信の公表ページ・サイトマップの構成を検証する。
//
//   node scripts/site-analytics.test.js
//
// ここで固定したいのは次の3点。
//
// 1. 計測タグを置く先を間違えない。
//    site/attribution.html・site/llms.txt・site/llms-full.txt は private リポジトリ
//    （japan-facilities-crawler）が生成してこのリポジトリへ push する成果物。生成物へ
//    計測タグを書いても次回の push で消えるので、書いてあること自体が事故の兆候になる。
//
// 2. 計測を入れたページからは必ず外部送信の公表ページ（privacy.html）へ辿れる。
//    電気通信事業法の外部送信規律（第27条の12）は「通知・公表・同意取得・オプトアウト
//    提供」のいずれかを求める。当サイトは privacy.html による公表で対応しているため、
//    そこへ辿れないページで計測するとこの前提が崩れる。
//
// 3. Search Console の所有権確認は meta タグ方式を使う。
//    pages.yml は keep_files: true で、gh-pages 上のファイル削除が反映されない。
//    HTML ファイル方式の確認ファイルを置くと、あとから消せないゴミとして残り続ける。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');

// 公開サイトの配信 URL の基点（pages.yml が site/ を gh-pages のルートへ出す）。
const BASE_URL = 'https://gl20percentclub.github.io/japan-food-facilities/';

// 計測タグ（analytics.js）を読み込むページ。生成物ではない素の HTML だけを対象にする。
const ANALYTICS_PAGES = ['index.html', 'map.html', 'playground.html', 'coord-quality.html', 'privacy.html'];

// 配信のたびに生成元から作り直されるファイル。ここに計測タグを書いても消える。
const GENERATED_FILES = ['attribution.html', 'llms.txt', 'llms-full.txt'];

// 生成物の中に現れてはいけない計測まわりの文字列。
const TRACKING_MARKERS = ['googletagmanager', 'gtag(', 'analytics.js', 'google-site-verification'];

let failures = 0;
/** 条件を検証して結果を出力する（失敗数を数える）。 */
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

/** site/ 配下のファイルを読む。 */
function readSite(name) {
  return fs.readFileSync(path.join(SITE, name), 'utf-8');
}

/** robots meta で noindex を指定しているページか（サイトマップに載せない対象）。 */
function isNoindex(html) {
  return /<meta\s+name="robots"\s+content="[^"]*noindex/i.test(html);
}

/**
 * analytics.js を最小の DOM スタブ上で実際に実行し、何をしたかを観測する。
 * 「プレースホルダのままなら送信しない」は挙動の話なので、文字列一致ではなく
 * 走らせて確かめる。window / document は引数で渡してグローバルを汚さない。
 *
 * @param {string} source analytics.js の中身
 * @returns {{ scripts: object[], window: object }} head へ足された要素と window の状態
 */
function runAnalytics(source) {
  const scripts = [];
  const document = {
    head: { appendChild: (el) => scripts.push(el) },
    createElement: () => ({}),
  };
  const window = {};
  // eslint-disable-next-line no-new-func -- 検証対象を隔離したスコープで動かすため
  new Function('window', 'document', source)(window, document);
  return { scripts, window };
}

console.log('公開サイトの計測・プライバシー構成テスト\n');

const analyticsJs = readSite('analytics.js');
const indexHtml = readSite('index.html');
const privacyHtml = readSite('privacy.html');
const sitemapXml = readSite('sitemap.xml');

// --- 測定タグの実装（analytics.js） ---
// 測定 ID をページごとにコピーせず 1 ファイルに集約しているので、差し替えも 1 か所で済む。
// 測定 ID は 1 か所（この定数）だけに書く。差し替え後もこのテストがそのまま通るよう、
// ハードコードせずファイルから現在の値を読む。
const ID_LINE = /var MEASUREMENT_ID = '([^']*)';/;
const currentId = analyticsJs.match(ID_LINE)?.[1];
assert(currentId !== undefined, 'analytics.js: 測定 ID の定数（MEASUREMENT_ID）がある');

// GA4 プロパティ発行後は実 ID を固定する。うっかりプレースホルダへ戻したり、
// 打ち間違えて書式が崩れたりしたら、ここで落ちて気付ける（計測タグは無言で
// 発火を止めるだけなので、コード側の変化を検知する手段がこのテストしかない）。
assert(currentId !== 'G-XXXXXXXXXX', 'analytics.js: 測定 ID がプレースホルダのままではない');
assert(
  /^G-[A-Z0-9]{6,}$/.test(currentId ?? ''),
  'analytics.js: 測定 ID が GA4 の書式（G- + 英数字）に合致する',
);

const asShipped = runAnalytics(analyticsJs);
if (currentId === 'G-XXXXXXXXXX') {
  // まだ GA4 プロパティを作っていない状態。プレースホルダのまま Google へリクエストを
  // 飛ばすと、集計に使えないヒットのために閲覧者の情報を外部送信することになるので、
  // 発火しないことを実行して確かめる。
  assert(
    asShipped.scripts.length === 0,
    'analytics.js: 測定 ID が未設定（プレースホルダ）のあいだは gtag.js を読み込まない',
  );
  assert(
    asShipped.window.dataLayer === undefined && asShipped.window.gtag === undefined,
    'analytics.js: 測定 ID が未設定のあいだは dataLayer / gtag も作らない（計測ヒットを積まない）',
  );
} else {
  // 測定 ID 差し替え後。今度は実際に発火することを確かめる（無言で止まっていないか）。
  assert(
    asShipped.scripts.length === 1,
    `analytics.js: 測定 ID（${currentId}）が設定済みなので gtag.js を読み込む`,
  );
}

// 測定 ID を設定したときの挙動。差し替え前でも後でも同じ検証になるよう、
// 定数の行だけをテスト用の ID へ置き換えて動かす。
const REAL_ID = 'G-TEST123456';
const configured = runAnalytics(
  analyticsJs.replace(ID_LINE, `var MEASUREMENT_ID = '${REAL_ID}';`),
);
assert(
  configured.scripts.length === 1
    && configured.scripts[0].src === `https://www.googletagmanager.com/gtag/js?id=${REAL_ID}`
    && configured.scripts[0].async === true,
  'analytics.js: 測定 ID を設定すると gtag.js を非同期で読み込む',
);
// dataLayer に積まれた命令から config の設定値を取り出して検証する。
const configCall = (configured.window.dataLayer ?? [])
  .map((args) => Array.from(args))
  .find((args) => args[0] === 'config');
assert(configCall?.[1] === REAL_ID, 'analytics.js: 設定した測定 ID で gtag config を呼ぶ');
// 広告目的の機能は使わない。privacy.html に「広告配信の目的では利用しません」と
// 書いている根拠なので、実装から消えたら公表内容と食い違う。
assert(
  configCall?.[2]?.allow_google_signals === false
    && configCall?.[2]?.allow_ad_personalization_signals === false,
  'analytics.js: Google シグナルと広告のパーソナライズを無効にしている',
);
// --- 素の HTML に計測タグが入っている ---
for (const page of ANALYTICS_PAGES) {
  const html = readSite(page);
  assert(
    /<script\s+src="\.\/analytics\.js"><\/script>/.test(html),
    `site/${page}: analytics.js を読み込んでいる`,
  );
  // 測定 ID の直書きは analytics.js の 1 か所だけ。ページ側に散ると差し替え漏れが出る。
  assert(
    !/G-[A-Z0-9]{6,}/.test(html),
    `site/${page}: 測定 ID を直書きしていない（analytics.js に集約する）`,
  );
}

// --- 計測しているページからは公表ページへ辿れる ---
for (const page of ANALYTICS_PAGES.filter((p) => p !== 'privacy.html')) {
  assert(
    readSite(page).includes('href="./privacy.html"'),
    `site/${page}: privacy.html へのリンクがある（外部送信の公表へ辿れる）`,
  );
}

// --- 自動生成ファイルに計測タグを書いていない ---
// 書いても配信時に消えるため、残っていたら「生成元ではなく生成物を編集した」しるし。
for (const file of GENERATED_FILES) {
  const content = readSite(file);
  for (const marker of TRACKING_MARKERS) {
    assert(
      !content.includes(marker),
      `site/${file}: 自動生成ファイルに計測タグ（${marker}）が入っていない`,
    );
  }
}
// 生成元のテンプレート（scripts/generate/attribution.js・llms.js）は private リポジトリ
// （japan-facilities-crawler）にのみ存在し、このリポジトリにはコピーを持たない
// （ADR 0001: コピーを持たないことで巻き戻りを構造的に起こせなくする）。
// そのため生成元テンプレート側の検証はこのリポジトリからは行わない。

// --- Search Console の所有権確認は meta タグ方式 ---
const verificationTag = indexHtml.match(/<meta\s+name="google-site-verification"\s+content="([^"]+)">/);
assert(verificationTag !== null, 'site/index.html: google-site-verification の meta タグがある');
// プレースホルダのまま配信すると所有権確認が失敗するので、実トークンが入っていることを固定する。
assert(
  verificationTag?.[1] !== 'GOOGLE_SITE_VERIFICATION_TOKEN',
  'site/index.html: google-site-verification の content がプレースホルダのままではない',
);
// keep_files: true のため HTML ファイル方式の確認ファイルは後から消せない。
// （google1234abcd.html のような名前で site/ 直下に置く方式）
const verificationFiles = fs.readdirSync(SITE).filter((f) => /^google[0-9a-f]+\.html$/i.test(f));
assert(
  verificationFiles.length === 0,
  `site/: HTML ファイル方式の所有権確認ファイルを置いていない（keep_files: true で消せないため）${verificationFiles.length ? ` — 実際: ${verificationFiles.join(', ')}` : ''}`,
);

// --- 外部送信の公表ページ（privacy.html）の中身 ---
// 外部送信規律が公表を求める要素（送信する情報・送信先・利用目的・停止方法）と、
// 問い合わせ先が欠けていないかを固定する。
const privacyRequired = [
  ['外部送信', '外部送信への言及'],
  ['第27条の12', '根拠条文（電気通信事業法の外部送信規律）'],
  ['Google', '送信先（Google）'],
  ['Cookie', 'Cookie の利用'],
  ['利用目的', '利用目的'],
  ['https://tools.google.com/dlpage/gaoptout', 'Google 公式オプトアウト アドオンの案内'],
  ['https://github.com/gl20percentclub/japan-food-facilities/issues', '問い合わせ先'],
];
for (const [needle, label] of privacyRequired) {
  assert(privacyHtml.includes(needle), `site/privacy.html: ${label} の記載がある`);
}
// 公表ページ自体がインデックスされないと公表の意味が薄れる。
assert(!isNoindex(privacyHtml), 'site/privacy.html: noindex になっていない');

// --- サイトマップが公開ページを網羅している ---
const sitemapLocs = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
assert(sitemapXml.includes('<urlset'), 'site/sitemap.xml: urlset を持つサイトマップ形式である');
assert(sitemapLocs.length > 0, 'site/sitemap.xml: URL が1件以上ある');
assert(
  sitemapLocs.every((loc) => loc.startsWith(BASE_URL)),
  `site/sitemap.xml: 全 URL が公開サイトの基点（${BASE_URL}）配下である`,
);
// トップは index.html ではなくディレクトリ URL を正規とする（LP の og:url と揃える）。
assert(sitemapLocs.includes(BASE_URL), 'site/sitemap.xml: トップページ（ディレクトリ URL）が載っている');

// site/ の HTML を増やしたらサイトマップにも足す。noindex のページは対象外。
const siteHtml = fs.readdirSync(SITE).filter((f) => f.endsWith('.html'));
for (const page of siteHtml) {
  const listed = sitemapLocs.includes(`${BASE_URL}${page}`)
    || (page === 'index.html' && sitemapLocs.includes(BASE_URL));
  if (isNoindex(readSite(page))) {
    assert(!listed, `site/sitemap.xml: noindex の ${page} を載せていない`);
  } else {
    assert(listed, `site/sitemap.xml: ${page} が載っている（ページ追加時の書き忘れ防止）`);
  }
}
// 実在しないページを指していないこと（リネーム・削除時の追従漏れ防止）。
for (const loc of sitemapLocs) {
  const rel = loc.slice(BASE_URL.length) || 'index.html';
  assert(
    fs.existsSync(path.join(SITE, rel)),
    `site/sitemap.xml: ${rel} が site/ に実在する`,
  );
}

console.log('');
if (failures > 0) {
  console.error(`❌ 公開サイトの計測・プライバシー構成テストに ${failures} 件の失敗`);
  process.exit(1);
}
console.log('✅ 公開サイトの計測・プライバシー構成テストに合格');

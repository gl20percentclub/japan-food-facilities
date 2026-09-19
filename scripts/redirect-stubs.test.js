// gh-pages → 新ドメイン（food.japan-facilities.com）移行用のリダイレクトスタブを検証する。
//
//   node scripts/redirect-stubs.test.js
//
// スタブは redirect-stubs/ に置いてあり、まだ site/ には配置していない（＝配信していない）。
// 新ドメインでの配信開始・動作確認が終わるまでリダイレクトを有効化しないためで、
// 詳細は redirect-stubs/README.md を参照。
//
// ここで固定したいのは次の3点。
//
// 1. スタブが指す先の URL が正しい（新ドメインの対応するパスを指している）。
// 2. .github/workflows/pages.yml が redirect-stubs/ を配信対象にしていない
//    （site/** だけを配信対象にする前提が崩れると、意図せずリダイレクトが有効化される）。
// 3. site/ 側にはまだ新ドメインへのリダイレクトが書き込まれていない
//    （このテストを追加した時点でうっかり同時に有効化していないかのガード）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUBS = path.join(ROOT, 'redirect-stubs');
const NEW_ORIGIN = 'https://food.japan-facilities.com';

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

/** redirect-stubs/ 配下のファイルを読む。 */
function readStub(name) {
  return fs.readFileSync(path.join(STUBS, name), 'utf-8');
}

console.log('gh-pages リダイレクトスタブのテスト\n');

// --- 各 HTML スタブが正しい新ドメイン URL を指している ---
const HTML_STUBS = {
  'index.html': `${NEW_ORIGIN}/`,
  'map.html': `${NEW_ORIGIN}/map.html`,
  'playground.html': `${NEW_ORIGIN}/map.html`,
  'coord-quality.html': `${NEW_ORIGIN}/coord-quality.html`,
  'privacy.html': `${NEW_ORIGIN}/privacy.html`,
};

for (const [file, target] of Object.entries(HTML_STUBS)) {
  const html = readStub(file);
  assert(
    html.includes(`<meta http-equiv="refresh" content="0; url=${target}">`),
    `redirect-stubs/${file}: meta refresh が ${target} を指している`,
  );
  assert(
    html.includes(`<link rel="canonical" href="${target}">`),
    `redirect-stubs/${file}: canonical が ${target} を指している`,
  );
  assert(
    /<meta\s+name="robots"\s+content="noindex">/.test(html),
    `redirect-stubs/${file}: noindex になっている`,
  );
  assert(
    html.includes(`href="${target}"`),
    `redirect-stubs/${file}: 自動で遷移しない場合の可視リンクがある`,
  );
}

// --- 404.html はパスを引き継いで新ドメインへ遷移する（JS）＋ noscript フォールバック ---
const notFound = readStub('404.html');
assert(
  notFound.includes(`'${NEW_ORIGIN}' + location.pathname + location.search`),
  'redirect-stubs/404.html: JS でパス・クエリを引き継いで新ドメインへ遷移する',
);
assert(
  /<noscript>\s*<meta http-equiv="refresh" content="0; url=https:\/\/food\.japan-facilities\.com\/">\s*<\/noscript>/.test(notFound),
  'redirect-stubs/404.html: noscript フォールバックが新ドメインのトップを指している',
);
assert(
  /<meta\s+name="robots"\s+content="noindex">/.test(notFound),
  'redirect-stubs/404.html: noindex になっている',
);

// --- sitemap.xml が新ドメインの URL だけを指している ---
const sitemap = readStub('sitemap.xml');
const sitemapLocs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
assert(sitemapLocs.length > 0, 'redirect-stubs/sitemap.xml: URL が1件以上ある');
assert(
  sitemapLocs.every((loc) => loc.startsWith(`${NEW_ORIGIN}/`)),
  `redirect-stubs/sitemap.xml: 全 URL が新ドメイン（${NEW_ORIGIN}/）配下である`,
);

// --- attribution.html / llms.txt / llms-full.txt のスタブは意図的に置いていない ---
// private リポジトリ（japan-facilities-crawler）が生成して push する成果物のため、
// このリポジトリでは手編集しない（AGENTS.md / CONTRIBUTING.md の方針）。
for (const generated of ['attribution.html', 'llms.txt', 'llms-full.txt']) {
  assert(
    !fs.existsSync(path.join(STUBS, generated)),
    `redirect-stubs/${generated} を置いていない（生成元は private リポジトリ側にある）`,
  );
}

// --- pages.yml が redirect-stubs/ を配信対象にしていない（意図しない有効化を防ぐ） ---
const pages = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/pages.yml'), 'utf8'));
const pushPaths = (pages.on ?? pages[true])?.push?.paths ?? [];
assert(
  !pushPaths.some((p) => p.startsWith('redirect-stubs')),
  'pages.yml: redirect-stubs/ を配信トリガーに含めていない（有効化するまで配信されない）',
);
const deploySteps = Object.values(pages.jobs ?? {})
  .flatMap((job) => job.steps ?? [])
  .filter((step) => (step.uses ?? '').startsWith('peaceiris/actions-gh-pages'));
assert(
  deploySteps.every((step) => (step.with ?? {}).publish_dir !== 'redirect-stubs'),
  'pages.yml: publish_dir が redirect-stubs/ になっていない',
);

// --- site/ 側にはまだ新ドメインへのリダイレクトが書き込まれていない（早すぎる有効化のガード） ---
for (const file of Object.keys(HTML_STUBS)) {
  const sitePath = path.join(ROOT, 'site', file);
  if (!fs.existsSync(sitePath)) continue;
  const siteHtml = fs.readFileSync(sitePath, 'utf-8');
  assert(
    !siteHtml.includes(`url=${NEW_ORIGIN}`),
    `site/${file}: まだ新ドメインへのリダイレクトが書き込まれていない（有効化前）`,
  );
}
assert(
  !fs.existsSync(path.join(ROOT, 'site', '404.html')),
  'site/404.html: まだ配置していない（有効化前）',
);

console.log('');
if (failures > 0) {
  console.error(`❌ リダイレクトスタブのテストに ${failures} 件の失敗`);
  process.exit(1);
}
console.log('✅ リダイレクトスタブのテストに合格');

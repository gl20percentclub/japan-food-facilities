// site/index.html のヒーロー統計（都道府県・市区町村・施設レコード数）が、
// 実在しない値をHTMLに焼き込んでいないかを検証する。
//
//   node scripts/site-stats.test.js
//
// 背景: これらの値は本来 JS（fetch(`${API_BASE}/tiles/metadata.json`)）が実データで
// 上書きするための「初期値」に過ぎない。しかし fetch が失敗した場合・JS 無効の場合・
// SNS のリンクプレビュー・一部のクローラにはこの初期値がそのまま見えるため、
// 週次クロールのたびに実態とズレていく数値を書いておくと外部からの信用を損なう。
// 「52都道府県」（日本には47都道府県しか存在しない）はその典型例だった。
//
// そこで、都道府県・市区町村・施設レコード数の初期値は site/map.html に既にある
// パターン（`–` のダッシュ）に揃え、数値を焼き込まないことにした。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');

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

console.log('公開サイトの統計値テスト\n');

const indexHtml = fs.readFileSync(path.join(SITE, 'index.html'), 'utf-8');

// --- JS が上書きする3つの統計値は、初期値としてダッシュ（–）を書く ---
// map.html（site/map.html:180-182）と同じパターンに揃える。JS で上書きされなかった
// 場合に、古い（＝いずれ実態とズレる）数値ではなく「わからない」ことが分かる表示にする。
const DASH_STAT_IDS = ['stat-facility', 'stat-pref', 'stat-city'];
for (const id of DASH_STAT_IDS) {
  const m = indexHtml.match(new RegExp(`<span class="num" id="${id}">([^<]*)</span>`));
  assert(m !== null, `site/index.html: #${id} の統計スパンがある`);
  assert(m?.[1] === '–', `site/index.html: #${id} の初期値がダッシュ（–）である（数値を焼き込んでいない）`);
}

// --- 都道府県の統計だけは、万一数値に戻されても「52」のような実在しない値を防ぐ ---
// 日本の都道府県数は47（都道府県の増減は現実的に起こらない）。
const prefMatch = indexHtml.match(/<span class="num" id="stat-pref">([^<]*)<\/span>/);
const prefValue = prefMatch?.[1] ?? '';
const prefAsNumber = Number(prefValue.replace(/,/g, ''));
assert(
  prefValue === '–' || (Number.isFinite(prefAsNumber) && prefAsNumber > 0 && prefAsNumber <= 47),
  'site/index.html: #stat-pref が実在しない都道府県数（47超）を焼き込んでいない',
);

// --- OGP の og:url が公開サイトの正規ドメインを指している ---
// 静的ページは food.japan-facilities.com（S3 + CloudFront）から配信している。
const CANONICAL_ORIGIN = 'https://food.japan-facilities.com/';
for (const page of ['index.html', 'coord-quality.html', 'privacy.html']) {
  const html = fs.readFileSync(path.join(SITE, page), 'utf-8');
  const ogUrl = html.match(/<meta property="og:url" content="([^"]+)">/)?.[1];
  assert(
    ogUrl?.startsWith(CANONICAL_ORIGIN),
    `site/${page}: og:url（${ogUrl}）が公開サイトの正規ドメイン（${CANONICAL_ORIGIN}）を指している`,
  );
}

console.log('');
if (failures > 0) {
  console.error(`❌ 公開サイトの統計値テストに ${failures} 件の失敗`);
  process.exit(1);
}
console.log('✅ 公開サイトの統計値テストに合格');

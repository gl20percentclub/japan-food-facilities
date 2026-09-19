// gh-pages → 新ドメイン（food.japan-facilities.com）移行用のリダイレクトスタブを検証する。
//
//   node scripts/redirect-stubs.test.js
//
// スタブは redirect-stubs/ に置いてあり、.github/workflows/pages.yml のビルドステップが
// デプロイのたびに site/ のコピー（gh-pages-dist/）へ上書きしてから gh-pages へ配信する
// （有効化済み）。詳細は redirect-stubs/README.md を参照。
//
// ここで固定したいのは次の4点。
//
// 1. スタブが指す先の URL が正しい（新ドメインの対応するパスを指している）。
// 2. pages.yml が実際に redirect-stubs/ を配信対象にし、site/ とは別のビルド先
//    （gh-pages-dist/）へ配信している（publish_dir が site でも redirect-stubs でもない）。
// 3. 【最重要】pages.yml のビルドステップを実際に実行しても site/ 自体は一切書き換わらない。
//    site/ は deploy-s3.yml（新ドメイン = S3 + CloudFront）の配信元でもあるため、
//    ここが崩れると新ドメインのページがリダイレクトに置き換わり、
//    「新ドメイン → 新ドメイン」の無限リダイレクトになる。
// 4. deploy-s3.yml が redirect-stubs/ やビルド先ディレクトリに一切触れない
//    （S3 側からの独立した防御線）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUBS = path.join(ROOT, 'redirect-stubs');
const SITE = path.join(ROOT, 'site');
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

/** ファイルの内容ハッシュ（ディレクトリ丸ごとの変更検知に使う）。 */
function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** ディレクトリ配下の全ファイルを相対パス → ハッシュ の Map にする（再帰）。 */
function hashDir(dir) {
  const result = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [rel, h] of hashDir(abs)) result.set(path.join(entry.name, rel), h);
    } else {
      result.set(entry.name, hashFile(abs));
    }
  }
  return result;
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
// gh-pages ではビルドステップが site/ の内容をそのまま通す（後述のビルド検証を参照）。
for (const generated of ['attribution.html', 'llms.txt', 'llms-full.txt']) {
  assert(
    !fs.existsSync(path.join(STUBS, generated)),
    `redirect-stubs/${generated} を置いていない（生成元は private リポジトリ側にある）`,
  );
}

// --- pages.yml の配信設定を読む ---
const pages = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/pages.yml'), 'utf8'));
const pushPaths = (pages.on ?? pages[true])?.push?.paths ?? [];
const pagesSteps = Object.values(pages.jobs ?? {}).flatMap((job) => job.steps ?? []);
const deployStep = pagesSteps.find((step) => (step.uses ?? '').startsWith('peaceiris/actions-gh-pages'));
const publishDir = String(deployStep?.with?.publish_dir ?? '');

// --- pages.yml が site/ と redirect-stubs/ の両方を配信トリガーにしている ---
// （どちらの変更でも gh-pages への再配信が必要なため）
assert(
  pushPaths.includes('site/**'),
  'pages.yml: site/** の変更を配信トリガーにしている',
);
assert(
  pushPaths.some((p) => p.startsWith('redirect-stubs')),
  'pages.yml: redirect-stubs/** の変更を配信トリガーにしている（有効化済み）',
);

// --- pages.yml の配信元（publish_dir）は site/ でも redirect-stubs/ でもない ---
// site/ を直接配信すると本来のページがそのまま出てリダイレクトが効かない。
// redirect-stubs/ を直接配信すると attribution.html / llms*.txt / analytics.js / _headers
// が欠落する。どちらでもない専用のビルド先であることを固定する。
assert(
  publishDir !== '' && publishDir !== 'site' && publishDir !== './site',
  `pages.yml: publish_dir が site/ 自体ではない（実際: ${publishDir || '未指定'}）`,
);
assert(
  publishDir !== 'redirect-stubs' && publishDir !== './redirect-stubs',
  `pages.yml: publish_dir が redirect-stubs/ 自体でもない（実際: ${publishDir || '未指定'}）`,
);

// --- ビルドステップを実際に実行して、site/ との分離を検証する ---
// 文字列の grep ではなく、pages.yml に書かれている run スクリプトをそのまま
// 隔離したコピーの上で実行し、結果を確かめる（検証は最終成果物で行う）。
const buildStep = pagesSteps.find((step) =>
  typeof step.run === 'string' && step.run.includes(publishDir),
);
assert(!!buildStep, `pages.yml: ${publishDir}/ を組み立てる run ステップが見つかる`);

if (buildStep && publishDir) {
  // site/ と redirect-stubs/ を隔離した一時ディレクトリへコピーし、そこで
  // run スクリプトをそのまま実行する（実リポジトリの site/ には一切触れない）。
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redirect-stubs-build-'));
  try {
    fs.cpSync(SITE, path.join(workDir, 'site'), { recursive: true });
    fs.cpSync(STUBS, path.join(workDir, 'redirect-stubs'), { recursive: true });
    const siteHashesBefore = hashDir(path.join(workDir, 'site'));

    execSync(buildStep.run, { cwd: workDir, shell: '/bin/bash' });

    const builtDir = path.join(workDir, publishDir);
    assert(fs.existsSync(builtDir), `${publishDir}/: ビルドステップの実行後に生成される`);

    // --- site/ のコピーはビルド実行後も一切変わっていない ---
    const siteHashesAfter = hashDir(path.join(workDir, 'site'));
    assert(
      siteHashesBefore.size === siteHashesAfter.size
        && [...siteHashesBefore].every(([rel, h]) => siteHashesAfter.get(rel) === h),
      'pages.yml のビルドステップを実行しても site/ の内容は一切変わらない（無限リダイレクトの根拠）',
    );

    // --- ビルド先にはリダイレクトスタブの内容がそのまま反映されている ---
    for (const file of [...Object.keys(HTML_STUBS), '404.html', 'sitemap.xml']) {
      const builtPath = path.join(builtDir, file);
      assert(
        fs.existsSync(builtPath) && fs.readFileSync(builtPath, 'utf-8') === readStub(file),
        `${publishDir}/${file}: redirect-stubs/${file} の内容がそのまま反映されている`,
      );
    }

    // --- attribution.html / llms.txt / llms-full.txt / analytics.js / _headers は
    //     site/ の内容がそのまま通る（生成物・計測タグを壊さない） ---
    for (const file of ['attribution.html', 'llms.txt', 'llms-full.txt', 'analytics.js', '_headers']) {
      const sitePath = path.join(SITE, file);
      if (!fs.existsSync(sitePath)) continue;
      const builtPath = path.join(builtDir, file);
      assert(
        fs.existsSync(builtPath) && hashFile(builtPath) === hashFile(sitePath),
        `${publishDir}/${file}: site/${file} の内容がそのまま通る（redirect-stubs で上書きされていない）`,
      );
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// --- site/ 側には新ドメインへのリダイレクトが一切書き込まれていない ---
// これはビルド前の状態についての恒久的な不変条件（deploy-s3.yml が site/ を
// そのまま新ドメインへ同期するため）。上のビルド実行検証と合わせた二重の防御線。
for (const file of Object.keys(HTML_STUBS)) {
  const sitePath = path.join(SITE, file);
  if (!fs.existsSync(sitePath)) continue;
  const siteHtml = fs.readFileSync(sitePath, 'utf-8');
  assert(
    !siteHtml.includes(`url=${NEW_ORIGIN}`),
    `site/${file}: 新ドメインへのリダイレクトが書き込まれていない（S3 側の実ページを守る）`,
  );
}
assert(
  !fs.existsSync(path.join(SITE, '404.html')),
  'site/404.html: 配置していない（新ドメイン側に 404 リダイレクトは不要）',
);

// --- deploy-s3.yml は redirect-stubs/ やビルド先ディレクトリに一切触れない ---
// S3 側からの独立した防御線。pages.yml 側の設定が壊れても、deploy-s3.yml 自体が
// これらを参照していない限り新ドメインへ混入しない。
const s3Deploy = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-s3.yml'), 'utf8'));
const s3RunText = Object.values(s3Deploy.jobs ?? {})
  .flatMap((job) => job.steps ?? [])
  .map((step) => step.run ?? '')
  .join('\n');
assert(
  !s3RunText.includes('redirect-stubs'),
  'deploy-s3.yml: redirect-stubs/ を参照していない',
);
if (publishDir) {
  assert(
    !s3RunText.includes(publishDir),
    `deploy-s3.yml: pages.yml のビルド先（${publishDir}/）を参照していない`,
  );
}
const s3PushPaths = (s3Deploy.on ?? s3Deploy[true])?.push?.paths ?? [];
assert(
  !s3PushPaths.some((p) => p.startsWith('redirect-stubs')),
  'deploy-s3.yml: redirect-stubs/** を配信トリガーにしていない',
);

console.log('');
if (failures > 0) {
  console.error(`❌ リダイレクトスタブのテストに ${failures} 件の失敗`);
  process.exit(1);
}
console.log('✅ リダイレクトスタブのテストに合格');

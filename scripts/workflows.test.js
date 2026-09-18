// gh-pages への配信ワークフローの設定を検証する。
//
//   node scripts/workflows.test.js
//
// 過去に、publish_dir が . のため .gitignore ごと配信され、配信先で git add --all
// された結果 api/ が一切コミットされず（.gitignore が api/ を無視するため）、
// gh-pages 上のデータが全削除される事故があった。現在は配信元を site/ に限定して
// 同じ壊れ方を構造的に起きなくしてあるので、その前提のほうをテストで固定する。
//
// データ（api/）の配信は外部の Fargate クローラー（S3 + CloudFront）へ移したため、
// gh-pages へ配信するのは静的ページだけ。旧 crawl.yml は廃止済みで、復活しないことも
// ここで固定する。
//
// クロール処理・生成ドキュメント（attribution.html/llms*.txt）の生成元
// （config/sources.yaml・scripts/generate/）は private リポジトリ
// （japan-facilities-crawler）へ移行済みで、このリポジトリには存在しない。
// そのため以前とは逆に、次を禁止事項として固定する:
//   - pages.yml が配信前にページを再生成しないこと（生成元が無いので再生成できない。
//     site/ にコミット済みの内容がそのまま配信物になる）
//   - generated-docs.yml（生成元とのドリフトを自己修復するワークフロー）が
//     復活していないこと（対象が無くなったため撤去した）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

/** ワークフロー YAML を読む。`on:` は YAML 1.1 では真偽値 true になるため両方見る。 */
function loadWorkflow(name) {
  const doc = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8'));
  return { ...doc, on: doc.on ?? doc[true] };
}

/** 全ジョブから actions-gh-pages の配信ステップを集める。 */
function deploySteps(workflow) {
  return Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((step) => (step.uses ?? '').startsWith('peaceiris/actions-gh-pages'));
}

console.log('ワークフロー設定テスト\n');

const pages = loadWorkflow('pages.yml');

// --- 旧 crawl.yml が復活していない ---
// gh-pages へデータを配信していた旧ワークフロー。クロールと配信は外部の Fargate
// クローラー（S3 + CloudFront）に移ったため廃止した。復活すると (1) 100MB を超える
// 結合CSV で push 全体が失敗し、(2) 生成物（attribution.html / llms*.txt）を main へ
// push して古い内容に巻き戻す事故が再発する。
assert(
  !fs.existsSync(path.join(ROOT, '.github/workflows/crawl.yml')),
  '廃止した crawl.yml が復活していない（クロールと配信は外部の Fargate クローラーが担う）',
);

// --- generated-docs.yml が復活していない ---
// 生成ドキュメント（attribution.html/llms*.txt）の生成元（config/sources.yaml・
// scripts/generate/）は private リポジトリへ移行済みで、このリポジトリには無い。
// 生成元が無い状態でこのワークフローが存在すると、再生成コマンドがそもそも動かず
// CI が壊れる。復活していないことをここで固定する。
assert(
  !fs.existsSync(path.join(ROOT, '.github/workflows/generated-docs.yml')),
  '撤去した generated-docs.yml が復活していない（生成元は private リポジトリ側にある）',
);

// --- 生成元（config/sources.yaml・scripts/generate/）がこのリポジトリに無い ---
// 誤って復活させると「このリポジトリが生成物の単一の情報源」という誤解を招き、
// private リポジトリ側の生成元と二重管理になる（過去の巻き戻り事故と同じ構造）。
assert(
  !fs.existsSync(path.join(ROOT, 'config/sources.yaml')),
  'config/sources.yaml が無い（データソース定義は private リポジトリ側が持つ）',
);
assert(
  !fs.existsSync(path.join(ROOT, 'scripts/generate')),
  'scripts/generate/ が無い（生成ドキュメントの生成元は private リポジトリ側が持つ）',
);

// --- .gitignore が api/ を無視している前提を確認する ---
// この前提が崩れたら以降の除外チェックの意味も変わるため、最初に固定する。
const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
const ignoresApi = gitignore.split('\n').some((line) => line.trim() === 'api/');
assert(ignoresApi, '.gitignore が api/ を無視している（配信物は Git 管理しない）');

// --- 配信元が公開用ディレクトリ（site/）に限定されている ---
const allDeploySteps = deploySteps(pages).map((step) => ['pages.yml', step]);
assert(allDeploySteps.length === 1, '配信ステップは pages.yml の1つだけ');

for (const [file, step] of allDeploySteps) {
  const withInputs = step.with ?? {};
  const excluded = String(withInputs.exclude_assets ?? '')
    .split(',')
    .map((s) => s.trim());
  assert(
    withInputs.publish_branch === 'gh-pages',
    `${file}: 配信先ブランチが gh-pages である`,
  );
  // 配信元は公開用ディレクトリ（site/）に限定する。リポジトリのルートを配信すると
  // README・docs/・config/ まで公開され、さらに .gitignore ごと配信された場合は
  // 配信先の git add --all で api/ が無視されて gh-pages 上のデータが消える。
  // 除外リストで塞ぐより、配信元を分けて構造的に起きなくするほうが確実。
  const publishDir = String(withInputs.publish_dir ?? '');
  assert(
    publishDir !== '.' && publishDir !== '' && publishDir !== './',
    `${file}: publish_dir がリポジトリのルートではない（実際: ${publishDir || '未指定'}）`,
  );
  // 配信元に混ざってはいけないものが実際に無いことを確認する（除外リストの代わり）。
  for (const forbidden of ['.gitignore', 'node_modules', 'scripts', 'package.json']) {
    assert(
      !fs.existsSync(path.join(ROOT, publishDir, forbidden)),
      `${file}: 配信元 ${publishDir}/ に ${forbidden} が無い`,
    );
  }
  // 除外リストを併用する場合は、上の前提を崩さない範囲であること。
  assert(
    excluded.every((e) => e === ''),
    `${file}: 配信元を site/ に絞ったため exclude_assets は不要`,
  );
}

// --- 役割 ---
// pages.yml はページだけを上書きし、gh-pages 上の既存ファイルを消さない。
const pagesDeploy = deploySteps(pages)[0]?.with ?? {};
const pagesPublishDir = String(pagesDeploy.publish_dir ?? 'site');
assert(
  pagesDeploy.keep_files === true,
  'pages.yml: keep_files が true（gh-pages 上の既存ファイルを消さない）',
);

// --- gh-pages への同時 push を避ける ---
// main への連続 push で配信が重なると push が競合するため直列化する。
assert(
  pages.concurrency?.group != null && pages.concurrency?.['cancel-in-progress'] !== true,
  'pages.yml: concurrency グループで配信を直列化する（実行中をキャンセルしない）',
);

// --- ページの変更が push で配信される ---
const pushPaths = pages.on?.push?.paths ?? [];
assert(pages.on?.push?.branches?.includes('main'), 'pages.yml: main への push で動く');
// 配信元ディレクトリ配下は一括で拾う。個別列挙だとページ追加時に書き忘れる。
assert(
  pushPaths.includes(`${pagesPublishDir}/**`),
  `pages.yml: ${pagesPublishDir}/** の変更を配信対象にしている`,
);
// 公開しているページが配信元に実在することを確認する（移動・リネーム時の追従漏れ防止）。
for (const page of ['index.html', 'map.html', 'playground.html', 'attribution.html', 'llms.txt', 'llms-full.txt']) {
  assert(
    fs.existsSync(path.join(ROOT, pagesPublishDir, page)),
    `pages.yml: ${pagesPublishDir}/${page} がリポジトリに存在する`,
  );
}

// --- 自動生成ページを配信前に再生成しない ---
// site/attribution.html・llms*.txt の生成元（config/sources.yaml・
// scripts/generate/）は private リポジトリ（japan-facilities-crawler）へ移行済みで、
// このリポジトリには無い。そのため配信前の再生成はできない・してはいけない
// （このリポジトリでは生成できないコマンドを呼ぶだけの壊れたステップになる）。
// これらのファイルは private リポジトリが生成して push した「コミット済みの成果物」
// として扱い、site/ にある内容をそのまま配信する。
const pagesRun = Object.values(pages.jobs ?? {})
  .flatMap((job) => job.steps ?? [])
  .map((step) => step.run ?? '')
  .join('\n');
assert(
  !pagesRun.includes('build:attribution') && !pagesRun.includes('build:llms'),
  'pages.yml: 配信前に attribution.html / llms*.txt を再生成しない（生成元が無いため）',
);
// 生成元だけの変更で配信が走る仕組みも不要（生成元自体がこのリポジトリに無い）。
for (const src of ['config/sources.yaml']) {
  assert(!pushPaths.includes(src), `pages.yml: ${src} は配信対象に含めない（このリポジトリに無い）`);
}

console.log('');
if (failures > 0) {
  console.error(`❌ ワークフロー設定テストに ${failures} 件の失敗`);
  process.exit(1);
}
console.log('✅ ワークフロー設定テストに合格');

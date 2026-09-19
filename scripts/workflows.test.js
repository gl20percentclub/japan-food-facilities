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
import { execSync } from 'node:child_process';
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

// --- 配信ステップは pages.yml の1つだけ ---
const allDeploySteps = deploySteps(pages).map((step) => ['pages.yml', step]);
assert(allDeploySteps.length === 1, '配信ステップは pages.yml の1つだけ');

// pages.yml は gh-pages への配信直前に、コミット済みの site/ を一時ディレクトリ
// （publish_dir。Git 管理対象外、CI が使い捨てで生成する）へコピーしてから
// redirect-stubs/ で上書きする。そのため publish_dir 自体はリポジトリ上に実在しない。
// 「配信元にリポジトリのルートの余計なファイルが混ざらない」という守りたい性質は、
// コピー元である site/ 側にあるかどうかで検証する（gh-pages-dist/ はその単純コピー +
// 上書きなので、site/ に無いものは gh-pages-dist/ にも現れない。詳細は
// scripts/redirect-stubs.test.js が実際にビルドを実行して検証している）。
for (const [file, step] of allDeploySteps) {
  const withInputs = step.with ?? {};
  const excluded = String(withInputs.exclude_assets ?? '')
    .split(',')
    .map((s) => s.trim());
  assert(
    withInputs.publish_branch === 'gh-pages',
    `${file}: 配信先ブランチが gh-pages である`,
  );
  // 配信元（publish_dir）はリポジトリのルートでも site/ 自体でもない専用のビルド先。
  // リポジトリのルートを配信すると README・docs/・config/ まで公開され、さらに
  // .gitignore ごと配信された場合は配信先の git add --all で api/ が無視されて
  // gh-pages 上のデータが消える。除外リストで塞ぐより、配信元を分けて構造的に
  // 起きなくするほうが確実。
  const publishDir = String(withInputs.publish_dir ?? '');
  assert(
    publishDir !== '.' && publishDir !== '' && publishDir !== './',
    `${file}: publish_dir がリポジトリのルートではない（実際: ${publishDir || '未指定'}）`,
  );
  // コピー元（site/）に混ざってはいけないものが実際に無いことを確認する
  // （除外リストの代わり。publish_dir は site/ の単純コピーなのでここで担保できる）。
  for (const forbidden of ['.gitignore', 'node_modules', 'scripts', 'package.json']) {
    assert(
      !fs.existsSync(path.join(ROOT, 'site', forbidden)),
      `${file}: 配信元 site/ に ${forbidden} が無い（publish_dir はその単純コピー）`,
    );
  }
  // 除外リストを併用する場合は、上の前提を崩さない範囲であること。
  assert(
    excluded.every((e) => e === ''),
    `${file}: 配信元を site/ に絞ったため exclude_assets は不要`,
  );
}

// --- ビルドステップは site/ をコピーしてから publish_dir を組み立てている ---
// （publishDir が site/ の単純コピーであるという上の前提そのものを固定する）
const pagesDeploy = deploySteps(pages)[0]?.with ?? {};
const pagesPublishDir = String(pagesDeploy.publish_dir ?? '');
const pagesRunSteps = Object.values(pages.jobs ?? {}).flatMap((job) => job.steps ?? []);
const buildStep = pagesRunSteps.find(
  (step) => typeof step.run === 'string' && pagesPublishDir && step.run.includes(pagesPublishDir),
);
assert(!!buildStep, `pages.yml: ${pagesPublishDir || '(publish_dir)'} を組み立てる run ステップがある`);
assert(
  new RegExp(`cp\\s+-r\\s+site\\s+${pagesPublishDir}\\b`).test(buildStep?.run ?? ''),
  `pages.yml: ビルドステップが site/ を ${pagesPublishDir}/ へコピーしている（cp -r site ${pagesPublishDir}）`,
);
// site/ 自体を書き換える行（cp の宛先が site/）が無いことも固定する。
// site/ は deploy-s3.yml（新ドメイン）の配信元でもあるため、ここに書き込むと
// 「新ドメイン → 新ドメイン」の無限リダイレクトになりうる。
// run スクリプトは `\` による行継続で複数行にまたがるため、まず1論理コマンド
// 1行にまとめてから宛先（最後のトークン）を見る。継続行の途中だけを見ると
// 宛先が別の行にあるケースを見落とす。
const runLines = (buildStep?.run ?? '').split('\n');
const logicalCommands = runLines.reduce((lines, line) => {
  const prev = lines[lines.length - 1];
  if (prev !== undefined && /\\\s*$/.test(prev)) {
    lines[lines.length - 1] = `${prev.replace(/\\\s*$/, '')} ${line.trim()}`;
  } else {
    lines.push(line);
  }
  return lines;
}, []);
const writesIntoSite = logicalCommands.some((line) => {
  const trimmed = line.trim();
  if (!/^cp\b/.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  const dest = tokens[tokens.length - 1];
  return ['site', 'site/', './site', './site/'].includes(dest);
});
assert(
  !writesIntoSite,
  'pages.yml: ビルドステップの cp コマンドの宛先が site/ 自体になっていない',
);

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
// ビルド元（site/）配下は一括で拾う。個別列挙だとページ追加時に書き忘れる。
assert(
  pushPaths.includes('site/**'),
  'pages.yml: site/** の変更を配信対象にしている',
);
// リダイレクトスタブの変更でも再配信されないと、redirect-stubs/ だけを直しても
// gh-pages に反映されない（scripts/redirect-stubs.test.js がスタブ自体の内容は検証する）。
assert(
  pushPaths.some((p) => p.startsWith('redirect-stubs')),
  'pages.yml: redirect-stubs/** の変更も配信対象にしている',
);
// 自動生成ページ（private リポジトリが push する成果物）が配信元（site/）に実在する
// ことを確認する（移動・リネーム時の追従漏れ防止）。リダイレクト対象のページ
// （index.html 等）は redirect-stubs/ 側にあるので、そちらは
// scripts/redirect-stubs.test.js が検証する。
for (const page of ['attribution.html', 'llms.txt', 'llms-full.txt']) {
  assert(
    fs.existsSync(path.join(ROOT, 'site', page)),
    `pages.yml: site/${page} がリポジトリに存在する（gh-pages でもそのまま配信される）`,
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

// --- deploy-s3.yml（food.japan-facilities.com への配信）---
// gh-pages（pages.yml）とは別に、site/** を S3 + CloudFront（独自ドメイン）へ配信する
// ワークフロー。OIDC ロール・バケット・CloudFront distribution の値を取り違えると
// 誤ったリソースへデプロイしてしまう、または /api/* の配信データ（DataBucket、390MB）を
// 巻き込む事故になりうるため、ここで構成を固定する。
const s3Deploy = loadWorkflow('deploy-s3.yml');
const s3DeploySteps = Object.values(s3Deploy.jobs ?? {}).flatMap((job) => job.steps ?? []);
const s3DeployRunText = s3DeploySteps.map((step) => step.run ?? '').join('\n');

// --- OIDC 認証を使っている（アクセスキーを使わない） ---
assert(
  s3Deploy.permissions?.['id-token'] === 'write',
  'deploy-s3.yml: permissions.id-token が write（OIDC 認証）',
);
const credStep = s3DeploySteps.find((step) =>
  (step.uses ?? '').startsWith('aws-actions/configure-aws-credentials'),
);
assert(!!credStep, 'deploy-s3.yml: aws-actions/configure-aws-credentials を使っている');
assert(
  !!credStep?.with?.['role-to-assume'],
  'deploy-s3.yml: role-to-assume が指定されている（OIDC で AssumeRole する）',
);
assert(
  credStep?.with?.['aws-access-key-id'] == null && credStep?.with?.['aws-secret-access-key'] == null,
  'deploy-s3.yml: アクセスキー（aws-access-key-id/aws-secret-access-key）を使っていない',
);

// --- main ブランチの push だけで動く ---
// OIDC ロールの信頼条件（sub）が main への push だけを許可しているため、
// それ以外の ref からは AWS 認証自体が通らない。
assert(
  s3Deploy.on?.push?.branches?.length === 1 && s3Deploy.on?.push?.branches?.includes('main'),
  'deploy-s3.yml: main への push だけで動く（他ブランチを許可していない）',
);
assert(
  (s3Deploy.on?.push?.paths ?? []).includes('site/**'),
  'deploy-s3.yml: site/** の変更を配信対象にしている',
);
const s3DeployJob = Object.values(s3Deploy.jobs ?? {})[0];
assert(
  s3DeployJob?.if === "github.ref == 'refs/heads/main'",
  'deploy-s3.yml: ジョブ自体に main 以外では実行しないガードがある（workflow_dispatch を他ブランチで叩いても動かない）',
);

// --- gh-pages への同時デプロイと同様、S3 sync 同士が競合しないよう直列化する ---
assert(
  s3Deploy.concurrency?.group != null && s3Deploy.concurrency?.['cancel-in-progress'] !== true,
  'deploy-s3.yml: concurrency グループで配信を直列化する（実行中をキャンセルしない）',
);

// --- CloudFront invalidation を実行している ---
assert(
  s3DeployRunText.includes('aws cloudfront create-invalidation'),
  'deploy-s3.yml: 配信後に CloudFront invalidation を実行している',
);

// --- invalidation が /api/* を巻き込まない ---
// この distribution は /api/* も同じ CloudFront から配信しており（DataBucket、
// 390MB）、--paths "/*" は api/* にも一致してしまう。site のデプロイと api の
// 鮮度は無関係なので、無関係なキャッシュ破棄でオリジンへの不要なリクエストを
// 誘発したくない。素の "/*" を使っていないことをまず固定する。
const invalidateStep = s3DeploySteps.find((step) => (step.run ?? '').includes('create-invalidation'));
assert(!!invalidateStep, 'deploy-s3.yml: CloudFront invalidation ステップが見つかる');
const invalidateRun = invalidateStep?.run ?? '';
assert(
  !/--paths\s+["']\/\*["']/.test(invalidateRun),
  'deploy-s3.yml: invalidation の --paths に素の "/*" を使っていない（api/* を巻き込むため）',
);

// --- invalidation パスは site/ 配下の実ファイルから動的に列挙している ---
// 列挙ロジック（変数代入の行）だけを実際に実行し、結果に /api 配下が絶対に
// 含まれないことを実測する（api/ は site/ の外の別ディレクトリなので、site/ の
// 中だけを見て列挙する限り構造的に混ざりようがない、という前提そのものを検証する）。
const pathsAssignment = invalidateRun.match(/^\s*([A-Z_]+)=\$\((.+)\)\s*$/m);
assert(!!pathsAssignment, 'deploy-s3.yml: invalidation パスを動的に列挙する代入行がある');
if (pathsAssignment) {
  const [, varName, subshell] = pathsAssignment;
  const output = execSync(subshell, { cwd: ROOT, shell: '/bin/bash', encoding: 'utf8' });
  const computedPaths = output.split('\n').filter((line) => line.trim() !== '');
  assert(computedPaths.length > 0, `deploy-s3.yml: ${varName} が1件以上のパスを列挙する（実測: ${computedPaths.length}件）`);
  assert(
    computedPaths.every((p) => !p.startsWith('/api')),
    `deploy-s3.yml: ${varName} の列挙結果に /api 配下が含まれない（実測: ${computedPaths.join(', ')}）`,
  );
  assert(
    computedPaths.includes('/index.html'),
    `deploy-s3.yml: ${varName} の列挙結果に /index.html が含まれる`,
  );
  assert(
    !computedPaths.includes('/_headers'),
    `deploy-s3.yml: ${varName} の列挙結果に /_headers が含まれない（配信していないため）`,
  );
  assert(
    invalidateRun.includes(`--paths "/" $${varName}`) || invalidateRun.includes(`--paths "/" $\{${varName}}`),
    `deploy-s3.yml: --paths が "/"（ルート）と ${varName} の両方を渡している`,
  );
}

// --- aws s3 sync を使っている ---
assert(/aws s3 sync/.test(s3DeployRunText), 'deploy-s3.yml: aws s3 sync を使っている');

// --- デプロイ先が env の1箇所にまとまっており、直書きの重複が無い ---
// バケット名・distribution ID・ロール ARN を env で1箇所に定義し、各ステップは
// ${{ env.X }} 経由でだけ参照する。値の直書きが複数箇所に散ると、片方だけ書き換えて
// 取り違える事故が起きる。
assert(
  !!s3Deploy.env?.SITE_BUCKET_NAME,
  'deploy-s3.yml: env.SITE_BUCKET_NAME が定義されている',
);
assert(
  s3DeployRunText.includes('${{ env.SITE_BUCKET_NAME }}'),
  'deploy-s3.yml: sync 先を ${{ env.SITE_BUCKET_NAME }} で参照している',
);
assert(
  !s3DeployRunText.includes(s3Deploy.env?.SITE_BUCKET_NAME ?? '\u0000'),
  'deploy-s3.yml: バケット名を run ステップに直書きしていない（env 参照のみ）',
);
assert(
  s3DeployRunText.includes('${{ env.CLOUDFRONT_DISTRIBUTION_ID }}'),
  'deploy-s3.yml: invalidation 先を ${{ env.CLOUDFRONT_DISTRIBUTION_ID }} で参照している',
);

// --- 実際にデプロイされている値と一致している ---
// cdk deploy 後の CloudFormation Outputs（SiteBucketName / DistributionId /
// PublicSiteDeployRoleArn）から実測した値。ここがずれると、正しく見える設定のまま
// 存在しないリソースや別のリソースへデプロイしてしまう。
assert(
  s3Deploy.env?.SITE_BUCKET_NAME === 'japan-facilities-site-500207450484',
  'deploy-s3.yml: env.SITE_BUCKET_NAME が実際の SiteBucket 名と一致する',
);
assert(
  s3Deploy.env?.CLOUDFRONT_DISTRIBUTION_ID === 'E3AKGPRKL94W0C',
  'deploy-s3.yml: env.CLOUDFRONT_DISTRIBUTION_ID が実際の distribution ID と一致する',
);
assert(
  s3Deploy.env?.AWS_DEPLOY_ROLE_ARN === 'arn:aws:iam::500207450484:role/japan-food-facilities-site-deploy',
  'deploy-s3.yml: env.AWS_DEPLOY_ROLE_ARN が PublicSiteDeployRole の ARN と一致する',
);

// --- DataBucket（/api/* の配信データ、390MB）に一切触れない ---
// バケットを分けている（物理的に別バケット）ため、この文字列が出てくる時点で
// 設計が変わっている。ロール側の IAM ポリシーでも明示的に Deny されている
// （多重防御）が、ワークフロー自体からも参照していないことをここで固定する。
assert(
  !s3DeployRunText.toLowerCase().includes('databucket'),
  'deploy-s3.yml: DataBucket を参照していない',
);

// --- site/_headers は配信しない（実際には解釈されない死んだ設定ファイルのため） ---
assert(
  !s3DeployRunText.includes('site/_headers'),
  'deploy-s3.yml: site/_headers を配信対象にしていない',
);

// --- pages.yml（gh-pages）の deploySteps() には引っかからない ---
// deploySteps() は peaceiris/actions-gh-pages を使うステップだけを拾う関数で、
// aws s3 sync を使う deploy-s3.yml はそもそも対象にならない。この前提が
// 変わっていないことを明示的に固定する（変わっていた場合、上の
// allDeploySteps.length === 1 のアサーションが deploy-s3.yml のステップ数を
// 含んでいないことを意味してしまうため）。
assert(
  deploySteps(s3Deploy).length === 0,
  'deploy-s3.yml: peaceiris/actions-gh-pages を使っていない（deploySteps() の対象外）',
);

// --- S3 へ OIDC で配信するワークフローは1本だけ ---
const workflowFiles = fs.readdirSync(path.join(ROOT, '.github/workflows'));
const s3DeployWorkflows = workflowFiles.filter((file) => {
  const wf = loadWorkflow(file);
  const steps = Object.values(wf.jobs ?? {}).flatMap((job) => job.steps ?? []);
  return steps.some((step) => (step.uses ?? '').startsWith('aws-actions/configure-aws-credentials'));
});
assert(
  s3DeployWorkflows.length === 1 && s3DeployWorkflows[0] === 'deploy-s3.yml',
  'S3 へ OIDC で配信するワークフローは deploy-s3.yml の1本だけ',
);

console.log('');
if (failures > 0) {
  console.error(`❌ ワークフロー設定テストに ${failures} 件の失敗`);
  process.exit(1);
}
console.log('✅ ワークフロー設定テストに合格');

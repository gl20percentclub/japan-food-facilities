// AGENTS.md / docs/ARCHITECTURE.md の「配信の仕組み」の記述が、実態と矛盾していないかを
// 検証する。
//
//   node scripts/architecture-docs.test.js
//
// 実態: 正規の配信先は S3 + CloudFront（food.japan-facilities.com、deploy-s3.yml が担う）で、
// 静的ページ（site/）もデータ（api/）もここが本番。GitHub Pages
// （gl20percentclub.github.io）は本番ではなく、redirect-stubs/ の内容を配信する
// リダイレクト専用サイト（.github/workflows/pages.yml）になっている。
//
// 過去にこの記述が古いままだったため、AGENTS.md を読んだエージェントが「静的ページの正規
// ドメインは GitHub Pages」という誤った前提で調査を始める実害が出た。そのため、この
// テストでは (1) 実態と矛盾する断定的な言い回しが残っていないこと、(2) 正規の配信経路
// （deploy-s3.yml）と GitHub Pages が本番ではないことの両方が言及されていることを固定する。
//
// 言い回しの細部（「です」「である」等の文体、語順）までは固定しない。固定するのは
// 「GitHub Pages が静的ページの配信先である」という趣旨の断定と、「deploy-s3.yml・
// リダイレクト専用」という実態の骨子だけ。細部を変えただけで落ちる壊れやすいテストに
// しないため。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = ['AGENTS.md', 'docs/ARCHITECTURE.md'];

// 実態と矛盾する、かつて実在した断定的な言い回し。1つでも見つかれば巻き戻りとみなす。
const FORBIDDEN_PHRASES = [
  // 「静的ページは GitHub Pages から配信する」という誤った断定（旧 AGENTS.md）。
  '静的ページは GitHub Pages',
  // 「データとページで配信先が違う。データは S3 + CloudFront、静的ページは GitHub Pages」
  // という誤った断定（旧 docs/ARCHITECTURE.md）。
  'データとページで配信先が違う',
  // 「pages.yml が site/ をそのまま gh-pages へ配信する（= 本番）」という誤った断定。
  // 実際には site/ のコピーを redirect-stubs/ で上書きしたものを配信する。
  '`site/` をそのまま gh-pages へ配信',
];

// 実態の骨子として必ず言及されているべきキーワード。
// deploy-s3.yml（正規の配信経路）と、GitHub Pages が本番ではないことの両方を要求する。
const REQUIRED_KEYWORDS = ['deploy-s3.yml', '本番ではな'];

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

console.log('配信構成ドキュメント（AGENTS.md / docs/ARCHITECTURE.md）の整合性検査\n');

for (const relPath of TARGETS) {
  const content = fs.readFileSync(path.join(ROOT, relPath), 'utf-8');

  for (const phrase of FORBIDDEN_PHRASES) {
    assert(
      !content.includes(phrase),
      `${relPath}: 実態と矛盾する言い回し「${phrase}」が残っていない`,
    );
  }

  for (const keyword of REQUIRED_KEYWORDS) {
    assert(
      content.includes(keyword),
      `${relPath}: 実態の骨子「${keyword}」への言及がある`,
    );
  }
}

console.log('');
if (failures > 0) {
  console.error(`❌ 配信構成ドキュメント整合性検査に ${failures} 件の失敗`);
  process.exit(1);
}
console.log('✅ 配信構成ドキュメント整合性検査に合格');

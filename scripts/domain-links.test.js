// 旧ドメイン（gl20percentclub.github.io）へのリンクが、意図しない箇所に
// 残っていないかを検証する。
//
//   node scripts/domain-links.test.js
//
// 公開サイトは https://food.japan-facilities.com/（S3 + CloudFront）へ移行済みで、
// gl20percentclub.github.io（GitHub Pages）は新ドメインへのリダイレクト専用サイトに
// なっている（redirect-stubs/README.md）。そのため、ユーザーやAIエージェント向けの
// 案内・コピペ例が旧ドメインを指していると、リダイレクトを1回余分に踏ませることになる。
//
// 一方で、旧ドメインへの言及がすべて誤りというわけではない。次の箇所は意図的に
// 残している（機械的な一括置換をしなかった理由はコミットメッセージ・報告を参照）。
//   - redirect-stubs/ 以下: リダイレクト先の説明・動作確認手順そのものが旧ドメインの話
//   - docs/ARCHITECTURE.md: 構成図が GitHub Pages という配信先そのものの実ドメイン名を記載
//   - .github/workflows/pages.yml: gh-pages がリダイレクト専用になった経緯のコメント
//   - site/attribution.html・site/llms.txt・site/llms-full.txt: private リポジトリ
//     （japan-facilities-crawler）が生成して push する成果物。このリポジトリでは
//     直接編集しない方針のため、生成元側の修正が必要（別issue）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_DOMAIN = 'gl20percentclub.github.io';

// 意図的に旧ドメインを残している箇所（相対パス）。
const ALLOWED_FILES = new Set([
  'redirect-stubs/README.md',
  'redirect-stubs/index.html',
  'redirect-stubs/map.html',
  'redirect-stubs/playground.html',
  'redirect-stubs/coord-quality.html',
  'redirect-stubs/privacy.html',
  'redirect-stubs/404.html',
  'redirect-stubs/sitemap.xml',
  'docs/ARCHITECTURE.md',
  '.github/workflows/pages.yml',
  // private リポジトリが生成して push する成果物。直接編集しない方針（AGENTS.md）。
  'site/attribution.html',
  'site/llms.txt',
  'site/llms-full.txt',
  // このテスト自身。旧ドメインの文字列を検査条件として持つため、当然含まれる。
  'scripts/domain-links.test.js',
]);

// スキャン対象から除外するディレクトリ。
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.worktrees']);

// テキストとして中身を見る意味がある拡張子だけを対象にする。
const TARGET_EXTENSIONS = new Set(['.md', '.html', '.txt', '.xml', '.yml', '.yaml', '.js']);

/** ディレクトリを再帰的に辿り、対象拡張子のファイルの相対パスを列挙する。 */
function walk(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(fullPath));
    } else if (TARGET_EXTENSIONS.has(path.extname(entry.name))) {
      results.push(fullPath);
    }
  }
  return results;
}

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

console.log('旧ドメイン（gl20percentclub.github.io）リンク検査\n');

const files = walk(ROOT);
let checked = 0;
for (const filePath of files) {
  const relPath = path.relative(ROOT, filePath).split(path.sep).join('/');
  if (ALLOWED_FILES.has(relPath)) continue;
  const content = fs.readFileSync(filePath, 'utf-8');
  if (!content.includes(OLD_DOMAIN)) continue;
  checked++;
  assert(false, `${relPath}: 旧ドメイン（${OLD_DOMAIN}）への意図しない参照が残っている`);
}
if (checked === 0) {
  console.log(`  ✓ 許可リスト外のファイルに旧ドメイン（${OLD_DOMAIN}）への参照が無い`);
}

console.log('');
if (failures > 0) {
  console.error(`❌ 旧ドメインリンク検査に ${failures} 件の失敗`);
  process.exit(1);
}
console.log('✅ 旧ドメインリンク検査に合格');

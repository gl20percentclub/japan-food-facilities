// README.md / CONTRIBUTING.md のライセンス表記まわりを検証する。
//
//   node scripts/readme-license.test.js
//
// 経緯: README.md は「リポジトリ内のコードは MIT License」と書いているが、
// リポジトリのルートに LICENSE ファイルを置いていない（意図的な選択。GitHub は
// ルートに LICENSE を置くとリポジトリ全体に MIT のライセンスバッジを表示し、
// 配信しているデータ（CSV・ベクトルタイル）まで MIT だと誤解されるおそれがある
// ため、あえて置いていない）。そのため「MIT License」という文言自体は残しつつ、
// 存在しない LICENSE ファイルへのリンクだけは張らない、という状態を固定する。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

console.log('README / CONTRIBUTING のライセンス表記テスト\n');

// --- リポジトリのルートに LICENSE ファイルを置かない方針を固定する ---
// 置くと GitHub がリポジトリ全体に MIT バッジを出し、配信データまで MIT だと
// 誤解されるおそれがあるため、意図的に置いていない。
for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
  assert(!fs.existsSync(path.join(ROOT, name)), `${name} をリポジトリのルートに置いていない`);
}

// --- README.md / CONTRIBUTING.md の記載内容 ---
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8');
const contributing = fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf-8');

for (const [name, content] of [['README.md', readme], ['CONTRIBUTING.md', contributing]]) {
  // 「コードは MIT License」という文言そのものは残す。
  assert(content.includes('MIT License'), `${name}: 「MIT License」という文言が残っている`);
  // ただし LICENSE ファイルは存在しないので、そこへのリンクは張らない
  // （張ると 404 になる）。
  assert(!/\]\(LICENSE(?:\.md|\.txt)?\)/.test(content), `${name}: 存在しない LICENSE ファイルへのリンクを張っていない`);
}

// --- README.md 内のローカル相対リンクが実在のファイルを指しているか ---
// http(s) 以外の宛先（相対パス）を持つ Markdown リンクを洗い出し、
// アンカー（#以降）を除いたパスがリポジトリ内に実在することを確認する。
// LICENSE リンクの再発だけでなく、同種のリンク切れを一般に防ぐ。
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
for (const match of readme.matchAll(LINK_RE)) {
  const target = match[1];
  if (/^https?:\/\//.test(target) || target.startsWith('#')) continue;
  const relPath = target.split('#')[0];
  assert(
    fs.existsSync(path.join(ROOT, relPath)),
    `README.md: ローカルリンク「${target}」の参照先（${relPath}）が実在する`,
  );
}

console.log('');
if (failures > 0) {
  console.error(`❌ README / CONTRIBUTING のライセンス表記テストに ${failures} 件の失敗`);
  process.exit(1);
}
console.log('✅ README / CONTRIBUTING のライセンス表記テストに合格');

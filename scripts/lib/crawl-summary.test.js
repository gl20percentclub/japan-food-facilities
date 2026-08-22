// crawl-summary のユニットテスト。
//   node scripts/lib/crawl-summary.test.js
// 「取得0件」「取得エラー」「前回比の大幅減」の3種類の問題検知ロジックを固定入力で検証する。

import assert from 'node:assert/strict';
import {
  buildSourceSummary,
  detectProblems,
  shouldPersistSummary,
  summaryToMap,
  DEFAULT_DROP_THRESHOLD,
  DEFAULT_DROP_MIN_PREVIOUS,
} from './crawl-summary.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// --- buildSourceSummary ---
test('buildSourceSummary: 件数とエラーをソース定義順にまとめる', () => {
  const sources = [
    { key: 'a', source: 'A市' },
    { key: 'b', source: 'B市' },
  ];
  const kept = new Map([['a', 100]]); // b は未登録（0件扱い）
  const errors = new Map([['b', 'ダウンロード失敗: 404 Not Found']]);
  const summary = buildSourceSummary(sources, kept, errors);
  assert.deepEqual(summary, [
    { key: 'a', name: 'A市', count: 100, error: null },
    { key: 'b', name: 'B市', count: 0, error: 'ダウンロード失敗: 404 Not Found' },
  ]);
});

// --- detectProblems: 取得0件 ---
test('detectProblems: 取得0件は zero として検知する', () => {
  const summary = [{ key: 'a', name: 'A市', count: 0, error: null }];
  const problems = detectProblems(summary, null);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].type, 'zero');
  assert.equal(problems[0].key, 'a');
});

// --- detectProblems: エラー ---
test('detectProblems: 取得エラーは error として検知し、0件チェックより優先する', () => {
  const summary = [{ key: 'a', name: 'A市', count: 0, error: 'timeout' }];
  const problems = detectProblems(summary, null);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].type, 'error');
  assert.equal(problems[0].error, 'timeout');
});

// --- detectProblems: 大幅減（drop） ---
test('detectProblems: 前回比30%以上の減少は drop として検知する', () => {
  const summary = [{ key: 'a', name: 'A市', count: 60, error: null }]; // 100 -> 60 は40%減
  const previous = summaryToMap([{ key: 'a', count: 100 }]);
  const problems = detectProblems(summary, previous);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].type, 'drop');
  assert.equal(problems[0].previousCount, 100);
  assert.ok(Math.abs(problems[0].dropRatio - 0.4) < 1e-9);
});

test('detectProblems: 閾値未満の減少（30%未満）は検知しない', () => {
  const summary = [{ key: 'a', name: 'A市', count: 80, error: null }]; // 100 -> 80 は20%減
  const previous = summaryToMap([{ key: 'a', count: 100 }]);
  assert.deepEqual(detectProblems(summary, previous), []);
});

test('detectProblems: 前回件数が閾値未満（20件未満）の母数は drop 判定から除外する', () => {
  const summary = [{ key: 'a', name: 'A市', count: 1, error: null }]; // 10 -> 1 は90%減だが母数が小さい
  const previous = summaryToMap([{ key: 'a', count: 10 }]);
  assert.deepEqual(detectProblems(summary, previous), []);
});

test('detectProblems: 前回サマリが無い（初回実行）ときは drop 判定をスキップする', () => {
  const summary = [{ key: 'a', name: 'A市', count: 1, error: null }];
  assert.deepEqual(detectProblems(summary, null), []);
});

test('detectProblems: 増加は検知しない', () => {
  const summary = [{ key: 'a', name: 'A市', count: 150, error: null }];
  const previous = summaryToMap([{ key: 'a', count: 100 }]);
  assert.deepEqual(detectProblems(summary, previous), []);
});

test('detectProblems: 問題の無いソースは混ざっていても無視する', () => {
  const summary = [
    { key: 'a', name: 'A市', count: 100, error: null },
    { key: 'b', name: 'B市', count: 0, error: null },
  ];
  const previous = summaryToMap([{ key: 'a', count: 100 }]);
  const problems = detectProblems(summary, previous);
  assert.deepEqual(problems.map((p) => p.key), ['b']);
});

test('detectProblems: 閾値はオプションで上書きできる', () => {
  const summary = [{ key: 'a', name: 'A市', count: 90, error: null }]; // 100 -> 90 は10%減
  const previous = summaryToMap([{ key: 'a', count: 100 }]);
  assert.deepEqual(detectProblems(summary, previous, { dropThreshold: 0.05 }).map((p) => p.key), ['a']);
  assert.deepEqual(detectProblems(summary, previous, { dropThreshold: 0.2 }), []);
});

test('既定の閾値定数が想定どおりにexportされている', () => {
  assert.equal(DEFAULT_DROP_THRESHOLD, 0.3);
  assert.equal(DEFAULT_DROP_MIN_PREVIOUS, 20);
});

// --- shouldPersistSummary ---
test('shouldPersistSummary: 通常実行は保存する', () => {
  assert.equal(shouldPersistSummary({ dryRun: false, only: null }), true);
});
test('shouldPersistSummary: --dry-run は保存しない', () => {
  assert.equal(shouldPersistSummary({ dryRun: true, only: null }), false);
});
test('shouldPersistSummary: --only（部分実行）は保存しない', () => {
  assert.equal(shouldPersistSummary({ dryRun: false, only: new Set(['a']) }), false);
});

// --- summaryToMap ---
test('summaryToMap: key -> {count} の Map に変換する', () => {
  const map = summaryToMap([{ key: 'a', name: 'A市', count: 5 }]);
  assert.deepEqual(map.get('a'), { count: 5 });
  assert.equal(map.get('missing'), undefined);
});

console.log(`\n✅ crawl-summary.js ユニットテスト: ${passed}件すべて合格`);

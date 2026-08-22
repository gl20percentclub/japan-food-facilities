// notify-slack のユニットテスト。
//   node scripts/lib/notify-slack.test.js
// 実際に Slack へは送信しない（webhookを持っていない）。かわりに:
//   - buildSlackMessage: 検知した問題からペイロードを組み立てる純粋関数を固定入力で検証
//   - sendSlackNotification: fetch をモックに差し替え、渡されるペイロード・
//     未設定時のスキップ・失敗時の非throwを検証する

import assert from 'node:assert/strict';
import { buildSlackMessage, sendSlackNotification } from './notify-slack.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const asyncTests = [];
function testAsync(name, fn) {
  asyncTests.push({ name, fn });
}

// --- buildSlackMessage ---
test('buildSlackMessage: 問題が0件なら null（通知不要）', () => {
  assert.equal(buildSlackMessage([], { totalSources: 10, updatedAt: '2026-08-23T00:00:00.000Z' }), null);
  assert.equal(buildSlackMessage(null, { totalSources: 10, updatedAt: '2026-08-23T00:00:00.000Z' }), null);
});

test('buildSlackMessage: zero/error/drop それぞれの内容を1行に含める', () => {
  const problems = [
    { key: 'a', name: 'A市', type: 'zero', count: 0, previousCount: 500, dropRatio: null, error: null },
    { key: 'b', name: 'B市', type: 'error', count: 0, previousCount: null, dropRatio: null, error: '404 Not Found' },
    { key: 'c', name: 'C市', type: 'drop', count: 60, previousCount: 100, dropRatio: 0.4, error: null },
  ];
  const msg = buildSlackMessage(problems, { totalSources: 81, updatedAt: '2026-08-23T00:00:00.000Z' });
  assert.ok(msg && msg.text && Array.isArray(msg.blocks));
  const text = JSON.stringify(msg);
  // どのソースが・どう問題なのか・前回との差、が含まれること
  assert.ok(text.includes('a') && text.includes('A市') && text.includes('取得0件'));
  assert.ok(text.includes('b') && text.includes('404 Not Found'));
  assert.ok(text.includes('c') && text.includes('100件') && text.includes('60件') && text.includes('40%減'));
  // 次のアクションが分かる文言が含まれること
  assert.ok(text.includes('sources.yaml'));
});

test('buildSlackMessage: 問題が21件以上は先頭20件+残数注記に絞る（Slack section 3000文字制限対策）', () => {
  const problems = Array.from({ length: 25 }, (_, i) => ({
    key: `s${i}`,
    name: `市${i}`,
    type: 'zero',
    count: 0,
    previousCount: null,
    dropRatio: null,
    error: null,
  }));
  const msg = buildSlackMessage(problems, { totalSources: 81, updatedAt: '2026-08-23T00:00:00.000Z' });
  const text = JSON.stringify(msg);
  assert.ok(text.includes('他 5件'));
  assert.ok(text.includes('s19'), '先頭20件目（s19）は含まれる');
  assert.ok(!text.includes('"s20"'), '21件目（s20）は省略される');
});

// --- sendSlackNotification ---
testAsync('sendSlackNotification: webhookUrl未設定はネットワークを叩かずスキップを返す', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error('呼ばれてはいけない');
  };
  const result = await sendSlackNotification({ text: 'x' }, { webhookUrl: undefined, fetchImpl });
  assert.deepEqual(result, { ok: true, skipped: true });
  assert.equal(called, false);
});

testAsync('sendSlackNotification: payloadがnull（問題なし）はスキップする', async () => {
  const result = await sendSlackNotification(null, { webhookUrl: 'https://hooks.slack.example/x' });
  assert.deepEqual(result, { ok: true, skipped: true });
});

testAsync('sendSlackNotification: 正しいURL・メソッド・JSON本文でPOSTする', async () => {
  let capturedUrl, capturedOpts;
  const fetchImpl = async (url, opts) => {
    capturedUrl = url;
    capturedOpts = opts;
    return { ok: true, status: 200, statusText: 'OK' };
  };
  const payload = { text: 'hello', blocks: [] };
  const result = await sendSlackNotification(payload, {
    webhookUrl: 'https://hooks.slack.example/services/x',
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(capturedUrl, 'https://hooks.slack.example/services/x');
  assert.equal(capturedOpts.method, 'POST');
  assert.equal(capturedOpts.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(capturedOpts.body), payload);
});

testAsync('sendSlackNotification: Slackが非2xxを返しても例外を投げず ok:false を返す', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' });
  const result = await sendSlackNotification({ text: 'x' }, { webhookUrl: 'https://hooks.slack.example/x', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
});

testAsync('sendSlackNotification: fetchが例外を投げても呼び出し元には伝播しない', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const result = await sendSlackNotification({ text: 'x' }, { webhookUrl: 'https://hooks.slack.example/x', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'network down');
});

const runAsync = async () => {
  for (const { name, fn } of asyncTests) {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n✅ notify-slack.js ユニットテスト: ${passed}件すべて合格`);
};

runAsync().catch((err) => {
  console.error('\n❌ テスト失敗:', err);
  process.exit(1);
});

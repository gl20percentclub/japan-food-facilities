// acquire.js のユニットテスト（自前 assert、node scripts/lib/acquire.test.js で実行）。
//
// 対象:
//   - extractDateToken / selectLatestCandidate: 日付抽出・最新候補選択の純粋ロジック
//   - resolveLinkFromHtml: 複数候補からのリンク解決（既定挙動 と pickLatest オプション）
//   - resolveCkanDownloadUrl: CKAN datastore 専用リソースへのフォールバック
//   - acquire(): ckan の resourceId 配列対応・datastore フォールバック・resolve pickLatest の結合動作
//     （global.fetch を一時的に差し替えてネットワークなしで検証する）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractDateToken,
  selectLatestCandidate,
  resolveLinkFromHtml,
  resolveCkanDownloadUrl,
  acquire,
} from './acquire.js';

let failures = 0;
/** 条件を検証して結果を出力する（失敗数を数える）。 */
function check(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

/** 例外が投げられることを検証する。 */
function assertThrows(fn, msg) {
  try {
    fn();
    console.error(`  ✗ ${msg}（例外が投げられなかった）`);
    failures++;
  } catch (e) {
    console.log(`  ✓ ${msg}: ${e.message}`);
  }
}

console.log('acquire テスト\n');

// ============================================================
// extractDateToken
// ============================================================
console.log('--- extractDateToken ---');

check(extractDateToken('Shokuhin_itiran_R08.csv')?.value === 20260000, '和暦「年のみ」R08 -> 20260000（令和8年=2026年）');
check(extractDateToken('Shokuhin_itiran_R07.csv')?.value === 20250000, '和暦「年のみ」R07 -> 20250000（令和7年=2025年）');
check(extractDateToken('Shokuhin_itiran_R08.csv')?.era === 'wareki', '和暦「年のみ」の era は wareki');
check(extractDateToken('zenkenr080331.csv')?.value === 20260331, '和暦「年月日」r080331 -> 20260331');
check(extractDateToken('R0803zenshisetsuichiran.xls')?.value === 20260300, '和暦「年月」R0803 -> 20260300');
check(extractDateToken('232033_Food_Business_All_20260331.csv')?.value === 20260331, '西暦8桁 20260331 -> 20260331');
check(extractDateToken('20260407150739.csv')?.value === 20260407, '西暦8桁+時刻14桁の先頭8桁を採用: 20260407150739 -> 20260407');
check(extractDateToken('syokuhineiseidaityou202401.csv')?.value === 20240100, '西暦6桁 202401 -> 20240100');
check(extractDateToken('2026ALL-IND-CSV.csv')?.value === 20260000, '西暦4桁 2026 -> 20260000');
check(
  extractDateToken('全ての許可施設（2026年3月末現在）')?.value === 20260300,
  '西暦+漢字「2026年3月末現在」-> 20260300',
);
check(
  extractDateToken('全ての許可施設（2021年5月末現在）')?.value === 20210500,
  '西暦+漢字「2021年5月末現在」-> 20210500',
);
check(extractDateToken('syokuhineigyoukyoka.csv') === null, '日付が全く含まれない文字列は null');
check(extractDateToken('r30531_all_.csv')?.value === 20210531, '和暦「年月日」r30531（1桁年、区切りなし）-> 20210531');
check(extractDateToken('r30531_all_.csv')?.era === 'wareki', 'r30531 の era は wareki');

// ============================================================
// selectLatestCandidate
// ============================================================
console.log('\n--- selectLatestCandidate ---');

{
  const r08first = [
    { url: 'https://x/Shokuhin_itiran_R08.csv', text: '' },
    { url: 'https://x/Shokuhin_itiran_R07.csv', text: '' },
  ];
  const r07first = [
    { url: 'https://x/Shokuhin_itiran_R07.csv', text: '' },
    { url: 'https://x/Shokuhin_itiran_R08.csv', text: '' },
  ];
  check(
    selectLatestCandidate(r08first).winner.url.endsWith('R08.csv'),
    '和暦 R08 vs R07（R08が先）: R08 が選ばれる',
  );
  check(
    selectLatestCandidate(r07first).winner.url.endsWith('R08.csv'),
    '和暦 R08 vs R07（R07が先、DOM順逆転）: それでも R08 が選ばれる',
  );
}

{
  // 西暦8桁の候補同士で正しく最大値が選ばれることを固定する。
  const cands = [
    { url: 'https://x/a_20250630.csv', text: '' },
    { url: 'https://x/a_20260331.csv', text: '' },
    { url: 'https://x/a_20251231.csv', text: '' },
  ];
  check(selectLatestCandidate(cands).winner.url.endsWith('20260331.csv'), '西暦8桁3候補: 最大の20260331が選ばれる');
}

assertThrows(
  () =>
    selectLatestCandidate([
      { url: 'https://x/a_20260331.csv', text: '' },
      { url: 'https://x/Shokuhin_itiran_R08.csv', text: '' },
    ]),
  '西暦と和暦が候補間で混在すると比較できず例外',
);

assertThrows(
  () =>
    selectLatestCandidate([
      { url: 'https://x/opaque-id-1.csv', text: '' },
      { url: 'https://x/opaque-id-2.csv', text: '' },
    ]),
  '日付を抽出できる候補が1件も無いと例外（黙って先頭を返さない）',
);

{
  // 日付を抽出できる候補と抽出できない候補が混在するとき、抽出できないものは除外して比較する。
  const cands = [
    { url: 'https://x/opaque-id.csv', text: '' },
    { url: 'https://x/a_20260331.csv', text: '' },
    { url: 'https://x/a_20250101.csv', text: '' },
  ];
  const { winner, skipped } = selectLatestCandidate(cands);
  check(winner.url.endsWith('20260331.csv'), '日付なし候補混在: 日付ありの中から最大が選ばれる');
  check(skipped.length === 1 && skipped[0].url.endsWith('opaque-id.csv'), '日付なし候補混在: 除外された候補が skipped に入る');
}

// ============================================================
// resolveLinkFromHtml（既定挙動: pickLatest 未指定）
// ============================================================
console.log('\n--- resolveLinkFromHtml（既定挙動） ---');

{
  // 既存32件の resolve が依存している「DOM順の先頭を採用」を固定する。
  // pickLatest を渡さない限り、旧いリンクが先にあっても先頭がそのまま採用されるべき。
  const html = `
    <a href="/old.csv">古いファイル</a>
    <a href="/new.csv">新しいファイル</a>
  `;
  const hit = resolveLinkFromHtml(html, { format: 'csv' });
  check(hit.url === '/old.csv', '既定挙動: 複数一致でも DOM順の先頭を採用する（回帰防止）');
  check(hit.count === 2, '既定挙動: count は一致件数の合計');
  check(hit.all.length === 2, '既定挙動: all に全候補が入る');
}

check(resolveLinkFromHtml('<p>no links here</p>', { format: 'csv' }) === null, '一致0件のとき null を返す');

// ============================================================
// resolveLinkFromHtml（pickLatest: true）
// ============================================================
console.log('\n--- resolveLinkFromHtml（pickLatest: true） ---');

// いわき市を模したフィクスチャ: 年ベースのCSV（R07/R08）と、同じページに並ぶ月次差分（R0604等、4桁）。
// hrefPattern は「Shokuhin_itiran_R + 2桁のみ + .csv」に絞り、月次差分を除外する。
const iwakiHtmlOldFirst = `
  <a href="/simple/Shokuhin_itiran_R07.csv">（CSV type）（796KB）</a>
  <a href="/simple/Shokuhin_itiran_R08.csv">（CSV type）（1008KB）</a>
  <a href="/simple/Shokuhin_itiran_R0604.csv">（CSV type）（4KB）</a>
  <a href="/simple/Shokuhin_itiran_R0803.csv">（CSV type）（6KB）</a>
`;
const iwakiHtmlNewFirst = `
  <a href="/simple/Shokuhin_itiran_R08.csv">（CSV type）（1008KB）</a>
  <a href="/simple/Shokuhin_itiran_R07.csv">（CSV type）（796KB）</a>
  <a href="/simple/Shokuhin_itiran_R0604.csv">（CSV type）（4KB）</a>
  <a href="/simple/Shokuhin_itiran_R0803.csv">（CSV type）（6KB）</a>
`;
{
  const opts = { hrefPattern: 'Shokuhin_itiran_R\\d{2}\\.csv$', format: 'csv', pickLatest: true, baseUrl: 'https://city.iwaki.example/index.html' };
  const hitOld = resolveLinkFromHtml(iwakiHtmlOldFirst, opts);
  const hitNew = resolveLinkFromHtml(iwakiHtmlNewFirst, opts);
  check(hitOld.url.endsWith('Shokuhin_itiran_R08.csv'), 'いわき市想定: hrefPattern で月次差分を除外しR08(最新)が選ばれる（古い→新しい順）');
  check(hitNew.url.endsWith('Shokuhin_itiran_R08.csv'), 'いわき市想定: DOM順を入れ替えても同じR08が選ばれる（新しい→古い順）');
  check(hitOld.count === 2, 'いわき市想定: hrefPattern一致は2件（R07/R08。月次差分は候補にすら入らない）');
}

// 神戸市を模したフィクスチャ: 現行版（2026年）と改正前旧法版（2021年）が同じ文言テンプレで並存。
// href は現行版が14桁タイムスタンプ、旧法版が和暦ファイル名で表記が揃っていないため、
// 日付はリンク文言（西暦+漢字）から取る前提のフィクスチャ。
const kobeHtmlCurrentFirst = `
  <a href="/documents/6359/20260407150739.csv">全ての許可施設（2026年3月末現在。同時点で許可満了日を過ぎている施設を除く。）（CSV：3,777KB）</a>
  <a href="/documents/6359/0804_syokuhin.csv">2026年4月新規許可施設（CSV：60KB）</a>
  <a href="/documents/6359/r30531_all_.csv">全ての許可施設（2021年5月末現在。同時点で許可満了日を過ぎている施設を除く。）（CSV：5,840KB）</a>
`;
// 「意図的に候補順を入れ替えたケース」（回帰の本丸）: 2021年版を先頭に持ってくる。
const kobeHtmlOldFirst = `
  <a href="/documents/6359/r30531_all_.csv">全ての許可施設（2021年5月末現在。同時点で許可満了日を過ぎている施設を除く。）（CSV：5,840KB）</a>
  <a href="/documents/6359/0804_syokuhin.csv">2026年4月新規許可施設（CSV：60KB）</a>
  <a href="/documents/6359/20260407150739.csv">全ての許可施設（2026年3月末現在。同時点で許可満了日を過ぎている施設を除く。）（CSV：3,777KB）</a>
`;
{
  const opts = { pattern: '^全ての許可施設', format: 'csv', pickLatest: true, baseUrl: 'https://city.kobe.example/dataset.html' };
  const hitCurrentFirst = resolveLinkFromHtml(kobeHtmlCurrentFirst, opts);
  const hitOldFirst = resolveLinkFromHtml(kobeHtmlOldFirst, opts);
  check(
    hitCurrentFirst.url.endsWith('20260407150739.csv'),
    '神戸市想定（現行版が先）: 2026年版が選ばれる',
  );
  check(
    hitOldFirst.url.endsWith('20260407150739.csv'),
    '神戸市想定【回帰の本丸】: 候補順を意図的に入れ替え（2021年版を先頭）ても、2026年版が選ばれる',
  );
  check(hitOldFirst.count === 2, '神戸市想定: linkPattern一致は2件（月次新規許可施設は含まれない）');
}

// 日付の表記（西暦/和暦）が混在すると比較不能として resolveLinkFromHtml 経由でも例外になることを固定する。
assertThrows(() => {
  const html = `
    <a href="/a_20260331.csv">a</a>
    <a href="/Shokuhin_itiran_R08.csv">b</a>
  `;
  resolveLinkFromHtml(html, { format: 'csv', pickLatest: true });
}, 'pickLatest: 西暦/和暦混在の候補は resolveLinkFromHtml 経由でも例外');

// 日付を抽出できる候補が1件も無いと例外になることを固定する（黙って先頭を返さない）。
assertThrows(() => {
  const html = `
    <a href="/opaque-a.csv">a</a>
    <a href="/opaque-b.csv">b</a>
  `;
  resolveLinkFromHtml(html, { format: 'csv', pickLatest: true });
}, 'pickLatest: 日付を抽出できる候補が1件も無いと例外');

// ============================================================
// resolveCkanDownloadUrl
// ============================================================
console.log('\n--- resolveCkanDownloadUrl ---');

check(
  resolveCkanDownloadUrl('https://ckan.example', 'abc', { url: 'https://files.example/a.csv', datastore_active: false }) ===
    'https://files.example/a.csv',
  'result.url があればそれをそのまま使う（既定挙動、既存39件の ckan を壊さない）',
);
check(
  resolveCkanDownloadUrl('https://catalog-data.city.kanazawa.ishikawa.jp', '09a49521-cabf-40b4-978b-bd61ef02f650', {
    url: '',
    datastore_active: true,
  }) === 'https://catalog-data.city.kanazawa.ishikawa.jp/datastore/dump/09a49521-cabf-40b4-978b-bd61ef02f650',
  'url が空で datastore_active:true なら datastore/dump にフォールバック（金沢市の実際のAPI応答で確認済み）',
);
assertThrows(
  () => resolveCkanDownloadUrl('https://ckan.example', 'abc', { url: '', datastore_active: false }),
  'url が空でも datastore_active が無ければ（別の理由で空の可能性があるため）誤動作せず例外',
);
assertThrows(
  () => resolveCkanDownloadUrl('https://ckan.example', 'abc', { url: '' }),
  'url が空で datastore_active フィールド自体が無いケースも例外（黙って空URLを使わない）',
);

// ============================================================
// acquire()（結合動作。global.fetch を一時差し替えてネットワークなしで検証）
// ============================================================
console.log('\n--- acquire()（ckan resourceId 配列 / datastore フォールバック / resolve pickLatest） ---');

/** テスト用の一時 cacheDir を作る。 */
function makeTmpCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acquire-test-'));
}

/** global.fetch を差し替えて実行し、必ず元に戻す。 */
async function withMockFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

await (async () => {
  // 既存の ckan（resourceId が単一文字列）が、これまでどおり1回だけ resource_show を叩き、
  // その id がそのまま使われることを固定する（既存39件の回帰防止）。
  const calls = [];
  await withMockFetch(
    async (url) => {
      calls.push(String(url));
      if (String(url).includes('resource_show')) {
        return { ok: true, json: async () => ({ success: true, result: { url: 'https://files.example/single.csv', format: 'CSV' } }) };
      }
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode('a,b\n1,2\n').buffer };
    },
    async () => {
      const cacheDir = makeTmpCacheDir();
      const source = { key: 'existing-ckan', acquire: { type: 'ckan', ckanBase: 'https://ckan.example', resourceId: 'single-id' } };
      const results = await acquire(source, { cacheDir });
      check(results.length === 1, 'ckan(単一resourceId・既存挙動): 結果は1件');
      check(
        calls.some((u) => u.includes('id=single-id')),
        'ckan(単一resourceId・既存挙動): resource_show に元のIDがそのまま渡る',
      );
    },
  );
})();

await (async () => {
  // ckan の resourceId を配列にしたとき（福井県想定）、2つとも resource_show が叩かれ、
  // 2ファイルとも取得されることを固定する。
  const calls = [];
  await withMockFetch(
    async (url) => {
      calls.push(String(url));
      const m = String(url).match(/id=([^&]+)/);
      if (String(url).includes('resource_show')) {
        return {
          ok: true,
          json: async () => ({ success: true, result: { url: `https://files.example/${m[1]}.csv`, format: 'CSV' } }),
        };
      }
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode('a,b\n1,2\n').buffer };
    },
    async () => {
      const cacheDir = makeTmpCacheDir();
      const source = {
        key: 'fukui-pref-like',
        acquire: { type: 'ckan', ckanBase: 'https://ckan.example', resourceId: ['res-776', 'res-777'], format: 'csv' },
      };
      const results = await acquire(source, { cacheDir });
      check(results.length === 2, 'ckan(resourceId配列): 2つのresourceIdから2ファイル取得できる');
      check(
        calls.filter((u) => u.includes('resource_show')).length === 2,
        'ckan(resourceId配列): resource_show が2回（各IDごとに1回）呼ばれる',
      );
      // 2回とも同じ resourceId で呼ばれていないか（配列の2件目以降を無視していないか）を明示的に確認する。
      check(
        calls.some((u) => u.includes('resource_show') && u.includes('id=res-776')) &&
          calls.some((u) => u.includes('resource_show') && u.includes('id=res-777')),
        'ckan(resourceId配列): resource_show が res-776 / res-777 それぞれ別のIDで呼ばれている（2件目以降を無視していない）',
      );
      check(
        fs.existsSync(path.join(cacheDir, 'fukui-pref-like-0.csv')) && fs.existsSync(path.join(cacheDir, 'fukui-pref-like-1.csv')),
        'ckan(resourceId配列): key-0 / key-1 でキャッシュされる（get型のurls複数指定と同じ命名規則）',
      );
    },
  );
})();

await (async () => {
  // 金沢市想定: resource_show が url="" + datastore_active:true を返すとき、
  // 実際にダウンロードされる URL が datastore/dump にフォールバックしていることを固定する。
  const downloadedUrls = [];
  await withMockFetch(
    async (url) => {
      const s = String(url);
      if (s.includes('resource_show')) {
        return { ok: true, json: async () => ({ success: true, result: { url: '', format: 'CSV', datastore_active: true } }) };
      }
      downloadedUrls.push(s);
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode('a,b\n1,2\n').buffer };
    },
    async () => {
      const cacheDir = makeTmpCacheDir();
      const source = {
        key: 'kanazawa-like',
        acquire: { type: 'ckan', ckanBase: 'https://catalog-data.example', resourceId: 'kanazawa-resource-id', format: 'csv' },
      };
      const results = await acquire(source, { cacheDir });
      check(results.length === 1, 'ckan(datastoreフォールバック): 結果は1件取得できる');
      check(
        downloadedUrls.some((u) => u === 'https://catalog-data.example/datastore/dump/kanazawa-resource-id'),
        'ckan(datastoreフォールバック): 実際に datastore/dump URL からダウンロードされている',
      );
    },
  );
})();

await (async () => {
  // resolve + pickLatest: 神戸市想定のページ（候補順を意図的に入れ替え＝2021年版が先）から、
  // 実際にダウンロードされる URL が2026年版（最新）になっていることを acquire() を通して固定する。
  const downloadedUrls = [];
  await withMockFetch(
    async (url) => {
      const s = String(url);
      if (s.includes('dataset.html')) {
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode(kobeHtmlOldFirst).buffer };
      }
      downloadedUrls.push(s);
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode('a,b\n1,2\n').buffer };
    },
    async () => {
      const cacheDir = makeTmpCacheDir();
      const source = {
        key: 'kobe-like',
        acquire: {
          type: 'resolve',
          pageUrl: 'https://city.kobe.example/dataset.html',
          linkPattern: '^全ての許可施設',
          format: 'csv',
          pickLatest: true,
        },
      };
      const results = await acquire(source, { cacheDir });
      check(results.length === 1, 'resolve+pickLatest(結合): 結果は1件取得できる');
      check(
        downloadedUrls.some((u) => u.endsWith('/documents/6359/20260407150739.csv')),
        'resolve+pickLatest(結合)【回帰の本丸】: 候補順を入れ替えたページでも実際にダウンロードされるのは2026年版',
      );
      check(
        !downloadedUrls.some((u) => u.endsWith('r30531_all_.csv')),
        'resolve+pickLatest(結合): 2021年版（旧法）は取得されない',
      );
    },
  );
})();

console.log(failures === 0 ? '\n✅ すべて成功' : `\n❌ ${failures}件 失敗`);
process.exit(failures === 0 ? 0 : 1);

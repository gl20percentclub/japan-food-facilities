// 地図ページ(map.html)と build/tiles.js の生成物との整合性テスト。
// 業種フィルターの整合性は scripts/map-filter.test.js が見る。
//   node scripts/preview-map.test.js
//
// map.html はベクトルタイル(api/tiles)を直接読むため、レイヤ名・ズーム範囲・
// タイルパス・利用する属性・metadata.json の統計フィールドが build/tiles.js の出力と
// ズレると地図が黙って壊れる。ここでは実際に generateTiles を走らせた生成物と
// map.html の記述を突き合わせ、両者が食い違ったら失敗させる。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFeatureCollection, generateTiles, thinFeatures } from './build/tiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'site', 'map.html'), 'utf-8');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// map.html から地図設定に使っている値を素朴に抽出する（フルパーサは不要）。
function htmlValue(re, label) {
  const m = HTML.match(re);
  assert.ok(m, `map.html から ${label} を抽出できる`);
  return m[1];
}

const FACILITIES = [
  { name: '店A', business_type: '飲食店営業', address: '千代田区丸の内1-1', lat: 35.681, lng: 139.767, geocoding_level: 8, pref: '東京都', city: '千代田区' },
];
const STATS = { rowsOut: 1, prefectures: 1, cities: 1 };

/** 一時ディレクトリにタイルを焼き、metadata.json を返す（生成が非同期のため async）。 */
async function withTiles(opts, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-test-'));
  try {
    const outDir = path.join(dir, 'tiles');
    await generateTiles(FACILITIES, { outDir, stats: STATS, log: () => {}, ...opts });
    fn(JSON.parse(fs.readFileSync(path.join(outDir, 'metadata.json'), 'utf-8')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await test('source-layer が タイル生成の出力レイヤ名(metadata.vector_layers[0].id)と一致する', async () => {
  const sourceLayer = htmlValue(/'source-layer':\s*'([^']+)'/, 'source-layer');
  await withTiles({ minZoom: 3, maxZoom: 12 }, (meta) => {
    assert.equal(sourceLayer, meta.vector_layers[0].id, `source-layer(${sourceLayer}) == 生成レイヤ(${meta.vector_layers[0].id})`);
  });
});

await test('TILE_MIN_ZOOM / TILE_MAX_ZOOM が タイル生成の既定ズーム範囲と一致する', async () => {
  const minZoom = Number(htmlValue(/TILE_MIN_ZOOM\s*=\s*(\d+)/, 'TILE_MIN_ZOOM'));
  const maxZoom = Number(htmlValue(/TILE_MAX_ZOOM\s*=\s*(\d+)/, 'TILE_MAX_ZOOM'));
  // 既定のズーム範囲(scripts/build/tiles.js の MIN_ZOOM/MAX_ZOOM)で生成する。
  await withTiles({}, (meta) => {
    assert.equal(minZoom, meta.minzoom, `TILE_MIN_ZOOM(${minZoom}) == metadata.minzoom(${meta.minzoom})`);
    assert.equal(maxZoom, meta.maxzoom, `TILE_MAX_ZOOM(${maxZoom}) == metadata.maxzoom(${meta.maxzoom})`);
  });
});

await test('初期ズームがタイルの最小ズーム以上で、開いた直後から点が出る', async () => {
  // タイルが無いズームで開くと点が1つも出ない。初期ズームは必ずタイルの
  // 最小ズーム以上にする（定数を直接使っていることも確認する）。
  assert.ok(/zoom: INITIAL_ZOOM/.test(HTML), '初期ズームに INITIAL_ZOOM を使う');
  assert.ok(!/fitBoundsOptions/.test(HTML), '全国 fitBounds で初期表示していない');
  await withTiles({}, (meta) => {
    const initialZoom = Number(htmlValue(/INITIAL_ZOOM\s*=\s*(\d+)/, 'INITIAL_ZOOM'));
    assert.ok(
      initialZoom >= meta.minzoom,
      `初期ズーム(${initialZoom}) がタイルの最小ズーム(${meta.minzoom})以上`,
    );
  });
  // 地図の下限がタイルの最小ズームより下だと、引いたときに点が消えるズームに到達できる。
  assert.ok(/minZoom: TILE_MIN_ZOOM/.test(HTML), '地図の下限をタイルの最小ズームに揃える');
  // 初期中心が日本の範囲（タイルの bounds）に収まっていること。
  const center = htmlValue(/INITIAL_CENTER = \[([^\]]+)\]/, 'INITIAL_CENTER')
    .split(',').map((v) => Number(v.trim()));
  const bounds = htmlValue(/JAPAN_BOUNDS = \[([^\]]+)\]/, 'JAPAN_BOUNDS')
    .split(',').map((v) => Number(v.trim()));
  assert.ok(center[0] > bounds[0] && center[0] < bounds[2], `初期中心の経度(${center[0]}) が日本の範囲内`);
  assert.ok(center[1] > bounds[1] && center[1] < bounds[3], `初期中心の緯度(${center[1]}) が日本の範囲内`);
});

await test('タイルURLテンプレートが「api/tiles/ + metadata.tiles[0]」の配置と一致する', async () => {
  // データは CloudFront 配信のため、map.html は API_BASE（.../api）を基点に組み立てる。
  // API_BASE と組み立て後のパスを突き合わせ、配信物の配置と一致するか検証する。
  const apiBase = htmlValue(/API_BASE\s*=\s*'([^']+)'/, 'API_BASE');
  assert.ok(apiBase.endsWith('/api'), `API_BASE(${apiBase}) が api/ を指す`);
  await withTiles({ minZoom: 3, maxZoom: 12 }, (meta) => {
    const expectedPath = `\${API_BASE}/tiles/${meta.tiles[0]}`; // = ${API_BASE}/tiles/{z}/{x}/{y}.pbf
    assert.ok(HTML.includes(expectedPath), `map.html がタイルパス ${expectedPath} を参照する`);
    // 組み立て結果が生成物の配置（api/tiles/{z}/{x}/{y}.pbf）と一致することを確認する。
    const resolved = `${apiBase}/tiles/${meta.tiles[0]}`;
    assert.ok(
      resolved.endsWith(`api/tiles/${meta.tiles[0]}`),
      `組み立て後のタイルURL(${resolved}) が api/tiles/ 配下を指す`,
    );
  });
});

await test('ポップアップのラベル定義が生成featureの属性と過不足なく一致する', async () => {
  // ポップアップは feature が実際に持つ属性を出すため、ラベル定義(TILE_PROP_LABELS)が
  // 生成物とズレるとキー名がそのまま画面に出る／表示されない属性が生まれる。
  //
  // 属性はズームで2種類ある。最大ズームは buildFeatureCollection の属性がそのまま入り、
  // 低ズームは間引き後の属性（name が落ち count が付く）が入る。ラベルは両方を
  // 過不足なく覆う必要があるため、和集合と突き合わせる。
  const fc = buildFeatureCollection(FACILITIES);
  const detailProps = Object.keys(fc.features[0].properties);
  const thinnedProps = Object.keys(thinFeatures(fc.features, 6)[0].properties);
  const props = [...new Set([...detailProps, ...thinnedProps])];
  const m = HTML.match(/const TILE_PROP_LABELS = \{([^}]+)\}/);
  assert.ok(m, 'map.html に TILE_PROP_LABELS が定義されている');
  const labeled = [...m[1].matchAll(/^\s*([a-z_]+):/gm)].map((x) => x[1]);
  for (const key of props) {
    assert.ok(labeled.includes(key), `生成属性 ${key} のラベルが定義されている`);
  }
  for (const key of labeled) {
    assert.ok(props.includes(key), `ラベル定義の ${key} が生成feature.properties に存在する`);
  }
});

await test('ヘッダーの統計が参照する metadata.stats のキーがすべて生成される', async () => {
  // 統計用の JSON は配信しないため、件数は metadata.json（TileJSON）から読む。
  const referenced = new Set([...HTML.matchAll(/\bstats\.([a-z_]+)\b/g)].map((m) => m[1]));
  assert.ok(referenced.size >= 1, `map.html が metadata.stats を参照している (${[...referenced].join(',')})`);
  await withTiles({ minZoom: 3, maxZoom: 12 }, (meta) => {
    for (const key of referenced) {
      assert.ok(key in meta.stats, `metadata.stats.${key} が生成される`);
    }
    assert.ok('updated' in meta, 'metadata.updated が生成される（最終更新の表示に使う）');
  });
});

// 廃止した配信形式（階層JSON・検索インデックス）を参照していないこと。
// 「data.json」は metadata.json に部分一致するため、パス区切り込みで判定する。
await test('廃止した配信形式を参照していない', async () => {
  for (const gone of ['facilities/index.json', 'search-index', '/data.json']) {
    assert.ok(!HTML.includes(gone), `map.html が ${gone} を参照していない`);
  }
});

await test('代表点の表示が「1施設」と誤解されない文言になっている', async () => {
  // 最大ズーム未満のタイルは代表点（name を持たず count に件数が入る）。
  // 「各点＝1施設」「（名称なし）」のままだと、点の数を施設数と読まれたり、
  // 元データに名前が無い施設と区別がつかなくなる。
  const fc = buildFeatureCollection(FACILITIES);
  const thinned = thinFeatures(fc.features, 6);
  assert.ok(thinned.length >= 1, '間引き後も点が残る');
  for (const f of thinned) {
    assert.ok(!('name' in f.properties), '代表点に name は載らない');
    assert.ok(Number.isInteger(f.properties.count), 'count に件数が入る');
  }

  // 凡例をズームで出し分ける（要素と、間引き中の文言の両方を固定する）
  assert.ok(/id="legend-text"/.test(HTML), '凡例を差し替える要素がある');
  assert.ok(HTML.includes('各点＝付近の施設をまとめた代表'), '間引き中の凡例文言がある');

  // ポップアップは count の有無で代表点を判定し、件数を見出しに出す
  assert.ok(/props\.count !== undefined/.test(HTML), '代表点かどうかを count の有無で判定する');
  assert.ok(HTML.includes('この付近に '), '代表点のポップアップは件数を見出しに出す');
});

console.log(`\n✅ preview-map 整合性テスト: ${passed}件すべて合格`);

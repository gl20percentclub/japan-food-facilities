// tiles.js のユニットテスト。
//   node scripts/build/tiles.test.js
// タイル座標計算(lonLatToTile)と、一時ディレクトリに対する generateTiles の生成結果を検証する。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  lonLatToTile,
  lonLatToCell,
  thinFeatures,
  buildFeatureCollection,
  generateTiles,
} from './tiles.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// --- lonLatToTile: スリッピータイル座標（独立した基準で検証） ---
await test('lonLatToTile: z0 は常に (0,0)', async () => {
  assert.deepEqual(lonLatToTile(139.7, 35.6, 0), [0, 0]);
  assert.deepEqual(lonLatToTile(-70, 40, 0), [0, 0]);
});
await test('lonLatToTile: z1 は経度・緯度の符号で象限が決まる', async () => {
  assert.deepEqual(lonLatToTile(0.1, 0.1, 1), [1, 0]);   // 東・北
  assert.deepEqual(lonLatToTile(-0.1, 0.1, 1), [0, 0]);  // 西・北
  assert.deepEqual(lonLatToTile(0.1, -0.1, 1), [1, 1]);  // 東・南
  assert.deepEqual(lonLatToTile(-0.1, -0.1, 1), [0, 1]); // 西・南
});
await test('lonLatToTile: 範囲外の座標は 0..2^z-1 にクランプ', async () => {
  const [x, y] = lonLatToTile(999, 999, 3); // 8x8 グリッド
  assert.ok(x >= 0 && x <= 7 && y >= 0 && y <= 7, `クランプされる (${x},${y})`);
});
// 逆変換でタイルの地理境界を求め、元の点がそのタイルに含まれることを確認する
// （実装式の自己参照でなく、独立した基準での正しさ検証）。
await test('lonLatToTile: 返したタイルの境界内に元の点が含まれる', async () => {
  const tile2lng = (x, z) => (x / 2 ** z) * 360 - 180;
  const tile2lat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
  for (const [lng, lat] of [[139.7671, 35.6812], [135.5, 34.7], [141.35, 43.06], [127.68, 26.21]]) {
    for (const z of [6, 10, 12]) {
      const [x, y] = lonLatToTile(lng, lat, z);
      const west = tile2lng(x, z), east = tile2lng(x + 1, z);
      const north = tile2lat(y, z), south = tile2lat(y + 1, z);
      assert.ok(lng >= west && lng < east, `lng ${lng} が [${west},${east}) 内 (z${z})`);
      assert.ok(lat <= north && lat > south, `lat ${lat} が (${south},${north}] 内 (z${z})`);
    }
  }
});

// --- lonLatToCell: 間引き用グリッド ---
// セル境界がタイル境界と一致していないと、間引き後に隣接タイルの継ぎ目で
// 点の密度が変わる。cellsPerTile で割ればタイル座標に戻ることで検証する。
test('lonLatToCell: セルをタイルサイズで割るとタイル座標に一致する', () => {
  for (const [lng, lat] of [[139.7671, 35.6812], [135.5, 34.7], [141.35, 43.06], [127.68, 26.21]]) {
    for (const z of [6, 9, 12]) {
      for (const cells of [16, 64]) {
        const [cx, cy] = lonLatToCell(lng, lat, z, cells);
        const [x, y] = lonLatToTile(lng, lat, z);
        assert.deepEqual(
          [Math.floor(cx / cells), Math.floor(cy / cells)],
          [x, y],
          `z${z} cells=${cells} のセルがタイル ${x}/${y} に収まる`,
        );
      }
    }
  }
});
test('lonLatToCell: cellsPerTile=1 は lonLatToTile と同じ', () => {
  assert.deepEqual(lonLatToCell(139.7671, 35.6812, 10, 1), lonLatToTile(139.7671, 35.6812, 10));
});
test('lonLatToCell: ズームが上がるほどセルは細かくなる', () => {
  // 100m ほど離れた 2 点。低ズームでは同じセル、高ズームでは別セルになる
  const a = [139.7671, 35.6812];
  const b = [139.7682, 35.6812];
  assert.deepEqual(lonLatToCell(...a, 6, 64), lonLatToCell(...b, 6, 64), 'z6 では同じセル');
  assert.notDeepEqual(lonLatToCell(...a, 16, 64), lonLatToCell(...b, 16, 64), 'z16 では別セル');
});

// --- thinFeatures: 低ズームの間引き ---
/** テスト用の点 feature を作る。 */
function pt(lng, lat, props) {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props };
}

test('thinFeatures: 同じセル・同じ業種は1点にまとめ count に件数を入れる', () => {
  const base = { name: '店', business_type: '飲食店営業', pref: '東京都', city: '港区' };
  // 数 m 差の 3 点（z6 では確実に同じセル）
  const out = thinFeatures(
    [
      pt(139.7671, 35.6812, { ...base, name: '店A' }),
      pt(139.7672, 35.6813, { ...base, name: '店B' }),
      pt(139.7673, 35.6814, { ...base, name: '店C' }),
    ],
    6,
    64,
  );
  assert.equal(out.length, 1, '1点に潰れる');
  assert.equal(out[0].properties.count, 3, 'まとめた件数が count に入る');
});

test('thinFeatures: 同じセルでも業種が違えば残る（業種フィルターを壊さない）', () => {
  const at = (business_type) => pt(139.7671, 35.6812, { name: '店', business_type, pref: '東京都', city: '港区' });
  const out = thinFeatures([at('飲食店営業'), at('飲食店営業'), at('喫茶店営業')], 6, 64);
  assert.equal(out.length, 2, '業種ごとに代表が残る');
  const counts = Object.fromEntries(out.map((f) => [f.properties.business_type, f.properties.count]));
  assert.deepEqual(counts, { 飲食店営業: 2, 喫茶店営業: 1 });
});

test('thinFeatures: 同じセルでも自治体が違えば残る（count が複数自治体の合計にならない）', () => {
  // z6 のセルは約 8 km 四方で市区町村・県境をまたぐ。同じセルに落ちる 2 自治体の点を
  // 1 点に潰すと、代表点 1 軒の自治体名にセル全体の件数が貼り付いてしまう。
  const at = (pref, city) => pt(139.7671, 35.6812, { name: '店', business_type: '飲食店営業', pref, city });
  const out = thinFeatures([at('東京都', '港区'), at('東京都', '港区'), at('東京都', '千代田区')], 6, 64);
  assert.equal(out.length, 2, '市区町村ごとに代表が残る');
  const counts = Object.fromEntries(out.map((f) => [f.properties.city, f.properties.count]));
  assert.deepEqual(counts, { 港区: 2, 千代田区: 1 });
});

test('thinFeatures: cellsPerTile が 0 や NaN なら例外（全点が1点に潰れるのを防ぐ）', () => {
  const features = [pt(139.7671, 35.6812, { name: '店', business_type: '飲食店営業', pref: '東京都', city: '港区' })];
  // 環境変数が「宣言だけされて空文字」だと Number('') === 0 になる経路
  assert.throws(() => thinFeatures(features, 6, 0), /間引きグリッドの解像度が不正/);
  assert.throws(() => thinFeatures(features, 6, Number('')), /間引きグリッドの解像度が不正/);
  assert.throws(() => thinFeatures(features, 6, NaN), /間引きグリッドの解像度が不正/);
});

test('thinFeatures: 離れた点は潰れない', () => {
  const base = { name: '店', business_type: '飲食店営業', pref: '東京都', city: '港区' };
  // 東京と大阪
  const out = thinFeatures([pt(139.7671, 35.6812, base), pt(135.5023, 34.6937, base)], 6, 64);
  assert.equal(out.length, 2);
});

test('thinFeatures: name は落とし、業種・都道府県・市区町村は残す', () => {
  const out = thinFeatures(
    [pt(139.7671, 35.6812, { name: '店A', business_type: '飲食店営業', pref: '東京都', city: '港区' })],
    6,
    64,
  );
  const props = out[0].properties;
  assert.ok(!('name' in props), 'name は載せない（文字列テーブルが太るため）');
  assert.equal(props.business_type, '飲食店営業');
  assert.equal(props.pref, '東京都');
  assert.equal(props.city, '港区');
});

test('thinFeatures: 入力の features を書き換えない', () => {
  const input = [pt(139.7671, 35.6812, { name: '店A', business_type: '飲食店営業', pref: '東京都', city: '港区' })];
  thinFeatures(input, 6, 64);
  assert.deepEqual(input[0].properties, { name: '店A', business_type: '飲食店営業', pref: '東京都', city: '港区' });
});

test('thinFeatures: グリッドが細かいほど残る点が増える', () => {
  const base = { name: '店', business_type: '飲食店営業', pref: '東京都', city: '港区' };
  // 東京駅周辺に 0.01 度刻みで並べた 25 点
  const features = [];
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) features.push(pt(139.76 + i * 0.01, 35.68 + j * 0.01, base));
  }
  const coarse = thinFeatures(features, 6, 16).length;
  const fine = thinFeatures(features, 6, 256).length;
  assert.ok(coarse < fine, `粗いグリッドのほうが点が減る (${coarse} < ${fine})`);
  assert.ok(fine <= features.length, '元の点数は超えない');
});

// --- buildFeatureCollection / generateTiles: インメモリの施設配列で検証 ---
function makeFacilities() {
  return [
    { name: '店A', business_type: '飲食店営業', address: '港区赤坂1-1', lat: 35.673, lng: 139.737, geocoding_level: 8, pref: '東京都', city: '港区' },
    { name: '店B', business_type: '喫茶店営業', address: '港区六本木6-1', lat: 35.662, lng: 139.731, geocoding_level: 8, pref: '東京都', city: '港区' },
    { name: '座標なし', business_type: '飲食店営業', address: '港区不明', lat: null, lng: null, geocoding_level: null, pref: '東京都', city: '港区' },
  ];
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tiles-test-'));
}

await test('buildFeatureCollection: 座標を持つ施設だけを点に変換する', async () => {
  const fc = buildFeatureCollection(makeFacilities());
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 2); // 座標なしは除外
  const f = fc.features[0];
  assert.equal(f.geometry.type, 'Point');
  assert.deepEqual(f.geometry.coordinates, [139.737, 35.673]); // [lng, lat]
  assert.equal(f.properties.pref, '東京都');
  assert.equal(f.properties.city, '港区');
  assert.ok('name' in f.properties && 'business_type' in f.properties);
});

await test('generateTiles: metadata.json と、各点に対応する非空 pbf タイルを生成する', async () => {
  const dir = tmpDir();
  const outDir = path.join(dir, 'tiles');
  try {
    const { tiles: written, points } = await generateTiles(makeFacilities(), {
      minZoom: 12,
      maxZoom: 12,
      outDir,
      updated: 1749600000,
      stats: { rowsOut: 3, prefectures: 1, cities: 1 },
      log: () => {},
    });
    assert.ok(written >= 1, `タイルが1枚以上生成される (${written})`);
    assert.equal(points, 2, '座標を持つ点だけが焼かれる');

    // metadata.json（TileJSON）の要点
    const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'metadata.json'), 'utf-8'));
    assert.equal(meta.format, 'pbf');
    assert.equal(meta.minzoom, 12);
    assert.equal(meta.maxzoom, 12);
    assert.deepEqual(meta.tiles, ['{z}/{x}/{y}.pbf']);
    assert.equal(meta.vector_layers[0].id, 'facilities');

    // プレビュー地図が読む統計が埋め込まれている
    assert.equal(meta.updated, 1749600000);
    assert.deepEqual(meta.stats, { points: 2, records: 3, prefectures: 1, cities: 1 });

    // フィクスチャの点が属する z12 タイルに、非空の .pbf が実在する
    // （書き出しパスが lonLatToTile と整合していることの検証）
    const [x, y] = lonLatToTile(139.737, 35.673, 12);
    const pbfPath = path.join(outDir, '12', String(x), `${y}.pbf`);
    assert.ok(fs.existsSync(pbfPath), `点に対応する pbf が存在する: 12/${x}/${y}.pbf`);
    assert.ok(fs.statSync(pbfPath).size > 0, 'pbf が非空である');

    // 出力された .pbf の総数が戻り値(written)と一致する
    const pbfCount = fs
      .readdirSync(outDir)
      .filter((z) => /^\d+$/.test(z))
      .reduce((n, z) => n + fs.readdirSync(path.join(outDir, z)).reduce((m, xx) => m + fs.readdirSync(path.join(outDir, z, xx)).length, 0), 0);
    assert.equal(pbfCount, written, `.pbf 数(${pbfCount}) が戻り値(${written})と一致`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** そのズームの .pbf の合計バイト数。 */
function zoomBytesIn(outDir, z) {
  const zDir = path.join(outDir, String(z));
  if (!fs.existsSync(zDir)) return 0;
  return fs.readdirSync(zDir).reduce(
    (sum, x) =>
      sum +
      fs
        .readdirSync(path.join(zDir, x))
        .reduce((s, y) => s + fs.statSync(path.join(zDir, x, y)).size, 0),
    0,
  );
}

/** 東京駅周辺に 0.0005 度（約 50m）刻みで 400 点を並べた施設配列。 */
function denseFacilities() {
  const facilities = [];
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 20; j++) {
      facilities.push({
        name: `店${i}-${j}`,
        business_type: '飲食店営業',
        lat: 35.68 + j * 0.0005,
        lng: 139.76 + i * 0.0005,
        pref: '東京都',
        city: '千代田区',
      });
    }
  }
  return facilities;
}

// 低ズームが実際に間引かれ、最大ズームは間引かれないことを生成物で確認する。
await test('generateTiles: 低ズームは間引かれ、最大ズームは全点そのまま', async () => {
  const dir = tmpDir();
  const outDir = path.join(dir, 'tiles');
  try {
    // 密な 400 点は z6 では同じセルに集まり、z12 ではセルが十分細かいので散らばる。
    const facilities = denseFacilities();
    await generateTiles(facilities, {
      minZoom: 6,
      maxZoom: 12,
      detailZoom: 12,
      cellsPerTile: 64,
      outDir,
      updated: 1749600000,
      stats: { rowsOut: facilities.length, prefectures: 1, cities: 1 },
      log: () => {},
    });

    // 同じ点群でも、間引かれた z6 は間引きなしの z12 よりはっきり小さい
    const z6 = zoomBytesIn(outDir, 6);
    const z12 = zoomBytesIn(outDir, 12);
    assert.ok(z6 * 4 < z12, `z6(${z6}B) が z12(${z12}B) より十分小さい`);

    // metadata に間引きの仕様と count フィールドが載る
    const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'metadata.json'), 'utf-8'));
    assert.deepEqual(meta.thinning, { detail_zoom: 12, cells_per_tile: 64 });
    assert.equal(meta.vector_layers[0].fields.count, 'Number');
    // 点の総数は間引き前の値を報告する（統計の意味を変えない）
    assert.equal(meta.stats.points, facilities.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// detailZoom を渡さない呼び出しでも「最大ズームは間引かない」が保たれることを確認する。
// 最大ズームまで間引かれると、overzoom（z13 以上）の元データが代表点だけになる。
await test('generateTiles: detailZoom 未指定なら maxZoom が間引き対象から外れる', async () => {
  const dir = tmpDir();
  const outDir = path.join(dir, 'tiles');
  try {
    const facilities = denseFacilities();
    // maxZoom だけを指定（detailZoom は既定に任せる）
    await generateTiles(facilities, {
      minZoom: 9,
      maxZoom: 10,
      cellsPerTile: 64,
      outDir,
      updated: 1749600000,
      stats: { rowsOut: facilities.length, prefectures: 1, cities: 1 },
      log: () => {},
    });

    const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'metadata.json'), 'utf-8'));
    assert.equal(
      meta.thinning.detail_zoom,
      10,
      'detail_zoom は maxZoom に追従する（metadata と実データが食い違わない）',
    );
    assert.equal(meta.maxzoom, 10);

    // 間引きなしの z10 には施設名も載るので、間引かれた z9 よりはっきり大きい
    const z9 = zoomBytesIn(outDir, 9);
    const z10 = zoomBytesIn(outDir, 10);
    assert.ok(z9 * 4 < z10, `z9(${z9}B) が z10(${z10}B) より十分小さい＝z10 は間引かれていない`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- タイルは gzip 済みで書き出す（配信時に Content-Encoding: gzip を付ける前提）---
// 解凍は fflate ではなく Node の zlib で行い、自作実装の自己参照にならないようにする。
await test('generateTiles: タイルを gzip 圧縮して書き出す（解凍すると MVT に戻る）', async () => {
  const dir = tmpDir();
  const outDir = path.join(dir, 'tiles');
  try {
    const { bytes, rawBytes } = await generateTiles(makeFacilities(), {
      minZoom: 12,
      maxZoom: 12,
      outDir,
      updated: 1749600000,
      stats: { rowsOut: 3, prefectures: 1, cities: 1 },
      log: () => {},
    });

    const [x, y] = lonLatToTile(139.737, 35.673, 12);
    const stored = fs.readFileSync(path.join(outDir, '12', String(x), `${y}.pbf`));

    // gzip のマジックナンバー（0x1f 0x8b）で始まる
    assert.equal(stored[0], 0x1f, 'gzip のマジックナンバー 1バイト目');
    assert.equal(stored[1], 0x8b, 'gzip のマジックナンバー 2バイト目');

    // 解凍すると元の MVT が戻り、属性値（施設名）がバイト列に現れる
    const raw = zlib.gunzipSync(stored);
    assert.ok(raw.length > stored.length, `解凍すると大きくなる (${stored.length} → ${raw.length})`);
    assert.ok(raw.includes(Buffer.from('店A', 'utf8')), '解凍した MVT に属性値が含まれる');

    // 戻り値は配信サイズ（gzip 後）と圧縮前サイズの両方を持つ
    assert.ok(bytes < rawBytes, `bytes(${bytes}) が rawBytes(${rawBytes}) より小さい`);
    assert.equal(bytes, stored.length, 'bytes は書き出した gzip のバイト数と一致');
    assert.equal(rawBytes, raw.length, 'rawBytes は圧縮前のバイト数と一致');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// gzip ヘッダに時刻を入れていないこと。同じ入力で毎回同じバイト列になることが、
// aws s3 sync の差分判定（サイズ・更新時刻の比較）で不要な再アップロードを防ぐ前提。
await test('generateTiles: 同じ入力なら同じバイト列を書き出す（gzip に時刻を埋めない）', async () => {
  const dirs = [tmpDir(), tmpDir()];
  try {
    const written = [];
    for (const dir of dirs) {
      const outDir = path.join(dir, 'tiles');
      await generateTiles(makeFacilities(), {
        minZoom: 12, maxZoom: 12, outDir, updated: 1749600000,
        stats: { rowsOut: 3, prefectures: 1, cities: 1 }, log: () => {},
      });
      const [x, y] = lonLatToTile(139.737, 35.673, 12);
      written.push(fs.readFileSync(path.join(outDir, '12', String(x), `${y}.pbf`)));
    }
    assert.deepEqual(written[0], written[1], '2回の生成結果が同一バイト列');
  } finally {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n✅ ベクトルタイル生成 ユニットテスト: ${passed}件すべて合格`);

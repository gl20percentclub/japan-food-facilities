// land-price-rank.js のユニットテスト。
//   node scripts/enrich/land-price-rank.test.js
//
// **このテストはネットワークに一切出ない。** 不動産情報ライブラリ API は利用申請が
// 必要で、キーが無い環境（CI・他の開発者の手元）でも必ず緑になる必要があるため、
//   - レスポンスの解釈・最寄り探索・ランク付けは固定のフィクスチャで検証する
//   - 通信する関数（fetchLandPriceTile / fetchCommercialPoints / runEnrichment）は
//     fetchImpl をモックに差し替え、渡される URL・ヘッダとキャッシュの効き方を検証する
//   - APIキー未設定時は fetch が1度も呼ばれないことを明示的に固定する
// という方針を取る（lib/notify-slack.test.js と同じ流儀）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  toNumber,
  haversineDistanceM,
  lngLatToTile,
  tileKey,
  collectTileCoords,
  parseLandPrice,
  isCommercialFeature,
  featureToPoint,
  pointsFromGeoJson,
  buildPointIndex,
  findNearestPoint,
  computeRankThresholds,
  assignRank,
  buildRankThresholds,
  thresholdsFor,
  enrichFacilities,
  defaultPriceYear,
  resolveApiKey,
  buildRequestUrl,
  fetchLandPriceTile,
  fetchCommercialPoints,
  runEnrichment,
  parseArgs,
  tileCachePath,
  readFacilitiesCsv,
  writeFacilitiesCsv,
  LAND_PRICE_COLUMNS,
  API_KEY_HEADER,
  API_KEY_ENV,
  MAX_RANK_DISTANCE_M,
  MIN_POINTS_FOR_RANK,
  TILE_ZOOM,
} from './land-price-rank.js';

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

console.log('land-price-rank テスト\n');

// --- フィクスチャ生成 ----------------------------------------------------------

/** XPT002 のレスポンスに見立てた Feature を作る。 */
function feature(lng, lat, priceText, { useCategory = '4,商業地', prefCode = '26' } = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: {
      point_id: 1,
      use_category_name_ja: useCategory,
      u_current_years_price_ja: priceText,
      prefecture_code: prefCode,
      target_year_name_ja: '令和8年1月1日',
    },
  };
}

/** ランクの母集団を満たすためのダミー点（施設から遠い場所に置く）。 */
function backgroundPoints(count, { prefCode = '01', baseLat = 43.0, baseLng = 141.0 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    lat: baseLat + i * 0.01,
    lng: baseLng,
    price: (i + 1) * 1000,
    prefCode,
    year: '令和8年1月1日',
  }));
}

// --- toNumber -----------------------------------------------------------------

test('toNumber: 空文字・null は null（Number("") の 0 を座標として拾わない）', () => {
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('   '), null);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber(undefined), null);
  assert.equal(toNumber('abc'), null);
  assert.equal(toNumber('35.68'), 35.68);
  assert.equal(toNumber(0), 0);
});

// --- haversineDistanceM -------------------------------------------------------

test('haversineDistanceM: 緯度1度は約111.2km', () => {
  const d = haversineDistanceM(0, 0, 1, 0);
  assert.ok(Math.abs(d - 111195) < 20, `実際 ${Math.round(d)}m`);
});

test('haversineDistanceM: 同一点は0m', () => {
  assert.equal(haversineDistanceM(35.0, 135.0, 35.0, 135.0), 0);
});

test('haversineDistanceM: 緯度35度での経度0.001度は約91m', () => {
  const d = haversineDistanceM(35.0, 135.0, 35.0, 135.001);
  assert.ok(Math.abs(d - 91) < 2, `実際 ${Math.round(d)}m`);
});

// --- lngLatToTile / tileKey ----------------------------------------------------

test('lngLatToTile: z=0 は常に (0,0)', () => {
  assert.deepEqual(lngLatToTile(135, 35, 0), { x: 0, y: 0 });
});

test('lngLatToTile: z=1 の南東半球は (1,1)', () => {
  assert.deepEqual(lngLatToTile(90, -45, 1), { x: 1, y: 1 });
});

test('lngLatToTile: 経度135度は z=13 のタイル境界（135.0005 と 134.9995 で x が分かれる）', () => {
  assert.equal(lngLatToTile(135.0005, 35, 13).x, 7168);
  assert.equal(lngLatToTile(134.9995, 35, 13).x, 7167);
});

test('tileKey: x/y の文字列', () => {
  assert.equal(tileKey(7168, 3232), '7168/3232');
});

// --- collectTileCoords ---------------------------------------------------------

test('collectTileCoords: 1施設につき3×3の9枚を返す', () => {
  const tiles = collectTileCoords([{ lat: 35, lng: 135 }], { zoom: 13, neighborRadius: 1 });
  assert.equal(tiles.length, 9);
});

test('collectTileCoords: neighborRadius=0 なら自タイルだけ', () => {
  const tiles = collectTileCoords([{ lat: 35, lng: 135 }], { zoom: 13, neighborRadius: 0 });
  assert.deepEqual(tiles, [lngLatToTile(135, 35, 13)]);
});

test('collectTileCoords: 同じタイルに乗る施設が何件あっても重複しない', () => {
  const facilities = Array.from({ length: 50 }, (_, i) => ({ lat: 35 + i * 0.00001, lng: 135.001 }));
  const tiles = collectTileCoords(facilities, { zoom: 13, neighborRadius: 1 });
  assert.equal(tiles.length, 9);
  assert.equal(new Set(tiles.map((t) => tileKey(t.x, t.y))).size, 9);
});

test('collectTileCoords: 座標を持たない施設は対象外（空文字の lat を 0 扱いしない）', () => {
  assert.equal(collectTileCoords([{ lat: '', lng: '' }], { zoom: 13 }).length, 0);
  assert.equal(collectTileCoords([{ lat: null, lng: null }], { zoom: 13 }).length, 0);
});

// --- parseLandPrice ------------------------------------------------------------

test('parseLandPrice: 「3,100,000(円/㎡)」→ 3100000', () => {
  assert.equal(parseLandPrice('3,100,000(円/㎡)'), 3100000);
});

test('parseLandPrice: 数値型もそのまま受け取る', () => {
  assert.equal(parseLandPrice(2820000), 2820000);
});

test('parseLandPrice: 数字が無ければ null（休止地点・欠測を落とす）', () => {
  assert.equal(parseLandPrice(''), null);
  assert.equal(parseLandPrice('（値なし）'), null);
  assert.equal(parseLandPrice(null), null);
  assert.equal(parseLandPrice(undefined), null);
  assert.equal(parseLandPrice(0), null);
});

// --- isCommercialFeature / featureToPoint / pointsFromGeoJson -------------------

test('isCommercialFeature: 用途区分名にコードが前置されていても商業地を判定できる', () => {
  assert.equal(isCommercialFeature({ use_category_name_ja: '4,商業地' }), true);
  assert.equal(isCommercialFeature({ use_category_name_ja: '0,住宅地' }), false);
  assert.equal(isCommercialFeature({}), false);
  assert.equal(isCommercialFeature(null), false);
});

test('featureToPoint: 商業地の Feature を点に落とす（座標は [lng, lat] の順）', () => {
  const p = featureToPoint(feature(135.5, 34.7, '1,200,000(円/㎡)'));
  assert.deepEqual(
    { lat: p.lat, lng: p.lng, price: p.price, prefCode: p.prefCode },
    { lat: 34.7, lng: 135.5, price: 1200000, prefCode: '26' },
  );
});

test('featureToPoint: 商業地でない／価格が読めない／座標が無い Feature は null', () => {
  assert.equal(featureToPoint(feature(135.5, 34.7, '300,000(円/㎡)', { useCategory: '0,住宅地' })), null);
  assert.equal(featureToPoint(feature(135.5, 34.7, '（値なし）')), null);
  assert.equal(featureToPoint({ properties: { use_category_name_ja: '4,商業地', u_current_years_price_ja: '1(円/㎡)' } }), null);
});

test('pointsFromGeoJson: 採用できる Feature だけを取り出す', () => {
  const geojson = {
    type: 'FeatureCollection',
    features: [
      feature(135.5, 34.7, '1,200,000(円/㎡)'),
      feature(135.6, 34.8, '500,000(円/㎡)', { useCategory: '0,住宅地' }), // 住宅地は落とす
      feature(135.7, 34.9, '（値なし）'), // 価格なしは落とす
      feature(135.8, 35.0, '800,000(円/㎡)'),
    ],
  };
  const points = pointsFromGeoJson(geojson);
  assert.equal(points.length, 2);
  assert.deepEqual(points.map((p) => p.price), [1200000, 800000]);
});

test('pointsFromGeoJson: features が無いレスポンスでも落ちない', () => {
  assert.deepEqual(pointsFromGeoJson({ type: 'FeatureCollection', features: [] }), []);
  assert.deepEqual(pointsFromGeoJson({}), []);
  assert.deepEqual(pointsFromGeoJson(null), []);
});

// --- buildPointIndex / findNearestPoint ----------------------------------------

test('findNearestPoint: 複数の候補からもっとも近い点を選ぶ', () => {
  const points = [
    { lat: 35.0, lng: 135.02, price: 100000, prefCode: '26' }, // 約1.8km
    { lat: 35.0, lng: 135.005, price: 200000, prefCode: '26' }, // 約456m ← これが最寄り
    { lat: 35.0, lng: 135.05, price: 300000, prefCode: '26' }, // 約4.6km
  ];
  const hit = findNearestPoint(buildPointIndex(points, 13), 35.0, 135.0, { zoom: 13 });
  assert.equal(hit.point.price, 200000);
  assert.ok(Math.abs(hit.distanceM - 456) < 10, `実際 ${Math.round(hit.distanceM)}m`);
});

test('findNearestPoint: 隣のタイルにある点も拾う（3×3の近傍探索）', () => {
  // 経度135.0 は z=13 のタイル境界。施設は x=7168、最寄り点は x=7167 に置く。
  const near = { lat: 35.0, lng: 134.9995, price: 900000, prefCode: '26' }; // 別タイル・約91m
  const sameTile = { lat: 35.0, lng: 135.01, price: 100000, prefCode: '26' }; // 同タイル・約912m
  assert.notEqual(lngLatToTile(near.lng, near.lat, 13).x, lngLatToTile(135.0005, 35.0, 13).x);

  const index = buildPointIndex([near, sameTile], 13);
  const hit = findNearestPoint(index, 35.0, 135.0005, { zoom: 13, neighborRadius: 1 });
  assert.equal(hit.point.price, 900000, '別タイルにある近い点が選ばれる');

  // neighborRadius=0 だと自タイルしか見ないので、遠い同タイルの点を掴んでしまう。
  const narrow = findNearestPoint(index, 35.0, 135.0005, { zoom: 13, neighborRadius: 0 });
  assert.equal(narrow.point.price, 100000, '近傍を見ないと取りこぼす（3×3にしている理由）');
});

test('findNearestPoint: 近傍に点が無ければ null / 座標が無ければ null', () => {
  const index = buildPointIndex([{ lat: 43.0, lng: 141.0, price: 100000, prefCode: '01' }], 13);
  assert.equal(findNearestPoint(index, 35.0, 135.0, { zoom: 13 }), null);
  assert.equal(findNearestPoint(index, '', '', { zoom: 13 }), null);
});

// --- computeRankThresholds / assignRank ----------------------------------------

test('computeRankThresholds: 100点の等差分布から 20/40/60/80 パーセンタイルを返す', () => {
  const prices = Array.from({ length: 100 }, (_, i) => (i + 1) * 1000);
  assert.deepEqual(computeRankThresholds(prices), [20000, 40000, 60000, 80000]);
});

test(`computeRankThresholds: 母集団が ${MIN_POINTS_FOR_RANK}件未満なら null（分位が安定しない）`, () => {
  const few = Array.from({ length: MIN_POINTS_FOR_RANK - 1 }, (_, i) => (i + 1) * 1000);
  assert.equal(computeRankThresholds(few), null);
  const enough = Array.from({ length: MIN_POINTS_FOR_RANK }, (_, i) => (i + 1) * 1000);
  assert.ok(Array.isArray(computeRankThresholds(enough)));
});

test('assignRank: 1 = もっとも安い / 5 = もっとも高い', () => {
  const t = [20000, 40000, 60000, 80000];
  assert.equal(assignRank(1000, t), 1);
  assert.equal(assignRank(19999, t), 1);
  assert.equal(assignRank(20000, t), 2, '閾値ちょうどは上の段に入る');
  assert.equal(assignRank(50000, t), 3);
  assert.equal(assignRank(79999, t), 4);
  assert.equal(assignRank(80000, t), 5);
  assert.equal(assignRank(9999999, t), 5, '5を超えるランクは作らない');
});

test('assignRank: 価格または閾値が無ければ null', () => {
  assert.equal(assignRank(null, [20000]), null);
  assert.equal(assignRank(20000, null), null);
  assert.equal(assignRank(20000, []), null);
});

// --- buildRankThresholds / thresholdsFor ---------------------------------------

test('buildRankThresholds: 既定（national）は都道府県別の閾値を作らない', () => {
  const points = [...backgroundPoints(30, { prefCode: '01' }), ...backgroundPoints(30, { prefCode: '13' })];
  const set = buildRankThresholds(points);
  assert.equal(set.scope, 'national');
  assert.equal(set.byPrefecture.size, 0);
  assert.ok(Array.isArray(set.national));
});

test('buildRankThresholds: prefecture なら県ごとに母集団を分ける', () => {
  // 東京都(13)だけ桁を1つ上げる。全国基準なら 13 は全部 5、県内相対なら 1〜5 に散る。
  const cheap = backgroundPoints(30, { prefCode: '01' });
  const rich = backgroundPoints(30, { prefCode: '13' }).map((p) => ({ ...p, price: p.price * 100 }));
  const set = buildRankThresholds([...cheap, ...rich], { scope: 'prefecture' });
  assert.equal(set.scope, 'prefecture');
  assert.equal(set.byPrefecture.size, 2);
  const tokyo = thresholdsFor(set, '13');
  assert.notDeepEqual(tokyo, set.national, '県内相対の閾値は全国の閾値と別物');
  assert.equal(assignRank(100000, tokyo), 1, '東京都内では最下位の水準になる');
  assert.ok(
    assignRank(100000, set.national) > assignRank(100000, tokyo),
    '同じ地価でも、全国基準のほうが高いランクになる（母集団が違うため）',
  );
});

test('thresholdsFor: 点が少ない県は全国の閾値にフォールバックする', () => {
  const points = [...backgroundPoints(30, { prefCode: '01' }), ...backgroundPoints(3, { prefCode: '47' })];
  const set = buildRankThresholds(points, { scope: 'prefecture' });
  assert.equal(set.byPrefecture.has('47'), false, '母集団が足りない県は閾値を持たない');
  assert.deepEqual(thresholdsFor(set, '47'), set.national);
  assert.deepEqual(thresholdsFor(set, null), set.national);
});

// --- enrichFacilities ----------------------------------------------------------

test('enrichFacilities: 地価・距離・ランクの3列を付与する', () => {
  const points = [
    { lat: 35.0, lng: 135.005, price: 55000, prefCode: '26' },
    ...backgroundPoints(30),
  ];
  const facilities = [{ name: '店A', lat: 35.0, lng: 135.0 }];
  const stats = enrichFacilities(facilities, points, { zoom: 13, log: () => {} });

  assert.equal(facilities[0].land_price, 55000);
  assert.ok(Math.abs(facilities[0].land_price_distance_m - 456) < 10);
  assert.equal(Number.isInteger(facilities[0].land_price_distance_m), true, '距離は整数メートルに丸める');
  assert.ok(facilities[0].land_price_rank >= 1 && facilities[0].land_price_rank <= 5);
  assert.deepEqual(
    { matched: stats.matched, ranked: stats.ranked, tooFar: stats.tooFar },
    { matched: 1, ranked: 1, tooFar: 0 },
  );
});

test(`enrichFacilities: 最寄り点が ${MAX_RANK_DISTANCE_M}m を超えたらランクだけ空にする（地価と距離は残す）`, () => {
  // 緯度35度で経度+0.0548度 ≒ 5.0km。閾値 3,000m を超える。
  const far = { lat: 35.0, lng: 135.0553, price: 55000, prefCode: '26' };
  const points = [far, ...backgroundPoints(30)];
  const facilities = [{ name: '店B', lat: 35.0, lng: 135.0 }];
  const stats = enrichFacilities(facilities, points, { zoom: 13, log: () => {} });

  assert.ok(facilities[0].land_price_distance_m > MAX_RANK_DISTANCE_M, `実際 ${facilities[0].land_price_distance_m}m`);
  assert.equal(facilities[0].land_price, 55000, '参照した地価は参考値として残す');
  assert.equal(facilities[0].land_price_rank, null, '遠すぎる点にランクは付けない');
  assert.deepEqual({ matched: stats.matched, ranked: stats.ranked, tooFar: stats.tooFar }, { matched: 1, ranked: 0, tooFar: 1 });
});

test('enrichFacilities: 座標が無い施設・近傍に点が無い施設は3列とも空', () => {
  const points = backgroundPoints(30);
  const facilities = [
    { name: '座標なし', lat: '', lng: '' },
    { name: '近傍に点なし', lat: 33.6, lng: 130.4 },
  ];
  const stats = enrichFacilities(facilities, points, { zoom: 13, log: () => {} });
  for (const f of facilities) {
    assert.deepEqual(
      [f.land_price, f.land_price_distance_m, f.land_price_rank],
      [null, null, null],
      `${f.name} は3列とも空`,
    );
  }
  assert.deepEqual({ noCoord: stats.noCoord, noPoint: stats.noPoint, matched: stats.matched }, { noCoord: 1, noPoint: 1, matched: 0 });
});

test('enrichFacilities: 母集団が足りなければランクだけ空になる（地価と距離は出る）', () => {
  const points = [{ lat: 35.0, lng: 135.005, price: 55000, prefCode: '26' }]; // 1点しかない
  const facilities = [{ name: '店C', lat: 35.0, lng: 135.0 }];
  enrichFacilities(facilities, points, { zoom: 13, log: () => {} });
  assert.equal(facilities[0].land_price, 55000);
  assert.equal(facilities[0].land_price_rank, null);
});

test('enrichFacilities: rankScope=prefecture に切り替えられる（閾値の切り方は未決のため）', () => {
  // 最寄り点は京都(26)。京都の母集団では安い側、全国の母集団では高い側になるよう作る。
  const kyoto = backgroundPoints(30, { prefCode: '26', baseLat: 35.0, baseLng: 135.4 }).map((p) => ({
    ...p,
    price: p.price * 100,
  }));
  const nearest = { lat: 35.0, lng: 135.005, price: 100000, prefCode: '26' };
  const points = [nearest, ...kyoto, ...backgroundPoints(30, { prefCode: '01' })];
  const facilities = () => [{ name: '店D', lat: 35.0, lng: 135.0 }];

  const national = facilities();
  enrichFacilities(national, points, { zoom: 13, rankScope: 'national', log: () => {} });
  const perPref = facilities();
  enrichFacilities(perPref, points, { zoom: 13, rankScope: 'prefecture', log: () => {} });

  assert.equal(national[0].land_price, perPref[0].land_price, '参照する地価は同じ点');
  assert.notEqual(national[0].land_price_rank, perPref[0].land_price_rank, 'scope でランクが変わる');
});

// --- defaultPriceYear / resolveApiKey / buildRequestUrl -------------------------

test('defaultPriceYear: 地価公示の公表（3月下旬）を待って当年に切り替える', () => {
  assert.equal(defaultPriceYear(new Date(2026, 8, 19)), 2026, '9月なら当年');
  assert.equal(defaultPriceYear(new Date(2026, 3, 1)), 2026, '4月なら当年');
  assert.equal(defaultPriceYear(new Date(2026, 2, 1)), 2025, '3月はまだ公表前なので前年');
  assert.equal(defaultPriceYear(new Date(2026, 0, 5)), 2025, '1月は前年');
});

test('resolveApiKey: 環境変数から読み、未設定・空白なら null', () => {
  assert.equal(resolveApiKey({}), null);
  assert.equal(resolveApiKey({ [API_KEY_ENV]: '' }), null);
  assert.equal(resolveApiKey({ [API_KEY_ENV]: '   ' }), null);
  assert.equal(resolveApiKey({ [API_KEY_ENV]: ' abc123 ' }), 'abc123');
});

test('buildRequestUrl: XPT002 に商業地・GeoJSON・タイル座標を渡す', () => {
  const url = new URL(buildRequestUrl({ zoom: 13, x: 7168, y: 3232, year: 2026 }));
  assert.equal(url.origin + url.pathname, 'https://www.reinfolib.mlit.go.jp/ex-api/external/XPT002');
  assert.equal(url.searchParams.get('response_format'), 'geojson');
  assert.equal(url.searchParams.get('z'), '13');
  assert.equal(url.searchParams.get('x'), '7168');
  assert.equal(url.searchParams.get('y'), '3232');
  assert.equal(url.searchParams.get('year'), '2026');
  assert.equal(url.searchParams.get('useCategoryCode'), '05', '商業地に絞る');
  assert.equal(url.searchParams.has('priceClassification'), false, '地価公示・地価調査の両方を受け取る');
});

// --- parseArgs / tileCachePath -------------------------------------------------

test('parseArgs: --in / --out / --year / --rank-scope / --force', () => {
  const a = parseArgs(['--in=a.csv', '--out=b.csv', '--year=2025', '--rank-scope=prefecture', '--force']);
  assert.deepEqual(a, { in: 'a.csv', out: 'b.csv', year: 2025, rankScope: 'prefecture', force: true });
});

test('parseArgs: 既定は全国共通のランク（未指定・不正値とも national）', () => {
  assert.equal(parseArgs([]).rankScope, 'national');
  assert.equal(parseArgs(['--rank-scope=world']).rankScope, 'national');
  assert.equal(parseArgs([]).year, null);
  assert.equal(parseArgs([]).force, false);
});

test('tileCachePath: 年ごとにディレクトリを分ける', () => {
  const p = tileCachePath('/tmp/.cache', { zoom: 13, x: 7168, y: 3232, year: 2026 });
  assert.equal(p, path.join('/tmp/.cache', 'land-price', '2026', '13-7168-3232.geojson'));
});

// --- CSV の読み書き（入出力の往復） ------------------------------------------------

testAsync('readFacilitiesCsv / writeFacilitiesCsv: 元の列を保ったまま3列を末尾に足す', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-price-test-'));
  try {
    const inPath = path.join(dir, 'in.csv');
    const outPath = path.join(dir, 'out.csv');
    fs.writeFileSync(
      inPath,
      'prefecture,city,name,lat,lng\n' +
        '京都府,宇治市,"テスト, 食堂",34.884,135.799\n' +
        '京都府,宇治市,座標なし店,,\n',
      'utf-8',
    );

    const { header, rows } = readFacilitiesCsv(inPath);
    assert.deepEqual(header, ['prefecture', 'city', 'name', 'lat', 'lng']);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, 'テスト, 食堂', '引用符付きのセルも正しく読める');

    // 1行目だけランクが付いた状態を作って書き出す。
    Object.assign(rows[0], { land_price: 250000, land_price_distance_m: 120, land_price_rank: 4 });
    Object.assign(rows[1], { land_price: null, land_price_distance_m: null, land_price_rank: null });
    await writeFacilitiesCsv(outPath, header, rows);

    const lines = fs.readFileSync(outPath, 'utf-8').trimEnd().split('\n');
    assert.equal(lines[0], [...header, ...LAND_PRICE_COLUMNS].join(','), 'ヘッダーは元の列＋3列');
    assert.equal(lines[1], '京都府,宇治市,"テスト, 食堂",34.884,135.799,250000,120,4');
    assert.equal(lines[2], '京都府,宇治市,座標なし店,,,,,', '付与できなかった行は空セルで出す');
    assert.notEqual(fs.readFileSync(outPath).subarray(0, 3).toString('hex'), 'efbbbf', 'BOM なし UTF-8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 通信する関数（すべて fetchImpl をモックに差し替える） -------------------------

testAsync(`fetchLandPriceTile: ${API_KEY_HEADER} ヘッダでキーを渡す`, async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, json: async () => ({ type: 'FeatureCollection', features: [] }) };
  };
  await fetchLandPriceTile({ zoom: 13, x: 1, y: 2, year: 2026 }, { apiKey: 'KEY', fetchImpl });
  assert.equal(seen.opts.headers[API_KEY_HEADER], 'KEY');
  assert.ok(seen.url.includes('XPT002'));
});

testAsync('fetchLandPriceTile: 404 は「そのタイルにデータが無い」として空で返す', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, statusText: 'Not Found' });
  const json = await fetchLandPriceTile({ zoom: 13, x: 1, y: 2, year: 2026 }, { apiKey: 'KEY', fetchImpl });
  assert.deepEqual(json.features, []);
});

testAsync('fetchLandPriceTile: 404 以外の失敗は例外（黙って空にしない）', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, statusText: 'Unauthorized' });
  await assert.rejects(
    () => fetchLandPriceTile({ zoom: 13, x: 1, y: 2, year: 2026 }, { apiKey: 'BAD', fetchImpl }),
    /401/,
  );
});

testAsync('fetchCommercialPoints: 2回目はキャッシュを使い API を叩き直さない', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-price-test-'));
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ type: 'FeatureCollection', features: [feature(135.5, 34.7, '1,200,000(円/㎡)')] }),
      };
    };
    const opts = { apiKey: 'KEY', year: 2026, zoom: 13, cacheDir, fetchImpl, delayMs: 0, log: () => {} };
    const tiles = [{ x: 7168, y: 3232 }];

    const first = await fetchCommercialPoints(tiles, opts);
    assert.deepEqual({ calls, points: first.points.length, fetched: first.fetched, cached: first.cached }, { calls: 1, points: 1, fetched: 1, cached: 0 });
    assert.ok(fs.existsSync(tileCachePath(cacheDir, { zoom: 13, x: 7168, y: 3232, year: 2026 })), 'キャッシュファイルが .cache に残る');

    const second = await fetchCommercialPoints(tiles, opts);
    assert.deepEqual({ calls, points: second.points.length, fetched: second.fetched, cached: second.cached }, { calls: 1, points: 1, fetched: 0, cached: 1 });
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

testAsync('fetchCommercialPoints: 1タイルの失敗で全体を止めない（残りは取得を続ける）', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-price-test-'));
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 500, statusText: 'Internal Server Error' };
      return {
        ok: true,
        status: 200,
        json: async () => ({ type: 'FeatureCollection', features: [feature(135.5, 34.7, '900,000(円/㎡)')] }),
      };
    };
    const res = await fetchCommercialPoints(
      [{ x: 1, y: 1 }, { x: 2, y: 2 }],
      { apiKey: 'KEY', year: 2026, zoom: 13, cacheDir, fetchImpl, delayMs: 0, log: () => {} },
    );
    assert.deepEqual({ failed: res.failed, fetched: res.fetched, points: res.points.length }, { failed: 1, fetched: 1, points: 1 });
    assert.equal(fs.existsSync(tileCachePath(cacheDir, { zoom: 13, x: 1, y: 1, year: 2026 })), false, '失敗したタイルはキャッシュに残さない（次回再試行される）');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

testAsync(`runEnrichment: ${API_KEY_ENV} が未設定なら fetch せずスキップする`, async () => {
  const saved = process.env[API_KEY_ENV];
  delete process.env[API_KEY_ENV];
  try {
    let calls = 0;
    const messages = [];
    const facilities = [{ name: '店A', lat: 35.0, lng: 135.0 }];
    const result = await runEnrichment(facilities, {
      fetchImpl: async () => {
        calls++;
        throw new Error('APIキーが無いのにネットワークへ出ている');
      },
      log: (m) => messages.push(m),
    });

    assert.equal(result.skipped, true);
    assert.equal(calls, 0, 'fetch を1度も呼ばない');
    assert.ok(messages.join('\n').includes(API_KEY_ENV), '環境変数名を含む理由を必ず表示する（黙ってスキップしない）');
    assert.equal(facilities[0].land_price, undefined, 'スキップ時は列を付けない');
  } finally {
    if (saved !== undefined) process.env[API_KEY_ENV] = saved;
  }
});

testAsync('runEnrichment: キーがあればタイル取得から付与まで通す（fetch はモック）', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-price-test-'));
  try {
    // どのタイルを要求されても、施設のすぐ近くに商業地ポイントを1点返す。
    // ランクの母集団を満たすため、価格だけ少しずつずらして返す。
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          type: 'FeatureCollection',
          features: [feature(135.0 + calls * 0.0001, 35.0, `${calls * 10},000(円/㎡)`)],
        }),
      };
    };
    const facilities = [{ name: '店A', lat: 35.0, lng: 135.0 }];
    const result = await runEnrichment(facilities, {
      apiKey: 'KEY',
      year: 2026,
      zoom: TILE_ZOOM,
      cacheDir,
      fetchImpl,
      delayMs: 0,
      log: () => {},
    });

    assert.equal(result.skipped, false);
    assert.equal(calls, 9, '3×3の9タイルを取得する');
    assert.equal(result.points, 9);
    assert.equal(typeof facilities[0].land_price, 'number');
    assert.equal(typeof facilities[0].land_price_distance_m, 'number');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

// --- 実行 -----------------------------------------------------------------------

for (const { name, fn } of asyncTests) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log(`\n✅ land-price-rank テスト: ${passed}件すべて合格`);

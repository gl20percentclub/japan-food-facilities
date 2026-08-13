// 都道府県の行政界による座標の検証。
//
// 施設の座標が、そのレコードの都道府県の外に落ちていないかを判定する。
// 元データの緯度経度には、桁の取り違え・別自治体の座標の紛れ込み・列の入れ替わりが
// 混ざっている。lib/normalize.js の sanitizeLatLng は「日本国内かどうか」までしか
// 見ないため、県をまたいだ誤りは素通りしていた。
//
// 住所文字列（「○○県…」で始まるか）での突き合わせでは足りない。配信中データの
// 実測では、住所の 35.5% が都道府県名で始まっておらず照合できず、文字列比較で
// 検出できた不一致は 438件（0.03%）にとどまった。座標そのものを行政界と
// 突き合わせる必要がある。
//
// 判定はラスタマスクで行う。都道府県ポリゴンを約200mのセルに焼いておけば、
// 1点あたりの判定は配列アクセス1回で済む（100万点を総当たりで多角形判定すると
// 現実的な時間で終わらない）。
//
// 行政界データ: smartnews-smri/japan-topography の簡略版（s0010）。
// 国土数値情報「行政区域データ(N03)」を加工したもので、都道府県ごとに1ファイル。
// 簡略化されているぶん海岸線は実際より内側に寄るため、判定には余裕（バッファ）を持たせる。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { fetchWithRetry } from './acquire.js';
import { PREFECTURE_BY_CODE } from './prefectures.js';

const CACHE_DIR = path.join(ROOT, '.cache', 'admin');
const BASE_URL =
  'https://raw.githubusercontent.com/smartnews-smri/japan-topography/main/data/municipality/geojson/s0010';
/** ファイル名は N03-21_{都道府県コード2桁}_210101.json */
const fileName = (code) => `N03-21_${code}_210101.json`;

/** ラスタセルの一辺（度）。緯度方向で約220m、経度方向で北緯35度なら約180m。 */
export const CELL_DEG = 0.002;

/**
 * 県外と判定するまでに許すセル数（約1km）。
 *
 * 簡略化された行政界は実際の海岸線・県境より内側に寄るため、埋立地や海沿い、
 * 県境沿いの施設が「県外」に見えてしまう。ここで拾いたいのは県をまたぐ規模の
 * 誤りなので、境界付近は安全側に倒して残す。
 */
export const BUFFER_CELLS = 5;

/**
 * 空のラスタマスクを作る（純粋関数）。
 * bbox からセル数を決め、1セル1バイトのビットマップを確保する。
 */
export function createMask(bbox, cell = CELL_DEG) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const rows = Math.max(1, Math.ceil((maxLat - minLat) / cell) + 1);
  const cols = Math.max(1, Math.ceil((maxLng - minLng) / cell) + 1);
  return { minLat, minLng, rows, cols, cell, bits: new Uint8Array(rows * cols) };
}

/**
 * GeoJSON の Feature 配列から bbox を求める（純粋関数）。
 * 返り値は [minLng, minLat, maxLng, maxLat]。
 */
export function boundsOf(features) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const ring of eachRing(features)) {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [minLng, minLat, maxLng, maxLat];
}

/** Feature 配列に含まれる全リング（外環・穴）を順に返すジェネレータ。 */
function* eachRing(features) {
  for (const f of features) {
    const g = f && f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') yield* g.coordinates;
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) yield* poly;
  }
}

/** Feature 配列を「ポリゴン単位（穴を含むリング群）」で返すジェネレータ。 */
function* eachPolygon(features) {
  for (const f of features) {
    const g = f && f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') yield g.coordinates;
    else if (g.type === 'MultiPolygon') yield* g.coordinates;
  }
}

/**
 * リング群（1ポリゴン＝外環＋穴）をマスクへ塗る（破壊的に更新）。
 *
 * 走査線（スキャンライン）法。セル中心の緯度ごとに、その緯度を跨ぐ辺との交点を
 * 求めて昇順に並べ、交点の対と対の間を塗る。同じポリゴンの穴も同じ交点列に
 * 混ぜることで、偶奇規則により穴が自動的に抜ける。
 *
 * 交点は「その辺が跨ぐ行」だけに積むので、計算量は辺の縦方向の長さに比例する
 * （全辺 × 全行の総当たりにはならない）。
 */
export function fillPolygon(mask, rings) {
  const { minLat, minLng, rows, cols, cell, bits } = mask;
  const xsByRow = new Map(); // row -> 交点の経度の配列

  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      if (y1 === y2) continue; // 水平な辺は交点を持たない
      const loY = Math.min(y1, y2);
      const hiY = Math.max(y1, y2);
      // この辺が跨ぐ行の範囲（セル中心の緯度が [loY, hiY) に入る行）
      let r0 = Math.ceil((loY - minLat) / cell - 0.5);
      let r1 = Math.floor((hiY - minLat) / cell - 0.5);
      if (r0 < 0) r0 = 0;
      if (r1 > rows - 1) r1 = rows - 1;
      for (let r = r0; r <= r1; r++) {
        const y = minLat + (r + 0.5) * cell;
        // 上端は含めない（頂点を2回数えて塗りが反転するのを防ぐ半開区間）
        if (y < loY || y >= hiY) continue;
        const x = x1 + ((y - y1) * (x2 - x1)) / (y2 - y1);
        let xs = xsByRow.get(r);
        if (!xs) xsByRow.set(r, (xs = []));
        xs.push(x);
      }
    }
  }

  for (const [r, xs] of xsByRow) {
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      let c0 = Math.ceil((xs[i] - minLng) / cell - 0.5);
      let c1 = Math.floor((xs[i + 1] - minLng) / cell - 0.5);
      if (c0 < 0) c0 = 0;
      if (c1 > cols - 1) c1 = cols - 1;
      const base = r * cols;
      for (let c = c0; c <= c1; c++) bits[base + c] = 1;
    }
  }
  return mask;
}

/**
 * GeoJSON の Feature 配列からラスタマスクを作る。
 * ポリゴンごとに塗って論理和を取るため、飛び地・離島も1枚のマスクに収まる。
 */
export function buildMask(features, cell = CELL_DEG) {
  const mask = createMask(boundsOf(features), cell);
  for (const rings of eachPolygon(features)) fillPolygon(mask, rings);
  return mask;
}

/**
 * 座標がマスクの内側か（純粋関数）。bbox の外なら false。
 */
export function maskHas(mask, lat, lng) {
  const r = Math.floor((lat - mask.minLat) / mask.cell);
  const c = Math.floor((lng - mask.minLng) / mask.cell);
  if (r < 0 || c < 0 || r >= mask.rows || c >= mask.cols) return false;
  return mask.bits[r * mask.cols + c] === 1;
}

/**
 * 座標がマスクの内側、または buffer セル以内に内側があるか（純粋関数）。
 * 簡略化された境界の誤差を吸収するための緩い判定。
 */
export function maskHasNear(mask, lat, lng, buffer = BUFFER_CELLS) {
  if (maskHas(mask, lat, lng)) return true;
  const r0 = Math.floor((lat - mask.minLat) / mask.cell);
  const c0 = Math.floor((lng - mask.minLng) / mask.cell);
  for (let r = r0 - buffer; r <= r0 + buffer; r++) {
    if (r < 0 || r >= mask.rows) continue;
    const base = r * mask.cols;
    for (let c = c0 - buffer; c <= c0 + buffer; c++) {
      if (c < 0 || c >= mask.cols) continue;
      if (mask.bits[base + c] === 1) return true;
    }
  }
  return false;
}

/**
 * 都道府県コード（2桁）の行政界 GeoJSON を取得する。
 * 一度取得したら .cache/admin/ に置き、次回以降は再ダウンロードしない。
 */
async function loadPrefGeoJson(code) {
  const cachePath = path.join(CACHE_DIR, `${code}.json`);
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  }
  const buf = await fetchWithRetry(`${BASE_URL}/${fileName(code)}`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, Buffer.from(buf));
  return JSON.parse(Buffer.from(buf).toString('utf-8'));
}

/**
 * 施設の座標を都道府県の行政界と突き合わせ、県外に落ちているものの座標を落とす。
 *
 * 都道府県ごとに「マスクを作る → その県の施設だけ判定する → マスクを捨てる」を
 * 繰り返す。47県ぶんのマスクを同時に持たないため、メモリは最大の県（北海道）の
 * 1枚（約10MB）で足りる。
 *
 * 行政界データを取得できなかった場合は、その県の判定だけを飛ばして続行する。
 * 週次クロールを外部リポジトリの可用性に巻き込まないための措置。
 *
 * @param {Array} facilities 施設（pref / lat / lng を持つ）
 * @param {{dropCoord:Function, buffer?:number, log?:Function}} options
 * @returns {{outside:number, checked:number, skippedPrefs:string[]}}
 */
export async function applyPrefBoundary(
  facilities,
  { dropCoord, buffer = BUFFER_CELLS, log = console.log } = {},
) {
  // 都道府県コード → その県の施設（座標を持つものだけ）
  const byCode = new Map();
  const codeOf = new Map(Object.entries(PREFECTURE_BY_CODE).map(([c, n]) => [n, c]));
  for (const f of facilities) {
    if (f.lat == null || f.lng == null) continue;
    const code = codeOf.get(f.pref ?? f._pref);
    if (!code) continue; // 都道府県が '不明' のレコードは判定できない
    let list = byCode.get(code);
    if (!list) byCode.set(code, (list = []));
    list.push(f);
  }

  let outside = 0;
  let checked = 0;
  const skippedPrefs = [];

  for (const [code, list] of [...byCode.entries()].sort()) {
    let geojson;
    try {
      geojson = await loadPrefGeoJson(code);
    } catch (err) {
      skippedPrefs.push(PREFECTURE_BY_CODE[code]);
      log(`  ⚠ ${PREFECTURE_BY_CODE[code]} の行政界を取得できず判定をスキップ: ${err.message}`);
      continue;
    }
    const mask = buildMask(geojson.features || []);
    for (const f of list) {
      checked++;
      if (!maskHasNear(mask, f.lat, f.lng, buffer)) {
        dropCoord(f);
        outside++;
      }
    }
  }

  log(
    `  県外に落ちていた座標: ${outside.toLocaleString('en-US')}件 を除去` +
      `（判定対象 ${checked.toLocaleString('en-US')}件` +
      `${skippedPrefs.length ? ` / 行政界を取得できず未判定 ${skippedPrefs.length}県` : ''}）`,
  );

  return { outside, checked, skippedPrefs };
}

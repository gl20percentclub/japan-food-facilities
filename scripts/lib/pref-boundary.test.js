// pref-boundary.js のラスタマスク（行政界の内外判定）を固定入力で検証する。
//
//   node scripts/lib/pref-boundary.test.js

import {
  createMask,
  boundsOf,
  buildMask,
  maskHas,
  maskHasNear,
  CELL_DEG,
} from './pref-boundary.js';

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

console.log('pref-boundary テスト\n');

/** 閉じた矩形リングを作る（GeoJSON のリングは始点と終点が一致する）。 */
const rect = (minLng, minLat, maxLng, maxLat) => [
  [minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat],
];
/** Polygon の Feature を作る。 */
const polygon = (...rings) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: rings } });

// --- boundsOf / createMask ---
const square = polygon(rect(139.0, 35.0, 139.1, 35.1));
const bbox = boundsOf([square]);
assert(
  bbox[0] === 139.0 && bbox[1] === 35.0 && bbox[2] === 139.1 && bbox[3] === 35.1,
  'boundsOf が [minLng, minLat, maxLng, maxLat] を返す',
);
const empty = createMask(bbox, CELL_DEG);
// 0.1度 / 0.002度 = 50 区間 → 端を含めて51セル。浮動小数の誤差で1セル多くなることがあるため
// 幅そのものではなく「bbox の端まで格子が届いていること」を検証する。
assert(
  empty.rows >= 51 && empty.rows <= 52 && empty.cols >= 51 && empty.cols <= 52,
  `セル0.002度で0.1度四方は51セル前後（実際 ${empty.rows}x${empty.cols}）`,
);
assert(
  Math.floor((35.1 - empty.minLat) / empty.cell) < empty.rows &&
    Math.floor((139.1 - empty.minLng) / empty.cell) < empty.cols,
  '格子が bbox の右上端まで届いている（端のセルが欠けない）',
);
assert(empty.bits.every((b) => b === 0), '作りたてのマスクは全セル0');

// --- 単純な矩形の内外 ---
const m = buildMask([square]);
assert(maskHas(m, 35.05, 139.05) === true, '矩形の中心は内側');
assert(maskHas(m, 35.02, 139.09) === true, '矩形の内側の別の点も内側');
assert(maskHas(m, 35.05, 139.2) === false, '矩形の外（経度が範囲外）は外側');
assert(maskHas(m, 35.5, 139.05) === false, '矩形の外（緯度が範囲外）は外側');

// --- 穴（ドーナツ）は外側になる ---
const donut = buildMask([polygon(rect(139.0, 35.0, 139.1, 35.1), rect(139.04, 35.04, 139.06, 35.06))]);
assert(maskHas(donut, 35.05, 139.05) === false, '穴の中は外側（偶奇規則で抜ける）');
assert(maskHas(donut, 35.02, 139.02) === true, '穴の外かつ外環の内側は内側');

// --- 飛び地・離島（MultiPolygon）が1枚のマスクに収まる ---
const multi = buildMask([
  {
    type: 'Feature',
    geometry: {
      type: 'MultiPolygon',
      coordinates: [[rect(139.0, 35.0, 139.02, 35.02)], [rect(139.3, 35.3, 139.32, 35.32)]],
    },
  },
]);
assert(maskHas(multi, 35.01, 139.01) === true, 'MultiPolygon の1つ目のポリゴンが内側');
assert(maskHas(multi, 35.31, 139.31) === true, 'MultiPolygon の2つ目（離島）も内側');
assert(maskHas(multi, 35.15, 139.15) === false, '2つのポリゴンの間は外側');

// --- バッファ付き判定 ---
// 矩形の外側に 3セル（約0.006度）離れた点
const nearLng = 139.1 + CELL_DEG * 3;
assert(maskHas(m, 35.05, nearLng) === false, '3セル外の点はバッファなしでは外側');
assert(maskHasNear(m, 35.05, nearLng, 5) === true, 'バッファ5セルなら3セル外の点は内側扱い');
assert(maskHasNear(m, 35.05, nearLng, 1) === false, 'バッファ1セルでは3セル外の点は外側のまま');
assert(
  maskHasNear(m, 35.05, 139.5, 5) === false,
  'bbox から大きく外れた点はバッファを付けても外側',
);
assert(maskHasNear(m, 35.05, 139.05, 0) === true, 'バッファ0でも内側の点は内側');

console.log(failures === 0 ? '\n✅ すべて成功' : `\n❌ ${failures}件 失敗`);
process.exit(failures === 0 ? 0 : 1);

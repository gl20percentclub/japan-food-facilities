// coord-quality.js の座標品質フィルタを固定入力で検証する。
//
//   node scripts/lib/coord-quality.test.js

import {
  isRepresentativeLevel,
  applyCoordQuality,
  dropCoord,
  hasCoord,
} from './coord-quality.js';
import { isPlaceholderAddress } from './normalize.js';

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

console.log('coord-quality テスト\n');

// --- isRepresentativeLevel: 1/2 だけが代表点 ---
assert(isRepresentativeLevel(1) === true, 'level 1（都道府県代表点）は代表点');
assert(isRepresentativeLevel(2) === true, 'level 2（市区町村代表点）は代表点');
assert(isRepresentativeLevel(3) === false, 'level 3（町丁目）は代表点ではない');
assert(isRepresentativeLevel(8) === false, 'level 8（街区・地番）は代表点ではない');
assert(isRepresentativeLevel(null) === false, 'level null（元データ座標）は代表点ではない');
assert(isRepresentativeLevel('') === false, 'level 空文字（CSV由来）は代表点ではない');
assert(isRepresentativeLevel('2') === true, 'level が文字列の "2" でも代表点と判定する');

// --- applyCoordQuality: 座標だけを落とし、レコードは残す ---
const facilities = [
  // 1) プレースホルダ住所に元データ座標が付いているケース
  { name: 'キッチンカーA', address: '都内一円', pref: '東京都', city: '渋谷区', lat: 35.66, lng: 139.69, geocoding_level: null },
  // 2) 市区町村の代表点
  { name: '店B', address: '愛知県岡崎市洞町字的場72-2', pref: '愛知県', city: '岡崎市', lat: 34.95, lng: 137.17, geocoding_level: 2 },
  // 2) 都道府県の代表点
  { name: '店B2', address: '愛知県岡崎市洞町字的場72-3', pref: '愛知県', city: '岡崎市', lat: 35.18, lng: 136.9, geocoding_level: 1 },
  // 残るべき正常な座標
  { name: '店C', address: '東京都港区赤坂1-1-12', pref: '東京都', city: '港区', lat: 35.67, lng: 139.74, geocoding_level: 8 },
  // level 3（町丁目）は仕様どおりの精度なので残す
  { name: '店C2', address: '東京都港区赤坂1-1-14', pref: '東京都', city: '港区', lat: 35.671, lng: 139.741, geocoding_level: 3 },
  // 座標を持たない行（触らない）
  { name: '店D', address: '東京都港区赤坂1-1-13', pref: '東京都', city: '港区', lat: null, lng: null, geocoding_level: null },
];
const before = facilities.length;
const stats = applyCoordQuality(facilities, { isPlaceholderAddress, log: () => {} });

assert(facilities.length === before, 'レコードは1件も削除しない');
assert(stats.placeholder === 1, `プレースホルダ住所の座標を1件落とす（実際 ${stats.placeholder}）`);
assert(stats.representative === 2, `代表点(level1/2)を2件落とす（実際 ${stats.representative}）`);
assert(!hasCoord(facilities[0]) && facilities[0].name === 'キッチンカーA', 'プレースホルダ行は座標だけ空になり名前は残る');
assert(facilities[0].geocoding_level === null, '座標を落とした行は geocoding_level も空にする');
assert(facilities[0].address === '都内一円', '住所は書き換えない');
assert(!hasCoord(facilities[1]) && !hasCoord(facilities[2]), '代表点の行は座標が空になる');
assert(hasCoord(facilities[3]) && facilities[3].lat === 35.67, '正常な座標（level 8）はそのまま残る');
assert(hasCoord(facilities[4]) && facilities[4].geocoding_level === 3, 'level 3 の座標は落とさない（町丁目は仕様どおりの精度）');
assert(!hasCoord(facilities[5]), '座標を持たない行はそのまま');

// --- プレースホルダ判定はレベルより先に効く ---
// 「県内一円」に level 3 が付いていても、住所が無効なのでプレースホルダとして落とす。
const order = [
  { name: '移動販売', address: '大分県内一円', pref: '大分県', city: '不明', lat: 33.239, lng: 131.609, geocoding_level: 3 },
];
const s2 = applyCoordQuality(order, { isPlaceholderAddress, log: () => {} });
assert(
  s2.placeholder === 1 && s2.representative === 0,
  'プレースホルダ住所はレベルによる判定より先に落とす',
);

// --- dropCoord 単体 ---
const one = { lat: 1, lng: 2, geocoding_level: 8 };
dropCoord(one);
assert(one.lat === null && one.lng === null && one.geocoding_level === null, 'dropCoord が3列とも空にする');

console.log(failures === 0 ? '\n✅ すべて成功' : `\n❌ ${failures}件 失敗`);
process.exit(failures === 0 ? 0 : 1);

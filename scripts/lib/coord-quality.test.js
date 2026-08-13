// coord-quality.js の座標品質フィルタを固定入力で検証する。
//
//   node scripts/lib/coord-quality.test.js

import {
  isRepresentativeLevel,
  coordKey,
  townKey,
  findFallbackCoords,
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

// --- coordKey: 桁数の違う同一座標が同じキーになる ---
assert(
  coordKey(35.6816, 139.7671) === coordKey(35.68160000, 139.76710000),
  '末尾の0が違うだけの座標は同じキーになる',
);
assert(
  coordKey(35.6816001, 139.7671) !== coordKey(35.6817001, 139.7671),
  '小数6桁で違う座標は別キーになる',
);

// --- townKey: 都道府県・市区町村の前置ゆれを吸収して町名だけを取り出す ---
assert(
  townKey('愛媛県松山市二番町1丁目4-25', '愛媛県', '松山市') === '二番町',
  '都道府県・市区町村を剥がして最初の数字までを町名にする',
);
assert(
  townKey('松山市二番町1丁目4-25', '愛媛県', '松山市') === '二番町',
  '都道府県が前置されていない表記でも同じ町名になる',
);
assert(
  townKey('愛媛県松山市二番町１丁目４－２５', '愛媛県', '松山市') === '二番町',
  '全角数字でも同じ町名になる（NFKC 正規化）',
);
assert(
  townKey('東京都港区赤坂一丁目1番12号 溜池明産ビル1階', '東京都', '港区') === '赤坂一丁目',
  '漢数字の丁目は町名の一部として残る',
);
assert(
  townKey('京都市中京区先斗町四条上ル柏屋町170', '京都府', '京都市') === '中京区先斗町四条上ル柏屋町',
  '政令市の行政区は町名の一部として残る',
);

// --- findFallbackCoords: 件数と町名の異なり数の両方を満たすときだけ検出する ---
// 町名は数字を含まない実在風の名前を巡回させる（連番を住所に埋めると
// townKey が最初の数字で切るため、町名が1種類に潰れてテストにならない）。
const TOWNS = ['権堂町', '新田町', '問御所町', '鶴賀', '妻科', '西後町'];

// 実在の商業施設: 件数は多いが町名は1種類
const mall = Array.from({ length: 60 }, (_, i) => ({
  lat: 35.1, lng: 135.1, pref: '大阪府', city: '大阪市', address: `大阪府大阪市北区梅田1-1-${i}`,
}));
// 代表点フォールバック: 多数の町名が1点に集まる
const fallback = Array.from({ length: 60 }, (_, i) => ({
  lat: 36.2, lng: 136.2, pref: '長野県', city: '長野市',
  address: `長野県長野市${TOWNS[i % TOWNS.length]}${i}-1`,
}));
// 町名は多いが件数が閾値未満
const small = Array.from({ length: 10 }, (_, i) => ({
  lat: 37.3, lng: 137.3, pref: '新潟県', city: '新潟市',
  address: `新潟県新潟市${TOWNS[i % TOWNS.length]}${i}-1`,
}));

const flagged = findFallbackCoords([...mall, ...fallback, ...small], { minCount: 50, minTowns: 5 });
assert(
  flagged.has(coordKey(36.2, 136.2)),
  '多数の町名が1点に集まる座標はフォールバックとして検出する',
);
assert(
  !flagged.has(coordKey(35.1, 135.1)),
  '町名が1種類なら件数が多くても検出しない（実在の商業施設を守る）',
);
assert(
  !flagged.has(coordKey(37.3, 137.3)),
  '町名が多くても件数が閾値未満なら検出しない',
);

// --- applyCoordQuality: 座標だけを落とし、レコードは残す ---
const facilities = [
  // 1) プレースホルダ住所に元データ座標が付いているケース
  { name: 'キッチンカーA', address: '都内一円', pref: '東京都', city: '渋谷区', lat: 35.66, lng: 139.69, geocoding_level: null },
  // 3) 市区町村の代表点
  { name: '店B', address: '愛知県岡崎市洞町字的場72-2', pref: '愛知県', city: '岡崎市', lat: 34.95, lng: 137.17, geocoding_level: 2 },
  // 残るべき正常な座標
  { name: '店C', address: '東京都港区赤坂1-1-12', pref: '東京都', city: '港区', lat: 35.67, lng: 139.74, geocoding_level: 8 },
  // 座標を持たない行（触らない）
  { name: '店D', address: '東京都港区赤坂1-1-13', pref: '東京都', city: '港区', lat: null, lng: null, geocoding_level: null },
  // 2) フォールバック座標（町名が多数・件数が閾値以上）
  ...Array.from({ length: 55 }, (_, i) => ({
    name: `店E${i}`, address: `長野県長野市大字${TOWNS[i % TOWNS.length]}${i}-1449`, pref: '長野県', city: '長野市',
    lat: 36.648, lng: 138.195, geocoding_level: 3,
  })),
];
const before = facilities.length;
const stats = applyCoordQuality(facilities, {
  isPlaceholderAddress,
  minCount: 50,
  minTowns: 5,
  log: () => {},
});

assert(facilities.length === before, 'レコードは1件も削除しない');
assert(stats.placeholder === 1, `プレースホルダ住所の座標を1件落とす（実際 ${stats.placeholder}）`);
assert(stats.representative === 1, `代表点(level1/2)を1件落とす（実際 ${stats.representative}）`);
assert(stats.fallback === 55, `フォールバック座標を55件落とす（実際 ${stats.fallback}）`);
assert(!hasCoord(facilities[0]) && facilities[0].name === 'キッチンカーA', 'プレースホルダ行は座標だけ空になり名前は残る');
assert(facilities[0].geocoding_level === null, '座標を落とした行は geocoding_level も空にする');
assert(hasCoord(facilities[2]), '正常な座標（level 8）はそのまま残る');
assert(facilities[2].lat === 35.67, '残した座標の値は書き換えない');
assert(!hasCoord(facilities[4]), 'フォールバック座標の行は座標が空になる');

// --- 適用順の検証: プレースホルダの山はフォールバック判定に持ち込まれない ---
const placeholderPile = Array.from({ length: 100 }, (_, i) => ({
  name: `移動販売${i}`, address: '大分県内一円', pref: '大分県', city: '不明',
  lat: 33.239, lng: 131.609, geocoding_level: null,
}));
const stats2 = applyCoordQuality(placeholderPile, {
  isPlaceholderAddress, minCount: 50, minTowns: 5, log: () => {},
});
assert(
  stats2.placeholder === 100 && stats2.fallback === 0,
  'プレースホルダを先に落とすため、同じ行がフォールバックとして二重に数えられない',
);

// --- dropCoord 単体 ---
const one = { lat: 1, lng: 2, geocoding_level: 8 };
dropCoord(one);
assert(one.lat === null && one.lng === null && one.geocoding_level === null, 'dropCoord が3列とも空にする');

console.log(failures === 0 ? '\n✅ すべて成功' : `\n❌ ${failures}件 失敗`);
process.exit(failures === 0 ? 0 : 1);

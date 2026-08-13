// name-cluster.js の名寄せによる座標統一を固定入力で検証する。
//
//   node scripts/lib/name-cluster.test.js

import {
  normalizeFacilityName,
  distanceMeters,
  precisionRank,
  median,
  pickRepresentative,
  clusterByDistance,
  unifyCoordsByName,
} from './name-cluster.js';

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
/** 誤差を許した数値比較。 */
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('name-cluster テスト\n');

// --- normalizeFacilityName ---
assert(
  normalizeFacilityName('株式会社ラーメン太郎') === normalizeFacilityName('ラーメン太郎'),
  '法人格の有無を吸収する',
);
assert(
  normalizeFacilityName('㈱ラーメン太郎') === normalizeFacilityName('ラーメン太郎'),
  '㈱ の合字も法人格として落とす',
);
assert(
  normalizeFacilityName('ラーメン　太郎・本店') === normalizeFacilityName('ラーメン太郎本店'),
  '空白と中黒を落とす',
);
assert(
  normalizeFacilityName('ＣＡＦＥ　ＢＡＲ') === normalizeFacilityName('cafe bar'),
  '全角・大文字小文字を吸収する（NFKC + 大文字化）',
);
assert(
  normalizeFacilityName('セブン-イレブン東京店') === normalizeFacilityName('セブンイレブン東京店'),
  'ハイフンの有無を吸収する',
);
assert(
  normalizeFacilityName('ラーメン太郎') !== normalizeFacilityName('ラーメン太郎 二号店'),
  '支店名が違えば別のキーになる（別店舗を統合しない）',
);
assert(normalizeFacilityName('・・・') === '', '記号だけの名前は空キーになる');
assert(normalizeFacilityName(null) === '', 'null でも例外にならない');

// --- distanceMeters ---
// 緯度0.001度 ≒ 111.2m
assert(near(distanceMeters(35.0, 139.0, 35.001, 139.0), 111.2, 1), '緯度0.001度は約111m');
assert(distanceMeters(35.0, 139.0, 35.0, 139.0) === 0, '同一点は0m');

// --- precisionRank / median / pickRepresentative ---
assert(precisionRank(null) === 0, '元データ座標（level 空）がいちばん信用できる');
assert(precisionRank(8) === 1, 'level 8 は2番目');
assert(precisionRank(3) === 2, 'level 3 は3番目');
assert(precisionRank(null) < precisionRank(8) && precisionRank(8) < precisionRank(3), '精度の順位が期待どおり並ぶ');
assert(median([3, 1, 2]) === 2, '奇数個の中央値');
assert(median([1, 2, 3, 4]) === 2.5, '偶数個の中央値は真ん中2つの平均');
assert(median([]) === null, '空配列の中央値は null');

const rep = pickRepresentative([
  { lat: 35.0, lng: 139.0, geocoding_level: 3 },
  { lat: 35.5, lng: 139.5, geocoding_level: null },
  { lat: 35.6, lng: 139.6, geocoding_level: 8 },
]);
assert(
  rep.lat === 35.5 && rep.lng === 139.5,
  '最上位の精度（元データ座標）だけから代表点を選ぶ',
);
const repMedian = pickRepresentative([
  { lat: 35.0, lng: 139.0, geocoding_level: 8 },
  { lat: 35.1, lng: 139.1, geocoding_level: 8 },
  { lat: 39.0, lng: 143.0, geocoding_level: 8 }, // 大きく外れた1点
]);
assert(
  repMedian.lat === 35.1 && repMedian.lng === 139.1,
  '同順位なら中央値を取る（外れ値に引っ張られない）',
);

// --- clusterByDistance ---
// 0.0002度 ≒ 22m、0.002度 ≒ 222m
const pts = [
  { lat: 35.0000, lng: 139.0, id: 'a' },
  { lat: 35.0002, lng: 139.0, id: 'b' }, // a から約22m
  { lat: 35.0040, lng: 139.0, id: 'c' }, // a から約445m
];
const cl = clusterByDistance(pts, 50);
assert(cl.length === 2, `50m 半径で2グループに分かれる（実際 ${cl.length}）`);
assert(cl[0].length === 2 && cl[0][0].id === 'a' && cl[0][1].id === 'b', '22m 離れた2点は同じグループ');
assert(cl[1].length === 1 && cl[1][0].id === 'c', '445m 離れた点は別グループ');

// リーダーからの距離で切るので、数珠つなぎで際限なく広がらない
const chain = [
  { lat: 35.0000, lng: 139.0, id: 'a' },
  { lat: 35.0004, lng: 139.0, id: 'b' }, // a から約44m
  { lat: 35.0008, lng: 139.0, id: 'c' }, // b から約44m、a からは約89m
];
const chained = clusterByDistance(chain, 50);
assert(
  chained.length === 2,
  `単連結で繋がらない（a-b は同じ、c は別。実際 ${chained.length}グループ）`,
);

// --- unifyCoordsByName ---
const facilities = [
  // 同一施設が2ソースに載っているケース: 元データ座標と level 3 が約22m ずれている
  { name: '株式会社ラーメン太郎', pref: '東京都', lat: 35.0002, lng: 139.0, geocoding_level: 3 },
  { name: 'ラーメン太郎', pref: '東京都', lat: 35.0000, lng: 139.0, geocoding_level: null },
  // 同名だが遠い（別店舗）
  { name: 'ラーメン太郎', pref: '東京都', lat: 35.0100, lng: 139.0, geocoding_level: 8 },
  // 名前が違う近接店（巻き込まれないこと）
  { name: 'そば次郎', pref: '東京都', lat: 35.0001, lng: 139.0, geocoding_level: 8 },
  // 別の都道府県の同名店
  { name: 'ラーメン太郎', pref: '大阪府', lat: 35.0000, lng: 139.0, geocoding_level: 8 },
  // 座標なし（触らない）
  { name: 'ラーメン太郎', pref: '東京都', lat: null, lng: null, geocoding_level: null },
];
const stats = unifyCoordsByName(facilities, { radiusM: 50, log: () => {} });

assert(stats.moved === 1, `座標を寄せたのは1件（実際 ${stats.moved}）`);
assert(
  facilities[0].lat === 35.0 && facilities[0].lng === 139.0,
  'level 3 の座標が、より精度の高い元データ座標に置き換わる',
);
assert(
  facilities[0].geocoding_level === 3,
  'geocoding_level は書き換えない（その行の住所から解けた精度は変わらないため）',
);
assert(facilities[1].lat === 35.0, '代表点そのものの座標は変わらない');
assert(facilities[2].lat === 35.01, '同名でも 50m より遠い店は動かさない');
assert(facilities[3].lat === 35.0001, '名前が違う近接店は巻き込まない');
assert(facilities[4].lat === 35.0, '都道府県が違えば別グループ（座標は変わらない）');
assert(facilities[5].lat === null, '座標を持たない行は触らない');

// --- 名前が空のレコードだけでも落ちない ---
const noName = [
  { name: '', pref: '東京都', lat: 35.0, lng: 139.0, geocoding_level: null },
  { name: '・', pref: '東京都', lat: 35.0, lng: 139.0, geocoding_level: null },
];
const s2 = unifyCoordsByName(noName, { radiusM: 50, log: () => {} });
assert(s2.moved === 0, '名前が空のレコードは名寄せ対象にしない');

console.log(failures === 0 ? '\n✅ すべて成功' : `\n❌ ${failures}件 失敗`);
process.exit(failures === 0 ? 0 : 1);

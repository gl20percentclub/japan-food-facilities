// 地価ベースの「水準ランク」を施設に付与する（営業リスト向けの付加情報）。
//
// ---------------------------------------------------------------------------
// これは賃料ではない（最重要）
// ---------------------------------------------------------------------------
// 賃料の金額は公的オープンデータに存在しない。国土交通省 不動産情報ライブラリが
// 公開しているのは 取引価格（XIT001 / XPT001）・地価公示と地価調査のポイント
// （XPT002）・鑑定評価書（XCT001）で、**賃料は含まれない**。
//
// したがってここで作れるのは「その立地の地価が全国（または都道府県内）で
// どのあたりに位置するか」という**水準ランク**であって、実賃料ではない。
// 金額（坪いくら）へは換算しない。収益還元で出るのは土地の期待収益であって、
// テナント1区画の坪賃料ではないため、換算した瞬間に誤った数字になる。
// 出力列も「ランク」と「参照した地価」「最寄り点までの距離」に留める。
//
// ---------------------------------------------------------------------------
// 使うデータ
// ---------------------------------------------------------------------------
// 国土交通省 不動産情報ライブラリ API の XPT002（地価公示・地価調査のポイント）。
//   マニュアル: https://www.reinfolib.mlit.go.jp/help/apiManual/xpt002/
//   認証: リクエストヘッダ `Ocp-Apim-Subscription-Key`
//   API 利用申請が必要で、審査は5営業日目安（docs/LAND-PRICE-RANK.md 参照）
//
// XPT002 はタイル単位（z/x/y、z は 13〜15）で点を返す。そこで
//   1. 施設の座標が乗るタイルとその周囲8タイル（3×3）を列挙する
//   2. タイルごとに商業地（useCategoryCode=05）の点を取得し .cache に保存する
//   3. 取得した点をタイルで索引し、施設ごとに3×3の近傍だけを走査して最寄り点を選ぶ
// という手順を取る。施設×全ポイントの総当たりはしない。
//
// 使い方:
//   REINFOLIB_API_KEY=xxx node scripts/enrich/land-price-rank.js --in=api/facilities-all.csv --out=out.csv
//   （APIキーが未設定のときは、何もせず理由を表示してスキップする）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../lib/config.js';
import { readCsvRows } from '../lib/csv-read.js';
import { csvCell } from '../build/merged-csv.js';

// --- 定数 -------------------------------------------------------------------

/** 付与する列（この順で入力CSVの末尾に足す）。 */
export const LAND_PRICE_COLUMNS = ['land_price', 'land_price_distance_m', 'land_price_rank'];

/** XPT002 のエンドポイント。 */
export const XPT002_ENDPOINT = 'https://www.reinfolib.mlit.go.jp/ex-api/external/XPT002';

/** APIキーを渡すリクエストヘッダ名（不動産情報ライブラリの仕様）。 */
export const API_KEY_HEADER = 'Ocp-Apim-Subscription-Key';

/** APIキーを読む環境変数名。キーはコード・リポジトリに書かない。 */
export const API_KEY_ENV = 'REINFOLIB_API_KEY';

/** 用途区分コード: 商業地。XPT002 の useCategoryCode に渡す。 */
export const COMMERCIAL_USE_CATEGORY_CODE = '05';

// タイルのズームレベル。XPT002 が受け付けるのは 13〜15。
// 13 は1タイルが日本の緯度帯で 3.4〜4.0km 四方になり、後述の探索半径
// （MAX_RANK_DISTANCE_M）を3×3の近傍だけで賄える最小のリクエスト数になる。
// 14・15 にするとタイル数が4倍・16倍に増えるだけで、得られる点は変わらない。
export const TILE_ZOOM = 13;

// 最寄り点の探索範囲（タイル何枚分まで見るか）。1 = 自タイル＋周囲8枚の3×3。
// 施設がタイルの隅にあっても、3×3ならどの方角にも最低1タイル分（≒3.4km以上）は
// 走査できる。逆に言えば、ここを 0 にすると自タイル内に点が無い施設を取りこぼす。
export const TILE_NEIGHBOR_RADIUS = 1;

// この距離を超えたらランクを付けない（列は空にする）。
//
// 理由は2つある。
//   1. 意味の問題。数km離れた地価公示ポイントは、その店舗の立地の水準を表さない。
//      「遠くの点をそのまま使って5段階に押し込む」と、根拠の無いランクが出てしまう。
//   2. 探索範囲の問題。上記のとおり3×3の近傍で保証できるのは最低 3.4km 程度。
//      それを超える距離で見つかった点は「たまたま近傍タイルに入っていただけ」で、
//      真の最寄り点である保証が無い。
// 地価・距離の2列は（閾値を超えていても）参考値として残す。遠いことが距離列から
// 分かるようにしておくのが、この設計の要点。
export const MAX_RANK_DISTANCE_M = 3000;

// 分位でランクを切るために最低限必要な点の数（5段階 × 各段5点）。
// これ未満の母集団で分位を取ると、1点動いただけでランクが総入れ替えになる。
export const MIN_POINTS_FOR_RANK = 25;

/** ランクの段階数。5 = もっとも地価が高い。 */
export const RANK_LEVELS = 5;

// 地球の平均半径（IUGG）。Haversine で測地線距離を出すのに使う。
const EARTH_RADIUS_M = 6371008.8;

// --- 純粋関数: 距離・タイル ---------------------------------------------------

/**
 * CSV 由来の値を数値に直す（数値でなければ null）。
 * `Number('')` は 0 になるため、空欄の緯度経度を「赤道上の座標」と誤解しないよう
 * 空文字・null・undefined は明示的に弾く。
 * @param {*} v
 * @returns {number|null}
 */
export function toNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 2点間の測地線距離をメートルで返す（Haversine）。
 * 数km スケールの比較しかしないので、球面近似で十分（楕円体との差は 0.5% 未満）。
 * @param {number} lat1 緯度1（度）
 * @param {number} lng1 経度1（度）
 * @param {number} lat2 緯度2（度）
 * @param {number} lng2 経度2（度）
 * @returns {number} 距離（メートル）
 */
export function haversineDistanceM(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * 経度緯度を XYZ 方式のタイル座標に変換する（Web メルカトル）。
 * @param {number} lng 経度（度）
 * @param {number} lat 緯度（度）
 * @param {number} z ズームレベル
 * @returns {{x:number, y:number}} タイル座標（整数）
 */
export function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  // 日本国内しか扱わないが、極付近・日付変更線で範囲外に出ないよう丸めておく。
  return { x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)) };
}

/** タイル座標を Map のキーに使う文字列にする。 */
export function tileKey(x, y) {
  return `${x}/${y}`;
}

/**
 * 施設群から「取得すべきタイル座標」の一覧を作る（重複排除済み）。
 *
 * 各施設のタイルだけでなく周囲 `neighborRadius` 枚も含める。施設のいない
 * 隣タイルに最寄りの商業地ポイントがある、という状況が普通にあるため
 * （駅前の商業地ポイントと、その外周にある店舗はタイルをまたぎやすい）。
 *
 * @param {Array<{lat:number, lng:number}>} facilities 座標を持つ施設
 * @param {{zoom?:number, neighborRadius?:number}} [options]
 * @returns {Array<{x:number, y:number}>} タイル座標の配列
 */
export function collectTileCoords(facilities, { zoom = TILE_ZOOM, neighborRadius = TILE_NEIGHBOR_RADIUS } = {}) {
  const seen = new Set();
  const out = [];
  const n = 2 ** zoom;
  for (const f of facilities) {
    const lat = toNumber(f.lat);
    const lng = toNumber(f.lng);
    if (lat === null || lng === null) continue;
    const t = lngLatToTile(lng, lat, zoom);
    for (let dx = -neighborRadius; dx <= neighborRadius; dx++) {
      for (let dy = -neighborRadius; dy <= neighborRadius; dy++) {
        const x = t.x + dx;
        const y = t.y + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue; // 世界地図の外は存在しない
        const key = tileKey(x, y);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ x, y });
      }
    }
  }
  return out;
}

// --- 純粋関数: レスポンスの解釈 ------------------------------------------------

/**
 * XPT002 の当年価格（u_current_years_price_ja）を数値に直す。
 * 値は「3,100,000(円/㎡)」のような文字列型なので、桁区切りと単位を落として
 * 円/㎡ の整数にする。数字が取れなければ null（休止地点・欠測を弾くため）。
 * @param {string|number|null|undefined} raw
 * @returns {number|null} 円/㎡
 */
export function parseLandPrice(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  const digits = String(raw).replace(/[^0-9]/g, '');
  if (digits === '') return null;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 用途区分が商業地かを判定する。
 * リクエストで useCategoryCode=05（商業地）に絞っているので本来は全件が商業地だが、
 * パラメータが効いていない・仕様が変わった場合に住宅地が混ざると
 * ランクの母集団が壊れるため、レスポンス側でも必ず確認する。
 * use_category_name_ja は「4,商業地」のようにコード付きの文字列で返る。
 * @param {object} props Feature の properties
 * @returns {boolean}
 */
export function isCommercialFeature(props) {
  return typeof props?.use_category_name_ja === 'string' && props.use_category_name_ja.includes('商業地');
}

/**
 * GeoJSON の Feature を、最寄り探索で使う最小限の点に落とす。
 * 商業地でないもの・座標が無いもの・価格が読めないものは null（＝採用しない）。
 * @param {object} feature GeoJSON Feature
 * @returns {{lat:number, lng:number, price:number, prefCode:string|null, year:string|null}|null}
 */
export function featureToPoint(feature) {
  const props = feature?.properties;
  if (!props || !isCommercialFeature(props)) return null;
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lng, lat] = coords;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const price = parseLandPrice(props.u_current_years_price_ja);
  if (price === null) return null;
  return {
    lat,
    lng,
    price,
    // 都道府県内の相対ランクに切り替えたときのグループキー。
    prefCode: props.prefecture_code != null ? String(props.prefecture_code) : null,
    year: props.target_year_name_ja != null ? String(props.target_year_name_ja) : null,
  };
}

/**
 * XPT002 のレスポンス（FeatureCollection）から採用できる点だけを取り出す。
 * @param {object} geojson レスポンス JSON
 * @returns {Array<object>} 点の配列（0件もありうる）
 */
export function pointsFromGeoJson(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const out = [];
  for (const f of features) {
    const p = featureToPoint(f);
    if (p) out.push(p);
  }
  return out;
}

// --- 純粋関数: 空間索引と最寄り探索 ---------------------------------------------

/**
 * 点をタイル座標で索引する（Map<tileKey, 点[]>）。
 * これを作らずに施設×全点で総当たりすると、施設100万件 × 点2万件で
 * 200億回の距離計算になり現実的な時間で終わらない。
 * @param {Array<{lat:number, lng:number}>} points
 * @param {number} [zoom]
 * @returns {Map<string, Array<object>>}
 */
export function buildPointIndex(points, zoom = TILE_ZOOM) {
  const index = new Map();
  for (const p of points) {
    const t = lngLatToTile(p.lng, p.lat, zoom);
    const key = tileKey(t.x, t.y);
    const bucket = index.get(key);
    if (bucket) bucket.push(p);
    else index.set(key, [p]);
  }
  return index;
}

/**
 * 索引から、指定座標にもっとも近い点を探す。
 * 走査するのは自タイルと周囲 `neighborRadius` 枚だけ（＝全点は見ない）。
 * 近傍に点が1つも無ければ null。
 * @param {Map<string, Array<object>>} index buildPointIndex の返り値
 * @param {number} lat 施設の緯度
 * @param {number} lng 施設の経度
 * @param {{zoom?:number, neighborRadius?:number}} [options]
 * @returns {{point:object, distanceM:number}|null}
 */
export function findNearestPoint(index, lat, lng, { zoom = TILE_ZOOM, neighborRadius = TILE_NEIGHBOR_RADIUS } = {}) {
  const la = toNumber(lat);
  const ln = toNumber(lng);
  if (la === null || ln === null) return null;
  const t = lngLatToTile(ln, la, zoom);
  let best = null;
  let bestDist = Infinity;
  for (let dx = -neighborRadius; dx <= neighborRadius; dx++) {
    for (let dy = -neighborRadius; dy <= neighborRadius; dy++) {
      const bucket = index.get(tileKey(t.x + dx, t.y + dy));
      if (!bucket) continue;
      for (const p of bucket) {
        const d = haversineDistanceM(la, ln, p.lat, p.lng);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
    }
  }
  return best ? { point: best, distanceM: bestDist } : null;
}

// --- 純粋関数: ランク付け ------------------------------------------------------

/** ソート済み配列から分位点を取る（nearest-rank 法）。 */
function quantile(sortedAsc, q) {
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(q * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

/**
 * 価格の集合から5段階ランクの閾値（4本）を作る（純粋関数）。
 *
 * 全国共通の固定金額ではなく分位で切る。地価は毎年変わるうえ、都市と郡部で
 * 桁が違うため、円の絶対値を定数で持つと数年で意味を失うから。
 * 母集団が MIN_POINTS_FOR_RANK 未満なら null を返す（呼び出し側でフォールバック）。
 *
 * @param {Array<number>} prices 円/㎡ の配列
 * @returns {Array<number>|null} 昇順の閾値4本、または null
 */
export function computeRankThresholds(prices) {
  const valid = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (valid.length < MIN_POINTS_FOR_RANK) return null;
  const cuts = [];
  for (let i = 1; i < RANK_LEVELS; i++) cuts.push(quantile(valid, i / RANK_LEVELS));
  return cuts;
}

/**
 * 価格を5段階ランクに割り当てる（1 = もっとも安い / 5 = もっとも高い）。
 * @param {number|null} price 円/㎡
 * @param {Array<number>|null} thresholds computeRankThresholds の返り値
 * @returns {number|null} 1〜5。価格または閾値が無ければ null
 */
export function assignRank(price, thresholds) {
  if (!Number.isFinite(price) || !Array.isArray(thresholds) || thresholds.length === 0) return null;
  let rank = 1;
  for (const t of thresholds) {
    if (price >= t) rank++;
  }
  return Math.min(RANK_LEVELS, rank);
}

/**
 * ランクの母集団（＝取得した商業地ポイント）から閾値の組を作る。
 *
 * scope は2通り。どちらを採るかは未決なので、切り替えられる形にしてある。
 *   'national'   全国の商業地ポイントを1つの母集団にする（既定）。
 *                全国で横に並べたときの水準が出る。郡部はほぼ 1 に寄る。
 *   'prefecture' 都道府県ごとに母集団を分ける。
 *                「その県の中で高いか」が出る。県をまたいだ比較はできなくなる。
 *
 * @param {Array<{price:number, prefCode:string|null}>} points
 * @param {{scope?:'national'|'prefecture'}} [options]
 * @returns {{scope:string, national:Array<number>|null, byPrefecture:Map<string, Array<number>>}}
 */
export function buildRankThresholds(points, { scope = 'national' } = {}) {
  const national = computeRankThresholds(points.map((p) => p.price));
  const byPrefecture = new Map();
  if (scope === 'prefecture') {
    const grouped = new Map();
    for (const p of points) {
      if (!p.prefCode) continue;
      const bucket = grouped.get(p.prefCode);
      if (bucket) bucket.push(p.price);
      else grouped.set(p.prefCode, [p.price]);
    }
    for (const [code, prices] of grouped) {
      const cuts = computeRankThresholds(prices);
      // 点が少なすぎる県は閾値を持たせない。呼び出し側が全国の閾値へ落ちる。
      if (cuts) byPrefecture.set(code, cuts);
    }
  }
  return { scope, national, byPrefecture };
}

/**
 * 閾値の組から、この点に適用すべき閾値を選ぶ。
 * scope が 'prefecture' でもその県の母集団が足りなければ全国の閾値を使う
 * （ランクを空にするより、全国基準であることをドキュメントで示すほうが実用的）。
 * @param {object} thresholdSet buildRankThresholds の返り値
 * @param {string|null} prefCode 都道府県コード
 * @returns {Array<number>|null}
 */
export function thresholdsFor(thresholdSet, prefCode) {
  if (thresholdSet.scope === 'prefecture' && prefCode && thresholdSet.byPrefecture.has(prefCode)) {
    return thresholdSet.byPrefecture.get(prefCode);
  }
  return thresholdSet.national;
}

/**
 * 施設に land_price / land_price_distance_m / land_price_rank を付与する（破壊的）。
 *
 * 距離が maxDistanceM を超えた場合、地価と距離は残したままランクだけ空にする
 * （MAX_RANK_DISTANCE_M のコメント参照）。近傍に点が1つも無い施設は3列とも空。
 *
 * @param {Array<object>} facilities lat / lng を持つ施設（無くてもよい）
 * @param {Array<object>} points 取得済みの商業地ポイント
 * @param {{zoom?:number, neighborRadius?:number, maxDistanceM?:number, rankScope?:string, log?:Function}} [options]
 * @returns {{total:number, noCoord:number, noPoint:number, matched:number, ranked:number, tooFar:number}}
 */
export function enrichFacilities(facilities, points, options = {}) {
  const {
    zoom = TILE_ZOOM,
    neighborRadius = TILE_NEIGHBOR_RADIUS,
    maxDistanceM = MAX_RANK_DISTANCE_M,
    rankScope = 'national',
    log = console.log,
  } = options;

  const index = buildPointIndex(points, zoom);
  const thresholdSet = buildRankThresholds(points, { scope: rankScope });
  const stats = { total: facilities.length, noCoord: 0, noPoint: 0, matched: 0, ranked: 0, tooFar: 0 };

  for (const f of facilities) {
    f.land_price = null;
    f.land_price_distance_m = null;
    f.land_price_rank = null;

    const lat = toNumber(f.lat);
    const lng = toNumber(f.lng);
    if (lat === null || lng === null) {
      stats.noCoord++;
      continue;
    }
    const hit = findNearestPoint(index, lat, lng, { zoom, neighborRadius });
    if (!hit) {
      stats.noPoint++;
      continue;
    }

    stats.matched++;
    f.land_price = hit.point.price;
    f.land_price_distance_m = Math.round(hit.distanceM);

    // 遠すぎる点は参考値。ランクは付けない（根拠の無い5段階を作らないため）。
    if (hit.distanceM > maxDistanceM) {
      stats.tooFar++;
      continue;
    }
    const rank = assignRank(hit.point.price, thresholdsFor(thresholdSet, hit.point.prefCode));
    if (rank !== null) {
      f.land_price_rank = rank;
      stats.ranked++;
    }
  }

  log(
    `  地価ランク付与: 対象 ${stats.total.toLocaleString('en-US')}件 / ` +
      `最寄り点あり ${stats.matched.toLocaleString('en-US')}件 / ` +
      `ランク付与 ${stats.ranked.toLocaleString('en-US')}件 / ` +
      `遠すぎてランクなし ${stats.tooFar.toLocaleString('en-US')}件 / ` +
      `座標なし ${stats.noCoord.toLocaleString('en-US')}件 / ` +
      `近傍に点なし ${stats.noPoint.toLocaleString('en-US')}件`,
  );
  return stats;
}

// --- API アクセス --------------------------------------------------------------

/**
 * 既定の対象年（価格時点の年）を決める。
 * 地価公示は毎年3月下旬に公表される（価格時点は当年1月1日）。まだ公表前の
 * 1〜3月に当年を指定すると空振りするため、4月以降なら当年・それ以前は前年を使う。
 * @param {Date} [now]
 * @returns {number} 西暦年
 */
export function defaultPriceYear(now = new Date()) {
  const y = now.getFullYear();
  return now.getMonth() + 1 >= 4 ? y : y - 1;
}

/**
 * APIキーを環境変数から読む。キーはコードにもリポジトリにも書かない。
 * @param {object} [env]
 * @returns {string|null} 未設定・空文字なら null
 */
export function resolveApiKey(env = process.env) {
  const key = env[API_KEY_ENV];
  return key && String(key).trim() !== '' ? String(key).trim() : null;
}

/**
 * XPT002 のリクエスト URL を組み立てる（純粋関数）。
 * priceClassification は指定しない＝地価公示と地価調査の両方を受け取る
 * （点の密度を落とさないため。どちらかに絞る理由が今のところ無い）。
 * @param {{zoom:number, x:number, y:number, year:number, useCategoryCode?:string}} params
 * @returns {string}
 */
export function buildRequestUrl({ zoom, x, y, year, useCategoryCode = COMMERCIAL_USE_CATEGORY_CODE }) {
  const q = new URLSearchParams({
    response_format: 'geojson',
    z: String(zoom),
    x: String(x),
    y: String(y),
    year: String(year),
    useCategoryCode,
  });
  return `${XPT002_ENDPOINT}?${q.toString()}`;
}

/**
 * タイル1枚分の XPT002 を取得する。
 * 404 は「そのタイルにデータが無い」なので空の FeatureCollection として扱う
 * （山間部など、商業地ポイントが1つも無いタイルは普通にある）。
 * @param {{zoom:number, x:number, y:number, year:number}} tile
 * @param {{apiKey:string, fetchImpl?:Function}} options
 * @returns {Promise<object>} GeoJSON
 */
export async function fetchLandPriceTile(tile, { apiKey, fetchImpl = fetch }) {
  const url = buildRequestUrl(tile);
  const res = await fetchImpl(url, { headers: { [API_KEY_HEADER]: apiKey } });
  if (res.status === 404) return { type: 'FeatureCollection', features: [] };
  if (!res.ok) {
    throw new Error(`XPT002 取得失敗: ${res.status} ${res.statusText} (z=${tile.zoom} x=${tile.x} y=${tile.y})`);
  }
  return await res.json();
}

/** タイル1枚分のキャッシュパス。年ごとにディレクトリを分ける（年をまたいでも壊れない）。 */
export function tileCachePath(cacheDir, { zoom, x, y, year }) {
  return path.join(cacheDir, 'land-price', String(year), `${zoom}-${x}-${y}.geojson`);
}

/**
 * タイル群の商業地ポイントを取得する。既に .cache にあるタイルは API を叩き直さない。
 *
 * キャッシュの流儀は lib/acquire.js と同じで、`.cache/` 配下に取得物をそのまま置き、
 * 次回は存在すれば再利用する（`force` で無視して取り直す）。タイル数は全国でも
 * 数千枚のオーダーなので、2回目以降はネットワークに一切出ない。
 *
 * @param {Array<{x:number, y:number}>} tiles collectTileCoords の返り値
 * @param {{apiKey:string, year:number, zoom?:number, cacheDir?:string, fetchImpl?:Function, force?:boolean, delayMs?:number, log?:Function}} options
 * @returns {Promise<{points:Array<object>, fetched:number, cached:number, failed:number}>}
 */
export async function fetchCommercialPoints(tiles, options) {
  const {
    apiKey,
    year,
    zoom = TILE_ZOOM,
    cacheDir = path.join(ROOT, '.cache'),
    fetchImpl = fetch,
    force = false,
    delayMs = 200, // 公開APIに優しくするための待機（連続リクエストの間隔）
    log = console.log,
  } = options;

  const points = [];
  let fetched = 0;
  let cached = 0;
  let failed = 0;

  for (const t of tiles) {
    const tile = { zoom, x: t.x, y: t.y, year };
    const cachePath = tileCachePath(cacheDir, tile);
    let geojson = null;

    // 1) キャッシュを優先する。壊れた JSON が残っていた場合は取り直す。
    if (!force && fs.existsSync(cachePath)) {
      try {
        geojson = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        cached++;
      } catch {
        geojson = null;
      }
    }

    // 2) キャッシュに無ければ API から取得して保存する。
    if (geojson === null) {
      try {
        geojson = await fetchLandPriceTile(tile, { apiKey, fetchImpl });
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify(geojson));
        fetched++;
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      } catch (e) {
        // 1タイルの失敗で全体を止めない。キャッシュに残らないので次回再試行される。
        failed++;
        log(`  ⚠ タイル取得失敗 z=${zoom} x=${t.x} y=${t.y}: ${e.message}`);
        continue;
      }
    }

    points.push(...pointsFromGeoJson(geojson));
  }

  log(`  商業地ポイント ${points.length.toLocaleString('en-US')}件（新規取得 ${fetched} / キャッシュ ${cached} / 失敗 ${failed} タイル）`);
  return { points, fetched, cached, failed };
}

// --- オーケストレーション --------------------------------------------------------

/**
 * 施設群に地価ランクを付与する一連の流れ（タイル列挙 → 取得 → 最寄り結合 → ランク）。
 * APIキーが無ければ何もせず `{ skipped: true }` を返す。黙って進まず、理由を必ず出す。
 * @param {Array<object>} facilities lat / lng を持つ施設
 * @param {object} [options] fetchCommercialPoints / enrichFacilities のオプション
 * @returns {Promise<{skipped:boolean, reason?:string, stats?:object, points?:number}>}
 */
export async function runEnrichment(facilities, options = {}) {
  const { log = console.log } = options;
  const apiKey = options.apiKey ?? resolveApiKey();
  if (!apiKey) {
    log(
      `地価ランクの付与をスキップしました: 環境変数 ${API_KEY_ENV} が未設定です。\n` +
        `  不動産情報ライブラリの API 利用申請（審査5営業日目安）を済ませ、発行された\n` +
        `  サブスクリプションキーを ${API_KEY_ENV} に設定してから再実行してください。\n` +
        `  手順: docs/LAND-PRICE-RANK.md`,
    );
    return { skipped: true, reason: `${API_KEY_ENV} が未設定` };
  }

  const zoom = options.zoom ?? TILE_ZOOM;
  const year = options.year ?? defaultPriceYear();
  const neighborRadius = options.neighborRadius ?? TILE_NEIGHBOR_RADIUS;

  const tiles = collectTileCoords(facilities, { zoom, neighborRadius });
  log(`  対象タイル ${tiles.length.toLocaleString('en-US')}枚（z=${zoom} / 対象年 ${year}）`);

  const { points } = await fetchCommercialPoints(tiles, { ...options, apiKey, year, zoom, log });
  const stats = enrichFacilities(facilities, points, { ...options, zoom, neighborRadius, log });
  return { skipped: false, stats, points: points.length };
}

// --- CLI ------------------------------------------------------------------------

/**
 * コマンドライン引数を解釈する（純粋関数）。
 * @param {Array<string>} argv process.argv.slice(2) 相当
 * @returns {{in:string|null, out:string|null, year:number|null, rankScope:string, force:boolean}}
 */
export function parseArgs(argv) {
  const get = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const year = get('year');
  const scope = get('rank-scope');
  return {
    in: get('in'),
    out: get('out'),
    year: year ? Number(year) : null,
    // 既定は全国共通。都道府県内の相対に切り替えるなら --rank-scope=prefecture。
    // どちらを採るかは未決（docs/LAND-PRICE-RANK.md の「未決の論点」を参照）。
    rankScope: scope === 'prefecture' ? 'prefecture' : 'national',
    force: argv.includes('--force'),
  };
}

/**
 * CSV を読み込み、ヘッダーと行（オブジェクト配列）に分けて返す。
 * @param {string} filePath 入力CSV（BOM の有無は csv-read.js が吸収する）
 * @returns {{header:Array<string>, rows:Array<object>}}
 */
export function readFacilitiesCsv(filePath) {
  let header = null;
  const rows = [];
  for (const cells of readCsvRows(filePath)) {
    if (!header) {
      header = cells;
      continue;
    }
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i] ?? '';
    rows.push(row);
  }
  if (!header) throw new Error(`CSV が空です: ${filePath}`);
  return { header, rows };
}

/**
 * 元の列＋付与した3列で CSV を書き出す（BOM なし UTF-8、結合CSV と同じ流儀）。
 * 値が null の列は空セルになる（ランクを付けなかった行は空欄で出す）。
 * @param {string} filePath 出力先
 * @param {Array<string>} header 入力CSV のヘッダー
 * @param {Array<object>} rows 付与済みの行
 */
export async function writeFacilitiesCsv(filePath, header, rows) {
  const cols = [...header, ...LAND_PRICE_COLUMNS];
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  const out = fs.createWriteStream(filePath, { encoding: 'utf-8' });
  out.write(cols.join(',') + '\n');
  for (const r of rows) out.write(cols.map((c) => csvCell(r[c])).join(',') + '\n');
  // end() を呼ぶだけではフラッシュ完了前にプロセスが進むため、finish を待つ。
  await new Promise((resolve, reject) => {
    out.once('error', reject);
    out.end(resolve);
  });
}

/** CLI 本体: 入力CSV を読み、地価ランクを付与して出力CSV に書き出す。 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in || !args.out) {
    console.error(
      '使い方: node scripts/enrich/land-price-rank.js --in=<入力CSV> --out=<出力CSV>' +
        ' [--year=2026] [--rank-scope=national|prefecture] [--force]',
    );
    process.exit(1);
  }

  console.log(`入力: ${args.in}`);
  const { header, rows } = readFacilitiesCsv(args.in);
  console.log(`  ${rows.length.toLocaleString('en-US')}行`);

  const result = await runEnrichment(rows, {
    year: args.year ?? undefined,
    rankScope: args.rankScope,
    force: args.force,
  });
  if (result.skipped) {
    // キーが無いだけなので異常終了にはしない。出力も作らない（中途半端な列を残さない）。
    process.exit(0);
  }

  await writeFacilitiesCsv(args.out, header, rows);
  console.log(`出力: ${args.out}`);
}

// import されたときは実行しない（テストから純粋関数だけ使うため）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

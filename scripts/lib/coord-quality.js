// 座標の品質フィルタ: 施設の位置として信用できない緯度経度を落とす。
//
// レコード自体は消さない。信用できない座標だけを null にして、名前・住所・業種・
// 許可番号といった施設情報は配信し続ける（座標なしのレコードは元々 CSV に含めて
// いるため、扱いはそれと同じになる）。地図用のベクトルタイルは座標を持つ行だけを
// 載せるので、座標を null にした時点で地図からは自動的に消える。
//
// 落とす対象は3種類:
//   1. プレースホルダ住所（「市内一円」等）に付いている座標
//   2. 同一座標へ大量のレコードが積まれている「代表点フォールバック」
//   3. ジオコーディングが都道府県／市区町村の代表点までしか解けなかった座標
//
// 適用順に意味がある。1 → 3 → 2 の順で実行すること。プレースホルダと代表点を
// 先に落とさないと、それらが作る巨大な同一座標の山を 2 が拾ってしまい、
// 「なぜこの座標が怪しいのか」の判定が二重になる。

// 「元データ由来の座標」を表す geocoding_level。ジオコーディングを経ていないため
// レベルの概念が無く、null のまま配信している。
const LEVEL_SOURCE = null;

// 施設位置として意味を持たない代表点のレベル。
//   1 = 都道府県の代表点 / 2 = 市区町村の代表点
// どちらも prefecture / city 列で表現できる情報しか持たないうえ、地図上では
// 県庁・市役所の一点に施設が積み上がって実在しない密集を作る。
const REPRESENTATIVE_LEVELS = new Set([1, 2]);

/**
 * 座標を持たない状態に戻す（行そのものは残す）。
 * lat / lng / geocoding_level をまとめて空にする。
 */
export function dropCoord(facility) {
  facility.lat = null;
  facility.lng = null;
  facility.geocoding_level = null;
}

/** 座標を持っているか。 */
export function hasCoord(facility) {
  return facility.lat != null && facility.lng != null;
}

/**
 * ジオコーディングレベルが代表点（1=都道府県 / 2=市区町村）かを判定する（純粋関数）。
 * null（元データ由来の座標）と 3 以上は false。
 */
export function isRepresentativeLevel(level) {
  if (level === LEVEL_SOURCE || level === undefined || level === '') return false;
  return REPRESENTATIVE_LEVELS.has(Number(level));
}

/**
 * 同一座標をまとめるためのキー（純粋関数）。
 * 元データの座標は桁数がまちまちなので、小数6桁（約11cm）に丸めて突き合わせる。
 */
export function coordKey(lat, lng) {
  return `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
}

/**
 * 住所から「町名までの部分」を取り出す（純粋関数）。
 * 最初の算用数字より前を町名とみなす。「赤坂一丁目1番12号」→「赤坂一丁目」。
 * 数字を含まない住所はそのまま返す。
 *
 * 同一座標に積まれたレコードが何種類の町にまたがるかを数えるために使う。
 * 実在の建物（ビル・市場・商業施設）に入る複数テナントは町名が1種類に揃うが、
 * 代表点フォールバックは市内の広い範囲＝多数の町名を1点に集めるため、
 * この異なり数で両者を切り分けられる。
 *
 * 都道府県名・市区町村名の前置は元データごとに有ったり無かったりするため、
 * 数える前に剥がす。剥がさないと「愛媛県松山市二番町」と「松山市二番町」が
 * 別の町として数えられ、同じ町しか含まない座標の町名数が水増しされる。
 */
export function townKey(address, pref = '', city = '') {
  let s = String(address || '').normalize('NFKC').replace(/[\s　]+/g, '');
  for (const prefix of [pref, city]) {
    const p = String(prefix || '').normalize('NFKC').replace(/[\s　]+/g, '');
    if (p && s.startsWith(p)) s = s.slice(p.length);
  }
  // 政令市の行政区など、city を剥がしたあとに残る「○○区」も町名の一部として扱う
  const m = s.match(/^[^0-9]*/);
  return m ? m[0] : s;
}

/**
 * 代表点フォールバックとみなせる座標を洗い出す（純粋関数）。
 *
 * 判定は「同じ座標に積まれたレコード数」と「その座標がまたがる町名の異なり数」の
 * 2条件。件数だけで判定すると、テナントの多い商業施設や卸売市場のように
 * 正しく1点に集まるべき座標まで巻き込むため、町名の異なり数を必須にしている。
 *
 * @param {Array<{lat:number,lng:number,address:string}>} facilities 座標を持つ施設
 * @param {{minCount?:number, minTowns?:number}} options
 *   minCount 同一座標のレコード数の下限 / minTowns またがる町名の異なり数の下限
 * @returns {Set<string>} coordKey の集合
 */
export function findFallbackCoords(facilities, { minCount = 50, minTowns = 5 } = {}) {
  const groups = new Map(); // coordKey -> { count, towns:Set }
  for (const f of facilities) {
    if (!hasCoord(f)) continue;
    const key = coordKey(f.lat, f.lng);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { count: 0, towns: new Set() }));
    g.count++;
    // 町名の異なり数は上限を設けて打ち切る（判定に必要なのは minTowns に届くかだけで、
    // 全国最大級の山では数万件ぶんの文字列を保持することになるため）
    if (g.towns.size < minTowns) g.towns.add(townKey(f.address, f.pref ?? f._pref, f.city ?? f._city));
  }

  const flagged = new Set();
  for (const [key, g] of groups) {
    if (g.count >= minCount && g.towns.size >= minTowns) flagged.add(key);
  }
  return flagged;
}

/**
 * 座標の品質フィルタを施設配列に適用する（破壊的に更新）。
 *
 * @param {Array} facilities 施設（lat / lng / geocoding_level / address を持つ）
 * @param {{isPlaceholderAddress:Function, minCount?:number, minTowns?:number, log?:Function}} options
 *   isPlaceholderAddress は lib/normalize.js のものを渡す（循環 import を避けるため注入する）
 * @returns {{placeholder:number, representative:number, fallback:number, fallbackCoords:number}}
 */
export function applyCoordQuality(
  facilities,
  { isPlaceholderAddress, minCount = 50, minTowns = 3, log = console.log } = {},
) {
  let placeholder = 0;
  let representative = 0;

  // 1) プレースホルダ住所に付いている座標を落とす。
  //    ジオコーディングは元々これらを対象外にしているが、元データが座標を持ち込んだ
  //    レコードは素通りしていた。「都内一円」のキッチンカーが1点に積み上がるのはこれ。
  // 3) 都道府県／市区町村の代表点を落とす。
  for (const f of facilities) {
    if (!hasCoord(f)) continue;
    if (isPlaceholderAddress(f.address)) {
      dropCoord(f);
      placeholder++;
      continue;
    }
    if (isRepresentativeLevel(f.geocoding_level)) {
      dropCoord(f);
      representative++;
    }
  }

  // 2) 残った座標から、元データ側が代表点で埋めた山を検出して落とす。
  //    1 と 3 の後に実行することで、判定対象は「元データ由来の座標」と
  //    「町丁目以上のジオコーディング結果」だけになる。
  const flagged = findFallbackCoords(facilities, { minCount, minTowns });
  let fallback = 0;
  for (const f of facilities) {
    if (!hasCoord(f)) continue;
    if (flagged.has(coordKey(f.lat, f.lng))) {
      dropCoord(f);
      fallback++;
    }
  }

  log(
    `  プレースホルダ住所の座標: ${placeholder.toLocaleString('en-US')}件` +
      ` / 都道府県・市区町村の代表点: ${representative.toLocaleString('en-US')}件` +
      ` / 代表点フォールバック: ${fallback.toLocaleString('en-US')}件（${flagged.size}座標）を除去`,
  );

  return { placeholder, representative, fallback, fallbackCoords: flagged.size };
}

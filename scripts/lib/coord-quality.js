// 座標の品質フィルタ: 施設の位置として信用できない緯度経度を落とす。
//
// レコード自体は消さない。信用できない座標だけを null にして、名前・住所・業種・
// 許可番号といった施設情報は配信し続ける（座標なしのレコードは元々 CSV に含めて
// いるため、扱いはそれと同じになる）。地図用のベクトルタイルは座標を持つ行だけを
// 載せるので、座標を null にした時点で地図からは自動的に消える。
//
// 落とす対象は2種類:
//   1. プレースホルダ住所（「市内一円」等）に付いている座標
//   2. ジオコーディングが都道府県／市区町村の代表点までしか解けなかった座標
//
// 適用順に意味がある。1 を先に実行すること。プレースホルダ住所のレコードは
// 元データが座標を持ち込んでいる場合があり、住所として無効であることが分かって
// いる以上、レベルによる判定より先に落とすほうが理由が明確になる。
//
// ---------------------------------------------------------------------------
// 「代表点フォールバック」の検出を入れていない理由（再挑戦するとき用の記録）
// ---------------------------------------------------------------------------
// 公開元が「住所は分かるが座標は分からない」レコードを市役所などの座標で一括して
// 埋めていることがある。配信中データでは同一座標に100件以上が積まれた行が 76,088件
// あり、これは level が空欄（元データ由来）のまま素通りしていた。
//
// これを「同一座標のレコード数」と「その座標がまたがる町名の異なり数」で検出する
// 実装を試したが、配信中データ 1,365,867件で監査したところ使えないと判断した。
// 検出した149座標のうち 59座標・5,512件（34%）が誤検出で、内訳は次のようなもの:
//   - 京都駅ビル(208件) / 京都タワー(50件) … 同じ町を通り名で書き分けているだけ
//     （「烏丸通七条下る東塩小路町」「下ル」「下がる」「東塩小路町」）
//   - 神戸市西区伊川谷町有瀬(133件) … 単一の町丁目。小字のゆれで町名が6種に見える
// さらに「本物」に分類した90座標にも京都市中央卸売市場(196件)などが混ざっており、
// 34%は下限。町名の異なり数という指標そのものが日本の住所表記のゆれに耐えない。
// 加えて除去対象の77%は level 3 で、level 3 は「町丁目の代表点」として仕様どおりの
// 挙動であり、そもそも落とす必要が薄い。
//
// 文字列を数えるのをやめ、距離で測るのが正しい方向。候補となる座標（同一座標に
// 50件以上が乗っている832座標）ごとに、乗っている住所を数十件サンプリングして
// 独立にジオコーディングし、結果が数km単位に散ったらフォールバックと判定する。
// 1棟のビルなら結果は1点に集まり、市内一括埋めなら市域に散る。住所の書き方に
// 依存せず、必要な問い合わせも2万回程度で済む。

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
 * 座標の品質フィルタを施設配列に適用する（破壊的に更新）。
 *
 * @param {Array} facilities 施設（lat / lng / geocoding_level / address を持つ）
 * @param {{isPlaceholderAddress:Function, log?:Function}} options
 *   isPlaceholderAddress は lib/normalize.js のものを渡す（循環 import を避けるため注入する）
 * @returns {{placeholder:number, representative:number}}
 */
export function applyCoordQuality(
  facilities,
  { isPlaceholderAddress, log = console.log } = {},
) {
  let placeholder = 0;
  let representative = 0;

  for (const f of facilities) {
    if (!hasCoord(f)) continue;
    // 1) プレースホルダ住所に付いている座標を落とす。
    //    ジオコーディングは元々これらを対象外にしているが、元データが座標を持ち込んだ
    //    レコードは素通りしていた。「都内一円」のキッチンカーが1点に積み上がるのはこれ。
    if (isPlaceholderAddress(f.address)) {
      dropCoord(f);
      placeholder++;
      continue;
    }
    // 2) 都道府県／市区町村の代表点を落とす。
    if (isRepresentativeLevel(f.geocoding_level)) {
      dropCoord(f);
      representative++;
    }
  }

  log(
    `  プレースホルダ住所の座標: ${placeholder.toLocaleString('en-US')}件` +
      ` / 都道府県・市区町村の代表点: ${representative.toLocaleString('en-US')}件 を除去`,
  );

  return { placeholder, representative };
}

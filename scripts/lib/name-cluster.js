// 施設名の名寄せによる座標の統一。
//
// 同じ施設が複数のソース（自治体の独自公開と i2fas 等）に載っていたり、業種違いの
// 許可レコードとして複数行に分かれていたりすると、同じ店に少しずつ違う座標が付く。
// 片方は自治体が実測した座標、もう片方は住所からのジオコーディング結果、という
// 組み合わせが典型で、両者は数十メートルずれる。
//
// そこで「正規化した施設名が一致し、かつ一定距離以内にある座標」を1点に寄せ、
// グループの中でいちばん精度の高い座標を全員に配る。精度の低い側が引き上げられる
// ぶん、データ全体の位置精度が上がる。
//
// 距離のしきい値は 50m。配信中データで「正規化名＋電話番号が一致する＝ほぼ同一施設」
// のペアを集め、群の中央点からの距離分布を測った結果に基づく:
//     0m 77.4% / 20m以内 86.6% / 50m以内 89.1% / 100m以内 91.0% / 200m以内 93.0%
// 1mあたりの密度は 21〜50m で 0.084%/m、51〜100m で 0.039%/m、101〜200m で 0.020%/m と
// 50m を境に半減し、それ以降は平坦な背景ノイズになる。実際にこの距離で統合される
// 行数も 20m格子で 233,772行、50mで 242,618行、100mで 249,587行とほとんど増えない。
// 一方で 100m を超えると「本部の電話番号を共有しているだけの別の支店」が混ざり始める
// （電話番号が一致するペアのうち 1.95% は 2km 以上離れている）。広げても得るものが
// 無く、誤統合のリスクだけが増えるため 50m で打ち止めにする。
//
// 座標を書き換えるだけで、レコードの統合や削除は行わない。業種違いの許可レコードは
// 「別の許可」として価値があるため残す（結合CSV 側の全列一致の重複除去に任せる）。

// 法人格の表記。名寄せキーからは落とす（「株式会社山田」と「山田」を同じ店として扱う）。
const CORPORATE_FORMS =
  /(株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|社会福祉法人|医療法人|学校法人|宗教法人|特定非営利活動法人|農業協同組合|生活協同組合|\(株\)|\(有\)|\(合\)|NPO法人)/g;

// 名寄せキーから落とす記号・空白。表記のゆれ（中黒の有無、ハイフンの種類）を吸収する。
const NOISE =
  /[\s　・,，.。\-‐‑‒–—―ー−ｰ~〜!?'"“”''()（）[\]【】「」『』/／\\|&＆+＋*＊:：;；#＃@＠]/g;

/** 地球の平均半径（メートル）。 */
const EARTH_RADIUS_M = 6371000;
/** 緯度1度あたりの距離（メートル）。格子のセルサイズを決めるのに使う。 */
const METERS_PER_DEG_LAT = 111320;

/**
 * 施設名を名寄せ用のキーに正規化する（純粋関数）。
 * NFKC で全角半角を揃え、大文字化し、法人格と記号・空白を落とす。
 * 例: 「㈱ ラーメン 太郎・本店」→「ラーメン太郎本店」
 */
export function normalizeFacilityName(name) {
  return String(name || '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[㈱㈲㈹]/g, '')
    .replace(CORPORATE_FORMS, '')
    .replace(NOISE, '');
}

/**
 * 2点間の距離（メートル）を求める（純粋関数・Haversine）。
 */
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * 座標の精度の順位（小さいほど信用できる）を返す（純粋関数）。
 *   0 = 元データ由来の座標（geocoding_level が空）
 *   1 = level 8（街区・地番）
 *   2 = level 3（町丁目）
 *   3 = それ以外
 * 代表点（level 1 / 2）は座標品質フィルタで既に落ちているため、ここには来ない。
 */
export function precisionRank(level) {
  if (level === null || level === undefined || level === '') return 0;
  const n = Number(level);
  if (n === 8) return 1;
  if (n === 3) return 2;
  return 3;
}

/** 数値配列の中央値（純粋関数）。空配列なら null。 */
export function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * グループの代表座標を選ぶ（純粋関数）。
 *
 * いちばん精度の高い階級（元データ座標 → level 8 → level 3）だけを残し、その中の
 * 中央値を取る。平均ではなく中央値なのは、1点だけ大きくずれた座標に引っ張られない
 * ようにするため。
 *
 * @param {Array<{lat:number,lng:number,geocoding_level:*}>} members
 * @returns {{lat:number, lng:number}|null}
 */
export function pickRepresentative(members) {
  if (members.length === 0) return null;
  let best = Infinity;
  for (const m of members) best = Math.min(best, precisionRank(m.geocoding_level));
  const top = members.filter((m) => precisionRank(m.geocoding_level) === best);
  return { lat: median(top.map((m) => m.lat)), lng: median(top.map((m) => m.lng)) };
}

/**
 * 同一グループ内の座標を、半径 radiusM 以内のまとまりに分ける（純粋関数）。
 *
 * 各まとまりの先頭（リーダー）から radiusM 以内かどうかだけで判定する。隣どうしを
 * 繋いでいく方式（単連結）だと「AとBが40m、BとCが40m」で AとC が80m離れていても
 * 1つになってしまうため、必ずリーダーからの距離で切る。
 *
 * 候補の絞り込みには radiusM 相当の格子を使い、周囲9セルのリーダーだけを見る。
 * チェーン店のように同名が数百件ある場合でも総当たりにならない。
 */
export function clusterByDistance(members, radiusM) {
  const cellLat = radiusM / METERS_PER_DEG_LAT;
  const clusters = [];
  const grid = new Map(); // セルキー -> そのセルにリーダーがいるクラスタの添字

  for (const m of members) {
    const cosLat = Math.max(0.01, Math.cos((m.lat * Math.PI) / 180));
    const cellLng = radiusM / (METERS_PER_DEG_LAT * cosLat);
    const r = Math.floor(m.lat / cellLat);
    const c = Math.floor(m.lng / cellLng);

    let joined = null;
    for (let dr = -1; dr <= 1 && joined === null; dr++) {
      for (let dc = -1; dc <= 1 && joined === null; dc++) {
        const idxs = grid.get(`${r + dr},${c + dc}`);
        if (!idxs) continue;
        for (const i of idxs) {
          const lead = clusters[i][0];
          if (distanceMeters(lead.lat, lead.lng, m.lat, m.lng) <= radiusM) {
            joined = i;
            break;
          }
        }
      }
    }

    if (joined !== null) {
      clusters[joined].push(m);
    } else {
      const idx = clusters.length;
      clusters.push([m]);
      const key = `${r},${c}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(idx);
    }
  }
  return clusters;
}

/**
 * 正規化した施設名が一致し radiusM 以内にある座標を、1点に統一する（破壊的に更新）。
 *
 * geocoding_level は書き換えない。座標を精度の高いものに差し替えても、その行自身の
 * 住所から解けた精度は変わらないため、level は「精度の下限」として正しいまま残る。
 *
 * @param {Array} facilities 施設（name / pref / lat / lng / geocoding_level を持つ）
 * @param {{radiusM?:number, log?:Function}} options
 * @returns {{moved:number, clusters:number, groups:number}}
 */
export function unifyCoordsByName(facilities, { radiusM = 50, log = console.log } = {}) {
  // 都道府県 + 正規化名でグループ化する。50m 以内しか統合しないので県をまたぐことは
  // 無く、キーに都道府県を含めておくとグループが細かく割れて後段が軽くなる。
  const groups = new Map();
  for (const f of facilities) {
    if (f.lat == null || f.lng == null) continue;
    const key = normalizeFacilityName(f.name);
    if (!key) continue; // 名前が無い（記号だけ等）レコードは名寄せできない
    const full = `${f.pref ?? f._pref ?? ''} ${key}`;
    let list = groups.get(full);
    if (!list) groups.set(full, (list = []));
    list.push(f);
  }

  let moved = 0;
  let clusterCount = 0;
  let multiGroups = 0;

  for (const members of groups.values()) {
    if (members.length < 2) continue;
    multiGroups++;
    for (const cluster of clusterByDistance(members, radiusM)) {
      if (cluster.length < 2) continue;
      clusterCount++;
      const rep = pickRepresentative(cluster);
      if (!rep || rep.lat == null || rep.lng == null) continue;
      for (const m of cluster) {
        if (m.lat === rep.lat && m.lng === rep.lng) continue;
        m.lat = rep.lat;
        m.lng = rep.lng;
        moved++;
      }
    }
  }

  log(
    `  施設名の名寄せ: ${clusterCount.toLocaleString('en-US')}グループの座標を統一` +
      `（${moved.toLocaleString('en-US')}件の座標を代表点へ寄せた / 半径 ${radiusM}m）`,
  );

  return { moved, clusters: clusterCount, groups: multiGroups };
}

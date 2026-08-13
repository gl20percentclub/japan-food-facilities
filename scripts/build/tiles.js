// ベクトルタイル生成（z/x/y .pbf ディレクトリ）
//
// 座標を持つ施設を点(Point)として Mapbox Vector Tile（MVT）に焼き、
// GitHub Pages から直接配信できる z/x/y 形式で出力する。
//   api/tiles/{z}/{x}/{y}.pbf   MapLibre の tiles:["{z}/{x}/{y}.pbf"] でそのまま読める
//   api/tiles/metadata.json     TileJSON（レイヤ・ズーム範囲・bounds・データ統計）
//
// tippecanoe 等のシステムバイナリは不要（pure JS: geojson-vt + vt-pbf）。
//
// タイルは gzip 圧縮して書き出す（MVT は繰り返しの多いバイナリで、実測で約 1/4 になる）。
// 配信元の S3 は保存したバイト列をそのまま返すだけなので、圧縮は「置くときに済ませる」
// 必要がある（CloudFront の自動圧縮は 10MB 超のオブジェクトが対象外で、低ズームの
// 大きいタイルにはそもそも効かない）。S3 へ上げるときに
// `Content-Encoding: gzip` を付けるのはクローラー側の docker/entrypoint.sh の役目。
//
// 入力はクロール結果の施設配列（メモリ上）。crawl.js から呼ばれる。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gvtNs from 'geojson-vt';
import * as vtpbfNs from 'vt-pbf';
import { gzipSync } from 'fflate';

const geojsonvt = gvtNs.default || gvtNs;
const vtpbf = vtpbfNs.default || vtpbfNs;
const fromGeojsonVt = vtpbf.fromGeojsonVt || vtpbfNs.fromGeojsonVt;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const TILES_DIR = path.join(ROOT, 'api', 'tiles');
const LAYER = 'facilities';

// 最小ズーム。プレビュー地図（site/map.html）が地図自体の下限を z3 にしているため、
// z3 まで焼いておけば「引くと点が消える」ズームが無くなる。
// 間引き後は低ズームのコストがほぼ無い（z3〜z5 の 3 ズームを足しても合計 +5.7MB。
// タイル数が 3/3/6 枚しかないため）ので、下限を上げて節約する意味がない。
// 逆に z6 開始だと初期表示で日本全体が入らず、狭い範囲を密なタイルで埋めることになる。
const MIN_ZOOM = Number(process.env.TILES_MIN_ZOOM ?? 3);
const MAX_ZOOM = Number(process.env.TILES_MAX_ZOOM ?? 12);
// gzip の圧縮レベル。9 にしても縮むのは 1% 未満で、タイル数が数万枚あるぶん
// 生成時間だけが伸びるため既定の 6 を使う。
const GZIP_LEVEL = 6;
// 日本のおおよその範囲 [west, south, east, north]
const BOUNDS = [122, 20, 154, 46];

// --- 低ズームの間引き設定 ---------------------------------------------------
// geojson-vt の tolerance は線・面の簡略化にしか効かず、点は全ズームでそのまま
// 焼かれる。そのため対策前は z6 の 1 タイルに全 136 万点が入り 38 MB あった
// （全ズーム合計 469 MB）。実際には低ズームで数万点が同じ画素に重なるだけなので、
// タイル内をグリッドに切って 1 セル 1 点に間引く。
//
// セル数はタイルの 1 辺あたり。タイルは概ね 512 CSS px で描かれるので、
// 64 なら 1 セル ≒ 8 px。半径 1.6〜2.8 px の円を描く用途では、
// これ以上細かくしても画面上は区別できない。
const CELLS_PER_TILE = Number(process.env.TILES_CELLS_PER_TILE ?? 64);
// 間引きを適用しない最小ズーム。既定は generateTiles の maxZoom（下記参照）。
// 環境変数で明示された場合だけこの定数が使われる。
const DETAIL_ZOOM_ENV = process.env.TILES_DETAIL_ZOOM;

/**
 * 間引きグリッドの解像度を検証して返す。
 *
 * `Number(process.env.X ?? 64)` は変数が「宣言だけされて空文字」のとき
 * `Number('') === 0` になり、lonLatToCell の分母 `2^z * 0` が 0 になって
 * 全点が [0,0] に潰れる（＝ほぼ空の地図が例外なく出来上がる）。
 * 配信物バリデーションは「z6 タイルが非空」しか見ず検知できないため、
 * ここで落とす。
 */
function assertCellsPerTile(cellsPerTile) {
  if (!Number.isFinite(cellsPerTile) || cellsPerTile < 1) {
    throw new Error(`間引きグリッドの解像度が不正: ${cellsPerTile}（1 以上の有限数が必要）`);
  }
  return cellsPerTile;
}

// 経緯度 → スリッピータイル座標 (x, y)
export function lonLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  let x = Math.floor(((lng + 180) / 360) * n);
  let y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  x = Math.max(0, Math.min(n - 1, x));
  y = Math.max(0, Math.min(n - 1, y));
  return [x, y];
}

/**
 * 経緯度を、ズーム z の「タイルをさらに cellsPerTile 分割したグリッド」の
 * セル番号 [cx, cy] に落とす（純粋関数）。
 *
 * lonLatToTile と同じ Web メルカトル式を、分母を 2^z * cellsPerTile にして
 * 使う。こうするとセル境界がタイル境界と必ず一致し、隣接タイルで同じ点が
 * 別セルに割れる（＝間引き後に継ぎ目が出る）ことがない。
 */
export function lonLatToCell(lng, lat, z, cellsPerTile) {
  const n = 2 ** z * cellsPerTile;
  const latRad = (lat * Math.PI) / 180;
  let cx = Math.floor(((lng + 180) / 360) * n);
  let cy = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  cx = Math.max(0, Math.min(n - 1, cx));
  cy = Math.max(0, Math.min(n - 1, cy));
  return [cx, cy];
}

/**
 * ズーム z 向けに feature を間引く（純粋関数）。
 *
 * グリッドの 1 セル × 1 業種 × 1 市区町村につき 1 点だけ残し、まとめた件数を
 * `count` に入れる。
 *
 * 業種をキーに含めるのは、地図の業種フィルターを低ズームでも正しく効かせるため。
 * セル単位で 1 点に潰すと、飲食店だらけのセルに 1 軒だけある喫茶店が消え、
 * 「喫茶店で絞り込むと空白地帯ができる」という嘘の表示になる。
 *
 * 都道府県・市区町村もキーに含める。z6 のセル幅は 360/(64*64) ≒ 0.088°（約 8 km）で、
 * 市区町村どころか県境もまたぐ。キーに含めないと「代表点 1 軒の自治体名」に
 * 「セル全体の件数」が貼り付き、複数自治体の合計を単一自治体の件数として
 * 表示してしまう。含めておけば count と pref/city が必ず同じ集合を指す。
 *
 * 残す代表点は各キーで最初に現れた施設。ただし `name` は載せない。施設名は
 * ほぼ全件が異なる文字列で MVT のレイヤ内文字列テーブルを最も太らせる一方、
 * 間引き後の 1 点は「同じ画素に重なった複数施設の代表」でしかなく、その 1 軒の
 * 名前を出すと誤解を招くため。業種・都道府県・市区町村は異なり数が少なく
 * 文字列テーブルで共有されるので残す。
 *
 * 入力の features は変更しない。戻り値は新しい配列。
 */
export function thinFeatures(features, z, cellsPerTile = CELLS_PER_TILE) {
  assertCellsPerTile(cellsPerTile);
  const byCell = new Map();
  for (const f of features) {
    const [lng, lat] = f.geometry.coordinates;
    const [cx, cy] = lonLatToCell(lng, lat, z, cellsPerTile);
    // 業種は生の文字列のまま鍵に使う（表記ゆれを正規化するとフィルターの
    // 部分一致条件とずれるため、ここでは束ねない）。
    // pref/city も鍵に含め、count が数える集合と表示する自治体名を一致させる。
    const p = f.properties;
    const key = `${cx}\u001f${cy}\u001f${p.business_type}\u001f${p.pref}\u001f${p.city}`;
    const hit = byCell.get(key);
    if (hit) {
      hit.properties.count++;
      continue;
    }
    byCell.set(key, {
      type: 'Feature',
      geometry: f.geometry,
      // name は載せない（施設名は全件ほぼ一意で MVT の文字列テーブルを最も太らせる。
      // 間引き後の 1 点は重なった複数施設の代表でしかなく、1 軒の名前を出すと誤解を招く）
      properties: {
        business_type: f.properties.business_type,
        pref: f.properties.pref,
        city: f.properties.city,
        count: 1,
      },
    });
  }
  return [...byCell.values()];
}

/** 施設配列から、座標を持つ施設だけの GeoJSON FeatureCollection を組み立てる。 */
export function buildFeatureCollection(facilities) {
  const features = [];
  for (const f of facilities) {
    if (typeof f.lat !== 'number' || typeof f.lng !== 'number') continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
      properties: {
        name: f.name || '',
        business_type: f.business_type || '',
        pref: f.pref || '',
        city: f.city || '',
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * 施設配列から z/x/y ベクトルタイルと TileJSON を生成する。
 *
 * `stats`（結合CSV 側で集計した件数）は metadata.json に埋め込み、
 * プレビュー地図(site/map.html)が JSON データを別途配信せずに件数を表示できるようにする。
 *
 * 生成結果 `{ tiles, points, bytes, rawBytes }` を返す（書き出しが非同期のため async）。
 * `bytes` は実際に配信されるサイズ（gzip 後）、`rawBytes` は圧縮前の合計。
 */
export async function generateTiles(facilities, {
  minZoom = MIN_ZOOM,
  maxZoom = MAX_ZOOM,
  outDir = TILES_DIR,
  updated = Math.floor(Date.now() / 1000),
  stats = null,
  log = console.log,
  // 間引きのグリッド解像度（タイル1辺あたりのセル数）と、間引きを止める最小ズーム。
  // detailZoom の既定はモジュール定数ではなく maxZoom にする。最大ズームは
  // overzoom（z13 以上）の元になるため個々の施設を残す必要があり、この不変条件は
  // 呼び出し側が maxZoom だけを指定した場合にも保たれなければならない。
  cellsPerTile = CELLS_PER_TILE,
  detailZoom = DETAIL_ZOOM_ENV === undefined ? maxZoom : Number(DETAIL_ZOOM_ENV),
} = {}) {
  assertCellsPerTile(cellsPerTile);
  // 環境変数で maxZoom より大きい値が来ても最大ズームは間引かない（overzoom の元を守る）
  const detailFrom = Math.min(detailZoom, maxZoom);

  // metadata.json には CSV 側で数えた records と、ここで数える points が並ぶ。
  // 別々の集合から数えると両者が食い違い、配信物バリデーションで落ちる。
  // 重複除去後の施設（stats.unique）を渡し忘れた場合はここで止める。
  if (stats?.unique && stats.unique !== facilities) {
    throw new Error('ベクトルタイルは結合CSV と同じ施設集合（stats.unique）から生成すること');
  }

  const fc = buildFeatureCollection(facilities);
  if (fc.features.length === 0) {
    console.warn('  座標を持つ施設が無いため ベクトルタイルの生成をスキップ');
    // 戻り値の形は生成した場合と揃える（呼び出し側で rawBytes が undefined にならないように）
    return { tiles: 0, points: 0, bytes: 0, rawBytes: 0 };
  }

  // 古いタイルを消してから作り直す（点が減った場合の取り残しを防ぐ）。
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // タイルの生成（getTile + エンコード）は CPU 主体でメインスレッドのまま、
  // ファイル書き出しだけを非同期の同時実行プールに逃がして I/O 待ちを重ねる。
  // ディレクトリ作成は同期のまま重複を Set で省く（mkdir の連打を避ける）。
  const WRITE_CONCURRENCY = 64;
  let written = 0;
  let bytes = 0;
  let rawBytes = 0;
  const madeDirs = new Set();
  const pending = new Set();
  // ズームごとに「そのズーム用に間引いた点」でインデックスを作り直す。
  // 全ズームを 1 つのインデックスで賄うと、低ズームのタイルにも全点が
  // そのまま入ってしまう（geojson-vt の簡略化は点に効かない）。
  // インデックスはズームごとに使い捨てて、同時に抱えるメモリを抑える。
  for (let z = minZoom; z <= maxZoom; z++) {
    const zoomFeatures = z >= detailFrom ? fc.features : thinFeatures(fc.features, z, cellsPerTile);
    const index = geojsonvt(
      { type: 'FeatureCollection', features: zoomFeatures },
      { maxZoom: z, indexMaxZoom: z, extent: 4096, buffer: 64, tolerance: 3 },
    );

    // このズームで点が乗るタイル座標だけを集め、非空タイルを書き出す。
    const coords = new Set();
    for (const f of zoomFeatures) {
      const [lng, lat] = f.geometry.coordinates;
      const [x, y] = lonLatToTile(lng, lat, z);
      coords.add(`${x}/${y}`);
    }

    let zoomTiles = 0;
    let zoomBytes = 0;
    let zoomRawBytes = 0;
    for (const key of coords) {
      const [x, y] = key.split('/').map(Number);
      const tile = index.getTile(z, x, y);
      if (!tile || !tile.features.length) continue;
      const raw = Buffer.from(fromGeojsonVt({ [LAYER]: tile }, { version: 2 }));
      // mtime: 0 で gzip ヘッダにタイムスタンプを入れない。同じ入力なら毎回同じ
      // バイト列になり、aws s3 sync の差分判定（サイズ比較）が中身の変化だけを拾う。
      const buf = Buffer.from(gzipSync(raw, { level: GZIP_LEVEL, mtime: 0 }));
      const dir = path.join(outDir, String(z), String(x));
      if (!madeDirs.has(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        madeDirs.add(dir);
      }
      const p = fs.promises.writeFile(path.join(dir, `${y}.pbf`), buf).then(() => {
        pending.delete(p);
      });
      pending.add(p);
      zoomTiles++;
      zoomBytes += buf.length;
      zoomRawBytes += raw.length;
      // 書き出し待ちが溜まりすぎたら1本はけるまで待つ（メモリと fd を抑える）
      if (pending.size >= WRITE_CONCURRENCY) await Promise.race(pending);
    }
    written += zoomTiles;
    bytes += zoomBytes;
    rawBytes += zoomRawBytes;
    log(
      `    z${z}: ${zoomFeatures.length}点 → ${zoomTiles}タイル ` +
        `（${(zoomBytes / 1024 / 1024).toFixed(1)} MB / gzip 前 ` +
        `${(zoomRawBytes / 1024 / 1024).toFixed(1)} MB` +
        `${z >= detailFrom ? '、間引きなし' : ''}）`,
    );
  }
  // 残りの書き出しをすべて待つ（書き切る前に検証や配信が走るのを防ぐ）
  await Promise.all(pending);

  // TileJSON（利用側は tiles テンプレートと vector_layers を参照）。
  // stats はプレビュー地図が読む拡張フィールド。
  const metadata = {
    tilejson: '2.2.0',
    name: 'japan-facilities',
    description: '全国 食品営業許可 施設の点データ',
    format: 'pbf',
    scheme: 'xyz',
    minzoom: minZoom,
    maxzoom: maxZoom,
    bounds: BOUNDS,
    tiles: ['{z}/{x}/{y}.pbf'],
    vector_layers: [
      {
        id: LAYER,
        fields: {
          name: 'String',
          business_type: 'String',
          pref: 'String',
          city: 'String',
          // z{detailFrom} 未満のタイルだけに載る。同じグリッドセル・同じ業種の
          // 施設を 1 点に間引いた際の元の件数。最大ズームでは全点そのままなので付かない
          count: 'Number',
        },
      },
    ],
    // 間引きの仕様。利用側が「低ズームの点は代表点である」ことを判別できるようにする
    thinning: {
      detail_zoom: detailFrom,
      cells_per_tile: cellsPerTile,
    },
    updated,
    stats: {
      points: fc.features.length,
      records: stats?.rowsOut ?? null,
      prefectures: stats?.prefectures ?? null,
      cities: stats?.cities ?? null,
    },
  };
  fs.writeFileSync(path.join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');

  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  log(
    `  ベクトルタイル: ${fc.features.length}点 → ${written}タイル（z${minZoom}-${maxZoom}, ` +
      `計 ${mb(bytes)} MB / gzip 前 ${mb(rawBytes)} MB）→ api/tiles/`,
  );
  return { tiles: written, points: fc.features.length, bytes, rawBytes };
}

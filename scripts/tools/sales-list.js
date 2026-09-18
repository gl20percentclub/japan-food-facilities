// 飲食店向け営業用リストの生成（分析用・非コミット出力）
//
// 配信済みの CSV（全件 api/facilities-all.csv または都道府県別 api/prefectures/{code}.csv）を
// 入力に、「新しく出店した飲食店」へ営業をかけるためのリストを書き出す。
// クローラー側 issue gl20percentclub/japan-facilities-crawler#29 に対応する。
//
// やっていること:
//   1. 飲食店営業だけに絞る（有効期間の切れたレコードは落とす）
//   2. 市区町村を `address`（元データの営業施設所在地）から切り出し直す
//   3. 電話番号を正規化する（全角→半角・区切りをハイフンに統一・明らかな欠損は空に倒す）
//   4. 「新規」フラグを2系統で立てる（後述。2つの根拠は列を分けて混ぜない）
//
// 使い方:
//   node scripts/tools/sales-list.js --in api/prefectures/26.csv --out analysis/sales-list-26.csv
//   node scripts/tools/sales-list.js --in api/facilities-all.csv --pref 京都府 --only-new
//   node scripts/tools/sales-list.js --in api/prefectures/26.csv --new-keys api/changes/added-keys.txt
//
// ---------------------------------------------------------------------------
// 「新規」の根拠が2系統あることについて（ここが一番の設計判断）
// ---------------------------------------------------------------------------
// 根拠A: 週次スナップショットの差分（確実）
//   毎週のクロール結果を前回と突き合わせ、「今回増えた行」のキー一覧を `--new-keys`
//   で受け取る。解釈の余地がなく、これが本命。
//   差分の生成そのものはこのリポジトリの責務ではない（クロール基盤側の
//   gl20percentclub/japan-facilities-crawler#36 が持つ）。ここは**受け取る口**だけを用意する。
//
//   `--new-keys` が読むのは、差分が配信する **`api/changes/added-keys.txt`**（1行1キー）。
//   キーの形は recordKey() の doc コメントのとおりで、向こうの
//   `docker/snapshot-diff.mjs` が単一の情報源。取得例:
//     curl -o api/changes/added-keys.txt https://food.japan-facilities.com/api/changes/added-keys.txt
//
// 根拠B: 許可年月日が新しい（蓋然性が高いだけで、確定ではない）
//   差分が手に入らないときのフォールバック。`license_date >= --new-since`（既定 2024-06-01）で
//   立てる。**これは「新しく出店した」ことの証明にはならない。**
//     - 元データの `初回許可年月日` は飲食店営業の 99.4% で `許可年月日` と同一（京都府実測）。
//       そもそも配信CSV には `初回許可年月日` 列が無いので、ここでは `license_date`
//       （= 許可年月日）を使う。
//     - その `初回許可年月日` の最古が 2021-06 ＝ 改正食品衛生法の施行日で、旧制度から
//       移行しただけの老舗も 2021〜2024 の日付を持つ。経過措置が明けた 2024-06-01 以降なら
//       真に新しい許可である蓋然性は高い、という程度の根拠しかない。
//   出力では列名を `is_new_guess_by_license_date`（guess）とし、根拠Aの
//   `is_new_by_snapshot_diff` とは別列に分けて、どちらで立ったフラグか必ず区別できるようにする。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../lib/config.js';
import { readCsvRows } from '../lib/csv-read.js';
import { splitPrefCity } from '../lib/normalize.js';
import { toMunicipality } from '../lib/city-normmap.js';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/**
 * 飲食店営業と判定するキーワード（部分一致）。
 * 元データの業種表記は自治体ごとに揺れる（「① 飲食店営業」「飲食店営業(1)一般食堂・
 * レストラン等」「飲食店（バー）」等）ため完全一致では拾えない。
 * 判定は site/map.html の CATEGORY_GROUPS の restaurant と同じキーワードに合わせてある
 * （表記ゆれの実例と期待結果は scripts/map-filter.test.js が固定している）。
 * 旧法の「喫茶店営業」は別業種なので含めない。
 */
export const RESTAURANT_KEYWORDS = ['飲食店'];

/**
 * 根拠B（許可年月日フォールバック）の既定の基準日。
 * 改正食品衛生法の経過措置が明けた日。これ以降の許可なら旧制度からの移行ではない
 * 蓋然性が高い、というだけの根拠であることに注意（モジュール冒頭のコメント参照）。
 */
export const DEFAULT_NEW_SINCE = '2024-06-01';

/** 出力CSV の列（この順で出力する）。 */
export const SALES_CSV_COLUMNS = [
  'key',
  'prefecture',
  'city',
  'city_csv',
  'name',
  'name_kana',
  'business_type',
  'address',
  'lat',
  'lng',
  'phone',
  'license_no',
  'license_date',
  'expire_date',
  'is_new_by_snapshot_diff',
  'is_new_guess_by_license_date',
  'new_basis',
  'sources',
  'licenses',
];

/**
 * 入力CSV に必ず要る列（配信CSV の列。欠けていたら入力を間違えている）。
 * 同一性キーに使う列（`sources` / `license_no` / `business_type` / `city` / `name` / `address`）が
 * 1つでも欠けると、差分と突き合わせたときに全行が別レコード扱いになるので必ず含める。
 */
export const REQUIRED_INPUT_COLUMNS = [
  'prefecture', 'city', 'name', 'business_type', 'address', 'phone', 'license_no', 'license_date',
  'expire_date', 'sources',
];

/** `new_basis` に入れる根拠の識別子（列を分けたうえで、まとめて読む用）。 */
export const BASIS_SNAPSHOT_DIFF = 'snapshot-diff';
export const BASIS_LICENSE_DATE_GUESS = 'license-date-guess';

// ---------------------------------------------------------------------------
// 純粋関数（テスト対象）
// ---------------------------------------------------------------------------

/**
 * 業種表記が飲食店営業かを判定する（純粋関数）。
 * 表記ゆれを吸収するため RESTAURANT_KEYWORDS の部分一致で見る。
 */
export function isRestaurant(businessType) {
  const s = String(businessType ?? '');
  return RESTAURANT_KEYWORDS.some((kw) => s.includes(kw));
}

/** `YYYY-MM-DD` 形式の日付文字列かを判定する（純粋関数）。 */
export function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '').trim());
}

/**
 * 有効期間が切れている（＝もう営業していないとみなす）かを判定する（純粋関数）。
 *
 * 配信CSV には `廃業年月日` 列が無い（config/sources.yaml の close_date は取り込んで
 * いるが、scripts/lib/normalize.js の toFacility() が出力していない）。そのため
 * 「廃業を除く」の代わりに、**有効期間終了日が基準日より前のレコードを落とす**。
 * 有効期間終了日が空・不正な形式のレコードは判断材料が無いので落とさない
 * （黙って消すより、営業リストに残して人が見たほうがよい）。
 */
export function isExpired(expireDate, asOf) {
  const d = String(expireDate ?? '').trim();
  if (!isIsoDate(d) || !isIsoDate(asOf)) return false;
  return d < asOf; // ISO 形式なので辞書順比較でそのまま日付の前後になる
}

/**
 * 許可年月日が基準日以降かを判定する（純粋関数）。根拠B（蓋然性）の判定。
 * 許可年月日が空・不正な形式なら判定できないので null を返す（0 とは区別する）。
 */
export function isRecentLicense(licenseDate, since) {
  const d = String(licenseDate ?? '').trim();
  if (!isIsoDate(d)) return null;
  return d >= since;
}

/**
 * 市区町村を営業施設所在地から切り出す（純粋関数）。
 *
 * 配信CSV の `city` 列をそのまま使ってはいけない。元データの `市区町村名` 列は
 * **公開元（県庁）の所在地**であって施設の所在地ではないことがある。京都府の
 * 20,900件は全行が「京都市上京区」＝京都府庁の住所になっており、1行目は
 * `市区町村名` が上京区なのに `営業施設所在地` は南丹市だった。住所から切り出すと
 * 宇治市 1,580 / 福知山市 847 / 京丹後市 761 と妥当な分布になる。
 *
 * 切り出しは既存の splitPrefCity（scripts/lib/normalize.js）を使う。これは
 * `locateByAddress` ソース（厚労省 i2fas。市区町村カラムが管轄自治体になっている）で
 * すでに本番で使っている仕組みで、同じ罠に同じ道具で対処する。粒度（郡名剥がし・
 * 政令市の行政区を市へ集約）も既存の toMunicipality（scripts/lib/city-normmap.js）に
 * 揃えるので、配信CSV の `city` 列と直接比べられる。
 *
 * 住所が都道府県名で始まらない場合は `pref` を前置して解析し直す（県名なし住所への対応）。
 * 切り出せなければ空文字を返す（呼び出し側が配信CSV の値へフォールバックする）。
 */
export function cityFromAddress(address, pref) {
  const addr = String(address ?? '').trim();
  if (!addr) return '';
  let [, city] = splitPrefCity(addr);
  if (!city && pref) [, city] = splitPrefCity(`${String(pref).trim()}${addr}`);
  return city ? toMunicipality(stripTownAfterCityWithCounty(city)) : '';
}

/**
 * 市名に『郡』を含む自治体で、町名まで取り込んでしまった切り出し結果を市までに戻す（純粋関数）。
 *
 * splitPrefCity は「郡＋町村」を「市」より先に判定するため、郡山市・郡上市・大和郡山市の
 * ような市では、市名の先にある町名まで1つの自治体名として拾ってしまう
 * （「岐阜県郡上市八幡町島谷」→「郡上市八幡町」）。このまま toMunicipality を通すと
 * 郡名剥がしが働いて「上市八幡町」という実在しない自治体名になる。
 *
 * 先頭から最初の「〜市」までが『郡』を含み、かつ切り出し結果がそれより長い場合は、
 * その『郡』は郡名ではなく市名の一部なので、市までで切り直す。
 * 「余市郡余市町」のように郡名の側に『市』があるケースでは、最初の「〜市」＝「余市」に
 * 『郡』が含まれないため、この補正は働かない（正しく郡＋町村のまま残る）。
 */
export function stripTownAfterCityWithCounty(city) {
  const m = String(city).match(/^(.+?市)/);
  if (m && m[1].includes('郡') && city.length > m[1].length) return m[1];
  return city;
}

// 電話番号として使う文字の対応表（全角→半角）。
// 元データには全角数字・全角ハイフン・全角括弧がそのまま入っていることがある。
const FULLWIDTH_DIGITS = /[０-９]/g;
// ハイフンに見える記号（全角ハイフン・長音・ダッシュ類・マイナス）はすべて '-' に寄せる。
const HYPHEN_LIKE = /[‐‑‒–—―ー−－]/g;

/** 電話番号として意味を持たないプレースホルダ（そのまま残すと営業先として誤解される）。 */
const PHONE_PLACEHOLDERS = new Set(['', '-', 'なし', '無し', '無', '不明', '非公開', '記載なし', '未定']);

/**
 * 電話番号を正規化する（純粋関数）。
 *
 * 正規化できなければ空文字を返す（＝電話番号なしとして扱う）。京都府の実測では
 * 飲食店営業のうち電話番号があるのは 59.4% で、残りは元データに入っていない。
 * 埋まっていない番号を無理に整形して「それらしい番号」を作らないこと。
 *
 * ルール:
 *   - 全角数字・全角ハイフン類を半角へ寄せ、'TEL' や '電話' の見出しを落とす
 *   - 括弧・スラッシュ・空白・ドットは区切りとみなしてハイフンに統一する
 *   - 国番号 +81 / 81- は先頭 0 に戻す
 *   - プレースホルダ（'なし' '不明' 等）、同じ数字の繰り返し（0000000000 等）は欠損とみなす
 *   - 桁数は 10桁（固定電話・フリーダイヤル 0120）か 11桁（携帯・0800）だけを通す。
 *     桁数の足りない番号は内線や入力途中の可能性が高く、そのまま架電できないため落とす
 *   - 区切りの位置は元データのまま保つ。市外局番の桁数は地域ごとに違い、
 *     数字列から機械的に打ち直すと誤った区切りを作ってしまうため、
 *     「区切り文字の統一」だけを行い、**ハイフンの打ち直しはしない**
 */
export function normalizePhone(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';

  // 全角英数を半角へ（数字以外の全角は後段でどうせ落ちるので数字だけ寄せる）
  s = s.replace(FULLWIDTH_DIGITS, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(HYPHEN_LIKE, '-');
  // 見出し語・注記を落とす（「TEL:075-...」「電話 075-...」「075-...（代表）」）
  s = s.replace(/tel|電話番号|電話|ＴＥＬ/gi, '');
  s = s.replace(/[（(][^）)]*[）)]\s*$/, ''); // 末尾の注記「（代表）」等
  s = s.replace(/[※＊*].*$/, ''); // 注記マーカー以降を落とす（「03-1234-5678 ※代表」）
  s = s.trim();

  if (PHONE_PLACEHOLDERS.has(s)) return '';

  // 国番号を国内表記へ戻す（+81-75-... → 075-...）
  s = s.replace(/^\+?81[-\s]?/, '0');

  // 区切りに使われる文字をすべてハイフンへ寄せる（括弧書き 075(123)4567 や
  // 見出しの後ろに残るコロン「:075-…」を含む）
  s = s.replace(/[()（）\/／.、,:：\s　]+/g, '-');
  // ハイフンの重複・前後のハイフンを整理する
  s = s.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');

  // ここまでで数字とハイフン以外が残っていたら電話番号として扱わない
  // （「内線123」「代表」「※」等が混ざったセル）
  if (!/^[0-9-]+$/.test(s) || s === '') return '';

  const digits = s.replace(/-/g, '');
  if (digits.length < 10 || digits.length > 11) return ''; // 桁数が合わない＝欠損か内線
  if (!digits.startsWith('0')) return ''; // 国内の電話番号は必ず 0 始まり
  if (/^(\d)\1+$/.test(digits)) return ''; // 0000000000 のようなダミー

  return s;
}

/**
 * 同一性キーの主キーに使う列（許可番号がある行）。
 * クロール基盤側 `docker/snapshot-diff.mjs` の `PRIMARY_KEY_COLUMNS` と同じ。
 */
export const PRIMARY_KEY_COLUMNS = ['sources', 'license_no', 'business_type'];

/**
 * 同一性キーの代替キーに使う列（許可番号が空の行）。
 * クロール基盤側 `docker/snapshot-diff.mjs` の `FALLBACK_KEY_COLUMNS` と同じ。
 */
export const FALLBACK_KEY_COLUMNS = ['sources', 'city', 'name', 'address', 'business_type'];

/** キーの区切り文字（本文に出てこない制御文字）。主キー/代替キーの種別も先頭1文字で分ける。 */
const KEY_SEPARATOR = '\u0001';

/**
 * レコードの同一性を判定するキーを作る（純粋関数）。
 *
 * **この関数の単一の情報源はクロール基盤側の `docker/snapshot-diff.mjs`**
 * （`gl20percentclub/japan-facilities-crawler#36`）。差分を出すのは向こうで、ここは
 * その出力（`api/changes/added-keys.txt`）と突き合わせるだけなので、列の並び・区切り
 * 文字・空白の扱い・代替キーへの切り替え条件のどれか1つでもズレると、`--new-keys` を
 * 渡しても新規フラグが1件も立たない。**片方を変えたらもう片方が必ず壊れる**ので、
 * 変更するときは両リポジトリを同じタイミングで直すこと。
 *
 * 列の選定理由（向こうの doc コメントと同じ）:
 *   - 元CSV の行番号は使わない。公開元が並べ替えただけで全行がズレる。
 *   - `license_no`（許可番号）は保健所ごとの連番なので単独では一意にならない。
 *     同じ都道府県内でも発行元が違えば同じ番号が出る。そこで**発行元とセットにする**。
 *     結合CSV でそれにあたるのは `sources`（config/sources.yaml の `source` 名がそのまま
 *     入る＝データを公開している主体）。`prefecture` は**施設の所在地**であって公開主体
 *     ではなく、名寄せの改善で値が動くのでキーには向かない。
 *   - `business_type` を足すのは、**同一施設が複数業種の許可を同じ番号で持つ**データが
 *     あるため。結合CSV は業種違いを別レコードとして残す方針なので、業種を含めないと
 *     2件が1キーに潰れる。
 *   - `name` / `address` は元データの生の値なので、許可番号が空のソース向けの代替キーに
 *     だけ使う（主キーに含めると、表記ゆれの修正が「消滅＋新規追加」に化ける）。
 *
 * 値の正規化は**前後の空白を落とすだけ**。連続空白の圧縮などをここで足すと向こうと
 * 一致しなくなる。
 */
export function recordKey(row) {
  const keyValue = (v) => (v === undefined || v === null ? '' : String(v).trim());
  const licenseNo = keyValue(row.license_no);
  // 許可番号があれば主キー（'L'）、無ければ代替キー（'C'）。先頭1文字で種別を分けるのは、
  // たまたま同じ連結文字列になった主キーと代替キーがぶつからないようにするため。
  const columns = licenseNo ? PRIMARY_KEY_COLUMNS : FALLBACK_KEY_COLUMNS;
  const parts = columns.map((c) => keyValue(row[c]));
  return (licenseNo ? 'L' : 'C') + KEY_SEPARATOR + parts.join(KEY_SEPARATOR);
}

/**
 * 1行を営業リストの1行へ変換する（純粋関数）。
 *
 * `newKeys` は差分で「今回増えた」と判定されたキーの Set。差分が無い場合は null を
 * 渡すこと。null のとき `is_new_by_snapshot_diff` は 0 ではなく空文字にする
 * （「新規ではない」ではなく「判定できない」なので、0 と混ぜてはいけない）。
 *
 * `cityFromAddr` は住所から切り出した市区町村。呼び出し側が統計用にすでに計算して
 * いる場合に渡す（同じ住所を2回解析しないため）。省略時はここで計算する。
 */
export function buildSalesRow(row, {
  newKeys = null,
  newSince = DEFAULT_NEW_SINCE,
  cityFromAddr = cityFromAddress(row.address, row.prefecture),
} = {}) {
  const key = recordKey(row);

  // 罠3対策: 市区町村は住所から切り出した値を採用し、配信CSV の値は city_csv に残す
  // （両者が食い違う行がそのまま罠3の検出になる）。切り出せなければ配信CSV の値に戻す。
  const cityCsv = String(row.city ?? '').trim();

  // 根拠A: スナップショット差分。差分が無ければ「判定できない」として空文字。
  const byDiff = newKeys ? (newKeys.has(key) ? 1 : 0) : '';
  // 根拠B: 許可年月日（蓋然性のみ）。許可年月日が無ければ判定できないので空文字。
  const recent = isRecentLicense(row.license_date, newSince);
  const byLicense = recent === null ? '' : recent ? 1 : 0;

  // 2つの根拠は列を分けたうえで、立ったものだけを new_basis に並べる（混ぜて上書きしない）。
  const basis = [];
  if (byDiff === 1) basis.push(BASIS_SNAPSHOT_DIFF);
  if (byLicense === 1) basis.push(BASIS_LICENSE_DATE_GUESS);

  return {
    key,
    prefecture: row.prefecture ?? '',
    city: cityFromAddr || cityCsv,
    city_csv: cityCsv,
    name: row.name ?? '',
    name_kana: row.name_kana ?? '',
    business_type: row.business_type ?? '',
    address: row.address ?? '',
    lat: row.lat ?? '',
    lng: row.lng ?? '',
    phone: normalizePhone(row.phone),
    license_no: row.license_no ?? '',
    license_date: row.license_date ?? '',
    expire_date: row.expire_date ?? '',
    is_new_by_snapshot_diff: byDiff,
    is_new_guess_by_license_date: byLicense,
    new_basis: basis.join('+'),
    sources: row.sources ?? '',
    licenses: row.licenses ?? '',
  };
}

/**
 * 配信CSV の行（オブジェクト）の配列から営業リストの行を選び出す（純粋関数）。
 *
 * 戻り値は `{ rows, stats }`。`stats` には各段で何件落としたかを残す
 * （営業リストは「何件取れたか」で価値が決まるので、絞り込みを黙って行わない）。
 *
 * オプション:
 *   asOf          有効期間切れの判定基準日（`YYYY-MM-DD`）
 *   newSince      根拠Bの基準日（`YYYY-MM-DD`）
 *   newKeys       差分で増えたレコードのキー Set（無ければ null）
 *   onlyNew       どちらかの根拠で新規フラグが立った行だけ残す
 *   requirePhone  電話番号を正規化できた行だけ残す
 *   pref          都道府県で絞る（全件CSV を入力にするとき）
 */
export function selectSalesRows(rows, {
  asOf,
  newSince = DEFAULT_NEW_SINCE,
  newKeys = null,
  onlyNew = false,
  requirePhone = false,
  pref = null,
} = {}) {
  const stats = {
    rowsIn: 0,
    prefSkipped: 0,
    notRestaurant: 0,
    expired: 0,
    restaurant: 0,
    withAddress: 0,
    withCoord: 0,
    withPhone: 0,
    cityFromAddress: 0,
    cityMismatch: 0,
    newByDiff: 0,
    newByLicenseGuess: 0,
    droppedNotNew: 0,
    droppedNoPhone: 0,
    rowsOut: 0,
  };
  const out = [];

  for (const row of rows) {
    stats.rowsIn++;

    if (pref && String(row.prefecture ?? '').trim() !== pref) {
      stats.prefSkipped++;
      continue;
    }
    if (!isRestaurant(row.business_type)) {
      stats.notRestaurant++;
      continue;
    }
    // 廃業の代わりに有効期間切れで落とす（isExpired の doc コメント参照）。
    if (isExpired(row.expire_date, asOf)) {
      stats.expired++;
      continue;
    }
    stats.restaurant++;

    // 住所からの切り出しは統計にも使うのでここで1回だけ行い、行の組み立てへ渡す。
    const cityFromAddr = cityFromAddress(row.address, row.prefecture);
    const sales = buildSalesRow(row, { newKeys, newSince, cityFromAddr });

    // 営業リストとしての充足度。落とす判断はしないが、件数は必ず出す。
    if (sales.address) stats.withAddress++;
    if (sales.lat !== '' && sales.lng !== '') stats.withCoord++;
    if (sales.phone) stats.withPhone++;
    // 罠3の検出: 住所から切り出せた件数と、配信CSV の city と食い違った件数。
    if (cityFromAddr) {
      stats.cityFromAddress++;
      if (cityFromAddr !== sales.city_csv) stats.cityMismatch++;
    }
    if (sales.is_new_by_snapshot_diff === 1) stats.newByDiff++;
    if (sales.is_new_guess_by_license_date === 1) stats.newByLicenseGuess++;

    if (onlyNew && sales.new_basis === '') {
      stats.droppedNotNew++;
      continue;
    }
    if (requirePhone && !sales.phone) {
      stats.droppedNoPhone++;
      continue;
    }

    out.push(sales);
    stats.rowsOut++;
  }

  return { rows: out, stats };
}

/**
 * 差分キー一覧のテキストを Set にする（純粋関数）。
 *
 * クロール基盤側が配信する `api/changes/added-keys.txt` の形式＝**1行1キー**を読む。
 * キーは recordKey() と同じ文字列（先頭が `L`/`C`、区切りは制御文字 U+0001）なので、
 * 行の中身は一切加工しない。空行と `#` で始まる行だけ無視する
 * （手で作ったキー一覧に見出しを書けるようにするため。キーは必ず `L`/`C` で始まる）。
 */
export function parseNewKeys(text) {
  const keys = new Set();
  for (const line of String(text ?? '').split('\n')) {
    const s = line.replace(/\r$/, '');
    if (!s.trim() || s.startsWith('#')) continue;
    keys.add(s);
  }
  return keys;
}

/**
 * コマンドライン引数を解釈する（純粋関数）。
 * 未知のオプションは黙って無視せずエラーにする（打ち間違いで全件が出るのを防ぐ）。
 */
export function parseArgs(argv, { today } = {}) {
  const opts = {
    in: 'api/facilities-all.csv',
    out: 'analysis/sales-list.csv',
    newKeys: null,
    newSince: DEFAULT_NEW_SINCE,
    asOf: today || new Date().toISOString().slice(0, 10),
    onlyNew: false,
    requirePhone: false,
    pref: null,
  };
  const takesValue = {
    '--in': 'in', '--out': 'out', '--new-keys': 'newKeys',
    '--new-since': 'newSince', '--as-of': 'asOf', '--pref': 'pref',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `--key=value` 形式と `--key value` 形式の両方を受ける（既存ツールに合わせる）。
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (takesValue[name]) {
      const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new Error(`${name} に値がありません`);
      opts[takesValue[name]] = value;
      continue;
    }
    if (name === '--only-new') { opts.onlyNew = true; continue; }
    if (name === '--require-phone') { opts.requirePhone = true; continue; }
    throw new Error(`不明なオプション: ${a}`);
  }

  for (const [label, value] of [['--as-of', opts.asOf], ['--new-since', opts.newSince]]) {
    if (!isIsoDate(value)) throw new Error(`${label} は YYYY-MM-DD 形式で指定してください: ${value}`);
  }
  return opts;
}

/**
 * ヘッダー行（セル配列）から「列名 → 位置」の対応を作る（純粋関数）。
 * 配信CSV の列が欠けていたら、入力を取り違えているのでその場で止める。
 */
export function indexHeader(header) {
  const cells = (header || []).map((h) => String(h).replace(/^﻿/, '').trim());
  const index = {};
  cells.forEach((h, i) => {
    if (h && index[h] === undefined) index[h] = i;
  });
  const missing = REQUIRED_INPUT_COLUMNS.filter((c) => index[c] === undefined);
  if (missing.length) {
    throw new Error(`入力CSV に必要な列がありません: ${missing.join(', ')}`);
  }
  return index;
}

// ---------------------------------------------------------------------------
// 入出力
// ---------------------------------------------------------------------------

/** CSV セルのエスケープ（build/merged-csv.js と同じ規則）。 */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 配信CSV を1行ずつ読み、列名でひけるオブジェクトとして yield する。
 * 全件CSV は数百MB あるためメモリに載せず、既存の readCsvRows で流し読みする。
 */
export function* readFacilityRows(filePath) {
  let index = null;
  for (const cells of readCsvRows(filePath)) {
    if (!index) {
      index = indexHeader(cells);
      continue;
    }
    const row = {};
    for (const [name, i] of Object.entries(index)) row[name] = cells[i] ?? '';
    yield row;
  }
  if (!index) throw new Error('入力CSV が空です（ヘッダー行もありません）');
}

/**
 * 営業リストの行を CSV に書き出す。
 * 営業担当が Excel で開くことを前提に、配信物と違って BOM 付き UTF-8 で書く
 * （配信CSV は BOM なし。これは analysis/ 配下の分析出力であって配信物ではない）。
 */
async function writeSalesCsv(outPath, rows) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const out = fs.createWriteStream(outPath, { encoding: 'utf-8' });
  out.write('﻿');
  out.write(SALES_CSV_COLUMNS.join(',') + '\n');
  for (const r of rows) out.write(SALES_CSV_COLUMNS.map((c) => csvCell(r[c])).join(',') + '\n');
  await new Promise((resolve, reject) => {
    out.once('error', reject);
    out.end(resolve);
  });
  return fs.statSync(outPath).size;
}

/** 相対パスはリポジトリルート基準で解決する（どこから実行しても同じ場所を指す）。 */
function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const inPath = resolvePath(opts.in);
  const outPath = resolvePath(opts.out);

  if (!fs.existsSync(inPath)) {
    throw new Error(
      `入力CSV が見つかりません: ${inPath}\n` +
        '  配信物を取得してから実行してください:\n' +
        '    curl -o api/prefectures/26.csv https://food.japan-facilities.com/api/prefectures/26.csv',
    );
  }

  let newKeys = null;
  if (opts.newKeys) {
    const keysPath = resolvePath(opts.newKeys);
    if (!fs.existsSync(keysPath)) throw new Error(`差分キー一覧が見つかりません: ${keysPath}`);
    newKeys = parseNewKeys(fs.readFileSync(keysPath, 'utf-8'));
  }

  console.log(`営業用リスト生成: ${opts.in}`);
  console.log(`  有効期間切れの判定基準日: ${opts.asOf}`);
  if (newKeys) console.log(`  スナップショット差分: ${newKeys.size.toLocaleString('en-US')}キー（根拠A）`);
  else console.log('  スナップショット差分: なし → 許可年月日での推定のみ（根拠B）');
  console.log(`  許可年月日の基準日: ${opts.newSince}（根拠B・蓋然性のみ）\n`);

  const { rows, stats } = selectSalesRows(readFacilityRows(inPath), {
    asOf: opts.asOf,
    newSince: opts.newSince,
    newKeys,
    onlyNew: opts.onlyNew,
    requirePhone: opts.requirePhone,
    pref: opts.pref,
  });

  const bytes = await writeSalesCsv(outPath, rows);

  const n = (v) => v.toLocaleString('en-US');
  console.log('===== 絞り込み =====');
  console.log(`  入力: ${n(stats.rowsIn)}行`);
  if (opts.pref) console.log(`  他都道府県で除外: ${n(stats.prefSkipped)}行`);
  console.log(`  飲食店営業でない: ${n(stats.notRestaurant)}行を除外`);
  console.log(`  有効期間切れ: ${n(stats.expired)}行を除外（配信CSV に廃業年月日は無い）`);
  console.log(`  飲食店営業（有効）: ${n(stats.restaurant)}行`);
  console.log(`    うち住所あり: ${n(stats.withAddress)} / 座標あり: ${n(stats.withCoord)} / 電話あり: ${n(stats.withPhone)}`);
  console.log('\n===== 市区町村 =====');
  console.log(`  住所から切り出せた: ${n(stats.cityFromAddress)}行`);
  console.log(`    うち配信CSV の city と食い違う: ${n(stats.cityMismatch)}行`);
  console.log('    （元データの市区町村名列が公開元＝県庁の所在地になっているケース。住所側を採用する）');
  console.log('\n===== 新規フラグ =====');
  if (newKeys) console.log(`  根拠A スナップショット差分: ${n(stats.newByDiff)}行`);
  else console.log('  根拠A スナップショット差分: 未判定（--new-keys 未指定）');
  console.log(`  根拠B 許可年月日 >= ${opts.newSince}: ${n(stats.newByLicenseGuess)}行`);
  console.log('    ※ 根拠B は「新しく出店した」ことの証明ではない。改正食品衛生法の経過措置明け以降の');
  console.log('       許可というだけで、旧制度からの移行を除ききれる保証はない（蓋然性が高い止まり）。');
  if (opts.onlyNew) console.log(`  新規フラグなしで除外: ${n(stats.droppedNotNew)}行`);
  if (opts.requirePhone) console.log(`  電話番号なしで除外: ${n(stats.droppedNoPhone)}行`);
  console.log(`\n出力: ${opts.out}（${n(stats.rowsOut)}行 / ${(bytes / 1024).toFixed(1)} KB）`);
}

// ライブラリとして import されたときは実行しない（テストから純粋関数だけを使う）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n❌ エラー: ${err.message}`);
    process.exit(1);
  });
}

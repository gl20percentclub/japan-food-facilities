// 営業用リスト生成（scripts/tools/sales-list.js）のロジックを検証する。
//   node scripts/tools/sales-list.test.js
//
// 営業リストの価値は「新しく出店した飲食店に、連絡できる形で届くか」で決まる。
// ここで固定するのは4点:
//   - 飲食店営業だけに絞れる（表記ゆれを拾い、有効期間の切れたレコードは落とす）
//   - 市区町村を住所から切り出す（元データの市区町村名列＝公開元の所在地に引きずられない）
//   - 電話番号が架電できる形に正規化され、欠損は欠損として落ちる
//   - 「新規」フラグの2系統（スナップショット差分／許可年月日の推定）が別の列に分かれ、
//     どちらで立ったのか必ず区別できる

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BASIS_LICENSE_DATE_GUESS,
  BASIS_SNAPSHOT_DIFF,
  DEFAULT_NEW_SINCE,
  SALES_CSV_COLUMNS,
  buildSalesRow,
  cityFromAddress,
  indexHeader,
  isExpired,
  isRecentLicense,
  isRestaurant,
  normalizePhone,
  parseArgs,
  parseNewKeys,
  readFacilityRows,
  recordKey,
  selectSalesRows,
  stripTownAfterCityWithCounty,
} from './sales-list.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('営業用リスト テスト\n');

/**
 * テスト用の配信CSV 1行（列は api/facilities-all.csv と同じ）。
 * 既定値は京都府のデータを模した「罠3」入りの行にしてある。
 * `city` は公開元（京都府庁）の所在地で、施設は南丹市にある。
 */
function row(over = {}) {
  return {
    prefecture: '京都府',
    city: '京都市',
    city_raw: '京都市上京区',
    name: '居酒屋テスト',
    name_kana: 'イザカヤテスト',
    business_type: '飲食店営業',
    address: '京都府南丹市園部町小桜町47',
    lat: '35.107',
    lng: '135.471',
    geocoding_level: '8',
    phone: '0771-22-3333',
    license_no: '第1号',
    license_date: '2025-04-01',
    expire_date: '2031-03-31',
    sources: '京都府食品営業許可',
    licenses: 'CC BY 4.0',
    ...over,
  };
}

// --- 飲食店営業の絞り込み ---------------------------------------------------
test('飲食店営業の表記ゆれを拾い、別業種は拾わない', () => {
  // 実データの表記（scripts/map-filter.test.js の REAL_TO_TYPE と同じ出典）
  for (const t of [
    '飲食店営業',
    '① 飲食店営業',
    '飲食店営業(1)一般食堂・レストラン等',
    '飲食店営業(2)仕出し屋・弁当屋',
    '飲食店（バー）',
    '飲食店（屋台型臨時営業）',
  ]) {
    assert.ok(isRestaurant(t), `「${t}」は飲食店営業`);
  }
  // 旧法の喫茶店営業は別業種。菓子製造業・そうざい製造業も混ぜない。
  for (const t of ['喫茶店営業', '⑪ 菓子製造業', '㉕ そうざい製造業', '食肉販売業', '', undefined]) {
    assert.ok(!isRestaurant(t), `「${t}」は飲食店営業ではない`);
  }
});

test('有効期間が切れたレコードを廃業の代わりに落とす', () => {
  // 配信CSV には廃業年月日の列が無いため、有効期間終了日で判定する。
  assert.equal(isExpired('2025-03-31', '2026-09-19'), true);
  assert.equal(isExpired('2031-03-31', '2026-09-19'), false);
  assert.equal(isExpired('2026-09-19', '2026-09-19'), false, '基準日当日はまだ有効');
  // 判断材料が無い行は落とさない（黙って消すより人に見せる）
  assert.equal(isExpired('', '2026-09-19'), false);
  assert.equal(isExpired('不明', '2026-09-19'), false);
  assert.equal(isExpired('2025-03-31', ''), false, '基準日が不正なら判定しない');
});

// --- 市区町村の切り出し（罠3） ------------------------------------------------
test('市区町村を住所から切り出す（市区町村名列の公開元住所に引きずられない）', () => {
  // 京都府の配信データは全行の city が「京都市」（＝京都府庁の所在地）になっている。
  // 住所から切り出せば施設の実際の市区町村になる、というのがこのツールの前提。
  assert.equal(cityFromAddress('京都府南丹市園部町小桜町47', '京都府'), '南丹市');
  assert.equal(cityFromAddress('京都府宇治市宇治琵琶33', '京都府'), '宇治市');
  assert.equal(cityFromAddress('京都府京丹後市峰山町杉谷', '京都府'), '京丹後市');
  // 都道府県名で始まらない住所は pref を前置して解析する
  assert.equal(cityFromAddress('福知山市内記1', '京都府'), '福知山市');
  // 粒度は配信CSV の city 列と同じ（郡名を外す・政令市の行政区は市に集約）
  assert.equal(cityFromAddress('京都府久世郡久御山町佐山', '京都府'), '久御山町');
  assert.equal(cityFromAddress('神奈川県横浜市戸塚区上倉田町1', '神奈川県'), '横浜市');
  assert.equal(cityFromAddress('東京都千代田区丸の内1-1', '東京都'), '千代田区');
  assert.equal(cityFromAddress('三重県四日市市諏訪町1', '三重県'), '四日市市');
  // 切り出せない住所は空（呼び出し側が配信CSV の値に戻す）
  assert.equal(cityFromAddress('', '京都府'), '');
  assert.equal(cityFromAddress('市内一円', ''), '');
});

test('市名に『郡』を含む自治体で町名まで取り込まない', () => {
  // splitPrefCity は「郡＋町村」を「市」より先に判定するため、補正しないと
  // 「郡上市八幡町」→ 郡名剥がしで「上市八幡町」という実在しない自治体名になる。
  assert.equal(cityFromAddress('岐阜県郡上市八幡町島谷1', '岐阜県'), '郡上市');
  assert.equal(cityFromAddress('奈良県大和郡山市本町1', '奈良県'), '大和郡山市');
  assert.equal(cityFromAddress('福島県郡山市虎丸町1', '福島県'), '郡山市');
  // 郡名の側に「市」がある町村は、補正を働かせずに郡＋町村のまま解釈する
  assert.equal(cityFromAddress('北海道余市郡余市町黒川町1', '北海道'), '余市町');
  assert.equal(cityFromAddress('北海道余市郡仁木町北町1', '北海道'), '仁木町');
  // 純粋関数としての振る舞い
  assert.equal(stripTownAfterCityWithCounty('郡上市八幡町'), '郡上市');
  assert.equal(stripTownAfterCityWithCounty('余市郡余市町'), '余市郡余市町');
  assert.equal(stripTownAfterCityWithCounty('南丹市'), '南丹市');
});

// --- 電話番号の正規化 ---------------------------------------------------------
test('電話番号を半角・ハイフン区切りに正規化する', () => {
  assert.equal(normalizePhone('075-123-4567'), '075-123-4567');
  assert.equal(normalizePhone('０７５－１２３－４５６７'), '075-123-4567', '全角→半角');
  assert.equal(normalizePhone('075(123)4567'), '075-123-4567', '括弧書き→ハイフン');
  assert.equal(normalizePhone('075.123.4567'), '075-123-4567');
  assert.equal(normalizePhone('075 123 4567'), '075-123-4567');
  assert.equal(normalizePhone('TEL:075-123-4567'), '075-123-4567', '見出し語を落とす');
  assert.equal(normalizePhone('電話 075-123-4567'), '075-123-4567');
  assert.equal(normalizePhone('075-123-4567（代表）'), '075-123-4567', '末尾の注記を落とす');
  assert.equal(normalizePhone('03-1234-5678 ※代表'), '03-1234-5678');
  assert.equal(normalizePhone('+81-75-123-4567'), '075-123-4567', '国番号を国内表記へ');
  assert.equal(normalizePhone('090-1234-5678'), '090-1234-5678');
  assert.equal(normalizePhone('0120-123-456'), '0120-123-456');
  // 区切りの位置は元データのまま。市外局番の桁数は地域ごとに違うので打ち直さない。
  assert.equal(normalizePhone('0751234567'), '0751234567');
  assert.equal(normalizePhone('0-7-5-1-2-3-4-5-6-7'), '0-7-5-1-2-3-4-5-6-7');
});

test('明らかな欠損の電話番号は空に倒す', () => {
  for (const q of [
    '', '   ', '-', 'なし', '無し', '不明', '非公開', '記載なし',
    '0000000000', // ダミー
    '1234567890', // 0 始まりでない
    '1234567', // 桁数不足
    '075-123-456789', // 桁数超過
    '内線123',
    '075-123-4567/090-1111-2222', // 2本入り（どちらか判断できない）
    'お問い合わせください',
  ]) {
    assert.equal(normalizePhone(q), '', `「${q}」は欠損`);
  }
});

// --- 新規フラグの2系統 --------------------------------------------------------
test('recordKey: 行番号ではなく内容で同一性を判定する', () => {
  const a = recordKey(row());
  // 空白のゆれは吸収する（前週との突き合わせが空白差で外れないように）
  assert.equal(recordKey(row({ name: ' 居酒屋テスト ' })), a);
  assert.equal(recordKey(row({ address: '京都府南丹市園部町小桜町47' })), a);
  // 施設・所在地・許可番号が違えば別レコード
  assert.notEqual(recordKey(row({ name: '居酒屋テスト2' })), a);
  assert.notEqual(recordKey(row({ license_no: '第2号' })), a);
  assert.notEqual(recordKey(row({ address: '京都府宇治市宇治琵琶33' })), a);
  // 列の値をタブで連結した形（差分を作る側と同じ関数を使う前提）
  assert.equal(a.split('\t').length, 4);
});

test('isRecentLicense: 許可年月日が判定できない行は 0 と区別する', () => {
  assert.equal(isRecentLicense('2025-04-01', DEFAULT_NEW_SINCE), true);
  assert.equal(isRecentLicense('2024-06-01', DEFAULT_NEW_SINCE), true, '基準日当日は含む');
  assert.equal(isRecentLicense('2023-05-31', DEFAULT_NEW_SINCE), false);
  assert.equal(isRecentLicense('', DEFAULT_NEW_SINCE), null, '判定できないので null');
  assert.equal(isRecentLicense('令和7年4月1日', DEFAULT_NEW_SINCE), null);
});

test('新規フラグは根拠ごとに別の列へ立てる', () => {
  const newRow = row({ license_date: '2025-04-01' });
  const oldRow = row({ name: '老舗', license_date: '2021-06-01' });

  // 差分が手に入らない場合: 差分の列は 0 ではなく空（「新規でない」と言い切らない）
  const noDiff = buildSalesRow(newRow);
  assert.equal(noDiff.is_new_by_snapshot_diff, '');
  assert.equal(noDiff.is_new_guess_by_license_date, 1);
  assert.equal(noDiff.new_basis, BASIS_LICENSE_DATE_GUESS);

  // 差分が手に入る場合: 2つの根拠は別の列に立ち、new_basis で両方が読める
  const keys = new Set([recordKey(newRow)]);
  const both = buildSalesRow(newRow, { newKeys: keys });
  assert.equal(both.is_new_by_snapshot_diff, 1);
  assert.equal(both.is_new_guess_by_license_date, 1);
  assert.equal(both.new_basis, `${BASIS_SNAPSHOT_DIFF}+${BASIS_LICENSE_DATE_GUESS}`);

  // 差分にあるが許可年月日は古い（旧制度からの移行ではなく、実際に今週増えた行）
  const diffOnly = buildSalesRow(oldRow, { newKeys: new Set([recordKey(oldRow)]) });
  assert.equal(diffOnly.is_new_by_snapshot_diff, 1);
  assert.equal(diffOnly.is_new_guess_by_license_date, 0);
  assert.equal(diffOnly.new_basis, BASIS_SNAPSHOT_DIFF);

  // 差分にも無く許可年月日も古い
  const neither = buildSalesRow(oldRow, { newKeys: keys });
  assert.equal(neither.is_new_by_snapshot_diff, 0);
  assert.equal(neither.is_new_guess_by_license_date, 0);
  assert.equal(neither.new_basis, '');
});

test('推定でしかない根拠は列名で断る', () => {
  // 「許可年月日が新しい」は蓋然性が高いだけで、新規出店の証明ではない。
  // 列名に guess を残しておかないと、受け取った側が確定情報として扱ってしまう。
  assert.ok(SALES_CSV_COLUMNS.includes('is_new_guess_by_license_date'));
  assert.ok(SALES_CSV_COLUMNS.includes('is_new_by_snapshot_diff'));
  assert.ok(SALES_CSV_COLUMNS.includes('new_basis'));
  // 罠3の検証用に、住所から切り出した city と配信CSV の city を並べて出す
  assert.ok(SALES_CSV_COLUMNS.includes('city'));
  assert.ok(SALES_CSV_COLUMNS.includes('city_csv'));
});

test('parseNewKeys: 1行1キー・空行とコメントは無視する', () => {
  const keys = parseNewKeys('# 2026-09-14 の差分\n\nA\tB\tC\tD\nE\tF\tG\tH\r\n');
  assert.equal(keys.size, 2);
  assert.ok(keys.has('A\tB\tC\tD'));
  assert.ok(keys.has('E\tF\tG\tH'));
});

// --- 行の選択と統計 -----------------------------------------------------------
test('selectSalesRows: 飲食店営業だけを残し、落とした件数を残す', () => {
  const rows = [
    row({ name: '飲食A' }),
    row({ name: '菓子B', business_type: '⑪ 菓子製造業' }),
    row({ name: '廃業C', expire_date: '2025-03-31' }),
    row({ name: '飲食D', business_type: '飲食店営業(1)一般食堂・レストラン等' }),
  ];
  const { rows: out, stats } = selectSalesRows(rows, { asOf: '2026-09-19' });

  assert.deepEqual(out.map((r) => r.name), ['飲食A', '飲食D']);
  assert.equal(stats.rowsIn, 4);
  assert.equal(stats.notRestaurant, 1);
  assert.equal(stats.expired, 1);
  assert.equal(stats.restaurant, 2);
  assert.equal(stats.rowsOut, 2);
});

test('selectSalesRows: 罠3（市区町村名列が公開元の住所）を件数で検出する', () => {
  const { rows: out, stats } = selectSalesRows(
    [row(), row({ name: '宇治店', address: '京都府宇治市宇治琵琶33' })],
    { asOf: '2026-09-19' },
  );

  // 採用するのは住所から切り出した市区町村。配信CSV の値は city_csv に残す。
  assert.deepEqual(out.map((r) => r.city), ['南丹市', '宇治市']);
  assert.deepEqual(out.map((r) => r.city_csv), ['京都市', '京都市']);
  assert.equal(stats.cityFromAddress, 2);
  assert.equal(stats.cityMismatch, 2, '2行とも配信CSV の city と食い違う');
});

test('selectSalesRows: 市区町村を切り出せない行は配信CSV の値に戻す', () => {
  const { rows: out, stats } = selectSalesRows(
    [row({ address: '市内一円', city: '福知山市' })],
    { asOf: '2026-09-19' },
  );
  assert.equal(out[0].city, '福知山市');
  assert.equal(stats.cityFromAddress, 0);
});

test('selectSalesRows: 都道府県・新規・電話番号での絞り込み', () => {
  const rows = [
    row({ name: '京都新規' }),
    row({ name: '京都老舗', license_date: '2021-06-01' }),
    row({ name: '京都新規電話なし', phone: 'なし' }),
    row({ name: '大阪新規', prefecture: '大阪府', address: '大阪府大阪市北区梅田1' }),
  ];

  const kyoto = selectSalesRows(rows, { asOf: '2026-09-19', pref: '京都府' });
  assert.equal(kyoto.stats.prefSkipped, 1);
  assert.equal(kyoto.stats.rowsOut, 3);

  const onlyNew = selectSalesRows(rows, { asOf: '2026-09-19', pref: '京都府', onlyNew: true });
  assert.deepEqual(onlyNew.rows.map((r) => r.name), ['京都新規', '京都新規電話なし']);
  assert.equal(onlyNew.stats.droppedNotNew, 1);

  const withPhone = selectSalesRows(rows, { asOf: '2026-09-19', pref: '京都府', requirePhone: true });
  assert.deepEqual(withPhone.rows.map((r) => r.name), ['京都新規', '京都老舗']);
  assert.equal(withPhone.stats.droppedNoPhone, 1);
  assert.equal(withPhone.stats.withPhone, 2, '電話ありの件数は絞り込み前に数える');
});

test('selectSalesRows: 差分キーが無いときは新規判定を未判定のままにする', () => {
  const { rows: out, stats } = selectSalesRows([row()], { asOf: '2026-09-19' });
  assert.equal(out[0].is_new_by_snapshot_diff, '');
  assert.equal(stats.newByDiff, 0);
  assert.equal(stats.newByLicenseGuess, 1);
});

// --- 入力CSV の読み取り -------------------------------------------------------
const INPUT_COLUMNS = [
  'prefecture', 'city', 'city_raw', 'name', 'name_kana', 'business_type', 'address',
  'lat', 'lng', 'geocoding_level', 'phone', 'license_no', 'license_date', 'expire_date',
  'sources', 'licenses',
];

/** 配信CSV と同じ列構成の一時ファイルを書き出す。 */
function writeInputCsv(rows, { bom = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-list-test-'));
  const file = path.join(dir, 'in.csv');
  const cell = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const body = [INPUT_COLUMNS.join(','), ...rows.map((r) => INPUT_COLUMNS.map((c) => cell(r[c] ?? '')).join(','))];
  fs.writeFileSync(file, (bom ? '﻿' : '') + body.join('\n') + '\n');
  return file;
}

test('indexHeader: 配信CSV の列が欠けていたら止める', () => {
  const index = indexHeader(INPUT_COLUMNS);
  assert.equal(index.prefecture, 0);
  assert.equal(index.business_type, 5);
  // BOM 付きのヘッダーも読める
  assert.equal(indexHeader(['﻿prefecture', ...INPUT_COLUMNS.slice(1)]).prefecture, 0);
  // 列が足りない入力（タイル用の metadata を渡した等）はその場でエラーにする
  assert.throws(() => indexHeader(['name', 'address']), /必要な列がありません/);
});

test('配信CSV を読み込んで営業リストの行になる', () => {
  const file = writeInputCsv([
    row({ name: 'カフェ, "A"', phone: '０７５（１２３）４５６７' }),
    row({ name: '菓子B', business_type: '菓子製造業' }),
  ], { bom: true });

  const { rows: out, stats } = selectSalesRows(readFacilityRows(file), { asOf: '2026-09-19' });

  assert.equal(stats.rowsIn, 2);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'カフェ, "A"', '引用符・カンマ入りのセルが元に戻る');
  assert.equal(out[0].city, '南丹市');
  assert.equal(out[0].phone, '075-123-4567');
});

// --- 引数 ---------------------------------------------------------------------
test('parseArgs: 既定値と --key=value / --key value の両形式', () => {
  const def = parseArgs([], { today: '2026-09-19' });
  assert.equal(def.in, 'api/facilities-all.csv');
  assert.equal(def.out, 'analysis/sales-list.csv');
  assert.equal(def.newKeys, null);
  assert.equal(def.newSince, DEFAULT_NEW_SINCE);
  assert.equal(def.asOf, '2026-09-19');
  assert.equal(def.onlyNew, false);

  const opts = parseArgs(
    ['--in', 'api/prefectures/26.csv', '--out=analysis/kyoto.csv', '--pref', '京都府',
      '--new-keys', 'analysis/new-keys.txt', '--only-new', '--require-phone'],
    { today: '2026-09-19' },
  );
  assert.equal(opts.in, 'api/prefectures/26.csv');
  assert.equal(opts.out, 'analysis/kyoto.csv');
  assert.equal(opts.pref, '京都府');
  assert.equal(opts.newKeys, 'analysis/new-keys.txt');
  assert.equal(opts.onlyNew, true);
  assert.equal(opts.requirePhone, true);
});

test('parseArgs: 打ち間違いと不正な日付はエラーにする', () => {
  // 黙って無視すると、絞り込みが効かない全件リストが出てしまう
  assert.throws(() => parseArgs(['--onlynew']), /不明なオプション/);
  assert.throws(() => parseArgs(['--in']), /値がありません/);
  assert.throws(() => parseArgs(['--as-of', '2026/09/19']), /YYYY-MM-DD/);
  assert.throws(() => parseArgs(['--new-since', '令和6年6月1日']), /YYYY-MM-DD/);
});

console.log(`\n✅ 営業用リスト テスト ${passed}件に合格`);

// 取得(acquire): ソース定義に従ってファイルを取得し .cache に保存する。
// 取得方法は5種: ckan / get / post / resolve / i2fasglob。
// 一過性の失敗はリトライ、恒久的な失敗(4xx)は即失敗。ZIP は中の csv/xlsx/xls を展開する。

import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// bot 対策で User-Agent 等を求めるサーバがあるため、常識的なヘッダを付ける。
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; japan-food-facilities/1.0; +https://github.com/gl20percentclub/japan-food-facilities)',
  'Accept-Language': 'ja,en;q=0.8',
  Accept: '*/*',
};

// CKAN API: リソース情報（URL・フォーマット）を取得。403/429/5xx は指数バックオフでリトライ。
export async function fetchCkanResourceInfo(ckanBase, resourceId, attempt = 0) {
  const url = `${ckanBase}/api/3/action/resource_show?id=${encodeURIComponent(resourceId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(1000 * 2 ** attempt);
      return fetchCkanResourceInfo(ckanBase, resourceId, attempt + 1);
    }
    throw new Error(`resource_show failed: ${res.status} ${res.statusText} (${resourceId})`);
  }
  const json = await res.json();
  if (!json.success) throw new Error(`resource_show returned success=false (${resourceId})`);
  return json.result; // { url, format, ... }
}

// CKAN resource_show の結果から、実際にダウンロードすべきURLを決める。
// 通常は result.url をそのまま使うが、datastore 専用リソース（ファイルストアに実体が無く、
// CKAN の datastore テーブルにしかデータが無いもの）は result.url が空文字になる。
// この場合 datastore_active:true が立っているので、それを条件に
// `<ckanBase>/datastore/dump/<resourceId>` へフォールバックする（url が空というだけで
// 分岐すると、取得失敗など別の理由で空になったケースを誤って datastore 扱いしてしまうため、
// 必ず datastore_active を見る）。どちらの条件にも当てはまらない場合は黙って諦めず例外を投げる。
export function resolveCkanDownloadUrl(ckanBase, resourceId, info) {
  if (info.url) return info.url;
  if (info.datastore_active) return `${ckanBase}/datastore/dump/${encodeURIComponent(resourceId)}`;
  throw new Error(`CKAN resource の url が空で datastore も無効です（フォールバック不可）: ${resourceId}`);
}

// キャッシュ済みファイルを拡張子から探す（dry-run で CKAN 問い合わせ・リンク解決を避けるため）。
// `key.ext` に加え、multi 取得の `key-0.ext` `key-1.ext` … も拾う。
function findCachedFiles(cacheDir, key) {
  const exts = ['csv', 'tsv', 'xlsx', 'xls'];
  const found = [];
  for (const ext of exts) {
    const p = path.join(cacheDir, `${key}.${ext}`);
    if (fs.existsSync(p)) found.push({ cachePath: p, format: ext });
  }
  for (let j = 0; ; j++) {
    const hit = exts
      .map((ext) => ({ cachePath: path.join(cacheDir, `${key}-${j}.${ext}`), format: ext }))
      .find((c) => fs.existsSync(c.cachePath));
    if (!hit) break;
    found.push(hit);
  }
  return found;
}

// HTTP GET/POST をリトライ付きで実行し、本文を ArrayBuffer で返す。
// 一過性の失敗（ネットワーク例外・5xx・429）は指数バックオフで再試行、4xx（429除く）は即失敗。
export async function fetchWithRetry(url, opts = {}, { retries = 3, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.log(`    リトライ ${attempt}/${retries}（${delay}ms 待機）: ${lastErr.message}`);
      await sleep(delay);
    }
    try {
      const res = await fetch(url, opts);
      if (res.ok) return await res.arrayBuffer();
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const err = new Error(`ダウンロード失敗: ${res.status} ${res.statusText}`);
        err.permanent = true;
        throw err;
      }
      lastErr = new Error(`ダウンロード失敗: ${res.status} ${res.statusText}`);
    } catch (e) {
      if (e.permanent) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

// href/リンク文言中の基本的な HTML 実体参照を復元する（&amp; 等）。
function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// 候補文字列（href または リンク表示テキスト）から日付を抽出し、比較可能な数値に正規化する。
// 対応する表記（優先順に試す。先に一致したものを採用する）:
//   西暦+漢字   2026年3月(末現在)   -> 20260300（掲載ページの説明文に多い）
//   和暦(日付)  R080331 / r080331   -> 令和8年3月31日 = 20260331（区切りなし、年2桁固定）
//   和暦(年月)  R0803 / r0803       -> 令和8年3月     = 20260300
//   和暦(年)    R08 / R7 / r08      -> 令和8年 / 令和7年 = 20260000 / 20250000
//   西暦8桁     20260331            -> 20260331（14桁タイムスタンプの先頭8桁も拾う）
//   西暦6桁     202603              -> 20260300
//   西暦4桁     2026                -> 20260000
// 一致しなければ null。どちらの元号体系（'western'|'wareki'）で一致したかも返す
// （pickLatest で西暦と和暦が混在した候補を検出するために使う）。
export function extractDateToken(str) {
  const s = String(str);

  // 西暦+漢字（例: 「2026年3月末現在」）。リンク文言での日付表記はこの形が多いため最優先で試す。
  let m = s.match(/(19|20)\d{2}年(\d{1,2})月/);
  if (m) {
    const year = Number(m[0].match(/(19|20)\d{2}/)[0]);
    const month = Number(m[2]);
    return { era: 'western', value: year * 10000 + month * 100, raw: m[0] };
  }

  // 和暦「年月日まで」: R080331 / r080331（区切りなし、年は2桁固定・月日各2桁）
  m = s.match(/[Rr]0?(\d{1,2})(\d{2})(\d{2})(?!\d)/);
  if (m) {
    const year = 2018 + Number(m[1]); // 令和元年(R1) = 2019年
    const month = Number(m[2]);
    const day = Number(m[3]);
    return { era: 'wareki', value: year * 10000 + month * 100 + day, raw: m[0] };
  }

  // 和暦「年月まで」: R0803 / r0803
  m = s.match(/[Rr]0?(\d{1,2})(\d{2})(?!\d)/);
  if (m) {
    const year = 2018 + Number(m[1]);
    const month = Number(m[2]);
    return { era: 'wareki', value: year * 10000 + month * 100, raw: m[0] };
  }

  // 和暦「年のみ」: R08 / R7 / r08
  m = s.match(/[Rr]0?(\d{1,2})(?!\d)/);
  if (m) {
    const year = 2018 + Number(m[1]);
    return { era: 'wareki', value: year * 10000, raw: m[0] };
  }

  // 西暦8桁: 20260331
  m = s.match(/(?:19|20)\d{6}/);
  if (m) return { era: 'western', value: Number(m[0]), raw: m[0] };

  // 西暦6桁: 202603
  m = s.match(/(?:19|20)\d{4}(?!\d)/);
  if (m) return { era: 'western', value: Number(m[0]) * 100, raw: m[0] };

  // 西暦4桁: 2026
  m = s.match(/(?:19|20)\d{2}(?!\d)/);
  if (m) return { era: 'western', value: Number(m[0]) * 10000, raw: m[0] };

  return null;
}

// 候補 [{url, text}, ...] の中から「日付が最大のもの」を選ぶ（resolveLinkFromHtml の pickLatest 用）。
// 日付抽出は各候補について text を優先し、無ければ url を試す（掲載ページの説明文には
// 西暦の日付が書かれているがファイル名は和暦、ということがあるため。同一ソース内では
// text 側の表記が一貫していれば text 側だけで揃う）。
// 日付を抽出できない候補は比較対象から除外する（skipped で返す）。
// 比較対象になった候補の元号体系（西暦/和暦）が混在している場合は、桁数の解釈が変わり
// 単純比較できないため例外を投げる。比較対象が1件も無い場合も例外を投げる
// （「選べなかったときに黙って先頭を返す」を避けるため）。
export function selectLatestCandidate(candidates) {
  const dated = [];
  const skipped = [];
  for (const c of candidates) {
    const token = extractDateToken(c.text) || extractDateToken(c.url);
    if (!token) {
      skipped.push(c);
      continue;
    }
    dated.push({ ...c, token });
  }
  if (dated.length === 0) {
    throw new Error(
      `pickLatest: 候補 ${candidates.length}件のいずれからも日付を抽出できませんでした: ` +
        `[${candidates.map((c) => c.text || c.url).join(', ')}]`,
    );
  }
  const eras = new Set(dated.map((d) => d.token.era));
  if (eras.size > 1) {
    throw new Error(
      `pickLatest: 候補間で日付表記（西暦/和暦）が混在しており比較できません: ` +
        dated.map((d) => `${d.token.raw}(${d.token.era})`).join(', '),
    );
  }
  dated.sort((x, y) => y.token.value - x.token.value);
  return { winner: dated[0], skipped };
}

// HTML から、条件に一致する <a href> を解決する。
//   pattern      リンク表示テキストにマッチさせる正規表現文字列（任意）
//   hrefPattern  href にマッチさせる正規表現文字列（任意。ファイル名で全件/差分を区別する場合に使う）
//   format       href の拡張子で絞り込む（'xlsx' 等。任意）
//   baseUrl      相対 href を絶対化する基準
//   pickLatest   true のとき、複数一致した場合に DOM順の先頭ではなく「日付が最大の候補」を選ぶ
//                （日付の抽出は extractDateToken / selectLatestCandidate を参照）
// 返り値: { url, text, count, all }（一致0件なら null）。
//   url/text は通常は先頭一致、pickLatest 指定時は日付最大の候補。all は全一致の [{url,text}]（multi 取得に使う）。
export function resolveLinkFromHtml(htmlText, { pattern, hrefPattern, format, baseUrl, pickLatest } = {}) {
  const textRe = pattern ? new RegExp(pattern, 'i') : null;
  const hrefRe = hrefPattern ? new RegExp(hrefPattern, 'i') : null;
  const extRe = format ? new RegExp(`\\.${format}(?:$|[?#])`, 'i') : null;
  const anchorRe = /<a\b[^>]*\shref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const candidates = [];
  let m;
  while ((m = anchorRe.exec(htmlText))) {
    const href = decodeHtmlEntities(m[1]);
    const text = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (extRe && !extRe.test(href)) continue;
    if (textRe && !textRe.test(text)) continue;
    if (hrefRe && !hrefRe.test(href)) continue;
    candidates.push({ href, text });
  }
  if (candidates.length === 0) return null;
  const toUrl = (c) => ({ url: baseUrl ? new URL(c.href, baseUrl).toString() : c.href, text: c.text });
  const all = candidates.map(toUrl);

  // pickLatest: 既定の「先頭を採用」ではなく、日付が最大の候補を採用する。
  // 既定の挙動（pickLatest 未指定）はここに一切触れないため変わらない。
  if (pickLatest) {
    const { winner, skipped } = selectLatestCandidate(all);
    if (skipped.length > 0) {
      console.log(
        `  ⚠ pickLatest: 日付を抽出できない候補 ${skipped.length}件を比較対象から除外: ` +
          `${skipped.map((s) => s.text || s.url).join(', ')}`,
      );
    }
    return { url: winner.url, text: winner.text, count: candidates.length, all };
  }

  return { ...all[0], count: candidates.length, all };
}

// ZIP バイト列から対象の csv/xlsx/xls を取り出す。
async function extractFromZip(zipBuf, entryPattern) {
  const { unzipSync } = await import('fflate');
  const files = unzipSync(new Uint8Array(zipBuf));
  const names = Object.keys(files).filter((n) => !n.endsWith('/'));
  const re = entryPattern ? new RegExp(entryPattern, 'i') : /\.(csv|xlsx|xls)$/i;
  const name = names.find((n) => re.test(n)) || names.find((n) => /\.(csv|xlsx|xls)$/i.test(n));
  if (!name) throw new Error(`ZIP 内に csv/xlsx/xls が見つかりません: [${names.join(', ')}]`);
  const mm = name.toLowerCase().match(/\.(csv|xlsx|xls)$/);
  return { buf: Buffer.from(files[name]), format: mm[1] };
}

// ソースが取得すべきファイル群を返す。単一 url でも複数 urls[] でも扱える。
// 返り値: [{ cachePath, format }, ...]（複数ファイルはパース後に結合される）
export async function acquire(source, { cacheDir, dryRun = false } = {}) {
  const a = source.acquire;

  // i2fasglob: scripts/tools/fetch-i2fas.js が取得した .cache/i2fas/*.csv をまとめて読む。
  if (a.type === 'i2fasglob') {
    const dir = path.join(cacheDir, 'i2fas');
    if (!fs.existsSync(dir)) throw new Error(`.cache/i2fas がありません（先に node scripts/tools/fetch-i2fas.js を実行）`);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv')).sort();
    if (files.length === 0) throw new Error('.cache/i2fas に CSV がありません');
    console.log(`  i2fas キャッシュ ${files.length} ファイルを使用`);
    return files.map((f) => ({ cachePath: path.join(dir, f), format: 'csv' }));
  }

  // ckan: resourceId は単一文字列でも配列でもよい（配列なら1エントリで複数リソースを結合して取得する。
  // 例: 福井県は776・777の2 resourceId を1ソースとして結合する）。
  const ckanResourceIds = a.type === 'ckan' ? (Array.isArray(a.resourceId) ? a.resourceId : [a.resourceId]) : null;
  const urls = a.urls || (a.url ? [a.url] : ckanResourceIds ? ckanResourceIds.map(() => null) : [null]); // ckan は url なしで resourceId 解決
  const results = [];

  // 1URLを取得して .cache に保存し {cachePath, format} を返す。
  // 形式はヒント fmt を優先し、無ければ拡張子から推定。zip は中身を展開する。
  async function downloadOne(downloadUrl, key, fmt) {
    let format = (fmt || '').toLowerCase();
    if (!format) {
      const mm = String(downloadUrl).toLowerCase().match(/\.(csv|tsv|txt|xlsx|xls|zip)(?:$|\?)/);
      format = mm ? mm[1] : 'csv';
    }
    if (format === 'txt') format = 'tsv'; // LinkData 等の tab 区切り txt

    const fetchOpts = { headers: { ...DEFAULT_HEADERS } };
    if (a.type === 'post') {
      fetchOpts.method = 'POST';
      fetchOpts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      fetchOpts.body = new URLSearchParams(a.body || {}).toString();
    }

    console.log(`  ダウンロード中: ${downloadUrl}`);
    let buf = Buffer.from(await fetchWithRetry(downloadUrl, fetchOpts));

    // format: 'zip' のとき、中の csv/xlsx/xls を取り出す（acquire.zipEntry で対象指定可）。
    if (format === 'zip') {
      const extracted = await extractFromZip(buf, a.zipEntry);
      buf = extracted.buf;
      format = extracted.format;
    }

    const ext = format === 'xlsx' ? 'xlsx' : format === 'xls' ? 'xls' : format === 'tsv' ? 'tsv' : 'csv';
    const cachePath = path.join(cacheDir, `${key}.${ext}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath, buf);
    console.log(`  キャッシュに保存: ${cachePath} (${buf.length} bytes)`);
    return { cachePath, format };
  }

  for (let i = 0; i < urls.length; i++) {
    const suffix = urls.length > 1 ? `-${i}` : '';
    const key = `${source.key}${suffix}`;

    // dry-run はキャッシュのみ使用。CKAN 問い合わせをせず拡張子からファイルを特定する。
    if (dryRun) {
      const hits = findCachedFiles(cacheDir, key);
      if (hits.length === 0) throw new Error(`--dry-run ですがキャッシュが存在しません: ${key}`);
      for (const hit of hits) {
        console.log(`  [dry-run] キャッシュを使用: ${hit.cachePath}`);
        results.push(hit);
      }
      continue;
    }

    let downloadUrl = urls[i];
    const format = (a.format || '').toLowerCase();

    if (a.type === 'ckan') {
      const resourceId = ckanResourceIds[i];
      const info = await fetchCkanResourceInfo(a.ckanBase, resourceId);
      downloadUrl = resolveCkanDownloadUrl(a.ckanBase, resourceId, info);
      results.push(await downloadOne(downloadUrl, key, format || (info.format || '').toLowerCase()));
      continue;
    }

    // resolve: 掲載ページ(pageUrl)を取得し、最新のダウンロードURLを解決する（日付でURLが変わる自治体向け）。
    //   linkPattern  <a> の表示テキストにマッチ / hrefPattern  href にマッチ（ファイル名で全件/差分を区別）
    //   multi:true   一致した全リンクを取得（全件が複数ファイルに分割された自治体）
    //   hrefScan:true <a> に限らず生HTML中で hrefPattern に一致するURL/パスを拾う
    //                 （<button value="..."> 等 アンカー以外にURLが埋まっているページ向け）
    //   pickLatest:true 複数一致したとき DOM順の先頭ではなく日付が最大の候補を採用する
    //                 （同一ページに複数年度のファイルが並存し、DOM順への依存が危険な自治体向け。
    //                 日付抽出・比較の仕様は extractDateToken / selectLatestCandidate を参照）
    if (a.type === 'resolve') {
      console.log(`  リンク解決中: ${a.pageUrl}`);
      const html = Buffer.from(await fetchWithRetry(a.pageUrl, { headers: { ...DEFAULT_HEADERS } })).toString('utf-8');
      const linkFmt = (a.linkFormat || format || '').toLowerCase();
      let resolvedUrls;

      if (a.hrefScan) {
        if (!a.hrefPattern) throw new Error(`resolve hrefScan には hrefPattern が必要です: ${source.key}`);
        const re = new RegExp(a.hrefPattern, 'ig');
        const seen = new Set();
        let mm;
        while ((mm = re.exec(html))) seen.add(new URL(mm[0], a.pageUrl).toString());
        resolvedUrls = [...seen];
        if (resolvedUrls.length === 0) {
          throw new Error(`リンク解決に失敗: ${a.pageUrl} に hrefPattern「${a.hrefPattern}」に一致するURLがありません`);
        }
        console.log(`  リンク解決(hrefScan): ${resolvedUrls.length}件`);
      } else {
        const hit = resolveLinkFromHtml(html, {
          pattern: a.linkPattern,
          hrefPattern: a.hrefPattern,
          format: linkFmt,
          baseUrl: a.pageUrl,
          pickLatest: a.pickLatest,
        });
        if (!hit) {
          throw new Error(
            `リンク解決に失敗: ${a.pageUrl} に「${a.linkPattern || a.hrefPattern || '(指定なし)'}」に一致する` +
              `${linkFmt ? ` .${linkFmt}` : ''} リンクが見つかりません`,
          );
        }
        resolvedUrls = a.multi ? hit.all.map((h) => h.url) : [hit.url];
        if (a.multi) console.log(`  リンク解決: ${hit.count}件を取得`);
        else if (hit.count > 1 && a.pickLatest) {
          // pickLatest: DOM順の先頭ではなく日付最大の候補を採用したことが分かるようログを変える。
          console.log(`  リンク解決(pickLatest): ${hit.count}件中、日付が最大のものを採用: 「${hit.text}」 -> ${hit.url}`);
        } else {
          if (hit.count > 1) console.log(`  ⚠ ${hit.count}件一致。先頭を採用: 「${hit.text}」`);
          console.log(`  リンク解決: 「${hit.text}」 -> ${hit.url}`);
        }
      }

      if (a.multi || a.hrefScan) {
        for (let j = 0; j < resolvedUrls.length; j++) {
          results.push(await downloadOne(resolvedUrls[j], `${key}-${j}`, format));
        }
        continue;
      }
      downloadUrl = resolvedUrls[0];
    }

    results.push(await downloadOne(downloadUrl, key, format));
  }
  return results;
}

// クロール結果のサマリ集計・前回結果との比較（純粋関数のみ）。
//
// 目的: 「壊れても誰も気づけない」問題への対策。本番クロールは
// --allow-empty-sources がデフォルトで有効（japan-facilities-crawler 側の
// entrypoint.sh）なため、取得0件のソースがあってもクロール自体は成功扱いになり、
// ログの warning に埋もれて人には届かない（実例: PR #80 で15ソース・約13万件が
// 数週間気づかれず欠落）。ここで検知した「問題」は notify-slack.js で Slack に通知する。
//
// 「問題」は3種類:
//   zero  取得0件（--allow-empty-sources で握りつぶされている分）
//   error 取得/パースで例外が発生し処理をスキップしたソース
//   drop  前回のクロール結果より件数が大きく減ったソース（後述の閾値で判定）
//
// drop の閾値についての根拠:
//   東京都保健医療局のように新URLも旧URLも200を返す「404が出ない陳腐化」は、
//   0件にもエラーにもならず curl の死活監視では原理的に検出できない
//   （commander/20260822-1058-jff-issue93/workers/2/REPORT.md の調査で判明）。
//   これを拾うには前回件数との比較が唯一の手段。
//   閾値は「30%以上の減少」かつ「前回20件以上」とした:
//     - 30%: 自治体データは廃業等で自然減することがあるため、数%の減少まで拾うと
//       ノイズ（誤検知）が多くなる。一方で一部データ欠落（例: 15ソース中の一部URL
//       だけ404化）は数十%単位で減ることが多く、30%なら実害のある欠落を取り逃さず
//       自然減のノイズも避けられる、という経験則上のバランス値。
//     - 前回20件以上: 母数が小さいソース（数件〜十数件）は1〜2件の増減で
//       比率が跳ね上がり誤検知になりやすいため、判定対象から除外する。
export const DEFAULT_DROP_THRESHOLD = 0.3;
export const DEFAULT_DROP_MIN_PREVIOUS = 20;

/**
 * 各ソースの取得結果を { key, name, count, error } の配列にまとめる。
 * @param {Array} sources config/sources.yaml の sources 配列（フィルタ後）
 * @param {Map<string, number>} keptBySource source.key -> 取り込めた施設数
 * @param {Map<string, string>} errorBySource source.key -> 例外メッセージ（例外が無ければ未登録）
 * @returns {Array<{key: string, name: string, count: number, error: string|null}>}
 */
export function buildSourceSummary(sources, keptBySource, errorBySource) {
  return sources.map((s) => ({
    key: s.key,
    name: s.source,
    count: keptBySource.get(s.key) || 0,
    error: (errorBySource && errorBySource.get(s.key)) || null,
  }));
}

/**
 * 今回のサマリと前回のサマリを比較し、「問題」の一覧を返す。
 * previousByKey が無い（初回実行）場合は drop 判定をスキップする（誤検知防止）。
 * @param {Array<{key,name,count,error}>} summary 今回のサマリ（buildSourceSummary の出力）
 * @param {Map<string, {count: number}>|null} previousByKey 前回のサマリ（key -> {count}）
 * @param {{dropThreshold?: number, dropMinPrevious?: number}} [options]
 * @returns {Array<{key,name,type:'zero'|'error'|'drop',count,previousCount,dropRatio,error}>}
 */
export function detectProblems(summary, previousByKey, options = {}) {
  const dropThreshold = options.dropThreshold ?? DEFAULT_DROP_THRESHOLD;
  const dropMinPrevious = options.dropMinPrevious ?? DEFAULT_DROP_MIN_PREVIOUS;
  const problems = [];

  for (const entry of summary) {
    // エラーで処理をスキップしたソース（HTTPエラー・パース失敗など）を最優先で報告する。
    if (entry.error) {
      problems.push({
        key: entry.key,
        name: entry.name,
        type: 'error',
        count: entry.count,
        previousCount: null,
        dropRatio: null,
        error: entry.error,
      });
      continue;
    }
    // 取得0件（--allow-empty-sources で握りつぶされている分）。
    if (entry.count === 0) {
      problems.push({
        key: entry.key,
        name: entry.name,
        type: 'zero',
        count: 0,
        previousCount: previousByKey?.get(entry.key)?.count ?? null,
        dropRatio: null,
        error: null,
      });
      continue;
    }
    // 前回結果との比較（前回サマリが無い＝初回実行のときはスキップ）。
    const previous = previousByKey?.get(entry.key);
    if (!previous || previous.count < dropMinPrevious) continue;
    const dropRatio = (previous.count - entry.count) / previous.count;
    if (dropRatio >= dropThreshold) {
      problems.push({
        key: entry.key,
        name: entry.name,
        type: 'drop',
        count: entry.count,
        previousCount: previous.count,
        dropRatio,
        error: null,
      });
    }
  }
  return problems;
}

/**
 * 今回のサマリを次回比較用に永続化してよいかどうかを判定する。
 * --only（部分実行）はソース全体を処理していないため、処理対象外のソースが
 * 「前回結果が消えた」ように見えてしまう。--dry-run はローカル動作確認用で
 * 本番の実測件数ではないため、いずれも本番比較の基準（ベースライン）を
 * 汚さないよう保存をスキップする。
 * @param {{dryRun: boolean, only: Set|null}} opts
 * @returns {boolean}
 */
export function shouldPersistSummary({ dryRun, only }) {
  return !dryRun && !only;
}

/**
 * サマリ配列を previousByKey（Map）と同じ形の Map に変換する。
 * detectProblems・保存済みJSONの読み込み後の変換に使う。
 * @param {Array<{key,count}>} summary
 * @returns {Map<string, {count: number}>}
 */
export function summaryToMap(summary) {
  return new Map(summary.map((s) => [s.key, { count: s.count }]));
}

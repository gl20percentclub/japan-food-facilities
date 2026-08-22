// クロール失敗時の Slack 通知。
//
// メッセージ整形（buildSlackMessage）は純粋関数として切り出し、固定入力でテストする。
// 送信（sendSlackNotification）だけがネットワークI/Oを持つ副作用関数で、
//   - Webhook URL が未設定なら何もせず正常終了する（ローカル開発・CI・テストで落ちない）
//   - 送信自体が失敗しても例外を投げない（通知は補助機能。クロール本体を落とす理由にしない）
// という2点を必ず守る。Webhook URL はコード・リポジトリに書かず、必ず環境変数
// （既定 SLACK_WEBHOOK_URL）から読む。

/**
 * 問題の種別ごとに、人が見て次のアクションが分かる1行を作る。
 * @param {{key,name,type,count,previousCount,dropRatio,error}} p detectProblems の1要素
 * @returns {string} Slack mrkdwn 形式の1行
 */
function formatProblemLine(p) {
  const label = `*${p.key}*（${p.name}）`;
  if (p.type === 'error') {
    return `:red_circle: ${label} — 取得エラー: ${p.error}`;
  }
  if (p.type === 'zero') {
    const prev = p.previousCount != null ? `（前回 ${p.previousCount}件）` : '';
    return `:red_circle: ${label} — 取得0件${prev}`;
  }
  // type === 'drop'
  const pct = Math.round(p.dropRatio * 100);
  return `:large_orange_diamond: ${label} — 前回 ${p.previousCount}件 → 今回 ${p.count}件（${pct}%減）`;
}

/**
 * 検知した問題一覧から Slack Incoming Webhook 用のペイロードを組み立てる（純粋関数）。
 * @param {Array} problems detectProblems の返り値
 * @param {{totalSources: number, updatedAt: string}} meta 対象ソース総数・実行時刻（ISO文字列）
 * @returns {{text: string, blocks: Array}|null} 問題が0件なら null（通知不要）
 */
export function buildSlackMessage(problems, meta) {
  if (!problems || problems.length === 0) return null;

  const summaryText = `⚠️ Japan Food Facilities クロールで問題を検知（${problems.length}/${meta.totalSources}ソース）`;
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '⚠️ クロール警告: japan-food-facilities' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `対象 ${meta.totalSources} ソース中 *${problems.length}件* で問題を検知しました（${meta.updatedAt}）`,
      },
    },
    { type: 'divider' },
    // Slack section の text は最大3000文字。問題が大量にある場合に備え、
    // 1メッセージあたり最大20件までに絞り、残数を末尾に注記する。
    ...problems.slice(0, 20).map((p) => ({
      type: 'section',
      text: { type: 'mrkdwn', text: formatProblemLine(p) },
    })),
    ...(problems.length > 20
      ? [{ type: 'section', text: { type: 'mrkdwn', text: `…他 ${problems.length - 20}件` } }]
      : []),
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '次のアクション: config/sources.yaml の該当ソースの取得元URL・CKAN resourceId が変わっていないか確認してください。',
        },
      ],
    },
  ];

  return { text: summaryText, blocks };
}

/**
 * Slack Incoming Webhook にメッセージを送信する。
 * webhookUrl が無ければ何もせず { ok: true, skipped: true } を返す
 * （環境変数未設定時にローカル開発・CI・テストを落とさないため）。
 * 送信自体が失敗しても例外は投げず { ok: false, error } を返す
 * （通知の失敗でクロール全体を止めないため）。
 * @param {{text: string, blocks: Array}} payload buildSlackMessage の返り値
 * @param {{webhookUrl?: string, fetchImpl?: Function, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, skipped?: boolean, status?: number, error?: string}>}
 */
export async function sendSlackNotification(payload, options = {}) {
  const webhookUrl = options.webhookUrl ?? process.env.SLACK_WEBHOOK_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10000;

  if (!webhookUrl) return { ok: true, skipped: true };
  if (!payload) return { ok: true, skipped: true };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `Slack Webhook failed: ${res.status} ${res.statusText}` };
    }
    return { ok: true };
  } catch (e) {
    // ネットワーク例外・タイムアウトも含め、ここで必ず握りつぶす。
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

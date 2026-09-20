// ---------------------------------------------------------------------------
// Google アナリティクス 4（GA4）の測定タグ。
//
// 各ページから <script src="./analytics.js"></script> で読み込む。測定タグを
// ページごとにコピーせず1ファイルに集約しているのは、測定 ID の差し替えを
// 1 か所で済ませるため（ページを追加するたびに書き忘れる事故を防ぐ）。
//
// 公開リポジトリのため測定 ID は直書きになるが、GA4 の測定 ID は秘密情報ではない。
// 「どのプロパティへ計測ヒットを送るか」を示す送信先の識別子であり、これ単体で
// レポートを閲覧したりデータを読み出したりはできない（閲覧には Google アカウントの
// 権限が必要）。差し替え手順とこの方針は docs/ANALYTICS.md に書いてある。
//
// 送信する情報・送信先・利用目的・オプトアウト方法は site/privacy.html で公表して
// いる（電気通信事業法の外部送信規律・第27条の12）。ここを変更して送信内容が
// 変わる場合は、privacy.html の記載も必ず合わせて更新すること。
// ---------------------------------------------------------------------------
(function () {
  'use strict';

  // GA4 の測定 ID。プロパティ発行後、この 1 行だけを実際の ID へ差し替える。
  // 未発行のあいだはプレースホルダのままにしておく（下のガードで送信しない）。
  var MEASUREMENT_ID = 'G-2EL4MB98BL';

  // 差し替え前のプレースホルダ。実 ID と同じ形をしているため、正規表現だけでは
  // 判別できない。値そのものを突き合わせて弾く。
  var PLACEHOLDER_ID = 'G-XXXXXXXXXX';

  // 測定 ID が未設定・不正な形式のあいだは Google へ一切リクエストを送らない。
  // 存在しないプロパティへ計測ヒットを飛ばしても集計には使えず、閲覧者の情報を
  // 無意味に外部送信することになるだけなので、発火自体を止める。
  if (MEASUREMENT_ID === PLACEHOLDER_ID || !/^G-[A-Z0-9]{6,}$/.test(MEASUREMENT_ID)) return;

  // gtag.js 本体を非同期で読み込む。ページの描画をブロックさせない。
  var tag = document.createElement('script');
  tag.async = true;
  tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(MEASUREMENT_ID);
  document.head.appendChild(tag);

  // gtag.js が読み込まれる前に積んだ命令も、dataLayer 経由で後から処理される。
  window.dataLayer = window.dataLayer || [];
  /** gtag.js の標準ヘルパー。引数をそのまま dataLayer へ積む。 */
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  gtag('js', new Date());
  gtag('config', MEASUREMENT_ID, {
    // 広告目的の機能は使わない。アクセス状況の把握だけが目的であり、
    // 送信する情報を必要以上に増やさないため明示的に無効化する。
    // （privacy.html に「広告配信の目的では利用しません」と記載している根拠）
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
})();

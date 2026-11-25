// DLALL（設計書 `2026-11-24-beaksight-job-artifacts-download-all-design.md` 2 章）: 「できたファイル」の一覧の全部を、一覧の順に 1 つずつ
// ダウンロードする処理。取りに行く処理は持たない（設計変更履歴 2026-11-24 の 2 行目）: 各ファイルの今のリンクと同じ `href` の `a[download]` を、
// 一覧の順に押す（ブラウザのダウンロードの仕組みが 1 つずつ保存する。秒の待ちを置かない）。押す口を差し込む（画面はリンクを押す口、テストは偽の口）。

/** 一覧の順に、各 `href` のダウンロードのリンクを 1 回ずつ押す。 */
export const clickDownloadLinksInOrder = (hrefs: readonly string[], clickLink: (href: string) => void): void => {
  for (const href of hrefs) {
    clickLink(href);
  }
};

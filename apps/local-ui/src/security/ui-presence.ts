/**
 * UI-close（設計書 `doc/design/2026-10-19-beaksight-ui-close-stops-server-design.md` の 2 章）: 管理画面のページが、画面のサーバへ送る知らせの口と
 * 間隔と猶予（唯一の owner）。ページ（`components/UiPresence.tsx`）と、起動の部品（`launcher/presence.ts`、`launcher/serve.ts`）が使う。
 * - 生きている知らせ（`UI_PRESENCE_ALIVE_PATH`）: ページは、開いている間、`UI_PRESENCE_INTERVAL_MS` ごとに送る。
 * - 閉じたときの知らせ（`UI_PRESENCE_CLOSED_PATH`）: ページを閉じるとき（`pagehide`）に `navigator.sendBeacon` で送る。
 * - どちらも POST で、ページの ID（`UI_PRESENCE_PAGE_PARAMETER`。読み込みごとの乱数）を query に付ける。要求の守り（token の cookie、Host）の後に、
 *   同じ Origin の確かめを掛ける。状態を変えるのは、止めるかの判定だけ（管理データを書かない）。
 * - 画面のサーバは、ページが一度は知らせを送り、どのページも開いていない（閉じた知らせの後は `UI_PRESENCE_CLOSED_GRACE_MS`、知らせが途絶えたときは
 *   `UI_PRESENCE_SILENCE_LIMIT_MS`）とき、動いているジョブがなければ止まる。途絶えの上限は、隠れたタブの timer がブラウザに 1 分ごとに間引かれても
 *   止めない長さにする。
 * 守りの部品と同じく Node の型の除去で動くので、このファイルは消せる型の書き方だけを使い、ほかのモジュールを import しない。
 */

/** 生きている知らせの口。 */
export const UI_PRESENCE_ALIVE_PATH = '/_presence/alive';

/** 閉じたときの知らせの口。 */
export const UI_PRESENCE_CLOSED_PATH = '/_presence/closed';

/** ページの ID を渡す query の名前。 */
export const UI_PRESENCE_PAGE_PARAMETER = 'page';

/** ページの ID の形（英数字と `-`。長さの上限つき）。 */
export const UI_PRESENCE_PAGE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/u;

/** ページが生きている知らせを送る間隔（ms）。 */
export const UI_PRESENCE_INTERVAL_MS = 5_000;

/** 閉じたときの知らせの後、止めるまでの猶予（ms。読み込み直しは、この中で戻る）。 */
export const UI_PRESENCE_CLOSED_GRACE_MS = 15_000;

/** 生きている知らせが途絶えた後、そのページを閉じたと見なすまでの上限（ms。隠れたタブの間引きより長い）。 */
export const UI_PRESENCE_SILENCE_LIMIT_MS = 150_000;

/** 画面のサーバが、止めるかを確かめ直す間隔（ms）。 */
export const UI_PRESENCE_CHECK_INTERVAL_MS = 1_000;

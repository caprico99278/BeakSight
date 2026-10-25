import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { BROWSER_CLOSE_TIMEOUT_MS } from '../../src/core/limits.js';

/**
 * 結合のテストで、並行の混雑の下で切れる本番の期限を延ばす、名前つきの混雑の倍率（TS-d。設計書
 * `2026-10-24-beaksight-test-suite-tiers-design.md` 3.4。DEF-063 の `cli-site-unavailable` の形を 1 か所に置いた）。
 * - 使い方: テストの Run に注入する期限（例: `crawl.resourceSettlingTimeoutMs`、Run Coordinator の `browserCloseTimeoutMs`、テストの待ちの上限）を、
 *   本番の名前つきの値にこの倍率を掛けて作る（`BROWSER_CLOSE_TIMEOUT_MS * LOADED_DEADLINE_FACTOR`）。本番の値そのものは変えない。
 * - 使ってよいのは、テストが確かめる判定に関わらない期限だけ（比べる相手と各場面の Run の片方だけが、混雑で期限切れになるのを防ぐなど）。
 *   確かめる判定に使う期限（サイトの不調の判定の読み込みの期限、注入した短い期限の内に返ること）には掛けない。
 * - 値の根拠（DEF-063。2026-10-10 の観測）: CPU のループ 8 本と `tests/integration` の並行の実行 2 本の混雑で、DOM の準備（既定 5 秒）と
 *   Browser を閉じる処理（既定 10 秒）が切れ、観測した止まり（約 19 秒など）に余裕を取って 6 倍にした。ほかのファイルに倍率を書き写さない。
 */
export const LOADED_DEADLINE_FACTOR = 6;

/**
 * DOM の準備を待つ期限（ms。`crawl.resourceSettlingTimeoutMs`。既定は 5,000）に混雑の倍率を掛けた値（30,000）。DEF-063 の観測: 既定の 5 秒が切れ、
 * ページが `DOM_READINESS_FAILED: DEADLINE_EXCEEDED` の PARTIAL になった回がある。DF-2b で `cli-site-unavailable` から、ほかの結合のテストと共有する
 * ためにここへ移した（Run の結果が COMPLETE であることを確かめ、DOM の準備の期限そのものを確かめないテストが使う）。
 */
export const LOADED_RESOURCE_SETTLING_TIMEOUT_MS = DEFAULT_CONFIG.crawl.resourceSettlingTimeoutMs * LOADED_DEADLINE_FACTOR;

/**
 * Browser を閉じる処理を待つ期限（ms。Run Coordinator の `browserCloseTimeoutMs`。既定は `BROWSER_CLOSE_TIMEOUT_MS` の 10,000）に混雑の倍率を
 * 掛けた値（60,000）。DEF-063 の観測: 強い混雑の下で既定の 10 秒が切れ、Run の理由 `UNHANDLED_FAILURE: browser-close:...` で Run が PARTIAL に
 * なった（ふだんは 1 秒未満で終わる）。DF-2b で `cli-site-unavailable` からここへ移した。
 */
export const LOADED_BROWSER_CLOSE_TIMEOUT_MS = BROWSER_CLOSE_TIMEOUT_MS * LOADED_DEADLINE_FACTOR;

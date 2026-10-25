/**
 * 回数を重ねるテスト（同じ場面を N 回くり返し、どの回も確かめるテスト）の回数の 1 か所（TS-b。設計書
 * `doc/design/2026-10-24-beaksight-test-suite-tiers-design.md` 3.2）。テストのファイルに回数を数で書かず、ここの値を `roundsOf` で読む
 * （Architecture Gate `tests/architecture/test-suites.test.ts`）。
 * - `full`: 全部の組（`BEAKSIGHT_TEST_TIER=full`。`test:full`・`verify`・`verify:all`）の値。TS-b の前の回数そのもの（安全の確かめの強さを落とさない）。
 * - `regular`: ふだんの組（省略）の値。1 以上で、競合の場面を少なくとも 1 回は通る数。止める経路が働いた証拠の確かめ（記録が残る回が 1 回以上）は、
 *   ふだんの組でも残る。回ごとに時間をずらす場面は、ずらし方の全部を 1 回ずつ通る数にする。
 * どちらの値を使うかは `test-run-environment.ts` の `isFullTestTier`（唯一の判定）で決める。
 */
import { isFullTestTier } from './test-run-environment.js';

/** 1 つの場面の回数（ふだんの組と全部の組）。 */
export interface TestRounds {
  readonly regular: number;
  readonly full: number;
}

/**
 * 場面ごとの回数。理由は値の横に書く（修正の前の調査の値は、それぞれのテストの説明にある）。
 * 2026-10-24 の測り（PRE42-TEST）では、証拠を確かめる場面（DEF-085・DEF-036）は、どの回にも証拠が残った（20/20、40/40、10/10）。
 */
export const TEST_ROUNDS = Object.freeze({
  /** DEF-060（`stale-lock-takeover-processes`）: 古いロックの場面ごとの回数。例の 20 → 3。1 回が 2 つの CLI の process で重い。 */
  staleLockTakeoverPerScenario: Object.freeze({ regular: 3, full: 20 }),
  /** DEF-085（`guard-popup-close-race`）の burst の場面。例の 20 → 3。 */
  popupCloseRaceBurst: Object.freeze({ regular: 3, full: 20 }),
  /** DEF-085（`guard-popup-close-race`）の storm の場面。例の 40 → 5。 */
  popupCloseRaceStorm: Object.freeze({ regular: 5, full: 40 }),
  /**
   * DEF-036（凍結中のポップアップ。TS-f で `isolated-interaction` のテストと `safety-gates` の GATE-S04 を、`safety-gates` の GATE-S04 に
   * まとめた。前の GATE-S04 の回数 `gateS04PopupFormPost`（2・5）は、多い側のこの回数に寄せて捨てた）。修正の前は 40 回中 37 回届いた。
   * `ROUTED` の回が 1 回以上の確かめは、どの回でも満たした。
   */
  frozenPopupAudit: Object.freeze({ regular: 3, full: 10 }),
  /** DEF-039（`isolated-interaction` のページ自身が開いて閉じるポップアップ）。修正の前は毎回届いた（5/5、8/8）。 */
  frozenPopupSelfClose: Object.freeze({ regular: 2, full: 5 }),
  /**
   * DEF-045（`isolated-interaction` の凍結の直後の owner の close）。回ごとに、凍結までの待ちを 5 種類、close までの待ちを 3 種類ずらすので、
   * ふだんの組も 5 回にして、どのずらし方も 1 回ずつ通る（修正の前は 10 回のうち 1〜3 回で違反が出た）。
   */
  frozenCloseRace: Object.freeze({ regular: 5, full: 10 }),
  /** GATE-S04（`safety-gates` の DEF-039）。修正の前は毎回届いた（5/5、8/8）ので、1 回でも修正の前には失敗する。 */
  gateS04PopupSelfClose: Object.freeze({ regular: 1, full: 3 }),
  /** DEF-038（`gate-harness` の `runGuardedUnloadBeaconRounds`。`site-metadata` も読む）。修正の前は 5 回中 5 回届いた。 */
  unloadBeaconClose: Object.freeze({ regular: 2, full: 5 }),
  /**
   * DEF-042（`gate-harness` の `runGuardedSelfNavigationRounds`）と DEF-040（`WORKER_WEBSOCKET_ROUNDS`。同じ回数）。修正の前は、どの Chromium でも
   * 毎回届いた（5/5、3/3、36/36）ので、1 回でも修正の前には失敗する。
   */
  unloadBeaconSelfNavigation: Object.freeze({ regular: 1, full: 3 }),
  /** T23c（`control-profile-processes`）の同時の更新。 */
  profileConcurrentUpdate: Object.freeze({ regular: 2, full: 5 }),
  /** T23c（`control-profile-processes`）の書き込みのトランザクションの途中の強制終了。 */
  profileHeldTransactionKill: Object.freeze({ regular: 1, full: 3 }),
  /** T23c（`control-profile-processes`）の任意の時の強制終了。 */
  profileLoopKill: Object.freeze({ regular: 1, full: 3 }),
  /**
   * DEF-050（`passive-request-guard` の iframe の `src` を変え続けるページ。測りの上位から足した）。閉じるまでの待ちを 5 種類、凍結の後の待ちを
   * 4 種類ずらすので、ふだんの組も 5 回にして、どのずらし方も 1 回ずつ通る。除いた回が半分より少ないことの確かめ（`< 回数 / 2`）は、測りでは
   * 除いた回が 0 だった（修正の前は 20 回のうち 3〜4 回で違反が出た）。
   */
  iframeSrcChurnClose: Object.freeze({ regular: 5, full: 20 }),
  /** T32R-fix-I1（`isolated-element-bridge` の入れ替え続けるページ。測りの上位から足した）。修正の前は 300 回で違う要素が 71〜85 回（約 4 回に 1 回）。 */
  isolatedElementSwap: Object.freeze({ regular: 50, full: 300 }),
});

/** `TEST_ROUNDS` の場面の名前。 */
export type TestRoundsName = keyof typeof TEST_ROUNDS;

/** この回の組の回数（全部の組なら `full`、ふだんの組なら `regular`）。 */
export function roundsOf(name: TestRoundsName, environment: Readonly<Record<string, string | undefined>> = process.env): number {
  const rounds: TestRounds = TEST_ROUNDS[name];
  return isFullTestTier(environment) ? rounds.full : rounds.regular;
}

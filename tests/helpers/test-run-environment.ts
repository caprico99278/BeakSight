/**
 * テストの回を切り替える環境変数の名前と値の 1 か所（TS-a の発見事項 2 と TS-b。設計書 `doc/design/2026-10-24-beaksight-test-suite-tiers-design.md`
 * 3.1・3.2）。テストの既定の Chromium の切り替え（`tests/helpers/chromium.ts`）、回数の値の選び方（`tests/helpers/test-rounds.ts`）、組を流す起動の
 * 部品（`tests/run-suite.mjs`）、Architecture Gate（`tests/architecture/test-suites.test.ts`）は、ここから読む。名前と値をほかの場所に書き写さない。
 *
 * このファイルは、Node の型の取り除き（`node tests/run-suite.mjs`）でもそのまま読めるよう、何も import せず、型の注釈と `as const` だけを使う
 * （enum・namespace・引数のプロパティを使わない）。`tests/helpers/test-chromium-args.ts` は `src/` を読み込み、その指定子（`.js`）を Node の型の
 * 取り除きが解けないので、ここを別にした。
 */

/**
 * DEF-085 fix round 1: テストの既定の Chromium（`launchHeadlessChromium`）を、CLI の起動の設定に切り替える環境変数（値が
 * `CLI_CHROMIUM_SELECTION` のときだけ）。両方の Chromium で確かめる指示のある既存のテストを、テストを書き換えずに CLI の Chromium でも
 * 実行するための口で、ふだん（省略）は今のまま headless shell を使う。どちらも headless で起動する。
 */
export const TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE = 'BEAKSIGHT_TEST_DEFAULT_CHROMIUM';
/** `TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE` の、CLI の Chromium を選ぶ値。 */
export const CLI_CHROMIUM_SELECTION = 'cli';
/** CLI の回（`test:safety` と `test:full` の 2 回目）で、起動の部品が子のプロセスに渡す環境変数。 */
export const CLI_CHROMIUM_RUN_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  [TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE]: CLI_CHROMIUM_SELECTION,
});

/**
 * SLIM-B0: 2 つの Chromium の組（`tests/helpers/chromium.ts` の `chromiumRunsOf`・`BOTH_CHROMIUM_LAUNCHERS`）を、両方の Chromium に広げる環境変数
 * （値が `BOTH_CHROMIUM_SELECTION` のときだけ）。省略とほかの値は、CLI の起動の設定（本番）の 1 つだけ。広げるのは、安全の不具合を直す束、Guard・中継・
 * 起動の部品を変えた束、Chromium の版を上げるときだけ（`tests/run-suite.mjs` の `safety`、`related --with-safety`・`--both-chromium`）。
 */
export const BOTH_CHROMIUM_ENVIRONMENT_VARIABLE = 'BEAKSIGHT_TEST_BOTH_CHROMIUM';
/** `BOTH_CHROMIUM_ENVIRONMENT_VARIABLE` の、両方の Chromium に広げる値。 */
export const BOTH_CHROMIUM_SELECTION = 'both';
/** 両方の Chromium に広げる回で、起動の部品が子のプロセスに渡す環境変数。 */
export const BOTH_CHROMIUM_RUN_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  [BOTH_CHROMIUM_ENVIRONMENT_VARIABLE]: BOTH_CHROMIUM_SELECTION,
});

/** この回が 2 つの Chromium の組を両方に広げるか（`BOTH_CHROMIUM_ENVIRONMENT_VARIABLE` が `BOTH_CHROMIUM_SELECTION`。唯一の判定）。 */
export function isBothChromiumSelected(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return environment[BOTH_CHROMIUM_ENVIRONMENT_VARIABLE] === BOTH_CHROMIUM_SELECTION;
}

/**
 * TS-b: 回数を重ねるテストの回数（`tests/helpers/test-rounds.ts`）を、全部の組の値にする環境変数（値が `FULL_TEST_TIER` のときだけ）。
 * 省略とほかの値は、ふだんの組の値。
 */
export const TEST_TIER_ENVIRONMENT_VARIABLE = 'BEAKSIGHT_TEST_TIER';
/** `TEST_TIER_ENVIRONMENT_VARIABLE` の、全部の組を選ぶ値。 */
export const FULL_TEST_TIER = 'full';
/** 全部の組（`test:full`。`verify`・`verify:all` から呼ぶ）のどの回でも、起動の部品が子のプロセスに渡す環境変数。 */
export const FULL_TEST_TIER_RUN_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  [TEST_TIER_ENVIRONMENT_VARIABLE]: FULL_TEST_TIER,
});

/** この回が全部の組か（`TEST_TIER_ENVIRONMENT_VARIABLE` が `FULL_TEST_TIER`。唯一の判定）。 */
export function isFullTestTier(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return environment[TEST_TIER_ENVIRONMENT_VARIABLE] === FULL_TEST_TIER;
}

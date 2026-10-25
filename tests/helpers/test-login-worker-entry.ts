/**
 * 手動のログインの段の口だけを替えた、監査のワーカーのテストだけの入口の本文（CCX-23。CC-061）。
 * - 本番の process の組み立て（`runAuditWorkerProcess`）を、テストだけの口（関数の引数。T25d）で、ログイン用の Browser を CLI の起動の設定の
 *   headless に替え、待つ時間を短くして呼ぶ。監査の Browser は、本番と同じく headless。本番の入口（`src/worker/audit-worker.ts`）は変えない。
 * - 人の操作の代わり: 資格情報の組（`[セレクタ, 値]` の組と、送るボタンのセレクタ）を返す式を渡すと、ログインの画面を開いたときにその式を評価し、
 *   欄に入れて送る。式を渡さなければ、ログインの画面の口を渡さない（人の操作を待ち、時間切れになる）。
 * - 資格情報の値は、入口に書かない（式は、受け渡しのサーバや標準入力から受け取るもの）。
 * - 使う所: 画面のテスト（`apps/local-ui/tests/helpers/auth-worker.ts`。一時の root の `dist/worker/` に置く）と、ワーカーの fork の結合テスト
 *   （`tests/integration/audit-worker-auth-fork.test.ts` など。一時のビルドの root に置く）。`playwright` は、置き場所の祖先の `node_modules` から解決される。
 *   PRE42-CC の組 6a（CC-061 の後半、CC-091）: 書き込みのジョブの補助（`write-job-harness.ts`）、発見のジョブとまとめて実行の fork のテストも使う
 *   （ほかの口は `additionalHooks` で足す）。ログインの画面の口の写しの戻りは、Gate `fork-test-helper-reuse` が止める。
 */
import { TEST_DEFAULT_CHROMIUM_LAUNCH_SOURCE } from './test-chromium-args.js';

/** テストだけの入口の本文の指定。 */
export interface TestLoginWorkerEntryOptions {
  /** 入口のファイルから見た、ビルドの `dist/` の場所（`/` で終わる。例: `dist/worker/` の中なら `'../'`、root なら `'./dist/'`）。 */
  readonly distPrefix: string;
  /** ログインを待つ時間（ms）。 */
  readonly loginTimeoutMs: number;
  /** 入口の先頭に足す本文（ESM。記録や、資格情報の読み取りの準備）。 */
  readonly prelude?: string;
  /**
   * 資格情報の組を返す式（JavaScript。`await` する。ログインの画面を開いてから評価する）。`null` なら、ログインの画面の口を渡さない。
   */
  readonly credentialsExpression: string | null;
  /**
   * T34c: ログイン用の Browser の起動の設定（省略は `CLI`）。`CLI` は CLI の起動の設定の headless（`chromiumLaunchOptions` の値を起動の部品 `launchChromium` で）、`TEST_DEFAULT` は
   * テストの既定の headless shell（`tests/helpers/test-chromium-args.ts` の `TEST_DEFAULT_CHROMIUM_ARGS` の引数つき。`launchHeadlessChromium` と同じ）。両方の
   * Chromium で確かめる結合テストが選ぶ。監査の Browser は、どちらでも本番と同じ。
   */
  readonly loginLaunch?: TestLoginWorkerLaunch;
  /**
   * CC-091（PRE42-CC の組 6a）: `runAuditWorkerProcess` の口の組に、`loginStage` の後に足す本文（JavaScript の項目。`,` で終える。例:
   * `launchRunBrowser: …,`、`auto-login-worker-entry.ts` の `PORTABLE_CREDENTIAL_STORE_HOOK_SOURCE`）。省略は、足さない。足す口が使う import と
   * 値は `prelude` に書く。
   */
  readonly additionalHooks?: string;
}

/** ログイン用の Browser の起動の設定の種類（T34c）。 */
export type TestLoginWorkerLaunch = 'CLI' | 'TEST_DEFAULT';

/** ログイン用の Browser を起動する式（T34c）。 */
const LOGIN_LAUNCH_SOURCES: Readonly<Record<TestLoginWorkerLaunch, string>> = Object.freeze({
  // EL-12: CLI の起動の設定は、本番と同じ起動の部品（`launchChromium`。外部のアプリの起動を止める一時のプロファイルと自己検査）で起動する。
  CLI: 'launchChromium({ headless: true })',
  // CC-098: テストの既定の headless shell の起動の引数は、1 か所から読む（`test-chromium-args.ts`。WebRTC と Shared Worker の引数）。
  TEST_DEFAULT: TEST_DEFAULT_CHROMIUM_LAUNCH_SOURCE,
});

/** ログインの画面を開いたときに、資格情報の組を欄に入れて送る口（`credentialsExpression` を評価する）。 */
const loginPageReadySource = (credentialsExpression: string): string => String.raw`
    onLoginPageReady: async (page) => {
      const { fields, submit } = await (${credentialsExpression});
      for (const [selector, value] of fields) {
        await page.fill(selector, value);
      }
      await page.click(submit);
    },`;

/** テストだけの入口の本文（ESM）。 */
export const testLoginWorkerEntrySource = (options: TestLoginWorkerEntryOptions): string => String.raw`
${options.prelude ?? ''}
import { chromium } from 'playwright';
import { launchChromium } from '${options.distPrefix}browser/chromium-launch.js';
import { runAuditWorkerProcess } from '${options.distPrefix}worker/audit-worker-process.js';
runAuditWorkerProcess(process, {
  loginStage: {
    launchLoginBrowser: () => ${LOGIN_LAUNCH_SOURCES[options.loginLaunch ?? 'CLI']},
    loginTimeoutMs: ${JSON.stringify(options.loginTimeoutMs)},${options.credentialsExpression === null ? '' : loginPageReadySource(options.credentialsExpression)}
  },${options.additionalHooks ?? ''}
});
`;

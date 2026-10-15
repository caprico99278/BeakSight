/**
 * 手動のログインの段の口だけを替えた、監査のワーカーのテストだけの入口の本文（CCX-23。CC-061）。
 * - 本番の process の組み立て（`runAuditWorkerProcess`）を、テストだけの口（関数の引数。T25d）で、ログイン用の Browser を CLI の起動の設定の
 *   headless に替え、待つ時間を短くして呼ぶ。監査の Browser は、本番と同じく headless。本番の入口（`src/worker/audit-worker.ts`）は変えない。
 * - 人の操作の代わり: 資格情報の組（`[セレクタ, 値]` の組と、送るボタンのセレクタ）を返す式を渡すと、ログインの画面を開いたときにその式を評価し、
 *   欄に入れて送る。式を渡さなければ、ログインの画面の口を渡さない（人の操作を待ち、時間切れになる）。
 * - 資格情報の値は、入口に書かない（式は、受け渡しのサーバや標準入力から受け取るもの）。
 * - 使う所: 画面のテスト（`apps/local-ui/tests/helpers/auth-worker.ts`。一時の root の `dist/worker/` に置く）と、ワーカーの fork の結合テスト
 *   （`tests/integration/audit-worker-auth-fork.test.ts`。一時のビルドの root に置く）。`playwright` は、置き場所の祖先の `node_modules` から解決される。
 */

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
}

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
import { chromiumLaunchOptions } from '${options.distPrefix}browser/chromium-launch.js';
import { runAuditWorkerProcess } from '${options.distPrefix}worker/audit-worker-process.js';
runAuditWorkerProcess(process, {
  loginStage: {
    launchLoginBrowser: () => chromium.launch(chromiumLaunchOptions({ headless: true })),
    loginTimeoutMs: ${JSON.stringify(options.loginTimeoutMs)},${options.credentialsExpression === null ? '' : loginPageReadySource(options.credentialsExpression)}
  },
});
`;

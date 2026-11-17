/**
 * SLIM-1: 部品と、その振る舞いを確かめるテストの組の台帳（設計書 `doc/design/2026-11-14-beaksight-slim-and-simplify-design.md` 3 章）。
 * - `node tests/run-suite.mjs related` は、ここに載る部品を変えたとき、import のたどりで選ぶ代わりに、ここの組だけを選ぶ。広く import される部品は、
 *   たどるとほぼ全部のテストが選ばれるため。選んだ組は、`tests/suites.ts` の組（速い組・遅い組）に分けて流す。
 * - 組には、部品の振る舞い（入力と出力）を網羅する単体と、本番の通り道でその部品を使うことの代表の結合（1〜3 ファイル）を書く。
 * - `component` はリポジトリの根からのパス。`/` で終われば、その下の全部。
 * - 部品とテストのファイルが在ること、部品が重ならないことは、Architecture Gate（`tests/architecture/test-suites.test.ts`）が確かめる。
 * このファイルは何も import しない（`node tests/run-suite.mjs` が型の取り除きでそのまま読む）。
 */

/** 台帳の 1 行（部品と、それを確かめるテストのファイル）。 */
export interface ComponentTests {
  readonly component: string;
  readonly tests: readonly string[];
}

export const COMPONENT_TEST_LEDGER: readonly ComponentTests[] = Object.freeze([
  {
    // URL・ヘッダ・記録の値の伏せ字。
    component: 'src/safety/redact.ts',
    tests: [
      'tests/unit/redact.test.ts',
      'tests/unit/redact-url-secrets.test.ts',
      'tests/unit/recorded-request-url-redaction.test.ts',
      'tests/unit/service-origin-url-redaction.test.ts',
      'tests/unit/secret-query-names.test.ts',
      'tests/unit/secret-name-policies.test.ts',
      'tests/unit/artifact-writer-url-secrets.test.ts',
      'tests/unit/beaksight-block-marks.test.ts',
      'tests/architecture/secret-name-policies.test.ts',
      // 代表の結合: 公開の監査の成果物、認証つきの Run の記録と通知、画面の目印。
      'tests/integration/public-audit-url-values-all-fields.test.ts',
      'tests/integration/authenticated-url-secrets.test.ts',
      'apps/local-ui/tests/login-secret-markers.test.ts',
    ],
  },
  {
    // Run・Finding・ページの契約の型と、閉じた値の一覧。
    component: 'src/core/contracts.ts',
    tests: [
      'tests/unit/core-contracts.test.ts',
      'tests/unit/schema-enum-consistency.test.ts',
      'tests/unit/finding-schema.test.ts',
      'tests/unit/status.test.ts',
      'tests/architecture/semantic-ownership.test.ts',
      'tests/architecture/incomplete-reason-ownership.test.ts',
      // 代表の結合: 同じ process の Run と、ビルドした本物のワーカーの Run（SLIM-GROUP: 前の CLI の `fixture-full-crawl` をまとめた先）。
      'tests/integration/audit-run.test.ts',
      'tests/integration/control-audit-jobs-worker.test.ts',
    ],
  },
  {
    // 利用者に見せる文言。
    component: 'src/presentation/messages.ts',
    tests: [
      'tests/unit/presentation-messages.test.ts',
      'tests/unit/presentation-format.test.ts',
      'tests/unit/html-report.test.ts',
      'tests/unit/cli.test.ts',
      'tests/unit/local-ui-display.test.ts',
      'tests/unit/control-setup-messages.test.ts',
      'tests/architecture/ui-ssot.test.ts',
      'apps/local-ui/tests/plain-safety-text.test.ts',
      'apps/local-ui/tests/job-stop-dialog-text.test.ts',
      // 代表の結合: ビルドした CLI の出力と、画面の表示。
      'tests/integration/cli.test.ts',
      'apps/local-ui/tests/site-screens-ui.test.ts',
    ],
  },
]);

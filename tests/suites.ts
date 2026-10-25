/**
 * テストの組の一覧の 1 か所（TS-a。設計書 `doc/design/2026-10-24-beaksight-test-suite-tiers-design.md` 3.1）。
 * どのファイルがどの組かは、ここにだけ書く。Vitest の設定（`vitest.config.ts` の projects）と、組を流す起動の部品（`tests/run-suite.mjs`）は、
 * ここから読む。npm の scripts やほかの場所に、ファイルの一覧を書き写さない（Architecture Gate `tests/architecture/test-suites.test.ts`）。
 *
 * このファイルは、Node の型の取り除き（`node tests/run-suite.mjs`）でもそのまま読めるよう、何も import せず、型の注釈と `as const` だけを使う
 * （enum・namespace・引数のプロパティを使わない）。
 */

/** 単体の系の project の名前（unit・component・architecture）。 */
export const UNIT_PROJECT_NAME = 'unit';
/** 結合のうち、重い組でないものの project の名前。 */
export const INTEGRATION_PROJECT_NAME = 'integration';
/** 結合のうち、重い組の project の名前。 */
export const HEAVY_PROJECT_NAME = 'heavy';

/** 単体の系の project が読むファイル。 */
export const UNIT_PROJECT_INCLUDE: readonly string[] = Object.freeze([
  'tests/unit/**/*.test.ts',
  'tests/component/**/*.test.ts',
  'tests/architecture/**/*.test.ts',
]);

/** 結合の project（重い組を含む）が読むファイル。 */
export const INTEGRATION_PROJECT_INCLUDE: readonly string[] = Object.freeze(['tests/integration/**/*.test.ts']);

/**
 * 安全の一覧（`test:safety` の既定の Chromium の回）。設計者の確かめの手順（Task 44 の fix round 1 の後の確かめ）の 31 ファイルと同じで、
 * ブラウザ自身の通信の検査（`chromium-google-connections`）を含む。重いファイルも、ここに入れたものは重い組に入れない。TS-c で、前の
 * `stage-chain-fork.test.ts` を Run の Browser ごとに 2 つ（`-default`・`-cli`）に分けたので、今は 32 ファイル。
 */
export const SAFETY_TEST_FILES: readonly string[] = Object.freeze([
  'tests/integration/safety-gates.test.ts',
  'tests/component/context-factory.test.ts',
  'tests/integration/gate-fixtures.test.ts',
  'tests/integration/passive-request-guard.test.ts',
  'tests/integration/guard-login-stage.test.ts',
  'tests/integration/guard-write-stage.test.ts',
  'tests/integration/guard-audit-send-policy.test.ts',
  'tests/integration/guard-audit-send-revisit-close.test.ts',
  'tests/integration/guard-unload-requests.test.ts',
  'tests/integration/guard-script-login.test.ts',
  'tests/integration/guard-page-errors.test.ts',
  'tests/integration/webrtc-egress-blocked.test.ts',
  'tests/integration/public-audit-url-values-all-fields.test.ts',
  'tests/integration/public-audit-url-values-resume.test.ts',
  'tests/integration/stage-chain-fork-default.test.ts',
  'tests/integration/stage-chain-fork-cli.test.ts',
  'tests/integration/login-field-proposal-stage.test.ts',
  'tests/integration/login-form-fields.test.ts',
  'tests/integration/chromium-google-connections.test.ts',
  'tests/integration/preloading-disabled.test.ts',
  'tests/integration/egress-close-freeze-run.test.ts',
  'tests/integration/egress-http-fidelity.test.ts',
  'tests/integration/egress-keep-alive-cli.test.ts',
  'tests/integration/egress-proxy-request-budget.test.ts',
  'tests/integration/egress-proxy-tunnel-admission.test.ts',
  'tests/integration/egress-proxy.test.ts',
  'tests/integration/egress-tunnel-admission.test.ts',
  'tests/integration/bn0-page-subresource-exclusions.test.ts',
  'tests/integration/beaksight-block-records.test.ts',
  'tests/integration/beaksight-block-relation.test.ts',
  'tests/integration/guard-audit-exclusions.test.ts',
  'tests/integration/guard-audit-stage.test.ts',
]);

/**
 * CLI の回の一覧（`test:safety` の 2 回目。`tests/helpers/test-run-environment.ts` の `CLI_CHROMIUM_RUN_ENVIRONMENT` で、テストの既定の Chromium を
 * CLI の起動の設定に替えて流す）。
 * 安全の一覧のうち、テストの既定の Chromium（`launchHeadlessChromium`・`useHeadlessChromium`・`createRunLauncher`）で流すテストを、同じファイルの中で
 * CLI の Chromium でも流していないものだけ。ほかの安全のファイルは、ファイルの中で両方の Chromium を流している（`describe.each` の組）か、
 * 環境変数を読まない（中継だけのテスト、ビルドした CLI の別のプロセス、子のプロセスの入口に埋めた起動の式）ので、2 回目では新しく確かめるものがない。
 */
export const CLI_CHROMIUM_TEST_FILES: readonly string[] = Object.freeze([
  'tests/integration/safety-gates.test.ts',
  'tests/component/context-factory.test.ts',
  'tests/integration/gate-fixtures.test.ts',
  'tests/integration/passive-request-guard.test.ts',
  'tests/integration/beaksight-block-relation.test.ts',
]);

/**
 * 重い組の一覧（`test:heavy`）。目安は、組み直しの前の測り（2026-10-24 PRE42-TEST。15 並列の混雑の下）で、ファイルの時間（フックを含む）が
 * 60 秒以上の結合のファイル。安全の一覧のファイルは、重くてもここに入れない。新しいファイルや、ファイルを分けたときは、測りを見て足す。
 */
export const HEAVY_TEST_FILES: readonly string[] = Object.freeze([
  'tests/integration/api-write-create-run.test.ts',
  'tests/integration/api-write-submission.test.ts',
  'tests/integration/api-write-submitter.test.ts',
  'tests/integration/api-write-update-run.test.ts',
  'tests/integration/audit-run.test.ts',
  'tests/integration/audit-send-refresh-worker-fork.test.ts',
  'tests/integration/audit-send-token-refresh.test.ts',
  'tests/integration/audit-worker-auth-fork.test.ts',
  'tests/integration/audit-worker-auth.test.ts',
  'tests/integration/audit-worker-automated-login-fork.test.ts',
  'tests/integration/audit-worker.test.ts',
  'tests/integration/auditor-gates.test.ts',
  'tests/integration/auth-mode-contrast.test.ts',
  'tests/integration/authenticated-audit-run.test.ts',
  'tests/integration/authenticated-run-resume-kind.test.ts',
  'tests/integration/authenticated-run.test.ts',
  'tests/integration/authenticated-url-secrets.test.ts',
  'tests/integration/automated-login-hostile.test.ts',
  'tests/integration/automated-login-pacing.test.ts',
  'tests/integration/automated-login.test.ts',
  'tests/integration/automated-script-login-carryover.test.ts',
  'tests/integration/automated-script-login-fork.test.ts',
  'tests/integration/automated-script-login.test.ts',
  'tests/integration/cli-interrupt-windows.test.ts',
  'tests/integration/cli-lock-takeover-overlap.test.ts',
  'tests/integration/cli-output-parity.test.ts',
  'tests/integration/cli-resume.test.ts',
  'tests/integration/cli-site-unavailable.test.ts',
  'tests/integration/control-audit-jobs-worker.test.ts',
  'tests/integration/crawl-run.test.ts',
  'tests/integration/def-144-probe-page-change.test.ts',
  'tests/integration/discovery-job-fork.test.ts',
  'tests/integration/discovery-probe.test.ts',
  'tests/integration/discovery-run.test.ts',
  'tests/integration/discovery-submission-probe.test.ts',
  'tests/integration/entry-check-run.test.ts',
  'tests/integration/fixture-full-crawl.test.ts',
  'tests/integration/guard-api-write-stage.test.ts',
  'tests/integration/guard-audit-send-review-fixes.test.ts',
  'tests/integration/guard-external-cancel.test.ts',
  'tests/integration/guard-login-credential-leaks.test.ts',
  'tests/integration/guard-login-credential.test.ts',
  'tests/integration/guard-popup-close-race.test.ts',
  'tests/integration/guard-submission-observation.test.ts',
  'tests/integration/guard-unguarded-popup.test.ts',
  'tests/integration/guard-worker-websocket.test.ts',
  'tests/integration/isolated-element-bridge.test.ts',
  'tests/integration/isolated-interaction-audit.test.ts',
  'tests/integration/isolated-interaction-corrections.test.ts',
  'tests/integration/isolated-interaction-discovery.test.ts',
  'tests/integration/isolated-interaction-evidence.test.ts',
  'tests/integration/job-audit-stage-review.test.ts',
  'tests/integration/job-audit-stage-spa.test.ts',
  'tests/integration/job-site-unavailability.test.ts',
  'tests/integration/login-form-submitter.test.ts',
  'tests/integration/navigation-pacing.test.ts',
  'tests/integration/page-auditor-interaction.test.ts',
  'tests/integration/page-auditor-site-unavailability.test.ts',
  'tests/integration/page-auditor.test.ts',
  'tests/integration/page-navigation-limit.test.ts',
  'tests/integration/read-check-page.test.ts',
  'tests/integration/read-check-run.test.ts',
  'tests/integration/resume-run.test.ts',
  'tests/integration/scenario-api-store.test.ts',
  'tests/integration/script-login-worker-fork.test.ts',
  'tests/integration/script-login-worker-stage.test.ts',
  'tests/integration/session-loss-late-move.test.ts',
  'tests/integration/spa-audit-revisit.test.ts',
  'tests/integration/spa-audit-run.test.ts',
  'tests/integration/spa-script-login-baseline.test.ts',
  'tests/integration/stale-lock-takeover-processes.test.ts',
  'tests/integration/worker-finalizing-heartbeat-fork.test.ts',
  'tests/integration/write-create-run.test.ts',
  'tests/integration/write-job-api-start.test.ts',
  'tests/integration/write-job-api-update.test.ts',
  'tests/integration/write-job-audit-stage.test.ts',
  'tests/integration/write-job-fork.test.ts',
  'tests/integration/write-job-g30.test.ts',
  'tests/integration/write-job-g31.test.ts',
  'tests/integration/write-job-update.test.ts',
  'tests/integration/write-update-run.test.ts',
]);

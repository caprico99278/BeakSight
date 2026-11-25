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

/** 結合の project（重い組を含む）が読むファイル。RB-3: ずれの確かめ（`tests/contract/`）も、本物の Chromium を使う結合として読む。 */
export const INTEGRATION_PROJECT_INCLUDE: readonly string[] = Object.freeze(['tests/integration/**/*.test.ts', 'tests/contract/**/*.test.ts']);

/**
 * 安全の一覧（`test:safety` の既定の Chromium の回）。ブラウザ自身の通信の検査（`preloading-disabled`）を含む。
 * 重いファイルも、ここに入れたものは重い組に入れない。SLIM-GROUP（設計書 `doc/design/2026-11-14-beaksight-slim-and-simplify-design.md` 4 章）で、
 * 場面を段ごとの家のファイルへまとめ、25 ファイルにした（安全の受け入れ条件の場面は消していない）。
 */
export const SAFETY_TEST_FILES: readonly string[] = Object.freeze([
  // 守りの全体と起動の部品
  'tests/integration/safety-gates.test.ts',
  'tests/component/context-factory.test.ts',
  'tests/integration/gate-fixtures.test.ts',
  // Guard（段ごとの家と、段によらない場面）
  'tests/unit/passive-request-guard.test.ts',
  'tests/integration/passive-request-guard-browser.test.ts',
  'tests/integration/guard-login-stage.test.ts',
  'tests/integration/guard-write-stage.test.ts',
  'tests/integration/guard-audit-stage.test.ts',
  'tests/integration/guard-audit-exclusions.test.ts',
  'tests/integration/guard-audit-send-revisit-close.test.ts',
  'tests/integration/guard-unload-requests.test.ts',
  'tests/integration/guard-page-errors.test.ts',
  'tests/integration/beaksight-block-relation.test.ts',
  // DEF-236: 画面を見せたまま待つ間の送信（SD-2: ページ自身の DELETE は届き、止めた記録にならない）。
  'tests/integration/visible-pacing-wait.test.ts',
  'tests/integration/visible-pacing-wait-worker.test.ts',
  // 資格情報と伏せ字
  'tests/integration/login-form-fields.test.ts',
  'tests/integration/public-audit-url-values-all-fields.test.ts',
  // ブラウザ自身の通信と中継
  'tests/integration/preloading-disabled.test.ts',
  'tests/integration/egress-http-fidelity.test.ts',
  'tests/integration/egress-proxy-request-budget.test.ts',
  'tests/integration/egress-proxy-tunnel-admission.test.ts',
  'tests/integration/egress-proxy.test.ts',
  'tests/integration/egress-tunnel-admission.test.ts',
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
  // SLIM-GROUP（SAFE）: passive-request-guard は外した（CLI の Chromium は、passive-request-guard-browser の最後の describe.each が入口 `chromiumRunsOf` で通す）。
  'tests/integration/beaksight-block-relation.test.ts',
]);

/**
 * TEST-SLIM H0: 安全の一覧の外で、2 つの Chromium の組（`tests/helpers/chromium.ts` の `chromiumRunsOf`・`BOTH_CHROMIUM_LAUNCHERS`）を使ってよいファイル。
 * 使ってよいのは、安全の漏れ（読み取りでない要求・記録されない要求・削除・資格情報がサーバに届かないこと）を確かめるファイルだけ
 * （TEST-POLICY の決まり 3）。足すときは、行の横に確かめる漏れを書く。
 * SLIM-B0: この一覧は「その束で両方の Chromium に広げる一覧」。遅い組の一覧ではない（遅い組かは、下の構造の一覧で決める）。遅い組と区切りでは、
 * 組を CLI の起動の設定（本番）の 1 つだけで流し、両方に広げるのは、安全の不具合を直す束、Guard・中継・起動の部品を変えた束、Chromium の版を
 * 上げるときだけ（`tests/run-suite.mjs` の `safety`、`related --with-safety`・`--both-chromium`）。
 */
export const BOTH_CHROMIUM_LEAK_CHECK_FILES: readonly string[] = Object.freeze([
  // 書き込みの段
  'tests/integration/api-write-submission.test.ts', // 2 回目・再送・中継へ直に送った分が届かない、Authorization と応答の本文が記録に出ない
  'tests/integration/write-stage-after-press-sends.test.ts', // 押した後の削除・書き換えた本文・READ_ONLY のページの送信が届かない
  'tests/integration/write-stage-context.test.ts', // 書き込みの段の許可が外へ漏れない、中継へ直に送った承認の形の POST が届かない
  'tests/integration/wbf-nameless-field-write.test.ts', // 名前のない欄の位置がずれて別の欄に入った値の送信が届かない
  // ログイン・認証
  'tests/integration/spa-script-login-baseline.test.ts', // 登録のない RPC・token の更新・WebSocket・beacon が届かない
  'tests/integration/authenticated-context-factory.test.ts', // 別の Origin の Cookie が届かない、状態の読み取りで何も送らない
  'tests/integration/authenticated-url-secrets.test.ts', // URL の秘密が記録・通知・checkpoint に出ない
  'tests/integration/automated-script-login.test.ts', // 資格情報を運ぶ GET のフォームや付随の送信が届かない
  'tests/integration/login-observation-hostile.test.ts', // ユーザー名が観察の記録に残らない
  'tests/integration/automated-login-hostile.test.ts', // ページの JS が入力の値をほかの要求で送れない
  'tests/integration/login-credential-capture.test.ts', // 受け取った資格情報が記録・ページに出ない
  'tests/integration/automated-login-pass-through.test.ts', // 資格情報・DELETE・危険な path・2 回目のログインの送信が届かない
  'tests/integration/authenticated-host-only-cookies.test.ts', // ドメインと親ドメインの Cookie がサブドメインに、別の Origin の Cookie がほかの Origin に届かない
  'tests/integration/automated-script-login-carryover.test.ts', // 状態に置いたパスワードを持ち越さない、パスワードを運ぶ要求が届かない
  // 監査・READ
  'tests/integration/spa-audit-run.test.ts', // 読み取りでない要求（token の更新・計測・WebSocket）が届かない、秘密が成果物に出ない
  'tests/integration/audit-scope-move.test.ts', // REV-SD の I-1: 読み込みの後に範囲の外へ移った画面で押さず、押下の POST が外のサーバに届かない
  'tests/integration/spa-audit-revisit.test.ts', // 幅の走査の読み込み直しでサービスに何も届かない、秘密が成果物に出ない
  'tests/integration/modal-open-state.test.ts', // AUD-2: 押した後に開いた小窓を読んでも、使い捨ての Context から読み込みのほかの要求が届かない
  'tests/integration/focus-tab-guard.test.ts', // AUD-3: 通常の Tab の確かめの間にページが出す POST が、送信の扱いのまま記録され、読み込みが増えない
  'tests/integration/read-check-run.test.ts', // 読まないパス・危険な語・秘密の名前・送れない欄の READ と、凍結の後の読み込みが届かない
  'tests/integration/read-check-page.test.ts', // 登録していない手続きの呼び出しが届かない
  'tests/integration/read-check-search-checks.test.ts', // RCA-7: 検索の確かめ（スクリプトの組の押下）で読み取りでない要求が届かない
  'tests/integration/job-audit-stage-review.test.ts', // probe の押下で書いた目印と読み取りでない要求が届かない
  'tests/integration/job-audit-stage-spa.test.ts', // 登録した呼び出しのほかの読み取りでない要求が届かない
  // 制御
  'tests/integration/job-site-unavailability.test.ts', // 不調で止めた後、記録されない要求が次の画面へ届かない（DEF-166）
  // Guard（TEST-SLIM G1）
  'tests/integration/guard-api-write-stage.test.ts', // API の書き込みの段で、敵対的な書き込み・DELETE・2 回目がサービスに届かない
  // SLIM-GROUP（SAFE）: 段ごとの家（安全の一覧の guard-login-stage・guard-audit-stage・guard-write-stage）へまとめたファイルは外した
  'tests/integration/guard-submission-observation.test.ts', // 凍結の後の probe の押下で、事前確認を含め何も届かない
  'tests/integration/guard-popup-close-race.test.ts', // Context を閉じる途中と CDP の付いていないポップアップの要求が届かない
  'tests/integration/guard-worker-websocket.test.ts', // Worker の中の WebSocket の Upgrade が届かない
  // 発見（TEST-SLIM D2）
  'tests/integration/discovery-submission-probe.test.ts', // 凍結の probe の押下で書き込み・削除・敵対的な保存・行の編集の送信が届かない
  'tests/integration/entry-check-run.test.ts', // 許可 Origin の外へ移るログインで、外の Origin に何も届かない
  'tests/integration/list-row-opener-press.test.ts', // 確かめと押す間に入れ替わった、名前のない開き手の POST が届かない
  'tests/integration/discovery-coverage-safety.test.ts', // 網羅の押下と移り先の読み込みの POST・beacon・目印が届かない
  'tests/integration/discovery-token-refresh.test.ts', // 凍結の間、入力の値・危険な語・DELETE を運ぶ更新が届かない
  'tests/integration/discovery-token-refresh-disguise.test.ts', // 見せかけの token の更新が届かず、押下で書いた値が次の画面へ渡らない
  'tests/integration/discovery-run.test.ts', // 読み取りでない要求・読まないパス・ログインの画面・ページ自身の beacon と POST が届かず、秘密が成果物に出ない
  'tests/integration/discovery-screen-watch.test.ts', // DEF-289: 動くボタンを force で押す・作り直された要素を押し直す・読み込み直して続きを押す間に、読み取りでない要求が届かない
  // SLIM-1（X3）: 部品の export（`probe-scene-site.ts` の `PROBE_SCENE_LAUNCHERS`、`isolated-interaction-cases.ts` の DEF-045 の組）を通して 2 つの Chromium で流していた
  'tests/integration/discovery-probe-scenes.test.ts', // 凍結の間、書き込み・削除・上書き・危険なパス・読まないパス・認証情報を含む URL が届かない
  'tests/integration/isolated-interaction-audit.test.ts', // 凍結の直後に閉じる途中の POST が届かない（DEF-045）
  // SLIM-B0: CLI の Chromium を直接 import し、組を入口（`chromiumRunsOf`）に通すファイル（両方に広げる束で 2 つの Chromium を流す）
  'tests/integration/external-launch-block.test.ts', // 外部スキームへの移動が OS のアプリへ渡らず、Guard が 1 回だけ記録する（EL-12）
  'tests/integration/frozen-observation-context.test.ts', // 最初から凍結した Context で、読み込みが自動に出す POST が届かない（SAFE-2 の 1）
  'tests/integration/isolated-element-bridge.test.ts', // isolated world の読み取りで、ページの JS が走らず、ほかの要素を渡さない（T32j-4）
  'tests/integration/isolated-reads-forgery.test.ts', // ページの JS の偽りの下でも、読む間にページの JS が走らない（T32j-4）
  'tests/integration/resource-delivery.test.ts', // 読み込み直しの Context が、許可 Origin の外へキャッシュにない要求を送らない（L5b・DEF-031）
  // SD-1: 操作の前の判定の代表
  'tests/integration/destructive-action-guard.test.ts', // 巡回・知らせの枠・Interaction・発見が、削除に関する操作を押さず（移らず）、その合図と書き込みが届かない
  // RB-3: ずれの確かめの通り道ごとの代表（`CONTRACT_PATH_TEST_FILES`）
  'tests/contract/pass-through-paths.test.ts', // 口で止めた削除・凍結の後の書き込み・資格情報・READ_ONLY の送信が、どの通り道からも届かず、外のアプリが起きない
]);

/**
 * RB-3（設計書 `doc/design/2026-11-15-beaksight-test-rebuild-design.md` 2 章 2・3.3）: ずれの確かめ（`tests/contract/`。どのファイルも、どちらかの
 * 一覧に載せる）。Chromium（Playwright）の版を上げるときは、必ず流す（`node tests/run-suite.mjs chromium-upgrade` が、口の操作ごとを両方の Chromium で、
 * 通り道ごとを両方に広げて流す）。
 * - 口の操作ごと（本物の口と偽の口が同じ答えを返す）: 速い組。テストの既定の Chromium で流す。
 * - 通り道ごとの代表（口で止めたら、本物の Chromium でもサイトに届かない）: 2 つの Chromium の組の入口を通すので、漏れの確かめの一覧と、遅い組の
 *   CLI の Chromium の一覧に載る（区切りでは CLI の起動の設定の 1 回）。
 */
export const CONTRACT_PORT_TEST_FILES: readonly string[] = Object.freeze([
  'tests/contract/port-operations.test.ts',
  // RB-5: Browser の lease（段の後に Context が残らない、借りた Browser でも Worker の自己検査が働く）。
  'tests/contract/browser-lease.test.ts',
]);
export const CONTRACT_PATH_TEST_FILES: readonly string[] = Object.freeze(['tests/contract/pass-through-paths.test.ts']);

/*
 * SLIM-1（設計書 `doc/design/2026-11-14-beaksight-slim-and-simplify-design.md` 3 章）: 速い組（直すたびに流す）と遅い組（区切りに流す）。
 * - 遅い組は、ここの一覧の和 `SLOW_TEST_FILES` で決める（この 1 か所。`tests/run-suite.mjs related` が読む）。速い組は、遅い組に入らないテストの全部
 *   （単体・部品・architecture、同じ process の中だけで済む 2 分以内の結合と画面のテスト）。CLI の回（`CLI_CHROMIUM_TEST_FILES` を CLI の Chromium で
 *   流す回）は、ファイルの組によらず遅い組の回。
 * - 印は、ファイルの中でなく、この一覧で付ける。理由: 組の決めを 1 つの差分で見られる、起動の部品がテストのファイルを走査せずに読める、Gate が
 *   構造の条件（`tests/architecture/test-group-criteria.ts`）と一覧の両向きの一致を確かめられる（ファイルの中の印は、付け忘れを見つけにくい）。
 * - 単体・部品・architecture（`tests/unit`・`tests/component`・`tests/architecture`）は、条件によらず速い組に置く。
 * - 1 つのファイルは、遅い組の一覧の 1 つにだけ載せる（本番のビルド → 画面のサーバ → CLI の Chromium → 長いファイルの順に先のもの）。
 * - SLIM-B0: 漏れの確かめの一覧（`BOTH_CHROMIUM_LEAK_CHECK_FILES`）は、遅い組の一覧に入れない（両方の Chromium に広げる一覧。載るファイルは、2 つの
 *   Chromium の組の入口を import するので、CLI の Chromium の一覧か本番のビルドの一覧に載る）。
 */

/** 遅い組: 一時ビルドの本番（CLI・ワーカー）を子の process で動かす端から端のテスト（Gate の条件 `BUILT_PRODUCT`）。 */
export const SLOW_BUILT_PRODUCT_TEST_FILES: readonly string[] = Object.freeze([
  'tests/integration/audit-worker.test.ts',
  'tests/integration/cli.test.ts',
  'tests/integration/control-audit-jobs-worker.test.ts',
  'tests/integration/setup-local-built.test.ts',
  'tests/integration/worker-finalizing-heartbeat-fork.test.ts',
]);

/** 遅い組: 画面のサーバを起こすテスト（Gate の条件 `UI_SERVER`。本番のビルドの一覧に載るものを除く）。 */
export const SLOW_UI_SERVER_TEST_FILES: readonly string[] = Object.freeze([
  // 1 ファイル 2 分を超えてよい例外（設計書 5.4）: 秘密の目印の 2 つと、主の流れの 2 つ。
  'apps/local-ui/tests/discovery-approval-secret-markers.test.ts',
  'apps/local-ui/tests/login-secret-markers.test.ts',
  'apps/local-ui/tests/full-flow.test.ts',
  'apps/local-ui/tests/one-pass-write-flow.test.ts',
  // そのほかの画面の流れ
  'apps/local-ui/tests/audit-ui-flows.test.ts',
  'apps/local-ui/tests/auth-ui-flows.test.ts',
  'apps/local-ui/tests/credential-ui-flows.test.ts',
  'apps/local-ui/tests/entry-check-ui.test.ts',
  'apps/local-ui/tests/start-url-onboarding-ui.test.ts',
  'apps/local-ui/tests/ui-close.test.ts',
  // 束 S1（SLIM-GROUP の UI-2）: 画面のサーバの守り（起動の部品・Server Function の作り・成果物の Server Routes・同時に 1 つ）。
  'apps/local-ui/tests/server-guards.test.ts',
  // 束 S2（UI-2）: 開発のサーバ（同時に 1 つと、起動の失敗の場面）。
  'apps/local-ui/tests/dev-server.test.ts',
  // 束 S3（UI-3）: サイトの一覧・作成・詳細・設定の画面。
  'apps/local-ui/tests/site-screens-ui.test.ts',
  // 束 S4（UI-4）: 作業の画面と、行から開く画面。
  'apps/local-ui/tests/job-screens-ui.test.ts',
  // 束 S5a・S5b（UI-5）: 偽のワーカーの発見・一覧でチェック・書き込みの段の画面と、手動のログイン・自動ログインの画面。
  'apps/local-ui/tests/fake-worker-screens-ui.test.ts',
  'apps/local-ui/tests/login-worker-screens-ui.test.ts',
]);

/**
 * 遅い組: CLI の Chromium を起こすテスト（Gate の条件 `CLI_CHROMIUM`。2 つの Chromium の組か、CLI の Chromium だけの場面を持つ。上の一覧に載るものを
 * 除く）。
 */
export const SLOW_CLI_CHROMIUM_LAUNCH_TEST_FILES: readonly string[] = Object.freeze([
  'tests/integration/api-write-submission.test.ts',
  'tests/integration/audit-scope-move.test.ts',
  'tests/integration/authenticated-context-factory.test.ts',
  'tests/integration/authenticated-host-only-cookies.test.ts',
  'tests/integration/authenticated-url-secrets.test.ts',
  'tests/integration/automated-login-hostile.test.ts',
  'tests/integration/automated-login-pass-through.test.ts',
  'tests/integration/automated-script-login-carryover.test.ts',
  'tests/integration/automated-script-login.test.ts',
  'tests/integration/destructive-action-guard.test.ts',
  'tests/integration/discovery-coverage-safety.test.ts',
  'tests/integration/discovery-probe-scenes.test.ts',
  'tests/integration/discovery-run.test.ts',
  'tests/integration/discovery-screen-watch.test.ts',
  'tests/integration/discovery-submission-probe.test.ts',
  'tests/integration/discovery-token-refresh-disguise.test.ts',
  'tests/integration/discovery-token-refresh.test.ts',
  'tests/integration/egress-http-fidelity.test.ts',
  'tests/integration/egress-tunnel-admission.test.ts',
  'tests/integration/element-path-engine-timing-cli.test.ts',
  'tests/integration/entry-check-run.test.ts',
  'tests/integration/external-launch-block.test.ts',
  'tests/integration/focus-tab-guard.test.ts',
  'tests/integration/frozen-observation-context.test.ts',
  'tests/integration/gate-fixtures.test.ts',
  'tests/integration/guard-api-write-stage.test.ts',
  'tests/integration/guard-audit-exclusions.test.ts',
  'tests/integration/guard-audit-send-revisit-close.test.ts',
  'tests/integration/guard-audit-stage.test.ts',
  'tests/integration/guard-canceled-document.test.ts',
  'tests/integration/guard-external-cancel.test.ts',
  'tests/integration/guard-login-stage.test.ts',
  'tests/integration/guard-page-errors.test.ts',
  'tests/integration/guard-popup-close-race.test.ts',
  'tests/integration/guard-response-received-failures.test.ts',
  'tests/integration/guard-submission-observation.test.ts',
  'tests/integration/guard-unload-requests.test.ts',
  'tests/integration/guard-worker-websocket.test.ts',
  'tests/integration/guard-write-stage.test.ts',
  'tests/integration/isolated-element-bridge.test.ts',
  'tests/integration/isolated-interaction-audit.test.ts',
  'tests/integration/isolated-reads-forgery.test.ts',
  'tests/integration/job-audit-stage-review.test.ts',
  'tests/integration/job-audit-stage-spa.test.ts',
  'tests/integration/job-site-unavailability.test.ts',
  'tests/integration/list-row-opener-press.test.ts',
  'tests/integration/login-credential-capture.test.ts',
  'tests/integration/login-form-fields.test.ts',
  'tests/integration/login-observation-hostile.test.ts',
  'tests/integration/modal-open-state.test.ts',
  'tests/integration/passive-request-guard-browser.test.ts',
  'tests/integration/preflight.test.ts',
  'tests/integration/preloading-disabled.test.ts',
  'tests/integration/public-audit-url-values-all-fields.test.ts',
  'tests/integration/read-check-page.test.ts',
  'tests/integration/read-check-run.test.ts',
  'tests/integration/read-check-search-checks.test.ts',
  'tests/integration/resource-cache-truncated.test.ts',
  'tests/integration/resource-delivery.test.ts',
  'tests/integration/safety-gates.test.ts',
  'tests/integration/site-metadata-cli-chromium.test.ts',
  'tests/integration/spa-audit-revisit.test.ts',
  'tests/integration/spa-audit-run.test.ts',
  'tests/integration/spa-script-login-baseline.test.ts',
  'tests/integration/visible-pacing-wait-worker.test.ts',
  'tests/integration/visible-pacing-wait.test.ts',
  'tests/integration/wbf-nameless-field-write.test.ts',
  'tests/integration/write-stage-after-press-sends.test.ts',
  'tests/integration/write-stage-context.test.ts',
  // RB-3: ずれの確かめの通り道ごとの代表（2 つの Chromium の組の入口を通す）。
  'tests/contract/pass-through-paths.test.ts',
]);

/**
 * 遅い組: 同じ process の中だけで済むが、1 ファイルが 2 分を超えたテスト（構造の条件に当たらないもの）。数は、2026-11-15 の各組の報告のファイルの秒
 * （単独の流し）。細くして 2 分以内になったら、ここから外して速い組にする。
 */
export const SLOW_LONG_TEST_FILES: readonly string[] = Object.freeze([
  'tests/integration/arr-3-array-rows-write.test.ts', // 152 秒
  'tests/integration/form-list-row-update-run.test.ts', // 130 秒
  'tests/integration/notification-dismissal.test.ts', // 354 秒
  'tests/integration/page-auditor.test.ts', // 178 秒
  'tests/integration/write-create-run.test.ts', // 192 秒
]);

/**
 * SLIM-GROUP（設計書 `doc/design/2026-11-14-beaksight-slim-and-simplify-design.md` 5.4）: Chromium（Playwright）の版を上げるときの束。Chromium の振る舞いに
 * 依る「誤って違反・失敗にしない」確かめ（止まる向きの退行。漏れの守りではない）を、区切りの遅い組から外し、版を上げるときに両方の Chromium で流す
 * （`node tests/run-suite.mjs chromium-upgrade`。`related --both-chromium` でも、選ばれれば流す）。どのファイルも、上の構造の一覧のどれかに載る
 * （構造の条件は変わらない）が、遅い組（`SLOW_TEST_FILES`）にも速い組にも入らない。足すときは、行の横に確かめる振る舞いを書く。
 * RB-3: 版を上げるときは、ずれの確かめ（`CONTRACT_PORT_TEST_FILES`・`CONTRACT_PATH_TEST_FILES`）も流す（`chromium-upgrade` の初めの 2 回）。この束の
 * 4 つは、Guard が Chromium の事象を受けて判定する所（取り消し・応答の後の失敗）なので、Guard の止める道が口の操作になる段（RB-4b・RB-14）で、
 * ずれの確かめの場面へ移して消す。足さない。
 */
export const CHROMIUM_UPGRADE_TEST_FILES: readonly string[] = Object.freeze([
  'tests/integration/guard-canceled-document.test.ts', // DEF-026: 取り消された文書の命令の失敗を違反にしない（証拠がなければ違反）
  'tests/integration/guard-external-cancel.test.ts', // DEF-027・DEF-163・DEF-225: 外からの取り消しを違反にしない
  'tests/integration/guard-response-received-failures.test.ts', // DEF-029: 応答の後の失敗を違反にしない（CLI の Chromium だけで起きる）
  'tests/integration/site-metadata-cli-chromium.test.ts', // DEF-029・DEF-030: 本文が空の 4xx・5xx の robots.txt・sitemap.xml を NOT_FOUND・FAILED に
]);

/** 遅い組の全部（上の 4 つの一覧の和から、Chromium の版を上げるときの束を除いたもの）。ここに載らないテストは、版を上げるときの束を除いて速い組。 */
export const SLOW_TEST_FILES: readonly string[] = Object.freeze([
  ...SLOW_BUILT_PRODUCT_TEST_FILES,
  ...SLOW_UI_SERVER_TEST_FILES,
  ...SLOW_CLI_CHROMIUM_LAUNCH_TEST_FILES,
  ...SLOW_LONG_TEST_FILES,
].filter((file) => !CHROMIUM_UPGRADE_TEST_FILES.includes(file)));

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
  'tests/integration/audit-scope-move.test.ts',
  'tests/integration/audit-send-token-refresh.test.ts',
  'tests/integration/audit-worker-auth.test.ts',
  'tests/integration/audit-worker.test.ts',
  'tests/integration/auditor-gates.test.ts',
  'tests/integration/authenticated-run.test.ts',
  'tests/integration/authenticated-url-secrets.test.ts',
  'tests/integration/automated-login-hostile.test.ts',
  'tests/integration/automated-login-pacing.test.ts',
  'tests/integration/automated-login.test.ts',
  'tests/integration/automated-script-login-carryover.test.ts',
  'tests/integration/automated-script-login.test.ts',
  'tests/integration/control-audit-jobs-worker.test.ts',
  // L9: scroll の上限の撤廃（伸び続ける画面。TEST-SLIM M3 で遅い読み込みと固まる画面の場面は外した。測りを見て重い組から外すか決める）。
  'tests/integration/controlled-scroll-coverage.test.ts',
  'tests/integration/discovery-probe-scenes.test.ts',
  'tests/integration/discovery-run.test.ts',
  'tests/integration/discovery-submission-probe.test.ts',
  'tests/integration/entry-check-run.test.ts',
  'tests/integration/guard-api-write-stage.test.ts',
  'tests/integration/guard-external-cancel.test.ts',
  'tests/integration/guard-popup-close-race.test.ts',
  'tests/integration/guard-submission-observation.test.ts',
  'tests/integration/guard-worker-websocket.test.ts',
  'tests/integration/isolated-element-bridge.test.ts',
  'tests/integration/isolated-interaction-audit.test.ts',
  'tests/integration/isolated-interaction-corrections.test.ts',
  'tests/integration/isolated-interaction-discovery.test.ts',
  'tests/integration/job-audit-stage-review.test.ts',
  'tests/integration/job-audit-stage-spa.test.ts',
  'tests/integration/job-site-unavailability.test.ts',
  'tests/integration/login-form-submitter.test.ts',
  'tests/integration/navigation-pacing.test.ts',
  // L1b: 段の見張りと collector の見張りを 1 つにし、途中の記録を残す（固まる axe・撮影。2 ビューポートずつ。約 25 秒）。
  'tests/integration/page-auditor-collector-watch.test.ts',
  'tests/integration/page-auditor-interaction.test.ts',
  // L1: 段の期限の撤廃と進みの見張り（固まる段の 1 場面。TEST-SLIM M3 で 65 秒の読み込みと候補 20 件は外した。測りを見て重い組から外すか決める）。
  'tests/integration/page-auditor-progress-watch.test.ts',
  'tests/integration/page-auditor-site-unavailability.test.ts',
  'tests/integration/page-auditor.test.ts',
  'tests/integration/page-navigation-limit.test.ts',
  // L0: 進みの見張り（遅いが進むページを 2 分読み切る。固まるページ・静まらないページ）。
  'tests/integration/progress-watch.test.ts',
  'tests/integration/read-check-page.test.ts',
  'tests/integration/read-check-run.test.ts',
  'tests/integration/resume-run.test.ts',
  'tests/integration/scenario-api-store.test.ts',
  'tests/integration/script-login-worker-stage.test.ts',
  'tests/integration/session-loss-late-move.test.ts',
  'tests/integration/spa-audit-revisit.test.ts',
  'tests/integration/spa-audit-run.test.ts',
  'tests/integration/spa-script-login-baseline.test.ts',
  'tests/integration/worker-finalizing-heartbeat-fork.test.ts',
  'tests/integration/write-create-run.test.ts',
  'tests/integration/write-job-audit-stage.test.ts',
  'tests/integration/write-update-run.test.ts',
]);

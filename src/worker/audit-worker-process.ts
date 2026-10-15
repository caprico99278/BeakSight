/**
 * 監査のワーカーの process の組み立て（Task 24 の設計書 3 章、4.2。T24d。T25d で入口 `audit-worker.ts` から切り出した）。本番の依存を渡して
 * ワーカーの流れ（`audit-worker-session.ts`）を始める。
 * - IPC がない（`process.send` がない。親から fork されていない）なら、何もせずに終了コード 1 で終える。
 * - 本番の依存を渡す: 設定の読み込み（`loadConfig`）、監査の中核（`executeAuditRun`）、CLI と同じ Chromium の起動（`PRODUCTION_RUN_DEPENDENCIES`）、
 *   認証つきの監査のログインの段（`runLoginStage`。ログイン用の Browser は、CLI の起動の設定の headed。`LOGIN_BROWSER_HEADLESS`）。
 * - T26d-2（Task 26 の設計書 3 章、4.4）: 自動ログインの段（`runAutomatedLoginStage`）。ログイン用の Browser は、CLI の起動の設定の **headless**
 *   （`AUTOMATED_LOGIN_BROWSER_HEADLESS`）。資格情報は、`START` の `credentialRoot` から本番の入口 `createCredentialStore` で作ったファイルの部品の
 *   `readMetadata` と `decrypt` で読む（復号は、自動ログインの段が値を入れる直前に 1 回だけ呼ぶ）。
 * - T27d（Task 27 の設計書 4.6）: 発見のジョブの流れ（`executeDiscoveryRun`。`discovery-run.ts`）。Browser は監査と同じ `PRODUCTION_RUN_DEPENDENCIES`。
 * - T27e（Task 27 の設計書 4.5）: READ の確かめのジョブの流れ（`executeReadCheckRun`。`read-check-run.ts`）。Browser は監査と同じ。
 * - T30f（Task 30 の設計書 3 章）: 書き込みのジョブの流れ（`executeWriteCreateRun`。`write-create-run.ts`）。Browser は監査と同じ。
 * - シグナル（`INTERRUPT_SIGNALS`。コンソールの Ctrl+C は、同じコンソールの子も受ける）を、CLI と同じ受け手の数え方で受ける。
 * - 扱われない例外と reject は、`FAILED`（`UNEXPECTED_FAILURE`）を送って、終了コード 1 で終える。
 * - 標準出力には何も書かない。標準出力と標準エラーの `'error'`（閉じたパイプ）は無視する（CLI の `index.ts` と同じ）。cwd は変えない。
 *
 * テストだけの口（T25d）: `loginStage` の指定（関数の引数の依存の注入）で、ログイン用の Browser の起動（テストは headless に替える）と、待つ時間と、
 * ログインの画面の page の受け手（`onLoginPageReady`。テストが人の操作の代わりに入力する）を替えられる。本番の入口（`audit-worker.ts`）は
 * 指定を渡さない。IPC・設定のファイル・環境変数・起動の引数からは渡せない（この関数は、それらを読まない）。
 * T26d-2: 同じ形で、`automatedLoginStage`（自動ログイン用の Browser の起動 `launchAutomatedLoginBrowser` と時間）と `openCredentialStore`（資格情報の
 * ファイルの部品の作り方。テストは偽の暗号化の部品の部品を渡す）を替えられる。
 */
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../browser/chromium-launch.js';
import { executeAuditRun, PRODUCTION_RUN_DEPENDENCIES } from '../cli/audit-run.js';
import { FAILURE_EXIT_CODE } from '../cli/exit-codes.js';
import { registerInterruptHandlers } from '../cli/interrupt.js';
import { ignoreOutputErrors, streamOutput } from '../cli/output-stream.js';
import { loadConfig } from '../config/load-config.js';
import { loginOriginOf } from '../control/auth/automated-login-results.js';
import { createCredentialStore, type CredentialStore } from '../control/credentials/credential-store.js';
import type { WorkerToParentMessage } from '../control/worker-protocol.js';
import { LOGIN_BROWSER_HEADLESS, runLoginStage, type LoginStageDependencies } from './authenticated-login.js';
import { runAutomatedLoginStage, type AutomatedLoginStageDependencies, type AutomatedLoginStageResult } from './automated-login.js';
import { startAuditWorker, type WorkerAutomatedLoginStageRequest, type WorkerChannel } from './audit-worker-session.js';
import { executeDiscoveryRun } from './discovery-run.js';
import { executeReadCheckRun } from './read-check-run.js';
import { executeWriteCreateRun } from './write-create-run.js';

/** IPC がないときの終了コード（親から起動されたときだけ動く）。 */
const NO_PARENT_EXIT_CODE = FAILURE_EXIT_CODE;

/** 本番のログインの段の依存: ログイン用の Browser を、CLI の起動の設定の headed で起動する（人が操作する）。 */
export const PRODUCTION_LOGIN_STAGE_DEPENDENCIES: LoginStageDependencies = Object.freeze({
  launchLoginBrowser: () => chromium.launch(chromiumLaunchOptions({ headless: LOGIN_BROWSER_HEADLESS })),
});

/**
 * 本番の自動ログイン用の Browser を headless で起動するか（真: headless。Task 26 の設計書 4.4。人が操作しないので、ウィンドウを開かない）。手動の
 * ログインの段の headed（`LOGIN_BROWSER_HEADLESS`）は、自動ログインには掛からない。
 */
export const AUTOMATED_LOGIN_BROWSER_HEADLESS = true;

/** 本番の自動ログインの段の依存: ログイン用の Browser を、CLI の起動の設定の headless で起動する。 */
export const PRODUCTION_AUTOMATED_LOGIN_STAGE_DEPENDENCIES: AutomatedLoginStageDependencies = Object.freeze({
  launchAutomatedLoginBrowser: () => chromium.launch(chromiumLaunchOptions({ headless: AUTOMATED_LOGIN_BROWSER_HEADLESS })),
});

/** ワーカーの process の指定（テストだけ。本番の入口は渡さない）。 */
export interface AuditWorkerProcessOptions {
  /** ログインの段の依存の差し替え（省略した項目は本番の値）。 */
  readonly loginStage?: Partial<LoginStageDependencies>;
  /** 自動ログインの段の依存の差し替え（T26d-2。省略した項目は本番の値）。 */
  readonly automatedLoginStage?: Partial<AutomatedLoginStageDependencies>;
  /** 資格情報のファイルの部品の作り方の差し替え（T26d-2。省略すると本番の `createCredentialStore`）。 */
  readonly openCredentialStore?: (credentialRoot: string) => CredentialStore;
}

/**
 * 自動ログインの段を、資格情報のファイルの読み方を付けて行う（T26d-2）。ファイルの部品は、最初に読むときに 1 回だけ作る（作れなければ、読む関数の
 * 誤りになり、自動ログインの段が `CREDENTIAL_UNAVAILABLE` にする）。ログインの Origin は `loginOriginOf`（自動ログインの段の確かめと同じ）。
 */
function runAutomatedLoginWithCredentials(
  request: WorkerAutomatedLoginStageRequest,
  dependencies: AutomatedLoginStageDependencies,
  openCredentialStore: (credentialRoot: string) => CredentialStore,
): Promise<AutomatedLoginStageResult> {
  const { setup, automatedLogin } = request;
  let store: CredentialStore | null = null;
  const credentialStore = (): CredentialStore => {
    store ??= openCredentialStore(automatedLogin.credentialRoot);
    return store;
  };
  return runAutomatedLoginStage({
    config: request.config,
    setup,
    approvedTestOrigins: request.approvedTestOrigins,
    expectedCredentialRevision: automatedLogin.credentialRevision,
    readCredentialMetadata: async () => credentialStore().readMetadata(setup.profileId),
    readCredential: async () => {
      const loginOrigin = loginOriginOf(setup.loginStartUrl);
      if (loginOrigin === undefined) {
        throw new RangeError('the login page of the auth setup has no http(s) origin');
      }
      return credentialStore().decrypt(setup.profileId, loginOrigin);
    },
    signal: request.signal,
    navigationPacer: request.navigationPacer,
  }, dependencies);
}

/** `process` の IPC を、ワーカーの口にする。IPC がなければ `null`。 */
function processWorkerChannel(target: NodeJS.Process): WorkerChannel | null {
  if (typeof target.send !== 'function') {
    return null;
  }
  return {
    send: (message: WorkerToParentMessage) =>
      new Promise<boolean>((resolvePromise) => {
        if (!target.connected || typeof target.send !== 'function') {
          resolvePromise(false);
          return;
        }
        try {
          target.send(message, (error: Error | null) => resolvePromise(error === null || error === undefined));
        } catch {
          resolvePromise(false);
        }
      }),
    onMessage: (listener) => {
      target.on('message', listener);
    },
    onDisconnect: (listener) => {
      target.on('disconnect', listener);
    },
  };
}

/** ワーカーの process を始める（`target` は本番では `process`）。 */
export function runAuditWorkerProcess(target: NodeJS.Process, options: AuditWorkerProcessOptions = {}): void {
  const channel = processWorkerChannel(target);
  if (channel === null) {
    target.exit(NO_PARENT_EXIT_CODE);
    return;
  }
  ignoreOutputErrors(target.stdout);
  ignoreOutputErrors(target.stderr);
  const loginStage: LoginStageDependencies = { ...PRODUCTION_LOGIN_STAGE_DEPENDENCIES, ...options.loginStage };
  const automatedLoginStage: AutomatedLoginStageDependencies = { ...PRODUCTION_AUTOMATED_LOGIN_STAGE_DEPENDENCIES, ...options.automatedLoginStage };
  const openCredentialStore = options.openCredentialStore ?? createCredentialStore;
  const worker = startAuditWorker({
    channel,
    stderr: streamOutput(target.stderr),
    exit: (code) => target.exit(code),
    loadConfig,
    // ターゲット JSON は、`loadConfig` と同じく cwd（リポジトリの root）から読む。
    readTargetConfig: (path) => readFile(path),
    executeAuditRun,
    runDependencies: PRODUCTION_RUN_DEPENDENCIES,
    runLoginStage: (request) => runLoginStage(request, loginStage),
    runAutomatedLoginStage: (request) => runAutomatedLoginWithCredentials(request, automatedLoginStage, openCredentialStore),
    // T27d: 発見のジョブの流れ（監査の Browser と同じ、CLI の起動の設定の Chromium。`runDependencies.launchBrowser`）。
    executeDiscovery: executeDiscoveryRun,
    // T27e: READ の確かめのジョブの流れ（監査の Browser と同じ、CLI の起動の設定の Chromium）。
    executeReadCheck: executeReadCheckRun,
    executeWriteCreate: executeWriteCreateRun,
  });
  registerInterruptHandlers(target, worker.interrupt);
  target.on('uncaughtException', worker.failUnexpectedly);
  target.on('unhandledRejection', worker.failUnexpectedly);
}

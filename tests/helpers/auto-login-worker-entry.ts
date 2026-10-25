/**
 * 自動ログインを使うワーカーの fork のテストの、テストだけの入口の本文（CC-091。T32k。テストのファイルではない）。一時のビルドの root に書く
 * （`./dist/` を読む）。本番の入口（`src/worker/audit-worker.ts`）は変えない。
 * - 使う所: 自動ログインの fork のテスト（`tests/integration/audit-worker-automated-login-fork.test.ts`）と、認証の対比のテスト
 *   （`tests/integration/auth-mode-contrast.test.ts`）。手動のログインの段だけを替える入口は `test-login-worker-entry.ts`（画面のテストと共用）。
 * - ログイン用の Browser: `test-default` はテストの既定の headless shell（自動ログインの段の Browser も同じに替える）、`cli` は CLI の起動の設定の
 *   headless（自動ログインの段の Browser は本番の既定のまま）。
 * - 手動のログインの段: `REJECT` は、呼ばれたら記録して失敗する（自動ログインだけを通るはずのテスト）。`SESSION_HANDOFF` は、Browser を起動し、
 *   ログインの画面を開いたら、標準入力で受けたセッション（Cookie と移る先の URL）を入れる（受けなければ何もしない）。どちらも、呼ばれた口の名前を
 *   記録のファイルに 1 行ずつ書き足す。
 * - 資格情報の部品: `portableCredentialStore` が真なら、移せる偽の暗号化の部品（`PORTABLE_TEST_PROTECTOR_SOURCE`）で開く。偽なら本番の部品のまま。
 * - 資格情報とセッションの値は、入口に書かない（偽の暗号化の部品の鍵はテストだけの値で、資格情報ではない）。
 */
import { TEST_DEFAULT_CHROMIUM_LAUNCH_SOURCE } from './test-chromium-args.js';
import { PORTABLE_TEST_PROTECTOR_SOURCE } from './test-credential-store.js';

/** ログイン用の Browser の起動の種類。 */
export const AUTO_LOGIN_ENTRY_LAUNCHES = Object.freeze(['test-default', 'cli'] as const);
export type AutoLoginEntryLaunch = (typeof AUTO_LOGIN_ENTRY_LAUNCHES)[number];

/** 手動のログインの段の口。 */
export type ManualLoginStageOfEntry =
  | { readonly kind: 'REJECT' }
  | { readonly kind: 'SESSION_HANDOFF'; readonly loginTimeoutMs: number };

/** テストだけの入口の本文の指定。 */
export interface AutoLoginWorkerEntryOptions {
  readonly launch: AutoLoginEntryLaunch;
  /** 手動のログインの段の口が呼ばれた記録のファイル。 */
  readonly manualStageRecord: string;
  /** 偽の暗号化の部品の鍵（16 進）。 */
  readonly protectorKey: string;
  /** 資格情報の部品を、移せる偽の暗号化の部品で開くか。 */
  readonly portableCredentialStore: boolean;
  readonly manualStage: ManualLoginStageOfEntry;
}

/** ログイン用の Browser の起動の式。 */
const LAUNCH_EXPRESSIONS: Readonly<Record<AutoLoginEntryLaunch, string>> = Object.freeze({
  // CC-098: テストの既定の headless shell の起動の引数は、1 か所（`test-chromium-args.ts`。WebRTC と Shared Worker の引数）から読む。
  'test-default': TEST_DEFAULT_CHROMIUM_LAUNCH_SOURCE,
  // EL-12: CLI の起動の設定は、本番と同じ起動の部品（`launchChromium`）で起動する。
  cli: 'launchChromium({ headless: true })',
});

/** 標準入力で受けるセッション（空なら null）。 */
const SESSION_HANDOFF_SOURCE = String.raw`
const handoff = new Promise((resolve) => {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { text += chunk; });
  process.stdin.on('end', () => resolve(text === '' ? null : JSON.parse(text)));
});`;

const manualStageSource = (stage: ManualLoginStageOfEntry): string => (stage.kind === 'REJECT'
  ? String.raw`
  loginStage: {
    launchLoginBrowser: async () => {
      manualStageCalled('launchLoginBrowser');
      throw new Error('the manual login stage must not run');
    },
    onLoginPageReady: async () => manualStageCalled('onLoginPageReady'),
  },`
  : String.raw`
  loginStage: {
    launchLoginBrowser: async () => {
      manualStageCalled('launchLoginBrowser');
      return launchLoginBrowser();
    },
    loginTimeoutMs: ${JSON.stringify(stage.loginTimeoutMs)},
    onLoginPageReady: async (page) => {
      manualStageCalled('onLoginPageReady');
      const given = await handoff;
      if (given === null) {
        return;
      }
      await page.context().addCookies([given.cookie]);
      await page.goto(given.url);
    },
  },`);

/**
 * 移せる偽の暗号化の部品で資格情報の部品を開く口（`runAuditWorkerProcess` の口の項目。CC-091。PRE42-CC の組 6a: 発見のジョブの fork のテストも
 * `testLoginWorkerEntrySource` の `additionalHooks` で使う）。使う import は `PORTABLE_CREDENTIAL_STORE_IMPORTS_SOURCE`、偽の部品は
 * `portableTestProtectorSourceOf` の本文。
 */
export const PORTABLE_CREDENTIAL_STORE_HOOK_SOURCE = String.raw`
  openCredentialStore: (root) => createCredentialStoreWith(root, {
    protector: portableProtector,
    spawnProcess: () => { throw new Error('no child process in the test worker'); },
    now: () => new Date(),
    platform: 'win32',
    renameFile: rename,
    waitBeforeRetry: async () => undefined,
  }),`;

/** 上の口と偽の部品が使う import（ESM。入口は一時のビルドの root に置き、`./dist/` を読む）。 */
export const PORTABLE_CREDENTIAL_STORE_IMPORTS_SOURCE = String.raw`
import { rename } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createCredentialStoreWith } from './dist/control/credentials/credential-store.js';`;

/** 鍵（16 進）を入れた、移せる偽の暗号化の部品の本文（`portableProtector` を作る）。 */
export const portableTestProtectorSourceOf = (protectorKey: string): string =>
  PORTABLE_TEST_PROTECTOR_SOURCE.split('__KEY__').join(JSON.stringify(protectorKey));

/** テストだけの入口の本文（ESM）。 */
export const autoLoginWorkerEntrySource = (options: AutoLoginWorkerEntryOptions): string => String.raw`
import { appendFileSync } from 'node:fs';${PORTABLE_CREDENTIAL_STORE_IMPORTS_SOURCE}
import { chromium } from 'playwright';
import { launchChromium } from './dist/browser/chromium-launch.js';
import { runAuditWorkerProcess } from './dist/worker/audit-worker-process.js';
const MANUAL_RECORD = ${JSON.stringify(options.manualStageRecord)};
${portableTestProtectorSourceOf(options.protectorKey)}${options.manualStage.kind === 'SESSION_HANDOFF' ? SESSION_HANDOFF_SOURCE : ''}
const manualStageCalled = (name) => appendFileSync(MANUAL_RECORD, name + '\n');
const launchLoginBrowser = () => ${LAUNCH_EXPRESSIONS[options.launch]};
runAuditWorkerProcess(process, {${manualStageSource(options.manualStage)}${options.launch === 'test-default' ? String.raw`
  automatedLoginStage: { launchAutomatedLoginBrowser: launchLoginBrowser },` : ''}${options.portableCredentialStore ? PORTABLE_CREDENTIAL_STORE_HOOK_SOURCE : ''}
});
`;

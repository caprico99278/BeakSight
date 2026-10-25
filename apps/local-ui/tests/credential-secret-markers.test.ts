/**
 * 資格情報の目印の検査（端から端まで。Task 26 の設計書 4.7、6 章。T26f）。T25f（`auth-secret-markers.test.ts`）と T26e
 * （`credential-ui-flows.test.ts`）の作りで、ビルドした画面を一時の root の起動の部品で起動し、画面から自動ログインの資格情報を登録・変更・削除し、
 * ログインの確かめ（`LOGIN_CHECK`）と、自動ログインの後の監査（`AUDIT`）を行って、ユーザー名とパスワードの目印が、どこにも出ないことを、バイトで
 * （UTF-8 と UTF-16LE の両方で）検索して確かめる。
 * - 対照（どの OS でも）: 検索の読み方が正しいこと。わざと目印を置いたファイル（UTF-8、UTF-16LE、圧縮した ZIP の中、SQLite の WAL、表の行、
 *   PowerShell の `-EncodedCommand` の中のスクリプト）で見つかり、目印のないファイルと、読まないフォルダでは見つからない。
 * - 場面（Windows だけ。本物の DPAPI。一時の root の資格情報のフォルダ。資格情報マネージャーは使わない）:
 *   (1) 画面での登録（確かめの不一致の拒否の後）→ ログインの確かめの成功 → ユーザー名だけの変更 → 確かめの成功 → パスワードだけの変更 →
 *       確かめの成功 → 削除。変更の前と後の目印（ユーザー名 2 つ、パスワード 2 つ）を検索する。
 *   (2) 自動ログインの後の監査が COMPLETE（Run のディレクトリ、ZIP の中身）。
 *   (3) 資格情報の誤りで止まり、自動ログインを止める（監査のジョブ）。
 *   (4) フォームの確かめ（GET のフォーム）で止まる（値を入れず、送らない）。
 *   (5) セッションが切れて止まった監査（checkpoint）と、その再開（もう一度自動ログイン）。
 *   (6) ログインの POST の途中で、ワーカーが落ちる（試しは結果が分からないで閉じ、止める）。ジョブが動いている間の変更の拒否の応答も含む。
 * - 検索する場所: 一時の root のすべてのファイル（Run のディレクトリ（checkpoint と、ZIP を展開した中身）、管理データのファイルと WAL と SHM、
 *   資格情報のフォルダ、記録のフォルダ。`node_modules` の junction は除く）、管理データのすべての表のすべての行（ジョブ、`auto_login_attempts`、
 *   `auto_login_holds`、`credential_events`）、画面のサーバの標準出力と標準エラー、ワーカーの標準出力と標準エラー、IPC の記録（ワーカーが親へ
 *   送ったすべてのメッセージと、親から受けたすべてのメッセージ（`START` を含む））、画面の HTML（すべての画面と成果物の画面）と Server Function の
 *   応答（成功と誤り）、子プロセスの起動の引数（画面のサーバとワーカー。PowerShell の `-EncodedCommand` は戻した本文も）。
 * - 資格情報のフォルダには、資格情報のファイル（`<profileId>.credential.json`）のほかに、一時のファイルが残らない。
 * - 子プロセスの起動の記録: 画面のサーバはテストだけの前処理（`node --import`）、ワーカーはテストだけの入口で、`node:child_process` の `spawn` を
 *   包んで、起動のファイルと引数を記録のフォルダに書き足す（製品の起動の部品は変えない）。PowerShell の起動は、決まった引数（`-EncodedCommand` の
 *   固定の文）で、環境を渡さない。
 * - 時刻の進め方: 同じプロファイルの自動ログインどうしの最小の間隔（`AUTO_LOGIN_MIN_INTERVAL_MS`）を待たずに次の試しを始めるため、ジョブが
 *   動いていない間に、管理データの `auto_login_attempts` の試し始めた時刻を、その間隔の分だけ前へずらす（テストだけの操作。上限の判定は変えない）。
 * fixture のサイトは 127.0.0.1（と、同じ port の `localhost`）だけ。Chromium は headless だけ。目印の値は実行ごとのランダムな値で、出力しない
 * （漏れた場所の名前と、文字の形だけを出す）。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { strToU8, zipSync } from 'fflate';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import {AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS } from '../../../src/control/auth/auth-setup-contracts.js';
import {
  CREDENTIAL_FILE_SUFFIX,
  MAX_CREDENTIAL_VALUE_LENGTH,
  resolveCredentialDirectory,
} from '../../../src/control/credentials/credential-store.js';
import { POWERSHELL_LAUNCH_ARGUMENTS, WINDOWS_POWERSHELL_PATH } from '../../../src/control/credentials/dpapi-protector.js';
import { AUTO_LOGIN_MIN_INTERVAL_MS } from '../../../src/control/job/auto-login-limits.js';
import { CONTROL_DATA_DIRECTORY_NAME, resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { isTemporaryFileName } from '../../../src/core/temporary-file-name.js';
import { LOCAL_UI_AUDIT_TEXT, LOCAL_UI_CREDENTIAL_TEXT } from '../../../src/presentation/messages.js';
import {
  AUTH_SITE_LOGIN_FIELDS,
  AUTH_SITE_PATHS,
  startAuthenticatedSite,
  type AuthenticatedSite,
} from '../../../tests/helpers/authenticated-site-fixture.js';
import {
  AUTOMATED_LOGIN_FIXTURE_CONDITIONS,
  AUTOMATED_LOGIN_FIXTURE_PATHS,
  AUTOMATED_LOGIN_FIXTURE_SELECTORS,
  startAutomatedLoginFixture,
  type AutomatedLoginFixture,
  type AutomatedLoginFormVariant,
  type AutomatedLoginOutcome,
} from '../../../tests/helpers/automated-login-fixture.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { openWalControlDatabase, shiftAutoLoginAttemptsBack } from '../../../tests/helpers/control-data-test-writes.js';
import { nonReadRequestsOf } from '../../../tests/helpers/leak-places.js';
import { descendantsOf, listProcesses, waitUntilExited, type ProcessIdentity } from '../../../tests/helpers/process-tree.js';
import {
  MANUAL_LOGIN_STAGE_RECORD,
  WORKER_PARENT_MESSAGE_RECORD,
  WORKER_RECORD_FILES,
  installTestAutomatedLoginWorkerEntry,
  writeAuthTargetConfig,
} from './helpers/auth-worker.ts';
import {
  createTemporaryUiRoot,
  findFreePort,
  parseSetCookie,
  rawRequest,
  startLauncherWithNodeArguments,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';
import {
  childProcessRecordingSource,
  childProcessRecordsOf,
  databaseRowsPlace,
  filesUnder,
  leakedPlaces,
  textPlace,
  writeChildProcessRecordingPreload,
  type SearchedPlace,
} from './helpers/secret-markers.ts';
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { waitForJobViaServerFunctions } from './helpers/server-function-job-wait.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

const IS_WINDOWS = process.platform === 'win32';
const SKIP_REASON = 'the automated login and the credential screen save with the real DPAPI, which exists only on Windows';

/** 画面の操作を待つ上限（ミリ秒）。 */
const UI_TIMEOUT_MS = 20_000;
/** ジョブの終わりを待つ上限（ミリ秒。ワーカーの起動、Chromium、DPAPI、結果を待つ時間、監査を含む）。 */
const JOB_TIMEOUT_MS = 180_000;
/** 1 つの場面の上限（ミリ秒）。 */
const SCENARIO_TIMEOUT_MS = 600_000;
/** process が消えるのを待つ上限（ミリ秒）。 */
const PROCESS_EXIT_LIMIT_MS = 60_000;
/** 状態を読み直す間隔（ミリ秒）。 */
const POLL_MS = 250;
/** 監査するページの上限（T26d-2 の端から端と同じ。管理画面、second、frames）。 */
const MAX_PAGES = 3;
const FIRST_REVISION = 1;
/** HTTP の状態。 */
const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400 });
/** 一時の root の検索で読まないフォルダ（リポジトリの `node_modules` への junction）。 */
const SKIPPED_DIRECTORY_NAMES = Object.freeze(['node_modules']);
/** 記録のフォルダと、画面のサーバの子プロセスの記録（一時の root の中）。 */
const RECORD_DIRECTORY_NAME = 't26f-records';
const SERVER_CHILD_PROCESS_RECORD = 'server-child-processes.jsonl';
const WORKER_CHILD_PROCESS_RECORD = 'worker-child-processes.jsonl';
const PRELOAD_FILE_NAME = 't26f-child-process-recording.mjs';

/** テストの値（匿名）。 */
const CHANGE_PROFILE = 't26f-change';
const AUDIT_PROFILE = 't26f-audit';
const INVALID_PROFILE = 't26f-invalid';
const FORM_PROFILE = 't26f-form';
const LOST_PROFILE = 't26f-lost';
const CRASH_PROFILE = 't26f-crash';

/** 実行ごとの目印（値を出力しない。`[a-z0-9-]` だけなので、URL・JSON・HTML のどの書き方でも形が変わらない）。 */
const markerOf = (name: string): string => `t26f-${name}-${randomUUID()}`;
const USER_A = markerOf('user-a');
const PASS_A = markerOf('pass-a');
const USER_B = markerOf('user-b');
const PASS_B = markerOf('pass-b');
const PASS_TYPO = markerOf('pass-typo');
const USER_WRONG = markerOf('user-wrong');
const PASS_WRONG = markerOf('pass-wrong');
const USER_FORM = markerOf('user-form');
const PASS_FORM = markerOf('pass-form');
const USER_CRASH = markerOf('user-crash');
const PASS_CRASH = markerOf('pass-crash');
const USER_REJECTED = markerOf('user-rejected');
const USER_INVALID_INPUT = markerOf('user-invalid-input');
const PASS_INVALID_INPUT = markerOf('pass-invalid-input');

const credentialText = LOCAL_UI_CREDENTIAL_TEXT;
const auditText = LOCAL_UI_AUDIT_TEXT;

// ---------------------------------------------------------------------------------------------------------------
// 対照（どの OS でも）
// ---------------------------------------------------------------------------------------------------------------

describe('T26f: the marker search finds markers placed on purpose (the control)', () => {
  it('finds a marker in UTF-8 and UTF-16LE files, in a compressed ZIP entry, in the WAL, in the table rows and in an encoded PowerShell script', () => {
    const directory = mkdtempSync(join(tmpdir(), 'beaksight-t26f-control-'));
    const control = markerOf('control');
    let database: { readonly close: () => void } | undefined;
    try {
      database = openWalControlDatabase(join(directory, 'control.sqlite'), control);
      mkdirSync(join(directory, 'nested', 'deeper'), { recursive: true });
      writeFileSync(join(directory, 'nested', 'utf8.txt'), `before ${control} after`, 'utf8');
      writeFileSync(join(directory, 'nested', 'deeper', 'utf16.txt'), Buffer.from(`before ${control} after`, 'utf16le'));
      const zipped = zipSync({ 'inner/value.json': strToU8(JSON.stringify({ values: [control, control, control] })) });
      writeFileSync(join(directory, 'bundle.zip'), zipped);
      writeFileSync(join(directory, 'clean.txt'), 'no marker here', 'utf8');
      mkdirSync(join(directory, 'node_modules'));
      writeFileSync(join(directory, 'node_modules', 'skipped.txt'), control, 'utf8');
      const script = `$value = '${control}'`;
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const records = join(directory, 'records');
      mkdirSync(records);
      writeFileSync(join(records, 'child-processes.jsonl'), `${JSON.stringify({
        process: 'control', file: WINDOWS_POWERSHELL_PATH, args: [...POWERSHELL_LAUNCH_ARGUMENTS, encoded], hasEnv: false,
      })}\n`, 'utf8');

      const places = filesUnder(directory, 'control', SKIPPED_DIRECTORY_NAMES);
      const childProcesses = childProcessRecordsOf(join(records, 'child-processes.jsonl'), 'control-process');
      const rows = databaseRowsPlace(join(directory, 'control.sqlite'), 'control-rows');
      const leaked = leakedPlaces([...places, ...childProcesses.places, rows.place], [control]);
      expect(leaked).toEqual(expect.arrayContaining([
        'control:nested/utf8.txt (utf8)',
        'control:nested/deeper/utf16.txt (utf16le)',
        'control:bundle.zip!inner/value.json (utf8)',
        'control:control.sqlite-wal (utf8)',
        'control-rows (utf8)',
        'control-process:1:script (utf16le)',
      ]));
      // 読み方の違いが要ること: 圧縮した ZIP の本体、UTF-16LE のファイルの UTF-8 の形、base64 の起動の引数には、そのままの目印がない。
      expect(leaked).not.toContain('control:bundle.zip (utf8)');
      expect(leaked).not.toContain('control:nested/deeper/utf16.txt (utf8)');
      expect(leaked.filter((place) => place.startsWith('control-process:1 ') || place.startsWith('control:records/'))).toEqual([]);
      // 目印のないファイルと、読まないフォルダでは見つからない。
      expect(leaked.filter((place) => place.includes('clean.txt') || place.includes('node_modules'))).toEqual([]);
      expect(childProcesses.records).toEqual([{ process: 'control', file: WINDOWS_POWERSHELL_PATH, args: [...POWERSHELL_LAUNCH_ARGUMENTS, encoded], hasEnv: false }]);
      expect(leakedPlaces(places, [markerOf('absent')])).toEqual([]);
    } finally {
      database?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 端から端（Windows だけ。本物の DPAPI）
// ---------------------------------------------------------------------------------------------------------------

let root: TemporaryUiRoot | undefined;
let autoFixture: AutomatedLoginFixture | undefined;
let auditSite: AuthenticatedSite | undefined;
let lostSite: AuthenticatedSite | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();
let slowPosts = 0;
/** 自動ログインの fixture の正しい資格情報（変更の場面で、テストが入れ替える）。 */
const validCredentials = { username: USER_A, password: PASS_A };
/** 認証つきの fixture のサイトの資格情報（`fillCredentials` で受け取る。目印）。 */
const siteCredentials = new Map<string, { readonly username: string; readonly password: string }>();
/** 監査の間に見つけた、画面のサーバの子孫（ワーカーと Chromium）。 */
const descendants: ProcessIdentity[] = [];
/** 画面の HTML（ブラウザで開いたもの）と、Server Function の応答の本文（ブラウザとテストの両方）。 */
const htmlSnapshots: { readonly path: string; readonly html: string }[] = [];
const responseBodies: string[] = [];
/** 始めたジョブの ID。 */
const jobIds: string[] = [];

const rootOf = (): string => {
  if (root === undefined) {
    throw new Error('一時の root がない');
  }
  return root.root;
};
const started = (): StartedServer => {
  if (server === undefined) {
    throw new Error('サーバが起動していない');
  }
  return server;
};
const fixtureOf = (): AutomatedLoginFixture => {
  if (autoFixture === undefined) {
    throw new Error('自動ログインの fixture が起動していない');
  }
  return autoFixture;
};
const siteOf = (site: AuthenticatedSite | undefined): AuthenticatedSite => {
  if (site === undefined) {
    throw new Error('認証つきの fixture のサイトが起動していない');
  }
  return site;
};
const recordDirectory = (): string => `${rootOf()}/${RECORD_DIRECTORY_NAME}`;
const databasePath = (): string => resolveControlDatabasePath(rootOf());

/** 検索するすべての目印（資格情報の目印と、認証つきの fixture のサイトのセッションの値）。 */
const allMarkers = (): readonly string[] => [
  USER_A, PASS_A, USER_B, PASS_B, PASS_TYPO, USER_WRONG, PASS_WRONG, USER_FORM, PASS_FORM, USER_CRASH, PASS_CRASH, USER_REJECTED,
  USER_INVALID_INPUT, PASS_INVALID_INPUT,
  ...[...siteCredentials.values()].flatMap(({ username, password }) => [username, password]),
  ...(auditSite?.secretValues() ?? []),
  ...(lostSite?.secretValues() ?? []),
];

/** 画面のページを開く（記録は付けない。Server Function の応答の本文と、HTML を集める。CCX-16 の共通の補助）。 */
const { openPage, forgetPages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  recordPages: false,
  onPageCreated: (page) => {
    page.on('response', (response) => {
      if (response.url().includes('/_serverFn/')) {
        void response.text().then((body) => responseBodies.push(body), () => undefined);
      }
    });
  },
  afterOpen: (page) => snapshot(page),
});

const snapshot = async (page: Page): Promise<void> => {
  htmlSnapshots.push({ path: new URL(page.url()).pathname, html: await page.content() });
};

const callFunction = async (name: string, method: 'GET' | 'POST', data?: unknown) => {
  const result = await callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
  responseBodies.push(result.response.body);
  return result;
};

const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await callFunction(name, method, data);
  expect(result.response.status, `${name} status`).toBe(STATUS.OK);
  return result.value as T;
};

/** 画面のサーバの子孫（ワーカーと Chromium）を記録する。 */
const recordDescendants = async (): Promise<void> => {
  descendants.push(...descendantsOf(started().child.pid ?? 0, await listProcesses()));
};

/** 資格情報の画面の欄（ラベルは完全一致）。 */
const field = (page: Page, label: string): Locator => page.getByLabel(label, { exact: true });

/** 資格情報の画面の、終わりの知らせか拒否のどちらかが出るまで待つ。 */
const waitForCredentialOutcome = async (page: Page): Promise<void> => {
  await page.locator('[data-testid="credential-done"], [data-testid="credential-rejection"]').first().waitFor({ timeout: UI_TIMEOUT_MS });
  await snapshot(page);
};

/** 資格情報の画面で、新しく登録する（Enter で送る）。拒否の理由（なければ `null`）を返す。 */
const registerOnPage = async (profileId: string, username: string, password: string, confirmation: string = password): Promise<string | null> => {
  const page = await openPage(`/credentials/${profileId}`);
  await page.getByTestId('credential-register-form').waitFor({ timeout: UI_TIMEOUT_MS });
  await field(page, credentialText.username).fill(username);
  await field(page, credentialText.password).fill(password);
  const confirmationField = field(page, credentialText.passwordConfirmation);
  await confirmationField.fill(confirmation);
  await confirmationField.press('Enter');
  await waitForCredentialOutcome(page);
  return page.getByTestId('credential-rejection').count().then(async (count) =>
    (count === 0 ? null : page.getByTestId('credential-rejection').getAttribute('data-reason')));
};

/** 資格情報の画面で、ユーザー名だけか、パスワードだけを変える。最後の変更の種類を返す。 */
const changeOnPage = async (profileId: string, kind: 'username' | 'password', value: string): Promise<string | null> => {
  const page = await openPage(`/credentials/${profileId}`);
  await page.getByTestId('credential-change-form').waitFor({ timeout: UI_TIMEOUT_MS });
  if (kind === 'username') {
    await page.getByLabel(credentialText.change.changeUsername).check();
    await field(page, credentialText.change.newUsername).fill(value);
  } else {
    await page.getByLabel(credentialText.change.changePassword).check();
    await field(page, credentialText.change.newPassword).fill(value);
    await field(page, credentialText.change.newPasswordConfirmation).fill(value);
  }
  await page.getByTestId('credential-change-submit').click();
  await waitForCredentialOutcome(page);
  expect(await page.getByTestId('credential-rejection').count()).toBe(0);
  return page.getByTestId('credential-last-change').getAttribute('data-kind');
};

/** 資格情報の画面で、確かめのダイアログの後に削除する。 */
const removeOnPage = async (profileId: string): Promise<void> => {
  const page = await openPage(`/credentials/${profileId}`);
  await page.getByTestId('credential-remove').click();
  const dialog = page.getByRole('dialog', { name: credentialText.remove.title });
  await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
  // 開いたときは「やめる」にフォーカスがある。Tab で「削除する」へ移って押す。
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.locator('[data-testid="credential-done"][data-notice="removed"]').waitFor({ timeout: UI_TIMEOUT_MS });
  await snapshot(page);
};

interface JobDetail {
  readonly jobId: string;
  readonly jobKind: string;
  readonly active: boolean;
  readonly state: string;
  readonly runId: string | null;
  readonly runStatus: string | null;
  readonly failureReason: string | null;
  readonly lastAuthState: string | null;
  readonly autoLogin: {
    readonly result: string | null;
    readonly submitted: string | null;
    readonly formInvalidReason: string | null;
  } | null;
  readonly artifacts: readonly { readonly href: string }[];
}

/** ジョブが終わるまで待つ。 */
const waitForJobEnd = async (jobId: string): Promise<JobDetail> => {
  await recordDescendants();
  // PRE42-CC 組 UI-K2（CC-112）: 読み直して待つのは補助 `waitForJobViaServerFunctions`（上限と間隔は前と同じ）。
  return waitForJobViaServerFunctions(
    (id) => valueOf<JobDetail | null>('getAuditJobFn', 'GET', { jobId: id }),
    jobId,
    (job) => !job.active,
    { limitMs: JOB_TIMEOUT_MS, stepMs: POLL_MS },
  );
};

/** 開いたページの移動の先のジョブの ID を覚えて返す。 */
const jobIdOf = async (page: Page): Promise<string> => {
  await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
  const jobId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  jobIds.push(jobId);
  return jobId;
};

/** ジョブの画面で、終わった状態が出るまで待って、HTML を集める。 */
const snapshotEndedJob = async (page: Page): Promise<void> => {
  await page.locator('[data-testid="job-state"]:not([data-state="STARTING"]):not([data-state="RUNNING"]):not([data-state="STOPPING"])')
    .waitFor({ timeout: JOB_TIMEOUT_MS });
  await snapshot(page);
};

/** ログインの確かめの画面から、ログインの確かめを始める。ジョブの画面とジョブの ID を返す。 */
const startLoginCheckOnPage = async (profileId: string): Promise<{ readonly page: Page; readonly jobId: string }> => {
  const page = await openPage(`/login-check/${profileId}`);
  await page.getByTestId('login-check-start').click();
  return { page, jobId: await jobIdOf(page) };
};

/** ログインの確かめを始めて、終わるまで待つ。 */
const loginCheckOnPage = async (profileId: string): Promise<JobDetail> => {
  const { page, jobId } = await startLoginCheckOnPage(profileId);
  const job = await waitForJobEnd(jobId);
  await snapshotEndedJob(page);
  return job;
};

/** 開始の画面から監査を始めて（`startNew` に合わせて選ぶ）、終わるまで待つ。 */
const auditOnPage = async (profileId: string, startNew: boolean): Promise<JobDetail> => {
  const page = await openPage(`/start/${profileId}`);
  await page.getByTestId('start-login').waitFor({ timeout: UI_TIMEOUT_MS });
  await page.getByRole('radio', { name: startNew ? auditText.start.startNew : auditText.start.resume }).check();
  await page.getByRole('button', { name: auditText.start.submit }).click();
  const jobId = await jobIdOf(page);
  const job = await waitForJobEnd(jobId);
  await snapshotEndedJob(page);
  return job;
};

/** ジョブが動いていない間に、プロファイルの試し始めた時刻を、最小の間隔の分だけ前へずらす（テストだけの操作）。 */
const passMinimumInterval = (profileId: string): void => {
  expect(shiftAutoLoginAttemptsBack(databasePath(), profileId, AUTO_LOGIN_MIN_INTERVAL_MS)).toBeGreaterThan(0);
};

/** 自動ログインを止めているか（資格情報の画面の値）。 */
const isHeld = async (profileId: string): Promise<boolean> => {
  const page = await openPage(`/credentials/${profileId}`);
  return (await page.getByTestId('credential-hold').getAttribute('data-held')) === 'yes';
};

/** fixture の自動ログインの認証の設定。 */
const fixtureSetupOf = (profileId: string, variant: AutomatedLoginFormVariant, outcome: AutomatedLoginOutcome): Record<string, unknown> => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId,
  profileRevision: FIRST_REVISION,
  loginStartUrl: fixtureOf().formUrl(variant, outcome),
  loginPostEndpoints: [{ origin: fixtureOf().originA, path: fixtureOf().authPath(outcome) }],
  successCondition: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.success,
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/logout'],
  auditPathPrefixes: [AUTOMATED_LOGIN_FIXTURE_PATHS.home],
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  allowedIdpOrigins: [],
  automatedLogin: {
    usernameSelector: AUTOMATED_LOGIN_FIXTURE_SELECTORS.username,
    passwordSelector: AUTOMATED_LOGIN_FIXTURE_SELECTORS.password,
    submitSelector: AUTOMATED_LOGIN_FIXTURE_SELECTORS.submit,
    failureConditions: {
      invalidCredentials: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.invalidCredentials,
      accountLocked: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.accountLocked,
      mfaRequired: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.mfaRequired,
      credentialExpired: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.credentialExpired,
    },
  },
});

/** 認証つきの fixture のサイトの、自動ログインの認証の設定（T26d-2 の端から端と同じ）。 */
const siteSetupOf = (profileId: string, site: AuthenticatedSite): Record<string, unknown> => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId,
  profileRevision: FIRST_REVISION,
  loginStartUrl: `${site.originA}${AUTH_SITE_PATHS.login}`,
  loginPostEndpoints: [{ origin: site.originA, path: AUTH_SITE_PATHS.login }],
  successCondition: { pathPrefix: AUTH_SITE_PATHS.admin, selector: '#admin-ok' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [AUTH_SITE_PATHS.adminLogout],
  auditPathPrefixes: [AUTH_SITE_PATHS.admin],
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  allowedIdpOrigins: [],
  automatedLogin: {
    usernameSelector: AUTH_SITE_LOGIN_FIELDS.user,
    passwordSelector: AUTH_SITE_LOGIN_FIELDS.pass,
    submitSelector: AUTH_SITE_LOGIN_FIELDS.submit,
    failureConditions: {
      invalidCredentials: { pathPrefix: AUTH_SITE_PATHS.login, selector: '#login-failed' },
      accountLocked: null,
      mfaRequired: null,
      credentialExpired: null,
    },
  },
});

/** 自動ログインのプロファイルと認証の設定を作る（ターゲット設定は、監査の対象の Origin だけを許す）。 */
const prepareProfile = async (profileId: string, origin: string, startPath: string, setup: Record<string, unknown>): Promise<void> => {
  const targetConfigPath = writeAuthTargetConfig(rootOf(), profileId, origin, startPath, MAX_PAGES);
  expect(await valueOf('createProfileFn', 'POST', {
    profile: {
      schemaVersion: 'beaksight-profile/1',
      profileId,
      revision: FIRST_REVISION,
      targetConfigPath,
      environment: 'TEST',
      mode: 'TEST_AUTH_PASSIVE',
      auth: 'AUTOMATED_LOGIN',
      approvedTestOrigins: [origin],
      environmentEvidenceRef: 't26f-evidence',
    },
  })).toMatchObject({ ok: true });
  expect(await valueOf('saveAuthSetupFn', 'POST', { setup })).toMatchObject({ ok: true });
};

/** 認証つきの fixture のサイトの正しい資格情報（値はテストの process の中だけ。目印として覚える）。 */
const credentialsOfSite = async (site: AuthenticatedSite): Promise<{ readonly username: string; readonly password: string }> => {
  const values = new Map<string, string>();
  await site.fillCredentials(async (selector, value) => {
    values.set(selector, value);
  });
  return { username: values.get(AUTH_SITE_LOGIN_FIELDS.user) ?? '', password: values.get(AUTH_SITE_LOGIN_FIELDS.pass) ?? '' };
};

const PROFILE_PATHS = Object.freeze(['/profiles/', '/auth-setup/', '/credentials/', '/login-check/', '/start/']);

/** 画面の HTML（すべての画面。サーバで描いたもの）と、成果物の画面。 */
const screenPlaces = async (): Promise<readonly SearchedPlace[]> => {
  const paths = ['/', '/jobs', '/environment'];
  for (const profileId of [CHANGE_PROFILE, AUDIT_PROFILE, INVALID_PROFILE, FORM_PROFILE, LOST_PROFILE, CRASH_PROFILE]) {
    paths.push(...PROFILE_PATHS.map((prefix) => `${prefix}${profileId}`));
  }
  const artifactPaths: string[] = [];
  for (const jobId of jobIds) {
    paths.push(`/jobs/${jobId}`);
    const job = await valueOf<JobDetail | null>('getAuditJobFn', 'GET', { jobId });
    artifactPaths.push(...(job?.artifacts ?? []).map(({ href }) => href));
  }
  const places: SearchedPlace[] = [];
  for (const path of [...paths, ...artifactPaths]) {
    const response = await rawRequest(started().port, path, { headers: { cookie } });
    expect(response.status, path).toBe(STATUS.OK);
    places.push(textPlace(`html:${path}`, response.body));
  }
  places.push(...htmlSnapshots.map(({ path, html }, index) => textPlace(`browser-html:${index}:${path}`, html)));
  return places;
};

/** Server Function の応答（読むもののすべてを、いま読む。集めた応答も含める）。 */
const functionPlaces = async (): Promise<readonly SearchedPlace[]> => {
  const calls: (readonly [string, unknown])[] = [['listProfilesFn', undefined], ['listAuditJobsFn', undefined], ['environmentStatusFn', undefined]];
  for (const profileId of [CHANGE_PROFILE, AUDIT_PROFILE, INVALID_PROFILE, FORM_PROFILE, LOST_PROFILE, CRASH_PROFILE]) {
    for (const name of ['getProfileFn', 'getAuthSetupFn', 'getCredentialPageFn', 'auditStartSummaryFn']) {
      calls.push([name, { profileId }]);
    }
  }
  calls.push(...jobIds.map((jobId) => ['getAuditJobFn', { jobId }] as const));
  for (const [name, data] of calls) {
    await valueOf(name, 'GET', data);
  }
  return responseBodies.map((body, index) => textPlace(`function:${index}`, body));
};

/** 検索の結果（場所の一覧と、漏れた場所）。 */
interface MarkerSearch {
  readonly places: readonly SearchedPlace[];
  readonly leaked: readonly string[];
}

/** 検索するすべての場所で、目印を探す。 */
const searchEverywhere = async (): Promise<MarkerSearch> => {
  const serverProcesses = childProcessRecordsOf(`${recordDirectory()}/${SERVER_CHILD_PROCESS_RECORD}`, 'server-process');
  const workerProcesses = childProcessRecordsOf(`${recordDirectory()}/${WORKER_CHILD_PROCESS_RECORD}`, 'worker-process');
  const places: SearchedPlace[] = [
    ...filesUnder(rootOf(), 'root', SKIPPED_DIRECTORY_NAMES),
    databaseRowsPlace(databasePath(), 'database:rows').place,
    textPlace('server:output', started().output()),
    ...serverProcesses.places,
    ...workerProcesses.places,
    ...await screenPlaces(),
    ...await functionPlaces(),
  ];
  console.info(`[CCX-16] t26f searched places: ${places.length}`);
  return { places, leaked: leakedPlaces(places, allMarkers()) };
};

/** 資格情報のフォルダのファイルの名前（資格情報のファイルだけで、一時のファイルがないこと）。 */
const credentialFileNames = (): readonly string[] => {
  const directory = resolveCredentialDirectory(rootOf());
  return existsSync(directory) ? readdirSync(directory) : [];
};

const expectOnlyCredentialFiles = (profileIds: readonly string[]): void => {
  const names = credentialFileNames();
  expect(names.filter((name) => isTemporaryFileName(name))).toEqual([]);
  expect([...names].sort()).toEqual(profileIds.map((profileId) => `${profileId}${CREDENTIAL_FILE_SUFFIX}`).sort());
};

/** 目印がどこにもないことを確かめる（漏れた場所の名前と文字の形だけを出す）。 */
const expectNoMarkerAnywhere = async (scenario: string): Promise<MarkerSearch> => {
  const search = await searchEverywhere();
  expect(search.leaked, scenario).toEqual([]);
  // 検索した場所に、管理データのファイルと WAL と SHM、IPC の記録、ワーカーの出力の記録が入っている。
  const names = search.places.map(({ place }) => place);
  const localData = `root:${CONTROL_DATA_DIRECTORY_NAME}/`;
  expect(names.some((name) => name.startsWith(localData) && name.endsWith('-wal')), scenario).toBe(true);
  expect(names.some((name) => name.startsWith(localData) && name.endsWith('-shm')), scenario).toBe(true);
  expect(names).toContain(`root:${RECORD_DIRECTORY_NAME}/${WORKER_RECORD_FILES.ipc}`);
  expect(names).toContain(`root:${RECORD_DIRECTORY_NAME}/${WORKER_PARENT_MESSAGE_RECORD}`);
  return search;
};

describe.skipIf(!IS_WINDOWS)(`T26f: no credential marker anywhere in the automated login flows${IS_WINDOWS ? '' : ` [skipped: ${SKIP_REASON}]`}`, () => {
  beforeAll(async () => {
    root = createTemporaryUiRoot('built');
    mkdirSync(recordDirectory(), { recursive: true });
    installTestAutomatedLoginWorkerEntry(root.root, recordDirectory(), {
      recordParentMessages: true,
      prelude: childProcessRecordingSource(`${recordDirectory()}/${WORKER_CHILD_PROCESS_RECORD}`, 'worker'),
    });
    const preload = writeChildProcessRecordingPreload(`${root.root}/${PRELOAD_FILE_NAME}`, `${recordDirectory()}/${SERVER_CHILD_PROCESS_RECORD}`, 'server');
    autoFixture = await startAutomatedLoginFixture({
      get username() { return validCredentials.username; },
      get password() { return validCredentials.password; },
      onSlowPost: () => { slowPosts += 1; },
    });
    auditSite = await startAuthenticatedSite({ loginForm: true, rotate: true });
    lostSite = await startAuthenticatedSite({ loginForm: true, rotate: true, expireFirstSessionAtPath: AUTH_SITE_PATHS.adminSecond });
    siteCredentials.set(AUDIT_PROFILE, await credentialsOfSite(auditSite));
    siteCredentials.set(LOST_PROFILE, await credentialsOfSite(lostSite));
    ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
    browser = await launchHeadlessChromium();
    server = await startLauncherWithNodeArguments(root, await findFreePort(), ['--import', preload]);
    context = await browser.newContext();
    const tokenPage = await context.newPage();
    await tokenPage.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
    await tokenPage.close();
    const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
    cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
    const fixture = fixtureOf();
    const home = AUTOMATED_LOGIN_FIXTURE_PATHS.home;
    await prepareProfile(CHANGE_PROFILE, fixture.originA, home, fixtureSetupOf(CHANGE_PROFILE, 'standard', 'success'));
    await prepareProfile(INVALID_PROFILE, fixture.originA, home, fixtureSetupOf(INVALID_PROFILE, 'standard', 'success'));
    await prepareProfile(FORM_PROFILE, fixture.originA, home, fixtureSetupOf(FORM_PROFILE, 'get', 'success'));
    await prepareProfile(CRASH_PROFILE, fixture.originA, home, fixtureSetupOf(CRASH_PROFILE, 'standard', 'slow'));
    await prepareProfile(AUDIT_PROFILE, auditSite.originA, AUTH_SITE_PATHS.admin, siteSetupOf(AUDIT_PROFILE, auditSite));
    await prepareProfile(LOST_PROFILE, lostSite.originA, AUTH_SITE_PATHS.admin, siteSetupOf(LOST_PROFILE, lostSite));
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await forgetPages();
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await stopServer(server);
    expect(await waitUntilExited(descendants, PROCESS_EXIT_LIMIT_MS)).toEqual([]);
    await autoFixture?.close();
    await auditSite?.close();
    await lostSite?.close();
    root?.remove();
  }, SCENARIO_TIMEOUT_MS);

  it('registers on the screen after a mismatch, checks the login, changes the username only and the password only (checking after each), and deletes', async () => {
    const fixture = fixtureOf();
    // 確かめの不一致の拒否（誤りの応答）→ 登録。
    expect(await registerOnPage(CHANGE_PROFILE, USER_A, PASS_A, PASS_TYPO)).toBe('CREDENTIAL_CONFIRMATION_MISMATCH');
    expect(await registerOnPage(CHANGE_PROFILE, USER_A, PASS_A)).toBeNull();
    expectOnlyCredentialFiles([CHANGE_PROFILE]);
    const since = fixture.requests.length;
    expect(await loginCheckOnPage(CHANGE_PROFILE)).toMatchObject({ jobKind: 'LOGIN_CHECK', autoLogin: { result: 'SUCCEEDED', submitted: 'YES' } });
    await expectNoMarkerAnywhere('registered and checked');

    // ユーザー名だけを変える（fixture の正しいユーザー名も変える）→ 新しいユーザー名でログインが通る。
    expect(await changeOnPage(CHANGE_PROFILE, 'username', USER_B)).toBe('USERNAME_CHANGED');
    validCredentials.username = USER_B;
    expectOnlyCredentialFiles([CHANGE_PROFILE]);
    passMinimumInterval(CHANGE_PROFILE);
    expect(await loginCheckOnPage(CHANGE_PROFILE)).toMatchObject({ autoLogin: { result: 'SUCCEEDED', submitted: 'YES' } });
    await expectNoMarkerAnywhere('username changed and checked');

    // パスワードだけを変える → 新しいパスワードでログインが通る。
    expect(await changeOnPage(CHANGE_PROFILE, 'password', PASS_B)).toBe('PASSWORD_CHANGED');
    validCredentials.password = PASS_B;
    expectOnlyCredentialFiles([CHANGE_PROFILE]);
    passMinimumInterval(CHANGE_PROFILE);
    expect(await loginCheckOnPage(CHANGE_PROFILE)).toMatchObject({ autoLogin: { result: 'SUCCEEDED', submitted: 'YES' } });
    // 3 回とも、ログインの POST の 1 回だけを送った。
    const loginPost = `POST ${fixture.authPath('success')}`;
    expect(nonReadRequestsOf(fixture.requests, since)).toEqual([loginPost, loginPost, loginPost]);
    await expectNoMarkerAnywhere('password changed and checked');

    // 削除 → 資格情報のファイルが消え、一時のファイルも残らない。
    await removeOnPage(CHANGE_PROFILE);
    expectOnlyCredentialFiles([]);
    const events = new DatabaseSync(databasePath(), { readOnly: true });
    try {
      expect(events.prepare('SELECT kind, credential_revision AS revision FROM credential_events WHERE profile_id = ? ORDER BY event_id').all(CHANGE_PROFILE))
        .toEqual([
          { kind: 'CREATED', revision: 1 },
          { kind: 'USERNAME_CHANGED', revision: 2 },
          { kind: 'PASSWORD_CHANGED', revision: 3 },
          // 削除の記録の改訂の番号は、削除した資格情報の最後の番号。
          { kind: 'DELETED', revision: 3 },
        ]);
    } finally {
      events.close();
    }
    await expectNoMarkerAnywhere('deleted');
  }, SCENARIO_TIMEOUT_MS);

  it('logs in automatically and audits read only to COMPLETE, and no marker is in the Run directory or its ZIP', async () => {
    const site = siteOf(auditSite);
    const credential = siteCredentials.get(AUDIT_PROFILE) ?? { username: '', password: '' };
    expect(await registerOnPage(AUDIT_PROFILE, credential.username, credential.password)).toBeNull();
    const job = await auditOnPage(AUDIT_PROFILE, true);
    expect(job).toMatchObject({
      jobKind: 'AUDIT',
      state: 'FINISHED',
      runStatus: 'COMPLETE',
      lastAuthState: 'AUTHENTICATED',
      autoLogin: { result: 'SUCCEEDED', submitted: 'YES' },
    });
    expect(site.successfulLogins).toBe(1);
    expect(nonReadRequestsOf(site.requests)).toEqual([`POST ${AUTH_SITE_PATHS.login}`]);
    const search = await expectNoMarkerAnywhere('audit completed');
    expect(search.places.some(({ place }) => place.startsWith(`root:t25e-output-${AUDIT_PROFILE}/`) && place.includes('.zip!'))).toBe(true);
    expect(search.places.some(({ place }) => place.startsWith('html:/artifacts/'))).toBe(true);
  }, SCENARIO_TIMEOUT_MS);

  it('stops the audit on invalid credentials, holds the automated login, and no marker is anywhere', async () => {
    const fixture = fixtureOf();
    expect(await registerOnPage(INVALID_PROFILE, USER_WRONG, PASS_WRONG)).toBeNull();
    const since = fixture.requests.length;
    const job = await auditOnPage(INVALID_PROFILE, true);
    expect(job).toMatchObject({
      jobKind: 'AUDIT',
      state: 'FAILED',
      failureReason: 'INVALID_CREDENTIALS',
      runId: null,
      autoLogin: { result: 'INVALID_CREDENTIALS', submitted: 'YES' },
    });
    expect(nonReadRequestsOf(fixture.requests, since)).toEqual([`POST ${fixture.authPath('success')}`]);
    expect(await isHeld(INVALID_PROFILE)).toBe(true);
    await expectNoMarkerAnywhere('invalid credentials');
  }, SCENARIO_TIMEOUT_MS);

  it('stops at the form check of a GET form without entering or sending the values, and no marker is anywhere', async () => {
    const fixture = fixtureOf();
    expect(await registerOnPage(FORM_PROFILE, USER_FORM, PASS_FORM)).toBeNull();
    const since = fixture.requests.length;
    const job = await loginCheckOnPage(FORM_PROFILE);
    expect(job).toMatchObject({
      jobKind: 'LOGIN_CHECK',
      state: 'FAILED',
      autoLogin: { result: 'LOGIN_FORM_INVALID', submitted: 'NO', formInvalidReason: 'METHOD_NOT_POST' },
    });
    // 読み取りでない要求も、目印を載せた要求も、サーバに届かない。止めない（送っていないため）。
    expect(nonReadRequestsOf(fixture.requests, since)).toEqual([]);
    expect(fixture.requests.slice(since).filter(({ path, body }) => [USER_FORM, PASS_FORM].some((marker) => path.includes(marker) || body.includes(marker))))
      .toEqual([]);
    expect(await isHeld(FORM_PROFILE)).toBe(false);
    await expectNoMarkerAnywhere('form check');
  }, SCENARIO_TIMEOUT_MS);

  it('stops on a lost session (with a checkpoint) and resumes with another automated login, and no marker is anywhere after either', async () => {
    const site = siteOf(lostSite);
    const credential = siteCredentials.get(LOST_PROFILE) ?? { username: '', password: '' };
    expect(await registerOnPage(LOST_PROFILE, credential.username, credential.password)).toBeNull();
    const stopped = await auditOnPage(LOST_PROFILE, true);
    expect(stopped).toMatchObject({ state: 'FINISHED', runStatus: 'PARTIAL', lastAuthState: 'SESSION_LOST', autoLogin: { result: 'SUCCEEDED' } });
    const stoppedSearch = await expectNoMarkerAnywhere('session lost');
    expect(stoppedSearch.places.some(({ place }) => place.startsWith(`root:t25e-output-${LOST_PROFILE}/`) && place.includes('/checkpoint/'))).toBe(true);

    passMinimumInterval(LOST_PROFILE);
    const resumed = await auditOnPage(LOST_PROFILE, false);
    expect(resumed).toMatchObject({
      state: 'FINISHED',
      runStatus: 'COMPLETE',
      runId: stopped.runId,
      lastAuthState: 'AUTHENTICATED',
      autoLogin: { result: 'SUCCEEDED', submitted: 'YES' },
    });
    expect(site.successfulLogins).toBe(2);
    expect(nonReadRequestsOf(site.requests)).toEqual([`POST ${AUTH_SITE_PATHS.login}`, `POST ${AUTH_SITE_PATHS.login}`]);
    await expectNoMarkerAnywhere('resumed');
  }, SCENARIO_TIMEOUT_MS);

  it('closes the attempt as unknown and holds when the worker dies during the login POST, and no marker is anywhere', async () => {
    expect(await registerOnPage(CRASH_PROFILE, USER_CRASH, PASS_CRASH)).toBeNull();
    const postsBefore = slowPosts;
    const { page, jobId } = await startLoginCheckOnPage(CRASH_PROFILE);
    await expect.poll(() => slowPosts, { timeout: JOB_TIMEOUT_MS, interval: POLL_MS }).toBeGreaterThan(postsBefore);
    await recordDescendants();

    // ジョブが動いている間の変更は拒む（誤りの応答に値を入れない）。
    expect(await valueOf('changeCredentialFn', 'POST', {
      profileId: CRASH_PROFILE, username: USER_REJECTED, password: null, passwordConfirmation: null, clearHold: false,
    })).toEqual({ ok: false, reason: 'CREDENTIAL_IN_USE', field: null });
    // スキーマに合わない入力（長すぎる値、余分な項目）の誤りの応答にも、値を入れない。
    for (const data of [
      { profileId: CRASH_PROFILE, username: `${USER_INVALID_INPUT}${'a'.repeat(MAX_CREDENTIAL_VALUE_LENGTH)}`, password: PASS_INVALID_INPUT, passwordConfirmation: PASS_INVALID_INPUT },
      { profileId: CRASH_PROFILE, username: USER_INVALID_INPUT, password: PASS_INVALID_INPUT, passwordConfirmation: PASS_INVALID_INPUT, extra: PASS_INVALID_INPUT },
    ]) {
      expect((await callFunction('registerCredentialFn', 'POST', data)).response.status).toBe(STATUS.BAD_REQUEST);
    }

    // ログインの POST の応答を待っている間に、ワーカーを止める（落ちる）。
    const database = new DatabaseSync(databasePath(), { readOnly: true });
    let workerPid = 0;
    try {
      workerPid = Number((database.prepare('SELECT worker_pid FROM jobs WHERE job_id = ?').get(jobId) as { worker_pid: number | null } | undefined)?.worker_pid ?? 0);
    } finally {
      database.close();
    }
    expect(workerPid).toBeGreaterThan(0);
    process.kill(workerPid);
    const job = await waitForJobEnd(jobId);
    await snapshotEndedJob(page);
    expect(job).toMatchObject({ jobKind: 'LOGIN_CHECK', state: 'INTERRUPTED', autoLogin: { result: 'AUTH_RESULT_UNKNOWN', submitted: 'UNKNOWN' } });
    expect(await isHeld(CRASH_PROFILE)).toBe(true);
    await expectNoMarkerAnywhere('worker died');
  }, SCENARIO_TIMEOUT_MS);

  it('records the PowerShell launches of the server and the worker with the fixed arguments, the IPC both ways, and leaves only credential files', async () => {
    const search = await expectNoMarkerAnywhere('final');
    const records = [
      ...childProcessRecordsOf(`${recordDirectory()}/${SERVER_CHILD_PROCESS_RECORD}`, 'server-process').records,
      ...childProcessRecordsOf(`${recordDirectory()}/${WORKER_CHILD_PROCESS_RECORD}`, 'worker-process').records,
    ];
    const powerShell = records.filter(({ file }) => file === WINDOWS_POWERSHELL_PATH);
    // 画面のサーバ（暗号化・権限の確かめ）とワーカー（復号）の両方で、PowerShell を起動した。
    expect(powerShell.filter(({ process: label }) => label === 'server').length).toBeGreaterThan(0);
    expect(powerShell.filter(({ process: label }) => label === 'worker').length).toBeGreaterThan(0);
    for (const record of powerShell) {
      expect(record.args.slice(0, POWERSHELL_LAUNCH_ARGUMENTS.length)).toEqual([...POWERSHELL_LAUNCH_ARGUMENTS]);
      expect(record.args.length).toBe(POWERSHELL_LAUNCH_ARGUMENTS.length + 1);
      expect(record.hasEnv).toBe(false);
    }
    expect(search.places.filter(({ place }) => place.endsWith(':script')).length).toBe(powerShell.length);
    // IPC の記録: 親から受けた `START` と、親へ送った自動ログインの結果（`AUTH_STATE`）がある。
    const parentMessages = search.places.find(({ place }) => place === `root:${RECORD_DIRECTORY_NAME}/${WORKER_PARENT_MESSAGE_RECORD}`);
    const workerMessages = search.places.find(({ place }) => place === `root:${RECORD_DIRECTORY_NAME}/${WORKER_RECORD_FILES.ipc}`);
    const typesOf = (place: SearchedPlace | undefined): readonly string[] => Buffer.from(place?.bytes ?? new Uint8Array()).toString('utf8')
      .split('\n').filter((line) => line.length > 0).map((line) => String((JSON.parse(line) as Record<string, unknown>)['type']));
    expect(typesOf(parentMessages).filter((type) => type === 'START').length).toBe(jobIds.length);
    expect(typesOf(workerMessages)).toContain('AUTH_STATE');
    // 管理データの新しい表に行がある（検索した行が空でない）。
    const rows = databaseRowsPlace(databasePath(), 'database:rows');
    for (const table of ['jobs', 'auto_login_attempts', 'auto_login_holds', 'credential_events']) {
      expect(rows.rowCounts.get(table) ?? 0, table).toBeGreaterThan(0);
    }
    // 自動ログインは、手動のログインの段へ切り替えない。資格情報のフォルダには、資格情報のファイルだけ。
    expect(existsSync(`${recordDirectory()}/${MANUAL_LOGIN_STAGE_RECORD}`)).toBe(false);
    expectOnlyCredentialFiles([AUDIT_PROFILE, INVALID_PROFILE, FORM_PROFILE, LOST_PROFILE, CRASH_PROFILE]);
    // 目印は、fixture のサイトへの要求の URL に載らない（本文に載るのは、ログインの POST だけ）。
    const fixture = fixtureOf();
    expect(fixture.requests.filter(({ path }) => allMarkers().some((marker) => path.includes(marker))).length).toBe(0);
    expect([...new Set(fixture.requests.filter(({ body }) => allMarkers().some((marker) => body.includes(marker)))
      .map(({ method, path }) => `${method} ${path}`))].sort()).toEqual([`POST ${fixture.authPath('slow')}`, `POST ${fixture.authPath('success')}`]);
    for (const site of [siteOf(auditSite), siteOf(lostSite)]) {
      expect(site.requests.filter(({ path }) => allMarkers().some((marker) => path.includes(marker))).length).toBe(0);
    }
    // 資格情報のファイル（暗号文）も、検索した場所に入っている。
    const credentialDirectory = relative(rootOf(), resolveCredentialDirectory(rootOf())).split('\\').join('/');
    for (const profileId of [AUDIT_PROFILE, CRASH_PROFILE]) {
      expect(search.places.map(({ place }) => place)).toContain(`root:${credentialDirectory}/${profileId}${CREDENTIAL_FILE_SUFFIX}`);
    }

    // 対照（この一時の root の中で）: わざと目印を置いたファイルは、同じ検索で見つかる（UTF-16LE）。
    const planted = `${recordDirectory()}/t26f-planted-control.txt`;
    writeFileSync(planted, Buffer.from(`planted ${USER_A}`, 'utf16le'));
    try {
      expect((await searchEverywhere()).leaked).toEqual([`root:${RECORD_DIRECTORY_NAME}/t26f-planted-control.txt (utf16le)`]);
    } finally {
      rmSync(planted, { force: true });
    }
  }, SCENARIO_TIMEOUT_MS);
});

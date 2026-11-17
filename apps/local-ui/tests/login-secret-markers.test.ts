/**
 * ログインの秘密の目印の検査（端から端まで。T25f と T26f を 1 つにした。UI-6。設計書 `2026-11-14-beaksight-slim-and-simplify-design.md` 5.4）。
 * ビルドした画面を一時の root の起動の部品で起動し（`helpers/scenario-marker-flow.ts` の作り。子プロセスの起動の記録つき）、画面から認証つきの監査
 * （手動のログイン）と、自動ログインの資格情報の登録・変更・削除・ログインの確かめ・監査を行って、秘密の目印が、どこにも出ないことを、バイトで
 * （UTF-8 と UTF-16LE の両方で）検索して確かめる。
 * - T25f（Task 25 の設計書 4.6、6 章）: 手動のログインの監査。目印は、Cookie の値（回転で替えた値を含む）、localStorage の値、ログインの POST の本文の
 *   資格情報、URL の query に入れた token の値（リンク、画像、移動の先の `code` と `state`）、IndexedDB の値（DEF-139）。URL の query の token は、伏せ字の
 *   印（`token=[REDACTED]` など）に替わって成果物に現れる。場面: (1) 最後まで終わる監査（UI-6: 前の `auth-ui-flows` の場面 4 の画面の確かめ「ログイン待ち →
 *   ログイン済み」を同じジョブで確かめる）、(2) セッションの切れで止まった監査と、その再開（UI-6: 前の `auth-ui-flows` の場面 5 の画面の確かめ
 *   「止まったページの URL と案内と認証の設定へのリンク」を同じジョブで確かめる）。
 * - T26f（Task 26 の設計書 4.7、6 章。Windows だけ。本物の DPAPI。資格情報マネージャーは使わない）: (1) 画面での登録（確かめの不一致の拒否の後）→
 *   ログインの確かめ → ユーザー名だけの変更 → 確かめ → パスワードだけの変更 → 確かめ → 削除、(2) 自動ログインの後の監査が COMPLETE、(3) 資格情報の
 *   誤りで止まり自動ログインを止める、(4) GET のフォームで止まる（値を入れず送らない）、(5) セッションが切れた監査がログインし直しの間隔を待つ間と、
 *   画面で止めた後（DEF-200）、(6) ログインの POST の途中でワーカーが落ちる（ジョブが動いている間の変更の拒否の応答を含む）。
 * - 対照: 検索の読み方（UTF-8、UTF-16LE、圧縮した ZIP の中、WAL、表の行、PowerShell の `-EncodedCommand`）は最初の対照で、この一時の root の中に
 *   わざと置いた目印（UTF-16LE）が同じ検索で見つかることは最後の検索で確かめる（UI-6: わざと置く目印を最後の検索に入れ、検索を 1 回減らした）。
 * - 検索する場所（`scenario-marker-flow` の `searchedPlaces`）: 一時の root のすべてのファイル（Run のディレクトリ（checkpoint と ZIP の中身）、管理データの
 *   ファイルと WAL と SHM、資格情報のフォルダ、記録のフォルダ。`node_modules` の junction は除く）、管理データのすべての表のすべての行、画面のサーバの
 *   標準出力と標準エラー、ワーカーの標準出力と標準エラー、IPC の記録（両方向）、子プロセスの起動の記録（PowerShell の本文も）、すべての画面の HTML
 *   （サーバで描いたもの・ブラウザで開いたもの・成果物の画面）と Server Function の応答。
 * - ワーカーの入口は、手動のログインの段の口だけを替えるテストだけの入口（`installTestAuthWorkerEntry`。自動ログインの段は本番のまま）。自動ログインが
 *   手動のログインの段へ切り替えないことは、受け渡しのサーバに来た回数が手動のログインの回数だけであることで確かめる（UI-6: 前は自動ログインだけの
 *   入口の記録のファイルで確かめた）。
 * - 時刻の進め方: 同じプロファイルの自動ログインどうしの最小の間隔を待たずに次の試しを始めるため、ジョブが動いていない間に、管理データの試し始めた時刻を
 *   その間隔の分だけ前へずらす（テストだけの操作）。
 * fixture のサイトは 127.0.0.1（と、同じ port の `localhost`）だけ。Chromium は headless だけ。目印の値は実行ごとのランダムな値で、出力しない。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { strToU8, zipSync } from 'fflate';
import type { Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS } from '../../../src/control/auth/auth-setup-contracts.js';
import {
  CREDENTIAL_FILE_SUFFIX,
  MAX_CREDENTIAL_VALUE_LENGTH,
  resolveCredentialDirectory,
} from '../../../src/control/credentials/credential-store.js';
import { POWERSHELL_LAUNCH_ARGUMENTS, WINDOWS_POWERSHELL_PATH } from '../../../src/control/credentials/dpapi-protector.js';
import { AUTO_LOGIN_MIN_INTERVAL_MS } from '../../../src/control/job/auto-login-limits.js';
import { CONTROL_DATA_DIRECTORY_NAME } from '../../../src/control/store/database-path.js';
import { PAGE_ARTIFACT_FILE_NAMES, RUN_ARTIFACT_FILE_NAMES } from '../../../src/core/artifact-layout.js';
import { REDACTED } from '../../../src/core/redaction.js';
import { isTemporaryFileName } from '../../../src/core/temporary-file-name.js';
import { AUDIT_JOB_AUTH_STATE_CATALOG } from '../../../src/presentation/catalog.js';
import { LOCAL_UI_AUDIT_TEXT, LOCAL_UI_AUTH_TEXT, LOCAL_UI_CREDENTIAL_TEXT, LOCAL_UI_NEXT_STEP_TEXT } from '../../../src/presentation/messages.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import {
  AUTH_SITE_LOGIN_FIELDS,
  AUTH_SITE_PATHS,
  AUTH_SITE_TOKEN_PATHS,
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
import { openWalControlDatabase, shiftAutoLoginAttemptsBack } from '../../../tests/helpers/control-data-test-writes.js';
import { nonReadRequestsOf } from '../../../tests/helpers/leak-places.js';
import { openAdvancedSettings } from './helpers/advanced-settings.ts';
import { openAuthSetupAdvancedSettings } from './helpers/auth-setup-page.ts';
import { WORKER_PARENT_MESSAGE_RECORD, WORKER_RECORD_FILES, writeAuthTargetConfig, type RelayedCredentials } from './helpers/auth-worker.ts';
import { createProfileInStore, saveAuthSetupRequestInStore } from './helpers/profile-store-setup.ts';
import { createScenarioMarkerFlow, type JobDetail as FlowJobDetail } from './helpers/scenario-marker-flow.ts';
import { childProcessRecordsOf, databaseRowsPlace, filesUnder, leakedPlaces, type SearchedPlace } from './helpers/secret-markers.ts';
import { waitForJobViaServerFunctions, waitForNoActiveJobViaServerFunctions, type ServerFunctionJobRow } from './helpers/server-function-job-wait.ts';

const IS_WINDOWS = process.platform === 'win32';
const SKIP_REASON = 'the automated login and the credential screen save with the real DPAPI, which exists only on Windows';

/** 画面の操作を待つ上限（ミリ秒）。 */
const UI_TIMEOUT_MS = 20_000;
/** ジョブの終わりを待つ上限（ミリ秒。ワーカーの起動、Chromium、DPAPI、ログイン、監査を含む）。 */
const JOB_TIMEOUT_MS = 180_000;
/** 1 つの場面の上限（ミリ秒）。 */
const SCENARIO_TIMEOUT_MS = 600_000;
/** 状態を読み直す間隔（ミリ秒）。 */
const POLL_MS = 250;
/** 受け渡しのサーバに、ログインの画面の準備の知らせが来るのを待つ間隔（ミリ秒）。 */
const RELAY_POLL_MS = 100;
/** フォーカスを Tab で動かす回数の上限。 */
const MAX_TAB_PRESSES = 80;
/** 手動のログインの監査のページの上限（管理画面、report、item、jump、second、frames のすべて。上限で止まると PARTIAL になるため）。 */
const MANUAL_MAX_PAGES = 6;
/** 自動ログインの監査のページの上限（管理画面、second、frames。L14: 3 は前の既定と同じ値で捨てられるので 4）。 */
const AUTO_MAX_PAGES = 4;
const FIRST_REVISION = 1;
/** 手動のログインの段で許す POST の回数。 */
const MANUAL_MAX_LOGIN_ATTEMPTS = 1;
/** HTTP の状態。 */
const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400 });
/** 一時の root の検索で読まないフォルダ（リポジトリの `node_modules` への junction）。対照で使う。 */
const SKIPPED_DIRECTORY_NAMES = Object.freeze(['node_modules']);
/** 子プロセスの起動の記録（記録のフォルダの中。`scenario-marker-flow` の名前）。 */
const SERVER_CHILD_PROCESS_RECORD = 'server-child-processes.jsonl';
const WORKER_CHILD_PROCESS_RECORD = 'worker-child-processes.jsonl';
/** 伏せ字の印に替わって現れるはずの、URL の query の形。 */
const REDACTED_QUERY_FORMS = Object.freeze([`token=${REDACTED}&page=2`, `access_token=${REDACTED}`, `code=${REDACTED}&state=${REDACTED}`]);
/** 手動のログインの回数（最後まで終わる監査、止まった監査、その再開）。受け渡しのサーバに来る回数は、これだけ。 */
const MANUAL_LOGINS = 3;

/** テストの値（匿名）。 */
const COMPLETE_PROFILE = 't25f-markers-complete';
const MANUAL_LOST_PROFILE = 't25f-markers-lost';
const CHANGE_PROFILE = 't26f-change';
const AUDIT_PROFILE = 't26f-audit';
const INVALID_PROFILE = 't26f-invalid';
const FORM_PROFILE = 't26f-form';
const AUTO_LOST_PROFILE = 't26f-lost';
const CRASH_PROFILE = 't26f-crash';
const MANUAL_PROFILES = Object.freeze([COMPLETE_PROFILE, MANUAL_LOST_PROFILE]);
const AUTO_PROFILES = Object.freeze([CHANGE_PROFILE, AUDIT_PROFILE, INVALID_PROFILE, FORM_PROFILE, AUTO_LOST_PROFILE, CRASH_PROFILE]);

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
const authText = LOCAL_UI_AUTH_TEXT;

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
// 端から端
// ---------------------------------------------------------------------------------------------------------------

let completeSite: AuthenticatedSite | undefined;
let manualLostSite: AuthenticatedSite | undefined;
let autoFixture: AutomatedLoginFixture | undefined;
let auditSite: AuthenticatedSite | undefined;
let autoLostSite: AuthenticatedSite | undefined;
let slowPosts = 0;
/** 自動ログインの fixture の正しい資格情報（変更の場面で、テストが入れ替える）。 */
const validCredentials = { username: USER_A, password: PASS_A };
/** 手動のログインで渡した資格情報の値（目印。出力しない）。 */
const manualCredentialMarkers = new Set<string>();
/** 自動ログインの認証つきの fixture のサイトの資格情報（`fillCredentials` で受け取る。目印）。 */
const siteCredentials = new Map<string, { readonly username: string; readonly password: string }>();

const siteOf = (site: AuthenticatedSite | undefined): AuthenticatedSite => {
  if (site === undefined) {
    throw new Error('認証つきの fixture のサイトが起動していない');
  }
  return site;
};
const fixtureOf = (): AutomatedLoginFixture => {
  if (autoFixture === undefined) {
    throw new Error('自動ログインの fixture が起動していない');
  }
  return autoFixture;
};

/** 検索するすべての目印（資格情報の目印、認証つきの fixture のサイトのセッションの値と URL の query の token）。 */
const allMarkers = (): readonly string[] => [
  USER_A, PASS_A, USER_B, PASS_B, PASS_TYPO, USER_WRONG, PASS_WRONG, USER_FORM, PASS_FORM, USER_CRASH, PASS_CRASH, USER_REJECTED,
  USER_INVALID_INPUT, PASS_INVALID_INPUT,
  ...manualCredentialMarkers,
  ...[...siteCredentials.values()].flatMap(({ username, password }) => [username, password]),
  ...[completeSite, manualLostSite].flatMap((site) => [...(site?.secretValues() ?? []), ...(site?.queryTokenValues() ?? [])]),
  ...(auditSite?.secretValues() ?? []),
  ...(autoLostSite?.secretValues() ?? []),
];

/** 画面の端から端の目印の検査の作り（CCX-16）。読む画面と Server Function は、手動と自動の両方のプロファイルのもの。 */
const flow = createScenarioMarkerFlow({
  label: 'login-markers',
  profileIds: () => [...MANUAL_PROFILES, ...(IS_WINDOWS ? AUTO_PROFILES : [])],
  secretMarkers: allMarkers,
  extraScreenPaths: () => [],
  extraFunctionCalls: () => [],
  // この検査は、画面の Cookie と token の場所を分けて確かめない（`expectNoSecretMarker` を使わない）。
  isScreenSecretPlace: () => false,
  profileScreenPrefixes: ['/profiles/', '/auth-setup/', '/credentials/', '/login-check/', '/start/'],
  profileFunctions: ['getProfileFn', 'getAuthSetupFn', 'getCredentialPageFn', 'auditStartSummaryFn'],
  // 手動のログインの監査の画面（UI-6: 前の `auth-ui-flows` の場面 4・5）は、CSP の違反・console の誤り・外への要求の記録も確かめる。
  recordPages: true,
  maxTabPresses: MAX_TAB_PRESSES,
});
const { openPage, snapshot, tabTo, valueOf, callFunction, waitForJobEnd, recordDescendants, databasePath, rootOf } = flow;

/** 始めたジョブの ID（検索で、ジョブの画面と成果物の画面を読む）。 */
const addJob = (jobId: string, profileId: string): void => {
  flow.jobs.push({ jobId, profileId });
};

/** 画面を開いて、HTML を集める。 */
const openAndSnapshot = async (path: string): Promise<Page> => {
  const page = await openPage(path);
  await snapshot(page);
  return page;
};

// --- 手動のログインの監査（T25f） ---------------------------------------------------------------------------

/** 認証つきの読み取りの監査（手動のログイン）のプロファイルと認証の設定を作る（ログアウトを読まないパスに、管理画面を読む範囲に）。 */
const prepareManualProfile = async (profileId: string, site: AuthenticatedSite): Promise<void> => {
  const targetConfigPath = writeAuthTargetConfig(rootOf(), profileId, site.originA, AUTH_SITE_PATHS.admin, MANUAL_MAX_PAGES);
  expect(await valueOf('createProfileFn', 'POST', {
    profile: {
      schemaVersion: 'beaksight-profile/1',
      profileId,
      revision: FIRST_REVISION,
      targetConfigPath,
      environment: 'TEST',
      mode: 'TEST_AUTH_PASSIVE',
      auth: 'MANUAL_SESSION',
      approvedTestOrigins: [site.originA],
      environmentEvidenceRef: 't25f-evidence',
      // OP-1: セッションの切れと再開で手でのログインを繰り返すので、毎回手でログインする。
      loginPreference: 'MANUAL_EVERY_TIME',
    },
  })).toMatchObject({ ok: true });
  expect(await saveAuthSetupRequestInStore(rootOf(), {
    setup: {
      ...FORM_NAVIGATION_SETUP_ITEMS,
      profileId,
      profileRevision: FIRST_REVISION,
      loginStartUrl: `${site.originA}${AUTH_SITE_PATHS.login}`,
      loginPostEndpoints: [{ origin: site.originA, path: AUTH_SITE_PATHS.login }],
      successCondition: { pathPrefix: AUTH_SITE_PATHS.admin, selector: '#admin-ok' },
      sessionLostCondition: { pathPrefix: null },
      excludedPaths: [AUTH_SITE_PATHS.adminLogout],
      auditPathPrefixes: [AUTH_SITE_PATHS.admin],
      maxLoginAttempts: MANUAL_MAX_LOGIN_ATTEMPTS,
      allowedIdpOrigins: [],
      automatedLogin: null,
    },
  })).toMatchObject({ ok: true });
};

/** fixture の正しい資格情報（値はテストの process の中だけ。目印として覚える。出力しない）。 */
const manualCredentialsOf = async (site: AuthenticatedSite): Promise<RelayedCredentials> => {
  const fields: (readonly [string, string])[] = [];
  await site.fillCredentials(async (selector, value) => {
    fields.push([selector, value]);
    manualCredentialMarkers.add(value);
  });
  return { fields, submit: AUTH_SITE_LOGIN_FIELDS.submit };
};

const jobState = (page: Page, state: string): Locator => page.locator(`[data-testid="job-state"][data-state="${state}"]`);
const authState = (page: Page, state: string): Locator => page.locator(`[data-testid="job-auth-state"][data-auth-state="${state}"]`);

/**
 * 一覧の行の「続ける」からサイトの画面へ進み、要点の「点検を始める」から開始の画面を開き、`startNew` に合わせて選び、開始してジョブの画面に移る（キーボード
 * だけ）。PL-1: 一覧の行のボタンは「続ける」1 つ。PL-3: 始め方の選択は、前回の点検が最後まで終わらなかったときだけ、たたんだ詳しい内容に出る。
 */
const startFromList = async (profileId: string, site: AuthenticatedSite, startNew: boolean): Promise<{ readonly page: Page; readonly jobId: string }> => {
  const page = await openPage('/');
  const row = page.locator(`tr[data-profile-id="${profileId}"]`);
  await tabTo(page, row.getByRole('link', { name: LOCAL_UI_NEXT_STEP_TEXT.continue }));
  await page.keyboard.press('Enter');
  await page.waitForURL(new RegExp(`/profiles/${profileId}$`, 'u'), { timeout: UI_TIMEOUT_MS });
  await tabTo(page, page.getByTestId('profile-summary').getByRole('link', { name: auditText.profileList.startAudit }));
  await page.keyboard.press('Enter');
  await page.waitForURL(new RegExp(`/start/${profileId}$`, 'u'), { timeout: UI_TIMEOUT_MS });
  await page.getByTestId('start-login').waitFor({ timeout: UI_TIMEOUT_MS });
  if (await page.locator('input[name="start-mode"]').count() > 0) {
    await tabTo(page, page.getByTestId('start-advanced-settings').locator('summary'));
    await page.keyboard.press('Enter');
    await tabTo(page, page.getByRole('radio', { name: auditText.start.resume }));
    if (startNew) {
      await page.keyboard.press('ArrowDown');
    }
    expect(await page.getByRole('radio', { name: startNew ? auditText.start.startNew : auditText.start.resume }).isChecked()).toBe(true);
  } else {
    // 前の auth-ui-flows の場面 4: まだ点検していないサイトは、始め方の選択を出さず、主のボタンは、まとめて実行を始める。開始の画面に、ログインの案内と認証の設定の要点。
    expect(startNew).toBe(true);
    expect(await page.getByTestId('start-submit').getAttribute('data-kind')).toBe('STAGE_CHAIN');
    expect(await page.getByTestId('start-login-guidance').textContent()).toBe(authText.start.guidance);
    const summary = await page.getByTestId('start-auth-setup').textContent();
    expect(summary).toContain(`${site.originA}${AUTH_SITE_PATHS.login}`);
    expect(summary).toContain(AUTH_SITE_PATHS.admin);
  }
  await snapshot(page);
  await tabTo(page, page.getByRole('button', { name: auditText.start.submit }));
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
  const jobId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  addJob(jobId, profileId);
  return { page, jobId };
};

/** 受け渡しのサーバに、ログインの画面の準備の知らせが `count` 回来るまで待つ。 */
const waitForLoginPage = async (count: number): Promise<void> => {
  await expect.poll(() => flow.relayOf().requested(), { timeout: JOB_TIMEOUT_MS, interval: RELAY_POLL_MS }).toBeGreaterThanOrEqual(count);
};

/**
 * 手動のログインで監査を始め、終わりまで待つ。`observeAwaitingLogin` のときは、資格情報を渡す前に、ジョブの画面の「ログイン待ち」を確かめる（前の
 * auth-ui-flows の場面 4）。PL-2: 終わりはサーバの値で待ち、終わった作業の画面を開き直してから確かめる。認証の状態は、たたんだ詳しい内容の中。
 */
const runManualAudit = async (
  profileId: string,
  site: AuthenticatedSite,
  startNew: boolean,
  expectedAuthState: string,
  observeAwaitingLogin = false,
): Promise<{ readonly page: Page; readonly jobId: string }> => {
  const requestedBefore = flow.relayOf().requested();
  if (!observeAwaitingLogin) {
    flow.relayOf().provide(await manualCredentialsOf(site));
  }
  const job = await startFromList(profileId, site, startNew);
  await waitForLoginPage(requestedBefore + 1);
  if (observeAwaitingLogin) {
    // PL-2: 要点は「開いたブラウザで、ログインしてください」。認証の状態の札と説明は、たたんだ詳しい内容の中。
    await authState(job.page, 'AWAITING_LOGIN').waitFor({ state: 'attached', timeout: JOB_TIMEOUT_MS });
    await job.page.locator('[data-testid="job-result"][data-result="AWAITING_LOGIN"]').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await job.page.getByTestId('job-auth-state').textContent()).toBe(AUDIT_JOB_AUTH_STATE_CATALOG.AWAITING_LOGIN.label);
    expect(await job.page.getByTestId('job-auth-description').textContent()).toBe(AUDIT_JOB_AUTH_STATE_CATALOG.AWAITING_LOGIN.description);
    await snapshot(job.page);
    expect((await recordDescendants()).length).toBeGreaterThan(0);
    flow.relayOf().provide(await manualCredentialsOf(site));
  }
  await waitForJobEnd(job.jobId);
  // PL-3（判断 3）: 「点検を始める」は、まとめて実行を始める。残りのステップも終わるまで待つ（ログインは最初の段の 1 回だけ）。
  await waitForNoActiveJobViaServerFunctions(
    () => valueOf<readonly ServerFunctionJobRow[]>('listAuditJobsFn', 'GET'),
    profileId,
    { limitMs: JOB_TIMEOUT_MS, stepMs: POLL_MS },
  );
  await job.page.goto(new URL(`/jobs/${job.jobId}`, job.page.url()).href);
  await jobState(job.page, 'FINISHED').waitFor({ timeout: JOB_TIMEOUT_MS });
  await openAdvancedSettings(job.page, 'job-details', UI_TIMEOUT_MS);
  await authState(job.page, expectedAuthState).waitFor({ timeout: UI_TIMEOUT_MS });
  await snapshot(job.page);
  return job;
};

const containsBytes = (bytes: Uint8Array, needle: string): boolean => Buffer.from(bytes).includes(Buffer.from(needle, 'utf8'));

/** サーバに届いた要求のうち、path と query に `value` を含むものの数（値は出力しない）。 */
const requestsWith = (site: AuthenticatedSite, value: string | undefined): number =>
  site.requests.filter(({ path }) => value !== undefined && path.includes(value)).length;

/** Run のディレクトリ（一時の root の中）の場所の名前の頭。 */
const runPlacePrefix = (profileId: string): string => `root:t25e-output-${profileId}/`;
/** Run のディレクトリのページの page.json（ZIP の中は除く）。 */
const pageJsonsOf = (places: readonly SearchedPlace[], profileId: string): readonly SearchedPlace[] => places
  .filter(({ place }) => place.startsWith(runPlacePrefix(profileId)) && !place.includes('!') && place.endsWith(`/${PAGE_ARTIFACT_FILE_NAMES.page}`));

// --- 自動ログイン（T26f） ----------------------------------------------------------------------------------

interface JobDetail extends FlowJobDetail {
  readonly runId: string | null;
  readonly failureReason: string | null;
  readonly autoLogin: {
    readonly result: string | null;
    readonly submitted: string | null;
    readonly formInvalidReason?: string | null;
  } | null;
}

/** 資格情報の画面の欄（ラベルは完全一致）。 */
const field = (page: Page, label: string): Locator => page.getByLabel(label, { exact: true });

/** 資格情報の画面の、終わりの知らせか拒否のどちらかが出るまで待つ。 */
const waitForCredentialOutcome = async (page: Page): Promise<void> => {
  await page.locator('[data-testid="credential-done"], [data-testid="credential-rejection"]').first().waitFor({ timeout: UI_TIMEOUT_MS });
  await snapshot(page);
};

/** 資格情報の画面で、新しく登録する（Enter で送る）。拒否の理由（なければ `null`）を返す。 */
const registerOnPage = async (profileId: string, username: string, password: string, confirmation: string = password): Promise<string | null> => {
  const page = await openAndSnapshot(`/credentials/${profileId}`);
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

/** 資格情報の画面で、ユーザー名だけか、パスワードだけを変える（PL-4: 変える欄は閉じた詳しい内容の中）。最後の変更の種類を返す。 */
const changeOnPage = async (profileId: string, kind: 'username' | 'password', value: string): Promise<string | null> => {
  const page = await openAndSnapshot(`/credentials/${profileId}`);
  await openAdvancedSettings(page, 'credential-advanced-settings', UI_TIMEOUT_MS);
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
  return (await valueOf<{ credential: { lastChangeKind: string } | null }>('getCredentialPageFn', 'GET', { profileId })).credential?.lastChangeKind ?? null;
};

/** 資格情報の画面で、確かめのダイアログの後に削除する（PL-4: 削除は閉じた詳しい内容の中）。 */
const removeOnPage = async (profileId: string): Promise<void> => {
  const page = await openAndSnapshot(`/credentials/${profileId}`);
  await openAdvancedSettings(page, 'credential-advanced-settings', UI_TIMEOUT_MS);
  await page.getByTestId('credential-remove').click();
  await page.getByRole('dialog', { name: credentialText.remove.title }).waitFor({ timeout: UI_TIMEOUT_MS });
  // 開いたときは「やめる」にフォーカスがある。Tab で「削除する」へ移って押す。
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.locator('[data-testid="credential-done"][data-notice="removed"]').waitFor({ timeout: UI_TIMEOUT_MS });
  await snapshot(page);
};

/** ジョブが終わるまで待つ（詳しい値の型で）。 */
const waitForAutoJobEnd = async (jobId: string): Promise<JobDetail> => (await waitForJobEnd(jobId)) as JobDetail;

/** ジョブの画面で、終わった状態が出るまで待って、HTML を集める（PL-2: 終わった作業の画面を開き直してから）。 */
const snapshotEndedJob = async (page: Page, jobId: string): Promise<void> => {
  await page.goto(new URL(`/jobs/${jobId}`, page.url()).href);
  await page.locator('[data-testid="job-state"]:not([data-state="STARTING"]):not([data-state="RUNNING"]):not([data-state="STOPPING"])')
    .waitFor({ timeout: JOB_TIMEOUT_MS });
  await snapshot(page);
};

/**
 * ログインの確かめを始め、ジョブの画面を開く。PL-3: ログインの確かめの画面のログインだけを試すボタンはなくしたので、ジョブは開始の Server Function で
 * 始める。ログインの確かめの画面（止めた自動ログインを再開する入口）は開いて、HTML を集める。
 */
const startLoginCheckOnPage = async (profileId: string): Promise<{ readonly page: Page; readonly jobId: string }> => {
  const check = await openAndSnapshot(`/login-check/${profileId}`);
  await check.getByTestId('login-check-summary').waitFor({ timeout: UI_TIMEOUT_MS });
  await snapshot(check);
  const { revision } = await valueOf<{ revision: number }>('auditStartSummaryFn', 'GET', { profileId });
  const started = await valueOf<{ ok: boolean; jobId: string }>('startLoginCheckFn', 'POST', { profileId, expectedRevision: revision });
  expect(started.ok).toBe(true);
  addJob(started.jobId, profileId);
  return { page: await openAndSnapshot(`/jobs/${started.jobId}`), jobId: started.jobId };
};

/** ログインの確かめを始めて、終わるまで待つ。 */
const loginCheckOnPage = async (profileId: string): Promise<JobDetail> => {
  const { page, jobId } = await startLoginCheckOnPage(profileId);
  const job = await waitForAutoJobEnd(jobId);
  await snapshotEndedJob(page, jobId);
  return job;
};

/** 開始の画面から新しく監査を始め、ジョブの画面とジョブの ID を返す。 */
const startAuditOnPage = async (profileId: string): Promise<{ readonly page: Page; readonly jobId: string }> => {
  const page = await openAndSnapshot(`/start/${profileId}`);
  await page.getByTestId('start-login').waitFor({ timeout: UI_TIMEOUT_MS });
  if (await page.locator('input[name="start-mode"]').count() > 0) {
    await openAdvancedSettings(page, 'start-advanced-settings', UI_TIMEOUT_MS);
    await page.getByRole('radio', { name: auditText.start.startNew }).check();
  }
  await page.getByRole('button', { name: auditText.start.submit }).click();
  await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
  const jobId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  addJob(jobId, profileId);
  return { page, jobId };
};

/** 開始の画面から新しく監査を始めて、まとめて実行の残りも終わるまで待つ。 */
const auditOnPage = async (profileId: string): Promise<JobDetail> => {
  const { page, jobId } = await startAuditOnPage(profileId);
  const job = await waitForAutoJobEnd(jobId);
  await waitForNoActiveJobViaServerFunctions(
    () => valueOf<readonly ServerFunctionJobRow[]>('listAuditJobsFn', 'GET'),
    profileId,
    { limitMs: JOB_TIMEOUT_MS, stepMs: POLL_MS },
  );
  await snapshotEndedJob(page, jobId);
  return job;
};

/** ジョブが動いていない間に、プロファイルの試し始めた時刻を、最小の間隔の分だけ前へずらす（テストだけの操作）。 */
const passMinimumInterval = (profileId: string): void => {
  expect(shiftAutoLoginAttemptsBack(databasePath(), profileId, AUTO_LOGIN_MIN_INTERVAL_MS)).toBeGreaterThan(0);
};

/** 自動ログインを止めているか（資格情報の画面の値。PL-4: 止めていないときは、停止の行を出さない）。 */
const isHeld = async (profileId: string): Promise<boolean> => {
  const page = await openAndSnapshot(`/credentials/${profileId}`);
  await page.getByTestId('credential-summary').waitFor({ timeout: UI_TIMEOUT_MS });
  return (await page.locator('[data-testid="credential-hold"][data-held="yes"]').count()) > 0;
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

/** 自動ログインのプロファイルと認証の設定を作る（MI-F1: 自動ログインのプロファイルは画面の作成の口では作れないので、保存の部品で直接作る）。 */
const prepareAutoProfile = async (profileId: string, origin: string, startPath: string, setup: Record<string, unknown>): Promise<void> => {
  const targetConfigPath = writeAuthTargetConfig(rootOf(), profileId, origin, startPath, AUTO_MAX_PAGES);
  expect(await createProfileInStore(rootOf(), {
    schemaVersion: 'beaksight-profile/1',
    profileId,
    revision: FIRST_REVISION,
    targetConfigPath,
    environment: 'TEST',
    mode: 'TEST_AUTH_PASSIVE',
    auth: 'AUTOMATED_LOGIN',
    approvedTestOrigins: [origin],
    environmentEvidenceRef: 't26f-evidence',
  })).toMatchObject({ ok: true });
  expect(await saveAuthSetupRequestInStore(rootOf(), { setup })).toMatchObject({ ok: true });
};

/** 認証つきの fixture のサイトの正しい資格情報（値はテストの process の中だけ。目印として覚える）。 */
const credentialsOfSite = async (site: AuthenticatedSite): Promise<{ readonly username: string; readonly password: string }> => {
  const values = new Map<string, string>();
  await site.fillCredentials(async (selector, value) => {
    values.set(selector, value);
  });
  return { username: values.get(AUTH_SITE_LOGIN_FIELDS.user) ?? '', password: values.get(AUTH_SITE_LOGIN_FIELDS.pass) ?? '' };
};

/** 資格情報のフォルダのファイルの名前（資格情報のファイルだけで、一時のファイルがないこと）。 */
const expectOnlyCredentialFiles = (profileIds: readonly string[]): void => {
  const directory = resolveCredentialDirectory(rootOf());
  const names = existsSync(directory) ? readdirSync(directory) : [];
  expect(names.filter((name) => isTemporaryFileName(name))).toEqual([]);
  expect([...names].sort()).toEqual(profileIds.map((profileId) => `${profileId}${CREDENTIAL_FILE_SUFFIX}`).sort());
};

// --- 検索 ------------------------------------------------------------------------------------------------

/**
 * 検索するすべての場所で目印を探し、`expectedLeaks`（ふつうは空。最後の検索では、わざと置いた目印の場所）のほかに目印がないことを確かめる（漏れた場所の
 * 名前と文字の形だけを出す）。検索した場所に、管理データのファイルと WAL と SHM、IPC の記録（両方向）が入っている。
 */
const expectNoMarkerAnywhere = async (scenario: string, expectedLeaks: readonly string[] = []): Promise<readonly SearchedPlace[]> => {
  const places = await flow.searchedPlaces();
  console.info(`[CCX-16] login-markers searched places (${scenario}): ${places.length}`);
  expect(leakedPlaces(places, allMarkers()), scenario).toEqual(expectedLeaks);
  const names = places.map(({ place }) => place);
  const localData = `root:${CONTROL_DATA_DIRECTORY_NAME}/`;
  expect(names.some((name) => name.startsWith(localData) && name.endsWith('-wal')), scenario).toBe(true);
  expect(names.some((name) => name.startsWith(localData) && name.endsWith('-shm')), scenario).toBe(true);
  expect(names).toContain(`root:${flow.recordDirectoryName}/${WORKER_RECORD_FILES.ipc}`);
  expect(names).toContain(`root:${flow.recordDirectoryName}/${WORKER_PARENT_MESSAGE_RECORD}`);
  return places;
};

describe('T25f and T26f: no secret marker anywhere after the logins from the screen', () => {
  beforeAll(async () => {
    // DEF-139: ログインの後の画面が IndexedDB に目印を書き、2 ページ目はその記録がなければログインの画面へ移す（IndexedDB の値の目印も検索する）。
    completeSite = await startAuthenticatedSite({ loginForm: true, rotate: true, queryTokens: true, indexedDbGate: true });
    manualLostSite = await startAuthenticatedSite({ loginForm: true, rotate: true, queryTokens: true, expireFirstSessionAtPath: AUTH_SITE_TOKEN_PATHS.item });
    await flow.start();
    await prepareManualProfile(COMPLETE_PROFILE, completeSite);
    await prepareManualProfile(MANUAL_LOST_PROFILE, manualLostSite);
    if (IS_WINDOWS) {
      autoFixture = await startAutomatedLoginFixture({
        get username() { return validCredentials.username; },
        get password() { return validCredentials.password; },
        onSlowPost: () => { slowPosts += 1; },
      });
      auditSite = await startAuthenticatedSite({ loginForm: true, rotate: true });
      autoLostSite = await startAuthenticatedSite({ loginForm: true, rotate: true, expireFirstSessionAtPath: AUTH_SITE_PATHS.adminSecond });
      siteCredentials.set(AUDIT_PROFILE, await credentialsOfSite(auditSite));
      siteCredentials.set(AUTO_LOST_PROFILE, await credentialsOfSite(autoLostSite));
      const fixture = fixtureOf();
      const home = AUTOMATED_LOGIN_FIXTURE_PATHS.home;
      await prepareAutoProfile(CHANGE_PROFILE, fixture.originA, home, fixtureSetupOf(CHANGE_PROFILE, 'standard', 'success'));
      await prepareAutoProfile(INVALID_PROFILE, fixture.originA, home, fixtureSetupOf(INVALID_PROFILE, 'standard', 'success'));
      await prepareAutoProfile(FORM_PROFILE, fixture.originA, home, fixtureSetupOf(FORM_PROFILE, 'get', 'success'));
      await prepareAutoProfile(CRASH_PROFILE, fixture.originA, home, fixtureSetupOf(CRASH_PROFILE, 'standard', 'slow'));
      await prepareAutoProfile(AUDIT_PROFILE, auditSite.originA, AUTH_SITE_PATHS.admin, siteSetupOf(AUDIT_PROFILE, auditSite));
      await prepareAutoProfile(AUTO_LOST_PROFILE, autoLostSite.originA, AUTH_SITE_PATHS.admin, siteSetupOf(AUTO_LOST_PROFILE, autoLostSite));
    }
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await flow.closePages();
  });

  afterAll(async () => {
    await flow.stop();
    await autoFixture?.close();
    await auditSite?.close();
    await autoLostSite?.close();
    await completeSite?.close();
    await manualLostSite?.close();
  }, SCENARIO_TIMEOUT_MS);

  it('manual login: awaits the login on the screen, completes the audit, and no marker is anywhere; the URL tokens are redacted', async () => {
    const site = siteOf(completeSite);
    const { page, jobId } = await runManualAudit(COMPLETE_PROFILE, site, true, 'AUTHENTICATED', true);
    expect(await page.getByTestId('job-run-status').getAttribute('data-run-status')).toBe('COMPLETE');
    expect(await page.getByTestId('job-session-lost-url').count()).toBe(0);
    // 前の auth-ui-flows の場面 4: すべての画面で、CSP の違反と console の誤りと外への要求が 0 件。
    await flow.expectCleanPages();
    expect(site.successfulLogins).toBe(1);
    expect(nonReadRequestsOf(site.requests)).toEqual([`POST ${AUTH_SITE_PATHS.login}`]);
    // 巡回は伏せ字の前の URL で行った（画像の目印と、移動の先の code の目印つきの要求が、サーバに届いた）。
    const [, , , pixel, code] = site.queryTokenValues();
    expect(requestsWith(site, pixel)).toBeGreaterThan(0);
    expect(requestsWith(site, code)).toBeGreaterThan(0);
    // 回転で替えた値を含む Cookie と localStorage（3 つ以上）、資格情報（2 つ）、URL の query の token（すべて）。
    expect(site.secretValues().length).toBeGreaterThan(2);
    expect(manualCredentialMarkers.size).toBeGreaterThanOrEqual(2);
    expect(site.queryTokenValues().length).toBeGreaterThan(0);

    const places = await expectNoMarkerAnywhere('manual audit completed');
    expect(places.some(({ place }) => place.startsWith(runPlacePrefix(COMPLETE_PROFILE)) && place.includes('.zip!'))).toBe(true);
    // ジョブの画面（サーバで描いたもの）と、その Server Function の応答も検索した。
    expect(places.some(({ place }) => place === `html:/jobs/${jobId}`)).toBe(true);
    expect(places.some(({ place }) => place.startsWith('function:getAuditJobFn:'))).toBe(true);
    // URL の query の token は、伏せ字の印に替わって、成果物に現れる（REC-2: ページの page.json で確かめる）。
    const pageJsons = pageJsonsOf(places, COMPLETE_PROFILE);
    expect(pageJsons.length).toBeGreaterThan(0);
    for (const form of REDACTED_QUERY_FORMS) {
      expect(pageJsons.some(({ bytes }) => containsBytes(bytes, form)), form).toBe(true);
    }
  }, SCENARIO_TIMEOUT_MS);

  it('manual login: stops with SESSION_LOST (the stopped page, the guidance and the link to the auth setup) and resumes, and no marker is anywhere after either', async () => {
    const site = siteOf(manualLostSite);
    const stopped = await runManualAudit(MANUAL_LOST_PROFILE, site, true, 'SESSION_LOST');
    expect(await stopped.page.getByTestId('job-run-status').getAttribute('data-run-status')).toBe('PARTIAL');
    // 前の auth-ui-flows の場面 5: 止まったページの URL（リンクにしない）と次にすることは要点に、認証の状態の札は詳しい内容に出る。
    expect(await stopped.page.getByTestId('job-session-lost-page').isVisible()).toBe(true);
    expect(await stopped.page.getByTestId('job-auth-state').textContent()).toBe(AUDIT_JOB_AUTH_STATE_CATALOG.SESSION_LOST.label);
    expect(await stopped.page.getByTestId('job-session-lost-url').textContent()).toBe(`${site.originA}${AUTH_SITE_TOKEN_PATHS.item}`);
    expect(await stopped.page.getByTestId('job-session-lost-guidance').textContent()).toBe(authText.job.sessionLostGuidance);
    expect(await stopped.page.getByTestId('job-auth').locator(`a[href*="${site.originA}"]`).count()).toBe(0);
    await flow.expectCleanPages();
    await tabTo(stopped.page, stopped.page.getByTestId('job-open-auth-setup'));
    await stopped.page.keyboard.press('Enter');
    await stopped.page.waitForURL(new RegExp(`/auth-setup/${MANUAL_LOST_PROFILE}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await openAuthSetupAdvancedSettings(stopped.page, UI_TIMEOUT_MS);
    await stopped.page.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
    await snapshot(stopped.page);
    await stopped.page.close();
    expect(nonReadRequestsOf(site.requests)).toEqual([`POST ${AUTH_SITE_PATHS.login}`]);

    // 止まった Run: 保存が残り、目印はどこにもなく、保存のページには伏せ字の印が現れる。DEF-138: 証拠は run.json・管理データ（WAL を含む）・IPC の記録にある。
    const stoppedPlaces = await expectNoMarkerAnywhere('manual audit stopped by SESSION_LOST');
    const stoppedRunJson = stoppedPlaces.find(({ place }) => place.startsWith(runPlacePrefix(MANUAL_LOST_PROFILE)) && place.endsWith(`/${RUN_ARTIFACT_FILE_NAMES.run}`));
    const stoppedRun = JSON.parse(Buffer.from(stoppedRunJson?.bytes ?? new Uint8Array()).toString('utf8')) as {
      readonly authentication?: { readonly sessionLoss?: { readonly requestedPath: string | null } };
    };
    expect(stoppedRun.authentication?.sessionLoss?.requestedPath).toMatch(new RegExp(`^${AUTH_SITE_TOKEN_PATHS.item}(?:\\?|$)`, 'u'));
    expect(stoppedPlaces.some(({ place, bytes }) => place.endsWith(WORKER_RECORD_FILES.ipc) && containsBytes(bytes, '"sessionLoss"'))).toBe(true);
    const checkpointFiles = stoppedPlaces.filter(({ place }) => place.startsWith(runPlacePrefix(MANUAL_LOST_PROFILE)) && place.includes('/checkpoint/'));
    expect(checkpointFiles.length).toBeGreaterThan(0);
    expect(checkpointFiles.some(({ bytes }) => containsBytes(bytes, `token=${REDACTED}`))).toBe(true);

    // 再開（もう一度ログイン。2 回目のログインのセッションは切れない）→ 最後まで。
    const resumed = await runManualAudit(MANUAL_LOST_PROFILE, site, false, 'AUTHENTICATED');
    expect(await resumed.page.getByTestId('job-run-status').getAttribute('data-run-status')).toBe('COMPLETE');
    await resumed.page.close();
    expect(site.successfulLogins).toBe(2);
    expect(nonReadRequestsOf(site.requests)).toEqual([`POST ${AUTH_SITE_PATHS.login}`, `POST ${AUTH_SITE_PATHS.login}`]);
    const resumedPlaces = await expectNoMarkerAnywhere('manual audit resumed');
    const runJson = resumedPlaces.find(({ place }) => place.startsWith(runPlacePrefix(MANUAL_LOST_PROFILE)) && !place.includes('!')
      && place.endsWith(`/${RUN_ARTIFACT_FILE_NAMES.run}`));
    const { executions } = JSON.parse(Buffer.from(runJson?.bytes ?? new Uint8Array()).toString('utf8')) as {
      readonly executions: readonly { readonly endReason: string | null }[];
    };
    // 同じ Run の 2 回の実行（セッションの切れで止まった実行と、再開して終えた実行）。
    expect(executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_AUTH_SESSION_LOST', 'COMPLETED']);
    expect(pageJsonsOf(resumedPlaces, MANUAL_LOST_PROFILE).some(({ bytes }) => containsBytes(bytes, `token=${REDACTED}&page=2`))).toBe(true);
  }, SCENARIO_TIMEOUT_MS);

  it.skipIf(!IS_WINDOWS)(`automated login: registers after a mismatch, checks the login, changes the username only and the password only (checking after each), and deletes${IS_WINDOWS ? '' : ` [skipped: ${SKIP_REASON}]`}`, async () => {
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

  it.skipIf(!IS_WINDOWS)('automated login: audits read only to COMPLETE, and no marker is in the Run directory or its ZIP', async () => {
    const site = siteOf(auditSite);
    const credential = siteCredentials.get(AUDIT_PROFILE) ?? { username: '', password: '' };
    expect(await registerOnPage(AUDIT_PROFILE, credential.username, credential.password)).toBeNull();
    const job = await auditOnPage(AUDIT_PROFILE);
    expect(job).toMatchObject({
      jobKind: 'AUDIT',
      state: 'FINISHED',
      runStatus: 'COMPLETE',
      lastAuthState: 'AUTHENTICATED',
      autoLogin: { result: 'SUCCEEDED', submitted: 'YES' },
    });
    expect(site.successfulLogins).toBe(1);
    expect(nonReadRequestsOf(site.requests)).toEqual([`POST ${AUTH_SITE_PATHS.login}`]);
    const places = await expectNoMarkerAnywhere('automated audit completed');
    expect(places.some(({ place }) => place.startsWith(runPlacePrefix(AUDIT_PROFILE)) && place.includes('.zip!'))).toBe(true);
    expect(places.some(({ place }) => place.startsWith('html:/artifacts/'))).toBe(true);
  }, SCENARIO_TIMEOUT_MS);

  it.skipIf(!IS_WINDOWS)('automated login: stops the audit on invalid credentials, holds the automated login, and no marker is anywhere', async () => {
    const fixture = fixtureOf();
    expect(await registerOnPage(INVALID_PROFILE, USER_WRONG, PASS_WRONG)).toBeNull();
    const since = fixture.requests.length;
    const job = await auditOnPage(INVALID_PROFILE);
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

  it.skipIf(!IS_WINDOWS)('automated login: stops at the form check of a GET form without entering or sending the values, and no marker is anywhere', async () => {
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

  it.skipIf(!IS_WINDOWS)('automated login: waits to sign in again after a lost session (with a checkpoint), stops on the screen, and no marker is anywhere before or after the stop', async () => {
    const site = siteOf(autoLostSite);
    const credential = siteCredentials.get(AUTO_LOST_PROFILE) ?? { username: '', password: '' };
    expect(await registerOnPage(AUTO_LOST_PROFILE, credential.username, credential.password)).toBeNull();
    const { page, jobId } = await startAuditOnPage(AUTO_LOST_PROFILE);
    // DEF-200: セッションが切れた Run の成果物ができた後、ジョブは自動ログインの間隔が明けるのを待つ（動いたまま。ログインし直しの POST はまだ送らない）。
    await recordDescendants();
    const waiting = await waitForJobViaServerFunctions(
      (id) => valueOf<JobDetail | null>('getAuditJobFn', 'GET', { jobId: id }),
      jobId,
      (job) => job.lastAuthState === 'SESSION_LOST' && job.artifacts.length > 0,
      { limitMs: JOB_TIMEOUT_MS, stepMs: POLL_MS },
    );
    expect(waiting).toMatchObject({ active: true, autoLogin: { result: 'SUCCEEDED' } });
    const waitingPlaces = await expectNoMarkerAnywhere('session lost, waiting to sign in again');
    expect(waitingPlaces.some(({ place }) => place.startsWith(runPlacePrefix(AUTO_LOST_PROFILE)) && place.includes('/checkpoint/'))).toBe(true);

    // 画面の「止める」（Server Function）で止めると、待ちを終えてジョブが終わる。ログインし直さない。
    expect(await valueOf('stopAuditJobFn', 'POST', { jobId, force: false })).toMatchObject({ ok: true });
    const stopped = await waitForAutoJobEnd(jobId);
    expect(stopped.state).not.toBe('RUNNING');
    await snapshotEndedJob(page, jobId);
    expect(site.successfulLogins).toBe(1);
    expect(nonReadRequestsOf(site.requests)).toEqual([`POST ${AUTH_SITE_PATHS.login}`]);
    await expectNoMarkerAnywhere('stopped while waiting to sign in again');
  }, SCENARIO_TIMEOUT_MS);

  it.skipIf(!IS_WINDOWS)('automated login: closes the attempt as unknown and holds when the worker dies during the login POST, and no marker is anywhere', async () => {
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
    const job = await waitForAutoJobEnd(jobId);
    await snapshotEndedJob(page, jobId);
    expect(job).toMatchObject({ jobKind: 'LOGIN_CHECK', state: 'INTERRUPTED', autoLogin: { result: 'AUTH_RESULT_UNKNOWN', submitted: 'UNKNOWN' } });
    expect(await isHeld(CRASH_PROFILE)).toBe(true);
    await expectNoMarkerAnywhere('worker died');
  }, SCENARIO_TIMEOUT_MS);

  it('finds only the marker placed on purpose in the final search, records the launches and the IPC both ways, and leaves only credential files', async () => {
    // 対照（この一時の root の中で）: わざと目印を置いたファイルは、同じ検索で見つかる（UTF-16LE）。ほかの場所に目印はない（UI-6: 最後の検索を兼ねる）。
    const plantedName = 'login-markers-planted-control.txt';
    const planted = `${flow.recordDirectory()}/${plantedName}`;
    const [plantedMarker = ''] = manualCredentialMarkers;
    writeFileSync(planted, Buffer.from(`planted ${plantedMarker}`, 'utf16le'));
    let places: readonly SearchedPlace[];
    try {
      places = await expectNoMarkerAnywhere('final', [`root:${flow.recordDirectoryName}/${plantedName} (utf16le)`]);
    } finally {
      rmSync(planted, { force: true });
    }
    // IPC の記録: 親から受けた `START`（ジョブの数）と、親へ送った認証の状態（`AUTH_STATE`）がある。
    expect(flow.recordedMessageTypesOf(places, WORKER_PARENT_MESSAGE_RECORD).filter((type) => type === 'START').length).toBe(flow.jobs.length);
    expect(flow.recordedMessageTypesOf(places, WORKER_RECORD_FILES.ipc)).toContain('AUTH_STATE');
    // 手動のログインの段（受け渡しのサーバ）を使ったのは、手動のログインの監査だけ（自動ログインは、手動のログインの段へ切り替えない）。
    expect(flow.relayOf().requested()).toBe(MANUAL_LOGINS);
    if (!IS_WINDOWS) {
      return;
    }
    const records = [
      ...childProcessRecordsOf(`${flow.recordDirectory()}/${SERVER_CHILD_PROCESS_RECORD}`, 'server-process').records,
      ...childProcessRecordsOf(`${flow.recordDirectory()}/${WORKER_CHILD_PROCESS_RECORD}`, 'worker-process').records,
    ];
    const powerShell = records.filter(({ file }) => file === WINDOWS_POWERSHELL_PATH);
    // 画面のサーバ（暗号化・権限の確かめ）とワーカー（復号）の両方で、PowerShell を起動した（決まった引数で、環境を渡さない）。
    expect(powerShell.filter(({ process: label }) => label === 'server').length).toBeGreaterThan(0);
    expect(powerShell.filter(({ process: label }) => label === 'worker').length).toBeGreaterThan(0);
    for (const record of powerShell) {
      expect(record.args.slice(0, POWERSHELL_LAUNCH_ARGUMENTS.length)).toEqual([...POWERSHELL_LAUNCH_ARGUMENTS]);
      expect(record.args.length).toBe(POWERSHELL_LAUNCH_ARGUMENTS.length + 1);
      expect(record.hasEnv).toBe(false);
    }
    expect(places.filter(({ place }) => place.endsWith(':script')).length).toBe(powerShell.length);
    // 管理データの表に行がある（検索した行が空でない）。
    const rows = databaseRowsPlace(databasePath(), 'database:rows');
    for (const table of ['jobs', 'auto_login_attempts', 'auto_login_holds', 'credential_events']) {
      expect(rows.rowCounts.get(table) ?? 0, table).toBeGreaterThan(0);
    }
    expectOnlyCredentialFiles([AUDIT_PROFILE, INVALID_PROFILE, FORM_PROFILE, AUTO_LOST_PROFILE, CRASH_PROFILE]);
    // 目印は、自動ログインの fixture のサイトへの要求の URL に載らない（本文に載るのは、ログインの POST だけ）。
    const fixture = fixtureOf();
    expect(fixture.requests.filter(({ path }) => allMarkers().some((marker) => path.includes(marker))).length).toBe(0);
    expect([...new Set(fixture.requests.filter(({ body }) => allMarkers().some((marker) => body.includes(marker)))
      .map(({ method, path }) => `${method} ${path}`))].sort()).toEqual([`POST ${fixture.authPath('slow')}`, `POST ${fixture.authPath('success')}`]);
    for (const site of [siteOf(auditSite), siteOf(autoLostSite)]) {
      expect(site.requests.filter(({ path }) => allMarkers().some((marker) => path.includes(marker))).length).toBe(0);
    }
    // 資格情報のファイル（暗号文）も、検索した場所に入っている。
    const credentialDirectory = relative(rootOf(), resolveCredentialDirectory(rootOf())).split('\\').join('/');
    for (const profileId of [AUDIT_PROFILE, CRASH_PROFILE]) {
      expect(places.map(({ place }) => place)).toContain(`root:${credentialDirectory}/${profileId}${CREDENTIAL_FILE_SUFFIX}`);
    }
  }, SCENARIO_TIMEOUT_MS);
});

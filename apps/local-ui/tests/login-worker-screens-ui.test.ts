/**
 * SLIM-GROUP UI-5 の束 S5b（手動のログインの偽のワーカーで動かす画面）。1 つの画面のサーバ（一時の root 1 つ、headless の Chromium 1 つ）を、元のファイルごとの
 * describe で分けて使う（`helpers/ui-server.ts` の `sharedUiServerKitOf`）。偽のワーカーの入口（一時の root の `TEST_WORKER_ENTRY`）は、describe の
 * beforeAll で、その describe の偽のワーカーに書き換える（ジョブは同時に動かない順に並べる）。
 * 元のファイル（どれも丸ごと入れた）:
 * - `manual-login-ui.test.ts`（ML-b。ジョブの行はテストだけの操作で書く。ワーカーは起動しない）
 * - `manual-login-confirm-ui.test.ts`（ML-b-2。偽のワーカー `auth-manual-confirm`）
 *   この 2 つは同じ画面なので 1 つの describe にした。重なる「ボタンを出さない」の確かめ（前の manual-login-ui の「does not show the button when the job does
 *   not await the login」）は、同じ認証済みのジョブの画面を開く「登録した設定」の場面に 3 行で寄せた（場面は消していない。ボタンを出すことは ML-b の 1 つ目と
 *   ML-b-2 の 1 つ目）。
 * - `automated-login-setup-ui.test.ts`（FM2e・MI-4。偽のワーカー `auth-manual-confirm` と `auto-login-success`。本物のワーカーの describe はもうない）
 * 削った場面: なし。
 * 束の決まり: プロファイルの ID は元のまま（`mlb-manual`・`mlb2-manual`・`fm2e-manual-ui`・`mi4-manual-flow`。重ならない）。ML-b のジョブの行のうち
 * 「ログイン待ち」で書いた行は、ML-b の describe の afterAll で終わった行にする（ジョブは同時に 1 つの決まりに、後の describe のジョブの開始を当てない）。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  LOGIN_SIDE_REQUEST_METHODS,
  MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE,
} from '../../../src/control/auth/auth-setup-contracts.js';
import { credentialFilePathFor, resolveCredentialDirectory } from '../../../src/control/credentials/credential-store.js';
import { AUTO_LOGIN_DAILY_MAX_ATTEMPTS, AUTO_LOGIN_DAILY_WINDOW_MS, AUTO_LOGIN_MIN_INTERVAL_MS } from '../../../src/control/job/auto-login-limits.js';
import { createStartingJob, recordAuthState, recordEnded } from '../../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { CONTROL_DATA_DIRECTORY_NAME, resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { DAY_MS, MINUTE_MS } from '../../../src/core/time-units.js';
import { formatCount, formatInteger } from '../../../src/presentation/format.js';
import {
  CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS,
  LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT,
  LOCAL_UI_JOB_SUMMARY_TEXT,
  LOCAL_UI_LOGIN_STAGE_TEXT,
  LOCAL_UI_MANUAL_LOGIN_TEXT,
  LOCAL_UI_NEXT_STEP_TEXT,
  LOCAL_UI_TEXT,
} from '../../../src/presentation/messages.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { writeFakeWorker, type FakeWorker } from '../../../tests/helpers/fake-audit-worker.js';
import { fakeWorkerValuesOf } from '../../../tests/helpers/job-test-support.js';
import { httpMethodLabel } from '../src/display/labels';
import { openAdvancedSettings } from './helpers/advanced-settings.ts';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
import { TEST_WORKER_ENTRY } from './helpers/local-server.ts';
import { profileStageOf } from './helpers/next-steps.ts';
import { saveAuthSetupRequestInStore, updateProfileInStore } from './helpers/profile-store-setup.ts';
import { filesUnder, leakedPlaces } from './helpers/secret-markers.ts';
import { isServerFunctionUrlOf } from './helpers/server-functions.ts';
import { waitForJobViaServerFunctions, type ServerFunctionJobWaitTiming } from './helpers/server-function-job-wait.ts';
import { createUiPageKit } from './helpers/ui-page.ts';
import { createUiServerKit, sharedUiServerKitOf } from './helpers/ui-server.ts';

/** 束のサーバの準備の上限（ms）。 */
const SERVER_SETUP_TIMEOUT_MS = 120_000;

/** 束の 1 つのサーバ（`setUp`・`tearDown` は、ここで 1 回だけ）。 */
const serverKit = createUiServerKit();
beforeAll(() => serverKit.setUp(), SERVER_SETUP_TIMEOUT_MS);
afterAll(() => serverKit.tearDown());

// ---------------------------------------------------------------------------------------------------------------
// 元: manual-login-ui.test.ts と manual-login-confirm-ui.test.ts（同じ画面なので 1 つの describe）
// ---------------------------------------------------------------------------------------------------------------

describe('manual-login-ui・manual-login-confirm-ui: the screens of the manual login', () => {
  const UI_TIMEOUT_MS = 15_000;
  const SCENARIO_TIMEOUT_MS = 120_000;
  const MAX_TAB_PRESSES = 80;
  const MAX_PAGES = 4; // L14: 3 は前の既定と同じ値（読むときに捨てられる）なので 4。
  const TEST_ORIGIN = 'http://127.0.0.1:4173';
  const SERVICE_ORIGIN = 'https://service.example.invalid';
  const TOKEN_PATH = '/auth/v1/token';
  const SCREENSHOT_DIRECTORY = process.env['MLB_SCREENSHOT_DIR'];

  const text = LOCAL_UI_MANUAL_LOGIN_TEXT;

  /** サーバの準備と Server Function の呼び出し（束の 1 つのサーバ。`helpers/ui-server.ts`）。 */
  const { started, rootOf, contextOf, idsOf, valueOf, setUp, tearDown } = sharedUiServerKitOf(serverKit);

  const { openPage, screenshot, expectCleanAndClosePages, takeConsoleErrors } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
    maxTabPresses: MAX_TAB_PRESSES,
    screenshotDirectory: SCREENSHOT_DIRECTORY,
  });

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  afterAll(async () => {
    await tearDown();
  });

  // -------------------------------------------------------------------------------------------------------------
  // 元: manual-login-ui.test.ts（ML-b）
  // -------------------------------------------------------------------------------------------------------------
  /**
   * ML-b（設計書 `doc/design/2026-10-19-beaksight-manual-login-pass-through-design.md` の 2.2〜2.4）: 手動のログインの間の画面を、ビルドした画面のサーバ
   * （一時の root）と headless の Chromium で確かめる。ジョブの行は、テストだけの操作で管理データに書く（ワーカーは起動しない。サイトへは接続しない）。
   * - ジョブが `AWAITING_LOGIN` のときだけ、「ログインを終えた」のボタンと説明を出す。押すと、ジョブの管理の口（`confirmManualLogin`）を呼ぶ Server Function
   *   （POST）を送り、拒まれたら理由を出す（この場面のジョブは、ジョブの管理が動かしていないので、受け付けない）。CSRF と入力の形の確かめは `server-guards.test.ts` の Server Function の表。
   * - 手動のログインの成功から自動で登録した設定（認証の設定の版 3 のスクリプトの送信先、ログインに伴う送信、成功の鍵の形と、プロファイルの承認したサービスの
   *   Origin）を、ジョブの画面とプロファイルの画面に出し、認証の設定の画面への入口と、保存でプロファイルの改訂が進むことの知らせを置く。
   * 値は匿名（`example.invalid` とループバック）。
   */
  describe('manual-login-ui (ML-b)', () => {
    const PROFILE_ID = 'mlb-manual';
    const AWAITING_JOB_ID = 'job-mlb-awaiting';
    const AUTHENTICATED_JOB_ID = 'job-mlb-authenticated';
    const JOB_CREATED_AT = '20261019010000';
    const JOB_ENDED_AT = '20261019011000';
    const TENANT_PATH = '/rest/v1/rpc/resolve_tenant';

    /** 自動で登録したとする、スクリプトで送るログインの認証の設定（版 3）。 */
    const scriptSetupOf = (profileId: string, profileRevision: number) => ({
      schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
      profileId,
      profileRevision,
      loginStartUrl: `${TEST_ORIGIN}/auth`,
      loginPostEndpoints: [],
      successCondition: { pathPrefix: '/admin', selector: null },
      sessionLostCondition: { pathPrefix: '/auth' },
      excludedPaths: ['/auth/logout'],
      auditPathPrefixes: [],
      maxLoginAttempts: 1,
      allowedIdpOrigins: [],
      automatedLogin: null,
      loginTransport: 'SCRIPT_REQUEST',
      scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      loginSideRequests: [{ origin: SERVICE_ORIGIN, path: TENANT_PATH, method: 'POST', maxPerLoginStage: 2 }],
      successStorageKey: { origin: TEST_ORIGIN, prefix: '', suffix: '-auth-token' },
    });

    /** テストだけの操作: ジョブの行を書き、最後の認証の状態にする（ワーカーの代わり）。`ended` なら終わった行にする（同時に動くジョブは 1 つだけ）。 */
    const writeJob = (jobId: string, state: 'AWAITING_LOGIN' | 'AUTHENTICATED', ended: boolean): void => {
      const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
      try {
        expect(createStartingJob(database, { jobId, jobKind: 'AUDIT', profileId: PROFILE_ID, profileRevision: 2, startNew: true, createdAt: JOB_CREATED_AT }, () => null))
          .toEqual({ ok: true });
        expect(recordAuthState(database, jobId, state, null, null)).toBe(true);
        if (ended) {
          expect(recordEnded(database, jobId, { state: 'FAILED', reason: 'LOGIN_TIMEOUT', exitCode: null, at: JOB_ENDED_AT })).toBe(true);
        }
      } finally {
        closeControlDatabase(database);
      }
    };

    beforeAll(async () => {
      await setUp((root) => {
        writeAuthTargetConfig(root.root, PROFILE_ID, TEST_ORIGIN, '/admin', MAX_PAGES);
      });
      const profile = {
        schemaVersion: 'beaksight-profile/1', profileId: PROFILE_ID, revision: 1, targetConfigPath: `config/targets/${PROFILE_ID}.json`, environment: 'TEST',
        mode: 'TEST_AUTH_PASSIVE', auth: 'MANUAL_SESSION', approvedTestOrigins: [TEST_ORIGIN], environmentEvidenceRef: `${PROFILE_ID}-evidence`,
      };
      expect(await valueOf('createProfileFn', 'POST', { profile })).toMatchObject({ ok: true });
      // 自動で登録したとする設定: プロファイルの承認したサービスの Origin（改訂が進む）と、認証の設定の版 3。MI-F1（設計書 4.7.1 の 1）: 画面の編集の口では
      // 承認したサービスの Origin を足せない（手動のログインの観察だけが足す）ので、テストの準備は保存の部品で直接更新する。
      expect(await updateProfileInStore(rootOf().root, { ...profile, revision: 2, approvedServiceOrigins: [SERVICE_ORIGIN] }, 1))
        .toMatchObject({ ok: true });
      expect(await saveAuthSetupRequestInStore(rootOf(), { setup: scriptSetupOf(PROFILE_ID, 2) })).toMatchObject({ ok: true });
      writeJob(AUTHENTICATED_JOB_ID, 'AUTHENTICATED', true);
      writeJob(AWAITING_JOB_ID, 'AWAITING_LOGIN', false);
    }, SCENARIO_TIMEOUT_MS);

    // 束: 「ログイン待ち」で書いた行を終わった行にする（後の describe のジョブの開始を、同時に 1 つの決まりに当てない）。
    afterAll(() => {
      const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
      try {
        expect(recordEnded(database, AWAITING_JOB_ID, { state: 'FAILED', reason: 'LOGIN_TIMEOUT', exitCode: null, at: JOB_ENDED_AT })).toBe(true);
      } finally {
        closeControlDatabase(database);
      }
    });

    describe('ML-b: the "login finished" button while the job awaits the manual login', () => {
      it('shows the button and the note only while the job awaits the login, and shows the reason when the job manager does not accept it', async () => {
        const page = await openPage(`/jobs/${AWAITING_JOB_ID}`);
        // PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 13 章の 11）: 待つ間は 1 つのパネル（要点）に、要点の 1 行「開いたブラウザで、ログインして
        // ください」と、主のボタン「ログインを終えた」。前の説明の文（送信の形の記録など）は出さない。
        const button = page.getByTestId('job-summary-panel').getByTestId('job-manual-login-confirm');
        await button.waitFor({ timeout: UI_TIMEOUT_MS });
        expect(await page.getByTestId('job-result').textContent()).toBe(LOCAL_UI_JOB_SUMMARY_TEXT.active.AWAITING_LOGIN);
        expect(await page.getByTestId('job-manual-login-note').count()).toBe(0);
        const panel = page.getByTestId('job-manual-login');
        expect(await button.textContent()).toBe(text.confirm);
        await screenshot(page, 'mlb-01-awaiting-login');
        await button.click();
        // この場面のジョブは、ジョブの管理が動かしていない（テストだけの行）ので、受け付けない（ML-b-2: ジョブの管理の閉じた一覧の理由）。理由の説明を出す。
        const rejection = panel.getByTestId('job-manual-login-rejection');
        await rejection.waitFor({ timeout: UI_TIMEOUT_MS });
        expect(await rejection.getAttribute('data-reason')).toBe('JOB_NOT_ACTIVE');
        expect(await rejection.textContent()).toContain(text.rejected);
        expect(await rejection.textContent()).toContain(text.rejectionReasons.JOB_NOT_ACTIVE);
      }, SCENARIO_TIMEOUT_MS);

      // 束: 前の「does not show the button when the job does not await the login」は、同じ認証済みのジョブの画面を開く下の場面に寄せた（ML-b-2 の 1 つ目も、
      // 認証済みになった後にボタンが消えることを確かめる）。
    });

    describe('ML-b: the settings registered from the manual login', () => {
      it('shows the registered settings on the job screen with the note of the profile revision, and keeps them off the profile screen', async () => {
        // PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 2 章、3 章の 1。作業記録 UX-1 の画面 A の 1.3「手動のログインから登録した設定」は隠す）: サイトの
        // 画面には、登録した設定の欄（token の送信先・承認したサービスの Origin などの技術の値）を出さない。見直す道は、詳しい内容の「ログインの設定を開く」。
        // 前はサイトの画面にも同じ欄を出していた。
        const profilePage = await openPage(`/profiles/${PROFILE_ID}`);
        await profilePage.getByTestId('profile-summary').waitFor({ timeout: UI_TIMEOUT_MS });
        expect(await profilePage.getByTestId('profile-login-setup').count()).toBe(0);
        expect(await profilePage.getByRole('main').innerText()).not.toContain(SERVICE_ORIGIN);
        expect(await profilePage.getByTestId('profile-detail-actions').locator('[data-action="AUTH_SETUP"]').getAttribute('href')).toBe(`/auth-setup/${PROFILE_ID}`);
        // PL-1（4 章の 1）: 「次から自動でログインする」は、手でログインした点検が 1 回終わってから出す（この場面の点検は、どれも終わっていない）。
        expect(await profilePage.locator('main [data-action="AUTOMATED_LOGIN_SETUP"]').count()).toBe(0);
        await screenshot(profilePage, 'mlb-02-profile-summary');
        for (const [path, testId] of [[`/jobs/${AUTHENTICATED_JOB_ID}`, 'job-login-setup']] as const) {
          const page = await openPage(path);
          // 束（前の「does not show the button when the job does not await the login」）: ログインを待っていないジョブには、ボタンを出さない。
          await page.getByTestId('job-result').waitFor({ timeout: UI_TIMEOUT_MS });
          expect(await page.getByTestId('job-auth').count()).toBe(1);
          expect(await page.getByTestId('job-manual-login').count()).toBe(0);
          expect(await page.getByTestId('job-manual-login-confirm').count()).toBe(0);
          const panel = page.getByTestId(testId);
          // PL-2（3 章の 1・2）: 作業の画面では、登録した設定はたたんだ詳しい内容の中。
          if (testId === 'job-login-setup') {
            await openAdvancedSettings(page, 'job-details', UI_TIMEOUT_MS);
          }
          await panel.waitFor({ timeout: UI_TIMEOUT_MS });
          expect(await panel.locator('[data-item="token"]').textContent()).toContain(`${SERVICE_ORIGIN}${TOKEN_PATH}`);
          expect(await panel.locator('[data-item="token"]').textContent()).toContain('grant_type');
          expect(await panel.locator('[data-item="sideRequests"] li').evaluateAll((items) => items.map((item) => item.getAttribute('data-path')))).toEqual([TENANT_PATH]);
          expect(await panel.locator('[data-item="serviceOrigins"]').textContent()).toBe(SERVICE_ORIGIN);
          expect(await panel.locator('[data-item="successKey"]').textContent()).toBe(text.successKeyValue('', '-auth-token'));
          expect(await panel.getByTestId(`${testId}-revision-note`).textContent()).toBe(text.revisionNote);
          // PL-2（4 章の 2）: 作業の画面は、済んだ登録の見直しの入口を出さない。
          expect(await panel.getByTestId(`${testId}-review`).count()).toBe(0);
          // 値（query の値・token）は出さない。
          expect(await panel.textContent()).not.toContain('password');
          // MI-C 項目 11・MI-4（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.4）: 「次から自動でログインする」の案内は、登録した設定の欄
          // （`LoginSetupPanel`）には出さない（PL-1: サイトの画面の要点の主のボタンの 1 か所）。
          expect(await panel.getByTestId(`${testId}-automated-login`).count()).toBe(0);
          expect(await page.locator('main [data-action="AUTOMATED_LOGIN_SETUP"]').count()).toBe(0);
          await screenshot(page, `mlb-02-${testId}`);
        }
      }, SCENARIO_TIMEOUT_MS);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  // 元: manual-login-confirm-ui.test.ts（ML-b-2）
  // -------------------------------------------------------------------------------------------------------------
  /**
   * ML-b-2（設計書 `doc/design/2026-10-19-beaksight-manual-login-pass-through-design.md` の 2.2、2.3）: 手動のログインの「ログインを終えた」と、通した送信の表と、
   * 手動のログインの成功から自動で登録した設定を、ビルドした画面のサーバ（一時の root）と headless の Chromium で、本物のジョブの管理と確かめる。
   * 監査のワーカーは、一時の root の入口を偽のワーカー（`tests/helpers/fake-audit-worker.ts` の `auth-manual-confirm`。ML-a。サイトに接続しない）に替える。
   * 偽のワーカーは、ログインを待ち、「ログインを終えた」（`LOGIN_CONFIRMED`）を受けたら、通した送信の一覧とログインの段の観察つきで認証済みにして、監査に進む。
   * - ボタンを押すと、ジョブの管理がワーカーへ知らせ、監査に進む（ボタンは消える）。2 回目は、閉じた一覧の理由で拒む。
   * - 通した送信の表（行ごとの「登録する」）。
   * - ジョブが終わった後に、ジョブの管理が背後で設定を登録する。画面は、結果が書かれるまで読み直しを続け、SAVED（このジョブで登録した、足した Origin）と
   *   SKIPPED（理由と次にすること）を出す。
   * 値は匿名（`example.invalid` とループバック）。
   */
  describe('manual-login-confirm-ui (ML-b-2)', () => {
    const JOB_WAIT: ServerFunctionJobWaitTiming = Object.freeze({ limitMs: 30_000, stepMs: 100 });
    const PROFILE_ID = 'mlb2-manual';
    const FIRST_REVISION = 1;
    const TENANT_PATH = '/rest/v1/rpc/current_tenant';
    const AFTER_TOKEN_PATH = '/rest/v1/rpc/after_login';
    const LOGOUT_PATH = '/auth/v1/logout';
    const ANALYTICS_ORIGIN = 'https://analytics.example.invalid';
    const ANALYTICS_PATH = '/v1/collect';
    const WORKER_ENTRY = TEST_WORKER_ENTRY;
    const FAKE_HEARTBEAT_INTERVAL_MS = 200;
    const FAKE_RUN_ID = 'RUN-20261019000000';
    const OTHER_RUN_ID = 'RUN-20261019000999';

    /**
     * 手動のログインの段で通した送信（最初に見た順。理由は、通さなければ止めた理由）。ML-b-3（ML-a-fix の決まり）: 印 `beforeToken` は、token の送信より前に
     * 最初に見た行だけ。自動で登録するログインに伴う送信は、印があり、種類が fetch・xhr で、手続きの呼び出しの path（`/rpc/`）で、危険な語・読まないパスで
     * ない行だけ。
     * - テナントを決める手続きの呼び出し（token の前。`/rpc/`）: 登録する。回数は閉じた上限の定数にする（上限の決まりが変わっても、値を書き写さない）。
     * - 第三者の解析の送信（token の前。手続きの呼び出しでない）: 登録しない（案だけ）。Origin も足さない。
     * - token の送信: token の送信先として登録する。
     * - token の後の手続きの呼び出し: 登録しない（案だけ）。
     * - 危険な語の path（ログアウト。token の後）: 登録しない。
     */
    const PASSED_REQUESTS = Object.freeze({
      requests: [
        { origin: SERVICE_ORIGIN, path: TENANT_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE, beforeToken: true },
        { origin: ANALYTICS_ORIGIN, path: ANALYTICS_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1, beforeToken: true },
        {
          origin: SERVICE_ORIGIN, path: TOKEN_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
          query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] },
        },
        { origin: SERVICE_ORIGIN, path: AFTER_TOKEN_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1 },
        { origin: SERVICE_ORIGIN, path: LOGOUT_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1 },
      ],
      unlisted: 0,
    });
    const LOGIN_OBSERVATION = Object.freeze({ storageKeys: { origin: TEST_ORIGIN, shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 } });

    let worker: FakeWorker | undefined;

    const workerOf = (): FakeWorker => {
      if (worker === undefined) throw new Error('偽のワーカーがない');
      return worker;
    };

    interface JobValue {
      readonly active: boolean;
      readonly lastAuthState: string | null;
      readonly loginStage: { readonly autoRegistration?: unknown } | null;
    }

    /** ジョブの値を 1 回読む（画面のサーバの管理データを読むだけ）。条件に当たるまで待つのは `waitForJobViaServerFunctions`。 */
    const readJob = (jobId: string): Promise<JobValue | null> => valueOf<JobValue | null>('getAuditJobFn', 'GET', { jobId });

    /** 手動のログインの認証の設定（版 2。フォームの送信のログイン）。 */
    const formSetupOf = (profileRevision: number) => ({
      ...FORM_NAVIGATION_SETUP_ITEMS,
      profileId: PROFILE_ID,
      profileRevision,
      loginStartUrl: `${TEST_ORIGIN}/auth`,
      loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/auth' }],
      successCondition: { pathPrefix: '/admin', selector: null },
      sessionLostCondition: { pathPrefix: '/auth' },
      excludedPaths: ['/auth/logout'],
      auditPathPrefixes: [],
      maxLoginAttempts: 1,
      allowedIdpOrigins: [],
      automatedLogin: null,
    });

    const startJob = async (expectedRevision: number): Promise<string> => {
      const start = await valueOf<{ ok: boolean; jobId: string }>('startAuditJobFn', 'POST', { profileId: PROFILE_ID, expectedRevision, startNew: true });
      expect(start.ok, JSON.stringify(start)).toBe(true);
      return start.jobId;
    };

    const confirmedMessages = (): number => workerOf().received().filter((message) => message['type'] === 'LOGIN_CONFIRMED').length;

    beforeAll(async () => {
      await setUp((root) => {
        writeAuthTargetConfig(root.root, PROFILE_ID, TEST_ORIGIN, '/admin', MAX_PAGES);
        const directory = `${root.root}/fake-workers/mlb2`;
        mkdirSync(directory, { recursive: true });
        worker = writeFakeWorker(directory, 'auth-manual-confirm', fakeWorkerValuesOf({ runId: FAKE_RUN_ID, otherRunId: OTHER_RUN_ID }, {
          heartbeatIntervalMs: FAKE_HEARTBEAT_INTERVAL_MS,
          loginStage: { passedRequests: PASSED_REQUESTS, loginObservation: LOGIN_OBSERVATION },
        }));
        writeFileSync(`${root.root}/${WORKER_ENTRY}`, readFileSync(worker.path, 'utf8'), 'utf8');
      });
      const profile = {
        schemaVersion: 'beaksight-profile/1', profileId: PROFILE_ID, revision: FIRST_REVISION, targetConfigPath: `config/targets/${PROFILE_ID}.json`,
        environment: 'TEST', mode: 'TEST_AUTH_PASSIVE', auth: 'MANUAL_SESSION', approvedTestOrigins: [TEST_ORIGIN], environmentEvidenceRef: `${PROFILE_ID}-evidence`,
      };
      expect(await valueOf('createProfileFn', 'POST', { profile })).toMatchObject({ ok: true });
      expect(await saveAuthSetupRequestInStore(rootOf(), { setup: formSetupOf(FIRST_REVISION) })).toMatchObject({ ok: true });
    }, SCENARIO_TIMEOUT_MS);

    describe('ML-b-2: the manual login with the job manager and the fake worker', () => {
      it('goes on to the audit when the button is pressed, shows the passed requests, and shows the settings this job registered', async () => {
        const jobId = await startJob(FIRST_REVISION);
        const page = await openPage(`/jobs/${jobId}`);
        const panel = page.getByTestId('job-manual-login');
        // PL-2（13 章の 11）: 「ログインを終えた」は、要点の主のボタン（要点の 1 つのパネルの中）。
        const confirmButton = page.getByTestId('job-summary-panel').getByTestId('job-manual-login-confirm');
        await confirmButton.waitFor({ timeout: UI_TIMEOUT_MS });
        await screenshot(page, 'mlb2-01-awaiting-login');
        expect(confirmedMessages()).toBe(0);
        await confirmButton.click();

        // ボタンを押す → ジョブの管理がワーカーへ知らせ、監査に進む（認証済み。ボタンは消える）。
        await expect.poll(() => page.getByTestId('job-auth-state').getAttribute('data-auth-state'), { timeout: UI_TIMEOUT_MS }).toBe('AUTHENTICATED');
        await expect.poll(() => panel.count(), { timeout: UI_TIMEOUT_MS }).toBe(0);
        expect(await confirmButton.count()).toBe(0);
        expect(confirmedMessages()).toBe(1);
        // 2 回目は、閉じた一覧の理由で拒む（ワーカーへは送らない）。
        expect(await valueOf('confirmManualLoginFn', 'POST', { jobId })).toEqual({ ok: false, reason: 'ALREADY_CONFIRMED' });
        expect(confirmedMessages()).toBe(1);

        // 通した送信の表（行ごとに、通さなければ止めた理由と「登録する」）。PL-2（3 章の 1・2）: 表は、たたんだ詳しい内容の中。
        await openAdvancedSettings(page, 'job-details', UI_TIMEOUT_MS);
        const passed = page.getByTestId('job-login-stage-passed');
        await passed.waitFor({ timeout: UI_TIMEOUT_MS });
        const rows = passed.locator('tbody tr');
        expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-path'))))
          .toEqual([TENANT_PATH, ANALYTICS_PATH, TOKEN_PATH, AFTER_TOKEN_PATH, LOGOUT_PATH]);
        expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-reason')))).toEqual(PASSED_REQUESTS.requests.map(() => 'NON_READ_METHOD'));
        // ML-b-3: token の送信より前に最初に見た行の印（カタログの文言）。
        expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-before-token')))).toEqual(['true', 'true', null, null, null]);
        expect(await rows.nth(0).textContent()).toContain(LOCAL_UI_LOGIN_STAGE_TEXT.passedBeforeToken);
        expect(await rows.nth(2).textContent()).not.toContain(LOCAL_UI_LOGIN_STAGE_TEXT.passedBeforeToken);
        const tokenRow = passed.locator(`tbody tr[data-path="${TOKEN_PATH}"]`);
        expect(await tokenRow.getByTestId('job-login-stage-query').textContent()).toContain('grant_type');
        expect(await tokenRow.getByTestId('job-login-stage-register').getAttribute('data-registration')).toBe('TOKEN_TARGET');
        // 自動で登録しない行も、表の「登録する」の案として出る（第三者の解析の送信、token の後の手続きの呼び出し）。
        for (const path of [ANALYTICS_PATH, AFTER_TOKEN_PATH]) {
          expect(await passed.locator(`tbody tr[data-path="${path}"]`).getByTestId('job-login-stage-register').getAttribute('data-registration'), path)
            .toBe('SIDE_REQUEST');
        }
        await screenshot(page, 'mlb2-02-passed-requests');

        // ジョブが終わったら、ジョブの管理が背後で設定を登録する。画面は、読み込み直しなしで、このジョブで登録したことと足した Origin を出す。
        expect(await valueOf('stopAuditJobFn', 'POST', { jobId, force: false })).toMatchObject({ ok: true });
        const registration = page.getByTestId('job-login-auto-registration');
        await registration.waitFor({ timeout: UI_TIMEOUT_MS });
        expect(await registration.getAttribute('data-result')).toBe('SAVED');
        expect(await registration.textContent()).toContain(text.autoRegistration.saved);
        expect(await registration.textContent()).toContain(LOCAL_UI_TEXT.profileForm.revisionText(FIRST_REVISION + 1));
        // 足す Origin は、token の送信先と、自動で登録した送信の送り先だけ（第三者の解析の Origin は足さない）。
        expect(await registration.locator('[data-item="addedServiceOrigins"]').textContent()).toBe(SERVICE_ORIGIN);
        // 登録した設定の中身: token の送信先と、token の前の手続きの呼び出しだけ（解析の送信、token の後の送信、危険な語の path は入れない）。
        const setup = page.getByTestId('job-login-setup');
        expect(await setup.locator('[data-item="token"]').textContent()).toContain(`${SERVICE_ORIGIN}${TOKEN_PATH}`);
        const sides = setup.locator('[data-item="sideRequests"] li');
        expect(await sides.evaluateAll((items) => items.map((item) => item.getAttribute('data-path')))).toEqual([TENANT_PATH]);
        expect(await sides.first().textContent()).toBe(text.sideRequestValue(
          httpMethodLabel(LOGIN_SIDE_REQUEST_METHODS[0]), `${SERVICE_ORIGIN}${TENANT_PATH}`, formatCount(MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE),
        ));
        expect(await setup.locator('[data-item="serviceOrigins"]').textContent()).toBe(SERVICE_ORIGIN);
        // MI-C 項目 11（MI-4 の報告。意図して直した期待）: 「次から自動でログインする」の案内は、プロファイルの詳細の「次にすること」の 1 か所だけ
        // （`AutomatedLoginReadinessNote`。そろいを判定する）。ジョブの画面の登録した設定の欄には出さない。
        expect(await page.getByTestId('job-login-setup-automated-login').count()).toBe(0);
        // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D5）: 「次から自動でログインする」は、ふだんの流れからなくした（どこにも出ない）。
        expect(await page.getByText('次から自動でログインする', { exact: true }).count()).toBe(0);
        await screenshot(page, 'mlb2-03-auto-registration-saved');
      }, SCENARIO_TIMEOUT_MS);

      it('shows the reason and the next step when the job registered nothing', async () => {
        // 前のジョブが登録した設定（改訂 2）のまま、同じ送信を通す。足すものがないので、登録しない（NOTHING_NEW）。
        const jobId = await startJob(FIRST_REVISION + 1);
        await waitForJobViaServerFunctions(readJob, jobId, (job) => job.lastAuthState === 'AWAITING_LOGIN', JOB_WAIT);
        expect(await valueOf('confirmManualLoginFn', 'POST', { jobId })).toEqual({ ok: true });
        await waitForJobViaServerFunctions(readJob, jobId, (job) => job.lastAuthState === 'AUTHENTICATED', JOB_WAIT);
        expect(await valueOf('stopAuditJobFn', 'POST', { jobId, force: false })).toMatchObject({ ok: true });
        await waitForJobViaServerFunctions(readJob, jobId, (job) => !job.active, JOB_WAIT);
        const page = await openPage(`/jobs/${jobId}`);
        // PL-2（3 章の 1・2）: 登録の結果の詳しいことは、たたんだ詳しい内容の中。
        await openAdvancedSettings(page, 'job-details', UI_TIMEOUT_MS);
        const registration = page.getByTestId('job-login-auto-registration');
        await registration.waitFor({ timeout: UI_TIMEOUT_MS });
        expect(await registration.getAttribute('data-result')).toBe('SKIPPED');
        expect(await registration.getAttribute('data-reason')).toBe('NOTHING_NEW');
        const shown = await registration.textContent();
        expect(shown).toContain(text.autoRegistration.skipped);
        expect(shown).toContain(text.autoRegistration.skipReasons.NOTHING_NEW.label);
        expect(shown).toContain(text.autoRegistration.skipReasons.NOTHING_NEW.next);
        // FM-1（設計書 2.3）: 「次から自動でログインする」は、このジョブが登録した（SAVED）ときだけ出す。
        expect(await page.getByTestId('job-login-setup-automated-login').count()).toBe(0);
        await screenshot(page, 'mlb2-04-auto-registration-skipped');
      }, SCENARIO_TIMEOUT_MS);

      it('DEF-146: shows the request error when the call of "ログインを終えた" fails, and the button can be pressed again', async () => {
        const jobId = await startJob(FIRST_REVISION + 1);
        await waitForJobViaServerFunctions(readJob, jobId, (job) => job.lastAuthState === 'AWAITING_LOGIN', JOB_WAIT);
        const page = await openPage(`/jobs/${jobId}`);
        const panel = page.getByTestId('job-manual-login');
        const button = page.getByTestId('job-summary-panel').getByTestId('job-manual-login-confirm');
        await button.waitFor({ timeout: UI_TIMEOUT_MS });
        const before = confirmedMessages();
        // テストだけの操作: 「ログインを終えた」の要求を通信の誤りで終える（Server Function の呼び出しが例外を投げる）。
        await page.route((url) => isServerFunctionUrlOf(idsOf(), 'confirmManualLoginFn', url), (route) => route.abort('failed'));
        await button.click();
        const failed = panel.getByTestId('job-manual-login-request-failed');
        await failed.waitFor({ timeout: UI_TIMEOUT_MS });
        expect(await failed.textContent()).toContain(text.rejected);
        expect(await failed.textContent()).toContain(text.requestFailed);
        expect(await panel.getByTestId('job-manual-login-rejection').count()).toBe(0);
        expect(await panel.getByTestId('job-manual-login-accepted').count()).toBe(0);
        expect(await button.isDisabled()).toBe(false);
        expect(confirmedMessages()).toBe(before);
        await screenshot(page, 'mlb2-05-confirm-request-failed');
        await page.close();
        // わざと起こした読み込みの誤りだけを、console の誤りの記録から外す。
        expect(takeConsoleErrors(page, /^Failed to load resource: /u).length).toBeGreaterThan(0);
        expect(await valueOf('stopAuditJobFn', 'POST', { jobId, force: false })).toMatchObject({ ok: true });
        await waitForJobViaServerFunctions(readJob, jobId, (job) => !job.active, JOB_WAIT);
      }, SCENARIO_TIMEOUT_MS);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 元: automated-login-setup-ui.test.ts（FM2e・MI-4）
// ---------------------------------------------------------------------------------------------------------------
/**
 * FM2e（手を減らす段 2 の設計書 3A.4）: 手動のログインの成功の後の「次から自動でログインする」から、1 つの画面（資格情報の画面の、手動のログインの
 * プロファイルの形）で、認証の方式の変更・ログインの 3 つのセレクタ・資格情報を、確認 1 回で保存する。ビルドした画面のサーバ（一時の root）と headless の
 * Chromium で、本物のジョブの管理と確かめる。監査のワーカーは偽のワーカー（`auth-manual-confirm`。サイトに接続しない）に替える。偽のワーカーは、
 * 「ログインを終えた」を受けたら、通した送信の一覧とログインの段の観察（ログインの欄の案つき）で認証済みにする。
 * - 案の入った画面: 3 つのセレクタの案は、画面に出さずにそのまま送る（PL-4。前は欄に案と推測の印を出し、人が直せた）。
 * - 確認のダイアログ: 変えるもの（方式・回数の上限・資格情報）と、改訂が進むこと。PL-S: セレクタは出さず、パスワードを入れる先（ホストだけ）・テスト用の
 *   アカウントだけ・保存の場所・回数の決まりを出す。
 * - 保存の後: 自動ログインのプロファイルになり、資格情報を保存する。PL-4: 点検の開始の画面へ移る（ログインの確かめは始めない。判断 1）。
 * - 拒否（2 回入れたパスワードの違い）: 理由と、何も保存していないこと。入力は空にする。
 * - パスワードは画面に出ない: 目印の値が、ページの HTML、Server Function の応答、管理データのファイルと WAL、偽のワーカーが受けたメッセージにない。
 * - MI-4（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.4。案のそろった画面の確かめを 4.4 に合わせて直した）: 3 つのセレクタの案が
 *   そろうときは、見える入力は資格情報の 3 欄と「自動ログインにする」だけ（PL-4: セレクタの欄は出さない）。
 * - MI-4（受け入れ条件 3）: プロファイルの詳細の「次にすること」の「次から自動でログインする」（手動のログインの登録の前は、手動のログインで 1 回ログインする
 *   案内）→ 資格情報の 3 欄と確認 → ログインの確かめ、が、認証の設定の画面を開かずに通る。ログインの確かめのジョブは、偽のワーカー（`auto-login-success`）に
 *   替えて行う。
 * - MI-4 の C（設計書 8 章）: 自動ログインに切り替えたプロファイルを、手動のログインへ戻す道（詳しい設定の編集で認証の方式を戻す → 古くなった認証の設定を
 *   保存し直す）の後に、手動のログインの監査と自動の登録が通ること。もう一度切り替えるには、残った資格情報を先に消すこと。
 * - MI-F2 / OP-1 の本物のワーカーの通し（作成の画面 → 手でのログイン → 自動ログインの 2 回目）は、SLIM-GROUP UI-7 で `one-pass-write-flow.test.ts` に任せた。
 * 資格情報は、本物の DPAPI（Windows だけ。一時の root の中の資格情報のフォルダ）で暗号化する。Windows でなければ、理由を出して飛ばす。値は匿名
 * （`example.invalid` とループバック）。
 */
describe('automated-login-setup-ui: the one screen of the automated login (FM2e, MI-4)', () => {
  const IS_WINDOWS = process.platform === 'win32';
  const SKIP_REASON = 'the one screen saves the credential with the real DPAPI, which exists only on Windows';
  const UI_TIMEOUT_MS = 20_000;
  const SCENARIO_TIMEOUT_MS = 180_000;
  const JOB_WAIT: ServerFunctionJobWaitTiming = Object.freeze({ limitMs: 30_000, stepMs: 100 });
  const MAX_TAB_PRESSES = 80;
  const MAX_PAGES = 4; // L14: 3 は前の既定と同じ値（読むときに捨てられる）なので 4。
  const PROFILE_ID = 'fm2e-manual-ui';
  /** MI-4: 「次にすること」から自動ログインへ進むプロファイル（スクリプトで送るログイン。手動のログインの自動の登録の前は、token の送信先と成功の鍵がない）。 */
  const FLOW_PROFILE_ID = 'mi4-manual-flow';
  const FIRST_REVISION = 1;
  const TEST_ORIGIN = 'http://127.0.0.1:4173';
  const SERVICE_ORIGIN = 'https://service.example.invalid';
  const TOKEN_PATH = '/auth/v1/token';
  const WORKER_ENTRY = TEST_WORKER_ENTRY;
  const STATUS_OK = 200;
  const SCREENSHOT_DIRECTORY = process.env['FM2E_SCREENSHOT_DIR'];
  /** 案（偽のワーカーが、ログインの段の始めに検出した形で送る）。 */
  const FIELDS = Object.freeze({ username: '#email', password: '#password', submit: '#login' });

  /** 実行ごとの目印（値を出力しない。比べるときは真偽だけを見る）。 */
  const RUN = randomUUID();
  const USER = `fm2e-user-${RUN}`;
  const PASS = `fm2e-pass-${RUN}`;
  const PASS_TYPO = `fm2e-typo-${RUN}`;
  const MARKERS = Object.freeze([USER, PASS, PASS_TYPO]);
  const leaks = (value: string): boolean => MARKERS.some((marker) => value.includes(marker));

  /** 手動のログインの段で通した送信（token の送信だけ）と、観察（成功の鍵の形と、ログインの欄の案）。 */
  const PASSED_REQUESTS = Object.freeze({
    requests: [{
      origin: SERVICE_ORIGIN, path: TOKEN_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
      query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] },
    }],
    unlisted: 0,
  });
  const LOGIN_OBSERVATION = Object.freeze({
    storageKeys: { origin: TEST_ORIGIN, shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 },
    loginFields: FIELDS,
  });

  const text = LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT;

  /** サーバの準備と Server Function の呼び出し（束の 1 つのサーバ。`helpers/ui-server.ts`）。 */
  const { started, rootOf, contextOf, call, setUp, tearDown } = sharedUiServerKitOf(serverKit);

  let worker: FakeWorker | undefined;
  /** MI-4: ログインの確かめのジョブの偽のワーカー（成功で終える）。 */
  let loginCheckWorker: FakeWorker | undefined;
  const htmlSnapshots: string[] = [];
  const responseBodies: string[] = [];

  const { openPage, screenshot, expectCleanAndClosePages } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
    maxTabPresses: MAX_TAB_PRESSES,
    screenshotDirectory: SCREENSHOT_DIRECTORY,
    // Server Function の応答の本文を集める（目印がないことを確かめる）。
    onPageCreated: (page) => {
      page.on('response', (response) => {
        if (response.url().includes('/_serverFn/')) {
          void response.text().then((body) => responseBodies.push(body), () => undefined);
        }
      });
    },
  });

  const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
    const result = await call(name, method, data);
    expect(result.response.status, name).toBe(STATUS_OK);
    responseBodies.push(JSON.stringify(result.value));
    return result.value as T;
  };

  interface JobValue {
    readonly active: boolean;
    readonly lastAuthState: string | null;
    readonly loginStage: { readonly autoRegistration?: { readonly result: string } } | null;
  }

  /** ジョブの値を 1 回読む（応答の本文は `valueOf` が集める）。待つのは `waitForJobViaServerFunctions`。 */
  const readJob = (jobId: string): Promise<JobValue | null> => valueOf<JobValue | null>('getAuditJobFn', 'GET', { jobId });

  /** ページの HTML を覚える（最後に目印がないことを確かめる）。 */
  const snapshot = async (page: Page): Promise<void> => {
    htmlSnapshots.push(await page.content());
  };

  /**
   * MI-4・PL-4（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2、4 章の 3。前は、セレクタの欄を閉じた「詳しい設定」にたたんでいた）: 切り替えの画面で、
   * 見える入力が資格情報の 3 欄と「自動ログインにする」だけか。セレクタの欄・方式の表・詳しい設定は、画面にない（観察の案のまま送る）。
   */
  const expectOnlyCredentialInputsVisible = async (form: ReturnType<Page['getByTestId']>): Promise<void> => {
    expect(await form.locator('details').count()).toBe(0);
    expect(await form.locator('[data-testid="automated-login-setup-selector"], [data-testid="automated-login-setup-method"]').count()).toBe(0);
    expect(await form.locator('input:visible, select:visible, textarea:visible').evaluateAll((items) => items.map((item) => item.getAttribute('name'))))
      .toEqual(['username', 'password', 'passwordConfirmation']);
    expect(await form.locator('button:visible').evaluateAll((items) => items.map((item) => item.getAttribute('data-testid'))))
      .toEqual(['automated-login-setup-review']);
    const shown = await form.innerText();
    for (const selector of Object.values(FIELDS)) {
      expect(shown, selector).not.toContain(selector);
    }
  };

  /** PL-4（設計書 6 章の 4）: 確定の後に移る点検の開始の画面の URL（移った印と、自動ログインにした印）。 */
  const startAfterSetUpUrlOf = (profileId: string): RegExp => new RegExp(`/start/${profileId}[?]arrived=auto&automatedLogin=setUp$`, 'u');

  /** 手動のログインの認証の設定（版 2。フォームの送信のログイン）。 */
  const formSetup = Object.freeze({
    ...FORM_NAVIGATION_SETUP_ITEMS,
    profileId: PROFILE_ID,
    profileRevision: FIRST_REVISION,
    loginStartUrl: `${TEST_ORIGIN}/auth`,
    loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/auth' }],
    successCondition: { pathPrefix: '/admin', selector: null },
    sessionLostCondition: { pathPrefix: '/auth' },
    excludedPaths: ['/auth/logout'],
    auditPathPrefixes: [],
    maxLoginAttempts: 1,
    allowedIdpOrigins: [],
    automatedLogin: null,
  });

  beforeAll(async () => {
    if (!IS_WINDOWS) return;
    await setUp((root) => {
      writeAuthTargetConfig(root.root, PROFILE_ID, TEST_ORIGIN, '/admin', MAX_PAGES);
      const directory = `${root.root}/fake-workers/fm2e`;
      mkdirSync(directory, { recursive: true });
      worker = writeFakeWorker(directory, 'auth-manual-confirm', fakeWorkerValuesOf({ runId: 'RUN-20261022000000', otherRunId: 'RUN-20261022000999' }, {
        heartbeatIntervalMs: 200,
        loginStage: { passedRequests: PASSED_REQUESTS, loginObservation: LOGIN_OBSERVATION },
      }));
      writeFileSync(`${root.root}/${WORKER_ENTRY}`, readFileSync(worker.path, 'utf8'), 'utf8');
      const loginCheckDirectory = `${root.root}/fake-workers/mi4-login-check`;
      mkdirSync(loginCheckDirectory, { recursive: true });
      loginCheckWorker = writeFakeWorker(loginCheckDirectory, 'auto-login-success',
        fakeWorkerValuesOf({ runId: 'RUN-20261026000000', otherRunId: 'RUN-20261026000999' }, { heartbeatIntervalMs: 200 }));
    });
    const profile = {
      schemaVersion: 'beaksight-profile/1', profileId: PROFILE_ID, revision: FIRST_REVISION, targetConfigPath: `config/targets/${PROFILE_ID}.json`,
      environment: 'TEST', mode: 'TEST_AUTH_PASSIVE', auth: 'MANUAL_SESSION', approvedTestOrigins: [TEST_ORIGIN], environmentEvidenceRef: `${PROFILE_ID}-evidence`,
    };
    expect(await valueOf('createProfileFn', 'POST', { profile })).toMatchObject({ ok: true });
    expect(await saveAuthSetupRequestInStore(rootOf(), { setup: formSetup })).toMatchObject({ ok: true });
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    if (IS_WINDOWS) await expectCleanAndClosePages();
  });

  afterAll(async () => {
    await tearDown();
  });

  describe('FM2e: the one screen of the automated login', () => {
    it.skipIf(!IS_WINDOWS)(`shows the proposals, confirms the changes once, saves, and offers the login check (${SKIP_REASON} otherwise)`, async () => {
      // 手動のログインのジョブ（「ログインを終えた」→ 止める）。ジョブの管理が背後で認証の設定を登録し（改訂 2）、観察の欄の案はジョブの行に残る。
      const start = await valueOf<{ ok: boolean; jobId: string }>('startAuditJobFn', 'POST', { profileId: PROFILE_ID, expectedRevision: FIRST_REVISION, startNew: true });
      expect(start.ok, JSON.stringify(start)).toBe(true);
      await waitForJobViaServerFunctions(readJob, start.jobId, (job) => job.lastAuthState === 'AWAITING_LOGIN', JOB_WAIT);
      expect(await valueOf('confirmManualLoginFn', 'POST', { jobId: start.jobId })).toEqual({ ok: true });
      await waitForJobViaServerFunctions(readJob, start.jobId, (job) => job.lastAuthState === 'AUTHENTICATED', JOB_WAIT);
      expect(await valueOf('stopAuditJobFn', 'POST', { jobId: start.jobId, force: false })).toMatchObject({ ok: true });
      await waitForJobViaServerFunctions(readJob, start.jobId, (job) => !job.active && job.loginStage?.autoRegistration?.result === 'SAVED', JOB_WAIT);
      const revision = FIRST_REVISION + 1;

      // MI-C 項目 11: ジョブの画面の登録した設定の欄には「次から自動でログインする」を出さない（案内はプロファイルの詳細の「次にすること」の 1 か所）。
      const job = await openPage(`/jobs/${start.jobId}`);
      // PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2）: 登録した設定の欄は、たたんだ詳しい内容の中。
      await openAdvancedSettings(job, 'job-details', UI_TIMEOUT_MS);
      await job.getByTestId('job-login-setup').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await job.getByTestId('job-login-setup-automated-login').count()).toBe(0);
      // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D5）: 「次から自動でログインする」は、ふだんの流れ（要点）からなくした。1 つの画面へは、
      // サイトの画面の詳しい内容の中の直す道（ID とパスワードの画面を開く）から進む。
      const jobPage = await openPage(`/profiles/${PROFILE_ID}`);
      await profileStageOf(jobPage, UI_TIMEOUT_MS);
      expect(await jobPage.locator('main [data-action="AUTOMATED_LOGIN_SETUP"]').count()).toBe(0);
      expect(await jobPage.getByTestId('profile-login-setup').count()).toBe(0);
      await openAdvancedSettings(jobPage, 'profile-edit-advanced-settings', UI_TIMEOUT_MS);
      const offer = jobPage.getByTestId('profile-detail-actions').locator('[data-action="CREDENTIAL"]');
      expect(await offer.textContent()).toBe(LOCAL_UI_NEXT_STEP_TEXT.actions.CREDENTIAL);
      await offer.click();
      await jobPage.waitForURL(`**/credentials/${PROFILE_ID}`, { timeout: UI_TIMEOUT_MS });
      const form = jobPage.getByTestId('automated-login-setup');
      await form.waitFor({ timeout: UI_TIMEOUT_MS });
      await snapshot(jobPage);
      // 1 つの画面を出すときは、「資格情報を使わない」の知らせを出さない。
      expect(await jobPage.getByTestId('credential-not-eligible').count()).toBe(0);

      // MI-4・PL-4: 3 つの案がそろうので、セレクタは観察の案のまま送る（画面に欄も印も出さない）。見える入力は資格情報の 3 欄と「自動ログインにする」だけ。
      await expectOnlyCredentialInputsVisible(form);
      await screenshot(jobPage, 'fm2e-01-proposals');

      // 拒否（2 回入れたパスワードの違い）: 理由を出し、何も保存しない。入力は空にする。
      await form.locator('input[name="username"]').fill(USER);
      await form.locator('input[name="password"]').fill(PASS);
      await form.locator('input[name="passwordConfirmation"]').fill(PASS_TYPO);
      await form.getByTestId('automated-login-setup-review').click();
      const dialog = jobPage.getByRole('dialog', { name: text.dialog.title });
      await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
      await dialog.getByRole('button', { name: text.dialog.confirm }).click();
      const rejection = form.getByTestId('automated-login-setup-rejection');
      await rejection.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await rejection.getAttribute('data-reason')).toBe('CREDENTIAL_CONFIRMATION_MISMATCH');
      expect(await rejection.textContent()).toBe(CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS.CREDENTIAL_CONFIRMATION_MISMATCH.description);
      expect(await form.getByTestId('automated-login-setup-rollback').textContent()).toBe(text.rollbacks.NOT_NEEDED);
      expect(await form.locator('input[name="password"]').inputValue()).toBe('');
      expect(await form.locator('input[name="username"]').inputValue()).toBe('');
      expect(await valueOf<{ eligible: boolean }>('getCredentialPageFn', 'GET', { profileId: PROFILE_ID })).toMatchObject({ eligible: false });
      await snapshot(jobPage);

      // 確認のダイアログ: 変えるもの（方式・資格情報）と、改訂が進むこと。
      // PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 7 章・9 章の 2。前はセレクタの 3 行を出していた）: CSS セレクタはダイアログに出さない（直した値は保存の後の
      // 認証の設定で確かめる）。代わりに、パスワードを入れる先（ログインの画面のホストだけ）、テスト用のアカウントだけ、保存の場所、回数の決まり（定義元の定数）を出す。
      await form.locator('input[name="username"]').fill(USER);
      await form.locator('input[name="password"]').fill(PASS);
      await form.locator('input[name="passwordConfirmation"]').fill(PASS);
      await form.getByTestId('automated-login-setup-review').click();
      await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
      const rows = dialog.getByTestId('automated-login-setup-change');
      expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-item'))))
        .toEqual(['method', 'credential']);
      expect(await dialog.locator('[data-item="credential"]').textContent()).toContain(text.dialog.credentialAfter);
      const dialogText = await dialog.textContent() ?? '';
      for (const selector of Object.values(FIELDS)) {
        expect(dialogText, selector).not.toContain(selector);
      }
      expect(await dialog.getByTestId('automated-login-setup-destination').textContent()).toBe(text.dialog.destination(new URL(TEST_ORIGIN).host));
      expect(dialogText).not.toContain(TEST_ORIGIN);
      expect(await dialog.getByTestId('automated-login-setup-test-account').textContent()).toBe(text.dialog.testAccountOnly);
      expect(await dialog.getByTestId('automated-login-setup-storage').textContent()).toBe(text.dialog.storage);
      expect(await dialog.getByTestId('automated-login-setup-limits').textContent()).toBe(text.dialog.limits(
        formatInteger(AUTO_LOGIN_MIN_INTERVAL_MS / MINUTE_MS),
        formatInteger(AUTO_LOGIN_DAILY_WINDOW_MS / DAY_MS),
        formatInteger(AUTO_LOGIN_DAILY_MAX_ATTEMPTS),
      ));
      expect(await dialog.getByTestId('automated-login-setup-revision').textContent())
        .toBe(text.dialog.revisionNotice(LOCAL_UI_TEXT.profileForm.revisionText(revision), LOCAL_UI_TEXT.profileForm.revisionText(revision + 1)));
      // 承認したシナリオはない（承認が外れる知らせは出さない）。
      expect(await dialog.getByTestId('automated-login-setup-approval').count()).toBe(0);
      // パスワードはダイアログにも出ない。
      expect(leaks(await dialog.innerHTML())).toBe(false);
      await screenshot(jobPage, 'fm2e-02-dialog');
      await dialog.getByRole('button', { name: text.dialog.confirm }).click();

      // 保存の後: 自動ログインのプロファイルになり、資格情報を保存した。PL-4（設計書 4 章の 3、6 章の 4。前は、この画面に済んだ知らせ・「ログインを確かめる」の
      // 案内・次の手順のリンクを出していた）: 確定で点検の開始の画面へ移る（移った印つき）。ログインの確かめは始めない（点検の最初の自動ログインが兼ねる。判断 1）。
      await jobPage.waitForURL(startAfterSetUpUrlOf(PROFILE_ID), { timeout: UI_TIMEOUT_MS });
      // PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: 開始の画面の読む量の上限は詳しい内容の中。見えるのは要点のパネル。
      await jobPage.getByTestId('start-summary').waitFor({ timeout: UI_TIMEOUT_MS });
      // PL-3（13 章の最後の段落）: 移ってきた開始の画面の要点の 1 行目に、何が起きたか（自動ログインにした）を書く。開き直した画面（印なし）には出さない。
      expect(await jobPage.getByTestId('start-summary').locator('p').first().getAttribute('data-testid')).toBe('start-arrived-automated-login');
      expect(await jobPage.getByTestId('start-arrived-automated-login').textContent()).toBe(text.arrived);
      expect(await jobPage.getByTestId('start-submit').count()).toBe(1);
      const reopenedStart = await openPage(`/start/${PROFILE_ID}`);
      await reopenedStart.getByTestId('start-summary').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await reopenedStart.getByTestId('start-arrived-automated-login').count()).toBe(0);
      await reopenedStart.close();
      expect(await jobPage.getByTestId('automated-login-setup').count()).toBe(0);
      expect(await jobPage.getByTestId('automated-login-setup-login-check-note').count()).toBe(0);
      await snapshot(jobPage);
      await screenshot(jobPage, 'fm2e-03-saved');
      expect((await valueOf<{ credential: unknown }>('getCredentialPageFn', 'GET', { profileId: PROFILE_ID })).credential).not.toBeNull();
      const profileValue = await valueOf<{ profile: { auth: string; revision: number } } | null>('getProfileFn', 'GET', { profileId: PROFILE_ID });
      expect(profileValue?.profile).toMatchObject({ auth: 'AUTOMATED_LOGIN', revision: revision + 1 });
      const setup = await valueOf<{ stored: { setup: { automatedLogin: unknown; maxLoginAttempts: number }; freshness: string } | null }>('getAuthSetupFn', 'GET', { profileId: PROFILE_ID });
      expect(setup.stored?.freshness).toBe('CURRENT');
      // 観察の案のまま保存した（PL-4: 人が直す道はない）。
      expect(setup.stored?.setup.automatedLogin).toMatchObject({ usernameSelector: FIELDS.username, passwordSelector: FIELDS.password, submitSelector: FIELDS.submit });
      // ログインの確かめは始めていない（ジョブは、最初の手動のログインのジョブだけ）。
      const jobs = await valueOf<readonly { jobKind: string }[]>('listAuditJobsFn', 'GET');
      expect(jobs.filter((listed) => listed.jobKind === 'LOGIN_CHECK')).toEqual([]);
      expect(existsSync(credentialFilePathFor(resolveCredentialDirectory(rootOf().root), PROFILE_ID))).toBe(true);

      // パスワードは画面に出ない（HTML、応答、管理データ、偽のワーカーが受けたメッセージ）。
      expect(htmlSnapshots.filter(leaks)).toEqual([]);
      expect(responseBodies.filter(leaks)).toEqual([]);
      const dataFiles = filesUnder(`${rootOf().root}/${CONTROL_DATA_DIRECTORY_NAME}`, 'local-data');
      expect(dataFiles.length).toBeGreaterThan(0);
      expect(leakedPlaces(dataFiles, MARKERS)).toEqual([]);
      expect(leaks(JSON.stringify(worker?.received() ?? []))).toBe(false);
      expect(leaks(started().output())).toBe(false);
    }, SCENARIO_TIMEOUT_MS);
  });
  /**
   * MI-4（設計書 4.4、6 章の受け入れ条件 3、8 章）: 手動のログインの監査 → 自動の登録 → 「次にすること」の「次から自動でログインする」→ 資格情報の 3 欄と確認
   * → ログインの確かめ、が、認証の設定の画面を開かずに通る。その後、手動のログインへ戻す道で、手動のログインの監査と自動の登録が通る。
   */
  describe('MI-4: from the next steps to the automated login, and back to the manual login', () => {
    /** スクリプトで送るログインの、手動のログインの認証の設定（token の送信先と成功の鍵は、手動のログインの自動の登録が埋める）。 */
    const scriptSetupOf = (profileRevision: number) => ({
      ...formSetup,
      profileId: FLOW_PROFILE_ID,
      profileRevision,
      loginPostEndpoints: [],
      loginTransport: 'SCRIPT_REQUEST',
    });

    /** 手動のログインのジョブ（「ログインを終えた」→ 止める）を行い、自動の登録の結果を返す。 */
    const runManualLogin = async (expectedRevision: number): Promise<{ readonly result: string; readonly reason?: string }> => {
      const start = await valueOf<{ ok: boolean; jobId: string }>('startAuditJobFn', 'POST', { profileId: FLOW_PROFILE_ID, expectedRevision, startNew: true });
      expect(start.ok, JSON.stringify(start)).toBe(true);
      await waitForJobViaServerFunctions(readJob, start.jobId, (job) => job.lastAuthState === 'AWAITING_LOGIN', JOB_WAIT);
      expect(await valueOf('confirmManualLoginFn', 'POST', { jobId: start.jobId })).toEqual({ ok: true });
      await waitForJobViaServerFunctions(readJob, start.jobId, (job) => job.lastAuthState === 'AUTHENTICATED', JOB_WAIT);
      expect(await valueOf('stopAuditJobFn', 'POST', { jobId: start.jobId, force: false })).toMatchObject({ ok: true });
      const ended = await waitForJobViaServerFunctions(readJob, start.jobId,
        (job) => !job.active && job.loginStage?.autoRegistration !== undefined, JOB_WAIT);
      return ended.loginStage?.autoRegistration as { readonly result: string; readonly reason?: string };
    };

    /** ジョブの管理が起動するワーカーを替える（同じ一時の root の `TEST_WORKER_ENTRY`）。 */
    const useWorker = (fake: FakeWorker | undefined): void => {
      if (fake === undefined) throw new Error('偽のワーカーがない');
      writeFileSync(`${rootOf().root}/${WORKER_ENTRY}`, readFileSync(fake.path, 'utf8'), 'utf8');
    };

    /**
     * 自動ログインへの切り替えの画面を出せるか（資格情報の画面の値の `automatedLoginSetup`。OP-1（D5）で「次から自動でログインする」の段をなくしたので、前の段の値の
     * 代わりに、切り替えの画面そのものの値で確かめる）。
     */
    const automatedLoginOffered = async (): Promise<boolean> =>
      (await valueOf<{ automatedLoginSetup: { authSetupCurrent: boolean } | null } | null>('getCredentialPageFn', 'GET', { profileId: FLOW_PROFILE_ID }))
        ?.automatedLoginSetup?.authSetupCurrent === true;

    it.skipIf(!IS_WINDOWS)(`reaches the login check from the next steps without opening the auth setup screen, then goes back to the manual login (${SKIP_REASON} otherwise)`, async () => {
      const profile = {
        schemaVersion: 'beaksight-profile/1', profileId: FLOW_PROFILE_ID, revision: FIRST_REVISION,
        targetConfigPath: writeAuthTargetConfig(rootOf().root, FLOW_PROFILE_ID, TEST_ORIGIN, '/admin', MAX_PAGES),
        environment: 'TEST', mode: 'TEST_AUTH_PASSIVE', auth: 'MANUAL_SESSION', approvedTestOrigins: [TEST_ORIGIN], environmentEvidenceRef: `${FLOW_PROFILE_ID}-evidence`,
      };
      expect(await valueOf('createProfileFn', 'POST', { profile })).toMatchObject({ ok: true });
      expect(await saveAuthSetupRequestInStore(rootOf(), { setup: scriptSetupOf(FIRST_REVISION) })).toMatchObject({ ok: true });
      const visited: string[] = [];

      // 手でログインした点検の前: PL-1（4 章の 1）: 「次から自動でログインする」は出さず、主のボタンは「点検を始める」（開いたブラウザで手でログインする）。
      const before = await openPage(`/profiles/${FLOW_PROFILE_ID}`);
      expect(await profileStageOf(before, UI_TIMEOUT_MS)).toBe('AUDIT_MANUAL_LOGIN');
      expect(await before.getByTestId('profile-summary').locator('[data-action="AUDIT_START"]').getAttribute('href')).toBe(`/start/${FLOW_PROFILE_ID}`);
      expect(await before.locator('main [data-action="AUTOMATED_LOGIN_SETUP"]').count()).toBe(0);
      await snapshot(before);

      // 手動のログインの監査 → 自動の登録（改訂 2。token の送信先・成功の鍵・承認したサービスの Origin）。
      expect(await runManualLogin(FIRST_REVISION)).toMatchObject({ result: 'SAVED' });
      const registered = FIRST_REVISION + 1;

      // 要点の主のボタン「次から自動でログインする」→ 切り替えの画面（資格情報の画面）。
      const page = await openPage(`/profiles/${FLOW_PROFILE_ID}`);
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
      });
      // OP-1（D5）: 要点には出さない。詳しい内容の直す道（ID とパスワードの画面を開く）から進む。
      await profileStageOf(page, UI_TIMEOUT_MS);
      expect(await page.locator('main [data-action="AUTOMATED_LOGIN_SETUP"]').count()).toBe(0);
      await screenshot(page, 'mi4-01-next-steps');
      await openAdvancedSettings(page, 'profile-edit-advanced-settings', UI_TIMEOUT_MS);
      await page.getByTestId('profile-detail-actions').locator('[data-action="CREDENTIAL"]').click();
      await page.waitForURL(`**/credentials/${FLOW_PROFILE_ID}`, { timeout: UI_TIMEOUT_MS });
      const form = page.getByTestId('automated-login-setup');
      await form.waitFor({ timeout: UI_TIMEOUT_MS });
      await expectOnlyCredentialInputsVisible(form);
      await snapshot(page);
      await screenshot(page, 'mi4-02-folded');

      // 資格情報の 3 欄と確認だけで保存する（案のセレクタのまま）。
      await form.locator('input[name="username"]').fill(USER);
      await form.locator('input[name="password"]').fill(PASS);
      await form.locator('input[name="passwordConfirmation"]').fill(PASS);
      await form.getByTestId('automated-login-setup-review').click();
      const dialog = page.getByRole('dialog', { name: text.dialog.title });
      await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
      // PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 9 章の 2）: CSS セレクタはダイアログに出さない（案のまま保存したことは、保存の後の認証の設定で確かめる）。
      expect(await dialog.locator('code').count()).toBe(0);
      expect(await dialog.getByTestId('automated-login-setup-destination').textContent()).toBe(text.dialog.destination(new URL(TEST_ORIGIN).host));
      await dialog.getByRole('button', { name: text.dialog.confirm }).click();
      // PL-4（設計書 6 章の 4）: 確定で点検の開始の画面へ移る（ログインの確かめへの入口は出さない。判断 1）。
      await page.waitForURL(startAfterSetUpUrlOf(FLOW_PROFILE_ID), { timeout: UI_TIMEOUT_MS });
      await snapshot(page);
      const switched = registered + 1;
      expect((await valueOf<{ profile: { auth: string; revision: number } }>('getProfileFn', 'GET', { profileId: FLOW_PROFILE_ID })).profile)
        .toMatchObject({ auth: 'AUTOMATED_LOGIN', revision: switched });

      // ログインの確かめの画面（停止を解く入口として残す）は、直接開いて確かめる。PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 6 章の最後）: 止めて
      // いないので、要点は「止まっていません」と主のボタン「点検を始める」で、ログインだけを試すボタンはない。ログインの確かめのジョブは、開始の Server Function で
      // 始める（偽のワーカーが成功で終える）。
      useWorker(loginCheckWorker);
      await page.goto(`${started().origin}/login-check/${FLOW_PROFILE_ID}`);
      await page.waitForURL(`**/login-check/${FLOW_PROFILE_ID}`, { timeout: UI_TIMEOUT_MS });
      expect(await page.getByTestId('login-check-summary').getAttribute('data-state')).toBe('notHeld');
      expect(await page.getByTestId('login-check-open-start').getAttribute('href')).toBe(`/start/${FLOW_PROFILE_ID}`);
      expect(await page.getByTestId('login-check-start').count()).toBe(0);
      const loginCheckStart = await valueOf<{ ok: boolean; jobId: string }>('startLoginCheckFn', 'POST', { profileId: FLOW_PROFILE_ID, expectedRevision: switched });
      expect(loginCheckStart.ok).toBe(true);
      const loginCheckJobId = loginCheckStart.jobId;
      const checked = await waitForJobViaServerFunctions(readJob, loginCheckJobId, (job) => !job.active, JOB_WAIT);
      expect(checked).toMatchObject({ lastAuthState: 'AUTHENTICATED' });
      const jobs = await valueOf<readonly { jobId: string; jobKind: string; state: string }[]>('listAuditJobsFn', 'GET');
      expect(jobs.find((listed) => listed.jobId === loginCheckJobId)).toMatchObject({ jobKind: 'LOGIN_CHECK', state: 'FINISHED' });
      await page.goto(`${started().origin}/profiles/${FLOW_PROFILE_ID}`);
      // PL-1（4 章の 7）: 自動ログインをしたばかりなので、自動ログインの間隔の中。主のボタンを出さず、要点に始められる時刻を出す。
      expect(await profileStageOf(page, UI_TIMEOUT_MS)).toBe('AUTO_LOGIN_WAIT');
      expect(await page.getByTestId('profile-summary').locator('[data-action]').count()).toBe(0);
      expect(await page.getByTestId('profile-next-allowed-at').getAttribute('data-next-allowed-at')).not.toBe('');
      // 自動ログインのプロファイルには、もう「次から自動でログインする」を出さない。
      expect(await page.locator('main [data-action="AUTOMATED_LOGIN_SETUP"]').count()).toBe(0);
      await snapshot(page);
      // 認証の設定の画面は、一度も開いていない。
      expect(visited.filter((path) => path.startsWith('/auth-setup/'))).toEqual([]);
      expect(visited).toContain(`/credentials/${FLOW_PROFILE_ID}`);
      expect(visited).toContain(`/login-check/${FLOW_PROFILE_ID}`);

      // C（設計書 8 章）: 手動のログインへ戻す道。詳しい設定の編集（プロファイルの保存）で認証の方式を戻し、古くなった認証の設定を手動のログインの形
      // （`automatedLogin` なし。認証の設定の画面の保存と同じ形）で保存し直す。
      useWorker(worker);
      const current = await valueOf<{ profile: Record<string, unknown> & { revision: number } }>('getProfileFn', 'GET', { profileId: FLOW_PROFILE_ID });
      expect(await valueOf('updateProfileFn', 'POST', {
        profile: { ...current.profile, auth: 'MANUAL_SESSION', revision: switched + 1 }, expectedRevision: switched,
      })).toMatchObject({ ok: true });
      const back = switched + 1;
      expect(await automatedLoginOffered()).toBe(false);
      const stale = await valueOf<{ stored: { setup: Record<string, unknown>; freshness: string } | null }>('getAuthSetupFn', 'GET', { profileId: FLOW_PROFILE_ID });
      expect(stale.stored?.freshness).toBe('STALE');
      expect(await valueOf('saveAuthSetupFn', 'POST', { setup: { ...stale.stored?.setup, profileRevision: back, automatedLogin: null } }))
        .toMatchObject({ ok: true });
      expect(await automatedLoginOffered()).toBe(true);
      // 手動のログインの監査が通る。自動の登録は、足す送信がないので「足すものなし」（MI-G の拒否にならない）。
      expect(await runManualLogin(back)).toEqual({ result: 'SKIPPED', reason: 'NOTHING_NEW' });
      // もう一度切り替えるには、残った資格情報を先に消す（残っている間は、資格情報のファイルの部品が拒む）。
      const again = {
        profileId: FLOW_PROFILE_ID, expectedRevision: back,
        usernameSelector: FIELDS.username, passwordSelector: FIELDS.password, submitSelector: FIELDS.submit,
        username: USER, password: PASS, passwordConfirmation: PASS,
      };
      expect(await valueOf('setUpAutomatedLoginFn', 'POST', again)).toMatchObject({ ok: false, kind: 'CREDENTIAL', reason: 'CREDENTIAL_ALREADY_EXISTS' });
      expect(await valueOf('removeCredentialFn', 'POST', { profileId: FLOW_PROFILE_ID })).toMatchObject({ ok: true });
      expect(await valueOf('setUpAutomatedLoginFn', 'POST', again)).toMatchObject({ ok: true, profileRevision: back + 1 });

      // パスワードは画面と応答に出ない。
      expect(htmlSnapshots.filter(leaks)).toEqual([]);
      expect(responseBodies.filter(leaks)).toEqual([]);
      expect(leaks(JSON.stringify(loginCheckWorker?.received() ?? []))).toBe(false);
    }, SCENARIO_TIMEOUT_MS);
  });
  // SLIM-GROUP UI-7: 前の MI-F2 / OP-1 の本物のワーカーの場面（作成の画面 → 手でのログイン 1 回 → 自動ログインへの切り替え → 2 回目の自動の点検）は、
  // 同じ道を `one-pass-write-flow.test.ts`（作成 → 手でのログイン → 自動ログインの 2 回目）が本物のワーカーで流す。パスワードが画面に出ないことは
  // `login-secret-markers.test.ts`。
});

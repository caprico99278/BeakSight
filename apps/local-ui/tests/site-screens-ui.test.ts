/**
 * SLIM-GROUP の UI-3（束 S3 site-screens-ui）: サイトの一覧・作成・詳細・設定の画面のテストを、1 つの画面のサーバ（一時の root 1 つ、headless の Chromium 1 つ）で
 * 流す束。ワーカーは起動しない（ui-flows と onboarding-ui-flows の作成の画面の下調べだけは、元のファイルのとおり画面のサーバが始める）。行は、テストだけの操作で書く。
 * 元のファイル（どれも `apps/local-ui/tests/`）と、ここでの describe:
 * - ui-flows.test.ts（丸ごと。空の一覧の場面は束の最初の describe へ、「再起動の後も残る」は束の最後の describe へ移した）
 * - onboarding-ui-flows.test.ts（丸ごと）
 * - profile-screens-ui.test.ts（丸ごと。空の一覧と作成の画面の describe は束の最初へ。書き込みのモードの場面に、write-mode-switch-ui の「書き込みにも使う」の
 *   ボタンがないことの確かめを足した）
 * - audit-send-settings-ui.test.ts（丸ごと。入力の検査（400）の場面は、server-function-contract.test.ts に同じ確かめがなかったので残した）
 * - crawl-limits-ui.test.ts（丸ごと。Server Function だけの場面は、target-crawl-limits.test.ts に同じ確かめ（HTTP の 400・PROFILE_NOT_FOUND）がなかったので残した）
 * - credential-screens-ui.test.ts・display-settings-ui.test.ts・page-frame-ui.test.ts・stage-chain-ui.test.ts（丸ごと）
 * 削った場面: なし。
 * 束の決まり:
 * - 順: 空の一覧（ui-flows・profile-screens）→ stage-chain（ジョブが 1 つもないこと（`listAuditJobsFn` が空）を確かめるので、ジョブを作る describe より前）→
 *   ui-flows → onboarding → profile-screens → audit-send → crawl-limits → credential-screens → display-settings → page-frame → 再起動（最後）。
 * - 動いている行を書く describe（profile-screens の DEF-197・display-settings・page-frame）は、その describe の afterAll で終わった状態にする（ジョブは同時に 1 つ）。
 * - プロファイルの ID は、元のファイル同士でぶつからない（変えたものはない）。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Locator, Page, Route } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS } from '../../../src/control/auth/auth-setup-contracts.js';
import { createCredentialStore } from '../../../src/control/credentials/credential-store.js';
import { recordAutoLoginResult } from '../../../src/control/job/auto-login-store.js';
import {
  createStartingJob,
  recordAuthState,
  recordEnded,
  recordFinished,
  recordLoginCheckFinished,
  recordRunStarted,
} from '../../../src/control/job/job-store.js';
import { createReadCheck } from '../../../src/control/job/read-check-store.js';
import { getAuthSetup } from '../../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import type { ProfileDisplaySettings } from '../../../src/control/store/profile-store.js';
import { bundleFileName } from '../../../src/core/artifact-layout.js';
import type { RunAuditSendSummary, RunSummary } from '../../../src/core/contracts.js';
import { createRunId } from '../../../src/core/ids.js';
import { formatCompactUtcTimestamp } from '../../../src/core/utc-timestamp.js';
import { AUDIT_JOB_KIND_CATALOG, AUDIT_MODE_CATALOG, AUTOMATED_LOGIN_RESULT_CATALOG } from '../../../src/presentation/catalog.js';
import { formatCount, formatDuration, formatElapsedTime } from '../../../src/presentation/format.js';
import {
  AUDIT_JOB_START_REJECTION_DESCRIPTIONS,
  AUDIT_JOB_STOP_TARGET_NAMES,
  AUDIT_SEND_TEXT,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_SETUP_PROPOSAL_TEXT,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT,
  LOCAL_UI_CRAWL_LIMITS_TEXT,
  LOCAL_UI_CREDENTIAL_TEXT,
  LOCAL_UI_DISCOVERY_TEXT,
  LOCAL_UI_DISPLAY_NAME_TEXT,
  LOCAL_UI_DISPLAY_SETTINGS_TEXT,
  LOCAL_UI_FRAME_TEXT,
  LOCAL_UI_JOB_NEXT_STEPS,
  LOCAL_UI_JOB_SUMMARY_TEXT,
  LOCAL_UI_LEDGER_TEXT,
  LOCAL_UI_NEXT_STEP_TEXT,
  LOCAL_UI_READ_CHECK_TEXT,
  LOCAL_UI_SCENARIO_TEXT,
  LOCAL_UI_TEXT,
  PROFILE_STORE_REJECTION_DESCRIPTIONS,
  PROFILE_VALIDATION_ERROR_DESCRIPTIONS,
  RUN_SUMMARY_TEXT,
  TARGET_CRAWL_LIMIT_PROBLEM_DESCRIPTIONS,
  TARGET_CRAWL_LIMITS_CHANGE_FAILURE_DESCRIPTIONS,
  TARGET_SITE_PROBLEM_DESCRIPTIONS,
} from '../../../src/presentation/messages.js';
import { runSummary } from '../../../tests/helpers/audit-run-fixture.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { openAdvancedSettings } from './helpers/advanced-settings.ts';
import { outputDirectoryOf, publicProfileDocument, writeAuditTargetConfig } from './helpers/audit-site.ts';
import { openAuthSetupAdvancedSettings } from './helpers/auth-setup-page.ts';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
import { EXAMPLE_TARGET_CONFIG, findFreePort, startLauncher, stopServer, type StartedServer } from './helpers/local-server.ts';
import { profileStageOf, profileSummaryActionsOf } from './helpers/next-steps.ts';
import { chooseProfileUsage, createProfileOnScreen, openProfileAdvancedSettings, profileIdOfPage } from './helpers/profile-form.ts';
import { createProfileInStore, readProfileInStore, saveAuthSetupInStore, saveAuthSetupRequestInStore } from './helpers/profile-store-setup.ts';
import { axeViolationsOf, backLinkCountInMain, expectAtMostOnePrimaryButton, primaryButtonLabelsInMain } from './helpers/screen-shape.ts';
import { encodeServerFunctionPayload, isServerFunctionUrlOf } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';
import { createUiServerKit, sharedUiServerKitOf } from './helpers/ui-server.ts';
import { auditJobStateDisplay } from '../src/display/labels';

/** 束の準備（一時の root・サーバ・Chromium）を待つ上限（ミリ秒。元のファイルの準備の上限のうち、いちばん長いもの）。 */
const SCENARIO_TIMEOUT_MS = 180_000;

const serverKit = createUiServerKit();
beforeAll(() => serverKit.setUp(), SCENARIO_TIMEOUT_MS);
afterAll(() => serverKit.tearDown());

describe('束の最初: 空の一覧（ui-flows と profile-screens-ui）', () => {
  describe('ui-flows: local UI: profiles (the empty list)', () => {
    const MAX_TAB_PRESSES = 40;
    const text = LOCAL_UI_TEXT;
    const { started, contextOf } = sharedUiServerKitOf(serverKit);
    const { openPage, expectCleanAndClosePages } = createUiPageKit({
      contextOf,
      originOf: () => started().origin,
      maxTabPresses: MAX_TAB_PRESSES,
      requireCspRecord: true,
    });

    afterEach(async () => {
      await expectCleanAndClosePages();
    });

    it('shows the empty list and the menu (T24f: with the run history. T43a: with "new profile")', async () => {
      const page = await openPage('/');
      expect(await page.locator('h1').textContent()).toBe(text.pages.profiles);
      await page.getByTestId('profile-list-empty').waitFor();
      expect(await page.getByTestId('profile-list-empty').textContent()).toBe(text.profileList.empty);
      // T43a（Task 43 の設計書 4.1。ユーザーの確認）: 左のメニューに「新しいプロファイル」を足した（意図した期待の変更）。
      // PL-V（設計書 `2026-10-26-beaksight-plain-ui-design.md` 13 章の 14）: メニューは 3 つ。環境の状態は、問題があるときだけ出す（意図した期待の変更）。
      expect(await page.getByRole('navigation', { name: text.navigationLabel }).getByRole('link').allTextContents())
        .toEqual([text.pages.profiles, text.pages.newProfile, LOCAL_UI_AUDIT_TEXT.pages.jobs]);
    });
  });

  describe('profile-screens-ui: PL-1: the site list and the create screen', () => {
    const UI_TIMEOUT_MS = 20_000;
    const { started, contextOf } = sharedUiServerKitOf(serverKit);
    const { openPage, expectCleanAndClosePages } = createUiPageKit({
      contextOf,
      originOf: () => started().origin,
    });

    afterEach(async () => {
      await expectCleanAndClosePages();
    });

    it('empty list: one line of what the tool does, and the primary button right below it (13 の 12)', async () => {
      const page = await openPage('/');
      const summary = page.getByTestId('profile-list-summary');
      await summary.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await summary.locator('p').first().textContent()).toBe(LOCAL_UI_TEXT.profileList.intro);
      expect(await page.getByTestId('profile-list-empty').textContent()).toBe(LOCAL_UI_TEXT.profileList.empty);
      expect(await primaryButtonLabelsInMain(page)).toEqual([LOCAL_UI_TEXT.profileList.newProfile]);
      expect(await page.getByTestId('profile-list').count()).toBe(0);
      expect(await axeViolationsOf(page)).toEqual([]);
    });

    it('create: the visible inputs are the start address, the usage and the save button only (no isolation choice, no folded settings)', async () => {
      const page = await openPage('/profiles/new');
      const form = page.getByRole('main').locator('form');
      await form.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await form.locator('input:visible:not([type="radio"]), select:visible, textarea:visible').evaluateAll((items) => items.map((item) => item.getAttribute('name'))))
        .toEqual(['startUrl']);
      expect(await form.locator('input[type="radio"]:visible').evaluateAll((items) => [...new Set(items.map((item) => item.getAttribute('name')))]))
        .toEqual(['usage']);
      expect(await form.locator('button:visible').allTextContents()).toEqual([LOCAL_UI_TEXT.profileForm.saveAndCheckEntry]);
      expect(await form.locator('details').count()).toBe(0);
      expect(await page.getByTestId('profile-isolation').count()).toBe(0);
      await expectAtMostOnePrimaryButton(page);
      expect(await axeViolationsOf(page)).toEqual([]);
      // OP-1 修正の 2 回目（OP 設計書 4.1.3 の 3。設計者の判断「公開のサイトも点検を始める 1 つ」。前は「保存する」）: ログインしなくても見られるサイトを選んでも、
      // ボタンは「点検を始める」1 つで、主のボタン。
      await chooseProfileUsage(page, 'PUBLIC', UI_TIMEOUT_MS);
      await expect.poll(() => page.getByTestId('profile-save-entry-check-note').textContent(), { timeout: UI_TIMEOUT_MS })
        .toBe(LOCAL_UI_TEXT.profileForm.saveAndCheckEntryNotePublic);
      expect(await form.locator('button:visible').allTextContents()).toEqual([LOCAL_UI_TEXT.profileForm.saveAndCheckEntry]);
      await expectAtMostOnePrimaryButton(page);
      expect(await primaryButtonLabelsInMain(page)).toEqual([LOCAL_UI_TEXT.profileForm.saveAndCheckEntry]);
      expect(await axeViolationsOf(page)).toEqual([]);
    });
  });
});

describe('stage-chain-ui: FM2d: the chained run on the start screen', () => {
  const UI_TIMEOUT_MS = 15_000;
  const SCENARIO_TIMEOUT_MS = 120_000;
  const MAX_TAB_PRESSES = 80;
  const PUBLIC_PROFILE = 'fm2d-public';
  const AUTH_PROFILE = 'fm2d-auth';
  const WRITE_PROFILE = 'fm2d-write';
  /** FM2R の I-1: 認証の設定を保存した、始められるプロファイル（READ の定義 0 件と 1 件）。 */
  const READY_PROFILE = 'fm2d-ready';
  const ORIGIN = 'http://127.0.0.1:9';
  const STATUS = Object.freeze({ BAD_REQUEST: 400 });

  /** サーバの準備と Server Function の呼び出し（`helpers/ui-server.ts`）。 */
  const { started, rootOf, contextOf, call, valueOf, setUp, tearDown } = sharedUiServerKitOf(serverKit);

  const { openPage, expectCleanAndClosePages } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
    maxTabPresses: MAX_TAB_PRESSES,
    screenshotDirectory: process.env['FM2D_SCREENSHOT_DIR'],
  });

  const testProfile = (profileId: string, targetConfigPath: string, mode: 'TEST_AUTH_PASSIVE' | 'TEST_APPROVED_WRITE'): Record<string, unknown> => ({
    ...publicProfileDocument(profileId, targetConfigPath),
    environment: 'TEST',
    mode,
    auth: 'MANUAL_SESSION',
    approvedTestOrigins: [ORIGIN],
    environmentEvidenceRef: 'fm2d-evidence',
  });

  beforeAll(async () => {
    const config = await setUp((root) => writeAuditTargetConfig(root.root, PUBLIC_PROFILE, ORIGIN, { minNavigationIntervalMs: 0, screenshots: false }));
    for (const document of [
      publicProfileDocument(PUBLIC_PROFILE, config),
      testProfile(AUTH_PROFILE, config, 'TEST_AUTH_PASSIVE'),
      testProfile(WRITE_PROFILE, config, 'TEST_APPROVED_WRITE'),
      testProfile(READY_PROFILE, config, 'TEST_AUTH_PASSIVE'),
    ]) {
      expect(await valueOf('createProfileFn', 'POST', { profile: document })).toMatchObject({ ok: true });
    }
    expect(await saveAuthSetupRequestInStore(rootOf(), { setup: authSetupOf(READY_PROFILE) })).toMatchObject({ ok: true });
  }, SCENARIO_TIMEOUT_MS);

  /** FM2R の I-1: 始められるプロファイルの認証の設定（手動のログイン。値は匿名）。 */
  function authSetupOf(profileId: string): Record<string, unknown> {
    return {
      ...FORM_NAVIGATION_SETUP_ITEMS,
      profileId,
      profileRevision: 1,
      loginStartUrl: `${ORIGIN}/login`,
      loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
      successCondition: { pathPrefix: '/admin', selector: null },
      sessionLostCondition: { pathPrefix: null },
      excludedPaths: ['/admin/logout'],
      auditPathPrefixes: ['/admin'],
      maxLoginAttempts: 1,
      allowedIdpOrigins: [],
      automatedLogin: null,
    };
  }

  /** テストだけの操作: 画面の path の READ の確かめの定義を 1 つ、管理データに書く（候補の要らない形）。 */
  function writeReadCheckDefinition(profileId: string): void {
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      expect(createReadCheck(database, {
        readCheckId: 'fm2d-read-1', profileId, at: '20261023000000',
        definition: { targetPagePath: '/admin/search', parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
      }).ok).toBe(true);
    } finally {
      closeControlDatabase(database);
    }
  }

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  afterAll(async () => {
    await tearDown();
  });

  const label = (kind: keyof typeof AUDIT_JOB_KIND_CATALOG): string => AUDIT_JOB_KIND_CATALOG[kind].label;

  /** 開始の画面の主のボタン（要点のパネルの「点検を始める」。始めるものは `data-kind`）。 */
  const submitOf = (page: Page) => page.getByTestId('start-summary').getByTestId('start-submit');

  // PL-3（判断 3、3 章の 1）: 主のボタンは「点検を始める」1 つで、まとめて実行を始める。ステップの並びは詳しい内容。始められない理由は要点に 1 回だけ。
  it('shows one start of the chain for the test modes (and the audit only for the public audit), with the reason why it cannot start yet', async () => {
    const auth = await openPage(`/start/${AUTH_PROFILE}`);
    const summary = auth.getByTestId('start-summary');
    await summary.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await summary.getAttribute('data-start-kind')).toBe('STAGE_CHAIN');
    expect(await auth.getByTestId('start-what-happens').textContent()).toBe(LOCAL_UI_AUDIT_TEXT.start.whatHappens.STAGE_CHAIN);
    // ステップの並びは、たたんだ詳しい内容の中（1 つだけ）。
    expect(await auth.locator('main details').count()).toBe(1);
    expect(await auth.getByTestId('start-advanced-settings').locator('summary').textContent()).toBe(LOCAL_UI_TEXT.advancedSettings.summary);
    expect(await auth.getByTestId('start-advanced-settings').getByTestId('start-stage-chain-stages').locator('li').allTextContents())
      .toEqual([label('AUDIT'), label('DISCOVERY'), label('READ_CHECK')]);
    // 認証の設定がないので、始められない理由を要点に 1 回だけ出し、主のボタンを出さない（前の 2 つ目の欄「まとめて実行する」はない）。
    expect(await submitOf(auth).count()).toBe(0);
    expect(await auth.getByTestId('start-reason').count()).toBe(1);
    expect(await summary.getByTestId('start-reason').getAttribute('data-reason')).toBe('AUTH_SETUP_MISSING');
    expect(await auth.getByText(AUDIT_JOB_START_REJECTION_DESCRIPTIONS.AUTH_SETUP_MISSING.description).count()).toBe(1);
    expect(await auth.getByTestId('start-open-auth-setup').count()).toBe(1);
    expect(await auth.getByTestId('start-stage-chain').count()).toBe(0);
    expect(await auth.getByTestId('start-stage-chain-reason').count()).toBe(0);
    // 直す道のリンクは二次の見た目（主のボタンは出さない）。
    expect(await primaryButtonLabelsInMain(auth)).toEqual([]);
    expect(await axeViolationsOf(auth)).toEqual([]);

    // MI-5: 書き込みのモードも、監査から始める連鎖。
    const write = await openPage(`/start/${WRITE_PROFILE}`);
    await write.getByTestId('start-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await write.getByTestId('start-summary').getAttribute('data-start-kind')).toBe('STAGE_CHAIN');
    expect(await write.getByTestId('start-stage-chain-stages').locator('li').allTextContents())
      .toEqual([label('AUDIT'), label('DISCOVERY'), label('READ_CHECK')]);
    expect(await write.getByTestId('start-reason').count()).toBe(1);
    expect(await write.getByTestId('start-reason').getAttribute('data-reason')).toBe('AUTH_SETUP_MISSING');
    expect(await write.getByTestId('start-open-auth-setup').count()).toBe(1);
    expect(await axeViolationsOf(write)).toEqual([]);

    // 公開の画面だけのサイトは、まとめて実行の段がないので点検だけ（ステップの並びも出さない）。
    const publicPage = await openPage(`/start/${PUBLIC_PROFILE}`);
    await publicPage.getByTestId('start-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await publicPage.getByTestId('start-summary').getAttribute('data-start-kind')).toBe('AUDIT_ONLY');
    expect(await publicPage.getByTestId('start-what-happens').textContent()).toBe(LOCAL_UI_AUDIT_TEXT.start.whatHappens.AUDIT_ONLY);
    expect(await publicPage.getByTestId('start-stage-chain-stages').count()).toBe(0);
    expect(await submitOf(publicPage).getAttribute('data-kind')).toBe('AUDIT_ONLY');
    expect(await primaryButtonLabelsInMain(publicPage)).toEqual([LOCAL_UI_AUDIT_TEXT.start.submit]);
    // まだ点検していないので、始め方（続きから・新しく）の選択を出さない（4 章の 4）。
    expect(await publicPage.locator('input[name="start-mode"]').count()).toBe(0);
    expect(await axeViolationsOf(publicPage)).toEqual([]);
  }, SCENARIO_TIMEOUT_MS);

  it('returns the chain of the start summary, and rejects the start without making a job', async () => {
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: AUTH_PROFILE })).toMatchObject({
      chain: { stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'], blocker: 'AUTH_SETUP_MISSING' },
    });
    // MI-5: 書き込みのモードも、監査 → 発見 → READ の確かめ。
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: WRITE_PROFILE })).toMatchObject({
      chain: { stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'], blocker: 'AUTH_SETUP_MISSING' },
    });
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: PUBLIC_PROFILE })).toMatchObject({ chain: null, primaryStart: { kind: 'AUDIT_ONLY', blocker: null } });

    expect(await valueOf('startStageChainFn', 'POST', { profileId: PUBLIC_PROFILE, expectedRevision: 1, startNew: false }))
      .toMatchObject({ ok: false, reason: 'MODE_NOT_EXECUTABLE' });
    expect(await valueOf('startStageChainFn', 'POST', { profileId: AUTH_PROFILE, expectedRevision: 1, startNew: true }))
      .toMatchObject({ ok: false, reason: 'AUTH_SETUP_MISSING' });
    expect((await call('startStageChainFn', 'POST', { profileId: AUTH_PROFILE, expectedRevision: 1 })).response.status).toBe(STATUS.BAD_REQUEST);
    // 束: この describe は、ジョブを作るどの describe よりも前に流す（ジョブの一覧が空であることを確かめるため）。
    expect(await valueOf('listAuditJobsFn', 'GET')).toEqual([]);
  }, SCENARIO_TIMEOUT_MS);

  // FM2R の I-1: READ の段の定義の件数は、まとめて実行の開始の確かめに入れない（0 件は「行わなかった」で、止める理由にしない）。開始のボタンは押さない
  // （押すと、本物のログインの段が始まる）。
  it('can start the chain of a ready profile with no READ definition and with one', async () => {
    for (const definitions of [0, 1]) {
      if (definitions === 1) {
        writeReadCheckDefinition(READY_PROFILE);
      }
      expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: READY_PROFILE }), `${definitions} definitions`).toMatchObject({
        blocker: null,
        chain: { stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'], blocker: null },
        primaryStart: { kind: 'STAGE_CHAIN', blocker: null },
      });
      const page = await openPage(`/start/${READY_PROFILE}`);
      const submit = submitOf(page);
      await submit.waitFor({ timeout: UI_TIMEOUT_MS });
      // PL-3（判断 3）: 主のボタン「点検を始める」1 つが、まとめて実行を始める。
      expect(await submit.isEnabled(), `${definitions} definitions`).toBe(true);
      expect(await submit.getAttribute('data-kind'), `${definitions} definitions`).toBe('STAGE_CHAIN');
      expect(await page.getByText(LOCAL_UI_AUDIT_TEXT.start.cannotStartHeading).count()).toBe(0);
      expect(await primaryButtonLabelsInMain(page)).toEqual([LOCAL_UI_AUDIT_TEXT.start.submit]);
      await expectAtMostOnePrimaryButton(page);
      expect(await axeViolationsOf(page)).toEqual([]);
    }
  }, SCENARIO_TIMEOUT_MS);
});

describe('ui-flows: local UI: profiles', () => {
  /** 画面の操作を待つ上限（ミリ秒）。 */
  const UI_TIMEOUT_MS = 15_000;
  /** OP-1 修正の 2 回目: 作成の画面が始めた下調べが終わり、サイトの画面へ移るまでを待つ上限（ミリ秒。`start-url-onboarding-ui.test.ts` と同じ）。 */
  const JOB_TIMEOUT_MS = 60_000;
  /** フォーカスを Tab で動かす回数の上限。 */
  const MAX_TAB_PRESSES = 40;
  /**
   * テストの値（匿名）。PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 6 章の 1）: 作成の画面に名前の欄はなく、名前は開始のアドレスから決まる。一時の root の
   * 設定のファイルの開始のアドレスを入れると、そのファイルを使い、名前はホスト名からの案になる。OP-1 修正の 2 回目（OP 設計書 4.1.3 の 3。設計者の判断「公開のサイトも
   * 点検を始める 1 つ」）: 作成の画面の「点検を始める」で、下調べが実際に開始のページを読みに行くので、どこにも接続しない予約の名前の設定のファイルを、一時の root の
   * `config/targets/` に置いて使う（前は `config/targets/example.json` の `https://example.com/` だった）。
   */
  const START_URL = 'https://ui-flows.example.test/';
  const PROFILE_ID = 'ui-flows-example-test';
  const EXAMPLE_TARGET_CONFIG = 'config/targets/ui-flows.json';

  const { started, rootOf, contextOf, setUp } = sharedUiServerKitOf(serverKit);

  /** 管理データのプロファイルの改訂（PL-1: サイトの画面に改訂を出さなくなったので、管理データから読む）。 */
  const revisionOf = (): number | undefined => readProfileInStore(rootOf(), PROFILE_ID)?.profile.revision;

  const text = LOCAL_UI_TEXT;

  /** 記録つきのページ（CSP の違反、console の誤り、外部への要求。CCX-16 の共通の補助）と、Tab だけのフォーカスの移動。 */
  const { records, openPage, tabTo, expectCleanAndClosePages } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
    maxTabPresses: MAX_TAB_PRESSES,
    requireCspRecord: true,
  });

  beforeAll(async () => {
    await setUp((root) => {
      writeFileSync(`${root.root}/${EXAMPLE_TARGET_CONFIG}`, `${JSON.stringify({ target: { id: 'ui-flows' }, site: { startUrl: START_URL, allowedOrigins: [new URL(START_URL).origin] } })}
`, 'utf8');
    });
  });

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  // 束: 「shows the empty list and the menu」は束の最初の describe へ移した（空の一覧を確かめるため）。

  it('registers a profile with the keyboard only, after a client-side error, and lists it', async () => {
    const page = await openPage('/');
    // T43a: 左のメニューにも同じ名前のリンクがあるので、本文（一覧の上の帯）のリンクを選ぶ。
    await tabTo(page, page.getByRole('main').getByRole('link', { name: text.profileList.newProfile }));
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/profiles\/new$/u);
    await page.getByLabel(text.profileForm.startUrl, { exact: true }).waitFor();

    // MI-1（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.2）: 使い方は「公開の画面だけ」にする（キーボードだけ: 使い方の radio で下の
    // 矢印を押す。既定は「ログインして読む」）。PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 6 章の 1）: 作成の画面の見える入力は、開始のアドレス・
    // 使い方・保存の 3 つだけ（名前と選び方の欄は消した。前はたたんだ詳しい設定で名前の形の誤りを確かめていたので、開始のアドレスの形の誤りで確かめる）。
    await tabTo(page, page.getByLabel(text.profileForm.usageTestAuth, { exact: true }));
    await page.keyboard.press('ArrowDown');
    expect(await page.getByLabel(text.profileForm.usagePublic, { exact: true }).isChecked()).toBe(true);

    // 開始のアドレスの形の誤り（画面の側の補助の確かめ）。
    await tabTo(page, page.getByLabel(text.profileForm.startUrl, { exact: true }));
    await page.keyboard.type('not a url');
    // OP-1 修正の 2 回目（前は「保存する」）: ログインしなくても見られるサイトも、作成の画面のボタンは「点検を始める」1 つ。
    await tabTo(page, page.getByRole('button', { name: text.profileForm.saveAndCheckEntry }));
    await page.keyboard.press('Enter');
    await page.getByText(TARGET_SITE_PROBLEM_DESCRIPTIONS.START_URL_INVALID).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByLabel(text.profileForm.startUrl, { exact: true }).getAttribute('aria-invalid')).toBe('true');

    // 一時の root の設定のファイルの開始のアドレスを入れると、そのファイルを使い、名前は開始のアドレスから決まる。
    await tabTo(page, page.getByLabel(text.profileForm.startUrl, { exact: true }));
    await page.keyboard.press('Control+A');
    await page.keyboard.type(START_URL);
    await tabTo(page, page.getByRole('button', { name: text.profileForm.saveAndCheckEntry }));
    await page.keyboard.press('Enter');
    // OP-1 修正の 2 回目（前は、保存だけでサイトの画面へ移り、保存の知らせを出した）: 保存に続けて下調べの作業の画面へ移る。下調べは開始のページを開けない（予約の
    // 名前）ので、ジョブの管理は点検を始めず、作業の画面がサイトの画面へ移す。
    await page.waitForURL(/\/jobs\/[^/]+$/u, { timeout: UI_TIMEOUT_MS });
    const entryJobId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    await page.waitForURL(new RegExp(`/profiles/${PROFILE_ID}\?`, 'u'), { timeout: JOB_TIMEOUT_MS });
    expect(readProfileInStore(rootOf(), PROFILE_ID)?.profile).toMatchObject({ revision: 1, targetConfigPath: EXAMPLE_TARGET_CONFIG });

    const list = await openPage('/');
    const row = list.locator(`tr[data-profile-id="${PROFILE_ID}"]`);
    await row.waitFor();
    expect(await row.textContent()).toContain(AUDIT_MODE_CATALOG.PUBLIC_PASSIVE.label);
    // T24f: 「前回の点検」の欄は、最後の作業を示す（OP-1 修正の 2 回目: 前は、まだジョブがないこと。今は、作成の画面の押下で始めた下調べの作業。その作業の状態と、
    // その作業へのリンク）。PL-1（設計書 3 章、4 章の 1）: 行のボタンは「続ける」1 つ（行き先はサイトの画面。点検を始めるは、サイトの画面の主のボタンの 1 か所）。
    // 状態の列は出さない（取り消した行は段の文で分かる）。
    expect(await row.getByTestId('last-run').textContent()).not.toContain(LOCAL_UI_AUDIT_TEXT.profileList.lastRunNone);
    expect(await row.getByTestId('last-run-state').textContent()).toBe(auditJobStateDisplay('FINISHED').label);
    expect(await row.getByTestId('last-run').getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.lastRunDetail }).getAttribute('href'))
      .toBe(`/jobs/${entryJobId}`);
    expect(await row.getByTestId('profile-row-next').getAttribute('data-stage')).toBe('AUDIT_PUBLIC');
    expect(await row.getByRole('link', { name: LOCAL_UI_NEXT_STEP_TEXT.continue }).count()).toBe(1);
    expect(await row.getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit }).count()).toBe(0);
  });

  // T25e（T25d の申し送り 1）: 認証つきの読み取りの監査（`TEST_AUTH_PASSIVE`）は、認証の設定があれば開始できるモードになった。選ぶと、認証の
  // 設定を作ってから始める案内を出す（今は実行できないという案内は出さない）。MI-5（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.5）:
  // 承認した書き込みのモードも監査を始められるようになったので、今は実行できないという案内は、どのモードでも出さない（前は書き込みのモードで出した）。
  it('shows the Task 22 error on the field, and the auth setup notice for TEST_AUTH_PASSIVE and TEST_APPROVED_WRITE without the not-yet-executable notice', async () => {
    const page = await openPage(`/profiles/${PROFILE_ID}`);
    // MI-1: 編集の欄は、プロファイルの詳細のたたんだ「詳しい設定」の中にある。
    await openProfileAdvancedSettings(page, UI_TIMEOUT_MS);
    await page.getByLabel(text.profileForm.mode).selectOption('TEST_APPROVED_WRITE');
    // T28b（Task 28 の設計書 4.5）: 書き込みのモードも、発見と READ の確かめのために認証の設定を使うので、認証の設定の案内も出す。MI-1 の D: 「今は
    // 実行できない」の案内は、文言ごとカタログから消した（`auth-display.test.ts`）。
    await page.getByTestId('profile-auth-setup-notice').waitFor();
    expect(await page.getByTestId('profile-auth-setup-notice').textContent()).toBe(LOCAL_UI_AUTH_TEXT.profileFormNotice);
    await page.getByLabel(text.profileForm.mode).selectOption('TEST_AUTH_PASSIVE');
    await page.getByTestId('profile-auth-setup-notice').waitFor();
    expect(await page.getByTestId('profile-auth-setup-notice').textContent()).toBe(LOCAL_UI_AUTH_TEXT.profileFormNotice);
    // NL-3（NL-1 の申し送り）: 注意書きは認証の方式も購読する。ログインしない方式にすると消え、ログインを使う方式に戻すと出る（モードは変えない）。
    await page.getByLabel(text.profileForm.auth, { exact: true }).selectOption('NONE');
    await page.getByTestId('profile-auth-setup-notice').waitFor({ state: 'detached', timeout: UI_TIMEOUT_MS });
    await page.getByLabel(text.profileForm.auth, { exact: true }).selectOption('MANUAL_SESSION');
    await page.getByTestId('profile-auth-setup-notice').waitFor({ timeout: UI_TIMEOUT_MS });
    // T43a fix round 1（Task 43 の設計書 4.1）: モードを選ぶと、環境は組み合わせの表の初めの値（テスト環境）に合う。利用者が公開の環境に戻して
    // 保存すると、保存の検証（Task 22）が組み合わせの誤りで止める（意図した手順の変更。期待は変えない）。
    // 「環境」は「テスト環境の Origin」などにも部分一致するので、ラベルは完全一致で選ぶ。
    expect(await page.getByLabel(text.profileForm.environment, { exact: true }).inputValue()).toBe('TEST');
    await page.getByLabel(text.profileForm.environment, { exact: true }).selectOption('PUBLIC');
    await page.getByRole('button', { name: text.profileForm.save }).click();
    await page.getByText(PROFILE_STORE_REJECTION_DESCRIPTIONS.PROFILE_INVALID.description).waitFor({ timeout: UI_TIMEOUT_MS });
    await page.getByText(PROFILE_VALIDATION_ERROR_DESCRIPTIONS.PROFILE_MODE_ENVIRONMENT_MISMATCH).waitFor();
    expect(await page.getByLabel(text.profileForm.mode).getAttribute('aria-invalid')).toBe('true');
    expect(revisionOf()).toBe(1);
  });

  it('updates the profile, and explains a revision conflict with a reload', async () => {
    const first = await openPage(`/profiles/${PROFILE_ID}`);
    const second = await openPage(`/profiles/${PROFILE_ID}`);
    await openProfileAdvancedSettings(first, UI_TIMEOUT_MS);
    await openProfileAdvancedSettings(second, UI_TIMEOUT_MS);
    await first.getByRole('button', { name: text.profileForm.save }).click();
    await first.getByText(text.profileForm.updated).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(revisionOf()).toBe(2);

    await second.getByRole('button', { name: text.profileForm.save }).click();
    await second.getByText(PROFILE_STORE_REJECTION_DESCRIPTIONS.PROFILE_REVISION_CONFLICT.description).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(revisionOf()).toBe(2);
    // PL-1: 改訂は画面に出さないので、読み込み直した後は、今の改訂の内容で保存し直せることで確かめる（拒否の知らせが消え、保存すると次の改訂になる）。
    await second.getByRole('button', { name: text.reload }).click();
    await second.getByText(PROFILE_STORE_REJECTION_DESCRIPTIONS.PROFILE_REVISION_CONFLICT.description).waitFor({ state: 'detached', timeout: UI_TIMEOUT_MS });
    await openProfileAdvancedSettings(second, UI_TIMEOUT_MS);
    await second.getByRole('button', { name: text.profileForm.save }).click();
    await second.getByText(text.profileForm.updated).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(revisionOf()).toBe(3);
  });

  // DEF-137（DEF-128 と同じ揺らぎ）: 保存の知らせは、画面の改訂が保存した改訂（search の `savedRevision`）に届いたときだけ出す（古い値のまま「更新しました」を
  // 出さない）。改訂がまだ届いていない URL では知らせを出さず、届いた URL では出す。
  it('shows the saved notice only when the revision on the screen reached the saved revision', async () => {
    const ahead = await openPage(`/profiles/${PROFILE_ID}?saved=updated&savedRevision=1000`);
    await ahead.getByTestId('profile-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await ahead.getByText(text.profileForm.updated).count()).toBe(0);
    const reached = await openPage(`/profiles/${PROFILE_ID}?saved=updated&savedRevision=1`);
    await reached.getByText(text.profileForm.updated).waitFor({ timeout: UI_TIMEOUT_MS });
  });

  it('retires the profile with the keyboard only through the confirmation dialog (focus is trapped and returned)', async () => {
    const page = await openPage(`/profiles/${PROFILE_ID}`);
    // PL-1（設計書 3 章の 1）: 取り消しは、サイトの画面の詳しい内容の中（キーボードだけ: 見出しで Enter を押して開く）。
    await tabTo(page, page.getByTestId('profile-edit-advanced-settings').locator('summary'));
    await page.keyboard.press('Enter');
    const opener = page.getByRole('button', { name: text.retireDialog.open });
    await tabTo(page, opener);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: text.retireDialog.title });
    await dialog.waitFor();
    expect(await dialog.textContent()).toContain(text.retireDialog.body);
    // 開いたときは「やめる」にフォーカス。Escape で閉じると、開いたボタンにフォーカスが戻る。
    expect(await dialog.getByRole('button', { name: text.retireDialog.cancel }).evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    expect(await opener.evaluate((element) => element === document.activeElement)).toBe(true);

    await page.keyboard.press('Enter');
    await dialog.waitFor();
    // フォーカスはダイアログの中に閉じ込められる（Tab を何回押しても外に出ない）。
    for (let count = 0; count < 4; count += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    await tabTo(page, dialog.getByRole('button', { name: text.retireDialog.confirm }));
    await page.keyboard.press('Enter');
    await page.getByText(text.retireDialog.done).waitFor({ timeout: UI_TIMEOUT_MS });
    await page.locator('[data-testid="profile-summary"][data-stage="SITE_RETIRED"]').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(readProfileInStore(rootOf(), PROFILE_ID)).toMatchObject({ status: 'RETIRED', profile: { revision: 4 } });
    await page.getByText(text.profileForm.retiredNotice).waitFor();
    expect(await page.getByRole('button', { name: text.profileForm.save }).count()).toBe(0);
  });

  // 束: 「keeps the profiles after the server restarts」は束の最後の describe へ移した（共有のサーバを止めて起動し直すため）。

  it('shows the environment status', async () => {
    const page = await openPage('/environment');
    const status = await page.getByTestId('environment-status').textContent();
    expect(status).toContain('local-data/beaksight-control.sqlite');
    expect(status).toContain(text.environmentStatus.listeningValue);
    expect(status).toContain(text.environmentStatus.quickCheckOk);
  });

  it('shows the not-found page inside the shell (the document itself answers 404)', async () => {
    const page = await openPage('/does-not-exist');
    expect(await page.locator('h1').textContent()).toBe(text.notFound.title);
    expect(await page.getByRole('navigation', { name: text.navigationLabel }).count()).toBe(1);
    // 文書そのものの 404 は、ブラウザが console に出す（画面の誤りではない）。それ以外の誤りはないこと。
    const record = records.at(-1);
    const notFoundMessages = record?.consoleErrors.filter((message) => /status of 404/u.test(message)) ?? [];
    expect(notFoundMessages).toHaveLength(1);
    record?.consoleErrors.splice(0, record.consoleErrors.length, ...record.consoleErrors.filter((message) => !/status of 404/u.test(message)));
  });
});

describe('onboarding-ui-flows: T43a: from creating a profile to starting the audit, inside the screens', () => {
  /** 画面の操作を待つ上限（ミリ秒）。 */
  const UI_TIMEOUT_MS = 15_000;
  /** フォーカスを Tab で動かす回数の上限。 */
  const MAX_TAB_PRESSES = 60;
  const FIRST_REVISION = 1;

  /**
   * OP-1 修正の 2 回目（OP 設計書 4.1.3 の 3。設計者の判断「公開のサイトも点検を始める 1 つ」）: 作成の画面の「点検を始める」で、下調べが開始のページを実際に読みに行く
   * ので、作成の画面で使う設定のファイルは、どこにも接続しない予約の名前にして、一時の root の `config/targets/` に置く（前は `config/targets/example.json` の
   * `https://example.com/`）。
   */
  const PUBLIC_START_URL = 'https://onboarding.example.test/';
  const PUBLIC_PROFILE = 'onboarding-example-test';
  const PUBLIC_TARGET_CONFIG = 'config/targets/onboarding.json';
  /** OP-1 修正の 2 回目: 作成の画面が始めた下調べが終わり、サイトの画面へ移るまでを待つ上限（ms。`start-url-onboarding-ui.test.ts` と同じ）。 */
  const ENTRY_CHECK_TIMEOUT_MS = 60_000;
  const MANUAL_PROFILE = 't43a-manual';
  const AUTOMATED_PROFILE = 't43a-automated';
  const WRITE_PROFILE = 't43a-write';
  const RETIRED_PROFILE = 't43a-retired';
  /** T43a fix round 1: 公開のモードで、環境がテスト環境のプロファイル（確かめた記録の参照を持てる）。 */
  const PUBLIC_TEST_PROFILE = 't43a-public-test';
  const PUBLIC_TEST_EVIDENCE = 't43a-public-test-evidence';
  const TEST_ORIGIN = 'http://127.0.0.1:9';
  const ADMIN_PATH = '/admin/';
  const LOGIN_PATH = '/login';
  const LOGOUT_PATH = '/admin/logout';

  const text = LOCAL_UI_TEXT;
  const nextText = LOCAL_UI_NEXT_STEP_TEXT;

  const { started, rootOf, contextOf, valueOf, setUp } = sharedUiServerKitOf(serverKit);

  /** 記録つきのページ（CSP の違反、console の誤り、外部への要求。CCX-16 の共通の補助）と、Tab だけのフォーカスの移動。 */
  const { openPage, tabTo, expectCleanAndClosePages } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
    maxTabPresses: MAX_TAB_PRESSES,
    requireCspRecord: true,
  });

  /** 認証のプロファイルの文書（テスト環境。ターゲット設定は一時の root に書く）。 */
  const testProfileDocument = (
    profileId: string,
    mode: 'TEST_AUTH_PASSIVE' | 'TEST_APPROVED_WRITE',
    auth: 'MANUAL_SESSION' | 'AUTOMATED_LOGIN',
  ): Record<string, unknown> => ({
    schemaVersion: 'beaksight-profile/1',
    profileId,
    revision: FIRST_REVISION,
    targetConfigPath: writeAuthTargetConfig(rootOf().root, profileId, TEST_ORIGIN, ADMIN_PATH, 1),
    environment: 'TEST',
    mode,
    auth,
    approvedTestOrigins: [TEST_ORIGIN],
    environmentEvidenceRef: 't43a-evidence',
  });

  /** 手動のログインの認証の設定（フォームの送信）。 */
  const manualSetupOf = (profileId: string): Record<string, unknown> => ({
    ...FORM_NAVIGATION_SETUP_ITEMS,
    profileId,
    profileRevision: FIRST_REVISION,
    loginStartUrl: `${TEST_ORIGIN}${LOGIN_PATH}`,
    loginPostEndpoints: [{ origin: TEST_ORIGIN, path: LOGIN_PATH }],
    successCondition: { pathPrefix: ADMIN_PATH, selector: '#admin-ok' },
    sessionLostCondition: { pathPrefix: null },
    excludedPaths: [LOGOUT_PATH],
    auditPathPrefixes: [ADMIN_PATH],
    maxLoginAttempts: 1,
    allowedIdpOrigins: [],
    automatedLogin: null,
  });

  /** サイトの画面の段（共用の補助 `profileStageOf`）。 */
  const stageOf = (page: Page): Promise<string | null> => profileStageOf(page, UI_TIMEOUT_MS);

  /** サイトの画面の要点のパネルのボタンの行き先（共用の補助 `profileSummaryActionsOf`）。 */
  const summaryActionsOf = (page: Page): Promise<readonly (string | null)[]> => profileSummaryActionsOf(page, UI_TIMEOUT_MS);

  /** 本文の中の、ログインの確かめの画面へのリンクの数（判断 1: ふだんの流れからは行かない）。 */
  const loginCheckLinksOf = (page: Page): Promise<number> => page.locator('main a[href*="/login-check/"]').count();

  /** 本文の中の、「次から自動でログインする」の入口の数（要点のパネルと詳しい内容）。 */
  const automatedLoginOffersOf = (page: Page): Promise<number> => page.locator('main [data-action="AUTOMATED_LOGIN_SETUP"]').count();

  beforeAll(async () => {
    await setUp((root) => {
      writeFileSync(`${root.root}/${PUBLIC_TARGET_CONFIG}`, `${JSON.stringify({ target: { id: 'onboarding' }, site: { startUrl: PUBLIC_START_URL, allowedOrigins: [new URL(PUBLIC_START_URL).origin] } })}
`, 'utf8');
    });
    expect(await valueOf('createProfileFn', 'POST', { profile: testProfileDocument(MANUAL_PROFILE, 'TEST_AUTH_PASSIVE', 'MANUAL_SESSION') }))
      .toMatchObject({ ok: true });
    // MI-F1（設計書 4.7.1 の 2）: 自動ログインのプロファイルは、画面の作成の口では作れない（切り替えだけで入る）。テストの準備は、保存の部品で直接作る。
    expect(await createProfileInStore(rootOf().root, testProfileDocument(AUTOMATED_PROFILE, 'TEST_AUTH_PASSIVE', 'AUTOMATED_LOGIN')))
      .toMatchObject({ ok: true });
    expect(await valueOf('createProfileFn', 'POST', { profile: testProfileDocument(WRITE_PROFILE, 'TEST_APPROVED_WRITE', 'MANUAL_SESSION') }))
      .toMatchObject({ ok: true });
    expect(await valueOf('createProfileFn', 'POST', {
      profile: {
        schemaVersion: 'beaksight-profile/1',
        profileId: RETIRED_PROFILE,
        revision: FIRST_REVISION,
        targetConfigPath: EXAMPLE_TARGET_CONFIG,
        environment: 'PUBLIC',
        mode: 'PUBLIC_PASSIVE',
        auth: 'NONE',
        approvedTestOrigins: [],
        environmentEvidenceRef: null,
      },
    })).toMatchObject({ ok: true });
    expect(await valueOf('retireProfileFn', 'POST', { profileId: RETIRED_PROFILE, expectedRevision: FIRST_REVISION })).toMatchObject({ ok: true });
    expect(await valueOf('createProfileFn', 'POST', {
      profile: {
        schemaVersion: 'beaksight-profile/1',
        profileId: PUBLIC_TEST_PROFILE,
        revision: FIRST_REVISION,
        targetConfigPath: EXAMPLE_TARGET_CONFIG,
        environment: 'TEST',
        mode: 'PUBLIC_PASSIVE',
        auth: 'NONE',
        approvedTestOrigins: [],
        environmentEvidenceRef: PUBLIC_TEST_EVIDENCE,
      },
    })).toMatchObject({ ok: true });
  });

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  it('has "add a site" in the left menu, and marks it as the current page on the form', async () => {
    const page = await openPage('/');
    const navigation = page.getByRole('navigation', { name: text.navigationLabel });
    // PL-V（設計書 `2026-10-26-beaksight-plain-ui-design.md` 13 章の 14）: メニューは 3 つ。環境の状態は、問題があるときだけ出す（意図した期待の変更）。
    expect(await navigation.getByRole('link').allTextContents())
      .toEqual([text.pages.profiles, text.pages.newProfile, LOCAL_UI_AUDIT_TEXT.pages.jobs]);
    await tabTo(page, navigation.getByRole('link', { name: text.pages.newProfile }));
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/profiles\/new$/u, { timeout: UI_TIMEOUT_MS });
    // MI-1: 作成の画面の最初の欄は開始の URL。
    await page.getByLabel(text.profileForm.startUrl, { exact: true }).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await navigation.getByRole('link', { name: text.pages.newProfile }).getAttribute('aria-current')).toBe('page');
    expect(await navigation.getByRole('link', { name: text.pages.profiles }).getAttribute('aria-current')).toBeNull();
  });

  it('creates a public profile with the three inputs only, without the test environment values, then reaches the start screen by links only', async () => {
    const page = await openPage('/');
    await page.getByRole('navigation', { name: text.navigationLabel }).getByRole('link', { name: text.pages.newProfile }).click();
    await page.waitForURL(/\/profiles\/new$/u, { timeout: UI_TIMEOUT_MS });
    await page.getByLabel(text.profileForm.startUrl, { exact: true }).waitFor({ timeout: UI_TIMEOUT_MS });
    // PL-1（設計書 6 章の 1）: どちらの使い方でも、テスト環境の Origin・隔離の扱い・確かめた記録の参照・承認したサービスの Origin の欄は出さない。
    const testFields = page.locator('[data-testid="profile-isolation"], textarea, [data-testid="profile-service-origins"]');
    expect(await testFields.count()).toBe(0);
    expect(await page.getByLabel(text.profileForm.environmentEvidenceRef).count()).toBe(0);

    // 保存する（公開の画面だけのプロファイルは、テスト環境の値を持たない）。名前は開始のアドレスから決まる。
    await createProfileOnScreen(page, { startUrl: PUBLIC_START_URL, usage: 'PUBLIC' }, UI_TIMEOUT_MS);
    // OP-1 修正の 2 回目（前は、保存だけでサイトの画面へ移り、保存の知らせを出した）: 保存に続けて下調べの作業の画面へ移る。下調べは開始のページを開けない（予約の
    // 名前）ので、ジョブの管理は点検を始めず、作業の画面がサイトの画面へ移す。
    await page.waitForURL(/\/jobs\/[^/]+$/u, { timeout: UI_TIMEOUT_MS });
    await page.waitForURL(new RegExp(`/profiles/${PUBLIC_PROFILE}\?`, 'u'), { timeout: ENTRY_CHECK_TIMEOUT_MS });
    expect(profileIdOfPage(page)).toBe(PUBLIC_PROFILE);
    const saved = await valueOf<{ profile: { approvedTestOrigins: readonly string[]; environmentEvidenceRef: string | null; targetConfigPath: string } }>(
      'getProfileFn', 'GET', { profileId: PUBLIC_PROFILE },
    );
    expect(saved.profile).toMatchObject({ approvedTestOrigins: [], environmentEvidenceRef: null, targetConfigPath: PUBLIC_TARGET_CONFIG });

    // 要点のパネル: 公開の画面の点検。主のボタンは「点検を始める」1 つ（同じ行き先は 1 か所）。
    expect(await stageOf(page)).toBe('AUDIT_PUBLIC');
    expect(await summaryActionsOf(page)).toEqual(['AUDIT_START']);
    expect(await page.locator(`main a[href="/start/${PUBLIC_PROFILE}"]`).count()).toBe(1);

    // 要点の「点検を始める」→ 開始の画面（キーボードだけ）。
    const startLink = page.getByTestId('profile-summary').getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit });
    await tabTo(page, startLink);
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/start/${PUBLIC_PROFILE}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    // PL-3（3 章の 1）: 開始の画面は、要点のパネル（主のボタン 1 つ）と詳しい内容。
    await page.getByTestId('start-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.start.submit }).count()).toBe(1);

    // 一覧の行は「続ける」と、サイトの画面と同じ段の短い文。
    const list = await openPage('/');
    const row = list.locator(`tr[data-profile-id="${PUBLIC_PROFILE}"]`);
    await row.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await row.getByRole('link', { name: nextText.continue }).getAttribute('href')).toBe(`/profiles/${PUBLIC_PROFILE}`);
    expect(await row.getByTestId('profile-row-next').getAttribute('data-stage')).toBe('AUDIT_PUBLIC');
    expect(await row.getByTestId('profile-row-next').textContent()).toContain(nextText.listStages.AUDIT_PUBLIC);
  });

  it('manual login: re-check the entry first, the saved setup links to the next steps, and editing the profile asks to fix the setup', async () => {
    const detail = await openPage(`/profiles/${MANUAL_PROFILE}`);
    // 認証の設定がない（まだ入口を確かめていない）: 主のボタンは「入口を確かめ直す」。点検を始めるボタンは出さず、理由を要点に出す。
    expect(await stageOf(detail)).toBe('ENTRY_NOT_CHECKED');
    expect(await summaryActionsOf(detail)).toEqual(['RECHECK_ENTRY']);
    const reason = detail.getByTestId('profile-stage-reason');
    expect(await reason.getAttribute('data-reason')).toBe('NOT_CHECKED');
    expect(await reason.textContent()).toBe(LOCAL_UI_AUTH_SETUP_PROPOSAL_TEXT.states.NOT_CHECKED);
    expect(await detail.getByRole('main').getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit }).count()).toBe(0);
    // MI-3: 認証の設定の画面への入口は、詳しい内容の中だけ。MI-4: 認証の設定がない間は、「次から自動でログインする」を出さない。
    expect(await detail.getByTestId('profile-detail-actions').locator('[data-action="AUTH_SETUP"]').getAttribute('href')).toBe(`/auth-setup/${MANUAL_PROFILE}`);
    expect(await automatedLoginOffersOf(detail)).toBe(0);

    // 認証の設定を保存する（内容は保存の部品で入れ、画面の「保存する」で保存し直す）→ 次の手順のリンク。
    expect(await saveAuthSetupRequestInStore(rootOf(), { setup: manualSetupOf(MANUAL_PROFILE) })).toMatchObject({ ok: true });
    const setup = await openPage(`/auth-setup/${MANUAL_PROFILE}`);
    expect(await setup.getByTestId('next-step-links').count()).toBe(0);
    // MI-3: 欄と「保存する」は、たたんだ「詳しい設定」の中。
    await openAuthSetupAdvancedSettings(setup, UI_TIMEOUT_MS);
    await setup.getByRole('button', { name: LOCAL_UI_AUTH_TEXT.setup.save }).click();
    await setup.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
    const links = setup.getByTestId('next-step-links');
    await links.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await links.getByRole('link', { name: nextText.after.openOverview }).getAttribute('href')).toBe(`/profiles/${MANUAL_PROFILE}#next-steps`);
    expect(await links.getByRole('link', { name: nextText.after.actions.AUDIT_START }).getAttribute('href')).toBe(`/start/${MANUAL_PROFILE}`);

    // サイトの画面へ戻ると、点検を始められる。PL-1（設計書 4 章の 1）: 手でログインした点検がまだないので、「次から自動でログインする」はまだ出さない
    // （前は、認証の設定を保存した直後から出ていた）。
    await tabTo(setup, links.getByRole('link', { name: nextText.after.openOverview }));
    await setup.keyboard.press('Enter');
    await setup.waitForURL(new RegExp(`/profiles/${MANUAL_PROFILE}#next-steps$`, 'u'), { timeout: UI_TIMEOUT_MS });
    expect(await stageOf(setup)).toBe('AUDIT_MANUAL_LOGIN');
    expect(await summaryActionsOf(setup)).toEqual(['AUDIT_START']);
    expect(await setup.getByTestId('profile-stage').textContent()).toBe(nextText.stages.AUDIT_MANUAL_LOGIN);
    expect(await automatedLoginOffersOf(setup)).toBe(0);
    expect(await setup.getByTestId('profile-summary').getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit }).getAttribute('href'))
      .toBe(`/start/${MANUAL_PROFILE}`);
    // MI-3 の D: 書き込みのモードでないプロファイルの開始の画面には、読み取りだけの一文を出さない。
    const manualStart = await openPage(`/start/${MANUAL_PROFILE}`);
    await manualStart.getByTestId('start-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await manualStart.getByTestId('start-write-mode-read-only').count()).toBe(0);

    // プロファイルを直す（改訂 2。編集の欄は、詳しい内容の中）→ 認証の設定が古い。主のボタンは「ログインの設定を開く」で、点検は始められない。
    await openProfileAdvancedSettings(setup, UI_TIMEOUT_MS);
    await setup.getByRole('button', { name: text.profileForm.save }).click();
    await setup.getByText(text.profileForm.updated).waitFor({ timeout: UI_TIMEOUT_MS });
    await setup.locator('[data-testid="profile-summary"][data-stage="AUTH_SETUP_FIX"]').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await summaryActionsOf(setup)).toEqual(['AUTH_SETUP']);
    expect(await setup.getByTestId('profile-summary').locator('[data-action="AUTH_SETUP"]').getAttribute('href')).toBe(`/auth-setup/${MANUAL_PROFILE}`);
    expect(await setup.getByTestId('profile-stage-reason').getAttribute('data-reason')).toBe('AUTH_SETUP_STALE');
    expect(await setup.getByTestId('profile-stage-reason').textContent()).toContain(AUDIT_JOB_START_REJECTION_DESCRIPTIONS.AUTH_SETUP_STALE.description);
    // MI-4: 認証の設定が古い間は出さない（先に直す）。
    expect(await automatedLoginOffersOf(setup)).toBe(0);
  });

  it('automated login: re-check the entry first, and no way to the login check screen (decision 1)', async () => {
    const detail = await openPage(`/profiles/${AUTOMATED_PROFILE}`);
    expect(await stageOf(detail)).toBe('ENTRY_NOT_CHECKED');
    // 資格情報の画面への入口は、詳しい内容の中。ログインの確かめの画面への入口は、どこにもない（止めたときだけ出す）。
    expect(await detail.getByTestId('profile-detail-actions').locator('[data-action="CREDENTIAL"]').getAttribute('href')).toBe(`/credentials/${AUTOMATED_PROFILE}`);
    expect(await loginCheckLinksOf(detail)).toBe(0);
    // MI-4: 自動ログインのプロファイルには、「次から自動でログインする」を出さない。
    expect(await automatedLoginOffersOf(detail)).toBe(0);
  });

  // MI-5（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.5）: 書き込みのモードでも監査を始められるので、書き込みのモードの手動のログインの
  // プロファイルは、認証つきの読み取りの監査と同じく、認証の設定がない間は入口の確かめから（`AUTH_SETUP_MISSING`）。一覧は、サイトの画面と同じ段を出す。
  it('write mode and a retired profile: no start button with the reason, and the list shows the same stage shortly', async () => {
    const write = await openPage(`/profiles/${WRITE_PROFILE}`);
    expect(await stageOf(write)).toBe('ENTRY_NOT_CHECKED');
    expect(await write.getByRole('main').getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit }).count()).toBe(0);
    // MI-3 の D: 書き込みのモードのプロファイルの開始の画面には、監査は読み取りだけで行う旨の一文を出す。
    const writeStart = await openPage(`/start/${WRITE_PROFILE}`);
    await writeStart.getByTestId('start-write-mode-read-only').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await writeStart.getByTestId('start-write-mode-read-only').textContent()).toBe(LOCAL_UI_AUDIT_TEXT.start.readOnlyInWriteMode);

    // 取り消したプロファイル: 要点に取り消した旨だけ。押せるボタンは出さない（記録を見る画面は詳しい内容の中）。
    const retired = await openPage(`/profiles/${RETIRED_PROFILE}`);
    expect(await stageOf(retired)).toBe('SITE_RETIRED');
    expect(await summaryActionsOf(retired)).toEqual([]);
    expect(await retired.getByTestId('profile-stage').textContent()).toBe(nextText.stages.SITE_RETIRED);
    expect(await retired.getByRole('main').getByRole('button', { name: text.retireDialog.open }).count()).toBe(0);

    const list = await openPage('/');
    const retiredRow = list.locator(`tr[data-profile-id="${RETIRED_PROFILE}"]`);
    await retiredRow.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await retiredRow.getByTestId('profile-row-next').getAttribute('data-stage')).toBe('SITE_RETIRED');
    expect(await retiredRow.getByTestId('profile-row-next').textContent()).toBe(nextText.listStages.SITE_RETIRED);
    expect(await retiredRow.getByRole('link', { name: nextText.continue }).count()).toBe(0);
    // MI-5: 書き込みのモードの行は、サイトの画面と同じ段（入口の確かめが要る）と「続ける」。
    const writeRow = list.locator(`tr[data-profile-id="${WRITE_PROFILE}"]`);
    await writeRow.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await writeRow.getByTestId('profile-row-next').getAttribute('data-stage')).toBe('ENTRY_NOT_CHECKED');
    expect(await writeRow.getByRole('link', { name: nextText.continue }).count()).toBe(1);
    expect(await writeRow.getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit }).count()).toBe(0);
  });

  // T43a fix round 1（設計者の判断 1）: モードを選ぶと、環境と認証の方式を組み合わせの表の初めの値に合わせる（利用者は後から変えられる）。PL-1: 作成の画面から
  // この 3 つの欄を消したので、編集の画面（サイトの画面の詳しい内容の中）で確かめる（保存はしない）。
  it('sets the environment and the auth to the first values of the combination table when a mode is selected on the edit screen, and lets the person change them', async () => {
    const page = await openPage(`/profiles/${WRITE_PROFILE}`);
    await openProfileAdvancedSettings(page, UI_TIMEOUT_MS);
    // 「環境」は「テスト環境の Origin」などにも部分一致するので、ラベルは完全一致で選ぶ。
    const mode = page.getByLabel(text.profileForm.mode, { exact: true });
    const environment = page.getByLabel(text.profileForm.environment, { exact: true });
    const auth = page.getByLabel(text.profileForm.auth, { exact: true });
    const evidence = page.getByLabel(text.profileForm.environmentEvidenceRef);
    const testOrigins = page.getByLabel(text.profileForm.approvedTestOrigins);
    await mode.waitFor({ timeout: UI_TIMEOUT_MS });
    const selected = async (): Promise<readonly string[]> => [await environment.inputValue(), await auth.inputValue()];
    expect(await selected()).toEqual(['TEST', 'MANUAL_SESSION']);
    await mode.selectOption('PUBLIC_PASSIVE');
    await expect.poll(selected, { timeout: UI_TIMEOUT_MS }).toEqual(['PUBLIC', 'NONE']);

    await mode.selectOption('TEST_AUTH_PASSIVE');
    await expect.poll(selected, { timeout: UI_TIMEOUT_MS }).toEqual(['TEST', 'MANUAL_SESSION']);
    // 利用者は、合わせた値を後から変えられる（モードを選び直すまで残る）。
    await auth.selectOption('NONE');
    expect(await selected()).toEqual(['TEST', 'NONE']);
    await mode.selectOption('TEST_APPROVED_WRITE');
    await expect.poll(selected, { timeout: UI_TIMEOUT_MS }).toEqual(['TEST', 'MANUAL_SESSION']);
    await mode.selectOption('PUBLIC_PASSIVE');
    await expect.poll(selected, { timeout: UI_TIMEOUT_MS }).toEqual(['PUBLIC', 'NONE']);
    expect([await testOrigins.count(), await evidence.count()]).toEqual([0, 0]);

    // 設計者の判断 3: 確かめた記録の参照の欄は、環境がテスト環境のときに出す（公開のモードでも）。テスト環境の Origin の欄は、モードで隠す。
    await environment.selectOption('TEST');
    await evidence.waitFor({ timeout: UI_TIMEOUT_MS });
    expect([await testOrigins.count(), await evidence.count()]).toEqual([0, 1]);
  });

  // MI-C 項目 13: 編集の画面は今のまま（自動ログインのプロファイルを開ける。手動のログインへ戻す道に要る）。
  it('still offers the automated login in the auth of the edit screen', async () => {
    const page = await openPage(`/profiles/${AUTOMATED_PROFILE}`);
    await openProfileAdvancedSettings(page, UI_TIMEOUT_MS);
    const auth = page.getByLabel(text.profileForm.auth, { exact: true });
    await auth.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await auth.inputValue()).toBe('AUTOMATED_LOGIN');
    expect(await auth.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)))
      .toContain('MANUAL_SESSION');
  });

  it('keeps the evidence reference of a public mode profile in the test environment when the profile is saved again', async () => {
    const page = await openPage(`/profiles/${PUBLIC_TEST_PROFILE}`);
    // MI-1: 編集の欄は、たたんだ詳しい設定の中。
    await openProfileAdvancedSettings(page, UI_TIMEOUT_MS);
    const evidence = page.getByLabel(text.profileForm.environmentEvidenceRef);
    await evidence.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await evidence.inputValue()).toBe(PUBLIC_TEST_EVIDENCE);
    expect(await page.getByLabel(text.profileForm.approvedTestOrigins).count()).toBe(0);
    await page.getByRole('button', { name: text.profileForm.save }).click();
    await page.getByText(text.profileForm.updated).waitFor({ timeout: UI_TIMEOUT_MS });
    const saved = await valueOf<{ profile: { revision: number; environment: string; environmentEvidenceRef: string | null } }>(
      'getProfileFn', 'GET', { profileId: PUBLIC_TEST_PROFILE },
    );
    expect(saved.profile).toMatchObject({ revision: 2, environment: 'TEST', environmentEvidenceRef: PUBLIC_TEST_EVIDENCE });
  });
});

describe('profile-screens-ui: the site screens (PL-1・PL-U・DEF-196・DEF-197)', () => {
  const IS_WINDOWS = process.platform === 'win32';
  const SKIP_REASON = 'the automated login states save the credential with the real DPAPI, which exists only on Windows';
  const UI_TIMEOUT_MS = 20_000;
  const SCENARIO_TIMEOUT_MS = 180_000;
  const MAX_PAGES = 4; // L14: 3 は前の既定と同じ値（読むときに捨てられる）なので 4。
  const FIRST_REVISION = 1;
  const TEST_ORIGIN = 'http://127.0.0.1:9';
  const ADMIN_PATH = '/admin';

  /** 状態ごとのプロファイル（名前は状態の短い名前）。 */
  const PROFILES = Object.freeze({
    entry: 'pl1-entry',
    audit: 'pl1-audit',
    after: 'pl1-after',
    write: 'pl1-write',
    public: 'pl1-public',
    automated: 'pl1-automated',
    wait: 'pl1-wait',
    held: 'pl1-held',
    resultManual: 'plu-result-manual',
    resultPublic: 'plu-result-public',
  });

  const text = LOCAL_UI_NEXT_STEP_TEXT;

  const { started, rootOf, contextOf } = sharedUiServerKitOf(serverKit);

  const { openPage, expectCleanAndClosePages } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
  });

  /** 管理データを開いて 1 回書く（テストだけの操作）。 */
  const withDatabase = <T>(write: (database: ReturnType<typeof openControlDatabase>) => T): T => {
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      return write(database);
    } finally {
      closeControlDatabase(database);
    }
  };

  const now = (): string => formatCompactUtcTimestamp(new Date(), 'test job time');

  /**
   * 終わった点検のジョブの行を書く（ワーカーの代わり）。`autoLogin` があれば、自動ログインの試しを、その結果で記録する（成功なら間隔の中、送った失敗なら停止）。
   */
  const writeFinishedAudit = (
    profileId: string,
    autoLogin: { readonly result: 'SUCCEEDED' | 'INVALID_CREDENTIALS' } | null,
    /** PL-U: 点検の報告（`report.html`）を置く、設定の出力先のフォルダ（一時の root からの相対）。省けば報告はない。 */
    reportOutputDirectory?: string,
    /** DEF-202: 報告の隣に、ChatGPT 用のまとめファイル（ZIP）も置くか（報告の出力先があるときだけ）。 */
    withBundle = false,
  ): string => {
    const jobId = `job-${profileId}-${randomUUID().slice(0, 8)}`;
    const runId = 'RUN-20261026000000';
    withDatabase((database) => {
      const createdAt = now();
      expect(createStartingJob(database, {
        jobId, jobKind: 'AUDIT', profileId, profileRevision: FIRST_REVISION, startNew: true, createdAt,
        ...(autoLogin === null ? {} : { autoLoginAttempt: { credentialRevision: 1 } }),
      }, () => null)).toEqual({ ok: true });
      if (autoLogin !== null) {
        expect(recordAutoLoginResult(database, { jobId, result: autoLogin.result, submitted: 'YES', retryAfterUntil: null, at: createdAt }))
          .toMatchObject({ recorded: true });
      }
      expect(recordRunStarted(database, jobId, { runId: runId as never, runDirectory: runId, startedAt: createdAt })).toBe(true);
      expect(recordFinished(database, jobId, { kind: 'RAN', exitCode: 0, runId: runId as never, runDirectory: runId, runStatus: 'COMPLETE' }, now()))
        .toBe(true);
    });
    if (reportOutputDirectory !== undefined) {
      const runDirectory = join(rootOf().root, reportOutputDirectory, runId);
      mkdirSync(runDirectory, { recursive: true });
      writeFileSync(join(runDirectory, 'report.html'), '<!doctype html><html lang="ja"><head><title>r</title></head><body></body></html>', 'utf8');
      if (withBundle) {
        writeFileSync(join(runDirectory, bundleFileName(new Date().toISOString())), 'PK', 'utf8');
      }
    }
    return jobId;
  };

  /** テスト用のサイトのプロファイル（手でログイン・自動ログイン・書き込みのモード）。 */
  const testProfileOf = (profileId: string, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
    schemaVersion: 'beaksight-profile/1', profileId, revision: FIRST_REVISION, targetConfigPath: `config/targets/${profileId}.json`,
    environment: 'TEST', mode: 'TEST_AUTH_PASSIVE', auth: 'MANUAL_SESSION', approvedTestOrigins: [TEST_ORIGIN], environmentEvidenceRef: `${profileId}-evidence`,
    ...overrides,
  });

  /** フォームで送るログインの認証の設定（入口の確かめの後に、BeakSight が案で保存した形）。`automated` なら自動ログインのセレクタも。 */
  const formSetupOf = (profileId: string, automated: boolean): Record<string, unknown> => ({
    ...FORM_NAVIGATION_SETUP_ITEMS,
    profileId,
    profileRevision: FIRST_REVISION,
    loginStartUrl: `${TEST_ORIGIN}/auth`,
    loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/auth' }],
    successCondition: { pathPrefix: ADMIN_PATH, selector: null },
    sessionLostCondition: { pathPrefix: '/auth' },
    excludedPaths: ['/auth/logout'],
    auditPathPrefixes: [],
    maxLoginAttempts: automated ? AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS : 1,
    allowedIdpOrigins: [],
    automatedLogin: automated
      ? {
        usernameSelector: '#email',
        passwordSelector: '#password',
        submitSelector: '#login',
        failureConditions: { invalidCredentials: { pathPrefix: '/auth', selector: null }, accountLocked: null, mfaRequired: null, credentialExpired: null },
      }
      : null,
  });

  /** テスト用のサイトのプロファイルを作り、認証の設定を保存する（`setup` が偽なら、入口の確かめの前で設定はない）。 */
  const createTestProfile = async (profileId: string, options: { readonly setup: boolean; readonly overrides?: Readonly<Record<string, unknown>> }): Promise<void> => {
    writeAuthTargetConfig(rootOf().root, profileId, TEST_ORIGIN, ADMIN_PATH, MAX_PAGES);
    expect(await createProfileInStore(rootOf().root, testProfileOf(profileId, options.overrides))).toMatchObject({ ok: true });
    if (options.setup) {
      const automated = options.overrides?.['auth'] === 'AUTOMATED_LOGIN';
      expect(await saveAuthSetupInStore(rootOf().root, formSetupOf(profileId, automated))).toMatchObject({ ok: true });
    }
  };

  /** サイトの画面を開き、要点のパネルを待つ。 */
  const openProfile = async (profileId: string): Promise<Page> => {
    const page = await openPage(`/profiles/${profileId}`);
    await page.getByTestId('profile-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    return page;
  };

  /** 3 章の形の共通の確かめ（主のボタン 1 つまで、axe の違反 0、見える塊は要点と詳しい内容の 2 つで、詳しい内容は閉じている）。 */
  const expectScreenShape = async (page: Page, label: string): Promise<void> => {
    await expectAtMostOnePrimaryButton(page);
    expect(await axeViolationsOf(page), label).toEqual([]);
    expect(await page.locator('main > section:visible').count(), label).toBe(2);
    expect(await page.getByTestId('profile-edit-advanced-settings').evaluate((element) => (element as HTMLDetailsElement).open), label).toBe(false);
  };

  /** 要点のパネルの段と、見えているボタンの名前（主のボタン → 二次のボタン）。 */
  const summaryOf = async (page: Page): Promise<{ readonly stage: string | null; readonly buttons: readonly string[]; readonly primary: readonly string[] }> => {
    const summary = page.getByTestId('profile-summary');
    return {
      stage: await summary.getAttribute('data-stage'),
      buttons: (await summary.locator('[data-testid="profile-summary-actions"] .button').allTextContents()).map((label) => label.trim()),
      primary: await primaryButtonLabelsInMain(page),
    };
  };

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  // 束: 「PL-1: the site list and the create screen」（空の一覧と作成の画面）は、束の最初の describe へ移した。

  describe('PL-1: the site screen follows the stage', () => {
    beforeAll(async () => {
      await createTestProfile(PROFILES.entry, { setup: false });
      await createTestProfile(PROFILES.audit, { setup: true });
      await createTestProfile(PROFILES.after, { setup: true });
      writeFinishedAudit(PROFILES.after, null);
      await createTestProfile(PROFILES.write, { setup: true, overrides: { mode: 'TEST_APPROVED_WRITE' } });
      const publicPath = writeAuditTargetConfig(rootOf().root, PROFILES.public, TEST_ORIGIN, { minNavigationIntervalMs: 0, screenshots: false });
      expect(await createProfileInStore(rootOf().root, publicProfileDocument(PROFILES.public, publicPath))).toMatchObject({ ok: true });
    }, SCENARIO_TIMEOUT_MS);

    it('before the entry check: re-check the entry is the only primary button, no audit and no login check', async () => {
      const page = await openProfile(PROFILES.entry);
      expect(await summaryOf(page)).toEqual({ stage: 'ENTRY_NOT_CHECKED', buttons: [text.actions.RECHECK_ENTRY], primary: [text.actions.RECHECK_ENTRY] });
      expect(await page.getByTestId('profile-stage').textContent()).toBe(text.stages.ENTRY_NOT_CHECKED);
      expect(await page.getByRole('main').getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit }).count()).toBe(0);
      expect(await page.locator('main a[href*="/login-check/"]').count()).toBe(0);
      await expectScreenShape(page, PROFILES.entry);
    });

    it('after the entry check: start the audit, and neither the automated login nor the write mode yet (4 の 1)', async () => {
      const page = await openProfile(PROFILES.audit);
      expect(await summaryOf(page)).toEqual({
        stage: 'AUDIT_MANUAL_LOGIN', buttons: [text.actions.AUDIT_START], primary: [text.actions.AUDIT_START],
      });
      // 同じ行き先の重なりがない（点検を始めるは 1 か所）。自動ログインと書き込みの入口は、詳しい内容にもまだない。
      expect(await page.locator('main a[href$="/start/pl1-audit"]').count()).toBe(1);
      expect(await page.locator('main [data-action="AUTOMATED_LOGIN_SETUP"], main [data-action="WRITE_MODE_SWITCH"]').count()).toBe(0);
      expect(await page.locator('main a[href*="/login-check/"]').count()).toBe(0);
      await expectScreenShape(page, PROFILES.audit);
    });

    // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D5。08 の指摘）: 「次から自動でログインする」はなくした。ID とパスワードの画面は、詳しい内容の中の
    // 直す道。OP-2（4.1.1 の D7'）: 「書き込みも試す」もなくした（書き込みは「登録・更新を試せる画面」の一覧のチェック）。手でログインした点検の後は、点検の段のまま。
    it('after a manual audit: the audit is the primary button (no "write too"), the credential screen is in the details', async () => {
      const page = await openProfile(PROFILES.after);
      expect(await summaryOf(page)).toEqual({
        stage: 'AUDIT_AGAIN',
        buttons: [text.actions.AUDIT_START],
        primary: [text.actions.AUDIT_START],
      });
      expect(await page.getByTestId('profile-detail-actions').locator('[data-action="CREDENTIAL"]').count()).toBe(1);
      await expectScreenShape(page, PROFILES.after);
      // 詳しい内容を開いても、主のボタンは 1 つのまま（中のボタンは二次の見た目）。
      await page.getByTestId('profile-edit-advanced-settings').locator('summary').click();
      await expectAtMostOnePrimaryButton(page);
    });

    // OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'）: 書き込みの手順の画面は、ふだんの流れから外した（詳しい内容の直す道）。書き込みの
    // モードのサイトも、ほかのサイトと同じ点検の段（点検がまだなら、点検を始める）。
    it('write mode: the same audit stage as the other sites (the write scenarios are in the details)', async () => {
      const page = await openProfile(PROFILES.write);
      expect(await summaryOf(page)).toEqual({
        stage: 'AUDIT_MANUAL_LOGIN', buttons: [text.actions.AUDIT_START], primary: [text.actions.AUDIT_START],
      });
      expect(await page.getByTestId('profile-detail-actions').locator('[data-action="SCENARIOS"]').count()).toBe(1);
      await expectScreenShape(page, PROFILES.write);
      // 束（UI-3）: write-mode-switch-ui.test.ts を消すので、その「書き込みにも使う」のボタンがないこと（MI-5）を、詳しい内容を開いてここで確かめる。
      await openProfileAdvancedSettings(page, UI_TIMEOUT_MS);
      expect(await page.locator('main [data-action="WRITE_MODE_SWITCH"], main [data-testid="profile-write-mode-open"]').count()).toBe(0);
    });

    it('public site: start the audit', async () => {
      const page = await openProfile(PROFILES.public);
      expect(await summaryOf(page)).toEqual({ stage: 'AUDIT_PUBLIC', buttons: [text.actions.AUDIT_START], primary: [text.actions.AUDIT_START] });
      await expectScreenShape(page, PROFILES.public);
    });

    it('the list: the only primary button is "add a site", each row has "continue" with the same stage as the site screen', async () => {
      const page = await openPage('/');
      await page.getByTestId('profile-list').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await primaryButtonLabelsInMain(page)).toEqual([LOCAL_UI_TEXT.profileList.newProfile]);
      const expected: Readonly<Record<string, string>> = {
        [PROFILES.entry]: 'ENTRY_NOT_CHECKED',
        [PROFILES.audit]: 'AUDIT_MANUAL_LOGIN',
        // OP-1（D5）: 「次から自動でログインする」の段はなくした。
        // OP-2: 「書き込みも試す」と「書き込みの手順へ」の段もなくした。
        [PROFILES.after]: 'AUDIT_AGAIN',
        [PROFILES.write]: 'AUDIT_MANUAL_LOGIN',
        [PROFILES.public]: 'AUDIT_PUBLIC',
      };
      for (const [profileId, stage] of Object.entries(expected)) {
        const row = page.locator(`tr[data-profile-id="${profileId}"]`);
        expect(await row.getByTestId('profile-row-next').getAttribute('data-stage'), profileId).toBe(stage);
        expect(await row.getByRole('link', { name: text.continue }).getAttribute('href'), profileId).toBe(`/profiles/${profileId}`);
        // 行に点検の開始やログインの確かめへの直接のボタンはない。
        expect(await row.locator('a[href*="/start/"], a[href*="/login-check/"]').count(), profileId).toBe(0);
      }
      expect(await axeViolationsOf(page)).toEqual([]);
    });

    // OP-I（I3。設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.5、`2026-10-26-beaksight-plain-ui-design.md` 13 章の 5）: サイトの一覧の表は、幅 1280 でも
    // 390 でも、本文の幅に収まる（横のスクロールが出ない）。「次にすること」の列の文は切れない（折り返して全部見える）。
    it.each([[1280, 800], [390, 844]] as const)('the list: the table fits in the content at the width %i, and the next step text is not cut', async (width, height) => {
      const page = await openPage('/');
      await page.setViewportSize({ width, height });
      await page.getByTestId('profile-list').waitFor({ timeout: UI_TIMEOUT_MS });
      const measured = await page.evaluate(() => {
        const table = document.querySelector('[data-testid="profile-list"]') as HTMLElement;
        const wrap = table.parentElement as HTMLElement;
        const content = table.closest('main') as HTMLElement;
        const nextTexts = [...document.querySelectorAll('[data-testid="profile-row-next"] p')] as HTMLElement[];
        return {
          tableWidth: table.getBoundingClientRect().width,
          wrapWidth: wrap.clientWidth,
          wrapScrollWidth: wrap.scrollWidth,
          contentRight: content.getBoundingClientRect().right,
          tableRight: table.getBoundingClientRect().right,
          pageScrollWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth,
          cutTexts: nextTexts.filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => element.textContent),
          nextTextCount: nextTexts.length,
        };
      });
      expect(measured.nextTextCount).toBeGreaterThan(0);
      expect(measured.wrapScrollWidth, JSON.stringify(measured)).toBeLessThanOrEqual(measured.wrapWidth);
      expect(measured.tableWidth, JSON.stringify(measured)).toBeLessThanOrEqual(measured.wrapWidth + 1);
      expect(measured.tableRight, JSON.stringify(measured)).toBeLessThanOrEqual(measured.contentRight + 1);
      expect(measured.pageScrollWidth, JSON.stringify(measured)).toBeLessThanOrEqual(measured.viewportWidth);
      expect(measured.cutTexts).toEqual([]);
      expect(await axeViolationsOf(page)).toEqual([]);
    });
  });

  // PL-U（設計書 14.1 の U2、13 章の 13）: 点検を終えたばかりで移ってきたときと、最新の点検の結果があって次の段の操作がないときは、主のボタンを「結果を
  // 見る」にする。次の段の操作は二次のボタンにし、押し出された二次のボタンは詳しい内容に移す（ボタンは増やさない）。
  describe('PL-U: the result of the audit on the site screen', () => {
    let arrivedJobId = '';

    beforeAll(async () => {
      await createTestProfile(PROFILES.resultManual, { setup: true });
      arrivedJobId = writeFinishedAudit(PROFILES.resultManual, null, `t25e-output-${PROFILES.resultManual}`, true);
      const publicPath = writeAuditTargetConfig(rootOf().root, PROFILES.resultPublic, TEST_ORIGIN, { minNavigationIntervalMs: 0, screenshots: false });
      expect(await createProfileInStore(rootOf().root, publicProfileDocument(PROFILES.resultPublic, publicPath))).toMatchObject({ ok: true });
      writeFinishedAudit(PROFILES.resultPublic, null, outputDirectoryOf(PROFILES.resultPublic));
    }, SCENARIO_TIMEOUT_MS);

    it('right after the audit: "see the result" is the primary button, the next stage is the secondary one, the audit start is in the details', async () => {
      const page = await openPage(`/profiles/${PROFILES.resultManual}?arrived=auto&fromJob=${arrivedJobId}`);
      await page.getByTestId('profile-summary').waitFor({ timeout: UI_TIMEOUT_MS });
      // OP-2: 次の段の操作（前の「書き込みも試す」）はなくしたので、二次のボタンは点検を始める。
      expect(await summaryOf(page)).toEqual({
        stage: 'AUDIT_AGAIN',
        buttons: [text.actions.AUDIT_RESULT, text.actions.AUDIT_START],
        primary: [text.actions.AUDIT_RESULT],
      });
      const result = page.getByTestId('profile-summary').locator('[data-action="AUDIT_RESULT"]');
      expect(await result.getAttribute('href')).toMatch(/report\.html$/u);
      expect(await result.getAttribute('target')).toBe('_blank');
      // DEF-202: 「結果を見る」の隣に、最新の点検のまとめファイル（ZIP）を保存するリンク（作業の画面の「できたファイル」と同じ文言。ボタンの見た目は使わない）。
      // ボタンの列（主のボタンと二次のボタンだけ）の中には置かず、ボタンの列の後の、独立した 1 行に置く。
      expect(await page.getByTestId('profile-summary-actions').getByTestId('profile-bundle-download').count()).toBe(0);
      const bundle = page.getByTestId('profile-summary').getByTestId('profile-bundle-download');
      expect(await bundle.count()).toBe(1);
      expect(await page.getByTestId('profile-summary').evaluate((summary) => {
        const row = summary.querySelector('[data-testid="profile-summary-actions"]');
        const link = summary.querySelector('[data-testid="profile-bundle-download"]');
        return row !== null && link !== null && link.parentElement?.tagName === 'P'
          && (row.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      })).toBe(true);
      expect(await bundle.getAttribute('href')).toMatch(/\/beaksight-audit-bundle_\d{14}\.zip$/u);
      expect(await bundle.getAttribute('download')).not.toBeNull();
      expect(await bundle.textContent()).toBe(LOCAL_UI_AUDIT_TEXT.job.downloadBundle);
      // 要点の 1 行目は、移ってきた点検の結果の 1 行。
      expect(await page.getByTestId('profile-arrival').textContent()).toBe(LOCAL_UI_JOB_SUMMARY_TEXT.finished.AUDIT_COMPLETE);
      // OP-3（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D12）: 「点検が終わりました」を 2 行続けて出さない（段の文は、次にすることだけ）。
      expect((await page.getByTestId('profile-summary').textContent() ?? '').split('終わりました').length - 1).toBe(1);
      expect(await page.getByTestId('profile-stage').textContent()).toBe(text.afterAuditArrival.AUDIT_AGAIN);
      const details = page.getByTestId('profile-detail-actions');
      expect(await details.locator('[data-action="AUDIT_START"]').count()).toBe(0);
      expect(await page.locator('main [data-action="WRITE_MODE_SWITCH"]').count()).toBe(0);
      await expectScreenShape(page, `${PROFILES.resultManual} arrived`);
      // 移ってきた印がなければ、今どおり次の段の操作が主のボタン（結果を見るは出さない）。
      const plain = await openProfile(PROFILES.resultManual);
      expect(await summaryOf(plain)).toEqual({
        stage: 'AUDIT_AGAIN',
        buttons: [text.actions.AUDIT_RESULT, text.actions.AUDIT_START],
        primary: [text.actions.AUDIT_RESULT],
      });
      // 移ってきた印がなければ、段の文は前回の点検が終わったことから言う。
      expect(await plain.getByTestId('profile-stage').textContent()).toBe(text.stages.AUDIT_AGAIN);
    });

    it('nothing next: "see the result" is the primary button and the audit start the secondary one', async () => {
      const page = await openProfile(PROFILES.resultPublic);
      expect(await summaryOf(page)).toEqual({
        stage: 'AUDIT_AGAIN',
        buttons: [text.actions.AUDIT_RESULT, text.actions.AUDIT_START],
        primary: [text.actions.AUDIT_RESULT],
      });
      // DEF-202: まとめファイル（ZIP）がまだないときは、保存のリンクを出さない。
      expect(await page.getByTestId('profile-bundle-download').count()).toBe(0);
      await expectScreenShape(page, PROFILES.resultPublic);
    });
  });

  // DEF-196: 広い画面では、サイトの一覧の表が本文の枠に収まる（右に余白があるのに横スクロールにしない）。狭い画面（375）は、今のとおり行ごとの縦の並びで、
  // 横のスクロールが出ない。表を広くする行（長めのサイトの名前と、前回の点検の欄）を足して確かめる（ほかの describe の幅の確かめの後に足す）。
  describe('DEF-196: the site list on a wide screen', () => {
    const wideProfileId = 'def196-a-site-with-a-rather-long-name-for-the-list';

    beforeAll(async () => {
      await createTestProfile(wideProfileId, { setup: true });
      writeFinishedAudit(wideProfileId, null);
    }, SCENARIO_TIMEOUT_MS);

    it.each([[2000, 1000], [375, 812]] as const)('the table fits in its frame at the width %i (no horizontal scroll)', async (width, height) => {
      const page = await openPage('/');
      await page.setViewportSize({ width, height });
      await page.getByTestId('profile-list').waitFor({ timeout: UI_TIMEOUT_MS });
      const measured = await page.evaluate(() => {
        const table = document.querySelector('[data-testid="profile-list"]') as HTMLElement;
        const wrap = table.parentElement as HTMLElement;
        return {
          wrapWidth: wrap.clientWidth,
          wrapScrollWidth: wrap.scrollWidth,
          tableDisplay: getComputedStyle(table).display,
          pageScrollWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth,
        };
      });
      expect(measured.wrapScrollWidth, JSON.stringify(measured)).toBeLessThanOrEqual(measured.wrapWidth);
      expect(measured.pageScrollWidth, JSON.stringify(measured)).toBeLessThanOrEqual(measured.viewportWidth);
      // 狭い画面は、今のとおり行ごとの縦の並び（`data-table--stack`）。広い画面は表のまま。
      expect(measured.tableDisplay).toBe(width <= 768 ? 'block' : 'table');
      expect(await axeViolationsOf(page)).toEqual([]);
    });
  });

  describe('PL-1: the automated login states (the login check is out of the flow)', () => {
    beforeAll(async () => {
      if (!IS_WINDOWS) return;
      const credentials = createCredentialStore(rootOf().root);
      for (const profileId of [PROFILES.automated, PROFILES.wait, PROFILES.held]) {
        await createTestProfile(profileId, { setup: true, overrides: { auth: 'AUTOMATED_LOGIN' } });
        await credentials.register({ profileId, loginOrigin: TEST_ORIGIN, username: `pl1-user-${randomUUID()}`, password: `pl1-pass-${randomUUID()}` });
      }
      // 切り替えの前の、手でのログインの点検（自動ログインの試しの記録はない）。
      writeFinishedAudit(PROFILES.automated, null);
      // 自動ログインの点検が成功した直後（5 分の間隔の中）と、送った後に失敗した（止めた）点検。
      writeFinishedAudit(PROFILES.wait, { result: 'SUCCEEDED' });
      writeFinishedAudit(PROFILES.held, { result: 'INVALID_CREDENTIALS' });
    }, SCENARIO_TIMEOUT_MS);

    it.skipIf(!IS_WINDOWS)(`after the switch: start the audit (no login check step) (${SKIP_REASON} otherwise)`, async () => {
      const page = await openProfile(PROFILES.automated);
      expect(await summaryOf(page)).toEqual({
        stage: 'AUDIT_AUTOMATED_LOGIN', buttons: [text.actions.AUDIT_START], primary: [text.actions.AUDIT_START],
      });
      expect(await page.locator('main a[href*="/login-check/"]').count()).toBe(0);
      await expectScreenShape(page, PROFILES.automated);
    });

    it.skipIf(!IS_WINDOWS)(`within the interval: no primary button, and the summary says when it can start (${SKIP_REASON} otherwise)`, async () => {
      const page = await openProfile(PROFILES.wait);
      expect(await summaryOf(page)).toEqual({ stage: 'AUTO_LOGIN_WAIT', buttons: [], primary: [] });
      const when = page.getByTestId('profile-next-allowed-at');
      expect(await when.getAttribute('data-next-allowed-at')).not.toBe('');
      // この場面には報告がない（`writeFinishedAudit` の報告の出力先を省いた）ので、OP-G の「報告があれば待ちの間も『結果を見る』を主のボタンにする」には
      // 当たらず、主のボタンはないまま（上の確かめ）。
      const whenText = (await when.textContent()) ?? '';
      expect(whenText).toMatch(/から始められます。$/u);
      // OP-G（意図して直した期待）: 待ちの文と始められる時刻を 1 行にまとめた（カタログの `autoLoginWaitUntil`）。前と後ろはカタログの文と同じ。
      const [waitHead = '', waitTail = ''] = text.autoLoginWaitUntil('\u0000').split('\u0000');
      expect(waitHead.length).toBeGreaterThan(0);
      expect(waitTail).toBe(' から始められます。');
      expect(whenText.startsWith(waitHead)).toBe(true);
      expect(whenText.endsWith(waitTail)).toBe(true);
      // OP-3（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D12）: 時刻は「10 月 27 日 15:30」の形（年・秒・JST を書かない）。
      expect(whenText.slice(waitHead.length, whenText.length - waitTail.length)).toMatch(/^\d{1,2} 月 \d{1,2} 日 \d{1,2}:\d{2}$/u);
      expect(await page.locator('main a[href*="/login-check/"]').count()).toBe(0);
      await expectScreenShape(page, PROFILES.wait);
    });

    it.skipIf(!IS_WINDOWS)(`held: no primary button, the reason, and the way to clear the hold (${SKIP_REASON} otherwise)`, async () => {
      const page = await openProfile(PROFILES.held);
      expect(await summaryOf(page)).toEqual({ stage: 'AUTO_LOGIN_HELD', buttons: [text.actions.CLEAR_HOLD], primary: [] });
      expect(await page.getByTestId('profile-stage').textContent()).toBe(text.stages.AUTO_LOGIN_HELD);
      expect(await page.locator('main a[href$="/login-check/pl1-held"]').count()).toBe(1);
      await expectScreenShape(page, PROFILES.held);
    });
  });

  // DEF-197: まとめて実行の連鎖の途中（点検の段は終わり、操作さがしの段のジョブが動いている）。一覧の「前回の点検」と「次にすること」は同じ事実から決まり、
  // 「次にすること」は点検をしている段で、「続ける」を出さない。サイトの画面の要点にも、「結果を見る」と「点検を始める」を出さない。
  // 動いているジョブの行は、ジョブの管理の部品で書く（ワーカーは起動しない）。動いているジョブがあると、ほかのジョブを作れないので、この describe は最後に置き、
  // 終わりにジョブを終わった形にする。
  describe('DEF-197: the site while a stage of the chain is running', () => {
    const runningProfileId = 'def197-running';
    const runningJobId = `job-${runningProfileId}-discovery`;

    beforeAll(async () => {
      await createTestProfile(runningProfileId, { setup: true });
      writeFinishedAudit(runningProfileId, null, `t25e-output-${runningProfileId}`, true);
      withDatabase((database) => {
        // 束（UI-3）: 一覧は作成の時刻（秒）の新しい順で、同じ秒なら job_id の降順。終わった点検の job_id は乱数の後ろ（`job-def197-running-<8 桁>`）を持つので、
        // 同じ秒だと約 1/8 で終わった点検が「前回」になる（元のファイルにもある揺らぎ）。動いている行を 1 秒後の時刻で書き、順を決める。
        const createdAt = formatCompactUtcTimestamp(new Date(Date.now() + 1_000), 'test job time');
        expect(createStartingJob(database, {
          jobId: runningJobId, jobKind: 'DISCOVERY', profileId: runningProfileId, profileRevision: FIRST_REVISION, startNew: true, createdAt,
        }, () => null)).toEqual({ ok: true });
        expect(recordRunStarted(database, runningJobId, { runId: 'RUN-20261026000001' as never, runDirectory: 'RUN-20261026000001', startedAt: createdAt }))
          .toBe(true);
      });
    }, SCENARIO_TIMEOUT_MS);

    afterAll(() => {
      withDatabase((database) => {
        recordFinished(database, runningJobId, { kind: 'RAN', exitCode: 0, runId: 'RUN-20261026000001' as never, runDirectory: 'RUN-20261026000001', runStatus: 'COMPLETE' }, now());
      });
    });

    it('the list: the last run is the running job, the next step says the audit is running, and there is no "continue"', async () => {
      const page = await openPage('/');
      await page.getByTestId('profile-list').waitFor({ timeout: UI_TIMEOUT_MS });
      const row = page.locator(`tr[data-profile-id="${runningProfileId}"]`);
      expect(await row.getByTestId('last-run-state').textContent()).toBe(auditJobStateDisplay('RUNNING').label);
      expect(await row.getByTestId('last-run').locator('a').getAttribute('href')).toBe(`/jobs/${runningJobId}`);
      const next = row.getByTestId('profile-row-next');
      expect(await next.getAttribute('data-stage')).toBe('AUDIT_RUNNING');
      expect(await next.textContent()).toBe(text.listStages.AUDIT_RUNNING);
      expect(await row.getByTestId('profile-row-continue').count()).toBe(0);
      expect(await axeViolationsOf(page)).toEqual([]);
    });

    it('the site screen: the summary says the audit is running, with neither "see the result" nor "start the audit"', async () => {
      const page = await openProfile(runningProfileId);
      expect(await summaryOf(page)).toEqual({ stage: 'AUDIT_RUNNING', buttons: [], primary: [] });
      expect(await page.getByTestId('profile-stage').textContent()).toBe(text.stages.AUDIT_RUNNING);
      expect(await page.getByTestId('profile-summary').locator('[data-action="AUDIT_RESULT"], [data-action="AUDIT_START"]').count()).toBe(0);
      await expectScreenShape(page, runningProfileId);
    });
  });
});

describe('audit-send-settings-ui: AS-b', () => {
  const UI_TIMEOUT_MS = 15_000;
  const SCENARIO_TIMEOUT_MS = 120_000;
  const MAX_TAB_PRESSES = 80;
  const PROFILE_ID = 'asb-send';
  const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400 });
  const CREATED_AT = '20261019020000';
  const STARTED_AT = '20261019020001';
  const FINISHED_AT = '20261019020100';
  const PASSED_REQUESTS = 4;
  const PASSED_OTHER_ORIGIN_REQUESTS = 2;
  const PASSED_WEB_SOCKETS = 3;
  /** AS-c fix round 1: そのうち Guard の判定を通らずに開いた接続と、危険な語の接続の数。 */
  const PASSED_WEB_SOCKETS_OUTSIDE_GUARD = 2;
  const PASSED_DANGEROUS_WEB_SOCKETS = 1;
  /** 画面に出てはならない目印（`run.json` の method ごとの数の鍵に入れる）。 */
  const MARKER = 'asb-marker-not-on-screen';
  const NOTICE_PREFIX = AUDIT_SEND_TEXT.passedNotice('').split('（')[0]!;
  /** FM-3: 止めた要求で、Chromium が console に出す誤り（テストがわざと起こしたもの）。 */
  const LOAD_FAILURE_PATTERN = /^Failed to load resource: /u;

  const text = LOCAL_UI_DISPLAY_SETTINGS_TEXT;

  const { started, rootOf, contextOf, idsOf, call, setUp } = sharedUiServerKitOf(serverKit);

  const { openPage, screenshot, expectCleanAndClosePages, takeConsoleErrors } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
    maxTabPresses: MAX_TAB_PRESSES,
    screenshotDirectory: process.env['ASB_SCREENSHOT_DIR'],
  });

  const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
    const result = await call(name, method, data);
    expect(result.response.status, name).toBe(STATUS.OK);
    return result.value as T;
  };
  const profileRevision = async (): Promise<number> =>
    (await valueOf<{ profile: { revision: number } }>('getProfileFn', 'GET', { profileId: PROFILE_ID })).profile.revision;
  const storedPolicy = async (): Promise<string> =>
    (await valueOf<{ auditSendPolicy: string }>('profileDisplaySettingsFn', 'GET', { profileId: PROFILE_ID })).auditSendPolicy;
  /** FM-3: 画面が送る、表示の設定の保存の要求か（`page.route` と要求の記録の判定）。 */
  const isSaveRequest = (url: URL): boolean => isServerFunctionUrlOf(idsOf(), 'saveProfileDisplaySettingsFn', url);
  /** FM-3: `page` が送った保存の要求を数える（記録の配列を返す）。 */
  const recordSaveRequests = (page: Page): string[] => {
    const requests: string[] = [];
    page.on('request', (request) => {
      if (isSaveRequest(new URL(request.url()))) {
        requests.push(request.method());
      }
    });
    return requests;
  };

  /** 終わった監査のジョブの行と、その `run.json` を書く（テストだけの操作。ワーカーの代わり）。`auditSend` が `null` なら、項目のない古い Run。 */
  const writeFinishedAuditJob = (jobId: string, sequence: number, auditSend: RunAuditSendSummary | null): void => {
    const runId = createRunId(20261019020000 + sequence);
    const base = runSummary({ runId });
    const run: RunSummary = {
      ...base,
      safety: { ...base.safety, ...(auditSend === null ? {} : { auditSend }) },
    };
    const runDirectory = join(rootOf().root, outputDirectoryOf(PROFILE_ID), runId);
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(join(runDirectory, 'run.json'), JSON.stringify(run), 'utf8');
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      expect(createStartingJob(database, { jobId, jobKind: 'AUDIT', profileId: PROFILE_ID, profileRevision: 1, startNew: true, createdAt: CREATED_AT }, () => null))
        .toEqual({ ok: true });
      expect(recordRunStarted(database, jobId, { runId, runDirectory: runId, startedAt: STARTED_AT })).toBe(true);
      expect(recordFinished(database, jobId, { kind: 'RAN', exitCode: 0, runId, runDirectory: runId, runStatus: 'COMPLETE' }, FINISHED_AT)).toBe(true);
    } finally {
      closeControlDatabase(database);
    }
  };

  beforeAll(async () => {
    const targetConfigPath = await setUp((root) =>
      writeAuditTargetConfig(root.root, PROFILE_ID, 'http://127.0.0.1:9', { minNavigationIntervalMs: 0, screenshots: false }));
    expect(await valueOf('createProfileFn', 'POST', { profile: publicProfileDocument(PROFILE_ID, targetConfigPath) })).toMatchObject({ ok: true });
    writeFinishedAuditJob('job-asb-passed', 1, {
      // 目印は method の鍵に入れる（画面は数だけを出すので、出てはならない）。
      policy: 'PASS_EXCEPT_DELETE', passedRequests: PASSED_REQUESTS, passedRequestsByMethod: { POST: 3, [MARKER]: 1 },
      // AS-c: ほかの Origin へ通した数と、通した WebSocket の接続の数。
      passedOtherOriginRequests: PASSED_OTHER_ORIGIN_REQUESTS, passedWebSockets: PASSED_WEB_SOCKETS,
      // AS-c fix round 1: Guard の判定を通らずに開いた接続と、危険な語の接続。
      passedWebSocketsOutsideGuard: PASSED_WEB_SOCKETS_OUTSIDE_GUARD, passedDangerousWebSockets: PASSED_DANGEROUS_WEB_SOCKETS,
    });
    writeFinishedAuditJob('job-asb-read-only', 2, { policy: 'READ_ONLY', passedRequests: 0, passedRequestsByMethod: {} });
    writeFinishedAuditJob('job-asb-old', 3, null);
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  describe('AS-b: the audit send policy of a profile', () => {
    // OP-I（I1。設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.5）: サイトの既定は「サイトの通信を止めない」。読み取りだけは、人が詳しい内容で選んだときだけ。
    // 既定になったので、要点の「守りを緩めています」の印は、どちらの扱いでも出さない（作業の画面の知らせは下の describe で残す）。
    it('is PASS_EXCEPT_DELETE by default without the relaxed mark, goes to READ_ONLY (saved on the switch) without a dialog, asks before switching back and saves on the confirm only, and keeps the revision', async () => {
      const before = await profileRevision();
      expect(await storedPolicy()).toBe('PASS_EXCEPT_DELETE');
      const page = await openPage(`/profiles/${PROFILE_ID}`);
      const saveRequests = recordSaveRequests(page);
      // PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: 表示の設定の欄は、サイトの画面の詳しい内容の中。
      await openProfileAdvancedSettings(page, UI_TIMEOUT_MS);
      const panel = page.getByTestId('profile-display-settings');
      await panel.waitFor({ timeout: UI_TIMEOUT_MS });
      // FM-3: 欄に専用の保存のボタンはない。
      expect(await panel.getByRole('button').count()).toBe(0);
      const toggle = panel.getByRole('checkbox', { name: text.auditSendPassExceptDelete });
      expect(await toggle.isChecked()).toBe(true);
      expect(await page.getByTestId('profile-summary').count()).toBe(1);
      expect(await page.getByTestId('profile-audit-send-relaxed').count()).toBe(0);

      // 読み取りだけへは、ダイアログを出さず、切り替えた時点で保存される（人が選んだ読み取りだけ）。
      await toggle.click();
      expect(await page.getByRole('dialog', { name: text.auditSendDialogTitle }).isVisible()).toBe(false);
      await panel.getByTestId('profile-display-settings-saved').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await toggle.isChecked()).toBe(false);
      expect(saveRequests).toEqual(['POST']);
      saveRequests.length = 0;
      expect(await storedPolicy()).toBe('READ_ONLY');
      expect(await profileRevision()).toBe(before);
      expect(await page.getByTestId('profile-audit-send-relaxed').count()).toBe(0);

      // やめると、切り替わらず、保存の要求を送らない。
      await toggle.click();
      const dialog = page.getByRole('dialog', { name: text.auditSendDialogTitle });
      await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await dialog.textContent()).toContain(text.auditSendDialogBody);
      await screenshot(page, 'asb-10-confirm-dialog');
      await dialog.getByRole('button', { name: text.auditSendCancel, exact: true }).click();
      await expect.poll(() => dialog.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(false);
      expect(await toggle.isChecked()).toBe(false);
      expect(saveRequests).toEqual([]);
      expect(await panel.getByTestId('profile-display-settings-saved').count()).toBe(0);
      expect(await storedPolicy()).toBe('READ_ONLY');

      // 「通す」を選ぶと、切り替わり、その場で保存される（保存のボタンを押さない。プロファイルの改訂は変わらない）。
      await toggle.click();
      await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
      await dialog.getByRole('button', { name: text.auditSendConfirm, exact: true }).click();
      await expect.poll(() => dialog.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(false);
      await panel.getByTestId('profile-display-settings-saved').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await toggle.isChecked()).toBe(true);
      expect(saveRequests).toEqual(['POST']);
      expect(await storedPolicy()).toBe('PASS_EXCEPT_DELETE');
      expect(await profileRevision()).toBe(before);

      const again = await openPage(`/profiles/${PROFILE_ID}`);
      const againSaveRequests = recordSaveRequests(again);
      await openProfileAdvancedSettings(again, UI_TIMEOUT_MS);
      const reloaded = again.getByTestId('profile-display-settings');
      await reloaded.waitFor({ timeout: UI_TIMEOUT_MS });
      const reloadedToggle = reloaded.getByRole('checkbox', { name: text.auditSendPassExceptDelete });
      expect(await reloadedToggle.isChecked()).toBe(true);
      // OP-I（I1）: 通す側は既定なので、開き直しても、要点に守りを緩めている印は出さない。
      expect(await again.getByTestId('profile-summary').count()).toBe(1);
      expect(await again.getByTestId('profile-audit-send-relaxed').count()).toBe(0);
      await screenshot(again, 'asb-11-pass-except-delete');

      // 読み取りだけへ戻すときは、ダイアログを出さず、切り替えた時点で保存される。
      await reloadedToggle.click();
      expect(await again.getByRole('dialog', { name: text.auditSendDialogTitle }).isVisible()).toBe(false);
      await reloaded.getByTestId('profile-display-settings-saved').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await reloadedToggle.isChecked()).toBe(false);
      expect(againSaveRequests).toEqual(['POST']);
      expect(await storedPolicy()).toBe('READ_ONLY');
      expect(await profileRevision()).toBe(before);
      expect(await again.getByTestId('profile-audit-send-relaxed').count()).toBe(0);
    }, SCENARIO_TIMEOUT_MS);

    it('puts the switch back to READ_ONLY and shows the error when the save after the confirm fails', async () => {
      expect(await storedPolicy()).toBe('READ_ONLY');
      const page = await openPage(`/profiles/${PROFILE_ID}`);
      // PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: この欄は、サイトの画面の詳しい内容の中。
      await openProfileAdvancedSettings(page, UI_TIMEOUT_MS);
      const panel = page.getByTestId('profile-display-settings');
      await panel.waitFor({ timeout: UI_TIMEOUT_MS });
      const toggle = panel.getByRole('checkbox', { name: text.auditSendPassExceptDelete });
      // テストだけの操作: 画面が送る保存の要求を、通信の誤りで終える（Server Function の呼び出しが例外を投げる）。
      await page.route(isSaveRequest, (route) => route.abort('failed'));
      await toggle.click();
      const dialog = page.getByRole('dialog', { name: text.auditSendDialogTitle });
      await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
      await dialog.getByRole('button', { name: text.auditSendConfirm, exact: true }).click();
      const failed = panel.getByTestId('profile-display-settings-request-failed');
      await failed.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await failed.textContent()).toContain(text.requestFailed);
      // チェックは読み取りだけに戻り、また押せる。保存された扱いは読み取りだけのまま。
      expect(await toggle.isChecked()).toBe(false);
      expect(await toggle.getAttribute('data-policy')).toBe('READ_ONLY');
      expect(await toggle.isDisabled()).toBe(false);
      expect(await panel.getByTestId('profile-display-settings-saved').count()).toBe(0);
      expect(await storedPolicy()).toBe('READ_ONLY');
      await screenshot(page, 'fm3-20-audit-send-request-failed');
      // わざと起こした読み込みの誤りだけを、console の誤りの記録から外す。
      expect(takeConsoleErrors(page, LOAD_FAILURE_PATTERN).length).toBeGreaterThan(0);
    }, SCENARIO_TIMEOUT_MS);

    // 束（UI-3）: 表の案は「Server Function の表（`server-guards.test.ts`）に任せて消す」だったが、そこに `saveProfileDisplaySettingsFn` の 400 の項目がなかったので残した。
    it('keeps the input check of the save (the listed values only), and the display only save keeps the policy', async () => {
      for (const auditSendPolicy of ['PASS_ALL', '', null, true]) {
        const result = await call('saveProfileDisplaySettingsFn', 'POST', { profileId: PROFILE_ID, showJobBrowser: true, auditSendPolicy });
        expect(result.response.status, String(auditSendPolicy)).toBe(STATUS.BAD_REQUEST);
      }
      expect(await valueOf('saveProfileDisplaySettingsFn', 'POST', { profileId: PROFILE_ID, showJobBrowser: false, auditSendPolicy: 'PASS_EXCEPT_DELETE' }))
        .toEqual({ ok: true, settings: { showJobBrowser: false, auditSendPolicy: 'PASS_EXCEPT_DELETE' } });
      expect(await valueOf('saveProfileDisplaySettingsFn', 'POST', { profileId: PROFILE_ID, showJobBrowser: true }))
        .toEqual({ ok: true, settings: { showJobBrowser: true, auditSendPolicy: 'PASS_EXCEPT_DELETE' } });
      expect(await valueOf('saveProfileDisplaySettingsFn', 'POST', { profileId: PROFILE_ID, showJobBrowser: true, auditSendPolicy: 'READ_ONLY' }))
        .toEqual({ ok: true, settings: { showJobBrowser: true, auditSendPolicy: 'READ_ONLY' } });
    });
  });

  // OP-U（設計者の判断の 2）: 作業の画面には、通したことの知らせを出さない（どの扱いでも）。通した数と送り先は成果物（`run.json` の `safety.auditSend`）と報告に残す。
  describe('AS-b: the job screen does not show the passed sends', () => {
    it('shows no notice, no number and no marker for a PASS_EXCEPT_DELETE audit, a READ_ONLY audit and an old Run', async () => {
      for (const jobId of ['job-asb-passed', 'job-asb-read-only', 'job-asb-old']) {
        const page = await openPage(`/jobs/${jobId}`);
        // PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: 要点は結果の 1 行（前の表は、たたんだ詳しい内容の中）。
        await page.getByTestId('job-result').waitFor({ timeout: UI_TIMEOUT_MS });
        await page.getByTestId('job-run-status').waitFor({ timeout: UI_TIMEOUT_MS });
        for (const testId of ['job-audit-send-notice', 'job-audit-send-detail', 'job-audit-send-websocket-caution']) {
          expect(await page.getByTestId(testId).count(), `${jobId} ${testId}`).toBe(0);
        }
        const content = await page.content();
        expect(content, jobId).not.toContain(NOTICE_PREFIX);
        expect(content, jobId).not.toContain(AUDIT_SEND_TEXT.passedNotice(formatCount(PASSED_REQUESTS)));
        expect(content, jobId).not.toContain(AUDIT_SEND_TEXT.jobNotice);
        expect(content, jobId).not.toContain(MARKER);
        if (jobId === 'job-asb-passed') {
          await screenshot(page, 'asb-20-job-without-notice');
        }
      }
    }, SCENARIO_TIMEOUT_MS);
  });
});

describe('crawl-limits-ui: T44d: the crawl limits on the profile screen', () => {
  const UI_TIMEOUT_MS = 15_000;
  const SCENARIO_TIMEOUT_MS = 120_000;
  const MAX_TAB_PRESSES = 80;
  const PROFILE_ID = 't44d-limits';
  const FIXED_PROFILE_ID = 't44d-fixed';
  const TARGET_PATH = `local/targets/${PROFILE_ID}.json`;
  const OUTPUT_DIRECTORY = 't44d-limits-output';
  /** 許可 Origin（ループバックでない、予約のドメイン。接続しない）。 */
  const ORIGIN = 'https://t44d.example.test';
  // L14: ページの上限 3・時間の上限 1 時間は前の既定（読むときに「選んでいない」とみなす）なので、利用者が選んだ値として別の値を使う。
  const BEFORE = Object.freeze({ maxPages: 4, maxRuntimeMs: 1_200_000, minNavigationIntervalMs: 10_000 });
  const INTERVAL_FLOOR_MS = 1_000;
  const STATUS = Object.freeze({ BAD_REQUEST: 400 });

  const text = LOCAL_UI_CRAWL_LIMITS_TEXT;

  /** サーバの準備と Server Function の呼び出し（`helpers/ui-server.ts`）。 */
  const { started, rootOf, contextOf, call, valueOf, setUp, tearDown } = sharedUiServerKitOf(serverKit);

  const { openPage, tabTo, screenshot, expectCleanAndClosePages } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
    maxTabPresses: MAX_TAB_PRESSES,
    screenshotDirectory: process.env['T44D_SCREENSHOT_DIR'],
  });

  /** 設定のファイルの中身（ほかの項目も持つ。変えないことを確かめる）。 */
  const targetDocument = Object.freeze({
    target: { id: PROFILE_ID },
    site: { startUrl: `${ORIGIN}/admin/`, allowedOrigins: [ORIGIN] },
    crawl: { ...BEFORE, maxDepth: 4 },
    viewports: { stressWidths: [] },
    audit: { performance: false, accessibility: false, interactions: false, screenshots: false },
    output: { directory: OUTPUT_DIRECTORY },
  });

  const targetFile = (): Record<string, Record<string, unknown>> =>
    JSON.parse(readFileSync(`${rootOf().root}/${TARGET_PATH}`, 'utf8')) as Record<string, Record<string, unknown>>;

  /** 監査の負荷の欄（PL-1: サイトの画面の詳しい内容の中なので、先に開く）。 */
  const panelOf = async (page: Page): Promise<Locator> => {
    await openProfileAdvancedSettings(page, UI_TIMEOUT_MS);
    const panel = page.getByTestId('profile-crawl-limits');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    return panel;
  };
  const field = (panel: Locator, label: string): Locator => panel.getByLabel(label, { exact: true });
  /** 欄の枠（ラベル・案内・入力・誤り。`FieldFrame`）。 */
  const frameOf = (panel: Locator, name: keyof typeof text.fields): Locator =>
    panel.locator('.field', { has: panel.page().getByLabel(text.fields[name], { exact: true }) });
  const problemOf = (panel: Locator, name: keyof typeof text.fields): Locator => frameOf(panel, name).locator('.field-error');
  const hintOf = (panel: Locator, name: keyof typeof text.fields): Locator => frameOf(panel, name).locator('.field-hint');

  /** 欄に値を入れて「変更を確かめる」を押す（キーボード）。 */
  const review = async (page: Page, panel: Locator, values: Partial<Record<keyof typeof text.fields, string>>): Promise<void> => {
    for (const [name, value] of Object.entries(values)) {
      await field(panel, text.fields[name as keyof typeof text.fields]).fill(value);
    }
    await tabTo(page, panel.getByRole('button', { name: text.review }));
    await page.keyboard.press('Enter');
  };

  beforeAll(async () => {
    const fixedPath = await setUp((root) => {
      mkdirSync(`${root.root}/local/targets`, { recursive: true });
      writeFileSync(`${root.root}/${TARGET_PATH}`, `${JSON.stringify(targetDocument, null, 2)}\n`, 'utf8');
      return writeAuditTargetConfig(root.root, FIXED_PROFILE_ID, 'http://127.0.0.1:9', { minNavigationIntervalMs: 0, screenshots: false });
    });
    expect(await valueOf('createProfileFn', 'POST', { profile: publicProfileDocument(PROFILE_ID, TARGET_PATH) })).toMatchObject({ ok: true });
    expect(await valueOf('createProfileFn', 'POST', { profile: publicProfileDocument(FIXED_PROFILE_ID, fixedPath) })).toMatchObject({ ok: true });
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  afterAll(async () => {
    await tearDown();
  });

  it('rejects the values outside the range by field (the same range as validateConfig, and not shorter than the floor), and writes nothing', async () => {
    const before = readFileSync(`${rootOf().root}/${TARGET_PATH}`, 'utf8');
    const page = await openPage(`/profiles/${PROFILE_ID}`);
    const panel = await panelOf(page);
    expect(await field(panel, text.fields.maxPages).inputValue()).toBe(String(BEFORE.maxPages));
    expect(await field(panel, text.fields.maxRuntimeMs).inputValue()).toBe(String(BEFORE.maxRuntimeMs));
    expect(await field(panel, text.fields.minNavigationIntervalMs).inputValue()).toBe(String(BEFORE.minNavigationIntervalMs));
    expect(await hintOf(panel, 'minNavigationIntervalMs').textContent()).toContain(text.intervalFloor(formatDuration(INTERVAL_FLOOR_MS)));
    expect(await hintOf(panel, 'maxPages').textContent()).toContain(text.currentValue(formatCount(BEFORE.maxPages)));

    await review(page, panel, { maxPages: '0', minNavigationIntervalMs: String(INTERVAL_FLOOR_MS - 1) });
    const rejection = panel.getByTestId('crawl-limits-rejection');
    await rejection.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await rejection.getAttribute('data-reason')).toBe('CRAWL_LIMITS_INVALID');
    expect(await field(panel, text.fields.maxPages).getAttribute('aria-invalid')).toBe('true');
    expect(await field(panel, text.fields.maxRuntimeMs).getAttribute('aria-invalid')).toBe('false');
    expect(await field(panel, text.fields.minNavigationIntervalMs).getAttribute('aria-invalid')).toBe('true');
    expect(await problemOf(panel, 'maxPages').textContent()).toBe(TARGET_CRAWL_LIMIT_PROBLEM_DESCRIPTIONS.NOT_POSITIVE_INTEGER);
    expect(await problemOf(panel, 'minNavigationIntervalMs').textContent()).toBe(TARGET_CRAWL_LIMIT_PROBLEM_DESCRIPTIONS.BELOW_NAVIGATION_INTERVAL_FLOOR);
    expect(await problemOf(panel, 'maxRuntimeMs').count()).toBe(0);
    expect(await page.getByRole('dialog').count()).toBe(0);
    await screenshot(page, 't44d-10-crawl-limits-rejected');

    // 空の間隔の欄（送れないので、画面が欄に出す）と、小数（サーバが確かめる）も、書かずに欄ごとに出す。L14: ページと時間の上限の空は「指定なし」（次の場面）。
    await review(page, panel, { maxPages: String(BEFORE.maxPages), minNavigationIntervalMs: '' });
    await expect.poll(() => field(panel, text.fields.maxPages).getAttribute('aria-invalid'), { timeout: UI_TIMEOUT_MS }).toBe('false');
    expect(await problemOf(panel, 'minNavigationIntervalMs').textContent()).toBe(TARGET_CRAWL_LIMIT_PROBLEM_DESCRIPTIONS.NOT_NON_NEGATIVE_INTEGER);
    await review(page, panel, { maxRuntimeMs: '1.5', minNavigationIntervalMs: String(BEFORE.minNavigationIntervalMs) });
    await expect.poll(() => field(panel, text.fields.maxRuntimeMs).getAttribute('aria-invalid'), { timeout: UI_TIMEOUT_MS }).toBe('true');
    expect(await field(panel, text.fields.maxPages).getAttribute('aria-invalid')).toBe('false');
    expect(await page.getByRole('dialog').count()).toBe(0);

    // 同じ値は書かない（書くと、承認が外れるため）。
    await review(page, panel, { maxPages: String(BEFORE.maxPages), maxRuntimeMs: String(BEFORE.maxRuntimeMs) });
    await expect.poll(() => panel.getByTestId('crawl-limits-rejection').getAttribute('data-reason'), { timeout: UI_TIMEOUT_MS })
      .toBe('CRAWL_LIMITS_UNCHANGED');
    expect(await panel.getByTestId('crawl-limits-rejection').textContent())
      .toContain(TARGET_CRAWL_LIMITS_CHANGE_FAILURE_DESCRIPTIONS.CRAWL_LIMITS_UNCHANGED.description);
    expect(readFileSync(`${rootOf().root}/${TARGET_PATH}`, 'utf8')).toBe(before);
  }, SCENARIO_TIMEOUT_MS);

  it('shows the values before and after and the resume notice in the dialog, writes nothing on cancel, and writes the three values on confirm', async () => {
    const revision = (await valueOf<{ profile: { revision: number } }>('getProfileFn', 'GET', { profileId: PROFILE_ID })).profile.revision;
    const before = readFileSync(`${rootOf().root}/${TARGET_PATH}`, 'utf8');
    const page = await openPage(`/profiles/${PROFILE_ID}`);
    const panel = await panelOf(page);
    // L14: ページの上限の欄を空にすると「指定なし」（上限なし）。
    await review(page, panel, { maxPages: '', minNavigationIntervalMs: '2000' });
    const dialog = page.getByRole('dialog', { name: text.dialog.title });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    const rows = dialog.getByTestId('crawl-limits-change-row');
    expect(await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-field')))).toEqual(['maxPages', 'minNavigationIntervalMs']);
    expect(await rows.nth(0).locator('td').allTextContents()).toEqual([formatCount(BEFORE.maxPages), RUN_SUMMARY_TEXT.limitNotSpecified]);
    expect(await rows.nth(1).locator('td').allTextContents()).toEqual([formatDuration(BEFORE.minNavigationIntervalMs), formatDuration(2_000)]);
    // 途中の Run があれば再開されない旨は、いつも出す（探す部品は、画面のコードが読み込めない範囲にある）。
    expect(await dialog.getByTestId('crawl-limits-resume').textContent()).toBe(text.resumeNotice);
    // 公開の監査のプロファイルには、承認したシナリオがない。
    expect(await dialog.getByTestId('crawl-limits-approval').count()).toBe(0);
    expect(await dialog.getByRole('button').allTextContents()).toEqual([text.dialog.cancel, text.dialog.confirm]);
    await screenshot(page, 't44d-11-crawl-limits-dialog');
    // 開いたときのフォーカスは取り消し。取り消すと書かない。
    await page.keyboard.press('Enter');
    await expect.poll(() => dialog.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(false);
    expect(readFileSync(`${rootOf().root}/${TARGET_PATH}`, 'utf8')).toBe(before);

    await tabTo(page, panel.getByRole('button', { name: text.review }));
    await page.keyboard.press('Enter');
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    const saved = page.getByTestId('crawl-limits-saved');
    await saved.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await saved.textContent()).toBe(text.saved);
    // 変えた値だけが変わり（指定なしにしたページの上限はファイルから除く）、ほかの項目は同じ。プロファイルの改訂は変わらない。
    const { maxPages: _removed, ...crawlWithoutPages } = targetDocument.crawl;
    expect(targetFile()).toEqual({ ...targetDocument, crawl: { ...crawlWithoutPages, minNavigationIntervalMs: 2_000 } });
    expect((await valueOf<{ profile: { revision: number } }>('getProfileFn', 'GET', { profileId: PROFILE_ID })).profile.revision).toBe(revision);
    const reloaded = await panelOf(await openPage(`/profiles/${PROFILE_ID}`));
    expect(await field(reloaded, text.fields.maxPages).inputValue()).toBe('');
    expect(await hintOf(reloaded, 'maxPages').textContent()).toContain(text.currentValue(RUN_SUMMARY_TEXT.limitNotSpecified));
    await screenshot(page, 't44d-12-crawl-limits-saved');

    // 開始の画面も、新しい値と、変え方の案内を出す。
    const start = await openPage(`/start/${PROFILE_ID}`);
    // PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: 読む量の上限は、たたんだ詳しい内容の中。
    const target = start.getByTestId('start-target');
    await target.waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    expect(await target.textContent()).toContain(RUN_SUMMARY_TEXT.limitNotSpecified);
    expect(await start.getByTestId('start-interval').textContent()).toBe(formatDuration(2_000));
    expect(await target.textContent()).toContain(formatElapsedTime(BEFORE.maxRuntimeMs));
    expect(await start.getByText(LOCAL_UI_AUDIT_TEXT.start.configNote).count()).toBe(1);
  }, SCENARIO_TIMEOUT_MS);

  it('does not change a target configuration outside local/targets from the screen', async () => {
    const page = await openPage(`/profiles/${FIXED_PROFILE_ID}`);
    const panel = await panelOf(page);
    expect(await panel.getByTestId('crawl-limits-not-editable').textContent()).toBe(text.notEditable);
    expect(await panel.locator('input').count()).toBe(0);
    expect(await panel.getByRole('button').count()).toBe(0);
    const view = await valueOf<{ state: string; targetConfigDigest: string | null }>('crawlLimitsPanelFn', 'GET', { profileId: FIXED_PROFILE_ID });
    expect(view).toMatchObject({ state: 'NOT_EDITABLE', targetConfigDigest: null });
    const request = { profileId: FIXED_PROFILE_ID, expectedTargetConfigDigest: '0'.repeat(64), limits: { ...BEFORE, maxPages: 9 } };
    expect(await valueOf('saveCrawlLimitsFn', 'POST', request)).toEqual({ ok: false, reason: 'TARGET_CONFIG_NOT_EDITABLE', problems: [] });
  }, SCENARIO_TIMEOUT_MS);

  // 束（UI-3）: 表の案は「target-crawl-limits.test.ts（速い組）に同じ確かめがあれば消す」だったが、そこは部品の関数の確かめで、HTTP の 400 と
  // PROFILE_NOT_FOUND、Server Function の口の digest の確かめがなかったので残した（ブラウザを使わない場面）。
  it('checks the input of the Server Functions, the digest the screen read, and the floor without the screen', async () => {
    const view = await valueOf<{ targetConfigDigest: string; limits: typeof BEFORE }>('crawlLimitsPanelFn', 'GET', { profileId: PROFILE_ID });
    const valid = { profileId: PROFILE_ID, expectedTargetConfigDigest: view.targetConfigDigest, limits: view.limits };
    for (const [name, method] of [['previewCrawlLimitsFn', 'GET'], ['saveCrawlLimitsFn', 'POST']] as const) {
      for (const data of [
        { ...valid, expectedTargetConfigDigest: 'sha256:x' },
        { ...valid, limits: { maxPages: 1, maxRuntimeMs: 1 } },
        { ...valid, limits: { ...valid.limits, maxPages: '5' } },
        { ...valid, extra: 1 },
      ]) {
        expect((await call(name, method, data)).response.status, `${name} ${JSON.stringify(data)}`).toBe(STATUS.BAD_REQUEST);
      }
    }
    const before = readFileSync(`${rootOf().root}/${TARGET_PATH}`, 'utf8');
    expect(await valueOf('saveCrawlLimitsFn', 'POST', { ...valid, expectedTargetConfigDigest: 'a'.repeat(64), limits: { ...valid.limits, maxPages: 7 } }))
      .toEqual({ ok: false, reason: 'TARGET_CONFIG_CHANGED', problems: [] });
    expect(await valueOf('saveCrawlLimitsFn', 'POST', { ...valid, limits: { ...valid.limits, minNavigationIntervalMs: 500 } })).toEqual({
      ok: false, reason: 'CRAWL_LIMITS_INVALID', problems: [{ field: 'minNavigationIntervalMs', code: 'BELOW_NAVIGATION_INTERVAL_FLOOR' }],
    });
    expect(await valueOf('saveCrawlLimitsFn', 'POST', { ...valid, profileId: 'not-there' })).toEqual({ ok: false, reason: 'PROFILE_NOT_FOUND', problems: [] });
    expect(readFileSync(`${rootOf().root}/${TARGET_PATH}`, 'utf8')).toBe(before);
  }, SCENARIO_TIMEOUT_MS);
});

describe('credential-screens-ui: PL-4', () => {
  const IS_WINDOWS = process.platform === 'win32';
  const SKIP_REASON = 'the automated login states save the credential with the real DPAPI, which exists only on Windows';
  const UI_TIMEOUT_MS = 20_000;
  const SCENARIO_TIMEOUT_MS = 180_000;
  const MAX_PAGES = 4; // L14: 3 は前の既定と同じ値（読むときに捨てられる）なので 4。
  const FIRST_REVISION = 1;
  const TEST_ORIGIN = 'http://127.0.0.1:9';
  const TEST_HOST = new URL(TEST_ORIGIN).host;
  const LOGIN_START_URL = `${TEST_ORIGIN}/auth`;
  const ADMIN_PATH = '/admin';
  /** 手でログインしたときに観察した、ログインの欄の案（偽の観察。値は読まない）。 */
  const FIELDS = Object.freeze({ username: '#email', password: '#password', submit: '#login' });

  /** 状態ごとのサイト。 */
  const PROFILES = Object.freeze({
    switch: 'pl4-switch',
    noProposal: 'pl4-no-proposal',
    noSetup: 'pl4-no-setup',
    public: 'pl4-public',
    saved: 'pl4-saved',
    held: 'pl4-held',
    empty: 'pl4-empty',
  });

  const setupText = LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT;
  const credentialText = LOCAL_UI_CREDENTIAL_TEXT;

  /** 実行ごとの目印（値を出力しない）。 */
  const RUN = randomUUID();
  const USER = `pl4-user-${RUN}`;
  const PASS = `pl4-pass-${RUN}`;

  const { started, rootOf, contextOf, setUp } = sharedUiServerKitOf(serverKit);

  const { openPage, expectCleanAndClosePages } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
  });

  /** 管理データを開いて 1 回書く・読む（テストだけの操作）。 */
  const withDatabase = <T>(use: (database: ReturnType<typeof openControlDatabase>) => T): T => {
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      return use(database);
    } finally {
      closeControlDatabase(database);
    }
  };

  const now = (): string => formatCompactUtcTimestamp(new Date(), 'test job time');

  /** 手でログインした点検の、ログインの段の観察（欄の案つき）を持つ、終わったジョブの行を書く（ワーカーの代わり）。 */
  const writeManualLoginJob = (profileId: string): void => {
    const jobId = `job-${profileId}-${randomUUID().slice(0, 8)}`;
    withDatabase((database) => {
      const at = now();
      expect(createStartingJob(database, { jobId, jobKind: 'AUDIT', profileId, profileRevision: FIRST_REVISION, startNew: true, createdAt: at }, () => null))
        .toEqual({ ok: true });
      expect(recordAuthState(database, jobId, 'AUTHENTICATED', null, { scriptLogin: null, blockedRequests: null, observation: { loginFields: FIELDS } }))
        .toBe(true);
      expect(recordLoginCheckFinished(database, jobId, 0, at)).toBe(true);
    });
  };

  /** 自動ログインの点検が送った後に失敗した（自動ログインを止めた）ジョブの行を書く。 */
  const writeHeldAudit = (profileId: string): void => {
    const jobId = `job-${profileId}-${randomUUID().slice(0, 8)}`;
    const runId = 'RUN-20261026000000';
    withDatabase((database) => {
      const createdAt = now();
      expect(createStartingJob(database, {
        jobId, jobKind: 'AUDIT', profileId, profileRevision: FIRST_REVISION, startNew: true, createdAt, autoLoginAttempt: { credentialRevision: 1 },
      }, () => null)).toEqual({ ok: true });
      expect(recordAutoLoginResult(database, { jobId, result: 'INVALID_CREDENTIALS', submitted: 'YES', retryAfterUntil: null, at: createdAt }))
        .toMatchObject({ recorded: true });
      expect(recordRunStarted(database, jobId, { runId: runId as never, runDirectory: runId, startedAt: createdAt })).toBe(true);
      expect(recordFinished(database, jobId, { kind: 'RAN', exitCode: 0, runId: runId as never, runDirectory: runId, runStatus: 'COMPLETE' }, now()))
        .toBe(true);
    });
  };

  /** テスト用のサイトのプロファイル。 */
  const testProfileOf = (profileId: string, auth: 'MANUAL_SESSION' | 'AUTOMATED_LOGIN'): Record<string, unknown> => ({
    schemaVersion: 'beaksight-profile/1', profileId, revision: FIRST_REVISION, targetConfigPath: `config/targets/${profileId}.json`,
    environment: 'TEST', mode: 'TEST_AUTH_PASSIVE', auth, approvedTestOrigins: [TEST_ORIGIN], environmentEvidenceRef: `${profileId}-evidence`,
  });

  /** フォームで送るログインの認証の設定（入口の確かめの後に、BeakSight が案で保存した形）。`automated` なら自動ログインの欄の目印も。 */
  const formSetupOf = (profileId: string, automated: boolean): Record<string, unknown> => ({
    ...FORM_NAVIGATION_SETUP_ITEMS,
    profileId,
    profileRevision: FIRST_REVISION,
    loginStartUrl: LOGIN_START_URL,
    loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/auth' }],
    successCondition: { pathPrefix: ADMIN_PATH, selector: null },
    sessionLostCondition: { pathPrefix: '/auth' },
    excludedPaths: ['/auth/logout'],
    auditPathPrefixes: [],
    maxLoginAttempts: automated ? AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS : 1,
    allowedIdpOrigins: [],
    automatedLogin: automated
      ? {
        usernameSelector: FIELDS.username,
        passwordSelector: FIELDS.password,
        submitSelector: FIELDS.submit,
        failureConditions: { invalidCredentials: { pathPrefix: '/auth', selector: null }, accountLocked: null, mfaRequired: null, credentialExpired: null },
      }
      : null,
  });

  /** テスト用のサイトを作る（`setup` が真なら、ログインの設定も保存する）。 */
  const createTestProfile = async (profileId: string, auth: 'MANUAL_SESSION' | 'AUTOMATED_LOGIN', setup: boolean): Promise<void> => {
    writeAuthTargetConfig(rootOf().root, profileId, TEST_ORIGIN, ADMIN_PATH, MAX_PAGES);
    expect(await createProfileInStore(rootOf().root, testProfileOf(profileId, auth))).toMatchObject({ ok: true });
    if (setup) {
      expect(await saveAuthSetupInStore(rootOf().root, formSetupOf(profileId, auth === 'AUTOMATED_LOGIN'))).toMatchObject({ ok: true });
    }
  };

  /** ID とパスワードの画面を開き、要点のパネルを待つ。 */
  const openCredentials = async (profileId: string): Promise<Page> => {
    const page = await openPage(`/credentials/${profileId}`);
    await page.getByTestId('credential-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    return page;
  };

  /** main の中で見えている入力の欄の名前と、見えているボタン・リンク（ボタンの見た目）の名前。 */
  const visibleControlsOf = async (page: Page): Promise<{ readonly inputs: readonly (string | null)[]; readonly buttons: readonly string[] }> => ({
    inputs: await page.locator('main input:visible, main select:visible, main textarea:visible').evaluateAll((items) => items.map((item) => item.getAttribute('name'))),
    buttons: (await page.locator('main button:visible, main a.button:visible').allTextContents()).map((label) => label.trim()),
  });

  /** 3 章の形の共通の確かめ（主のボタン 1 つまで、axe の違反 0、見える区画の数）。 */
  const expectScreenShape = async (page: Page, label: string, sections: number): Promise<void> => {
    await expectAtMostOnePrimaryButton(page);
    expect(await axeViolationsOf(page), label).toEqual([]);
    expect(await page.locator('main > section:visible').count(), label).toBe(sections);
  };

  /** 2 章の「出さないもの」と、秒の上限の表示が、main の見える文にないこと。 */
  const expectNoTechnicalText = async (page: Page, label: string): Promise<void> => {
    const shown = await page.getByRole('main').innerText();
    for (const hidden of [TEST_ORIGIN, LOGIN_START_URL, ...Object.values(FIELDS), '300秒', '86400秒', '24時間']) {
      expect(shown, `${label}: ${hidden}`).not.toContain(hidden);
    }
  };

  beforeAll(async () => {
    await setUp();
    await createTestProfile(PROFILES.switch, 'MANUAL_SESSION', true);
    writeManualLoginJob(PROFILES.switch);
    await createTestProfile(PROFILES.noProposal, 'MANUAL_SESSION', true);
    await createTestProfile(PROFILES.noSetup, 'MANUAL_SESSION', false);
    const publicPath = writeAuditTargetConfig(rootOf().root, PROFILES.public, TEST_ORIGIN, { minNavigationIntervalMs: 0, screenshots: false });
    expect(await createProfileInStore(rootOf().root, publicProfileDocument(PROFILES.public, publicPath))).toMatchObject({ ok: true });
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  describe('PL-4: the screen to switch to the automated login (a site with the manual login)', () => {
    it('shows only the three inputs and the primary button when the three proposals are complete (no selectors, no method table, no details)', async () => {
      const page = await openCredentials(PROFILES.switch);
      const form = page.getByTestId('automated-login-setup');
      await form.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await visibleControlsOf(page)).toEqual({ inputs: ['username', 'password', 'passwordConfirmation'], buttons: [setupText.review] });
      expect(await primaryButtonLabelsInMain(page)).toEqual([setupText.review]);
      expect(await page.locator('main details').count()).toBe(0);
      expect(await page.locator('main [data-testid="automated-login-setup-selector"], main [data-testid="automated-login-setup-method"]').count()).toBe(0);
      // テスト用のアカウントだけを入れることと、ブラウザに保存させないこと（安全のために必ず見せる。7 章）。
      expect(await page.getByTestId('credential-test-account-only').textContent()).toBe(credentialText.testAccountOnlyBody);
      expect(await page.getByTestId('credential-not-eligible').count()).toBe(0);
      await expectNoTechnicalText(page, PROFILES.switch);
      await expectScreenShape(page, PROFILES.switch, 1);
    });

    it('says the automated login is not available, without inputs and without a button, when the proposals are not complete', async () => {
      const page = await openCredentials(PROFILES.noProposal);
      expect(await page.getByTestId('automated-login-setup-not-available').textContent()).toBe(setupText.notAvailable);
      expect(await visibleControlsOf(page)).toEqual({ inputs: [], buttons: [] });
      expect(await page.getByTestId('automated-login-setup-form').count()).toBe(0);
      await expectScreenShape(page, PROFILES.noProposal, 1);
    });

    it('asks for one manual audit first, with the primary button to start the audit, when the manual login site has no login setup (S4)', async () => {
      const page = await openCredentials(PROFILES.noSetup);
      const note = page.getByTestId('credential-not-eligible');
      expect(await note.getAttribute('data-kind')).toBe('MANUAL');
      expect(await note.textContent()).toBe(credentialText.notEligibleManual);
      expect(await primaryButtonLabelsInMain(page)).toEqual([LOCAL_UI_NEXT_STEP_TEXT.actions.AUDIT_START]);
      expect(await page.locator('main a.button--primary').getAttribute('href')).toBe(`/start/${PROFILES.noSetup}`);
      expect(await visibleControlsOf(page)).toEqual({ inputs: [], buttons: [LOCAL_UI_NEXT_STEP_TEXT.actions.AUDIT_START] });
      await expectScreenShape(page, PROFILES.noSetup, 1);
    });

    it('says no password is needed, without a button, for a site with the public pages only', async () => {
      const page = await openCredentials(PROFILES.public);
      const note = page.getByTestId('credential-not-eligible');
      expect(await note.getAttribute('data-kind')).toBe('PUBLIC');
      expect(await note.textContent()).toBe(credentialText.notEligiblePublic);
      expect(await visibleControlsOf(page)).toEqual({ inputs: [], buttons: [] });
      await expectScreenShape(page, PROFILES.public, 1);
    });

    it.skipIf(!IS_WINDOWS)(`confirms once with the dialog (the PL-S lines), then moves to the audit start screen (${SKIP_REASON} otherwise)`, async () => {
      const page = await openCredentials(PROFILES.switch);
      const form = page.getByTestId('automated-login-setup');
      await form.locator('input[name="username"]').fill(USER);
      await form.locator('input[name="password"]').fill(PASS);
      await form.locator('input[name="passwordConfirmation"]').fill(PASS);
      await form.getByRole('button', { name: setupText.review }).click();
      const dialog = page.getByRole('dialog', { name: setupText.dialog.title });
      await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
      // PL-S の文（パスワードを入れる先・テスト用のアカウントだけ・保存の場所・回数の決まり）は変わらない。
      expect(await dialog.getByTestId('automated-login-setup-destination').textContent()).toBe(setupText.dialog.destination(TEST_HOST));
      expect(await dialog.getByTestId('automated-login-setup-test-account').textContent()).toBe(setupText.dialog.testAccountOnly);
      expect(await dialog.getByTestId('automated-login-setup-storage').textContent()).toBe(setupText.dialog.storage);
      expect(await dialog.getByTestId('automated-login-setup-limits').count()).toBe(1);
      await expectAtMostOnePrimaryButton(page);
      await dialog.getByRole('button', { name: setupText.dialog.confirm }).click();
      // 確定の後は、点検の開始の画面へ移る（移った印と、自動ログインにした印）。保存の後の画面（変える・削除・ログインを確かめる）は出ない。
      await page.waitForURL(new RegExp(`/start/${PROFILES.switch}[?]arrived=auto&automatedLogin=setUp$`, 'u'), { timeout: UI_TIMEOUT_MS });
      // 開始の画面の中身は PL-3 の作り直しの範囲なので、描き終えたこと（読む量の表があること）だけを待つ。
      await page.getByTestId('start-target').waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
      expect(await page.getByTestId('automated-login-setup').count()).toBe(0);
      expect(await page.getByTestId('credential-done').count()).toBe(0);
      expect(await page.getByTestId('automated-login-setup-login-check-note').count()).toBe(0);
      expect(readProfileInStore(rootOf(), PROFILES.switch)?.profile).toMatchObject({ auth: 'AUTOMATED_LOGIN', revision: FIRST_REVISION + 1 });
      // 欄の目印は、観察の案のまま保存した。
      expect(withDatabase((database) => getAuthSetup(database, PROFILES.switch))?.setup.automatedLogin)
        .toMatchObject({ usernameSelector: FIELDS.username, passwordSelector: FIELDS.password, submitSelector: FIELDS.submit });
      // 値は画面に出ない。
      expect(await page.content()).not.toContain(PASS);
      expect(await page.content()).not.toContain(USER);
    });
  });

  describe('PL-4: the ID and password screen (a site with the automated login)', () => {
    beforeAll(async () => {
      if (!IS_WINDOWS) return;
      const credentials = createCredentialStore(rootOf().root);
      for (const profileId of [PROFILES.saved, PROFILES.held, PROFILES.empty]) {
        await createTestProfile(profileId, 'AUTOMATED_LOGIN', true);
      }
      for (const profileId of [PROFILES.saved, PROFILES.held]) {
        await credentials.register({ profileId, loginOrigin: TEST_ORIGIN, username: `pl4-user-${randomUUID()}`, password: `pl4-pass-${randomUUID()}` });
      }
      writeHeldAudit(PROFILES.held);
    }, SCENARIO_TIMEOUT_MS);

    it.skipIf(!IS_WINDOWS)(`saved: the summary says where it is kept, the primary button starts the audit, and the change and the removal are in the details (${SKIP_REASON} otherwise)`, async () => {
      const page = await openCredentials(PROFILES.saved);
      const saved = page.getByTestId('credential-saved');
      expect(await saved.getAttribute('data-saved')).toBe('yes');
      expect(await saved.textContent()).toBe(credentialText.summary.saved);
      expect(await page.getByTestId('credential-destination').textContent()).toBe(credentialText.summary.destination(TEST_HOST));
      expect(await page.getByTestId('credential-hold').count()).toBe(0);
      expect(await primaryButtonLabelsInMain(page)).toEqual([LOCAL_UI_NEXT_STEP_TEXT.actions.AUDIT_START]);
      expect(await visibleControlsOf(page)).toEqual({ inputs: [], buttons: [LOCAL_UI_NEXT_STEP_TEXT.actions.AUDIT_START] });
      expect(await page.locator('main a[href*="/login-check/"]').count()).toBe(0);
      const details = page.getByTestId('credential-advanced-settings');
      expect(await details.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
      expect(await page.getByTestId('credential-change-form').isVisible()).toBe(false);
      expect(await page.getByTestId('credential-remove').isVisible()).toBe(false);
      await expectNoTechnicalText(page, PROFILES.saved);
      await expectScreenShape(page, PROFILES.saved, 2);
      // 詳しい内容を開くと、変える欄と削除がある（主のボタンは増えない）。
      await openAdvancedSettings(page, 'credential-advanced-settings', UI_TIMEOUT_MS);
      expect(await page.getByTestId('credential-change-form').isVisible()).toBe(true);
      expect(await page.getByTestId('credential-remove').isVisible()).toBe(true);
      await expectAtMostOnePrimaryButton(page);
      expect(await axeViolationsOf(page)).toEqual([]);
    });

    it.skipIf(!IS_WINDOWS)(`held: the reason and what to do, no primary button, and the way to clear the hold (${SKIP_REASON} otherwise)`, async () => {
      const page = await openCredentials(PROFILES.held);
      const held = page.getByTestId('credential-hold');
      expect(await held.getAttribute('data-held')).toBe('yes');
      expect(await held.textContent()).toBe(credentialText.summary.held(AUTOMATED_LOGIN_RESULT_CATALOG.INVALID_CREDENTIALS.label));
      expect(await primaryButtonLabelsInMain(page)).toEqual([]);
      expect(await page.locator(`main a[href$="/login-check/${PROFILES.held}"]`).textContent()).toBe(LOCAL_UI_NEXT_STEP_TEXT.actions.CLEAR_HOLD);
      await expectNoTechnicalText(page, PROFILES.held);
      await expectScreenShape(page, PROFILES.held, 2);
    });

    it.skipIf(!IS_WINDOWS)(`not saved yet: the three inputs and the primary button to register them in the summary (${SKIP_REASON} otherwise)`, async () => {
      const page = await openCredentials(PROFILES.empty);
      expect(await page.getByTestId('credential-saved').getAttribute('data-saved')).toBe('no');
      expect(await page.getByTestId('credential-saved').textContent()).toBe(credentialText.summary.notSaved);
      expect(await visibleControlsOf(page)).toEqual({ inputs: ['username', 'password', 'passwordConfirmation'], buttons: [credentialText.register.submit] });
      expect(await primaryButtonLabelsInMain(page)).toEqual([credentialText.register.submit]);
      await expectNoTechnicalText(page, PROFILES.empty);
      await expectScreenShape(page, PROFILES.empty, 1);
    });
  });

  describe('PL-4: the login setup screen', () => {
    it('says the setup was saved automatically, and shows no read-only destination fields even in the details', async () => {
      const page = await openPage(`/auth-setup/${PROFILES.noProposal}`);
      const summary = page.getByTestId('auth-setup-summary');
      await summary.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await summary.getByTestId('auth-setup-summary-line').textContent()).toBe(LOCAL_UI_AUTH_TEXT.setup.summarySaved);
      expect(await page.getByTestId('auth-setup-freshness').getAttribute('data-freshness')).toBe('CURRENT');
      expect(await page.getByTestId('auth-setup-profile').count()).toBe(0);
      expect(await page.getByTestId('auth-setup-value-sources').count()).toBe(0);
      expect(await page.getByTestId('entry-check-panel').count()).toBe(0);
      await expectNoTechnicalText(page, PROFILES.noProposal);
      await expectScreenShape(page, PROFILES.noProposal, 2);
      await openAdvancedSettings(page, 'auth-setup-advanced-settings', UI_TIMEOUT_MS);
      await page.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await page.locator('main [data-testid^="auth-setup-destination-"]:not([data-testid="auth-setup-destination-locked"])').count()).toBe(0);
      expect(await page.getByTestId('auth-setup-destination-locked').textContent()).toBe(LOCAL_UI_AUTH_TEXT.setup.destinationLockedNote);
      expect(await page.getByRole('main').innerText()).not.toContain(LOGIN_START_URL);
      await expectAtMostOnePrimaryButton(page);
      expect(await axeViolationsOf(page)).toEqual([]);
    });

    it('names the entry check button the same as the site screen (re-check the entry), when the setup is not saved yet', async () => {
      const page = await openPage(`/auth-setup/${PROFILES.noSetup}`);
      await page.getByTestId('auth-setup-summary').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await page.getByTestId('auth-setup-summary-line').textContent()).toBe(LOCAL_UI_AUTH_TEXT.setup.summaryNotSaved);
      const panel = page.getByTestId('entry-check-panel');
      expect((await panel.getByTestId('entry-check-start').textContent())?.trim()).toBe(LOCAL_UI_NEXT_STEP_TEXT.actions.RECHECK_ENTRY);
      await expectAtMostOnePrimaryButton(page);
      expect(await axeViolationsOf(page)).toEqual([]);
    });

    it('guides to the same button name in the next steps of the entry check job (READ_FAILED, NAVIGATION_FAILED)', () => {
      for (const reason of ['READ_FAILED', 'NAVIGATION_FAILED'] as const) {
        expect(LOCAL_UI_JOB_NEXT_STEPS.entryCheckEndReasons[reason], reason).toContain(`「${LOCAL_UI_NEXT_STEP_TEXT.actions.RECHECK_ENTRY}」`);
      }
    });

    it.skipIf(!IS_WINDOWS)(`shows no selectors of the automated login even in the details (${SKIP_REASON} otherwise)`, async () => {
      const page = await openPage(`/auth-setup/${PROFILES.saved}`);
      await page.getByTestId('auth-setup-summary').waitFor({ timeout: UI_TIMEOUT_MS });
      await openAdvancedSettings(page, 'auth-setup-advanced-settings', UI_TIMEOUT_MS);
      await page.getByTestId('auth-setup-automated').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await page.locator('main [data-testid^="auth-setup-destination-"]:not([data-testid="auth-setup-destination-locked"])').count()).toBe(0);
      const shown = await page.getByRole('main').innerText();
      for (const selector of Object.values(FIELDS)) {
        expect(shown, selector).not.toContain(selector);
      }
      await expectAtMostOnePrimaryButton(page);
      expect(await axeViolationsOf(page)).toEqual([]);
    });
  });
});

describe('display-settings-ui: FM-1: the display setting of the job browser and the watch-only notice', () => {
  const UI_TIMEOUT_MS = 15_000;
  const SCENARIO_TIMEOUT_MS = 120_000;
  const MAX_TAB_PRESSES = 80;
  const PROFILE_ID = 'fm1-display';
  /** FM-3: 保存の要求の入力を差し替える先の、ないプロファイル（画面のサーバが `PROFILE_NOT_FOUND` で拒む）。 */
  const MISSING_PROFILE_ID = 'fm3-not-there';
  /** FM-3: 止めた・差し替えた要求で、Chromium が console に出す誤り（テストがわざと起こしたもの）。 */
  const LOAD_FAILURE_PATTERN = /^Failed to load resource: /u;
  const RUNNING_JOB_ID = 'job-fm1-running';
  const ENDED_JOB_ID = 'job-fm1-ended';
  const JOB_CREATED_AT = '20261019010000';
  const JOB_ENDED_AT = '20261019011000';
  const STATUS = Object.freeze({ BAD_REQUEST: 400 });

  const text = LOCAL_UI_DISPLAY_SETTINGS_TEXT;

  /** サーバの準備と Server Function の呼び出し（`helpers/ui-server.ts`）。 */
  const { started, rootOf, contextOf, idsOf, call, valueOf, setUp, tearDown } = sharedUiServerKitOf(serverKit);

  const { openPage, screenshot, expectCleanAndClosePages, takeConsoleErrors } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
    maxTabPresses: MAX_TAB_PRESSES,
    screenshotDirectory: process.env['FM1_SCREENSHOT_DIR'],
  });
  const profileRevision = async (): Promise<number> =>
    (await valueOf<{ profile: { revision: number } }>('getProfileFn', 'GET', { profileId: PROFILE_ID })).profile.revision;
  const storedSettings = (): Promise<ProfileDisplaySettings> => valueOf<ProfileDisplaySettings>('profileDisplaySettingsFn', 'GET', { profileId: PROFILE_ID });
  /** FM-3: 画面が送る、表示の設定の保存の要求か（`page.route` の判定）。 */
  const isSaveRequest = (url: URL): boolean => isServerFunctionUrlOf(idsOf(),'saveProfileDisplaySettingsFn', url);

  /** FM-3: プロファイルの画面を開き、表示の設定の欄と、ジョブのブラウザのチェックを返す。 */
  const openDisplaySettings = async (): Promise<{ page: Page; panel: Locator; toggle: Locator }> => {
    const page = await openPage(`/profiles/${PROFILE_ID}`);
    // PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: この欄は、サイトの画面の詳しい内容の中。
    await openProfileAdvancedSettings(page, UI_TIMEOUT_MS);
    const panel = page.getByTestId('profile-display-settings');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    return { page, panel, toggle: panel.getByRole('checkbox', { name: text.showJobBrowser }) };
  };

  /** テストだけの操作: 動いている監査のジョブの行と、終わった行を書く（ワーカーの代わり）。 */
  const writeJobs = (): void => {
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      for (const jobId of [ENDED_JOB_ID, RUNNING_JOB_ID]) {
        expect(createStartingJob(database, { jobId, jobKind: 'AUDIT', profileId: PROFILE_ID, profileRevision: 1, startNew: true, createdAt: JOB_CREATED_AT }, () => null))
          .toEqual({ ok: true });
        if (jobId === ENDED_JOB_ID) {
          expect(recordEnded(database, jobId, { state: 'FAILED', reason: 'WORKER_START_FAILED', exitCode: null, at: JOB_ENDED_AT })).toBe(true);
        }
      }
    } finally {
      closeControlDatabase(database);
    }
  };

  beforeAll(async () => {
    const targetConfigPath = await setUp((root) =>
      writeAuditTargetConfig(root.root, PROFILE_ID, 'http://127.0.0.1:9', { minNavigationIntervalMs: 0, screenshots: false }));
    expect(await valueOf('createProfileFn', 'POST', { profile: publicProfileDocument(PROFILE_ID, targetConfigPath) })).toMatchObject({ ok: true });
    writeJobs();
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  afterAll(async () => {
    // 束: 動いている行（`RUNNING_JOB_ID`）を終わった状態にする（ジョブは同時に 1 つなので、後の describe の行の作成に当たらないように）。
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      recordEnded(database, RUNNING_JOB_ID, { state: 'FAILED', reason: 'WORKER_START_FAILED', exitCode: null, at: JOB_ENDED_AT });
    } finally {
      closeControlDatabase(database);
    }
    await tearDown();
  });

  it('shows the job browser by default, warns not to operate it on a running job, and not on an ended job', async () => {
    const profile = await openPage(`/profiles/${PROFILE_ID}`);
    // PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: この欄は、サイトの画面の詳しい内容の中。
    await openProfileAdvancedSettings(profile, UI_TIMEOUT_MS);
    const panel = profile.getByTestId('profile-display-settings');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await panel.getByRole('checkbox', { name: text.showJobBrowser }).isChecked()).toBe(true);
    await screenshot(profile, 'fm1-10-display-settings');
    const running = await openPage(`/jobs/${RUNNING_JOB_ID}`);
    const notice = running.getByTestId('job-browser-watch-only');
    await notice.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await notice.textContent()).toContain(text.watchOnly);
    const ended = await openPage(`/jobs/${ENDED_JOB_ID}`);
    // PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: 要点は結果の 1 行（前の表は、たたんだ詳しい内容の中）。
    await ended.getByTestId('job-result').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await ended.getByTestId('job-browser-watch-only').count()).toBe(0);
  }, SCENARIO_TIMEOUT_MS);

  it('saves the setting on the switch itself (no save button, the switches are disabled while saving) without changing the profile revision, and the running job shows no notice when the browser is hidden', async () => {
    const before = await profileRevision();
    const { page, panel, toggle } = await openDisplaySettings();
    // FM-3: 欄に専用の保存のボタンはない。切り替えるとすぐ保存すること（プロファイルの保存とは別）を、欄の説明に出す。
    expect(await panel.getByRole('button').count()).toBe(0);
    expect(await panel.textContent()).toContain(text.autoSaveNote);
    // 保存の要求を止めておき、保存の間は、どちらのチェックも押せないことを確かめる（テストだけの操作）。
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const hold = async (route: Route): Promise<void> => {
      await held;
      await route.continue();
    };
    await page.route(isSaveRequest, hold);
    await toggle.click();
    await expect.poll(() => toggle.isDisabled(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await panel.getByRole('checkbox', { name: text.auditSendPassExceptDelete }).isDisabled()).toBe(true);
    expect(await panel.getByTestId('profile-display-settings-saving').textContent()).toBe(text.saving);
    expect(await panel.getByTestId('profile-display-settings-saved').count()).toBe(0);
    release();
    // 切り替えるだけで保存される（ボタンを押さない）。
    const saved = panel.getByTestId('profile-display-settings-saved');
    await saved.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await saved.textContent()).toBe(text.saved);
    await page.unroute(isSaveRequest, hold);
    expect(await toggle.isDisabled()).toBe(false);
    expect(await toggle.isChecked()).toBe(false);
    // 保存の後も、切り替えたチェックにフォーカスが残る（キーボードで続けて操作できる）。
    expect(await toggle.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await panel.getByTestId('profile-display-settings-saving').count()).toBe(0);
    // OP-I（I1）: 送信の扱いは、サイトの既定（サイトの通信を止めない）のまま保存される。
    expect(await storedSettings()).toEqual({ showJobBrowser: false, auditSendPolicy: 'PASS_EXCEPT_DELETE' });
    expect(await profileRevision()).toBe(before);
    await screenshot(page, 'fm3-10-saved-on-switch');
    const again = await openPage(`/profiles/${PROFILE_ID}`);
    // PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: この欄は、サイトの画面の詳しい内容の中。
    await openProfileAdvancedSettings(again, UI_TIMEOUT_MS);
    const reloaded = again.getByTestId('profile-display-settings');
    await reloaded.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await reloaded.getByRole('checkbox', { name: text.showJobBrowser }).isChecked()).toBe(false);
    const running = await openPage(`/jobs/${RUNNING_JOB_ID}`);
    await running.getByTestId('job-result').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await running.getByTestId('job-browser-watch-only').count()).toBe(0);
  }, SCENARIO_TIMEOUT_MS);

  it('puts the switch back and shows the reason when the save is rejected, and keeps the stored setting', async () => {
    const stored = await storedSettings();
    const { page, panel, toggle } = await openDisplaySettings();
    expect(await toggle.isChecked()).toBe(stored.showJobBrowser);
    // テストだけの操作: 画面が送る保存の要求の入力を、ないプロファイルに差し替える（画面のサーバが PROFILE_NOT_FOUND で拒む）。
    await page.route(isSaveRequest, (route) =>
      route.continue({ postData: encodeServerFunctionPayload({ profileId: MISSING_PROFILE_ID, showJobBrowser: !stored.showJobBrowser }) }));
    await toggle.click();
    const rejection = panel.getByTestId('profile-display-settings-rejection');
    await rejection.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await rejection.getAttribute('data-reason')).toBe('PROFILE_NOT_FOUND');
    expect(await rejection.textContent()).toContain(text.rejected);
    expect(await rejection.textContent()).toContain(text.reasons.PROFILE_NOT_FOUND);
    // チェックは元の値に戻り、また押せる。「保存しました」は出さない。
    expect(await toggle.isChecked()).toBe(stored.showJobBrowser);
    expect(await toggle.isDisabled()).toBe(false);
    expect(await panel.getByTestId('profile-display-settings-saved').count()).toBe(0);
    expect(await storedSettings()).toEqual(stored);
    await screenshot(page, 'fm3-11-rejected');
  }, SCENARIO_TIMEOUT_MS);

  it('puts the switch back and shows the error when the save throws (an input check error and a communication error)', async () => {
    const failures: readonly { readonly name: string; readonly fail: (route: Route) => Promise<void> }[] = [
      // テストだけの操作: 入力を、検証で拒まれる形に差し替える（画面のサーバが 400 を返し、Server Function の呼び出しが例外を投げる）。
      { name: 'input check', fail: (route) => route.continue({ postData: encodeServerFunctionPayload({ profileId: PROFILE_ID, showJobBrowser: 'yes' }) }) },
      // テストだけの操作: 要求を通信の誤りで終える（Server Function の呼び出しが例外を投げる）。
      { name: 'communication', fail: (route) => route.abort('failed') },
    ];
    for (const { name, fail } of failures) {
      const stored = await storedSettings();
      const { page, panel, toggle } = await openDisplaySettings();
      await page.route(isSaveRequest, fail);
      await toggle.click();
      const failed = panel.getByTestId('profile-display-settings-request-failed');
      await failed.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await failed.textContent(), name).toContain(text.rejected);
      expect(await failed.textContent(), name).toContain(text.requestFailed);
      expect(await toggle.isChecked(), name).toBe(stored.showJobBrowser);
      expect(await toggle.isDisabled(), name).toBe(false);
      expect(await panel.getByTestId('profile-display-settings-saved').count(), name).toBe(0);
      expect(await panel.getByTestId('profile-display-settings-rejection').count(), name).toBe(0);
      expect(await storedSettings(), name).toEqual(stored);
      await screenshot(page, `fm3-12-request-failed-${name.replaceAll(' ', '-')}`);
      // わざと起こした読み込みの誤りだけを、console の誤りの記録から外す（ほかの誤りは、各テストの後の確かめで誤りになる）。
      expect(takeConsoleErrors(page, LOAD_FAILURE_PATTERN).length, name).toBeGreaterThan(0);
    }
  }, SCENARIO_TIMEOUT_MS);

  it('keeps the input check of the save', async () => {
    for (const data of [{ profileId: PROFILE_ID, showJobBrowser: 'yes' }, { profileId: PROFILE_ID }, { profileId: PROFILE_ID, showJobBrowser: true, extra: 1 }]) {
      expect((await call('saveProfileDisplaySettingsFn', 'POST', data)).response.status, JSON.stringify(data)).toBe(STATUS.BAD_REQUEST);
    }
    expect(await valueOf('saveProfileDisplaySettingsFn', 'POST', { profileId: 'not-there', showJobBrowser: true })).toEqual({ ok: false, reason: 'PROFILE_NOT_FOUND' });
  });

  // DN-1（設計書 `2026-11-16-beaksight-profile-display-name-design.md` 3 章）: 画面に出す名前を変えると、一覧・題・作業の履歴に出る（印と改訂は
  // 変わらない）。空・長すぎは理由の文を出して保存しない（改行は、1 行の入力の欄に入らない。決まりは管理データの単体）。この describe の最後に置く。
  it('DN-1: saves the display name, shows it on the list, the title and the jobs, and explains an empty or too long name', async () => {
    const nameText = LOCAL_UI_DISPLAY_NAME_TEXT;
    const NAME = 'テストの店';
    const revision = await profileRevision();
    const page = await openPage(`/profiles/${PROFILE_ID}`);
    await openProfileAdvancedSettings(page, UI_TIMEOUT_MS);
    const panel = page.getByTestId('profile-display-name');
    const input = panel.getByLabel(nameText.label);
    expect(await input.inputValue()).toBe(PROFILE_ID);
    for (const [value, reason] of [['  ', 'DISPLAY_NAME_EMPTY'], ['あ'.repeat(81), 'DISPLAY_NAME_TOO_LONG']] as const) {
      await input.fill(value);
      await panel.getByRole('button', { name: nameText.save }).click();
      await panel.getByText(nameText.reasons[reason]).waitFor({ timeout: UI_TIMEOUT_MS });
    }
    await input.fill(NAME);
    await panel.getByRole('button', { name: nameText.save }).click();
    await panel.getByTestId('profile-display-name-saved').waitFor({ timeout: UI_TIMEOUT_MS });
    await page.getByRole('heading', { level: 1, name: NAME }).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await profileRevision()).toBe(revision);
    const list = await openPage('/');
    expect(await list.locator(`tr[data-profile-id="${PROFILE_ID}"] th`).textContent()).toBe(NAME);
    const jobs = await openPage('/jobs');
    expect(await jobs.getByTestId('job-list').getByText(NAME).count()).toBe(2);
  });
});

describe('page-frame-ui: PL-V', () => {
  const UI_TIMEOUT_MS = 15_000;
  const SCENARIO_TIMEOUT_MS = 120_000;
  const PROFILE_ID = 'plv-frame';
  const JOB_ID = 'job-plv-discovery';
  const RUN_ID = 'RUN-20261026000000';

  const text = LOCAL_UI_TEXT;

  const { started, rootOf, contextOf, setUp } = sharedUiServerKitOf(serverKit);

  const { openPage, expectCleanAndClosePages } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
    requireCspRecord: true,
  });

  /** テストだけの操作: 動いている発見のジョブの行を書く（ワーカーの代わり）。 */
  const writeRunningDiscoveryJob = (): void => {
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      const now = formatCompactUtcTimestamp(new Date(), 'test job time');
      expect(createStartingJob(database, { jobId: JOB_ID, jobKind: 'DISCOVERY', profileId: PROFILE_ID, profileRevision: 1, startNew: true, createdAt: now }, () => null))
        .toEqual({ ok: true });
      expect(recordRunStarted(database, JOB_ID, { runId: RUN_ID as never, runDirectory: RUN_ID, startedAt: now })).toBe(true);
    } finally {
      closeControlDatabase(database);
    }
  };

  /** 今どこにいるかの 1 行のリンクの名前（上から順）と、今の画面の名前。1 行がないときは null。 */
  const trailOf = async (page: Page): Promise<{ readonly links: readonly string[]; readonly current: string | null } | null> => {
    const line = page.getByTestId('page-context');
    if (await line.count() === 0) {
      return null;
    }
    return {
      links: await line.getByRole('link').allTextContents(),
      current: await line.locator('[aria-current="page"]').textContent(),
    };
  };

  /** 本文に、前の戻るボタンの形（「〜に戻る」）のリンクがない。 */
  const expectNoBackButtons = async (page: Page, path: string): Promise<void> => {
    expect(await backLinkCountInMain(page), path).toBe(0);
  };

  beforeAll(async () => {
    const targetConfigPath = await setUp((root) =>
      writeAuditTargetConfig(root.root, PROFILE_ID, 'http://127.0.0.1:9', { minNavigationIntervalMs: 0, screenshots: false }));
    expect(await createProfileInStore(rootOf().root, publicProfileDocument(PROFILE_ID, targetConfigPath))).toMatchObject({ ok: true });
    writeRunningDiscoveryJob();
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  afterAll(() => {
    // 束: 動いている発見の行を終わった状態にする（ジョブは同時に 1 つ）。
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      recordFinished(database, JOB_ID, { kind: 'RAN', exitCode: 0, runId: RUN_ID as never, runDirectory: RUN_ID, runStatus: 'COMPLETE' },
        formatCompactUtcTimestamp(new Date(), 'test job time'));
    } finally {
      closeControlDatabase(database);
    }
  });

  describe('PL-V: the shared menu (13 の 14)', () => {
    it('has the three items, and no environment item while the environment has no problem; the environment screen still opens', async () => {
      const page = await openPage('/');
      const navigation = page.getByRole('navigation', { name: text.navigationLabel });
      expect(await navigation.getByRole('link').allTextContents()).toEqual([text.pages.profiles, text.pages.newProfile, LOCAL_UI_AUDIT_TEXT.pages.jobs]);
      expect(await navigation.getByText(LOCAL_UI_FRAME_TEXT.environmentProblem).count()).toBe(0);
      const environment = await openPage('/environment');
      await environment.getByTestId('environment-status').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await environment.getByRole('navigation', { name: text.navigationLabel }).getByRole('link').count()).toBe(3);
    });
  });

  describe('PL-V: the line of where you are, above the h1 (13 の 4)', () => {
    const sitesAndSite = [text.pages.profiles, PROFILE_ID];
    const cases: readonly { readonly path: string; readonly links: readonly string[] | null; readonly title: string }[] = [
      { path: '/', links: null, title: text.pages.profiles },
      { path: '/jobs', links: null, title: LOCAL_UI_AUDIT_TEXT.pages.jobs },
      { path: '/profiles/new', links: [text.pages.profiles], title: text.pages.newProfile },
      // サイトの画面の題は、サイトの名前。
      { path: `/profiles/${PROFILE_ID}`, links: [text.pages.profiles], title: PROFILE_ID },
      { path: `/start/${PROFILE_ID}`, links: sitesAndSite, title: LOCAL_UI_AUDIT_TEXT.pages.startAudit },
      { path: `/discovery/${PROFILE_ID}`, links: sitesAndSite, title: LOCAL_UI_DISCOVERY_TEXT.pages.discovery },
      { path: `/read-checks/${PROFILE_ID}`, links: sitesAndSite, title: LOCAL_UI_READ_CHECK_TEXT.pages.readChecks },
      { path: `/read-checks/${PROFILE_ID}/new`, links: [...sitesAndSite, LOCAL_UI_READ_CHECK_TEXT.pages.readChecks], title: LOCAL_UI_READ_CHECK_TEXT.pages.newReadCheck },
      { path: `/scenarios/${PROFILE_ID}`, links: sitesAndSite, title: LOCAL_UI_SCENARIO_TEXT.pages.scenarios },
      { path: `/ledger/${PROFILE_ID}`, links: sitesAndSite, title: LOCAL_UI_LEDGER_TEXT.pages.ledger },
      // 作業の画面の題は、作業の種類。
      { path: `/jobs/${JOB_ID}`, links: sitesAndSite, title: AUDIT_JOB_KIND_CATALOG.DISCOVERY.label },
    ];

    it.each(cases)('$path: the line, the title, and no back button at the bottom', async ({ path, links, title }) => {
      const page = await openPage(path);
      expect(await page.locator('h1').textContent(), path).toBe(title);
      expect(await trailOf(page), path).toEqual(links === null ? null : { links, current: title });
      await expectNoBackButtons(page, path);
    });

    it('goes to the site screen from the line', async () => {
      const page = await openPage(`/start/${PROFILE_ID}`);
      // 画面の形の補助（PL-1〜4 が使う）: 公開のプロファイルの開始の画面の主のボタンは 1 つ。
      expect(await primaryButtonLabelsInMain(page)).toEqual([LOCAL_UI_AUDIT_TEXT.start.submit]);
      await expectAtMostOnePrimaryButton(page);
      await page.getByTestId('page-context').getByRole('link', { name: PROFILE_ID, exact: true }).click();
      await page.waitForURL(new RegExp(`/profiles/${PROFILE_ID}$`, 'u'), { timeout: UI_TIMEOUT_MS });
      await expect.poll(() => page.locator('h1').textContent(), { timeout: UI_TIMEOUT_MS }).toBe(PROFILE_ID);
    });
  });

  describe('PL-V: the focus after an automatic move (13 章の最後の段落)', () => {
    const focusedTag = (page: Page): Promise<string | null> => page.evaluate(() => document.activeElement?.tagName ?? null);

    it('puts the focus on the h1 when the screen has the arrival mark, and not otherwise', async () => {
      const arrived = await openPage(`/profiles/${PROFILE_ID}?arrived=auto`);
      await expect.poll(() => focusedTag(arrived), { timeout: UI_TIMEOUT_MS }).toBe('H1');
      const plain = await openPage(`/profiles/${PROFILE_ID}`);
      expect(await focusedTag(plain)).not.toBe('H1');
    });
  });

  describe('PL-V: the job screen (13 の 10, 7)', () => {
    it('has one aria-live region only, the summary; the stop confirm looks dangerous', async () => {
      const page = await openPage(`/jobs/${JOB_ID}`);
      await page.locator('[data-testid="job-state"][data-state="RUNNING"]').waitFor({ timeout: UI_TIMEOUT_MS });
      const live = page.locator('main [aria-live]');
      expect(await live.count()).toBe(1);
      expect(await live.first().getAttribute('data-testid')).toBe('job-summary-panel');
      const target = AUDIT_JOB_STOP_TARGET_NAMES.DISCOVERY;
      await page.getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.job.stop(target), exact: true }).click();
      const dialog = page.getByRole('dialog', { name: LOCAL_UI_AUDIT_TEXT.stopDialog.title(target) });
      await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
      const confirm = dialog.getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.stopDialog.confirm(target), exact: true });
      expect(await confirm.getAttribute('data-confirm-tone')).toBe('danger');
      expect(await confirm.getAttribute('class')).toContain('button--danger');
      // 画面の形の補助（PL-1〜4 が使う）: 開いたダイアログの間は、ダイアログの中だけを数える（止める確定は危険の見た目なので、主のボタンは 0）。
      expect(await primaryButtonLabelsInMain(page)).toEqual([]);
      await dialog.getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.stopDialog.cancel, exact: true }).click();
    });
  });
});

describe('束の最後: ui-flows: local UI: profiles (restart)', () => {
  /** フォーカスを Tab で動かす回数の上限。 */
  const MAX_TAB_PRESSES = 40;
  const PROFILE_ID = 'ui-flows-example-test';

  const { started: sharedStarted, rootOf, contextOf } = sharedUiServerKitOf(serverKit);
  /** 束: 共有のサーバを止めた後に、同じ一時の root で起動し直したサーバと、その Cookie を持つ context。 */
  let restarted: StartedServer | undefined;
  let context: BrowserContext | undefined;
  const started = (): StartedServer => {
    if (restarted === undefined) {
      throw new Error('サーバが起動していない');
    }
    return restarted;
  };

  const { openPage, expectCleanAndClosePages } = createUiPageKit({
    contextOf: () => context,
    originOf: () => started().origin,
    maxTabPresses: MAX_TAB_PRESSES,
    requireCspRecord: true,
  });

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  afterAll(async () => {
    await context?.close();
    await stopServer(restarted);
  });

  it('keeps the profiles after the server restarts', async () => {
    // 束: 共有のサーバを止め、同じ一時の root で起動し直す（共有の Chromium で新しい context を作り、token の URL から開く）。
    await stopServer(sharedStarted());
    restarted = await startLauncher(rootOf(), await findFreePort());
    const browser = contextOf()?.browser();
    if (browser === undefined || browser === null) {
      throw new Error('共有の Chromium がない');
    }
    context = await browser.newContext();
    // token の URL から開いて cookie を受け取る（303 で token のない URL へ移る）。
    const tokenPage = await context.newPage();
    await tokenPage.goto(restarted.tokenUrl.href, { waitUntil: 'networkidle' });
    expect(tokenPage.url()).toBe(`${restarted.origin}/`);
    await tokenPage.close();
    const page = await openPage('/');
    const row = page.locator(`tr[data-profile-id="${PROFILE_ID}"]`);
    await row.waitFor();
    expect(await row.getByTestId('profile-row-next').getAttribute('data-stage')).toBe('SITE_RETIRED');
    expect(await row.textContent()).toContain(LOCAL_UI_NEXT_STEP_TEXT.listStages.SITE_RETIRED);
  });
});

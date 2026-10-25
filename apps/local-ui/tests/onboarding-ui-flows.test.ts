/**
 * T43a（Task 43 の設計書 4.1、5 章の 1）: プロファイルの作成から監査の開始まで、画面の中のリンクだけで進めることの確かめ。ビルドした画面を一時の root の
 * 起動の部品で起動し、Playwright の headless の Chromium（`tests/helpers/chromium.ts` の既定）で、token の URL から開く。
 * - 左のメニューの「新しいプロファイル」。作成の欄: 公開のモードでは、テスト環境の Origin・承認したサービスの Origin・確かめた記録の参照の欄を隠し、
 *   隠した欄の値は送らない（テストの環境のモードを選ぶと出る）。
 * - プロファイルの詳細の「次にすること」（済み・要る・要らない・古い（直す）と、直す画面へのリンク）と「監査を始める」（始められないときは押せない形と
 *   理由）。一覧の、始められない理由の短い文。
 * - 認証の設定の保存の後の次の手順のリンク。プロファイルを直した後に、認証の設定が「古い」になったことを詳細で示す。
 * - 「開始の URL だけ」の流れは T43b なので、ここでは今の「設定のファイルを選ぶ」で、作成 → 詳細 → 監査の開始の画面まで、リンクだけでたどる。
 * - 監査は始めない（サイトに接続しない。テスト環境の Origin は 127.0.0.1 の使っていない番号で、どこにも接続しない）。すべての画面で、CSP の違反と
 *   console の誤りが 0 件、外部への要求が 0 件。
 */
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NEXT_STEP_STATE_CATALOG, PROFILE_NEXT_STEP_CATALOG } from '../../../src/presentation/catalog.js';
import {
  AUDIT_JOB_START_REJECTION_DESCRIPTIONS,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_NEXT_STEP_TEXT,
  LOCAL_UI_SCRIPT_LOGIN_TEXT,
  LOCAL_UI_TEXT,
} from '../../../src/presentation/messages.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
import { nextStepStatesOf } from './helpers/next-steps.ts';
import { chooseExistingTargetConfig } from './helpers/profile-form.ts';
import {
  EXAMPLE_TARGET_CONFIG,
  createTemporaryUiRoot,
  findFreePort,
  parseSetCookie,
  rawRequest,
  startLauncher,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

/** 画面の操作を待つ上限（ミリ秒）。 */
const UI_TIMEOUT_MS = 15_000;
/** フォーカスを Tab で動かす回数の上限。 */
const MAX_TAB_PRESSES = 60;
const FIRST_REVISION = 1;

/** テストの値（匿名）。テスト環境の Origin は、使っていない 127.0.0.1 の番号（接続しない）。 */
const PUBLIC_PROFILE = 't43a-public';
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

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();

const started = (): StartedServer => {
  if (server === undefined) {
    throw new Error('サーバが起動していない');
  }
  return server;
};

/** 記録つきのページ（CSP の違反、console の誤り、外部への要求。CCX-16 の共通の補助）と、Tab だけのフォーカスの移動。 */
const { openPage, tabTo, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  requireCspRecord: true,
});

/** Server Function を呼び、200 の値を返す。 */
const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
  expect(result.response.status, `${name} ${result.response.body.slice(0, 200)}`).toBe(200);
  return result.value as T;
};

/** 認証のプロファイルの文書（テスト環境。ターゲット設定は一時の root に書く）。 */
const testProfileDocument = (
  profileId: string,
  mode: 'TEST_AUTH_PASSIVE' | 'TEST_APPROVED_WRITE',
  auth: 'MANUAL_SESSION' | 'AUTOMATED_LOGIN',
): Record<string, unknown> => ({
  schemaVersion: 'beaksight-profile/1',
  profileId,
  revision: FIRST_REVISION,
  targetConfigPath: writeAuthTargetConfig(root?.root ?? '', profileId, TEST_ORIGIN, ADMIN_PATH, 1),
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

/** 「次にすること」の欄の、手順の行。 */
const stepRow = (page: Page, step: keyof typeof PROFILE_NEXT_STEP_CATALOG): Locator =>
  page.getByTestId('profile-next-steps').locator(`tr[data-step="${step}"]`);

/** 「次にすること」の欄の、手順の順の状態（共用の補助 `nextStepStatesOf`）。 */
const stepStates = (page: Page): Promise<readonly (string | null)[]> => nextStepStatesOf(page, UI_TIMEOUT_MS);

/** プロファイルの詳細の「監査を始める」の欄。 */
const auditStart = (page: Page): Locator => page.getByTestId('profile-audit-start');

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  expect(page.url()).toBe(`${server.origin}/`);
  await page.close();
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  expect(await valueOf('createProfileFn', 'POST', { profile: testProfileDocument(MANUAL_PROFILE, 'TEST_AUTH_PASSIVE', 'MANUAL_SESSION') }))
    .toMatchObject({ ok: true });
  expect(await valueOf('createProfileFn', 'POST', { profile: testProfileDocument(AUTOMATED_PROFILE, 'TEST_AUTH_PASSIVE', 'AUTOMATED_LOGIN') }))
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

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  root?.remove();
});

describe('T43a: from creating a profile to starting the audit, inside the screens', () => {
  it('has "new profile" in the left menu, and marks it as the current page on the form', async () => {
    const page = await openPage('/');
    const navigation = page.getByRole('navigation', { name: text.navigationLabel });
    expect(await navigation.getByRole('link').allTextContents())
      .toEqual([text.pages.profiles, text.pages.newProfile, LOCAL_UI_AUDIT_TEXT.pages.jobs, text.pages.environment]);
    await tabTo(page, navigation.getByRole('link', { name: text.pages.newProfile }));
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/profiles\/new$/u, { timeout: UI_TIMEOUT_MS });
    await page.getByLabel(text.profileForm.profileId).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await navigation.getByRole('link', { name: text.pages.newProfile }).getAttribute('aria-current')).toBe('page');
    expect(await navigation.getByRole('link', { name: text.pages.profiles }).getAttribute('aria-current')).toBeNull();
  });

  it('hides the test environment fields in the public mode and does not send them, then reaches the start screen by links only', async () => {
    const page = await openPage('/');
    await page.getByRole('navigation', { name: text.navigationLabel }).getByRole('link', { name: text.pages.newProfile }).click();
    await page.waitForURL(/\/profiles\/new$/u, { timeout: UI_TIMEOUT_MS });
    const testOrigins = page.getByLabel(text.profileForm.approvedTestOrigins);
    const evidence = page.getByLabel(text.profileForm.environmentEvidenceRef);
    const serviceOrigins = page.getByLabel(LOCAL_UI_SCRIPT_LOGIN_TEXT.profile.approvedServiceOrigins);
    await page.getByLabel(text.profileForm.profileId).waitFor({ timeout: UI_TIMEOUT_MS });
    // 公開のモード（初めの値）では、テスト環境の欄を出さない。
    expect([await testOrigins.count(), await evidence.count(), await serviceOrigins.count()]).toEqual([0, 0, 0]);
    // テストの環境のモードを選ぶと出る。値を入れてから公開のモードに戻すと、また隠れる。
    await page.getByLabel(text.profileForm.mode).selectOption('TEST_AUTH_PASSIVE');
    await testOrigins.waitFor({ timeout: UI_TIMEOUT_MS });
    expect([await testOrigins.count(), await evidence.count(), await serviceOrigins.count()]).toEqual([1, 1, 1]);
    await testOrigins.fill(TEST_ORIGIN);
    await evidence.fill('t43a-hidden-evidence');
    await page.getByLabel(text.profileForm.mode).selectOption('PUBLIC_PASSIVE');
    await testOrigins.waitFor({ state: 'detached', timeout: UI_TIMEOUT_MS });
    expect([await testOrigins.count(), await evidence.count(), await serviceOrigins.count()]).toEqual([0, 0, 0]);

    // 保存する（隠した欄の値を送れば、公開の環境のプロファイルでは Task 22 の検証が拒む）。
    await page.getByLabel(text.profileForm.profileId).fill(PUBLIC_PROFILE);
    // T43b: 作成の画面の既定は「開始の URL から新しく作る」。この流れは、すでにある設定のファイルを選ぶ（開始の URL だけの流れは
    // `start-url-onboarding-ui.test.ts`）。
    await chooseExistingTargetConfig(page, EXAMPLE_TARGET_CONFIG, UI_TIMEOUT_MS);
    await page.getByText(text.profileForm.configOk).waitFor({ timeout: UI_TIMEOUT_MS });
    await page.getByRole('button', { name: text.profileForm.save }).click();
    await page.waitForURL(new RegExp(`/profiles/${PUBLIC_PROFILE}`, 'u'), { timeout: UI_TIMEOUT_MS });
    await page.getByText(text.profileForm.created).waitFor({ timeout: UI_TIMEOUT_MS });
    const saved = await valueOf<{ profile: { approvedTestOrigins: readonly string[]; environmentEvidenceRef: string | null } }>(
      'getProfileFn', 'GET', { profileId: PUBLIC_PROFILE },
    );
    expect(saved.profile).toMatchObject({ approvedTestOrigins: [], environmentEvidenceRef: null });

    // 「次にすること」: 公開の監査は、監査の開始だけが要る。
    expect(await page.getByRole('heading', { name: nextText.heading }).count()).toBe(1);
    expect(await stepStates(page)).toEqual(['NOT_NEEDED', 'NOT_NEEDED', 'NOT_NEEDED', 'NEEDED']);
    expect(await stepRow(page, 'AUTH_SETUP').getByRole('link').count()).toBe(0);
    expect(await stepRow(page, 'AUTH_SETUP').textContent()).toContain(NEXT_STEP_STATE_CATALOG.NOT_NEEDED.label);
    expect(await stepRow(page, 'AUDIT_START').getByRole('link', { name: nextText.openStep(PROFILE_NEXT_STEP_CATALOG.AUDIT_START.label) })
      .getAttribute('href')).toBe(`/start/${PUBLIC_PROFILE}`);

    // 詳細の「監査を始める」→ 開始の画面（キーボードだけ）。
    const startLink = auditStart(page).getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit });
    await tabTo(page, startLink);
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/start/${PUBLIC_PROFILE}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await page.getByTestId('start-target').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.start.submit }).count()).toBe(1);

    // 一覧の行には、今までどおり「監査を始める」があり、理由は出ない。
    const list = await openPage('/');
    const row = list.locator(`tr[data-profile-id="${PUBLIC_PROFILE}"]`);
    await row.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await row.getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit }).count()).toBe(1);
    expect(await row.getByTestId('profile-start-unavailable').count()).toBe(0);
  });

  it('manual login: the auth setup is needed, the saved setup links to the next steps, and editing the profile makes it stale', async () => {
    const detail = await openPage(`/profiles/${MANUAL_PROFILE}`);
    expect(await stepStates(detail)).toEqual(['NEEDED', 'NOT_NEEDED', 'NOT_NEEDED', 'NEEDED']);
    expect(await stepRow(detail, 'AUTH_SETUP').getByRole('link', { name: nextText.openStep(PROFILE_NEXT_STEP_CATALOG.AUTH_SETUP.label) })
      .getAttribute('href')).toBe(`/auth-setup/${MANUAL_PROFILE}`);
    // 認証の設定がないので、監査を始めるボタンは押せない形で、理由を出す。
    const disabled = auditStart(detail).getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit });
    expect(await disabled.isDisabled()).toBe(true);
    expect(await auditStart(detail).getByTestId('profile-audit-start-reason').getAttribute('data-reason')).toBe('AUTH_SETUP_MISSING');
    expect(await auditStart(detail).getByTestId('profile-audit-start-reason').textContent())
      .toBe(AUDIT_JOB_START_REJECTION_DESCRIPTIONS.AUTH_SETUP_MISSING.description);

    // 認証の設定を保存する（内容は Server Function で入れ、画面の「保存する」で保存し直す）→ 次の手順のリンク。
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: manualSetupOf(MANUAL_PROFILE) })).toMatchObject({ ok: true });
    const setup = await openPage(`/auth-setup/${MANUAL_PROFILE}`);
    expect(await setup.getByTestId('next-step-links').count()).toBe(0);
    await setup.getByRole('button', { name: LOCAL_UI_AUTH_TEXT.setup.save }).click();
    await setup.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
    const links = setup.getByTestId('next-step-links');
    await links.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await links.getByRole('link', { name: nextText.after.openOverview }).getAttribute('href')).toBe(`/profiles/${MANUAL_PROFILE}#next-steps`);
    expect(await links.getByRole('link', { name: nextText.after.actions.AUDIT_START }).getAttribute('href')).toBe(`/start/${MANUAL_PROFILE}`);

    // 「次にすること」へ戻ると、認証の設定は済み。監査を始められる。
    await tabTo(setup, links.getByRole('link', { name: nextText.after.openOverview }));
    await setup.keyboard.press('Enter');
    await setup.waitForURL(new RegExp(`/profiles/${MANUAL_PROFILE}#next-steps$`, 'u'), { timeout: UI_TIMEOUT_MS });
    expect(await stepStates(setup)).toEqual(['DONE', 'NOT_NEEDED', 'NOT_NEEDED', 'NEEDED']);
    expect(await auditStart(setup).getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit }).getAttribute('href'))
      .toBe(`/start/${MANUAL_PROFILE}`);

    // プロファイルを直す（改訂 2）→ 認証の設定は「古い（直す）」。監査は始められない。
    await setup.getByRole('button', { name: text.profileForm.save }).click();
    await setup.getByText(text.profileForm.updated).waitFor({ timeout: UI_TIMEOUT_MS });
    await setup.getByTestId('profile-revision').filter({ hasText: text.profileForm.revisionText(2) }).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await stepStates(setup)).toEqual(['STALE', 'NOT_NEEDED', 'NOT_NEEDED', 'NEEDED']);
    expect(await stepRow(setup, 'AUTH_SETUP').textContent()).toContain(NEXT_STEP_STATE_CATALOG.STALE.label);
    expect(await stepRow(setup, 'AUTH_SETUP').getByRole('link', { name: nextText.fixStep(PROFILE_NEXT_STEP_CATALOG.AUTH_SETUP.label) })
      .getAttribute('href')).toBe(`/auth-setup/${MANUAL_PROFILE}`);
    expect(await auditStart(setup).getByTestId('profile-audit-start-reason').getAttribute('data-reason')).toBe('AUTH_SETUP_STALE');
  });

  it('automated login: lists the auth setup, the credential and the login check as needed with links', async () => {
    const detail = await openPage(`/profiles/${AUTOMATED_PROFILE}`);
    expect(await stepStates(detail)).toEqual(['NEEDED', 'NEEDED', 'NEEDED', 'NEEDED']);
    expect(await stepRow(detail, 'CREDENTIAL').getByRole('link', { name: nextText.openStep(PROFILE_NEXT_STEP_CATALOG.CREDENTIAL.label) })
      .getAttribute('href')).toBe(`/credentials/${AUTOMATED_PROFILE}`);
    expect(await stepRow(detail, 'LOGIN_CHECK').getByRole('link', { name: nextText.openStep(PROFILE_NEXT_STEP_CATALOG.LOGIN_CHECK.label) })
      .getAttribute('href')).toBe(`/login-check/${AUTOMATED_PROFILE}`);
  });

  it('write mode and a retired profile: the start button cannot be pressed and shows why, and the list shows the same reason shortly', async () => {
    const write = await openPage(`/profiles/${WRITE_PROFILE}`);
    expect(await stepStates(write)).toEqual(['NEEDED', 'NOT_NEEDED', 'NOT_NEEDED', 'NOT_NEEDED']);
    expect(await stepRow(write, 'AUDIT_START').getByRole('link').count()).toBe(0);
    expect(await auditStart(write).getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit }).isDisabled()).toBe(true);
    expect(await auditStart(write).getByRole('link').count()).toBe(0);
    expect(await auditStart(write).getByTestId('profile-audit-start-reason').getAttribute('data-reason')).toBe('MODE_NOT_EXECUTABLE');

    const retired = await openPage(`/profiles/${RETIRED_PROFILE}`);
    await auditStart(retired).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await retired.getByTestId('profile-next-steps').count()).toBe(0);
    expect(await auditStart(retired).getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit }).isDisabled()).toBe(true);
    expect(await auditStart(retired).getByTestId('profile-audit-start-reason').getAttribute('data-reason')).toBe('PROFILE_RETIRED');

    const list = await openPage('/');
    for (const [profileId, reason] of [[WRITE_PROFILE, 'MODE_NOT_EXECUTABLE'], [RETIRED_PROFILE, 'PROFILE_RETIRED']] as const) {
      const row = list.locator(`tr[data-profile-id="${profileId}"]`);
      await row.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await row.getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit }).count()).toBe(0);
      expect(await row.getByTestId('profile-start-unavailable').getAttribute('data-reason')).toBe(reason);
      expect(await row.getByTestId('profile-start-unavailable').textContent()).toBe(nextText.auditStartUnavailable[reason]);
    }
  });

  // T43a fix round 1（設計者の判断 1）: モードを選ぶと、環境と認証の方式を組み合わせの表の初めの値に合わせる（利用者は後から変えられる）。
  it('sets the environment and the auth to the first values of the combination table when a mode is selected, and lets the person change them', async () => {
    const page = await openPage('/profiles/new');
    // 「環境」は「テスト環境の Origin」などにも部分一致するので、ラベルは完全一致で選ぶ。
    const mode = page.getByLabel(text.profileForm.mode, { exact: true });
    const environment = page.getByLabel(text.profileForm.environment, { exact: true });
    const auth = page.getByLabel(text.profileForm.auth, { exact: true });
    const evidence = page.getByLabel(text.profileForm.environmentEvidenceRef);
    const testOrigins = page.getByLabel(text.profileForm.approvedTestOrigins);
    await mode.waitFor({ timeout: UI_TIMEOUT_MS });
    const selected = async (): Promise<readonly string[]> => [await environment.inputValue(), await auth.inputValue()];
    expect(await selected()).toEqual(['PUBLIC', 'NONE']);

    await mode.selectOption('TEST_AUTH_PASSIVE');
    await expect.poll(selected, { timeout: UI_TIMEOUT_MS }).toEqual(['TEST', 'MANUAL_SESSION']);
    // 利用者は、合わせた値を後から変えられる（モードを選び直すまで残る）。
    await auth.selectOption('AUTOMATED_LOGIN');
    expect(await selected()).toEqual(['TEST', 'AUTOMATED_LOGIN']);
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

  it('keeps the evidence reference of a public mode profile in the test environment when the profile is saved again', async () => {
    const page = await openPage(`/profiles/${PUBLIC_TEST_PROFILE}`);
    const evidence = page.getByLabel(text.profileForm.environmentEvidenceRef);
    await evidence.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await evidence.inputValue()).toBe(PUBLIC_TEST_EVIDENCE);
    expect(await page.getByLabel(text.profileForm.approvedTestOrigins).count()).toBe(0);
    await page.getByRole('button', { name: text.profileForm.save }).click();
    await page.getByText(text.profileForm.updated).waitFor({ timeout: UI_TIMEOUT_MS });
    await page.getByTestId('profile-revision').filter({ hasText: text.profileForm.revisionText(2) }).waitFor({ timeout: UI_TIMEOUT_MS });
    const saved = await valueOf<{ profile: { revision: number; environment: string; environmentEvidenceRef: string | null } }>(
      'getProfileFn', 'GET', { profileId: PUBLIC_TEST_PROFILE },
    );
    expect(saved.profile).toMatchObject({ revision: 2, environment: 'TEST', environmentEvidenceRef: PUBLIC_TEST_EVIDENCE });
  });
});

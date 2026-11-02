/**
 * T43a（Task 43 の設計書 4.1、5 章の 1）: プロファイルの作成から監査の開始まで、画面の中のリンクだけで進めることの確かめ。ビルドした画面を一時の root の
 * 起動の部品で起動し、Playwright の headless の Chromium（`tests/helpers/chromium.ts` の既定）で、token の URL から開く。
 * - 左のメニューの「サイトを足す」。
 * - PL-1（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1、4 章の 1・7、6 章。前の「次にすること」の表（済み・要る・要らない・古い（直す））と
 *   「監査を始める」の欄の確かめを、この形に直した）: サイトの画面は、要点のパネル（段の文と理由、主のボタン 1 つ）と詳しい内容 1 つ。主のボタンは段で決まる
 *   （入口を確かめ直す → 点検を始める → …）。押せないときはボタンを出さず、要点に理由を出す。一覧の行は「続ける」と、同じ判定の段の短い文。
 * - 作成の欄（PL-1。設計書 6 章の 1）: 見える入力は開始のアドレス・使い方・保存だけ。公開の画面だけのプロファイルは、テスト環境の Origin と確かめた記録の参照を
 *   持たない（前は、公開のモードで隠した欄の値を送らないことを、たたんだ詳しい設定の欄で確かめていた。欄はもうない）。
 * - 認証の設定の保存の後の次の手順のリンク。プロファイルを直した後に、認証の設定が古くなったことを、要点の段（ログインの設定を直す）で示す。
 * - MI-3 の D: 書き込みのモードのプロファイルの監査の開始の画面に、監査は読み取りだけで行う旨の一文を出す（ほかのモードでは出さない）。
 * - MI-4（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.4）・PL-1（4 章の 1）: 「次から自動でログインする」は、手でログインした点検が 1 回終わって
 *   からだけ出す（認証の設定を保存した直後には出さない）。自動ログインのプロファイルの画面に、ログインの確かめの画面への入口を出さない（判断 1）。
 * - 編集の画面（サイトの画面の詳しい内容の中）の、モードを選ぶと環境と認証の方式を組み合わせの表の初めの値に合わせること（T43a fix round 1）。
 * - 監査は始めない（サイトに接続しない。テスト環境の Origin は 127.0.0.1 の使っていない番号で、どこにも接続しない。OP-1 修正の 2 回目: 作成の画面の下調べは、
 *   予約の名前の開始のアドレスを開けずに終わる）。すべての画面で、CSP の違反と
 *   console の誤りが 0 件、外部への要求が 0 件。
 */
import { writeFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_JOB_START_REJECTION_DESCRIPTIONS,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_SETUP_PROPOSAL_TEXT,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_NEXT_STEP_TEXT,
  LOCAL_UI_TEXT,
} from '../../../src/presentation/messages.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
import { profileStageOf, profileSummaryActionsOf } from './helpers/next-steps.ts';
import { openAuthSetupAdvancedSettings } from './helpers/auth-setup-page.ts';
import { createProfileOnScreen, openProfileAdvancedSettings, profileIdOfPage } from './helpers/profile-form.ts';
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
import { createProfileInStore, saveAuthSetupRequestInStore } from './helpers/profile-store-setup.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

/** 画面の操作を待つ上限（ミリ秒）。 */
const UI_TIMEOUT_MS = 15_000;
/** フォーカスを Tab で動かす回数の上限。 */
const MAX_TAB_PRESSES = 60;
const FIRST_REVISION = 1;

/**
 * テストの値（匿名）。テスト環境の Origin は、使っていない 127.0.0.1 の番号（接続しない）。PL-1: 画面で作る公開の画面だけのプロファイルの名前は、開始のアドレス
 * （一時の root の `config/targets/example.json` の開始のアドレス）から決まる。
 */
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

/** サイトの画面の段（共用の補助 `profileStageOf`）。 */
const stageOf = (page: Page): Promise<string | null> => profileStageOf(page, UI_TIMEOUT_MS);

/** サイトの画面の要点のパネルのボタンの行き先（共用の補助 `profileSummaryActionsOf`）。 */
const summaryActionsOf = (page: Page): Promise<readonly (string | null)[]> => profileSummaryActionsOf(page, UI_TIMEOUT_MS);

/** 本文の中の、ログインの確かめの画面へのリンクの数（判断 1: ふだんの流れからは行かない）。 */
const loginCheckLinksOf = (page: Page): Promise<number> => page.locator('main a[href*="/login-check/"]').count();

/** 本文の中の、「次から自動でログインする」の入口の数（要点のパネルと詳しい内容）。 */
const automatedLoginOffersOf = (page: Page): Promise<number> => page.locator('main [data-action="AUTOMATED_LOGIN_SETUP"]').count();

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  writeFileSync(`${root.root}/${PUBLIC_TARGET_CONFIG}`, `${JSON.stringify({ target: { id: 'onboarding' }, site: { startUrl: PUBLIC_START_URL, allowedOrigins: [new URL(PUBLIC_START_URL).origin] } })}
`, 'utf8');
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
  // MI-F1（設計書 4.7.1 の 2）: 自動ログインのプロファイルは、画面の作成の口では作れない（切り替えだけで入る）。テストの準備は、保存の部品で直接作る。
  expect(await createProfileInStore(root.root, testProfileDocument(AUTOMATED_PROFILE, 'TEST_AUTH_PASSIVE', 'AUTOMATED_LOGIN')))
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
    expect(await saveAuthSetupRequestInStore(root, { setup: manualSetupOf(MANUAL_PROFILE) })).toMatchObject({ ok: true });
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

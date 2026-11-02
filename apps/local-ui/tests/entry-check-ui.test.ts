/**
 * T43c（Task 43 の設計書 4.3、5 章の 3）: 入口の確かめの画面の操作の確かめ。ビルドした画面を一時の root の起動の部品で起動し、Playwright の headless の
 * Chromium（`tests/helpers/chromium.ts` の既定）で、token の URL から開く。監査のワーカーは本番の入口のまま（入口の確かめはログインの段を通さない）で、
 * 127.0.0.1 の fixture のサイト（`tests/helpers/entry-check-site.ts`。値の目印を入れたログインの画面）に対して、本物の入口の確かめを動かす。
 * - プロファイルの詳細の「入口を確かめる」（キーボード）→ ジョブの画面に、読んだ事実（終わり方、移った先、欄の候補と一意な CSS、form）と案を出す。
 *   成果物のリンク。公開のプロファイルには、認証の設定の画面へのリンクを出さない。
 * - 始められない理由: 対象の設定のファイルを読めないプロファイルは、押せない形で理由を出す。認証の設定のないテストのプロファイルは始められる
 *   （認証の設定は要らない）。
 * - 認証の設定の画面: 保存した設定がないときは、最後の成功した入口の確かめの案を欄に埋め、案であることを示す（開始の URL の path の案より優先。ログインの
 *   画面の path に当たる成功の画面の path の案は空にする）。自動ログインのプロファイルでは 3 つのセレクタも埋める。保存した設定があれば埋めない。
 * - 画面（ページの本文）に欄の値の目印が出ない。すべての画面で、CSP の違反と console の誤りが 0 件、外部への要求が 0 件。fixture のサイトに届いた要求は
 *   GET と HEAD だけで、許可 Origin の外には届かない。
 * - MI-3（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.3。今の「認証の設定の画面で案を確かめて保存する」流れを 4.3 に合わせて直した）:
 *   ジョブの画面の「入口の確かめの結果」は、認証の設定の画面へのリンクの代わりに、入口の確かめの後の認証の設定の状態を出す。ログインの画面を見つけ、案が検証を
 *   通れば BeakSight が案で保存し（`PRESENT`。文は出さず、監査の開始へのリンクだけ）、プロファイルの「次にすること」に認証の設定の画面へのリンクを出さない。案が検証を通らなければ
 *   保存せず、理由と「詳しい設定で認証の設定を作る」を出す。認証の設定の画面の欄は、たたんだ「詳しい設定」の中（入れる前に開く）。
 * - MI-3 の C: 監査の開始の画面の「読まないパス」。変えて始めると認証の設定を保存してから始め、変えなければ保存しない。保存が拒まれたら始めずに理由を出す。
 */
import { rmSync } from 'node:fs';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_JOB_STATE_CATALOG } from '../../../src/presentation/catalog.js';
import {
  AUDIT_JOB_START_REJECTION_DESCRIPTIONS,
  AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_SETUP_PROPOSAL_TEXT,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_ENTRY_CHECK_TEXT,
  LOCAL_UI_JOB_NEXT_STEPS,
  LOCAL_UI_JOB_SUMMARY_TEXT,
  LOCAL_UI_NEXT_STEP_TEXT,
  LOCAL_UI_TEXT,
} from '../../../src/presentation/messages.js';
import { SPA_APP_PATHS, startSpaAuthSite, type SpaAuthSite } from '../../../tests/helpers/spa-auth-site-fixture.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import {
  ENTRY_CHECK_SITE_PATHS,
  ENTRY_CHECK_VALUE_MARKERS,
  startEntryCheckSite,
  type EntryCheckSite,
} from '../../../tests/helpers/entry-check-site.js';
import { READ_METHODS } from '../../../tests/helpers/leak-places.js';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
import { openAuthSetupAdvancedSettings } from './helpers/auth-setup-page.ts';
import {
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
import { waitForJobViaServerFunctions } from './helpers/server-function-job-wait.ts';
import { createProfileInStore, saveAuthSetupRequestInStore } from './helpers/profile-store-setup.ts';
import { createUiPageKit } from './helpers/ui-page.ts';
import { openAdvancedSettings } from './helpers/advanced-settings.ts';
import { primaryButtonLabelsInMain } from './helpers/screen-shape.ts';

/** 画面の操作を待つ上限（ms）。 */
const UI_TIMEOUT_MS = 15_000;
/** ジョブの終わりを待つ上限（ms）。 */
const JOB_TIMEOUT_MS = 120_000;
/** 入口の確かめのジョブを読み直す間隔（ms）。 */
const ENTRY_CHECK_POLL_MS = 250;
/** 1 つの場面の上限（ms）。 */
const SCENARIO_TIMEOUT_MS = 240_000;
/** フォーカスを Tab で動かす回数の上限。 */
const MAX_TAB_PRESSES = 120;
const FIRST_REVISION = 1;
const PUBLIC_PROFILE = 't43c-public';
const MANUAL_PROFILE = 't43c-manual';
const AUTOMATED_PROFILE = 't43c-automated';
const SAVED_PROFILE = 't43c-saved';
const BROKEN_PROFILE = 't43c-broken';
/** T44e: 開始の URL が許可 Origin の外へ移ろうとするプロファイル（終わり方 `LEFT_ALLOWED_ORIGINS`）。 */
const LEFT_PROFILE = 't44e-left';
/** T44e（P2-8）: SPA（スクリプトで送るログイン）の入口の確かめのプロファイル。 */
const SPA_PROFILE = 't44e-spa';
/** MI-3: 開始の URL がログインの後の画面（`/admin`）で、ログインの画面へ移る SPA のプロファイル（案が検証を通り、BeakSight が保存する）。 */
const SPA_ADMIN_PROFILE = 'mi3-spa-admin';

const text = LOCAL_UI_ENTRY_CHECK_TEXT;

let root: TemporaryUiRoot | undefined;
let site: EntryCheckSite | undefined;
/** T44e（P2-8）: SPA の fixture（入口の確かめは 1 回読むだけ。ログインはしない）。 */
let spaSite: SpaAuthSite | undefined;
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
const siteOf = (): EntryCheckSite => {
  if (site === undefined) {
    throw new Error('fixture のサイトが起動していない');
  }
  return site;
};

const { openPage, tabTo, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
});

const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
  expect(result.response.status, `${name} ${result.response.body.slice(0, 200)}`).toBe(200);  return result.value as T;
};

const jobState = (page: Page, value: keyof typeof AUDIT_JOB_STATE_CATALOG): Locator => page.locator(`[data-testid="job-state"][data-state="${value}"]`);

/** テストのプロファイルの文書。 */
const testProfileOf = (profileId: string, auth: 'MANUAL_SESSION' | 'AUTOMATED_LOGIN'): Record<string, unknown> => ({
  schemaVersion: 'beaksight-profile/1',
  profileId,
  revision: FIRST_REVISION,
  targetConfigPath: writeAuthTargetConfig(root?.root ?? '', profileId, siteOf().originA, ENTRY_CHECK_SITE_PATHS.prefilled, 1),
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth,
  approvedTestOrigins: [siteOf().originA],
  environmentEvidenceRef: 't43c-evidence',
});

/** 公開のプロファイルの文書（`startPath` は開始の URL の path。既定はログインの画面）。 */
const publicProfileOf = (profileId: string, startPath: string = ENTRY_CHECK_SITE_PATHS.prefilled): Record<string, unknown> => ({
  schemaVersion: 'beaksight-profile/1',
  profileId,
  revision: FIRST_REVISION,
  targetConfigPath: writeAuthTargetConfig(root?.root ?? '', profileId, siteOf().originA, startPath, 1),
  environment: 'PUBLIC',
  mode: 'PUBLIC_PASSIVE',
  auth: 'NONE',
  approvedTestOrigins: [],
  environmentEvidenceRef: null,
});

/** 手動のログインの認証の設定（フォームの送信）。 */
const savedSetupOf = (profileId: string): Record<string, unknown> => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId,
  profileRevision: FIRST_REVISION,
  loginStartUrl: `${siteOf().originA}/saved-login`,
  loginPostEndpoints: [{ origin: siteOf().originA, path: '/saved-session' }],
  successCondition: { pathPrefix: '/saved-home', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [],
  auditPathPrefixes: ['/saved-home'],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

/** 入口の確かめを Server Function で始め、終わるまで待つ（ジョブの ID を返す）。 */
const runEntryCheck = async (profileId: string): Promise<string> => {
  const job = await valueOf<{ ok: boolean; jobId: string }>('startEntryCheckFn', 'POST', { profileId, expectedRevision: FIRST_REVISION });
  expect(job.ok).toBe(true);
  // PRE42-CC 組 UI-K2（CC-112）: 読み直して待つのは補助（上限と間隔は前と同じ）。
  const detail = await waitForJobViaServerFunctions(
    (jobId) => valueOf<{ state: string; active: boolean }>('getAuditJobFn', 'GET', { jobId }),
    job.jobId,
    (current) => !current.active,
    { limitMs: JOB_TIMEOUT_MS, stepMs: ENTRY_CHECK_POLL_MS },
  );
  expect(detail.state).toBe('FINISHED');
  return job.jobId;
};

/** 開始の画面から始めた監査のジョブの画面へ移るのを待ち、そのジョブを止めて、終わるまで待つ（MI-3 の C と MI-F3 の場面が共用する）。 */
const stopStartedAudit = async (current: Page): Promise<void> => {
  await current.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
  const startedJobId = new URL(current.url()).pathname.split('/').at(-1) ?? '';
  expect(await valueOf<{ ok: boolean }>('stopAuditJobFn', 'POST', { jobId: startedJobId, force: false })).toMatchObject({ ok: true });
  await waitForJobViaServerFunctions(
    (id) => valueOf<{ active: boolean }>('getAuditJobFn', 'GET', { jobId: id }),
    startedJobId,
    (currentJob) => !currentJob.active,
    { limitMs: JOB_TIMEOUT_MS, stepMs: ENTRY_CHECK_POLL_MS },
  );
};

/** ページの本文に、欄の値の目印がない。 */
const expectNoMarkers = async (page: Page): Promise<void> => {
  const html = await page.content();
  for (const marker of Object.values(ENTRY_CHECK_VALUE_MARKERS)) {
    expect(html.includes(marker), marker).toBe(false);
  }
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  site = await startEntryCheckSite();
  spaSite = await startSpaAuthSite();
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  for (const profile of [
    publicProfileOf(PUBLIC_PROFILE),
    publicProfileOf(BROKEN_PROFILE),
    publicProfileOf(LEFT_PROFILE, ENTRY_CHECK_SITE_PATHS.redirectOut),
    testProfileOf(MANUAL_PROFILE, 'MANUAL_SESSION'),
    testProfileOf(AUTOMATED_PROFILE, 'AUTOMATED_LOGIN'),
    testProfileOf(SAVED_PROFILE, 'MANUAL_SESSION'),
    {
      ...testProfileOf(SPA_PROFILE, 'MANUAL_SESSION'),
      targetConfigPath: writeAuthTargetConfig(root.root, SPA_PROFILE, spaSite.appOrigin, SPA_APP_PATHS.auth, 1),
      approvedTestOrigins: [spaSite.appOrigin],
    },
    {
      ...testProfileOf(SPA_ADMIN_PROFILE, 'MANUAL_SESSION'),
      targetConfigPath: writeAuthTargetConfig(root.root, SPA_ADMIN_PROFILE, spaSite.appOrigin, SPA_APP_PATHS.admin, 1),
      approvedTestOrigins: [spaSite.appOrigin],
    },
  ]) {
    // MI-F1（設計書 4.7.1 の 2）: 自動ログインのプロファイルは、画面の作成の口では作れない（切り替えだけで入る）。テストの準備は、保存の部品で直接作る。
    expect(profile.auth === 'AUTOMATED_LOGIN'
      ? await createProfileInStore(root.root, profile)
      : await valueOf('createProfileFn', 'POST', { profile })).toMatchObject({ ok: true });
  }
  expect(await saveAuthSetupRequestInStore(root, { setup: savedSetupOf(SAVED_PROFILE) })).toMatchObject({ ok: true });
  // 対象の設定のファイルを読めないプロファイル（作った後にファイルを消す）。
  const broken = await valueOf<{ profile: { targetConfigPath: string } }>('getProfileFn', 'GET', { profileId: BROKEN_PROFILE });
  rmSync(`${root.root}/${broken.profile.targetConfigPath}`);
}, SCENARIO_TIMEOUT_MS);

afterEach(async () => {
  await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  if (site !== undefined) {
    expect(site.requests.filter(({ method }) => !READ_METHODS.has(method)), 'non-read requests').toEqual([]);
    expect(site.requests.filter(({ site: origin }) => origin === 'B'), 'requests outside the allowed origins').toEqual([]);
    await site.close();
  }
  if (spaSite !== undefined) {
    // 入口の確かめは読み取りだけ（ログインの送信も、サービスへの要求もない）。
    expect(spaSite.requests.filter(({ method }) => !READ_METHODS.has(method)), 'non-read requests to the SPA').toEqual([]);
    await spaSite.close();
  }
  root?.remove();
}, SCENARIO_TIMEOUT_MS);

describe('T43c: the entry check on the screens', () => {
  it('starts the entry check from the profile detail by keyboard, and shows the facts and the proposal on the job screen', async () => {
    const page = await openPage(`/profiles/${PUBLIC_PROFILE}`);
    // PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1、4 章の 1）: 「入口を確かめ直す」は、主のボタンでないときは詳しい内容の中（キーボードで
    // 見出しを開く）。前の入口の確かめの欄（説明と、最後に成功した入口の確かめ）は、サイトの画面から消した（済んだ操作の記録は作業の画面にある）。
    await tabTo(page, page.getByTestId('profile-edit-advanced-settings').locator('summary'));
    await page.keyboard.press('Enter');
    const button = page.getByTestId('profile-detail-actions').locator('[data-action="RECHECK_ENTRY"]');
    expect(await button.textContent()).toBe(LOCAL_UI_NEXT_STEP_TEXT.actions.RECHECK_ENTRY);
    expect(await button.isEnabled()).toBe(true);
    await tabTo(page, button);
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
    const entryJobId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    // PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 5）: 見ていた入口の確かめが成功で終わったら、サイトの詳細へ自動で移る（移った印と、
    // どの作業から移ったか）。
    await page.waitForURL(new RegExp(`/profiles/${PUBLIC_PROFILE}[?]`, 'u'), { timeout: JOB_TIMEOUT_MS });
    expect(new URL(page.url()).searchParams.get('arrived')).toBe('auto');
    expect(new URL(page.url()).searchParams.get('fromJob')).toBe(entryJobId);
    // PL-1（13 章の最後の段落）: 移った先の要点の 1 行目に、何が起きたか（作業の結果の文）を出す。
    const arrival = page.getByTestId('profile-summary').getByTestId('profile-arrival');
    await arrival.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await arrival.getAttribute('data-result')).toBe('ENTRY_CHECK_LOGIN_PAGE');
    expect(await arrival.textContent()).toBe(LOCAL_UI_JOB_SUMMARY_TEXT.finished.ENTRY_CHECK_LOGIN_PAGE);
    // 終わった作業を開き直すと、移らずに、要点（結果の 1 行と主のボタン「点検を始める」）と、たたんだ詳しい内容（読んだ事実と案）を出す。
    const job = await openPage(`/jobs/${entryJobId}`);
    await job.locator('[data-testid="job-result"][data-result="ENTRY_CHECK_LOGIN_PAGE"]').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await job.getByTestId('job-start-audit').getAttribute('href')).toBe(`/start/${PUBLIC_PROFILE}`);
    await openAdvancedSettings(job, 'job-details', UI_TIMEOUT_MS);
    expect(await job.getByTestId('job-entry-check-end-reason').getAttribute('data-end-reason')).toBe('READ');
    expect(await job.getByTestId('job-entry-check-login-page').getAttribute('data-login-page')).toBe('true');
    const fields = job.getByTestId('job-entry-check-fields');
    expect(await fields.locator('tr[data-field="username"] code').textContent()).toBe('#login-id');
    expect(await fields.locator('tr[data-field="password"] code').textContent()).toBe('#login-password');
    expect(await fields.locator('tr[data-field="submit"] code').textContent()).toBe('#login-submit');
    expect(await job.getByTestId('job-entry-check-proposal').locator('[data-transport]').getAttribute('data-transport')).toBe('FORM_NAVIGATION');
    expect(await job.getByTestId('job-entry-check-proposal').textContent()).toContain(`${siteOf().originA}${ENTRY_CHECK_SITE_PATHS.session}`);
    // 公開のプロファイルは認証の設定を使わないので、認証の設定の状態もリンクも出さない（MI-3）。
    expect(await job.getByTestId('auth-setup-proposal').count()).toBe(0);
    expect(await job.locator('a[href^="/auth-setup/"]').count()).toBe(0);
    expect(await job.locator('[data-artifact="ENTRY_CHECK_JSON"]').count()).toBe(1);
    await expectNoMarkers(job);

    // PL-1: サイトの画面には、最後の成功した入口の確かめの欄（日時と作業へのリンク）を出さない。公開のサイトの要点は、点検を始めるだけ。
    const detail = await openPage(`/profiles/${PUBLIC_PROFILE}`);
    await detail.locator('[data-testid="profile-summary"][data-stage="AUDIT_PUBLIC"]').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await detail.getByTestId('entry-check-latest').count()).toBe(0);
  }, SCENARIO_TIMEOUT_MS);

  it('shows the reason why the entry check cannot start, with the button disabled', async () => {
    const page = await openPage(`/profiles/${BROKEN_PROFILE}`);
    // PL-1（設計書 3 章の 1）: 押せないときはボタンを出さず、要点に理由を出す（前は押せない「入口を確かめる」と理由）。
    const summary = page.locator('[data-testid="profile-summary"][data-stage="BLOCKED"]');
    await summary.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.locator('main [data-action="RECHECK_ENTRY"]').count()).toBe(0);
    const reason = summary.getByTestId('profile-stage-reason');
    expect(await reason.getAttribute('data-reason')).toBe('TARGET_CONFIG_UNAVAILABLE');
    expect(await reason.textContent()).toContain(AUDIT_JOB_START_REJECTION_DESCRIPTIONS.TARGET_CONFIG_UNAVAILABLE.description);
  }, SCENARIO_TIMEOUT_MS);

  // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D3。前は MI-3 の「案は検証を通らず、BeakSight は保存しない」）: 開始の URL がログインの画面そのもので、
  // ログインが済んだと判定するパスを決められないときも、手動のログインのプロファイルは、成功の条件を空にした案のまま保存する（手でのログインの後に、観察した成功の
  // 画面の path が埋める。空の成功の条件は、ログインの段で成功にしない）。人は詳しい設定で何も入れない。
  it('saves the proposal of the last entry check with an empty success condition (a manual login profile whose start URL is the login page)', async () => {
    const page = await openPage(`/auth-setup/${MANUAL_PROFILE}`);
    const panel = page.getByTestId('entry-check-panel');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    // 認証の設定がなくても始められる。
    expect(await panel.getByTestId('entry-check-start').isEnabled()).toBe(true);
    expect(await page.getByTestId('auth-setup-entry-check-draft').count()).toBe(0);
    await tabTo(page, panel.getByTestId('entry-check-start'));
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
    const jobId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    await waitForJobViaServerFunctions((id) => valueOf<{ active: boolean }>('getAuditJobFn', 'GET', { jobId: id }), jobId, (job) => !job.active,
      { limitMs: JOB_TIMEOUT_MS, stepMs: ENTRY_CHECK_POLL_MS });
    await expect.poll(async () => (await valueOf<{ stored: { freshness: string; setup: Record<string, unknown> } | null }>(
      'getAuthSetupFn', 'GET', { profileId: MANUAL_PROFILE },
    )).stored, { timeout: UI_TIMEOUT_MS }).toMatchObject({
      freshness: 'CURRENT',
      setup: {
        loginStartUrl: `${siteOf().originA}${ENTRY_CHECK_SITE_PATHS.prefilled}`,
        sessionLostCondition: { pathPrefix: ENTRY_CHECK_SITE_PATHS.prefilled },
        loginPostEndpoints: [{ origin: siteOf().originA, path: ENTRY_CHECK_SITE_PATHS.session }],
        // 開始の URL の path の案（T43b）は、ログインの画面の path に当たるので、成功の画面の path に残さない（空のまま保存する）。
        successCondition: { pathPrefix: '', selector: null },
      },
    });
    await expectNoMarkers(page);
  }, SCENARIO_TIMEOUT_MS);

  // MI-F5（設計書 4.7.1 の 6）: 認証の設定がまだないときの最初の保存は、送信先の項目（ログインの画面の URL、送り方、フォームの送信先、セレクタ）が、最後の
  // 入口の確かめの案と同じときだけ受ける（前の場面で、このプロファイルの入口の確かめが終わっている）。送信先でない欄（ログインが済んだと判定するパス）は人が入れる。
  it('accepts a save of the saved proposal only with the same destinations', async () => {
    const proposed = {
      ...FORM_NAVIGATION_SETUP_ITEMS,
      profileId: MANUAL_PROFILE,
      profileRevision: FIRST_REVISION,
      loginStartUrl: `${siteOf().originA}${ENTRY_CHECK_SITE_PATHS.prefilled}`,
      loginPostEndpoints: [{ origin: siteOf().originA, path: ENTRY_CHECK_SITE_PATHS.session }],
      successCondition: { pathPrefix: '/mi-f5-home', selector: null },
      sessionLostCondition: { pathPrefix: ENTRY_CHECK_SITE_PATHS.prefilled },
      excludedPaths: [],
      auditPathPrefixes: [],
      maxLoginAttempts: 1,
      allowedIdpOrigins: [],
      automatedLogin: null,
    };
    // OP-1（D3）: 前の場面で、入口の確かめの案（成功の条件は空）を BeakSight が保存した。送信先を変える保存は、今も拒む（MI-F5 の 4.7.1 の 6。認証の設定がある
    // ときの守り）。送信先でない欄（ログインが済んだと判定するパス）を変える保存は受ける。
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: { ...proposed, loginPostEndpoints: [{ origin: siteOf().originA, path: '/mi-f5-collect' }] } }))
      .toMatchObject({ ok: false });
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: { ...proposed, loginStartUrl: `${siteOf().originA}/mi-f5-login` } }))
      .toMatchObject({ ok: false });
    expect((await valueOf<{ stored: { setup: { successCondition: unknown } } | null }>('getAuthSetupFn', 'GET', { profileId: MANUAL_PROFILE })).stored?.setup.successCondition)
      .toEqual({ pathPrefix: '', selector: null });
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: proposed })).toMatchObject({ ok: true });
  }, SCENARIO_TIMEOUT_MS);

  it('fills the three selectors of the automated login from the proposal', async () => {
    await runEntryCheck(AUTOMATED_PROFILE);
    const page = await openPage(`/auth-setup/${AUTOMATED_PROFILE}`);
    // MI-3: 欄と案の知らせは、たたんだ「詳しい設定」の中。開いてから確かめる。
    await openAuthSetupAdvancedSettings(page, UI_TIMEOUT_MS);
    await page.getByTestId('auth-setup-entry-check-draft').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.locator('[name="usernameSelector"]').inputValue()).toBe('#login-id');
    expect(await page.locator('[name="passwordSelector"]').inputValue()).toBe('#login-password');
    expect(await page.locator('[name="submitSelector"]').inputValue()).toBe('#login-submit');
  }, SCENARIO_TIMEOUT_MS);

  // T44e（Task 44 の設計書 P2-7。測りの記録の 3.3 の B）: 案を作れなかった終わり方に、次にできることを出す。
  it('shows the next step when the start URL tried to leave the allowed origins', async () => {
    const jobId = await runEntryCheck(LEFT_PROFILE);
    const page = await openPage(`/jobs/${jobId}`);
    await page.getByTestId('job-entry-check').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('job-entry-check-end-reason').getAttribute('data-end-reason')).toBe('LEFT_ALLOWED_ORIGINS');
    expect(await page.getByTestId('job-entry-check-next-step').textContent()).toBe(LOCAL_UI_JOB_NEXT_STEPS.entryCheckEndReasons.LEFT_ALLOWED_ORIGINS);
  }, SCENARIO_TIMEOUT_MS);

  // T44e（Task 44 の設計書 P2-8。設計の変更の履歴の T44e の行の (1) 案 (a)）: SPA（action のないログインの form。スクリプトで送るログイン）の入口の確かめの
  // 案は「スクリプトの送信」で、token の送信先と成功のローカル ストレージの鍵が空。手動のログインのプロファイルでは、そのまま保存できる（前は
  // `AUTH_SETUP_SCRIPT_LOGIN_REQUIRED` で拒まれた）。入口の確かめの結果と認証の設定の画面に、「手動のログインで一度ログインすると、送信先が自動で登録される」
  // 旨を出す（空の欄は、手動のログインの成功の後の自動の登録が埋める。`tests/integration/manual-login-pass-through.test.ts`）。
  it('saves the proposal of an SPA entry check as it is for a manual login profile, with the guidance of the automatic registration', async () => {
    const jobId = await runEntryCheck(SPA_PROFILE);
    const job = await openPage(`/jobs/${jobId}`);
    await job.getByTestId('job-entry-check').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await job.getByTestId('job-entry-check-end-reason').getAttribute('data-end-reason')).toBe('READ');
    expect(await job.getByTestId('job-entry-check-proposal').locator('[data-transport]').getAttribute('data-transport')).toBe('SCRIPT_REQUEST');
    expect(await job.getByTestId('job-entry-check-script-login-note').textContent()).toBe(LOCAL_UI_AUTH_TEXT.scriptLoginAutoRegistrationNote);
    // OP-1（D3。前は MI-3 の「案は検証を通らず、BeakSight は保存しない（人が詳しい設定で入れる）」）: 開始の URL がログインの画面でも、成功の条件を空にした案のまま
    // 保存する（ログインが済んだと判定するパスは、手でのログインの後に、観察した成功の画面の path が埋める。人は何も入れない）。
    await expect.poll(() => valueOf<{ stored: unknown }>('getAuthSetupFn', 'GET', { profileId: SPA_PROFILE }).then((value) => value.stored !== null), { timeout: UI_TIMEOUT_MS })
      .toBe(true);
    const stored = await valueOf<{ stored: { setup: Record<string, unknown> } | null }>('getAuthSetupFn', 'GET', { profileId: SPA_PROFILE });
    expect(stored.stored?.setup).toMatchObject({ loginTransport: 'SCRIPT_REQUEST', scriptLogin: null, successStorageKey: null, successCondition: { pathPrefix: '', selector: null } });
  }, SCENARIO_TIMEOUT_MS);

  // MI-3（設計書 4.3、6 章の受け入れ条件 2）: 開始の URL がログインの後の画面（`/admin`）で、ログインの画面（`/auth`）へ移る SPA。入口の確かめが終わると、
  // BeakSight が案（読まないパスは空）で認証の設定を保存する。ジョブの画面は文を出さずに監査の開始へのリンクだけを出し、プロファイルの「次にすること」には
  // 認証の設定の画面へのリンクを出さない（認証の設定は済み）。認証の設定の画面は「どこから来た値か」の要約を出し、欄はたたんだまま。
  it('saves the auth setup proposal after the entry check found a login page, and links no auth setup page from the next steps', async () => {
    const jobId = await runEntryCheck(SPA_ADMIN_PROFILE);
    const stored = await valueOf<{ stored: { setup: Record<string, unknown> } | null }>('getAuthSetupFn', 'GET', { profileId: SPA_ADMIN_PROFILE });
    expect(stored.stored?.setup).toMatchObject({
      profileRevision: FIRST_REVISION,
      loginStartUrl: `${spaSite?.appOrigin ?? ''}${SPA_APP_PATHS.auth}`,
      successCondition: { pathPrefix: SPA_APP_PATHS.admin, selector: null },
      excludedPaths: [],
      auditPathPrefixes: [SPA_APP_PATHS.admin],
      loginTransport: 'SCRIPT_REQUEST',
      scriptLogin: null,
    });
    const job = await openPage(`/jobs/${jobId}`);
    // 設計者の判断（表示を減らす）: 設定があるときは「保存しました」などの文を出さず、次の段（監査の開始）へのリンクだけ。PL-2（3 章の 1、13 章の 3）: その
    // リンクは、要点の主のボタン（1 つだけ）。
    const start = job.getByTestId('job-summary-panel').getByTestId('job-start-audit');
    await start.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await start.getAttribute('href')).toBe(`/start/${SPA_ADMIN_PROFILE}`);
    expect((await start.textContent())?.trim()).toBe(LOCAL_UI_AUDIT_TEXT.profileList.startAudit);
    expect(await primaryButtonLabelsInMain(job)).toEqual([LOCAL_UI_AUDIT_TEXT.profileList.startAudit]);
    expect(await job.getByTestId('auth-setup-proposal').count()).toBe(0);
    expect(await job.locator('a[href^="/auth-setup/"]').count()).toBe(0);

    // PL-1（設計書 3 章の 1、6 章の 3）: 認証の設定は済んだので、要点のパネルの段は「点検を始める（手でログイン）」。要点に認証の設定の画面へのリンクは出さない。
    const detail = await openPage(`/profiles/${SPA_ADMIN_PROFILE}`);
    const summary = detail.locator('[data-testid="profile-summary"][data-stage="AUDIT_MANUAL_LOGIN"]');
    await summary.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await summary.locator('a[href^="/auth-setup/"]').count()).toBe(0);
    // 認証の設定の画面は、サイトの画面の詳しい内容の中からだけ開く。
    const advanced = detail.getByTestId('profile-edit-advanced-settings');
    expect(await advanced.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
    expect(await detail.locator('main a[href^="/auth-setup/"]').count()).toBe(1);
    expect(await advanced.locator('[data-action="AUTH_SETUP"]').getAttribute('href')).toBe(`/auth-setup/${SPA_ADMIN_PROFILE}`);

    const setup = await openPage(`/auth-setup/${SPA_ADMIN_PROFILE}`);
    // PL-4（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2。前は「どこから来た値か」の表と印を出していた）: 要点に、自動で作った設定であることと、
    // 直すのは自動で入らない欄だけであることの 1 行。表は出さない。
    const summaryLine = setup.getByTestId('auth-setup-summary-line');
    await summaryLine.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await summaryLine.textContent()).toBe(LOCAL_UI_AUTH_TEXT.setup.summarySaved);
    expect(await setup.getByTestId('auth-setup-value-sources').count()).toBe(0);
    expect(await setup.getByTestId('auth-setup-advanced-settings').evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
  }, SCENARIO_TIMEOUT_MS);

  // MI-3 の C（設計書 4.3）: 監査の開始の画面の「読まないパス」。初めの値は今の認証の設定の読まないパスで、既定の語を説明に出す。保存が拒まれたら監査を始めず、
  // 欄に理由を出す。変えて始めると、認証の設定を保存してから始める。変えなければ保存しない（最後の保存の日時が変わらない）。始めたジョブは止める。
  // PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 2 章の判断 3、3 章の 1）: 読まないパスの欄は、たたんだ詳しい内容の中（開いてから入れる）。主のボタン
  // 「点検を始める」は、まとめて実行を始める（前の「まとめて実行する」のボタンはなくなり、保存してから始める処理は 1 か所のまま）。
  it('saves the excluded paths from the audit start screen only when they changed, before starting the audit', async () => {
    type StoredView = { stored: { setup: { excludedPaths: readonly string[] }; updatedAt: string } | null };
    const before = await valueOf<StoredView>('getAuthSetupFn', 'GET', { profileId: SAVED_PROFILE });
    const page = await openPage(`/start/${SAVED_PROFILE}`);
    const field = page.getByTestId('start-excluded-paths');
    await field.waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    expect(await field.isVisible()).toBe(false);
    expect(await page.getByTestId('start-submit').getAttribute('data-kind')).toBe('STAGE_CHAIN');
    await openAdvancedSettings(page, 'start-advanced-settings', UI_TIMEOUT_MS);
    expect(await field.inputValue()).toBe('');
    expect(await page.getByTestId('start-default-excluded').locator('code').count()).toBeGreaterThan(0);
    // MI-C 項目 9: 承認済みのシナリオがないプロファイルでは、承認し直しの知らせを出さない。
    expect(await page.getByTestId('start-excluded-paths-reapproval').count()).toBe(0);
    // 形の誤り（/ で始まらない）は保存の部品が拒む。監査は始めず、欄に理由を出す（要点にも、欄を見る案内を出す）。
    await field.fill('saved-home/logout');
    const jobsBefore = (await valueOf<readonly unknown[]>('listAuditJobsFn', 'GET')).length;
    await page.getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.start.submit }).click();
    await page.getByText(LOCAL_UI_AUTH_TEXT.start.excludedPathsRejected).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('start-excluded-paths-not-saved').textContent())
      .toBe(LOCAL_UI_AUTH_TEXT.start.excludedPathsRejectedNote(LOCAL_UI_TEXT.advancedSettings.summary));
    expect(page.url()).toBe(`${started().origin}/start/${SAVED_PROFILE}`);
    expect((await valueOf<readonly unknown[]>('listAuditJobsFn', 'GET')).length).toBe(jobsBefore);
    expect((await valueOf<StoredView>('getAuthSetupFn', 'GET', { profileId: SAVED_PROFILE })).stored).toEqual(before.stored);

    // 変えて始めると、保存してから始める。
    await field.fill('/saved-home/logout');
    await page.getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.start.submit }).click();
    await stopStartedAudit(page);
    const changed = await valueOf<StoredView>('getAuthSetupFn', 'GET', { profileId: SAVED_PROFILE });
    expect(changed.stored?.setup.excludedPaths).toEqual(['/saved-home/logout']);

    // 変えなければ保存しない。
    const again = await openPage(`/start/${SAVED_PROFILE}`);
    expect(await again.getByTestId('start-excluded-paths').inputValue()).toBe('/saved-home/logout');
    await again.getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.start.submit }).click();
    await stopStartedAudit(again);
    expect((await valueOf<StoredView>('getAuthSetupFn', 'GET', { profileId: SAVED_PROFILE })).stored?.updatedAt).toBe(changed.stored?.updatedAt);
  }, SCENARIO_TIMEOUT_MS);

  // MI-F3（独立レビュー MI-R の Minor 5。設計書 4.3）: 開始の画面を開いた後に、別のタブで認証の設定（読む範囲のパス）を保存しても、開始の画面の読まないパスの
  // 保存は、その変更を開いた時の古い値に戻さない（サーバが今保存してある設定の読まないパスだけを替える）。
  it('keeps a change of the auth setup saved in another tab when the audit start screen saves the excluded paths', async () => {
    type StoredView = { stored: { setup: Record<string, unknown> } | null };
    const page = await openPage(`/start/${SAVED_PROFILE}`);
    const field = page.getByTestId('start-excluded-paths');
    // PL-3: 欄は、たたんだ詳しい内容の中。
    await openAdvancedSettings(page, 'start-advanced-settings', UI_TIMEOUT_MS);
    await field.waitFor({ timeout: UI_TIMEOUT_MS });
    const opened = (await valueOf<StoredView>('getAuthSetupFn', 'GET', { profileId: SAVED_PROFILE })).stored?.setup;
    expect(opened).toBeDefined();
    // 別のタブ（認証の設定の画面）で、読む範囲のパスを変えて保存した。
    const elsewhere = { ...opened, auditPathPrefixes: ['/saved-home', '/saved-reports'] };
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: elsewhere })).toMatchObject({ ok: true });
    await field.fill('/saved-home/other-tab');
    await page.getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.start.submit }).click();
    await stopStartedAudit(page);
    expect((await valueOf<StoredView>('getAuthSetupFn', 'GET', { profileId: SAVED_PROFILE })).stored?.setup)
      .toEqual({ ...elsewhere, excludedPaths: ['/saved-home/other-tab'] });
  }, SCENARIO_TIMEOUT_MS);

  it('does not fill the auth setup with the proposal when a setup is saved', async () => {
    await runEntryCheck(SAVED_PROFILE);
    const page = await openPage(`/auth-setup/${SAVED_PROFILE}`);
    await page.getByTestId('auth-setup-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    // PL-4（作業記録 UX-1 の画面 C の 5.1）: 設定があるときは、入口を確かめ直しても上書きしないので、入口の確かめの区画は出さない。
    expect(await page.getByTestId('entry-check-panel').count()).toBe(0);
    expect(await page.getByTestId('auth-setup-entry-check-draft').count()).toBe(0);
    // MI-F5（設計書 4.7.1 の 6）・PL-4: 認証の設定があるときは、ログインの送信先は入力の欄にせず、読むだけの値でも出さない。保存しても、保存した送信先のまま
    // （入口の確かめの案で埋めない）。
    await openAuthSetupAdvancedSettings(page, UI_TIMEOUT_MS);
    expect(await page.locator('[name="loginStartUrl"]').count()).toBe(0);
    expect(await page.getByTestId('auth-setup-destination-login-start-url').count()).toBe(0);
    expect(await page.getByTestId('auth-setup-destination-post-endpoints').count()).toBe(0);
    await page.getByRole('button', { name: LOCAL_UI_AUTH_TEXT.setup.save }).click();
    await page.locator('[data-testid="auth-setup-saved"], [data-testid="auth-setup-rejection"]').first().waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('auth-setup-rejection').count()).toBe(0);
    const saved = await valueOf<{ stored: { setup: Record<string, unknown> } | null }>('getAuthSetupFn', 'GET', { profileId: SAVED_PROFILE });
    expect(saved.stored?.setup).toMatchObject({
      loginStartUrl: `${siteOf().originA}/saved-login`,
      loginPostEndpoints: [{ origin: siteOf().originA, path: '/saved-session' }],
    });
  }, SCENARIO_TIMEOUT_MS);

  // MI-F3（独立レビュー MI-R の Minor 14b）: 作成の画面が、保存の後の入口の確かめの開始の応答を取れなかった（`REQUEST_FAILED`）とき、実際にはジョブが始まって
  // いることがある。プロファイルの詳細は、そのプロファイルの入口の確かめのジョブ（動いているもの・終わったもの）を、「入口を確かめる」を押す前に見られる形で出す
  // （もう一度始める案内は、ジョブがないときだけ）。画面を開くだけでは、ジョブを始めない。
  it('lists the entry check jobs of the profile when the start response was lost after saving, before pressing the button again', async () => {
    const jobId = await runEntryCheck(PUBLIC_PROFILE);
    const jobsBefore = (await valueOf<readonly unknown[]>('listAuditJobsFn', 'GET')).length;
    const page = await openPage(`/profiles/${PUBLIC_PROFILE}?saved=created&entryCheckNotStarted=REQUEST_FAILED`);
    const notice = page.getByTestId('profile-entry-check-not-started');
    await notice.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await notice.getAttribute('data-reason')).toBe('REQUEST_FAILED');
    const listed = notice.getByTestId('profile-entry-check-jobs').locator(`[data-job-id="${jobId}"]`);
    expect(await listed.getAttribute('data-state')).toBe('FINISHED');
    expect(await listed.getByRole('link').getAttribute('href')).toBe(`/jobs/${jobId}`);
    expect(await notice.textContent()).toContain(LOCAL_UI_TEXT.profileForm.entryCheckNotStarted.jobsFound);
    expect(await notice.textContent()).not.toContain(LOCAL_UI_TEXT.profileForm.entryCheckNotStarted.action);
    // 入口の確かめのジョブのないプロファイルでは、ないことと、もう一度始める案内を出す。
    const none = await openPage(`/profiles/${BROKEN_PROFILE}?entryCheckNotStarted=REQUEST_FAILED`);
    const noneNotice = none.getByTestId('profile-entry-check-not-started');
    await noneNotice.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await noneNotice.getByTestId('profile-entry-check-jobs-none').textContent()).toBe(LOCAL_UI_TEXT.profileForm.entryCheckNotStarted.noJobs);
    expect(await noneNotice.textContent()).toContain(LOCAL_UI_TEXT.profileForm.entryCheckNotStarted.action);
    // 開始を拒んだ理由のとき（応答は取れた）は、ジョブの一覧を出さない。
    const rejected = await openPage(`/profiles/${PUBLIC_PROFILE}?entryCheckNotStarted=JOB_ALREADY_ACTIVE`);
    await rejected.getByTestId('profile-entry-check-not-started').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await rejected.getByTestId('profile-entry-check-jobs').count()).toBe(0);
    expect((await valueOf<readonly unknown[]>('listAuditJobsFn', 'GET')).length).toBe(jobsBefore);
  }, SCENARIO_TIMEOUT_MS);
});

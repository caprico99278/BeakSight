/**
 * T43b（Task 43 の設計書 4.2、5 章の 1・2）: 開始の URL だけを入れてプロファイルを作ると、サーバが対象の設定のファイル
 * `local/targets/<profileId>.json` を作り、プロファイルがそれを指すことの確かめ。ビルドした画面を一時の root の起動の部品で起動し、Playwright の
 * headless の Chromium（`tests/helpers/chromium.ts` の既定）で、token の URL から開く。ファイルは一時の root にだけ書く（実際の `local/` に書かない）。
 * MI-1・MI-2（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.2、6 章の受け入れ条件 1・8。作成の画面の欄を入れる手順は、4.2 の
 * 形に合わせて直した）:
 * - PL-1（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 6 章の 1。前は隔離の扱いの 2 択と、たたんだ「詳しい設定」の欄があった）: 作成の画面に
 *   見える入力は、開始の URL・使い方の 2 択・保存の 3 つだけ。たたんだ詳しい設定もない。
 * - 開始の URL だけで、テスト環境のプロファイルを保存し、同じ押下で入口の確かめのジョブが 1 つ始まり、ジョブの画面へ移る（127.0.0.1 の fixture の
 *   サイト。届いた要求は読み取りだけ）。名前・設定のファイル・テスト環境の Origin・隔離が未確認の参照はサーバが決め、承認したサービスの Origin の
 *   項目は作らない。
 * - 開始の URL の Origin を含む設定のファイルが 1 つあれば、それを使い（ファイルを作らない・書き換えない）、2 つ以上か、別の開始の URL のものだけなら保存せずに
 *   理由を出し、拒否の知らせの中で、使うファイルか新しく作るかを選ばせる（PL-1。前は詳しい設定を開いて選び直した）。
 * - 同じ名前のファイルがあれば上書きしない（画面は名前を送らないので -2 を付けて作り、名前を送る Server Function は誤りにする）。プロファイルの内容の誤りでは、
 *   ファイルを作らない。
 * - 認証の設定の画面は、新しい設定のときだけ、開始の URL の path で監査の path と成功の画面の path を埋める（保存した設定があればその値）。
 * - 開始の URL が同じ設定のファイルを使う流れ（ファイルを作らない）。
 * - 保存に続けて入口の確かめを始められなかったときのプロファイルの詳細の知らせ（URL の search で渡す理由）を出す。
 * - すべての画面で、CSP の違反と console の誤りが 0 件、外部への要求が 0 件（どこにも接続しない）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { loadConfig } from '../../../src/config/load-config.js';
import { GENERATED_TARGET_CRAWL_LIMITS } from '../../../src/config/target-config-draft.js';
import { WORKER_ENTRY_CHECK_JOB_KIND } from '../../../src/control/worker-protocol.js';
import { formatDuration } from '../../../src/presentation/format.js';
import {
  AUDIT_JOB_START_REJECTION_DESCRIPTIONS,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_JOB_SUMMARY_TEXT,
  LOCAL_UI_TEXT,
  PROFILE_VALIDATION_ERROR_DESCRIPTIONS,
  TARGET_CONFIG_CREATION_FAILURE_DESCRIPTIONS,
  TARGET_SITE_PROBLEM_DESCRIPTIONS,
} from '../../../src/presentation/messages.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { ENTRY_CHECK_SITE_PATHS, startEntryCheckSite, type EntryCheckSite } from '../../../tests/helpers/entry-check-site.js';
import { READ_METHODS } from '../../../tests/helpers/leak-places.js';
import { AUDIT_JOB_POLL_INTERVAL_MS } from '../src/display/job-polling';
import { ISOLATION_UNVERIFIED_EVIDENCE_REF_PREFIX } from '../src/server/isolation-evidence-ref';
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
import { openAuthSetupAdvancedSettings } from './helpers/auth-setup-page.ts';
import { profileStageOf } from './helpers/next-steps.ts';
import { chooseProfileUsage, createProfileOnScreen } from './helpers/profile-form.ts';
import { settleJobsStartedByCreate, waitForJobViaServerFunctions, type ServerFunctionEntryCheckJob } from './helpers/server-function-job-wait.ts';
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';
import { saveAuthSetupRequestInStore } from './helpers/profile-store-setup.ts';

/** 画面の操作を待つ上限（ミリ秒）。 */
const UI_TIMEOUT_MS = 15_000;
const MAX_TAB_PRESSES = 60;
/** 入口の確かめのジョブが終わるのを待つ上限と、読み直しの間隔（ms。`entry-check-ui.test.ts` と同じ）。 */
const JOB_TIMEOUT_MS = 60_000;
const JOB_POLL_MS = 200;

/** テストの値（予約の名前と、使っていない 127.0.0.1 の番号。どこにも接続しない）。 */
const PUBLIC_START_URL = 'https://www.example.test/shop/';
const PUBLIC_PROFILE = 'www-example-test';
const PUBLIC_ORIGIN = 'https://www.example.test';
const TEST_START_URL = 'http://127.0.0.1:9/admin/';
const TEST_ORIGIN = 'http://127.0.0.1:9';
/** PL-1: 名前は開始の URL のホスト名から（前の場面の `127-0-0-1` と重なるので -2）。 */
const TEST_PROFILE = '127-0-0-1-2';
const START_PATH = '/admin/';
const EXISTS_PROFILE = 't43b-exists';
const INVALID_PROFILE = 't43b-invalid-profile';
/**
 * OP-1 修正の 2 回目: すでにある `config/targets/` の設定のファイル（一時の root に置く）の開始の URL と、そこから決まる名前。前は `config/targets/example.json`
 * （`https://example.com/`）を使っていたが、作成の画面の「点検を始める」で下調べが実際にそのページを読むので、どこにも接続しない予約の名前にした。
 */
const EXISTING_FILE_START_URL = 'https://existing.example.test/';
const EXISTING_FILE_CONFIG = 'config/targets/existing-site.json';
const EXISTING_FILE_PROFILE = 'existing-example-test';
const SHARED_START_URL = 'https://shared.example.test/top/';
const SHARED_ORIGIN = 'https://shared.example.test';
const SHARED_PROFILE = 'shared-example-test';
const GENERATED_DIRECTORY = 'local/targets';

const text = LOCAL_UI_TEXT.profileForm;

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let site: EntryCheckSite | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();
/** PL-1: 開始の URL だけで作ったテスト環境のプロファイルの、入口の確かめの作業の ID（自動で移ってきたときの要点の 1 行目の確かめに使う）。 */
let entryCheckJobId = '';

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

const rootPath = (): string => root?.root ?? '';

/** 一時の root の中の、作られたファイルのパス。 */
const generatedFileOf = (profileId: string): string => `${rootPath()}/${GENERATED_DIRECTORY}/${profileId}.json`;

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

/** 作成の画面の欄（ラベルは完全一致で選ぶ。「環境」などはほかのラベルに部分一致するため）。 */
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

/** 一時の root の `local/targets/` の中の、一時のファイル（書き込みの途中のもの）の名前。 */
const leftoverTemporaryFiles = (): readonly string[] => {
  const directory = `${rootPath()}/${GENERATED_DIRECTORY}`;
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('.tmp')) : [];
};

/** 一時の root の `local/targets/` に、すでにある設定のファイルを置く（中身を返す）。 */
const writeLocalTarget = (name: string, startUrl: string, allowedOrigins: readonly string[]): string => {
  mkdirSync(`${rootPath()}/${GENERATED_DIRECTORY}`, { recursive: true });
  const content = `${JSON.stringify({ target: { id: name }, site: { startUrl, allowedOrigins } })}\n`;
  writeFileSync(`${rootPath()}/${GENERATED_DIRECTORY}/${name}.json`, content, 'utf8');
  return content;
};

/** ジョブの一覧の行（入口の確かめのジョブを数える）。 */
interface JobRow {
  readonly jobId: string;
  readonly jobKind: string;
  readonly profileId: string;
}

/** ジョブが終わるまで待つ。 */
const waitForJobEnd = (jobId: string): Promise<{ state: string; active: boolean }> => waitForJobViaServerFunctions(
  (id) => valueOf<{ state: string; active: boolean }>('getAuditJobFn', 'GET', { jobId: id }),
  jobId,
  (current) => !current.active,
  { limitMs: JOB_TIMEOUT_MS, stepMs: JOB_POLL_MS },
);

/**
 * OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.3 の 3）: 作成の画面の「点検を始める」は、下調べの後に続けて点検（ログインが必要なサイトは
 * まとめて実行。手でのログインを待つ。OP-1 修正の 2 回目: ログインしなくても見られるサイトは単独の点検）を始める。この画面のテストは点検まで進めないので、続けて
 * 始めた点検を止めて、終わるまで待つ（次の場面の作業を始められるように）。始めなかったら何もしない（待ち方は共通の補助 `settleJobsStartedByCreate`）。
 */
const stopFollowUpAudit = (entryJobId: string): Promise<string | null> => settleJobsStartedByCreate(
  (id) => valueOf<ServerFunctionEntryCheckJob>('getAuditJobFn', 'GET', { jobId: id }),
  (id) => valueOf('stopAuditJobFn', 'POST', { jobId: id, force: true }),
  entryJobId,
  { limitMs: JOB_TIMEOUT_MS, stepMs: JOB_POLL_MS },
);

/**
 * OP-1 修正の 2 回目: 作成の画面で「点検を始める」を押した後、作業の画面（下調べ）へ移ったのを待ち、下調べと続けて始めた点検を片付ける（`stopFollowUpAudit`）。
 * 下調べの作業の ID を返す。
 */
const settleCreatedJobs = async (page: Page): Promise<string> => {
  await page.waitForURL(/\/jobs\/[^/]+$/u, { timeout: UI_TIMEOUT_MS });
  const entryJobId = jobIdOfPage(page);
  await stopFollowUpAudit(entryJobId);
  return entryJobId;
};

/** 保存の後に移ったジョブの画面のジョブの ID。 */
const jobIdOfPage = (page: Page): string => new URL(page.url()).pathname.split('/').at(-1) ?? '';

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  site = await startEntryCheckSite();
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
});

afterEach(async () => {
  await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  await site?.close();
  root?.remove();
});

describe('PL-1: the creation screen shows three inputs only', () => {
  it('shows only the start URL, the usage and the save button, with no isolation choice and no folded settings', async () => {
    const page = await openPage('/profiles/new');
    const startUrl = field(page, text.startUrl);
    await startUrl.waitFor({ timeout: UI_TIMEOUT_MS });
    const form = page.locator('form');
    // PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 6 章の 1。前は隔離の扱いの 2 択も見え、ほかの欄はたたんだ詳しい設定の中にあった）: 見える入力は、
    // 開始の URL、使い方の 2 択、保存のボタン（既定は「ログインして読む」）。たたんだ詳しい設定もない。
    const visibleNames = await form.locator('input, select, textarea').filter({ visible: true }).evaluateAll(
      (elements) => elements.map((element) => element.getAttribute('name')),
    );
    expect(visibleNames).toEqual(['startUrl', 'usage', 'usage']);
    expect(await form.locator('input, select, textarea').count()).toBe(3);
    expect(await form.getByRole('button').filter({ visible: true }).allTextContents()).toEqual([text.saveAndCheckEntry]);
    expect(await field(page, text.usageTestAuth).isChecked()).toBe(true);
    expect(await page.getByTestId('profile-save-entry-check-note').textContent()).toBe(text.saveAndCheckEntryNote);
    expect(await form.locator('details').count()).toBe(0);
    expect(await page.getByTestId('profile-isolation').count()).toBe(0);
    expect(await page.locator('[name="approvedServiceOrigins"], [name="environmentEvidenceRef"], [name="profileId"]').count()).toBe(0);

    // OP-1 修正の 2 回目（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.3 の 3。設計者の判断「公開のサイトも点検を始める 1 つ」。前は、公開の画面だけに
    // すると説明が消え、ボタンは「保存する」だった）: ログインしなくても見られるサイトでも、ボタンは「点検を始める」1 つ。説明は、ログインの文のない形になる。
    await chooseProfileUsage(page, 'PUBLIC', UI_TIMEOUT_MS);
    await expect.poll(() => page.getByTestId('profile-save-entry-check-note').textContent(), { timeout: UI_TIMEOUT_MS }).toBe(text.saveAndCheckEntryNotePublic);
    expect(await form.getByRole('button').filter({ visible: true }).allTextContents()).toEqual([text.saveAndCheckEntry]);
    expect(await form.getByRole('button', { name: text.save, exact: true }).count()).toBe(0);
  });

  it('saves a test profile from the start URL only, starts one entry check with the same press, and opens its job', async () => {
    const startUrl = `${siteOf().originA}${ENTRY_CHECK_SITE_PATHS.prefilled}`;
    const profileId = '127-0-0-1';
    const jobsBefore = await valueOf<readonly JobRow[]>('listAuditJobsFn', 'GET');
    const requestsBefore = siteOf().requests.length;
    const page = await openPage('/profiles/new');
    // 入力は 1（開始の URL）、選択は 1（使い方。既定のまま）、押下は 1。
    await field(page, text.startUrl).fill(startUrl);
    await page.getByRole('button', { name: text.saveAndCheckEntry }).click();
    await page.waitForURL(/\/jobs\/[^/]+$/u, { timeout: UI_TIMEOUT_MS });

    // 入口の確かめのジョブが 1 つだけ始まった（ジョブの記録で数える）。
    const jobs = (await valueOf<readonly JobRow[]>('listAuditJobsFn', 'GET')).filter((job) => !jobsBefore.some((before) => before.jobId === job.jobId));
    expect(jobs.map((job) => [job.profileId, job.jobKind])).toEqual([[profileId, WORKER_ENTRY_CHECK_JOB_KIND]]);
    expect(jobs[0]?.jobId).toBe(jobIdOfPage(page));
    entryCheckJobId = jobIdOfPage(page);
    expect((await waitForJobEnd(entryCheckJobId)).state).toBe('FINISHED');
    await stopFollowUpAudit(entryCheckJobId);
    // fixture のサイトに届いたのは読み取りだけ（ログインしない）。開始の URL を読んだ。
    const requests = siteOf().requests.slice(requestsBefore);
    expect(requests.filter((request) => !READ_METHODS.has(request.method))).toEqual([]);
    expect(requests.some((request) => request.method === 'GET' && request.path === ENTRY_CHECK_SITE_PATHS.prefilled)).toBe(true);

    // 隠す値はサーバが決めた: 名前、作ったファイル、テスト環境の Origin、隔離が未確認の参照。承認したサービスの Origin の項目はない。
    const saved = await valueOf<{ profile: Record<string, unknown> }>('getProfileFn', 'GET', { profileId });
    expect(saved.profile).toMatchObject({
      targetConfigPath: `${GENERATED_DIRECTORY}/${profileId}.json`,
      environment: 'TEST',
      mode: 'TEST_AUTH_PASSIVE',
      auth: 'MANUAL_SESSION',
      approvedTestOrigins: [siteOf().originA],
    });
    expect(String(saved.profile['environmentEvidenceRef'])).toMatch(new RegExp(`^${ISOLATION_UNVERIFIED_EVIDENCE_REF_PREFIX}[0-9]{8}$`, 'u'));
    expect(Object.hasOwn(saved.profile, 'approvedServiceOrigins')).toBe(false);
    expect(JSON.parse(readFileSync(generatedFileOf(profileId), 'utf8'))).toMatchObject({ site: { startUrl, allowedOrigins: [siteOf().originA] } });
  });

  it('uses the one existing file of the same site and start URL, and lets the person choose in the rejection when it starts elsewhere or when there are two', async () => {
    const content = writeLocalTarget('shared-site', SHARED_START_URL, [SHARED_ORIGIN]);
    const page = await openPage('/profiles/new');
    await field(page, text.startUrl).fill(SHARED_START_URL);
    await chooseProfileUsage(page, 'PUBLIC', UI_TIMEOUT_MS);
    await page.getByRole('button', { name: text.saveAndCheckEntry }).click();
    // OP-1 修正の 2 回目（設計者の判断。前はサイトの画面へ移り、保存の知らせを出した）: ログインしなくても見られるサイトも、保存に続けて下調べの作業の画面へ移る。
    await settleCreatedJobs(page);
    const saved = await valueOf<{ profile: { targetConfigPath: string } }>('getProfileFn', 'GET', { profileId: SHARED_PROFILE });
    expect(saved.profile.targetConfigPath).toBe(`${GENERATED_DIRECTORY}/shared-site.json`);
    // 新しい名前のファイルを作らない。すでにあるファイルの中身を書き換えない。
    expect(existsSync(generatedFileOf(SHARED_PROFILE))).toBe(false);
    expect(readFileSync(generatedFileOf('shared-site'), 'utf8')).toBe(content);

    // MI-C: 同じサイトで開始の URL が違うファイルしかないときは、新しいファイルを作らずに、理由を出す。PL-1（UX-1 の画面 A の 4.2。前は詳しい設定を開いて
    // 選び直した）: 知らせの中で、候補のファイルか「開始のアドレスから新しく作る」を選ぶ。
    const otherStart = await openPage('/profiles/new');
    await field(otherStart, text.startUrl).fill(`${SHARED_ORIGIN}/other/`);
    await chooseProfileUsage(otherStart, 'PUBLIC', UI_TIMEOUT_MS);
    await otherStart.getByRole('button', { name: text.saveAndCheckEntry }).click();
    await otherStart.getByText(text.targetConfigStartUrlMismatch.description).waitFor({ timeout: UI_TIMEOUT_MS });
    const mismatch = otherStart.getByTestId('profile-target-config-ambiguous');
    expect(await mismatch.getAttribute('data-reason')).toBe('TARGET_CONFIG_START_URL_MISMATCH');
    const choice = mismatch.getByTestId('profile-target-choice');
    expect(await choice.locator('input[type="radio"]').evaluateAll((items) => items.map((item) => (item as HTMLInputElement).value)))
      .toEqual([`${GENERATED_DIRECTORY}/shared-site.json`, 'NEW']);
    expect(otherStart.url()).toMatch(/\/profiles\/new$/u);
    expect(await valueOf('getProfileFn', 'GET', { profileId: `${SHARED_PROFILE}-2` })).toBeNull();
    // 新しいファイルを作らない。
    expect(existsSync(generatedFileOf(SHARED_PROFILE))).toBe(false);
    expect(existsSync(generatedFileOf(`${SHARED_PROFILE}-2`))).toBe(false);
    // 選んでいる間は知らせが残る。「開始のアドレスから新しく作る」を選んで保存し直すと、開始のアドレスから新しいファイルを作る（名前は -2）。
    await choice.getByLabel(text.targetSourceNew, { exact: true }).check();
    expect(await mismatch.count()).toBe(1);
    await otherStart.getByRole('button', { name: text.saveAndCheckEntry }).click();
    await settleCreatedJobs(otherStart);
    expect((await valueOf<{ profile: { targetConfigPath: string } }>('getProfileFn', 'GET', { profileId: `${SHARED_PROFILE}-2` })).profile.targetConfigPath)
      .toBe(`${GENERATED_DIRECTORY}/${SHARED_PROFILE}-2.json`);
    expect(JSON.parse(readFileSync(generatedFileOf(`${SHARED_PROFILE}-2`), 'utf8'))).toMatchObject({ site: { startUrl: `${SHARED_ORIGIN}/other/` } });
    expect(readFileSync(generatedFileOf('shared-site'), 'utf8')).toBe(content);

    // 同じサイトで開始の URL も同じファイルが 2 つになると、保存せずに理由を出し、知らせの中で使うファイルを選ぶ。
    writeLocalTarget('shared-site-copy', SHARED_START_URL, [SHARED_ORIGIN]);
    const again = await openPage('/profiles/new');
    await field(again, text.startUrl).fill(SHARED_START_URL);
    await chooseProfileUsage(again, 'PUBLIC', UI_TIMEOUT_MS);
    await again.getByRole('button', { name: text.saveAndCheckEntry }).click();
    await again.getByText(text.targetConfigAmbiguous.description).waitFor({ timeout: UI_TIMEOUT_MS });
    const ambiguous = again.getByTestId('profile-target-config-ambiguous');
    expect(await ambiguous.getAttribute('data-reason')).toBe('TARGET_CONFIG_AMBIGUOUS');
    expect(await ambiguous.locator('code').allTextContents())
      .toEqual([`${GENERATED_DIRECTORY}/shared-site-copy.json`, `${GENERATED_DIRECTORY}/shared-site.json`]);
    expect(again.url()).toMatch(/\/profiles\/new$/u);
    expect(await valueOf('getProfileFn', 'GET', { profileId: `${SHARED_PROFILE}-3` })).toBeNull();
    // 開始のアドレスを直すと、選択は消え、初めの決め方に戻る（古い選択のまま送らない）。
    await field(again, text.startUrl).fill(`${SHARED_START_URL}?`);
    await ambiguous.waitFor({ state: 'detached', timeout: UI_TIMEOUT_MS });
    await field(again, text.startUrl).fill(SHARED_START_URL);
    await again.getByRole('button', { name: text.saveAndCheckEntry }).click();
    await ambiguous.waitFor({ timeout: UI_TIMEOUT_MS });
    await ambiguous.locator(`input[value="${GENERATED_DIRECTORY}/shared-site-copy.json"]`).check();
    await again.getByRole('button', { name: text.saveAndCheckEntry }).click();
    await settleCreatedJobs(again);
    expect((await valueOf<{ profile: { targetConfigPath: string } }>('getProfileFn', 'GET', { profileId: `${SHARED_PROFILE}-3` })).profile.targetConfigPath)
      .toBe(`${GENERATED_DIRECTORY}/shared-site-copy.json`);
  });

  it('shows on the profile detail that the entry check could not be started after saving', async () => {
    // テスト環境のプロファイル（前の場面で、開始の URL だけで作ったもの）。
    const profileId = '127-0-0-1';
    const page = await openPage(`/profiles/${profileId}?saved=created&entryCheckNotStarted=PROFILE_REVISION_CONFLICT`);
    const notice = page.getByTestId('profile-entry-check-not-started');
    await notice.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await notice.getAttribute('data-reason')).toBe('PROFILE_REVISION_CONFLICT');
    expect(await notice.textContent()).toContain(AUDIT_JOB_START_REJECTION_DESCRIPTIONS.PROFILE_REVISION_CONFLICT.description);
    expect(await notice.textContent()).toContain(text.entryCheckNotStarted.action);
    expect(await page.getByText(text.entryCheckNotStarted.heading).count()).toBe(1);
    // 「入口を確かめ直す」のボタンは 1 つ（PL-1: 要点のパネルの主のボタンか、詳しい内容の中）。
    expect(await page.locator('main [data-action="RECHECK_ENTRY"]').count()).toBe(1);
    // 閉じた一覧にない値は受けない（知らせを出さない）。
    const unknown = await openPage(`/profiles/${profileId}?entryCheckNotStarted=NOT_A_REASON`);
    await unknown.getByTestId('profile-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await unknown.getByTestId('profile-entry-check-not-started').count()).toBe(0);
    // MI-C（MI-1 の発見事項 1）: 保存の知らせ（`saved`）も、閉じた一覧にない値では出さない（空の知らせの枠を出さない）。一覧の値なら出す。
    // 知らせの数は、search のない画面（ほかの欄の知らせだけ）と同じ。
    const plain = await openPage(`/profiles/${profileId}`);
    await plain.getByTestId('profile-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    const positiveNotices = await plain.locator('.notice--positive').count();
    const unknownSaved = await openPage(`/profiles/${profileId}?saved=foo&savedRevision=1`);
    await unknownSaved.getByTestId('profile-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await unknownSaved.locator('.notice--positive').count()).toBe(positiveNotices);
    const knownSaved = await openPage(`/profiles/${profileId}?saved=updated`);
    await knownSaved.locator('.notice--positive').filter({ hasText: text.updated }).waitFor({ timeout: UI_TIMEOUT_MS });
    // PL-1: 自動で移ってきた印の作業が、ほかのサイトの作業のときと、ない作業のときは、要点の 1 行目の結果の文を出さない（印のない画面と同じ）。
    expect(entryCheckJobId).not.toBe('');
    const otherSite = await openPage(`/profiles/${SHARED_PROFILE}?arrived=auto&fromJob=${entryCheckJobId}`);
    await otherSite.getByTestId('profile-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await otherSite.getByTestId('profile-arrival').count()).toBe(0);
    const missingJob = await openPage(`/profiles/${profileId}?arrived=auto&fromJob=job-does-not-exist`);
    await missingJob.getByTestId('profile-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await missingJob.getByTestId('profile-arrival').count()).toBe(0);
    // 同じサイトの作業なら、出す（読んだ作業の記録の事実だけ。文は作業の画面の要点と同じ結果の文）。
    const { summary } = await valueOf<{ summary: { result: keyof typeof LOCAL_UI_JOB_SUMMARY_TEXT.finished } }>('getAuditJobFn', 'GET', { jobId: entryCheckJobId });
    const sameSite = await openPage(`/profiles/${profileId}?arrived=auto&fromJob=${entryCheckJobId}`);
    const arrival = sameSite.getByTestId('profile-arrival');
    await arrival.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await arrival.getAttribute('data-result')).toBe(summary.result);
    expect(await arrival.textContent()).toBe(LOCAL_UI_JOB_SUMMARY_TEXT.finished[summary.result]);
    expect(await sameSite.getByTestId('profile-summary').locator('p').first().getAttribute('data-testid')).toBe('profile-arrival');
  });
});

describe('T43b: creating a profile from the start URL only', () => {
  it('checks the start URL before sending', async () => {
    const page = await openPage('/profiles/new');
    const startUrl = field(page, text.startUrl);
    await startUrl.waitFor({ timeout: UI_TIMEOUT_MS });
    // PL-1: 名前・許可 Origin の案の欄（placeholder）は、作成の画面から消した（名前はサーバが開始のアドレスから決める）。受けない開始の URL は、保存の前に欄の
    // 誤りになる（何も送らない）。
    await startUrl.fill('https://third.example.test/#top');
    await page.getByRole('button', { name: text.saveAndCheckEntry }).click();
    await page.getByText(TARGET_SITE_PROBLEM_DESCRIPTIONS.START_URL_HAS_FRAGMENT).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await startUrl.getAttribute('aria-invalid')).toBe('true');
    expect(existsSync(generatedFileOf('third-example-test'))).toBe(false);
  });

  it('saves with the start URL only, writes local/targets/<id>.json, and reaches the start screen by links (public mode)', async () => {
    const page = await openPage('/profiles/new');
    await field(page, text.startUrl).fill(PUBLIC_START_URL);
    await chooseProfileUsage(page, 'PUBLIC', UI_TIMEOUT_MS);
    await page.getByRole('button', { name: text.saveAndCheckEntry }).click();
    // OP-1 修正の 2 回目（設計者の判断。前はサイトの画面へ移り、保存の知らせを出した）: 保存に続けて下調べの作業の画面へ移る。
    const entryJobId = await settleCreatedJobs(page);

    // ファイル: 中身は target.id・site・負荷と出力。負荷は最初の読み込みのための控えめな値（最大 3 ページ、間隔 10 秒。T43b fix round 2）で、
    // ほかの負荷と出力は既定値。CLI の loadConfig で読める。一時のファイルは残らない。
    const path = generatedFileOf(PUBLIC_PROFILE);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      target: { id: PUBLIC_PROFILE },
      site: { startUrl: PUBLIC_START_URL, allowedOrigins: [PUBLIC_ORIGIN] },
      crawl: { ...DEFAULT_CONFIG.crawl, maxPages: GENERATED_TARGET_CRAWL_LIMITS.maxPages, minNavigationIntervalMs: GENERATED_TARGET_CRAWL_LIMITS.minNavigationIntervalMs },
      output: DEFAULT_CONFIG.output,
    });
    const loaded = await loadConfig(path);
    expect(loaded.site).toEqual({ startUrl: PUBLIC_START_URL, allowedOrigins: [PUBLIC_ORIGIN] });
    expect([loaded.crawl.maxPages, loaded.crawl.minNavigationIntervalMs])
      .toEqual([GENERATED_TARGET_CRAWL_LIMITS.maxPages, GENERATED_TARGET_CRAWL_LIMITS.minNavigationIntervalMs]);
    expect(leftoverTemporaryFiles()).toEqual([]);

    // プロファイルは作ったファイルを指す。
    const saved = await valueOf<{ profile: { targetConfigPath: string; environment: string; mode: string; environmentEvidenceRef: string | null } }>(
      'getProfileFn', 'GET', { profileId: PUBLIC_PROFILE },
    );
    expect(saved.profile).toMatchObject({
      targetConfigPath: `${GENERATED_DIRECTORY}/${PUBLIC_PROFILE}.json`,
      environment: 'PUBLIC',
      mode: 'PUBLIC_PASSIVE',
      environmentEvidenceRef: null,
    });
    // OP-1 修正の 2 回目（前は「公開の画面だけなので、入口の確かめは自動で始めない」）: 同じ押下で、このサイトの下調べの作業が 1 つ始まった（ジョブの記録で数える）。
    const jobs = (await valueOf<readonly JobRow[]>('listAuditJobsFn', 'GET')).filter((job) => job.profileId === PUBLIC_PROFILE);
    expect(jobs.filter((job) => job.jobKind === WORKER_ENTRY_CHECK_JOB_KIND).map((job) => job.jobId)).toEqual([entryJobId]);

    // サイトの画面の要点の「点検を始める」→ 監査の開始の画面（リンクだけ、キーボードで）。
    await page.goto(`${started().origin}/profiles/${PUBLIC_PROFILE}`);
    expect(await profileStageOf(page, UI_TIMEOUT_MS)).toBe('AUDIT_PUBLIC');
    await tabTo(page, page.getByTestId('profile-summary').getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit }));
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/start/${PUBLIC_PROFILE}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    // PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: 開始のアドレスと間隔は、たたんだ詳しい内容の中。
    await page.getByTestId('start-target').waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('start-target').textContent()).toContain(PUBLIC_START_URL);
    // 開始の画面にも、作ったファイルの間隔（10 秒）が出る。
    expect(await page.getByTestId('start-interval').textContent()).toBe(formatDuration(GENERATED_TARGET_CRAWL_LIMITS.minNavigationIntervalMs));
  });

  it('does not overwrite a file with the same name, and does not create the profile', async () => {
    const existing = writeLocalTarget(EXISTS_PROFILE, 'https://kept.example.test/', ['https://kept.example.test']);

    // PL-1: 作成の画面は名前を送らない。開始のアドレスからの名前の案が、すでにあるファイルの名前と重なるときは、サーバが -2 を付けて新しく作る（上書きしない）。
    const page = await openPage('/profiles/new');
    await field(page, text.startUrl).fill(`https://${EXISTS_PROFILE}/`);
    await chooseProfileUsage(page, 'PUBLIC', UI_TIMEOUT_MS);
    await page.getByRole('button', { name: text.saveAndCheckEntry }).click();
    await settleCreatedJobs(page);
    expect(await valueOf('getProfileFn', 'GET', { profileId: `${EXISTS_PROFILE}-2` })).not.toBeNull();
    expect(readFileSync(generatedFileOf(EXISTS_PROFILE), 'utf8')).toBe(existing);
    expect(await valueOf('getProfileFn', 'GET', { profileId: EXISTS_PROFILE })).toBeNull();

    // 名前を直接送る作成（Server Function）でも、同じ名前のファイルがあれば上書きせず、誤りにする（プロファイルも作らない）。
    expect(await valueOf('createProfileFn', 'POST', {
      targetChoice: 'NEW',
      profile: {
        schemaVersion: 'beaksight-profile/1', profileId: EXISTS_PROFILE, revision: 1, environment: 'PUBLIC', mode: 'PUBLIC_PASSIVE', auth: 'NONE',
        approvedTestOrigins: [], environmentEvidenceRef: null,
      },
      newTargetSite: { startUrl: 'https://new.example.test/', allowedOrigins: ['https://new.example.test'] },
    })).toMatchObject({ ok: false, reason: 'TARGET_CONFIG_EXISTS' });
    expect(readFileSync(generatedFileOf(EXISTS_PROFILE), 'utf8')).toBe(existing);
    expect(await valueOf('getProfileFn', 'GET', { profileId: EXISTS_PROFILE })).toBeNull();
    expect(leftoverTemporaryFiles()).toEqual([]);
    expect(TARGET_CONFIG_CREATION_FAILURE_DESCRIPTIONS.TARGET_CONFIG_EXISTS.description.length).toBeGreaterThan(0);
  });

  it('does not write the file when the profile itself is rejected, nor for a rejected site sent directly', async () => {
    // テスト環境の Origin を、対象の許可 Origin の外にする（プロファイルの検証が拒む）。PL-1: 作成の画面にはこの欄がないので、Server Function を直接呼ぶ。
    const rejectedProfile = {
      schemaVersion: 'beaksight-profile/1', profileId: INVALID_PROFILE, revision: 1, environment: 'TEST', mode: 'TEST_AUTH_PASSIVE', auth: 'MANUAL_SESSION',
      approvedTestOrigins: ['https://elsewhere.example.test'], environmentEvidenceRef: 't43b-evidence',
    };
    expect(await valueOf('createProfileFn', 'POST', {
      targetChoice: 'NEW',
      profile: rejectedProfile,
      newTargetSite: { startUrl: 'https://outside.example.test/', allowedOrigins: ['https://outside.example.test'] },
    })).toMatchObject({ ok: false, reason: 'PROFILE_INVALID', errorCodes: ['PROFILE_TEST_ORIGIN_OUTSIDE_TARGET'] });
    expect(PROFILE_VALIDATION_ERROR_DESCRIPTIONS.PROFILE_TEST_ORIGIN_OUTSIDE_TARGET.length).toBeGreaterThan(0);
    expect(existsSync(generatedFileOf(INVALID_PROFILE))).toBe(false);

    // Server Function を直接呼んでも、受けない開始の URL ではファイルを作らない。
    const profile = {
      schemaVersion: 'beaksight-profile/1',
      profileId: 't43b-direct',
      revision: 1,
      targetConfigPath: `${GENERATED_DIRECTORY}/t43b-direct.json`,
      environment: 'PUBLIC',
      mode: 'PUBLIC_PASSIVE',
      auth: 'NONE',
      approvedTestOrigins: [],
      environmentEvidenceRef: null,
    };
    expect(await valueOf('createProfileFn', 'POST', {
      targetChoice: 'NEW',
      profile,
      newTargetSite: { startUrl: 'https://user:secret@direct.example.test/', allowedOrigins: ['https://direct.example.test'] },
    })).toEqual({ ok: false, reason: 'TARGET_SITE_INVALID', siteProblems: ['START_URL_HAS_CREDENTIALS'] });
    // 名前の形に合わない ID では、パスを作らない（任意のパスに書かない）。
    expect(await valueOf('createProfileFn', 'POST', {
      targetChoice: 'NEW',
      profile: { ...profile, profileId: '../escape' },
      newTargetSite: { startUrl: 'https://direct.example.test/', allowedOrigins: ['https://direct.example.test'] },
    })).toMatchObject({ ok: false, reason: 'PROFILE_INVALID', errorCodes: ['PROFILE_ID_INVALID'] });
    // T43R-fix-D（M-6）・PL-U（設計書 14.1 の U7）: Windows の予約名の名前は、ファイルの名前にしない。拒まずに、番号を付けた名前で作る（作成の画面に名前の
    // 欄はないので、「別の名前にしてから」と言わない）。
    expect(await valueOf('createProfileFn', 'POST', {
      targetChoice: 'NEW',
      profile: { ...profile, profileId: 'con' },
      newTargetSite: { startUrl: 'https://direct.example.test/', allowedOrigins: ['https://direct.example.test'] },
    })).toMatchObject({ ok: true });
    expect(await valueOf('getProfileFn', 'GET', { profileId: 'con' })).toBeNull();
    expect(await valueOf('getProfileFn', 'GET', { profileId: 'con-2' })).toMatchObject({ profile: { targetConfigPath: 'local/targets/con-2.json' } });
    expect(existsSync(generatedFileOf('con'))).toBe(false);
    expect(existsSync(generatedFileOf('t43b-direct'))).toBe(false);
    expect(existsSync(`${rootPath()}/local/escape.json`)).toBe(false);
    expect(leftoverTemporaryFiles()).toEqual([]);
  });

  it('copies the allowed origin to the test origins in a test mode, and fills the new auth setup from the start URL path', async () => {
    const jobsBefore = await valueOf<readonly JobRow[]>('listAuditJobsFn', 'GET');
    const page = await openPage('/profiles/new');
    await field(page, text.startUrl).fill(TEST_START_URL);
    await page.getByRole('button', { name: text.saveAndCheckEntry }).click();
    // MI-2: テスト環境なので、保存に続けて入口の確かめを始め、ジョブの画面へ移る（127.0.0.1:9 には何も待ち受けていない。終わるまで待つ）。
    await page.waitForURL(/\/jobs\/[^/]+$/u, { timeout: UI_TIMEOUT_MS });
    const entryJobId = jobIdOfPage(page);
    await waitForJobEnd(entryJobId);
    await stopFollowUpAudit(entryJobId);
    // PL-1: 名前は開始のアドレスから決まる（前の場面の `127-0-0-1` と重なるので -2）。
    const [job] = (await valueOf<readonly JobRow[]>('listAuditJobsFn', 'GET')).filter((row) => !jobsBefore.some((before) => before.jobId === row.jobId));
    expect(job?.profileId).toBe(TEST_PROFILE);
    const saved = await valueOf<{ profile: { targetConfigPath: string; approvedTestOrigins: readonly string[] } }>(
      'getProfileFn', 'GET', { profileId: TEST_PROFILE },
    );
    expect(saved.profile).toMatchObject({ targetConfigPath: `${GENERATED_DIRECTORY}/${TEST_PROFILE}.json`, approvedTestOrigins: [TEST_ORIGIN] });

    // 新しい認証の設定: 監査の path と成功の画面の path は開始の URL の path。除外の path は今の既定（空）のまま。
    const setupText = LOCAL_UI_AUTH_TEXT.setup;
    const setup = await openPage(`/auth-setup/${TEST_PROFILE}`);
    await openAuthSetupAdvancedSettings(setup, UI_TIMEOUT_MS);
    await setup.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await field(setup, setupText.auditPathPrefixes).inputValue()).toBe(START_PATH);
    expect(await field(setup, setupText.successPathPrefix).inputValue()).toBe(START_PATH);
    expect(await field(setup, setupText.excludedPaths).inputValue()).toBe('');

    // 保存した設定があれば、その値を出す（案で上書きしない）。
    expect(await saveAuthSetupRequestInStore(root, {
      setup: {
        ...FORM_NAVIGATION_SETUP_ITEMS,
        profileId: TEST_PROFILE,
        profileRevision: 1,
        loginStartUrl: `${TEST_ORIGIN}/login`,
        loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/login' }],
        successCondition: { pathPrefix: '/admin/home/', selector: '#admin-ok' },
        sessionLostCondition: { pathPrefix: null },
        excludedPaths: ['/admin/logout'],
        auditPathPrefixes: ['/admin/reports/'],
        maxLoginAttempts: 1,
        allowedIdpOrigins: [],
        automatedLogin: null,
      },
    })).toMatchObject({ ok: true });
    const reopened = await openPage(`/auth-setup/${TEST_PROFILE}`);
    await openAuthSetupAdvancedSettings(reopened, UI_TIMEOUT_MS);
    await reopened.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await field(reopened, setupText.auditPathPrefixes).inputValue()).toBe('/admin/reports/');
    expect(await field(reopened, setupText.successPathPrefix).inputValue()).toBe('/admin/home/');
  });

  it('keeps the existing file flow: the start URL of an existing file creates no file', async () => {
    // PL-1: 前は詳しい設定で「すでにある設定のファイルを使う」を選んでいた。今は、開始のアドレスが同じ設定のファイルが 1 つあれば、それを使う。
    const existing = `${JSON.stringify({ target: { id: 'existing-site' }, site: { startUrl: EXISTING_FILE_START_URL, allowedOrigins: [new URL(EXISTING_FILE_START_URL).origin] } })}
`;
    writeFileSync(`${rootPath()}/${EXISTING_FILE_CONFIG}`, existing, 'utf8');
    const page = await openPage('/profiles/new');
    await field(page, text.startUrl).fill(EXISTING_FILE_START_URL);
    await chooseProfileUsage(page, 'PUBLIC', UI_TIMEOUT_MS);
    await page.getByRole('button', { name: text.saveAndCheckEntry }).click();
    // OP-1 修正の 2 回目（前はサイトの画面へ移り、保存の知らせを出した）: 保存に続けて下調べの作業の画面へ移る。
    await settleCreatedJobs(page);
    const saved = await valueOf<{ profile: { targetConfigPath: string } }>('getProfileFn', 'GET', { profileId: EXISTING_FILE_PROFILE });
    expect(saved.profile.targetConfigPath).toBe(EXISTING_FILE_CONFIG);
    expect(readFileSync(`${rootPath()}/${EXISTING_FILE_CONFIG}`, 'utf8')).toBe(existing);
    expect(existsSync(generatedFileOf(EXISTING_FILE_PROFILE))).toBe(false);
  });
});

/** 作業の要点の、確かめに使う項目（`getAuditJobFn` の応答の一部）。 */
interface JobWithSummary {
  readonly jobKind: string;
  readonly active: boolean;
  readonly lastAuthState: string | null;
  readonly stopRequestedAt: string | null;
  readonly runEnd: unknown;
  readonly stageChain: unknown;
  readonly entryCheckFollowUp: { readonly state: string; readonly jobId?: string } | null;
  readonly summary: { readonly result: string; readonly advance: unknown };
}

describe('OP-1 fix round 2: one button for a public site, and a stopped audit stays on the job screen (the real worker)', () => {
  // 設計者の判断（OP 設計書 4.1.3 の 3）: ログインしなくても見られるサイトも、作成の画面のボタンは「点検を始める」1 つ。保存 → 下調べ → 点検（単独の点検）へ、ジョブの
  // 管理が進める。127.0.0.1 の fixture のサイト（届いた要求は読み取りだけ）。
  it('saves a public site, starts the entry check and then the single audit with the same press, and opens the audit job', async () => {
    const startUrl = `${siteOf().originA}${ENTRY_CHECK_SITE_PATHS.twoPasswords}`;
    // PL-1: 名前は開始のアドレスのホスト名から（前の場面の `127-0-0-1` と `-2` と重なるので -3）。
    const profileId = '127-0-0-1-3';
    const jobsBefore = await valueOf<readonly JobRow[]>('listAuditJobsFn', 'GET');
    const requestsBefore = siteOf().requests.length;
    const page = await openPage('/profiles/new');
    // 作業の画面が移った先を記録する（点検が早く終わると、点検の作業の画面からサイトの画面へ、さらに移るため）。
    const visited: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        visited.push(new URL(frame.url()).pathname);
      }
    });
    // 入力は 1（開始の URL）、選択は 1（使い方）、押下は 1。同じサイトの設定のファイル（前の場面のもの）が別の開始のアドレスなので、拒否の知らせの中で「開始の
    // アドレスから新しく作る」を選んで押し直す（MI-C の今の流れ）。
    await createProfileOnScreen(page, { startUrl, usage: 'PUBLIC', targetConfigPath: 'NEW' }, UI_TIMEOUT_MS);
    await page.waitForURL(/\/jobs\/[^/]+$/u, { timeout: UI_TIMEOUT_MS });
    const entryJobId = jobIdOfPage(page);
    expect(await valueOf<{ profile: Record<string, unknown> }>('getProfileFn', 'GET', { profileId })).toMatchObject({
      profile: { environment: 'PUBLIC', mode: 'PUBLIC_PASSIVE', auth: 'NONE' },
    });

    // 下調べが終わると、ジョブの管理が続けて単独の点検（まとめて実行ではない）を始め、作業の画面がその作業へ移る。
    const entry = await waitForJobViaServerFunctions(
      (id) => valueOf<JobWithSummary>('getAuditJobFn', 'GET', { jobId: id }),
      entryJobId,
      (current) => !current.active && current.entryCheckFollowUp?.state !== 'WAITING',
      { limitMs: JOB_TIMEOUT_MS, stepMs: JOB_POLL_MS },
    );
    expect(entry).toMatchObject({ jobKind: WORKER_ENTRY_CHECK_JOB_KIND, entryCheckFollowUp: { state: 'STARTED' } });
    const auditJobId = entry.entryCheckFollowUp?.jobId ?? '';
    await expect.poll(() => visited.includes(`/jobs/${auditJobId}`), { timeout: JOB_TIMEOUT_MS }).toBe(true);
    const audit = await valueOf<JobWithSummary>('getAuditJobFn', 'GET', { jobId: auditJobId });
    expect(audit).toMatchObject({ jobKind: 'AUDIT', stageChain: null });
    const jobs = (await valueOf<readonly JobRow[]>('listAuditJobsFn', 'GET')).filter((job) => !jobsBefore.some((before) => before.jobId === job.jobId));
    expect(jobs.map((job) => [job.profileId, job.jobKind]).sort()).toEqual([[profileId, 'AUDIT'], [profileId, WORKER_ENTRY_CHECK_JOB_KIND]]);
    await stopFollowUpAudit(entryJobId);
    // fixture のサイトに届いたのは読み取りだけ。
    expect(siteOf().requests.slice(requestsBefore).filter((request) => !READ_METHODS.has(request.method))).toEqual([]);
  });

  // PL 設計書 14.1 の末尾の U1: 利用者が「止める」で止めた点検は、作業の画面に残す。ログインを待つ間に止めると、Run がまだなく、Run の終わりの記録がない。
  // それでも、ジョブに残る止める要求の記録で、止めた点検と分かり、作業の画面に残る（前は、サイトの画面へ移っていた）。本物のワーカーの単独の点検（手でのログイン）。
  it('keeps the job screen when the person stops a single audit while it waits for the manual login', async () => {
    // 前の場面で、開始の URL だけで作ったログインが必要なサイト（下調べがログインの画面を見つけ、ログインの設定を案で保存した）。
    const profileId = '127-0-0-1';
    const { profile } = await valueOf<{ profile: { revision: number } }>('getProfileFn', 'GET', { profileId });
    const start = await valueOf<{ ok: boolean; jobId: string }>('startAuditJobFn', 'POST', { profileId, expectedRevision: profile.revision, startNew: true });
    expect(start).toMatchObject({ ok: true });
    const page = await openPage(`/jobs/${start.jobId}`);
    const read = (id: string): Promise<JobWithSummary> => valueOf<JobWithSummary>('getAuditJobFn', 'GET', { jobId: id });
    await waitForJobViaServerFunctions(read, start.jobId, (job) => job.lastAuthState === 'AWAITING_LOGIN', { limitMs: JOB_TIMEOUT_MS, stepMs: JOB_POLL_MS });
    expect(await valueOf('stopAuditJobFn', 'POST', { jobId: start.jobId, force: false })).toMatchObject({ ok: true });
    const ended = await waitForJobViaServerFunctions(read, start.jobId, (job) => !job.active, { limitMs: JOB_TIMEOUT_MS, stepMs: JOB_POLL_MS });
    // ログインを待つ間に止めたので、Run の終わりの記録はない。止める要求の記録は残る。サーバの判定は、移さない。本物のワーカーでは、この作業は中断（`INTERRUPTED`）で
    // 終わるので、前の判定（Run の終わりの理由だけを見る）でも移さなかった。前の判定で移ったのは、Run の終わりの記録なしに終わった点検（偽のワーカー
    // `manual-login-confirm-ui`）と、止めた下調べ（続けて始めるかの判定が先）のとき。ここでは、本物のワーカーで止める要求の記録が残ることを確かめる。
    expect(ended).toMatchObject({ jobKind: 'AUDIT', stageChain: null, runEnd: null });
    expect(ended.stopRequestedAt).not.toBeNull();
    expect(ended.summary.advance).toBeNull();
    // 画面は、終わった作業の要点を出したまま、作業の画面に残る。
    // 作業の画面の読み直しの間隔の 2 回分を待つ（移すなら、その間に移る）。
    await page.waitForTimeout(AUDIT_JOB_POLL_INTERVAL_MS * 2);
    expect(new URL(page.url()).pathname).toBe(`/jobs/${start.jobId}`);
  });
});

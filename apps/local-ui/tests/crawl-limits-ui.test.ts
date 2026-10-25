/**
 * T44d（Task 44 の設計書 P2-1。設計の変更の履歴の T44d の行の案 (a)）: プロファイルの画面の「監査の負荷」（ページの上限・時間の上限・読み込みの間隔）を、
 * ビルドした画面のサーバ（一時の root）と headless の Chromium（`tests/helpers/chromium.ts` の既定）で確かめる。
 * - 今の値と、読み込みの間隔の下限（許可 Origin にループバックでないものがあるので 1 秒）を出す。
 * - 確認のダイアログに、変える前と後の値（変えた項目だけ）と、途中の Run があれば再開されない旨（いつも）を出す（承認の旨は、書き込みのモードの
 *   `scenario-ui.test.ts`）。取り消すと書かない。確定すると設定のファイルの 3 つの値だけを書き換え、プロファイルの改訂は変えない。開始の画面も、
 *   新しい値と、変え方の案内を出す。
 * - 範囲の外の値（`validateConfig` と同じ範囲）と、下限より短い間隔は、欄ごとに理由を出し、ダイアログを開かず、書かない。同じ値は書かない。
 * - `local/targets/` の外の設定のファイル（`config/targets/`）は、画面から変えない（欄を出さず、Server Function も拒む）。
 * - Server Function は、入力の形をスキーマで確かめ（400）、画面が見た digest と違えば書かない。画面を通さずに送っても、下限より短い間隔は書かない。
 * サイトへは接続しない（ジョブを始めない）。許可 Origin の名前は予約のドメイン。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { formatCount, formatDuration, formatElapsedTime } from '../../../src/presentation/format.js';
import {
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_CRAWL_LIMITS_TEXT,
  TARGET_CRAWL_LIMIT_PROBLEM_DESCRIPTIONS,
  TARGET_CRAWL_LIMITS_CHANGE_FAILURE_DESCRIPTIONS,
} from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { publicProfileDocument, writeAuditTargetConfig } from './helpers/audit-site.ts';
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
import { createUiPageKit } from './helpers/ui-page.ts';

const UI_TIMEOUT_MS = 15_000;
const SCENARIO_TIMEOUT_MS = 120_000;
const MAX_TAB_PRESSES = 80;
const PROFILE_ID = 't44d-limits';
const FIXED_PROFILE_ID = 't44d-fixed';
const TARGET_PATH = `local/targets/${PROFILE_ID}.json`;
const OUTPUT_DIRECTORY = 't44d-limits-output';
/** 許可 Origin（ループバックでない、予約のドメイン。接続しない）。 */
const ORIGIN = 'https://t44d.example.test';
const BEFORE = Object.freeze({ maxPages: 3, maxRuntimeMs: 3_600_000, minNavigationIntervalMs: 10_000 });
const INTERVAL_FLOOR_MS = 1_000;
const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400 });

const text = LOCAL_UI_CRAWL_LIMITS_TEXT;

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();

const started = (): StartedServer => {
  if (server === undefined) throw new Error('サーバが起動していない');
  return server;
};
const rootOf = (): TemporaryUiRoot => {
  if (root === undefined) throw new Error('一時の root がない');
  return root;
};

const { openPage, tabTo, screenshot, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  screenshotDirectory: process.env['T44D_SCREENSHOT_DIR'],
});

const call = (name: string, method: 'GET' | 'POST', data?: unknown) =>
  callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await call(name, method, data);
  expect(result.response.status, name).toBe(STATUS.OK);
  return result.value as T;
};

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

const panelOf = async (page: Page): Promise<Locator> => {
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
  root = createTemporaryUiRoot('built');
  mkdirSync(`${root.root}/local/targets`, { recursive: true });
  writeFileSync(`${root.root}/${TARGET_PATH}`, `${JSON.stringify(targetDocument, null, 2)}\n`, 'utf8');
  const fixedPath = writeAuditTargetConfig(root.root, FIXED_PROFILE_ID, 'http://127.0.0.1:9', { minNavigationIntervalMs: 0, screenshots: false });
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  expect(await valueOf('createProfileFn', 'POST', { profile: publicProfileDocument(PROFILE_ID, TARGET_PATH) })).toMatchObject({ ok: true });
  expect(await valueOf('createProfileFn', 'POST', { profile: publicProfileDocument(FIXED_PROFILE_ID, fixedPath) })).toMatchObject({ ok: true });
}, SCENARIO_TIMEOUT_MS);

afterEach(async () => {
  await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  root?.remove();
});

describe('T44d: the crawl limits on the profile screen', () => {
  it('rejects the values outside the range by field (the same range as validateConfig, and not shorter than the floor), and writes nothing', async () => {
    const before = readFileSync(`${rootOf().root}/${TARGET_PATH}`, 'utf8');
    const page = await openPage(`/profiles/${PROFILE_ID}`);
    const panel = await panelOf(page);
    expect(await field(panel, text.fields.maxPages).inputValue()).toBe(String(BEFORE.maxPages));
    expect(await field(panel, text.fields.maxRuntimeMs).inputValue()).toBe(String(BEFORE.maxRuntimeMs));
    expect(await field(panel, text.fields.minNavigationIntervalMs).inputValue()).toBe(String(BEFORE.minNavigationIntervalMs));
    expect(await hintOf(panel, 'minNavigationIntervalMs').textContent()).toContain(text.intervalFloor(formatDuration(INTERVAL_FLOOR_MS)));
    expect(await hintOf(panel, 'maxPages').textContent()).toBe(text.currentValue(formatCount(BEFORE.maxPages)));

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

    // 空の欄（数でない値。送れないので、画面が欄に出す）と、小数（サーバが確かめる）も、書かずに欄ごとに出す。
    await review(page, panel, { maxPages: '', minNavigationIntervalMs: String(BEFORE.minNavigationIntervalMs) });
    await expect.poll(() => field(panel, text.fields.minNavigationIntervalMs).getAttribute('aria-invalid'), { timeout: UI_TIMEOUT_MS }).toBe('false');
    expect(await field(panel, text.fields.maxPages).getAttribute('aria-invalid')).toBe('true');
    expect(await problemOf(panel, 'maxPages').textContent()).toBe(TARGET_CRAWL_LIMIT_PROBLEM_DESCRIPTIONS.NOT_POSITIVE_INTEGER);
    await review(page, panel, { maxPages: String(BEFORE.maxPages), maxRuntimeMs: '1.5' });
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
    await review(page, panel, { maxPages: '20', minNavigationIntervalMs: '2000' });
    const dialog = page.getByRole('dialog', { name: text.dialog.title });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    const rows = dialog.getByTestId('crawl-limits-change-row');
    expect(await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-field')))).toEqual(['maxPages', 'minNavigationIntervalMs']);
    expect(await rows.nth(0).locator('td').allTextContents()).toEqual([formatCount(BEFORE.maxPages), formatCount(20)]);
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
    // 3 つの値だけが変わり、ほかの項目は同じ。プロファイルの改訂は変わらない。
    expect(targetFile()).toEqual({ ...targetDocument, crawl: { ...targetDocument.crawl, maxPages: 20, minNavigationIntervalMs: 2_000 } });
    expect((await valueOf<{ profile: { revision: number } }>('getProfileFn', 'GET', { profileId: PROFILE_ID })).profile.revision).toBe(revision);
    const reloaded = await panelOf(await openPage(`/profiles/${PROFILE_ID}`));
    expect(await field(reloaded, text.fields.maxPages).inputValue()).toBe('20');
    await screenshot(page, 't44d-12-crawl-limits-saved');

    // 開始の画面も、新しい値と、変え方の案内を出す。
    const start = await openPage(`/start/${PROFILE_ID}`);
    const target = start.getByTestId('start-target');
    await target.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await target.textContent()).toContain(formatCount(20));
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

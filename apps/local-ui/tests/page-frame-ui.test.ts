/**
 * PL-V（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 13 章）: 画面の枠の共通の導線を、ビルドした画面のサーバ（一時の root）と headless の
 * Chromium（`tests/helpers/chromium.ts` の既定）で確かめる。
 * - 共通のメニュー（13 章の 14）: 3 つ（サイトの一覧・サイトを足す・これまでの結果）。環境に問題がない間は、環境の状態をメニューに出さない
 *   （画面の URL は残る）。
 * - 今どこにいるかの 1 行（13 章の 4）: h1 の上に、上の画面へのリンクと今の画面の名前の 1 行。各画面の一番下の戻るボタンはない。サイトの画面の題は
 *   サイトの名前、作業の画面の題は作業の種類。
 * - 自動で次へ移ったとき（13 章の最後の段落）: 移った印（search）のある画面は、h1 にフォーカスを置く。
 * - 作業の画面の読み上げ（13 章の 10）: `aria-live` の区画は要点の 1 つだけ。
 * - 確認のダイアログ（13 章の 7）: 止める確定は危険の見た目。
 * ジョブの行は、テストだけの操作で管理データに書く（ワーカーは起動しない。サイトへは接続しない）。値は匿名（ループバック）。
 */
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStartingJob, recordRunStarted } from '../../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { formatCompactUtcTimestamp } from '../../../src/core/utc-timestamp.js';
import { AUDIT_JOB_KIND_CATALOG } from '../../../src/presentation/catalog.js';
import {
  AUDIT_JOB_STOP_TARGET_NAMES,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_DISCOVERY_TEXT,
  LOCAL_UI_FRAME_TEXT,
  LOCAL_UI_LEDGER_TEXT,
  LOCAL_UI_READ_CHECK_TEXT,
  LOCAL_UI_SCENARIO_TEXT,
  LOCAL_UI_TEXT,
} from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { publicProfileDocument, writeAuditTargetConfig } from './helpers/audit-site.ts';
import { createTemporaryUiRoot, findFreePort, startLauncher, stopServer, type StartedServer, type TemporaryUiRoot } from './helpers/local-server.ts';
import { createProfileInStore } from './helpers/profile-store-setup.ts';
import { backLinkCountInMain, expectAtMostOnePrimaryButton, primaryButtonLabelsInMain } from './helpers/screen-shape.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

const UI_TIMEOUT_MS = 15_000;
const SCENARIO_TIMEOUT_MS = 120_000;
const PROFILE_ID = 'plv-frame';
const JOB_ID = 'job-plv-discovery';
const RUN_ID = 'RUN-20261026000000';

const text = LOCAL_UI_TEXT;

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;

const started = (): StartedServer => {
  if (server === undefined) throw new Error('サーバが起動していない');
  return server;
};
const rootOf = (): TemporaryUiRoot => {
  if (root === undefined) throw new Error('一時の root がない');
  return root;
};

const { openPage, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
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
  root = createTemporaryUiRoot('built');
  const targetConfigPath = writeAuditTargetConfig(root.root, PROFILE_ID, 'http://127.0.0.1:9', { minNavigationIntervalMs: 0, screenshots: false });
  expect(await createProfileInStore(root.root, publicProfileDocument(PROFILE_ID, targetConfigPath))).toMatchObject({ ok: true });
  writeRunningDiscoveryJob();
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
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

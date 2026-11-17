// T25b round 1（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 4.2、6 章）: 監査の段の除外の Guard の指定
// （`PassiveRequestGuardOptions.auditExclusions`）。本物の Guard と、127.0.0.1 の fixture のサーバ（`tests/helpers/login-fixture-server.ts`）で
// 確かめる。
// - SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: Guard は除外を当てない。除外のパス（ログアウト）、危険な語（既定の一覧
//   `DEFAULT_EXCLUDED_URL_WORDS`）、読む範囲（`/admin`）の外の URL へも、main frame の移動・ページの中の画像・fetch の GET と HEAD・iframe の文書のどれでも届き、
//   `blockedAuditExclusions` は現れず、違反は 0（前の Isolated Interaction Context の印 `applyToPageSubresourceReads` と、Guard を迂回した先読みを中継で拒む 2 段目は
//   外した）。BeakSight 自身の移動は移る前の判定（`isRunNavigationBlocked`）が止める。
// - 指定のない Context では、今のまま届く（対照）。`blockedAuditExclusions` は現れない。
// - Chromium は headless だけ（`BOTH_CHROMIUM_LAUNCHERS`）。
import { type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { wait } from '../../src/core/deadline.js';
import {
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  installPassiveRequestGuard,
} from '../../src/safety/passive-request-guard.js';
import type { AuditExclusionPolicy } from '../../src/safety/request-policy.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { BOTH_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { QUIET_PERIOD_MS } from '../helpers/gate-harness.js';
import {
  LOGIN_FIXTURE_PATHS,
  startLoginFixtureServer,
  type LoginFixtureServer,
} from '../helpers/login-fixture-server.js';

const VIEWPORT = Object.freeze({ width: 900, height: 700 });
/** ページの中の fetch がそろうのを待つ上限（ms）。 */
const IN_PAGE_SETTLE_TIMEOUT_MS = 5_000;
/** 全部の試みの後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 1_000;

/** 監査の段の除外（設計書 4.1 の `excludedPaths` にログアウト、`auditPathPrefixes` に管理画面、危険な語は既定の一覧）。 */
const EXCLUSIONS: AuditExclusionPolicy = Object.freeze({
  excludedPathPrefixes: Object.freeze([LOGIN_FIXTURE_PATHS.adminLogout]),
  auditPathPrefixes: Object.freeze([LOGIN_FIXTURE_PATHS.admin]),
  dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
});

/** fixture の画面（`adminResources`）が読む要求のうち、除外に当たるもの（path と query。fixture の本文と同じ）。 */
const EXCLUDED_SUB_REQUESTS = Object.freeze([
  `${LOGIN_FIXTURE_PATHS.adminLogout}?via=img`,
  '/admin/items/1/delete?via=img',
  '/admin/%72emove?via=img',
  `${LOGIN_FIXTURE_PATHS.publicPage}?via=img`,
  `${LOGIN_FIXTURE_PATHS.adminLogout}?via=iframe`,
  '/admin/items?action=CANCEL&via=iframe',
  `${LOGIN_FIXTURE_PATHS.adminLogout}?via=fetch`,
  '/admin/items?op=destroy&via=fetch',
]);
/** 同じ画面が読む要求のうち、除外に当たらないもの。 */
const ALLOWED_SUB_REQUESTS = Object.freeze([
  LOGIN_FIXTURE_PATHS.adminOkImage,
  LOGIN_FIXTURE_PATHS.adminOkFrame,
  `${LOGIN_FIXTURE_PATHS.adminOkJson}?via=fetch`,
]);
/** main frame の移動の先のうち、除外に当たるもの（ログアウト、percent-encode した危険な語、読む範囲の外）。 */
const EXCLUDED_MAIN_FRAME_PATHS = Object.freeze([
  LOGIN_FIXTURE_PATHS.adminLogout,
  '/admin/items?op=%64elete',
  LOGIN_FIXTURE_PATHS.publicPage,
]);

/**
 * T25g-1（独立レビュー T25R の C1）: 除外のパスに、危険な語を含まないもの（`/admin/purge`）を足した除外。危険な語に頼らず、除外のパスの
 * 比べだけで止まることを確かめる。
 */
const EXCLUDED_PURGE_PATH = '/admin/purge';
const EXCLUSIONS_WITH_PURGE: AuditExclusionPolicy = Object.freeze({
  ...EXCLUSIONS,
  excludedPathPrefixes: Object.freeze([...EXCLUSIONS.excludedPathPrefixes, EXCLUDED_PURGE_PATH]),
});
/** 除外のパスの、別の書き方（path の途中の連続した `/`、segment の `;` から後の path の引数）。 */
const RESPELLED_EXCLUDED_PATHS = Object.freeze(['/admin//purge', '/admin;x=1/purge']);
/** 別の書き方の要求の経路の印（query）。 */
const RESPELLED_VIA = Object.freeze({ image: '?via=img', fetchHead: '?via=fetch-head', navigation: '?via=nav' });

describe.each(BOTH_CHROMIUM_LAUNCHERS)('T25b round 1: the audit stage exclusions of the Guard, with %s', (name, launch) => {
  let browser: Browser;
  let server: LoginFixtureServer;
  const contexts: BrowserContext[] = [];

  beforeAll(async () => {
    browser = await launch();
  });

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    server = await startLoginFixtureServer();
  });

  afterEach(async () => {
    for (const context of contexts.splice(0)) {
      await closePassiveGuardedContext(context).catch(() => context.close().catch(() => undefined));
    }
    await server?.close();
  });

  /** 本物の Guard を付けた Context と page（factory と同じ Context の作り方）。`exclusions` を省略すると、今の公開監査と同じ。 */
  const openGuarded = async (exclusions?: AuditExclusionPolicy): Promise<{ readonly page: Page; readonly ledger: SafetyLedger }> => {
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block', acceptDownloads: false });
    contexts.push(context);
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(
      context,
      ledger,
      new Set([server.originA]),
      exclusions === undefined ? {} : { auditExclusions: exclusions },
    );
    const page = await context.newPage();
    await awaitPassiveRequestGuardReady(page);
    return { page, ledger };
  };

  /** fixture の画面を開き、ページの中の fetch がそろうまで待つ。 */
  const openResourcesPage = async (page: Page): Promise<void> => {
    await page.goto(`${server.originA}${LOGIN_FIXTURE_PATHS.adminResources}`, { waitUntil: 'load' });
    await expect.poll(
      () => page.evaluate(() => document.documentElement.dataset['done']),
      { timeout: IN_PAGE_SETTLE_TIMEOUT_MS },
    ).toBe('1');
    await wait(QUIET_PERIOD_MS);
  };

  const serverPaths = (): string[] => server.requests.filter((entry) => entry.site === 'A').map((entry) => entry.path);

  // BN-0・SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: ページが出す読み取り（画像・fetch）と子の frame の文書（iframe）には
  // 除外を当てない（届く）。前の、子の frame を止める決まりと、Isolated Interaction Context の印 `applyToPageSubresourceReads` は外した。
  it('SD-2: the images, iframes and fetch GETs of a page that hit an exclusion reach the server, nothing is recorded, and there is no violation', async () => {
    const { page, ledger } = await openGuarded(EXCLUSIONS);

    await openResourcesPage(page);
    await wait(LATE_DELIVERY_SETTLE_MS);
    const snapshot = ledger.snapshot();
    console.info(`SD-2 sub requests (${name}): server ${JSON.stringify(serverPaths())}`);

    // ログアウトの画像・iframe・fetch は、fixture のサーバの 303（ログインの画面へ）をたどるので、ログインの画面の GET も届く。
    const logoutReads = EXCLUDED_SUB_REQUESTS.filter((path) => path.startsWith(`${LOGIN_FIXTURE_PATHS.adminLogout}?`)).length;
    expect(serverPaths().filter((path) => path === LOGIN_FIXTURE_PATHS.login)).toHaveLength(logoutReads);
    expect(serverPaths().filter((path) => path !== LOGIN_FIXTURE_PATHS.login).sort())
      .toEqual([LOGIN_FIXTURE_PATHS.adminResources, ...ALLOWED_SUB_REQUESTS, ...EXCLUDED_SUB_REQUESTS].sort());
    expect(snapshot.invariantViolations).toEqual([]);
    expect(snapshot.blockedRequests).toEqual([]);
    expect(snapshot.blockedNavigations).toEqual([]);
    expect(snapshot.blockedAuditExclusions).toBeUndefined();
  });

  // SD-2（設計書 2.4 の「main frame の文書の移動」）: main frame の移動も、除外に当たる先（ログアウト、percent-encode した危険な語、読む範囲の外、ページの
  // リンクの押下）へ届く。止めた記録は出ない（BeakSight 自身の移動は移る前の判定 `isRunNavigationBlocked` が止め、移った画面は読み込みの部品が点検しない）。
  it('SD-2: the main frame navigations to the logout link, a dangerous term and a path outside the audit paths reach the server without a record or a violation', async () => {
    const { page, ledger } = await openGuarded(EXCLUSIONS);

    await page.goto(`${server.originA}${LOGIN_FIXTURE_PATHS.adminOkFrame}`);
    for (const path of EXCLUDED_MAIN_FRAME_PATHS) {
      const outcome = await page.goto(`${server.originA}${path}`).then(() => 'loaded', () => 'blocked');
      expect(outcome, path).toBe('loaded');
    }
    await page.goto(`${server.originA}${LOGIN_FIXTURE_PATHS.adminResources}`, { waitUntil: 'load' });
    await page.click('#logout');
    await page.waitForLoadState('load').catch(() => undefined);
    await wait(LATE_DELIVERY_SETTLE_MS);
    const snapshot = ledger.snapshot();

    for (const path of EXCLUDED_MAIN_FRAME_PATHS) {
      expect(serverPaths(), path).toContain(path);
    }
    expect(serverPaths().filter((path) => path === LOGIN_FIXTURE_PATHS.adminLogout).length).toBeGreaterThanOrEqual(2);
    expect(snapshot.invariantViolations).toEqual([]);
    expect(snapshot.blockedNavigations).toEqual([]);
    expect(snapshot.blockedAuditExclusions).toBeUndefined();
  });

  /** 今の page で、別の書き方の除外のパスへ、画像の GET、fetch の HEAD、main frame の移動の順に試みる。 */
  const attemptRespelledPaths = async (page: Page): Promise<void> => {
    await page.goto(`${server.originA}${LOGIN_FIXTURE_PATHS.adminOkFrame}`, { waitUntil: 'load' });
    await page.evaluate(async ({ paths, via }) => {
      await Promise.all(paths.map((path) => new Promise<void>((resolve) => {
        const image = new Image();
        image.onload = () => resolve();
        image.onerror = () => resolve();
        image.src = `${path}${via.image}`;
        document.body.append(image);
      })));
      for (const path of paths) {
        try {
          await fetch(`${path}${via.fetchHead}`, { method: 'HEAD' });
        } catch {
          // 止められた fetch は失敗する。届いたかはサーバの記録で確かめる。
        }
      }
    }, { paths: RESPELLED_EXCLUDED_PATHS, via: RESPELLED_VIA });
    for (const path of RESPELLED_EXCLUDED_PATHS) {
      await page.goto(`${server.originA}${path}${RESPELLED_VIA.navigation}`).catch(() => undefined);
      await page.waitForLoadState('load').catch(() => undefined);
      await wait(QUIET_PERIOD_MS);
    }
    await wait(LATE_DELIVERY_SETTLE_MS);
  };

  /** サーバに届いた、別の書き方の除外のパスへの要求（method と path と query）。 */
  const respelledRequestsReached = (): string[] => server.requests
    .filter((entry) => RESPELLED_EXCLUDED_PATHS.some((path) => entry.path.startsWith(`${path}?`)))
    .map((entry) => `${entry.method} ${entry.path}`);

  // BN-0・SD-2: 別の書き方の除外のパスも、画像の GET・fetch の HEAD・main frame の移動のどれでも届き、記録はない（書き方の比べは単体の
  // `request-policy-auth.test.ts` の移る前の判定が確かめる）。
  it('SD-2: the respelled excluded path reaches the server by an image GET, a fetch HEAD and a main frame navigation, without a record', async () => {
    const { page, ledger } = await openGuarded(EXCLUSIONS_WITH_PURGE);

    await attemptRespelledPaths(page);
    const snapshot = ledger.snapshot();
    expect(respelledRequestsReached().sort()).toEqual(RESPELLED_EXCLUDED_PATHS.flatMap((path) => [
      `GET ${path}${RESPELLED_VIA.image}`,
      `HEAD ${path}${RESPELLED_VIA.fetchHead}`,
      `GET ${path}${RESPELLED_VIA.navigation}`,
    ]).sort());
    expect(snapshot.invariantViolations).toEqual([]);
    expect(snapshot.blockedAuditExclusions).toBeUndefined();
  });

  it('T25g-1 control: without the exclusions, the same respelled requests reach the server as today', async () => {
    const { page, ledger } = await openGuarded();

    await attemptRespelledPaths(page);

    expect(respelledRequestsReached().sort()).toEqual(RESPELLED_EXCLUDED_PATHS.flatMap((path) => [
      `GET ${path}${RESPELLED_VIA.image}`,
      `HEAD ${path}${RESPELLED_VIA.fetchHead}`,
      `GET ${path}${RESPELLED_VIA.navigation}`,
    ]).sort());
    expect(Object.hasOwn(ledger.snapshot(), 'blockedAuditExclusions')).toBe(false);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('control: a Context without the exclusions delivers the same requests as today, and has no blockedAuditExclusions record', async () => {
    const { page, ledger } = await openGuarded();

    await openResourcesPage(page);
    await page.goto(`${server.originA}${LOGIN_FIXTURE_PATHS.adminLogout}`);
    await wait(LATE_DELIVERY_SETTLE_MS);

    for (const path of [...EXCLUDED_SUB_REQUESTS, ...ALLOWED_SUB_REQUESTS, LOGIN_FIXTURE_PATHS.adminLogout]) {
      expect(serverPaths(), path).toContain(path);
    }
    const snapshot = ledger.snapshot();
    expect(Object.hasOwn(snapshot, 'blockedAuditExclusions')).toBe(false);
    expect(snapshot.invariantViolations).toEqual([]);
  });
});

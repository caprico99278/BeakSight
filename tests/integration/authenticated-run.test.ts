// T25c（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 3 章、4.2、4.3、4.6、4.7 と、変更履歴の 2026-10-10 の
// Blocker の行）: 認証つきの Run（`RunCoordinatorDependencies.authentication`）。本物の Run Coordinator、factory、Guard と、127.0.0.1 の fixture
// のサーバ（`tests/helpers/authenticated-site-fixture.ts`）で確かめる。Chromium は headless だけ。安全の確かめは、テストの既定（headless shell）と、
// CLI の起動の設定（`launchCliChromium`）の両方で行う。
// - 状態の注入と世代つきの受け継ぎ: 回転するサーバでも、PREFLIGHT、Desktop、幅の走査、Mobile のすべての Context で認証が保たれ、管理画面を監査する。
// - 監査の範囲: Interaction を行わない（有効な設定の `audit.interactions` が false。候補を探さない）。ログアウト・危険な語・ログインの画面の URL は
//   巡回の候補に入らず、サーバに届かない（セッションは壊れない）。読み取り以外の要求は 0。
// - 別の Origin の Cookie（E7）: 別の Origin の部品の要求に、状態の Cookie が付かない。
// - セッションの切れ: 期限切れのサーバ（ログインの画面が読む範囲の外で Guard が止める場合と、読む範囲の中の場合）と、古い値の再利用を盗難と
//   みなすサーバで、`AUTH_SESSION_LOST` で止まり（Run は PARTIAL、実行の終わり方は `STOPPED_BY_AUTH_SESSION_LOST`）、ログインの画面を管理画面
//   として監査しない。
// - 除外の記録が 256 件を超えても、Ledger の記録の切り詰めにならない（PARTIAL にならない）。
// - 秘密の目印（Cookie と localStorage の値）が、Run のディレクトリのどのファイル（保存、ZIP の中身を含む）にも現れないことは、TS-f で
//   `authenticated-url-secrets.test.ts` の T25f にまとめた（同じ回転するサーバで、URL の query の目印も合わせて確かめる）。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { AuditRunResult, PageAuditResult } from '../../src/core/contracts.js';
import type { RunStageCarried, RunStageCarry } from '../../src/orchestration/audit-stage-run.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import type { BrowserLauncher } from '../../src/orchestration/preflight.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import {
  AUTH_SITE_MANY_EXCLUDED_IMAGES,
  AUTH_SITE_PATHS,
  authenticatedStateFor,
  startAuthenticatedSite,
  type AuthenticatedSite,
  type AuthenticatedSiteOptions,
} from '../helpers/authenticated-site-fixture.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { LOADED_BROWSER_CLOSE_TIMEOUT_MS, LOADED_RESOURCE_SETTLING_TIMEOUT_MS } from '../helpers/loaded-deadline.js';
import { createTestConfig } from '../helpers/test-config.js';

/** 幅の走査の幅（主の Desktop と Mobile の幅と重ならない 2 幅。Desktop の Context の中で、順に開け閉めする Context）。 */
const STRESS_WIDTHS = Object.freeze([600, 900]);
/** 巡回するページの数の上限（管理画面、2 つ目の画面、別の Origin の部品の画面）。 */
const MAX_PAGES = 4;
/** セッションの切れのページの、残りの URL を確かめるための上限。 */
const SESSION_LOST_MAX_PAGES = 4;
/** 期限切れのサーバで、セッションを期限切れにするまでの管理画面の数（1 ページ目の Desktop、幅 1 つ、Mobile の 3 回）。 */
const EXPIRING_ADMIN_PAGES = 3;
/** 期限切れのサーバの幅の走査の幅（1 幅）。 */
const EXPIRING_STRESS_WIDTHS = Object.freeze([600]);
/**
 * 複数のページを、幅の走査を含めて最後まで監査するテストの期限（ms。DEF-067）。単独での実行で 11〜16 秒かかり（2026-10-11 の 3 回の計測。最大は
 * CLI の起動の設定で約 16 秒）、全体の検証の混雑で既定の 30 秒を超えた。計測の最大のおよそ 7.5 倍にして、ほかの Run の全体を行うテストの期限
 * （`guard-response-received-failures.test.ts` などの `RUN_TEST_TIMEOUT_MS`）とそろえる。確かめる内容と Run の期限は変えない。
 */
const FULL_RUN_TEST_TIMEOUT_MS = 120_000;
/** BN-0: 除外に当たる iframe を 300 個読む画面の Run の期限（ms。iframe の文書は 1 つずつ止まるので、画像のときより長い）。 */
const MANY_EXCLUDED_TEST_TIMEOUT_MS = 120_000;

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;

/** 監査の段の除外（ログアウトを除外のパスに、管理画面を読む範囲に、危険な語は既定の一覧）。 */
function exclusionsWith(auditPathPrefixes: readonly string[]): RunAuthentication['auditExclusions'] {
  return Object.freeze({
    excludedPathPrefixes: Object.freeze([AUTH_SITE_PATHS.adminLogout]),
    auditPathPrefixes: Object.freeze([...auditPathPrefixes]),
    dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
  });
}

/** robots.txt と sitemap.xml の path（サイトの情報の取得の先）。 */
const ROBOTS_TXT_PATH = '/robots.txt';
const SITEMAP_XML_PATH = '/sitemap.xml';

const pathOf = (url: string | null): string | null => (url === null ? null : new URL(url).pathname);

describe.each(LAUNCHERS)('T25c: the authenticated Run (%s)', (_name, launch) => {
  let workDirectory: string;
  let site: AuthenticatedSite | undefined;
  const browsers: Browser[] = [];
  const launcher: BrowserLauncher = async () => {
    const browser = await launch();
    browsers.push(browser);
    return browser;
  };

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-authenticated-run-'));
  });

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close().catch(() => undefined)));
    await site?.close();
    site = undefined;
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  async function startSite(options: AuthenticatedSiteOptions = {}): Promise<AuthenticatedSite> {
    site = await startAuthenticatedSite(options);
    return site;
  }

  // DF-2b（DEF-067 の続き。LG-3b の 2 件の PARTIAL）: Run が COMPLETE であることを確かめる場面が、混雑の下で DOM の準備の期限と Browser を
  // 閉じる期限で PARTIAL にならないよう、どちらも名前つきの混雑の倍率を掛けた値にする（DEF-063 の形。判定に関わる読み込みの期限は変えない）。
  function configFor(started: AuthenticatedSite, startPath: string, overrides: Parameters<typeof createTestConfig>[2] = {}): AuditConfig {
    return createTestConfig(started.originA, startPath, {
      ...overrides,
      crawl: { maxPages: MAX_PAGES, resourceSettlingTimeoutMs: LOADED_RESOURCE_SETTLING_TIMEOUT_MS, ...overrides.crawl },
      viewports: { stressWidths: [...STRESS_WIDTHS], ...overrides.viewports },
      audit: { screenshots: false, ...overrides.audit },
    });
  }

  function authenticationFor(
    started: AuthenticatedSite,
    initialState: RunAuthentication['initialState'],
    auditPathPrefixes: readonly string[] = [AUTH_SITE_PATHS.admin],
  ): RunAuthentication {
    return {
      initialState,
      approvedTestOrigins: [started.originA],
      auditExclusions: exclusionsWith(auditPathPrefixes),
      sessionLostPathPrefix: AUTH_SITE_PATHS.login,
      filterState: filterAuthenticatedState,
    };
  }

  async function run(input: {
    readonly config: AuditConfig;
    readonly authentication?: RunAuthentication;
    readonly outputDirectory: string;
    /** 渡すと、Run で作ったすべての Safety Ledger を、作った順に入れる。 */
    readonly ledgers?: SafetyLedger[];
    /** FM2d: まとめて実行の段の持ち越し。 */
    readonly stageCarry?: RunStageCarry;
  }): Promise<{ readonly result: AuditRunResult; readonly coordinator: RunCoordinator }> {
    const coordinator = new RunCoordinator({
      config: input.config,
      launchBrowser: launcher,
      createSafetyLedger: () => {
        const ledger = new SafetyLedger();
        input.ledgers?.push(ledger);
        return ledger;
      },
      clock: () => new Date(),
      now: () => Date.now(),
      browserCloseTimeoutMs: LOADED_BROWSER_CLOSE_TIMEOUT_MS,
      outputDirectory: input.outputDirectory,
      ...(input.authentication === undefined ? {} : { authentication: input.authentication }),
      ...(input.stageCarry === undefined ? {} : { stageCarry: input.stageCarry }),
    });
    return { result: await coordinator.run(), coordinator };
  }

  // FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: Run の終わりに、factory の最新の状態を持ち越しの口へ 1 回渡す。回転するサーバ
  // （古い値を無効にする）で、持ち越した状態から始めた次の Run も、ログインの画面に飛ばされずに通る。
  it('records the latest state once at the end of the Run, and the next Run with the carried state passes on a rotating server', async () => {
    const started = await startSite({ rotate: true });
    const { state } = authenticatedStateFor(started);
    const carried: RunStageCarried[] = [];
    const first = await run({
      config: configFor(started, AUTH_SITE_PATHS.admin),
      authentication: authenticationFor(started, state),
      outputDirectory: join(workDirectory, `carry-first-${browsers.length}-${Date.now()}`),
      stageCarry: { serviceRequestWindowMs: [], record: (value) => carried.push(value) },
    });
    expect(first.result.run.runStatus).toBe('COMPLETE');
    expect(carried).toHaveLength(1);
    const latest = carried[0]?.latestState ?? null;
    expect(latest).not.toBeNull();
    // 監査の段の口がない Run の窓は空。
    expect(carried[0]?.serviceRequestWindowMs).toEqual([]);

    const second = await run({
      config: configFor(started, AUTH_SITE_PATHS.admin),
      authentication: authenticationFor(started, latest ?? state),
      outputDirectory: join(workDirectory, `carry-second-${browsers.length}-${Date.now()}`),
    });
    expect(second.result.run.runStatus).toBe('COMPLETE');
    expect(second.result.run.incompleteReasons.filter(({ code }) => code === 'AUTH_SESSION_LOST')).toEqual([]);
    expect(started.requests.filter(({ path }) => path.startsWith(AUTH_SITE_PATHS.login))).toEqual([]);
  }, FULL_RUN_TEST_TIMEOUT_MS * 2);

  const pageAt = (result: AuditRunResult, origin: string, path: string): PageAuditResult | undefined =>
    result.pages.find(({ pageUrl }) => pageUrl === `${origin}${path}`);

  it('audits the admin pages in every Context on a rotating server, without Interaction, excluded URLs or other Origin cookies', async () => {
    const started = await startSite({ rotate: true });
    const { state } = authenticatedStateFor(started);
    const { result } = await run({
      config: configFor(started, AUTH_SITE_PATHS.admin),
      authentication: authenticationFor(started, state),
      outputDirectory: join(workDirectory, `rotating-${browsers.length}-${Date.now()}`),
    });

    // 管理画面の 3 ページを、Desktop と Mobile の両方で、管理画面として監査した（ログインの画面に飛ばされていない）。
    const auditedPaths = [AUTH_SITE_PATHS.admin, AUTH_SITE_PATHS.adminSecond, AUTH_SITE_PATHS.adminFrames];
    for (const path of auditedPaths) {
      const page = pageAt(result, started.originA, path);
      expect(page?.status, path).not.toBe('SKIPPED');
      expect(page?.status, path).not.toBe('FAILED');
      expect(pathOf(page?.viewports.desktop.finalUrl ?? null), path).toBe(path);
      expect(pathOf(page?.viewports.mobile.finalUrl ?? null), path).toBe(path);
    }
    // サーバに届いた管理画面の要求は、すべて認証済み（PREFLIGHT、Desktop、幅の走査、Mobile のすべての Context）。読み取り以外は 0。
    const adminRequests = started.requests.filter(({ site: origin, path }) => origin === 'A' && path.startsWith(AUTH_SITE_PATHS.admin));
    expect(adminRequests.length).toBeGreaterThanOrEqual(auditedPaths.length * (2 + STRESS_WIDTHS.length));
    expect(adminRequests.filter(({ authenticated }) => !authenticated)).toEqual([]);
    expect(started.requests.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    // ログアウト、危険な語、ログインの画面は、巡回の候補に入らず、サーバに届かない。
    for (const path of [AUTH_SITE_PATHS.adminLogout, AUTH_SITE_PATHS.adminDelete, AUTH_SITE_PATHS.login]) {
      expect(started.requests.filter(({ path: requested }) => requested.startsWith(path)), path).toEqual([]);
      expect(pageAt(result, started.originA, path), path).toBeUndefined();
    }
    // 別の Origin の部品の要求に、状態の Cookie が付かない（E7）。
    const otherOriginRequests = started.requests.filter(({ site: origin }) => origin === 'B');
    expect(otherOriginRequests.length).toBeGreaterThan(0);
    expect(otherOriginRequests.filter(({ cookieNames }) => cookieNames.length > 0)).toEqual([]);
    // Interaction を行わない（有効な設定に記録し、候補を探さない）。ページの結果を PARTIAL にする理由は加えない。
    expect(result.run.effectiveConfig.audit.interactions).toBe(false);
    expect(result.pages.flatMap(({ evidence }) => evidence.filter(({ type }) => type === 'interaction'))).toEqual([]);
    expect(result.pages.flatMap(({ incompleteReasons }) => incompleteReasons)
      .filter(({ detail }) => detail?.startsWith('interaction') === true)).toEqual([]);
    expect(result.run.incompleteReasons.filter(({ code }) => code === 'AUTH_SESSION_LOST')).toEqual([]);
    expect(result.run.runStatus).toBe('COMPLETE');
    expect(result.run.safety.invariantViolationCount).toBe(0);
  }, FULL_RUN_TEST_TIMEOUT_MS);

  it.each([
    ['the login page is outside the audit range (the Guard stops the redirect)', [AUTH_SITE_PATHS.admin]],
    ['the login page is inside the audit range (the redirect is followed)', []],
  ] as const)('stops with AUTH_SESSION_LOST on an expiring server and does not audit the login page (%s)', async (_case, prefixes) => {
    const started = await startSite({ maxAdminPages: EXPIRING_ADMIN_PAGES });
    const { state } = authenticatedStateFor(started);
    const { result } = await run({
      config: configFor(started, AUTH_SITE_PATHS.admin, {
        crawl: { maxPages: SESSION_LOST_MAX_PAGES },
        viewports: { stressWidths: [...EXPIRING_STRESS_WIDTHS] },
      }),
      authentication: authenticationFor(started, state, prefixes),
      outputDirectory: join(workDirectory, `expiring-${prefixes.length}-${Date.now()}`),
    });

    // 1 ページ目（Desktop、幅 1 つ、Mobile）は監査した。2 ページ目の Desktop で期限切れになり、そのページを捨てて止めた。
    const first = pageAt(result, started.originA, AUTH_SITE_PATHS.admin);
    expect(first?.status).not.toBe('SKIPPED');
    const skipped = result.pages.filter(({ status }) => status === 'SKIPPED');
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every(({ incompleteReasons }) => incompleteReasons.every(({ code }) => code === 'AUTH_SESSION_LOST'))).toBe(true);
    expect(skipped.map(({ incompleteReasons }) => incompleteReasons[0]?.detail)).toContain('desktop:passive');
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.incompleteReasons).toContainEqual({ code: 'AUTH_SESSION_LOST', detail: null });
    expect(result.run.executions.at(-1)?.endReason).toBe('STOPPED_BY_AUTH_SESSION_LOST');
    // ログインの画面を、管理画面として監査していない（どのページの結果にも、ログインの画面の最後の URL がない）。
    const finalPaths = result.pages.flatMap(({ viewports }) => [viewports.desktop.finalUrl, viewports.mobile.finalUrl]).map(pathOf);
    expect(finalPaths).not.toContain(AUTH_SITE_PATHS.login);
    expect(result.run.safety.invariantViolationCount).toBe(0);
    expect(started.requests.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
  });

  it('stops with AUTH_SESSION_LOST when the server treats a reused rotated value as theft (the remaining risk of the generation inheritance)', async () => {
    const started = await startSite({ rotate: true, theftDetection: true });
    const { state } = authenticatedStateFor(started);
    const { result } = await run({
      config: configFor(started, AUTH_SITE_PATHS.adminPinging, { crawl: { maxPages: 1 } }),
      authentication: authenticationFor(started, state),
      outputDirectory: join(workDirectory, `theft-${Date.now()}`),
    });

    const page = pageAt(result, started.originA, AUTH_SITE_PATHS.adminPinging);
    expect(page?.status).toBe('SKIPPED');
    expect(page?.incompleteReasons.map(({ code }) => code)).toEqual(['AUTH_SESSION_LOST']);
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.executions.at(-1)?.endReason).toBe('STOPPED_BY_AUTH_SESSION_LOST');
    expect(result.run.safety.invariantViolationCount).toBe(0);
  });

  it.each([
    ['the audit range is the admin pages (both files are excluded)', [AUTH_SITE_PATHS.admin], true],
    ['the audit range is not limited (both files are fetched)', [], false],
  ] as const)('handles robots.txt and sitemap.xml by the audit exclusions, and keeps the Run status (%s)', async (_case, prefixes, excluded) => {
    const started = await startSite();
    const { state } = authenticatedStateFor(started);
    const ledgers: SafetyLedger[] = [];
    const { result } = await run({
      config: configFor(started, AUTH_SITE_PATHS.admin, { viewports: { stressWidths: [] } }),
      authentication: authenticationFor(started, state, prefixes),
      outputDirectory: join(workDirectory, `metadata-${prefixes.length}-${Date.now()}`),
      ledgers,
    });

    const metadataPaths = [ROBOTS_TXT_PATH, SITEMAP_XML_PATH];
    const start = pageAt(result, started.originA, AUTH_SITE_PATHS.admin);
    const outcomes = (start?.evidence ?? []).flatMap((record) => (record.type === 'metadata' ? [record.payload.outcome] : []));
    const fetchedPaths = started.requests.map(({ path }) => path).filter((path) => metadataPaths.includes(path));
    const guardRecords = ledgers.flatMap((ledger) => ledger.snapshot().blockedAuditExclusions?.events ?? [])
      .filter(({ url }) => metadataPaths.includes(new URL(url).pathname));
    if (excluded) {
      // サーバにも Guard にも来ない（取りに行かない）。Evidence は「取らなかった」。
      expect(outcomes).toEqual(['EXCLUDED', 'EXCLUDED']);
      expect(fetchedPaths).toEqual([]);
    } else {
      expect(outcomes).not.toContain('EXCLUDED');
      expect(fetchedPaths).toEqual(metadataPaths);
    }
    expect(guardRecords).toEqual([]);
    expect(result.run.runStatus).toBe('COMPLETE');
    expect(result.run.executions.at(-1)?.endReason).toBe('COMPLETED');
    expect(result.run.safety.invariantViolationCount).toBe(0);
  }, FULL_RUN_TEST_TIMEOUT_MS);

  it('audits the same pinging page on a rotating server that does not treat the reuse as theft (control of the theft case)', async () => {
    const started = await startSite({ rotate: true });
    const { state } = authenticatedStateFor(started);
    const { result } = await run({
      config: configFor(started, AUTH_SITE_PATHS.adminPinging, { crawl: { maxPages: 1 } }),
      authentication: authenticationFor(started, state),
      outputDirectory: join(workDirectory, `pinging-${Date.now()}`),
    });

    const page = pageAt(result, started.originA, AUTH_SITE_PATHS.adminPinging);
    expect(page?.status).not.toBe('SKIPPED');
    expect(pathOf(page?.viewports.mobile.finalUrl ?? null)).toBe(AUTH_SITE_PATHS.adminPinging);
    expect(result.run.executions.at(-1)?.endReason).toBe('COMPLETED');
  });

  it('does not truncate the Ledger (nor make the Run PARTIAL) when only the audit exclusion record exceeds 256 events', async () => {
    const started = await startSite();
    const { state } = authenticatedStateFor(started);
    const { result } = await run({
      config: configFor(started, AUTH_SITE_PATHS.adminManyExcluded, { crawl: { maxPages: 1 }, viewports: { stressWidths: [] } }),
      authentication: authenticationFor(started, state),
      outputDirectory: join(workDirectory, `many-${Date.now()}`),
    });

    const page = pageAt(result, started.originA, AUTH_SITE_PATHS.adminManyExcluded);
    const exclusionCounts = (page?.evidence ?? []).flatMap((record) =>
      (record.type === 'safety' && record.payload.blockedAuditExclusions !== undefined ? [record.payload.blockedAuditExclusions.count] : []));
    expect(exclusionCounts.some((count) => count >= AUTH_SITE_MANY_EXCLUDED_IMAGES)).toBe(true);
    expect(started.requests.filter(({ path }) => path.startsWith(AUTH_SITE_PATHS.adminLogout))).toEqual([]);
    expect(result.run.safety.recordTruncated).toBe(false);
    expect(result.run.runStatus).toBe('COMPLETE');
    expect(result.statusInput.safetyLedgerTruncated).toBe(false);
    expect(result.run.incompleteReasons.map(({ code }) => code)).not.toContain('SAFETY_LEDGER_TRUNCATED');
  }, MANY_EXCLUDED_TEST_TIMEOUT_MS);

  // TS-f（B13）: 回転するサーバの認証つきの Run で、Run のディレクトリのどのファイル（出力、保存、ZIP の中身）にも秘密の目印が残らないことは、
  // 同じ確かめ（と URL の query の目印）をしていた `authenticated-url-secrets.test.ts` の T25f に、1 か所にまとめた。

  it('keeps the Run without the authentication unchanged (Interaction stays enabled in the effective configuration)', async () => {
    const started = await startSite();
    const { result } = await run({
      config: configFor(started, AUTH_SITE_PATHS.login, { crawl: { maxPages: 1 }, viewports: { stressWidths: [] } }),
      outputDirectory: join(workDirectory, `public-${Date.now()}`),
    });

    expect(result.run.effectiveConfig.audit.interactions).toBe(true);
    expect(started.requests.every(({ cookieNames }) => cookieNames.length === 0)).toBe(true);
    expect(result.run.incompleteReasons.map(({ code }) => code)).not.toContain('AUTH_SESSION_LOST');
  });
});

// T25c（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 3 章、4.2、4.3、4.6、4.7 と、変更履歴の 2026-10-10 の
// Blocker の行）: 認証つきの Run（`RunCoordinatorDependencies.authentication`）。本物の Run Coordinator、factory、Guard と、127.0.0.1 の fixture
// のサーバ（`tests/helpers/authenticated-site-fixture.ts`）で確かめる。Chromium は既定の headless だけ（TEST-SLIM。別の Origin の Cookie と
// ログアウトの除外の 2 つの Chromium での確かめは `authenticated-context-factory.test.ts`）。
// - 状態の注入と受け継ぎ（DEF-191 の後は、最後に閉じた Context の状態）: 回転するサーバでも、PREFLIGHT、Desktop、幅の走査、Mobile のすべての Context で認証が
//   保たれ、管理画面を監査する。
// - 監査の範囲: Interaction を行わない（有効な設定の `audit.interactions` が false。候補を探さない）。ログアウト・危険な語・ログインの画面の URL は
//   巡回の候補に入らず、サーバに届かない（セッションは壊れない）。読み取り以外の要求は 0。
// - 別の Origin の Cookie（E7）: 別の Origin の部品の要求に、状態の Cookie が付かない。
// - DEF-191: 古い値の再利用を盗難とみなすサーバでも、値を送り続けるページを切れずに監査する。
// - robots.txt と sitemap.xml を、読む範囲の外なら取りに行かない。
// - SLIM-GROUP L-4: セッションの切れ（`AUTH_SESSION_LOST`）は `authenticated-url-secrets.test.ts`・`session-loss-evidence-run.test.ts` が確かめる。
// - 秘密の目印（Cookie と localStorage の値）が、Run のディレクトリのどのファイル（保存、ZIP の中身を含む）にも現れないことは、TS-f で
//   `authenticated-url-secrets.test.ts` の T25f にまとめた（同じ回転するサーバで、URL の query の目印も合わせて確かめる）。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  AUTH_SITE_PATHS,
  authenticatedStateFor,
  startAuthenticatedSite,
  type AuthenticatedSite,
  type AuthenticatedSiteOptions,
} from '../helpers/authenticated-site-fixture.js';
import { DEFAULT_CHROMIUM_LAUNCHERS, useSharedRunBrowser } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { auditRunArrayOf } from '../helpers/audit-run-fixture.js';
import { LOADED_BROWSER_CLOSE_TIMEOUT_MS, LOADED_RESOURCE_SETTLING_TIMEOUT_MS } from '../helpers/loaded-deadline.js';
import { TEST_RUN_PROGRESS_QUIET_LIMIT_MS } from '../helpers/run-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

/** 幅の走査の幅（主の Desktop と Mobile の幅と重ならない幅。Desktop の Context の中で開け閉めする Context。SLIM-GROUP L-4: 回転の確かめは 1 幅で足りる）。 */
const STRESS_WIDTHS = Object.freeze([600]);
/** 巡回するページの数の上限（管理画面、2 つ目の画面、別の Origin の部品の画面）。 */
const MAX_PAGES = 4;
/**
 * 複数のページを、幅の走査を含めて最後まで監査するテストの期限（ms。DEF-067）。単独での実行で 11〜16 秒かかり（2026-10-11 の 3 回の計測。最大は
 * CLI の起動の設定で約 16 秒）、全体の検証の混雑で既定の 30 秒を超えた。計測の最大のおよそ 7.5 倍にして、ほかの Run の全体を行うテストの期限
 * （`guard-response-received-failures.test.ts` などの `RUN_TEST_TIMEOUT_MS`）とそろえる。確かめる内容と Run の期限は変えない。
 */
const FULL_RUN_TEST_TIMEOUT_MS = 120_000;

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

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('T25c: the authenticated Run (%s)', (_name, launch) => {
  let workDirectory: string;
  let site: AuthenticatedSite | undefined;
  // SLIM-2（X7）: Run ごとに Chromium を起こし直さない（Run は、自分の Context だけを閉じて終わる）。
  const launcher: BrowserLauncher = useSharedRunBrowser(() => launch());

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-authenticated-run-'));
  });

  afterEach(async () => {
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
      // SLIM-GROUP L-4: 確かめるのは認証・届いた要求・Run の状態だけなので、性能と accessibility の収集は外す。
      audit: { screenshots: false, performance: false, accessibility: false, ...overrides.audit },
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
    /** DEF-254: 見張りの反応なしの長さ（省略すると、短いテストの値）。 */
    readonly progressWatchQuietLimitMs?: number;
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
      // DEF-245 の A: 見張りの反応なしの長さを短くする（本番は 180 秒）。
      progressWatchQuietLimitMs: input.progressWatchQuietLimitMs ?? TEST_RUN_PROGRESS_QUIET_LIMIT_MS,
      outputDirectory: input.outputDirectory,
      ...(input.authentication === undefined ? {} : { authentication: input.authentication }),
      ...(input.stageCarry === undefined ? {} : { stageCarry: input.stageCarry }),
    });
    return { result: await auditRunArrayOf(await coordinator.run()), coordinator };
  }

  const pageAt = (result: AuditRunResult, origin: string, path: string): PageAuditResult | undefined =>
    result.pages.find(({ pageUrl }) => pageUrl === `${origin}${path}`);

  // SLIM-GROUP L-4: 1 回目の Run で、回転するサーバのすべての Context の認証と監査の範囲（前の別の場面）を確かめ、その Run の持ち越しで 2 回目を流す。
  // FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: Run の終わりに、factory の最新の状態を持ち越しの口へ 1 回渡す。回転するサーバ
  // （古い値を無効にする）で、持ち越した状態から始めた次の Run も、ログインの画面に飛ばされずに通る。
  it('audits the admin pages in every Context on a rotating server without Interaction, excluded URLs, robots/sitemap or other Origin cookies, records the latest state once, and the next Run with it passes', async () => {
    const started = await startSite({ rotate: true });
    const { state } = authenticatedStateFor(started);
    const carried: RunStageCarried[] = [];
    const ledgers: SafetyLedger[] = [];
    const first = await run({
      config: configFor(started, AUTH_SITE_PATHS.admin),
      authentication: authenticationFor(started, state),
      outputDirectory: join(workDirectory, `carry-first-${Date.now()}`),
      ledgers,
      stageCarry: { serviceRequestWindowMs: [], record: (value) => carried.push(value) },
    });
    const { result } = first;
    // robots.txt と sitemap.xml は、読む範囲（管理画面）の外なので、サーバにも Guard にも来ない（取りに行かない）。Evidence は「取らなかった」。
    const metadataPaths = [ROBOTS_TXT_PATH, SITEMAP_XML_PATH];
    expect((pageAt(result, started.originA, AUTH_SITE_PATHS.admin)?.evidence ?? [])
      .flatMap((record) => (record.type === 'metadata' ? [record.payload.outcome] : []))).toEqual(['EXCLUDED', 'EXCLUDED']);
    expect(started.requests.map(({ path }) => path).filter((path) => metadataPaths.includes(path))).toEqual([]);
    expect(ledgers.flatMap((ledger) => ledger.snapshot().blockedAuditExclusions?.events ?? [])
      .filter(({ url }) => metadataPaths.includes(new URL(url).pathname))).toEqual([]);
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
    expect(carried).toHaveLength(1);
    const latest = carried[0]?.latestState ?? null;
    expect(latest).not.toBeNull();
    // 監査の段の口がない Run の窓は空。
    expect(carried[0]?.serviceRequestWindowMs).toEqual([]);

    // 2 回目は、持ち越した状態で始めて切れないことだけを見る（幅の走査はしない）。
    const second = await run({
      config: configFor(started, AUTH_SITE_PATHS.admin, { viewports: { stressWidths: [] } }),
      authentication: authenticationFor(started, latest ?? state),
      outputDirectory: join(workDirectory, `carry-second-${Date.now()}`),
    });
    expect(second.result.run.runStatus).toBe('COMPLETE');
    expect(second.result.run.incompleteReasons.filter(({ code }) => code === 'AUTH_SESSION_LOST')).toEqual([]);
    expect(started.requests.filter(({ path }) => path.startsWith(AUTH_SITE_PATHS.login))).toEqual([]);
  }, FULL_RUN_TEST_TIMEOUT_MS * 2);

  // SLIM-GROUP L-4: 期限切れのサーバの `AUTH_SESSION_LOST` の 2 場面は消した（`authenticated-url-secrets.test.ts` の切れと再開、`session-loss-evidence-run.test.ts` の
  // 読む範囲の外へ Guard が止める場面が確かめる）。

  // DEF-191（設計書 `2026-11-04-beaksight-login-session-design.md` 3.1）: 前は、Desktop の Context（値を送り続けるページ）を開いたまま幅の走査の Context が値を回したので、
  // Desktop が回された古い値を送り、盗難とみなすサーバが系列を無効にした（世代つきの受け継ぎの残りの危険。セッションの切れで止まった）。今は、Desktop を閉じてから
  // 幅の走査を回すので、回された古い値を送る Context がなく、盗難とみなすサーバでも切れずに監査する。
  it('audits the pinging page even when the server treats a reused rotated value as theft (DEF-191: no live Context keeps an older value)', async () => {
    const started = await startSite({ rotate: true, theftDetection: true });
    const { state } = authenticatedStateFor(started);
    const { result } = await run({
      config: configFor(started, AUTH_SITE_PATHS.adminPinging, { crawl: { maxPages: 1 } }),
      authentication: authenticationFor(started, state),
      outputDirectory: join(workDirectory, `theft-${Date.now()}`),
    });

    const page = pageAt(result, started.originA, AUTH_SITE_PATHS.adminPinging);
    expect(page?.status).not.toBe('SKIPPED');
    expect(page?.incompleteReasons.map(({ code }) => code)).not.toContain('AUTH_SESSION_LOST');
    expect(pathOf(page?.viewports.desktop.finalUrl ?? null)).toBe(AUTH_SITE_PATHS.adminPinging);
    expect(pathOf(page?.viewports.mobile.finalUrl ?? null)).toBe(AUTH_SITE_PATHS.adminPinging);
    expect(result.run.executions.at(-1)?.endReason).toBe('COMPLETED');
    expect(started.requests.filter(({ path }) => path.startsWith(AUTH_SITE_PATHS.login))).toEqual([]);
    expect(result.run.safety.invariantViolationCount).toBe(0);
  });

  // SLIM-GROUP L-4: robots.txt と sitemap.xml の除外は 1 つ目の場面の Run で確かめる（読む範囲を絞らない回は、除外の判定の写しなので消した）。

  // SPEC-1: 除外の記録が前の上限（256 件。LZ-3a で撤廃）を超えても Ledger を不完全にしない場面（BN-0 の 300 個の iframe）は消した。確かめは単体の
  // `tests/unit/safety-ledger-audit-exclusion-limit.test.ts` にある。除外のパスに届かないことは `guard-audit-exclusions.test.ts` の BN-0 が確かめる。

  // TS-f（B13）: 回転するサーバの認証つきの Run で、Run のディレクトリのどのファイル（出力、保存、ZIP の中身）にも秘密の目印が残らないことは、
  // 同じ確かめ（と URL の query の目印）をしていた `authenticated-url-secrets.test.ts` の T25f に、1 か所にまとめた。
  // SLIM-GROUP L-4: 盗難とみなさないサーバの対照（制御の場面）と、認証なしの Run の場面は消した（認証なしの有効な設定は、単体
  // `tests/unit/authenticated-run.test.ts` の「Interaction を行わないことを有効な設定に記録し、ほかは変えない」が確かめる）。
});

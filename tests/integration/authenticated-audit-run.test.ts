// T25d（Task 25 の設計書の変更履歴の 2026-10-10 の T25d の Blocker の行の (1)(2)）: 監査の中核（`executeAuditRun`）の認証の指定と、セッションの
// 切れの知らせ。本物の監査の中核（Run Coordinator、factory、Guard、保存のセッション）と、127.0.0.1 の fixture のサーバ
// （`tests/helpers/authenticated-site-fixture.ts`）で確かめる。Chromium は headless だけ（テストの既定と、CLI の起動の設定の両方）。
// - `AuditRunDependencies.authentication` を渡すと、Run Coordinator に渡る（管理画面を認証済みで監査する。有効な設定の `audit.interactions` は false）。
// - 期限切れのサーバで、観測の口の `onNotice` に `AUTH_SESSION_LOST`（止まったページの URL つき）が 1 回だけ届き、その URL が、捨てたページ
//   （理由 `AUTH_SESSION_LOST` で、`detail` が当たった場所）の URL と同じ。Run は PARTIAL、実行の終わり方は `STOPPED_BY_AUTH_SESSION_LOST`。
// - もう一度認証の指定を渡して（新しいセッション）`startNew` なしで実行すると、設定の違いにならずに、止まった Run を再開する。認証の指定なし
//   では、設定が違う（`audit.interactions`）ので再開しない。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  executeAuditRun,
  type AuditRunDependencies,
  type AuditRunOutcome,
  type AuditRunStart,
} from '../../src/cli/audit-run.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/control/auth/auth-setup-contracts.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import type { RunNotice } from '../../src/orchestration/run-coordinator.js';
import {
  AUTH_SITE_PATHS,
  authenticatedStateFor,
  startAuthenticatedSite,
  type AuthenticatedSite,
} from '../helpers/authenticated-site-fixture.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { createTestConfig } from '../helpers/test-config.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;
/** 期限切れまでの管理画面の数（1 ページ目の Desktop、幅 1 つ、Mobile の 3 回）。 */
const EXPIRING_ADMIN_PAGES = 3;
const MAX_PAGES = 4;
const STRESS_WIDTHS = Object.freeze([600]);
const TEST_TIMEOUT_MS = 180_000;

describe.each(LAUNCHERS)('T25d: executeAuditRun with the authentication (%s)', (_name, launch) => {
  let workDirectory: string;
  let site: AuthenticatedSite | undefined;
  const browsers: Browser[] = [];

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-authenticated-audit-run-'));
  });

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close().catch(() => undefined)));
    await site?.close();
    site = undefined;
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  const dependenciesWith = (authentication?: RunAuthentication): AuditRunDependencies => ({
    launchBrowser: async () => {
      const browser = await launch();
      browsers.push(browser);
      return browser;
    },
    clock: () => new Date(),
    now: () => Date.now(),
    ...(authentication === undefined ? {} : { authentication }),
  });

  const authenticationFor = (started: AuthenticatedSite): RunAuthentication => ({
    initialState: authenticatedStateFor(started).state,
    approvedTestOrigins: [started.originA],
    auditExclusions: {
      excludedPathPrefixes: [AUTH_SITE_PATHS.adminLogout],
      auditPathPrefixes: [AUTH_SITE_PATHS.admin],
      dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
    },
    sessionLostPathPrefix: AUTH_SITE_PATHS.login,
    filterState: filterAuthenticatedState,
  });

  const configFor = (started: AuthenticatedSite, outputDirectory: string): AuditConfig =>
    createTestConfig(started.originA, AUTH_SITE_PATHS.admin, {
      crawl: { maxPages: MAX_PAGES },
      viewports: { stressWidths: [...STRESS_WIDTHS] },
      audit: { screenshots: false },
      output: { directory: outputDirectory },
    });

  const ranOf = (outcome: AuditRunOutcome): Extract<AuditRunOutcome, { kind: 'RAN' }> => {
    if (outcome.kind !== 'RAN') {
      throw new Error(`the audit did not run: ${outcome.kind}`);
    }
    return outcome;
  };

  it('passes the authentication to the Run, notices AUTH_SESSION_LOST with the lost page, and resumes with a new session', async () => {
    const started = await startAuthenticatedSite({ maxAdminPages: EXPIRING_ADMIN_PAGES });
    site = started;
    const outputDirectory = join(workDirectory, `expiring-${browsers.length}-${Date.now()}`);
    const config = configFor(started, outputDirectory);
    const notices: RunNotice[] = [];

    const first = ranOf(await executeAuditRun(config, dependenciesWith(authenticationFor(started)), { startNew: true }, {
      onNotice: (notice) => notices.push(notice),
    }));
    expect(first.runStatus).toBe('PARTIAL');
    expect(first.summary.executions.lastEndReason).toBe('STOPPED_BY_AUTH_SESSION_LOST');
    const lost = notices.filter((notice) => notice.kind === 'AUTH_SESSION_LOST');
    expect(lost).toHaveLength(1);
    const lostUrl = lost[0]?.kind === 'AUTH_SESSION_LOST' ? lost[0].url : '';
    expect(lostUrl.startsWith(`${started.originA}${AUTH_SITE_PATHS.admin}/`)).toBe(true);
    // 1 ページ目は監査済み。止まったのは、その後のページ。
    expect(lostUrl).not.toBe(`${started.originA}${AUTH_SITE_PATHS.admin}`);
    expect(started.requests.filter(({ method }) => method !== 'GET' && method !== 'HEAD')).toEqual([]);

    // 認証の指定なしでは、設定が違う（`audit.interactions`）ので、止まった Run を再開しない。
    const starts: AuditRunStart[] = [];
    const publicRun = await executeAuditRun(config, dependenciesWith(), { startNew: false }, { onRunStarting: (start) => starts.push(start) });
    expect(starts[0]?.resumeDecision.kind).toBe('NEW_RUN');
    expect(starts[0]?.notices.map(({ kind }) => kind)).toEqual(['CONFIG_DIFFERS']);
    ranOf(publicRun);
  }, TEST_TIMEOUT_MS);

  it('resumes the Run stopped by AUTH_SESSION_LOST when the authentication is given again (a new login)', async () => {
    const started = await startAuthenticatedSite({ maxAdminPages: EXPIRING_ADMIN_PAGES });
    site = started;
    const outputDirectory = join(workDirectory, `resume-${browsers.length}-${Date.now()}`);
    const config = configFor(started, outputDirectory);
    const first = ranOf(await executeAuditRun(config, dependenciesWith(authenticationFor(started)), { startNew: true }));
    expect(first.summary.executions.lastEndReason).toBe('STOPPED_BY_AUTH_SESSION_LOST');

    const starts: AuditRunStart[] = [];
    const resumed = ranOf(await executeAuditRun(config, dependenciesWith(authenticationFor(started)), { startNew: false }, {
      onRunStarting: (start) => starts.push(start),
    }));
    expect(starts[0]?.resumeDecision.kind).toBe('RESUME');
    expect(starts[0]?.notices).toEqual([]);
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.summary.executions.count).toBe(2);
    expect(started.requests.filter(({ method }) => method !== 'GET' && method !== 'HEAD')).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

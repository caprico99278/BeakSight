// T25g-2（独立レビュー T25R の Important I1）: 認証つきの Run と公開監査の Run は、同じ設定・同じ出力先でも、互いに再開しない（新しい Run を
// 始め、知らせ `CONFIG_DIFFERS` に違う項目 `authentication` を出す）。同じ種類どうしは、今のとおり再開する。監査の中核（`executeAuditRun`）と、
// 127.0.0.1 の fixture のサーバ（`tests/helpers/authenticated-site-fixture.ts`）で確かめる。Chromium は headless だけ。テストの既定の Chromium と、
// CLI の起動の設定の両方で確かめる。
// - 認証つきの Run は、セッションの切れ（`STOPPED_BY_AUTH_SESSION_LOST`）で止め、公開監査の Run は、止める印（`STOPPED_BY_SIGNAL`）で止める
//   （どちらも、再開できる保存の状態 `STOPPED`）。設定は `audit.interactions: false`（認証つきの Run の有効な設定と同じ形にし、Run の種類
//   だけが違うようにする）。
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { executeAuditRun, type AuditRunDependencies, type AuditRunOutcome } from '../../src/cli/audit-run.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/control/auth/auth-setup-contracts.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { RUN_ARTIFACT_FILE_NAMES } from '../../src/core/artifact-layout.js';
import type { RunSummary } from '../../src/core/contracts.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { RUN_KIND_DIFFERENCE_PATH } from '../../src/orchestration/run-checkpoint.js';
import {
  AUTH_SITE_PATHS,
  authenticatedStateFor,
  startAuthenticatedSite,
  type AuthenticatedSite,
} from '../helpers/authenticated-site-fixture.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { createTestConfig } from '../helpers/test-config.js';

/** 期限切れのサーバで、セッションを期限切れにするまでの管理画面の数（1 ページ目の Desktop と Mobile）。 */
const EXPIRING_ADMIN_PAGES = 2;
const MAX_PAGES = 4;
/**
 * 2 回目の Run の時計を進める量（ms）。Run の ID は、Run の開始の時刻の秒から作る（`createRunIdFromTime`）。すぐ止まる 1 回目の Run と同じ秒に
 * 2 回目の Run を新しく始めると、同じ名前の Run のディレクトリがすでにあるので、新しい Run を作れない（DEF-009 の扱い）。それを避けるため。
 */
const SECOND_RUN_CLOCK_OFFSET_MS = 2_000;

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;

type RunKind = 'AUTHENTICATED' | 'PUBLIC';

describe.each(LAUNCHERS)('T25g-2: the authenticated Run and the public Run do not resume each other (%s)', (_name, launch) => {
  let workDirectory: string;
  let site: AuthenticatedSite;
  const browsers: Browser[] = [];

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-resume-kind-'));
  });

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close().catch(() => undefined)));
    await site?.close();
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  function configFor(outputDirectory: string): AuditConfig {
    return createTestConfig(site.originA, AUTH_SITE_PATHS.admin, {
      crawl: { maxPages: MAX_PAGES },
      viewports: { stressWidths: [] },
      audit: { interactions: false, screenshots: false },
      output: { directory: outputDirectory },
    });
  }

  function authentication(): RunAuthentication {
    return {
      initialState: authenticatedStateFor(site).state,
      approvedTestOrigins: [site.originA],
      auditExclusions: {
        excludedPathPrefixes: [AUTH_SITE_PATHS.adminLogout],
        auditPathPrefixes: [AUTH_SITE_PATHS.admin],
        dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
      },
      sessionLostPathPrefix: AUTH_SITE_PATHS.login,
      filterState: filterAuthenticatedState,
    };
  }

  /**
   * `kind` の Run を、`startNew` で行う。`stop` が真なら止める（認証つきの Run は、期限切れのサーバのセッションの切れで止まるので、何もしない。
   * 公開監査の Run は、始める前に付けた止める印で止める）。
   */
  async function runAs(
    kind: RunKind,
    outputDirectory: string,
    options: { readonly startNew: boolean; readonly stop: boolean; readonly clockOffsetMs?: number },
  ): Promise<AuditRunOutcome> {
    const clockOffsetMs = options.clockOffsetMs ?? 0;
    const dependencies: AuditRunDependencies = {
      launchBrowser: async () => {
        const browser = await launch();
        browsers.push(browser);
        return browser;
      },
      clock: () => new Date(Date.now() + clockOffsetMs),
      now: () => Date.now(),
      ...(kind === 'AUTHENTICATED' ? { authentication: authentication() } : {}),
      ...(kind === 'PUBLIC' && options.stop ? { stopSignal: AbortSignal.abort() } : {}),
    };
    return await executeAuditRun(configFor(outputDirectory), dependencies, { startNew: options.startNew });
  }

  async function lastEndReasonOf(outcome: AuditRunOutcome): Promise<string | undefined> {
    if (outcome.kind !== 'RAN') return undefined;
    const run = JSON.parse(await readFile(join(outcome.runDirectory, RUN_ARTIFACT_FILE_NAMES.run), 'utf8')) as RunSummary;
    return run.executions.at(-1)?.endReason;
  }

  it.each([
    ['an authenticated Run stopped by the session loss is not resumed by a public Run', 'AUTHENTICATED', 'PUBLIC', 'STOPPED_BY_AUTH_SESSION_LOST'],
    ['a public Run stopped by the stop signal is not resumed by an authenticated Run', 'PUBLIC', 'AUTHENTICATED', 'STOPPED_BY_SIGNAL'],
  ] as const)('%s (a new Run with CONFIG_DIFFERS)', async (_case, first, second, stoppedBy) => {
    site = await startAuthenticatedSite({ maxAdminPages: EXPIRING_ADMIN_PAGES });
    const outputDirectory = join(workDirectory, `${first}-${second}-${Date.now()}`);
    const stopped = await runAs(first, outputDirectory, { startNew: true, stop: true });
    expect(stopped.kind).toBe('RAN');
    expect(await lastEndReasonOf(stopped)).toBe(stoppedBy);

    const next = await runAs(second, outputDirectory, { startNew: false, stop: false, clockOffsetMs: SECOND_RUN_CLOCK_OFFSET_MS });
    expect(next.kind).toBe('RAN');
    if (next.kind !== 'RAN' || stopped.kind !== 'RAN') return;
    expect(next.resumeDecision.kind).toBe('NEW_RUN');
    expect(next.notices).toEqual([{ kind: 'CONFIG_DIFFERS', runId: stopped.runId, differences: [RUN_KIND_DIFFERENCE_PATH] }]);
    expect(next.runId).not.toBe(stopped.runId);
  });

  it.each([
    ['an authenticated Run resumes an authenticated Run', 'AUTHENTICATED'],
    ['a public Run resumes a public Run', 'PUBLIC'],
  ] as const)('%s (as before)', async (_case, kind) => {
    site = await startAuthenticatedSite({ maxAdminPages: EXPIRING_ADMIN_PAGES });
    const outputDirectory = join(workDirectory, `${kind}-${kind}-${Date.now()}`);
    const stopped = await runAs(kind, outputDirectory, { startNew: true, stop: true });
    expect(stopped.kind).toBe('RAN');

    const next = await runAs(kind, outputDirectory, { startNew: false, stop: false, clockOffsetMs: SECOND_RUN_CLOCK_OFFSET_MS });
    expect(next.kind).toBe('RAN');
    if (next.kind !== 'RAN' || stopped.kind !== 'RAN') return;
    expect(next.resumeDecision).toMatchObject({ kind: 'RESUME', runId: stopped.runId });
    expect(next.notices).toEqual([]);
    expect(next.runId).toBe(stopped.runId);
  });
});

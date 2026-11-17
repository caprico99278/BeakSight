// DEF-191（設計書 `doc/design/2026-11-04-beaksight-login-session-design.md` 3.1・5 章）: 長い点検でログインが切れない。更新の鍵を回し、使い終えた鍵の
// 再使用で系列を取り消すサービス（`tests/helpers/rotating-token-site.ts`）を、token の期限を数十秒に縮めて、本物の監査の流れ（`executeAuditRun`。factory・
// Guard・Page Auditor）で 6 ページ監査する（TEST-TIME-B: 期限を 8 秒に縮め、14 ページから減らした）。
// - 直す前: 幅の走査（S）を、最初の読み込み（D）の Context を開いたまま回すので、D と S が同じ更新の鍵で更新を送り、サーバが使い回しとみなして取り消す
//   （セッションの切れで止まる。RED）。
// - 直した後: サービスの Origin へ送れる Context は同時に 1 つ（D を閉じてから S）。どの更新も今の鍵で送られ（使い回しがない）、全部のページを切れずに COMPLETED。
// - 使い回しの扱いは、すぐ取り消す `strict`（SLIM-GROUP L-4: 親の鍵の再使用を許す `lenient` の回は、同じ順の守りの写しなので消した）。
// Chromium はテストの既定の headless だけ（TEST-SLIM）。届いたかはサーバの記録で数え、名前つきの時間だけ待って数え直す。
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { executeAuditRun } from '../../src/cli/audit-run.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import type { RunSummary } from '../../src/core/contracts.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { hasSuccessStorageKey } from '../../src/worker/login-stage-checks.js';
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { settleLateDeliveries } from '../helpers/loopback-server.js';
import {
  ROTATING_TOKEN_PATHS,
  ROTATING_TOKEN_STORAGE_KEY,
  startRotatingTokenSite,
  type RotatingTokenReuseMode,
  type RotatingTokenSite,
} from '../helpers/rotating-token-site.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import { TEST_RUN_PROGRESS_QUIET_LIMIT_MS } from '../helpers/run-harness.js';
import { createTestConfig } from '../helpers/test-config.js';
import { TEST_OBSERVATION_WINDOWS } from '../helpers/test-waits.js';

/**
 * 監査するページの数。TEST-TIME-B: 設計書 5 章の「14 ページ以上」は、本番に近い間隔で token の期限を越えるための数だった。期限を 8 秒に縮めたので、6 ページに
 * 減らした（期限を越えたことは、Run の長さが期限より長いことで確かめる）。
 */
const PAGES = 6;
/**
 * token の期限を数秒に縮める（長い時間を待つ再現はしない）。TEST-TIME-B: 20 秒から 8 秒へ（比を保ち、余白も縮めた）。更新は約 3 秒ごとに来るので、D と S が
 * 同時に生きていれば、ほぼどのページでも更新の境目が S の間に入る（確かめの間隔を 1 秒にして、D と S の両方がすぐ気づく）。
 */
const ACCESS_LIFETIME_MS = 8_000;
const LOAD_MARGIN_MS = 3_000;
const TICK_MARGIN_MS = 5_000;
const TICK_MS = 1_000;
/** 幅の走査の幅（主の Desktop と Mobile の幅と重ならない 1 幅）。 */
const STRESS_WIDTH = 600;
/** Run の後に、遅れて届く要求を待つ時間（数え直す）。 */
const LATE_REQUEST_WAIT_MS = 2_000;
const RUN_TIMEOUT_MS = 290_000;

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('DEF-191: a long audit keeps the sign-in on a server that rotates the refresh token (%s)', (_label, launch) => {
  let site: RotatingTokenSite | undefined;
  let workDirectory = '';

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-token-rotation-'));
  });

  afterEach(async () => {
    await site?.close();
    site = undefined;
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  const audit = async (mode: RotatingTokenReuseMode): Promise<{ readonly site: RotatingTokenSite; readonly run: RunSummary; readonly elapsedMs: number }> => {
    site = await startRotatingTokenSite({
      pages: PAGES, accessLifetimeMs: ACCESS_LIFETIME_MS, marginMs: LOAD_MARGIN_MS, tickMarginMs: TICK_MARGIN_MS, tickMs: TICK_MS, mode,
    });
    const started = site;
    const authentication: RunAuthentication = {
      initialState: {
        cookies: [],
        origins: [{ origin: started.appOrigin, localStorage: [{ name: ROTATING_TOKEN_STORAGE_KEY, value: started.issueStoredSession() }] }],
      },
      approvedTestOrigins: [started.appOrigin],
      auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: ROTATING_TOKEN_PATHS.auth,
      filterState: filterAuthenticatedState,
      auditStage: {
        approvedServiceOrigins: [started.svcOrigin],
        auditReadRequests: [],
        scriptLogin: { origin: started.svcOrigin, path: ROTATING_TOKEN_PATHS.token, requiredQuery: [{ name: 'grant_type', value: 'password' }] },      },
      sessionKeyPresent: (state) => hasSuccessStorageKey(state, { origin: started.appOrigin, prefix: 'fixture', suffix: '-auth-token' }),
    };
    const config = createTestConfig(started.appOrigin, `${ROTATING_TOKEN_PATHS.pagePrefix}1`, {
      target: { id: `def191-${mode}` },
      output: { directory: join(workDirectory, `${mode}-${String(Date.now())}`) },
      crawl: { maxPages: PAGES },
      // 幅の走査（D と同時に生きていた読み込み）。SLIM-GROUP L-4: 1 幅で足りる。確かめるのは更新と切れだけなので、accessibility の収集は外す。
      // token の更新を通すので、監査の段の送信の扱いは `PASS_EXCEPT_DELETE` のまま（READ_ONLY では更新が止まる）。
      viewports: { stressWidths: [STRESS_WIDTH] },
      audit: { sendPolicy: 'PASS_EXCEPT_DELETE', screenshots: false, performance: false, accessibility: false },
    });
    const startedAt = Date.now();
    const outcome = await executeAuditRun(config, {
      launchBrowser: () => launch(), clock: () => new Date(), now: () => Date.now(), authentication,
      // DEF-245 の A: 見張りの反応なしの長さを短くする（本番は 180 秒）。SLIM-2（X5b）: 閉じる前の待ちはテストの短い値（本番の値は
      // `production-wait-values` と、口を渡さない結合が確かめる）。
      createRunCoordinator: (dependencies) => new RunCoordinator({
        ...dependencies, progressWatchQuietLimitMs: TEST_RUN_PROGRESS_QUIET_LIMIT_MS, observationWindows: TEST_OBSERVATION_WINDOWS,
      }),
    }, { startNew: true });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the audit did not run: ${outcome.kind}`);
    }
    const elapsedMs = Date.now() - startedAt;
    return { site: started, run: JSON.parse(readFileSync(join(outcome.runDirectory, 'run.json'), 'utf8')) as RunSummary, elapsedMs };
  };

  // SLIM-GROUP L-4: 親の鍵の再使用を許す `lenient` の回は消した（D を閉じてから S を回す順の守りは、すぐ取り消す `strict` の回で決まる）。
  it(`audits ${String(PAGES)} pages without the session loss and never reuses a refresh token (strict)`, async () => {
    const { site: started, run, elapsedMs } = await audit('strict');
    // TEST-TIME-B: 縮めた期限を、監査の長さが越えた（更新しなければ、後半のページで期限が切れる長さ）。更新が起きたことは下の `refreshes` で確かめる。
    expect(elapsedMs).toBeGreaterThan(ACCESS_LIFETIME_MS);
    const refreshes = started.refreshRecords.length;
    const serviceRequests = started.requestLog.filter(({ origin }) => origin === 'svc').length;
    // 名前つきの時間だけ待って、遅れて届く要求を数え直す（Run の後には届かない）。TEST-TIME-B（案 9）: Run は Browser を閉じて終わるので、受けている途中の
    // 要求が 0 になってから短い余白だけ待つ（上限は前の固定の待ち）。
    await settleLateDeliveries(LATE_REQUEST_WAIT_MS, started);
    expect(started.refreshRecords.length).toBe(refreshes);
    expect(started.requestLog.filter(({ origin }) => origin === 'svc').length).toBe(serviceRequests);

    expect({ endReason: run.executions.at(-1)?.endReason, audited: run.auditedPageCount, revokedAtMs: started.revokedAtMs })
      .toEqual({ endReason: 'COMPLETED', audited: PAGES, revokedAtMs: null });
    expect(run.incompleteReasons.map(({ code }) => code)).not.toContain('AUTH_SESSION_LOST');
    // 期限を何度も切ったので、更新は届いた（その形を確かめた）。どの更新も今の鍵で送られ、使い回しがない。
    expect(refreshes).toBeGreaterThanOrEqual(2);
    expect(started.refreshRecords.filter(({ tokenIndex, activeIndex }) => tokenIndex !== activeIndex)).toEqual([]);
    expect(started.refreshRecords.map(({ outcome }) => outcome).filter((outcome) => outcome !== 'ROTATED')).toEqual([]);
    // ログインの画面は読まれない。サービスの読み取りは、どれも認証のまま通った。
    expect(started.requestLog.filter(({ path }) => path === ROTATING_TOKEN_PATHS.auth)).toEqual([]);
    expect(started.requestLog.filter(({ origin, status }) => origin === 'svc' && status >= 400)).toEqual([]);
    expect(run.safety.invariantViolationCount).toBe(0);
  }, RUN_TIMEOUT_MS);
});

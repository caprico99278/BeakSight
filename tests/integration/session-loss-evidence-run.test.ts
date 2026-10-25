// DEF-138（設計書 `2026-10-19-beaksight-session-loss-evidence-design.md` 3 章の受け入れ条件 1・4・5）: 監査の Run がセッションの切れで止まったとき、
// `run.json` の `authentication.sessionLoss` に、判定したページの証拠（頼んだ path、行き着いた先、経路、止めた要求、鍵の名前の違い）が残る。
// - fixture（認証つきの SPA）の 2 ページ目が、クライアントの側でログインの画面へ移る（ローカル ストレージのログインの状態の鍵を消してから移る）場合と、
//   サーバの側でリダイレクトする（ログインの画面は読む範囲の外で、Guard がリダイレクトを止める）場合。
// - token・query の値（移る先の URL の目印）・資格情報が `run.json` に出ない。止める・飛ばす（`STOPPED_BY_AUTH_SESSION_LOST`、理由 `AUTH_SESSION_LOST`）
//   は今のまま。
// Chromium はテストの既定の headless。値は出力しない。
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import { executeAuditRun } from '../../src/cli/audit-run.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { RunSummary } from '../../src/core/contracts.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_SESSION_LOSS_PATH,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaSessionLossPage,
} from '../helpers/spa-auth-site-fixture.js';

const TEST_TIMEOUT_MS = 180_000;
const MAX_PAGES = 4;
/** 移る先の path の表記（query は名前だけ。名前はログインの段の観察の記録と同じく並べる）。 */
const LANDED_PATH = `${SPA_APP_PATHS.auth}?from&ticket`;
const LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });

describe('DEF-138: the session loss evidence in run.json of an audit Run', () => {
  let site: SpaAuthSite | undefined;
  let workDirectory = '';
  let runCount = 0;

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-session-loss-run-'));
  });

  afterEach(async () => {
    await site?.close();
    site = undefined;
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  const auditStageOf = (spa: SpaAuthSite): AuditStageServiceRequests => ({
    approvedServiceOrigins: [spa.backendOrigin],
    auditReadRequests: [],
    scriptLogin: { origin: spa.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
    serviceRequestLimits: LIMITS,
  });

  const auditAdmin = async (
    page: SpaSessionLossPage,
    options: { readonly auditPathPrefixes: readonly string[]; readonly scriptLogin: boolean },
  ): Promise<{ readonly run: RunSummary; readonly text: string; readonly spa: SpaAuthSite }> => {
    runCount += 1;
    const spa = await startSpaAuthSite({ sessionLossPage: page });
    site = spa;
    spa.addMember('既存花子');
    const authentication: RunAuthentication = {
      initialState: { cookies: [], origins: [{ origin: spa.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: spa.issueStoredSession() }] }] },
      approvedTestOrigins: [spa.appOrigin],
      auditExclusions: { excludedPathPrefixes: [SPA_APP_PATHS.logout], auditPathPrefixes: options.auditPathPrefixes, dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: SPA_APP_PATHS.auth,
      filterState: filterAuthenticatedState,
      ...(options.scriptLogin ? { auditStage: auditStageOf(spa) } : {}),
    };
    const name = `${page}-${runCount}`;
    const base = fastRunConfig(spa.appOrigin, SPA_APP_PATHS.admin, {
      target: { id: `loss-${name}` }, output: { directory: join(workDirectory, name) }, crawl: { maxPages: MAX_PAGES },
    });
    const config: AuditConfig = { ...base, site: { startUrl: `${spa.appOrigin}${SPA_APP_PATHS.admin}`, allowedOrigins: [spa.appOrigin] } };
    const outcome = await executeAuditRun(config, {
      launchBrowser: () => launchHeadlessChromium(), clock: () => new Date(), now: () => Date.now(), authentication,
    }, { startNew: true });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the audit did not run: ${outcome.kind}`);
    }
    const text = readFileSync(join(outcome.runDirectory, 'run.json'), 'utf8');
    return { run: JSON.parse(text) as RunSummary, text, spa };
  };

  const expectNoValues = (text: string, spa: SpaAuthSite): void => {
    for (const marker of [...spa.sessionLossMarkers(), ...spa.secretValues()]) {
      expect(text.includes(marker)).toBe(false);
    }
  };

  it('keeps the evidence of a page that moves to the login page on the client side (the key removed), without values', async () => {
    const { run, text, spa } = await auditAdmin('client', { auditPathPrefixes: [], scriptLogin: false });
    // 止める・飛ばすは今のまま（受け入れ条件 5）。
    expect(run.runStatus).toBe('PARTIAL');
    expect(run.executions.at(-1)?.endReason).toBe('STOPPED_BY_AUTH_SESSION_LOST');
    expect(run.incompleteReasons).toContainEqual({ code: 'AUTH_SESSION_LOST', detail: null });
    const loss = run.authentication?.sessionLoss;
    expect(loss).toBeDefined();
    // フォームの送信のログインの Run（監査の段の数がない）は、証拠だけを持つ。
    expect(Object.keys(run.authentication ?? {})).toEqual(['sessionLoss']);
    expect(loss?.stage).toBe('desktop:passive');
    expect(loss?.requestedPath).toBe(SPA_SESSION_LOSS_PATH);
    expect(loss?.landedPath).toBe(LANDED_PATH);
    expect(loss?.landedBy).toBe('PAGE_URL');
    expect(loss?.redirectPaths).toContainEqual({ originKind: 'ALLOWED', path: SPA_SESSION_LOSS_PATH });
    expect(loss?.redirectPaths).toContainEqual({ originKind: 'ALLOWED', path: LANDED_PATH });
    expect(loss?.storageKeyChange).toContainEqual({
      storage: 'LOCAL_STORAGE', originKind: 'ALLOWED', change: 'REMOVED', count: 1, shapes: [{ prefix: '', suffix: '-token' }],
    });
    expect(Array.isArray(loss?.blockedRequests)).toBe(true);
    expectNoValues(text, spa);
  }, TEST_TIMEOUT_MS);

  it('keeps the evidence of a page that the server redirects to the login page outside the audit range (the Guard stops it), without values', async () => {
    const { run, text, spa } = await auditAdmin('server', { auditPathPrefixes: [SPA_APP_PATHS.admin], scriptLogin: true });
    expect(run.runStatus).toBe('PARTIAL');
    expect(run.executions.at(-1)?.endReason).toBe('STOPPED_BY_AUTH_SESSION_LOST');
    // スクリプトで送るログインの Run は、監査の段の数と証拠の両方を持つ。
    expect(run.authentication?.serviceRequestLimitReached).toBe(false);
    const loss = run.authentication?.sessionLoss;
    expect(loss?.stage).toBe('desktop:passive');
    expect(loss?.requestedPath).toBe(SPA_SESSION_LOSS_PATH);
    expect(loss?.landedPath).toBe(LANDED_PATH);
    expect(loss?.landedBy).toBe('BLOCKED_REDIRECT');
    expect(loss?.redirectPaths[0]).toEqual({ originKind: 'ALLOWED', path: SPA_SESSION_LOSS_PATH });
    expect(loss?.redirectPaths).toContainEqual({ originKind: 'ALLOWED', path: LANDED_PATH });
    expect(loss?.blockedRequests).toContainEqual({ method: 'GET', originKind: 'ALLOWED', path: SPA_APP_PATHS.auth, reason: 'AUDIT_EXCLUDED_URL', count: 1 });
    // 鍵は消えていない（読み込みの前と後で名前が同じ）。
    expect(loss?.storageKeyChange?.filter(({ storage, originKind }) => storage === 'LOCAL_STORAGE' && originKind === 'ALLOWED')).toEqual([]);
    expectNoValues(text, spa);
  }, TEST_TIMEOUT_MS);
});

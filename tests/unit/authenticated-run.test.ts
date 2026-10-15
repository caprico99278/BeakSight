// T25c（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 4.2、4.3、4.7 と、変更履歴の 2026-10-10 の Blocker の
// 行）: 認証つきの Run の指定の部品（`src/orchestration/authenticated-run.ts`）と、セッションの切れの実行の終わり方と保存の終わり方
// （`src/orchestration/run-checkpoint.ts`）。ブラウザは使わない。
// CCX-10: 読み込みの事前の判定（要求の判定 `classifyPassiveRequest` とセッションの切れの path）の唯一の部品 `isRunNavigationBlocked`。止める
// 範囲は引数（`AUDIT_EXCLUSION`: 巡回の候補の除外、`ANY_BLOCK`: READ の事前の判定）で選ぶ。巡回（`isExcludedCrawlCandidate`）と READ
// （`isReadUrlAllowed`）の判定の表を、まとめる前と後で同じに保つ。
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/control/auth/auth-setup-contracts.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import {
  assertRunAuthentication,
  AUTH_SESSION_LOST_SKIP_REASON,
  authenticatedContextOptions,
  authenticatedRunConfig,
  authSessionLostReason,
  isExcludedCrawlCandidate,
  isRunNavigationBlocked,
  isSessionLostUrl,
  RUN_NAVIGATION_BLOCK_SCOPES,
  type RunAuthentication,
} from '../../src/orchestration/authenticated-run.js';
import {
  decideRunCheckpointConclusion,
  decideRunExecutionEndReason,
  RESUME_REQUEUE_SKIP_REASON_CODES,
} from '../../src/orchestration/run-checkpoint.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { isReadUrlAllowed } from '../../src/worker/read-check-run.js';
import { createTestConfig } from '../helpers/test-config.js';

const ORIGIN = 'http://127.0.0.1:4173';
const OTHER_ORIGIN = 'http://localhost:4174';
/** 秘密の目印（誤りの文に現れないことを確かめる仮の値）。 */
const SECRET_MARKER = 'secret-marker-7f3a9c';

const CONFIG = createTestConfig(ORIGIN, '/admin');

function authentication(overrides: Partial<Record<keyof RunAuthentication, unknown>> = {}): RunAuthentication {
  return {
    initialState: {
      cookies: [{ name: 'sid', value: SECRET_MARKER, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
      origins: [],
    },
    approvedTestOrigins: [ORIGIN],
    auditExclusions: {
      excludedPathPrefixes: ['/admin/logout'],
      auditPathPrefixes: ['/admin'],
      dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
    },
    sessionLostPathPrefix: '/login',
    filterState: filterAuthenticatedState,
    ...overrides,
  } as RunAuthentication;
}

describe('T25c: the authenticated Run specification', () => {
  it('accepts a well-formed specification', () => {
    expect(() => assertRunAuthentication(authentication(), CONFIG)).not.toThrow();
  });

  it.each([
    ['not an object', null],
    ['no initial state', { initialState: undefined }],
    ['no filter function', { filterState: 'filter' }],
    ['malformed audit exclusions', { auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [] } }],
    ['a session lost prefix that is not a path', { sessionLostPathPrefix: 'login' }],
    ['no approved test origins', { approvedTestOrigins: [] }],
    ['an approved test origin outside site.allowedOrigins', { approvedTestOrigins: [ORIGIN, OTHER_ORIGIN] }],
  ] as const)('rejects %s with a TypeError that carries no secret value', (_case, overrides) => {
    const value = overrides === null ? null : authentication(overrides);
    let thrown: unknown;
    try {
      assertRunAuthentication(value, CONFIG);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(String((thrown as Error).message)).not.toContain(SECRET_MARKER);
  });

  it('makes the RunCoordinator constructor reject a malformed specification, and keeps it optional', () => {
    const base = {
      config: CONFIG,
      launchBrowser: async () => {
        throw new Error('not launched');
      },
      createSafetyLedger: () => new SafetyLedger(),
      clock: () => new Date(),
      now: () => Date.now(),
      outputDirectory: 'unused-output',
    };
    expect(() => new RunCoordinator({ ...base, authentication: authentication({ approvedTestOrigins: [OTHER_ORIGIN] }) }))
      .toThrow(TypeError);
    expect(() => new RunCoordinator({ ...base, authentication: authentication() })).not.toThrow();
    expect(() => new RunCoordinator(base)).not.toThrow();
  });

  it('records that Interaction is not run in the effective configuration, and keeps everything else (design 4.7)', () => {
    const effective = authenticatedRunConfig(CONFIG);
    expect(effective.audit).toEqual({ ...CONFIG.audit, interactions: false });
    expect({ ...effective, audit: CONFIG.audit }).toEqual(CONFIG);
    expect(CONFIG.audit.interactions).toBe(true);
  });

  it('wraps the filter with the approved test origins for the factory', () => {
    const options = authenticatedContextOptions(authentication());
    const filtered = options.filterState({
      cookies: [
        { name: 'sid', value: SECRET_MARKER, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' },
        { name: 'idp', value: SECRET_MARKER, domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' },
      ],
      origins: [
        { origin: ORIGIN, localStorage: [{ name: 'a', value: SECRET_MARKER }] },
        { origin: OTHER_ORIGIN, localStorage: [{ name: 'b', value: SECRET_MARKER }] },
      ],
    });
    expect(filtered.cookies.map(({ name }) => name)).toEqual(['sid']);
    expect(filtered.origins.map(({ origin }) => origin)).toEqual([ORIGIN]);
  });
});

describe('T25c: crawl candidates and the session lost path', () => {
  const allowed: ReadonlySet<string> = new Set([ORIGIN]);
  const spec = authentication();

  it.each([
    ['the logout path', `${ORIGIN}/admin/logout`],
    ['a dangerous word in the path', `${ORIGIN}/admin/items/1/delete`],
    ['a dangerous word in the query (upper case)', `${ORIGIN}/admin/items?action=CANCEL`],
    ['a percent-encoded dangerous word', `${ORIGIN}/admin/%72emove`],
    ['a path outside the audit range', `${ORIGIN}/public/page`],
    ['the session lost path (the login page)', `${ORIGIN}/login?expired=1`],
  ] as const)('excludes %s from the crawl candidates (the same judgement as the Guard)', (_case, url) => {
    expect(isExcludedCrawlCandidate(url, allowed, spec)).toBe(true);
  });

  it.each([
    ['the admin page', `${ORIGIN}/admin`],
    ['an admin sub page', `${ORIGIN}/admin/second?page=2`],
  ] as const)('keeps %s as a crawl candidate', (_case, url) => {
    expect(isExcludedCrawlCandidate(url, allowed, spec)).toBe(false);
  });

  it('judges the session lost path by the path prefix of a parsable URL', () => {
    expect(isSessionLostUrl(`${ORIGIN}/login`, '/login')).toBe(true);
    expect(isSessionLostUrl(`${ORIGIN}/login?expired=1`, '/login')).toBe(true);
    expect(isSessionLostUrl(`${ORIGIN}/admin?next=/login`, '/login')).toBe(false);
    expect(isSessionLostUrl('about:blank', '/login')).toBe(false);
    expect(isSessionLostUrl('not a url', '/login')).toBe(false);
  });

  it('builds the reasons of the session loss (the trigger page with the place, the others without detail)', () => {
    expect(AUTH_SESSION_LOST_SKIP_REASON).toEqual({ code: 'AUTH_SESSION_LOST', detail: null });
    expect(authSessionLostReason('desktop:passive')).toEqual({ code: 'AUTH_SESSION_LOST', detail: 'desktop:passive' });
    expect(Object.isFrozen(authSessionLostReason('mobile:passive'))).toBe(true);
  });
});

describe('CCX-10: the navigation pre-check shared by the crawl and the READ check', () => {
  /** 設定の許可 Origin には別の Origin も入れる（プロファイルの許可 Origin の外を、READ だけが止めることを確かめる）。 */
  const config = { ...CONFIG, site: { ...CONFIG.site, allowedOrigins: [ORIGIN, OTHER_ORIGIN] } };
  const allowed: ReadonlySet<string> = new Set(config.site.allowedOrigins);
  const spec = authentication();
  /** [場合, URL, 巡回の候補から外すか, READ で読んでよいか]（まとめる前の振る舞いを固定した表）。 */
  const CASES = [
    ['the admin page', `${ORIGIN}/admin`, false, true],
    ['an admin sub page with a query', `${ORIGIN}/admin/second?page=2`, false, true],
    ['the logout path', `${ORIGIN}/admin/logout`, true, false],
    ['a dangerous word in the path', `${ORIGIN}/admin/items/1/delete`, true, false],
    ['a dangerous word in the query (upper case)', `${ORIGIN}/admin/items?action=CANCEL`, true, false],
    ['a percent-encoded dangerous word', `${ORIGIN}/admin/%72emove`, true, false],
    ['a path outside the audit range', `${ORIGIN}/public/page`, true, false],
    ['the session lost path (the login page)', `${ORIGIN}/login?expired=1`, true, false],
    ['an allowed origin outside the approved test origins', `${OTHER_ORIGIN}/admin`, false, false],
    ['an origin outside the allowed origins', 'http://127.0.0.1:4999/admin', false, false],
    ['a non-http URL', 'ftp://127.0.0.1:4173/admin', false, false],
  ] as const;

  it.each(CASES)('keeps the crawl and READ judgements of %s', (_case, url, excluded, readable) => {
    expect(isExcludedCrawlCandidate(url, allowed, spec)).toBe(excluded);
    expect(isReadUrlAllowed(url, config, spec)).toBe(readable);
  });

  it('has the closed list of the scopes', () => {
    expect(RUN_NAVIGATION_BLOCK_SCOPES).toEqual(['AUDIT_EXCLUSION', 'ANY_BLOCK']);
  });

  it.each(CASES)('decides %s by the scope: audit exclusions only for the crawl, any block for the READ check', (_case, url, excluded) => {
    expect(isRunNavigationBlocked(url, allowed, spec, 'AUDIT_EXCLUSION')).toBe(excluded);
    const anyBlock = isRunNavigationBlocked(url, allowed, spec, 'ANY_BLOCK');
    // どの BLOCK でも止める範囲は、除外の範囲を含む。
    expect(anyBlock || !excluded).toBe(true);
  });

  it('stops any block only with the ANY_BLOCK scope (an origin outside the allowed origins)', () => {
    const outside = 'http://127.0.0.1:4999/admin';
    expect(isRunNavigationBlocked(outside, allowed, spec, 'AUDIT_EXCLUSION')).toBe(false);
    expect(isRunNavigationBlocked(outside, allowed, spec, 'ANY_BLOCK')).toBe(true);
    expect(isRunNavigationBlocked(`${ORIGIN}/admin`, allowed, spec, 'ANY_BLOCK')).toBe(false);
    expect(isRunNavigationBlocked(`${ORIGIN}/login`, allowed, spec, 'ANY_BLOCK')).toBe(true);
  });
});

describe('T25c: the execution end and the checkpoint conclusion of a Run stopped by the session loss', () => {
  const skipReasonCodes = new Set(['AUTH_SESSION_LOST'] as const);

  it('ends the execution with STOPPED_BY_AUTH_SESSION_LOST', () => {
    expect(decideRunExecutionEndReason({ runStatus: 'PARTIAL', skipReasonCodes })).toBe('STOPPED_BY_AUTH_SESSION_LOST');
    expect(decideRunExecutionEndReason({ runStatus: 'ABORTED_BY_SAFETY', skipReasonCodes })).toBe('STOPPED_BY_SAFETY_VIOLATION');
  });

  it('keeps the checkpoint STOPPED (resumable), and requeues the skipped URLs on resume', () => {
    expect(decideRunCheckpointConclusion({
      sessionStarted: true,
      runStatus: 'PARTIAL',
      skipReasonCodes,
      checkpointWriteFailed: false,
      resumed: false,
      preflightFailed: false,
      hasWrittenCheckpoint: true,
    })).toMatchObject({ action: 'FINISH', state: 'STOPPED' });
    expect(RESUME_REQUEUE_SKIP_REASON_CODES).toContain('AUTH_SESSION_LOST');
  });
});

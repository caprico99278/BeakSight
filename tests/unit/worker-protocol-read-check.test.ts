// T27e（Task 27 の設計書 4.5、4.6）: IPC の契約（`src/control/worker-protocol.ts`）の、READ の確かめのジョブ（`READ_CHECK`）の部分。
// - `START`: `READ_CHECK` は、認証の指定と、定義の一覧（1 件以上。L4: 件数の上限なし）を必ず持つ。ほかの種類は定義の一覧を持たない。定義の ID の
//   形と重複、対象の画面の Origin と path、定義の中身（`read-check-definition` のスキーマを参照）を確かめる。秘密に見える名前の送る値は拒む
//   （誤りの文に名前と値を書かない）。
// - `FINISHED`: 件数の要約（`readCheck`）は、Run を実行した結果だけ、発見の件数の要約と同時には持たない、確かめた数は定義の数以下。
// - スキーマの上限は、名前つきの定数と一致する。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
  WORKER_PROTOCOL_VERSION,
  WORKER_READ_CHECK_JOB_KIND,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
  type WorkerJobKind,
} from '../../src/control/worker-protocol.js';

const ORIGIN = 'http://127.0.0.1:4173';
const DIGEST = `sha256:${'b'.repeat(64)}`;
const SECRET_VALUE = 'secret-value-example';

const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-read',
  profileRevision: 1,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [],
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

const readCheck = (index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  readCheckId: `read-${index}`,
  readCheckRevision: 1,
  targetPage: { origin: ORIGIN, path: '/admin/search' },
  definition: { targetIdentityDigest: DIGEST, parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 0 }] },
  ...overrides,
});

const start = (jobKind: WorkerJobKind, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-read',
  jobKind,
  targetConfigPath: 'local/targets/example-read.json',
  startNew: true,
  targetConfigSha256: targetConfigDigestOf(new TextEncoder().encode('{}')),
  authentication: {
    setup: SETUP,
    approvedTestOrigins: [ORIGIN],
    authenticationSha256: workerAuthenticationDigestOf(SETUP, [ORIGIN], { jobKind, automatedLogin: null }),
  },
  ...extra,
});

const errorsOf = (value: unknown): readonly string[] => {
  const checked = validateParentToWorkerMessage(value);
  return checked.ok ? [] : checked.errors;
};

describe('T27e: START of a READ check job', () => {
  it('accepts READ_CHECK with the authentication and definitions, a null target page included', () => {
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [readCheck(1)] }))).toEqual([]);
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [readCheck(1, { targetPage: null })] }))).toEqual([]);
  });

  it('rejects READ_CHECK without definitions and without the authentication, and accepts many definitions (L4)', () => {
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND))).toContain('/readChecks is required for READ_CHECK');
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [] })).length).toBeGreaterThan(0);
    // L4（COV-7）: 定義の数の上限はない（前の上限 20 を超えても受ける）。
    const many = Array.from({ length: 25 },(_, index) => readCheck(index));
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: many }))).toEqual([]);
    const { authentication: _authentication, ...unauthenticated } = start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [readCheck(1)] });
    expect(errorsOf(unauthenticated)).toContain('/authentication is required for READ_CHECK');
  });

  // RCA-6（検索の確かめの設計書 2.2、版 10）: 検索の確かめの組。人の定義が空でも、組が 1 つ以上あれば始められる。守りに当たる組と、ほかの種類の組は拒む。
  it('accepts the search checks with an empty list of definitions, and rejects a guarded combo or the combos on another kind', () => {
    const key = (letter: string): string => `sha256:${letter.repeat(64)}`;
    const form = {
      kind: 'FORM', key: key('a'), page: { origin: ORIGIN, path: '/items' }, targetIdentityDigest: DIGEST, parameters: { q: '' },
      change: { kind: 'TEXT', field: 'q', text: 'FULL_WIDTH' }, unsentHiddenFields: false,
    };
    const script = {
      kind: 'SCRIPT', key: key('b'), page: { origin: ORIGIN, path: '/items' }, text: 'EMPTY',
      trigger: { kind: 'TYPED', stage: 1, priorPresses: [], field: { name: 'kw', selector: '#kw', type: 'search' } },
    };
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [], searchChecks: [form, script] }))).toEqual([]);
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [], searchChecks: [] })).length).toBeGreaterThan(0);
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [], searchChecks: [{ ...form, parameters: { api_key: '' } }] })))
      .toEqual(['/searchChecks/0/parameters must not send a secret-like name or a dangerous word']);
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [], searchChecks: [form, { ...script, key: key('a') }] })))
      .toEqual(['/searchChecks/1/key must be unique']);
    expect(errorsOf(start('DISCOVERY', { searchChecks: [form] }))).toContain('/searchChecks is allowed only for READ_CHECK');
    // REV-RCA の I-4: ログインし直す段の、戻された組の鍵は、渡す組のどれかの鍵。
    const relogin = (bouncedSearchCheckKey: string): Record<string, unknown> => ({
      protocol: WORKER_PROTOCOL_VERSION, type: 'RELOGIN_STAGE', jobId: 'job-read-2', jobKind: WORKER_READ_CHECK_JOB_KIND, count: 1, readChecks: [],
      searchChecks: [form, script], bouncedSearchCheckKey,
    });
    expect(errorsOf(relogin(key('b')))).toEqual([]);
    expect(errorsOf(relogin(key('c')))).toEqual(['/bouncedSearchCheckKey must be the key of one of /searchChecks']);
  });

  it('rejects definitions on any other job kind', () => {
    for (const jobKind of ['AUDIT', 'DISCOVERY'] as const) {
      expect(errorsOf(start(jobKind, { readChecks: [readCheck(1)] })), jobKind).toContain('/readChecks is allowed only for READ_CHECK');
    }
  });

  it('rejects a secret-like parameter name without writing the name or the value in the errors', () => {
    for (const name of ['token', 'authenticity_token', 'code', 'state', 'api_key', 'Session-Id']) {
      const errors = errorsOf(start(WORKER_READ_CHECK_JOB_KIND, {
        readChecks: [readCheck(1, { definition: { targetIdentityDigest: DIGEST, parameters: { q: 'x', [name]: SECRET_VALUE }, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] } })],
      }));
      expect(errors, name).toEqual(['/readChecks/0/definition/parameters (parameter 1) looks like a secret and is never sent']);
      expect(errors.join(' ').includes(SECRET_VALUE)).toBe(false);
    }
  });

  it('rejects a wrong definition id, a duplicate id, a wrong target page and a wrong definition shape', () => {
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [readCheck(1, { readCheckId: 'Read_1' })] })).length).toBeGreaterThan(0);
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [readCheck(1), readCheck(1)] }))).toContain('/readChecks/1/readCheckId must be unique');
    for (const targetPage of [{ origin: `${ORIGIN}/`, path: '/admin' }, { origin: 'ftp://127.0.0.1', path: '/admin' }, { origin: ORIGIN, path: 'admin' }]) {
      expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [readCheck(1, { targetPage })] })).length, JSON.stringify(targetPage)).toBeGreaterThan(0);
    }
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [readCheck(1, { readCheckRevision: 0 })] })).length).toBeGreaterThan(0);
    for (const definition of [
      { targetIdentityDigest: 'sha256:x', parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] },
      { targetIdentityDigest: DIGEST, parameters: {}, expectations: [] },
      { targetIdentityDigest: DIGEST, parameters: {}, expectations: [{ kind: 'ROW_COUNT_BETWEEN', count: 1 }] },
      { targetIdentityDigest: DIGEST, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }], csrf: 'x' },
    ]) {
      expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [readCheck(1, { definition })] })).length, JSON.stringify(definition)).toBeGreaterThan(0);
    }
  });

  // CCX-29（CC-087 の後半）: 規則の誤りの位置と文と順を固定する（位置を引数で渡す形に変えても、同じ誤りが出ること）。
  it('reports the rule errors of each definition at its position in the list, in the order of the definitions', () => {
    const errors = errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [
      readCheck(1, { targetPage: { origin: `${ORIGIN}/`, path: '/admin' } }),
      readCheck(1, { definition: { targetIdentityDigest: DIGEST, parameters: { q: 'x', token: SECRET_VALUE }, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] } }),
    ] }));
    expect(errors).toEqual([
      '/readChecks/0/targetPage must be the canonical origin of an http(s) page and an absolute path',
      '/readChecks/1/readCheckId must be unique',
      '/readChecks/1/definition/parameters (parameter 1) looks like a secret and is never sent',
    ]);
  });

  // L4（COV-7）: 定義の数と件数の要約に、READ の確かめの上限を置かない（件数の要約は安全な整数の範囲だけ）。
  it('has no count limit of the READ checks in the schema (L4)', () => {
    const schema = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'worker-message.schema.json'), 'utf8')) as {
      readonly $defs: {
        readonly start: { readonly properties: { readonly readChecks: { readonly maxItems?: number } } };
        readonly readCheckSummary: { readonly properties: { readonly checks: { readonly maximum: number }; readonly executed: { readonly maximum: number } } };
      };
    };
    expect(schema.$defs.start.properties.readChecks.maxItems).toBeUndefined();
    expect(schema.$defs.readCheckSummary.properties.checks.maximum).toBe(Number.MAX_SAFE_INTEGER);
    expect(schema.$defs.readCheckSummary.properties.executed.maximum).toBe(Number.MAX_SAFE_INTEGER);
  });

  // T37d（Task 37 の設計書 3.5）: 画面の path の定義は、送る値を持たず、対象の画面（親が開始の URL の Origin と、その path で入れる）が定義の path と同じ。
  it('accepts a page path definition whose target page is the page of the path, and rejects another or no target page', () => {
    const pageCheck = (overrides: Record<string, unknown> = {}): Record<string, unknown> => readCheck(1, {
      targetPage: { origin: ORIGIN, path: '/admin/members' },
      definition: { targetPagePath: '/admin/members', parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
      ...overrides,
    });
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [pageCheck(), readCheck(2)] }))).toEqual([]);
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [pageCheck({ targetPage: null })] })))
      .toContain('/readChecks/0/targetPage must be the page of the page path of the definition');
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [pageCheck({ targetPage: { origin: ORIGIN, path: '/admin' } })] })))
      .toContain('/readChecks/0/targetPage must be the page of the page path of the definition');
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [pageCheck({
      definition: { targetPagePath: '/admin/members', parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
    })] })).length).toBeGreaterThan(0);
  });
});

describe('T27e: FINISHED of a READ check job', () => {
  const outcome = { kind: 'RAN', exitCode: 0, runId: 'RUN-20261011000000', runDirectory: 'RUN-20261011000000', runStatus: 'COMPLETE' };
  const finished = (extra: Record<string, unknown>): Record<string, unknown> => ({ protocol: WORKER_PROTOCOL_VERSION, type: 'FINISHED', outcome, ...extra });
  const finishedErrors = (value: unknown): readonly string[] => {
    const checked = validateWorkerToParentMessage(value);
    return checked.ok ? [] : checked.errors;
  };

  it('accepts the counts only for a Run that ran, not with the discovery counts, and not more executed than checks', () => {
    const search = { searchChecks: 3, searchCheckErrors: 1 };
    expect(finishedErrors(finished({ readCheck: { checks: 2, executed: 1, ...search } }))).toEqual([]);
    expect(finishedErrors(finished({ readCheck: { checks: 2, executed: 3, ...search } }))).toEqual(['/readCheck/executed must not be more than /readCheck/checks']);
    // RCA-5: 誤りの組の数は、組の数を超えない。
    expect(finishedErrors(finished({ readCheck: { checks: 0, executed: 0, searchChecks: 1, searchCheckErrors: 2 } })))
      .toEqual(['/readCheck/searchCheckErrors must not be more than /readCheck/searchChecks']);
    expect(finishedErrors(finished({ readCheck: { checks: 1, executed: 1, ...search }, discovery: { pagesRead: 1, pagesNotRead: 0, candidates: 0 } })).length)
      .toBeGreaterThan(0);
    expect(finishedErrors({
      protocol: WORKER_PROTOCOL_VERSION,
      type: 'FINISHED',
      outcome: { kind: 'RUN_ACTIVE', exitCode: 4, runId: null, runDirectory: null, runStatus: null },
      readCheck: { checks: 1, executed: 0, ...search },
    }).length).toBeGreaterThan(0);
    expect(finishedErrors(finished({ readCheck: { checks: 1, executed: 1, ...search, results: ['MATCHED'] } })).length).toBeGreaterThan(0);
    // L4: 前の上限 20 を超える数も受ける。
    expect(finishedErrors(finished({ readCheck: { checks: 21, executed: 0, ...search } }))).toEqual([]);
  });
});

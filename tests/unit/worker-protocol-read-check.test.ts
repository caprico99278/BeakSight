// T27e（Task 27 の設計書 4.5、4.6）: IPC の契約（`src/control/worker-protocol.ts`）の、READ の確かめのジョブ（`READ_CHECK`）の部分。
// - `START`: `READ_CHECK` は、認証の指定と、定義の一覧（1〜`MAX_WORKER_READ_CHECKS` 件）を必ず持つ。ほかの種類は定義の一覧を持たない。定義の ID の
//   形と重複、対象の画面の Origin と path、定義の中身（`read-check-definition` のスキーマを参照）を確かめる。秘密に見える名前の送る値は拒む
//   （誤りの文に名前と値を書かない）。
// - `FINISHED`: 件数の要約（`readCheck`）は、Run を実行した結果だけ、発見の件数の要約と同時には持たない、確かめた数は定義の数以下。
// - スキーマの上限は、名前つきの定数と一致する。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_SETUP_SCHEMA_VERSION_2, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
  MAX_WORKER_READ_CHECKS,
  WORKER_PROTOCOL_VERSION,
  WORKER_READ_CHECK_JOB_KIND,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
  type WorkerJobKind,
} from '../../src/control/worker-protocol.js';
import { MAX_READ_CHECKS_PER_JOB } from '../../src/discovery/read-check-contracts.js';

const ORIGIN = 'http://127.0.0.1:4173';
const DIGEST = `sha256:${'b'.repeat(64)}`;
const SECRET_VALUE = 'secret-value-example';

const SETUP: AuthSetup = Object.freeze({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
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
  it('accepts READ_CHECK with the authentication and 1 to MAX_WORKER_READ_CHECKS definitions, a null target page included', () => {
    expect(MAX_WORKER_READ_CHECKS).toBe(MAX_READ_CHECKS_PER_JOB);
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [readCheck(1)] }))).toEqual([]);
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [readCheck(1, { targetPage: null })] }))).toEqual([]);
    const most = Array.from({ length: MAX_WORKER_READ_CHECKS }, (_, index) => readCheck(index));
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: most }))).toEqual([]);
  });

  it('rejects READ_CHECK without definitions, with no or too many definitions, and without the authentication', () => {
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND))).toContain('/readChecks is required for READ_CHECK');
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [] })).length).toBeGreaterThan(0);
    const tooMany = Array.from({ length: MAX_WORKER_READ_CHECKS + 1 }, (_, index) => readCheck(index));
    expect(errorsOf(start(WORKER_READ_CHECK_JOB_KIND, { readChecks: tooMany })).length).toBeGreaterThan(0);
    const { authentication: _authentication, ...unauthenticated } = start(WORKER_READ_CHECK_JOB_KIND, { readChecks: [readCheck(1)] });
    expect(errorsOf(unauthenticated)).toContain('/authentication is required for READ_CHECK');
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

  it('keeps the schema limits equal to the named constants', () => {
    const schema = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'worker-message.schema.json'), 'utf8')) as {
      readonly $defs: {
        readonly start: { readonly properties: { readonly readChecks: { readonly maxItems: number } } };
        readonly readCheckSummary: { readonly properties: { readonly checks: { readonly maximum: number }; readonly executed: { readonly maximum: number } } };
      };
    };
    expect(schema.$defs.start.properties.readChecks.maxItems).toBe(MAX_WORKER_READ_CHECKS);
    expect(schema.$defs.readCheckSummary.properties.checks.maximum).toBe(MAX_WORKER_READ_CHECKS);
    expect(schema.$defs.readCheckSummary.properties.executed.maximum).toBe(MAX_WORKER_READ_CHECKS);
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
    expect(finishedErrors(finished({ readCheck: { checks: 2, executed: 1 } }))).toEqual([]);
    expect(finishedErrors(finished({ readCheck: { checks: 2, executed: 3 } }))).toEqual(['/readCheck/executed must not be more than /readCheck/checks']);
    expect(finishedErrors(finished({ readCheck: { checks: 1, executed: 1 }, discovery: { pagesRead: 1, pagesNotRead: 0, candidates: 0 } })).length).toBeGreaterThan(0);
    expect(finishedErrors({
      protocol: WORKER_PROTOCOL_VERSION,
      type: 'FINISHED',
      outcome: { kind: 'RUN_ACTIVE', exitCode: 4, runId: null, runDirectory: null, runStatus: null },
      readCheck: { checks: 1, executed: 0 },
    }).length).toBeGreaterThan(0);
    expect(finishedErrors(finished({ readCheck: { checks: 1, executed: 1, results: ['MATCHED'] } })).length).toBeGreaterThan(0);
    expect(finishedErrors(finished({ readCheck: { checks: MAX_WORKER_READ_CHECKS + 1, executed: 0 } })).length).toBeGreaterThan(0);
  });
});

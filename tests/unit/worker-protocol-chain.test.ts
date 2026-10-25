// FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の IPC の契約（`src/control/worker-protocol.ts`、
// `schemas/control/worker-message.schema.json`）。
// - `START` は 1 回のまま。`chain` に段の並び（閉じた一覧の並びだけ: 監査 → 発見 → READ、発見 → READ）を持てる。最初の段の種類は `jobKind`。認証つきだけ。
// - 親 → 子の `NEXT_STAGE`（次の段のジョブの ID と種類。READ の確かめなら定義の一覧を必ず持つ）と `CHAIN_END`（次の段を始めない）。
// - `FINISHED` は、未完了の理由のコード（`incompleteReasonCodes`。コードだけ。重なりなし）を持てる。
// 例の値は、匿名の値（`127.0.0.1`、`example`）だけを使う。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INCOMPLETE_REASON_CODES } from '../../src/core/contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
  WORKER_CHAIN_STAGE_SEQUENCES,
  WORKER_PROTOCOL_VERSION,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
} from '../../src/control/worker-protocol.js';

const ORIGIN = 'http://127.0.0.1:4173';
const SHA256 = targetConfigDigestOf(new TextEncoder().encode('{}'));
const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-chain',
  profileRevision: 1,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

const READ_CHECKS = Object.freeze([{
  readCheckId: 'read-1',
  readCheckRevision: 3,
  targetPage: { origin: ORIGIN, path: '/admin/search' },
  definition: { targetIdentityDigest: `sha256:${'c'.repeat(64)}`, parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
}]);

const start = (jobKind: string, chain: unknown, withAuthentication = true): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-1',
  jobKind,
  targetConfigPath: 'config/targets/example.json',
  startNew: false,
  targetConfigSha256: SHA256,
  ...(withAuthentication
    ? {
      authentication: {
        setup: SETUP,
        approvedTestOrigins: [ORIGIN],
        authenticationSha256: workerAuthenticationDigestOf(SETUP, [ORIGIN], { jobKind: jobKind as 'AUDIT', automatedLogin: null }),
      },
    }
    : {}),
  ...(chain === undefined ? {} : { chain }),
});

const errorsOf = (result: ReturnType<typeof validateParentToWorkerMessage>): readonly string[] => (result.ok ? [] : result.errors);

describe('FM2d: the IPC contract of the chained run', () => {
  it('accepts the START with the closed list of the stage sequences only', () => {
    expect(WORKER_CHAIN_STAGE_SEQUENCES).toEqual([['AUDIT', 'DISCOVERY', 'READ_CHECK'], ['DISCOVERY', 'READ_CHECK']]);
    expect(validateParentToWorkerMessage(start('AUDIT', { stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'] })).ok).toBe(true);
    expect(validateParentToWorkerMessage(start('DISCOVERY', { stages: ['DISCOVERY', 'READ_CHECK'] })).ok).toBe(true);
    // 並びの一覧にない並び。
    expect(errorsOf(validateParentToWorkerMessage(start('AUDIT', { stages: ['AUDIT', 'READ_CHECK'] }))))
      .toEqual(['/chain/stages must be one of the stage sequences of the chained run']);
    // 最初の段の種類が、ジョブの種類と違う。
    expect(errorsOf(validateParentToWorkerMessage(start('DISCOVERY', { stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'] }))))
      .toEqual(['/chain/stages must start with the job kind']);
    // 認証の指定のない連鎖は受けない。
    expect(errorsOf(validateParentToWorkerMessage(start('AUDIT', { stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'] }, false))))
      .toContain('/authentication is required for the chained run');
    // 形の違う段の名前は、スキーマが拒む。
    expect(validateParentToWorkerMessage(start('AUDIT', { stages: ['AUDIT', 'WRITE_CREATE'] })).ok).toBe(false);
    // 連鎖のない START は今のまま。
    expect(validateParentToWorkerMessage(start('AUDIT', undefined)).ok).toBe(true);
  });

  it('accepts NEXT_STAGE with the job id and the kind, and the definitions only for the READ check', () => {
    const next = (jobKind: string, readChecks?: unknown): Record<string, unknown> => ({
      protocol: WORKER_PROTOCOL_VERSION, type: 'NEXT_STAGE', jobId: 'job-2', jobKind, ...(readChecks === undefined ? {} : { readChecks }),
    });
    expect(validateParentToWorkerMessage(next('DISCOVERY')).ok).toBe(true);
    expect(validateParentToWorkerMessage(next('READ_CHECK', READ_CHECKS)).ok).toBe(true);
    expect(errorsOf(validateParentToWorkerMessage(next('READ_CHECK')))).toEqual(['/readChecks is required for READ_CHECK']);
    expect(errorsOf(validateParentToWorkerMessage(next('DISCOVERY', READ_CHECKS)))).toEqual(['/readChecks is allowed only for READ_CHECK']);
    // 監査は次の段にならない（スキーマが拒む）。
    expect(validateParentToWorkerMessage(next('AUDIT')).ok).toBe(false);
    expect(validateParentToWorkerMessage({ ...next('DISCOVERY'), jobId: 'Job_2' }).ok).toBe(false);
    expect(validateParentToWorkerMessage({ protocol: WORKER_PROTOCOL_VERSION, type: 'CHAIN_END' }).ok).toBe(true);
    expect(validateParentToWorkerMessage({ protocol: WORKER_PROTOCOL_VERSION, type: 'CHAIN_END', reason: 'x' }).ok).toBe(false);
  });

  it('accepts FINISHED with the incomplete reason codes only (codes without the details, without repeats)', () => {
    const finished = (codes: unknown): Record<string, unknown> => ({
      protocol: WORKER_PROTOCOL_VERSION,
      type: 'FINISHED',
      outcome: { kind: 'RAN', exitCode: 2, runId: 'RUN-20261022010000', runDirectory: 'RUN-20261022010000', runStatus: 'PARTIAL' },
      incompleteReasonCodes: codes,
    });
    expect(validateWorkerToParentMessage(finished(['MAX_PAGES_REACHED', 'AUTH_SESSION_LOST'])).ok).toBe(true);
    expect(validateWorkerToParentMessage(finished([])).ok).toBe(true);
    expect(validateWorkerToParentMessage(finished(['MAX_PAGES_REACHED', 'MAX_PAGES_REACHED'])).ok).toBe(false);
    expect(validateWorkerToParentMessage(finished([{ code: 'MAX_PAGES_REACHED', detail: 'x' }])).ok).toBe(false);
    expect(validateWorkerToParentMessage(finished(['NOT_A_CODE'])).ok).toBe(false);
  });

  // FM2R の Minor 5: スキーマの `incompleteReasonCodes` の上限の数は、理由のコードの一覧の数と同じ（重なりなしなので、すべてのコードを載せられる）。
  it('binds the maxItems of incompleteReasonCodes in the schema to the number of the incomplete reason codes', () => {
    const schema = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'worker-message.schema.json'), 'utf8')) as {
      readonly $defs: { readonly finished: { readonly properties: { readonly incompleteReasonCodes: { readonly maxItems: number } } } };
    };
    expect(schema.$defs.finished.properties.incompleteReasonCodes.maxItems).toBe(INCOMPLETE_REASON_CODES.length);
  });
});

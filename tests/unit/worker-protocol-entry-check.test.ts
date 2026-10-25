// T43c（Task 43 の設計書 4.3）: 入口の確かめのジョブ（`ENTRY_CHECK`）の IPC の契約（`src/control/worker-protocol.ts`、
// `schemas/control/worker-message.schema.json`）。
// - `ENTRY_CHECK` は、ジョブの種類の一覧の後ろに足す（公開済みの値の順は変えない）。
// - `START` は、認証の指定を持たない（ログインの状態を持たない読み取りだけの Context で読む。認証の設定のないプロファイルでも始められる）。
// - `FINISHED` は、`entry-check.json` の場所（Run のディレクトリ）と件数の要約（`entryCheck`。終わり方、ログインの画面に見えたか、案のセレクタの数）
//   だけを持てる。要約は、入口の確かめのジョブの Run を実行した結果（`RAN`）だけ。発見と READ の確かめの要約と一緒に持たない。URL・セレクタ・値を
//   持たない。
// 例の値は、匿名の値（`127.0.0.1`、`example`）だけを使う。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { ENTRY_CHECK_END_REASONS } from '../../src/control/entry-check.js';
import {
  WORKER_ENTRY_CHECK_JOB_KIND,
  WORKER_JOB_KINDS,
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
  profileId: 'example-entry',
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

const start = (withAuthentication: boolean): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-1',
  jobKind: 'ENTRY_CHECK',
  targetConfigPath: 'config/targets/example.json',
  startNew: true,
  targetConfigSha256: SHA256,
  ...(withAuthentication
    ? {
      authentication: {
        setup: SETUP,
        approvedTestOrigins: [ORIGIN],
        authenticationSha256: workerAuthenticationDigestOf(SETUP, [ORIGIN], { jobKind: 'ENTRY_CHECK', automatedLogin: null }),
      },
    }
    : {}),
});

const ran = { kind: 'RAN', exitCode: 0, runId: 'RUN-20261017010000', runDirectory: 'RUN-20261017010000', runStatus: 'COMPLETE' };
const summary = { endReason: 'READ', loginPage: true, proposedSelectors: 3 };

const finished = (outcome: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'FINISHED',
  outcome,
  ...extra,
});

describe('T43c: the IPC contract of the entry check job', () => {
  it('adds ENTRY_CHECK after the published job kinds', () => {
    expect(WORKER_JOB_KINDS).toEqual(['AUDIT', 'LOGIN_CHECK', 'DISCOVERY', 'READ_CHECK', 'WRITE_CREATE', 'WRITE_UPDATE', 'ENTRY_CHECK']);
    expect(WORKER_ENTRY_CHECK_JOB_KIND).toBe('ENTRY_CHECK');
  });

  it('accepts the START of ENTRY_CHECK only without the authentication (no login state)', () => {
    expect(validateParentToWorkerMessage(start(false)).ok).toBe(true);
    const rejected = validateParentToWorkerMessage(start(true));
    expect(rejected.ok).toBe(false);
    expect(rejected.ok ? [] : rejected.errors).toEqual(['/authentication is not allowed for ENTRY_CHECK']);
  });

  it('accepts FINISHED with the summary of entry-check.json for a Run that ran, and without it', () => {
    const accepted = validateWorkerToParentMessage(finished(ran, { entryCheck: summary }));
    expect(accepted.ok).toBe(true);
    expect(accepted.ok && accepted.message.type === 'FINISHED' ? accepted.message.entryCheck : null).toEqual(summary);
    expect(validateWorkerToParentMessage(finished(ran, { entryCheck: { endReason: 'NAVIGATION_FAILED', loginPage: null, proposedSelectors: 0 } })).ok)
      .toBe(true);
    expect(validateWorkerToParentMessage(finished(ran)).ok).toBe(true);
  });

  it('rejects the summary of a Run that did not run, with another summary, with other items, and of another shape', () => {
    const notRan = { kind: 'RUN_ACTIVE', exitCode: 4, runId: null, runDirectory: null, runStatus: null };
    for (const [name, message] of [
      ['a summary of a Run that did not run', finished(notRan, { entryCheck: summary })],
      ['with the discovery summary', finished(ran, { entryCheck: summary, discovery: { pagesRead: 1, pagesNotRead: 0, candidates: 0 } })],
      ['with the READ check summary', finished(ran, { entryCheck: summary, readCheck: { checks: 1, executed: 1 } })],
      ['a summary with a selector', finished(ran, { entryCheck: { ...summary, selector: '#email' } })],
      ['a summary with a URL', finished(ran, { entryCheck: { ...summary, url: `${ORIGIN}/login` } })],
      ['an unknown end reason', finished(ran, { entryCheck: { ...summary, endReason: 'OTHER' } })],
      ['too many selectors', finished(ran, { entryCheck: { ...summary, proposedSelectors: 4 } })],
      ['a negative count', finished(ran, { entryCheck: { ...summary, proposedSelectors: -1 } })],
    ] as const) {
      expect(validateWorkerToParentMessage(message).ok, name).toBe(false);
    }
  });

  it('keeps the job kinds, the end reasons and the summary shape in the schema', () => {
    const schema = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'worker-message.schema.json'), 'utf8')) as {
      $defs: {
        start: { properties: { jobKind: { enum: string[] } } };
        entryCheckSummary: { required: string[]; additionalProperties: boolean; properties: { endReason: { enum: string[] } } };
      };
    };
    expect(schema.$defs.start.properties.jobKind.enum).toEqual([...WORKER_JOB_KINDS]);
    expect(schema.$defs.entryCheckSummary.required).toEqual(['endReason', 'loginPage', 'proposedSelectors']);
    expect(schema.$defs.entryCheckSummary.additionalProperties).toBe(false);
    expect(schema.$defs.entryCheckSummary.properties.endReason.enum).toEqual([...ENTRY_CHECK_END_REASONS]);
  });
});

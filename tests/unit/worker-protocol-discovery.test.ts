// T27d（Task 27 の設計書 4.6 と、変更履歴の「T27b・T27c の報告と T27d の前の判断」の (3)）: 発見のジョブ（`DISCOVERY`）の IPC の契約
// （`src/control/worker-protocol.ts`、`schemas/control/worker-message.schema.json`）。
// - `DISCOVERY` の `START` は、認証つき（`authentication`）だけ（認証の設定のない発見は受けない。fail-closed）。
// - `FINISHED` は、候補を載せず、`discovery.json` の場所（Run のディレクトリ）と件数の要約（`discovery`。読んだ画面、読まなかった画面、候補の
//   件数）だけを持てる。要約は、Run を実行した結果（`RAN`）だけ。要約に、件数のほかの項目は持てない。
// 例の値は、匿名の値（`127.0.0.1`、`example`）だけを使う。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
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
  profileId: 'example-discovery',
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

const start = (withAuthentication: boolean): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-1',
  jobKind: 'DISCOVERY',
  targetConfigPath: 'config/targets/example.json',
  startNew: true,
  targetConfigSha256: SHA256,
  ...(withAuthentication
    ? {
      authentication: {
        setup: SETUP,
        approvedTestOrigins: [ORIGIN],
        authenticationSha256: workerAuthenticationDigestOf(SETUP, [ORIGIN], { jobKind: 'DISCOVERY', automatedLogin: null }),
      },
    }
    : {}),
});

const ran = {
  kind: 'RAN',
  exitCode: 0,
  runId: 'RUN-20261011010000',
  runDirectory: 'RUN-20261011010000',
  runStatus: 'COMPLETE',
};

const finished = (outcome: Record<string, unknown>, discovery?: unknown): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'FINISHED',
  outcome,
  ...(discovery === undefined ? {} : { discovery }),
});

describe('T27d: the IPC contract of the discovery job', () => {
  it('accepts the START of DISCOVERY only with the authentication (no discovery without the auth setup)', () => {
    expect(validateParentToWorkerMessage(start(true)).ok).toBe(true);
    const rejected = validateParentToWorkerMessage(start(false));
    expect(rejected.ok).toBe(false);
    expect(rejected.ok ? [] : rejected.errors).toEqual(['/authentication is required for DISCOVERY']);
  });

  it('accepts FINISHED with the count summary of discovery.json for a Run that ran, and without it for other jobs', () => {
    const accepted = validateWorkerToParentMessage(finished(ran, { pagesRead: 3, pagesNotRead: 2, candidates: 7 }));
    expect(accepted.ok).toBe(true);
    expect(accepted.ok && accepted.message.type === 'FINISHED' ? accepted.message.discovery : null).toEqual({ pagesRead: 3, pagesNotRead: 2, candidates: 7 });
    expect(validateWorkerToParentMessage(finished(ran)).ok).toBe(true);
  });

  it('rejects the summary of a Run that did not run, a summary with other items, and counts of another shape', () => {
    const summary = { pagesRead: 0, pagesNotRead: 0, candidates: 0 };
    const notRan = { kind: 'RUN_ACTIVE', exitCode: 4, runId: null, runDirectory: null, runStatus: null };
    for (const [name, message] of [
      ['a summary of a Run that did not run', finished(notRan, summary)],
      ['a summary with the candidates', finished(ran, { ...summary, items: [] })],
      ['a summary with a URL', finished(ran, { ...summary, url: `${ORIGIN}/admin` })],
      ['a negative count', finished(ran, { ...summary, pagesRead: -1 })],
      ['a count that is not an integer', finished(ran, { ...summary, candidates: 1.5 })],
      ['a summary without a count', finished(ran, { pagesRead: 1, pagesNotRead: 0 })],
    ] as const) {
      expect(validateWorkerToParentMessage(message).ok, name).toBe(false);
    }
  });

  it('keeps the summary in the schema as counts only', () => {
    const schema = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'worker-message.schema.json'), 'utf8')) as {
      $defs: { discoverySummary: { required: string[]; additionalProperties: boolean } };
    };
    expect(schema.$defs.discoverySummary.required).toEqual(['pagesRead', 'pagesNotRead', 'candidates']);
    expect(schema.$defs.discoverySummary.additionalProperties).toBe(false);
  });
});

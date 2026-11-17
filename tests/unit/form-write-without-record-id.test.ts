// PL-5 の 9 の (4)（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 8.1 の「自動で決める項目」の表の「登録の ID の取り方」の行）:
// ID が取れないフォームの書き込みの手順（下書きの決められない理由 `RECORD_ID_NOT_FOUND`。ID の取り方は null）でも、答え合わせ（照合の READ）があれば
// 実行の許可を出し、結果は ID なしの `PARTIAL`。
// - 未指定の項目の判定（`missingVerificationItemsOf`）: フォームの形では ID の取り方を必須から外す。結果の判定のしかたの印と答え合わせは必須のまま
//   （期待は緩めない）。API の形の判定は今のまま。
// - 開始の口（`writeStartSpecOf`）: ID の取り方が null のフォームの登録でも、書き込みの指定を作る（ID の取り方は null）。作った指定は IPC の契約を通る。
// - 結果: 送った後の URL から ID を取らない（型がない）ので、照合が一致しても ID なしの `PARTIAL`（`RECORD_ID_NOT_FOUND`）。
import { describe, expect, it } from 'vitest';
import { UNSPECIFIED_VERIFICATION, type ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import { missingVerificationItemsOf } from '../../src/control/approval/scenario-policy.js';
import { actionOutcomeOf, formResultJudgementOf } from '../../src/control/actions/action-outcome.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import type { SeedRecord } from '../../src/control/data-rules/scenario-data.js';
import type { ReadCheckView } from '../../src/control/job/read-check-store.js';
import { writeStartSpecOf } from '../../src/control/job/write-job-start.js';
import {
  WORKER_PROTOCOL_VERSION,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  workerAuthenticationDigestOf,
} from '../../src/control/worker-protocol.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { CREATE_CANDIDATE, FULL_VERIFICATION, PROFILE_ID, sampleScenario } from './approval-samples.js';
import { SAMPLE_ORIGIN } from './discovery-candidate-samples.js';

/** ID の取り方を決められなかったフォームの検証の指定（答え合わせと判定のしかたの印はある）。 */
const WITHOUT_RECORD_ID = Object.freeze({ ...FULL_VERIFICATION, recordId: null });

describe('PL-5 9 (4): the missing items of a form scenario without a way to take the record id', () => {
  it('does not require the record id of a form scenario when the READ verification is there', () => {
    expect(missingVerificationItemsOf(WITHOUT_RECORD_ID, { transport: 'FORM' })).toEqual([]);
    // 送り方の項目のない文書もフォームとして判定する（同じ結果）。
    expect(missingVerificationItemsOf(WITHOUT_RECORD_ID)).toEqual([]);
  });

  it('keeps requiring the READ verification and the result judgement of a form scenario (the expectations are not loosened)', () => {
    expect(missingVerificationItemsOf({ ...WITHOUT_RECORD_ID, readVerification: null }, { transport: 'FORM' })).toEqual(['readVerification']);
    expect(missingVerificationItemsOf({ ...WITHOUT_RECORD_ID, resultJudgement: null }, { transport: 'FORM' })).toEqual(['resultJudgement']);
    expect(missingVerificationItemsOf(UNSPECIFIED_VERIFICATION, { transport: 'FORM' })).toEqual(['resultJudgement', 'readVerification']);
  });

  it('keeps requiring a way to take the record id of an API registration', () => {
    expect(missingVerificationItemsOf({ ...WITHOUT_RECORD_ID, resultJudgement: null }, { transport: 'API' })).toEqual(['recordId']);
  });
});

const GRANT_ID = 'grant-form-1';
const SCENARIO: ScenarioRevision = sampleScenario({ verification: WITHOUT_RECORD_ID });
const READ_CHECK: ReadCheckView = {
  readCheckId: 'rc-1', profileId: PROFILE_ID, revision: 2, createdAt: '20261027000000', updatedAt: '20261027000000', canceledAt: null,
  definition: { targetIdentityDigest: `sha256:${'a'.repeat(64)}`, parameters: { q: '' }, expectations: [] },
};
const VALUES = Object.freeze({ name: 'サンプル 太郎', email: 'sample0001@example.invalid' });
const SEED_RECORD = {
  seed: 'd'.repeat(64),
  seedInput: { profileId: PROFILE_ID, scenarioId: SCENARIO.scenarioId, scenarioRevision: SCENARIO.revision,
    ruleSetDigest: `sha256:${'c'.repeat(64)}`, executionGrantId: GRANT_ID },
  baseDate: '2026-10-27',
  attempt: 0,
} as SeedRecord;
const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision: 1,
  loginStartUrl: `${SAMPLE_ORIGIN}/login`,
  loginPostEndpoints: [{ origin: SAMPLE_ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/members', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [],
  auditPathPrefixes: ['/members'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

const startOf = (write: unknown): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-form-1',
  jobKind: 'WRITE_CREATE',
  targetConfigPath: 'local/targets/example-form.json',
  startNew: true,
  targetConfigSha256: targetConfigDigestOf(new TextEncoder().encode('{}')),
  authentication: {
    setup: SETUP,
    approvedTestOrigins: [SAMPLE_ORIGIN],
    approvedServiceOrigins: [],
    authenticationSha256: workerAuthenticationDigestOf(SETUP, [SAMPLE_ORIGIN], { jobKind: 'WRITE_CREATE', automatedLogin: null, approvedServiceOrigins: [] }),
  },
  write,
});

const inputsOf = (scenario: ScenarioRevision) => ({
  scenario,
  evidence: CREATE_CANDIDATE,
  grantId: GRANT_ID,
  profileId: PROFILE_ID,
  seedRecord: SEED_RECORD,
  values: VALUES,
  readCheck: READ_CHECK,
  targetPage: { origin: SAMPLE_ORIGIN, path: '/members' },
  approvalFacts: sampleApprovalFacts({ kind: 'CREATE', profileId: PROFILE_ID, scenarioId: scenario.scenarioId, scenarioRevision: scenario.revision, grantId: GRANT_ID }),
});

describe('PL-5 9 (4): the start of a form registration without a way to take the record id', () => {
  it('makes the form write specification of the sample with a way to take the record id (the control case of the sample)', () => {
    const spec = writeStartSpecOf(inputsOf(sampleScenario()));
    expect(spec?.verification).toEqual({ resultJudgement: 'FORM_STRUCTURE', recordId: FULL_VERIFICATION.recordId });
    expect(validateParentToWorkerMessage(startOf(spec))).toMatchObject({ ok: true });
  });

  it('makes the form write specification with no way to take the record id, and the IPC contract accepts it', () => {
    const spec = writeStartSpecOf({
      scenario: SCENARIO,
      evidence: CREATE_CANDIDATE,
      grantId: GRANT_ID,
      profileId: PROFILE_ID,
      seedRecord: SEED_RECORD,
      values: VALUES,
      readCheck: READ_CHECK,
      targetPage: { origin: SAMPLE_ORIGIN, path: '/members' },
      approvalFacts: sampleApprovalFacts({ kind: 'CREATE', profileId: PROFILE_ID, scenarioId: SCENARIO.scenarioId, scenarioRevision: SCENARIO.revision, grantId: GRANT_ID }),
    });
    expect(spec).not.toBeNull();
    expect(spec?.verification).toEqual({ resultJudgement: 'FORM_STRUCTURE', recordId: null });
    expect(validateParentToWorkerMessage(startOf(spec))).toMatchObject({ ok: true });
  });

  it('ends a matched registration without a record id as PARTIAL (RECORD_ID_NOT_FOUND), not VERIFIED', () => {
    const judgement = formResultJudgementOf({ httpStatus: 303, sameForm: false, sameFormKeptValues: false, recordId: null, readVerification: 'MATCHED' });
    expect(judgement).toEqual({ responseJudgement: 'SUCCESS', recordId: null });
    expect(actionOutcomeOf({ submission: 'SENT', ...judgement, readVerification: 'MATCHED' })).toMatchObject({ result: 'PARTIAL', reason: 'RECORD_ID_NOT_FOUND' });
  });
});

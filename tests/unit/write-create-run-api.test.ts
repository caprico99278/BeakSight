// T40b-1（Task 40 の設計書 3.3、7 章の履歴の「T40a の報告（API の検証の指定）」）: ワーカーの API の書き込みの流れ（`src/worker/write-create-run.ts`）の
// 純粋な部品。
// - 応答の判定の表（`apiResponseFactsOf`）: 応答を受けていなければ判定なし。状態が 100〜599 の外なら、応答が分からないとして状態も判定も null（T40c の
//   発見事項 3 への判断）。範囲の中なら、状態はそのまま、判定は `apiResponseJudgementOf`（2xx `SUCCESS`、429 `RATE_LIMITED`、ほかの 4xx `INPUT_ERROR`、
//   5xx `SERVER_ERROR`、ほか `NO_CONDITION_MATCHED`）。
// - ID の取り方の選び方（`apiRecordIdSourceOf`）: API の `recordId`（応答の本文の鍵）があればそれ、なければ検証の指定の `recordId`（保存の後の画面）。
// - 文書の組み立て（`writeRunDocumentsOf`）: API の Run は版 1.1 の API の形（送り方 `API`、成否の条件 null、API の要約は `actionApiSummaryOf` で 1 回、
//   送った値は鍵ごとの生成した値、送信先の path は API の path）。照合まで進まなかった（送らなかった）回は、ページが決める鍵の値を null にする。
//   照合の READ は行わない（T40b-2 まで）ので、実行しなかった印。スキーマと手書きの確かめ、親の照らし合わせに合う。
import { describe, expect, it } from 'vitest';
import {
  actionApiSummaryOf,
  actionRunMatchesWriteStart,
  actionRunRuleErrors,
} from '../../src/control/actions/action-api-summary.js';
import type { ActionGuardSummary } from '../../src/control/actions/action-contracts.js';
import { actionOutcomeOf, apiResponseJudgementOf } from '../../src/control/actions/action-outcome.js';
import type { WorkerStartApiWrite } from '../../src/control/worker-protocol.js';
import type { RunId } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { WriteStageMonitor } from '../../src/safety/passive-request-guard.js';
import { apiRecordIdSourceOf, apiResponseFactsOf, writeRunDocumentsOf, type WriteFacts } from '../../src/worker/write-create-run.js';
import { sampleStartApiWrite } from './worker-write-samples.js';

const ORIGIN = 'http://127.0.0.1:4173';
const RUN_ID = 'RUN-20261017000001' as RunId;
const STARTED_AT = new Date('2026-10-17T01:02:03Z');
const SUBMITTED_AT = new Date('2026-10-17T01:02:13Z');
const FINISHED_AT = new Date('2026-10-17T01:02:23Z');
const API_WRITE = sampleStartApiWrite(ORIGIN) as unknown as WorkerStartApiWrite;
const PAGE_KEY_VALUES = Object.freeze({ tenant_id: 'tenant-1' });

/** 書き込みの段の記録の写しから、報告の Guard の要約を作る（流れの `guardSummaryOf` と同じ項目）。 */
const guardSummary = (): ActionGuardSummary => {
  const snapshot = new WriteStageMonitor().snapshot();
  return {
    blockedByReason: snapshot.blockedByReason,
    blockedByOtherRulesInWindow: snapshot.blockedByOtherRulesInWindow,
    submissionWindowOpen: snapshot.submissionWindowOpen,
    blockedByPayloadReason: snapshot.blockedByPayloadReason,
    documentCharsetRead: snapshot.documentCharsetRead,
    responseDeliveryCanceled: snapshot.responseDeliveryCanceled,
  };
};

describe('T40b-1: the response judgement of the API write (apiResponseFactsOf)', () => {
  it('has no judgement without a response', () => {
    expect(apiResponseFactsOf({ responseReceived: false, responseStatus: null })).toEqual({ httpStatus: null, responseJudgement: null });
    expect(apiResponseFactsOf({ responseReceived: false, responseStatus: 201 })).toEqual({ httpStatus: null, responseJudgement: null });
    expect(apiResponseFactsOf({ responseReceived: true, responseStatus: null })).toEqual({ httpStatus: null, responseJudgement: null });
  });

  it.each([
    [100, 'NO_CONDITION_MATCHED'],
    [199, 'NO_CONDITION_MATCHED'],
    [200, 'SUCCESS'],
    [201, 'SUCCESS'],
    [204, 'SUCCESS'],
    [299, 'SUCCESS'],
    [300, 'NO_CONDITION_MATCHED'],
    [307, 'NO_CONDITION_MATCHED'],
    [399, 'NO_CONDITION_MATCHED'],
    [400, 'INPUT_ERROR'],
    [401, 'INPUT_ERROR'],
    [428, 'INPUT_ERROR'],
    [429, 'RATE_LIMITED'],
    [430, 'INPUT_ERROR'],
    [499, 'INPUT_ERROR'],
    [500, 'SERVER_ERROR'],
    [503, 'SERVER_ERROR'],
    [599, 'SERVER_ERROR'],
  ] as const)('keeps the status %i and judges it as %s (the same as apiResponseJudgementOf)', (status, judgement) => {
    expect(apiResponseFactsOf({ responseReceived: true, responseStatus: status })).toEqual({ httpStatus: status, responseJudgement: judgement });
    expect(apiResponseJudgementOf(status)).toBe(judgement);
  });

  it.each([99, 600, 999, 1_000, -1, 1.5, Number.NaN])('treats the status %d outside 100 to 599 as an unknown response (no status, no judgement)', (status) => {
    expect(apiResponseFactsOf({ responseReceived: true, responseStatus: status })).toEqual({ httpStatus: null, responseJudgement: null });
  });
});

describe('T40b-1: the way to take the record id (apiRecordIdSourceOf)', () => {
  it('uses the key of the response body when the API specification has one', () => {
    expect(apiRecordIdSourceOf(API_WRITE)).toEqual({ kind: 'RESPONSE_BODY', key: 'id' });
  });

  it('uses the page after the save (the verification) when the API specification has no record id', () => {
    const write = { ...API_WRITE, api: { ...API_WRITE.api, recordId: null } };
    expect(apiRecordIdSourceOf(write)).toEqual({ kind: 'PAGE', spec: API_WRITE.verification.recordId });
  });

  it('has no way when neither is given (the contract rejects it; fail-closed)', () => {
    const write = { ...API_WRITE, api: { ...API_WRITE.api, recordId: null }, verification: { ...API_WRITE.verification, recordId: null } };
    expect(apiRecordIdSourceOf(write)).toBeNull();
  });
});

describe('T40b-1: the documents of an API write run (writeRunDocumentsOf)', () => {
  const sentFacts: WriteFacts = {
    submission: 'SENT',
    blockReason: null,
    httpStatus: 201,
    responseJudgement: 'SUCCESS',
    rawRecordId: '7',
    readEvidence: null,
    submittedAt: SUBMITTED_AT,
    violation: false,
    candidateDigestMatched: true,
    judgedAt: FINISHED_AT,
    guard: guardSummary(),
    apiPageKeyValues: PAGE_KEY_VALUES,
  };

  it('writes the API form of 1.1 once from the same facts: API summary, no result conditions, the generated values, the API path', async () => {
    const outcome = actionOutcomeOf({ submission: 'SENT', responseJudgement: 'SUCCESS', recordId: '7', readVerification: null });
    expect(outcome).toEqual({ result: 'PARTIAL', reason: 'READ_VERIFICATION_UNDETERMINED' });
    const documents = writeRunDocumentsOf({
      jobId: 'job-api', write: API_WRITE, runId: RUN_ID, startedAt: STARTED_AT, finishedAt: FINISHED_AT, facts: sentFacts, outcome,
    });
    const summary = actionApiSummaryOf(API_WRITE.api, PAGE_KEY_VALUES);
    expect(documents.actionRun).toMatchObject({
      transport: 'API',
      api: summary,
      resultConditions: null,
      submittedValues: API_WRITE.values,
      submission: 'SENT',
      httpStatus: 201,
      responseJudgement: 'SUCCESS',
      recordId: '7',
      readVerification: null,
      reservationState: 'COMMITTED',
      result: 'PARTIAL',
      reason: 'READ_VERIFICATION_UNDETERMINED',
    });
    expect(documents.actionRun).not.toHaveProperty('update');
    expect(documents.evidence).toMatchObject({
      transport: 'API',
      api: summary,
      submission: { state: 'SENT', submittedValues: API_WRITE.values, actionPath: API_WRITE.api.request.pathShape },
      response: { httpStatus: 201, judgement: 'SUCCESS' },
      update: null,
      readVerification: { readCheckId: API_WRITE.readVerification.readCheckId, state: 'NOT_EXECUTED' },
      containsHumanEnteredValues: false,
    });
    expect(summary.pageKeyValues).toEqual({ tenant_id: '"tenant-1"' });
    expect(await validateArtifact('action-run', documents.actionRun)).toEqual({ ok: true });
    expect(await validateArtifact('action-evidence', documents.evidence)).toEqual({ ok: true });
    expect(await validateArtifact('approval-summary', documents.approvalSummary)).toEqual({ ok: true });
    expect(actionRunRuleErrors(documents.actionRun)).toEqual([]);
    expect(actionRunMatchesWriteStart(documents.actionRun, API_WRITE.api)).toBe(true);
    expect(actionRunMatchesWriteStart(documents.actionRun, null)).toBe(false);
  });

  it('keeps no page key values for a run that was not sent (the Guard did not reach the check, or the sender did not write)', async () => {
    const facts: WriteFacts = {
      ...sentFacts, submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', httpStatus: null, responseJudgement: null, rawRecordId: null, submittedAt: null,
      judgedAt: null,
    };
    const outcome = actionOutcomeOf({ submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH' });
    const documents = writeRunDocumentsOf({ jobId: 'job-api', write: API_WRITE, runId: RUN_ID, startedAt: STARTED_AT, finishedAt: FINISHED_AT, facts, outcome });
    expect(documents.actionRun.api?.pageKeyValues).toBeNull();
    expect(documents.evidence.api?.pageKeyValues).toBeNull();
    expect(documents.evidence.submission).toEqual({ state: 'NOT_SENT', submittedValues: {}, actionPath: null, submittedAt: null });
    expect(documents.actionRun).toMatchObject({ result: 'BLOCKED', reason: 'PAYLOAD_MISMATCH', reservationState: 'RELEASED', resultConditions: null });
    expect(await validateArtifact('action-run', documents.actionRun)).toEqual({ ok: true });
    expect(await validateArtifact('action-evidence', documents.evidence)).toEqual({ ok: true });
    expect(actionRunRuleErrors(documents.actionRun)).toEqual([]);
    expect(actionRunMatchesWriteStart(documents.actionRun, API_WRITE.api)).toBe(true);
  });

  it('writes no status for an unknown response (sent, the status outside the range): the result is UNKNOWN', async () => {
    const response = apiResponseFactsOf({ responseReceived: true, responseStatus: 600 });
    const facts: WriteFacts = { ...sentFacts, ...response, rawRecordId: null, judgedAt: null };
    const outcome = actionOutcomeOf({ submission: 'SENT', responseJudgement: response.responseJudgement, recordId: null, readVerification: null });
    const documents = writeRunDocumentsOf({ jobId: 'job-api', write: API_WRITE, runId: RUN_ID, startedAt: STARTED_AT, finishedAt: FINISHED_AT, facts, outcome });
    expect(documents.actionRun).toMatchObject({ httpStatus: null, responseJudgement: null, result: 'UNKNOWN', reason: 'NO_RESPONSE', reservationState: 'UNKNOWN' });
    expect(await validateArtifact('action-run', documents.actionRun)).toEqual({ ok: true });
    expect(await validateArtifact('action-evidence', documents.evidence)).toEqual({ ok: true });
  });
});

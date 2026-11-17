// RB-11（再構築の設計書 2 章 1・3、INV-REBUILD の plan 2 章の 10・11）: 書き込みの流れ（`executeWriteCreateRun` の `performWrite`）を、偽の段の口
// （`writePorts`）で、ブラウザなしに確かめる。画面の確かめ・書き込みの段（入れる・窓・押す・結果の観察）・READ の中身は口の向こうにあり、ここでは口の答えを
// 前提として信じる（決まり 3）。段の中の判定（窓・結果・入れ直し）は `write-stage-steps.test.ts` の純粋な判定が確かめる。
// - 送る前: 画面の確かめが合わない・送る前の答え合わせの READ で値がもう見える・書き込みの段を開けない・Run の前の確認の失敗は、送らずに止める。
// - 送った後: Guard の送信の報告で送ったかを決め、照合の中身の不一致は `PAYLOAD_MISMATCH`。form は送った後の画面の観察と照合の READ で、API は応答の判定と
//   `{id}` の画面の READ で結果を決める。照合の READ はジョブの最後の読み込み（見せたまま待たない）。
// - 送信の報告は 1 回だけ。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import type { WorkerStartApiWrite, WorkerStartReadCheck, WorkerStartWrite } from '../../src/control/worker-protocol.js';
import type { WorkerWriteSubmissionReport } from '../../src/worker/write-ipc.js';
import { ACTION_EVIDENCE_ARTIFACT_FILE_NAME, ACTION_RUN_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { readCheckEvidenceTargetOf, type ReadCheckExecutedEvidence } from '../../src/discovery/read-check-evaluation.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { WriteStageMonitor, type WriteSubmissionReport } from '../../src/safety/passive-request-guard.js';
import type { ReadCheckPageVisitOptions } from '../../src/worker/read-check-run.js';
import {
  executeWriteCreateRun,
  type WritePorts,
  type WriteSession,
  type WriteStageRun,
} from '../../src/worker/write-create-run.js';
import { createTestConfig } from '../helpers/test-config.js';
import type { UpdateFormValues } from '../../src/browser/write-form-submitter.js';
import { sampleStartApiWrite, sampleStartUpdateWrite, sampleStartWrite, sampleWriteField } from './worker-write-samples.js';

const ORIGIN = 'http://127.0.0.1:4175';

const authentication: RunAuthentication = Object.freeze({
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: [ORIGIN],
  auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix: '/login',
  filterState: filterAuthenticatedState,
});
/** 照らす値（hidden・readonly）のない登録の form（送る前の画面の確かめは、照らす値を読まない）。 */
const FORM_WRITE = sampleStartWrite(ORIGIN, {
  candidateFields: [sampleWriteField('name'), sampleWriteField('email', 'email'), sampleWriteField('newsletter', 'checkbox')],
}) as unknown as WorkerStartWrite;
const API_WRITE = sampleStartApiWrite(ORIGIN, {}, ORIGIN) as unknown as WorkerStartApiWrite;
/** 更新の form（名前とメールを変え、お知らせの選択を保つ）。 */
const UPDATE_WRITE = sampleStartUpdateWrite(ORIGIN, {
  candidateFields: [sampleWriteField('name'), sampleWriteField('email', 'email'), sampleWriteField('newsletter', 'checkbox')],
}) as unknown as WorkerStartWrite;
const updateValuesOf = (name: string, email: string): UpdateFormValues =>
  ({ fields: { name, email, newsletter: null }, stateHiddenValues: {}, pairOffValues: {}, passthroughValues: {} });
const PRIOR_VALUES = updateValuesOf('サンプル 一郎', 'sample0001@example.invalid');
const UPDATED_VALUES = updateValuesOf('サンプル 次郎', 'sample0002@example.invalid');

/** 照らして決まった READ の結果（構造と期待の結果つき。スキーマに合う形）。 */
const evaluatedOf = (readCheck: WorkerStartReadCheck, result: 'MATCHED' | 'NOT_MATCHED', url: string): ReadCheckExecutedEvidence => ({
  readCheckId: readCheck.readCheckId, readCheckRevision: readCheck.readCheckRevision, ...readCheckEvidenceTargetOf(readCheck.definition),
  state: 'EXECUTED', result, detail: 'EXPECTATIONS_EVALUATED', url, httpStatus: 200, blockedRequests: 0,
  structure: { region: 'MAIN', tables: 0, tableRowCounts: [], lists: 0, listItemCounts: [], detailFields: 0, textLength: 10, limitReached: false, settled: true },
  expectations: readCheck.definition.expectations.map((expectation) => (expectation.kind === 'TEXT_CONTAINS'
    ? { expectation, result, undeterminedReason: null, found: result === 'MATCHED' }
    : { expectation, result, undeterminedReason: null, rowSource: 'TABLE', observedRowCount: result === 'MATCHED' ? 1 : 0 })) as ReadCheckExecutedEvidence['expectations'],
});
const checkedOf = (evidence: ReadCheckExecutedEvidence) => ({ evidence, sessionLostUrl: null, sessionLostDetail: null, violation: false });

/** 書き込みの段の Guard の要約（何も止めていない）。 */
const GUARD = (() => {
  const snapshot = new WriteStageMonitor().snapshot();
  return {
    blockedByReason: snapshot.blockedByReason, blockedByOtherRulesInWindow: snapshot.blockedByOtherRulesInWindow, submissionWindowOpen: true,
    blockedByPayloadReason: snapshot.blockedByPayloadReason, documentCharsetRead: true, responseDeliveryCanceled: false,
  };
})();
const sentReport = (status: number): WriteSubmissionReport =>
  ({ submission: 'SENT', responseReceived: true, responseStatus: status, sendAttempts: 1, sendOutcome: 'RESPONDED' });
const NOT_SENT_REPORT: WriteSubmissionReport = { submission: 'NOT_SENT', responseReceived: false, responseStatus: null, sendAttempts: 0, sendOutcome: null };
const SUBMITTED_AT = new Date('2026-11-15T01:00:00Z');

/** 送った書き込みの段（`stage` の判定の項目を足す）。 */
const ranStage = (report: WriteSubmissionReport, stage: Partial<Extract<WriteStageRun, { readonly kind: 'RAN' }>['stage']>, facts: Partial<Extract<WriteStageRun, { readonly kind: 'RAN' }>> = {}): WriteStageRun => ({
  kind: 'RAN',
  stage: {
    clicked: true, precheckFailed: false, httpStatus: null, responseJudgement: null, rawRecordId: null, submittedAt: SUBMITTED_AT, judgedAt: SUBMITTED_AT,
    sessionLostUrl: null, ...stage,
  },
  report, guard: GUARD, payloadBlocked: false, violation: false, apiPageKeyValues: null, ...facts,
});

/** 偽の口に頼んだこと。 */
interface PortCall {
  readonly kind: 'FORM_PAGE' | 'UPDATE_PAGE' | 'API_PAGE' | 'CANDIDATES' | 'READ' | 'RECORD' | 'STAGE';
  readonly lastLoad: boolean;
}

interface FakeAnswers {
  readonly formMatched?: boolean;
  /** 更新の画面の欄の値（前の読み取り、更新の後の照合の順）。 */
  readonly updates?: readonly UpdateFormValues[];
  /** 候補の READ の結果（呼んだ順）。 */
  readonly reads?: readonly ('MATCHED' | 'NOT_MATCHED')[];
  readonly record?: 'MATCHED' | 'NOT_MATCHED';
  readonly stage?: WriteStageRun;
  readonly opened?: boolean;
  /** API の画面の確かめで送信の要素が見つからない（候補が合わない）。 */
  readonly apiSubmitterMissing?: boolean;
  /** 書き込みの段が押した時刻（段の外の入れ物に知らせる）。 */
  readonly pressedAt?: Date;
}

const fakePorts = (answers: FakeAnswers): { readonly ports: WritePorts; readonly calls: PortCall[] } => {
  const calls: PortCall[] = [];
  let reads = 0;
  let updates = 0;
  const lastLoad = (options: ReadCheckPageVisitOptions): boolean => options.pacingWaitBeforeClose === false;
  const unexpected = (): never => {
    throw new Error('the fake write port was not asked for this');
  };
  const pageCheck = <T>(value: T | null) => ({
    value, violation: false, sessionLostUrl: null, candidateMatched: value !== null,
    candidateMismatch: value === null ? { reason: 'IDENTITY_NOT_FOUND' as const, pageCandidateCount: 0, sameIdentityCount: 0, fieldPosition: null } : null,
  });
  const session: WriteSession = {
    readListPageLinks: unexpected,
    readTargetCandidates: async (_url, options) => {
      calls.push({ kind: 'CANDIDATES', lastLoad: lastLoad(options) });
      return {
        kind: 'VISITED', value: { candidates: { candidates: [], reliable: true }, siteUnavailable: false },
        blockedRequests: 0, violation: false, auditStageObservation: null, pageLoad: { limitReached: false },
      };
    },
    visitAndRead: async (readCheck, _confirmation, options) => {
      calls.push({ kind: 'READ', lastLoad: lastLoad(options) });
      const result = answers.reads?.[reads] ?? 'NOT_MATCHED';
      reads += 1;
      return checkedOf(evaluatedOf(readCheck, result, `${ORIGIN}/members?q=x`));
    },
    visitAndReadPage: unexpected,
    visitAndReadRecordPage: async (readCheck, recordId, options) => {
      calls.push({ kind: 'RECORD', lastLoad: lastLoad(options) });
      return checkedOf(evaluatedOf(readCheck, answers.record ?? 'MATCHED', `${ORIGIN}/admin/members/${recordId}/edit`));
    },
    checkFormPage: async () => {
      calls.push({ kind: 'FORM_PAGE', lastLoad: false });
      return pageCheck(answers.formMatched === false ? null : { passthrough: {}, shapeKey: 'shape-1' });
    },
    checkUpdateFormPage: async () => {
      calls.push({ kind: 'UPDATE_PAGE', lastLoad: false });
      const values = answers.updates?.[updates] ?? null;
      updates += 1;
      return pageCheck(values === null ? null : { values, shapeKey: 'shape-1' });
    },
    checkApiFormPage: async () => {
      calls.push({ kind: 'API_PAGE', lastLoad: false });
      return answers.apiSubmitterMissing === true
        ? { ...pageCheck<true>(null), candidateMismatch: { reason: 'SUBMITTER_NOT_FOUND', pageCandidateCount: null, sameIdentityCount: null, fieldPosition: null } }
        : pageCheck(true as const);
    },
    checkApiUpdatePage: unexpected,
    runWriteStage: async ({ onEntered, onPressed }) => {
      calls.push({ kind: 'STAGE', lastLoad: false });
      const stage = answers.stage ?? { kind: 'NOT_OPENED' };
      if (stage.kind === 'RAN') {
        onEntered();
        if (answers.pressedAt !== undefined) onPressed(answers.pressedAt);
      }
      return stage;
    },
    carry: { latestAuthenticatedState: () => null },
    close: async () => undefined,
  };
  return { ports: { open: async () => (answers.opened === false ? null : session) }, calls };
};

describe('RB-11: the write flow on a fake stage port', () => {
  let directory = '';
  let runs = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'beaksight-write-run-loop-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const run = async (write: WorkerStartWrite | WorkerStartApiWrite, ports: WritePorts): Promise<{
    readonly document: ActionRunDocument;
    readonly reports: readonly WorkerWriteSubmissionReport[];
    /** 書き込みの報告の証拠（`action-evidence.json`）。 */
    readonly evidence: Readonly<Record<string, unknown>>;
  }> => {
    runs += 1;
    const config = createTestConfig(ORIGIN, '/members', {
      crawl: { minNavigationIntervalMs: 1_000 }, audit: { screenshots: false }, output: { directory: join(directory, `run-${String(runs)}`) },
    });
    const reports: WorkerWriteSubmissionReport[] = [];
    const outcome = await executeWriteCreateRun({
      config, jobId: 'job-write-loop', authentication, write,
      launchBrowser: () => Promise.reject(new Error('the fake stage port starts no browser')),
      clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
      recheck: async () => ({ allowed: true }), reportSubmission: (report) => reports.push(report), writePorts: ports,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the write run did not run: ${outcome.kind}`);
    }
    const text = readFileSync(artifactFilePath(outcome.runDirectory, ACTION_RUN_ARTIFACT_FILE_NAME), 'utf8');
    const document = JSON.parse(text) as ActionRunDocument;
    const validation = await validateArtifact('action-run', document);
    expect(validation.ok ? [] : validation.errors).toEqual([]);
    expect(reports).toEqual([{ submission: document.submission, blockReason: document.blockReason }]);
    const evidence = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, ACTION_EVIDENCE_ARTIFACT_FILE_NAME), 'utf8')) as Record<string, unknown>;
    return { document, reports, evidence };
  };

  it('sends a form once after the answer check, judges the page after the send with the READ, and closes the READ at once (CREATE)', async () => {
    const fake = fakePorts({
      reads: ['NOT_MATCHED', 'MATCHED'],
      stage: ranStage(sentReport(200), { formFacts: { httpStatus: 200, sameForm: false, sameFormKeptValues: false, recordId: '7' } }),
    });
    const { document } = await run(FORM_WRITE, fake.ports);
    expect(document).toMatchObject({ submission: 'SENT', blockReason: null, result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED' });
    expect(fake.calls).toEqual([
      { kind: 'FORM_PAGE', lastLoad: false }, { kind: 'CANDIDATES', lastLoad: false }, { kind: 'READ', lastLoad: false },
      { kind: 'STAGE', lastLoad: false }, { kind: 'CANDIDATES', lastLoad: false }, { kind: 'READ', lastLoad: true },
    ]);
  });

  it('does not open the write stage when the answer check already sees the value', async () => {
    const fake = fakePorts({ reads: ['MATCHED'] });
    const { document } = await run(FORM_WRITE, fake.ports);
    expect(document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', result: 'BLOCKED' });
    expect(fake.calls.map(({ kind }) => kind)).toEqual(['FORM_PAGE', 'CANDIDATES', 'READ']);
  });

  it('does not read further when the candidate on the form page does not match', async () => {
    const fake = fakePorts({ formMatched: false });
    const { document } = await run(FORM_WRITE, fake.ports);
    expect(document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', result: 'BLOCKED' });
    expect(fake.calls.map(({ kind }) => kind)).toEqual(['FORM_PAGE']);
  });

  it('says PAYLOAD_MISMATCH when the Guard did not send because the payload differed, and does not verify', async () => {
    const fake = fakePorts({ reads: ['NOT_MATCHED'], stage: ranStage(NOT_SENT_REPORT, { clicked: true }, { payloadBlocked: true }) });
    const { document } = await run(FORM_WRITE, fake.ports);
    expect(document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', result: 'BLOCKED' });
    expect(fake.calls.map(({ kind }) => kind)).toEqual(['FORM_PAGE', 'CANDIDATES', 'READ', 'STAGE']);
  });

  it('stops without sending when the write stage cannot open', async () => {
    const fake = fakePorts({ reads: ['NOT_MATCHED'] });
    const { document } = await run(FORM_WRITE, fake.ports);
    expect(document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', result: 'BLOCKED' });
  });

  it('ends as a failed preflight when the stage port cannot open', async () => {
    const fake = fakePorts({ opened: false });
    const { document } = await run(FORM_WRITE, fake.ports);
    expect(document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED' });
    expect(fake.calls).toEqual([]);
  });

  it('checks the update page after the send and reads the READ only when the fields were updated (UPDATE)', async () => {
    const stage = ranStage(sentReport(200), { formFacts: { httpStatus: 200, sameForm: false, sameFormKeptValues: false, recordId: null } });
    const updated = fakePorts({ updates: [PRIOR_VALUES, UPDATED_VALUES], reads: ['MATCHED'], stage });
    const { document } = await run(UPDATE_WRITE, updated.ports);
    expect(document).toMatchObject({ submission: 'SENT', result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED' });
    expect(updated.calls).toEqual([
      { kind: 'UPDATE_PAGE', lastLoad: false }, { kind: 'STAGE', lastLoad: false }, { kind: 'UPDATE_PAGE', lastLoad: false },
      { kind: 'CANDIDATES', lastLoad: false }, { kind: 'READ', lastLoad: true },
    ]);
    // 更新しないまま同じ form を送った値で返した: 入力の誤り（照合の READ は読まない）。
    const unchanged = fakePorts({
      updates: [PRIOR_VALUES, PRIOR_VALUES],
      stage: ranStage(sentReport(200), { formFacts: { httpStatus: 200, sameForm: true, sameFormKeptValues: true, recordId: null } }),
    });
    const failed = await run(UPDATE_WRITE, unchanged.ports);
    expect(failed.document).toMatchObject({ submission: 'SENT', responseJudgement: 'INPUT_ERROR', result: 'FAILED', reason: 'INPUT_ERROR' });
    expect(unchanged.calls.map(({ kind }) => kind)).toEqual(['UPDATE_PAGE', 'STAGE', 'UPDATE_PAGE']);
  });

  it('verifies an API create by the record page READ after a successful response, as the last load (CREATE)', async () => {
    const fake = fakePorts({ stage: ranStage(sentReport(201), { httpStatus: 201, responseJudgement: 'SUCCESS', rawRecordId: '7' }) });
    const { document } = await run(API_WRITE, fake.ports);
    expect(document).toMatchObject({ submission: 'SENT', result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED' });
    expect(fake.calls).toEqual([{ kind: 'API_PAGE', lastLoad: false }, { kind: 'STAGE', lastLoad: false }, { kind: 'RECORD', lastLoad: true }]);
  });

  it('does not verify an API write whose response was not a success', async () => {
    const fake = fakePorts({ stage: ranStage(sentReport(422), { httpStatus: 422, responseJudgement: 'INPUT_ERROR' }) });
    const { document } = await run(API_WRITE, fake.ports);
    expect(document).toMatchObject({ submission: 'SENT', httpStatus: 422 });
    expect(fake.calls.map(({ kind }) => kind)).toEqual(['API_PAGE', 'STAGE']);
  });

  it('records the result without a judgement when the Guard sent but no response came', async () => {
    const report: WriteSubmissionReport = { submission: 'SENT', responseReceived: false, responseStatus: null, sendAttempts: 1, sendOutcome: 'NO_RESPONSE' };
    const fake = fakePorts({ stage: ranStage(report, {}) });
    const { document } = await run(API_WRITE, fake.ports);
    expect(document).toMatchObject({ submission: 'SENT', httpStatus: null, result: 'UNKNOWN' });
    expect(fake.calls.map(({ kind }) => kind)).toEqual(['API_PAGE', 'STAGE']);
  });

  // 段の輪の反応: 書き込みの段が「応答をページに返せなかった」と決めた（form はページの JS が遅い応答の間に移った（M-b）、API は画面から ID を取る形でページが
  // 要求を取り消した）。どちらも判定せず照合しない。段が観察に出す順は `write-stage-steps` の `formResultStepOf`、取り消しの観察は guard-write-stage が確かめる。
  it.each<[string, WorkerStartWrite | WorkerStartApiWrite, number]>([
    ['a form whose page moved while the response was slow (M-b)', FORM_WRITE, 303],
    ['an API write whose page canceled its request', API_WRITE, 201],
  ])('writes UNKNOWN without the READ when the response did not reach the page: %s', async (_name, write, status) => {
    const fake = fakePorts({
      reads: ['NOT_MATCHED'],
      stage: ranStage(sentReport(status), { httpStatus: status, responseJudgement: 'RESPONSE_NOT_DELIVERED' }),
    });
    const { document } = await run(write, fake.ports);
    expect(document).toMatchObject({
      submission: 'SENT', httpStatus: status, responseJudgement: 'RESPONSE_NOT_DELIVERED', recordId: null, readVerification: null,
      result: 'UNKNOWN', reason: 'RESPONSE_NOT_DELIVERED',
    });
    // 書き込みの段の後に、照合の READ を読まない。
    expect(fake.calls.at(-1)).toEqual({ kind: 'STAGE', lastLoad: false });
  });

  // REV-RB8911 M-3（DEF-280）: 押した後に段の本体が例外で終わった（段の結果は送る前の止めの形のまま、Guard の報告は SENT）ときも、押した時刻を記録に残す。
  it('keeps the press time when the write stage ended by an exception after the press', async () => {
    const pressedAt = new Date('2026-11-15T02:03:04Z');
    const fake = fakePorts({
      pressedAt,
      stage: ranStage(sentReport(303), { clicked: false, precheckFailed: true, submittedAt: null, judgedAt: null }),
    });
    const { document } = await run(API_WRITE, fake.ports);
    expect(document).toMatchObject({ submission: 'SENT', httpStatus: 303 });
    expect(document.submittedAt).not.toBeNull();
  });

  it('records where the API candidate did not match, without opening the write stage (OP-L L1)', async () => {
    const fake = fakePorts({ apiSubmitterMissing: true });
    const { document, evidence } = await run(API_WRITE, fake.ports);
    expect(document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', result: 'BLOCKED', reservationState: 'RELEASED' });
    expect(evidence).toMatchObject({
      precheck: { candidateDigestMatched: false, blockReason: 'PRECHECK_FAILED', candidateMismatch: { reason: 'SUBMITTER_NOT_FOUND', fieldPosition: null } },
      guard: null,
    });
    expect(fake.calls.map(({ kind }) => kind)).toEqual(['API_PAGE']);
  });

  it.each([
    ['the values were emptied by a rebuild before the press (OP-P)', 'SUBMIT', 'EMPTIED'],
    ['the values did not stay after the refill (OP-O O1)', 'FILL', 'EMPTIED'],
  ] as const)('records the stage, the reason and the field facts without values when %s', async (_name, stage, valueChange) => {
    const inputFailure = { stage, reason: 'VALUE_CHANGED', fieldPosition: 0, fieldType: 'email', fieldAttributes: [], valueChange } as const;
    const fake = fakePorts({
      stage: ranStage(NOT_SENT_REPORT, { clicked: false, precheckFailed: true, submittedAt: null, judgedAt: null, precheckDetail: 'FORM_NOT_READY', inputFailure }),
    });
    const { document, evidence } = await run(API_WRITE, fake.ports);
    expect(document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'FORM_NOT_READY', result: 'BLOCKED' });
    expect((evidence['precheck'] as Record<string, unknown>)['inputFailure']).toEqual(inputFailure);
    // 入れた値（名前とメール）を証拠に残さない（短い数の値は、時刻などの数字と区別できないので見ない）。
    for (const value of [API_WRITE.values['name'], API_WRITE.values['email']]) {
      expect(JSON.stringify(evidence)).not.toContain(value);
    }
  });
});

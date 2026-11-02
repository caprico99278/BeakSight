/**
 * PL-2（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・5、4 章の 2、13 章の 11・13）: 作業の画面の要点を決める 1 か所
 * （`server/audit-job-functions.ts` の `jobSummaryOf`）と、点検が終わるまでの上限の見積もり（`auditRemainingUpperBoundMs`）を、作業の状態ごとに確かめる。
 * - 主のボタンは 1 つまでで、押す先がないときは出さない。
 * - 成功のときだけ、次の画面へ移す先を返す（入口の確かめ → サイト、点検 → サイト、まとめて実行 → 次のステップの作業かサイト、書き込み → 続けて始めた
 *   更新の作業か書き込みの手順）。失敗・中断・安全の違反・ログインの切れ・書き込みの結果が分からない（UNKNOWN）・自動の登録を待つ間は返さない。
 *   OP-U: 移す先は、ページが出す送信の扱い（既定は削除のほかを通す）によらない。
 * - 自動の登録が済んだ後は、ログインの段の行の登録を「済み」にする（済んだ操作を出さない）。
 * 値は匿名（ループバック）。画面のサーバとブラウザは起動しない。
 */
import { describe, expect, it } from 'vitest';
import {
  auditRemainingUpperBoundMs,
  jobSummaryOf,
  type AuditJobDetailView,
} from '../src/server/audit-job-functions';

type Facts = Omit<AuditJobDetailView, 'summary'>;

/** 終わった公開の点検の作業（何も足さない形）。 */
const BASE: Facts = Object.freeze({
  jobId: 'job-pl2-summary',
  jobKind: 'AUDIT',
  profileId: 'pl2-site',
  profileRevision: 1,
  state: 'FINISHED',
  startNew: true,
  runId: 'RUN-20261026000000',
  runStatus: 'COMPLETE',
  endKind: 'RAN',
  exitCode: 0,
  failureReason: null,
  createdAt: '2026-10-26T00:00:00Z',
  startedAt: '2026-10-26T00:00:01Z',
  finishedAt: '2026-10-26T00:01:00Z',
  stopRequestedAt: null,
  lastProgress: null,
  lastNotice: null,
  active: false,
  forceStopAvailable: false,
  forceStopOfferAfterMs: 1,
  artifacts: [],
  lastAuthState: null,
  sessionLostUrl: null,
  sessionLoss: null,
  autoLogin: null,
  write: null,
  writeChain: null,
  stageChain: null,
  stageChainWriteKind: null,
  inspectionWrite: null,
  loginSetup: null,
  jobBrowserShown: false,
  loginStage: null,
  auditStage: null,
  safetyViolation: null,
  externalSchemeProbes: null,
  pressLimitProbes: null,
  pageIncompleteReasons: null,
  auditSend: null,
  currentProfile: { mode: 'PUBLIC_PASSIVE', auth: 'NONE' },
  automatedLoginContext: true,
  entryCheck: null,
  entryCheckAuthSetup: null,
  runEnd: null,
  profileJobEnd: null,
  writePrecheckDetail: null,
  reportSummary: null,
  loginEndDetection: null,
  entryCheckFollowUp: null,
} satisfies Facts);

const REPORT = Object.freeze({ kind: 'REPORT', relativePath: 'report.html', href: '/artifacts/job-pl2-summary/report.html' } as const);

const summaryOf = (overrides: Partial<Facts>, awaitingRegistration = false) =>
  jobSummaryOf({ ...BASE, ...overrides }, { estimateLimits: null, awaitingRegistration });

/** 書き込みの結果（結果だけを変える）。 */
const writeOf = (result: NonNullable<Facts['write']>['result'], reportHref: string | null = '/artifacts/job-pl2-summary/action-report.html') => ({
  jobId: BASE.jobId,
  writeKind: 'CREATE',
  update: null,
  scenarioId: 'scenario-pl2',
  scenarioRevision: 1,
  result,
  reason: null,
  submission: null,
  blockReason: null,
  httpStatus: null,
  responseJudgement: null,
  recordId: null,
  readVerification: null,
  reservationState: null,
  recordedAt: BASE.createdAt,
  submittedAt: null,
  settledAt: null,
  submittedValues: [],
  report: { check: null, reportHref, bundleHref: null },
  transport: 'FORM',
  api: null,
}) satisfies NonNullable<Facts['write']>;

/** まとめて実行の連鎖（点検 → 操作さがし → 見るだけの確かめ）。 */
const chainOf = (state: 'RUNNING' | 'FINISHED' | 'STOPPED', stages: readonly (readonly [string, string | null])[]): NonNullable<Facts['stageChain']> => ({
  chainId: BASE.jobId,
  profileId: BASE.profileId,
  profileRevision: 1,
  state,
  stopReason: state === 'STOPPED' ? 'STAGE_FAILED' : null,
  stages: (['AUDIT', 'DISCOVERY', 'READ_CHECK'] as const).map((kind, index) => ({
    kind,
    state: (stages[index]?.[0] ?? 'PENDING') as NonNullable<Facts['stageChain']>['stages'][number]['state'],
    jobId: stages[index]?.[1] ?? null,
  })),
  // OP-2: 書き込みの段は行っていない。
  writeStageJobIds: [],
});

/** ログインの段のまとめ（登録できる token の送信の行が 1 つ）。 */
const LOGIN_STAGE: NonNullable<Facts['loginStage']> = Object.freeze({
  scriptLogin: null,
  blockedRequests: {
    requests: [{
      origin: 'https://service.example.invalid', path: '/auth/v1/token', resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
      query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] },
    }],
    unlisted: 0,
  },
}) as NonNullable<Facts['loginStage']>;

describe('PL-2: the result line and the primary button of the job screen', () => {
  it.each([
    ['running', { active: true, state: 'RUNNING', runStatus: null, finishedAt: null }, 'RUNNING', null],
    ['starting', { active: true, state: 'STARTING', runStatus: null, finishedAt: null }, 'STARTING', null],
    ['awaiting the manual login', { active: true, state: 'RUNNING', runStatus: null, finishedAt: null, lastAuthState: 'AWAITING_LOGIN' }, 'AWAITING_LOGIN', 'CONFIRM_LOGIN'],
    ['stopping', { active: true, state: 'STOPPING', runStatus: null, finishedAt: null, lastAuthState: 'AWAITING_LOGIN' }, 'STOPPING', null],
    ['a complete audit with the report', { artifacts: [REPORT] }, 'AUDIT_COMPLETE', 'OPEN_REPORT'],
    ['a complete audit without the report', {}, 'AUDIT_COMPLETE', null],
    ['a partial audit', { runStatus: 'PARTIAL', artifacts: [REPORT] }, 'AUDIT_PARTIAL', 'OPEN_REPORT'],
    ['an audit stopped for safety', { runStatus: 'ABORTED_BY_SAFETY', artifacts: [REPORT] }, 'SAFETY_VIOLATION', 'OPEN_REPORT'],
    ['a failed job', { state: 'FAILED', runStatus: null, failureReason: 'WORKER_START_FAILED' }, 'FAILED', null],
    ['an interrupted job', { state: 'INTERRUPTED', runStatus: null, failureReason: 'SERVER_RESTARTED' }, 'INTERRUPTED', null],
    ['a session loss', { runStatus: 'PARTIAL', sessionLostUrl: 'http://127.0.0.1:9/admin/logout', lastAuthState: 'SESSION_LOST' }, 'SESSION_LOST', null],
    ['a verified write', { jobKind: 'WRITE_CREATE', runStatus: null, write: writeOf('VERIFIED') }, 'WRITE_VERIFIED', 'OPEN_WRITE_REPORT'],
    ['an unknown write', { jobKind: 'WRITE_CREATE', runStatus: null, write: writeOf('UNKNOWN', null) }, 'WRITE_UNKNOWN', null],
    // 書き込みの作業が中断で終わっても、書き込みの結果の記録（送ったかどうか分からない）を先に出す（7 章）。
    ['an unknown write of an interrupted job', {
      jobKind: 'WRITE_CREATE', runStatus: null, state: 'INTERRUPTED', failureReason: 'WORKER_EXITED', write: writeOf('UNKNOWN', null),
    }, 'WRITE_UNKNOWN', null],
    ['a failed write job without its record', { jobKind: 'WRITE_CREATE', runStatus: null, state: 'FAILED', failureReason: 'WORKER_START_FAILED' }, 'FAILED', null],
    ['a partial write', { jobKind: 'WRITE_CREATE', runStatus: null, write: writeOf('PARTIAL') }, 'WRITE_PARTIAL', 'OPEN_WRITE_REPORT'],
    ['a blocked write', { jobKind: 'WRITE_CREATE', runStatus: null, write: writeOf('BLOCKED', null) }, 'WRITE_NOT_SENT', null],
    ['a write without its record yet', { jobKind: 'WRITE_UPDATE', runStatus: null, write: null }, 'WRITE_PENDING', null],
    ['a finished discovery', { jobKind: 'DISCOVERY' }, 'DISCOVERY_FINISHED', 'OPEN_DISCOVERY'],
    ['a finished read check', { jobKind: 'READ_CHECK' }, 'READ_CHECK_FINISHED', 'OPEN_READ_CHECKS'],
    ['a successful login check', { jobKind: 'LOGIN_CHECK', runStatus: null, autoLogin: { result: 'SUCCEEDED', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null } }, 'LOGIN_CHECK_SUCCEEDED', null],
  ] as const)('%s', (_name, overrides, result, primary) => {
    const summary = summaryOf(overrides as Partial<Facts>);
    expect(summary.result).toBe(result);
    expect(summary.primary).toBe(primary);
  });

  it('decides the entry check by the end reason, the auth setup state and whether a login page was seen', () => {
    const entry = (endReason: string, loginPage: boolean, entryCheckAuthSetup: Facts['entryCheckAuthSetup']) => summaryOf({
      jobKind: 'ENTRY_CHECK',
      runStatus: null,
      entryCheck: { endReason, facts: { loginPage } } as unknown as Facts['entryCheck'],
      entryCheckAuthSetup,
    });
    expect(entry('READ', true, 'PRESENT')).toMatchObject({ result: 'ENTRY_CHECK_LOGIN_PAGE', primary: 'START_AUDIT', advance: { kind: 'SITE' } });
    expect(entry('READ', false, 'NOT_USED')).toMatchObject({ result: 'ENTRY_CHECK_READ', primary: 'START_AUDIT', advance: { kind: 'SITE' } });
    expect(entry('READ', true, 'PROPOSAL_INVALID')).toMatchObject({ result: 'ENTRY_CHECK_NEEDS_SETUP', primary: null, advance: null });
    expect(entry('LEFT_ALLOWED_ORIGINS', false, 'NOT_READ')).toMatchObject({ result: 'ENTRY_CHECK_NOT_READ', primary: null, advance: null });
    expect(summaryOf({ jobKind: 'ENTRY_CHECK', runStatus: null, entryCheck: null })).toMatchObject({ result: 'ENTRY_CHECK_NOT_READ', advance: null });
  });
});

// PL-R（設計書 14 章、13 章の 13。PL-2 の持ち越し）: 点検が最後まで終わったときだけ、報告を作る時に書いた小さなまとめ（`report-summary.json`）の問題の件数を、
// 結果の 1 行に出す。途中で終わった点検、まとめがない・読めない点検は、今の文のまま（件数を出さない）。
describe('PL-R: the number of problems in the result line of a finished audit', () => {
  const reportSummary = (problemCount: number) => ({ problemCount, notFullyCheckedPageCount: 0 });

  it('gives the number of problems of a complete audit whose small summary was read', () => {
    expect(summaryOf({ artifacts: [REPORT], reportSummary: reportSummary(2) })).toMatchObject({ result: 'AUDIT_COMPLETE', problemCount: 2 });
    expect(summaryOf({ artifacts: [REPORT], reportSummary: reportSummary(0) })).toMatchObject({ result: 'AUDIT_COMPLETE', problemCount: 0 });
  });

  it('gives no number when the audit ended part way, ended for safety, or has no readable small summary', () => {
    expect(summaryOf({ artifacts: [REPORT] }).problemCount).toBeNull();
    expect(summaryOf({ runStatus: 'PARTIAL', artifacts: [REPORT], reportSummary: reportSummary(2) }).problemCount).toBeNull();
    expect(summaryOf({ runStatus: 'ABORTED_BY_SAFETY', artifacts: [REPORT], reportSummary: reportSummary(2) }).problemCount).toBeNull();
    expect(summaryOf({ state: 'INTERRUPTED', runStatus: null, reportSummary: reportSummary(2) }).problemCount).toBeNull();
    expect(summaryOf({ jobKind: 'DISCOVERY', reportSummary: reportSummary(2) }).problemCount).toBeNull();
    expect(summaryOf({ active: true, state: 'RUNNING', runStatus: null, finishedAt: null, reportSummary: reportSummary(2) }).problemCount).toBeNull();
  });
});

describe('PL-2: the automatic move after a success (3 章の 5)', () => {
  it('moves a complete audit and a partial audit to the site, and nothing else of the audits', () => {
    expect(summaryOf({ artifacts: [REPORT] }).advance).toEqual({ kind: 'SITE' });
    // PL-U（設計書 14.1 の U1）: 一部のページを見られなかった点検（`AUDIT_PARTIAL`）も、完了と同じくサイトの画面へ移す。
    expect(summaryOf({ runStatus: 'PARTIAL', artifacts: [REPORT] })).toMatchObject({ result: 'AUDIT_PARTIAL', advance: { kind: 'SITE' } });
    // PL-U の修正の 1 回目（14.1 の判断）: 利用者が「止める」で止めた点検（Run の終わりの理由が `STOPPED_BY_SIGNAL`）は、作業の画面に残す。
    // OP-1 修正の 2 回目: 人が止めたかは、ジョブに残る「止める」の要求の記録（`stopRequestedAt`）で決める（止めた点検の行には、いつも要求の日時が残る）。
    const stoppedEnd = { lastExecutionEndReason: 'STOPPED_BY_SIGNAL', reasons: ['RUN_INTERRUPTED'], partialPageCount: 0, failedPageCount: 0, skippedPageCount: 1 } as const;
    const stopRequestedAt = '2026-10-26T00:00:30Z';
    expect(summaryOf({ runStatus: 'PARTIAL', artifacts: [REPORT], runEnd: stoppedEnd, stopRequestedAt } as Partial<Facts>))
      .toMatchObject({ result: 'AUDIT_PARTIAL', advance: null });
    expect(summaryOf({ runStatus: 'PARTIAL', artifacts: [REPORT], runEnd: { ...stoppedEnd, lastExecutionEndReason: 'COMPLETED' } } as Partial<Facts>).advance)
      .toEqual({ kind: 'SITE' });
    // OP-1 修正の 2 回目（14.1 の U1）: ログインを待つ間に止めた点検は、Run がまだなく、Run の終わりの記録がない（`runEnd` が `null`）。それでも、止める要求の
    // 記録があれば、作業の画面に残す（単独の点検・まとめて実行の段・続けて始めた下調べのどれでも）。
    expect(summaryOf({ runStatus: null, runId: null, runEnd: null, stopRequestedAt }).advance).toBeNull();
    expect(summaryOf({ runStatus: 'COMPLETE', artifacts: [REPORT], runEnd: null, stopRequestedAt }).advance).toBeNull();
    expect(summaryOf({ jobKind: 'ENTRY_CHECK', runEnd: null, stopRequestedAt, entryCheckFollowUp: { state: 'SKIPPED' } } as Partial<Facts>).advance).toBeNull();
    for (const overrides of [
      { active: true, state: 'RUNNING', runStatus: null, finishedAt: null },
      { runStatus: 'ABORTED_BY_SAFETY' },
      { state: 'FAILED', runStatus: null, failureReason: 'WORKER_START_FAILED' },
      { state: 'INTERRUPTED', runStatus: null, failureReason: 'SERVER_RESTARTED' },
      { runStatus: 'PARTIAL', sessionLostUrl: 'http://127.0.0.1:9/admin/logout' },
    ] as const) {
      expect(summaryOf(overrides as Partial<Facts>).advance, JSON.stringify(overrides)).toBeNull();
    }
  });

  // OP-U（設計者の判断の 1）: 移り先は送信の扱いによらない。既定の「削除のほかを通す」で通した点検も、読み取りだけと同じ所へ移す（前は移さなかった）。
  it('moves a finished audit and the stages of a finished chain to the same place whatever the send policy', () => {
    const passed = {
      policy: 'PASS_EXCEPT_DELETE', passedRequests: 2, passedOtherOriginRequests: 0, passedWebSockets: 0,
      passedWebSocketsOutsideGuard: 0, passedDangerousWebSockets: 0, webSocketCaution: false,
    } as const;
    const readOnly = { ...passed, policy: 'READ_ONLY', passedRequests: 0 } as const;
    // 発見と READ の確かめの記録は、通した数を持たない。
    const passedWithoutCount = { ...passed, passedRequests: null, passedOtherOriginRequests: null, passedWebSockets: null } as const;
    const finished = chainOf('FINISHED', [['DONE', BASE.jobId], ['DONE', 'job-pl2-discovery'], ['DONE', 'job-pl2-read']]);
    for (const overrides of [
      {},
      { runStatus: 'PARTIAL' },
      { stageChain: finished },
      { jobKind: 'DISCOVERY', runStatus: null, stageChain: finished },
      { jobKind: 'READ_CHECK', runStatus: null, stageChain: finished },
      { jobKind: 'ENTRY_CHECK', runStatus: null, entryCheckFollowUp: { state: 'SKIPPED' } },
    ] as const) {
      const expected = summaryOf({ ...overrides, auditSend: readOnly } as Partial<Facts>).advance;
      expect(expected, JSON.stringify(overrides)).not.toBeNull();
      expect(summaryOf({ ...overrides, auditSend: passed } as Partial<Facts>).advance, JSON.stringify(overrides)).toEqual(expected);
      expect(summaryOf({ ...overrides, auditSend: passedWithoutCount } as Partial<Facts>).advance, JSON.stringify(overrides)).toEqual(expected);
    }
    expect(summaryOf({ auditSend: passed }).advance).toEqual({ kind: 'SITE' });
  });

  it('does not move while the automatic registration from the manual login is awaited', () => {
    expect(summaryOf({}, true)).toMatchObject({ advance: null, awaitingRegistration: true });
  });

  it('moves a verified write to its scenario, or to the update job it started, and never an unknown or partial write', () => {
    expect(summaryOf({ jobKind: 'WRITE_CREATE', runStatus: null, write: writeOf('VERIFIED') }).advance).toEqual({ kind: 'SCENARIO', scenarioId: 'scenario-pl2' });
    const chain = { createJobId: BASE.jobId, createScenarioId: 'scenario-pl2', updateScenarioId: 'scenario-pl2-update', reason: null, nextStartAt: null };
    expect(summaryOf({ jobKind: 'WRITE_CREATE', runStatus: null, write: writeOf('VERIFIED'), writeChain: { ...chain, state: 'UPDATE_STARTED', updateJobId: 'job-pl2-update' } }).advance)
      .toEqual({ kind: 'JOB', jobId: 'job-pl2-update' });
    expect(summaryOf({ jobKind: 'WRITE_CREATE', runStatus: null, write: writeOf('VERIFIED'), writeChain: { ...chain, state: 'CREATING', updateJobId: null } }).advance)
      .toBeNull();
    for (const result of ['UNKNOWN', 'PARTIAL', 'BLOCKED', 'FAILED', null] as const) {
      expect(summaryOf({ jobKind: 'WRITE_CREATE', runStatus: null, write: writeOf(result) }).advance, String(result)).toBeNull();
    }
  });

  // OP-G2（OP-G の指示書の 6。PL 3 章の 5）: まとめて実行の段が進んでも、見ている点検の作業の画面にとどめる（前は、動いている次の段の作業へ移していたので、
  // 書き込みの段の間は「操作さがしが終わりました。」だけの画面になった）。最後まで行ったらサイトの画面へ移す（今どおり）。
  it('keeps the inspection screen while the chain runs, and moves to the site when the chain finished', () => {
    const running = chainOf('RUNNING', [['DONE', BASE.jobId], ['RUNNING', 'job-pl2-discovery']]);
    expect(summaryOf({ stageChain: running }).advance).toBeNull();
    // 次のステップをまだ始めていない間も、移さない。
    expect(summaryOf({ stageChain: chainOf('RUNNING', [['DONE', BASE.jobId], ['PENDING', null]]) }).advance).toBeNull();
    const finished = chainOf('FINISHED', [['DONE', BASE.jobId], ['DONE', 'job-pl2-discovery'], ['NOT_NEEDED', null]]);
    expect(summaryOf({ stageChain: finished }).advance).toEqual({ kind: 'SITE' });
    expect(summaryOf({ jobId: 'job-pl2-discovery', jobKind: 'DISCOVERY', stageChain: finished }).advance).toEqual({ kind: 'SITE' });
    expect(summaryOf({ stageChain: chainOf('STOPPED', [['STOPPED', BASE.jobId]]) }).advance).toBeNull();
    // OP-G（指示書の 4）: チェックした画面を 1 つも試せずに終えた点検（書き込みの段がない）も、読み取りの段は終えたので、どの段の作業からもサイトの画面へ。
    const notTried = { ...chainOf('STOPPED', [['DONE', BASE.jobId], ['STOPPED', 'job-pl2-discovery'], ['NOT_NEEDED', null]]), stopReason: 'WRITE_NOT_TRIED' as const };
    expect(summaryOf({ stageChain: notTried }).advance).toEqual({ kind: 'SITE' });
    expect(summaryOf({ jobId: 'job-pl2-discovery', jobKind: 'DISCOVERY', stageChain: notTried }).advance).toEqual({ kind: 'SITE' });
    // PL-U（14.1 の U1）: 点検のステップが一部のページを見られずに終わったときも、連鎖が動いている間は、点検の画面にとどまる。
    expect(summaryOf({ runStatus: 'PARTIAL', stageChain: running }).advance).toBeNull();
  });

  // OP-G2: 点検の画面にとどまる間は、要点の 1 行目で今の段を言う（判定はサーバの要点の 1 か所。画面は描くだけ）。結果の報告はまだ出さない（点検は続いている）。
  it('tells the stage the chain is running now, while the inspection screen waits', () => {
    const discovering = chainOf('RUNNING', [['DONE', BASE.jobId], ['RUNNING', 'job-pl2-discovery']]);
    const reading = chainOf('RUNNING', [['DONE', BASE.jobId], ['DONE', 'job-pl2-discovery'], ['RUNNING', 'job-pl2-read']]);
    const between = chainOf('RUNNING', [['DONE', BASE.jobId], ['DONE', 'job-pl2-discovery'], ['NOT_NEEDED', null]]);
    const writing = { ...between, writeStageJobIds: ['job-pl2-create'] };
    const finishedAudit = { artifacts: [REPORT] } as const;
    expect(summaryOf({ ...finishedAudit, stageChain: discovering })).toMatchObject({ chainStage: 'DISCOVERY', primary: null });
    expect(summaryOf({ ...finishedAudit, stageChain: reading }).chainStage).toBe('READ_CHECK');
    expect(summaryOf({ ...finishedAudit, stageChain: between }).chainStage).toBe('NEXT');
    expect(summaryOf({ ...finishedAudit, stageChain: writing, stageChainWriteKind: 'WRITE_CREATE' })).toMatchObject({ chainStage: 'WRITE_CREATE', primary: null });
    expect(summaryOf({ ...finishedAudit, stageChain: writing, stageChainWriteKind: 'WRITE_UPDATE' }).chainStage).toBe('WRITE_UPDATE');
    // 書き込みの段を締めた後、次の段を準備している間。
    expect(summaryOf({ ...finishedAudit, stageChain: writing }).chainStage).toBe('NEXT');
    // 見ている作業が動いている間は、その作業の 1 行（今どおり）。連鎖が終わったら、今どおりの結果と主のボタン。
    expect(summaryOf({ active: true, state: 'RUNNING', runStatus: null, finishedAt: null, stageChain: chainOf('RUNNING', [['RUNNING', BASE.jobId]]) }).chainStage)
      .toBeNull();
    const finished = chainOf('FINISHED', [['DONE', BASE.jobId], ['DONE', 'job-pl2-discovery'], ['NOT_NEEDED', null]]);
    expect(summaryOf({ ...finishedAudit, stageChain: finished })).toMatchObject({ chainStage: null, primary: 'OPEN_REPORT' });
    expect(summaryOf({ ...finishedAudit }).chainStage).toBeNull();
  });

  it('does not move the single discovery, read check and login check jobs (no next screen in the flow)', () => {
    expect(summaryOf({ jobKind: 'DISCOVERY' }).advance).toBeNull();
    expect(summaryOf({ jobKind: 'READ_CHECK' }).advance).toBeNull();
    expect(summaryOf({ jobKind: 'LOGIN_CHECK', runStatus: null, autoLogin: { result: 'SUCCEEDED', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null } }).advance)
      .toBeNull();
  });
});

describe('PL-2: the registration of the login stage rows (4 章の 2)', () => {
  it('is done after the automatic registration, needed when a row can still be registered, and none otherwise', () => {
    expect(summaryOf({ loginStage: { ...LOGIN_STAGE, autoRegistration: { result: 'SAVED', profileRevision: 2, addedServiceOrigins: [] } } }).loginStageRegistration)
      .toBe('DONE');
    expect(summaryOf({ loginStage: { ...LOGIN_STAGE, autoRegistration: { result: 'SKIPPED', reason: 'NOTHING_NEW' } } }).loginStageRegistration).toBe('DONE');
    expect(summaryOf({ loginStage: { ...LOGIN_STAGE, autoRegistration: { result: 'SKIPPED', reason: 'MULTIPLE_TOKEN_TARGETS' } } }).loginStageRegistration)
      .toBe('NEEDED');
    expect(summaryOf({ state: 'FAILED', runStatus: null, failureReason: 'LOGIN_TIMEOUT', loginStage: LOGIN_STAGE }).loginStageRegistration).toBe('NEEDED');
    expect(summaryOf({ loginStage: LOGIN_STAGE }, true).loginStageRegistration).toBe('NONE');
    expect(summaryOf({ loginStage: { ...LOGIN_STAGE, blockedRequests: { requests: [], unlisted: 0 } } }).loginStageRegistration).toBe('NONE');
    expect(summaryOf({}).loginStageRegistration).toBe('NONE');
  });
});

describe('PL-2: the estimate while waiting (13 章の 11)', () => {
  it('is the smaller of the remaining pages times the interval and the rest of the runtime limit', () => {
    expect(auditRemainingUpperBoundMs({ pagesFinished: 3, maxPages: 20, elapsedMs: 0, minNavigationIntervalMs: 10_000, maxRuntimeMs: 3_600_000 })).toBe(170_000);
    expect(auditRemainingUpperBoundMs({ pagesFinished: 0, maxPages: 500, elapsedMs: 600_000, minNavigationIntervalMs: 10_000, maxRuntimeMs: 3_600_000 })).toBe(3_000_000);
    expect(auditRemainingUpperBoundMs({ pagesFinished: 20, maxPages: 20, elapsedMs: 0, minNavigationIntervalMs: 10_000, maxRuntimeMs: 3_600_000 })).toBe(0);
    expect(auditRemainingUpperBoundMs({ pagesFinished: 1, maxPages: 20, elapsedMs: 4_000_000, minNavigationIntervalMs: 10_000, maxRuntimeMs: 3_600_000 })).toBe(0);
  });

  it('uses the progress report, or the limits before the first page, and the slowed interval of the site notice', () => {
    const limits = { maxPages: 20, maxRuntimeMs: 3_600_000, minNavigationIntervalMs: 10_000 };
    const running: Partial<Facts> = { active: true, state: 'RUNNING', runStatus: null, finishedAt: null };
    expect(jobSummaryOf({ ...BASE, ...running }, { estimateLimits: limits, awaitingRegistration: false }).estimate)
      .toEqual({ pagesFinished: 0, maxPages: 20, remainingUpperBoundMs: 200_000 });
    const progress = {
      pagesFinished: 3, pagesDiscovered: 5, maxPages: 20, elapsedMs: 30_000, navigationCount: 3, pacingWaitMs: 0,
      requests: { allowedOrigins: { count: 3, peakPerMinute: 3 }, otherOrigins: { count: 0, peakPerMinute: 0 }, servedFromCache: 0, withheldOtherOrigins: 0 },
      recentPerMinute: { allowedOrigins: 3, otherOrigins: 0 },
    };
    expect(jobSummaryOf({ ...BASE, ...running, lastProgress: progress }, { estimateLimits: limits, awaitingRegistration: false }).estimate)
      .toEqual({ pagesFinished: 3, maxPages: 20, remainingUpperBoundMs: 170_000 });
    expect(jobSummaryOf(
      { ...BASE, ...running, lastProgress: progress, lastNotice: { kind: 'SITE_UNAVAILABLE_SLOWDOWN', minIntervalMs: 20_000 } as Facts['lastNotice'] },
      { estimateLimits: limits, awaitingRegistration: false },
    ).estimate).toEqual({ pagesFinished: 3, maxPages: 20, remainingUpperBoundMs: 340_000 });
    expect(jobSummaryOf({ ...BASE, ...running }, { estimateLimits: null, awaitingRegistration: false }).estimate).toBeNull();
  });
});

// OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D3・D11、4.1.3 の 3・4）:
// - 手でのログインを待つ間、BeakSight がログインの終わりを判定できる（`loginEndDetection`）ときは、「ログインを終えた」を出さない。
// - 印つきの下調べ（作成の画面の「点検を始める」）は、続けて始めた点検の作業へ移す。始めるのを待つ間は移さずに読み直す。始めなかったときはサイトの画面へ移す。
describe('OP-1: the login confirmation and the audit started after the entry check', () => {
  const awaiting = { active: true, state: 'RUNNING', runStatus: null, finishedAt: null, lastAuthState: 'AWAITING_LOGIN' } as const;

  it('hides the login confirmation when BeakSight detects the end of the login', () => {
    expect(summaryOf({ ...awaiting, loginEndDetection: true } as Partial<Facts>).primary).toBeNull();
    expect(summaryOf({ ...awaiting, loginEndDetection: false } as Partial<Facts>).primary).toBe('CONFIRM_LOGIN');
    expect(summaryOf({ ...awaiting, loginEndDetection: null } as Partial<Facts>).primary).toBe('CONFIRM_LOGIN');
  });

  it('moves to the audit started after the entry check, waits while it is pending, and goes to the site when it did not start', () => {
    const entry = (entryCheckFollowUp: Facts['entryCheckFollowUp'], endReason = 'READ', loginPage = true) => summaryOf({
      jobKind: 'ENTRY_CHECK',
      runStatus: null,
      entryCheck: { endReason, facts: { loginPage } } as unknown as Facts['entryCheck'],
      entryCheckAuthSetup: 'PRESENT',
      entryCheckFollowUp,
    });
    expect(entry({ state: 'STARTED', jobId: 'job-chain' })).toMatchObject({ advance: { kind: 'JOB', jobId: 'job-chain' }, awaitingRegistration: false });
    expect(entry({ state: 'WAITING' })).toMatchObject({ advance: null, awaitingRegistration: true });
    expect(entry({ state: 'SKIPPED' })).toMatchObject({ advance: { kind: 'SITE' } });
    // 下調べが読めなかったときも、始めなかったのでサイトの画面へ移る（サイトの画面が理由を出す）。
    expect(entry({ state: 'SKIPPED' }, 'LEFT_ALLOWED_ORIGINS', false)).toMatchObject({ advance: { kind: 'SITE' } });
    expect(entry(null)).toMatchObject({ advance: { kind: 'SITE' } });
  });
});

// OP-2 の修正の 1 回目（指示書の 8）: 書き込みの段を含む点検（まとめて実行）の後は、サイトの画面へ移す。操作さがし・見るだけの確かめ・書き込みの手順への
// 案内（主のボタン）は出さない。書き込みの段の作業の画面からも、書き込みの手順の詳細へは移さない。止めた点検と、安全の違反で止まった点検は移さない（今どおり）。
describe('OP-2 fix round 1: the inspection with the write stages', () => {
  const withWrites = (state: 'RUNNING' | 'FINISHED' | 'STOPPED', stopReason: NonNullable<Facts['stageChain']>['stopReason'] = null): NonNullable<Facts['stageChain']> => ({
    ...chainOf(state, [['DONE', BASE.jobId], ['DONE', 'job-op2-discovery'], ['DONE', 'job-op2-read']]),
    stopReason,
    writeStageJobIds: ['job-op2-create', 'job-op2-update'],
  });
  const readStage = { jobId: 'job-op2-read', jobKind: 'READ_CHECK' } as const;
  const writeStage = { jobId: 'job-op2-update', jobKind: 'WRITE_UPDATE', runStatus: null, write: writeOf('VERIFIED') } as const;

  it('moves to the site when the inspection with the write stages ended, from the read stage and from a write stage', () => {
    expect(summaryOf({ ...readStage, stageChain: withWrites('FINISHED') }).advance).toEqual({ kind: 'SITE' });
    expect(summaryOf({ ...writeStage, stageChain: withWrites('FINISHED') }).advance).toEqual({ kind: 'SITE' });
    // 結果が分からない書き込みの後で止まった点検も、サイトの画面へ（行に結果が出る）。
    expect(summaryOf({ ...writeStage, write: writeOf('UNKNOWN'), stageChain: withWrites('STOPPED', 'WRITE_RESULT_UNKNOWN') }).advance).toEqual({ kind: 'SITE' });
  });

  it('waits while the write stages run, and keeps the screen after a safety stop and a stop by the person', () => {
    expect(summaryOf({ ...readStage, stageChain: withWrites('RUNNING') }).advance).toBeNull();
    expect(summaryOf({ ...writeStage, stageChain: withWrites('STOPPED', 'SAFETY_VIOLATION') }).advance).toBeNull();
    expect(summaryOf({ ...writeStage, stopRequestedAt: '2026-10-27T00:00:00Z', stageChain: withWrites('STOPPED', 'USER_STOPPED') }).advance).toBeNull();
  });

  it('shows no guidance to the discovery, the read checks or the write procedures', () => {
    expect(summaryOf({ ...readStage, stageChain: withWrites('FINISHED') }).primary).toBeNull();
    expect(summaryOf({ jobId: 'job-op2-discovery', jobKind: 'DISCOVERY', stageChain: withWrites('FINISHED') }).primary).toBeNull();
    // 書き込みの段の報告は今どおり見られる（書き込みの手順への案内ではない）。
    expect(summaryOf({ ...writeStage, stageChain: withWrites('FINISHED') }).primary).toBe('OPEN_WRITE_REPORT');
  });
});

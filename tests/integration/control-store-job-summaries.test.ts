// ジョブの表の、ジョブの記録の口が書くまとめの列の結合テスト（T32g・T34e・T36R-fix・T43d・DEF-138）。LG-2 で、版ごとのテスト
// （`control-store-v10`・`v11`・`v16`）の今の形と、今の版の管理データでの部品の振る舞いをまとめた（前の版からの上げの確かめは捨てた）。
// - 書き込みのジョブの報告の確かめ（`write_report_check`）: 記録の口（`recordWriteReportCheck`）は書き込みのジョブだけに 1 回だけ書く。
// - ログインの段のまとめ（`login_stage_summary`）: JSON の object の CHECK（URL-LEN の版 20 で大きさの上限は外した）。記録の口
//   （`recordAuthState`）は 1 回だけ書き、読む口（`readJob`）は閉じた形に合わなければデータベースの誤りとして止める。
// - セッションの切れの証拠（`session_loss`）: JSON の object の CHECK（大きさの上限は版 20 で外した）。`SESSION_LOST` のときに 1 回だけ書く。
// 一時のフォルダだけを使い、終わったら消す。
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import {
  readJob,
  recordAuthState,
  recordEnded,
  recordWriteReportCheck,
  type AuditJobLoginStageSummary,
} from '../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { WORKER_SCRIPT_LOGIN_BLOCK_REASONS, type WorkerScriptLoginBlockReason } from '../../src/control/worker-protocol.js';
import type { SessionLossEvidence } from '../../src/core/evidence-types.js';
import { insertRow, useControlStoreWorkspace, type SqlValue } from '../helpers/control-store-schema.js';

const PROFILE_ID = 'example-job-summaries';
const CREATED_AT = '20261016000000';
const LATER_AT = '20261016000100';

const workspace = useControlStoreWorkspace('beaksight-control-job-summaries-');

const insertJob = (connection: DatabaseSync, row: Record<string, SqlValue>): void => insertRow(connection, 'jobs', {
  job_id: 'job-1', profile_id: PROFILE_ID, profile_revision: MIN_PROFILE_REVISION, state: 'FINISHED', start_new: 1, created_at: CREATED_AT,
  finished_at: LATER_AT, job_kind: 'AUDIT', ...row,
});

/** 今の版の管理データに `rows` のジョブを入れ、開いた管理データを `use` に渡す（終わったら閉じる）。 */
const withJobs = (rows: readonly Record<string, SqlValue>[], use: (database: ControlDatabase) => void): void => {
  const connection = workspace.latestConnection([PROFILE_ID]);
  for (const row of rows) insertJob(connection, row);
  connection.close();
  const database = openControlDatabase(workspace.databasePath());
  try {
    use(database);
  } finally {
    closeControlDatabase(database);
  }
};

/** 開いている管理データに、生の接続でジョブを足す。 */
const addJob = (row: Record<string, SqlValue>): void => {
  const connection = workspace.rawConnection();
  insertJob(connection, row);
  connection.close();
};

describe('Control store: the report check of a write job', () => {
  it('records the report check of a write job once, and reads it back; another kind of job is not written', () => {
    withJobs([{ job_id: 'job-w', job_kind: 'WRITE_CREATE' }, { job_id: 'job-a', job_kind: 'AUDIT' }], (database) => {
      expect(readJob(database, 'job-w')?.writeReportCheck).toBeNull();
      expect(recordWriteReportCheck(database, 'job-w', 'BUNDLE_MISMATCH')).toBe(true);
      expect(recordWriteReportCheck(database, 'job-w', 'VALID')).toBe(false);
      expect(readJob(database, 'job-w')?.writeReportCheck).toBe('BUNDLE_MISMATCH');
      expect(recordWriteReportCheck(database, 'job-a', 'VALID')).toBe(false);
      expect(readJob(database, 'job-a')?.writeReportCheck).toBeNull();
      expect(() => recordWriteReportCheck(database, 'job-w', 'OTHER' as never)).toThrow(RangeError);
    });
  });
});

/** 止めた要求の一覧と数のまとめ（例の値）。 */
const SUMMARY: AuditJobLoginStageSummary = {
  scriptLogin: {
    tokenRequestsAllowed: 1,
    sideRequestsAllowed: [1],
    serviceOriginReads: 2,
    blockedByReason: Object.fromEntries(WORKER_SCRIPT_LOGIN_BLOCK_REASONS.map((reason) => [reason, reason === 'UNREGISTERED_NON_READ' ? 2 : 0])) as
      Record<WorkerScriptLoginBlockReason, number>,
  },
  blockedRequests: {
    requests: [{ origin: 'http://127.0.0.1:5173', path: '/rest/v1/rpc/log_login', resourceType: 'fetch', reason: 'UNREGISTERED_NON_READ', count: 2 }],
    unlisted: 0,
  },
};

/** URL-LEN（版 20）: 前の JSON の全体の上限（まとめ 32,768・証拠 65,536）を超える長さ。 */
const LONGER_THAN_FORMER_RECORD_LIMIT = 70_000;

describe('Control store: the login stage summary of a job', () => {
  // URL-LEN（版 20）: 大きさの上限（前は 32,768）はない。JSON の object の形だけを確かめる。
  it('accepts a JSON object of any size, and rejects a broken JSON and a JSON that is not an object', () => {
    const connection = workspace.latestConnection([PROFILE_ID]);
    insertJob(connection, { job_id: 'job-ok', login_stage_summary: JSON.stringify(SUMMARY) });
    insertJob(connection, { job_id: 'job-null', login_stage_summary: null });
    insertJob(connection, { job_id: 'job-long', login_stage_summary: JSON.stringify({ padding: 'x'.repeat(LONGER_THAN_FORMER_RECORD_LIMIT) }) });
    for (const [index, value] of ['{', '[]', '"text"'].entries()) {
      expect(() => insertJob(connection, { job_id: `job-bad-${index}`, login_stage_summary: value }), value.slice(0, 10)).toThrow();
    }
  });

  it('records the summary with the auth state once, reads it back, and stops at a stored summary of another form', () => {
    withJobs([
      { job_id: 'job-s', state: 'RUNNING', finished_at: null },
      { job_id: 'job-x', login_stage_summary: JSON.stringify({ scriptLogin: null, blockedRequests: null, extra: 1 }) },
    ], (database) => {
      expect(readJob(database, 'job-s')?.loginStage).toBeNull();
      expect(recordAuthState(database, 'job-s', 'LOGIN_TIMEOUT', null, SUMMARY)).toBe(true);
      expect(readJob(database, 'job-s')?.loginStage).toEqual(SUMMARY);
      expect(readJob(database, 'job-s')?.lastAuthState).toBe('LOGIN_TIMEOUT');
      // 2 回目は、状態だけを書き、まとめは書き換えない。
      const other: AuditJobLoginStageSummary = { scriptLogin: null, blockedRequests: { requests: [], unlisted: 1 } };
      expect(recordAuthState(database, 'job-s', 'AUTHENTICATED', null, other)).toBe(true);
      expect(readJob(database, 'job-s')?.loginStage).toEqual(SUMMARY);
      // フォームの送信のログイン（数のまとめなし、一覧だけ）。終わっていないジョブは 1 つだけなので、前のジョブを終えてから作る。
      expect(recordEnded(database, 'job-s', { state: 'FAILED', reason: 'LOGIN_TIMEOUT', exitCode: null, at: LATER_AT })).toBe(true);
      addJob({ job_id: 'job-f', state: 'RUNNING', finished_at: null });
      expect(recordAuthState(database, 'job-f', 'LOGIN_TIMEOUT', null, other)).toBe(true);
      expect(readJob(database, 'job-f')?.loginStage).toEqual(other);
      expect(() => readJob(database, 'job-x')).toThrow(/login_stage_summary/u);
    });
  });

  // LG-3（2026-10-24 の設計 3.7.2）: T36c の前に書いた行（資格情報の理由 `LOGIN_CREDENTIAL_IN_REQUEST` の鍵がない数）は、0 として読み替えずに、
  // 管理データの誤り（`DATABASE_INTEGRITY_FAILED`）で止まる（T36R-fix の読み替えを捨てた。動いている IPC と同じく、この鍵は必須）。
  it('stops at a summary stored before T36c without the credential reason (LG-3)', () => {
    const scriptLogin = SUMMARY.scriptLogin;
    if (scriptLogin === null) {
      throw new Error('the summary has no counts');
    }
    const { LOGIN_CREDENTIAL_IN_REQUEST: _credential, ...before } = scriptLogin.blockedByReason;
    const stored = { ...SUMMARY, scriptLogin: { ...scriptLogin, blockedByReason: before } };
    withJobs([{ job_id: 'job-before', login_stage_summary: JSON.stringify(stored) }], (database) => {
      expect(() => readJob(database, 'job-before')).toThrow(expect.objectContaining({ reason: 'DATABASE_INTEGRITY_FAILED' }));
      expect(() => readJob(database, 'job-before')).toThrow(/login_stage_summary/u);
    });
  });
});

// T43d（Task 43 の設計書 4.4）: ログインの段のまとめに、止めた要求の行の query（名前と `grant_type` の値）と、観察（成功の鍵の名前の案と成功の画面の
// セレクタの案。任意の項目 `observation`）を足した。`observation` のない行は今どおり読める。
describe('Control store: the login observation in the login stage summary', () => {
  it('records the observation and the query with the summary, reads them back, and reads a summary without the observation', () => {
    withJobs([
      { job_id: 'job-o', state: 'RUNNING', finished_at: null },
      { job_id: 'job-before', login_stage_summary: JSON.stringify(SUMMARY) },
    ], (database) => {
      const observed: AuditJobLoginStageSummary = {
        scriptLogin: null,
        blockedRequests: {
          requests: [{
            origin: 'http://127.0.0.1:5173', path: '/auth/v1/token', resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
            query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] },
          }],
          unlisted: 0,
        },
        observation: {
          storageKeys: { origin: 'http://127.0.0.1:4173', shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 },
          successSelector: { selector: '#logout', kind: 'LOGOUT_CONTROL', logoutWord: 'logout' },
        },
      };
      expect(recordAuthState(database, 'job-o', 'LOGIN_TIMEOUT', null, observed)).toBe(true);
      expect(readJob(database, 'job-o')?.loginStage).toEqual(observed);
      expect(readJob(database, 'job-before')?.loginStage).toEqual(SUMMARY);
      // 観察だけのまとめ（フォームの送信のログインで止めた要求がない成功）も書ける。
      expect(recordEnded(database, 'job-o', { state: 'FAILED', reason: 'LOGIN_TIMEOUT', exitCode: null, at: LATER_AT })).toBe(true);
      addJob({ job_id: 'job-only', state: 'RUNNING', finished_at: null });
      const only: AuditJobLoginStageSummary = {
        scriptLogin: null, blockedRequests: null, observation: { successSelector: { selector: '#logout-btn', kind: 'LOGOUT_CONTROL', logoutWord: 'logout' } },
      };
      expect(recordAuthState(database, 'job-only', 'AUTHENTICATED', null, only)).toBe(true);
      expect(readJob(database, 'job-only')?.loginStage).toEqual(only);
      // 閉じた形でない観察（要素の文字）は書けない。
      expect(() => recordAuthState(database, 'job-only', 'AUTHENTICATED', null, {
        ...only, observation: { successSelector: { selector: '#logout-btn', kind: 'LOGOUT_CONTROL', logoutWord: 'logout', text: 'x' } },
      } as unknown as AuditJobLoginStageSummary)).toThrow(RangeError);
    });
  });

  // URL-LEN（版 20）: 前の大きさの上限（32,768）を超えるまとめも、観察と行の query の名前を落とさずに、そのまま書いて読む（前は落として「省いた」印を付けた）。
  // 前に書いた「省いた」印のまとめも読める。
  it('records a summary longer than the former limit as it is, with the observation and the query names, and reads an omitted summary written before', () => {
    withJobs([{ job_id: 'job-big', state: 'RUNNING', finished_at: null }, { job_id: 'job-omitted', state: 'FINISHED' }], (database) => {
      const longPath = `/${'p'.repeat(LONGER_THAN_FORMER_RECORD_LIMIT)}`;
      const big: AuditJobLoginStageSummary = {
        scriptLogin: null,
        blockedRequests: {
          requests: [{
            origin: 'http://127.0.0.1:5173', path: longPath, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
            query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] },
          }],
          unlisted: 0,
        },
        observation: { successSelector: { selector: '#logout', kind: 'LOGOUT_CONTROL', logoutWord: 'logout' } },
      };
      expect(recordAuthState(database, 'job-big', 'LOGIN_TIMEOUT', null, big)).toBe(true);
      expect(readJob(database, 'job-big')?.loginStage).toEqual(big);
      const omitted: AuditJobLoginStageSummary = { scriptLogin: null, blockedRequests: SUMMARY.blockedRequests, observationOmitted: true };
      const connection = workspace.rawConnection();
      connection.prepare('UPDATE jobs SET login_stage_summary = ? WHERE job_id = ?').run(JSON.stringify(omitted), 'job-omitted');
      connection.close();
      expect(readJob(database, 'job-omitted')?.loginStage).toEqual(omitted);
    });
  });
});

/** 例の証拠（値を持たない）。 */
const EVIDENCE: SessionLossEvidence = {
  stage: 'desktop:passive',
  requestedPath: '/admin/expired',
  landedPath: '/auth?from&ticket',
  landedBy: 'PAGE_URL',
  redirectPaths: [{ originKind: 'ALLOWED', path: '/admin/expired' }, { originKind: 'ALLOWED', path: '/auth?from&ticket' }],
  redirectPathsOmitted: 0,
  blockedRequests: [{ method: 'GET', originKind: 'ALLOWED', path: '/auth', reason: 'AUDIT_EXCLUDED_URL', count: 1 }],
  blockedRequestsUnlisted: 0,
  storageKeyChange: [{ storage: 'LOCAL_STORAGE', originKind: 'ALLOWED', change: 'REMOVED', count: 1, shapes: [{ prefix: '', suffix: '-token' }] }],
};

describe('Control store: the session loss evidence of a job', () => {
  // URL-LEN（版 20）: 大きさの上限（前は 65,536）はない。JSON の object の形だけを確かめる。
  it('accepts an evidence of any size, and rejects a broken JSON and a JSON that is not an object', () => {
    const connection = workspace.latestConnection([PROFILE_ID]);
    insertJob(connection, { job_id: 'job-ok', session_loss: JSON.stringify(EVIDENCE) });
    insertJob(connection, { job_id: 'job-long', session_loss: JSON.stringify({ padding: 'x'.repeat(LONGER_THAN_FORMER_RECORD_LIMIT) }) });
    for (const [index, value] of ['{', '[]', '"text"'].entries()) {
      expect(() => insertJob(connection, { job_id: `job-bad-${index}`, session_loss: value }), value.slice(0, 10)).toThrow();
    }
  });

  it('records the evidence with SESSION_LOST once, reads it back, and stops at another form', () => {
    const marker = 'marker-value-should-not-be-stored';
    withJobs([
      { job_id: 'job-s', state: 'RUNNING', finished_at: null },
      { job_id: 'job-x', session_loss: JSON.stringify({ ...EVIDENCE, landedPath: `/auth?ticket=${marker}` }) },
    ], (database) => {
      expect(readJob(database, 'job-s')?.sessionLoss).toBeNull();
      // `SESSION_LOST` のほかの状態では、証拠を受けない（呼び出し側の誤り）。
      expect(() => recordAuthState(database, 'job-s', 'AUTHENTICATED', null, null, EVIDENCE)).toThrow(RangeError);
      expect(recordAuthState(database, 'job-s', 'SESSION_LOST', 'http://127.0.0.1/admin/expired', null, EVIDENCE)).toBe(true);
      expect(readJob(database, 'job-s')).toMatchObject({ lastAuthState: 'SESSION_LOST', sessionLoss: EVIDENCE });
      // 2 回目は書き換えない。
      expect(recordAuthState(database, 'job-s', 'SESSION_LOST', 'http://127.0.0.1/admin/other', null, { ...EVIDENCE, stage: 'mobile:passive' })).toBe(true);
      expect(readJob(database, 'job-s')?.sessionLoss).toEqual(EVIDENCE);
      // 閉じた形でない（query の値を持つ）証拠は、データベースの誤り。
      expect(() => readJob(database, 'job-x')).toThrow(/session_loss/u);
      // URL-LEN: 前の大きさの上限（65,536）と path の上限（2,048）を超える証拠も、そのまま書いて読む。
      expect(recordEnded(database, 'job-s', { state: 'FAILED', reason: 'LOGIN_TIMEOUT', exitCode: null, at: LATER_AT })).toBe(true);
      addJob({ job_id: 'job-long', state: 'RUNNING', finished_at: null });
      const long: SessionLossEvidence = { ...EVIDENCE, requestedPath: `/${'p'.repeat(LONGER_THAN_FORMER_RECORD_LIMIT)}` };
      expect(recordAuthState(database, 'job-long', 'SESSION_LOST', `http://127.0.0.1/${'p'.repeat(2_049)}`, null, long)).toBe(true);
      expect(readJob(database, 'job-long')).toMatchObject({ sessionLoss: long, sessionLostUrl: `http://127.0.0.1/${'p'.repeat(2_049)}` });
    });
  });
});

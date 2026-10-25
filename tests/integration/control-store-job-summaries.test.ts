// ジョブの表の、ジョブの記録の口が書くまとめの列の結合テスト（T32g・T34e・T36R-fix・T43d・DEF-138）。LG-2 で、版ごとのテスト
// （`control-store-v10`・`v11`・`v16`）の今の形と、今の版の管理データでの部品の振る舞いをまとめた（前の版からの上げの確かめは捨てた）。
// - 書き込みのジョブの報告の確かめ（`write_report_check`）: 記録の口（`recordWriteReportCheck`）は書き込みのジョブだけに 1 回だけ書く。
// - ログインの段のまとめ（`login_stage_summary`）: JSON の object と大きさの上限の CHECK。最も大きいまとめが上限に収まる。記録の口
//   （`recordAuthState`）は 1 回だけ書き、読む口（`readJob`）は閉じた形に合わなければデータベースの誤りとして止める。
// - セッションの切れの証拠（`session_loss`）: JSON の object と大きさの上限の CHECK。`SESSION_LOST` のときに 1 回だけ書く。
// 一時のフォルダだけを使い、終わったら消す。
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MAX_LOGIN_SIDE_REQUESTS, MAX_SUCCESS_SELECTOR_LENGTH } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { MAX_LOGIN_STAGE_SUMMARY_LENGTH, MAX_SESSION_LOSS_RECORD_LENGTH } from '../../src/control/job/job-records.js';
import {
  fittedLoginStageSummary,
  readJob,
  recordAuthState,
  recordEnded,
  recordWriteReportCheck,
  type AuditJobLoginStageSummary,
} from '../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import {
  MAX_WORKER_LOGIN_STAGE_BLOCKED_PATH_LENGTH,
  MAX_WORKER_LOGIN_STAGE_BLOCKED_REQUESTS,
  MAX_WORKER_NOTICE_URL_LENGTH,
  WORKER_LOGIN_STAGE_BLOCK_REASONS,
  WORKER_REQUEST_RESOURCE_TYPES,
  WORKER_SCRIPT_LOGIN_BLOCK_REASONS,
  type WorkerScriptLoginBlockReason,
} from '../../src/control/worker-protocol.js';
import {
  MAX_SESSION_LOSS_BLOCKED_REQUESTS,
  MAX_SESSION_LOSS_KEY_SHAPES,
  MAX_SESSION_LOSS_PATH_LENGTH,
  MAX_SESSION_LOSS_REDIRECT_PATHS,
  MAX_SESSION_LOSS_STORAGE_KEY_CHANGES,
  SESSION_LOSS_BLOCKED_REQUEST_REASONS,
  type SessionLossEvidence,
} from '../../src/core/evidence-types.js';
import { DISCOVERY_LOGOUT_WORDS } from '../../src/discovery/classification-words.js';
import {
  LOGIN_OBSERVED_QUERY_VALUE_NAMES,
  MAX_LOGIN_OBSERVED_KEY_PART_LENGTH,
  MAX_LOGIN_OBSERVED_QUERY_NAMES,
  MAX_LOGIN_OBSERVED_QUERY_NAME_LENGTH,
  MAX_LOGIN_OBSERVED_QUERY_VALUE_LENGTH,
  MAX_LOGIN_OBSERVED_STORAGE_KEY_NAMES,
} from '../../src/discovery/login-observation.js';
import { insertRow, useControlStoreWorkspace, type SqlValue } from '../helpers/control-store-schema.js';

const PROFILE_ID = 'example-job-summaries';
const CREATED_AT = '20261016000000';
const LATER_AT = '20261016000100';
/** 安全な整数の最大（回数の最悪の桁数）。 */
const MAX_COUNT = Number.MAX_SAFE_INTEGER;

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

/** 最も大きいまとめ（上限の長さの Origin と path、上限の件数、安全な整数の最大の回数、最も長い理由と種類の名前）。 */
const largestSummaryText = (): string => {
  const longest = (values: readonly string[]): string => values.reduce((a, b) => (b.length > a.length ? b : a), '');
  const origin = `http://${'a'.repeat(MAX_WORKER_NOTICE_URL_LENGTH - 'http://'.length)}`;
  return JSON.stringify({
    scriptLogin: {
      tokenRequestsAllowed: MAX_COUNT,
      sideRequestsAllowed: Array.from({ length: MAX_LOGIN_SIDE_REQUESTS }, () => MAX_COUNT),
      serviceOriginReads: MAX_COUNT,
      blockedByReason: Object.fromEntries(WORKER_SCRIPT_LOGIN_BLOCK_REASONS.map((reason) => [reason, MAX_COUNT])),
    },
    blockedRequests: {
      requests: Array.from({ length: MAX_WORKER_LOGIN_STAGE_BLOCKED_REQUESTS }, () => ({
        origin,
        path: `/${'p'.repeat(MAX_WORKER_LOGIN_STAGE_BLOCKED_PATH_LENGTH - 1)}`,
        resourceType: longest(WORKER_REQUEST_RESOURCE_TYPES),
        reason: longest(WORKER_LOGIN_STAGE_BLOCK_REASONS),
        count: MAX_COUNT,
      })),
      unlisted: MAX_COUNT,
    },
  });
};

describe('Control store: the login stage summary of a job', () => {
  it('fits the largest summary in the size limit', () => {
    expect(largestSummaryText().length).toBeLessThanOrEqual(MAX_LOGIN_STAGE_SUMMARY_LENGTH);
  });

  it('accepts a JSON object within the size limit, and rejects a broken JSON, a JSON that is not an object and a too long one', () => {
    const connection = workspace.latestConnection([PROFILE_ID]);
    insertJob(connection, { job_id: 'job-ok', login_stage_summary: JSON.stringify(SUMMARY) });
    insertJob(connection, { job_id: 'job-null', login_stage_summary: null });
    for (const [index, value] of ['{', '[]', '"text"', JSON.stringify({ padding: 'x'.repeat(MAX_LOGIN_STAGE_SUMMARY_LENGTH) })].entries()) {
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
// セレクタの案。任意の項目 `observation`）を足した。最も大きいまとめも、大きさの上限の中に収まる。`observation` のない行は今どおり読める。
describe('Control store: the login observation in the login stage summary', () => {
  /** 最も大きい観察（上限の長さの Origin、上限の数と長さの鍵の名前、最も長い CSS と語）。 */
  const largestObservation = () => {
    const longest = (values: readonly string[]): string => values.reduce((a, b) => (b.length > a.length ? b : a), '');
    return {
      // T43R-fix の C-1（意図して直した期待）: 鍵の名前は接頭辞と接尾辞の組だけ。
      storageKeys: {
        origin: `http://${'a'.repeat(MAX_WORKER_NOTICE_URL_LENGTH - 'http://'.length)}`,
        shapes: Array.from({ length: MAX_LOGIN_OBSERVED_STORAGE_KEY_NAMES }, (_, index) => ({
          prefix: `${index}${'k'.repeat(MAX_LOGIN_OBSERVED_KEY_PART_LENGTH - 1)}.`, suffix: `.${index}${'k'.repeat(MAX_LOGIN_OBSERVED_KEY_PART_LENGTH - 1)}`,
        })),
        omitted: MAX_COUNT,
      },
      successSelector: { selector: `#${'s'.repeat(MAX_SUCCESS_SELECTOR_LENGTH - 1)}`, kind: 'LOGOUT_CONTROL', logoutWord: longest(DISCOVERY_LOGOUT_WORDS) },
      credentialDiscarded: MAX_COUNT,
    };
  };

  it('fits the largest summary with the query of every row and the observation in the size limit', () => {
    const largest = JSON.parse(largestSummaryText()) as { blockedRequests: { requests: Record<string, unknown>[] } } & Record<string, unknown>;
    const query = {
      names: Array.from({ length: MAX_LOGIN_OBSERVED_QUERY_NAMES }, (_, index) => `${index}${'q'.repeat(MAX_LOGIN_OBSERVED_QUERY_NAME_LENGTH - 1)}`),
      omitted: MAX_COUNT,
      values: LOGIN_OBSERVED_QUERY_VALUE_NAMES.map((name) => ({ name, value: 'v'.repeat(MAX_LOGIN_OBSERVED_QUERY_VALUE_LENGTH) })),
    };
    const text = JSON.stringify({
      ...largest,
      blockedRequests: { ...largest.blockedRequests, requests: largest.blockedRequests.requests.map((request) => ({ ...request, query })) },
      observation: largestObservation(),
    });
    expect(text.length).toBeLessThanOrEqual(MAX_LOGIN_STAGE_SUMMARY_LENGTH);
  });

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

  // T43R-fix の M-5: まとめの大きさは JSON の escape を含めた全体の長さで確かめ、上限を超えるときは観察と行の query の名前を落として「省いた」印を付ける
  // （RangeError で落とさない）。数のまとめと、行の Origin・path・種類・理由・回数は残る。
  it('drops the observation and the query names of a summary over the limit with the escapes, and marks it omitted', () => {
    withJobs([{ job_id: 'job-big', state: 'RUNNING', finished_at: null }], (database) => {
      const largest = JSON.parse(largestSummaryText()) as AuditJobLoginStageSummary;
      // 引用符は JSON の escape で 2 文字になる（IPC の検証は 1 文字で数える）。
      const quoted = (index: number): string => `${index}${'"'.repeat(MAX_LOGIN_OBSERVED_QUERY_NAME_LENGTH - 1)}`;
      const big: AuditJobLoginStageSummary = {
        ...largest,
        blockedRequests: {
          requests: (largest.blockedRequests?.requests ?? []).map((request) => ({
            ...request,
            query: { names: [quoted(0), quoted(1), quoted(2), 'grant_type'].sort(), omitted: MAX_COUNT, values: [{ name: 'grant_type', value: 'password' }] },
          })),
          unlisted: largest.blockedRequests?.unlisted ?? 0,
        },
        observation: {
          ...largestObservation(),
          storageKeys: {
            origin: largestObservation().storageKeys.origin,
            shapes: Array.from({ length: MAX_LOGIN_OBSERVED_STORAGE_KEY_NAMES }, (_, index) => ({
              prefix: `${index}${'"'.repeat(MAX_LOGIN_OBSERVED_KEY_PART_LENGTH - 1)}.`, suffix: `.${index}${'"'.repeat(MAX_LOGIN_OBSERVED_KEY_PART_LENGTH - 1)}`,
            })),
            omitted: MAX_COUNT,
          },
        } as NonNullable<AuditJobLoginStageSummary['observation']>,
      };
      // 上限を超えるまとめは、観察と query の名前を落とし、省いた印を付ける（行と数は残る）。
      expect(JSON.stringify(big).length).toBeGreaterThan(MAX_LOGIN_STAGE_SUMMARY_LENGTH);
      const fitted = fittedLoginStageSummary(big);
      expect(fitted.observationOmitted).toBe(true);
      expect(fitted.observation).toBeUndefined();
      expect(fitted.blockedRequests?.requests.every((request) => request.query === undefined)).toBe(true);
      expect(fitted.blockedRequests?.requests).toHaveLength(largest.blockedRequests?.requests.length ?? 0);
      expect(fitted.scriptLogin).toEqual(largest.scriptLogin);
      expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(MAX_LOGIN_STAGE_SUMMARY_LENGTH);
      expect(fittedLoginStageSummary(SUMMARY)).toBe(SUMMARY);
      // IPC の検証を通る最も大きいまとめ（正規の Origin の最大の長さ、escape で 2 文字になる引用符の path・query の名前・鍵の部分）は、上限に収まり、
      // 書く口は RangeError で落とさずに、そのまま書く。省いた印のまとめも書けて読める。
      const origin = `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}:65535`;
      const valid: AuditJobLoginStageSummary = {
        ...big,
        blockedRequests: {
          requests: (big.blockedRequests?.requests ?? []).map((request, index) => ({
            ...request, origin, path: `/${String(index)}${'"'.repeat(MAX_WORKER_LOGIN_STAGE_BLOCKED_PATH_LENGTH - 2)}`,
          })),
          unlisted: MAX_COUNT,
        },
        observation: {
          ...big.observation,
          // T43R2-fix: 鍵の案の端の部分は一般の語だけ（引用符の部分は持てない）。最も長い一般の語の組を上限の数まで。
          storageKeys: {
            origin,
            shapes: ['refreshtoken', 'accesstoken', 'credentials', 'authtoken'].map((word) => ({ prefix: `${word}.`, suffix: `.${word}` })),
            omitted: MAX_COUNT,
          },
          // ログアウトの属性の CSS の最も長い形（`href` は上限の長さまで）。
          successSelector: { selector: `a[href="/${'menu/'.repeat(24)}logout"]`, kind: 'LOGOUT_CONTROL', logoutWord: 'ログアウト' },
        },
      };
      expect(recordAuthState(database, 'job-big', 'LOGIN_TIMEOUT', null, valid)).toBe(true);
      expect(readJob(database, 'job-big')?.loginStage).toEqual(valid);
      expect(recordEnded(database, 'job-big', { state: 'FAILED', reason: 'LOGIN_TIMEOUT', exitCode: null, at: LATER_AT })).toBe(true);
      addJob({ job_id: 'job-omitted', state: 'RUNNING', finished_at: null });
      const omitted: AuditJobLoginStageSummary = { scriptLogin: null, blockedRequests: SUMMARY.blockedRequests, observationOmitted: true };
      expect(recordAuthState(database, 'job-omitted', 'LOGIN_TIMEOUT', null, omitted)).toBe(true);
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

/** 最も大きい証拠（上限の件数と最大の長さの path の表記、安全な整数の最大の回数）。 */
const largestEvidenceText = (): string => {
  const longest = (values: readonly string[]): string => values.reduce((a, b) => (b.length > a.length ? b : a), '');
  const path = `/${'p'.repeat(MAX_SESSION_LOSS_PATH_LENGTH - 1)}`;
  const part = 't'.repeat(MAX_LOGIN_OBSERVED_KEY_PART_LENGTH);
  return JSON.stringify({
    stage: path,
    requestedPath: path,
    landedPath: path,
    landedBy: 'BLOCKED_REDIRECT',
    redirectPaths: Array.from({ length: MAX_SESSION_LOSS_REDIRECT_PATHS }, () => ({ originKind: 'SERVICE', path })),
    redirectPathsOmitted: MAX_COUNT,
    blockedRequests: Array.from({ length: MAX_SESSION_LOSS_BLOCKED_REQUESTS }, () => ({
      method: 'M'.repeat(32), originKind: 'SERVICE', path, reason: longest(SESSION_LOSS_BLOCKED_REQUEST_REASONS), count: MAX_COUNT,
    })),
    blockedRequestsUnlisted: MAX_COUNT,
    storageKeyChange: Array.from({ length: MAX_SESSION_LOSS_STORAGE_KEY_CHANGES }, () => ({
      storage: 'LOCAL_STORAGE', originKind: 'SERVICE', change: 'REMOVED', count: MAX_COUNT,
      shapes: Array.from({ length: MAX_SESSION_LOSS_KEY_SHAPES }, () => ({ prefix: `${part}.`, suffix: `.${part}` })),
    })),
  });
};

describe('Control store: the session loss evidence of a job', () => {
  it('fits the largest evidence in the size limit', () => {
    expect(largestEvidenceText().length).toBeLessThanOrEqual(MAX_SESSION_LOSS_RECORD_LENGTH);
  });

  it('rejects a broken JSON, a JSON that is not an object and a too long one', () => {
    const connection = workspace.latestConnection([PROFILE_ID]);
    insertJob(connection, { job_id: 'job-ok', session_loss: JSON.stringify(EVIDENCE) });
    for (const [index, value] of ['{', '[]', '"text"', JSON.stringify({ padding: 'x'.repeat(MAX_SESSION_LOSS_RECORD_LENGTH) })].entries()) {
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
    });
  });
});

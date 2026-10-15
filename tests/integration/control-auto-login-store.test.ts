// T26c（Task 26 の設計書 4.2 の「止めた状態との関係」「変更の記録」、4.5 の「止める」、変更履歴の「Blocker: T26c」の行）: 自動ログインの
// 試し・止めた状態・資格情報の変更の記録の部品（`src/control/job/auto-login-store.ts`）と、ジョブを作るときの試し始めた記録
// （`createStartingJob`）の結合テスト。
// - 試し始めた記録は、ジョブの行と同じトランザクションで書く（どちらか一方だけが残らない）。ジョブの種類は必ず明示して書く。
// - 結果ごとに止めるか: 成功は止めない、送信が `NO` は止めない、`YES` と `UNKNOWN` は止める（すでに止めていれば作らない）。
// - 結果なしで終わった試しを `AUTH_RESULT_UNKNOWN`・送信 `UNKNOWN` で閉じて止める（ジョブの終わりと、起動のときの回復）。
// - 止めた状態を解く（解いた時刻と `HOLD_CLEARED`）。資格情報の変更の記録（解除とまとめて書ける）。
// - 読み出し（止めた状態、上限の判定に要る試し、最近の変更）と、上限の判定（`decideAutoLoginStart`）との組み合わせ。
// - 秘密: 記録の部品の入力の型に値（ユーザー名・パスワード）の口がない。余分な項目に目印を入れて渡しても、管理データのファイルと WAL に
//   目印が出ない。
// 一時のフォルダだけを使い、終わったら消す。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { decideAutoLoginStart, AUTO_LOGIN_DAILY_WINDOW_MS } from '../../src/control/job/auto-login-limits.js';
import {
  clearAutoLoginHold,
  closeOrphanedAutoLoginAttempts,
  closePendingAutoLoginAttempt,
  readAutoLoginHold,
  readAutoLoginLimitInputs,
  readRecentCredentialEvents,
  recordAutoLoginResult,
  recordCredentialEvent,
  RESENT_ATTEMPT_JOB_ID_PREFIX,
  type AutoLoginResultInput,
  type CredentialEventInput,
} from '../../src/control/job/auto-login-store.js';
import { createStartingJob, recordEnded, type NewAuditJob } from '../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { publicProfile, resolveTestContext } from './control-profile-fixtures.js';

const PROFILE_ID = 'example-auto-login';
const OTHER_PROFILE_ID = 'example-auto-login-other';
const NOW = new Date(Date.UTC(2026, 9, 10, 12, 0, 0));
const MINUTE_MS = 60_000;
const stampAt = (offsetMs: number): string => formatCompactUtcTimestamp(new Date(NOW.getTime() + offsetMs), 'test time');
const CREATED_AT = stampAt(-10 * MINUTE_MS);
const ENDED_AT = stampAt(-9 * MINUTE_MS);
const RESULT_AT = stampAt(-9 * MINUTE_MS);
const CREDENTIAL_REVISION = 2;

let workDirectory = '';
let database: ControlDatabase;
let jobCount = 0;

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-auto-login-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  for (const profileId of [PROFILE_ID, OTHER_PROFILE_ID]) {
    expect(createProfile(database, publicProfile(profileId, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
  }
  jobCount = 0;
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

const rawQuery = <Row>(sql: string, ...params: (string | number | null)[]): Row[] => {
  const raw = new DatabaseSync(resolveControlDatabasePath(workDirectory), { readOnly: true });
  try {
    return raw.prepare(sql).all(...params) as Row[];
  } finally {
    raw.close();
  }
};

const attemptsOf = (profileId = PROFILE_ID): Record<string, unknown>[] =>
  rawQuery('SELECT job_id, result, submitted, retry_after_until, result_recorded_at, credential_revision FROM auto_login_attempts WHERE profile_id = ? ORDER BY attempt_id', profileId);

const holdsOf = (profileId = PROFILE_ID): Record<string, unknown>[] =>
  rawQuery('SELECT reason, cleared_at FROM auto_login_holds WHERE profile_id = ? ORDER BY hold_id', profileId);

const newJob = (overrides: Partial<NewAuditJob> = {}, withAttempt = true): NewAuditJob => {
  jobCount += 1;
  const job: NewAuditJob = {
    jobId: `job-${jobCount}`,
    jobKind: 'LOGIN_CHECK',
    profileId: PROFILE_ID,
    profileRevision: MIN_PROFILE_REVISION,
    startNew: true,
    createdAt: CREATED_AT,
  };
  return { ...job, ...(withAttempt ? { autoLoginAttempt: { credentialRevision: CREDENTIAL_REVISION } } : {}), ...overrides };
};

/** 試し始めた記録つきのジョブを作り、すぐに終わらせる（次のジョブを作れるように）。ジョブの ID を返す。 */
const startedAttempt = (overrides: Partial<NewAuditJob> = {}, endJob = true): string => {
  const job = newJob(overrides);
  expect(createStartingJob(database, job, () => null)).toEqual({ ok: true });
  if (endJob) {
    recordEnded(database, job.jobId, { state: 'INTERRUPTED', reason: 'WORKER_EXITED', exitCode: null, at: ENDED_AT });
  }
  return job.jobId;
};

const result = (jobId: string, overrides: Partial<AutoLoginResultInput> = {}): AutoLoginResultInput => ({
  jobId, result: 'ACCOUNT_LOCKED', submitted: 'YES', retryAfterUntil: null, at: RESULT_AT, ...overrides,
});

describe('createStartingJob with the job kind and the attempt (T26c, Blocker A)', () => {
  it('writes the job kind and the started attempt together', () => {
    const jobId = startedAttempt({}, false);
    expect(rawQuery('SELECT job_kind FROM jobs WHERE job_id = ?', jobId)).toEqual([{ job_kind: 'LOGIN_CHECK' }]);
    expect(attemptsOf()).toEqual([
      { job_id: jobId, result: null, submitted: null, retry_after_until: null, result_recorded_at: null, credential_revision: CREDENTIAL_REVISION },
    ]);
    expect(rawQuery('SELECT started_at FROM auto_login_attempts WHERE job_id = ?', jobId)).toEqual([{ started_at: CREATED_AT }]);
  });

  it('writes an AUDIT job without an attempt when none is given', () => {
    const job = newJob({ jobKind: 'AUDIT' }, false);
    expect('autoLoginAttempt' in job).toBe(false);
    expect(createStartingJob(database, job, () => null)).toEqual({ ok: true });
    expect(rawQuery('SELECT job_kind FROM jobs WHERE job_id = ?', job.jobId)).toEqual([{ job_kind: 'AUDIT' }]);
    expect(attemptsOf()).toEqual([]);
  });

  it('writes neither the job nor the attempt when the guard refuses or another job is active', () => {
    const refused = newJob();
    expect(createStartingJob(database, refused, () => 'AUTO_LOGIN_HELD' as const)).toEqual({ ok: false, reason: 'AUTO_LOGIN_HELD' });
    const active = startedAttempt({}, false);
    const second = newJob();
    expect(createStartingJob(database, second, () => null)).toEqual({ ok: false, reason: 'JOB_ALREADY_ACTIVE' });
    expect(rawQuery<{ job_id: string }>('SELECT job_id FROM jobs ORDER BY job_id').map((row) => row.job_id)).toEqual([active]);
    expect(attemptsOf().map((row) => row['job_id'])).toEqual([active]);
  });

  it('rolls the job back when the attempt cannot be written (one transaction)', () => {
    const job = newJob({ autoLoginAttempt: { credentialRevision: 0 } });
    expect(() => createStartingJob(database, job, () => null)).toThrow();
    expect(rawQuery('SELECT job_id FROM jobs')).toEqual([]);
    expect(attemptsOf()).toEqual([]);
  });

  it('requires the job kind in the type (no silent AUDIT)', () => {
    // T27c: ジョブの種類に `DISCOVERY` と `READ_CHECK` を足した（行を作る部品は、表が受ける種類をすべて受ける。始める口は T27d・T27e）。
    // T30d: 書き込みのジョブ `WRITE_CREATE` を足した（始める口は T30e）。T31e: 更新の書き込みのジョブ `WRITE_UPDATE` を足した（始める口は T31f）。
    expectTypeOf<NewAuditJob['jobKind']>().toEqualTypeOf<'AUDIT' | 'LOGIN_CHECK' | 'DISCOVERY' | 'READ_CHECK' | 'WRITE_CREATE' | 'WRITE_UPDATE'>();
    expectTypeOf<undefined extends NewAuditJob['jobKind'] ? true : false>().toEqualTypeOf<false>();
  });
});

describe('recording the result and holding (design 4.5)', () => {
  it.each([
    ['a failure that was sent', { result: 'INVALID_CREDENTIALS', submitted: 'YES' }, true],
    ['a failure whose sending is unknown', { result: 'LOGIN_FORM_INPUT_FAILED', submitted: 'UNKNOWN' }, true],
    ['a rate limit with Retry-After', { result: 'RATE_LIMITED', submitted: 'YES', retryAfterUntil: stampAt(MINUTE_MS) }, true],
    ['a failure before sending', { result: 'LOGIN_FORM_INVALID', submitted: 'NO' }, false],
    ['a changed credential before sending', { result: 'CREDENTIAL_CHANGED', submitted: 'NO' }, false],
    ['a success', { result: 'SUCCEEDED', submitted: 'YES' }, false],
  ] as const)('records %s and holds only when it was or may have been sent', (_name, overrides, held) => {
    const jobId = startedAttempt();
    expect(recordAutoLoginResult(database, result(jobId, overrides))).toEqual({ recorded: true, held });
    expect(attemptsOf()).toEqual([{
      job_id: jobId,
      result: overrides.result,
      submitted: overrides.submitted,
      retry_after_until: 'retryAfterUntil' in overrides ? overrides.retryAfterUntil : null,
      result_recorded_at: RESULT_AT,
      credential_revision: CREDENTIAL_REVISION,
    }]);
    expect(holdsOf()).toEqual(held ? [{ reason: overrides.result, cleared_at: null }] : []);
    expect(readAutoLoginHold(database, PROFILE_ID)?.reason ?? null).toBe(held ? overrides.result : null);
  });

  it('does not overwrite a recorded result, and does not add a second hold while held', () => {
    const first = startedAttempt();
    expect(recordAutoLoginResult(database, result(first))).toEqual({ recorded: true, held: true });
    expect(recordAutoLoginResult(database, result(first, { result: 'SUCCEEDED' }))).toEqual({ recorded: false, held: false });
    const second = startedAttempt();
    expect(recordAutoLoginResult(database, result(second, { result: 'MFA_REQUIRED' }))).toEqual({ recorded: true, held: false });
    expect(holdsOf()).toEqual([{ reason: 'ACCOUNT_LOCKED', cleared_at: null }]);
    expect(recordAutoLoginResult(database, result('job-missing'))).toEqual({ recorded: false, held: false });
  });

  it('rejects inconsistent results (caller errors) without writing', () => {
    const jobId = startedAttempt();
    expect(() => recordAutoLoginResult(database, result(jobId, { result: 'ACCOUNT_LOCKED', retryAfterUntil: stampAt(MINUTE_MS) }))).toThrow(RangeError);
    expect(() => recordAutoLoginResult(database, result(jobId, { result: 'SUCCEEDED', submitted: 'UNKNOWN' }))).toThrow(RangeError);
    expect(() => recordAutoLoginResult(database, result(jobId, { at: '2026-10-10' }))).toThrow(RangeError);
    expect(() => recordAutoLoginResult(database, result(jobId, { result: 'LOCKED' as never }))).toThrow(RangeError);
    expect(attemptsOf()[0]?.['result']).toBeNull();
    expect(holdsOf()).toEqual([]);
  });
});

// T30R-fix-1（M-2）: 結果のない試し（ログインの POST の後にワーカーが落ちた、画面のサーバが終わった）は、送信したかもしれない回なので、DEF-099 fix
// round 1 と同じ作りの 2 行目を書く（少なく数えない側）。止める行は 1 行。上限の判定は 2 回と数える。
describe('closing attempts that ended without a result (design 4.5)', () => {
  /** 結果のない試しを閉じた 2 行（1 行目はジョブの id、2 行目は `RESENT_ATTEMPT_JOB_ID_PREFIX` の id。どちらも結果が分からず、送信 `UNKNOWN`）。 */
  const unknownRowsOf = (jobId: string): readonly unknown[] => [jobId, `${RESENT_ATTEMPT_JOB_ID_PREFIX}${jobId}`].map((id) => ({
    job_id: id, result: 'AUTH_RESULT_UNKNOWN', submitted: 'UNKNOWN', retry_after_until: null, result_recorded_at: RESULT_AT,
    credential_revision: CREDENTIAL_REVISION,
  }));

  it('closes the attempt of a job as AUTH_RESULT_UNKNOWN with an unknown sending in two rows, and holds once', () => {
    const jobId = startedAttempt();
    expect(closePendingAutoLoginAttempt(database, jobId, RESULT_AT)).toEqual({ recorded: true, held: true });
    expect(attemptsOf()).toEqual(unknownRowsOf(jobId));
    expect(rawQuery('SELECT DISTINCT started_at FROM auto_login_attempts')).toEqual([{ started_at: CREATED_AT }]);
    expect(holdsOf()).toEqual([{ reason: 'AUTH_RESULT_UNKNOWN', cleared_at: null }]);
    expect(readAutoLoginLimitInputs(database, PROFILE_ID, NOW).attempts).toHaveLength(2);
    expect(closePendingAutoLoginAttempt(database, jobId, RESULT_AT)).toEqual({ recorded: false, held: false });
    expect(attemptsOf()).toHaveLength(2);
  });

  it('closes, at start up, the attempts whose job is no longer active, and keeps the attempt of an active job', () => {
    const ended = startedAttempt();
    const otherEnded = startedAttempt({ profileId: OTHER_PROFILE_ID });
    const recorded = startedAttempt();
    recordAutoLoginResult(database, result(recorded, { result: 'SUCCEEDED' }));
    const active = startedAttempt({}, false);
    expect(closeOrphanedAutoLoginAttempts(database, RESULT_AT)).toBe(2);
    expect(attemptsOf().map((row) => [row['job_id'], row['result']])).toEqual([
      [ended, 'AUTH_RESULT_UNKNOWN'], [recorded, 'SUCCEEDED'], [active, null], [`${RESENT_ATTEMPT_JOB_ID_PREFIX}${ended}`, 'AUTH_RESULT_UNKNOWN'],
    ]);
    expect(attemptsOf(OTHER_PROFILE_ID)).toEqual(unknownRowsOf(otherEnded));
    expect(holdsOf()).toEqual([{ reason: 'AUTH_RESULT_UNKNOWN', cleared_at: null }]);
    expect(holdsOf(OTHER_PROFILE_ID)).toEqual([{ reason: 'AUTH_RESULT_UNKNOWN', cleared_at: null }]);
    expect(closeOrphanedAutoLoginAttempts(database, RESULT_AT)).toBe(0);
    expect(attemptsOf()).toHaveLength(4);
  });
});

describe('clearing the hold and recording credential changes (design 4.2)', () => {
  it('clears the hold with the time and a HOLD_CLEARED event, and does nothing when not held', () => {
    expect(clearAutoLoginHold(database, PROFILE_ID, RESULT_AT)).toBe(false);
    expect(readRecentCredentialEvents(database, PROFILE_ID)).toEqual([]);
    const jobId = startedAttempt();
    recordAutoLoginResult(database, result(jobId));
    expect(clearAutoLoginHold(database, PROFILE_ID, stampAt(-MINUTE_MS), CREDENTIAL_REVISION)).toBe(true);
    expect(holdsOf()).toEqual([{ reason: 'ACCOUNT_LOCKED', cleared_at: stampAt(-MINUTE_MS) }]);
    expect(readAutoLoginHold(database, PROFILE_ID)).toBeNull();
    expect(readRecentCredentialEvents(database, PROFILE_ID)).toEqual([
      expect.objectContaining({ profileId: PROFILE_ID, kind: 'HOLD_CLEARED', recordedAt: stampAt(-MINUTE_MS), credentialRevision: CREDENTIAL_REVISION }),
    ]);
    expect(clearAutoLoginHold(database, PROFILE_ID, RESULT_AT)).toBe(false);
    // 解いた後は、新しい失敗で、また止められる。
    const next = startedAttempt();
    expect(recordAutoLoginResult(database, result(next, { result: 'AUTH_RESULT_UNKNOWN', submitted: 'UNKNOWN' }))).toEqual({ recorded: true, held: true });
  });

  it('records credential changes, newest first, and can clear the hold in the same transaction', () => {
    expect(recordCredentialEvent(database, { profileId: PROFILE_ID, kind: 'CREATED', at: stampAt(-3 * MINUTE_MS), credentialRevision: 1 }))
      .toEqual({ holdCleared: false });
    const jobId = startedAttempt();
    recordAutoLoginResult(database, result(jobId));
    expect(recordCredentialEvent(database, { profileId: PROFILE_ID, kind: 'PASSWORD_CHANGED', at: stampAt(-MINUTE_MS), credentialRevision: 2 }))
      .toEqual({ holdCleared: false });
    expect(readAutoLoginHold(database, PROFILE_ID)).not.toBeNull();
    expect(recordCredentialEvent(
      database,
      { profileId: PROFILE_ID, kind: 'USERNAME_CHANGED', at: stampAt(0), credentialRevision: 3 },
      { clearHold: true },
    )).toEqual({ holdCleared: true });
    expect(readAutoLoginHold(database, PROFILE_ID)).toBeNull();
    // 変更を書いてから解除を書く（同じ時刻。新しい順では解除が先）。
    expect(readRecentCredentialEvents(database, PROFILE_ID).map((event) => event.kind))
      .toEqual(['HOLD_CLEARED', 'USERNAME_CHANGED', 'PASSWORD_CHANGED', 'CREATED']);
    expect(readRecentCredentialEvents(database, PROFILE_ID, 2).map((event) => event.kind)).toEqual(['HOLD_CLEARED', 'USERNAME_CHANGED']);
    expect(readRecentCredentialEvents(database, PROFILE_ID)[0]).toEqual(expect.objectContaining({ recordedAt: stampAt(0), credentialRevision: 3 }));
    expect(recordCredentialEvent(database, { profileId: PROFILE_ID, kind: 'DELETED', at: stampAt(0), credentialRevision: null }))
      .toEqual({ holdCleared: false });
    expect(() => recordCredentialEvent(database, { profileId: PROFILE_ID, kind: 'HOLD_CLEARED' as never, at: stampAt(0), credentialRevision: null }))
      .toThrow(RangeError);
    expect(readRecentCredentialEvents(database, OTHER_PROFILE_ID)).toEqual([]);
  });
});

describe('reading the inputs of the limits (design 4.5)', () => {
  it('reads the hold and the attempts of the window or with a Retry-After not yet passed, and the decision follows them', () => {
    const old = startedAttempt({ createdAt: stampAt(-AUTO_LOGIN_DAILY_WINDOW_MS - MINUTE_MS) });
    const oldLimited = startedAttempt({ createdAt: stampAt(-AUTO_LOGIN_DAILY_WINDOW_MS - MINUTE_MS) });
    recordAutoLoginResult(database, result(oldLimited, { result: 'RATE_LIMITED', retryAfterUntil: stampAt(MINUTE_MS) }));
    const recent = startedAttempt({ createdAt: stampAt(-2 * MINUTE_MS) });
    startedAttempt({ profileId: OTHER_PROFILE_ID, createdAt: stampAt(-MINUTE_MS) });
    const inputs = readAutoLoginLimitInputs(database, PROFILE_ID, NOW);
    expect(inputs.attempts.map((attempt) => attempt.jobId).sort()).toEqual([oldLimited, recent].sort());
    expect(inputs.attempts.map((attempt) => attempt.jobId)).not.toContain(old);
    expect(inputs.hold).toEqual(expect.objectContaining({ profileId: PROFILE_ID, reason: 'RATE_LIMITED', clearedAt: null }));
    expect(decideAutoLoginStart({ ...inputs, now: NOW })).toEqual({ ok: false, reason: 'AUTO_LOGIN_HELD', nextAllowedAt: null });
    clearAutoLoginHold(database, PROFILE_ID, stampAt(0));
    const cleared = readAutoLoginLimitInputs(database, PROFILE_ID, NOW);
    expect(cleared.hold).toBeNull();
    expect(decideAutoLoginStart({ ...cleared, now: NOW }))
      .toEqual({ ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED', nextAllowedAt: stampAt(3 * MINUTE_MS) });
    expect(Object.isFrozen(cleared.attempts)).toBe(true);
  });
});

describe('the records never hold credential values (design 4.7)', () => {
  const USERNAME_MARKER = `bsuser${Date.now().toString(36)}marker`;
  const PASSWORD_MARKER = `bspass${Date.now().toString(36)}marker`;
  const leakedIn = (text: string): readonly string[] =>
    [USERNAME_MARKER, PASSWORD_MARKER].filter((marker) => text.includes(marker) || text.includes(Buffer.from(marker, 'utf16le').toString('latin1')));
  const databaseBytes = (path: string): string =>
    [path, `${path}-wal`].filter((file) => existsSync(file)).map((file) => readFileSync(file).toString('latin1')).join('\n');

  it('has no input for values in the types of the record parts', () => {
    // 値の口になりうる項目の名前が、どの入力の型にもない（項目ごとに確かめる）。
    type HasKey<Shape, Key extends string> = Key extends keyof Shape ? true : false;
    type Inputs = AutoLoginResultInput | CredentialEventInput | NewAuditJob | NonNullable<NewAuditJob['autoLoginAttempt']>;
    expectTypeOf<HasKey<AutoLoginResultInput, 'username'> | HasKey<AutoLoginResultInput, 'password'>>().toEqualTypeOf<false>();
    expectTypeOf<HasKey<CredentialEventInput, 'username'> | HasKey<CredentialEventInput, 'password'>>().toEqualTypeOf<false>();
    expectTypeOf<HasKey<NewAuditJob, 'username'> | HasKey<NewAuditJob, 'password'>>().toEqualTypeOf<false>();
    expectTypeOf<HasKey<NonNullable<NewAuditJob['autoLoginAttempt']>, 'username'>>().toEqualTypeOf<false>();
    expectTypeOf<HasKey<NonNullable<NewAuditJob['autoLoginAttempt']>, 'password'>>().toEqualTypeOf<false>();
    // 入力の項目は、ID・閉じた一覧の値・時刻・改訂の番号だけ（文字列の自由な項目を足したら、ここで気づく）。T26d-2: フォームの確かめの理由の
    // コード（閉じた一覧の値）を足した。DEF-099 fix round 1: 送った後の応答の印（真偽）を足した。
    expectTypeOf<keyof AutoLoginResultInput>().toEqualTypeOf<
      'jobId' | 'result' | 'submitted' | 'retryAfterUntil' | 'formInvalidReason' | 'at' | 'responseAfterSubmission'
    >();
    expectTypeOf<keyof CredentialEventInput>().toEqualTypeOf<'profileId' | 'kind' | 'at' | 'credentialRevision'>();
    expectTypeOf<keyof NonNullable<NewAuditJob['autoLoginAttempt']>>().toEqualTypeOf<'credentialRevision'>();
    expectTypeOf<Inputs>().not.toBeAny();
  });

  it('writes no marker to the database file or the WAL even when extra properties carry one', () => {
    const extra = { username: USERNAME_MARKER, password: PASSWORD_MARKER };
    const job = { ...newJob(), ...extra, autoLoginAttempt: { credentialRevision: CREDENTIAL_REVISION, ...extra } } as NewAuditJob;
    expect(createStartingJob(database, job, () => null)).toEqual({ ok: true });
    recordEnded(database, job.jobId, { state: 'FAILED', reason: 'INVALID_CREDENTIALS', exitCode: null, at: ENDED_AT });
    recordAutoLoginResult(database, { ...result(job.jobId, { result: 'INVALID_CREDENTIALS' }), ...extra } as AutoLoginResultInput);
    recordCredentialEvent(database, { profileId: PROFILE_ID, kind: 'BOTH_CHANGED', at: RESULT_AT, credentialRevision: 3, ...extra } as CredentialEventInput, { clearHold: true });
    const pending = startedAttempt({ ...extra } as Partial<NewAuditJob>);
    closePendingAutoLoginAttempt(database, pending, RESULT_AT);
    clearAutoLoginHold(database, PROFILE_ID, RESULT_AT);
    const path = resolveControlDatabasePath(workDirectory);
    expect(existsSync(`${path}-wal`)).toBe(true);
    expect(leakedIn(databaseBytes(path))).toEqual([]);
    expect(leakedIn(JSON.stringify([readAutoLoginLimitInputs(database, PROFILE_ID, NOW), readRecentCredentialEvents(database, PROFILE_ID)]))).toEqual([]);

    // 検出の確かめ: 同じ読み方で、別のファイルに書いた目印は見つかる。
    const controlPath = join(workDirectory, 'control.sqlite');
    const control = new DatabaseSync(controlPath);
    try {
      control.exec('PRAGMA journal_mode = WAL');
      control.exec('CREATE TABLE t (v TEXT) STRICT');
      control.prepare('INSERT INTO t (v) VALUES (?)').run(USERNAME_MARKER);
      expect(leakedIn(databaseBytes(controlPath))).toEqual([USERNAME_MARKER]);
    } finally {
      control.close();
    }
  });
});

// DEF-099 fix round 1（Task 30 の設計書 11 章の DEF-099 の行。ユーザーの判断「応答がない回は 2 回と数える」）: ログインの POST を送った後に応答が
// なかった回（接続の断・応答なし。Chromium がログインの POST を自動で送り直しうる）は、試しの行を 2 行書く（2 行目も送信 `YES`、同じ結果、同じ
// 試し始めた時刻）。上限の判定（`decideAutoLoginStart`）は変えずに 2 回と数える。応答があった回（5xx を含む）は、今どおり 1 行。
describe('DEF-099: an unanswered login submission counts as two attempts', () => {
  it('writes a second attempt row with the same result for an unanswered submission, and one row for an answered one', () => {
    const unanswered = startedAttempt();
    expect(recordAutoLoginResult(database, result(unanswered, { result: 'AUTH_RESULT_UNKNOWN', responseAfterSubmission: false })))
      .toEqual({ recorded: true, held: true });
    const answered = startedAttempt();
    recordAutoLoginResult(database, result(answered, { result: 'AUTH_RESULT_UNKNOWN', responseAfterSubmission: true }));
    const plain = startedAttempt();
    recordAutoLoginResult(database, result(plain, { result: 'AUTH_RESULT_UNKNOWN' }));
    const rows = rawQuery<Record<string, unknown>>(
      'SELECT job_id, started_at, result, submitted, credential_revision FROM auto_login_attempts WHERE profile_id = ? ORDER BY attempt_id', PROFILE_ID);
    expect(rows).toHaveLength(4);
    expect(rows.filter(({ job_id: jobId }) => jobId === unanswered)).toHaveLength(1);
    expect(rows.filter(({ job_id: jobId }) => jobId === answered || jobId === plain)).toHaveLength(2);
    const second = rows.find(({ job_id: jobId }) => ![unanswered, answered, plain].includes(String(jobId)));
    expect(second).toMatchObject({ started_at: CREATED_AT, result: 'AUTH_RESULT_UNKNOWN', submitted: 'YES', credential_revision: CREDENTIAL_REVISION });
    // 2 行目は、ジョブの値の試しにならない（どのジョブの id にもならない形）。
    expect(String(second?.['job_id'])).not.toMatch(/^[a-z0-9]/u);
    expect(readAutoLoginLimitInputs(database, PROFILE_ID, NOW).attempts).toHaveLength(4);
  });

  it('reaches the daily limit sooner: five unanswered submissions count as ten', () => {
    for (let index = 0; index < 5; index += 1) {
      recordAutoLoginResult(database, result(startedAttempt(), { result: 'AUTH_RESULT_UNKNOWN', responseAfterSubmission: false }));
    }
    const inputs = readAutoLoginLimitInputs(database, PROFILE_ID, NOW);
    expect(inputs.attempts).toHaveLength(10);
    expect(decideAutoLoginStart({ attempts: inputs.attempts, hold: null, now: NOW }))
      .toMatchObject({ ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED', nextAllowedAt: stampAt(-10 * MINUTE_MS + AUTO_LOGIN_DAILY_WINDOW_MS) });
  });

  it('counts five answered submissions as five (the limit is not reached)', () => {
    for (let index = 0; index < 5; index += 1) {
      recordAutoLoginResult(database, result(startedAttempt(), { result: 'AUTH_RESULT_UNKNOWN', responseAfterSubmission: true }));
    }
    const inputs = readAutoLoginLimitInputs(database, PROFILE_ID, NOW);
    expect(inputs.attempts).toHaveLength(5);
    expect(decideAutoLoginStart({ attempts: inputs.attempts, hold: null, now: NOW })).toEqual({ ok: true });
  });

  it('rejects the mark for a result that was not sent', () => {
    const jobId = startedAttempt();
    expect(() => recordAutoLoginResult(database, result(jobId, { result: 'CREDENTIAL_CHANGED', submitted: 'NO', responseAfterSubmission: false })))
      .toThrow(RangeError);
    expect(() => recordAutoLoginResult(database, result(jobId, { result: 'SUCCEEDED', submitted: 'YES', responseAfterSubmission: false })))
      .toThrow(RangeError);
  });
});

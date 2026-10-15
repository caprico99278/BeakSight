// T27c（Task 27 の設計書 4.5、4.6、10 章の 4）: READ の確かめの定義と結果の記録と読み出し（`src/control/job/read-check-store.ts`）の結合テスト。
// - 定義の作成（版 1）・変更（版を上げる。画面が読んだ版と違えば拒む）・取り消し（消さずに取り消した時刻を書く）。
// - 1 つのプロファイルの、取り消していない定義の数の上限（`MAX_READ_CHECK_DEFINITIONS_PER_PROFILE`。1 回のジョブの READ の上限と同じ定数）。
// - 保存の前の確かめ直し（形と秘密に見える名前。候補の確かめは呼び出し側が `validateReadCheckDefinition` で行う）。
// - 結果の記録（ジョブ・定義・定義の版・閉じた一覧の結果・時刻）と、最近の結果の読み出し。
// - T27e（T27c の申し送り 11）: 定義の版が今の版と違う結果（実行の間に定義が変わった）は書かない。1 回のジョブの結果をまとめて書く口
//   （`recordReadCheckResults`）は、その結果だけを書かずに数え、ほかは 1 つのトランザクションで書く。
// - 秘密: READ の送る値は、設計どおり平文で保存される（テスト環境のテスト用の値だけ。設計書 4.5、10 章の 4）。そのため、送る値は目印の検査の
//   対象から外す。送る値の外の口（余分な項目）に入れた目印は、管理データのファイルと WAL に出ない。
// 一時のフォルダだけを使い、終わったら消す。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import {
  cancelReadCheck,
  createReadCheck,
  listReadChecks,
  listReadChecksIn,
  readReadCheck,
  readRecentReadCheckResults,
  recordReadCheckResult,
  recordReadCheckResults,
  updateReadCheck,
  type NewReadCheck,
  type ReadCheckResultInput,
} from '../../src/control/job/read-check-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { withReadTransaction } from '../../src/control/store/transaction.js';
import { createProfile, updateProfile } from '../../src/control/store/profile-store.js';
import {
  MAX_READ_CHECK_DEFINITIONS_PER_PROFILE,
  READ_CHECK_RESULTS,
  type ReadCheckDefinition,
} from '../../src/discovery/read-check-contracts.js';
import { publicProfile, resolveTestContext, testAuthProfile, testWriteProfile } from './control-profile-fixtures.js';

const PROFILE_ID = 'example-read-check';
const OTHER_PROFILE_ID = 'example-read-check-other';
const CREATED_AT = '20261011010000';
const UPDATED_AT = '20261011020000';
const RESULT_AT = '20261011030000';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;

let workDirectory = '';
let database: ControlDatabase;

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-read-check-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  // T28b fix round 1: 定義を作れるのは、READ の確かめを許すモードのプロファイルだけになったので、認証つきの読み取りの監査のプロファイルを使う
  // （公開の監査のプロファイルの拒否は、下の T28b の場面で確かめる）。
  for (const profileId of [PROFILE_ID, OTHER_PROFILE_ID]) {
    expect(createProfile(database, testAuthProfile(profileId, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
  }
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

const DEFINITION: ReadCheckDefinition = {
  targetIdentityDigest: DIGEST,
  parameters: { q: 'example' },
  expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }],
};

const CHANGED_DEFINITION: ReadCheckDefinition = {
  targetIdentityDigest: OTHER_DIGEST,
  parameters: {},
  expectations: [{ kind: 'TEXT_CONTAINS', text: '一覧' }, { kind: 'DETAIL_FIELD_EQUALS', field: '名前', value: 'example' }],
};

const newReadCheck = (readCheckId: string, overrides: Partial<NewReadCheck> = {}): NewReadCheck =>
  ({ readCheckId, profileId: PROFILE_ID, definition: DEFINITION, at: CREATED_AT, ...overrides });

const create = (readCheckId: string, overrides: Partial<NewReadCheck> = {}) => createReadCheck(database, newReadCheck(readCheckId, overrides));

describe('READ check definitions (T27c)', () => {
  it('creates a definition at revision 1 and reads it back', () => {
    const created = create('read-1');
    expect(created).toEqual({
      ok: true,
      readCheck: {
        readCheckId: 'read-1', profileId: PROFILE_ID, definition: DEFINITION, revision: 1, createdAt: CREATED_AT, updatedAt: CREATED_AT, canceledAt: null,
      },
    });
    expect(created.ok && Object.isFrozen(created.readCheck.definition.parameters)).toBe(true);
    expect(readReadCheck(database, 'read-1')).toEqual(created.ok ? created.readCheck : null);
    expect(readReadCheck(database, 'read-missing')).toBeNull();
    expect(listReadChecks(database, PROFILE_ID).map(({ readCheckId }) => readCheckId)).toEqual(['read-1']);
    expect(listReadChecks(database, OTHER_PROFILE_ID)).toEqual([]);
  });

  it('changes a definition by raising the revision, and rejects a stale revision', () => {
    create('read-1');
    const changed = updateReadCheck(database, { readCheckId: 'read-1', expectedRevision: 1, definition: CHANGED_DEFINITION, at: UPDATED_AT });
    expect(changed).toMatchObject({ ok: true, readCheck: { revision: 2, definition: CHANGED_DEFINITION, createdAt: CREATED_AT, updatedAt: UPDATED_AT } });
    expect(updateReadCheck(database, { readCheckId: 'read-1', expectedRevision: 1, definition: DEFINITION, at: UPDATED_AT }))
      .toEqual({ ok: false, reason: 'READ_CHECK_REVISION_CONFLICT' });
    expect(updateReadCheck(database, { readCheckId: 'read-missing', expectedRevision: 1, definition: DEFINITION, at: UPDATED_AT }))
      .toEqual({ ok: false, reason: 'READ_CHECK_NOT_FOUND' });
    expect(readReadCheck(database, 'read-1')).toMatchObject({ revision: 2, definition: CHANGED_DEFINITION });
  });

  it('cancels a definition without deleting it, and does not change or cancel it again', () => {
    create('read-1');
    expect(cancelReadCheck(database, { readCheckId: 'read-1', expectedRevision: 1, at: UPDATED_AT }))
      .toMatchObject({ ok: true, readCheck: { revision: 1, canceledAt: UPDATED_AT, updatedAt: UPDATED_AT } });
    expect(cancelReadCheck(database, { readCheckId: 'read-1', expectedRevision: 1, at: UPDATED_AT })).toEqual({ ok: false, reason: 'READ_CHECK_CANCELED' });
    expect(updateReadCheck(database, { readCheckId: 'read-1', expectedRevision: 1, definition: DEFINITION, at: UPDATED_AT }))
      .toEqual({ ok: false, reason: 'READ_CHECK_CANCELED' });
    expect(cancelReadCheck(database, { readCheckId: 'read-missing', expectedRevision: 1, at: UPDATED_AT })).toEqual({ ok: false, reason: 'READ_CHECK_NOT_FOUND' });
    expect(listReadChecks(database, PROFILE_ID)).toEqual([]);
    expect(listReadChecks(database, PROFILE_ID, { includeCanceled: true }).map(({ readCheckId, canceledAt }) => [readCheckId, canceledAt]))
      .toEqual([['read-1', UPDATED_AT]]);
  });

  it('limits the definitions of one profile that are not canceled (the same constant as the READ of one job)', () => {
    for (let index = 0; index < MAX_READ_CHECK_DEFINITIONS_PER_PROFILE; index += 1) {
      expect(create(`read-${index}`).ok).toBe(true);
    }
    expect(create('read-over')).toEqual({ ok: false, reason: 'READ_CHECK_LIMIT_EXCEEDED' });
    // ほかのプロファイルは数えない。取り消すと、また作れる。
    expect(create('read-other', { profileId: OTHER_PROFILE_ID }).ok).toBe(true);
    expect(cancelReadCheck(database, { readCheckId: 'read-0', expectedRevision: 1, at: UPDATED_AT }).ok).toBe(true);
    expect(create('read-over').ok).toBe(true);
    expect(readReadCheck(database, 'read-over')).not.toBeNull();
  });

  it('rejects a missing profile, and the caller errors before writing', () => {
    expect(create('read-1', { profileId: 'missing-profile' })).toEqual({ ok: false, reason: 'READ_CHECK_PROFILE_NOT_FOUND' });
    create('read-1');
    for (const [name, input] of [
      ['the same id twice', newReadCheck('read-1')],
      ['an id of another shape', newReadCheck('Read-2')],
      ['a time that is not 14 digits', newReadCheck('read-2', { at: '2026-10-11' })],
      ['a secret-like parameter name', newReadCheck('read-2', { definition: { ...DEFINITION, parameters: { token: 'x' } } })],
      ['an expectation outside the closed list', newReadCheck('read-2', {
        definition: { ...DEFINITION, expectations: [{ kind: 'STATUS_EQUALS' } as unknown as ReadCheckDefinition['expectations'][number]] },
      })],
    ] as const) {
      expect(() => createReadCheck(database, input), name).toThrow(RangeError);
    }
    expect(() => updateReadCheck(database, { readCheckId: 'read-1', expectedRevision: 1, definition: DEFINITION, at: '20261010000000' }))
      .toThrow(RangeError);
    expect(listReadChecks(database, PROFILE_ID, { includeCanceled: true })).toHaveLength(1);
  });
});

// T28b fix round 1（Task 28 の設計書 4.5。T28b の発見事項 3）: 管理の側の保存も、READ の確かめを許すモードか（`execution-policy.ts` の
// `READ_CHECK` の行）を、同じトランザクションの中で確かめる。許さないモード（公開の監査）では作らない・変えない（`READ_CHECK_PROFILE_NOT_ELIGIBLE`）。
// 取り消し（削除）は、今までどおりできる。書き込みのモードのプロファイルでは作れる。
describe('READ check definitions by the mode of the profile (T28b fix round 1)', () => {
  const PUBLIC_PROFILE_ID = 'example-read-check-public';
  const WRITE_PROFILE_ID = 'example-read-check-write';

  it('does not create a definition for a public profile, and creates one for a write mode profile', () => {
    expect(createProfile(database, publicProfile(PUBLIC_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
    expect(createProfile(database, testWriteProfile(WRITE_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
    expect(create('read-public', { profileId: PUBLIC_PROFILE_ID })).toEqual({ ok: false, reason: 'READ_CHECK_PROFILE_NOT_ELIGIBLE' });
    expect(listReadChecks(database, PUBLIC_PROFILE_ID, { includeCanceled: true })).toEqual([]);
    expect(create('read-write', { profileId: WRITE_PROFILE_ID })).toMatchObject({ ok: true, readCheck: { profileId: WRITE_PROFILE_ID, revision: 1 } });
  });

  it('does not change a definition after its profile became a public profile, and still cancels it', () => {
    create('read-1');
    expect(updateProfile(database, { profile: publicProfile(PROFILE_ID, MIN_PROFILE_REVISION + 1), expectedRevision: MIN_PROFILE_REVISION }, {
      resolveContext: resolveTestContext,
    }).ok).toBe(true);
    expect(updateReadCheck(database, { readCheckId: 'read-1', expectedRevision: 1, definition: CHANGED_DEFINITION, at: UPDATED_AT }))
      .toEqual({ ok: false, reason: 'READ_CHECK_PROFILE_NOT_ELIGIBLE' });
    expect(readReadCheck(database, 'read-1')).toMatchObject({ revision: 1, definition: DEFINITION });
    expect(cancelReadCheck(database, { readCheckId: 'read-1', expectedRevision: 1, at: UPDATED_AT })).toMatchObject({ ok: true });
  });
});

describe('READ check results (T27c)', () => {
  const resultOf = (input: Partial<ReadCheckResultInput> = {}): ReadCheckResultInput =>
    ({ jobId: 'job-1', readCheckId: 'read-1', readCheckRevision: 1, result: 'MATCHED', at: RESULT_AT, ...input });

  it('records the result of every closed value and reads the recent results of a profile (newest first)', () => {
    create('read-1');
    create('read-2');
    create('read-other', { profileId: OTHER_PROFILE_ID });
    READ_CHECK_RESULTS.forEach((result, index) => {
      recordReadCheckResult(database, resultOf({ jobId: `job-${index}`, result, at: `2026101103000${index}` }));
    });
    recordReadCheckResult(database, resultOf({ jobId: 'job-0', readCheckId: 'read-2', result: 'NOT_MATCHED' }));
    recordReadCheckResult(database, resultOf({ jobId: 'job-0', readCheckId: 'read-other' }));
    const recent = readRecentReadCheckResults(database, PROFILE_ID);
    expect(recent).toHaveLength(READ_CHECK_RESULTS.length + 1);
    expect(recent[0]).toEqual({ jobId: `job-${READ_CHECK_RESULTS.length - 1}`, readCheckId: 'read-1', readCheckRevision: 1, result: 'READ_CANDIDATE_NOT_READ', recordedAt: `2026101103000${READ_CHECK_RESULTS.length - 1}` });
    expect(readRecentReadCheckResults(database, PROFILE_ID, 2)).toHaveLength(2);
    expect(readRecentReadCheckResults(database, OTHER_PROFILE_ID).map(({ readCheckId }) => readCheckId)).toEqual(['read-other']);
  });

  it('rejects the caller errors and an unknown definition', () => {
    create('read-1');
    recordReadCheckResult(database, resultOf());
    for (const [name, input] of [
      ['the same job and definition twice', resultOf()],
      ['an unknown result', resultOf({ jobId: 'job-2', result: 'PASSED' as ReadCheckResultInput['result'] })],
      ['a revision newer than the definition', resultOf({ jobId: 'job-2', readCheckRevision: 2 })],
      ['a revision of 0', resultOf({ jobId: 'job-2', readCheckRevision: 0 })],
      ['a job id of another shape', resultOf({ jobId: 'JOB-2' })],
      ['a time that is not 14 digits', resultOf({ jobId: 'job-2', at: 'now' })],
      ['an unknown definition', resultOf({ jobId: 'job-2', readCheckId: 'read-missing' })],
    ] as const) {
      expect(() => recordReadCheckResult(database, input), name).toThrow();
    }
    expect(readRecentReadCheckResults(database, PROFILE_ID)).toHaveLength(1);
  });

  it('rejects a result whose definition revision is older than the current one (the definition changed during the job, T27e)', () => {
    create('read-1');
    expect(updateReadCheck(database, { readCheckId: 'read-1', expectedRevision: 1, definition: CHANGED_DEFINITION, at: UPDATED_AT }).ok).toBe(true);
    expect(() => recordReadCheckResult(database, resultOf({ readCheckRevision: 1, at: RESULT_AT }))).toThrow(RangeError);
    recordReadCheckResult(database, resultOf({ readCheckRevision: 2, at: RESULT_AT }));
    expect(readRecentReadCheckResults(database, PROFILE_ID).map(({ readCheckRevision }) => readCheckRevision)).toEqual([2]);
  });

  it('records the results of one job in one transaction, and skips (counts) only the results of a stale revision (T27e)', () => {
    create('read-1');
    create('read-2');
    create('read-3');
    expect(updateReadCheck(database, { readCheckId: 'read-2', expectedRevision: 1, definition: CHANGED_DEFINITION, at: UPDATED_AT }).ok).toBe(true);
    const recording = recordReadCheckResults(database, [
      resultOf({ readCheckId: 'read-1' }),
      resultOf({ readCheckId: 'read-2', readCheckRevision: 1 }),
      resultOf({ readCheckId: 'read-3', result: 'UNDETERMINED' }),
      resultOf({ readCheckId: 'read-missing' }),
    ]);
    expect(recording).toEqual({ recorded: ['read-1', 'read-3'], rejectedStale: ['read-2', 'read-missing'] });
    expect(readRecentReadCheckResults(database, PROFILE_ID).map(({ readCheckId, result }) => [readCheckId, result]).sort())
      .toEqual([['read-1', 'MATCHED'], ['read-3', 'UNDETERMINED']]);
    expect(recordReadCheckResults(database, [])).toEqual({ recorded: [], rejectedStale: [] });
  });

  it('writes nothing of the job when one result of it is a caller error (T27e)', () => {
    create('read-1');
    create('read-2');
    expect(() => recordReadCheckResults(database, [resultOf({ readCheckId: 'read-1' }), resultOf({ readCheckId: 'read-2', at: 'now' })])).toThrow(RangeError);
    recordReadCheckResult(database, resultOf({ jobId: 'job-9', readCheckId: 'read-1' }));
    expect(() => recordReadCheckResults(database, [resultOf({ readCheckId: 'read-2' }), resultOf({ jobId: 'job-9', readCheckId: 'read-1' })])).toThrow();
    expect(readRecentReadCheckResults(database, PROFILE_ID).map(({ jobId, readCheckId }) => `${jobId} ${readCheckId}`)).toEqual(['job-9 read-1']);
  });
});

describe('the READ check records and secrets (design 4.5, 4.8)', () => {
  const MARKER = `bsreadcheck${Date.now().toString(36)}marker`;
  const leakedIn = (text: string): boolean => text.includes(MARKER) || text.includes(Buffer.from(MARKER, 'utf16le').toString('latin1'));
  const databaseBytes = (path: string): string =>
    [path, `${path}-wal`].filter((file) => existsSync(file)).map((file) => readFileSync(file).toString('latin1')).join('\n');

  it('has no input for credentials, tokens or labels in the types', () => {
    expectTypeOf<keyof NewReadCheck>().toEqualTypeOf<'readCheckId' | 'profileId' | 'definition' | 'at'>();
    expectTypeOf<keyof ReadCheckResultInput>().toEqualTypeOf<'jobId' | 'readCheckId' | 'readCheckRevision' | 'result' | 'at'>();
    expectTypeOf<keyof ReadCheckDefinition>().toEqualTypeOf<'targetIdentityDigest' | 'parameters' | 'expectations'>();
  });

  it('stores the values to send in plain text by design, and writes no marker given through any other property', () => {
    // 送る値は、設計どおり平文で保存される（設計書 4.5、10 章の 4。テスト環境のテスト用の値だけ）。このため、送る値は目印の検査の対象から外す。
    const plainValue = `plain${Date.now().toString(36)}value`;
    const extra = { label: MARKER, token: MARKER, password: MARKER };
    const definition = { ...DEFINITION, parameters: { q: plainValue }, ...extra } as ReadCheckDefinition;
    expect(createReadCheck(database, { ...newReadCheck('read-1', { definition }), ...extra } as NewReadCheck).ok).toBe(true);
    recordReadCheckResult(database, { jobId: 'job-1', readCheckId: 'read-1', readCheckRevision: 1, result: 'MATCHED', at: RESULT_AT, ...extra } as ReadCheckResultInput);
    const path = resolveControlDatabasePath(workDirectory);
    expect(existsSync(`${path}-wal`)).toBe(true);
    const bytes = databaseBytes(path);
    expect(bytes.includes(plainValue)).toBe(true);
    expect(leakedIn(bytes)).toBe(false);
    expect(leakedIn(JSON.stringify([listReadChecks(database, PROFILE_ID), readRecentReadCheckResults(database, PROFILE_ID)]))).toBe(false);
  });
});

// CCX-17（CC-078 の前半）: READ の定義の owner が公開する、トランザクションの中で使える読み出し。
describe('CCX-17: the reader of the READ checks inside a transaction', () => {
  it('reads the same list (and order) as listReadChecks inside the caller transaction, with and without the canceled ones', () => {
    expect(create('read-2').ok && create('read-1').ok).toBe(true);
    expect(cancelReadCheck(database, { readCheckId: 'read-2', expectedRevision: 1, at: UPDATED_AT }).ok).toBe(true);
    for (const options of [{}, { includeCanceled: true }, { includeCanceled: false }]) {
      expect(withReadTransaction(database, (connection) => listReadChecksIn(connection, PROFILE_ID, options)))
        .toEqual(listReadChecks(database, PROFILE_ID, options));
    }
    expect(withReadTransaction(database, (connection) => listReadChecksIn(connection, PROFILE_ID, { includeCanceled: true }))
      .map(({ readCheckId }) => readCheckId).sort()).toEqual(['read-1', 'read-2']);
  });
});

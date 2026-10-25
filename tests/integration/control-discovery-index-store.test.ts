// T27c（Task 27 の設計書 4.4 の「ドリフト」、4.6、4.8）: 候補の索引の記録と読み出し（`src/control/job/discovery-index-store.ts`）の結合テスト。
// - 発見のジョブの結果を、1 つのトランザクションで、新しい・変わった・まだある・消えたが分かる形で書く。消えた候補は消さない（最後に見たジョブで
//   分かる）。変わった（規則の digest・分類・理由・状態の欄の印が前と違う）候補は、最後に変わったジョブで分かる。
// - 読み出し: プロファイルの候補の一覧と、最後の発見のジョブに対するドリフト。
// - 秘密: 記録の入力の型に、値・トークン・label・ボタンの文言・欄の名前の口がない。候補に目印を入れても、管理データのファイルと WAL に出ない。
// 一時のフォルダだけを使い、終わったら消す。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import {
  DISCOVERY_INDEX_DRIFTS,
  MAX_INDEX_SHAPE_DIGESTS,
  discoveryIndexEntryOf,
  noDiscoveryJobRecordedAfterIn,
  readDiscoveryIndex,
  readDiscoveryIndexIn,
  recordDiscoveryCandidates,
  type DiscoveryIndexEntry,
  type DiscoveryIndexUpdate,
} from '../../src/control/job/discovery-index-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { withReadTransaction } from '../../src/control/store/transaction.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { ControlStoreError } from '../../src/control/store/store-errors.js';
import { notObservedSubmissionProbeOf, type SubmissionProbeRecord } from '../../src/discovery/submission-probe-contracts.js';
import type { DiscoveredCandidate, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import { MAX_DISCOVERY_READ_PAGE_PATHS } from '../../src/discovery/discovery-result.js';
import { computeCandidateDigests, recordIdSegmentPairsOf, templatedIdentityDigestOf, templatedIdentityDigestsOf } from '../../src/discovery/fingerprint.js';
import { usableRecordIdOf } from '../../src/control/actions/action-outcome.js';
import { SAMPLE_ALLOWED_ORIGINS, sampleAction, sampleButton, sampleField, sampleForm } from '../unit/discovery-candidate-samples.js';
import { publicProfile, resolveTestContext } from './control-profile-fixtures.js';

const PROFILE_ID = 'example-discovery';
const OTHER_PROFILE_ID = 'example-discovery-other';
const FIRST_AT = '20261011010000';
const SECOND_AT = '20261011020000';
const THIRD_AT = '20261011030000';

let workDirectory = '';
let database: ControlDatabase;

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-discovery-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  for (const profileId of [PROFILE_ID, OTHER_PROFILE_ID]) {
    expect(createProfile(database, publicProfile(profileId, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
  }
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

const candidateOf = (discovered: DiscoveredCandidate): DiscoveryCandidate => ({
  ...discovered,
  ...classifyCandidate(discovered, { allowedOrigins: SAMPLE_ALLOWED_ORIGINS }),
  ...computeCandidateDigests(discovered),
});

/** 一覧の検索（READ）。 */
const SEARCH = candidateOf(sampleForm({
  page: { origin: 'http://127.0.0.1:4173', path: '/admin/items' },
  formMethod: 'GET',
  action: sampleAction('/admin/items', ['page']),
  submitterText: '表示',
  fields: [sampleField('q'), sampleField('status', 'select-one', { options: ['open', 'closed'] })],
}));
/** 同じ検索の、規則が変わったもの（欄が必須になった）。識別は同じ。 */
const SEARCH_REQUIRED = candidateOf(sampleForm({
  page: { origin: 'http://127.0.0.1:4173', path: '/admin/items' },
  formMethod: 'GET',
  action: sampleAction('/admin/items', ['page']),
  submitterText: '表示',
  fields: [sampleField('q', 'text', { required: true }), sampleField('status', 'select-one', { options: ['open', 'closed'] })],
}));
/** 更新（PATCH の上書き）。 */
const UPDATE = candidateOf(sampleForm({
  page: { origin: 'http://127.0.0.1:4173', path: '/admin/items/1' },
  methodOverride: 'PATCH',
  action: sampleAction('/admin/items/1'),
  submitterText: '保存',
  fields: [sampleField('name'), sampleField('_method', 'hidden')],
}));
/** form の外のボタン。 */
const BUTTON = candidateOf(sampleButton({ page: { origin: 'http://127.0.0.1:4173', path: '/admin' } }));

const entries = (...candidates: readonly DiscoveryCandidate[]): readonly DiscoveryIndexEntry[] => candidates.map(discoveryIndexEntryOf);

/** 登録の ID の形の区切りか（索引が使う判定と同じ。T31e）。 */
const isRecordIdValue = (value: string): boolean => usableRecordIdOf(value) !== null;

/** 別のレコードの、同じ形の更新の画面（T31e。`/admin/items/2`）。 */
const OTHER_RECORD_UPDATE = candidateOf(sampleForm({
  page: { origin: 'http://127.0.0.1:4173', path: '/admin/items/2' },
  methodOverride: 'PATCH',
  action: sampleAction('/admin/items/2'),
  submitterText: '保存',
  fields: [sampleField('name'), sampleField('_method', 'hidden')],
}));

/** 読んだ画面の path（既定は、候補の画面の path。T27d）。 */
const pathsOf = (candidates: readonly DiscoveryCandidate[]): readonly string[] => [...new Set(candidates.map((candidate) => candidate.page.path))].sort();

const update = (
  jobId: string,
  at: string,
  candidates: readonly DiscoveryCandidate[],
  profileId = PROFILE_ID,
  readPagePaths: readonly string[] = pathsOf(candidates),
): DiscoveryIndexUpdate => ({ profileId, jobId, at, entries: entries(...candidates), readPagePaths });

const sorted = (...digests: readonly string[]): readonly string[] => [...digests].sort();

const rawRows = (): Record<string, unknown>[] => {
  const raw = new DatabaseSync(resolveControlDatabasePath(workDirectory), { readOnly: true });
  try {
    return raw.prepare('SELECT * FROM discovery_candidates ORDER BY profile_id, identity_digest').all() as Record<string, unknown>[];
  } finally {
    raw.close();
  }
};

describe('discovery index entries (T27c)', () => {
  it('keeps only the digests, the classification, the paths, the method and the state mark of a candidate', () => {
    expect(discoveryIndexEntryOf(UPDATE)).toEqual({
      identityDigest: UPDATE.identityDigest,
      ruleDigest: UPDATE.ruleDigest,
      classification: 'UPDATE',
      reasonCode: 'UPDATE_METHOD',
      pagePath: '/admin/items/1',
      actionPath: '/admin/items/1',
      formMethod: 'POST',
      methodOverride: 'PATCH',
      hasStateField: false,
      // T31e: 型にした識別の digest の一覧（画面と送信先の `1` の区切りの組 1 つ）。
      templatedIdentityDigests: templatedIdentityDigestsOf(UPDATE, isRecordIdValue),
      // T38d: probe のない候補は、型を持たない（空の一覧）。
      shapeDigests: [],
      // T38R-fix の I-1: 鍵と欄の対応の digest の一覧も、probe のない候補は空。
      keyFieldDigests: [],
    });
    // 区切りの組は、値が登録の ID の形に合う同じ値の組すべて（`admin`・`items`・`1` の 3 組）。
    expect(discoveryIndexEntryOf(UPDATE).templatedIdentityDigests).toHaveLength(3);
    expect(discoveryIndexEntryOf(BUTTON)).toMatchObject({ actionPath: null, formMethod: null, methodOverride: null, templatedIdentityDigests: [] });
    expect(Object.isFrozen(discoveryIndexEntryOf(SEARCH))).toBe(true);
    expect(DISCOVERY_INDEX_DRIFTS).toEqual(['NEW', 'CHANGED', 'UNCHANGED', 'MISSING', 'NOT_REVISITED']);
  });

  it('has no input for values, tokens, labels, button texts or field names in the types', () => {
    expectTypeOf<keyof DiscoveryIndexEntry>().toEqualTypeOf<
      'identityDigest' | 'ruleDigest' | 'classification' | 'reasonCode' | 'pagePath' | 'actionPath' | 'formMethod' | 'methodOverride' | 'hasStateField'
      | 'templatedIdentityDigests' | 'shapeDigests' | 'keyFieldDigests'
    >();
    expectTypeOf<keyof DiscoveryIndexUpdate>().toEqualTypeOf<'profileId' | 'jobId' | 'at' | 'entries' | 'readPagePaths'>();
  });
});

describe('recording a discovery job (T27c)', () => {
  it('records new candidates with the first and last job', () => {
    expect(recordDiscoveryCandidates(database, update('job-1', FIRST_AT, [SEARCH, UPDATE, BUTTON]))).toEqual({
      NEW: sorted(SEARCH.identityDigest, UPDATE.identityDigest, BUTTON.identityDigest),
      CHANGED: [],
      UNCHANGED: [],
      MISSING: [],
      NOT_REVISITED: [],
    });
    const index = readDiscoveryIndex(database, PROFILE_ID);
    expect(index.latestJobId).toBe('job-1');
    expect(index.latestSeenAt).toBe(FIRST_AT);
    expect(index.candidates.map(({ identityDigest, drift, firstSeenJobId, lastSeenJobId, lastChangedJobId }) =>
      ({ identityDigest, drift, firstSeenJobId, lastSeenJobId, lastChangedJobId }))).toEqual(
      sorted(SEARCH.identityDigest, UPDATE.identityDigest, BUTTON.identityDigest).map((identityDigest) =>
        ({ identityDigest, drift: 'NEW', firstSeenJobId: 'job-1', lastSeenJobId: 'job-1', lastChangedJobId: null })),
    );
    expect(readDiscoveryIndex(database, OTHER_PROFILE_ID)).toEqual({ latestJobId: null, latestSeenAt: null, latestReadPagePaths: [], candidates: [] });
  });

  it('tells new, changed, unchanged and missing candidates in one transaction, and keeps the missing ones', () => {
    recordDiscoveryCandidates(database, update('job-1', FIRST_AT, [SEARCH, UPDATE, BUTTON]));
    const NEW_BUTTON = candidateOf(sampleButton({ page: { origin: 'http://127.0.0.1:4173', path: '/admin/other' } }));
    expect(recordDiscoveryCandidates(database, update('job-2', SECOND_AT, [SEARCH_REQUIRED, UPDATE, NEW_BUTTON], PROFILE_ID, ['/admin', '/admin/items', '/admin/items/1', '/admin/other']))).toEqual({
      NEW: [NEW_BUTTON.identityDigest],
      CHANGED: [SEARCH.identityDigest],
      UNCHANGED: [UPDATE.identityDigest],
      MISSING: [BUTTON.identityDigest],
      NOT_REVISITED: [],
    });
    const second = readDiscoveryIndex(database, PROFILE_ID);
    expect(second.latestJobId).toBe('job-2');
    const byDigest = new Map(second.candidates.map((candidate) => [candidate.identityDigest, candidate]));
    expect(byDigest.get(SEARCH.identityDigest)).toMatchObject({
      drift: 'CHANGED', ruleDigest: SEARCH_REQUIRED.ruleDigest, firstSeenJobId: 'job-1', firstSeenAt: FIRST_AT, lastSeenJobId: 'job-2',
      lastSeenAt: SECOND_AT, lastChangedJobId: 'job-2',
    });
    expect(byDigest.get(UPDATE.identityDigest)).toMatchObject({ drift: 'UNCHANGED', lastSeenJobId: 'job-2', lastChangedJobId: null });
    expect(byDigest.get(NEW_BUTTON.identityDigest)).toMatchObject({ drift: 'NEW', firstSeenJobId: 'job-2' });
    // 消えた候補は消さない（最後に見たジョブで分かる）。
    expect(byDigest.get(BUTTON.identityDigest)).toMatchObject({ drift: 'MISSING', lastSeenJobId: 'job-1', lastSeenAt: FIRST_AT });
    expect(second.candidates).toHaveLength(4);

    // 次のジョブで変わらなければ、変わった印は前のジョブのまま（今のジョブに対しては UNCHANGED）。消えた候補が戻れば、まだある候補になる。
    expect(recordDiscoveryCandidates(database, update('job-3', THIRD_AT, [SEARCH_REQUIRED, UPDATE, NEW_BUTTON, BUTTON]))).toEqual({
      NEW: [],
      CHANGED: [],
      UNCHANGED: sorted(SEARCH.identityDigest, UPDATE.identityDigest, NEW_BUTTON.identityDigest, BUTTON.identityDigest),
      MISSING: [],
      NOT_REVISITED: [],
    });
    const third = new Map(readDiscoveryIndex(database, PROFILE_ID).candidates.map((candidate) => [candidate.identityDigest, candidate]));
    expect(third.get(SEARCH.identityDigest)).toMatchObject({ drift: 'UNCHANGED', lastChangedJobId: 'job-2' });
    expect(third.get(BUTTON.identityDigest)).toMatchObject({ drift: 'UNCHANGED', lastSeenJobId: 'job-3', firstSeenJobId: 'job-1' });
  });

  it('keeps the profiles apart', () => {
    recordDiscoveryCandidates(database, update('job-1', FIRST_AT, [SEARCH]));
    expect(recordDiscoveryCandidates(database, update('job-2', SECOND_AT, [SEARCH, UPDATE], OTHER_PROFILE_ID)).NEW)
      .toEqual(sorted(SEARCH.identityDigest, UPDATE.identityDigest));
    expect(readDiscoveryIndex(database, PROFILE_ID).candidates.map(({ identityDigest, drift }) => [identityDigest, drift]))
      .toEqual([[SEARCH.identityDigest, 'NEW']]);
  });

  it('merges the same candidate given twice, and rejects two entries with one identity but different contents', () => {
    expect(recordDiscoveryCandidates(database, update('job-1', FIRST_AT, [SEARCH, SEARCH])).NEW).toEqual([SEARCH.identityDigest]);
    const conflicting = [discoveryIndexEntryOf(SEARCH), discoveryIndexEntryOf(SEARCH_REQUIRED)];
    expect(() => recordDiscoveryCandidates(database, { profileId: PROFILE_ID, jobId: 'job-2', at: SECOND_AT, entries: conflicting, readPagePaths: ['/admin/items'] })).toThrow(RangeError);
    expect(readDiscoveryIndex(database, PROFILE_ID).latestJobId).toBe('job-1');
  });

  it('rejects the caller errors before writing (nothing is written)', () => {
    recordDiscoveryCandidates(database, update('job-1', SECOND_AT, [SEARCH]));
    const before = JSON.stringify(rawRows());
    const entry = discoveryIndexEntryOf(UPDATE);
    for (const [name, value] of [
      ['the same job twice', update('job-1', SECOND_AT, [UPDATE])],
      ['a time before the last job', update('job-2', FIRST_AT, [UPDATE])],
      ['a time that is not 14 digits', update('job-2', '2026-10-11', [UPDATE])],
      ['a job id of another shape', update('Job-2', THIRD_AT, [UPDATE])],
      ['a digest of another shape', { ...update('job-2', THIRD_AT, []), entries: [{ ...entry, identityDigest: 'x' }] }],
      ['a reason of another classification', { ...update('job-2', THIRD_AT, []), entries: [{ ...entry, reasonCode: 'READ_GET_FORM' }] }],
      ['a path without the slash', { ...update('job-2', THIRD_AT, []), entries: [{ ...entry, pagePath: 'admin' }] }],
    ] as const) {
      expect(() => recordDiscoveryCandidates(database, value as DiscoveryIndexUpdate), name).toThrow(RangeError);
    }
    expect(() => recordDiscoveryCandidates(database, update('job-2', THIRD_AT, [UPDATE], 'missing-profile'))).toThrow();
    expect(JSON.stringify(rawRows())).toBe(before);
  });
});

describe('T27d: the pages read by a job, NOT_REVISITED, and jobs without candidates', () => {
  const driftsOfIndex = (): Readonly<Record<string, string>> =>
    Object.fromEntries(readDiscoveryIndex(database, PROFILE_ID).candidates.map(({ identityDigest, drift }) => [identityDigest, drift]));
  const OTHER_PAGE_BUTTON = candidateOf(sampleButton({ page: { origin: 'http://127.0.0.1:4173', path: '/admin/other' } }));

  it('marks a missing candidate on a page read again as MISSING, and one on a page not read as NOT_REVISITED', () => {
    recordDiscoveryCandidates(database, update('job-1', FIRST_AT, [SEARCH, UPDATE, BUTTON, OTHER_PAGE_BUTTON]));
    // 2 回目は、`/admin/items` と `/admin` だけを読んだ（`/admin/items/1` と `/admin/other` は読まなかった）。`/admin` の候補は消えた。
    expect(recordDiscoveryCandidates(database, update('job-2', SECOND_AT, [SEARCH], PROFILE_ID, ['/admin', '/admin/items']))).toEqual({
      NEW: [],
      CHANGED: [],
      UNCHANGED: [SEARCH.identityDigest],
      MISSING: [BUTTON.identityDigest],
      NOT_REVISITED: sorted(UPDATE.identityDigest, OTHER_PAGE_BUTTON.identityDigest),
    });
    const index = readDiscoveryIndex(database, PROFILE_ID);
    expect(index).toMatchObject({ latestJobId: 'job-2', latestSeenAt: SECOND_AT, latestReadPagePaths: ['/admin', '/admin/items'] });
    expect(Object.fromEntries(index.candidates.map(({ identityDigest, drift }) => [identityDigest, drift]))).toEqual({
      [SEARCH.identityDigest]: 'UNCHANGED',
      [BUTTON.identityDigest]: 'MISSING',
      [UPDATE.identityDigest]: 'NOT_REVISITED',
      [OTHER_PAGE_BUTTON.identityDigest]: 'NOT_REVISITED',
    });
  });

  it('records a job without candidates as the latest job (a job row), and its read pages decide MISSING', () => {
    recordDiscoveryCandidates(database, update('job-1', FIRST_AT, [SEARCH, BUTTON]));
    expect(recordDiscoveryCandidates(database, update('job-2', SECOND_AT, [], PROFILE_ID, ['/admin']))).toEqual({
      NEW: [],
      CHANGED: [],
      UNCHANGED: [],
      MISSING: [BUTTON.identityDigest],
      NOT_REVISITED: [SEARCH.identityDigest],
    });
    const index = readDiscoveryIndex(database, PROFILE_ID);
    expect(index.latestJobId).toBe('job-2');
    expect(index.latestSeenAt).toBe(SECOND_AT);
    expect(Object.fromEntries(index.candidates.map(({ identityDigest, drift }) => [identityDigest, drift]))).toEqual({
      [SEARCH.identityDigest]: 'NOT_REVISITED',
      [BUTTON.identityDigest]: 'MISSING',
    });
    // 候補のない最初のジョブも、ジョブの行で分かる（読んだ画面もない）。
    expect(recordDiscoveryCandidates(database, update('job-3', THIRD_AT, [], OTHER_PROFILE_ID, []))).toEqual({
      NEW: [], CHANGED: [], UNCHANGED: [], MISSING: [], NOT_REVISITED: [],
    });
    expect(readDiscoveryIndex(database, OTHER_PROFILE_ID)).toEqual({
      latestJobId: 'job-3', latestSeenAt: THIRD_AT, latestReadPagePaths: [], candidates: [],
    });
  });

  it('takes the job recorded later as the latest job when two jobs are recorded at the same time (job ids are random)', () => {
    recordDiscoveryCandidates(database, update('job-b', FIRST_AT, [SEARCH, BUTTON]));
    recordDiscoveryCandidates(database, update('job-a', FIRST_AT, [SEARCH], PROFILE_ID, ['/admin', '/admin/items']));
    expect(readDiscoveryIndex(database, PROFILE_ID)).toMatchObject({ latestJobId: 'job-a', latestReadPagePaths: ['/admin', '/admin/items'] });
    expect(driftsOfIndex()).toEqual({ [SEARCH.identityDigest]: 'UNCHANGED', [BUTTON.identityDigest]: 'MISSING' });
  });

  it('rejects the second record of the same job by the job row (also a job without candidates), and writes nothing', () => {
    recordDiscoveryCandidates(database, update('job-1', FIRST_AT, [], PROFILE_ID, ['/admin']));
    expect(() => recordDiscoveryCandidates(database, update('job-1', SECOND_AT, [SEARCH]))).toThrow(RangeError);
    expect(() => recordDiscoveryCandidates(database, update('job-1', SECOND_AT, [], OTHER_PROFILE_ID))).toThrow(RangeError);
    expect(rawRows()).toEqual([]);
    expect(readDiscoveryIndex(database, PROFILE_ID)).toMatchObject({ latestJobId: 'job-1', latestReadPagePaths: ['/admin'] });
  });

  it('rejects read page paths of another shape, too many, or duplicated, before writing', () => {
    for (const [name, paths] of [
      ['a path without the slash', ['admin']],
      ['a path that is not a string', [1]],
      ['a duplicated path', ['/admin', '/admin']],
      ['too many paths', Array.from({ length: MAX_DISCOVERY_READ_PAGE_PATHS + 1 }, (_value, index) => `/p/${index}`)],
    ] as const) {
      expect(() => recordDiscoveryCandidates(database, update('job-1', FIRST_AT, [SEARCH], PROFILE_ID, paths as unknown as string[])), name)
        .toThrow(RangeError);
    }
    expect(rawRows()).toEqual([]);
    expect(readDiscoveryIndex(database, PROFILE_ID).latestJobId).toBeNull();
  });
});

describe('the index never holds values, tokens, labels or button texts (design 4.8)', () => {
  const MARKER = `bsdiscovery${Date.now().toString(36)}marker`;
  const leakedIn = (text: string): boolean => text.includes(MARKER) || text.includes(Buffer.from(MARKER, 'utf16le').toString('latin1'));
  const databaseBytes = (path: string): string =>
    [path, `${path}-wal`].filter((file) => existsSync(file)).map((file) => readFileSync(file).toString('latin1')).join('\n');

  it('writes no marker to the database file or the WAL even when the candidate carries one everywhere it can', () => {
    const marked = candidateOf(sampleForm({
      page: { origin: 'http://127.0.0.1:4173', path: '/admin/items' },
      formMethod: 'GET',
      action: sampleAction('/admin/items', [`${MARKER}query`]),
      target: `${MARKER}target`,
      submitterText: `${MARKER}button`,
      fields: [
        sampleField(`${MARKER}name`),
        sampleField('kind', 'select-one', { options: [`${MARKER}option`], hasValue: true }),
        sampleField('pattern', 'text', { constraints: { ...sampleField('x').constraints, pattern: `${MARKER}pattern` } }),
      ],
    }));
    const withExtra = { ...discoveryIndexEntryOf(marked), label: `${MARKER}label`, value: `${MARKER}value`, token: `${MARKER}token` };
    recordDiscoveryCandidates(database, { profileId: PROFILE_ID, jobId: 'job-1', at: FIRST_AT, entries: [withExtra as DiscoveryIndexEntry], readPagePaths: ['/admin/items'] });
    const path = resolveControlDatabasePath(workDirectory);
    expect(existsSync(`${path}-wal`)).toBe(true);
    expect(leakedIn(databaseBytes(path))).toBe(false);
    expect(leakedIn(JSON.stringify(readDiscoveryIndex(database, PROFILE_ID)))).toBe(false);
    expect(readDiscoveryIndex(database, PROFILE_ID).candidates).toHaveLength(1);

    // 検出の確かめ: 同じ読み方で、別のファイルに書いた目印は見つかる。
    const controlPath = join(workDirectory, 'control.sqlite');
    const control = new DatabaseSync(controlPath);
    try {
      control.exec('PRAGMA journal_mode = WAL');
      control.exec('CREATE TABLE t (v TEXT) STRICT');
      control.prepare('INSERT INTO t (v) VALUES (?)').run(MARKER);
      expect(leakedIn(databaseBytes(controlPath))).toBe(true);
    } finally {
      control.close();
    }
  });
});

// CCX-17（CC-078 の前半）: 索引の owner が公開する、トランザクションの中で使える読み出し。
describe('CCX-17: readers of the discovery index inside a transaction', () => {
  it('reads the same index as readDiscoveryIndex inside the caller transaction', () => {
    expect(withReadTransaction(database, (connection) => readDiscoveryIndexIn(connection, PROFILE_ID))).toEqual(readDiscoveryIndex(database, PROFILE_ID));
    recordDiscoveryCandidates(database, update('job-1', FIRST_AT, [SEARCH, UPDATE]));
    recordDiscoveryCandidates(database, update('job-2', SECOND_AT, [SEARCH], OTHER_PROFILE_ID));
    expect(withReadTransaction(database, (connection) => readDiscoveryIndexIn(connection, PROFILE_ID))).toEqual(readDiscoveryIndex(database, PROFILE_ID));
  });

  it('tells whether a discovery job of the profile was recorded after the given job (all jobs when it is null)', () => {
    const unchanged = (jobId: string | null, profileId = PROFILE_ID): boolean =>
      withReadTransaction(database, (connection) => noDiscoveryJobRecordedAfterIn(connection, profileId, jobId));
    expect(unchanged(null)).toBe(true);
    recordDiscoveryCandidates(database, update('job-1', FIRST_AT, [SEARCH]));
    expect(unchanged(null)).toBe(false);
    expect(unchanged('job-1')).toBe(true);
    recordDiscoveryCandidates(database, update('job-2', SECOND_AT, [SEARCH]));
    expect(unchanged('job-1')).toBe(false);
    expect(unchanged('job-2')).toBe(true);
    // ほかのプロファイルのジョブは数えない。
    recordDiscoveryCandidates(database, update('job-3', THIRD_AT, [SEARCH], OTHER_PROFILE_ID));
    expect(unchanged('job-2')).toBe(true);
  });
});

// T31e（Task 31 の設計書 11 章の T31b の Blocker の判断。管理データの版 9）: 索引の型にした識別の digest の一覧。
describe('T31e: the templated identity digests of the discovery index', () => {
  it('writes the digests computed from the whole candidate, and reads the same list as the candidate gives again', () => {
    recordDiscoveryCandidates(database, update('job-1', FIRST_AT, [SEARCH, UPDATE, OTHER_RECORD_UPDATE, BUTTON]));
    const index = readDiscoveryIndex(database, PROFILE_ID);
    for (const candidate of [SEARCH, UPDATE, OTHER_RECORD_UPDATE, BUTTON]) {
      const view = index.candidates.find(({ identityDigest }) => identityDigest === candidate.identityDigest);
      expect(view?.templatedIdentityDigests, candidate.page.path).toEqual(templatedIdentityDigestsOf(candidate, isRecordIdValue));
    }
    // 別のレコードの画面の候補も、ID の区切りを `{id}` にした同じ digest を持つ（UPDATE の承認は、どちらの画面の索引でも有効になる）。
    const shared = templatedIdentityDigestsOf(UPDATE, isRecordIdValue)
      .filter((digest) => templatedIdentityDigestsOf(OTHER_RECORD_UPDATE, isRecordIdValue).includes(digest));
    const idPair = recordIdSegmentPairsOf(UPDATE, isRecordIdValue).find((pair) => pair.pageSegment === recordIdSegmentPairsOf(UPDATE, isRecordIdValue)
      .reduce((last, candidate) => Math.max(last, candidate.pageSegment), 0));
    expect(shared).toEqual([idPair === undefined ? '' : templatedIdentityDigestOf(UPDATE, idPair)]);
    expect(index.candidates.filter(({ templatedIdentityDigests }) => templatedIdentityDigests?.includes(shared[0] ?? '') === true)
      .map(({ pagePath }) => pagePath).sort()).toEqual(['/admin/items/1', '/admin/items/2']);
    // 欄の名前と値は、管理データのファイルに入れない（digest だけ）。
    expect(JSON.stringify(rawRows())).not.toContain('"name"');
  });

  it('reads the rows written before version 9 without the digests (null), and writes them at the next discovery', () => {
    recordDiscoveryCandidates(database, update('job-1', FIRST_AT, [UPDATE]));
    const raw = new DatabaseSync(resolveControlDatabasePath(workDirectory));
    try {
      raw.prepare('UPDATE discovery_candidates SET templated_identity_digests = NULL').run();
    } finally {
      raw.close();
    }
    expect(readDiscoveryIndex(database, PROFILE_ID).candidates.map(({ templatedIdentityDigests }) => templatedIdentityDigests)).toEqual([null]);
    expect(recordDiscoveryCandidates(database, update('job-2', SECOND_AT, [UPDATE])).UNCHANGED).toEqual([UPDATE.identityDigest]);
    expect(readDiscoveryIndex(database, PROFILE_ID).candidates.map(({ templatedIdentityDigests }) => templatedIdentityDigests))
      .toEqual([templatedIdentityDigestsOf(UPDATE, isRecordIdValue)]);
  });

  it('rejects an entry whose digests are not sorted distinct digests within the limit, and writes nothing', () => {
    const entry = discoveryIndexEntryOf(UPDATE);
    const digest = entry.templatedIdentityDigests[0] ?? '';
    for (const templatedIdentityDigests of [
      ['not a digest'],
      [digest, digest],
      [`sha256:${'f'.repeat(64)}`, `sha256:${'0'.repeat(64)}`],
      Array.from({ length: 9 }, (_value, index) => `sha256:${String(index).repeat(64)}`),
    ]) {
      expect(() => recordDiscoveryCandidates(database, {
        profileId: PROFILE_ID, jobId: 'job-1', at: FIRST_AT, entries: [{ ...entry, templatedIdentityDigests }], readPagePaths: ['/admin/items/1'],
      })).toThrow(RangeError);
    }
    expect(readDiscoveryIndex(database, PROFILE_ID).latestJobId).toBeNull();
  });
});

describe('T38d: the shape digests of the discovery index', () => {
  const SHAPE_A = `sha256:${'1'.repeat(64)}`;
  const SHAPE_B = `sha256:${'2'.repeat(64)}`;
  const SHAPE_C = `sha256:${'3'.repeat(64)}`;
  const SHAPE_D = `sha256:${'4'.repeat(64)}`;

  /**
   * probe の結果を付けた候補（型の digest だけを使う。T38a の後の probe は `inputFields` を持つ）。T38R-fix の C-1: 索引に入れるのは書き込みの probe
   * （`API_CREATE`・`API_UPDATE`）の型だけなので、結果は `API_UPDATE`（`result` で変えられる）。
   */
  const probed = (
    candidate: DiscoveryCandidate,
    shapeDigest: string | null,
    withInputFields = true,
    result: SubmissionProbeRecord['result'] = 'API_UPDATE',
  ): DiscoveryCandidate => {
    const { inputFields: _inputFields, ...withoutFields } = notObservedSubmissionProbeOf('PRESS_FAILED');
    const written = { ...withoutFields, result, reason: null };
    const probe: SubmissionProbeRecord = withInputFields ? { ...written, inputFields: [], shapeDigest } : { ...written, shapeDigest };
    return { ...candidate, submissionProbe: probe };
  };

  const shapeDigestsOf = (identityDigest: string): readonly string[] | null | undefined =>
    readDiscoveryIndex(database, PROFILE_ID).candidates.find((candidate) => candidate.identityDigest === identityDigest)?.shapeDigests;

  it('takes the shape digest of a probe with the input fields, and no shape from a probe without them (before T38a) or without a shape', () => {
    expect(discoveryIndexEntryOf(probed(UPDATE, SHAPE_A)).shapeDigests).toEqual([SHAPE_A]);
    expect(discoveryIndexEntryOf(probed(UPDATE, SHAPE_A, false)).shapeDigests).toEqual([]);
    expect(discoveryIndexEntryOf(probed(UPDATE, null)).shapeDigests).toEqual([]);
    expect(discoveryIndexEntryOf(UPDATE).shapeDigests).toEqual([]);
    expect(Object.isFrozen(discoveryIndexEntryOf(probed(UPDATE, SHAPE_A)).shapeDigests)).toBe(true);
    // T38R-fix の C-1: 書き込みの probe でない結果（2 つの要求の `NOT_EXECUTABLE` など）の型は入れない。I-1: 鍵と欄の対応の digest も同じ行だけ。
    expect(discoveryIndexEntryOf(probed(UPDATE, SHAPE_A, true, 'NOT_EXECUTABLE'))).toMatchObject({ shapeDigests: [], keyFieldDigests: [] });
    expect(discoveryIndexEntryOf(probed(UPDATE, SHAPE_A)).keyFieldDigests).toHaveLength(1);
  });

  it('joins the shapes of the rows of one identity in a job (sorted, distinct), and rewrites them at the next discovery without a drift', () => {
    const first = recordDiscoveryCandidates(database, {
      ...update('job-1', FIRST_AT, [UPDATE]),
      entries: entries(probed(UPDATE, SHAPE_B), probed(UPDATE, SHAPE_A), probed(UPDATE, SHAPE_B), UPDATE, BUTTON),
      readPagePaths: ['/admin', '/admin/items/1'],
    });
    expect(first.NEW).toEqual(sorted(UPDATE.identityDigest, BUTTON.identityDigest));
    expect(shapeDigestsOf(UPDATE.identityDigest)).toEqual([SHAPE_A, SHAPE_B]);
    expect(shapeDigestsOf(BUTTON.identityDigest)).toEqual([]);
    // 次の発見で、今回の一覧に書き直す（型の違いはドリフトに数えない）。
    const second = recordDiscoveryCandidates(database, {
      ...update('job-2', SECOND_AT, [UPDATE]), entries: entries(probed(UPDATE, SHAPE_C)), readPagePaths: ['/admin/items/1'],
    });
    expect(second.UNCHANGED).toEqual([UPDATE.identityDigest]);
    expect(shapeDigestsOf(UPDATE.identityDigest)).toEqual([SHAPE_C]);
    // 変わった候補（規則の digest が違う）も、今回の一覧で書く。
    expect(recordDiscoveryCandidates(database, {
      ...update('job-3', THIRD_AT, [SEARCH]), entries: entries(probed(SEARCH, SHAPE_A)),
    }).NEW).toEqual([SEARCH.identityDigest]);
    expect(recordDiscoveryCandidates(database, {
      ...update('job-4', THIRD_AT, [SEARCH_REQUIRED]), entries: entries(probed(SEARCH_REQUIRED, SHAPE_B)),
    }).CHANGED).toEqual([SEARCH.identityDigest]);
    expect(shapeDigestsOf(SEARCH.identityDigest)).toEqual([SHAPE_B]);
  });

  it('still rejects two entries of one identity whose other contents differ', () => {
    expect(() => recordDiscoveryCandidates(database, {
      ...update('job-1', FIRST_AT, [SEARCH]), entries: entries(probed(SEARCH, SHAPE_A), probed(SEARCH_REQUIRED, SHAPE_B)),
    })).toThrow(RangeError);
    expect(readDiscoveryIndex(database, PROFILE_ID).latestJobId).toBeNull();
  });

  it('rejects shape digests of another form, unsorted, repeated, or more than the limit after the join, and writes nothing', () => {
    const entry = discoveryIndexEntryOf(UPDATE);
    for (const shapeDigests of [
      ['not a digest'],
      [SHAPE_A, SHAPE_A],
      [SHAPE_B, SHAPE_A],
      [SHAPE_A, SHAPE_B, SHAPE_C, SHAPE_D],
    ]) {
      expect(() => recordDiscoveryCandidates(database, {
        profileId: PROFILE_ID, jobId: 'job-1', at: FIRST_AT, entries: [{ ...entry, shapeDigests }], readPagePaths: ['/admin/items/1'],
      }), JSON.stringify(shapeDigests)).toThrow(RangeError);
    }
    expect(MAX_INDEX_SHAPE_DIGESTS).toBe(3);
    expect(() => recordDiscoveryCandidates(database, {
      profileId: PROFILE_ID, jobId: 'job-1', at: FIRST_AT, readPagePaths: ['/admin/items/1'],
      entries: [{ ...entry, shapeDigests: [SHAPE_A, SHAPE_B] }, { ...entry, shapeDigests: [SHAPE_C, SHAPE_D] }],
    })).toThrow(RangeError);
    expect(readDiscoveryIndex(database, PROFILE_ID).latestJobId).toBeNull();
  });

  it('reads the rows without shape digests (written before version 13) as null, and writes them at the next discovery', () => {
    recordDiscoveryCandidates(database, { ...update('job-1', FIRST_AT, [UPDATE]), entries: entries(probed(UPDATE, SHAPE_A)) });
    const raw = new DatabaseSync(resolveControlDatabasePath(workDirectory));
    try {
      raw.prepare('UPDATE discovery_candidates SET shape_digests = NULL').run();
    } finally {
      raw.close();
    }
    expect(shapeDigestsOf(UPDATE.identityDigest)).toBeNull();
    recordDiscoveryCandidates(database, { ...update('job-2', SECOND_AT, [UPDATE]), entries: entries(probed(UPDATE, SHAPE_B)) });
    expect(shapeDigestsOf(UPDATE.identityDigest)).toEqual([SHAPE_B]);
  });

  it('fails as a broken database when the stored shape digests are not a sorted list of digests', () => {
    recordDiscoveryCandidates(database, { ...update('job-1', FIRST_AT, [UPDATE]), entries: entries(probed(UPDATE, SHAPE_A)) });
    const raw = new DatabaseSync(resolveControlDatabasePath(workDirectory));
    try {
      raw.prepare('UPDATE discovery_candidates SET shape_digests = ?').run(JSON.stringify([SHAPE_B, SHAPE_A]));
    } finally {
      raw.close();
    }
    expect(() => readDiscoveryIndex(database, PROFILE_ID)).toThrow(ControlStoreError);
  });
});

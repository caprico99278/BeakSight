// 管理データの発見の索引と READ の確かめの表（`discovery_candidates`、`discovery_jobs`、`read_checks`、`read_check_results`）の結合テスト（T27c・T27d・
// T31e・T37d・T38d）。LG-2 で、版ごとのテスト（`control-store-v5`・`v9`・`v12`・`v13`）の今の形の確かめと、今の版の管理データでの部品の振る舞いを
// まとめた（前の版からの上げと前の版の形の確かめは捨てた。CHECK の値の一覧が名前つきの一覧と等しいことは `control-store-base-schema.test.ts`）。
// - STRICT、閉じた一覧と日時と digest の形の CHECK。索引の表は値・label・ボタンの文言の列を持たない。
// - 型にした識別の digest の一覧、型の digest の一覧、鍵と欄の対応の digest の一覧は JSON の配列（型の digest と鍵と欄の対応は上限の件数）。
// - READ の確かめの定義は、識別の digest か画面の path のどちらか 1 つ（画面の path の定義の送る値は `{}` だけ）。
// - 索引の読み書き（`discovery-index-store.ts`）と、シナリオの有効性が型を引く口（`scenario-facts.ts` の `candidateShapeDigestsOf`）。
// 一時のフォルダだけを使い、終わったら消す。
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { candidateShapeDigestsOf, discoverySnapshotOf } from '../../src/control/approval/scenario-facts.js';
import { MAX_INDEX_SHAPE_DIGESTS, readDiscoveryIndex, recordDiscoveryCandidates } from '../../src/control/job/discovery-index-store.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import {
  CANDIDATE_CLASSIFICATIONS,
  CANDIDATE_REASON_CODES,
  FORM_METHODS,
  METHOD_OVERRIDE_VALUES,
} from '../../src/discovery/candidate-contracts.js';
import { MAX_DISCOVERY_READ_PAGE_PATHS } from '../../src/discovery/discovery-result.js';
import { MAX_READ_CHECK_PAGE_PATH_LENGTH, READ_CHECK_RESULTS } from '../../src/discovery/read-check-contracts.js';
import { MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE } from '../../src/discovery/submission-probe-contracts.js';
import {
  checkListOf,
  columnNamesOf,
  countOf,
  indexNamesOf,
  insertRow,
  tableSqlOf,
  useControlStoreWorkspace,
  type SqlValue,
} from '../helpers/control-store-schema.js';

const PROFILE_ID = 'example-v5';
const OTHER_PROFILE_ID = 'example-v5-other';
const CREATED_AT = '20261011000000';
const FINISHED_AT = '20261011000100';
const LATER_AT = '20261017000100';
const JOB_AT = '20261017000200';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;
const SHAPE_A = `sha256:${'1'.repeat(64)}`;
const SHAPE_B = `sha256:${'2'.repeat(64)}`;

const workspace = useControlStoreWorkspace('beaksight-control-discovery-');

/** 今の版の管理データ（プロファイルを 2 つ入れた）の生の接続。 */
const latestConnection = (): DatabaseSync => workspace.latestConnection([PROFILE_ID, OTHER_PROFILE_ID]);

const candidateRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  profile_id: PROFILE_ID,
  identity_digest: DIGEST,
  rule_digest: OTHER_DIGEST,
  classification: 'READ',
  reason_code: 'READ_GET_FORM',
  page_path: '/admin/items',
  action_path: '/admin/items',
  form_method: 'GET',
  method_override: null,
  has_state_field: 0,
  first_seen_job_id: 'job-1',
  first_seen_at: CREATED_AT,
  last_seen_job_id: 'job-1',
  last_seen_at: CREATED_AT,
  last_changed_job_id: null,
  ...row,
});

const readCheckRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  read_check_id: 'read-check-1',
  profile_id: PROFILE_ID,
  target_identity_digest: DIGEST,
  parameters: '{"q":"example"}',
  expectations: '[{"kind":"ROW_COUNT_AT_LEAST","count":1}]',
  revision: 1,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
  canceled_at: null,
  ...row,
});

const resultRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  job_id: 'job-1',
  read_check_id: 'read-check-1',
  read_check_revision: 1,
  result: 'MATCHED',
  recorded_at: FINISHED_AT,
  ...row,
});

describe('Control store: the discovery and READ check tables', () => {
  it('are STRICT, use the closed lists, and the index has no column for values, labels or button texts', () => {
    const connection = latestConnection();
    for (const table of ['discovery_candidates', 'read_checks', 'read_check_results']) {
      expect(tableSqlOf(connection, table), table).toMatch(/\)\s*STRICT\s*$/u);
    }
    expect(columnNamesOf(connection, 'discovery_candidates')).toEqual([
      'profile_id', 'identity_digest', 'rule_digest', 'classification', 'reason_code', 'page_path', 'action_path', 'form_method',
      'method_override', 'has_state_field', 'first_seen_job_id', 'first_seen_at', 'last_seen_job_id', 'last_seen_at', 'last_changed_job_id',
      // T31e: 型にした識別の digest の一覧（digest だけ。欄の名前は持たない）。
      'templated_identity_digests',
      // T38d: 型の digest の一覧（digest だけ）。
      'shape_digests',
      // T38R-fix の I-1: 鍵と欄の対応の digest の一覧（digest だけ）。
      'key_field_digests',
    ]);
    expect(columnNamesOf(connection, 'discovery_candidates').filter((name) => /value|label|text|submitter|token|option|name/iu.test(name))).toEqual([]);
    const candidates = tableSqlOf(connection, 'discovery_candidates');
    expect(checkListOf(candidates, 'classification')).toEqual([...CANDIDATE_CLASSIFICATIONS]);
    expect(checkListOf(candidates, 'reason_code')).toEqual([...CANDIDATE_REASON_CODES]);
    expect(checkListOf(candidates, 'form_method')).toEqual([...FORM_METHODS]);
    expect(checkListOf(candidates, 'method_override')).toEqual([...METHOD_OVERRIDE_VALUES]);
    expect(checkListOf(tableSqlOf(connection, 'read_check_results'), 'result')).toEqual([...READ_CHECK_RESULTS]);
    // T37d: READ の確かめの定義の表は、画面の path の列（`target_page_path`）を持つ。
    expect(columnNamesOf(connection, 'read_checks')).toEqual([
      'read_check_id', 'profile_id', 'target_identity_digest', 'parameters', 'expectations', 'revision', 'created_at', 'updated_at', 'canceled_at',
      'target_page_path',
    ]);
    expect(columnNamesOf(connection, 'read_check_results')).toEqual(['result_id', 'job_id', 'read_check_id', 'read_check_revision', 'result', 'recorded_at']);
    expect(indexNamesOf(connection, 'discovery_candidates')).toEqual(['discovery_candidates_profile_last_seen']);
    expect([...indexNamesOf(connection, 'read_checks'), ...indexNamesOf(connection, 'read_check_results')])
      .toEqual(['read_checks_profile_created', 'read_check_results_check_recorded']);
  });

  it('accepts candidates in the right shape and rejects the rows that break the CHECKs', () => {
    const connection = latestConnection();
    insertRow(connection, 'discovery_candidates', candidateRow());
    insertRow(connection, 'discovery_candidates', candidateRow({ profile_id: OTHER_PROFILE_ID }));
    insertRow(connection, 'discovery_candidates', candidateRow({
      identity_digest: OTHER_DIGEST, classification: 'NOT_EXECUTABLE', reason_code: 'DESTRUCTIVE', form_method: 'POST', method_override: 'DELETE',
      has_state_field: 1, last_seen_job_id: 'job-2', last_seen_at: FINISHED_AT, last_changed_job_id: 'job-2',
    }));
    insertRow(connection, 'discovery_candidates', candidateRow({
      identity_digest: `sha256:${'c'.repeat(64)}`, classification: 'DISPLAY_ONLY', reason_code: 'NO_KNOWN_ACTION', action_path: null, form_method: null,
    }));
    for (const [name, row] of [
      ['the same profile and identity twice', candidateRow()],
      ['a digest of another shape', candidateRow({ identity_digest: 'a'.repeat(64) })],
      ['an upper case digest', candidateRow({ identity_digest: `sha256:${'A'.repeat(64)}` })],
      ['a rule digest of another shape', candidateRow({ identity_digest: `sha256:${'d'.repeat(64)}`, rule_digest: 'sha256:x' })],
      ['an unknown classification', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, classification: 'DELETE' })],
      ['a reason of another classification', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, reason_code: 'DESTRUCTIVE' })],
      ['an unknown method', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, form_method: 'PUT' })],
      ['an override without a form', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, action_path: null, form_method: null, method_override: 'PUT' })],
      ['an action without a method', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, form_method: null })],
      ['a path without the slash', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, page_path: 'admin' })],
      ['a state mark that is not 0 or 1', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, has_state_field: 2 })],
      ['a time that is not 14 digits', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, last_seen_at: '2026-10-11' })],
      ['a last time before the first', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, first_seen_at: FINISHED_AT, last_seen_at: CREATED_AT })],
      ['an upper case job id', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, last_seen_job_id: 'Job-1' })],
      ['an unknown profile', candidateRow({ profile_id: 'missing-profile' })],
    ] as const) {
      expect(() => insertRow(connection, 'discovery_candidates', row), name).toThrow();
    }
    expect(countOf(connection, 'discovery_candidates')).toBe(4);
  });

  it('accepts READ check definitions and results in the right shape and rejects the rows that break the CHECKs', () => {
    const connection = latestConnection();
    insertRow(connection, 'read_checks', readCheckRow());
    insertRow(connection, 'read_checks', readCheckRow({ read_check_id: 'read-check-2', revision: 2, updated_at: FINISHED_AT, canceled_at: FINISHED_AT }));
    for (const [name, row] of [
      ['the same id twice', readCheckRow()],
      ['parameters that are not an object', readCheckRow({ read_check_id: 'r-1', parameters: '["q"]' })],
      ['parameters that are not JSON', readCheckRow({ read_check_id: 'r-2', parameters: '{q' })],
      ['expectations that are not an array', readCheckRow({ read_check_id: 'r-3', expectations: '{}' })],
      ['a revision of 0', readCheckRow({ read_check_id: 'r-4', revision: 0 })],
      ['a text revision (STRICT)', readCheckRow({ read_check_id: 'r-5', revision: 'one' })],
      ['a digest of another shape', readCheckRow({ read_check_id: 'r-6', target_identity_digest: 'sha256:' })],
      ['an update before the creation', readCheckRow({ read_check_id: 'r-7', created_at: FINISHED_AT, updated_at: CREATED_AT })],
      ['a canceled time that is not 14 digits', readCheckRow({ read_check_id: 'r-8', canceled_at: 'now' })],
      ['an upper case id', readCheckRow({ read_check_id: 'Read-1' })],
      ['an unknown profile', readCheckRow({ read_check_id: 'r-9', profile_id: 'missing-profile' })],
    ] as const) {
      expect(() => insertRow(connection, 'read_checks', row), name).toThrow();
    }
    expect(countOf(connection, 'read_checks')).toBe(2);

    for (const result of READ_CHECK_RESULTS) {
      insertRow(connection, 'read_check_results', resultRow({ job_id: `job-${result.toLowerCase().split('_').join('-')}`, result }));
    }
    for (const [name, row] of [
      ['the same job and definition twice', resultRow({ job_id: 'job-matched' })],
      ['an unknown result', resultRow({ job_id: 'job-x', result: 'PASSED' })],
      ['an unknown definition', resultRow({ job_id: 'job-y', read_check_id: 'missing' })],
      ['a revision of 0', resultRow({ job_id: 'job-z', read_check_revision: 0 })],
      ['a time that is not 14 digits', resultRow({ job_id: 'job-w', recorded_at: '20261011' })],
      ['an upper case job id', resultRow({ job_id: 'JOB-1' })],
    ] as const) {
      expect(() => insertRow(connection, 'read_check_results', row), name).toThrow();
    }
    expect(countOf(connection, 'read_check_results')).toBe(READ_CHECK_RESULTS.length);
    expect(connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  // T37d（Task 37 の設計書 3.5）: READ の定義は、識別の digest か画面の path のちょうど 1 つ。画面の path の定義の送る値は `{}` だけ。
  it('accepts a page path definition with no values to send, and rejects the other shapes', () => {
    const connection = latestConnection();
    insertRow(connection, 'read_checks', readCheckRow({ read_check_id: 'read-page', target_identity_digest: null, target_page_path: '/admin/members', parameters: '{}' }));
    insertRow(connection, 'read_checks', readCheckRow({ read_check_id: 'read-root', target_identity_digest: null, target_page_path: '/', parameters: '{}' }));
    insertRow(connection, 'read_check_results', resultRow({ read_check_id: 'read-page' }));
    for (const [name, row] of [
      ['no target', { target_identity_digest: null }],
      ['both targets', { target_page_path: '/admin' }],
      ['a page path with values to send', { target_identity_digest: null, target_page_path: '/admin' }],
      ['a page path without a slash', { target_identity_digest: null, target_page_path: 'admin', parameters: '{}' }],
      ['a page path of another host', { target_identity_digest: null, target_page_path: '//example.invalid', parameters: '{}' }],
      ['a page path with a query', { target_identity_digest: null, target_page_path: '/admin?x=1', parameters: '{}' }],
      ['a page path with a fragment', { target_identity_digest: null, target_page_path: '/admin#x', parameters: '{}' }],
      ['a page path with a backslash', { target_identity_digest: null, target_page_path: '/\\x', parameters: '{}' }],
      ['a page path over the limit', { target_identity_digest: null, target_page_path: `/${'a'.repeat(MAX_READ_CHECK_PAGE_PATH_LENGTH)}`, parameters: '{}' }],
      ['a digest of another shape', { target_identity_digest: 'sha256:x' }],
    ] as const) {
      expect(() => insertRow(connection, 'read_checks', readCheckRow({ read_check_id: 'read-bad', ...row })), name).toThrow();
    }
  });
});

describe('Control store: the discovery jobs table', () => {
  const discoveryJobRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
    job_id: 'job-1',
    profile_id: PROFILE_ID,
    recorded_at: CREATED_AT,
    read_page_paths: '["/admin","/admin/items"]',
    ...row,
  });

  it('is STRICT, keeps the job, the profile, the time and the read page paths only, and is indexed by profile and time', () => {
    const connection = latestConnection();
    expect(tableSqlOf(connection, 'discovery_jobs')).toMatch(/\)\s*STRICT\s*$/u);
    expect(columnNamesOf(connection, 'discovery_jobs')).toEqual(['job_id', 'profile_id', 'recorded_at', 'read_page_paths']);
    expect(tableSqlOf(connection, 'discovery_jobs')).toContain(`json_array_length(read_page_paths) <= ${MAX_DISCOVERY_READ_PAGE_PATHS}`);
    expect(indexNamesOf(connection, 'discovery_jobs')).toEqual(['discovery_jobs_profile_recorded']);
  });

  it('accepts a job row (also without read pages) and rejects the rows that break the CHECKs or repeat a job', () => {
    const connection = latestConnection();
    insertRow(connection, 'discovery_jobs', discoveryJobRow());
    insertRow(connection, 'discovery_jobs', discoveryJobRow({ job_id: 'job-2', profile_id: OTHER_PROFILE_ID, read_page_paths: '[]' }));
    for (const [name, row] of [
      ['the same job twice', discoveryJobRow()],
      ['the same job for another profile', discoveryJobRow({ profile_id: OTHER_PROFILE_ID })],
      ['an upper case job id', discoveryJobRow({ job_id: 'Job-3' })],
      ['a time that is not 14 digits', discoveryJobRow({ job_id: 'job-3', recorded_at: '2026-10-11' })],
      ['read page paths that are not JSON', discoveryJobRow({ job_id: 'job-3', read_page_paths: '[/admin' })],
      ['read page paths that are not an array', discoveryJobRow({ job_id: 'job-3', read_page_paths: '{"a":1}' })],
      ['too many read page paths', discoveryJobRow({ job_id: 'job-3', read_page_paths: JSON.stringify(Array.from({ length: MAX_DISCOVERY_READ_PAGE_PATHS + 1 }, (_value, index) => `/p/${index}`)) })],
      ['an unknown profile', discoveryJobRow({ job_id: 'job-3', profile_id: 'missing-profile' })],
    ] as const) {
      expect(() => insertRow(connection, 'discovery_jobs', row), name).toThrow();
    }
    expect(countOf(connection, 'discovery_jobs')).toBe(2);
  });
});

// T31e・T38d: 型にした識別の digest の一覧、型の digest の一覧、鍵と欄の対応の digest の一覧。
describe('Control store: the digest lists of the discovery index', () => {
  it('accepts a JSON array or null as the templated digests, and rejects other values', () => {
    const connection = latestConnection();
    insertRow(connection, 'discovery_candidates', candidateRow({ templated_identity_digests: JSON.stringify([OTHER_DIGEST]) }));
    insertRow(connection, 'discovery_candidates', candidateRow({ identity_digest: OTHER_DIGEST, templated_identity_digests: null }));
    expect(() => insertRow(connection, 'discovery_candidates', candidateRow({ identity_digest: `sha256:${'c'.repeat(64)}`,
      templated_identity_digests: '{}' }))).toThrow();
    expect(() => insertRow(connection, 'discovery_candidates', candidateRow({ identity_digest: `sha256:${'d'.repeat(64)}`,
      templated_identity_digests: 'not json' }))).toThrow();
    expect(countOf(connection, 'discovery_candidates')).toBe(2);
  });

  it('limits the shape digests and the key field digests to the presses of one page', () => {
    // 索引の上限は、1 画面で押す回数の上限（1 つの識別の digest の型は、1 回の発見でそれより多くならない）。
    expect(MAX_INDEX_SHAPE_DIGESTS).toBe(MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE);
    const connection = latestConnection();
    const sql = tableSqlOf(connection, 'discovery_candidates');
    expect(sql).toContain(`json_array_length(shape_digests) <= ${MAX_INDEX_SHAPE_DIGESTS}`);
    expect(sql).toContain(`json_array_length(key_field_digests) <= ${MAX_INDEX_SHAPE_DIGESTS}`);
  });

  it('accepts a JSON array within the limit, and rejects a broken JSON, an object and a too long array', () => {
    const connection = latestConnection();
    const display = { classification: 'DISPLAY_ONLY', reason_code: 'NO_KNOWN_ACTION', action_path: null, form_method: null } as const;
    insertRow(connection, 'discovery_candidates', candidateRow({ ...display, shape_digests: JSON.stringify([SHAPE_A, SHAPE_B]) }));
    insertRow(connection, 'discovery_candidates', candidateRow({ ...display, identity_digest: OTHER_DIGEST, shape_digests: '[]' }));
    for (const [index, value] of ['[', '{}', '"x"', JSON.stringify(Array.from({ length: MAX_INDEX_SHAPE_DIGESTS + 1 }, () => SHAPE_A))].entries()) {
      expect(() => insertRow(connection, 'discovery_candidates', candidateRow({ ...display, identity_digest: `sha256:${String(index).repeat(64)}`, shape_digests: value })), value)
        .toThrow();
      // T38R-fix の I-1: 鍵と欄の対応の digest の一覧の列も同じ CHECK。
      expect(() => insertRow(connection, 'discovery_candidates', candidateRow({ ...display, identity_digest: `sha256:${String(index).repeat(63)}f`, key_field_digests: value })), value)
        .toThrow();
    }
    insertRow(connection, 'discovery_candidates', candidateRow({ ...display, identity_digest: `sha256:${'e'.repeat(64)}`, key_field_digests: JSON.stringify([SHAPE_A]) }));
  });

  it('reads a row without shape digests (null) through the index and the scenario facts', () => {
    const connection = latestConnection();
    insertRow(connection, 'discovery_jobs', { job_id: 'job-1', profile_id: PROFILE_ID, recorded_at: CREATED_AT, read_page_paths: '["/admin"]' });
    insertRow(connection, 'discovery_candidates', candidateRow({
      classification: 'DISPLAY_ONLY', reason_code: 'NO_KNOWN_ACTION', page_path: '/admin', action_path: null, form_method: null,
      templated_identity_digests: '[]',
    }));
    connection.close();
    const database = openControlDatabase(workspace.databasePath());
    try {
      expect(readDiscoveryIndex(database, PROFILE_ID).candidates.map(({ shapeDigests }) => shapeDigests)).toEqual([null]);
      const snapshot = discoverySnapshotOf(database, PROFILE_ID);
      expect(candidateShapeDigestsOf(snapshot, DIGEST)).toBeNull();
      expect(candidateShapeDigestsOf(snapshot, OTHER_DIGEST)).toBeNull();
    } finally {
      closeControlDatabase(database);
    }
  });

  it('writes the shape digests at the next discovery, and the scenario facts look them up by the identity digest', () => {
    workspace.latestConnection([PROFILE_ID]).close();
    const database = openControlDatabase(workspace.databasePath());
    try {
      const entry = {
        identityDigest: DIGEST, ruleDigest: OTHER_DIGEST, classification: 'NEEDS_BINDING', reasonCode: 'JS_BOUND', pagePath: '/admin',
        actionPath: null, formMethod: null, methodOverride: null, hasStateField: false, templatedIdentityDigests: [], keyFieldDigests: [],
      } as const;
      recordDiscoveryCandidates(database, {
        profileId: PROFILE_ID, jobId: 'job-1', at: LATER_AT, readPagePaths: ['/admin'],
        entries: [{ ...entry, shapeDigests: [SHAPE_B] }, { ...entry, shapeDigests: [SHAPE_A] }],
      });
      expect(readDiscoveryIndex(database, PROFILE_ID).candidates.map(({ shapeDigests }) => shapeDigests)).toEqual([[SHAPE_A, SHAPE_B]]);
      expect(candidateShapeDigestsOf(discoverySnapshotOf(database, PROFILE_ID), DIGEST)).toEqual([SHAPE_A, SHAPE_B]);
      recordDiscoveryCandidates(database, {
        profileId: PROFILE_ID, jobId: 'job-2', at: JOB_AT, readPagePaths: ['/admin'], entries: [{ ...entry, shapeDigests: [] }],
      });
      expect(candidateShapeDigestsOf(discoverySnapshotOf(database, PROFILE_ID), DIGEST)).toEqual([]);
    } finally {
      closeControlDatabase(database);
    }
  });
});

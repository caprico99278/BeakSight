// LG-2（設計書 `2026-10-24-beaksight-test-suite-tiers-design.md` 3.7.1）: 管理データの基準の版 17 の結合テスト。
// - 新しく作った管理データの形が、写し取った fixture（`tests/fixtures/control-schema/v17-schema.json`）と同じこと（`sqlite_schema` の文、列の順、索引、
//   外部キー、`application_id`、`user_version`、`store_meta` の鍵）。fixture は、LG-2 で版 1〜16 の段を捨てる前に、今の版 1→17 の段で空の所から作った
//   管理データから写し取った（scratchpad の道具 `lg-2/capture.test.ts`。`schemaShapeOf` と同じ読み方）。手で直さない。
// - 基準の文の SHA-256 の固定（基準の文は公開済みの版 17 なので変えない。値の一覧を足すときは、版 18 から後の段として足す）。
// - 今の名前つきの一覧と定数が、基準の文の CHECK の値と等しいこと（並びも同じ。前は、名前つきの一覧が公開した時点の写しで「始まる」ことだけを確かめた表も
//   ある）。等しくなくなったら、版 18 から後の段を足して、その段のテストで確かめる。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTION_BLOCK_REASONS,
  ACTION_OUTCOME_REASONS,
  ACTION_RESULTS,
  MAX_HTTP_STATUS,
  MIN_HTTP_STATUS,
  RESPONSE_JUDGEMENTS,
  SETTLED_RESERVATION_STATES,
  SUBMISSION_STATES,
} from '../../src/control/actions/action-contracts.js';
import { MAX_SAFE_RECORD_ID_LENGTH } from '../../src/control/actions/action-outcome.js';
import {
  APPROVAL_RECEIPT_KINDS,
  DEFAULT_MAX_CREATES_PER_RUN,
  MAX_RECORD_ID_LENGTH,
  MAX_SCENARIO_API_PATH_LENGTH,
  MIN_SCENARIO_LIMIT,
  MIN_SCENARIO_REVISION,
  SCENARIO_API_METHODS,
  SCENARIO_STATES,
  SCENARIO_TRANSPORTS,
  WRITE_RESERVATION_STATES,
} from '../../src/control/approval/scenario-contracts.js';
import {
  AUTOMATED_LOGIN_FAILURE_RESULTS,
  AUTOMATED_LOGIN_RESULTS,
  AUTOMATED_LOGIN_SUBMISSIONS,
} from '../../src/control/auth/automated-login-results.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { MIN_RULE_SET_REVISION } from '../../src/control/data-rules/rule-contracts.js';
import { MAX_INDEX_SHAPE_DIGESTS } from '../../src/control/job/discovery-index-store.js';
import {
  ACTIVE_AUDIT_JOB_STATES,
  AUDIT_JOB_FAILURE_REASONS,
  AUDIT_JOB_KINDS,
  AUDIT_JOB_STATES,
  AUDIT_JOB_STATES_WITH_REASON,
  CONTROL_INSTANCE_SLOT,
  CREDENTIAL_EVENT_KINDS,
  FINAL_AUDIT_JOB_STATES,
  MAX_CONTROL_INSTANCE_PORT,
  MAX_LOGIN_STAGE_SUMMARY_LENGTH,
  MAX_SESSION_LOSS_RECORD_LENGTH,
  MIN_CONTROL_INSTANCE_PORT,
  WRITE_REPORT_CHECKS,
} from '../../src/control/job/job-records.js';
import { CONTROL_SCHEMA_V17 } from '../../src/control/store/control-schema-v17.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import { CONTROL_DB_APPLICATION_ID, CONTROL_SCHEMA_BASE, CONTROL_SCHEMA_VERSION } from '../../src/control/store/migrations.js';
import { PROFILE_CHANGE_KINDS, PROFILE_STATUSES } from '../../src/control/store/profile-records.js';
import {
  MAX_WORKER_EXIT_CODE,
  MAX_WORKER_MESSAGE_PATH_LENGTH,
  MAX_WORKER_NOTICE_URL_LENGTH,
  WORKER_AUTH_STATES,
  WORKER_LOGIN_FORM_INVALID_REASONS,
  WORKER_OUTCOME_KINDS,
  WORKER_RUN_STATUSES,
  WORKER_WRITE_JOB_KINDS,
} from '../../src/control/worker-protocol.js';
import { MAX_API_SHAPE_PATH_LENGTH } from '../../src/core/api-request-shape.js';
import { AUDIT_SEND_POLICIES, DEFAULT_AUDIT_SEND_POLICY } from '../../src/core/audit-send-policy.js';
import { MAX_URL_LENGTH } from '../../src/core/limits.js';
import { SCENARIO_KINDS } from '../../src/core/scenario-kind.js';
import { COMPACT_UTC_TIMESTAMP_LENGTH } from '../../src/core/utc-timestamp.js';
import {
  CANDIDATE_CLASSIFICATIONS,
  CANDIDATE_REASON_CLASSIFICATIONS,
  CANDIDATE_REASON_CODES,
  FORM_METHODS,
  MAX_CANDIDATE_URL_PART_LENGTH,
  METHOD_OVERRIDE_VALUES,
} from '../../src/discovery/candidate-contracts.js';
import { MAX_DISCOVERY_READ_PAGE_PATHS } from '../../src/discovery/discovery-result.js';
import { MAX_READ_CHECK_PAGE_PATH_LENGTH, READ_CHECK_RESULTS } from '../../src/discovery/read-check-contracts.js';
import { inListsOf, schemaShapeOf, useControlStoreWorkspace } from '../helpers/control-store-schema.js';

/** 写し取った形（LG-2 の前の版 1→17 の段で作った管理データ）。 */
const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/control-schema/v17-schema.json', import.meta.url), 'utf8')) as {
  readonly applicationId: number;
  readonly userVersion: number;
  readonly storeMetaKeys: readonly string[];
  readonly objects: unknown;
  readonly tables: unknown;
};

/** 文をつなぐ区切り（SHA-256 を求めるときだけに使う。前の版のテストと同じ）。 */
const STATEMENT_SEPARATOR = '\n;\n';
/** 基準の版 17 の文の SHA-256（LG-2 で写し取った文から求めた。基準の文は変えない）。 */
const BASE_STATEMENTS_SHA256 = '114b583638fe776f60e818fc51bf6f4b168c856e37be3f5507b49e7d90ee8ea2';
/** 基準の版 17 の文と版。 */
const CONTROL_SCHEMA_V17_STATEMENTS = CONTROL_SCHEMA_V17.statements;
const CONTROL_SCHEMA_V17_VERSION = CONTROL_SCHEMA_V17.version;
/** 0 か 1 の列の値。 */
const FLAG_VALUES = ['0', '1'];

const workspace = useControlStoreWorkspace('beaksight-control-base-schema-');

/** 作る文の名前（`CREATE [UNIQUE] TABLE|INDEX <名前>`。二重引用符を外す）。 */
const createdNameOf = (statement: string): string =>
  (/^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+"?(\w+)"?/u.exec(statement)?.[1] ?? '');

/** 名前の表・索引を作る文。 */
const statementOf = (name: string): string => CONTROL_SCHEMA_V17_STATEMENTS.find((statement) => createdNameOf(statement) === name) ?? '';

const named = (column: string, values: readonly (string | number)[]): string => `${column}: ${values.join(',')}`;

describe('Control store base version 17 (LG-2): the frozen statements', () => {
  it('is version 17, the base of the runner, and the latest version is the base plus the later steps', () => {
    expect(CONTROL_SCHEMA_V17_VERSION).toBe(17);
    expect(CONTROL_SCHEMA_BASE.version).toBe(CONTROL_SCHEMA_V17_VERSION);
    expect(CONTROL_SCHEMA_BASE.statements).toBe(CONTROL_SCHEMA_V17_STATEMENTS);
    expect(CONTROL_SCHEMA_VERSION).toBeGreaterThanOrEqual(CONTROL_SCHEMA_V17_VERSION);
    expect(Object.isFrozen(CONTROL_SCHEMA_V17)).toBe(true);
    expect(Object.isFrozen(CONTROL_SCHEMA_V17_STATEMENTS)).toBe(true);
    expect(Object.isFrozen(CONTROL_SCHEMA_BASE)).toBe(true);
  });

  it('keeps the statements byte for byte (SHA-256)', () => {
    expect(createHash('sha256').update(CONTROL_SCHEMA_V17_STATEMENTS.join(STATEMENT_SEPARATOR), 'utf8').digest('hex')).toBe(BASE_STATEMENTS_SHA256);
  });

  it('only creates tables and indexes, each name once, every index after its table', () => {
    const names = CONTROL_SCHEMA_V17_STATEMENTS.map(createdNameOf);
    expect(names.every((name) => name.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    CONTROL_SCHEMA_V17_STATEMENTS.forEach((statement, index) => {
      const table = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+\w+\s+ON\s+(\w+)/u.exec(statement)?.[1];
      if (table !== undefined) {
        expect(names.indexOf(table), statement).toBeLessThan(index);
      }
    });
  });
});

describe('Control store base version 17 (LG-2): the shape of a new database', () => {
  it('creates the same shape as the fixture copied from the database built through versions 1 to 17', () => {
    const database = openControlDatabase(workspace.databasePath());
    try {
      expect(database.foundSchemaVersion).toBe(0);
      expect(database.schemaVersion).toBe(CONTROL_SCHEMA_VERSION);
    } finally {
      closeControlDatabase(database);
    }
    const connection = workspace.rawConnection();
    const pragmaOf = (name: string): unknown => (connection.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[name];
    expect(FIXTURE.applicationId).toBe(CONTROL_DB_APPLICATION_ID);
    expect(pragmaOf('application_id')).toBe(FIXTURE.applicationId);
    expect(pragmaOf('user_version')).toBe(FIXTURE.userVersion);
    expect((connection.prepare('SELECT key FROM store_meta ORDER BY key').all() as { key: string }[]).map((row) => row.key))
      .toEqual(FIXTURE.storeMetaKeys);
    const shape = schemaShapeOf(connection);
    expect(shape.objects).toEqual(FIXTURE.objects);
    expect(shape.tables).toEqual(FIXTURE.tables);
    expect(connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('Control store base version 17 (LG-2): the named lists and numbers are equal to the frozen CHECKs', () => {
  it('has the CHECK lists of the named closed lists, in the same order, for every table and index', () => {
    const expected: Readonly<Record<string, readonly string[]>> = {
      profiles: [named('status', PROFILE_STATUSES)],
      profile_revisions: [named('change_kind', PROFILE_CHANGE_KINDS)],
      auto_login_attempts: [
        named('result', AUTOMATED_LOGIN_RESULTS),
        named('submitted', AUTOMATED_LOGIN_SUBMISSIONS),
        named('form_invalid_reason', WORKER_LOGIN_FORM_INVALID_REASONS),
      ],
      auto_login_holds: [named('reason', AUTOMATED_LOGIN_FAILURE_RESULTS)],
      credential_events: [named('kind', CREDENTIAL_EVENT_KINDS)],
      discovery_candidates: [
        named('classification', CANDIDATE_CLASSIFICATIONS),
        named('reason_code', CANDIDATE_REASON_CODES),
        named('form_method', FORM_METHODS),
        named('method_override', METHOD_OVERRIDE_VALUES),
        named('has_state_field', FLAG_VALUES),
      ],
      scenarios: [named('state', SCENARIO_STATES)],
      approval_receipts: [named('kind', APPROVAL_RECEIPT_KINDS)],
      write_reservations: [named('state', WRITE_RESERVATION_STATES)],
      jobs: [
        named('state', AUDIT_JOB_STATES),
        named('start_new', FLAG_VALUES),
        named('run_status', WORKER_RUN_STATUSES),
        named('end_kind', WORKER_OUTCOME_KINDS),
        named('failure_reason', AUDIT_JOB_FAILURE_REASONS),
        named('last_auth_state', WORKER_AUTH_STATES),
        named('job_kind', AUDIT_JOB_KINDS),
        named('write_report_check', WRITE_REPORT_CHECKS),
        named('job_kind', WORKER_WRITE_JOB_KINDS),
        named('state', FINAL_AUDIT_JOB_STATES),
        named('state', AUDIT_JOB_STATES_WITH_REASON),
      ],
      jobs_single_active: [named('state', ACTIVE_AUDIT_JOB_STATES), named('state', ACTIVE_AUDIT_JOB_STATES)],
      read_check_results: [named('result', READ_CHECK_RESULTS)],
      write_results: [
        named('write_kind', SCENARIO_KINDS),
        named('submission', SUBMISSION_STATES),
        named('block_reason', ACTION_BLOCK_REASONS),
        named('response_judgement', RESPONSE_JUDGEMENTS),
        named('read_verification', READ_CHECK_RESULTS),
        named('result', ACTION_RESULTS),
        named('reason', ACTION_OUTCOME_REASONS),
        named('reservation_state', SETTLED_RESERVATION_STATES),
        named('transport', SCENARIO_TRANSPORTS),
        named('api_method', SCENARIO_API_METHODS),
      ],
      profile_display_settings: [named('show_job_browser', FLAG_VALUES), named('audit_send_policy', AUDIT_SEND_POLICIES)],
    };
    for (const statement of CONTROL_SCHEMA_V17_STATEMENTS) {
      const name = createdNameOf(statement);
      expect(inListsOf([statement]), name).toEqual(expected[name] ?? []);
    }
    expect(Object.keys(expected).filter((name) => statementOf(name) === '')).toEqual([]);
  });

  it('pairs every candidate reason with its classification, in the order of the reasons', () => {
    const pairs = [...statementOf('discovery_candidates').matchAll(/WHEN '(\w+)' THEN '(\w+)'/gu)].map((match) => [match[1], match[2]]);
    expect(pairs).toEqual(CANDIDATE_REASON_CODES.map((code) => [code, CANDIDATE_REASON_CLASSIFICATIONS[code]]));
  });

  it('has the defaults of the transport and the audit send policy', () => {
    expect(statementOf('write_results')).toContain(`transport TEXT NOT NULL DEFAULT '${SCENARIO_TRANSPORTS[0]}'`);
    expect(statementOf('profile_display_settings')).toContain(`audit_send_policy TEXT NOT NULL DEFAULT '${DEFAULT_AUDIT_SEND_POLICY}'`);
  });

  it('has the numbers of the named constants in the CHECKs', () => {
    const fragments: readonly (readonly [string, string])[] = [
      ['profiles', `revision >= ${MIN_PROFILE_REVISION}`],
      ['profiles', `length(updated_at) = ${COMPACT_UTC_TIMESTAMP_LENGTH}`],
      ['control_instance', `slot = ${CONTROL_INSTANCE_SLOT}`],
      ['control_instance', `port BETWEEN ${MIN_CONTROL_INSTANCE_PORT} AND ${MAX_CONTROL_INSTANCE_PORT}`],
      ['discovery_candidates', `length(page_path) BETWEEN 1 AND ${MAX_CANDIDATE_URL_PART_LENGTH}`],
      ['discovery_candidates', `json_array_length(shape_digests) <= ${MAX_INDEX_SHAPE_DIGESTS}`],
      ['discovery_candidates', `json_array_length(key_field_digests) <= ${MAX_INDEX_SHAPE_DIGESTS}`],
      ['discovery_jobs', `json_array_length(read_page_paths) <= ${MAX_DISCOVERY_READ_PAGE_PATHS}`],
      ['scenarios', `revision >= ${MIN_SCENARIO_REVISION}`],
      ['write_reservations', `count BETWEEN ${MIN_SCENARIO_LIMIT} AND ${DEFAULT_MAX_CREATES_PER_RUN}`],
      ['execution_grants', `length(target_record_id) BETWEEN 1 AND ${MAX_SAFE_RECORD_ID_LENGTH}`],
      ['rule_sets', `revision >= ${MIN_RULE_SET_REVISION}`],
      ['jobs', `length(run_directory) BETWEEN 1 AND ${MAX_WORKER_MESSAGE_PATH_LENGTH}`],
      ['jobs', `exit_code BETWEEN 0 AND ${MAX_WORKER_EXIT_CODE}`],
      ['jobs', `length(session_lost_url) BETWEEN 1 AND ${MAX_WORKER_NOTICE_URL_LENGTH}`],
      ['jobs', `length(login_stage_summary) <= ${MAX_LOGIN_STAGE_SUMMARY_LENGTH}`],
      ['jobs', `length(session_loss) <= ${MAX_SESSION_LOSS_RECORD_LENGTH}`],
      ['read_checks', `length(target_page_path) BETWEEN 1 AND ${MAX_READ_CHECK_PAGE_PATH_LENGTH}`],
      ['write_results', `length(target_record_id) BETWEEN 1 AND ${MAX_SAFE_RECORD_ID_LENGTH}`],
      ['write_results', `http_status BETWEEN ${MIN_HTTP_STATUS} AND ${MAX_HTTP_STATUS}`],
      ['write_results', `length(record_id) BETWEEN 1 AND ${MAX_RECORD_ID_LENGTH}`],
      ['write_results', `length(api_origin) BETWEEN 1 AND ${MAX_URL_LENGTH}`],
      ['write_results', `length(api_path_shape) BETWEEN 1 AND ${MAX_API_SHAPE_PATH_LENGTH}`],
    ];
    expect(fragments.filter(([table, fragment]) => !statementOf(table).includes(fragment))).toEqual([]);
    expect(MAX_SCENARIO_API_PATH_LENGTH).toBe(MAX_API_SHAPE_PATH_LENGTH);
  });
});

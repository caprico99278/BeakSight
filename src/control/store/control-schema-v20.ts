// 管理データの版 20 の文（URL-LEN。設計書 `2026-11-09-beaksight-remove-limits-design.md` 1〜3 章。URL の長さの上限の撤廃）。凍結。
// - 版 20: URL と URL の path の長さの上限（2,048・1,024）と、URL を含む JSON の全体の長さの上限（32,768・65,536）だけを外す。空でないこと（1 文字以上）、
//   `/` で始まること、使える文字・JSON の形の決まりは残す。
//   - 発見の索引（`discovery_candidates`）の `page_path`・`action_path`（2,048。版 18 の文から）。
//   - ジョブ（`jobs`）の `session_lost_url`（2,048）、`login_stage_summary`（32,768）、`session_loss`（65,536）（版 17 の文から）。
//   - 書き込みの結果（`write_results`）の `api_origin`（2,048）、`api_path_shape`（1,024）（版 19 の文から）。
//   - READ の確かめの定義（`read_checks`）の `target_page_path`（1,024。版 17 の文から）。
// - SQLite は CHECK を外せないので、前の版の表の文から上限だけを除いた表を作り、行を写し、元の表と替えて、索引を作り直す（列の順・ほかの CHECK・外部キーは
//   前の版のまま。文は前の版の文の凍結の写しで、違いは上限の句と、写しの表の名前だけ。`tests/integration/control-store-migrations.test.ts` で確かめる）。
// - ほかの表から参照されない表（発見の索引・ジョブ・書き込みの結果）は、写しの表を作って行を写し、元と替える（版 18・19 と同じ組）。
// - READ の確かめの定義（確かめの結果から外部キーで参照される）は、外部キーが入れ替わりの表を指さないよう、表の名前を替えない。行を制約のない仮の表に退け、
//   元の表を消して同じ名前で作り直し、行を戻す（版 19 の実行の許可と同じ組）。外部キーの確かめはトランザクションの終わりまで延ばす（`PRAGMA defer_foreign_keys`）。
// - 走らせるのは版の管理（`migrations.ts` の `runControlMigrations`）だけ（トランザクションの中で、`user_version` と一緒に）。
// - 文の中の digest の接頭辞（`sha256:`）は、版 17 と同じく fingerprint の owner（`createSha256Fingerprint`）の形から取る（GATE-ARCH06）。
import { createSha256Fingerprint } from '../../core/ids.js';

/** fingerprint の形の例（空の文字列の digest）。 */
const SAMPLE_FINGERPRINT = createSha256Fingerprint('');
/** digest の接頭辞（`<方式>:`）。 */
const DIGEST_PREFIX = SAMPLE_FINGERPRINT.slice(0, SAMPLE_FINGERPRINT.indexOf(':') + 1);

/** 書き込みの結果の表の列（版 19 の列の順。行を写すときに、列の名前で対応させる）。 */
const WRITE_RESULTS_COLUMNS = [
  'job_id', 'grant_id', 'profile_id', 'scenario_id', 'scenario_revision', 'write_kind', 'target_record_id', 'seed_record', 'submitted_values', 'unique_key',
  'phone_numbers', 'submission', 'block_reason', 'http_status', 'response_judgement', 'record_id', 'read_verification', 'update_evidence', 'result', 'reason',
  'reservation_state', 'recorded_at', 'submitted_at', 'settled_at', 'transport', 'api_shape_digest', 'api_method', 'api_origin', 'api_path_shape',
].join(', ');

/** 版 20 の文（作れる順）。 */
const CONTROL_SCHEMA_V20_STATEMENTS: readonly string[] = Object.freeze([
  'PRAGMA defer_foreign_keys = ON',
  `CREATE TABLE discovery_candidates_v20 (
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    identity_digest TEXT NOT NULL CHECK (length(identity_digest) = 71 AND substr(identity_digest, 1, 7) = '${DIGEST_PREFIX}' AND substr(identity_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    rule_digest TEXT NOT NULL CHECK (length(rule_digest) = 71 AND substr(rule_digest, 1, 7) = '${DIGEST_PREFIX}' AND substr(rule_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    classification TEXT NOT NULL CHECK (classification IN ('READ', 'CREATE', 'UPDATE', 'NOT_EXECUTABLE', 'NEEDS_BINDING', 'UNSUPPORTED_READ_TRANSPORT', 'BLOCKED_EXTERNAL', 'DISPLAY_ONLY')),
    reason_code TEXT NOT NULL CHECK (reason_code IN ('ACTION_OUTSIDE_ALLOWED_ORIGINS', 'DESTRUCTIVE', 'READ_GET_FORM', 'GET_WITH_PASSWORD_FIELD', 'GET_WITH_MULTIPART', 'POST_SEARCH', 'GRAPHQL_ENDPOINT', 'JS_BOUND', 'JS_DELEGATED', 'NO_KNOWN_ACTION', 'DIALOG_METHOD', 'METHOD_OVERRIDE_UNRECOGNIZED', 'UPDATE_METHOD', 'UPDATE_WORD', 'CREATE_WORD', 'UNCLASSIFIED', 'DUPLICATE_IDENTITY_CONFLICT')),
    page_path TEXT NOT NULL CHECK (length(page_path) >= 1 AND substr(page_path, 1, 1) = '/'),
    action_path TEXT CHECK (action_path IS NULL OR (length(action_path) >= 1 AND substr(action_path, 1, 1) = '/')),
    form_method TEXT CHECK (form_method IS NULL OR form_method IN ('GET', 'POST', 'DIALOG')),
    method_override TEXT CHECK (method_override IS NULL OR method_override IN ('PUT', 'PATCH', 'DELETE')),
    has_state_field INTEGER NOT NULL CHECK (has_state_field IN (0, 1)),
    first_seen_job_id TEXT NOT NULL CHECK (length(first_seen_job_id) > 0 AND first_seen_job_id NOT GLOB '*[^a-z0-9-]*'),
    first_seen_at TEXT NOT NULL CHECK (length(first_seen_at) = 14 AND first_seen_at NOT GLOB '*[^0-9]*'),
    last_seen_job_id TEXT NOT NULL CHECK (length(last_seen_job_id) > 0 AND last_seen_job_id NOT GLOB '*[^a-z0-9-]*'),
    last_seen_at TEXT NOT NULL CHECK (length(last_seen_at) = 14 AND last_seen_at NOT GLOB '*[^0-9]*'),
    last_changed_job_id TEXT CHECK (last_changed_job_id IS NULL OR (length(last_changed_job_id) > 0 AND last_changed_job_id NOT GLOB '*[^a-z0-9-]*')), templated_identity_digests TEXT
    CHECK (templated_identity_digests IS NULL OR (json_valid(templated_identity_digests) AND json_type(templated_identity_digests) = 'array')), shape_digests TEXT
    CHECK (shape_digests IS NULL OR (json_valid(shape_digests) AND json_type(shape_digests) = 'array')), key_field_digests TEXT
    CHECK (key_field_digests IS NULL OR (json_valid(key_field_digests) AND json_type(key_field_digests) = 'array')),
    PRIMARY KEY (profile_id, identity_digest),
    CHECK (classification = CASE reason_code WHEN 'ACTION_OUTSIDE_ALLOWED_ORIGINS' THEN 'BLOCKED_EXTERNAL' WHEN 'DESTRUCTIVE' THEN 'NOT_EXECUTABLE' WHEN 'READ_GET_FORM' THEN 'READ' WHEN 'GET_WITH_PASSWORD_FIELD' THEN 'UNSUPPORTED_READ_TRANSPORT' WHEN 'GET_WITH_MULTIPART' THEN 'UNSUPPORTED_READ_TRANSPORT' WHEN 'POST_SEARCH' THEN 'UNSUPPORTED_READ_TRANSPORT' WHEN 'GRAPHQL_ENDPOINT' THEN 'UNSUPPORTED_READ_TRANSPORT' WHEN 'JS_BOUND' THEN 'NEEDS_BINDING' WHEN 'JS_DELEGATED' THEN 'NEEDS_BINDING' WHEN 'NO_KNOWN_ACTION' THEN 'DISPLAY_ONLY' WHEN 'DIALOG_METHOD' THEN 'DISPLAY_ONLY' WHEN 'METHOD_OVERRIDE_UNRECOGNIZED' THEN 'DISPLAY_ONLY' WHEN 'UPDATE_METHOD' THEN 'UPDATE' WHEN 'UPDATE_WORD' THEN 'UPDATE' WHEN 'CREATE_WORD' THEN 'CREATE' WHEN 'UNCLASSIFIED' THEN 'DISPLAY_ONLY' WHEN 'DUPLICATE_IDENTITY_CONFLICT' THEN 'DISPLAY_ONLY' END),
    CHECK ((action_path IS NULL) = (form_method IS NULL)),
    CHECK (method_override IS NULL OR form_method IS NOT NULL),
    CHECK (first_seen_at <= last_seen_at)
  ) STRICT`,
  'INSERT INTO discovery_candidates_v20 SELECT * FROM discovery_candidates',
  'DROP TABLE discovery_candidates',
  'ALTER TABLE discovery_candidates_v20 RENAME TO discovery_candidates',
  'CREATE INDEX discovery_candidates_profile_last_seen ON discovery_candidates (profile_id, last_seen_at)',
  `CREATE TABLE jobs_v20 (
    job_id TEXT PRIMARY KEY NOT NULL CHECK (length(job_id) > 0 AND job_id NOT GLOB '*[^a-z0-9-]*'),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
    state TEXT NOT NULL CHECK (state IN ('STARTING', 'RUNNING', 'STOPPING', 'FINISHED', 'FAILED', 'INTERRUPTED')),
    start_new INTEGER NOT NULL CHECK (start_new IN (0, 1)),
    run_id TEXT CHECK (run_id IS NULL OR length(run_id) > 0),
    run_directory TEXT CHECK (run_directory IS NULL OR length(run_directory) BETWEEN 1 AND 1024),
    exit_code INTEGER CHECK (exit_code IS NULL OR exit_code BETWEEN 0 AND 255),
    run_status TEXT CHECK (run_status IS NULL OR run_status IN ('COMPLETE', 'PARTIAL', 'FAILED', 'ABORTED_BY_SAFETY')),
    end_kind TEXT CHECK (end_kind IS NULL OR end_kind IN ('RAN', 'RUN_ACTIVE', 'VERSION_MISMATCH', 'RUN_DIRECTORY_UNAVAILABLE', 'RESUME_UNAVAILABLE')),
    last_progress TEXT CHECK (last_progress IS NULL OR json_valid(last_progress)),
    last_notice TEXT CHECK (last_notice IS NULL OR json_valid(last_notice)),
    worker_pid INTEGER CHECK (worker_pid IS NULL OR worker_pid > 0),
    created_at TEXT NOT NULL CHECK (length(created_at) = 14 AND created_at NOT GLOB '*[^0-9]*'),
    started_at TEXT CHECK (started_at IS NULL OR (length(started_at) = 14 AND started_at NOT GLOB '*[^0-9]*')),
    finished_at TEXT CHECK (finished_at IS NULL OR (length(finished_at) = 14 AND finished_at NOT GLOB '*[^0-9]*')),
    last_heartbeat_at TEXT CHECK (last_heartbeat_at IS NULL OR (length(last_heartbeat_at) = 14 AND last_heartbeat_at NOT GLOB '*[^0-9]*')),
    stop_requested_at TEXT CHECK (stop_requested_at IS NULL OR (length(stop_requested_at) = 14 AND stop_requested_at NOT GLOB '*[^0-9]*')),
    failure_reason TEXT CHECK (failure_reason IS NULL OR failure_reason IN ('CONFIG_ERROR', 'ARTIFACT_WRITE_FAILED', 'UNEXPECTED_FAILURE', 'PROTOCOL_VIOLATION', 'START_TIMEOUT', 'CONFIG_CHANGED', 'AUTH_SETUP_CHANGED', 'AUTH_SETUP_REQUIRED', 'UNSUPPORTED_AUTH_STATE', 'LOGIN_TIMEOUT', 'LOGIN_ATTEMPTS_EXCEEDED', 'WORKER_START_FAILED', 'WORKER_NOT_READY', 'WORKER_EXITED', 'WORKER_UNRESPONSIVE', 'STOP_TIMEOUT', 'SERVER_RESTARTED', 'SERVER_SHUTDOWN', 'INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'MFA_REQUIRED', 'CREDENTIAL_EXPIRED', 'RATE_LIMITED', 'AUTH_RESULT_UNKNOWN', 'LOGIN_FORM_INVALID', 'LOGIN_FORM_INPUT_FAILED', 'CREDENTIAL_CHANGED', 'CREDENTIAL_UNAVAILABLE', 'UNEXPECTED_LOGIN_REQUEST', 'JOB_KIND_NOT_SUPPORTED', 'DISCOVERY_RESULT_INVALID', 'READ_CHECK_RESULT_INVALID', 'WRITE_GRANT_REJECTED', 'WRITE_RESULT_INVALID', 'ENTRY_CHECK_RESULT_INVALID')),
    last_auth_state TEXT CHECK (last_auth_state IS NULL OR last_auth_state IN ('AWAITING_LOGIN', 'AUTHENTICATED', 'AUTH_SETUP_REQUIRED', 'UNSUPPORTED_AUTH_STATE', 'SESSION_LOST', 'LOGIN_TIMEOUT', 'LOGIN_ATTEMPTS_EXCEEDED', 'AUTOMATED_LOGIN_FAILED')),
    session_lost_url TEXT CHECK (session_lost_url IS NULL OR length(session_lost_url) >= 1),
    job_kind TEXT NOT NULL CHECK (job_kind IN ('AUDIT', 'LOGIN_CHECK', 'DISCOVERY', 'READ_CHECK', 'WRITE_CREATE', 'WRITE_UPDATE', 'ENTRY_CHECK')),
    write_report_check TEXT
      CHECK (write_report_check IS NULL OR (write_report_check IN ('VALID', 'REPORT_MISSING', 'REPORT_INVALID', 'REPORT_MISMATCH', 'APPROVAL_FACTS_MISMATCH', 'BUNDLE_MISMATCH', 'RESULT_INVALID')
        AND job_kind IN ('WRITE_CREATE', 'WRITE_UPDATE'))),
    login_stage_summary TEXT
      CHECK (login_stage_summary IS NULL OR (json_valid(login_stage_summary) AND json_type(login_stage_summary) = 'object')), session_loss TEXT
    CHECK (session_loss IS NULL OR (json_valid(session_loss) AND json_type(session_loss) = 'object')),
    CHECK ((state IN ('FINISHED', 'FAILED', 'INTERRUPTED')) = (finished_at IS NOT NULL)),
    CHECK ((state IN ('FAILED', 'INTERRUPTED')) = (failure_reason IS NOT NULL))
  ) STRICT`,
  'INSERT INTO jobs_v20 SELECT * FROM jobs',
  'DROP TABLE jobs',
  'ALTER TABLE jobs_v20 RENAME TO jobs',
  `CREATE UNIQUE INDEX jobs_single_active ON jobs ((state IN ('STARTING', 'RUNNING', 'STOPPING'))) WHERE state IN ('STARTING', 'RUNNING', 'STOPPING')`,
  `CREATE INDEX jobs_created_at ON jobs (created_at)`,
  `CREATE TABLE write_results_v20 (
    job_id TEXT PRIMARY KEY NOT NULL CHECK (length(job_id) > 0 AND job_id NOT GLOB '*[^a-z0-9-]*'),
    grant_id TEXT NOT NULL UNIQUE REFERENCES execution_grants (grant_id),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    scenario_id TEXT NOT NULL REFERENCES scenarios (scenario_id),
    scenario_revision INTEGER NOT NULL CHECK (scenario_revision >= 1),
    write_kind TEXT NOT NULL CHECK (write_kind IN ('CREATE', 'UPDATE')),
    target_record_id TEXT CHECK (target_record_id IS NULL OR (length(target_record_id) >= 1 AND target_record_id NOT GLOB '*[^A-Za-z0-9_-]*')),
    seed_record TEXT CHECK (seed_record IS NULL OR (json_valid(seed_record) AND json_type(seed_record) = 'object')),
    submitted_values TEXT NOT NULL CHECK (json_valid(submitted_values) AND json_type(submitted_values) = 'object'),
    unique_key TEXT CHECK (unique_key IS NULL OR length(unique_key) > 0),
    phone_numbers TEXT NOT NULL CHECK (json_valid(phone_numbers) AND json_type(phone_numbers) = 'array'),
    submission TEXT CHECK (submission IS NULL OR submission IN ('NOT_SENT', 'SENT', 'UNKNOWN')),
    block_reason TEXT CHECK (block_reason IS NULL OR block_reason IN ('PAYLOAD_MISMATCH', 'PRECHECK_FAILED')),
    http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
    response_judgement TEXT CHECK (response_judgement IS NULL OR response_judgement IN ('SUCCESS', 'INPUT_ERROR', 'RATE_LIMITED', 'SERVER_ERROR', 'NO_CONDITION_MATCHED', 'MULTIPLE_CONDITIONS_MATCHED', 'SESSION_LOST', 'REPOST_REDIRECT', 'RESPONSE_NOT_DELIVERED')),
    record_id TEXT CHECK (record_id IS NULL OR length(record_id) >= 1),
    read_verification TEXT CHECK (read_verification IS NULL OR read_verification IN ('MATCHED', 'NOT_MATCHED', 'UNDETERMINED', 'READ_BLOCKED_BY_POLICY', 'READ_CANDIDATE_DRIFTED', 'READ_CANDIDATE_NOT_READ')),
    update_evidence TEXT CHECK (update_evidence IS NULL OR (json_valid(update_evidence) AND json_type(update_evidence) = 'object')),
    result TEXT CHECK (result IS NULL OR result IN ('VERIFIED', 'PARTIAL', 'BLOCKED', 'UNKNOWN', 'FAILED')),
    reason TEXT CHECK (reason IS NULL OR reason IN ('PAYLOAD_MISMATCH', 'PRECHECK_FAILED', 'NO_RESPONSE', 'INPUT_ERROR', 'RATE_LIMITED', 'SERVER_ERROR', 'NO_CONDITION_MATCHED', 'MULTIPLE_CONDITIONS_MATCHED', 'SESSION_LOST', 'REPOST_REDIRECT', 'RESPONSE_NOT_DELIVERED', 'RECORD_ID_NOT_FOUND', 'RECORD_ID_UNSAFE', 'READ_VERIFICATION_MATCHED', 'READ_VERIFICATION_NOT_MATCHED', 'READ_VERIFICATION_UNDETERMINED', 'RECORD_ID_MISMATCH', 'UNEXPECTED_FIELD_CHANGE', 'UPDATE_POSTCHECK_UNDETERMINED')),
    reservation_state TEXT CHECK (reservation_state IS NULL OR reservation_state IN ('COMMITTED', 'UNKNOWN', 'RELEASED')),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 14 AND recorded_at NOT GLOB '*[^0-9]*'),
    submitted_at TEXT CHECK (submitted_at IS NULL OR (length(submitted_at) = 14 AND submitted_at NOT GLOB '*[^0-9]*')),
    settled_at TEXT CHECK (settled_at IS NULL OR (length(settled_at) = 14 AND settled_at NOT GLOB '*[^0-9]*')),
    transport TEXT NOT NULL DEFAULT 'FORM' CHECK (transport IN ('FORM', 'API')),
    api_shape_digest TEXT CHECK (api_shape_digest IS NULL OR (length(api_shape_digest) = 71 AND substr(api_shape_digest, 1, 7) = '${DIGEST_PREFIX}' AND substr(api_shape_digest, 8) NOT GLOB '*[^0-9a-f]*')),
    api_method TEXT CHECK (api_method IS NULL OR api_method IN ('POST', 'PATCH')),
    api_origin TEXT CHECK (api_origin IS NULL OR length(api_origin) >= 1),
    api_path_shape TEXT CHECK (api_path_shape IS NULL OR (length(api_path_shape) >= 1
      AND substr(api_path_shape, 1, 1) = '/')),
    CHECK ((settled_at IS NULL) = (result IS NULL)),
    CHECK ((result IS NULL) = (reason IS NULL)),
    CHECK ((result IS NULL) = (reservation_state IS NULL)),
    CHECK ((result IS NULL) = (submission IS NULL)),
    CHECK (result IS NOT NULL OR (block_reason IS NULL AND http_status IS NULL AND response_judgement IS NULL AND record_id IS NULL
      AND read_verification IS NULL AND submitted_at IS NULL)),
    CHECK (submission IS NULL OR (submission = 'NOT_SENT') = (block_reason IS NOT NULL)),
    CHECK (submission IS NOT 'NOT_SENT' OR (result = 'BLOCKED' AND reservation_state = 'RELEASED'
      AND http_status IS NULL AND response_judgement IS NULL AND record_id IS NULL AND read_verification IS NULL AND submitted_at IS NULL)),
    CHECK (submission IS NULL OR submission = 'NOT_SENT'
      OR (result IS NOT 'BLOCKED' AND reservation_state IS NOT 'RELEASED')),
    CHECK (result IS NOT 'VERIFIED' OR (response_judgement = 'SUCCESS' AND record_id IS NOT NULL
      AND read_verification = 'MATCHED')),
    CHECK (submitted_at IS NULL OR submitted_at >= recorded_at),
    CHECK (settled_at IS NULL OR settled_at >= recorded_at),
    CHECK ((write_kind = 'UPDATE') = (target_record_id IS NOT NULL)),
    CHECK (update_evidence IS NULL OR (write_kind = 'UPDATE' AND result IS NOT NULL)),
    CHECK (write_kind IS NOT 'UPDATE' OR result IS NOT 'VERIFIED' OR update_evidence IS NOT NULL),
    CHECK ((transport = 'API') = (api_shape_digest IS NOT NULL)),
    CHECK ((api_shape_digest IS NULL) = (api_method IS NULL) AND (api_shape_digest IS NULL) = (api_origin IS NULL)
      AND (api_shape_digest IS NULL) = (api_path_shape IS NULL))
  ) STRICT`,
  `INSERT INTO write_results_v20 (${WRITE_RESULTS_COLUMNS})
    SELECT ${WRITE_RESULTS_COLUMNS} FROM write_results`,
  'DROP TABLE write_results',
  'ALTER TABLE write_results_v20 RENAME TO write_results',
  'CREATE INDEX write_results_scenario_recorded ON write_results (scenario_id, recorded_at)',
  'CREATE INDEX write_results_profile ON write_results (profile_id)',
  'CREATE TABLE read_checks_v20_rows AS SELECT * FROM read_checks',
  'DROP TABLE read_checks',
  `CREATE TABLE "read_checks" (
    read_check_id TEXT PRIMARY KEY NOT NULL CHECK (length(read_check_id) > 0 AND read_check_id NOT GLOB '*[^a-z0-9-]*'),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    target_identity_digest TEXT CHECK (target_identity_digest IS NULL OR (length(target_identity_digest) = 71 AND substr(target_identity_digest, 1, 7) = '${DIGEST_PREFIX}' AND substr(target_identity_digest, 8) NOT GLOB '*[^0-9a-f]*')),
    parameters TEXT NOT NULL CHECK (json_valid(parameters) AND json_type(parameters) = 'object'),
    expectations TEXT NOT NULL CHECK (json_valid(expectations) AND json_type(expectations) = 'array'),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL CHECK (length(created_at) = 14 AND created_at NOT GLOB '*[^0-9]*'),
    updated_at TEXT NOT NULL CHECK (length(updated_at) = 14 AND updated_at NOT GLOB '*[^0-9]*'),
    canceled_at TEXT CHECK (canceled_at IS NULL OR (length(canceled_at) = 14 AND canceled_at NOT GLOB '*[^0-9]*')),
    target_page_path TEXT CHECK (target_page_path IS NULL OR (length(target_page_path) >= 1 AND substr(target_page_path, 1, 1) = '/' AND substr(target_page_path, 2, 1) <> '/' AND instr(target_page_path, '?') = 0 AND instr(target_page_path, '#') = 0 AND instr(target_page_path, char(92)) = 0 AND target_page_path NOT GLOB ('*[' || char(9, 10, 11, 12, 13, 32) || ']*'))),
    CHECK (created_at <= updated_at),
    CHECK ((target_identity_digest IS NULL) <> (target_page_path IS NULL)),
    CHECK (target_page_path IS NULL OR parameters = '{}')
  ) STRICT`,
  'INSERT INTO read_checks SELECT * FROM read_checks_v20_rows',
  'DROP TABLE read_checks_v20_rows',
  `CREATE INDEX read_checks_profile_created ON read_checks (profile_id, created_at)`,
]);

/** 版 20（版と文。凍結）。 */
export const CONTROL_SCHEMA_V20: { readonly version: number; readonly statements: readonly string[] } = Object.freeze({
  version: 20,
  statements: CONTROL_SCHEMA_V20_STATEMENTS,
});

// 管理データの基準の版 17 の文（LG-2。設計書 `2026-10-24-beaksight-test-suite-tiers-design.md` 3.7.1）。凍結。
// - 版 17 は公開済み（利用者の管理データの版）。空の所から管理データを作るときは、この文をそのまま流す（版 1〜16 の段は持たない）。
// - 中身は、LG-2 で捨てる前の版 1→17 の段で作った管理データの `sqlite_schema.sql` を、そのまま写した文（列の順と引用符も、利用者の管理データと
//   同じ）。並びは作れる順（写した管理データの `sqlite_schema` の rowid の順。自動の索引と `sqlite_` の内部の表は除く）。
// - 今の名前つきの一覧（`AUDIT_SEND_POLICIES` など）や定数を参照しない。値の一覧を足したり変えたりするときは、ここを変えず、版 18 から後の段
//   （`migrations.ts` の `CONTROL_MIGRATIONS`）として足す。
// - 新しく作った管理データの形と、写し取った fixture（`tests/fixtures/control-schema/v17-schema.json`）が同じこと、文の SHA-256、今の名前つきの
//   一覧と CHECK の値が等しいことは、`tests/integration/control-store-base-schema.test.ts` で確かめる。
// - 走らせるのは版の管理（`migrations.ts` の `runControlMigrations`）だけ（トランザクションの中で、seed と `user_version` と一緒に）。文の配列は
//   公開せず、版の一覧と同じデータの形（`CONTROL_SCHEMA_V17`）で渡す（Architecture Gate `control-store-boundary.test.ts` の (g)。外で流す漏れを見る）。
// - 文の中の digest の接頭辞（`sha256:`）だけは、fingerprint の owner（`createSha256Fingerprint`）の形から取る（Architecture Gate GATE-ARCH06 は、
//   `sha256` を含む文字列を owner の外に書かせない。LG-2 の前の `migrations.ts` と同じ取り方）。生成される文は写した文と同じ（SHA-256 で固定）。
import { createSha256Fingerprint } from '../../core/ids.js';

/** fingerprint の形の例（空の文字列の digest）。 */
const SAMPLE_FINGERPRINT = createSha256Fingerprint('');
/** digest の接頭辞（`<方式>:`）。 */
const DIGEST_PREFIX = SAMPLE_FINGERPRINT.slice(0, SAMPLE_FINGERPRINT.indexOf(':') + 1);

/** 基準の版 17 の文（表・索引。作れる順）。 */
const CONTROL_SCHEMA_V17_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE profiles (
    profile_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')),
    document TEXT NOT NULL CHECK (json_valid(document)),
    updated_at TEXT NOT NULL CHECK (length(updated_at) = 14 AND updated_at NOT GLOB '*[^0-9]*')
  ) STRICT`,
  `CREATE TABLE profile_revisions (
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    document TEXT NOT NULL CHECK (json_valid(document)),
    change_kind TEXT NOT NULL CHECK (change_kind IN ('CREATED', 'UPDATED', 'RETIRED')),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 14 AND recorded_at NOT GLOB '*[^0-9]*'),
    PRIMARY KEY (profile_id, revision)
  ) STRICT`,
  `CREATE TABLE store_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE control_instance (
    slot INTEGER PRIMARY KEY NOT NULL CHECK (slot = 1),
    process_id INTEGER NOT NULL CHECK (process_id > 0),
    booted_at_ms INTEGER NOT NULL CHECK (booted_at_ms >= 0),
    acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
    heartbeat_at_ms INTEGER NOT NULL CHECK (heartbeat_at_ms >= 0),
    port INTEGER CHECK (port IS NULL OR port BETWEEN 1 AND 65535)
  ) STRICT`,
  `CREATE TABLE auth_setups (
    profile_id TEXT PRIMARY KEY NOT NULL REFERENCES profiles (profile_id),
    profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
    document TEXT NOT NULL CHECK (json_valid(document)),
    updated_at TEXT NOT NULL CHECK (length(updated_at) = 14 AND updated_at NOT GLOB '*[^0-9]*')
  ) STRICT`,
  `CREATE TABLE auto_login_attempts (
    attempt_id INTEGER PRIMARY KEY NOT NULL,
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    job_id TEXT NOT NULL UNIQUE CHECK (length(job_id) > 0 AND job_id NOT GLOB '*[^a-z0-9-]*'),
    started_at TEXT NOT NULL CHECK (length(started_at) = 14 AND started_at NOT GLOB '*[^0-9]*'),
    credential_revision INTEGER NOT NULL CHECK (credential_revision >= 1),
    result TEXT CHECK (result IS NULL OR result IN ('SUCCEEDED', 'INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'MFA_REQUIRED', 'CREDENTIAL_EXPIRED', 'RATE_LIMITED', 'AUTH_RESULT_UNKNOWN', 'LOGIN_FORM_INVALID', 'LOGIN_FORM_INPUT_FAILED', 'CREDENTIAL_CHANGED', 'CREDENTIAL_UNAVAILABLE', 'UNEXPECTED_LOGIN_REQUEST')),
    submitted TEXT CHECK (submitted IS NULL OR submitted IN ('YES', 'NO', 'UNKNOWN')),
    retry_after_until TEXT CHECK (retry_after_until IS NULL OR (length(retry_after_until) = 14 AND retry_after_until NOT GLOB '*[^0-9]*')),
    result_recorded_at TEXT CHECK (result_recorded_at IS NULL OR (length(result_recorded_at) = 14 AND result_recorded_at NOT GLOB '*[^0-9]*')),
    form_invalid_reason TEXT CHECK (form_invalid_reason IS NULL OR form_invalid_reason IN ('SELECTOR_NOT_UNIQUE', 'USERNAME_FIELD_INVALID', 'PASSWORD_FIELD_INVALID', 'SUBMIT_BUTTON_INVALID', 'NOT_SAME_FORM', 'METHOD_NOT_POST', 'ACTION_NOT_ALLOWED', 'FORM_TARGET_NOT_SELF', 'FORM_UNREADABLE')),
    CHECK (form_invalid_reason IS NULL OR result = 'LOGIN_FORM_INVALID'),
    CHECK ((result IS NULL) = (submitted IS NULL)),
    CHECK ((result IS NULL) = (result_recorded_at IS NULL)),
    CHECK (retry_after_until IS NULL OR result = 'RATE_LIMITED'),
    CHECK (result IS NULL OR result <> 'SUCCEEDED' OR submitted = 'YES')
  ) STRICT`,
  `CREATE INDEX auto_login_attempts_profile_started ON auto_login_attempts (profile_id, started_at)`,
  `CREATE TABLE auto_login_holds (
    hold_id INTEGER PRIMARY KEY NOT NULL,
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    reason TEXT NOT NULL CHECK (reason IN ('INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'MFA_REQUIRED', 'CREDENTIAL_EXPIRED', 'RATE_LIMITED', 'AUTH_RESULT_UNKNOWN', 'LOGIN_FORM_INVALID', 'LOGIN_FORM_INPUT_FAILED', 'CREDENTIAL_CHANGED', 'CREDENTIAL_UNAVAILABLE', 'UNEXPECTED_LOGIN_REQUEST')),
    held_at TEXT NOT NULL CHECK (length(held_at) = 14 AND held_at NOT GLOB '*[^0-9]*'),
    attempt_id INTEGER NOT NULL CHECK (attempt_id > 0),
    cleared_at TEXT CHECK (cleared_at IS NULL OR (length(cleared_at) = 14 AND cleared_at NOT GLOB '*[^0-9]*'))
  ) STRICT`,
  `CREATE UNIQUE INDEX auto_login_holds_single_active ON auto_login_holds (profile_id) WHERE cleared_at IS NULL`,
  `CREATE TABLE credential_events (
    event_id INTEGER PRIMARY KEY NOT NULL,
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 14 AND recorded_at NOT GLOB '*[^0-9]*'),
    kind TEXT NOT NULL CHECK (kind IN ('CREATED', 'USERNAME_CHANGED', 'PASSWORD_CHANGED', 'BOTH_CHANGED', 'DELETED', 'HOLD_CLEARED')),
    credential_revision INTEGER CHECK (credential_revision IS NULL OR credential_revision >= 1)
  ) STRICT`,
  `CREATE INDEX credential_events_profile_recorded ON credential_events (profile_id, recorded_at)`,
  `CREATE TABLE discovery_candidates (
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    identity_digest TEXT NOT NULL CHECK (length(identity_digest) = 71 AND substr(identity_digest, 1, 7) = '${DIGEST_PREFIX}' AND substr(identity_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    rule_digest TEXT NOT NULL CHECK (length(rule_digest) = 71 AND substr(rule_digest, 1, 7) = '${DIGEST_PREFIX}' AND substr(rule_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    classification TEXT NOT NULL CHECK (classification IN ('READ', 'CREATE', 'UPDATE', 'NOT_EXECUTABLE', 'NEEDS_BINDING', 'UNSUPPORTED_READ_TRANSPORT', 'BLOCKED_EXTERNAL', 'DISPLAY_ONLY')),
    reason_code TEXT NOT NULL CHECK (reason_code IN ('ACTION_OUTSIDE_ALLOWED_ORIGINS', 'DESTRUCTIVE', 'READ_GET_FORM', 'GET_WITH_PASSWORD_FIELD', 'GET_WITH_MULTIPART', 'POST_SEARCH', 'GRAPHQL_ENDPOINT', 'JS_BOUND', 'JS_DELEGATED', 'NO_KNOWN_ACTION', 'DIALOG_METHOD', 'METHOD_OVERRIDE_UNRECOGNIZED', 'UPDATE_METHOD', 'UPDATE_WORD', 'CREATE_WORD', 'UNCLASSIFIED', 'DUPLICATE_IDENTITY_CONFLICT')),
    page_path TEXT NOT NULL CHECK (length(page_path) BETWEEN 1 AND 2048 AND substr(page_path, 1, 1) = '/'),
    action_path TEXT CHECK (action_path IS NULL OR (length(action_path) BETWEEN 1 AND 2048 AND substr(action_path, 1, 1) = '/')),
    form_method TEXT CHECK (form_method IS NULL OR form_method IN ('GET', 'POST', 'DIALOG')),
    method_override TEXT CHECK (method_override IS NULL OR method_override IN ('PUT', 'PATCH', 'DELETE')),
    has_state_field INTEGER NOT NULL CHECK (has_state_field IN (0, 1)),
    first_seen_job_id TEXT NOT NULL CHECK (length(first_seen_job_id) > 0 AND first_seen_job_id NOT GLOB '*[^a-z0-9-]*'),
    first_seen_at TEXT NOT NULL CHECK (length(first_seen_at) = 14 AND first_seen_at NOT GLOB '*[^0-9]*'),
    last_seen_job_id TEXT NOT NULL CHECK (length(last_seen_job_id) > 0 AND last_seen_job_id NOT GLOB '*[^a-z0-9-]*'),
    last_seen_at TEXT NOT NULL CHECK (length(last_seen_at) = 14 AND last_seen_at NOT GLOB '*[^0-9]*'),
    last_changed_job_id TEXT CHECK (last_changed_job_id IS NULL OR (length(last_changed_job_id) > 0 AND last_changed_job_id NOT GLOB '*[^a-z0-9-]*')), templated_identity_digests TEXT
    CHECK (templated_identity_digests IS NULL OR (json_valid(templated_identity_digests) AND json_type(templated_identity_digests) = 'array')), shape_digests TEXT
    CHECK (shape_digests IS NULL OR (json_valid(shape_digests) AND json_type(shape_digests) = 'array'
      AND json_array_length(shape_digests) <= 3)), key_field_digests TEXT
    CHECK (key_field_digests IS NULL OR (json_valid(key_field_digests) AND json_type(key_field_digests) = 'array'
      AND json_array_length(key_field_digests) <= 3)),
    PRIMARY KEY (profile_id, identity_digest),
    CHECK (classification = CASE reason_code WHEN 'ACTION_OUTSIDE_ALLOWED_ORIGINS' THEN 'BLOCKED_EXTERNAL' WHEN 'DESTRUCTIVE' THEN 'NOT_EXECUTABLE' WHEN 'READ_GET_FORM' THEN 'READ' WHEN 'GET_WITH_PASSWORD_FIELD' THEN 'UNSUPPORTED_READ_TRANSPORT' WHEN 'GET_WITH_MULTIPART' THEN 'UNSUPPORTED_READ_TRANSPORT' WHEN 'POST_SEARCH' THEN 'UNSUPPORTED_READ_TRANSPORT' WHEN 'GRAPHQL_ENDPOINT' THEN 'UNSUPPORTED_READ_TRANSPORT' WHEN 'JS_BOUND' THEN 'NEEDS_BINDING' WHEN 'JS_DELEGATED' THEN 'NEEDS_BINDING' WHEN 'NO_KNOWN_ACTION' THEN 'DISPLAY_ONLY' WHEN 'DIALOG_METHOD' THEN 'DISPLAY_ONLY' WHEN 'METHOD_OVERRIDE_UNRECOGNIZED' THEN 'DISPLAY_ONLY' WHEN 'UPDATE_METHOD' THEN 'UPDATE' WHEN 'UPDATE_WORD' THEN 'UPDATE' WHEN 'CREATE_WORD' THEN 'CREATE' WHEN 'UNCLASSIFIED' THEN 'DISPLAY_ONLY' WHEN 'DUPLICATE_IDENTITY_CONFLICT' THEN 'DISPLAY_ONLY' END),
    CHECK ((action_path IS NULL) = (form_method IS NULL)),
    CHECK (method_override IS NULL OR form_method IS NOT NULL),
    CHECK (first_seen_at <= last_seen_at)
  ) STRICT`,
  `CREATE INDEX discovery_candidates_profile_last_seen ON discovery_candidates (profile_id, last_seen_at)`,
  `CREATE TABLE discovery_jobs (
    job_id TEXT PRIMARY KEY NOT NULL CHECK (length(job_id) > 0 AND job_id NOT GLOB '*[^a-z0-9-]*'),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 14 AND recorded_at NOT GLOB '*[^0-9]*'),
    read_page_paths TEXT NOT NULL CHECK (json_valid(read_page_paths) AND json_type(read_page_paths) = 'array'
      AND json_array_length(read_page_paths) <= 10000)
  ) STRICT`,
  `CREATE INDEX discovery_jobs_profile_recorded ON discovery_jobs (profile_id, recorded_at)`,
  `CREATE TABLE scenarios (
    scenario_id TEXT PRIMARY KEY NOT NULL CHECK (length(scenario_id) > 0 AND scenario_id NOT GLOB '*[^a-z0-9-]*'),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    state TEXT NOT NULL CHECK (state IN ('DRAFT', 'APPROVED', 'REVOKED')),
    last_approval_receipt_id TEXT CHECK (last_approval_receipt_id IS NULL OR (length(last_approval_receipt_id) > 0 AND last_approval_receipt_id NOT GLOB '*[^a-z0-9-]*')),
    created_at TEXT NOT NULL CHECK (length(created_at) = 14 AND created_at NOT GLOB '*[^0-9]*'),
    updated_at TEXT NOT NULL CHECK (length(updated_at) = 14 AND updated_at NOT GLOB '*[^0-9]*'),
    CHECK (created_at <= updated_at),
    CHECK (state = 'DRAFT' OR last_approval_receipt_id IS NOT NULL)
  ) STRICT`,
  `CREATE INDEX scenarios_profile_created ON scenarios (profile_id, created_at)`,
  `CREATE TABLE scenario_revisions (
    scenario_id TEXT NOT NULL REFERENCES scenarios (scenario_id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    document TEXT NOT NULL CHECK (json_valid(document) AND json_type(document) = 'object'),
    evidence TEXT NOT NULL CHECK (json_valid(evidence) AND json_type(evidence) = 'object'),
    discovery_job_id TEXT NOT NULL CHECK (length(discovery_job_id) > 0 AND discovery_job_id NOT GLOB '*[^a-z0-9-]*'),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 14 AND recorded_at NOT GLOB '*[^0-9]*'),
    PRIMARY KEY (scenario_id, revision)
  ) STRICT`,
  `CREATE TABLE approval_receipts (
    receipt_id TEXT PRIMARY KEY NOT NULL CHECK (length(receipt_id) > 0 AND receipt_id NOT GLOB '*[^a-z0-9-]*'),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    scenario_id TEXT NOT NULL REFERENCES scenarios (scenario_id),
    kind TEXT NOT NULL CHECK (kind IN ('APPROVAL', 'REVOCATION')),
    scenario_revision INTEGER CHECK (scenario_revision IS NULL OR scenario_revision >= 1),
    approval_digest TEXT CHECK (approval_digest IS NULL OR (length(approval_digest) = 71 AND substr(approval_digest, 1, 7) = '${DIGEST_PREFIX}' AND substr(approval_digest, 8) NOT GLOB '*[^0-9a-f]*')),
    target_receipt_id TEXT REFERENCES approval_receipts (receipt_id),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 14 AND recorded_at NOT GLOB '*[^0-9]*'),
    expires_at TEXT CHECK (expires_at IS NULL OR (length(expires_at) = 14 AND expires_at NOT GLOB '*[^0-9]*')),
    document TEXT NOT NULL CHECK (json_valid(document) AND json_type(document) = 'object'),
    CHECK ((kind = 'APPROVAL') = (scenario_revision IS NOT NULL)),
    CHECK ((kind = 'APPROVAL') = (approval_digest IS NOT NULL)),
    CHECK ((kind = 'APPROVAL') = (expires_at IS NOT NULL)),
    CHECK ((kind = 'REVOCATION') = (target_receipt_id IS NOT NULL)),
    CHECK (expires_at IS NULL OR recorded_at < expires_at)
  ) STRICT`,
  `CREATE INDEX approval_receipts_scenario_recorded ON approval_receipts (scenario_id, recorded_at)`,
  `CREATE UNIQUE INDEX approval_receipts_single_revocation ON approval_receipts (target_receipt_id) WHERE target_receipt_id IS NOT NULL`,
  `CREATE TABLE execution_grants (
    grant_id TEXT PRIMARY KEY NOT NULL CHECK (length(grant_id) > 0 AND grant_id NOT GLOB '*[^a-z0-9-]*'),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    scenario_id TEXT NOT NULL REFERENCES scenarios (scenario_id),
    scenario_revision INTEGER NOT NULL CHECK (scenario_revision >= 1),
    approval_receipt_id TEXT NOT NULL REFERENCES approval_receipts (receipt_id),
    job_id TEXT NOT NULL UNIQUE CHECK (length(job_id) > 0 AND job_id NOT GLOB '*[^a-z0-9-]*'),
    issued_at TEXT NOT NULL CHECK (length(issued_at) = 14 AND issued_at NOT GLOB '*[^0-9]*'),
    expires_at TEXT NOT NULL CHECK (length(expires_at) = 14 AND expires_at NOT GLOB '*[^0-9]*'),
    consumed_at TEXT CHECK (consumed_at IS NULL OR (length(consumed_at) = 14 AND consumed_at NOT GLOB '*[^0-9]*')),
    invalidated_at TEXT CHECK (invalidated_at IS NULL OR (length(invalidated_at) = 14 AND invalidated_at NOT GLOB '*[^0-9]*')), target_record_id TEXT
    CHECK (target_record_id IS NULL OR (length(target_record_id) BETWEEN 1 AND 64 AND target_record_id NOT GLOB '*[^A-Za-z0-9_-]*')),
    CHECK (issued_at < expires_at),
    CHECK (consumed_at IS NULL OR invalidated_at IS NULL),
    CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
    CHECK (invalidated_at IS NULL OR invalidated_at >= issued_at)
  ) STRICT`,
  `CREATE UNIQUE INDEX execution_grants_single_open ON execution_grants (scenario_id) WHERE consumed_at IS NULL AND invalidated_at IS NULL`,
  `CREATE TABLE write_reservations (
    reservation_id INTEGER PRIMARY KEY NOT NULL,
    grant_id TEXT NOT NULL REFERENCES execution_grants (grant_id),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    scenario_id TEXT NOT NULL REFERENCES scenarios (scenario_id),
    count INTEGER NOT NULL CHECK (count BETWEEN 1 AND 1),
    state TEXT NOT NULL CHECK (state IN ('RESERVED', 'RELEASED', 'COMMITTED', 'UNKNOWN')),
    reserved_at TEXT NOT NULL CHECK (length(reserved_at) = 14 AND reserved_at NOT GLOB '*[^0-9]*'),
    settled_at TEXT CHECK (settled_at IS NULL OR (length(settled_at) = 14 AND settled_at NOT GLOB '*[^0-9]*')),
    CHECK ((state = 'RESERVED') = (settled_at IS NULL)),
    CHECK (settled_at IS NULL OR settled_at >= reserved_at)
  ) STRICT`,
  `CREATE INDEX write_reservations_scenario_state ON write_reservations (scenario_id, state)`,
  `CREATE UNIQUE INDEX write_reservations_single_per_grant ON write_reservations (grant_id)`,
  `CREATE TABLE rule_sets (
    rule_set_id TEXT PRIMARY KEY NOT NULL CHECK (length(rule_set_id) > 0 AND rule_set_id NOT GLOB '*[^a-z0-9-]*'),
    scenario_id TEXT NOT NULL UNIQUE REFERENCES scenarios (scenario_id),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL CHECK (length(created_at) = 14 AND created_at NOT GLOB '*[^0-9]*'),
    updated_at TEXT NOT NULL CHECK (length(updated_at) = 14 AND updated_at NOT GLOB '*[^0-9]*'),
    CHECK (created_at <= updated_at)
  ) STRICT`,
  `CREATE INDEX rule_sets_profile_created ON rule_sets (profile_id, created_at)`,
  `CREATE TABLE rule_set_revisions (
    rule_set_id TEXT NOT NULL REFERENCES rule_sets (rule_set_id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    scenario_id TEXT NOT NULL REFERENCES scenarios (scenario_id),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    document TEXT NOT NULL CHECK (json_valid(document) AND json_type(document) = 'object'),
    digest TEXT NOT NULL CHECK (length(digest) = 71 AND substr(digest, 1, 7) = '${DIGEST_PREFIX}' AND substr(digest, 8) NOT GLOB '*[^0-9a-f]*'),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 14 AND recorded_at NOT GLOB '*[^0-9]*'),
    PRIMARY KEY (rule_set_id, revision)
  ) STRICT`,
  `CREATE TABLE "jobs" (
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
    session_lost_url TEXT CHECK (session_lost_url IS NULL OR length(session_lost_url) BETWEEN 1 AND 2048),
    job_kind TEXT NOT NULL CHECK (job_kind IN ('AUDIT', 'LOGIN_CHECK', 'DISCOVERY', 'READ_CHECK', 'WRITE_CREATE', 'WRITE_UPDATE', 'ENTRY_CHECK')),
    write_report_check TEXT
      CHECK (write_report_check IS NULL OR (write_report_check IN ('VALID', 'REPORT_MISSING', 'REPORT_INVALID', 'REPORT_MISMATCH', 'APPROVAL_FACTS_MISMATCH', 'BUNDLE_MISMATCH', 'RESULT_INVALID')
        AND job_kind IN ('WRITE_CREATE', 'WRITE_UPDATE'))),
    login_stage_summary TEXT
      CHECK (login_stage_summary IS NULL OR (json_valid(login_stage_summary) AND json_type(login_stage_summary) = 'object'
        AND length(login_stage_summary) <= 32768)), session_loss TEXT
    CHECK (session_loss IS NULL OR (json_valid(session_loss) AND json_type(session_loss) = 'object'
      AND length(session_loss) <= 65536)),
    CHECK ((state IN ('FINISHED', 'FAILED', 'INTERRUPTED')) = (finished_at IS NOT NULL)),
    CHECK ((state IN ('FAILED', 'INTERRUPTED')) = (failure_reason IS NOT NULL))
  ) STRICT`,
  `CREATE UNIQUE INDEX jobs_single_active ON jobs ((state IN ('STARTING', 'RUNNING', 'STOPPING'))) WHERE state IN ('STARTING', 'RUNNING', 'STOPPING')`,
  `CREATE INDEX jobs_created_at ON jobs (created_at)`,
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
    target_page_path TEXT CHECK (target_page_path IS NULL OR (length(target_page_path) BETWEEN 1 AND 1024 AND substr(target_page_path, 1, 1) = '/' AND substr(target_page_path, 2, 1) <> '/' AND instr(target_page_path, '?') = 0 AND instr(target_page_path, '#') = 0 AND instr(target_page_path, char(92)) = 0 AND target_page_path NOT GLOB ('*[' || char(9, 10, 11, 12, 13, 32) || ']*'))),
    CHECK (created_at <= updated_at),
    CHECK ((target_identity_digest IS NULL) <> (target_page_path IS NULL)),
    CHECK (target_page_path IS NULL OR parameters = '{}')
  ) STRICT`,
  `CREATE TABLE "read_check_results" (
    result_id INTEGER PRIMARY KEY NOT NULL,
    job_id TEXT NOT NULL CHECK (length(job_id) > 0 AND job_id NOT GLOB '*[^a-z0-9-]*'),
    read_check_id TEXT NOT NULL REFERENCES "read_checks" (read_check_id),
    read_check_revision INTEGER NOT NULL CHECK (read_check_revision >= 1),
    result TEXT NOT NULL CHECK (result IN ('MATCHED', 'NOT_MATCHED', 'UNDETERMINED', 'READ_BLOCKED_BY_POLICY', 'READ_CANDIDATE_DRIFTED', 'READ_CANDIDATE_NOT_READ')),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 14 AND recorded_at NOT GLOB '*[^0-9]*'),
    UNIQUE (job_id, read_check_id)
  ) STRICT`,
  `CREATE INDEX read_checks_profile_created ON read_checks (profile_id, created_at)`,
  `CREATE INDEX read_check_results_check_recorded ON read_check_results (read_check_id, recorded_at)`,
  `CREATE TABLE "write_results" (
    job_id TEXT PRIMARY KEY NOT NULL CHECK (length(job_id) > 0 AND job_id NOT GLOB '*[^a-z0-9-]*'),
    grant_id TEXT NOT NULL UNIQUE REFERENCES execution_grants (grant_id),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    scenario_id TEXT NOT NULL REFERENCES scenarios (scenario_id),
    scenario_revision INTEGER NOT NULL CHECK (scenario_revision >= 1),
    write_kind TEXT NOT NULL CHECK (write_kind IN ('CREATE', 'UPDATE')),
    target_record_id TEXT CHECK (target_record_id IS NULL OR (length(target_record_id) BETWEEN 1 AND 64 AND target_record_id NOT GLOB '*[^A-Za-z0-9_-]*')),
    seed_record TEXT CHECK (seed_record IS NULL OR (json_valid(seed_record) AND json_type(seed_record) = 'object')),
    submitted_values TEXT NOT NULL CHECK (json_valid(submitted_values) AND json_type(submitted_values) = 'object'),
    unique_key TEXT CHECK (unique_key IS NULL OR length(unique_key) > 0),
    phone_numbers TEXT NOT NULL CHECK (json_valid(phone_numbers) AND json_type(phone_numbers) = 'array'),
    submission TEXT CHECK (submission IS NULL OR submission IN ('NOT_SENT', 'SENT', 'UNKNOWN')),
    block_reason TEXT CHECK (block_reason IS NULL OR block_reason IN ('PAYLOAD_MISMATCH', 'PRECHECK_FAILED')),
    http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
    response_judgement TEXT CHECK (response_judgement IS NULL OR response_judgement IN ('SUCCESS', 'INPUT_ERROR', 'RATE_LIMITED', 'SERVER_ERROR', 'NO_CONDITION_MATCHED', 'MULTIPLE_CONDITIONS_MATCHED', 'SESSION_LOST', 'REPOST_REDIRECT', 'RESPONSE_NOT_DELIVERED')),
    record_id TEXT CHECK (record_id IS NULL OR length(record_id) BETWEEN 1 AND 256),
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
    api_origin TEXT CHECK (api_origin IS NULL OR length(api_origin) BETWEEN 1 AND 2048),
    api_path_shape TEXT CHECK (api_path_shape IS NULL OR (length(api_path_shape) BETWEEN 1 AND 1024
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
  `CREATE INDEX write_results_scenario_recorded ON write_results (scenario_id, recorded_at)`,
  `CREATE INDEX write_results_profile ON write_results (profile_id)`,
  `CREATE TABLE profile_display_settings (
    profile_id TEXT PRIMARY KEY NOT NULL REFERENCES profiles (profile_id),
    show_job_browser INTEGER NOT NULL CHECK (show_job_browser IN (0, 1)),
    updated_at TEXT NOT NULL CHECK (length(updated_at) = 14 AND updated_at NOT GLOB '*[^0-9]*')
  , audit_send_policy TEXT NOT NULL DEFAULT 'READ_ONLY'
    CHECK (audit_send_policy IN ('READ_ONLY', 'PASS_EXCEPT_DELETE'))) STRICT`,
]);

/** 基準の版 17（版と文。凍結）。 */
export const CONTROL_SCHEMA_V17: { readonly version: number; readonly statements: readonly string[] } = Object.freeze({
  version: 17,
  statements: CONTROL_SCHEMA_V17_STATEMENTS,
});

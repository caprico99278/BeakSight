// 管理データの版 19 の文（L12b。設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2 の S18 と、L12b の設計者の判断 1）。凍結。
// - 版 19: 実行の許可（`execution_grants`）と書き込みの結果（`write_results`）の、対象のレコードの ID（`target_record_id`）の長さの上限（64 文字）と、
//   書き込みの結果の登録の ID（`record_id`）の長さの上限（256 文字。L12b の設計者の判断 2）だけを外す。1 文字以上と、対象のレコードの ID の使える文字
//   （英数字・`_`・`-`。path に使うときの守り）の決まりは残す。
// - SQLite は CHECK を外せないので、版 17 の表の文から上限だけを除いた表を作り、行を写し、元の表と替えて、索引を作り直す（列の順・ほかの CHECK・外部キーは
//   版 17 のまま。文は版 17 の文の凍結の写しで、違いは上限の句と、写しの表の名前だけ。`tests/integration/control-store-migrations.test.ts` で確かめる）。
// - 書き込みの結果（ほかの表から参照されない）は、写しの表を作って行を写し、元と替える（版 9 の作り直しと同じ組）。
// - 実行の許可（予約と結果から外部キーで参照される）は、外部キーが入れ替わりの表を指さないよう、表の名前を替えない。行を制約のない仮の表に退け、元の表を消して
//   同じ名前で作り直し、行を戻す。外部キーの確かめはトランザクションの終わりまで延ばす（`PRAGMA defer_foreign_keys`。トランザクションの終わりで自動で戻る）。
//   消したときに数えた違反は、行を戻したときに消える。
// - 走らせるのは版の管理（`migrations.ts` の `runControlMigrations`）だけ（トランザクションの中で、`user_version` と一緒に）。
// - 文の中の digest の接頭辞（`sha256:`）は、版 17 と同じく fingerprint の owner（`createSha256Fingerprint`）の形から取る（GATE-ARCH06）。
import { createSha256Fingerprint } from '../../core/ids.js';

/** fingerprint の形の例（空の文字列の digest）。 */
const SAMPLE_FINGERPRINT = createSha256Fingerprint('');
/** digest の接頭辞（`<方式>:`）。 */
const DIGEST_PREFIX = SAMPLE_FINGERPRINT.slice(0, SAMPLE_FINGERPRINT.indexOf(':') + 1);

/** 書き込みの結果の表の列（版 17 の列の順。行を写すときに、列の名前で対応させる）。 */
const WRITE_RESULTS_COLUMNS = [
  'job_id', 'grant_id', 'profile_id', 'scenario_id', 'scenario_revision', 'write_kind', 'target_record_id', 'seed_record', 'submitted_values', 'unique_key',
  'phone_numbers', 'submission', 'block_reason', 'http_status', 'response_judgement', 'record_id', 'read_verification', 'update_evidence', 'result', 'reason',
  'reservation_state', 'recorded_at', 'submitted_at', 'settled_at', 'transport', 'api_shape_digest', 'api_method', 'api_origin', 'api_path_shape',
].join(', ');

/** 版 19 の文（作れる順）。 */
const CONTROL_SCHEMA_V19_STATEMENTS: readonly string[] = Object.freeze([
  'PRAGMA defer_foreign_keys = ON',
  `CREATE TABLE write_results_v19 (
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
  `INSERT INTO write_results_v19 (${WRITE_RESULTS_COLUMNS})
    SELECT ${WRITE_RESULTS_COLUMNS} FROM write_results`,
  'DROP TABLE write_results',
  'ALTER TABLE write_results_v19 RENAME TO write_results',
  'CREATE TABLE execution_grants_v19_rows AS SELECT * FROM execution_grants',
  'DROP TABLE execution_grants',
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
    CHECK (target_record_id IS NULL OR (length(target_record_id) >= 1 AND target_record_id NOT GLOB '*[^A-Za-z0-9_-]*')),
    CHECK (issued_at < expires_at),
    CHECK (consumed_at IS NULL OR invalidated_at IS NULL),
    CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
    CHECK (invalidated_at IS NULL OR invalidated_at >= issued_at)
  ) STRICT`,
  'INSERT INTO execution_grants SELECT * FROM execution_grants_v19_rows',
  'DROP TABLE execution_grants_v19_rows',
  'CREATE UNIQUE INDEX execution_grants_single_open ON execution_grants (scenario_id) WHERE consumed_at IS NULL AND invalidated_at IS NULL',
  'CREATE INDEX write_results_scenario_recorded ON write_results (scenario_id, recorded_at)',
  'CREATE INDEX write_results_profile ON write_results (profile_id)',
]);

/** 版 19（版と文。凍結）。 */
export const CONTROL_SCHEMA_V19: { readonly version: number; readonly statements: readonly string[] } = Object.freeze({
  version: 19,
  statements: CONTROL_SCHEMA_V19_STATEMENTS,
});

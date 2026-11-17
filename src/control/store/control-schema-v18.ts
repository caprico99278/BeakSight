// 管理データの版 18 の文（COV-1。網羅の設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.3）。凍結。
// - 版 18: 発見の索引（`discovery_candidates`）の型の digest と鍵と欄の対応の digest の一覧の件数の CHECK（版 13 の 3 件。1 画面の押す上限と結び付いていた）を、
//   押す上限から切り離して外す。SQLite は CHECK を外せないので、版 17 の表の文から 2 つの件数の CHECK だけを除いた表を作り、行を写し、元の表と替えて、
//   索引を作り直す（列の順・ほかの CHECK は版 17 のまま。ほかの表からの外部キーはない）。
// - 表の文を持つファイルは、版ごとに 1 つ（版 17 の `control-schema-v17.ts` と同じ形）。走らせるのは版の管理（`migrations.ts` の `runControlMigrations`）
//   だけ（トランザクションの中で、`user_version` と一緒に）。文は版の一覧と同じデータの形（`CONTROL_SCHEMA_V18`）で渡す。
// - 版 17 の文から 2 つの CHECK を除いただけであることは、`tests/integration/control-store-migrations.test.ts` で確かめる。
// - 文の中の digest の接頭辞（`sha256:`）は、版 17 と同じく fingerprint の owner（`createSha256Fingerprint`）の形から取る（GATE-ARCH06）。
import { createSha256Fingerprint } from '../../core/ids.js';

/** fingerprint の形の例（空の文字列の digest）。 */
const SAMPLE_FINGERPRINT = createSha256Fingerprint('');
/** digest の接頭辞（`<方式>:`）。 */
const DIGEST_PREFIX = SAMPLE_FINGERPRINT.slice(0, SAMPLE_FINGERPRINT.indexOf(':') + 1);

/** 版 18 の文（作れる順）。 */
const CONTROL_SCHEMA_V18_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE discovery_candidates_v18 (
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
    CHECK (shape_digests IS NULL OR (json_valid(shape_digests) AND json_type(shape_digests) = 'array')), key_field_digests TEXT
    CHECK (key_field_digests IS NULL OR (json_valid(key_field_digests) AND json_type(key_field_digests) = 'array')),
    PRIMARY KEY (profile_id, identity_digest),
    CHECK (classification = CASE reason_code WHEN 'ACTION_OUTSIDE_ALLOWED_ORIGINS' THEN 'BLOCKED_EXTERNAL' WHEN 'DESTRUCTIVE' THEN 'NOT_EXECUTABLE' WHEN 'READ_GET_FORM' THEN 'READ' WHEN 'GET_WITH_PASSWORD_FIELD' THEN 'UNSUPPORTED_READ_TRANSPORT' WHEN 'GET_WITH_MULTIPART' THEN 'UNSUPPORTED_READ_TRANSPORT' WHEN 'POST_SEARCH' THEN 'UNSUPPORTED_READ_TRANSPORT' WHEN 'GRAPHQL_ENDPOINT' THEN 'UNSUPPORTED_READ_TRANSPORT' WHEN 'JS_BOUND' THEN 'NEEDS_BINDING' WHEN 'JS_DELEGATED' THEN 'NEEDS_BINDING' WHEN 'NO_KNOWN_ACTION' THEN 'DISPLAY_ONLY' WHEN 'DIALOG_METHOD' THEN 'DISPLAY_ONLY' WHEN 'METHOD_OVERRIDE_UNRECOGNIZED' THEN 'DISPLAY_ONLY' WHEN 'UPDATE_METHOD' THEN 'UPDATE' WHEN 'UPDATE_WORD' THEN 'UPDATE' WHEN 'CREATE_WORD' THEN 'CREATE' WHEN 'UNCLASSIFIED' THEN 'DISPLAY_ONLY' WHEN 'DUPLICATE_IDENTITY_CONFLICT' THEN 'DISPLAY_ONLY' END),
    CHECK ((action_path IS NULL) = (form_method IS NULL)),
    CHECK (method_override IS NULL OR form_method IS NOT NULL),
    CHECK (first_seen_at <= last_seen_at)
  ) STRICT`,
  'INSERT INTO discovery_candidates_v18 SELECT * FROM discovery_candidates',
  'DROP TABLE discovery_candidates',
  'ALTER TABLE discovery_candidates_v18 RENAME TO discovery_candidates',
  'CREATE INDEX discovery_candidates_profile_last_seen ON discovery_candidates (profile_id, last_seen_at)',
]);

/** 版 18（版と文。凍結）。 */
export const CONTROL_SCHEMA_V18: { readonly version: number; readonly statements: readonly string[] } = Object.freeze({
  version: 18,
  statements: CONTROL_SCHEMA_V18_STATEMENTS,
});

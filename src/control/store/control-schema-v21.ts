// 管理データの版 21 の文（LZ-3a。設計書 `2026-11-09-beaksight-remove-limits-design.md` 1〜3 章。件数の上限の撤廃）。凍結。
// - 版 21: 発見のジョブ（`discovery_jobs`）の、読み切れた画面の path の数の上限（`json_array_length(read_page_paths) <= 10000`。版 17 の文から）だけを
//   外す。JSON の配列であることの決まりは残す。
// - SQLite は CHECK を外せないので、版 17 の表の文から上限だけを除いた表を作り、行を写し、元の表と替えて、索引を作り直す（列の順・ほかの CHECK・外部キーは
//   版 17 のまま。文は版 17 の文の凍結の写しで、違いは上限の句と、写しの表の名前だけ。`tests/integration/control-store-migrations.test.ts` で確かめる）。
//   ほかの表から参照されない表なので、版 18・20 の発見の索引と同じ組で替える。
// - 走らせるのは版の管理（`migrations.ts` の `runControlMigrations`）だけ（トランザクションの中で、`user_version` と一緒に）。

/** 版 21 の文（作れる順）。 */
const CONTROL_SCHEMA_V21_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE discovery_jobs_v21 (
    job_id TEXT PRIMARY KEY NOT NULL CHECK (length(job_id) > 0 AND job_id NOT GLOB '*[^a-z0-9-]*'),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 14 AND recorded_at NOT GLOB '*[^0-9]*'),
    read_page_paths TEXT NOT NULL CHECK (json_valid(read_page_paths) AND json_type(read_page_paths) = 'array')
  ) STRICT`,
  'INSERT INTO discovery_jobs_v21 SELECT * FROM discovery_jobs',
  'DROP TABLE discovery_jobs',
  'ALTER TABLE discovery_jobs_v21 RENAME TO discovery_jobs',
  `CREATE INDEX discovery_jobs_profile_recorded ON discovery_jobs (profile_id, recorded_at)`,
]);

/** 版 21（版と文。凍結）。 */
export const CONTROL_SCHEMA_V21: { readonly version: number; readonly statements: readonly string[] } = Object.freeze({
  version: 21,
  statements: CONTROL_SCHEMA_V21_STATEMENTS,
});

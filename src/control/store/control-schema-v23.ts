// 管理データの版 23 の文（PAR-b。設計書 `2026-11-17-beaksight-parallel-site-audits-design.md` 2 章。サイトごとに同時に 1 つ）。凍結。
// - 版 23: 終わっていないジョブの一意の部分索引を、管理データ全体で 1 行まで（`jobs_single_active`）から、プロファイルごとに 1 行まで
//   （`jobs_profile_single_active`）にする。表の行は変えない。同じサイト（許可 Origin が重なる）のほかのプロファイルを同時に始めない決まりは、ジョブの
//   管理（`audit-job-manager.ts`）が行を作るトランザクションの中で確かめる（許可 Origin はターゲット設定にあり、管理データにない）。
// - 走らせるのは版の管理（`migrations.ts` の `runControlMigrations`）だけ（トランザクションの中で、`user_version` と一緒に）。

/** 版 23 の文（作れる順）。 */
const CONTROL_SCHEMA_V23_STATEMENTS: readonly string[] = Object.freeze([
  'DROP INDEX jobs_single_active',
  `CREATE UNIQUE INDEX jobs_profile_single_active ON jobs (profile_id) WHERE state IN ('STARTING', 'RUNNING', 'STOPPING')`,
]);

/** 版 23（版と文。凍結）。 */
export const CONTROL_SCHEMA_V23: { readonly version: number; readonly statements: readonly string[] } = Object.freeze({
  version: 23,
  statements: CONTROL_SCHEMA_V23_STATEMENTS,
});

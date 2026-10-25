// プロファイルの保存の記録の値の閉じた一覧（Task 23 の設計書 4.3 の「表（版 1）」。T23c）。
// 版 1 の表の CHECK（`migrations.ts`）と、保存の部品（`profile-store.ts`）と、状態（`store-status.ts`）が、ここだけを参照する。
// SQL を書かない（値の一覧だけ）。表示の語（日本語のラベル）は `src/presentation/`（T23d・T23f）が持つ。

/** プロファイルの状態（`profiles.status`）。取り消しは行を消さず `RETIRED` にする。 */
/** 取り消していないプロファイルの状態（`PROFILE_STATUSES` の値の名前つきの定数。FM2R の Minor 13: 画面のサーバは、ここから読む）。 */
export const ACTIVE_PROFILE_STATUS = 'ACTIVE';
/** 取り消したプロファイルの状態（`PROFILE_STATUSES` の値の名前つきの定数。PRE42-CC 組 1b: 管理の層と画面は、ここから読む）。 */
export const RETIRED_PROFILE_STATUS = 'RETIRED';
export const PROFILE_STATUSES = Object.freeze([ACTIVE_PROFILE_STATUS, RETIRED_PROFILE_STATUS] as const);
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

/** 改訂の履歴の変更の種類（`profile_revisions.change_kind`）。 */
export const PROFILE_CHANGE_KINDS = Object.freeze(['CREATED', 'UPDATED', 'RETIRED'] as const);
export type ProfileChangeKind = (typeof PROFILE_CHANGE_KINDS)[number];

/** `store_meta` の鍵（診断用。作ったときの版と日時）。 */
export const STORE_META_KEYS = Object.freeze({
  createdSchemaVersion: 'created_schema_version',
  createdAt: 'created_at',
} as const);

// 再承認が要る理由の値の一覧（PRE42-CC 組 UI-K3。台帳の CC-113）。純粋な定義だけのファイル（import を持たない）。
// - 承認が有効かの判定の唯一の owner（`src/control/approval/approval-validity.ts`）が、ここを読んで同じ名前で公開し直す（判定は owner のまま。ここは値だけ。
//   Gate `tests/architecture/approval-ssot.test.ts` の (a)）。画面のブラウザ側（`apps/local-ui/src/` の `server/` の外）は、管理データと Node の部品に触れずに
//   値を読めるように、ここから読む（`audit-job-values.ts` と同じ置き方。Gate `tests/architecture/browser-list-values.test.ts`）。

/**
 * 再承認が要る理由（閉じた一覧。判定の結果は、この順で並べる）。
 * - `SCENARIO_REVISION_CHANGED`: シナリオの版が、承認した版と違う（承認の記録の書き換えを含む）。
 * - `PROFILE_REVISION_CHANGED`: プロファイルの改訂が、承認の時と違う（どの編集でも）。
 * - `AUTH_SETUP_CHANGED`・`TARGET_CONFIG_CHANGED`: 認証の設定・ターゲットの設定の digest が、承認の時と違う。
 * - `CANDIDATE_CHANGED`: 最後の発見の候補の規則の digest が、シナリオか承認に固定したものと違う、または分類がシナリオの kind と違う。
 * - `CANDIDATE_MISSING`: 最後の発見で、候補を確かめられない（同じ識別の digest の候補が索引にない、`MISSING`、`NOT_REVISITED`）。T31b: UPDATE は、
 *   型にした識別の digest で同じことを確かめる。
 * - `CANDIDATE_TEMPLATES_UNAVAILABLE`: UPDATE のシナリオで、最後の発見の索引の型にした識別の digest の一覧を、まだ集められない（管理データの版 9 の
 *   前。T31b）。
 * - `CANDIDATE_SHAPE_CHANGED`: API のシナリオで、最後の発見の索引の候補の型の digest の一覧に、シナリオの型の digest がない（型が変わった、型のない
 *   候補。T38c）。
 * - `CANDIDATE_SHAPES_UNAVAILABLE`: API のシナリオで、最後の発見の索引の候補が型の digest の一覧を持たない（管理データの版 13 の前に書いた行。T38c）。
 *   T38R-fix: 鍵と欄の対応の digest の一覧を持たない行も同じ。
 * - `CANDIDATE_FIELDS_CHANGED`: API のシナリオで、型は同じだが、鍵と欄の対応（目印のある欄の識別）が承認した対応と違う（T38R-fix の I-1）。
 * - `API_ORIGIN_NOT_APPROVED`: API のシナリオの Origin が、今のプロファイルの承認したサービスの Origin の一覧の、型の番号の位置にない（T38R-fix の C-2）。
 * - `API_DISCOVERY_PROFILE_STALE`: 索引を書いた最新の発見のジョブの、プロファイルの改訂が今の改訂と違う（発見のやり直しが要る。T38R-fix の C-2）。
 * - `INPUT_RULES_CHANGED`: 入力の規則の参照（id、版、digest）が変わった。
 * - `READ_CHECK_CHANGED`: 照らす READ の定義が変わった（ない、取り消した、版が違う）。
 * - `EXPIRED`: 承認の期限を過ぎた（ちょうど期限の時刻を含む）。
 * - `REVOKED`: 最後の承認が撤回された。
 * - `NOT_APPROVED`: 承認の記録がない。
 * - `PROFILE_RETIRED`: プロファイルを取り消した。
 * - `MODE_NOT_WRITE`: プロファイルのモードが書き込みのモード（`TEST_APPROVED_WRITE`）でない。
 */
export const APPROVAL_INVALIDITY_REASONS = Object.freeze([
  'SCENARIO_REVISION_CHANGED',
  'PROFILE_REVISION_CHANGED',
  'AUTH_SETUP_CHANGED',
  'TARGET_CONFIG_CHANGED',
  'CANDIDATE_CHANGED',
  'CANDIDATE_MISSING',
  'CANDIDATE_TEMPLATES_UNAVAILABLE',
  // T38c: API のシナリオ。
  'CANDIDATE_SHAPE_CHANGED',
  'CANDIDATE_SHAPES_UNAVAILABLE',
  // T38R-fix: 鍵と欄の対応（I-1）、Origin と最新の発見の改訂（C-2）。
  'CANDIDATE_FIELDS_CHANGED',
  'API_ORIGIN_NOT_APPROVED',
  'API_DISCOVERY_PROFILE_STALE',
  'INPUT_RULES_CHANGED',
  'READ_CHECK_CHANGED',
  'EXPIRED',
  'REVOKED',
  'NOT_APPROVED',
  'PROFILE_RETIRED',
  'MODE_NOT_WRITE',
] as const);
export type ApprovalInvalidityReason = (typeof APPROVAL_INVALIDITY_REASONS)[number];

/** 承認の期限を過ぎた（画面のシナリオの表示の状態「期限切れ」を選ぶ理由）。 */
export const EXPIRED_INVALIDITY_REASON = 'EXPIRED' satisfies ApprovalInvalidityReason;

/** 最後の承認が撤回された（画面の表示の状態「撤回済み」を選ぶ理由）。 */
export const REVOKED_INVALIDITY_REASON = 'REVOKED' satisfies ApprovalInvalidityReason;

/** 承認の記録がない（画面の表示の状態「下書き」を選ぶ理由。再承認が要る理由の一覧には出さない）。 */
export const NOT_APPROVED_INVALIDITY_REASON = 'NOT_APPROVED' satisfies ApprovalInvalidityReason;

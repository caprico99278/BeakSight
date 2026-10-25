// シナリオの下書きを拒む理由の値の一覧（PRE42-CC 組 UI-K3。台帳の CC-113）。純粋な定義だけのファイル（import を持たない）。
// - 下書きの確かめの唯一の owner（`src/control/approval/scenario-policy.ts` の `validateScenarioDraft`）が、ここを読んで同じ名前で公開し直す（判定と、理由ごとの
//   意味の説明は owner のまま。ここは値だけ。Gate `tests/architecture/approval-ssot.test.ts` の (a)）。画面のブラウザ側（`apps/local-ui/src/` の `server/` の外）は、
//   管理データと Node の部品に触れずに値を読めるように、ここから読む（`audit-job-values.ts` と同じ置き方。Gate `tests/architecture/browser-list-values.test.ts`）。

/** 下書きを拒む理由（閉じた一覧）。意味は `scenario-policy.ts` の `SCENARIO_DRAFT_REJECTION_REASONS` の説明。 */
export const SCENARIO_DRAFT_REJECTION_REASONS = Object.freeze([
  'SCENARIO_INPUT_INVALID',
  'SCENARIO_CANDIDATE_UNKNOWN',
  'SCENARIO_CANDIDATE_NOT_WRITABLE',
  'SCENARIO_CANDIDATE_REQUEST_UNSUPPORTED',
  'SCENARIO_FIELD_SECRET_LIKE',
  'SCENARIO_FIELD_DANGEROUS_WORD',
  'SCENARIO_FIELD_TYPE_NOT_SENDABLE',
  'SCENARIO_FIELD_NOT_ALLOWED',
  // T30f fix round 1・2（DEF-098）: CREATE の送らない、既定の値が分からない欄。
  'SCENARIO_CREATE_DEFAULT_VALUE_FIELD_NOT_SENT',
  // T31R2-fix-1: 値を読めず照らせない、秘密に見える名前の欄がある画面（登録と更新）。
  'SCENARIO_FORM_HAS_UNREADABLE_SECRET_FIELD',
  // T31b: UPDATE の指定。
  'SCENARIO_UPDATE_SPEC_MISSING',
  'SCENARIO_UPDATE_SPEC_NOT_ALLOWED',
  'SCENARIO_UPDATE_TARGET_NOT_FOUND',
  'SCENARIO_UPDATE_TARGET_NOT_CREATE',
  'SCENARIO_UPDATE_PATH_MISMATCH',
  'SCENARIO_UPDATE_RECORD_ID_UNSAFE',
  // T31R-fix-1 の I-2: path の型の `{id}` の位置が、台帳の登録の ID の取り方に結び付かない。
  'SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID',
  'SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD',
  'SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_STATE_FIELD',
  'SCENARIO_STATE_FIELD_NOT_CHANGEABLE',
  // T31R-fix-1 の I-1: 危険な語・削除の語に当たる名前の欄は、保つだけ。
  'SCENARIO_REMOVAL_FIELD_NOT_CHANGEABLE',
  'SCENARIO_UPDATE_FIELD_ROLE_OVERLAP',
  'SCENARIO_UPDATE_FIELD_ROLE_MISSING',
  'SCENARIO_UPDATE_NO_CHANGED_FIELD',
  'SCENARIO_READ_CHECK_NOT_FOUND',
  'SCENARIO_READ_CHECK_CANCELED',
  'SCENARIO_READ_CHECK_REVISION_MISMATCH',
  'SCENARIO_VERIFICATION_CONDITIONS_AMBIGUOUS',
  'SCENARIO_VERIFICATION_PARAMETER_UNKNOWN',
  'SCENARIO_VERIFICATION_FIELD_NOT_SENT',
  'SCENARIO_LIMIT_ABOVE_DEFAULT',
  'SCENARIO_LIMIT_INCONSISTENT',
  'SCENARIO_TTL_ABOVE_DEFAULT',
  // T37d fix round 1: 照合の READ に、画面の path を読む定義を選んだ（開始の拒否 `WRITE_READ_VERIFICATION_PAGE_TARGET` と同じ意味。重ねの守り）。
  'SCENARIO_VERIFICATION_READ_CHECK_PAGE_TARGET',
  // T38b（Task 38 の設計書 3.2）: API のシナリオの下書き（説明は `scenario-policy.ts` の API の確かめの節）。
  'SCENARIO_API_CANDIDATE_NOT_API',
  'SCENARIO_API_STATE_KEY',
  'SCENARIO_API_METHOD_OVERRIDE',
  'SCENARIO_API_HEADER_METHOD_OVERRIDE',
  'SCENARIO_API_ORIGIN_NOT_APPROVED',
  'SCENARIO_API_SHAPE_NOT_EXECUTABLE',
  'SCENARIO_API_FIELD_KEY_MISMATCH',
  'SCENARIO_API_FIELD_TYPE_MISMATCH',
  'SCENARIO_API_KEY_NOT_ALLOWED',
  'SCENARIO_API_PAGE_KEY_SECRET_LIKE',
  'SCENARIO_API_FILTER_MISMATCH',
  // T38c（T38b の報告の (2)）: 候補を見つけた発見のジョブのプロファイルの改訂が、今の改訂と違う（分からないときも。発見のやり直しが要る）。
  'SCENARIO_API_DISCOVERY_PROFILE_STALE',
  // T38R-fix の I-2: ページが決める鍵が scalar でない、登録の ID を読む応答の鍵が秘密に見える。
  'SCENARIO_API_PAGE_KEY_NOT_SCALAR',
  'SCENARIO_API_RECORD_ID_KEY_SECRET_LIKE',
  // T40R-fix-B（Task 40 の設計書 7 章の「T40R」の行の I-2 (a)）: `{id}` の照合の READ に、生成した値と比べる期待がない（行の数だけ）。T40R2-fix: (b) の
  // 画面から ID を取る型が書き込みの画面に当たる場合は拒まず、画面の注意（core の `recordIdPatternMatchesPagePath`）にしたので、一覧から外した。
  'SCENARIO_API_READ_VERIFICATION_NOT_BOUND',
  // T41a（Task 41 の設計書 3.1、3.3 のページが決める鍵）: 更新の画面の欄として識別できないページが決める鍵（UPDATE）、台帳の ID の鍵が filter の名前と違う。
  'SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE',
  'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID',
] as const);
export type ScenarioDraftRejectionReason = (typeof SCENARIO_DRAFT_REJECTION_REASONS)[number];

/** T31R-fix-1 の I-2: path の型の `{id}` の位置が、台帳の登録の ID の取り方に結び付かない（画面の UPDATE の入力が、型の組の近くに出す理由）。 */
export const PATH_NOT_BOUND_TO_LEDGER_ID_REJECTION_REASON = 'SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID' satisfies ScenarioDraftRejectionReason;

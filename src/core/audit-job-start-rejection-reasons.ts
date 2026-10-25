// ジョブの開始を拒むときの理由の値の一覧（PRE42-CC 組 UI-K2。台帳の CC-113）。純粋な定義だけのファイル（import を持たない）。
// - ジョブの記録（`src/control/job/job-records.ts`）が、ここを同じ名前で公開し直す（定義は 1 か所。ジョブの管理と画面のサーバは、そこから読む）。画面の
//   ブラウザ側（`apps/local-ui/src/` の `server/` の外）は、ジョブの管理と Node の部品に触れずに値を読めるように、ここから読む（`audit-job-values.ts` と
//   同じ置き方。Gate `tests/architecture/browser-list-values.test.ts`）。

/** ジョブの開始を拒むときの理由（行を作らず、ワーカーを起動しない）。 */
export const AUDIT_JOB_START_REJECTION_REASONS = Object.freeze([
  /** 依頼の形が違う（プロファイルの ID、改訂、`startNew`）。 */
  'INVALID_REQUEST',
  /** プロファイルがない。 */
  'PROFILE_NOT_FOUND',
  /** 取り消したプロファイル。 */
  'PROFILE_RETIRED',
  /** 画面が読んだ改訂と、保存されている改訂が違う（開始の直前に変わった）。 */
  'PROFILE_REVISION_CONFLICT',
  /** そのジョブの種類を、このモードでは実行できない（`execution-policy.ts` の `PROFILE_OPERATION_POLICY` の行にない。T28b）。 */
  'MODE_NOT_EXECUTABLE',
  /**
   * 今は実行できない認証の方式（T25d。`EXECUTABLE_AUTH_STRATEGIES`）。T26d-2: ログインの検証を、自動ログインでないプロファイルで始めようとした
   * ときも、この理由（Windows 以外の自動ログインは、資格情報の暗号化の確かめで `CREDENTIAL_PROTECTION_UNAVAILABLE`）。
   */
  'AUTH_STRATEGY_NOT_EXECUTABLE',
  /** 認証の設定が要るモードで、認証の設定が保存されていない（T25d）。ターゲット設定を読まない。 */
  'AUTH_SETUP_MISSING',
  /** 保存した認証の設定が古い（プロファイルの改訂が変わった。`STALE`。T25d）。ターゲット設定を読まない。 */
  'AUTH_SETUP_STALE',
  /** 保存した認証の設定が、開始の直前の `validateAuthSetup` を通らない（T25d）。 */
  'AUTH_SETUP_INVALID',
  /** ターゲット JSON のパスを受けない（`isAcceptedTargetConfigPath`）。ファイルを読まない。 */
  'TARGET_PATH_INVALID',
  /** ターゲット JSON を読めない、検証を通らない（検証の文脈を用意できない）。 */
  'TARGET_CONFIG_UNAVAILABLE',
  /** 今のターゲット設定で、プロファイルが `validateSiteProfile` を通らない。 */
  'PROFILE_INVALID',
  /** 終わっていないジョブがある（同時に 1 つだけ）。 */
  'JOB_ALREADY_ACTIVE',
  /** 自動ログインのプロファイルで、資格情報のファイルがない（Task 26 の設計書 4.5。T26c）。 */
  'CREDENTIAL_MISSING',
  /** 保存した資格情報のログインの Origin が、今の認証の設定の `loginStartUrl` の Origin と違う（T26c）。 */
  'CREDENTIAL_STALE',
  /** 資格情報の暗号化（DPAPI）が使えない（T26c）。 */
  'CREDENTIAL_PROTECTION_UNAVAILABLE',
  /** 前の自動ログインが成功以外で終わったので、人が画面で解くまで、そのプロファイルの自動ログインを止めている（T26c）。 */
  'AUTO_LOGIN_HELD',
  /** 自動ログインの最小の間隔、24 時間の上限、`Retry-After` の待ちの中（次に始められる時刻がある。T26c）。 */
  'AUTO_LOGIN_RATE_LIMITED',
  /**
   * この管理が、管理のロック（画面のサーバを 1 つだけにする。DEF-061）を失った（ハートビートの間に、ほかの管理が古いと判定して取り直した）。
   * 新しいジョブを始めない（T24h-4）。
   */
  'CONTROL_INSTANCE_LOCK_LOST',
  /** READ の確かめを始めようとしたが、そのプロファイルに、取り消していない READ の確かめの定義が 1 件もない（T27e）。 */
  'READ_CHECK_DEFINITIONS_MISSING',
  /**
   * 書き込みのジョブ（T30e）: 実行の許可を使えない（ない、別のシナリオ・プロファイル、消費済み、無効、期限切れ、消費で拒まれた）。消費で拒まれたときは、
   * ジョブの行を `FAILED`（`WRITE_GRANT_REJECTED`）で残し、予約を返す（消費していない、そのジョブの許可を無効にする）。
   */
  'WRITE_GRANT_REJECTED',
  /**
   * 書き込みのジョブ（T30e）: 送る値を生成できない（規則が決まらない、一意にする欄の組を使い切った、照合の READ に結び付ける値がない、書き込みの
   * 指定を作れない）。許可は消費済みのまま、結果を `BLOCKED`・`RELEASED` で締め、ジョブの行を `FAILED`（`WRITE_GRANT_REJECTED`）で残す。
   */
  'WRITE_DATA_NOT_GENERATED',
  /**
   * 書き込みのジョブ（T37d。設計者の判断 5）: 照合の READ の定義が、画面の path の定義（書き込みの照合には使わない）。許可は消費済みのまま、結果を
   * `BLOCKED`・`RELEASED` で締め、ジョブの行を `FAILED`（`WRITE_GRANT_REJECTED`）で残す（`WRITE_DATA_NOT_GENERATED` と同じ締め方）。
   */
  'WRITE_READ_VERIFICATION_PAGE_TARGET',
] as const);
export type AuditJobStartRejectionReason = (typeof AUDIT_JOB_START_REJECTION_REASONS)[number];

/** 取り消したプロファイルの開始を拒む理由（画面の「次にすること」が、監査を始められない理由の短い一覧に使う）。 */
export const PROFILE_RETIRED_START_REJECTION_REASON = 'PROFILE_RETIRED' satisfies AuditJobStartRejectionReason;

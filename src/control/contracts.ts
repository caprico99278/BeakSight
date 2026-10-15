// 監査プロファイル（サイト・環境ごとの監査モード）の契約の SSOT（Task 22 の設計書 4.1、4.4。ロードマップ第 5 章）。
// 値の一覧は `as const` の凍結した配列として 1 回だけ定義し、TypeScript の型はその配列から導く（共通部品台帳 2.2 と同じ方式）。
// JSON Schema（`schemas/control/profile.schema.json`）の enum と定数は、この一覧と一致することをテストで固定する
// （`tests/unit/control-contracts.test.ts`、`tests/unit/schema-enum-consistency.test.ts`）。
// import を持たない純粋なファイル（Node の部品も、Playwright と監査エンジン（`src/browser/`、`src/safety/`、`src/orchestration/`）も import しない）。
// ブラウザのコードからも値を読める（CCX-29）。ブラウザで `WRITE_AUDIT_MODE` の値が要るときは、`approval-view.ts` を通さず、ここから直接読む。
// 組み合わせの規則（環境とモードと認証）は、ここにもスキーマにも置かない。判定は `profile-policy.ts`（T22b）の 1 か所。

/** 監査モード（ロードマップ 3.1）。 */
export const AUDIT_MODES = Object.freeze(['PUBLIC_PASSIVE', 'TEST_AUTH_PASSIVE', 'TEST_APPROVED_WRITE'] as const);
export type AuditMode = (typeof AUDIT_MODES)[number];

/**
 * 書き込みを許すモード（承認が有効でありうるプロファイルのモード。Task 28）。値の唯一の定義（CCX-29。CC-080 の (c) で
 * `approval/scenario-contracts.ts` から移した。import を持たないこのファイルに置くので、ブラウザのコードからも値として読める）。
 * `approval/scenario-contracts.ts` は、これを公開し直す。
 */
export const WRITE_AUDIT_MODE = 'TEST_APPROVED_WRITE' satisfies AuditMode;

/** 環境の種類（ロードマップ 3.1。本番とテストは別のプロファイル）。 */
export const ENVIRONMENT_KINDS = Object.freeze(['PUBLIC', 'TEST'] as const);
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

/** 認証の方式（ロードマップ 3.1）。 */
export const AUTH_STRATEGIES = Object.freeze(['NONE', 'MANUAL_SESSION', 'AUTOMATED_LOGIN'] as const);
export type AuthStrategy = (typeof AUTH_STRATEGIES)[number];

/** プロファイルの版。スキーマの `schemaVersion` の const と一致する。 */
export const SITE_PROFILE_SCHEMA_VERSION = 'beaksight-profile/1';

/** プロファイルの識別子の形（小文字の英数字とハイフン、先頭は英数字、全体で 1〜63 文字）。スキーマの pattern と一致する。 */
export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

/** プロファイルの改訂の番号の最小値。スキーマの `revision` の minimum と一致する。 */
export const MIN_PROFILE_REVISION = 1;

/** 環境の隔離の確認の非秘密の参照（`environmentEvidenceRef`）の最大長（UTF-16 のコード単位）。スキーマの maxLength と一致する。 */
export const MAX_ENVIRONMENT_EVIDENCE_REF_LENGTH = 200;

/** サイト・環境のプロファイル（ロードマップ第 5 章の形のまま。フィールドの追加・改名はしない）。 */
export interface SiteProfile {
  readonly schemaVersion: typeof SITE_PROFILE_SCHEMA_VERSION;
  /** `PROFILE_ID_PATTERN` の形。 */
  readonly profileId: string;
  /** `MIN_PROFILE_REVISION` 以上の安全な整数。同じ `profileId` の改訂は単調増加。 */
  readonly revision: number;
  /** 既存の監査のターゲット JSON への相対パス（形の判定は `profile-policy.ts`）。 */
  readonly targetConfigPath: string;
  readonly environment: EnvironmentKind;
  readonly mode: AuditMode;
  readonly auth: AuthStrategy;
  /** テスト環境の認証・書き込みのモードで許可する Origin（重複なし）。 */
  readonly approvedTestOrigins: readonly string[];
  /** 環境の隔離の確認の非秘密の参照。ないときは null。 */
  readonly environmentEvidenceRef: string | null;
}

/** プロファイルの検証で拒否するときのコード（閉じた一覧。設計書 4.4）。表示の文言は Task 23 の表示カタログに置く。 */
export const PROFILE_VALIDATION_ERROR_CODES = Object.freeze([
  'PROFILE_SCHEMA_INVALID',
  'PROFILE_ID_INVALID',
  'PROFILE_TARGET_PATH_INVALID',
  'PROFILE_MODE_ENVIRONMENT_MISMATCH',
  'PROFILE_AUTH_MISMATCH',
  'PROFILE_TEST_ORIGINS_REQUIRED',
  'PROFILE_TEST_ORIGIN_INVALID',
  'PROFILE_TEST_ORIGIN_OUTSIDE_TARGET',
  'PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED',
  'PROFILE_REVISION_NOT_ADVANCED',
] as const);
export type ProfileValidationErrorCode = (typeof PROFILE_VALIDATION_ERROR_CODES)[number];

/** プロファイルの検証の誤り 1 件（閉じた一覧のコードと、英語の技術的な詳細）。 */
export interface ProfileValidationError {
  readonly code: ProfileValidationErrorCode;
  readonly detail: string;
}

/** プロファイルの検証の結果。受けるときは凍結したプロファイル、拒むときは当たった誤りのすべて（1 件以上）。 */
export type ProfileValidationResult =
  | { readonly ok: true; readonly profile: SiteProfile }
  | { readonly ok: false; readonly errors: readonly ProfileValidationError[] };

/** `ValidatedSiteProfile` の印の鍵。型の上だけにあり（実行時の値を持たない）、外へ公開しないので、印をほかの場所で書けない。 */
declare const validatedSiteProfileMark: unique symbol;

/**
 * `validateSiteProfile`（`profile-policy.ts`）が受けたプロファイル（T22d。T22R の I1）。凍結した写し。
 * 型の印は、ほかの場所で付けられない。実行時にも、`profile-policy.ts` の中の閉じた一覧で、受けた値かを確かめる
 * （型の変換で印を付けた値は、実行時の確かめで拒否する）。
 */
export type ValidatedSiteProfile = SiteProfile & { readonly [validatedSiteProfileMark]: true };

/** 検証を通ったプロファイルを返す結果（`validateSiteProfile`、`assertProfileRevisionAdvance`）。`ProfileValidationResult` に代入できる。 */
export type ValidatedProfileResult =
  | { readonly ok: true; readonly profile: ValidatedSiteProfile }
  | { readonly ok: false; readonly errors: readonly ProfileValidationError[] };

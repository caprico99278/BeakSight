/**
 * 資格情報の画面の要求を拒む理由の閉じた一覧（Task 26 の設計書 4.2、4.7。T26e）。表示の文言は `CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS`
 * （`src/presentation/messages.ts`）。書き漏れと余分は `src/display/catalog-coverage.ts` で型で確かめる。
 * - 先頭は、資格情報のファイルの部品の誤りのコード（`CREDENTIAL_STORE_ERROR_CODES`）のすべて。後ろに、画面のサーバが決める理由を足す。
 * - 誤りの応答には、理由のコードと項目の名前（`username`・`password`）だけを入れる。値（ユーザー名とパスワード）を入れない。
 */
import {
  CREDENTIAL_STORE_ERROR_CODES,
  CredentialStoreError,
  type CredentialField,
} from '../../../../src/control/credentials/credential-store.js';
import { CredentialProtectionError } from '../../../../src/control/credentials/dpapi-protector.js';
import { CREDENTIAL_CHANGE_REJECTION_REASONS } from '../../../../src/control/job/job-records.js';

/** 画面のサーバが決める理由。 */
const LOCAL_UI_CREDENTIAL_REJECTION_REASONS = Object.freeze([
  /** プロファイルがない。 */
  'PROFILE_NOT_FOUND',
  /** 自動ログインの、有効なプロファイルでない（`TEST_AUTH_PASSIVE` か `TEST_APPROVED_WRITE`（T28b）で `AUTOMATED_LOGIN`。保存と変更は `ACTIVE` だけ）。 */
  'CREDENTIAL_NOT_ELIGIBLE',
  /** 認証の設定がない（資格情報を結びつけるログインの Origin が決まらない）。 */
  'AUTH_SETUP_MISSING',
  /** 2 回入れたパスワードが一致しない。 */
  'CREDENTIAL_CONFIRMATION_MISMATCH',
  /** 暗号化の部品の誤り（`CredentialProtectionError`）。 */
  'CREDENTIAL_PROTECTION_FAILED',
] as const);

/** 資格情報の画面の要求を拒む理由（閉じた一覧）。 */
export const CREDENTIAL_REQUEST_REJECTION_REASONS = Object.freeze([
  ...CREDENTIAL_STORE_ERROR_CODES,
  ...CREDENTIAL_CHANGE_REJECTION_REASONS,
  ...LOCAL_UI_CREDENTIAL_REJECTION_REASONS,
] as const);
export type CredentialRequestRejectionReason = (typeof CREDENTIAL_REQUEST_REJECTION_REASONS)[number];

/** 誤りの応答（理由のコードと、項目の名前だけ）。 */
export interface CredentialRequestRejection {
  readonly ok: false;
  readonly reason: CredentialRequestRejectionReason;
  /** 値の決まりの誤りの項目（ほかの誤りでは `null`）。 */
  readonly field: CredentialField | null;
}

/** 拒否の応答を作る（凍結）。 */
export const credentialRejection = (reason: CredentialRequestRejectionReason, field: CredentialField | null = null): CredentialRequestRejection =>
  Object.freeze({ ok: false, reason, field });

/**
 * 資格情報のファイルの部品と暗号化の部品の誤りを、拒否の応答にする（コードと項目の名前だけ。誤りの文は使わない）。ほかの誤りは、そのまま投げる。
 */
export const credentialRejectionOf = (error: unknown): CredentialRequestRejection => {
  if (error instanceof CredentialStoreError) {
    return credentialRejection(error.code, error.field);
  }
  if (error instanceof CredentialProtectionError) {
    return credentialRejection('CREDENTIAL_PROTECTION_FAILED');
  }
  throw error;
};

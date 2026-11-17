/**
 * 資格情報の画面の要求を拒む理由（Task 26 の設計書 4.2、4.7。T26e）。OP-1 の修正の 1 回目（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.3 の 1）で、
 * 中身を `src/control/auth/credential-request-rejection.ts` へ移した（ジョブの管理の、ログインの直後の自動ログインへの切り替えも使うため）。ここは同じ名前で公開し直す。
 */
export {
  CREDENTIAL_REQUEST_REJECTION_REASONS,
  credentialRejection,
  credentialRejectionOf,
  type CredentialRequestRejection,
  type CredentialRequestRejectionReason,
} from '../../../../src/control/auth/credential-request-rejection.js';

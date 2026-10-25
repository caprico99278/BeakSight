// 監査プロファイルの組み合わせの表の唯一の owner（Task 22 の設計書 4.3 の表。T43a fix round 1 で `profile-policy.ts` から切り出した）。
// - 純粋な定義だけを置く（`node:fs`・スキーマの検証・入出力を import しない）。画面のブラウザの部品（プロファイルの作成の欄）からも読む。
// - 判定（`validateSiteProfile`）は `profile-policy.ts` が、この表を使って行う（表の写しを持たない）。
// - 作成の欄は、監査モードを選んだときに、環境と認証の方式の初めの値（`defaultEnvironmentAndAuthOf`。表の先頭の値）に合わせる（利用者は後から
//   変えられる。保存の検証は今のまま。Task 43 の設計書 4.1）。
import { deepFreeze } from '../core/immutable.js';
import type { AuditMode, AuthStrategy, EnvironmentKind } from './contracts.js';

/** モードごとに受ける環境（設計書 4.3 の表。先頭が初めの値）。表にない組み合わせは `PROFILE_MODE_ENVIRONMENT_MISMATCH`。 */
export const ENVIRONMENTS_BY_MODE: Readonly<Record<AuditMode, readonly [EnvironmentKind, ...EnvironmentKind[]]>> = deepFreeze({
  PUBLIC_PASSIVE: ['PUBLIC', 'TEST'],
  TEST_AUTH_PASSIVE: ['TEST'],
  TEST_APPROVED_WRITE: ['TEST'],
});

/** モードごとに受ける認証の方式（設計書 4.3 の表。先頭が初めの値）。表にない組み合わせは `PROFILE_AUTH_MISMATCH`。 */
export const AUTH_STRATEGIES_BY_MODE: Readonly<Record<AuditMode, readonly [AuthStrategy, ...AuthStrategy[]]>> = deepFreeze({
  PUBLIC_PASSIVE: ['NONE'],
  TEST_AUTH_PASSIVE: ['MANUAL_SESSION', 'AUTOMATED_LOGIN'],
  TEST_APPROVED_WRITE: ['MANUAL_SESSION', 'AUTOMATED_LOGIN'],
});

/** テスト環境の Origin と環境の証拠を必須にするモード（認証・書き込みのモード）。承認したサービスの Origin を持てるのも、このモードだけ。 */
export const TEST_ORIGIN_MODES: readonly AuditMode[] = deepFreeze(['TEST_AUTH_PASSIVE', 'TEST_APPROVED_WRITE']);

/** 環境の証拠（確かめた記録の参照）を持たない環境（公開の環境）。 */
export const ENVIRONMENT_WITHOUT_EVIDENCE: EnvironmentKind = 'PUBLIC';

/** その環境で、環境の証拠（確かめた記録の参照）を持てるか（公開の環境でなければ持てる）。 */
export const environmentAcceptsEvidence = (environment: EnvironmentKind): boolean => environment !== ENVIRONMENT_WITHOUT_EVIDENCE;

/** モードの、環境と認証の方式の初めの値（表の先頭の値）。 */
export const defaultEnvironmentAndAuthOf = (mode: AuditMode): { readonly environment: EnvironmentKind; readonly auth: AuthStrategy } => ({
  environment: ENVIRONMENTS_BY_MODE[mode][0],
  auth: AUTH_STRATEGIES_BY_MODE[mode][0],
});

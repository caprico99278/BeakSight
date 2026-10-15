/**
 * 開始できない理由の表示（Task 24 の設計書 4.8、Task 25 の設計書 4.5。T25e で開始の画面に作り、T26e でログインの確かめの画面と共用するために
 * 切り出した）。理由の説明と手順、プロファイルの検証の誤り、設定のファイルの誤り、認証の設定の誤り、案内のリンク。
 * - T26e（Task 26 の設計書 4.5、4.6）: 自動ログインの上限で止めているときは、次に始められる日時を出す。資格情報の理由と、止めている理由には、
 *   資格情報の画面とログインの確かめの画面へのリンクを出す。
 */
import { Link } from '@tanstack/react-router';
import { formatDateTime } from '../../../../src/presentation/format.js';
import {
  AUDIT_JOB_START_REJECTION_DESCRIPTIONS,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_LOGIN_CHECK_TEXT,
  PROFILE_VALIDATION_ERROR_DESCRIPTIONS,
  describeConfigError,
} from '../../../../src/presentation/messages.js';
import type { AuthSetupErrorView } from '../server/auth-setup-errors';
import { authSetupErrorSummaryText } from './AuthSetupForm';

type StartReason = keyof typeof AUDIT_JOB_START_REJECTION_DESCRIPTIONS;

/** 認証の設定の画面へ案内する、開始できない理由（T25e。認証の設定を作る・保存し直す・直す）。 */
const AUTH_SETUP_REASONS: ReadonlySet<StartReason> = new Set(['AUTH_SETUP_MISSING', 'AUTH_SETUP_STALE', 'AUTH_SETUP_INVALID']);

/** 資格情報の画面へ案内する、開始できない理由（T26e）。 */
const CREDENTIAL_REASONS: ReadonlySet<StartReason> = new Set(['CREDENTIAL_MISSING', 'CREDENTIAL_STALE']);

/** ログインの確かめの画面（止めた状態の解除）へ案内する、開始できない理由（T26e）。 */
const HOLD_REASONS: ReadonlySet<StartReason> = new Set(['AUTO_LOGIN_HELD']);

export function StartReasonDetails({ profileId, reason, errorCodes, configError, authSetupErrors, nextAllowedAt, showLoginCheckLink }: Readonly<{
  profileId: string;
  reason: StartReason;
  errorCodes: readonly (keyof typeof PROFILE_VALIDATION_ERROR_DESCRIPTIONS)[];
  configError: Parameters<typeof describeConfigError>[0] | null;
  authSetupErrors: readonly AuthSetupErrorView[];
  /** 次に始められる日時（ISO 8601。なければ `null`）。 */
  nextAllowedAt: string | null;
  /** 止めている理由のときに、ログインの確かめの画面へのリンクを出すか（ログインの確かめの画面そのものでは出さない）。 */
  showLoginCheckLink: boolean;
}>) {
  const text = AUDIT_JOB_START_REJECTION_DESCRIPTIONS[reason];
  return (
    <>
      <p data-testid="start-reason" data-reason={reason}>{text.description}</p>
      {errorCodes.length === 0 ? null : (
        <ul>
          {errorCodes.map((code) => <li key={code}>{PROFILE_VALIDATION_ERROR_DESCRIPTIONS[code]}</li>)}
        </ul>
      )}
      {authSetupErrors.length === 0 ? null : (
        <ul data-testid="start-auth-setup-errors">
          {authSetupErrors.map((error) => {
            const line = authSetupErrorSummaryText(error);
            return <li key={line} data-code={error.code} data-field={error.field ?? ''}>{line}</li>;
          })}
        </ul>
      )}
      {configError === null ? null : <p>{describeConfigError(configError)}</p>}
      {nextAllowedAt === null ? null : (
        <dl className="facts">
          <dt>{LOCAL_UI_LOGIN_CHECK_TEXT.nextAllowedAt}</dt>
          <dd data-testid="start-next-allowed-at">{formatDateTime(nextAllowedAt)}</dd>
        </dl>
      )}
      <p>{text.action}</p>
      {AUTH_SETUP_REASONS.has(reason) ? (
        <div className="button-row">
          <Link to="/auth-setup/$profileId" params={{ profileId }} className="button button--primary" data-testid="start-open-auth-setup">
            {LOCAL_UI_AUTH_TEXT.start.openSetup}
          </Link>
        </div>
      ) : null}
      {CREDENTIAL_REASONS.has(reason) ? (
        <div className="button-row">
          <Link to="/credentials/$profileId" params={{ profileId }} className="button button--primary" data-testid="start-open-credentials">
            {LOCAL_UI_LOGIN_CHECK_TEXT.openCredentials}
          </Link>
        </div>
      ) : null}
      {showLoginCheckLink && HOLD_REASONS.has(reason) ? (
        <div className="button-row">
          <Link to="/login-check/$profileId" params={{ profileId }} className="button button--primary" data-testid="start-open-login-check">
            {LOCAL_UI_AUTH_TEXT.start.openLoginCheck}
          </Link>
        </div>
      ) : null}
    </>
  );
}

/**
 * ジョブの詳細の、ログインの段で止めた送信の「登録する」と、ログインの段で観察した案（T43d。Task 43 の設計書 4.4）。
 * - 行の query の欄: query の名前（値なし）と、閉じた一覧の名前（`grant_type`）の記録した値。
 * - 行の登録の欄: 登録先（`loginStageRegistrationOf`）ごとに、認証の設定の画面を下書きつき（URL の search。サーバに保存しない）で開くリンク「登録する」。
 *   伏せた path の行と、登録済みの送信の上限・送り方で止めた行は、リンクを出さず、手で入れる案内を出す。「登録する」は、その場では保存しない。
 * - 観察の欄: 新しく出たローカル ストレージの鍵の名前の接頭辞と接尾辞（成功の鍵の名前の案。間の部分は持たない）と、成功の画面のセレクタの案（ログアウトの
 *   属性の CSS と語の説明。画面の文字は持たない）と、資格情報を含んだので捨てた案の数（T43R-fix の C-1）。「案を認証の設定に入れる」で、同じ下書きの仕組みで
 *   認証の設定の画面を開く。まとめが大きすぎて観察を省いたときは、その旨（M-5）。
 */
import { Link } from '@tanstack/react-router';
import {
  loginStageRegistrationOf,
  observedDraftOfObservation,
  observedDraftOfRegistration,
} from '../../../../src/control/login-observation-draft.js';
import type { WorkerLoginObservation, WorkerLoginStageBlockedRequest } from '../../../../src/control/worker-protocol.js';
import { formatCount } from '../../../../src/presentation/format.js';
import { LOCAL_UI_LOGIN_OBSERVATION_TEXT, LOCAL_UI_LOGIN_STAGE_REGISTER_TEXT } from '../../../../src/presentation/messages.js';
import { LoginStageRegisterButton, type LoginStageRowTarget } from './LoginStageRegister';

const text = LOCAL_UI_LOGIN_OBSERVATION_TEXT;

/** 行の query の欄（名前と、記録した値）。 */
export function LoginStageQueryCell({ request }: Readonly<{ request: WorkerLoginStageBlockedRequest }>) {
  const { query } = request;
  if (query === undefined) {
    return <span className="muted">{text.noQuery}</span>;
  }
  return (
    <span data-testid="job-login-stage-query">
      {query.names.map((name, index) => {
        const recorded = query.values.find((value) => value.name === name);
        return (
          <span key={name}>
            {index === 0 ? null : ', '}
            <code>{name}</code>
            {recorded === undefined ? null : <>{`（${text.recordedValue}: `}<code>{recorded.value}</code>{'）'}</>}
          </span>
        );
      })}
      {query.omitted === 0 ? null : <span className="muted">{` ${text.omittedQueryNames(formatCount(query.omitted))}`}</span>}
    </span>
  );
}

/**
 * 行の登録の欄（「登録する」か、手で入れる案内）。FM-1（手動の操作を減らす設計書 2.1）: 「登録する」は、確認のダイアログの後にその場で保存する
 * （`LoginStageRegisterButton`。画面は移らない）。今までの下書きのリンク（認証の設定の画面を下書きつきで開く。保存は利用者）は「認証の設定の画面で直す」
 * として残す。
 */
export function LoginStageRegisterCell({ profileId, request, target }: Readonly<{
  profileId: string;
  request: WorkerLoginStageBlockedRequest;
  target: LoginStageRowTarget;
}>) {
  const registration = loginStageRegistrationOf(request);
  const draft = observedDraftOfRegistration(registration);
  if (registration.kind === 'MANUAL' || draft === null) {
    const guidance = registration.kind === 'MANUAL' && registration.reason === 'REDACTED_PATH' ? text.manualRedactedPath : text.manualAlreadyRegistered;
    return <span className="muted" data-testid="job-login-stage-manual">{guidance}</span>;
  }
  return (
    <>
      <LoginStageRegisterButton target={target} registration={registration.kind} />
      <span className="field-hint">{registration.kind === 'TOKEN_TARGET' ? text.registerTokenTarget : text.registerSideRequest}</span>
      <Link to="/auth-setup/$profileId" params={{ profileId }} search={{ draft }} data-testid="job-login-stage-edit-draft">
        {LOCAL_UI_LOGIN_STAGE_REGISTER_TEXT.editDraft}
      </Link>
    </>
  );
}

/** ログインの段で観察した案の欄（観察がなければ出さない）。 */
export function LoginStageObservationPanel({ profileId, observation, omitted = false }: Readonly<{
  profileId: string;
  observation: WorkerLoginObservation | undefined;
  /** T43R-fix の M-5: まとめが大きすぎたので、観察と query の名前を省いたか。 */
  omitted?: boolean;
}>) {
  if (observation === undefined) {
    return omitted ? <p className="muted" data-testid="job-login-observation-omitted">{text.observationOmitted}</p> : null;
  }
  const draft = observedDraftOfObservation(observation);
  const { storageKeys, successSelector, credentialDiscarded } = observation;
  return (
    <div data-testid="job-login-observation">
      <h3 className="field-group-subheading">{text.observationHeading}</h3>
      <p className="muted">{text.observationBody}</p>
      <dl className="facts">
        {storageKeys === undefined ? null : (
          <>
            <dt>{text.storageKeys}</dt>
            <dd className="cell-break" data-testid="job-login-observation-keys">
              {storageKeys.shapes.map(({ prefix, suffix }, index) => (
                <span key={`${prefix}${text.storageKeyMiddle}${suffix}`}>
                  {index === 0 ? null : ', '}
                  <code>{prefix}</code>{text.storageKeyMiddle}<code>{suffix}</code>
                </span>
              ))}
              {storageKeys.omitted === 0 ? null : <span className="muted">{` ${text.omittedQueryNames(formatCount(storageKeys.omitted))}`}</span>}
            </dd>
            <dt>{text.storageKeysOrigin}</dt>
            <dd className="cell-break"><code>{storageKeys.origin}</code></dd>
          </>
        )}
        {successSelector === undefined ? null : (
          <>
            <dt>{text.successSelector}</dt>
            <dd className="cell-break" data-testid="job-login-observation-selector">
              <code>{successSelector.selector}</code>
              <span className="field-hint">{text.successSelectorLogout(successSelector.logoutWord)}</span>
            </dd>
          </>
        )}
      </dl>
      {credentialDiscarded === undefined ? null : (
        <p className="muted" data-testid="job-login-observation-discarded">{text.credentialDiscarded(formatCount(credentialDiscarded))}</p>
      )}
      {draft === null ? null : (
        <p>
          <Link to="/auth-setup/$profileId" params={{ profileId }} search={{ draft }} className="button" data-testid="job-login-observation-apply">
            {text.applyObservation}
          </Link>
        </p>
      )}
    </div>
  );
}

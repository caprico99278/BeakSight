/**
 * 入口の確かめのジョブの結果（Task 43 の設計書 4.3。T43c）。ジョブの詳細に、成果物 `entry-check.json` の読んだ事実と案を出す。値（欄の値）は成果物にも
 * ない。URL・path・セレクタは文字として出す（リンクにしない）。
 * MI-3（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.3）: 認証の設定の画面へのリンクの代わりに、入口の確かめの後の認証の設定の状態
 * （BeakSight が案で保存したか、保存しなかった理由と「詳しい設定で認証の設定を作る」。`AuthSetupProposalNote`）を出す。
 * PL-2（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2）: 2 つに分ける。`EntryCheckOutcome` は、ふだんの画面に出すもの（進めないときの
 * 次にすること、外のサイトへ移ろうとしたこと、手でのログインの案内、保存しなかった理由）。設定が済んだとき（`PRESENT`）の「点検を始める」は、作業の画面の
 * 要点の主のボタンが出す（ここでは出さない）。`EntryCheckFacts` は、たたんだ詳しい内容に入れるもの（読んだ事実、欄の候補とセレクタ、送り方、案）。
 */
import { Fragment } from 'react';
import type { EntryCheckAuthSetupState } from '../../../../src/control/auth/auth-setup-proposal.js';
import type { EntryCheckLocation } from '../../../../src/control/entry-check.js';
import { formatTimes } from '../../../../src/presentation/format.js';
import { SCRIPT_REQUEST_TRANSPORT } from '../../../../src/control/auth/auth-setup-contracts.js';
import { LOCAL_UI_AUTH_TEXT, LOCAL_UI_ENTRY_CHECK_TEXT, LOCAL_UI_JOB_NEXT_STEPS } from '../../../../src/presentation/messages.js';
import { entryCheckEndReasonDisplay, entryCheckFormPlacementDisplay, httpMethodLabel, loginTransportDisplay, toneClass } from '../display/labels';
import type { EntryCheckResultView } from '../server/entry-check-functions';
import { AuthSetupProposalNote } from './NextSteps';

/** 欄の並び（ユーザー名、パスワード、送信の要素）。 */
const FIELDS = Object.freeze(['username', 'password', 'submit'] as const);

const text = LOCAL_UI_ENTRY_CHECK_TEXT.job;

/** 場所の表示（Origin と path。外なら Origin だけ）。 */
function LocationText({ location }: Readonly<{ location: EntryCheckLocation }>) {
  return (
    <>
      <code>{`${location.origin}${location.path ?? ''}`}</code>
      {' '}
      <span className="muted">{location.inAllowedOrigins ? text.landingInside : text.landingOutside}</span>
    </>
  );
}

export function EntryCheckOutcome({ result, profileId, authSetupState, manualLogin = false }: Readonly<{
  result: EntryCheckResultView | null;
  profileId: string;
  /** MI-3: 入口の確かめの後の認証の設定の状態（サーバが求めた値。認証の設定を使わないプロファイルは `NOT_USED`）。 */
  authSetupState: EntryCheckAuthSetupState | null;
  /** T44e: プロファイルが認証の設定を使い、認証の方式が手動のログインか（スクリプトで送るログインの案の、自動の登録の案内）。 */
  manualLogin?: boolean;
}>) {
  // PRESENT（設定がそろった）の「点検を始める」は、要点の主のボタンが出す。
  const proposalNote = authSetupState === 'PRESENT' ? null : <AuthSetupProposalNote profileId={profileId} state={authSetupState} />;
  if (result === null) {
    return (
      <div data-testid="job-entry-check">
        <p data-testid="job-entry-check-unavailable">{text.unavailable}</p>
        {proposalNote}
      </div>
    );
  }
  const nextStep = LOCAL_UI_JOB_NEXT_STEPS.entryCheckEndReasons[result.endReason];
  const { proposal } = result;
  return (
    <div data-testid="job-entry-check">
      {/* T44e（Task 44 の設計書 P2-7）: 案を作れなかった終わり方の、次にできること（カタログ。外のサイトへ移ろうとしたときも、ここに出る）。 */}
      {nextStep === null ? null : (
        <p data-testid="job-entry-check-next-step">{nextStep}</p>
      )}
      {/* T44e（Task 44 の設計書 P2-8）: 手動のログインのプロファイルで、スクリプトで送るログインの案（送信先と鍵は空）なら、自動の登録の案内を出す。 */}
      {manualLogin && proposal !== null && proposal.loginTransport === SCRIPT_REQUEST_TRANSPORT ? (
        <p data-testid="job-entry-check-script-login-note">{LOCAL_UI_AUTH_TEXT.scriptLoginAutoRegistrationNote}</p>
      ) : null}
      {proposalNote}
    </div>
  );
}

/** 入口の確かめの読んだ事実と案（たたんだ詳しい内容に入れる。成果物を読めなければ何も出さない）。 */
export function EntryCheckFacts({ result }: Readonly<{ result: EntryCheckResultView | null }>) {
  if (result === null) {
    return null;
  }
  const endReason = entryCheckEndReasonDisplay(result.endReason);
  const { facts, proposal } = result;
  const placement = facts?.form.placement ?? null;
  return (
    <section className="panel" data-testid="job-entry-check-facts">
      <h2 className="panel-heading">{text.heading}</h2>
      <dl className="facts">
        <dt>{text.endReason}</dt>
        <dd>
          <span className={toneClass(endReason.tone)} data-testid="job-entry-check-end-reason" data-end-reason={result.endReason}>{endReason.label}</span>
        </dd>
        {result.landing === null ? null : (
          <>
            <dt>{text.landing}</dt>
            <dd className="cell-break" data-testid="job-entry-check-landing"><LocationText location={result.landing} /></dd>
          </>
        )}
        {facts === null ? null : (
          <>
            <dt>{text.loginPage}</dt>
            <dd data-testid="job-entry-check-login-page" data-login-page={String(facts.loginPage)}>
              {facts.loginPage ? text.loginPageYes : text.loginPageNo}
            </dd>
          </>
        )}
        <dt>{text.blockedRequests}</dt>
        <dd>{formatTimes(result.blockedRequests)}</dd>
      </dl>
      {endReason.description === null ? null : <p>{endReason.description}</p>}
      {facts === null ? null : (
        <>
          <h3>{text.fieldsHeading}</h3>
          <div className="table-wrap">
            <table data-testid="job-entry-check-fields">
              <thead>
                <tr>
                  <th scope="col">{text.fieldColumn}</th>
                  <th scope="col">{text.candidatesColumn}</th>
                  <th scope="col">{text.selectorColumn}</th>
                </tr>
              </thead>
              <tbody>
                {FIELDS.map((field) => (
                  <tr key={field} data-field={field}>
                    <td>{text.fields[field]}</td>
                    <td>{String(facts.fields[field].candidates)}</td>
                    <td className="cell-break">{facts.fields[field].selector === null ? text.noSelector : <code>{facts.fields[field].selector}</code>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>{text.formHeading}</h3>
          <dl className="facts" data-testid="job-entry-check-form">
            <dt>{text.placement}</dt>
            <dd data-placement={placement ?? ''}>{placement === null ? text.placementUnknown : entryCheckFormPlacementDisplay(placement).label}</dd>
            <dt>{text.method}</dt>
            <dd>{facts.form.method === null ? text.none : httpMethodLabel(facts.form.method)}</dd>
            <dt>{text.action}</dt>
            <dd className="cell-break">{facts.form.action === null ? text.none : <LocationText location={facts.form.action} />}</dd>
          </dl>
          {placement === null ? null : <p className="muted">{entryCheckFormPlacementDisplay(placement).description}</p>}
        </>
      )}
      <h3>{text.proposalHeading}</h3>
      {proposal === null ? <p data-testid="job-entry-check-no-proposal">{text.noProposal}</p> : (
        <>
          <dl className="facts" data-testid="job-entry-check-proposal">
            <dt>{text.loginStartUrl}</dt>
            <dd className="cell-break">{proposal.loginStartUrl === null ? text.none : <code>{proposal.loginStartUrl}</code>}</dd>
            <dt>{text.sessionLostPathPrefix}</dt>
            <dd className="cell-break">{proposal.sessionLostPathPrefix === null ? text.none : <code>{proposal.sessionLostPathPrefix}</code>}</dd>
            <dt>{text.loginTransport}</dt>
            <dd data-transport={proposal.loginTransport ?? ''}>
              {proposal.loginTransport === null ? text.none : loginTransportDisplay(proposal.loginTransport).label}
            </dd>
            {proposal.loginPostEndpoint === null ? null : (
              <>
                <dt>{text.loginPostEndpoint}</dt>
                <dd className="cell-break"><code>{`${proposal.loginPostEndpoint.origin}${proposal.loginPostEndpoint.path}`}</code></dd>
              </>
            )}
          </dl>
          <h4>{text.selectorsHeading}</h4>
          <dl className="facts" data-testid="job-entry-check-selectors">
            {FIELDS.map((field) => (
              <Fragment key={field}>
                <dt>{text.fields[field]}</dt>
                <dd className="cell-break" data-field={field}>
                  {proposal.selectors[field] === null ? text.noSelector : <code>{proposal.selectors[field]}</code>}
                </dd>
              </Fragment>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}

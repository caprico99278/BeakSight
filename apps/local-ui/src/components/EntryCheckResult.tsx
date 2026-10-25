/**
 * 入口の確かめのジョブの結果（Task 43 の設計書 4.3。T43c）。ジョブの詳細に、成果物 `entry-check.json` の読んだ事実と案を出す。値（欄の値）は成果物にも
 * ない。URL・path・セレクタは文字として出す（リンクにしない）。案があり、プロファイルが認証の設定を使うときは、認証の設定の画面へのリンクを出す。
 */
import { Fragment } from 'react';
import { Link } from '@tanstack/react-router';
import type { EntryCheckLocation } from '../../../../src/control/entry-check.js';
import { formatTimes } from '../../../../src/presentation/format.js';
import { SCRIPT_REQUEST_TRANSPORT } from '../../../../src/control/auth/auth-setup-contracts.js';
import { LOCAL_UI_AUTH_TEXT, LOCAL_UI_ENTRY_CHECK_TEXT, LOCAL_UI_JOB_NEXT_STEPS } from '../../../../src/presentation/messages.js';
import { entryCheckEndReasonDisplay, entryCheckFormPlacementDisplay, loginTransportDisplay, toneClass } from '../display/labels';
import type { EntryCheckResultView } from '../server/entry-check-functions';

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

export function EntryCheckResult({ result, profileId, usesAuthSetup, manualLogin = false }: Readonly<{
  result: EntryCheckResultView | null;
  profileId: string;
  /** プロファイルが認証の設定を使うか（案があるときの、認証の設定の画面へのリンク）。 */
  usesAuthSetup: boolean;
  /** T44e: プロファイルが認証の設定を使い、認証の方式が手動のログインか（スクリプトで送るログインの案の、自動の登録の案内）。 */
  manualLogin?: boolean;
}>) {
  if (result === null) {
    return (
      <section className="panel" data-testid="job-entry-check">
        <h2 className="panel-heading">{text.heading}</h2>
        <p data-testid="job-entry-check-unavailable">{text.unavailable}</p>
      </section>
    );
  }
  const endReason = entryCheckEndReasonDisplay(result.endReason);
  const nextStep = LOCAL_UI_JOB_NEXT_STEPS.entryCheckEndReasons[result.endReason];
  const { facts, proposal } = result;
  const placement = facts?.form.placement ?? null;
  return (
    <section className="panel" data-testid="job-entry-check">
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
      {/* T44e（Task 44 の設計書 P2-7）: 案を作れなかった終わり方の、次にできること（カタログ）。 */}
      {nextStep === null ? null : (
        <p data-testid="job-entry-check-next-step">{nextStep}</p>
      )}
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
            <dd>{facts.form.method === null ? text.none : <code>{facts.form.method}</code>}</dd>
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
          {/* T44e（Task 44 の設計書 P2-8）: 手動のログインのプロファイルで、スクリプトで送るログインの案（送信先と鍵は空）なら、自動の登録の案内を出す。 */}
          {manualLogin && proposal.loginTransport === SCRIPT_REQUEST_TRANSPORT ? (
            <p data-testid="job-entry-check-script-login-note">{LOCAL_UI_AUTH_TEXT.scriptLoginAutoRegistrationNote}</p>
          ) : null}
          {usesAuthSetup ? (
            <p>
              <Link to="/auth-setup/$profileId" params={{ profileId }} className="button" data-testid="job-entry-check-open-auth-setup">
                {text.openAuthSetup}
              </Link>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

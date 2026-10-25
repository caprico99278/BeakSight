/**
 * ML-b（設計書 `doc/design/2026-10-19-beaksight-manual-login-pass-through-design.md` の 2.3）: 手動のログインの成功から自動で登録した、Guard を通るための
 * 設定（token の送信先、ログインに伴う送信、承認したサービスの Origin、成功のローカル ストレージの鍵の形）。ジョブの画面とプロファイルの画面が共用する。
 * 見直して直す入口（認証の設定の画面）と、保存でプロファイルの改訂が進むことの知らせを置く。値は持たない（query は名前だけ）。文言はカタログだけ。
 * ML-b-2: ジョブの画面は、このジョブからの自動の登録の結果（`children`）を同じ欄に出す。スクリプトで送るログインの設定がまだない（`setup` が null）
 * ときは、結果と入口だけを出す。
 */
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { formatCount } from '../../../../src/presentation/format.js';
import { LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT, LOCAL_UI_MANUAL_LOGIN_TEXT, listText } from '../../../../src/presentation/messages.js';
import type { LoginSetupView } from '../server/login-setup-view';

const text = LOCAL_UI_MANUAL_LOGIN_TEXT;

export function LoginSetupPanel({ profileId, setup, testId, offerAutomatedLogin = false, children }: Readonly<{
  profileId: string;
  setup: LoginSetupView | null;
  testId: string;
  /** FM-1（手動の操作を減らす設計書 2.3）: 「次から自動でログインする」の案内を出すか。 */
  offerAutomatedLogin?: boolean;
  children?: ReactNode;
}>) {
  return (
    <section className="panel" aria-live="polite" data-testid={testId}>
      <h2 className="panel-heading">{text.setupHeading}</h2>
      <p className="muted">{text.setupNote}</p>
      {children}
      {setup === null ? null : <LoginSetupFacts setup={setup} testId={testId} />}
      <p>
        <Link to="/auth-setup/$profileId" params={{ profileId }} className="button" data-testid={`${testId}-review`}>{text.review}</Link>
      </p>
      {offerAutomatedLogin ? <AutomatedLoginOffer profileId={profileId} testId={`${testId}-automated-login`} /> : null}
    </section>
  );
}

/**
 * FM-1（手動の操作を減らす設計書 2.3）: 「次から自動でログインする」。FM2e（同 3A.4）: 3 つの画面を順に導く代わりに、1 つの画面（資格情報の画面の、
 * 手動のログインのプロファイルの形）へ進む。その画面で、認証の方式の変更・ログインの欄のセレクタ（手動のログインの段の観察の案）・資格情報を、確認 1 回で
 * 保存する。自動ログインの上限と厳しさは今のまま。
 */
function AutomatedLoginOffer({ profileId, testId }: Readonly<{ profileId: string; testId: string }>) {
  const offer = LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT.offer;
  return (
    <div data-testid={testId}>
      <h3>{offer.heading}</h3>
      <p>{offer.body}</p>
      <p>
        <Link to="/credentials/$profileId" params={{ profileId }} className="button button--primary" data-testid="automated-login-offer-setup">
          {offer.open}
        </Link>
      </p>
    </div>
  );
}

/** 登録してある設定の中身と、保存でプロファイルの改訂が進むことの知らせ。 */
function LoginSetupFacts({ setup, testId }: Readonly<{ setup: LoginSetupView; testId: string }>) {
  return (
    <>
      <dl className="facts">
        <dt>{text.token}</dt>
        <dd data-item="token">
          {setup.token === null ? text.none : (
            <>
              <code>{`${setup.token.origin}${setup.token.path}`}</code>
              {setup.token.queryNames.length === 0 ? null : <span className="muted">{text.tokenQueryNames(listText(setup.token.queryNames))}</span>}
            </>
          )}
        </dd>
        <dt>{text.sideRequests}</dt>
        <dd data-item="sideRequests">
          {setup.sideRequests.length === 0 ? text.none : (
            <ul>
              {setup.sideRequests.map((request) => (
                <li key={`${request.origin}${request.path}`} data-path={request.path}>
                  {text.sideRequestValue(request.method, `${request.origin}${request.path}`, formatCount(request.maxPerLoginStage))}
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>{text.serviceOrigins}</dt>
        <dd data-item="serviceOrigins">{setup.serviceOrigins.length === 0 ? text.none : listText(setup.serviceOrigins)}</dd>
        <dt>{text.successKey}</dt>
        <dd data-item="successKey">{setup.successKey === null ? text.none : text.successKeyValue(setup.successKey.prefix, setup.successKey.suffix)}</dd>
      </dl>
      <p data-testid={`${testId}-revision-note`}>{text.revisionNote}</p>
    </>
  );
}

/**
 * ML-b（設計書 `doc/design/2026-10-19-beaksight-manual-login-pass-through-design.md` の 2.3）: 手動のログインの成功から自動で登録した、Guard を通るための
 * 設定（token の送信先、ログインに伴う送信、承認したサービスの Origin、成功のローカル ストレージの鍵の形）。ジョブの画面とプロファイルの画面が共用する。
 * 見直して直す入口（認証の設定の画面）と、保存でプロファイルの改訂が進むことの知らせを置く。値は持たない（query は名前だけ）。文言はカタログだけ。
 * ML-b-2: ジョブの画面は、このジョブからの自動の登録の結果（`children`）を同じ欄に出す。スクリプトで送るログインの設定がまだない（`setup` が null）
 * ときは、結果と入口だけを出す。
 * MI-C 項目 11（MI-4 の報告）: 「次から自動でログインする」の案内（前の `AutomatedLoginOffer`）は消した。PL-1: 案内は、サイトの画面の要点の主のボタン（段の決め方は
 * `display/next-steps.ts` の `profileStageOf`）の 1 か所だけ。サイトの画面には、この欄を出さない（作業の画面だけ）。
 * PL-2（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 13 章の 10、4 章の 2）: 読み上げの区画（`aria-live`）は持たない（作業の画面の読み上げは
 * 要点の 1 つだけ）。作業の画面は、自動の登録が済んだ後の見直しの入口を出さない（`showReview` を偽にする）。
 */
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { formatCount } from '../../../../src/presentation/format.js';
import { LOCAL_UI_MANUAL_LOGIN_TEXT, listText } from '../../../../src/presentation/messages.js';
import { httpMethodLabel } from '../display/labels';
import type { LoginSetupView } from '../server/login-setup-view';

const text = LOCAL_UI_MANUAL_LOGIN_TEXT;

export function LoginSetupPanel({ profileId, setup, testId, children, showReview = true }: Readonly<{
  profileId: string;
  setup: LoginSetupView | null;
  testId: string;
  children?: ReactNode;
  /** 見直しの入口（ログインの設定の画面へのリンク）を出すか（既定は出す）。 */
  showReview?: boolean;
}>) {
  return (
    <section className="panel" data-testid={testId}>
      <h2 className="panel-heading">{text.setupHeading}</h2>
      <p className="muted">{text.setupNote}</p>
      {children}
      {setup === null ? null : <LoginSetupFacts setup={setup} testId={testId} />}
      {showReview ? (
        <p>
          <Link to="/auth-setup/$profileId" params={{ profileId }} className="button" data-testid={`${testId}-review`}>{text.review}</Link>
        </p>
      ) : null}
    </section>
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
                  {text.sideRequestValue(httpMethodLabel(request.method), `${request.origin}${request.path}`, formatCount(request.maxPerLoginStage))}
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

/**
 * プロファイルの「次にすること」の欄と、保存の後の次の手順のリンク（T43a。Task 43 の設計書 4.1）。
 * - 「次にすること」: 手順ごとに、状態（済み・要る・古い（直す）・要らない）と、その手順の画面へのリンク（要らない手順にはリンクを出さない。
 *   古い手順は「直す」）。状態はサーバが選んだ値（`profileOnboardingFn`。選び方は `display/next-steps.ts`）。
 * - 次の手順のリンク: プロファイルの詳細の「次にすること」（`#next-steps`）と、次に使う手順（`nextStepAfter`）の画面。認証の設定の保存、資格情報の
 *   保存、ログインの確かめの成功の後に出す。
 * - 文言は `LOCAL_UI_NEXT_STEP_TEXT`、手順と状態のラベルは表示のカタログ。
 */
import { Link } from '@tanstack/react-router';
import type { AuditMode, AuthStrategy } from '../../../../src/control/contracts.js';
import { LOCAL_UI_NEXT_STEP_TEXT } from '../../../../src/presentation/messages.js';
import { nextStepStateDisplay, profileNextStepDisplay, toneClass } from '../display/labels';
import { nextStepAfter, type ProfileNextStep, type ProfileNextStepRow } from '../display/next-steps';

/** 「次にすること」の欄のアンカー（保存の後のリンクの行き先）。 */
export const NEXT_STEPS_ANCHOR = 'next-steps';

const text = LOCAL_UI_NEXT_STEP_TEXT;

/** 手順の画面へのリンク（行き先は手順ごとの画面）。 */
function StepLink({ step, profileId, label, primary }: Readonly<{ step: ProfileNextStep; profileId: string; label: string; primary: boolean }>) {
  const className = primary ? 'button button--primary' : 'button';
  const attributes = { className, 'data-testid': 'next-step-link', 'data-step': step } as const;
  switch (step) {
    case 'AUTH_SETUP':
      return <Link to="/auth-setup/$profileId" params={{ profileId }} {...attributes}>{label}</Link>;
    case 'CREDENTIAL':
      return <Link to="/credentials/$profileId" params={{ profileId }} {...attributes}>{label}</Link>;
    case 'LOGIN_CHECK':
      return <Link to="/login-check/$profileId" params={{ profileId }} {...attributes}>{label}</Link>;
    case 'AUDIT_START':
      return <Link to="/start/$profileId" params={{ profileId }} {...attributes}>{label}</Link>;
  }
}

/** プロファイルの詳細の「次にすること」の欄。 */
export function NextStepsPanel({ profileId, steps }: Readonly<{ profileId: string; steps: readonly ProfileNextStepRow[] }>) {
  return (
    <section className="panel" id={NEXT_STEPS_ANCHOR} data-testid="profile-next-steps">
      <h2 className="panel-heading">{text.heading}</h2>
      <p>{text.body}</p>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{text.columns.step}</th>
              <th scope="col">{text.columns.state}</th>
              <th scope="col">{text.columns.action}</th>
            </tr>
          </thead>
          <tbody>
            {steps.map(({ step, state }) => {
              const stepDisplay = profileNextStepDisplay(step);
              const stateDisplay = nextStepStateDisplay(state);
              return (
                <tr key={step} data-step={step}>
                  <th scope="row">{stepDisplay.label}</th>
                  <td>
                    <span className={toneClass(stateDisplay.tone)} data-testid="next-step-state" data-state={state}>{stateDisplay.label}</span>
                    {stateDisplay.description === null ? null : <p className="muted">{stateDisplay.description}</p>}
                  </td>
                  <td>
                    {state === 'NOT_NEEDED' ? null : (
                      <StepLink
                        step={step}
                        profileId={profileId}
                        label={state === 'STALE' ? text.fixStep(stepDisplay.label) : text.openStep(stepDisplay.label)}
                        primary={state === 'NEEDED' || state === 'STALE'}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 保存の後（と、ログインの確かめの成功の後）の、次の手順のリンク。 */
export function NextStepLinks({ profileId, after, mode, auth }: Readonly<{
  profileId: string;
  /** 済ませた手順。 */
  after: ProfileNextStep;
  mode: AuditMode;
  auth: AuthStrategy;
}>) {
  const next = nextStepAfter(after, mode, auth);
  return (
    <section className="panel" data-testid="next-step-links">
      <h2 className="panel-heading">{text.after.heading}</h2>
      <div className="button-row">
        {next === null ? null : <StepLink step={next} profileId={profileId} label={text.after.actions[next]} primary />}
        <Link to="/profiles/$profileId" params={{ profileId }} hash={NEXT_STEPS_ANCHOR} className="button" data-testid="next-step-overview">
          {text.after.openOverview}
        </Link>
      </div>
    </section>
  );
}

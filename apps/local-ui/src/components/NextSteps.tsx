/**
 * サイトの画面のボタンの部品と、保存の後の次の手順のリンク（T43a で作り、PL-1 で 3 章の形に置き換えた）。
 * - PL-1（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1、6 章）: サイトの画面の要点のパネルの主のボタン・二次のボタンと、詳しい内容の中の
 *   入口を、行き先（`display/next-steps.ts` の `PROFILE_ACTIONS`）ごとに 1 つの部品で描く（`ProfileActionLink`・`EntryCheckStartButton`）。どれを出すかは、
 *   サーバが選んだ段（`profileOnboardingFn` の `stage`）が決める。画面は描くだけ。「書き込みも試す」は確認のダイアログがあるので、サイトの画面の部品が描く。
 * - 次の手順のリンク（`NextStepLinks`）: サイトの画面（要点のパネル `#next-steps`）と、次に使う手順（`nextStepAfter`）の画面。認証の設定の保存、資格情報の
 *   保存、ログインの確かめの成功の後に出す。
 * - MI-3（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.3）: 入口の確かめの後の認証の設定の状態（`AuthSetupProposalNote`）。ジョブの画面の
 *   「入口の確かめの結果」が使う。
 * - 文言は `LOCAL_UI_NEXT_STEP_TEXT`。
 */
import { Link } from '@tanstack/react-router';
import type { EntryCheckAuthSetupState } from '../../../../src/control/auth/auth-setup-proposal.js';
import type { AuditMode, AuthStrategy } from '../../../../src/control/contracts.js';
import {
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_SETUP_PROPOSAL_TEXT,
  LOCAL_UI_ENTRY_CHECK_TEXT,
  LOCAL_UI_NEXT_STEP_TEXT,
} from '../../../../src/presentation/messages.js';
import { nextStepAfter, type ProfileAction, type ProfileNextStep } from '../display/next-steps';
import { EntryCheckRejectedNotice, useEntryCheckStart } from './EntryCheckPanel';

/** サイトの画面の要点のパネルのアンカー（保存の後のリンクの行き先）。 */
export const NEXT_STEPS_ANCHOR = 'next-steps';

const text = LOCAL_UI_NEXT_STEP_TEXT;

/** ボタンの見た目の class（主のボタンか、二次のボタンか）。 */
const buttonClassOf = (primary: boolean): string => (primary ? 'button button--primary' : 'button');

/** 手順の画面へのリンク（行き先は手順ごとの画面）。 */
function StepLink({ step, profileId, label, primary }: Readonly<{ step: ProfileNextStep; profileId: string; label: string; primary: boolean }>) {
  const attributes = { className: buttonClassOf(primary), 'data-testid': 'next-step-link', 'data-step': step } as const;
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

/**
 * 画面へ移るだけの行き先（入口を確かめ直すと書き込みも試すは、押した場で動くので別の部品。PL-U の結果を見るは、報告を別のタブで開くので、サイトの画面が描く）。
 */
export type ProfileLinkAction = Exclude<ProfileAction, 'RECHECK_ENTRY' | 'AUDIT_RESULT'>;

/** サイトの画面の、行き先の画面へのリンク（名前はカタログの `actions`）。`primary` は主のボタンの見た目。 */
export function ProfileActionLink({ action, profileId, primary }: Readonly<{ action: ProfileLinkAction; profileId: string; primary: boolean }>) {
  const attributes = { className: buttonClassOf(primary), 'data-testid': 'profile-action', 'data-action': action } as const;
  const label = text.actions[action];
  switch (action) {
    case 'AUTH_SETUP':
      return <Link to="/auth-setup/$profileId" params={{ profileId }} {...attributes}>{label}</Link>;
    case 'CREDENTIAL':
      return <Link to="/credentials/$profileId" params={{ profileId }} {...attributes}>{label}</Link>;
    case 'AUDIT_START':
      return <Link to="/start/$profileId" params={{ profileId }} {...attributes}>{label}</Link>;
    case 'SCENARIOS':
      return <Link to="/scenarios/$profileId" params={{ profileId }} {...attributes}>{label}</Link>;
    case 'CLEAR_HOLD':
      // 判断 1: ログインの確かめの画面は、止めた自動ログインを解く入口としてだけ残す。
      return <Link to="/login-check/$profileId" params={{ profileId }} {...attributes}>{label}</Link>;
  }
}

/**
 * 入口を確かめ直す（始める処理と拒否の知らせは、入口の確かめの欄と共用の `useEntryCheckStart`・`EntryCheckRejectedNotice`。CC-117）。始めたら作業の画面へ
 * 移る。拒まれたら、開始の画面と同じ理由の部品で理由を出す。`revision` は画面が読んだサイトの改訂。
 */
export function EntryCheckStartButton({ profileId, revision, primary }: Readonly<{ profileId: string; revision: number; primary: boolean }>) {
  const { submitting, rejection, begin, clearRejection } = useEntryCheckStart(profileId, revision);
  return (
    <>
      <button
        type="button"
        className={buttonClassOf(primary)}
        disabled={submitting}
        data-testid="profile-action"
        data-action="RECHECK_ENTRY"
        onClick={begin}
      >
        {submitting ? LOCAL_UI_ENTRY_CHECK_TEXT.panel.starting : text.actions.RECHECK_ENTRY}
      </button>
      {rejection === null ? null : <EntryCheckRejectedNotice profileId={profileId} rejection={rejection} onCleared={clearRejection} />}
    </>
  );
}

/**
 * MI-3: 入口の確かめの後の認証の設定の状態。設定がない（自動で保存できなかった）ときは、理由 1 行と「詳しい設定で認証の設定を作る」。設定がある（`PRESENT`）
 * ときは文を出さず、次の段（監査の開始）へのリンクだけ（設計者の判断。表示を減らす）。認証の設定を使わないプロファイル（`NOT_USED`）と、状態がないときは
 * 何も出さない。ジョブの画面の「入口の確かめの結果」が使う。
 */
export function AuthSetupProposalNote({ profileId, state }: Readonly<{ profileId: string; state: EntryCheckAuthSetupState | null }>) {
  if (state === null || state === 'NOT_USED') {
    return null;
  }
  const proposalText = LOCAL_UI_AUTH_SETUP_PROPOSAL_TEXT;
  if (state === 'PRESENT') {
    return (
      <p data-testid="auth-setup-proposal" data-state={state}>
        <Link to="/start/$profileId" params={{ profileId }} className="button" data-testid="auth-setup-proposal-start">
          {LOCAL_UI_AUDIT_TEXT.profileList.startAudit}
        </Link>
      </p>
    );
  }
  return (
    <div data-testid="auth-setup-proposal" data-state={state}>
      <p>{proposalText.states[state]}</p>
      <p>
        <Link to="/auth-setup/$profileId" params={{ profileId }} className="button" data-testid="auth-setup-proposal-advanced">
          {proposalText.createInAdvanced}
        </Link>
      </p>
    </div>
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

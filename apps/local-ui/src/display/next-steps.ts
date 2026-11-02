/**
 * サイトの画面の主のボタンの決め方と、保存の後の次の手順（T43a で作り、PL-1 で 3 章の形に置き換えた）。ブラウザでも動く純粋な部品（値は持たず、判定は今の
 * owner を呼ぶだけ）。
 * - PL-1（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1、4 章の 1・7、6 章の 1〜6 の段）: サイトの画面は、要点＋主のボタン 1 つ＋詳しい
 *   内容 1 つ。主のボタンは段で決まる（入口を確かめ直す → 点検を始める → 書き込みも試す → 書き込みの手順へ。OP-1: 「次から自動でログインする」は外した）。
 *   決め方は `profileStageOf` の 1 か所だけ（画面のサーバの `profileOnboardingFn` が読んだ事実を渡し、サイトの画面とサイトの一覧が同じ値を描く）。
 *   - 事実は、今の owner の判定の結果だけ: 点検を始められない理由（開始の画面と同じ `audit-start-check.ts` の `auditStartCheckOf`）、入口の確かめを始められるか
 *     （同じ確かめの入口の確かめの種類）、入口の確かめの後の認証の設定の状態（`entryCheckAuthSetupStateOf`）、最後の点検のジョブ（終わったか、自動ログインで
 *     ログインしたか）、「書き込みにも使う」の対象か
 *     （`writeModeSwitchProposalOf` と認証の設定が今の改訂か）。
 *   - 「書き込みも試す」は、点検が 1 回終わってから出す（4 章の 1）。自動ログインにした後は、自動ログインの点検が 1 回終わるまで
 *     「点検を始める」。
 *   - ログインの確かめは流れから外す（判断 1。4 章の 7）。自動ログインの間隔の中は主のボタンを出さない（要点に時刻）。止めた（停止の hold）ときだけ、停止を
 *     解く入口（ログインの確かめの画面）を二次の入口にする。
 * - PL-U（設計書 14.1 の U2、13 章の 13）: 最新の点検の結果（報告）があって、進む段がもうない（`AUDIT_AGAIN`）ときは、主のボタンを「結果を見る」
 *   （`AUDIT_RESULT`）にし、「点検を始める」を二次のボタンにする。点検を終えたばかりで移ってきたとき（`arrived=auto`。点検かまとめて実行の作業から）は、
 *   `profileStageAfterAuditArrivalOf` で、どの段でも「結果を見る」を主のボタンにし、元の主のボタン（次の段の操作）を二次のボタンに、元の二次のボタンを
 *   詳しい内容に移す（ボタンは増やさない。移ってきたかは画面の search にしかないので、画面がこの 1 つの部品を呼ぶ）。
 * - 保存の後の次の手順（`nextStepAfter`。ほかの画面の `NextStepLinks`）: 手順の値は 4 つのまま（ログインの確かめの画面の後の段にも使う）。ログインの確かめは、
 *   どのプロファイルでも使わない手順（流れから外した）。
 * - 文言は `messages.ts` の `LOCAL_UI_NEXT_STEP_TEXT`（網羅は `catalog-coverage.ts`）。
 */
import type { EntryCheckAuthSetupState } from '../../../../src/control/auth/auth-setup-proposal.js';
import type { AuditMode, AuthStrategy } from '../../../../src/control/contracts.js';
import { ACTIVE_PROFILE_STATUS, type ProfileStatus } from '../../../../src/control/store/profile-records.js';
import { formatInteger } from '../../../../src/presentation/format.js';
import { LOCAL_UI_JOB_SUMMARY_TEXT } from '../../../../src/presentation/messages.js';
import type { JobSummaryFinishedResult } from '../server/audit-job-functions';
import type { AutoDraftPreviewView } from '../server/scenario-autodraft-functions';
import type { AuditStartBlocker } from '../server/audit-start-check';
import { isExecutableProfile, usesAuthSetup, usesAutomatedLogin, usesScenarios } from './labels';

/** 保存の後の次の手順（閉じた一覧。並べる順）。 */
export const PROFILE_NEXT_STEPS = Object.freeze(['AUTH_SETUP', 'CREDENTIAL', 'LOGIN_CHECK', 'AUDIT_START'] as const);
export type ProfileNextStep = (typeof PROFILE_NEXT_STEPS)[number];

/**
 * その手順を、このモードと認証の方式のプロファイルで使うか（`execution-policy.ts` の行の判定）。PL-1: ログインの確かめは流れから外した（判断 1。点検の
 * 最初の自動ログインが確かめを兼ねる）ので、どのプロファイルでも使わない。
 */
const profileNextStepApplies = (step: ProfileNextStep, mode: AuditMode, auth: AuthStrategy): boolean => {
  switch (step) {
    case 'AUTH_SETUP':
      return usesAuthSetup(mode, auth);
    case 'CREDENTIAL':
      return usesAutomatedLogin(mode, auth);
    case 'LOGIN_CHECK':
      return false;
    case 'AUDIT_START':
      return isExecutableProfile(mode, auth);
  }
};

/** その手順の次に使う手順（なければ `null`。保存の後の次の手順のリンクに使う）。 */
export const nextStepAfter = (step: ProfileNextStep, mode: AuditMode, auth: AuthStrategy): ProfileNextStep | null =>
  PROFILE_NEXT_STEPS.slice(PROFILE_NEXT_STEPS.indexOf(step) + 1).find((next) => profileNextStepApplies(next, mode, auth)) ?? null;

/**
 * サイトの画面の段（閉じた一覧。要点の文の鍵）。
 * - `SITE_RETIRED`: 取り消した。`ENTRY_NOT_CHECKED`: 認証の設定がまだない（入口を確かめ直す）。`AUTH_SETUP_CREATE`: 入口の確かめの案から作れなかった（ログインの設定を作る）。
 * - `AUTH_SETUP_FIX`: 認証の設定が古いか誤り。`CREDENTIAL_FIX`: 自動ログインの ID とパスワードがないか、今のログインの画面と合わない。
 * - `AUTO_LOGIN_WAIT`: 自動ログインの間隔の中。`AUTO_LOGIN_HELD`: 自動ログインを止めている。`BLOCKED`: ほかの理由で始められない。
 * - `AUDIT_PUBLIC`・`AUDIT_MANUAL_LOGIN`・`AUDIT_AUTOMATED_LOGIN`: 点検を始める（公開の画面・手でログイン・自動ログインの最初の点検）。`AUDIT_AGAIN`: 進む段が
 *   もうなく、点検を繰り返す。
 * - `WRITE_MODE_SWITCH`: 書き込みも試す。`SCENARIOS`: 書き込みの手順へ。OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D5）: 「次から自動で
 *   ログインする」（`AUTOMATED_LOGIN_SETUP`）は、ふだんの流れから外した（1 回目の点検の手でのログインの後に、BeakSight が自動ログインへ切り替える）。
 */
export const PROFILE_STAGES = Object.freeze([
  'SITE_RETIRED',
  'ENTRY_NOT_CHECKED',
  'AUTH_SETUP_CREATE',
  'AUTH_SETUP_FIX',
  'CREDENTIAL_FIX',
  'AUTO_LOGIN_WAIT',
  'AUTO_LOGIN_HELD',
  'BLOCKED',
  'AUDIT_PUBLIC',
  'AUDIT_MANUAL_LOGIN',
  'AUDIT_AUTOMATED_LOGIN',
  'AUDIT_AGAIN',
] as const);
export type ProfileStageKind = (typeof PROFILE_STAGES)[number];

/** サイトの画面のボタンの行き先（閉じた一覧。ボタンの名前の鍵）。 */
export const PROFILE_ACTIONS = Object.freeze([
  'RECHECK_ENTRY',
  'AUTH_SETUP',
  'CREDENTIAL',
  'AUDIT_START',
  'SCENARIOS',
  'CLEAR_HOLD',
  // PL-U（14.1 の U2）: 最新の点検の報告を開く（結果を見る）。
  'AUDIT_RESULT',
] as const);
export type ProfileAction = (typeof PROFILE_ACTIONS)[number];

/**
 * 主のボタンでない入口のうち、詳しい内容に置くもの: 点検が 1 回終わってから出す入口（自動でログインする・書き込みも試す）と、PL-U で「結果を見る」に
 * 主のボタンを譲ったときの、元の二次のボタン。
 */
export type ProfileLaterOffer = ProfileAction;

/** 段を選ぶための、画面のサーバが読んだ事実（どれも今の owner の判定の結果）。 */
export interface ProfileStageFacts {
  readonly status: ProfileStatus;
  readonly mode: AuditMode;
  readonly auth: AuthStrategy;
  /** 点検を始められない理由（開始の画面と同じ確かめ。始められるなら `null`）。 */
  readonly auditStartBlocker: AuditStartBlocker | null;
  /** 入口の確かめを今始められるか（同じ確かめの、入口の確かめの種類）。 */
  readonly entryCheckStartable: boolean;
  /** 入口の確かめの後の認証の設定の状態（`entryCheckAuthSetupStateOf`。なければ `null`）。 */
  readonly authSetupProposal: EntryCheckAuthSetupState | null;
  /**
   * 最後の点検のジョブ（なければ `null`）。終わった（`FINISHED`）か、その点検が自動ログインでログインしたか、その点検の報告（HTML）があるか（PL-U の
   * 「結果を見る」）。
   */
  readonly lastAudit: { readonly finished: boolean; readonly automatedLogin: boolean; readonly report: boolean } | null;
  /** 「書き込みにも使う」の対象で、認証の設定が今の改訂に結びつくか。 */
  readonly writeModeSwitchOffered: boolean;
  /**
   * OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.3 の 2）: 「毎回手でログインする」が点検に効くか（`manualLoginEveryTimeApplies`）。効くときは、自動ログインの
   * プロファイルでも、手でログインするサイトと同じ段で進む。省けば偽。
   */
  readonly manualLoginEveryTime?: boolean;
}

/** サイトの画面の段と、ボタン。 */
export interface ProfileStage {
  readonly stage: ProfileStageKind;
  /** 要点のパネルの主のボタン（押せないときは `null`。理由は要点の文）。 */
  readonly primary: ProfileAction | null;
  /** 主のボタンと同じ行の右の二次のボタン（なければ `null`）。 */
  readonly secondary: ProfileAction | null;
  /** 点検が 1 回終わった後の入口のうち、主のボタンでないもの（詳しい内容に置く）。 */
  readonly laterOffers: readonly ProfileLaterOffer[];
}

/** 入口を確かめ直しても案が変わらない、入口の確かめの後の状態（ログインの設定を作る画面へ進める）。 */
const UNCHANGED_BY_RECHECK: ReadonlySet<EntryCheckAuthSetupState> = new Set(['NOT_LOGIN_PAGE', 'PROPOSAL_INVALID']);

const stageOf = (stage: ProfileStageKind, primary: ProfileAction | null, secondary: ProfileAction | null = null): Omit<ProfileStage, 'laterOffers'> =>
  ({ stage, primary, secondary });

/** 始められない理由があるときの段（なければ `null`）。 */
const blockedStageOf = (facts: ProfileStageFacts): Omit<ProfileStage, 'laterOffers'> | null => {
  switch (facts.auditStartBlocker) {
    case null:
      return null;
    case 'AUTH_SETUP_MISSING':
      return facts.authSetupProposal !== null && UNCHANGED_BY_RECHECK.has(facts.authSetupProposal)
        ? stageOf('AUTH_SETUP_CREATE', 'AUTH_SETUP')
        : stageOf('ENTRY_NOT_CHECKED', facts.entryCheckStartable ? 'RECHECK_ENTRY' : null);
    case 'AUTH_SETUP_STALE':
    case 'AUTH_SETUP_INVALID':
      return stageOf('AUTH_SETUP_FIX', 'AUTH_SETUP');
    case 'CREDENTIAL_MISSING':
    case 'CREDENTIAL_STALE':
      return stageOf('CREDENTIAL_FIX', 'CREDENTIAL');
    case 'AUTO_LOGIN_RATE_LIMITED':
      // OP-G（指示書の 4）: 間隔の待ちの間も、最新の点検の報告があれば「結果を見る」を主のボタンにする（始められる時刻は要点の 1 行）。
      return stageOf('AUTO_LOGIN_WAIT', facts.lastAudit?.report === true ? 'AUDIT_RESULT' : null);
    case 'AUTO_LOGIN_HELD':
      return stageOf('AUTO_LOGIN_HELD', null, 'CLEAR_HOLD');
    default:
      return stageOf('BLOCKED', null);
  }
};

/** 点検を始められるときの段（順はファイルの先頭）。 */
const readyStageOf = (facts: ProfileStageFacts): Omit<ProfileStage, 'laterOffers'> => {
  const { mode, auth, lastAudit } = facts;
  // OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'）: 書き込みは点検の流れの一部（サイトの画面の一覧でチェックする）。書き込みの手順の画面は
  // ふだんの流れから外し（詳しい内容の直す道に残す）、書き込みのモードのサイトも、ほかのサイトと同じ点検の段で進む。
  // OP-1: 「毎回手でログインする」が効くなら、手でログインするサイトと同じ段で進む。
  const automated = usesAutomatedLogin(mode, auth) && facts.manualLoginEveryTime !== true;
  if (lastAudit === null || !lastAudit.finished || (automated && !lastAudit.automatedLogin)) {
    if (automated) {
      return stageOf('AUDIT_AUTOMATED_LOGIN', 'AUDIT_START');
    }
    return stageOf(usesAuthSetup(mode, auth) ? 'AUDIT_MANUAL_LOGIN' : 'AUDIT_PUBLIC', 'AUDIT_START');
  }
  // PL-U（14.1 の U2）: 進む段がもうないときは、最新の点検の結果を主のボタンにする（報告がなければ、今どおり点検を繰り返す）。
  return lastAudit.report ? stageOf('AUDIT_AGAIN', 'AUDIT_RESULT', 'AUDIT_START') : stageOf('AUDIT_AGAIN', 'AUDIT_START');
};

/** サイトの画面の段とボタン（決め方はファイルの先頭。サイトの画面とサイトの一覧が使う）。 */
export const profileStageOf = (facts: ProfileStageFacts): ProfileStage => {
  if (facts.status !== ACTIVE_PROFILE_STATUS) {
    return { stage: 'SITE_RETIRED', primary: null, secondary: null, laterOffers: [] };
  }
  const chosen = blockedStageOf(facts) ?? readyStageOf(facts);
  // OP-2: 「書き込みも試す」はなくした（書き込みのモードへの切り替えは、一覧のチェックの保存が行う）。
  const laterOffers: ProfileLaterOffer[] = [];
  return { ...chosen, laterOffers };
};

/**
 * PL-U（14.1 の U2）: 点検を終えたばかりで移ってきたときの段とボタン（`profileStageOf` の結果から）。「結果を見る」を主のボタンにし、元の主のボタン
 * （次の段の操作。なければ元の二次のボタン）を二次のボタンに、押し出された元の二次のボタンを詳しい内容に移す。取り消したサイトと、すでに「結果を見る」が
 * 主のボタンの段は、そのまま。呼ぶのは、最新の点検の報告があるときだけ（画面が、移ってきた印と報告の有無を見て呼ぶ）。
 */
export const profileStageAfterAuditArrivalOf = (stage: ProfileStage): ProfileStage => {
  if (stage.stage === 'SITE_RETIRED' || stage.primary === 'AUDIT_RESULT') {
    return stage;
  }
  const secondary = stage.primary ?? stage.secondary;
  const displaced = stage.primary !== null && stage.secondary !== null ? [stage.secondary] : [];
  return { stage: stage.stage, primary: 'AUDIT_RESULT', secondary, laterOffers: [...stage.laterOffers, ...displaced] };
};

/**
 * 終わった作業の結果の 1 行（作業の画面の要点と、移ってきたサイトの画面の要点の 1 行目が共用する。PL-U で作業の画面から移した）。点検が最後まで終わり、
 * 報告の小さなまとめを読めたとき（`problemCount` が `null` でない。決めるのはサーバの要点）は、問題の数を言う（PL-R。設計書 14 章、13 章の 13）。
 */
export const finishedJobResultTextOf = (result: JobSummaryFinishedResult, problemCount: number | null): string => {
  if (result !== 'AUDIT_COMPLETE' || problemCount === null) {
    return LOCAL_UI_JOB_SUMMARY_TEXT.finished[result];
  }
  return problemCount === 0
    ? LOCAL_UI_JOB_SUMMARY_TEXT.auditCompleteWithoutProblems
    : LOCAL_UI_JOB_SUMMARY_TEXT.auditCompleteWithProblems(formatInteger(problemCount));
};

/**
 * PL-U（設計書 14.1 の U4）: 書き込みの手順が 0 件の一覧の主のボタン「書き込みの手順を作る」の行き先（閉じた一覧）。`CREATE_DRAFTS`: 最後の操作さがしの
 * 結果から下書きを作る（操作さがしの画面と同じ部品とダイアログ）。`START_DISCOVERY`: 使える操作さがしの結果がない（ない・サイトの設定を変えた後・書き込める
 * 形がない）ので、操作さがしを始める。
 */
export type EmptyScenarioListEntry = 'CREATE_DRAFTS' | 'START_DISCOVERY';

/** 操作さがしをやり直せば使える結果になる、下書きを作れない理由（`api-scenario-autodraft.ts` の `AUTO_DRAFT_BLOCKERS` のうち）。 */
const DISCOVERY_REDO_BLOCKERS: ReadonlySet<AutoDraftPreviewView['blocker']> = new Set(['DISCOVERY_MISSING', 'DISCOVERY_STALE', 'NO_WRITE_ROWS']);

/** 0 件の一覧の主のボタンの行き先（書き込みの手順を使えない・取り消したサイト、作る登録の形がないときは `null`。値は下書きの部品の案だけを見る）。 */
export const emptyScenarioListEntryOf = (preview: AutoDraftPreviewView | null): EmptyScenarioListEntry | null => {
  if (preview === null) {
    return null;
  }
  if (preview.blocker === null) {
    return preview.creates.some(({ status }) => status === 'NEW') ? 'CREATE_DRAFTS' : null;
  }
  return DISCOVERY_REDO_BLOCKERS.has(preview.blocker) ? 'START_DISCOVERY' : null;
};

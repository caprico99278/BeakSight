/**
 * サイトの画面の主のボタンの決め方（PL-1。設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1、4 章の 1・7、6 章の 1〜6 の段）と、保存の後の
 * 次の手順を固定する（ブラウザとビルドを使わない純粋な部品の確かめ）。
 * - 主のボタンは段で決まる（入口を確かめ直す → 点検を始める → 次から自動でログインする → 点検を始める → 書き込みも試す → 書き込みの手順へ）。決め方は
 *   `display/next-steps.ts` の `profileStageOf` の 1 か所（画面のサーバ `profileOnboardingFn` が読んだ事実を渡す）。
 * - ログインの確かめは流れから外す（判断 1。4 章の 7）。自動ログインにした後の主のボタンは「点検を始める」。自動ログインの間隔で始められないときは主のボタンを
 *   出さず、止めた（停止の hold）ときだけ、停止を解く入口（ログインの確かめの画面）を二次の入口にする。
 * - 前の T43a の「次にすること」の表（手順ごとの状態）は、3 章の形（要点＋主のボタン 1 つ＋詳しい内容 1 つ）に置き換えた。
 */
import { describe, expect, it } from 'vitest';
import { AUDIT_JOB_START_REJECTION_DESCRIPTIONS, LOCAL_UI_NEXT_STEP_TEXT } from '../../../src/presentation/messages.js';
import {
  PROFILE_ACTIONS,
  PROFILE_NEXT_STEPS,
  PROFILE_STAGES,
  emptyScenarioListEntryOf,
  nextStepAfter,
  profileStageAfterAuditArrivalOf,
  profileStageOf,
  type ProfileStageFacts,
} from '../src/display/next-steps';

/** 入口の確かめの前の、手でログインするテスト用のサイトの事実（認証の設定がまだない）。 */
const MANUAL_BEFORE_ENTRY_CHECK: ProfileStageFacts = Object.freeze({
  status: 'ACTIVE',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  auditStartBlocker: 'AUTH_SETUP_MISSING',
  entryCheckStartable: true,
  authSetupProposal: 'NOT_CHECKED',
  lastAudit: null,
  writeModeSwitchOffered: false,
});

/** 入口の確かめの後（認証の設定を案で保存した）。フォームでログインするサイトは、ここで切り替えの前の確かめが通る（`automatedLoginReady`）。 */
const MANUAL_AFTER_ENTRY_CHECK: ProfileStageFacts = Object.freeze({
  ...MANUAL_BEFORE_ENTRY_CHECK,
  auditStartBlocker: null,
  authSetupProposal: 'PRESENT',
  writeModeSwitchOffered: true,
});

/** 手でログインした点検が 1 回終わった後。 */
const MANUAL_AFTER_AUDIT: ProfileStageFacts = Object.freeze({
  ...MANUAL_AFTER_ENTRY_CHECK,
  lastAudit: { finished: true, automatedLogin: false, report: false },
});

/** 自動ログインに切り替えた直後（前の点検は手でのログイン。切り替えの対象でなくなる）。 */
const AUTOMATED_AFTER_SWITCH: ProfileStageFacts = Object.freeze({
  ...MANUAL_AFTER_AUDIT,
  auth: 'AUTOMATED_LOGIN',
});

describe('PL-1: the primary button of the site screen follows the stage (design 6, steps 1-6)', () => {
  it('lists the stages and the actions as closed lists, with a label and a summary text in the catalog for each', () => {
    for (const action of PROFILE_ACTIONS) {
      expect(LOCAL_UI_NEXT_STEP_TEXT.actions[action].length).toBeGreaterThan(0);
    }
    for (const stage of PROFILE_STAGES) {
      expect(LOCAL_UI_NEXT_STEP_TEXT.stages[stage].length).toBeGreaterThan(0);
      expect(LOCAL_UI_NEXT_STEP_TEXT.listStages[stage].length).toBeGreaterThan(0);
    }
  });

  it('before the entry check: re-checks the entry (no audit, no automated login, no write mode yet)', () => {
    expect(profileStageOf(MANUAL_BEFORE_ENTRY_CHECK)).toEqual({ stage: 'ENTRY_NOT_CHECKED', primary: 'RECHECK_ENTRY', secondary: null, laterOffers: [] });
    // 入口の確かめを今は始められないときは、主のボタンを出さない（理由は要点）。
    expect(profileStageOf({ ...MANUAL_BEFORE_ENTRY_CHECK, entryCheckStartable: false }).primary).toBeNull();
    // ログインの画面に見えなかった・案が確かめを通らなかったときは、入口を確かめ直しても変わらないので、ログインの設定を作る画面へ。
    for (const authSetupProposal of ['NOT_LOGIN_PAGE', 'PROPOSAL_INVALID'] as const) {
      expect(profileStageOf({ ...MANUAL_BEFORE_ENTRY_CHECK, authSetupProposal })).toMatchObject({ stage: 'AUTH_SETUP_CREATE', primary: 'AUTH_SETUP' });
    }
  });

  it('after the entry check: starts the audit, and offers neither the automated login nor the write mode before an audit finished (4-1)', () => {
    expect(profileStageOf(MANUAL_AFTER_ENTRY_CHECK)).toEqual({ stage: 'AUDIT_MANUAL_LOGIN', primary: 'AUDIT_START', secondary: null, laterOffers: [] });
    // 点検が終わっていない（失敗・止めた・動いている）間も、まだ出さない。
    expect(profileStageOf({ ...MANUAL_AFTER_ENTRY_CHECK, lastAudit: { finished: false, automatedLogin: false, report: false } }))
      .toEqual({ stage: 'AUDIT_MANUAL_LOGIN', primary: 'AUDIT_START', secondary: null, laterOffers: [] });
  });

  // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D5）: 「次から自動でログインする」の段はなくした（1 回目の点検の手でのログインの後に、
  // BeakSight が自動ログインへ切り替える）。手でログインした点検の後は、書き込みも試すへ進む。
  // OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'）: 「書き込みも試す」と「書き込みの手順へ」の段はなくした（書き込みは、サイトの画面の
  // 一覧でチェックした画面だけ、点検の中で行う）。点検が終わった後は、どのサイトも点検の段（結果を見る・点検を始める）。
  it('after a manual audit: the audit again (no switch to the automated login, OP-1; no "write too", OP-2)', () => {
    expect(profileStageOf(MANUAL_AFTER_AUDIT))
      .toEqual({ stage: 'AUDIT_AGAIN', primary: 'AUDIT_START', secondary: null, laterOffers: [] });
  });

  it('after the switch to the automated login: starts the audit (the login check is no longer in the flow, decision 1)', () => {
    expect(profileStageOf(AUTOMATED_AFTER_SWITCH)).toEqual({
      stage: 'AUDIT_AUTOMATED_LOGIN',
      primary: 'AUDIT_START',
      secondary: null,
      laterOffers: [],
    });
    // 自動ログインの点検が 1 回終わったら、点検の段（OP-2: 「書き込みも試す」はなくした）。
    expect(profileStageOf({ ...AUTOMATED_AFTER_SWITCH, lastAudit: { finished: true, automatedLogin: true, report: false } }))
      .toEqual({ stage: 'AUDIT_AGAIN', primary: 'AUDIT_START', secondary: null, laterOffers: [] });
  });

  it('within the automated login interval: the latest result is the primary button if any (the summary says when), and the held login offers the way to clear it', () => {
    expect(profileStageOf({ ...AUTOMATED_AFTER_SWITCH, auditStartBlocker: 'AUTO_LOGIN_RATE_LIMITED' }))
      .toMatchObject({ stage: 'AUTO_LOGIN_WAIT', primary: null, secondary: null });
    // OP-G（指示書の 4）: 点検の報告があれば、待つ間も「結果を見る」が主のボタン（始められる時刻は要点の 1 行）。
    expect(profileStageOf({
      ...AUTOMATED_AFTER_SWITCH, auditStartBlocker: 'AUTO_LOGIN_RATE_LIMITED', lastAudit: { finished: true, automatedLogin: true, report: true },
    })).toMatchObject({ stage: 'AUTO_LOGIN_WAIT', primary: 'AUDIT_RESULT', secondary: null });
    expect(profileStageOf({ ...AUTOMATED_AFTER_SWITCH, auditStartBlocker: 'AUTO_LOGIN_HELD' }))
      .toMatchObject({ stage: 'AUTO_LOGIN_HELD', primary: null, secondary: 'CLEAR_HOLD' });
  });

  it('in the write mode: the same audit stage as the other sites (the write scenarios are out of the usual flow, OP-2)', () => {
    const write: ProfileStageFacts = { ...AUTOMATED_AFTER_SWITCH, mode: 'TEST_APPROVED_WRITE', writeModeSwitchOffered: false, lastAudit: { finished: true, automatedLogin: true, report: false } };
    expect(profileStageOf(write)).toEqual({ stage: 'AUDIT_AGAIN', primary: 'AUDIT_START', secondary: null, laterOffers: [] });
    expect(profileStageOf({ ...write, lastAudit: { finished: true, automatedLogin: true, report: true } }))
      .toEqual({ stage: 'AUDIT_AGAIN', primary: 'AUDIT_RESULT', secondary: 'AUDIT_START', laterOffers: [] });
    // OP-1: 手でログインする書き込みのサイトにも、自動ログインにする入口を置かない（ふだんの流れから外した）。
    expect(profileStageOf({ ...write, auth: 'MANUAL_SESSION' }).laterOffers).toEqual([]);
  });

  it('public site: starts the audit, again after it finished', () => {
    const publicSite: ProfileStageFacts = {
      ...MANUAL_BEFORE_ENTRY_CHECK, mode: 'PUBLIC_PASSIVE', auth: 'NONE', auditStartBlocker: null, authSetupProposal: 'NOT_USED',
    };
    expect(profileStageOf(publicSite)).toEqual({ stage: 'AUDIT_PUBLIC', primary: 'AUDIT_START', secondary: null, laterOffers: [] });
    expect(profileStageOf({ ...publicSite, lastAudit: { finished: true, automatedLogin: false, report: false } }))
      .toEqual({ stage: 'AUDIT_AGAIN', primary: 'AUDIT_START', secondary: null, laterOffers: [] });
  });

  it('fixes a stale login setup or credential, stops on the other start blockers, and shows nothing to press on a retired site', () => {
    expect(profileStageOf({ ...MANUAL_AFTER_AUDIT, auditStartBlocker: 'AUTH_SETUP_STALE' })).toMatchObject({ stage: 'AUTH_SETUP_FIX', primary: 'AUTH_SETUP' });
    expect(profileStageOf({ ...MANUAL_AFTER_AUDIT, auditStartBlocker: 'AUTH_SETUP_INVALID' })).toMatchObject({ stage: 'AUTH_SETUP_FIX', primary: 'AUTH_SETUP' });
    expect(profileStageOf({ ...AUTOMATED_AFTER_SWITCH, auditStartBlocker: 'CREDENTIAL_STALE' })).toMatchObject({ stage: 'CREDENTIAL_FIX', primary: 'CREDENTIAL' });
    expect(profileStageOf({ ...AUTOMATED_AFTER_SWITCH, auditStartBlocker: 'CREDENTIAL_MISSING' })).toMatchObject({ stage: 'CREDENTIAL_FIX', primary: 'CREDENTIAL' });
    expect(profileStageOf({ ...MANUAL_AFTER_AUDIT, auditStartBlocker: 'TARGET_CONFIG_UNAVAILABLE' })).toMatchObject({ stage: 'BLOCKED', primary: null, secondary: null });
    expect(AUDIT_JOB_START_REJECTION_DESCRIPTIONS.TARGET_CONFIG_UNAVAILABLE.description.length).toBeGreaterThan(0);
    expect(profileStageOf({ ...MANUAL_AFTER_AUDIT, status: 'RETIRED', auditStartBlocker: 'PROFILE_RETIRED' }))
      .toEqual({ stage: 'SITE_RETIRED', primary: null, secondary: null, laterOffers: [] });
  });
});

// PL-U（設計書 14.1 の U2、13 章の 13）: 点検を終えたばかりで移ってきたときと、最新の点検の結果があって次の段の操作がないときは、主のボタンを「結果を見る」に
// する。次の段の操作は、そのときは二次のボタン（決め方は `next-steps.ts` の 1 か所。画面は描くだけ）。
describe('PL-U: the result of the audit is the primary button right after an audit, and when there is nothing next', () => {
  const publicSite: ProfileStageFacts = {
    ...MANUAL_BEFORE_ENTRY_CHECK, mode: 'PUBLIC_PASSIVE', auth: 'NONE', auditStartBlocker: null, authSetupProposal: 'NOT_USED',
  };

  it('opens the result when the last audit has its report and no next stage is left, with the audit as the secondary button', () => {
    expect(profileStageOf({ ...publicSite, lastAudit: { finished: true, automatedLogin: false, report: true } }))
      .toEqual({ stage: 'AUDIT_AGAIN', primary: 'AUDIT_RESULT', secondary: 'AUDIT_START', laterOffers: [] });
    // 報告がない（作れなかった）ときは、今どおり「点検を始める」。
    expect(profileStageOf({ ...publicSite, lastAudit: { finished: true, automatedLogin: false, report: false } }))
      .toEqual({ stage: 'AUDIT_AGAIN', primary: 'AUDIT_START', secondary: null, laterOffers: [] });
    // OP-2: 手でログインした点検の後も、次の段の操作（前の「書き込みも試す」）はないので、結果を見るが主のボタン。
    expect(profileStageOf({ ...MANUAL_AFTER_AUDIT, lastAudit: { finished: true, automatedLogin: false, report: true } }))
      .toMatchObject({ stage: 'AUDIT_AGAIN', primary: 'AUDIT_RESULT', secondary: 'AUDIT_START' });
    expect(LOCAL_UI_NEXT_STEP_TEXT.actions.AUDIT_RESULT).toBe('結果を見る');
  });

  it('right after an audit: the result is the primary button, the next stage is the secondary one, and the old secondary goes into the details', () => {
    const afterManual = profileStageOf({ ...MANUAL_AFTER_AUDIT, lastAudit: { finished: true, automatedLogin: false, report: true } });
    // OP-2: すでに結果が主のボタン（次の段の操作はない）ので、そのまま。
    expect(profileStageAfterAuditArrivalOf(afterManual)).toEqual({
      stage: 'AUDIT_AGAIN',
      primary: 'AUDIT_RESULT',
      secondary: 'AUDIT_START',
      laterOffers: [],
    });
    // 次の段の操作がある段（自動ログインの最初の点検）では、結果を見るを主にし、元の主のボタンを二次へ。
    expect(profileStageAfterAuditArrivalOf(profileStageOf({ ...AUTOMATED_AFTER_SWITCH, lastAudit: { finished: true, automatedLogin: false, report: true } })))
      .toMatchObject({ stage: 'AUDIT_AUTOMATED_LOGIN', primary: 'AUDIT_RESULT', secondary: 'AUDIT_START' });
    // 自動ログインの間隔の中（主のボタンがない）でも、結果は見られる。止めた自動ログインを解く入口は、二次のボタンのまま。
    expect(profileStageAfterAuditArrivalOf(profileStageOf({ ...AUTOMATED_AFTER_SWITCH, auditStartBlocker: 'AUTO_LOGIN_RATE_LIMITED' })))
      .toMatchObject({ stage: 'AUTO_LOGIN_WAIT', primary: 'AUDIT_RESULT', secondary: null });
    expect(profileStageAfterAuditArrivalOf(profileStageOf({ ...AUTOMATED_AFTER_SWITCH, auditStartBlocker: 'AUTO_LOGIN_HELD' })))
      .toMatchObject({ stage: 'AUTO_LOGIN_HELD', primary: 'AUDIT_RESULT', secondary: 'CLEAR_HOLD' });
    // すでに結果が主のボタンなら、そのまま。取り消したサイトには何も出さない。
    const again = profileStageOf({ ...publicSite, lastAudit: { finished: true, automatedLogin: false, report: true } });
    expect(profileStageAfterAuditArrivalOf(again)).toEqual(again);
    const retired = profileStageOf({ ...MANUAL_AFTER_AUDIT, status: 'RETIRED', auditStartBlocker: 'PROFILE_RETIRED' });
    expect(profileStageAfterAuditArrivalOf(retired)).toEqual(retired);
  });
});

// PL-U（設計書 14.1 の U4）: 書き込みの手順が 0 件の一覧の主のボタン「書き込みの手順を作る」の行き先（操作さがしの結果があれば下書き、使える結果がなければ
// 操作さがしを始める。書き込みの手順を使えないサイトでは出さない）。
describe('PL-U: the primary button of the empty list of the write steps', () => {
  const row = { kind: 'CREATE', transport: 'API', identityDigest: 'a', shapeDigest: 'b', method: 'POST', pathShape: '/x', pagePath: '/x' } as const;
  const createOf = (status: 'NEW' | 'EXISTING' | 'REJECTED') => ({
    ...row, status, scenarioId: null, reason: null, recordIdKey: null, readCheck: null, readTemplate: null, gaps: [],
  });
  const previewOf = (blocker: Parameters<typeof emptyScenarioListEntryOf>[0] extends infer P ? P extends { blocker: infer B } ? B : never : never,
    creates: readonly ReturnType<typeof createOf>[] = []) => ({ blocker, expectedRevision: 1, discoveryJobId: blocker === 'DISCOVERY_MISSING' ? null : 'job', creates, updates: [] });

  it('makes the drafts from the discovery result, and starts the discovery when there is no usable result', () => {
    expect(emptyScenarioListEntryOf(previewOf(null, [createOf('NEW')]))).toBe('CREATE_DRAFTS');
    for (const blocker of ['DISCOVERY_MISSING', 'DISCOVERY_STALE', 'NO_WRITE_ROWS'] as const) {
      expect(emptyScenarioListEntryOf(previewOf(blocker)), blocker).toBe('START_DISCOVERY');
    }
    // 書き込みの手順を使えない・取り消したサイト、作る登録の形がない（作れない形だけ）ときは、主のボタンを出さない。
    expect(emptyScenarioListEntryOf(previewOf('PROFILE_NOT_EDITABLE'))).toBeNull();
    expect(emptyScenarioListEntryOf(previewOf(null, [createOf('REJECTED')]))).toBeNull();
    expect(emptyScenarioListEntryOf(null)).toBeNull();
  });
});

describe('PL-1: the next step after saving (the login check is out of the flow)', () => {
  it('goes from the auth setup to the credential (automated) or to the audit start (manual), and from the credential to the audit start', () => {
    // 手順の値は、ほかの画面の保存の後のリンク（`NextStepLinks`）が使う。ログインの確かめはどのプロファイルでも使わない手順になった。
    expect(PROFILE_NEXT_STEPS).toEqual(['AUTH_SETUP', 'CREDENTIAL', 'LOGIN_CHECK', 'AUDIT_START']);
    expect(nextStepAfter('AUTH_SETUP', 'TEST_AUTH_PASSIVE', 'AUTOMATED_LOGIN')).toBe('CREDENTIAL');
    expect(nextStepAfter('AUTH_SETUP', 'TEST_AUTH_PASSIVE', 'MANUAL_SESSION')).toBe('AUDIT_START');
    expect(nextStepAfter('AUTH_SETUP', 'TEST_APPROVED_WRITE', 'MANUAL_SESSION')).toBe('AUDIT_START');
    expect(nextStepAfter('CREDENTIAL', 'TEST_AUTH_PASSIVE', 'AUTOMATED_LOGIN')).toBe('AUDIT_START');
    expect(nextStepAfter('LOGIN_CHECK', 'TEST_AUTH_PASSIVE', 'AUTOMATED_LOGIN')).toBe('AUDIT_START');
    expect(nextStepAfter('LOGIN_CHECK', 'TEST_APPROVED_WRITE', 'AUTOMATED_LOGIN')).toBe('AUDIT_START');
    expect(nextStepAfter('AUDIT_START', 'PUBLIC_PASSIVE', 'NONE')).toBeNull();
    for (const step of PROFILE_NEXT_STEPS) {
      expect(LOCAL_UI_NEXT_STEP_TEXT.after.actions[step].length).toBeGreaterThan(0);
    }
  });
});

// OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D5、4.1.3。08 の指摘）: 自動ログインは既定（1 回目の点検の手でのログインの後に、BeakSight が
// 切り替える）。「次から自動でログインする」は、ふだんの流れ（主のボタン・二次のボタン・詳しい内容の入口）から外した。
describe('OP-1: no "log in automatically next time" in the usual flow', () => {
  it('has no stage and no action for the switch, and the finished manual audit goes on to the next stage', () => {
    expect(PROFILE_STAGES as readonly string[]).not.toContain('AUTOMATED_LOGIN_SETUP');
    expect(PROFILE_ACTIONS as readonly string[]).not.toContain('AUTOMATED_LOGIN_SETUP');
    const finished = profileStageOf({ ...MANUAL_AFTER_ENTRY_CHECK, lastAudit: { finished: true, automatedLogin: false, report: true } });
    // OP-2: 「書き込みも試す」もなくしたので、次は結果を見る。
    expect(finished.primary).toBe('AUDIT_RESULT');
    expect(PROFILE_STAGES as readonly string[]).not.toContain('WRITE_MODE_SWITCH');
    expect(PROFILE_ACTIONS as readonly string[]).not.toContain('WRITE_MODE_SWITCH');
    expect(finished.laterOffers as readonly string[]).not.toContain('AUTOMATED_LOGIN_SETUP');
  });
});

// OP-1（設計書 4.1.3 の 2）: 「毎回手でログインする」の自動ログインのプロファイルは、手でログインするサイトと同じ段で進む（手でログインした点検が終われば次の段へ）。
describe('OP-1: the stage of an automated login profile that logs in by hand every time', () => {
  it('goes on after a manual audit, as a manual login site', () => {
    const facts: ProfileStageFacts = {
      ...AUTOMATED_AFTER_SWITCH, manualLoginEveryTime: true, lastAudit: { finished: true, automatedLogin: false, report: false },
    };
    expect(profileStageOf(facts)).toMatchObject({ stage: 'AUDIT_AGAIN', primary: 'AUDIT_START' });
    expect(profileStageOf({ ...facts, lastAudit: null })).toMatchObject({ stage: 'AUDIT_MANUAL_LOGIN', primary: 'AUDIT_START' });
    expect(profileStageOf({ ...facts, manualLoginEveryTime: false })).toMatchObject({ stage: 'AUDIT_AUTOMATED_LOGIN' });
  });
});

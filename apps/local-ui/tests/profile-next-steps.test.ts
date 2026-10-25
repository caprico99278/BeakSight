/**
 * T43a（Task 43 の設計書 4.1）: プロファイルの詳細の「次にすること」の状態の選び方と、監査を始められない理由（一覧の短い理由）、保存の後の次の手順を
 * 固定する（ブラウザとビルドを使わない純粋な部品の確かめ）。
 * - 状態は、今の部品の判定（`execution-policy.ts` の行、保存した認証の設定の新しさ、開始の確かめの `CREDENTIAL_STALE`、最後のログインの確かめのジョブ）
 *   から選ぶだけ。第二の判定を作らない。
 * - 文言と表示は、表示のカタログ（`catalog.ts` の `PROFILE_NEXT_STEP_CATALOG`・`NEXT_STEP_STATE_CATALOG`、`messages.ts` の `LOCAL_UI_NEXT_STEP_TEXT`）。
 */
import { describe, expect, it } from 'vitest';
import { profileOperationRejectionOf } from '../../../src/control/execution-policy.js';
import { NEXT_STEP_STATE_CATALOG, PROFILE_NEXT_STEP_CATALOG } from '../../../src/presentation/catalog.js';
import { AUDIT_JOB_START_REJECTION_DESCRIPTIONS, LOCAL_UI_NEXT_STEP_TEXT } from '../../../src/presentation/messages.js';
import {
  NEXT_STEP_STATES,
  PROFILE_NEXT_STEPS,
  auditStartUnavailableReasonOf,
  nextStepAfter,
  profileNextStepsOf,
  type ProfileNextStepFacts,
} from '../src/display/next-steps';

/** 何も済んでいない、公開の監査のプロファイルの事実。 */
const PUBLIC_FACTS: ProfileNextStepFacts = Object.freeze({
  mode: 'PUBLIC_PASSIVE',
  auth: 'NONE',
  revision: 1,
  authSetupFreshness: null,
  credentialSaved: false,
  credentialStale: false,
  lastLoginCheck: null,
  lastAuditFinished: false,
});

/** 状態だけを、手順の順に並べる。 */
const statesOf = (facts: ProfileNextStepFacts): readonly string[] => profileNextStepsOf(facts).map(({ state }) => state);

describe('T43a: the next steps of a profile', () => {
  it('lists the four steps in a fixed order, each with a label and a state label in the catalog', () => {
    expect(profileNextStepsOf(PUBLIC_FACTS).map(({ step }) => step)).toEqual([...PROFILE_NEXT_STEPS]);
    expect(PROFILE_NEXT_STEPS).toEqual(['AUTH_SETUP', 'CREDENTIAL', 'LOGIN_CHECK', 'AUDIT_START']);
    for (const step of PROFILE_NEXT_STEPS) {
      expect(PROFILE_NEXT_STEP_CATALOG[step].label.length).toBeGreaterThan(0);
      expect(LOCAL_UI_NEXT_STEP_TEXT.after.actions[step].length).toBeGreaterThan(0);
    }
    expect(Object.keys(NEXT_STEP_STATE_CATALOG).sort()).toEqual([...NEXT_STEP_STATES].sort());
    expect(NEXT_STEP_STATE_CATALOG.DONE.label).toBe('済み');
    expect(NEXT_STEP_STATE_CATALOG.NEEDED.label).toBe('要る');
    expect(NEXT_STEP_STATE_CATALOG.NOT_NEEDED.label).toBe('要らない');
    expect(NEXT_STEP_STATE_CATALOG.STALE.label).toBe('古い（直す）');
  });

  it('public audit: only the audit start is needed, and it is done after a finished audit', () => {
    expect(statesOf(PUBLIC_FACTS)).toEqual(['NOT_NEEDED', 'NOT_NEEDED', 'NOT_NEEDED', 'NEEDED']);
    expect(statesOf({ ...PUBLIC_FACTS, lastAuditFinished: true })).toEqual(['NOT_NEEDED', 'NOT_NEEDED', 'NOT_NEEDED', 'DONE']);
  });

  it('manual login: the auth setup is needed, done when current, and stale after the profile changed', () => {
    const manual: ProfileNextStepFacts = { ...PUBLIC_FACTS, mode: 'TEST_AUTH_PASSIVE', auth: 'MANUAL_SESSION' };
    expect(statesOf(manual)).toEqual(['NEEDED', 'NOT_NEEDED', 'NOT_NEEDED', 'NEEDED']);
    expect(statesOf({ ...manual, authSetupFreshness: 'CURRENT' })).toEqual(['DONE', 'NOT_NEEDED', 'NOT_NEEDED', 'NEEDED']);
    expect(statesOf({ ...manual, authSetupFreshness: 'STALE', revision: 2 })).toEqual(['STALE', 'NOT_NEEDED', 'NOT_NEEDED', 'NEEDED']);
  });

  it('automated login: the credential and the login check follow the saved credential and the last login check job', () => {
    const automated: ProfileNextStepFacts = { ...PUBLIC_FACTS, mode: 'TEST_AUTH_PASSIVE', auth: 'AUTOMATED_LOGIN', authSetupFreshness: 'CURRENT' };
    expect(statesOf(automated)).toEqual(['DONE', 'NEEDED', 'NEEDED', 'NEEDED']);
    expect(statesOf({ ...automated, credentialSaved: true })).toEqual(['DONE', 'DONE', 'NEEDED', 'NEEDED']);
    expect(statesOf({ ...automated, credentialSaved: true, credentialStale: true })).toEqual(['DONE', 'STALE', 'NEEDED', 'NEEDED']);
    // 最後のログインの確かめが失敗なら、まだ要る。成功で、そのジョブの改訂が今の改訂なら済み、改訂が変わったら古い。
    expect(statesOf({ ...automated, credentialSaved: true, lastLoginCheck: { succeeded: false, profileRevision: 1 } }))
      .toEqual(['DONE', 'DONE', 'NEEDED', 'NEEDED']);
    expect(statesOf({ ...automated, credentialSaved: true, lastLoginCheck: { succeeded: true, profileRevision: 1 } }))
      .toEqual(['DONE', 'DONE', 'DONE', 'NEEDED']);
    expect(statesOf({ ...automated, revision: 2, authSetupFreshness: 'STALE', credentialSaved: true, lastLoginCheck: { succeeded: true, profileRevision: 1 } }))
      .toEqual(['STALE', 'DONE', 'STALE', 'NEEDED']);
  });

  it('approved write mode: the audit start is not needed (the audit is not executable in this mode)', () => {
    const write: ProfileNextStepFacts = { ...PUBLIC_FACTS, mode: 'TEST_APPROVED_WRITE', auth: 'AUTOMATED_LOGIN' };
    expect(statesOf(write)).toEqual(['NEEDED', 'NEEDED', 'NEEDED', 'NOT_NEEDED']);
  });
});

describe('T43a: the next step after saving', () => {
  it('goes from the auth setup to the credential (automated) or to the audit start (manual), and has none in the write mode', () => {
    expect(nextStepAfter('AUTH_SETUP', 'TEST_AUTH_PASSIVE', 'AUTOMATED_LOGIN')).toBe('CREDENTIAL');
    expect(nextStepAfter('AUTH_SETUP', 'TEST_AUTH_PASSIVE', 'MANUAL_SESSION')).toBe('AUDIT_START');
    expect(nextStepAfter('AUTH_SETUP', 'TEST_APPROVED_WRITE', 'MANUAL_SESSION')).toBeNull();
    expect(nextStepAfter('CREDENTIAL', 'TEST_AUTH_PASSIVE', 'AUTOMATED_LOGIN')).toBe('LOGIN_CHECK');
    expect(nextStepAfter('LOGIN_CHECK', 'TEST_AUTH_PASSIVE', 'AUTOMATED_LOGIN')).toBe('AUDIT_START');
    expect(nextStepAfter('LOGIN_CHECK', 'TEST_APPROVED_WRITE', 'AUTOMATED_LOGIN')).toBeNull();
    expect(nextStepAfter('AUDIT_START', 'PUBLIC_PASSIVE', 'NONE')).toBeNull();
  });
});

describe('T43a: why the audit cannot be started (the list shows the same reason shortly)', () => {
  it('uses the status first, then the operation policy of execution-policy.ts', () => {
    expect(auditStartUnavailableReasonOf('ACTIVE', 'PUBLIC_PASSIVE', 'NONE')).toBeNull();
    expect(auditStartUnavailableReasonOf('ACTIVE', 'TEST_AUTH_PASSIVE', 'MANUAL_SESSION')).toBeNull();
    expect(auditStartUnavailableReasonOf('RETIRED', 'PUBLIC_PASSIVE', 'NONE')).toBe('PROFILE_RETIRED');
    expect(auditStartUnavailableReasonOf('ACTIVE', 'TEST_APPROVED_WRITE', 'MANUAL_SESSION')).toBe('MODE_NOT_EXECUTABLE');
    expect(auditStartUnavailableReasonOf('ACTIVE', 'PUBLIC_PASSIVE', 'MANUAL_SESSION')).toBe('AUTH_STRATEGY_NOT_EXECUTABLE');
    // 判定は owner のまま（モードと方式の理由は `profileOperationRejectionOf` と同じ値）。
    expect(auditStartUnavailableReasonOf('ACTIVE', 'TEST_APPROVED_WRITE', 'AUTOMATED_LOGIN'))
      .toBe(profileOperationRejectionOf('AUDIT', 'TEST_APPROVED_WRITE', 'AUTOMATED_LOGIN'));
  });

  it('has a short text for every reason, and the reason is one of the start rejection reasons', () => {
    for (const reason of ['PROFILE_RETIRED', 'MODE_NOT_EXECUTABLE', 'AUTH_STRATEGY_NOT_EXECUTABLE'] as const) {
      expect(LOCAL_UI_NEXT_STEP_TEXT.auditStartUnavailable[reason].length).toBeGreaterThan(0);
      expect(AUDIT_JOB_START_REJECTION_DESCRIPTIONS[reason].description.length).toBeGreaterThan(0);
    }
  });
});

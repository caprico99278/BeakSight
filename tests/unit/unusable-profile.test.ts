// MI-F3 項目 6（ユーザーの指示 2026-10-26「フォームやボタンは増やさない。基本的に自動化を厳守する」）: 使えないプロファイルを画面のサーバの起動のときに自動で
// 取り消すかの判定（`src/control/unusable-profile.ts`。純粋な関数の 1 か所）。
// - 対象は、取り消していない、認証の方式が自動ログインで、認証の設定がないプロファイル（MI より前に作られた形。今の画面の道では作れない。自動保存も切り替えも
//   使えず、ログインのある操作はどれも始められない）。
// - 動いているジョブのあるプロファイルは取り消さない。
import { describe, expect, it } from 'vitest';
import {
  UNUSABLE_PROFILE_REASONS,
  startupRetirementReasonOf,
  type UnusableProfileFacts,
} from '../../src/control/unusable-profile.js';

const UNUSABLE: UnusableProfileFacts = Object.freeze({ status: 'ACTIVE', auth: 'AUTOMATED_LOGIN', hasAuthSetup: false, hasActiveJob: false });

describe('MI-F3: which profile is retired automatically when the local UI server starts', () => {
  it('has the closed list of the reasons', () => {
    expect(UNUSABLE_PROFILE_REASONS).toEqual(['AUTOMATED_LOGIN_WITHOUT_AUTH_SETUP']);
    expect(Object.isFrozen(UNUSABLE_PROFILE_REASONS)).toBe(true);
  });

  it('retires an active automated login profile without an auth setup', () => {
    expect(startupRetirementReasonOf(UNUSABLE)).toBe('AUTOMATED_LOGIN_WITHOUT_AUTH_SETUP');
  });

  it.each([
    ['an automated login profile with an auth setup', { hasAuthSetup: true }],
    ['a manual login profile without an auth setup', { auth: 'MANUAL_SESSION' }],
    ['a public profile', { auth: 'NONE' }],
    ['a retired profile', { status: 'RETIRED' }],
    ['a profile with an active job', { hasActiveJob: true }],
  ] as const)('does not retire %s', (_name, overrides: Partial<UnusableProfileFacts>) => {
    expect(startupRetirementReasonOf({ ...UNUSABLE, ...overrides })).toBeNull();
  });
});

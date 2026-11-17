/**
 * OP-1（設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D5、4.1.3 の 2）: サイトの設定（詳しい内容）の「毎回手でログインする」の切り替えと、
 * プロファイルの任意の項目 `loginPreference` の対応（純粋な部品。画面のサーバとブラウザは起動しない）。
 * - 切り替えを入れると `MANUAL_EVERY_TIME` を保存する。外すと項目を送らない（省けば `AUTOMATIC`。項目のない今のプロファイルの digest を変えない）。
 * - 保存してある希望を、切り替えの値に写す。
 */
import { describe, expect, it } from 'vitest';
import { SITE_PROFILE_SCHEMA_VERSION, type SiteProfile } from '../../../src/control/contracts.js';
import { formValuesOf, profileDocumentOf } from '../src/components/ProfileForm';

const PROFILE: SiteProfile = Object.freeze({
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId: 'example-preference',
  revision: 3,
  targetConfigPath: 'local/targets/example-preference.json',
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'AUTOMATED_LOGIN',
  approvedTestOrigins: ['http://127.0.0.1:4173'],
  environmentEvidenceRef: 'isolation-unverified-20261027',
});

describe('OP-1: the toggle "log in by hand every time"', () => {
  it('reads the saved preference into the toggle', () => {
    expect(formValuesOf(PROFILE).manualLoginEveryTime).toBe(false);
    expect(formValuesOf({ ...PROFILE, loginPreference: 'MANUAL_EVERY_TIME' }).manualLoginEveryTime).toBe(true);
  });

  it('saves MANUAL_EVERY_TIME only when the toggle is on, and leaves the item out otherwise', () => {
    expect(profileDocumentOf({ ...formValuesOf(PROFILE), manualLoginEveryTime: true }, 4).loginPreference).toBe('MANUAL_EVERY_TIME');
    expect('loginPreference' in profileDocumentOf(formValuesOf(PROFILE), 4)).toBe(false);
    expect('loginPreference' in profileDocumentOf(formValuesOf({ ...PROFILE, loginPreference: 'MANUAL_EVERY_TIME' }), 4)).toBe(true);
  });

  it('does not save the preference for a public site (no login)', () => {
    const publicValues = { ...formValuesOf(PROFILE), environment: 'PUBLIC', mode: 'PUBLIC_PASSIVE', auth: 'NONE', manualLoginEveryTime: true } as const;
    expect('loginPreference' in profileDocumentOf(publicValues, 4)).toBe(false);
  });
});

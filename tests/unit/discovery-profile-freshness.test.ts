/**
 * PL-U の修正の 1 回目（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 14.1 の U5 と判断）: 操作さがしの結果の古さの判定の 1 か所
 * （`src/control/approval/discovery-profile-freshness.ts`）。
 * - 「書き込みも試す」の切り替えの 1 歩: 書き込みのモードでない改訂から、書き込みのモードの次の改訂へ。違いは改訂の番号・モード・隔離の参照だけ。
 * - 操作さがしの改訂と今の改訂が同じか、その間が切り替えの 1 歩だけだと保存した記録で確かめられたときだけ、今の結果とみなす（分からないときは古い）。
 */
import { describe, expect, it } from 'vitest';
import {
  discoveryProfileRevisionsIn,
  isDiscoveryNeutralStep,
  isDiscoveryProfileRevisionCurrent,
  isWriteModeSwitchStep,
} from '../../src/control/approval/discovery-profile-freshness.js';
import { loadNodeSqlite } from '../../src/control/store/sqlite-module.js';

const PASSIVE = Object.freeze({
  schemaVersion: 'beaksight-profile/1',
  profileId: 'example-switch',
  revision: 1,
  targetConfigPath: 'local/targets/example-switch.json',
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: ['https://example.test'],
  approvedServiceOrigins: ['https://api.example.invalid'],
  environmentEvidenceRef: 'isolation-unverified-20261026',
});
const SWITCHED = Object.freeze({ ...PASSIVE, revision: 2, mode: 'TEST_APPROVED_WRITE', environmentEvidenceRef: 'evidence/isolation-check-1' });

describe('PL-U: one step of the write mode switch', () => {
  it('is the step to the write mode with only the revision, the mode and the isolation reference changed', () => {
    expect(isWriteModeSwitchStep(PASSIVE, SWITCHED)).toBe(true);
    expect(isWriteModeSwitchStep(PASSIVE, { ...SWITCHED, environmentEvidenceRef: PASSIVE.environmentEvidenceRef })).toBe(true);
  });

  it('is not a switch when anything else changed, the mode did not go to the write mode, or the revision skipped', () => {
    for (const changed of [
      { approvedServiceOrigins: ['https://api.example.invalid', 'https://other.example.invalid'] },
      { approvedServiceOrigins: [] },
      { targetConfigPath: 'local/targets/other.json' },
      { approvedTestOrigins: ['https://other.example.test'] },
      { auth: 'AUTOMATED_LOGIN' },
      { environment: 'PUBLIC' },
      { revision: 3 },
      { extra: true },
    ]) {
      expect(isWriteModeSwitchStep(PASSIVE, { ...SWITCHED, ...changed }), JSON.stringify(changed)).toBe(false);
    }
    const withoutServiceOrigins: Record<string, unknown> = { ...SWITCHED };
    delete withoutServiceOrigins['approvedServiceOrigins'];
    expect(isWriteModeSwitchStep(PASSIVE, withoutServiceOrigins)).toBe(false);
    // 書き込みのモードの中の編集（隔離の参照だけでも）と、書き込みのモードから戻す変更は、切り替えではない。
    expect(isWriteModeSwitchStep(SWITCHED, { ...SWITCHED, revision: 3, environmentEvidenceRef: 'evidence/isolation-check-2' })).toBe(false);
    expect(isWriteModeSwitchStep(SWITCHED, { ...PASSIVE, revision: 3 })).toBe(false);
    expect(isWriteModeSwitchStep(PASSIVE, { ...PASSIVE, revision: 2 })).toBe(false);
    expect(isWriteModeSwitchStep(null, SWITCHED)).toBe(false);
  });
});

describe('PL-U: whether the discovery result is of the current revision', () => {
  it('is current for the same revision, or for a switch only confirmed by the saved records, and stale otherwise', () => {
    expect(isDiscoveryProfileRevisionCurrent({ discoveryJob: 2, current: 2, switchOnlySinceDiscovery: false })).toBe(true);
    expect(isDiscoveryProfileRevisionCurrent({ discoveryJob: 1, current: 2, switchOnlySinceDiscovery: true })).toBe(true);
    expect(isDiscoveryProfileRevisionCurrent({ discoveryJob: 1, current: 2, switchOnlySinceDiscovery: false })).toBe(false);
    expect(isDiscoveryProfileRevisionCurrent({ discoveryJob: null, current: 2, switchOnlySinceDiscovery: true })).toBe(false);
    expect(isDiscoveryProfileRevisionCurrent({ discoveryJob: 3, current: 2, switchOnlySinceDiscovery: true })).toBe(false);
    expect(isDiscoveryProfileRevisionCurrent(undefined)).toBe(false);
  });
});

describe('OP-2: one step that only changes the login preference (OP-1 carry-over)', () => {
  it('is a discovery-neutral step when only the revision and the login preference changed', () => {
    const manual = { ...PASSIVE, revision: 2, loginPreference: 'MANUAL_EVERY_TIME' };
    expect(isDiscoveryNeutralStep(PASSIVE, manual)).toBe(true);
    expect(isDiscoveryNeutralStep(manual, { ...manual, revision: 3, loginPreference: 'AUTOMATIC' })).toBe(true);
    // 改訂の番号だけが進んだ保存は、今どおり中身の変わらない 1 歩とみなさない。
    expect(isDiscoveryNeutralStep(PASSIVE, { ...PASSIVE, revision: 2 })).toBe(false);
    // 書き込みのモードの切り替えも、同じ判定に入る。
    expect(isDiscoveryNeutralStep(PASSIVE, SWITCHED)).toBe(true);
  });

  it('is not neutral when the approved services, the auth, or anything else changed with the login preference', () => {
    for (const changed of [
      { approvedServiceOrigins: ['https://api.example.invalid', 'https://other.example.invalid'] },
      { auth: 'AUTOMATED_LOGIN' },
      { approvedTestOrigins: ['https://other.example.test'] },
      { mode: 'TEST_APPROVED_WRITE', loginPreference: 'MANUAL_EVERY_TIME', environmentEvidenceRef: 'x' },
      { revision: 3 },
    ]) {
      expect(isDiscoveryNeutralStep(PASSIVE, { ...PASSIVE, revision: 2, loginPreference: 'MANUAL_EVERY_TIME', ...changed }), JSON.stringify(changed)).toBe(false);
    }
  });

  it('treats a discovery as current across saved login-preference steps only (database records)', () => {
    const sqlite = loadNodeSqlite();
    if (sqlite === undefined) throw new Error('node:sqlite is not available');
    const connection = new sqlite.DatabaseSync(':memory:');
    try {
      connection.exec('CREATE TABLE profile_revisions (profile_id TEXT, revision INTEGER, document TEXT)');
      const insert = connection.prepare('INSERT INTO profile_revisions (profile_id, revision, document) VALUES (?, ?, ?)');
      const second = { ...PASSIVE, revision: 2, loginPreference: 'MANUAL_EVERY_TIME' };
      const third = { ...second, revision: 3, mode: 'TEST_APPROVED_WRITE' };
      insert.run(PASSIVE.profileId, 1, JSON.stringify(PASSIVE));
      insert.run(PASSIVE.profileId, 2, JSON.stringify(second));
      insert.run(PASSIVE.profileId, 3, JSON.stringify(third));
      expect(isDiscoveryProfileRevisionCurrent(discoveryProfileRevisionsIn(connection, PASSIVE.profileId, 1, 3))).toBe(true);
      const changedService = { ...third, revision: 4, approvedServiceOrigins: [] };
      insert.run(PASSIVE.profileId, 4, JSON.stringify(changedService));
      expect(isDiscoveryProfileRevisionCurrent(discoveryProfileRevisionsIn(connection, PASSIVE.profileId, 1, 4))).toBe(false);
    } finally {
      connection.close();
    }
  });
});

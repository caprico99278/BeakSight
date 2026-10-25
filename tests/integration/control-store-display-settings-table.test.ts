// 管理データのプロファイルの表示の設定の表（`profile_display_settings`）の結合テスト（FM-2・AS-b。設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md`
// 2.2、`2026-10-19-beaksight-audit-send-policy-design.md` 2.1）。LG-2 で、版ごとのテスト（`control-store-v15`・`v17`）の今の形の確かめと、今の版の
// 管理データでの部品の振る舞いをまとめた（前の版からの上げと前の版の文の固定は捨てた。CHECK の値の一覧が名前つきの一覧と等しいことは
// `control-store-base-schema.test.ts`）。
// - 承認に結ばれるプロファイルの文書と改訂とは別に持ち、切り替えてもプロファイルの改訂を変えない。行がなければ既定（ジョブのブラウザを表示する・
//   監査の段は読み取りだけ）。
// - 監査の段の送信の扱いの列（`audit_send_policy`）は、`AUDIT_SEND_POLICIES` の値だけ。保存の口は、扱いを渡さなければ今の値を変えない。
// 一時のフォルダだけを使い、終わったら消す。
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import {
  createProfile,
  DEFAULT_PROFILE_DISPLAY_SETTINGS,
  getProfile,
  readProfileDisplaySettings,
  saveProfileDisplaySettings,
} from '../../src/control/store/profile-store.js';
import { insertRow, useControlStoreWorkspace } from '../helpers/control-store-schema.js';
import { publicProfile, resolveTestContext } from './control-profile-fixtures.js';

const PROFILE_ID = 'example-display-settings';
const CREATED_AT = '20261019000000';
/** テストの接続は busy を待たない。 */
const RAW_TIMEOUT_MS = 0;

const workspace = useControlStoreWorkspace('beaksight-control-display-settings-');

/** 今の版の管理データを開き、`use` に渡す（終わったら閉じる）。 */
const withDatabase = (use: (database: ControlDatabase) => void): void => {
  const database = openControlDatabase(workspace.databasePath());
  try {
    use(database);
  } finally {
    closeControlDatabase(database);
  }
};

describe('Control store: the display settings of a profile', () => {
  it('reads the default (show the job browser) without a row, saves and reads it, and does not change the profile revision', () => {
    withDatabase((database) => {
      expect(createProfile(database, publicProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
      const readOnly = { auditSendPolicy: 'READ_ONLY' } as const;
      expect(readProfileDisplaySettings(database, PROFILE_ID)).toEqual({ showJobBrowser: true, ...readOnly });
      expect(saveProfileDisplaySettings(database, PROFILE_ID, { showJobBrowser: false })).toEqual({ ok: true, settings: { showJobBrowser: false, ...readOnly } });
      expect(readProfileDisplaySettings(database, PROFILE_ID)).toEqual({ showJobBrowser: false, ...readOnly });
      expect(saveProfileDisplaySettings(database, PROFILE_ID, { showJobBrowser: true })).toEqual({ ok: true, settings: { showJobBrowser: true, ...readOnly } });
      expect(readProfileDisplaySettings(database, PROFILE_ID)).toEqual({ showJobBrowser: true, ...readOnly });
      const stored = getProfile(database, PROFILE_ID);
      expect(stored?.profile.revision).toBe(MIN_PROFILE_REVISION);
      const revisions = new DatabaseSync(workspace.databasePath(), { timeout: RAW_TIMEOUT_MS, readOnly: true });
      try {
        expect(revisions.prepare('SELECT COUNT(*) AS count FROM profile_revisions WHERE profile_id = ?').get(PROFILE_ID)).toEqual({ count: 1 });
      } finally {
        revisions.close();
      }
    });
  });

  it('rejects an unknown profile and a value that is not a boolean, without writing', () => {
    withDatabase((database) => {
      expect(saveProfileDisplaySettings(database, 'no-such-profile', { showJobBrowser: false })).toEqual({ ok: false, reason: 'PROFILE_NOT_FOUND' });
      expect(createProfile(database, publicProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
      expect(saveProfileDisplaySettings(database, PROFILE_ID, { showJobBrowser: 'no' as unknown as boolean })).toEqual({ ok: false, reason: 'SETTINGS_INVALID' });
      expect(readProfileDisplaySettings(database, PROFILE_ID)).toEqual({ showJobBrowser: true, auditSendPolicy: 'READ_ONLY' });
    });
  });
});

describe('Control store: the audit send policy of a profile', () => {
  it('rejects a value outside the list in the column, and keeps READ_ONLY as the default of a row written without it', () => {
    const raw = workspace.latestConnection([PROFILE_ID]);
    expect(() => insertRow(raw, 'profile_display_settings', { profile_id: PROFILE_ID, show_job_browser: 1, audit_send_policy: 'PASS_ALL', updated_at: CREATED_AT }))
      .toThrow();
    insertRow(raw, 'profile_display_settings', { profile_id: PROFILE_ID, show_job_browser: 0, updated_at: CREATED_AT });
    expect(raw.prepare('SELECT audit_send_policy FROM profile_display_settings').get()).toEqual({ audit_send_policy: 'READ_ONLY' });
    raw.prepare('UPDATE profile_display_settings SET audit_send_policy = ? WHERE profile_id = ?').run('PASS_EXCEPT_DELETE', PROFILE_ID);
    raw.close();
    withDatabase((database) => {
      expect(readProfileDisplaySettings(database, PROFILE_ID)).toEqual({ showJobBrowser: false, auditSendPolicy: 'PASS_EXCEPT_DELETE' });
    });
  });

  it('reads READ_ONLY without a row, saves and reads it back, keeps it when only the display is saved, and rejects another value', () => {
    workspace.latestConnection([PROFILE_ID]).close();
    withDatabase((database) => {
      expect(DEFAULT_PROFILE_DISPLAY_SETTINGS).toEqual({ showJobBrowser: true, auditSendPolicy: 'READ_ONLY' });
      expect(readProfileDisplaySettings(database, PROFILE_ID)).toEqual({ showJobBrowser: true, auditSendPolicy: 'READ_ONLY' });
      // 表示だけを保存した行も、扱いは読み取りだけ。
      expect(saveProfileDisplaySettings(database, PROFILE_ID, { showJobBrowser: false }))
        .toEqual({ ok: true, settings: { showJobBrowser: false, auditSendPolicy: 'READ_ONLY' } });
      expect(saveProfileDisplaySettings(database, PROFILE_ID, { showJobBrowser: false, auditSendPolicy: 'PASS_EXCEPT_DELETE' }))
        .toEqual({ ok: true, settings: { showJobBrowser: false, auditSendPolicy: 'PASS_EXCEPT_DELETE' } });
      expect(readProfileDisplaySettings(database, PROFILE_ID)).toEqual({ showJobBrowser: false, auditSendPolicy: 'PASS_EXCEPT_DELETE' });
      // 表示だけを切り替える呼び出し（テストの補助の `hideJobBrowser` など）は、扱いを変えない。
      expect(saveProfileDisplaySettings(database, PROFILE_ID, { showJobBrowser: true }))
        .toEqual({ ok: true, settings: { showJobBrowser: true, auditSendPolicy: 'PASS_EXCEPT_DELETE' } });
      expect(saveProfileDisplaySettings(database, PROFILE_ID, { showJobBrowser: true, auditSendPolicy: 'READ_ONLY' }))
        .toEqual({ ok: true, settings: { showJobBrowser: true, auditSendPolicy: 'READ_ONLY' } });
      for (const auditSendPolicy of ['PASS_ALL', '', null, 1]) {
        expect(saveProfileDisplaySettings(database, PROFILE_ID, { showJobBrowser: true, auditSendPolicy: auditSendPolicy as never }), String(auditSendPolicy))
          .toEqual({ ok: false, reason: 'SETTINGS_INVALID' });
      }
      expect(readProfileDisplaySettings(database, PROFILE_ID)).toEqual({ showJobBrowser: true, auditSendPolicy: 'READ_ONLY' });
      expect(saveProfileDisplaySettings(database, 'no-such-profile', { showJobBrowser: true, auditSendPolicy: 'PASS_EXCEPT_DELETE' }))
        .toEqual({ ok: false, reason: 'PROFILE_NOT_FOUND' });
      // プロファイルの改訂は変えない（承認に結ばれる改訂の外の設定）。
      expect(getProfile(database, PROFILE_ID)?.profile.revision).toBe(MIN_PROFILE_REVISION);
    });
  });
});

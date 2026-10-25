// 管理データの準備と保存の、利用者への文言（`src/presentation/messages.ts`）の網羅の確かめ（Task 23 の設計書 4.3、4.6。T23d）。
// - 止める理由（環境 2 個、管理データ 12 個。LG-2 で前の版の理由を足した）と、プロファイルの保存の拒否の理由（9 個）の、すべての値に説明と取るべき手順があり、余分がない。
// - ファイルにかかわる理由の手順は、BeakSight がファイルを消さない・上書きしないことを伝える。
// - 手順書（`doc/spec/local-setup.md`）の困ったときの表に、止める理由のすべての、表示される文と取るべき手順が載っている。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTROL_ENVIRONMENT_FAILURE_REASONS } from '../../src/control/environment/control-environment.js';
import { CONTROL_SCHEMA_BASE } from '../../src/control/store/migrations.js';
import { PROFILE_STORE_REJECTION_REASONS } from '../../src/control/store/profile-store.js';
import { CONTROL_STORE_FAILURE_REASONS } from '../../src/control/store/store-errors.js';
import {
  CONTROL_ENVIRONMENT_FAILURE_DESCRIPTIONS,
  CONTROL_STORE_FAILURE_DESCRIPTIONS,
  PROFILE_STORE_REJECTION_DESCRIPTIONS,
  SETUP_LOCAL_TEXT,
} from '../../src/presentation/messages.js';

const LOCAL_SETUP_DOCUMENT = readFileSync(new URL('../../doc/spec/local-setup.md', import.meta.url), 'utf8');

/** 利用者のファイルがある場所で止める理由（手順に「消さない・上書きしない」を書く）。 */
const FILE_PRESERVING_REASONS = Object.freeze([
  'DATA_DIRECTORY_NOT_DIRECTORY',
  'NOT_A_SQLITE_FILE',
  'NOT_A_BEAKSIGHT_DATABASE',
  'DATABASE_FROM_NEWER_VERSION',
  'DATABASE_FROM_OLDER_VERSION',
  'DATABASE_INTEGRITY_FAILED',
] as const);

const sortedKeys = (value: object): readonly string[] => Object.keys(value).sort();

describe('control setup messages (design 4.3, 4.6)', () => {
  it('describes every environment failure reason, and nothing else', () => {
    expect(sortedKeys(CONTROL_ENVIRONMENT_FAILURE_DESCRIPTIONS)).toEqual([...CONTROL_ENVIRONMENT_FAILURE_REASONS].sort());
  });

  it('describes every control store failure reason (including the environment reasons), and nothing else', () => {
    expect(sortedKeys(CONTROL_STORE_FAILURE_DESCRIPTIONS)).toEqual([...CONTROL_STORE_FAILURE_REASONS].sort());
    for (const reason of CONTROL_ENVIRONMENT_FAILURE_REASONS) {
      expect(CONTROL_STORE_FAILURE_DESCRIPTIONS[reason]).toEqual(CONTROL_ENVIRONMENT_FAILURE_DESCRIPTIONS[reason]);
    }
  });

  it('describes every profile store rejection reason, and nothing else', () => {
    expect(sortedKeys(PROFILE_STORE_REJECTION_DESCRIPTIONS)).toEqual([...PROFILE_STORE_REJECTION_REASONS].sort());
  });

  it('gives every reason a sentence and an action', () => {
    for (const [reason, text] of [
      ...Object.entries(CONTROL_STORE_FAILURE_DESCRIPTIONS),
      ...Object.entries(PROFILE_STORE_REJECTION_DESCRIPTIONS),
    ]) {
      expect(text.description, reason).toMatch(/。$/u);
      expect(text.action, reason).toMatch(/。$/u);
      expect(text.description, reason).not.toMatch(/\|/u);
      expect(text.action, reason).not.toMatch(/\|/u);
    }
  });

  it('tells the user that BeakSight neither deletes nor overwrites the file, where a user file is in the way', () => {
    for (const reason of FILE_PRESERVING_REASONS) {
      expect(CONTROL_STORE_FAILURE_DESCRIPTIONS[reason].action, reason).toContain(SETUP_LOCAL_TEXT.filesKept);
    }
  });

  it('covers the design 4.6 examples: an old Node, the SQLite feature, renaming or moving the file, a newer version, another program', () => {
    expect(CONTROL_STORE_FAILURE_DESCRIPTIONS.NODE_VERSION_UNSUPPORTED.action).toContain('Node.js 24');
    expect(CONTROL_STORE_FAILURE_DESCRIPTIONS.NODE_SQLITE_UNAVAILABLE.action).toContain('別に入れるものはありません');
    expect(CONTROL_STORE_FAILURE_DESCRIPTIONS.NOT_A_SQLITE_FILE.action).toContain('別の名前に変えるか');
    expect(CONTROL_STORE_FAILURE_DESCRIPTIONS.NOT_A_BEAKSIGHT_DATABASE.action).toContain('別の名前に変えるか');
    expect(CONTROL_STORE_FAILURE_DESCRIPTIONS.DATABASE_FROM_NEWER_VERSION.action).toContain('新しい版の BeakSight');
    expect(CONTROL_STORE_FAILURE_DESCRIPTIONS.DATABASE_LOCKED.action).toContain('閉じて');
  });

  // LG-2: 基準の版より前の版の管理データは開かない。文の版の数は、基準の版と同じ（文言は `src/control/` を import しないため、ここで比べる）。
  it('tells that a control database before the base version cannot be opened, and how to start a new one', () => {
    const text = CONTROL_STORE_FAILURE_DESCRIPTIONS.DATABASE_FROM_OLDER_VERSION;
    expect(text.description).toContain(`版 ${CONTROL_SCHEMA_BASE.version} より前`);
    expect(text.action).toContain('別の名前に変えるか');
    expect(text.action).toContain(SETUP_LOCAL_TEXT.filesKept);
  });

  it('the troubleshooting table of doc/spec/local-setup.md lists every stop reason with the displayed sentence and the action', () => {
    for (const reason of CONTROL_STORE_FAILURE_REASONS) {
      const row = LOCAL_SETUP_DOCUMENT.split(/\r?\n/u).find((line) => line.startsWith(`| \`${reason}\` |`));
      expect(row, reason).toBeDefined();
      expect(row, reason).toContain(CONTROL_STORE_FAILURE_DESCRIPTIONS[reason].description);
      expect(row, reason).toContain(CONTROL_STORE_FAILURE_DESCRIPTIONS[reason].action);
    }
  });
});

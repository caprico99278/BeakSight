// ローカルの管理画面の表示の語と文言の網羅（Task 23 の設計書 4.7。T23f）。
// - 表示カタログ（`src/presentation/catalog.ts`）が、`src/control/` の値の一覧（監査モード、環境、認証の方式、プロファイルの状態）の
//   すべてを余分なく持ち、ラベルが空でなく、色のトーンが閉じた一覧の値であること（GATE-UI05 と同じ確かめを、control の一覧に対して行う）。
// - 文言（`src/presentation/messages.ts`）が、Task 22 の検証の誤りのコードのすべてに説明を持つこと。
// - 拒否の応答の本文（T23e から移した）が、守りの部品の 3 つの拒否のすべてにあること。
// 型の確かめは `apps/local-ui/src/display/catalog-coverage.ts` にもある（`src/presentation/` は `src/control/` を import しないため）。
import { describe, expect, it } from 'vitest';
import { AUDIT_MODES, AUTH_STRATEGIES, ENVIRONMENT_KINDS, PROFILE_VALIDATION_ERROR_CODES } from '../../src/control/contracts.js';
import { PROFILE_STATUSES } from '../../src/control/store/profile-records.js';
import {
  AUDIT_MODE_CATALOG,
  AUTH_STRATEGY_CATALOG,
  DISPLAY_TONES,
  ENVIRONMENT_KIND_CATALOG,
  PROFILE_STATUS_CATALOG,
} from '../../src/presentation/catalog.js';
import { LOCAL_UI_GUARD_REJECTION_TEXT, PROFILE_VALIDATION_ERROR_DESCRIPTIONS } from '../../src/presentation/messages.js';

describe('local UI display catalogs (design 4.7)', () => {
  it.each([
    ['AUDIT_MODES', AUDIT_MODES, AUDIT_MODE_CATALOG],
    ['ENVIRONMENT_KINDS', ENVIRONMENT_KINDS, ENVIRONMENT_KIND_CATALOG],
    ['AUTH_STRATEGIES', AUTH_STRATEGIES, AUTH_STRATEGY_CATALOG],
    ['PROFILE_STATUSES', PROFILE_STATUSES, PROFILE_STATUS_CATALOG],
  ] as const)('the catalog for %s has every value, a label and a tone', (_name, values, catalog) => {
    const entries: Readonly<Record<string, { readonly label: string; readonly tone: string; readonly order: number }>> = catalog;
    expect(Object.keys(entries).sort()).toEqual([...values].sort());
    const orders = values.map((value) => entries[value]?.order);
    expect(new Set(orders).size).toBe(values.length);
    for (const value of values) {
      expect(entries[value]?.label.trim(), value).not.toBe('');
      expect(DISPLAY_TONES, value).toContain(entries[value]?.tone);
    }
  });

  it('describes every Task 22 validation error code, and nothing else', () => {
    expect(Object.keys(PROFILE_VALIDATION_ERROR_DESCRIPTIONS).sort()).toEqual([...PROFILE_VALIDATION_ERROR_CODES].sort());
    for (const text of Object.values(PROFILE_VALIDATION_ERROR_DESCRIPTIONS)) {
      expect(text).toMatch(/。$/u);
    }
  });

  it('has the guard rejection texts for 400, 401 and 421', () => {
    expect(Object.keys(LOCAL_UI_GUARD_REJECTION_TEXT).sort()).toEqual(['BAD_REQUEST', 'MISDIRECTED_REQUEST', 'UNAUTHORIZED']);
    for (const text of Object.values(LOCAL_UI_GUARD_REJECTION_TEXT)) {
      expect(text).not.toMatch(/token=/u);
    }
  });
});

/**
 * 認証つきの監査の画面の表示カタログと文言の網羅（Task 25 の設計書 4.5。T25e）。型の確かめ（`src/display/catalog-coverage.ts`）に加えて、
 * 実行時の値（ラベルが空でない、色のトーンが閉じた一覧の値、順が重ならない、説明が文で終わる）を確かめる。
 * 子の process もブラウザも使わない。
 */
import { describe, expect, it } from 'vitest';
import { AUTH_SETUP_VALIDATION_ERROR_CODES } from '../../../src/control/auth/auth-setup-contracts.js';
import { AUDIT_JOB_START_REJECTION_REASONS } from '../../../src/control/job/job-records.js';
import { AUTH_SETUP_FRESHNESS_VALUES, AUTH_SETUP_STORE_REJECTION_REASONS } from '../../../src/control/store/auth-setup-store.js';
import { WORKER_AUTH_STATES } from '../../../src/control/worker-protocol.js';
import { AUDIT_JOB_AUTH_STATE_CATALOG, AUTH_SETUP_FRESHNESS_CATALOG, DISPLAY_TONES } from '../../../src/presentation/catalog.js';
import {
  AUDIT_JOB_START_REJECTION_DESCRIPTIONS,
  AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS,
  AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_TEXT,
} from '../../../src/presentation/messages.js';

/** 文の終わり。 */
const SENTENCE_END = /。$/u;

describe('T25e: the display catalogs and texts of the authenticated audit', () => {
  it.each([
    ['AUTH_SETUP_FRESHNESS_VALUES', AUTH_SETUP_FRESHNESS_VALUES, AUTH_SETUP_FRESHNESS_CATALOG],
    ['WORKER_AUTH_STATES', WORKER_AUTH_STATES, AUDIT_JOB_AUTH_STATE_CATALOG],
  ] as const)('the catalog for %s has every value, a label, a tone and a distinct order', (_name, values, catalog) => {
    const entries: Readonly<Record<string, { readonly label: string; readonly tone: string; readonly order: number }>> = catalog;
    expect(Object.keys(entries).sort()).toEqual([...values].sort());
    expect(new Set(values.map((value) => entries[value]?.order)).size).toBe(values.length);
    for (const value of values) {
      expect(entries[value]?.label.trim(), value).not.toBe('');
      expect(DISPLAY_TONES, value).toContain(entries[value]?.tone);
    }
  });

  it('describes every auth setup validation error code and every store rejection reason, and nothing else', () => {
    expect(Object.keys(AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS).sort()).toEqual([...AUTH_SETUP_VALIDATION_ERROR_CODES].sort());
    for (const text of Object.values(AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS)) {
      expect(text).toMatch(SENTENCE_END);
    }
    expect(Object.keys(AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS).sort()).toEqual([...AUTH_SETUP_STORE_REJECTION_REASONS].sort());
    for (const { description, action } of Object.values(AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS)) {
      expect(description).toMatch(SENTENCE_END);
      expect(action).toMatch(SENTENCE_END);
    }
    expect(Object.keys(AUDIT_JOB_START_REJECTION_DESCRIPTIONS).sort()).toEqual([...AUDIT_JOB_START_REJECTION_REASONS].sort());
  });

  it('says that only the approved write audit is not executable yet (the authenticated read audit is executable now)', () => {
    const { description, action } = AUDIT_JOB_START_REJECTION_DESCRIPTIONS.MODE_NOT_EXECUTABLE;
    expect(description).toContain('承認した書き込みの監査');
    expect(description).not.toContain('ログイン');
    // T25e round 1: 手順は、今実行できる 2 つのモード（公開の監査、認証つきの読み取りの監査）を案内する。
    expect(action).toContain('公開の監査');
    expect(action).toContain('認証つきの読み取りの監査');
    // T25e round 1: プロファイルのフォームの「今は実行できない」案内は、承認した書き込みの監査だけを言う（ログインは今使える）。
    expect(LOCAL_UI_TEXT.profileForm.testModeNotice).toContain('承認した書き込みの監査');
    expect(LOCAL_UI_TEXT.profileForm.testModeNotice).not.toContain('ログイン');
  });

  it('guides the login on the start screen with the agreed sentence', () => {
    expect(LOCAL_UI_AUTH_TEXT.start.guidance).toBe('BeakSight が開くブラウザでログインしてください。ログインが済むと自動で監査が始まります。');
  });
});

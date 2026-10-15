// T24e（Task 24 の設計書 4.4 の開始の 1、5 章）: 今実行できる監査モードの owner（`src/control/execution-policy.ts`）。
// T25d（Task 25 の設計書 4.4、4.5）: 認証つきの読み取りの監査（`TEST_AUTH_PASSIVE`）を、手動のログイン（`MANUAL_SESSION`）のときだけ足した。
// 書き込みの監査（`TEST_APPROVED_WRITE`）は、引き続き実行できない。T26d-2: 自動ログイン（`AUTOMATED_LOGIN`）を、方式として実行できるものに足した
// （プラットフォームを問わない。Windows だけであることは、ジョブの管理の開始の確かめで強制する。`execution-policy-automated-login.test.ts`）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_MODES, AUTH_STRATEGIES, type AuditMode, type AuthStrategy } from '../../src/control/contracts.js';
import {
  AUTH_SETUP_REQUIRED_AUDIT_MODES,
  EXECUTABLE_AUDIT_MODES,
  PROFILE_OPERATION_POLICY,
  PROFILE_OPERATIONS,
  isExecutableAuditMode,
  isExecutableAuthStrategy,
  isProfileOperationAllowed,
  operationRequiresAuthSetup,
  profileOperationRejectionOf,
  requiresAuthSetup,
  type ProfileOperation,
  type ProfileOperationRejection,
} from '../../src/control/execution-policy.js';
import { WORKER_JOB_KINDS } from '../../src/control/worker-protocol.js';
import { scanSource } from '../architecture/source-scan.js';

describe('executable audit modes', () => {
  it('lists the public passive audit and the authenticated passive audit, as a frozen subset of the audit modes', () => {
    expect(EXECUTABLE_AUDIT_MODES).toEqual(['PUBLIC_PASSIVE', 'TEST_AUTH_PASSIVE']);
    expect(Object.isFrozen(EXECUTABLE_AUDIT_MODES)).toBe(true);
    expect(EXECUTABLE_AUDIT_MODES.every((mode) => AUDIT_MODES.includes(mode))).toBe(true);
  });

  it('accepts only the listed modes, and rejects the write mode and values that are not modes', () => {
    expect(AUDIT_MODES.filter(isExecutableAuditMode)).toEqual(['PUBLIC_PASSIVE', 'TEST_AUTH_PASSIVE']);
    for (const value of ['TEST_APPROVED_WRITE', 'public_passive', '', null, undefined, 1, ['PUBLIC_PASSIVE']]) {
      expect(isExecutableAuditMode(value), String(value)).toBe(false);
    }
  });

  it('accepts only NONE for the public audit and MANUAL_SESSION and AUTOMATED_LOGIN (T26d-2) for the authenticated audit (T25d)', () => {
    const accepted = AUDIT_MODES.flatMap((mode) =>
      AUTH_STRATEGIES.filter((auth) => isExecutableAuthStrategy(mode, auth)).map((auth) => `${mode}/${auth}`));
    expect(accepted).toEqual(['PUBLIC_PASSIVE/NONE', 'TEST_AUTH_PASSIVE/MANUAL_SESSION', 'TEST_AUTH_PASSIVE/AUTOMATED_LOGIN']);
    for (const [mode, auth] of [['TEST_AUTH_PASSIVE', 'manual_session'], ['TEST_AUTH_PASSIVE', null], [null, 'NONE'], ['constructor', 'NONE']]) {
      expect(isExecutableAuthStrategy(mode, auth), `${String(mode)}/${String(auth)}`).toBe(false);
    }
  });

  // T28b（Task 28 の設計書 2 章のユーザーの判断 1、4.5）: 書き込みのモード（`TEST_APPROVED_WRITE`）のプロファイルも、認証の設定を使う（発見・READ の
  // 確かめ・ログインの確かめの前に、有効な認証の設定が要る）。公開の監査は、引き続き認証の設定を使わない。
  it('requires an auth setup for the authenticated audit (T25d) and the write mode (T28b), not for the public audit', () => {
    expect(AUTH_SETUP_REQUIRED_AUDIT_MODES).toEqual(['TEST_AUTH_PASSIVE', 'TEST_APPROVED_WRITE']);
    expect(Object.isFrozen(AUTH_SETUP_REQUIRED_AUDIT_MODES)).toBe(true);
    expect(AUDIT_MODES.filter(requiresAuthSetup)).toEqual(['TEST_AUTH_PASSIVE', 'TEST_APPROVED_WRITE']);
    for (const value of [undefined, null, '', 'constructor', 'test_auth_passive', ['TEST_AUTH_PASSIVE']]) {
      expect(requiresAuthSetup(value), String(value)).toBe(false);
    }
  });
});

// T28b（Task 28 の設計書 2 章のユーザーの判断 1、3 章の「モードの拡張」、4.5、10 章の 5）: どのモードで何を許すかの唯一の判定
// （`profileOperationRejectionOf`。閉じた一覧 `PROFILE_OPERATION_POLICY`）。ジョブの管理・認証の設定・画面の出し分けが、すべてこれを使う。
// 組み合わせは、プロファイルとして保存できるモードと認証の方式の組（`validateSiteProfile` の表）の全部を並べる。
describe('profile operations by mode (T28b)', () => {
  const PROFILE_KINDS = [
    ['PUBLIC_PASSIVE', 'NONE'],
    ['TEST_AUTH_PASSIVE', 'MANUAL_SESSION'],
    ['TEST_AUTH_PASSIVE', 'AUTOMATED_LOGIN'],
    ['TEST_APPROVED_WRITE', 'MANUAL_SESSION'],
    ['TEST_APPROVED_WRITE', 'AUTOMATED_LOGIN'],
  ] as const satisfies readonly (readonly [AuditMode, AuthStrategy])[];
  const ALLOWED = null;
  const MODE = 'MODE_NOT_EXECUTABLE';
  const AUTH = 'AUTH_STRATEGY_NOT_EXECUTABLE';
  /** 操作ごとの、`PROFILE_KINDS` の順の判定（`null` は許す）。今までの公開監査と認証つきの読み取りの監査の理由は変えない。 */
  const EXPECTED: Readonly<Record<ProfileOperation, readonly (ProfileOperationRejection | null)[]>> = {
    // 認証つきの監査は、書き込みのモードでは今までどおり始められない（ユーザーの判断の範囲の外）。
    AUDIT: [ALLOWED, ALLOWED, ALLOWED, MODE, MODE],
    // ログインの確かめは、自動ログインのプロファイルだけ（公開の監査と手動のログインは、今までどおり方式の理由）。
    LOGIN_CHECK: [AUTH, AUTH, ALLOWED, AUTH, ALLOWED],
    DISCOVERY: [MODE, ALLOWED, ALLOWED, ALLOWED, ALLOWED],
    READ_CHECK: [MODE, ALLOWED, ALLOWED, ALLOWED, ALLOWED],
    AUTH_SETUP: [MODE, ALLOWED, ALLOWED, ALLOWED, ALLOWED],
    CREDENTIAL: [MODE, AUTH, ALLOWED, AUTH, ALLOWED],
    // T28e fix round 1（Task 28 の設計書 4.6）: 書き込みのシナリオ（作成・変更・承認）は、書き込みのモードだけ（手動のログインと自動ログインの
    // 両方）。シナリオは発見の候補から作るので、発見と同じ方式を許す。画面の出し分けとシナリオの保存の部品が、この行を使う（判定を 1 か所に）。
    SCENARIO: [MODE, MODE, MODE, ALLOWED, ALLOWED],
    // T30e（Task 30 の設計書 3 章）: 承認された CREATE の書き込みのジョブは、書き込みのモードの、ログインを使うプロファイルだけ（手動のログインと
    // 自動ログインの両方。ほかのモードは、モードの理由で拒む）。
    WRITE_CREATE: [MODE, MODE, MODE, ALLOWED, ALLOWED],
    // T31e fix round 1（Task 31 の設計書 3 章）: 承認された UPDATE の書き込みのジョブも、CREATE と同じ（書き込みのモードの、ログインを使う方式だけ）。
    WRITE_UPDATE: [MODE, MODE, MODE, ALLOWED, ALLOWED],
  };

  it('decides every operation for every storable pair of the mode and the auth strategy with the closed table', () => {
    expect([...PROFILE_OPERATIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const operation of PROFILE_OPERATIONS) {
      expect(PROFILE_KINDS.map(([mode, auth]) => profileOperationRejectionOf(operation, mode, auth)), operation).toEqual(EXPECTED[operation]);
      expect(PROFILE_KINDS.map(([mode, auth]) => isProfileOperationAllowed(operation, mode, auth)), operation)
        .toEqual(EXPECTED[operation].map((rejection) => rejection === null));
    }
  });

  it('lists the modes of each operation in the frozen table, and the job kinds are operations of the table', () => {
    expect(Object.isFrozen(PROFILE_OPERATIONS)).toBe(true);
    expect(Object.isFrozen(PROFILE_OPERATION_POLICY)).toBe(true);
    for (const operation of PROFILE_OPERATIONS) {
      expect(Object.isFrozen(PROFILE_OPERATION_POLICY[operation]), operation).toBe(true);
    }
    // T30e: 書き込みのジョブ `WRITE_CREATE` にも操作の行を足した（T30d では行がなく、どのモードでも拒んでいた）。ジョブの種類は、すべて操作の行がある。
    expect(WORKER_JOB_KINDS.filter((kind) => !(PROFILE_OPERATIONS as readonly string[]).includes(kind))).toEqual([]);
    // 書き込みのモードで許すのは、認証の設定・資格情報・ログインの確かめ・発見・READ の確かめ（10 章の 5）と、書き込みのシナリオ（T28e fix round 1。
    // シナリオは書き込みのモードの機能そのもので、書き込みは実行しない）と、承認された CREATE の書き込み（T30e）と、承認された UPDATE の書き込み
    // （T31e fix round 1）だけ。
    expect(PROFILE_OPERATIONS.filter((operation) => Object.hasOwn(PROFILE_OPERATION_POLICY[operation], 'TEST_APPROVED_WRITE')))
      .toEqual(['LOGIN_CHECK', 'DISCOVERY', 'READ_CHECK', 'AUTH_SETUP', 'CREDENTIAL', 'SCENARIO', 'WRITE_CREATE', 'WRITE_UPDATE']);
    // シナリオと書き込みを許すのは、書き込みのモードだけ。書き込みは、ログインを使う方式だけ（公開の方式 `NONE` は、方式の理由で拒む）。
    expect(Object.keys(PROFILE_OPERATION_POLICY.SCENARIO)).toEqual(['TEST_APPROVED_WRITE']);
    for (const write of ['WRITE_CREATE', 'WRITE_UPDATE'] as const) {
      expect(Object.keys(PROFILE_OPERATION_POLICY[write]), write).toEqual(['TEST_APPROVED_WRITE']);
      expect(profileOperationRejectionOf(write, 'TEST_APPROVED_WRITE', 'NONE'), write).toBe('AUTH_STRATEGY_NOT_EXECUTABLE');
      expect(isProfileOperationAllowed(write, 'TEST_APPROVED_WRITE', 'AUTOMATED_LOGIN'), write).toBe(true);
      for (const mode of ['PUBLIC_PASSIVE', 'TEST_AUTH_PASSIVE'] as const) {
        for (const auth of ['NONE', 'MANUAL_SESSION', 'AUTOMATED_LOGIN'] as const) {
          expect(isProfileOperationAllowed(write, mode, auth), `${write} ${mode}/${auth}`).toBe(false);
        }
      }
    }
  });

  it('keeps the existing owner of the audit: the executable modes and strategies are the AUDIT row of the table', () => {
    expect(EXECUTABLE_AUDIT_MODES).toEqual(Object.keys(PROFILE_OPERATION_POLICY.AUDIT));
    for (const [mode, auth] of PROFILE_KINDS) {
      expect(isExecutableAuthStrategy(mode, auth), `${mode}/${auth}`).toBe(isProfileOperationAllowed('AUDIT', mode, auth));
    }
  });

  it('rejects values that are not modes, strategies or operations (fail-closed)', () => {
    for (const [operation, mode, auth] of [
      ['DISCOVERY', 'constructor', 'MANUAL_SESSION'],
      ['DISCOVERY', 'test_approved_write', 'MANUAL_SESSION'],
      ['DISCOVERY', null, 'MANUAL_SESSION'],
      ['constructor', 'TEST_APPROVED_WRITE', 'MANUAL_SESSION'],
      ['WRITE', 'TEST_APPROVED_WRITE', 'MANUAL_SESSION'],
      [undefined, 'TEST_AUTH_PASSIVE', 'MANUAL_SESSION'],
    ] as const) {
      expect(profileOperationRejectionOf(operation as never, mode, auth), `${String(operation)}/${String(mode)}`).toBe(MODE);
    }
    for (const auth of ['constructor', 'manual_session', null, undefined, ['MANUAL_SESSION']]) {
      expect(profileOperationRejectionOf('DISCOVERY', 'TEST_APPROVED_WRITE', auth), String(auth)).toBe(AUTH);
    }
  });

  it('needs the auth setup only for an operation the mode accepts (the write mode audit does not need it, as it cannot start)', () => {
    expect(AUDIT_MODES.map((mode) => operationRequiresAuthSetup('AUDIT', mode))).toEqual([false, true, false]);
    expect(AUDIT_MODES.map((mode) => operationRequiresAuthSetup('DISCOVERY', mode))).toEqual([false, true, true]);
    expect(AUDIT_MODES.map((mode) => operationRequiresAuthSetup('LOGIN_CHECK', mode))).toEqual([false, true, true]);
    expect(operationRequiresAuthSetup('DISCOVERY', 'constructor')).toBe(false);
  });

  // 判定を owner の外に書き直さない（Gate。コメントと文字列の外の本文で、モードの値の文字列を比べない）。
  it('does not write a mode value in the files that use the decision (they call the owner)', () => {
    const users = [
      'src/control/job/audit-job-manager.ts',
      'src/control/auth/auth-setup-policy.ts',
      'apps/local-ui/src/server/audit-start-check.ts',
      'apps/local-ui/src/display/labels.ts',
      'apps/local-ui/src/server/start-check-inputs.ts',
      // T28e fix round 1: シナリオを使うかの判定と、シナリオの保存の部品のモードの確かめも、owner を呼ぶ。
      'apps/local-ui/src/server/scenario-facts.ts',
      'src/control/approval/scenario-store.ts',
    ];
    for (const path of users) {
      const source = scanSource(readFileSync(resolve(process.cwd(), path), 'utf8'));
      const modeLiterals = source.literals.filter((literal) => (AUDIT_MODES as readonly string[]).includes(literal));
      expect(modeLiterals, path).toEqual([]);
    }
    // 検出の自己検査。
    expect(scanSource(`const m = 'TEST_AUTH_PASSIVE';`).literals).toContain('TEST_AUTH_PASSIVE');
  });
});

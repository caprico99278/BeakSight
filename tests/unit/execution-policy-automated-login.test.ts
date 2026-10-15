// T26d-2（Task 26 の設計書 4.3、変更履歴の「Blocker: T26d-2」の行）: 今実行できる認証の方式の owner（`src/control/execution-policy.ts`）は、
// プラットフォームを問わない純粋な判定で、認証つきの読み取りの監査（`TEST_AUTH_PASSIVE`）に自動ログイン（`AUTOMATED_LOGIN`）を足す。このファイルは
// ブラウザでも読み込まれるので、`process` を使わない（Windows だけであることは、ジョブの管理の開始の確かめで強制する。
// `control-audit-jobs-auto-login.test.ts` の「Windows でない」の場面）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_MODES, AUTH_STRATEGIES } from '../../src/control/contracts.js';
import { EXECUTABLE_AUTH_STRATEGIES, isExecutableAuthStrategy } from '../../src/control/execution-policy.js';
import { scanSource } from '../architecture/source-scan.js';

const POLICY_PATH = resolve(process.cwd(), 'src', 'control', 'execution-policy.ts');

describe('executable auth strategies of the automated login (T26d-2)', () => {
  it('accepts AUTOMATED_LOGIN of the authenticated passive audit as a strategy, on any platform', () => {
    const accepted = AUDIT_MODES.flatMap((mode) =>
      AUTH_STRATEGIES.filter((auth) => isExecutableAuthStrategy(mode, auth)).map((auth) => `${mode}/${auth}`));
    expect(accepted).toEqual(['PUBLIC_PASSIVE/NONE', 'TEST_AUTH_PASSIVE/MANUAL_SESSION', 'TEST_AUTH_PASSIVE/AUTOMATED_LOGIN']);
    expect(EXECUTABLE_AUTH_STRATEGIES).toEqual({ PUBLIC_PASSIVE: ['NONE'], TEST_AUTH_PASSIVE: ['MANUAL_SESSION', 'AUTOMATED_LOGIN'] });
    expect(Object.isFrozen(EXECUTABLE_AUTH_STRATEGIES)).toBe(true);
  });

  it('never accepts the automated login of the other modes, or values that are not strategies', () => {
    for (const [mode, auth] of [
      ['TEST_APPROVED_WRITE', 'AUTOMATED_LOGIN'],
      ['PUBLIC_PASSIVE', 'AUTOMATED_LOGIN'],
      ['TEST_AUTH_PASSIVE', 'automated_login'],
      ['TEST_AUTH_PASSIVE', null],
      ['constructor', 'AUTOMATED_LOGIN'],
    ]) {
      expect(isExecutableAuthStrategy(mode, auth), `${String(mode)}/${String(auth)}`).toBe(false);
    }
  });

  it('does not refer to process (the file is loaded in the browser too)', () => {
    const source = scanSource(readFileSync(POLICY_PATH, 'utf8'));
    expect(source.bare).not.toMatch(/\bprocess\b/u);
    // 検出の自己検査。
    expect(scanSource('const p = process.platform;').bare).toMatch(/\bprocess\b/u);
  });
});

import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { AUDIT_SEND_PASS_EXCEPT_DELETE, installPassiveRequestGuard } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';

/**
 * RB-14b（X1）: 判定の口は、ログインの段と、ほかの段（書き込みの段・監査の段・送信の扱い・リアルタイムの通信）の口を一緒に作れない（型）。Guard の取り付けも、
 * その組み合わせを、取り付けの前に `TypeError` で拒む（判定の中の実行時の fail-closed の分岐は外した）。
 */
describe('the guard refuses the login stage together with another stage', () => {
  const loginStage = { loginPostEndpoints: [], remainingPosts: 1 };
  const others = {
    writeStage: {},
    auditStage: {},
    auditSend: { policy: AUDIT_SEND_PASS_EXCEPT_DELETE, approvedServiceOrigins: [], dangerousTerms: [] },
    realtimePassThrough: { dangerousTerms: [] },
  };

  it.each(Object.entries(others))('refuses the login stage with %s', async (name, value) => {
    await expect(installPassiveRequestGuard({} as BrowserContext, new SafetyLedger(), new Set(['https://example.test']), {
      loginStage,
      [name]: value,
    } as never)).rejects.toThrow(/login stage/u);
  });
});

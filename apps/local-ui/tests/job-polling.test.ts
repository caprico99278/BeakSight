/**
 * ML-b-2（設計書 `doc/design/2026-10-19-beaksight-manual-login-pass-through-design.md` の 2.3）: 手動のログインの成功から設定を自動で登録する結果
 * （`loginStage.autoRegistration`）は、ジョブの管理がジョブの終わりの後に背後で書く。終わったジョブの画面は、結果が書かれるまで、短い間だけ読み直しを
 * 続ける（T41g-2 の「登録中」の読み直しと同じ考え）。判定（`apps/local-ui/src/display/job-polling.ts` の `awaitsAutoRegistration`）を確かめる。
 */
import { describe, expect, it } from 'vitest';
import { MINUTE_MS } from '../../../src/core/time-units.js';
import { AUDIT_JOB_AUTO_REGISTRATION_WAIT_MS, awaitsAutoRegistration } from '../src/display/job-polling';

const FINISHED_AT = '20261019010000';
const FINISHED_AT_MS = Date.UTC(2026, 9, 19, 1, 0, 0);
const PASSED = Object.freeze({ requests: [], unlisted: 1 });
const ended = Object.freeze({
  active: false,
  finishedAt: FINISHED_AT,
  loginStage: { scriptLogin: null, blockedRequests: null, passedRequests: PASSED },
});

describe('ML-b-2: the finished job screen waits a short time for the automatic registration', () => {
  it('keeps reloading only for a short time after a manual login job that passed requests ended without the result', () => {
    expect(AUDIT_JOB_AUTO_REGISTRATION_WAIT_MS).toBeGreaterThan(0);
    expect(AUDIT_JOB_AUTO_REGISTRATION_WAIT_MS).toBeLessThanOrEqual(MINUTE_MS);
    expect(awaitsAutoRegistration(ended, FINISHED_AT_MS)).toBe(true);
    expect(awaitsAutoRegistration(ended, FINISHED_AT_MS + AUDIT_JOB_AUTO_REGISTRATION_WAIT_MS)).toBe(true);
    expect(awaitsAutoRegistration(ended, FINISHED_AT_MS + AUDIT_JOB_AUTO_REGISTRATION_WAIT_MS + 1)).toBe(false);
  });

  it('does not wait once the result is written, for a job that passed nothing, or for a job that has not ended', () => {
    const saved = { result: 'SAVED' as const, profileRevision: 2, addedServiceOrigins: [] };
    expect(awaitsAutoRegistration({ ...ended, loginStage: { ...ended.loginStage, autoRegistration: saved } }, FINISHED_AT_MS)).toBe(false);
    expect(awaitsAutoRegistration({ ...ended, loginStage: { scriptLogin: null, blockedRequests: PASSED } }, FINISHED_AT_MS)).toBe(false);
    expect(awaitsAutoRegistration({ ...ended, loginStage: null }, FINISHED_AT_MS)).toBe(false);
    expect(awaitsAutoRegistration({ ...ended, active: true, finishedAt: null }, FINISHED_AT_MS)).toBe(false);
    expect(awaitsAutoRegistration({ ...ended, finishedAt: null }, FINISHED_AT_MS)).toBe(false);
  });
});

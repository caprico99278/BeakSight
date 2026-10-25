// AS-b（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.1）: `START` の、監査の段の送信の扱いの項目（`auditSendPolicy`）。
// - 監査・発見・READ の確かめのジョブ（`WORKER_JOB_KINDS_WITH_AUDIT_SEND_POLICY`）だけが持てる（書き込み・ログインの確かめ・入口の確かめは持てない。
//   書き込みとログインの段には口を渡さない）。
// - 値は一覧（`AUDIT_SEND_POLICIES`）の値だけ。省略は読み取りだけ（ワーカーが `READ_ONLY` の上書きで読む）。
import { describe, expect, it } from 'vitest';
import {
  WORKER_JOB_KINDS,
  WORKER_JOB_KINDS_WITH_AUDIT_SEND_POLICY,
  WORKER_PROTOCOL_VERSION,
  validateParentToWorkerMessage,
} from '../../src/control/worker-protocol.js';
import { AUDIT_SEND_POLICIES } from '../../src/core/audit-send-policy.js';

const START = Object.freeze({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-audit-send',
  jobKind: 'AUDIT',
  targetConfigPath: 'config/targets/example.json',
  startNew: true,
  targetConfigSha256: 'a'.repeat(64),
});

describe('AS-b: the audit send policy item in START', () => {
  it('lists the audit, discovery and READ check jobs only', () => {
    expect(WORKER_JOB_KINDS_WITH_AUDIT_SEND_POLICY).toEqual(['AUDIT', 'DISCOVERY', 'READ_CHECK']);
    expect(Object.isFrozen(WORKER_JOB_KINDS_WITH_AUDIT_SEND_POLICY)).toBe(true);
  });

  it('accepts each listed value for an audit job, and its absence', () => {
    for (const auditSendPolicy of AUDIT_SEND_POLICIES) {
      expect(validateParentToWorkerMessage({ ...START, auditSendPolicy }).ok, auditSendPolicy).toBe(true);
    }
    expect(validateParentToWorkerMessage(START).ok).toBe(true);
  });

  it('rejects a value outside the list', () => {
    for (const auditSendPolicy of ['PASS_ALL', 'read_only', '', true, null, 1]) {
      expect(validateParentToWorkerMessage({ ...START, auditSendPolicy }).ok, String(auditSendPolicy)).toBe(false);
    }
  });

  it('rejects the item for the other job kinds (writes, the login check and the entry check)', () => {
    const others = WORKER_JOB_KINDS.filter((kind) => !WORKER_JOB_KINDS_WITH_AUDIT_SEND_POLICY.includes(kind));
    expect(others).toEqual(['LOGIN_CHECK', 'WRITE_CREATE', 'WRITE_UPDATE', 'ENTRY_CHECK']);
    for (const jobKind of others) {
      for (const auditSendPolicy of AUDIT_SEND_POLICIES) {
        const result = validateParentToWorkerMessage({ ...START, jobKind, auditSendPolicy });
        expect(result.ok, `${jobKind} ${auditSendPolicy}`).toBe(false);
        expect(result.ok ? [] : result.errors).toContain(`/auditSendPolicy is not allowed for ${jobKind}`);
      }
    }
  });
});

// FM-2（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 2.2）: `START` の、ジョブのブラウザを表示するかの項目（`showJobBrowser`。真偽）。
// - 監査・発見・READ の確かめ・書き込みのジョブだけが持てる（ログインの確かめと入口の確かめは持てない。ログインの段のブラウザは今どおり表示）。
// - 真偽のほかの値は、形の誤り。省略は表示しない（今の振る舞い）。
import { describe, expect, it } from 'vitest';
import { WORKER_PROTOCOL_VERSION, validateParentToWorkerMessage } from '../../src/control/worker-protocol.js';

const START = Object.freeze({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-show-browser',
  jobKind: 'AUDIT',
  targetConfigPath: 'config/targets/example.json',
  startNew: true,
  targetConfigSha256: 'a'.repeat(64),
});

describe('FM-2: the item to show the job browser in START', () => {
  it('accepts the item true and false for an audit job, and its absence', () => {
    expect(validateParentToWorkerMessage({ ...START, showJobBrowser: true }).ok).toBe(true);
    expect(validateParentToWorkerMessage({ ...START, showJobBrowser: false }).ok).toBe(true);
    expect(validateParentToWorkerMessage(START).ok).toBe(true);
  });

  it('rejects a value that is not a boolean', () => {
    expect(validateParentToWorkerMessage({ ...START, showJobBrowser: 'yes' }).ok).toBe(false);
    expect(validateParentToWorkerMessage({ ...START, showJobBrowser: null }).ok).toBe(false);
  });

  it('rejects the item for the entry check job (no job browser of the run kinds)', () => {
    expect(validateParentToWorkerMessage({ ...START, jobKind: 'ENTRY_CHECK', showJobBrowser: true }).ok).toBe(false);
    expect(validateParentToWorkerMessage({ ...START, jobKind: 'ENTRY_CHECK', showJobBrowser: false }).ok).toBe(false);
  });
});

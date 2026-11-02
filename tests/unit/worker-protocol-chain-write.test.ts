// OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.2 の案 C）: まとめて実行の最後の書き込みの段の IPC の契約（`src/control/worker-protocol.ts` と
// `schemas/control/worker-message.schema.json`）。
// - `START` の `chain` は、書き込みの段を続けられる印（`writeStages: true`）を持てる。印は書き込みのモードの並び（監査 → 発見 → READ の確かめ）と一緒だけ。
// - `NEXT_STAGE` は、書き込みの段（`WRITE_CREATE`・`WRITE_UPDATE`）を指せる。書き込みの段は書き込みの指定（`write`。`START` と同じ形）を必ず持ち、ほかの段は
//   持てない。
// - 形が変わったので、プロトコルの版を 4 に上げた（親と子の版が違えば、どちらも受けない）。
import { describe, expect, it } from 'vitest';
import {
  WORKER_CHAIN_WRITE_STAGE_JOB_KINDS,
  WORKER_NEXT_STAGE_JOB_KINDS,
  WORKER_PROTOCOL_VERSION,
  validateParentToWorkerMessage,
} from '../../src/control/worker-protocol.js';
import { sampleStartUpdateWrite, sampleStartWrite } from './worker-write-samples.js';

const ORIGIN = 'http://127.0.0.1:4173';

const errorsOf = (value: unknown): readonly string[] => {
  const checked = validateParentToWorkerMessage(value);
  return checked.ok ? [] : checked.errors;
};

const next = (extra: Record<string, unknown>): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION, type: 'NEXT_STAGE', jobId: 'job-write-1', ...extra,
});

describe('OP-2: the write stages of the chained run in the IPC contract', () => {
  it('raises the protocol version to 4 for the new shape', () => {
    expect(WORKER_PROTOCOL_VERSION).toBe('beaksight-worker-message/7'); // DEF-180: 前の読み込みの時刻で版 5。OP-H: チェックした画面の数で版 6。OP-L: 保存できなかった理由で版 7
  });

  it('lets NEXT_STAGE start a create or an update write stage with the write specification', () => {
    expect(WORKER_CHAIN_WRITE_STAGE_JOB_KINDS).toEqual(['WRITE_CREATE', 'WRITE_UPDATE']);
    expect(WORKER_NEXT_STAGE_JOB_KINDS).toEqual(['DISCOVERY', 'READ_CHECK', 'WRITE_CREATE', 'WRITE_UPDATE']);
    expect(errorsOf(next({ jobKind: 'WRITE_CREATE', write: sampleStartWrite(ORIGIN) }))).toEqual([]);
    expect(errorsOf(next({ jobKind: 'WRITE_UPDATE', write: sampleStartUpdateWrite(ORIGIN) }))).toEqual([]);
  });

  it('requires the write specification only for the write stages, with the update block only for the update', () => {
    expect(errorsOf(next({ jobKind: 'WRITE_CREATE' }))).toContain('/write is required for WRITE_CREATE');
    expect(errorsOf(next({ jobKind: 'DISCOVERY', write: sampleStartWrite(ORIGIN) }))).toContain('/write is allowed only for WRITE_CREATE and WRITE_UPDATE');
    expect(errorsOf(next({ jobKind: 'WRITE_CREATE', write: sampleStartUpdateWrite(ORIGIN) })))
      .toContain('/write/update is required for WRITE_UPDATE and allowed only for it');
    expect(errorsOf(next({ jobKind: 'WRITE_UPDATE', write: sampleStartWrite(ORIGIN) })))
      .toContain('/write/update is required for WRITE_UPDATE and allowed only for it');
  });

  it('accepts the write stages mark of the chain only as true', () => {
    const start = (chain: Record<string, unknown>): Record<string, unknown> => ({
      protocol: WORKER_PROTOCOL_VERSION, type: 'START', jobId: 'job-audit', jobKind: 'AUDIT', targetConfigPath: 'config/targets/example.json', startNew: true,
      targetConfigSha256: 'a'.repeat(64), chain,
    });
    // OP-H: 書き込みの段の印は、チェックした画面の数（`writeScreenCount`）と一緒に入れる。
    expect(errorsOf(start({ stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'], writeStages: true, writeScreenCount: 1 }))
      .filter((error) => error.includes('writeStages') || error.includes('writeScreenCount'))).toEqual([]);
    expect(errorsOf(start({ stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'], writeStages: false, writeScreenCount: 1 })).length).toBeGreaterThan(0);
  });

  // OP-H（撮影 UI-W4 の 3）: 監査の段の報告が「この後に、チェックした画面で登録・更新する」と言えるよう、親はチェックした画面の数だけを渡す（画面の名前や path は
  // 渡さない）。数は 1 以上の整数で、書き込みの段の印と必ず一緒（片方だけは受けない）。
  it('carries the number of the checked screens only together with the write stages mark', () => {
    const start = (chain: Record<string, unknown>): Record<string, unknown> => ({
      protocol: WORKER_PROTOCOL_VERSION, type: 'START', jobId: 'job-audit', jobKind: 'AUDIT', targetConfigPath: 'config/targets/example.json', startNew: true,
      targetConfigSha256: 'a'.repeat(64), chain,
    });
    const chainErrors = (chain: Record<string, unknown>): readonly string[] =>
      errorsOf(start({ stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'], ...chain })).filter((error) => error.includes('/chain'));
    expect(chainErrors({ writeStages: true, writeScreenCount: 3 })).toEqual([]);
    expect(chainErrors({})).toEqual([]);
    expect(chainErrors({ writeStages: true })).toContain('/chain/writeScreenCount is required with /chain/writeStages and allowed only with it');
    expect(chainErrors({ writeScreenCount: 2 })).toContain('/chain/writeScreenCount is required with /chain/writeStages and allowed only with it');
    expect(chainErrors({ writeStages: true, writeScreenCount: 0 }).length).toBeGreaterThan(0);
    expect(chainErrors({ writeStages: true, writeScreenCount: 1.5 }).length).toBeGreaterThan(0);
  });
});

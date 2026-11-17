/**
 * RB-6（設計書 `doc/design/2026-11-15-beaksight-test-rebuild-design.md` 2 章 5、案 6 章 B）: まとめて実行の段 1 つの入口（`runChainStageOnce`）。前の段の結果
 * （`ChainStageSeed`）を与えて段 1 つだけに入り、段の流れへ渡すものと、段の終わりの持ち越しを確かめる。
 */
import { describe, expect, it } from 'vitest';
import type { WorkerNextStageMessage, WorkerStartMessage } from '../../src/control/worker-protocol.js';
import { createNavigationPacer } from '../../src/crawl/navigation-pacer.js';
import type { RunStageCarried } from '../../src/orchestration/audit-stage-run.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import {
  runChainStageOnce,
  validatedChainWriteOf,
  type ChainStage,
  type ChainStageRunners,
  type ChainStageSeed,
} from '../../src/worker/chain-stage.js';
import { createTestConfig } from '../helpers/test-config.js';

const CARRIED: RunStageCarried = Object.freeze({
  latestState: null,
  serviceRequestWindowMs: [7_000],
  navigation: Object.freeze({ lastNavigationStartedAtMs: 1, stageEndedAtMs: 2, minIntervalMs: 3 }),
});
const RUN_DIRECTORY = 'C:/runs/RUN-1';
const CONFIG = createTestConfig('http://127.0.0.1:9');

const seedOf = (overrides: Partial<ChainStageSeed> = {}): ChainStageSeed => ({
  authentication: { initialState: null } as unknown as RunAuthentication,
  navigationPacer: createNavigationPacer({ minIntervalMs: 0, now: () => 0, sleep: async () => undefined }),
  serviceRequestWindowMs: [1_000, 2_000],
  ...overrides,
});

const stageOf = (kind: ChainStage['kind']): ChainStage => ({ kind, jobId: `job-${kind}`, readChecks: kind === 'READ_CHECK' ? [] : undefined, write: undefined });

/** 呼ばれた流れと、受けたもの（設定・認証・pacer・持ち越しの窓・前の段の Run）を記録する偽の流れ。 */
const recordingRunners = (): { readonly runners: ChainStageRunners; readonly calls: Record<string, unknown>[] } => {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    runners: {
      audit: async (_options, config, authentication, navigationPacer, _automatedLogin, stageCarry, onRan) => {
        calls.push({ kind: 'AUDIT', config, authentication, navigationPacer, window: stageCarry.serviceRequestWindowMs });
        stageCarry.record(CARRIED);
        onRan(RUN_DIRECTORY);
        return 0;
      },
      discover: async (jobId, config, _authentication, _pacer, _carry, chainedAuditRunDirectory, checkpoint) => {
        calls.push({ kind: 'DISCOVERY', jobId, config, chainedAuditRunDirectory, checkpoint });
        return 3;
      },
      readCheck: async (jobId) => {
        calls.push({ kind: 'READ_CHECK', jobId });
        return 0;
      },
      write: null,
      unsupported: (stage) => {
        calls.push({ kind: 'UNSUPPORTED', stage: stage.kind });
        return 1;
      },
    },
  };
};

describe('RB-6: one stage of the chained run from the result of the stage before', () => {
  it('gives the seed to the stage, and returns what the stage carried and the Run directory', async () => {
    const seed = seedOf();
    const { runners, calls } = recordingRunners();
    const result = await runChainStageOnce({ stage: stageOf('AUDIT'), runOptions: { startNew: true }, config: CONFIG, automatedLogin: false, seed }, runners);
    expect(calls).toEqual([{ kind: 'AUDIT', config: CONFIG, authentication: seed.authentication, navigationPacer: seed.navigationPacer, window: [1_000, 2_000] }]);
    expect(result).toEqual({ exitCode: 0, carried: CARRIED, runDirectory: RUN_DIRECTORY });
  });

  it('passes the Run of the audit before and the checkpoint to the discovery stage, and carries nothing a stage did not record', async () => {
    const { runners, calls } = recordingRunners();
    const checkpoint = { identity: { authenticationSha256: 'a', targetConfigSha256: 'b' } };
    const result = await runChainStageOnce({
      stage: stageOf('DISCOVERY'), runOptions: { startNew: true }, config: CONFIG, automatedLogin: true,
      seed: seedOf({ chainedAuditRunDirectory: RUN_DIRECTORY, discoveryCheckpoint: checkpoint }),
    }, runners);
    expect(calls).toEqual([{ kind: 'DISCOVERY', jobId: 'job-DISCOVERY', config: CONFIG, chainedAuditRunDirectory: RUN_DIRECTORY, checkpoint }]);
    expect(result).toEqual({ exitCode: 3, carried: null, runDirectory: null });
  });

  it('does not run a stage without its flow, nor a write stage without a checked write specification', async () => {
    const { runners, calls } = recordingRunners();
    const exitCodes = [];
    for (const kind of ['WRITE_CREATE', 'WRITE_UPDATE'] as const) {
      exitCodes.push((await runChainStageOnce({ stage: stageOf(kind), runOptions: { startNew: true }, config: CONFIG, automatedLogin: false, seed: seedOf() },
        { ...runners, write: async () => 0 })).exitCode);
    }
    exitCodes.push((await runChainStageOnce({ stage: stageOf('DISCOVERY'), runOptions: { startNew: true }, config: CONFIG, automatedLogin: false, seed: seedOf() },
      { ...runners, discover: null })).exitCode);
    expect(exitCodes).toEqual([1, 1, 1]);
    expect(calls).toEqual([{ kind: 'UNSUPPORTED', stage: 'WRITE_CREATE' }, { kind: 'UNSUPPORTED', stage: 'WRITE_UPDATE' }, { kind: 'UNSUPPORTED', stage: 'DISCOVERY' }]);
  });

  it('checks a write specification of NEXT_STAGE only for a write stage (not for the read stages)', () => {
    const next = { protocol: 1, type: 'NEXT_STAGE', jobId: 'job-read', jobKind: 'READ_CHECK', readChecks: [] } as unknown as WorkerNextStageMessage;
    expect(validatedChainWriteOf({} as WorkerStartMessage, next)).toBeNull();
  });
});

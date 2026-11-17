// WSO: 書き込みを試す画面にチェックを付けて点検を始めるとき、「チェックした画面だけ」を選べる。
// - 段の並び: 「チェックした画面だけ」は点検の段 1 つ（その後に書き込みの段）。書き込みのモードだけ。
// - 読む画面の決め方: チェックした画面（登録の画面）と、関係する一覧の画面。型（`{id}`）の画面は読まない。重ねない。
// - 再開の選び方: 「全部」の Run と「チェックした画面だけ」の Run は、互いの続きを奪わない。
// - IPC: 点検の段 1 つの並びは、書き込みの段の印と読む画面と一緒だけ。読む画面は、その並びだけが持てる。
import { describe, expect, it } from 'vitest';
import { CHECKED_WRITE_SCREENS_SCOPE } from '../../src/core/audit-page-scope.js';
import { createRunId } from '../../src/core/ids.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { chainStagesOf, checkedScreenPagesOf } from '../../src/control/job/stage-chain-policy.js';
import { WORKER_PROTOCOL_VERSION, validateParentToWorkerMessage } from '../../src/control/worker-protocol.js';
import { createRunCheckpoint, selectRunToResume, type RunCheckpoint, type RunResumeCandidate } from '../../src/orchestration/run-checkpoint.js';
import { sampleRunCheckpoint } from '../helpers/run-checkpoint-samples.js';

const ORIGIN = 'http://127.0.0.1:4173';
const OTHER_ORIGIN = 'http://127.0.0.1:4174';

describe('WSO: the stages of the inspection of the checked screens only', () => {
  it('is the audit stage only in the write mode, and the mode stages without the scope', () => {
    expect(chainStagesOf('TEST_APPROVED_WRITE', CHECKED_WRITE_SCREENS_SCOPE)).toEqual(['AUDIT']);
    expect(chainStagesOf('TEST_AUTH_PASSIVE', CHECKED_WRITE_SCREENS_SCOPE)).toBeNull();
    expect(chainStagesOf('PUBLIC_PASSIVE', CHECKED_WRITE_SCREENS_SCOPE)).toBeNull();
    expect(chainStagesOf('TEST_APPROVED_WRITE', null)).toEqual(['AUDIT', 'DISCOVERY', 'READ_CHECK']);
  });
});

describe('WSO: the screens that the inspection of the checked screens reads', () => {
  // REV-WSO の M-3: 関係する画面は、その画面自身の Origin で読み、許可 Origin の外の画面は読まない。
  it('reads each checked screen and its related list screens once, in order, at their own origins, without template paths or other origins', () => {
    const at = (path: string, origin = ORIGIN) => ({ origin, path });
    expect(checkedScreenPagesOf([
      { page: at('/items/new'), relatedPages: [at('/items'), null, at('/items/{id}/edit'), at('/items', OTHER_ORIGIN)] },
      { page: at('/members/new'), relatedPages: [at('/members'), at('/items')] },
      { page: at('/items/new'), relatedPages: [] },
      { page: at('/outside/new', OTHER_ORIGIN), relatedPages: [] },
    ], [ORIGIN])).toEqual([
      { origin: ORIGIN, path: '/items/new' },
      { origin: ORIGIN, path: '/items' },
      { origin: ORIGIN, path: '/members/new' },
      { origin: ORIGIN, path: '/members' },
    ]);
    expect(checkedScreenPagesOf([], [ORIGIN])).toEqual([]);
  });
});

describe('WSO: the resume choice by the scope', () => {
  const scoped = (checkpoint: RunCheckpoint): RunCheckpoint =>
    createRunCheckpoint({ ...checkpoint, pageScope: { kind: CHECKED_WRITE_SCREENS_SCOPE, pageCount: 2 } });
  const candidateOf = (checkpoint: RunCheckpoint, sequence: number, startedAt: string): RunResumeCandidate => {
    const runId = createRunId(sequence);
    return { runId, runDirectory: `output/${runId}`, checkpoint: createRunCheckpoint({ ...checkpoint, startedAt }) };
  };
  const full = candidateOf(sampleRunCheckpoint(), 1, '2026-11-16T00:00:00.000Z');
  const checkedOnly = candidateOf(scoped(sampleRunCheckpoint()), 2, '2026-11-16T01:00:00.000Z');

  it('resumes the earlier whole Run, not the later Run of the checked screens, and the other way round', () => {
    const config = full.checkpoint.effectiveConfig;
    expect(selectRunToResume([full, checkedOnly], config)).toMatchObject({ kind: 'RESUME', candidate: { runId: full.runId } });
    expect(selectRunToResume([full, checkedOnly], config, null, CHECKED_WRITE_SCREENS_SCOPE))
      .toMatchObject({ kind: 'RESUME', candidate: { runId: checkedOnly.runId } });
    expect(selectRunToResume([checkedOnly], config)).toEqual({ kind: 'START_NEW' });
  });

  it('accepts the scope in the checkpoint schema', async () => {
    await expect(validateArtifact('checkpoint', JSON.parse(JSON.stringify(checkedOnly.checkpoint)) as unknown)).resolves.toEqual({ ok: true });
  });
});

describe('WSO: the chain of the checked screens in the IPC contract', () => {
  const start = (chain: Record<string, unknown>): Record<string, unknown> => ({
    protocol: WORKER_PROTOCOL_VERSION, type: 'START', jobId: 'job-audit', jobKind: 'AUDIT', targetConfigPath: 'config/targets/example.json', startNew: true,
    targetConfigSha256: 'a'.repeat(64), chain,
  });
  const chainErrors = (chain: Record<string, unknown>): readonly string[] => {
    const checked = validateParentToWorkerMessage(start(chain));
    return checked.ok ? [] : checked.errors.filter((error) => error.includes('/chain'));
  };
  const pages = [{ origin: ORIGIN, path: '/items/new' }, { origin: ORIGIN, path: '/items' }];

  it('accepts the audit stage only with the write stages and the screens to read', () => {
    expect(chainErrors({ stages: ['AUDIT'], writeStages: true, writeScreenCount: 1, checkedScreenPages: pages })).toEqual([]);
    expect(chainErrors({ stages: ['AUDIT'], writeStages: true, writeScreenCount: 1 }).length).toBeGreaterThan(0);
    expect(chainErrors({ stages: ['AUDIT'], checkedScreenPages: pages }).length).toBeGreaterThan(0);
    expect(chainErrors({ stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'], writeStages: true, writeScreenCount: 1, checkedScreenPages: pages }).length)
      .toBeGreaterThan(0);
    expect(chainErrors({ stages: ['AUDIT'], writeStages: true, writeScreenCount: 1, checkedScreenPages: [{ origin: ORIGIN, path: 'items' }] }).length)
      .toBeGreaterThan(0);
  });
});

/**
 * 画面のサーバの終わり（Ctrl+C）の 2 段の扱いの単体テスト（Task 24 の設計書 4.4 の「画面のサーバの終わり」。T24f）。
 * - 1 回目: 動いているジョブがあれば知らせ、ジョブの後始末（名前つきの時間だけ待つ）→ 画面のサーバ → 管理データの順に閉じてから終える。
 * - 2 回目: 待たずに、すぐに終える。
 * - 後始末が失敗しても、終える（止まったままにしない）。
 */
import { describe, expect, it } from 'vitest';
import { createTwoStepShutdown, SHUTDOWN_EXIT_CODE } from '../launcher/shutdown.ts';

const TEXT = Object.freeze({ jobsStopping: 'stopping jobs', exitingNow: 'exiting now' });

interface Recorder {
  readonly steps: string[];
  readonly exits: number[];
  release: () => void;
}

const recorder = (runningJobs: number, failJobs = false): { readonly record: Recorder; readonly handler: () => void } => {
  const steps: string[] = [];
  const exits: number[] = [];
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolveHeld) => {
    release = resolveHeld;
  });
  const record: Recorder = { steps, exits, release: () => release() };
  const handler = createTwoStepShutdown({
    runningJobCount: () => runningJobs,
    text: TEXT,
    log: (line) => steps.push(`log:${line}`),
    shutdownJobs: async () => {
      steps.push('jobs');
      await held;
      if (failJobs) {
        throw new Error('jobs failed');
      }
    },
    closeServer: async () => {
      steps.push('server');
    },
    closeStore: () => {
      steps.push('store');
    },
    exit: (code) => {
      exits.push(code);
    },
  });
  return { record, handler };
};

const settle = (): Promise<void> => new Promise((resolveSettle) => {
  setImmediate(resolveSettle);
});

describe('two-step shutdown of the local UI server', () => {
  it('on the first signal: tells about running jobs, waits for the jobs, closes the server and the store, then exits', async () => {
    const { record, handler } = recorder(1);
    handler();
    await settle();
    expect(record.steps).toEqual(['log:stopping jobs', 'jobs']);
    expect(record.exits).toEqual([]);
    record.release();
    await settle();
    await settle();
    expect(record.steps).toEqual(['log:stopping jobs', 'jobs', 'server', 'store']);
    expect(record.exits).toEqual([SHUTDOWN_EXIT_CODE]);
  });

  it('does not tell anything when no job is running', async () => {
    const { record, handler } = recorder(0);
    record.release();
    handler();
    await settle();
    await settle();
    expect(record.steps).toEqual(['jobs', 'server', 'store']);
    expect(record.exits).toEqual([SHUTDOWN_EXIT_CODE]);
  });

  it('on the second signal: exits at once without waiting for the jobs', async () => {
    const { record, handler } = recorder(1);
    handler();
    handler();
    expect(record.steps).toEqual(['log:stopping jobs', 'jobs', 'log:exiting now']);
    expect(record.exits).toEqual([SHUTDOWN_EXIT_CODE]);
  });

  it('still closes and exits when the job shutdown fails', async () => {
    const { record, handler } = recorder(1, true);
    handler();
    record.release();
    await settle();
    await settle();
    expect(record.steps).toEqual(['log:stopping jobs', 'jobs', 'server', 'store']);
    expect(record.exits).toEqual([SHUTDOWN_EXIT_CODE]);
  });
});

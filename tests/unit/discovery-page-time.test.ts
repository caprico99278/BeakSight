// DTIME: 操作さがしの 1 画面の時間の内訳（`createPageTimeRecorder`）を、偽の時計で確かめる。
// - 区分の時間・見張りの終わりで失った時間・そのほかを足すと全体になる（入れ子の測りは外の区分に入り、重ねて数えない）。
// - 読み込み直しと、準備の確かめの「だめ」を数える。見張りが終えた画面の見放した測りと、締めた後の測りは数えない。
import { describe, expect, it } from 'vitest';
import { PAGE_TIME_PARTS, createPageTimeRecorder, type DiscoveryPageTimeBreakdown } from '../../src/discovery/page-time-breakdown.js';

const sumOf = (breakdown: DiscoveryPageTimeBreakdown): number => breakdown.pacingWaitMs + breakdown.loadMs + breakdown.settleMs
  + breakdown.afterPressWindowMs + breakdown.pressReadinessMs + breakdown.inputChecksMs + breakdown.stageEndMs + breakdown.otherMs;

describe('DTIME: the time breakdown of one discovery page', () => {
  it('adds the parts, the time lost at the end of the watch and the rest up to the whole, counting nested waits once', async () => {
    let clock = 1_000;
    const recorder = createPageTimeRecorder(() => clock);
    const spend = (ms: number) => async (): Promise<void> => { clock += ms; };
    await recorder.measure('PACING_WAIT', spend(100));
    // 読み込みの中の落ち着きの待ちは、外の読み込みに入る。
    await recorder.measure('LOAD', async () => { clock += 200; await recorder.measure('SETTLE', spend(50)); });
    clock += 30;
    await recorder.measure('SETTLE', spend(40));
    await recorder.measure('AFTER_PRESS_WINDOW', spend(60));
    await recorder.measure('AFTER_PRESS_WINDOW', spend(60));
    const ready = await recorder.measure('PRESS_READINESS', async () => { clock += 25; return { ready: false }; }, (value) => !value.ready);
    expect(ready).toEqual({ ready: false });
    await recorder.measure('PRESS_READINESS', async () => { clock += 5; return { ready: true }; }, (value) => !value.ready);
    // 打つだけの欄の中の見届けの窓は、外の区分に入る（押下の数には数える）。
    await recorder.measure('INPUT_CHECKS', async () => { clock += 10; await recorder.measure('AFTER_PRESS_WINDOW', spend(20)); });
    recorder.countReload();
    await recorder.measure('LOAD', spend(100));
    clock += 7;
    const breakdown = recorder.finish();
    expect(breakdown).toEqual({
      totalMs: 707, pacingWaitMs: 100, loadMs: 350, loads: 2, reloads: 1, settleMs: 40, afterPressWindowMs: 120, presses: 3,
      pressReadinessMs: 30, pressReadinessTimeouts: 1, inputChecksMs: 30, stageEndMs: 0, otherMs: 37,
    });
    expect(sumOf(breakdown)).toBe(breakdown.totalMs);
    expect(PAGE_TIME_PARTS).toHaveLength(6);
  });

  it('counts the time from the last progress to the end of the watch as lost, ignores the abandoned work, and stops counting after finish', async () => {
    let clock = 0;
    const recorder = createPageTimeRecorder(() => clock);
    let release: () => void = () => undefined;
    // 見届けの窓を待つ間に、最後の中身の進みから見張りが画面を終える。
    const abandoned = recorder.measure('AFTER_PRESS_WINDOW', () => new Promise<void>((resolve) => { release = resolve; }));
    clock = 40;
    recorder.noteProgress();
    clock = 340;
    recorder.endStage();
    // 見放した処理が後で終わっても数えない。読み込み直した画面の測りは数える。
    clock = 400;
    release();
    await abandoned;
    await recorder.measure('LOAD', async () => { clock += 60; });
    const breakdown = recorder.finish();
    await recorder.measure('SETTLE', async () => { clock += 999; });
    expect(recorder.finish()).toEqual(breakdown);
    expect(breakdown).toMatchObject({ totalMs: 460, afterPressWindowMs: 40, stageEndMs: 300, loadMs: 60, otherMs: 60, presses: 1, loads: 1 });
    expect(sumOf(breakdown)).toBe(breakdown.totalMs);
  });
});

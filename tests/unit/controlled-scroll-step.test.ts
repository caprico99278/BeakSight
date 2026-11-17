// RB-9（再構築の設計書 3 章。案 2 章の 2）: controlled scroll の文書の輪と内側の領域の輪が共有する、1 回の測定の判定（純粋な `scrollStep`）。
// 進める量・進まなかった・最下部で静まった・伸び続けて新しい作りが出ない、を 1 か所で決める（ブラウザは使わない）。
import { describe, expect, it } from 'vitest';
import {
  INITIAL_SCROLL_STEP_STATE,
  scrollStep,
  scrollStructureCheckNeeded,
  type ScrollStepMeasurement,
  type ScrollStepState,
} from '../../src/browser/controlled-scroll.js';

const POLICY = { stableWindowMs: 100, stepViewportFraction: 0.5 } as const;
const at = (atMs: number, position: number, scrollHeight: number, canAdvance = true): ScrollStepMeasurement =>
  ({ atMs, position, viewportHeight: 100, scrollHeight, canAdvance });

/** 測定を順に渡し、判定の並びを返す。 */
const verdictsOf = (measurements: readonly ScrollStepMeasurement[], structure: (index: number) => boolean | undefined = () => undefined) => {
  let state: ScrollStepState = INITIAL_SCROLL_STEP_STATE;
  return measurements.map((measurement, index) => {
    const step = scrollStep(state, measurement, POLICY, structure(index));
    state = step.state;
    return step.verdict;
  });
};

describe('RB-9: the shared step of the controlled scroll', () => {
  it('steps by the fraction of the viewport, and stops at the bottom only after the stable window', () => {
    expect(verdictsOf([at(0, 0, 300), at(10, 50, 300), at(20, 100, 300), at(30, 150, 300), at(30, 200, 300), at(80, 200, 300), at(130, 200, 300)]))
      .toEqual([
        { kind: 'STEP', top: 50 }, { kind: 'STEP', top: 100 }, { kind: 'STEP', top: 150 }, { kind: 'STEP', top: 200 },
        { kind: 'STEP', top: 200 }, { kind: 'STEP', top: 200 }, { kind: 'BOTTOM_STABLE' },
      ]);
  });

  it('restarts the stable window when the height changes at the bottom', () => {
    expect(verdictsOf([at(0, 200, 300), at(100, 200, 300)]).at(-1)).toEqual({ kind: 'BOTTOM_STABLE' });
    expect(verdictsOf([at(0, 200, 300), at(60, 200, 250), at(100, 150, 250), at(200, 150, 250)]).map(({ kind }) => kind))
      .toEqual(['STEP', 'STEP', 'STEP', 'BOTTOM_STABLE']);
  });

  it('stops as not advanced when a requested step did not move and the height stayed', () => {
    expect(verdictsOf([at(0, 0, 300), at(10, 0, 300)]).at(-1)).toEqual({ kind: 'NOT_ADVANCED' });
    // 高さが変わったときは、進まなくても止めない。進めない測定（文書の対象がない）は、進んだかを確かめない。
    expect(verdictsOf([at(0, 0, 300), at(10, 0, 400)]).at(-1)).toEqual({ kind: 'STEP', top: 50 });
    expect(verdictsOf([at(0, 0, 300, false), at(10, 0, 300, false)]).at(-1)).toEqual({ kind: 'STEP', top: 50 });
  });

  it('asks for the structure only when the height grew near the bottom, and stops when no new structure appeared', () => {
    let state = scrollStep(INITIAL_SCROLL_STEP_STATE, at(0, 0, 1_000), POLICY, undefined).state;
    expect(scrollStructureCheckNeeded(state, at(10, 50, 1_200))).toBe(false);
    state = scrollStep(state, at(10, 50, 1_000), POLICY, undefined).state;
    state = scrollStep(state, at(20, 850, 1_000), POLICY, undefined).state;
    expect(scrollStructureCheckNeeded(state, at(30, 900, 1_000))).toBe(false);
    expect(scrollStructureCheckNeeded(state, at(30, 900, 1_300))).toBe(true);
    expect(scrollStep(state, at(30, 900, 1_300), POLICY, false).verdict).toEqual({ kind: 'NO_NEW_STRUCTURE' });
    expect(scrollStep(state, at(30, 900, 1_300), POLICY, true).verdict).toEqual({ kind: 'STEP', top: 950 });
  });
});

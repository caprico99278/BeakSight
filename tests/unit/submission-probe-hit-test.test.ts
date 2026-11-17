// L6/L3-1 の続き（設計者の判断 A の案 A1）: 押す前に、送信ボタンの矩形の点の最前面の要素（`elementFromPoint`）を読み、送信ボタンかその子孫になる点があれば、
// その点を押す。どの点も覆われていれば（モーダルの窓の後ろ・ほかの表示に覆われている・操作を受け付けない）、押さずに `COVERED_BY_OTHER` で次へ進む（Playwright の
// 1 手が期限なしで待ち続けない）。点は、監査の側（AUD-3b）と同じく、表示の範囲の中の矩形の中心と、内側に寄せた四隅の 5 点（寄せる量は各辺の 1/4 と 4px の小さい方）。
// 判定と点の純粋な部品と、理由の閉じた一覧を確かめる。ページの中の読み取りは、結合テスト（`discovery-screen-watch.test.ts`）で確かめる。
import { describe, expect, it } from 'vitest';
import {
  COVERED_BY_OTHER_PROBE_REASON,
  SUBMISSION_PROBE_HIT_POINT_INSET_PX,
  SUBMISSION_PROBE_NOT_OBSERVED_REASONS,
  SUBMISSION_PROBE_NOT_PRESSED_REASONS,
  submitterHitJudgementOf,
  submitterHitPointsOf,
} from '../../src/discovery/submission-probe-contracts.js';
import { LAYOUT_THRESHOLDS } from '../../src/evidence/layout-collector.js';
import { SUBMISSION_PROBE_REASON_CATALOG } from '../../src/presentation/catalog.js';

const VIEWPORT = { width: 1000, height: 800 };
const RECT = { left: 100, top: 200, right: 200, bottom: 240 };

describe('L6/L3-1 (decision A1): the hit points before a press', () => {
  it('uses the centre and the four corners moved inside by the smaller of a quarter of the side and the inset of the audit side', () => {
    // 監査の側（AUD-3b）の寄せる量と同じ値（共有できない置き場所なので、値が同じことを確かめる）。
    expect(SUBMISSION_PROBE_HIT_POINT_INSET_PX).toBe(LAYOUT_THRESHOLDS.hitTestPointInsetPx);
    expect(submitterHitPointsOf(RECT, VIEWPORT)).toEqual([[150, 220], [104, 204], [196, 204], [104, 236], [196, 236]]);
    // 小さい矩形（幅 8・高さ 8）は、各辺の 1/4（2px）だけ寄せる。
    expect(submitterHitPointsOf({ left: 0, top: 0, right: 8, bottom: 8 }, VIEWPORT)).toEqual([[4, 4], [2, 2], [6, 2], [2, 6], [6, 6]]);
  });

  it('takes the points in the part inside the viewport, and none when the centre of the element is outside the viewport', () => {
    expect(submitterHitPointsOf({ left: 900, top: 700, right: 1080, bottom: 760 }, VIEWPORT)).toEqual([[950, 730], [904, 704], [996, 704], [904, 756], [996, 756]]);
    expect(submitterHitPointsOf({ left: 100, top: 790, right: 200, bottom: 900 }, VIEWPORT)).toEqual([]);
    expect(submitterHitPointsOf({ left: 100, top: 100, right: 100, bottom: 140 }, VIEWPORT)).toEqual([]);
  });
});

describe('L6/L3-1 (decision A1): the hit judgement before a press', () => {
  it('presses at the centre when the topmost element there is the submitter or its descendant', () => {
    expect(submitterHitJudgementOf([[150, 220, 'TARGET'], [104, 204, 'OTHER']])).toEqual({ kind: 'REACHABLE', point: [150, 220] });
    expect(submitterHitJudgementOf([[150, 220, 'DESCENDANT']])).toEqual({ kind: 'REACHABLE', point: [150, 220] });
  });

  it('presses at the first reachable corner when only the centre is covered', () => {
    expect(submitterHitJudgementOf([[150, 220, 'OTHER'], [104, 204, 'OTHER'], [196, 204, 'TARGET'], [104, 236, 'TARGET']]))
      .toEqual({ kind: 'REACHABLE', point: [196, 204] });
  });

  it('does not press when every point is covered (behind a modal dialog, covered, or not taking pointer events)', () => {
    expect(submitterHitJudgementOf([[150, 220, 'OTHER'], [104, 204, 'NONE'], [196, 204, 'OTHER'], [104, 236, 'OTHER'], [196, 236, 'OTHER']]))
      .toEqual({ kind: 'COVERED' });
  });

  it('leaves the press to the browser when there is no point (the centre is outside the viewport; the press scrolls it into view first)', () => {
    expect(submitterHitJudgementOf([])).toEqual({ kind: 'UNKNOWN' });
  });

  it('records the covered submitter as not pressed, with a plain label', () => {
    expect(COVERED_BY_OTHER_PROBE_REASON).toBe('COVERED_BY_OTHER');
    expect(SUBMISSION_PROBE_NOT_OBSERVED_REASONS).toContain('COVERED_BY_OTHER');
    expect(SUBMISSION_PROBE_NOT_PRESSED_REASONS).toContain('COVERED_BY_OTHER');
    expect(SUBMISSION_PROBE_REASON_CATALOG.COVERED_BY_OTHER.label).toBe('ほかの表示に覆われていたので、押せませんでした');
  });
});

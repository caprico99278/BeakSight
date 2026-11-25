// EV-2（設計書 `doc/design/2026-11-16-beaksight-finding-evidence-design.md` 3.2）: 対象まで動かして撮る部品の、ブラウザを使わない決め方。
// - 画像に入ったか（全部・一部・入らない）と、分けて撮る部分（終わりは部分の数という構造の事実）。
// - 固定の枠の覆いの区分（末尾でも隠れる・スクロールで避けられる・初めの位置だけ）。
import { describe, expect, it } from 'vitest';
import { occlusionRevealOutcomeOf } from '../../src/audit/fixed-overlap-classes.js';
import type { RevealedTargetEvidence } from '../../src/core/evidence-types.js';
import { combinedInclusion, inclusionOfVisiblePart, isShownInPlace, vanishedByMove } from '../../src/core/target-image-inclusion.js';
import { revealSegmentsOf } from '../../src/evidence/reveal-and-capture.js';

const rect = (left: number, top: number, width: number, height: number) => ({ x: left, y: top, top, left, width, height, right: left + width, bottom: top + height });

describe('EV-2: whether the target is in the image, and the parts of a large target', () => {
  it('decides inside, partial and outside from the visible part', () => {
    expect(inclusionOfVisiblePart(rect(10, 10, 50, 50), rect(10, 10, 50, 50))).toBe('INSIDE');
    expect(inclusionOfVisiblePart(rect(10, 10, 50, 50), rect(10, 10, 50, 20))).toBe('PARTIAL');
    expect(inclusionOfVisiblePart(rect(10, 10, 50, 50), null)).toBe('OUTSIDE');
    // DEF-286: 引き直した要素が大きさのない（隠れた）要素なら、写ったとしない。
    expect(inclusionOfVisiblePart(rect(10, 10, 0, 0), rect(10, 10, 0, 0), { hitTestPointCount: 0, hitPointCount: 0 })).toBe('OUTSIDE');
    expect(combinedInclusion(['INSIDE', 'INSIDE'])).toBe('INSIDE');
    expect(combinedInclusion(['INSIDE', 'OUTSIDE'])).toBe('PARTIAL');
  });

  it('splits a target larger than the box into parts that cover the whole target', () => {
    expect(revealSegmentsOf(rect(0, 0, 100, 100), 400, 300)).toEqual([null]);
    expect(revealSegmentsOf(rect(0, 0, 100, 700), 400, 300)).toEqual([
      { x: 0, y: 0, width: 100, height: 300 }, { x: 0, y: 300, width: 100, height: 300 }, { x: 0, y: 600, width: 100, height: 100 },
    ]);
  });
});

// TII（DEF-285）: 画面の中で見えている対象は動かさずに撮る。動かして交わりが消えたら、元の位置で撮る。
describe('TII: whether to take the target where it is', () => {
  it('keeps a target shown on the screen where it is, and goes back when moving makes the overlap vanish', () => {
    const shown = { found: true, rect: rect(10, 10, 30, 30), visibleRect: rect(10, 10, 30, 30), hitTestPointCount: 5, hitPointCount: 2 };
    expect(isShownInPlace(shown)).toBe(true);
    // 隠れている・一部が切られている・大きさのない対象は、今どおり動かす。
    expect(isShownInPlace({ ...shown, hitPointCount: 0 })).toBe(false);
    expect(isShownInPlace({ ...shown, visibleRect: rect(10, 10, 30, 10) })).toBe(false);
    expect(isShownInPlace({ ...shown, rect: rect(10, 10, 0, 30), visibleRect: rect(10, 10, 0, 30), hitTestPointCount: 0, hitPointCount: 0 })).toBe(false);
    expect(vanishedByMove(rect(10, 10, 30, 30), rect(40, 10, 0, 30))).toBe(true);
    expect(vanishedByMove(rect(10, 10, 30, 30), rect(40, 10, 30, 30))).toBe(false);
    expect(vanishedByMove(rect(10, 10, 0, 30), rect(40, 10, 0, 30))).toBe(false);
  });
});

describe('EV-2: the cover measured after moving', () => {
  const measured = (position: 'TARGET' | 'ONE_SCREEN' | 'END', facts: { covered: number; hit: number; overlay: boolean }): RevealedTargetEvidence => ({
    purpose: 'FIXED_ELEMENT_OCCLUSION', selectors: ['#h'], overlaySelector: '#f', position, found: true,
    scroll: { document: { before: { scrollX: 0, scrollY: 0 }, after: { scrollX: 0, scrollY: 0 } }, ancestors: [] },
    rect: rect(0, 0, 10, 10), elementRects: [rect(0, 0, 10, 10)], lineRectCounts: [1], visibleRect: rect(0, 0, 10, 10),
    hitTestPointCount: 5, hitPointCount: facts.hit, coveredPointCount: facts.covered, overlayPresent: facts.overlay, inclusion: 'INSIDE',
  });
  it('separates the cover hidden even at the end, the cover avoidable by scrolling, and the cover only at the first position', () => {
    const covered = { covered: 5, hit: 0, overlay: true };
    expect(occlusionRevealOutcomeOf(measured('TARGET', covered), measured('ONE_SCREEN', covered), measured('END', covered))).toBe('HIDDEN_AT_END');
    // 動かした位置で覆われなければ、1 画面分・末尾の位置は測らない。
    expect(occlusionRevealOutcomeOf(measured('TARGET', { covered: 0, hit: 5, overlay: true }), undefined, undefined)).toBe('SCROLL_AVOIDABLE');
    // 1 画面分動かして覆う部品が消え、対象が見えれば、末尾までは動かさない。
    expect(occlusionRevealOutcomeOf(measured('TARGET', covered), measured('ONE_SCREEN', { covered: 0, hit: 5, overlay: false }), undefined)).toBe('INITIAL_ONLY');
    // REV-EV3 の M-1: 覆う部品が消えた位置で対象が見えなければ、初めの位置だけにせず、末尾で決める。
    const goneUnseen = { covered: 0, hit: 0, overlay: false };
    expect(occlusionRevealOutcomeOf(measured('TARGET', covered), measured('ONE_SCREEN', goneUnseen), measured('END', goneUnseen))).toBe('HIDDEN_AT_END');
    expect(occlusionRevealOutcomeOf(measured('TARGET', covered), measured('ONE_SCREEN', covered), undefined)).toBeNull();
  });
});

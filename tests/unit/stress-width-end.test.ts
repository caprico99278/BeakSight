// 幅の走査の 1 つの幅の終わり方（ブラウザを使わない）。
// - B（C18i）: 幅の結果が `PAGE_CLOSED` で、違反が記録されていれば、その幅の理由は `SAFETY_VIOLATION_ABORT`（Guard が違反で Context を閉じた）。
// - C: 幅の page が外部スキームへ移ろうとした記録が入るか、文書が誤りの画面（`chrome-error://`）に替わった・閉じたら、その幅を終えて次へ進む（発見の側の
//   `documentGoneOf` と同じ考え方。Playwright の 1 手には期限を付けない）。
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { FocusCheckEvidence, LayoutEvidence } from '../../src/core/evidence-types.js';
import {
  auditDocumentLeftCause,
  sameStressLayoutFacts,
  stressLayoutFactKeys,
  stressWidthIncompleteReasonOf,
  stressWidthSessionCloser,
} from '../../src/orchestration/stress-width-end.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';

const pageAt = (url: string, closed = false): Page => ({ isClosed: () => closed, url: () => url, mainFrame: () => ({ url: () => url }) }) as unknown as Page;

describe('the end of a stress width', () => {
  it('names a closed width SAFETY_VIOLATION_ABORT only when a violation is recorded (B)', () => {
    expect(stressWidthIncompleteReasonOf('PAGE_CLOSED', true)).toBe('SAFETY_VIOLATION_ABORT');
    expect(stressWidthIncompleteReasonOf('PAGE_CLOSED', false)).toBe('PAGE_CLOSED');
    expect(stressWidthIncompleteReasonOf('NAVIGATION_FAILED', true)).toBe('NAVIGATION_FAILED');
  });

  // DEF-247: 幅を早く終えるときも、その幅の session の閉じる口（factory が持ち主として Context ごと閉じる）を使う。page だけを閉じると、Guard が印のない
  // session の切れを違反にする。早く終える所と、collector の後片付けの両方から呼んでも、閉じるのは 1 回だけ（session の 2 回目の close は reject する）。
  it('closes the width session once, however many times the early end and the cleanup ask (DEF-247)', async () => {
    let closes = 0;
    const close = stressWidthSessionCloser(async () => {
      closes += 1;
    });
    await Promise.all([close(), close()]);
    await close();
    expect(closes).toBe(1);
  });

  // C と DEF-250 の c（幅の走査と Passive の page の共通の判定）: main frame の外部スキームへの移動の記録が入るか、読み込んだ後に文書が消えたら、その原因を返す。
  it('tells why the page cannot be used: a main frame move to an external scheme, or a gone document (C, DEF-250 c)', () => {
    const external = new SafetyLedger();
    external.recordExternalSchemeNavigation({ url: 'mailto:a@example.test', scheme: 'mailto', frame: 'MAIN', phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_NAVIGATION' });
    const subFrame = new SafetyLedger();
    subFrame.recordExternalSchemeNavigation({ url: 'tel:0000', scheme: 'tel', frame: 'SUB', phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_NAVIGATION' });
    const clean = new SafetyLedger().snapshot();
    // 外部スキームの記録は、読み込みの前でも見る。子の frame の記録では、page は使える。
    expect(auditDocumentLeftCause(pageAt('about:blank'), [external.snapshot()], false)).toBe('EXTERNAL_SCHEME');
    expect(auditDocumentLeftCause(pageAt('https://example.test/'), [subFrame.snapshot()], true)).toBeNull();
    expect(auditDocumentLeftCause(pageAt('chrome-error://chromewebdata/'), [clean], true)).toBe('DOCUMENT_GONE');
    expect(auditDocumentLeftCause(pageAt('https://example.test/', true), [clean], true)).toBe('DOCUMENT_GONE');
    expect(auditDocumentLeftCause(pageAt('https://example.test/'), [clean], true)).toBeNull();
    // 読み込む前の page（`about:blank`）は、文書が消えたとみなさない。
    expect(auditDocumentLeftCause(pageAt('about:blank'), [clean], false)).toBeNull();
  });
});

// SWR（設計者の判断 2026-11-17 の 1）: 大きさを変えて測った幅と、読み込み直して測った幅の照らし合わせは、指摘になりうる事実の鍵の集合で比べる（位置の違いは見ない）。
describe('the layout facts of a stress width to compare a resized page with a loaded page', () => {
  const element = (selector: string, x = 0): unknown => ({ selector, rect: { x } });
  const layoutWith = (facts: Partial<Record<string, unknown>>): LayoutEvidence => ({
    document: { horizontalOverflowPx: 0 },
    boxesOutsideViewport: [],
    clippedText: [],
    fixedHeadingOverlaps: [],
    elementOverlaps: [],
    fixedElements: [],
    ...facts,
  }) as unknown as LayoutEvidence;
  const focusWith = (items: readonly { readonly selector: string; readonly visibleAfterFocus: boolean; readonly hitAfterFocus: boolean }[]): FocusCheckEvidence =>
    ({ items }) as unknown as FocusCheckEvidence;

  it('names the overflow, the elements outside, the overlaps, the fixed frames, the clipped text and the hidden focus', () => {
    const facts = stressLayoutFactKeys(layoutWith({
      document: { horizontalOverflowPx: 12 },
      boxesOutsideViewport: [element('#wide')],
      elementOverlaps: [{ first: element('#a'), second: element('#b') }],
      fixedHeadingOverlaps: [{ overlaySelector: '#bar', headingSelector: 'h2' }],
      fixedElements: [{ selector: '#banner', viewportIntersectionArea: 100, visibility: { visible: true } }],
      clippedText: [element('#clip')],
    }), focusWith([{ selector: '#hidden', visibleAfterFocus: false, hitAfterFocus: false }, { selector: '#shown', visibleAfterFocus: true, hitAfterFocus: true }]));
    expect([...facts].sort()).toEqual([
      'CLIPPED_TEXT #clip', 'DOCUMENT_OVERFLOW', 'ELEMENT_OVERLAP #a #b', 'FIXED_ELEMENT #banner', 'FIXED_HEADING_OVERLAP #bar h2',
      'FOCUS_HIDDEN #hidden', 'OUTSIDE_VIEWPORT #wide',
    ]);
  });

  it('is the same for the same facts at other positions, and differs when a fact appears', () => {
    const at = (x: number): LayoutEvidence => layoutWith({ boxesOutsideViewport: [element('#wide', x)] });
    expect(sameStressLayoutFacts({ layout: at(0), focus: null }, { layout: at(30), focus: null })).toBe(true);
    expect(sameStressLayoutFacts({ layout: at(0), focus: null }, { layout: layoutWith({ document: { horizontalOverflowPx: 5 } }), focus: null })).toBe(false);
  });
});

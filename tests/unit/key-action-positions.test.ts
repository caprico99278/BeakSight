// BS-2（設計書 `doc/design/2026-11-20-beaksight-key-action-positions-design.md`）: 主要な行動の候補の位置の事実（表示用モデルで 1 回だけ集計）と、固定の表示の
// 覆いの指摘との結び付け。値は作り物。ブラウザを使わない。
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { EvidenceRecord, PageId } from '../../src/core/contracts.js';
import type { KeyActionElementEvidence, LayoutEvidence, ScrollEvidence } from '../../src/core/evidence-types.js';
import { createPageId } from '../../src/core/ids.js';
import { keyActionKindOf } from '../../src/core/key-actions.js';
import { CHATGPT_BUNDLE_GUIDE_TEXT, KEY_ACTION_TEXT } from '../../src/presentation/messages.js';
import { CHATGPT_BUNDLE_FILE_NAMES, createChatGptBundle } from '../../src/report/chatgpt-bundle.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { auditRun, finding, idOf, page, record } from '../helpers/audit-run-fixture.js';

const WIDTH = 400;
const HEIGHT = 800;
const PAGE_HEIGHT = 4000;
const PHONE_NUMBER = '0120-000-000';
const rect = (left: number, top: number, width: number, height: number) => ({ x: left, y: top, top, left, width, height, right: left + width, bottom: top + height });
const visible = { visible: true, display: 'block', visibility: 'visible', opacity: 1, hiddenAttribute: false, ariaHidden: false, clientRectCount: 1 };

const action = (selector: string, top: number, overrides: Partial<KeyActionElementEvidence>): KeyActionElementEvidence => ({
  selector, tagName: 'a', role: null, text: '', ariaLabel: null, title: null, hrefScheme: 'https', hrefHost: '127.0.0.1',
  rect: rect(0, top, 100, 40), visible: true, fixedContainerSelector: null, ...overrides,
});

/** 下の固定の帯（電話・メッセージ・予約）と、本文の下の方の問い合わせのリンク。帯は本文の段落を覆う。 */
const BAR_ACTIONS: readonly KeyActionElementEvidence[] = [
  action('#bar > a:nth-of-type(1)', 740, { text: `電話 ${PHONE_NUMBER}`, hrefScheme: 'tel', hrefHost: null, fixedContainerSelector: '#bar' }),
  action('#bar > a:nth-of-type(2)', 740, { text: 'メッセージで聞く', hrefHost: 'line.me', fixedContainerSelector: '#bar' }),
  action('#bar > button', 740, { tagName: 'button', text: '予約', hrefScheme: null, hrefHost: null, fixedContainerSelector: '#bar' }),
  action('#footer-contact', 3500, { text: 'お問い合わせ' }),
];

const layoutOf = (actions: readonly KeyActionElementEvidence[]): LayoutEvidence => {
  const element = (selector: string, box: ReturnType<typeof rect>, position: string) => ({
    selector, kind: 'other' as const, rect: box, area: box.width * box.height, visibility: visible, position, zIndex: position === 'fixed' ? '10' : 'auto',
    overflowX: 'visible', overflowY: 'visible', fixedOrStickyAncestor: false,
  });
  return {
    scrollPosition: { scrollX: 0, scrollY: 0 },
    document: {
      viewportWidth: WIDTH, viewportHeight: HEIGHT, documentElementClientWidth: WIDTH, documentElementClientHeight: HEIGHT,
      documentElementScrollWidth: WIDTH, documentElementScrollHeight: PAGE_HEIGHT, bodyScrollWidth: WIDTH, bodyScrollHeight: PAGE_HEIGHT,
      bodyClientWidth: WIDTH, bodyClientHeight: HEIGHT, horizontalOverflowPx: 0, viewportHorizontalClip: 'NONE',
    },
    boxesOutsideViewport: [], zeroSizeInteractive: [], clippedText: [], fixedHeadingOverlaps: [], fixedElements: [],
    elementOverlaps: actions.length === 0 ? [] : [{
      first: element('#lead', rect(0, 720, WIDTH, 60), 'static'),
      second: element('#bar', rect(0, 720, WIDTH, 80), 'fixed'),
      intersection: { ...rect(0, 720, WIDTH, 60), area: WIDTH * 60 },
      truncated: false,
    }],
    truncation: {
      omittedOutsideViewportCount: 0, omittedZeroSizeInteractiveCount: 0, omittedClippedTextCount: 0, omittedFixedHeadingOverlapCount: 0,
      omittedElementOverlapCount: 0, omittedFixedElementCount: 0, overlapComparisonLimitReached: false, clippedTextNodeScanLimitReachedCount: 0,
      renderedDescendantScanLimitReachedCount: 0,
    },
    keyActionElements: actions,
  };
};

const pageOf = (
  number: number,
  actions: readonly KeyActionElementEvidence[],
  options: { readonly path?: string; readonly layout?: (base: LayoutEvidence) => LayoutEvidence; readonly scroll?: ScrollEvidence } = {},
) => {
  const pageId: PageId = createPageId(number);
  const base = layoutOf(actions);
  const layout: EvidenceRecord = record('layout', number * 10, pageId, 'desktop', {
    primary: { status: 'COMPLETE', layout: options.layout?.(base) ?? base }, stressSweep: null,
  });
  const scroll: readonly EvidenceRecord[] = options.scroll === undefined ? [] : [record('scroll', number * 10 + 2, pageId, 'desktop', options.scroll)];
  const findings = actions.length === 0 ? [] : [finding(number * 10 + 1, 'WARN', 'LAYOUT', pageId, [idOf(layout)], {
    ruleId: 'FIXED_ELEMENT_OCCLUSION', groupingKeys: [{ name: 'overlaySelector', value: '#bar' }],
  })];
  return page(pageId, options.path ?? `/p${number}.html`, 'AUDITED', [layout, ...scroll], findings);
};

/** AUDR2: 文書がスクロールしない（文書の高さが表示の高さと同じ）layout と、内側の入れ物 `#scroller`（左 160px から）の位置の印。 */
const SCROLLER_TOP = 0;
const SCROLLER_HEIGHT = 3200;
const unscrolledDocument = (base: LayoutEvidence, withScroller: boolean): LayoutEvidence => ({
  ...base,
  document: { ...base.document, documentElementScrollHeight: HEIGHT, bodyScrollHeight: HEIGHT },
  ...(withScroller
    ? {
      stateMark: {
        documentScroll: { scrollX: 0, scrollY: 0 }, structureDigest: '1:00000000',
        scrollBoxes: [{ selector: '#scroller', scrollLeft: 0, scrollTop: 0, clientRect: rect(160, SCROLLER_TOP, WIDTH - 160, HEIGHT) }],
      },
    }
    : {}),
});
/** AUDR2: 内側の入れ物 `#scroller` をたどった scroll の記録（文書は動かない）。 */
const INNER_SCROLL: ScrollEvidence = {
  status: 'COMPLETE', reason: 'BOTTOM_AND_HEIGHT_STABLE', heightGrowthCount: 0, observations: [], omittedObservationCount: 0, targetSwitchCount: 0,
  restoration: { status: 'RESTORED', position: { scrollX: 0, scrollY: 0 } },
  innerScrollScan: { scannedElementCount: 10, scanLimitReached: false, containerCount: 1, representative: { clientHeight: HEIGHT, scrollHeight: SCROLLER_HEIGHT } },
  innerScrollContainers: [{
    selector: '#scroller', originTop: 0, clientHeight: HEIGHT, initialScrollHeight: SCROLLER_HEIGHT, finalScrollHeight: SCROLLER_HEIGHT, maxScrollTop: SCROLLER_HEIGHT - HEIGHT,
    reachedBottom: true, stepCount: 3, heightGrowthCount: 0, stopReason: 'BOTTOM_AND_HEIGHT_STABLE', restored: true,
  }],
  finalSnapshot: {
    observedAtMs: 0, scrollTarget: 'SCROLLING_ELEMENT', scrollY: 0, viewportHeight: HEIGHT, scrollHeight: HEIGHT, contentHeight: HEIGHT, documentScrollRange: 0,
    bodyScrollRange: 0, heightGrew: false, atBottom: true,
  },
};
/** AUDR2: 横のメニューの問い合わせと、内側の入れ物の中の予約。 */
const SHELL_ACTIONS: readonly KeyActionElementEvidence[] = [
  action('#nav-contact', 100, { text: 'お問い合わせ' }),
  action('#scroller-reserve', 1600, { text: '予約', rect: rect(200, 1600, 100, 40) }),
];

const decoder = new TextDecoder();

describe('BS-2: the positions of the key actions', () => {
  it('takes the kind from the target and the generic words only', () => {
    const facts = { text: '', ariaLabel: null, title: null, hrefScheme: 'https', hrefHost: '127.0.0.1' };
    expect(keyActionKindOf({ ...facts, hrefScheme: 'tel', hrefHost: null })).toBe('PHONE');
    expect(keyActionKindOf({ ...facts, hrefHost: 'line.me' })).toBe('MESSAGE');
    expect(keyActionKindOf({ ...facts, ariaLabel: '来店のご予約' })).toBe('BOOKING');
    expect(keyActionKindOf({ ...facts, text: 'Contact us' })).toBe('CONTACT');
    expect(keyActionKindOf({ ...facts, text: 'Contacts list?' })).toBe('CONTACT');
    expect(keyActionKindOf({ ...facts, text: 'Recontacting' })).toBeNull();
    expect(keyActionKindOf({ ...facts, text: '会社の歴史' })).toBeNull();
  });

  it('records the kind, the first screen, the fixed display and the ratio of the position, without the phone number', async () => {
    const result = auditRun({ pages: [pageOf(1, BAR_ACTIONS)] });
    const model = buildReportViewModel(result);
    const [row] = model.summary.keyActions.pages;
    expect(row?.actions.map(({ kind, inFirstView, fixed, positionRatio }) => [kind, inFirstView, fixed, positionRatio])).toEqual([
      ['PHONE', true, true, null],
      ['MESSAGE', true, true, null],
      ['BOOKING', true, true, null],
      ['CONTACT', false, false, 3500 / PAGE_HEIGHT],
    ]);
    expect(row?.pageHeight).toBe(PAGE_HEIGHT);
    const html = renderHtmlReport(model);
    expect(html).toContain(KEY_ACTION_TEXT.limitNote);
    const entries = unzipSync(await createChatGptBundle(model, result, async () => null));
    const file = decoder.decode(entries[CHATGPT_BUNDLE_FILE_NAMES.keyActions]);
    for (const text of [html, file, decoder.decode(entries['pages/PAGE-000001/findings.json'])]) {
      expect(text).not.toContain(PHONE_NUMBER);
    }
  });

  it('marks the kinds of the cover and that the hindrance to the operation is not checked, and groups the same bar over pages', () => {
    const model = buildReportViewModel(auditRun({ pages: [pageOf(1, BAR_ACTIONS), pageOf(2, BAR_ACTIONS)] }));
    const [first] = model.findings;
    expect(first?.verification.keyActions).toEqual({ overlayKinds: ['PHONE', 'MESSAGE', 'BOOKING'], coveredKinds: [], pressCheck: 'NOT_CHECKED' });
    expect(model.findingGroups.filter(({ ruleId }) => ruleId === 'FIXED_ELEMENT_OCCLUSION').map(({ pageCount }) => pageCount)).toEqual([2]);
  });

  // AUDR2: 文書がスクロールしない画面は、内側の入れ物の高さと、その中の位置で割合を出す。記録がなければ高さは分からないとし、割合を出さない。
  it('takes the height and the positions from the inner scroll container when the document does not scroll, and gives no ratio without its record', () => {
    const model = buildReportViewModel(auditRun({
      pages: [
        pageOf(1, SHELL_ACTIONS, { layout: (base) => unscrolledDocument(base, true), scroll: INNER_SCROLL }),
        pageOf(2, SHELL_ACTIONS, { layout: (base) => unscrolledDocument(base, false) }),
      ],
    }));
    const [inner, unknown] = model.summary.keyActions.pages;
    expect([inner?.pageHeight, inner?.pageHeightBasis, unknown?.pageHeight, unknown?.pageHeightBasis])
      .toEqual([SCROLLER_HEIGHT, 'INNER_SCROLL_CONTAINER', null, 'UNKNOWN']);
    expect(inner?.actions.map(({ inScrollContainer, positionRatio }) => [inScrollContainer, positionRatio])).toEqual([[false, null], [true, 1600 / SCROLLER_HEIGHT]]);
    expect(unknown?.actions.map(({ positionRatio }) => positionRatio)).toEqual([null, null]);
    expect(model.summary.keyActions.summary.pageHeights.desktop).toMatchObject({ pageCount: 1, maxPx: SCROLLER_HEIGHT });
  });

  // AUDR2: データを除いた path の違う 2 つ以上のページに、同じ要素（番号を丸めた selector・名前・種類）として出る候補は、共通の枠の候補として数を分ける。
  it('marks the candidates that the pages of other paths share as the shared frame, and splits the counts of the summary', () => {
    const lead = action('#lead-reserve', 1200, { text: '予約する' });
    const item = action('#item-reserve', 1200, { text: '予約する' });
    const model = buildReportViewModel(auditRun({
      pages: [
        pageOf(1, [...BAR_ACTIONS, lead], { path: '/guide' }),
        pageOf(2, BAR_ACTIONS, { path: '/about' }),
        pageOf(3, [item], { path: '/items/1' }),
        pageOf(4, [item], { path: '/items/2' }),
      ],
    }));
    const [guide] = model.summary.keyActions.pages;
    expect(guide?.actions.map(({ sharedFrame }) => sharedFrame)).toEqual([true, true, true, true, false]);
    const { summary } = model.summary.keyActions;
    expect([summary.pagesWithKindInSharedFrame.BOOKING, summary.pagesWithKindInBody.BOOKING]).toEqual([2, 3]);
    expect([summary.pagesWithKindInSharedFrame.CONTACT, summary.pagesWithKindInBody.CONTACT]).toEqual([2, 0]);
  });

  it('does not say "none" for a page without a candidate, and writes the range of the detection instead', async () => {
    const result = auditRun({ pages: [pageOf(1, [])] });
    const model = buildReportViewModel(result);
    expect(model.summary.keyActions.pages.map(({ actions }) => actions)).toEqual([[]]);
    expect(renderHtmlReport(model)).not.toContain(KEY_ACTION_TEXT.heading);
    const entries = unzipSync(await createChatGptBundle(model, result, async () => null));
    const readme = decoder.decode(entries[CHATGPT_BUNDLE_FILE_NAMES.readme]);
    expect(readme).toContain(KEY_ACTION_TEXT.limitNote);
    expect(readme).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.keyActionsHeading);
  });
});

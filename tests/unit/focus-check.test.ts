// AUD-4d: フォーカスまで隠すリンク（画面の外に置いた、フォーカスできる要素）の判定の表と、表示用モデルの数・バンドルの写し。ブラウザを使わない。
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { FOCUS_CHECK_OUTCOMES, focusCheckLowersConfidence, focusCheckOutcomeOf } from '../../src/audit/focus-check.js';
import { FOCUS_RULES } from '../../src/audit/focus-rules.js';
import { RUN_ARTIFACT_FILE_NAMES, pageArtifactRelativePath } from '../../src/core/artifact-layout.js';
import type { FocusCheckItemEvidence } from '../../src/core/evidence-types.js';
import { createFindingId } from '../../src/core/ids.js';
import { CHATGPT_BUNDLE_GUIDE_TEXT, FOCUSED_CONTROL_HIDDEN_TEXT } from '../../src/presentation/messages.js';
import { createChatGptBundle } from '../../src/report/chatgpt-bundle.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, auditRun, finding, metadata, page, record } from '../helpers/audit-run-fixture.js';

const rect = (left: number, top: number, width: number, height: number) => ({ x: left, y: top, top, left, width, height, right: left + width, bottom: top + height });

const item = (overrides: Partial<FocusCheckItemEvidence> = {}): FocusCheckItemEvidence => ({
  selector: '#skip',
  tagName: 'a',
  beforeRect: rect(-9999, 0, 80, 20),
  focused: true,
  afterRect: rect(8, 8, 80, 20),
  visibleAfterFocus: true,
  hitAfterFocus: true,
  screenshotEvidenceId: null,
  ...overrides,
});

const VIEWPORT = { width: 400, height: 300 };

describe('the table of the focus check', () => {
  it('has the closed list of the outcomes', () => {
    expect(FOCUS_CHECK_OUTCOMES).toEqual(['APPEARS', 'OUTSIDE_VIEWPORT', 'NOT_VISIBLE', 'NOT_HITTABLE', 'NOT_FOCUSED']);
  });

  const cases = [
    { name: 'a skip link that comes into the screen on focus', input: item(), expected: 'APPEARS' },
    { name: 'a link that stays outside the screen on focus', input: item({ afterRect: rect(-9999, 0, 80, 20) }), expected: 'OUTSIDE_VIEWPORT' },
    { name: 'a link with no box on focus', input: item({ afterRect: null }), expected: 'OUTSIDE_VIEWPORT' },
    { name: 'a link that comes in but is not drawn', input: item({ visibleAfterFocus: false }), expected: 'NOT_VISIBLE' },
    { name: 'a link that comes in but another element takes the pointer', input: item({ hitAfterFocus: false }), expected: 'NOT_HITTABLE' },
    { name: 'an element that does not take the focus', input: item({ focused: false }), expected: 'NOT_FOCUSED' },
  ] as const;
  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(focusCheckOutcomeOf(input, VIEWPORT)).toBe(expected);
    });
  }
});

describe('the counts of the focus checks in the report model and the bundle', () => {
  const run = () => auditRun({
    pages: [page(PAGE_1, '/', 'AUDITED', [
      metadata(1, PAGE_1),
      record('focus', 40, PAGE_1, 'desktop', {
        status: 'COMPLETE',
        viewportWidth: VIEWPORT.width,
        viewportHeight: VIEWPORT.height,
        scrollPosition: { scrollX: 0, scrollY: 0 },
        items: [
          item(), item({ selector: '#broken', afterRect: rect(-9999, 0, 80, 20) }), item({ selector: '#plain', focused: false }),
          item({ selector: '#behind', hitAfterFocus: false, frontWindowCovered: true }),
        ],
      }),
    ])],
  });

  it('counts the elements that appear on focus apart from the hidden ones and the ones behind a front window', () => {
    // RVP-1: 前面の窓の背後で指摘にしなかった項目は `NOT_HITTABLE` と分け、Tab の確かめのない指摘の数も出す。
    expect(buildReportViewModel(run()).summary.focusChecks).toEqual({
      checked: 4,
      byOutcome: [
        { outcome: 'APPEARS', count: 1 }, { outcome: 'OUTSIDE_VIEWPORT', count: 1 }, { outcome: 'NOT_FOCUSED', count: 1 },
        { outcome: 'FRONT_WINDOW_COVERED', count: 1 },
      ],
      findingsWithoutSequentialTab: 1,
    });
  });

  it('copies the counts to summary.json, and keeps the codes out of the HTML body', async () => {
    const result = run();
    const model = buildReportViewModel(result);
    expect(renderHtmlReport(model)).not.toContain('OUTSIDE_VIEWPORT');
    const encoder = new TextEncoder();
    const files = new Map<string, Uint8Array>([[RUN_ARTIFACT_FILE_NAMES.run, encoder.encode(JSON.stringify(result.run))]]);
    for (const value of result.pages) {
      files.set(pageArtifactRelativePath(value.pageId, 'page'), encoder.encode(JSON.stringify(value)));
    }
    const entries = unzipSync(await createChatGptBundle(model, result, async (path) => files.get(path) ?? null));
    const summary = JSON.parse(new TextDecoder().decode(entries['summary.json'])) as { readonly focusChecks: unknown };
    expect(summary.focusChecks).toEqual(JSON.parse(JSON.stringify(model.summary.focusChecks)));
    expect(new TextDecoder().decode(entries['README.md'])).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.focusChecksNote);
  });
});

describe('AUD-3: the finding on a guard item of a focus trap', () => {
  // 守りの部品と本物のボタン。指摘は、それぞれの項目の番号で引く。
  const focus = record('focus', 41, PAGE_1, 'desktop', {
    status: 'COMPLETE',
    viewportWidth: VIEWPORT.width,
    viewportHeight: VIEWPORT.height,
    scrollPosition: { scrollX: 0, scrollY: 0 },
    items: [
      item({ selector: 'span', tagName: 'span', afterRect: rect(0, 0, 0, 0), kind: 'GUARD' }),
      item({ selector: '#b', tagName: 'button', afterRect: rect(-9999, 0, 80, 20), kind: 'CONTROL' }),
    ],
  });
  const hidden = (sequence: number, selector: string, focusItem: number) => finding(sequence, 'WARN', 'ACCESSIBILITY', PAGE_1, [focus.evidenceId], {
    ruleId: 'FOCUSED_CONTROL_HIDDEN',
    groupingKeys: [{ name: 'selector', value: selector }, { name: 'focusItem', value: String(focusItem) }],
  });

  it('lowers the confidence only of the finding whose own item is a guard', () => {
    const tabbed = { operation: 'SEQUENTIAL_TAB', reached: false, afterRect: null, visibleAfterFocus: false, hitAfterFocus: false, hitTestPointCount: 0, hitPointCount: 0,
      coveredBySelector: null } as const;
    const checked = record('focus', 41, PAGE_1, 'desktop', {
      ...focus.payload, items: focus.payload.items.map((value) => ({ ...value, sequentialTab: tabbed })),
    });
    const model = buildReportViewModel(auditRun({
      pages: [page(PAGE_1, '/', 'AUDITED', [metadata(1, PAGE_1), checked])], findings: [hidden(1, 'span', 0), hidden(2, '#b', 1)],
    }));
    const confidenceOf = (sequence: number) => model.findingGroups.find((group) => group.findingIds.includes(createFindingId(sequence)))?.confidence;
    expect([confidenceOf(1), confidenceOf(2)]).toEqual(['MEDIUM', 'HIGH']);
  });
});

describe('RVP-1: the findings behind a front window and without the sequential Tab check', () => {
  const tab = (behindFrontWindow: boolean): NonNullable<FocusCheckItemEvidence['sequentialTab']> => ({
    operation: 'SEQUENTIAL_TAB', reached: true, afterRect: rect(8, 8, 80, 20), visibleAfterFocus: true, hitAfterFocus: false, hitTestPointCount: 5,
    hitPointCount: 0, coveredBySelector: '#sheet', ...(behindFrontWindow ? { behindFrontWindow: true as const } : {}),
  });
  const covered = (overrides: Partial<FocusCheckItemEvidence> = {}) => item({ selector: '#behind', hitAfterFocus: false, ...overrides });
  const messagesOf = (items: readonly FocusCheckItemEvidence[]): readonly string[] => FOCUS_RULES.flatMap((rule) => rule.evaluate({
    pageId: PAGE_1, pageUrl: page(PAGE_1, '/').pageUrl, viewport: 'desktop',
    evidence: [record('focus', 42, PAGE_1, 'desktop', { status: 'COMPLETE', viewportWidth: 400, viewportHeight: 300, scrollPosition: { scrollX: 0, scrollY: 0 }, items })],
  })).map(({ message }) => message);

  it('does not report a control covered by an open front window, and still reports one covered by another element', () => {
    expect(messagesOf([covered({ frontWindowCovered: true })])).toEqual([]);
    expect(messagesOf([covered()])).toHaveLength(1);
  });

  it('reports a control behind the front window only when the Tab key moves there with the window open', () => {
    const [behind] = messagesOf([covered({ frontWindowCovered: true, sequentialTab: tab(true) })]);
    expect(behind).toContain(FOCUSED_CONTROL_HIDDEN_TEXT.frontWindowTabNote);
    expect(messagesOf([covered({ frontWindowCovered: true, sequentialTab: tab(false) })])).toEqual([]);
  });

  it('does not say that a control without the Tab check cannot be pressed, and lowers its confidence', () => {
    const [message] = messagesOf([covered()]);
    expect(message).not.toContain('押せません');
    expect(message).toContain(FOCUSED_CONTROL_HIDDEN_TEXT.tabUncheckedNote);
    expect(focusCheckLowersConfidence({ kind: 'CONTROL', sequentialTab: null })).toBe(true);
    expect(focusCheckLowersConfidence({ kind: 'CONTROL', sequentialTab: 'HIDDEN' })).toBe(false);
  });
});

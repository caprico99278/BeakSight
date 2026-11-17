// AUD-4d: フォーカスまで隠すリンク（画面の外に置いた、フォーカスできる要素）の判定の表と、表示用モデルの数・バンドルの写し。ブラウザを使わない。
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { FOCUS_CHECK_OUTCOMES, focusCheckOutcomeOf } from '../../src/audit/focus-check.js';
import { RUN_ARTIFACT_FILE_NAMES, pageArtifactRelativePath } from '../../src/core/artifact-layout.js';
import type { FocusCheckItemEvidence } from '../../src/core/evidence-types.js';
import { CHATGPT_BUNDLE_GUIDE_TEXT } from '../../src/presentation/messages.js';
import { createChatGptBundle } from '../../src/report/chatgpt-bundle.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, auditRun, metadata, page, record } from '../helpers/audit-run-fixture.js';

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
        items: [item(), item({ selector: '#broken', afterRect: rect(-9999, 0, 80, 20) }), item({ selector: '#plain', focused: false })],
      }),
    ])],
  });

  it('counts the elements that appear on focus apart from the hidden ones', () => {
    expect(buildReportViewModel(run()).summary.focusChecks).toEqual({
      checked: 3,
      byOutcome: [{ outcome: 'APPEARS', count: 1 }, { outcome: 'OUTSIDE_VIEWPORT', count: 1 }, { outcome: 'NOT_FOCUSED', count: 1 }],
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

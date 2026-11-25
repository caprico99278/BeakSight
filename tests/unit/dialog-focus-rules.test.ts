// FRET（設計書 `doc/design/2026-11-24-beaksight-dialog-focus-return-design.md` 1.4）: 窓を閉じた後のフォーカスの戻り先の 3 つの指摘と、「押す物なし」の数。
// ブラウザを使わない。
import { describe, expect, it } from 'vitest';
import { FOCUS_RULES } from '../../src/audit/focus-rules.js';
import type { DialogFocusEvidence, DialogFocusItemEvidence } from '../../src/core/evidence-types.js';
import { DIALOG_FOCUS_TEXT } from '../../src/presentation/messages.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, auditRun, metadata, page, record } from '../helpers/audit-run-fixture.js';

const checked = (overrides: Partial<DialogFocusItemEvidence> = {}): DialogFocusItemEvidence => ({
  selector: '#open', name: '開く', keyDigest: 'k', outcome: 'CHECKED', focusMovedIntoWindow: true, closedBy: 'ESCAPE', focusAfterClose: 'TRIGGER',
  focusAfterCloseSelector: null, beforeScreenshotEvidenceId: null, afterScreenshotEvidenceId: null, ...overrides,
});

const focusRecord = (dialogFocus: DialogFocusEvidence) => record('focus', 40, PAGE_1, 'desktop', {
  status: 'COMPLETE', viewportWidth: 400, viewportHeight: 300, scrollPosition: { scrollX: 0, scrollY: 0 }, items: [], dialogFocus,
});

const findingsOf = (items: readonly DialogFocusItemEvidence[]) => FOCUS_RULES.flatMap((rule) => rule.evaluate({
  pageId: PAGE_1, pageUrl: page(PAGE_1, '/').pageUrl, viewport: 'desktop',
  evidence: [focusRecord({ status: 'COMPLETE', pressableCount: items.length, alreadyCheckedCount: 0, items })],
})).map(({ ruleId, message }) => ({ ruleId, message }));

describe('FRET: the findings of the focus after a window closes', () => {
  it('reports nothing when the focus moves into the window and comes back to the button', () => {
    expect(findingsOf([checked(), checked({ outcome: 'NO_WINDOW', focusMovedIntoWindow: null, closedBy: null, focusAfterClose: null })])).toEqual([]);
  });

  it('reports the focus that does not come back while the button stays, and not the one whose button is gone', () => {
    expect(findingsOf([checked({ focusAfterClose: 'BODY' })]).map(({ ruleId }) => ruleId)).toEqual(['DIALOG_FOCUS_NOT_RETURNED']);
    expect(findingsOf([checked({ focusAfterClose: 'OTHER', focusAfterCloseSelector: '#other' })])[0]?.message).toContain('#other');
    expect(findingsOf([checked({ focusAfterClose: 'TRIGGER_GONE' })])).toEqual([]);
  });

  it('reports the focus that does not move into the window, and the window closed only by its close button says so', () => {
    const [moved] = findingsOf([checked({ focusMovedIntoWindow: false, closedBy: 'CLOSE_BUTTON' })]);
    expect(moved?.ruleId).toBe('DIALOG_FOCUS_NOT_MOVED');
    expect(moved?.message).toContain(DIALOG_FOCUS_TEXT.closeButtonOnlyNote);
  });

  it('reports the window that neither Escape nor its close button closes', () => {
    expect(findingsOf([checked({ closedBy: 'NOT_CLOSABLE', focusAfterClose: null })]).map(({ ruleId }) => ruleId)).toEqual(['DIALOG_NOT_CLOSABLE_BY_KEYBOARD']);
  });

  it('counts the screens without a button to press', () => {
    const none = focusRecord({ status: 'COMPLETE', pressableCount: 0, alreadyCheckedCount: 0, items: [] });
    const model = buildReportViewModel(auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [metadata(1, PAGE_1), none])] }));
    expect(model.summary.focusChecks.dialogFocus).toEqual({ screens: 1, screensWithoutPressables: 1, pressed: 0, alreadyChecked: 0 });
  });
});

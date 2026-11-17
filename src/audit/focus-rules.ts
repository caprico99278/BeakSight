/**
 * AUD-4d（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-4d）: フォーカスまで隠す要素の page rule。登録は `RULE_CATALOG`。
 * - `FOCUSED_CONTROL_HIDDEN`（WARN・ACCESSIBILITY）: 画面の外に置いた、フォーカスできる要素が、フォーカスを当てても画面の外・見えない・押せないもの。判定は
 *   `focusCheckOutcomeOf`（`./focus-check.ts`）の 1 か所。フォーカスで正しく現れる要素は、指摘にしない（数はバンドルに出る）。
 * - 指摘は、フォーカスの確かめの Evidence と、フォーカスを当てたままの viewport の画像の Evidence（撮れたとき）を参照する。
 * - 幅の走査の幅の確かめの指摘は、同一性の要素に幅（`stressWidth`）を足す。
 */
import { formatPixels } from '../presentation/format.js';
import { FOCUSED_CONTROL_HIDDEN_TEXT, stressWidthFindingMessageText } from '../presentation/messages.js';
import { focusCheckOutcomeOf, isHiddenFocusCheckOutcome } from './focus-check.js';
import type { AuditRule, FindingDraft } from './rule.js';
import { evidenceOfType } from './rule-helpers.js';

const RULE_ID = 'FOCUSED_CONTROL_HIDDEN';
const RULE_VERSION = 1;

const focusedControlHidden: AuditRule = {
  ruleId: RULE_ID,
  version: RULE_VERSION,
  category: 'ACCESSIBILITY',
  severity: 'WARN',
  plainMessage: FOCUSED_CONTROL_HIDDEN_TEXT.plain,
  evaluate: (input) => evidenceOfType(input, 'focus').flatMap((record): FindingDraft[] => {
    const { payload } = record;
    const viewport = { width: payload.viewportWidth, height: payload.viewportHeight };
    return payload.items.flatMap((item): FindingDraft[] => {
      const outcome = focusCheckOutcomeOf(item, viewport);
      if (!isHiddenFocusCheckOutcome(outcome)) {
        return [];
      }
      const width = payload.stressWidth;
      const message = FOCUSED_CONTROL_HIDDEN_TEXT.message(item.selector, FOCUSED_CONTROL_HIDDEN_TEXT.reasons[outcome]);
      return [{
        ruleId: RULE_ID,
        ruleVersion: RULE_VERSION,
        category: 'ACCESSIBILITY',
        severity: 'WARN',
        // 幅の文の形は、layout の幅の指摘と同じ 1 か所（`stressWidthFindingMessageText`）。
        message: width === undefined ? message : stressWidthFindingMessageText(formatPixels(width), message),
        evidenceRefs: item.screenshotEvidenceId === null ? [record.evidenceId] : [record.evidenceId, item.screenshotEvidenceId],
        identityFields: [
          { name: 'selector', value: item.selector },
          ...(width === undefined ? [] : [{ name: 'stressWidth', value: String(width) }]),
        ],
      }];
    });
  }),
};

/** フォーカスまで隠す要素の page rule の一覧。 */
export const FOCUS_RULES: readonly AuditRule[] = Object.freeze([focusedControlHidden]);

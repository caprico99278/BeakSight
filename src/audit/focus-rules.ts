/**
 * AUD-4d（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-4d）: フォーカスまで隠す要素の page rule。登録は `RULE_CATALOG`。
 * - `FOCUSED_CONTROL_HIDDEN`（WARN・ACCESSIBILITY）: 画面の外に置いた、フォーカスできる要素が、フォーカスを当てても画面の外・見えない・押せないもの。判定は
 *   `focusCheckOutcomeOf`（`./focus-check.ts`）の 1 か所。フォーカスで正しく現れる要素は、指摘にしない（数はバンドルに出る）。
 * - 指摘は、フォーカスの確かめの Evidence と、フォーカスを当てたままの viewport の画像の Evidence（撮れたとき）を参照する。
 * - 幅の走査の幅の確かめの指摘は、同一性の要素に幅（`stressWidth`）を足す。
 * - AUD-3: 結びの鍵に項目の番号（`focusItem`。fingerprint と候補群の鍵には入れない）を足し、項目の種別が循環の守り（`GUARD`）の指摘は文を分ける。通常の
 *   Tab で届いて見える・届かない事実も文に足す。
 * - FRET: 窓を開くボタンを押して窓を閉じた後のフォーカスの戻り先の 3 つの Rule（戻らない・窓の中へ移らない・キーボードで閉じられない）。
 */
import { formatPixels } from '../presentation/format.js';
import { DIALOG_FOCUS_TEXT, FOCUSED_CONTROL_HIDDEN_TEXT, stressWidthFindingMessageText } from '../presentation/messages.js';
import type { DialogFocusItemEvidence } from '../core/evidence-types.js';
import { FOCUS_ITEM_LINK_KEY_NAME } from '../core/focus-check-items.js';
import {
  FOCUSED_CONTROL_HIDDEN_RULE_ID, focusCheckOutcomeOf, frontWindowFocusDispositionOf, isHiddenFocusCheckOutcome, sequentialTabOutcomeOf,
} from './focus-check.js';
import type { AuditRule, FindingDraft } from './rule.js';
import { evidenceOfType } from './rule-helpers.js';

const RULE_ID = FOCUSED_CONTROL_HIDDEN_RULE_ID;
/** REV-AUD3 の I-2: 項目の番号を fingerprint に入れないので、fingerprint が前の Run と同じになるよう、版は 1 のまま。 */
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
    return payload.items.flatMap((item, index): FindingDraft[] => {
      const outcome = focusCheckOutcomeOf(item, viewport);
      // RVP-1: 開いた前面の窓が背後を覆う項目は、Tab で背後へ移ったときだけ指摘にする（判定は `frontWindowFocusDispositionOf` の 1 か所）。
      const frontWindow = frontWindowFocusDispositionOf(item, viewport);
      if (!isHiddenFocusCheckOutcome(outcome) || frontWindow === 'EXCLUDED') {
        return [];
      }
      const width = payload.stressWidth;
      // AUD-3: 循環の守りの部品の指摘は、文で分ける（重さは今のまま。確信度は表示用モデルが下げる）。
      // AUD-3（6.2 の 5）: 通常の Tab で届いて見える・届かない事実も文に足す（指摘は残す）。
      // RVP-1: Tab の確かめのない項目は、「押せません」と言い切らず、直の focus の事実と、Tab では確かめていないことを書く。
      const tab = sequentialTabOutcomeOf(item, viewport);
      const base = tab === null && outcome === 'NOT_HITTABLE'
        ? FOCUSED_CONTROL_HIDDEN_TEXT.directNotHittableMessage(item.selector)
        : FOCUSED_CONTROL_HIDDEN_TEXT.message(item.selector, FOCUSED_CONTROL_HIDDEN_TEXT.reasons[outcome]);
      const message = base
        + (item.kind === 'GUARD' ? FOCUSED_CONTROL_HIDDEN_TEXT.guardNote : '')
        + (frontWindow === 'TAB_BEHIND' ? FOCUSED_CONTROL_HIDDEN_TEXT.frontWindowTabNote : '')
        + (tab === 'SHOWN' ? FOCUSED_CONTROL_HIDDEN_TEXT.tabShownNote : tab === 'NOT_REACHED' ? FOCUSED_CONTROL_HIDDEN_TEXT.tabUnreachedNote : '')
        + (tab === null ? FOCUSED_CONTROL_HIDDEN_TEXT.tabUncheckedNote : '');
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
        // AUD-3（6.2 の 3）: 指摘と項目を、項目の番号で 1 対 1 に結ぶ（同じ selector の別の項目を根拠にしない）。REV-AUD3 の I-2: 結びだけに使い、
        // fingerprint と候補群の鍵には入れない。
        linkKeys: [{ name: FOCUS_ITEM_LINK_KEY_NAME, value: String(index) }],
      }];
    });
  }),
};

/**
 * FRET（設計書 `2026-11-24-beaksight-dialog-focus-return-design.md` 1.4）: 窓を開くボタンの確かめの記録（`focus` の Evidence の `dialogFocus`）の項目ごとの指摘の
 * 下書き。`judge` が文を返した項目だけ指摘にする（重さは WARN。参照は記録と、押す前と閉じた後の画像）。
 */
const dialogFocusRule = (
  ruleId: string,
  plainMessage: string,
  judge: (item: DialogFocusItemEvidence) => string | null,
): AuditRule => ({
  ruleId,
  version: 1,
  category: 'ACCESSIBILITY',
  severity: 'WARN',
  plainMessage,
  evaluate: (input) => evidenceOfType(input, 'focus').flatMap((record) => (record.payload.dialogFocus?.items ?? []).flatMap((item): FindingDraft[] => {
    const message = item.outcome === 'CHECKED' ? judge(item) : null;
    if (message === null) {
      return [];
    }
    return [{
      ruleId,
      ruleVersion: 1,
      category: 'ACCESSIBILITY',
      severity: 'WARN',
      // 閉じるボタンでは閉じたが Esc では閉じない窓は、文に事実を足す（指摘にはしない）。
      message: message + (item.closedBy === 'CLOSE_BUTTON' ? DIALOG_FOCUS_TEXT.closeButtonOnlyNote : ''),
      evidenceRefs: [record.evidenceId, ...[item.beforeScreenshotEvidenceId, item.afterScreenshotEvidenceId].filter((id) => id !== null)],
      identityFields: [{ name: 'selector', value: item.selector }],
    }];
  })),
});

/** FRET: 閉じた後、押す物が残っているのに、フォーカスが押す物に戻らない。 */
const dialogFocusNotReturned = dialogFocusRule('DIALOG_FOCUS_NOT_RETURNED', DIALOG_FOCUS_TEXT.notReturnedPlain, (item) => {
  if (item.focusAfterClose === 'BODY') return DIALOG_FOCUS_TEXT.notReturnedMessage(item.selector, DIALOG_FOCUS_TEXT.bodyDestination);
  if (item.focusAfterClose === 'OTHER') return DIALOG_FOCUS_TEXT.notReturnedMessage(item.selector, DIALOG_FOCUS_TEXT.otherDestination(item.focusAfterCloseSelector ?? ''));
  return null;
});

/** FRET: 窓が出たのに、フォーカスが窓の中へ移らない。 */
const dialogFocusNotMoved = dialogFocusRule('DIALOG_FOCUS_NOT_MOVED', DIALOG_FOCUS_TEXT.notMovedPlain, (item) =>
  (item.focusMovedIntoWindow === false ? DIALOG_FOCUS_TEXT.notMovedMessage(item.selector) : null));

/** FRET: Esc でも閉じるボタンでも閉じられない。 */
const dialogNotClosableByKeyboard = dialogFocusRule('DIALOG_NOT_CLOSABLE_BY_KEYBOARD', DIALOG_FOCUS_TEXT.notClosablePlain, (item) =>
  (item.closedBy === 'NOT_CLOSABLE' ? DIALOG_FOCUS_TEXT.notClosableMessage(item.selector) : null));

/** フォーカスまで隠す要素と、窓を閉じた後のフォーカスの戻り先の page rule の一覧。 */
export const FOCUS_RULES: readonly AuditRule[] = Object.freeze([focusedControlHidden, dialogFocusNotReturned, dialogFocusNotMoved, dialogNotClosableByKeyboard]);

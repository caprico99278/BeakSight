/**
 * T44c（Task 44 の設計書 P1-4。設計者の判断）: 監査のジョブの詳細の、ページの未完了の理由ごとのページ数（`run.json` の `pageIncompleteReasonCounts`。持つときだけ）。
 * 理由の説明は表示カタログ（`INCOMPLETE_REASON_DESCRIPTIONS`）、次にできることは `nextStepOfIncompleteReason`（レポートと同じ文）、文言は
 * `LOCAL_UI_PAGE_INCOMPLETE_REASON_TEXT`。数と理由のコードだけを出す（URL・値は持たない）。Run の終わり方の理由の欄とは別の部品にする。
 */
import type { PageIncompleteReasonCount } from '../../../../src/core/contracts.js';
import { formatCount } from '../../../../src/presentation/format.js';
import {
  INCOMPLETE_REASON_DESCRIPTIONS,
  LOCAL_UI_PAGE_INCOMPLETE_REASON_TEXT,
  nextStepOfIncompleteReason,
} from '../../../../src/presentation/messages.js';

const text = LOCAL_UI_PAGE_INCOMPLETE_REASON_TEXT;

/** 理由ごとのページ数の欄（記録がなければ何も出さない）。 */
export function PageIncompleteReasons({ counts }: Readonly<{ counts: readonly PageIncompleteReasonCount[] | null }>) {
  if (counts === null || counts.length === 0) {
    return null;
  }
  return (
    <section className="panel" data-testid="job-page-incomplete-reasons">
      <h2 className="panel-heading">{text.heading}</h2>
      <p className="muted">{text.body}</p>
      <div className="table-wrap">
        <table data-testid="job-page-incomplete-reason-list">
          <caption>{text.tableCaption}</caption>
          <thead>
            <tr>
              <th scope="col">{text.columns.reason}</th>
              <th scope="col">{text.columns.pages}</th>
              <th scope="col">{text.columns.nextStep}</th>
            </tr>
          </thead>
          <tbody>
            {counts.map(({ code, pages }) => (
              <tr key={code} data-code={code}>
                <td className="cell-break">
                  {INCOMPLETE_REASON_DESCRIPTIONS[code]} <code>{code}</code>
                </td>
                <td>{formatCount(pages)}</td>
                {/* T44h の判断 (1): どの理由にも、次にできること（レポートと同じ文）がある。 */}
                <td className="cell-break">{nextStepOfIncompleteReason(code)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

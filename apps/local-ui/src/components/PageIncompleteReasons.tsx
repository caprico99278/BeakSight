/**
 * T44c（Task 44 の設計書 P1-4。設計者の判断）: 監査のジョブの詳細の、ページの未完了の理由ごとのページ数（`run.json` の `pageIncompleteReasonCounts`。持つときだけ）。
 * 理由の説明は `describeIncompleteReasonOf`、次にできることは `nextStepOfIncompleteReasonOf`（レポートと同じ文）、文言は `LOCAL_UI_PAGE_INCOMPLETE_REASON_TEXT`。
 * Run の終わり方の理由の欄とは別の部品にする。
 * PIR: 点検の範囲の外へ移った読み込みの失敗は、別の行と別の文（`detail` が鍵）。各行に、そのページのアドレスの全部を、たたんだ欄に文字で出す（リンクにしない。
 * アドレスを持たない前の書き手の Run には出さない）。
 */
import type { PageIncompleteReasonCount } from '../../../../src/core/contracts.js';
import { formatCount } from '../../../../src/presentation/format.js';
import {
  LOCAL_UI_PAGE_INCOMPLETE_REASON_TEXT,
  describeIncompleteReasonOf,
  nextStepOfIncompleteReasonOf,
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
            {counts.map((count) => (
              <tr key={`${count.code}:${count.detail ?? ''}`} data-code={count.code}>
                <td className="cell-break">{describeIncompleteReasonOf(count)}</td>
                <td>
                  {formatCount(count.pages)}
                  {count.pageUrls === undefined ? null : (
                    <details data-testid="job-page-incomplete-reason-urls">
                      <summary>{text.pageUrls}</summary>
                      <ul>
                        {count.pageUrls.map((url) => <li key={url} className="cell-break">{url}</li>)}
                      </ul>
                    </details>
                  )}
                </td>
                {/* T44h の判断 (1): どの理由にも、次にできること（レポートと同じ文）がある。 */}
                <td className="cell-break">{nextStepOfIncompleteReasonOf(count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

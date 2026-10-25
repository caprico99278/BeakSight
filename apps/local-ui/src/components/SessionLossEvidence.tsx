/**
 * ジョブの詳細の、セッションが切れたと判定した読み込みの記録（DEF-138。設計書 `2026-10-19-beaksight-session-loss-evidence-design.md` 2.2）。「止まったページの
 * URL」の近くに、頼んだページ・行き着いた先・読み込みの経路・止めた要求・読み込みの前と後のログインの状態の名前の違いを出す。記録は path と query の名前と
 * 数だけで、値（token、Cookie の値、query の値）を持たない（ジョブの記録の写しをそのまま出す。リンクにしない）。文言はカタログ
 * （`LOCAL_UI_AUTH_TEXT.job.sessionLoss`、`SESSION_LOSS_BLOCKED_REQUEST_REASON_DESCRIPTIONS`）。
 */
import type { SessionLossEvidence as SessionLossEvidenceRecord } from '../../../../src/core/evidence-types.js';
import { formatCount, formatTimes } from '../../../../src/presentation/format.js';
import { LOCAL_UI_AUTH_TEXT, SESSION_LOSS_BLOCKED_REQUEST_REASON_DESCRIPTIONS } from '../../../../src/presentation/messages.js';

const text = LOCAL_UI_AUTH_TEXT.job.sessionLoss;

/** path の表記（なければ「なし」）。 */
function PathText({ path, testId }: Readonly<{ path: string | null; testId: string }>) {
  return path === null ? <span className="muted" data-testid={testId}>{text.none}</span> : <code data-testid={testId}>{path}</code>;
}

/** セッションの切れの記録（記録がなければ何も出さない）。 */
export function SessionLossEvidence({ evidence }: Readonly<{ evidence: SessionLossEvidenceRecord | null }>) {
  if (evidence === null) {
    return null;
  }
  const { redirectPaths, blockedRequests, storageKeyChange } = evidence;
  return (
    <div data-testid="job-session-loss">
      <h3>{text.heading}</h3>
      <p className="muted">{text.note}</p>
      <dl className="facts">
        {evidence.stage === null ? null : (
          <>
            <dt>{text.stage}</dt>
            <dd><code data-testid="job-session-loss-stage">{evidence.stage}</code></dd>
          </>
        )}
        <dt>{text.requestedPath}</dt>
        <dd className="cell-break"><PathText path={evidence.requestedPath} testId="job-session-loss-requested" /></dd>
        <dt>{text.landedPath}</dt>
        <dd className="cell-break"><PathText path={evidence.landedPath} testId="job-session-loss-landed" /></dd>
        <dt>{text.landedBy}</dt>
        <dd data-testid="job-session-loss-landed-by" data-landed-by={evidence.landedBy}>{text.landedByLabels[evidence.landedBy]}</dd>
      </dl>
      <h4>{text.redirectPaths}</h4>
      {redirectPaths.length === 0 ? <p className="muted">{text.none}</p> : (
        <ol data-testid="job-session-loss-route">
          {redirectPaths.map(({ originKind, path }, index) => (
            // 経路は同じ段が並びうるので、順の番号を鍵にする（並べ替えない）。
            <li key={index} className="cell-break" data-origin-kind={originKind}>
              <code>{path}</code> {text.routeOriginText(text.originKindLabels[originKind])}
            </li>
          ))}
        </ol>
      )}
      {evidence.redirectPathsOmitted === 0 ? null : <p>{text.omittedText(formatCount(evidence.redirectPathsOmitted))}</p>}
      <h4>{text.blockedRequests}</h4>
      {blockedRequests.length === 0 ? <p className="muted">{text.none}</p> : (
        <div className="table-wrap">
          <table data-testid="job-session-loss-blocked">
            <caption>{text.blockedRequests}</caption>
            <thead>
              <tr>
                <th scope="col">{text.blockedColumns.method}</th>
                <th scope="col">{text.blockedColumns.originKind}</th>
                <th scope="col">{text.blockedColumns.path}</th>
                <th scope="col">{text.blockedColumns.reason}</th>
                <th scope="col">{text.blockedColumns.count}</th>
              </tr>
            </thead>
            <tbody>
              {blockedRequests.map((request) => (
                <tr key={JSON.stringify([request.method, request.originKind, request.path, request.reason])} data-reason={request.reason}>
                  <td><code>{request.method}</code></td>
                  <td>{text.originKindLabels[request.originKind]}</td>
                  <td className="cell-break"><code>{request.path}</code></td>
                  <td>{SESSION_LOSS_BLOCKED_REQUEST_REASON_DESCRIPTIONS[request.reason]}</td>
                  <td>{formatTimes(request.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {evidence.blockedRequestsUnlisted === 0 ? null : <p>{text.omittedText(formatCount(evidence.blockedRequestsUnlisted))}</p>}
      <h4>{text.storageKeyChange}</h4>
      {storageKeyChange === null ? <p className="muted" data-testid="job-session-loss-storage-unread">{text.storageUnread}</p> : null}
      {storageKeyChange !== null && storageKeyChange.length === 0 ? <p className="muted" data-testid="job-session-loss-storage-none">{text.noChange}</p> : null}
      {storageKeyChange === null || storageKeyChange.length === 0 ? null : (
        <div className="table-wrap">
          <table data-testid="job-session-loss-storage">
            <caption>{text.storageKeyChange}</caption>
            <thead>
              <tr>
                <th scope="col">{text.storageColumns.storage}</th>
                <th scope="col">{text.storageColumns.originKind}</th>
                <th scope="col">{text.storageColumns.change}</th>
                <th scope="col">{text.storageColumns.count}</th>
                <th scope="col">{text.storageColumns.shapes}</th>
              </tr>
            </thead>
            <tbody>
              {storageKeyChange.map((row) => (
                <tr key={JSON.stringify([row.storage, row.originKind, row.change])} data-change={row.change}>
                  <td>{text.storageLabels[row.storage]}</td>
                  <td>{text.originKindLabels[row.originKind]}</td>
                  <td>{text.changeLabels[row.change]}</td>
                  <td>{formatCount(row.count)}</td>
                  <td className="cell-break">
                    {row.shapes.length === 0 ? <span className="muted">{text.none}</span> : row.shapes.map(({ prefix, suffix }, index) => (
                      <span key={JSON.stringify([prefix, suffix])}>{index === 0 ? null : ', '}<code>{text.shapeText(prefix, suffix)}</code></span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * 書き込みの結果の表示（Task 30 の設計書 2 章のユーザーの判断 2、3 章の「結果の判定」「予約の締め」「`UNKNOWN` の後」。T30g）。ジョブの詳細と、
 * シナリオの書き込みの履歴が共用する。
 * - `UNKNOWN` は、はっきり目立たせ（critical のお知らせ）、テスト環境で登録の有無を確かめるよう促す。`PARTIAL` も、照合できていないことを
 *   お知らせで示す（成功と偽らない）。
 * - 文言と表示はカタログ（`src/presentation/`）だけ。送った値は、入力の規則で作った合成のテストデータ（設計書のとおり出してよい値）。
 * - T31h-2（Task 31 の設計書 3 章の「証拠と記録」、8.1）: 更新（UPDATE）は、対象のレコードの ID と取れた ID、前後の差分（変えた欄の前の値と
 *   新しい値と一致、保つ欄の一致）を出す。保つ欄の値は記録にないので出さない。`UNKNOWN` は今の critical のお知らせのまま。
 * - T32g（Task 32 の設計書 4.1 の「親の確かめと画面の配布」）: 書き込みの報告の欄（詳細）と列（履歴）。親の確かめに通った報告だけ、開く・ZIP を
 *   落とすリンクを出し、通らない・確かめていないときは配らない理由を出す。
 */
import { Link } from '@tanstack/react-router';
import { formatDateTime, formatInteger } from '../../../../src/presentation/format.js';
import { LOCAL_UI_WRITE_REPORT_TEXT, LOCAL_UI_WRITE_TEXT } from '../../../../src/presentation/messages.js';
import {
  actionBlockReasonDisplay,
  actionOutcomeReasonDisplay,
  actionResultDisplay,
  readCheckResultDisplay,
  responseJudgementDisplay,
  settledReservationStateDisplay,
  submissionStateDisplay,
  toneClass,
  writeReportCheckDisplay,
  type DisplayValue,
} from '../display/labels';
import type { WriteReportView, WriteResultSummaryView, WriteUpdateResultView } from '../server/write-results';
import { Notice } from './Notice';

const text = LOCAL_UI_WRITE_TEXT;
const reportText = LOCAL_UI_WRITE_REPORT_TEXT;

/** 値があればラベル（色つき）、なければ「なし」。 */
function Badge({ display }: Readonly<{ display: DisplayValue | null }>) {
  return display === null ? <span>{text.notApplicable}</span> : <span className={toneClass(display.tone)}>{display.label}</span>;
}

/** 更新の後の照合の一致の表示（一致・一致しない・照合できない）。 */
function Matched({ matched }: Readonly<{ matched: boolean | null }>) {
  if (matched === null) {
    return <span className={toneClass('caution')}>{text.undeterminedValue}</span>;
  }
  return matched
    ? <span className={toneClass('positive')}>{text.matchedValue}</span>
    : <span className={toneClass('critical')}>{text.notMatchedValue}</span>;
}

/** 一致の data 属性の値（照合できなければ空）。 */
const matchedAttribute = (matched: boolean | null): string => (matched === null ? '' : String(matched));

/** T31h-2: 更新の前後の差分（変えた欄は前の値・新しい値・一致、保つ欄は一致だけ）。 */
function UpdateDiff({ update }: Readonly<{ update: WriteUpdateResultView }>) {
  return (
    <div data-testid="write-result-diff">
      <h3>{text.diffHeading}</h3>
      <p className="muted">{text.diffNote}</p>
      {update.evidence ? null : <p data-testid="write-result-diff-none">{text.noUpdateEvidence}</p>}
      {update.changed.length === 0 ? null : (
        <div className="table-wrap">
          <table>
            <caption>{text.changedDiffHeading}</caption>
            <thead>
              <tr>
                <th scope="col">{text.diffColumns.field}</th>
                <th scope="col">{text.diffColumns.previous}</th>
                <th scope="col">{text.diffColumns.next}</th>
                <th scope="col">{text.diffColumns.matched}</th>
              </tr>
            </thead>
            <tbody>
              {update.changed.map((field) => (
                <tr key={field.fieldName} data-testid="write-result-diff-changed" data-field-name={field.fieldName} data-matched={matchedAttribute(field.matched)}>
                  <th scope="row"><code>{field.fieldName}</code></th>
                  <td><code data-testid="write-result-diff-previous">{field.previousValue}</code></td>
                  <td><code data-testid="write-result-diff-new">{field.newValue}</code></td>
                  <td><Matched matched={field.matched} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {update.kept.length === 0 ? null : (
        <div className="table-wrap">
          <table>
            <caption>{text.keptDiffHeading}</caption>
            <thead>
              <tr>
                <th scope="col">{text.diffColumns.field}</th>
                <th scope="col">{text.diffColumns.matched}</th>
              </tr>
            </thead>
            <tbody>
              {update.kept.map((field) => (
                <tr key={field.fieldName} data-testid="write-result-diff-kept" data-field-name={field.fieldName} data-matched={matchedAttribute(field.matched)}>
                  <th scope="row"><code>{field.fieldName}</code></th>
                  <td><Matched matched={field.matched} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * T32g: 書き込みの報告（親の確かめに通ったときだけ、報告を開く・ZIP を落とすリンク。通らない・確かめていないときは、配らない理由）。配るかは、
 * サーバが返す URL があるかで決める（確かめの結果の値で分岐しない）。
 */
function WriteReport({ report }: Readonly<{ report: WriteReportView }>) {
  const check = report.check === null ? null : writeReportCheckDisplay(report.check);
  return (
    <div data-testid="write-report" data-check={report.check ?? ''}>
      <h3>{reportText.heading}</h3>
      {report.reportHref === null ? (
        <>
          <p>{reportText.notDistributed}</p>
          {check === null ? <p data-testid="write-report-not-checked">{reportText.notChecked}</p> : (
            <dl className="facts">
              <dt>{reportText.checkLabel}</dt>
              <dd data-testid="write-report-reason"><span className={toneClass(check.tone)}>{check.label}</span></dd>
            </dl>
          )}
          {check === null || check.description === null ? null : <p className="muted">{check.description}</p>}
        </>
      ) : (
        <ul className="link-list">
          <li>
            <a href={report.reportHref} target="_blank" rel="noopener noreferrer" data-testid="write-report-open">{reportText.openReport}</a>
          </li>
          {report.bundleHref === null ? null : (
            <li><a href={report.bundleHref} download data-testid="write-report-download">{reportText.downloadBundle}</a></li>
          )}
        </ul>
      )}
    </div>
  );
}

/** 結果の見出しのお知らせ（`UNKNOWN`・`PARTIAL` だけ。ほかは出さない）。 */
export function WriteResultWarning({ result }: Readonly<{ result: WriteResultSummaryView }>) {
  if (result.result === 'UNKNOWN') {
    return (
      <Notice kind="critical" heading={text.unknownHeading}>
        <p data-testid="write-result-unknown">{text.unknownBody}</p>
      </Notice>
    );
  }
  if (result.result === 'PARTIAL') {
    return (
      <Notice kind="caution" heading={text.partialHeading}>
        <p data-testid="write-result-partial">{result.update === null ? text.partialBody : text.partialUpdateBody}</p>
      </Notice>
    );
  }
  return null;
}

/** 書き込みの結果 1 件の詳細（結果・理由・送信・応答・登録の ID・照合の READ・予約の締め・日時・送った値）。 */
export function WriteResultDetails({ result }: Readonly<{ result: WriteResultSummaryView }>) {
  const resultDisplay = result.result === null ? null : actionResultDisplay(result.result);
  return (
    <div data-testid="write-result" data-job-id={result.jobId} data-result={result.result ?? ''} data-kind={result.writeKind}>
      <WriteResultWarning result={result} />
      {result.result === null ? <p data-testid="write-result-pending">{text.resultPending}</p> : null}
      <dl className="facts">
        <dt>{text.columns.result}</dt>
        <dd data-testid="write-result-label"><Badge display={resultDisplay} /></dd>
        <dt>{text.columns.reason}</dt>
        <dd data-testid="write-result-reason" data-reason={result.reason ?? ''}>
          <Badge display={result.reason === null ? null : actionOutcomeReasonDisplay(result.reason)} />
        </dd>
        {result.update === null ? null : [
          <dt key="target:name">{text.columns.target}</dt>,
          <dd key="target:value" data-testid="write-result-target"><code>{result.update.targetRecordId}</code></dd>,
        ]}
        <dt>{text.columns.submission}</dt>
        <dd data-testid="write-result-submission"><Badge display={result.submission === null ? null : submissionStateDisplay(result.submission)} /></dd>
        <dt>{text.columns.blockReason}</dt>
        <dd><Badge display={result.blockReason === null ? null : actionBlockReasonDisplay(result.blockReason)} /></dd>
        <dt>{text.columns.httpStatus}</dt>
        <dd>{result.httpStatus === null ? text.notApplicable : formatInteger(result.httpStatus)}</dd>
        <dt>{text.columns.responseJudgement}</dt>
        <dd><Badge display={result.responseJudgement === null ? null : responseJudgementDisplay(result.responseJudgement)} /></dd>
        <dt>{result.update === null ? text.columns.recordId : text.columns.obtainedId}</dt>
        <dd data-testid="write-result-record-id">{result.recordId === null ? text.notApplicable : <code>{result.recordId}</code>}</dd>
        <dt>{text.columns.readVerification}</dt>
        <dd><Badge display={result.readVerification === null ? null : readCheckResultDisplay(result.readVerification)} /></dd>
        <dt>{text.columns.reservation}</dt>
        <dd data-testid="write-result-reservation">
          <Badge display={result.reservationState === null ? null : settledReservationStateDisplay(result.reservationState)} />
        </dd>
        <dt>{text.columns.recordedAt}</dt>
        <dd>{formatDateTime(result.recordedAt)}</dd>
        <dt>{text.columns.submittedAt}</dt>
        <dd>{result.submittedAt === null ? text.notApplicable : formatDateTime(result.submittedAt)}</dd>
        <dt>{text.columns.settledAt}</dt>
        <dd>{result.settledAt === null ? text.notApplicable : formatDateTime(result.settledAt)}</dd>
      </dl>
      {resultDisplay === null || resultDisplay.description === null ? null : <p className="muted">{resultDisplay.description}</p>}
      {result.update === null ? null : <UpdateDiff update={result.update} />}
      <WriteReport report={result.report} />
      <h3>{text.submittedValuesHeading}</h3>
      {result.submittedValues.length === 0 ? <p>{text.noSubmittedValues}</p> : (
        <dl className="facts" data-testid="write-result-values">
          {result.submittedValues.map(({ name, value }) => [
            <dt key={`${name}:name`}><code>{name}</code></dt>,
            <dd key={`${name}:value`}><code>{value}</code></dd>,
          ])}
        </dl>
      )}
    </div>
  );
}

/** シナリオの書き込みの履歴（新しい順。結果ごとに、ジョブを開く）。 */
export function WriteResultHistory({ results }: Readonly<{ results: readonly WriteResultSummaryView[] }>) {
  if (results.length === 0) {
    return <p data-testid="write-history-empty">{text.noWrites}</p>;
  }
  return (
    <div className="table-wrap">
      <table data-testid="write-history">
        <thead>
          <tr>
            <th scope="col">{text.columns.recordedAt}</th>
            <th scope="col">{text.columns.result}</th>
            <th scope="col">{text.columns.reason}</th>
            <th scope="col">{text.columns.submission}</th>
            <th scope="col">{text.columns.target}</th>
            <th scope="col">{text.columns.recordId}</th>
            <th scope="col">{text.columns.reservation}</th>
            <th scope="col">{reportText.column}</th>
            <th scope="col">{text.columns.job}</th>
          </tr>
        </thead>
        <tbody>
          {results.map((result) => (
            <tr key={result.jobId} data-testid="write-history-entry" data-job-id={result.jobId} data-result={result.result ?? ''}
              data-target={result.update?.targetRecordId ?? ''} data-report-check={result.report.check ?? ''}>
              <td>{formatDateTime(result.recordedAt)}</td>
              <td><Badge display={result.result === null ? null : actionResultDisplay(result.result)} /></td>
              <td><Badge display={result.reason === null ? null : actionOutcomeReasonDisplay(result.reason)} /></td>
              <td><Badge display={result.submission === null ? null : submissionStateDisplay(result.submission)} /></td>
              <td>{result.update === null ? text.notApplicable : <code>{result.update.targetRecordId}</code>}</td>
              <td>{result.recordId === null ? text.notApplicable : <code>{result.recordId}</code>}</td>
              <td><Badge display={result.reservationState === null ? null : settledReservationStateDisplay(result.reservationState)} /></td>
              <td>
                {result.report.reportHref === null
                  ? <span className="muted">{reportText.notDistributedShort}</span>
                  : (
                    <a href={result.report.reportHref} target="_blank" rel="noopener noreferrer" data-testid="write-history-report-open">
                      {reportText.openReport}
                    </a>
                  )}
              </td>
              <td><Link to="/jobs/$jobId" params={{ jobId: result.jobId }}>{text.openJob}</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

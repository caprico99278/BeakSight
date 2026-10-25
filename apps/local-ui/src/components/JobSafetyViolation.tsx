/**
 * ジョブの詳細の、安全の違反の中身（DEF-144。発見と READ の確かめのジョブが `SAFETY_VIOLATION` で止まったとき）。成果物の `safetyViolation`（`run.json` の
 * `safety` と同じ形の一覧と数に、起きた段・画面の path・押していた候補を足したもの）を出す。値（本文、query の値、Cookie、token）は成果物にない。リンクに
 * しない。文言はカタログ（`LOCAL_UI_SAFETY_VIOLATION_TEXT`、`JOB_SAFETY_VIOLATION_STAGE_LABELS`）。
 */
import type { DiscoveryExternalSchemeProbes, DiscoveryPressLimitProbes } from '../../../../src/control/discovery-view.js';
import type { JobSafetyViolation as JobSafetyViolationRecord } from '../../../../src/core/contracts.js';
import { formatCount } from '../../../../src/presentation/format.js';
import {
  JOB_SAFETY_VIOLATION_STAGE_LABELS,
  LOCAL_UI_EXTERNAL_SCHEME_PROBE_TEXT,
  LOCAL_UI_PRESS_LIMIT_PROBE_TEXT,
  LOCAL_UI_SAFETY_VIOLATION_TEXT,
} from '../../../../src/presentation/messages.js';
import { Notice } from './Notice';

/**
 * DEF-144（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 2.3）: 発見のジョブの、外部のアプリへ移るので押さなかったボタンの数と、読み込み直した
 * 画面の数（成果物にあるときだけ）。
 */
export function ExternalSchemeProbes({ counts }: Readonly<{ counts: DiscoveryExternalSchemeProbes | null }>) {
  if (counts === null) {
    return null;
  }
  const probeText = LOCAL_UI_EXTERNAL_SCHEME_PROBE_TEXT;
  return (
    <section className="panel" data-testid="job-external-scheme-probes">
      <h2 className="panel-heading">{probeText.heading}</h2>
      <p className="muted">{probeText.body}</p>
      <dl className="facts">
        <dt>{probeText.notPressed}</dt>
        <dd data-testid="job-external-scheme-not-pressed">{formatCount(counts.notPressed)}</dd>
        <dt>{probeText.reloadedPages}</dt>
        <dd data-testid="job-external-scheme-reloaded">{formatCount(counts.reloadedPages)}</dd>
      </dl>
    </section>
  );
}

/**
 * T44c（Task 44 の設計書 P1-3）: 発見のジョブの、押す数の上限で押せなかった登録・更新の語のボタンの数（成果物にあるときだけ）。
 */
export function PressLimitProbes({ counts }: Readonly<{ counts: DiscoveryPressLimitProbes | null }>) {
  if (counts === null) {
    return null;
  }
  const limitText = LOCAL_UI_PRESS_LIMIT_PROBE_TEXT;
  return (
    <section className="panel" data-testid="job-press-limit-probes">
      <h2 className="panel-heading">{limitText.heading}</h2>
      <p className="muted">{limitText.body}</p>
      <dl className="facts">
        <dt>{limitText.priorityNotPressed}</dt>
        <dd data-testid="job-press-limit-priority-not-pressed">{formatCount(counts.priorityNotPressed)}</dd>
      </dl>
    </section>
  );
}

const text = LOCAL_UI_SAFETY_VIOLATION_TEXT;

/** 違反の中身（記録がなければ何も出さない）。 */
export function JobSafetyViolation({ violation }: Readonly<{ violation: JobSafetyViolationRecord | null }>) {
  if (violation === null) {
    return null;
  }
  const omitted = Math.max(0, violation.invariantViolationCount - violation.invariantViolations.length);
  return (
    <section className="panel" data-testid="job-safety-violation" data-stage={violation.stage}>
      <h2 className="panel-heading">{text.heading}</h2>
      <Notice kind="caution">
        <p>{text.body}</p>
      </Notice>
      <dl className="facts">
        <dt>{text.stage}</dt>
        <dd data-testid="job-safety-violation-stage">{JOB_SAFETY_VIOLATION_STAGE_LABELS[violation.stage]}</dd>
        <dt>{text.pagePath}</dt>
        <dd className="cell-break"><code data-testid="job-safety-violation-page">{violation.pagePath}</code></dd>
        {violation.press === null ? null : (
          <>
            <dt>{text.pressedWords}</dt>
            <dd data-testid="job-safety-violation-press-words">
              {violation.press.submitterWords.length === 0 ? text.pressedNoWords : violation.press.submitterWords.join('、')}
            </dd>
            <dt>{text.pressedIdentity}</dt>
            <dd className="cell-break"><code data-testid="job-safety-violation-press-identity">{violation.press.identityDigest}</code></dd>
          </>
        )}
        <dt>{text.count}</dt>
        <dd data-testid="job-safety-violation-count">{formatCount(violation.invariantViolationCount)}</dd>
      </dl>
      {violation.recordTruncated ? <p data-testid="job-safety-violation-truncated">{text.recordTruncated}</p> : null}
      <div className="table-wrap">
        <table data-testid="job-safety-violation-list">
          <caption>{text.tableCaption}</caption>
          <thead>
            <tr>
              <th scope="col">{text.columns.code}</th>
              <th scope="col">{text.columns.message}</th>
              <th scope="col">{text.columns.method}</th>
              <th scope="col">{text.columns.origin}</th>
              <th scope="col">{text.columns.path}</th>
            </tr>
          </thead>
          <tbody>
            {violation.invariantViolations.map(({ code, message, request }, index) => (
              // 同じ種類の違反が並びうるので、順の番号を鍵にする（並べ替えない）。
              <tr key={index} data-code={code}>
                <td><code>{code}</code></td>
                <td className="cell-break">{message}</td>
                {request === undefined ? (
                  <td colSpan={3} className="muted">{text.noRequest}</td>
                ) : (
                  <>
                    <td><code>{request.method}</code></td>
                    <td className="cell-break">{request.origin === null ? <span className="muted">{text.noOrigin}</span> : <code>{request.origin}</code>}</td>
                    <td className="cell-break"><code>{request.path}</code></td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {omitted === 0 ? null : <p data-testid="job-safety-violation-omitted">{text.omittedText(formatCount(omitted))}</p>}
    </section>
  );
}

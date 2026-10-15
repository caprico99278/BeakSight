import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import { formatCount, formatDateTime, formatInteger } from '../../../../../src/presentation/format.js';
import { LOCAL_UI_LEDGER_TEXT } from '../../../../../src/presentation/messages.js';
import { Notice } from '../../components/Notice';
import { PageFrame } from '../../components/PageFrame';
import { ProfileSummary } from '../../components/ProfileSummary';
import {
  actionResultDisplay,
  readCheckResultDisplay,
  scenarioKindDisplay,
  submissionStateDisplay,
  toneClass,
  type DisplayValue,
} from '../../display/labels';
import { auditedDataLedgerPageFn, type LedgerEntryView } from '../../server/ledger-functions';

export const Route = createFileRoute('/ledger/$profileId')({
  loader: async ({ params }) => {
    const page = await auditedDataLedgerPageFn({ data: { profileId: params.profileId } });
    if (page === null) {
      throw notFound();
    }
    return page;
  },
  component: LedgerPage,
});

const text = LOCAL_UI_LEDGER_TEXT;

/** 値があればラベル（色つき）、なければ「なし」。 */
function Badge({ display }: Readonly<{ display: DisplayValue | null }>) {
  return display === null ? <span>{text.notApplicable}</span> : <span className={toneClass(display.tone)}>{display.label}</span>;
}

/** 照合の状態（送信の状態・結果・照合の READ の結果）。 */
function Verification({ entry }: Readonly<{ entry: LedgerEntryView }>) {
  return (
    <ul className="word-list">
      <li><Badge display={entry.submission === null ? null : submissionStateDisplay(entry.submission)} /></li>
      <li><Badge display={entry.result === null ? null : actionResultDisplay(entry.result)} /></li>
      <li><Badge display={entry.readVerification === null ? null : readCheckResultDisplay(entry.readVerification)} /></li>
    </ul>
  );
}

/**
 * 監査済みデータの台帳（T32g。Task 32 の設計書 4.1 の「監査済みデータの台帳」。ロードマップ 13.4）。プロファイルの詳細から開く。BeakSight が
 * 作ったかもしれないデータ（CREATE の書き込み。送らずに止めた回を除く）の、登録の ID、シナリオと版、seed の記録（許可の ID と規則の digest）、
 * ジョブと Run、照合の状態、その ID への UPDATE の回数と最後の結果、シナリオごとの累計の件数と上限。「削除も復元もしない」の注記を出す。
 * 書き出しのファイルは作らない。書き込みのモードでないプロファイルには、行を出さずに理由を出す。
 */
function LedgerPage() {
  const page = Route.useLoaderData();
  const { profile } = page;
  const columns = text.columns;
  return (
    <PageFrame title={text.pages.ledger}>
      <ProfileSummary profile={profile} testId="ledger-profile" />
      {page.eligible ? (
        <>
          <Notice kind="caution">
            <p data-testid="ledger-note">{text.note}</p>
          </Notice>
          <section className="panel" data-testid="ledger">
            <h2 className="panel-heading">{text.entriesHeading}</h2>
            <p className="muted">{text.entriesNote}</p>
            {page.entries.length === 0 ? <p data-testid="ledger-empty">{text.noEntries}</p> : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{columns.recordId}</th>
                      <th scope="col">{columns.scenario}</th>
                      <th scope="col">{columns.seed}</th>
                      <th scope="col">{columns.job}</th>
                      <th scope="col">{columns.verification}</th>
                      <th scope="col">{columns.updates}</th>
                      <th scope="col">{columns.recordedAt}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.entries.map((entry) => (
                      <tr key={entry.jobId} data-testid="ledger-entry" data-job-id={entry.jobId} data-record-id={entry.recordId ?? ''}
                        data-scenario-id={entry.scenarioId} data-update-count={String(entry.updates.count)}
                        data-last-update-result={entry.updates.lastResult ?? ''}>
                        <th scope="row">{entry.recordId === null ? text.notObtained : <code>{entry.recordId}</code>}</th>
                        <td className="cell-break">
                          <code>{entry.scenarioId}</code>
                          <br />
                          {text.revisionValue(formatInteger(entry.scenarioRevision))}
                          <br />
                          <Link to="/scenarios/$profileId/$scenarioId" params={{ profileId: profile.profileId, scenarioId: entry.scenarioId }}
                            data-testid="ledger-open-scenario">
                            {text.openScenario}
                          </Link>
                        </td>
                        <td className="cell-break">
                          {entry.seed === null ? text.notApplicable : (
                            <>
                              <code>{entry.seed.executionGrantId}</code>
                              <br />
                              <code>{entry.seed.ruleSetDigest}</code>
                            </>
                          )}
                        </td>
                        <td className="cell-break">
                          <Link to="/jobs/$jobId" params={{ jobId: entry.jobId }} data-testid="ledger-open-job">{entry.jobId}</Link>
                          <br />
                          {entry.runId === null ? text.notApplicable : <code>{entry.runId}</code>}
                        </td>
                        <td><Verification entry={entry} /></td>
                        <td>
                          {text.updateCountValue(formatCount(entry.updates.count))}
                          {entry.updates.lastJobId === null ? null : (
                            <>
                              <br />
                              {text.lastUpdateLabel}
                              {' '}
                              <Badge display={entry.updates.lastResult === null ? null : actionResultDisplay(entry.updates.lastResult)} />
                            </>
                          )}
                        </td>
                        <td>{formatDateTime(entry.recordedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="panel" data-testid="ledger-scenarios">
            <h2 className="panel-heading">{text.scenariosHeading}</h2>
            {page.scenarios.length === 0 ? <p>{text.noScenarios}</p> : (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{text.scenarioColumns.scenario}</th>
                        <th scope="col">{text.scenarioColumns.kind}</th>
                        <th scope="col">{text.scenarioColumns.revision}</th>
                        <th scope="col">{text.scenarioColumns.cumulative}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.scenarios.map((scenario) => {
                        const kind = scenarioKindDisplay(scenario.kind);
                        return (
                          <tr key={scenario.scenarioId} data-testid="ledger-scenario" data-scenario-id={scenario.scenarioId}
                            data-used={String(scenario.used)} data-limit={String(scenario.limit)}>
                            <th scope="row"><code>{scenario.scenarioId}</code></th>
                            <td><span className={toneClass(kind.tone)}>{kind.label}</span></td>
                            <td>{text.revisionValue(formatInteger(scenario.revision))}</td>
                            <td>{text.cumulativeValue(formatCount(scenario.used), formatCount(scenario.limit))}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="muted">{text.cumulativeNote}</p>
              </>
            )}
          </section>
        </>
      ) : (
        <Notice kind="caution">
          <p data-testid="ledger-not-eligible">{text.notEligible}</p>
        </Notice>
      )}
      <div className="button-row">
        <Link to="/profiles/$profileId" params={{ profileId: profile.profileId }} className="button">{text.backToProfile}</Link>
      </div>
    </PageFrame>
  );
}

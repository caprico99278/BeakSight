import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import { formatCount, formatInteger, formatPlainDateTime } from '../../../../../src/presentation/format.js';
import { LOCAL_UI_LEDGER_TEXT, LOCAL_UI_WRITE_SCREENS_TEXT, LOCAL_UI_WRITE_STAGE_TEXT } from '../../../../../src/presentation/messages.js';
import { AdvancedSettings } from '../../components/AdvancedSettings';
import { Notice } from '../../components/Notice';
import { PageFrame, siteTrail } from '../../components/PageFrame';
import {
  actionResultDisplay,
  readCheckResultDisplay,
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
const stageText = LOCAL_UI_WRITE_STAGE_TEXT.ledger;

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
 * 作ったデータの一覧（監査済みデータの台帳。T32g。PL-5 で設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の形に作り直した）。上から: 要点のパネル（作ったデータの
 * 数、「消さない」の注記、行は「何を作ったか・いつ・書き換えたか」。SPEC-4 で「書き換えを試す」を外した）→ 詳しい内容 1 つ（データの ID と答え合わせの結果、
 * 書き込みの手順ごとの累計の件数）。許可の ID・digest・作業と点検の回の ID・書き込みの手順の ID と版は出さない（3 章の 2）。
 */
function LedgerPage() {
  const page = Route.useLoaderData();
  /** OP-G（指示書の 7）: 登録の手順（画面）ごとの、一覧に出た順の番号（1 から）。 */
  const screenNumbers = new Map([...new Set(page.entries.map(({ scenarioId }) => scenarioId))].map((scenarioId, index) => [scenarioId, index + 1]));
  const screenNumberOf = (scenarioId: string): number => screenNumbers.get(scenarioId) ?? 1;
  const { profile } = page;
  return (
    <PageFrame title={text.pages.ledger} trail={siteTrail(profile.profileId)}>
      {page.eligible ? (
        <>
          <section className="panel" data-testid="ledger">
            <h2 className="panel-heading">{LOCAL_UI_WRITE_STAGE_TEXT.summaryHeading}</h2>
            <p data-testid="ledger-count">{page.entries.length === 0 ? stageText.none : stageText.count(formatCount(page.entries.length))}</p>
            <Notice kind="caution">
              <p data-testid="ledger-note">{text.note}</p>
            </Notice>
            {page.entries.length === 0 ? <p data-testid="ledger-empty">{text.noEntries}</p> : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{stageText.columns.what}</th>
                      <th scope="col">{stageText.columns.at}</th>
                      <th scope="col">{stageText.columns.updated}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.entries.map((entry) => (
                      <tr key={entry.jobId} data-testid="ledger-entry" data-job-id={entry.jobId} data-record-id={entry.recordId ?? ''}
                        data-scenario-id={entry.scenarioId} data-update-count={String(entry.updates.count)}
                        data-last-update-result={entry.updates.lastResult ?? ''}>
                        <th scope="row">
                          <Link to="/scenarios/$profileId/$scenarioId" params={{ profileId: profile.profileId, scenarioId: entry.scenarioId }}
                            data-testid="ledger-open-scenario">
                            {/* OP-G（指示書の 7）: 英字の path の語を出さず、登録の画面ごとの順の番号の、やさしい形（「登録の画面（1）」）。 */}
                            {entry.pagePath === null
                              ? text.openScenario
                              : stageText.what(LOCAL_UI_WRITE_SCREENS_TEXT.unnamedScreen(formatInteger(screenNumberOf(entry.scenarioId))))}
                          </Link>
                        </th>
                        <td>{formatPlainDateTime(entry.recordedAt)}</td>
                        <td>{entry.updates.count === 0 ? stageText.updatedNo : stageText.updatedYes(formatCount(entry.updates.count))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="panel">
            <AdvancedSettings testId="ledger-advanced">
              {page.entries.length === 0 ? null : (
                <div className="table-wrap">
                  <table data-testid="ledger-details">
                    <thead>
                      <tr>
                        <th scope="col">{text.columns.recordId}</th>
                        <th scope="col">{text.columns.verification}</th>
                        <th scope="col">{text.columns.updates}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.entries.map((entry) => (
                        <tr key={entry.jobId} data-testid="ledger-entry-detail" data-job-id={entry.jobId}>
                          <th scope="row">{entry.recordId ?? text.notObtained}</th>
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
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <section data-testid="ledger-scenarios">
                <h3>{text.scenariosHeading}</h3>
                {page.scenarios.length === 0 ? <p>{text.noScenarios}</p> : (
                  <ul>
                    {page.scenarios.map((scenario) => (
                      <li key={scenario.scenarioId} data-testid="ledger-scenario" data-scenario-id={scenario.scenarioId}
                        data-used={String(scenario.used)}>
                        {text.cumulativeValue(formatCount(scenario.used))}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="muted">{text.cumulativeNote}</p>
              </section>
            </AdvancedSettings>
          </section>
        </>
      ) : (
        <Notice kind="caution">
          <p data-testid="ledger-not-eligible">{text.notEligible}</p>
        </Notice>
      )}
    </PageFrame>
  );
}

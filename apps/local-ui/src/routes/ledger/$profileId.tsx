import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import { formatCount, formatInteger, formatPlainDateTime } from '../../../../../src/presentation/format.js';
import { LOCAL_UI_LEDGER_TEXT, LOCAL_UI_WRITE_SCREENS_TEXT, LOCAL_UI_WRITE_STAGE_TEXT } from '../../../../../src/presentation/messages.js';
import { AdvancedSettings } from '../../components/AdvancedSettings';
import { Notice } from '../../components/Notice';
import { PageFrame, siteTrail } from '../../components/PageFrame';
import { AUTO_DRAFT_SEARCH_MARK } from '../../display/auto-draft-search';
import {
  actionResultDisplay,
  readCheckResultDisplay,
  submissionStateDisplay,
  toneClass,
  type DisplayValue,
} from '../../display/labels';
import { auditedDataLedgerPageFn, type LedgerEntryView } from '../../server/ledger-functions';
import { scenarioAutoDraftPreviewFn, type AutoDraftUpdateLinkView } from '../../server/scenario-autodraft-functions';

export const Route = createFileRoute('/ledger/$profileId')({
  loader: async ({ params }) => {
    // PL-5（設計書 6 章の 8）: 「書き換えを試す」の行き先は、自動の下書きの書き換えの案内（PL-6b。今の管理データから求め直す。保存しない）。
    const [page, autoDraft] = await Promise.all([
      auditedDataLedgerPageFn({ data: { profileId: params.profileId } }),
      scenarioAutoDraftPreviewFn({ data: { profileId: params.profileId } }),
    ]);
    if (page === null) {
      throw notFound();
    }
    const ledgerIds = new Set(page.entries.filter((entry) => entry.recordId !== null).map((entry) => entry.scenarioId));
    // 作ったデータ（ID のある行）の書き込みの手順を台帳に前もって選んだ、最初の書き換えの案内（台帳を選べない案内でも、作成の画面で選べる）。
    const updates = autoDraft?.updates.filter((item) => item.link !== null) ?? [];
    const update = updates.find((item) => item.presetLedger !== null && ledgerIds.has(item.presetLedger.value)) ?? updates[0] ?? null;
    return { ...page, updateLink: ledgerIds.size === 0 ? null : update?.link ?? null };
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

/** 「書き換えを試す」（作成の画面へ。変える欄は人が選ぶ。前もって選ぶ台帳と画面の型は案）。 */
function UpdateTryLink({ profileId, link }: Readonly<{ profileId: string; link: AutoDraftUpdateLinkView }>) {
  return (
    <Link
      to="/scenarios/$profileId/new"
      params={{ profileId }}
      search={{
        candidate: link.candidate,
        ...(link.shape === '' ? {} : { shape: link.shape }),
        ...(link.ledger === null ? {} : { ledger: link.ledger }),
        ...(link.template === null ? {} : { template: link.template }),
        autoDraft: AUTO_DRAFT_SEARCH_MARK,
      }}
      className="button button--primary"
      data-testid="ledger-update-try"
    >
      {stageText.updateTry}
    </Link>
  );
}

/**
 * 作ったデータの一覧（監査済みデータの台帳。T32g。PL-5 で設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の形に作り直した）。上から: 要点のパネル（作ったデータの
 * 数、「消さない」の注記、行は「何を作ったか・いつ・書き換えたか」、主のボタン「書き換えを試す」）→ 詳しい内容 1 つ（データの ID と答え合わせの結果、
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
            {page.updateLink === null ? null : (
              <>
                <p>{stageText.nextUpdate}</p>
                <div className="button-row">
                  <UpdateTryLink profileId={profile.profileId} link={page.updateLink} />
                </div>
              </>
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
                        data-used={String(scenario.used)} data-limit={String(scenario.limit)}>
                        {text.cumulativeValue(formatCount(scenario.used), formatCount(scenario.limit))}
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

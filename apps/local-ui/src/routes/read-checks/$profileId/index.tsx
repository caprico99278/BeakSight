import { useState } from 'react';
import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { formatCount, formatDateTime } from '../../../../../../src/presentation/format.js';
import {
  LOCAL_UI_DISCOVERY_TEXT,
  LOCAL_UI_READ_CHECK_TEXT,
  LOCAL_UI_TEXT,
  READ_CHECK_DETAIL_DESCRIPTIONS,
  READ_EXPECTATION_UNDETERMINED_REASON_DESCRIPTIONS,
  READ_ROW_SOURCE_LABELS,
  listText,
} from '../../../../../../src/presentation/messages.js';
import { Notice } from '../../../components/Notice';
import { PageFrame } from '../../../components/PageFrame';
import { ProfileSummary } from '../../../components/ProfileSummary';
import { StartReasonDetails } from '../../../components/StartReasonDetails';
import {
  readCheckEndReasonDisplay,
  readCheckResultDisplay,
  toneClass,
} from '../../../display/labels';
import { expectationText, parametersText } from '../../../display/read-checks';
import type { AuditJobStartView } from '../../../server/audit-job-functions';
import {
  readCheckPageFn,
  startReadCheckFn,
  type ReadCheckCandidateView,
  type ReadCheckPageView,
  type ReadExpectationResultView,
} from '../../../server/read-check-functions';

/** 保存と削除の後に出す知らせ（URL の search で渡す。値は閉じた一覧）。 */
const NOTICES = Object.freeze(['saved', 'removed'] as const);
type ReadCheckNotice = (typeof NOTICES)[number];
const isReadCheckNotice = (value: unknown): value is ReadCheckNotice => NOTICES.some((notice) => notice === value);

export const Route = createFileRoute('/read-checks/$profileId/')({
  validateSearch: (search: Record<string, unknown>): { notice?: ReadCheckNotice } =>
    (isReadCheckNotice(search['notice']) ? { notice: search['notice'] } : {}),
  loader: async ({ params }) => {
    const page = await readCheckPageFn({ data: { profileId: params.profileId } });
    if (page === null) {
      throw notFound();
    }
    return page;
  },
  component: ReadChecksPage,
});

const text = LOCAL_UI_READ_CHECK_TEXT;

const NOTICE_TEXT: Readonly<Record<ReadCheckNotice, string>> = Object.freeze({ saved: text.saved, removed: text.removed });

/** 候補の画面と送信先の表示（Origin を示すときは、Origin と path）。 */
const pageTextOf = (candidate: ReadCheckCandidateView, showOrigins: boolean): string =>
  `${showOrigins ? candidate.pageOrigin : ''}${candidate.pagePath}`;
const actionTextOf = (candidate: ReadCheckCandidateView, showOrigins: boolean): string =>
  (candidate.actionPath === null ? LOCAL_UI_DISCOVERY_TEXT.noAction : `${showOrigins ? candidate.actionOrigin ?? '' : ''}${candidate.actionPath}`);

/** 期待 1 件の結果の要約（照らした項目と取れた値）。 */
const expectationResultText = (view: ReadExpectationResultView): string => {
  const parts = [expectationText(view.expectation), readCheckResultDisplay(view.result).label];
  if (view.observedRowCount !== null) {
    parts.push(text.observedRowCount(formatCount(view.observedRowCount), view.rowSource === null ? '' : READ_ROW_SOURCE_LABELS[view.rowSource]));
  }
  if (view.found !== null) {
    parts.push(view.found ? text.found : text.notFound);
  }
  if (view.expectation.kind === 'DETAIL_FIELD_EQUALS') {
    parts.push(view.observedValue === null ? text.observedNone : text.observedValue(JSON.stringify(view.observedValue)));
  }
  if (view.undeterminedReason !== null) {
    parts.push(READ_EXPECTATION_UNDETERMINED_REASON_DESCRIPTIONS[view.undeterminedReason]);
  }
  return listText(parts);
};

/** 結果の欄（ジョブごと。定義ごとの結果、詳しい理由、期待ごとの結果の要約、`read-evidence.json` へのリンク）。 */
function Results({ page }: Readonly<{ page: ReadCheckPageView }>) {
  const columns = text.resultColumns;
  return (
    <section className="panel" data-testid="read-check-results">
      <h2 className="panel-heading">{text.resultsHeading}</h2>
      {page.results.length === 0 ? <p data-testid="read-check-no-results">{text.noResults}</p> : page.results.map((job) => (
        <section key={job.jobId} data-testid="read-check-job" data-job-id={job.jobId}>
          <h3>
            <Link to="/jobs/$jobId" params={{ jobId: job.jobId }}>{text.resultsJob(formatDateTime(job.recordedAt))}</Link>
          </h3>
          <dl className="facts">
            <dt>{text.recordedAt}</dt>
            <dd>{formatDateTime(job.recordedAt)}</dd>
            {job.endReason === null ? null : (
              <>
                <dt>{text.endReason}</dt>
                <dd>{readCheckEndReasonDisplay(job.endReason).label}</dd>
              </>
            )}
          </dl>
          {job.evidenceHref === null ? <p>{text.evidenceUnavailable}</p> : (
            <p>
              <a href={job.evidenceHref} download data-testid="read-check-evidence">{text.openEvidence}</a>
            </p>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{columns.definition}</th>
                  <th scope="col">{columns.revision}</th>
                  <th scope="col">{columns.result}</th>
                  <th scope="col">{columns.detail}</th>
                  <th scope="col">{columns.httpStatus}</th>
                  <th scope="col">{columns.expectations}</th>
                </tr>
              </thead>
              <tbody>
                {job.results.map((result) => {
                  const display = readCheckResultDisplay(result.result);
                  const definition = page.definitions.find((view) => view.readCheckId === result.readCheckId);
                  return (
                    <tr
                      key={result.readCheckId}
                      data-testid="read-check-result"
                      data-job-id={job.jobId}
                      data-read-check-id={result.readCheckId}
                      data-result={result.result}
                      data-detail={result.detail ?? ''}
                    >
                      <th scope="row" className="cell-break">
                        {definition === undefined || definition.candidate === null
                          ? text.definitionRemoved
                          : <code>{pageTextOf(definition.candidate, page.showOrigins)}</code>}
                      </th>
                      <td className="nowrap">{LOCAL_UI_TEXT.profileForm.revisionText(result.readCheckRevision)}</td>
                      <td>
                        <span className={toneClass(display.tone)}>{display.label}</span>
                        {display.description === null ? null : <p className="muted">{display.description}</p>}
                      </td>
                      <td>{result.detail === null ? LOCAL_UI_DISCOVERY_TEXT.noFlags : READ_CHECK_DETAIL_DESCRIPTIONS[result.detail]}</td>
                      <td>{result.httpStatus === null ? LOCAL_UI_DISCOVERY_TEXT.noFlags : String(result.httpStatus)}</td>
                      <td>
                        {result.expectations.length === 0 ? LOCAL_UI_DISCOVERY_TEXT.noFlags : (
                          <ul>
                            {result.expectations.map((expectation, index) => (
                              <li key={String(index)} data-result={expectation.result}>{expectationResultText(expectation)}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {job.notExecuted.length === 0 ? null : (
            <>
              <h4>{text.notExecuted}</h4>
              <ul>
                {job.notExecuted.map((check) => (
                  <li key={check.readCheckId} data-read-check-id={check.readCheckId}>{readCheckEndReasonDisplay(check.reason).label}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      ))}
    </section>
  );
}

/**
 * READ の確かめ（Task 27 の設計書 4.5、4.7。T27f）。プロファイルの詳細から開く。「READ を確かめる」（`READ_CHECK` のジョブ。始められない理由を出し、
 * 始められないときはボタンを出さない）、定義の一覧（送る値と期待。変更と削除は定義の画面）、READ の候補（定義を作る）、結果（定義ごと）。
 */
function ReadChecksPage() {
  const page = Route.useLoaderData();
  const { notice } = Route.useSearch();
  const start = useServerFn(startReadCheckFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [rejection, setRejection] = useState<Extract<AuditJobStartView, { ok: false }> | null>(null);
  const { profile } = page;
  const columns = text.columns;

  return (
    <PageFrame title={text.pages.readChecks}>
      {notice === undefined ? null : (
        <Notice kind="positive">
          <p data-testid="read-check-notice" data-notice={notice}>{NOTICE_TEXT[notice]}</p>
        </Notice>
      )}
      <ProfileSummary profile={profile} testId="read-check-profile" />

      {page.eligible ? null : (
        <Notice kind="caution">
          <p data-testid="read-check-not-eligible">{text.notEligible}</p>
        </Notice>
      )}
      {page.eligible && !page.editable ? (
        <Notice kind="caution">
          <p data-testid="read-check-retired">{text.retired}</p>
        </Notice>
      ) : null}

      <section className="panel">
        <h2 className="panel-heading">{text.heading}</h2>
        <p data-testid="read-check-guidance">{text.guidance}</p>
        {page.start.blocker === null ? (
          <>
            {rejection === null ? null : (
              <Notice kind="critical" heading={text.rejectedHeading}>
                <StartReasonDetails
                  profileId={profile.profileId}
                  reason={rejection.reason}
                  errorCodes={rejection.errorCodes}
                  configError={null}
                  authSetupErrors={rejection.authSetupErrors}
                  nextAllowedAt={rejection.nextAllowedAt ?? null}
                  showLoginCheckLink
                />
                <div className="button-row">
                  <button type="button" className="button" onClick={() => void router.invalidate().then(() => setRejection(null))}>
                    {LOCAL_UI_TEXT.reload}
                  </button>
                </div>
              </Notice>
            )}
            <form
              className="form-grid"
              onSubmit={(event) => {
                event.preventDefault();
                setSubmitting(true);
                void start({ data: { profileId: profile.profileId, expectedRevision: profile.revision } })
                  .then((started) => {
                    if (started.ok) {
                      setRejection(null);
                      return navigate({ to: '/jobs/$jobId', params: { jobId: started.jobId } });
                    }
                    setRejection(started);
                    return undefined;
                  })
                  .finally(() => setSubmitting(false));
              }}
            >
              <div className="button-row">
                <button type="submit" className="button button--primary" disabled={submitting} data-testid="read-check-start">
                  {submitting ? text.submitting : text.submit}
                </button>
              </div>
            </form>
          </>
        ) : (
          <Notice kind="critical" heading={text.cannotStartHeading}>
            <StartReasonDetails
              profileId={profile.profileId}
              reason={page.start.blocker}
              errorCodes={page.start.errorCodes}
              configError={page.configError}
              authSetupErrors={page.start.authSetupErrors}
              nextAllowedAt={page.start.nextAllowedAt}
              showLoginCheckLink
            />
          </Notice>
        )}
      </section>

      <section className="panel" data-testid="read-check-definitions">
        <h2 className="panel-heading">{text.definitionsHeading}</h2>
        <p className="muted">{text.definitionCount(formatCount(page.definitions.length), formatCount(page.form.maxDefinitions))}</p>
        <p className="muted">{text.valuesNote}</p>
        {page.definitions.length === 0 ? <p data-testid="read-check-no-definitions">{text.noDefinitions}</p> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{columns.page}</th>
                  <th scope="col">{columns.parameters}</th>
                  <th scope="col">{columns.expectations}</th>
                  <th scope="col">{columns.revision}</th>
                  <th scope="col">{columns.updatedAt}</th>
                  <th scope="col">{columns.operations}</th>
                </tr>
              </thead>
              <tbody>
                {page.definitions.map((definition) => (
                  <tr key={definition.readCheckId} data-testid="read-check-definition" data-read-check-id={definition.readCheckId}>
                    <th scope="row" className="cell-break">
                      {definition.candidate === null
                        ? <span className={toneClass('caution')}>{text.candidateMissing}</span>
                        : <code>{pageTextOf(definition.candidate, page.showOrigins)}</code>}
                    </th>
                    <td className="cell-break" data-testid="read-check-definition-parameters">{parametersText(definition.definition.parameters)}</td>
                    <td className="cell-break">
                      <ul>
                        {definition.definition.expectations.map((expectation, index) => <li key={String(index)}>{expectationText(expectation)}</li>)}
                      </ul>
                    </td>
                    <td className="nowrap">{LOCAL_UI_TEXT.profileForm.revisionText(definition.revision)}</td>
                    <td className="nowrap">{formatDateTime(definition.updatedAt)}</td>
                    <td className="nowrap">
                      <Link
                        to="/read-checks/$profileId/$readCheckId"
                        params={{ profileId: profile.profileId, readCheckId: definition.readCheckId }}
                        data-testid="read-check-edit"
                      >
                        {page.editable ? text.edit : text.remove}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" data-testid="read-check-candidates">
        <h2 className="panel-heading">{text.candidatesHeading}</h2>
        <p className="muted">{text.candidatesNote}</p>
        {page.candidates.length === 0 ? <p data-testid="read-check-no-candidates">{text.noCandidates}</p> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{columns.page}</th>
                  <th scope="col">{columns.action}</th>
                  <th scope="col">{columns.submitterWords}</th>
                  <th scope="col">{columns.operations}</th>
                </tr>
              </thead>
              <tbody>
                {page.candidates.map((candidate) => (
                  <tr key={candidate.identityDigest} data-testid="read-check-candidate" data-digest={candidate.identityDigest}>
                    <th scope="row" className="cell-break"><code>{pageTextOf(candidate, page.showOrigins)}</code></th>
                    <td className="cell-break"><code>{actionTextOf(candidate, page.showOrigins)}</code></td>
                    <td>{LOCAL_UI_DISCOVERY_TEXT.submitterWordsValue(candidate.submitterWords)}</td>
                    <td>
                      {page.editable ? (
                        <Link
                          to="/read-checks/$profileId/new"
                          params={{ profileId: profile.profileId }}
                          search={{ candidate: candidate.identityDigest }}
                          data-testid="read-check-create"
                        >
                          {text.create}
                        </Link>
                      ) : LOCAL_UI_DISCOVERY_TEXT.noFlags}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Results page={page} />

      <div className="button-row">
        <Link to="/discovery/$profileId" params={{ profileId: profile.profileId }} className="button">{text.openDiscovery}</Link>
        <Link to="/profiles/$profileId" params={{ profileId: profile.profileId }} className="button">{LOCAL_UI_DISCOVERY_TEXT.backToProfile}</Link>
      </div>
    </PageFrame>
  );
}

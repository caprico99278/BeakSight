import { useState } from 'react';
import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { compareCodeUnits } from '../../../../../src/core/text.js';
import { CANDIDATE_CLASSIFICATION_CATALOG } from '../../../../../src/presentation/catalog.js';
import { formatCount, formatDateTime } from '../../../../../src/presentation/format.js';
import {
  CANDIDATE_REASON_DESCRIPTIONS,
  DISCOVERY_INCOMPLETE_REASON_DESCRIPTIONS,
  DISCOVERY_UNREAD_REASON_LABELS,
  LOCAL_UI_DISCOVERY_TEXT,
  LOCAL_UI_SCENARIO_TEXT,
  LOCAL_UI_TEXT,
  cliFieldText,
  labelWithCodeText,
  listText,
} from '../../../../../src/presentation/messages.js';
import { Notice } from '../../components/Notice';
import { PageFrame } from '../../components/PageFrame';
import { ProfileSummary } from '../../components/ProfileSummary';
import { StartReasonDetails } from '../../components/StartReasonDetails';
import { candidateFieldConstraintsText, candidateFieldFlagsText } from '../../display/candidate-fields';
import {
  candidateClassificationDisplay,
  candidateKindDisplay,
  discoveryDriftDisplay,
  discoveryEndReasonDisplay,
  runStatusDisplay,
  toneClass,
  usesScenarios,
} from '../../display/labels';
import type { AuditJobStartView } from '../../server/audit-job-functions';
import type { CandidateFieldView, DiscoveryCandidateDetailView } from '../../server/discovery-documents';
import { discoveryPageFn, startDiscoveryFn, type DiscoveryCandidateView, type DiscoveryPageView } from '../../server/discovery-functions';

export const Route = createFileRoute('/discovery/$profileId')({
  loader: async ({ params }) => {
    const page = await discoveryPageFn({ data: { profileId: params.profileId } });
    if (page === null) {
      throw notFound();
    }
    return page;
  },
  component: DiscoveryPage,
});

const text = LOCAL_UI_DISCOVERY_TEXT;

/** 取り消していないプロファイルの状態。 */
const ACTIVE_PROFILE_STATUS = 'ACTIVE';

/** 候補の画面のまとまり（画面の Origin と path）。 */
interface CandidateGroup {
  readonly key: string;
  readonly origin: string | null;
  readonly path: string;
  readonly candidates: readonly DiscoveryCandidateView[];
}

/**
 * 候補を、画面ごとにまとめる（許可 Origin が 2 つ以上なら、画面の Origin でも分ける。T27c の申し送り 3）。まとまりは path、Origin の順、
 * まとまりの中は、分類の表示の順、種類、識別の digest の順。
 */
const groupsOf = (page: DiscoveryPageView): readonly CandidateGroup[] => {
  const groups = new Map<string, { origin: string | null; path: string; candidates: DiscoveryCandidateView[] }>();
  for (const candidate of page.candidates) {
    const origin = page.showOrigins ? candidate.detail?.pageOrigin ?? null : null;
    const key = `${candidate.pagePath} ${origin ?? ''}`;
    const group = groups.get(key) ?? { origin, path: candidate.pagePath, candidates: [] };
    group.candidates.push(candidate);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, group]) => ({
      key,
      origin: group.origin,
      path: group.path,
      candidates: [...group.candidates].sort((left, right) =>
        CANDIDATE_CLASSIFICATION_CATALOG[left.classification].order - CANDIDATE_CLASSIFICATION_CATALOG[right.classification].order
        || compareCodeUnits(left.identityDigest, right.identityDigest)),
    }));
};

/** まとまりの見出し（Origin を示すときは、Origin と path を続けて示す）。 */
const groupHeadingOf = (group: CandidateGroup, showOrigins: boolean): string =>
  (showOrigins ? `${group.origin ?? `${text.originUnknown} `}${group.path}` : group.path);

/** 送り方の表示（form の method と `_method` の上書き。form の外のボタンは「なし」）。 */
const methodTextOf = (candidate: DiscoveryCandidateView): string => {
  if (candidate.formMethod === null) {
    return text.noAction;
  }
  return candidate.methodOverride === null ? candidate.formMethod : text.methodOverride(candidate.formMethod, candidate.methodOverride);
};

/** 送信先の表示（Origin を示すときは、Origin と path）。 */
const actionTextOf = (candidate: DiscoveryCandidateView, showOrigins: boolean): string => {
  if (candidate.actionPath === null) {
    return text.noAction;
  }
  const origin = showOrigins ? candidate.detail?.action?.origin ?? '' : '';
  return `${origin}${candidate.actionPath}`;
};

/** 選択肢の値の表示（見えない欄と秘密に見える名前の欄は示さない）。 */
const fieldOptionsOf = (field: CandidateFieldView): string => {
  if (field.optionsWithheld) {
    return text.optionsHidden;
  }
  if (field.options === null) {
    return text.noOptions;
  }
  const values = field.options.map((option) => JSON.stringify(option));
  return field.omittedOptionCount > 0 ? listText([...values, text.optionsOmitted(formatCount(field.omittedOptionCount))]) : listText(values);
};

/** 候補の詳しい内容（候補を最後に見た発見のジョブの `discovery.json` から）。 */
function CandidateDetail({ candidate, detail }: Readonly<{ candidate: DiscoveryCandidateView; detail: DiscoveryCandidateDetailView }>) {
  const classification = candidateClassificationDisplay(candidate.classification);
  return (
    <>
      {classification.description === null ? null : <p>{classification.description}</p>}
      <dl className="facts">
        <dt>{text.submitterWords}</dt>
        <dd>{text.submitterWordsValue(detail.submitterWords)}</dd>
        <dt>{text.enctype}</dt>
        <dd>{detail.enctype ?? text.noFlags}</dd>
        <dt>{text.target}</dt>
        <dd>{detail.target === null || detail.target === '' ? text.noFlags : detail.target}</dd>
        <dt>{text.queryNames}</dt>
        <dd>{detail.action === null || detail.action.queryNames.length === 0 ? text.noFlags : listText(detail.action.queryNames)}</dd>
        <dt>{text.listeners}</dt>
        <dd>
          {detail.listenerKinds.length === 0 && !detail.inlineHandler
            ? text.noListeners
            : listText([...detail.listenerKinds, ...(detail.inlineHandler ? [text.inlineHandler] : [])])}
        </dd>
        <dt>{text.firstSeenAt}</dt>
        <dd>{formatDateTime(candidate.firstSeenAt)}</dd>
        <dt>{text.lastSeenAt}</dt>
        <dd>{formatDateTime(candidate.lastSeenAt)}</dd>
      </dl>
      {detail.incompleteReasons.length === 0 ? null : (
        <ul>
          {detail.incompleteReasons.map((reason) => <li key={reason}>{DISCOVERY_INCOMPLETE_REASON_DESCRIPTIONS[reason]}</li>)}
        </ul>
      )}
      <h4>{text.fieldsHeading}</h4>
      {detail.fields.length === 0 ? <p>{text.noFields}</p> : (
        <div className="table-wrap">
          <table data-testid="candidate-fields">
            <thead>
              <tr>
                <th scope="col">{text.fieldColumns.name}</th>
                <th scope="col">{text.fieldColumns.type}</th>
                <th scope="col">{text.fieldColumns.flags}</th>
                <th scope="col">{text.fieldColumns.constraints}</th>
                <th scope="col">{text.fieldColumns.options}</th>
                <th scope="col">{text.fieldColumns.sendable}</th>
              </tr>
            </thead>
            <tbody>
              {detail.fields.map((field, index) => (
                <tr key={`${field.name}:${String(index)}`} data-field-name={field.name} data-sendable={String(field.sendable)}>
                  <th scope="row">{field.name === '' ? text.unnamedField : <code>{field.name}</code>}</th>
                  <td><code>{field.type}</code></td>
                  <td>{candidateFieldFlagsText(field)}</td>
                  <td>{candidateFieldConstraintsText(field)}</td>
                  <td>{fieldOptionsOf(field)}</td>
                  <td>
                    {field.secretLike ? text.secretLikeField : field.sendable ? text.sendableYes : text.sendableNo}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** 候補の 1 行と、詳しい内容。 */
function CandidateRows({ candidate, page, editable }: Readonly<{ candidate: DiscoveryCandidateView; page: DiscoveryPageView; editable: boolean }>) {
  const classification = candidateClassificationDisplay(candidate.classification);
  const drift = discoveryDriftDisplay(candidate.drift);
  const kind = candidate.detail === null ? null : candidateKindDisplay(candidate.detail.kind);
  return (
    <>
      <tr
        data-testid="discovery-candidate"
        data-digest={candidate.identityDigest}
        data-classification={candidate.classification}
        data-reason={candidate.reasonCode}
        data-drift={candidate.drift}
      >
        <td className="nowrap">{kind?.label ?? text.noFlags}</td>
        <td>
          <span className={toneClass(classification.tone)}>{classification.label}</span>
          <p className="muted">{CANDIDATE_REASON_DESCRIPTIONS[candidate.reasonCode]}</p>
        </td>
        <td className="nowrap">
          <span className={toneClass(drift.tone)} data-testid="candidate-drift">{drift.label}</span>
        </td>
        <td className="nowrap">{methodTextOf(candidate)}</td>
        <td className="cell-break"><code>{actionTextOf(candidate, page.showOrigins)}</code></td>
        <td>{candidate.hasStateField ? text.stateFieldMarked : text.stateFieldNone}</td>
        <td data-testid="candidate-execution">
          {candidate.readCheckable ? (
            <>
              <span className={toneClass('positive')}>{text.readCheckable}</span>
              {editable ? (
                <p className="cell-action">
                  <Link
                    to="/read-checks/$profileId/new"
                    params={{ profileId: page.profile.profileId }}
                    search={{ candidate: candidate.identityDigest }}
                    data-testid="candidate-create-read-check"
                  >
                    {text.createReadCheck}
                  </Link>
                </p>
              ) : null}
            </>
          ) : (
            <>
              <span className={toneClass('neutral')}>{text.notExecutable}</span>
              {/* T28e（Task 28 の設計書 4.6）: シナリオを使うプロファイルの、最後の発見の登録・更新の候補だけに「シナリオを作る」を出す。 */}
              {editable && candidate.scenarioCreatable ? (
                <p className="cell-action">
                  <Link
                    to="/scenarios/$profileId/new"
                    params={{ profileId: page.profile.profileId }}
                    search={{ candidate: candidate.identityDigest }}
                    data-testid="candidate-create-scenario"
                  >
                    {LOCAL_UI_SCENARIO_TEXT.createFromCandidate}
                  </Link>
                </p>
              ) : null}
            </>
          )}
        </td>
      </tr>
      <tr>
        <td colSpan={7}>
          <details data-testid="candidate-detail">
            <summary>{text.detailSummary}</summary>
            {drift.description === null ? null : <p className="muted">{drift.description}</p>}
            {candidate.detail === null ? <p>{text.detailUnavailable}</p> : <CandidateDetail candidate={candidate} detail={candidate.detail} />}
          </details>
        </td>
      </tr>
    </>
  );
}

/**
 * 操作の候補（Task 27 の設計書 4.4、4.7。T27f）。プロファイルの詳細から開く。「操作の候補を探す」（`DISCOVERY` のジョブ。始められない理由を出し、
 * 始められないときはボタンを出さない）、最後の発見の要点、候補の一覧（画面ごと、分類ごと。分類の理由、ドリフト、状態の欄の印、この画面から
 * 実行できるか）と、候補の詳しい内容（欄の型と制約、送信先、送り方）。値・トークン・選択肢の label は、サーバが返さない。
 */
function DiscoveryPage() {
  const page = Route.useLoaderData();
  const start = useServerFn(startDiscoveryFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [rejection, setRejection] = useState<Extract<AuditJobStartView, { ok: false }> | null>(null);
  const { profile, latest } = page;
  const editable = page.eligible && profile.status === ACTIVE_PROFILE_STATUS;
  const result = latest?.result ?? null;
  const groups = groupsOf(page);

  return (
    <PageFrame title={text.pages.discovery}>
      <ProfileSummary profile={profile} testId="discovery-profile" />

      {page.eligible ? null : (
        <Notice kind="caution">
          <p data-testid="discovery-not-eligible">{text.notEligible}</p>
        </Notice>
      )}

      <section className="panel">
        <h2 className="panel-heading">{text.heading}</h2>
        <p data-testid="discovery-guidance">{text.guidance}</p>
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
                <button type="submit" className="button button--primary" disabled={submitting} data-testid="discovery-start">
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

      <section className="panel" data-testid="discovery-latest">
        <h2 className="panel-heading">{text.latestHeading}</h2>
        {latest === null ? <p data-testid="discovery-no-records">{text.noDiscovery}</p> : (
          <>
            <dl className="facts">
              <dt>{text.latestJob}</dt>
              <dd><Link to="/jobs/$jobId" params={{ jobId: latest.jobId }}>{text.openJob}</Link></dd>
              <dt>{text.latestRecordedAt}</dt>
              <dd>{formatDateTime(latest.recordedAt)}</dd>
              {result === null ? null : (
                <>
                  <dt>{text.endReason}</dt>
                  <dd>
                    <span className={toneClass(discoveryEndReasonDisplay(result.endReason).tone)} data-testid="discovery-end-reason" data-reason={result.endReason}>
                      {discoveryEndReasonDisplay(result.endReason).label}
                    </span>
                  </dd>
                  <dt>{text.runStatus}</dt>
                  <dd>{labelWithCodeText(runStatusDisplay(result.runStatus).label, result.runStatus)}</dd>
                  <dt>{text.pagesRead}</dt>
                  <dd data-testid="discovery-pages-read">{formatCount(result.pagesRead)}</dd>
                  <dt>{text.pagesNotRead}</dt>
                  <dd>{formatCount(result.pagesNotRead)}</dd>
                  <dt>{text.maxPages}</dt>
                  <dd>{formatCount(result.maxPages)}</dd>
                </>
              )}
            </dl>
            {result === null ? <p>{text.resultUnavailable}</p> : (
              <>
                {discoveryEndReasonDisplay(result.endReason).description === null ? null : (
                  <p className="muted">{discoveryEndReasonDisplay(result.endReason).description}</p>
                )}
                {result.unreadReasons.length === 0 ? null : (
                  <>
                    <h3>{text.unreadReasonsHeading}</h3>
                    <ul data-testid="discovery-unread-reasons">
                      {result.unreadReasons.map(({ reason, count }) => (
                        <li key={reason} data-reason={reason}>{cliFieldText(DISCOVERY_UNREAD_REASON_LABELS[reason], formatCount(count))}</li>
                      ))}
                    </ul>
                  </>
                )}
                {result.incompletePages.length === 0 ? null : (
                  <>
                    <h3>{text.incompletePagesHeading}</h3>
                    <ul data-testid="discovery-incomplete-pages">
                      {result.incompletePages.map((incomplete) => (
                        <li key={incomplete.url}>
                          <code>{incomplete.path === null ? incomplete.url : `${page.showOrigins ? incomplete.origin ?? '' : ''}${incomplete.path}`}</code>
                          {': '}
                          {listText(incomplete.reasons.map((reason) => DISCOVERY_INCOMPLETE_REASON_DESCRIPTIONS[reason]))}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </>
        )}
      </section>

      <section className="panel" data-testid="discovery-candidates">
        <h2 className="panel-heading">{text.candidatesHeading}</h2>
        {groups.length === 0 ? <p data-testid="discovery-no-candidates">{text.noCandidates}</p> : groups.map((group) => (
          <section key={group.key} data-testid="discovery-page" data-page-path={group.path} data-page-origin={group.origin ?? ''}>
            <h3>
              <span className="muted">{`${text.pageHeading} `}</span>
              <code>{groupHeadingOf(group, page.showOrigins)}</code>
            </h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col" className="nowrap">{text.columns.kind}</th>
                    <th scope="col">{text.columns.classification}</th>
                    <th scope="col" className="nowrap">{text.columns.drift}</th>
                    <th scope="col" className="nowrap">{text.columns.method}</th>
                    <th scope="col">{text.columns.action}</th>
                    <th scope="col" className="nowrap">{text.columns.stateField}</th>
                    <th scope="col">{text.columns.execution}</th>
                  </tr>
                </thead>
                <tbody>
                  {group.candidates.map((candidate) => (
                    <CandidateRows key={candidate.identityDigest} candidate={candidate} page={page} editable={editable} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </section>

      <div className="button-row">
        <Link to="/read-checks/$profileId" params={{ profileId: profile.profileId }} className="button">{text.openReadChecks}</Link>
        {usesScenarios(profile.mode, profile.auth) ? (
          <Link to="/scenarios/$profileId" params={{ profileId: profile.profileId }} className="button">{LOCAL_UI_SCENARIO_TEXT.profileDetail.open}</Link>
        ) : null}
        <Link to="/profiles/$profileId" params={{ profileId: profile.profileId }} className="button">{text.backToProfile}</Link>
      </div>
    </PageFrame>
  );
}

import { useState } from 'react';
import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import type { SideEffectConfirmation } from '../../../../../../../src/control/approval-view.js';
// PRE42-CC 組 UI-K（組 2 の引き継ぎ。CC-106）: シナリオの種類の値は、管理データに触れない純粋な owner から読む（文字列で比べない）。
import { UPDATE_SCENARIO_KIND } from '../../../../../../../src/core/scenario-kind.js';
import { SIDE_EFFECT_CONFIRMATION_CATALOG, sortByDisplayOrder } from '../../../../../../../src/presentation/catalog.js';
import { formatCount, formatDateTime, formatInteger } from '../../../../../../../src/presentation/format.js';
import {
  LOCAL_UI_AUTO_DRAFT_TEXT,
  LOCAL_UI_DISCOVERY_TEXT,
  LOCAL_UI_SCENARIO_TEXT,
  LOCAL_UI_WRITE_TEXT,
  SCENARIO_REQUEST_REJECTION_DESCRIPTIONS,
  listText,
} from '../../../../../../../src/presentation/messages.js';
import { ConfirmDialog } from '../../../../components/ConfirmDialog';
import { DraftValueMark } from '../../../../components/DraftValueMark';
import { Notice } from '../../../../components/Notice';
import { PageFrame } from '../../../../components/PageFrame';
import { ScenarioApiShape } from '../../../../components/ScenarioApiShape';
import { ScenarioProfilePanel } from '../../../../components/ScenarioProfilePanel';
import { ScenarioStatus } from '../../../../components/ScenarioStatus';
import { WriteResultHistory } from '../../../../components/WriteResultDetails';
import { candidateFieldConstraintsText, candidateFieldFlagsText } from '../../../../display/candidate-fields';
import {
  approvalDigestItemDisplay,
  approvalInvalidityReasonDisplay,
  approvalReceiptKindDisplay,
  candidateKindDisplay,
  inputRuleStateDisplay,
  recordIdSourceDisplay,
  revocationReasonDisplay,
  scenarioVerificationItemDisplay,
  scenarioKindDisplay,
  sideEffectConfirmationDisplay,
  toneClass,
} from '../../../../display/labels';
import {
  approveScenarioFn,
  revokeScenarioFn,
  scenarioDetailPageFn,
  type ScenarioDetailPageView,
  type ScenarioRejectionView,
} from '../../../../server/scenario-functions';

/** 操作の後に出す知らせ（URL の search で渡す。値は閉じた一覧）。 */
// FM2b: `autoRules`・`autoRulesFailed` は、自動の下書きの案内から作った更新の保存の後（推した入力の規則を付けた・付けられなかった）。
const NOTICES = Object.freeze(['saved', 'approved', 'revoked', 'autoRules', 'autoRulesFailed'] as const);
type ScenarioNotice = (typeof NOTICES)[number];
const isScenarioNotice = (value: unknown): value is ScenarioNotice => NOTICES.some((notice) => notice === value);

export const Route = createFileRoute('/scenarios/$profileId/$scenarioId/')({
  validateSearch: (search: Record<string, unknown>): { notice?: ScenarioNotice } =>
    (isScenarioNotice(search['notice']) ? { notice: search['notice'] } : {}),
  loader: async ({ params }) => {
    const page = await scenarioDetailPageFn({ data: { scenarioId: params.scenarioId } });
    if (page === null || page.profile.profileId !== params.profileId) {
      throw notFound();
    }
    return page;
  },
  component: ScenarioDetailPage,
});

const text = LOCAL_UI_SCENARIO_TEXT;
const discoveryText = LOCAL_UI_DISCOVERY_TEXT;

/** 承認したシナリオの保存の状態（撤回の操作を出すか）。 */
const APPROVED_STATE = 'APPROVED';

const NOTICE_TEXT: Readonly<Record<ScenarioNotice, string>> = Object.freeze({
  saved: text.saved,
  approved: text.approved,
  revoked: text.revoked,
  autoRules: LOCAL_UI_AUTO_DRAFT_TEXT.savedWithRules,
  autoRulesFailed: LOCAL_UI_AUTO_DRAFT_TEXT.savedRulesFailed,
});

/** FM2b: 自動の下書きが推した値のまま残る項目（項目、値、出どころの印と根拠）。 */
function InferredItems({ page, testId }: Readonly<{ page: ScenarioDetailPageView; testId: string }>) {
  return (
    <ul data-testid={testId}>
      {page.inferredItems.map((item) => (
        <li key={`${item.item}:${item.value}`} data-item={item.item} data-value={item.value}>
          {LOCAL_UI_AUTO_DRAFT_TEXT.inferredItems[item.item]}: <code>{item.value}</code>{' '}
          <DraftValueMark origin={item.origin} ground={item.ground} />
        </li>
      ))}
    </ul>
  );
}

/** 上限の表示。 */
const limitsTextOf = (page: ScenarioDetailPageView): string =>
  text.limitsValue(formatCount(page.scenario.limits.maxCreatesPerRun), formatCount(page.used), formatCount(page.scenario.limits.maxCumulativeCreates));

const writeText = LOCAL_UI_WRITE_TEXT;

/** 検証の指定の項目ごとの値（T30g。未指定は「未指定」。T40a-fix: 出す項目は `page.verificationItems`）。 */
function Verification({ page }: Readonly<{ page: ScenarioDetailPageView }>) {
  const { successCondition, inputErrorCondition, recordId, readVerification } = page.scenario.verification;
  const apiRecordIdKey = page.scenario.api?.recordId?.key ?? null;
  const valueOf = (item: 'successCondition' | 'inputErrorCondition' | 'recordId' | 'readVerification'): string => {
    switch (item) {
      case 'successCondition':
        return successCondition === null ? writeText.verificationItemUnset : writeText.conditionValue(successCondition.pathPrefix, successCondition.selector);
      case 'inputErrorCondition':
        return inputErrorCondition === null
          ? writeText.verificationItemUnset
          : writeText.conditionValue(inputErrorCondition.pathPrefix, inputErrorCondition.selector);
      case 'recordId':
        // T40a-fix: API のシナリオは、応答の本文の鍵（`api.recordId`）でも ID を取れる（検証の指定の取り方がなければ、そちらを出す）。
        if (recordId === null) {
          return apiRecordIdKey === null ? writeText.verificationItemUnset : writeText.apiRecordIdValue(apiRecordIdKey);
        }
        return listText([recordIdSourceDisplay(recordId.source).label, recordId.source === 'URL_PATH_PATTERN' ? recordId.pathPattern : recordId.selector]);
      case 'readVerification':
        return readVerification === null
          ? writeText.verificationItemUnset
          : writeText.readVerificationValue(readVerification.readCheckId, formatInteger(readVerification.revision), formatCount(readVerification.expectations.length));
    }
  };
  return (
    <dl className="facts" data-testid="scenario-verification-values">
      {/* T40a-fix: 求める項目だけを出す（API のシナリオは ID の取り方と照合の READ。成否の条件と入力の誤りの条件は使わないので出さない）。 */}
      {page.verificationItems.map((item) => [
        <dt key={`${item}:label`}>{scenarioVerificationItemDisplay(item).label}</dt>,
        <dd key={`${item}:value`} data-item={item} data-set={String(!page.missingVerification.includes(item))}><code>{valueOf(item)}</code></dd>,
      ])}
    </dl>
  );
}

/** T31h-1: UPDATE の指定（台帳、path の型、変える欄・保つ欄）と、更新の予定のレコード。 */
function UpdateSpec({ page }: Readonly<{ page: ScenarioDetailPageView }>) {
  const { update, fieldNames, api } = page.scenario;
  const updateText = text.update;
  // T38f: API の UPDATE は、form の UPDATE の指定を持たず、台帳の参照（`api.ledger`）を持つ（送信先の path の型と保つ欄はない）。
  const apiLedger = api?.ledger ?? null;
  if (update === null && apiLedger === null) {
    return <p data-testid="scenario-update-spec-missing">{updateText.specMissing}</p>;
  }
  const ledger = page.updateLedger;
  const targetCreateScenarioId = update?.targetCreateScenarioId ?? apiLedger?.targetCreateScenarioId ?? '';
  const formPathTemplate = update?.formPathTemplate ?? apiLedger?.formPathTemplate ?? '';
  return (
    <>
      <dl className="facts" data-testid="scenario-update-values">
        <dt>{updateText.ledger}</dt>
        <dd data-testid="scenario-update-ledger-value" data-scenario-id={targetCreateScenarioId}>
          {ledger === null || ledger.pagePath === null
            ? <code>{targetCreateScenarioId}</code>
            : (
              <Link to="/scenarios/$profileId/$scenarioId" params={{ profileId: page.profile.profileId, scenarioId: ledger.scenarioId }}>
                {updateText.ledgerOption(ledger.scenarioId, ledger.pagePath)}
              </Link>
            )}
        </dd>
        <dt>{updateText.formPathTemplate}</dt>
        <dd data-testid="scenario-update-form-template"><code>{formPathTemplate}</code></dd>
        {update === null ? null : (
          <>
            <dt>{updateText.actionPathTemplate}</dt>
            <dd data-testid="scenario-update-action-template"><code>{update.actionPathTemplate}</code></dd>
          </>
        )}
        <dt>{updateText.changedFields}</dt>
        <dd data-testid="scenario-update-changed">{fieldNames.length === 0 ? updateText.none : listText(fieldNames)}</dd>
        {update === null ? null : (
          <>
            <dt>{updateText.keptFields}</dt>
            <dd data-testid="scenario-update-kept">{update.keepFieldNames.length === 0 ? updateText.none : listText(update.keepFieldNames)}</dd>
          </>
        )}
      </dl>
      <h3>{updateText.plannedTarget}</h3>
      <p className="field-hint">{updateText.plannedTargetNote}</p>
      {page.plannedUpdateTarget === null
        ? <p data-testid="scenario-update-planned" data-target="">{updateText.noPlannedTarget}</p>
        : <p data-testid="scenario-update-planned" data-target={page.plannedUpdateTarget}><code>{page.plannedUpdateTarget}</code></p>}
    </>
  );
}

/** 副作用の確認の一覧（項目と、確かめたか）。 */
function SideEffects({ page }: Readonly<{ page: ScenarioDetailPageView }>) {
  const items = sortByDisplayOrder(Object.keys(page.scenario.sideEffectConfirmations) as SideEffectConfirmation[], SIDE_EFFECT_CONFIRMATION_CATALOG);
  return (
    <ul data-testid="scenario-side-effects">
      {items.map((item) => {
        const confirmed = page.scenario.sideEffectConfirmations[item];
        return (
          <li key={item} data-item={item} data-confirmed={String(confirmed)}>
            {`${sideEffectConfirmationDisplay(item).label}: `}
            <span className={toneClass(confirmed ? 'positive' : 'caution')}>{confirmed ? text.sideEffectConfirmed : text.sideEffectUnconfirmed}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** 最後の承認との差分（項目ごとの機械の読める差分と、日本語の説明）。 */
function Differences({ page }: Readonly<{ page: ScenarioDetailPageView }>) {
  if (page.lastApprovalRevision === null) {
    return <p data-testid="scenario-diff-none">{text.noApproval}</p>;
  }
  if (page.differences === null) {
    return <p data-testid="scenario-diff-unavailable">{text.factsUnavailable}</p>;
  }
  if (page.differences.length === 0) {
    return <p data-testid="scenario-diff-empty">{text.noDiff}</p>;
  }
  return (
    <div className="table-wrap">
      <table data-testid="scenario-diff">
        <thead>
          <tr>
            <th scope="col">{text.diffColumns.item}</th>
            <th scope="col">{text.diffColumns.change}</th>
            <th scope="col">{text.diffColumns.description}</th>
          </tr>
        </thead>
        <tbody>
          {page.differences.map((difference) => {
            const display = approvalDigestItemDisplay(difference.item);
            return (
              <tr key={difference.item} data-testid="scenario-diff-item" data-item={difference.item}>
                <th scope="row">{display.label}</th>
                <td className="cell-break"><code>{text.diffValue(JSON.stringify(difference.previous), JSON.stringify(difference.current))}</code></td>
                <td>{display.description}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * シナリオの詳細（Task 28 の設計書 4.6。T28e）。承認の状態と再承認の理由、要求の形、入力の規則の参照、副作用の確認、発見の根拠（写し。欄の型と
 * 制約。値と選択肢は出さない）、最後の承認との差分、承認と撤回の履歴、版の履歴。承認と撤回は、確認のダイアログ（取り消し側にフォーカス）の後に
 * だけ送る。書き込みを実行するボタンは置かない。
 */
function ScenarioDetailPage() {
  const page = Route.useLoaderData();
  const { notice } = Route.useSearch();
  const approve = useServerFn(approveScenarioFn);
  const revoke = useServerFn(revokeScenarioFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [dialog, setDialog] = useState<'approve' | 'revoke' | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejection, setRejection] = useState<ScenarioRejectionView | null>(null);
  const { profile, scenario, evidence, status } = page;
  const kind = scenarioKindDisplay(scenario.kind);
  const params = { profileId: profile.profileId, scenarioId: scenario.scenarioId };
  const approvable = page.editable && status !== null && page.unconfirmedSideEffects.length === 0;
  const finish = (next: ScenarioNotice): void => {
    // 先に今の内容を読み直し（loader）、それから知らせを出す（知らせと内容が食い違わないように）。
    void router.invalidate().then(() => navigate({ to: '/scenarios/$profileId/$scenarioId', params, search: { notice: next }, replace: true }));
  };
  const send = (action: () => Promise<ScenarioRejectionView | { readonly ok: true }>, next: ScenarioNotice): void => {
    setBusy(true);
    void action()
      .then((result) => {
        setDialog(null);
        if (result.ok) {
          setRejection(null);
          finish(next);
        } else {
          setRejection(result);
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <PageFrame title={text.pages.scenario}>
      {notice === undefined ? null : (
        <Notice kind="positive">
          <p data-testid="scenario-notice" data-notice={notice}>{NOTICE_TEXT[notice]}</p>
        </Notice>
      )}
      <ScenarioProfilePanel profile={profile} eligible={page.eligible} editable={page.editable} />

      <section className="panel" data-testid="scenario-status" data-scenario-id={scenario.scenarioId} data-revision={String(scenario.revision)}>
        <h2 className="panel-heading">{text.stateHeading}</h2>
        <div><ScenarioStatus status={status} showDescriptions /></div>
        <dl className="facts">
          <dt>{text.columns.kind}</dt>
          <dd><span className={toneClass(kind.tone)}>{kind.label}</span></dd>
          <dt>{text.columns.revision}</dt>
          <dd>{text.revisionValue(formatInteger(scenario.revision))}</dd>
          <dt>{text.expiresAt}</dt>
          <dd data-testid="scenario-expires-at">{status === null || status.expiresAt === null ? text.noExpiry : formatDateTime(status.expiresAt)}</dd>
          <dt>{text.approvalTtlDays}</dt>
          <dd>{text.daysValue(formatInteger(scenario.approvalTtlDays))}</dd>
          <dt>{text.columns.limits}</dt>
          <dd data-testid="scenario-limits-used">{limitsTextOf(page)}</dd>
        </dl>
        <p className="muted">{text.usedNote}</p>
        <p data-testid="scenario-no-execution">{text.noExecution}</p>
        {page.unconfirmedSideEffects.length === 0 ? null : (
          <Notice kind="caution">
            <p data-testid="scenario-unconfirmed">{text.unconfirmedSideEffects}</p>
          </Notice>
        )}
        {/* T40R2-fix（使える度合い）: 画面から ID を取る型が書き込みの画面にも当たるときの注意（保存の画面と同じ文言。実行は止めない）。 */}
        {page.recordIdPatternCaution ? (
          <Notice kind="caution">
            <p data-testid="scenario-record-id-caution">{writeText.recordIdPatternCaution}</p>
          </Notice>
        ) : null}
        {/* T30g: 検証の指定に未指定の項目があれば、実行できない理由として出す（`VERIFICATION_SPEC_MISSING`）。 */}
        {page.missingVerification.length === 0 ? null : (
          <Notice kind="caution" heading={writeText.verificationMissingHeading}>
            <div data-testid="scenario-verification-missing" data-reason="VERIFICATION_SPEC_MISSING">
              <p>{writeText.verificationMissing}</p>
              <ul>
                {page.missingVerification.map((item) => <li key={item} data-item={item}>{scenarioVerificationItemDisplay(item).label}</li>)}
              </ul>
            </div>
          </Notice>
        )}
        {/* FM2b: 自動の下書きが推した値のまま残る項目と根拠（表示のときに求め直す。承認に結ばない）。 */}
        {page.inferredItems.length === 0 ? null : (
          <Notice kind="caution" heading={LOCAL_UI_AUTO_DRAFT_TEXT.inferredHeading}>
            <p>{LOCAL_UI_AUTO_DRAFT_TEXT.inferredNote}</p>
            <InferredItems page={page} testId="scenario-inferred" />
          </Notice>
        )}
        {rejection === null ? null : (
          <Notice kind="critical" heading={text.actionRejectedHeading}>
            <div data-testid="scenario-action-rejection" data-reason={rejection.reason}>
              <p>{SCENARIO_REQUEST_REJECTION_DESCRIPTIONS[rejection.reason].description}</p>
              <p>{SCENARIO_REQUEST_REJECTION_DESCRIPTIONS[rejection.reason].action}</p>
              {rejection.invalidityReasons.length === 0 ? null : (
                <ul>
                  {rejection.invalidityReasons.map((reason) => (
                    <li key={reason} data-reason={reason}>{approvalInvalidityReasonDisplay(reason).label}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="button-row">
              <button type="button" className="button" onClick={() => void router.invalidate().then(() => setRejection(null))}>{text.reload}</button>
            </div>
          </Notice>
        )}
        <div className="button-row">
          {page.editable ? (
            <Link to="/scenarios/$profileId/$scenarioId/edit" params={params} className="button" data-testid="scenario-edit">{text.edit}</Link>
          ) : null}
          {page.eligible ? (
            <Link to="/scenarios/$profileId/$scenarioId/rules" params={params} className="button" data-testid="scenario-open-rules">{text.openRules}</Link>
          ) : null}
          {page.writeStartAvailable ? (
            <Link to="/scenarios/$profileId/$scenarioId/write" params={params} className="button" data-testid="scenario-open-write">
              {writeText.openWriteStart}
            </Link>
          ) : null}
          {approvable ? (
            <button type="button" className="button button--primary" data-testid="scenario-approve" onClick={() => setDialog('approve')}>
              {text.approve}
            </button>
          ) : null}
          {scenario.state === APPROVED_STATE ? (
            <button type="button" className="button button--danger" data-testid="scenario-revoke" onClick={() => setDialog('revoke')}>
              {text.revoke}
            </button>
          ) : null}
        </div>
      </section>

      {status === null ? null : (
        <ConfirmDialog
          open={dialog === 'approve'}
          title={text.approveDialog.title}
          body={text.approveDialog.body}
          confirmLabel={text.approveDialog.confirm}
          cancelLabel={text.approveDialog.cancel}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => send(
            () => approve({ data: { scenarioId: scenario.scenarioId, expectedRevision: scenario.revision, expectedApprovalDigest: status.approvalDigest } }),
            'approved',
          )}
        >
          <div className="dialog-details" data-testid="scenario-approve-details">
            <dl className="facts">
              <dt>{text.approveDialog.limits}</dt>
              <dd>{limitsTextOf(page)}</dd>
              <dt>{text.approveDialog.ttl}</dt>
              <dd>{text.daysValue(formatInteger(scenario.approvalTtlDays))}</dd>
            </dl>
            {/* T38c: API のシナリオは、承認が縛る要求の型の要約を、承認の前に出す。 */}
            {scenario.api === null ? null : (
              <ScenarioApiShape api={scenario.api} transport={scenario.transport} testId="scenario-approve-api-shape"
                publicationStateKeys={scenario.apiPublicationStateKeys} />
            )}
            {/* FM2b: 推測の項目が 1 つでも残る下書きは、承認の前に一覧を出す。 */}
            {page.inferredItems.length === 0 ? null : (
              <>
                <h3>{LOCAL_UI_AUTO_DRAFT_TEXT.approveInferredHeading}</h3>
                <InferredItems page={page} testId="scenario-approve-inferred" />
              </>
            )}
            <h3>{text.approveDialog.sideEffects}</h3>
            <SideEffects page={page} />
            <h3>{text.approveDialog.diff}</h3>
            <Differences page={page} />
          </div>
        </ConfirmDialog>
      )}
      <ConfirmDialog
        open={dialog === 'revoke'}
        title={text.revokeDialog.title}
        body={text.revokeDialog.body}
        confirmLabel={text.revokeDialog.confirm}
        cancelLabel={text.revokeDialog.cancel}
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => send(() => revoke({ data: { scenarioId: scenario.scenarioId, expectedRevision: scenario.revision } }), 'revoked')}
      />

      <section className="panel" data-testid="scenario-request">
        <h2 className="panel-heading">{text.requestHeading}</h2>
        <dl className="facts">
          {/* T38b: form の要求の形は FORM のシナリオだけ（API のシナリオの要求の型は、下の要約。T38c）。 */}
          {scenario.request === null ? null : (
            <>
              <dt>{text.formMethod}</dt>
              <dd>{scenario.request.methodOverride === null
                ? scenario.request.formMethod
                : discoveryText.methodOverride(scenario.request.formMethod, scenario.request.methodOverride)}</dd>
              <dt>{text.origin}</dt>
              <dd><code>{scenario.request.origin}</code></dd>
              <dt>{text.path}</dt>
              <dd><code>{scenario.request.path}</code></dd>
              <dt>{text.enctype}</dt>
              <dd>{scenario.request.enctype}</dd>
            </>
          )}
          <dt>{text.fieldsHeading}</dt>
          <dd data-testid="scenario-field-names">{scenario.fieldNames.length === 0 ? discoveryText.noFlags : listText(scenario.fieldNames)}</dd>
          <dt>{text.readChecksHeading}</dt>
          <dd>
            {scenario.readChecks.length === 0
              ? discoveryText.noFlags
              : listText(scenario.readChecks.map(({ readCheckId, revision }) => text.readCheckOption(readCheckId, formatInteger(revision))))}
          </dd>
          <dt>{text.inputRulesHeading}</dt>
          <dd data-testid="scenario-input-rules" data-state={page.inputRuleState}>
            {page.inputRuleState === 'NOT_SET'
              ? text.inputRulesMissing
              : text.inputRulesState(
                inputRuleStateDisplay(page.inputRuleState).label,
                scenario.inputRuleReference === null
                  ? text.inputRulesMissing
                  : text.inputRulesValue(scenario.inputRuleReference.ruleSetId, formatInteger(scenario.inputRuleReference.revision), scenario.inputRuleReference.digest),
              )}
          </dd>
        </dl>
        {scenario.api === null ? null : (
          <ScenarioApiShape api={scenario.api} transport={scenario.transport} testId="scenario-api-shape" publicationStateKeys={scenario.apiPublicationStateKeys} />
        )}
        <h3>{text.sideEffectsHeading}</h3>
        <SideEffects page={page} />
      </section>

      {scenario.kind !== UPDATE_SCENARIO_KIND ? null : (
        <section className="panel" data-testid="scenario-update-section">
          <h2 className="panel-heading">{text.update.heading}</h2>
          <UpdateSpec page={page} />
        </section>
      )}

      <section className="panel" data-testid="scenario-verification-section">
        <h2 className="panel-heading">{writeText.verificationSectionHeading}</h2>
        <Verification page={page} />
      </section>

      <section className="panel" data-testid="scenario-writes">
        <h2 className="panel-heading">{writeText.writesHeading}</h2>
        <WriteResultHistory results={page.writes} />
      </section>

      <section className="panel" data-testid="scenario-differences">
        <h2 className="panel-heading">{text.diffHeading}</h2>
        <Differences page={page} />
      </section>

      <section className="panel" data-testid="scenario-evidence">
        <h2 className="panel-heading">{text.evidenceHeading}</h2>
        <p className="muted">{text.evidenceNote}</p>
        <dl className="facts">
          <dt>{discoveryText.columns.kind}</dt>
          <dd>{candidateKindDisplay(evidence.kind).label}</dd>
          <dt>{text.columns.page}</dt>
          <dd><code>{`${page.showOrigins ? evidence.pageOrigin : ''}${evidence.pagePath}`}</code></dd>
          <dt>{discoveryText.queryNames}</dt>
          <dd>{evidence.queryNames.length === 0 ? discoveryText.noFlags : listText(evidence.queryNames)}</dd>
          <dt>{discoveryText.submitterWords}</dt>
          <dd>{discoveryText.submitterWordsValue(evidence.submitterWords)}</dd>
          <dt>{text.discoveryJob}</dt>
          <dd><Link to="/jobs/$jobId" params={{ jobId: evidence.discoveryJobId }}>{discoveryText.openJob}</Link></dd>
        </dl>
        <h3>{text.fieldsTableHeading}</h3>
        {evidence.fields.length === 0 ? <p>{discoveryText.noFields}</p> : (
          <div className="table-wrap">
            <table data-testid="scenario-evidence-fields">
              <thead>
                <tr>
                  <th scope="col">{text.fieldColumns.name}</th>
                  <th scope="col">{text.fieldColumns.type}</th>
                  <th scope="col">{text.fieldColumns.flags}</th>
                  <th scope="col">{text.fieldColumns.constraints}</th>
                  <th scope="col">{text.fieldColumns.selected}</th>
                </tr>
              </thead>
              <tbody>
                {evidence.fields.map((field, index) => {
                  const selected = scenario.fieldNames.includes(field.name);
                  return (
                    <tr key={`${field.name}:${String(index)}`} data-field-name={field.name} data-selected={String(selected)}>
                      <th scope="row"><code>{field.name}</code></th>
                      <td><code>{field.type}</code></td>
                      <td>{candidateFieldFlagsText(field)}</td>
                      <td>{candidateFieldConstraintsText(field)}</td>
                      <td>{selected ? text.selectedYes : text.selectedNo}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" data-testid="scenario-history">
        <h2 className="panel-heading">{text.historyHeading}</h2>
        {page.history.length === 0 ? <p>{text.noHistory}</p> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{text.historyColumns.kind}</th>
                  <th scope="col">{text.historyColumns.at}</th>
                  <th scope="col">{text.historyColumns.revision}</th>
                  <th scope="col">{text.historyColumns.expiresAt}</th>
                  <th scope="col">{text.historyColumns.detail}</th>
                </tr>
              </thead>
              <tbody>
                {page.history.map((entry) => {
                  const display = approvalReceiptKindDisplay(entry.kind);
                  return (
                    <tr key={entry.receiptId} data-testid="scenario-history-entry" data-kind={entry.kind}>
                      <td><span className={toneClass(display.tone)}>{display.label}</span></td>
                      <td>{formatDateTime(entry.at)}</td>
                      <td>{entry.scenarioRevision === null ? discoveryText.noFlags : text.revisionValue(formatInteger(entry.scenarioRevision))}</td>
                      <td>{entry.expiresAt === null ? discoveryText.noFlags : formatDateTime(entry.expiresAt)}</td>
                      <td>{entry.reason === null ? text.approverLocalOperator : revocationReasonDisplay(entry.reason).label}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" data-testid="scenario-revisions">
        <h2 className="panel-heading">{text.revisionsHeading}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{text.revisionColumns.revision}</th>
                <th scope="col">{text.revisionColumns.recordedAt}</th>
                <th scope="col">{text.revisionColumns.fields}</th>
                <th scope="col">{text.revisionColumns.limits}</th>
                <th scope="col">{text.revisionColumns.ttl}</th>
              </tr>
            </thead>
            <tbody>
              {page.revisions.map((revision) => (
                <tr key={revision.revision} data-testid="scenario-revision" data-revision={String(revision.revision)}>
                  <td>{text.revisionValue(formatInteger(revision.revision))}</td>
                  <td>{formatDateTime(revision.recordedAt)}</td>
                  <td>{revision.fieldNames.length === 0 ? discoveryText.noFlags : listText(revision.fieldNames)}</td>
                  <td>{listText([formatCount(revision.limits.maxCreatesPerRun), formatCount(revision.limits.maxCumulativeCreates)])}</td>
                  <td>{text.daysValue(formatInteger(revision.approvalTtlDays))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="button-row">
        <Link to="/scenarios/$profileId" params={{ profileId: profile.profileId }} className="button">{text.backToList}</Link>
        <Link to="/profiles/$profileId" params={{ profileId: profile.profileId }} className="button">{text.backToProfile}</Link>
      </div>
    </PageFrame>
  );
}

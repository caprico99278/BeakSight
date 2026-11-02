import { useState } from 'react';
import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import type { SideEffectConfirmation } from '../../../../../../../src/control/approval-view.js';
// PRE42-CC 組 UI-K（組 2 の引き継ぎ。CC-106）: シナリオの種類の値は、管理データに触れない純粋な owner から読む（文字列で比べない）。
import { UPDATE_SCENARIO_KIND } from '../../../../../../../src/core/scenario-kind.js';
import { SIDE_EFFECT_CONFIRMATION_CATALOG, sortByDisplayOrder } from '../../../../../../../src/presentation/catalog.js';
import { formatInteger } from '../../../../../../../src/presentation/format.js';
import {
  LOCAL_UI_AUTO_DRAFT_TEXT,
  LOCAL_UI_JOB_SUMMARY_TEXT,
  LOCAL_UI_SCENARIO_TEXT,
  LOCAL_UI_WRITE_STAGE_TEXT,
  LOCAL_UI_WRITE_TEXT,
  SCENARIO_REQUEST_REJECTION_DESCRIPTIONS,
  listText,
} from '../../../../../../../src/presentation/messages.js';
import { AdvancedSettings } from '../../../../components/AdvancedSettings';
import { ConfirmDialog } from '../../../../components/ConfirmDialog';
import { DraftValueMark } from '../../../../components/DraftValueMark';
import { arrivedFromJobOf } from '../../../../components/JobArrival';
import { Notice } from '../../../../components/Notice';
import { PageFrame, arrivalSearchOf, scenariosTrail } from '../../../../components/PageFrame';
import { ScenarioProfilePanel } from '../../../../components/ScenarioProfilePanel';
import { ScenarioStatus } from '../../../../components/ScenarioStatus';
import { WriteResultHistory } from '../../../../components/WriteResultDetails';
import { closedListReason } from '../../../../display/server-function-outcome';
import { closedSearchValueOf, isClosedSearchValue } from '../../../../display/search-values';
import { approvalInvalidityReasonDisplay, scenarioDisplayStateDisplay, sideEffectConfirmationDisplay } from '../../../../display/labels';
import { getAuditJobFn } from '../../../../server/audit-job-functions';
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
const isScenarioNotice = (value: unknown): value is ScenarioNotice => isClosedSearchValue(NOTICES, value);

/** PL-5（設計書 3 章の 5、13 章の最後の段落）: 自動で移ってきた書き込みの作業の、終わった結果（文の鍵はカタログと同じ）。 */
const isFinishedJobResult = closedListReason(LOCAL_UI_JOB_SUMMARY_TEXT.finished);

export const Route = createFileRoute('/scenarios/$profileId/$scenarioId/')({
  // PL-5: 作業の画面から自動で移ってきた印（`arrived`。PL-V）と、どの作業から移ったか（`fromJob`。PL-2 の `JobArrival.tsx`）も受ける（サイトの詳細と同じ形）。
  validateSearch: (search: Record<string, unknown>): { notice?: ScenarioNotice; arrived?: 'auto'; fromJob?: string } => {
    const fromJob = arrivedFromJobOf(search);
    return {
      ...(isScenarioNotice(search['notice']) ? { notice: search['notice'] } : {}),
      ...arrivalSearchOf(search),
      ...(fromJob === null ? {} : { fromJob }),
    };
  },
  loaderDeps: ({ search }) => ({ fromJob: arrivedFromJobOf(search) }),
  loader: async ({ params, deps }) => {
    const [page, arrivedJob] = await Promise.all([
      scenarioDetailPageFn({ data: { scenarioId: params.scenarioId } }),
      deps.fromJob === null ? Promise.resolve(null) : getAuditJobFn({ data: { jobId: deps.fromJob } }),
    ]);
    if (page === null || page.profile.profileId !== params.profileId) {
      throw notFound();
    }
    return {
      ...page,
      // PL-5（3 章の 5）: 移ってきた作業の結果（このサイトのこの書き込みの手順の作業で、終わった結果のときだけ）。
      arrivedResult: arrivedJob !== null && arrivedJob.profileId === params.profileId && arrivedJob.write?.scenarioId === params.scenarioId
        && isFinishedJobResult(arrivedJob.summary.result)
        ? arrivedJob.summary.result
        : null,
    };
  },
  component: ScenarioDetailPage,
});

const text = LOCAL_UI_SCENARIO_TEXT;
const stageText = LOCAL_UI_WRITE_STAGE_TEXT.scenario;
const writeText = LOCAL_UI_WRITE_TEXT;

/** 承認したシナリオの保存の状態（撤回の操作を出すか）。 */
const APPROVED_STATE = 'APPROVED';

const NOTICE_TEXT: Readonly<Record<ScenarioNotice, string>> = Object.freeze({
  saved: text.saved,
  approved: text.approved,
  revoked: text.revoked,
  autoRules: LOCAL_UI_AUTO_DRAFT_TEXT.savedWithRules,
  autoRulesFailed: LOCAL_UI_AUTO_DRAFT_TEXT.savedRulesFailed,
});

/** 副作用の確認の項目（表示の順）。 */
const sideEffectItemsOf = (page: ScenarioDetailPageView): readonly SideEffectConfirmation[] =>
  sortByDisplayOrder(Object.keys(page.scenario.sideEffectConfirmations) as SideEffectConfirmation[], SIDE_EFFECT_CONFIRMATION_CATALOG);

/**
 * MI-6（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.6、ユーザーの判断 2）: 承認のダイアログの副作用の 4 項目（中身の文と説明）。「承認する」の
 * 1 回の押下で、すべてを確かめたことにする。PL-S（設計書 7 章）: 4 つの約束の文。
 */
function SideEffectContents({ page }: Readonly<{ page: ScenarioDetailPageView }>) {
  return (
    <>
      <p className="field-hint">{text.approveDialog.sideEffectsNote}</p>
      <ul data-testid="scenario-approve-side-effects">
        {sideEffectItemsOf(page).map((item) => {
          const display = sideEffectConfirmationDisplay(item);
          return (
            <li key={item} data-item={item} data-confirmed={String(page.scenario.sideEffectConfirmations[item])}>
              <strong>{display.label}</strong>
              {display.description === null ? null : <span className="field-hint">{display.description}</span>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** FM2b: 自動の下書きが推した値のまま残る項目（詳しい内容。項目の名前と印だけ。値は出さない）。 */
function InferredItems({ page }: Readonly<{ page: ScenarioDetailPageView }>) {
  return (
    <ul data-testid="scenario-inferred">
      {page.inferredItems.map((item) => (
        <li key={`${item.item}:${item.value}`} data-item={item.item}>
          {LOCAL_UI_AUTO_DRAFT_TEXT.inferredItems[item.item]}{' '}
          <DraftValueMark origin={item.origin} ground={item.ground} />
        </li>
      ))}
    </ul>
  );
}

/** 要点の、今の様子の文の後に出す 1 行ずつの文（決められなかったこと・写したこと。判定はサーバの値）。 */
function SummaryLines({ page }: Readonly<{ page: ScenarioDetailPageView }>) {
  const { scenario } = page;
  return (
    <>
      {page.recordIdUndetermined ? <p data-testid="scenario-record-id-undetermined">{stageText.recordIdUndetermined}</p> : null}
      {page.missingVerification.length === 0 ? null : (
        <p data-testid="scenario-verification-missing" data-reason="VERIFICATION_SPEC_MISSING">{stageText.verificationMissing}</p>
      )}
      {page.inputRuleState === 'INSUFFICIENT' ? <p data-testid="scenario-rules-insufficient">{stageText.rulesInsufficient}</p> : null}
      {page.verificationCopied ? <p data-testid="scenario-verification-copied">{stageText.verificationCopied}</p> : null}
      {scenario.kind === UPDATE_SCENARIO_KIND && page.plannedUpdateTarget === null
        ? <p data-testid="scenario-update-no-target">{stageText.noPlannedTarget}</p>
        : null}
      {page.writes.length === 0 ? null : <p data-testid="scenario-no-cleanup">{writeText.noCleanup}</p>}
    </>
  );
}

/**
 * 書き込みの手順の詳細（Task 28 の設計書 4.6。T28e。PL-5 で設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の形に作り直した）。上から: 要点のパネル（今の
 * 様子の文と、決められなかったこと・写したことの 1 行、主のボタン 1 つ（`primaryAction`。「書き込みの OK」か「書き込みを始める」））→ 詳しい内容 1 つ（変える、
 * 入れる値の決まり、OK の取り消し、書き換えの対象、書き込みの結果、推した項目）。要求の形・検証の指定の中身・入れる値の決まりの中身・版・digest・ID は出さない。
 * 承認と撤回は、確認のダイアログ（取り消し側にフォーカス）の後にだけ送る。
 */
function ScenarioDetailPage() {
  const page = Route.useLoaderData();
  const { notice: rawNotice } = Route.useSearch();
  // MI-C2 項目 19: ルータは根の生の search も子へ渡すので、知らせの値は描く前に閉じた一覧でもう一度確かめる（`display/search-values.ts`）。
  const notice = closedSearchValueOf(NOTICES, rawNotice);
  const approve = useServerFn(approveScenarioFn);
  const revoke = useServerFn(revokeScenarioFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [dialog, setDialog] = useState<'approve' | 'revoke' | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejection, setRejection] = useState<ScenarioRejectionView | null>(null);
  const { profile, scenario, evidence, status } = page;
  const params = { profileId: profile.profileId, scenarioId: scenario.scenarioId };
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
  const stateDescription = status === null ? text.factsUnavailable : scenarioDisplayStateDisplay(status.displayState).description;

  return (
    <PageFrame title={text.pages.scenario} trail={scenariosTrail(profile.profileId)}>
      {/* 3 章の 1: 要点のパネル（今の様子の文、1 行ずつの理由、主のボタン 1 つ。知らせもこの中。13 章の 6）。 */}
      <section className="panel" data-testid="scenario-summary" data-primary={page.primaryAction ?? ''}>
        <h2 className="panel-heading">{LOCAL_UI_WRITE_STAGE_TEXT.summaryHeading}</h2>
        {/* PL-5（3 章の 5、13 章の最後の段落）: 書き込みの作業から自動で移ってきたときは、要点の 1 行目に何が起きたか（作業の結果の文）。 */}
        {page.arrivedResult === null ? null : (
          <p data-testid="scenario-arrival" data-result={page.arrivedResult}>{LOCAL_UI_JOB_SUMMARY_TEXT.finished[page.arrivedResult]}</p>
        )}
        {notice === undefined ? null : (
          <Notice kind="positive">
            <p data-testid="scenario-notice" data-notice={notice}>{NOTICE_TEXT[notice]}</p>
          </Notice>
        )}
        <ScenarioProfilePanel eligible={page.eligible} editable={page.editable} />
        <div data-testid="scenario-status" data-scenario-kind={scenario.kind}>
          {stateDescription === null ? null : <p data-testid="scenario-state-description">{stateDescription}</p>}
          {status === null || status.reasons.length === 0 ? null : (
            <ul data-testid="scenario-reasons">
              {status.reasons.map((reason) => <li key={reason} data-reason={reason}>{approvalInvalidityReasonDisplay(reason).label}</li>)}
            </ul>
          )}
        </div>
        <SummaryLines page={page} />
        {page.primaryAction === 'APPROVE' ? <p>{stageText.nextApprove}</p> : null}
        {page.primaryAction === 'START' ? <p>{stageText.nextStart}</p> : null}
        {page.primaryAction === null && status?.displayState === 'APPROVED' && !page.writeStartAvailable ? <p>{stageText.cannotStart}</p> : null}
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
        {page.primaryAction === null ? null : (
          <div className="button-row" data-testid="scenario-summary-actions">
            {page.primaryAction === 'APPROVE' ? (
              <button type="button" className="button button--primary" data-testid="scenario-approve" onClick={() => setDialog('approve')}>
                {stageText.approve}
              </button>
            ) : (
              <Link to="/scenarios/$profileId/$scenarioId/write" params={params} className="button button--primary" data-testid="scenario-open-write">
                {stageText.start}
              </Link>
            )}
          </div>
        )}
      </section>

      {/* 3 章の 1: 詳しい内容 1 つ（開かなくても流れは進む）。 */}
      <section className="panel">
        <AdvancedSettings testId="scenario-detail-advanced">
          <div data-testid="scenario-state-badge"><ScenarioStatus status={status} showDescriptions={false} /></div>
          <div className="button-row" data-testid="scenario-detail-actions">
            {page.editable ? (
              <Link to="/scenarios/$profileId/$scenarioId/edit" params={params} className="button" data-testid="scenario-edit">{text.edit}</Link>
            ) : null}
            {/* PL-5（8 章）: 入れる値の決まりの画面は、ふだんの流れから外す（推せない欄があるときの直す入口として、ここに置く）。 */}
            {page.eligible ? (
              <Link to="/scenarios/$profileId/$scenarioId/rules" params={params} className="button" data-testid="scenario-open-rules">{text.openRules}</Link>
            ) : null}
            {scenario.state === APPROVED_STATE ? (
              <button type="button" className="button button--danger" data-testid="scenario-revoke" onClick={() => setDialog('revoke')}>
                {text.revoke}
              </button>
            ) : null}
          </div>
          <dl className="facts">
            <dt>{text.columns.page}</dt>
            <dd data-testid="scenario-page">{evidence.pagePath}</dd>
            <dt>{text.fieldsHeading}</dt>
            <dd data-testid="scenario-field-names">{scenario.fieldNames.length === 0 ? text.update.none : listText(scenario.fieldNames)}</dd>
            {scenario.kind !== UPDATE_SCENARIO_KIND ? null : (
              <>
                <dt>{text.update.plannedTarget}</dt>
                <dd data-testid="scenario-update-planned" data-target={page.plannedUpdateTarget ?? ''}>
                  {page.plannedUpdateTarget === null ? text.update.noPlannedTarget : page.plannedUpdateTarget}
                </dd>
              </>
            )}
          </dl>
          {page.inferredItems.length === 0 ? null : (
            <>
              <h3>{LOCAL_UI_AUTO_DRAFT_TEXT.inferredHeading}</h3>
              <InferredItems page={page} />
            </>
          )}
          <section data-testid="scenario-writes">
            <h3>{writeText.writesHeading}</h3>
            <WriteResultHistory results={page.writes} />
          </section>
        </AdvancedSettings>
      </section>

      {status === null ? null : (
        <ConfirmDialog
          open={dialog === 'approve'}
          title={text.approveDialog.title}
          body={text.approveDialog.body}
          confirmLabel={text.approveDialog.confirm}
          cancelLabel={text.approveDialog.cancel}
          confirmTone="danger"
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => send(
            // MI-6: ダイアログが 4 項目を示したので、1 回の「承認する」で確かめたことを送る（確認のない版は、確認を入れた次の版を作って承認する）。
            () => approve({
              data: {
                scenarioId: scenario.scenarioId, expectedRevision: scenario.revision, expectedApprovalDigest: status.approvalDigest, sideEffectsConfirmed: true,
              },
            }),
            'approved',
          )}
        >
          {/* PL-5: 長いときに中だけを動かす区画は、キーボードで動かせるようにフォーカスを受ける（axe の scrollable-region-focusable）。 */}
          <div className="dialog-details" data-testid="scenario-approve-details" tabIndex={0}>
            {/* PL-S（設計書 7 章・9 章の 1・3）: 何を・どこへ・何件（操作を見つけた画面の path を 1 つ。送り方によらず同じ文）と、隔離が未確認なら、その注意。 */}
            <p data-testid="scenario-approve-target">
              {(scenario.kind === UPDATE_SCENARIO_KIND ? text.approveDialog.targetUpdate : text.approveDialog.targetCreate)(
                evidence.pagePath, formatInteger(scenario.limits.maxCreatesPerRun),
              )}
            </p>
            {/* FM2b: 推測の項目が 1 つでも残る下書きは、承認の前にその印を出す（項目の名前だけ。値は出さない）。 */}
            {page.inferredItems.length === 0 ? null : (
              <p data-testid="scenario-approve-inferred">{LOCAL_UI_AUTO_DRAFT_TEXT.approveInferredHeading}</p>
            )}
            <h3>{text.approveDialog.sideEffects}</h3>
            <SideEffectContents page={page} />
          </div>
        </ConfirmDialog>
      )}
      <ConfirmDialog
        open={dialog === 'revoke'}
        title={text.revokeDialog.title}
        body={text.revokeDialog.body}
        confirmLabel={text.revokeDialog.confirm}
        cancelLabel={text.revokeDialog.cancel}
        confirmTone="danger"
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => send(() => revoke({ data: { scenarioId: scenario.scenarioId, expectedRevision: scenario.revision } }), 'revoked')}
      />
    </PageFrame>
  );
}

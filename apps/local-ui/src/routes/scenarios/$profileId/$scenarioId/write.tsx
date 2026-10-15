import { useState } from 'react';
import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { formatCount, formatDateTime, formatInteger } from '../../../../../../../src/presentation/format.js';
import {
  AUDIT_JOB_START_REJECTION_DESCRIPTIONS,
  EXECUTION_GRANT_REJECTION_DESCRIPTIONS,
  LOCAL_UI_DISCOVERY_TEXT,
  LOCAL_UI_SCENARIO_TEXT,
  LOCAL_UI_WRITE_TEXT,
  WRITE_START_LOCAL_REJECTION_DESCRIPTIONS,
  listText,
} from '../../../../../../../src/presentation/messages.js';
import { ConfirmDialog } from '../../../../components/ConfirmDialog';
import { Notice } from '../../../../components/Notice';
import { PageFrame } from '../../../../components/PageFrame';
import { ScenarioProfilePanel } from '../../../../components/ScenarioProfilePanel';
import {
  approvalInvalidityReasonDisplay,
  scenarioDisplayStateDisplay,
  scenarioVerificationItemDisplay,
  toneClass,
} from '../../../../display/labels';
import { startWriteCreateFn, startWriteUpdateFn, writeStartPageFn, type WriteStartView } from '../../../../server/write-job-functions';

export const Route = createFileRoute('/scenarios/$profileId/$scenarioId/write')({
  loader: async ({ params }) => {
    const page = await writeStartPageFn({ data: { scenarioId: params.scenarioId } });
    if (page === null || page.profile.profileId !== params.profileId) {
      throw notFound();
    }
    return page;
  },
  component: WriteStartPage,
});

const text = LOCAL_UI_WRITE_TEXT;
const scenarioText = LOCAL_UI_SCENARIO_TEXT;

/** 拒んだ結果の説明と手順（どの段で拒んだかで、文言のカタログを選ぶ）。 */
const rejectionTextOf = (result: Extract<WriteStartView, { ok: false }>): { readonly description: string; readonly action: string } => {
  switch (result.stage) {
    case 'LOCAL':
      return WRITE_START_LOCAL_REJECTION_DESCRIPTIONS[result.reason];
    case 'GRANT':
      return EXECUTION_GRANT_REJECTION_DESCRIPTIONS[result.reason];
    case 'START':
      return AUDIT_JOB_START_REJECTION_DESCRIPTIONS[result.reason];
  }
};

/**
 * 書き込みを始める（Task 30 の設計書 2 章、3 章、10 章。T30g）。シナリオの詳細の「書き込みを始める画面を開く」から開く。始める前に人が確かめる
 * 内容（シナリオと版、送る欄、送り先、1 回の Run で 1 件、累積の残り、連続の上限と次に実行できる時刻、外部への通知の確認、環境の証跡、検証の指定、
 * 承認の状態）を出し、確認のダイアログ（取り消し側にフォーカス）の後にだけ、実行の許可の発行と書き込みのジョブの開始を送る。始めたら、ジョブの
 * 詳細へ移る。拒まれたら、理由をカタログの文言で出す。
 * T31h-2（Task 31 の設計書 3 章の「対象の選び方」、10 章）: 更新（UPDATE）のシナリオでは、送る欄の代わりに、更新するレコード（予定のレコード）、変える欄、
 * 保つ欄、型に予定の ID を入れた更新の画面の path と送り先を出し、開始の要求に画面が見せた予定の ID を載せる（予定がなければ始められない）。
 */
function WriteStartPage() {
  const page = Route.useLoaderData();
  const startCreate = useServerFn(startWriteCreateFn);
  const startUpdate = useServerFn(startWriteUpdateFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rejection, setRejection] = useState<Extract<WriteStartView, { ok: false }> | null>(null);
  const { profile, scenario, update } = page;
  const origin = page.showOrigins ? scenario.request.origin : '';
  const updateText = scenarioText.update;
  const params = { profileId: profile.profileId, scenarioId: scenario.scenarioId };
  const rejectionText = rejection === null ? null : rejectionTextOf(rejection);

  return (
    <PageFrame title={text.pages.writeStart}>
      <ScenarioProfilePanel profile={profile} eligible={page.eligible} editable={page.eligible} />

      <section
        className="panel"
        data-testid="write-start"
        data-scenario-id={scenario.scenarioId}
        data-kind={scenario.kind}
        data-startable={String(page.startable)}
      >
        <h2 className="panel-heading">{text.confirmHeading}</h2>
        <p>{update === null ? text.confirmNote : text.confirmNoteUpdate}</p>
        <dl className="facts">
          <dt>{text.scenario}</dt>
          <dd><code>{scenario.scenarioId}</code></dd>
          <dt>{text.revision}</dt>
          <dd data-testid="write-start-revision">{scenarioText.revisionValue(formatInteger(scenario.revision))}</dd>
          {update === null ? [
            <dt key="fields:name">{text.fields}</dt>,
            <dd key="fields:value" data-testid="write-start-fields">{scenario.fieldNames.length === 0 ? text.notApplicable : listText(scenario.fieldNames)}</dd>,
          ] : [
            <dt key="target:name">{text.targetRecord}</dt>,
            <dd key="target:value">
              <span data-testid="write-start-target" data-target={update.plannedTarget ?? ''}>
                {update.plannedTarget === null ? updateText.noPlannedTarget : <code>{update.plannedTarget}</code>}
              </span>
              <span className="field-hint">{text.targetRecordNote}</span>
            </dd>,
            <dt key="changed:name">{text.changedFields}</dt>,
            <dd key="changed:value" data-testid="write-start-changed">
              {update.changedFieldNames.length === 0 ? text.notApplicable : listText(update.changedFieldNames)}
            </dd>,
            <dt key="kept:name">{text.keptFields}</dt>,
            <dd key="kept:value" data-testid="write-start-kept">{update.keptFieldNames.length === 0 ? text.notApplicable : listText(update.keptFieldNames)}</dd>,
            <dt key="form:name">{text.formPage}</dt>,
            <dd key="form:value" data-testid="write-start-form" data-path={update.formPath ?? ''}>
              {update.formPath === null ? text.notApplicable : <code>{`${origin}${update.formPath}`}</code>}
            </dd>,
          ]}
          <dt>{text.action}</dt>
          <dd data-testid="write-start-action" data-path={update === null ? scenario.request.path : update.actionPath ?? ''}>
            {update === null
              ? <code>{`${origin}${scenario.request.path}`}</code>
              : update.actionPath === null ? text.notApplicable : <code>{`${origin}${update.actionPath}`}</code>}
            {scenario.request.methodOverride === null
              ? null
              : <span>{` ${LOCAL_UI_DISCOVERY_TEXT.methodOverride(scenario.request.formMethod, scenario.request.methodOverride)}`}</span>}
          </dd>
          <dt>{scenarioText.perRunLimit}</dt>
          <dd>{text.perRun}</dd>
          <dt>{text.cumulative}</dt>
          <dd data-testid="write-start-cumulative" data-remaining={String(page.remaining)}>
            {text.cumulativeValue(formatCount(page.used), formatCount(scenario.limits.maxCumulativeCreates), formatCount(page.remaining))}
          </dd>
          <dt>{text.schedule}</dt>
          <dd data-testid="write-start-schedule" data-remaining={String(page.remainingInWindow)}>
            {text.scheduleValue(formatInteger(page.intervalMinutes), formatCount(page.writesPerDay), formatCount(page.remainingInWindow))}
          </dd>
          <dt>{text.nextAllowedAt}</dt>
          <dd data-testid="write-start-next" data-next={page.nextWriteAllowedAt ?? ''}>
            {page.nextWriteAllowedAt === null ? text.nextAllowedNow : formatDateTime(page.nextWriteAllowedAt)}
          </dd>
          <dt>{text.notification}</dt>
          <dd data-testid="write-start-notification" data-confirmed={String(page.notificationConfirmed)}>
            <span className={toneClass(page.notificationConfirmed ? 'positive' : 'caution')}>
              {page.notificationConfirmed ? text.notificationConfirmed : text.notificationUnconfirmed}
            </span>
          </dd>
          <dt>{text.evidence}</dt>
          <dd data-testid="write-start-evidence" data-present={String(page.evidencePresent)}>
            <span className={toneClass(page.evidencePresent ? 'positive' : 'caution')}>{page.evidencePresent ? text.evidencePresent : text.evidenceMissing}</span>
          </dd>
          <dt>{text.approval}</dt>
          <dd data-testid="write-start-approval" data-approved={page.approved === null ? '' : String(page.approved)}>
            {page.approved === null
              ? scenarioText.factsUnavailable
              : page.approved
                ? <span className={toneClass(scenarioDisplayStateDisplay('APPROVED').tone)}>{scenarioDisplayStateDisplay('APPROVED').label}</span>
                : listText(page.invalidityReasons.map((reason) => approvalInvalidityReasonDisplay(reason).label))}
          </dd>
        </dl>
        {page.missingVerification.length === 0 ? null : (
          <Notice kind="caution" heading={text.verificationMissingHeading}>
            <div data-testid="write-start-verification-missing">
              <p>{text.verificationMissing}</p>
              <ul>
                {page.missingVerification.map((item) => <li key={item} data-item={item}>{scenarioVerificationItemDisplay(item).label}</li>)}
              </ul>
            </div>
          </Notice>
        )}
        {page.startBlocker === null ? null : (
          <Notice kind="caution">
            <div data-testid="write-start-blocker" data-reason={page.startBlocker}>
              <p>{AUDIT_JOB_START_REJECTION_DESCRIPTIONS[page.startBlocker].description}</p>
              <p>{AUDIT_JOB_START_REJECTION_DESCRIPTIONS[page.startBlocker].action}</p>
            </div>
          </Notice>
        )}
        {page.startable ? null : <p data-testid="write-start-not-startable">{text.notStartable}</p>}
        {rejection === null || rejectionText === null ? null : (
          <Notice kind="critical" heading={text.startRejectedHeading}>
            <div data-testid="write-start-rejection" data-stage={rejection.stage} data-reason={rejection.reason}>
              <p>{rejectionText.description}</p>
              <p>{rejectionText.action}</p>
              {rejection.stage !== 'GRANT' || rejection.invalidityReasons.length === 0 ? null : (
                <ul>
                  {rejection.invalidityReasons.map((reason) => <li key={reason} data-reason={reason}>{approvalInvalidityReasonDisplay(reason).label}</li>)}
                </ul>
              )}
            </div>
            <div className="button-row">
              <button type="button" className="button" onClick={() => void router.invalidate().then(() => setRejection(null))}>{scenarioText.reload}</button>
            </div>
          </Notice>
        )}
        <div className="button-row">
          {page.startable ? (
            <button type="button" className="button button--primary" data-testid="write-start-open" onClick={() => setDialog(true)}>{text.start}</button>
          ) : null}
          <Link to="/scenarios/$profileId/$scenarioId" params={params} className="button">{text.backToScenario}</Link>
        </div>
      </section>

      <ConfirmDialog
        open={dialog}
        title={text.startDialog.title}
        body={update === null ? text.startDialog.body : text.startDialogUpdateBody}
        confirmLabel={busy ? text.starting : text.startDialog.confirm}
        cancelLabel={text.startDialog.cancel}
        busy={busy}
        onCancel={() => setDialog(false)}
        onConfirm={() => {
          setBusy(true);
          const data = { scenarioId: scenario.scenarioId, expectedRevision: scenario.revision };
          // T31h-2: 更新は、画面が見せた予定のレコードの ID を載せる（予定がなければ、開始のボタンは出ない）。
          const started = update === null || update.plannedTarget === null
            ? startCreate({ data })
            : startUpdate({ data: { ...data, expectedTargetRecordId: update.plannedTarget } });
          void started
            .then((result) => {
              setDialog(false);
              if (result.ok) {
                setRejection(null);
                void navigate({ to: '/jobs/$jobId', params: { jobId: result.jobId } });
              } else {
                setRejection(result);
              }
            })
            .finally(() => setBusy(false));
        }}
      />
    </PageFrame>
  );
}

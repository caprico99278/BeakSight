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
import { ScenarioApiShape } from '../../../../components/ScenarioApiShape';
import { ScenarioProfilePanel } from '../../../../components/ScenarioProfilePanel';
import {
  approvalInvalidityReasonDisplay,
  scenarioDisplayStateDisplay,
  scenarioTransportDisplay,
  scenarioVerificationItemDisplay,
  toneClass,
  writeChainStateDisplay,
} from '../../../../display/labels';
import {
  startWriteCreateFn,
  startWriteCreateThenUpdateFn,
  startWriteUpdateFn,
  writeStartPageFn,
  type WriteStartPageView,
  type WriteStartView,
} from '../../../../server/write-job-functions';

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
    // T41g: 「登録してから更新する」を、何も始めずに拒んだ。
    case 'CHAIN':
      return text.chain.startRejections[result.reason];
  }
};

/**
 * T41g（Task 41 の設計書 3.5.1）: 「登録してから更新する」（台帳の参照を持つ更新のシナリオで、出す理由があるときだけ）。両方が始められるときだけ開始の
 * ボタンを出す。最後に続けて始めた状態（メモリの中）も出す。
 */
function WriteChainOffer({ chain, onOpen }: Readonly<{ chain: NonNullable<WriteStartPageView['chain']>; onOpen: () => void }>) {
  const last = chain.last;
  const lastState = last === null ? null : writeChainStateDisplay(last.state);
  return (
    <>
      {chain.offer === null ? null : (
        <Notice kind="caution" heading={text.chain.heading}>
          <div data-testid="write-start-chain" data-offer={chain.offer} data-startable={String(chain.startable)}>
            <p>{text.chain.offerReasons[chain.offer]}</p>
            {chain.startable ? (
              <div className="button-row">
                <button type="button" className="button" data-testid="write-start-chain-open" onClick={onOpen}>{text.chain.open}</button>
              </div>
            ) : <p data-testid="write-start-chain-not-startable">{text.chain.notStartable}</p>}
          </div>
        </Notice>
      )}
      {last === null || lastState === null ? null : (
        <dl className="facts" data-testid="write-start-chain-state" data-state={last.state} data-reason={last.reason ?? ''}>
          <dt>{text.chain.stateHeading}</dt>
          <dd>
            <span className={toneClass(lastState.tone)}>{lastState.label}</span>
            {' '}
            <Link to="/jobs/$jobId" params={{ jobId: last.updateJobId ?? last.createJobId }}>{last.updateJobId === null ? text.openJob : text.chain.openUpdateJob}</Link>
          </dd>
          {/* T41g-3: 自動ログインの間隔を待っている間は、更新を始め直す時刻を出す。 */}
          {last.nextStartAt === null ? null : [
            <dt key="next:name">{text.chain.nextStartAt}</dt>,
            <dd key="next:value" data-testid="write-start-chain-next">{formatDateTime(last.nextStartAt)}</dd>,
          ]}
        </dl>
      )}
    </>
  );
}

/** T41g: 「登録してから更新する」の確認のダイアログの本文（2 回の書き込みの、それぞれの送り先と累積の残り）。 */
function WriteChainSteps({ chain, page }: Readonly<{ chain: NonNullable<WriteStartPageView['chain']>; page: WriteStartPageView }>) {
  const create = chain.create;
  const update = page.update;
  const updateAction = page.scenario.api === null ? update?.actionPath ?? '' : `${page.scenario.api.request.origin}${page.scenario.api.request.pathShape}`;
  return (
    <div>
      {create === null ? null : (
        <dl className="facts" data-testid="write-start-chain-step" data-step="CREATE" data-scenario-id={create.scenarioId} data-remaining={String(create.remaining)}>
          <dt>{text.chain.stepCreate(create.scenarioId)}</dt>
          <dd>{text.chain.stepAction}: <code>{create.action}</code></dd>
          <dd>{text.chain.stepRemaining}: {text.chain.remainingValue(formatCount(create.remaining), formatCount(create.limit))}</dd>
        </dl>
      )}
      <dl className="facts" data-testid="write-start-chain-step" data-step="UPDATE" data-scenario-id={page.scenario.scenarioId}
        data-remaining={String(page.remaining)}>
        <dt>{text.chain.stepUpdate(page.scenario.scenarioId)}</dt>
        <dd>{text.chain.stepAction}: <code>{updateAction}</code></dd>
        <dd>{text.chain.stepRemaining}: {text.chain.remainingValue(formatCount(page.remaining), formatCount(page.scenario.limits.maxCumulativeCreates))}</dd>
        <dd>{text.chain.stepTarget}: {text.chain.stepTargetValue}</dd>
      </dl>
    </div>
  );
}

/**
 * 書き込みを始める（Task 30 の設計書 2 章、3 章、10 章。T30g）。シナリオの詳細の「書き込みを始める画面を開く」から開く。始める前に人が確かめる
 * 内容（シナリオと版、送る欄、送り先、1 回の Run で 1 件、累積の残り、連続の上限と次に実行できる時刻、外部への通知の確認、環境の証跡、検証の指定、
 * 承認の状態）を出し、確認のダイアログ（取り消し側にフォーカス）の後にだけ、実行の許可の発行と書き込みのジョブの開始を送る。始めたら、ジョブの
 * 詳細へ移る。拒まれたら、理由をカタログの文言で出す。
 * T31h-2（Task 31 の設計書 3 章の「対象の選び方」、10 章）: 更新（UPDATE）のシナリオでは、送る欄の代わりに、更新するレコード（予定のレコード）、変える欄、
 * 保つ欄、型に予定の ID を入れた更新の画面の path と送り先を出し、開始の要求に画面が見せた予定の ID を載せる（予定がなければ始められない）。
 * T40d（Task 40 の設計書 3.5）: 送り方のラベルを出す。API のシナリオは、送り先に承認した API の path の型を、その下に承認した API の要求の型の要約
 * （シナリオの詳細と同じ部品 `ScenarioApiShape`）を出す。始め方と確かめは form と同じ。
 */
function WriteStartPage() {
  const page = Route.useLoaderData();
  const startCreate = useServerFn(startWriteCreateFn);
  const startUpdate = useServerFn(startWriteUpdateFn);
  const startChain = useServerFn(startWriteCreateThenUpdateFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [dialog, setDialog] = useState(false);
  // T41g: 「登録してから更新する」の確認のダイアログ。
  const [chainDialog, setChainDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rejection, setRejection] = useState<Extract<WriteStartView, { ok: false }> | null>(null);
  const { profile, scenario, update } = page;
  // T38b: API のシナリオは form の要求の形を持たない（null）。T40d: 送り先は、承認した API の要求の型（`scenario.api`）の path の型で示す。
  const { request, api } = scenario;
  const origin = page.showOrigins && request !== null ? request.origin : '';
  const transport = scenarioTransportDisplay(scenario.transport);
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
          <dt>{text.api.transport}</dt>
          <dd data-testid="write-start-transport" data-transport={scenario.transport}><span className={toneClass(transport.tone)}>{transport.label}</span></dd>
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
          <dd data-testid="write-start-action" data-path={update === null ? request?.path ?? api?.request.pathShape ?? '' : update.actionPath ?? ''}>
            {update === null
              ? (request === null
                ? (api === null ? text.notApplicable : <code>{`${api.request.origin}${api.request.pathShape}`}</code>)
                : <code>{`${origin}${request.path}`}</code>)
              // T41e: API の更新の送り先は、承認した API の Origin と path の型。
              : update.actionPath === null ? text.notApplicable : <code>{`${api === null ? origin : api.request.origin}${update.actionPath}`}</code>}
            {request === null || request.methodOverride === null
              ? null
              : <span>{` ${LOCAL_UI_DISCOVERY_TEXT.methodOverride(request.formMethod, request.methodOverride)}`}</span>}
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
        {/* T40d: API のシナリオは、承認した API の要求の型の要約（値を持たない型と名前）を出す。 */}
        {api === null ? null : <ScenarioApiShape api={api} transport={scenario.transport} testId="write-start-api-shape" />}
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
        {/* T40R2-fix（M-1）: 照合の READ の期待が、実行のたびに変わる値と比べない（許可の発行と同じ判定の理由）。 */}
        {page.readVerificationVaryingRejection === null ? null : (
          <Notice kind="caution" heading={text.readVerificationNotVaryingHeading}>
            <div data-testid="write-start-read-verification-not-varying" data-reason={page.readVerificationVaryingRejection}>
              <p>{EXECUTION_GRANT_REJECTION_DESCRIPTIONS[page.readVerificationVaryingRejection].description}</p>
              <p>{EXECUTION_GRANT_REJECTION_DESCRIPTIONS[page.readVerificationVaryingRejection].action}</p>
            </div>
          </Notice>
        )}
        {/* T41e-2: API の更新の台帳の結び付きが外れた（許可の発行の確かめ直しと同じ部品の理由）。 */}
        {page.ledgerBindingRejection === null ? null : (
          <Notice kind="caution">
            <div data-testid="write-start-ledger-unbound" data-reason={page.ledgerBindingRejection}>
              <p>{EXECUTION_GRANT_REJECTION_DESCRIPTIONS[page.ledgerBindingRejection].description}</p>
              <p>{EXECUTION_GRANT_REJECTION_DESCRIPTIONS[page.ledgerBindingRejection].action}</p>
            </div>
          </Notice>
        )}
        {page.startable ? null : <p data-testid="write-start-not-startable">{text.notStartable}</p>}
        {/* T41g: 登録してから更新する（台帳の参照を持つ更新のシナリオだけ）。 */}
        {page.chain === null ? null : <WriteChainOffer chain={page.chain} onOpen={() => setChainDialog(true)} />}
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
      {/* T41g: 登録してから更新する（2 回の書き込みを、それぞれの送り先と累積の残りとともに出す。取り消し側にフォーカス）。 */}
      {page.chain === null ? null : (
        <ConfirmDialog
          open={chainDialog}
          title={text.chain.dialogTitle}
          body={text.chain.dialogBody}
          confirmLabel={busy ? text.starting : text.chain.confirm}
          cancelLabel={text.startDialog.cancel}
          busy={busy}
          onCancel={() => setChainDialog(false)}
          onConfirm={() => {
            setBusy(true);
            // T41g-3（T41R5 の M-1）: 画面が読んだ台帳の登録のシナリオの版も送る（違えば、何も始めない）。
            void startChain({
              data: { scenarioId: scenario.scenarioId, expectedRevision: scenario.revision, expectedCreateRevision: page.chain?.create?.revision ?? 0 },
            })
              .then((result) => {
                setChainDialog(false);
                if (result.ok) {
                  setRejection(null);
                  void navigate({ to: '/jobs/$jobId', params: { jobId: result.jobId } });
                } else {
                  setRejection(result);
                }
              })
              .finally(() => setBusy(false));
          }}
        >
          <WriteChainSteps chain={page.chain} page={page} />
        </ConfirmDialog>
      )}
    </PageFrame>
  );
}

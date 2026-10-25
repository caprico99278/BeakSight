/**
 * 発見の画面の「シナリオの下書きを作る」（手を減らす段 2 の設計書 3A.2。5 章の 2026-10-22 の FM2b の Blocker の判断（案 2））。
 * - 押せるのは、最後の発見の時のプロファイルの改訂が今の改訂と同じときだけ。押せなければ、理由と次にできること（カタログの文言）を出す。
 * - 押すと、作るもの（型の行ごとの登録の下書き、照合の READ の定義の予定、入力の規則、更新の案内）を確認のダイアログで出し、確認の後にだけ作る
 *   （取り消し側にフォーカス）。作った結果（シナリオへのリンク、推した値の印と根拠、推せなかった項目の案内、推せなかった規則の欄）を出す。
 * - 更新は作らず、作成の画面へのリンク（候補・型・前もって選ぶ台帳と画面の型。ID と型だけ）を出す。
 * - 値（目印・送る値）は出さない（サーバの値にない）。印は表示だけで、承認に結ばない。
 */
import { useState } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import {
  LOCAL_UI_AUTO_DRAFT_TEXT,
  READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS,
  RULE_PROBLEM_DETAIL_DESCRIPTIONS,
  SCENARIO_DRAFT_REJECTION_DESCRIPTIONS,
  SCENARIO_REQUEST_REJECTION_DESCRIPTIONS,
} from '../../../../src/presentation/messages.js';
import {
  createScenarioAutoDraftsFn,
  type AutoDraftCreatePreviewView,
  type AutoDraftCreateResultView,
  type AutoDraftPreviewView,
  type AutoDraftResultView,
  type AutoDraftRowView,
  type AutoDraftUpdatePreviewView,
  type AutoDraftUpdateResultView,
  type AutoDraftValueView,
} from '../server/scenario-autodraft-functions';
// 自動の下書きの案内から開いた作成の画面の印（URL の引数。承認に結ばない。値の 1 か所は `auto-draft-search.ts`）。
import { AUTO_DRAFT_SEARCH_MARK } from '../display/auto-draft-search';
import { ConfirmDialog } from './ConfirmDialog';
import { DraftValueMark } from './DraftValueMark';
import { Notice } from './Notice';

const text = LOCAL_UI_AUTO_DRAFT_TEXT;

const rowLabelOf = (row: AutoDraftRowView): string => text.rowLabel(row.method, row.pathShape, row.pagePath);

/** 値と、その印と根拠。 */
function MarkedValue({ label, value, testId }: Readonly<{ label: string; value: AutoDraftValueView; testId: string }>) {
  return (
    <>
      <dt>{label}</dt>
      <dd data-testid={testId} data-value={value.value}>
        <code>{value.value}</code>{' '}
        <DraftValueMark origin={value.origin} ground={value.ground} />
      </dd>
    </>
  );
}

/** 確認のダイアログの、登録の行 1 つ。 */
function CreatePreview({ item }: Readonly<{ item: AutoDraftCreatePreviewView }>) {
  return (
    <li data-testid="auto-draft-preview-create" data-status={item.status} data-shape-digest={item.shapeDigest}>
      <p>{rowLabelOf(item)}: <strong>{text.createStatuses[item.status]}</strong></p>
      {item.reason === null ? null : <p className="field-hint">{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[item.reason].description}</p>}
      {item.status !== 'NEW' ? null : (
        <dl className="facts">
          {item.recordIdKey === null
            ? (<><dt>{text.recordIdKeyLabel}</dt><dd data-testid="auto-draft-record-id-missing">{text.recordIdKeyMissing}</dd></>)
            : <MarkedValue label={text.recordIdKeyLabel} value={item.recordIdKey} testId="auto-draft-record-id-key" />}
          <dt>{text.readCheckLabel}</dt>
          <dd data-testid="auto-draft-preview-read-check" data-outcome={item.readCheck ?? ''}>
            {item.readCheck === null ? null : text.readCheckPlannedOutcomes[item.readCheck]}
            {item.readTemplate === null ? null : (<>{' '}<code>{item.readTemplate.value}</code>{' '}<DraftValueMark origin={item.readTemplate.origin} ground={item.readTemplate.ground} /></>)}
          </dd>
          <dt>{text.rulesLabel}</dt>
          <dd>{text.rulesPlanned}</dd>
        </dl>
      )}
    </li>
  );
}

/** 確認のダイアログの、更新の行 1 つ。 */
function UpdatePreview({ item }: Readonly<{ item: AutoDraftUpdatePreviewView }>) {
  return (
    <li data-testid="auto-draft-preview-update" data-status={item.status} data-shape-digest={item.shapeDigest}>
      <p>{rowLabelOf(item)}: <strong>{text.updateStatuses[item.status]}</strong></p>
      {item.reason === null ? null : <p className="field-hint">{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[item.reason].description}</p>}
    </li>
  );
}

/** 作った結果の、登録の行 1 つ。 */
function CreateResult({ profileId, item }: Readonly<{ profileId: string; item: AutoDraftCreateResultView }>) {
  const statusText = item.status === 'CREATED' ? text.createdStatus : item.status === 'FAILED' ? text.failedStatus : text.createStatuses[item.status];
  return (
    <li data-testid="auto-draft-result-create" data-status={item.status} data-scenario-id={item.scenarioId ?? ''} data-shape-digest={item.shapeDigest}>
      <p>{rowLabelOf(item)}: <strong>{statusText}</strong></p>
      {item.failure === null ? null : <p className="field-hint">{SCENARIO_REQUEST_REJECTION_DESCRIPTIONS[item.failure].description}</p>}
      {item.reason === null ? null : <p className="field-hint">{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[item.reason].description}</p>}
      {item.scenarioId === null ? null : (
        <div className="button-row">
          <Link to="/scenarios/$profileId/$scenarioId" params={{ profileId, scenarioId: item.scenarioId }} className="button" data-testid="auto-draft-open-scenario">
            {text.openScenario}
          </Link>
          {item.status !== 'CREATED' ? null : (
            <Link to="/scenarios/$profileId/$scenarioId/rules" params={{ profileId, scenarioId: item.scenarioId }} className="button">{text.openRules}</Link>
          )}
        </div>
      )}
      {item.status !== 'CREATED' ? null : (
        <dl className="facts">
          {item.recordIdKey === null
            ? (<><dt>{text.recordIdKeyLabel}</dt><dd data-testid="auto-draft-record-id-missing">{text.recordIdKeyMissing}</dd></>)
            : <MarkedValue label={text.recordIdKeyLabel} value={item.recordIdKey} testId="auto-draft-record-id-key" />}
          <dt>{text.readCheckLabel}</dt>
          <dd data-testid="auto-draft-read-check" data-outcome={item.readCheck ?? ''}>
            {item.readCheck === null ? null : text.readCheckOutcomes[item.readCheck]}
            {item.readTemplate === null ? null : (<>{' '}<code>{item.readTemplate.value}</code>{' '}<DraftValueMark origin={item.readTemplate.origin} ground={item.readTemplate.ground} /></>)}
            {item.readCheckRejection === null ? null : <span className="field-hint">{READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS[item.readCheckRejection].description}</span>}
          </dd>
          {/* FM2R の Minor 10: 結ばなかったときは、その理由を事実のとおりに出す。 */}
          {item.expectation === null
            ? (
              <>
                <dt>{text.expectationLabel}</dt>
                <dd data-testid="auto-draft-expectation-missing" data-outcome={item.expectationOutcome ?? ''}>
                  {item.expectationOutcome === null ? null : text.expectationOutcomes[item.expectationOutcome]}
                </dd>
              </>
            )
            : <MarkedValue label={text.expectationLabel} value={item.expectation} testId="auto-draft-expectation" />}
          <dt>{text.rulesLabel}</dt>
          <dd data-testid="auto-draft-rules" data-attached={String(item.rules?.attached ?? false)}>
            {item.rules?.attached === true ? text.rulesAttached : text.rulesFailed}
          </dd>
        </dl>
      )}
      {item.rules === null || item.status !== 'CREATED' ? null : (
        <>
          <h4>{text.unresolvedHeading}</h4>
          {item.rules.unresolved.length === 0 ? <p>{text.noUnresolved}</p> : (
            <ul data-testid="auto-draft-unresolved">
              {item.rules.unresolved.map(({ fieldName, problem }) => (
                <li key={fieldName} data-field={fieldName} data-detail={problem.detail}>
                  <code>{fieldName}</code>: {RULE_PROBLEM_DETAIL_DESCRIPTIONS[problem.detail].description}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

/** 作った結果の、更新の行 1 つ（作成の画面へのリンク）。 */
function UpdateResult({ profileId, item }: Readonly<{ profileId: string; item: AutoDraftUpdateResultView }>) {
  const { link } = item;
  return (
    <li data-testid="auto-draft-result-update" data-status={item.status} data-shape-digest={item.shapeDigest}>
      <p>{rowLabelOf(item)}: <strong>{text.updateStatuses[item.status]}</strong></p>
      {item.reason === null ? null : <p className="field-hint">{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[item.reason].description}</p>}
      {link === null ? null : (
        <>
          <dl className="facts">
            {item.presetLedger === null
              ? (<><dt>{text.form.presetLedger}</dt><dd data-testid="auto-draft-ledger-unset">{item.ledgerOptionCount === 0 ? text.form.noLedger : text.form.chooseLedger}</dd></>)
              : <MarkedValue label={text.form.presetLedger} value={item.presetLedger} testId="auto-draft-preset-ledger" />}
            {item.presetTemplate === null ? null : <MarkedValue label={text.form.presetFormPathTemplate} value={item.presetTemplate} testId="auto-draft-preset-template" />}
          </dl>
          <div className="button-row">
            <Link
              to="/scenarios/$profileId/new"
              params={{ profileId }}
              search={{
                candidate: link.candidate,
                shape: link.shape,
                ...(link.ledger === null ? {} : { ledger: link.ledger }),
                ...(link.template === null ? {} : { template: link.template }),
                autoDraft: AUTO_DRAFT_SEARCH_MARK,
              }}
              className="button button--primary"
              data-testid="auto-draft-open-create-form"
            >
              {text.openCreateForm}
            </Link>
          </div>
        </>
      )}
    </li>
  );
}

/** 発見の画面の、シナリオの下書きを作るまとまり。 */
export function ScenarioAutoDraftPanel({ profileId, preview }: Readonly<{ profileId: string; preview: AutoDraftPreviewView | null }>) {
  const create = useServerFn(createScenarioAutoDraftsFn);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AutoDraftResultView | null>(null);
  const blocker = preview?.blocker ?? 'DISCOVERY_MISSING';
  const pressable = preview !== null && preview.blocker === null && preview.discoveryJobId !== null;

  return (
    <section className="panel" data-testid="auto-draft-panel">
      <h2 className="panel-heading">{text.heading}</h2>
      <p>{text.guidance}</p>
      {pressable ? null : (
        <Notice kind="caution" heading={text.cannotHeading}>
          <div data-testid="auto-draft-blocker" data-reason={blocker}>
            <p>{text.blockers[blocker].description}</p>
            <p>{text.blockers[blocker].action}</p>
          </div>
        </Notice>
      )}
      <div className="button-row">
        <button type="button" className="button button--primary" disabled={!pressable || busy} data-testid="auto-draft-open" onClick={() => setOpen(true)}>
          {busy ? text.creating : text.open}
        </button>
      </div>
      {preview === null ? null : (
        <ConfirmDialog
          open={open}
          title={text.dialog.title}
          body={text.dialog.body}
          confirmLabel={text.dialog.confirm}
          cancelLabel={text.dialog.cancel}
          busy={busy}
          onCancel={() => setOpen(false)}
          onConfirm={() => {
            if (preview.discoveryJobId === null) {
              return;
            }
            setBusy(true);
            void create({ data: { profileId, expectedRevision: preview.expectedRevision, discoveryJobId: preview.discoveryJobId } })
              .then((made) => {
                setOpen(false);
                setResult(made);
                return router.invalidate();
              })
              .finally(() => setBusy(false));
          }}
        >
          <div className="dialog-details" data-testid="auto-draft-preview">
            <h3>{text.createsHeading}</h3>
            {preview.creates.length === 0 ? <p>{text.noCreates}</p> : (
              <ul>{preview.creates.map((item) => <CreatePreview key={`${item.identityDigest} ${item.shapeDigest}`} item={item} />)}</ul>
            )}
            <h3>{text.updatesHeading}</h3>
            {preview.updates.length === 0 ? <p>{text.noUpdates}</p> : (
              <ul>{preview.updates.map((item) => <UpdatePreview key={`${item.identityDigest} ${item.shapeDigest}`} item={item} />)}</ul>
            )}
          </div>
        </ConfirmDialog>
      )}
      {result === null ? null : result.ok ? (
        <div data-testid="auto-draft-result">
          <h3>{text.resultHeading}</h3>
          <h4>{text.createsHeading}</h4>
          {result.creates.length === 0 ? <p>{text.noCreates}</p> : (
            <ul>{result.creates.map((item) => <CreateResult key={`${item.identityDigest} ${item.shapeDigest}`} profileId={profileId} item={item} />)}</ul>
          )}
          <h4>{text.updatesHeading}</h4>
          {result.updates.length === 0 ? <p>{text.noUpdates}</p> : (
            <ul>{result.updates.map((item) => <UpdateResult key={`${item.identityDigest} ${item.shapeDigest}`} profileId={profileId} item={item} />)}</ul>
          )}
        </div>
      ) : (
        <Notice kind="critical" heading={text.cannotHeading}>
          <div data-testid="auto-draft-result-blocker" data-reason={result.blocker}>
            <p>{text.blockers[result.blocker].description}</p>
            <p>{text.blockers[result.blocker].action}</p>
          </div>
        </Notice>
      )}
    </section>
  );
}

/**
 * 書き込みの結果の、画面に返す値（Task 30 の設計書 3 章の「結果の判定」「予約の締め」「`UNKNOWN` の後」。T30g）。ジョブの詳細とシナリオの書き込みの
 * 履歴が共用する。読み出しは `src/control/actions/write-result-facts.ts`（書き込みの結果の表の読み出しの owner）。
 * - 返す値は、結果・送信の状態・止めた理由・応答の HTTP の状態と判定・登録の ID・照合の READ・予約の締めと、送った値（入力の規則で作った合成の
 *   テストデータ。設計書 3 章の「記録」で平文として扱う値）。seed の記録・一意にする欄の組・電話番号の一覧は返さない。日時は ISO 8601。
 * - サーバの Server Function のファイル（`audit-job-functions.ts`、`scenario-functions.ts`）だけが import する（ブラウザ側のコードは型だけ）。
 * - T31h-2（Task 31 の設計書 3 章の「証拠と記録」、8.1）: 書き込みの種類と、更新（UPDATE）の対象のレコードの ID、前後の差分（変えた欄の前の値と
 *   新しい値と一致、保つ欄の一致だけ。保つ欄の値は記録にないので返さない）を足した。取れた ID は `recordId`。
 * - T32g（Task 32 の設計書 4.1 の「親の確かめと画面の配布」）: 書き込みの報告（親の確かめの結果と、配るときだけ報告の HTML と書き込みのバンドルの
 *   URL のパス）を足した。配るかと URL は、成果物の一覧（`artifact-files.ts` の `listJobArtifacts`。親の確かめが `VALID` のジョブだけ）から決める。
 * - T40d（Task 40 の設計書 3.5）: 送り方と API の型の要約（台帳の版 14 の `WriteResultView.transport`・`api`。値を持たない）を足した。
 */
import type {
  ActionBlockReason,
  ActionOutcomeReason,
  ActionResult,
  ResponseJudgement,
  SettledReservationState,
  SubmissionState,
} from '../../../../src/control/actions/action-contracts.js';
import {
  readWriteResult,
  readWriteResults,
  type WriteResultApiShape,
  type WriteResultView,
} from '../../../../src/control/actions/write-result-facts.js';
import type { ScenarioKind, ScenarioTransport } from '../../../../src/control/approval-view.js';
import type { ReadCheckResult } from '../../../../src/control/discovery-view.js';
import type { WriteReportCheck } from '../../../../src/control/job/job-records.js';
import { compareCodeUnits } from '../../../../src/core/text.js';
import { listJobArtifacts } from './artifact-files';
import { localUiAuditJobs } from './audit-jobs';
import { localUiStore } from './control-store';
import { isoTimestampOf, isoTimestampOrNull } from './timestamps';

/**
 * 書き込みの報告（T32g）。親の確かめの結果（締める前・結果の前にワーカーが終わったときは null）と、配るときだけ、報告の HTML と書き込みの
 * バンドルの成果物の URL のパス。
 */
export interface WriteReportView {
  readonly check: WriteReportCheck | null;
  readonly reportHref: string | null;
  readonly bundleHref: string | null;
}

/** 送った値 1 つ（欄の名前と、合成のテストデータの値）。 */
export interface SubmittedValueView {
  readonly name: string;
  readonly value: string;
}

/** 前後の差分の、変えた欄 1 つ（T31h-2。前の値と送った新しい値は、BeakSight が登録したテストのレコードの合成の値）。 */
export interface WriteChangedFieldView {
  readonly fieldName: string;
  readonly previousValue: string;
  readonly newValue: string;
  /** 更新の後の照合で一致したか（照合できなければ null）。 */
  readonly matched: boolean | null;
}

/** 前後の差分の、保つ欄 1 つ（T31h-2。値は記録にないので持たない）。 */
export interface WriteKeptFieldView {
  readonly fieldName: string;
  readonly matched: boolean | null;
}

/** 更新（UPDATE）の結果の対象と前後の差分（T31h-2）。証拠がなければ（照合まで進まなかった）、欄の一覧は空で `evidence` が偽。 */
export interface WriteUpdateResultView {
  readonly targetRecordId: string;
  readonly evidence: boolean;
  /** 変えた欄・保つ欄（欄の名前の順）。 */
  readonly changed: readonly WriteChangedFieldView[];
  readonly kept: readonly WriteKeptFieldView[];
}

/** 書き込みの結果 1 件（締める前は、結果から締めの時刻までが null）。 */
export interface WriteResultSummaryView {
  readonly jobId: string;
  /** T31h-2: 書き込みの種類（登録・更新）。 */
  readonly writeKind: ScenarioKind;
  /** T31h-2: 更新の対象と前後の差分（更新だけ。登録は null）。 */
  readonly update: WriteUpdateResultView | null;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  readonly result: ActionResult | null;
  readonly reason: ActionOutcomeReason | null;
  readonly submission: SubmissionState | null;
  readonly blockReason: ActionBlockReason | null;
  readonly httpStatus: number | null;
  readonly responseJudgement: ResponseJudgement | null;
  readonly recordId: string | null;
  readonly readVerification: ReadCheckResult | null;
  readonly reservationState: SettledReservationState | null;
  readonly recordedAt: string;
  readonly submittedAt: string | null;
  readonly settledAt: string | null;
  /** 送った値（欄の名前の順）。 */
  readonly submittedValues: readonly SubmittedValueView[];
  /** T32g: 書き込みの報告。 */
  readonly report: WriteReportView;
  /** T40d: 送り方（版 14 の前の行は `FORM`）。 */
  readonly transport: ScenarioTransport;
  /** T40d: API の型の要約（型の digest、method、送り先の Origin、path の型。API の行だけ。FORM は null）。 */
  readonly api: WriteResultApiShape | null;
}

/** 欄の名前の順（並べ方は core の比べ方 `compareCodeUnits`）。 */
const byFieldName = (left: { readonly fieldName: string }, right: { readonly fieldName: string }): number =>
  compareCodeUnits(left.fieldName, right.fieldName);

/** 更新の対象と前後の差分（対象の ID がない登録は null）。 */
const updateResultOf = (view: WriteResultView): WriteUpdateResultView | null => {
  if (view.targetRecordId === null) {
    return null;
  }
  const fields = view.updateEvidence?.fields ?? [];
  return {
    targetRecordId: view.targetRecordId,
    evidence: view.updateEvidence !== null,
    changed: fields.flatMap(({ fieldName, role, previousValue, newValue, matched }) =>
      (role === 'CHANGED' && previousValue !== null && newValue !== null ? [{ fieldName, previousValue, newValue, matched }] : [])).sort(byFieldName),
    // 保つ欄は、名前と一致だけ（値は記録にない）。
    kept: fields.flatMap(({ fieldName, role, matched }) => (role === 'KEPT' ? [{ fieldName, matched }] : [])).sort(byFieldName),
  };
};

/** 報告の確かめも成果物もないときの書き込みの報告（ジョブの行がない記録など）。 */
const NO_WRITE_REPORT: WriteReportView = Object.freeze({ check: null, reportHref: null, bundleHref: null });

/** T32g: ジョブの書き込みの報告（配るかと URL は成果物の一覧から。ジョブの行がなければ、確かめも配布もない）。 */
const writeReportOf = async (jobId: string): Promise<WriteReportView> => {
  const job = localUiAuditJobs().getAuditJob(jobId);
  if (job === null) {
    return NO_WRITE_REPORT;
  }
  const artifacts = await listJobArtifacts(job);
  return {
    check: job.writeReportCheck,
    reportHref: artifacts.find(({ kind }) => kind === 'ACTION_REPORT')?.href ?? null,
    bundleHref: artifacts.find(({ kind }) => kind === 'ACTION_BUNDLE')?.href ?? null,
  };
};

/** 書き込みの結果を、画面に返す値にする。 */
const summaryOf = async (view: WriteResultView): Promise<WriteResultSummaryView> => ({
  jobId: view.jobId,
  writeKind: view.writeKind,
  update: updateResultOf(view),
  scenarioId: view.scenarioId,
  scenarioRevision: view.scenarioRevision,
  result: view.result,
  reason: view.reason,
  submission: view.submission,
  blockReason: view.blockReason,
  httpStatus: view.httpStatus,
  responseJudgement: view.responseJudgement,
  recordId: view.recordId,
  readVerification: view.readVerification,
  reservationState: view.reservationState,
  recordedAt: isoTimestampOf(view.recordedAt),
  submittedAt: isoTimestampOrNull(view.submittedAt),
  settledAt: isoTimestampOrNull(view.settledAt),
  // 欄の名前の順の表示の行（並べ方は core の比べ方 `compareCodeUnits`）。
  submittedValues: Object.entries(view.submittedValues)
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => compareCodeUnits(left.name, right.name)),
  report: await writeReportOf(view.jobId),
  transport: view.transport,
  api: view.api === null ? null : { ...view.api },
});

/** 書き込みのジョブの結果（なければ null）。 */
export const writeResultSummaryOfJob = async (jobId: string): Promise<WriteResultSummaryView | null> => {
  const view = readWriteResult(localUiStore(), jobId);
  return view === null ? null : summaryOf(view);
};

/** シナリオの書き込みの履歴（新しい順）。 */
export const writeResultSummariesOfScenario = async (scenarioId: string): Promise<readonly WriteResultSummaryView[]> =>
  (await Promise.all(readWriteResults(localUiStore(), scenarioId).map(summaryOf))).reverse();

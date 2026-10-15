// 書き込みのジョブの `START` の書き込みの指定を組み立てる純粋な部品（Task 30 の設計書 3 章の「検証の指定」「READ による照合」、4 章の「IPC」。T30e）。
// ジョブの管理（`audit-job-manager.ts`）が、実行の許可を消費し、値を生成した後に使う（ワーカーは管理データを読まないので、親が入れる）。
// - 照合の READ: シナリオの検証の指定の結び付け（READ の送る値の名前 → シナリオの送る欄）で、READ の定義の送る値の一部を生成した値に置き換え、
//   期待は検証の指定の期待から作る（行の数はそのまま、本文と詳細の項目は生成した値）。結び付ける値・比べる値が null（送らない欄）なら作らない。
// - 候補の欄は、名前・型・readonly・hidden・disabled だけを写す（値と選択肢は写さない）。
// - 基準日（Task 29 の生成の `baseDate`）は、実行の許可の発行の日（Asia/Tokyo の `YYYY-MM-DD`。Task 29 の設計書 3 章）。
// - T31f（Task 31 の設計書 4 章の「IPC」）: UPDATE のシナリオは、実行の許可の対象の ID（`targetRecordId`）を受け、書き込みの画面の path と要求の
//   path を、シナリオの path の型に対象の ID を入れた具体的な path にし、UPDATE の指定（対象の ID、型にした識別の digest、変える欄と保つ欄の名前）を
//   足す（ワーカーは型を扱わない）。保つ欄の値と前の値は入れない。対象の ID の有無がシナリオの種類と合わなければ作らない。
// - T32d（Task 32 の設計書 4.1 の「承認の要約の受け渡し」）: 書き込みの報告の承認の要約の事実（`approvalFacts`）を、受けたまま入れる（組み立ては
//   `src/control/actions/approval-summary-facts.ts`）。
// 管理データ・ブラウザ・ワーカーに触れない。
import type { ApprovalSummaryFacts } from '../actions/action-contracts.js';
import type { ScenarioRevision, VerificationExpectation } from '../approval/scenario-contracts.js';
import type { SeedRecord } from '../data-rules/scenario-data.js';
import type { CandidateLocation, DiscoveryCandidate } from '../../discovery/candidate-contracts.js';
import type { ReadCheckExpectation, ReadCheckParameters } from '../../discovery/read-check-contracts.js';
import { baseDateOf } from '../../core/base-date.js';
import { dateOfCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import { concretePathOfTemplate } from '../../discovery/fingerprint.js';
import type { WorkerStartReadCheck, WorkerStartWrite } from '../worker-protocol.js';
import type { ReadCheckView } from './read-check-store.js';

/**
 * 書き込みのジョブの成果物の名前（Run のディレクトリの中。`schemas/action-run.schema.json`。ワーカーが書き、親が読む）。T30f（CC-084）: 定義は成果物の
 * 名前の owner（`src/core/artifact-layout.ts`）に移した。ここは、ジョブの管理のために、その値をそのまま公開する。
 */
export { ACTION_RUN_ARTIFACT_FILE_NAME } from '../../core/artifact-layout.js';

/**
 * 生成の基準日（実行の許可の発行の時刻（UTC の 14 桁）の、Asia/Tokyo の `YYYY-MM-DD`。計算は基準日の owner の `baseDateOf`。CCX-20）。
 * 時刻の形が違えば `RangeError`。
 */
export const writeBaseDateOf = (issuedAt: string): string => baseDateOf(dateOfCompactUtcTimestamp(issuedAt));

/** 書き込みの指定の入力。 */
export interface WriteStartInputs {
  readonly scenario: ScenarioRevision;
  /** 承認した版の、発見の根拠の写し（候補の契約の形）。 */
  readonly evidence: DiscoveryCandidate;
  readonly grantId: string;
  /** T30f: プロファイルと、生成の seed の記録（送る前の記録に書くものと同じ値）。 */
  readonly profileId: string;
  readonly seedRecord: SeedRecord;
  /** 生成した値（欄の名前 → 値。null は送らない）。 */
  readonly values: Readonly<Record<string, string | null>>;
  /** 照合の READ の定義（検証の指定の id と版のもの）。 */
  readonly readCheck: ReadCheckView;
  /** 照合の READ の対象の画面（決められなければ null）。 */
  readonly targetPage: CandidateLocation | null;
  /** T31f: 更新の対象のレコードの ID（実行の許可の `targetRecordId`。UPDATE のシナリオだけ。CREATE は null か省略）。 */
  readonly targetRecordId?: string | null;
  /** T32d: 書き込みの報告の承認の要約の事実（許可の消費の直後に `approvalSummaryFactsOf` で組み立てたもの。そのまま `START` に入れる）。 */
  readonly approvalFacts: ApprovalSummaryFacts;
}

/** 生成した値（送らない値と、ない値は null）。 */
const valueOf = (values: Readonly<Record<string, string | null>>, fieldName: string): string | null =>
  Object.hasOwn(values, fieldName) ? values[fieldName] ?? null : null;

/** 期待を、生成した値で作る（比べる値がなければ null）。 */
const expectationOf = (expectation: VerificationExpectation, values: Readonly<Record<string, string | null>>): ReadCheckExpectation | null => {
  switch (expectation.kind) {
    case 'ROW_COUNT_EQUALS':
      return { kind: expectation.kind, count: expectation.count };
    case 'TEXT_CONTAINS': {
      const text = valueOf(values, expectation.fieldName);
      return text === null ? null : { kind: expectation.kind, text };
    }
    case 'DETAIL_FIELD_EQUALS': {
      const value = valueOf(values, expectation.fieldName);
      return value === null ? null : { kind: expectation.kind, field: expectation.field, value };
    }
  }
};

/**
 * `START` の書き込みの指定（作れなければ null: 検証の指定に未指定の項目がある、READ の定義の id と版が検証の指定と違う、結び付ける値・比べる値が
 * null、T31f: 対象の ID の有無がシナリオの UPDATE の指定の有無と合わない、CCX-28: path の型に対象の ID を入れられない）。形と上限の確かめは、IPC の契約（`validateParentToWorkerMessage`）が行う。
 */
export const writeStartSpecOf = (inputs: WriteStartInputs): WorkerStartWrite | null => {
  const { scenario, evidence, readCheck, values } = inputs;
  const { successCondition, inputErrorCondition, recordId, readVerification } = scenario.verification;
  const targetRecordId = inputs.targetRecordId ?? null;
  if (successCondition === null || inputErrorCondition === null || recordId === null || readVerification === null
    || readCheck.readCheckId !== readVerification.readCheckId || readCheck.revision !== readVerification.revision
    || (scenario.update === null) !== (targetRecordId === null)) {
    return null;
  }
  const parameters: Record<string, string> = { ...readCheck.definition.parameters };
  for (const { parameterName, fieldName } of readVerification.bindings) {
    const value = valueOf(values, fieldName);
    if (value === null) {
      return null;
    }
    parameters[parameterName] = value;
  }
  const expectations = readVerification.expectations.map((expectation) => expectationOf(expectation, values));
  if (expectations.some((expectation) => expectation === null)) {
    return null;
  }
  const bound: WorkerStartReadCheck = {
    readCheckId: readCheck.readCheckId,
    readCheckRevision: readCheck.revision,
    targetPage: inputs.targetPage,
    definition: {
      targetIdentityDigest: readCheck.definition.targetIdentityDigest,
      parameters: parameters as ReadCheckParameters,
      expectations: expectations as ReadCheckExpectation[],
    },
  };
  const common = {
    scenarioId: scenario.scenarioId,
    scenarioRevision: scenario.revision,
    grantId: inputs.grantId,
    profileId: inputs.profileId,
    seedRecord: inputs.seedRecord,
    candidate: { identityDigest: scenario.candidate.identityDigest, ruleDigest: scenario.candidate.ruleDigest },
    candidateFields: evidence.fields.map(({ name, type, readonly, hidden, disabled }) => ({ name, type, readonly, hidden, disabled })),
    values: { ...values },
    verification: { successCondition, inputErrorCondition, recordId },
    readVerification: bound,
    approvalFacts: inputs.approvalFacts,
  };
  if (scenario.update === null || targetRecordId === null) {
    return { ...common, request: scenario.request, formPage: { origin: evidence.page.origin, path: evidence.page.path } };
  }
  // T31f: UPDATE は、型に対象の ID を入れた具体的な path（CCX-28: 型の owner の `concretePathOfTemplate`）と、UPDATE の指定（値を持たない）。
  const { update } = scenario;
  const actionPath = concretePathOfTemplate(update.actionPathTemplate, targetRecordId);
  const formPath = concretePathOfTemplate(update.formPathTemplate, targetRecordId);
  if (actionPath === null || formPath === null) {
    return null;
  }
  return {
    ...common,
    request: { ...scenario.request, path: actionPath },
    formPage: { origin: evidence.page.origin, path: formPath },
    update: {
      targetRecordId,
      templatedIdentityDigest: update.templatedIdentityDigest,
      changedFieldNames: [...scenario.fieldNames],
      keptFieldNames: [...update.keepFieldNames],
    },
  };
};

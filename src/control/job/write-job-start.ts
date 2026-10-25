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
// - T37d（設計者の判断 5）: 照合の READ に、画面の path の定義は使わない（`readVerificationTargetRejectionOf`。書き込みの指定も作らない）。
// - T40a（Task 40 の設計書 3.2）: 送り方 API の登録のシナリオは、API の書き込みの指定（`WorkerStartApiWrite`）を作る: 承認した API の指定（シナリオの
//   API の指定のまま）、欄に対応する鍵ごとの生成した値（欄の識別は API の指定の `keyFields`）、送信の要素の識別の digest（登録の画面の候補の識別の
//   digest）、書き込みの画面、検証の指定、照合の READ（候補の READ か、`{id}` の型の画面の READ。型の READ は送る値なしで、対象の画面は呼び出し側が
//   入れる型の path）、承認の要約の事実。API の更新は Task 41 まで作らない。
// - T40a-fix: 検証の指定で求める項目は、許可の発行と同じ判定（`missingVerificationItemsOf`。API は照合の READ と ID の取り方だけ）。API の書き込みの
//   指定の成否の条件と入力の誤りの条件は null で、ID の取り方は検証の指定の `recordId`（API の `recordId` があれば null でもよい）。
// - T41b（Task 41 の設計書 3.2、8 章の設計者の判断 (2)）: API の更新は、許可の対象の ID を受け、`update: { targetRecordId }` と、台帳の画面の path の型に
//   対象の ID を入れた書き込みの画面を持つ（`api` はシナリオの API の指定のまま、`values` は変える鍵だけ）。
// 管理データ・ブラウザ・ワーカーに触れない。
import type { ApprovalSummaryFacts } from '../actions/action-contracts.js';
import { knownKeptValuesOf, type RecordValueWrite } from '../actions/write-result-facts.js';
import { missingVerificationItemsOf } from '../approval/scenario-policy.js';
import {
  API_SCENARIO_TRANSPORT,
  UPDATE_SCENARIO_KIND,
  scenarioTransportOf,
  type ScenarioRevision,
  type ScenarioTransport,
  type VerificationExpectation,
} from '../approval/scenario-contracts.js';
import type { SeedRecord } from '../data-rules/scenario-data.js';
import type { CandidateLocation, DiscoveryCandidate } from '../../discovery/candidate-contracts.js';
import {
  isReadCheckPageTemplatePath,
  readCheckTargetKindOf,
  type ReadCheckDefinition,
  type ReadCheckExpectation,
  type ReadCheckParameters,
} from '../../discovery/read-check-contracts.js';
import { baseDateOf } from '../../core/base-date.js';
import { dateOfCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import { concretePathOfTemplate } from '../../discovery/fingerprint.js';
import type { WorkerStartApiWrite, WorkerStartReadCheck, WorkerStartWrite } from '../worker-protocol.js';
import type { AuditJobStartRejectionReason } from './job-records.js';
import type { ReadCheckView } from './read-check-store.js';

// 書き込みのジョブの成果物の名前（`ACTION_RUN_ARTIFACT_FILE_NAME`）は、成果物の名前の owner（`src/core/artifact-layout.ts`）から直接 import する
// （CC-084。T30f で owner に移し、PRE42-CC の組 1a で、ここの公開し直しをやめた。Gate `owner-constant-reuse`）。

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
  /**
   * T41R2-fix-B（Task 41 の設計書 8 章の「T41R2」の C-2 (1)）: 同じ台帳のシナリオの書き込みの値の履歴（`readLedgerValueWrites`）。API の更新で、対象のレコードの
   * 保つ鍵ごとの最後に分かっている値（`knownKeptValuesOf`。T41R3-fix-B）を求める。省けば履歴なし（一覧は空）。
   */
  readonly ledgerWrites?: readonly RecordValueWrite[];
}

/** 照合の READ の定義を使えない理由（T37d。設計者の判断 5。閉じた一覧。開始を拒む理由 `AUDIT_JOB_START_REJECTION_REASONS` の一部）。 */
export const WRITE_READ_VERIFICATION_PAGE_TARGET = 'WRITE_READ_VERIFICATION_PAGE_TARGET' satisfies AuditJobStartRejectionReason;

/**
 * 書き込みの照合の READ に使えない定義か（T37d。設計者の判断 5。安全側）: 画面の path の定義（`targetPagePath`）は、書き込みの照合に使わない
 * （照合は、候補の送信先に生成した値を付けて読む形だけ）。使えなければ理由、使えれば null。
 * T38c（ユーザーの判断 (3)、T38c の Blocker の判断（案 A））: 送り方が API のシナリオに限って、`{id}` つきの画面の path の定義（`isReadCheckPageTemplatePath`）
 * を通す。T40a: API の登録のシナリオに許可が出るので、この口を通った型の READ は、書き込みの指定と IPC（`{id}` の型を開いた）に載る。
 */
export const readVerificationTargetRejectionOf = (
  readCheck: Pick<ReadCheckView, 'definition'>,
  transport: ScenarioTransport,
): typeof WRITE_READ_VERIFICATION_PAGE_TARGET | null => {
  const { definition } = readCheck;
  if (readCheckTargetKindOf(definition) !== 'PAGE') {
    return null;
  }
  return transport === API_SCENARIO_TRANSPORT && isReadCheckPageTemplatePath(definition.targetPagePath ?? '') ? null : WRITE_READ_VERIFICATION_PAGE_TARGET;
};

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
 * T40a（Task 40 の設計書 3.2）: 送り方 API の登録のシナリオは、API の書き込みの指定（`WorkerStartApiWrite`）を作る。API の更新（Task 41 まで）と、
 * API の指定を持たない API のシナリオは作らない。
 */
export const writeStartSpecOf = (inputs: WriteStartInputs): WorkerStartWrite | WorkerStartApiWrite | null => {
  const { scenario, evidence, readCheck, values } = inputs;
  const { successCondition, inputErrorCondition, recordId, readVerification } = scenario.verification;
  const targetRecordId = inputs.targetRecordId ?? null;
  const transport = scenarioTransportOf(scenario);
  // T41b: 対象の ID を持つのは、form の UPDATE の指定を持つ版と、API の更新（台帳の参照は API の指定）。
  const takesTarget = transport === API_SCENARIO_TRANSPORT ? scenario.kind === UPDATE_SCENARIO_KIND : scenario.update !== null;
  // T40a-fix: 求める項目は送り方で決まる（許可の発行と同じ判定 `missingVerificationItemsOf`。API は照合の READ と ID の取り方だけ）。
  if (missingVerificationItemsOf(scenario.verification, scenario).length > 0 || readVerification === null
    || readCheck.readCheckId !== readVerification.readCheckId || readCheck.revision !== readVerification.revision
    || takesTarget !== (targetRecordId !== null)) {
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
  // T37d（設計者の判断 5）: 画面の path の定義は、書き込みの照合に使わない（作らない。呼び出し側は開始の前に `readVerificationTargetRejectionOf` で拒む）。
  // T40a: API のシナリオに限って、`{id}` の型の画面の path の定義を使う（送る値なし。`{id}` はワーカーが取った登録の ID）。
  const { targetIdentityDigest, targetPagePath } = readCheck.definition;
  const target = targetIdentityDigest !== undefined
    ? { targetIdentityDigest }
    : transport === API_SCENARIO_TRANSPORT && targetPagePath !== undefined && isReadCheckPageTemplatePath(targetPagePath) ? { targetPagePath } : null;
  if (target === null) {
    return null;
  }
  const bound: WorkerStartReadCheck = {
    readCheckId: readCheck.readCheckId,
    readCheckRevision: readCheck.revision,
    targetPage: inputs.targetPage,
    definition: {
      ...target,
      parameters: parameters as ReadCheckParameters,
      expectations: expectations as ReadCheckExpectation[],
    } as ReadCheckDefinition,
  };
  if (transport === API_SCENARIO_TRANSPORT) {
    // T40a: 値は欄に対応する鍵ごとの生成した値（ページが決める鍵の値は生成しない）。
    // LG-3b: T40R-fix-B（M-2）の送り方の判定 `apiWriteRejectionOf` は捨てた（T41a の契約のない API の更新の版は、スキーマが拒むので読まれない）。
    // T41b（Task 41 の設計書 3.2、8 章の設計者の判断 (2)）: API の更新は、値は変える鍵だけ（生成した値。保つ鍵とページが決める鍵の値は持たない）、
    // `update: { targetRecordId }`、書き込みの画面は台帳の画面の path の型に対象の ID を入れた具体的な path（型の owner の `concretePathOfTemplate`）。
    // 照合の READ の `{id}` には、ワーカーが対象の ID を入れる（型の READ のまま渡す）。
    const { api } = scenario;
    if (api === undefined) {
      return null;
    }
    let formPath: string | null = evidence.page.path;
    if (targetRecordId !== null) {
      formPath = api.ledger === null ? null : concretePathOfTemplate(api.ledger.formPathTemplate, targetRecordId);
    }
    if (formPath === null) {
      return null;
    }
    return {
      transport: API_SCENARIO_TRANSPORT,
      scenarioId: scenario.scenarioId,
      scenarioRevision: scenario.revision,
      grantId: inputs.grantId,
      profileId: inputs.profileId,
      seedRecord: inputs.seedRecord,
      formPage: { origin: evidence.page.origin, path: formPath },
      candidate: { identityDigest: scenario.candidate.identityDigest, ruleDigest: scenario.candidate.ruleDigest },
      // 登録の画面は probe の候補を見た画面なので、送信の要素の識別の digest は候補の識別の digest（T39d の申し送り）。
      submitterIdentityDigest: scenario.candidate.identityDigest,
      api,
      values: { ...values },
      // T40a-fix: 成否の条件と入力の誤りの条件は使わない（null）。ID の取り方は検証の指定のもの（API の `recordId` があれば null でもよい）。
      verification: { successCondition: null, inputErrorCondition: null, recordId },
      readVerification: bound,
      approvalFacts: inputs.approvalFacts,
      // T41R2-fix-B・T41R3-fix-B（Task 41 の設計書 8 章の「T41R3」の C-3、ユーザーの判断「API の更新だけ台帳と比べる」）: 保つ鍵ごとの、台帳の値の履歴で
      // 最後に分かっている値（空を含む。値は BeakSight が作ったテストの値で `values` と同じ扱い）。ワーカーは、画面の値がこれと同じでなければ送らない。
      ...(targetRecordId === null ? {} : {
        update: {
          targetRecordId,
          knownKeptValues: knownKeptValuesOf(inputs.ledgerWrites ?? [], targetRecordId, (api.keptKeys ?? []).map(({ key }) => key)),
        },
      }),
    };
  }
  // T38b: form の要求の形がないシナリオは、form の書き込みの指定を作らない。form は 4 項目がそろっている（上の判定。型のために確かめ直す）。
  const { request } = scenario;
  if (request === null || successCondition === null || inputErrorCondition === null || recordId === null) {
    return null;
  }
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
    return { ...common, request, formPage: { origin: evidence.page.origin, path: evidence.page.path } };
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
    request: { ...request, path: actionPath },
    formPage: { origin: evidence.page.origin, path: formPath },
    update: {
      targetRecordId,
      templatedIdentityDigest: update.templatedIdentityDigest,
      changedFieldNames: [...scenario.fieldNames],
      keptFieldNames: [...update.keepFieldNames],
    },
  };
};

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
// - LU-8（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.5 の最後の段）: 台帳に一覧の行の選び方（`listRow`）のある API の更新は、書き込みの画面を
//   一覧の画面の path のまま（番号を入れない）にし、`update.listRow`（行を選ぶ値と、前の値を後から入れる印）を足す。行を選ぶ値がない・行を選ぶ欄が台帳の登録の
//   今の入力の規則で毎回違う欄でなければ作らない（送らずに止める）。
// - LU-12・LU-12b（設計書 4.0 の D5、5.5。ユーザーの判断 2026-11-03「台帳との比べをフォームの形にも広げる」）: フォームの一覧の行の更新（形 B。`update.listRow`）は、
//   書き込みの画面を一覧の画面の path、送信先を送信先の型に台帳の番号を入れた path にし、`update.listRow`（一覧の path・開き手の識別の digest・行を選ぶ値）と
//   `update.knownKeptValues`（保つ欄ごとの台帳の最後の値）を足す。行を選ぶ値の決め方と、作らない条件は API の形と同じ部品（`listRowKeyValueOf`）。
// - LU-7 fix round 2（設計書 5.5 の 7、K3）: 一覧の行の更新は、照合の READ に一覧の画面（`listRow.listPagePath`）の定義も使う。「毎回違う欄」の判定は、許可の
//   発行と同じ唯一の判定 `readVerificationUniqueRejectionOf`（一覧の行の更新は行を選ぶ欄で判定する。LU-8 の確かめ直しも、これ 1 つ）。変える欄の新しい値が、
//   台帳の最後に分かっている値と同じなら作らない（変わったことを一覧で確かめられないため。生成の決まりは前の値を避けない）。
// 管理データ・ブラウザ・ワーカーに触れない。
import type { ApprovalSummaryFacts } from '../actions/action-contracts.js';
import { knownKeptValuesOf, type RecordValueWrite } from '../actions/write-result-facts.js';
import { missingVerificationItemsOf } from '../approval/scenario-policy.js';
import {
  API_SCENARIO_TRANSPORT,
  UPDATE_SCENARIO_KIND,
  isFormRecordIdSpec,
  scenarioTransportOf,
  type ScenarioListRow,
  type ScenarioRevision,
  type ScenarioTransport,
  type VerificationExpectation,
} from '../approval/scenario-contracts.js';
import type { SeedRecord } from '../data-rules/scenario-data.js';
import { isListPageReadTarget, readVerificationUniqueRejectionOf } from '../data-rules/varying-values.js';
import { CREATE_SCENARIO_KIND } from '../../core/scenario-kind.js';
import type { CandidateLocation, DiscoveryCandidate } from '../../discovery/candidate-contracts.js';
import {
  readListPagePathOf,
  isReadCheckPageTemplatePath,
  readCheckTargetKindOf,
  type ReadCheckDefinition,
  type ReadCheckExpectation,
  type ReadCheckParameters,
} from '../../discovery/read-check-contracts.js';
import { baseDateOf } from '../../core/base-date.js';
import { dateOfCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import { concretePathOfTemplate } from '../../discovery/fingerprint.js';
import type {
  WorkerStartApiWrite, WorkerStartApiWriteFilterValue, WorkerStartApiWriteLedgerKeyValue, WorkerStartApiWriteListRow, WorkerStartReadCheck, WorkerStartWrite, WorkerStartWriteListRow,
} from '../worker-protocol.js';
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
  /**
   * OP-REV6 の I-1（設計書 4.1.9 の R1）: 実行のたびに違う値になる欄の名前（値の生成の持ち主の判定 `uniqueEachRunFieldNamesOf`。親が入力の規則から求める）。一覧の
   * 画面の照合の READ は、この欄と比べる期待があるときだけ作る（一覧には前の登録が並ぶため）。省けば空（一覧の画面の指定は作らない）。
   */
  readonly uniqueEachRunFieldNames?: readonly string[];
  /**
   * LU-8（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.5 の最後の段）: 一覧の行の更新の、台帳の登録のシナリオの今の入力の規則で、実行のたびに違う値に
   * なる欄の名前（値の生成の持ち主の判定 `uniqueEachRunFieldNamesOf`。親が台帳の登録の入力の規則から求め直す）。行を選ぶ欄（`listRow.rowKeyField`）がこの中に
   * なければ作らない（許可を出す時の確かめ直し）。省くか null なら、一覧の行の更新は作らない（fail-closed）。一覧の行のない更新・登録は見ない。
   */
  readonly ledgerUniqueEachRunFieldNames?: readonly string[] | null;
  /**
   * DEF-198（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.9 の 3）: 更新の対象のレコード（`targetRecordId`）を登録した、同じ点検の登録の書き込みの
   * 成果物の、ページが決める鍵の値（親が締めで確かめた `action-run.json` の `api.pageKeyValues`。JSON の scalar を JSON の文字列にした形。親のメモリの中だけ）。
   * API の指定にほかの filter の名前がある更新は、同じ名前の値から照らす値（`update.otherFilterValues`）を作る。省くか null なら、その更新は作らない（送らない）。
   * DEF-203（5.10 の 1）: 台帳の登録の値と照らす鍵（`api.ledgerPageKeys`）の値（`update.ledgerKeyValues`）も、同じ値から作る。
   */
  readonly createPageKeyValues?: Readonly<Record<string, string | null>> | null;
}

/**
 * DEF-198・DEF-203（設計書 5.9 の 3、5.10 の 1）: 登録の成果物のページが決める鍵の、名前ごとの値（JSON の文字列の形）を読んで JSON の値にする唯一の読み方（純粋）。
 * 名前のどれかに値がない・伏せの印（null）・読めない・`accepts` が受けない値なら null（作らない。送らずに止める）。
 */
const createPageKeyValuesOf = <T>(
  names: readonly string[],
  createPageKeyValues: Readonly<Record<string, string | null>> | null | undefined,
  accepts: (value: unknown) => value is T,
): readonly { readonly key: string; readonly value: T }[] | null => {
  if (names.length === 0) {
    return Object.freeze([]);
  }
  if (createPageKeyValues === null || createPageKeyValues === undefined) {
    return null;
  }
  const values: { readonly key: string; readonly value: T }[] = [];
  for (const key of names) {
    const text = Object.hasOwn(createPageKeyValues, key) ? createPageKeyValues[key] ?? null : null;
    let value: unknown;
    try {
      value = text === null ? undefined : JSON.parse(text);
    } catch {
      return null;
    }
    if (!accepts(value)) {
      return null;
    }
    values.push(Object.freeze({ key, value }));
  }
  return Object.freeze(values);
};

/** ほかの filter の照らす値に受ける値（空でない string か、有限の number）。 */
const isFilterValue = (value: unknown): value is string | number =>
  (typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isFinite(value));
/** DEF-203: 台帳の登録の値と照らす鍵の値に受ける値（JSON の scalar。number は有限）。 */
const isLedgerKeyValue = (value: unknown): value is WorkerStartApiWriteLedgerKeyValue['value'] =>
  value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

/**
 * DEF-198（設計書 5.9 の 3）: API の更新の、ほかの filter ごとの照らす値（純粋）。API の指定のほかの filter の名前（`otherFilterNames`）ごとに、登録の成果物の
 * ページが決める鍵の同じ名前の値（JSON の文字列の形）を読み、空でない string か number の値にする。ほかの filter のない指定は空の一覧。値がない・伏せの印（null）・
 * 読めない・string と number のほか・空の文字なら null（作らない。送らずに止める）。
 */
export const apiOtherFilterValuesOf = (
  api: Pick<NonNullable<ScenarioRevision['api']>, 'otherFilterNames'>,
  createPageKeyValues: Readonly<Record<string, string | null>> | null | undefined,
): readonly WorkerStartApiWriteFilterValue[] | null => createPageKeyValuesOf(api.otherFilterNames ?? [], createPageKeyValues, isFilterValue);

/**
 * DEF-203（設計書 5.10 の 1）: API の更新の、台帳の登録の値と照らす鍵（`ledgerPageKeys`）ごとの値（純粋。ほかの filter と同じ出所と読み方）。値は JSON の型のまま
 * （string・number・boolean・null）。照らす鍵のない指定は空の一覧。値がない・伏せの印（null）・読めない・scalar でなければ null（作らない。送らずに止める）。
 */
export const apiLedgerKeyValuesOf = (
  api: Pick<NonNullable<ScenarioRevision['api']>, 'ledgerPageKeys'>,
  createPageKeyValues: Readonly<Record<string, string | null>> | null | undefined,
): readonly WorkerStartApiWriteLedgerKeyValue[] | null => createPageKeyValuesOf(api.ledgerPageKeys ?? [], createPageKeyValues, isLedgerKeyValue);

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
  apiCreateListPagePath: string | null = null,
): typeof WRITE_READ_VERIFICATION_PAGE_TARGET | null => {
  const { definition } = readCheck;
  if (readCheckTargetKindOf(definition) !== 'PAGE') {
    return null;
  }
  return transport === API_SCENARIO_TRANSPORT && isApiVerificationPagePath(definition.targetPagePath ?? '', apiCreateListPagePath)
    ? null
    : WRITE_READ_VERIFICATION_PAGE_TARGET;
};

/**
 * OP-R（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.9 の R1。T37d の判断 5 を改めた）: API の登録のシナリオの、照合の READ に使える一覧の画面の
 * path（登録の画面の 1 つ上。唯一の判定 `readListPagePathOf`）。LU-7 fix round 2: API の一覧の行の更新は、承認した `ledger.listRow.listPagePath`（下書きの確かめが
 * 候補の画面の path と同じことを確かめた）。ほか・決められないときは null（一覧の画面の定義は使わない）。LU-7 fix round 3 で、前の名前 `apiCreateReadListPagePathOf` から中身に合う名前に変えた。
 */
export const readListPagePathForWriteOf = (
  scenario: Pick<ScenarioRevision, 'kind' | 'transport'> & { readonly api?: Pick<NonNullable<ScenarioRevision['api']>, 'ledger'> },
  evidence: Pick<DiscoveryCandidate, 'page'>,
): string | null => {
  if (scenarioTransportOf(scenario) !== API_SCENARIO_TRANSPORT) {
    return null;
  }
  if (scenario.kind === CREATE_SCENARIO_KIND) {
    return readListPagePathOf(evidence.page.path);
  }
  return scenario.kind === UPDATE_SCENARIO_KIND ? scenario.api?.ledger?.listRow?.listPagePath ?? null : null;
};

/** API のシナリオの照合の READ に使える画面の path か（`{id}` の型か、OP-R: API の登録の一覧の画面）。 */
const isApiVerificationPagePath = (path: string, apiCreateListPagePath: string | null): boolean =>
  isReadCheckPageTemplatePath(path) || (apiCreateListPagePath !== null && path === apiCreateListPagePath);

/**
 * LU-8（設計書 5.5 の最後の段、4.0 の D4）: 一覧の行の更新の行の選び方の指定（作れなければ null。送らずに止める）。
 * - 許可を出す時の確かめ直し（行を選ぶ欄が、台帳の登録の今の入力の規則で毎回違う欄か）は、LU-7 fix round 2 から唯一の判定 `readVerificationUniqueRejectionOf`
 *   （`writeStartSpecOf` が先に呼ぶ）。
 * - LU-7 fix round 2: 変える鍵の新しい値（`values`）が、台帳の、対象のレコードの最後に分かっている値と同じなら作らない（一覧で変わったことを確かめられない）。
 * - 行を選ぶ値: 台帳の、対象のレコードの最後に分かっている値（`knownKeptValuesOf`。空は行を選べないので作らない）。値は IPC のメッセージにだけ入れる。
 * - 前の値を後から入れる印: 保つ鍵の名前（承認した API の指定の `keptKeys` の順）。値は持たない（ワーカーが「編集」を押した後に読む）。
 * 開き手の識別の digest と行を選ぶ欄の名前は、承認した API の指定の `ledger.listRow` のまま（ここで写し直さない）。
 */
const listRowStartOf = (
  listRow: ScenarioListRow,
  inputs: Pick<WriteStartInputs, 'ledgerWrites' | 'values'>,
  targetRecordId: string,
  keptKeyNames: readonly string[],
): WorkerStartApiWriteListRow | null => {
  const rowKeyValue = listRowKeyValueOf(listRow, inputs, targetRecordId);
  return rowKeyValue === null ? null : { rowKeyValue, deferredPriorValues: { keptKeys: [...keptKeyNames] } };
};

/**
 * LU-12b: API の形とフォームの形（形 B）の一覧の行の更新が共有する、行を選ぶ値（作れなければ null）。変える欄の新しい値が台帳の対象のレコードの最後に分かっている値と
 * 同じなら作らない（一覧で変わったことを確かめられない）。行を選ぶ値は、台帳の対象のレコードの行を選ぶ欄の最後に分かっている値（空は行を選べないので作らない）。
 */
const listRowKeyValueOf = (
  listRow: Pick<ScenarioListRow, 'rowKeyField'>,
  inputs: Pick<WriteStartInputs, 'ledgerWrites' | 'values'>,
  targetRecordId: string,
): string | null => {
  const changedKeys = Object.keys(inputs.values);
  if (knownKeptValuesOf(inputs.ledgerWrites ?? [], targetRecordId, changedKeys).some(({ key, value }) => valueOf(inputs.values, key) === value)) {
    return null;
  }
  const [known] = knownKeptValuesOf(inputs.ledgerWrites ?? [], targetRecordId, [listRow.rowKeyField]);
  return known === undefined || known.value === '' ? null : known.value;
};

/**
 * LU-12b（設計書 5.5 の最後の段）: フォームの一覧の行の更新の行の選び方の指定（作れなければ null）。一覧の画面の path と開き手の識別の digest は承認した
 * `update.listRow` のまま、行を選ぶ値は API の形と同じ部品（`listRowKeyValueOf`）。
 */
const formListRowStartOf = (
  listRow: ScenarioListRow,
  inputs: Pick<WriteStartInputs, 'ledgerWrites' | 'values'>,
  targetRecordId: string,
): WorkerStartWriteListRow | null => {
  const rowKeyValue = listRowKeyValueOf(listRow, inputs, targetRecordId);
  return rowKeyValue === null ? null : { listPagePath: listRow.listPagePath, openerIdentityDigest: listRow.openerIdentityDigest, rowKeyValue };
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
  const { resultJudgement, recordId, readVerification } = scenario.verification;
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
  // OP-R（R1）: API の登録は、登録の画面の 1 つ上の一覧の画面の定義も使う（送る値なし。読むのはワーカーが GET 1 回）。
  const target = targetIdentityDigest !== undefined
    ? { targetIdentityDigest }
    : transport === API_SCENARIO_TRANSPORT && targetPagePath !== undefined
      && isApiVerificationPagePath(targetPagePath, readListPagePathForWriteOf(scenario, evidence)) ? { targetPagePath } : null;
  if (target === null) {
    return null;
  }
  // OP-REV6 の I-1・LU-7 fix round 2: 一覧の画面は、実行のたびに違う値になる欄と比べる期待があるときだけ。一覧の行の更新は、行を選ぶ欄が台帳の登録の毎回違う欄の
  // ときだけ（照合の READ の画面によらない）。判定は許可の発行と同じ唯一の判定。
  // LU-12b: フォームの一覧の行の更新（形 B）も、行を選ぶ欄で判定する。
  const listRowOfScenario = targetRecordId === null
    ? null
    : transport === API_SCENARIO_TRANSPORT ? scenario.api?.ledger?.listRow ?? null : scenario.update?.listRow ?? null;
  if (readVerificationUniqueRejectionOf({
    expectations: readVerification.expectations,
    listPage: isListPageReadTarget(targetPagePath) && targetIdentityDigest === undefined,
    uniqueEachRunFieldNames: inputs.uniqueEachRunFieldNames ?? [],
    listRow: listRowOfScenario,
    ledgerUniqueEachRunFieldNames: inputs.ledgerUniqueEachRunFieldNames,
  }) !== null) {
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
    // LU-8（設計書 5.5 の最後の段）: 一覧の行の更新は、書き込みの画面を一覧の画面の path のまま（番号を入れない）にし、行の選び方の指定を足す。
    const listRow = targetRecordId === null ? undefined : api.ledger?.listRow;
    let formPath: string | null = evidence.page.path;
    if (targetRecordId !== null) {
      formPath = api.ledger === null ? null : listRow !== undefined ? listRow.listPagePath : concretePathOfTemplate(api.ledger.formPathTemplate, targetRecordId);
    }
    const keptKeyNames = (api.keptKeys ?? []).map(({ key }) => key);
    const listRowStart = listRow === undefined || targetRecordId === null ? null : listRowStartOf(listRow, inputs, targetRecordId, keptKeyNames);
    // DEF-198（設計書 5.9 の 3）: ほかの filter のある更新は、同じ点検の登録のページが決めた同じ名前の値を照らす値にする（取れなければ作らない。送らない）。
    const otherFilterValues = targetRecordId === null ? [] : apiOtherFilterValuesOf(api, inputs.createPageKeyValues);
    // DEF-203（設計書 5.10 の 1）: 台帳の登録の値と照らす鍵も、同じ出所の同じ名前の値にする（取れなければ作らない。送らない）。
    const ledgerKeyValues = targetRecordId === null ? [] : apiLedgerKeyValuesOf(api, inputs.createPageKeyValues);
    if (formPath === null || (listRow !== undefined && listRowStart === null) || otherFilterValues === null || ledgerKeyValues === null) {
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
      // T40a-fix: 結果は応答の状態で決める（PL-6a: 結果の判定のしかたの印は null）。ID の取り方は検証の指定のもの（API の `recordId` があれば null でもよい。
      // form の ID の型の一覧は、API のシナリオの下書きの確かめが拒むので持たない。型のために確かめ直す）。
      verification: { resultJudgement: null, recordId: isFormRecordIdSpec(recordId) ? null : recordId },
      readVerification: bound,
      approvalFacts: inputs.approvalFacts,
      // T41R2-fix-B・T41R3-fix-B（Task 41 の設計書 8 章の「T41R3」の C-3、ユーザーの判断「API の更新だけ台帳と比べる」）: 保つ鍵ごとの、台帳の値の履歴で
      // 最後に分かっている値（空を含む。値は BeakSight が作ったテストの値で `values` と同じ扱い）。ワーカーは、画面の値がこれと同じでなければ送らない。
      ...(targetRecordId === null ? {} : {
        update: {
          targetRecordId,
          knownKeptValues: knownKeptValuesOf(inputs.ledgerWrites ?? [], targetRecordId, keptKeyNames),
          ...(listRowStart === null ? {} : { listRow: listRowStart }),
          ...(otherFilterValues.length === 0 ? {} : { otherFilterValues: [...otherFilterValues] }),
          ...(ledgerKeyValues.length === 0 ? {} : { ledgerKeyValues: [...ledgerKeyValues] }),
        },
      }),
    };
  }
  // T38b: form の要求の形がないシナリオは、form の書き込みの指定を作らない。form は 3 項目がそろっている（上の判定。型のために確かめ直す）。PL-6a: form の
  // ID の取り方は ID の型の一覧だけ（前の文書の取り方は、結果の判定のしかたの印がないので上の判定で止まる）。PL-5 の 9 の (4)（設計書 8.1）: 決められなかった
  // ID の取り方（null）は、そのまま null で載せる（ワーカーは ID を取らず、結果は ID なしの `PARTIAL`）。
  const { request } = scenario;
  if (request === null || resultJudgement === null || (recordId !== null && !isFormRecordIdSpec(recordId))) {
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
    verification: { resultJudgement, recordId },
    readVerification: bound,
    approvalFacts: inputs.approvalFacts,
  };
  if (scenario.update === null || targetRecordId === null) {
    return { ...common, request, formPage: { origin: evidence.page.origin, path: evidence.page.path } };
  }
  // T31f: UPDATE は、型に対象の ID を入れた具体的な path（CCX-28: 型の owner の `concretePathOfTemplate`）と、UPDATE の指定（値を持たない）。
  const { update } = scenario;
  // LU-12b（設計書 5.5）: フォームの一覧の行の更新（形 B）は、書き込みの画面を一覧の画面の path のまま（番号を入れない）にし、送信先だけに台帳の番号を入れる。
  // 行の選び方と、保つ欄ごとの台帳の最後の値（API の形の `knownKeptValues` と同じ考え方。ワーカーは、押した後に読んだ前の値がこれと同じときだけ送る）を足す。
  const { listRow } = update;
  const actionPath = concretePathOfTemplate(update.actionPathTemplate, targetRecordId);
  const formPath = listRow === undefined ? concretePathOfTemplate(update.formPathTemplate, targetRecordId) : listRow.listPagePath;
  const listRowStart = listRow === undefined ? null : formListRowStartOf(listRow, inputs, targetRecordId);
  if (actionPath === null || formPath === null || (listRow !== undefined && (listRowStart === null || update.formPathTemplate !== listRow.listPagePath))) {
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
      ...(listRowStart === null ? {} : {
        knownKeptValues: knownKeptValuesOf(inputs.ledgerWrites ?? [], targetRecordId, update.keepFieldNames),
        listRow: listRowStart,
      }),
    },
  };
};

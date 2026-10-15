// READ の確かめの契約の SSOT（Task 27 の設計書 4.5、変更履歴「Blocker: T27c」の行の (3)。T27c）。
// - 期待の種類と結果の閉じた一覧、1 回のジョブの READ の上限、定義の数の上限、値の長さの上限を、ここで 1 回だけ定義する。管理データ
//   （`src/control/`。定義と結果の表、定義の検証）と、READ の実行（T27e。ワーカー）が、ここを参照する。
// - 定義の JSON Schema（`schemas/control/read-check-definition.schema.json`）の期待の種類と上限は、ここの一覧と定数と一致する
//   （`tests/unit/read-check-contracts.test.ts`）。
// - 送る値は、テスト環境のテスト用の値だけ（設計書 4.5。管理データに平文で保存する。秘密に見える名前の欄は、保存のときに拒む）。
// - 送れる欄の判定（`isSendableField`、`isSendableReadCheckParameter`、`unsendableReadCheckParameterNames`）の唯一の owner（CCX-10）。定義の
//   保存の確かめ（`src/control/read-check-policy.ts`）と、ワーカーの実行の前の確かめ直し（`src/worker/read-check-run.ts`。保存の後に欄が
//   見えない・readonly・disabled に変わったら読まない）が、ここを使う（書き写さない。`tests/architecture/read-check-ssot.test.ts`）。
// - T31e fix round 1（Task 31 の設計書 3 章の「削除にあたる変更の遮断」）: 状態の語に当たり、秘密に見える名前でもある、値を送る欄の判定
//   （`isSecretLikeStateField`）の唯一の owner。UPDATE の下書きの確かめ（`src/control/approval/scenario-policy.ts`）と、UPDATE の欄の役割
//   （`src/browser/write-form-submitter.ts` の `updateRolesOf`）が使う（書き写さない）。
// - T31R2-fix-1（DEF-108 の残り）: 書き込みの照合で名前だけを照らす（値を読まない）欄の名前の判定（`isPageIssuedTokenFieldName`。語の一覧は
//   秘密に見える名前の方針の owner `src/core/secret-query-names.ts` の `PAGE_ISSUED_TOKEN_FIELD_WORDS`）と、値を読めず照らせない秘密に見える
//   名前の欄の判定（`isUnreadableSecretField`）の唯一の owner。書き込みの照合の期待の作り手（`src/browser/write-form-submitter.ts`）と、シナリオの
//   下書きの確かめが使う（書き写さない）。
// - 純粋な定義と関数だけのファイル（実行時の import は、候補の契約の純粋な判定 `isUnsendableFieldType`、状態の語の判定 `fieldNameHasStateWord`、
//   欄の名前の語の判定 `fieldNameHasListedWord`、秘密に見える名前の方針の owner の判定 `isSecretUrlQueryParameterName` と一覧
//   `PAGE_ISSUED_TOKEN_FIELD_WORDS` だけ。DEF-094。候補の欄の形は型だけ）。Playwright、ブラウザ、`node:fs`、`src/control/`、
//   監査エンジンを import しない（`src/control/` とワーカーから import できるようにするため。`tests/architecture/discovery-boundary.test.ts`）。
import { isSecretUrlQueryParameterName, PAGE_ISSUED_TOKEN_FIELD_WORDS } from '../core/secret-query-names.js';
import { isUnsendableFieldType, writeFieldsOfName, type CandidateField, type DiscoveryCandidate } from './candidate-contracts.js';
import { fieldNameHasListedWord, fieldNameHasStateWord } from './classify.js';

/**
 * 期待の種類（設計書 4.5。閉じた一覧）。
 * - `ROW_COUNT_EQUALS`・`ROW_COUNT_AT_LEAST`: 構造にした結果の行の数が、ちょうど・少なくとも `count`。
 * - `TEXT_CONTAINS`: ページの本文が `text` を含む。
 * - `DETAIL_FIELD_EQUALS`: 詳細（`dl` など）の項目 `field` の値が `value`。
 */
export const READ_CHECK_EXPECTATION_KINDS = Object.freeze([
  'ROW_COUNT_EQUALS',
  'ROW_COUNT_AT_LEAST',
  'TEXT_CONTAINS',
  'DETAIL_FIELD_EQUALS',
] as const);
export type ReadCheckExpectationKind = (typeof READ_CHECK_EXPECTATION_KINDS)[number];

/**
 * READ の確かめの結果（設計書 4.5。閉じた一覧。管理データの `read_check_results.result`）。
 * - `MATCHED`・`NOT_MATCHED`: 期待と照らした（一致した・しなかった）。
 * - `UNDETERMINED`: 構造が取れないなどで、判定できない。
 * - `READ_BLOCKED_BY_POLICY`: 要求の判定（読まないパス、危険な語、許可 Origin）で止まり、読まなかった。
 * - `READ_CANDIDATE_DRIFTED`: 候補の今の識別の digest が定義のものと違う（画面が変わった）ので、読まなかった。
 * - `READ_CANDIDATE_NOT_READ`: 候補の今の分類が `READ` でない（JS の結び付きなど。設計書の変更履歴「T27a の報告」の行の (6)）ので、読まなかった。
 */
export const READ_CHECK_RESULTS = Object.freeze([
  'MATCHED',
  'NOT_MATCHED',
  'UNDETERMINED',
  'READ_BLOCKED_BY_POLICY',
  'READ_CANDIDATE_DRIFTED',
  'READ_CANDIDATE_NOT_READ',
] as const);
export type ReadCheckResult = (typeof READ_CHECK_RESULTS)[number];

/** 1 回のジョブ（`READ_CHECK`）で読む READ の数の上限（設計書 4.5、10 章の 2。ユーザー承認の値）。 */
export const MAX_READ_CHECKS_PER_JOB = 20;

/** 1 つのプロファイルの、取り消していない定義の数の上限（1 回のジョブで、すべての定義を読めるように、1 回のジョブの上限と同じ定数）。 */
export const MAX_READ_CHECK_DEFINITIONS_PER_PROFILE = MAX_READ_CHECKS_PER_JOB;

/** 1 つの定義の、送る値の数の上限（1 つの候補の欄の数の上限 `MAX_CANDIDATE_FIELDS` より大きくしない。テストで確かめる）。 */
export const MAX_READ_CHECK_PARAMETERS = 50;

/** 送る値 1 つの最大長（UTF-16 のコード単位）。 */
export const MAX_READ_CHECK_PARAMETER_VALUE_LENGTH = 256;

/** 1 つの定義の、期待の数の上限（1 つ以上）。 */
export const MAX_READ_CHECK_EXPECTATIONS = 10;

/** 期待の行の数の上限（`ROW_COUNT_*` の `count`。0 以上）。 */
export const MAX_READ_CHECK_ROW_COUNT = 100_000;

/** 期待の文（`TEXT_CONTAINS` の `text`、`DETAIL_FIELD_EQUALS` の `value`）の最大長（UTF-16 のコード単位。1 文字以上）。 */
export const MAX_READ_CHECK_EXPECTED_TEXT_LENGTH = 256;

/** 詳細の項目の名前（`DETAIL_FIELD_EQUALS` の `field`）の最大長（UTF-16 のコード単位。1 文字以上）。 */
export const MAX_READ_CHECK_DETAIL_FIELD_LENGTH = 256;

/** 送る値（欄の名前 → 値。テスト環境のテスト用の値だけ）。 */
export type ReadCheckParameters = Readonly<Record<string, string>>;

/** 期待 1 件（`kind` で分かれる閉じた形）。 */
export type ReadCheckExpectation =
  | { readonly kind: 'ROW_COUNT_EQUALS'; readonly count: number }
  | { readonly kind: 'ROW_COUNT_AT_LEAST'; readonly count: number }
  | { readonly kind: 'TEXT_CONTAINS'; readonly text: string }
  | { readonly kind: 'DETAIL_FIELD_EQUALS'; readonly field: string; readonly value: string };

/** READ の確かめの定義の中身（人が画面で決める。`schemas/control/read-check-definition.schema.json` の形）。 */
export interface ReadCheckDefinition {
  /** 対象の READ の候補の識別の digest（`computeCandidateDigests` の `identityDigest`）。 */
  readonly targetIdentityDigest: string;
  readonly parameters: ReadCheckParameters;
  /** 期待（1 件以上、`MAX_READ_CHECK_EXPECTATIONS` 件まで）。 */
  readonly expectations: readonly ReadCheckExpectation[];
}

/**
 * 値を送ってよい欄か（名前があり、見えていて、readonly でも disabled でもなく、値を送れない型（`password`・`file`。owner は
 * `candidate-contracts.ts` の `isUnsendableFieldType`。DEF-094、T28e fix round 1）でもない）。
 */
export const isSendableField = (field: CandidateField): boolean =>
  field.name.length > 0 && !field.hidden && !field.readonly && !field.disabled && !isUnsendableFieldType(field.type);

/**
 * 候補に、その名前の欄があり、そのすべてが送れる欄か（同じ名前の欄がいくつかある（radio など）ときは、そのすべてが送れる欄であること。
 * fail-closed）。
 */
export const isSendableReadCheckParameter = (candidate: Pick<DiscoveryCandidate, 'fields'>, name: string): boolean => {
  const fields = candidate.fields.filter((field) => field.name === name);
  return fields.length > 0 && fields.every(isSendableField);
};

/**
 * 書き込みで、その名前の値を送れるか（T31b fix round 1。Task 31 の設計書 3 章の「同じ名前の hidden と checkbox の組（Rails 型）」）: 値を送る欄
 * （`candidate-contracts.ts` の `writeFieldsOfName`。同じ名前の hidden と checkbox の組の名前は組の checkbox だけ、ほかは同じ名前の欄のすべて）が
 * あり、すべて送れる欄（`isSendableField`）。`_method` は確かめない（呼び出し側が確かめる）。シナリオの下書きの確かめ
 * （`src/control/approval/scenario-policy.ts`）と、入力の規則の欄の判定（`src/control/data-rules/field-evaluation.ts`）が使う。READ の送る値の判定
 * （`isSendableReadCheckParameter`）は、組を受けない今のまま。
 */
export const isSendableWriteFieldName = (candidate: Pick<DiscoveryCandidate, 'fields'>, name: string): boolean => {
  const fields = writeFieldsOfName(candidate.fields, name);
  return fields.length > 0 && fields.every(isSendableField);
};

/**
 * 書き込みの照合で、名前だけを照らす（値を読まない）欄の名前か（T31R2-fix-1。DEF-108 の残り）: ページが読み込みごとに作る値の名前の語
 * （owner `src/core/secret-query-names.ts` の `PAGE_ISSUED_TOKEN_FIELD_WORDS`）に、語の単位で当たる（`classify.ts` の `fieldNameHasListedWord`）。
 * ほかの秘密に見える名前（`code`・`key`・`ticket` など）は当たらない（値を読めず照らせないので、その hidden・readonly・見えない欄がある画面の
 * 書き込みは止める。`isUnreadableSecretField`）。
 */
export const isPageIssuedTokenFieldName = (name: string): boolean =>
  name.length > 0 && fieldNameHasListedWord(name, PAGE_ISSUED_TOKEN_FIELD_WORDS);

/** hidden の型（T31e fix round 1。`isSecretLikeStateField`）。 */
const HIDDEN_FIELD_TYPE: CandidateField['type'] = 'hidden';
/** file の型（T31R2-fix-1。`isUnreadableSecretField`。file の欄は空のときだけ送ってよいので、値を照らす対象でない）。 */
const FILE_FIELD_TYPE: CandidateField['type'] = 'file';

/**
 * 値を読めず照らせない、秘密に見える名前の欄か（T31R2-fix-1。DEF-108 の残り。書き込みの照合の期待の作り手の `SECRET_LIKE_PASSTHROUGH_FIELD` と、
 * シナリオの下書きの確かめが使う唯一の判定）: 名前があり、disabled・file でなく（disabled の欄は送らない。file の欄は空のときだけ送る）、
 * hidden の型・見えない欄・readonly のどれかで、ページが読み込みごとに作る値の名前（`isPageIssuedTokenFieldName`）でなく、秘密に見える名前
 * （`isSecretUrlQueryParameterName`）。
 */
export const isUnreadableSecretField = (field: Pick<CandidateField, 'name' | 'type' | 'hidden' | 'readonly' | 'disabled'>): boolean =>
  field.name.length > 0 && !field.disabled && field.type !== FILE_FIELD_TYPE
  && (field.type === HIDDEN_FIELD_TYPE || field.hidden || field.readonly)
  && !isPageIssuedTokenFieldName(field.name) && isSecretUrlQueryParameterName(field.name);

/**
 * 状態の語に当たり、秘密に見える名前でもある、値を送る欄か（T31e fix round 1。Task 31 の設計書 3 章の「削除にあたる変更の遮断」）: 名前があり、
 * disabled でなく（disabled の欄は値を送らない）、hidden の型・見えない欄・readonly のどれかで、名前が状態の語（`classify.ts` の
 * `fieldNameHasStateWord`）と秘密に見える名前（`isSecretUrlQueryParameterName`）の両方に当たる。秘密に見える名前の値は読まないので、更新の前と後で
 * 値を照らせず、名前だけを照らすとページの JS が値を変えても止まらない。そうした欄がある画面の UPDATE は受けない。
 */
export const isSecretLikeStateField = (field: Pick<CandidateField, 'name' | 'type' | 'hidden' | 'readonly' | 'disabled'>): boolean =>
  field.name.length > 0 && !field.disabled && (field.type === HIDDEN_FIELD_TYPE || field.hidden || field.readonly)
  && fieldNameHasStateWord(field.name) && isSecretUrlQueryParameterName(field.name);

/** 送る値のうち、候補の送れる欄でない名前（定義の順）。空なら、すべて送れる。 */
export const unsendableReadCheckParameterNames = (
  candidate: Pick<DiscoveryCandidate, 'fields'>,
  parameters: ReadCheckParameters,
): readonly string[] => Object.freeze(Object.keys(parameters).filter((name) => !isSendableReadCheckParameter(candidate, name)));

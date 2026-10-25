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
// - T37d（Task 37 の設計書 3.5）: 定義の対象は、READ の候補の識別の digest（`targetIdentityDigest`）か、画面の path（`targetPagePath`）のどちらか
//   1 つ（`READ_CHECK_TARGET_KINDS`、`readCheckTargetKindOf`）。画面の path の定義は送る値を持たない。画面の path の読む URL の組み立て
//   （`readCheckPageUrlOf`。正規の形の path だけ）の唯一の owner。
// - 純粋な定義と関数だけのファイル（実行時の import は、候補の契約の純粋な判定 `isUnsendableFieldType`、状態の語の判定 `fieldNameHasStateWord`、
//   欄の名前の語の判定 `fieldNameHasListedWord`、秘密に見える名前の方針の owner の判定 `isSecretUrlQueryParameterName` と一覧
//   `PAGE_ISSUED_TOKEN_FIELD_WORDS` だけ。DEF-094。候補の欄の形は型だけ）。Playwright、ブラウザ、`node:fs`、`src/control/`、
//   監査エンジンを import しない（`src/control/` とワーカーから import できるようにするため。`tests/architecture/discovery-boundary.test.ts`）。
import { isSecretUrlQueryParameterName, PAGE_ISSUED_TOKEN_FIELD_WORDS } from '../core/secret-query-names.js';
// PRE42-CC 組 UI-K2（CC-113）: 期待の種類の一覧の定義（画面のブラウザ側も読む、import を持たない純粋な core のファイル）。ここは公開し直す。
import {
  DETAIL_FIELD_EQUALS_EXPECTATION_KIND,
  READ_CHECK_EXPECTATION_KINDS,
  ROW_COUNT_AT_LEAST_EXPECTATION_KIND,
  ROW_COUNT_EQUALS_EXPECTATION_KIND,
  ROW_COUNT_EXPECTATION_KINDS,
  TEXT_CONTAINS_EXPECTATION_KIND,
  type ReadCheckExpectationKind,
} from '../core/read-check-expectation-kinds.js';
import { isUnsendableFieldType, writeFieldsOfName, type CandidateField, type DiscoveryCandidate } from './candidate-contracts.js';
import { fieldNameHasListedWord, fieldNameHasStateWord } from './classify.js';
import { PATH_TEMPLATE_ID_SEGMENT } from './fingerprint.js';

/**
 * 期待の種類（設計書 4.5。閉じた一覧）。定義と値の意味は `src/core/read-check-expectation-kinds.ts`（PRE42-CC 組 UI-K2）。ここは同じ名前で公開し直す
 * （行の数を照らす種類 `ROW_COUNT_EXPECTATION_KINDS` と、名前つきの定数も）。
 */
export {
  DETAIL_FIELD_EQUALS_EXPECTATION_KIND,
  READ_CHECK_EXPECTATION_KINDS,
  ROW_COUNT_AT_LEAST_EXPECTATION_KIND,
  ROW_COUNT_EQUALS_EXPECTATION_KIND,
  ROW_COUNT_EXPECTATION_KINDS,
  TEXT_CONTAINS_EXPECTATION_KIND,
  type ReadCheckExpectationKind,
};

/**
 * T40R-fix-B（Task 40 の設計書 7 章の「T40R」の行の I-2 (a)）: 書き込みの照合の READ で、生成した値と比べる期待の種類（本文の文字、詳細の項目の値）。
 * 行の数の期待は、取り違えた ID の画面でも一致しうるので、ここに入れない。
 */
export const GENERATED_VALUE_EXPECTATION_KINDS = Object.freeze(['TEXT_CONTAINS', 'DETAIL_FIELD_EQUALS'] as const satisfies readonly ReadCheckExpectationKind[]);

/**
 * 期待の一覧に、生成した値と比べる期待が 1 つ以上あるか（T40R-fix-B。API の `{id}` の照合の READ の保存の確かめ（`scenario-policy.ts`）と、IPC の手書きの
 * 確かめ（`worker-protocol.ts`）が使う唯一の判定。シナリオの検証の指定の期待と、結び付けた後の READ の期待の、どちらの形も種類で見る）。
 * T40R2-fix（Task 40 の設計書 7 章の「T40R2」の行の M-1）: 比べる値が実行のたびに変わるかの述語（`varies`）を渡せば、その述語に当たる期待だけを数える
 * （許可の発行は、比べる欄の入力の規則が変わる欄か。IPC は、比べる値が生成した値のどれか）。省けば種類だけで見る（保存の時。規則がまだない）。
 */
export function hasGeneratedValueExpectation<T extends { readonly kind: string }>(expectations: readonly T[], varies?: (expectation: T) => boolean): boolean {
  return expectations.some((expectation) => (GENERATED_VALUE_EXPECTATION_KINDS as readonly string[]).includes(expectation.kind)
    && (varies === undefined || varies(expectation)));
}

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

/**
 * 定義の対象の種類（T37d。Task 37 の設計書 3.5。閉じた一覧）。
 * - `CANDIDATE`: READ の候補（識別の digest `targetIdentityDigest`）。候補の送信先に送る値を付けて読む。
 * - `PAGE`: 画面の path（`targetPagePath`）。プロファイルの開始の URL と同じ Origin のその画面を、送る値なしで 1 回読む（データを後から API で描く画面）。
 */
export const READ_CHECK_TARGET_KINDS = Object.freeze(['CANDIDATE', 'PAGE'] as const);
export type ReadCheckTargetKind = (typeof READ_CHECK_TARGET_KINDS)[number];

/** 画面の path（`targetPagePath`）の最大長（UTF-16 のコード単位。`/` を含む。T37d）。 */
export const MAX_READ_CHECK_PAGE_PATH_LENGTH = 1_024;

/** 送る値（欄の名前 → 値。テスト環境のテスト用の値だけ）。 */
export type ReadCheckParameters = Readonly<Record<string, string>>;

/** 期待 1 件（`kind` で分かれる閉じた形）。 */
export type ReadCheckExpectation =
  | { readonly kind: 'ROW_COUNT_EQUALS'; readonly count: number }
  | { readonly kind: 'ROW_COUNT_AT_LEAST'; readonly count: number }
  | { readonly kind: 'TEXT_CONTAINS'; readonly text: string }
  | { readonly kind: 'DETAIL_FIELD_EQUALS'; readonly field: string; readonly value: string };

/** READ の候補を対象にした定義（今の形）。 */
export interface ReadCheckCandidateDefinition {
  /** 対象の READ の候補の識別の digest（`computeCandidateDigests` の `identityDigest`）。 */
  readonly targetIdentityDigest: string;
  readonly targetPagePath?: never;
  readonly parameters: ReadCheckParameters;
  /** 期待（1 件以上、`MAX_READ_CHECK_EXPECTATIONS` 件まで）。 */
  readonly expectations: readonly ReadCheckExpectation[];
}

/** 画面の path を対象にした定義（T37d）。送る値を持たない（空だけ）。 */
export interface ReadCheckPageDefinition {
  readonly targetIdentityDigest?: never;
  /** 対象の画面の path（`/` で始まる正規の形。query と fragment を持たない。`readCheckPageUrlOf` が受ける形）。 */
  readonly targetPagePath: string;
  readonly parameters: Readonly<Record<string, never>>;
  readonly expectations: readonly ReadCheckExpectation[];
}

/**
 * READ の確かめの定義の中身（人が画面で決める。`schemas/control/read-check-definition.schema.json` の形）。T37d: 対象は、READ の候補か画面の path の
 * どちらか 1 つ（`readCheckTargetKindOf`）。
 */
export type ReadCheckDefinition = ReadCheckCandidateDefinition | ReadCheckPageDefinition;

/** 定義の対象の種類（T37d。`targetPagePath` を持てば `PAGE`、ほかは `CANDIDATE`）。 */
export const readCheckTargetKindOf = (definition: ReadCheckDefinition): ReadCheckTargetKind =>
  (typeof definition.targetPagePath === 'string' ? 'PAGE' : 'CANDIDATE');

/** http(s) の scheme（`URL.protocol` の値）。 */
const PAGE_URL_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * 画面の path の定義の、読む URL（T37d。純粋。保存の確かめ `src/control/read-check-policy.ts` と、ワーカーの実行 `src/worker/read-check-run.ts` が
 * 使う唯一の組み立て）。`origin` は http(s) の Origin の正規の直列化だけ、`path` は `/` で始まり（`//` で始まらない）、長さが
 * `MAX_READ_CHECK_PAGE_PATH_LENGTH` 以下で、URL の解析で形が変わらない（正規の形）ものだけ受ける。組み立てた URL の Origin が `origin` で、path が
 * `path` のまま、query と fragment がないこと。どれかに外れたら null（fail-closed。`..` の区切り、URL の解析が取り除く・符号化する文字（タブ、
 * 空白、日本語の文字など）、`\`（区切りとして読まれる）、`?`、`#` を含む path は受けない）。
 */
export const readCheckPageUrlOf = (origin: string, path: string): string | null => {
  if (path.length === 0 || path.length > MAX_READ_CHECK_PAGE_PATH_LENGTH || !path.startsWith('/') || path.startsWith('//')
    || path.includes('\\') || path.includes('?') || path.includes('#')) {
    return null;
  }
  // 組み立てる URL は、Origin と path をつないだ文字列そのもの。URL の解析で形が変わらない（Origin が正規の直列化で path を持たず、path が正規の形）
  // ときだけ受ける（受け入れの判定ではない。読み込む前に、ワーカーが要求の判定の owner で確かめる）。
  const expected = `${origin}${path}`;
  let base: URL;
  let url: URL;
  try {
    base = new URL(origin);
    url = new URL(expected);
  } catch {
    return null;
  }
  if (!PAGE_URL_PROTOCOLS.has(base.protocol) || base.href !== `${origin}/` || origin.includes('@') || url.href !== expected) {
    return null;
  }
  return expected;
};

// ---------------------------------------------------------------------------------------------------------------
// T38c（Task 38 の設計書 3.4、7 章の履歴のユーザーの判断 (3)、T38c の Blocker の判断（案 A））: `{id}` つきの画面の path の型
// ---------------------------------------------------------------------------------------------------------------
// API のシナリオの照合の READ に使う、画面の path の定義の型。path の区切りのちょうど 1 つの全体が `{id}`（`PATH_TEMPLATE_ID_SEGMENT`。型の owner
// `fingerprint.ts` と同じ印）で、ほかに `{`・`}` を持たない。読む URL は、`{id}` に台帳の ID（安全な形だけ。判定は呼び出し側の唯一の判定
// `isUsableRecordId` を受ける）を入れて、`readCheckPageUrlOf` で組み立てる。保存の確かめは、代わりの値（`READ_CHECK_PAGE_TEMPLATE_SAMPLE_ID`）を
// 入れた path で、今の画面の READ の確かめを通す。READ の確かめのジョブが型の定義を単独で読むことはない（`readCheckPageUrlOf` が型を組み立てないので、
// ワーカーは読まずに `URL_NOT_BUILT`。fail-closed）。実際の照合（ID を入れて読む）は Task 40。

/** path の区切り。 */
const PAGE_PATH_SEPARATOR = '/';

/** 保存の確かめで `{id}` に入れる代わりの値（台帳の ID の安全な形の 1 つ。英数字だけ）。 */
export const READ_CHECK_PAGE_TEMPLATE_SAMPLE_ID = '1';

/**
 * 画面の path の型か（区切りのちょうど 1 つの全体が `{id}` で、ほかの所に `{`・`}` がない）。T38R-fix の M-1: `{id}` の前に、固定の区切り（空でない区切り）を
 * 1 つ以上求める（`/{id}` のように、ID だけで画面が決まる型を受けない）。
 */
export const isReadCheckPageTemplatePath = (path: string): boolean => {
  const segments = path.split(PAGE_PATH_SEPARATOR);
  const idSegments = segments.filter((segment) => segment === PATH_TEMPLATE_ID_SEGMENT).length;
  const idIndex = segments.indexOf(PATH_TEMPLATE_ID_SEGMENT);
  return path.startsWith(PAGE_PATH_SEPARATOR) && idSegments === 1
    && segments.slice(0, idIndex).some((segment) => segment.length > 0)
    && segments.every((segment) => segment === PATH_TEMPLATE_ID_SEGMENT || (!segment.includes('{') && !segment.includes('}')));
};

/** 型の `{id}` の区切りに値を入れた path（型でなければ null）。 */
export const readCheckPagePathOfTemplate = (template: string, recordId: string): string | null =>
  (isReadCheckPageTemplatePath(template)
    ? template.split(PAGE_PATH_SEPARATOR).map((segment) => (segment === PATH_TEMPLATE_ID_SEGMENT ? recordId : segment)).join(PAGE_PATH_SEPARATOR)
    : null);

/**
 * 型の画面の path の定義の、読む URL（純粋）。`recordId` は台帳の ID で、`isRecordIdValue`（呼び出し側の唯一の判定。`isUsableRecordId`）が受ける値だけ
 * 入れる。型でない path、受けない ID、入れた path が正規の形でない（`readCheckPageUrlOf` が組み立てない）なら null。
 */
export const readCheckPageTemplateUrlOf = (
  origin: string,
  template: string,
  recordId: string,
  isRecordIdValue: (value: string) => boolean,
): string | null => {
  if (!isRecordIdValue(recordId)) {
    return null;
  }
  const path = readCheckPagePathOfTemplate(template, recordId);
  return path === null ? null : readCheckPageUrlOf(origin, path);
};

/**
 * 保存の確かめが見る形の path（T38c）: 型なら、代わりの値を入れた path。`{`・`}` を持つが型でない path は null（正規の形でない）。ほかはそのまま。
 */
export const checkedReadCheckPagePathOf = (path: string): string | null => {
  if (isReadCheckPageTemplatePath(path)) {
    return readCheckPagePathOfTemplate(path, READ_CHECK_PAGE_TEMPLATE_SAMPLE_ID);
  }
  return path.includes('{') || path.includes('}') ? null : path;
};

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

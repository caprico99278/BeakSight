// READ の確かめの定義の検証の唯一の owner（Task 27 の設計書 4.5、変更履歴「Blocker: T27c」の行の (1)(4)。T27c）。純粋な関数。
// - 定義の形（期待の閉じた一覧、値の長さと件数の上限）は、JSON Schema（`read-check-definition`）で確かめる。形が違えば、候補の確かめをしない。
// - 送る値は、対象の候補の、名前があり、見えていて、readonly でも disabled でもない欄だけ（`READ_PARAMETER_NOT_ALLOWED`）。同じ名前の欄が
//   いくつかある（radio など）ときは、その名前のすべての欄が送れる欄であること（fail-closed）。判定は、純粋な契約の
//   `isSendableReadCheckParameter`（`src/discovery/read-check-contracts.ts`。ワーカーの実行の前の確かめ直しと同じ判定。CCX-10）に任せる。
// - 秘密に見える名前（URL の伏せ字の一覧と同じ判定 `isSecretUrlQueryParameterName`。owner は `src/core/secret-query-names.ts`）の欄に値を送る
//   定義は、欄があってもなくても拒む（`READ_PARAMETER_SECRET_LIKE`。黙って落とさない）。
// - 送る値の名前か値が、発見の分類の危険な語（日本語を含む。判定の owner は `src/discovery/classify.ts` の `readParametersHaveDestructiveWord`。
//   ワーカーの実行の前の確かめと同じ判定）に当たる定義は拒む（`READ_PARAMETER_DANGEROUS_WORD`。T27R-fix-1。DEF-088 の (b)）。
// - 対象の候補は引数で受ける（`DiscoveryCandidate`。保存の口が成果物 `discovery.json` から読んで渡す。T27f）。渡されない、識別の digest が
//   違う → `READ_CANDIDATE_UNKNOWN`。今の分類が `READ` でない → `READ_CANDIDATE_NOT_READ`。
// - 誤りの詳しい文には、欄の名前と項目の位置だけを書き、送る値を書かない。
// - 保存の部品（`src/control/job/read-check-store.ts`）は、書く前に `assertStorableReadCheckDefinition` で形と秘密に見える名前を確かめ直す
//   （候補の確かめは、候補を持つ呼び出し側がこの関数で行う）。同じ関数は保存した行を読むときにも使うので、危険な語は確かめ直さない（T27R-fix-1
//   の前に保存した定義を読めなくしないため。そうした定義は、ワーカーの実行の前の確かめで止まる）。
// - T37d（Task 37 の設計書 3.5）: 画面の path の定義（`targetPagePath`）は、候補を見ずに、画面の文脈（`ReadCheckPageContext`。開始の URL、許可 Origin、
//   認証の設定の読まないパス・読む範囲・セッションの切れの path）に照らす。path の形は契約の `readCheckPageUrlOf`、読まないパスと危険な語の比べ方は
//   Guard と同じ core の部品（`src/core/audit-exclusion-match.ts`。control は safety を読めない）。ワーカーは実行の前に、Guard の判定で確かめ直す。
// - T38c（Task 38 の設計書 3.4、T38c の Blocker の判断（案 A））: `{id}` つきの画面の path の型（契約の `isReadCheckPageTemplatePath`。API のシナリオの
//   照合の READ に使う）は、代わりの値を入れた path（`checkedReadCheckPagePathOf`）で、上と同じ確かめを通す。
// - T40b-2（Task 40 の設計書 7 章の「T40b-2 の設計」）: 画面の path の確かめ（正規の形、開始の URL、Origin、読まないパス・読む範囲・ログインの画面、危険な語）の
//   判定は、ワーカーの照合の READ の確かめ直しと共有する唯一の owner `read-check-page-path.ts` の `readCheckPagePathRejectionsOf` に移した。ここは理由を
//   誤りの文に写すだけ（理由の値と順は変えない）。
import { deepFreeze } from '../core/immutable.js';
import { isSecretUrlQueryParameterName } from '../core/secret-query-names.js';
import { READ_CANDIDATE_CLASSIFICATION, type DiscoveryCandidate } from '../discovery/candidate-contracts.js';
import { readParametersHaveDestructiveWord } from '../discovery/classify.js';
import {
  checkedReadCheckPagePathOf,
  isSendableReadCheckParameter,
  readCheckPageUrlOf,
  readCheckTargetKindOf,
  type ReadCheckCandidateDefinition,
  type ReadCheckDefinition,
  type ReadCheckPageDefinition,
} from '../discovery/read-check-contracts.js';
import {
  READ_CHECK_PAGE_PATH_FORM_ORIGIN,
  READ_CHECK_PAGE_PATH_REJECTION_REASONS,
  readCheckPagePathRejectionsOf,
  type ReadCheckPageContext,
  type ReadCheckPagePathRejection,
} from './read-check-page-path.js';
import { schemaCheckedCopyOf } from './schema-checked-copy.js';

export type { ReadCheckPageContext } from './read-check-page-path.js';

/**
 * READ の確かめの定義の保存を拒む理由（閉じた一覧）。
 * - `READ_CHECK_INPUT_INVALID`: 定義の形が契約と違う（期待の種類、値の長さと件数の上限を含む）。
 * - `READ_PARAMETER_SECRET_LIKE`: 秘密に見える名前の欄に値を送る。
 * - `READ_PARAMETER_NOT_ALLOWED`: 候補の欄でない、名前がない、hidden（見えない）、readonly、disabled の欄に値を送る。
 * - `READ_CANDIDATE_UNKNOWN`: 対象の候補が分からない（渡されない、識別の digest が違う）。
 * - `READ_CANDIDATE_NOT_READ`: 対象の候補の今の分類が `READ` でない。
 * - `READ_CHECK_LIMIT_EXCEEDED`: プロファイルの、取り消していない定義の数が上限（`MAX_READ_CHECK_DEFINITIONS_PER_PROFILE`）に達している。
 * - `READ_CHECK_PROFILE_NOT_FOUND`: プロファイルがない。
 * - `READ_CHECK_NOT_FOUND`: 変える・取り消す定義がない。
 * - `READ_CHECK_REVISION_CONFLICT`: 画面が読んだ版と、保存されている版が違う。
 * - `READ_CHECK_CANCELED`: 取り消した定義は変えない・取り消し直さない。
 * - `READ_CHECK_PROFILE_RETIRED`（T27f。T27c の申し送り 6）: 取り消したプロファイルでは、定義を作らない・変えない（取り消しはできる）。
 * - `READ_PARAMETER_DANGEROUS_WORD`（T27R-fix-1。DEF-088）: 送る値の名前か値が、発見の分類の危険な語（日本語を含む）に当たる。
 * - `READ_CHECK_PROFILE_NOT_ELIGIBLE`（T28b fix round 1）: プロファイルのモードと認証の方式で、READ の確かめを許さない（`execution-policy.ts` の
 *   `READ_CHECK` の行にない。例: 公開の監査）。定義を作らない・変えない（取り消しはできる）。
 * T37d（Task 37 の設計書 3.5）: 画面の path の定義の理由。
 * - `READ_PAGE_PATH_INVALID`: path が正規の形でない（`readCheckPageUrlOf` が組み立てない。`..` の区切り、URL の解析が変える文字、解けない `%`）。
 * - `READ_PAGE_START_URL_UNKNOWN`: プロファイルの開始の URL（ターゲット設定の `site.startUrl`）を読めない。
 * - `READ_PAGE_ORIGIN_NOT_ALLOWED`: 開始の URL の Origin が、ターゲット設定の許可 Origin か、プロファイルの承認したテストの Origin の外。
 * - `READ_PAGE_PATH_EXCLUDED`: 読まないパス、読む範囲の外、ログインの画面（セッションの切れの path）に当たる。
 * - `READ_PAGE_PATH_DANGEROUS_WORD`: path が既定の危険な語（`DEFAULT_EXCLUDED_URL_WORDS`）に当たる。
 */
export const READ_CHECK_DEFINITION_REJECTION_REASONS = Object.freeze([
  'READ_CHECK_INPUT_INVALID',
  'READ_PARAMETER_SECRET_LIKE',
  'READ_PARAMETER_NOT_ALLOWED',
  'READ_CANDIDATE_UNKNOWN',
  'READ_CANDIDATE_NOT_READ',
  'READ_CHECK_LIMIT_EXCEEDED',
  'READ_CHECK_PROFILE_NOT_FOUND',
  'READ_CHECK_NOT_FOUND',
  'READ_CHECK_REVISION_CONFLICT',
  'READ_CHECK_CANCELED',
  'READ_CHECK_PROFILE_RETIRED',
  'READ_PARAMETER_DANGEROUS_WORD',
  'READ_CHECK_PROFILE_NOT_ELIGIBLE',
  // T40b-2: 画面の path の理由は、確かめの owner の閉じた一覧（同じ値と順）。
  ...READ_CHECK_PAGE_PATH_REJECTION_REASONS,
] as const);
export type ReadCheckDefinitionRejectionReason = (typeof READ_CHECK_DEFINITION_REJECTION_REASONS)[number];

/**
 * 検証の誤り 1 件（`detail` は英語の診断の文。欄の名前と項目の位置だけを含み、送る値を含まない）。`parameter` は、送る値の名前の誤り
 * （`READ_PARAMETER_SECRET_LIKE`・`READ_PARAMETER_DANGEROUS_WORD`・`READ_PARAMETER_NOT_ALLOWED`）のときだけ、その欄の名前（画面が項目ごとに誤りを
 * 出すため。T27f）。ほかは null。
 */
export interface ReadCheckValidationError {
  readonly code: ReadCheckDefinitionRejectionReason;
  readonly detail: string;
  readonly parameter: string | null;
}

/** 検証の結果。受けるときは凍結した写し、拒むときは当たった誤りのすべて（1 件以上）。 */
export type ReadCheckValidationResult =
  | { readonly ok: true; readonly definition: ReadCheckDefinition }
  | { readonly ok: false; readonly errors: readonly ReadCheckValidationError[] };

/** 定義の中身のスキーマの名前。 */
const READ_CHECK_DEFINITION_SCHEMA_NAME = 'read-check-definition';

const errorOf = (code: ReadCheckDefinitionRejectionReason, detail: string, parameter: string | null = null): ReadCheckValidationError =>
  Object.freeze({ code, detail, parameter });

/** 候補を、READ の確かめの対象にできる分類か（画面が「READ の確かめに使える」を示すための読み出し。T27f）。 */
export const isReadCheckTargetClassification = (classification: DiscoveryCandidate['classification']): boolean =>
  classification === READ_CANDIDATE_CLASSIFICATION;

const rejected = (errors: readonly ReadCheckValidationError[]): ReadCheckValidationResult =>
  Object.freeze({ ok: false, errors: Object.freeze([...errors]) });

/**
 * 送る値の名前の誤り（秘密に見える名前、危険な語、送れない欄。名前ごとに、この順で最初の 1 件）。`candidate` が `null` なら、送れる欄かは
 * 確かめない。
 */
const parameterErrorsOf = (definition: ReadCheckDefinition, candidate: DiscoveryCandidate | null): readonly ReadCheckValidationError[] =>
  Object.entries(definition.parameters).flatMap(([name, value]) => {
    const label = JSON.stringify(name);
    if (isSecretUrlQueryParameterName(name)) {
      return [errorOf('READ_PARAMETER_SECRET_LIKE', `the parameter ${label} looks like a secret and is never sent`, name)];
    }
    if (readParametersHaveDestructiveWord({ [name]: value })) {
      return [errorOf('READ_PARAMETER_DANGEROUS_WORD', `the name or the value of the parameter ${label} has a dangerous word and is never sent`, name)];
    }
    if (candidate !== null && !isSendableReadCheckParameter(candidate, name)) {
      return [errorOf('READ_PARAMETER_NOT_ALLOWED', `the parameter ${label} is not a visible, editable field of the candidate`, name)];
    }
    return [];
  });

/** 画面の path の理由ごとの誤りの文（英語の診断の文。path と値を含まない）。 */
const PAGE_PATH_ERROR_DETAILS: Readonly<Record<ReadCheckPagePathRejection, string>> = Object.freeze({
  READ_PAGE_PATH_INVALID: 'the page path is not a canonical absolute path without a query and a fragment',
  READ_PAGE_START_URL_UNKNOWN: 'the start URL of the profile is not known',
  READ_PAGE_ORIGIN_NOT_ALLOWED: 'the origin of the start URL is not an allowed origin of the profile',
  READ_PAGE_PATH_EXCLUDED: 'the page path is excluded, outside the audit paths or the login screen',
  READ_PAGE_PATH_DANGEROUS_WORD: 'the page path has a dangerous word',
});

/**
 * 画面の path の定義の誤り（T37d。判定は T40b-2 から唯一の owner `readCheckPagePathRejectionsOf`。理由を誤りの文に写すだけ）。T38c: `{id}` つきの型は、
 * 代わりの値を入れた path で確かめる（型でない `{`・`}` は形の誤り）。
 */
const pageErrorsOf = (definition: ReadCheckPageDefinition, page: ReadCheckPageContext | null): readonly ReadCheckValidationError[] => {
  const checked = checkedReadCheckPagePathOf(definition.targetPagePath);
  const rejections: readonly ReadCheckPagePathRejection[] = checked === null ? ['READ_PAGE_PATH_INVALID'] : readCheckPagePathRejectionsOf(checked, page);
  return rejections.map((code) => errorOf(code, PAGE_PATH_ERROR_DETAILS[code]));
};

/** 対象の候補の誤り。 */
const candidateErrorsOf = (definition: ReadCheckCandidateDefinition, candidate: DiscoveryCandidate | null): readonly ReadCheckValidationError[] => {
  if (candidate === null || candidate.identityDigest !== definition.targetIdentityDigest) {
    return [errorOf('READ_CANDIDATE_UNKNOWN', 'the target candidate is not the given candidate of the latest discovery')];
  }
  return isReadCheckTargetClassification(candidate.classification)
    ? []
    : [errorOf('READ_CANDIDATE_NOT_READ', `the target candidate is classified as ${candidate.classification}, not ${READ_CANDIDATE_CLASSIFICATION}`)];
};

/** 形だけを確かめる（スキーマ）。通れば凍結した写し。手順は `schema-checked-copy.ts`（CCX-17。CC-077）。 */
const shapeOf = (input: unknown): ReadCheckValidationResult => {
  const shape = schemaCheckedCopyOf<ReadCheckDefinition>(READ_CHECK_DEFINITION_SCHEMA_NAME, input);
  if (!shape.ok) {
    return rejected(shape.errors.map((error) => errorOf('READ_CHECK_INPUT_INVALID', error)));
  }
  return Object.freeze({ ok: true, definition: shape.value });
};

/**
 * READ の確かめの定義を、対象の候補に照らして確かめる（純粋。入力を変えない）。誤りの順は、対象の候補、送る値の名前（定義の順）。
 * 形が違えば、`READ_CHECK_INPUT_INVALID` だけを返す。T37d: 画面の path の定義は、候補を見ずに、画面の文脈（`page`。なければ
 * `READ_PAGE_START_URL_UNKNOWN`）に照らす（`pageErrorsOf`）。送る値は持たない（形で確かめる）。
 */
export const validateReadCheckDefinition = (
  input: unknown,
  candidate: DiscoveryCandidate | null,
  page: ReadCheckPageContext | null = null,
): ReadCheckValidationResult => {
  const shape = shapeOf(input);
  if (!shape.ok) {
    return shape;
  }
  const { definition } = shape;
  const errors = definition.targetPagePath !== undefined
    ? pageErrorsOf(definition, page)
    : [...candidateErrorsOf(definition, candidate), ...parameterErrorsOf(definition, candidate)];
  return errors.length > 0 ? rejected(errors) : shape;
};

/**
 * 保存の前の確かめ直し（形と、秘密に見える名前だけ。候補は見ない）。通らなければ `RangeError`（呼び出し側が `validateReadCheckDefinition` を
 * 通していない誤り）。凍結した写しを返す。T37d: 画面の path の定義は、path が正規の形であること（`readCheckPageUrlOf`。Origin は問わない）も
 * 確かめ直す。
 */
export const assertStorableReadCheckDefinition = (definition: ReadCheckDefinition): ReadCheckDefinition => {
  const shape = shapeOf(definition);
  if (!shape.ok) {
    throw new RangeError(`the READ check definition does not match the contract: ${shape.errors.map(({ detail }) => detail).join('; ')}`);
  }
  if (Object.keys(shape.definition.parameters).some(isSecretUrlQueryParameterName)) {
    throw new RangeError('the READ check definition sends a parameter whose name looks like a secret');
  }
  const pagePath = readCheckTargetKindOf(shape.definition) === 'PAGE' ? checkedReadCheckPagePathOf(shape.definition.targetPagePath ?? '') : null;
  if (readCheckTargetKindOf(shape.definition) === 'PAGE' && (pagePath === null || readCheckPageUrlOf(READ_CHECK_PAGE_PATH_FORM_ORIGIN, pagePath) === null)) {
    throw new RangeError('the page path of the READ check definition is not canonical');
  }
  return shape.definition;
};

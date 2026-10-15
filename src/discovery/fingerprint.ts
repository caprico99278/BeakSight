// 発見の候補の 2 つの digest（Task 27 の設計書 4.4。T27a）。SHA-256 の作成は `src/core/ids.ts` の `createSha256Fingerprint` に任せる。
// - 識別の digest: 画面の Origin と path、候補の種類、method（form の method と `_method` の上書き）、送信先の Origin と path と query の
//   名前、名前のある入力の欄の `name`・`tag`・`type`、送信ボタンの語（T27R-fix-1。DEF-086。文言そのものではなく、文言が当たった分類の閉じた
//   一覧の語。表の行ごとに文言が違うボタンでも、語の組が同じなら同じ識別になる。版 2）。
// - 入力規則の digest: 名前のある入力の欄ごとの `name`・`tag`・`type` と、必須・readonly・disabled・hidden・制約・選択肢の値と省いた件数。
// - 入れないもの: 入力の値、トークン、label の文言、送信ボタンの文言（候補の契約に項目がない。読むのは契約の項目だけなので、呼び出し側が余分な項目を
//   渡しても入らない）。値があるか（読み込み直しで変わる）、JS の結び付き、enctype、target、不完全の理由も入れない。
// - 並べ方の決め（欄の順と選択肢の順に依らない）: 欄は、欄ごとの JSON の文字列を UTF-16 のコード単位の順（`compareCodeUnits`）に並べる
//   （同じ名前の欄は、その数だけ並べる）。選択肢の値と query の名前と送信ボタンの語も、同じ順に並べる。名前のない欄（送られない）は入れない。
// - 文書の形の印（`*_DIGEST_FORMAT`）を先頭に入れる。並べ方や項目を変えるときは、印の版を上げる。
// - T31b（Task 31 の設計書 3 章の「型にした識別の digest」、11 章の T31b の Blocker の判断（案 D））: 型にした識別の digest。識別の digest の入力の
//   うち、画面の path と送信先の path の、同じ値を持つ区切りの組 1 つを `{id}`（`PATH_TEMPLATE_ID_SEGMENT`）にした形に、enctype を足して求める
//   （別の印 `CANDIDATE_TEMPLATE_IDENTITY_DIGEST_FORMAT`。今の識別の digest（版 2）は変えない）。ID だけが違う 2 つの画面の候補で同じになる。
//   - 組の一覧（`recordIdSegmentPairsOf`）: 値がレコードの ID の形に合う組だけ（判定は呼び出し側が渡す。owner は
//     `src/control/actions/action-outcome.ts` の `usableRecordIdOf`。ここは `src/control/` を import しない）。画面の区切りの位置、送信先の区切りの
//     位置の順に、上限（`MAX_RECORD_ID_SEGMENT_PAIRS`）まで。
//   - 一覧の digest（`templatedIdentityDigestsOf`）: 発見の索引に入れるときに、親が候補の全体から求める（索引の読み書きは版 9。T31e）。digest だけで、
//     欄の名前は持たない（Task 27 の 4.8）。
//   - シナリオの型（`recordIdSegmentPairOfTemplates`、`recordIdOfTemplates`）: 更新の画面の path と送信先の path の型から、組の位置と、候補の具体的な
//     path に戻る ID の値を決める（下書きの確かめ `src/control/approval/scenario-policy.ts` が使う）。
//   - T31i: 対象のレコードの ID と同じ値の区切りの組（ちょうど 1 つ）で求める口（`templatedIdentityDigestForRecordIdOf`。ワーカーの更新の
//     画面の確かめが使う）。
//   - T31h-1: 候補から作れる path の型の組の一覧（`pathTemplateOptionsOf`）。組の列挙は `recordIdSegmentPairsOf` と同じ。画面が、候補の具体的な
//     path から ID の区切りを選んで型を作るための口（ID の形の判定は呼び出し側が渡す）。
// 純粋な関数だけのファイル。Playwright、ブラウザ、`node:fs`、`src/control/`、監査エンジンを import しない
// （`tests/architecture/discovery-boundary.test.ts`）。
import { createSha256Fingerprint } from '../core/ids.js';
import { compareCodeUnits } from '../core/text.js';
import {
  FIELD_CONSTRAINT_NAMES,
  type CandidateDigests,
  type CandidateField,
  type DiscoveredCandidate,
} from './candidate-contracts.js';

/** 識別の digest の入力の形の印（版つき）。 */
export const CANDIDATE_IDENTITY_DIGEST_FORMAT = 'beaksight-candidate-identity/2';

/** 入力規則の digest の入力の形の印（版つき）。 */
export const CANDIDATE_RULE_DIGEST_FORMAT = 'beaksight-candidate-rules/1';

/** 型にした識別の digest の入力の形の印（版つき。T31b）。 */
export const CANDIDATE_TEMPLATE_IDENTITY_DIGEST_FORMAT = 'beaksight-candidate-template-identity/1';

/** path の型の中の、レコードの ID の区切りの印（型にちょうど 1 つ。path の 1 つの区切りの全体。T31b）。 */
export const PATH_TEMPLATE_ID_SEGMENT = '{id}';

/** 1 つの候補の、ID の区切りの組の最大の件数（索引の一覧の上限。T31b）。 */
export const MAX_RECORD_ID_SEGMENT_PAIRS = 8;

/** path の区切り。 */
const PATH_SEPARATOR = '/';

/** 画面の path と送信先の path の、ID の区切りの組（`path.split('/')` の位置。先頭の空の区切りが 0）。 */
export interface RecordIdSegmentPair {
  readonly pageSegment: number;
  readonly actionSegment: number;
}

/** 文字列の一覧を、UTF-16 のコード単位の順に並べた写し。 */
const sortedTexts = (texts: readonly string[]): readonly string[] => [...texts].sort(compareCodeUnits);

/** 名前のある欄（送られる欄）だけ。 */
const namedFieldsOf = (candidate: DiscoveredCandidate): readonly CandidateField[] =>
  candidate.fields.filter((field) => field.name.length > 0);

/** 識別の、欄 1 件の形（`[name, tag, type]` の JSON）。 */
const identityFieldOf = (field: CandidateField): string => JSON.stringify([field.name, field.tag, field.type]);

/** 入力規則の、欄 1 件の形（決まった項目の順の JSON。制約は `FIELD_CONSTRAINT_NAMES` の順）。 */
const ruleFieldOf = (field: CandidateField): string => JSON.stringify([
  field.name,
  field.tag,
  field.type,
  field.required,
  field.readonly,
  field.disabled,
  field.hidden,
  FIELD_CONSTRAINT_NAMES.map((name) => field.constraints[name]),
  field.options === null ? null : sortedTexts(field.options),
  field.omittedOptionCount,
]);

/** 識別の digest の入力の並び（画面の path と送信先の path は引数。型にした形と共用。並びを変えるときは、両方の印の版を上げる）。 */
const identityItemsOf = (candidate: DiscoveredCandidate, pagePath: string, actionPath: string | null): readonly unknown[] => {
  const { action } = candidate;
  return [
    candidate.page.origin,
    pagePath,
    candidate.kind,
    candidate.formMethod,
    candidate.methodOverride,
    action === null || actionPath === null ? null : [action.origin, actionPath, sortedTexts(action.queryNames)],
    sortedTexts(namedFieldsOf(candidate).map(identityFieldOf)),
    sortedTexts(candidate.submitterWords),
  ];
};

/** 候補の 2 つの digest を求める（純粋。入力を変えない）。 */
export const computeCandidateDigests = (candidate: DiscoveredCandidate): CandidateDigests => {
  const fields = namedFieldsOf(candidate);
  const identityInput = JSON.stringify([
    CANDIDATE_IDENTITY_DIGEST_FORMAT,
    ...identityItemsOf(candidate, candidate.page.path, candidate.action?.path ?? null),
  ]);
  const ruleInput = JSON.stringify([CANDIDATE_RULE_DIGEST_FORMAT, sortedTexts(fields.map(ruleFieldOf))]);
  return Object.freeze({
    identityDigest: createSha256Fingerprint(identityInput),
    ruleDigest: createSha256Fingerprint(ruleInput),
  });
};

// ---------------------------------------------------------------------------------------------------------------
// 型にした識別の digest（T31b）
// ---------------------------------------------------------------------------------------------------------------

/** path の区切り（先頭の空の区切りを含む）。 */
const segmentsOf = (path: string): readonly string[] => path.split(PATH_SEPARATOR);

/** 区切り 1 つを `value` にした path。 */
const replacedPathOf = (segments: readonly string[], index: number, value: string): string =>
  segments.map((segment, position) => (position === index ? value : segment)).join(PATH_SEPARATOR);

/**
 * 画面の path と送信先の path の、同じ値を持つ区切りの組（値が `isRecordId` に当たる組だけ。画面の位置、送信先の位置の順。上限
 * `MAX_RECORD_ID_SEGMENT_PAIRS` 件まで。凍結）。送信先がなければ空。
 */
export const recordIdSegmentPairsOf = (
  candidate: DiscoveredCandidate,
  isRecordId: (value: string) => boolean,
): readonly RecordIdSegmentPair[] => {
  if (candidate.action === null) {
    return Object.freeze([]);
  }
  const actionSegments = segmentsOf(candidate.action.path);
  const pairs = segmentsOf(candidate.page.path).flatMap((value, pageSegment) => (isRecordId(value)
    ? actionSegments.flatMap((other, actionSegment) => (other === value ? [Object.freeze({ pageSegment, actionSegment })] : []))
    : []));
  return Object.freeze(pairs.slice(0, MAX_RECORD_ID_SEGMENT_PAIRS));
};

/**
 * 組 1 つの、型にした識別の digest（純粋）。組の位置が path の外、2 つの区切りの値が違う、送信先がないときは null。入力は、識別の digest の並びの
 * 2 つの path の区切りを `{id}` にした形と、enctype。
 */
export const templatedIdentityDigestOf = (candidate: DiscoveredCandidate, pair: RecordIdSegmentPair): string | null => {
  if (candidate.action === null) {
    return null;
  }
  const pageSegments = segmentsOf(candidate.page.path);
  const actionSegments = segmentsOf(candidate.action.path);
  const value = pageSegments[pair.pageSegment];
  if (value === undefined || actionSegments[pair.actionSegment] !== value) {
    return null;
  }
  return createSha256Fingerprint(JSON.stringify([
    CANDIDATE_TEMPLATE_IDENTITY_DIGEST_FORMAT,
    ...identityItemsOf(
      candidate,
      replacedPathOf(pageSegments, pair.pageSegment, PATH_TEMPLATE_ID_SEGMENT),
      replacedPathOf(actionSegments, pair.actionSegment, PATH_TEMPLATE_ID_SEGMENT),
    ),
    candidate.enctype,
  ]));
};

/** 候補の、型にした識別の digest の一覧（組ごと。UTF-16 のコード単位の順、重なりなし。凍結）。索引に入れるときに親が求める。 */
export const templatedIdentityDigestsOf = (candidate: DiscoveredCandidate, isRecordId: (value: string) => boolean): readonly string[] => {
  const digests = recordIdSegmentPairsOf(candidate, isRecordId).flatMap((pair) => {
    const digest = templatedIdentityDigestOf(candidate, pair);
    return digest === null ? [] : [digest];
  });
  return Object.freeze(sortedTexts([...new Set(digests)]));
};

/**
 * T31i（T31g-2 の共通化の候補）: 具体的な画面の候補の、対象のレコードの ID（`recordId`）と同じ値を持つ区切りの組で求めた、型にした識別の digest
 * （純粋）。組がちょうど 1 つのときだけ（0 や 2 つ以上は、どの区切りが ID か決められないので null。空の ID も null）。ワーカーの書き込みの流れが、
 * 更新の画面の確かめで、承認した型にした digest と照らすのに使う（START に path の型を持たせない。T31g-2 の判断）。
 */
export const templatedIdentityDigestForRecordIdOf = (candidate: DiscoveredCandidate, recordId: string): string | null => {
  if (recordId.length === 0) {
    return null;
  }
  const pairs = recordIdSegmentPairsOf(candidate, (value) => value === recordId);
  const [pair] = pairs;
  return pairs.length === 1 && pair !== undefined ? templatedIdentityDigestOf(candidate, pair) : null;
};

/** path の型の中の、`{id}` の区切りの位置（`{id}` がちょうど 1 つで、区切りの全体でなければ null）。 */
const placeholderSegmentOf = (template: string): number | null => {
  const positions = segmentsOf(template).flatMap((segment, index) => (segment === PATH_TEMPLATE_ID_SEGMENT ? [index] : []));
  const occurrences = template.split(PATH_TEMPLATE_ID_SEGMENT).length - 1;
  return positions.length === 1 && occurrences === 1 ? positions[0] ?? null : null;
};

/**
 * 型に ID を入れた具体的な path（CCX-28。型の `{id}` の区切り（ちょうど 1 つ、区切りの全体）を `recordId` にする。純粋）。型がその形でない、
 * `recordId` が空か区切りの `/` を含むときは null。ID の形（登録の ID として使える形）は呼び出し側が確かめる。
 */
export const concretePathOfTemplate = (template: string, recordId: string): string | null => {
  const index = placeholderSegmentOf(template);
  return index === null || recordId.length === 0 || recordId.includes(PATH_SEPARATOR)
    ? null
    : replacedPathOf(segmentsOf(template), index, recordId);
};

/** シナリオの 2 つの path の型から、ID の区切りの組（それぞれ `{id}` をちょうど 1 つ、区切りの全体に持たなければ null）。 */
export const recordIdSegmentPairOfTemplates = (formPathTemplate: string, actionPathTemplate: string): RecordIdSegmentPair | null => {
  const pageSegment = placeholderSegmentOf(formPathTemplate);
  const actionSegment = placeholderSegmentOf(actionPathTemplate);
  return pageSegment === null || actionSegment === null ? null : Object.freeze({ pageSegment, actionSegment });
};

/**
 * 2 つの path の型に、候補の同じ位置の区切りの値を入れると、画面の path と送信先の path の両方に、同じ値で戻るときの、その値（ID）。戻らない、
 * 型が組を持たない、送信先がないときは null。ID の形は確かめない（呼び出し側が確かめる）。
 */
export const recordIdOfTemplates = (candidate: DiscoveredCandidate, formPathTemplate: string, actionPathTemplate: string): string | null => {
  const pair = recordIdSegmentPairOfTemplates(formPathTemplate, actionPathTemplate);
  if (pair === null || candidate.action === null) {
    return null;
  }
  const value = segmentsOf(candidate.page.path)[pair.pageSegment];
  if (value === undefined) {
    return null;
  }
  const restoredPage = replacedPathOf(segmentsOf(formPathTemplate), pair.pageSegment, value);
  const restoredAction = replacedPathOf(segmentsOf(actionPathTemplate), pair.actionSegment, value);
  return restoredPage === candidate.page.path && restoredAction === candidate.action.path ? value : null;
};

/** 候補から作れる path の型の組 1 つ（T31h-1）。 */
export interface PathTemplateOption {
  /** 更新の画面の path の型（ID の区切りを `{id}` にした形）。 */
  readonly formPathTemplate: string;
  /** 送信先の path の型（同じ形）。 */
  readonly actionPathTemplate: string;
  /** 型に入れると、候補の具体的な path に戻る ID の区切りの値。 */
  readonly recordId: string;
}

/**
 * 候補から作れる path の型の組の一覧（T31h-1。Task 31 の設計書 3 章の「UPDATE の指定」。画面が、候補の具体的な path から ID の区切りを選んで型を
 * 作るための口）。組の列挙は `recordIdSegmentPairsOf` と同じ（値が `isRecordId` に当たる組だけ。順と上限も同じ）。組ごとに、2 つの区切りを
 * `{id}` にした型と、その値を返す。型が候補の path に同じ値で戻らない組（path に `{id}` の文字が既にあるなど）は入れない（`recordIdOfTemplates`
 * で確かめる）。凍結。
 */
export const pathTemplateOptionsOf = (
  candidate: DiscoveredCandidate,
  isRecordId: (value: string) => boolean,
): readonly PathTemplateOption[] => {
  if (candidate.action === null) {
    return Object.freeze([]);
  }
  const pageSegments = segmentsOf(candidate.page.path);
  const actionSegments = segmentsOf(candidate.action.path);
  const options = recordIdSegmentPairsOf(candidate, isRecordId).flatMap((pair): readonly PathTemplateOption[] => {
    const formPathTemplate = replacedPathOf(pageSegments, pair.pageSegment, PATH_TEMPLATE_ID_SEGMENT);
    const actionPathTemplate = replacedPathOf(actionSegments, pair.actionSegment, PATH_TEMPLATE_ID_SEGMENT);
    const recordId = recordIdOfTemplates(candidate, formPathTemplate, actionPathTemplate);
    return recordId === null ? [] : [Object.freeze({ formPathTemplate, actionPathTemplate, recordId })];
  });
  return Object.freeze(options);
};

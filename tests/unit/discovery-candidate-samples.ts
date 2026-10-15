// T27a（Task 27 の設計書 4.1）: 発見の候補（`DiscoveredCandidate`）の例を組み立てる、テストの補助（テストのファイルではない）。
// 分類（`discovery-classify.test.ts`）、指紋（`discovery-fingerprint.test.ts`）、スキーマ（`discovery-candidate-schema.test.ts`）が共用する。
// 例の値は、匿名の値（`127.0.0.1`、`example.invalid`）だけを使う。
// T27R-fix-1（DEF-086）: 候補は送信ボタンの文言を持たず、語（`submitterWords`）だけを持つ。例の上書きの `submitterText` は、probe が読んだ文言の
// 代わりで、本番の probe と同じく分類の owner の `submitterWordsOf` で語に変え、文言は候補に入れない（修正の前後で同じ表を使うため）。
import {
  FIELD_CONSTRAINT_NAMES,
  type CandidateField,
  type CandidateFieldConstraints,
  type CandidateFieldType,
  type CandidateJsBinding,
  type DiscoveredCandidate,
} from '../../src/discovery/candidate-contracts.js';
import { submitterWordsOf } from '../../src/discovery/classify.js';

export const SAMPLE_ORIGIN = 'http://127.0.0.1:4173';
export const OTHER_ORIGIN = 'https://other.example.invalid';
export const SAMPLE_ALLOWED_ORIGINS: ReadonlySet<string> = new Set([SAMPLE_ORIGIN]);

const URLENCODED = 'application/x-www-form-urlencoded';

/** 制約がない欄の制約（すべて null）。 */
export const NO_CONSTRAINTS: CandidateFieldConstraints = Object.freeze(
  Object.fromEntries(FIELD_CONSTRAINT_NAMES.map((name) => [name, null])) as unknown as CandidateFieldConstraints,
);

/** listener も inline の処理もない JS の結び付き。 */
export const NO_JS_BINDING: CandidateJsBinding = Object.freeze({
  form: [],
  submitter: [],
  ancestor: [],
  document: [],
  window: [],
  inlineHandler: false,
});

const tagOf = (type: CandidateFieldType): CandidateField['tag'] => {
  if (type === 'textarea') {
    return 'textarea';
  }
  return type === 'select-one' || type === 'select-multiple' ? 'select' : 'input';
};

/** 入力の欄 1 件（既定は、制約のない text の欄）。 */
export const sampleField = (
  name: string,
  type: CandidateFieldType = 'text',
  overrides: Partial<CandidateField> = {},
): CandidateField => ({
  name,
  tag: tagOf(type),
  type,
  required: false,
  readonly: false,
  disabled: false,
  hidden: type === 'hidden',
  constraints: NO_CONSTRAINTS,
  options: null,
  omittedOptionCount: 0,
  hasValue: false,
  ...overrides,
});

/** 例の上書き（`submitterText` は probe が読んだ送信ボタンの文言の代わり。null はボタンのない form。語に変えて、文言は持たない）。 */
export type SampleCandidateOverrides = Partial<DiscoveredCandidate> & { readonly submitterText?: string | null };

/** 上書きの `submitterText` を、送信ボタンの語に変える（`submitterWords` を直に渡したら、そちらを使う）。 */
const wordsOverridesOf = (overrides: SampleCandidateOverrides): Partial<DiscoveredCandidate> => {
  const { submitterText, ...rest } = overrides;
  return submitterText === undefined
    ? rest
    : { submitterWords: submitterText === null ? [] : submitterWordsOf(submitterText), ...rest };
};

/** form の候補 1 件（既定は、許可 Origin への POST の、文言「送信」（語なし）のボタン）。 */
export const sampleForm = (overrides: SampleCandidateOverrides = {}): DiscoveredCandidate => ({
  page: { origin: SAMPLE_ORIGIN, path: '/page' },
  kind: 'FORM',
  formMethod: 'POST',
  methodOverride: null,
  action: { origin: SAMPLE_ORIGIN, path: '/action', queryNames: [] },
  enctype: URLENCODED,
  target: '',
  fields: [],
  submitterWords: submitterWordsOf('送信'),
  jsBinding: NO_JS_BINDING,
  incompleteReasons: [],
  ...wordsOverridesOf(overrides),
});

/** form の外のボタンの候補 1 件（既定は、listener のない、文言「表示」（語なし）のボタン）。 */
export const sampleButton = (overrides: SampleCandidateOverrides = {}): DiscoveredCandidate => ({
  page: { origin: SAMPLE_ORIGIN, path: '/page' },
  kind: 'BUTTON',
  formMethod: null,
  methodOverride: null,
  action: null,
  enctype: null,
  target: null,
  fields: [],
  submitterWords: submitterWordsOf('表示'),
  jsBinding: NO_JS_BINDING,
  incompleteReasons: [],
  ...wordsOverridesOf(overrides),
});

/** 送信先（許可 Origin の path と、query の名前）。 */
export const sampleAction = (path: string, queryNames: readonly string[] = [], origin = SAMPLE_ORIGIN): DiscoveredCandidate['action'] => ({
  origin,
  path,
  queryNames,
});

// 業務テンプレートと意味の推しの唯一の owner（Task 29 の設計書 3 章の規則の優先順位と業務テンプレート、4.2。T29c）。純粋な定義と関数。
// - 3 つの業務テンプレート（顧客・予約・商品）と、その意味の種類。欄の名前・型・autocomplete から意味の種類を推す表（閉じた語の一覧。日本語を
//   含む）。推せなければ null（欄の判定が `SEMANTIC_KIND_UNDECIDED` にする）。テンプレートにサイト固有の値を書かない。
// - 推しの順: 外部到達の欄（メール・電話。判定は `external-delivery-words.ts`）→ フリガナ → 氏名 → 合計 → 単価 → 数量 → 人数 → 商品名 → 備考 →
//   開始 → 終了 → 日付 → 汎用（型から）。意味の種類ごとに、合う欄の型（`SEMANTIC_KIND_FIELD_TYPES`）だけで推す。
// - 欄の名前の語の比べ方は、発見の分類の `fieldNameHasListedWord`（英語の語は語の単位の並び、日本語の語は部分一致）。区切りのない短い日本語の
//   名前（`姓`・`名`・`セイ`・`メイ`）は、畳み込んだ名前の完全一致（`TEMPLATE_KIND_EXACT_NAMES`）だけで当てる（`名前`・`会社名` が `名` に
//   当たらないように）。
// - 既定の範囲（`TEMPLATE_DEFAULT_RANGES`）は、数と金額だけ（欄にも人の規則にも範囲がないときの補い）。日付と時刻の範囲は、欄の min・max と
//   人の範囲だけで決める（基準日から範囲を推さない。設計書 10 章の 3）。
// - 既定の関係（`defaultRelationsOf`）と、既定の一意にする欄の組（`defaultUniqueKeyFieldNamesOf`）。
// - 語の一覧は照らすためのデータで、利用者に見せる文言ではない（GATE-UI06 の除外の理由）。一覧の語を、このファイルの外に書かない
//   （`tests/architecture/data-rules-boundary.test.ts` の (d)）。
import { compareCodeUnits, foldNfkcCase } from '../../core/text.js';
import { CHOICE_FIELD_TYPES, VALUE_INPUT_FIELD_TYPES, type CandidateField, type CandidateFieldType } from '../../discovery/candidate-contracts.js';
import { fieldNameHasListedWord } from '../../discovery/classify.js';
import { externalDeliveryKindsOf } from './external-delivery-words.js';
import type { FieldRelation, FieldRule, RuleRange, SemanticKind } from './rule-contracts.js';

/** 業務テンプレート（閉じた一覧）。 */
export const BUSINESS_TEMPLATES = Object.freeze(['CUSTOMER', 'RESERVATION', 'PRODUCT'] as const);
export type BusinessTemplate = (typeof BUSINESS_TEMPLATES)[number];

/** テンプレートごとの意味の種類（補完の画面の分け方。設計書 3 章）。 */
export const TEMPLATE_SEMANTIC_KINDS = Object.freeze({
  CUSTOMER: Object.freeze(['FAMILY_NAME', 'GIVEN_NAME', 'FULL_NAME', 'FAMILY_NAME_KANA', 'GIVEN_NAME_KANA', 'FULL_NAME_KANA', 'EMAIL', 'PHONE',
    'NOTE'] as const),
  RESERVATION: Object.freeze(['DATE', 'START_TIME', 'END_TIME', 'PARTY_SIZE', 'GENERIC_CHOICE'] as const),
  PRODUCT: Object.freeze(['PRODUCT_NAME', 'UNIT_PRICE', 'QUANTITY', 'TOTAL_PRICE'] as const),
} as const satisfies Readonly<Record<BusinessTemplate, readonly SemanticKind[]>>);

// ---------------------------------------------------------------------------------------------------------------
// 意味の種類と欄の型
// ---------------------------------------------------------------------------------------------------------------

const TEXT_TYPES = Object.freeze(['text', 'search', 'textarea'] as const);
const SINGLE_CHOICE_TYPES = Object.freeze(['select-one', 'radio'] as const);
const NUMBER_TYPES = Object.freeze(['number', 'range', 'text', 'search', ...SINGLE_CHOICE_TYPES] as const);
const TEMPORAL_TYPES = Object.freeze(['date', 'time', 'datetime-local', 'month', 'week', ...SINGLE_CHOICE_TYPES] as const);

/** 意味の種類ごとの、合う欄の型（閉じた一覧）。合わなければ `SEMANTIC_KIND_TYPE_MISMATCH`。 */
export const SEMANTIC_KIND_FIELD_TYPES = Object.freeze({
  GENERIC_NUMBER: Object.freeze(['number', 'range'] as const),
  GENERIC_DATETIME: Object.freeze(['date', 'time', 'datetime-local', 'month', 'week'] as const),
  GENERIC_CHOICE: CHOICE_FIELD_TYPES,
  GENERIC_COLOR: Object.freeze(['color'] as const),
  FAMILY_NAME: TEXT_TYPES,
  GIVEN_NAME: TEXT_TYPES,
  FULL_NAME: TEXT_TYPES,
  FAMILY_NAME_KANA: TEXT_TYPES,
  GIVEN_NAME_KANA: TEXT_TYPES,
  FULL_NAME_KANA: TEXT_TYPES,
  EMAIL: Object.freeze(['email', 'text', 'search'] as const),
  PHONE: Object.freeze(['tel', 'text', 'search'] as const),
  NOTE: TEXT_TYPES,
  PRODUCT_NAME: TEXT_TYPES,
  UNIT_PRICE: NUMBER_TYPES,
  QUANTITY: NUMBER_TYPES,
  TOTAL_PRICE: NUMBER_TYPES,
  DATE: TEMPORAL_TYPES,
  START_TIME: TEMPORAL_TYPES,
  END_TIME: TEMPORAL_TYPES,
  PARTY_SIZE: NUMBER_TYPES,
  // 人の固定の一覧で値を入れられる型（値を入れて送れる型のすべて。password・file・hidden を除く。owner は候補の欄の形。CCX-20）。
  FIXED_LIST: VALUE_INPUT_FIELD_TYPES,
  OUT_OF_TEMPLATE: VALUE_INPUT_FIELD_TYPES,
} as const satisfies Readonly<Record<SemanticKind, readonly CandidateFieldType[]>>);

/** 意味の種類が欄の型に合うか。 */
export const isSemanticKindCompatible = (kind: SemanticKind, type: CandidateFieldType): boolean =>
  (SEMANTIC_KIND_FIELD_TYPES[kind] as readonly CandidateFieldType[]).includes(type);

/** 氏名の意味の種類（漢字）と、そのフリガナの意味の種類（同じ人。フリガナの関係の組）。 */
export const NAME_KANA_PAIRS = Object.freeze([
  Object.freeze(['FAMILY_NAME', 'FAMILY_NAME_KANA'] as const),
  Object.freeze(['GIVEN_NAME', 'GIVEN_NAME_KANA'] as const),
  Object.freeze(['FULL_NAME', 'FULL_NAME_KANA'] as const),
] as const satisfies readonly (readonly [SemanticKind, SemanticKind])[]);

/** 氏名とフリガナの意味の種類（辞書の同じ人から作る）。 */
export const PERSON_NAME_KINDS = Object.freeze(NAME_KANA_PAIRS.flat() as readonly SemanticKind[]);

/** 日時の意味の種類（終了 > 開始の関係の欄）。 */
export const TEMPORAL_KINDS = Object.freeze(['DATE', 'START_TIME', 'END_TIME', 'GENERIC_DATETIME'] as const satisfies readonly SemanticKind[]);

/** 数の意味の種類（合計 = 単価 × 数量 の関係の欄と、既定の範囲）。 */
export const NUMERIC_KINDS = Object.freeze(['UNIT_PRICE', 'QUANTITY', 'TOTAL_PRICE', 'PARTY_SIZE', 'GENERIC_NUMBER'] as const satisfies
  readonly SemanticKind[]);

// ---------------------------------------------------------------------------------------------------------------
// 語の一覧（比べる形で書く。どの語も 1 つの種類だけに載る）
// ---------------------------------------------------------------------------------------------------------------

/** 意味の種類ごとの、欄の名前の語（英語は語の単位の並び、日本語は部分一致）。 */
export const TEMPLATE_KIND_NAME_WORDS = Object.freeze({
  FAMILY_NAME: Object.freeze(['last_name', 'lastname', 'family_name', 'familyname', 'surname', 'sei', '苗字', '名字'] as const),
  GIVEN_NAME: Object.freeze(['first_name', 'firstname', 'given_name', 'givenname', 'mei', '下の名前'] as const),
  FULL_NAME: Object.freeze(['name', 'fullname', '氏名', '名前', '姓名', 'フルネーム'] as const),
  NOTE: Object.freeze(['note', 'notes', 'remark', 'remarks', 'memo', 'comment', 'comments', 'message', 'biko', '備考', 'メモ', 'コメント',
    '要望', 'メッセージ'] as const),
  PRODUCT_NAME: Object.freeze(['product', 'productname', 'item', 'itemname', 'goods', '商品', '品名', '品目', '製品'] as const),
  UNIT_PRICE: Object.freeze(['price', 'unitprice', 'fee', 'cost', '単価', '価格', '値段', '料金'] as const),
  QUANTITY: Object.freeze(['quantity', 'qty', 'count', 'pcs', 'units', '数量', '個数', '点数', '枚数'] as const),
  TOTAL_PRICE: Object.freeze(['total', 'subtotal', 'amount', 'sum', 'totalprice', '合計', '小計', '総額', '金額'] as const),
  PARTY_SIZE: Object.freeze(['people', 'persons', 'guests', 'guest', 'pax', 'headcount', 'party_size', 'adults', '人数', '名様', '大人'] as const),
  DATE: Object.freeze(['date', 'day', '日付', '日にち', '予約日', '利用日', '来店日'] as const),
  START_TIME: Object.freeze(['start', 'from', 'checkin', 'check_in', '開始', 'から', 'チェックイン'] as const),
  END_TIME: Object.freeze(['end', 'to', 'until', 'finish', 'checkout', 'check_out', '終了', 'まで', 'チェックアウト'] as const),
} as const satisfies Readonly<Partial<Record<SemanticKind, readonly string[]>>>);

/** フリガナの印の語（欄の名前にあれば、氏名の種類をフリガナの種類にする）。 */
export const KANA_MARKER_WORDS = Object.freeze(['kana', 'furigana', 'yomi', 'ruby', 'フリガナ', 'ふりがな', 'カナ', 'かな', 'よみ', '読み'] as const);

/** 人の名前でない「名前」の語（あれば、氏名の種類を推さない。会社名・利用者名・ファイル名など。商品名の語も氏名にしない）。 */
export const NON_PERSON_NAME_WORDS = Object.freeze(['company', 'corp', 'corporation', 'organization', 'org', 'shop', 'store', 'user', 'login',
  'account', 'file', 'department', 'dept', 'title', '会社', '社名', '法人', '店舗', '店名', '部署', 'ファイル', 'ユーザー', 'アカウント'] as const);

/** 区切りのない短い名前の、畳み込んだ名前の完全一致（意味の種類ごと）。 */
export const TEMPLATE_KIND_EXACT_NAMES = Object.freeze({
  FAMILY_NAME: Object.freeze(['姓'] as const),
  GIVEN_NAME: Object.freeze(['名'] as const),
  FAMILY_NAME_KANA: Object.freeze(['セイ', 'せい'] as const),
  GIVEN_NAME_KANA: Object.freeze(['メイ', 'めい'] as const),
} as const satisfies Readonly<Partial<Record<SemanticKind, readonly string[]>>>);

/** autocomplete の値（HTML の autofill の欄の名前）から推す意味の種類。 */
export const TEMPLATE_AUTOCOMPLETE_KINDS = Object.freeze({
  name: 'FULL_NAME',
  'family-name': 'FAMILY_NAME',
  'given-name': 'GIVEN_NAME',
} as const satisfies Readonly<Record<string, SemanticKind>>);

/** 既定の範囲（数と金額だけ。欄にも人の規則にも min・max がないときの補い。サイト固有の値ではない、一般的な幅）。 */
export const TEMPLATE_DEFAULT_RANGES = Object.freeze({
  PARTY_SIZE: Object.freeze({ min: '1', max: '4', step: '1' }),
  QUANTITY: Object.freeze({ min: '1', max: '5', step: '1' }),
  UNIT_PRICE: Object.freeze({ min: '100', max: '10000', step: '100' }),
} as const satisfies Readonly<Partial<Record<SemanticKind, RuleRange>>>);

/** 既定の範囲（ない種類は null）。 */
export const templateDefaultRangeOf = (kind: SemanticKind): RuleRange | null =>
  (TEMPLATE_DEFAULT_RANGES as Readonly<Partial<Record<SemanticKind, RuleRange>>>)[kind] ?? null;

// ---------------------------------------------------------------------------------------------------------------
// 推し
// ---------------------------------------------------------------------------------------------------------------

/** 推しに使う欄の項目。 */
export type InferenceField = Pick<CandidateField, 'name' | 'type'> & {
  readonly constraints: Pick<CandidateField['constraints'], 'autocomplete'>;
};

const nameHas = (name: string, kind: keyof typeof TEMPLATE_KIND_NAME_WORDS): boolean => fieldNameHasListedWord(name, TEMPLATE_KIND_NAME_WORDS[kind]);

const exactNameIs = (name: string, kind: keyof typeof TEMPLATE_KIND_EXACT_NAMES): boolean =>
  (TEMPLATE_KIND_EXACT_NAMES[kind] as readonly string[]).includes(foldNfkcCase(name).trim());

/** autocomplete の値（空白で分けた最後の語。HTML の autofill の欄の名前）が指す意味の種類。 */
const autocompleteKindOf = (autocomplete: string | null): SemanticKind | null => {
  const tokens = autocomplete === null ? [] : foldNfkcCase(autocomplete).split(/\s+/u).filter((token) => token.length > 0);
  const last = tokens.at(-1);
  return last !== undefined && Object.hasOwn(TEMPLATE_AUTOCOMPLETE_KINDS, last)
    ? TEMPLATE_AUTOCOMPLETE_KINDS[last as keyof typeof TEMPLATE_AUTOCOMPLETE_KINDS]
    : null;
};

/** 氏名とフリガナの推し（人の名前でない語があれば推さない）。 */
const personNameKindOf = (field: InferenceField): SemanticKind | null => {
  if (!isSemanticKindCompatible('FULL_NAME', field.type) || fieldNameHasListedWord(field.name, NON_PERSON_NAME_WORDS)
    || nameHas(field.name, 'PRODUCT_NAME')) {
    return null;
  }
  const { name } = field;
  if (exactNameIs(name, 'FAMILY_NAME_KANA')) {
    return 'FAMILY_NAME_KANA';
  }
  if (exactNameIs(name, 'GIVEN_NAME_KANA')) {
    return 'GIVEN_NAME_KANA';
  }
  const family = exactNameIs(name, 'FAMILY_NAME') || nameHas(name, 'FAMILY_NAME');
  const given = exactNameIs(name, 'GIVEN_NAME') || nameHas(name, 'GIVEN_NAME');
  const autocomplete = autocompleteKindOf(field.constraints.autocomplete);
  const kana = fieldNameHasListedWord(name, KANA_MARKER_WORDS);
  // 姓と名の片方だけが当たれば、その種類。両方か、どちらでもなくフルネームの語・印があれば、フルネーム。
  const base: SemanticKind | null = family !== given
    ? (family ? 'FAMILY_NAME' : 'GIVEN_NAME')
    : (family || kana || nameHas(name, 'FULL_NAME') ? 'FULL_NAME' : autocomplete);
  if (base === null) {
    return null;
  }
  return kana ? (NAME_KANA_PAIRS.find(([kanji]) => kanji === base)?.[1] ?? null) : base;
};

/** 名前の語で推す種類（推しの順。氏名とメール・電話のほか）。 */
const WORD_INFERENCE_ORDER = Object.freeze([
  'TOTAL_PRICE',
  'UNIT_PRICE',
  'QUANTITY',
  'PARTY_SIZE',
  'PRODUCT_NAME',
  'NOTE',
  'START_TIME',
  'END_TIME',
  'DATE',
] as const satisfies readonly (keyof typeof TEMPLATE_KIND_NAME_WORDS)[]);

/** 型だけで決まる汎用の種類。 */
const genericKindOf = (type: CandidateFieldType): SemanticKind | null =>
  (['GENERIC_NUMBER', 'GENERIC_DATETIME', 'GENERIC_CHOICE', 'GENERIC_COLOR'] as const).find((kind) => isSemanticKindCompatible(kind, type))
    ?? null;

/**
 * 欄の名前・型・autocomplete から意味の種類を推す（純粋）。推せなければ null。外部到達の欄（メール・電話）は外部到達の語の owner の判定で、
 * 合う型（`SEMANTIC_KIND_FIELD_TYPES`）のときだけ。メールと電話の両方に当たる欄は、型が email ならメール、tel なら電話、ほかは推さない
 * （T29R-fix-1 の I-1）。password・file・hidden は推さない。
 */
export const inferSemanticKind = (field: InferenceField): SemanticKind | null => {
  const external = externalDeliveryKindsOf(field);
  // T29R-fix-1（I-1）: メールと電話の両方に当たる欄（`携帯メール`、`tel_mail` など）は、欄の型で決める。型で決まらなければ推さない。
  if (external.includes('EMAIL') && external.includes('PHONE')) {
    return field.type === 'email' ? 'EMAIL' : field.type === 'tel' ? 'PHONE' : null;
  }
  for (const kind of ['EMAIL', 'PHONE'] as const) {
    if (external.includes(kind) && isSemanticKindCompatible(kind, field.type)) {
      return kind;
    }
  }
  const person = personNameKindOf(field);
  if (person !== null) {
    return person;
  }
  const worded = WORD_INFERENCE_ORDER.find((kind) => isSemanticKindCompatible(kind, field.type) && nameHas(field.name, kind));
  return worded ?? genericKindOf(field.type);
};

// ---------------------------------------------------------------------------------------------------------------
// 既定の関係と一意にする欄の組
// ---------------------------------------------------------------------------------------------------------------

/** 意味の種類がちょうど 1 つの欄の名前（なければ、2 つ以上なら null）。 */
const singleFieldOf = (rules: readonly FieldRule[], kind: SemanticKind): string | null => {
  const matches = rules.filter((rule) => rule.semanticKind === kind);
  return matches.length === 1 ? (matches[0]?.fieldName ?? null) : null;
};

/**
 * テンプレートの既定の関係（純粋。凍結）: 開始と終了がちょうど 1 つずつなら終了 > 開始、単価・数量・合計がちょうど 1 つずつなら合計 = 単価 × 数量、
 * 氏名とそのフリガナがちょうど 1 つずつならフリガナは氏名と同じ人（姓・名・フルネームの順）。この順に並べる。
 */
export const defaultRelationsOf = (rules: readonly FieldRule[]): readonly FieldRelation[] => {
  const relations: FieldRelation[] = [];
  const start = singleFieldOf(rules, 'START_TIME');
  const end = singleFieldOf(rules, 'END_TIME');
  if (start !== null && end !== null) {
    relations.push({ kind: 'END_AFTER_START', startFieldName: start, endFieldName: end });
  }
  const unitPrice = singleFieldOf(rules, 'UNIT_PRICE');
  const quantity = singleFieldOf(rules, 'QUANTITY');
  const total = singleFieldOf(rules, 'TOTAL_PRICE');
  if (unitPrice !== null && quantity !== null && total !== null) {
    relations.push({ kind: 'TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY', unitPriceFieldName: unitPrice, quantityFieldName: quantity, totalFieldName: total });
  }
  for (const [nameKind, kanaKind] of NAME_KANA_PAIRS) {
    const name = singleFieldOf(rules, nameKind);
    const kana = singleFieldOf(rules, kanaKind);
    if (name !== null && kana !== null) {
      relations.push({ kind: 'KANA_MATCHES_NAME', nameFieldName: name, kanaFieldName: kana });
    }
  }
  return Object.freeze(relations.map((relation) => Object.freeze(relation)));
};

/** 予約の一意にする欄の意味の種類。 */
const RESERVATION_UNIQUE_KINDS: readonly SemanticKind[] = Object.freeze(['DATE', 'START_TIME', 'GENERIC_CHOICE']);

/**
 * テンプレートの既定の一意にする欄の組（純粋。UTF-16 のコード単位の順。凍結）: 氏名かフリガナの欄があれば、それらすべて（顧客）。なければ商品名の
 * 欄（商品）。なければ日付・開始・選択肢の欄（予約）。どれもなければ空。
 */
export const defaultUniqueKeyFieldNamesOf = (rules: readonly FieldRule[]): readonly string[] => {
  const namesOf = (kinds: readonly SemanticKind[]): string[] =>
    rules.filter((rule) => kinds.includes(rule.semanticKind)).map((rule) => rule.fieldName).sort(compareCodeUnits);
  const groups = [namesOf(PERSON_NAME_KINDS), namesOf(['PRODUCT_NAME']), namesOf(RESERVATION_UNIQUE_KINDS)];
  return Object.freeze(groups.find((group) => group.length > 0) ?? []);
};

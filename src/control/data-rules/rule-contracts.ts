// 入力の規則（規則の集まり）の契約の SSOT（Task 29 の設計書 3 章、4.1。T29a）。
// - 閉じた一覧は `as const` の凍結した配列として 1 回だけ定義し、TypeScript の型はその配列から導く（`scenario-contracts.ts` と同じ方式）。
// - JSON Schema（`schemas/control/data-rule.schema.json`）の enum は、ここの配列と一致する（`tests/unit/schema-enum-consistency.test.ts`）。
//   上限・形・分岐の const は、ここの名前つきの定数と一致する（`tests/unit/data-rule-contracts.test.ts`）。
// - 規則の集まり（RuleSet）はシナリオごとに 1 つ。版ごとに変えない写し（追記だけ。保存は T29d）。欄ごとの規則、欄どうしの関係、一意にする欄の組を
//   持つ。digest は `rule-digest.ts`（Task 28 の入力の規則の参照 `InputRuleReference` の digest）。
// - 判定の理由（`NEEDS_RULE_INPUT`・`RULE_CONFLICT`・`EXTERNAL_DELIVERY_BLOCKED` と細分）は、判定と生成（T29b・T29c）が使う閉じた一覧。
//   保存する文書には入らない（スキーマの enum ではない）。
// - 合成のメールアドレスと電話番号の形（設計書 2 章の判断 1、3 章。2026-10-13 のユーザーの指示）は、ここの名前つきの定数だけで表す。
// - 純粋な定義だけのファイル。管理データ・画面・ブラウザ・ワーカーに触れない（`tests/architecture/data-rules-boundary.test.ts`）。
import {
  MAX_CONSTRAINT_VALUE_LENGTH,
  MAX_FIELD_NAME_LENGTH,
  MAX_OPTION_VALUE_LENGTH,
  MAX_SELECT_OPTION_VALUES,
} from '../../discovery/candidate-contracts.js';
import { MAX_SCENARIO_FIELD_NAMES, MIN_SCENARIO_REVISION, SCENARIO_ID_PATTERN } from '../approval/scenario-contracts.js';
import { foldNfkcCase } from '../../core/text.js';

// ---------------------------------------------------------------------------------------------------------------
// 版の印と閉じた一覧
// ---------------------------------------------------------------------------------------------------------------

/** 規則の集まりの版の文書の形の印（スキーマの `schemaVersion` の const）。 */
export const RULE_SET_SCHEMA_VERSION = 'beaksight-data-rule/1';

/**
 * 欄の意味の種類（閉じた一覧。設計書 4.1。電話を含む）。
 * - 汎用（型と制約から作る）: `GENERIC_NUMBER`（number・range）、`GENERIC_DATETIME`（date・time 系）、`GENERIC_CHOICE`（select・radio・
 *   checkbox）、`GENERIC_COLOR`（color）。
 * - 氏名（辞書から作る。フリガナはカタカナ）: 姓、名、フルネーム、姓のフリガナ、名のフリガナ、フルネームのフリガナ。
 * - `EMAIL`（`example.invalid` の宛先だけ）、`PHONE`（`090-0XXX-XXXX` の形だけ）、`NOTE`（架空の備考の文例）、`PRODUCT_NAME`（商品名）。
 * - 業務の数値と日時: `UNIT_PRICE`（単価）、`QUANTITY`（数量）、`TOTAL_PRICE`（合計）、`DATE`（日付）、`START_TIME`・`END_TIME`（開始・終了の
 *   時刻）、`PARTY_SIZE`（人数）。
 * - `FIXED_LIST`（人の固定の一覧の値だけ）、`OUT_OF_TEMPLATE`（テンプレートの外。人の固定の一覧がなければ作らない）。
 */
export const SEMANTIC_KINDS = Object.freeze([
  'GENERIC_NUMBER',
  'GENERIC_DATETIME',
  'GENERIC_CHOICE',
  'GENERIC_COLOR',
  'FAMILY_NAME',
  'GIVEN_NAME',
  'FULL_NAME',
  'FAMILY_NAME_KANA',
  'GIVEN_NAME_KANA',
  'FULL_NAME_KANA',
  'EMAIL',
  'PHONE',
  'NOTE',
  'PRODUCT_NAME',
  'UNIT_PRICE',
  'QUANTITY',
  'TOTAL_PRICE',
  'DATE',
  'START_TIME',
  'END_TIME',
  'PARTY_SIZE',
  'FIXED_LIST',
  'OUT_OF_TEMPLATE',
] as const);
export type SemanticKind = (typeof SEMANTIC_KINDS)[number];

/**
 * 値の作り方（閉じた一覧。設計書 3 章の規則の優先順位: 汎用の規則 → 業務テンプレート → 人の上書き）。
 * - `FROM_TYPE`: 欄の型と制約から（汎用の規則）。
 * - `FROM_TEMPLATE`: 業務テンプレート（顧客・予約・商品）と辞書から。
 * - `FROM_FIXED_LIST`: 人が入れた固定の値の一覧から（最も強い）。固定の値の一覧は、この作り方のときだけ 1 件以上を持つ。
 */
export const GENERATION_METHODS = Object.freeze(['FROM_TYPE', 'FROM_TEMPLATE', 'FROM_FIXED_LIST'] as const);
export type GenerationMethod = (typeof GENERATION_METHODS)[number];

/** 固定の値の一覧を持つ作り方。 */
export const FIXED_LIST_GENERATION_METHOD = 'FROM_FIXED_LIST' satisfies GenerationMethod;

/**
 * 欄どうしの関係（閉じた一覧。設計書 4.1）。関係ごとに、欄の役割の名前（`FIELD_RELATION_ROLES`）を持つ。
 * - `END_AFTER_START`: 終了 > 開始（日時）。
 * - `TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY`: 合計 = 単価 × 数量。
 * - `KANA_MATCHES_NAME`: フリガナは氏名と同じ人（氏名の欄 1 つとフリガナの欄 1 つの組。姓と名で分かれていれば関係を 2 つ持つ）。
 */
export const FIELD_RELATION_KINDS = Object.freeze([
  'END_AFTER_START',
  'TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY',
  'KANA_MATCHES_NAME',
] as const);
export type FieldRelationKind = (typeof FIELD_RELATION_KINDS)[number];

/** 関係ごとの、欄の役割の鍵（関係の文書の、欄の名前を持つ項目。この順）。 */
export const FIELD_RELATION_ROLES = Object.freeze({
  END_AFTER_START: Object.freeze(['startFieldName', 'endFieldName'] as const),
  TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY: Object.freeze(['unitPriceFieldName', 'quantityFieldName', 'totalFieldName'] as const),
  KANA_MATCHES_NAME: Object.freeze(['nameFieldName', 'kanaFieldName'] as const),
} as const satisfies Readonly<Record<FieldRelationKind, readonly string[]>>);

/**
 * 判定の理由のコード（閉じた一覧。設計書 1 章、3 章、4.1）。
 * - `NEEDS_RULE_INPUT`: 規則が決まらない（推し量らずに止める。人の入力が要る）。
 * - `RULE_CONFLICT`: 決まりがぶつかる（欄の制約と規則、欄どうしの関係、一意性の作り直しの上限、外部到達の欄の「送らない」側がない）。
 * - `EXTERNAL_DELIVERY_BLOCKED`: 外部に届きうる欄（メール・電話）を、シナリオの副作用の確認が済まないので作らない。
 */
export const RULE_PROBLEM_CODES = Object.freeze(['NEEDS_RULE_INPUT', 'RULE_CONFLICT', 'EXTERNAL_DELIVERY_BLOCKED'] as const);
export type RuleProblemCode = (typeof RULE_PROBLEM_CODES)[number];

/**
 * `NEEDS_RULE_INPUT` の細分（閉じた一覧）。
 * - `NO_RULE`: 送る欄に規則がない。
 * - `REQUIRED_FIELD_NOT_SELECTED`: required の欄が送る欄に選ばれていない。
 * - `SEMANTIC_KIND_UNDECIDED`: text・search・textarea などで、意味の種類が決まらない。
 * - `PATTERN_UNSUPPORTED`: pattern が単純な形（数字の桁数、英数字の長さ）でない。
 * - `RANGE_MISSING`: 範囲（min・max）のない number・date・time 系。
 * - `RANGE_EMPTY`: 範囲の min が max を超える（T29c。T29b の汎用の規則の理由）。
 * - `CONSTRAINT_UNSUPPORTED`: min・max・step が扱える形でない（`any`、指数の表記、0 以下の step、ありえない日時、値の数が多すぎる。T29c。T29b の
 *   汎用の規則の理由）。
 * - `LENGTH_UNSATISFIABLE`: minlength・maxlength に合う値を、規則の作り方で作れない。
 * - `NO_USABLE_OPTION`: 選択肢の値から使える値がない（空の値と危険な語・無効化の語（T31a）の値を除いた残りがない）。
 * - `URL_FIELD`: url の欄（作らない）。
 * - `ADDRESS_FIELD`: 住所の欄（人の値だけ）。
 * - `PHONE_FORMAT_UNSUPPORTED`: 電話の欄の制約に、`090-0XXX-XXXX` の形もハイフンなしの形も合わない（ほかの形に切り替えない）。
 */
export const NEEDS_RULE_INPUT_DETAILS = Object.freeze([
  'NO_RULE',
  'REQUIRED_FIELD_NOT_SELECTED',
  'SEMANTIC_KIND_UNDECIDED',
  'PATTERN_UNSUPPORTED',
  'RANGE_MISSING',
  'RANGE_EMPTY',
  'CONSTRAINT_UNSUPPORTED',
  'LENGTH_UNSATISFIABLE',
  'NO_USABLE_OPTION',
  'URL_FIELD',
  'ADDRESS_FIELD',
  'PHONE_FORMAT_UNSUPPORTED',
] as const);
export type NeedsRuleInputDetail = (typeof NEEDS_RULE_INPUT_DETAILS)[number];

/**
 * `RULE_CONFLICT` の細分（閉じた一覧）。
 * - `SEMANTIC_KIND_TYPE_MISMATCH`: 意味の種類が欄の型に合わない（number の欄にメールなど）。
 * - `FIXED_VALUE_VIOLATES_CONSTRAINT`: 人の固定の値が、欄の型・制約・選択肢に合わない。
 * - `RANGE_OUTSIDE_FIELD_CONSTRAINT`: 人の範囲が欄の min・max の外か、min が max を超える。
 * - `RELATION_FIELD_MISMATCH`: 欄どうしの関係の欄が、規則の欄にないか、意味の種類が役割に合わない。
 * - `RELATION_UNSATISFIABLE`: 欄どうしの関係（終了 > 開始、合計 = 単価 × 数量）を、範囲の中で満たせない。
 * - `UNIQUE_COMBINATIONS_EXHAUSTED`: 一意にする欄の組を、作り直しの上限（`MAX_UNIQUE_RETRIES`）の中で、使った組と重ならないように作れない。
 * - `STATE_FIELD_NOT_USABLE`: 状態の欄（`active`・`status`・`deleted` など）に値を入れることになる。
 * - `NOTIFICATION_OPT_OUT_UNAVAILABLE`: 外部到達の欄（通知・SMS・メールの送信を求める欄）で、「送らない」側の値が選べない。
 * - `FIELD_NOT_SENDABLE`: 送る欄が、候補の送れる欄でない（ない、hidden・readonly・disabled、password・file、`_method`。T29c。Task 28 の下書きの
 *   確かめを通った後に候補が変わった場合の備え）。
 */
export const RULE_CONFLICT_DETAILS = Object.freeze([
  'SEMANTIC_KIND_TYPE_MISMATCH',
  'FIXED_VALUE_VIOLATES_CONSTRAINT',
  'RANGE_OUTSIDE_FIELD_CONSTRAINT',
  'RELATION_FIELD_MISMATCH',
  'RELATION_UNSATISFIABLE',
  'UNIQUE_COMBINATIONS_EXHAUSTED',
  'STATE_FIELD_NOT_USABLE',
  'NOTIFICATION_OPT_OUT_UNAVAILABLE',
  'FIELD_NOT_SENDABLE',
] as const);
export type RuleConflictDetail = (typeof RULE_CONFLICT_DETAILS)[number];

/**
 * `EXTERNAL_DELIVERY_BLOCKED` の細分（閉じた一覧）。
 * - `EXTERNAL_NOTIFICATION_UNCONFIRMED`: メール・電話の欄を作るのに要る、シナリオの副作用の確認 `NO_EXTERNAL_NOTIFICATION` が済んでいない。
 */
export const EXTERNAL_DELIVERY_BLOCKED_DETAILS = Object.freeze(['EXTERNAL_NOTIFICATION_UNCONFIRMED'] as const);
export type ExternalDeliveryBlockedDetail = (typeof EXTERNAL_DELIVERY_BLOCKED_DETAILS)[number];

/** 理由のコードごとの細分の一覧（細分は、どの一覧にも 1 回だけ現れる）。 */
export const RULE_PROBLEM_DETAILS = Object.freeze({
  NEEDS_RULE_INPUT: NEEDS_RULE_INPUT_DETAILS,
  RULE_CONFLICT: RULE_CONFLICT_DETAILS,
  EXTERNAL_DELIVERY_BLOCKED: EXTERNAL_DELIVERY_BLOCKED_DETAILS,
} as const satisfies Readonly<Record<RuleProblemCode, readonly string[]>>);

/** 判定の理由（コードと、そのコードの細分の組）。 */
export type RuleProblem =
  | { readonly code: 'NEEDS_RULE_INPUT'; readonly detail: NeedsRuleInputDetail }
  | { readonly code: 'RULE_CONFLICT'; readonly detail: RuleConflictDetail }
  | { readonly code: 'EXTERNAL_DELIVERY_BLOCKED'; readonly detail: ExternalDeliveryBlockedDetail };

/** 欄 1 つの判定の理由（欄の名前と、理由のコードと細分。生成の結果と、実行の許可の発行の拒否に添える。T29d）。 */
export interface FieldRuleProblem {
  readonly fieldName: string;
  readonly problem: RuleProblem;
}

/** 欄ごとの判定の状態（閉じた一覧。補完の画面の状態）。`DECIDED` は規則が決まった欄、ほかは判定の理由のコード。 */
export const FIELD_RULE_STATUSES = Object.freeze(['DECIDED', ...RULE_PROBLEM_CODES] as const);
export type FieldRuleStatus = (typeof FIELD_RULE_STATUSES)[number];

/**
 * 欄の規則の出どころ（閉じた一覧。設計書 3 章の規則の優先順位。T29c）。
 * - `HUMAN`: 規則の集まりに保存した規則（人の上書き。最も強い）。
 * - `TEMPLATE`: 業務テンプレートが欄の名前・型・autocomplete から推した規則。
 * - `GENERIC`: 汎用の規則（欄の型と制約）。
 * - `OPT_OUT`: 通知・配信を求める欄を「送らない」側に固定した（規則の集まりの規則に依らない）。
 */
export const RULE_SOURCES = Object.freeze(['HUMAN', 'TEMPLATE', 'GENERIC', 'OPT_OUT'] as const);
export type RuleSource = (typeof RULE_SOURCES)[number];

// ---------------------------------------------------------------------------------------------------------------
// 上限
// ---------------------------------------------------------------------------------------------------------------

/** 欄ごとの規則の最大の件数（送る欄の名前の最大の件数と同じ）。 */
export const MAX_FIELD_RULES = MAX_SCENARIO_FIELD_NAMES;

/** 欄どうしの関係の最大の件数（欄ごとの規則の最大の件数と同じ）。 */
export const MAX_FIELD_RELATIONS = MAX_SCENARIO_FIELD_NAMES;

/** 一意にする欄の組の、欄の最大の件数（欄ごとの規則の最大の件数と同じ）。 */
export const MAX_UNIQUE_KEY_FIELDS = MAX_SCENARIO_FIELD_NAMES;

/** 人の固定の値の一覧の最大の件数（発見の選択肢の値の最大の件数と同じ）。 */
export const MAX_FIXED_VALUES = MAX_SELECT_OPTION_VALUES;

/** 人の固定の値 1 つの最大長（UTF-16 のコード単位。発見の選択肢の値 1 つの最大長と同じ）。 */
export const MAX_FIXED_VALUE_LENGTH = MAX_OPTION_VALUE_LENGTH;

/** 範囲（min・max・step）の値 1 つの最大長（UTF-16 のコード単位。欄の制約の属性の値の最大長と同じ）。 */
export const MAX_RULE_RANGE_VALUE_LENGTH = MAX_CONSTRAINT_VALUE_LENGTH;

/** 一意にする欄の組が、使った組とぶつかったときの、決定的な作り直しの最大の回数（超えれば `UNIQUE_COMBINATIONS_EXHAUSTED`）。 */
export const MAX_UNIQUE_RETRIES = 32;

/** 規則の集まりの版の最小（シナリオの版と同じ）。 */
export const MIN_RULE_SET_REVISION = MIN_SCENARIO_REVISION;

/** 規則の集まりの id とシナリオの id の形（Task 28 の入力の規則の参照と同じ形）。 */
export const RULE_SET_ID_PATTERN = SCENARIO_ID_PATTERN;

/** 欄の名前の最大長（発見の候補の欄の名前と同じ）。 */
export const MAX_RULE_FIELD_NAME_LENGTH = MAX_FIELD_NAME_LENGTH;

// ---------------------------------------------------------------------------------------------------------------
// 合成のメールアドレスと電話番号の形（設計書 2 章の判断 1、3 章）
// ---------------------------------------------------------------------------------------------------------------

/** 合成のメールアドレスのドメイン（配送されない予約のドメイン。RFC 2606 の `.invalid`）。局所部は合成の値。 */
export const SYNTHETIC_EMAIL_DOMAIN = 'example.invalid';

/** 合成のメールアドレスの区切り。 */
export const EMAIL_LOCAL_PART_SEPARATOR = '@';

/**
 * 合成の電話番号の形（閉じた一覧。2026-10-13 のユーザーの指示）。
 * - `HYPHENATED`: `090-0XXX-XXXX`（`090` の直後が `0`。通常の携帯電話番号として割り当てられていない形）。
 * - `COMPACT`: ハイフンなしの `0900XXXXXXX`（11 桁）。欄の pattern・maxlength がハイフンを許さないときだけ。
 * どちらも欄の制約に合わなければ、ほかの形に切り替えずに `PHONE_FORMAT_UNSUPPORTED`。
 */
export const SYNTHETIC_PHONE_FORMATS = Object.freeze(['HYPHENATED', 'COMPACT'] as const);
export type SyntheticPhoneFormat = (typeof SYNTHETIC_PHONE_FORMATS)[number];

/** 合成の電話番号の、決定的に作る桁の数（`XXX-XXXX` の 7 桁）。 */
export const SYNTHETIC_PHONE_VARIABLE_DIGITS = 7;

/** ハイフンつきの形の、作る桁の前半（`XXX`）の桁の数。 */
export const SYNTHETIC_PHONE_MIDDLE_DIGITS = 3;

/** 合成の電話番号の形ごとの、固定の頭（作る桁の前）。 */
export const SYNTHETIC_PHONE_PREFIXES = Object.freeze({
  HYPHENATED: '090-0',
  COMPACT: '0900',
} as const satisfies Readonly<Record<SyntheticPhoneFormat, string>>);

/** 合成の電話番号の、ハイフンつきの形の区切り。 */
export const PHONE_NUMBER_SEPARATOR = '-';

/** 合成の電話番号の形ごとの、値の全体の形。 */
export const SYNTHETIC_PHONE_PATTERNS = Object.freeze({
  HYPHENATED: /^090-0[0-9]{3}-[0-9]{4}$/u,
  COMPACT: /^0900[0-9]{7}$/u,
} as const satisfies Readonly<Record<SyntheticPhoneFormat, RegExp>>);

/** 合成のメールアドレスの局所部の形（ASCII の小文字・数字と、`.`・`_`・`-`。英数字で始まり、英数字で終わる。64 文字まで）。 */
export const SYNTHETIC_EMAIL_LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;

/** 合成のメールアドレスの局所部の頭（人を指さない語。T29c）。 */
export const SYNTHETIC_EMAIL_LOCAL_PREFIX = 'sample';

/** 合成のメールアドレスの局所部の、決定的に作る数字の桁の数（T29c）。 */
export const SYNTHETIC_EMAIL_LOCAL_DIGITS = 10;

/** 10 進の桁の数から、作る数の上限（`10^digits - 1`）。 */
const DECIMAL_RADIX = 10;
export const maxNumberOfDigits = (digits: number): number => DECIMAL_RADIX ** digits - 1;

/** 合成のメールアドレス（`sample` と `SYNTHETIC_EMAIL_LOCAL_DIGITS` 桁の数字の局所部と、`example.invalid`。T29c）。 */
export const syntheticEmailAddressOf = (number: number): string =>
  `${SYNTHETIC_EMAIL_LOCAL_PREFIX}${String(number).padStart(SYNTHETIC_EMAIL_LOCAL_DIGITS, '0')}${EMAIL_LOCAL_PART_SEPARATOR}${SYNTHETIC_EMAIL_DOMAIN}`;

/** 合成の電話番号（形ごとの固定の頭と、`SYNTHETIC_PHONE_VARIABLE_DIGITS` 桁の数字。ハイフンつきの形は 3 桁と 4 桁に分ける。T29c）。 */
export const syntheticPhoneNumberOf = (format: SyntheticPhoneFormat, number: number): string => {
  const digits = String(number).padStart(SYNTHETIC_PHONE_VARIABLE_DIGITS, '0');
  return format === 'HYPHENATED'
    ? `${SYNTHETIC_PHONE_PREFIXES.HYPHENATED}${digits.slice(0, SYNTHETIC_PHONE_MIDDLE_DIGITS)}${PHONE_NUMBER_SEPARATOR}`
      + digits.slice(SYNTHETIC_PHONE_MIDDLE_DIGITS)
    : `${SYNTHETIC_PHONE_PREFIXES.COMPACT}${digits}`;
};

/** 電話番号の数字だけ（使った番号と重ならないことを、形によらずに比べる。T29c）。 */
export const phoneNumberDigitsOf = (value: string): string => foldNfkcCase(value).replace(/[^0-9]/gu, '');

/** 合成の電話番号の形（`SYNTHETIC_PHONE_PATTERNS` のどれか）か。当たる形を返す（当たらなければ null）。 */
export const syntheticPhoneFormatOf = (value: string): SyntheticPhoneFormat | null =>
  SYNTHETIC_PHONE_FORMATS.find((format) => SYNTHETIC_PHONE_PATTERNS[format].test(value)) ?? null;

/** 合成のメールアドレスの形（局所部の形と、ドメインがちょうど `SYNTHETIC_EMAIL_DOMAIN`）か。 */
export const isSyntheticEmailAddress = (value: string): boolean => {
  const separator = value.lastIndexOf(EMAIL_LOCAL_PART_SEPARATOR);
  return separator > 0
    && value.slice(separator + EMAIL_LOCAL_PART_SEPARATOR.length) === SYNTHETIC_EMAIL_DOMAIN
    && SYNTHETIC_EMAIL_LOCAL_PART_PATTERN.test(value.slice(0, separator));
};

// ---------------------------------------------------------------------------------------------------------------
// 形
// ---------------------------------------------------------------------------------------------------------------

/**
 * 範囲（属性の文字列と同じ形。number は数、date・time 系は HTML の値の形）。項目がなければ null。欄の min・max・step と人の範囲の
 * どちらにも使う（解釈と確かめは T29b・T29c）。
 */
export interface RuleRange {
  readonly min: string | null;
  readonly max: string | null;
  readonly step: string | null;
}

/** 欄の規則 1 件（`schemas/control/data-rule.schema.json` の `fieldRule`）。 */
export interface FieldRule {
  /** 欄の名前（規則の集まりの中で重ならない）。 */
  readonly fieldName: string;
  readonly semanticKind: SemanticKind;
  readonly method: GenerationMethod;
  /** 人の範囲（なければ null。欄の min・max・step の中だけ）。 */
  readonly range: RuleRange | null;
  /**
   * 人の固定の値の一覧（`FROM_FIXED_LIST` のときだけ 1〜`MAX_FIXED_VALUES` 件、ほかは空。重ならない）。並びは意味を持つ（digest でも並べ
   * 替えない）。管理データに平文で残る（設計書 10 章の 4。秘密に見える名前の欄は拒む。確かめは T29c・T29d）。
   */
  readonly fixedValues: readonly string[];
}

/** 欄どうしの関係 1 件（`schemas/control/data-rule.schema.json` の `relation` の分岐）。 */
export type FieldRelation =
  | { readonly kind: 'END_AFTER_START'; readonly startFieldName: string; readonly endFieldName: string }
  | {
    readonly kind: 'TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY';
    readonly unitPriceFieldName: string;
    readonly quantityFieldName: string;
    readonly totalFieldName: string;
  }
  | { readonly kind: 'KANA_MATCHES_NAME'; readonly nameFieldName: string; readonly kanaFieldName: string };

/** 関係の欄の名前（役割の順。`FIELD_RELATION_ROLES[relation.kind]` と同じ並び）。役割の項目を引くのは、この関数だけ。 */
export const relationFieldNamesOf = (relation: FieldRelation): readonly string[] => {
  const roles = relation as unknown as Readonly<Record<string, string | undefined>>;
  return Object.freeze(FIELD_RELATION_ROLES[relation.kind].map((role) => roles[role] ?? ''));
};

/** 規則の集まりの中身（人が補完の画面で決める。id・版・時刻は保存の部品が足す）。 */
export interface RuleSetContent {
  /** 欄ごとの規則（欄の名前は重ならない）。 */
  readonly fieldRules: readonly FieldRule[];
  /** 欄どうしの関係（関係の欄は、欄ごとの規則の欄）。 */
  readonly relations: readonly FieldRelation[];
  /** 一意にする欄の組（重ならない。欄ごとの規則の欄。空なら業務テンプレートの既定の組（T29c の `defaultUniqueKeyFieldNamesOf`）を使う）。 */
  readonly uniqueKeyFieldNames: readonly string[];
}

/** 規則の集まりの版 1 つ（変えない写し。`schemas/control/data-rule.schema.json` の形。日時は UTC の 14 桁）。 */
export interface RuleSetRevision extends RuleSetContent {
  readonly schemaVersion: typeof RULE_SET_SCHEMA_VERSION;
  readonly ruleSetId: string;
  readonly scenarioId: string;
  readonly revision: number;
  readonly createdAt: string;
}

// T29c（Task 29 の設計書 3 章の業務テンプレート、4.2）: 業務テンプレート（`src/control/data-rules/business-templates.ts`）の検査。
// - 欄の名前・type・autocomplete から意味の種類を推す表（日本語を含む）。推せなければ null（判定で `SEMANTIC_KIND_UNDECIDED`）。
// - 語の一覧: 凍結、比べる形、重なり。意味の種類と欄の型の合う組み合わせ。テンプレートの既定の範囲・関係・一意にする欄の組。
// 例の値は匿名の欄の名前だけ。
import { describe, expect, it } from 'vitest';
import {
  BUSINESS_TEMPLATES,
  SEMANTIC_KIND_FIELD_TYPES,
  TEMPLATE_DEFAULT_RANGES,
  TEMPLATE_KIND_NAME_WORDS,
  TEMPLATE_SEMANTIC_KINDS,
  defaultRelationsOf,
  defaultUniqueKeyFieldNamesOf,
  inferSemanticKind,
  isSemanticKindCompatible,
} from '../../src/control/data-rules/business-templates.js';
import { SEMANTIC_KINDS, type SemanticKind } from '../../src/control/data-rules/rule-contracts.js';
import { foldNfkcCase } from '../../src/core/text.js';
import type { CandidateFieldType } from '../../src/discovery/candidate-contracts.js';
import { NO_CONSTRAINTS } from './discovery-candidate-samples.js';
import { sampleFieldRule } from './data-rule-samples.js';

const fieldOf = (name: string, type: CandidateFieldType = 'text', autocomplete: string | null = null) =>
  ({ name, type, constraints: { ...NO_CONSTRAINTS, autocomplete } });

describe('business templates: the closed lists (T29c)', () => {
  it('has the three templates and their semantic kinds', () => {
    expect(BUSINESS_TEMPLATES).toEqual(['CUSTOMER', 'RESERVATION', 'PRODUCT']);
    expect(TEMPLATE_SEMANTIC_KINDS.CUSTOMER).toEqual(['FAMILY_NAME', 'GIVEN_NAME', 'FULL_NAME', 'FAMILY_NAME_KANA', 'GIVEN_NAME_KANA',
      'FULL_NAME_KANA', 'EMAIL', 'PHONE', 'NOTE']);
    expect(TEMPLATE_SEMANTIC_KINDS.RESERVATION).toEqual(['DATE', 'START_TIME', 'END_TIME', 'PARTY_SIZE', 'GENERIC_CHOICE']);
    expect(TEMPLATE_SEMANTIC_KINDS.PRODUCT).toEqual(['PRODUCT_NAME', 'UNIT_PRICE', 'QUANTITY', 'TOTAL_PRICE']);
  });

  it('keeps the word lists frozen, folded and without a word under two kinds', () => {
    expect(Object.isFrozen(TEMPLATE_KIND_NAME_WORDS)).toBe(true);
    const all: string[] = [];
    for (const words of Object.values(TEMPLATE_KIND_NAME_WORDS)) {
      expect(Object.isFrozen(words)).toBe(true);
      for (const word of words) {
        expect(foldNfkcCase(word), word).toBe(word);
        all.push(word);
      }
    }
    expect(new Set(all).size).toBe(all.length);
  });

  it('gives every semantic kind its field types', () => {
    expect(Object.keys(SEMANTIC_KIND_FIELD_TYPES).sort()).toEqual([...SEMANTIC_KINDS].sort());
    expect(isSemanticKindCompatible('EMAIL', 'email')).toBe(true);
    expect(isSemanticKindCompatible('EMAIL', 'number')).toBe(false);
    expect(isSemanticKindCompatible('FULL_NAME', 'textarea')).toBe(true);
    expect(isSemanticKindCompatible('QUANTITY', 'number')).toBe(true);
    expect(isSemanticKindCompatible('START_TIME', 'time')).toBe(true);
    expect(isSemanticKindCompatible('START_TIME', 'text')).toBe(false);
    expect(isSemanticKindCompatible('GENERIC_COLOR', 'color')).toBe(true);
    expect(isSemanticKindCompatible('FIXED_LIST', 'url')).toBe(true);
    for (const kind of SEMANTIC_KINDS) {
      expect(isSemanticKindCompatible(kind, 'password'), kind).toBe(false);
      expect(isSemanticKindCompatible(kind, 'file'), kind).toBe(false);
      expect(isSemanticKindCompatible(kind, 'hidden'), kind).toBe(false);
    }
  });

  it('has named default ranges only for counts and prices (no dates or times)', () => {
    expect(Object.keys(TEMPLATE_DEFAULT_RANGES).sort()).toEqual(['PARTY_SIZE', 'QUANTITY', 'UNIT_PRICE']);
    for (const range of Object.values(TEMPLATE_DEFAULT_RANGES)) {
      expect(Number(range.min)).toBeLessThanOrEqual(Number(range.max));
    }
  });
});

describe('business templates: semantic kind inference (T29c)', () => {
  it.each<readonly [string, ReturnType<typeof fieldOf>, SemanticKind | null]>([
    // 氏名
    ['last_name', fieldOf('last_name'), 'FAMILY_NAME'],
    ['familyName', fieldOf('familyName'), 'FAMILY_NAME'],
    ['sei', fieldOf('sei'), 'FAMILY_NAME'],
    ['姓', fieldOf('姓'), 'FAMILY_NAME'],
    ['first_name', fieldOf('first_name'), 'GIVEN_NAME'],
    ['名', fieldOf('名'), 'GIVEN_NAME'],
    ['name', fieldOf('name'), 'FULL_NAME'],
    ['customer_name', fieldOf('customer_name'), 'FULL_NAME'],
    ['氏名', fieldOf('氏名'), 'FULL_NAME'],
    ['お名前', fieldOf('お名前'), 'FULL_NAME'],
    ['autocomplete name', fieldOf('x', 'text', 'name'), 'FULL_NAME'],
    ['autocomplete family-name', fieldOf('x', 'text', 'family-name'), 'FAMILY_NAME'],
    ['autocomplete given-name', fieldOf('x', 'text', 'section-a given-name'), 'GIVEN_NAME'],
    // フリガナ
    ['name_kana', fieldOf('name_kana'), 'FULL_NAME_KANA'],
    ['sei_kana', fieldOf('sei_kana'), 'FAMILY_NAME_KANA'],
    ['firstNameKana', fieldOf('firstNameKana'), 'GIVEN_NAME_KANA'],
    ['furigana', fieldOf('furigana'), 'FULL_NAME_KANA'],
    ['フリガナ', fieldOf('フリガナ'), 'FULL_NAME_KANA'],
    ['セイ', fieldOf('セイ'), 'FAMILY_NAME_KANA'],
    ['メイ', fieldOf('メイ'), 'GIVEN_NAME_KANA'],
    // 人の名前でない名前
    ['company_name', fieldOf('company_name'), null],
    ['user_name', fieldOf('user_name'), null],
    ['会社名', fieldOf('会社名'), null],
    ['autocomplete organization', fieldOf('x', 'text', 'organization'), null],
    // メールと電話（外部到達の語の owner の判定）
    ['email', fieldOf('email', 'email'), 'EMAIL'],
    ['mail on text', fieldOf('mail'), 'EMAIL'],
    ['tel', fieldOf('tel', 'tel'), 'PHONE'],
    ['電話番号', fieldOf('電話番号'), 'PHONE'],
    // 備考
    ['note', fieldOf('note', 'textarea'), 'NOTE'],
    ['comment', fieldOf('comment'), 'NOTE'],
    ['備考', fieldOf('備考', 'textarea'), 'NOTE'],
    // 商品
    ['product_name', fieldOf('product_name'), 'PRODUCT_NAME'],
    ['商品名', fieldOf('商品名'), 'PRODUCT_NAME'],
    ['price', fieldOf('price', 'number'), 'UNIT_PRICE'],
    ['unit_price', fieldOf('unit_price', 'number'), 'UNIT_PRICE'],
    ['単価', fieldOf('単価', 'number'), 'UNIT_PRICE'],
    ['total', fieldOf('total', 'number'), 'TOTAL_PRICE'],
    ['total_price', fieldOf('total_price', 'number'), 'TOTAL_PRICE'],
    ['合計', fieldOf('合計', 'text'), 'TOTAL_PRICE'],
    ['quantity', fieldOf('quantity', 'number'), 'QUANTITY'],
    ['qty on a select', fieldOf('qty', 'select-one'), 'QUANTITY'],
    ['数量', fieldOf('数量', 'number'), 'QUANTITY'],
    // 予約
    ['reservation date', fieldOf('reservation_date', 'date'), 'DATE'],
    ['予約日', fieldOf('予約日', 'date'), 'DATE'],
    ['start_time', fieldOf('start_time', 'time'), 'START_TIME'],
    ['end_time', fieldOf('end_time', 'time'), 'END_TIME'],
    ['開始時刻', fieldOf('開始時刻', 'time'), 'START_TIME'],
    ['終了時刻', fieldOf('終了時刻', 'select-one'), 'END_TIME'],
    ['start on a text field', fieldOf('start_time', 'text'), null],
    ['guests', fieldOf('guests', 'number'), 'PARTY_SIZE'],
    ['人数', fieldOf('人数', 'select-one'), 'PARTY_SIZE'],
    // 汎用（型から）
    ['a plain number', fieldOf('level', 'number'), 'GENERIC_NUMBER'],
    ['a plain range', fieldOf('level', 'range'), 'GENERIC_NUMBER'],
    ['a plain date', fieldOf('when', 'date'), 'GENERIC_DATETIME'],
    ['a plain color', fieldOf('theme', 'color'), 'GENERIC_COLOR'],
    ['a plain select', fieldOf('course', 'select-one'), 'GENERIC_CHOICE'],
    ['a plain checkbox', fieldOf('agree', 'checkbox'), 'GENERIC_CHOICE'],
    // 推せない
    ['a plain text', fieldOf('code_x'), null],
    ['a plain textarea', fieldOf('body', 'textarea'), null],
    ['a url', fieldOf('website', 'url'), null],
    ['a password', fieldOf('name', 'password'), null],
    ['a file', fieldOf('note', 'file'), null],
    ['a hidden', fieldOf('name', 'hidden'), null],
  ])('infers %s', (_label, field, kind) => {
    expect(inferSemanticKind(field)).toBe(kind);
  });
});

describe('business templates: default relations and unique keys (T29c)', () => {
  it('relates one start with one end, unit price, quantity and total, and each name with its kana', () => {
    const rules = [
      sampleFieldRule('s', { semanticKind: 'START_TIME' }),
      sampleFieldRule('e', { semanticKind: 'END_TIME' }),
      sampleFieldRule('p', { semanticKind: 'UNIT_PRICE' }),
      sampleFieldRule('q', { semanticKind: 'QUANTITY' }),
      sampleFieldRule('t', { semanticKind: 'TOTAL_PRICE' }),
      sampleFieldRule('fn', { semanticKind: 'FAMILY_NAME' }),
      sampleFieldRule('fk', { semanticKind: 'FAMILY_NAME_KANA' }),
      sampleFieldRule('gn', { semanticKind: 'GIVEN_NAME' }),
    ];
    expect(defaultRelationsOf(rules)).toEqual([
      { kind: 'END_AFTER_START', startFieldName: 's', endFieldName: 'e' },
      { kind: 'TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY', unitPriceFieldName: 'p', quantityFieldName: 'q', totalFieldName: 't' },
      { kind: 'KANA_MATCHES_NAME', nameFieldName: 'fn', kanaFieldName: 'fk' },
    ]);
    // 2 つ以上あれば推さない（どれとどれの関係か決まらない）。
    expect(defaultRelationsOf([...rules, sampleFieldRule('s2', { semanticKind: 'START_TIME' })])
      .some((relation) => relation.kind === 'END_AFTER_START')).toBe(false);
  });

  it('uses the names for a customer, the product name for a product, and the date, start and choices for a reservation', () => {
    expect(defaultUniqueKeyFieldNamesOf([
      sampleFieldRule('name', { semanticKind: 'FULL_NAME' }),
      sampleFieldRule('kana', { semanticKind: 'FULL_NAME_KANA' }),
      sampleFieldRule('mail', { semanticKind: 'EMAIL' }),
    ])).toEqual(['kana', 'name']);
    expect(defaultUniqueKeyFieldNamesOf([
      sampleFieldRule('item', { semanticKind: 'PRODUCT_NAME' }),
      sampleFieldRule('price', { semanticKind: 'UNIT_PRICE' }),
    ])).toEqual(['item']);
    expect(defaultUniqueKeyFieldNamesOf([
      sampleFieldRule('day', { semanticKind: 'DATE' }),
      sampleFieldRule('from', { semanticKind: 'START_TIME' }),
      sampleFieldRule('to', { semanticKind: 'END_TIME' }),
      sampleFieldRule('course', { semanticKind: 'GENERIC_CHOICE' }),
    ])).toEqual(['course', 'day', 'from']);
    expect(defaultUniqueKeyFieldNamesOf([sampleFieldRule('level')])).toEqual([]);
  });
});

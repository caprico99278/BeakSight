// 入力の規則の小さな辞書の読み込み（Task 29 の設計書 2 章の判断 3、3 章の辞書、5 章。T29b）。辞書の owner は、このフォルダ。
// - 辞書のデータは、同じフォルダの JSON（姓・名とそのフリガナ、架空の備考の文例、商品名）。実在の人や会社を指さない、ありふれた語だけを置く。
//   危険な語・秘密に見える語・外部到達の語に当たらないこと、件数、重なり、文字の種類は `tests/unit/data-rules-dictionaries.test.ts` で固定する。
// - JSON は import の属性（`with { type: 'json' }`）で読む。`tsc` の build は、import した JSON を `dist/` の同じ場所に書き出す（`schemas/` の
//   ような写しの手順は要らない）。
// - 読み込みの時に、形（文字列、空でない、姓・名は `name` と `kana` の組）と件数（`DICTIONARY_SIZE_LIMITS`）を確かめ、凍結した写しを公開する
//   （形が崩れていれば、読み込みの時に `TypeError` で止める）。
// - 辞書の語は照らすためのデータで、利用者に見せる文言のカタログではない（生成した値として送る。表示の文言は表示のカタログ）。
// - T29R-fix-1（M-8）: 著名人と同じ姓名になりやすい組を、生成で選ばない組の閉じた一覧（`avoided-person-names.json`）に置く。組の姓と名は、
//   それぞれ姓・名の辞書にある語（ない語の組は意味を持たないので、読み込みの時に `TypeError` で止める）。
import avoidedPersonNamesData from './avoided-person-names.json' with { type: 'json' };
import familyNamesData from './family-names.json' with { type: 'json' };
import givenNamesData from './given-names.json' with { type: 'json' };
import productNamesData from './product-names.json' with { type: 'json' };
import remarkPhrasesData from './remark-phrases.json' with { type: 'json' };
import { isRecord } from '../../../core/guards.js';

/** 姓か名と、そのフリガナ（カタカナ）。 */
export interface NameEntry {
  readonly name: string;
  readonly kana: string;
}

/** 辞書の件数の範囲（設計書 3 章: 姓・名は各 30〜50 件、備考の文例と商品名は各 10〜20 件）。 */
export const DICTIONARY_SIZE_LIMITS = Object.freeze({
  names: Object.freeze({ min: 30, max: 50 }),
  phrases: Object.freeze({ min: 10, max: 20 }),
});

type SizeLimit = (typeof DICTIONARY_SIZE_LIMITS)[keyof typeof DICTIONARY_SIZE_LIMITS];

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const checkedSize = <T>(label: string, items: readonly T[], limit: SizeLimit): readonly T[] => {
  if (items.length < limit.min || items.length > limit.max) {
    throw new TypeError(`${label} dictionary must have ${limit.min} to ${limit.max} entries`);
  }
  return Object.freeze(items);
};

const nameEntriesOf = (label: string, data: unknown): readonly NameEntry[] => {
  if (!Array.isArray(data)) {
    throw new TypeError(`${label} dictionary must be an array`);
  }
  const entries = data.map((entry: unknown) => {
    if (!isRecord(entry) || !isNonEmptyString(entry.name) || !isNonEmptyString(entry.kana)) {
      throw new TypeError(`${label} dictionary entries must have a name and its kana`);
    }
    return Object.freeze({ name: entry.name, kana: entry.kana });
  });
  return checkedSize(label, entries, DICTIONARY_SIZE_LIMITS.names);
};

const phrasesOf = (label: string, data: unknown): readonly string[] => {
  if (!Array.isArray(data) || !data.every(isNonEmptyString)) {
    throw new TypeError(`${label} dictionary must be an array of non-empty strings`);
  }
  return checkedSize(label, [...data], DICTIONARY_SIZE_LIMITS.phrases);
};

/** 姓（ありふれたもの）とそのフリガナ。 */
export const FAMILY_NAMES: readonly NameEntry[] = nameEntriesOf('family name', familyNamesData);
/** 名（ありふれたもの）とそのフリガナ。 */
export const GIVEN_NAMES: readonly NameEntry[] = nameEntriesOf('given name', givenNamesData);
/** 架空の備考の短い文例。 */
export const REMARK_PHRASES: readonly string[] = phrasesOf('remark', remarkPhrasesData);
/** 商品名（一般名詞）。 */
export const PRODUCT_NAMES: readonly string[] = phrasesOf('product', productNamesData);

/** 生成で選ばない姓と名の組（著名人と同じ姓名になりやすい組。T29R-fix-1 の M-8）。 */
export interface AvoidedPersonNamePair {
  readonly family: string;
  readonly given: string;
}

const avoidedPairsOf = (data: unknown): readonly AvoidedPersonNamePair[] => {
  if (!Array.isArray(data)) {
    throw new TypeError('avoided person name pairs must be an array');
  }
  const families = new Set(FAMILY_NAMES.map((entry) => entry.name));
  const givens = new Set(GIVEN_NAMES.map((entry) => entry.name));
  return Object.freeze(data.map((entry: unknown) => {
    if (!isRecord(entry) || !isNonEmptyString(entry.family) || !isNonEmptyString(entry.given)) {
      throw new TypeError('avoided person name pairs must have a family name and a given name');
    }
    if (!families.has(entry.family) || !givens.has(entry.given)) {
      throw new TypeError('avoided person name pairs must refer to the name dictionaries');
    }
    return Object.freeze({ family: entry.family, given: entry.given });
  }));
};

/** 生成で選ばない姓と名の組（閉じた一覧）。 */
export const AVOIDED_PERSON_NAME_PAIRS: readonly AvoidedPersonNamePair[] = avoidedPairsOf(avoidedPersonNamesData);

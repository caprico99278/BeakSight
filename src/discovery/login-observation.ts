// 手動のログイン（と自動ログイン）のログインの段で観察したことの、記録の形と純粋な判定の唯一の owner（Task 43 の設計書 3 章、4.4。T43d）。
// 純粋な部品（`tests/architecture/discovery-boundary.test.ts` の `PURE_DISCOVERY_FILES`）。ページを操作しない・読まない。Guard の止めた一覧
// （`src/safety/login-stage-blocked-requests.ts`）、ワーカー（`src/worker/login-stage-observation.ts`）、IPC の検証（`src/control/worker-protocol.ts`）、
// 画面の登録の案が、同じ定義を使う（書き写さない）。
// - 止めた要求の query（設計書 3 章「query の値は登録の案に入れない。例外は、プロトコルの決まった名前の閉じた一覧（今は `grant_type`）の値だけ」）:
//   名前の一覧（値なし。重ならない名前で数え、上限 `MAX_LOGIN_OBSERVED_QUERY_NAMES`。値に見える名前（`isValueLikeText`）・長すぎる名前・書けない文字を
//   含む名前は伏せた表記 `REDACTED_PATH_SEGMENT` にする）と、一覧に入れなかった名前の数と、閉じた一覧の名前の値（決まった形の短い語だけ。値に見える
//   値、同じ名前が 2 回ある query の値は残さない）。名前の一覧は、値を残した名前を先に入れ、残りを UTF-16 のコード単位の順で入れ、並べて返す。
// - 成功の鍵の名前（設計書 4.4「ローカル ストレージの鍵の名前を、ログインの前と後で比べ、新しく出た名前を記録する（値は読まない）」）: 始めになく
//   終わりにある名前の、接頭辞と接尾辞の案だけ（T43R-fix の C-1 (a)。名前の全体は残さない。下の「成功の鍵の名前」）。
// - 成功の画面のセレクタ（ユーザーの判断「ログインの後の画面から提案する」）: ログアウトの語に当たる見えるリンクやボタン（`LOGOUT_CONTROL`）の、ログアウトの
//   語を含む属性から作った CSS だけ（T43R-fix の C-1 (b)。下の「成功の画面のセレクタ」）。ログインの画面にもあった CSS は外し、ログインの後の画面で
//   ちょうど 1 つに当たり、読んだ要素を指す最初の CSS を案にする。要素の文字は持たない（ログアウトの語は閉じた一覧の語だけ）。
import { LOGIN_STORAGE_KEY_GENERAL_WORDS } from '../core/secret-query-names.js';
import { compareCodeUnits, foldNfkcCase, hasControlOrLineSeparator, hasLoneSurrogate } from '../core/text.js';
import { REDACTED_PATH_SEGMENT, hasValueLikePathSegment, isValueLikeText } from '../core/url-path-redaction.js';
import { DISCOVERY_LOGOUT_GENERAL_WORDS, DISCOVERY_LOGOUT_WORDS } from './classification-words.js';
import {
  cssIdentifierOf,
  cssStringOf,
  isPlaywrightCssShape,
  uniqueEntrySelectorOf,
  type EntryElementFacts,
  type EntrySelectorCheck,
} from './entry-check-selectors.js';

// ---------------------------------------------------------------------------------------------------------------
// 止めた要求の query
// ---------------------------------------------------------------------------------------------------------------

/** 値を残す query の名前（プロトコルの決まった名前の閉じた一覧。設計書 3 章。ユーザーの確認「query の値は `grant_type` だけ残す」）。 */
export const LOGIN_OBSERVED_QUERY_VALUE_NAMES = Object.freeze(['grant_type'] as const);
export type LoginObservedQueryValueName = (typeof LOGIN_OBSERVED_QUERY_VALUE_NAMES)[number];

/** 1 行の query の名前の上限（認証の設定の必須の query の組の上限 `MAX_SCRIPT_LOGIN_REQUIRED_QUERY` と同じ数）。 */
export const MAX_LOGIN_OBSERVED_QUERY_NAMES = 4;
/** query の名前の最大長（UTF-16 のコード単位。超える名前は伏せる）。 */
export const MAX_LOGIN_OBSERVED_QUERY_NAME_LENGTH = 64;
/** 残す値の最大長（UTF-16 のコード単位。超える値は残さない）。 */
export const MAX_LOGIN_OBSERVED_QUERY_VALUE_LENGTH = 32;
/** 残す値の形（英数字と `_`・`.`・`:`・`-` だけ。プロトコルの決まった語の形）。 */
const QUERY_VALUE_SHAPE = /^[A-Za-z0-9_.:-]+$/u;

/** 残した値 1 つ。 */
export interface LoginObservedQueryValue {
  readonly name: LoginObservedQueryValueName;
  readonly value: string;
}

/** 止めた要求の query の記録（値は閉じた一覧の名前の値だけ）。 */
export interface LoginObservedQuery {
  /** 名前（重ならない。並べてある。値に見える名前は伏せた表記）。 */
  readonly names: readonly string[];
  /** 一覧に入れなかった、重ならない名前の数。 */
  readonly omitted: number;
  readonly values: readonly LoginObservedQueryValue[];
}

/** 名前・値として書ける文字だけか（制御文字・行の区切り・対になっていないサロゲートを含まない）。 */
const isWritable = (text: string): boolean => !hasControlOrLineSeparator(text) && !hasLoneSurrogate(text);

/** 名前を記録の表記にする（伏せる名前は伏せた表記。空の名前は `null`）。 */
const recordedNameOf = (name: string, maxLength: number): string | null => {
  if (name.length === 0) {
    return null;
  }
  return name.length > maxLength || !isWritable(name) || isValueLikeText(name) ? REDACTED_PATH_SEGMENT : name;
};

/** 記録の名前として書ける値か（伏せた表記か、上限の長さまでの、書ける文字だけの、値に見えない名前）。 */
const isRecordedName = (name: string, maxLength: number): boolean =>
  name === REDACTED_PATH_SEGMENT || (name.length > 0 && name.length <= maxLength && isWritable(name) && !isValueLikeText(name));

/** 記録の query の名前として書ける値か（IPC の検証が使う）。 */
export const isLoginObservedQueryName = (name: string): boolean => isRecordedName(name, MAX_LOGIN_OBSERVED_QUERY_NAME_LENGTH);

/** 閉じた一覧の名前か。 */
const isValueName = (name: string): name is LoginObservedQueryValueName =>
  (LOGIN_OBSERVED_QUERY_VALUE_NAMES as readonly string[]).includes(name);

/** 残してよい値か（閉じた一覧の名前で、決まった形の短い語で、値に見えない）。 */
export const isLoginObservedQueryValue = (name: string, value: string): boolean =>
  isValueName(name) && value.length > 0 && value.length <= MAX_LOGIN_OBSERVED_QUERY_VALUE_LENGTH && QUERY_VALUE_SHAPE.test(value) && !isValueLikeText(value);

/** 並べた写し。 */
const sorted = (values: Iterable<string>): string[] => [...values].sort(compareCodeUnits);

/** 上限までの名前（`first` を先に入れ、残りを並べた順で入れる。返す名前は並べる）と、入れなかった数。 */
const cappedNamesOf = (
  names: ReadonlySet<string>,
  first: readonly string[],
  limit: number,
): { readonly names: readonly string[]; readonly omitted: number } => {
  const kept = first.filter((name) => names.has(name)).slice(0, limit);
  for (const name of sorted(names)) {
    if (kept.length >= limit) {
      break;
    }
    if (!kept.includes(name)) {
      kept.push(name);
    }
  }
  return { names: Object.freeze(sorted(kept)), omitted: names.size - kept.length };
};

/** query の記録を組み立てる（名前がなければ `null`）。 */
const queryRecordOf = (names: ReadonlySet<string>, values: readonly LoginObservedQueryValue[], extraOmitted: number): LoginObservedQuery | null => {
  if (names.size === 0) {
    return null;
  }
  const capped = cappedNamesOf(names, values.map(({ name }) => name), MAX_LOGIN_OBSERVED_QUERY_NAMES);
  const kept = values.filter(({ name }) => capped.names.includes(name));
  return Object.freeze({
    names: capped.names,
    omitted: capped.omitted + extraOmitted,
    values: Object.freeze(kept.map((value) => Object.freeze({ ...value }))),
  });
};

/**
 * URL の query の組（`URL` の `searchParams`。decode した名前と値の組）から、記録の query を作る（名前がなければ `null`）。値は閉じた一覧の名前の値
 * だけで、同じ名前が 2 回あれば残さない。query を組み替えない（読むだけ）。
 */
export const loginObservedQueryOf = (parameters: Iterable<readonly [string, string]>): LoginObservedQuery | null => {
  const names = new Set<string>();
  const occurrences = new Map<string, string[]>();
  for (const [name, value] of parameters) {
    const recorded = recordedNameOf(name, MAX_LOGIN_OBSERVED_QUERY_NAME_LENGTH);
    if (recorded === null) {
      continue;
    }
    names.add(recorded);
    occurrences.set(name, [...(occurrences.get(name) ?? []), value]);
  }
  const values: LoginObservedQueryValue[] = [];
  for (const name of LOGIN_OBSERVED_QUERY_VALUE_NAMES) {
    const found = occurrences.get(name);
    const [value] = found ?? [];
    if (found !== undefined && found.length === 1 && value !== undefined && isLoginObservedQueryValue(name, value)) {
      values.push({ name, value });
    }
  }
  return queryRecordOf(names, values, 0);
};

/**
 * 同じ行の 2 つの query の記録を合わせる（名前を足し合わせ、上限と入れなかった数を保つ。値は同じ行なので同じ。前の値を使う）。入れなかった数は、合わせた
 * 名前の上限を超えた数と、前の 2 つの入れなかった数の大きい方の和（下限の目安）。
 */
export const mergeLoginObservedQuery = (previous: LoginObservedQuery | null, next: LoginObservedQuery | null): LoginObservedQuery | null => {
  if (previous === null || next === null) {
    return previous ?? next;
  }
  const names = new Set([...previous.names, ...next.names]);
  return queryRecordOf(names, previous.values.length > 0 ? previous.values : next.values, Math.max(previous.omitted, next.omitted));
};

// ---------------------------------------------------------------------------------------------------------------
// 成功の鍵の名前
// ---------------------------------------------------------------------------------------------------------------

// T43R-fix の C-1 (a)（Task 43 の設計書 7 章の T43R の行）: 鍵の名前の全体は残さない。区切り（`LOGIN_OBSERVED_KEY_SEPARATORS`）で分けた最初の部分と
// 最後の部分だけを、成功の鍵の名前の接頭辞（最初の部分と、その後の区切り）と接尾辞（最後の部分の前の区切りと、最後の部分）の案にする。間の部分（利用者の
// 名前や ID が入りうる）は、記録・IPC・管理データ・画面・下書きのどこにも残さない。
// T43R2-fix（Task 43 の設計書 7 章の最後の行。設計者の既定）: 端の部分にも利用者の名前が入りうるので、端の部分は閉じた一覧の一般の語
// （`src/core/secret-query-names.ts` の `LOGIN_STORAGE_KEY_GENERAL_WORDS`）に当たる側だけを出し、当たらない側は空にする（利用者が入れる。成功の鍵の決まりは
// 接頭辞か接尾辞の片側が空でも受ける）。両側とも当たらない名前、区切りのない名前、当たる端が短すぎる・長すぎる・値に見える・書けない文字を含む名前は、
// 案にしない。

/** 新しく出た鍵の名前の案（接頭辞と接尾辞の組）の上限。 */
export const MAX_LOGIN_OBSERVED_STORAGE_KEY_NAMES = 4;
/** 鍵の名前の区切り（閉じた一覧）。 */
export const LOGIN_OBSERVED_KEY_SEPARATORS = Object.freeze(['.', ':', '_', '/', '-'] as const);
/** 最初と最後の部分の最小の長さ（UTF-16 のコード単位。短すぎる部分は識別にならない）。 */
export const MIN_LOGIN_OBSERVED_KEY_PART_LENGTH = 2;
/** 最初と最後の部分の最大の長さ（UTF-16 のコード単位）。 */
export const MAX_LOGIN_OBSERVED_KEY_PART_LENGTH = 64;
/** 区切りの数の下限（T43R2-fix: 端の部分の一方だけを出せるので 1 つ。区切りが 1 つで両側とも一般の語なら、重ならないよう接尾辞だけ）。 */
const MIN_KEY_SEPARATORS = 1;

/** 成功の鍵の名前の案 1 つ（接頭辞と接尾辞。間の部分は持たない）。 */
export interface LoginObservedStorageKeyShape {
  readonly prefix: string;
  readonly suffix: string;
}

/** 新しく出た鍵の名前の案と、案にしなかった新しい名前の数（区切りが足りない・部分が受けられない・上限を超えた）。 */
export interface LoginObservedStorageKeyShapes {
  readonly shapes: readonly LoginObservedStorageKeyShape[];
  readonly omitted: number;
}

const isKeySeparator = (character: string): boolean => (LOGIN_OBSERVED_KEY_SEPARATORS as readonly string[]).includes(character);

/** 最初か最後の部分として受けるか（区切りを含まず、長さの範囲の中で、書ける文字だけで、値に見えない）。 */
const isKeyPart = (part: string): boolean =>
  part.length >= MIN_LOGIN_OBSERVED_KEY_PART_LENGTH
  && part.length <= MAX_LOGIN_OBSERVED_KEY_PART_LENGTH
  && ![...part].some(isKeySeparator)
  && isWritable(part)
  && !isValueLikeText(part);

/** T43R2-fix: 端の部分が、一般の語（`LOGIN_STORAGE_KEY_GENERAL_WORDS`。NFKC と大文字小文字を畳んだ形の完全一致）か。 */
const GENERAL_KEY_WORDS: ReadonlySet<string> = new Set(LOGIN_STORAGE_KEY_GENERAL_WORDS);
const isGeneralKeyPart = (part: string): boolean => isKeyPart(part) && GENERAL_KEY_WORDS.has(foldNfkcCase(part));

/**
 * 鍵の名前から、接頭辞と接尾辞の案を作る（案にしない名前は `null`）。名前の全体と間の部分は返さない。T43R2-fix: 端の部分が一般の語に当たる側だけを出し、
 * 当たらない側は空にする（利用者が入れる）。両側とも当たらなければ `null`。区切りが 1 つで両側とも当たるときは、接頭辞と接尾辞が区切りを共有して今の成功の
 * 鍵の決まりで受けられないので、接尾辞だけを出す。
 */
export const storageKeyShapeOf = (name: string): LoginObservedStorageKeyShape | null => {
  const characters = [...name];
  const positions = characters.flatMap((character, index) => (isKeySeparator(character) ? [index] : []));
  const first = positions[0];
  const last = positions.at(-1);
  if (positions.length < MIN_KEY_SEPARATORS || first === undefined || last === undefined) {
    return null;
  }
  const head = characters.slice(0, first).join('');
  const tail = characters.slice(last + 1).join('');
  const suffixKept = isGeneralKeyPart(tail);
  const prefixKept = isGeneralKeyPart(head) && !(first === last && suffixKept);
  if (!prefixKept && !suffixKept) {
    return null;
  }
  return Object.freeze({
    prefix: prefixKept ? `${head}${characters[first] ?? ''}` : '',
    suffix: suffixKept ? `${characters[last] ?? ''}${tail}` : '',
  });
};

/**
 * 記録の案として書ける組か（IPC の検証と下書きの読み直しが使う）。どちらかは空でない。空でない接頭辞は一般の語の部分と区切り 1 つ、空でない接尾辞は区切り
 * 1 つと一般の語の部分。
 */
export const isLoginObservedStorageKeyShape = ({ prefix, suffix }: LoginObservedStorageKeyShape): boolean => {
  const prefixCharacters = [...prefix];
  const suffixCharacters = [...suffix];
  const prefixOk = prefix.length === 0
    || (isKeySeparator(prefixCharacters.at(-1) ?? '') && isGeneralKeyPart(prefixCharacters.slice(0, -1).join('')));
  const suffixOk = suffix.length === 0
    || (isKeySeparator(suffixCharacters[0] ?? '') && isGeneralKeyPart(suffixCharacters.slice(1).join('')));
  return (prefix.length > 0 || suffix.length > 0) && prefixOk && suffixOk;
};

/** ログインの段の始めになく、終わりにある鍵の名前の案（案がなければ `null`）。値は受け取らない。 */
export const newStorageKeyShapesOf = (before: readonly string[], after: readonly string[]): LoginObservedStorageKeyShapes | null => {
  const previous = new Set(before);
  const fresh = [...new Set(after)].filter((name) => !previous.has(name));
  const shapes = new Map<string, LoginObservedStorageKeyShape>();
  for (const name of fresh) {
    const shape = storageKeyShapeOf(name);
    if (shape !== null) {
      shapes.set(JSON.stringify([shape.prefix, shape.suffix]), shape);
    }
  }
  if (shapes.size === 0) {
    return null;
  }
  const sortedShapes = [...shapes.values()].sort((left, right) => compareCodeUnits(left.prefix, right.prefix) || compareCodeUnits(left.suffix, right.suffix));
  const kept = sortedShapes.slice(0, MAX_LOGIN_OBSERVED_STORAGE_KEY_NAMES);
  return Object.freeze({ shapes: Object.freeze(kept), omitted: fresh.length - kept.length });
};

// ---------------------------------------------------------------------------------------------------------------
// 成功の画面のセレクタ
// ---------------------------------------------------------------------------------------------------------------

// T43R-fix の C-1 (b)（Task 43 の設計書 7 章の T43R の行）: 案は、ログアウトの語に当たる要素（`LOGOUT_CONTROL`）の、ログアウトの語を含む属性（id・name・
// リンクの href）から作った CSS だけ。属性の値からログアウトの語を除いた残りは、閉じた一覧の一般の語（`DISCOVERY_LOGOUT_GENERAL_WORDS`）と区切りだけで
// あること（利用者の名前や ID が入りうる値を案にしない）。nav・header の中の要素の案はやめた。

/** 成功の画面のセレクタの候補の種類（ログアウトの要素だけ）。 */
export const SUCCESS_SELECTOR_CANDIDATE_KINDS = Object.freeze(['LOGOUT_CONTROL'] as const);
export type SuccessSelectorCandidateKind = (typeof SUCCESS_SELECTOR_CANDIDATE_KINDS)[number];

/** CSS に使うリンクの `href` の最大長。 */
const MAX_SUCCESS_SELECTOR_HREF_LENGTH = 128;
const LINK_TAG = 'a';
const PATH_START = '/';
/** 属性の値を語に分ける区切り（鍵の名前の区切りと空白）。 */
const ATTRIBUTE_WORD_SEPARATORS = /[.:_/\s-]+/u;

/** 1 つの要素の、CSS の組み立てに使う事実（`href` は属性の値そのもの。ないときは空文字列）。 */
export interface SuccessSelectorElementFacts extends EntryElementFacts {
  readonly href: string;
}

/** CSS に使えるリンクの `href` か（`/` で始まり、`//` で始まらず、query・fragment・値に見える区切りのない、短い値）。 */
const isPlainHref = (href: string): boolean =>
  href.startsWith(PATH_START)
  && !href.startsWith(`${PATH_START}${PATH_START}`)
  && href.length <= MAX_SUCCESS_SELECTOR_HREF_LENGTH
  && !href.includes('?')
  && !href.includes('#')
  && isWritable(href)
  && !hasValueLikePathSegment(href);

/** ログアウトの語（長い語を先に除く。`sign-out` を `signout` より先に）。 */
const LOGOUT_WORDS_LONGEST_FIRST: readonly string[] = [...DISCOVERY_LOGOUT_WORDS].sort((left, right) => right.length - left.length);
const GENERAL_WORDS: ReadonlySet<string> = new Set(DISCOVERY_LOGOUT_GENERAL_WORDS);

/**
 * 属性の値が、ログアウトの語を含み、ほかは閉じた一覧の一般の語と区切りだけか（大文字と小文字を区別しない。`logoutButton` は `logout` と `button`）。
 */
export const isLogoutAttributeValue = (value: string): boolean => {
  const lowered = value.toLowerCase();
  if (!LOGOUT_WORDS_LONGEST_FIRST.some((word) => lowered.includes(word))) {
    return false;
  }
  const rest = LOGOUT_WORDS_LONGEST_FIRST.reduce((text, word) => text.split(word).join(' '), lowered);
  return rest.split(ATTRIBUTE_WORD_SEPARATORS).filter((part) => part.length > 0).every((part) => GENERAL_WORDS.has(part));
};

/**
 * ログアウトの要素の候補の CSS（ログアウトの語を含む属性だけ。`#id` → `tag[name="…"]` → リンクの `a[href="…"]`。重ねない）。T43R-fix の M-4: Playwright の
 * `css=` が解釈できない escape（`\`）を含む CSS は作らない。
 */
export const successSelectorCandidatesOf = (facts: SuccessSelectorElementFacts): readonly string[] => {
  const { tag, id, name, href } = facts;
  if (tag.length === 0) {
    return [];
  }
  const element = cssIdentifierOf(tag);
  const candidates = [
    ...(id.length > 0 && isLogoutAttributeValue(id) ? [`#${cssIdentifierOf(id)}`] : []),
    ...(name.length > 0 && isLogoutAttributeValue(name) ? [`${element}[name=${cssStringOf(name)}]`] : []),
    ...(tag === LINK_TAG && isPlainHref(href) && isLogoutAttributeValue(href) ? [`${cssIdentifierOf(LINK_TAG)}[href=${cssStringOf(href)}]`] : []),
  ];
  return [...new Set(candidates)].filter(isPlaywrightCssShape);
};

/** CSS の形から属性の値を取り出す（`#id`・`tag[name="…"]`・`a[href="…"]` の、escape のない形だけ）。 */
const SELECTOR_SHAPES: readonly (readonly [RegExp, boolean])[] = [
  [/^#([A-Za-z_][A-Za-z0-9_-]*)$/u, false],
  [/^[a-z][a-z0-9-]*\[name="([^"\\]*)"\]$/u, false],
  [/^a\[href="([^"\\]*)"\]$/u, true],
];

/** 記録の成功の画面のセレクタの案として書ける CSS か（上の形の 1 つで、属性の値がログアウトの語の値。IPC の検証と下書きの読み直しが使う）。 */
export const isLoginObservedSuccessSelector = (selector: string): boolean =>
  SELECTOR_SHAPES.some(([shape, link]) => {
    const value = shape.exec(selector)?.[1];
    return value !== undefined && isLogoutAttributeValue(value) && (!link || isPlainHref(value));
  });

/** 成功の画面のセレクタの案（要素の文字は持たない。ログアウトの語は閉じた一覧の語）。 */
export interface LoginObservedSuccessSelector {
  readonly selector: string;
  readonly kind: SuccessSelectorCandidateKind;
  /** 当たったログアウトの語（閉じた一覧の語）。 */
  readonly logoutWord: string;
}

/** 案を選ぶための、1 つの候補の要素（語と、候補の CSS をログインの後の画面で数えた結果）。 */
export interface SuccessSelectorCandidateCheck {
  readonly logoutWord: string;
  readonly checks: readonly EntrySelectorCheck[];
}

/**
 * 成功の画面のセレクタの案を選ぶ（なければ `null`）。渡された順（文書の順）に、ログインの画面にもあった CSS（`loginPageSelectors`）を除いて、ちょうど
 * 1 つに当たり読んだ要素を指す最初の CSS。
 */
export const successSelectorProposalOf = (
  candidates: readonly SuccessSelectorCandidateCheck[],
  loginPageSelectors: ReadonlySet<string>,
): LoginObservedSuccessSelector | null => {
  for (const candidate of candidates) {
    const selector = uniqueEntrySelectorOf(candidate.checks.filter((check) => !loginPageSelectors.has(check.selector)));
    if (selector !== null && isLoginObservedSuccessSelector(selector)) {
      return Object.freeze({ selector, kind: 'LOGOUT_CONTROL', logoutWord: candidate.logoutWord });
    }
  }
  return null;
};

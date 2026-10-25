// 発見の候補の分類（Task 27 の設計書 4.3。T27a）。表で駆動する純粋な関数。意味の判断や LLM は使わない（規則だけ）。
// - 表（`CANDIDATE_CLASSIFICATION_RULES`）を上から順に調べ、最初に当たった行の理由のコードと、その分類にする。
// - 送信先が許可 Origin の中かの判定は、URL の受け入れの owner（`src/crawl/admission-policy.ts` の `classifyUrl`）に任せる。
// - 語の比べ方:
//   - 比べる前に、Unicode の正規化（NFKC）と大文字小文字の畳み込み（`toUpperCase` の後に `toLowerCase`）をかける。全角の英数字は
//     ASCII に、半角のカタカナは全角になる（要求の判定の owner の、除外のパスと危険な語の比べと同じ畳み込み。owner は `src/core/text.ts`
//     の `foldNfkcCase`。CCX-15）。送信先の path は、percent-encode を外した形でも比べる。
//   - 危険な語は、部分一致（fail-closed）。区切り（空白、`-`、`_`、`/` など、文字と数字以外）を除いた形でも比べる（`Sign out`、
//     `sign_out` も `signout` に当たる）。比べる所は、送信ボタンの語、送信先の path、query の名前。READ の確かめで送る値の名前と値にも、
//     同じ比べ方で当てる（`readParametersHaveDestructiveWord`。DEF-088 の (b)。percent-encode を外した形でも比べる。送る値は利用者が選ぶので、
//     止める側に寄せる）。
//   - GET の form の欄の名前（T27R-fix-1。DEF-088 の (a)）の危険な語: 英語の語は、語の単位で比べる（`fieldNameWordsOf` で分けた語と一致する
//     ときだけ。T27R-fix-2。設計書 11 章の 2026-10-12 の行の (4)。`include_disabled` は `disable` に当たらず、`delete_flag` は `delete` に
//     当たる）。日本語の語（区切りがない）は、今までどおり部分一致（`削除フラグ` は `削除` に当たる）。
//   - 検索・更新・登録の語と、状態の欄の名前の語: 英語の語（ASCII だけの語）は、語の境界で比べる（文字と数字以外の区切りと、
//     camelCase の境で分けた語か、camelCase で分けない語の 1 つと一致するか、その語に `s` を付けた形と一致する）。`address` は `add` に、`research` は `search` に
//     当たらない。日本語の語は部分一致。状態の欄の名前の語は、T31a で欄の名前の語の owner の分け方（`fieldNameWordsOf`）の語も足し、`display`・
//     `show`・`表示` に名前・順・ラベルの語が続く所を除く（`fieldNameHasStateWord`）。
// - 送信ボタンの文言（T27R-fix-1。DEF-086）: 候補は文言そのものを持たない。probe が読んだ文言（ボタンの文字・`aria-label`・`title`）は、Node の
//   側で `submitterWordsOf` により、送信ボタンの語の閉じた一覧（`DISCOVERY_SUBMITTER_WORDS`）のうち、文言に当たる語だけに変える（上の比べ方と
//   同じ当たり方。危険な語は部分一致と区切りを除いた形、ほかは語の境界）。分類は、その語の一覧を見る（文言を見たときと同じ結果になる。
//   4 つの一覧は重ならないので、語がどの一覧の語かで決まる。`tests/unit/discovery-classify-table.test.ts` の固定の表で確かめる）。
// - GET の form の `_method` の欄（T27R-fix-1。DEF-088 の 3）: 型を問わず（hidden でなくても）、名前を畳み込んで `_method` と同じ欄があれば、
//   送るとサーバが method の上書きとして扱いうるので、実行できないもの（`DESTRUCTIVE`）にする。
// 純粋な関数だけのファイル。Playwright、ブラウザ、`node:fs`、`src/control/`、監査エンジンを import しない
// （`tests/architecture/discovery-boundary.test.ts`）。
import {
  API_WRITE_SECRET_LIKE_KEY_EXCLUDED_NAMES,
  API_WRITE_SECRET_LIKE_KEY_SEGMENTS,
  API_WRITE_SECRET_LIKE_KEY_WORDS,
  isSecretUrlQueryParameterName,
} from '../core/secret-query-names.js';
import { compareCodeUnits, foldNfkcCase, stripCombiningMarks } from '../core/text.js';
import { classifyUrl } from '../crawl/admission-policy.js';
import {
  CANDIDATE_REASON_CLASSIFICATIONS,
  effectiveFormMethodOf,
  isMethodOverrideFieldName,
  type CandidateClassificationResult,
  type CandidateKind,
  type CandidateReasonCode,
  type FormMethod,
  type MethodOverride,
  type DiscoveredCandidate,
  type ListenerKind,
} from './candidate-contracts.js';
import {
  DISCOVERY_CREATE_WORDS,
  DISCOVERY_DESTRUCTIVE_WORDS,
  DISCOVERY_GRAPHQL_PATH_WORDS,
  DISCOVERY_PROCEDURE_WRITE_WORDS,
  DISCOVERY_PUBLICATION_STATE_FIELD_WORDS,
  DISCOVERY_REMOVAL_FIELD_WORDS,
  DISCOVERY_SEARCH_WORDS,
  DISCOVERY_SOFT_DELETE_FIELD_WORDS,
  DISCOVERY_STATE_FIELD_LABEL_WORDS,
  DISCOVERY_STATE_FIELD_LABELED_WORDS,
  DISCOVERY_STATE_FIELD_WORDS,
  DISCOVERY_SUBMIT_PRESS_WORDS,
  DISCOVERY_UPDATE_WORDS,
} from './classification-words.js';

/** 分類の入力の決まり。 */
export interface CandidateClassificationPolicy {
  /** 許可 Origin（プロファイルの `approvedTestOrigins`）。正規化は `classifyUrl` が行う。 */
  readonly allowedOrigins: ReadonlySet<string>;
}

/**
 * document・window・祖先の listener のうち、委譲として数える種類（押す・送る操作。設計書 4.2 の「click・submit の委譲」）。キーの操作と
 * 入力の変化（`keydown`、`input` など）は、画面の全体の近道や入力の補助によくあるので、委譲に数えない。要素（form と送信ボタン）の
 * listener は、種類を問わず結び付きとして数える。
 */
const DELEGATION_LISTENER_KINDS: ReadonlySet<ListenerKind> = new Set<ListenerKind>([
  'click',
  'dblclick',
  'auxclick',
  'submit',
  'formdata',
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'touchstart',
  'touchend',
]);

/** percent-encode を外す回数の上限（二重に encode した path に備える。外せない形は、そこで止める）。 */
const MAX_PERCENT_DECODE_PASSES = 3;

/** 英語の語の複数形として、語の境界の比べで同じとみなす接尾辞。 */
const PLURAL_SUFFIX = 's';

/** 区切り（文字と数字以外）を除いた形。 */
const compactText = (folded: string): string => folded.replace(/[^\p{L}\p{N}]+/gu, '');

/** camelCase の境（小文字か数字の後の大文字）に区切りを入れる（畳み込みの前に行う）。 */
const splitCamelCase = (text: string): string => text.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2');

/** 区切り（文字と数字以外）で分けた語の一覧（畳み込んだ形）。 */
const separatedWordsOf = (text: string): readonly string[] =>
  foldNfkcCase(text).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);

/** 語の境界で分けた語の一覧（畳み込んだ形）。camelCase の境で分けた語と、分けない語の両方（`addItem` の `add`、`GraphQL` の `graphql`）。 */
const wordsOf = (text: string): readonly string[] => [...separatedWordsOf(splitCamelCase(text)), ...separatedWordsOf(text)];

/**
 * ASCII だけの語か（英語の語。語の境界で比べる。そうでない語は部分一致で比べる）。PRE42-CC 組 4（CC-082 1′）: 語の一覧の比べ方の振り分けの唯一の
 * owner。入力の規則の「送らない」側の選択肢の値の比べ（`src/control/data-rules/external-delivery-words.ts`）も使う
 * （`tests/architecture/data-rules-boundary.test.ts` の (g)）。
 */
export const isAsciiWord = (word: string): boolean => /^[\x20-\x7e]+$/u.test(word);

/** 大文字の続きの後の、大文字で始まる語の境（`XMLDelete` の `XML` と `Delete`）。 */
const UPPERCASE_RUN_BOUNDARY = /(\p{Lu})(\p{Lu}\p{Ll})/gu;
/** 文字と数字の境（`delete2` の `delete` と `2`、`2nd` の `2` と `nd`）。 */
const LETTER_DIGIT_BOUNDARY = /(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/gu;

/**
 * 欄の名前を語に分ける（T27R-fix-2。設計書 11 章の 2026-10-12 の行の (4)）。`_`・`-`・`.`・`[`・`]`・空白など文字と数字以外の区切り、文字と数字の
 * 境、大文字の切れ目（camelCase と、大文字の続きの後の語）で分け、畳み込んだ（`foldNfkcCase`）語の一覧を返す（`deleteFlag` → `delete`・`flag`、
 * `user[remove]` → `user`・`remove`）。使うのは、GET の form の欄の名前と、危険な語の一覧（`DISCOVERY_DESTRUCTIVE_WORDS`）の英語の語の比べ
 * （`fieldNameHasDestructiveWord`）だけ。ほかの比べ（検索・更新・登録・状態の欄の語は `wordsOf`、送信ボタンの文言・送信先の path・query の名前・
 * READ の送る値の危険な語は部分一致）には使わない。
 */
export const fieldNameWordsOf = (name: string): readonly string[] =>
  separatedWordsOf(splitCamelCase(name.replace(UPPERCASE_RUN_BOUNDARY, '$1 $2')).replace(LETTER_DIGIT_BOUNDARY, ' '));

/** percent-encode を外した形を、元の形と合わせて返す（外せない形は含めない）。 */
const percentDecodedForms = (text: string): readonly string[] => {
  const forms = [text];
  let current = text;
  for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      break;
    }
    if (decoded === current) {
      break;
    }
    forms.push(decoded);
    current = decoded;
  }
  return forms;
};

/** 危険な語の比べ（部分一致。畳み込んだ形と、区切りを除いた形）で、`texts` が当たる危険な語（一覧の順）。 */
const destructiveWordsIn = (texts: readonly string[]): readonly string[] => {
  const searched = texts.flatMap((text) => {
    const folded = foldNfkcCase(text);
    return [folded, compactText(folded)];
  });
  return DISCOVERY_DESTRUCTIVE_WORDS.filter((word) => {
    const forms = [word, compactText(word)];
    return searched.some((text) => forms.some((form) => form.length > 0 && text.includes(form)));
  });
};

/** 危険な語の比べ（`destructiveWordsIn`）で、どれかに当たるか。 */
const containsDestructiveWord = (texts: readonly string[]): boolean => destructiveWordsIn(texts).length > 0;

/** 語の境界の比べ（英語の語は語の境界、日本語の語は部分一致）で、`texts` が当たる `words` の語（一覧の順）。 */
const boundedWordsIn = (words: readonly string[], texts: readonly string[]): readonly string[] => {
  const tokens = new Set(texts.flatMap(wordsOf));
  const folded = texts.map(foldNfkcCase);
  return words.filter((word) => (isAsciiWord(word)
    ? tokens.has(word) || tokens.has(`${word}${PLURAL_SUFFIX}`)
    : folded.some((text) => text.includes(word))));
};

/** 語の境界の比べ（`boundedWordsIn`）で、どれかに当たるか。 */
const containsWord = (words: readonly string[], texts: readonly string[]): boolean => boundedWordsIn(words, texts).length > 0;

/**
 * 送信ボタンの文言（probe が読んだ文字。ボタンの文字・`aria-label`・`title` をつないだもの）が当たる、送信ボタンの語の閉じた一覧
 * （`DISCOVERY_SUBMITTER_WORDS`）の語（T27R-fix-1。DEF-086）。分類の比べ方と同じ当たり方（危険な語は部分一致と区切りを除いた形、検索・更新・
 * 登録の語は語の境界）。UTF-16 のコード単位の順に並べ、重なりのない凍結した一覧を返す（0 件もありうる）。文言そのものは返さない。
 */
export const submitterWordsOf = (text: string): readonly string[] => {
  const texts = [text];
  const words = new Set([
    ...destructiveWordsIn(texts),
    ...boundedWordsIn(DISCOVERY_SEARCH_WORDS, texts),
    ...boundedWordsIn(DISCOVERY_UPDATE_WORDS, texts),
    ...boundedWordsIn(DISCOVERY_CREATE_WORDS, texts),
  ]);
  return Object.freeze([...words].sort(compareCodeUnits));
};

/**
 * T44c（設計者の判断）: 送信ボタンの文言（probe が読んだ文字）が、送信の語（`DISCOVERY_SUBMIT_PRESS_WORDS`）に当たるか（更新・登録の語と同じ語の境界の
 * 比べ方）。送らずに観察する probe の押す順だけが使う（候補の語・識別の digest には入れない）。
 */
export const submitterTextHasSubmitWord = (text: string): boolean => containsWord(DISCOVERY_SUBMIT_PRESS_WORDS, [text]);

/**
 * READ の確かめで送る値（名前 → 値）の名前か値が、発見の分類の危険な語に当たるか（T27R-fix-1。DEF-088 の (b)）。比べ方は分類の危険な語と同じ
 * （部分一致、畳み込み、区切りを除いた形。日本語を含む）。サーバが percent-encode を外しうるので、外した形でも比べる（fail-closed）。定義の保存の
 * 確かめ（`src/control/read-check-policy.ts`）と、ワーカーの実行の前の確かめ（`read-check-evaluation.ts` の `buildReadCheckUrl`）が使う。
 */
export const readParametersHaveDestructiveWord = (parameters: Readonly<Record<string, string>>): boolean =>
  containsDestructiveWord(Object.entries(parameters).flatMap(([name, value]) => [...percentDecodedForms(name), ...percentDecodedForms(value)]));

/**
 * 欄の名前が、語の一覧（比べる形で書いた語）のどれかに当たるか（T29c。CC-082 の 1 つ目。欄の名前の語の単位の比べの唯一の owner）。英語の語
 * （ASCII だけの語）は、欄の名前の語（`fieldNameWordsOf`）の並びに、その語を同じ関数で分けた語の並び（`sign-out` は `sign`・`out`）がそのまま
 * 現れるときだけ当たる。日本語の語は、危険な語のほかの所と同じ部分一致（畳み込んだ形と、区切りを除いた形）。危険な語の判定
 * （`fieldNameHasDestructiveWord`）と、入力の規則の外部到達の語・業務テンプレートの語（`src/control/data-rules/`）が使う。
 */
export const fieldNameHasListedWord = (name: string, words: readonly string[]): boolean => {
  const nameWords = fieldNameWordsOf(name);
  const folded = foldNfkcCase(name);
  const searched = [folded, compactText(folded)];
  return words.some((word) => {
    if (!isAsciiWord(word)) {
      return [word, compactText(word)].some((form) => form.length > 0 && searched.some((text) => text.includes(form)));
    }
    const parts = fieldNameWordsOf(word);
    return parts.length > 0 && nameWords.some((_word, start) => parts.every((part, offset) => nameWords[start + offset] === part));
  });
};

/**
 * API の本文の鍵の名前が、秘密に見える名前か（秘密に見える名前の方針 6。T38R-fix の I-2、T38R2-fix の M-1。語の一覧は `src/core/secret-query-names.ts`）。
 * ページが決める鍵と、登録の ID を読む応答の鍵（値を照らさない鍵）を拒む下書きの確かめ（`src/control/approval/scenario-policy.ts`）が使う。次のどれかに
 * 当たれば当たる（fail-closed）:
 * - 方針 1 の完全一致（`isSecretUrlQueryParameterName`）。名前そのものと、NFKC と大文字小文字を畳んだ（`foldNfkcCase`）名前の両方で比べる。
 * - `API_WRITE_SECRET_LIKE_KEY_WORDS` の部分一致（畳んだ名前から文字と数字以外を除いた形。全角の英字・`ſ`・ケルビン記号・半角カナは NFKC で畳める）。
 * - `API_WRITE_SECRET_LIKE_KEY_SEGMENTS` の語の単位の一致（`fieldNameHasListedWord`。欄の名前の語に分ける。語の後の数字と頭字語の境でも分ける）。
 * - T41a: 結合文字を除いた形（NFD の後。`src/core/text.ts` の `stripCombiningMarks`）でも、上の 3 つを比べる（部分一致の語も同じ形にする）。
 * 限界: NFKC で畳めない形の似た文字（キリル文字の `о`・`ѕ` など）と、数字で書き換えた語（`p4ssword`）には当たらない。
 */
export const isApiWriteKeyNameSecretLike = (name: string): boolean =>
  // T44g（P4-2）: 比べる形が誤検知の除く一覧（`API_WRITE_SECRET_LIKE_KEY_EXCLUDED_NAMES`）にちょうど当たる鍵は除く。
  !isExcludedApiWriteKeyName(name)
  // T41a: 結合文字を除いた形（`stripCombiningMarks`。語の側も同じ形にする）でも比べる。
  && [name, stripCombiningMarks(name)].some((form) => isApiWriteKeyFormSecretLike(form));

/**
 * T44g（Task 44 の設計書 P4-2）: 鍵の名前の比べる形（NFKC と大文字小文字を畳み、文字と数字以外を除いた形。結合文字を除いた形も）が、どれも
 * `API_WRITE_SECRET_LIKE_KEY_EXCLUDED_NAMES` の語にちょうど当たるか（部分一致の誤検知として除く鍵）。
 */
const isExcludedApiWriteKeyName = (name: string): boolean => {
  const forms = [compactText(foldNfkcCase(name)), compactText(stripCombiningMarks(foldNfkcCase(name)))];
  return forms.every((form) => (API_WRITE_SECRET_LIKE_KEY_EXCLUDED_NAMES as readonly string[]).includes(form));
};

/** 方針 6 の比べの 1 つの形（`isApiWriteKeyNameSecretLike` の説明の 3 つ）。 */
const isApiWriteKeyFormSecretLike = (name: string): boolean => {
  const folded = foldNfkcCase(name);
  if (isSecretUrlQueryParameterName(name) || isSecretUrlQueryParameterName(folded)) {
    return true;
  }
  const compact = compactText(folded);
  const strippedCompact = compactText(stripCombiningMarks(folded));
  return API_WRITE_SECRET_LIKE_KEY_WORDS.some((word) => compact.includes(word) || strippedCompact.includes(compactText(stripCombiningMarks(word))))
    || fieldNameHasListedWord(name, API_WRITE_SECRET_LIKE_KEY_SEGMENTS);
};

/**
 * GET の form の欄の名前が、危険な語に当たるか（T27R-fix-1 の DEF-088 の (a)、T27R-fix-2）。比べ方は `fieldNameHasListedWord`（英語の語は語の
 * 単位の並び、日本語の語は部分一致。T29c で、その関数を使う形にした。判定の結果は変えない）。
 */
export const fieldNameHasDestructiveWord = (name: string): boolean => fieldNameHasListedWord(name, DISCOVERY_DESTRUCTIVE_WORDS);

/**
 * 欄の名前が、危険な語か削除の語に当たるか（T31R-fix-1 の I-1。Task 31 の設計書 3 章の「削除にあたる変更の遮断」）。危険な語
 * （`fieldNameHasDestructiveWord`）と、欄の名前のための削除の語（`DISCOVERY_REMOVAL_FIELD_WORDS`）のどちらかに、同じ比べ方
 * （`fieldNameHasListedWord`）で当たれば真。当たる欄は、UPDATE で状態の欄と同じく保つだけ（下書きの確かめ `scenario-policy.ts` と、ワーカーの
 * 欄の役割が共用する唯一の判定）。
 */
export const fieldNameHasRemovalWord = (name: string): boolean =>
  fieldNameHasDestructiveWord(name) || fieldNameHasListedWord(name, DISCOVERY_REMOVAL_FIELD_WORDS);

/** ML-a-fix-3: 手続きの呼び出しの書き込みの語（危険な語・更新の語・登録の語と、手続きの名前のための語）。 */
const PROCEDURE_WRITE_WORDS: readonly string[] = Object.freeze([
  ...DISCOVERY_DESTRUCTIVE_WORDS,
  ...DISCOVERY_UPDATE_WORDS,
  ...DISCOVERY_CREATE_WORDS,
  ...DISCOVERY_PROCEDURE_WRITE_WORDS,
]);

/**
 * ML-a-fix-3（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 6 章の ML-R2 の行の M-2）: 手続きの呼び出しの名前（path）が、書き込みの語
 * （`upsert`・`insert`・`update`・`create`・`delete`・`remove`・`save`・`set`・`write`・`add` など）を含むか。比べ方は欄の名前の語の単位の比べ
 * （`fieldNameHasListedWord`。`settings`・`address` は `set`・`add` に当たらない）。手動のログインの成功からの自動の登録
 * （`src/control/manual-login-registration.ts`）が、書き込みの手続きを登録しないために使う。
 */
export const procedureNameHasWriteWord = (name: string): boolean => fieldNameHasListedWord(name, PROCEDURE_WRITE_WORDS);

/** 送信ボタンの語に、ある一覧の語があるか（4 つの一覧は重ならないので、語がどの一覧の語かで決まる）。 */
const hasListedWord = (submitterWords: ReadonlySet<string>, words: readonly string[]): boolean => words.some((word) => submitterWords.has(word));

/** 分類の表が見る事実（候補から 1 回だけ求める）。 */
export interface CandidateFacts {
  readonly kind: CandidateKind;
  /** 実際の method（POST の `_method` の上書きを反映。form の外のボタンは null）。 */
  readonly method: FormMethod | MethodOverride | null;
  readonly actionOutsideAllowedOrigins: boolean;
  readonly destructive: boolean;
  readonly hasPasswordField: boolean;
  readonly multipart: boolean;
  readonly searchWord: boolean;
  readonly graphqlEndpoint: boolean;
  readonly jsBound: boolean;
  readonly jsDelegated: boolean;
  readonly unrecognizedMethodOverride: boolean;
  /** GET の form に、型を問わず `_method` の欄がある（T27R-fix-1。DEF-088 の 3）。 */
  readonly methodOverrideFieldOnGet: boolean;
  readonly updateWord: boolean;
  readonly createWord: boolean;
}

/**
 * 送信先の Origin が、許可 Origin の中か（解析できない Origin は外。fail-closed）。T37c: 送らずに観察する probe の対象の選び方
 * （`submission-probe-contracts.ts` の `isSubmissionProbeTarget`。画面と送信先の Origin）も使う（書き写さない）。
 */
export const isInsideAllowedOrigins = (origin: string, policy: CandidateClassificationPolicy): boolean =>
  URL.canParse(origin) && classifyUrl(new URL(origin), { allowedOrigins: policy.allowedOrigins }).kind === 'INTERNAL_NAVIGABLE';

const factsOf = (candidate: DiscoveredCandidate, policy: CandidateClassificationPolicy): CandidateFacts => {
  const { action, formMethod, methodOverride, jsBinding } = candidate;
  const method = effectiveFormMethodOf(candidate);
  const actionPaths = action === null ? [] : percentDecodedForms(action.path);
  const submitterWords: ReadonlySet<string> = new Set(candidate.submitterWords);
  // T27R-fix-1（DEF-088 の (a)）: GET の form は、欄の名前も危険な語の比べの対象（送ると、その名前で送られる）。英語の語は語の単位で比べる
  // （T27R-fix-2。`fieldNameHasDestructiveWord`）。
  const getFieldNames = method === 'GET' ? candidate.fields.map((field) => field.name) : [];
  return {
    kind: candidate.kind,
    method,
    actionOutsideAllowedOrigins: action !== null && !isInsideAllowedOrigins(action.origin, policy),
    // GET の form の `_method=DELETE` も、送られる method にかかわらず実行できないものにする（fail-closed）。
    destructive: methodOverride === 'DELETE'
      || hasListedWord(submitterWords, DISCOVERY_DESTRUCTIVE_WORDS)
      || containsDestructiveWord([...actionPaths, ...(action?.queryNames ?? [])])
      || getFieldNames.some(fieldNameHasDestructiveWord),
    hasPasswordField: candidate.fields.some((field) => field.type === 'password'),
    multipart: candidate.enctype === 'multipart/form-data',
    searchWord: hasListedWord(submitterWords, DISCOVERY_SEARCH_WORDS) || containsWord(DISCOVERY_SEARCH_WORDS, actionPaths),
    graphqlEndpoint: containsWord(DISCOVERY_GRAPHQL_PATH_WORDS, actionPaths),
    jsBound: jsBinding.inlineHandler || jsBinding.form.length > 0 || jsBinding.submitter.length > 0,
    jsDelegated: [jsBinding.ancestor, jsBinding.document, jsBinding.window]
      .some((kinds) => kinds.some((kind) => DELEGATION_LISTENER_KINDS.has(kind))),
    unrecognizedMethodOverride: formMethod === 'POST' && methodOverride === null && candidate.fields.some((field) =>
      field.type === 'hidden' && isMethodOverrideFieldName(field.name)),
    methodOverrideFieldOnGet: method === 'GET' && candidate.fields.some((field) => isMethodOverrideFieldName(field.name)),
    updateWord: hasListedWord(submitterWords, DISCOVERY_UPDATE_WORDS) || containsWord(DISCOVERY_UPDATE_WORDS, actionPaths),
    createWord: hasListedWord(submitterWords, DISCOVERY_CREATE_WORDS) || containsWord(DISCOVERY_CREATE_WORDS, actionPaths),
  };
};

/** 分類の表の 1 行。 */
export interface CandidateClassificationRule {
  readonly reasonCode: CandidateReasonCode;
  readonly matches: (facts: CandidateFacts) => boolean;
}

/** 書き込みの method（更新と登録の語を見る method）。 */
const isWriteMethod = (method: CandidateFacts['method']): boolean => method === 'POST' || method === 'PUT' || method === 'PATCH';

/**
 * 分類の表（設計書 4.3 の 8 段。上から順に、最初に当たった行に決める）。行の分類は `CANDIDATE_REASON_CLASSIFICATIONS`。
 * 段の中の順の決め:
 * - 3: 扱えない読み取り（password の欄、multipart）を、JS の結び付きより先にする（結び付きが分かっても READ にできないため）。
 * - 5: 委譲（画面の全体に効く）を、要素の結び付きより先にする。結び付きのない form の外のボタン、`dialog` の form（サーバへ送らない）、
 *   値の分からない `_method`（実際の method が決まらない）は、表示だけにする（6・7 の語で CREATE・UPDATE にしない）。
 * - 6・7: 語は、書き込みの method（POST・PUT・PATCH）の form だけで見る。
 */
export const CANDIDATE_CLASSIFICATION_RULES: readonly CandidateClassificationRule[] = Object.freeze([
  // 1
  { reasonCode: 'ACTION_OUTSIDE_ALLOWED_ORIGINS', matches: (facts) => facts.actionOutsideAllowedOrigins },
  // 2（T27R-fix-1: GET の form の `_method` の欄も。DEF-088 の 3）
  { reasonCode: 'DESTRUCTIVE', matches: (facts) => facts.method === 'DELETE' || facts.destructive || facts.methodOverrideFieldOnGet },
  // 3
  { reasonCode: 'GET_WITH_PASSWORD_FIELD', matches: (facts) => facts.method === 'GET' && facts.hasPasswordField },
  { reasonCode: 'GET_WITH_MULTIPART', matches: (facts) => facts.method === 'GET' && facts.multipart },
  { reasonCode: 'JS_DELEGATED', matches: (facts) => facts.method === 'GET' && facts.jsDelegated },
  { reasonCode: 'JS_BOUND', matches: (facts) => facts.method === 'GET' && facts.jsBound },
  { reasonCode: 'READ_GET_FORM', matches: (facts) => facts.method === 'GET' },
  // 4
  { reasonCode: 'POST_SEARCH', matches: (facts) => facts.method === 'POST' && facts.searchWord },
  { reasonCode: 'GRAPHQL_ENDPOINT', matches: (facts) => facts.method === 'POST' && facts.graphqlEndpoint },
  // 5
  { reasonCode: 'JS_DELEGATED', matches: (facts) => facts.jsDelegated },
  { reasonCode: 'JS_BOUND', matches: (facts) => facts.jsBound },
  { reasonCode: 'NO_KNOWN_ACTION', matches: (facts) => facts.kind === 'BUTTON' },
  { reasonCode: 'DIALOG_METHOD', matches: (facts) => facts.method === 'DIALOG' },
  { reasonCode: 'METHOD_OVERRIDE_UNRECOGNIZED', matches: (facts) => facts.unrecognizedMethodOverride },
  // 6
  { reasonCode: 'UPDATE_METHOD', matches: (facts) => facts.method === 'PATCH' || facts.method === 'PUT' },
  { reasonCode: 'UPDATE_WORD', matches: (facts) => isWriteMethod(facts.method) && facts.updateWord },
  // 7
  { reasonCode: 'CREATE_WORD', matches: (facts) => isWriteMethod(facts.method) && facts.createWord },
  // 8
  { reasonCode: 'UNCLASSIFIED', matches: () => true },
] satisfies CandidateClassificationRule[]);

/** 状態の欄の語の比べの例外を持つ語（`display`・`show`・`表示`）。 */
const STATE_FIELD_LABELED_WORDS: ReadonlySet<string> = new Set(DISCOVERY_STATE_FIELD_LABELED_WORDS);

/**
 * 欄の名前の語の 1 つ（畳み込んだ形）が、名前・順・ラベルの語（`DISCOVERY_STATE_FIELD_LABEL_WORDS`）か。英語の語は一致するか、`s` を付けた形と
 * 一致する。日本語の語は、その語で始まる（`名前` は `名` で始まる）。
 */
const isStateFieldLabelWord = (word: string | undefined): boolean => word !== undefined && DISCOVERY_STATE_FIELD_LABEL_WORDS.some((label) =>
  (isAsciiWord(label) ? word === label || word === `${label}${PLURAL_SUFFIX}` : word.startsWith(label)));

/**
 * 英語の状態の欄の語が、欄の名前に語の単位で現れるか。語の並びは 3 つ（`wordsOf` の 2 つ: camelCase の境で分けた並びと、分けない並び。
 * 欄の名前の語の owner の `fieldNameWordsOf` の並び: 文字と数字の境と、大文字の続きの後の語でも分ける）。語か、語に `s` を付けた形と一致すれば
 * 当たる。例外を持つ語（`display`・`show`）は、すぐ後の語が名前・順・ラベルの語なら、その所では当てない。
 */
const nameHasAsciiStateWord = (word: string, sequences: readonly (readonly string[])[]): boolean => sequences.some((tokens) =>
  tokens.some((token, index) => (token === word || token === `${word}${PLURAL_SUFFIX}`)
    && !(STATE_FIELD_LABELED_WORDS.has(word) && isStateFieldLabelWord(tokens[index + 1]))));

/**
 * 日本語の状態の欄の語が、畳み込んだ欄の名前に部分一致で現れるか。例外を持つ語（`表示`）は、その所の後の最初の語（`fieldNameWordsOf`。区切りは
 * 除かれる）が名前・順・ラベルの語なら、その所では当てない（`表示名`・`表示順`・`表示 名`・`表示_name`）。ほかの所で当たれば当たる。
 */
const nameHasJapaneseStateWord = (word: string, folded: string): boolean => {
  if (!STATE_FIELD_LABELED_WORDS.has(word)) {
    return folded.includes(word);
  }
  for (let index = folded.indexOf(word); index >= 0; index = folded.indexOf(word, index + 1)) {
    if (!isStateFieldLabelWord(fieldNameWordsOf(folded.slice(index + word.length))[0])) {
      return true;
    }
  }
  return false;
};

/**
 * 欄の名前が、状態の欄の名前の語（`DISCOVERY_STATE_FIELD_WORDS`）に当たるか（T29c fix round 1 で公開した。候補の状態の欄の印と、入力の規則の
 * 欄ごとの判定（`src/control/data-rules/field-evaluation.ts`）が使う）。T31a（Task 31 の設計書 3 章）で語を足し、比べ方を次のようにした:
 * - 英語の語は語の単位（`nameHasAsciiStateWord`）。T31a の前の比べ（`wordsOf` の語の境界）の並びに、欄の名前の語の owner の並び
 *   （`fieldNameWordsOf`）を足した（`del2`・`flg1` も当たる。前に当たっていた名前は、今も当たる）。
 * - 日本語の語は、今までどおり畳み込んだ名前への部分一致（`nameHasJapaneseStateWord`）。
 * - `display`・`show`・`表示` は、名前・順・ラベルの語が続く所では当てない（`display_name`・`displayName`・`show_order`・`表示名`・`表示順`。
 *   閉じた例外の一覧）。
 */
export const fieldNameHasStateWord = (name: string): boolean => {
  const sequences = [separatedWordsOf(splitCamelCase(name)), separatedWordsOf(name), fieldNameWordsOf(name)];
  const folded = foldNfkcCase(name);
  return DISCOVERY_STATE_FIELD_WORDS.some((word) =>
    (isAsciiWord(word) ? nameHasAsciiStateWord(word, sequences) : nameHasJapaneseStateWord(word, folded)));
};

/** DEF-147: 欄（鍵）の名前が、論理削除の語（`DISCOVERY_SOFT_DELETE_FIELD_WORDS`）に当たるか。 */
export const fieldNameHasSoftDeleteWord = (name: string): boolean => fieldNameHasListedWord(name, DISCOVERY_SOFT_DELETE_FIELD_WORDS);

/** DEF-147: 欄（鍵）の名前が、公開の状態の語（`DISCOVERY_PUBLICATION_STATE_FIELD_WORDS`）に当たるか。 */
export const isPublicationStateKeyName = (name: string): boolean => fieldNameHasListedWord(name, DISCOVERY_PUBLICATION_STATE_FIELD_WORDS);

/**
 * DEF-147（設計書 `2026-10-21-beaksight-api-state-keys-design.md` 2 章）: API の要求の本文の鍵の名前が、論理削除にあたる鍵か（API の型の分類と、API の
 * シナリオと入力の規則の判定が使う唯一の判定）。論理削除の語に当たるか、状態の欄の語（`fieldNameHasStateWord`）に当たるのに公開の状態の語に当たらない
 * （公開の状態でも論理削除でもない状態の語。止める側）なら真。公開の状態の語にだけ当たる鍵（status・is_published・published_at など）は偽。フォームの
 * 送信の分類（状態の欄の印）は、今どおり `fieldNameHasStateWord`。
 */
export const isApiSoftDeleteKeyName = (name: string): boolean =>
  fieldNameHasSoftDeleteWord(name) || (fieldNameHasStateWord(name) && !isPublicationStateKeyName(name));

/** 状態の欄の名前（語の境界で比べる）を持つか。 */
const hasStateField = (candidate: DiscoveredCandidate): boolean => candidate.fields.some((field) => fieldNameHasStateWord(field.name));

/** 候補を分類する（純粋。入力を変えない）。 */
export const classifyCandidate = (
  candidate: DiscoveredCandidate,
  policy: CandidateClassificationPolicy,
): CandidateClassificationResult => {
  const facts = factsOf(candidate, policy);
  const rule = CANDIDATE_CLASSIFICATION_RULES.find((candidateRule) => candidateRule.matches(facts));
  // 表の最後の行はいつも当たるので、`rule` は必ずある。型のために、最後の行の理由に倒す。
  const reasonCode = rule?.reasonCode ?? 'UNCLASSIFIED';
  return Object.freeze({
    classification: CANDIDATE_REASON_CLASSIFICATIONS[reasonCode],
    reasonCode,
    hasStateField: hasStateField(candidate),
  });
};

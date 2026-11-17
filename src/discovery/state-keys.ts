// COV-0（設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.1）: 状態の鍵の唯一の部品（SSOT）。見るだけの点検と操作さがしが共用する。
// - 場所の鍵（`stateLocationKeyOf`）: 正規化した URL（path の全体と、query の名前と値）と、frame・開いた枠の印の digest。同じ場所の鍵は 1 回だけ読む。
//   - 正規化は `src/crawl/normalize-url.ts` の `normalizeUrl` に任せる。今の正規化と違うのは、query の値を捨てずに、URL にある名前をすべて残すこと
//     （残す名前の集合に、その URL の名前をすべて渡す）。追跡用の名前（`utm_*`・`gclid`・`fbclid`）は今の正規化どおり捨てる。fragment も捨てる。
//   - query の組の並びは `normalizeUrl` の決まり（名前の UTF-16 のコード単位の順。同じ名前の値は書かれた順のまま）。名前の並びの違いは同じ鍵、
//     同じ名前の値の並びの違い（`a=2&a=1` と `a=1&a=2`）は、値の並びに意味のあるサイトがあるので違う鍵にする（URL の組み立て直しは
//     `normalize-url.ts` の外に書かない。GATE-ARCH04）。
//   - 秘密に見える名前（`secret-query-names.ts` の方針 1）の query の値は、鍵を作る前に伏せる（`url-redaction.ts` の `redactUrlQueryValues`。認証つきの
//     Run の伏せ方 `redactUrlSecrets` と同じ判定）。伏せた値だけが違う URL は同じ場所の鍵になる。移動に使う URL（伏せる前）は `url` で返す。
// - 構造の鍵（`stateStructureKeyOf`）: 事実の組の digest。文字の値（見出しや欄の label の文言など）は入れない。入力の欠け（`null`）は、空の集合と
//   違う値として鍵に入れる。
//   - path の型は `fingerprint.ts` の `pageTemplatePathOf`（番号や値に見える区切りを `{id}` にする。なければ path のまま）。
//   - 候補の識別は digest（`sha256:`）だけを受ける。見出しは段（1〜6）があるか、landmark は閉じた一覧の role があるかにする（COV-2c: 数は入れない。
//     候補・欄も集合。同じ作りの部品が増えただけでは同じ鍵）。
//   - 欄の名前は型（番号を `{n}` にしたもの）にする（版 3。行を足す画面で、番号だけ違う名前の欄が増えただけでは同じ鍵）。
//   - 状態の語は、呼び出し側が閉じた一覧の語を渡す（ここは集合にして digest に入れるだけ）。
// - 文書の形の印（`*_FORMAT`）を先頭に入れる。並べ方や項目を変えるときは、印の版を上げる。
// 純粋な関数だけのファイル（`tests/architecture/discovery-boundary.test.ts` の純粋な部品）。
import type { UrlRejectionReason } from '../core/evidence-types.js';
import { createSha256Fingerprint, isSha256Fingerprint } from '../core/ids.js';
import { isSecretUrlQueryParameterName } from '../core/secret-query-names.js';
import { compareCodeUnits } from '../core/text.js';
import { redactUrlQueryValues } from '../core/url-redaction.js';
import { normalizeUrl } from '../crawl/normalize-url.js';
import { DISCOVERY_STATE_WORDS } from './classification-words.js';
import { pageTemplatePathOf } from './fingerprint.js';

/** 場所の鍵の入力の形の印（版つき）。 */
export const STATE_LOCATION_KEY_FORMAT = 'beaksight-state-location/1';

/** 構造の鍵の入力の形の印（版つき）。 */
export const STATE_STRUCTURE_KEY_FORMAT = 'beaksight-state-structure/3';

/** 場所の鍵の入力。`frame`・`openedRegion` は呼び出し側の印（最上位の文書・開いた枠なしは `null`）。 */
export interface StateLocationInput {
  readonly url: string;
  /** 相対の URL の基準（絶対の URL なら省いてよい）。 */
  readonly baseUrl?: string;
  readonly frame: string | null;
  readonly openedRegion: string | null;
  /**
   * COV-2b: 秘密に見える名前のほかに、値を伏せる query の名前（押下で出た移り先の、値に目印を含む名前など）。伏せ方は秘密の名前と同じ部品
   * （`redactUrlQueryValues`）。省略すると秘密に見える名前だけ。
   */
  readonly redactedQueryNames?: readonly string[] | undefined;
}

/** 場所の鍵の結果。 */
export type StateLocationKeyResult =
  | {
    readonly ok: true;
    /** 場所の鍵（`sha256:` の digest）。 */
    readonly key: string;
    /** 移動に使う正規化した URL（query の値を持つ。秘密に見える値も伏せない。成果物に書かない）。 */
    readonly url: string;
    /** 秘密に見える名前の query の値を伏せた URL（鍵の元。記録に書いてよい形）。 */
    readonly redactedUrl: string;
  }
  | { readonly ok: false; readonly reason: UrlRejectionReason };

/** 文字列を UTF-16 のコード単位の順に並べた写し。 */
const sortedTexts = (texts: Iterable<string>): string[] => [...texts].sort(compareCodeUnits);

/** URL の query の名前（解析できなければ空）。 */
const queryNamesOf = (url: string, baseUrl: string | undefined): ReadonlySet<string> => {
  try {
    return new Set(new URL(url, baseUrl).searchParams.keys());
  } catch {
    return new Set();
  }
};

/** 場所の鍵（ファイルの先頭の説明）。受け入れない URL は、`normalizeUrl` の理由のコードで返す。 */
export const stateLocationKeyOf = (input: StateLocationInput): StateLocationKeyResult => {
  const normalized = normalizeUrl(input.url, input.baseUrl ?? input.url, queryNamesOf(input.url, input.baseUrl));
  if (!normalized.ok) {
    return Object.freeze({ ok: false, reason: normalized.reason });
  }
  const { url } = normalized;
  const extra: ReadonlySet<string> = new Set(input.redactedQueryNames ?? []);
  const redactedUrl = redactUrlQueryValues(url, (name) => isSecretUrlQueryParameterName(name) || extra.has(name));
  const key = createSha256Fingerprint(JSON.stringify([STATE_LOCATION_KEY_FORMAT, redactedUrl, input.frame, input.openedRegion]));
  return Object.freeze({ ok: true, key, url, redactedUrl });
};

/** landmark の role の閉じた一覧（WAI-ARIA の landmark。構造の鍵は role ごとの数を持つ）。 */
export const STATE_LANDMARK_ROLES = Object.freeze([
  'banner',
  'complementary',
  'contentinfo',
  'form',
  'main',
  'navigation',
  'region',
  'search',
] as const);
export type StateLandmarkRole = (typeof STATE_LANDMARK_ROLES)[number];

/**
 * COV-2（設計書 3.1 の 2）: 状態の語の閉じた一覧（小文字。画面の見える文字にこの語があるかだけを構造の鍵に入れる。文字の値そのものは入れない）。同じ作りの
 * 画面でも、状態（取り消し済み・確定など）でボタンが変わる画面を、別の状態として見分けるための語。語を足すときは、構造の鍵の版
 * （`STATE_STRUCTURE_KEY_FORMAT`）は上げない（語の有無は入力の値）。
 */
export const STATE_WORDS = DISCOVERY_STATE_WORDS;

/** 見出しの段の最小と最大。 */
const MIN_HEADING_LEVEL = 1;
const MAX_HEADING_LEVEL = 6;

/** 構造の鍵の、欄 1 件の事実。 */
export interface StateStructureField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly disabled: boolean;
  /** 選択肢の値（select・radio など）。選択肢のない欄は `null`。 */
  readonly optionValues: readonly string[] | null;
}

/** 構造の鍵の入力（事実の組）。どの項目も、読めなかったときは `null`（欠け）。空の一覧とは違う鍵になる。 */
export interface StateStructureFacts {
  /** 画面の path（型は `pageTemplatePathOf` で作る）。 */
  readonly path: string | null;
  readonly queryNames: readonly string[] | null;
  /** 共通の枠を除いた候補の識別の digest（`sha256:`）。 */
  readonly candidateIdentityDigests: readonly string[] | null;
  readonly fields: readonly StateStructureField[] | null;
  /** 開いた窓・区画があるか。 */
  readonly openedDialogOrRegion: boolean | null;
  /** 見出しの段（1〜6）。見出し 1 つにつき 1 つ（鍵には、段があるかだけを入れる）。 */
  readonly headingLevels: readonly number[] | null;
  /** landmark の role（`STATE_LANDMARK_ROLES`）。landmark 1 つにつき 1 つ（鍵には、role があるかだけを入れる）。 */
  readonly landmarkRoles: readonly string[] | null;
  /** 状態の語（呼び出し側の閉じた一覧の語）。 */
  readonly stateWords: readonly string[] | null;
}

/** 欠けた項目はそのまま `null`、ほかは `toItem` の値にする。 */
const factItem = <T>(value: T | null, toItem: (present: T) => unknown): unknown => (value === null ? null : toItem(value));

/**
 * 欄の名前の型（番号を `{n}` にする）。行を足す画面（押すと `name` に番号の付いた同じ作りの行が増える）で、番号だけ違う名前の欄が増えただけでは別の鍵に
 * しない（COV-2c の I-1 の 2 の「同じ作りの部品が増えただけでは同じ鍵」を欄の名前にも当てる。path の型 `pageTemplatePathOf` と同じ考え方）。
 */
const fieldNameTemplateOf = (name: string): string => name.replace(/[0-9]+/gu, '{n}');

const fieldItemOf = (field: StateStructureField): string => JSON.stringify([
  fieldNameTemplateOf(field.name),
  field.type,
  field.required,
  field.disabled,
  field.optionValues === null ? null : sortedTexts(new Set(field.optionValues)),
]);

const candidateItemOf = (digests: readonly string[]): string[] => {
  for (const digest of digests) {
    if (!isSha256Fingerprint(digest)) {
      throw new RangeError('state structure candidate identity must be a fingerprint digest');
    }
  }
  return sortedTexts(new Set(digests));
};

// COV-2c（SREV-COV の I-1 の 2）: 見出し・landmark・欄は、数でなく作りの集合（あるか・ないか）にする。同じ作りの部品が増えただけでは別の鍵にならない
// （伸び続ける画面の作りの印 `scrollStructureSignaturesOf` と同じ考え方。押すたびに見出しや行が増える画面で、状態が終わりなく増えない）。

const headingItemOf = (levels: readonly number[]): boolean[] => {
  const present = Array.from({ length: MAX_HEADING_LEVEL }, () => false);
  for (const level of levels) {
    if (!Number.isInteger(level) || level < MIN_HEADING_LEVEL || level > MAX_HEADING_LEVEL) {
      throw new RangeError(`state structure heading level must be an integer from ${MIN_HEADING_LEVEL} to ${MAX_HEADING_LEVEL}`);
    }
    present[level - MIN_HEADING_LEVEL] = true;
  }
  return present;
};

const landmarkItemOf = (roles: readonly string[]): boolean[] => {
  const known: readonly string[] = STATE_LANDMARK_ROLES;
  for (const role of roles) {
    if (!known.includes(role)) {
      throw new RangeError('state structure landmark role is not in STATE_LANDMARK_ROLES');
    }
  }
  return STATE_LANDMARK_ROLES.map((role) => roles.includes(role));
};

/** 構造の鍵（ファイルの先頭の説明）。文字の値が入り込む入力（digest でない候補、範囲の外の段、一覧にない role）は `RangeError`。 */
export const stateStructureKeyOf = (facts: StateStructureFacts): string => createSha256Fingerprint(JSON.stringify([
  STATE_STRUCTURE_KEY_FORMAT,
  ['path', factItem(facts.path, (path) => pageTemplatePathOf(path) ?? path)],
  ['queryNames', factItem(facts.queryNames, (names) => sortedTexts(new Set(names)))],
  ['candidates', factItem(facts.candidateIdentityDigests, candidateItemOf)],
  ['fields', factItem(facts.fields, (fields) => sortedTexts(new Set(fields.map(fieldItemOf))))],
  ['opened', facts.openedDialogOrRegion],
  ['headings', factItem(facts.headingLevels, headingItemOf)],
  ['landmarks', factItem(facts.landmarkRoles, landmarkItemOf)],
  ['stateWords', factItem(facts.stateWords, (words) => sortedTexts(new Set(words)))],
]));

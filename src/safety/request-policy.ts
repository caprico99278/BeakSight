import type { BLOCKED_AUDIT_EXCLUSION_REASONS } from '../core/evidence-types.js';
import { foldNfkcCase } from '../core/text.js';
import { canonicalizeAllowedOrigins, hasUrlCredentials } from '../crawl/normalize-url.js';

export interface HttpRequestFacts {
  readonly kind: 'HTTP';
  readonly method: string;
  readonly url: string;
  readonly isNavigationRequest: boolean;
  readonly isMainFrame: boolean;
}

export interface WebSocketRequestFacts {
  readonly kind: 'WEBSOCKET';
  readonly url: string;
}

export type PassiveRequestFacts = HttpRequestFacts | WebSocketRequestFacts;

export type PassiveRequestDecision =
  | { readonly action: 'ALLOW'; readonly delivery: 'DIRECT' | 'INSPECT_REDIRECTS' }
  | { readonly action: 'BLOCK'; readonly category: 'REQUEST'; readonly reason: 'NON_READ_METHOD' }
  | {
    readonly action: 'BLOCK';
    readonly category: 'NAVIGATION';
    readonly reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION';
  }
  | { readonly action: 'BLOCK'; readonly category: 'WEBSOCKET'; readonly reason: 'PASSIVE_WEBSOCKET' }
  | {
    readonly action: 'BLOCK';
    readonly category: 'AUDIT_EXCLUSION';
    /** 理由の値の一覧の owner は core（`BLOCKED_AUDIT_EXCLUSION_REASONS`。Safety Ledger の `blockedAuditExclusions` の中だけで使う）。 */
    readonly reason: (typeof BLOCKED_AUDIT_EXCLUSION_REASONS)[number];
  }
  | {
    readonly action: 'BLOCK';
    readonly category: 'LOGIN_STAGE';
    /** ログインの段だけで止める理由（`LOGIN_STAGE_BLOCK_REASONS`。Safety Ledger には書かず、Guard のログインの段の記録に数える）。 */
    readonly reason: LoginStageBlockReason;
  }
  | {
    readonly action: 'BLOCK';
    readonly category: 'WRITE_STAGE';
    /** 書き込みの段だけで止める理由（`WRITE_STAGE_BLOCK_REASONS`。Safety Ledger には書かず、Guard の書き込みの段の記録に数える。T30b）。 */
    readonly reason: WriteStageBlockReason;
  };

/**
 * 送信の段（ログインの段と書き込みの段）だけで止める理由（T26g-1。Task 26 の設計書の変更履歴の「T26R」の行の C1、「Blocker: T26g-1」の行。
 * T30b で書き込みの段と共用にした。閉じた一覧）。
 * - `OUTSIDE_ALLOWED_ORIGINS`: 許可 Origin の外への GET と HEAD のサブリソースとサブ frame のナビゲーション（手動と自動の両方）。
 * - `SUBMISSION_WINDOW`: 送信の窓の中の、許した POST のほかの読み取りの要求（同じ Origin を含む）。
 * - `SUBMISSION_WINDOW_BROWSER_FAVICON`: 送信の窓の中の、許可 Origin の `GET /favicon.ico`（query と fragment なし）。止めるが、値を運べない
 *   ブラウザ自身の要求として、予期しない要求の理由には数えない。
 * 記録は Safety Ledger ではなく、Guard の段の指定の中に持つ（core とスキーマの理由の一覧を変えない）。
 */
export const SUBMISSION_STAGE_BLOCK_REASONS = Object.freeze([
  'OUTSIDE_ALLOWED_ORIGINS',
  'SUBMISSION_WINDOW',
  'SUBMISSION_WINDOW_BROWSER_FAVICON',
] as const);
export type SubmissionStageBlockReason = (typeof SUBMISSION_STAGE_BLOCK_REASONS)[number];
/** ログインの段だけで止める理由（`SUBMISSION_STAGE_BLOCK_REASONS` と同じ一覧）。 */
export const LOGIN_STAGE_BLOCK_REASONS = SUBMISSION_STAGE_BLOCK_REASONS;
export type LoginStageBlockReason = SubmissionStageBlockReason;
/** 書き込みの段だけで止める理由（T30b。`SUBMISSION_STAGE_BLOCK_REASONS` と同じ一覧。窓の考え方はログインの段と同じ）。 */
export const WRITE_STAGE_BLOCK_REASONS = SUBMISSION_STAGE_BLOCK_REASONS;
export type WriteStageBlockReason = SubmissionStageBlockReason;

/** ブラウザ自身が、ページのアイコンを取りに行くときの既定の path（ページにアイコンの指定がない場合）。 */
export const BROWSER_DEFAULT_FAVICON_PATH = '/favicon.ico';

/**
 * ログインの段で、main frame のナビゲーションの POST を許す送信先（Task 25 の設計書 4.1 の `loginPostEndpoints`、4.2）。
 * - `origin`: 送信先の Origin。許可 Origin と同じ意味（`canonicalizeAllowedOrigins`）で比べる。
 * - `path`: 送信先の path。`/` で始まり、query と fragment を含まない値だけが当たりうる（それ以外は、どの要求にも当たらない。fail-closed）。
 */
export interface LoginPostEndpoint {
  readonly origin: string;
  readonly path: string;
}

/**
 * 送信の段（ログインの段と書き込みの段）で、main frame のナビゲーションの POST を許す送信先（T30b。形は `LoginPostEndpoint` と同じ。
 * 比べ方も同じ。書き込みの段は query と fragment を許さない）。
 */
export type SubmissionEndpoint = LoginPostEndpoint;

/**
 * 送信の段の口の共通の項目（T30b。ログインの段の口と書き込みの段の口）。
 * - `remainingPosts`: あと何回の POST を許すか。1 以上の整数のときだけ許す。回数を数えて減らすのは、呼び出し側（Guard）である。
 * - `submissionWindowOpen`（T26g-1）: 送信の窓が開いている。開いている間は、許した POST のほかの読み取りの要求を止める。
 *   省略と `false` は閉じている。開け閉めは、呼び出し側（Guard）が決める。
 */
interface SubmissionStagePolicy {
  readonly remainingPosts: number;
  readonly submissionWindowOpen?: boolean | undefined;
}

/**
 * ログインの段だけの口（Task 25 の設計書 4.2。平らなデータ）。この口があることが、ログインの段であることを表す。
 * - `loginPostEndpoints`: 許す送信先の一覧。
 * - `remainingPosts`・`submissionWindowOpen`: `SubmissionStagePolicy`（窓は自動ログインの送信の窓）。
 */
export interface LoginStagePolicy extends SubmissionStagePolicy {
  readonly loginPostEndpoints: readonly LoginPostEndpoint[];
}

/**
 * 書き込みの段だけの口（T30b。Task 30 の設計書 3 章の「書き込みの段」、4 章。平らなデータ）。この口があることが、書き込みの段であることを
 * 表す。
 * - `writeEndpoint`: 承認の要求の形の送信先（Origin と path。method は `POST` だけ。query と fragment のある要求は許さない）。
 * - `remainingPosts`・`submissionWindowOpen`: `SubmissionStagePolicy`（窓は、値を入れ始める直前から、承認の POST を通すまで）。
 * 送る中身（enctype、欄の名前と値、文書の文字コード）の照合は、この判定の後に Guard が行う（`src/safety/write-payload-policy.ts`）。
 */
export interface WriteStagePolicy extends SubmissionStagePolicy {
  readonly writeEndpoint: SubmissionEndpoint;
}

/**
 * 監査の段の除外の口（Task 25 の設計書 4.1 の `excludedPaths`・`auditPathPrefixes`・既定の危険な語、4.2。平らなデータ）。一覧の値は
 * 呼び出し側（認証の設定の owner）から受ける。
 * - `excludedPathPrefixes`: 読まない path の前方一致（文字列の前方一致。大文字と小文字を区別しない）。
 * - `auditPathPrefixes`: 読む path の前方一致（文字列の前方一致。大文字と小文字を区別する）。空なら制限しない。
 * - `dangerousTerms`: path か query に含まれていたら読まない語（大文字と小文字を区別しない）。
 */
export interface AuditExclusionPolicy {
  readonly excludedPathPrefixes: readonly string[];
  readonly auditPathPrefixes: readonly string[];
  readonly dangerousTerms: readonly string[];
}

/**
 * `classifyPassiveRequest` の省略できる口。どれもなければ、今の判定（公開監査）と同じ。
 * T30b: ログインの段の口（`authSetup`）と書き込みの段の口（`writeStage`）を両方渡した場合は、どちらの POST も許さない（fail-closed。
 * factory はどちらか 1 つだけを渡す）。
 */
export interface PassiveRequestPolicyOptions {
  readonly authSetup?: LoginStagePolicy | undefined;
  readonly auditExclusions?: AuditExclusionPolicy | undefined;
  readonly writeStage?: WriteStagePolicy | undefined;
}

/**
 * 送信の段（ログインの段と書き込みの段）で許す method（HTTP の method は大文字と小文字を区別するので、この綴りだけ。T30b で共用にした）。
 */
export const SUBMISSION_POST_METHOD = 'POST';

/**
 * ログインの段で許す method（`SUBMISSION_POST_METHOD`）。認証の設定の送信先への POST かを調べるときの要求の事実（`isLoginEndpointPost`）と、
 * 回数の上限で止められたかの判定（`src/worker/login-stage-checks.ts`）も、この値を使う（CCX-15）。
 */
export const LOGIN_POST_METHOD = SUBMISSION_POST_METHOD;

/** 送信先かを調べるときの残りの回数（1 なら、送信先への POST は ALLOW になる。`isLoginEndpointPost`）。 */
const ONE_REMAINING_POST = 1;

/**
 * 除外の判定で、percent-encode を decode し直す回数の上限。上限まで decode しても変わり続ける URL は、除外に当たるものとして止める
 * （二重、三重の encode で語を隠す URL に備える。fail-closed）。
 */
const MAX_PERCENT_DECODE_ROUNDS = 4;

/** path の正規化（dot segment の解決）に使う、仮の基準の Origin。結果の pathname だけを使う。 */
const PATH_NORMALIZATION_BASE = 'http://path.invalid';

/**
 * 除外の判定で比べる path の形の数の上限（T25g-1）。形は、生の値と、それに「decode」「連続した `/` を 1 つにまとめる」「各 segment の
 * `;` から後を外す」「`.` と `..` を解決する」を、どの順でも重ねて得られる形のすべてである。4 つの変換は、それぞれ 2 回目から形を
 * 変えないので、ふつうは十数個に収まる。上限を超えた URL は、除外に当たるものとして止める（fail-closed）。
 */
const MAX_AUDIT_PATH_FORMS = 64;

/** path の形の `.` と `..` を解決するときに、path の一部のまま残すため percent-encode する区切りの文字（query と fragment の始まり）。 */
const PATH_DELIMITER_ESCAPES: ReadonlyMap<string, string> = new Map([['?', '%3F'], ['#', '%23']]);

export function isReadMethod(method: string): boolean {
  const normalizedMethod = method.toUpperCase();
  return normalizedMethod === 'GET' || normalizedMethod === 'HEAD';
}

/** Passive HTTP の許可Origin。正規化は URL の意味の owner（`canonicalizeAllowedOrigins`）に委譲する。 */
export function canonicalPassiveAllowedOrigins(allowedOrigins: ReadonlySet<string>): ReadonlySet<string> {
  return canonicalizeAllowedOrigins(allowedOrigins);
}

export function hasAllowedOrigin(url: string, allowedOrigins: ReadonlySet<string>): boolean {
  try {
    const candidate = new URL(url);
    return canonicalPassiveAllowedOrigins(allowedOrigins).has(candidate.origin);
  } catch {
    return false;
  }
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * ログインの送信先の path を、URL の解析器の規則（dot segment の解決）で正規化した値。`/` で始まらない値、`//` で始まる値（別の
 * host を指しうる）、query か fragment を含む値は `null`（どの要求にも当たらない）。
 */
function canonicalEndpointPath(path: string): string | null {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')) {
    return null;
  }
  const parsed = parseUrl(`${PATH_NORMALIZATION_BASE}${path}`);
  return parsed === null ? null : parsed.pathname;
}

/**
 * URL が、送信の段の送信先に当たるか（T30b でログインの段から共通にした比べ方）。次をすべて満たすときだけ真。
 * - URL が解析でき、認証情報を含まない。
 * - `queryAllowed` が偽なら、URL の文字列に `?` も `#` もない（空の query と fragment を含めて止める。書き込みの段）。
 * - Origin（許可 Origin と同じ意味の正規化）と path（URL の解析器が正規化した値。percent-encode は decode しない）が、送信先と完全に一致する。
 */
function matchesSubmissionEndpoint(url: string, endpoint: SubmissionEndpoint, queryAllowed: boolean): boolean {
  const candidate = parseUrl(url);
  if (candidate === null || hasUrlCredentials(candidate)) {
    return false;
  }
  if (!queryAllowed && (url.includes('?') || url.includes('#'))) {
    return false;
  }
  return canonicalEndpointPath(endpoint.path) === candidate.pathname && hasAllowedOrigin(url, new Set([endpoint.origin]));
}

/**
 * 要求が、送信の段（ログインの段と書き込みの段）で許す POST の形か（T30b でログインの段から共通にした条件）。次をすべて満たすときだけ真。
 * - method が `POST`、main frame のナビゲーション。
 * - URL の Origin が許可 Origin に含まれる。
 * - 残りの回数が 1 以上の整数。
 * - 送信先のどれかに当たる（`matchesSubmissionEndpoint`）。
 */
function isAllowedSubmissionPost(
  facts: HttpRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  remainingPosts: number,
  endpoints: readonly SubmissionEndpoint[],
  queryAllowed: boolean,
): boolean {
  if (
    facts.method !== SUBMISSION_POST_METHOD
    || !facts.isNavigationRequest
    || !facts.isMainFrame
    || !Number.isSafeInteger(remainingPosts)
    || remainingPosts < 1
    || !hasAllowedOrigin(facts.url, allowedOrigins)
  ) {
    return false;
  }
  return endpoints.some((endpoint) => matchesSubmissionEndpoint(facts.url, endpoint, queryAllowed));
}

/**
 * 要求が、ログインの段で許す POST か（Task 25 の設計書 4.2）。`isAllowedSubmissionPost` の条件で、query は問わない（path までで比べる）。
 */
function isAllowedLoginPost(facts: HttpRequestFacts, allowedOrigins: ReadonlySet<string>, policy: LoginStagePolicy): boolean {
  return isAllowedSubmissionPost(facts, allowedOrigins, policy.remainingPosts, policy.loginPostEndpoints, true);
}

/**
 * 要求が、書き込みの段で許す POST の形か（T30b。Task 30 の設計書 3 章）。`isAllowedSubmissionPost` の条件で、送信先は承認の要求の形の 1 つ
 * だけ、query と fragment は許さない。送る中身の照合は、この後に Guard が行う。
 */
function isAllowedWritePost(facts: HttpRequestFacts, allowedOrigins: ReadonlySet<string>, policy: WriteStagePolicy): boolean {
  return isAllowedSubmissionPost(facts, allowedOrigins, policy.remainingPosts, [policy.writeEndpoint], false);
}

/**
 * URL が、書き込みの段の送信先（承認の要求の形の Origin と path）に当たるか（T30b）。query と fragment のある URL、認証情報を含む URL、
 * 解析できない URL は偽。送る中身の照合（`src/safety/write-payload-policy.ts` の (a)）が、要求の判定と同じ比べ方で使う。
 */
export const isWriteEndpointUrl = (url: string, endpoint: SubmissionEndpoint): boolean =>
  matchesSubmissionEndpoint(url, endpoint, false);

/**
 * 送信の窓の中で、値を運べないブラウザ自身の favicon の要求か（T26g-1。「Blocker: T26g-1」の行）。GET で、許可 Origin の、path がちょうど
 * `BROWSER_DEFAULT_FAVICON_PATH` で、query と fragment がない（URL の文字列にも `?` と `#` がない）ときだけ真。
 */
function isPlainBrowserFavicon(facts: HttpRequestFacts, allowedOrigins: ReadonlySet<string>): boolean {
  const parsed = parseUrl(facts.url);
  return facts.method === 'GET'
    && parsed !== null
    && !facts.url.includes('?')
    && !facts.url.includes('#')
    && parsed.pathname === BROWSER_DEFAULT_FAVICON_PATH
    && hasAllowedOrigin(facts.url, allowedOrigins);
}

/**
 * 送信の段（ログインの段と書き込みの段）だけの制限（T26g-1。T30b で共通にした）。許した POST と、今の判定で止まる要求（GET と HEAD 以外、
 * 許可 Origin の外への main frame の移動）の後に、読み取りの要求に働く。送信の窓が開いていれば、すべて止める（favicon だけ理由を分ける）。
 * 閉じていれば、許可 Origin の外（解析できない URL を含む）を止める。止めなければ `null`。
 */
function submissionStageBlockReason(
  facts: HttpRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  policy: SubmissionStagePolicy,
): SubmissionStageBlockReason | null {
  if (policy.submissionWindowOpen === true) {
    return isPlainBrowserFavicon(facts, allowedOrigins) ? 'SUBMISSION_WINDOW_BROWSER_FAVICON' : 'SUBMISSION_WINDOW';
  }
  return hasAllowedOrigin(facts.url, allowedOrigins) ? null : 'OUTSIDE_ALLOWED_ORIGINS';
}

/**
 * percent-encode を、変わらなくなるまで decode する（`MAX_PERCENT_DECODE_ROUNDS` 回まで）。decode できない値と、上限まで変わり続ける値は
 * `null`（呼び出し側が止める）。
 */
function fullyDecoded(value: string): string | null {
  let current = value;
  for (let round = 0; round < MAX_PERCENT_DECODE_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) {
      return current;
    }
    current = next;
  }
  return null;
}

/** path の中の、連続した `/` を 1 つにまとめた形（T25g-1）。 */
function collapsedSlashesPath(path: string): string {
  return path.split('/').filter((segment, index, segments) => segment.length > 0 || index === 0 || index === segments.length - 1)
    .join('/');
}

/** path の各 segment の、`;` から後（path の引数）を外した形（T25g-1）。 */
function withoutSegmentParametersPath(path: string): string {
  return path.split('/').map((segment) => {
    const parameterStart = segment.indexOf(';');
    return parameterStart < 0 ? segment : segment.slice(0, parameterStart);
  }).join('/');
}

/**
 * path の `.` と `..` を URL の解析器で解決した形。解決できない値は `null`。decode した形に含まれる `?` と `#` は、path の一部のまま
 * 解決するため、percent-encode してから渡す（後ろを query や fragment として落とさない）。
 */
function resolvedDotSegmentsPath(path: string): string | null {
  const pathOnly = [...path.replace(/^\/+/u, '')]
    .map((character) => PATH_DELIMITER_ESCAPES.get(character) ?? character)
    .join('');
  return parseUrl(`${PATH_NORMALIZATION_BASE}/${pathOnly}`)?.pathname ?? null;
}

/** path の形を作る変換（作れない値は `null`）。 */
type PathFormTransform = (path: string) => string | null;

/** 読む範囲の判定に使う形の変換（T25g-1。大文字と小文字、Unicode の書き方は変えない）。 */
const AUDIT_SCOPE_PATH_TRANSFORMS: readonly PathFormTransform[] = Object.freeze([
  fullyDecoded,
  collapsedSlashesPath,
  withoutSegmentParametersPath,
  resolvedDotSegmentsPath,
]);

/**
 * 除外のパスと危険な語の判定に使う形の変換（T25g-1 round 1）。読む範囲の判定の変換に、Unicode の正規化（NFKC）と大文字小文字の
 * 畳み込み（`toUpperCase` の後に `toLowerCase`。owner は `src/core/text.ts` の `foldNfkcCase`。CCX-15）を加える（畳み込みでできた
 * `/`、`;`、`.` も、ほかの変換で重ねて扱う）。`ſ`（U+017F）は `s` に、ケルビン記号（U+212A）は `k` に、全角の英字と記号（`／`、`；` を
 * 含む）は ASCII になる。サーバが Unicode の規則で path を読む場合に備えて、除外のパスと危険な語の比べだけに使う（読む範囲の判定には
 * 使わない）。
 */
const EXCLUSION_MATCH_PATH_TRANSFORMS: readonly PathFormTransform[] = Object.freeze([
  ...AUDIT_SCOPE_PATH_TRANSFORMS,
  foldNfkcCase,
]);

/**
 * 比べる path の形のすべて（T25g-1）。生の path から始めて、`transforms` の変換（decode（`fullyDecoded`）、連続した `/` をまとめる、
 * 各 segment の引数を外す、`.` と `..` の解決。除外の比べでは、Unicode の正規化と大文字小文字の畳み込みも）を、新しい形が出なくなるまで
 * 重ねる。decode できない形があるか、形の数が `MAX_AUDIT_PATH_FORMS` を超える
 * 場合は `null`（呼び出し側が止める。fail-closed）。
 */
function auditPathForms(rawPath: string, transforms: readonly PathFormTransform[]): readonly string[] | null {
  const forms = new Set<string>([rawPath]);
  const pending = [rawPath];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    for (const transform of transforms) {
      const next = transform(path);
      if (next === null) {
        return null;
      }
      if (!forms.has(next)) {
        if (forms.size >= MAX_AUDIT_PATH_FORMS) {
          return null;
        }
        forms.add(next);
        pending.push(next);
      }
    }
  }
  return [...forms];
}

/**
 * 監査の段の除外に当たるか（Task 25 の設計書 4.2）。許可 Origin への要求だけを調べる（許可 Origin の外の要求は、今の判定のまま）。
 * 解析できない URL は、当たるものとする（fail-closed）。
 * - path は、`auditPathForms` のすべての形で調べる（生の値、decode した値、連続した `/` をまとめた形、各 segment の `;` から後を外した
 *   形、`.` と `..` を解決した形と、それらの重ね。T25g-1）。サーバがどの形で読んでもよいように、除外のパスと危険な語は、どれか 1 つの
 *   形に当たれば止める。この 2 つの比べには、Unicode の正規化と大文字小文字の畳み込みの形も加える（T25g-1 round 1）。
 * - 読む範囲は、畳み込みの形を使わずに（大文字と小文字を区別して）、すべての形が当たらなければ止める（畳み込みで範囲を広げない）。
 * - 危険な語は、path のすべての形と、query の生の値と decode した値（と、その畳み込みの形）を、小文字にして調べる。fragment はサーバに
 *   送られないので調べない。
 */
function isAuditExcluded(url: string, allowedOrigins: ReadonlySet<string>, policy: AuditExclusionPolicy): boolean {
  const parsed = parseUrl(url);
  if (parsed === null) {
    return true;
  }
  if (!hasAllowedOrigin(url, allowedOrigins)) {
    return false;
  }
  const scopePathForms = auditPathForms(parsed.pathname, AUDIT_SCOPE_PATH_TRANSFORMS);
  const matchPathForms = auditPathForms(parsed.pathname, EXCLUSION_MATCH_PATH_TRANSFORMS);
  const decodedQuery = fullyDecoded(parsed.search);
  if (scopePathForms === null || matchPathForms === null || decodedQuery === null) {
    return true;
  }
  const lowerPathVariants = matchPathForms.map((path) => path.toLowerCase());
  /** 比べる値（除外のパスと危険な語）の、小文字の形と畳み込みの形。空の値は、どれにも当たらない。 */
  const comparableValues = (value: string): readonly string[] =>
    [value.toLowerCase(), foldNfkcCase(value)].filter((candidate) => candidate.length > 0);
  if (policy.excludedPathPrefixes.some((prefix) =>
    comparableValues(prefix).some((candidate) => lowerPathVariants.some((path) => path.startsWith(candidate))))) {
    return true;
  }
  if (
    policy.auditPathPrefixes.length > 0
    && !scopePathForms.every((path) => policy.auditPathPrefixes.some((prefix) => path.startsWith(prefix)))
  ) {
    return true;
  }
  const searchedText = [
    ...lowerPathVariants,
    parsed.search.toLowerCase(),
    decodedQuery.toLowerCase(),
    foldNfkcCase(decodedQuery),
  ];
  return policy.dangerousTerms.some((term) =>
    comparableValues(term).some((candidate) => searchedText.some((text) => text.includes(candidate))));
}

/**
 * Passive の要求の判定（SSOT Owner Matrix の Passive HTTP authority の唯一の owner）。
 * - `policy` を省略した場合（と、空の場合）は、公開監査の判定（Task 22 の golden）と同じ。
 * - `policy.authSetup`（ログインの段の口）: 許した Origin と path への、main frame のナビゲーションの POST だけを ALLOW する
 *   （`isAllowedLoginPost`）。T26g-1: 加えて、今の判定で止まらない読み取りの要求のうち、許可 Origin の外へのもの（サブリソース、サブ frame の
 *   ナビゲーション）と、送信の窓の中のすべてを、`LOGIN_STAGE` で止める（`loginStageBlockReason`）。今の判定で止まる要求の判定と記録は
 *   変えない。
 * - `policy.auditExclusions`（監査の段の除外の口）: 許可 Origin への GET と HEAD でも、除外に当たる URL を BLOCK する
 *   （`isAuditExcluded`。main frame でもサブの要求でも）。GET と HEAD 以外の拒否、WebSocket、許可 Origin の外への main frame の移動の
 *   判定が先に働く。
 * - `policy.writeStage`（書き込みの段の口。T30b）: 承認の要求の形に完全に一致する（query と fragment なし）、main frame のナビゲーションの
 *   POST だけを、残りの回数が 1 以上のときに ALLOW する（`isAllowedWritePost`。送る中身の照合は、その後に Guard が行う）。ほかの要求は、
 *   ログインの段と同じく、許可 Origin の外と、送信の窓の中のすべてを `WRITE_STAGE` で止める（`submissionStageBlockReason`）。
 * - `authSetup` と `writeStage` を両方渡した場合は、どちらの POST も ALLOW しない（fail-closed）。窓と許可 Origin の制限は、両方の口で働く。
 */
export function classifyPassiveRequest(
  facts: PassiveRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  policy: PassiveRequestPolicyOptions = {},
): PassiveRequestDecision {
  if (facts.kind === 'WEBSOCKET') {
    return { action: 'BLOCK', category: 'WEBSOCKET', reason: 'PASSIVE_WEBSOCKET' };
  }
  const singleSubmissionStage = policy.authSetup === undefined || policy.writeStage === undefined;
  if (singleSubmissionStage && policy.authSetup !== undefined && isAllowedLoginPost(facts, allowedOrigins, policy.authSetup)) {
    return { action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' };
  }
  if (singleSubmissionStage && policy.writeStage !== undefined && isAllowedWritePost(facts, allowedOrigins, policy.writeStage)) {
    return { action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' };
  }
  if (!isReadMethod(facts.method)) {
    return { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' };
  }
  if (
    facts.isNavigationRequest
    && facts.isMainFrame
    && !hasAllowedOrigin(facts.url, allowedOrigins)
  ) {
    return {
      action: 'BLOCK',
      category: 'NAVIGATION',
      reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION',
    };
  }
  if (policy.authSetup !== undefined) {
    const loginStageReason = submissionStageBlockReason(facts, allowedOrigins, policy.authSetup);
    if (loginStageReason !== null) {
      return { action: 'BLOCK', category: 'LOGIN_STAGE', reason: loginStageReason };
    }
  }
  if (policy.writeStage !== undefined) {
    const writeStageReason = submissionStageBlockReason(facts, allowedOrigins, policy.writeStage);
    if (writeStageReason !== null) {
      return { action: 'BLOCK', category: 'WRITE_STAGE', reason: writeStageReason };
    }
  }
  if (policy.auditExclusions !== undefined && isAuditExcluded(facts.url, allowedOrigins, policy.auditExclusions)) {
    return { action: 'BLOCK', category: 'AUDIT_EXCLUSION', reason: 'AUDIT_EXCLUDED_URL' };
  }
  return {
    action: 'ALLOW',
    delivery: facts.isNavigationRequest && facts.isMainFrame ? 'INSPECT_REDIRECTS' : 'DIRECT',
  };
}

/**
 * 認証の設定の送信先への POST か（CCX-15。共通化の台帳の CC-064。T26d-1 で `src/worker/login-stage-checks.ts` に置いたものを、要求の判定の
 * owner に移した）。`url` への main frame のナビゲーションの POST を、残りの回数 1 のログインの段の口で判定して ALLOW になるか
 * （`isAllowedLoginPost` の条件）。自動ログインの段の送信先の確かめ（入力の部品に渡す `isAllowedAction`、送信の観察）と、回数の上限で
 * 止められたかの判定（`loginAttemptsExceeded`）が使う。
 */
export const isLoginEndpointPost = (
  url: string,
  allowedOrigins: ReadonlySet<string>,
  loginPostEndpoints: readonly LoginPostEndpoint[],
): boolean =>
  classifyPassiveRequest(
    { kind: 'HTTP', method: LOGIN_POST_METHOD, url, isNavigationRequest: true, isMainFrame: true },
    allowedOrigins,
    { authSetup: { loginPostEndpoints, remainingPosts: ONE_REMAINING_POST } },
  ).action === 'ALLOW';

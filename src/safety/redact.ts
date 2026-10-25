import { REDACTED } from '../core/redaction.js';
import { asHttpSchemeUrl, redactServiceOriginUrl, redactUrlQueryValues } from '../core/url-redaction.js';
import { canonicalizeAllowedOrigins, redactUrlCredentials } from '../crawl/normalize-url.js';
import { isSecretLikeHeaderName, isSecretUrlQueryParameterName } from '../core/secret-query-names.js';
import { hasAllowedOrigin } from './request-policy.js';

/**
 * header の値のうち、名前が秘密に見えるものを `REDACTED` にした写し（名前は書かれたまま残す。入力は変えない）。CCX-4: 名前の語の一覧と
 * 比べ方（header の部分一致の方針）の owner は `src/core/secret-query-names.ts` の `isSecretLikeHeaderName`。
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, isSecretLikeHeaderName(name) ? REDACTED : value]));
}

// ---------------------------------------------------------------------------------------------------------------
// 認証つきの Run の URL の伏せ字（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 4.6。T25f）
// - 認証つきの Run の成果物（Run のディレクトリのファイル）と知らせ（`RunNotice`）に書く URL の、秘密に見える query の値を `REDACTED` にする。
//   userinfo は、URL の owner の `redactUrlCredentials` と同じ規則で伏せる（ここで新しく判定しない）。
// - 公開監査では使わない（呼び出し側が、認証つきの Run のときだけ通す。公開監査の出力は変えない）。
// - 巡回の判定（同じページかどうか、重複の除去）には使わない（伏せ字の前の URL で判定する。伏せ字で別のページが同じに見えないように）。
// ---------------------------------------------------------------------------------------------------------------

// T27c: 値を伏せる query の名前の一覧と判定の owner は `src/core/secret-query-names.ts`（`src/control/` からも使うため）。ここは今の名前のまま
// 公開し直す（振る舞いは変えない）。
export { SECRET_URL_QUERY_PARAMETER_NAMES, isSecretUrlQueryParameterName } from '../core/secret-query-names.js';

/** query の始まり（伏せる対象になりうる URL の候補の印）。 */
const QUERY_START = '?';

/**
 * URL（絶対でも相対でもよい。成果物に書く形のまま）の秘密を伏せる。
 * 1. userinfo は、`redactUrlCredentials` で伏せる（今の規則と同じ）。
 * 2. query の組のうち、名前が値を伏せる名前（`isSecretUrlQueryParameterName`）の組の値を伏せる（組の扱いの owner は `src/core/url-redaction.ts` の
 *    `redactUrlQueryValues`。T35c で移した）。ほかの部分（path、値を伏せない組、区切り）は、書かれたまま残す。
 * 3. fragment（`#` から後）は触らない。`#` が `?` より前にあれば、query はない。
 * 同じ値を 2 回通しても変わらない。
 */
export function redactUrlSecrets(url: string): string {
  return redactUrlQueryValues(redactUrlCredentials(url), isSecretUrlQueryParameterName);
}

/**
 * URL の伏せ方の指定（T35c。Task 35 の設計書 3.6）。`serviceOrigins` は、承認したサービスの Origin（スクリプトで送るログインの監査の Run だけ）。その
 * Origin の URL は、秘密に見える名前の値に加えて、query のすべての値と path の値に見える区切りを伏せる（`redactServiceOriginUrl`）。
 */
export interface UrlSecretRedactionOptions {
  readonly serviceOrigins?: readonly string[] | undefined;
}

/** 文の中の、URL の候補（空白、引用符、`<`、`>`、backtick を含まない連なり）。 */
const URL_CANDIDATE = /[^\s"'<>`]+/gu;
/** URL の候補のうち、伏せる対象になりうるもの（query か userinfo の印を持つ）。 */
const USERINFO_MARK = '@';
/**
 * 絶対形の URL の scheme と区切り（`http://`・`https://`・`ws://`・`wss://`）の正規表現の本文。T44R2 の M-9: この正規表現の唯一の定義（`src/safety/` の
 * 文の中の URL を探す部品が、`absoluteUrlPattern` で組み立てて使う）。
 */
const ABSOLUTE_URL_SCHEME_SOURCE = String.raw`(?:https?|wss?):\/\/`;

/**
 * 絶対形の URL の scheme と区切りに、続きの文字の正規表現の本文（`continuation`。省略は続きなし）を足した、大文字と小文字を区別しない全体の正規表現
 * （`g`・`i`・`u`）を作る（T44R2 の M-9）。呼ぶたびに新しい正規表現を返す（`lastIndex` を共有しない）。
 */
export const absoluteUrlPattern = (continuation = ''): RegExp => new RegExp(`${ABSOLUTE_URL_SCHEME_SOURCE}${continuation}`, 'giu');

/**
 * 候補の中の、絶対形の URL の始まり（`http://`・`https://`・`ws://`・`wss://`。大文字と小文字を区別しない）。T35R-fix（T35R の I-1）: 前置き（`url=`・
 * `(`・`[`・`{url:`・`x,` など）の後や、ほかの URL の query の中に入った URL も、ここから Origin を判定する。
 */
const ABSOLUTE_URL_START = absoluteUrlPattern();

/**
 * 候補を、絶対形の URL の始まりごとに区切る（最初の区切りは、始まりの前の前置き。空のこともある）。区切りをつなぐと、もとの候補になる。
 */
const splitAtAbsoluteUrlStarts = (candidate: string): readonly string[] => {
  const starts = [...candidate.matchAll(ABSOLUTE_URL_START)].map(({ index }) => index).filter((index) => index > 0);
  const bounds = [0, ...starts, candidate.length];
  return bounds.slice(0, -1).map((start, position) => candidate.slice(start, bounds[position + 1]));
};

/** 区切りが、承認したサービスの Origin の URL か（WebSocket の URL は http(s) に読み替えて、Origin の照合の owner `hasAllowedOrigin` で比べる）。 */
const isServiceOriginUrl = (part: string, serviceOrigins: ReadonlySet<string>): boolean =>
  hasAllowedOrigin(asHttpSchemeUrl(part), serviceOrigins);

/**
 * 候補の中の、承認したサービスの Origin の URL を伏せる（T35R2-fix。T35R2 の I-1）。始まりごとに区切ったうち、最初のサービスの Origin の URL から
 * 候補の終わりまで（その URL の query の値に入った別の絶対形の URL を含む）を、1 つの URL として `redactServiceOriginUrl` で伏せる。その前の部分
 * （前置きと、ほかの Origin の URL）は変えない（その中に、サービスの Origin の URL の始まりはない）。
 */
const redactServiceOriginUrlsInCandidate = (candidate: string, serviceOrigins: ReadonlySet<string>): string => {
  const parts = splitAtAbsoluteUrlStarts(candidate);
  const first = parts.findIndex((part) => isServiceOriginUrl(part, serviceOrigins));
  return first < 0 ? candidate : `${parts.slice(0, first).join('')}${redactServiceOriginUrl(parts.slice(first).join(''))}`;
};

/**
 * 文（誤りの文、console の文、可視テキストなど、URL を含みうる任意の文字列）の中の URL の候補ごとに、`redactUrlSecrets` を通す。候補は、
 * 空白・引用符・`<`・`>`・backtick で区切った連なりのうち、`?` か `@` を含むもの。ほかの文字は変えない。T35c: 承認したサービスの Origin の URL は、
 * 先に `redactServiceOriginUrl` を通す（`?` を含まなくても）。T35R-fix（T35R の I-1・M-2）: 候補の中の絶対形の URL の始まりごとに区切って、区切りごとに
 * Origin を判定する（前置きの後の URL、ほかの URL の query の中の URL、サービスのホストへの WebSocket の URL も伏せる）。T35R2-fix（T35R2 の I-1）:
 * サービスの Origin の URL は、区切る前の全体（query の値に入った別の URL を含む）を伏せる（`redactServiceOriginUrlsInCandidate`）。
 */
export function redactUrlSecretsInText(text: string, options: UrlSecretRedactionOptions = {}): string {
  const serviceOrigins = canonicalizeAllowedOrigins(options.serviceOrigins ?? []);
  return text.replace(URL_CANDIDATE, (candidate) => {
    const serviceRedacted = serviceOrigins.size === 0 ? candidate : redactServiceOriginUrlsInCandidate(candidate, serviceOrigins);
    return serviceRedacted.includes(QUERY_START) || serviceRedacted.includes(USERINFO_MARK) ? redactUrlSecrets(serviceRedacted) : serviceRedacted;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// 記録した要求の URL の伏せ字（T44g。Task 44 の設計書 P4-1 と、設計の変更の履歴の「T44g の Blocker」の行。案 2）
// - 成果物に書く前に（判定の後に）、記録した要求の URL の、query のすべての値・値に見える path の区切り・fragment の値・userinfo を伏せる。規則は、承認した
//   サービスの Origin の URL と同じ `redactServiceOriginUrl` に、userinfo の `redactUrlCredentials` を加えたもの（この 1 か所）。名前は残す。
// - 当てるのは、値の木の中の、要求の URL の一覧の名前（`RECORDED_REQUEST_URL_LIST_NAMES`）の配列の項目の `url` だけ（network の Evidence の要求・応答・失敗、
//   resource timing、Safety の止めた記録。`blockedAuditExclusions` は、その `events`）。ページの URL・リンク・Finding の本文などは変えない（限界は
//   `doc/spec/output.md`・`safety.md`）。判定（リダイレクトの連鎖、Finding の identity）は、伏せる前の値で行う（呼び出し側は書き手だけ）。
// - セッションの切れの URL（`sessionLostUrl`）にも、同じ規則の `redactRecordedRequestUrl` を当てる（ワーカー）。
// ---------------------------------------------------------------------------------------------------------------

/**
 * 値の木の中で、項目の `url` を記録した要求の URL として伏せる配列の名前（閉じた一覧）。network の Evidence（`requests`・`responses`・`failures`）、
 * performance の Evidence の resource timing（`resources`）、Safety の Evidence と Safety Ledger の snapshot の止めた記録（`blocked*`）。
 */
export const RECORDED_REQUEST_URL_LIST_NAMES = Object.freeze([
  'requests',
  'responses',
  'failures',
  'resources',
  'blockedRequests',
  'blockedNavigations',
  'blockedWebSockets',
  'blockedExternalActions',
  'blockedInteractionRequests',
  'blockedInteractionNavigations',
  'blockedPopups',
  'blockedDownloads',
  'blockedInteractionWebSockets',
  // T44R の C-1: performance の server timing、計測の header と候補（どれも、記録した要求の URL を `url` に持つ）。
  'serverTiming',
  'telemetryHeaders',
  'telemetryCandidates',
] as const);

/**
 * 止めた記録のうち、`events` に項目を持つ記録の名前（その `events` の項目の `url` を伏せる）。監査の段の除外の記録（`BlockedAuditExclusionsRecord`）と、BN-a の
 * 閉じる途中に止めた要求の記録（`BlockedClosingRequestsRecord`）。
 */
const BLOCKED_EVENT_RECORD_NAMES: ReadonlySet<string> = new Set(['blockedAuditExclusions', 'blockedClosingRequests']);
const BLOCKED_AUDIT_EXCLUSION_EVENTS_NAME = 'events';
const RECORDED_REQUEST_URL_LISTS: ReadonlySet<string> = new Set(RECORDED_REQUEST_URL_LIST_NAMES);

/**
 * 記録した要求の URL の、query のすべての値・値に見える path の区切り・fragment の値・userinfo を伏せる（名前は残す。同じ値を 2 回通しても変わらない）。
 */
export function redactRecordedRequestUrl(url: string): string {
  return redactServiceOriginUrl(redactUrlCredentials(url));
}

/**
 * T44R の C-1（Task 44 の設計書の履歴の「T44R …と設計者の判断」の行。(a)）: 記録した要求の URL の一覧のほかに、同じ値を持つ項目の名前で伏せる欄。
 * - 画像の記録（DOM の Evidence の `images`）の `src`（相対のこともある）と `resolvedUrl`。
 * - console の記録（`consoleMessages`）の項目の `location.url`。
 * - ページの誤りの記録（`pageErrors`）の項目の `stack`（文の中の絶対形の URL ごとに伏せる）。
 * - header の値の一覧（`values`）の `location`・`content-location`・`refresh`（大文字と小文字を問わない。`refresh` の `url=` の後も、query の値を伏せる）。
 */
const IMAGE_URL_LIST_NAME = 'images';
const IMAGE_URL_FIELDS: readonly string[] = Object.freeze(['src', 'resolvedUrl']);
const CONSOLE_MESSAGES_NAME = 'consoleMessages';
const CONSOLE_LOCATION_NAME = 'location';
const PAGE_ERRORS_NAME = 'pageErrors';
const PAGE_ERROR_STACK_NAME = 'stack';
const HEADER_VALUES_NAME = 'values';
const URL_HEADER_NAMES: ReadonlySet<string> = new Set(['location', 'content-location', 'refresh']);
const URL_FIELD = 'url';
/** 文の中の絶対形の URL（`http(s)`・`ws(s)`。空白、引用符、`<`、`>`、backtick、`)` で終わる）。 */
const ABSOLUTE_URL_IN_TEXT = absoluteUrlPattern(String.raw`[^\s"'<>` + '`' + String.raw`)]+`);
/** (b) で照らす、path と query の形の最小の長さ（短すぎる形で、ふつうの文を伏せない）。 */
const MIN_MATCHED_URL_FORM_LENGTH = 4;

/** 文の中の絶対形の URL ごとに `redactRecordedRequestUrl` を当てる（置き換えは関数で行い、置き換えの文字列の特別な記法を使わない）。 */
const redactAbsoluteUrlsInText = (text: string): string => text.replace(ABSOLUTE_URL_IN_TEXT, (url) => redactRecordedRequestUrl(url));

/**
 * 伏せる前と後の値の組を覚える段（(b) で、同じ値を持つほかの文字列を伏せるため）。T44R3 の I-1: 照らさない値は、ページの identity に限る
 * （`pageIdentities` と `loadedDocuments`）。
 */
interface RecordedUrlRedactions {
  /** 照らす値（伏せる前 → 伏せた後）。 */
  readonly pairs: Map<string, string>;
  /** 照らす値のうち、止めた記録（`blocked*`・監査の段の除外）の項目の、伏せる前の値（`pageIdentities` に等しいものだけを除く）。 */
  readonly blocked: Set<string>;
  /** ページの URL（値の木の中の `pageUrl`・`finalUrl`）と、呼び出し側が渡す巡回の URL（`keptUrls`）。 */
  readonly pageIdentities: Set<string>;
  /** 許して読み込んだ main frame の文書の要求（応答のあるもの）と、そのリダイレクトの連鎖の要求の URL。 */
  readonly loadedDocuments: Set<string>;
}

/** ページの identity の欄の名前（値の木のどこでも、文字列なら照らさない値）。 */
const PAGE_IDENTITY_FIELDS: ReadonlySet<string> = new Set(['pageUrl', 'finalUrl', 'requestedUrl', 'startUrl']);
/** network の Evidence の、要求と応答の一覧の名前と、要求の ID・リダイレクトの連鎖の欄の名前（`NetworkRequestEvidence`・`NetworkResponseEvidence`）。 */
const NETWORK_REQUESTS_NAME = 'requests';
const NETWORK_RESPONSES_NAME = 'responses';
const REQUEST_ID_FIELD = 'requestId';
const REDIRECT_CHAIN_FIELD = 'redirectChainRequestIds';
/** 止めた記録の一覧の名前の印（`blockedRequests` など。監査の段の除外の `blockedAuditExclusions.events` も止めた記録）。 */
const BLOCKED_LIST_PREFIX = 'blocked';

/** 欄の値を伏せ、伏せる前と後が違えば、組を覚える（`blocked` が真なら、止めた記録の値として覚える）。 */
const redactRecordedField = (value: string, redactions: RecordedUrlRedactions, blocked = false): string => {
  const redacted = redactRecordedRequestUrl(value);
  if (redacted !== value) {
    redactions.pairs.set(value, redacted);
    if (blocked) {
      redactions.blocked.add(value);
    }
  }
  return redacted;
};

/** 記録した要求の一覧の項目（`url` の欄）を伏せる（`blocked` が真なら、止めた記録の項目）。 */
const redactRequestUrlItem = (item: unknown, redactions: RecordedUrlRedactions, blocked = false): unknown => {
  const walked = redactStructurally(item, redactions);
  if (!isPlainObject(walked) || typeof walked[URL_FIELD] !== 'string') {
    return walked;
  }
  return { ...walked, [URL_FIELD]: redactRecordedField(walked[URL_FIELD], redactions, blocked) };
};

/** 項目の文字列の欄の値（文字列でなければ `null`）。 */
const stringFieldOf = (item: unknown, field: string): string | null => {
  const value = isPlainObject(item) ? item[field] : undefined;
  return typeof value === 'string' ? value : null;
};

/**
 * T44R3 の I-1: network の Evidence（要求と応答の一覧を持つ値）から、許して読み込んだ main frame の文書の要求（応答のあるもの）と、そのリダイレクトの連鎖の
 * 要求の URL を覚える（伏せる前の値）。応答のない main frame の文書の要求（止めた POST の form の送信など）は覚えない（照らす）。
 */
const rememberLoadedDocuments = (value: Record<string, unknown>, redactions: RecordedUrlRedactions): void => {
  const requests = value[NETWORK_REQUESTS_NAME];
  const responses = value[NETWORK_RESPONSES_NAME];
  if (!Array.isArray(requests) || !Array.isArray(responses)) {
    return;
  }
  const responded = new Set(responses.map((response: unknown) => stringFieldOf(response, REQUEST_ID_FIELD)));
  const urlsById = new Map(requests.map((request: unknown) => [stringFieldOf(request, REQUEST_ID_FIELD), stringFieldOf(request, URL_FIELD)] as const));
  for (const request of requests) {
    const id = stringFieldOf(request, REQUEST_ID_FIELD);
    const url = stringFieldOf(request, URL_FIELD);
    if (!isPlainObject(request) || id === null || url === null || request['isNavigationRequest'] !== true || request['isMainFrame'] !== true || !responded.has(id)) {
      continue;
    }
    redactions.loadedDocuments.add(url);
    const chain = request[REDIRECT_CHAIN_FIELD];
    for (const chainId of Array.isArray(chain) ? chain : []) {
      const chained = typeof chainId === 'string' ? urlsById.get(chainId) : undefined;
      if (typeof chained === 'string') {
        redactions.loadedDocuments.add(chained);
      }
    }
  }
};

/** 項目の名前の欄（`fields`）の文字列を伏せる（画像の記録）。 */
const redactNamedFields = (item: unknown, fields: readonly string[], redactions: RecordedUrlRedactions): unknown => {
  const walked = redactStructurally(item, redactions);
  if (!isPlainObject(walked)) {
    return walked;
  }
  const copy: Record<string, unknown> = { ...walked };
  for (const field of fields) {
    const value = copy[field];
    if (typeof value === 'string') {
      copy[field] = redactRecordedField(value, redactions);
    }
  }
  return copy;
};

/** (a) の段: 項目の名前で伏せる（値の木の写し）。 */
const redactStructurally = (value: unknown, redactions: RecordedUrlRedactions): unknown => {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactStructurally(item, redactions));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  rememberLoadedDocuments(value, redactions);
  return Object.fromEntries(Object.entries(value).map(([name, item]) => {
    if (PAGE_IDENTITY_FIELDS.has(name) && typeof item === 'string') {
      redactions.pageIdentities.add(item);
      return [name, item];
    }
    if (RECORDED_REQUEST_URL_LISTS.has(name) && Array.isArray(item)) {
      const blocked = name.startsWith(BLOCKED_LIST_PREFIX);
      return [name, item.map((entry: unknown) => redactRequestUrlItem(entry, redactions, blocked))];
    }
    if (BLOCKED_EVENT_RECORD_NAMES.has(name) && isPlainObject(item) && Array.isArray(item[BLOCKED_AUDIT_EXCLUSION_EVENTS_NAME])) {
      const walked = redactStructurally(item, redactions) as Record<string, unknown>;
      const events = (item[BLOCKED_AUDIT_EXCLUSION_EVENTS_NAME] as unknown[]).map((entry) => redactRequestUrlItem(entry, redactions, true));
      return [name, { ...walked, [BLOCKED_AUDIT_EXCLUSION_EVENTS_NAME]: events }];
    }
    if (name === IMAGE_URL_LIST_NAME && Array.isArray(item)) {
      return [name, item.map((entry: unknown) => redactNamedFields(entry, IMAGE_URL_FIELDS, redactions))];
    }
    if (name === CONSOLE_MESSAGES_NAME && Array.isArray(item)) {
      return [name, item.map((entry: unknown) => {
        const walked = redactStructurally(entry, redactions);
        if (!isPlainObject(walked) || !isPlainObject(walked[CONSOLE_LOCATION_NAME])) {
          return walked;
        }
        return { ...walked, [CONSOLE_LOCATION_NAME]: redactNamedFields(walked[CONSOLE_LOCATION_NAME], [URL_FIELD], redactions) };
      })];
    }
    if (name === PAGE_ERRORS_NAME && Array.isArray(item)) {
      return [name, item.map((entry: unknown) => {
        const walked = redactStructurally(entry, redactions);
        const stack = isPlainObject(walked) ? walked[PAGE_ERROR_STACK_NAME] : undefined;
        return typeof stack === 'string' ? { ...(walked as Record<string, unknown>), [PAGE_ERROR_STACK_NAME]: redactAbsoluteUrlsInText(stack) } : walked;
      })];
    }
    if (name === HEADER_VALUES_NAME && isPlainObject(item)) {
      return [name, Object.fromEntries(Object.entries(item).map(([header, headerValue]) => [
        header,
        typeof headerValue === 'string' && URL_HEADER_NAMES.has(header.toLowerCase()) ? redactRecordedRequestUrl(headerValue) : redactStructurally(headerValue, redactions),
      ]))];
    }
    return [name, redactStructurally(item, redactions)];
  }));
};

/** URL の、authority の後の path と query（と fragment）の形（`/a?x=1`。query か fragment がなければ `null`）。 */
const pathAndQueryOf = (url: string): string | null => {
  const authorityStart = url.indexOf('://');
  const pathStart = authorityStart < 0 ? -1 : url.indexOf('/', authorityStart + '://'.length);
  const suffix = pathStart < 0 ? null : url.slice(pathStart);
  return suffix !== null && (suffix.includes('?') || suffix.includes('#')) ? suffix : null;
};

/** T44R2 の I-3: HTML の文字の参照の形（`&` → `&amp;`。アクセシビリティの HTML の断片などに入る形）。 */
const HTML_AMPERSAND = '&';
const HTML_AMPERSAND_REFERENCE = '&amp;';
const htmlEscapedFormOf = (text: string): string => text.split(HTML_AMPERSAND).join(HTML_AMPERSAND_REFERENCE);

/** URL の値と、その path と query の形と、それぞれの HTML の文字の参照の形を、集まりに加える。 */
const addIdentityForms = (excluded: Set<string>, urls: Iterable<string>): void => {
  for (const url of urls) {
    for (const form of [url, pathAndQueryOf(url)]) {
      if (form !== null) {
        excluded.add(form);
        excluded.add(htmlEscapedFormOf(form));
      }
    }
  }
};

/**
 * (b) で引く表。`tokens` は字句 → 伏せた字句。T44R4 の I-1: `identities` は、ページの identity の形の集まり（`pageIdentities` と `loadedDocuments` の
 * 値と、その path と query の形と、それぞれの HTML の文字の参照の形）。`identityCores` は、その形のうち末尾に外す字（`trailingStartOf`）を持つものの、
 * 外した芯の集まり（外して引く形が、identity の形を書き換えないため。T44R5 の m-1: 芯ごとの一覧は持たない）。
 */
interface MatchTable {
  readonly tokens: ReadonlyMap<string, string>;
  readonly identities: ReadonlySet<string>;
  readonly identityCores: ReadonlySet<string>;
}

/** identity の形のうち、末尾に外す字を持つものの、外した芯の集まり（時間は identity の形の全体の長さに比例する）。 */
const identityCoresOf = (identities: ReadonlySet<string>): ReadonlySet<string> => {
  const cores = new Set<string>();
  for (const form of identities) {
    const start = trailingStartOf(form);
    if (start < form.length) {
      cores.add(form.slice(0, start));
    }
  }
  return cores;
};

/**
 * (b) で引く表（`MatchTable`）。T44R2 の I-1・I-2・I-3: 記録した要求の URL と、その path と query の形と、それぞれの HTML の文字の参照の形を入れる。
 * T44R3 の I-1: ページの identity（`pageIdentities` と `loadedDocuments`）の形は入れない（ページの identity を変えない）。止めた記録の値は、
 * `pageIdentities` の形だけを除く（読み込んだ文書の要求に等しくても照らす）。
 */
const matchTableOf = (redactions: RecordedUrlRedactions): MatchTable => {
  const pageExcluded = new Set<string>();
  addIdentityForms(pageExcluded, redactions.pageIdentities);
  const identityExcluded = new Set(pageExcluded);
  addIdentityForms(identityExcluded, redactions.loadedDocuments);
  const tokens = new Map<string, string>();
  const add = (before: string, redacted: string, excluded: ReadonlySet<string>): void => {
    for (const [form, replacement] of [[before, redacted], [htmlEscapedFormOf(before), htmlEscapedFormOf(redacted)]] as const) {
      if (form !== replacement && form.length >= MIN_MATCHED_URL_FORM_LENGTH && !excluded.has(form)) {
        tokens.set(form, replacement);
      }
    }
  };
  for (const [before, redacted] of redactions.pairs) {
    const excluded = redactions.blocked.has(before) ? pageExcluded : identityExcluded;
    add(before, redacted, excluded);
    const suffix = pathAndQueryOf(before);
    if (suffix !== null) {
      add(suffix, redactRecordedRequestUrl(suffix), excluded);
    }
  }
  return { tokens, identities: identityExcluded, identityCores: identityCoresOf(identityExcluded) };
};

/**
 * 字句の中の、ASCII の印字できる文字の連なり（空白を除く）。記録した要求の URL は、ブラウザが直列化した ASCII の形（非 ASCII は百分率の符号化）なので、
 * 非 ASCII の文字（Finding の文の「）。」など）は、その URL の続きにならない。
 */
const ASCII_RUN = /[\x21-\x7e]+/gu;
/** T44R3 の M-1: 連なりの先頭から外す字（CSS の `url(` か `(`。どちらか 1 つ）。 */
const LEADING_BRACKET = /^(?:url\(|\()/u;
/** T44R3 の M-1: 連なりの末尾から外す字（閉じ括弧・`,`・`.`）。その前の、stack の行と列（`:\d+(:\d+)?`）も外す。 */
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([')', ']', '}', ',', '.']);
const POSITION_SEPARATOR = ':';
const MAX_POSITION_PARTS = 2;
/** T44R3 の M-1: 連なりの中の CSS の `url(…)`（中身に括弧を含まないもの。中身を引く）。 */
const CSS_URL_FUNCTION_MARK = 'url(';
const CSS_URL_FUNCTION = /url\(([^()]*)\)/gu;

const isAsciiDigit = (character: string | undefined): boolean => character !== undefined && character >= '0' && character <= '9';

/** 連なりの末尾の、外す部分の始まり（閉じ括弧・`,`・`.` の連なりと、その前の `:\d+` を 2 つまで。時間は外す部分の長さに比例する）。 */
const trailingStartOf = (run: string): number => {
  let end = run.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(run.charAt(end - 1))) {
    end -= 1;
  }
  for (let part = 0; part < MAX_POSITION_PARTS; part += 1) {
    let digits = end;
    while (digits > 0 && isAsciiDigit(run[digits - 1])) {
      digits -= 1;
    }
    if (digits === end || digits === 0 || run[digits - 1] !== POSITION_SEPARATOR) {
      break;
    }
    end = digits - 1;
  }
  return end;
};

/**
 * T44R5 の m-1: 外した末尾の、外す字の連なりの中で見る区切りの数の上限（引く回数を定数にし、時間を字句の長さに比例させる）。外す字（閉じ括弧・`,`・`.`）は
 * 1 字ずつが外す単位なので、連なりの始まりから 1 字ごとの位置を、この数まで区切りにする。
 */
const MAX_PUNCTUATION_BOUNDARIES = 3;

/**
 * T44R5 の m-1・m-2: 外した末尾（`(:\d+){0,2}` と、外す字の連なり）の区切りの位置（先頭、`:` の位置、外す字の連なりの始まりと、そこから 1 字ごとの
 * 位置（`MAX_PUNCTUATION_BOUNDARIES` まで）、末尾）。比べるのは、この区切りまでの前の部分だけ（行と列の数字は、字の単位では比べない）。
 */
const tailBoundariesOf = (tail: string): readonly number[] => {
  const boundaries: number[] = [];
  let position = 0;
  while (position < tail.length && tail[position] === POSITION_SEPARATOR) {
    boundaries.push(position);
    position += 1;
    while (position < tail.length && isAsciiDigit(tail[position])) {
      position += 1;
    }
  }
  boundaries.push(position);
  const lastPunctuationBoundary = Math.min(tail.length - 1, position + MAX_PUNCTUATION_BOUNDARIES);
  for (let index = position + 1; index <= lastPunctuationBoundary; index += 1) {
    boundaries.push(index);
  }
  boundaries.push(tail.length);
  return boundaries;
};

/**
 * T44R4 の I-1: 先頭を外した連なり（`rest`）が、ページの identity の形か、外す途中で identity の形になるか（例: ページの URL `…?id=1.` の文の
 * `(…?id=1.)`）。真なら、外して引く形で替えない。T44R5 の m-1・m-2: 芯が identity の形の芯なら、外した末尾を区切り（`tailBoundariesOf`）ごとに切り、
 * `identities.has(芯 + 切った末尾)` で引く（一覧をたどらない。引く回数は定数）。
 */
const isIdentityForm = (rest: string, core: string, tail: string, table: MatchTable): boolean =>
  table.identities.has(rest)
  || (table.identityCores.has(core) && tailBoundariesOf(tail).some((boundary) => table.identities.has(`${core}${tail.slice(0, boundary)}`)));

/**
 * ASCII の連なりを引く（T44R3 の M-1）。まるごと等しければ伏せた形（表は identity の形を持たない）。T44R4 の I-1: 連なりか、先頭を外した形が、ページの
 * identity の形（か、外す途中で identity の形になるもの）なら、替えずに返す。ほかは、先頭の `url(`・`(` と末尾の閉じ括弧・`,`・`.`・行と列を外した形が
 * 等しければ、外した字を残して替える。ほかは、連なりの中の CSS の `url(…)` の中身を引く。どれでもなければ連なりのまま（接頭辞の誤一致を増やさないよう、
 * 外すのはこれらの字だけ）。
 */
const replacedRunOf = (run: string, table: MatchTable): string => {
  const exact = table.tokens.get(run);
  if (exact !== undefined) {
    return exact;
  }
  const lead = LEADING_BRACKET.exec(run)?.[0] ?? '';
  const rest = run.slice(lead.length);
  const trailStart = trailingStartOf(rest);
  const core = rest.slice(0, trailStart);
  if (table.identities.has(run) || isIdentityForm(rest, core, rest.slice(trailStart), table)) {
    return run;
  }
  if (lead !== '' || trailStart < rest.length) {
    const replacement = table.tokens.get(core);
    if (replacement !== undefined) {
      return `${lead}${replacement}${rest.slice(trailStart)}`;
    }
  }
  if (!run.includes(CSS_URL_FUNCTION_MARK)) {
    return run;
  }
  return run.replace(CSS_URL_FUNCTION, (whole: string, inner: string) => {
    const replacement = table.tokens.get(inner);
    return replacement === undefined ? whole : `${CSS_URL_FUNCTION_MARK}${replacement})`;
  });
};

/** 字句がまるごと表の値に等しければ伏せた字句。ほかは、字句の中の ASCII の連なりごとに引く（`replacedRunOf`。等しくなければ字句のまま）。 */
const replacedTokenOf = (token: string, table: MatchTable): string =>
  table.tokens.get(token) ?? token.replace(ASCII_RUN, (run) => replacedRunOf(run, table));

/**
 * (b) の段: 文字列を URL の候補の区切り（`URL_CANDIDATE`）で字句に分け、字句（か、字句の中の ASCII の連なり、その前後の字を外した形）がまるごと表
 * （`table.tokens`）の値に等しいときだけ、伏せた字句に替える（部分一致にしない。ASCII の文字が続く prefix は替えない。ページの identity の形は、外して
 * 引く形で替えない。表は Map で引くので、時間は値の木の全体の長さに比例する。置き換えは関数で行う。値の木の写し）。
 */
const replaceMatchedValues = (value: unknown, table: MatchTable): unknown => {
  if (typeof value === 'string') {
    return value.replace(URL_CANDIDATE, (token) => replacedTokenOf(token, table));
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => replaceMatchedValues(item, table));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, replaceMatchedValues(item, table)]));
  }
  return value;
};

/**
 * `redactRecordedRequestUrlsInValue` の指定。
 * - `matchValues` が偽なら、(b) の値で照らす段を行わない（再開の保存の状態。巡回の URL の identity を変えない）。
 * - `keptUrls`（T44R3 の M-2）: 値の木の外のページの identity（巡回が知っている URL）。照らさない値に加える（再開の保存のページを書くとき、あとで監査する
 *   ページの URL を、続けて終えた Run と同じく伏せない）。
 */
export interface RecordedRequestUrlRedactionOptions {
  readonly matchValues?: boolean | undefined;
  readonly keptUrls?: readonly string[] | undefined;
}

/**
 * 値の木（JSON の値）の写しを作り、記録した要求の URL を伏せる（入力は変えない）。
 * - (a) 項目の名前で伏せる: 記録した要求の URL の一覧（`RECORDED_REQUEST_URL_LIST_NAMES` の名前の配列と、`blockedAuditExclusions.events`）の項目の `url`、
 *   画像の記録の `src`・`resolvedUrl`、console の記録の `location.url`、ページの誤りの `stack` の中の URL、header の値の `location`・`content-location`・`refresh`。
 * - (b) 値で照らす（T44R の C-1）: (a) で伏せた値と、その path と query の形を、木の中のほかの文字列（Finding の本文、ほかの Evidence の欄など）でも、
 *   同じ規則で伏せた値に替える。T44R2 の I-1・I-2・I-3: 字句（URL の候補の区切りで分けたもの）がまるごと等しいときだけ替える（字句の中の、非 ASCII の
 *   字で区切った ASCII の連なりも照らす。HTML の文字の参照の形 `&amp;` も照らす）。T44R3 の M-1: 連なりの先頭の `(`・`url(` と、末尾の閉じ括弧・`,`・
 *   `.`・stack の行と列を外した形と、CSS の `url(…)` の中身も照らす。T44R3 の I-1・M-2: 照らさない値は、ページの identity（`pageUrl`・`finalUrl`、
 *   許して読み込んだ main frame の文書の要求とそのリダイレクトの連鎖、`keptUrls`）に限る。止めた記録の値は、`pageUrl`・`finalUrl`・`keptUrls` に
 *   等しいものだけを除く。T44R4 の I-1: identity の欄に `requestedUrl`・`startUrl` も加え、identity の形（か、外す途中で identity の形になるもの）は、
 *   外して引く形で替えない。形を変えた写し（解いた形・`+`・相対の別の形・値だけ・JSON の `\/`・数値の文字参照・大文字の形）は残る（`doc/spec/output.md`
 *   の限界）。
 * 判定は、この前（伏せる前の値）で終わっている（呼び出し側は書き手だけ）。
 */
export function redactRecordedRequestUrlsInValue<T>(value: T, options: RecordedRequestUrlRedactionOptions = {}): T {
  const redactions: RecordedUrlRedactions = {
    pairs: new Map(),
    blocked: new Set(),
    pageIdentities: new Set(options.keptUrls ?? []),
    loadedDocuments: new Set(),
  };
  const structural = redactStructurally(value, redactions);
  if (options.matchValues === false) {
    return structural as T;
  }
  const table = matchTableOf(redactions);
  return (table.tokens.size === 0 ? structural : replaceMatchedValues(structural, table)) as T;
}

/** JSON の値として扱うオブジェクト（prototype が `Object.prototype` か `null`）か。 */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * 値の木（JSON の値: 文字列、配列、プレーンなオブジェクト）の写しを作り、すべての文字列に `redactUrlSecretsInText` を通す。オブジェクトの名前
 * （キー）と、文字列でない値（数、真偽、`null`、`undefined`）、プレーンでないオブジェクト（`Uint8Array` など）は、そのまま残す。入力は変えない。
 */
export function redactUrlSecretsInValue<T>(value: T, options: UrlSecretRedactionOptions = {}): T {
  if (typeof value === 'string') {
    return redactUrlSecretsInText(value, options) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactUrlSecretsInValue(item, options)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactUrlSecretsInValue(item, options)])) as T;
  }
  return value;
}

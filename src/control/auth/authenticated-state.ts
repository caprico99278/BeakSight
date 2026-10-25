// 認証済みの状態の絞り込みの純粋な部品（Task 25 の設計書 4.3 の「渡す前に絞る」。T25a）。
// - 入力は Playwright の `storageState` と同じ形（`{ cookies, origins }`。DEF-139 からは `origins` の項目に任意の `indexedDB`）。Playwright の型は import
//   せず、同じ形の型を core（`src/core/authenticated-storage-state.ts`。CC-060 の B）から読む（`src/control/` は Playwright を読まない。Task 22 の Architecture Gate）。
// - Cookie（DEF-139 で、設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 2.2 の決まりにした）: ブラウザが、許可 Origin（`approvedTestOrigins`）か
//   承認したサービスの Origin（`approvedServiceOrigins`）の host へ送る Cookie を残す（RFC 6265 の domain-match）。
//   - host だけの Cookie（ドメインの先頭に `.` がない）: ドメインが host と完全に一致するものだけ。
//   - Domain 属性つきの Cookie（先頭の `.`）: 先頭の `.` を 1 つ除いたドメインが host と一致するか、host がそのドメインの下のサブドメインのもの（親ドメインの
//     Cookie）。ただし、IP アドレスの host には親ドメインを当てない（完全一致だけ）。区切りのない 1 つの語のドメイン（`.com`、`.invalid`、`.localhost` など。
//     公開のサフィックスそのもの）は、同じ host のときのほかは当てない（ブラウザも受けない。複数の語の公開のサフィックス（`co.jp` など）は一覧を持たないので
//     見分けない。ブラウザが作らないので、来ない）。
//   - 大文字と小文字は区別しない。Cookie は port と scheme で分かれないので、port と scheme は見ない。
//   - T25g-3（独立レビュー T25R の M2）: 残す Cookie は、一致した host だけの Cookie にして渡す（許可の host のサブドメインやほかのサブドメインへ送られない
//     ように）。同じ host への Cookie（先頭の `.` を除いたドメインが host と同じ）は、先頭の `.` を 1 つ除き、ドメインの大文字と小文字は変えない（今どおり）。
//     親ドメインの Cookie は、一致した host（`URL.hostname` の形）ごとに 1 つずつ作る。同じ host・名前・path の host だけの Cookie がすでにあれば、親ドメインの
//     Cookie からは作らない（Playwright の写しでは同じ組の Cookie は 1 つしか入らないので、その host が作った Cookie を残す）。ほかの項目は変えない。
//     同じ host の別の port には、Cookie の決まりで送られうる（防げない）。
//   - IPv6 の host は、角括弧つき（`[::1]`。`URL.hostname` の形）と角括弧なし（`::1`）のどちらの書き方でも、同じ host とみなす（推測:
//     ブラウザの Cookie のドメインの書き方が、角括弧を含むかどうかを確かめていないため、両方を受ける）。
// - localStorage（`origins`）: `approvedTestOrigins` の Origin（正規の直列化の完全一致）のものだけを残す（今どおり。承認したサービスの Origin のものは残さない）。
// - IndexedDB（DEF-139）: `approvedTestOrigins` と `approvedServiceOrigins` の Origin のものだけを残す（中身は Playwright の形のまま写す。値を読まない）。
//   承認したサービスの Origin の項目は、IndexedDB があるときだけ、ローカル ストレージを空にして残す。
// - `approvedTestOrigins`・`approvedServiceOrigins` のうち、HTTP(S) の Origin の正規の直列化でない値には、権限を与えない（無視する）。
// - 入力を変えない。知っている項目だけを写した、凍結した写しを返す。形の正しくない項目は、投げずに除く。
// - 秘密（Cookie と localStorage の値、IndexedDB の中身）を含むので、値をログや誤りの文に入れない（この部品はログを書かず、例外を投げない）。
// - DEF-139（設計書 2.1）: 同じ決まりで、状態の名前の記録（`authenticatedStateNameRecordOf`。名前の形と、引き継いだか外したか。値を持たない）も作る。
// - Origin の判定は、URL の意味の owner（`src/crawl/normalize-url.ts`）の部品を呼ぶだけにする（GATE-ARCH04）。
import {
  AUTHENTICATED_STATE_SAME_SITE_VALUES,
  type AuthenticatedIndexedDBDatabase,
  type AuthenticatedStateSameSite,
  type AuthenticatedStorageCookie,
  type AuthenticatedStorageItem,
  type AuthenticatedStorageOrigin,
  type AuthenticatedStorageState,
} from '../../core/authenticated-storage-state.js';
import { isRecord } from '../../core/guards.js';
import { deepFreeze } from '../../core/immutable.js';
import { hasControlOrLineSeparator, hasLoneSurrogate } from '../../core/text.js';
import { REDACTED_PATH_SEGMENT, redactValueLikePathSegments } from '../../core/url-path-redaction.js';
import { canonicalHttpOriginOf, isOriginInAllowedOrigins } from '../../crawl/normalize-url.js';
import { storageKeyShapeOf, type LoginObservedStorageKeyShape } from '../../discovery/login-observation.js';

// 形の型と `SameSite` の値の一覧は core の 1 か所（`src/core/authenticated-storage-state.ts`。CC-060 の B）。Origin の項目（localStorage と、DEF-139 の
// IndexedDB。空の配列は持たない）は core の形のまま使う。

/** Cookie 1 つ（Playwright の `storageState` の `cookies` の項目と同じ形。core の形に、この owner だけが写す `partitionKey` を足す。CC-060 の C）。 */
export interface AuthenticatedStateCookie extends AuthenticatedStorageCookie {
  readonly partitionKey?: string;
}

/** 認証済みの状態（Playwright の `storageState` と同じ形。Cookie は `partitionKey` を含む形）。 */
export interface AuthenticatedState extends AuthenticatedStorageState {
  readonly cookies: readonly AuthenticatedStateCookie[];
}

/** Cookie のドメインの先頭の `.`（Domain 属性つきの Cookie の印）。 */
const DOMAIN_COOKIE_PREFIX = '.';

/** ドメインの語の区切り。 */
const DOMAIN_LABEL_SEPARATOR = '.';

/** IPv6 の host を囲む角括弧。 */
const IPV6_HOST_BRACKETS = /^\[(.*)\]$/u;

/** IPv4 の host（`URL.hostname` の 10 進の形）。 */
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/** IPv6 の印（`:`。ドメインの名前には現れない）。 */
const IPV6_SEPARATOR = ':';

/** 配列の値（配列でなければ空）。 */
const arrayOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const isSameSite = (value: unknown): value is AuthenticatedStateSameSite =>
  (AUTHENTICATED_STATE_SAME_SITE_VALUES as readonly unknown[]).includes(value);

/** 知っている項目だけを写した Cookie（形が正しくなければ `undefined`）。 */
const cookieCopyOf = (value: unknown): AuthenticatedStateCookie | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { name, value: cookieValue, domain, path, expires, httpOnly, secure, sameSite, partitionKey } = value;
  if (
    typeof name !== 'string'
    || typeof cookieValue !== 'string'
    || typeof domain !== 'string'
    || typeof path !== 'string'
    || typeof expires !== 'number'
    || typeof httpOnly !== 'boolean'
    || typeof secure !== 'boolean'
    || !isSameSite(sameSite)
    || (partitionKey !== undefined && typeof partitionKey !== 'string')
  ) {
    return undefined;
  }
  return {
    name,
    value: cookieValue,
    domain,
    path,
    expires,
    httpOnly,
    secure,
    sameSite,
    ...(partitionKey === undefined ? {} : { partitionKey }),
  };
};

/** 知っている項目だけを写した localStorage の項目（形が正しくなければ `undefined`）。 */
const storageItemCopyOf = (value: unknown): AuthenticatedStorageItem | undefined =>
  isRecord(value) && typeof value['name'] === 'string' && typeof value['value'] === 'string'
    ? { name: value['name'], value: value['value'] }
    : undefined;

/** DEF-139: 名前・版・中身の配列だけを写した IndexedDB のデータベース（形が正しくなければ `undefined`。中身は読まない）。 */
const indexedDBCopyOf = (value: unknown): AuthenticatedIndexedDBDatabase | undefined =>
  isRecord(value) && typeof value['name'] === 'string' && typeof value['version'] === 'number' && Array.isArray(value['stores'])
    ? { name: value['name'], version: value['version'], stores: value['stores'] as readonly unknown[] }
    : undefined;

/** 正規の直列化の Origin だけ（それ以外の値には権限を与えない）。 */
const canonicalApprovedOf = (approved: unknown): readonly string[] =>
  arrayOf(approved).filter((value): value is string => typeof value === 'string' && canonicalHttpOriginOf(value) !== undefined);

/** 許した Origin の host（`URL.hostname` の形）と、比べる形（IPv6 なら角括弧なしの形も）。 */
interface ApprovedHost {
  readonly hostname: string;
  readonly forms: readonly string[];
  readonly isAddress: boolean;
}

/** 許した Origin の host の一覧（重ならない。並びは Origin の順）。 */
const approvedHostsOf = (canonicalApproved: readonly string[]): readonly ApprovedHost[] => {
  const hosts = new Map<string, ApprovedHost>();
  for (const value of canonicalApproved) {
    const { hostname } = new URL(value);
    if (hosts.has(hostname)) {
      continue;
    }
    const unbracketed = IPV6_HOST_BRACKETS.exec(hostname)?.[1];
    hosts.set(hostname, {
      hostname,
      forms: unbracketed === undefined ? [hostname] : [hostname, unbracketed],
      isAddress: unbracketed !== undefined || IPV4_HOST.test(hostname) || hostname.includes(IPV6_SEPARATOR),
    });
  }
  return [...hosts.values()];
};

/** Cookie のドメインの、host だけの Cookie の形（先頭の `.` を 1 つだけ除く。大文字と小文字は変えない）。 */
const hostOnlyDomainOf = (domain: string): string =>
  (domain.startsWith(DOMAIN_COOKIE_PREFIX) ? domain.slice(DOMAIN_COOKIE_PREFIX.length) : domain);

/** Cookie のドメインを、比べる形（小文字、先頭の `.` を 1 つだけ除く）にする。 */
const cookieHostOf = (domain: string): string => hostOnlyDomainOf(domain.toLowerCase());

/**
 * DEF-139: Cookie が送られる、許した host の一覧（RFC 6265 の domain-match。この順）。`exact` は、ドメイン（先頭の `.` を除いたもの）が host と同じか。
 */
const matchedHostsOf = (domain: string, hosts: readonly ApprovedHost[]): readonly { readonly host: ApprovedHost; readonly exact: boolean }[] => {
  const cookieHost = cookieHostOf(domain);
  const domainCookie = domain.startsWith(DOMAIN_COOKIE_PREFIX);
  // 区切りのない 1 つの語のドメイン（公開のサフィックスそのもの）と空のドメインは、親ドメインとして当てない。
  const mayBeParent = domainCookie && cookieHost.includes(DOMAIN_LABEL_SEPARATOR) && !cookieHost.startsWith(DOMAIN_LABEL_SEPARATOR);
  return hosts.flatMap((host): { readonly host: ApprovedHost; readonly exact: boolean }[] => {
    if (host.forms.includes(cookieHost)) {
      return [{ host, exact: true }];
    }
    return mayBeParent && !host.isAddress && host.hostname.endsWith(`${DOMAIN_LABEL_SEPARATOR}${cookieHost}`) ? [{ host, exact: false }] : [];
  });
};

/** 写した状態と、許した Origin（どれも正規の直列化）。写せなければ `null`。 */
interface CopiedInput {
  readonly copy: unknown;
  readonly approvedTest: readonly string[];
  readonly approvedService: readonly string[];
}

const copiedInputOf = (state: unknown, approvedTestOrigins: unknown, approvedServiceOrigins: unknown): CopiedInput | null => {
  try {
    // 写しだけを読む（getter や Proxy の罠を呼び直さない）。写せない値は、空の状態にする（値を誤りの文に出さない）。
    const copy: unknown = structuredClone(state);
    return {
      copy,
      approvedTest: canonicalApprovedOf(structuredClone(approvedTestOrigins)),
      approvedService: canonicalApprovedOf(structuredClone(approvedServiceOrigins)),
    };
  } catch {
    return null;
  }
};

/** 写した Cookie と、それぞれを引き継ぐ host だけの Cookie（引き継がなければ空）。 */
const cookieDecisionsOf = (
  copy: unknown,
  hosts: readonly ApprovedHost[],
): readonly { readonly cookie: AuthenticatedStateCookie; readonly carried: readonly AuthenticatedStateCookie[] }[] => {
  const cookies = arrayOf(isRecord(copy) ? copy['cookies'] : undefined)
    .map(cookieCopyOf)
    .filter((entry): entry is AuthenticatedStateCookie => entry !== undefined);
  // 同じ host・名前・path の host だけの Cookie（同じ host への Cookie）の組（親ドメインの Cookie から同じ組を作らない）。
  const exactKeys = new Set(cookies.flatMap((entry) => matchedHostsOf(entry.domain, hosts)
    .filter(({ exact }) => exact)
    .map(({ host }) => JSON.stringify([host.hostname, entry.name, entry.path]))));
  return cookies.map((entry) => ({
    cookie: entry,
    carried: matchedHostsOf(entry.domain, hosts).flatMap(({ host, exact }) => {
      if (exact) {
        return [{ ...entry, domain: hostOnlyDomainOf(entry.domain) }];
      }
      return exactKeys.has(JSON.stringify([host.hostname, entry.name, entry.path])) ? [] : [{ ...entry, domain: host.hostname }];
    }),
  }));
};

/** 写した Origin の項目（形の正しいものだけ）。 */
interface OriginEntry {
  readonly origin: string;
  readonly localStorage: readonly AuthenticatedStorageItem[];
  readonly indexedDB: readonly AuthenticatedIndexedDBDatabase[];
}

const originEntriesOf = (copy: unknown): readonly OriginEntry[] =>
  arrayOf(isRecord(copy) ? copy['origins'] : undefined).flatMap((entry): OriginEntry[] => {
    if (!isRecord(entry) || typeof entry['origin'] !== 'string' || !Array.isArray(entry['localStorage'])) {
      return [];
    }
    return [{
      origin: entry['origin'],
      localStorage: (entry['localStorage'] as readonly unknown[])
        .map(storageItemCopyOf)
        .filter((item): item is AuthenticatedStorageItem => item !== undefined),
      indexedDB: arrayOf(entry['indexedDB'])
        .map(indexedDBCopyOf)
        .filter((item): item is AuthenticatedIndexedDBDatabase => item !== undefined),
    }];
  });

/** Origin の項目の、引き継ぐ部分（ローカル ストレージは許可 Origin だけ、IndexedDB は許可 Origin と承認したサービスの Origin）。 */
const carriedPartsOf = (entry: OriginEntry, input: CopiedInput): { readonly localStorage: boolean; readonly indexedDB: boolean } => {
  const approved = isOriginInAllowedOrigins(input.approvedTest, entry.origin);
  return { localStorage: approved, indexedDB: approved || isOriginInAllowedOrigins(input.approvedService, entry.origin) };
};

/**
 * 認証済みの状態を、ブラウザが `approvedTestOrigins` か `approvedServiceOrigins`（DEF-139。省略は空）の host へ送る Cookie と、`approvedTestOrigins` の
 * Origin の localStorage と、両方の Origin の IndexedDB だけに絞る。残す Cookie は、一致した host だけの Cookie にする（T25g-3、DEF-139）。
 * 入力を変えず、凍結した写しを返す。例外を投げない（形の正しくない入力は、空の状態か、その項目を除いた状態になる）。
 */
export const filterAuthenticatedState = (
  state: AuthenticatedState,
  approvedTestOrigins: readonly string[],
  approvedServiceOrigins: readonly string[] = [],
): AuthenticatedState => {
  const input = copiedInputOf(state, approvedTestOrigins, approvedServiceOrigins);
  if (input === null) {
    return deepFreeze({ cookies: [], origins: [] });
  }
  const hosts = approvedHostsOf([...input.approvedTest, ...input.approvedService]);
  const cookies = cookieDecisionsOf(input.copy, hosts).flatMap(({ carried }) => carried);
  const origins = originEntriesOf(input.copy).flatMap((entry): AuthenticatedStorageOrigin[] => {
    const carried = carriedPartsOf(entry, input);
    const indexedDB = carried.indexedDB ? entry.indexedDB : [];
    if (!carried.localStorage && indexedDB.length === 0) {
      return [];
    }
    return [{
      origin: entry.origin,
      localStorage: carried.localStorage ? entry.localStorage : [],
      ...(indexedDB.length === 0 ? {} : { indexedDB }),
    }];
  });
  return deepFreeze({ cookies, origins });
};

// ---------------------------------------------------------------------------------------------------------------
// DEF-139（設計書 2.1）: 状態の名前の記録
// ---------------------------------------------------------------------------------------------------------------

/** 名前ごとの結果（引き継いだ `CARRIED`、許可の外のドメイン・Origin なので外した `OUTSIDE_APPROVED`）。 */
export const LOGIN_STATE_NAME_OUTCOMES = Object.freeze(['CARRIED', 'OUTSIDE_APPROVED'] as const);
export type LoginStateNameOutcome = (typeof LOGIN_STATE_NAME_OUTCOMES)[number];

/** 置き場所ごとの行の上限（同じ行はまとめて数える。超えた行は数だけ）。 */
export const MAX_LOGIN_STATE_NAME_ROWS = 16;
/** Cookie のドメインの最大長（UTF-16 のコード単位。DNS の名前の上限と先頭の `.`）。超えるドメインは伏せる。 */
export const MAX_LOGIN_STATE_NAME_DOMAIN_LENGTH = 254;
/** Cookie の path の最大長（UTF-16 のコード単位）。超える path は伏せる。 */
export const MAX_LOGIN_STATE_NAME_PATH_LENGTH = 256;

/** 名前の形（ログインの段の観察の `storageKeyShapeOf` の形。端の一般の語だけ。名前の全体と間の部分は持たない）。形にできない名前は `null`。 */
export type LoginStateNameShape = LoginObservedStorageKeyShape;

/** Cookie の名前の行（ドメイン、path、host だけか、名前の形、結果、同じ行の数）。値を持たない。 */
export interface LoginStateCookieNameRow {
  readonly domain: string;
  readonly path: string;
  readonly hostOnly: boolean;
  readonly shape: LoginStateNameShape | null;
  readonly outcome: LoginStateNameOutcome;
  readonly count: number;
}

/** ローカル ストレージの鍵と IndexedDB のデータベースの名前の行（Origin、名前の形、結果、同じ行の数）。値と中身を持たない。 */
export interface LoginStateStorageNameRow {
  readonly origin: string;
  readonly shape: LoginStateNameShape | null;
  readonly outcome: LoginStateNameOutcome;
  readonly count: number;
}

/** 置き場所ごとの行と、上限で行にしなかった名前の数。 */
export interface LoginStateNameList<Row> {
  readonly rows: readonly Row[];
  readonly unlisted: number;
}

/** ログインの後のブラウザの状態の名前の記録（DEF-139。設計書 2.1）。 */
export interface LoginStateNameRecord {
  readonly cookies: LoginStateNameList<LoginStateCookieNameRow>;
  readonly localStorage: LoginStateNameList<LoginStateStorageNameRow>;
  readonly indexedDB: LoginStateNameList<LoginStateStorageNameRow>;
}

const isWritableText = (text: string, maxLength: number): boolean =>
  text.length <= maxLength && !hasControlOrLineSeparator(text) && !hasLoneSurrogate(text);

/** 記録のドメイン（書けない・長すぎるドメインは伏せる）。 */
const recordedDomainOf = (domain: string): string => (isWritableText(domain, MAX_LOGIN_STATE_NAME_DOMAIN_LENGTH) ? domain : REDACTED_PATH_SEGMENT);

/** 記録の path（値に見える区切りは伏せる。書けない・長すぎる path は伏せる）。 */
const recordedPathOf = (path: string): string => {
  const redacted = redactValueLikePathSegments(path);
  return isWritableText(redacted, MAX_LOGIN_STATE_NAME_PATH_LENGTH) ? redacted : REDACTED_PATH_SEGMENT;
};

/** 行をまとめ、上限までの行と、行にしなかった数にする。 */
const cappedRowsOf = <Row extends { readonly count: number }>(rows: readonly Omit<Row, 'count'>[]): LoginStateNameList<Row> => {
  const merged = new Map<string, { row: Omit<Row, 'count'>; count: number }>();
  let unlisted = 0;
  for (const row of rows) {
    const key = JSON.stringify(row);
    const existing = merged.get(key);
    if (existing !== undefined) {
      existing.count += 1;
    } else if (merged.size < MAX_LOGIN_STATE_NAME_ROWS) {
      merged.set(key, { row, count: 1 });
    } else {
      unlisted += 1;
    }
  }
  return { rows: [...merged.values()].map(({ row, count }) => ({ ...row, count }) as unknown as Row), unlisted };
};

const outcomeOf = (carried: boolean): LoginStateNameOutcome => (carried ? 'CARRIED' : 'OUTSIDE_APPROVED');

/** 空の記録。 */
const EMPTY_NAME_LIST = Object.freeze({ rows: Object.freeze([]), unlisted: 0 });

/**
 * ログインの後の状態の名前の記録（DEF-139。設計書 2.1）。`filterAuthenticatedState` と同じ決まりで、Cookie・ローカル ストレージの鍵・IndexedDB の
 * データベースのそれぞれを、引き継いだか外したかとともに記録する。名前は形（`storageKeyShapeOf`）だけで、値・中身・名前の全体を持たない。凍結した値を返す。
 * 投げない（形の正しくない入力は、空の記録か、その項目を除いた記録になる）。
 */
export const authenticatedStateNameRecordOf = (
  state: AuthenticatedState,
  approvedTestOrigins: readonly string[],
  approvedServiceOrigins: readonly string[] = [],
): LoginStateNameRecord => {
  const input = copiedInputOf(state, approvedTestOrigins, approvedServiceOrigins);
  if (input === null) {
    return deepFreeze({ cookies: EMPTY_NAME_LIST, localStorage: EMPTY_NAME_LIST, indexedDB: EMPTY_NAME_LIST });
  }
  const hosts = approvedHostsOf([...input.approvedTest, ...input.approvedService]);
  const cookies = cappedRowsOf<LoginStateCookieNameRow>(cookieDecisionsOf(input.copy, hosts).map(({ cookie, carried }) => ({
    domain: recordedDomainOf(cookie.domain),
    path: recordedPathOf(cookie.path),
    hostOnly: !cookie.domain.startsWith(DOMAIN_COOKIE_PREFIX),
    shape: storageKeyShapeOf(cookie.name),
    outcome: outcomeOf(carried.length > 0),
  })));
  const entries = originEntriesOf(input.copy).flatMap((entry) => {
    const origin = canonicalHttpOriginOf(entry.origin);
    return origin === undefined ? [] : [{ entry, origin, carried: carriedPartsOf(entry, input) }];
  });
  const localStorage = cappedRowsOf<LoginStateStorageNameRow>(entries.flatMap(({ entry, origin, carried }) =>
    entry.localStorage.map(({ name }) => ({ origin, shape: storageKeyShapeOf(name), outcome: outcomeOf(carried.localStorage) }))));
  const indexedDB = cappedRowsOf<LoginStateStorageNameRow>(entries.flatMap(({ entry, origin, carried }) =>
    entry.indexedDB.map(({ name }) => ({ origin, shape: storageKeyShapeOf(name), outcome: outcomeOf(carried.indexedDB) }))));
  return deepFreeze({ cookies, localStorage, indexedDB });
};

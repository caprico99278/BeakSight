// 認証済みの状態の絞り込みの純粋な部品（Task 25 の設計書 4.3 の「渡す前に絞る」。T25a）。
// - 入力は Playwright の `storageState` と同じ形（`{ cookies, origins }`）。Playwright の型は import せず、同じ形の型をここで定義する
//   （`src/control/` は Playwright を読まない。Task 22 の Architecture Gate）。
// - Cookie: ドメインが `approvedTestOrigins` の host と一致するものだけを残す。
//   - ドメインの先頭の `.`（Domain 属性つきの Cookie）は 1 つだけ除いて比べる。同じ host への Domain 属性つきの Cookie は残す。
//   - サブドメイン、親ドメイン（`.example.invalid` の形）、別の host は残さない（完全一致だけ。前方・後方の一致はしない）。
//   - 大文字と小文字は区別しない。Cookie は port と scheme で分かれないので、port と scheme は見ない。
//   - T25g-3（独立レビュー T25R の M2）: 残す Cookie は、host だけの Cookie にして渡す。Domain 属性つきの Cookie（先頭の `.`）は、先頭の `.` を
//     1 つ除く（Playwright の `storageState` の形では、先頭の `.` のないドメインが host だけの Cookie）。許可 Origin のサブドメインに送られない
//     ようにするため。ほかの項目と、ドメインの大文字と小文字は変えない。同じ host の別の port には、Cookie の決まりで送られうる（防げない）。
//   - IPv6 の host は、角括弧つき（`[::1]`。`URL.hostname` の形）と角括弧なし（`::1`）のどちらの書き方でも、同じ host とみなす（推測:
//     ブラウザの Cookie のドメインの書き方が、角括弧を含むかどうかを確かめていないため、両方を受ける）。
// - localStorage（`origins`）: `approvedTestOrigins` の Origin（正規の直列化の完全一致）のものだけを残す。
// - `approvedTestOrigins` のうち、HTTP(S) の Origin の正規の直列化でない値には、権限を与えない（無視する）。
// - 入力を変えない。知っている項目だけを写した、凍結した写しを返す。形の正しくない項目は、投げずに除く。
// - 秘密（Cookie と localStorage の値）を含むので、値をログや誤りの文に入れない（この部品はログを書かず、例外を投げない）。
// - Origin の判定は、URL の意味の owner（`src/crawl/normalize-url.ts`）の部品を呼ぶだけにする（GATE-ARCH04）。
import { isRecord } from '../../core/guards.js';
import { deepFreeze } from '../../core/immutable.js';
import { canonicalHttpOriginOf, isOriginInAllowedOrigins } from '../../crawl/normalize-url.js';

/** Cookie の `SameSite` の値（Playwright の `storageState` の形）。 */
export const AUTHENTICATED_STATE_SAME_SITE_VALUES = Object.freeze(['Strict', 'Lax', 'None'] as const);
export type AuthenticatedStateSameSite = (typeof AUTHENTICATED_STATE_SAME_SITE_VALUES)[number];

/** Cookie 1 つ（Playwright の `storageState` の `cookies` の項目と同じ形）。 */
export interface AuthenticatedStateCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  /** 秒の Unix 時刻。セッションの Cookie は -1。 */
  readonly expires: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: AuthenticatedStateSameSite;
  readonly partitionKey?: string;
}

/** localStorage の項目 1 つ。 */
export interface AuthenticatedStateStorageItem {
  readonly name: string;
  readonly value: string;
}

/** Origin ごとの localStorage（Playwright の `storageState` の `origins` の項目と同じ形）。 */
export interface AuthenticatedStateOrigin {
  readonly origin: string;
  readonly localStorage: readonly AuthenticatedStateStorageItem[];
}

/** 認証済みの状態（Playwright の `storageState` と同じ形）。 */
export interface AuthenticatedState {
  readonly cookies: readonly AuthenticatedStateCookie[];
  readonly origins: readonly AuthenticatedStateOrigin[];
}

/** Cookie のドメインの先頭の `.`（Domain 属性つきの Cookie の印）。 */
const DOMAIN_COOKIE_PREFIX = '.';

/** IPv6 の host を囲む角括弧。 */
const IPV6_HOST_BRACKETS = /^\[(.*)\]$/u;

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
const storageItemCopyOf = (value: unknown): AuthenticatedStateStorageItem | undefined =>
  isRecord(value) && typeof value['name'] === 'string' && typeof value['value'] === 'string'
    ? { name: value['name'], value: value['value'] }
    : undefined;

/** 正規の直列化の Origin だけ（それ以外の値には権限を与えない）。 */
const canonicalApprovedOf = (approvedTestOrigins: readonly string[]): readonly string[] =>
  approvedTestOrigins.filter((value): value is string =>
    typeof value === 'string' && canonicalHttpOriginOf(value) !== undefined);

/** 許した Origin の host の集合（`URL.hostname` の形と、IPv6 なら角括弧なしの形）。 */
const approvedHostsOf = (canonicalApproved: readonly string[]): ReadonlySet<string> => {
  const hosts = new Set<string>();
  for (const value of canonicalApproved) {
    const { hostname } = new URL(value);
    hosts.add(hostname);
    const unbracketed = IPV6_HOST_BRACKETS.exec(hostname)?.[1];
    if (unbracketed !== undefined) {
      hosts.add(unbracketed);
    }
  }
  return hosts;
};

/** Cookie のドメインの、host だけの Cookie の形（先頭の `.` を 1 つだけ除く。大文字と小文字は変えない）。 */
const hostOnlyDomainOf = (domain: string): string =>
  (domain.startsWith(DOMAIN_COOKIE_PREFIX) ? domain.slice(DOMAIN_COOKIE_PREFIX.length) : domain);

/** Cookie のドメインを、比べる形（小文字、先頭の `.` を 1 つだけ除く）にする。 */
const cookieHostOf = (domain: string): string => {
  const lowerCased = domain.toLowerCase();
  return lowerCased.startsWith(DOMAIN_COOKIE_PREFIX) ? lowerCased.slice(DOMAIN_COOKIE_PREFIX.length) : lowerCased;
};

/**
 * 認証済みの状態を、`approvedTestOrigins` の host の Cookie と、`approvedTestOrigins` の Origin の localStorage だけに絞る。残す Cookie は、host だけの
 * Cookie にする（`hostOnlyDomainOf`。T25g-3）。
 * 入力を変えず、凍結した写しを返す。例外を投げない（形の正しくない入力は、空の状態か、その項目を除いた状態になる）。
 */
export const filterAuthenticatedState = (
  state: AuthenticatedState,
  approvedTestOrigins: readonly string[],
): AuthenticatedState => {
  let copy: unknown;
  let approvedCopy: unknown;
  try {
    // 写しだけを読む（getter や Proxy の罠を呼び直さない）。写せない値は、空の状態にする（値を誤りの文に出さない）。
    copy = structuredClone(state);
    approvedCopy = structuredClone(approvedTestOrigins);
  } catch {
    return deepFreeze({ cookies: [], origins: [] });
  }
  const canonicalApproved = canonicalApprovedOf(arrayOf(approvedCopy) as readonly string[]);
  const approvedHosts = approvedHostsOf(canonicalApproved);
  const cookies = arrayOf(isRecord(copy) ? copy['cookies'] : undefined)
    .map(cookieCopyOf)
    .filter((entry): entry is AuthenticatedStateCookie => entry !== undefined && approvedHosts.has(cookieHostOf(entry.domain)))
    .map((entry) => ({ ...entry, domain: hostOnlyDomainOf(entry.domain) }));
  const origins = arrayOf(isRecord(copy) ? copy['origins'] : undefined).flatMap((entry): AuthenticatedStateOrigin[] => {
    if (!isRecord(entry) || typeof entry['origin'] !== 'string' || !Array.isArray(entry['localStorage'])) {
      return [];
    }
    if (!isOriginInAllowedOrigins(canonicalApproved, entry['origin'])) {
      return [];
    }
    const localStorage = (entry['localStorage'] as readonly unknown[])
      .map(storageItemCopyOf)
      .filter((item): item is AuthenticatedStateStorageItem => item !== undefined);
    return [{ origin: entry['origin'], localStorage }];
  });
  return deepFreeze({ cookies, origins });
};

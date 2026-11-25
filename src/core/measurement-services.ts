/**
 * BS-1（設計書 `doc/design/2026-11-19-beaksight-measurement-tag-inventory-design.md` 2.1・6 章）: 計測サービスの閉じた一覧と、URL から（種類, 識別子）を取り出す
 * 純粋な関数の唯一の置き場所。
 * - 一覧は汎用の外部の計測サービスだけ。点検の対象のサイトの名前は書かない。一覧にない外部のスクリプトは、計測と決めない（取り出さない）。
 * - 伏せ字（`src/safety/redact.ts` の `redactRecordedRequestUrl`）と表示用モデル（`src/report/measurement-tags.ts`）の両方が、この一覧を使う。伏せ字は、行の
 *   ホスト・path・識別子の欄の名前・識別子の形に全部合う query の値だけを伏せずに残す（6 章の狭い例外）。
 * - 新しいサービスは、種類（`MEASUREMENT_SERVICE_KINDS`・`MEASUREMENT_SERVICE_GROUP_OF`。表示の名前は表示カタログ）と行を足すだけで広げられる（表示面は変えない）。
 */
import { deepFreeze } from './immutable.js';

/** 計測サービスの分け方（構成の要約の単位）。 */
export const MEASUREMENT_SERVICE_GROUPS = Object.freeze(['TAG_MANAGEMENT', 'ANALYTICS', 'ADVERTISING'] as const);
export type MeasurementServiceGroup = (typeof MEASUREMENT_SERVICE_GROUPS)[number];

/** 計測サービスの種類の閉じた一覧。 */
export const MEASUREMENT_SERVICE_KINDS = Object.freeze(['TAG_MANAGER', 'GOOGLE_TAG', 'ANALYTICS_COLLECT', 'ADS_CONVERSION', 'META_PIXEL', 'CLARITY'] as const);
export type MeasurementServiceKind = (typeof MEASUREMENT_SERVICE_KINDS)[number];

/** 種類ごとの分け方（書き漏れは型のエラー）。 */
export const MEASUREMENT_SERVICE_GROUP_OF: Readonly<Record<MeasurementServiceKind, MeasurementServiceGroup>> = Object.freeze({
  TAG_MANAGER: 'TAG_MANAGEMENT',
  GOOGLE_TAG: 'TAG_MANAGEMENT',
  ANALYTICS_COLLECT: 'ANALYTICS',
  ADS_CONVERSION: 'ADVERTISING',
  META_PIXEL: 'ADVERTISING',
  CLARITY: 'ANALYTICS',
});

/** 識別子の場所: query の欄の名前か、path の区切りの位置（空の区切りを除いた 0 から）。 */
type MeasurementIdSource = { readonly query: string } | { readonly pathSegment: number };

/**
 * 一覧の 1 行。`hosts` はホストの名前（そのホストか、その下のホスト）。`paths` は path そのもの（`exact`）か始まり（`prefix`）。`idPattern` は識別子の形
 * （英数字と `-` だけ。長さの上限つき。伏せ字の値に見える形の境目より短い）。
 */
interface MeasurementServiceRow {
  readonly kind: MeasurementServiceKind;
  readonly hosts: readonly string[];
  readonly paths: { readonly exact: readonly string[] } | { readonly prefix: string };
  readonly id: MeasurementIdSource;
  readonly idPattern: RegExp;
}

/** 計測サービスの閉じた一覧（2.1）。 */
export const MEASUREMENT_SERVICE_ROWS: readonly MeasurementServiceRow[] = deepFreeze([
  { kind: 'TAG_MANAGER', hosts: ['googletagmanager.com'], paths: { exact: ['/gtm.js', '/ns.html'] }, id: { query: 'id' }, idPattern: /^GTM-[A-Z0-9]{4,12}$/u },
  {
    kind: 'GOOGLE_TAG',
    hosts: ['googletagmanager.com'],
    paths: { exact: ['/gtag/js'] },
    id: { query: 'id' },
    idPattern: /^(?:(?:G|GT)-[A-Z0-9]{4,12}|(?:AW|DC)-[0-9]{4,15})$/u,
  },
  {
    kind: 'ANALYTICS_COLLECT',
    hosts: ['google-analytics.com', 'analytics.google.com'],
    paths: { exact: ['/g/collect'] },
    id: { query: 'tid' },
    idPattern: /^G-[A-Z0-9]{4,12}$/u,
  },
  {
    kind: 'ADS_CONVERSION',
    hosts: ['googleadservices.com', 'googleads.g.doubleclick.net'],
    paths: { prefix: '/pagead/conversion/' },
    id: { pathSegment: 2 },
    idPattern: /^[0-9]{4,15}$/u,
  },
  {
    kind: 'ADS_CONVERSION',
    hosts: ['googleadservices.com', 'googleads.g.doubleclick.net'],
    paths: { prefix: '/pagead/viewthroughconversion/' },
    id: { pathSegment: 2 },
    idPattern: /^[0-9]{4,15}$/u,
  },
  { kind: 'META_PIXEL', hosts: ['facebook.com'], paths: { exact: ['/tr', '/tr/'] }, id: { query: 'id' }, idPattern: /^[0-9]{6,20}$/u },
  { kind: 'META_PIXEL', hosts: ['connect.facebook.net'], paths: { prefix: '/signals/config/' }, id: { pathSegment: 2 }, idPattern: /^[0-9]{6,20}$/u },
  { kind: 'CLARITY', hosts: ['clarity.ms'], paths: { prefix: '/tag/' }, id: { pathSegment: 1 }, idPattern: /^[a-z0-9]{6,16}$/u },
] satisfies MeasurementServiceRow[]);

/** URL から取り出した（種類, 識別子）。`queryName` は、識別子が query の値のときの欄の名前（path のときは `null`）。 */
export interface MeasurementTagMatch {
  readonly service: MeasurementServiceKind;
  readonly tagId: string;
  readonly queryName: string | null;
}

const HTTP_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

const hostMatches = (hostname: string, hosts: readonly string[]): boolean =>
  hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));

const pathMatches = (pathname: string, paths: MeasurementServiceRow['paths']): boolean =>
  'exact' in paths ? paths.exact.includes(pathname) : pathname.startsWith(paths.prefix);

/**
 * query の欄の、書かれたままの値の一覧（decode しない。書かれたままの値で形を確かめるので、percent-encode した値は形に合わない）。組の区切りが読み手で
 * 分かれうる query（`;` か 2 つ目の `?` を含む。伏せ字はそれも区切りにする）は、どの欄の値も返さない。
 */
const rawQueryValuesOf = (url: URL, name: string): readonly string[] =>
  /[;?]/u.test(url.search.slice(1)) ? [] : url.search.slice(1).split('&').flatMap((pair) => {
    const separator = pair.indexOf('=');
    return separator >= 0 && pair.slice(0, separator) === name ? [pair.slice(separator + 1)] : [];
  });

/** 行の識別子（形に合わなければ `null`）。query の欄は、同じ名前の組がちょうど 1 つのときだけ。 */
const idOf = (url: URL, row: MeasurementServiceRow): string | null => {
  if ('query' in row.id) {
    const values = rawQueryValuesOf(url, row.id.query);
    return values.length === 1 && values[0] !== undefined && row.idPattern.test(values[0]) ? values[0] : null;
  }
  const segment = url.pathname.split('/').filter((part) => part.length > 0)[row.id.pathSegment];
  return segment !== undefined && row.idPattern.test(segment) ? segment : null;
};

/** URL のホストが、一覧のどれかの行のホスト（か、その下のホスト）か（BeakSight が止めた計測の要求の数を数えるため。URL として読めなければ偽）。 */
export function isMeasurementServiceHostUrl(url: string): boolean {
  return URL.canParse(url) && MEASUREMENT_SERVICE_ROWS.some((row) => hostMatches(new URL(url).hostname, row.hosts));
}

/**
 * URL が一覧の行に全部合えば（種類, 識別子）を返す。合わなければ `null`（一覧にない外部のスクリプトは数えない）。http(s) で、userinfo と port の指定が
 * ない URL だけを見る。
 */
export function measurementTagOf(url: string): MeasurementTagMatch | null {
  if (!URL.canParse(url)) {
    return null;
  }
  const parsed = new URL(url);
  if (!HTTP_SCHEMES.has(parsed.protocol) || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') {
    return null;
  }
  for (const row of MEASUREMENT_SERVICE_ROWS) {
    if (!hostMatches(parsed.hostname, row.hosts) || !pathMatches(parsed.pathname, row.paths)) {
      continue;
    }
    const tagId = idOf(parsed, row);
    if (tagId !== null) {
      return { service: row.kind, tagId, queryName: 'query' in row.id ? row.id.query : null };
    }
  }
  return null;
}

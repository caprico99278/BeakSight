/**
 * 開始の URL から作る対象の設定のファイルの案（Task 43 の設計書 4.2。T43b）。
 * - 純粋な関数と閉じた一覧だけを置く（`node:` の部品を読み込まない）。画面のブラウザ側（作成の欄の確かめと案）と、画面のサーバ（ファイルを作る前の
 *   確かめと中身の組み立て）の両方が使う。最後の判定は、サーバが `validateConfig`（`validate-config.ts`）で行う（ここでは写さない）。
 * - URL の判定の部品（http(s) か、userinfo を持つか、Origin の正規の形か）は、`validateConfig` と同じ `src/crawl/normalize-url.ts` の部品を使う。
 *   fragment を持たないことは、認証の設定の URL の決まり（`auth-setup-policy.ts`）と同じ `src/core/url-fragment.ts` の `hasUrlFragment` で判定する。
 * - 作るファイルの中身は、`target.id`・`site`・負荷（`crawl`）・出力（`output`）。負荷は、最初の読み込みのための控えめな値
 *   （`GENERATED_TARGET_CRAWL_LIMITS`。T43b fix round 2）のほかは既定値（`defaults.ts` の `DEFAULT_CONFIG`）の複製、出力は既定値の複製で、
 *   作るときには画面から負荷を変えない（作った後は、プロファイルの画面から 3 つの値だけを変えられる。T44d）。ブラウザの設定・画面の大きさ・監査の項目は書かない（`loadConfig` が既定値を合わせる）。
 * - 作るファイルの場所は `local/targets/<id>.json` の形だけ（`id` はプロファイルの ID の形。任意のパスに書かない。組み立ては画面の
 *   `display/start-url-draft.ts`）。サーバは、書く前に `isAcceptedTargetConfigPath`（`src/control/profile-policy.ts`）も通す。
 * - 利用者に見せる文は、`src/presentation/messages.ts` の `TARGET_SITE_PROBLEM_DESCRIPTIONS` と `TARGET_CONFIG_CREATION_FAILURE_DESCRIPTIONS`
 *   が、コードごとに持つ（すべてのコードを持つことは、画面の `display/catalog-coverage.ts` が型で確かめる）。
 */
import { MAX_URL_LENGTH } from '../core/limits.js';
import { hasUrlFragment } from '../core/url-fragment.js';
import { isWindowsReservedDeviceName } from '../core/windows-reserved-names.js';
import { canonicalHttpOriginOf, hasUrlCredentials, isHttpProtocol, isOriginInAllowedOrigins } from '../crawl/normalize-url.js';
import { DEFAULT_CONFIG } from './defaults.js';
import type { AuditConfig } from './types.js';

/** 開始の URL と許可 Origin の欄の誤り（閉じた一覧。欄に出す）。 */
export const TARGET_SITE_PROBLEMS = Object.freeze([
  /** 開始の URL が空。 */
  'START_URL_REQUIRED',
  /** 開始の URL が、解析できないか、http(s) でない。 */
  'START_URL_INVALID',
  /** 開始の URL が長すぎる（解析した後の形が `MAX_URL_LENGTH` を超える）。 */
  'START_URL_TOO_LONG',
  /** 開始の URL が userinfo（ユーザー名・パスワード）を持つ。 */
  'START_URL_HAS_CREDENTIALS',
  /** 開始の URL が fragment（`#`）を持つ。 */
  'START_URL_HAS_FRAGMENT',
  /** 許可 Origin が 1 つもない。 */
  'ALLOWED_ORIGINS_REQUIRED',
  /** 許可 Origin に、http(s) の Origin の正規の形（例: `https://example.test`）でない値がある。 */
  'ALLOWED_ORIGIN_INVALID',
  /** 許可 Origin が多すぎる（`MAX_GENERATED_ALLOWED_ORIGINS` を超える）。 */
  'ALLOWED_ORIGINS_TOO_MANY',
  /** 許可 Origin に、開始の URL の Origin がない。 */
  'ALLOWED_ORIGINS_MISSING_START',
] as const);
export type TargetSiteProblem = (typeof TARGET_SITE_PROBLEMS)[number];

/** 対象の設定のファイルを作れなかった理由（閉じた一覧。フォームの上に出す）。 */
export const TARGET_CONFIG_CREATION_FAILURES = Object.freeze([
  /** 開始の URL か許可 Origin の欄に誤りがある（`TARGET_SITE_PROBLEMS`）。 */
  'TARGET_SITE_INVALID',
  /** 組み立てた設定が `validateConfig` を通らない（欄の確かめでは見つからない誤り）。 */
  'TARGET_CONFIG_INVALID',
  /** T43R-fix-D（M-6）: 名前が Windows の予約名（`con`・`nul`・`com1` など。大文字と小文字を問わない）で、ファイルの名前にできない。 */
  'TARGET_CONFIG_NAME_RESERVED',
  /** 同じ名前のファイルがもうある（上書きしない）。 */
  'TARGET_CONFIG_EXISTS',
  /** T43R-fix-D（M-6）: 置き場所（`local` か `local/targets`）が、リンク（junction・symlink）か、フォルダでない。書かずに止める。 */
  'TARGET_CONFIG_LOCATION_UNSAFE',
  /** ファイルを書けなかった。 */
  'TARGET_CONFIG_WRITE_FAILED',
] as const);
export type TargetConfigCreationFailure = (typeof TARGET_CONFIG_CREATION_FAILURES)[number];

const CREATION_FAILURE_SET: ReadonlySet<string> = new Set(TARGET_CONFIG_CREATION_FAILURES);

/**
 * T44d（Task 44 の設計書 P2-1）: プロファイルの画面から変えられる負荷の項目（`crawl` の中。閉じた一覧。この順に出す）。書くのは画面のサーバの
 * `target-config-writer.ts`。値の範囲は `validateConfig` と同じ（ページの上限と時間の上限は正の整数、間隔は 0 以上の整数で、下限
 * `navigationIntervalFloorMsOf` 以上）。
 */
export const TARGET_CRAWL_LIMIT_FIELDS = Object.freeze(['maxPages', 'maxRuntimeMs', 'minNavigationIntervalMs'] as const);
export type TargetCrawlLimitField = (typeof TARGET_CRAWL_LIMIT_FIELDS)[number];
/** 変えられる負荷の値（ページの数と、ms）。 */
export type TargetCrawlLimits = Readonly<Record<TargetCrawlLimitField, number>>;

/** T44d: 負荷の値の欄の誤り（閉じた一覧。欄に出す）。 */
export const TARGET_CRAWL_LIMIT_PROBLEMS = Object.freeze([
  /** 正の整数でない（ページの上限、時間の上限）。 */
  'NOT_POSITIVE_INTEGER',
  /** 0 以上の整数でない（読み込みの間隔）。 */
  'NOT_NON_NEGATIVE_INTEGER',
  /** T44R（Task 44 のレビューの M-3）: ページの上限が、設定の検証の上限（`MAX_CRAWL_MAX_PAGES`）を超える。 */
  'ABOVE_MAX_PAGES',
  /** 読み込みの間隔が、今の下限（許可 Origin にループバックでないものがあれば 1 秒）より短い。 */
  'BELOW_NAVIGATION_INTERVAL_FLOOR',
] as const);
export type TargetCrawlLimitProblemCode = (typeof TARGET_CRAWL_LIMIT_PROBLEMS)[number];

/** T44d: 負荷の値を変えられなかった理由（閉じた一覧。フォームの上に出す）。 */
export const TARGET_CRAWL_LIMITS_CHANGE_FAILURES = Object.freeze([
  /** 対象のプロファイルがない。 */
  'PROFILE_NOT_FOUND',
  /** 取り消したプロファイル。 */
  'PROFILE_RETIRED',
  /** 設定のファイルが `local/targets/<名前>.json` の形でない（画面からは書かない）。 */
  'TARGET_CONFIG_NOT_EDITABLE',
  /** 設定のファイルを読めないか、今の中身が `validateConfig` を通らない（変えた後の中身が通らない場合も）。 */
  'TARGET_CONFIG_INVALID',
  /** 欄の値に誤りがある（`TARGET_CRAWL_LIMIT_PROBLEMS`）。 */
  'CRAWL_LIMITS_INVALID',
  /** 値が今と同じ（書かない。書くと digest が変わり、承認が外れるため）。 */
  'CRAWL_LIMITS_UNCHANGED',
  /** 画面を開いた後に、設定のファイルが変わった（読み込み直してから、もう一度変える）。 */
  'TARGET_CONFIG_CHANGED',
  /** 置き場所（`local` か `local/targets`）か、ファイルそのものが、リンクかファイルでない。書かずに止める。 */
  'TARGET_CONFIG_LOCATION_UNSAFE',
  /** ファイルを書けなかった（今のファイルは変えていない）。 */
  'TARGET_CONFIG_WRITE_FAILED',
] as const);
export type TargetCrawlLimitsChangeFailure = (typeof TARGET_CRAWL_LIMITS_CHANGE_FAILURES)[number];

/** 値が、対象の設定のファイルを作れなかった理由のどれかか。 */
export const isTargetConfigCreationFailure = (value: string): value is TargetConfigCreationFailure => CREATION_FAILURE_SET.has(value);

/**
 * 名前（作るファイルの名前の、拡張子より前の部分）が Windows の予約名か（T43R-fix-D の M-6。CC-101 で画面の案でも使えるよう、ここに置いた）。
 * 大文字と小文字を問わない。一覧は `src/core/windows-reserved-names.ts`（写さない）。プロファイルの ID は `.` を含まないので、名前の全体で比べる。
 */
export const isReservedTargetConfigName = (targetId: string): boolean => isWindowsReservedDeviceName(targetId);

/** 作るファイルの許可 Origin の最大の件数（作成の入力のスキーマ `ui-profile-create` の `maxItems` と一致する）。 */
export const MAX_GENERATED_ALLOWED_ORIGINS = 16;

// 作るファイルの場所（`local/targets/<プロファイルの ID>.json`）は、置き場所の owner（`src/control/target-config-locations.ts`）の定数と、プロファイルの
// ID の形（`src/control/contracts.ts` の `PROFILE_ID_PATTERN`）で、画面の `display/start-url-draft.ts` の `generatedTargetConfigPathOf` が組み立てる
// （`src/config/` は `src/control/` を読み込まない。T43b fix round 1 で、ここの置き場所の定数をやめた）。

/** 開始の URL の入力を、判定の前に整える（前後の空白を除く。貼り付けの空白）。 */
const trimmedOf = (value: string): string => value.trim();

/** 受けた開始の URL を解析した値。受けなければ、その誤り。 */
const startUrlReadingOf = (raw: string): { readonly url: URL } | { readonly problem: TargetSiteProblem } => {
  const value = trimmedOf(raw);
  if (value.length === 0) {
    return { problem: 'START_URL_REQUIRED' };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: 'START_URL_INVALID' };
  }
  if (!isHttpProtocol(url.protocol)) {
    return { problem: 'START_URL_INVALID' };
  }
  if (hasUrlCredentials(url)) {
    return { problem: 'START_URL_HAS_CREDENTIALS' };
  }
  if (hasUrlFragment(value)) {
    return { problem: 'START_URL_HAS_FRAGMENT' };
  }
  if (url.href.length > MAX_URL_LENGTH) {
    return { problem: 'START_URL_TOO_LONG' };
  }
  return { url };
};

/** 開始の URL の誤り（受けるなら `null`）。 */
export const startUrlProblemOf = (raw: string): TargetSiteProblem | null => {
  const reading = startUrlReadingOf(raw);
  return 'problem' in reading ? reading.problem : null;
};

/** 受けた開始の URL の正規の形（`URL` の直列化）。受けなければ `undefined`。 */
const acceptedStartUrlOf = (raw: string): URL | undefined => {
  const reading = startUrlReadingOf(raw);
  return 'url' in reading ? reading.url : undefined;
};

/** 開始の URL の Origin（許可 Origin の案）。受けない開始の URL では `undefined`。 */
export const startUrlOriginOf = (raw: string): string | undefined => acceptedStartUrlOf(raw)?.origin;

/** 開始の URL のホスト名（プロファイルの ID の案の元）。受けない開始の URL では `undefined`。 */
export const startUrlHostnameOf = (raw: string): string | undefined => acceptedStartUrlOf(raw)?.hostname;

/** 開始の URL の path（認証の設定の監査の path と成功の画面の path の案）。受けない開始の URL では `undefined`。 */
export const startUrlPathOf = (raw: string): string | undefined => acceptedStartUrlOf(raw)?.pathname;

/** 許可 Origin の誤り（受けるなら `null`）。値は 1 つずつ、http(s) の Origin の正規の形でなければならない。 */
export const allowedOriginsProblemOf = (origins: readonly string[], startUrl: string): TargetSiteProblem | null => {
  if (origins.length === 0) {
    return 'ALLOWED_ORIGINS_REQUIRED';
  }
  if (origins.length > MAX_GENERATED_ALLOWED_ORIGINS) {
    return 'ALLOWED_ORIGINS_TOO_MANY';
  }
  if (origins.some((origin) => canonicalHttpOriginOf(origin) === undefined)) {
    return 'ALLOWED_ORIGIN_INVALID';
  }
  const startOrigin = startUrlOriginOf(startUrl);
  return startOrigin === undefined || isOriginInAllowedOrigins(origins, startOrigin) ? null : 'ALLOWED_ORIGINS_MISSING_START';
};

/** 開始の URL と許可 Origin（作るファイルの `site` の入力）。 */
export interface TargetSiteInput {
  readonly startUrl: string;
  readonly allowedOrigins: readonly string[];
}

/** 開始の URL と許可 Origin の誤り（開始の URL の誤りが先。どちらもなければ空）。 */
export const targetSiteProblemsOf = (site: TargetSiteInput): readonly TargetSiteProblem[] => {
  const problems = [startUrlProblemOf(site.startUrl), allowedOriginsProblemOf(site.allowedOrigins, site.startUrl)];
  return Object.freeze(problems.filter((problem): problem is TargetSiteProblem => problem !== null));
};

/**
 * 作るファイルの、最初の読み込みのための控えめな負荷（T43b fix round 2。Task 43 の設計書 7 章の最後の行。設計者の既定）。ページの上限は 3、
 * ページの読み込みの最小の間隔は 10 秒。ほかの負荷の項目と出力は既定値（`DEFAULT_CONFIG`）のまま。CLI の既定値は変えない。広げるときは、
 * プロファイルの画面の「監査の負荷」で変える（T44d。`TARGET_CRAWL_LIMIT_FIELDS`）か、作ったファイルを直す。
 */
export const GENERATED_TARGET_CRAWL_LIMITS = Object.freeze({
  maxPages: 3,
  minNavigationIntervalMs: 10_000,
} as const satisfies Partial<AuditConfig['crawl']>);

/** 作るファイルの中身（書く JSON の形）。 */
export interface GeneratedTargetConfigDocument {
  readonly target: AuditConfig['target'];
  readonly site: AuditConfig['site'];
  readonly crawl: AuditConfig['crawl'];
  readonly output: AuditConfig['output'];
}

/** 作るファイルの入力（ID と、開始の URL と許可 Origin）。 */
export interface GeneratedTargetConfigInput extends TargetSiteInput {
  readonly targetId: string;
}

/**
 * 作るファイルの中身を組み立てる。開始の URL は正規の形（解析した `URL` の直列化。受けない値は前後の空白を除いたまま。その場合は
 * `validateConfig` が拒む）。負荷は既定値の複製に最初の読み込みの値を重ねたもの、出力は既定値の複製（既定値と参照を共有しない）。
 */
export const targetConfigDocumentOf = (input: GeneratedTargetConfigInput): GeneratedTargetConfigDocument => ({
  target: { id: input.targetId },
  site: { startUrl: acceptedStartUrlOf(input.startUrl)?.href ?? trimmedOf(input.startUrl), allowedOrigins: [...input.allowedOrigins] },
  crawl: { ...structuredClone(DEFAULT_CONFIG.crawl), ...GENERATED_TARGET_CRAWL_LIMITS },
  output: structuredClone(DEFAULT_CONFIG.output),
});

/**
 * `validateConfig` に渡す、既定値を合わせた設定（`loadConfig` が読んだときと同じ値）。作るファイルは、持つ節（`target`・`site`・`crawl`・
 * `output`）をすべての項目で持つので、節ごとの置き換えが `loadConfig` の深い合わせと同じ結果になる。
 */
export const effectiveConfigInputOf = (document: GeneratedTargetConfigDocument): Readonly<Record<string, unknown>> => ({
  ...structuredClone(DEFAULT_CONFIG),
  ...structuredClone(document),
});

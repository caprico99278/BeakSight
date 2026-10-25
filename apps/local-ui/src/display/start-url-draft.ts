/**
 * 開始の URL から、作成の画面と認証の設定の画面が埋める案（Task 43 の設計書 4.2。区分 a。T43b）。純粋な関数だけ（ブラウザ側とサーバの両方が使う）。
 * - 埋めた値は、保存されていない案（設計書 3 章）。利用者が変えられ、保存したものだけが通る。
 * - 開始の URL の判定（受けるか、Origin、ホスト名、path）は `src/config/target-config-draft.ts` の部品を使う（写さない）。
 * - プロファイルの ID の案は、ホスト名を `PROFILE_ID_PATTERN`（`src/control/contracts.ts`）に合う形に直したもの。合う形にできなければ空。
 * - 作るファイルの場所（`local/targets/<profileId>.json`）は、プロファイルの ID の形を確かめてから、置き場所の owner
 *   （`src/control/target-config-locations.ts`）の定数で組み立てる（任意のパスを作らない）。
 */
import { isReservedTargetConfigName, startUrlHostnameOf, startUrlOriginOf } from '../../../../src/config/target-config-draft.js';
import { PROFILE_ID_PATTERN } from '../../../../src/control/contracts.js';
import { LOCAL_TARGET_CONFIG_DIRECTORY, TARGET_CONFIG_EXTENSION } from '../../../../src/control/target-config-locations.js';

/** ID に使えない文字（小文字の英数字とハイフンのほか）。ハイフンに置き換える。 */
const NOT_ID_CHARACTER = /[^a-z0-9-]/gu;
/** 先頭の、英数字でない文字。 */
const LEADING_NOT_ALPHANUMERIC = /^[^a-z0-9]+/u;
/** 末尾のハイフン。 */
const TRAILING_HYPHENS = /-+$/u;
const ID_SEPARATOR = '-';

/** 開始の URL のホスト名から、プロファイルの ID の案を作る。受けない開始の URL や、合う形にできないホスト名では空。 */
export const profileIdSuggestionOf = (startUrl: string): string => {
  const hostname = startUrlHostnameOf(startUrl);
  if (hostname === undefined) {
    return '';
  }
  const text = hostname.toLowerCase().replace(NOT_ID_CHARACTER, ID_SEPARATOR).replace(LEADING_NOT_ALPHANUMERIC, '');
  // ID の形に合う、最も長い先頭の部分（末尾のハイフンを除く）。長さの上限は `PROFILE_ID_PATTERN` だけが決める（写さない）。
  for (let length = text.length; length > 0; length -= 1) {
    const candidate = text.slice(0, length).replace(TRAILING_HYPHENS, '');
    if (candidate.length > 0 && PROFILE_ID_PATTERN.test(candidate)) {
      return candidate;
    }
  }
  return '';
};

/** 作成の画面の案（プロファイルの ID と許可 Origin）。 */
export interface ProfileDraft {
  readonly profileId: string;
  readonly allowedOrigins: readonly string[];
}

/** 開始の URL から、作成の画面の案を作る。受けない開始の URL では、どちらも空。 */
export const profileDraftOf = (startUrl: string): ProfileDraft => {
  const origin = startUrlOriginOf(startUrl);
  return { profileId: profileIdSuggestionOf(startUrl), allowedOrigins: origin === undefined ? [] : [origin] };
};

/**
 * 作るファイルの場所（`local/targets/<profileId>.json`）。`profileId` がプロファイルの ID の形でないとき、Windows の予約名のとき（CC-101）は
 * `undefined`（任意のパスを作らない。画面は場所を示さない）。
 */
export const generatedTargetConfigPathOf = (profileId: string): string | undefined =>
  PROFILE_ID_PATTERN.test(profileId) && !isReservedTargetConfigName(profileId)
    ? `${LOCAL_TARGET_CONFIG_DIRECTORY}${profileId}${TARGET_CONFIG_EXTENSION}`
    : undefined;

/** 認証の設定の画面の案（監査の path と成功の画面の path）。 */
export interface AuthSetupDraft {
  readonly auditPathPrefixes: readonly string[];
  readonly successPathPrefix: string;
}

/** 開始の URL の path から、新しい認証の設定の案を作る。path がなければ（対象の設定を読めない）、どちらも空。 */
export const authSetupDraftOf = (startUrlPath: string | null): AuthSetupDraft =>
  startUrlPath === null ? { auditPathPrefixes: [], successPathPrefix: '' } : { auditPathPrefixes: [startUrlPath], successPathPrefix: startUrlPath };

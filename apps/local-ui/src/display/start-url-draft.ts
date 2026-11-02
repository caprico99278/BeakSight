/**
 * 開始の URL から、作成の画面が埋める案（Task 43 の設計書 4.2。区分 a。T43b。認証の設定の案は MI-3 で `src/control/auth/auth-setup-proposal.ts` へ移した）。純粋な関数だけ（ブラウザ側とサーバの両方が使う）。
 * - 埋めた値は、保存されていない案（設計書 3 章）。利用者が変えられ、保存したものだけが通る。
 * - 開始の URL の判定（受けるか、Origin、ホスト名、path）は `src/config/target-config-draft.ts` の部品を使う（写さない）。
 * - プロファイルの ID の案は、ホスト名を `PROFILE_ID_PATTERN`（`src/control/contracts.ts`）に合う形に直したもの。合う形にできなければ空。
 *   MI-1: 案が使えない名前と重なるときの `-2`、`-3`…の付け方も、ここ（`uniqueProfileIdOf`。決めるのはサーバの作成の流れ）。
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

/** MI-1: 名前の案が重なったときに付ける最初の番号（`-2`）。 */
const FIRST_DUPLICATE_NUMBER = 2;

/** 名前 `candidate` を使えるか（`taken` にない、Windows の予約名でない、ID の形に合う）。 */
const isFreeProfileId = (candidate: string, taken: ReadonlySet<string>): boolean =>
  PROFILE_ID_PATTERN.test(candidate) && !taken.has(candidate) && !isReservedTargetConfigName(candidate);

/** `base` の先頭を、`suffix` を付けても ID の形に合う最も長い長さに切り、`suffix` を付ける（合わなければ空）。 */
const numberedProfileIdOf = (base: string, suffix: string): string => {
  for (let length = base.length; length > 0; length -= 1) {
    const candidate = `${base.slice(0, length).replace(TRAILING_HYPHENS, '')}${suffix}`;
    if (PROFILE_ID_PATTERN.test(candidate)) {
      return candidate;
    }
  }
  return '';
};

/**
 * MI-1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.2 の「隠す値」の表）: 名前の案 `suggestion` が、使えない名前（`taken`。既に
 * あるプロファイルの名前と、作るファイルの名前）と重なるときは、`-2`、`-3`…を付ける。長さの上限は `PROFILE_ID_PATTERN` だけが決める（写さない）。
 * Windows の予約名（CC-101）も使わない。案が空なら空（番号は `taken` の数より多くは要らない）。
 */
export const uniqueProfileIdOf = (suggestion: string, taken: ReadonlySet<string>): string => {
  if (suggestion === '' || isFreeProfileId(suggestion, taken)) {
    return suggestion;
  }
  // 番号ごとに名前は違うので、`taken` の数より 1 つ多く試せば、使える名前が必ずある（予約名は番号を付けると予約名でなくなる）。
  for (let number = FIRST_DUPLICATE_NUMBER; number <= FIRST_DUPLICATE_NUMBER + taken.size; number += 1) {
    const candidate = numberedProfileIdOf(suggestion, `${ID_SEPARATOR}${String(number)}`);
    if (isFreeProfileId(candidate, taken)) {
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

// MI-3: 認証の設定の画面の案（監査の path と成功の画面の path。`authSetupDraftOf`）の作り方は、ジョブの管理と同じ 1 か所
// （`src/control/auth/auth-setup-proposal.ts`）へ移した。

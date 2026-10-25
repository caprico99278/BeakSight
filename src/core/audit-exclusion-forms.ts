// 監査の除外（読まないパス・危険な語・読む範囲）で比べる path の形の作り方の、core の唯一の owner（CC-100）。Guard の要求の判定
// （`src/safety/request-policy.ts`）、認証の設定の保存の検証（`src/control/auth/auth-setup-policy.ts`）、READ の確かめの画面の path の保存の検証
// （`src/control/read-check-policy.ts`）が、同じ形を使う（control は safety を読めないので、core に置く）。比べ方は `audit-exclusion-match.ts`。
// - 読む範囲の形（`auditScopePathFormsOf`）: 生の path から、`%XX` を変わらなくなるまで戻す（`fullyPercentDecoded`）、連続した `/` をまとめる、
//   各 segment の `;` から後（path の引数）を外す、`.` と `..` を解決する、を新しい形が出なくなるまで重ねる（T25g-1）。大文字と小文字、Unicode
//   の書き方は変えない。
// - 除外の比べの形（`exclusionMatchPathFormsOf`）: 上の変換に、NFKC と大文字・小文字の畳み込み（`foldNfkcCase`）を加えて重ね（T25g-1 round 1）、
//   小文字にする。
// - 戻せない `%`、上限の回数まで変わり続ける値、形の数が上限を超える値は `null`（呼び出し側が、当たるものとして止める。fail-closed）。
// - T25g-1 で `request-policy.ts` に作った変換を、振る舞いを変えずにここへ移した（CC-100）。
import { foldNfkcCase } from './text.js';

/**
 * percent-encode を戻し直す回数の上限。上限まで戻しても変わり続ける値は、当たるものとして止める（二重、三重の encode で語を隠す URL に
 * 備える。fail-closed）。
 */
export const MAX_PERCENT_DECODE_ROUNDS = 4;

/**
 * 比べる path の形の数の上限（T25g-1）。形は、生の値と、それに「decode」「連続した `/` を 1 つにまとめる」「各 segment の `;` から後を外す」
 * 「`.` と `..` を解決する」を、どの順でも重ねて得られる形のすべてである。ふつうは十数個に収まる。上限を超えた値は、当たるものとして止める。
 */
export const MAX_AUDIT_PATH_FORMS = 64;

/** path の正規化（dot segment の解決）に使う、仮の基準の Origin。結果の pathname だけを使う。 */
export const PATH_NORMALIZATION_BASE = 'http://path.invalid';

/** path の形の `.` と `..` を解決するときに、path の一部のまま残すため percent-encode する区切りの文字（query と fragment の始まり）。 */
const PATH_DELIMITER_ESCAPES: ReadonlyMap<string, string> = new Map([['?', '%3F'], ['#', '%23']]);

/** 先頭の `/` の並び。 */
const LEADING_SLASHES = /^\/+/u;

/**
 * percent-encode を、変わらなくなるまで戻す（`MAX_PERCENT_DECODE_ROUNDS` 回まで）。戻せない値と、上限まで変わり続ける値は `null`
 * （呼び出し側が止める）。
 */
export const fullyPercentDecoded = (value: string): string | null => {
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
};

/** path の中の、連続した `/` を 1 つにまとめた形（T25g-1）。 */
const collapsedSlashesPath = (path: string): string =>
  path.split('/').filter((segment, index, segments) => segment.length > 0 || index === 0 || index === segments.length - 1).join('/');

/** path の各 segment の、`;` から後（path の引数）を外した形（T25g-1）。 */
const withoutSegmentParametersPath = (path: string): string =>
  path.split('/').map((segment) => {
    const parameterStart = segment.indexOf(';');
    return parameterStart < 0 ? segment : segment.slice(0, parameterStart);
  }).join('/');

/**
 * path の `.` と `..` を URL の解析器で解決した形。解決できない値は `null`。decode した形に含まれる `?` と `#` は、path の一部のまま
 * 解決するため、percent-encode してから渡す（後ろを query や fragment として落とさない）。
 */
const resolvedDotSegmentsPath = (path: string): string | null => {
  const pathOnly = [...path.replace(LEADING_SLASHES, '')].map((character) => PATH_DELIMITER_ESCAPES.get(character) ?? character).join('');
  try {
    return new URL(`${PATH_NORMALIZATION_BASE}/${pathOnly}`).pathname;
  } catch {
    return null;
  }
};

/** path の形を作る変換（作れない値は `null`）。 */
type PathFormTransform = (path: string) => string | null;

/** 読む範囲の判定に使う形の変換（大文字と小文字、Unicode の書き方は変えない）。 */
const AUDIT_SCOPE_PATH_TRANSFORMS: readonly PathFormTransform[] = Object.freeze([
  fullyPercentDecoded,
  collapsedSlashesPath,
  withoutSegmentParametersPath,
  resolvedDotSegmentsPath,
]);

/**
 * 除外のパスと危険な語の判定に使う形の変換（T25g-1 round 1）。読む範囲の判定の変換に、NFKC と大文字・小文字の畳み込み（`foldNfkcCase`）を加える
 * （畳み込みでできた `/`、`;`、`.` も、ほかの変換で重ねて扱う）。読む範囲の判定には使わない（畳み込みで範囲を広げない）。
 */
const EXCLUSION_MATCH_PATH_TRANSFORMS: readonly PathFormTransform[] = Object.freeze([...AUDIT_SCOPE_PATH_TRANSFORMS, foldNfkcCase]);

/** 生の path から、`transforms` の変換を新しい形が出なくなるまで重ねた形のすべて。作れない形があるか、数が上限を超えれば `null`。 */
const pathFormsOf = (rawPath: string, transforms: readonly PathFormTransform[]): readonly string[] | null => {
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
};

/** 読む範囲の判定に使う path の形（大文字と小文字は変えない）。作れなければ `null`。 */
export const auditScopePathFormsOf = (rawPath: string): readonly string[] | null => pathFormsOf(rawPath, AUDIT_SCOPE_PATH_TRANSFORMS);

/** 読まないパスと危険な語の比べに使う path の形（小文字）。作れなければ `null`。 */
export const exclusionMatchPathFormsOf = (rawPath: string): readonly string[] | null =>
  pathFormsOf(rawPath, EXCLUSION_MATCH_PATH_TRANSFORMS)?.map((path) => path.toLowerCase()) ?? null;

/**
 * 読む範囲の中か: 読む範囲の形（`auditScopePathFormsOf`）のすべてが、読む範囲のどれかで始まる（大文字と小文字を区別する。畳み込みで範囲を
 * 広げない）。読む範囲が空なら、範囲を絞らない（中とみなす）。
 */
export const isInsideAuditScope = (scopePathForms: readonly string[], auditPathPrefixes: readonly string[]): boolean =>
  auditPathPrefixes.length === 0 || scopePathForms.every((path) => auditPathPrefixes.some((prefix) => path.startsWith(prefix)));

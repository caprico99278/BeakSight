// 監査の段の除外（読まないパスと危険な語）の比べ方の、core の唯一の部品（T35R2-fix。T35R2 の M-4）。Guard の要求の判定
// （`src/safety/request-policy.ts` の `isAuditExcluded`・`isExcludedOrDangerous`）と、認証の設定の検証（`src/control/auth/auth-setup-policy.ts` の
// 登録した読み取りの手続きの呼び出しの path。control は safety を読めない）が、同じ比べ方を使う（写しを作らない）。
// - 比べる値（読まないパスと危険な語）は、小文字の形と、NFKC と大文字・小文字を畳んだ形の両方で比べる。空の値は、どれにも当たらない。
// - 読まないパス: 比べる path の形（呼び出し側が作る。小文字）のどれかが、値の形のどれかで始まれば当たる（前方一致）。
// - 危険な語: 比べる文字列（呼び出し側が作る path と query の形）のどれかが、値の形のどれかを含めば当たる。
import { foldNfkcCase } from './text.js';

/** 比べる値（読まないパスと危険な語）の、小文字の形と畳み込みの形。空の値は、どれにも当たらない。 */
export const comparableExclusionValues = (value: string): readonly string[] =>
  [value.toLowerCase(), foldNfkcCase(value)].filter((candidate) => candidate.length > 0);

/** path の形（小文字）のどれかが、読まないパスのどれかで始まるか。 */
export const hitsExcludedPathPrefix = (lowerPaths: readonly string[], excludedPathPrefixes: readonly string[]): boolean =>
  excludedPathPrefixes.some((prefix) =>
    comparableExclusionValues(prefix).some((candidate) => lowerPaths.some((path) => path.startsWith(candidate))));

/** 比べる文字列のどれかが、危険な語のどれかを含むか。 */
export const hitsDangerousTermIn = (searchedText: readonly string[], dangerousTerms: readonly string[]): boolean =>
  dangerousTerms.some((term) =>
    comparableExclusionValues(term).some((candidate) => searchedText.some((text) => text.includes(candidate))));

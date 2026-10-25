// 画面の path の READ の確かめの唯一の owner（T40b-2。Task 40 の設計書 7 章の「T40b-2 の設計（照合の READ の確かめ直し）」）。純粋な関数。
// - 保存の確かめ（`read-check-policy.ts` の画面の path の定義。T37d・T38c）と、ワーカーの実行のときの確かめ直し（`src/worker/read-check-run.ts` の API の
//   書き込みの照合の READ。`{id}` に取った ID を入れた具体的な path）が、同じこの関数を呼ぶ（第二の owner を作らない）。
// - 判定（上から順。形・開始の URL・Origin の誤りは 1 つだけ返し、読まないパスと危険な語は両方を返しうる）:
//   1. `READ_PAGE_PATH_INVALID`: path が正規の形でない（契約の `readCheckPageUrlOf` が組み立てない。比べる形を作れない。fail-closed）。
//   2. `READ_PAGE_START_URL_UNKNOWN`: プロファイルの開始の URL（ターゲット設定の `site.startUrl`）を読めない、その Origin で組み立てられない。
//   3. `READ_PAGE_ORIGIN_NOT_ALLOWED`: 開始の URL の Origin が、ターゲット設定の許可 Origin か、プロファイルの承認したテストの Origin の外。
//   4. `READ_PAGE_PATH_EXCLUDED`: 読まないパス、読む範囲の外、ログインの画面（セッションの切れの path）に当たる。
//   5. `READ_PAGE_PATH_DANGEROUS_WORD`: path が既定の危険な語（`DEFAULT_EXCLUDED_URL_WORDS`）に当たる。
// - path の比べる形は、Guard と同じ core の `src/core/audit-exclusion-forms.ts`（CC-100）: 読まないパス・ログインの画面・危険な語は
//   `exclusionMatchPathFormsOf`（小文字と畳み込み）、読む範囲は `auditScopePathFormsOf` と `isInsideAuditScope`（大文字と小文字を区別する）。比べ方は
//   `src/core/audit-exclusion-match.ts`（control は safety を読めない）。許可 Origin の比べ方は URL の意味の owner（`src/crawl/normalize-url.ts`）。
// - 置き場所: ワーカーが読み込んでよい control のファイル（`tests/architecture/worker-boundary-policy.ts` の `WORKER_ALLOWED_CONTROL_FILES`）。既定の危険な語の
//   owner（`auth/auth-setup-contracts.ts`）を読むため、control に置く。管理データ・画面・ブラウザに触れない。
import { auditScopePathFormsOf, exclusionMatchPathFormsOf, isInsideAuditScope } from '../core/audit-exclusion-forms.js';
import { hitsDangerousTermIn, hitsExcludedPathPrefix } from '../core/audit-exclusion-match.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../core/default-excluded-url-words.js';
import { isOriginInAllowedOrigins } from '../crawl/normalize-url.js';
import { readCheckPageUrlOf } from '../discovery/read-check-contracts.js';

/** 画面の path の確かめの理由（閉じた一覧。判定の順。READ の確かめの定義の保存を拒む理由 `READ_CHECK_DEFINITION_REJECTION_REASONS` の最後の 5 つ）。 */
export const READ_CHECK_PAGE_PATH_REJECTION_REASONS = Object.freeze([
  'READ_PAGE_PATH_INVALID',
  'READ_PAGE_START_URL_UNKNOWN',
  'READ_PAGE_ORIGIN_NOT_ALLOWED',
  'READ_PAGE_PATH_EXCLUDED',
  'READ_PAGE_PATH_DANGEROUS_WORD',
] as const);
export type ReadCheckPagePathRejection = (typeof READ_CHECK_PAGE_PATH_REJECTION_REASONS)[number];

/**
 * 画面の path の文脈（T37d。保存の口はプロファイルとターゲット設定と保存した認証の設定から、ワーカーは設定と認証つきの Run の指定から作る。ワーカーの実行の
 * 前の判定 `isReadUrlAllowed` と同じ値の出どころ）。
 * - `startUrl`: ターゲット設定の `site.startUrl`（この Origin で path を組み立てる）。
 * - `allowedOrigins`: ターゲット設定の `site.allowedOrigins`。`approvedTestOrigins`: プロファイルの承認したテストの Origin（両方の中だけ）。
 * - `excludedPathPrefixes`・`auditPathPrefixes`: 認証の設定の読まないパスと読む範囲（認証の設定がなければ空）。
 * - `sessionLostPathPrefix`: セッションの切れの path（ログインの画面。認証の設定がなければ null）。
 */
export interface ReadCheckPageContext {
  readonly startUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly approvedTestOrigins: readonly string[];
  readonly excludedPathPrefixes: readonly string[];
  readonly auditPathPrefixes: readonly string[];
  readonly sessionLostPathPrefix: string | null;
}

/** path の形だけを確かめるときに組み立てる Origin（どの Origin でも path の正規の形は同じ。開始の URL が分からないときと、保存の確かめ直し）。 */
export const READ_CHECK_PAGE_PATH_FORM_ORIGIN = 'http://127.0.0.1';

/** 開始の URL の Origin（読めなければ null）。 */
const startOriginOf = (page: ReadCheckPageContext | null): string | null => {
  try {
    return page === null ? null : new URL(page.startUrl).origin;
  } catch {
    return null;
  }
};

/**
 * 具体的な画面の path（型の印を持たない）の確かめの理由（判定の順。空なら受ける）。`page` が null なら、形を確かめた後に `READ_PAGE_START_URL_UNKNOWN`。
 */
export const readCheckPagePathRejectionsOf = (path: string, page: ReadCheckPageContext | null): readonly ReadCheckPagePathRejection[] => {
  const startOrigin = startOriginOf(page);
  const forms = exclusionMatchPathFormsOf(path);
  const scopeForms = auditScopePathFormsOf(path);
  // 開始の URL がなくても、path の形は確かめる（形の誤りが先）。
  if (readCheckPageUrlOf(READ_CHECK_PAGE_PATH_FORM_ORIGIN, path) === null || forms === null || scopeForms === null) {
    return ['READ_PAGE_PATH_INVALID'];
  }
  if (page === null || startOrigin === null || readCheckPageUrlOf(startOrigin, path) === null) {
    return ['READ_PAGE_START_URL_UNKNOWN'];
  }
  if (!isOriginInAllowedOrigins(page.allowedOrigins, startOrigin) || !isOriginInAllowedOrigins(page.approvedTestOrigins, startOrigin)) {
    return ['READ_PAGE_ORIGIN_NOT_ALLOWED'];
  }
  const rejections: ReadCheckPagePathRejection[] = [];
  const outsideScope = !isInsideAuditScope(scopeForms, page.auditPathPrefixes);
  const loginScreen = page.sessionLostPathPrefix !== null && page.sessionLostPathPrefix.length > 0
    && hitsExcludedPathPrefix(forms, [page.sessionLostPathPrefix]);
  if (hitsExcludedPathPrefix(forms, page.excludedPathPrefixes) || outsideScope || loginScreen) {
    rejections.push('READ_PAGE_PATH_EXCLUDED');
  }
  if (hitsDangerousTermIn(forms, DEFAULT_EXCLUDED_URL_WORDS)) {
    rejections.push('READ_PAGE_PATH_DANGEROUS_WORD');
  }
  return rejections;
};

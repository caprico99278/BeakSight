// 巡回の候補の取り出し（CCX-6。PRE42-CC 組 5b で Run Coordinator から移した。共通化の台帳の CC-070 (b)）。
// - Link の Evidence のうち、受け入れの判定が `INTERNAL_NAVIGABLE` で、正規化が `ok` のものを選ぶ式は、ここだけに書く（Gate
//   `run-lock-session-ownership` の (e)）。Run Coordinator（巡回の待ち行列）、発見のワーカーの流れ（`src/worker/discovery-run.ts`）、
//   Cross-page rule（`src/audit/cross-page-rules.ts` の内部のリンクの索引）が使う。
// - 純粋な関数だけのファイル（Playwright もブラウザも読み込まない）。
import type { LinkEvidence, NormalizedHttpUrlEvidence } from '../core/evidence-types.js';
import { crawlUrlHasDestructiveWord, linkTextHasDestructiveWord } from '../discovery/destructive-action.js';

/**
 * Link の Evidence のうち、巡回の候補にするもの（受け入れの判定が `INTERNAL_NAVIGABLE` で、正規化が `ok`）の正規化した URL（文書の順。重なりは
 * 取り除かない。巡回の待ち行列と、呼ぶ側が扱う）。
 */
export function internalNavigableUrlsOf(links: readonly LinkEvidence[]): NormalizedHttpUrlEvidence[] {
  return links.flatMap((link) => (link.admission.kind === 'INTERNAL_NAVIGABLE' && link.normalized.ok ? [link.normalized.url] : []));
}

/**
 * SD-1（設計書 `doc/design/2026-11-16-beaksight-action-based-delete-guard-design.md` 2.3）: 巡回で移るリンクの URL（`internalNavigableUrlsOf` のうち、削除に関する
 * 移動でないもの）。リンクの文字（見える文字・`aria-label`・`title`）が操作の前の判定の語に当たるか、URL の path と query が巡回の語
 * （`crawlUrlHasDestructiveWord`）に当たるリンクは移らず、その URL へのほかのリンクからも
 * 移らない（同じ要求になるため）。判定は操作の前の判定の owner（`src/discovery/destructive-action.ts`）。Cross-page rule の索引は、今までどおり
 * `internalNavigableUrlsOf` を使う。
 */
export function crawlableLinkUrlsOf(links: readonly LinkEvidence[]): NormalizedHttpUrlEvidence[] {
  const destructive = destructiveLinkTextUrlsOf(links);
  return internalNavigableUrlsOf(links).filter((url) => !destructive.has(url) && !crawlUrlHasDestructiveWord(url));
}

/**
 * SD-1: リンクの文字が削除の語に当たるリンクの、巡回の候補の URL（`crawlableLinkUrlsOf` の文字の側）。発見の巡回（`src/worker/discovery-run.ts`）は、URL の側を
 * 除外の記録つきの判定（`isExcludedCrawlCandidate`）で外すので、文字の側だけをこれで外す。
 */
export function destructiveLinkTextUrlsOf(links: readonly LinkEvidence[]): ReadonlySet<string> {
  return new Set<string>(internalNavigableUrlsOf(links.filter(linkTextHasDestructiveWord)));
}

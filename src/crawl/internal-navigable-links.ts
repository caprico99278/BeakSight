// 巡回の候補の取り出し（CCX-6。PRE42-CC 組 5b で Run Coordinator から移した。共通化の台帳の CC-070 (b)）。
// - Link の Evidence のうち、受け入れの判定が `INTERNAL_NAVIGABLE` で、正規化が `ok` のものを選ぶ式は、ここだけに書く（Gate
//   `run-lock-session-ownership` の (e)）。Run Coordinator（巡回の待ち行列）、発見のワーカーの流れ（`src/worker/discovery-run.ts`）、
//   Cross-page rule（`src/audit/cross-page-rules.ts` の内部のリンクの索引）が使う。
// - 純粋な関数だけのファイル（Playwright もブラウザも読み込まない）。
import type { LinkEvidence, NormalizedHttpUrlEvidence } from '../core/evidence-types.js';

/**
 * Link の Evidence のうち、巡回の候補にするもの（受け入れの判定が `INTERNAL_NAVIGABLE` で、正規化が `ok`）の正規化した URL（文書の順。重なりは
 * 取り除かない。巡回の待ち行列と、呼ぶ側が扱う）。
 */
export function internalNavigableUrlsOf(links: readonly LinkEvidence[]): NormalizedHttpUrlEvidence[] {
  return links.flatMap((link) => (link.admission.kind === 'INTERNAL_NAVIGABLE' && link.normalized.ok ? [link.normalized.url] : []));
}

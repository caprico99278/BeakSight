/**
 * L5 の N5（INV-LIMITS の表 A。設計者の判断 2026-11-10）: Mobile のビューポートで操作で確かめる候補の、唯一の選び方（純粋な関数）。
 * - Desktop の同じページに同じ候補がなかったものだけを確かめる（見えた違いを残らず確かめ、同じものを 2 回確かめない）。
 * - 同じ候補とは、識別（`candidateId`。要素の種類・role・名前・文字の指紋・関係の属性から作る digest）と、同じ識別の中の順番（`ordinal`）と、見えるか
 *   （`visible`）が同じもの（実装者の判断: Desktop で隠れていた部品が Mobile で見えるとき（狭い画面だけのメニューなど）は、Desktop では確かめられていないので、
 *   違いとして確かめる）。
 * - Desktop の候補が分からない（Desktop の候補の発見を終えられなかった）ときは、Mobile の候補を全部確かめる。
 */
import type { InteractionCandidateEvidence } from '../core/evidence-types.js';

type CandidateKeyFields = Pick<InteractionCandidateEvidence, 'candidateId' | 'ordinal' | 'visible'>;

const candidateKeyOf = (candidate: CandidateKeyFields): string => JSON.stringify([candidate.candidateId, candidate.ordinal, candidate.visible]);

/** Mobile の候補のうち、Desktop の候補になかったもの（Mobile の順）。 */
export function mobileOnlyInteractionCandidates<TCandidate extends CandidateKeyFields>(
  desktop: readonly CandidateKeyFields[] | null,
  mobile: readonly TCandidate[],
): readonly TCandidate[] {
  if (desktop === null) {
    return mobile;
  }
  const seen = new Set(desktop.map(candidateKeyOf));
  return mobile.filter((candidate) => !seen.has(candidateKeyOf(candidate)));
}

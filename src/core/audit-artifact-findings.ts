/**
 * T44f（Task 44 の設計書 P3-1 の B。ユーザーの判断 2026-10-21）: `audit.json` の最上位の `findings` の中身の、書く側と読む側の唯一の決まり（純粋な関数だけ）。
 * - 書く側（`ArtifactWriter`）: 最上位の `findings` には、どのページの結果の `findings` にも入っていない Finding（Cross-page の規則の Finding。ページの ID を
 *   持つものを含む）だけを書く（`runOnlyFindingsOf`）。ページの Finding はページの中（`pages[].findings`）に残る（同じ Finding を 2 回書かない）。
 * - 読む側: Run のすべての Finding は、ページの Finding（ページの順、ページの中の順）と、最上位の `findings` を、この順につないだもの
 *   （`findingsOfAuditArtifact`）。Run Coordinator の Finding の順（ページの Finding の後に Cross-page の Finding）と同じ。
 * - schema（`schemas/audit.schema.json`）の形は変えない（版は 1.0 のまま。説明だけ直した）。
 */
import type { Finding, PageAuditResult } from './contracts.js';

/** `audit.json` の、Finding を読むのに要る部分。 */
export interface AuditArtifactFindingsPart {
  readonly pages: readonly Pick<PageAuditResult, 'findings'>[];
  readonly findings: readonly Finding[];
}

/** 書く側: どのページの `findings` にも入っていない Finding（`findings` の順のまま。入力を変えない）。 */
export const runOnlyFindingsOf = (result: AuditArtifactFindingsPart): readonly Finding[] => {
  const pageFindingIds = new Set(result.pages.flatMap((page) => page.findings.map(({ findingId }) => findingId)));
  return result.findings.filter(({ findingId }) => !pageFindingIds.has(findingId));
};

/** 読む側: `audit.json` の、Run のすべての Finding（ページの Finding、最上位の `findings` の順。入力を変えない）。 */
export const findingsOfAuditArtifact = (audit: AuditArtifactFindingsPart): readonly Finding[] => [
  ...audit.pages.flatMap((page) => page.findings),
  ...audit.findings,
];

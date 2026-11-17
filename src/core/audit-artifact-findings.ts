/**
 * T44f（Task 44 の設計書 P3-1 の B。ユーザーの判断 2026-10-21）: `audit.json` の最上位の `findings` の中身の、書く側と読む側の唯一の決まり（純粋な関数だけ）。
 * - 書く側（`ArtifactWriter`）: 最上位の `findings` には、どのページの結果の `findings` にも入っていない Finding（Cross-page の規則の Finding。ページの ID を
 *   持つものを含む）だけを書く（`runOnlyFindingsByPageFindingIds`）。ページの Finding はページの `page.json` の中に残る（同じ Finding を 2 回書かない）。
 * - 読む側: Run のすべての Finding は、ページの Finding（ページの順、ページの中の順）と、最上位の `findings` を、この順につないだもの
 *   （`findingsOfAuditArtifact`）。Run Coordinator の Finding の順（ページの Finding の後に Cross-page の Finding）と同じ。
 * - REC-2: `audit.json` は目録（`audit-schema/2.0`）。ページは写さず、ページの `page.json` のパスの一覧だけを持つ。読む側は、目録のパスの `page.json` を
 *   読んで `pages` に渡す。
 */
import type { Finding, PageAuditResult } from './contracts.js';

/** Run の Finding を読むのに要る部分（`pages` は、目録のパスの順に読んだ `page.json`、`findings` は `audit.json` の最上位の `findings`）。 */
export interface AuditArtifactFindingsPart {
  readonly pages: readonly Pick<PageAuditResult, 'findings'>[];
  readonly findings: readonly Finding[];
}

/**
 * 書く側（MEM-3d: ページを 1 つずつ書く `ArtifactWriter.writeRun`）: ページの Finding の ID（`pageFindingIds`。ページを書きながら集めたもの）に入っていない
 * Finding（`findings` の順のまま。入力を変えない）。
 */
export const runOnlyFindingsByPageFindingIds = (findings: readonly Finding[], pageFindingIds: ReadonlySet<string>): readonly Finding[] =>
  findings.filter(({ findingId }) => !pageFindingIds.has(findingId));

/** 読む側: Run のすべての Finding（ページの Finding、`audit.json` の最上位の `findings` の順。入力を変えない）。 */
export const findingsOfAuditArtifact = (audit: AuditArtifactFindingsPart): readonly Finding[] => [
  ...audit.pages.flatMap((page) => page.findings),
  ...audit.findings,
];

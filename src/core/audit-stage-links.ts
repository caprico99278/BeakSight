// 点検の段の成果物から、見つけたリンクを読む唯一の部品（OP-J の J1 で `src/worker/discovery-run.ts` に置いた読み方を、OP-R（設計書
// `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.9 の R1・R2）でここへ移した。ワーカーの操作さがしの段と、画面のサーバの自動の下書きが使う）。
// - 読む所: Run のディレクトリの `pages/<pageId>/page.json`（ページの ID の順。リンクは文書の順）の、Desktop の `link` の Evidence の、受け入れが
//   `INTERNAL_NAVIGABLE` で正規化できたリンク（点検の段が見つけたリンクの持ち主は 1 つ）。形の違う行は使わない。
// - 読み取りは、リンクをたどらない部品（`readContainedArtifactFile`）で行う。読めない・形の違うファイルは飛ばす（読む先がなければ空）。例外を投げない。
// - 正規化し直し・許可 Origin・巡回の候補の除外は、呼ぶ側が行う（ここは成果物の形を読むだけ）。
import { readdir } from 'node:fs/promises';
import { PAGES_ARTIFACT_DIRECTORY, artifactFilePath, pageArtifactRelativePath } from './artifact-layout.js';
import { readContainedArtifactFile } from './contained-artifact-file.js';
import { isPageId } from './ids.js';

/** 点検の段の成果物の、リンクの Evidence の 1 行として読む形（読めた項目だけ）。 */
export interface AuditStageLinkFacts {
  readonly anchorText: string;
  readonly ariaLabel: string | null;
  readonly title: string | null;
  /** 正規化した URL（成果物の値のまま）。 */
  readonly url: string;
}

const stringOrNull = (value: unknown): string | null | undefined => (value === null || typeof value === 'string' ? value : undefined);

/** `page.json` の 1 つの Evidence から、Desktop の `link` の Evidence の、受け入れが `INTERNAL_NAVIGABLE` で正規化できたリンクを読む（純粋）。 */
export const auditStageLinksOfEvidence = (record: unknown): readonly AuditStageLinkFacts[] => {
  if (typeof record !== 'object' || record === null) {
    return [];
  }
  const { type, viewport, payload } = record as Record<string, unknown>;
  const links = type === 'link' && viewport === 'desktop' && typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)['links']
    : undefined;
  if (!Array.isArray(links)) {
    return [];
  }
  return links.flatMap((link: unknown): AuditStageLinkFacts[] => {
    if (typeof link !== 'object' || link === null) {
      return [];
    }
    const { anchorText, ariaLabel, title, normalized, admission } = link as Record<string, unknown>;
    const label = stringOrNull(ariaLabel);
    const named = stringOrNull(title);
    const target = typeof normalized === 'object' && normalized !== null ? normalized as Record<string, unknown> : null;
    const admitted = typeof admission === 'object' && admission !== null && (admission as Record<string, unknown>)['kind'] === 'INTERNAL_NAVIGABLE';
    const url = target?.['ok'] === true ? target['url'] : undefined;
    if (typeof anchorText !== 'string' || label === undefined || named === undefined || !admitted || typeof url !== 'string') {
      return [];
    }
    return [{ anchorText, ariaLabel: label, title: named, url }];
  });
};

/** 点検の段の Run のディレクトリ（絶対パス）の成果物から、見つけたリンクを、ページの ID の順・文書の順に読む（ファイルの先頭の説明）。 */
export async function readAuditStageLinks(auditRunDirectory: string): Promise<readonly AuditStageLinkFacts[]> {
  let names: string[];
  try {
    names = (await readdir(artifactFilePath(auditRunDirectory, PAGES_ARTIFACT_DIRECTORY))).sort();
  } catch {
    return [];
  }
  const found: AuditStageLinkFacts[] = [];
  for (const pageId of names) {
    if (!isPageId(pageId)) {
      continue;
    }
    let evidence: unknown;
    try {
      // 大きさの上限は、読み取りの部品の既定。
      const reading = await readContainedArtifactFile(auditRunDirectory, pageArtifactRelativePath(pageId, 'page'));
      if (!reading.ok) {
        continue;
      }
      evidence = (JSON.parse(reading.bytes.toString('utf8')) as Record<string, unknown>)['evidence'];
    } catch {
      continue;
    }
    found.push(...(Array.isArray(evidence) ? evidence.flatMap(auditStageLinksOfEvidence) : []));
  }
  return found;
}

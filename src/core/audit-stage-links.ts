// 点検の段の成果物から、見つけたリンクを読む唯一の部品（OP-J の J1 で `src/worker/discovery-run.ts` に置いた読み方を、OP-R（設計書
// `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.9 の R1・R2）でここへ移した。ワーカーの操作さがしの段と、画面のサーバの自動の下書きが使う）。
// - 読む所: Run のディレクトリの `pages/<pageId>/page.json`（ページの ID の順。リンクは文書の順）の、Desktop の `link` の Evidence の、受け入れが
//   `INTERNAL_NAVIGABLE` で正規化できたリンク（点検の段が見つけたリンクの持ち主は 1 つ）。形の違う行は使わない。
// - 読み取りは、リンクをたどらない部品（`readContainedArtifactFile`）で行う。読めない・形の違うファイルは飛ばす（読む先がなければ空）。例外を投げない。
// - 正規化し直し・許可 Origin・巡回の候補の除外は、呼ぶ側が行う（ここは成果物の形を読むだけ）。
// - DSEED（設計書 `2026-11-19-beaksight-discovery-seed-from-audit-design.md`）: 同じ読み方で、点検の段で読んだ画面の URL も読む（`readAuditStagePages`）。
//   SKIP-1: 押す物がないと点検の段の証拠で分かる画面の判定も、ここの 1 か所（`auditStagePageWithoutDiscoveryCandidates`）。
import { readdir } from 'node:fs/promises';
import { PAGES_ARTIFACT_DIRECTORY, artifactFilePath, pageArtifactRelativePath } from './artifact-layout.js';
import { readContainedArtifactFile } from './contained-artifact-file.js';
import { isOutsideAuditScopeNavigation, type IncompleteReasonCode } from './contracts.js';
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

/** 点検の段の Run のディレクトリ（絶対パス）の各 `page.json` を、ページの ID の順に読む（読めない・形の違うファイルは飛ばす。例外を投げない）。 */
async function readAuditStagePageRecords(auditRunDirectory: string): Promise<readonly Record<string, unknown>[]> {
  let names: string[];
  try {
    names = (await readdir(artifactFilePath(auditRunDirectory, PAGES_ARTIFACT_DIRECTORY))).sort();
  } catch {
    return [];
  }
  const records: Record<string, unknown>[] = [];
  for (const pageId of names) {
    if (!isPageId(pageId)) {
      continue;
    }
    try {
      // 大きさの上限は、読み取りの部品の既定。
      const reading = await readContainedArtifactFile(auditRunDirectory, pageArtifactRelativePath(pageId, 'page'));
      const parsed: unknown = reading.ok ? JSON.parse(reading.bytes.toString('utf8')) : null;
      if (typeof parsed === 'object' && parsed !== null) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }
  return records;
}

/** 点検の段の Run のディレクトリ（絶対パス）の成果物から、見つけたリンクを、ページの ID の順・文書の順に読む（ファイルの先頭の説明）。 */
export async function readAuditStageLinks(auditRunDirectory: string): Promise<readonly AuditStageLinkFacts[]> {
  return (await readAuditStagePageRecords(auditRunDirectory)).flatMap(({ evidence }) => (Array.isArray(evidence) ? evidence.flatMap(auditStageLinksOfEvidence) : []));
}

/** 未完了の理由の並び（形の違う行は飛ばす）に、点検の範囲の外へ移った読み込みの失敗（`isOutsideAuditScopeNavigation`）があるか。 */
const hasOutsideAuditScopeReason = (reasons: unknown): boolean => Array.isArray(reasons) && reasons.some((reason: unknown) => {
  if (typeof reason !== 'object' || reason === null) {
    return false;
  }
  const { code, detail } = reason as Record<string, unknown>;
  return typeof code === 'string' && (typeof detail === 'string' || detail === null)
    && isOutsideAuditScopeNavigation({ code: code as IncompleteReasonCode, detail });
});

/** 点検の段で読んだ画面（`readAuditStagePages` の 1 行）。 */
export interface AuditStagePage {
  /** 画面の URL（`page.json` の `pageUrl`。成果物の値のまま）。 */
  readonly url: string;
  /** SKIP-1: 操作さがしが押す物がないと、点検の段の証拠で分かったか（`auditStagePageWithoutDiscoveryCandidates`）。 */
  readonly withoutDiscoveryCandidates: boolean;
}

/** 1 つのビューポートの DOM の Evidence の、操作さがしの候補の数（DOM の記録がない・どれかに数がないときは `null`。数は記録の最大）。 */
const discoveryCandidateCountOf = (evidence: readonly unknown[], viewport: string): number | null => {
  const counts = evidence.flatMap((record: unknown): (number | null)[] => {
    if (typeof record !== 'object' || record === null) return [];
    const { type, viewport: recorded, payload } = record as Record<string, unknown>;
    if (type !== 'dom' || recorded !== viewport) return [];
    const count = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)['discoveryCandidateCount'] : undefined;
    return [typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null];
  });
  return counts.length === 0 || counts.includes(null) ? null : Math.max(...(counts as number[]));
};

/**
 * SKIP-1（設計書 `2026-11-20-beaksight-discovery-skip-and-debug-timing-design.md` 2.1）: 点検の段の 1 画面の記録（`page.json`）から、操作さがしが押す物がないと
 * 分かるか（判定の唯一の所）。Desktop と Mobile の両方の DOM の Evidence の、操作さがしの候補の数（`discoveryCandidateCount`。数え方は操作さがしの probe と共通の
 * 部品）が 0 のときだけ真。Mobile が同じ中身の画面（`sameness.depth` が `SAME`）で始めなかったときは、Desktop の数を両方に使う。数がない（前の版の記録）・
 * 読めないときは偽（読む側に倒す）。
 */
export const auditStagePageWithoutDiscoveryCandidates = (record: unknown): boolean => {
  if (typeof record !== 'object' || record === null) return false;
  const { evidence, sameness } = record as Record<string, unknown>;
  if (!Array.isArray(evidence)) return false;
  const desktop = discoveryCandidateCountOf(evidence, 'desktop');
  const sameAsEarlier = typeof sameness === 'object' && sameness !== null && (sameness as Record<string, unknown>)['depth'] === 'SAME';
  const mobile = sameAsEarlier && !evidence.some((item: unknown) => typeof item === 'object' && item !== null
    && (item as Record<string, unknown>)['type'] === 'dom' && (item as Record<string, unknown>)['viewport'] === 'mobile')
    ? desktop
    : discoveryCandidateCountOf(evidence, 'mobile');
  return desktop === 0 && mobile === 0;
};

/**
 * DSEED（設計書 `2026-11-19-beaksight-discovery-seed-from-audit-design.md` 2 章の 1）: 点検の段で読んだ画面（各 `page.json` の `pageUrl`。成果物の値のまま）を、
 * 点検の順（ページの ID の順）に読む。点検の範囲の外へ移った画面（ページかビューポートの未完了の理由が `isOutsideAuditScopeNavigation`）は入れない。読めなかった
 * 画面（失敗）は入れる。正規化し直し・許可 Origin・巡回の候補の除外・重なりの除きは、呼ぶ側が行う。SKIP-1: 押す物がないと分かった画面に印を付ける。
 */
export async function readAuditStagePages(auditRunDirectory: string): Promise<readonly AuditStagePage[]> {
  return (await readAuditStagePageRecords(auditRunDirectory)).flatMap((record): AuditStagePage[] => {
    const { pageUrl, incompleteReasons, viewports } = record;
    const viewportReasons = typeof viewports === 'object' && viewports !== null
      ? Object.values(viewports as Record<string, unknown>).map((viewport) => (typeof viewport === 'object' && viewport !== null ? (viewport as Record<string, unknown>)['incompleteReasons'] : undefined))
      : [];
    return typeof pageUrl === 'string' && pageUrl !== '' && ![incompleteReasons, ...viewportReasons].some(hasOutsideAuditScopeReason)
      ? [{ url: pageUrl, withoutDiscoveryCandidates: auditStagePageWithoutDiscoveryCandidates(record) }]
      : [];
  });
}

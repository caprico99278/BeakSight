// RCA-8（検索の確かめの設計書 2.4）: 検索の確かめの結果の見せ方の材料を作る唯一の部品（純粋）。見るだけの確かめの成果物（`read-evidence.json` の `searchChecks`）と、
// 操作さがしの成果物（`discovery.json` の `searchTriggers`。押下・選択・入力で出た 5xx）から、ためした数と誤りの一覧を作る。作業の画面の要点と、プロファイルの
// 詳細の要点の 1 行が、ここを使う（文言は `src/presentation/messages.ts`）。欄の名前・URL・値は一覧に入れない（画面の名前・どう試したか・起きたことだけ）。
import { discoveryPageScreenNameOf, type DiscoveryDocument } from './discovery-result.js';
import type { ReadEvidenceDocument, SearchCheckDetail, SearchCheckHow } from './read-check-evaluation.js';
import { hasSearchServerError, type SearchTriggerKind } from './search-read-contracts.js';

/** 誤りの 1 つ（どの画面で、どう試したら、何が起きたか）。 */
export interface SearchCheckErrorItem {
  /** 画面の名前（見出しか題。なければ null で、呼ぶ側が「名前のない画面」と出す）。 */
  readonly screenName: string | null;
  /** どう試したか（見るだけの確かめの組の試し方か、操作さがしのきっかけの種類 `EXPLORATION`）。 */
  readonly tried:
    | { readonly by: 'SEARCH_CHECK'; readonly how: SearchCheckHow }
    | { readonly by: 'EXPLORATION'; readonly trigger: SearchTriggerKind };
  /** 起きたこと（見るだけの確かめの誤りの理由。操作さがしは常に `SERVER_ERROR`）。 */
  readonly happened: Extract<SearchCheckDetail, 'SERVER_ERROR' | 'NOT_OPENED' | 'LOGIN_BOUNCE'>;
}

/**
 * 検索の確かめの結果（ためした数は、見るだけの確かめで確かめた組の数）。REV-RCA の M-2: 操作さがしで記録した 5xx（`explorationErrors`）は、見るだけの確かめの
 * 誤り（`errors`）と分け、ためした数と誤りの数に混ぜない（同じ画面・同じきっかけの種類は 1 つにまとめる）。
 */
export interface SearchCheckOutcome {
  readonly tried: number;
  readonly errors: readonly SearchCheckErrorItem[];
  readonly explorationErrors: readonly SearchCheckErrorItem[];
}

/** 誤りの理由か。 */
const isErrorDetail = (detail: SearchCheckDetail): detail is SearchCheckErrorItem['happened'] =>
  detail === 'SERVER_ERROR' || detail === 'NOT_OPENED' || detail === 'LOGIN_BOUNCE';

/**
 * 結果を作る（純粋）。見るだけの確かめの成果物も、操作さがしの誤りもなければ null（出すものがない）。見るだけの確かめの誤りは組の順、操作さがしの誤りは画面の順、
 * きっかけの順（同じ画面・同じ種類は 1 つ）。
 */
export const searchCheckOutcomeOf = (
  evidence: Pick<ReadEvidenceDocument, 'searchChecks'> | null,
  discovery: Pick<DiscoveryDocument, 'pages'> | null,
): SearchCheckOutcome | null => {
  const screenNameOf = (path: string): string | null => (discovery === null ? null : discoveryPageScreenNameOf(discovery as DiscoveryDocument, path));
  const checked = (evidence?.searchChecks ?? []).flatMap((check) => (check.state === 'EXECUTED' ? [check] : []));
  const fromChecks = checked.flatMap((check): SearchCheckErrorItem[] => (isErrorDetail(check.detail)
    ? [Object.freeze({ screenName: screenNameOf(check.pagePath), tried: Object.freeze({ by: 'SEARCH_CHECK' as const, how: check.how }), happened: check.detail })]
    : []));
  const seen = new Set<string>();
  const fromDiscovery = (discovery?.pages ?? []).flatMap((page): SearchCheckErrorItem[] => (page.state !== 'READ' || page.record.location === null
    ? []
    : (page.record.searchTriggers ?? []).filter(hasSearchServerError).flatMap((record) => {
      const path = page.record.location?.path ?? '';
      const key = JSON.stringify([path, record.trigger.kind]);
      if (seen.has(key)) return [];
      seen.add(key);
      return [Object.freeze({
        screenName: screenNameOf(path),
        tried: Object.freeze({ by: 'EXPLORATION' as const, trigger: record.trigger.kind }),
        happened: 'SERVER_ERROR' as const,
      })];
    })));
  if (evidence === null && fromDiscovery.length === 0) {
    return null;
  }
  return Object.freeze({ tried: checked.length, errors: Object.freeze(fromChecks), explorationErrors: Object.freeze(fromDiscovery) });
};

// 発見のジョブの成果物 `discovery.json` から候補を探す読み方の唯一の owner（Task 27 の設計書 4.7、Task 28 の設計書 3 章の「発見の根拠の写し」。T28c）。
// - 同じ識別の digest の候補をまとめた後（`mergeDiscoveryCandidates`。ジョブの管理と READ の実行と同じまとめ方）で探す。
// - 画面のサーバ（`apps/local-ui/src/server/discovery-documents.ts`。READ の確かめの定義の保存の確かめと、候補の詳しい内容の表示）と、シナリオの
//   保存の部品（`src/control/approval/scenario-store.ts`。発見の根拠の写し）が、ここを使う（T28c で画面のサーバから移した。書き写さない）。
// - 純粋な関数だけ。成果物のファイルを読むこと（スキーマとジョブの ID の確かめ）は、画面のサーバの部品（`readJobResultDocument`）が行い、
//   読んだ文書をここに渡す。
import type { DiscoveryCandidate } from '../discovery/candidate-contracts.js';
import { discoveryCandidatesOf, mergeDiscoveryCandidates, type DiscoveryDocument } from '../discovery/discovery-result.js';

/** 文書の候補を、同じ識別の digest でまとめた一覧（文書がなければ空）。 */
export const mergedDiscoveryCandidatesOf = (document: Pick<DiscoveryDocument, 'pages'> | null): readonly DiscoveryCandidate[] =>
  document === null ? Object.freeze([]) : mergeDiscoveryCandidates(discoveryCandidatesOf(document));

/** 文書の、識別の digest の候補（まとめた後。文書か候補がなければ null）。 */
export const candidateOfDiscoveryDocument = (
  document: Pick<DiscoveryDocument, 'pages'> | null,
  identityDigest: string,
): DiscoveryCandidate | null => mergedDiscoveryCandidatesOf(document).find((candidate) => candidate.identityDigest === identityDigest) ?? null;

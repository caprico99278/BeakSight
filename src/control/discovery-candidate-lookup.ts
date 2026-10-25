// 発見のジョブの成果物 `discovery.json` から候補を探す読み方の唯一の owner（Task 27 の設計書 4.7、Task 28 の設計書 3 章の「発見の根拠の写し」。T28c）。
// - 同じ識別の digest の候補をまとめた後（`mergeDiscoveryCandidates`。ジョブの管理と READ の実行と同じまとめ方）で探す。
// - 画面のサーバ（`apps/local-ui/src/server/discovery-documents.ts`。READ の確かめの定義の保存の確かめと、候補の詳しい内容の表示）と、シナリオの
//   保存の部品（`src/control/approval/scenario-store.ts`。発見の根拠の写し）が、ここを使う（T28c で画面のサーバから移した。書き写さない）。
// - 純粋な関数だけ。成果物のファイルを読むこと（スキーマとジョブの ID の確かめ）は、画面のサーバの部品（`readJobResultDocument`）が行い、
//   読んだ文書をここに渡す。
import type { DiscoveryCandidate } from '../discovery/candidate-contracts.js';
import { discoveryCandidatesOf, mergeDiscoveryCandidates, type DiscoveryDocument } from '../discovery/discovery-result.js';
import type { SubmissionProbeRecord } from '../discovery/submission-probe-contracts.js';

/** 文書の候補を、同じ識別の digest でまとめた一覧（文書がなければ空）。 */
export const mergedDiscoveryCandidatesOf = (document: Pick<DiscoveryDocument, 'pages'> | null): readonly DiscoveryCandidate[] =>
  document === null ? Object.freeze([]) : mergeDiscoveryCandidates(discoveryCandidatesOf(document));

/** 文書の、識別の digest の候補（まとめた後。文書か候補がなければ null）。 */
export const candidateOfDiscoveryDocument = (
  document: Pick<DiscoveryDocument, 'pages'> | null,
  identityDigest: string,
): DiscoveryCandidate | null => mergedDiscoveryCandidatesOf(document).find((candidate) => candidate.identityDigest === identityDigest) ?? null;

/**
 * T38a（Task 38 の設計書 3.1）: 文書の、識別の digest と型の digest で引いた行（まとめた後。同じ識別で型が違う行は別に残るので、シナリオが型で行を
 * 選ぶ）。T38b・T38d が使う。probe の欄の範囲（`inputFields`）を持たない行（T38a の前の成果物。目印の番号が押下ごとに振り直されていないので、型の
 * digest が今の求め方と違いうる）は引かない（null。発見をやり直す）。文書か行がなければ null。
 * T38R2-fix の R2-I-1: 同じ識別で、その型の書き込みでない probe（2 つの要求を送った probe の最初の型など）があれば、まとめた後の行は書き込みでない
 * 行（`mergeDiscoveryCandidates`）なので、それを返す（下書きの確かめが `SCENARIO_API_CANDIDATE_NOT_API` で拒む。書き込みの行を選び直さない）。
 */
export const candidateOfDiscoveryDocumentByShape = (
  document: Pick<DiscoveryDocument, 'pages'> | null,
  identityDigest: string,
  shapeDigest: string,
): DiscoveryCandidate | null => mergedDiscoveryCandidatesOf(document).find((candidate) =>
  candidate.identityDigest === identityDigest
  && candidate.submissionProbe?.inputFields !== undefined
  && candidate.submissionProbe.shapeDigest === shapeDigest) ?? null;

/**
 * 文書の、識別の digest の候補の、送らずに観察する probe の結果（T37c。Task 37 の設計書 3.4）。まとめた後の行のうち、その識別の digest の行の結果を、
 * 行の順に返す（まとめ方は型ごとに別の行を残すので、型の違う結果は別々に並ぶ。probe の結果のない行は除く。文書がなければ空）。
 */
export const submissionProbesOfDiscoveryDocument = (
  document: Pick<DiscoveryDocument, 'pages'> | null,
  identityDigest: string,
): readonly SubmissionProbeRecord[] => Object.freeze(mergedDiscoveryCandidatesOf(document).flatMap((candidate) =>
  (candidate.identityDigest === identityDigest && candidate.submissionProbe !== undefined ? [candidate.submissionProbe] : [])));

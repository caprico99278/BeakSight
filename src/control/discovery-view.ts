// 操作の候補の発見と READ の確かめの、画面（`apps/local-ui/`）に要る型と閉じた一覧と純粋な部品を、`src/discovery/` から公開し直す 1 か所
// （Task 27 の設計書 4.7。T27f）。
// - 画面のコードは `src/discovery/` を直接 import できない（`tests/architecture/local-ui-boundary.test.ts` の (f)）。画面は、ここから型と値を
//   読む（書き写さない）。意味の owner は、それぞれの `src/discovery/` のファイルのまま（ここは名前を公開し直すだけで、判断を持たない）。
// - 公開するのは、純粋な契約（候補の契約、READ の確かめの契約、成果物 `discovery.json`・`read-evidence.json` の形）と、成果物を読む純粋な関数
//   だけ。ブラウザの部品（probe、listener、落ち着きの待ち、READ の実行）は公開しない。
// - ブラウザ側の画面のコードは、ここから型だけを import する（値はサーバの Server Function が返す）。

export {
  CANDIDATE_CLASSIFICATIONS,
  CANDIDATE_FIELD_TAGS,
  CANDIDATE_FIELD_TYPES,
  CANDIDATE_KINDS,
  CANDIDATE_REASON_CODES,
  FIELD_CONSTRAINT_NAMES,
  FORM_ENCTYPES,
  FORM_METHODS,
  INCOMPLETE_REASONS,
  LISTENER_KINDS,
  METHOD_OVERRIDE_VALUES,
} from '../discovery/candidate-contracts.js';
export type {
  CandidateAction,
  CandidateClassification,
  CandidateField,
  CandidateFieldTag,
  CandidateFieldType,
  CandidateKind,
  CandidateLocation,
  CandidateReasonCode,
  DiscoveryCandidate,
  FieldConstraintName,
  FormEnctype,
  FormMethod,
  IncompleteReason,
  ListenerKind,
  MethodOverride,
} from '../discovery/candidate-contracts.js';

export {
  DISCOVERY_END_REASONS,
  DISCOVERY_UNREAD_REASONS,
  discoveryCandidatesOf,
  discoverySummaryOf,
  mergeDiscoveryCandidates,
} from '../discovery/discovery-result.js';
export type {
  DiscoveryDocument,
  DiscoveryEndReason,
  DiscoveryPageEntry,
  DiscoveryUnreadReason,
} from '../discovery/discovery-result.js';

export {
  MAX_READ_CHECK_DEFINITIONS_PER_PROFILE,
  MAX_READ_CHECK_DETAIL_FIELD_LENGTH,
  MAX_READ_CHECK_EXPECTATIONS,
  MAX_READ_CHECK_EXPECTED_TEXT_LENGTH,
  MAX_READ_CHECK_PARAMETER_VALUE_LENGTH,
  MAX_READ_CHECK_ROW_COUNT,
  READ_CHECK_EXPECTATION_KINDS,
  READ_CHECK_RESULTS,
  isSendableReadCheckParameter,
} from '../discovery/read-check-contracts.js';
export type {
  ReadCheckDefinition,
  ReadCheckExpectation,
  ReadCheckExpectationKind,
  ReadCheckParameters,
  ReadCheckResult,
} from '../discovery/read-check-contracts.js';

export {
  READ_CHECK_DETAILS,
  READ_CHECK_END_REASONS,
  READ_EXPECTATION_RESULTS,
  READ_EXPECTATION_UNDETERMINED_REASONS,
  READ_ROW_SOURCES,
} from '../discovery/read-check-evaluation.js';
export type {
  ReadCheckDetail,
  ReadCheckEndReason,
  ReadCheckEvidence,
  ReadEvidenceDocument,
  ReadExpectationEvidence,
  ReadExpectationResult,
  ReadExpectationUndeterminedReason,
  ReadRowSource,
} from '../discovery/read-check-evaluation.js';

// T31h-1（Task 31 の設計書 3 章の「UPDATE の指定」）: 候補から作れる path の型の組の一覧（画面が ID の区切りを選んで型を作る。ID の形の判定は、
// 画面のサーバが `src/control/actions/action-outcome.ts` の `usableRecordIdOf` を渡す）。T31h-2: 型に ID を入れた具体的な path（開始の画面が、
// 予定のレコードの送り先と画面の path を出す。CCX-28 の owner の関数）。
export { concretePathOfTemplate, pathTemplateOptionsOf } from '../discovery/fingerprint.js';
export type { PathTemplateOption } from '../discovery/fingerprint.js';

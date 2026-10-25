// 画面のサーバ（親）と監査のワーカー（子）の IPC の契約の唯一の owner（Task 24 の設計書 4.3、5 章。T24d）。
// - 版つき（`WORKER_PROTOCOL_VERSION`）。親 → 子: `START`、`STOP`。子 → 親: `READY`、`RUN_STARTED`、`PROGRESS`、`NOTICE`、`AUTH_STATE`、
//   `HEARTBEAT`、`RUN_FINALIZING`（DEF-143。「Run の終わり」の段に入る知らせ）、`FINISHED`、`FAILED`。
// - 認証つきの監査（Task 25 の設計書 4.4。T25d）: `START` の省略できる `authentication` に、親が開始の直前に検証した認証の設定の文書（秘密を
//   含まない）と、プロファイルの `approvedTestOrigins` と、その 2 つの SHA-256（`workerAuthenticationDigestOf`）を入れる。子 → 親の
//   `AUTH_STATE` は、ログインの段とセッションの状態の知らせ（値と秘密を含まない。`SESSION_LOST` だけ、止まったページの URL を持つ）。
// - 自動ログイン（Task 26 の設計書 3 章、4.4、4.5。T26d-2）: `START` に、ジョブの種類（`jobKind`。`AUDIT`・`LOGIN_CHECK`）と、自動ログインの
//   ときだけ `authentication.automatedLogin`（資格情報の改訂の番号と、資格情報のフォルダを決める根の絶対パス。どちらも秘密でない）を足した。
//   資格情報の値・暗号文・ユーザー名は `START` に入れない（スキーマの `additionalProperties: false` で拒む。復号はワーカーだけ）。SHA-256
//   （`workerAuthenticationDigestOf`）は、ジョブの種類と `automatedLogin` も含める。`AUTH_STATE` は、自動ログインの段の結果（閉じた一覧の結果、
//   送信したか、`Retry-After` の期限、フォームの確かめの理由のコード）を `automatedLogin` で持てる（値・誤りの文・URL は持てない）。
// - 発見のジョブ（Task 27 の設計書 4.6。T27d）: `DISCOVERY` の `START` は、認証つき（`authentication`）だけ。`FINISHED` は、候補を載せず、
//   `discovery.json` の場所（`outcome.runDirectory`）と、Run を実行した結果だけの件数の要約（`discovery`）を持てる。
// - READ の確かめのジョブ（Task 27 の設計書 4.5、4.6。T27e）: `READ_CHECK` の `START` は、認証つき（`authentication`）で、定義の一覧（`readChecks`。
//   1〜`MAX_READ_CHECKS_PER_JOB` 件。定義の ID・版・対象の候補の画面・定義の中身。ワーカーは管理データを読まないので、親が入れる）を必ず持つ。
//   ほかの種類は持たない。秘密に見える名前の送る値は、契約で拒む（保存の拒否と同じ判定 `isSecretUrlQueryParameterName`。fail-closed）。`FINISHED` は、
//   結果を載せず、`read-evidence.json` の場所（`outcome.runDirectory`）と、Run を実行した結果だけの件数の要約（`readCheck`）を持てる。
// - 書き込みのジョブ（Task 30 の設計書 3 章の「送る直前の確かめ直し」「予約の締め」、4 章の「IPC」。T30e。版を `/2` に上げた）: `WRITE_CREATE` の
//   `START` は、認証つき（ログインを使う方式）で、書き込みの指定（`write`。シナリオの id と版、許可の id、承認した候補の要求の形、書き込みの画面、
//   候補の 2 つの digest、候補の欄の名前と型と状態、送る値（生成した値）、検証の指定、照合の READ（生成した値を結び付けた後の定義））を必ず持つ。
//   ほかの種類は持てない。資格情報・Cookie・CSRF のトークン・hidden の値は持たない（スキーマで項目を置かない）。子 → 親の
//   `WRITE_RECHECK_REQUEST`（送る直前の確かめ直しの依頼。1 つのジョブで 1 回）と、親 → 子の `WRITE_RECHECK_RESULT`（許すか、拒む理由）、子 → 親の
//   `WRITE_SUBMISSION`（送信の報告。1 回）を足した。ワーカーは、親の結果を `WORKER_WRITE_RECHECK_TIMEOUT_MS` だけ待ち、来なければ送らない。
//   T40a（Task 40 の設計書 3.2）: `WRITE_CREATE` の書き込みの指定に、送り方 API の形（`WorkerStartApiWrite`。`transport: 'API'`）を足した（版は
//   変えない。form の書き込みの指定は今のまま）。照合の READ の `{id}` の型の画面の READ は、API の書き込みの指定だけで受ける。
// - 入口の確かめのジョブ（Task 43 の設計書 4.3。T43c）: `ENTRY_CHECK` の `START` は、認証の指定を持たない。`FINISHED` は、読んだ事実と案を載せず、
//   `entry-check.json` の場所（`outcome.runDirectory`）と、Run を実行した結果だけの件数の要約（`entryCheck`）を持てる。
// - まとめて実行（FM2d）: `START` は 1 回のまま、`chain`（段の並び。閉じた一覧 `WORKER_CHAIN_STAGE_SEQUENCES`。認証つきだけ）を持てる。親 → 子の `NEXT_STAGE`
//   （次の段のジョブの ID と種類、READ の確かめなら定義の一覧）と `CHAIN_END`。`FINISHED` は未完了の理由のコード（`incompleteReasonCodes`。コードだけ）を持てる。
//   ログインの状態は通信に載せない（ワーカーのメモリの中だけで段の間に渡す）。
// - 値の一覧（メッセージの種類、理由など）は、ここに `as const` の凍結した配列として 1 回だけ置き、型はその配列から導く。JSON Schema
//   （`schemas/control/worker-message.schema.json`）の enum・const・上限は、この一覧と定数に一致することをテストで固定する
//   （`tests/unit/worker-protocol.test.ts`、`tests/unit/schema-enum-consistency.test.ts`）。
// - 検証の関数（`validateParentToWorkerMessage`、`validateWorkerToParentMessage`）は、受けた値の写しを取り（`structuredClone`。Proxy・関数・
//   Symbol などの写せない値は拒否）、写しの形をスキーマで確かめ、スキーマで書けない規則（ターゲット JSON のパス、Run のディレクトリの
//   相対パス、Run の ID、項目どうしの組み合わせ、文字列の文字と UTF-16 の長さ）を確かめてから、深く凍結した写しを返す。親も子もこれを使う。
//   形の違う値は、すべて拒否する（fail-closed）。受けた側は、その相手を信用しない（親は子を止める。子は止まる）。
// - 写しの一覧: `src/control/` は、`src/cli/`（Playwright を読み込む）と `src/orchestration/` を実行時に読み込めない（Gate
//   `control-boundary.test.ts` の (b)、`local-ui-boundary.test.ts` の (g)）。そのため、結果の種類（`AUDIT_RUN_OUTCOME_KINDS`）、再開の判断
//   （`AUDIT_RUN_RESUME_DECISION_KINDS`）、監査の外の失敗の種類（`CLI_FAILURE_KINDS`）、知らせの種類（`RunNotice`）は、ここに写しを置く。
//   元の一覧との一致は、テスト（`tests/unit/worker-protocol.test.ts`）と、ワーカーの対応表の型（`src/worker/`）で確かめる。
// Node 専用。Playwright と監査エンジン（`src/browser/`、`src/safety/`、`src/orchestration/`）を import しない。
import { isAbsolute } from 'node:path';
import { isPortableRelativeArtifactPath } from '../core/artifact-layout.js';
import type { AuditSendPolicyName } from '../core/audit-send-policy.js';
import {
  INCOMPLETE_REASON_CODES,
  RUN_STATUSES,
  type IncompleteReasonCode,
  type JobSafetyViolation,
  type RunAuthenticationSummary,
  type RunId,
  type RunProgressReport,
  type RunStatus,
} from '../core/contracts.js';
import { MAX_SESSION_LOSS_PATH_LENGTH, type SessionLossEvidence } from '../core/evidence-types.js';
import { isRunId, isSha256Fingerprint, sha256HexOfBytes, sha256HexOfText } from '../core/ids.js';
import { deepFreeze } from '../core/immutable.js';
import { jsonPointerOf } from '../core/json-pointer.js';
import { isJsonValueConvertible } from '../core/json-value.js';
import { MAX_URL_LENGTH } from '../core/limits.js';
import { isSecretUrlQueryParameterName } from '../core/secret-query-names.js';
import { hasValueLikePathSegment } from '../core/url-path-redaction.js';
import { sortedKeysJsonOf } from '../core/sorted-keys-json.js';
import { hasControlOrLineSeparator, hasLoneSurrogate, replaceControlOrLineSeparators, truncateWellFormed } from '../core/text.js';
import { isCompactUtcTimestamp } from '../core/utc-timestamp.js';
import { canonicalHttpOriginOf, isOriginInAllowedOrigins } from '../crawl/normalize-url.js';
import { isMethodOverrideFieldName, type CandidateField, type CandidateFieldType, type CandidateLocation } from '../discovery/candidate-contracts.js';
import { PATH_TEMPLATE_ID_SEGMENT, concretePathOfTemplate } from '../discovery/fingerprint.js';
import {
  MAX_READ_CHECKS_PER_JOB,
  hasGeneratedValueExpectation,
  isReadCheckPageTemplatePath,
  isSendableField,
  type ReadCheckDefinition,
} from '../discovery/read-check-contracts.js';
import {
  isLoginObservedQueryName,
  isLoginObservedQueryValue,
  isLoginObservedStorageKeyShape,
  isLoginObservedSuccessSelector,
  type LoginObservedStorageKeyShape,
  type LoginObservedQuery,
  type LoginObservedSuccessSelector,
} from '../discovery/login-observation.js';
import {
  ACTION_BLOCK_REASONS,
  SUBMISSION_STATES,
  type ActionBlockReason,
  type ApprovalSummaryFacts,
  type SubmissionState,
} from './actions/action-contracts.js';
import type {
  ScenarioApiSpec,
  ScenarioRecordIdSpec,
  ScenarioRequestShape,
  ScenarioResultCondition,
} from './approval/scenario-contracts.js';
import { API_SCENARIO_TRANSPORT } from '../core/scenario-transport.js';
// CC-106（PRE42-CC の組 2）: UPDATE のシナリオの種類（T32d。承認の要約の種類と、書き込みの指定の UPDATE の指定の有無を照らす）。シナリオの契約は
// IPC の契約を読む（ID の形）ので、循環しないように core の owner から読む。
import { UPDATE_SCENARIO_KIND } from '../core/scenario-kind.js';
// PRE42-CC 組 UI-K（N4-8f）: ジョブの種類の一覧と名前つきの定数の定義（画面のブラウザ側も読む純粋なファイル）。ここは公開し直す。
import {
  WORKER_AUDIT_JOB_KIND,
  WORKER_DISCOVERY_JOB_KIND,
  WORKER_ENTRY_CHECK_JOB_KIND,
  WORKER_JOB_KINDS,
  WORKER_LOGIN_CHECK_JOB_KIND,
  WORKER_READ_CHECK_JOB_KIND,
  WORKER_WRITE_CREATE_JOB_KIND,
  WORKER_WRITE_UPDATE_JOB_KIND,
  type WorkerJobKind,
} from '../core/audit-job-values.js';
// PRE42-CC 組 UI-K2（CC-113）: 認証の状態の一覧の定義（画面のブラウザ側も読む純粋なファイル）。ここは公開し直す。
import { WORKER_AUTH_STATES, WORKER_AWAITING_LOGIN_STATE, type WorkerAuthState } from '../core/worker-auth-states.js';
import type { AuthSetup } from './auth/auth-setup-contracts.js';
import {
  LOGIN_STATE_NAME_OUTCOMES,
  MAX_LOGIN_STATE_NAME_DOMAIN_LENGTH,
  MAX_LOGIN_STATE_NAME_PATH_LENGTH,
  type LoginStateNameRecord,
} from './auth/authenticated-state.js';
import type { SeedRecord } from './data-rules/scenario-data.js';
import {
  AUTOMATED_LOGIN_FAILURE_RESULTS,
  AUTOMATED_LOGIN_RATE_LIMITED_RESULT,
  AUTOMATED_LOGIN_SUBMISSION_SENT,
  AUTOMATED_LOGIN_SUCCEEDED,
  type AutomatedLoginResult,
  type AutomatedLoginSubmission,
} from './auth/automated-login-results.js';
import { MAX_APPROVED_SERVICE_ORIGINS, MIN_PROFILE_REVISION } from './contracts.js';
import { validateControlDocument } from './control-schema-validator.js';
import { ENTRY_CHECK_END_REASONS, ENTRY_CHECK_FIELDS, isAcceptedEntrySelector, type EntryCheckField, type EntryCheckSummary } from './entry-check.js';
import { isAcceptedTargetConfigPath } from './profile-policy.js';

// ---------------------------------------------------------------------------------------------------------------
// 値の一覧と上限
// ---------------------------------------------------------------------------------------------------------------

/** IPC のメッセージの版。スキーマの `$defs/protocol` の const と一致する。 */
export const WORKER_PROTOCOL_VERSION = 'beaksight-worker-message/2';

/** 親（画面のサーバ）から子（ワーカー）へのメッセージの種類。 */
// ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.2）: `LOGIN_CONFIRMED`（利用者が「ログインを終えた」を押した）。
// FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の次の段（`NEXT_STAGE`）と、次の段を始めない（`CHAIN_END`）。
export const PARENT_TO_WORKER_MESSAGE_TYPES = Object.freeze([
  'START', 'STOP', 'WRITE_RECHECK_RESULT', 'LOGIN_CONFIRMED', 'NEXT_STAGE', 'CHAIN_END',
] as const);
export type ParentToWorkerMessageType = (typeof PARENT_TO_WORKER_MESSAGE_TYPES)[number];

/** 子（ワーカー）から親（画面のサーバ）へのメッセージの種類。 */
export const WORKER_TO_PARENT_MESSAGE_TYPES = Object.freeze([
  'READY',
  'RUN_STARTED',
  'PROGRESS',
  'NOTICE',
  'AUTH_STATE',
  'HEARTBEAT',
  // DEF-143: 「Run の終わり」の段（集計・成果物の書き出し・止めたときの片付け）に入る知らせ。親は、その段の間だけ途絶えの上限を延ばす。
  'RUN_FINALIZING',
  'FINISHED',
  'FAILED',
  // T30e: 書き込みのジョブの、送る直前の確かめ直しの依頼と、送信の報告。
  'WRITE_RECHECK_REQUEST',
  'WRITE_SUBMISSION',
] as const);
export type WorkerToParentMessageType = (typeof WORKER_TO_PARENT_MESSAGE_TYPES)[number];

/** メッセージの種類のすべて（親 → 子、子 → 親の順。スキーマの最上位の `oneOf` の順）。 */
export const WORKER_MESSAGE_TYPES = Object.freeze([...PARENT_TO_WORKER_MESSAGE_TYPES, ...WORKER_TO_PARENT_MESSAGE_TYPES] as const);
export type WorkerMessageType = (typeof WORKER_MESSAGE_TYPES)[number];

/** 再開の判断の種類（`AUDIT_RUN_RESUME_DECISION_KINDS`、`src/cli/audit-run.ts` の写し）。 */
export const WORKER_RESUME_DECISION_KINDS = Object.freeze(['NEW_RUN', 'RESUME', 'FINALIZE_ONLY'] as const);
export type WorkerResumeDecisionKind = (typeof WORKER_RESUME_DECISION_KINDS)[number];

/** 実行中の知らせの種類（`RunNotice`、`src/orchestration/run-coordinator.ts` の写し）。スキーマの `notice` の分岐の const の順。 */
export const WORKER_NOTICE_KINDS = Object.freeze(['SITE_UNAVAILABLE_RECHECK', 'SITE_UNAVAILABLE_SLOWDOWN', 'SERVICE_REQUEST_PACING_WAIT'] as const);
export type WorkerNoticeKind = (typeof WORKER_NOTICE_KINDS)[number];

/**
 * ジョブの種類（Task 26 の設計書 4.5。T26c で `src/control/job/job-records.ts` に作り、T26d-2 で、ワーカーからも読めるここへ移した。
 * `AUDIT_JOB_KINDS` は、この一覧そのもの）。
 * - `AUDIT`: 監査（公開の監査、手動のログインの後の監査、自動ログインの後の監査）。
 * - `LOGIN_CHECK`: ログインの検証（自動ログインの段だけを行い、結果を送って終わる。Run を作らない。成果物を書かない）。
 * - `DISCOVERY`: 操作の候補の発見（Task 27 の設計書 3 章、4.6。T27c で足した。ワーカーの対応は T27d）。
 * - `READ_CHECK`: READ の確かめ（Task 27 の設計書 3 章、4.5、4.6。T27c で足した。ワーカーの対応は T27e）。
 * - `WRITE_CREATE`: 承認された CREATE の書き込み（Task 30 の設計書 3 章の「記録」。T30d で足した。始める口・IPC の中身・ワーカーの対応は
 *   T30e・T30f。それまでは、ワーカーが `JOB_KIND_NOT_SUPPORTED` で拒む）。
 * - `WRITE_UPDATE`: 承認された UPDATE の書き込み（Task 31 の設計書 3 章の「記録」。T31e で足した。始める口・IPC の中身・ワーカーの対応は
 *   T31f・T31g。それまでは、ワーカーが `JOB_KIND_NOT_SUPPORTED` で拒む）。
 * - `ENTRY_CHECK`: 入口の確かめ（Task 43 の設計書 4.3。T43c）。ログインの状態を持たない読み取りだけの Context で開始の URL を 1 回読み、ログインの
 *   画面の案を作る。`START` は認証の指定を持たない。
 * 値は後ろに足すだけにする（管理データの公開済みの版の CHECK は、公開した時点の写しで固定している。`migrations.ts`）。ワーカーがまだ対応して
 * いない種類の `START` は、ワーカーが `FAILED`（`JOB_KIND_NOT_SUPPORTED`）で拒む（監査として扱わない。T27c）。
 * PRE42-CC 組 UI-K（N4-8f）: 一覧と名前つきの定数（`WORKER_*_JOB_KIND`。監査、ログインの検証、発見、READ の確かめ、登録と更新の書き込み、入口の
 * 確かめ）の定義は、画面のブラウザ側からも読める純粋なファイル `src/core/audit-job-values.ts` に移し、ここは同じ名前で公開し直す（定義は 1 か所）。
 */
export {
  WORKER_AUDIT_JOB_KIND,
  WORKER_DISCOVERY_JOB_KIND,
  WORKER_ENTRY_CHECK_JOB_KIND,
  WORKER_JOB_KINDS,
  WORKER_LOGIN_CHECK_JOB_KIND,
  WORKER_READ_CHECK_JOB_KIND,
  WORKER_WRITE_CREATE_JOB_KIND,
  WORKER_WRITE_UPDATE_JOB_KIND,
  type WorkerJobKind,
};

/**
 * FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の段の種類（閉じた一覧）。
 */
export const WORKER_CHAIN_STAGE_KINDS = Object.freeze(['AUDIT', 'DISCOVERY', 'READ_CHECK'] as const satisfies readonly WorkerJobKind[]);
export type WorkerChainStageKind = (typeof WORKER_CHAIN_STAGE_KINDS)[number];

/**
 * FM2d: まとめて実行の段の並び（閉じた一覧）。`TEST_AUTH_PASSIVE` は監査 → 発見 → READ の確かめ、`TEST_APPROVED_WRITE` は発見 → READ の確かめ（監査は
 * 書き込みのモードで動かない）。モードとの対応は、ジョブの管理の決まり（`src/control/job/stage-chain-policy.ts`）が持つ。
 */
export const WORKER_CHAIN_STAGE_SEQUENCES = Object.freeze([
  Object.freeze(['AUDIT', 'DISCOVERY', 'READ_CHECK'] as const),
  Object.freeze(['DISCOVERY', 'READ_CHECK'] as const),
] as const);
export type WorkerChainStageSequence = (typeof WORKER_CHAIN_STAGE_SEQUENCES)[number];

/** FM2d: `FINISHED` の未完了の理由のコード（core の `INCOMPLETE_REASON_CODES` そのもの。スキーマの enum との対応のため、この名前でも公開する）。 */
export const WORKER_INCOMPLETE_REASON_CODES = INCOMPLETE_REASON_CODES;

/** FM2d: 次の段になれる種類（最初の段にだけなる監査を除く）。 */
export const WORKER_NEXT_STAGE_JOB_KINDS = Object.freeze(['DISCOVERY', 'READ_CHECK'] as const satisfies readonly WorkerChainStageKind[]);
export type WorkerNextStageJobKind = (typeof WORKER_NEXT_STAGE_JOB_KINDS)[number];

/**
 * FM2d: まとめて実行のワーカーが、途中の段の `FINISHED` を送ってから、親の `NEXT_STAGE` か `CHAIN_END` を待つ上限（ms）。過ぎたら、次の段を始めずに、
 * その段の終了コードで終える。親の判定は、成果物の読み直しと管理データの読み書きだけなので、この時間より十分に短い。
 */
export const WORKER_NEXT_STAGE_TIMEOUT_MS = 60_000;

/** 入口の確かめの件数の要約の終わり方（`src/control/entry-check.ts` の一覧そのもの。スキーマの enum との対応のため、この名前でも公開する）。 */
export const WORKER_ENTRY_CHECK_END_REASONS = ENTRY_CHECK_END_REASONS;

/** 書き込みの指定（`write`）を持つジョブの種類（T31f。CREATE と UPDATE。凍結）。 */
export const WORKER_WRITE_JOB_KINDS = Object.freeze([WORKER_WRITE_CREATE_JOB_KIND, WORKER_WRITE_UPDATE_JOB_KIND] as const);
export type WorkerWriteJobKind = (typeof WORKER_WRITE_JOB_KINDS)[number];

/** 書き込みの指定を持つジョブの種類か（T31f）。 */
export const isWorkerWriteJobKind = (jobKind: string): jobKind is WorkerWriteJobKind => (WORKER_WRITE_JOB_KINDS as readonly string[]).includes(jobKind);

/**
 * 送る直前の確かめ直しを、親が拒む理由（T30e。閉じた一覧）。
 * - `GRANT_INVALID`: 実行の許可の確かめ直し（`assertGrantStillValid`）が通らない（撤回、期限切れの承認、事実の変化など）。
 * - `FACTS_UNAVAILABLE`: 承認を縛る管理データの外の事実（`approvalExternalFactsOf`）を求められない。
 * - `RECHECK_REPEATED`: 1 つのジョブで 2 回目の依頼（1 回だけ）。
 * 拒むときは、親は `STOP` も送る。
 */
export const WORKER_WRITE_RECHECK_REJECTION_REASONS = Object.freeze(['GRANT_INVALID', 'FACTS_UNAVAILABLE', 'RECHECK_REPEATED'] as const);
export type WorkerWriteRecheckRejectionReason = (typeof WORKER_WRITE_RECHECK_REJECTION_REASONS)[number];

/** 送信の状態（`WRITE_SUBMISSION`。`src/control/actions/action-contracts.ts` の `SUBMISSION_STATES` そのもの。スキーマの enum との対応のため、この名前でも公開する）。 */
export const WORKER_WRITE_SUBMISSION_STATES = SUBMISSION_STATES;

/** 送らずに止めた理由（`WRITE_SUBMISSION`。`ACTION_BLOCK_REASONS` そのもの）。 */
export const WORKER_WRITE_BLOCK_REASONS = ACTION_BLOCK_REASONS;

/**
 * ワーカーが、送る直前の確かめ直しの結果（`WRITE_RECHECK_RESULT`）を待つ上限（ms。T30e）。過ぎたら、ワーカーは送らない（`NOT_SENT`）。親の
 * 確かめ直しは、管理データの読み出しとターゲット設定のファイルの読み直しだけなので、この時間より十分に短い。
 */
export const WORKER_WRITE_RECHECK_TIMEOUT_MS = 10_000;

/** 書き込みの指定の、送る値の数の上限（1 つの候補の欄の数の上限と同じ値。スキーマの maxProperties と一致する）。 */
export const MAX_WORKER_WRITE_VALUES = 200;

/** 書き込みの指定の、候補の欄の数の上限（1 つの候補の欄の数の上限と同じ値。スキーマの maxItems と一致する）。 */
export const MAX_WORKER_WRITE_CANDIDATE_FIELDS = 200;

/** `START` の定義の一覧の最大の件数（1 回のジョブの READ の数の上限。スキーマの maxItems と一致する。T27e）。 */
export const MAX_WORKER_READ_CHECKS = MAX_READ_CHECKS_PER_JOB;

/**
 * ワーカーがまだ対応していない種類の `START` を拒む理由（T27c。Task 27 の設計書の変更履歴「Blocker: T27c」の行の (2)）。設定を読まず、
 * ログインも監査もせずに、`FAILED` で送って終える（fail-closed）。
 */
export const WORKER_JOB_KIND_NOT_SUPPORTED_REASON = 'JOB_KIND_NOT_SUPPORTED';

/**
 * フォームの確かめが通らない理由のコード（入力の部品 `src/browser/login-form-submitter.ts` の `LOGIN_FORM_INVALID_REASONS` の写し。
 * `src/control/` は `src/browser/` を読み込めない（Gate `control-boundary.test.ts` の (b)）。元の一覧との一致は
 * `tests/unit/worker-protocol-automated-login.test.ts` と、ワーカーの対応の型（`src/worker/audit-worker-session.ts`）で確かめる）。秘密でない。
 */
export const WORKER_LOGIN_FORM_INVALID_REASONS = Object.freeze([
  'SELECTOR_NOT_UNIQUE',
  'USERNAME_FIELD_INVALID',
  'PASSWORD_FIELD_INVALID',
  'SUBMIT_BUTTON_INVALID',
  'NOT_SAME_FORM',
  'METHOD_NOT_POST',
  'ACTION_NOT_ALLOWED',
  'FORM_TARGET_NOT_SELF',
  'FORM_UNREADABLE',
] as const);
export type WorkerLoginFormInvalidReason = (typeof WORKER_LOGIN_FORM_INVALID_REASONS)[number];

/** フォームの確かめの理由のコードを持つ結果（管理データの版 4 の `auto_login_attempts` の CHECK も使う）。 */
export const WORKER_LOGIN_FORM_INVALID_RESULT = 'LOGIN_FORM_INVALID' satisfies AutomatedLoginResult;

/** 資格情報の改訂の番号の最小値（資格情報のファイルの `credentialRevision` は 1 から。プロファイルの改訂と同じ値）。 */
export const MIN_WORKER_CREDENTIAL_REVISION = MIN_PROFILE_REVISION;

/**
 * 認証の状態の知らせ（`AUTH_STATE`）の値（Task 25 の設計書 4.4。T25d）。値と秘密を含まない。
 * - `AWAITING_LOGIN`: ログイン用の Browser でログインの画面を開いた。人がログインするのを待っている。
 * - `AUTHENTICATED`: 成功の条件に当たった。認証済みの状態をメモリに取り出し、ログイン用の Browser を閉じた。
 * - `AUTH_SETUP_REQUIRED`: ログインの段を続けられない（ログイン用の Context が閉じた、Guard の準備の前の移動など。設定を見直す）。
 * - `UNSUPPORTED_AUTH_STATE`: 成功の条件に当たったが、許可 Origin の Cookie も localStorage もなかった（別の Origin や sessionStorage に頼る認証）。
 * - `SESSION_LOST`: 監査の段で、セッションが切れた（Run は `AUTH_SESSION_LOST` で止まる）。止まったページの URL を持つ。
 * - `LOGIN_TIMEOUT`: 名前つきの時間の中に、成功の条件に当たらなかった。
 * - `LOGIN_ATTEMPTS_EXCEEDED`: 送信先への POST が、回数の上限で止められた。
 * - `AUTOMATED_LOGIN_FAILED`（T26d-2）: 自動ログインの段が成功以外で終わった（止める要求で終わった場合を含む）。結果は `automatedLogin`。
 * PRE42-CC 組 UI-K2（CC-113）: 一覧の定義は、画面のブラウザ側からも読める純粋なファイル `src/core/worker-auth-states.ts` に移し、ここは同じ名前で
 * 公開し直す（定義は 1 か所）。
 */
export { WORKER_AUTH_STATES, WORKER_AWAITING_LOGIN_STATE, type WorkerAuthState };

/** 自動ログインの段が成功以外で終わった状態（T26d-2。`automatedLogin` の結果が必ずあり、`SUCCEEDED` でない）。 */
export const WORKER_AUTOMATED_LOGIN_FAILED_STATE = 'AUTOMATED_LOGIN_FAILED' satisfies WorkerAuthState;

/**
 * 自動ログインの結果（`automatedLogin`）を持てる状態（T26d-2）。`AUTHENTICATED` と `UNSUPPORTED_AUTH_STATE` は、成功（`SUCCEEDED`）の結果だけ
 * （`UNSUPPORTED_AUTH_STATE` は、ログインは成功したが、許可 Origin の状態がなかった）。手動のログインでは、どの状態も結果を持たない。
 */
const AUTH_STATES_WITH_AUTOMATED_LOGIN: ReadonlySet<WorkerAuthState> = new Set([
  'AUTHENTICATED',
  'UNSUPPORTED_AUTH_STATE',
  WORKER_AUTOMATED_LOGIN_FAILED_STATE,
]);

/** ログインの段で、監査を始めずに終わる状態（`FAILED` の理由にも、同じ値を使う）。 */
export const WORKER_LOGIN_FAILURE_STATES = Object.freeze([
  'AUTH_SETUP_REQUIRED',
  'UNSUPPORTED_AUTH_STATE',
  'LOGIN_TIMEOUT',
  'LOGIN_ATTEMPTS_EXCEEDED',
] as const satisfies readonly WorkerAuthState[]);
export type WorkerLoginFailureState = (typeof WORKER_LOGIN_FAILURE_STATES)[number];

/** 止まったページの URL を持つ状態（ほかの状態は `sessionLostUrl` が `null`）。 */
export const WORKER_SESSION_LOST_STATE = 'SESSION_LOST' satisfies WorkerAuthState;

/**
 * スクリプトで送るログインの段で止めた、読み取りでない要求の理由（T34c。Task 34 の設計書 3.5。閉じた一覧）。`AUTH_STATE` の `scriptLogin` の
 * `blockedByReason` の鍵。値と順は、要求の判定の `SCRIPT_LOGIN_BLOCK_REASONS`（`src/safety/request-policy.ts`）と同じ（`src/control/` は
 * `src/safety/` を読み込めないので、ここにも置く。一致は `tests/unit/script-login-boundary-consistency.test.ts` で確かめる）。
 */
export const WORKER_SCRIPT_LOGIN_BLOCK_REASONS = Object.freeze([
  'TOKEN_REQUEST_OVER_LIMIT',
  'TOKEN_REQUEST_NOT_SCRIPT',
  'TOKEN_REQUEST_QUERY_MISMATCH',
  'SIDE_REQUEST_OVER_LIMIT',
  'SIDE_REQUEST_NOT_SCRIPT',
  'UNREGISTERED_NON_READ',
  // T36c（Task 36 の設計書 3.3。設計者の判断 1）: 自動ログインで、資格情報を含む要求を止めた数（`WORKER_LOGIN_CREDENTIAL_BLOCK_REASON`）。
  'LOGIN_CREDENTIAL_IN_REQUEST',
] as const);
export type WorkerScriptLoginBlockReason = (typeof WORKER_SCRIPT_LOGIN_BLOCK_REASONS)[number];

/**
 * 自動ログインで、承認した token の送信のほかの要求の URL か本文に資格情報が含まれていたので、Guard が止めた理由（T36c。Guard の側の
 * `LOGIN_CREDENTIAL_BLOCK_REASON` と同じ。一致は `script-login-boundary-consistency.test.ts`）。数（`blockedByReason`）だけを持ち、止めた一覧の行には
 * 載せない（path に値が入りうるため）。T36R-fix（T36R の M-3）: 動いている IPC では、この鍵も必須（スキーマの `required`）。LG-3: 管理データの
 * T36c の前の行（この鍵がない）を 0 として読む読み替えは捨てた（ジョブの記録の読む口 `src/control/job/job-store.ts` でも必須）。
 */
export const WORKER_LOGIN_CREDENTIAL_BLOCK_REASON = 'LOGIN_CREDENTIAL_IN_REQUEST' satisfies WorkerScriptLoginBlockReason;

/**
 * スクリプトで送るログインの段の結果の数（T34c。`AUTH_STATE` の任意の項目 `scriptLogin`。URL・本文・値を持たない）。
 * - `tokenRequestsAllowed`: 通した token の送信の数。
 * - `sideRequestsAllowed`: 通したログインに伴う送信の数（認証の設定の `loginSideRequests` の順に、項目ごと）。
 * - `serviceOriginReads`: 通した、承認したサービスの Origin への読み取りの数。
 * - `blockedByReason`: 止めた読み取りでない要求の数（理由ごと）。
 */
export interface WorkerScriptLoginCounts {
  readonly tokenRequestsAllowed: number;
  readonly sideRequestsAllowed: readonly number[];
  readonly serviceOriginReads: number;
  readonly blockedByReason: Readonly<Record<WorkerScriptLoginBlockReason, number>>;
}

/**
 * 止める印（`STOP`）で終わった手動のログインの段が、数と一覧を付けて送る状態（T34R-fix-a。T34R の I-1）。止めたときの新しい状態は足さず、最後の
 * 状態（ログインを待っていた `AWAITING_LOGIN`）に付けて送る（管理データの `last_auth_state` の閉じた一覧と版を変えない）。親は、止める要求を
 * 送ったジョブのときだけ受ける（`audit-job-manager.ts`）。
 */
export const WORKER_STOPPED_LOGIN_STAGE_STATE = WORKER_AWAITING_LOGIN_STATE;

/**
 * スクリプトで送るログインの段の結果の数（`scriptLogin`）を持てる状態（T34c）: ログインの段の結果（成功と、ログインの段の失敗）。T34R-fix-a: 止める印で
 * 終わったログインの段（`WORKER_STOPPED_LOGIN_STAGE_STATE`）も。
 */
const AUTH_STATES_WITH_SCRIPT_LOGIN: ReadonlySet<WorkerAuthState> = new Set([
  'AUTHENTICATED',
  ...WORKER_LOGIN_FAILURE_STATES,
  WORKER_STOPPED_LOGIN_STAGE_STATE,
]);

/**
 * 数（`scriptLogin`）と止めた一覧（`blockedRequests`）を持てるか（T36c で、スクリプトで送る自動ログインの結果を足した）。手動のログインの段の結果
 * （自動ログインの結果なし）は `AUTH_STATES_WITH_SCRIPT_LOGIN` の状態。自動ログインの段の結果（自動ログインの結果あり）は、自動ログインの結果を持てる
 * 状態（`AUTH_STATES_WITH_AUTOMATED_LOGIN`）。
 */
const mayCarryLoginStageCounts = (state: WorkerAuthState, automatedLogin: WorkerAutomatedLoginReport | undefined): boolean =>
  (automatedLogin === undefined ? AUTH_STATES_WITH_SCRIPT_LOGIN : AUTH_STATES_WITH_AUTOMATED_LOGIN).has(state);

/**
 * ログインの段で止めた読み取りでない要求の理由（T34e。Task 34 の設計書 3.5 と 8 章の T34e の行。閉じた一覧）: スクリプトで送るログインの詳しい理由
 * （`WORKER_SCRIPT_LOGIN_BLOCK_REASONS`）と、フォームの送信のログインの段の `NON_READ_METHOD`。値と順は、Guard の側の
 * `LOGIN_STAGE_BLOCKED_REQUEST_REASONS`（`src/safety/login-stage-blocked-requests.ts`）と同じ（一致は `script-login-boundary-consistency.test.ts`）。
 * T36R-fix（T36R の M-2）: 資格情報を含む要求の理由（`WORKER_LOGIN_CREDENTIAL_BLOCK_REASON`）は数だけで、行の理由には入れない。
 */
export type WorkerLoginStageBlockReason = Exclude<WorkerScriptLoginBlockReason, typeof WORKER_LOGIN_CREDENTIAL_BLOCK_REASON> | 'NON_READ_METHOD';
const isWorkerLoginStageBlockReason = <Reason extends WorkerScriptLoginBlockReason | 'NON_READ_METHOD'>(
  reason: Reason,
): reason is Exclude<Reason, typeof WORKER_LOGIN_CREDENTIAL_BLOCK_REASON> => reason !== WORKER_LOGIN_CREDENTIAL_BLOCK_REASON;
export const WORKER_LOGIN_STAGE_BLOCK_REASONS: readonly WorkerLoginStageBlockReason[] = Object.freeze([
  ...WORKER_SCRIPT_LOGIN_BLOCK_REASONS.filter(isWorkerLoginStageBlockReason),
  'NON_READ_METHOD' as const,
]);

/**
 * 要求の種類（T34e。閉じた一覧）。値と順は、要求の判定の `REQUEST_RESOURCE_TYPES`（`src/safety/request-policy.ts`）と同じ（一致は
 * `script-login-boundary-consistency.test.ts`）。
 */
export const WORKER_REQUEST_RESOURCE_TYPES = Object.freeze([
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'prefetch',
  'eventsource',
  'websocket',
  'manifest',
  'signedexchange',
  'ping',
  'cspviolationreport',
  'preflight',
  'fedcm',
  'other',
] as const);
export type WorkerRequestResourceType = (typeof WORKER_REQUEST_RESOURCE_TYPES)[number];

/** ログインの段で止めた要求の一覧の行の上限（T34e。スキーマの maxItems。Guard の側の `MAX_LOGIN_STAGE_BLOCKED_REQUESTS` と同じ）。 */
export const MAX_WORKER_LOGIN_STAGE_BLOCKED_REQUESTS = 8;

/** 一覧の path の最大長（T34e。スキーマの maxLength。Guard の側の `MAX_LOGIN_STAGE_BLOCKED_PATH_LENGTH` と同じ）。 */
export const MAX_WORKER_LOGIN_STAGE_BLOCKED_PATH_LENGTH = 1_024;

/** ログインの段で止めた読み取りでない要求の一覧の 1 行（T34e。Origin と path と種類と理由と回数だけ。query・本文・値を持たない）。 */
export interface WorkerLoginStageBlockedRequest {
  /** HTTP(S) の Origin の正規の直列化。 */
  readonly origin: string;
  /**
   * `/` で始まる path（query・fragment なし）。値に見える区切りは、伏せた区切り（`src/core/url-path-redaction.ts` の `REDACTED_PATH_SEGMENT`）にしてある
   * （T34e fix round 1。送信先の path は伏せない）。
   */
  readonly path: string;
  readonly resourceType: WorkerRequestResourceType;
  readonly reason: WorkerLoginStageBlockReason;
  /** 止めた回数（1 以上）。 */
  readonly count: number;
  /**
   * T43d（Task 43 の設計書 4.4）: query の名前の一覧（値なし）と、閉じた一覧の名前（`grant_type`）の決まった形の値（任意。query のない行は持たない）。
   * 形と判定の owner は `src/discovery/login-observation.ts`（Guard の側も同じ部品で作る）。
   */
  readonly query?: WorkerLoginObservedQuery;
  /**
   * ML-a-fix（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 6 章の ML-R の行の I-1）: この行を最初に見たのが、ログインの段の最初の token の
   * 送信より前だった（`true` だけ。値を持たない）。手動のログインの段で通した一覧（`passedRequests`）の行だけが持つ。自動の登録が、ログインに伴う送信を見分ける。
   */
  readonly beforeToken?: true;
}

/** T43d: 止めた要求の行の query の記録（`LoginObservedQuery` と同じ形）。 */
export type WorkerLoginObservedQuery = LoginObservedQuery;

/** ログインの段で止めた読み取りでない要求の一覧（T34e。`AUTH_STATE` の任意の項目 `blockedRequests`）と、一覧に入れなかった数。 */
export interface WorkerLoginStageBlockedRequests {
  readonly requests: readonly WorkerLoginStageBlockedRequest[];
  readonly unlisted: number;
}

/**
 * T43d（Task 43 の設計書 4.4）: ログインの段で観察したこと（`AUTH_STATE` の任意の項目 `loginObservation`。止めた一覧と同じ状態だけが持てる。どれかの
 * 項目を持つ）。値・要素の文字・鍵の名前の全体を持たない。
 * - `storageKeys`: ログインの画面の Origin のローカル ストレージの、ログインの段の始めになく終わりにある鍵の名前の、接頭辞と接尾辞の案（T43R-fix の C-1 (a)。
 *   間の部分は持たない。値は読まない）。
 * - `successSelector`: ログインの後の画面の、ログアウトの要素の、ログアウトの語を含む属性から作った CSS の案（T43R-fix の C-1 (b)）。
 * - `credentialDiscarded`: 自動ログインで、入れた資格情報（ユーザー名かパスワード）を含んだので捨てた案の数（T43R-fix の C-1 (c)。1 以上のときだけ）。
 * - `loginFields`: FM2e（手を減らす段 2 の設計書 3A.4）: 手動のログインの段の始めに検出した、ログインの 3 つの欄（ユーザー名・パスワード・送信）の CSS の
 *   案（`WorkerLoginFieldProposals`）。手動のログインの成功（`AUTHENTICATED`。自動ログインの結果なし）だけが持てる。欄の値は持たない。
 */
export interface WorkerLoginObservation {
  readonly storageKeys?: WorkerLoginObservedStorageKeys;
  readonly successSelector?: LoginObservedSuccessSelector;
  readonly credentialDiscarded?: number;
  readonly loginFields?: WorkerLoginFieldProposals;
}

/**
 * FM2e: ログインの 3 つの欄の CSS の案（各欄の見える候補がちょうど 1 つのときだけ、その一意な CSS。ほかは `null`。どれかは案がある）。検出は入口の確かめと
 * 同じ部品（`src/worker/entry-check-page.ts` の `readLoginFormFields`）。CSS は認証の設定として受ける形（`isAcceptedEntrySelector`）で、互いに違う。
 * 親は画面の案にだけ使い、認証の設定には保存しない（ジョブの行のログインの段のまとめに残る）。
 */
export type WorkerLoginFieldProposals = Readonly<Record<EntryCheckField, string | null>>;

/**
 * DEF-139（設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 2.1）: ログインの後のブラウザの状態の名前の記録（`AUTH_STATE` の任意の項目
 * `loginStateNames`。止めた一覧と同じ状態だけが持てる）。形と組み立ての owner は `src/control/auth/authenticated-state.ts`（`authenticatedStateNameRecordOf`）。
 * 値・中身・名前の全体を持たない。
 */
export type WorkerLoginStateNames = LoginStateNameRecord;

/** DEF-139: 状態の名前の記録の結果の値の一覧（スキーマの enum。owner の `LOGIN_STATE_NAME_OUTCOMES` そのもの）。 */
export const WORKER_LOGIN_STATE_NAME_OUTCOMES = LOGIN_STATE_NAME_OUTCOMES;

/** T43d・T43R-fix の C-1 (a): 成功の鍵の名前の案（Origin と、接頭辞と接尾辞の組（並べてある）と、案にしなかった新しい名前の数）。 */
export interface WorkerLoginObservedStorageKeys {
  readonly origin: string;
  readonly shapes: readonly LoginObservedStorageKeyShape[];
  readonly omitted: number;
}

/** 監査の中核の結果の種類（`AUDIT_RUN_OUTCOME_KINDS`、`src/cli/audit-run.ts` の写し）。 */
export const WORKER_OUTCOME_KINDS = Object.freeze([
  'RAN',
  'RUN_ACTIVE',
  'VERSION_MISMATCH',
  'RUN_DIRECTORY_UNAVAILABLE',
  'RESUME_UNAVAILABLE',
] as const);
export type WorkerOutcomeKind = (typeof WORKER_OUTCOME_KINDS)[number];

/** 結果の Run Status の一覧（core の `RUN_STATUSES` そのもの。スキーマの enum との対応のために、この名前でも公開する）。 */
export const WORKER_RUN_STATUSES = RUN_STATUSES;

/**
 * `FAILED` の理由の閉じた一覧。
 * - `CONFIG_ERROR`、`ARTIFACT_WRITE_FAILED`、`UNEXPECTED_FAILURE`: 監査の外の失敗の種類（`CLI_FAILURE_KINDS`、`src/cli/failure.ts` の写し。
 *   `classifyCliFailure` で分ける）。
 * - `PROTOCOL_VIOLATION`: 形の違うメッセージを受けた、順の違うメッセージを受けた（2 回目の `START` など）、または自分が形の違うメッセージを
 *   作った。
 * - `START_TIMEOUT`: 名前つきの時間（`WORKER_START_TIMEOUT_MS`）の中に `START` が来なかった。
 * - `CONFIG_CHANGED`: 読んだターゲット JSON の SHA-256 が、`START` の `targetConfigSha256`（親が開始の直前の検証で読んだもの）と違ったので、
 *   監査を始めなかった（T24h-1 の M3。設定の読み直しの TOCTOU）。
 * - `AUTH_SETUP_CHANGED`: `START` の認証の設定の文書と `approvedTestOrigins` から求めた SHA-256 が、`START` の値と違ったので、ログインも
 *   監査も始めなかった（T25d。M3 と同じ考え）。
 * - `AUTH_SETUP_REQUIRED`・`UNSUPPORTED_AUTH_STATE`・`LOGIN_TIMEOUT`・`LOGIN_ATTEMPTS_EXCEEDED`: ログインの段で終わった
 *   （`WORKER_LOGIN_FAILURE_STATES`。同じ値の `AUTH_STATE` を先に送る）。
 * - 自動ログインの成功以外の結果（`AUTOMATED_LOGIN_FAILURE_RESULTS`。T26d-2）: 自動ログインの段で終わった（同じ結果の `AUTH_STATE`
 *   （`AUTOMATED_LOGIN_FAILED`）を先に送る）。
 * - `JOB_KIND_NOT_SUPPORTED`（`WORKER_JOB_KIND_NOT_SUPPORTED_REASON`。T27c）: ワーカーがまだ対応していない種類の `START` を受けたので、設定を
 *   読まず、ログインも監査もしなかった。
 */
export const WORKER_FAILURE_REASONS = Object.freeze([
  'CONFIG_ERROR',
  'ARTIFACT_WRITE_FAILED',
  'UNEXPECTED_FAILURE',
  'PROTOCOL_VIOLATION',
  'START_TIMEOUT',
  'CONFIG_CHANGED',
  'AUTH_SETUP_CHANGED',
  ...WORKER_LOGIN_FAILURE_STATES,
  ...AUTOMATED_LOGIN_FAILURE_RESULTS,
  WORKER_JOB_KIND_NOT_SUPPORTED_REASON,
] as const);
export type WorkerFailureReason = (typeof WORKER_FAILURE_REASONS)[number];

/** ジョブの ID の形（小文字の英数字とハイフン、先頭は英数字、全体で 1〜64 文字）。スキーマの pattern と一致する。 */
export const WORKER_JOB_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** ターゲット JSON の SHA-256 の形（小文字の 16 進の 64 文字）。スキーマの pattern と一致する（T24h-1 の M3）。 */
export const TARGET_CONFIG_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * ターゲット JSON の内容の SHA-256（`TARGET_CONFIG_SHA256_PATTERN` の形）。親とワーカーが、同じこの関数で求める（T24h-1 の M3）。
 * SHA-256 の計算は、core の owner（`src/core/ids.ts` の `sha256HexOfBytes`）に任せる（CC-059。CCX-11）。
 */
export const targetConfigDigestOf = (bytes: Uint8Array): string => sha256HexOfBytes(bytes);

/** 認証の設定の SHA-256 の形（ターゲット JSON の SHA-256 と同じ。小文字の 16 進の 64 文字）。スキーマの pattern と一致する（T25d）。 */
export const WORKER_AUTHENTICATION_SHA256_PATTERN = TARGET_CONFIG_SHA256_PATTERN;

/** `START` の `approvedTestOrigins` の最大の件数（スキーマの maxItems。T25d）。 */
export const MAX_WORKER_APPROVED_TEST_ORIGINS = 100;

/** `START` の `approvedServiceOrigins` の最大の件数（スキーマの maxItems。プロファイルの上限と同じ。T34a）。 */
export const MAX_WORKER_APPROVED_SERVICE_ORIGINS = MAX_APPROVED_SERVICE_ORIGINS;

// 鍵を並べた JSON（同じ内容の文書から、同じ JSON の文字列を作る）は、`src/core/sorted-keys-json.ts` の `sortedKeysJsonOf` に移した（CC-078。CCX-12）。

/**
 * `START` の SHA-256 に含める、認証の設定の外の項目（T26d-2）: ジョブの種類と、自動ログインの指定（手動のログインでは `null`）。
 */
export interface WorkerAuthenticationBinding {
  readonly jobKind: WorkerJobKind;
  readonly automatedLogin: WorkerStartAutomatedLogin | null;
  /**
   * プロファイルの承認したサービスの Origin（T34c。`START` の `authentication.approvedServiceOrigins`）。1 つ以上あるときだけ SHA-256 に入れる
   * （省略と空は入れない。版 2 の設定と、サービスの Origin のないプロファイルの値は変わらない）。
   */
  readonly approvedServiceOrigins?: readonly string[] | undefined;
}

/**
 * 認証の設定の文書と `approvedTestOrigins` と、ジョブの種類と自動ログインの指定（T26d-2）の SHA-256（`WORKER_AUTHENTICATION_SHA256_PATTERN`
 * の形。T25d）。鍵を並べ替えた JSON の UTF-8 から求める。親（開始の直前に検証した値）とワーカー（`START` で受けた値）が、同じこの関数で求めて
 * 比べる。
 */
export const workerAuthenticationDigestOf = (
  setup: AuthSetup,
  approvedTestOrigins: readonly string[],
  binding: WorkerAuthenticationBinding,
): string =>
  sha256HexOfText(sortedKeysJsonOf({
    setup,
    approvedTestOrigins,
    jobKind: binding.jobKind,
    automatedLogin: binding.automatedLogin,
    ...(binding.approvedServiceOrigins === undefined || binding.approvedServiceOrigins.length === 0
      ? {}
      : { approvedServiceOrigins: binding.approvedServiceOrigins }),
  }));

/** `START` の `profileName` の最大長（UTF-16 のコード単位。PRE42-BN）。スキーマの maxLength と一致する。 */
export const MAX_WORKER_PROFILE_NAME_LENGTH = 256;

/** メッセージの中のパス（ターゲット JSON の相対パス、出力先の中の Run のディレクトリの相対パス）の最大長。スキーマの maxLength と一致する。 */
export const MAX_WORKER_MESSAGE_PATH_LENGTH = 1_024;

/** `FAILED` の詳細（利用者に見せない英語の短い文）の最大長（UTF-16 のコード単位）。スキーマの maxLength と一致する。 */
export const MAX_WORKER_FAILURE_DETAIL_LENGTH = 1_024;

/** 知らせの URL の最大長（UTF-16 のコード単位。記録する URL の上限 `MAX_URL_LENGTH` と同じ）。スキーマの maxLength と一致する。 */
export const MAX_WORKER_NOTICE_URL_LENGTH = MAX_URL_LENGTH;

/** 終了コードの最大（プロセスの終了コードとして渡せる最大）。スキーマの maximum と一致する。 */
export const MAX_WORKER_EXIT_CODE = 255;

/** ワーカーが `READY` を送ってから、`START` を待つ時間（ms）。過ぎたら、ワーカーは `FAILED`（`START_TIMEOUT`）を送って終わる。 */
export const WORKER_START_TIMEOUT_MS = 10_000;

/**
 * ワーカーが生きている合図（`HEARTBEAT`）を送る間隔（ms）。親の見張りの時間（Task 24 の設計書 4.4。T24e）は、この間隔より十分に長くする。
 */
export const WORKER_HEARTBEAT_INTERVAL_MS = 2_000;

// ---------------------------------------------------------------------------------------------------------------
// メッセージの型
// ---------------------------------------------------------------------------------------------------------------

interface WorkerMessageBase<Type extends WorkerMessageType> {
  readonly protocol: typeof WORKER_PROTOCOL_VERSION;
  readonly type: Type;
}

/** 監査を始める（親 → 子）。 */
export interface WorkerStartMessage extends WorkerMessageBase<'START'> {
  /** `WORKER_JOB_ID_PATTERN` の形。 */
  readonly jobId: string;
  /** ジョブの種類（T26d-2。既定の値はない。`LOGIN_CHECK` は、自動ログインの `authentication` を必ず持つ）。 */
  readonly jobKind: WorkerJobKind;
  /** ターゲット JSON のリポジトリの root からの相対パス（`isAcceptedTargetConfigPath` を通るもの）。 */
  readonly targetConfigPath: string;
  /** 新しく始める（CLI の `--new` に当たる）。 */
  readonly startNew: boolean;
  /**
   * 親が開始の直前の検証で読んだターゲット JSON の SHA-256（`targetConfigDigestOf`。小文字の 16 進の 64 文字）。ワーカーは、読んだファイルの
   * SHA-256 がこれと違えば、監査を始めずに `FAILED`（`CONFIG_CHANGED`）を送る（T24h-1 の M3）。
   */
  readonly targetConfigSha256: string;
  /**
   * 認証の設定を使うプロファイル（`TEST_AUTH_PASSIVE`。T28b から、発見・READ の確かめ・ログインの確かめでは `TEST_APPROVED_WRITE` も）のときだけ。
   * 省略は公開の監査（T25d）。
   */
  readonly authentication?: WorkerStartAuthentication;
  /** READ の確かめの定義の一覧（`READ_CHECK` のときだけ、必ず持つ。1〜`MAX_WORKER_READ_CHECKS` 件。T27e）。 */
  readonly readChecks?: readonly WorkerStartReadCheck[];
  /**
   * 書き込みの指定（`WRITE_CREATE` と、T31f から `WRITE_UPDATE` のときだけ、必ず持つ。T30e）。T40a: 送り方 API の登録の書き込みの指定
   * （`WorkerStartApiWrite`。`WRITE_CREATE` だけ）も受ける。
   */
  readonly write?: WorkerStartWrite | WorkerStartApiWrite;
  /**
   * FM-2（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 2.2）: ジョブのブラウザを表示（headed）で起動するか（親が、ジョブの開始のときにプロファイルの
   * 表示の設定を読んで入れる）。監査・発見・READ の確かめ・書き込みのジョブ（`WORKER_JOB_KINDS_WITH_JOB_BROWSER`）だけが持てる。省略は表示しない。
   */
  readonly showJobBrowser?: boolean;
  /**
   * AS-b（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.1）: 監査の段の送信の扱い（親が、ジョブの開始のときにプロファイルの設定を読んで入れる）。
   * 監査・発見・READ の確かめのジョブ（`WORKER_JOB_KINDS_WITH_AUDIT_SEND_POLICY`）だけが持てる。ワーカーは、実効の設定の上書き（`audit.sendPolicy`）として当てる。
   * 省略は読み取りだけ（ワーカーはターゲット JSON の値によらず `READ_ONLY` で読む）。
   */
  readonly auditSendPolicy?: AuditSendPolicyName;
  /**
   * PRE42-BN（2026-10-24 のユーザーの判断）: プロファイルの名前（親が、ジョブの開始のときに入れる。1〜`MAX_WORKER_PROFILE_NAME_LENGTH` 文字）。ChatGPT 用
   * バンドルのファイル名だけに使う（名前の部分は `src/core/artifact-layout.ts` の `bundleFileNameLabelOf` が作る。成果物の中身には入れない）。監査のジョブ
   * （`WORKER_AUDIT_JOB_KIND`）だけが持てる。省略は名前の部分のない名前。
   */
  readonly profileName?: string;
  /**
   * FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の段の並び（`WORKER_CHAIN_STAGE_SEQUENCES` のどれか。最初の段は
   * `jobKind`）。認証つきの `START` だけ。ワーカーは、ログイン 1 回の後に、途中の段の `FINISHED` の後で親の `NEXT_STAGE`・`CHAIN_END` を待つ。省略は今のまま
   * （1 つのジョブで終える）。
   */
  readonly chain?: WorkerStartChain;
}

/** FM2d: まとめて実行の段の並び（`START` の `chain`）。 */
export interface WorkerStartChain {
  readonly stages: WorkerChainStageSequence;
}

/**
 * AS-b: 監査の段の送信の扱いを持てるジョブの種類（Passive Context で監査の段の読み込みをする種類。書き込みの段とログインの段には口を渡さないので、書き込み・
 * ログインの確かめ・入口の確かめは持たない）。
 */
export const WORKER_JOB_KINDS_WITH_AUDIT_SEND_POLICY: readonly WorkerJobKind[] = Object.freeze([
  'AUDIT',
  'DISCOVERY',
  'READ_CHECK',
] satisfies WorkerJobKind[]);

/** FM-2: ジョブのブラウザの表示の設定を持てるジョブの種類（Run の Browser を起動する種類。ログインの確かめと入口の確かめは持たない）。 */
export const WORKER_JOB_KINDS_WITH_JOB_BROWSER: readonly WorkerJobKind[] = Object.freeze([
  'AUDIT',
  'DISCOVERY',
  'READ_CHECK',
  'WRITE_CREATE',
  'WRITE_UPDATE',
] satisfies WorkerJobKind[]);

/** 書き込みの指定の候補の欄 1 件（名前・型・状態だけ。値と選択肢は持たない。T30e）。 */
export type WorkerStartWriteField = Pick<CandidateField, 'name' | 'readonly' | 'hidden' | 'disabled'> & { readonly type: CandidateFieldType };

/**
 * 書き込みの指定（`START` の `write`。T30e）。親が、実行の許可を消費し、値を生成して送る前の記録を書いてから入れる（ワーカーは管理データを読まない）。
 * - `scenarioId`・`scenarioRevision`・`grantId`: シナリオと版と、消費した許可。
 * - `profileId`・`seedRecord`（T30f。設計書 11 章の Blocker 1 の案 A）: プロファイルと、生成の seed の記録（親が送る前の記録に書いたものと同じ値。
 *   秘密を含まない）。ワーカーは管理データを読まないので、`action-run.json` に書くために受ける。seed の入力のプロファイル・シナリオ・版・許可は、
 *   この指定の値と同じ（契約で確かめる）。
 * - `request`: 承認した候補の要求の形（form の method、`_method` の上書き、Origin、path、enctype。enctype は urlencoded か multipart だけ）。
 * - `formPage`: 書き込みの画面（候補を見た画面の Origin と path）。`candidate`: 承認に縛った候補の識別と規則の digest（画面の確かめに使う）。
 * - `candidateFields`: 承認した候補の欄（名前・型・readonly・hidden・disabled。照合の名前の一覧を作るのに使う。値は持たない）。
 * - `values`: 送る欄の生成した値（欄の名前 → 値。null は、その欄を選ばない・送らない）。送れる欄だけ（hidden・readonly・disabled・password・
 *   file・`_method` でない）。
 * - `verification`: 結果の判定の 2 つの条件と、登録の ID の取り方（どれも指定済み）。
 * - `readVerification`: 照合の READ（READ の定義の id と版、対象の画面、生成した値を結び付けた送る値と、生成した値で作った期待）。
 * - `update`（T31f。Task 31 の設計書 4 章の「IPC」）: UPDATE の指定。`WRITE_UPDATE` で必ず持ち、ほかの種類では持てない。UPDATE では、`formPage` の
 *   path と `request` の path は、親がシナリオの path の型に対象の ID を入れた具体的な path（ワーカーは型を扱わない）。`values` は変える欄の新しい
 *   値だけ（照合の READ に結び付ける値も新しい値）。保つ欄の値と前の値は持たない（ワーカーが画面から読む）。
 * - `approvalFacts`（T32d。Task 32 の設計書 4.1 の「承認の要約の受け渡し」）: 書き込みの報告の承認の要約の事実（`ApprovalSummaryFacts`）。親が
 *   実行の許可を消費した直後に読んだ開始の時点の値（`approvalSummaryFactsOf`）。ワーカーは照らさずに `approval-summary.json` に書き写す（承認の
 *   判断は親のまま）。秘密を持たない。形は成果物のスキーマの `$defs/facts`（`$ref`）。契約は、プロファイル・シナリオ・版・許可・種類が、この
 *   書き込みの指定と同じことを確かめる。
 */
export interface WorkerStartWrite {
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  readonly grantId: string;
  readonly profileId: string;
  readonly seedRecord: SeedRecord;
  readonly request: ScenarioRequestShape;
  readonly formPage: CandidateLocation;
  readonly candidate: { readonly identityDigest: string; readonly ruleDigest: string };
  readonly candidateFields: readonly WorkerStartWriteField[];
  readonly values: Readonly<Record<string, string | null>>;
  readonly verification: {
    readonly successCondition: ScenarioResultCondition;
    readonly inputErrorCondition: ScenarioResultCondition;
    readonly recordId: ScenarioRecordIdSpec;
  };
  readonly readVerification: WorkerStartReadCheck;
  /** T31f: UPDATE の指定（`WRITE_UPDATE` だけ）。 */
  readonly update?: WorkerStartWriteUpdate;
  /** T32d: 書き込みの報告の承認の要約の事実（開始の時点。ワーカーは書き写すだけ）。 */
  readonly approvalFacts: ApprovalSummaryFacts;
}

/**
 * T40a: 送り方 API の書き込みの指定の印（`WorkerStartApiWrite.transport`。form の書き込みの指定は、この項目を持たない）。T40R-fix-B: 送り方の値の唯一の
 * 定数（core の `API_SCENARIO_TRANSPORT`。シナリオの契約が公開し直す）の、公開の名前を保つ別名。
 */
export const WORKER_API_WRITE_TRANSPORT = API_SCENARIO_TRANSPORT;

/**
 * 送り方 API の登録の書き込みの指定（`START` の `write`。T40a。Task 40 の設計書 3.2）。親が、実行の許可を消費し、値を生成して送る前の記録を書いて
 * から入れる（form の書き込みの指定と同じ）。`WRITE_CREATE` だけ（API の更新は Task 41 まで持てない）。
 * - `scenarioId`・`scenarioRevision`・`grantId`・`profileId`・`seedRecord`・`approvalFacts`・`verification`: form の書き込みの指定と同じ。
 * - `formPage`: 書き込みの画面（probe の候補を見た画面の Origin と path。型の印を含まない）。`candidate`: 承認に縛った候補の識別と規則の digest。
 * - `submitterIdentityDigest`: 押す送信の要素の候補の識別の digest（登録の画面の path で求めたもの。登録では `candidate.identityDigest` と同じ）。
 * - `api`: 承認した API の指定（シナリオの API の指定の形のまま。Guard の照合に要る要求の型・鍵と JSON の型・ページが決める鍵・許すヘッダの名前と、
 *   鍵と欄の対応（欄の識別）、登録の ID の取り方（応答の本文の鍵。null は検証の指定の取り方））。値を持たない。
 * - `values`: 欄に対応する鍵（`api.keyFields`）ごとの生成した値（null は欄に入れない）。鍵の集まりは `api.keyFields` の鍵とちょうど同じで、値は鍵の
 *   JSON の型に変えられる（`jsonValueOf`）。ページが決める鍵の値は持たない（ワーカーが送られた要求から読む）。
 * - `readVerification`: 照合の READ（候補の READ は生成した値を結び付けた送る値、`{id}` の型の画面の READ は送る値なしで、対象の画面は書き込みの画面と
 *   同じ Origin の型の path。`{id}` に入れるのはワーカーが取った登録の ID）。
 */
export interface WorkerStartApiWrite {
  readonly transport: typeof WORKER_API_WRITE_TRANSPORT;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  readonly grantId: string;
  readonly profileId: string;
  readonly seedRecord: SeedRecord;
  readonly formPage: CandidateLocation;
  readonly candidate: { readonly identityDigest: string; readonly ruleDigest: string };
  readonly submitterIdentityDigest: string;
  readonly api: ScenarioApiSpec;
  readonly values: Readonly<Record<string, string | null>>;
  /**
   * T40a-fix（Task 40 の設計書 7 章の「T40a の報告（API の検証の指定）」）: 成否の条件と入力の誤りの条件は使わない（いつも null）。ID の取り方は
   * 検証の指定の `recordId`（保存の後の画面の URL・要素）で、API の `recordId`（応答の本文の鍵）があれば null でもよい（2 つとも null は契約で拒む）。
   */
  readonly verification: {
    readonly successCondition: null;
    readonly inputErrorCondition: null;
    readonly recordId: ScenarioRecordIdSpec | null;
  };
  readonly readVerification: WorkerStartReadCheck;
  readonly approvalFacts: ApprovalSummaryFacts;
  /**
   * T41b（Task 41 の設計書 3.2、8 章の設計者の判断 (2)）: API の更新の指定（`WRITE_UPDATE` で必ず持ち、ほかの種類では持てない）。対象のレコードの ID
   * だけ（親が実行の許可から写す）。保つ鍵とページが決める鍵の値は持たない（ワーカーが画面から読む）。
   */
  readonly update?: WorkerStartApiWriteUpdate;
}

/** T41b: API の更新の指定（`WorkerStartApiWrite.update`）。`targetRecordId` は登録の ID として使える形（Schema は form の UPDATE の指定と同じ定義を参照）。 */
export interface WorkerStartApiWriteUpdate {
  readonly targetRecordId: string;
  /**
   * T41R2-fix-B で作った空でない鍵の名前の一覧を、T41R3-fix-B（Task 41 の設計書 8 章の「T41R3」の C-3、ユーザーの判断「API の更新だけ台帳と比べる」）で
   * 置き換えた: 保つ鍵ごとの、台帳（登録と照合済みの更新で送った値）で最後に分かっている値（空を含む。値は BeakSight が作ったテストの値で、`values` と同じ
   * 扱い）。鍵は `api.keptKeys` の一部で重なりなし、件数は `MAX_SCENARIO_API_KEYS` まで、値の長さは `MAX_SUBMITTED_VALUE_LENGTH` まで。ワーカーは、画面の
   * 値がこれと同じでなければ、値が入る前か BeakSight の外で変わったとみなす。
   */
  readonly knownKeptValues: readonly { readonly key: string; readonly value: string }[];
}

/** T40a: 書き込みの指定が、送り方 API のものか（form の書き込みの指定は `transport` を持たない）。 */
export const isWorkerStartApiWrite = (write: WorkerStartWrite | WorkerStartApiWrite): write is WorkerStartApiWrite =>
  'transport' in write && write.transport === WORKER_API_WRITE_TRANSPORT;

/**
 * 書き込みの指定の UPDATE の指定（`START` の `write.update`。T31f。Task 31 の設計書 4 章の「IPC」）。値を持たない。
 * - `targetRecordId`: 更新の対象のレコードの ID（親が実行の許可（`ExecutionGrantView.targetRecordId`）から写す。登録の ID として使える形。スキーマで
 *   確かめる）。`formPage` の path と `request` の path は、この ID を 1 つの区切りとして含み、型の印（`{id}`）を含まない。
 * - `templatedIdentityDigest`: 承認したシナリオの、候補の型にした識別の digest（ワーカーが、具体的な画面の候補と照らす）。
 * - `changedFieldNames`: 変える欄（シナリオの送る欄。`values` の名前と同じ集まり。1 件以上）。`keptFieldNames`: 保つ欄（シナリオの UPDATE の指定。
 *   変える欄と重ならない、候補の欄。`_method` でない）。名前だけで、値は持たない。
 */
export interface WorkerStartWriteUpdate {
  readonly targetRecordId: string;
  readonly templatedIdentityDigest: string;
  readonly changedFieldNames: readonly string[];
  readonly keptFieldNames: readonly string[];
}

/**
 * READ の確かめの定義 1 件（`START` の `readChecks`。T27e）。秘密に見える名前の送る値を持たない（契約で拒む）。
 * - `readCheckId`・`readCheckRevision`: 管理データの定義の ID と、開始のときの版（結果の記録で、今の版と照らす）。
 * - `targetPage`: 対象の候補の画面（Origin と path）。親が、候補を最後に見た発見の成果物から決める。決められなければ `null`（ワーカーは読まずに
 *   `READ_CANDIDATE_DRIFTED` にする）。
 * - `definition`: 定義の中身（対象の識別の digest、送る値、期待）。
 */
export interface WorkerStartReadCheck {
  readonly readCheckId: string;
  readonly readCheckRevision: number;
  readonly targetPage: CandidateLocation | null;
  readonly definition: ReadCheckDefinition;
}

/**
 * 認証つきの監査の指定（`START` の `authentication`。T25d）。秘密を含まない。
 * - `setup`: 親が開始の直前に `validateAuthSetup` で検証した認証の設定の文書。
 * - `approvedTestOrigins`: プロファイルの許可 Origin（状態を絞る Origin。認証の設定の Origin は、すべてここに含まれる）。
 * - `authenticationSha256`: `workerAuthenticationDigestOf(setup, approvedTestOrigins, { jobKind, automatedLogin })`。ワーカーは、受けた値から
 *   求め直して比べる。
 * - `automatedLogin`（T26d-2）: 自動ログインの設定（`setup.automatedLogin` が null でない）のときだけ持つ。
 * - `approvedServiceOrigins`（T34a。任意。ないときは空と同じ）: プロファイルの承認したサービスの Origin。版 3 の設定のスクリプトの送信先の Origin は
 *   すべてここに含まれ、ログインに伴う送信の Origin は、ここか `approvedTestOrigins` に含まれる。`approvedTestOrigins` と重ならない。
 *   T34c: 1 つ以上あるときだけ `authenticationSha256` に入れる（`WorkerAuthenticationBinding`。版 2 の値と、ないプロファイルの値は変わらない）。
 */
export interface WorkerStartAuthentication {
  readonly setup: AuthSetup;
  readonly approvedTestOrigins: readonly string[];
  readonly approvedServiceOrigins?: readonly string[];
  readonly authenticationSha256: string;
  readonly automatedLogin?: WorkerStartAutomatedLogin;
}

/**
 * 自動ログインの指定（`START` の `authentication.automatedLogin`。T26d-2）。秘密を含まない。
 * - `credentialRevision`: 親が開始の前の確かめで読んだ、資格情報のファイルの改訂の番号（ワーカーは、読んだファイルの番号と比べる）。
 * - `credentialRoot`: 資格情報のフォルダを決める根の絶対パス（`resolveCredentialDirectory` に渡す根。親が決める。管理データの場所と同じ扱い）。
 */
export interface WorkerStartAutomatedLogin {
  readonly credentialRevision: number;
  readonly credentialRoot: string;
}

/** 止める（親 → 子）。`force` が偽なら CLI の Ctrl+C の 1 回目、真なら 2 回目と同じ止め方。 */
export interface WorkerStopMessage extends WorkerMessageBase<'STOP'> {
  readonly force: boolean;
}

/** 送る直前の確かめ直しの結果（親 → 子。T30e）。許すときは `reason` が null、拒むときは理由。 */
export interface WorkerWriteRecheckResultMessage extends WorkerMessageBase<'WRITE_RECHECK_RESULT'> {
  readonly allowed: boolean;
  readonly reason: WorkerWriteRecheckRejectionReason | null;
}

/**
 * ML-a: 利用者が、手動のログインの画面でログインを終えた（親 → 子。項目なし）。親は、手動のログインのジョブがログインを待っている（`AWAITING_LOGIN`）ときに
 * 1 回だけ送る。ワーカーは、手動のログインの段の中なら、成功の条件に当たらなくても成功として進む（ほかのときは何もしない）。
 */
export type WorkerLoginConfirmedMessage = WorkerMessageBase<'LOGIN_CONFIRMED'>;

/**
 * FM2d: まとめて実行の次の段を始める（親 → 子）。親が、前の段のジョブの行を締め、次の段のジョブの行を作ってから送る。ワーカーは、途中の段の `FINISHED` の後に
 * 1 回だけ受ける（ほかのときは契約の違反）。`jobKind` は `START` の `chain` の次の段と同じ。READ の確かめなら定義の一覧（`START` の `readChecks` と同じ形。
 * 親が、発見の段の索引を記録した後に決める）を必ず持つ。
 */
export interface WorkerNextStageMessage extends WorkerMessageBase<'NEXT_STAGE'> {
  readonly jobId: string;
  readonly jobKind: WorkerNextStageJobKind;
  readonly readChecks?: readonly WorkerStartReadCheck[];
}

/** FM2d: まとめて実行の次の段を始めない（親 → 子。項目なし）。ワーカーは、終えた段の終了コードで終える。 */
export type WorkerChainEndMessage = WorkerMessageBase<'CHAIN_END'>;

export type ParentToWorkerMessage =
  | WorkerStartMessage
  | WorkerStopMessage
  | WorkerWriteRecheckResultMessage
  | WorkerLoginConfirmedMessage
  | WorkerNextStageMessage
  | WorkerChainEndMessage;

/** 再開の判断（`RESUME` のときだけ、保存の、監査を終えたページの数を持つ）。 */
export type WorkerResumeDecision =
  | { readonly kind: Exclude<WorkerResumeDecisionKind, 'RESUME'>; readonly completedPages: null }
  | { readonly kind: Extract<WorkerResumeDecisionKind, 'RESUME'>; readonly completedPages: number };

/** 実行中の知らせ（`RunNotice` と同じ項目）。 */
export type WorkerRunNotice =
  | {
    readonly kind: Extract<WorkerNoticeKind, 'SITE_UNAVAILABLE_RECHECK'>;
    readonly url: string;
    readonly delayMs: number;
    readonly attempt: number;
    readonly maxAttempts: number;
  }
  | { readonly kind: Extract<WorkerNoticeKind, 'SITE_UNAVAILABLE_SLOWDOWN'>; readonly minIntervalMs: number }
  /** DEF-141: 承認したサービスの Origin への要求の 1 分あたりの上限で、次の読み込みの前に待つ（待つ時間と、Run の全体の回数と合計）。 */
  | {
    readonly kind: Extract<WorkerNoticeKind, 'SERVICE_REQUEST_PACING_WAIT'>;
    readonly waitMs: number;
    readonly waitCount: number;
    readonly totalWaitMs: number;
  };

/**
 * 監査の中核の結果の、画面に要る項目だけ（例外の `cause`、要約、知らせ、警告は送らない）。
 * - `runId`: その Run の ID（`RUN_ACTIVE` では、実行中の Run の ID。別の起動が開始の段にいて、まだ Run の ID が決まっていないときは `null`
 *   （DEF-057 の開始のロック）。`null` は `RUN_ACTIVE` だけ）。
 * - `runDirectory`: 出力先の中の Run のディレクトリの相対パス（区切りは `/`）。`RUN_ACTIVE` だけ `null`。
 * - `runStatus`: `RAN` と `RUN_DIRECTORY_UNAVAILABLE` だけ値を持ち、ほかは `null`。
 */
export interface WorkerRunOutcome {
  readonly kind: WorkerOutcomeKind;
  readonly exitCode: number;
  readonly runId: RunId | null;
  readonly runDirectory: string | null;
  readonly runStatus: RunStatus | null;
}

export type WorkerReadyMessage = WorkerMessageBase<'READY'>;

/** 保存のセッションが始まった Run（子 → 親）。 */
export interface WorkerRunStartedMessage extends WorkerMessageBase<'RUN_STARTED'> {
  readonly runId: RunId;
  /** 出力先の中の Run のディレクトリの相対パス（区切りは `/`。`isPortableRelativeArtifactPath` を通るもの）。 */
  readonly runDirectory: string;
  readonly resumeDecision: WorkerResumeDecision;
}

export interface WorkerProgressMessage extends WorkerMessageBase<'PROGRESS'> {
  readonly report: RunProgressReport;
}

export interface WorkerNoticeMessage extends WorkerMessageBase<'NOTICE'> {
  readonly notice: WorkerRunNotice;
}

/**
 * 認証の状態の知らせ（子 → 親。T25d）。`sessionLostUrl` は `SESSION_LOST` のときだけ値を持ち（止まったページの URL。Ledger の URL と同じ
 * 伏せ字の後、`MAX_WORKER_NOTICE_URL_LENGTH` で切ったもの）、ほかの状態は `null`。
 * `automatedLogin`（T26d-2）は、自動ログインの段の結果（`AUTOMATED_LOGIN_FAILED` では必ず持つ。`AUTHENTICATED`・`UNSUPPORTED_AUTH_STATE` では、
 * 自動ログインのときだけ成功の結果を持つ）。
 */
export interface WorkerAuthStateMessage extends WorkerMessageBase<'AUTH_STATE'> {
  readonly state: WorkerAuthState;
  readonly sessionLostUrl: string | null;
  readonly automatedLogin?: WorkerAutomatedLoginReport;
  /**
   * T34c: スクリプトで送るログインの段の結果の数（`WorkerScriptLoginCounts`）。手動のログインの段の結果（`AUTHENTICATED` とログインの段の失敗。
   * T34R-fix-a: 止める印で終わったときの `WORKER_STOPPED_LOGIN_STAGE_STATE`）だけが持てる。自動ログインの結果（`automatedLogin`）と一緒には持てない。
   */
  readonly scriptLogin?: WorkerScriptLoginCounts;
  /**
   * T34e: ログインの段で止めた読み取りでない要求の一覧（`WorkerLoginStageBlockedRequests`）。`scriptLogin` と同じ状態だけが持てる（ログインの送り方に
   * よらない）。止めた要求があったときだけ送る（一覧も数も空の値は持たない）。
   */
  readonly blockedRequests?: WorkerLoginStageBlockedRequests;
  /** T43d: ログインの段で観察したこと（`WorkerLoginObservation`）。`blockedRequests` と同じ状態だけが持てる。観察したことがあったときだけ送る。 */
  readonly loginObservation?: WorkerLoginObservation;
  /**
   * ML-a: 手動のログインの段で通した読み取りでない要求の一覧（止めた一覧と同じ形と規則。理由は、通さなければ止めた理由）。`blockedRequests` と同じ状態だけが
   * 持てる。通した要求があったときだけ送る。値（本文、query の値、ヘッダの値）を持たない。
   */
  readonly passedRequests?: WorkerLoginStageBlockedRequests;
  /**
   * DEF-138（設計書 `2026-10-19-beaksight-session-loss-evidence-design.md` 2.2）: セッションの切れの証拠（`SESSION_LOST` だけが持てる。組み立てられた
   * ときだけ送る）。形は `run.json` の `authentication.sessionLoss` と同じ。値（token、Cookie の値、query の値）を持たない。
   */
  readonly sessionLoss?: SessionLossEvidence;
  /**
   * DEF-139（設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 2.1）: ログインの後のブラウザの状態の名前の記録（`WorkerLoginStateNames`）。
   * `blockedRequests` と同じ状態だけが持てる。ログインの段の終わりに状態を読んだときだけ送る。値を持たない。
   */
  readonly loginStateNames?: WorkerLoginStateNames;
}

/**
 * 自動ログインの段の結果（T26d-2。値・誤りの文・URL を持たない）。
 * - `result`: 閉じた一覧の結果（`SUCCEEDED` は送信 `YES` だけ）。
 * - `submitted`: ログインの POST を送ったか（`YES`・`NO`・`UNKNOWN`）。
 * - `retryAfterUntil`: `RATE_LIMITED` のときだけ、次に試してよい時刻（UTC の 14 桁）。ほかは `null`。
 * - `formInvalidReason`: `LOGIN_FORM_INVALID` のときだけ、フォームの確かめの理由のコード。ほかは `null`。
 * - `responseAfterSubmission`（DEF-099 fix round 1。省略できる）: ログインの POST を送った後に、main frame の文書の応答があったか。送信 `YES` の
 *   ときだけ持てる。成功は応答のあった回だけなので `false` を持てない。`false`（応答がない。接続の断など。Chromium がログインの POST を自動で送り
 *   直しうる）の回は、親が試しを 2 回と数える。
 */
export interface WorkerAutomatedLoginReport {
  readonly result: AutomatedLoginResult;
  readonly submitted: AutomatedLoginSubmission;
  readonly retryAfterUntil: string | null;
  readonly formInvalidReason: WorkerLoginFormInvalidReason | null;
  readonly responseAfterSubmission?: boolean;
}

export type WorkerHeartbeatMessage = WorkerMessageBase<'HEARTBEAT'>;

/**
 * DEF-143（設計書 `2026-10-20-beaksight-worker-heartbeat-heavy-steps-design.md` 4 章の判断）: ワーカーが「Run の終わり」の段（集計・成果物の書き出し・
 * 止めたときの片付け）に入る知らせ。その段は main thread を長く占めることがあり、その間は `HEARTBEAT` を送れない。親は、この知らせの後、途絶えの上限を
 * 名前つきの長い時間にする。値を持たない。
 */
export type WorkerRunFinalizingMessage = WorkerMessageBase<'RUN_FINALIZING'>;

export interface WorkerFinishedMessage extends WorkerMessageBase<'FINISHED'> {
  readonly outcome: WorkerRunOutcome;
  /**
   * 発見のジョブ（`DISCOVERY`）の件数の要約（T27d。Task 27 の設計書の変更履歴「T27b・T27c の報告と T27d の前の判断」の (3)）。候補は載せない
   * （候補は Run のディレクトリの `discovery.json`。場所は `outcome.runDirectory`）。Run を実行した結果（`RAN`）だけが持てる。ほかのジョブは
   * 持たない（どのジョブが持つかは、ジョブの管理が確かめる）。
   */
  readonly discovery?: WorkerDiscoverySummary;
  /**
   * READ の確かめのジョブ（`READ_CHECK`）の件数の要約（T27e）。結果は載せない（結果は Run のディレクトリの `read-evidence.json`）。Run を実行した
   * 結果（`RAN`）だけが持てる。`discovery` と同時には持てない。
   */
  readonly readCheck?: WorkerReadCheckSummary;
  /**
   * 入口の確かめのジョブ（`ENTRY_CHECK`）の件数の要約（T43c）。読んだ事実と案は載せない（Run のディレクトリの `entry-check.json`）。Run を実行した
   * 結果（`RAN`）だけが持てる。`discovery`・`readCheck` と同時には持てない。
   */
  readonly entryCheck?: WorkerEntryCheckSummary;
  /**
   * FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の段の、未完了の理由のコード（コードだけ。詳細・URL を持たない。重なり
   * なし）。まとめて実行のワーカーが、Run を実行した段の `FINISHED` に載せる。親は、次の段へ進むかの判定（`stage-chain-policy.ts`）に使う。
   */
  readonly incompleteReasonCodes?: readonly IncompleteReasonCode[];
}

/** 入口の確かめのジョブの件数の要約（`src/control/entry-check.ts` の `EntryCheckSummary` そのもの。T43c）。URL・セレクタ・値を持たない。 */
export type WorkerEntryCheckSummary = EntryCheckSummary;

/** READ の確かめのジョブの件数の要約（`src/discovery/read-check-evaluation.ts` の `ReadEvidenceSummary` と同じ形。T27e）。 */
export interface WorkerReadCheckSummary {
  /** 定義の数。 */
  readonly checks: number;
  /** 確かめた定義の数。 */
  readonly executed: number;
  /** 監査の段の数（T37a。成果物 `read-evidence.json` の `authentication` と同じ値。監査の段の口のあるジョブだけ。数だけ）。 */
  readonly authentication?: WorkerAuditStageSummary;
  /** DEF-144: 違反で止まったときの違反の中身（成果物 `read-evidence.json` の `safetyViolation` と同じ値。値を持たない）。 */
  readonly safetyViolation?: JobSafetyViolation;
}

/** 発見のジョブの件数の要約（`src/discovery/discovery-result.ts` の `DiscoverySummary` と同じ形。T27d）。値・URL を持たない。 */
export interface WorkerDiscoverySummary {
  readonly pagesRead: number;
  readonly pagesNotRead: number;
  readonly candidates: number;
  /** 監査の段の数（T37a。成果物 `discovery.json` の `authentication` と同じ値。監査の段の口のあるジョブだけ。数だけ）。 */
  readonly authentication?: WorkerAuditStageSummary;
  /**
   * DEF-144: 違反で止まったときの違反の中身（成果物 `discovery.json` の `safetyViolation` と同じ値。種類・文・結びつく要求の method と Origin と path・段・
   * 画面の path・押した候補。値を持たない）。
   */
  readonly safetyViolation?: JobSafetyViolation;
}

/**
 * 発見と READ の確かめのジョブの、監査の段の数（T37a。Task 37 の設計書 3.1。`run.json` の `authentication` と同じ形 `RunAuthenticationSummary`。
 * スキーマは `run.schema.json` の形を参照する）。数だけで、URL・値を持たない。
 */
export type WorkerAuditStageSummary = RunAuthenticationSummary;

export interface WorkerFailedMessage extends WorkerMessageBase<'FAILED'> {
  readonly reason: WorkerFailureReason;
  /** 利用者に見せない英語の短い詳細（`toWorkerFailureDetail` で作る）。 */
  readonly detail: string;
}

/** 送る直前の確かめ直しの依頼（子 → 親。T30e。1 つのジョブで 1 回）。 */
export type WorkerWriteRecheckRequestMessage = WorkerMessageBase<'WRITE_RECHECK_REQUEST'>;

/** 送信の報告（子 → 親。T30e。1 回）。`NOT_SENT` だけが止めた理由を持つ。 */
export interface WorkerWriteSubmissionMessage extends WorkerMessageBase<'WRITE_SUBMISSION'> {
  readonly submission: SubmissionState;
  readonly blockReason: ActionBlockReason | null;
}

export type WorkerToParentMessage =
  | WorkerReadyMessage
  | WorkerRunStartedMessage
  | WorkerProgressMessage
  | WorkerNoticeMessage
  | WorkerAuthStateMessage
  | WorkerHeartbeatMessage
  | WorkerRunFinalizingMessage
  | WorkerFinishedMessage
  | WorkerFailedMessage
  | WorkerWriteRecheckRequestMessage
  | WorkerWriteSubmissionMessage;

/** 検証の結果。受けるときは深く凍結した写し、拒むときは英語の技術的な誤りの一覧（1 件以上）。 */
export type WorkerMessageValidation<Message> =
  | { readonly ok: true; readonly message: Message }
  | { readonly ok: false; readonly errors: readonly string[] };

// ---------------------------------------------------------------------------------------------------------------
// 検証
// ---------------------------------------------------------------------------------------------------------------

// 詳細と URL に書けない文字: 制御文字（Unicode の一般カテゴリ Cc）と、行・段落の区切り（一般カテゴリ Zl、Zp。U+2028、U+2029）。
// 判定と置き換えは `src/core/text.ts` の `hasControlOrLineSeparator`、`replaceControlOrLineSeparators`（CCX-3）。
/** 書けない文字の置き換え（空白）。 */
const FORBIDDEN_TEXT_REPLACEMENT = ' ';

/** `runStatus` を持つ結果の種類（ほかの種類は `null`）。 */
const OUTCOME_KINDS_WITH_RUN_STATUS: ReadonlySet<WorkerOutcomeKind> = new Set(['RAN', 'RUN_DIRECTORY_UNAVAILABLE']);
/** `runDirectory` を持たない結果の種類（ほかの種類は相対パスを持つ）。 */
const OUTCOME_KINDS_WITHOUT_RUN_DIRECTORY: ReadonlySet<WorkerOutcomeKind> = new Set(['RUN_ACTIVE']);
/** `runId` が `null` でよい結果の種類（ほかの種類は Run の ID を持つ）。 */
const OUTCOME_KINDS_WITH_OPTIONAL_RUN_ID: ReadonlySet<WorkerOutcomeKind> = new Set(['RUN_ACTIVE']);
/** 監査を終えたページの数を持つ再開の判断。 */
const RESUME_DECISION_WITH_COMPLETED_PAGES: WorkerResumeDecisionKind = 'RESUME';
/** 発見の件数の要約を持てる結果の種類（T27d。Run を実行した結果だけ）。READ の確かめの件数の要約（T27e）も同じ。 */
const OUTCOME_KIND_WITH_DISCOVERY_SUMMARY: WorkerOutcomeKind = 'RAN';

const PARENT_TYPES: ReadonlySet<string> = new Set(PARENT_TO_WORKER_MESSAGE_TYPES);
const WORKER_TYPES: ReadonlySet<string> = new Set(WORKER_TO_PARENT_MESSAGE_TYPES);

/** 詳細や URL として使える文字列か: 制御文字・行と段落の区切りを含まず、対になっていないサロゲートを含まず、UTF-16 で `maxLength` 以下。 */
/**
 * 一覧の path として書ける値か（`/` で始まり、query・fragment・制御文字なし、上限の長さまで）。T34e fix round 1: 伏せるべき値に見える区切りが残って
 * いない（Guard の側が伏せたのと同じ判定 `hasValueLikePathSegment`。`src/core/url-path-redaction.ts` の 1 か所）。
 */
const isBlockedRequestPath = (path: string): boolean =>
  path.startsWith('/')
  && !path.includes('?')
  && !path.includes('#')
  && isCleanText(path, MAX_WORKER_LOGIN_STAGE_BLOCKED_PATH_LENGTH)
  && !hasValueLikePathSegment(path);

/**
 * ログインの段で止めた要求の一覧の、スキーマで書けない規則の誤り（T34e）: 止めた要求があること、Origin が正規の直列化であること、path が `/` で
 * 始まり query・fragment・制御文字と値に見える区切りを持たないこと（`isBlockedRequestPath`）、同じ Origin・path・種類・理由の行を重ねないこと。
 * 誤りの文に値を入れない。
 */
const blockedRequestsErrors = (blocked: WorkerLoginStageBlockedRequests, pointer = '/blockedRequests'): readonly string[] => {
  // ML-a: 手動のログインの段で通した要求の一覧（`passedRequests`）も、同じ規則で確かめる（`pointer` は誤りの文の位置）。
  const errors: string[] = [];
  if (blocked.requests.length === 0 && blocked.unlisted === 0) {
    errors.push(`${pointer} must have a request`);
  }
  const seen = new Set<string>();
  blocked.requests.forEach(({ origin, path, resourceType, reason, query }, index) => {
    if (canonicalHttpOriginOf(origin) !== origin) {
      errors.push(`${pointer}/requests/${index}/origin must be the canonical serialization of an http(s) origin`);
    }
    if (!isBlockedRequestPath(path)) {
      errors.push(`${pointer}/requests/${index}/path must be a path without a query, a fragment or a value-like segment`);
    }
    if (query !== undefined && !isObservedQuery(query)) {
      errors.push(`${pointer}/requests/${index}/query must have the recorded names and only the closed list values among them`);
    }
    // T43d: 閉じた一覧の名前の値が違う行は、重ならない（Guard の側も値ごとに行を分ける）。
    const key = JSON.stringify([origin, path, resourceType, reason, query?.values ?? []]);
    if (seen.has(key)) {
      errors.push(`${pointer}/requests/${index} must not repeat another request`);
    }
    seen.add(key);
  });
  return errors;
};

/**
 * T43d: 止めた要求の行の query の記録として書ける値か（名前は 1 つ以上で重ならず、どれも記録の名前の形（`isLoginObservedQueryName`）。値は閉じた一覧の
 * 名前ごとに 1 つまでで、名前の一覧にあり、残してよい値（`isLoginObservedQueryValue`））。
 */
const isObservedQuery = ({ names, values }: WorkerLoginObservedQuery): boolean => {
  const valueNames = values.map(({ name }) => name);
  return names.length > 0
    && new Set(names).size === names.length
    && names.every(isLoginObservedQueryName)
    && new Set(valueNames).size === valueNames.length
    && values.every(({ name, value }) => names.includes(name) && isLoginObservedQueryValue(name, value));
};

/** T43d: 観察の誤り（スキーマで書けない規則）。誤りの文に値を入れない。 */
const loginObservationErrors = ({ storageKeys, successSelector, credentialDiscarded, loginFields }: WorkerLoginObservation): readonly string[] => {
  const errors: string[] = [];
  if (storageKeys === undefined && successSelector === undefined && credentialDiscarded === undefined && loginFields === undefined) {
    errors.push('/loginObservation must have the storage key shapes, the success selector, the discarded count or the login fields');
  }
  if (loginFields !== undefined) {
    // FM2e: 欄の CSS の案は、認証の設定として受ける形だけ。案のない欄は `null`。どれかは案があり、案どうしは違う。
    const selectors = ENTRY_CHECK_FIELDS.map((field) => loginFields[field]).filter((selector): selector is string => selector !== null);
    if (selectors.length === 0 || new Set(selectors).size !== selectors.length
      || !selectors.every((selector) => isCleanText(selector, MAX_URL_LENGTH) && isAcceptedEntrySelector(selector))) {
      errors.push('/loginObservation/loginFields must be different CSS selectors that the auth setup accepts, with at least one field');
    }
  }
  if (storageKeys !== undefined) {
    const { origin: keyOrigin } = storageKeys;
    if (canonicalHttpOriginOf(keyOrigin) !== keyOrigin) {
      errors.push('/loginObservation/storageKeys/origin must be the canonical serialization of an http(s) origin');
    }
    // T43R-fix の C-1 (a): 接頭辞と接尾辞の組だけ（名前の全体は持たない）。重ならない。
    const { shapes } = storageKeys;
    const keys = shapes.map(({ prefix, suffix }) => JSON.stringify([prefix, suffix]));
    if (shapes.length === 0 || new Set(keys).size !== keys.length || !shapes.every(isLoginObservedStorageKeyShape)) {
      errors.push('/loginObservation/storageKeys/shapes must be the prefixes and the suffixes of the key names without a repeated pair');
    }
  }
  if (successSelector !== undefined) {
    // T43R-fix の C-1 (b): ログアウトの語を含む属性から作った CSS の形だけ。
    const { selector } = successSelector;
    if (!isCleanText(selector, MAX_URL_LENGTH) || !isAcceptedEntrySelector(selector) || !isLoginObservedSuccessSelector(selector)) {
      errors.push('/loginObservation/successSelector/selector must be a CSS of a logout attribute that the auth setup accepts');
    }
  }
  return errors;
};

const isCleanText = (value: string, maxLength: number): boolean =>
  value.length <= maxLength && !hasLoneSurrogate(value) && !hasControlOrLineSeparator(value);

/** DEF-139: 名前の形として書ける値か（`null` か、ログインの段の観察と同じ決まりの組）。 */
const isLoginStateNameShape = (shape: LoginStateNameRecord['localStorage']['rows'][number]['shape']): boolean =>
  shape === null || isLoginObservedStorageKeyShape(shape);

/** DEF-139: 状態の名前の記録の誤り（スキーマで書けない規則）。誤りの文に値を入れない。 */
const loginStateNamesErrors = ({ cookies, localStorage, indexedDB }: WorkerLoginStateNames): readonly string[] => {
  const errors: string[] = [];
  cookies.rows.forEach(({ domain, path, shape }, index) => {
    if (!isCleanText(domain, MAX_LOGIN_STATE_NAME_DOMAIN_LENGTH) || !isCleanText(path, MAX_LOGIN_STATE_NAME_PATH_LENGTH) || hasValueLikePathSegment(path)
      || !isLoginStateNameShape(shape)) {
      errors.push(`/loginStateNames/cookies/rows/${index} must have a clean domain, a path without value-like segments and a name shape`);
    }
  });
  for (const [name, list] of [['localStorage', localStorage], ['indexedDB', indexedDB]] as const) {
    list.rows.forEach(({ origin, shape }, index) => {
      if (canonicalHttpOriginOf(origin) !== origin || !isLoginStateNameShape(shape)) {
        errors.push(`/loginStateNames/${name}/rows/${index} must have a canonical origin and a name shape`);
      }
    });
  }
  return errors;
};

/** DEF-138: 証拠の path の表記の query の始まり。 */
const SESSION_LOSS_PATH_QUERY_START = '?';

/**
 * DEF-138: 証拠の path の表記として受けるか（`/` で始まり、fragment を持たず、書ける文字だけで、上限の長さまで。`?` の前の path に値に見える区切りが
 * なく、`?` の後は名前だけ（`=` を持たない。値に見える名前は伏せてある））。
 */
const isSessionLossPath = (value: string): boolean => {
  const queryAt = value.indexOf(SESSION_LOSS_PATH_QUERY_START);
  const path = queryAt < 0 ? value : value.slice(0, queryAt);
  const names = queryAt < 0 ? '' : value.slice(queryAt + SESSION_LOSS_PATH_QUERY_START.length);
  return value.startsWith('/') && !value.includes('#') && !names.includes('=') && isCleanText(value, MAX_SESSION_LOSS_PATH_LENGTH)
    && !hasValueLikePathSegment(path);
};

/**
 * DEF-138: セッションの切れの証拠の、スキーマで書けない規則の誤り（形は確かめ済み）。path の表記、段階と method の文字、鍵の名前の案の形（ログインの段の観察と
 * 同じ決まり `isLoginObservedStorageKeyShape`）を確かめる。成果物の書き手とジョブの管理の読み直しも、同じ規則を使う。
 */
export const sessionLossErrors = (evidence: SessionLossEvidence, pointer: string): readonly string[] => {
  const errors: string[] = [];
  if (evidence.stage !== null && !isCleanText(evidence.stage, MAX_SESSION_LOSS_PATH_LENGTH)) {
    errors.push(`${pointer}/stage must not contain control characters or lone surrogates`);
  }
  for (const [name, path] of [['requestedPath', evidence.requestedPath], ['landedPath', evidence.landedPath]] as const) {
    if (path !== null && !isSessionLossPath(path)) {
      errors.push(`${pointer}/${name} must be a path with the query names only`);
    }
  }
  evidence.redirectPaths.forEach(({ path }, index) => {
    if (!isSessionLossPath(path)) {
      errors.push(`${pointer}/redirectPaths/${index}/path must be a path with the query names only`);
    }
  });
  evidence.blockedRequests.forEach(({ method, path }, index) => {
    if (!isCleanText(method, MAX_SESSION_LOSS_PATH_LENGTH) || !isSessionLossPath(path) || path.includes(SESSION_LOSS_PATH_QUERY_START)) {
      errors.push(`${pointer}/blockedRequests/${index} must have a clean method and a path without a query`);
    }
  });
  (evidence.storageKeyChange ?? []).forEach(({ shapes }, index) => {
    if (!shapes.every(isLoginObservedStorageKeyShape)) {
      errors.push(`${pointer}/storageKeyChange/${index}/shapes must be the prefixes and the suffixes of general words`);
    }
  });
  return errors;
};

/** 出力先の中の Run のディレクトリの相対パスとして使えるか（`isPortableRelativeArtifactPath` と、最大長）。 */
const isRunDirectoryPath = (value: unknown): value is string =>
  isPortableRelativeArtifactPath(value) && value.length <= MAX_WORKER_MESSAGE_PATH_LENGTH;

/**
 * 写しを取り、スキーマで形を確かめる。写せない値と形の誤りは、誤りの一覧を返す。形が正しければ、写しを返す（以後は写しだけを読む。
 * getter や Proxy の罠を、確かめと使う時とで 2 回呼ばない）。
 */
const shapeOf = (value: unknown): { readonly copy: Record<string, unknown> } | { readonly errors: readonly string[] } => {
  let copy: unknown;
  try {
    copy = structuredClone(value);
  } catch {
    return { errors: ['message must be a plain JSON value'] };
  }
  const shape = validateControlDocument('worker-message', copy);
  if (!shape.ok) {
    return { errors: shape.errors };
  }
  return { copy: copy as Record<string, unknown> };
};

const rejected = <Message>(errors: readonly string[]): WorkerMessageValidation<Message> =>
  Object.freeze({ ok: false, errors: Object.freeze([...errors]) });

const accepted = <Message>(message: Message): WorkerMessageValidation<Message> =>
  Object.freeze({ ok: true, message: deepFreeze(message) });

/** 親 → 子のメッセージの、スキーマで書けない規則の誤り（形は確かめ済み）。 */
const parentRuleErrors = (message: ParentToWorkerMessage): readonly string[] => {
  if (message.type === 'WRITE_RECHECK_RESULT') {
    // T30e: 許すときは理由なし、拒むときは理由つき。
    return message.allowed === (message.reason === null) ? [] : ['/reason must be null exactly when the write is allowed'];
  }
  if (message.type === 'NEXT_STAGE') {
    return nextStageRuleErrors(message);
  }
  if (message.type !== 'START') {
    return [];
  }
  const errors: string[] = [];
  if (!WORKER_JOB_ID_PATTERN.test(message.jobId)) {
    errors.push(`/jobId must match ${WORKER_JOB_ID_PATTERN.source}`);
  }
  if (!isAcceptedTargetConfigPath(message.targetConfigPath)) {
    errors.push('/targetConfigPath must be an accepted target configuration path');
  }
  if (!TARGET_CONFIG_SHA256_PATTERN.test(message.targetConfigSha256)) {
    errors.push(`/targetConfigSha256 must match ${TARGET_CONFIG_SHA256_PATTERN.source}`);
  }
  if (message.authentication !== undefined) {
    errors.push(...authenticationRuleErrors(message.authentication));
  }
  // FM-2: ジョブのブラウザの表示の設定は、Run の Browser を起動するジョブだけが持てる。
  if (message.showJobBrowser !== undefined && !WORKER_JOB_KINDS_WITH_JOB_BROWSER.includes(message.jobKind)) {
    errors.push(`/showJobBrowser is not allowed for ${message.jobKind}`);
  }
  // AS-b: 監査の段の送信の扱いは、監査・発見・READ の確かめのジョブだけが持てる（値の一覧はスキーマが確かめる）。
  if (message.auditSendPolicy !== undefined && !WORKER_JOB_KINDS_WITH_AUDIT_SEND_POLICY.includes(message.jobKind)) {
    errors.push(`/auditSendPolicy is not allowed for ${message.jobKind}`);
  }
  // PRE42-BN: プロファイルの名前（バンドルのファイル名だけに使う）は、監査のジョブだけが持てる（長さはスキーマが確かめる）。
  if (message.profileName !== undefined && message.jobKind !== WORKER_AUDIT_JOB_KIND) {
    errors.push(`/profileName is not allowed for ${message.jobKind}`);
  }
  // T26d-2: ログインの検証は、自動ログインの指定を必ず持つ（手動のログインと公開の監査では行わない）。
  if (message.jobKind === WORKER_LOGIN_CHECK_JOB_KIND && message.authentication?.automatedLogin === undefined) {
    errors.push(`/authentication/automatedLogin is required for ${WORKER_LOGIN_CHECK_JOB_KIND}`);
  }
  // T27d: 発見のジョブは、認証つき（`TEST_AUTH_PASSIVE` と、T28b から `TEST_APPROVED_WRITE` の認証の設定）だけ（Task 27 の設計書 3 章。fail-closed）。
  if (message.jobKind === WORKER_DISCOVERY_JOB_KIND && message.authentication === undefined) {
    errors.push(`/authentication is required for ${WORKER_DISCOVERY_JOB_KIND}`);
  }
  // T43c: 入口の確かめは、ログインの状態を持たない読み取りだけの Context で読むので、認証の指定を持たない（fail-closed）。
  if (message.jobKind === WORKER_ENTRY_CHECK_JOB_KIND && message.authentication !== undefined) {
    errors.push(`/authentication is not allowed for ${WORKER_ENTRY_CHECK_JOB_KIND}`);
  }
  // T27e: READ の確かめのジョブは、認証つきで、定義の一覧を必ず持つ。ほかの種類は、定義の一覧を持たない。
  if (message.jobKind === WORKER_READ_CHECK_JOB_KIND) {
    if (message.authentication === undefined) {
      errors.push(`/authentication is required for ${WORKER_READ_CHECK_JOB_KIND}`);
    }
    if (message.readChecks === undefined) {
      errors.push(`/readChecks is required for ${WORKER_READ_CHECK_JOB_KIND}`);
    }
  } else if (message.readChecks !== undefined) {
    errors.push(`/readChecks is allowed only for ${WORKER_READ_CHECK_JOB_KIND}`);
  }
  if (message.readChecks !== undefined) {
    errors.push(...readCheckRuleErrors(message.readChecks));
  }
  // T30e: 書き込みのジョブは、認証つき（ログインを使う方式）で、書き込みの指定を必ず持つ。ほかの種類は、書き込みの指定を持たない。
  // T31f: 更新の書き込みのジョブ（`WRITE_UPDATE`）も同じ。UPDATE の指定（`write.update`）は `WRITE_UPDATE` で必ず持ち、ほかの種類では持てない。
  if (isWorkerWriteJobKind(message.jobKind)) {
    if (message.authentication === undefined) {
      errors.push(`/authentication is required for ${message.jobKind}`);
    }
    if (message.write === undefined) {
      errors.push(`/write is required for ${message.jobKind}`);
    } else if (isWorkerStartApiWrite(message.write)) {
      // T40a: 送り方 API の書き込みの指定。T41b: 更新の書き込みのジョブ（`WRITE_UPDATE`）は API の更新の指定（`write.update`）を必ず持ち、登録は持てない。
      if ((message.jobKind === WORKER_WRITE_UPDATE_JOB_KIND) !== (message.write.update !== undefined)) {
        errors.push(`/write/update is required for ${WORKER_WRITE_UPDATE_JOB_KIND} and allowed only for it`);
      }
    } else if ((message.jobKind === WORKER_WRITE_UPDATE_JOB_KIND) !== (message.write.update !== undefined)) {
      errors.push(`/write/update is required for ${WORKER_WRITE_UPDATE_JOB_KIND} and allowed only for it`);
    }
  } else if (message.write !== undefined) {
    errors.push(`/write is allowed only for ${WORKER_WRITE_JOB_KINDS.join(' and ')}`);
  }
  if (message.write !== undefined) {
    errors.push(...(isWorkerStartApiWrite(message.write)
      ? apiWriteRuleErrors(message.write, message.authentication?.approvedServiceOrigins ?? [])
      : writeRuleErrors(message.write)));
  }
  if (message.chain !== undefined) {
    errors.push(...chainRuleErrors(message, message.chain));
  }
  return errors;
};

/** FM2d: 段の並びが、閉じた一覧の並びのどれかと同じか。 */
const isChainStageSequence = (stages: readonly string[]): boolean =>
  WORKER_CHAIN_STAGE_SEQUENCES.some((sequence) => sequence.length === stages.length && sequence.every((kind, index) => stages[index] === kind));

/** FM2d: `START` の `chain` の、スキーマで書けない規則の誤り（並びの一覧、最初の段の種類、認証つき）。 */
const chainRuleErrors = (message: WorkerStartMessage, chain: WorkerStartChain): readonly string[] => {
  const errors: string[] = [];
  const { stages } = chain;
  if (!isChainStageSequence(stages)) {
    errors.push('/chain/stages must be one of the stage sequences of the chained run');
  } else if (stages[0] !== message.jobKind) {
    errors.push('/chain/stages must start with the job kind');
  }
  if (message.authentication === undefined) {
    errors.push('/authentication is required for the chained run');
  }
  return errors;
};

/** FM2d: `NEXT_STAGE` の、スキーマで書けない規則の誤り（ジョブの ID の形、READ の確かめだけが定義の一覧を持つ、定義の一覧の規則）。 */
const nextStageRuleErrors = (message: WorkerNextStageMessage): readonly string[] => {
  const errors: string[] = [];
  if (!WORKER_JOB_ID_PATTERN.test(message.jobId)) {
    errors.push(`/jobId must match ${WORKER_JOB_ID_PATTERN.source}`);
  }
  if (message.jobKind === WORKER_READ_CHECK_JOB_KIND) {
    if (message.readChecks === undefined) {
      errors.push(`/readChecks is required for ${WORKER_READ_CHECK_JOB_KIND}`);
    }
  } else if (message.readChecks !== undefined) {
    errors.push(`/readChecks is allowed only for ${WORKER_READ_CHECK_JOB_KIND}`);
  }
  if (message.readChecks !== undefined) {
    errors.push(...readCheckRuleErrors(message.readChecks));
  }
  return errors;
};

/** 書き込みで送れる enctype（Task 30 の設計書 3 章の「送る中身の照合」。text/plain は送らない）。 */
const WRITE_ENCTYPES: ReadonlySet<string> = new Set(['application/x-www-form-urlencoded', 'multipart/form-data']);

/** http(s) の Origin の正規の直列化と、`/` から始まる path の場所か。 */
const isCanonicalLocation = ({ origin, path }: CandidateLocation): boolean => canonicalHttpOriginOf(origin) === origin && path.startsWith('/');

/**
 * `START` の書き込みの指定の、スキーマで書けない規則の誤り（T30e）: id と digest の形、enctype、要求の送信先と書き込みの画面の場所、送る値の欄が
 * 候補の送れる欄（送れる欄の判定は `isSendableField`。`_method` は送らない）で、秘密に見える名前でないこと、照合の READ の規則（READ の確かめの
 * 定義の一覧と同じ）。誤りの文に値と名前を入れない（位置だけ）。
 */
/**
 * 書き込みの指定（form と API）に共通の、スキーマで書けない規則の誤り（T40a で `writeRuleErrors` から取り出した）: id と digest の形、seed の記録と
 * 承認の要約がこの書き込みの指定のもの（`update` は UPDATE の指定を持つか）。
 */
const writeBindingRuleErrors = (write: WorkerStartWrite | WorkerStartApiWrite, update: boolean): readonly string[] => {
  const errors: string[] = [];
  if (!WORKER_JOB_ID_PATTERN.test(write.scenarioId) || !WORKER_JOB_ID_PATTERN.test(write.grantId)) {
    errors.push(`/write/scenarioId and /write/grantId must match ${WORKER_JOB_ID_PATTERN.source}`);
  }
  // T30f: seed の記録は、この書き込みの指定のもの（プロファイル・シナリオ・版・許可が同じ）。
  const { seedInput } = write.seedRecord;
  if (
    seedInput.profileId !== write.profileId
    || seedInput.scenarioId !== write.scenarioId
    || seedInput.scenarioRevision !== write.scenarioRevision
    || seedInput.executionGrantId !== write.grantId
  ) {
    errors.push('/write/seedRecord/seedInput must have the profile, the scenario, the revision and the grant of the write specification');
  }
  // T32d: 承認の要約は、この書き込みの指定のもの（プロファイル・シナリオ・版・許可・種類が同じ）。承認の判断はしない（組の一致だけ）。
  const { approvalFacts } = write;
  if (
    approvalFacts.profileId !== write.profileId
    || approvalFacts.scenario.scenarioId !== write.scenarioId
    || approvalFacts.scenario.revision !== write.scenarioRevision
    || approvalFacts.grantAtStart.grantId !== write.grantId
    || (approvalFacts.scenario.kind === UPDATE_SCENARIO_KIND) !== update
  ) {
    errors.push('/write/approvalFacts must have the profile, the scenario, the revision, the grant and the kind of the write specification');
  }
  if (!isSha256Fingerprint(write.candidate.identityDigest) || !isSha256Fingerprint(write.candidate.ruleDigest)) {
    errors.push('/write/candidate must have the digests of a candidate');
  }
  return errors;
};

const writeRuleErrors = (write: WorkerStartWrite): readonly string[] => {
  const errors: string[] = [...writeBindingRuleErrors(write, write.update !== undefined)];
  if (!WRITE_ENCTYPES.has(write.request.enctype)) {
    errors.push('/write/request/enctype must be application/x-www-form-urlencoded or multipart/form-data');
  }
  if (!isCanonicalLocation(write.request) || !isCanonicalLocation(write.formPage)) {
    errors.push('/write/request and /write/formPage must be the canonical origin of an http(s) page and an absolute path');
  }
  Object.keys(write.values).forEach((name, index) => {
    const fields = write.candidateFields.filter((candidateField) => candidateField.name === name);
    // 送れる欄の判定は、候補の契約の判定（`isSendableField`）が見る項目だけを持つ欄で行う（値と選択肢は、判定に使わない）。
    const sendable = fields.length > 0 && fields.every((candidateField) => isSendableField(candidateField as unknown as CandidateField));
    if (!sendable || isMethodOverrideFieldName(name) || isSecretUrlQueryParameterName(name)) {
      errors.push(`/write/values (value ${index}) must be a value of a sendable field of the candidate whose name does not look like a secret`);
    }
  });
  errors.push(...readCheckItemRuleErrors(WRITE_READ_VERIFICATION_POINTER_SEGMENTS, write.readVerification, false));
  // T37d（設計者の判断 5）: 書き込みの照合の READ に、画面の path の定義は使わない（安全側。親も開始の前に拒む）。
  if (write.readVerification.definition.targetPagePath !== undefined) {
    errors.push('/write/readVerification/definition must target a READ candidate (a page path definition is not used for the verification of a write)');
  }
  if (write.update !== undefined) {
    errors.push(...writeUpdateRuleErrors(write, write.update));
  }
  return errors;
};

/** T40a: API の登録の要求の method（API の更新の `PATCH` は Task 41）。 */
const API_CREATE_METHOD = 'POST';

/**
 * 送り方 API の登録の書き込みの指定の、スキーマで書けない規則の誤り（T40a。Task 40 の設計書 3.2、4 章）: 共通の規則（`writeBindingRuleErrors`）、
 * 書き込みの画面の場所（型の印を含まない）、送信の要素の識別の digest（登録では候補の識別の digest）、API の指定（型の digest の形、POST、filter と
 * 台帳なし、Origin が正規の直列化で、認証の指定の承認したサービスの Origin（`approvedServiceOrigins`）にある、鍵が重ならず、ページが決める鍵と重ならない）、
 * 値（鍵の集まりが欄に対応する鍵とちょうど同じ、秘密に見える名前でない、1 つ以上の値、値が鍵の JSON の型に変えられる）、照合の READ（READ の確かめの
 * 定義の一覧と同じ規則。画面の path の定義は `{id}` の型だけで、対象の画面は書き込みの画面と同じ Origin の型の path）。誤りの文に値と名前を入れない。
 */
const apiWriteRuleErrors = (write: WorkerStartApiWrite, approvedServiceOrigins: readonly string[]): readonly string[] => {
  const { update } = write;
  const errors: string[] = [...writeBindingRuleErrors(write, update !== undefined)];
  if (!isCanonicalLocation(write.formPage) || write.formPage.path.includes(PATH_TEMPLATE_ID_SEGMENT)) {
    errors.push('/write/formPage must be the canonical origin of an http(s) page and an absolute path without a template mark');
  }
  if (!isSha256Fingerprint(write.submitterIdentityDigest) || write.submitterIdentityDigest !== write.candidate.identityDigest) {
    errors.push('/write/submitterIdentityDigest must be the identity digest of the candidate on the page of the write');
  }
  const { api } = write;
  if (!isSha256Fingerprint(api.shapeDigest)) {
    errors.push('/write/api/shapeDigest must be the digest of a request shape');
  }
  if (update === undefined && (api.request.method !== API_CREATE_METHOD || api.filterName !== null || api.ledger !== null)) {
    errors.push(`/write/api must be the spec of a CREATE (${API_CREATE_METHOD}, no filter, no ledger)`);
  }
  if (update !== undefined) {
    errors.push(...apiWriteUpdateRuleErrors(write, update));
  }
  const { origin: apiOrigin } = api.request;
  if (canonicalHttpOriginOf(apiOrigin) !== apiOrigin || !isOriginInAllowedOrigins(approvedServiceOrigins, apiOrigin)) {
    errors.push('/write/api/request/origin must be the canonical origin of an approved service origin of the authentication');
  }
  const keys = api.keyFields.map(({ key }) => key);
  const keySet = new Set(keys);
  const pageKeys = api.pageKeys.map(({ key }) => key);
  if (keys.length === 0 || keySet.size !== keys.length || new Set(pageKeys).size !== pageKeys.length || pageKeys.some((key) => keySet.has(key))) {
    errors.push('/write/api/keyFields must have one or more keys, each once, and no key of the page');
  }
  const valueNames = Object.keys(write.values);
  if (valueNames.length !== keySet.size || valueNames.some((name) => !keySet.has(name) || isSecretUrlQueryParameterName(name))) {
    errors.push('/write/values must have a value for each key of the fields only, and no secret-like name');
  }
  if (valueNames.every((name) => write.values[name] === null)) {
    errors.push('/write/values must have a value to fill');
  }
  // T40a-fix: ID の取り方は、検証の指定か API の指定のどちらかに要る（成否の条件と入力の誤りの条件の null はスキーマで確かめる）。T41b: 更新は、対象の
  // ID を登録の ID にする（取り方は要らない）。
  if (update === undefined && write.verification.recordId === null && api.recordId === null) {
    errors.push('/write/verification/recordId and /write/api/recordId must not both be null (no way to take the record id)');
  }
  // T40R2-fix（使える度合い）: 画面から ID を取る型が書き込みの画面に当たっても拒まない（保存と同じ。取り違えはワーカーの押す前の値との比べと、
  // 実行のたびに変わる値の照合で防ぐ）。
  api.keyFields.forEach(({ key, type }, index) => {
    const value = Object.hasOwn(write.values, key) ? write.values[key] ?? null : null;
    if (value !== null && !isJsonValueConvertible(value, type)) {
      errors.push(`/write/values (key ${index}) must be convertible to the JSON type of the key`);
    }
  });
  errors.push(...readCheckItemRuleErrors(WRITE_READ_VERIFICATION_POINTER_SEGMENTS, write.readVerification, false));
  const { targetPage, definition } = write.readVerification;
  if (definition.targetPagePath !== undefined && (!isReadCheckPageTemplatePath(definition.targetPagePath)
    || targetPage === null || !isOriginInAllowedOrigins([write.formPage.origin], targetPage.origin))) {
    errors.push('/write/readVerification/definition must target a READ candidate or a page path template on the origin of the page of the write');
  }
  // T40R-fix-B（I-2 (a)）: `{id}` の型の照合の READ は、生成した値と比べる期待を 1 つ以上持つ（保存の確かめと同じ `hasGeneratedValueExpectation`）。
  // T40R2-fix（M-1）: 比べる値は、送る値（生成した値。null を除く）のどれか（書き写した文字ではない）。実行のたびに変わる欄かは、入力の規則を読める
  // 許可の発行で確かめる（IPC は規則を持たない）。
  const generatedValues = new Set(Object.values(write.values).filter((value): value is string => value !== null));
  if (definition.targetPagePath !== undefined && !hasGeneratedValueExpectation(definition.expectations, (expectation) =>
    generatedValues.has(expectation.kind === 'TEXT_CONTAINS' ? expectation.text : expectation.kind === 'DETAIL_FIELD_EQUALS' ? expectation.value : ''))) {
    errors.push('/write/readVerification/definition must have an expectation compared with a generated value (a page path template READ)');
  }
  return errors;
};

/** T41b: API の更新の要求の method。 */
const API_UPDATE_METHOD = 'PATCH';

/**
 * 送り方 API の更新の書き込みの指定の、スキーマで書けない規則の誤り（T41b。Task 41 の設計書 3.2、8 章の設計者の判断 (2)）: API の指定が更新のもの
 * （PATCH、filter の名前と台帳の参照と画面の path を型にした識別の digest と保つ鍵がある）、保つ鍵が変える鍵ともページが決める鍵とも重ならず 1 回ずつ、
 * ページが決める鍵はどれも欄の識別を持つ、変える鍵の値はどれも新しい値（null でない）、書き込みの画面は台帳の画面の path の型に対象の ID を入れた具体的な
 * path。対象の ID の形はスキーマで確かめる（form の UPDATE の指定と同じ定義）。誤りの文に値と名前を入れない。
 */
const apiWriteUpdateRuleErrors = (write: WorkerStartApiWrite, update: WorkerStartApiWriteUpdate): readonly string[] => {
  const errors: string[] = [];
  const { api } = write;
  const { keptKeys, templatedIdentityDigest, ledger } = api;
  if (api.request.method !== API_UPDATE_METHOD || api.filterName === null || ledger === null || keptKeys === undefined
    || templatedIdentityDigest === undefined || !isSha256Fingerprint(templatedIdentityDigest)) {
    errors.push(`/write/api must be the spec of an UPDATE (${API_UPDATE_METHOD}, a filter, a ledger, the kept keys and the templated identity digest)`);
  }
  const changed = new Set(api.keyFields.map(({ key }) => key));
  const pageKeys = new Set(api.pageKeys.map(({ key }) => key));
  const kept = (keptKeys ?? []).map(({ key }) => key);
  if (new Set(kept).size !== kept.length || kept.some((key) => changed.has(key) || pageKeys.has(key))) {
    errors.push('/write/api/keptKeys must be keys of the fields, each once, that are not changed and not decided by the page');
  }
  if (api.pageKeys.some(({ field }) => field === undefined)) {
    errors.push('/write/api/pageKeys of an UPDATE must have the field identity');
  }
  if (Object.values(write.values).some((value) => value === null)) {
    errors.push('/write/values of an UPDATE must have a new value for each changed key');
  }
  if (ledger === null || concretePathOfTemplate(ledger.formPathTemplate, update.targetRecordId) !== write.formPage.path) {
    errors.push('/write/formPage/path must be the form path template of the ledger with the target record id');
  }
  // T41R3-fix-B: 最後に分かっている保つ鍵の値の鍵は、保つ鍵の一部で 1 回ずつ（件数・値の長さ・形はスキーマで確かめる）。誤りの文に値と名前を入れない。
  const keptSet = new Set(kept);
  const knownKeys = update.knownKeptValues.map(({ key }) => key);
  if (new Set(knownKeys).size !== knownKeys.length || knownKeys.some((key) => !keptSet.has(key))) {
    errors.push('/write/update/knownKeptValues must be kept keys of the API spec, each once');
  }
  return errors;
};

/** path の区切り（`/` で分けた並び）。 */
const PATH_SEPARATOR = '/';

/** 型に対象の ID を入れた具体的な path か（T31f。ID を 1 つの区切りとして含み、型の印を含まない）。 */
const isConcretePathOf = (path: string, targetRecordId: string): boolean =>
  !path.includes(PATH_TEMPLATE_ID_SEGMENT) && path.split(PATH_SEPARATOR).includes(targetRecordId);

/**
 * `START` の UPDATE の指定の、スキーマで書けない規則の誤り（T31f）: 型にした識別の digest の形、変える欄が送る値の名前と同じ集まり（重なりなし。
 * 新しい値は送る値。null（送らない）は持てない）、保つ欄が変える欄と重ならない候補の欄で `_method` でないこと、画面の path と送信先の path が型に
 * 対象の ID を入れた具体的な path であること。対象の ID の形（登録の ID として使える形）はスキーマで確かめる。誤りの文に値と名前を入れない。
 */
const writeUpdateRuleErrors = (write: WorkerStartWrite, update: WorkerStartWriteUpdate): readonly string[] => {
  const errors: string[] = [];
  if (!isSha256Fingerprint(update.templatedIdentityDigest)) {
    errors.push('/write/update/templatedIdentityDigest must be the templated identity digest of a candidate');
  }
  const changed = new Set(update.changedFieldNames);
  const valueNames = Object.keys(write.values);
  if (changed.size !== update.changedFieldNames.length || changed.size !== valueNames.length
    || valueNames.some((name) => !changed.has(name) || write.values[name] === null)) {
    errors.push('/write/update/changedFieldNames must be the names of the values, each with a new value to send');
  }
  const candidateNames = new Set(write.candidateFields.map(({ name }) => name));
  if (new Set(update.keptFieldNames).size !== update.keptFieldNames.length
    || update.keptFieldNames.some((name) => changed.has(name) || !candidateNames.has(name) || isMethodOverrideFieldName(name))) {
    errors.push('/write/update/keptFieldNames must be fields of the candidate that are not changed and not the method override field');
  }
  if (!isConcretePathOf(write.formPage.path, update.targetRecordId) || !isConcretePathOf(write.request.path, update.targetRecordId)) {
    errors.push('/write/formPage/path and /write/request/path must be the concrete paths of the target record');
  }
  return errors;
};

/** `START` の定義の一覧（`/readChecks`）の位置の区切りの並び。 */
const READ_CHECKS_POINTER_SEGMENTS: readonly string[] = Object.freeze(['readChecks']);

/** `START` の書き込みの指定の照合の READ（`/write/readVerification`）の位置の区切りの並び。 */
const WRITE_READ_VERIFICATION_POINTER_SEGMENTS: readonly string[] = Object.freeze(['write', 'readVerification']);

/**
 * READ の確かめの定義 1 件の、スキーマで書けない規則の誤り（T27e。CCX-29 で位置を引数にした）: 定義の ID の形と重複、対象の画面の Origin が
 * http(s) の Origin の正規の直列化で path が `/` から始まること、送る値に秘密に見える名前がないこと（fail-closed）。誤りの文に値と名前を入れない
 * （位置だけ）。`at` は定義の位置の区切りの並び（定義の一覧の何番目か、書き込みの指定の照合の READ か）。`duplicate` は、一覧の前の定義と ID が
 * 重なるか。位置の組み立ては `src/core/json-pointer.ts` の `jsonPointerOf` が行う。
 */
const readCheckItemRuleErrors = (
  at: readonly string[],
  { readCheckId, targetPage, definition }: WorkerStartReadCheck,
  duplicate: boolean,
): readonly string[] => {
  const errors: string[] = [];
  const pointerOf = (...segments: readonly string[]): string => jsonPointerOf([...at, ...segments]);
  if (!WORKER_JOB_ID_PATTERN.test(readCheckId)) {
    errors.push(`${pointerOf('readCheckId')} must match ${WORKER_JOB_ID_PATTERN.source}`);
  }
  if (duplicate) {
    errors.push(`${pointerOf('readCheckId')} must be unique`);
  }
  if (targetPage !== null) {
    const { origin, path } = targetPage;
    if (canonicalHttpOriginOf(origin) !== origin || !path.startsWith('/')) {
      errors.push(`${pointerOf('targetPage')} must be the canonical origin of an http(s) page and an absolute path`);
    }
  }
  // T37d（Task 37 の設計書 3.5）: 画面の path の定義の対象の画面は、親がプロファイルの開始の URL の Origin と、その path で必ず入れる。
  if (definition.targetPagePath !== undefined && targetPage?.path !== definition.targetPagePath) {
    errors.push(`${pointerOf('targetPage')} must be the page of the page path of the definition`);
  }
  Object.keys(definition.parameters).forEach((name, parameterIndex) => {
    if (isSecretUrlQueryParameterName(name)) {
      errors.push(`${pointerOf('definition', 'parameters')} (parameter ${parameterIndex}) looks like a secret and is never sent`);
    }
  });
  return errors;
};

/** `START` の定義の一覧の、スキーマで書けない規則の誤り（T27e）。定義ごとの規則は `readCheckItemRuleErrors`、ID の重複は一覧の順で見る。 */
const readCheckRuleErrors = (readChecks: readonly WorkerStartReadCheck[]): readonly string[] => {
  const seen = new Set<string>();
  return readChecks.flatMap((readCheck, index) => {
    const duplicate = seen.has(readCheck.readCheckId);
    seen.add(readCheck.readCheckId);
    return readCheckItemRuleErrors([...READ_CHECKS_POINTER_SEGMENTS, String(index)], readCheck, duplicate);
  });
};

/** 資格情報のフォルダを決める根として受けるか（T26d-2。絶対パスで、パスの最大長以下で、制御文字・対になっていないサロゲートを含まない）。 */
const isCredentialRoot = (value: string): boolean =>
  value.length > 0 && isCleanText(value, MAX_WORKER_MESSAGE_PATH_LENGTH) && isAbsolute(value);

/** URL の Origin（解析できなければ `undefined`）。 */
const originOf = (value: string): string | undefined => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

/**
 * `START` の `authentication` のサービスの Origin の規則の誤り（T34a）: `approvedServiceOrigins` が正規の直列化で `approvedTestOrigins` と
 * 重ならないこと。版 3 の設定では、スクリプトの送信先の Origin が `approvedServiceOrigins` に、ログインに伴う送信の Origin が
 * `approvedTestOrigins` か `approvedServiceOrigins` に、成功のローカル ストレージの鍵の Origin が `approvedTestOrigins` に含まれること。
 * 誤りの文に値を入れない。
 */
const serviceOriginRuleErrors = (
  setup: AuthSetup,
  approvedTestOrigins: readonly string[],
  approvedServiceOrigins: readonly string[],
): readonly string[] => {
  const errors: string[] = [];
  approvedServiceOrigins.forEach((origin, index) => {
    if (canonicalHttpOriginOf(origin) !== origin) {
      errors.push(`/authentication/approvedServiceOrigins/${index} must be the canonical serialization of an http(s) origin`);
    } else if (isOriginInAllowedOrigins(approvedTestOrigins, origin)) {
      errors.push(`/authentication/approvedServiceOrigins/${index} must not be in approvedTestOrigins`);
    }
  });
  // PRE42-CC 組 UI-K3（CC-114）: 認証の設定は版 3 だけ（スキーマが確かめる）なので、いつも真だった版の確かめを消した。
  const isIn = (origins: readonly string[], origin: string): boolean => {
    const canonical = canonicalHttpOriginOf(origin);
    return canonical !== undefined && isOriginInAllowedOrigins(origins, canonical);
  };
  if (setup.scriptLogin !== null && !isIn(approvedServiceOrigins, setup.scriptLogin.origin)) {
    errors.push('/authentication/setup/scriptLogin/origin must be in approvedServiceOrigins');
  }
  setup.loginSideRequests.forEach((sideRequest, index) => {
    if (!isIn([...approvedTestOrigins, ...approvedServiceOrigins], sideRequest.origin)) {
      errors.push(`/authentication/setup/loginSideRequests/${index}/origin must be in approvedTestOrigins or approvedServiceOrigins`);
    }
  });
  // T35a（Task 35 の設計書 3.1）: 監査の段の読み取りの手続きの呼び出しの Origin も、承認したテストの Origin かサービスの Origin。
  (setup.auditReadRequests ?? []).forEach((read, index) => {
    if (!isIn([...approvedTestOrigins, ...approvedServiceOrigins], read.origin)) {
      errors.push(`/authentication/setup/auditReadRequests/${index}/origin must be in approvedTestOrigins or approvedServiceOrigins`);
    }
  });
  if (setup.successStorageKey !== null && !isIn(approvedTestOrigins, setup.successStorageKey.origin)) {
    errors.push('/authentication/setup/successStorageKey/origin must be in approvedTestOrigins');
  }
  return errors;
};

/**
 * `START` の `authentication` の、スキーマで書けない規則の誤り（T25d）: SHA-256 の形、`approvedTestOrigins` が HTTP(S) の Origin の正規の
 * 直列化であること、認証の設定のログインの画面と送信先の Origin が `approvedTestOrigins` に含まれること。誤りの文に値を入れない。
 * T34a: サービスの Origin の規則（`serviceOriginRuleErrors`）も確かめる。
 */
const authenticationRuleErrors = (authentication: WorkerStartAuthentication): readonly string[] => {
  const errors: string[] = [];
  const { setup, approvedTestOrigins, authenticationSha256 } = authentication;
  if (!WORKER_AUTHENTICATION_SHA256_PATTERN.test(authenticationSha256)) {
    errors.push(`/authentication/authenticationSha256 must match ${WORKER_AUTHENTICATION_SHA256_PATTERN.source}`);
  }
  approvedTestOrigins.forEach((origin, index) => {
    if (canonicalHttpOriginOf(origin) !== origin) {
      errors.push(`/authentication/approvedTestOrigins/${index} must be the canonical serialization of an http(s) origin`);
    }
  });
  const isApproved = (origin: string | undefined): boolean =>
    origin !== undefined && isOriginInAllowedOrigins(approvedTestOrigins, origin);
  if (!isApproved(originOf(setup.loginStartUrl))) {
    errors.push('/authentication/setup/loginStartUrl must be on an origin in approvedTestOrigins');
  }
  setup.loginPostEndpoints.forEach((endpoint, index) => {
    if (!isApproved(canonicalHttpOriginOf(endpoint.origin))) {
      errors.push(`/authentication/setup/loginPostEndpoints/${index}/origin must be in approvedTestOrigins`);
    }
  });
  errors.push(...serviceOriginRuleErrors(setup, approvedTestOrigins, authentication.approvedServiceOrigins ?? []));
  // T26d-2: 自動ログインの指定は、自動ログインの設定のときだけ、必ず持つ（手動のログインの設定に付けない。自動ログインの設定で欠かさない）。
  const { automatedLogin } = authentication;
  if ((setup.automatedLogin !== null) !== (automatedLogin !== undefined)) {
    errors.push('/authentication/automatedLogin must be present exactly when the setup has the automated login settings');
  }
  if (automatedLogin !== undefined) {
    if (!Number.isSafeInteger(automatedLogin.credentialRevision) || automatedLogin.credentialRevision < MIN_WORKER_CREDENTIAL_REVISION) {
      errors.push('/authentication/automatedLogin/credentialRevision must be a credential revision');
    }
    if (!isCredentialRoot(automatedLogin.credentialRoot)) {
      errors.push('/authentication/automatedLogin/credentialRoot must be a clean absolute path');
    }
  }
  return errors;
};

/**
 * `AUTH_STATE` の自動ログインの結果の、スキーマで書けない規則の誤り（T26d-2）: 結果を持てる状態、`AUTOMATED_LOGIN_FAILED` は成功以外の結果を
 * 必ず持つ、ほかの状態は成功の結果だけ、成功は送信 `YES` だけ、`Retry-After` の期限は 429 のときだけ（14 桁）、理由のコードはフォームの
 * 確かめのときだけ。
 */
const automatedLoginReportErrors = (state: WorkerAuthState, report: WorkerAutomatedLoginReport | undefined): readonly string[] => {
  if (report === undefined) {
    return state === WORKER_AUTOMATED_LOGIN_FAILED_STATE ? [`/automatedLogin is required for ${WORKER_AUTOMATED_LOGIN_FAILED_STATE}`] : [];
  }
  const errors: string[] = [];
  const succeeded = report.result === AUTOMATED_LOGIN_SUCCEEDED;
  if (!AUTH_STATES_WITH_AUTOMATED_LOGIN.has(state) || (state === WORKER_AUTOMATED_LOGIN_FAILED_STATE) === succeeded) {
    errors.push(`/automatedLogin/result ${report.result} does not match the state ${state}`);
  }
  if (succeeded && report.submitted !== AUTOMATED_LOGIN_SUBMISSION_SENT) {
    errors.push(`/automatedLogin/submitted must be ${AUTOMATED_LOGIN_SUBMISSION_SENT} for ${AUTOMATED_LOGIN_SUCCEEDED}`);
  }
  if ((report.result === AUTOMATED_LOGIN_RATE_LIMITED_RESULT) !== (report.retryAfterUntil !== null)) {
    errors.push(`/automatedLogin/retryAfterUntil must be a time only for ${AUTOMATED_LOGIN_RATE_LIMITED_RESULT}`);
  }
  if (report.retryAfterUntil !== null && !isCompactUtcTimestamp(report.retryAfterUntil)) {
    errors.push('/automatedLogin/retryAfterUntil must be a compact UTC timestamp');
  }
  if ((report.result === WORKER_LOGIN_FORM_INVALID_RESULT) !== (report.formInvalidReason !== null)) {
    errors.push(`/automatedLogin/formInvalidReason must be a reason code only for ${WORKER_LOGIN_FORM_INVALID_RESULT}`);
  }
  // DEF-099 fix round 1: 応答の印は、送った回だけ。成功は応答のあった回だけ。
  if (report.responseAfterSubmission !== undefined && report.submitted !== AUTOMATED_LOGIN_SUBMISSION_SENT) {
    errors.push(`/automatedLogin/responseAfterSubmission is only for a submission ${AUTOMATED_LOGIN_SUBMISSION_SENT}`);
  }
  if (succeeded && report.responseAfterSubmission === false) {
    errors.push(`/automatedLogin/responseAfterSubmission must not be false for ${AUTOMATED_LOGIN_SUCCEEDED}`);
  }
  return errors;
};

/** 子 → 親のメッセージの、スキーマで書けない規則の誤り（形は確かめ済み）。 */
const workerRuleErrors = (message: WorkerToParentMessage): readonly string[] => {
  switch (message.type) {
    case 'RUN_STARTED': {
      const errors: string[] = [];
      if (!isRunId(message.runId)) {
        errors.push('/runId must be a run id');
      }
      if (!isRunDirectoryPath(message.runDirectory)) {
        errors.push('/runDirectory must be a portable relative path in the output directory');
      }
      const { kind, completedPages } = message.resumeDecision;
      if ((kind === RESUME_DECISION_WITH_COMPLETED_PAGES) !== (completedPages !== null)) {
        errors.push(`/resumeDecision/completedPages must be a count only for ${RESUME_DECISION_WITH_COMPLETED_PAGES}`);
      }
      return errors;
    }
    case 'NOTICE':
      return message.notice.kind === 'SITE_UNAVAILABLE_RECHECK' && !isCleanText(message.notice.url, MAX_WORKER_NOTICE_URL_LENGTH)
        ? ['/notice/url must not contain control characters or lone surrogates']
        : [];
    case 'AUTH_STATE': {
      const { state, sessionLostUrl } = message;
      if ((state === WORKER_SESSION_LOST_STATE) !== (sessionLostUrl !== null)) {
        return [`/sessionLostUrl must be a URL only for ${WORKER_SESSION_LOST_STATE}`];
      }
      if (sessionLostUrl !== null && !isCleanText(sessionLostUrl, MAX_WORKER_NOTICE_URL_LENGTH)) {
        return ['/sessionLostUrl must not contain control characters or lone surrogates'];
      }
      // DEF-138: セッションの切れの証拠は、`SESSION_LOST` だけが持てる。
      if (message.sessionLoss !== undefined) {
        if (state !== WORKER_SESSION_LOST_STATE) {
          return [`/sessionLoss is only for ${WORKER_SESSION_LOST_STATE}`];
        }
        const errors = sessionLossErrors(message.sessionLoss, '/sessionLoss');
        if (errors.length > 0) {
          return errors;
        }
      }
      // T34c: スクリプトで送るログインの段の数は、ログインの段の結果だけが持てる。T36c: 自動ログインの段の結果も持てる（`mayCarryLoginStageCounts`）。
      if (message.scriptLogin !== undefined && !mayCarryLoginStageCounts(state, message.automatedLogin)) {
        return ['/scriptLogin is only for the result of the login stage'];
      }
      // T34e: 止めた要求の一覧も、ログインの段の結果だけが持てる（T36c: 自動ログインの段の結果を含む）。
      if (message.blockedRequests !== undefined) {
        if (!mayCarryLoginStageCounts(state, message.automatedLogin)) {
          return ['/blockedRequests is only for the result of the login stage'];
        }
        const errors = blockedRequestsErrors(message.blockedRequests);
        if (errors.length > 0) {
          return errors;
        }
        // ML-a-fix: 「token の送信より前」の印は、通した一覧の行だけが持つ。
        if (message.blockedRequests.requests.some(({ beforeToken }) => beforeToken !== undefined)) {
          return ['/blockedRequests/requests must not carry beforeToken'];
        }
      }
      // ML-a: 手動のログインの段で通した要求の一覧も、ログインの段の結果だけが持てる（止めた一覧と同じ規則）。
      if (message.passedRequests !== undefined) {
        if (!mayCarryLoginStageCounts(state, message.automatedLogin)) {
          return ['/passedRequests is only for the result of the login stage'];
        }
        const errors = blockedRequestsErrors(message.passedRequests, '/passedRequests');
        if (errors.length > 0) {
          return errors;
        }
      }
      // T43d: ログインの段で観察したことも、ログインの段の結果だけが持てる。
      if (message.loginObservation !== undefined) {
        if (!mayCarryLoginStageCounts(state, message.automatedLogin)) {
          return ['/loginObservation is only for the result of the login stage'];
        }
        const errors = loginObservationErrors(message.loginObservation);
        if (errors.length > 0) {
          return errors;
        }
        // FM2e: ログインの欄の案は、手動のログインの成功だけが持てる（自動ログインの段は検出しない）。
        if (message.loginObservation.loginFields !== undefined && (state !== 'AUTHENTICATED' || message.automatedLogin !== undefined)) {
          return ['/loginObservation/loginFields is only for the success of the manual login stage'];
        }
      }
      // DEF-139: 状態の名前の記録も、ログインの段の結果だけが持てる。
      if (message.loginStateNames !== undefined) {
        if (!mayCarryLoginStageCounts(state, message.automatedLogin)) {
          return ['/loginStateNames is only for the result of the login stage'];
        }
        const errors = loginStateNamesErrors(message.loginStateNames);
        if (errors.length > 0) {
          return errors;
        }
      }
      return automatedLoginReportErrors(state, message.automatedLogin);
    }
    case 'FINISHED': {
      const { kind, runId, runDirectory, runStatus } = message.outcome;
      const errors: string[] = [];
      if (runId === null ? !OUTCOME_KINDS_WITH_OPTIONAL_RUN_ID.has(kind) : !isRunId(runId)) {
        errors.push(`/outcome/runId must be a run id for the outcome kind ${kind}`);
      }
      if (OUTCOME_KINDS_WITHOUT_RUN_DIRECTORY.has(kind) ? runDirectory !== null : !isRunDirectoryPath(runDirectory)) {
        errors.push(`/outcome/runDirectory does not match the outcome kind ${kind}`);
      }
      if (OUTCOME_KINDS_WITH_RUN_STATUS.has(kind) === (runStatus === null)) {
        errors.push(`/outcome/runStatus does not match the outcome kind ${kind}`);
      }
      // T27d: 発見の件数の要約は、Run を実行した結果だけ。
      if (message.discovery !== undefined && kind !== OUTCOME_KIND_WITH_DISCOVERY_SUMMARY) {
        errors.push(`/discovery is allowed only for the outcome kind ${OUTCOME_KIND_WITH_DISCOVERY_SUMMARY}`);
      }
      // T27e: READ の確かめの件数の要約も、Run を実行した結果だけ。発見の件数の要約と同時には持たない。確かめた数は定義の数以下。
      if (message.readCheck !== undefined) {
        if (kind !== OUTCOME_KIND_WITH_DISCOVERY_SUMMARY || message.discovery !== undefined) {
          errors.push(`/readCheck is allowed only for the outcome kind ${OUTCOME_KIND_WITH_DISCOVERY_SUMMARY} without /discovery`);
        }
        if (message.readCheck.executed > message.readCheck.checks) {
          errors.push('/readCheck/executed must not be more than /readCheck/checks');
        }
      }
      // T43c: 入口の確かめの件数の要約も、Run を実行した結果だけ。ほかの要約と同時には持たない。案のセレクタの数は欄の数まで。
      if (message.entryCheck !== undefined) {
        if (kind !== OUTCOME_KIND_WITH_DISCOVERY_SUMMARY || message.discovery !== undefined || message.readCheck !== undefined) {
          errors.push(`/entryCheck is allowed only for the outcome kind ${OUTCOME_KIND_WITH_DISCOVERY_SUMMARY} without another summary`);
        }
        if (message.entryCheck.proposedSelectors > ENTRY_CHECK_FIELDS.length) {
          errors.push('/entryCheck/proposedSelectors must not be more than the number of the fields');
        }
      }
      // FM2d: まとめて実行の段の未完了の理由のコードも、Run を実行した結果だけ（重なりはスキーマが拒む）。
      if (message.incompleteReasonCodes !== undefined && kind !== OUTCOME_KIND_WITH_DISCOVERY_SUMMARY) {
        errors.push(`/incompleteReasonCodes is allowed only for the outcome kind ${OUTCOME_KIND_WITH_DISCOVERY_SUMMARY}`);
      }
      return errors;
    }
    case 'FAILED':
      return isCleanText(message.detail, MAX_WORKER_FAILURE_DETAIL_LENGTH)
        ? []
        : ['/detail must not contain control characters, line breaks or lone surrogates'];
    case 'WRITE_SUBMISSION':
      // T30e: `NOT_SENT` だけが止めた理由を持つ。
      return (message.submission === 'NOT_SENT') === (message.blockReason !== null)
        ? []
        : ['/blockReason must be a reason exactly when the submission is NOT_SENT'];
    case 'READY':
    case 'PROGRESS':
    case 'HEARTBEAT':
    case 'RUN_FINALIZING':
    case 'WRITE_RECHECK_REQUEST':
      return [];
  }
};

/**
 * 親 → 子のメッセージ（`START`、`STOP`）を検証する（ワーカーが使う）。子 → 親の種類、形の違う値、受けないターゲット JSON のパス、
 * 写せない値は拒否する。受けるときは、深く凍結した写しを返す。例外を投げない。
 */
export const validateParentToWorkerMessage = (value: unknown): WorkerMessageValidation<ParentToWorkerMessage> => {
  const shape = shapeOf(value);
  if ('errors' in shape) {
    return rejected(shape.errors);
  }
  if (!PARENT_TYPES.has(String(shape.copy.type))) {
    return rejected([`/type ${String(shape.copy.type)} is not a message from the parent`]);
  }
  const message = shape.copy as unknown as ParentToWorkerMessage;
  const errors = parentRuleErrors(message);
  return errors.length > 0 ? rejected(errors) : accepted(message);
};

/**
 * 子 → 親のメッセージを検証する（画面のサーバのジョブの管理と、送る前のワーカーが使う）。親 → 子の種類、形の違う値、受けない Run の
 * ディレクトリ、項目どうしの組み合わせの誤り、写せない値は拒否する。受けるときは、深く凍結した写しを返す。例外を投げない。
 */
export const validateWorkerToParentMessage = (value: unknown): WorkerMessageValidation<WorkerToParentMessage> => {
  const shape = shapeOf(value);
  if ('errors' in shape) {
    return rejected(shape.errors);
  }
  if (!WORKER_TYPES.has(String(shape.copy.type))) {
    return rejected([`/type ${String(shape.copy.type)} is not a message from the worker`]);
  }
  const message = shape.copy as unknown as WorkerToParentMessage;
  const errors = workerRuleErrors(message);
  return errors.length > 0 ? rejected(errors) : accepted(message);
};

/**
 * `FAILED` の詳細を作る: 制御文字と行・段落の区切りを空白にし、`MAX_WORKER_FAILURE_DETAIL_LENGTH` で切り、対になっていないサロゲート（切った後に
 * 残るものを含む）を U+FFFD にする。結果は、`FAILED` の詳細の規則を満たす。PRE42-CC の組 2: 切って U+FFFD にする形は `src/core/text.ts` の
 * `truncateWellFormed`（U+FFFD への置き換えは長さを変えないので、切る前の置き換えは要らない。結果は前と同じ）。
 */
export const toWorkerFailureDetail = (text: string): string =>
  truncateWellFormed(replaceControlOrLineSeparators(text, FORBIDDEN_TEXT_REPLACEMENT), MAX_WORKER_FAILURE_DETAIL_LENGTH);

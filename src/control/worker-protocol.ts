// 画面のサーバ（親）と監査のワーカー（子）の IPC の契約の唯一の owner（Task 24 の設計書 4.3、5 章。T24d）。
// - 版つき（`WORKER_PROTOCOL_VERSION`）。親 → 子: `START`、`STOP`。子 → 親: `READY`、`RUN_STARTED`、`PROGRESS`、`NOTICE`、`AUTH_STATE`、
//   `HEARTBEAT`、`FINISHED`、`FAILED`。
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
import { RUN_STATUSES, type RunId, type RunProgressReport, type RunStatus } from '../core/contracts.js';
import { isRunId, isSha256Fingerprint, sha256HexOfBytes, sha256HexOfText } from '../core/ids.js';
import { deepFreeze } from '../core/immutable.js';
import { jsonPointerOf } from '../core/json-pointer.js';
import { MAX_URL_LENGTH } from '../core/limits.js';
import { isSecretUrlQueryParameterName } from '../core/secret-query-names.js';
import { sortedKeysJsonOf } from '../core/sorted-keys-json.js';
import { hasControlOrLineSeparator, hasLoneSurrogate, replaceControlOrLineSeparators } from '../core/text.js';
import { isCompactUtcTimestamp } from '../core/utc-timestamp.js';
import { canonicalHttpOriginOf, isOriginInAllowedOrigins } from '../crawl/normalize-url.js';
import { isMethodOverrideFieldName, type CandidateField, type CandidateFieldType, type CandidateLocation } from '../discovery/candidate-contracts.js';
import { PATH_TEMPLATE_ID_SEGMENT } from '../discovery/fingerprint.js';
import { MAX_READ_CHECKS_PER_JOB, isSendableField, type ReadCheckDefinition } from '../discovery/read-check-contracts.js';
import {
  ACTION_BLOCK_REASONS,
  SUBMISSION_STATES,
  type ActionBlockReason,
  type ApprovalSummaryFacts,
  type SubmissionState,
} from './actions/action-contracts.js';
import type { ScenarioKind, ScenarioRecordIdSpec, ScenarioRequestShape, ScenarioResultCondition } from './approval/scenario-contracts.js';
import type { AuthSetup } from './auth/auth-setup-contracts.js';
import type { SeedRecord } from './data-rules/scenario-data.js';
import {
  AUTOMATED_LOGIN_FAILURE_RESULTS,
  AUTOMATED_LOGIN_RATE_LIMITED_RESULT,
  AUTOMATED_LOGIN_SUBMISSION_SENT,
  AUTOMATED_LOGIN_SUCCEEDED,
  type AutomatedLoginResult,
  type AutomatedLoginSubmission,
} from './auth/automated-login-results.js';
import { MIN_PROFILE_REVISION } from './contracts.js';
import { validateControlDocument } from './control-schema-validator.js';
import { isAcceptedTargetConfigPath } from './profile-policy.js';

// ---------------------------------------------------------------------------------------------------------------
// 値の一覧と上限
// ---------------------------------------------------------------------------------------------------------------

/** IPC のメッセージの版。スキーマの `$defs/protocol` の const と一致する。 */
export const WORKER_PROTOCOL_VERSION = 'beaksight-worker-message/2';

/** 親（画面のサーバ）から子（ワーカー）へのメッセージの種類。 */
export const PARENT_TO_WORKER_MESSAGE_TYPES = Object.freeze(['START', 'STOP', 'WRITE_RECHECK_RESULT'] as const);
export type ParentToWorkerMessageType = (typeof PARENT_TO_WORKER_MESSAGE_TYPES)[number];

/** 子（ワーカー）から親（画面のサーバ）へのメッセージの種類。 */
export const WORKER_TO_PARENT_MESSAGE_TYPES = Object.freeze([
  'READY',
  'RUN_STARTED',
  'PROGRESS',
  'NOTICE',
  'AUTH_STATE',
  'HEARTBEAT',
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
export const WORKER_NOTICE_KINDS = Object.freeze(['SITE_UNAVAILABLE_RECHECK', 'SITE_UNAVAILABLE_SLOWDOWN'] as const);
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
 * 値は後ろに足すだけにする（管理データの公開済みの版の CHECK は、公開した時点の写しで固定している。`migrations.ts`）。ワーカーがまだ対応して
 * いない種類の `START` は、ワーカーが `FAILED`（`JOB_KIND_NOT_SUPPORTED`）で拒む（監査として扱わない。T27c）。
 */
export const WORKER_JOB_KINDS = Object.freeze(['AUDIT', 'LOGIN_CHECK', 'DISCOVERY', 'READ_CHECK', 'WRITE_CREATE', 'WRITE_UPDATE'] as const);
export type WorkerJobKind = (typeof WORKER_JOB_KINDS)[number];

/** ログインの検証のジョブの種類。 */
export const WORKER_LOGIN_CHECK_JOB_KIND = 'LOGIN_CHECK' satisfies WorkerJobKind;

/** 操作の候補の発見のジョブの種類（T27d。認証つきの `START` だけ）。 */
export const WORKER_DISCOVERY_JOB_KIND = 'DISCOVERY' satisfies WorkerJobKind;

/** READ の確かめのジョブの種類（T27e。認証つきで、定義の一覧を持つ `START` だけ）。 */
export const WORKER_READ_CHECK_JOB_KIND = 'READ_CHECK' satisfies WorkerJobKind;

/** 書き込みのジョブの種類（T30e。認証つきで、書き込みの指定を持つ `START` だけ）。 */
export const WORKER_WRITE_CREATE_JOB_KIND = 'WRITE_CREATE' satisfies WorkerJobKind;

/** 更新の書き込みのジョブの種類（T31f。認証つきで、UPDATE の指定（`write.update`）を持つ書き込みの指定を持つ `START` だけ。ワーカーの流れは T31g-2）。 */
export const WORKER_WRITE_UPDATE_JOB_KIND = 'WRITE_UPDATE' satisfies WorkerJobKind;

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
 */
export const WORKER_AUTH_STATES = Object.freeze([
  'AWAITING_LOGIN',
  'AUTHENTICATED',
  'AUTH_SETUP_REQUIRED',
  'UNSUPPORTED_AUTH_STATE',
  'SESSION_LOST',
  'LOGIN_TIMEOUT',
  'LOGIN_ATTEMPTS_EXCEEDED',
  'AUTOMATED_LOGIN_FAILED',
] as const);
export type WorkerAuthState = (typeof WORKER_AUTH_STATES)[number];

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

// 鍵を並べた JSON（同じ内容の文書から、同じ JSON の文字列を作る）は、`src/core/sorted-keys-json.ts` の `sortedKeysJsonOf` に移した（CC-078。CCX-12）。

/**
 * `START` の SHA-256 に含める、認証の設定の外の項目（T26d-2）: ジョブの種類と、自動ログインの指定（手動のログインでは `null`）。
 */
export interface WorkerAuthenticationBinding {
  readonly jobKind: WorkerJobKind;
  readonly automatedLogin: WorkerStartAutomatedLogin | null;
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
  }));

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
  /** 書き込みの指定（`WRITE_CREATE` と、T31f から `WRITE_UPDATE` のときだけ、必ず持つ。T30e）。 */
  readonly write?: WorkerStartWrite;
}

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
 */
export interface WorkerStartAuthentication {
  readonly setup: AuthSetup;
  readonly approvedTestOrigins: readonly string[];
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

export type ParentToWorkerMessage = WorkerStartMessage | WorkerStopMessage | WorkerWriteRecheckResultMessage;

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
  | { readonly kind: Extract<WorkerNoticeKind, 'SITE_UNAVAILABLE_SLOWDOWN'>; readonly minIntervalMs: number };

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
}

/** READ の確かめのジョブの件数の要約（`src/discovery/read-check-evaluation.ts` の `ReadEvidenceSummary` と同じ形。T27e）。 */
export interface WorkerReadCheckSummary {
  /** 定義の数。 */
  readonly checks: number;
  /** 確かめた定義の数。 */
  readonly executed: number;
}

/** 発見のジョブの件数の要約（`src/discovery/discovery-result.ts` の `DiscoverySummary` と同じ形。T27d）。値・URL を持たない。 */
export interface WorkerDiscoverySummary {
  readonly pagesRead: number;
  readonly pagesNotRead: number;
  readonly candidates: number;
}

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
const isCleanText = (value: string, maxLength: number): boolean =>
  value.length <= maxLength && !hasLoneSurrogate(value) && !hasControlOrLineSeparator(value);

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
  // T26d-2: ログインの検証は、自動ログインの指定を必ず持つ（手動のログインと公開の監査では行わない）。
  if (message.jobKind === WORKER_LOGIN_CHECK_JOB_KIND && message.authentication?.automatedLogin === undefined) {
    errors.push(`/authentication/automatedLogin is required for ${WORKER_LOGIN_CHECK_JOB_KIND}`);
  }
  // T27d: 発見のジョブは、認証つき（`TEST_AUTH_PASSIVE` と、T28b から `TEST_APPROVED_WRITE` の認証の設定）だけ（Task 27 の設計書 3 章。fail-closed）。
  if (message.jobKind === WORKER_DISCOVERY_JOB_KIND && message.authentication === undefined) {
    errors.push(`/authentication is required for ${WORKER_DISCOVERY_JOB_KIND}`);
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
    } else if ((message.jobKind === WORKER_WRITE_UPDATE_JOB_KIND) !== (message.write.update !== undefined)) {
      errors.push(`/write/update is required for ${WORKER_WRITE_UPDATE_JOB_KIND} and allowed only for it`);
    }
  } else if (message.write !== undefined) {
    errors.push(`/write is allowed only for ${WORKER_WRITE_JOB_KINDS.join(' and ')}`);
  }
  if (message.write !== undefined) {
    errors.push(...writeRuleErrors(message.write));
  }
  return errors;
};

/** UPDATE のシナリオの種類（T32d。承認の要約の種類と、書き込みの指定の UPDATE の指定の有無を照らす）。 */
const UPDATE_SCENARIO_KIND = 'UPDATE' satisfies ScenarioKind;

/** 書き込みで送れる enctype（Task 30 の設計書 3 章の「送る中身の照合」。text/plain は送らない）。 */
const WRITE_ENCTYPES: ReadonlySet<string> = new Set(['application/x-www-form-urlencoded', 'multipart/form-data']);

/** http(s) の Origin の正規の直列化と、`/` から始まる path の場所か。 */
const isCanonicalLocation = ({ origin, path }: CandidateLocation): boolean => canonicalHttpOriginOf(origin) === origin && path.startsWith('/');

/**
 * `START` の書き込みの指定の、スキーマで書けない規則の誤り（T30e）: id と digest の形、enctype、要求の送信先と書き込みの画面の場所、送る値の欄が
 * 候補の送れる欄（送れる欄の判定は `isSendableField`。`_method` は送らない）で、秘密に見える名前でないこと、照合の READ の規則（READ の確かめの
 * 定義の一覧と同じ）。誤りの文に値と名前を入れない（位置だけ）。
 */
const writeRuleErrors = (write: WorkerStartWrite): readonly string[] => {
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
    || (approvalFacts.scenario.kind === UPDATE_SCENARIO_KIND) !== (write.update !== undefined)
  ) {
    errors.push('/write/approvalFacts must have the profile, the scenario, the revision, the grant and the kind of the write specification');
  }
  if (!isSha256Fingerprint(write.candidate.identityDigest) || !isSha256Fingerprint(write.candidate.ruleDigest)) {
    errors.push('/write/candidate must have the digests of a candidate');
  }
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
  if (write.update !== undefined) {
    errors.push(...writeUpdateRuleErrors(write, write.update));
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
 * `START` の `authentication` の、スキーマで書けない規則の誤り（T25d）: SHA-256 の形、`approvedTestOrigins` が HTTP(S) の Origin の正規の
 * 直列化であること、認証の設定のログインの画面と送信先の Origin が `approvedTestOrigins` に含まれること。誤りの文に値を入れない。
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
 * `FAILED` の詳細を作る: 制御文字と行・段落の区切りを空白にし、対になっていないサロゲートを U+FFFD にし、`MAX_WORKER_FAILURE_DETAIL_LENGTH`
 * で切る（切った後に残る、対になっていないサロゲートも U+FFFD にする）。結果は、`FAILED` の詳細の規則を満たす。
 */
export const toWorkerFailureDetail = (text: string): string =>
  replaceControlOrLineSeparators(text, FORBIDDEN_TEXT_REPLACEMENT)
    .toWellFormed()
    .slice(0, MAX_WORKER_FAILURE_DETAIL_LENGTH)
    .toWellFormed();

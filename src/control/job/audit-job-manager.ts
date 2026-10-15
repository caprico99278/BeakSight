// 監査のジョブの管理の唯一の owner（Task 24 の設計書 3 章、4.4、5 章。T24e）。画面のサーバ（T24f）の process の中に 1 つだけ作る。
//
// 開始（`startAuditJob`）:
//   1. 依頼の形を確かめる。プロファイルを読み、`ACTIVE`・改訂の一致・ジョブの種類ごとに許すモードと認証の方式（`execution-policy.ts` の閉じた一覧。T28b）を確かめる。
//      認証の設定が要るモード（`TEST_AUTH_PASSIVE`。T25d。T28b で `TEST_APPROVED_WRITE` を足した）は、保存した認証の設定が `CURRENT` であることも確かめる（なし・`STALE` は拒む）。
//      2. の後に、その設定を `validateAuthSetup` に通し直し、通った写しと許可 Origin と、その SHA-256 を `START` で渡す。`AUTH_STATE`
//      （値を含まない）は、ジョブの行に最後の認証の状態として記録する。
//   2. ターゲット JSON のパスを `isAcceptedTargetConfigPath` で確かめてから（通らなければファイルを読ませない）、呼び出し側の関数で
//      ターゲット設定を読み直し、`validateSiteProfile` を通す（I08。画面の操作は権限の十分条件ではない）。
//   3. `withWriteTransaction` の中で、プロファイルが変わっていないことを確かめ直し、終わっていないジョブがないことを確かめて、
//      `STARTING` の行を作る（同時に 1 つ。表の一意の部分索引も、最後の守りになる）。拒むときは、行を作らず、ワーカーを起動しない。
//   4. ワーカー（`dist/worker/audit-worker.js`。パスは呼び出し側が渡す）を `fork` する（IPC つき、`detached: false`、cwd はリポジトリの root、
//      標準入出力は捨てる、`execArgv` は空（画面のサーバの起動の引数（inspector など）を引き継がない））。`READY` を待って `START` を送る。
// IPC: 受けた値は、どれも `validateWorkerToParentMessage` を通してから使う。形が違う値と、順の違うメッセージ（`START` の前の `RUN_STARTED`
//   など）を受けたら、そのワーカーを信用しない（止めて、ジョブを `FAILED`（`PROTOCOL_VIOLATION`））。
// 停止（`stopAuditJob`）: `STOP` を送り `STOPPING`。強制は `STOP`（`force`）で、名前つきの時間の後も終わらなければワーカーを止める（kill）。
// 見張り: `HEARTBEAT` が名前つきの時間より長く来なければ、ワーカーを止めて `INTERRUPTED`（`WORKER_UNRESPONSIVE`）。
// ワーカーの終わり（DEF-084）: `exit` を受けたら、ジョブに「process は終わった」の印を付け、IPC が切れる（`disconnect`）か、名前つきの期限
//   （`ipcDrainWaitMs`）の早い方まで待つ（IPC がもう切れていれば待たない）。Node.js の `fork` では、混雑の下で、子が最後に送ったメッセージより
//   先に `exit` が来ることがあるため。待つ間に届いたメッセージは、今までどおり処理する。待つ間は、見張り・`READY` の期限・止める期限で、ジョブを
//   終わらせない（終わった process に `STOP` も送らない）。待ち終わって終わり方が決まっていなければ、その場で `WORKER_EXITED` に決め（以後の
//   メッセージは捨てる）、その後に結果のファイルを読んで（発見と READ の確かめ）記録する。
// 画面のサーバの起動のとき（`recoverInterruptedJobs`）と終わりのとき（`shutdownAuditJobs`）の後始末。
// 管理データの読み書きは、ジョブの行の部品（`job-store.ts`）だけを通す。ワーカーのモジュールを import しない（パスの文字列で起動するだけ）。
// 背後の処理（IPC の受け手、タイマー）の管理データの誤りは、投げずに `onBackgroundError` に渡す（画面のサーバを落とさない）。
// 管理のロック（画面のサーバを 1 つだけにする。独立レビュー T24R の C1、DEF-061。T24h-4）: `createAuditJobManager` は、管理を作る前に
//   管理データの `control_instance` の行で管理のロックを取る（`instance-lock.ts`）。動いている持ち主のロックがあれば、管理を作らずに
//   `ControlInstanceLockedError`（`CONTROL_INSTANCE_ALREADY_RUNNING`。持ち主の PID と、分かれば port）で止まり、何も書き換えない。そのため、
//   `recoverInterruptedJobs` と開始は、ロックを持つ管理だけが行う。ハートビートを名前つきの間隔で更新し（タイマーは unref）、ロックを
//   失ったら（ほかの管理が古いと判定して取り直した）新しいジョブを始めない。ジョブを作るトランザクションと中断に直すトランザクションの中でも、
//   ロックを持っていることを確かめ直す。`close()` で、自分のロックだけを消す。
// 自動ログイン（Task 26 の設計書 4.5、4.7。T26d-2）:
//   - ログインの検証（`startLoginCheck`。ジョブの種類 `LOGIN_CHECK`）と、自動ログインのプロファイルの監査（`startAuditJob`。`AUDIT`）は、監査の開始と
//     同じ確かめの後に、自動ログインの開始の前の確かめ（資格情報のメタデータ `readMetadata`、暗号化 `checkProtection`、上限の判定、
//     `checkAutoLoginStart`）を行う。上限は、ジョブを作るトランザクションの `guard` の中で `readAutoLoginLimitInputsWith` と
//     `decideAutoLoginStart` で確かめ直し、通ったら同じトランザクションで試し始めた記録を書く（`createStartingJob` の `autoLoginAttempt`）。拒むときは、
//     理由と次に始められる時刻（上限のとき）を返す。
//   - `START` に入れるのは、資格情報の改訂の番号と、資格情報のフォルダを決める根（`credentialRoot`）だけ（値・暗号文・ユーザー名を入れない）。
//   - `AUTH_STATE` の結果を `recordAutoLoginResult` で記録する（止める規則は `auto-login-store.ts`）。ログインの検証の成功は、`AUTH_STATE` で終わりを
//     決める（Run を作らないので `FINISHED` は来ない）。
//   - ジョブの終わり（どの終わり方でも）で、結果のない試しを閉じる。ワーカーを起動した後なら `closePendingAutoLoginAttempt`（送信 `UNKNOWN`。
//     止める）、ワーカーを起動できなかった（`START` を送っていない）なら送信 `NO`（POST は送られていない。止めない。round 1）。画面のサーバの起動の
//     回復（と、開始の前に、ほかの管理の終わったジョブを中断に直したとき）で `closeOrphanedAutoLoginAttempts` を呼ぶ。
//   - T30d（Task 30 の設計書 3 章の「予約の締め」）: 同じ所で、終わっていないジョブのものでない、消費済みで締めていない書き込みの予約を、
//     `closeOrphanedWriteResults`（`src/control/approval/scenario-store.ts`）で `UNKNOWN` で締める（書き込みの結果も `UNKNOWN` で記録する）。
//   - Windows だけであること: 方式としては、どの OS でも実行できる（`execution-policy.ts`）。Windows でなければ、資格情報の暗号化の確かめ
//     （`checkProtection`）が使えないを返すので、`CREDENTIAL_PROTECTION_UNAVAILABLE` で拒む（ワーカーを起動しない。round 1）。
//   - 資格情報を変えてよいかの確かめ（`checkCredentialChange`。T26e が使う）: そのプロファイルのジョブが終わっていない間は `CREDENTIAL_IN_USE`。
// 発見のジョブ（Task 27 の設計書 4.4、4.6 と、変更履歴の「T27b・T27c の報告と T27d の前の判断」「Blocker: T27d」の行。T27d）:
//   - 開始（`startDiscovery`。ジョブの種類 `DISCOVERY`）の確かめは監査と同じ（`TEST_AUTH_PASSIVE` と、T28b から `TEST_APPROVED_WRITE`。公開の監査のプロファイルは
//     `MODE_NOT_EXECUTABLE`。自動ログインなら資格情報と上限、試し始めた記録を同じトランザクションで）。発見のジョブは再開しない。
//   - `FINISHED` の件数の要約は、発見のジョブの Run を実行した結果だけが、必ず持つ（ほかは契約の違反）。
//   - ジョブの終わり（ワーカーが終わった後）に、出力先の Run のディレクトリの `discovery.json` を、リンクをたどらずに読み、成果物のスキーマ
//     （`validateArtifact`）、ジョブの ID、Run の ID、Run Status、件数の要約で確かめる。画面を読んだ Run（`COMPLETE`・`PARTIAL`）なら、同じ識別の
//     digest の候補をまとめ（`mergeDiscoveryCandidates`）、読み切れた画面の path とともに、索引を 1 つのトランザクションで更新して
//     （`recordDiscoveryCandidates`）から、ジョブを `FINISHED` にする。読めない・合わない・記録できないときは、索引を変えずに `FAILED`
//     （`DISCOVERY_RESULT_INVALID`）。読む間も、ジョブは管理の中に残る（同時に 1 つの枠を空けない）。
// READ の確かめのジョブ（Task 27 の設計書 4.5、4.6。T27e）:
//   - 開始（`startReadCheck`。ジョブの種類 `READ_CHECK`）の確かめは発見と同じ。加えて、そのプロファイルの取り消していない定義が 0 件なら
//     `READ_CHECK_DEFINITIONS_MISSING` で拒む（ターゲット設定を読む前）。`START` に、定義の一覧（`MAX_WORKER_READ_CHECKS` 件まで。定義の ID・版・
//     対象の候補の画面・定義の中身）を入れる（ワーカーは管理データを読まない）。対象の候補の画面（Origin と path）は、索引で対象の候補を最後に
//     見た発見のジョブの `discovery.json`（今のターゲット設定の出力先。スキーマで確かめる）から決める。決められなければ `null`（ワーカーは読まずに
//     `READ_CANDIDATE_DRIFTED` にする）。
//   - `FINISHED` の件数の要約（`readCheck`）は、READ の確かめのジョブの Run を実行した結果だけが、必ず持つ（ほかは契約の違反）。
//   - ジョブの終わりに、Run のディレクトリの `read-evidence.json` を、リンクをたどらずに読み、成果物のスキーマ、ジョブの ID、Run の ID、Run Status、
//     件数の要約、定義の一覧（`START` と同じ定義の ID・版・対象の識別の digest が同じ順）で確かめ、確かめた定義の結果を、1 つのトランザクションで
//     `read_check_results` に記録してから（`recordReadCheckResults`。定義の版が今の版と違う結果は、記録の部品が拒んで書かない）、ジョブを
//     `FINISHED` にする。読めない・合わない・記録できないときは、結果を記録せずに `FAILED`（`READ_CHECK_RESULT_INVALID`）。
// 書き込みのジョブ（Task 30 の設計書 3 章の「送る直前の確かめ直し」「予約の締め」「`UNKNOWN` の後」、4 章の「IPC」。T30e）:
//   - 開始（`startWriteCreate`。ジョブの種類 `WRITE_CREATE`）: 操作の行（`execution-policy.ts`）・プラットフォーム・認証の設定の確かめは発見と同じ。
//     次に実行の許可を確かめる（ある、同じシナリオとプロファイル、消費していない、無効でない、予約が `RESERVED`。外れたら `WRITE_GRANT_REJECTED`。
//     ジョブの行を作らない）。ジョブの行（同時に 1 つの枠。ジョブの id は許可に結び付けた id）を作ってから、許可を消費し（`consumeExecutionGrant`。
//     管理データの外の事実は `approvalExternalFactsOf`）、値を生成し（Task 29 の `generateScenarioData` に、生成の履歴（T31f から `readScenarioWriteGenerationHistory`）を
//     渡す）、`START` の書き込みの指定を組み立て（`write-job-start.ts`）、送る前の記録を書いて（`recordWriteAttempt`）から、ワーカーを起動する。
//     消費・生成・記録で止まれば、`closeWriteWithoutSending`（消費していない許可は無効にして予約を返し、消費済みは `BLOCKED`・`RELEASED` で締める）
//     の後に、ジョブの行を `FAILED`（`WRITE_GRANT_REJECTED`）にして拒む（`WRITE_GRANT_REJECTED`・`WRITE_DATA_NOT_GENERATED`）。予約は `RESERVED` の
//     まま残らない。
//   - IPC: `WRITE_RECHECK_REQUEST` は、書き込みのジョブの `START` の後だけ、1 回だけ。親が `assertGrantStillValid` と `approvalExternalFactsOf` を
//     求め直して `WRITE_RECHECK_RESULT` を返す。外れたら（2 回目の依頼を含む）、拒む結果を返し、`STOP` も送る（ジョブは `FAILED`
//     （`WRITE_GRANT_REJECTED`）で終わる）。`WRITE_SUBMISSION` は 1 回だけ（送った・分からないは、許した確かめ直しの後だけ。違えば契約の違反）。
//   - 終わりの締め（ジョブの終わりで必ず 1 回。ジョブを終わりの状態にする前）: `START` を送っていなければ `closeWriteWithoutSending`。
//     `action-run.json` が読めてスキーマとジョブ・許可・シナリオ・Run・送信の報告に合えば、その中身を `settleWriteResult` に渡す（判定は締めの部品が
//     決め直す）。読めない・合わない・異常終了・応答なしは、`NOT_SENT` の報告があれば `NOT_SENT`、ほかは `UNKNOWN` で締める。Run を実行した結果
//     （`RAN`）の `action-run.json` が使えなければ、ジョブは `FAILED`（`WRITE_RESULT_INVALID`）。
// 更新の書き込みのジョブ（Task 31 の設計書 3 章、4 章の「IPC」。T31f）:
//   - 開始（`startWriteUpdate`。ジョブの種類 `WRITE_UPDATE`）: `startWriteCreate` と同じ部品（`#startWrite`・`#start`・`#prepareWrite`）を通る。
//     実行の許可の確かめに、許可の種類（対象の ID の有無）がジョブの種類と合うことを足す（CREATE の許可で UPDATE を、UPDATE の許可で CREATE を
//     始めない。外れたら `WRITE_GRANT_REJECTED`）。対象の ID は、許可（`ExecutionGrantView.targetRecordId`）からだけ取る。
//   - 生成の履歴は、CREATE と UPDATE のどちらも `readScenarioWriteGenerationHistory`（同じ台帳の CREATE の登録の値と UPDATE で送った値。一意にする
//     欄の組は、生成の判定 `evaluateRuleSet` の `uniqueKeyFieldNames`）。
//   - `START` の書き込みの指定は、型に対象の ID を入れた具体的な path と UPDATE の指定（`write-job-start.ts`。保つ欄の値と前の値は送らない）。
//   - 締め: `action-run.json` の `update`（対象の ID と証拠）が、ジョブの種類と許可の対象の ID に合うときだけ使い、取れた ID（`recordId`）と証拠
//     （欄ごとの一致）を `settleWriteResult` に渡す（判定は締めの部品）。合わなければ、送信の報告から締める（`WRITE_RESULT_INVALID`）。
// ワーカーの環境（T26d-2。設計書 4.4）:`fork` に渡す環境から、デバッグの出力を有効にする変数（`WORKER_EXCLUDED_ENVIRONMENT_VARIABLES`）を外す
//   （すべてのジョブ。ほかの変数は、そのまま渡す）。
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { DISCOVERY_ARTIFACT_FILE_NAME, READ_EVIDENCE_ARTIFACT_FILE_NAME } from '../../core/artifact-layout.js';
import { readContainedArtifactFile } from '../../core/contained-artifact-file.js';
import type { RunId, RunStatus } from '../../core/contracts.js';
import { isRecord } from '../../core/guards.js';
import { currentProcessRunLockHost, isProcessRunning, RUN_LOCK_HEARTBEAT_INTERVAL_MS, type RunLock } from '../../core/process-lock.js';
import { sortedKeysJsonOf } from '../../core/sorted-keys-json.js';
import { formatCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import { deepFreeze } from '../../core/immutable.js';
import { validateArtifact, type ArtifactSchemaName } from '../../core/schema-validator.js';
import type { CandidateLocation } from '../../discovery/candidate-contracts.js';
import {
  discoveryCandidatesOf,
  discoveryReadPagePaths,
  discoverySummaryOf,
  mergeDiscoveryCandidates,
  type DiscoveryDocument,
} from '../../discovery/discovery-result.js';
import { readEvidenceSummaryOf, type ReadEvidenceDocument } from '../../discovery/read-check-evaluation.js';
import type { ActionRunDocument } from '../actions/action-contracts.js';
import { approvalSummaryFactsOf } from '../actions/approval-summary-facts.js';
import { approvalExternalFactsOf } from '../approval-external-facts.js';
import {
  assertGrantStillValid,
  closeOrphanedWriteResults,
  closeWriteWithoutSending,
  consumeExecutionGrant,
  readApprovalReceipts,
  readExecutionGrant,
  readScenarioRevisions,
  readUsedCumulativeWrites,
  readScenarioWriteGenerationHistory,
  recordWriteAttempt,
  settleWriteResult,
  type ExecutionGrantView,
  type WriteOutcomeReport,
} from '../approval/scenario-store.js';
import { evaluateRuleSet } from '../data-rules/field-evaluation.js';
import { readLatestRuleSet } from '../data-rules/rule-store.js';
import { generateScenarioData } from '../data-rules/scenario-data.js';
import type { AuthSetupValidationError } from '../auth/auth-setup-contracts.js';
import { validateAuthSetup } from '../auth/auth-setup-policy.js';
import { AUTOMATED_LOGIN_SUBMISSION_NONE, AUTOMATED_LOGIN_UNKNOWN_RESULT } from '../auth/automated-login-results.js';
import { MIN_PROFILE_REVISION, PROFILE_ID_PATTERN, type ProfileValidationError } from '../contracts.js';
import { createCredentialStore, type CredentialMetadata, type CredentialStore } from '../credentials/credential-store.js';
import { profileOperationRejectionOf, requiresAuthSetup, type ProfileOperation } from '../execution-policy.js';
import { isAcceptedTargetConfigPath, validateSiteProfile, type ProfileValidationContext } from '../profile-policy.js';
import { getAuthSetup, type StoredAuthSetup } from '../store/auth-setup-store.js';
import type { ControlDatabase } from '../store/control-database.js';
import { getProfile } from '../store/profile-store.js';
import {
  MAX_WORKER_EXIT_CODE,
  MAX_WORKER_READ_CHECKS,
  WORKER_DISCOVERY_JOB_KIND,
  WORKER_LOGIN_CHECK_JOB_KIND,
  WORKER_PROTOCOL_VERSION,
  WORKER_READ_CHECK_JOB_KIND,
  WORKER_JOB_ID_PATTERN,
  WORKER_SESSION_LOST_STATE,
  WORKER_WRITE_CREATE_JOB_KIND,
  WORKER_WRITE_UPDATE_JOB_KIND,
  isWorkerWriteJobKind,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
  type ParentToWorkerMessage,
  type WorkerAutomatedLoginReport,
  type WorkerDiscoverySummary,
  type WorkerReadCheckSummary,
  type WorkerRunOutcome,
  type WorkerStartAuthentication,
  type WorkerStartAutomatedLogin,
  type WorkerStartReadCheck,
  type WorkerStartWrite,
  type WorkerToParentMessage,
  type WorkerWriteJobKind,
  type WorkerWriteRecheckRejectionReason,
  type WorkerWriteSubmissionMessage,
} from '../worker-protocol.js';
import { dateOfCompactUtcTimestamp, decideAutoLoginStart, type AutoLoginLimitDecision } from './auto-login-limits.js';
import { checkAutoLoginStart } from './auto-login-preflight.js';
import {
  closeOrphanedAutoLoginAttempts,
  closePendingAutoLoginAttempt,
  readAutoLoginLimitInputs,
  readAutoLoginLimitInputsWith,
  recordAutoLoginResult,
} from './auto-login-store.js';
import { ACTION_RUN_ARTIFACT_FILE_NAME, writeBaseDateOf, writeStartSpecOf } from './write-job-start.js';
import { discoveryIndexEntryOf, readDiscoveryIndex, recordDiscoveryCandidates } from './discovery-index-store.js';
import {
  AUDIT_JOB_EXIT_WAIT_MS,
  AUDIT_JOB_LOCK_LOST_KILL_AFTER_MS,
  AUDIT_JOB_UNOWNED_WORKER_STALE_AFTER_MS,
  AUDIT_JOB_FORCE_STOP_KILL_AFTER_MS,
  AUDIT_JOB_HEARTBEAT_TIMEOUT_MS,
  AUDIT_JOB_IPC_DRAIN_WAIT_MS,
  AUDIT_JOB_PROGRESS_WRITE_INTERVAL_MS,
  AUDIT_JOB_READY_TIMEOUT_MS,
  AUDIT_JOB_SHUTDOWN_WAIT_MS,
  AUDIT_JOB_WATCHDOG_INTERVAL_MS,
  type AuditJobFailureReason,
  type AuditJobKind,
  type AuditJobStartRejectionReason,
  type AuditJobStopRejectionReason,
  type CredentialChangeRejectionReason,
  type WriteReportCheck,
} from './job-records.js';
import {
  acquireControlInstanceLock,
  ControlInstanceLockedError,
  holdsControlInstanceLock,
  releaseControlInstanceLock,
  renewControlInstanceLock,
} from './instance-lock.js';
import {
  createStartingJob,
  hasActiveJobForProfile,
  interruptActiveJobs,
  readAllJobs,
  readJob,
  recordEnded,
  recordFinished,
  recordLoginCheckFinished,
  recordHeartbeat,
  recordNotice,
  recordAuthState,
  recordProgress,
  recordRunStarted,
  recordStopping,
  recordWorkerPid,
  recordWriteReportCheck,
  type AuditJobView,
  type UnownedActiveJob,
} from './job-store.js';
import { checkWriteReport } from './write-report-check.js';
import { listReadChecks, recordReadCheckResults, type ReadCheckView } from './read-check-store.js';

/** ターゲット JSON のパスから、検証の文脈を返す（読めなければ `undefined`）。画面のサーバは、`loadConfig` で読む。 */
export type AuditJobContextResolver = (
  targetConfigPath: string,
) => Promise<ProfileValidationContext | undefined> | ProfileValidationContext | undefined;

/** ワーカーを起動する関数（本番は `child_process.fork`。テストは起動の回数を数える）。 */
export type AuditWorkerForker = (modulePath: string, args: readonly string[], options: ForkOptions) => ChildProcess;

/** ジョブの管理の時間（ms。テストは短くする）。 */
export interface AuditJobTiming {
  readonly readyTimeoutMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly watchdogIntervalMs: number;
  readonly progressWriteIntervalMs: number;
  readonly forceStopKillAfterMs: number;
  /** 結果（`FINISHED`・`FAILED`）を受けてから、ワーカーの終わりを待つ時間。過ぎたら kill する（T24h-1 の M2）。 */
  readonly exitWaitMs: number;
  /** ワーカーの `exit` を受けてから、IPC が切れる（`disconnect`）のを待つ上限（DEF-084。待つ間に届いたメッセージを処理する）。 */
  readonly ipcDrainWaitMs: number;
  /** 管理のロックのハートビートの間隔（T24h-4。古さの判定は `judgeRunLock` の `RUN_LOCK_STALE_AFTER_MS`）。 */
  readonly instanceHeartbeatIntervalMs: number;
  /** ほかの管理のジョブのワーカーが、まだ動いているとみなす時間（T24h-6）。 */
  readonly unownedWorkerStaleAfterMs: number;
  /** 管理のロックを失った後に、自分のワーカーの終わりを待つ時間（T24h-6）。 */
  readonly lockLostKillAfterMs: number;
}

/** 名前つきの時間（本番の値）。 */
export const AUDIT_JOB_TIMING: AuditJobTiming = Object.freeze({
  readyTimeoutMs: AUDIT_JOB_READY_TIMEOUT_MS,
  heartbeatTimeoutMs: AUDIT_JOB_HEARTBEAT_TIMEOUT_MS,
  watchdogIntervalMs: AUDIT_JOB_WATCHDOG_INTERVAL_MS,
  progressWriteIntervalMs: AUDIT_JOB_PROGRESS_WRITE_INTERVAL_MS,
  forceStopKillAfterMs: AUDIT_JOB_FORCE_STOP_KILL_AFTER_MS,
  exitWaitMs: AUDIT_JOB_EXIT_WAIT_MS,
  ipcDrainWaitMs: AUDIT_JOB_IPC_DRAIN_WAIT_MS,
  instanceHeartbeatIntervalMs: RUN_LOCK_HEARTBEAT_INTERVAL_MS,
  unownedWorkerStaleAfterMs: AUDIT_JOB_UNOWNED_WORKER_STALE_AFTER_MS,
  lockLostKillAfterMs: AUDIT_JOB_LOCK_LOST_KILL_AFTER_MS,
});

/** ジョブの管理を作るときに受け取るもの。 */
export interface AuditJobManagerOptions {
  readonly database: ControlDatabase;
  /** リポジトリの root（絶対パス）。ワーカーの cwd にする（ワーカーは、ターゲット JSON と出力先を cwd から解決する）。 */
  readonly repositoryRoot: string;
  /** ワーカーの入口（絶対パス。本番は `<root>/dist/worker/audit-worker.js`）。 */
  readonly workerPath: string;
  readonly resolveContext: AuditJobContextResolver;
  /** 今の時刻（記録の日時。既定は `new Date()`）。 */
  readonly now?: () => Date;
  /** ワーカーを起動する関数（既定は `child_process.fork`）。 */
  readonly forkWorker?: AuditWorkerForker;
  /** 時間（既定は `AUDIT_JOB_TIMING`）。 */
  readonly timing?: Partial<AuditJobTiming>;
  /** 背後の処理の誤り（管理データに書けなかったなど）の受け手（既定は何もしない）。 */
  readonly onBackgroundError?: (error: unknown) => void;
  /** この画面のサーバの port（管理のロックに記録し、2 つ目の画面のサーバの説明に出す。分からなければ省略）。 */
  readonly instancePort?: number | null;
  /**
   * 資格情報のファイルの部品と、そのフォルダを決める根（T26d-2）。省略すると、根はリポジトリの root で、部品は本番の入口 `createCredentialStore`
   * （最初に使うときに作る）。`root` は、`START` の `credentialRoot` として、ワーカーにも渡す（絶対パス）。
   */
  readonly credentials?: { readonly root: string; readonly store?: CredentialStore };
}

/** 開始の依頼（画面から受けた値。形もここで確かめる）。 */
export interface AuditJobStartRequest {
  readonly profileId: string;
  /** 画面が読んだプロファイルの改訂。 */
  readonly expectedRevision: number;
  /** 新しく始める（CLI の `--new` に当たる）。 */
  readonly startNew: boolean;
}

/** ログインの検証の開始の依頼（T26d-2。画面から受けた値。形もここで確かめる）。 */
export interface LoginCheckStartRequest {
  readonly profileId: string;
  /** 画面が読んだプロファイルの改訂。 */
  readonly expectedRevision: number;
}

/** 操作の候補の発見の開始の依頼（T27d。画面から受けた値。形もここで確かめる。発見のジョブは再開しないので、新しく始めるかの指定はない）。 */
export interface DiscoveryStartRequest {
  readonly profileId: string;
  /** 画面が読んだプロファイルの改訂。 */
  readonly expectedRevision: number;
}

/** READ の確かめの開始の依頼（T27e。画面から受けた値。形もここで確かめる。再開しないので、新しく始めるかの指定はない）。 */
export interface ReadCheckStartRequest {
  readonly profileId: string;
  /** 画面が読んだプロファイルの改訂。 */
  readonly expectedRevision: number;
}

/**
 * 書き込みのジョブの開始の依頼（T30e。画面から受けた値。形もここで確かめる。実行の許可は、画面が人の確かめの後に発行したもの）。T31f: CREATE と
 * UPDATE で同じ形（更新の対象の ID は、依頼ではなく許可から取る）。
 */
export interface WriteStartRequest {
  readonly profileId: string;
  /** 画面が読んだプロファイルの改訂。 */
  readonly expectedRevision: number;
  readonly scenarioId: string;
  /** 実行の許可の id（ジョブの id は、許可に結び付けた id）。 */
  readonly grantId: string;
}

/** CREATE の書き込みのジョブの開始の依頼（T30e）。 */
export type WriteCreateStartRequest = WriteStartRequest;

/** UPDATE の書き込みのジョブの開始の依頼（T31f）。 */
export type WriteUpdateStartRequest = WriteStartRequest;

/**
 * 開始の結果。受けたら作ったジョブ、拒んだら理由（`PROFILE_INVALID` では検証の誤り）。`AUTH_SETUP_INVALID` のときだけ、認証の設定の検証の誤り
 * （`authSetupErrors`。閉じた一覧のコードと、設定の値を入れない英語の詳細）を持つ（T25e。画面が、誤りのコードと項目を示すため）。
 * 自動ログインの上限で拒むとき（`AUTO_LOGIN_HELD`・`AUTO_LOGIN_RATE_LIMITED`。T26d-2）だけ、次に始められる時刻（`nextAllowedAt`。UTC の 14 桁。
 * 止めているときは `null`）を持つ。
 */
export type AuditJobStartResult =
  | { readonly ok: true; readonly job: AuditJobView }
  | {
    readonly ok: false;
    readonly reason: AuditJobStartRejectionReason;
    readonly errors: readonly ProfileValidationError[];
    readonly authSetupErrors?: readonly AuthSetupValidationError[];
    readonly nextAllowedAt?: string | null;
  };

/** 資格情報を変えてよいかの確かめの結果（T26d-2。T26e が使う）。 */
export type CredentialChangeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CredentialChangeRejectionReason };

/** 停止の結果。 */
export type AuditJobStopResult =
  | { readonly ok: true; readonly job: AuditJobView }
  | { readonly ok: false; readonly reason: AuditJobStopRejectionReason };

/** 終わりのときの後始末の結果。 */
export interface AuditJobShutdownResult {
  /** 止める要求を送ったジョブの数。 */
  readonly stopRequested: number;
  /** 待つ時間の中に終わらず、ワーカーを止めた（kill した）ジョブの数。 */
  readonly killed: number;
}

/** ジョブの管理。 */
export interface AuditJobManager {
  startAuditJob(request: AuditJobStartRequest): Promise<AuditJobStartResult>;
  /** ログインの検証を始める（T26d-2。自動ログインのプロファイルだけ。Run を作らない）。 */
  startLoginCheck(request: LoginCheckStartRequest): Promise<AuditJobStartResult>;
  /**
   * 操作の候補の発見を始める（T27d。`TEST_AUTH_PASSIVE` と、T28b から `TEST_APPROVED_WRITE` のプロファイルだけ。開始の確かめは監査と同じ。ジョブの終わりに、`discovery.json` を
   * 読んで候補の索引を更新する）。
   */
  startDiscovery(request: DiscoveryStartRequest): Promise<AuditJobStartResult>;
  /**
   * READ の確かめを始める（T27e。`TEST_AUTH_PASSIVE` と、T28b から `TEST_APPROVED_WRITE` のプロファイルだけ。開始の確かめは発見と同じで、取り消していない定義が 0 件なら拒む。ジョブの
   * 終わりに、`read-evidence.json` を読んで結果を記録する）。
   */
  startReadCheck(request: ReadCheckStartRequest): Promise<AuditJobStartResult>;
  /**
   * 承認された CREATE の書き込みを始める（T30e。書き込みのモードの、ログインを使うプロファイルだけ。実行の許可を消費し、値を生成して送る前の記録を
   * 書いてからワーカーを起動する。ジョブの終わりに、書き込みの結果を必ず 1 回締める）。
   */
  startWriteCreate(request: WriteCreateStartRequest): Promise<AuditJobStartResult>;
  /**
   * 承認された UPDATE の書き込みを始める（T31f。開始の確かめは `startWriteCreate` と同じで、許可は UPDATE の許可（対象の ID を結んだもの）だけ。
   * 対象の ID は許可から取って `START` に写す。ジョブの終わりに、書き込みの結果を必ず 1 回締める）。
   */
  startWriteUpdate(request: WriteUpdateStartRequest): Promise<AuditJobStartResult>;
  /** 資格情報を変えてよいか（T26d-2。そのプロファイルのジョブが終わっていない間は `CREDENTIAL_IN_USE`）。 */
  checkCredentialChange(profileId: string): CredentialChangeCheck;
  stopAuditJob(jobId: string, options?: { readonly force?: boolean }): AuditJobStopResult;
  /**
   * T30R-fix-1（DEF-103）: 承認を無効にする操作（撤回、シナリオの変更）の後に呼ぶ。そのシナリオの動いている書き込みのジョブ（`WRITE_CREATE`。T31f から `WRITE_UPDATE` も）に
   * `STOP` を送る（強制しない。ワーカーは押す前の各段で止める印を確かめ、押す直前の確かめ直しも拒まれる）。止めを求めたジョブの数を返す。
   */
  stopWriteJobsOfScenario(scenarioId: string): number;
  /** 画面のサーバの起動のときに呼ぶ。終わっていないジョブの行を `INTERRUPTED`（`SERVER_RESTARTED`）にする。直した行の数を返す。 */
  recoverInterruptedJobs(): number;
  /** 画面のサーバの終わりのときに呼ぶ。動いているジョブに `STOP` を送り、`waitMs` だけ終わりを待ち、残ったワーカーを止める。 */
  shutdownAuditJobs(options?: { readonly waitMs?: number }): Promise<AuditJobShutdownResult>;
  listAuditJobs(): readonly AuditJobView[];
  getAuditJob(jobId: string): AuditJobView | null;
  /** 動いているワーカーの数（この管理が起動して、まだ終わっていないもの）。 */
  runningWorkerCount(): number;
  /** 管理をやめる（残ったワーカーを止め、見張りを止め、この process の 1 つの枠を空ける）。 */
  close(): Promise<void>;
}

/** ジョブの段（親から見たワーカーとのやりとり）。 */
type WorkerPhase = 'FORKED' | 'STARTED' | 'RUN' | 'DONE';

/**
 * 決まった終わり方（T24h-1 の M2）。ワーカーの process が終わってから、管理データに記録する（記録するまで、ジョブは終わっていない状態の
 * ままで、同時に 1 つの枠を空けない）。
 */
type JobEnding =
  | {
    readonly kind: 'FINISHED';
    readonly outcome: WorkerRunOutcome;
    /** 発見のジョブの件数の要約（T27d。発見のジョブの Run を実行した結果だけ。ほかは `null`）。 */
    readonly discovery: WorkerDiscoverySummary | null;
    /** READ の確かめのジョブの件数の要約（T27e。READ の確かめのジョブの Run を実行した結果だけ。ほかは `null`）。 */
    readonly readCheck: WorkerReadCheckSummary | null;
  }
  | { readonly kind: 'LOGIN_CHECKED' }
  | { readonly kind: 'ENDED'; readonly state: 'FAILED' | 'INTERRUPTED'; readonly reason: AuditJobFailureReason };

/**
 * ジョブの結果のファイルを確かめた結果（T27d の発見、T27e の READ の確かめ）。`INVALID` は、読めない・合わない（理由は、ジョブの種類ごとの失敗の
 * 理由）。
 */
type JobResultVerdict =
  | { readonly kind: 'DISCOVERY'; readonly document: DiscoveryDocument }
  | { readonly kind: 'READ_CHECK'; readonly document: ReadEvidenceDocument }
  /** T32g: `reportCheck` は、報告の確かめの結果（`checkWriteReport`。締めで記録する）。 */
  | { readonly kind: 'WRITE'; readonly document: ActionRunDocument; readonly reportCheck: WriteReportCheck }
  | { readonly kind: 'INVALID'; readonly reason: AuditJobFailureReason };

/** 発見の結果を読めないときの、ジョブの失敗の理由（T27d）。 */
const DISCOVERY_RESULT_INVALID_REASON = 'DISCOVERY_RESULT_INVALID' satisfies AuditJobFailureReason;

/** READ の確かめの結果を読めないときの、ジョブの失敗の理由（T27e）。 */
const READ_CHECK_RESULT_INVALID_REASON = 'READ_CHECK_RESULT_INVALID' satisfies AuditJobFailureReason;

/** 書き込みの結果を読めないときと、確かめ直しで外れたときの、ジョブの失敗の理由（T30e）。 */
const WRITE_RESULT_INVALID_REASON = 'WRITE_RESULT_INVALID' satisfies AuditJobFailureReason;
const WRITE_GRANT_REJECTED_REASON = 'WRITE_GRANT_REJECTED' satisfies AuditJobFailureReason;

/** 書き込みの結果を読めない・合わない（T30e）。 */
const WRITE_RESULT_INVALID: JobResultVerdict = Object.freeze({ kind: 'INVALID', reason: WRITE_RESULT_INVALID_REASON });
/** T32g: `action-run.json` を使えなかったジョブの、報告の確かめの結果（報告を照らしていない。配らない）。 */
const WRITE_REPORT_RESULT_INVALID = 'RESULT_INVALID' satisfies WriteReportCheck;

/** 書き込みのジョブの、親の側の状態（T30e）。 */
interface WriteJobState {
  readonly grantId: string;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  /** 確かめ直しの依頼を受けた。 */
  recheckRequested: boolean;
  /** 確かめ直しで許した（送った・分からないの報告は、この後だけ）。 */
  recheckAllowed: boolean;
  /** 確かめ直しで拒んだ（2 回目の依頼を含む。`STOP` を送った）。 */
  rejected: boolean;
  /** 送信の報告（受けていなければ null）。 */
  submission: Pick<WorkerWriteSubmissionMessage, 'submission' | 'blockReason'> | null;
}

/** 発見の結果を読めない・合わない（T27d）。 */
const DISCOVERY_RESULT_INVALID: JobResultVerdict = Object.freeze({ kind: 'INVALID', reason: DISCOVERY_RESULT_INVALID_REASON });

/** READ の確かめの結果を読めない・合わない（T27e）。 */
const READ_CHECK_RESULT_INVALID: JobResultVerdict = Object.freeze({ kind: 'INVALID', reason: READ_CHECK_RESULT_INVALID_REASON });

/** 索引に記録する発見の Run の状態（画面を読んだ Run。`FAILED` と `ABORTED_BY_SAFETY` は記録しない。T27d）。 */
const DISCOVERY_INDEXED_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['COMPLETE', 'PARTIAL']);

/** ワーカーの起動の値（`#launchWorker` の引数。T27d で 1 つの値にまとめた）。 */
interface WorkerLaunch {
  readonly jobId: string;
  readonly jobKind: AuditJobKind;
  readonly profileId: string;
  readonly outputDirectory: string;
  readonly targetConfigPath: string;
  readonly startNew: boolean;
  readonly targetConfigSha256: string;
  readonly authentication: WorkerStartAuthentication | null;
  /** READ の確かめの定義の一覧（T27e。`READ_CHECK` だけ。ほかは `null`）。 */
  readonly readChecks: readonly WorkerStartReadCheck[] | null;
  /** 書き込みの指定（T30e。`WRITE_CREATE` と、T31f から `WRITE_UPDATE` だけ。ほかは `null`）。 */
  readonly writeSpec: WorkerStartWrite | null;
}

/** この管理が起動したワーカー。 */
interface TrackedJob extends WorkerLaunch {
  readonly jobId: string;
  /** ジョブの種類（T26d-2）。 */
  readonly jobKind: AuditJobKind;
  /** プロファイル（T27d。発見のジョブの索引の更新に使う）。 */
  readonly profileId: string;
  /** 出力先の絶対パス（T27d。開始の直前に読み直したターゲット設定の `output.directory` を、リポジトリの root から解決したもの）。 */
  readonly outputDirectory: string;
  readonly child: ChildProcess;
  readonly targetConfigPath: string;
  readonly startNew: boolean;
  /** 開始の直前の検証で読んだターゲット JSON の SHA-256（`START` で渡す。T24h-1 の M3）。 */
  readonly targetConfigSha256: string;
  /** 認証つきの監査の指定（`START` で渡す。T25d）。公開の監査は `null`（`AUTH_STATE` を受けたら違反）。 */
  readonly authentication: WorkerStartAuthentication | null;
  /** 自動ログインの結果を受けた（T26d-2。1 つのジョブで 1 回だけ）。 */
  automatedLoginReported: boolean;
  /** 書き込みのジョブの状態（T30e。`WRITE_CREATE` と、T31f から `WRITE_UPDATE` だけ。ほかは `null`）。 */
  readonly write: WriteJobState | null;
  /** `START` を送った（T26d-2 round 1。送っていなければ、ワーカーはログインの POST を送れない）。 */
  startSent: boolean;
  phase: WorkerPhase;
  /** `RUN_STARTED` で受けた Run の ID と Run のディレクトリ（`FINISHED` と照らし合わせる。T24h-1 の M1）。 */
  runStarted: { readonly runId: RunId; readonly runDirectory: string } | null;
  /** 決まった終わり方（ワーカーが終わったときに記録する。T24h-1 の M2）。決まっていなければ `null`。 */
  ending: JobEnding | null;
  exitTimer: NodeJS.Timeout | undefined;
  /**
   * ワーカーの process が終わった（`exit` を受けた。DEF-084）。真の間は、IPC の終わりを待っている（または記録の途中）。見張り・`READY` の期限・
   * 止める期限でジョブを終わらせず、`STOP` も送らない。
   */
  processExited: boolean;
  stopRequested: boolean;
  forceRequested: boolean;
  lastHeartbeatMs: number;
  lastProgressWriteMs: number;
  pendingProgress: Extract<WorkerToParentMessage, { readonly type: 'PROGRESS' }>['report'] | null;
  readyTimer: NodeJS.Timeout | undefined;
  killTimer: NodeJS.Timeout | undefined;
  progressTimer: NodeJS.Timeout | undefined;
  readonly exited: Promise<void>;
}

/** 標準入出力を捨て、IPC だけをつなぐ。 */
const WORKER_STDIO: ForkOptions['stdio'] = ['ignore', 'ignore', 'ignore', 'ipc'];
/** 画面のサーバの起動の引数を引き継がない。 */
const WORKER_EXEC_ARGV: readonly string[] = Object.freeze([]);
/** ワーカーへの引数（なし。`START` で渡す）。 */
const WORKER_ARGS: readonly string[] = Object.freeze([]);
/** IPC の直列化（JSON の値だけ）。 */
const WORKER_SERIALIZATION = 'json';
/** kill の後に、ワーカーの終わりを待つ上限（ms）。 */
const KILLED_WORKER_EXIT_WAIT_MS = 5_000;

/**
 * ワーカーの環境から外す変数の名前（T26d-2。Task 26 の設計書 4.4 の「ワーカーの環境」。名前つきの閉じた一覧。大文字と小文字を区別せずに外す
 * （Windows の環境の変数の名前は、大文字と小文字を区別しない））。どれも、Playwright か Node のデバッグの出力を有効にし、ページに入れた値や
 * 内部の値を標準エラーかファイルに出しうる（調査 E8: `DEBUG=pw:api` で、入れた値が標準エラーに出る）。
 * - `DEBUG`: Playwright（`debug` の部品）のデバッグの出力（`pw:api`、`pw:protocol` など）。
 * - `DEBUG_FILE`: Playwright のデバッグの出力の書き先のファイル。
 * - `PWDEBUG`: Playwright の検査の窓と、デバッグの出力。
 * - `PWDEBUGIMPL`: Playwright の内部の誤りの詳細（誤りの文と積み上げ）。
 * - `NODE_DEBUG`: Node の組み込みの部品のデバッグの出力。
 * - `NODE_DEBUG_NATIVE`: Node のネイティブの部品のデバッグの出力。
 * - `NODE_OPTIONS`（round 1）: Node の起動の指定（`--inspect` で検査の窓を開く、`--require`・`--import` で別のコードを読み込む、など）。ワーカーの
 *   中の値（復号した資格情報を含む）に、外から届く口を作りうる。
 */
export const WORKER_EXCLUDED_ENVIRONMENT_VARIABLES = Object.freeze([
  'DEBUG',
  'DEBUG_FILE',
  'PWDEBUG',
  'PWDEBUGIMPL',
  'NODE_DEBUG',
  'NODE_DEBUG_NATIVE',
  'NODE_OPTIONS',
] as const);

const EXCLUDED_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(WORKER_EXCLUDED_ENVIRONMENT_VARIABLES.map((name) => name.toUpperCase()));

/**
 * ワーカーに渡す環境（T26d-2）: `source` の写しから、`WORKER_EXCLUDED_ENVIRONMENT_VARIABLES` の名前の変数を（大文字と小文字を区別せずに）外す。
 * ほかの変数は、そのまま渡す。`source` は変えない。
 */
export const workerEnvironmentOf = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(source).filter(([name]) => !EXCLUDED_ENVIRONMENT_NAMES.has(name.toUpperCase())));

/** 自動ログインの上限で拒むときの、次に始められる時刻（T26d-2。止めているときは `null`）。 */
const nextAllowedAtOf = (decision: Exclude<AutoLoginLimitDecision, { readonly ok: true }>): string | null => decision.nextAllowedAt;

const NO_ERRORS: readonly ProfileValidationError[] = Object.freeze([]);

const startRejected = (
  reason: AuditJobStartRejectionReason,
  errors: readonly ProfileValidationError[] = NO_ERRORS,
): AuditJobStartResult => Object.freeze({ ok: false, reason, errors: Object.freeze([...errors]) });

const stopRejected = (reason: AuditJobStopRejectionReason): AuditJobStopResult => Object.freeze({ ok: false, reason });

/** 終了コードとして記録できる値（0 から `MAX_WORKER_EXIT_CODE`）か。Windows の大きな値などは記録しない。 */
const recordableExitCode = (code: number | null): number | null =>
  code !== null && Number.isSafeInteger(code) && code >= 0 && code <= MAX_WORKER_EXIT_CODE ? code : null;

/** ログインの検証の依頼の形（画面のスキーマとは別に、ここでも確かめる。T26d-2）。 */
const isLoginCheckRequest = (value: unknown): value is LoginCheckStartRequest =>
  isRecord(value)
  && typeof value['profileId'] === 'string'
  && PROFILE_ID_PATTERN.test(value['profileId'])
  && typeof value['expectedRevision'] === 'number'
  && Number.isSafeInteger(value['expectedRevision'])
  && value['expectedRevision'] >= MIN_PROFILE_REVISION;

/** 書き込みのジョブの開始の依頼の形（T30e。画面のスキーマとは別に、ここでも確かめる。T31f: CREATE と UPDATE で同じ）。 */
const isWriteStartRequest = (value: unknown): value is WriteStartRequest =>
  isLoginCheckRequest(value)
  && typeof (value as unknown as Record<string, unknown>)['scenarioId'] === 'string'
  && WORKER_JOB_ID_PATTERN.test((value as unknown as Record<string, string>)['scenarioId'] ?? '')
  && typeof (value as unknown as Record<string, unknown>)['grantId'] === 'string'
  && WORKER_JOB_ID_PATTERN.test((value as unknown as Record<string, string>)['grantId'] ?? '');

/** 依頼の形（画面のスキーマとは別に、ここでも確かめる）。 */
const isStartRequest = (value: unknown): value is AuditJobStartRequest =>
  isLoginCheckRequest(value) && typeof (value as unknown as Record<string, unknown>)['startNew'] === 'boolean';

/** 自動ログインの開始の前の確かめで読んだ値（T26d-2）。 */
interface AutoLoginStart {
  readonly automatedLogin: WorkerStartAutomatedLogin;
}

const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => {
  setTimeout(resolvePromise, ms);
});

/** この process の、ただ 1 つのジョブの管理（作っていなければ `null`）。 */
let processManager: AuditJobManager | null = null;

/**
 * ジョブの管理を作る。1 つの process の中に 1 つだけ（2 つ目は、前のものを `close()` するまで `Error`）。管理データの中でも 1 つだけ
 * （管理のロックを取れなければ `ControlInstanceLockedError`。T24h-4）。
 * `repositoryRoot` と `workerPath` が絶対パスでなければ `RangeError`。
 */
export function createAuditJobManager(options: AuditJobManagerOptions): AuditJobManager {
  if (processManager !== null) {
    throw new Error('only one audit job manager can exist in a process; close the previous one first');
  }
  if (!isAbsolute(options.repositoryRoot) || !isAbsolute(options.workerPath)) {
    throw new RangeError('the repository root and the worker path of the audit job manager must be absolute paths');
  }
  if (options.credentials !== undefined && !isAbsolute(options.credentials.root)) {
    throw new RangeError('the credential root of the audit job manager must be an absolute path');
  }
  // 管理のロック（T24h-4）: 取れなければ、管理を作らずに止まる（何も書き換えない）。
  const acquisition = acquireControlInstanceLock(options.database, {
    host: currentProcessRunLockHost(Date.now()),
    port: options.instancePort ?? null,
    isProcessRunning,
  });
  if (!acquisition.acquired) {
    throw new ControlInstanceLockedError(acquisition.holder);
  }
  let manager: JobManager;
  try {
    manager = new JobManager(options, acquisition.lock);
  } catch (error) {
    releaseControlInstanceLock(options.database, acquisition.lock);
    throw error;
  }
  processManager = manager;
  return manager;
}

class JobManager implements AuditJobManager {
  readonly #database: ControlDatabase;
  readonly #repositoryRoot: string;
  readonly #workerPath: string;
  readonly #resolveContext: AuditJobContextResolver;
  readonly #now: () => Date;
  readonly #forkWorker: AuditWorkerForker;
  readonly #timing: AuditJobTiming;
  readonly #onBackgroundError: (error: unknown) => void;
  /** 資格情報のフォルダを決める根（T26d-2。`START` の `credentialRoot`）。 */
  readonly #credentialRoot: string;
  /** 資格情報のファイルの部品（T26d-2。渡されなければ、最初に使うときに本番の入口で作る）。 */
  #credentialStore: CredentialStore | null;
  readonly #jobs = new Map<string, TrackedJob>();
  readonly #watchdog: NodeJS.Timeout;
  /** 持っている管理のロック（T24h-4）。 */
  readonly #instanceLock: RunLock;
  readonly #instanceHeartbeat: NodeJS.Timeout;
  /** 管理のロックを失った（ほかの管理が取り直した）。新しいジョブを始めない。 */
  #instanceLockLost = false;
  #closing = false;
  #closed = false;

  constructor(options: AuditJobManagerOptions, instanceLock: RunLock) {
    this.#instanceLock = instanceLock;
    this.#database = options.database;
    this.#repositoryRoot = options.repositoryRoot;
    this.#workerPath = options.workerPath;
    this.#resolveContext = options.resolveContext;
    this.#now = options.now ?? ((): Date => new Date());
    this.#forkWorker = options.forkWorker ?? ((modulePath, args, forkOptions) => fork(modulePath, [...args], forkOptions));
    this.#timing = Object.freeze({ ...AUDIT_JOB_TIMING, ...options.timing });
    this.#onBackgroundError = options.onBackgroundError ?? ((): void => undefined);
    this.#credentialRoot = options.credentials?.root ?? options.repositoryRoot;
    this.#credentialStore = options.credentials?.store ?? null;
    this.#watchdog = setInterval(() => this.#checkHeartbeats(), this.#timing.watchdogIntervalMs);
    this.#watchdog.unref();
    this.#instanceHeartbeat = setInterval(() => this.#guarded(() => this.#renewInstanceLock()), this.#timing.instanceHeartbeatIntervalMs);
    this.#instanceHeartbeat.unref();
  }

  /** 管理のロックのハートビート。自分の行でなくなっていたら、失ったとして扱う（T24h-4、T24h-6）。 */
  #renewInstanceLock(): void {
    if (this.#instanceLockLost || this.#closed) {
      return;
    }
    if (!renewControlInstanceLock(this.#database, this.#instanceLock, Date.now())) {
      this.#markInstanceLockLost();
    }
  }

  /** 開いているトランザクションの中で、管理のロックをまだ持っているか（失ったら、失ったとして扱う）。 */
  #holdsInstanceLock(connection: Parameters<typeof holdsControlInstanceLock>[0]): boolean {
    if (this.#instanceLockLost) {
      return false;
    }
    if (!holdsControlInstanceLock(connection, this.#instanceLock)) {
      this.#markInstanceLockLost();
      return false;
    }
    return true;
  }

  /**
   * 管理のロックを失った（ほかの管理が古いと判定して取り直した）: 新しいジョブを始めず（T24h-4）、自分の動いているワーカーを止める（T24h-6。
   * 再レビュー T24R2 の m1。2 つの監査を同時に動かさない）。トランザクションの中から呼ばれることがあるので、止める処理は、トランザクションの
   * 外（次の回）で行う。
   */
  #markInstanceLockLost(): void {
    if (this.#instanceLockLost) {
      return;
    }
    this.#instanceLockLost = true;
    this.#onBackgroundError(new Error('the control instance lock was taken over by another audit job manager; stopping the running workers'));
    setImmediate(() => this.#guarded(() => this.#stopWorkersAfterLockLost()));
  }

  /**
   * ロックを失った後に、自分の動いているワーカーに `STOP` を送る（今のページを終えてから止まる）。名前つきの時間（`lockLostKillAfterMs`）の後も
   * 終わらなければ、ワーカーを止める（`STOP_TIMEOUT`）。
   */
  #stopWorkersAfterLockLost(): void {
    for (const job of this.#jobs.values()) {
      if (job.phase === 'DONE') {
        continue;
      }
      this.#guarded(() => this.#requestStop(job, false));
      clearTimeout(job.killTimer);
      job.killTimer = setTimeout(() => this.#guarded(() => {
        job.killTimer = undefined;
        // DEF-084: process が終わって IPC の終わりを待つ間は、ここで終わらせない（待ち終わりに決める）。
        if (this.#jobs.has(job.jobId) && !job.processExited) {
          this.#end(job, 'INTERRUPTED', 'STOP_TIMEOUT');
          this.#kill(job);
        }
      }), this.#timing.lockLostKillAfterMs);
    }
  }

  /**
   * ほかの管理の、終わっていないジョブのワーカーが、まだ動いているか（T24h-6）。ワーカーの process が動いていて（起動の前なら問わない）、最後の
   * 合図の記録が名前つきの時間（`unownedWorkerStaleAfterMs`）の中なら真。process の ID の使い回しは、合図の記録の新しさで見分ける（合図を
   * 記録するのは、そのワーカーを動かしている画面のサーバだけ）。
   */
  #isUnownedWorkerRunning(job: UnownedActiveJob): boolean {
    if (job.workerPid !== null && !isProcessRunning(job.workerPid)) {
      return false;
    }
    const freshSince = formatCompactUtcTimestamp(
      new Date(this.#now().getTime() - this.#timing.unownedWorkerStaleAfterMs),
      'unowned audit job freshness limit',
    );
    // UTC の 14 桁の日時は、文字列の順が時刻の順と同じ。
    return job.lastSeenAt >= freshSince;
  }

  /**
   * ほかの管理の、終わっていないジョブを中断に直す（ワーカーがまだ動いているものは直さない）。ロックを持っていなければ何もしない。直した行の数。
   */
  #interruptUnownedJobs(): number {
    const interrupted = interruptActiveJobs(
      this.#database,
      'SERVER_RESTARTED',
      this.#timestamp(),
      [...this.#jobs.keys()],
      (connection) => this.#holdsInstanceLock(connection),
      (job) => this.#isUnownedWorkerRunning(job),
    );
    // T26d-2: 終わっていないジョブのものでない、結果のない自動ログインの試し（前の画面のサーバのワーカーが落ちた、など）を、
    // `AUTH_RESULT_UNKNOWN`・送信 `UNKNOWN` で閉じて止める（ロックを持つ管理だけ）。まだ動いているジョブの試しは残る。
    if (!this.#instanceLockLost) {
      closeOrphanedAutoLoginAttempts(this.#database, this.#timestamp());
      // T30d: 終わっていないジョブのものでない、消費済みで締めていない書き込みの予約を `UNKNOWN` で締める（ロックを持つ管理だけ）。
      closeOrphanedWriteResults(this.#database, this.#timestamp());
    }
    return interrupted;
  }

  // -------------------------------------------------------------------------------------------------------------
  // 開始
  // -------------------------------------------------------------------------------------------------------------

  async startAuditJob(request: AuditJobStartRequest): Promise<AuditJobStartResult> {
    if (this.#closing || !isStartRequest(request)) {
      return startRejected('INVALID_REQUEST');
    }
    return this.#start('AUDIT', request.profileId, request.expectedRevision, request.startNew);
  }

  async startLoginCheck(request: LoginCheckStartRequest): Promise<AuditJobStartResult> {
    if (this.#closing || !isLoginCheckRequest(request)) {
      return startRejected('INVALID_REQUEST');
    }
    // ログインの検証は Run を作らないので、新しく始めるかの指定は意味を持たない（行には偽を書く）。
    return this.#start(WORKER_LOGIN_CHECK_JOB_KIND, request.profileId, request.expectedRevision, false);
  }

  async startDiscovery(request: DiscoveryStartRequest): Promise<AuditJobStartResult> {
    if (this.#closing || !isLoginCheckRequest(request)) {
      return startRejected('INVALID_REQUEST');
    }
    // 発見のジョブは再開しない（いつも新しい Run）。行には真を書く。
    return this.#start(WORKER_DISCOVERY_JOB_KIND, request.profileId, request.expectedRevision, true);
  }

  async startReadCheck(request: ReadCheckStartRequest): Promise<AuditJobStartResult> {
    if (this.#closing || !isLoginCheckRequest(request)) {
      return startRejected('INVALID_REQUEST');
    }
    // READ の確かめのジョブは再開しない（いつも新しい Run）。行には真を書く。
    return this.#start(WORKER_READ_CHECK_JOB_KIND, request.profileId, request.expectedRevision, true);
  }

  startWriteCreate(request: WriteCreateStartRequest): Promise<AuditJobStartResult> {
    return this.#startWrite(WORKER_WRITE_CREATE_JOB_KIND, request);
  }

  startWriteUpdate(request: WriteUpdateStartRequest): Promise<AuditJobStartResult> {
    return this.#startWrite(WORKER_WRITE_UPDATE_JOB_KIND, request);
  }

  /** 書き込みのジョブの開始（T30e。T31f で CREATE と UPDATE の共通の口にした）。拒んだら、使われなかった許可を返す（DEF-101）。 */
  async #startWrite(jobKind: WorkerWriteJobKind, request: WriteStartRequest): Promise<AuditJobStartResult> {
    if (this.#closing || !isWriteStartRequest(request)) {
      return startRejected('INVALID_REQUEST');
    }
    // 書き込みのジョブは再開しない（いつも新しい Run）。行には真を書く。
    const result = await this.#start(jobKind, request.profileId, request.expectedRevision, true, {
      scenarioId: request.scenarioId,
      grantId: request.grantId,
    });
    if (!result.ok) {
      this.#releaseUnusedGrant(request);
    }
    return result;
  }

  /**
   * DEF-101（T30g fix round 1）: 開始を拒んだときに、使われなかった許可を無効にして予約を返す。ジョブの行を作る前の段（プロファイル・認証の設定・
   * ターゲット設定の確かめ、終わっていないジョブ）で拒んでも、予約を `RESERVED` のまま残さない（次の発行が同時実行の上限で拒まれない）。
   * 返すのは、依頼のシナリオとプロファイルの、消費していない、無効でない、予約が `RESERVED` の許可で、その許可に結び付けたジョブの行がまだない
   * ときだけ（別のシナリオ・プロファイルの許可は変えない。同じ許可で並んで始めた、行を作ったほうの開始の許可は変えない）。ジョブの行を作った後の
   * 拒否は、`#prepareWrite` の後の締めが行う（ここでは、その許可は消費済みか無効なので変わらない）。T31f: 許可の種類がジョブの種類と合わずに
   * 拒んだとき（CREATE の許可で UPDATE を始めた、など）も、依頼のシナリオとプロファイルの許可なので、同じく返す。
   */
  #releaseUnusedGrant(request: WriteStartRequest): void {
    this.#guarded(() => {
      const grant = readExecutionGrant(this.#database, request.grantId);
      if (grant === null || grant.scenarioId !== request.scenarioId || grant.profileId !== request.profileId || grant.consumedAt !== null
        || grant.invalidatedAt !== null || grant.reservation.state !== 'RESERVED' || readJob(this.#database, grant.jobId) !== null) {
        return;
      }
      closeWriteWithoutSending(this.#database, { grantId: grant.grantId, jobId: grant.jobId, at: this.#timestamp() });
    });
  }

  checkCredentialChange(profileId: string): CredentialChangeCheck {
    if (typeof profileId !== 'string' || !PROFILE_ID_PATTERN.test(profileId)) {
      throw new RangeError('the profile id must match the profile id pattern');
    }
    return hasActiveJobForProfile(this.#database, profileId)
      ? Object.freeze({ ok: false, reason: 'CREDENTIAL_IN_USE' })
      : Object.freeze({ ok: true });
  }

  /** 資格情報のファイルの部品（T26d-2。渡されていなければ、本番の入口で 1 回だけ作る）。 */
  #credentials(): CredentialStore {
    this.#credentialStore ??= createCredentialStore(this.#credentialRoot);
    return this.#credentialStore;
  }

  /**
   * 自動ログインの開始の前の確かめ（T26d-2。設計書 4.5）。資格情報のメタデータ（読めない・壊れたファイルは、ないものとして扱う）、暗号化が使えるか、
   * 上限の判定を読み、`checkAutoLoginStart` で決める。通れば、`START` の自動ログインの指定を返す。
   */
  async #autoLoginPreflight(
    profile: Parameters<typeof checkAutoLoginStart>[0]['profile'],
    authSetup: Parameters<typeof checkAutoLoginStart>[0]['authSetup'],
  ): Promise<AutoLoginStart | AuditJobStartResult> {
    const store = this.#credentials();
    let credential: CredentialMetadata | null;
    try {
      credential = await store.readMetadata(profile.profileId);
    } catch {
      credential = null;
    }
    const protection = await store.checkProtection();
    const now = this.#now();
    const limit = decideAutoLoginStart({ ...readAutoLoginLimitInputs(this.#database, profile.profileId, now), now });
    const preflight = checkAutoLoginStart({ profile, authSetup, credential, protection, limit });
    if (!preflight.ok) {
      return preflight.reason === 'AUTO_LOGIN_HELD' || preflight.reason === 'AUTO_LOGIN_RATE_LIMITED'
        ? Object.freeze({ ok: false, reason: preflight.reason, errors: NO_ERRORS, nextAllowedAt: preflight.nextAllowedAt })
        : startRejected(preflight.reason);
    }
    if (credential === null) {
      throw new Error('the auto login preflight accepted a missing credential');
    }
    return Object.freeze({
      automatedLogin: Object.freeze({ credentialRevision: credential.credentialRevision, credentialRoot: this.#credentialRoot }),
    });
  }

  /**
   * 開始（監査とログインの検証。流れはファイルの先頭）。T30d: ジョブの種類に `WRITE_CREATE` を足したが、始める口（と、`execution-policy.ts` の操作の
   * 行）は T30e で足すので、ここで始める種類は、操作の行のある種類だけ。
   */
  async #start(
    jobKind: Extract<AuditJobKind, ProfileOperation>,
    profileId: string,
    expectedRevision: number,
    startNew: boolean,
    writeRequest: { readonly scenarioId: string; readonly grantId: string } | null = null,
  ): Promise<AuditJobStartResult> {
    if (this.#instanceLockLost) {
      return startRejected('CONTROL_INSTANCE_LOCK_LOST');
    }

    // 1. プロファイル、改訂、今実行できるモード。
    const stored = getProfile(this.#database, profileId);
    if (stored === null) {
      return startRejected('PROFILE_NOT_FOUND');
    }
    if (stored.status !== 'ACTIVE') {
      return startRejected('PROFILE_RETIRED');
    }
    if (stored.profile.revision !== expectedRevision) {
      return startRejected('PROFILE_REVISION_CONFLICT');
    }
    // T28b: ジョブの種類ごとに許すモードと認証の方式は、`execution-policy.ts` の閉じた一覧だけで決める（T26d-2 のログインの検証は自動ログインの
    // プロファイルだけ、T27d・T27e の発見と READ の確かめは認証の設定のあるモードだけ。書き込みのモードは、監査だけを今までどおり拒む）。
    const operationRejection = profileOperationRejectionOf(jobKind, stored.profile.mode, stored.profile.auth);
    if (operationRejection !== null) {
      return startRejected(operationRejection);
    }
    // T30e: 書き込みのジョブは、まだ使える実行の許可（同じシナリオとプロファイル、消費していない、無効でない、予約が `RESERVED`）があるときだけ始める。
    // T31f: 許可の種類（更新の対象の ID を結んだか）が、ジョブの種類（`WRITE_UPDATE` か）と合うときだけ。
    let grant: ExecutionGrantView | null = null;
    if (isWorkerWriteJobKind(jobKind)) {
      grant = writeRequest === null ? null : readExecutionGrant(this.#database, writeRequest.grantId);
      if (grant === null || writeRequest === null || grant.scenarioId !== writeRequest.scenarioId || grant.profileId !== profileId
        || grant.consumedAt !== null || grant.invalidatedAt !== null || grant.reservation.state !== 'RESERVED'
        || (jobKind === WORKER_WRITE_UPDATE_JOB_KIND) !== (grant.targetRecordId !== null)) {
        return startRejected('WRITE_GRANT_REJECTED');
      }
    }
    // T27e: READ の確かめは、取り消していない定義が 1 件以上あるときだけ始める（ターゲット設定を読む前に確かめる）。
    let readCheckDefinitions: readonly ReadCheckView[] = [];
    if (jobKind === WORKER_READ_CHECK_JOB_KIND) {
      readCheckDefinitions = listReadChecks(this.#database, profileId).slice(0, MAX_WORKER_READ_CHECKS);
      if (readCheckDefinitions.length === 0) {
        return startRejected('READ_CHECK_DEFINITIONS_MISSING');
      }
    }
    // T25d: 認証つきの監査は、保存した認証の設定が、今のプロファイルの改訂に結びつくとき（`CURRENT`）だけ始める（ターゲット設定を読む前に
    // 確かめる）。設定の中身は、下でターゲット設定を読み直した後に `validateAuthSetup` で検証し直す。
    let storedSetup: StoredAuthSetup | null = null;
    if (requiresAuthSetup(stored.profile.mode)) {
      storedSetup = getAuthSetup(this.#database, profileId);
      if (storedSetup === null) {
        return startRejected('AUTH_SETUP_MISSING');
      }
      if (storedSetup.freshness !== 'CURRENT') {
        return startRejected('AUTH_SETUP_STALE');
      }
    }

    // 2. ターゲット設定を読み直して、プロファイルを検証し直す（パスを確かめてから読む）。
    const { targetConfigPath } = stored.profile;
    if (!isAcceptedTargetConfigPath(targetConfigPath)) {
      return startRejected('TARGET_PATH_INVALID');
    }
    // 読み直す前と後の内容の SHA-256 が同じときだけ受け、その値を `START` で渡す（T24h-1 の M3。ワーカーは同じ値と比べる）。
    const digestBefore = await this.#targetConfigDigest(targetConfigPath);
    let context: ProfileValidationContext | undefined;
    try {
      context = await this.#resolveContext(targetConfigPath);
    } catch {
      context = undefined;
    }
    const digestAfter = await this.#targetConfigDigest(targetConfigPath);
    if (context === undefined || digestBefore === null || digestBefore !== digestAfter) {
      return startRejected('TARGET_CONFIG_UNAVAILABLE');
    }
    const validation = validateSiteProfile(stored.profile, context);
    if (!validation.ok) {
      return startRejected('PROFILE_INVALID', validation.errors);
    }
    // T25d: 認証の設定を、検証し直したプロファイルと読み直したターゲット設定で、もう一度 `validateAuthSetup` に通す。通った写しと、
    // プロファイルの許可 Origin と、その SHA-256 を `START` で渡す（ワーカーは管理データを読まない。受けた値から SHA-256 を求め直して比べる）。
    let authentication: WorkerStartAuthentication | null = null;
    if (storedSetup !== null) {
      const checked = validateAuthSetup(storedSetup.setup, validation.profile, context);
      if (!checked.ok) {
        return Object.freeze({
          ok: false,
          reason: 'AUTH_SETUP_INVALID',
          errors: NO_ERRORS,
          authSetupErrors: Object.freeze([...checked.errors]),
        } satisfies AuditJobStartResult);
      }
      // T26d-2: 自動ログインの設定なら、自動ログインの開始の前の確かめ（資格情報、暗号化、上限）を行う。手動の方式へは切り替えない。
      let automatedLogin: WorkerStartAutomatedLogin | null = null;
      if (checked.setup.automatedLogin !== null) {
        const preflight = await this.#autoLoginPreflight(validation.profile, checked.setup);
        if ('ok' in preflight) {
          return preflight;
        }
        automatedLogin = preflight.automatedLogin;
      }
      const approvedTestOrigins = [...validation.profile.approvedTestOrigins];
      authentication = deepFreeze({
        setup: checked.setup,
        approvedTestOrigins,
        authenticationSha256: workerAuthenticationDigestOf(checked.setup, approvedTestOrigins, { jobKind, automatedLogin }),
        ...(automatedLogin === null ? {} : { automatedLogin }),
      });
    }
    // T27d: 出力先は、読み直したターゲット設定の値を、ワーカーの cwd（リポジトリの root）から解決する（ワーカーと同じ場所。結果を読む）。
    const outputDirectory = resolve(this.#repositoryRoot, context.targetConfig.output.directory);
    // T27e: READ の確かめの定義の一覧（対象の候補の画面は、候補を最後に見た発見の成果物から決める）。
    const readChecks = jobKind === WORKER_READ_CHECK_JOB_KIND
      ? await this.#readCheckLaunches(profileId, readCheckDefinitions, outputDirectory)
      : null;
    if (this.#closing) {
      return startRejected('INVALID_REQUEST');
    }
    const automatedLogin = authentication?.automatedLogin ?? null;

    // 3. 同時に 1 つ。ほかの管理の終わっていないジョブは、ワーカーが終わっていれば中断に直し、まだ動いていれば残す（その場合、下で
    //    `JOB_ALREADY_ACTIVE` になる。T24h-6）。読み直しを待つ間にプロファイルが変わっていないことも、同じトランザクションの中で確かめ直す。
    this.#interruptUnownedJobs();
    if (this.#instanceLockLost) {
      return startRejected('CONTROL_INSTANCE_LOCK_LOST');
    }
    // T30e: 書き込みのジョブの id は、実行の許可に結び付けた id（許可の消費で確かめる）。
    const jobId = grant?.jobId ?? randomUUID();
    /** トランザクションの中の上限の確かめで拒んだときの判定（次に始められる時刻を返すため。`guard` の中で書く）。 */
    const limitRejection: { decision: Exclude<AutoLoginLimitDecision, { readonly ok: true }> | null } = { decision: null };
    const created = createStartingJob<AuditJobStartRejectionReason>(this.#database, {
      jobId,
      // T26c: ジョブの種類は必ず明示する。
      jobKind,
      profileId,
      profileRevision: expectedRevision,
      startNew,
      createdAt: this.#timestamp(),
      // T26d-2: 自動ログインのジョブは、同じトランザクションで試し始めた記録を書く（資格情報の改訂の番号だけ。値は書かない）。
      ...(automatedLogin === null ? {} : { autoLoginAttempt: { credentialRevision: automatedLogin.credentialRevision } }),
    }, (connection) => {
      if (!this.#holdsInstanceLock(connection)) {
        return 'CONTROL_INSTANCE_LOCK_LOST';
      }
      const current = getProfile(this.#database, profileId);
      if (current === null) {
        return 'PROFILE_NOT_FOUND';
      }
      if (current.status !== 'ACTIVE') {
        return 'PROFILE_RETIRED';
      }
      if (current.profile.revision !== expectedRevision || current.profile.targetConfigPath !== targetConfigPath) {
        return 'PROFILE_REVISION_CONFLICT';
      }
      if (automatedLogin !== null) {
        // T26d-2: 上限を、ジョブを作るのと同じトランザクションの中で確かめ直す（開始の前の確かめとの間に、ほかの試しが記録された場合）。
        const now = this.#now();
        const decision = decideAutoLoginStart({ ...readAutoLoginLimitInputsWith(connection, profileId, now), now });
        if (!decision.ok) {
          limitRejection.decision = decision;
          return decision.reason;
        }
      }
      return null;
    });
    if (!created.ok) {
      const rejectedByLimit = limitRejection.decision;
      if (rejectedByLimit !== null && created.reason === rejectedByLimit.reason) {
        return Object.freeze({ ok: false, reason: created.reason, errors: NO_ERRORS, nextAllowedAt: nextAllowedAtOf(rejectedByLimit) });
      }
      return startRejected(created.reason);
    }

    // T30e: 書き込みのジョブは、ジョブの行（同時に 1 つの枠）を作ってから、許可を消費し、値を生成し、送る前の記録を書く。止まれば、予約を締めてから
    // ジョブの行を `FAILED`（`WRITE_GRANT_REJECTED`）にして拒む（予約を `RESERVED` のまま残さない）。
    let writeSpec: WorkerStartWrite | null = null;
    if (grant !== null) {
      const prepared = await this.#prepareWrite({
        jobId, stored, grant, outputDirectory,
        startOf: (write) => ({
          protocol: WORKER_PROTOCOL_VERSION, type: 'START', jobId, jobKind, targetConfigPath, startNew, targetConfigSha256: digestBefore,
          ...(authentication === null ? {} : { authentication }), write,
        }),
      });
      if (typeof prepared === 'string') {
        const at = this.#timestamp();
        this.#guarded(() => closeWriteWithoutSending(this.#database, { grantId: grant.grantId, jobId, at }));
        this.#endUntracked(jobId, 'FAILED', WRITE_GRANT_REJECTED_REASON);
        return startRejected(prepared);
      }
      writeSpec = prepared;
    }

    // 4. ワーカーを起動する。
    this.#launchWorker({
      jobId, jobKind, profileId, outputDirectory, targetConfigPath, startNew, targetConfigSha256: digestBefore, authentication, readChecks, writeSpec,
    });
    const job = readJob(this.#database, jobId);
    if (job === null) {
      throw new Error(`the audit job ${jobId} disappeared right after it was created`);
    }
    return Object.freeze({ ok: true, job });
  }

  /**
   * READ の確かめの定義を、`START` の定義の一覧にする（T27e）。対象の候補の画面は、索引で対象の候補を最後に見た発見のジョブの `discovery.json`
   * （出力先の、そのジョブの Run のディレクトリ）から決める。索引にない、ジョブの行や成果物を読めない、成果物に候補がないときは `null`。
   */
  async #readCheckLaunches(
    profileId: string,
    definitions: readonly ReadCheckView[],
    outputDirectory: string,
  ): Promise<readonly WorkerStartReadCheck[]> {
    const index = readDiscoveryIndex(this.#database, profileId);
    const documents = new Map<string, DiscoveryDocument | null>();
    const documentOf = async (jobId: string): Promise<DiscoveryDocument | null> => {
      if (!documents.has(jobId)) {
        const runDirectory = readJob(this.#database, jobId)?.runDirectory ?? null;
        const value = runDirectory === null
          ? null
          : await this.#readRunArtifact(outputDirectory, runDirectory, DISCOVERY_ARTIFACT_FILE_NAME, 'discovery');
        documents.set(jobId, value !== null && (value as DiscoveryDocument).jobId === jobId ? value as DiscoveryDocument : null);
      }
      return documents.get(jobId) ?? null;
    };
    const launches: WorkerStartReadCheck[] = [];
    for (const { readCheckId, revision, definition } of definitions) {
      const entry = index.candidates.find(({ identityDigest }) => identityDigest === definition.targetIdentityDigest);
      const document = entry === undefined ? null : await documentOf(entry.lastSeenJobId);
      const candidate = document === null
        ? undefined
        : discoveryCandidatesOf(document).find(({ identityDigest }) => identityDigest === definition.targetIdentityDigest);
      const targetPage: CandidateLocation | null = candidate === undefined ? null : { origin: candidate.page.origin, path: candidate.page.path };
      launches.push(deepFreeze({ readCheckId, readCheckRevision: revision, targetPage, definition }));
    }
    return Object.freeze(launches);
  }

  /**
   * 出力先（`outputDirectory`）の Run のディレクトリ（`runDirectory`。出力先からの相対）の成果物（`fileName`）を、リンクをたどらずに読み
   * （`readContainedArtifactFile`）、成果物のスキーマ（`schema`）で確かめた値を返す（T27d・T27e で共有）。読めない・JSON でない・合わなければ
   * `null`。例外を投げない。
   */
  async #readRunArtifact(outputDirectory: string, runDirectory: string, fileName: string, schema: ArtifactSchemaName): Promise<unknown> {
    try {
      const read = await readContainedArtifactFile(outputDirectory, `${runDirectory}/${fileName}`);
      if (!read.ok) {
        return null;
      }
      const value: unknown = JSON.parse(read.bytes.toString('utf8'));
      return (await validateArtifact(schema, value)).ok ? value : null;
    } catch {
      return null;
    }
  }

  /** ターゲット JSON（リポジトリの root からの相対パス）の内容の SHA-256。読めなければ `null`。 */
  async #targetConfigDigest(targetConfigPath: string): Promise<string | null> {
    try {
      return targetConfigDigestOf(await readFile(join(this.#repositoryRoot, targetConfigPath)));
    } catch {
      return null;
    }
  }

  /** ワーカーを起動できなかった（追う前）。T30e: 書き込みのジョブは、送らずに止めたとして締めてから、ジョブの行を `FAILED` にする。 */
  #failLaunch(launch: WorkerLaunch): void {
    if (launch.writeSpec !== null) {
      const { grantId } = launch.writeSpec;
      const at = this.#timestamp();
      this.#guarded(() => closeWriteWithoutSending(this.#database, { grantId, jobId: launch.jobId, at }));
    }
    this.#endUntracked(launch.jobId, 'FAILED', 'WORKER_START_FAILED');
  }

  #launchWorker(launch: WorkerLaunch): void {
    const { jobId } = launch;
    if (!existsSync(this.#workerPath)) {
      this.#failLaunch(launch);
      return;
    }
    let child: ChildProcess;
    try {
      child = this.#forkWorker(this.#workerPath, WORKER_ARGS, {
        cwd: this.#repositoryRoot,
        detached: false,
        stdio: WORKER_STDIO,
        execArgv: [...WORKER_EXEC_ARGV],
        serialization: WORKER_SERIALIZATION,
        // T26d-2: デバッグの出力を有効にする変数を外した環境（ほかの変数は、そのまま渡す）。
        env: workerEnvironmentOf(process.env),
      });
    } catch (error) {
      this.#onBackgroundError(error);
      this.#failLaunch(launch);
      return;
    }
    let resolveExited: () => void = () => undefined;
    const exited = new Promise<void>((resolvePromise) => {
      resolveExited = resolvePromise;
    });
    const job: TrackedJob = {
      ...launch,
      child,
      automatedLoginReported: false,
      write: launch.writeSpec === null ? null : {
        grantId: launch.writeSpec.grantId,
        scenarioId: launch.writeSpec.scenarioId,
        scenarioRevision: launch.writeSpec.scenarioRevision,
        recheckRequested: false,
        recheckAllowed: false,
        rejected: false,
        submission: null,
      },
      startSent: false,
      phase: 'FORKED',
      runStarted: null,
      ending: null,
      exitTimer: undefined,
      processExited: false,
      stopRequested: false,
      forceRequested: false,
      lastHeartbeatMs: performance.now(),
      lastProgressWriteMs: Number.NEGATIVE_INFINITY,
      pendingProgress: null,
      readyTimer: undefined,
      killTimer: undefined,
      progressTimer: undefined,
      exited,
    };
    this.#jobs.set(jobId, job);
    child.on('message', (value: unknown) => this.#guarded(() => this.#receive(job, value)));
    child.on('error', (error) => {
      this.#onBackgroundError(error);
      this.#guarded(() => this.#end(job, 'FAILED', 'WORKER_START_FAILED'));
      this.#kill(job);
    });
    child.on('exit', (code) => {
      // DEF-084: 子が最後に送ったメッセージは、`exit` より後に届くことがある。IPC が切れるか期限まで待ち（待つ間のメッセージは `#receive` で
      // 処理する）、それでも終わり方が決まっていなければ、その場で `WORKER_EXITED` に決める（以後のメッセージは捨てる。結果のファイルを読む間に
      // `FINISHED` が割り込まないように、読む前に決める）。
      job.processExited = true;
      void this.#drainIpc(job)
        .then(() => {
          this.#guarded(() => this.#end(job, 'INTERRUPTED', 'WORKER_EXITED'));
          // T27d: 発見のジョブの Run を実行した結果は、`discovery.json` を読んで確かめてから記録する（読む間も、ジョブは管理の中に残る）。
          // T27e: READ の確かめのジョブの Run を実行した結果も、`read-evidence.json` を読んで確かめてから記録する。
          return this.#readJobResult(job);
        })
        .then((verdict) => this.#guarded(() => this.#exited(job, code, verdict)))
        .finally(resolveExited);
    });
    if (child.pid === undefined) {
      // 起動できなかった（`error` の事象が後から来る。`exit` は来ないことがあるので、ここで記録して管理から外す）。
      this.#guarded(() => this.#end(job, 'FAILED', 'WORKER_START_FAILED'));
      this.#guarded(() => this.#exited(job, null));
      resolveExited();
      return;
    }
    this.#guarded(() => recordWorkerPid(this.#database, jobId, child.pid ?? 0));
    job.readyTimer = setTimeout(() => this.#guarded(() => {
      // DEF-084: process が終わって IPC の終わりを待つ間は、ここで終わらせない（待ち終わりに決める）。
      if (job.phase === 'FORKED' && !job.processExited) {
        this.#end(job, 'FAILED', 'WORKER_NOT_READY');
        this.#kill(job);
      }
    }), this.#timing.readyTimeoutMs);
  }

  /**
   * ワーカーの `exit` の後に、IPC が切れる（`disconnect`）か、名前つきの期限（`ipcDrainWaitMs`）の早い方まで待つ（DEF-084。`disconnect` は、
   * 子が最後に送ったメッセージより後に来る）。IPC がもう切れていれば待たない。
   */
  #drainIpc(job: TrackedJob): Promise<void> {
    const { child } = job;
    if (!child.connected) {
      return Promise.resolve();
    }
    return new Promise<void>((resolvePromise) => {
      const done = (): void => {
        clearTimeout(timer);
        child.off('disconnect', done);
        resolvePromise();
      };
      const timer = setTimeout(done, this.#timing.ipcDrainWaitMs);
      child.once('disconnect', done);
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // IPC
  // -------------------------------------------------------------------------------------------------------------

  #receive(job: TrackedJob, value: unknown): void {
    if (job.phase === 'DONE') {
      return;
    }
    const checked = validateWorkerToParentMessage(value);
    if (!checked.ok) {
      this.#violate(job);
      return;
    }
    const message = checked.message;
    switch (message.type) {
      case 'READY':
        if (job.phase !== 'FORKED') {
          this.#violate(job);
          return;
        }
        clearTimeout(job.readyTimer);
        job.phase = 'STARTED';
        this.#heartbeat(job);
        if (job.stopRequested) {
          // `START` の前に止める要求を受けていた: Run を始めさせない（ワーカーは `START` の前の `STOP` で終わる）。
          this.#send(job, { protocol: WORKER_PROTOCOL_VERSION, type: 'STOP', force: job.forceRequested });
          return;
        }
        job.startSent = true;
        this.#send(job, {
          protocol: WORKER_PROTOCOL_VERSION,
          type: 'START',
          jobId: job.jobId,
          jobKind: job.jobKind,
          targetConfigPath: job.targetConfigPath,
          startNew: job.startNew,
          targetConfigSha256: job.targetConfigSha256,
          ...(job.authentication === null ? {} : { authentication: job.authentication }),
          ...(job.readChecks === null ? {} : { readChecks: job.readChecks }),
          ...(job.writeSpec === null ? {} : { write: job.writeSpec }),
        });
        return;
      case 'RUN_STARTED':
        // Run のディレクトリは、その Run の ID の名前（新しい Run も、再開する Run も。T24h-1 の M1）。違えば信用しない。ログインの検証は
        // Run を作らない（T26d-2）。
        if (job.phase !== 'STARTED' || message.runDirectory !== message.runId || job.jobKind === WORKER_LOGIN_CHECK_JOB_KIND) {
          this.#violate(job);
          return;
        }
        job.phase = 'RUN';
        job.runStarted = { runId: message.runId, runDirectory: message.runDirectory };
        recordRunStarted(this.#database, job.jobId, { runId: message.runId, runDirectory: message.runDirectory, startedAt: this.#timestamp() });
        return;
      case 'PROGRESS':
        if (job.phase !== 'RUN') {
          this.#violate(job);
          return;
        }
        this.#progress(job, message.report);
        return;
      case 'NOTICE':
        if (job.phase !== 'RUN') {
          this.#violate(job);
          return;
        }
        recordNotice(this.#database, job.jobId, message.notice);
        return;
      case 'AUTH_STATE': {
        // T25d: 認証つきのジョブだけが送る。セッションの切れ（`SESSION_LOST`）は Run の途中（`RUN_STARTED` の後）だけ、ほかの状態は
        // ログインの段（`START` の後、`RUN_STARTED` の前）だけ。違えば信用しない。値は持たない（止まったページの URL だけ）。
        const sessionLost = message.state === WORKER_SESSION_LOST_STATE;
        if (job.authentication === null || job.phase !== (sessionLost ? 'RUN' : 'STARTED')) {
          this.#violate(job);
          return;
        }
        // T26d-2: 自動ログインのジョブのログインの段は、結果つきの状態を 1 回だけ送る。手動のログインのジョブは、結果を送らない。
        const report = message.automatedLogin;
        const automated = job.authentication.automatedLogin !== undefined;
        const expectsReport = automated && !sessionLost;
        if (expectsReport !== (report !== undefined) || (report !== undefined && job.automatedLoginReported)) {
          this.#violate(job);
          return;
        }
        if (report !== undefined) {
          if (!this.#isRecordableReport(report)) {
            this.#violate(job);
            return;
          }
          job.automatedLoginReported = true;
          recordAutoLoginResult(this.#database, {
            jobId: job.jobId,
            result: report.result,
            submitted: report.submitted,
            retryAfterUntil: report.retryAfterUntil,
            formInvalidReason: report.formInvalidReason,
            // DEF-099 fix round 1: 送った後に応答がなかった回は、試しを 2 回と数える（記録の owner が 2 行書く）。
            ...(report.responseAfterSubmission === undefined ? {} : { responseAfterSubmission: report.responseAfterSubmission }),
            at: this.#timestamp(),
          });
        }
        recordAuthState(this.#database, job.jobId, message.state, message.sessionLostUrl);
        if (job.jobKind === WORKER_LOGIN_CHECK_JOB_KIND && message.state === 'AUTHENTICATED') {
          // ログインの検証の成功: Run を作らないので、ここで終わり方を決める（記録はワーカーが終わった後）。
          this.#settle(job, { kind: 'LOGIN_CHECKED' });
          this.#awaitExit(job);
        }
        return;
      }
      case 'HEARTBEAT':
        if (job.phase === 'FORKED') {
          this.#violate(job);
          return;
        }
        this.#heartbeat(job);
        return;
      case 'FINISHED': {
        // T27d: 件数の要約は、発見のジョブの Run を実行した結果（`RAN`）だけが、必ず持つ（ほかのジョブと結果は持たない）。
        // T27e: READ の確かめの件数の要約も同じ（READ の確かめのジョブの Run を実行した結果だけが、必ず持つ）。
        const ran = message.outcome.kind === 'RAN';
        const expectsSummary = job.jobKind === WORKER_DISCOVERY_JOB_KIND && ran;
        const expectsReadCheckSummary = job.jobKind === WORKER_READ_CHECK_JOB_KIND && ran;
        if (
          (job.phase !== 'STARTED' && job.phase !== 'RUN')
          || !this.#matchesRunStarted(job, message.outcome)
          || job.jobKind === WORKER_LOGIN_CHECK_JOB_KIND
          || expectsSummary !== (message.discovery !== undefined)
          || expectsReadCheckSummary !== (message.readCheck !== undefined)
        ) {
          this.#violate(job);
          return;
        }
        this.#settle(job, {
          kind: 'FINISHED',
          outcome: message.outcome,
          discovery: message.discovery ?? null,
          readCheck: message.readCheck ?? null,
        });
        this.#awaitExit(job);
        return;
      }
      case 'WRITE_RECHECK_REQUEST': {
        // T30e: 書き込みのジョブの `START` の後だけ。2 回目は、拒む結果を返して止める。
        const write = job.write;
        if (write === null || (job.phase !== 'STARTED' && job.phase !== 'RUN')) {
          this.#violate(job);
          return;
        }
        if (write.recheckRequested) {
          this.#rejectWrite(job, 'RECHECK_REPEATED');
          return;
        }
        write.recheckRequested = true;
        void this.#recheckWrite(job, write);
        return;
      }
      case 'WRITE_SUBMISSION': {
        // T30e: 書き込みのジョブの `START` の後だけ、1 回だけ。送った・分からないは、許した確かめ直しの後だけ（報告は、締めのために先に残す）。
        const write = job.write;
        if (write === null || write.submission !== null || (job.phase !== 'STARTED' && job.phase !== 'RUN')) {
          this.#violate(job);
          return;
        }
        write.submission = { submission: message.submission, blockReason: message.blockReason };
        if (message.submission !== 'NOT_SENT' && !write.recheckAllowed) {
          this.#violate(job);
        }
        return;
      }
      case 'FAILED':
        this.#settle(job, { kind: 'ENDED', state: 'FAILED', reason: message.reason });
        if (message.reason === 'PROTOCOL_VIOLATION') {
          // ワーカー自身が契約に反した: 待たずに止める（終わりの記録は、終わった後）。
          this.#kill(job);
        } else {
          this.#awaitExit(job);
        }
        return;
    }
  }

  /** 送る直前の確かめ直しを拒む（T30e）: 拒む結果を返し、`STOP` を送る（ジョブは `FAILED`（`WRITE_GRANT_REJECTED`）で終わる）。 */
  #rejectWrite(job: TrackedJob, reason: WorkerWriteRecheckRejectionReason): void {
    if (job.write === null) {
      return;
    }
    job.write.rejected = true;
    this.#send(job, { protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_RECHECK_RESULT', allowed: false, reason });
    this.#requestStop(job, false);
  }

  /**
   * 送る直前の確かめ直し（T30e）: 管理データの外の事実（`approvalExternalFactsOf`）と、許可の確かめ直し（`assertGrantStillValid`）を求め直して、
   * 許すか拒む結果を返す。待つ間にジョブが終わった・拒んだときは、何も返さない（ワーカーは上限の時間の後に送らない）。
   */
  async #recheckWrite(job: TrackedJob, write: WriteJobState): Promise<void> {
    let reason: WorkerWriteRecheckRejectionReason | null = null;
    try {
      const stored = getProfile(this.#database, job.profileId);
      const facts = stored === null ? null : await approvalExternalFactsOf(stored, {
        database: this.#database, repositoryRoot: this.#repositoryRoot, credentialStore: this.#credentials(),
      });
      if (facts === null) {
        reason = 'FACTS_UNAVAILABLE';
      } else {
        const check = assertGrantStillValid(this.#database, {
          grantId: write.grantId, scenarioId: write.scenarioId, scenarioRevision: write.scenarioRevision, jobId: job.jobId, profileId: job.profileId,
          external: facts, now: this.#now(),
        });
        reason = check.ok ? null : 'GRANT_INVALID';
      }
    } catch (error) {
      this.#onBackgroundError(error);
      reason = 'GRANT_INVALID';
    }
    if (job.phase === 'DONE' || job.processExited || write.rejected) {
      return;
    }
    if (reason !== null) {
      this.#guarded(() => this.#rejectWrite(job, reason));
      return;
    }
    write.recheckAllowed = true;
    this.#send(job, { protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_RECHECK_RESULT', allowed: true, reason: null });
  }

  /**
   * 書き込みのジョブの準備（T30e。ジョブの行を作った後）: 許可の消費、値の生成、`START` の書き込みの指定、送る前の記録。受けたら書き込みの指定、
   * 止まったら開始を拒む理由（予約の締めは呼ぶ側）。
   */
  async #prepareWrite(input: {
    readonly jobId: string;
    readonly stored: NonNullable<ReturnType<typeof getProfile>>;
    readonly grant: ExecutionGrantView;
    readonly outputDirectory: string;
    readonly startOf: (write: WorkerStartWrite) => ParentToWorkerMessage;
  }): Promise<WorkerStartWrite | 'WRITE_GRANT_REJECTED' | 'WRITE_DATA_NOT_GENERATED'> {
    const { jobId, stored, grant } = input;
    const { profileId } = stored.profile;
    try {
      const facts = await approvalExternalFactsOf(stored, {
        database: this.#database, repositoryRoot: this.#repositoryRoot, credentialStore: this.#credentials(),
      });
      if (facts === null) {
        return 'WRITE_GRANT_REJECTED';
      }
      const at = this.#timestamp();
      const consumed = consumeExecutionGrant(this.#database, {
        grantId: grant.grantId, scenarioId: grant.scenarioId, scenarioRevision: grant.scenarioRevision, jobId, profileId, external: facts, at,
      });
      if (!consumed.ok) {
        return 'WRITE_GRANT_REJECTED';
      }
      const revision = readScenarioRevisions(this.#database, grant.scenarioId).find(({ revision: value }) => value === grant.scenarioRevision);
      const rules = readLatestRuleSet(this.#database, grant.scenarioId);
      const readVerification = revision?.scenario.verification.readVerification ?? null;
      const readCheck = readVerification === null
        ? undefined
        : listReadChecks(this.#database, profileId).find(({ readCheckId }) => readCheckId === readVerification.readCheckId);
      if (revision === undefined || rules === null || readCheck === undefined) {
        return 'WRITE_DATA_NOT_GENERATED';
      }
      // T32d（Task 32 の設計書 4.1 の「承認の要約の受け渡し」）: 書き込みの報告の承認の要約の事実。値は、消費の結果（許可・予約。消費と同じ
      // トランザクションで書いた値）、許可の版のシナリオ、承認と撤回の記録（追記だけの表）、累積の使った件数（消費の時刻で数える）。後の 2 つは、
      // 消費の直後の読むトランザクションで読む（開始の時点の値。承認の判断はしない。食い違えば始めない）。
      const approvalFacts = approvalSummaryFactsOf({
        grant: consumed.grant,
        scenario: revision.scenario,
        receipts: readApprovalReceipts(this.#database, grant.scenarioId),
        usedCumulativeWrites: readUsedCumulativeWrites(this.#database, grant.scenarioId, dateOfCompactUtcTimestamp(at)),
        capturedAt: at,
      });
      if (approvalFacts === null) {
        return 'WRITE_GRANT_REJECTED';
      }
      // T31f（T31e の申し送り）: 生成の履歴は、同じ台帳の CREATE と UPDATE の使った値（一意にする欄の組は、生成の判定のもの）。
      const evaluation = evaluateRuleSet(rules.ruleSet, revision.scenario, revision.evidence);
      const history = readScenarioWriteGenerationHistory(this.#database, grant.scenarioId, evaluation.uniqueKeyFieldNames);
      const generated = generateScenarioData({
        ruleSet: rules.ruleSet,
        scenario: revision.scenario,
        candidate: revision.evidence,
        seedInput: {
          profileId,
          scenarioId: grant.scenarioId,
          scenarioRevision: grant.scenarioRevision,
          ruleSetDigest: rules.reference.digest,
          executionGrantId: grant.grantId,
        },
        usedUniqueKeys: history.usedUniqueKeys,
        usedPhoneNumbers: history.usedPhoneNumbers,
        baseDate: writeBaseDateOf(grant.issuedAt),
      });
      if (!generated.ok) {
        return 'WRITE_DATA_NOT_GENERATED';
      }
      const [launch] = await this.#readCheckLaunches(profileId, [readCheck], input.outputDirectory);
      const spec = writeStartSpecOf({
        scenario: revision.scenario, evidence: revision.evidence, grantId: grant.grantId, values: generated.values, readCheck,
        targetPage: launch?.targetPage ?? null,
        // T30f（Blocker 1 の案 A）: 送る前の記録に書くのと同じプロファイルと seed の記録。
        profileId, seedRecord: generated.seedRecord,
        // T31f: 更新の対象の ID は、許可からだけ取る（CREATE の許可は null）。
        targetRecordId: grant.targetRecordId,
        approvalFacts,
      });
      // 書き込みの指定を、IPC の契約で確かめてから使う（送る値の長さ、送れる欄、照合の READ の上限など）。
      if (spec === null || !validateParentToWorkerMessage(input.startOf(spec)).ok) {
        return 'WRITE_DATA_NOT_GENERATED';
      }
      const submittedValues = Object.fromEntries(Object.entries(generated.values).flatMap(([name, value]) => (value === null ? [] : [[name, value]])));
      const recorded = recordWriteAttempt(this.#database, {
        jobId, grantId: grant.grantId, seedRecord: generated.seedRecord, submittedValues, uniqueKey: generated.uniqueKey,
        phoneNumbers: generated.phoneNumbers, at: this.#timestamp(),
      });
      return recorded.ok ? spec : 'WRITE_GRANT_REJECTED';
    } catch (error) {
      this.#onBackgroundError(error);
      return 'WRITE_GRANT_REJECTED';
    }
  }

  /** 自動ログインの結果を記録できるか（T26d-2。`Retry-After` の期限が、実在する時刻か）。 */
  #isRecordableReport(report: WorkerAutomatedLoginReport): boolean {
    if (report.retryAfterUntil === null) {
      return true;
    }
    try {
      dateOfCompactUtcTimestamp(report.retryAfterUntil);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 結果の Run の ID と Run のディレクトリが、`RUN_STARTED` で受けたものと同じか（T24h-1 の M1）。`RUN_STARTED` を受けていなければ、
   * Run を実行した結果（`RAN`）ではないこと（Run を始めなかった結果だけ）。
   */
  #matchesRunStarted(job: TrackedJob, outcome: WorkerRunOutcome): boolean {
    if (job.runStarted === null) {
      return outcome.kind !== 'RAN';
    }
    return outcome.runId === job.runStarted.runId && outcome.runDirectory === job.runStarted.runDirectory;
  }

  /**
   * 契約に反した: 信用しない（ジョブを `FAILED`（`PROTOCOL_VIOLATION`）に決め、ワーカーを止める）。記録はワーカーが終わった後で、それまで
   * 同時に 1 つの枠は空かない（T24h-1 の M2）。
   */
  #violate(job: TrackedJob): void {
    this.#end(job, 'FAILED', 'PROTOCOL_VIOLATION');
    this.#kill(job);
  }

  /** 結果を受けた後、名前つきの時間の中に終わらないワーカーを止める（T24h-1 の M2）。 */
  #awaitExit(job: TrackedJob): void {
    if (job.exitTimer === undefined) {
      job.exitTimer = setTimeout(() => this.#kill(job), this.#timing.exitWaitMs);
    }
  }

  #heartbeat(job: TrackedJob): void {
    job.lastHeartbeatMs = performance.now();
    recordHeartbeat(this.#database, job.jobId, this.#timestamp());
  }

  /** 最後の進み具合を、最短の間隔で間引いて書く（間の値は、最後のものだけを後で書く）。 */
  #progress(job: TrackedJob, report: TrackedJob['pendingProgress']): void {
    job.pendingProgress = report;
    const elapsed = performance.now() - job.lastProgressWriteMs;
    if (elapsed >= this.#timing.progressWriteIntervalMs) {
      this.#flushProgress(job);
      return;
    }
    if (job.progressTimer === undefined) {
      job.progressTimer = setTimeout(() => this.#guarded(() => {
        job.progressTimer = undefined;
        this.#flushProgress(job);
      }), this.#timing.progressWriteIntervalMs - elapsed);
    }
  }

  #flushProgress(job: TrackedJob): void {
    clearTimeout(job.progressTimer);
    job.progressTimer = undefined;
    const report = job.pendingProgress;
    if (report === null) {
      return;
    }
    job.pendingProgress = null;
    job.lastProgressWriteMs = performance.now();
    recordProgress(this.#database, job.jobId, report);
  }

  #send(job: TrackedJob, message: ParentToWorkerMessage): void {
    try {
      // DEF-084: 終わった process には送らない（IPC の終わりを待つ間も、まだつながって見えることがある）。
      if (job.child.connected && !job.processExited) {
        job.child.send(message);
      }
    } catch (error) {
      this.#onBackgroundError(error);
    }
  }

  /**
   * ワーカーが終わった: 決まった終わり方を記録する（T24h-1 の M2。ここで初めて、ジョブは終わりの状態になり、同時に 1 つの枠が空く）。
   * 決まっていなければ（結果の前に終わった）`INTERRUPTED`（`WORKER_EXITED`）。終了コードは、結果があれば結果のもの（I15）、なければ
   * process の終了コード。
   */
  #exited(job: TrackedJob, code: number | null, result: JobResultVerdict | null = null): void {
    this.#jobs.delete(job.jobId);
    this.#clearTimers(job);
    if (job.ending === null) {
      this.#settle(job, { kind: 'ENDED', state: 'INTERRUPTED', reason: 'WORKER_EXITED' });
    }
    const ending = job.ending ?? { kind: 'ENDED', state: 'INTERRUPTED', reason: 'WORKER_EXITED' };
    const at = this.#timestamp();
    let failedReason = ending.kind === 'FINISHED' && result !== null ? this.#recordJobResult(job, result, at) : null;
    // T30e: 書き込みのジョブは、ジョブを終わりの状態にする前に、書き込みの結果を必ず 1 回締める。確かめ直しで拒んだジョブは `WRITE_GRANT_REJECTED`、
    // Run を実行した結果の `action-run.json` を使えなかったジョブは `WRITE_RESULT_INVALID` で `FAILED`。
    if (job.write !== null) {
      const fromDocument = this.#settleWrite(job, result, at);
      if (job.write.rejected) {
        failedReason = WRITE_GRANT_REJECTED_REASON;
      } else if (ending.kind === 'FINISHED' && ending.outcome.kind === 'RAN' && !fromDocument) {
        failedReason = WRITE_RESULT_INVALID_REASON;
      }
      // T32g: Run を実行した結果のジョブは、報告の確かめの結果を、書き込みの結果の締めと同じ時点で 1 回だけ記録する（`action-run.json` を使えた
      // ときは照らした結果、使えなかったときは `RESULT_INVALID`）。結果の前に終わったジョブは記録しない（画面は報告を配らない）。報告の不一致は、
      // 締めた書き込みの結果を変えない。
      if (ending.kind === 'FINISHED' && ending.outcome.kind === 'RAN') {
        const reportCheck: WriteReportCheck = fromDocument && result?.kind === 'WRITE' ? result.reportCheck : WRITE_REPORT_RESULT_INVALID;
        this.#guarded(() => recordWriteReportCheck(this.#database, job.jobId, reportCheck));
      }
    }
    if (failedReason !== null) {
      // T27d: 発見の結果を読めない・合わない・索引に記録できない。索引を変えずに `FAILED`。
      // T27e: READ の確かめの結果を読めない・合わない・記録できない。結果を記録せずに `FAILED`。
      recordEnded(this.#database, job.jobId, { state: 'FAILED', reason: failedReason, exitCode: recordableExitCode(code), at });
    } else if (ending.kind === 'FINISHED') {
      recordFinished(this.#database, job.jobId, ending.outcome, at);
    } else if (ending.kind === 'LOGIN_CHECKED') {
      recordLoginCheckFinished(this.#database, job.jobId, recordableExitCode(code), at);
    } else {
      recordEnded(this.#database, job.jobId, { state: ending.state, reason: ending.reason, exitCode: recordableExitCode(code), at });
    }
    // T26d-2: どの終わり方でも、結果のない自動ログインの試しを閉じる（結果を受けていれば何もしない）。ワーカーを起動できなかった（`START` を
    // 送っていない）なら送信 `NO`（止めない。round 1）、ほかは `AUTH_RESULT_UNKNOWN`・送信 `UNKNOWN`（止める）。
    if (!job.startSent && ending.kind === 'ENDED' && ending.reason === 'WORKER_START_FAILED') {
      this.#closeAttemptNotSent(job.jobId, at);
    } else {
      closePendingAutoLoginAttempt(this.#database, job.jobId, at);
    }
  }

  /**
   * ジョブの結果のファイルを読んで確かめる（T27d の発見、T27e の READ の確かめ）。Run を実行した結果（`FINISHED` の `RAN`）でなければ、または発見と
   * READ の確かめでなければ `null`（今までどおりに記録する）。例外を投げない。
   */
  async #readJobResult(job: TrackedJob): Promise<JobResultVerdict | null> {
    const ending = job.ending;
    if (ending?.kind !== 'FINISHED' || ending.outcome.kind !== 'RAN') {
      return null;
    }
    if (job.jobKind === WORKER_DISCOVERY_JOB_KIND) {
      return this.#readDiscoveryResult(job, ending);
    }
    if (job.jobKind === WORKER_READ_CHECK_JOB_KIND) {
      return this.#readReadCheckResult(job, ending);
    }
    if (isWorkerWriteJobKind(job.jobKind)) {
      return this.#readWriteResult(job, ending);
    }
    return null;
  }

  /**
   * 書き込みのジョブの結果（`action-run.json`）を読んで確かめる（T30e）。出力先の Run のディレクトリの `action-run.json` を、リンクをたどらずに読み、
   * 成果物のスキーマ（`action-run`）、ジョブの ID、Run の ID、プロファイル、シナリオと版、許可、送信の報告（受けていれば同じ送信の状態と止めた理由）を
   * 確かめる。T31f: `update`（UPDATE の記録）は、UPDATE のジョブだけが持ち、対象の ID が `START` で写した値（許可の対象の ID）と同じ。どれかが
   * 通らなければ `INVALID`。例外を投げない。
   */
  async #readWriteResult(job: TrackedJob, ending: Extract<JobEnding, { readonly kind: 'FINISHED' }>): Promise<JobResultVerdict> {
    const { runId, runDirectory } = ending.outcome;
    const write = job.write;
    if (runDirectory === null || write === null) {
      return WRITE_RESULT_INVALID;
    }
    const value = await this.#readRunArtifact(job.outputDirectory, runDirectory, ACTION_RUN_ARTIFACT_FILE_NAME, 'action-run');
    if (value === null) {
      return WRITE_RESULT_INVALID;
    }
    const document = value as ActionRunDocument;
    const reported = write.submission;
    if (
      document.jobId !== job.jobId
      || document.runId !== runId
      || document.profileId !== job.profileId
      || document.scenarioId !== write.scenarioId
      || document.scenarioRevision !== write.scenarioRevision
      || document.grantId !== write.grantId
      // T30f: seed の記録は、START で送ったものと同じ（ほかの生成の記録を書いた成果物は使わない）。
      || job.writeSpec === null
      || sortedKeysJsonOf(document.seedRecord) !== sortedKeysJsonOf(job.writeSpec.seedRecord)
      || (reported !== null && (document.submission !== reported.submission || document.blockReason !== reported.blockReason))
      || (document.update?.targetRecordId ?? null) !== (job.writeSpec.update?.targetRecordId ?? null)
    ) {
      return WRITE_RESULT_INVALID;
    }
    // T32g: 報告（2 つの JSON、HTML、バンドル）を照らす（`START` の承認の要約の事実との一致は、親のメモリにあるここでだけ照らせる）。
    const reportCheck = await checkWriteReport({
      actionRun: document,
      approvalFacts: job.writeSpec.approvalFacts,
      readFile: async (fileName) => {
        const read = await readContainedArtifactFile(job.outputDirectory, `${runDirectory}/${fileName}`);
        return read.ok ? read.bytes : null;
      },
    });
    return Object.freeze({ kind: 'WRITE', document, reportCheck });
  }

  /**
   * 書き込みの結果を締める（T30e。ジョブの終わりで必ず 1 回。ジョブを終わりの状態にする前）。`START` を送っていなければ送らずに止めたとして締める。
   * `action-run.json` を使えたら、その中身を `settleWriteResult` に渡す（判定は締めの部品が決め直す）。使えない・食い違う・締められないときは、送信の
   * 報告から（`NOT_SENT` なら `NOT_SENT`、ほかは `UNKNOWN`）締める。`action-run.json` から締めたかを返す。
   */
  #settleWrite(job: TrackedJob, result: JobResultVerdict | null, at: string): boolean {
    const write = job.write;
    if (write === null) {
      return false;
    }
    if (!job.startSent) {
      this.#guarded(() => closeWriteWithoutSending(this.#database, { grantId: write.grantId, jobId: job.jobId, at }));
      return false;
    }
    if (result?.kind === 'WRITE') {
      const { document } = result;
      try {
        const settled = settleWriteResult(this.#database, {
          jobId: job.jobId,
          submission: document.submission,
          blockReason: document.blockReason,
          httpStatus: document.httpStatus,
          responseJudgement: document.responseJudgement,
          recordId: document.recordId,
          readVerification: document.readVerification?.result ?? null,
          submittedAt: document.submittedAt,
          // T31f: UPDATE は、更新の後の照合の証拠（欄ごとの一致）も渡す（取れた ID は `recordId`。対象の ID は、締めの部品が記録の行から読む）。
          updateEvidence: document.update?.updateEvidence ?? null,
          at,
        });
        if (settled.ok) {
          return true;
        }
      } catch (error) {
        if (!(error instanceof RangeError)) {
          this.#onBackgroundError(error);
        }
      }
    }
    const reported = write.submission;
    const fallback: WriteOutcomeReport = reported?.submission === 'NOT_SENT' && reported.blockReason !== null
      ? { jobId: job.jobId, submission: 'NOT_SENT', blockReason: reported.blockReason, httpStatus: null, responseJudgement: null, recordId: null,
        readVerification: null, submittedAt: null, at }
      : { jobId: job.jobId, submission: 'UNKNOWN', blockReason: null, httpStatus: null, responseJudgement: null, recordId: null,
        readVerification: null, submittedAt: null, at };
    this.#guarded(() => settleWriteResult(this.#database, fallback));
    return false;
  }

  /**
   * 発見のジョブの結果（`discovery.json`）を読んで確かめる（T27d。Task 27 の設計書の変更履歴「T27b・T27c の報告と T27d の前の判断」の (3)、
   * 「Blocker: T27d」の行）。
   * - 出力先（開始の直前のターゲット設定）の、Run のディレクトリの `discovery.json` を、リンクをたどらずに読む（`#readRunArtifact`）。
   * - 成果物のスキーマ（`discovery`）、ジョブの ID、Run の ID、Run Status、`FINISHED` の件数の要約と、ファイルから求めた件数の一致を確かめる。
   * どれかが通らなければ `INVALID`。例外を投げない。
   */
  async #readDiscoveryResult(job: TrackedJob, ending: Extract<JobEnding, { readonly kind: 'FINISHED' }>): Promise<JobResultVerdict> {
    const { runId, runDirectory, runStatus } = ending.outcome;
    if (runDirectory === null) {
      return DISCOVERY_RESULT_INVALID;
    }
    const value = await this.#readRunArtifact(job.outputDirectory, runDirectory, DISCOVERY_ARTIFACT_FILE_NAME, 'discovery');
    if (value === null) {
      return DISCOVERY_RESULT_INVALID;
    }
    const document = value as DiscoveryDocument;
    const summary = discoverySummaryOf(document);
    const reported = ending.discovery;
    if (
      document.jobId !== job.jobId
      || document.runId !== runId
      || document.runStatus !== runStatus
      || reported === null
      || summary.pagesRead !== reported.pagesRead
      || summary.pagesNotRead !== reported.pagesNotRead
      || summary.candidates !== reported.candidates
    ) {
      return DISCOVERY_RESULT_INVALID;
    }
    return Object.freeze({ kind: 'DISCOVERY', document });
  }

  /**
   * READ の確かめのジョブの結果（`read-evidence.json`）を読んで確かめる（T27e）。出力先の Run のディレクトリの `read-evidence.json` を、リンクを
   * たどらずに読み、成果物のスキーマ（`read-evidence`）、ジョブの ID、Run の ID、Run Status、`FINISHED` の件数の要約、定義の一覧（`START` の定義と
   * 同じ ID・版・対象の識別の digest が同じ順）を確かめる。どれかが通らなければ `INVALID`。例外を投げない。
   */
  async #readReadCheckResult(job: TrackedJob, ending: Extract<JobEnding, { readonly kind: 'FINISHED' }>): Promise<JobResultVerdict> {
    const { runId, runDirectory, runStatus } = ending.outcome;
    if (runDirectory === null || job.readChecks === null) {
      return READ_CHECK_RESULT_INVALID;
    }
    const value = await this.#readRunArtifact(job.outputDirectory, runDirectory, READ_EVIDENCE_ARTIFACT_FILE_NAME, 'read-evidence');
    if (value === null) {
      return READ_CHECK_RESULT_INVALID;
    }
    const document = value as ReadEvidenceDocument;
    const summary = readEvidenceSummaryOf(document);
    const reported = ending.readCheck;
    const started = job.readChecks;
    const sameChecks = document.checks.length === started.length && document.checks.every((check, index) =>
      check.readCheckId === started[index]?.readCheckId
      && check.readCheckRevision === started[index]?.readCheckRevision
      && check.targetIdentityDigest === started[index]?.definition.targetIdentityDigest);
    if (
      document.jobId !== job.jobId
      || document.runId !== runId
      || document.runStatus !== runStatus
      || reported === null
      || summary.checks !== reported.checks
      || summary.executed !== reported.executed
      || !sameChecks
    ) {
      return READ_CHECK_RESULT_INVALID;
    }
    return Object.freeze({ kind: 'READ_CHECK', document });
  }

  /**
   * 確かめたジョブの結果を記録する（T27d の発見の索引、T27e の READ の確かめの結果）。ジョブを終わりにする書き込みの前に、別のトランザクションで
   * 行う（途中で落ちたら、記録は済みでジョブは中断になる）。記録できたら（記録しない Run も）`null`、読めない・合わない・記録できなければ、ジョブの
   * 失敗の理由を返す。
   */
  #recordJobResult(job: TrackedJob, result: JobResultVerdict, at: string): AuditJobFailureReason | null {
    switch (result.kind) {
      case 'INVALID':
        return result.reason;
      case 'DISCOVERY':
        return this.#recordDiscoveryIndex(job, result.document, at) ? null : DISCOVERY_RESULT_INVALID_REASON;
      case 'READ_CHECK':
        return this.#recordReadCheckResults(job, result.document, at) ? null : READ_CHECK_RESULT_INVALID_REASON;
      case 'WRITE':
        // T30e: 書き込みの結果は、`#exited` の締め（`#settleWrite`）が記録する。
        return null;
    }
  }

  /**
   * 確かめた発見の結果を、候補の索引に記録する（T27d）。画面を読んだ Run（Run Status が `COMPLETE` か `PARTIAL`）だけ、同じ識別の digest の候補を
   * まとめ（`mergeDiscoveryCandidates`）、読み切れた画面の path（`discoveryReadPagePaths`）とともに、1 つのトランザクションで書く
   * （`recordDiscoveryCandidates`）。記録できたか（記録しない Run も真）を返す。索引が受けない形なら偽。
   */
  #recordDiscoveryIndex(job: TrackedJob, document: DiscoveryDocument, at: string): boolean {
    if (!DISCOVERY_INDEXED_RUN_STATUSES.has(document.runStatus)) {
      return true;
    }
    try {
      recordDiscoveryCandidates(this.#database, {
        profileId: job.profileId,
        jobId: job.jobId,
        at,
        entries: mergeDiscoveryCandidates(discoveryCandidatesOf(document)).map(discoveryIndexEntryOf),
        readPagePaths: discoveryReadPagePaths(document),
      });
      return true;
    } catch (error) {
      if (!(error instanceof RangeError)) {
        this.#onBackgroundError(error);
      }
      return false;
    }
  }

  /**
   * 確かめた READ の確かめの結果を、`read_check_results` に記録する（T27e）。確かめた定義（`EXECUTED`）の結果を、1 つのトランザクションで書く
   * （`recordReadCheckResults`。定義の版が今の版と違う結果は、記録の部品が書かない）。記録できたか（確かめた定義が 0 件でも真）を返す。記録の部品が
   * 受けない形なら偽（何も書かない）。
   */
  #recordReadCheckResults(job: TrackedJob, document: ReadEvidenceDocument, at: string): boolean {
    try {
      recordReadCheckResults(this.#database, document.checks.flatMap((check) => (check.state === 'EXECUTED'
        ? [{ jobId: job.jobId, readCheckId: check.readCheckId, readCheckRevision: check.readCheckRevision, result: check.result, at }]
        : [])));
      return true;
    } catch (error) {
      if (!(error instanceof RangeError)) {
        this.#onBackgroundError(error);
      }
      return false;
    }
  }

  /**
   * ワーカーを起動できなかったジョブの、結果のない自動ログインの試しを、`AUTH_RESULT_UNKNOWN`・送信 `NO` で閉じる（T26d-2 round 1。ワーカーが
   * 動いていないので、ログインの POST は送られていない。止めない）。
   */
  #closeAttemptNotSent(jobId: string, at: string): void {
    recordAutoLoginResult(this.#database, {
      jobId,
      result: AUTOMATED_LOGIN_UNKNOWN_RESULT,
      submitted: AUTOMATED_LOGIN_SUBMISSION_NONE,
      retryAfterUntil: null,
      at,
    });
  }

  /** 終わり方を決める（まだ決まっていなければ）。記録は、ワーカーが終わったとき（`#exited`）。 */
  #settle(job: TrackedJob, ending: JobEnding): void {
    if (job.ending !== null) {
      return;
    }
    this.#flushProgress(job);
    job.ending = ending;
    job.phase = 'DONE';
    this.#clearTimers(job);
  }

  /** ジョブを `FAILED` か `INTERRUPTED` に決める（まだ決まっていなければ）。 */
  #end(job: TrackedJob, state: 'FAILED' | 'INTERRUPTED', reason: AuditJobFailureReason): void {
    this.#settle(job, { kind: 'ENDED', state, reason });
  }

  /** ワーカーを起動しなかったジョブを終わりにする（T26d-2: 結果のない自動ログインの試しも、送信 `NO` で閉じる。round 1）。 */
  #endUntracked(jobId: string, state: 'FAILED' | 'INTERRUPTED', reason: AuditJobFailureReason): void {
    const at = this.#timestamp();
    this.#guarded(() => recordEnded(this.#database, jobId, { state, reason, exitCode: null, at }));
    this.#guarded(() => this.#closeAttemptNotSent(jobId, at));
  }

  #kill(job: TrackedJob): void {
    if (job.child.exitCode === null && job.child.signalCode === null) {
      try {
        job.child.kill();
      } catch (error) {
        this.#onBackgroundError(error);
      }
    }
  }

  #clearTimers(job: TrackedJob): void {
    clearTimeout(job.readyTimer);
    clearTimeout(job.killTimer);
    clearTimeout(job.progressTimer);
    job.readyTimer = undefined;
    job.killTimer = undefined;
    job.progressTimer = undefined;
    if (!this.#jobs.has(job.jobId)) {
      clearTimeout(job.exitTimer);
      job.exitTimer = undefined;
    }
  }

  /**
   * 見張り: `READY` の後、合図が名前つきの時間より長く来ないワーカーを止める。process が終わって IPC の終わりを待つジョブは飛ばす（DEF-084。
   * 待ち終わりに決める）。
   */
  #checkHeartbeats(): void {
    const nowMs = performance.now();
    for (const job of this.#jobs.values()) {
      if (
        !job.processExited
        && (job.phase === 'STARTED' || job.phase === 'RUN')
        && nowMs - job.lastHeartbeatMs > this.#timing.heartbeatTimeoutMs
      ) {
        this.#guarded(() => this.#end(job, 'INTERRUPTED', 'WORKER_UNRESPONSIVE'));
        this.#kill(job);
      }
    }
  }

  /** 背後の処理を、誤りを投げずに行う。 */
  #guarded(work: () => unknown): void {
    try {
      work();
    } catch (error) {
      this.#onBackgroundError(error);
    }
  }

  #timestamp(): string {
    return formatCompactUtcTimestamp(this.#now(), 'audit job time');
  }

  // -------------------------------------------------------------------------------------------------------------
  // 停止
  // -------------------------------------------------------------------------------------------------------------

  stopAuditJob(jobId: string, options: { readonly force?: boolean } = {}): AuditJobStopResult {
    const force = options.force === true;
    const job = typeof jobId === 'string' ? this.#jobs.get(jobId) : undefined;
    if (job === undefined || job.phase === 'DONE') {
      const stored = typeof jobId === 'string' ? readJob(this.#database, jobId) : null;
      if (stored === null) {
        return stopRejected('JOB_NOT_FOUND');
      }
      return stopRejected(job !== undefined || stored.finishedAt !== null ? 'JOB_NOT_ACTIVE' : 'JOB_NOT_OWNED');
    }
    this.#requestStop(job, force);
    const stored = readJob(this.#database, jobId);
    if (stored === null) {
      return stopRejected('JOB_NOT_FOUND');
    }
    return Object.freeze({ ok: true, job: stored });
  }

  stopWriteJobsOfScenario(scenarioId: string): number {
    if (typeof scenarioId !== 'string') {
      return 0;
    }
    let stopped = 0;
    for (const job of this.#jobs.values()) {
      if (job.phase !== 'DONE' && job.write?.scenarioId === scenarioId) {
        this.#guarded(() => this.#requestStop(job, false));
        stopped += 1;
      }
    }
    return stopped;
  }

  #requestStop(job: TrackedJob, force: boolean): void {
    job.stopRequested = true;
    job.forceRequested ||= force;
    recordStopping(this.#database, job.jobId, this.#timestamp());
    if (job.phase !== 'FORKED') {
      // `READY` の前は送らない（受け手の用意の前に届くと失われるため）。`READY` を受けたときに、`START` の代わりに送る。
      this.#send(job, { protocol: WORKER_PROTOCOL_VERSION, type: 'STOP', force });
    }
    if (force && job.killTimer === undefined) {
      job.killTimer = setTimeout(() => this.#guarded(() => {
        job.killTimer = undefined;
        // DEF-084: process が終わって IPC の終わりを待つ間は、ここで終わらせない（待ち終わりに決める）。
        if (this.#jobs.has(job.jobId) && !job.processExited) {
          this.#end(job, 'INTERRUPTED', 'STOP_TIMEOUT');
          this.#kill(job);
        }
      }), this.#timing.forceStopKillAfterMs);
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // 起動と終わりのとき、読み取り
  // -------------------------------------------------------------------------------------------------------------

  recoverInterruptedJobs(): number {
    return this.#interruptUnownedJobs();
  }

  async shutdownAuditJobs(options: { readonly waitMs?: number } = {}): Promise<AuditJobShutdownResult> {
    this.#closing = true;
    const waitMs = options.waitMs ?? AUDIT_JOB_SHUTDOWN_WAIT_MS;
    const jobs = [...this.#jobs.values()];
    let stopRequested = 0;
    for (const job of jobs) {
      if (job.phase !== 'DONE') {
        this.#guarded(() => this.#requestStop(job, false));
        stopRequested += 1;
      }
    }
    await Promise.race([Promise.all(jobs.map((job) => job.exited)), sleep(waitMs)]);
    const remaining = [...this.#jobs.values()];
    for (const job of remaining) {
      this.#guarded(() => this.#end(job, 'INTERRUPTED', 'SERVER_SHUTDOWN'));
      this.#kill(job);
    }
    await Promise.race([Promise.all(remaining.map((job) => job.exited)), sleep(KILLED_WORKER_EXIT_WAIT_MS)]);
    return Object.freeze({ stopRequested, killed: remaining.length });
  }

  listAuditJobs(): readonly AuditJobView[] {
    return readAllJobs(this.#database);
  }

  getAuditJob(jobId: string): AuditJobView | null {
    return typeof jobId === 'string' ? readJob(this.#database, jobId) : null;
  }

  runningWorkerCount(): number {
    return this.#jobs.size;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    await this.shutdownAuditJobs({ waitMs: 0 });
    clearInterval(this.#watchdog);
    clearInterval(this.#instanceHeartbeat);
    this.#closed = true;
    // 自分のロックだけを消す（ほかの管理が取り直していれば、消さない）。
    this.#guarded(() => releaseControlInstanceLock(this.#database, this.#instanceLock));
    if (processManager === this) {
      processManager = null;
    }
  }
}

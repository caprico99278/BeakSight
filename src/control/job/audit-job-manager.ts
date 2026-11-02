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
// API の登録の書き込みのジョブ（Task 40 の設計書 3.2。T40a）: `startWriteCreate` と同じ部品を通る。`START` の書き込みの指定は送り方 API の形
//   （`write-job-start.ts` の `WorkerStartApiWrite`）。照合の READ の `{id}` の型の画面の READ の対象の画面は、ターゲット設定の開始の URL の Origin と
//   型の path（READ の確かめのジョブと同じ組み立て）。締めは form と同じ（T40b までワーカーは `NOT_SENT` を報告して止まる）。
// まとめて実行（FM2d。設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: `startStageChain` は、モードの段の並び（`stage-chain-policy.ts`）の
//   最初の段のジョブを今の開始の確かめで始め、`START` に `chain` を入れる。途中の段の `FINISHED` を受けたら、ワーカーを終えさせずに `#advanceChain` で進めるか
//   を決める（結果を記録 → 純粋な判定 → READ の定義と対象の画面 → 今の段の行を締めて次の段の行を作る（await を挟まない）→ `NEXT_STAGE`。止めるなら
//   `CHAIN_END`）。同じワーカーの受け手は、今の段のジョブに渡す（`#stageJobs`）。連鎖の状態はメモリの中だけ（`#chains`。管理データに書かない）。
//   手動のログインの自動の登録は、ワーカーが終わったとき（連鎖の最後）に 1 回だけ。「やめる」は連鎖の全体を止める。
// ワーカーの環境（T26d-2。設計書 4.4）:`fork` に渡す環境から、デバッグの出力を有効にする変数（`WORKER_EXCLUDED_ENVIRONMENT_VARIABLES`）を外す
//   （すべてのジョブ。ほかの変数は、そのまま渡す）。
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  ACTION_RUN_ARTIFACT_FILE_NAME,
  DISCOVERY_ARTIFACT_FILE_NAME,
  ENTRY_CHECK_ARTIFACT_FILE_NAME,
  READ_EVIDENCE_ARTIFACT_FILE_NAME,
} from '../../core/artifact-layout.js';
import { readContainedArtifactFile } from '../../core/contained-artifact-file.js';
import type { IncompleteReasonCode, RunId, RunStatus } from '../../core/contracts.js';
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
  sameJobAuthenticationSummary,
  type DiscoveryDocument,
} from '../../discovery/discovery-result.js';
import {
  readCheckEvidenceTargetOf,
  readEvidenceSummaryOf,
  type ReadEvidenceDocument,
} from '../../discovery/read-check-evaluation.js';
import { VERIFIED_ACTION_RESULT, type ActionRunDocument } from '../actions/action-contracts.js';
import { readWriteResult } from '../actions/write-result-facts.js';
import { actionRunMatchesWriteStart } from '../actions/action-api-summary.js';
import { approvalSummaryFactsOf } from '../actions/approval-summary-facts.js';
import { approvalExternalFactsOf } from '../approval-external-facts.js';
import { DEFAULT_MAX_CREATES_PER_RUN, scenarioTransportOf, updateLedgerScenarioIdOf } from '../approval/scenario-contracts.js';
import {
  assertGrantStillValid,
  closeOrphanedWriteResults,
  closeWriteWithoutSending,
  consumeExecutionGrant,
  issueExecutionGrant,
  listScenarios,
  readScenario,
  readApprovalReceipts,
  readExecutionGrant,
  readScenarioApprovalStatus,
  readScenarioRevisions,
  readUsedCumulativeWrites,
  readScenarioWriteGenerationHistory,
  readLedgerValueWrites,
  recordWriteAttempt,
  settleWriteResult,
  type ExecutionGrantView,
  type WriteOutcomeReport,
  readVerificationOnlyReadCheckIds,
} from '../approval/scenario-store.js';
import { approveUpdateForChain, draftUpdateForCreate } from '../approval/update-autodraft.js';
import { evaluateRuleSet, planRuleSet } from '../data-rules/field-evaluation.js';
import { uniqueEachRunFieldNamesOf } from '../data-rules/varying-values.js';
import { readLatestRuleSet } from '../data-rules/rule-store.js';
import { generateScenarioData } from '../data-rules/scenario-data.js';
import { FORM_NAVIGATION_TRANSPORT, loginTransportOf, type AuthSetup, type AuthSetupValidationError } from '../auth/auth-setup-contracts.js';
import {
  automatedLoginSwitchOf,
  manualLoginEveryTimeApplies,
  offersAutomatedLoginSwitch,
  writableLoginOriginOf,
  type AutomatedLoginSelectors,
} from '../auth/automated-login-switch.js';
import { validateAuthSetup } from '../auth/auth-setup-policy.js';
import { authSetupProposalProfileOf, entryCheckAuthSetupDecisionOf, proposedAuthSetupOf } from '../auth/auth-setup-proposal.js';
import { isAutomatedLoginProfileAuth } from '../auth/credential-destination.js';
import { startUrlPathOf } from '../../config/target-config-draft.js';
import { isOriginInAllowedOrigins } from '../../crawl/normalize-url.js';
import { AUTOMATED_LOGIN_SUBMISSION_NONE, AUTOMATED_LOGIN_UNKNOWN_RESULT } from '../auth/automated-login-results.js';
import {
  AUTOMATED_LOGIN_AUTH_STRATEGY,
  MANUAL_EVERY_TIME_LOGIN_PREFERENCE,
  MIN_PROFILE_REVISION,
  PROFILE_ID_PATTERN,
  WRITE_AUDIT_MODE,
  loginPreferenceOf,
  type ProfileValidationError,
  type SiteProfile,
} from '../contracts.js';
import { CREDENTIAL_PLATFORM, CREDENTIAL_PROTECTION_AVAILABLE } from '../credentials/credential-platform.js';
import { FIRST_CREDENTIAL_REVISION, createCredentialStore, type CredentialMetadata, type CredentialStore } from '../credentials/credential-store.js';
import { entryCheckSummaryOf, type EntryCheckDocument, type EntryCheckEndReason } from '../entry-check.js';
import { operationRequiresAuthSetup, profileOperationRejectionOf, type ProfileOperation } from '../execution-policy.js';
import { isAcceptedTargetConfigPath, validateSiteProfile, type ProfileValidationContext } from '../profile-policy.js';
import { CURRENT_AUTH_SETUP_FRESHNESS, getAuthSetup, saveAuthSetup, type StoredAuthSetup } from '../store/auth-setup-store.js';
import type { ControlDatabase } from '../store/control-database.js';
import { getProfile, readProfileDisplaySettings, type StoredProfile } from '../store/profile-store.js';
import { ACTIVE_PROFILE_STATUS } from '../store/profile-records.js';
import { saveProfileAndAuthSetup } from '../store/profile-auth-setup-store.js';
import { loginRegistrationAfterLoginOf, manualLoginRegistrationOf } from '../manual-login-registration.js';
import { loginFieldDraftsOf } from '../login-observation-draft.js';
import {
  MAX_WORKER_EXIT_CODE,
  MAX_WORKER_READ_CHECKS,
  WORKER_AUDIT_JOB_KIND,
  WORKER_DISCOVERY_JOB_KIND,
  WORKER_ENTRY_CHECK_JOB_KIND,
  WORKER_JOB_KINDS_ACCEPTING_AUDIT_SEND_POLICY,
  WORKER_JOB_KINDS_WITH_JOB_BROWSER,
  WORKER_LOGIN_CHECK_JOB_KIND,
  WORKER_PROTOCOL_VERSION,
  WORKER_LOGIN_REGISTRATION_TIMEOUT_MS,
  WORKER_READ_CHECK_JOB_KIND,
  WORKER_JOB_ID_PATTERN,
  WORKER_SESSION_LOST_STATE,
  WORKER_STOPPED_LOGIN_STAGE_STATE,
  // PRE42-CC 組 UI-K3（CC-113）: 手動のログインを待っている状態（文字列で比べない）。
  WORKER_AWAITING_LOGIN_STATE,
  WORKER_WRITE_CREATE_JOB_KIND,
  WORKER_WRITE_UPDATE_JOB_KIND,
  isWorkerStartApiWrite,
  isWorkerWriteJobKind,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
  type ParentToWorkerMessage,
  type WorkerAuthState,
  type WorkerAutomatedLoginReport,
  type WorkerCredentialSaveFailureCode,
  type WorkerCredentialSavedMessage,
  type WorkerJobKind,
  type WorkerChainStageSequence,
  type WorkerNextStageJobKind,
  type WorkerDiscoverySummary,
  type WorkerLoginObservation,
  type WorkerLoginStageBlockedRequests,
  type WorkerEntryCheckSummary,
  type WorkerReadCheckSummary,
  type WorkerRunOutcome,
  type WorkerStartAuthentication,
  type WorkerStartAutomatedLogin,
  type WorkerStartApiWrite,
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
  recordCredentialEvent,
} from './auto-login-store.js';
import {
  WRITE_READ_VERIFICATION_PAGE_TARGET,
  apiCreateReadListPagePathOf,
  readVerificationTargetRejectionOf,
  writeBaseDateOf,
  writeStartSpecOf,
} from './write-job-start.js';
import { discoveryIndexEntryOf, readDiscoveryIndex, recordDiscoveryCandidates } from './discovery-index-store.js';
import {
  AUDIT_JOB_EXIT_WAIT_MS,
  AUDIT_JOB_FINALIZING_HEARTBEAT_TIMEOUT_MS,
  AUDIT_JOB_LOCK_LOST_KILL_AFTER_MS,
  AUDIT_JOB_UNOWNED_WORKER_STALE_AFTER_MS,
  AUDIT_JOB_FORCE_STOP_KILL_AFTER_MS,
  AUDIT_JOB_HEARTBEAT_TIMEOUT_MS,
  AUDIT_JOB_IPC_DRAIN_WAIT_MS,
  AUDIT_JOB_PROGRESS_WRITE_INTERVAL_MS,
  AUDIT_JOB_READY_TIMEOUT_MS,
  AUDIT_JOB_SHUTDOWN_WAIT_MS,
  AUDIT_JOB_WATCHDOG_INTERVAL_MS,
  AUDIT_JOB_WATCHDOG_LAG_LIMIT_MS,
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
  lastFinishedEntryCheckJobOf,
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
  recordLoginStageAutoRegistration,
  type AuditJobAutomatedLoginUnavailableReason,
  type AuditJobLoginAutoRegistration,
  type AuditJobLoginAutoRegistrationSkipReason,
  type AuditJobView,
  type UnownedActiveJob,
} from './job-store.js';
import { checkWriteReport } from './write-report-check.js';
import { listReadChecks, recordReadCheckResults, type ReadCheckView } from './read-check-store.js';
import {
  chainAdvanceDecisionOf,
  chainReadCheckDecisionOf,
  chainStagesOfMode,
  chainWriteAdvanceDecisionOf,
  chainWriteTargetsOf,
  nextChainWriteStepOf,
  type ChainWriteStep,
  type ChainWriteTarget,
  // PRE42-CC 組 UI-K3（CC-113）: 連鎖と段の状態の名前つきの定数（文字列で比べない）。組 Z: 代入とオブジェクトの値も定数で書く。
  DONE_CHAIN_STAGE_STATE,
  FINISHED_CHAIN_STATE,
  NOT_NEEDED_CHAIN_STAGE_STATE,
  NOT_STARTED_CHAIN_STAGE_STATE,
  PENDING_CHAIN_STAGE_STATE,
  RUNNING_CHAIN_STAGE_STATE,
  RUNNING_CHAIN_STATE,
  STOPPED_CHAIN_STAGE_STATE,
  STOPPED_CHAIN_STATE,
  type ChainAdvanceDecision,
  type ChainStageState,
  type ChainState,
  type ChainStopReason,
  type StageChainView,
} from './stage-chain-policy.js';

/** ターゲット JSON のパスから、検証の文脈を返す（読めなければ `undefined`）。画面のサーバは、`loadConfig` で読む。 */

/**
 * PL-6a（設計書 `2026-10-26-beaksight-plain-ui-design.md` 8.1、設計者の判断 (f)）: 単独の READ の確かめのジョブで読む定義（取り消していない定義のうち、
 * シナリオの照合の専用の印（`verificationOnly`）で参照されていないもの。作った順。上限 `MAX_WORKER_READ_CHECKS` まで）。
 */
const standaloneReadChecksOf = (database: ControlDatabase, profileId: string): readonly ReadCheckView[] => {
  const verificationOnly = new Set(readVerificationOnlyReadCheckIds(database, profileId));
  return listReadChecks(database, profileId).filter(({ readCheckId }) => !verificationOnly.has(readCheckId)).slice(0, MAX_WORKER_READ_CHECKS);
};
export type AuditJobContextResolver = (
  targetConfigPath: string,
) => Promise<ProfileValidationContext | undefined> | ProfileValidationContext | undefined;

/** ワーカーを起動する関数（本番は `child_process.fork`。テストは起動の回数を数える）。 */
export type AuditWorkerForker = (modulePath: string, args: readonly string[], options: ForkOptions) => ChildProcess;

/** ジョブの管理の時間（ms。テストは短くする）。 */
export interface AuditJobTiming {
  readonly readyTimeoutMs: number;
  readonly heartbeatTimeoutMs: number;
  /** DEF-143: 「Run の終わり」の段の知らせ（`RUN_FINALIZING`）を受けた後の、合図が来ない時間の上限。 */
  readonly finalizingHeartbeatTimeoutMs: number;
  readonly watchdogIntervalMs: number;
  /** DEF-143: 見張りの回の遅れの上限。見張りの間隔より、これを超えて遅れた回は判定しない（親自身が止まっていた）。 */
  readonly watchdogLagLimitMs: number;
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
  /** OP-F（安全のレビューの I-1）: ログインの直後の登録で、許しを送ってからワーカーの `CREDENTIAL_SAVED` を待つ上限（本番は `WORKER_LOGIN_REGISTRATION_TIMEOUT_MS`）。 */
  readonly loginRegistrationTimeoutMs: number;
}

/** 名前つきの時間（本番の値）。 */
export const AUDIT_JOB_TIMING: AuditJobTiming = Object.freeze({
  readyTimeoutMs: AUDIT_JOB_READY_TIMEOUT_MS,
  heartbeatTimeoutMs: AUDIT_JOB_HEARTBEAT_TIMEOUT_MS,
  finalizingHeartbeatTimeoutMs: AUDIT_JOB_FINALIZING_HEARTBEAT_TIMEOUT_MS,
  watchdogIntervalMs: AUDIT_JOB_WATCHDOG_INTERVAL_MS,
  watchdogLagLimitMs: AUDIT_JOB_WATCHDOG_LAG_LIMIT_MS,
  progressWriteIntervalMs: AUDIT_JOB_PROGRESS_WRITE_INTERVAL_MS,
  forceStopKillAfterMs: AUDIT_JOB_FORCE_STOP_KILL_AFTER_MS,
  exitWaitMs: AUDIT_JOB_EXIT_WAIT_MS,
  ipcDrainWaitMs: AUDIT_JOB_IPC_DRAIN_WAIT_MS,
  instanceHeartbeatIntervalMs: RUN_LOCK_HEARTBEAT_INTERVAL_MS,
  unownedWorkerStaleAfterMs: AUDIT_JOB_UNOWNED_WORKER_STALE_AFTER_MS,
  lockLostKillAfterMs: AUDIT_JOB_LOCK_LOST_KILL_AFTER_MS,
  loginRegistrationTimeoutMs: WORKER_LOGIN_REGISTRATION_TIMEOUT_MS,
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
  /**
   * DEF-146: ワーカーが結果の前に終わった（落ちた）ときの、親が分かる終わり方の受け手（IPC の終わりを待った後に、まだ終わり方が決まっていない
   * ジョブだけ。1 回だけ。画面のサーバは記録のファイルに書く）。既定は何もしない。受け手の誤りは投げずに `onBackgroundError` に渡す。
   */
  readonly onUnexpectedWorkerExit?: (event: AuditJobWorkerExit) => void;
}

/** DEF-146: 結果の前に終わったワーカーの終わり方（値と秘密は持たない）。 */
export interface AuditJobWorkerExit {
  readonly jobId: string;
  readonly jobKind: AuditJobKind;
  readonly exitCode: number | null;
  readonly signal: string | null;
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

/** 入口の確かめの開始の依頼（T43c。画面から受けた値。形もここで確かめる。再開しないので、新しく始めるかの指定はない）。 */
export interface EntryCheckStartRequest {
  readonly profileId: string;
  /** 画面が読んだプロファイルの改訂。 */
  readonly expectedRevision: number;
  /**
   * OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D11、4.1.3 の 3）: 下調べが終わったら、続けて点検（まとめて実行）を始めるか（作成の画面の
   * 「点検を始める」）。省略は偽。始めるかの判定は、ジョブの管理のこの 1 か所（`#startAfterEntryCheck`）。
   */
  readonly thenStartAudit?: boolean;
}

/**
 * OP-1 修正の 2 回目: 下調べが開始のページを読めた終わりの理由（`src/control/entry-check.ts` の閉じた一覧の値）。続けて点検を始めるかの判定（`#startAfterEntryCheck`）に使う。
 */
const ENTRY_CHECK_READ_END_REASON = 'READ' satisfies EntryCheckEndReason;

/**
 * OP-1: 下調べの後に続けて始める点検の状態（`entryCheckFollowUpOf`。メモリの中だけ）。`WAITING` は下調べの終わりの処理を待つ、`STARTED` は始めた点検の最初の段の
 * ジョブ、`SKIPPED` は始めなかった（下調べが読めなかった、ログインの設定を保存できなかった、開始を拒まれた）。
 */
export type EntryCheckFollowUp =
  | { readonly state: 'WAITING' }
  | { readonly state: 'STARTED'; readonly jobId: string }
  | { readonly state: 'SKIPPED' };

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
  /**
   * 入口の確かめを始める（T43c。Task 43 の設計書 4.3。公開のモードと、テストの 2 つのモードのログインを使うプロファイル。ログインはしないので、認証の
   * 設定がなくても始められる。開始の確かめは監査と同じ（プロファイル、改訂、モード、ターゲット設定、同時に 1 つ）。ジョブの終わりに、`entry-check.json`
   * を読んで確かめる（管理データには結果を残さない。成果物が正）。
   */
  startEntryCheck(request: EntryCheckStartRequest): Promise<AuditJobStartResult>;
  /**
   * FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行を始める（`TEST_AUTH_PASSIVE` と `TEST_APPROVED_WRITE` は、どちらも
   * 監査 → 発見 → READ の確かめ。MI-5 で書き込みのモードも監査から始まる並びにした。`stage-chain-policy.ts`）。開始の確かめは最初の段のジョブと同じで、どの段の操作もそのモードで許されるときだけ
   * 始める。1 つのワーカーがログイン 1 回の後に段を続け、段ごとにジョブの行を作る（段の間に空きはない）。返すジョブは最初の段のもの。
   */
  startStageChain(request: AuditJobStartRequest): Promise<AuditJobStartResult>;
  /** FM2d: そのジョブを段に持つまとめて実行の表示（メモリの中だけ。なければ `null`）。 */
  getStageChainOfJob(jobId: string): StageChainView | null;
  /**
   * OP-G（指示書の 5）: 次の点検（まとめて実行）が書き込みの段の対象にする、チェックした画面の数（決め方は連鎖の書き込みの段の対象と同じ 1 か所 `#chainWriteTargets`。
   * 書き込みのモードでないプロファイル・ないプロファイルは 0）。開始の画面の「何が起きるか」の文に使う。
   */
  checkedWriteScreenCountOf(profileId: string): number;
  /** OP-1: 下調べのジョブ（`thenStartAudit` で始めたもの）の、続けて始める点検の状態（ないなら `null`）。 */
  entryCheckFollowUpOf(jobId: string): EntryCheckFollowUp | null;
  /** OP-1（D3）: 手でのログインを待つジョブで、BeakSight がログインの終わりを判定できるか（知らせを受けていなければ `null`）。 */
  loginEndDetectionOf(jobId: string): boolean | null;
  /** 資格情報を変えてよいか（T26d-2。そのプロファイルのジョブが終わっていない間は `CREDENTIAL_IN_USE`）。 */
  checkCredentialChange(profileId: string): CredentialChangeCheck;
  stopAuditJob(jobId: string, options?: { readonly force?: boolean }): AuditJobStopResult;
  /**
   * ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.2）: 利用者が手動のログインの画面でログインを終えた。ジョブがログインを待っている
   * （`AWAITING_LOGIN`）手動のログインのジョブのときだけ、ワーカーへ `LOGIN_CONFIRMED` を 1 回送る。ほかは閉じた一覧の理由で拒む。
   */
  confirmManualLogin(jobId: string): Promise<AuditJobLoginConfirmResult>;
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
    /** 入口の確かめのジョブの件数の要約（T43c。入口の確かめのジョブの Run を実行した結果だけ。ほかは `null`）。 */
    readonly entryCheck: WorkerEntryCheckSummary | null;
    /** FM2d: まとめて実行の段の未完了の理由のコード（まとめて実行の段の Run を実行した結果だけ。ほかは空）。 */
    readonly incompleteReasonCodes: readonly IncompleteReasonCode[];
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
  /** T43c: 確かめた入口の確かめの成果物（管理データには記録しない）。 */
  | { readonly kind: 'ENTRY_CHECK'; readonly document: EntryCheckDocument }
  | { readonly kind: 'INVALID'; readonly reason: AuditJobFailureReason };

/** 入口の確かめの結果を読めないときの、ジョブの失敗の理由（T43c）。 */
const ENTRY_CHECK_RESULT_INVALID_REASON = 'ENTRY_CHECK_RESULT_INVALID' satisfies AuditJobFailureReason;

/** 入口の確かめの結果を読めない・合わない（T43c）。 */
const ENTRY_CHECK_RESULT_INVALID: JobResultVerdict = Object.freeze({ kind: 'INVALID', reason: ENTRY_CHECK_RESULT_INVALID_REASON });

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
  /** OP-2: まとめて実行の書き込みの段で、次の段へ進む前に書き込みの結果を締めた（ワーカーが終わったときに締め直さない）。 */
  settled: boolean;
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
  readonly writeSpec: WorkerStartWrite | WorkerStartApiWrite | null;
  /** FM2d: まとめて実行（その段のジョブだけ。ほかは `null`）。 */
  readonly chain: ChainRun | null;
  /** FM2d: まとめて実行の段の位置（0 から。まとめて実行でなければ 0）。 */
  readonly chainStageIndex: number;
  /** DEF-180: ワーカーが読み込むサイト（ターゲット設定の許可 Origin）。ワーカーが終わった時刻を、この Origin ごとに記録する。 */
  readonly siteOrigins: readonly string[];
}

/**
 * FM2d: まとめて実行の親の側の状態（メモリの中だけ。管理データに書かない。設計の判断 2026-10-22 の 3）。段ごとのジョブの行は今の作りのまま。
 * `chainId` は最初の段のジョブの ID。
 */
interface ChainRun {
  readonly chainId: string;
  readonly profileId: string;
  /**
   * 連鎖を始めた時のプロファイルの改訂（連鎖はこの改訂に結ぶ）。OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.3 の 1）: ログインの直後の登録で
   * 親が自分で進めた改訂だけ、ここを進めて受け入れる（ほかの改訂の変化は、今どおり `PROFILE_REVISION_CHANGED` で止める）。
   */
  profileRevision: number;
  readonly stages: WorkerChainStageSequence;
  /** ターゲット設定の開始の URL（READ の確かめの画面の path の定義の対象の画面を決めるため。開始の直前に読み直したもの）。 */
  readonly startUrl: string | null;
  /** 段ごとの状態とジョブの ID。 */
  readonly stageStates: { state: ChainStageState; jobId: string | null }[];
  state: ChainState;
  stopReason: ChainStopReason | null;
  /** 利用者が止めた（画面の「やめる」。連鎖の全体を止める）。 */
  stopRequested: boolean;
  /**
   * OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.2 の案 C）: 読み取りの段の後の書き込みの段の対象（チェックした画面。連鎖を始めた時に決める。
   * 空なら書き込みの段はない）。
   */
  writeTargets: readonly ChainWriteTarget[];
  /**
   * OP-2 の修正の 3 回目（設計書 4.1.2 の R1）: 最初の書き込みの段の前の、更新の下書きと承認を済ませたか（1 回の点検で 1 回だけ。済ませた後に書き込みの段の対象を
   * 求め直す）。
   */
  updatesPrepared: boolean;
  /** OP-2: 今の書き込みの段（行っていなければ null）。 */
  currentWriteStep: ChainWriteStep | null;
  /** OP-2: 終えた最後の書き込みの段と、登録が照合まで済んだときの番号（次の段を決める）。 */
  lastWrite: { readonly step: ChainWriteStep; readonly createRecordId: string | null } | null;
  /** OP-2: 行った書き込みの段のジョブ（行った順）。 */
  readonly writeStageJobIds: string[];
  /**
   * OP-F（安全のレビューの M-1）: チェックした画面のうち、試せなかった（許可を発行できない・書き込みの準備が通らない）段があったか。あれば、連鎖を「最後まで
   * 行った」にせず、`WRITE_NOT_TRIED` で終える。
   */
  writeNotTried: boolean;
}

/**
 * OP-F（安全のレビューの M-2）: 受け取った値を運んだ送り先（`carriedBy`）が、切り替えの後の認証の設定の資格情報の送り先に当たるか。送り先は、フォームの送り方なら
 * フォームの送信先（`loginPostEndpoints`）、スクリプトの送り方なら token の送信先（`scriptLogin`）。Origin の比べは URL の意味の owner の部品
 * （`isOriginInAllowedOrigins`）、path は完全一致。受け取っていない（null）なら偽。
 */
const credentialCarriedToLoginDestination = (setup: AuthSetup, carriedBy: { readonly origin: string; readonly path: string } | null): boolean => {
  if (carriedBy === null) {
    return false;
  }
  const destinations = loginTransportOf(setup) === FORM_NAVIGATION_TRANSPORT ? setup.loginPostEndpoints : setup.scriptLogin === null ? [] : [setup.scriptLogin];
  return destinations.some(({ origin, path }) => isOriginInAllowedOrigins([origin], carriedBy.origin) && path === carriedBy.path);
};

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
  /** ML-a: 最後に受けた認証の状態（`AUTH_STATE`。受けていなければ `null`）。「ログインを終えた」の口が、ログインを待っているかを見る。 */
  lastAuthState: WorkerAuthState | null;
  /** ML-a: 「ログインを終えた」（`LOGIN_CONFIRMED`）を送った（1 つのジョブで 1 回だけ）。 */
  loginConfirmSent: boolean;
  /**
   * ML-a: 手動のログインの段の成功の記録（通した送信の一覧と観察。メモリの中だけ。値を持たない）。ジョブが終わった後の、認証の設定の自動の登録の材料。
   * 手動のログインの成功を受けていなければ `null`。
   */
  manualLoginRecords: { readonly passedRequests: WorkerLoginStageBlockedRequests; readonly observation: WorkerLoginObservation | undefined } | null;
  /**
   * OP-1（設計書 4.1.3 の 1）: ログインの直後の登録の状態（`START` に `loginRegistration` を入れたジョブだけ。ほかは `null`）。`WAITING` はログインの成功を待つ、
   * `REGISTERING` は組み立て中、`AWAITING_SAVE` はワーカーの `CREDENTIAL_SAVED` を待つ（受け手 `onSaved`）、`DONE` は返事を送った。
   */
  loginRegistration: { phase: 'WAITING' | 'REGISTERING' | 'AWAITING_SAVE' | 'DONE'; onSaved: ((message: WorkerCredentialSavedMessage | null) => void) | null } | null;
  /** OP-1（D3）: 最後のログインを待つ知らせの、BeakSight がログインの終わりを判定できるかの印（受けていなければ `null`）。 */
  loginEndDetection: boolean | null;
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
  /**
   * DEF-143: 「Run の終わり」の段の知らせ（`RUN_FINALIZING`）を受けた。真の後は、見張りの途絶えの上限を `finalizingHeartbeatTimeoutMs` にする（ジョブの
   * 終わりまで）。
   */
  finalizing: boolean;
  lastHeartbeatMs: number;
  lastProgressWriteMs: number;
  pendingProgress: Extract<WorkerToParentMessage, { readonly type: 'PROGRESS' }>['report'] | null;
  readyTimer: NodeJS.Timeout | undefined;
  killTimer: NodeJS.Timeout | undefined;
  progressTimer: NodeJS.Timeout | undefined;
  readonly exited: Promise<void>;
  /** FM2d: 段の途中でセッションの切れ（`AUTH_STATE` の `SESSION_LOST`）を受けた（次の段へ進むかの判定に使う）。 */
  sessionLost: boolean;
  /**
   * FM2d: まとめて実行の途中の段で、結果のファイルを読んで記録した（発見の索引など。`failedReason` は記録できなかった理由）。記録していなければ `null`。
   * ワーカーが終わったときに、記録し直さない。
   */
  recordedResult: { readonly failedReason: AuditJobFailureReason | null } | null;
  /** FM2d: まとめて実行の次の段へ進めるときに、ジョブの行を締めた（ワーカーが終わったときに、締め直さない）。 */
  rowRecorded: boolean;
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

/**
 * ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.2、5 章の約束）: 「ログインを終えた」の口が拒む理由（閉じた一覧）。
 * - `JOB_NOT_FOUND`: そのジョブがない。
 * - `JOB_NOT_ACTIVE`: ジョブが終わっている（またはこの管理が動かしていない）。
 * - `NOT_AWAITING_LOGIN`: 手動のログインのジョブがログインを待っていない（公開の監査、自動ログイン、ログインの前・後、止める要求の後）。
 * - `ALREADY_CONFIRMED`: すでに知らせた（1 つのジョブで 1 回だけ）。
 */
export const AUDIT_JOB_LOGIN_CONFIRM_REJECTION_REASONS = Object.freeze(['JOB_NOT_FOUND', 'JOB_NOT_ACTIVE', 'NOT_AWAITING_LOGIN', 'ALREADY_CONFIRMED'] as const);
export type AuditJobLoginConfirmRejectionReason = (typeof AUDIT_JOB_LOGIN_CONFIRM_REJECTION_REASONS)[number];

/** ML-a: 「ログインを終えた」の口の結果。 */
export type AuditJobLoginConfirmResult = { readonly ok: true } | { readonly ok: false; readonly reason: AuditJobLoginConfirmRejectionReason };

const loginConfirmRejected = (reason: AuditJobLoginConfirmRejectionReason): AuditJobLoginConfirmResult => Object.freeze({ ok: false, reason });

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
  /** ML-a: 背後の、手動のログインの成功からの認証の設定の自動の登録（終わっていないもの）。 */
  readonly #registrations = new Set<Promise<void>>();
  /** OP-1: 下調べの後に続けて始める点検（下調べのジョブの ID → 状態。メモリの中だけ）。 */
  readonly #entryCheckFollowUps = new Map<string, EntryCheckFollowUp>();
  /**
   * DEF-180（OP-DEF 修正の 1 回目）: サイト（ターゲット設定の許可 Origin）ごとの、そのサイトを読んだ最後のワーカーが終わった時刻（エポックからの ms。ただの数。
   * メモリの中だけ）。次のワーカーの `START` に、前の読み込みの時刻（`previousNavigationAtMs`）として渡す。待つのはワーカーの pacer だけ（ここでは待たない）。
   */
  readonly #siteWorkerEndedAtMs = new Map<string, number>();
  readonly #forkWorker: AuditWorkerForker;
  readonly #timing: AuditJobTiming;
  readonly #onBackgroundError: (error: unknown) => void;
  /** DEF-146: 結果の前に終わったワーカーの終わり方の受け手。 */
  readonly #onUnexpectedWorkerExit: (event: AuditJobWorkerExit) => void;
  /** 資格情報のフォルダを決める根（T26d-2。`START` の `credentialRoot`）。 */
  readonly #credentialRoot: string;
  /** 資格情報のファイルの部品（T26d-2。渡されなければ、最初に使うときに本番の入口で作る）。 */
  #credentialStore: CredentialStore | null;
  readonly #jobs = new Map<string, TrackedJob>();
  /** FM2d: まとめて実行のワーカーの、今の段のジョブ（段を進めたときに置き換える。まとめて実行でないワーカーは持たない）。 */
  readonly #stageJobs = new WeakMap<ChildProcess, TrackedJob>();
  /** FM2d: 段のジョブの ID → まとめて実行（メモリの中だけ。画面のサーバが止まれば消える）。 */
  readonly #chains = new Map<string, ChainRun>();
  readonly #watchdog: NodeJS.Timeout;
  /** DEF-143: 見張りが前に回った時刻（`performance.now()`。回の遅れを測る）。 */
  #lastWatchdogMs = performance.now();
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
    this.#onUnexpectedWorkerExit = options.onUnexpectedWorkerExit ?? ((): void => undefined);
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

  async startStageChain(request: AuditJobStartRequest): Promise<AuditJobStartResult> {
    if (this.#closing || !isStartRequest(request)) {
      return startRejected('INVALID_REQUEST');
    }
    // FM2d: 段の並びはプロファイルのモードで決める（連鎖しないモードは拒む）。ほかの確かめは、最初の段のジョブと同じ（`#start`）。
    const stored = getProfile(this.#database, request.profileId);
    if (stored === null) {
      return startRejected('PROFILE_NOT_FOUND');
    }
    const stages = chainStagesOfMode(stored.profile.mode);
    if (stages === null) {
      return startRejected('MODE_NOT_EXECUTABLE');
    }
    // 監査の段は、開始の画面の指定（新しく始めるか）のまま。発見から始める連鎖は、いつも新しい Run。
    const startNew = stages[0] === WORKER_AUDIT_JOB_KIND ? request.startNew : true;
    return this.#start(stages[0], request.profileId, request.expectedRevision, startNew, null, stages);
  }

  async startReadCheck(request: ReadCheckStartRequest): Promise<AuditJobStartResult> {
    if (this.#closing || !isLoginCheckRequest(request)) {
      return startRejected('INVALID_REQUEST');
    }
    // READ の確かめのジョブは再開しない（いつも新しい Run）。行には真を書く。
    return this.#start(WORKER_READ_CHECK_JOB_KIND, request.profileId, request.expectedRevision, true);
  }

  async startEntryCheck(request: EntryCheckStartRequest): Promise<AuditJobStartResult> {
    if (this.#closing || !isLoginCheckRequest(request)) {
      return startRejected('INVALID_REQUEST');
    }
    if (request.thenStartAudit !== undefined && typeof request.thenStartAudit !== 'boolean') {
      return startRejected('INVALID_REQUEST');
    }
    // T43c: 入口の確かめのジョブは再開しない（いつも新しい Run）。行には真を書く。
    const result = await this.#start(WORKER_ENTRY_CHECK_JOB_KIND, request.profileId, request.expectedRevision, true);
    if (result.ok && request.thenStartAudit === true) {
      this.#entryCheckFollowUps.set(result.job.jobId, Object.freeze({ state: 'WAITING' }));
    }
    return result;
  }

  entryCheckFollowUpOf(jobId: string): EntryCheckFollowUp | null {
    return typeof jobId === 'string' ? (this.#entryCheckFollowUps.get(jobId) ?? null) : null;
  }

  loginEndDetectionOf(jobId: string): boolean | null {
    const job = typeof jobId === 'string' ? this.#jobs.get(jobId) : undefined;
    return job?.loginEndDetection ?? null;
  }

  /**
   * OP-1（設計書 4.1 の D11、4.1.3 の 3）: 印つきの下調べが終わったら、ログインの設定の案の保存（`#saveEntryCheckProposal`）の後に、続けて点検（まとめて実行）を
   * 始める。始めるのは、下調べが失敗の理由なしで終わって開始のページを読め（OP-1 修正の 2 回目）、人が止めておらず、プロファイルが有効で、ログインの設定を使うモードなら設定があるときだけ。開始の確かめは今の口
   * （`startStageChain`。公開の画面だけのプロファイルは連鎖しないので、今の点検の口 `startAuditJob`）。始めなかったら `SKIPPED`（画面はサイトの画面へ移る）。
   */
  async #startAfterEntryCheck(job: TrackedJob, finishedWithoutFailure: boolean): Promise<void> {
    if (this.#entryCheckFollowUps.get(job.jobId)?.state !== 'WAITING') {
      return;
    }
    const notStarted = (): void => {
      this.#entryCheckFollowUps.set(job.jobId, Object.freeze({ state: 'SKIPPED' }));
    };
    const current = getProfile(this.#database, job.profileId);
    // OP-1 修正の 2 回目: 人が止めた下調べ（止める要求の記録がある）の後にも始めない。
    if (!finishedWithoutFailure || job.stopRequested || this.#closing || current === null || current.status !== ACTIVE_PROFILE_STATUS
      || (operationRequiresAuthSetup(WORKER_AUDIT_JOB_KIND, current.profile.mode) && getAuthSetup(this.#database, job.profileId) === null)) {
      notStarted();
      return;
    }
    const request = { profileId: job.profileId, expectedRevision: current.profile.revision, startNew: true };
    const started = chainStagesOfMode(current.profile.mode) === null ? await this.startAuditJob(request) : await this.startStageChain(request);
    if (started.ok) {
      this.#entryCheckFollowUps.set(job.jobId, Object.freeze({ state: 'STARTED', jobId: started.job.jobId }));
    } else {
      notStarted();
    }
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
   * OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.3 の 1・2）: 手でのログインの値の受け取りを許すか。希望が自動ログイン（`AUTOMATIC`）で、資格情報を
   * 保存できるプラットフォームで、暗号化を使え、そのプロファイルの資格情報のファイルがない（読めない・壊れたファイルは、ある扱いにして許さない）ときだけ。
   */
  async #credentialCaptureAllowed(profile: SiteProfile): Promise<boolean> {
    if (loginPreferenceOf(profile) === MANUAL_EVERY_TIME_LOGIN_PREFERENCE || process.platform !== CREDENTIAL_PLATFORM) {
      return false;
    }
    const store = this.#credentials();
    try {
      return (await store.checkProtection()) === CREDENTIAL_PROTECTION_AVAILABLE && (await store.readMetadata(profile.profileId)) === null;
    } catch {
      return false;
    }
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
    chainStages: WorkerChainStageSequence | null = null,
  ): Promise<AuditJobStartResult> {
    if (this.#instanceLockLost) {
      return startRejected('CONTROL_INSTANCE_LOCK_LOST');
    }

    // 1. プロファイル、改訂、今実行できるモード。
    const stored = getProfile(this.#database, profileId);
    if (stored === null) {
      return startRejected('PROFILE_NOT_FOUND');
    }
    if (stored.status !== ACTIVE_PROFILE_STATUS) {
      return startRejected('PROFILE_RETIRED');
    }
    if (stored.profile.revision !== expectedRevision) {
      return startRejected('PROFILE_REVISION_CONFLICT');
    }
    // T28b: ジョブの種類ごとに許すモードと認証の方式は、`execution-policy.ts` の閉じた一覧だけで決める（T26d-2 のログインの検証は自動ログインの
    // プロファイルだけ、T27d・T27e の発見と READ の確かめは認証の設定のあるモードだけ。MI-5 から、書き込みのモードでも監査を許す。監査のジョブの送信の
    // 扱いは、モードでなくジョブの種類で決まり、読み取りだけのまま）。
    const operationRejection = profileOperationRejectionOf(jobKind, stored.profile.mode, stored.profile.auth);
    if (operationRejection !== null) {
      return startRejected(operationRejection);
    }
    // FM2d: まとめて実行は、モードの段の並び（`chainStagesOfMode`）と同じ並びで、どの段の操作もそのモードで許されるときだけ始める。
    if (chainStages !== null) {
      const expected = chainStagesOfMode(stored.profile.mode);
      if (expected !== chainStages) {
        return startRejected('MODE_NOT_EXECUTABLE');
      }
      for (const stageKind of chainStages) {
        const stageRejection = profileOperationRejectionOf(stageKind, stored.profile.mode, stored.profile.auth);
        if (stageRejection !== null) {
          return startRejected(stageRejection);
        }
      }
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
      readCheckDefinitions = standaloneReadChecksOf(this.#database, profileId);
      if (readCheckDefinitions.length === 0) {
        return startRejected('READ_CHECK_DEFINITIONS_MISSING');
      }
    }
    // T25d: 認証つきの監査は、保存した認証の設定が、今のプロファイルの改訂に結びつくとき（`CURRENT`）だけ始める（ターゲット設定を読む前に
    // 確かめる）。設定の中身は、下でターゲット設定を読み直した後に `validateAuthSetup` で検証し直す。
    // T43c: 認証の設定が要るかは、操作ごとの判定（`operationRequiresAuthSetup`）。入口の確かめはログインをしないので、どのモードでも要らない
    // （認証の指定のない `START`）。ほかの操作は、操作の行で受けたモードでは今までの `requiresAuthSetup` と同じ。
    let storedSetup: StoredAuthSetup | null = null;
    if (operationRequiresAuthSetup(jobKind, stored.profile.mode)) {
      storedSetup = getAuthSetup(this.#database, profileId);
      if (storedSetup === null) {
        return startRejected('AUTH_SETUP_MISSING');
      }
      if (storedSetup.freshness !== CURRENT_AUTH_SETUP_FRESHNESS) {
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
      // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.3 の 2）: 「毎回手でログインする」（`MANUAL_EVERY_TIME`）のプロファイルは、自動ログインの
      // 設定があっても手でログインする（自動ログインのセレクタを外した設定を渡す。ログインの検証のジョブは自動ログインだけの操作なので、今どおり）。
      const manualEveryTime = manualLoginEveryTimeApplies(validation.profile, jobKind);
      const startSetup: AuthSetup = manualEveryTime && checked.setup.automatedLogin !== null ? { ...checked.setup, automatedLogin: null } : checked.setup;
      // T26d-2: 自動ログインの設定なら、自動ログインの開始の前の確かめ（資格情報、暗号化、上限）を行う。手動の方式へは切り替えない。
      let automatedLogin: WorkerStartAutomatedLogin | null = null;
      if (startSetup.automatedLogin !== null) {
        const preflight = await this.#autoLoginPreflight(validation.profile, startSetup);
        if ('ok' in preflight) {
          return preflight;
        }
        automatedLogin = preflight.automatedLogin;
      }
      const approvedTestOrigins = [...validation.profile.approvedTestOrigins];
      // T34a: プロファイルの承認したサービスの Origin は、あるときだけ渡す（ないプロファイルの `START` は今のまま）。T34c: あるときだけ SHA-256 にも
      // 入れる（ワーカーが同じ求め方で求め直す）。
      const approvedServiceOrigins = [...(validation.profile.approvedServiceOrigins ?? [])];
      // OP-1（4.1.3 の 1）: 手動のログインのプロファイルのまとめて実行は、ログインの直後に登録する（ワーカーは返事を待つ）。受け取りを許すのは、切り替えられる
      // プロファイルで、希望が自動ログインで、資格情報のファイルがなく、暗号化を使えるときだけ。
      const loginRegistration = chainStages !== null && automatedLogin === null && offersAutomatedLoginSwitch(stored)
        ? { credentialRoot: await this.#credentialCaptureAllowed(validation.profile) ? this.#credentialRoot : null }
        : null;
      authentication = deepFreeze({
        setup: startSetup,
        approvedTestOrigins,
        ...(approvedServiceOrigins.length === 0 ? {} : { approvedServiceOrigins }),
        authenticationSha256: workerAuthenticationDigestOf(startSetup, approvedTestOrigins, { jobKind, automatedLogin, approvedServiceOrigins }),
        ...(automatedLogin === null ? {} : { automatedLogin }),
        ...(loginRegistration === null ? {} : { loginRegistration }),
      });
    }
    // T27d: 出力先は、読み直したターゲット設定の値を、ワーカーの cwd（リポジトリの root）から解決する（ワーカーと同じ場所。結果を読む）。
    const outputDirectory = resolve(this.#repositoryRoot, context.targetConfig.output.directory);
    // T27e: READ の確かめの定義の一覧（対象の候補の画面は、候補を最後に見た発見の成果物から決める）。
    const readChecks = jobKind === WORKER_READ_CHECK_JOB_KIND
      ? await this.#readCheckLaunches(profileId, readCheckDefinitions, outputDirectory, context.targetConfig.site.startUrl)
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
      if (current.status !== ACTIVE_PROFILE_STATUS) {
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
    let writeSpec: WorkerStartWrite | WorkerStartApiWrite | null = null;
    if (grant !== null) {
      const prepared = await this.#prepareWrite({
        jobId, stored, grant, outputDirectory,
        // T40a: 照合の READ の `{id}` の型の画面の READ の対象の画面は、READ の確かめのジョブと同じく開始の URL の Origin で決める。
        startUrl: context.targetConfig.site.startUrl,
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

    // FM2d: まとめて実行の親の側の状態（メモリの中だけ）。最初の段は今始めるジョブ。
    const chain: ChainRun | null = chainStages === null
      ? null
      : {
        chainId: jobId,
        profileId,
        profileRevision: expectedRevision,
        stages: chainStages,
        startUrl: context.targetConfig.site.startUrl,
        stageStates: chainStages.map((_kind, index) => (index === 0
          ? { state: RUNNING_CHAIN_STAGE_STATE, jobId }
          : { state: PENDING_CHAIN_STAGE_STATE, jobId: null })),
        state: RUNNING_CHAIN_STATE,
        stopReason: null,
        stopRequested: false,
        // OP-2: 書き込みのモードのプロファイルだけ、チェックした画面（承認した登録のシナリオ）を書き込みの段の対象にする。
        writeTargets: this.#chainWriteTargets(profileId, stored.profile.mode),
        updatesPrepared: false,
        writeNotTried: false,
        currentWriteStep: null,
        lastWrite: null,
        writeStageJobIds: [],
      };
    if (chain !== null) {
      this.#chains.set(jobId, chain);
    }

    // 4. ワーカーを起動する。
    this.#launchWorker({
      jobId, jobKind, profileId, outputDirectory, targetConfigPath, startNew, targetConfigSha256: digestBefore, authentication, readChecks, writeSpec,
      chain, chainStageIndex: 0, siteOrigins: [...context.targetConfig.site.allowedOrigins],
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
   * T37d（Task 37 の設計書 3.5）: 画面の path の定義の対象の画面は、ターゲット設定の開始の URL（`startUrl`）の Origin と定義の path（ワーカーが同じ
   * 組み立てで確かめ直す）。開始の URL を渡さない・読めないときは `null`（ワーカーは読まない。IPC の契約も拒む）。
   */
  async #readCheckLaunches(
    profileId: string,
    definitions: readonly ReadCheckView[],
    outputDirectory: string,
    startUrl: string | null,
  ): Promise<readonly WorkerStartReadCheck[]> {
    let startOrigin: string | null = null;
    try {
      startOrigin = startUrl === null ? null : new URL(startUrl).origin;
    } catch {
      startOrigin = null;
    }
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
      if (definition.targetPagePath !== undefined) {
        const targetPage: CandidateLocation | null = startOrigin === null ? null : { origin: startOrigin, path: definition.targetPagePath };
        launches.push(deepFreeze({ readCheckId, readCheckRevision: revision, targetPage, definition }));
        continue;
      }
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

  /** DEF-180: ワーカーが終わった時刻を、そのワーカーが読むサイトの Origin ごとに記録する（ただの時刻。待たない）。 */
  #recordSiteWorkerEnd(siteOrigins: readonly string[]): void {
    const endedAtMs = Date.now();
    for (const origin of siteOrigins) {
      this.#siteWorkerEndedAtMs.set(origin, endedAtMs);
    }
  }

  /** DEF-180: 同じサイト（許可 Origin のどれか）を読んだ前のワーカーが終わった、いちばん遅い時刻（なければ `null`）。 */
  #previousNavigationAtMsOf(siteOrigins: readonly string[]): number | null {
    const ends = siteOrigins.flatMap((origin) => {
      const endedAtMs = this.#siteWorkerEndedAtMs.get(origin);
      return endedAtMs === undefined ? [] : [endedAtMs];
    });
    return ends.length === 0 ? null : Math.max(...ends);
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
      lastAuthState: null,
      loginConfirmSent: false,
      manualLoginRecords: null,
      loginRegistration: launch.authentication?.loginRegistration === undefined ? null : { phase: 'WAITING', onSaved: null },
      loginEndDetection: null,
      write: launch.writeSpec === null ? null : {
        grantId: launch.writeSpec.grantId,
        scenarioId: launch.writeSpec.scenarioId,
        scenarioRevision: launch.writeSpec.scenarioRevision,
        recheckRequested: false,
        recheckAllowed: false,
        rejected: false,
        submission: null,
        settled: false,
      },
      startSent: false,
      phase: 'FORKED',
      runStarted: null,
      ending: null,
      exitTimer: undefined,
      processExited: false,
      stopRequested: false,
      forceRequested: false,
      finalizing: false,
      lastHeartbeatMs: performance.now(),
      lastProgressWriteMs: Number.NEGATIVE_INFINITY,
      pendingProgress: null,
      readyTimer: undefined,
      killTimer: undefined,
      progressTimer: undefined,
      exited,
      sessionLost: false,
      recordedResult: null,
      rowRecorded: false,
    };
    this.#jobs.set(jobId, job);
    // FM2d: まとめて実行では、同じワーカーが段ごとに別のジョブになる。受け手は、そのワーカーの今の段のジョブ（`#stageJobOf`）に渡す。
    const current = (): TrackedJob => this.#stageJobs.get(child) ?? job;
    child.on('message', (value: unknown) => this.#guarded(() => this.#receive(current(), value)));
    child.on('error', (error) => {
      this.#onBackgroundError(error);
      this.#guarded(() => this.#end(current(), 'FAILED', 'WORKER_START_FAILED'));
      this.#kill(current());
    });
    child.on('exit', (code, signal) => {
      // DEF-084: 子が最後に送ったメッセージは、`exit` より後に届くことがある。IPC が切れるか期限まで待ち（待つ間のメッセージは `#receive` で
      // 処理する）、それでも終わり方が決まっていなければ、その場で `WORKER_EXITED` に決める（以後のメッセージは捨てる。結果のファイルを読む間に
      // `FINISHED` が割り込まないように、読む前に決める）。
      // FM2d: まとめて実行では、終わったときの段のジョブで決める。
      // DEF-180: ワーカーが終わった時刻（このワーカーの要求は、すべてこの時刻より前）を、読むサイトの Origin ごとに記録する。
      this.#recordSiteWorkerEnd(launch.siteOrigins);
      const stageJob = current();
      stageJob.processExited = true;
      void this.#drainIpc(stageJob)
        .then(() => {
          // DEF-146: IPC の終わりを待っても終わり方が決まっていない（結果の前に落ちた）ジョブは、親が分かる終わり方を受け手に渡す。
          if (stageJob.ending === null) {
            this.#guarded(() => this.#onUnexpectedWorkerExit(Object.freeze({
              jobId: stageJob.jobId,
              jobKind: stageJob.jobKind,
              exitCode: typeof code === 'number' ? code : null,
              signal: typeof signal === 'string' ? signal : null,
            })));
          }
          this.#guarded(() => this.#end(stageJob, 'INTERRUPTED', 'WORKER_EXITED'));
          // T27d: 発見のジョブの Run を実行した結果は、`discovery.json` を読んで確かめてから記録する（読む間も、ジョブは管理の中に残る）。
          // T27e: READ の確かめのジョブの Run を実行した結果も、`read-evidence.json` を読んで確かめてから記録する。
          // FM2d: まとめて実行の途中の段で記録済みなら、読み直さない。
          return stageJob.recordedResult !== null ? null : this.#readJobResult(stageJob);
        })
        .then((verdict) => this.#guarded(() => this.#exited(stageJob, code, verdict)))
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
        // DEF-180（OP-DEF 修正の 1 回目）: 同じサイトを読んだ前のワーカーが終わった時刻（ただの数）。ワーカーの pacer が、ここから読み込みの間隔を空ける。
        const previousNavigationAtMs = this.#previousNavigationAtMsOf(job.siteOrigins);
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
          // FM-2: Run の Browser を起動するジョブは、プロファイルの表示の設定（既定は表示）を、ジョブの開始のときに読んで渡す。
          ...(WORKER_JOB_KINDS_WITH_JOB_BROWSER.includes(job.jobKind)
            ? { showJobBrowser: readProfileDisplaySettings(this.#database, job.profileId).showJobBrowser }
            : {}),
          // AS-b: 監査・発見・READ の確かめのジョブは、プロファイルの監査の段の送信の扱い（既定は読み取りだけ）を、ジョブの開始のときに読んで渡す。OP-N（設計書
          // 4.1.7 の N2）: 書き込みのジョブも渡す（書き込みの段の Context にも、監査の段と同じ送信の扱いを当てる）。
          ...(WORKER_JOB_KINDS_ACCEPTING_AUDIT_SEND_POLICY.includes(job.jobKind)
            ? { auditSendPolicy: readProfileDisplaySettings(this.#database, job.profileId).auditSendPolicy }
            : {}),
          // PRE42-BN（2026-10-24 のユーザーの判断）: 監査のジョブは、プロファイルの名前（画面の「名前（profileId）」をそのまま）を渡す。ChatGPT 用バンドルの
          // ファイル名だけに使う（ワーカーは管理データを読まないので、`START` で渡す。成果物の中身には入れない）。
          ...(job.jobKind === WORKER_AUDIT_JOB_KIND ? { profileName: job.profileId } : {}),
          // FM2d: まとめて実行の段の並び（最初の段のジョブだけが `START` を送る）。
          // OP-2: チェックした画面があれば、読み取りの段の後に書き込みの段を続ける印を入れる。OP-H: 印と一緒に、チェックした画面の数だけを渡す（監査の段の報告が、
          // この後に登録・更新することを言う。報告は判定しない）。
          ...(job.chain === null ? {} : {
            chain: {
              stages: job.chain.stages,
              ...(job.chain.writeTargets.length > 0 ? { writeStages: true as const, writeScreenCount: job.chain.writeTargets.length } : {}),
            },
          }),
          ...(previousNavigationAtMs === null ? {} : { previousNavigationAtMs }),
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
        // FM2d: まとめて実行の 2 つ目からの段は、ログインの段を持たない（セッションの切れだけを受ける）。
        if (job.authentication === null || job.phase !== (sessionLost ? 'RUN' : 'STARTED') || (job.chainStageIndex > 0 && !sessionLost)) {
          this.#violate(job);
          return;
        }
        if (sessionLost) {
          job.sessionLost = true;
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
        // T34e: 手動のログインの段の結果が持つ、数のまとめと、止めた読み取りでない要求の一覧を、ジョブの行に 1 回だけ残す（Run の成果物には入れない）。
        // T43d: ログインの段で観察したこと（`loginObservation`）も、同じ決まりで 1 回だけ残す。
        // DEF-139: 状態の名前の記録（`loginStateNames`）も、同じ決まりで 1 回だけ残す。
        const { scriptLogin, blockedRequests, loginObservation, passedRequests, loginStateNames } = message;
        // T34R-fix-a（T34R の I-1）: ログインを待っている状態（`WORKER_STOPPED_LOGIN_STAGE_STATE`）が数か一覧を持つのは、止める要求で終わったログインの
        // 段だけ。止める要求を送っていないジョブの、その形のメッセージは信用しない。
        // T34R2-fix（T34R2 の M-3）: `START` を送っていないジョブ（`START` の前に止める要求を受け、`START` の代わりに `STOP` を送った）では、ログインの段は
        // 始まっていないので、その形のメッセージは信用しない。
        if (
          message.state === WORKER_STOPPED_LOGIN_STAGE_STATE
          && (scriptLogin !== undefined || blockedRequests !== undefined || loginObservation !== undefined || passedRequests !== undefined
            || loginStateNames !== undefined)
          && (!job.stopRequested || !job.startSent)
        ) {
          this.#violate(job);
          return;
        }
        // T34R2-fix（T34R2 の M-4）: スクリプトで送るログインの数は、認証の設定の送り方が `SCRIPT_REQUEST` のジョブだけが送る。フォームの送信のジョブで
        // 受けたら信用しない（止めた要求の一覧は、どちらの送り方でも受ける）。
        if (scriptLogin !== undefined && loginTransportOf(job.authentication.setup) === FORM_NAVIGATION_TRANSPORT) {
          this.#violate(job);
          return;
        }
        // ML-a: 手動のログインの段で通した送信の一覧は、手動のログインのジョブだけが送る（自動ログインのジョブで受けたら信用しない）。
        if (passedRequests !== undefined && automated) {
          this.#violate(job);
          return;
        }
        const loginStage = scriptLogin === undefined && blockedRequests === undefined && loginObservation === undefined && passedRequests === undefined
          && loginStateNames === undefined
          ? null
          : {
            scriptLogin: scriptLogin ?? null,
            blockedRequests: blockedRequests ?? null,
            ...(loginObservation === undefined ? {} : { observation: loginObservation }),
            ...(passedRequests === undefined ? {} : { passedRequests }),
            ...(loginStateNames === undefined ? {} : { stateNames: loginStateNames }),
          };
        // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.3 の 1）: 値の受け取りのメタデータは、ログインの直後の登録を待つジョブの成功だけが持ち、
        // 受け取ったのは受け取りを許したジョブだけ。違えば信用しない。
        const capture = message.credentialCapture;
        const registration = job.loginRegistration;
        if (capture !== undefined && (registration === null || registration.phase !== 'WAITING'
          || (capture.captured && job.authentication.loginRegistration?.credentialRoot === null))) {
          this.#violate(job);
          return;
        }
        if (message.loginEndDetection !== undefined) {
          job.loginEndDetection = message.loginEndDetection;
        }
        // DEF-138: セッションの切れの証拠（`SESSION_LOST` だけ。契約の確かめは済み）も、ジョブの行に 1 回だけ残す。
        recordAuthState(this.#database, job.jobId, message.state, message.sessionLostUrl, loginStage, message.sessionLoss ?? null);
        job.lastAuthState = message.state;
        // OP-1: ログインの直後の登録を待つジョブは、ここで登録と切り替えを始める（ジョブの終わりの自動の登録はしない）。
        if (message.state === 'AUTHENTICATED' && !automated && registration !== null && registration.phase === 'WAITING') {
          registration.phase = 'REGISTERING';
          const registering = this.#registerRightAfterLogin(job, {
            passedRequests, observation: loginObservation, captured: capture?.captured === true, carriedBy: capture?.carriedBy ?? null,
          }).catch((error: unknown) => {
            this.#onBackgroundError(error);
            this.#finishLoginRegistration(job, null);
          });
          this.#registrations.add(registering);
          void registering.finally(() => this.#registrations.delete(registering));
          return;
        }
        // ML-a: 手動のログインの成功の記録（ジョブが終わった後の自動の登録の材料。メモリの中だけ）。
        if (message.state === 'AUTHENTICATED' && !automated && passedRequests !== undefined && job.manualLoginRecords === null) {
          job.manualLoginRecords = { passedRequests, observation: loginObservation };
        }
        if (job.jobKind === WORKER_LOGIN_CHECK_JOB_KIND && message.state === 'AUTHENTICATED') {
          // ログインの検証の成功: Run を作らないので、ここで終わり方を決める（記録はワーカーが終わった後）。
          this.#settle(job, { kind: 'LOGIN_CHECKED' });
          this.#awaitExit(job);
        }
        return;
      }
      case 'CREDENTIAL_SAVED': {
        // OP-1: 受け取った値を書いたかの知らせは、許しを送って待っているときだけ（1 回）。
        const registration = job.loginRegistration;
        const onSaved = registration?.phase === 'AWAITING_SAVE' ? registration.onSaved : null;
        if (registration === null || onSaved === null) {
          this.#violate(job);
          return;
        }
        registration.onSaved = null;
        onSaved(message);
        return;
      }
      case 'HEARTBEAT':
        if (job.phase === 'FORKED') {
          this.#violate(job);
          return;
        }
        this.#heartbeat(job);
        return;
      case 'RUN_FINALIZING':
        // DEF-143: `START` の後だけ（`FINISHED` と同じ段階）。その後は、見張りの途絶えの上限を延ばす（知らせそのものも、生きている合図として数える）。
        if (job.phase !== 'STARTED' && job.phase !== 'RUN') {
          this.#violate(job);
          return;
        }
        job.finalizing = true;
        this.#heartbeat(job);
        return;
      case 'FINISHED': {
        // T27d: 件数の要約は、発見のジョブの Run を実行した結果（`RAN`）だけが、必ず持つ（ほかのジョブと結果は持たない）。
        // T27e: READ の確かめの件数の要約も同じ（READ の確かめのジョブの Run を実行した結果だけが、必ず持つ）。
        const ran = message.outcome.kind === 'RAN';
        const expectsSummary = job.jobKind === WORKER_DISCOVERY_JOB_KIND && ran;
        const expectsReadCheckSummary = job.jobKind === WORKER_READ_CHECK_JOB_KIND && ran;
        // T43c: 入口の確かめの件数の要約も同じ（入口の確かめのジョブの Run を実行した結果だけが、必ず持つ）。
        const expectsEntryCheckSummary = job.jobKind === WORKER_ENTRY_CHECK_JOB_KIND && ran;
        // FM2d: まとめて実行の段の Run を実行した結果だけが、未完了の理由のコードを必ず持つ（ほかは持たない）。
        const expectsReasonCodes = job.chain !== null && ran;
        if (
          (job.phase !== 'STARTED' && job.phase !== 'RUN')
          || !this.#matchesRunStarted(job, message.outcome)
          || job.jobKind === WORKER_LOGIN_CHECK_JOB_KIND
          || expectsSummary !== (message.discovery !== undefined)
          || expectsReadCheckSummary !== (message.readCheck !== undefined)
          || expectsEntryCheckSummary !== (message.entryCheck !== undefined)
          || expectsReasonCodes !== (message.incompleteReasonCodes !== undefined)
        ) {
          this.#violate(job);
          return;
        }
        this.#settle(job, {
          kind: 'FINISHED',
          outcome: message.outcome,
          discovery: message.discovery ?? null,
          readCheck: message.readCheck ?? null,
          entryCheck: message.entryCheck ?? null,
          incompleteReasonCodes: message.incompleteReasonCodes ?? [],
        });
        // FM2d: まとめて実行の途中の段は、ワーカーを終えさせずに、次の段へ進めるかを決める（ワーカーは `NEXT_STAGE`・`CHAIN_END` を待つ）。
        const { chain } = job;
        if (chain !== null && this.#chainAwaitsParent(job, chain)) {
          void this.#advanceChain(job, chain).catch((error: unknown) => {
            this.#onBackgroundError(error);
            this.#guarded(() => this.#stopChainAt(job, chain, 'NEXT_STAGE_REJECTED'));
          });
          return;
        }
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
    /** T40a: ターゲット設定の開始の URL（`{id}` の型の画面の READ の対象の画面の Origin）。 */
    readonly startUrl: string;
    readonly startOf: (write: WorkerStartWrite | WorkerStartApiWrite) => ParentToWorkerMessage;
  }): Promise<
    WorkerStartWrite | WorkerStartApiWrite | 'WRITE_GRANT_REJECTED' | 'WRITE_DATA_NOT_GENERATED' | typeof WRITE_READ_VERIFICATION_PAGE_TARGET
  > {
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
      // T37d（設計者の判断 5）: 照合の READ に、画面の path の定義は使わない（書き込みは送らずに締める）。T38c: API のシナリオの `{id}` の型だけ通す。
      // OP-R（設計書 4.1.9 の R1）: API の登録は、登録の画面の 1 つ上の一覧の画面の定義も通す（`apiCreateReadListPagePathOf`）。
      const readVerificationRejection = readVerificationTargetRejectionOf(
        readCheck, scenarioTransportOf(revision.scenario), apiCreateReadListPagePathOf(revision.scenario, revision.evidence),
      );
      if (readVerificationRejection !== null) {
        return readVerificationRejection;
      }
      // T40a: API のシナリオの `{id}` の型の画面の READ は、開始の URL の Origin と型の path を対象の画面にする（FORM のシナリオは上で画面の READ を
      // 拒んでいるので、今までどおり候補の READ だけ）。
      const [launch] = await this.#readCheckLaunches(profileId, [readCheck], input.outputDirectory, input.startUrl);
      const spec = writeStartSpecOf({
        scenario: revision.scenario, evidence: revision.evidence, grantId: grant.grantId, values: generated.values, readCheck,
        targetPage: launch?.targetPage ?? null,
        // T30f（Blocker 1 の案 A）: 送る前の記録に書くのと同じプロファイルと seed の記録。
        profileId, seedRecord: generated.seedRecord,
        // T31f: 更新の対象の ID は、許可からだけ取る（CREATE の許可は null）。
        targetRecordId: grant.targetRecordId,
        // T41R2-fix-B・T41R3-fix-B: 同じ台帳の書き込みの値の履歴（API の更新の、保つ鍵ごとの最後に分かっている値を求める。`knownKeptValuesOf`）。
        ledgerWrites: grant.targetRecordId === null ? [] : readLedgerValueWrites(this.#database, grant.scenarioId),
        approvalFacts,
        // OP-REV6 の I-1: 一覧の画面の照合の READ は、実行のたびに違う値になる欄と比べるときだけ作る（許可の発行と同じ判定の部品）。
        uniqueEachRunFieldNames: uniqueEachRunFieldNamesOf(planRuleSet(rules.ruleSet, revision.scenario, revision.evidence)),
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
    const failedReason = job.rowRecorded ? (job.recordedResult?.failedReason ?? null) : this.#recordExitedJob(job, ending, code, result, at);
    // FM2d: まとめて実行は、ワーカーが終わった段で終わる（最後の段なら進むかと同じ判定で決める、途中なら止まった）。
    if (job.chain !== null) {
      this.#closeChainAtExit(job, job.chain, failedReason);
    }
    // ML-a: 手動のログインに成功したジョブは、終わった後に（ジョブの結果を始めたときのプロファイルの改訂で記録した後に）、通した送信の記録から組み立てた
    // 認証の設定を自動で登録する（終わり方によらない。背後で行い、誤りは背後の誤りの受け手に渡す）。FM2d: まとめて実行では、連鎖の最後に 1 回だけ（記録は
    // ログインの段を行った最初の段のジョブ）。
    if (job.manualLoginRecords !== null) {
      const registration = this.#registerManualLogin(job, job.manualLoginRecords, job.chain?.chainId ?? job.jobId)
        .catch((error: unknown) => this.#onBackgroundError(error));
      this.#registrations.add(registration);
      void registration.finally(() => this.#registrations.delete(registration));
    }
    // MI-3: 入口の確かめのジョブが確かめた成果物で終わったら、背後で（手動のログインの自動の登録と同じ作法）、認証の設定を案で保存する。
    if (job.jobKind === WORKER_ENTRY_CHECK_JOB_KIND && result?.kind === 'ENTRY_CHECK' && failedReason === null) {
      const saving = this.#saveEntryCheckProposal(job, result.document).catch((error: unknown) => this.#onBackgroundError(error))
        // OP-1: 印つきの下調べは、案の保存の後に続けて点検を始める（判定は `#startAfterEntryCheck` の 1 か所）。OP-1 修正の 2 回目: 開始のページを読めた
        // （`READ`）ときだけ、失敗なしの終わりとして渡す（開けなかった・止めた下調べの後に、ログインの設定の要らない公開のサイトの点検を始めない）。
        .then(() => this.#startAfterEntryCheck(job, result.document.endReason === ENTRY_CHECK_READ_END_REASON))
        .catch((error: unknown) => this.#onBackgroundError(error));
      this.#registrations.add(saving);
      void saving.finally(() => this.#registrations.delete(saving));
    } else if (job.jobKind === WORKER_ENTRY_CHECK_JOB_KIND) {
      const following = this.#startAfterEntryCheck(job, false).catch((error: unknown) => this.#onBackgroundError(error));
      this.#registrations.add(following);
      void following.finally(() => this.#registrations.delete(following));
    }
  }

  /**
   * ワーカーが終わったジョブの行を記録する（`#exited` から分けた。振る舞いは変えない）。FM2d: まとめて実行の途中の段で結果を記録済みなら、記録し直さない。
   * 記録した失敗の理由（なければ `null`）を返す（FM2R 確かめ直しの R-1: まとめて実行の最後の段の終わりの判定に使う）。
   */
  #recordExitedJob(job: TrackedJob, ending: JobEnding, code: number | null, result: JobResultVerdict | null, at: string): AuditJobFailureReason | null {
    let failedReason = job.recordedResult !== null
      ? job.recordedResult.failedReason
      : (ending.kind === 'FINISHED' && result !== null ? this.#recordJobResult(job, result, at) : null);
    // T30e: 書き込みのジョブは、ジョブを終わりの状態にする前に、書き込みの結果を必ず 1 回締める。確かめ直しで拒んだジョブは `WRITE_GRANT_REJECTED`、
    // Run を実行した結果の `action-run.json` を使えなかったジョブは `WRITE_RESULT_INVALID` で `FAILED`。
    if (job.write !== null && !job.write.settled) {
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
    this.#recordJobRow(job, ending, code, failedReason, at);
    return failedReason;
  }

  /**
   * ジョブの行の終わり方を記録し、結果のない自動ログインの試しを閉じる（`#exited` から分けた。振る舞いは変えない）。FM2d: まとめて実行の次の段へ進めるときも、
   * これで今の段の行を締める（終了コードは `FINISHED` の結果のもの）。
   */
  #recordJobRow(job: TrackedJob, ending: JobEnding, code: number | null, failedReason: AuditJobFailureReason | null, at: string): void {
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

  // -------------------------------------------------------------------------------------------------------------
  // まとめて実行（FM2d）
  // -------------------------------------------------------------------------------------------------------------

  /**
   * FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の途中の段の `FINISHED` の後に、次の段へ進むかを決めて進める。
   * 1. 段の結果のファイルを読み、記録する（発見の索引。今の決め方 `#readJobResult`・`#recordJobResult`）。読む間も、段のジョブの行は動いている状態のまま
   *    （ほかのジョブは始まらない）。
   * 2. 進むかを純粋な判定（`chainAdvanceDecisionOf`）で決める（止める要求、段の結果、理由のコード、セッションの切れ、改訂）。
   * 3. 次が READ の確かめなら、定義の件数を見る（0 件なら READ を行わずに連鎖を終える）。対象の画面は、索引を記録した後に今の決め方（`#readCheckLaunches`）で
   *    決め、待った後にもう一度判定する。
   * 4. 進むなら、今の段の行を締めることと次の段の行を作ることを、await を挟まずに続けて行い（`#advanceToNextStage`）、`NEXT_STAGE` を送る。止めるなら
   *    `CHAIN_END` を送り、ワーカーの終わりを待つ（行はワーカーが終わったときに記録する）。
   * 待つ間にワーカーが終わったら、何もしない（終わったときの記録に任せる）。
   */
  async #advanceChain(job: TrackedJob, chain: ChainRun): Promise<void> {
    const ending = job.ending;
    if (ending?.kind === 'FINISHED' && job.write !== null) {
      // OP-2: 書き込みの段の後（結果を締め、残りの書き込みを続けるかを決める）。
      await this.#advanceAfterWriteStage(job, chain, ending, job.write);
      return;
    }
    const nextKind = chain.stages[job.chainStageIndex + 1];
    if (ending?.kind !== 'FINISHED' || nextKind === WORKER_AUDIT_JOB_KIND || (nextKind === undefined && chain.writeTargets.length === 0)) {
      this.#stopChainAt(job, chain, 'NEXT_STAGE_REJECTED');
      return;
    }
    const verdict = await this.#readJobResult(job);
    if (job.processExited) {
      return;
    }
    const failedReason = verdict === null ? null : this.#recordJobResult(job, verdict, this.#timestamp());
    job.recordedResult = { failedReason };
    const decide = (): ChainAdvanceDecision => {
      const current = getProfile(this.#database, chain.profileId);
      return chainAdvanceDecisionOf({
        stopRequested: job.stopRequested || chain.stopRequested,
        outcomeRan: ending.outcome.kind === 'RAN',
        stageResultValid: failedReason === null,
        stageRunStatus: ending.outcome.runStatus,
        incompleteReasonCodes: ending.incompleteReasonCodes,
        sessionLost: job.sessionLost,
        profileRevisionUnchanged: current !== null && current.status === ACTIVE_PROFILE_STATUS && current.profile.revision === chain.profileRevision,
      });
    };
    let decision = decide();
    let readChecks: readonly WorkerStartReadCheck[] | null = null;
    if (decision.kind === 'CONTINUE' && nextKind === WORKER_READ_CHECK_JOB_KIND) {
      const definitions = standaloneReadChecksOf(this.#database, chain.profileId);
      if (chainReadCheckDecisionOf(definitions.length) === 'NOT_NEEDED') {
        // OP-2: チェックした画面があれば、READ の確かめを行わずに書き込みの段へ進む。
        if (chain.writeTargets.length > 0 && !this.#closing && !this.#instanceLockLost) {
          await this.#advanceToWriteStage(job, chain, ending);
          return;
        }
        // READ の確かめの定義がない: 行わなかったとして連鎖を終える（失敗にしない）。
        this.#closeChain(chain, null, NOT_NEEDED_CHAIN_STAGE_STATE);
        this.#send(job, { protocol: WORKER_PROTOCOL_VERSION, type: 'CHAIN_END' });
        this.#awaitExit(job);
        return;
      }
      readChecks = await this.#readCheckLaunches(chain.profileId, definitions, job.outputDirectory, chain.startUrl);
      if (job.processExited) {
        return;
      }
      decision = decide();
    }
    if (decision.kind === 'STOP') {
      this.#stopChainAt(job, chain, decision.reason);
      return;
    }
    if (this.#closing || this.#instanceLockLost) {
      this.#stopChainAt(job, chain, 'NEXT_STAGE_REJECTED');
      return;
    }
    if (nextKind === undefined) {
      // OP-2: 最後の読み取りの段の後は、書き込みの段。
      await this.#advanceToWriteStage(job, chain, ending);
      return;
    }
    this.#advanceToNextStage(job, chain, ending, nextKind, readChecks);
  }

  // -------------------------------------------------------------------------------------------------------------
  // OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'〜D9'、4.1.2 の案 C）: 連鎖の最後の書き込みの段
  // -------------------------------------------------------------------------------------------------------------

  /**
   * OP-2: 書き込みの段の対象（チェックした画面）。書き込みのモードのプロファイルの、承認した登録のシナリオと、その台帳に結ぶ承認した更新のシナリオ（決まりは
   * `chainWriteTargetsOf`）。ほかのモードは空。
   */
  #chainWriteTargets(profileId: string, mode: SiteProfile['mode']): readonly ChainWriteTarget[] {
    if (mode !== WRITE_AUDIT_MODE) {
      return [];
    }
    return chainWriteTargetsOf(listScenarios(this.#database, profileId).map((scenario) => ({
      scenarioId: scenario.scenarioId,
      kind: scenario.current.kind,
      approved: scenario.state === 'APPROVED',
      ledgerScenarioId: updateLedgerScenarioIdOf(scenario.current),
    })));
  }

  /**
   * OP-2 の修正の 3 回目（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.2 の R1。設計者の判断（案 A））: 最初の書き込みの段の前の、更新の下書きと承認。
   * - 対象は、承認が今も有効な登録のシナリオ（チェックした画面）のうち、その台帳に結ぶ更新のシナリオがまだないもの（取り消した・無効になった更新があれば、
   *   作り直さず、承認し直さない。R3）。
   * - 下書きは、この点検の発見の段の操作さがしの結果（索引の最後の発見が、この点検の発見の段のジョブのときだけ。ほかの発見の結果では作らない）で、共有の部品
   *   （`draftUpdateForCreate`。画面の一覧のチェックの保存と同じ 1 か所）が作る。
   * - 承認は、共有の部品（`approveForCheck`。`approveScenario` を `confirmSideEffects: true` で呼ぶ）。チェックの意味が「その画面で登録と更新を試す」なので、
   *   チェックの範囲の中で行う。承認の有効さの判定は変えない（版・digest・今の事実は承認の口が確かめ直す）。許可は、ここでは出さない（次の段の前に今どおり発行する）。
   * - 作れない・承認できない画面は、更新をしない（登録だけ）。誤りは知らせて、点検は続ける。
   */
  async #prepareChainUpdates(job: TrackedJob, chain: ChainRun): Promise<void> {
    try {
      const stored = getProfile(this.#database, chain.profileId);
      const discoveryStage = chain.stages.indexOf(WORKER_DISCOVERY_JOB_KIND);
      const discoveryJobId = discoveryStage < 0 ? null : chain.stageStates[discoveryStage]?.jobId ?? null;
      if (stored === null || stored.status !== ACTIVE_PROFILE_STATUS || stored.profile.revision !== chain.profileRevision || stored.profile.mode !== WRITE_AUDIT_MODE
        || discoveryJobId === null || readDiscoveryIndex(this.#database, chain.profileId).latestJobId !== discoveryJobId) {
        return;
      }
      const scenarios = listScenarios(this.#database, chain.profileId);
      const bound = new Set(scenarios.flatMap(({ current }) => {
        const ledger = current.kind === 'UPDATE' ? updateLedgerScenarioIdOf(current) : null;
        return ledger === null ? [] : [ledger];
      }));
      const creates = scenarios.filter(({ scenarioId, current, state }) => current.kind === 'CREATE' && state === 'APPROVED' && !bound.has(scenarioId));
      if (creates.length === 0) {
        return;
      }
      const external = await approvalExternalFactsOf(stored, {
        database: this.#database, repositoryRoot: this.#repositoryRoot, credentialStore: this.#credentials(),
      });
      const runDirectory = readJob(this.#database, discoveryJobId)?.runDirectory ?? null;
      const value = runDirectory === null ? null : await this.#readRunArtifact(job.outputDirectory, runDirectory, DISCOVERY_ARTIFACT_FILE_NAME, 'discovery');
      if (job.processExited || external === null || value === null || (value as DiscoveryDocument).jobId !== discoveryJobId) {
        return;
      }
      const facts = { database: this.#database, profileId: chain.profileId, discovery: value as DiscoveryDocument, clock: (): string => this.#timestamp() };
      for (const { scenarioId } of creates) {
        const status = readScenarioApprovalStatus(this.#database, scenarioId, external, this.#now());
        if (status === null || !status.validity.approved) {
          continue;
        }
        const updateScenarioId = draftUpdateForCreate(facts, scenarioId);
        if (updateScenarioId !== null) {
          // OP-F（M-3）: 更新の画面の知らせを、チェックが確かめていなければ承認しない（行に 1 行が出る）。
          approveUpdateForChain(this.#database, scenarioId, updateScenarioId, external, facts.clock);
        }
      }
    } catch (error) {
      this.#onBackgroundError(error);
    }
  }

  /** OP-2: 段の `FINISHED` の後に、ワーカーが親の `NEXT_STAGE`・`CHAIN_END` を待つか（途中の読み取りの段か、書き込みの段の印のある連鎖の後の段）。 */
  #chainAwaitsParent(job: TrackedJob, chain: ChainRun): boolean {
    return job.chainStageIndex < chain.stages.length - 1 || chain.writeTargets.length > 0;
  }

  /**
   * OP-2: 書き込みの段の結果を締める（ワーカーが終わったときの締め `#recordExitedJob` と同じ部品と順。次の段へ進む前に 1 回だけ。締めた印を付ける）。記録した
   * 失敗の理由（なければ `null`）を返す。
   */
  #settleChainWriteStage(job: TrackedJob, write: WriteJobState, ending: Extract<JobEnding, { readonly kind: 'FINISHED' }>, result: JobResultVerdict | null, at: string): AuditJobFailureReason | null {
    let failedReason: AuditJobFailureReason | null = result === null ? null : this.#recordJobResult(job, result, at);
    const fromDocument = this.#settleWrite(job, result, at);
    write.settled = true;
    if (write.rejected) {
      failedReason = WRITE_GRANT_REJECTED_REASON;
    } else if (ending.outcome.kind === 'RAN' && !fromDocument) {
      failedReason = WRITE_RESULT_INVALID_REASON;
    }
    if (ending.outcome.kind === 'RAN') {
      const reportCheck: WriteReportCheck = fromDocument && result?.kind === 'WRITE' ? result.reportCheck : WRITE_REPORT_RESULT_INVALID;
      this.#guarded(() => recordWriteReportCheck(this.#database, job.jobId, reportCheck));
    }
    return failedReason;
  }

  /**
   * OP-2: 書き込みの段の後。結果のファイルを読み、書き込みの結果を締め、残りの書き込みを続けるか（`chainWriteAdvanceDecisionOf`。結果が分からない・安全の違反・
   * ログインの切れ・止める要求・改訂の変化なら止める）を決める。続けるなら次の書き込みの段へ。
   */
  async #advanceAfterWriteStage(job: TrackedJob, chain: ChainRun, ending: Extract<JobEnding, { readonly kind: 'FINISHED' }>, write: WriteJobState): Promise<void> {
    const verdict = await this.#readJobResult(job);
    if (job.processExited) {
      return;
    }
    const failedReason = this.#settleChainWriteStage(job, write, ending, verdict, this.#timestamp());
    job.recordedResult = { failedReason };
    const settled = readWriteResult(this.#database, job.jobId);
    const step = chain.currentWriteStep;
    if (step !== null) {
      chain.lastWrite = { step, createRecordId: step.kind === 'CREATE' && settled?.result === VERIFIED_ACTION_RESULT ? settled.recordId : null };
    }
    chain.currentWriteStep = null;
    const current = getProfile(this.#database, chain.profileId);
    const decision = chainWriteAdvanceDecisionOf({
      stopRequested: job.stopRequested || chain.stopRequested,
      result: settled?.result ?? null,
      stageRunStatus: ending.outcome.runStatus,
      sessionLost: job.sessionLost,
      profileRevisionUnchanged: current !== null && current.status === ACTIVE_PROFILE_STATUS && current.profile.revision === chain.profileRevision,
    });
    if (decision.kind === 'STOP' || step === null) {
      this.#stopChainAt(job, chain, decision.kind === 'STOP' ? decision.reason : 'NEXT_STAGE_REJECTED');
      return;
    }
    if (this.#closing || this.#instanceLockLost) {
      this.#stopChainAt(job, chain, 'NEXT_STAGE_REJECTED');
      return;
    }
    await this.#advanceToWriteStage(job, chain, ending);
  }

  /**
   * OP-2: 次の書き込みの段を始める（なければ連鎖を終える）。段ごとに、今の書き込みの流れの部品をそのまま通す。
   * 1. 次の段（`nextChainWriteStepOf`。1 つの画面につき登録 1 件と更新 1 件まで）を決め、その画面の許可を発行する（`issueExecutionGrant`。承認の有効さ・上限・
   *    更新の対象（登録の番号）を今の判定で確かめる）。発行を拒まれた画面は送らずに次へ（R3: 承認し直さない）。
   * 2. 今の段の行を締めることと、次の段の行を作ることを、await を挟まずに続けて行う（段の間に、ほかのジョブを始める空きを作らない）。
   * 3. 書き込みの準備（`#prepareWrite`。許可の消費、値の生成、書き込みの指定、送る前の記録）。止まったら、その段の行を `FAILED` にし、予約を締めて次へ。
   * 4. ワーカーの今の段を置き換え、`NEXT_STAGE`（書き込みの指定つき）を送る。
   */
  async #advanceToWriteStage(job: TrackedJob, chain: ChainRun, ending: Extract<JobEnding, { readonly kind: 'FINISHED' }>): Promise<void> {
    if (!chain.updatesPrepared) {
      // OP-2 の修正の 3 回目（R1）: 最初の書き込みの段の前に 1 回だけ、この点検の操作さがしの結果で、更新がまだない画面の更新の下書きと承認を行い、対象を求め直す。
      chain.updatesPrepared = true;
      await this.#prepareChainUpdates(job, chain);
      if (job.processExited) {
        return;
      }
      chain.writeTargets = this.#chainWriteTargets(chain.profileId, getProfile(this.#database, chain.profileId)?.profile.mode ?? WRITE_AUDIT_MODE);
    }
    // OP-F（安全のレビューの M-1）: 止める要求（画面の「やめる」）は、親が書き込みの段を準備している間にも届く。許可の発行の前と `NEXT_STAGE` の前に見直す。
    const stopRequested = (): boolean => job.stopRequested || chain.stopRequested;
    for (;;) {
      if (stopRequested()) {
        this.#stopChainAt(job, chain, 'USER_STOPPED');
        return;
      }
      const step = nextChainWriteStepOf(chain.writeTargets, chain.lastWrite);
      if (step === null) {
        // チェックした画面をすべて試した（行わなかった READ の確かめは「行わなかった」）。OP-F（M-1）: 試せなかった画面があれば、その理由で終える。
        this.#closeChain(chain, chain.writeNotTried ? 'WRITE_NOT_TRIED' : null, NOT_NEEDED_CHAIN_STAGE_STATE);
        this.#send(job, { protocol: WORKER_PROTOCOL_VERSION, type: 'CHAIN_END' });
        this.#awaitExit(job);
        return;
      }
      const target = chain.writeTargets[step.targetIndex];
      const scenarioId = step.kind === 'CREATE' ? target?.createScenarioId : target?.updateScenarioId;
      const stored = getProfile(this.#database, chain.profileId);
      if (stored === null || stored.status !== ACTIVE_PROFILE_STATUS || stored.profile.revision !== chain.profileRevision) {
        this.#stopChainAt(job, chain, 'PROFILE_REVISION_CHANGED');
        return;
      }
      const scenario = scenarioId === undefined || scenarioId === null ? null : readScenario(this.#database, scenarioId);
      const facts = scenario === null ? null : await approvalExternalFactsOf(stored, {
        database: this.#database, repositoryRoot: this.#repositoryRoot, credentialStore: this.#credentials(),
      });
      if (job.processExited) {
        return;
      }
      if (stopRequested()) {
        this.#stopChainAt(job, chain, 'USER_STOPPED');
        return;
      }
      const jobKind = step.kind === 'CREATE' ? WORKER_WRITE_CREATE_JOB_KIND : WORKER_WRITE_UPDATE_JOB_KIND;
      const nextJobId = randomUUID();
      const grantId = randomUUID();
      const issuedAt = this.#timestamp();
      const targetRecordId = step.kind === 'UPDATE' ? chain.lastWrite?.createRecordId ?? null : null;
      const issued = scenario === null || facts === null || (step.kind === 'UPDATE' && targetRecordId === null)
        ? null
        : issueExecutionGrant(this.#database, {
          scenarioId: scenario.scenarioId,
          expectedRevision: scenario.revision,
          grantId,
          jobId: nextJobId,
          count: DEFAULT_MAX_CREATES_PER_RUN,
          ...(targetRecordId === null ? {} : { expectedTargetRecordId: targetRecordId }),
          external: facts,
          at: issuedAt,
        });
      if (issued === null || !issued.ok) {
        // その画面は送らない（R3: 承認し直さない）。登録を送らなかった画面の更新もしない。OP-F（M-1）: 試せなかったことを連鎖の結果に残す。
        chain.lastWrite = { step, createRecordId: null };
        chain.writeNotTried = true;
        continue;
      }
      if (!job.rowRecorded) {
        this.#recordJobRow(job, ending, ending.outcome.exitCode, job.recordedResult?.failedReason ?? null, issuedAt);
        job.rowRecorded = true;
      }
      const created = createStartingJob<AuditJobStartRejectionReason>(this.#database, {
        jobId: nextJobId, jobKind, profileId: chain.profileId, profileRevision: chain.profileRevision, startNew: true, createdAt: issuedAt,
      }, (connection) => {
        if (!this.#holdsInstanceLock(connection)) {
          return 'CONTROL_INSTANCE_LOCK_LOST';
        }
        const now = getProfile(this.#database, chain.profileId);
        return now === null || now.status !== ACTIVE_PROFILE_STATUS || now.profile.revision !== chain.profileRevision ? 'PROFILE_REVISION_CONFLICT' : null;
      });
      if (!created.ok) {
        this.#guarded(() => closeWriteWithoutSending(this.#database, { grantId, jobId: nextJobId, at: issuedAt }));
        this.#stopChainAt(job, chain, created.reason === 'PROFILE_REVISION_CONFLICT' ? 'PROFILE_REVISION_CHANGED' : 'NEXT_STAGE_REJECTED');
        return;
      }
      const grant = readExecutionGrant(this.#database, grantId);
      const authentication = job.authentication === null ? null : (({ loginRegistration: _registration, ...kept }) => kept)(job.authentication);
      const prepared = grant === null ? 'WRITE_GRANT_REJECTED' : await this.#prepareWrite({
        jobId: nextJobId, stored, grant, outputDirectory: job.outputDirectory, startUrl: chain.startUrl ?? '',
        startOf: (write) => ({
          protocol: WORKER_PROTOCOL_VERSION, type: 'START', jobId: nextJobId, jobKind, targetConfigPath: job.targetConfigPath, startNew: true,
          targetConfigSha256: job.targetConfigSha256, ...(authentication === null ? {} : { authentication }), write,
        }),
      });
      if (typeof prepared === 'string' || job.processExited || stopRequested()) {
        // 送らずに締め、その段の行を `FAILED` にする（ワーカーが終わっていたら、ここで終える）。OP-F（M-1）: 準備の間に止める要求が届いたときも、送らずに締めて
        // 利用者の停止で止める。準備が通らなかった画面は、試せなかったことを連鎖の結果に残す。
        const at = this.#timestamp();
        this.#guarded(() => closeWriteWithoutSending(this.#database, { grantId, jobId: nextJobId, at }));
        this.#endUntracked(nextJobId, 'FAILED', WRITE_GRANT_REJECTED_REASON);
        chain.lastWrite = { step, createRecordId: null };
        if (job.processExited) {
          return;
        }
        if (typeof prepared !== 'string') {
          this.#stopChainAt(job, chain, 'USER_STOPPED');
          return;
        }
        chain.writeNotTried = true;
        continue;
      }
      this.#startChainWriteStage(job, chain, step, nextJobId, jobKind, prepared);
      return;
    }
  }

  /** OP-2: ワーカーの今の段を書き込みの段に置き換え、`NEXT_STAGE`（書き込みの指定つき）を送る（`#advanceToNextStage` と同じ置き換え方）。 */
  #startChainWriteStage(
    job: TrackedJob,
    chain: ChainRun,
    step: ChainWriteStep,
    nextJobId: string,
    jobKind: WorkerWriteJobKind,
    write: WorkerStartWrite | WorkerStartApiWrite,
  ): void {
    const next: TrackedJob = {
      ...job,
      jobId: nextJobId,
      jobKind,
      startNew: true,
      readChecks: null,
      writeSpec: write,
      write: {
        grantId: write.grantId, scenarioId: write.scenarioId, scenarioRevision: write.scenarioRevision,
        recheckRequested: false, recheckAllowed: false, rejected: false, submission: null, settled: false,
      },
      // 書き込みの段は、最後の段として数える（ワーカーが終わったときの連鎖の終わり方の判定）。
      chainStageIndex: chain.stages.length - 1,
      automatedLoginReported: true,
      loginConfirmSent: true,
      manualLoginRecords: job.manualLoginRecords,
      loginRegistration: null,
      loginEndDetection: null,
      startSent: true,
      phase: 'STARTED',
      runStarted: null,
      ending: null,
      exitTimer: undefined,
      processExited: false,
      stopRequested: false,
      forceRequested: false,
      finalizing: false,
      lastHeartbeatMs: performance.now(),
      lastProgressWriteMs: Number.NEGATIVE_INFINITY,
      pendingProgress: null,
      readyTimer: undefined,
      killTimer: undefined,
      progressTimer: undefined,
      sessionLost: false,
      recordedResult: null,
      rowRecorded: false,
    };
    job.manualLoginRecords = null;
    this.#jobs.delete(job.jobId);
    this.#clearTimers(job);
    this.#jobs.set(nextJobId, next);
    this.#stageJobs.set(job.child, next);
    this.#chains.set(nextJobId, chain);
    chain.currentWriteStep = step;
    chain.writeStageJobIds.push(nextJobId);
    for (const stage of chain.stageStates) {
      if (stage.state === RUNNING_CHAIN_STAGE_STATE) {
        stage.state = DONE_CHAIN_STAGE_STATE;
      }
    }
    this.#guarded(() => recordWorkerPid(this.#database, nextJobId, job.child.pid ?? 0));
    this.#heartbeat(next);
    this.#send(next, { protocol: WORKER_PROTOCOL_VERSION, type: 'NEXT_STAGE', jobId: nextJobId, jobKind, write });
  }


  /**
   * FM2d: 今の段の行を締め、次の段の行を作り、ワーカーの今の段を置き換えて `NEXT_STAGE` を送る（await を挟まない。段の間に、ほかのジョブを始める空きを作らない）。
   * 次の段の行を作れなければ（改訂の変化、管理のロックを失った）、連鎖を止めて `CHAIN_END` を送る。
   */
  #advanceToNextStage(
    job: TrackedJob,
    chain: ChainRun,
    ending: Extract<JobEnding, { readonly kind: 'FINISHED' }>,
    nextKind: WorkerNextStageJobKind,
    readChecks: readonly WorkerStartReadCheck[] | null,
  ): void {
    const at = this.#timestamp();
    this.#recordJobRow(job, ending, ending.outcome.exitCode, job.recordedResult?.failedReason ?? null, at);
    job.rowRecorded = true;
    const nextJobId = randomUUID();
    const created = createStartingJob<AuditJobStartRejectionReason>(this.#database, {
      jobId: nextJobId,
      jobKind: nextKind,
      profileId: chain.profileId,
      profileRevision: chain.profileRevision,
      // 発見と READ の確かめは再開しない（いつも新しい Run）。
      startNew: true,
      createdAt: at,
    }, (connection) => {
      if (!this.#holdsInstanceLock(connection)) {
        return 'CONTROL_INSTANCE_LOCK_LOST';
      }
      const current = getProfile(this.#database, chain.profileId);
      return current === null || current.status !== ACTIVE_PROFILE_STATUS || current.profile.revision !== chain.profileRevision ? 'PROFILE_REVISION_CONFLICT' : null;
    });
    if (!created.ok) {
      this.#stopChainAt(job, chain, created.reason === 'PROFILE_REVISION_CONFLICT' ? 'PROFILE_REVISION_CHANGED' : 'NEXT_STAGE_REJECTED');
      return;
    }
    const next: TrackedJob = {
      ...job,
      jobId: nextJobId,
      jobKind: nextKind,
      startNew: true,
      readChecks,
      chainStageIndex: job.chainStageIndex + 1,
      // 2 つ目からの段は、ログインの段を持たない（自動ログインの結果も、ログインを終えたの知らせも受けない）。
      automatedLoginReported: true,
      loginConfirmSent: true,
      // ML-a: 手動のログインの自動の登録は、連鎖の最後に 1 回だけ（最後の段のジョブへ移す）。
      manualLoginRecords: job.manualLoginRecords,
      // OP-1: ログインの直後の登録は、最初の段の中で済んでいる（次の段は待たない）。
      loginRegistration: null,
      loginEndDetection: null,
      startSent: true,
      phase: 'STARTED',
      runStarted: null,
      ending: null,
      exitTimer: undefined,
      processExited: false,
      stopRequested: false,
      forceRequested: false,
      finalizing: false,
      lastHeartbeatMs: performance.now(),
      lastProgressWriteMs: Number.NEGATIVE_INFINITY,
      pendingProgress: null,
      readyTimer: undefined,
      killTimer: undefined,
      progressTimer: undefined,
      sessionLost: false,
      recordedResult: null,
      rowRecorded: false,
    };
    job.manualLoginRecords = null;
    this.#jobs.delete(job.jobId);
    this.#clearTimers(job);
    this.#jobs.set(nextJobId, next);
    this.#stageJobs.set(job.child, next);
    this.#chains.set(nextJobId, chain);
    const done = chain.stageStates[job.chainStageIndex];
    const started = chain.stageStates[next.chainStageIndex];
    if (done !== undefined) {
      done.state = DONE_CHAIN_STAGE_STATE;
    }
    if (started !== undefined) {
      started.state = RUNNING_CHAIN_STAGE_STATE;
      started.jobId = nextJobId;
    }
    this.#guarded(() => recordWorkerPid(this.#database, nextJobId, job.child.pid ?? 0));
    this.#heartbeat(next);
    this.#send(next, {
      protocol: WORKER_PROTOCOL_VERSION,
      type: 'NEXT_STAGE',
      jobId: nextJobId,
      jobKind: nextKind,
      ...(readChecks === null ? {} : { readChecks }),
    });
  }

  /** FM2d: 連鎖を止めて（理由つき）、ワーカーに `CHAIN_END` を送り、終わりを待つ。 */
  #stopChainAt(job: TrackedJob, chain: ChainRun, reason: ChainStopReason): void {
    this.#closeChain(chain, reason, NOT_STARTED_CHAIN_STAGE_STATE);
    this.#send(job, { protocol: WORKER_PROTOCOL_VERSION, type: 'CHAIN_END' });
    this.#awaitExit(job);
  }

  /**
   * FM2d: 連鎖を終える（止める理由があれば `STOPPED`、なければ `FINISHED`）。行っている段は `DONE`、まだ始めていない段は `pending` の状態にする（止めたなら
   * `NOT_STARTED`、READ を行わなかったなら `NOT_NEEDED`）。終えた連鎖は変えない。
   */
  #closeChain(
    chain: ChainRun,
    stopReason: ChainStopReason | null,
    pending: typeof NOT_STARTED_CHAIN_STAGE_STATE | typeof NOT_NEEDED_CHAIN_STAGE_STATE,
  ): void {
    if (chain.state !== RUNNING_CHAIN_STATE) {
      return;
    }
    chain.state = stopReason === null ? FINISHED_CHAIN_STATE : STOPPED_CHAIN_STATE;
    chain.stopReason = stopReason;
    for (const stage of chain.stageStates) {
      if (stage.state === RUNNING_CHAIN_STAGE_STATE) {
        // FM2R の I-5: 連鎖が止まった段には印を付ける。
        stage.state = stopReason === null ? DONE_CHAIN_STAGE_STATE : STOPPED_CHAIN_STAGE_STATE;
      } else if (stage.state === PENDING_CHAIN_STAGE_STATE) {
        stage.state = pending;
      }
    }
  }

  /**
   * FM2d: ワーカーが終わったときの連鎖の終わり方。止める要求なら利用者の停止、`FINISHED` を受けていなければ段の失敗（FM2R の I-5: 最後の段でも同じ）。途中の段
   * なら段の失敗（次の段へ進まずに終わった）。最後の段を `FINISHED` で終えたら、途中の段と同じ進むかの判定（`chainAdvanceDecisionOf`）で決め、止める理由が
   * あればその理由で止まった（FM2R 確かめ直しの R-1: Run の状態・理由のコード・結果を読めたか・セッションの切れを見る）、なければ最後まで行った。最後の段の後に
   * 始める段はないので、改訂の変化は見ない（段のジョブの行は、始めた時の改訂で記録する）。
   */
  #closeChainAtExit(job: TrackedJob, chain: ChainRun, failedReason: AuditJobFailureReason | null): void {
    const lastStage = job.chainStageIndex >= chain.stages.length - 1;
    const ending = job.ending;
    if (job.stopRequested || chain.stopRequested) {
      this.#closeChain(chain, 'USER_STOPPED', NOT_STARTED_CHAIN_STAGE_STATE);
    } else if (!lastStage || ending?.kind !== 'FINISHED') {
      this.#closeChain(chain, 'STAGE_FAILED', NOT_STARTED_CHAIN_STAGE_STATE);
    } else {
      const decision = chainAdvanceDecisionOf({
        stopRequested: false,
        outcomeRan: ending.outcome.kind === 'RAN',
        stageResultValid: failedReason === null,
        stageRunStatus: ending.outcome.runStatus,
        incompleteReasonCodes: ending.incompleteReasonCodes,
        sessionLost: job.sessionLost,
        profileRevisionUnchanged: true,
      });
      this.#closeChain(chain, decision.kind === 'STOP' ? decision.reason : null, NOT_STARTED_CHAIN_STAGE_STATE);
    }
  }

  checkedWriteScreenCountOf(profileId: string): number {
    const stored = getProfile(this.#database, profileId);
    return stored === null || stored.status !== ACTIVE_PROFILE_STATUS ? 0 : this.#chainWriteTargets(profileId, stored.profile.mode).length;
  }

  getStageChainOfJob(jobId: string): StageChainView | null {
    const chain = typeof jobId === 'string' ? this.#chains.get(jobId) : undefined;
    if (chain === undefined) {
      return null;
    }
    return deepFreeze({
      chainId: chain.chainId,
      profileId: chain.profileId,
      profileRevision: chain.profileRevision,
      state: chain.state,
      stopReason: chain.stopReason,
      stages: chain.stages.map((kind, index) => ({
        kind,
        state: chain.stageStates[index]?.state ?? NOT_STARTED_CHAIN_STAGE_STATE,
        jobId: chain.stageStates[index]?.jobId ?? null,
      })),
      writeStageJobIds: [...chain.writeStageJobIds],
    });
  }

  /**
   * ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.3）: 手動のログインの成功から、認証の設定の版 3 とプロファイルの承認したサービスの
   * Origin を組み立てて保存し、結果をジョブのログインの段のまとめに 1 回だけ残す。組み立ては `manualLoginRegistrationOf`（今の「登録する」の部品を使う）、保存は
   * プロファイルと認証の設定のまとめて保存（`saveProfileAndAuthSetup`。検証は保存の部品）。ジョブを始めた後にプロファイルか認証の設定が変わっていれば、
   * 利用者の変更を上書きしない（`PROFILE_CHANGED`）。
   */
  async #registerManualLogin(job: TrackedJob, records: NonNullable<TrackedJob['manualLoginRecords']>, recordJobId: string): Promise<void> {
    const setup = job.authentication?.setup;
    if (setup === undefined) {
      return;
    }
    // FM2d: 結果は、ログインの段を行ったジョブ（まとめて実行なら最初の段のジョブ）の行に残す。
    const record = (registration: AuditJobLoginAutoRegistration): void => {
      recordLoginStageAutoRegistration(this.#database, recordJobId, registration);
    };
    const skip = (reason: AuditJobLoginAutoRegistrationSkipReason): void => record({ result: 'SKIPPED', reason });
    const current = getProfile(this.#database, job.profileId);
    const stored = getAuthSetup(this.#database, job.profileId);
    const revision = setup.profileRevision;
    if (
      current === null || current.status !== ACTIVE_PROFILE_STATUS || current.profile.revision !== revision
      || stored === null || stored.freshness !== CURRENT_AUTH_SETUP_FRESHNESS || JSON.stringify(stored.setup) !== JSON.stringify(setup)
    ) {
      skip('PROFILE_CHANGED');
      return;
    }
    const services = [...(current.profile.approvedServiceOrigins ?? [])];
    const built = manualLoginRegistrationOf({
      setup,
      profile: { approvedTestOrigins: current.profile.approvedTestOrigins, approvedServiceOrigins: services },
      passedRequests: records.passedRequests,
      observation: records.observation,
      nextProfileRevision: revision + 1,
    });
    if (!built.ok) {
      skip(built.reason);
      return;
    }
    const { targetConfigPath } = current.profile;
    let context: ProfileValidationContext | undefined;
    try {
      context = await this.#resolveContext(targetConfigPath);
    } catch {
      context = undefined;
    }
    const result = saveProfileAndAuthSetup(this.#database, {
      profile: { ...current.profile, revision: revision + 1, approvedServiceOrigins: [...services, ...built.addServiceOrigins] },
      expectedRevision: revision,
      setup: built.setup,
    }, {
      resolveContext: (path) => (path === targetConfigPath ? context : undefined),
      now: this.#now,
    });
    if (result.ok) {
      record({ result: 'SAVED', profileRevision: revision + 1, addedServiceOrigins: [...built.addServiceOrigins] });
      return;
    }
    skip(result.part === 'PROFILE' && result.reason === 'PROFILE_REVISION_CONFLICT' ? 'PROFILE_CHANGED' : 'SAVE_REJECTED');
  }

  /**
   * OP-1: ログインの直後の登録の返事を送る（新しい設定か、飛ばした）。1 回だけ（2 回目は何もしない）。`registered` が `null` なら飛ばした。
   */
  #finishLoginRegistration(job: TrackedJob, registered: { readonly setup: AuthSetup; readonly approvedServiceOrigins: readonly string[] } | null): void {
    const registration = job.loginRegistration;
    if (registration === null || registration.phase === 'DONE') {
      return;
    }
    registration.phase = 'DONE';
    registration.onSaved = null;
    if (registered === null || job.authentication === null) {
      this.#send(job, { protocol: WORKER_PROTOCOL_VERSION, type: 'LOGIN_REGISTRATION_SKIPPED' });
      return;
    }
    const approvedServiceOrigins = [...registered.approvedServiceOrigins];
    this.#send(job, {
      protocol: WORKER_PROTOCOL_VERSION,
      type: 'LOGIN_REGISTERED',
      setup: registered.setup,
      approvedServiceOrigins,
      authenticationSha256: workerAuthenticationDigestOf(registered.setup, job.authentication.approvedTestOrigins, {
        jobKind: job.jobKind as WorkerJobKind, automatedLogin: null, approvedServiceOrigins,
      }),
    });
  }

  /** OP-1: ワーカーの `CREDENTIAL_SAVED` を待つ（待つ上限・ワーカーの終わりなら `null`）。 */
  #awaitCredentialSaved(job: TrackedJob): Promise<WorkerCredentialSavedMessage | null> {
    const registration = job.loginRegistration;
    if (registration === null) {
      return Promise.resolve(null);
    }
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => settle(null), this.#timing.loginRegistrationTimeoutMs);
      const settle = (message: WorkerCredentialSavedMessage | null): void => {
        clearTimeout(timer);
        registration.onSaved = null;
        // OP-F（発見事項）: 待ち終わったら、組み立ての続きの状態に戻す（上限を過ぎた・終わった後も、知らせを待つ状態のまま残さない。遅れて届く知らせは信用しない）。
        if (registration.phase === 'AWAITING_SAVE') {
          registration.phase = 'REGISTERING';
        }
        resolvePromise(message);
      };
      registration.phase = 'AWAITING_SAVE';
      registration.onSaved = settle;
      void job.exited.then(() => settle(null));
    });
  }

  /**
   * OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D4、4.1.3 の 1）: 手動のログインの成功の直後（点検と操作さがしの前）に、手動のログインの後の
   * 自動の登録（送信先・承認したサービスの Origin・観察した成功の画面の path）と、受け取った値があれば自動ログインへの切り替えを、1 回の保存で行う。書く順:
   * 1. 登録を組み立て（`loginRegistrationAfterLoginOf`）、受け取った値があり、3 つのセレクタ（観察の `loginFields`）がそろうときだけ、切り替えも組み立てて検証に通し
   *    （`automatedLoginSwitchOf`）、資格情報を書く前の確かめ（`writableLoginOriginOf`。動いているジョブは、このジョブだけ）を通す。
   * 2. 通れば、ワーカーに許し（`CREDENTIAL_SAVE_ALLOWED`）を送り、書いた知らせ（`CREDENTIAL_SAVED`）を待つ。書いた資格情報のファイルの改訂とログインの Origin が
   *    合うときだけ切り替える（合わなければ、このジョブが書いたファイルを消す）。
   * 3. 登録と切り替えを `saveProfileAndAuthSetup` の 1 回で書く（改訂の照合と検証は保存の部品）。失敗したら、書いた資格情報のファイルを消す。
   * 4. 切り替えたら資格情報の変更の記録（`CREATED`）を書き、連鎖の基準の改訂を、保存した改訂に進める。結果を最初の段のジョブの記録に残し、新しい設定を送る。
   * 何も変わらないとき、プロファイルか認証の設定が変わっていたとき、保存が拒まれたときは、今の設定のまま点検を続ける（`LOGIN_REGISTRATION_SKIPPED`）。
   * 値は扱わない（ワーカーが書く）。
   */
  async #registerRightAfterLogin(
    job: TrackedJob,
    records: {
      readonly passedRequests: WorkerLoginStageBlockedRequests | undefined;
      readonly observation: WorkerLoginObservation | undefined;
      readonly captured: boolean;
      /** OP-F（M-2）: 受け取った値を運んだ、観察した送り先（受け取っていなければ null）。 */
      readonly carriedBy: { readonly origin: string; readonly path: string } | null;
    },
  ): Promise<void> {
    const setup = job.authentication?.setup;
    if (setup === undefined) {
      this.#finishLoginRegistration(job, null);
      return;
    }
    const record = (registration: AuditJobLoginAutoRegistration): void => {
      recordLoginStageAutoRegistration(this.#database, job.jobId, registration);
    };
    // OP-K（K3）: 受け取った値があるのに切り替えられなかったときの理由（判定の順に、最初に当たったもの。保存の段の失敗は `REGISTRATION_NOT_SAVED`）。
    let unavailable: AuditJobAutomatedLoginUnavailableReason = 'REGISTRATION_NOT_SAVED';
    // OP-L（L2）: ワーカーが書けなかったと知らせた理由のコード（値を含まない。`CREDENTIAL_NOT_SAVED` の詳しい内容として残す）。
    let saveFailure: WorkerCredentialSaveFailureCode | null = null;
    const notAvailable = (): Pick<AuditJobLoginAutoRegistration, 'automatedLogin' | 'automatedLoginReason' | 'automatedLoginSaveFailure'> => {
      if (!records.captured) {
        return {};
      }
      return unavailable === 'CREDENTIAL_NOT_SAVED' && saveFailure !== null
        ? { automatedLogin: 'NOT_AVAILABLE', automatedLoginReason: unavailable, automatedLoginSaveFailure: saveFailure }
        : { automatedLogin: 'NOT_AVAILABLE', automatedLoginReason: unavailable };
    };
    const skip = (reason: AuditJobLoginAutoRegistrationSkipReason): void => {
      record({ result: 'SKIPPED', reason, ...notAvailable() });
      this.#finishLoginRegistration(job, null);
    };
    const revision = setup.profileRevision;
    const unchanged = (): StoredProfile | null => {
      const current = getProfile(this.#database, job.profileId);
      const stored = getAuthSetup(this.#database, job.profileId);
      return current === null || current.status !== ACTIVE_PROFILE_STATUS || current.profile.revision !== revision
        || stored === null || stored.freshness !== CURRENT_AUTH_SETUP_FRESHNESS || JSON.stringify(stored.setup) !== JSON.stringify(setup)
        ? null
        : current;
    };
    const current = unchanged();
    if (current === null) {
      skip('PROFILE_CHANGED');
      return;
    }
    const services = [...(current.profile.approvedServiceOrigins ?? [])];
    const nextRevision = revision + 1;
    const built = loginRegistrationAfterLoginOf({
      setup,
      profile: { approvedTestOrigins: current.profile.approvedTestOrigins, approvedServiceOrigins: services },
      passedRequests: records.passedRequests,
      observation: records.observation,
      nextProfileRevision: nextRevision,
    });
    const { targetConfigPath } = current.profile;
    let context: ProfileValidationContext | undefined;
    try {
      context = await this.#resolveContext(targetConfigPath);
    } catch {
      context = undefined;
    }
    const registeredProfile: SiteProfile = { ...current.profile, revision: nextRevision, approvedServiceOrigins: [...services, ...built.addServiceOrigins] };
    // 1. 切り替えの組み立て（受け取った値があり、3 つのセレクタがそろうときだけ）。OP-K（K3）: セレクタは、手でのログインの観察（`loginFields`）→ 最後の下調べの案の
    //    順に取る（SPA のログインの画面は、開いた直後に欄がなく、観察に入らないことがある。下調べの案は、同じ検出の部品が読んだもの。資格情報の照らしは変えない）。
    const selectors = records.captured ? await this.#loginFieldSelectorsOf(job, records.observation) : null;
    // DEF-182: token の送信先を登録できない（テスト環境と同じ Origin）ときは、自動ログインへ切り替えない（受け取った値は、許しを送らないのでワーカーが捨てる）。
    const builtSwitch = records.captured && selectors !== null && context !== undefined && built.automatedLoginBlocked === null
      ? automatedLoginSwitchOf(registeredProfile, built.setup, nextRevision, context, selectors)
      : null;
    // OP-F（安全のレビューの M-2）: 受け取った値を運んだ送り先が、切り替えの後の資格情報の送り先（フォームの送信先か token の送信先）のどれかに当たるときだけ
    // 切り替える。当たらないときは許しを送らない（値はワーカーが捨てる）。要点は、今の「使えない」の 1 行。
    const carriedToDestination = builtSwitch?.ok === true && credentialCarriedToLoginDestination(builtSwitch.nextSetup, records.carriedBy);
    const switchPlan = builtSwitch?.ok === true && !carriedToDestination ? null : builtSwitch;
    if (built.automatedLoginBlocked !== null) {
      unavailable = 'TOKEN_TARGET_ON_TEST_ORIGIN';
    } else if (selectors === null) {
      unavailable = 'LOGIN_FIELDS_MISSING';
    } else if (builtSwitch !== null && !builtSwitch.ok) {
      unavailable = 'SWITCH_INVALID';
    } else if (builtSwitch !== null && !carriedToDestination) {
      unavailable = 'DESTINATION_MISMATCH';
    }
    const writable = switchPlan?.ok === true
      ? writableLoginOriginOf({
        database: this.#database,
        // 動いているジョブは、このジョブだけ（同時に 1 つ）。ログインの段の口から書くときの、ジョブの確かめの 1 つの口。
        checkCredentialChange: () => ({ ok: true }),
        platformSupported: () => process.platform === CREDENTIAL_PLATFORM,
      }, job.profileId, { auth: AUTOMATED_LOGIN_AUTH_STRATEGY, loginStartUrl: switchPlan.nextSetup.loginStartUrl })
      : null;
    // 2. 許しを送り、書いた知らせを待つ。
    let switched: { readonly profile: SiteProfile; readonly setup: AuthSetup; readonly credentialRevision: number } | null = null;
    // OP-F（OP-REV2 の m-3）: 許しを送った時刻（壁の時計。資格情報のファイルの部品が書く作った日時と同じ時計。秒の精度）。消すのは、この後に書かれた形のファイルだけ。
    let allowedAt: string | null = null;
    const removeWrittenAfterAllowance = async (): Promise<void> => {
      const written = await this.#credentials().readMetadata(job.profileId).catch(() => null);
      // このジョブの許しの後に書かれた形（改訂 1、作った日時が許しの後）でなければ消さない（資格情報の画面がほかの時に書いたファイルを消さない）。
      if (allowedAt !== null && written !== null && written.credentialRevision === FIRST_CREDENTIAL_REVISION && written.createdAt >= allowedAt) {
        await this.#credentials().remove(job.profileId).catch(() => false);
      }
    };
    if (switchPlan?.ok === true && (writable === null || !('loginOrigin' in writable))) {
      unavailable = 'CREDENTIAL_NOT_WRITABLE';
    }
    if (switchPlan?.ok === true && writable !== null && 'loginOrigin' in writable) {
      unavailable = 'CREDENTIAL_NOT_SAVED';
      allowedAt = formatCompactUtcTimestamp(new Date(), 'credential save allowance time');
      this.#send(job, { protocol: WORKER_PROTOCOL_VERSION, type: 'CREDENTIAL_SAVE_ALLOWED', loginOrigin: writable.loginOrigin });
      const saved = await this.#awaitCredentialSaved(job);
      if (saved === null) {
        // OP-F（安全のレビューの I-1）: 許しの後に、知らせの前にワーカーが終わった（落ちた）か、待つ上限を過ぎた。書いたかが分からないので、まだ動いていれば
        // 止め（この後に書かせない。遅れて届く知らせも受けない）、終わりを待ってから確かめる。
        if (!job.processExited) {
          this.#end(job, 'INTERRUPTED', 'WORKER_UNRESPONSIVE');
          this.#kill(job);
        }
        await job.exited;
      }
      if (saved !== null && !saved.saved) {
        saveFailure = saved.failureCode;
      }
      const metadata = saved?.saved === true ? await this.#credentials().readMetadata(job.profileId).catch(() => null) : null;
      if (saved?.saved === true && metadata !== null && metadata.credentialRevision === saved.credentialRevision && metadata.loginOrigin === writable.loginOrigin) {
        switched = { profile: switchPlan.nextProfile, setup: switchPlan.nextSetup, credentialRevision: metadata.credentialRevision };
        // ここから後の失敗は、設定の保存の失敗（書いたファイルは消す）。
        unavailable = 'REGISTRATION_NOT_SAVED';
      } else {
        // 合わないファイルと、知らせのない（書けなかったと知らせた・知らせの前に終わった・上限を過ぎた）ときのファイルは、このジョブが書いたもの（始めたときは
        // ファイルがなかった。受け取りを許すのはファイルがないときだけ）なので、あれば消す（このジョブの許しの後に書かれた形のときだけ）。
        await removeWrittenAfterAllowance();
      }
    }
    if (!built.changed && switched === null) {
      skip(built.automatedLoginBlocked ?? 'NOTHING_NEW');
      return;
    }
    // 3. 1 回の保存（待つ間に変わっていないかを、保存の直前にもう一度確かめる。ここから保存まで await を挟まない）。
    const removeWritten = async (): Promise<void> => {
      if (switched !== null) {
        await removeWrittenAfterAllowance();
      }
    };
    if (unchanged() === null || context === undefined) {
      await removeWritten();
      skip(context === undefined ? 'SAVE_REJECTED' : 'PROFILE_CHANGED');
      return;
    }
    const resolved = context;
    const profileToSave = switched?.profile ?? registeredProfile;
    const setupToSave = switched?.setup ?? built.setup;
    let result: ReturnType<typeof saveProfileAndAuthSetup> | null;
    try {
      result = saveProfileAndAuthSetup(this.#database, { profile: profileToSave, expectedRevision: revision, setup: setupToSave }, {
        resolveContext: (path) => (path === targetConfigPath ? resolved : undefined),
        now: this.#now,
      });
    } catch {
      result = null;
    }
    if (result === null || !result.ok) {
      await removeWritten();
      skip(result !== null && result.part === 'PROFILE' && result.reason === 'PROFILE_REVISION_CONFLICT' ? 'PROFILE_CHANGED' : 'SAVE_REJECTED');
      return;
    }
    // 4. 記録と連鎖の基準の改訂。
    if (switched !== null) {
      this.#guarded(() => recordCredentialEvent(this.#database, {
        profileId: job.profileId, kind: 'CREATED', at: this.#timestamp(), credentialRevision: switched.credentialRevision,
      }));
    }
    if (job.chain !== null && job.chain.profileRevision === revision) {
      job.chain.profileRevision = nextRevision;
    }
    record({
      result: 'SAVED',
      profileRevision: nextRevision,
      addedServiceOrigins: [...built.addServiceOrigins],
      ...(switched === null ? notAvailable() : { automatedLogin: 'SWITCHED' as const }),
    });
    this.#finishLoginRegistration(job, { setup: setupToSave, approvedServiceOrigins: profileToSave.approvedServiceOrigins ?? [] });
  }

  /**
   * OP-K（K3）: 自動ログインへの切り替えの 3 つのセレクタ。手でのログインの観察の案（`loginFields`）が 3 つともそろえば、それを使う。そろわなければ、そのプロファイルの
   * 最後の終わった下調べ（入口の確かめ）の案（成果物 `entry-check.json` の `proposal.selectors`。資格情報の画面の切り替えの案と同じ順・同じもの）を使う。案への写しは
   * 画面の案と同じ部品（`loginFieldDraftsOf`。認証の設定として受ける形だけ）。どちらにもそろわなければ `null`。値は扱わない。例外を投げない。
   */
  async #loginFieldSelectorsOf(job: TrackedJob, observation: WorkerLoginObservation | undefined): Promise<AutomatedLoginSelectors | null> {
    const selectorsOf = (fields: WorkerLoginObservation['loginFields']): AutomatedLoginSelectors | null => {
      const drafts = loginFieldDraftsOf(fields === undefined ? undefined : { loginFields: fields });
      return drafts === null || drafts.username === null || drafts.password === null || drafts.submit === null
        ? null
        : { usernameSelector: drafts.username.value, passwordSelector: drafts.password.value, submitSelector: drafts.submit.value };
    };
    const observed = selectorsOf(observation?.loginFields);
    if (observed !== null) {
      return observed;
    }
    const entryCheck = lastFinishedEntryCheckJobOf(readAllJobs(this.#database), job.profileId);
    if (entryCheck === null || entryCheck.runDirectory === null) {
      return null;
    }
    const value = await this.#readRunArtifact(job.outputDirectory, entryCheck.runDirectory, ENTRY_CHECK_ARTIFACT_FILE_NAME, 'entry-check');
    const document = value === null ? null : value as EntryCheckDocument;
    return document === null || document.jobId !== entryCheck.jobId || document.proposal === null ? null : selectorsOf(document.proposal.selectors);
  }

  /**
   * MI-3（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.3）: 入口の確かめの後に、認証の設定を案で保存する。判定は
   * `entryCheckAuthSetupDecisionOf`（認証の設定を使うプロファイルで、設定がまだなく、「読んだ」で終わり、ログインの画面に見えたときだけ）、組み立ては
   * `proposedAuthSetupOf`（認証の設定の画面の案と同じ 1 か所）、保存は今の認証の設定の保存の部品（`saveAuthSetup`。検証 `validateAuthSetup` と改訂の照合）。
   * プロファイルの改訂は進めない。ジョブを始めた後にプロファイルの改訂が進んだ、設定ができた、対象の設定を読めない、検証を通らないときは保存しない。保存
   * しなかった理由は記録しない（設計者の判断。画面は成果物と今の認証の設定から状態を求める）。すでにある設定は上書きしない（確かめと保存の間に await を
   * 挟まない）。
   */
  async #saveEntryCheckProposal(job: TrackedJob, document: EntryCheckDocument): Promise<void> {
    const revision = readJob(this.#database, job.jobId)?.profileRevision;
    const proposable = (): { readonly targetConfigPath: string } | null => {
      const current = getProfile(this.#database, job.profileId);
      if (current === null || current.status !== ACTIVE_PROFILE_STATUS || current.profile.revision !== revision) {
        return null;
      }
      // MI-F1（設計書 4.3。MI-R の Minor 3）: 案で保存するのは手動のログインのプロファイルだけ（自動ログインのプロファイルは、資格情報の送信先（フォームの
      // 送信先、セレクタ）を人の確かめなしに保存しない）。
      if (isAutomatedLoginProfileAuth(current.profile.auth)) {
        return null;
      }
      const { usesAuthSetup } = authSetupProposalProfileOf(current.profile.mode, current.profile.auth);
      const decision = entryCheckAuthSetupDecisionOf({
        usesAuthSetup,
        hasAuthSetup: getAuthSetup(this.#database, job.profileId) !== null,
        entryCheck: document,
      });
      return decision === 'PROPOSE' ? { targetConfigPath: current.profile.targetConfigPath } : null;
    };
    const before = proposable();
    if (before === null || revision === undefined) {
      return;
    }
    let context: ProfileValidationContext | undefined;
    try {
      context = await this.#resolveContext(before.targetConfigPath);
    } catch {
      context = undefined;
    }
    // 待つ間に変わっていないかを、保存の直前にもう一度確かめる（ここから保存まで await を挟まない）。
    const now = proposable();
    if (context === undefined || now === null || now.targetConfigPath !== before.targetConfigPath) {
      return;
    }
    const setup = proposedAuthSetupOf({
      profileId: job.profileId,
      profileRevision: revision,
      // MI-F3（MI-F1 の報告の片付け）: 上で自動ログインのプロファイルを除くので、案はいつも手動のログインの形（自動ログインのセレクタを作らない）。
      // 案の部品の `automated: true` の分岐は、認証の設定の画面の案（`AuthSetupForm.tsx`）と入口の確かめの状態（`entry-check-functions.ts`）が使う。
      automated: false,
      startUrlPath: startUrlPathOf(context.targetConfig.site.startUrl) ?? null,
      entryProposal: document.proposal,
    });
    const resolved = context;
    // MI-F1（設計書 4.3。MI-R の Minor 4）: 「設定がないときだけ保存する」の確かめは、保存のトランザクションの中で行う（`onlyWhenAbsent`）。
    saveAuthSetup(this.#database, setup, {
      resolveContext: (path) => (path === now.targetConfigPath ? resolved : undefined),
      now: this.#now,
      onlyWhenAbsent: true,
    });
  }

  async confirmManualLogin(jobId: string): Promise<AuditJobLoginConfirmResult> {
    const job = typeof jobId === 'string' ? this.#jobs.get(jobId) : undefined;
    if (job === undefined || job.phase === 'DONE') {
      const stored = typeof jobId === 'string' ? readJob(this.#database, jobId) : null;
      return loginConfirmRejected(stored === null ? 'JOB_NOT_FOUND' : 'JOB_NOT_ACTIVE');
    }
    if (job.loginConfirmSent) {
      return loginConfirmRejected('ALREADY_CONFIRMED');
    }
    if (
      job.authentication === null || job.authentication.automatedLogin !== undefined || job.phase !== 'STARTED'
      || job.lastAuthState !== WORKER_AWAITING_LOGIN_STATE || job.stopRequested
    ) {
      return loginConfirmRejected('NOT_AWAITING_LOGIN');
    }
    job.loginConfirmSent = true;
    this.#send(job, { protocol: WORKER_PROTOCOL_VERSION, type: 'LOGIN_CONFIRMED' });
    return Object.freeze({ ok: true as const });
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
    if (job.jobKind === WORKER_ENTRY_CHECK_JOB_KIND) {
      return this.#readEntryCheckResult(job, ending);
    }
    return null;
  }

  /**
   * 入口の確かめのジョブの結果（`entry-check.json`）を読んで確かめる（T43c）。出力先の Run のディレクトリの `entry-check.json` を、リンクをたどらずに
   * 読み、成果物のスキーマ（`entry-check`）、ジョブの ID、Run の ID、Run Status、`FINISHED` の件数の要約と、ファイルから求めた要約の一致を確かめる。
   * どれかが通らなければ `INVALID`（ジョブは `ENTRY_CHECK_RESULT_INVALID`）。例外を投げない。管理データには結果を記録しない（成果物が正）。
   */
  async #readEntryCheckResult(job: TrackedJob, ending: Extract<JobEnding, { readonly kind: 'FINISHED' }>): Promise<JobResultVerdict> {
    const { runId, runDirectory, runStatus } = ending.outcome;
    const reported = ending.entryCheck;
    if (runDirectory === null || reported === null) {
      return ENTRY_CHECK_RESULT_INVALID;
    }
    const value = await this.#readRunArtifact(job.outputDirectory, runDirectory, ENTRY_CHECK_ARTIFACT_FILE_NAME, 'entry-check');
    if (value === null) {
      return ENTRY_CHECK_RESULT_INVALID;
    }
    const document = value as EntryCheckDocument;
    const summary = entryCheckSummaryOf(document);
    if (
      document.jobId !== job.jobId
      || document.runId !== runId
      || document.runStatus !== runStatus
      || summary.endReason !== reported.endReason
      || summary.loginPage !== reported.loginPage
      || summary.proposedSelectors !== reported.proposedSelectors
    ) {
      return ENTRY_CHECK_RESULT_INVALID;
    }
    return Object.freeze({ kind: 'ENTRY_CHECK', document });
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
      // T41b: API の更新の START も対象の ID を持つ（`update.targetRecordId`）。記録の対象の ID は、form と同じく START の対象の ID と同じ。
      || (document.update?.targetRecordId ?? null) !== (job.writeSpec.update?.targetRecordId ?? null)
      // T40c（Task 40 の設計書 3.4）: 版 1.1 の送り方と API の要約が、`START` の書き込みの指定（承認した API の指定）と同じ（FORM の START には
      // FORM の記録だけ。手書きの確かめ `actionRunRuleErrors` を含む）。
      || !actionRunMatchesWriteStart(document, isWorkerStartApiWrite(job.writeSpec) ? job.writeSpec.api : null)
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
      // T37a（Task 37 の設計書 3.1）: 監査の段の数も、成果物と同じ（どちらもないか、同じ数）。
      || !sameJobAuthenticationSummary(summary.authentication, reported.authentication)
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
    // T37d: 対象（種類、候補の識別の digest、画面の path）も、開始の定義と同じ（`readCheckEvidenceTargetOf` の形で比べる）。
    const sameChecks = document.checks.length === started.length && document.checks.every((check, index) => {
      const startedCheck = started[index];
      if (startedCheck === undefined || check.readCheckId !== startedCheck.readCheckId || check.readCheckRevision !== startedCheck.readCheckRevision) {
        return false;
      }
      const target = readCheckEvidenceTargetOf(startedCheck.definition);
      return check.targetKind === target.targetKind
        && check.targetIdentityDigest === target.targetIdentityDigest
        && check.targetPagePath === target.targetPagePath;
    });
    if (
      document.jobId !== job.jobId
      || document.runId !== runId
      || document.runStatus !== runStatus
      || reported === null
      || summary.checks !== reported.checks
      || summary.executed !== reported.executed
      // T37a（Task 37 の設計書 3.1）: 監査の段の数も、成果物と同じ（どちらもないか、同じ数）。
      || !sameJobAuthenticationSummary(summary.authentication, reported.authentication)
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
      case 'ENTRY_CHECK':
        // T43c: 入口の確かめの結果は記録しない（成果物が正。画面は確かめた成果物を読む）。
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
   * DEF-143: 「Run の終わり」の段の知らせ（`RUN_FINALIZING`）を受けたジョブは、上限を `finalizingHeartbeatTimeoutMs` にする。見張りの回が、間隔より
   * `watchdogLagLimitMs` を超えて遅れたときは、親自身の main thread が止まっていたので、その回は判定しない（timers の段は IPC を読む段より先に来るので、
   * 止まっている間に届いて溜まった合図を受ける前に判定して、ワーカーを誤って止めないため。次の回で判定する）。
   */
  #checkHeartbeats(): void {
    const nowMs = performance.now();
    const lagMs = nowMs - this.#lastWatchdogMs - this.#timing.watchdogIntervalMs;
    this.#lastWatchdogMs = nowMs;
    if (lagMs > this.#timing.watchdogLagLimitMs) {
      return;
    }
    for (const job of this.#jobs.values()) {
      const timeoutMs = job.finalizing ? this.#timing.finalizingHeartbeatTimeoutMs : this.#timing.heartbeatTimeoutMs;
      if (
        !job.processExited
        && (job.phase === 'STARTED' || job.phase === 'RUN')
        && nowMs - job.lastHeartbeatMs > timeoutMs
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
    // FM2d・FM2R の I-2: 動いているまとめて実行の段の ID（終えた前の段の ID を含む）の「やめる」は、連鎖の全体を止める。今の段のジョブへ止めを回し（動いて
    // いれば止める要求を送る。次の段へ進めるかを決めている間なら、次の段を始めない）、今の段のジョブを返す。
    const chain = typeof jobId === 'string' ? this.#chains.get(jobId) : undefined;
    if (chain !== undefined && chain.state === RUNNING_CHAIN_STATE) {
      chain.stopRequested = true;
      const current = [...this.#jobs.values()].find((candidate) => candidate.chain === chain && !candidate.rowRecorded);
      if (current !== undefined) {
        if (current.phase === 'DONE') {
          this.#guarded(() => recordStopping(this.#database, current.jobId, this.#timestamp()));
        } else {
          this.#requestStop(current, force);
        }
        const stored = readJob(this.#database, current.jobId);
        return stored === null ? stopRejected('JOB_NOT_FOUND') : Object.freeze({ ok: true, job: stored });
      }
      // OP-F（安全のレビューの M-1）: 書き込みの段を準備している間（今の段の行を締めた後、次の段を始める前）は、止める要求の印で止まる（許可の発行の前と
      // `NEXT_STAGE` の前に見直す）。受けたとして、準備している段のジョブを返す。
      const preparing = [...this.#jobs.values()].find((candidate) => candidate.chain === chain);
      if (preparing !== undefined) {
        const stored = readJob(this.#database, preparing.jobId);
        return stored === null ? stopRejected('JOB_NOT_FOUND') : Object.freeze({ ok: true, job: stored });
      }
    }
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
    // FM2d: まとめて実行の段を止めたら、連鎖の全体を止める（次の段を始めない）。
    if (job.chain !== null) {
      job.chain.stopRequested = true;
    }
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
    // ML-a: 背後の自動の登録の終わりを待つ（管理データを閉じる前に書き終える）。
    await Promise.all([...this.#registrations]);
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

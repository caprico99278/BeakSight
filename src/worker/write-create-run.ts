/**
 * 書き込みのジョブ（`WRITE_CREATE`）の流れ（Task 30 の設計書 3 章の「書き込みの段」「フォームの画面の確かめ」「送る直前の確かめ直し」「結果の判定」
 * 「登録の ID」「READ による照合」「予約の締め」、4 章の「読み込みの回数と間隔」。T30f）。ワーカーの流れ（`audit-worker-session.ts`）が、ログインの段
 * の後に、認証の指定（`RunAuthentication`）と `START` の書き込みの指定と IPC の 2 つの口（確かめ直し、送信の報告）を付けて呼ぶ。書き込みの段の
 * Context を開き（`createWriteStageContext`）、書き込みのフォームの入力の部品（`write-form-submitter.ts`）を呼ぶのは、このファイルだけ（Gate
 * `write-stage-boundary` の (c)(d)）。
 *
 * 1. Run の始めと終わり（発見と READ の確かめと同じ部品 `startWorkerRun`・`endWorkerRun`）。
 * 2. Run の前の確認（`runPreflight`。認証の指定を付けた factory）。
 * 3. 送る前の確かめ（どれかで止まれば、送らずに `NOT_SENT`（`PRECHECK_FAILED`））:
 *    a. 書き込みの画面の URL を事前の判定（READ の確かめと同じ `isReadUrlAllowed`。許可 Origin、監査の段の除外、セッションの切れの path）に通す。
 *    b. フォームの画面の確かめ: 凍結した Context で書き込みの画面を 1 回読み（GET）、発見の入口で候補を読み直し、承認に縛った候補の識別と規則の
 *       2 つの digest が同じ候補が、ちょうど 1 つあること。
 * 4. 書き込みの段: 書き込みの段の Context（Guard の照合の期待は、承認の要求の形と、`writePayloadFieldsOf` が作る欄の部分。DEF-098 で、
 *    送る欄に選ばなかった見える欄の期待を含む）で、書き込みの画面を 1 回読み（GET）、`inspectWriteForm` → `fillWriteForm`（送信の窓を開いてから
 *    入れる）→ 窓の中で止めた要求がないことを確かめる → 押す前の読み込みの間隔を守る（最後の待ち）→ 止める印を確かめる → 送る直前の確かめ直し
 *    （IPC の往復。親が `assertGrantStillValid` と `approvalExternalFactsOf` を求め直す。拒まれる・時間切れなら送らない）→ もう一度止める印を
 *    確かめる → `submitWriteForm`。T30R-fix-1（DEF-103）: 確かめ直しを、最後の待ちと止める印の確かめの後、押す直前に移した（確かめ直しの結果を
 *    受けてから押すまでの間に、待ちと読み込みを入れない。前は書き込みの段の前で、その後の待ちと読み込みの間に撤回されても押していた）。親は、
 *    撤回とシナリオの変更のときに、動いている書き込みのジョブに `STOP` を送る。送る欄は、`values` のすべての欄（null は checkbox を外す・
 *    radio を選ばない。ほかの型に null があれば送らない）。
 * 5. 結果の判定（送った場合。Task 26 の結果の判定の作り）: Guard が通した POST の応答と、その後の main frame の文書で決める: 307・308（再 POST は
 *    Guard が止める）→ `REPOST_REDIRECT`、429 → `RATE_LIMITED`、5xx → `SERVER_ERROR`、セッションの切れ → `SESSION_LOST`、成功の条件と入力の誤りの
 *    条件（`{ pathPrefix, selector }`）のちょうど 1 つ → `SUCCESS`・`INPUT_ERROR`、2 つ → `MULTIPLE_CONDITIONS_MATCHED`、期限までにどれにも当たら
 *    ない → `NO_CONDITION_MATCHED`。応答がなければ判定なし（`NO_RESPONSE`）。T30R2-fix-1（M-b）: 応答を受けても、送り手の応答をブラウザに返せ
 *    なかった（Guard の `responseDeliveryCanceled`）か、押した後に main frame の POST のナビゲーションの要求がブラウザで失敗した（ブラウザが
 *    取り消した。ページの JS が別の画面へ移ったなど）なら、今の画面は POST の応答ではないので、成功の条件と ID を判定せず
 *    `RESPONSE_NOT_DELIVERED`（結果は `UNKNOWN`）にする（307・308 の判定の後。再 POST を Guard が止めた失敗と取り違えない）。
 * 6. 登録の ID（成功のときだけ）: 検証の指定の取り方（成功の後の URL の path の型、または成功の画面の要素の文字）で取る。成果物に書くのは、記録して
 *    よい値（`recordableRecordIdOf`）だけ。使える形（`isUsableRecordId`）かは、判定（`actionOutcomeOf`）が決める（形の外は `RECORD_ID_UNSAFE`）。
 * 7. 送信の報告: 書き込みの段の Context を閉じた後（もう送れない時点）に、Guard の送信の報告から決めて 1 回だけ送る（`NOT_SENT` は、Guard が
 *    送る中身の照合で止めたなら `PAYLOAD_MISMATCH`、ほかは `PRECHECK_FAILED`）。
 * 8. READ による照合（成功のときだけ）: 書き込みの段を閉じた後、照合の READ（生成した値を結び付けた定義）を、READ の確かめの部品
 *    （`verifyReadCheck`。凍結した Context で候補を確かめ、別の Context で READ の URL を読む）で行う。
 * T31R-fix-1（C-1。DEF-108）: 3b の画面の確かめで、同じ画面の値を照らす hidden・readonly・見えない欄（秘密に見える名前でない欄）の値を読み
 *    （`readWritePassthroughValues`。記録しない）、照合の期待に入れる（送信の直前にページの JS が書き換えれば、Guard が止める）。UPDATE は、前の
 *    読み取りの `passthroughValues` で同じく照らし、更新の後の照合では比べない。
 * 9. `action-run.json` を、ArtifactWriter（`writeActionRun`。スキーマ `action-run`）で書く。判定は `actionOutcomeOf`、予約の締め方は
 *    `reservationSettlementOf`（親も決め直す）。資格情報・Cookie・CSRF のトークン・hidden の値は持たない（送った値は合成のテストデータ）。
 *    T32e（Task 32 の設計書 4.1）: その前に、書き込みの報告の承認の要約（`writeApprovalSummary`。`START` の承認の要約の事実をそのまま）と証拠
 *    （`writeActionEvidence`。送る前の確かめ、送信、応答と判定の時刻、照合の READ の証拠の全体、Guard の数の要約、人の値の印）を書く。3 つの文書は
 *    同じ事実から `writeRunDocumentsOf` で 1 回だけ組み立てる。どれかが書けなければ、`action-run.json` が書けないときと同じく reject する。
 *    T32f: 続けて、HTML の報告（`action-report.html`）と書き込みのバンドル（ZIP）を `writeActionPresentation` で書く（伏せ字の後の文書から
 *    `createActionPresentation` で 1 回だけ組み立てる）。`action-run.json` は最後。
 * 読み込み: 画面の確かめ（GET 1）、書き込みの画面（GET 1）、POST（と結果の画面への redirect）、照合の READ（対象の画面と READ の URL の GET 2）。
 * どれも設定の間隔（`crawl.minNavigationIntervalMs`。`NavigationPacer`）を守る。読み込み直しはしない。止める要求は、押す前の各段の前で確かめる
 * （押した後は止めない）。
 *
 * T31g-2（Task 31 の設計書 3 章の「更新の前の読み取り」「送信」「結果の判定」「更新の後の照合」「証拠と記録」、4 章の「読み込みの回数と間隔」）:
 * 更新の書き込みのジョブ（`WRITE_UPDATE`。`write.update` を持つ指定）も、この流れで行う（CREATE と同じ段を共有し、違う所だけを分ける。書き込みの段の
 * Context と入力の部品を使うのは、今どおりこのファイルだけ）。`formPage` と `request` の path は、親が対象の ID を入れた具体的な path。
 * - 3b の代わりに、更新の前の読み取り: 凍結した Context で具体的な更新の画面を 1 回読み（GET）、発見の入口で候補を読み直し、型にした識別の digest
 *   （`write.update.templatedIdentityDigest`）と規則の digest が同じ候補がちょうど 1 つあること。型にした digest は、候補の画面の path と送信先の
 *   path で、値が対象の ID と同じ区切りの組から求める（発見の部品の `templatedIdentityDigestForRecordIdOf`。T31i で共通化。組がちょうど 1 つで
 *   なければ、その候補は照らさない。fail-closed）。同じ画面で、書き込みの
 *   入力の部品（`readUpdateFormValues`）が前の値（変える欄と保つ欄、状態の名前の欄、組の hidden）を読む。変える欄の前の値が証拠の長さの上限
 *   （`MAX_SUBMITTED_VALUE_LENGTH`）を超えれば送らない（証拠に書けない）。
 * - 照合の期待は `updatePayloadFieldsOf`（保つ欄・状態の欄・組は前の値）。書き込みの段では、`inspectUpdateForm`（書き込みの画面の値が前の値と
 *   同じか）→ `fillWriteForm`（変える欄だけ）→ … → `submitWriteForm`（4 と同じ順。押す直前の確かめ直しと止める印も同じ）。
 * - 結果の判定は 5 と同じ。成功のときは 6 の ID（取れた ID。対象の ID と違えば `RECORD_ID_MISMATCH`）を取り、書き込みの段を閉じた後に、更新の後の
 *   照合: 凍結した Context で具体的な更新の画面をもう一度 1 回読み、同じ候補の確かめと読み取りをして、欄ごとに `sameValue` で比べる（変えた欄は
 *   新しい値、保つ欄・状態の名前の欄・組の hidden は前の値）。読めなければ、どの欄も照合できない（null）。一致しない欄がなければ、8 の照合の READ
 *   （新しい値を結び付けた形）を行う。
 * - 証拠（`action-run.json` の `update`）: 欄ごとに 1 つ。変えた欄は `CHANGED`（前の値と送った新しい値。前の値がない checkbox などは空の値）、
 *   保つ欄・状態の名前の欄（組の hidden は組の名前の欄に含める）は `KEPT`（値なし）。結果は `actionOutcomeOf` に対象の ID と
 *   `fieldsMatchedOf`（証拠の欄の一致）を渡して決める。
 * - 読み込み: 更新の前の読み取り（GET 1）、書き込みの画面（GET 1）、POST（と redirect）、更新の後の読み取り（GET 1）、照合の READ（GET 2）。
 */
import { resolve } from 'node:path';
import type { BrowserContext, Page, Request, Response } from 'playwright';
import { FORM_POST_METHOD } from '../browser/form-submission-common.js';
import type { BrowserContextFactory } from '../browser/context-factory.js';
import {
  fillWriteForm,
  inspectUpdateForm,
  inspectWriteForm,
  readUpdateFormValues,
  readWritePassthroughValues,
  sameValue,
  submitWriteForm,
  updatePayloadFieldsOf,
  writePayloadFieldsOf,
  type UpdateFormValues,
  type WriteFormSpec,
  type WriteUpdateFormSpec,
} from '../browser/write-form-submitter.js';
import { EXIT_CODES } from '../cli/exit-codes.js';
import type { AuditConfig } from '../config/types.js';
import {
  ACTION_EVIDENCE_SCHEMA_VERSION,
  ACTION_RUN_SCHEMA_VERSION,
  APPROVAL_SUMMARY_SCHEMA_VERSION,
  MAX_SUBMITTED_VALUE_LENGTH,
  type ActionBlockReason,
  type ActionEvidenceDocument,
  type ActionGuardSummary,
  type ActionOutcome,
  type ActionResult,
  type ActionRunDocument,
  type ActionRunReadVerification,
  type ActionRunUpdate,
  type ApprovalSummaryDocument,
  type ResponseJudgement,
  type SubmissionState,
  type WriteUpdateEvidence,
  type WriteUpdateFieldEvidence,
} from '../control/actions/action-contracts.js';
import { actionOutcomeOf, fieldsMatchedOf, recordableRecordIdOf, reservationSettlementOf } from '../control/actions/action-outcome.js';
import type { WorkerStartWrite, WorkerStartWriteUpdate } from '../control/worker-protocol.js';
import type { RunId, RunStatus } from '../core/contracts.js';
import { wait } from '../core/deadline.js';
import {
  ERROR_HTTP_STATUS_RANGE,
  SERVER_ERROR_HTTP_STATUS_RANGE,
  TOO_MANY_REQUESTS_HTTP_STATUS,
  isHttpStatusInRange,
} from '../core/http-status.js';
import { CONTEXT_CLOSE_TIMEOUT_MS } from '../core/limits.js';
import { deriveRunStatus } from '../core/status.js';
import { formatCompactUtcTimestamp } from '../core/utc-timestamp.js';
import { createNavigationPacer, type NavigationPacer } from '../crawl/navigation-pacer.js';
import { RECORD_ID_PLACEHOLDER, type ScenarioRecordIdSpec } from '../control/approval/scenario-contracts.js';
import { templatedIdentityDigestForRecordIdOf } from '../discovery/fingerprint.js';
import type { ReadCheckExecutedEvidence } from '../discovery/read-check-evaluation.js';
import { readCandidatePage } from '../discovery/read-executor.js';
import { authenticatedContextOptions, sessionLostUrlOf, type RunAuthentication } from '../orchestration/authenticated-run.js';
import { navigatePage } from '../orchestration/page-navigation.js';
import { closePassiveContextBeforeDeadline } from '../orchestration/passive-session-close.js';
import { closeBrowserBeforeDeadline, runPreflight, type BrowserLauncher } from '../orchestration/preflight.js';
import { createActionPresentation } from '../report/action-bundle.js';
import { ArtifactWriter } from '../report/artifact-writer.js';
import { isPassiveRequestGuardClosed, WriteStageMonitor, type WriteStageMonitorSnapshot } from '../safety/passive-request-guard.js';
import { redactUrlSecrets } from '../safety/redact.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import type { WritePayloadExpectation } from '../safety/write-payload-policy.js';
import { isLoginResultConditionPage, loginStageLocator } from './login-stage-checks.js';
import { isReadUrlAllowed, verifyReadCheck } from './read-check-run.js';
import { endWorkerRun, hasViolation, startWorkerRun, visitGuardedPage, type GuardedPageVisitOptions } from './worker-run-session.js';
import type { WorkerWriteRecheckOutcome, WorkerWriteSubmissionReport } from './write-ipc.js';

/** 日時の名前（誤りの文に使う）。 */
const WRITE_CREATE_TIME_SUBJECT = 'write create run time';

/** 再 POST させる redirect（307・308。Guard が 2 回目の POST を止める）。 */
const REPOST_REDIRECT_STATUSES: ReadonlySet<number> = new Set([307, 308]);

/** 結果を確かめる間隔（ms）。ページの中の読み取り（URL と要素の有無）だけで、サイトへの要求を増やさない。 */
export const WRITE_RESULT_POLL_INTERVAL_MS = 250;

/**
 * 値を入れた後、押す前に待つ時間（ms。自動ログインの `SUBMISSION_WINDOW_SETTLE_MS` と同じ考え方）。ページの JS が値の入力の事象で出そうとした
 * 要求を、Guard が送信の窓の中で止めて数えるのを待つ（止めた要求があれば、押さずに終える）。
 */
export const WRITE_SUBMISSION_WINDOW_SETTLE_MS = 300;

/** 書き込みの流れの入力。秘密（認証の状態）はメモリの認証の指定の中だけ。 */
export interface WriteCreateRunRequest {
  readonly config: AuditConfig;
  readonly jobId: string;
  readonly authentication: RunAuthentication;
  /** `START` の書き込みの指定（契約で確かめたもの）。 */
  readonly write: WorkerStartWrite;
  readonly launchBrowser: BrowserLauncher;
  readonly clock: () => Date;
  readonly now: () => number;
  /** 止める印（押す前の各段の前で確かめる。押した後は止めない）。 */
  readonly stopSignal: AbortSignal;
  /** 送る直前の確かめ直し（IPC の往復。`createWorkerWriteIpc` の `requestRecheck`）。 */
  readonly recheck: () => Promise<WorkerWriteRecheckOutcome>;
  /** 送信の報告（1 回。`createWorkerWriteIpc` の `reportSubmission`）。 */
  readonly reportSubmission: (report: WorkerWriteSubmissionReport) => void;
  /** 読み込みの間隔を守る部品（省略すると、設定の `crawl.minNavigationIntervalMs` で作る）。 */
  readonly navigationPacer?: NavigationPacer | undefined;
  /** 押した後に結果を待つ上限（ms。省略すると、設定の `crawl.navigationTimeoutMs`）。 */
  readonly resultTimeoutMs?: number | undefined;
  /**
   * テストだけ（DEF-099 fix）: 書き込みの送信の送り手が TLS の確かめで信頼する証明書を足す（PEM。自前の証明書の https の fixture のため）。
   * 確かめは切らない。ワーカーの本番の流れは渡さない。
   */
  readonly writeSubmissionCertificates?: readonly string[] | undefined;
}

/** 観測の口（ワーカーの流れが IPC に写す）。 */
export interface WriteCreateRunObserver {
  readonly onRunStarted: (event: { readonly runId: RunId; readonly runDirectory: string }) => void;
  readonly onSessionLost: (url: string) => void;
}

/** 書き込みの流れの結果（Run のディレクトリは絶対パス）。 */
export type WriteCreateRunOutcome =
  | {
    readonly kind: 'RAN';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly runStatus: RunStatus;
    readonly exitCode: number;
    readonly result: ActionResult;
  }
  | { readonly kind: 'RUN_ACTIVE'; readonly activeRunId: RunId | null; readonly exitCode: number }
  | {
    readonly kind: 'RUN_DIRECTORY_UNAVAILABLE';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly runStatus: RunStatus;
    readonly exitCode: number;
  };

/**
 * 書き込みの事実（成果物と送信の報告の元。`action-run.json` と、T32e から書き込みの報告の `action-evidence.json` を、この 1 つの事実から
 * `writeRunDocumentsOf` で 1 回だけ組み立てる）。
 */
interface WriteFacts {
  readonly submission: SubmissionState;
  readonly blockReason: ActionBlockReason | null;
  readonly httpStatus: number | null;
  readonly responseJudgement: ResponseJudgement | null;
  readonly rawRecordId: string | null;
  /**
   * T32e: 照合の READ の証拠の全体（実行したときだけ。`action-run.json` の `readVerification` は、ここから id・版・結果を取る）。期待ごとの
   * `observedValue` は人の値でありうる。URL は ArtifactWriter が書くときに伏せ字を通す。
   */
  readonly readEvidence: ReadCheckExecutedEvidence | null;
  readonly submittedAt: Date | null;
  /** 安全の不変条件の違反があった（Run は `ABORTED_BY_SAFETY`）。 */
  readonly violation: boolean;
  /** Run の前の確認（PREFLIGHT）が失敗した。 */
  readonly preflightFailed?: boolean;
  /** T31g-2: UPDATE の更新の後の照合の証拠（照合まで進まなかったとき・CREATE は null）。 */
  readonly updateEvidence?: WriteUpdateEvidence | null;
  /** T32e: 送る前の画面の確かめで、承認に縛った候補の digest が一致したか（確かめまで進まなければ null）。 */
  readonly candidateDigestMatched: boolean | null;
  /** T32e: 送信の後の画面の結果を判定した時刻（判定しなければ null）。 */
  readonly judgedAt: Date | null;
  /** T32e: Guard の書き込みの段の数の要約（書き込みの段に入らなければ null）。 */
  readonly guard: ActionGuardSummary | null;
}

/** 送らずに止めた事実（T32e: 候補の確かめの結果と Guard の要約は、分かっていれば添える）。 */
const notSent = (
  blockReason: ActionBlockReason,
  details: { readonly violation?: boolean; readonly candidateDigestMatched?: boolean | null; readonly guard?: ActionGuardSummary | null } = {},
): WriteFacts => Object.freeze({
  submission: 'NOT_SENT',
  blockReason,
  httpStatus: null,
  responseJudgement: null,
  rawRecordId: null,
  readEvidence: null,
  submittedAt: null,
  violation: details.violation ?? false,
  candidateDigestMatched: details.candidateDigestMatched ?? null,
  judgedAt: null,
  guard: details.guard ?? null,
});

/**
 * T32e: Guard の書き込みの段の記録の写しから、報告に書く数と印だけを写す（項目を名前で選ぶ。写しに項目が増えても、報告の形は変えない）。
 */
const guardSummaryOf = (snapshot: WriteStageMonitorSnapshot): ActionGuardSummary => Object.freeze({
  blockedByReason: Object.freeze({ ...snapshot.blockedByReason }),
  blockedByOtherRulesInWindow: snapshot.blockedByOtherRulesInWindow,
  submissionWindowOpen: snapshot.submissionWindowOpen,
  blockedByPayloadReason: Object.freeze({ ...snapshot.blockedByPayloadReason }),
  documentCharsetRead: snapshot.documentCharsetRead,
  responseDeliveryCanceled: snapshot.responseDeliveryCanceled,
});

const PRECHECK_FAILED: ActionBlockReason = 'PRECHECK_FAILED';
const PAYLOAD_MISMATCH: ActionBlockReason = 'PAYLOAD_MISMATCH';

/** 画面の URL（Origin と path）。 */
const pageUrlOf = (location: { readonly origin: string; readonly path: string }): string => `${location.origin}${location.path}`;

/** 送るフォームの指定（承認の要求の形と、承認した候補の欄と、生成した値の欄の名前）。 */
const formSpecOf = (write: WorkerStartWrite): WriteFormSpec => ({
  endpoint: { origin: write.request.origin, path: write.request.path },
  enctype: write.request.enctype as WriteFormSpec['enctype'],
  candidateFields: write.candidateFields,
  submittedFieldNames: Object.keys(write.values),
  methodOverride: write.request.methodOverride as WriteFormSpec['methodOverride'],
});

/** T31g-2: 更新の form の指定（承認の要求の形と、承認した候補の欄と、欄の役割）。 */
const updateSpecOf = (write: WorkerStartWrite, update: WorkerStartWriteUpdate): WriteUpdateFormSpec => ({
  endpoint: { origin: write.request.origin, path: write.request.path },
  enctype: write.request.enctype as WriteUpdateFormSpec['enctype'],
  candidateFields: write.candidateFields,
  methodOverride: write.request.methodOverride as WriteUpdateFormSpec['methodOverride'],
  changedFieldNames: update.changedFieldNames,
  keptFieldNames: update.keptFieldNames,
});

/** T31g-2: UPDATE の、書き込みの段に渡す前の値と指定。 */
interface UpdateStage {
  readonly spec: WriteUpdateFormSpec;
  readonly prior: UpdateFormValues;
}

/**
 * Guard の照合の期待（承認の要求の形と、期待の作り手 `writePayloadFieldsOf` が作る欄の部分。DEF-098）。T31R-fix-1（C-1）: 値を照らす hidden・
 * readonly・見えない欄は、画面の確かめで読んだ値（作れなければ null）。
 */
const payloadExpectationOf = (
  write: WorkerStartWrite,
  spec: WriteFormSpec,
  passthroughValues: Readonly<Record<string, string | null>>,
): WritePayloadExpectation | null => {
  const fields = writePayloadFieldsOf(spec, write.values, passthroughValues);
  return fields.ok ? { request: { origin: write.request.origin, path: write.request.path, enctype: spec.enctype }, ...fields.fields } : null;
};

/** Guard が、送る中身の照合で承認の形の POST を止めたか。 */
const payloadBlocked = (monitor: WriteStageMonitor): boolean =>
  Object.values(monitor.snapshot().blockedByPayloadReason).some((count) => count > 0);

/** HTTP の状態からの判定（429・5xx。ほかは null）。 */
const statusJudgementOf = (status: number | null): ResponseJudgement | null => {
  if (status === TOO_MANY_REQUESTS_HTTP_STATUS) {
    return 'RATE_LIMITED';
  }
  return isHttpStatusInRange(status, SERVER_ERROR_HTTP_STATUS_RANGE) ? 'SERVER_ERROR' : null;
};

/** 登録の ID を、成功の後の URL の path の型（`{id}` の区切り）から取る（区切りの数と、ほかの区切りが同じときだけ。そのままの値）。 */
const recordIdFromPath = (pathname: string, pattern: string): string | null => {
  const actual = pathname.split('/');
  const expected = pattern.split('/');
  if (actual.length !== expected.length) {
    return null;
  }
  let recordId: string | null = null;
  for (const [index, segment] of expected.entries()) {
    const value = actual[index] ?? '';
    if (segment === RECORD_ID_PLACEHOLDER) {
      recordId = value;
    } else if (segment !== value) {
      return null;
    }
  }
  return recordId;
};

/** 登録の ID を取る（取れなければ null。成果物に書いてよい値だけ）。要素は、ちょうど 1 つのときだけ、その文字の前後の空白を除いた値。 */
async function recordIdOf(page: Page, spec: ScenarioRecordIdSpec): Promise<string | null> {
  try {
    if (spec.source === 'URL_PATH_PATTERN') {
      return recordableRecordIdOf(recordIdFromPath(new URL(page.url()).pathname, spec.pathPattern));
    }
    const locator = loginStageLocator(page, spec.selector);
    if ((await locator.count()) !== 1) {
      return null;
    }
    const text = await locator.textContent({ timeout: WRITE_RESULT_POLL_INTERVAL_MS });
    return recordableRecordIdOf(text === null ? null : text.trim());
  } catch {
    return null;
  }
}

/** 書き込みの段の結果（Context を閉じる前に読んだもの）。 */
interface WriteStageResult {
  readonly clicked: boolean;
  readonly precheckFailed: boolean;
  readonly httpStatus: number | null;
  readonly responseJudgement: ResponseJudgement | null;
  readonly rawRecordId: string | null;
  readonly submittedAt: Date | null;
  /** T32e: 結果の判定を終えた時刻（判定まで進まなければ null）。 */
  readonly judgedAt: Date | null;
  readonly sessionLostUrl: string | null;
}

const PRECHECK_STOPPED: WriteStageResult = Object.freeze({
  clicked: false,
  precheckFailed: true,
  httpStatus: null,
  responseJudgement: null,
  rawRecordId: null,
  submittedAt: null,
  judgedAt: null,
  sessionLostUrl: null,
});

/** 書き込みの段で使うもの。 */
interface WriteStageInput {
  readonly request: WriteCreateRunRequest;
  readonly factory: BrowserContextFactory;
  readonly pacer: NavigationPacer;
  readonly monitor: WriteStageMonitor;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly ledger: SafetyLedger;
  /** T31g-2: UPDATE の指定と前の値（CREATE は undefined）。 */
  readonly update?: UpdateStage | undefined;
}

/**
 * 書き込みの段の本体（ファイルの先頭の 4〜6。Context を開いた後、閉じる前）。例外は呼ぶ側が受ける（送ったかは Guard の送信の報告で決める）。
 */
async function writeOnStage(input: WriteStageInput): Promise<WriteStageResult> {
  const { request, pacer, monitor, page, ledger } = input;
  const { config, write, authentication, stopSignal } = request;
  const spec = formSpecOf(write);
  await pacer.beforeNavigation();
  const navigation = await navigatePage(page, pageUrlOf(write.formPage), {
    timeoutMs: config.crawl.navigationTimeoutMs,
    ledger,
    allowedQueryParameters: new Set(config.crawl.allowedQueryParameters),
  });
  const lostBeforeWrite = sessionLostUrlOf(page, ledger, authentication.sessionLostPathPrefix);
  if (lostBeforeWrite !== null) {
    return { ...PRECHECK_STOPPED, sessionLostUrl: lostBeforeWrite };
  }
  // 書き込みの画面の読み込みの 4xx・5xx は、送らない。
  if (navigation.navigationOutcome !== 'OK' || isHttpStatusInRange(navigation.httpStatus, ERROR_HTTP_STATUS_RANGE)) {
    return PRECHECK_STOPPED;
  }
  // T31g-2: UPDATE は、書き込みの画面の値が前の値と同じかも確かめる（`inspectUpdateForm`）。
  const inspection = input.update === undefined ? await inspectWriteForm(page, spec) : await inspectUpdateForm(page, input.update.spec, input.update.prior);
  if (!inspection.ok || stopSignal.aborted) {
    return PRECHECK_STOPPED;
  }
  const filled = await fillWriteForm(page, inspection.form, write.values, monitor);
  if (!filled.ok) {
    return PRECHECK_STOPPED;
  }
  await wait(WRITE_SUBMISSION_WINDOW_SETTLE_MS);
  // 送信の窓の中で、承認の POST のほかの要求を止めた（ページが入力の値を別の要求で送ろうとした）なら、押さない。
  if (monitor.unexpectedRequestCount() > 0 || stopSignal.aborted) {
    return PRECHECK_STOPPED;
  }
  // main frame の文書の応答（押した後の、POST と redirect の先の応答）を、押す前から記録する。
  const documentStatuses: number[] = [];
  const onResponse = (response: Response): void => {
    try {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        documentStatuses.push(response.status());
      }
    } catch {
      // 読めない応答は記録しない。
    }
  };
  page.on('response', onResponse);
  // T30R2-fix-1（M-b）: 押した後に、main frame の POST のナビゲーションの要求がブラウザで失敗したか（ファイルの先頭の 5）。
  let postNavigationFailed = false;
  const onRequestFailed = (failed: Request): void => {
    try {
      if (failed.method().toLowerCase() === FORM_POST_METHOD && failed.isNavigationRequest() && failed.frame() === page.mainFrame()) {
        postNavigationFailed = true;
      }
    } catch {
      // 読めない要求は数えない（Guard の `responseDeliveryCanceled` でも見る）。
    }
  };
  page.on('requestfailed', onRequestFailed);
  try {
    await pacer.beforeNavigation();
    // T30R-fix-1（DEF-103）: 最後の待ちの後に止める印を確かめ、送る直前の確かめ直しをしてから押す（その間に待ちと読み込みを入れない）。
    if (stopSignal.aborted) {
      return PRECHECK_STOPPED;
    }
    const recheck = await request.recheck();
    if (!recheck.allowed || stopSignal.aborted) {
      return PRECHECK_STOPPED;
    }
    const submittedAt = request.clock();
    const submitted = await submitWriteForm(page, inspection.form, write.values);
    if (!submitted.ok && !submitted.clickAttempted) {
      return PRECHECK_STOPPED;
    }
    const judged = await judgeResult(input, documentStatuses, () => postNavigationFailed);
    // T32e: 判定の時刻は、判定を終えた時点の時計（報告の `response.judgedAt`）。
    return { clicked: true, precheckFailed: false, submittedAt, judgedAt: request.clock(), ...judged };
  } finally {
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
  }
}

/** 押した後の結果の判定（ファイルの先頭の 5・6）。期限（`resultTimeoutMs`）まで、間隔ごとに確かめる。 */
async function judgeResult(input: WriteStageInput, documentStatuses: readonly number[], postNavigationFailed: () => boolean): Promise<{
  readonly httpStatus: number | null;
  readonly responseJudgement: ResponseJudgement | null;
  readonly rawRecordId: string | null;
  readonly sessionLostUrl: string | null;
}> {
  const { request, monitor, page, ledger } = input;
  const { write, authentication, config } = request;
  const deadline = request.now() + (request.resultTimeoutMs ?? config.crawl.navigationTimeoutMs);
  const finalStatus = (): number | null => documentStatuses.at(-1) ?? monitor.submissionReport().responseStatus;
  const decided = (responseJudgement: ResponseJudgement | null, rawRecordId: string | null = null, sessionLostUrl: string | null = null) => {
    const report = monitor.submissionReport();
    return { httpStatus: report.responseReceived ? finalStatus() : null, responseJudgement: report.responseReceived ? responseJudgement : null, rawRecordId,
      sessionLostUrl };
  };
  for (;;) {
    const report = monitor.submissionReport();
    if (report.submission === 'NOT_SENT' && (payloadBlocked(monitor) || isPassiveRequestGuardClosed(input.context) || report.sendOutcome !== null)) {
      // Guard が送る中身の照合で止めた、Guard が Context を閉じた（違反。送っていない）、または送り手が書く前に止まった（DEF-099 fix）。
      return decided(null);
    }
    if (report.sendOutcome === 'NO_RESPONSE') {
      // DEF-099 fix: 送り手が書いた後に応答がなかった（届いたかは分からない）。待たずに判定なしで終える（`UNKNOWN`）。
      return decided(null);
    }
    if (report.responseReceived) {
      if (report.responseStatus !== null && REPOST_REDIRECT_STATUSES.has(report.responseStatus)) {
        return decided('REPOST_REDIRECT');
      }
      // T30R2-fix-1（M-b）: 応答をブラウザに返せなかった。今の画面（ページが自分で移った先など）は POST の応答ではないので、判定しない。
      // HTTP の状態は、送り手が受けた応答のもの（今の画面の文書の状態ではない）。
      if (monitor.snapshot().responseDeliveryCanceled || postNavigationFailed()) {
        return { ...decided('RESPONSE_NOT_DELIVERED'), httpStatus: report.responseStatus };
      }
      const byStatus = statusJudgementOf(finalStatus());
      if (byStatus !== null) {
        return decided(byStatus);
      }
      const lost = sessionLostUrlOf(page, ledger, authentication.sessionLostPathPrefix);
      if (lost !== null) {
        return decided('SESSION_LOST', null, lost);
      }
      const success = await isLoginResultConditionPage(page, write.verification.successCondition, authentication.approvedTestOrigins);
      const inputError = await isLoginResultConditionPage(page, write.verification.inputErrorCondition, authentication.approvedTestOrigins);
      if (success && inputError) {
        return decided('MULTIPLE_CONDITIONS_MATCHED');
      }
      if (success) {
        return decided('SUCCESS', await recordIdOf(page, write.verification.recordId));
      }
      if (inputError) {
        return decided('INPUT_ERROR');
      }
    }
    if (request.now() >= deadline || page.isClosed()) {
      return decided(report.responseReceived ? 'NO_CONDITION_MATCHED' : null);
    }
    await wait(WRITE_RESULT_POLL_INTERVAL_MS);
  }
}

/** 送る前の確かめ（ファイルの先頭の 3 の a・b）。止めるなら理由（違反、セッションの切れの URL）を返す。 */
async function checkFormPage(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  write: WorkerStartWrite,
  options: GuardedPageVisitOptions,
): Promise<{
  readonly ok: boolean;
  readonly violation: boolean;
  readonly sessionLostUrl: string | null;
  /** T31R2-fix-1（C-1）: null の値は、チェック・選択のない見えない checkbox・radio・select（送られない）。 */
  readonly passthroughValues: Readonly<Record<string, string | null>> | null;
  /** T32e: 承認に縛った候補の 2 つの digest が同じ候補が、ちょうど 1 つあったか（画面を読めず確かめまで進まなければ null）。 */
  readonly candidateMatched: boolean | null;
}> {
  const formUrl = pageUrlOf(write.formPage);
  if (!isReadUrlAllowed(formUrl, options.config, options.authentication)) {
    return { ok: false, violation: false, sessionLostUrl: null, passthroughValues: null, candidateMatched: null };
  }
  const classificationPolicy = { allowedOrigins: new Set(options.authentication.approvedTestOrigins) };
  // T31R-fix-1（C-1）: 候補がちょうど 1 つなら、同じ画面で、値を照らす hidden・readonly・見えない欄の値を読む（記録しない）。
  const visit = await visitGuardedPage(factory, pacer, formUrl, options, async ({ page, counter, navigation }): Promise<CandidateCheck<
    Readonly<Record<string, string | null>> | null
  > | null> => {
    if (navigation.navigationOutcome !== 'OK' || isHttpStatusInRange(navigation.httpStatus, ERROR_HTTP_STATUS_RANGE)) {
      return null;
    }
    const read = await readCandidatePage(page, { classificationPolicy, requestCounter: counter });
    const matching = read.candidates.filter((candidate) => candidate.identityDigest === write.candidate.identityDigest);
    const [only, ...others] = matching;
    if (only === undefined || others.length > 0 || only.ruleDigest !== write.candidate.ruleDigest) {
      return CANDIDATE_NOT_MATCHED;
    }
    const passthrough = await readWritePassthroughValues(page, formSpecOf(write));
    return { matched: true, value: passthrough.ok ? passthrough.values : null };
  });
  if (visit.kind === 'SESSION_LOST') {
    return { ok: false, violation: visit.violation, sessionLostUrl: visit.url, passthroughValues: null, candidateMatched: null };
  }
  const checked = visit.kind === 'VISITED' ? visit.value : null;
  const candidateMatched = checked === null ? null : checked.matched;
  if (checked === null || !checked.matched || checked.value === null || visit.violation) {
    return { ok: false, violation: visit.violation, sessionLostUrl: null, passthroughValues: null, candidateMatched };
  }
  return { ok: true, violation: false, sessionLostUrl: null, passthroughValues: checked.value, candidateMatched: true };
}

/** T32e: 画面の候補の確かめの結果（候補が一致しなかった、または一致して、その画面で読んだ値）。 */
type CandidateCheck<TValue> = { readonly matched: false } | { readonly matched: true; readonly value: TValue };

/** T32e: 承認に縛った候補が画面になかった（ちょうど 1 つでなかった）。 */
const CANDIDATE_NOT_MATCHED: { readonly matched: false } = Object.freeze({ matched: false });

/** T31g-2: 更新の画面の読み取りの結果（前の読み取りと後の読み取り）。 */
interface UpdateFormPageCheck {
  readonly values: UpdateFormValues | null;
  readonly violation: boolean;
  readonly sessionLostUrl: string | null;
  /** T32e: 型にした識別の digest と規則の digest が同じ候補が、ちょうど 1 つあったか（確かめまで進まなければ null）。 */
  readonly candidateMatched: boolean | null;
}

/**
 * T31g-2: 更新の画面の確かめと読み取り（ファイルの先頭の T31g-2 の「更新の前の読み取り」「更新の後の照合」）。凍結した Context で具体的な更新の画面を
 * 1 回読み、型にした識別の digest と規則の digest が同じ候補がちょうど 1 つあれば、同じ画面で値を読む。どれかが外れれば `values` は null。
 */
async function checkUpdateFormPage(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  write: WorkerStartWrite,
  update: WorkerStartWriteUpdate,
  options: GuardedPageVisitOptions,
): Promise<UpdateFormPageCheck> {
  const formUrl = pageUrlOf(write.formPage);
  if (!isReadUrlAllowed(formUrl, options.config, options.authentication)) {
    return { values: null, violation: false, sessionLostUrl: null, candidateMatched: null };
  }
  const classificationPolicy = { allowedOrigins: new Set(options.authentication.approvedTestOrigins) };
  const visit = await visitGuardedPage(factory, pacer, formUrl, options, async ({ page, counter, navigation }): Promise<CandidateCheck<
    UpdateFormValues | null
  > | null> => {
    if (navigation.navigationOutcome !== 'OK' || isHttpStatusInRange(navigation.httpStatus, ERROR_HTTP_STATUS_RANGE)) {
      return null;
    }
    const read = await readCandidatePage(page, { classificationPolicy, requestCounter: counter });
    const matching = read.candidates.filter((candidate) => candidate.ruleDigest === write.candidate.ruleDigest
      && templatedIdentityDigestForRecordIdOf(candidate, update.targetRecordId) === update.templatedIdentityDigest);
    if (matching.length !== 1) {
      return CANDIDATE_NOT_MATCHED;
    }
    const values = await readUpdateFormValues(page, updateSpecOf(write, update));
    return { matched: true, value: values.ok ? values.values : null };
  });
  if (visit.kind === 'SESSION_LOST') {
    return { values: null, violation: visit.violation, sessionLostUrl: visit.url, candidateMatched: null };
  }
  const checked = visit.kind === 'VISITED' ? visit.value : null;
  return {
    values: checked !== null && checked.matched && !visit.violation ? checked.value : null,
    violation: visit.violation,
    sessionLostUrl: null,
    candidateMatched: checked === null ? null : checked.matched,
  };
}

/** T31g-2: 変える欄の前の値が、証拠に書ける長さか（`action-run.json` の上限と同じ）。 */
const priorValuesRecordable = (update: WorkerStartWriteUpdate, prior: UpdateFormValues): boolean =>
  update.changedFieldNames.every((name) => (prior.fields[name] ?? '').length <= MAX_SUBMITTED_VALUE_LENGTH);

/**
 * T31g-2: 更新の後の照合の証拠（欄ごとに 1 つ。変えた欄、保つ欄、状態の名前の欄の順）。`after` が null（読めなかった）なら、どの欄も照合できない
 * （`matched` は null）。組の名前の欄は、組の hidden の値も前の値と同じときだけ一致。
 */
function updateEvidenceOf(
  update: WorkerStartWriteUpdate,
  prior: UpdateFormValues,
  after: UpdateFormValues | null,
  values: Readonly<Record<string, string | null>>,
): WriteUpdateEvidence {
  const pairKept = (name: string, current: UpdateFormValues): boolean =>
    !Object.hasOwn(prior.pairOffValues, name) || sameValue(current.pairOffValues[name] ?? null, prior.pairOffValues[name] ?? null);
  const matchedOf = (name: string, expected: string | null): boolean | null =>
    (after === null ? null : sameValue(after.fields[name] ?? null, expected) && pairKept(name, after));
  const changed = update.changedFieldNames.map((fieldName): WriteUpdateFieldEvidence => Object.freeze({
    fieldName, role: 'CHANGED', previousValue: prior.fields[fieldName] ?? '', newValue: values[fieldName] ?? '', matched: matchedOf(fieldName, values[fieldName] ?? null),
  }));
  const kept = update.keptFieldNames.map((fieldName): WriteUpdateFieldEvidence => Object.freeze({
    fieldName, role: 'KEPT', previousValue: null, newValue: null, matched: matchedOf(fieldName, prior.fields[fieldName] ?? null),
  }));
  const state = Object.keys(prior.stateHiddenValues).map((fieldName): WriteUpdateFieldEvidence => Object.freeze({
    fieldName, role: 'KEPT', previousValue: null, newValue: null,
    matched: after === null ? null : sameValue(after.stateHiddenValues[fieldName] ?? null, prior.stateHiddenValues[fieldName] ?? null),
  }));
  return Object.freeze({ fields: Object.freeze([...changed, ...kept, ...state]) });
}

/** 送信の報告の状態（1 回だけ送る。書き込みの段に入ったか）。 */
interface SubmissionReporting {
  reported: boolean;
  stageEntered: boolean;
}

/** 書く（ファイルの先頭の 2〜8）。送信の報告は、ここで 1 回だけ送る。 */
async function performWrite(
  request: WriteCreateRunRequest,
  outputDirectory: string,
  observer: WriteCreateRunObserver,
  reporting: SubmissionReporting,
): Promise<WriteFacts> {
  const { config, authentication, write, stopSignal, now } = request;
  const report = (facts: WriteFacts): WriteFacts => {
    if (!reporting.reported) {
      reporting.reported = true;
      request.reportSubmission({ submission: facts.submission, blockReason: facts.blockReason });
    }
    return facts;
  };
  // DEF-100 fix: pacer は PREFLIGHT の前に作り、factory にも渡す（Guard が main frame の文書の要求を送った時刻を記録する）。
  const pacer = request.navigationPacer ?? createNavigationPacer({ minIntervalMs: config.crawl.minNavigationIntervalMs, now, sleep: wait });
  const preflight = await runPreflight({
    config,
    launchBrowser: request.launchBrowser,
    createSafetyLedger: () => new SafetyLedger(),
    outputDirectory,
    contextFactoryOptions: {
      authentication: authenticatedContextOptions(authentication),
      navigationPacer: pacer,
      ...(request.writeSubmissionCertificates === undefined ? {} : { writeSubmissionCertificates: request.writeSubmissionCertificates }),
    },
  });
  if (!preflight.ok) {
    return report({ ...notSent(PRECHECK_FAILED), preflightFailed: true });
  }
  const { browser, factory } = preflight;
  try {
    const options: GuardedPageVisitOptions = { config, allowedQueryParameters: new Set(config.crawl.allowedQueryParameters), authentication };
    if (stopSignal.aborted) {
      return report(notSent(PRECHECK_FAILED));
    }
    const spec = formSpecOf(write);
    let updateStage: UpdateStage | undefined;
    let expectation: WritePayloadExpectation;
    if (write.update === undefined) {
      const formPage = await checkFormPage(factory, pacer, write, options);
      if (formPage.sessionLostUrl !== null) {
        observer.onSessionLost(redactUrlSecrets(formPage.sessionLostUrl));
      }
      const created = formPage.passthroughValues === null ? null : payloadExpectationOf(write, spec, formPage.passthroughValues);
      if (!formPage.ok || stopSignal.aborted || created === null) {
        return report(notSent(PRECHECK_FAILED, { violation: formPage.violation, candidateDigestMatched: formPage.candidateMatched }));
      }
      expectation = created;
    } else {
      // T31g-2: 更新の前の読み取り（ファイルの先頭の T31g-2）と、照合の期待（保つ欄・状態の欄・組は前の値）。
      const prior = await checkUpdateFormPage(factory, pacer, write, write.update, options);
      if (prior.sessionLostUrl !== null) {
        observer.onSessionLost(redactUrlSecrets(prior.sessionLostUrl));
      }
      if (prior.values === null || stopSignal.aborted || !priorValuesRecordable(write.update, prior.values)) {
        return report(notSent(PRECHECK_FAILED, { violation: prior.violation, candidateDigestMatched: prior.candidateMatched }));
      }
      updateStage = { spec: updateSpecOf(write, write.update), prior: prior.values };
      const fields = updatePayloadFieldsOf(updateStage.spec, updateStage.prior, write.values);
      if (!fields.ok) {
        return report(notSent(PRECHECK_FAILED, { candidateDigestMatched: true }));
      }
      expectation = { request: { origin: write.request.origin, path: write.request.path, enctype: spec.enctype }, ...fields.fields };
    }
    // 書き込みの段（Guard の照合の期待を付けた Context）。閉じた後に、Guard の送信の報告で送ったかを決める。
    const monitor = new WriteStageMonitor();
    let context: BrowserContext;
    try {
      context = await factory.createWriteStageContext(config.viewports.primaryDesktop, { expectation, monitor });
    } catch {
      return report(notSent(PRECHECK_FAILED, { candidateDigestMatched: true }));
    }
    const ledger = factory.getSafetyLedger(context);
    reporting.stageEntered = true;
    let stage: WriteStageResult = PRECHECK_STOPPED;
    try {
      const page = await factory.createPassivePage(context);
      stage = await writeOnStage({ request, factory, pacer, monitor, context, page, ledger, update: updateStage });
    } catch {
      // 送ったかは、閉じた後の Guard の送信の報告で決める。
    } finally {
      await closePassiveContextBeforeDeadline(factory, context, { timeoutMs: CONTEXT_CLOSE_TIMEOUT_MS });
    }
    if (stage.sessionLostUrl !== null) {
      observer.onSessionLost(redactUrlSecrets(stage.sessionLostUrl));
    }
    const violation = hasViolation(ledger);
    const guardReport = monitor.submissionReport();
    // T32e: Guard の書き込みの段の数の要約（Context を閉じた後の写し。送った回も送らなかった回も報告に書く）。
    const guard = guardSummaryOf(monitor.snapshot());
    if (guardReport.submission === 'NOT_SENT') {
      return report(notSent(payloadBlocked(monitor) ? PAYLOAD_MISMATCH : PRECHECK_FAILED, { violation, candidateDigestMatched: true, guard }));
    }
    // Guard が承認の POST を通した（送った）。応答がなければ判定なし（予約は `UNKNOWN`）。
    const httpStatus = guardReport.responseReceived ? stage.httpStatus ?? guardReport.responseStatus : null;
    const responseJudgement = httpStatus === null ? null : stage.responseJudgement ?? 'NO_CONDITION_MATCHED';
    /** 送った回の事実（照合の READ の証拠と UPDATE の証拠と違反は、段ごとに決める）。 */
    const sentFacts = (readEvidence: ReadCheckExecutedEvidence | null, updateEvidence: WriteUpdateEvidence | null, sentViolation: boolean): WriteFacts =>
      Object.freeze({
        submission: 'SENT', blockReason: null, httpStatus, responseJudgement, rawRecordId: stage.rawRecordId, readEvidence, submittedAt: stage.submittedAt,
        violation: sentViolation, updateEvidence, candidateDigestMatched: true, judgedAt: responseJudgement === null ? null : stage.judgedAt, guard,
      });
    // 送信の報告（送った。報告に使うのは送信の状態と止めた理由だけ）。
    report(sentFacts(null, null, violation));
    // T31g-2: UPDATE の更新の後の照合（成功のときだけ。一致しない欄があれば、照合の READ は行わない（結果は `UNKNOWN` に決まる））。
    let updateEvidence: WriteUpdateEvidence | null = null;
    if (responseJudgement === 'SUCCESS' && !violation && write.update !== undefined && updateStage !== undefined) {
      const after = await checkUpdateFormPage(factory, pacer, write, write.update, options);
      if (after.sessionLostUrl !== null) {
        observer.onSessionLost(redactUrlSecrets(after.sessionLostUrl));
      }
      updateEvidence = updateEvidenceOf(write.update, updateStage.prior, after.values, write.values);
      if (after.violation || fieldsMatchedOf(updateEvidence) === false) {
        return sentFacts(null, updateEvidence, violation || after.violation);
      }
    }
    if (responseJudgement === 'SUCCESS' && !violation) {
      const verified = await verifyReadCheck(factory, pacer, write.readVerification, options);
      if (verified.sessionLostUrl !== null) {
        observer.onSessionLost(redactUrlSecrets(verified.sessionLostUrl));
      }
      // T32e: 照合の READ の証拠の全体を残す（実行しなかった定義の証拠は、報告では実行しなかった印にする）。
      const { evidence } = verified;
      return sentFacts(evidence.state === 'EXECUTED' ? evidence : null, updateEvidence, verified.violation);
    }
    return sentFacts(null, updateEvidence, violation);
  } finally {
    await closeBrowserBeforeDeadline(browser);
  }
}

/**
 * Run の状態（書き込みの事実を、唯一の判定 `deriveRunStatus` の入力に写すだけ。判定はしない）。違反は `ABORTED_BY_SAFETY`、Run の前の確認の
 * 失敗は `FAILED`。照合まで済んだ（`VERIFIED`）ときだけ `COMPLETE` になりうる: 送らずに止めた・失敗は「失敗した仕事」、照合できない・分からないは
 * 「確かめていない仕事」として数える（どちらも `PARTIAL`）。
 */
const writeRunStatusOf = (result: ActionResult, facts: WriteFacts): RunStatus => deriveRunStatus({
  preflightFailed: facts.preflightFailed === true,
  safetyInvariantViolations: facts.violation ? 1 : 0,
  safetyLedgerTruncated: false,
  incompleteReasons: [],
  unhandledFailures: 0,
  crawlLimitReached: false,
  requiredArtifactsValid: true,
  executionComplete: true,
  skippedRequiredWork: 0,
  blockedRequiredWork: 0,
  timedOutRequiredWork: 0,
  notObservedRequiredWork: 0,
  notVerifiedRequiredWork: result === 'PARTIAL' || result === 'UNKNOWN' ? 1 : 0,
  failedRequiredWork: result === 'BLOCKED' || result === 'FAILED' ? 1 : 0,
  incompleteCollectorCount: 0,
});

/** 照合の READ の記録（`action-run.json` の `readVerification`。証拠の全体から id・版・結果だけを取る。実行しなければ null）。 */
const readVerificationOf = (facts: WriteFacts): ActionRunReadVerification | null => (facts.readEvidence === null
  ? null
  : { readCheckId: facts.readEvidence.readCheckId, readCheckRevision: facts.readEvidence.readCheckRevision, result: facts.readEvidence.result });

/** UPDATE の証拠の変えた欄の役割。 */
const CHANGED_FIELD_ROLE = 'CHANGED' satisfies WriteUpdateFieldEvidence['role'];

/** 照合の READ を実行しなかった印の状態。 */
const READ_NOT_EXECUTED_STATE = 'NOT_EXECUTED' satisfies ActionEvidenceDocument['readVerification']['state'];

/** 人の値が入りうる項目（UPDATE の変えた欄の前の値、照合の READ の取れた値）があるか（T32e。報告の `containsHumanEnteredValues`）。 */
const containsHumanEnteredValuesOf = (facts: WriteFacts): boolean =>
  (facts.updateEvidence?.fields.some((field) => field.role === CHANGED_FIELD_ROLE) ?? false)
  || (facts.readEvidence?.expectations.some((expectation) => 'observedValue' in expectation && typeof expectation.observedValue === 'string') ?? false);

/** 書き込みの記録と報告の文書（T32e）。 */
interface WriteRunDocuments {
  readonly actionRun: ActionRunDocument;
  readonly evidence: ActionEvidenceDocument;
  readonly approvalSummary: ApprovalSummaryDocument;
}

/**
 * 書き込みの記録（`action-run.json`。版は変えない）と、書き込みの報告の証拠（`action-evidence.json`）と承認の要約（`approval-summary.json`）を、
 * 同じ事実から 1 回だけ組み立てる（T32e。Task 32 の設計書 4.1 の「1 回だけ組み立てる」）。重なる値（ID、送った値と時刻、応答、登録の ID、UPDATE の
 * 証拠、照合の READ、結果と理由、時刻）は、ここで 1 回だけ求めて両方に入れる。
 * - 送らなかった回（`NOT_SENT`）の報告は、送った値を `{}`、送信先と送信の時刻と応答を null、照合の READ を実行しなかった印にする（報告の対象は
 *   終わりまで進んだ回すべて。ユーザーの判断 7）。`action-run.json` の送った値は、今までどおり生成した値（親の送る前の記録と同じ）。
 * - 人の値（UPDATE の変えた欄の前の値、照合の READ の `observedValue`）は入れ、`containsHumanEnteredValues` を真にする（ユーザーの判断 6）。
 * - 承認の要約は、`START` の承認の要約の事実に、版の印・ジョブ・Run を足すだけ（照らさない。承認の判断は親）。
 */
function writeRunDocumentsOf(input: {
  readonly request: WriteCreateRunRequest;
  readonly runId: RunId;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly facts: WriteFacts;
  readonly outcome: ActionOutcome;
}): WriteRunDocuments {
  const { request, runId, facts, outcome } = input;
  const { write } = request;
  const timeOf = (date: Date): string => formatCompactUtcTimestamp(date, WRITE_CREATE_TIME_SUBJECT);
  const sent = facts.submission !== 'NOT_SENT';
  const identity = {
    jobId: request.jobId, runId, profileId: write.profileId, scenarioId: write.scenarioId, scenarioRevision: write.scenarioRevision,
  };
  const submittedValues = Object.fromEntries(Object.entries(write.values).flatMap(([name, value]) => (value === null ? [] : [[name, value]])));
  const blockReason = sent ? null : facts.blockReason;
  const submittedAt = facts.submittedAt === null ? null : timeOf(facts.submittedAt);
  const startedAt = timeOf(input.startedAt);
  const finishedAt = timeOf(input.finishedAt);
  const update: ActionRunUpdate | undefined = write.update === undefined
    ? undefined
    : { targetRecordId: write.update.targetRecordId, updateEvidence: facts.updateEvidence ?? null };
  const readVerification = readVerificationOf(facts);
  const actionRun: ActionRunDocument = {
    schemaVersion: ACTION_RUN_SCHEMA_VERSION,
    ...identity,
    grantId: write.grantId,
    seedRecord: write.seedRecord,
    submittedValues,
    resultConditions: { successCondition: write.verification.successCondition, inputErrorCondition: write.verification.inputErrorCondition },
    submission: facts.submission,
    blockReason,
    httpStatus: facts.httpStatus,
    responseJudgement: facts.responseJudgement,
    recordId: facts.rawRecordId,
    readVerification,
    reservationState: reservationSettlementOf(facts.submission, facts.httpStatus !== null),
    result: outcome.result,
    reason: outcome.reason,
    startedAt,
    submittedAt,
    finishedAt,
    ...(update === undefined ? {} : { update }),
  };
  const evidence: ActionEvidenceDocument = {
    schemaVersion: ACTION_EVIDENCE_SCHEMA_VERSION,
    ...identity,
    kind: write.approvalFacts.scenario.kind,
    containsHumanEnteredValues: containsHumanEnteredValuesOf(facts),
    precheck: { candidateDigestMatched: facts.candidateDigestMatched, blockReason },
    submission: sent
      ? { state: facts.submission, submittedValues, actionPath: write.request.path, submittedAt }
      : { state: facts.submission, submittedValues: {}, actionPath: null, submittedAt: null },
    response: sent
      ? { httpStatus: facts.httpStatus, judgement: facts.responseJudgement, judgedAt: facts.judgedAt === null ? null : timeOf(facts.judgedAt) }
      : null,
    recordId: facts.rawRecordId,
    update: update ?? null,
    readVerification: facts.readEvidence ?? {
      readCheckId: write.readVerification.readCheckId, readCheckRevision: write.readVerification.readCheckRevision, state: READ_NOT_EXECUTED_STATE,
    },
    guard: facts.guard,
    result: outcome.result,
    reason: outcome.reason,
    startedAt,
    finishedAt,
  };
  const approvalSummary: ApprovalSummaryDocument = {
    ...write.approvalFacts,
    schemaVersion: APPROVAL_SUMMARY_SCHEMA_VERSION,
    jobId: request.jobId,
    runId,
  };
  return { actionRun, evidence, approvalSummary };
}

/**
 * 書き込みのジョブを実行する（流れはファイルの先頭）。Run の外の失敗（成果物を書けない `ArtifactWriteError`、予期しない例外）は、そのまま reject する
 * （ワーカーの流れが `classifyCliFailure` で `FAILED` にする）。送信の報告を送っていなければ、reject の前に送る（送ったかは分からないとは言わない:
 * 書き込みの段の前の失敗なので `NOT_SENT`）。
 */
export async function executeWriteCreateRun(request: WriteCreateRunRequest, observer: WriteCreateRunObserver): Promise<WriteCreateRunOutcome> {
  const outputDirectory = resolve(request.config.output.directory);
  const writer = new ArtifactWriter({ urlSecretRedaction: true });
  const run = await startWorkerRun(writer, outputDirectory, request.clock, request.now);
  if (run.kind !== 'STARTED') {
    request.reportSubmission({ submission: 'NOT_SENT', blockReason: PRECHECK_FAILED });
    return run;
  }
  const { runId, runDirectory, startedAt } = run;
  observer.onRunStarted({ runId, runDirectory });
  const reporting: SubmissionReporting = { reported: false, stageEntered: false };
  try {
    let facts: WriteFacts;
    try {
      facts = await performWrite(request, outputDirectory, observer, reporting);
    } catch (error) {
      // 予期しない失敗: まだ報告していなければ、書き込みの段の前なら `NOT_SENT`、段に入った後なら `UNKNOWN`（送ったかは分からない）を送る。
      if (!reporting.reported) {
        reporting.reported = true;
        request.reportSubmission(reporting.stageEntered
          ? { submission: 'UNKNOWN', blockReason: null }
          : { submission: 'NOT_SENT', blockReason: PRECHECK_FAILED });
      }
      throw error;
    }
    const readVerification = readVerificationOf(facts);
    const outcome = actionOutcomeOf(facts.submission === 'NOT_SENT'
      ? { submission: 'NOT_SENT', blockReason: facts.blockReason ?? PRECHECK_FAILED }
      : facts.submission === 'UNKNOWN'
        ? { submission: 'UNKNOWN' }
        : { submission: 'SENT', responseJudgement: facts.responseJudgement, recordId: facts.rawRecordId,
          readVerification: readVerification?.result ?? null,
          // T31g-2: UPDATE は、対象の ID と更新の後の照合の結果も渡す（締めの `scenario-store.ts` と同じ判定）。
          ...(request.write.update === undefined
            ? {}
            : { update: { targetRecordId: request.write.update.targetRecordId, fieldsMatched: fieldsMatchedOf(facts.updateEvidence ?? null) } }) });
    const documents = writeRunDocumentsOf({ request, runId, startedAt, finishedAt: request.clock(), facts, outcome });
    // T32f: HTML の報告とバンドルは、書くのと同じ手順（伏せ字・スキーマ・書式）に通した 3 つの文書から 1 回だけ組み立てる（照合の READ の URL は伏せ字の
    // 後。バンドルの中の JSON は、書くファイルと同じバイト列）。
    const presentation = createActionPresentation(await writer.prepareActionReport(runDirectory, documents));
    // T32e・T32f: 書き込みの報告（2 つの JSON、HTML、バンドル）を先に、`action-run.json` を最後に書く（どれかが書けなければ、`action-run.json` が書けない
    // ときと同じく reject する。親は `action-run.json` を読めないジョブを、送信の報告から締める。`action-run.json` だけがあって報告がない Run を作らない）。
    await writer.writeApprovalSummary(runDirectory, documents.approvalSummary);
    await writer.writeActionEvidence(runDirectory, documents.evidence);
    await writer.writeActionPresentation(runDirectory, {
      reportHtml: presentation.reportHtml,
      bundle: { bytes: presentation.bundleBytes, finishedAt: documents.actionRun.finishedAt },
    });
    await writer.writeActionRun(runDirectory, documents.actionRun);
    const runStatus = writeRunStatusOf(outcome.result, facts);
    return { kind: 'RAN', runId, runDirectory, runStatus, exitCode: EXIT_CODES[runStatus], result: outcome.result };
  } finally {
    // 保存の状態は書かない（再開の対象にしない）。ハートビートを止めてから、Run のロックを消す。
    await endWorkerRun(writer, run);
  }
}

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
 *    T40R-fix-A2: 押す直前に同じ取り方で読んだ値（`pageRecordIdBaselineOf`）と同じ値、URL の型で URL が押す前から変わっていないときは、ID として使わない
 *    （`isPageRecordIdNew`。`RECORD_ID_NOT_FOUND`）。
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
 *
 * T40b-1（Task 40 の設計書 3.3、4 章、7 章の履歴の「T40a の報告（API の検証の指定）」）: 送り方 API の登録の書き込みのジョブ（`write` が
 * `WorkerStartApiWrite`）も、この流れで行う（Run の始めと終わり、PREFLIGHT、監査の段の確かめ `auditStageStopsWrite`、送信の報告を 1 回だけ送る作り、
 * 文書を書く順、`writeRunStatusOf` は form と共通。書き込みの段の Context と API の入力の部品 `api-write-submitter.ts` を使うのも、今どおりこのファイル
 * だけ）。違う所:
 * - 3b の代わりに、送る前の画面の確かめ（`checkApiFormPage`）: 凍結した Context で書き込みの画面を 1 回読み（form と同じ `checkWritePage`。読む URL の
 *   判定 `isReadUrlAllowed`）、`inspectApiWriteInput` で、送信の要素（`submitterIdentityDigest`）がちょうど 1 つあり、鍵の欄（`api.keyFields` の欄の識別）が
 *   そろうことを、値を入れずに確かめる（結果は `candidateDigestMatched`）。外れたら送らずに `PRECHECK_FAILED`。
 * - 書き込みの段の Context は `transport: 'API'` で、Guard の照合の期待は承認した API の指定と鍵ごとの生成した値（`apiExpectationOf`）、ID を応答の本文から
 *   取るなら `recordIdOf`（`apiRecordIdOfResponseBody` を ID の鍵で包む）。段の中: 書き込みの画面を 1 回読み → `inspectApiWriteInput` → `fillApiWriteInput`
 *   （送信の窓を開いてから入れる）→ 窓の中で止めた要求がないことを確かめる → form と同じ押す直前の確かめ（`readyToPress`）→ `submitApiWriteInput`。
 * - 結果の判定（`judgeApiResult`。期限は form と同じ `resultTimeoutMs`）: 送らなかった・送り手が書いた後に応答がない・状態が 100〜599 の外は判定なし
 *   （`apiResponseFactsOf`。T40c の発見事項 3 への判断）。応答をブラウザに返せなかった（Guard の `responseDeliveryCanceled`。form と同じ部品）なら
 *   `RESPONSE_NOT_DELIVERED`（ID を取らない）。ほかは `apiResponseJudgementOf` の判定で、成功のときだけ、セッションの切れを
 *   form と同じ部品で見てから、ID を取り方（`apiRecordIdSourceOf`）で取る（応答の本文なら `monitor.apiWriteRecordId()`、画面なら期限まで `recordIdOf`）。
 * - 照合の READ（T40b-2）: form と同じ条件（成功で違反がなく、ID が使える形 `isUsableRecordId`）のときだけ、`{id}` に ID を入れた画面を
 *   `verifyRecordPageReadCheck`（`read-check-run.ts`。保存の時と同じ画面の path の確かめと事前の判定をかけ直し、通れば画面の path の READ と同じ手順で
 *   1 回だけ読む）で読む。ID がない・使えないときは行わない（実行しなかった印。`RECORD_ID_NOT_FOUND`・`RECORD_ID_UNSAFE`）。
 * - 文書は版 1.1 の API の形（送り方 `API`、成否の条件 null、API の要約は `actionApiSummaryOf` で 1 回、送った値は鍵ごとの生成した値、送信先の path は
 *   API の path）。ページが決める鍵の値は、照合まで進んだ（送った）回だけ残す。ヘッダの値・応答の本文は、記録・成果物・例外の文・IPC に出さない（I22）。
 * - 読み込み: 画面の確かめ（GET 1）、書き込みの画面（GET 1）、承認した API の要求（Guard の送り手が 1 回）、照合の READ の `{id}` の画面（GET 1）。
 *
 * T41d（Task 41 の設計書 3.4、3.6）: API の更新（`START` の API の書き込みの指定が `update: { targetRecordId }` を持つ）。
 * - 前の読み取り（`planApiUpdateStage`・`checkApiUpdatePage`）: 凍結した Context で対象の更新の画面を 1 回読み、画面の path を型にした識別の digest が承認の
 *   値と同じ候補がちょうど 1 つで、その path の最後の ID の区切りが対象の ID なら、その候補の識別を送信の要素の識別にし、変える欄・保つ欄・ページが決める
 *   鍵の欄の値を、落ち着くまで待って読む（`readApiWriteFieldValues`。メモリの中だけ）。保つ鍵とページが決める鍵の値は承認の JSON の型に変え（`jsonValueOf`）、
 *   Guard の期待（`keptKeys`・`pageKeyPriorValues`、ID は対象の ID）に入れる。読めない・変えられない・変える欄の前の値が長すぎるなら送らない。
 * - 書き込みの段: 開き直した画面の値が前の値と同じか確かめ（違えば送らない）、登録と同じ手順で入れて押す（画面の ID の基準は読まない）。
 * - 判定（`apiUpdateResultOf`）: 成功で応答の本文が空の一覧なら `NO_CONDITION_MATCHED`、要素 2 つ以上の一覧なら `MULTIPLE_CONDITIONS_MATCHED`
 *   （T41R-fix の I-2）、本文の ID が対象と違えばその ID（`RECORD_ID_MISMATCH`）、ほかは
 *   対象の ID。応答をページに返せなかった印では止めない。
 * - 後の照合（`apiUpdateEvidenceOf`）: ID が対象の ID のときだけ、前の読み取りと同じ確かめで更新の画面を 1 回読み、変えた欄は新しい値、保つ欄とページが
 *   決める鍵の欄は前の値かを照らす。一致しない欄があれば照合の READ は行わない（form の UPDATE と同じ）。記録は `update`（対象の ID と証拠）を持ち、
 *   ページが決める鍵の値は残さない（`{}`）。
 * - 読み込み: 前の読み取り（GET 1）、書き込みの画面（GET 1）、承認した API の要求（1 回）、後の照合（GET 1）、照合の READ（GET 1）。
 * - T41R-fix（設計書 8 章の「T41R の途中の報告」の C-1・I-1）: 欄の値は、画面を読み込む前に作った進行中の要求の数え方（`InFlightRequestCounter`）で、
 *   要求が止んだ後に落ち着いた値を読む（`readApiWriteFieldValues` の `settledFieldValuesWhenQuiet`。前の読み取り、書き込みの段、後の照合のどれも）。
 *   前の読み取りで目印を入れた欄（変える欄と保つ欄）がすべて空なら、値が入る前の画面とみなして送らない（`apiUpdatePriorFilled`）。押す直前の確かめ
 *   （`readyToPress`）の中で、送る直前の確かめ直しの前に欄を読み直し（T41R-fix-2。確かめ直しの後に待ちを入れない）、保つ欄とページが決める鍵の欄が前の
 *   値のまま、変える欄が入れた値のままでなければ押さない（`apiUpdateReadyToPress`）。読み直しの後の書き換えは、送る瞬間に Guard が止める。
 * - T41R2-fix（設計書 8 章の「T41R2」）: 要求が止むのを待つ上限（`API_WRITE_VALUE_QUIET_TIMEOUT_MS`）に届いたら、止めずに 2 回同じ値の落ち着きで進む
 *   （realtime の SPA）。応答の本文が空でなく読めない（上限を超える、JSON でない）なら、行の数が分からないので `NO_CONDITION_MATCHED`
 *   （`isUnreadableApiResponseBody`）。
 * - T41R3-fix（設計書 8 章の「T41R3」。ユーザーの判断「API の更新だけ台帳と比べる」）: 親が台帳から求める保つ鍵ごとの最後に分かっている値
 *   （`update.knownKeptValues`。T41R2-fix の「空でないはずの保つ鍵」を置き換えた）と、前の読み取りか押す直前の読み直しの値が同じ（`sameValue`）でなければ
 *   送らない（`apiUpdateKnownKeptMismatch`。仮の値・空・BeakSight の外での変更）。後の照合で違えば、その欄は照合できない（`UPDATE_POSTCHECK_UNDETERMINED`
 *   の側）。一覧にない保つ鍵は今のまま。M-1: 同じ Run で一度、要求が止む待ちの上限に届いた書き込みの画面は、残りの読み取りでその待ちを省く
 *   （`ApiUpdateQuietMemory`。候補の落ち着きの待ちの後も要求が止んでいない画面も同じ。欄の値は 2 回同じ値の落ち着きで読み、後の照合の候補の読み取りの
 *   落ち着きの待ちは欄の値の待ちの上限に縮める。候補の読み取りは画面を凍結するので、0 にはしない）。限界: ページのタイマーだけで長く遅れて値を入れる形は、止める側に倒れるが、すべての形を見分けられるとは限らない。
 */
import { resolve } from 'node:path';
import type { BrowserContext, Page, Request, Response } from 'playwright';
import {
  API_WRITE_VALUE_QUIET_TIMEOUT_MS,
  fillApiWriteInput,
  inspectApiWriteInput,
  readApiWriteFieldValues,
  submitApiWriteInput,
  type ApiWriteInputSpec,
} from '../browser/api-write-submitter.js';
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
import { actionApiSummaryOf } from '../control/actions/action-api-summary.js';
import {
  ACTION_EVIDENCE_SCHEMA_VERSION,
  ACTION_RUN_SCHEMA_VERSION,
  APPROVAL_SUMMARY_SCHEMA_VERSION,
  MAX_HTTP_STATUS,
  MAX_SUBMITTED_VALUE_LENGTH,
  MIN_HTTP_STATUS,
  type ActionBlockReason,
  type ActionEvidenceDocument,
  type ActionGuardSummary,
  type ActionOutcome,
  type ActionResult,
  type ActionRunDocument,
  type ActionRunReadVerification,
  type ActionRunUpdate,
  type ApprovalSummaryDocument,
  type PrecheckFailureDetail,
  type ResponseJudgement,
  type SubmissionState,
  type WriteUpdateEvidence,
  type WriteUpdateFieldEvidence,
} from '../control/actions/action-contracts.js';
import {
  actionOutcomeOf,
  apiResponseJudgementOf,
  fieldsMatchedOf,
  isUsableRecordId,
  recordableRecordIdOf,
  reservationSettlementOf,
} from '../control/actions/action-outcome.js';
import { apiRecordIdOfResponseBody, apiResponseBodyShapeOf } from '../control/actions/api-record-id.js';
import {
  WORKER_API_WRITE_TRANSPORT,
  isWorkerStartApiWrite,
  type WorkerStartApiWrite,
  type WorkerStartWrite,
  type WorkerStartWriteUpdate,
} from '../control/worker-protocol.js';
import type { ApiFieldIdentity } from '../core/api-field-identity.js';
import { lastRecordIdLikePathSegmentIndexOf, type ApiJsonValueType } from '../core/api-request-shape.js';
import type { RunId, RunStatus } from '../core/contracts.js';
import { jsonValueOf } from '../core/json-value.js';
import { wait } from '../core/deadline.js';
import {
  ERROR_HTTP_STATUS_RANGE,
  SERVER_ERROR_HTTP_STATUS_RANGE,
  TOO_MANY_REQUESTS_HTTP_STATUS,
  isHttpStatusInRange,
  type HttpStatusRange,
} from '../core/http-status.js';
import { CONTEXT_CLOSE_TIMEOUT_MS } from '../core/limits.js';
import { deriveRunStatus } from '../core/status.js';
import { formatCompactUtcTimestamp } from '../core/utc-timestamp.js';
import { createNavigationPacer, type NavigationPacer } from '../crawl/navigation-pacer.js';
import { FORM_SCENARIO_TRANSPORT, type ScenarioRecordIdSpec, type ScenarioTransport } from '../control/approval/scenario-contracts.js';
import type { CandidateLocation } from '../discovery/candidate-contracts.js';
import { pagePathTemplatedIdentityDigestOf, recordIdOfPathPattern, templatedIdentityDigestForRecordIdOf } from '../discovery/fingerprint.js';
import type { ReadCheckExecutedEvidence } from '../discovery/read-check-evaluation.js';
import { readCandidatePage } from '../discovery/read-executor.js';
import {
  DISCOVERY_NETWORK_QUIET_MS,
  DISCOVERY_SETTLE_POLICY,
  InFlightRequestCounter,
  type DiscoverySettlePolicy,
  type QuietSource,
} from '../discovery/settle.js';
import {
  isServiceRequestLimitReached,
  jobContextFactoryOptions,
  sessionKeyLostDetailOf,
  type AuditStageRunState,
} from '../orchestration/audit-stage-run.js';
import { sessionLostUrlOf, type RunAuthentication } from '../orchestration/authenticated-run.js';
import { navigatePage } from '../orchestration/page-navigation.js';
import { closePassiveContextBeforeDeadline } from '../orchestration/passive-session-close.js';
import { closeBrowserBeforeDeadline, runPreflight, type BrowserLauncher } from '../orchestration/preflight.js';
import { createActionPresentation } from '../report/action-bundle.js';
import { ArtifactWriter } from '../report/artifact-writer.js';
import type { ApiJsonScalarValue, ApiWritePayloadExpectation, ApiWritePriorValue } from '../safety/api-write-payload-policy.js';
import {
  isPassiveRequestGuardClosed,
  WriteStageMonitor,
  type GuardWriteStage,
  type WriteStageMonitorSnapshot,
} from '../safety/passive-request-guard.js';
import { redactUrlSecrets } from '../safety/redact.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import type { WritePayloadExpectation } from '../safety/write-payload-policy.js';
import { isLoginResultConditionPage, loginStageLocator } from './login-stage-checks.js';
import { isReadUrlAllowed, verifyReadCheck, verifyRecordPageReadCheck } from './read-check-run.js';
import {
  endWorkerRun,
  hasViolation,
  startWorkerRun,
  visitGuardedPage,
  type GuardedPageView,
  type GuardedPageVisitOptions,
} from './worker-run-session.js';
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
  /** `START` の書き込みの指定（契約で確かめたもの）。T40b-1: 送り方 API の登録の書き込みの指定も受ける。 */
  readonly write: WorkerStartWrite | WorkerStartApiWrite;
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
export interface WriteFacts {
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
  /** T44e（Task 44 の設計書 P2-4）: `PRECHECK_FAILED` の具体的な理由（分かったときだけ。`action-run.json` の任意の項目 `precheckDetail`）。 */
  readonly precheckDetail?: PrecheckFailureDetail;
  /**
   * T40b-1: API の書き込みで、Guard の照合が返したページが決める鍵の値（`monitor.apiWritePageKeyValues()`。form と、照合まで進まなかった回は
   * null か省略）。文書は、送った回だけ残す。
   */
  readonly apiPageKeyValues?: Readonly<Record<string, ApiJsonScalarValue>> | null;
}

/** 送らずに止めた事実（T32e: 候補の確かめの結果と Guard の要約は、分かっていれば添える）。 */
const notSent = (
  blockReason: ActionBlockReason,
  details: {
    readonly violation?: boolean;
    readonly candidateDigestMatched?: boolean | null;
    readonly guard?: ActionGuardSummary | null;
    /** T44e（Task 44 の設計書 P2-4）: `PRECHECK_FAILED` の具体的な理由（ほかの理由では付けない）。 */
    readonly precheckDetail?: PrecheckFailureDetail | undefined;
  } = {},
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
  ...(blockReason === PRECHECK_FAILED && details.precheckDetail !== undefined ? { precheckDetail: details.precheckDetail } : {}),
});

/**
 * T44e（Task 44 の設計書 P2-4）: 送る前の画面の確かめ（`WritePageCheck`）で送らないときの、具体的な理由。止める印 → ログインの切れ → 候補が合わない →
 * 画面を読めない、の順に決める（送る・送らないの判定は呼ぶ側のまま）。
 */
const pageCheckDetailOf = (check: WritePageCheck<unknown>, aborted: boolean): PrecheckFailureDetail => {
  if (aborted) {
    return 'STOPPED';
  }
  if (check.sessionLostUrl !== null) {
    return 'SESSION_LOST';
  }
  return check.candidateMatched === false ? 'CANDIDATE_CHANGED' : 'PAGE_UNAVAILABLE';
};

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

/**
 * 登録の ID を取る（取れなければ null。成果物に書いてよい値だけ）。URL の path の型（`{id}` の区切り）は、T40R-fix-A から保存と IPC と同じ部品
 * `recordIdOfPathPattern`（`src/discovery/fingerprint.ts`。区切りの数と、ほかの区切りが同じときだけ、そのままの値）で取る。要素は、ちょうど 1 つのときだけ、
 * その文字の前後の空白を除いた値。
 */
async function recordIdOf(page: Page, spec: ScenarioRecordIdSpec): Promise<string | null> {
  try {
    if (spec.source === 'URL_PATH_PATTERN') {
      return recordableRecordIdOf(recordIdOfPathPattern(new URL(page.url()).pathname, spec.pathPattern));
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

/** T40b-1: 記録できる HTTP の状態の範囲（`action-run.json` の `httpStatus` の最小と最大）。 */
const RECORDABLE_HTTP_STATUS_RANGE: HttpStatusRange = Object.freeze({ min: MIN_HTTP_STATUS, max: MAX_HTTP_STATUS });

/** T40b-1: API の書き込みの応答の事実（記録する状態と、結果の判定。応答が分からなければどちらも null）。 */
export interface ApiResponseFacts {
  readonly httpStatus: number | null;
  readonly responseJudgement: ResponseJudgement | null;
}

const UNKNOWN_API_RESPONSE: ApiResponseFacts = Object.freeze({ httpStatus: null, responseJudgement: null });

/**
 * T40b-1: 送り手の応答の状態から、記録する状態と判定を決める（純粋。ファイルの先頭の T40b-1）。応答を受けていない、状態が 100〜599 の外（整数でない
 * 値を含む）なら、応答が分からないとして、どちらも null（T40c の発見事項 3 への判断。結果は `UNKNOWN`）。範囲の中なら、状態はそのまま、判定は
 * `apiResponseJudgementOf`（判定の唯一の口）。
 */
export const apiResponseFactsOf = (report: { readonly responseReceived: boolean; readonly responseStatus: number | null }): ApiResponseFacts => {
  const status = report.responseReceived ? report.responseStatus : null;
  if (status === null || !Number.isSafeInteger(status) || !isHttpStatusInRange(status, RECORDABLE_HTTP_STATUS_RANGE)) {
    return UNKNOWN_API_RESPONSE;
  }
  return Object.freeze({ httpStatus: status, responseJudgement: apiResponseJudgementOf(status) });
};

/** T40b-1: API の書き込みの登録の ID の取り方（応答の本文の鍵か、保存の後の画面の URL・要素）。 */
export type ApiRecordIdSource =
  | { readonly kind: 'RESPONSE_BODY'; readonly key: string }
  | { readonly kind: 'PAGE'; readonly spec: ScenarioRecordIdSpec };

/**
 * T40b-1: ID の取り方を選ぶ（純粋）。API の指定の `recordId`（応答の本文の鍵）があればそれ、なければ検証の指定の `recordId`（保存の後の画面）。
 * どちらもなければ null（契約で拒むので起きない。fail-closed: ID なしで判定する）。
 */
export const apiRecordIdSourceOf = (write: WorkerStartApiWrite): ApiRecordIdSource | null => {
  if (write.api.recordId !== null) {
    return { kind: 'RESPONSE_BODY', key: write.api.recordId.key };
  }
  return write.verification.recordId === null ? null : { kind: 'PAGE', spec: write.verification.recordId };
};

/** T40b-1: API の入力と押下の指定（欄は `api.keyFields` の欄の識別、値は鍵ごとの生成した値。null の値の鍵は入れない）。 */
const apiInputSpecOf = (write: WorkerStartApiWrite): ApiWriteInputSpec => ({
  submitterIdentityDigest: write.submitterIdentityDigest,
  fields: write.api.keyFields.flatMap(({ key, field }) => {
    const value = Object.hasOwn(write.values, key) ? write.values[key] : null;
    return typeof value === 'string' ? [{ field, value }] : [];
  }),
});

/** T40b-1: Guard の API の照合の期待（承認した API の指定と鍵ごとの生成した値。登録なので台帳の ID はない）。 */
const apiExpectationOf = (write: WorkerStartApiWrite): ApiWritePayloadExpectation => ({ spec: write.api, values: write.values, recordId: null });

/** T40b-1: API の書き込みの段の指定（ID を応答の本文から取るなら、Guard の `recordIdOf` に ID の鍵で包んだ口を渡す）。 */
const apiWriteStageOf = (write: WorkerStartApiWrite, monitor: WriteStageMonitor, update?: ApiUpdateStage): GuardWriteStage => {
  if (update !== undefined) {
    // T41d（Task 41 の設計書 3.3・3.4）: 更新の照合の期待は、変える鍵の生成した値、対象の ID（filter の照合）、保つ鍵とページが決める鍵の前の値（メモリの
    // 中だけ）。応答の本文からは、ID の鍵（応答の本文の鍵がなければ filter の名前）の ID と、一覧の要素の数を読む（本文は持たない）。
    const key = write.api.recordId?.key ?? write.api.filterName;
    return {
      transport: WORKER_API_WRITE_TRANSPORT,
      expectation: {
        ...apiExpectationOf(write), recordId: update.targetRecordId, keptKeys: update.keptPriorValues, pageKeyPriorValues: update.pagePriorValues,
      },
      monitor,
      recordIdOf: (body: Buffer): string | null => {
        // CC-104: 本文の形を 1 回だけ求めて、一覧の要素の数と、読めない本文かを決める。
        const shape = apiResponseBodyShapeOf(body);
        update.response.rowCount = shape.kind === 'LIST' ? shape.length : null;
        update.response.bodyUnreadable = shape.kind === 'UNREADABLE';
        return key === null ? null : apiRecordIdOfResponseBody(body, key);
      },
    };
  }
  const source = apiRecordIdSourceOf(write);
  return {
    transport: WORKER_API_WRITE_TRANSPORT,
    expectation: apiExpectationOf(write),
    monitor,
    recordIdOf: source?.kind === 'RESPONSE_BODY' ? (body: Buffer): string | null => apiRecordIdOfResponseBody(body, source.key) : undefined,
  };
};

// ---------------------------------------------------------------------------------------------------------------
// T41d（Task 41 の設計書 3.4）: API の更新
// ---------------------------------------------------------------------------------------------------------------

/** T41d: API の書き込みの指定が UPDATE（T41b の `update: { targetRecordId }`）なら、対象の ID（登録は null）。 */
const apiUpdateTargetOf = (write: WorkerStartApiWrite): string | null => write.update?.targetRecordId ?? null;

/** T41R3-fix: 台帳が知る保つ鍵の最後の値（`START` の `update.knownKeptValues` の 1 つ。値は BeakSight が作ったテストの値。メモリの中だけ）。 */
export interface ApiUpdateKnownKeptValue {
  readonly key: string;
  readonly value: string;
}

/**
 * T41R3-fix（設計書 8 章の「T41R3」の (1)・(2)）: 親が台帳から求める保つ鍵ごとの最後に分かっている値（`START` の `update.knownKeptValues`。T41R3-fix-B の
 * 約束の形。T41R2-fix の `knownFilledKeptKeys` を置き換えた。IPC の確かめが、API の指定の保つ鍵だけで重ならないことを確かめる）。登録は空の一覧。
 */
const apiUpdateKnownKeptValuesOf = (write: WorkerStartApiWrite): readonly ApiUpdateKnownKeptValue[] => write.update?.knownKeptValues ?? [];

/**
 * T41R3-fix（M-1）: 同じ Run の書き込みの画面（`formPage`。前の読み取り・書き込みの段・後の照合で同じ Origin と path）で、要求が止む待ちの上限に一度
 * 届いたか。届いたら、残りの読み取りでその待ちを省く。
 */
interface ApiUpdateQuietMemory {
  quietTimedOut: boolean;
}

/** T41R3-fix（M-1）: 要求が止む待ちを省く画面の、候補の読み取りの落ち着きの指定（上限は欄の値の待ちの上限。ほかは発見と同じ）。 */
const BUSY_PAGE_CANDIDATE_SETTLE_POLICY: DiscoverySettlePolicy = Object.freeze({ ...DISCOVERY_SETTLE_POLICY, timeoutMs: API_WRITE_VALUE_QUIET_TIMEOUT_MS });
/**
 * T41R2-fix（M-1）: 応答の本文が空でなく、行の数を数えられない（上限 `MAX_API_RECORD_ID_BODY_BYTES` を超える、UTF-8 や JSON として読めない）か。空の本文
 * （204 など）は偽。本文は記録しない。例外を投げない。CC-104: 解読は本文の形の唯一の部品（`apiResponseBodyShapeOf`）。
 */
export const isUnreadableApiResponseBody = (body: Uint8Array): boolean => apiResponseBodyShapeOf(body).kind === 'UNREADABLE';

/** T41d: 更新の画面の欄の値（鍵 → 値。変える欄、保つ欄、ページが決める鍵の欄。メモリの中だけ。記録しない）。 */
export interface ApiUpdateFieldValues {
  readonly changed: Readonly<Record<string, string>>;
  readonly kept: Readonly<Record<string, string>>;
  readonly page: Readonly<Record<string, string>>;
}

/**
 * T41d: API の更新の、書き込みの段に渡す前の値と指定（前の読み取りの結果）。`response` は Guard の `recordIdOf` が書く、応答の本文の一覧の要素の数
 * （T41R-fix。一覧でなければ null）。
 */
interface ApiUpdateStage {
  readonly targetRecordId: string;
  readonly submitterIdentityDigest: string;
  readonly prior: ApiUpdateFieldValues;
  readonly keptPriorValues: readonly ApiWritePriorValue[];
  readonly pagePriorValues: readonly ApiWritePriorValue[];
  readonly response: { rowCount: number | null; bodyUnreadable: boolean };
  /** T41R3-fix: 台帳が知る保つ鍵の最後の値（`apiUpdateKnownKeptValuesOf`）。 */
  readonly knownKeptValues: readonly ApiUpdateKnownKeptValue[];
  /** T41R3-fix（M-1）: 書き込みの画面で、要求が止む待ちの上限に届いたか（同じ Run の残りの読み取りで待ちを省く）。 */
  readonly quiet: ApiUpdateQuietMemory;
}

/**
 * T41d: API の更新の結果の判定（純粋。ファイルの先頭の T41d）。状態の判定が成功でなければそのまま（ID なし）。成功で応答の本文が空の一覧なら、更新した行が
 * ないとして `NO_CONDITION_MATCHED`（結果は `UNKNOWN`。今の閉じた一覧から選んだ）。T41R-fix（設計書 8 章の「T41R の完全版」の I-2）: 要素 2 つ以上の
 * 一覧なら、2 行以上を更新した（どの行が変わったか分からない）として `MULTIPLE_CONDITIONS_MATCHED`（結果は `UNKNOWN`。今の閉じた一覧から選んだ）。
 * 応答の本文の ID が対象の ID と違えば、その ID（`actionOutcomeOf` が `RECORD_ID_MISMATCH` にする）。ほかは対象の ID（Guard が filter で対象に結んでいる）。
 * `rowCount` は応答の本文の一覧の要素の数（`apiResponseListLength`。一覧でなければ null）。
 * T41R2-fix（M-1）: 本文が空でなく読めない（`bodyUnreadable`。上限を超える、JSON でない）なら、行の数が分からないので `NO_CONDITION_MATCHED`（結果は
 * `UNKNOWN`。今の閉じた一覧から選んだ）。空の本文（204）は今のまま成功の側。
 */
export const apiUpdateResultOf = (facts: {
  readonly responseJudgement: ResponseJudgement;
  readonly targetRecordId: string;
  readonly bodyRecordId: string | null;
  readonly rowCount: number | null;
  readonly bodyUnreadable?: boolean;
}): { readonly responseJudgement: ResponseJudgement; readonly rawRecordId: string | null } => {
  if (facts.responseJudgement !== 'SUCCESS') {
    return { responseJudgement: facts.responseJudgement, rawRecordId: null };
  }
  if (facts.rowCount === 0 || facts.bodyUnreadable === true) {
    return { responseJudgement: 'NO_CONDITION_MATCHED', rawRecordId: null };
  }
  if (facts.rowCount !== null && facts.rowCount >= 2) {
    return { responseJudgement: 'MULTIPLE_CONDITIONS_MATCHED', rawRecordId: null };
  }
  return { responseJudgement: 'SUCCESS', rawRecordId: facts.bodyRecordId !== null && facts.bodyRecordId !== facts.targetRecordId ? facts.bodyRecordId : facts.targetRecordId };
};

/** 更新の後の照合の、1 つの欄の後の画面の値と、値のほかの一致の条件（form の組の hidden。ほかは真）。 */
interface UpdateFieldAfter {
  readonly value: string | null;
  readonly alsoMatched: boolean;
}

/** 更新の後の照合の、1 つの欄の比べ（`expected` は後の画面で期待する値。変えた欄は送った新しい値、保つ欄は前の値。後の画面を読めなければ `after` は null）。 */
interface UpdateFieldCheck {
  readonly fieldName: string;
  readonly expected: string | null;
  readonly after: UpdateFieldAfter | null;
}

/** 欄の一致（後の画面を読めなければ null。比べ方は `sameValue`）。 */
const updateFieldMatchedOf = (check: UpdateFieldCheck): boolean | null =>
  (check.after === null ? null : sameValue(check.after.value, check.expected) && check.after.alsoMatched);

/**
 * T41R-fix（設計書 8 章の「T41R の完全版」の M-2）: 更新の後の照合の証拠（Task 31 の `WriteUpdateEvidence`）を組み立てる唯一の部品（form の UPDATE の
 * `updateEvidenceOf` と API の更新の `apiUpdateEvidenceOf` が使う）。変えた欄（`CHANGED`）は前の値と送った新しい値（なければ空）と一致の真偽、保つ欄
 * （`KEPT`）は一致の真偽だけ（値を残さない）。順は変えた欄、保つ欄の順（呼ぶ側の順のまま）。
 */
function updateEvidenceOfChecks(
  changed: readonly (UpdateFieldCheck & { readonly previousValue: string })[],
  kept: readonly UpdateFieldCheck[],
): WriteUpdateEvidence {
  return Object.freeze({
    fields: Object.freeze([
      ...changed.map((check): WriteUpdateFieldEvidence => Object.freeze({
        fieldName: check.fieldName, role: 'CHANGED', previousValue: check.previousValue, newValue: check.expected ?? '', matched: updateFieldMatchedOf(check),
      })),
      ...kept.map((check): WriteUpdateFieldEvidence => Object.freeze({
        fieldName: check.fieldName, role: 'KEPT', previousValue: null, newValue: null, matched: updateFieldMatchedOf(check),
      })),
    ]),
  });
}

/**
 * T41d: API の更新の後の照合の証拠（純粋。Task 31 の `WriteUpdateEvidence`）。変えた欄（`CHANGED`）は前の値と送った新しい値と一致の真偽、保つ欄とページが
 * 決める鍵（`KEPT`）は一致の真偽だけ（値を残さない）。後の画面を読めなければ（`after` が null）、一致は null。比べ方は form と同じ `sameValue`。
 * T41R3-fix（設計書 8 章の「T41R3」の (2)。T41R2-fix の空の確かめを置き換えた）: 台帳が知る保つ鍵（`knownKeptValues`）の後の値が台帳の値と違えば
 * （仮の値・空を含む）、値が入る前の画面を読んだとみなし、その欄は照合できない（一致は null。結果は `UPDATE_POSTCHECK_UNDETERMINED` の側）。一覧にない
 * 保つ鍵は、今のまま前の値と照らす。
 */
export const apiUpdateEvidenceOf = (
  prior: ApiUpdateFieldValues,
  after: ApiUpdateFieldValues | null,
  values: Readonly<Record<string, string | null>>,
  knownKeptValues: readonly ApiUpdateKnownKeptValue[] = [],
): WriteUpdateEvidence => {
  const afterOf = (group: keyof ApiUpdateFieldValues, fieldName: string): UpdateFieldAfter | null => {
    const value = after === null ? null : after[group][fieldName] ?? null;
    const known = group === 'kept' ? knownKeptValues.find(({ key }) => key === fieldName) : undefined;
    if (after === null || (known !== undefined && !sameValue(value, known.value))) {
      return null;
    }
    return { value, alsoMatched: true };
  };
  return updateEvidenceOfChecks(
    Object.keys(prior.changed).map((fieldName) => ({
      fieldName, previousValue: prior.changed[fieldName] ?? '', expected: values[fieldName] ?? null, after: afterOf('changed', fieldName),
    })),
    (['kept', 'page'] as const).flatMap((group) => Object.keys(prior[group]).map((fieldName) => ({
      fieldName, expected: prior[group][fieldName] ?? null, after: afterOf(group, fieldName),
    }))),
  );
};

/** T41d: 更新の画面で読む欄（変える欄、保つ欄、ページが決める鍵の欄の順。ページが決める鍵に欄の識別がなければ null。fail-closed）。 */
const apiUpdateFieldsOf = (write: WorkerStartApiWrite): { readonly group: keyof ApiUpdateFieldValues; readonly key: string; readonly field: ApiFieldIdentity }[] | null => {
  const pageKeys = write.api.pageKeys.map(({ key, field }) => (field === undefined ? null : { group: 'page' as const, key, field }));
  if (pageKeys.some((entry) => entry === null)) {
    return null;
  }
  return [
    ...write.api.keyFields.map(({ key, field }) => ({ group: 'changed' as const, key, field })),
    ...(write.api.keptKeys ?? []).map(({ key, field }) => ({ group: 'kept' as const, key, field })),
    ...(pageKeys as { readonly group: 'page'; readonly key: string; readonly field: ApiFieldIdentity }[]),
  ];
};

/**
 * T41d: 更新の画面の欄の値を、落ち着くまで待って読む（`readApiWriteFieldValues`。読めなければ null）。T41R-fix: 落ち着きは、画面を読み込む前に作った進行中の
 * 要求の数え方（`counter`）で、要求が止んだ後に 2 回続けて同じ値（READ と同じ部品）。T41R3-fix（M-1）: 同じ Run で一度、要求が止む待ちの上限に届いた
 * 画面（`quiet.quietTimedOut`）は、その待ちを省き、間隔を置いた 2 回の読み取りの落ち着きで読む。上限に届いたら `quiet` に書く。
 */
async function readApiUpdateFieldValues(
  page: Page,
  write: WorkerStartApiWrite,
  counter: QuietSource,
  quiet: ApiUpdateQuietMemory,
): Promise<ApiUpdateFieldValues | null> {
  const fields = apiUpdateFieldsOf(write);
  if (fields === null) {
    return null;
  }
  const read = await readApiWriteFieldValues(page, fields.map(({ field }) => field), quiet.quietTimedOut ? undefined : {
    source: counter,
    onQuietTimedOut: () => {
      quiet.quietTimedOut = true;
    },
  });
  if (!read.ok) {
    return null;
  }
  const groups: Record<keyof ApiUpdateFieldValues, Record<string, string>> = { changed: {}, kept: {}, page: {} };
  fields.forEach(({ group, key }, index) => {
    groups[group][key] = read.values[index] ?? '';
  });
  return Object.freeze({ changed: Object.freeze(groups.changed), kept: Object.freeze(groups.kept), page: Object.freeze(groups.page) });
}

/** T41d: 2 つの読み取りの値が、どの欄も同じか（書き込みの段で開き直した画面の値と、前の値）。 */
const sameApiUpdateFieldValues = (left: ApiUpdateFieldValues, right: ApiUpdateFieldValues): boolean =>
  (['changed', 'kept', 'page'] as const).every((group) => {
    const keys = Object.keys(left[group]);
    return keys.length === Object.keys(right[group]).length && keys.every((key) => sameValue(left[group][key] ?? null, right[group][key] ?? null));
  });

/**
 * T41R-fix（設計書 8 章の「T41R の途中の報告」の (2)）: 前の読み取りが、値の入った画面のものか。目印を入れた欄（変える欄と保つ欄）の前の値がすべて空なら、
 * 値が入る前の画面とみなす（対象は BeakSight が登録した照合済みのレコードなので、生成した値の欄は空でないはず）。
 */
export const apiUpdatePriorFilled = (prior: ApiUpdateFieldValues): boolean =>
  [...Object.values(prior.changed), ...Object.values(prior.kept)].some((value) => value !== '');

/**
 * T41R3-fix（設計書 8 章の「T41R3」の (2)。T41R2-fix の「空でないはずの保つ鍵」の確かめを置き換えた）: 台帳が知る保つ鍵（`knownKeptValues`）のどれかの
 * 値が、台帳の値と違うか（比べ方は `sameValue`。空の値は空と比べる）。違えば、値が入る前の画面（仮の値・空）か、BeakSight の外で変わったレコードとみなす。
 * シナリオの保つ鍵として読んだ鍵だけを見る（一覧にあっても読んだ値にない鍵は比べない）。
 */
export const apiUpdateKnownKeptMismatch = (values: ApiUpdateFieldValues, knownKeptValues: readonly ApiUpdateKnownKeptValue[]): boolean =>
  knownKeptValues.some(({ key, value }) => Object.hasOwn(values.kept, key) && !sameValue(values.kept[key] ?? null, value));

/**
 * T41R-fix（同じ行の (3)）: 押す直前の読み直しの値で、押してよいか。保つ欄とページが決める鍵の欄は前の値のまま、変える欄は入れた生成した値のまま
 * （比べ方は `sameValue`）。読めなければ（null）押さない。
 */
export const apiUpdateReadyToPress = (
  prior: ApiUpdateFieldValues,
  current: ApiUpdateFieldValues | null,
  values: Readonly<Record<string, string | null>>,
): boolean => current !== null
  && (['kept', 'page'] as const).every((group) => Object.keys(prior[group]).every((key) =>
    Object.hasOwn(current[group], key) && sameValue(current[group][key] ?? null, prior[group][key] ?? null)))
  && Object.keys(prior.changed).every((key) => Object.hasOwn(current.changed, key) && sameValue(current.changed[key] ?? null, values[key] ?? null));

/** T41d: 前の値を、承認した鍵の JSON の型の値にする（Guard の照合の期待。変えられなければ null）。 */
const apiPriorValuesOf = (
  keys: readonly { readonly key: string; readonly type: ApiJsonValueType }[],
  values: Readonly<Record<string, string>>,
): readonly ApiWritePriorValue[] | null => {
  const converted: ApiWritePriorValue[] = [];
  for (const { key, type } of keys) {
    const conversion = jsonValueOf(values[key] ?? null, type);
    if (!conversion.ok) {
      return null;
    }
    converted.push(Object.freeze({ key, value: conversion.value }));
  }
  return Object.freeze(converted);
};

/**
 * T41d: API の更新の前の読み取りと後の照合（凍結した Context で対象の ID の更新の画面を 1 回読む）。画面の path を型にした識別の digest
 * （`pagePathTemplatedIdentityDigestOf`）が承認の値と同じ候補がちょうど 1 つで、その画面の path の最後の ID の区切り（`lastRecordIdLikePathSegmentIndexOf`）が
 * 対象の ID であれば、送信の要素の識別の digest（その候補の識別の digest）と、欄の値を返す。
 */
function checkApiUpdatePage(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  write: WorkerStartApiWrite,
  targetRecordId: string,
  options: GuardedPageVisitOptions,
  quiet: ApiUpdateQuietMemory,
): Promise<WritePageCheck<{ readonly submitterIdentityDigest: string; readonly values: ApiUpdateFieldValues }>> {
  const classificationPolicy = { allowedOrigins: new Set(options.authentication.approvedTestOrigins) };
  return checkWritePage(factory, pacer, write.formPage, options, async ({ page, counter }) => {
    // T41R3-fix（M-1）: 同じ Run で一度、要求が止む待ちの上限に届いた画面は、候補の読み取りの落ち着きの待ちを、欄の値の待ちの上限
    // （`API_WRITE_VALUE_QUIET_TIMEOUT_MS`）に縮める。0 にはしない: 候補の読み取りは画面を凍結するので、待たずに凍結すると値が入る前の画面を読む（確かめた）。
    const read = await readCandidatePage(page, {
      classificationPolicy, requestCounter: counter, settlePolicy: quiet.quietTimedOut ? BUSY_PAGE_CANDIDATE_SETTLE_POLICY : undefined,
    });
    // 候補の落ち着きの待ちの後も要求が止んでいなければ（開いたままの要求）、この画面の残りの読み取りで要求が止む待ちを省く。
    const quietSince = counter.quietSinceMs();
    if (quietSince === null || Date.now() - quietSince < DISCOVERY_NETWORK_QUIET_MS) {
      quiet.quietTimedOut = true;
    }
    const matching = read.candidates.filter((candidate) => write.api.templatedIdentityDigest !== undefined
      && pagePathTemplatedIdentityDigestOf(candidate) === write.api.templatedIdentityDigest);
    const [only, ...others] = matching;
    const segment = only === undefined ? null : lastRecordIdLikePathSegmentIndexOf(only.page.path);
    if (only === undefined || others.length > 0 || segment === null || only.page.path.split('/')[segment] !== targetRecordId) {
      return CANDIDATE_NOT_MATCHED;
    }
    // T41R-fix（(1)・(4)）: 前の読み取りと後の照合は、画面を読み込む前に作った数え方で、要求が止んだ後に落ち着いた値を読む。
    const values = await readApiUpdateFieldValues(page, write, counter, quiet);
    return { matched: true, value: values === null ? null : { submitterIdentityDigest: only.identityDigest, values } };
  });
}

/** T41d: API の更新の送る前の確かめ（前の読み取り）と、書き込みの段の指定（照合の期待に前の値を入れる）。 */
async function planApiUpdateStage(input: PrecheckInput, write: WorkerStartApiWrite, targetRecordId: string): Promise<WriteStagePlan> {
  // T41R3-fix（M-1）: 書き込みの画面の、要求が止む待ちの上限に届いたかの覚え（この Run の読み取りで共有する）。
  const quiet: ApiUpdateQuietMemory = { quietTimedOut: false };
  const checked = await checkApiUpdatePage(input.factory, input.pacer, write, targetRecordId, input.options, quiet);
  noticeSessionLost(input, checked.sessionLostUrl);
  const stop = (candidateDigestMatched: boolean | null, precheckDetail: PrecheckFailureDetail): WriteStagePlan =>
    ({ kind: 'STOP', facts: notSent(PRECHECK_FAILED, { violation: checked.violation, candidateDigestMatched, precheckDetail }) });
  if (checked.value === null || input.stopSignal.aborted) {
    return stop(checked.candidateMatched, pageCheckDetailOf(checked, input.stopSignal.aborted));
  }
  const { submitterIdentityDigest, values } = checked.value;
  const keptPriorValues = apiPriorValuesOf(write.api.keptKeys ?? [], values.kept);
  const pagePriorValues = apiPriorValuesOf(write.api.pageKeys, values.page);
  // 変える欄の前の値は証拠に書くので、長さの上限（`action-run.json` と同じ）を超えれば送らない。T41R-fix（(2)）: 目印を入れた欄がすべて空なら、値が入る
  // 前の画面とみなして送らない。
  // T41R3-fix（(2)）: 台帳が知る保つ鍵の値と違えば（仮の値・空・BeakSight の外での変更）、送らない。
  const knownKeptValues = apiUpdateKnownKeptValuesOf(write);
  // T44e（Task 44 の設計書 P2-4）: 送らない条件は今のまま。具体的な理由は、型に変えられない → 値が入る前 → 台帳の値と違う → 長すぎる、の順に決める。
  if (keptPriorValues === null || pagePriorValues === null) {
    return stop(true, 'PRIOR_VALUE_UNUSABLE');
  }
  if (!apiUpdatePriorFilled(values)) {
    return stop(true, 'PRIOR_VALUES_EMPTY');
  }
  if (apiUpdateKnownKeptMismatch(values, knownKeptValues)) {
    return stop(true, 'KNOWN_KEPT_VALUE_MISMATCH');
  }
  if (Object.values(values.changed).some((value) => value.length > MAX_SUBMITTED_VALUE_LENGTH)) {
    return stop(true, 'PRIOR_VALUE_UNUSABLE');
  }
  const apiUpdate: ApiUpdateStage = {
    targetRecordId, submitterIdentityDigest, prior: values, keptPriorValues, pagePriorValues, response: { rowCount: null, bodyUnreadable: false },
    knownKeptValues, quiet,
  };
  return { kind: 'STAGE', writeStageOf: (monitor) => apiWriteStageOf(write, monitor, apiUpdate), apiUpdate };
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
  /** T44e（Task 44 の設計書 P2-4）: 送らずに止めたときの具体的な理由（分かったときだけ）。 */
  readonly precheckDetail?: PrecheckFailureDetail;
}

/** T44e: 送らずに止めた書き込みの段の結果に、具体的な理由を付ける（送る・送らないは `PRECHECK_STOPPED` のまま）。 */
const precheckStopped = (precheckDetail: PrecheckFailureDetail): WriteStageResult => Object.freeze({ ...PRECHECK_STOPPED, precheckDetail });

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
  /** T41d: API の更新の前の値と指定（API の登録と form は undefined）。 */
  readonly apiUpdate?: ApiUpdateStage | undefined;
  /** T37a fix round 1: ジョブの監査の段の状態（口がなければ `null`）。押す直前に、鍵の消失と上限を確かめる。 */
  readonly auditStage: AuditStageRunState | null;
}

/**
 * T37a fix round 1（Task 37 の設計書 3.1 の「書き込みのジョブ」）: 送らずに止めるべき監査の段の事実があるか。ログインの状態の鍵がなくなった
 * （`sessionKeyLostDetailOf`）か、承認したサービスの Origin への要求の上限に届いた（`isServiceRequestLimitReached`）。判定は Run Coordinator・発見・
 * READ の確かめと同じ共通の部品。鍵の消失は、factory が Context を閉じるときに状態を読み直して知らせるので、今の書き込みの段の Context の中で消えた
 * 鍵は、押す前には見えない（前の Context までの分）。状態がなければ偽。
 */
const auditStageStopsWrite = (state: AuditStageRunState | null): boolean =>
  sessionKeyLostDetailOf(state) !== null || isServiceRequestLimitReached(state);

/**
 * 書き込みの段の本体（ファイルの先頭の 4〜6。Context を開いた後、閉じる前）。例外は呼ぶ側が受ける（送ったかは Guard の送信の報告で決める）。
 */
async function writeOnStage(input: WriteStageInput, write: WorkerStartWrite): Promise<WriteStageResult> {
  const { request, monitor, page } = input;
  const { stopSignal } = request;
  const spec = formSpecOf(write);
  const opened = await openWriteStagePage(input, write.formPage);
  if (opened !== null) {
    return opened;
  }
  // T31g-2: UPDATE は、書き込みの画面の値が前の値と同じかも確かめる（`inspectUpdateForm`）。
  const inspection = input.update === undefined ? await inspectWriteForm(page, spec) : await inspectUpdateForm(page, input.update.spec, input.update.prior);
  if (!inspection.ok || stopSignal.aborted) {
    // T44e: 更新の確かめの失敗は、書き込みの画面の値が前の値と違う（`inspectUpdateForm`）。登録は入力の前の確かめの失敗。
    return precheckStopped(stopSignal.aborted ? 'STOPPED' : input.update === undefined ? 'FORM_NOT_READY' : 'PRIOR_VALUE_CHANGED');
  }
  const filled = await fillWriteForm(page, inspection.form, write.values, monitor);
  if (!filled.ok) {
    return precheckStopped('FORM_NOT_READY');
  }
  const quiet = await submissionWindowDetailOf(input);
  if (quiet !== null) {
    return precheckStopped(quiet);
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
    const notReady = await readyToPress(input);
    if (notReady !== null) {
      return precheckStopped(notReady);
    }
    // T40R-fix-A2（Task 40 の設計書 7 章の「T40R-fix-A・B の報告」）: API と同じく、押す直前に、画面の ID の取り方で今の画面から値を読む（記録しない。押した
    // 後に同じ値か、URL の型で URL が変わっていなければ、ID として使わない）。
    const baseline = await pageRecordIdBaselineOf(page, write.verification.recordId);
    const submittedAt = request.clock();
    const submitted = await submitWriteForm(page, inspection.form, write.values);
    if (!submitted.ok && !submitted.clickAttempted) {
      return precheckStopped('FORM_NOT_READY');
    }
    const judged = await judgeResult(input, write, documentStatuses, () => postNavigationFailed, baseline);
    // T32e: 判定の時刻は、判定を終えた時点の時計（報告の `response.judgedAt`）。
    return { clicked: true, precheckFailed: false, submittedAt, judgedAt: request.clock(), ...judged };
  } finally {
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
  }
}

/**
 * 書き込みの段の中で、書き込みの画面を 1 回読む（form と API で共通。T40b-1 で取り出した）。セッションが切れた、読み込みが失敗した・4xx・5xx なら、
 * 送らずに止める結果を返す。続けてよければ null。
 */
async function openWriteStagePage(input: WriteStageInput, formPage: CandidateLocation): Promise<WriteStageResult | null> {
  const { request, pacer, page, ledger } = input;
  const { config, authentication } = request;
  await pacer.beforeNavigation();
  const navigation = await navigatePage(page, pageUrlOf(formPage), {
    timeoutMs: config.crawl.navigationTimeoutMs,
    ledger,
    allowedQueryParameters: new Set(config.crawl.allowedQueryParameters),
  });
  const lostBeforeWrite = sessionLostUrlOf(page, ledger, authentication.sessionLostPathPrefix);
  if (lostBeforeWrite !== null) {
    return { ...precheckStopped('SESSION_LOST'), sessionLostUrl: lostBeforeWrite };
  }
  // 書き込みの画面の読み込みの 4xx・5xx は、送らない。
  if (navigation.navigationOutcome !== 'OK' || isHttpStatusInRange(navigation.httpStatus, ERROR_HTTP_STATUS_RANGE)) {
    return precheckStopped('PAGE_UNAVAILABLE');
  }
  return null;
}

/**
 * 値を入れた後、`WRITE_SUBMISSION_WINDOW_SETTLE_MS` だけ待ち、送信の窓の中で承認の送信のほかの要求を止めていない（ページが入力の値を別の要求で
 * 送ろうとしていない）、止める印もないか（form と API で共通。T40b-1 で取り出した）。押してよければ null。
 * T44e（Task 44 の設計書 P2-4）: 押さないときは、具体的な理由（承認のほかの要求が出た、止める印）を返す（前は真偽だけ。確かめは同じ）。
 */
async function submissionWindowDetailOf(input: WriteStageInput): Promise<PrecheckFailureDetail | null> {
  await wait(WRITE_SUBMISSION_WINDOW_SETTLE_MS);
  if (input.monitor.unexpectedRequestCount() !== 0) {
    return 'UNEXPECTED_REQUEST';
  }
  return input.request.stopSignal.aborted ? 'STOPPED' : null;
}

/**
 * 押す直前の確かめ（form と API で共通。T40b-1 で取り出した）。押す前の最後の読み込みの間隔を守り、止める印 → 監査の段 → 送る直前の確かめ直し（IPC の
 * 往復）→ 止める印と監査の段、の順に確かめる。押してよければ真。
 * T30R-fix-1（DEF-103）: 最後の待ちの後に止める印を確かめ、送る直前の確かめ直しをしてから押す（その間に待ちと読み込みを入れない）。
 * T37a fix round 1: 押す直前（確かめ直しの前と後）に、鍵の消失と上限を確かめる（書き込みの段の読み込みで上限に届いた回を含む）。
 * T41R-fix-2（Task 41 の設計書 8 章の「T41R-fix の報告（設計者の判断）」）: 確かめ直しの前に差し込む確かめ（`beforeRecheck`。API の更新の、押す直前の欄の
 * 読み直し。待ちを含んでよい）を受ける。順は、最後の待ち → 止める印と監査の段 → `beforeRecheck` → 止める印と監査の段 → 確かめ直し → 止める印と監査の段。
 * 確かめ直しの後には待ちを入れない（DEF-103 の決まり）。省略（form と API の登録）は今までどおりの順。
 */
async function readyToPress(
  input: WriteStageInput,
  beforeRecheck?: () => Promise<PrecheckFailureDetail | null>,
): Promise<PrecheckFailureDetail | null> {
  const { request, pacer } = input;
  const { stopSignal } = request;
  // T44e（Task 44 の設計書 P2-4）: 押さないときは、具体的な理由を返す（押してよければ null。確かめの順と、押す・押さないは今のまま）。
  const stopOrAuditStage = (): PrecheckFailureDetail | null => {
    if (stopSignal.aborted) {
      return 'STOPPED';
    }
    return auditStageStopsWrite(input.auditStage) ? 'AUDIT_STAGE_STOPPED' : null;
  };
  await pacer.beforeNavigation();
  const first = stopOrAuditStage();
  if (first !== null) {
    return first;
  }
  if (beforeRecheck !== undefined) {
    const reread = await beforeRecheck();
    if (reread !== null) {
      return reread;
    }
    const afterReread = stopOrAuditStage();
    if (afterReread !== null) {
      return afterReread;
    }
  }
  const recheck = await request.recheck();
  if (!recheck.allowed) {
    return 'RECHECK_REFUSED';
  }
  return stopOrAuditStage();
}

/**
 * T40b-1: API の書き込みの段の本体（ファイルの先頭の T40b-1。Context を開いた後、閉じる前）。書き込みの画面を 1 回読み、入力の前の確かめ、値を入れて
 * 窓の中を確かめ、押す直前の確かめの後に押して、結果を判定する。例外は呼ぶ側が受ける（送ったかは Guard の送信の報告で決める）。
 */
async function apiWriteOnStage(input: WriteStageInput, write: WorkerStartApiWrite): Promise<WriteStageResult> {
  const { apiUpdate } = input;
  if (apiUpdate === undefined) {
    return apiWriteOnOpenedStage(input, write, undefined);
  }
  // T41R-fix（(1)）: 更新は、画面を読み込む前に進行中の要求の数え方を作り、欄の値の読み取りの落ち着きに使う（ページに何もしない。事象を受けるだけ）。
  const counter = new InFlightRequestCounter(input.page);
  try {
    return await apiWriteOnOpenedStage(input, write, { apiUpdate, counter });
  } finally {
    counter.dispose();
  }
}

/** T40b-1・T41d: API の書き込みの段の本体の続き（更新は前の値と、進行中の要求の数え方を受ける）。 */
async function apiWriteOnOpenedStage(
  input: WriteStageInput,
  write: WorkerStartApiWrite,
  update: { readonly apiUpdate: ApiUpdateStage; readonly counter: QuietSource } | undefined,
): Promise<WriteStageResult> {
  const { request, monitor, page } = input;
  const opened = await openWriteStagePage(input, write.formPage);
  if (opened !== null) {
    return opened;
  }
  const apiUpdate = update?.apiUpdate;
  // T41d（Task 41 の設計書 3.4 の 2）: 更新は、開き直した画面の欄の値が前の読み取りの値と同じか確かめ（違えば送らない）、送信の要素は前の読み取りで
  // 見た具体的な画面の候補の識別で探す。
  if (update !== undefined) {
    const current = await readApiUpdateFieldValues(page, write, update.counter, update.apiUpdate.quiet);
    if (current === null) {
      return precheckStopped('PAGE_UNAVAILABLE');
    }
    if (!sameApiUpdateFieldValues(current, update.apiUpdate.prior)) {
      return precheckStopped('PRIOR_VALUE_CHANGED');
    }
  }
  const spec = apiInputSpecOf(write);
  const inspection = await inspectApiWriteInput(page, apiUpdate === undefined ? spec : { ...spec, submitterIdentityDigest: apiUpdate.submitterIdentityDigest });
  if (!inspection.ok || request.stopSignal.aborted) {
    return precheckStopped(request.stopSignal.aborted ? 'STOPPED' : 'FORM_NOT_READY');
  }
  const filled = await fillApiWriteInput(page, inspection.input, monitor);
  if (!filled.ok) {
    return precheckStopped('FORM_NOT_READY');
  }
  const quiet = await submissionWindowDetailOf(input);
  if (quiet !== null) {
    return precheckStopped(quiet);
  }
  // T41R-fix（(3)）・T41R-fix-2: 更新は、押す直前の確かめの中で、送る直前の確かめ直しの前に欄を読み直し（落ち着きの待ちを含む）、保つ欄とページが決める鍵の
  // 欄が前の値のまま、変える欄が入れた生成した値のままでなければ押さない（確かめ直しの後には待ちを入れない。DEF-103）。読み直しの後にページが値を変えても、
  // 送る瞬間に Guard が前の値と照らして止める。
  // T41R3-fix（(2)）: 読み直しでも、台帳が知る保つ鍵の値と違えば押さない（前の値は台帳の値と同じと確かめてあるので、前の値との比べでも止まる。明示して
  // 確かめる）。
  const beforeRecheck = update === undefined
    ? undefined
    : async (): Promise<PrecheckFailureDetail | null> => {
      const current = await readApiUpdateFieldValues(page, write, update.counter, update.apiUpdate.quiet);
      // T44e: 押さない条件は今のまま（前の値・入れた値と違う、または台帳が知る保つ鍵の値と違う）。理由は、前の値と違う → 台帳の値と違う、の順。
      if (!apiUpdateReadyToPress(update.apiUpdate.prior, current, write.values) || current === null) {
        return 'PRIOR_VALUE_CHANGED';
      }
      return apiUpdateKnownKeptMismatch(current, update.apiUpdate.knownKeptValues) ? 'KNOWN_KEPT_VALUE_MISMATCH' : null;
    };
  const notReady = await readyToPress(input, beforeRecheck);
  if (notReady !== null) {
    return precheckStopped(notReady);
  }
  // T40R-fix-A（Task 40 の設計書 7 章の T40R の I-2）: ID を画面から取る形では、押す直前に、同じ取り方で今の画面から値を読む（記録しない。押した後に同じ値
  // なら ID として使わない）。T41d: 更新は対象の ID が決まっているので読まない。
  const source = apiUpdate === undefined ? apiRecordIdSourceOf(write) : null;
  const baseline = source?.kind === 'PAGE' ? await pageRecordIdBaselineOf(page, source.spec) : null;
  const submittedAt = request.clock();
  const submitted = await submitApiWriteInput(page, inspection.input);
  if (!submitted.ok && !submitted.clickAttempted) {
    return precheckStopped('FORM_NOT_READY');
  }
  const judged = await judgeApiResult(input, write, baseline);
  return { clicked: true, precheckFailed: false, submittedAt, judgedAt: request.clock(), ...judged };
}

/** T40R-fix-A: 押す直前の画面から、画面の ID の取り方で読んだ値と URL（メモリの中だけ。記録しない。T40R-fix-A2 から form の書き込みも使う）。 */
interface PageRecordIdBaseline {
  readonly recordId: string | null;
  readonly url: string;
}

/** T40R-fix-A: 押す直前の画面の、ID の取り方で読んだ値と URL（`recordIdOf` と同じ取り方。読めなければ値は null）。 */
async function pageRecordIdBaselineOf(page: Page, spec: ScenarioRecordIdSpec): Promise<PageRecordIdBaseline> {
  return { recordId: await recordIdOf(page, spec), url: page.url() };
}

/**
 * T40R-fix-A（T40R の I-2）: 押した後に画面から取れた値を、ID として使えるか。押す前の画面から同じ取り方で取れた値と同じなら使わない（例: 登録の画面の
 * path 自身が ID の型に当たる）。URL の型の取り方では、URL が押す前から変わっていないときも使わない。
 */
const isPageRecordIdNew = (recordId: string | null, baseline: PageRecordIdBaseline | null, spec: ScenarioRecordIdSpec, url: string): recordId is string =>
  recordId !== null && baseline !== null && recordId !== baseline.recordId && (spec.source !== 'URL_PATH_PATTERN' || url !== baseline.url);

/** 押した後の結果の判定の結果（form と API で共通）。 */
interface JudgedWriteResult {
  readonly httpStatus: number | null;
  readonly responseJudgement: ResponseJudgement | null;
  readonly rawRecordId: string | null;
  readonly sessionLostUrl: string | null;
}

/** 判定なし（送らなかった、応答がない、応答が分からない）。 */
const NOT_JUDGED: JudgedWriteResult = Object.freeze({ httpStatus: null, responseJudgement: null, rawRecordId: null, sessionLostUrl: null });

/**
 * Guard が送らなかったと決まった（送る中身の照合で止めた、Guard が Context を閉じた（違反。送っていない）、送り手が書く前に止まった（DEF-099 fix））か、
 * 送り手が書いた後に応答がなかった（届いたかは分からない。待たずに判定なしで終える）か（form と API で共通。T40b-1 で取り出した）。
 */
const submissionEndedWithoutResponse = (input: WriteStageInput): boolean => {
  const report = input.monitor.submissionReport();
  return (report.submission === 'NOT_SENT' && (payloadBlocked(input.monitor) || isPassiveRequestGuardClosed(input.context) || report.sendOutcome !== null))
    || report.sendOutcome === 'NO_RESPONSE';
};

/**
 * T40b-1: API の書き込みの、押した後の結果の判定（ファイルの先頭の T40b-1）。期限（`resultTimeoutMs`）まで、間隔ごとに確かめる。送り手が応答を受けたら、
 * 状態が範囲の外なら判定なし、ID を画面から取る形で応答をブラウザに返せなかった（Guard の `responseDeliveryCanceled`。form と同じ部品）なら
 * `RESPONSE_NOT_DELIVERED`、成功でなければその判定、成功ならセッションの切れを見てから ID を取る（画面から取るときは、押す前の画面の値（`baseline`）と
 * 違う値だけを、期限まで待つ。T40R-fix-A）。
 * ページの事象（`response`・`requestfailed`）では届いたかを決めない: Guard が送り手の応答で満たした要求には Playwright の `response` が出ず、空の本文の
 * 応答はページに届いた後にも `requestfailed`（`ERR_ABORTED`）が出る（T40b-1 の実験）。
 */
async function judgeApiResult(input: WriteStageInput, write: WorkerStartApiWrite, baseline: PageRecordIdBaseline | null): Promise<JudgedWriteResult> {
  const { request, monitor, page, ledger } = input;
  const { authentication, config } = request;
  const deadline = request.now() + (request.resultTimeoutMs ?? config.crawl.navigationTimeoutMs);
  const { apiUpdate } = input;
  // T41d: 更新は、ID を応答の本文から読む（画面からは取らない。応答をページに返せなかった印でも止めない）。
  const source = apiUpdate === undefined ? apiRecordIdSourceOf(write) : null;
  for (;;) {
    if (submissionEndedWithoutResponse(input)) {
      return NOT_JUDGED;
    }
    const report = monitor.submissionReport();
    if (report.responseReceived) {
      const { httpStatus, responseJudgement } = apiResponseFactsOf(report);
      if (httpStatus === null || responseJudgement === null) {
        return NOT_JUDGED;
      }
      const judged = (judgement: ResponseJudgement, rawRecordId: string | null = null, sessionLostUrl: string | null = null): JudgedWriteResult =>
        Object.freeze({ httpStatus, responseJudgement: judgement, rawRecordId, sessionLostUrl });
      // T40R-fix-A（T40R の I-2 の (c)）: ID を画面から取る形で、応答をページに返せなかった（Guard の `responseDeliveryCanceled`。form と同じ部品）なら、
      // 判定せず ID も取らない（`RESPONSE_NOT_DELIVERED`）。応答の本文から ID を取る形は、送り手が受けた応答で決まるので、この印では止めない。
      if (source?.kind === 'PAGE' && monitor.snapshot().responseDeliveryCanceled) {
        return judged('RESPONSE_NOT_DELIVERED');
      }
      if (responseJudgement !== 'SUCCESS') {
        return judged(responseJudgement);
      }
      const lost = sessionLostUrlOf(page, ledger, authentication.sessionLostPathPrefix);
      if (lost !== null) {
        return judged('SESSION_LOST', null, lost);
      }
      if (apiUpdate !== undefined) {
        // T41d（Task 41 の設計書 3.4 の 3）: 空の一覧は更新した行がない、2 行以上の一覧は 2 行以上を更新した（T41R-fix）、本文の ID が対象と違えばその ID、
        // ほかは対象の ID（`apiUpdateResultOf`）。
        const result = apiUpdateResultOf({
          responseJudgement, targetRecordId: apiUpdate.targetRecordId, bodyRecordId: monitor.apiWriteRecordId(), rowCount: apiUpdate.response.rowCount,
          bodyUnreadable: apiUpdate.response.bodyUnreadable,
        });
        return judged(result.responseJudgement, result.rawRecordId);
      }
      if (source?.kind !== 'PAGE') {
        return judged('SUCCESS', source === null ? null : monitor.apiWriteRecordId());
      }
      // T40R-fix-A（T40R の I-2）: 押す前の画面から同じ取り方で取れた値（URL の型では、押す前から変わっていない URL）は、ID として使わない。期限まで待ち、
      // 新しい値が取れなければ ID なし（`RECORD_ID_NOT_FOUND`）。
      const fromPage = await recordIdOf(page, source.spec);
      const usable = !page.isClosed() && isPageRecordIdNew(fromPage, baseline, source.spec, page.url()) ? fromPage : null;
      if (usable !== null || request.now() >= deadline || page.isClosed()) {
        return judged('SUCCESS', usable);
      }
    } else if (request.now() >= deadline || page.isClosed()) {
      return NOT_JUDGED;
    }
    await wait(WRITE_RESULT_POLL_INTERVAL_MS);
  }
}

/** 押した後の結果の判定（ファイルの先頭の 5・6）。期限（`resultTimeoutMs`）まで、間隔ごとに確かめる。 */
async function judgeResult(
  input: WriteStageInput,
  write: WorkerStartWrite,
  documentStatuses: readonly number[],
  postNavigationFailed: () => boolean,
  baseline: PageRecordIdBaseline,
): Promise<JudgedWriteResult> {
  const { request, monitor, page, ledger } = input;
  const { authentication, config } = request;
  const deadline = request.now() + (request.resultTimeoutMs ?? config.crawl.navigationTimeoutMs);
  const finalStatus = (): number | null => documentStatuses.at(-1) ?? monitor.submissionReport().responseStatus;
  const decided = (responseJudgement: ResponseJudgement | null, rawRecordId: string | null = null, sessionLostUrl: string | null = null) => {
    const report = monitor.submissionReport();
    return { httpStatus: report.responseReceived ? finalStatus() : null, responseJudgement: report.responseReceived ? responseJudgement : null, rawRecordId,
      sessionLostUrl };
  };
  for (;;) {
    // 送らなかったと決まった、または送り手が書いた後に応答がなかった（DEF-099 fix）。判定なしで終える。
    if (submissionEndedWithoutResponse(input)) {
      return decided(null);
    }
    const report = monitor.submissionReport();
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
        // T40R-fix-A2: 押す前の画面から同じ取り方で取れた値（URL の型では、押す前から変わっていない URL）は、ID として使わない（`RECORD_ID_NOT_FOUND`）。
        const spec = write.verification.recordId;
        const fromPage = await recordIdOf(page, spec);
        return decided('SUCCESS', !page.isClosed() && isPageRecordIdNew(fromPage, baseline, spec, page.url()) ? fromPage : null);
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

/** T32e: 画面の候補の確かめの結果（候補が一致しなかった、または一致して、その画面で読んだ値）。 */
type CandidateCheck<TValue> = { readonly matched: false } | { readonly matched: true; readonly value: TValue };

/** T32e: 承認に縛った候補が画面になかった（ちょうど 1 つでなかった）。 */
const CANDIDATE_NOT_MATCHED: { readonly matched: false } = Object.freeze({ matched: false });

/** 送る前の画面の確かめの結果（form・UPDATE・API で共通。T40b-1 で 1 つにした）。 */
interface WritePageCheck<TValue> {
  /** 候補が一致し、違反がなく、その画面で読めた値（どれかが外れれば null。送らない）。 */
  readonly value: TValue | null;
  readonly violation: boolean;
  readonly sessionLostUrl: string | null;
  /** T32e: 承認に縛った候補が、ちょうど 1 つあったか（画面を読めず確かめまで進まなければ null）。 */
  readonly candidateMatched: boolean | null;
}

/**
 * 送る前の画面の確かめの共通の部分（ファイルの先頭の 3 の a・b。T40b-1 で、form・UPDATE・API の 3 つの確かめから取り出した）。読む URL を事前の判定
 * （`isReadUrlAllowed`）に通し、凍結した Context で画面を 1 回読み（`visitGuardedPage`）、読み込みが成功して 4xx・5xx でなければ、呼ぶ側の確かめ
 * （`check`。候補の一致と、その画面で読む値）を行う。
 */
async function checkWritePage<TValue>(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  formPage: CandidateLocation,
  options: GuardedPageVisitOptions,
  check: (view: GuardedPageView) => Promise<CandidateCheck<TValue | null>>,
): Promise<WritePageCheck<TValue>> {
  const formUrl = pageUrlOf(formPage);
  if (!isReadUrlAllowed(formUrl, options.config, options.authentication)) {
    return { value: null, violation: false, sessionLostUrl: null, candidateMatched: null };
  }
  const visit = await visitGuardedPage(factory, pacer, formUrl, options, async (view): Promise<CandidateCheck<TValue | null> | null> => {
    if (view.navigation.navigationOutcome !== 'OK' || isHttpStatusInRange(view.navigation.httpStatus, ERROR_HTTP_STATUS_RANGE)) {
      return null;
    }
    return check(view);
  });
  if (visit.kind === 'SESSION_LOST') {
    return { value: null, violation: visit.violation, sessionLostUrl: visit.url, candidateMatched: null };
  }
  const checked = visit.kind === 'VISITED' ? visit.value : null;
  return {
    value: checked !== null && checked.matched && !visit.violation ? checked.value : null,
    violation: visit.violation,
    sessionLostUrl: null,
    candidateMatched: checked === null ? null : checked.matched,
  };
}

/**
 * 送る前の確かめ（ファイルの先頭の 3 の a・b）。承認に縛った候補の識別と規則の 2 つの digest が同じ候補がちょうど 1 つなら、同じ画面で、値を照らす
 * hidden・readonly・見えない欄の値を読む（T31R-fix-1（C-1）。記録しない。T31R2-fix-1（C-1）: null の値は、チェック・選択のない見えない checkbox・
 * radio・select（送られない））。
 */
function checkFormPage(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  write: WorkerStartWrite,
  options: GuardedPageVisitOptions,
): Promise<WritePageCheck<Readonly<Record<string, string | null>>>> {
  const classificationPolicy = { allowedOrigins: new Set(options.authentication.approvedTestOrigins) };
  return checkWritePage(factory, pacer, write.formPage, options, async ({ page, counter }) => {
    const read = await readCandidatePage(page, { classificationPolicy, requestCounter: counter });
    const matching = read.candidates.filter((candidate) => candidate.identityDigest === write.candidate.identityDigest);
    const [only, ...others] = matching;
    if (only === undefined || others.length > 0 || only.ruleDigest !== write.candidate.ruleDigest) {
      return CANDIDATE_NOT_MATCHED;
    }
    const passthrough = await readWritePassthroughValues(page, formSpecOf(write));
    return { matched: true, value: passthrough.ok ? passthrough.values : null };
  });
}

/**
 * T31g-2: 更新の画面の確かめと読み取り（ファイルの先頭の T31g-2 の「更新の前の読み取り」「更新の後の照合」）。凍結した Context で具体的な更新の画面を
 * 1 回読み、型にした識別の digest と規則の digest が同じ候補がちょうど 1 つあれば、同じ画面で値を読む。どれかが外れれば `value` は null。
 */
function checkUpdateFormPage(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  write: WorkerStartWrite,
  update: WorkerStartWriteUpdate,
  options: GuardedPageVisitOptions,
): Promise<WritePageCheck<UpdateFormValues>> {
  const classificationPolicy = { allowedOrigins: new Set(options.authentication.approvedTestOrigins) };
  return checkWritePage(factory, pacer, write.formPage, options, async ({ page, counter }) => {
    const read = await readCandidatePage(page, { classificationPolicy, requestCounter: counter });
    const matching = read.candidates.filter((candidate) => candidate.ruleDigest === write.candidate.ruleDigest
      && templatedIdentityDigestForRecordIdOf(candidate, update.targetRecordId) === update.templatedIdentityDigest);
    if (matching.length !== 1) {
      return CANDIDATE_NOT_MATCHED;
    }
    const values = await readUpdateFormValues(page, updateSpecOf(write, update));
    return { matched: true, value: values.ok ? values.values : null };
  });
}

/**
 * T40b-1: API の送る前の画面の確かめ（ファイルの先頭の T40b-1）。凍結した Context で書き込みの画面を 1 回読み、`inspectApiWriteInput` で、送信の要素
 * （`submitterIdentityDigest`）がちょうど 1 つあり、鍵の欄がそろうことを、値を入れずに確かめる（外れたら候補が一致しなかったとする）。
 */
function checkApiFormPage(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  write: WorkerStartApiWrite,
  options: GuardedPageVisitOptions,
): Promise<WritePageCheck<true>> {
  return checkWritePage(factory, pacer, write.formPage, options, async ({ page }) => {
    const inspection = await inspectApiWriteInput(page, apiInputSpecOf(write));
    return inspection.ok ? { matched: true, value: true } : CANDIDATE_NOT_MATCHED;
  });
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
  /** 欄の後の値（組の名前の欄は、組の hidden の値も前の値と同じときだけ一致。状態の名前の欄は組を見ない）。 */
  const fieldAfterOf = (name: string): UpdateFieldAfter | null =>
    (after === null ? null : { value: after.fields[name] ?? null, alsoMatched: pairKept(name, after) });
  const stateAfterOf = (name: string): UpdateFieldAfter | null =>
    (after === null ? null : { value: after.stateHiddenValues[name] ?? null, alsoMatched: true });
  return updateEvidenceOfChecks(
    update.changedFieldNames.map((fieldName) => ({
      fieldName, previousValue: prior.fields[fieldName] ?? '', expected: values[fieldName] ?? null, after: fieldAfterOf(fieldName),
    })),
    [
      ...update.keptFieldNames.map((fieldName) => ({ fieldName, expected: prior.fields[fieldName] ?? null, after: fieldAfterOf(fieldName) })),
      ...Object.keys(prior.stateHiddenValues).map((fieldName) => ({
        fieldName, expected: prior.stateHiddenValues[fieldName] ?? null, after: stateAfterOf(fieldName),
      })),
    ],
  );
}

/** 送信の報告の状態（1 回だけ送る。書き込みの段に入ったか）。 */
interface SubmissionReporting {
  reported: boolean;
  stageEntered: boolean;
}

/** 送る前の確かめで使うもの（PREFLIGHT の後）。 */
interface PrecheckInput {
  readonly factory: BrowserContextFactory;
  readonly pacer: NavigationPacer;
  readonly options: GuardedPageVisitOptions;
  readonly observer: WriteCreateRunObserver;
  readonly stopSignal: AbortSignal;
}

/**
 * 送る前の確かめの結果（T40b-1 で送り方ごとに分けた）: 書き込みの段の指定を作る口（Guard の照合の期待。部品は呼ぶ側が作る）と、UPDATE の前の値
 * （UPDATE だけ）か、送らずに止めた事実。
 */
type WriteStagePlan =
  | {
    readonly kind: 'STAGE';
    readonly writeStageOf: (monitor: WriteStageMonitor) => GuardWriteStage;
    readonly updateStage?: UpdateStage | undefined;
    /** T41d: API の更新の前の値と指定（API の更新だけ）。 */
    readonly apiUpdate?: ApiUpdateStage | undefined;
  }
  | { readonly kind: 'STOP'; readonly facts: WriteFacts };

/** 確かめの途中で分かったセッションの切れを、観測の口に伝える（伏せ字を通す）。 */
const noticeSessionLost = (input: PrecheckInput, url: string | null): void => {
  if (url !== null) {
    input.observer.onSessionLost(redactUrlSecrets(url));
  }
};

/**
 * form の送る前の確かめ（ファイルの先頭の 3。CREATE は画面の確かめ、UPDATE は更新の前の読み取り）と、Guard の照合の期待（CREATE は `writePayloadFieldsOf`、
 * UPDATE は `updatePayloadFieldsOf`。保つ欄・状態の欄・組は前の値）。
 */
async function planFormWriteStage(input: PrecheckInput, write: WorkerStartWrite): Promise<WriteStagePlan> {
  const { factory, pacer, options, stopSignal } = input;
  const spec = formSpecOf(write);
  if (write.update === undefined) {
    const formPage = await checkFormPage(factory, pacer, write, options);
    noticeSessionLost(input, formPage.sessionLostUrl);
    const created = formPage.value === null ? null : payloadExpectationOf(write, spec, formPage.value);
    if (stopSignal.aborted || created === null) {
      // T44e: 画面を読めた後に照合の期待を作れなければ、入力の前の確かめの失敗。
      const precheckDetail = formPage.value !== null && !stopSignal.aborted ? 'FORM_NOT_READY' : pageCheckDetailOf(formPage, stopSignal.aborted);
      return {
        kind: 'STOP',
        facts: notSent(PRECHECK_FAILED, { violation: formPage.violation, candidateDigestMatched: formPage.candidateMatched, precheckDetail }),
      };
    }
    return { kind: 'STAGE', writeStageOf: (monitor) => ({ expectation: created, monitor }) };
  }
  // T31g-2: 更新の前の読み取り（ファイルの先頭の T31g-2）と、照合の期待（保つ欄・状態の欄・組は前の値）。
  const prior = await checkUpdateFormPage(factory, pacer, write, write.update, options);
  noticeSessionLost(input, prior.sessionLostUrl);
  if (prior.value === null || stopSignal.aborted || !priorValuesRecordable(write.update, prior.value)) {
    // T44e: 前の値を読めた後に止めるのは、前の値が長すぎる（記録に使えない）とき。
    const precheckDetail = prior.value !== null && !stopSignal.aborted ? 'PRIOR_VALUE_UNUSABLE' : pageCheckDetailOf(prior, stopSignal.aborted);
    return { kind: 'STOP', facts: notSent(PRECHECK_FAILED, { violation: prior.violation, candidateDigestMatched: prior.candidateMatched, precheckDetail }) };
  }
  const updateStage: UpdateStage = { spec: updateSpecOf(write, write.update), prior: prior.value };
  const fields = updatePayloadFieldsOf(updateStage.spec, updateStage.prior, write.values);
  if (!fields.ok) {
    return { kind: 'STOP', facts: notSent(PRECHECK_FAILED, { candidateDigestMatched: true, precheckDetail: 'PRIOR_VALUE_UNUSABLE' }) };
  }
  const expectation: WritePayloadExpectation = { request: { origin: write.request.origin, path: write.request.path, enctype: spec.enctype }, ...fields.fields };
  return { kind: 'STAGE', writeStageOf: (monitor) => ({ expectation, monitor }), updateStage };
}

/** T40b-1: API の送る前の確かめ（`checkApiFormPage`）と、書き込みの段の指定（`apiWriteStageOf`）。T41d: 更新は前の読み取り（`planApiUpdateStage`）。 */
async function planApiWriteStage(input: PrecheckInput, write: WorkerStartApiWrite): Promise<WriteStagePlan> {
  const targetRecordId = apiUpdateTargetOf(write);
  if (targetRecordId !== null) {
    return planApiUpdateStage(input, write, targetRecordId);
  }
  const checked = await checkApiFormPage(input.factory, input.pacer, write, input.options);
  noticeSessionLost(input, checked.sessionLostUrl);
  if (checked.value === null || input.stopSignal.aborted) {
    return {
      kind: 'STOP',
      facts: notSent(PRECHECK_FAILED, {
        violation: checked.violation, candidateDigestMatched: checked.candidateMatched, precheckDetail: pageCheckDetailOf(checked, input.stopSignal.aborted),
      }),
    };
  }
  return { kind: 'STAGE', writeStageOf: (monitor) => apiWriteStageOf(write, monitor) };
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
  // T35R2-fix（T35R2 の C-1）: 監査の段の口があれば、Run と同じ部品で作った上限の部品も渡す。T37a（Task 37 の設計書 3.1）: 書き込みのジョブは、Task 39
  // まで登録した読み取りの手続きの呼び出しを通さない（`NONE`）。T37a fix round 1: 作った状態で、書き込みの段を開く前と押す直前に、鍵の消失と上限を
  // 確かめ、当たれば送らずに「送っていない」で終える。
  const { factoryOptions, state: auditStage } = jobContextFactoryOptions(authentication, now, 'NONE');
  const preflight = await runPreflight({
    config,
    launchBrowser: request.launchBrowser,
    createSafetyLedger: () => new SafetyLedger(),
    outputDirectory,
    contextFactoryOptions: {
      ...factoryOptions,
      navigationPacer: pacer,
      ...(request.writeSubmissionCertificates === undefined ? {} : { writeSubmissionCertificates: request.writeSubmissionCertificates }),
    },
  });
  if (!preflight.ok) {
    return report({ ...notSent(PRECHECK_FAILED, { precheckDetail: 'PREFLIGHT_FAILED' }), preflightFailed: true });
  }
  const { browser, factory } = preflight;
  try {
    const options: GuardedPageVisitOptions = { config, allowedQueryParameters: new Set(config.crawl.allowedQueryParameters), authentication };
    if (stopSignal.aborted) {
      return report(notSent(PRECHECK_FAILED, { precheckDetail: 'STOPPED' }));
    }
    const precheck: PrecheckInput = { factory, pacer, options, observer, stopSignal };
    // T40b-1: 送る前の確かめと書き込みの段の指定は、送り方で分ける（API は `checkApiFormPage`、form は画面の確かめか更新の前の読み取り）。
    const plan = isWorkerStartApiWrite(write) ? await planApiWriteStage(precheck, write) : await planFormWriteStage(precheck, write);
    if (plan.kind === 'STOP') {
      return report(plan.facts);
    }
    // T37a fix round 1: 画面の確かめ（と更新の前の読み取り）の後に、鍵の消失と上限を確かめる（当たれば、書き込みの段を開かずに送らない）。
    if (auditStageStopsWrite(auditStage)) {
      return report(notSent(PRECHECK_FAILED, { candidateDigestMatched: true, precheckDetail: 'AUDIT_STAGE_STOPPED' }));
    }
    // 書き込みの段（Guard の照合の期待を付けた Context）。閉じた後に、Guard の送信の報告で送ったかを決める。
    const monitor = new WriteStageMonitor();
    let context: BrowserContext;
    try {
      context = await factory.createWriteStageContext(config.viewports.primaryDesktop, plan.writeStageOf(monitor));
    } catch {
      return report(notSent(PRECHECK_FAILED, { candidateDigestMatched: true, precheckDetail: 'PAGE_UNAVAILABLE' }));
    }
    const ledger = factory.getSafetyLedger(context);
    reporting.stageEntered = true;
    let stage: WriteStageResult = PRECHECK_STOPPED;
    try {
      const page = await factory.createPassivePage(context);
      const stageInput: WriteStageInput = {
        request, factory, pacer, monitor, context, page, ledger, update: plan.updateStage, apiUpdate: plan.apiUpdate, auditStage,
      };
      stage = isWorkerStartApiWrite(write) ? await apiWriteOnStage(stageInput, write) : await writeOnStage(stageInput, write);
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
      // T44e: `PRECHECK_FAILED` なら、書き込みの段が返した具体的な理由（例外で終わったときはない）。`PAYLOAD_MISMATCH` には付けない（`notSent` が決める）。
      return report(notSent(payloadBlocked(monitor) ? PAYLOAD_MISMATCH : PRECHECK_FAILED, {
        violation, candidateDigestMatched: true, guard, precheckDetail: stage.precheckDetail,
      }));
    }
    // Guard が承認の POST を通した（送った）。応答がなければ判定なし（予約は `UNKNOWN`）。T40b-1: API の段が判定まで進まなかった回の状態も、100〜599 の
    // 外なら記録しない（`apiResponseFactsOf`）。
    const unjudgedStatus = isWorkerStartApiWrite(write) ? apiResponseFactsOf(guardReport).httpStatus : guardReport.responseStatus;
    const httpStatus = guardReport.responseReceived ? stage.httpStatus ?? unjudgedStatus : null;
    const responseJudgement = httpStatus === null ? null : stage.responseJudgement ?? 'NO_CONDITION_MATCHED';
    /** 送った回の事実（照合の READ の証拠と UPDATE の証拠と違反は、段ごとに決める）。 */
    const sentFacts = (readEvidence: ReadCheckExecutedEvidence | null, updateEvidence: WriteUpdateEvidence | null, sentViolation: boolean): WriteFacts =>
      Object.freeze({
        submission: 'SENT', blockReason: null, httpStatus, responseJudgement, rawRecordId: stage.rawRecordId, readEvidence, submittedAt: stage.submittedAt,
        violation: sentViolation, updateEvidence, candidateDigestMatched: true, judgedAt: responseJudgement === null ? null : stage.judgedAt, guard,
        // T40b-1: Guard の照合が返したページが決める鍵の値（form は null）。
        apiPageKeyValues: monitor.apiWritePageKeyValues(),
      });
    // 送信の報告（送った。報告に使うのは送信の状態と止めた理由だけ）。
    report(sentFacts(null, null, violation));
    if (isWorkerStartApiWrite(write)) {
      // T40b-2: 照合の READ（form と同じ条件: 成功で違反がなく、ID が使える形のときだけ）。`{id}` に ID を入れた画面に、保存の時と同じ画面の path の確かめと
      // 事前の判定をかけ直してから 1 回だけ読む（`verifyRecordPageReadCheck`）。ID がない・使えないときは行わない（`RECORD_ID_NOT_FOUND`・`RECORD_ID_UNSAFE`）。
      const recordId = stage.rawRecordId;
      if (responseJudgement !== 'SUCCESS' || violation || !isUsableRecordId(recordId)) {
        return sentFacts(null, null, violation);
      }
      // T41d（Task 41 の設計書 3.4 の 4）: 更新の後の照合。応答の ID が対象の ID のときだけ、前の読み取りと同じ確かめで対象の更新の画面を 1 回読み、変えた欄は
      // 新しい値、保つ欄とページが決める鍵の欄は前の値かを照らす（form の UPDATE と同じく、一致しない欄があれば照合の READ は行わない）。
      const { apiUpdate } = plan;
      let apiUpdateEvidence: WriteUpdateEvidence | null = null;
      if (apiUpdate !== undefined) {
        if (recordId !== apiUpdate.targetRecordId) {
          return sentFacts(null, null, violation);
        }
        const after = await checkApiUpdatePage(factory, pacer, write, apiUpdate.targetRecordId, options, apiUpdate.quiet);
        if (after.sessionLostUrl !== null) {
          observer.onSessionLost(redactUrlSecrets(after.sessionLostUrl));
        }
        apiUpdateEvidence = apiUpdateEvidenceOf(apiUpdate.prior, after.value?.values ?? null, write.values, apiUpdate.knownKeptValues);
        if (after.violation || fieldsMatchedOf(apiUpdateEvidence) === false) {
          return sentFacts(null, apiUpdateEvidence, violation || after.violation);
        }
      }
      const verified = await verifyRecordPageReadCheck(factory, pacer, write.readVerification, recordId, { ...options, auditStage });
      if (verified.sessionLostUrl !== null) {
        observer.onSessionLost(redactUrlSecrets(verified.sessionLostUrl));
      }
      return sentFacts(verified.evidence, apiUpdateEvidence, verified.violation);
    }
    // T31g-2: UPDATE の更新の後の照合（成功のときだけ。一致しない欄があれば、照合の READ は行わない（結果は `UNKNOWN` に決まる））。
    let updateEvidence: WriteUpdateEvidence | null = null;
    const { updateStage } = plan;
    if (responseJudgement === 'SUCCESS' && !violation && write.update !== undefined && updateStage !== undefined) {
      const after = await checkUpdateFormPage(factory, pacer, write, write.update, options);
      if (after.sessionLostUrl !== null) {
        observer.onSessionLost(redactUrlSecrets(after.sessionLostUrl));
      }
      updateEvidence = updateEvidenceOf(write.update, updateStage.prior, after.value, write.values);
      if (after.violation || fieldsMatchedOf(updateEvidence) === false) {
        return sentFacts(null, updateEvidence, violation || after.violation);
      }
    }
    if (responseJudgement === 'SUCCESS' && !violation) {
      // T37R-fix-B（T37R の M-3。Task 37 の設計書 8 章の T37R の行）: 照合の READ にも、判定できない決まりを当てる（監査の段の状態を渡す。読み込みの間に
      // 断った要求・401・止めた要求があれば `UNDETERMINED`。鍵の消失はセッションの切れ）。書き込みの結果は、今の「照合できない」の写しのまま。
      const verified = await verifyReadCheck(factory, pacer, write.readVerification, { ...options, auditStage });
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

/** 更新の対象の ID（form の UPDATE と、T41d の API の更新。登録は null）。 */
const updateTargetRecordIdOf = (write: WorkerStartWrite | WorkerStartApiWrite): string | null =>
  (isWorkerStartApiWrite(write) ? apiUpdateTargetOf(write) : write.update?.targetRecordId ?? null);

/** 照合の READ を実行しなかった印の状態。 */
const READ_NOT_EXECUTED_STATE = 'NOT_EXECUTED' satisfies ActionEvidenceDocument['readVerification']['state'];

/** form の書き込みの送り方（T40c。記録と報告の版 1.1 の `transport`）。 */
const FORM_TRANSPORT = FORM_SCENARIO_TRANSPORT;

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
 * 書き込みの記録（`action-run.json`。T40c から版 1.1。form は送り方 `FORM`・API の要約なし、T40b-1 から API は送り方 `API`・API の要約・成否の条件なし）と、
 * 書き込みの報告の証拠（`action-evidence.json`。同じく 1.1）と承認の要約（`approval-summary.json`）を、
 * 同じ事実から 1 回だけ組み立てる（T32e。Task 32 の設計書 4.1 の「1 回だけ組み立てる」）。重なる値（ID、送った値と時刻、応答、登録の ID、UPDATE の
 * 証拠、照合の READ、結果と理由、時刻）は、ここで 1 回だけ求めて両方に入れる。
 * - 送らなかった回（`NOT_SENT`）の報告は、送った値を `{}`、送信先と送信の時刻と応答を null、照合の READ を実行しなかった印にする（報告の対象は
 *   終わりまで進んだ回すべて。ユーザーの判断 7）。`action-run.json` の送った値は、今までどおり生成した値（親の送る前の記録と同じ）。
 * - 人の値（UPDATE の変えた欄の前の値、照合の READ の `observedValue`）は入れ、`containsHumanEnteredValues` を真にする（ユーザーの判断 6）。
 * - 承認の要約は、`START` の承認の要約の事実に、版の印・ジョブ・Run を足すだけ（照らさない。承認の判断は親）。
 */
export function writeRunDocumentsOf(input: {
  readonly jobId: string;
  readonly write: WorkerStartWrite | WorkerStartApiWrite;
  readonly runId: RunId;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly facts: WriteFacts;
  readonly outcome: ActionOutcome;
}): WriteRunDocuments {
  const { jobId, write, runId, facts, outcome } = input;
  const timeOf = (date: Date): string => formatCompactUtcTimestamp(date, WRITE_CREATE_TIME_SUBJECT);
  const sent = facts.submission !== 'NOT_SENT';
  const identity = {
    jobId, runId, profileId: write.profileId, scenarioId: write.scenarioId, scenarioRevision: write.scenarioRevision,
  };
  const submittedValues = Object.fromEntries(Object.entries(write.values).flatMap(([name, value]) => (value === null ? [] : [[name, value]])));
  const blockReason = sent ? null : facts.blockReason;
  const submittedAt = facts.submittedAt === null ? null : timeOf(facts.submittedAt);
  const startedAt = timeOf(input.startedAt);
  const finishedAt = timeOf(input.finishedAt);
  const targetRecordId = updateTargetRecordIdOf(write);
  const update: ActionRunUpdate | undefined = targetRecordId === null
    ? undefined
    : { targetRecordId, updateEvidence: facts.updateEvidence ?? null };
  const readVerification = readVerificationOf(facts);
  // T40b-1: 版 1.1 の送り方ごとの項目（1 回だけ求めて両方の文書に入れる）。API は、成否の条件なし、API の要約（ページが決める鍵の値は、照合まで進んだ
  // 送った回だけ）、送信先は API の path。form は今どおり。
  const transport: ScenarioTransport = isWorkerStartApiWrite(write) ? WORKER_API_WRITE_TRANSPORT : FORM_TRANSPORT;
  const api = isWorkerStartApiWrite(write) ? actionApiSummaryOf(write.api, sent ? facts.apiPageKeyValues ?? null : null) : null;
  const resultConditions = isWorkerStartApiWrite(write)
    ? null
    : { successCondition: write.verification.successCondition, inputErrorCondition: write.verification.inputErrorCondition };
  const actionPath = isWorkerStartApiWrite(write) ? write.api.request.pathShape : write.request.path;
  const actionRun: ActionRunDocument = {
    schemaVersion: ACTION_RUN_SCHEMA_VERSION,
    ...identity,
    grantId: write.grantId,
    seedRecord: write.seedRecord,
    submittedValues,
    resultConditions,
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
    // T40c: 版 1.1 の送り方と API の要約（form の書き込みは `FORM` で要約なし）。T40b-1: API の書き込みは `API` と要約。
    transport,
    api,
    // T44e（Task 44 の設計書 P2-4）: 送らずに止めた具体的な理由（`PRECHECK_FAILED` のときで、分かったときだけ。任意の項目なので版は上げない）。
    ...(blockReason === PRECHECK_FAILED && facts.precheckDetail !== undefined ? { precheckDetail: facts.precheckDetail } : {}),
  };
  const evidence: ActionEvidenceDocument = {
    schemaVersion: ACTION_EVIDENCE_SCHEMA_VERSION,
    ...identity,
    kind: write.approvalFacts.scenario.kind,
    containsHumanEnteredValues: containsHumanEnteredValuesOf(facts),
    precheck: { candidateDigestMatched: facts.candidateDigestMatched, blockReason },
    submission: sent
      ? { state: facts.submission, submittedValues, actionPath, submittedAt }
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
    transport,
    api,
  };
  const approvalSummary: ApprovalSummaryDocument = {
    ...write.approvalFacts,
    schemaVersion: APPROVAL_SUMMARY_SCHEMA_VERSION,
    jobId,
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
    // T31g-2: UPDATE は、対象の ID と更新の後の照合の結果も渡す（締めの `scenario-store.ts` と同じ判定）。T41d: API の更新も同じ。
    const targetRecordId = updateTargetRecordIdOf(request.write);
    const outcome = actionOutcomeOf(facts.submission === 'NOT_SENT'
      ? { submission: 'NOT_SENT', blockReason: facts.blockReason ?? PRECHECK_FAILED }
      : facts.submission === 'UNKNOWN'
        ? { submission: 'UNKNOWN' }
        : { submission: 'SENT', responseJudgement: facts.responseJudgement, recordId: facts.rawRecordId,
          readVerification: readVerification?.result ?? null,
          ...(targetRecordId === null
            ? {}
            : { update: { targetRecordId, fieldsMatched: fieldsMatchedOf(facts.updateEvidence ?? null) } }) });
    const documents = writeRunDocumentsOf({ jobId: request.jobId, write: request.write, runId, startedAt, finishedAt: request.clock(), facts, outcome });
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

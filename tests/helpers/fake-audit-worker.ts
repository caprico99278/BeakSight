/**
 * テストだけの偽のワーカー（T24e。ジョブの管理の、契約の検証と見張りを確かめる）。一時のフォルダに、Node の組み込みだけを使う `.mjs` を書く
 * （ジョブの管理が `fork` する。TypeScript の読み替えが要らない）。T44-UIFIX: 書き込みのバンドルだけは、本物の部品（`src/core/action-bundle-bytes.ts`
 * などの TypeScript のソース）を、Node の型の除去で直接読み込んで組み立てる（`.js` の指定子は、`module.registerHooks` の resolve で同じ名前の
 * `.ts` に読み替える。偽のワーカーの process の中だけ。フックの本文は `typescript-source-hook.ts`）。
 * - 契約の版と Run の ID は、親のテストが `src/` の値を埋め込む（偽のワーカーの中に値を書き写さない）。
 * - 受けたメッセージは、1 行 1 件の JSON でファイルに書く（親が、`START` の値と、止める要求を確かめる）。
 * - 動き（`FakeWorkerMode`）:
 *   - `hold`: `READY` と合図を送る。`START` で `RUN_STARTED` と `PROGRESS` を送り、待つ。`STOP` で `FINISHED`（PARTIAL）を送って
 *     終了コード 2、`force` の `STOP` で終了コード 5。
 *   - `finish`: `hold` と同じに始め、`START` の後に `FINISHED`（COMPLETE）を送って終了コード 0。
 *   - `fail`: `START` の後に `FAILED`（`CONFIG_ERROR`）を送って終了コード 4。
 *   - `silent`: `READY` を送らずに待つ。
 *   - `no-heartbeat`: `READY` を送るが、合図を送らない。`START` で `RUN_STARTED` を送り、待つ。
 *   - `ignore-stop`: `hold` と同じだが、`STOP` を受けても何もしない。
 *   - `malformed`: `START` の後に `RUN_STARTED` と、形の違う `PROGRESS`（負の数）を送り、待つ。
 *   - `out-of-order`: `READY` の直後（`START` の前）に `RUN_STARTED` を送り、待つ。
 *   - `mismatched-directory`: `START` の後に、Run の ID と違う名前の Run のディレクトリの `RUN_STARTED` を送り、待つ（T24h-1 の M1）。
 *   - `finished-other-run`: `START` の後に `RUN_STARTED` を送り、別の Run の ID の `FINISHED` を送って待つ（T24h-1 の M1）。
 *   - `auth-session-lost`（T25d）: `START` の後に `AUTH_STATE`（`AWAITING_LOGIN`、`AUTHENTICATED`）、`RUN_STARTED`、`PROGRESS`、`AUTH_STATE`
 *     （`SESSION_LOST`。止まったページの URL は `sessionLostUrl`）、`FINISHED`（PARTIAL）を送って終了コード 2。
 *   - `auth-timeout`（T25d）: `START` の後に `AUTH_STATE`（`AWAITING_LOGIN`、`LOGIN_TIMEOUT`）と `FAILED`（`LOGIN_TIMEOUT`）を送って終了コード 1。
 *   - `auth-early-session-lost`（T25d）: `START` の後に、`RUN_STARTED` の前の `AUTH_STATE`（`SESSION_LOST`）を送り、待つ（順の違い）。
 *   - `auth-awaiting-summary`（T34R-fix-a）: `START` の後に、止める要求を受けていないのに、数と一覧つきの `AUTH_STATE`（`AWAITING_LOGIN`）を送り、
 *     待つ（止める印で終わったログインの段だけが送る形。違反）。
 *   - `auth-stop-before-start-summary`（T34R2-fix の M-3）: `READY` と合図を `readyDelayMs` だけ遅らせて送る（親が `START` の前に止める要求を受ける
 *     ため）。`START` を受けずに `STOP` を受けたら、数と一覧つきの `AUTH_STATE`（`AWAITING_LOGIN`）を送り、待つ（`START` を送っていないジョブ。違反）。
 *   - `auth-timeout-login-stage`（T34R2-fix の M-4）: `START` の後に `AUTH_STATE`（`AWAITING_LOGIN`）と、`loginStage` の項目（`scriptLogin`・
 *     `blockedRequests`）つきの `AUTH_STATE`（`LOGIN_TIMEOUT`）と、`FAILED`（`LOGIN_TIMEOUT`）を送って終了コード 1。
 *   - `auth-manual-confirm`（ML-a）: `START` の後に `AUTH_STATE`（`AWAITING_LOGIN`）を送って待つ。`LOGIN_CONFIRMED` を受けたら、`loginStage` の項目
 *     （`passedRequests`・`loginObservation`）つきの `AUTH_STATE`（`AUTHENTICATED`）と `RUN_STARTED` を送り、待つ（止める要求で PARTIAL で終える）。
 *   - `auto-login-success`（T26d-2）: `START` の後に `AUTH_STATE`（`AUTHENTICATED`、成功の結果）を送る。`LOGIN_CHECK` なら終了コード 0 で終える
 *     （`FINISHED` を送らない）。`AUDIT` なら `finish` と同じに続ける。
 *   - `auto-login-failure`（T26d-2）: `START` の後に `AUTH_STATE`（`AUTOMATED_LOGIN_FAILED`、結果は `autoLoginReport`）と、結果を理由にした
 *     `FAILED` を送って終了コード 1。
 *   - `auto-login-crash`（T26d-2）: `START` の後に、何も送らずに終了コード 1 で終える（ログインの途中でワーカーが落ちた）。
 *   - `auto-login-wait`（T26d-2）: `START` の後に何も送らずに待つ（`STOP` で終了コード 5）。
 *   - `auto-login-no-report`（T26d-2）: `START` の後に、結果のない `AUTH_STATE`（`AUTHENTICATED`）を送り、待つ（自動ログインのジョブの違反）。
 *   - `auto-login-run-started`（T26d-2）: `START` の後に、`RUN_STARTED` を送り、待つ（ログインの検証は Run を作らない。違反）。
 *   - `discovery`（T27d）: `START` の後に `AUTH_STATE`（`AUTHENTICATED`）と `RUN_STARTED` を送り、`discovery.json`（`discovery.documentText` の
 *     `__JOB_ID__` を `START` のジョブの ID に置き換えたもの。`null` なら書かない）を `<discovery.outputDirectory>/<Run の ID>/` に書いて、`FINISHED`（件数の要約は `discovery.summary`。`null` なら付けない。
 *     Run の状態は `discovery.runStatus`）を送り、終了コード 0 で終える。
 *   - `discovery-crash`（T27d）: `START` の後に `AUTH_STATE`（`AUTHENTICATED`）と `RUN_STARTED` を送り、`discovery.json` を書いてから、`FINISHED` を
 *     送らずに終了コード 1 で終える（巡回の途中でワーカーが落ちた）。
 *   - `read-check`（T27e）: `START` の後に `AUTH_STATE`（`AUTHENTICATED`）と `RUN_STARTED` を送り、`START` の定義の一覧から `read-evidence.json` を
 *     組み立てて書き、`FINISHED`（件数の要約つき）を送って終了コード 0 で終える（値は `readCheck`）。
 *   - `write`（T30e）: `START` の後に `AUTH_STATE`（`AUTHENTICATED`）と `RUN_STARTED` を送り、`write.recheck` の回数だけ `WRITE_RECHECK_REQUEST` を
 *     送る（0 なら送らずに続ける）。最初の結果を受けたら（または送らないとき）、許されなければ `write.onReject`（`report` なら `NOT_SENT` の報告）の後に
 *     待つ（`STOP` で終わる）。許されれば、`write.submission` の報告（null なら送らない）、`action-run.json`（`write.actionRunText`。null なら書かない）
 *     を `<write.outputDirectory>/<Run の ID>/` に書き、`write.end`（`finish`: `FINISHED`（COMPLETE）で終了コード 0、`crash`: 終了コード 1、`wait`:
 *     待つ）。T31f: 更新の書き込み（`WRITE_UPDATE`）も同じ動き。`action-run.json` の印 `"__START_TARGET_RECORD_ID__"` は、`START` の UPDATE の指定の
 *     対象の ID に置き換える（UPDATE の指定がなければ null）。T31h-2: 印 `"__START_JOB_ID__"`・`"__START_GRANT_ID__"` は、`START` のジョブの id と
 *     書き込みの指定の許可の id に置き換える（画面から始めたジョブの id と許可の id は、テストが前もって知らないため）。T32e: `write.report` が
 *     あれば、`action-run.json` の前に、書き込みの報告の `approval-summary.json`（`START` の承認の要約の事実から）と `action-evidence.json` も書く。
 *   - `entry-check`（T43c）: `START` の後に `RUN_STARTED` を送り、`entry-check.json` を書いて、`FINISHED`（件数の要約つき）を送って終了コード 0 で
 *     終える（値は `entryCheck`）。
 *   - `chain`（FM2d）: まとめて実行の `START` の後に、ログインの段の `AUTH_STATE`（`AUTHENTICATED`。`loginStage` の項目つき）を 1 回送り、段ごとに
 *     `RUN_STARTED` と `FINISHED`（未完了の理由のコードつき）を送る。途中の段の後は `NEXT_STAGE`（次の段を行う）・`CHAIN_END`（終える）を待つ。値は `chain`。
 * 親が止める（kill する）まで待つ動きは、その間ずっと動いている（親との IPC がある間）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTION_BUNDLE_MANIFEST_FILE_NAME } from '../../src/core/action-bundle-bytes.js';
import {
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
  ACTION_RUN_ARTIFACT_FILE_NAME,
  APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
  DISCOVERY_ARTIFACT_FILE_NAME,
  ENTRY_CHECK_ARTIFACT_FILE_NAME,
  READ_EVIDENCE_ARTIFACT_FILE_NAME,
} from '../../src/core/artifact-layout.js';
import { ACTION_REPORT_TEXT } from '../../src/presentation/messages.js';
import { TYPESCRIPT_SOURCE_RESOLVE_HOOK } from './typescript-source-hook.js';

/** T44-UIFIX: 偽のワーカーが書く成果物のファイルの名前（`src/` の値。偽のワーカーの中に名前を書き写さない）。 */
const ARTIFACT_FILE_NAMES = Object.freeze({
  discovery: DISCOVERY_ARTIFACT_FILE_NAME,
  entryCheck: ENTRY_CHECK_ARTIFACT_FILE_NAME,
  readEvidence: READ_EVIDENCE_ARTIFACT_FILE_NAME,
  actionRun: ACTION_RUN_ARTIFACT_FILE_NAME,
  actionEvidence: ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  approvalSummary: APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
  actionReport: ACTION_REPORT_ARTIFACT_FILE_NAME,
});

/**
 * T32R2 M-2: 偽のワーカーが本物と同じバイト列の書き込みのバンドルを作るための `src/` の値（偽のワーカーの中に値を書き写さない）。
 * T44-UIFIX: 目録の項目・書式（T44f で字下げなしに変わったのに、偽のワーカーが字下げ 2 文字を書き写したままで `BUNDLE_MISMATCH` になった）・ZIP の
 * 組み立ては写さず、偽のワーカーが本物の部品のソースを読み込む（そのモジュールの URL）。
 */
const ACTION_BUNDLE_VALUES = Object.freeze({
  manifestFileName: ACTION_BUNDLE_MANIFEST_FILE_NAME,
  humanEnteredValuesNotice: ACTION_REPORT_TEXT.bundleHumanEnteredValuesNotice,
  /** バンドルのバイト列の唯一の組み立て（`actionBundleBytesOf`）。 */
  bundleBytesModuleUrl: new URL('../../src/core/action-bundle-bytes.ts', import.meta.url).href,
  /** 目録を食い違わせるとき（`tamper: 'manifest'`）に組み立て直す、artifact の JSON の書式（`artifactJsonBytes`）と決定論の ZIP（`deterministicZipOf`）。 */
  artifactJsonModuleUrl: new URL('../../src/core/artifact-json.ts', import.meta.url).href,
  deterministicZipModuleUrl: new URL('../../src/core/deterministic-zip.ts', import.meta.url).href,
});

export const FAKE_WORKER_MODES = Object.freeze([
  'hold', 'finish', 'fail', 'silent', 'no-heartbeat', 'ignore-stop', 'malformed', 'out-of-order', 'mismatched-directory', 'finished-other-run',
  'auth-session-lost', 'auth-timeout', 'auth-early-session-lost', 'auth-awaiting-summary', 'auth-stop-before-start-summary', 'auth-timeout-login-stage',
  'auth-manual-confirm',
  'auto-login-success', 'auto-login-failure', 'auto-login-crash', 'auto-login-wait', 'auto-login-no-report', 'auto-login-run-started',
  'discovery', 'discovery-crash',
  'read-check',
  'write',
  'entry-check',
  'chain',
] as const);
export type FakeWorkerMode = (typeof FAKE_WORKER_MODES)[number];

/** 偽のワーカーに埋め込む値。 */
export interface FakeWorkerValues {
  readonly protocolVersion: string;
  readonly runId: string;
  /** 別の Run の ID（契約の形は正しいが、このジョブの Run ではない）。 */
  readonly otherRunId: string;
  /** 合図の間隔（ms）。 */
  readonly heartbeatIntervalMs: number;
  /** 止める要求の結果の終了コード（PARTIAL と、強制の止め方）と、完了と失敗の終了コード。 */
  readonly exitCodes: {
    readonly complete: number;
    readonly partial: number;
    readonly interrupted: number;
    readonly configError: number;
    /** ログインの段の失敗の終了コード（T25d の `auth-timeout`。省略すると 1）。 */
    readonly failure?: number;
  };
  /** `auth-session-lost` の止まったページの URL（T25d。省略すると `http://127.0.0.1/`）。 */
  readonly sessionLostUrl?: string;
  /** DEF-138: `auth-session-lost` の `SESSION_LOST` に載せるセッションの切れの証拠（省略すると載せない）。 */
  readonly sessionLoss?: Readonly<Record<string, unknown>>;
  /** `auth-stop-before-start-summary` の、`READY` と合図を遅らせる時間（ms。T34R2-fix。省略すると 0）。 */
  readonly readyDelayMs?: number;
  /** `auth-timeout-login-stage` の、`LOGIN_TIMEOUT` に付ける項目（`scriptLogin`・`blockedRequests`。T34R2-fix。省略すると付けない）。 */
  readonly loginStage?: Readonly<Record<string, unknown>>;
  /** `auto-login-failure` の結果（T26d-2。`AUTH_STATE` の `automatedLogin` の形。省略すると、送った後の `INVALID_CREDENTIALS`）。 */
  readonly autoLoginReport?: Readonly<Record<string, unknown>>;
  /** `discovery`・`discovery-crash` の値（T27d）。 */
  readonly discovery?: {
    /** 出力先（絶対パス）。Run のディレクトリは、その下の Run の ID の名前。 */
    readonly outputDirectory: string;
    /** 書く `discovery.json` の中身（`null` なら書かない）。 */
    readonly documentText: string | null;
    /** `FINISHED` の件数の要約（`null` なら付けない）。 */
    readonly summary: Readonly<Record<string, unknown>> | null;
    readonly runStatus: string;
  };
  /**
   * `read-check` の値（T27e）。`START` の定義の一覧から `read-evidence.json` を組み立てて `<outputDirectory>/<Run の ID>/` に書き（`document` が
   * `missing` なら書かない、`broken` なら JSON でない中身、`other-job` ならジョブの ID を変える）、`delayMs` 待ってから、`FINISHED`（件数の要約。
   * `summary` が `null` なら付けない。省略すると、書いた文書の件数）を送り、終了コード 0 で終える。定義ごとの結果は `results`（足りない分は `MATCHED`）。
   */
  readonly readCheck?: {
    readonly outputDirectory: string;
    readonly results: readonly string[];
    readonly document?: 'valid' | 'missing' | 'broken' | 'other-job';
    readonly summary?: Readonly<Record<string, unknown>> | null;
    readonly delayMs?: number;
    /** T37a: 書く文書の監査の段の数（省略は書かない。件数の要約を省略したときは、要約にも同じ値を載せる）。 */
    readonly authentication?: Readonly<Record<string, unknown>>;
  };
  /**
   * `entry-check` の値（T43c）。`START` の後に `RUN_STARTED` を送り（ログインの段はない）、`entry-check.json`（`documentText` の `__JOB_ID__` を
   * `START` のジョブの ID に置き換えたもの。`null` なら書かない）を `<outputDirectory>/<Run の ID>/` に書いて、`FINISHED`（件数の要約は `summary`。
   * `null` なら付けない。Run の状態は `runStatus`）を送り、終了コード 0 で終える。
   */
  readonly entryCheck?: {
    readonly outputDirectory: string;
    readonly documentText: string | null;
    readonly summary: Readonly<Record<string, unknown>> | null;
    readonly runStatus: string;
  };
  /** `write` の値（T30e）。 */
  readonly write?: {
    readonly outputDirectory: string;
    /** 送る確かめ直しの依頼の回数（0〜2）。 */
    readonly recheck: number;
    /** 許されなかったときの動き（`report`: `NOT_SENT` の報告を送って待つ、`wait`: 何も送らずに待つ）。 */
    readonly onReject: 'report' | 'wait';
    /** 送信の報告（null なら送らない）。 */
    readonly submission: { readonly submission: string; readonly blockReason: string | null } | null;
    /** 書く `action-run.json` の中身（null なら書かない）。 */
    readonly actionRunText: string | null;
    /**
     * T41g: 更新の書き込みの START（`write.update` を持つ）に書く `action-run.json` の中身（省略すると `actionRunText`）。1 つの入口で、登録のジョブと続けて
     * 始まる更新のジョブの両方に答えるため。
     */
    readonly actionRunTextForUpdate?: string;
    /**
     * T32e: 書き込みの報告の 2 つの JSON も書く（省略か null なら書かない）。`approval-summary.json` は、`START` の `write.approvalFacts` に版の印
     * （`approvalSummarySchemaVersion`）・ジョブ・Run を足したもの。`action-evidence.json` は `actionEvidenceText` の印を `action-run.json` と同じく
     * 置き換えたもの（null なら書かない）。
     */
    readonly report?: {
      readonly approvalSummarySchemaVersion: string;
      readonly actionEvidenceText: string | null;
      /** T32g: 承認の要約の事実を上書きする項目（START と違う要約を作る）。 */
      readonly approvalFactsOverride?: Readonly<Record<string, unknown>> | null;
      /** T32g: 書く `action-report.html` の中身（省略か null なら書かない）。 */
      readonly reportHtml?: string | null;
      /**
       * T32g: 書き込みのバンドル（`name` の名前。中身は書いたファイルと `action-run.json` のバイト列、目録はその sha256）。`tamper`: `manifest` は
       * 目録の sha256 を違う値に、`disk` はバンドルの後に `action-report.html` を書き換える。
       * T32R2 M-2: 親が組み立て直してバイト列で照らすので、本物の組み立てと同じバイト列にする。T44-UIFIX: 本物の部品（`actionBundleBytesOf`）で
       * 組み立てる（目録の項目と順・JSON の書式・ZIP を写さない）。`fflateUrl`（fflate のモジュールの URL）は、`tamper: 'manifest'` で本物の
       * バンドルを開くときだけ使う。4 つのファイルのどれかを書かないときは、バンドルも書かない（親の確かめは、バンドルを見る前に `REPORT_MISSING`）。
       */
      readonly bundle?: { readonly name: string; readonly fflateUrl: string; readonly tamper?: 'manifest' | 'disk' } | null;
    } | null;
    readonly end: 'finish' | 'crash' | 'wait';
  };
  /**
   * FM2d: `chain` の値。段の Run の ID（`runIds` の順）、段ごとの Run の状態（`runStatuses`。省略は `COMPLETE`）と未完了の理由のコード（`reasonCodes`。省略は空）、
   * `STOP` まで待つ段（`holdStage`。0 から）、各段の `RUN_STARTED` から `FINISHED` までの待ち（`finishDelayMs`）。発見の段の成果物は `discovery`（印
   * `__JOB_ID__`・`__RUN_ID__` を置き換える）、READ の段の成果物は `readCheck` の値で書く。
   */
  readonly chain?: {
    readonly runIds: readonly string[];
    readonly runStatuses?: readonly string[];
    readonly reasonCodes?: readonly (readonly string[])[];
    readonly holdStage?: number;
    readonly finishDelayMs?: number;
  };
}

const SCRIPT = String.raw`
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// T44-UIFIX: 本物の部品の TypeScript のソースを読み込めるよう、解決できない相対の ".js" の指定子を、同じ名前の ".ts" に読み替える。
__TYPESCRIPT_SOURCE_RESOLVE_HOOK__
const VALUES = __VALUES__;
const ACTION_BUNDLE = __ACTION_BUNDLE__;
const FILES = __ARTIFACT_FILES__;
const MODE = __MODE__;
const LOG = __LOG__;
const P = VALUES.protocolVersion;
const send = (message, after) => { if (process.connected) { process.send(message, after); } else if (after) { after(); } };
const exitAfter = (message, code) => send(message, () => process.exit(code));
const progress = { pagesFinished: 1, pagesDiscovered: 2, maxPages: 10, elapsedMs: 5, navigationCount: 1, pacingWaitMs: 0,
  requests: { allowedOrigins: { count: 1, peakPerMinute: 1 }, otherOrigins: { count: 0, peakPerMinute: 0 }, servedFromCache: 0, withheldOtherOrigins: 0 },
  recentPerMinute: { allowedOrigins: 1, otherOrigins: 0 } };
const runStarted = { protocol: P, type: 'RUN_STARTED', runId: VALUES.runId, runDirectory: VALUES.runId, resumeDecision: { kind: 'NEW_RUN', completedPages: null } };
const finished = (runStatus, exitCode) => ({ protocol: P, type: 'FINISHED', outcome: { kind: 'RAN', exitCode, runId: VALUES.runId, runDirectory: VALUES.runId, runStatus } });
setInterval(() => undefined, 1000);
const announce = () => {
  if (MODE !== 'silent') {
    send({ protocol: P, type: 'READY' });
  }
  if (MODE === 'out-of-order') {
    send(runStarted);
  }
  if (MODE !== 'silent' && MODE !== 'no-heartbeat') {
    setInterval(() => send({ protocol: P, type: 'HEARTBEAT' }), VALUES.heartbeatIntervalMs);
  }
};
if (MODE === 'auth-stop-before-start-summary') {
  setTimeout(announce, VALUES.readyDelayMs ?? 0);
} else {
  announce();
}
const loginStageBlockedByReason = {
  TOKEN_REQUEST_OVER_LIMIT: 0, TOKEN_REQUEST_NOT_SCRIPT: 0, TOKEN_REQUEST_QUERY_MISMATCH: 0,
  SIDE_REQUEST_OVER_LIMIT: 0, SIDE_REQUEST_NOT_SCRIPT: 0, UNREGISTERED_NON_READ: 0,
};
const loginStageCounts = { tokenRequestsAllowed: 0, sideRequestsAllowed: [], serviceOriginReads: 0, blockedByReason: loginStageBlockedByReason };
// T27e: START の定義の一覧から read-evidence.json を組み立てて書き、FINISHED の件数の要約を返す（read-check と chain の READ の段が共用する）。
const writeReadEvidence = (jobId, readChecks, runId) => {
  const readCheck = VALUES.readCheck;
  const evaluated = new Set(['MATCHED', 'NOT_MATCHED', 'UNDETERMINED']);
  const details = { READ_BLOCKED_BY_POLICY: 'REQUEST_POLICY', READ_CANDIDATE_DRIFTED: 'CANDIDATE_NOT_FOUND', READ_CANDIDATE_NOT_READ: 'CANDIDATE_NOT_READ' };
  const checks = (readChecks ?? []).map((check, index) => {
    const result = readCheck.results[index] ?? 'MATCHED';
    return {
      readCheckId: check.readCheckId,
      readCheckRevision: check.readCheckRevision,
      // T37d: 版 1.2 の対象の種類と、候補の識別の digest か画面の path。
      ...(typeof check.definition.targetPagePath === 'string'
        ? { targetKind: 'PAGE', targetPagePath: check.definition.targetPagePath }
        : { targetKind: 'CANDIDATE', targetIdentityDigest: check.definition.targetIdentityDigest }),
      state: 'EXECUTED',
      result,
      detail: evaluated.has(result) ? 'EXPECTATIONS_EVALUATED' : details[result],
      url: null,
      httpStatus: null,
      blockedRequests: 0,
      structure: null,
      expectations: [],
    };
  });
  const kind = readCheck.document ?? 'valid';
  const document = {
    schemaVersion: 'read-evidence-schema/1.2',
    jobId: kind === 'other-job' ? jobId + '-other' : jobId,
    runId,
    startedAt: '20261011000000',
    finishedAt: '20261011000100',
    runStatus: 'COMPLETE',
    endReason: 'COMPLETED',
    checks,
    ...(readCheck.authentication === undefined ? {} : { authentication: readCheck.authentication }),
  };
  if (kind !== 'missing') {
    mkdirSync(join(readCheck.outputDirectory, runId), { recursive: true });
    writeFileSync(join(readCheck.outputDirectory, runId, FILES.readEvidence),kind === 'broken' ? '{"schemaVersion":' : JSON.stringify(document), 'utf8');
  }
  return readCheck.summary === undefined
    ? { checks: checks.length, executed: checks.length, ...(readCheck.authentication === undefined ? {} : { authentication: readCheck.authentication }) }
    : readCheck.summary;
};
// FM2d: まとめて実行（chain）。段ごとに RUN_STARTED と FINISHED（理由のコードつき）を送り、途中の段の後は NEXT_STAGE・CHAIN_END を待つ。
const chainState = { stages: [], index: 0, exitCode: 0, holding: null };
const chainFinish = (kind, jobId, readChecks, runId, runStatus, codes) => {
  const exitCode = runStatus === 'COMPLETE' ? VALUES.exitCodes.complete : VALUES.exitCodes.partial;
  chainState.exitCode = exitCode;
  let extra = {};
  if (kind === 'DISCOVERY') {
    const discovery = VALUES.discovery;
    mkdirSync(join(discovery.outputDirectory, runId), { recursive: true });
    writeFileSync(join(discovery.outputDirectory, runId, FILES.discovery),
      discovery.documentText.split('__JOB_ID__').join(jobId).split('__RUN_ID__').join(runId), 'utf8');
    extra = { discovery: discovery.summary };
  } else if (kind === 'READ_CHECK') {
    extra = { readCheck: writeReadEvidence(jobId, readChecks, runId) };
  }
  const message = { protocol: P, type: 'FINISHED', outcome: { kind: 'RAN', exitCode, runId, runDirectory: runId, runStatus }, ...extra, incompleteReasonCodes: codes };
  if (chainState.index >= chainState.stages.length - 1) {
    exitAfter(message, exitCode);
  } else {
    send(message);
  }
};
const chainRun = (kind, jobId, readChecks) => {
  const chain = VALUES.chain;
  const index = chainState.index;
  const runId = chain.runIds[index];
  send({ ...runStarted, runId, runDirectory: runId });
  if (chain.holdStage === index) {
    chainState.holding = { kind, jobId, readChecks, runId };
    return;
  }
  setTimeout(() => chainFinish(kind, jobId, readChecks, runId, chain.runStatuses?.[index] ?? 'COMPLETE', chain.reasonCodes?.[index] ?? []), chain.finishDelayMs ?? 0);
};
process.on('message', (message) => {
  appendFileSync(LOG, JSON.stringify(message) + '\n');
  if (message && message.type === 'START') {
    if (MODE === 'malformed') {
      send(runStarted);
      send({ protocol: P, type: 'PROGRESS', report: { ...progress, pagesFinished: -1 } });
      return;
    }
    if (MODE === 'mismatched-directory') {
      send({ ...runStarted, runDirectory: VALUES.otherRunId });
      return;
    }
    if (MODE === 'finished-other-run') {
      send(runStarted);
      send({ protocol: P, type: 'FINISHED', outcome: { kind: 'RAN', exitCode: VALUES.exitCodes.complete, runId: VALUES.otherRunId, runDirectory: VALUES.otherRunId, runStatus: 'COMPLETE' } });
      return;
    }
    const authState = (state, sessionLostUrl = null) => ({ protocol: P, type: 'AUTH_STATE', state, sessionLostUrl });
    if (MODE === 'auth-session-lost') {
      send(authState('AWAITING_LOGIN'));
      send(authState('AUTHENTICATED'));
      send(runStarted);
      send({ protocol: P, type: 'PROGRESS', report: progress });
      send({ ...authState('SESSION_LOST', VALUES.sessionLostUrl ?? 'http://127.0.0.1/'), ...(VALUES.sessionLoss === undefined ? {} : { sessionLoss: VALUES.sessionLoss }) });
      exitAfter(finished('PARTIAL', VALUES.exitCodes.partial), VALUES.exitCodes.partial);
      return;
    }
    if (MODE === 'auth-timeout') {
      send(authState('AWAITING_LOGIN'));
      send(authState('LOGIN_TIMEOUT'));
      exitAfter({ protocol: P, type: 'FAILED', reason: 'LOGIN_TIMEOUT', detail: 'fake login timeout' }, VALUES.exitCodes.failure ?? 1);
      return;
    }
    if (MODE === 'auth-early-session-lost') {
      send(authState('SESSION_LOST', 'http://127.0.0.1/'));
      return;
    }
    if (MODE === 'auth-timeout-login-stage') {
      send(authState('AWAITING_LOGIN'));
      send({ ...authState('LOGIN_TIMEOUT'), ...(VALUES.loginStage ?? {}) });
      exitAfter({ protocol: P, type: 'FAILED', reason: 'LOGIN_TIMEOUT', detail: 'fake login timeout' }, VALUES.exitCodes.failure ?? 1);
      return;
    }
    if (MODE === 'auth-manual-confirm') {
      send(authState('AWAITING_LOGIN'));
      return;
    }
    if (MODE === 'auth-awaiting-summary') {
      const blockedByReason = {
        TOKEN_REQUEST_OVER_LIMIT: 0, TOKEN_REQUEST_NOT_SCRIPT: 0, TOKEN_REQUEST_QUERY_MISMATCH: 0,
        SIDE_REQUEST_OVER_LIMIT: 0, SIDE_REQUEST_NOT_SCRIPT: 0, UNREGISTERED_NON_READ: 0,
      };
      send({ ...authState('AWAITING_LOGIN'), scriptLogin: { tokenRequestsAllowed: 0, sideRequestsAllowed: [], serviceOriginReads: 0, blockedByReason } });
      return;
    }
    const succeeded = { result: 'SUCCEEDED', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null };
    if (MODE === 'auto-login-success') {
      if (message.jobKind === 'LOGIN_CHECK') {
        exitAfter({ ...authState('AUTHENTICATED'), automatedLogin: succeeded }, VALUES.exitCodes.complete);
        return;
      }
      send({ ...authState('AUTHENTICATED'), automatedLogin: succeeded });
      send(runStarted);
      exitAfter(finished('COMPLETE', VALUES.exitCodes.complete), VALUES.exitCodes.complete);
      return;
    }
    if (MODE === 'auto-login-failure') {
      const report = VALUES.autoLoginReport ?? { result: 'INVALID_CREDENTIALS', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null };
      send({ ...authState('AUTOMATED_LOGIN_FAILED'), automatedLogin: report });
      exitAfter({ protocol: P, type: 'FAILED', reason: report.result, detail: 'fake automated login failure' }, VALUES.exitCodes.failure ?? 1);
      return;
    }
    if (MODE === 'auto-login-crash') {
      process.exit(VALUES.exitCodes.failure ?? 1);
    }
    if (MODE === 'auto-login-wait') {
      return;
    }
    if (MODE === 'auto-login-no-report') {
      send(authState('AUTHENTICATED'));
      return;
    }
    if (MODE === 'auto-login-run-started') {
      send(runStarted);
      return;
    }
    if (MODE === 'discovery' || MODE === 'discovery-crash') {
      const discovery = VALUES.discovery;
      send(authState('AUTHENTICATED'));
      send(runStarted);
      if (discovery.documentText !== null) {
        mkdirSync(join(discovery.outputDirectory, VALUES.runId), { recursive: true });
        writeFileSync(join(discovery.outputDirectory, VALUES.runId, FILES.discovery),discovery.documentText.split('__JOB_ID__').join(message.jobId), 'utf8');
      }
      if (MODE === 'discovery-crash') {
        setTimeout(() => process.exit(VALUES.exitCodes.failure ?? 1), 50);
        return;
      }
      const exitCode = discovery.runStatus === 'COMPLETE' ? VALUES.exitCodes.complete : VALUES.exitCodes.partial;
      const done = finished(discovery.runStatus, exitCode);
      exitAfter(discovery.summary === null ? done : { ...done, discovery: discovery.summary }, exitCode);
      return;
    }
    if (MODE === 'entry-check') {
      const entryCheck = VALUES.entryCheck;
      send(runStarted);
      if (entryCheck.documentText !== null) {
        mkdirSync(join(entryCheck.outputDirectory, VALUES.runId), { recursive: true });
        writeFileSync(join(entryCheck.outputDirectory, VALUES.runId, FILES.entryCheck),entryCheck.documentText.split('__JOB_ID__').join(message.jobId), 'utf8');
      }
      const done = finished(entryCheck.runStatus, VALUES.exitCodes.complete);
      exitAfter(entryCheck.summary === null ? done : { ...done, entryCheck: entryCheck.summary }, VALUES.exitCodes.complete);
      return;
    }
    if (MODE === 'chain') {
      // FM2d: まとめて実行の最初の段（ログインの段の知らせは 1 回だけ）。
      chainState.stages = message.chain.stages;
      send({ ...authState('AUTHENTICATED'), ...(VALUES.loginStage ?? {}) });
      chainRun(message.chain.stages[0], message.jobId, undefined);
      return;
    }
    if (MODE === 'read-check') {
      const readCheck = VALUES.readCheck;
      send(authState('AUTHENTICATED'));
      send(runStarted);
      const summary = writeReadEvidence(message.jobId, message.readChecks, VALUES.runId);
      const done = finished('COMPLETE', VALUES.exitCodes.complete);
      setTimeout(() => exitAfter(summary === null ? done : { ...done, readCheck: summary }, VALUES.exitCodes.complete), readCheck.delayMs ?? 0);
      return;
    }
    if (MODE === 'write') {
      const write = VALUES.write;
      send(authState('AUTHENTICATED'));
      send(runStarted);
      globalThis.afterRecheck = async (result) => {
        if (result !== null && !result.allowed) {
          if (write.onReject === 'report') {
            send({ protocol: P, type: 'WRITE_SUBMISSION', submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED' });
          }
          return;
        }
        if (write.submission !== null) {
          send({ protocol: P, type: 'WRITE_SUBMISSION', ...write.submission });
        }
        // T30f: 印 "__START_SEED_RECORD__" は、START の seed の記録に置き換える（本物のワーカーと同じく、受けた値をそのまま書く）。
        // T31f: 印 "__START_TARGET_RECORD_ID__" は、START の UPDATE の指定の対象の ID に置き換える（ワーカーは許可から写した値をそのまま書く）。
        // T31h-2: 印 "__START_JOB_ID__"・"__START_GRANT_ID__" は、START のジョブの id と許可の id に置き換える。
        // T32e: 書き込みの報告の証拠（write.report.actionEvidenceText）にも、同じ印を同じ値に置き換える。
        // T41e-2: 印 "__START_VALUE:<鍵>__" は、START の生成した値（write.values のその鍵の値）に置き換える（API の更新の記録の送った値と前後の差分）。
        const fillStartValues = (text) => Object.entries(message.write.values ?? {})
          .reduce((filled, [key, value]) => filled.split(JSON.stringify('__START_VALUE:' + key + '__')).join(JSON.stringify(value)), text);
        const fillStartMarks = (text) => fillStartValues(text).split('"__START_SEED_RECORD__"').join(JSON.stringify(message.write.seedRecord))
          .split('"__START_TARGET_RECORD_ID__"').join(JSON.stringify(message.write.update?.targetRecordId ?? null))
          .split('"__START_JOB_ID__"').join(JSON.stringify(message.jobId))
          .split('"__START_GRANT_ID__"').join(JSON.stringify(message.write.grantId))
          // T40R2-fix: 印 "__START_VALUES__" は、START の送る値（値を入れない null の欄を除く）に置き換える（生成した値が実行のたびに変わるため）。
          .split('"__START_VALUES__"').join(JSON.stringify(Object.fromEntries(Object.entries(message.write.values).filter(([, value]) => value !== null))));
        const runDirectory = join(write.outputDirectory, VALUES.runId);
        // T32e: 書き込みの報告の 2 つの JSON（本物のワーカーと同じく、action-run.json より先に書く）。承認の要約は、START の承認の要約の事実に、
        // 版の印・ジョブ・Run を足したもの（受けた値をそのまま書く。T32g: approvalFactsOverride の項目で上書きできる）。
        // T32g: HTML の報告（reportHtml）と書き込みのバンドル（bundle。中身は書いたファイルのバイト列と、その sha256 の目録。tamper で目録の sha256 か
        // ディスクのファイルを変える）も書ける。
        if (write.report) {
          mkdirSync(runDirectory, { recursive: true });
          const files = [];
          const put = (name, text) => {
            writeFileSync(join(runDirectory, name), text, 'utf8');
            files.push([name, Buffer.from(text, 'utf8')]);
          };
          put(FILES.approvalSummary, JSON.stringify({ ...message.write.approvalFacts, ...(write.report.approvalFactsOverride ?? {}),
            schemaVersion: write.report.approvalSummarySchemaVersion, jobId: message.jobId, runId: VALUES.runId }));
          if (write.report.actionEvidenceText !== null) {
            put(FILES.actionEvidence, fillStartMarks(write.report.actionEvidenceText));
          }
          if (typeof write.report.reportHtml === 'string') {
            put(FILES.actionReport, write.report.reportHtml);
          }
          const fileBytesOf = (name) => files.find(([entry]) => entry === name)?.[1];
          const evidenceBytes = fileBytesOf(FILES.actionEvidence);
          const summaryBytes = fileBytesOf(FILES.approvalSummary);
          const htmlBytes = fileBytesOf(FILES.actionReport);
          if (write.report.bundle && write.actionRunText !== null && evidenceBytes !== undefined && summaryBytes !== undefined && htmlBytes !== undefined) {
            // T44-UIFIX: 本物の部品（actionBundleBytesOf）で組み立てる（目録の項目と順・JSON の書式・ZIP を写さない）。ジョブ・Run・人の値の印は、
            // 書いた action-evidence.json の値（ワーカーと親の組み立て直しと同じ）。
            const { actionBundleBytesOf } = await import(ACTION_BUNDLE.bundleBytesModuleUrl);
            let evidence = {};
            try {
              evidence = JSON.parse(evidenceBytes.toString('utf8'));
            } catch {
              evidence = {};
            }
            let bundle = actionBundleBytesOf({
              jobId: evidence.jobId,
              runId: evidence.runId,
              containsHumanEnteredValues: evidence.containsHumanEnteredValues,
              humanEnteredValuesNotice: ACTION_BUNDLE.humanEnteredValuesNotice,
              actionRun: Buffer.from(fillStartMarks(write.actionRunText), 'utf8'),
              actionEvidence: evidenceBytes,
              approvalSummary: summaryBytes,
              reportHtml: htmlBytes,
            });
            if (write.report.bundle.tamper === 'manifest') {
              // 本物のバンドルを開き、目録の sha256 だけを違う値にして、本物の書式と ZIP で組み立て直す。
              const { unzipSync } = await import(write.report.bundle.fflateUrl);
              const { artifactJsonBytes } = await import(ACTION_BUNDLE.artifactJsonModuleUrl);
              const { deterministicZipOf } = await import(ACTION_BUNDLE.deterministicZipModuleUrl);
              bundle = deterministicZipOf(Object.entries(unzipSync(bundle)).map(([path, bytes]) => {
                if (path !== ACTION_BUNDLE.manifestFileName) {
                  return { path, bytes };
                }
                const manifest = JSON.parse(Buffer.from(bytes).toString('utf8'));
                return { path, bytes: artifactJsonBytes({ ...manifest,
                  files: manifest.files.map((record) => ({ ...record, sha256: 'sha256:' + '0'.repeat(64) })) }) };
              }));
            }
            writeFileSync(join(runDirectory, write.report.bundle.name), bundle);
            if (write.report.bundle.tamper === 'disk') {
              writeFileSync(join(runDirectory, FILES.actionReport), 'changed after the bundle', 'utf8');
            }
          }
        }
        // T41g: 更新の START には、更新の記録の中身があればそれを書く（登録してから更新する、の 2 つのジョブに 1 つの入口で答える）。
        const runText = message.write.update !== undefined && typeof write.actionRunTextForUpdate === 'string'
          ? write.actionRunTextForUpdate
          : write.actionRunText;
        if (runText !== null) {
          mkdirSync(runDirectory, { recursive: true });
          writeFileSync(join(runDirectory, FILES.actionRun), fillStartMarks(runText), 'utf8');
        }
        if (write.end === 'finish') {
          exitAfter(finished('COMPLETE', VALUES.exitCodes.complete), VALUES.exitCodes.complete);
        } else if (write.end === 'crash') {
          setTimeout(() => process.exit(VALUES.exitCodes.failure ?? 1), 50);
        }
      };
      if (write.recheck === 0) {
        globalThis.afterRecheck(null);
        return;
      }
      for (let index = 0; index < write.recheck; index += 1) {
        send({ protocol: P, type: 'WRITE_RECHECK_REQUEST' });
      }
      return;
    }
    if (MODE === 'fail') {
      exitAfter({ protocol: P, type: 'FAILED', reason: 'CONFIG_ERROR', detail: 'fake configuration error' }, VALUES.exitCodes.configError);
      return;
    }
    send(runStarted);
    if (MODE === 'no-heartbeat') {
      return;
    }
    send({ protocol: P, type: 'PROGRESS', report: progress });
    send({ protocol: P, type: 'PROGRESS', report: { ...progress, pagesFinished: 2 } });
    send({ protocol: P, type: 'NOTICE', notice: { kind: 'SITE_UNAVAILABLE_SLOWDOWN', minIntervalMs: 10 } });
    if (MODE === 'finish') {
      exitAfter(finished('COMPLETE', VALUES.exitCodes.complete), VALUES.exitCodes.complete);
    }
    return;
  }
  if (message && message.type === 'WRITE_RECHECK_RESULT' && MODE === 'write' && !globalThis.recheckAnswered) {
    globalThis.recheckAnswered = true;
    globalThis.afterRecheck(message);
    return;
  }
  if (message && message.type === 'LOGIN_CONFIRMED' && MODE === 'auth-manual-confirm') {
    send({ protocol: P, type: 'AUTH_STATE', state: 'AUTHENTICATED', sessionLostUrl: null, ...(VALUES.loginStage ?? {}) });
    send(runStarted);
    return;
  }
  if (message && MODE === 'chain' && message.type === 'NEXT_STAGE') {
    chainState.index += 1;
    chainRun(message.jobKind, message.jobId, message.readChecks);
    return;
  }
  if (message && MODE === 'chain' && message.type === 'CHAIN_END') {
    process.exit(chainState.exitCode);
  }
  if (message && MODE === 'chain' && message.type === 'STOP') {
    // 止める要求: 待っている段を PARTIAL（RUN_INTERRUPTED）で終え、次の段を待たずに終える（本物のワーカーと同じ）。
    const holding = chainState.holding;
    if (holding !== null) {
      chainState.holding = null;
      chainState.stages = chainState.stages.slice(0, chainState.index + 1);
      chainFinish(holding.kind, holding.jobId, holding.readChecks, holding.runId, 'PARTIAL', ['RUN_INTERRUPTED']);
    }
    return;
  }
  if (message && message.type === 'STOP' && MODE === 'auth-stop-before-start-summary') {
    send({ protocol: P, type: 'AUTH_STATE', state: 'AWAITING_LOGIN', sessionLostUrl: null, scriptLogin: loginStageCounts });
    return;
  }
  if (message && message.type === 'STOP' && MODE === 'auto-login-wait') {
    process.exit(VALUES.exitCodes.interrupted);
  }
  if (message && message.type === 'STOP' && MODE !== 'ignore-stop') {
    if (message.force) {
      process.exit(VALUES.exitCodes.interrupted);
    }
    exitAfter(finished('PARTIAL', VALUES.exitCodes.partial), VALUES.exitCodes.partial);
  }
});
`;

/** 偽のワーカーのファイル。 */
export interface FakeWorker {
  /** `fork` するファイル（絶対パス）。 */
  readonly path: string;
  /** 受けたメッセージ（ファイルを読み直す）。 */
  readonly received: () => readonly Record<string, unknown>[];
}

/** `directory` に、`mode` の偽のワーカーを書く。 */
export function writeFakeWorker(directory: string, mode: FakeWorkerMode, values: FakeWorkerValues): FakeWorker {
  const path = join(directory, `fake-worker-${mode}.mjs`);
  const log = join(directory, `fake-worker-${mode}.log`);
  writeFileSync(log, '', 'utf8');
  writeFileSync(
    path,
    SCRIPT.replace('__TYPESCRIPT_SOURCE_RESOLVE_HOOK__', () => TYPESCRIPT_SOURCE_RESOLVE_HOOK)
      .replace('__VALUES__', JSON.stringify(values)).replace('__ACTION_BUNDLE__', JSON.stringify(ACTION_BUNDLE_VALUES))
      .replace('__ARTIFACT_FILES__', JSON.stringify(ARTIFACT_FILE_NAMES))
      .replace('__MODE__', JSON.stringify(mode)).replace('__LOG__', JSON.stringify(log)),
    'utf8',
  );
  return {
    path,
    received: () => readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

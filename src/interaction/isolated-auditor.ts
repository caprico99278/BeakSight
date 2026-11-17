import type { Page } from 'playwright';
import type { InteractionGuardedSession } from '../browser/context-factory.js';
import {
  observeMainFrameLoad,
  settleMainFrameLoad,
  trackMainFrameDocument,
  type MainFrameLoadObservation,
  type MainFrameLoadSettlement,
} from '../browser/main-frame-load.js';
import { isPlaywrightTimeoutError } from '../browser/playwright-errors.js';
import type { Viewport } from '../config/types.js';
import type { InteractionStatus } from '../core/contracts.js';
import { awaitBeforeDeadline, deadlineWithinTimeoutAtMs, yieldMacrotask } from '../core/deadline.js';
import { safeErrorMessage } from '../core/errors.js';
import {
  CONTEXT_CLOSE_TIMEOUT_MS,
  PAGE_SETTLING_PACING,
  SESSION_OPEN_TIMEOUT_MS,
} from '../core/limits.js';
import type { ProgressSignals } from '../core/progress-watch.js';
import { attachPageProgressSignals } from '../browser/page-progress-signals.js';
import { waitForPageSettled } from '../browser/page-settling.js';
import { DataActivityCollector } from '../evidence/network-collector.js';
import type {
  InteractionChangeEvidence,
  InteractionClosedLifecycle,
  InteractionEvidence,
  InteractionLifecycleReasonCode,
  InteractionNotVerifiableKind,
  InteractionReasonCodeFor,
  InteractionWorkOutcome,
  InteractionWrittenNotVerifiableReasonCode,
} from '../core/evidence-types.js';
import { isPositiveSafeInteger } from '../core/guards.js';
import {
  normalizeWhitespace,
  removeBidiControls,
  removeLoneSurrogates,
  replaceControlCharacters,
} from '../core/text.js';
import { isHttpProtocol } from '../crawl/normalize-url.js';
import { auditScopeLeftUrl, type AuditScopeJudge } from '../orchestration/audit-scope-watch.js';
import {
  collectInteractionChangeEvidence,
  collectDisconnectedInteractionEvidence,
  type InteractionStateDifference,
} from '../evidence/interaction-collector.js';
import { isBlockedExternalActionReason, SafetyLedger, type SafetyLedgerSnapshot } from '../safety/safety-ledger.js';
import {
  classifyInteractionCandidate,
  freezeInteractionCandidate,
  interactionRejectionLedgerRecord,
  type InteractionCandidate,
} from '../safety/interaction-policy.js';
import {
  changedInteractionAttributeNames,
  changedInteractionClassNames,
  discoverInteractionCandidates,
  inspectInteractionCandidateHandle,
  resolveInteractionCandidateHandle,
  type InteractionAttributeRecord,
  type InteractionHandleResolution,
} from './discover-candidates.js';

export type InteractionAuditSession = InteractionGuardedSession;

export interface InteractionAuditInput {
  readonly sessionFactory: (viewport: Viewport) => Promise<InteractionAuditSession>;
  readonly targetUrl: string;
  readonly candidate: InteractionCandidate;
  readonly viewport: Viewport;
  /**
   * 隔離された Context での読み込み（`goto`）と初期描画の期限（ms）。呼び出す側が、設定の `crawl.navigationTimeoutMs` を渡す
   * （設計書 2026-09-23 4.4.1、R6 の I-2）。
   */
  readonly navigationTimeoutMs: number;
  /**
   * Interaction の期限（ms。設定の `crawl.interactionTimeoutMs`）。読み込みと初期描画が終わった時点から数える（R6 の I-2）。
   * owner のクリーンアップの期限にも使う。
   */
  readonly timeoutMs: number;
  /** 監査の全体の期限（時刻）。読み込みの期限と Interaction の期限は、この時刻を超えない。 */
  readonly deadlineAtMs: number;
  /**
   * 隔離した session の作成（`sessionFactory`）を待つ上限（ms。DEF-008、R15r-4）。既定は `SESSION_OPEN_TIMEOUT_MS`。
   * 作成の期限は、今からこの時間の後と、読み込みの期限（`navigationTimeoutMs` と `deadlineAtMs` の早い方）の、早い方である
   * （候補の予算の中に収める。Task 18 の前の整理の設計書 4.2、4.4）。
   */
  readonly sessionOpenTimeoutMs?: number | undefined;
  /**
   * 凍結（`activateInteractionFreeze`）を待つ上限（ms。DEF-008、R15r-4）。既定は `CONTEXT_CLOSE_TIMEOUT_MS`。
   * 凍結の失敗の後の無効化（Guard の `failClosed`。Context を閉じる処理）が終わらない場合に、待つのをやめるためである。
   */
  readonly freezeActivationTimeoutMs?: number | undefined;
  /**
   * session の作成が期限を過ぎた後に、作成の失敗（拒否）が届いた場合に、その失敗を受け取る口（DEF-008）。
   * 呼び出し側は、失敗が持つ Context（`ContextConstructionError` の Context など）を閉じる。口は `auditInteraction` が戻った後に
   * 呼ばれる。口の例外は封じ込める。省略すると、遅れた失敗は捨てる。遅れて届いた session は、この口を使わずに `close()` で閉じる。
   */
  readonly releaseLateSessionFailure?: ((error: unknown) => void) | undefined;
  /**
   * 候補の対象のページの読み込み（`page.goto`）の観測を受け取る口（サイトが応答しないときに Run を止める設計書 2.1）。読み込みを始めた場合に1回、
   * 読み込みが終わった（応答か例外が返った）直後に呼ぶ。読み込みを始めなかった場合（読み込みの予算が 0）は呼ばない。
   * 観測は `src/browser/main-frame-load.ts` の部品で作る。Interaction は判定をしない（判定は、受け取った Page Auditor が行う）。
   * 結果と例外の扱いは、受け口の有無で変わらない。省略できる。省略すると、観測を作らず、page の事象の受け口も付けない。
   * 関数でない値は、session を開かずに例外を投げる。
   */
  readonly afterTargetLoad?: ((observation: MainFrameLoadObservation) => void) | undefined;
  /**
   * L5（INV-LIMITS の表 A の T11・T21。設計者の判断 2026-11-10）: 進みの見張り（`watchProgress`）の口。渡すと、呼び出し側は期限を置かない（利用者が期限を
   * 指定していない）とみなし、次のように振る舞う。
   * - 隔離した page の自発の変化に、見張りの印を付ける（`attachPageProgressSignals`）。
   * - 押した後の落ち着きの待ち（`waitForPageSettled`）に、見張りを渡す（期限を置かない）。
   * - 見張りが終えたら（`signal` の abort）、session を閉じて待ちを終わらせ、結果を `NOT_VERIFIABLE`（理由は `STAGE_UNRESPONSIVE`・`STAGE_NEVER_QUIET`）にする。
   * 省略すると、落ち着きの待ちを期限で終える（SPEC-5: どちらも、落ち着いた後に 1 回だけ観測する）。
   */
  readonly progress?: ProgressSignals | undefined;
  /**
   * L5: 後片付け（owner の close）の期限（ms）。BeakSight 自身の処理の守り（Safety Ledger の不変条件の違反に結び付く）なので残す。省略は `timeoutMs`。
   */
  readonly cleanupTimeoutMs?: number | undefined;
  /**
   * COV-4 の区切り 3（設計者の判断 2026-11-10）: 確かめ終えた（`VERIFIED`）操作で開いた状態の page を受け取る口（後片付けの前に 1 回呼ぶ）。page は凍結した
   * ままなので、サイトへの送信は Guard が止めたまま。呼び出し側は、読み込み直さずに今の段を当てる。口の例外は封じ込める（操作の結果を変えない）。
   */
  readonly afterVerified?: ((page: Page) => Promise<void>) | undefined;
  /**
   * COV-4 の区切り 3（入れ子の開いた状態。設計者の判断 2026-11-10）: 対象の候補を押す前に、開いた状態まで押し直す押下の並び（候補の ID と、同じ ID の中の順番。
   * 読み込みの後、凍結してから順に押す）。渡すと、凍結の前の下準備（スクロール・hover）を凍結の後に行う（入れ子の対象だけ。送信を伴わない
   * 操作なので、サイトへ届く送信は増えない）。押し直せなかった・再現を確かめる口（`verifyTrail`）が偽を返したら `TRAIL_NOT_REPRODUCED`。省略・空は今までどおり。
   */
  readonly pressTrail?: readonly InteractionPressStep[] | undefined;
  /** COV-4 の区切り 3: 押し直した後の page が、記録した開いた状態と同じ構造かを確かめる口（偽なら `TRAIL_NOT_REPRODUCED`）。 */
  readonly verifyTrail?: ((page: Page) => Promise<boolean>) | undefined;
  /**
   * REV-SD の I-1: URL が点検の範囲の外か（呼ぶ側が Run の範囲で作る）。凍結の後と押す直前に、隔離した page の main frame の URL を見直し（判定は
   * `auditScopeLeftUrl`）、範囲の外へ移っていれば押さない（`INITIAL_LOAD_AFTER_LOAD`。詳細は `OUTSIDE_AUDIT_SCOPE`）。省略は見ない。
   */
  readonly isOutsideAuditScope?: AuditScopeJudge | undefined;
}

/** REV-SD の I-1: 範囲の外へ移った page で押さなかったときの詳細。 */
const OUTSIDE_AUDIT_SCOPE_DETAIL = 'OUTSIDE_AUDIT_SCOPE';

/** REV-SD の I-1: 隔離した page の main frame が、点検の範囲の外へ移ったか（判定は `auditScopeLeftUrl` の 1 か所）。 */
const movedOutsideAuditScope = (session: InteractionAuditSession, input: InteractionAuditInput): boolean =>
  input.isOutsideAuditScope !== undefined && auditScopeLeftUrl(session.page.url(), input.isOutsideAuditScope) !== null;

/** COV-4 の区切り 3: 押し直す押下の 1 つ（候補の ID と、同じ ID の中の順番）。 */
export interface InteractionPressStep {
  readonly candidateId: string;
  readonly ordinal: number;
}

/**
 * L5: 進みの見張りが終えた理由から、Interaction の理由のコード（見張りが終えていない・Run の時間の上限などは `null`）。判定はここだけ。
 */
export function interactionStageEndReasonOf(signal: AbortSignal | undefined): 'STAGE_UNRESPONSIVE' | 'STAGE_NEVER_QUIET' | null {
  if (signal === undefined || !signal.aborted) {
    return null;
  }
  const reason: unknown = signal.reason;
  return reason === 'STAGE_UNRESPONSIVE' || reason === 'STAGE_NEVER_QUIET' ? reason : null;
}

/** Interaction の Evidence（`InteractionEvidence`）と、その Interaction の Context の Safety Ledger の記録。 */
export interface InteractionAuditResult extends InteractionEvidence {
  readonly safety: SafetyLedgerSnapshot;
}

/**
 * クリーンアップの期限か回数を使い切っても終端に達しなかった状態。`InteractionOwnerCleanupError` だけが持つ。
 * 理由は、lifecycle の理由のコードと、技術的な詳細（Evidence の lifecycle と同じ形。C18n）。
 */
export interface InteractionNonTerminalLifecycle {
  readonly status: 'NON_TERMINAL';
  readonly reason: InteractionLifecycleReasonCode;
  readonly reasonDetail: string | null;
}

const INTERACTION_OWNER_CLOSE_ATTEMPT_LIMIT = 2;
const INTERACTION_OWNER_CLEANUP_EXHAUSTED_MESSAGE = 'Interaction owner cleanup retry budget exhausted';
/** owner の close が期限を過ぎたときの、Ledger の違反の文言（lifecycle の理由のコードは `OWNER_CLOSE_TIMED_OUT`）。 */
const INTERACTION_OWNER_CLOSE_TIMEOUT_MESSAGE = 'Interaction owner close timed out before terminal Guard state';
/** owner の close が終端に達せずに終わったときの、Ledger の違反の文言（lifecycle の理由のコードは `OWNER_CLOSE_NON_TERMINAL`）。 */
const INTERACTION_OWNER_CLOSE_NON_TERMINAL_MESSAGE = 'Interaction owner close fulfilled without terminal Guard state';
const INTERACTION_OWNER_CLEANUP_DEADLINE_MESSAGE = 'Interaction owner cleanup deadline exceeded';
/** 凍結を待つ処理が期限（`freezeActivationTimeoutMs`）の中で終わらなかったときの、失敗のメッセージ（DEF-008）。 */
const INTERACTION_FREEZE_DEADLINE_MESSAGE = 'Interaction freeze activation did not finish before its deadline';

/**
 * NOT_VERIFIABLE の理由のコードと、区分（`InteractionNotVerifiableKind`）の対応表（Task 14〜17 の設計書 5.4.1、I15a。
 * Task 19 の前の整理の設計書 5.1）。コードの一覧は `src/core/evidence-types.ts` の `INTERACTION_NOT_VERIFIABLE_REASON_CODES`。
 * NOT_VERIFIABLE の結果は、この表のコードを受け取る `notVerifiable` だけが作るので、区分はコードと1対1に決まる。
 * 型（`satisfies`）で、今の版が書くすべてのコードに区分があり、ほかのコードがないことを保証する。前の版だけが書いたコード
 * （`INTERACTION_LEGACY_NOT_VERIFIABLE_REASON_CODES`。読むだけ）は、この表に持たない（SPEC-5）。
 * - `OBSERVED_NO_CHANGE`: 確かめる手順を最後まで行い、変化が見えなかったか、サイトの振る舞いのために確かめられないと結論した。
 * - `CHECK_NOT_COMPLETED`: 確かめる手順を終えられなかった（期限切れ、下準備の失敗、作業量や探索の上限、比べられない、対象を特定できない）。
 *   判断に迷う理由も、完了の偽りを避けるために、こちらに寄せる。
 */
export const INTERACTION_NOT_VERIFIABLE_REASONS = Object.freeze({
  // 隔離した session（Context と page）の作成の期限切れ（DEF-008。Task 18 の前の整理の設計書 4.4）。session がないので、読み込みも
  // 操作もしていない。遅れて届いた session は、待たずに閉じる。
  SESSION_OPEN_DEADLINE: 'CHECK_NOT_COMPLETED',

  // 読み込みと初期描画の期限（`navigationTimeoutMs` と全体の期限の早い方）の期限切れ（R6 の I-2）。Interaction の期限切れの理由と
  // 区別できるように、読み込みのどの段階かを示す。
  INITIAL_LOAD_BEFORE_LOAD: 'CHECK_NOT_COMPLETED',
  INITIAL_LOAD_DURING_LOAD: 'CHECK_NOT_COMPLETED',
  INITIAL_LOAD_AFTER_LOAD: 'CHECK_NOT_COMPLETED',
  INITIAL_LOAD_BEFORE_RENDER: 'CHECK_NOT_COMPLETED',

  // 凍結の前の下準備（SPEC-5: スクロール・hover・描画 2 回・観測 1 回。focus と安定の窓はやめた）。
  /** 下準備（スクロール・hover・描画の待ち・観測）を、期限までに終えられなかった。 */
  SCROLL_PREPARATION_DEADLINE: 'CHECK_NOT_COMPLETED',
  /** 下準備のスクロールか hover の失敗。詳細は、整えたエラーの文言。文言から詳細に使える部分が残らなければ、詳細は null。 */
  SCROLL_PREPARATION_FAILED: 'CHECK_NOT_COMPLETED',

  // 凍結の後の、探し直し・handle の解決・受け入れの判定・click。
  CANDIDATE_IDENTITY_NOT_REDISCOVERED: 'CHECK_NOT_COMPLETED',
  CANDIDATE_IDENTITY_AMBIGUOUS: 'CHECK_NOT_COMPLETED',
  TARGET_HANDLE_NOT_RESOLVED: 'CHECK_NOT_COMPLETED',
  TARGET_DISCONNECTED_BEFORE_ADMISSION: 'CHECK_NOT_COMPLETED',
  TARGET_CHANGED_DURING_EXACT_NODE_RESOLUTION: 'CHECK_NOT_COMPLETED',
  /** 下準備をしなかった（凍結の前に対象を一意に特定できなかったなど）対象が、凍結の後に受け入れられた。click しない。 */
  TARGET_NOT_SCROLL_PREPARED: 'CHECK_NOT_COMPLETED',
  /** 凍結の後、click を始める前に、期限が切れた（探し直し・handle の解決・押す前の観測のどこでも）。 */
  DEADLINE_BEFORE_EXACT_NODE_CLICK: 'CHECK_NOT_COMPLETED',
  /**
   * click が期限切れになった。詳細は、整えた click のエラーの文言（残らなければ null）。click のほかの失敗は、
   * EXECUTION_FAILED の `CLICK_FAILED` で、コードで見分けられる。
   */
  CLICK_TIMED_OUT: 'CHECK_NOT_COMPLETED',

  // click の後の観測（SPEC-5: 落ち着きを待ってから 1 回だけ観測する）。
  /** click の後の 1 回の観測を、期限までに終えられなかった（落ち着きの待ちが期限まで続いた場合を含む）。 */
  DEADLINE_DURING_POST_CONDITION_OBSERVATION: 'CHECK_NOT_COMPLETED',
  /**
   * click の後の観測を終え、根拠となる変化が見えなかった。位置と大きさ（`boundingBox`）だけの変化も、ここに寄せる（SPEC-5。前の版の
   * `GEOMETRY_ONLY_*` は読むだけ）。
   */
  NO_OBSERVABLE_CHANGE: 'OBSERVED_NO_CHANGE',
  /**
   * click の後に、保持した対象が切断され、同じ要素と確かめられなくなった。詳細は、切断の後の identityStatus の値。
   * click と観測を終えたうえで、サイトの振る舞い（対象の置き換えや削除）のために確かめられないと結論した場合である。
   */
  RETAINED_IDENTITY_LOST: 'OBSERVED_NO_CHANGE',
  // L5: 利用者が期限を指定していない操作を、L0 の進みの見張りが終えた（確かめる手順を終えられなかった）。
  STAGE_UNRESPONSIVE: 'CHECK_NOT_COMPLETED',
  STAGE_NEVER_QUIET: 'CHECK_NOT_COMPLETED',
  // COV-4 の区切り 3: 入れ子の開いた状態まで押し直す並びを再現できなかった（確かめる手順を終えられなかった）。
  TRAIL_NOT_REPRODUCED: 'CHECK_NOT_COMPLETED',
} as const satisfies Readonly<Record<InteractionWrittenNotVerifiableReasonCode, InteractionNotVerifiableKind>>);

/** 下準備の hover の後、凍結の前に待つ描画の回数。 */
const SCROLL_PREPARATION_SETTLE_FRAMES = 2;
const UNINSPECTABLE_INTERACTION_ERROR_MESSAGE = 'Interaction error could not be safely normalized';
/** owner の close の拒否のエラーの文言から、不要な部分を除いた結果が空になった場合の、Ledger の違反の文言。 */
const OWNER_CLOSE_FAILURE_FALLBACK_MESSAGE = 'Interaction owner close failed';
/** handle の破棄の失敗のエラーの文言から、不要な部分を除いた結果が空になった場合の、Ledger の違反の文言。 */
const HANDLE_DISPOSE_FAILURE_FALLBACK_MESSAGE = 'Interaction handle dispose failed';
/**
 * 端末の色付けなどに使うエスケープシーケンス。左から順に、次のものに一致する（R5 の N-6）。
 * - 本体を持つ制御文字列（DCS・SOS・OSC・PM・APC）。7ビットの導入（`ESC P` など）と C1 の導入（0x90 など）の両方。
 *   本体は BEL か ST（`ESC \` または C1 の 0x9C）まで。終端がなければ、文言の終わりまでを本体とみなす。
 * - CSI（`ESC [` または C1 の 0x9B）。終端の文字（final byte）のない断片も含む。
 * - 2文字のエスケープシーケンス。
 */
const ANSI_ESCAPE_SEQUENCE_PATTERN =
  /(?:\u001b[PX\]^_]|[\u0090\u0098\u009d-\u009f])[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?|\u001b[@-Z\\-_]/gu;
/** エスケープシーケンスを除いた後に残る、C0・C1 の制御文字（Cc）の置き換え。判定は `src/core/text.ts` の `replaceControlCharacters`（CCX-3）。 */
const CONTROL_CHARACTER_REPLACEMENT = ' ';
/** Playwright がエラーの文言の後ろに付ける、操作の記録（`Call log:` の行から後ろ）。 */
const PLAYWRIGHT_CALL_LOG_PATTERN = /(?:^|\n)[ \t]*Call log:/u;

export interface InteractionCleanupFailure {
  readonly kind: 'DEADLINE_EXCEEDED' | 'ATTEMPT_BUDGET_EXHAUSTED';
  readonly attemptsStarted: number;
  readonly deadlineAtMs: number;
  readonly deadlineReached: boolean;
  readonly anomaly: 'TIMED_OUT' | 'REJECTED' | 'FULFILLED_NON_TERMINAL';
  readonly lastCloseRejected: boolean;
  readonly lastCloseError: unknown;
}

/** クリーンアップに許された時間を使い切った後、まだ生存しているセッションの所有権を引き継ぐ。 */
export class InteractionOwnerCleanupError extends Error {
  readonly session: InteractionAuditSession;
  readonly candidateId: string;
  readonly work: InteractionWorkOutcome;
  readonly lifecycle: InteractionNonTerminalLifecycle;
  readonly safety: SafetyLedgerSnapshot;
  readonly lastCloseRejected: boolean;
  readonly lastCloseError: unknown;
  readonly cleanup: InteractionCleanupFailure;

  constructor(input: {
    readonly session: InteractionAuditSession;
    readonly candidateId: string;
    readonly work: InteractionWorkOutcome;
    readonly lifecycle: InteractionNonTerminalLifecycle;
    readonly safety: SafetyLedgerSnapshot;
    readonly lastCloseRejected: boolean;
    readonly lastCloseError: unknown;
    readonly cleanup: InteractionCleanupFailure;
  }) {
    super(INTERACTION_OWNER_CLEANUP_EXHAUSTED_MESSAGE);
    this.name = 'InteractionOwnerCleanupError';
    this.session = input.session;
    this.candidateId = input.candidateId;
    this.work = input.work;
    this.lifecycle = input.lifecycle;
    this.safety = input.safety;
    this.lastCloseRejected = input.lastCloseRejected;
    this.lastCloseError = input.lastCloseError;
    this.cleanup = input.cleanup;
    Object.freeze(this);
  }
}

/** エラーの文言を、切り詰めずに取り出す（LZ-2: 理由の詳細と Ledger の文言の長さの上限（前は 512）は置かない）。 */
function fullErrorMessage(error: unknown): string {
  return safeErrorMessage(error, UNINSPECTABLE_INTERACTION_ERROR_MESSAGE);
}

function emptyEvidence(
  before: InteractionCandidate | null = null,
  identityStatus: 'MISSING' | 'AMBIGUOUS' | 'UNESTABLISHED' = 'UNESTABLISHED',
): InteractionChangeEvidence {
  return Object.freeze({
    before,
    after: null,
    identityStatus,
    changedFields: Object.freeze([]),
    changedAttributes: Object.freeze([]),
    changedAttributesTruncated: false,
    detailsOpenBefore: null,
    detailsOpenAfter: null,
  });
}

function matchedPreInteractionEvidence(before: InteractionCandidate): InteractionChangeEvidence {
  return Object.freeze({
    before,
    after: null,
    identityStatus: 'MATCHED',
    changedFields: Object.freeze([]),
    changedAttributes: Object.freeze([]),
    changedAttributesTruncated: false,
    detailsOpenBefore: null,
    detailsOpenAfter: null,
  });
}

/**
 * 作業の結果（Evidence の `work`）と、NOT_VERIFIABLE の区分（I15a）。区分は Evidence の最上位に置き、`work` には持たせない。
 * 作るのは `outcome` と `notVerifiable` だけである。
 */
interface ClassifiedWorkOutcome {
  readonly work: InteractionWorkOutcome;
  readonly notVerifiableKind: InteractionNotVerifiableKind | null;
}

/** NOT_VERIFIABLE の状態。この状態の結果は `notVerifiable` だけが作る（区分を理由の対応表から決めるため）。 */
const NOT_VERIFIABLE_STATUS = 'NOT_VERIFIABLE' satisfies InteractionStatus;

/**
 * NOT_VERIFIABLE 以外の作業の結果。区分は null。理由は、status に合うコード（`INTERACTION_REASON_CODES_BY_STATUS`）だけを
 * 型で受け取る（Task 19 の前の整理の設計書 5.1.2）。詳細がなければ `reasonDetail` は null。
 */
function outcome<S extends Exclude<InteractionStatus, typeof NOT_VERIFIABLE_STATUS>>(
  status: S,
  reason: InteractionReasonCodeFor<S>,
  reasonDetail: string | null,
  evidence: InteractionChangeEvidence,
): ClassifiedWorkOutcome {
  return Object.freeze({
    work: Object.freeze({ status, reason, reasonDetail, evidence }),
    notVerifiableKind: null,
  });
}

/**
 * NOT_VERIFIABLE の作業の結果。区分は、理由のコードから対応表（`INTERACTION_NOT_VERIFIABLE_REASONS`）で決める。
 * 技術的な詳細（completeness の値、identityStatus の値、整えたエラーの文言）は `reasonDetail` に渡す。詳細がなければ null。
 */
function notVerifiable(
  code: InteractionWrittenNotVerifiableReasonCode,
  evidence: InteractionChangeEvidence,
  reasonDetail: string | null = null,
): ClassifiedWorkOutcome {
  return Object.freeze({
    work: Object.freeze({
      status: NOT_VERIFIABLE_STATUS,
      reason: code,
      reasonDetail,
      evidence,
    }),
    notVerifiableKind: INTERACTION_NOT_VERIFIABLE_REASONS[code],
  });
}

/** 終端（`CLOSED`）に達した lifecycle。理由がなければ、理由も詳細も null。 */
function closedLifecycle(
  reason: InteractionLifecycleReasonCode | null,
  reasonDetail: string | null = null,
): InteractionClosedLifecycle {
  return Object.freeze({
    status: 'CLOSED',
    reason,
    reasonDetail: reason === null ? null : reasonDetail,
  });
}

function nonTerminalLifecycle(
  reason: InteractionLifecycleReasonCode,
  reasonDetail: string | null,
): InteractionNonTerminalLifecycle {
  return Object.freeze({
    status: 'NON_TERMINAL',
    reason,
    reasonDetail,
  });
}

/**
 * Interaction の失敗の詳細を、エラーの文言から作る。click・下準備・作業の失敗と、owner の close の失敗の詳細（`reasonDetail`）と、
 * Ledger に記録する文言（`interactionFailureMessage`）は、すべてこの関数で整形する。
 * エスケープシーケンス（制御文字列の本体を含む）と、Playwright の `Call log:` から後ろと、双方向の制御文字と、孤立したサロゲートを除き、
 * 残った制御文字と連続する空白を1つの空白にする。何も残らなかった場合は null を返す。
 * LZ-2: 切り詰めない（前は `MAX_INTERACTION_REASON_LENGTH` 512 まで）。
 */
function interactionFailureDetail(error: unknown): string | null {
  const withoutAnsi = fullErrorMessage(error).replace(ANSI_ESCAPE_SEQUENCE_PATTERN, '');
  const callLogAt = withoutAnsi.search(PLAYWRIGHT_CALL_LOG_PATTERN);
  const summary = callLogAt === -1 ? withoutAnsi : withoutAnsi.slice(0, callLogAt);
  const cleaned = normalizeWhitespace(
    // 双方向の制御文字（ALM・LRM・RLM、埋め込み・上書き、分離）と、孤立したサロゲートを除く（R6 の M-3）。残った Cc は空白にする。
    replaceControlCharacters(removeLoneSurrogates(removeBidiControls(summary)), CONTROL_CHARACTER_REPLACEMENT),
  );
  return cleaned === '' ? null : cleaned;
}

/** Ledger に記録する失敗の文言。整えたエラーの文言で、何も残らなかった場合は `fallbackMessage`。 */
function interactionFailureMessage(error: unknown, fallbackMessage: string): string {
  return interactionFailureDetail(error) ?? fallbackMessage;
}

/**
 * click の失敗の結果。期限切れ（Playwright の TimeoutError）は NOT_VERIFIABLE の `CLICK_TIMED_OUT`、ほかの失敗は
 * EXECUTION_FAILED の `CLICK_FAILED`。どちらも、詳細は整えた click のエラーの文言（残らなければ null）。
 */
function clickFailureOutcome(
  clickError: unknown,
  evidence: InteractionChangeEvidence,
): ClassifiedWorkOutcome {
  const reasonDetail = interactionFailureDetail(clickError);
  return isPlaywrightTimeoutError(clickError)
    ? notVerifiable('CLICK_TIMED_OUT', evidence, reasonDetail)
    : outcome('EXECUTION_FAILED', 'CLICK_FAILED', reasonDetail, evidence);
}

/**
 * freeze の後にページが起こした作用を遮断したか、または外部スキームへの移動を試みたか。Passive フェーズ（読み込み中）の
 * ダウンロード（`PASSIVE_DOWNLOAD`）と外部スキームへの移動の試み（`phase: 'PASSIVE'`。C18a）は、Ledger に記録されていれば足り、
 * Interaction の結果を BLOCKED にしない。
 * 遮断したリクエストは、Guard が止めたページの要求（理由 `INTERACTION_FROZEN`）だけを数える（DEF-046。設計書
 * `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 3）。出口の中継の記録（`INTERACTION_FROZEN_EGRESS`、
 * `EGRESS_UPSTREAM_DENIED`）は、ネットワークの層の記録で、Chromium 自身の通信を含みうるので数えない（Ledger には残る）。
 */
export function interactionFreezeEventRecorded(snapshot: SafetyLedgerSnapshot): boolean {
  return snapshot.blockedInteractionRequests.some(({ reason }) => reason === 'INTERACTION_FROZEN')
    || snapshot.blockedInteractionNavigations.length > 0
    || snapshot.blockedPopups.length > 0
    || snapshot.blockedDownloads.some(({ reason }) => reason === 'INTERACTION_FROZEN')
    || snapshot.blockedInteractionWebSockets.length > 0
    || snapshot.externalSchemeNavigations.some(({ phase }) => phase === 'INTERACTION')
    // SAFE-2 の 4 の後: 凍結の後の `window.open` の外部スキームは、frame の判定の失敗にだけ残るので、凍結の後のその記録も作用として見る。
    || (snapshot.frameClassificationFailures?.events.some(({ phase }) => phase === 'INTERACTION') ?? false);
}

const hasFreezeEvent = interactionFreezeEventRecorded;

/**
 * 終端（`CLOSED`）に達した後の最終結果を決める。非終端の場合は結果を返さないので、ここには来ない。
 * NOT_VERIFIABLE の区分は、最終の状態が作業の状態のまま NOT_VERIFIABLE の場合だけ持つ（BLOCKED_BY_SAFETY にした場合は null）。
 * BLOCKED_BY_SAFETY にした場合の理由の詳細は null（作業の理由と詳細は `work` に残る）。
 */
function finalizeInteractionOutcome(
  classified: ClassifiedWorkOutcome,
  cleanupAnomaly: boolean,
  safety: SafetyLedgerSnapshot,
): Pick<InteractionEvidence, 'status' | 'reason' | 'reasonDetail' | 'notVerifiableKind'> {
  if (hasFreezeEvent(safety)) {
    return Object.freeze({
      status: 'BLOCKED_BY_SAFETY',
      reason: 'SAFETY_FREEZE_BLOCKED',
      reasonDetail: null,
      notVerifiableKind: null,
    });
  }
  if (cleanupAnomaly) {
    return Object.freeze({
      status: 'BLOCKED_BY_SAFETY',
      reason: 'OWNER_CLOSE_SAFETY_FAILURE',
      reasonDetail: null,
      notVerifiableKind: null,
    });
  }
  return Object.freeze({
    status: classified.work.status,
    reason: classified.work.reason,
    reasonDetail: classified.work.reasonDetail,
    notVerifiableKind: classified.notVerifiableKind,
  });
}

function positiveFiniteInteger(value: number, name: string): void {
  if (!isPositiveSafeInteger(value)) {
    throw new Error(`${name} must be a positive finite integer`);
  }
}

function immutableViewport(viewport: Viewport): Viewport {
  positiveFiniteInteger(viewport.width, 'Interaction viewport width');
  positiveFiniteInteger(viewport.height, 'Interaction viewport height');
  return Object.freeze({ width: viewport.width, height: viewport.height });
}

async function awaitInitialRender(page: Page, deadlineAtMs: number): Promise<boolean> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const observed = await Promise.race([
      page.evaluate(() => new Promise<true>((resolveFrame) => {
        requestAnimationFrame(() => resolveFrame(true));
      })),
      new Promise<false>((resolveDeadline) => {
        timer = setTimeout(() => resolveDeadline(false), remainingMs);
      }),
    ]);
    return observed && Date.now() < deadlineAtMs;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

type CloseSettlement =
  | { readonly status: 'FULFILLED' }
  | { readonly status: 'REJECTED'; readonly error: unknown };

type BoundedCloseSettlement = CloseSettlement | { readonly status: 'TIMED_OUT' };

function containedCloseSettlement(session: InteractionAuditSession): Promise<CloseSettlement> {
  return Promise.resolve()
    .then(() => session.close())
    .then(
      (): CloseSettlement => Object.freeze({ status: 'FULFILLED' }),
      (error: unknown): CloseSettlement => Object.freeze({ status: 'REJECTED', error }),
    );
}

async function observeCloseUntil(
  settlement: Promise<CloseSettlement>,
  deadlineAtMs: number,
): Promise<BoundedCloseSettlement> {
  const remainingMs = Math.max(0, deadlineAtMs - Date.now());
  if (remainingMs === 0) return Object.freeze({ status: 'TIMED_OUT' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settlement,
      new Promise<BoundedCloseSettlement>((resolve) => {
        timer = setTimeout(() => resolve(Object.freeze({ status: 'TIMED_OUT' })), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type BoundedBrowserWork<T> =
  | { readonly status: 'SETTLED'; readonly value: T }
  | { readonly status: 'PENDING_AT_DEADLINE' };

const PENDING_AT_DEADLINE: BoundedBrowserWork<never> = Object.freeze({ status: 'PENDING_AT_DEADLINE' });

/**
 * 作業フェーズのブラウザ内評価（discovery・handle の解決・保持した handle の検査）を始め、`deadlineAtMs` までの期限付きで待つ
 * （設計書 2026-09-23 4.3）。期限の待機を用意してから `start` を呼ぶので、待機は評価の開始から有効になる。
 *
 * - 呼び出した時点で期限を過ぎていれば、`start` を呼ばずに（ブラウザ内の評価を始めずに）`PENDING_AT_DEADLINE` を返す。
 * - 期限のタイマーより先に決着すれば、その値を返す（期限を過ぎてから決着を確かめた場合も、値を所有するために返す。
 *   期限切れの判定は、呼び出し側の既存の検査が行う）。拒否は、そのまま投げる。
 * - 期限までに決着しなければ `PENDING_AT_DEADLINE` を返す。放置した評価が後で拒否しても unhandledRejection にならない。
 *   後で値が届いた場合は `releaseLateValue` で解放する（handle の破棄、session を閉じる処理など）。後で拒否された場合は、
 *   その理由を `releaseLateFailure` に渡す（既定は捨てる）。どちらの例外も封じ込める。
 */
async function awaitBrowserWork<T>(
  start: () => Promise<T>,
  deadlineAtMs: number,
  releaseLateValue: (value: T) => Promise<void> | void = () => undefined,
  releaseLateFailure: (reason: unknown) => Promise<void> | void = () => undefined,
): Promise<BoundedBrowserWork<T>> {
  if (!Number.isFinite(deadlineAtMs) || Date.now() >= deadlineAtMs) {
    return PENDING_AT_DEADLINE;
  }
  let settled: { readonly value: T } | undefined;
  let resolveOperation!: (value: T | PromiseLike<T>) => void;
  let rejectOperation!: (reason: unknown) => void;
  const operation = new Promise<T>((resolve, reject) => {
    resolveOperation = resolve;
    rejectOperation = reject;
  });
  const observed = operation.then((value) => {
    settled = { value };
    return value;
  });
  const boundedWait = awaitBeforeDeadline(observed, deadlineAtMs);
  try {
    resolveOperation(start());
  } catch (error) {
    rejectOperation(error);
  }
  const bounded = await boundedWait;
  if (bounded.status === 'FULFILLED') {
    return Object.freeze({ status: 'SETTLED' as const, value: bounded.value });
  }
  if (bounded.status === 'REJECTED') {
    throw bounded.reason;
  }
  if (settled !== undefined) {
    return Object.freeze({ status: 'SETTLED' as const, value: settled.value });
  }
  observed
    .then(releaseLateValue, releaseLateFailure)
    .catch(() => undefined);
  return PENDING_AT_DEADLINE;
}

function recordHandleDisposeFailure(session: InteractionAuditSession, error: unknown): void {
  session.ledger.recordInvariantViolation({
    code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
    message: interactionFailureMessage(error, HANDLE_DISPOSE_FAILURE_FALLBACK_MESSAGE),
  });
}

/** 期限の後に届いた handle の解決結果を破棄する。破棄の失敗は、期限内に破棄した場合と同じく Ledger に記録する。 */
function disposeLateResolvedHandle(
  session: InteractionAuditSession,
): (resolution: InteractionHandleResolution) => Promise<void> {
  return async (resolution) => {
    if (resolution.status !== 'FOUND') {
      return;
    }
    try {
      await resolution.reference.handle.dispose();
    } catch (error) {
      recordHandleDisposeFailure(session, error);
    }
  };
}

/**
 * 保持した handle を破棄し、`deadlineAtMs` までの期限付きで待つ。期限の前に破棄が失敗すれば Ledger に記録する。
 * 期限までに決着しなければ待たずに進み、後で失敗した場合は、期限の後に届いた handle の破棄（`disposeLateResolvedHandle`）と
 * 同じく Ledger に記録する。期限を過ぎていても、破棄そのものは必ず始める。
 */
async function disposeRetainedHandleUntil(
  session: InteractionAuditSession,
  handle: { dispose(): Promise<void> },
  deadlineAtMs: number,
): Promise<void> {
  const disposal = Promise.resolve().then(() => handle.dispose());
  const bounded = await awaitBeforeDeadline(disposal, deadlineAtMs);
  if (bounded.status === 'REJECTED') {
    recordHandleDisposeFailure(session, bounded.reason);
    return;
  }
  if (bounded.status === 'DEADLINE_EXCEEDED') {
    disposal
      .then(() => undefined, (error: unknown) => recordHandleDisposeFailure(session, error))
      .catch(() => undefined);
  }
}

/**
 * 凍結（`activateInteractionFreeze`）を始め、`timeoutMs` の間だけ待つ（DEF-008。Task 18 の前の整理の設計書 4.4）。
 * - 凍結の失敗は、そのまま投げる（今の扱い。`auditInteraction` が EXECUTION_FAILED にする）。
 * - 期限の中で終わらなければ、待つのをやめて、`INTERACTION_FREEZE_DEADLINE_MESSAGE` の Error を投げる（凍結の失敗と同じ扱いになる）。
 *   凍結が終わらないのは、凍結の失敗の後の無効化（Guard の `failClosed`。Context を閉じる処理）が終わらない場合である。
 *   違反の記録は凍結の処理が行うので、ここでは加えない。Guard の状態も変えない（無効化が終わらない間も、Guard はリクエストを止め続ける）。
 * - 期限を過ぎた後に遅れて返る結果と例外は、封じ込める（`awaitBeforeDeadline`）。
 */
async function activateFreezeBeforeDeadline(session: InteractionAuditSession, timeoutMs: number): Promise<void> {
  const activation = await awaitBeforeDeadline(
    (async (): Promise<void> => session.activateInteractionFreeze())(),
    Date.now() + timeoutMs,
  );
  if (activation.status === 'REJECTED') {
    throw activation.reason;
  }
  if (activation.status === 'DEADLINE_EXCEEDED') {
    throw new Error(INTERACTION_FREEZE_DEADLINE_MESSAGE);
  }
}

/** 期限を過ぎた後に届いた session を、待たずに閉じる（DEF-008）。閉じる処理の結果と例外は捨てる（設計書 4.2 と同じ扱い）。 */
async function closeLateSession(session: InteractionAuditSession): Promise<void> {
  await containedCloseSettlement(session);
}

/**
 * session の作成が期限を過ぎた場合の結果（DEF-008。Task 18 の前の整理の設計書 4.4）。NOT_VERIFIABLE（CHECK_NOT_COMPLETED）とする。
 * session を持たないので、読み込みも操作もしていない。Safety の記録は、この audit が観測した事象がないので、空の Ledger の snapshot とする。
 * 遅れて届いた session は、`closeLateSession` が閉じる。lifecycle の理由は `SESSION_NOT_OPENED`（閉じる session がない）。
 */
function sessionOpenDeadlineResult(candidate: InteractionCandidate): InteractionAuditResult {
  const classified = notVerifiable('SESSION_OPEN_DEADLINE', emptyEvidence(candidate));
  const safety = new SafetyLedger().snapshot();
  const finalOutcome = finalizeInteractionOutcome(classified, false, safety);
  return Object.freeze({
    candidateId: candidate.candidateId,
    status: finalOutcome.status,
    reason: finalOutcome.reason,
    reasonDetail: finalOutcome.reasonDetail,
    evidence: classified.work.evidence,
    work: classified.work,
    lifecycle: closedLifecycle('SESSION_NOT_OPENED'),
    notVerifiableKind: finalOutcome.notVerifiableKind,
    safety,
  });
}

/** 1回の観測で得た、対象の状態（候補の事実と、候補の事実の外にある状態）。 */
interface TargetObservation {
  readonly candidate: InteractionCandidate;
  readonly attributes: InteractionAttributeRecord;
  readonly detailsOpen: boolean | null;
}

/** 押す前と押した後の観測の間の、候補の事実の外にある状態の変化。 */
function targetStateDifference(before: TargetObservation, after: TargetObservation): InteractionStateDifference {
  return Object.freeze({
    changedAttributeNames: changedInteractionAttributeNames(before.attributes, after.attributes),
    changedClassNames: changedInteractionClassNames(before.attributes, after.attributes),
    detailsOpen: Object.freeze({ before: before.detailsOpen, after: after.detailsOpen }),
  });
}

/**
 * 凍結の前の下準備の結果（設計書 2026-09-23 4.4、選択肢 A。SPEC-5 で focus と安定の窓をやめた）。
 * - `PREPARED`: 対象を画面内にスクロールし、hover し、描画を 2 回待ち、対象を 1 回観測した。`candidateId` はその観測の候補の ID で、
 *   凍結の後の探し直しの目印にする（hover で文字が変わる対象のため。R5 の N-4）。
 * - `SKIPPED`: 対象を一意に特定できなかった、同じ要素と確かめられなかった、または受け入れの判定で除外される見込みなので、下準備をしなかった。
 *   結果は凍結の後の、これまでと同じ判定で決まる。受け入れられた場合は、click せずに `TARGET_NOT_SCROLL_PREPARED` にする。
 * - `STOPPED`: 期限切れか、スクロール・hover の失敗。凍結せずに、その結果で終える。
 */
type TargetPreparation =
  | { readonly status: 'PREPARED'; readonly candidateId: string }
  | { readonly status: 'SKIPPED' }
  | { readonly status: 'STOPPED'; readonly outcome: ClassifiedWorkOutcome };

/**
 * 凍結の前（Passive フェーズ）の下準備（設計書 2026-09-23 4.4.2 を SPEC-5 で置き換え。設計書 2026-11-14 5.1 の案 B）。候補を探し直して handle を
 * 解決し、同じ要素かを 1 回の観測で確かめ、期限付きで画面内にスクロールし、期限付きで対象に hover し、描画を 2 回待ってから、対象を 1 回観測して、
 * handle を破棄する。click のときにスクロールが起きないようにし、hover による変化を押す前の状態に含め、スクロールと hover で始まる遅延読み込みなどの
 * 通信を、凍結の前（Passive フェーズの通信として Guard の判定を受ける）に始めさせるためである。focus と安定の窓は持たない。
 * 探索や解決がブラウザから不正な値を受け取った場合は、凍結の後と同じく例外をそのまま投げる。
 */
async function prepareTarget(
  session: InteractionAuditSession,
  candidate: InteractionCandidate,
  effectiveDeadlineAtMs: number,
): Promise<TargetPreparation> {
  const stop = (
    code: 'SCROLL_PREPARATION_DEADLINE' | 'SCROLL_PREPARATION_FAILED',
    reasonDetail: string | null = null,
  ): TargetPreparation => Object.freeze({
    status: 'STOPPED' as const,
    outcome: notVerifiable(code, emptyEvidence(candidate), reasonDetail),
  });
  const stopByError = (error: unknown): TargetPreparation => (isPlaywrightTimeoutError(error)
    ? stop('SCROLL_PREPARATION_DEADLINE')
    : stop('SCROLL_PREPARATION_FAILED', interactionFailureDetail(error)));
  const skipped: TargetPreparation = Object.freeze({ status: 'SKIPPED' });

  const discoveryWork = await awaitBrowserWork(() => discoverInteractionCandidates(session.page), effectiveDeadlineAtMs);
  if (discoveryWork.status === 'PENDING_AT_DEADLINE') {
    return stop('SCROLL_PREPARATION_DEADLINE');
  }
  const matching = discoveryWork.value.candidates.filter((item) => item.candidateId === candidate.candidateId);
  if (matching.length !== 1) {
    return skipped;
  }
  const prepared = matching[0] as InteractionCandidate;
  if (classifyInteractionCandidate(prepared).action === 'REJECT') {
    return skipped;
  }

  const resolutionWork = await awaitBrowserWork(
    () => resolveInteractionCandidateHandle(session.page, prepared.ordinal),
    effectiveDeadlineAtMs,
    disposeLateResolvedHandle(session),
  );
  if (resolutionWork.status === 'PENDING_AT_DEADLINE') {
    return stop('SCROLL_PREPARATION_DEADLINE');
  }
  const resolution = resolutionWork.value;
  if (resolution.status !== 'FOUND') {
    return skipped;
  }
  const { reference } = resolution;
  /** 下準備の handle で対象を 1 回観測する。期限切れは undefined、つながっていなければ null。 */
  const observe = async (): Promise<InteractionCandidate | null | undefined> => {
    const inspectionWork = await awaitBrowserWork(
      () => inspectInteractionCandidateHandle(reference, prepared.ordinal),
      effectiveDeadlineAtMs,
    );
    if (inspectionWork.status === 'PENDING_AT_DEADLINE') {
      return undefined;
    }
    return inspectionWork.value.status === 'CONNECTED' ? inspectionWork.value.candidate : null;
  };
  try {
    // 下準備の handle が、探索で見つけた候補と同じ要素かを、スクロールの前に確かめる（R5 の N-4）。探索と解決の間に別の要素が差し込まれた
    // 場合に、別の要素を下準備しないためである。同じ要素でなければ、下準備をせずに（SKIPPED）、凍結の後のこれまでと同じ判定に任せる。
    const identity = await observe();
    if (identity === undefined) {
      return stop('SCROLL_PREPARATION_DEADLINE');
    }
    if (identity === null || identity.candidateId !== prepared.candidateId) {
      return skipped;
    }
    try {
      const scrollWork = await awaitBrowserWork(
        () => reference.handle.scrollIntoViewIfNeeded({ timeout: Math.max(1, effectiveDeadlineAtMs - Date.now()) }),
        effectiveDeadlineAtMs,
      );
      if (scrollWork.status === 'PENDING_AT_DEADLINE') {
        return stop('SCROLL_PREPARATION_DEADLINE');
      }
      // 対象に hover し、hover の後の状態を押す前の状態にする（設計書 2026-09-23 4.4.1）。CSS の `:hover` や JavaScript の hover の処理による
      // 変化を、押す前と後の差に出さないためである。
      const hoverWork = await awaitBrowserWork(
        () => reference.handle.hover({ timeout: Math.max(1, effectiveDeadlineAtMs - Date.now()) }),
        effectiveDeadlineAtMs,
      );
      if (hoverWork.status === 'PENDING_AT_DEADLINE') {
        return stop('SCROLL_PREPARATION_DEADLINE');
      }
    } catch (error) {
      return stopByError(error);
    }
    // スクロールと hover の後の最初の描画で IntersectionObserver の通知が task として積まれるので、次の描画まで待ち、遅延読み込みなどの通信を
    // 凍結の前（Passive フェーズ）に始めさせる。
    for (let frame = 0; frame < SCROLL_PREPARATION_SETTLE_FRAMES; frame += 1) {
      if (!await awaitInitialRender(session.page, effectiveDeadlineAtMs)) {
        return stop('SCROLL_PREPARATION_DEADLINE');
      }
    }
    // hover の後の同じ要素の候補の ID を、凍結の後の探し直しの目印にする（hover で文字が変わる対象は、別の候補の ID になるため。R5 の N-4）。
    const hovered = await observe();
    if (hovered === undefined) {
      return stop('SCROLL_PREPARATION_DEADLINE');
    }
    return hovered === null ? skipped : Object.freeze({ status: 'PREPARED', candidateId: hovered.candidateId });
  } finally {
    await disposeRetainedHandleUntil(session, reference.handle, effectiveDeadlineAtMs);
  }
}

/**
 * 隔離された Context で対象のページを読み込み、初期描画を待つ（設計書 2026-09-23 4.4.1、R6 の I-2）。どちらも読み込みの期限
 * （`navigationDeadlineAtMs`）で待つ。期限を過ぎた場合は、読み込みの期限切れと分かる理由の NOT_VERIFIABLE を返し、終えた場合は null を返す。
 * 読み込みのほかの失敗は、そのまま投げる（`auditInteraction` が EXECUTION_FAILED にする）。
 * `afterTargetLoad` を渡した場合は、読み込みの前に main frame の文書の追跡を付け、読み込みの結果（応答は `FULFILLED`、例外は `REJECTED`）から
 * 観測を作って渡し、追跡を外す（サイトが応答しないときに Run を止める設計書 2.1）。読み込みを始めなかった場合は、呼ばない。
 */
async function loadInteractionTarget(
  session: InteractionAuditSession,
  targetUrl: string,
  candidate: InteractionCandidate,
  navigationDeadlineAtMs: number,
  afterTargetLoad: InteractionAuditInput['afterTargetLoad'],
): Promise<ClassifiedWorkOutcome | null> {
  const navigationBudgetMs = Math.max(0, navigationDeadlineAtMs - Date.now());
  if (navigationBudgetMs === 0) {
    return notVerifiable('INITIAL_LOAD_BEFORE_LOAD', emptyEvidence(candidate));
  }
  const tracker = afterTargetLoad === undefined ? null : trackMainFrameDocument(session.page);
  let loaded: MainFrameLoadSettlement;
  try {
    loaded = await settleMainFrameLoad(session.page, targetUrl, { waitUntil: 'load', timeoutMs: navigationBudgetMs });
    if (tracker !== null && afterTargetLoad !== undefined) {
      afterTargetLoad(observeMainFrameLoad(tracker, loaded));
    }
  } finally {
    tracker?.dispose();
  }
  if (loaded.status === 'REJECTED') {
    if (isPlaywrightTimeoutError(loaded.reason)) {
      return notVerifiable('INITIAL_LOAD_DURING_LOAD', emptyEvidence(candidate));
    }
    throw loaded.reason;
  }
  if (Date.now() >= navigationDeadlineAtMs) {
    return notVerifiable('INITIAL_LOAD_AFTER_LOAD', emptyEvidence(candidate));
  }
  if (!await awaitInitialRender(session.page, navigationDeadlineAtMs)) {
    return notVerifiable('INITIAL_LOAD_BEFORE_RENDER', emptyEvidence(candidate));
  }
  return null;
}

/**
 * COV-4 の区切り 3（入れ子の開いた状態。設計者の判断 2026-11-10）: 凍結の中で、押下の並びを順に押し直す。各押下は、探し直して同じ候補の ID と順番の要素を見つけ、
 * 安全の判定（`classifyInteractionCandidate`）で拒む要素は押さず、押した後はページの落ち着き（`waitForPageSettled` と口ごとの静まり）を待つ。見つからない・
 * 拒む・押せない・期限を過ぎたら偽（押し直しが再現しない）。凍結の中なので、押下が出す送信は Guard が止める（止めた事実は Ledger に残り、呼び出し側が見る）。
 */
async function replayPressTrail(
  session: InteractionAuditSession,
  trail: readonly InteractionPressStep[],
  deadlineAtMs: number,
  progress: ProgressSignals | undefined,
): Promise<boolean> {
  for (const step of trail) {
    if (Date.now() >= deadlineAtMs || session.isClosed()) {
      return false;
    }
    const discovered = await discoverInteractionCandidates(session.page, undefined, deadlineAtMs);
    const found = discovered.candidates.find(({ candidateId, ordinal }) => candidateId === step.candidateId && ordinal === step.ordinal);
    if (found === undefined || classifyInteractionCandidate(found).action === 'REJECT') {
      return false;
    }
    const resolution = await resolveInteractionCandidateHandle(session.page, step.ordinal, undefined, deadlineAtMs);
    if (resolution.status !== 'FOUND') {
      return false;
    }
    // 落ち着きの待ちのためだけなので、要求ごとの記録を持たない口にする（設計者の判断 2026-11-11）。
    const network = DataActivityCollector.attach(session.page);
    try {
      await resolution.reference.handle.click({ timeout: Math.max(1, deadlineAtMs - Date.now()) });
      await waitForPageSettled(session.page, {
        deadlineAtMs,
        ...PAGE_SETTLING_PACING,
        ...(progress === undefined ? {} : { progress }),
        dataActivity: () => network.dataRequestActivity(),
      });
    } catch {
      return false;
    } finally {
      network.detach();
      await resolution.reference.handle.dispose().catch(() => undefined);
    }
  }
  return true;
}

async function executeInteraction(
  session: InteractionAuditSession,
  input: InteractionAuditInput,
  candidate: InteractionCandidate,
  navigationDeadlineAtMs: number,
): Promise<ClassifiedWorkOutcome> {
  const loadFailure = await loadInteractionTarget(
    session,
    input.targetUrl,
    candidate,
    navigationDeadlineAtMs,
    input.afterTargetLoad,
  );
  if (loadFailure !== null) {
    return loadFailure;
  }
  // Interaction の期限は、読み込みと初期描画が終わったここから数える（設計書 2026-09-23 4.4.1、R6 の I-2）。
  // 読み込みの遅いページで、読み込みの時間が、下準備・click・押した後の観測の時間を削らないようにするためである。
  const effectiveDeadlineAtMs = deadlineWithinTimeoutAtMs(input.deadlineAtMs, input.timeoutMs);
  const remaining = (): number => Math.max(0, effectiveDeadlineAtMs - Date.now());
  // SPEC-5: 凍結の後、click を始める前の期限切れは、どの段（探し直し・handle の解決・押す前の観測）でも 1 つの理由にする。
  const deadlineBeforeClick = (evidence: InteractionChangeEvidence): ClassifiedWorkOutcome => notVerifiable(
    'DEADLINE_BEFORE_EXACT_NODE_CLICK',
    evidence,
  );
  // L10・SPEC-5: DOM の作業量は数えない（前の上限と、1 回の audit で共有する作業量の差し引き（`maxDomWork`）は撤廃した）。読み取りの部品に上限を
  // 渡さないので、部品は作業量の上限に達した結果（`DOM_WORK_BUDGET_REACHED`）を返さない。
  // COV-4 の区切り 3（入れ子の開いた状態）: 押し直す並びがあれば、凍結してから押し直し、同じ構造まで再現したかを確かめる。凍結の前の下準備は、凍結の後に行う。
  const nested = (input.pressTrail?.length ?? 0) > 0;
  if (nested) {
    await activateFreezeBeforeDeadline(session, input.freezeActivationTimeoutMs ?? CONTEXT_CLOSE_TIMEOUT_MS);
    // REV-SD の I-1: 押し直す前に、範囲の外へ移った page では押さない。
    if (movedOutsideAuditScope(session, input)) {
      return notVerifiable('INITIAL_LOAD_AFTER_LOAD', emptyEvidence(candidate), OUTSIDE_AUDIT_SCOPE_DETAIL);
    }
    const replayed = await replayPressTrail(session, input.pressTrail ?? [], effectiveDeadlineAtMs, input.progress);
    if (hasFreezeEvent(session.ledger.snapshot())) {
      return outcome('BLOCKED_BY_SAFETY', 'SAFETY_FREEZE_BLOCKED', null, emptyEvidence(candidate));
    }
    if (!replayed || (input.verifyTrail !== undefined && !(await input.verifyTrail(session.page)))) {
      return notVerifiable('TRAIL_NOT_REPRODUCED', emptyEvidence(candidate));
    }
  }
  // REV-SD の I-1: 下準備（スクロール・hover）の前にも見直す。
  if (movedOutsideAuditScope(session, input)) {
    return notVerifiable('INITIAL_LOAD_AFTER_LOAD', emptyEvidence(candidate), OUTSIDE_AUDIT_SCOPE_DETAIL);
  }
  const preparation = await prepareTarget(session, candidate, effectiveDeadlineAtMs);
  if (preparation.status === 'STOPPED') {
    return preparation.outcome;
  }
  if (!nested) {
    await activateFreezeBeforeDeadline(session, input.freezeActivationTimeoutMs ?? CONTEXT_CLOSE_TIMEOUT_MS);
  }

  const rediscoveryWork = await awaitBrowserWork(() => discoverInteractionCandidates(session.page), effectiveDeadlineAtMs);
  if (rediscoveryWork.status === 'PENDING_AT_DEADLINE' || remaining() === 0) {
    return deadlineBeforeClick(emptyEvidence(candidate));
  }
  // 下準備を終えた場合は、下準備の handle で読んだ、hover の後の同じ要素の候補の ID を目印にして探し直す（R5 の N-4）。
  // hover で文字が変わる対象は、同じ要素でも、凍結の前の探索とは別の候補の ID になるためである。受け入れの判定は、この後に行う。
  const expectedCandidateId = preparation.status === 'PREPARED' ? preparation.candidateId : candidate.candidateId;
  const matching = rediscoveryWork.value.candidates.filter((item) => item.candidateId === expectedCandidateId);
  if (matching.length === 0) {
    return notVerifiable('CANDIDATE_IDENTITY_NOT_REDISCOVERED', emptyEvidence(candidate, 'MISSING'));
  }
  if (matching.length !== 1) {
    return notVerifiable('CANDIDATE_IDENTITY_AMBIGUOUS', emptyEvidence(candidate, 'AMBIGUOUS'));
  }
  const before = matching[0] as InteractionCandidate;
  const resolutionWork = await awaitBrowserWork(
    () => resolveInteractionCandidateHandle(session.page, before.ordinal),
    effectiveDeadlineAtMs,
    disposeLateResolvedHandle(session),
  );
  if (resolutionWork.status === 'PENDING_AT_DEADLINE') {
    return deadlineBeforeClick(emptyEvidence(before));
  }
  const resolution = resolutionWork.value;
  if (resolution.status !== 'FOUND') {
    return notVerifiable('TARGET_HANDLE_NOT_RESOLVED', emptyEvidence(before, 'MISSING'));
  }
  const targetReference = resolution.reference;

  try {
    const resolvedSnapshotWork = await awaitBrowserWork(
      () => inspectInteractionCandidateHandle(targetReference, before.ordinal),
      effectiveDeadlineAtMs,
    );
    if (resolvedSnapshotWork.status === 'PENDING_AT_DEADLINE' || remaining() === 0) {
      return deadlineBeforeClick(emptyEvidence(before));
    }
    const resolvedSnapshot = resolvedSnapshotWork.value;
    if (resolvedSnapshot.status !== 'CONNECTED') {
      return notVerifiable('TARGET_DISCONNECTED_BEFORE_ADMISSION', emptyEvidence(before, 'MISSING'));
    }
    const resolvedCandidate = resolvedSnapshot.candidate;
    // click の前の、対象の状態（候補の事実、対象自身の属性、親の details の開閉）。click の後の 1 回の観測と比べる（設計書 2026-09-23 4.4.1、SPEC-5）。
    // 下準備で hover をした後に取るので、hover による変化は、前後の差に出ない。
    const observationBeforeClick: TargetObservation = Object.freeze({
      candidate: resolvedCandidate,
      attributes: resolvedSnapshot.attributes,
      detailsOpen: resolvedSnapshot.detailsOpen,
    });
    if (resolvedCandidate.candidateId !== before.candidateId) {
      return notVerifiable('TARGET_CHANGED_DURING_EXACT_NODE_RESOLUTION', emptyEvidence(before));
    }
    const exactAdmission = classifyInteractionCandidate(resolvedCandidate);
    if (exactAdmission.action === 'REJECT') {
      const ledgerRecord = interactionRejectionLedgerRecord(exactAdmission.reason);
      // `isBlockedExternalActionReason` は、記録先の判断（`interactionRejectionLedgerRecord`）と一致する（テストで確かめる）。
      // ここでは、理由を記録の閉じた型（CC-014）に絞り込むためだけに使う。
      if (ledgerRecord === 'BLOCKED_EXTERNAL_ACTION' && isBlockedExternalActionReason(exactAdmission.reason)) {
        session.ledger.recordBlockedExternalAction({
          candidateId: resolvedCandidate.candidateId,
          url: resolvedCandidate.href,
          reason: exactAdmission.reason,
        });
      } else if (ledgerRecord === 'EXCLUDED_CANDIDATE') {
        session.ledger.recordExcludedInteractionCandidate({
          candidateId: resolvedCandidate.candidateId,
          reason: exactAdmission.reason,
        });
      }
      return outcome('REJECTED_UNSAFE', exactAdmission.reason, null, matchedPreInteractionEvidence(resolvedCandidate));
    }
    // 凍結の前に下準備をしていない対象（凍結の後に現れた要素など）は、押さない。
    if (preparation.status !== 'PREPARED') {
      return notVerifiable('TARGET_NOT_SCROLL_PREPARED', emptyEvidence(resolvedCandidate));
    }
    // REV-SD の I-1: 押す直前に、main frame の URL を見直す（範囲の外へ移った page では押さない）。
    if (movedOutsideAuditScope(session, input)) {
      return notVerifiable('INITIAL_LOAD_AFTER_LOAD', emptyEvidence(resolvedCandidate), OUTSIDE_AUDIT_SCOPE_DETAIL);
    }

    const clickBudgetMs = remaining();
    if (clickBudgetMs === 0) {
      return deadlineBeforeClick(emptyEvidence(resolvedCandidate));
    }
    let clickFailure: { readonly error: unknown } | null = null;
    // SPEC-5（設計書 2026-11-14 5.1）: 押した後は、ページの落ち着き（落ち着きの待ちの唯一の部品 `waitForPageSettled` と口ごとの静まり）を待ってから、
    // 1 回だけ観測する。見張りの口がないとき（利用者が期限を指定したとき）も同じく待つ（期限で終わる）。押した後の要求の口ごとの事実は、落ち着きの待ちの
    // ためだけに数える（要求は増やさない。要求ごとの記録は持たない。設計者の判断 2026-11-11）。落ち着かないまま見張りが終えたら、session が閉じられて、
    // この後の観測が失敗する（見張りの理由の NOT_VERIFIABLE になる）。
    const network = DataActivityCollector.attach(session.page);
    try {
      try {
        await targetReference.handle.click({ timeout: clickBudgetMs });
      } catch (error) {
        clickFailure = Object.freeze({ error });
      }
      if (clickFailure === null) {
        await waitForPageSettled(session.page, {
          deadlineAtMs: effectiveDeadlineAtMs,
          ...PAGE_SETTLING_PACING,
          ...(input.progress === undefined ? {} : { progress: input.progress }),
          dataActivity: () => network.dataRequestActivity(),
        });
      }
    } finally {
      network.detach();
    }
    if (hasFreezeEvent(session.ledger.snapshot())) {
      return outcome('BLOCKED_BY_SAFETY', 'SAFETY_FREEZE_BLOCKED', null, emptyEvidence(resolvedCandidate));
    }

    // 押した後の 1 回の観測。保持した要素が切断されていれば、探し直して、置き換えか削除かを記録する（同じ要素とは確かめられない）。
    // 期限までに観測を終えられなければ、観測の結果を持たない（null）。
    let observed: InteractionChangeEvidence | null = null;
    // 保持した対象が切断された場合の詳細（切断の後の identityStatus の値）。
    let identityLossDetail: string | null = null;
    try {
      const retainedSnapshotWork = await awaitBrowserWork(
        () => inspectInteractionCandidateHandle(targetReference, resolvedCandidate.ordinal),
        effectiveDeadlineAtMs,
      );
      if (retainedSnapshotWork.status === 'SETTLED') {
        const retainedSnapshot = retainedSnapshotWork.value;
        if (retainedSnapshot.status === 'CONNECTED') {
          // 対象の位置と大きさの変化は、根拠にしない（`collectInteractionChangeEvidence` は `boundingBox` を数えない）。属性は、ARIA の状態と
          // `open` と class の名前だけを根拠にする（SPEC-5。前はタブだけに当てた決まりを、全部の候補に当てる）。
          observed = collectInteractionChangeEvidence(resolvedCandidate, retainedSnapshot.candidate, {
            difference: targetStateDifference(observationBeforeClick, retainedSnapshot),
          });
        } else {
          const liveCandidatesWork = await awaitBrowserWork(
            () => discoverInteractionCandidates(session.page),
            effectiveDeadlineAtMs,
          );
          if (liveCandidatesWork.status === 'SETTLED') {
            observed = collectDisconnectedInteractionEvidence(resolvedCandidate, liveCandidatesWork.value.candidates);
            identityLossDetail = observed.identityStatus;
          }
        }
      }
    } catch (error) {
      if (hasFreezeEvent(session.ledger.snapshot())) {
        return outcome('BLOCKED_BY_SAFETY', 'SAFETY_FREEZE_BLOCKED', null, emptyEvidence(resolvedCandidate));
      }
      throw error;
    }
    const observedEvidence = observed ?? emptyEvidence(resolvedCandidate);
    if (hasFreezeEvent(session.ledger.snapshot())) {
      return outcome('BLOCKED_BY_SAFETY', 'SAFETY_FREEZE_BLOCKED', null, observedEvidence);
    }
    if (clickFailure !== null) {
      return clickFailureOutcome(clickFailure.error, observedEvidence);
    }
    if (observed === null) {
      return notVerifiable('DEADLINE_DURING_POST_CONDITION_OBSERVATION', observedEvidence);
    }
    if (identityLossDetail !== null) {
      return notVerifiable('RETAINED_IDENTITY_LOST', observed, identityLossDetail);
    }
    return observed.changedFields.length > 0
      ? outcome('VERIFIED', 'OBSERVABLE_STATE_CHANGED', null, observed)
      : notVerifiable('NO_OBSERVABLE_CHANGE', observed);
  } finally {
    await disposeRetainedHandleUntil(session, targetReference.handle, effectiveDeadlineAtMs);
  }
}

export async function auditInteraction(input: InteractionAuditInput): Promise<InteractionAuditResult> {
  if (typeof input.sessionFactory !== 'function') {
    throw new Error('An owner-managed interaction session factory is required');
  }
  positiveFiniteInteger(input.navigationTimeoutMs, 'Interaction navigation timeout');
  positiveFiniteInteger(input.timeoutMs, 'Interaction timeout');
  const sessionOpenTimeoutMs = input.sessionOpenTimeoutMs ?? SESSION_OPEN_TIMEOUT_MS;
  positiveFiniteInteger(sessionOpenTimeoutMs, 'Interaction session open timeout');
  positiveFiniteInteger(input.freezeActivationTimeoutMs ?? CONTEXT_CLOSE_TIMEOUT_MS, 'Interaction freeze activation timeout');
  positiveFiniteInteger(input.cleanupTimeoutMs ?? input.timeoutMs, 'Interaction cleanup timeout');
  const { releaseLateSessionFailure } = input;
  if (releaseLateSessionFailure !== undefined && typeof releaseLateSessionFailure !== 'function') {
    throw new Error('The receiver of late interaction session failures must be a function');
  }
  if (input.afterTargetLoad !== undefined && typeof input.afterTargetLoad !== 'function') {
    throw new Error('The receiver of the interaction target load observation must be a function');
  }
  if (!Number.isFinite(input.deadlineAtMs)) {
    throw new Error('Interaction deadline must be finite');
  }
  let targetUrl: URL;
  try {
    targetUrl = new URL(input.targetUrl);
  } catch {
    throw new Error('Interaction target URL must be absolute');
  }
  if (!isHttpProtocol(targetUrl.protocol)) {
    throw new Error('Interaction target URL must use HTTP(S)');
  }
  const candidate = freezeInteractionCandidate(input.candidate);
  const viewport = immutableViewport(input.viewport);
  // 読み込みの期限。Interaction の期限（`timeoutMs`）は、読み込みと初期描画の後に数え始める（R6 の I-2）。
  const navigationDeadlineAtMs = deadlineWithinTimeoutAtMs(input.deadlineAtMs, input.navigationTimeoutMs);
  if (navigationDeadlineAtMs <= Date.now()) {
    throw new Error('Interaction deadline has already expired');
  }

  // session の作成は、候補の予算の中（読み込みの期限と、今から `sessionOpenTimeoutMs` 後の早い方）で待つ（DEF-008）。
  // 期限の中の失敗は、今までどおり、そのまま投げる。期限を過ぎた場合は NOT_VERIFIABLE を返し、遅れて届いた session は閉じ、
  // 遅れて届いた失敗は受け取る口に渡す（Context を持つ失敗の Context は、呼び出し側が閉じる）。
  const sessionOpenDeadlineAtMs = deadlineWithinTimeoutAtMs(navigationDeadlineAtMs, sessionOpenTimeoutMs);
  const opened = await awaitBrowserWork(
    () => input.sessionFactory(viewport),
    sessionOpenDeadlineAtMs,
    closeLateSession,
    (error) => releaseLateSessionFailure?.(error),
  );
  if (opened.status === 'PENDING_AT_DEADLINE') {
    return sessionOpenDeadlineResult(candidate);
  }
  const session = opened.value;
  // L5: 進みの見張りの口があれば、隔離した page の変化に印を付け、見張りが終えたら session を閉じて待ちを終わらせる（閉じる処理の失敗は、後片付けが記録する）。
  const { progress } = input;
  const detachProgress = progress === undefined ? (): void => undefined : attachPageProgressSignals(session.page, progress);
  const closeOnWatchEnd = (): void => {
    void session.close().catch(() => undefined);
  };
  if (progress !== undefined) {
    if (progress.signal.aborted) {
      closeOnWatchEnd();
    } else {
      progress.signal.addEventListener('abort', closeOnWatchEnd, { once: true });
    }
  }
  let classifiedWork: ClassifiedWorkOutcome;
  try {
    classifiedWork = await executeInteraction(session, input, candidate, navigationDeadlineAtMs);
  } catch (error) {
    classifiedWork = outcome('EXECUTION_FAILED', 'EXECUTION_FAILED', interactionFailureDetail(error), emptyEvidence(candidate));
  } finally {
    progress?.signal.removeEventListener('abort', closeOnWatchEnd);
    detachProgress();
  }
  // L5: 見張りが終えて、確かめを終えられなかった（NOT_VERIFIABLE・EXECUTION_FAILED。閉じた session で失敗した）操作は、見張りの理由にする。確かめ終えた結果
  // （VERIFIED）・安全の判定（REJECTED_UNSAFE・BLOCKED_BY_SAFETY）は変えない（凍結の失敗の fail-closed は、閉じた session のまま変わらない）。
  const stageEnd = interactionStageEndReasonOf(progress?.signal);
  if (stageEnd !== null && (classifiedWork.work.status === NOT_VERIFIABLE_STATUS || classifiedWork.work.status === 'EXECUTION_FAILED')) {
    classifiedWork = notVerifiable(stageEnd, classifiedWork.work.evidence);
  }
  // COV-4 の区切り 3: 操作の後の文書の URL（文書が替わらずに URL が変わったら、巡回の辺にする）。閉じた session からは読まない。
  let postInteractionUrl: string | undefined;
  if (!session.isClosed()) {
    try {
      postInteractionUrl = session.page.url();
    } catch {
      postInteractionUrl = undefined;
    }
  }
  // COV-4 の区切り 3（設計者の判断 2026-11-10）: 確かめ終えた（VERIFIED）操作で開いた状態に、呼び出し側が今の段を当てる（凍結したままの page。読み込み直さない）。
  // 当てる処理の失敗は、操作の結果を変えない（呼び出し側が自分の記録に残す）。
  if (classifiedWork.work.status === 'VERIFIED' && input.afterVerified !== undefined && !session.isClosed() && progress?.signal.aborted !== true) {
    try {
      await input.afterVerified(session.page);
    } catch {
      // 開いた状態の監査の失敗で、後片付けを止めない。
    }
  }

  let cleanupAnomaly = false;
  // 最新の閉じる処理の異常の、lifecycle の理由（コードと詳細）。異常がなければ null。
  let latestCleanupAnomalyReason: { readonly reason: InteractionLifecycleReasonCode; readonly reasonDetail: string | null } | null =
    null;
  let lastCloseRejected = false;
  let lastCloseError: unknown;
  let latestCleanupAnomaly: InteractionCleanupFailure['anomaly'] = 'FULFILLED_NON_TERMINAL';
  let attemptsStarted = 0;
  const cleanupStartedAtMs = Date.now();
  // L5: 後片付けの期限は、操作の期限から切り離せる（`cleanupTimeoutMs`。省略は操作の期限）。
  const cleanupTimeoutMs = input.cleanupTimeoutMs ?? input.timeoutMs;
  const cleanupDeadlineAtMs = cleanupStartedAtMs + cleanupTimeoutMs;
  const firstAttemptDeadlineAtMs = cleanupStartedAtMs + Math.floor(cleanupTimeoutMs / 2);
  const finishClosed = (): InteractionAuditResult => {
    const lifecycle = closedLifecycle(latestCleanupAnomalyReason?.reason ?? null, latestCleanupAnomalyReason?.reasonDetail ?? null);
    const finalSafety = session.ledger.snapshot();
    const finalOutcome = finalizeInteractionOutcome(classifiedWork, cleanupAnomaly, finalSafety);
    return Object.freeze({
      candidateId: candidate.candidateId,
      status: finalOutcome.status,
      reason: finalOutcome.reason,
      reasonDetail: finalOutcome.reasonDetail,
      evidence: classifiedWork.work.evidence,
      work: classifiedWork.work,
      lifecycle,
      notVerifiableKind: finalOutcome.notVerifiableKind,
      safety: finalSafety,
      ...(postInteractionUrl === undefined ? {} : { postInteractionUrl }),
    });
  };
  const throwCleanupFailure = (
    kind: InteractionCleanupFailure['kind'],
  ): never => {
    const deadlineReached = Date.now() >= cleanupDeadlineAtMs;
    if (kind === 'DEADLINE_EXCEEDED') {
      session.ledger.recordInvariantViolation({
        code: 'INTERACTION_OWNER_CLEANUP_DEADLINE_EXCEEDED',
        message: INTERACTION_OWNER_CLEANUP_DEADLINE_MESSAGE,
      });
    } else {
      session.ledger.recordInvariantViolation({
        code: 'INTERACTION_OWNER_CLEANUP_RETRY_EXHAUSTED',
        message: INTERACTION_OWNER_CLEANUP_EXHAUSTED_MESSAGE,
      });
    }
    const lifecycle = nonTerminalLifecycle(
      latestCleanupAnomalyReason?.reason ?? 'OWNER_CLOSE_NON_TERMINAL',
      latestCleanupAnomalyReason?.reasonDetail ?? null,
    );
    const finalSafety = session.ledger.snapshot();
    const cleanup: InteractionCleanupFailure = Object.freeze({
      kind,
      attemptsStarted,
      deadlineAtMs: cleanupDeadlineAtMs,
      deadlineReached,
      anomaly: latestCleanupAnomaly,
      lastCloseRejected,
      lastCloseError,
    });
    throw new InteractionOwnerCleanupError({
      session,
      candidateId: candidate.candidateId,
      work: classifiedWork.work,
      lifecycle,
      safety: finalSafety,
      lastCloseRejected,
      lastCloseError,
      cleanup,
    });
  };
  for (let attempt = 0; attempt < INTERACTION_OWNER_CLOSE_ATTEMPT_LIMIT; attempt += 1) {
    lastCloseRejected = false;
    lastCloseError = undefined;
    attemptsStarted += 1;
    const attemptDeadlineAtMs = attempt === 0 ? firstAttemptDeadlineAtMs : cleanupDeadlineAtMs;
    const closeSettlement = await observeCloseUntil(containedCloseSettlement(session), attemptDeadlineAtMs);
    if (closeSettlement.status === 'REJECTED') {
      lastCloseRejected = true;
      lastCloseError = closeSettlement.error;
      cleanupAnomaly = true;
      latestCleanupAnomaly = 'REJECTED';
      latestCleanupAnomalyReason = Object.freeze({
        reason: 'OWNER_CLOSE_FAILED',
        reasonDetail: interactionFailureDetail(closeSettlement.error),
      });
      session.ledger.recordInvariantViolation({
        code: 'INTERACTION_OWNER_CLOSE_FAILED',
        message: interactionFailureMessage(closeSettlement.error, OWNER_CLOSE_FAILURE_FALLBACK_MESSAGE),
      });
    } else if (closeSettlement.status === 'TIMED_OUT') {
      cleanupAnomaly = true;
      latestCleanupAnomaly = 'TIMED_OUT';
      latestCleanupAnomalyReason = Object.freeze({ reason: 'OWNER_CLOSE_TIMED_OUT', reasonDetail: null });
      session.ledger.recordInvariantViolation({
        code: 'INTERACTION_OWNER_CLOSE_TIMED_OUT',
        message: INTERACTION_OWNER_CLOSE_TIMEOUT_MESSAGE,
      });
    }

    const terminal = session.isClosed();
    if (closeSettlement.status === 'FULFILLED' && !terminal) {
      cleanupAnomaly = true;
      latestCleanupAnomaly = 'FULFILLED_NON_TERMINAL';
      latestCleanupAnomalyReason = Object.freeze({ reason: 'OWNER_CLOSE_NON_TERMINAL', reasonDetail: null });
      session.ledger.recordInvariantViolation({
        code: 'INTERACTION_OWNER_CLOSE_NON_TERMINAL',
        message: INTERACTION_OWNER_CLOSE_NON_TERMINAL_MESSAGE,
      });
    }
    if (terminal) {
      return finishClosed();
    }
    if (attempt === 0) {
      await yieldMacrotask();
      if (session.isClosed()) {
        return finishClosed();
      }
      if (Date.now() >= cleanupDeadlineAtMs) {
        throwCleanupFailure('DEADLINE_EXCEEDED');
      }
    }
  }

  return throwCleanupFailure(
    Date.now() >= cleanupDeadlineAtMs ? 'DEADLINE_EXCEEDED' : 'ATTEMPT_BUDGET_EXHAUSTED',
  );
}

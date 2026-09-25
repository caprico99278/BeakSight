import type { Page } from 'playwright';
import type { InteractionGuardedSession } from '../browser/context-factory.js';
import { isPlaywrightTimeoutError } from '../browser/playwright-errors.js';
import type { Viewport } from '../config/types.js';
import type { InteractionStatus } from '../core/contracts.js';
import { awaitBeforeDeadline, wait, yieldMacrotask } from '../core/deadline.js';
import { safeErrorMessage } from '../core/errors.js';
import {
  CONTEXT_CLOSE_TIMEOUT_MS,
  INTERACTION_PERSISTENCE_WINDOW_MS,
  INTERACTION_STABILITY_WINDOW_MS,
  SESSION_OPEN_TIMEOUT_MS,
} from '../core/limits.js';
import type {
  InteractionChangeEvidence,
  InteractionClosedLifecycle,
  InteractionEvidence,
  InteractionLifecycleReasonCode,
  InteractionNotVerifiableKind,
  InteractionNotVerifiableReasonCode,
  InteractionReasonCodeFor,
  InteractionWorkOutcome,
} from '../core/evidence-types.js';
import { isPositiveSafeInteger, isNonNegativeSafeInteger } from '../core/guards.js';
import { normalizeWhitespace, truncateText } from '../core/text.js';
import { isHttpProtocol } from '../crawl/normalize-url.js';
import {
  collectInteractionChangeEvidence,
  collectDisconnectedInteractionEvidence,
  interactionGeometryChanged,
  interactionStateChanges,
  interactionTargetStateChanged,
  retainPersistentInteractionChanges,
  type InteractionInstability,
  type InteractionStateDifference,
} from '../evidence/interaction-collector.js';
import { isBlockedExternalActionReason, SafetyLedger, type SafetyLedgerSnapshot } from '../safety/safety-ledger.js';
import {
  classifyInteractionCandidate,
  freezeInteractionCandidate,
  INTERACTION_CANDIDATE_LIMITS,
  interactionRejectionLedgerRecord,
  type InteractionCandidate,
} from '../safety/interaction-policy.js';
import {
  changedInteractionAttributeNames,
  changedInteractionClassNames,
  compareInteractionScrollRecords,
  discoverInteractionCandidates,
  hasExplicitTabRole,
  inspectInteractionCandidateHandle,
  resolveInteractionCandidateHandle,
  type InteractionAttributeRecord,
  type InteractionHandleResolution,
  type InteractionScrollComparison,
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

/** 理由の詳細（`reasonDetail`）と、Ledger に記録する文言の、長さの上限。 */
const MAX_INTERACTION_REASON_LENGTH = 512;
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
 * 型（`satisfies`）で、一覧のすべてのコードに区分があり、一覧にないコードがないことを保証する。
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

  // 凍結の前の下準備（スクロール・hover・focus・落ち着くのを待つ）。
  SCROLL_PREPARATION_DEADLINE: 'CHECK_NOT_COMPLETED',
  SCROLL_PREPARATION_DOM_WORK_EXHAUSTED: 'CHECK_NOT_COMPLETED',
  /** 下準備のスクロールの失敗。詳細は、整えたエラーの文言。文言から詳細に使える部分が残らなければ、詳細は null。 */
  SCROLL_PREPARATION_FAILED: 'CHECK_NOT_COMPLETED',
  SCROLL_PREPARATION_SETTLE_DEADLINE: 'CHECK_NOT_COMPLETED',
  HOVER_PREPARATION_DEADLINE: 'CHECK_NOT_COMPLETED',
  /** 下準備の hover の失敗。詳細の作り方は `SCROLL_PREPARATION_FAILED` と同じ。 */
  HOVER_PREPARATION_FAILED: 'CHECK_NOT_COMPLETED',
  FOCUS_PREPARATION_DEADLINE: 'CHECK_NOT_COMPLETED',
  /** 下準備の focus の失敗。詳細の作り方は `SCROLL_PREPARATION_FAILED` と同じ。 */
  FOCUS_PREPARATION_FAILED: 'CHECK_NOT_COMPLETED',
  FOCUS_PREPARATION_DOM_WORK_EXHAUSTED: 'CHECK_NOT_COMPLETED',
  FOCUS_PREPARATION_TARGET_DISCONNECTED: 'CHECK_NOT_COMPLETED',
  FOCUS_PREPARATION_CANDIDATE_LIMIT_REACHED: 'CHECK_NOT_COMPLETED',
  FOCUS_PREPARATION_TEXT_NODE_LIMIT_REACHED: 'CHECK_NOT_COMPLETED',
  /**
   * 下準備の focus の前後で、対象の ARIA の状態か `aria-controls` の先の表示の状態が変わった（R8 の Important-2）。
   * この変化は、click で起きる変化と区別できないので、凍結せずに終える。サイトの振る舞いのために確かめられないと結論した場合である。
   */
  FOCUS_PREPARATION_STATE_CHANGED: 'OBSERVED_NO_CHANGE',
  /** 下準備の focus の前後の、対象の状態を比べられない（fail-closed。R8 の Important-2）。 */
  FOCUS_PREPARATION_STATE_UNCOMPARABLE: 'CHECK_NOT_COMPLETED',

  // 凍結の前の安定性の確認（同じ要素かの確認を含む）。
  /** 安定性の確認を、期限までに終えられない（始める時点で時間が足りない場合を含む）。 */
  STABILITY_CHECK_DEADLINE: 'CHECK_NOT_COMPLETED',
  STABILITY_CHECK_DOM_WORK_EXHAUSTED: 'CHECK_NOT_COMPLETED',
  STABILITY_CHECK_TARGET_DISCONNECTED: 'CHECK_NOT_COMPLETED',
  STABILITY_CHECK_CANDIDATE_LIMIT_REACHED: 'CHECK_NOT_COMPLETED',
  STABILITY_CHECK_TEXT_NODE_LIMIT_REACHED: 'CHECK_NOT_COMPLETED',

  // 凍結の後の、探し直し・handle の解決・受け入れの判定・click。
  DEADLINE_AFTER_SAFETY_FREEZE: 'CHECK_NOT_COMPLETED',
  DEADLINE_DURING_CANDIDATE_REDISCOVERY: 'CHECK_NOT_COMPLETED',
  /** 1回の audit で共有する DOM の作業量の上限を使い切った。 */
  DOM_WORK_EXHAUSTED: 'CHECK_NOT_COMPLETED',
  /** 探し直しが完了しなかった。詳細は、探し直しの completeness の値。 */
  CANDIDATE_REDISCOVERY_INCOMPLETE: 'CHECK_NOT_COMPLETED',
  CANDIDATE_IDENTITY_NOT_REDISCOVERED: 'CHECK_NOT_COMPLETED',
  CANDIDATE_IDENTITY_AMBIGUOUS: 'CHECK_NOT_COMPLETED',
  DEADLINE_BEFORE_TARGET_HANDLE_ACQUISITION: 'CHECK_NOT_COMPLETED',
  DEADLINE_DURING_TARGET_HANDLE_ACQUISITION: 'CHECK_NOT_COMPLETED',
  TARGET_HANDLE_NOT_RESOLVED: 'CHECK_NOT_COMPLETED',
  TARGET_HANDLE_RESOLUTION_DOM_WORK_EXHAUSTED: 'CHECK_NOT_COMPLETED',
  DEADLINE_DURING_TARGET_FACT_COLLECTION: 'CHECK_NOT_COMPLETED',
  TARGET_INSPECTION_DOM_WORK_EXHAUSTED: 'CHECK_NOT_COMPLETED',
  TARGET_INSPECTION_CANDIDATE_LIMIT_REACHED: 'CHECK_NOT_COMPLETED',
  TARGET_INSPECTION_TEXT_NODE_LIMIT_REACHED: 'CHECK_NOT_COMPLETED',
  TARGET_DISCONNECTED_BEFORE_ADMISSION: 'CHECK_NOT_COMPLETED',
  TARGET_CHANGED_DURING_EXACT_NODE_RESOLUTION: 'CHECK_NOT_COMPLETED',
  DEADLINE_DURING_EXACT_NODE_ADMISSION: 'CHECK_NOT_COMPLETED',
  /** 下準備をしなかった（凍結の前に対象を一意に特定できなかったなど）対象が、凍結の後に受け入れられた。click しない。 */
  TARGET_NOT_SCROLL_PREPARED: 'CHECK_NOT_COMPLETED',
  DEADLINE_BEFORE_EXACT_NODE_CLICK: 'CHECK_NOT_COMPLETED',
  /**
   * click が期限切れになった。詳細は、整えた click のエラーの文言（残らなければ null）。click のほかの失敗は、
   * EXECUTION_FAILED の `CLICK_FAILED` で、コードで見分けられる。
   */
  CLICK_TIMED_OUT: 'CHECK_NOT_COMPLETED',

  // click の後の観測。
  /** click の後の観測を1回も終えないうちに、期限が切れた。 */
  DEADLINE_BEFORE_POST_CONDITION_OBSERVATION: 'CHECK_NOT_COMPLETED',
  /** click の後の観測の途中で、期限が切れた（変化の見えない観測を終えた後の期限切れは `NO_OBSERVABLE_CHANGE`）。 */
  DEADLINE_DURING_POST_CONDITION_OBSERVATION: 'CHECK_NOT_COMPLETED',
  /** 持続の確認の時間が、期限までに終わらない。 */
  PERSISTENCE_CHECK_DEADLINE: 'CHECK_NOT_COMPLETED',
  /** click の後の観測を終え、期限まで根拠となる変化が見えなかった。 */
  NO_OBSERVABLE_CHANGE: 'OBSERVED_NO_CHANGE',
  /**
   * 観測できた変化が対象の `boundingBox` の変化だけだった（設計書 2026-09-23 4.4.1、4.4.3）。位置と大きさの変化は、根拠にしない。
   * 対象のスクロールする祖先がスクロールした場合と、スクロールはなく位置か大きさが変わっただけの場合は、観測を終えて変化が見えなかった。
   * スクロールしたかを比べられない場合は、比べる手順を終えられなかったので、CHECK_NOT_COMPLETED に寄せる。
   */
  GEOMETRY_ONLY_CHANGED_WHILE_SCROLLED: 'OBSERVED_NO_CHANGE',
  GEOMETRY_ONLY_CHANGED_SCROLL_UNCOMPARABLE: 'CHECK_NOT_COMPLETED',
  GEOMETRY_ONLY_CHANGED: 'OBSERVED_NO_CHANGE',
  RETAINED_INSPECTION_DOM_WORK_EXHAUSTED: 'CHECK_NOT_COMPLETED',
  RETAINED_INSPECTION_CANDIDATE_LIMIT_REACHED: 'CHECK_NOT_COMPLETED',
  RETAINED_INSPECTION_TEXT_NODE_LIMIT_REACHED: 'CHECK_NOT_COMPLETED',
  /**
   * click の後に、保持した対象が切断され、同じ要素と確かめられなくなった。詳細は、切断の後の identityStatus の値。
   * click と観測を終えたうえで、サイトの振る舞い（対象の置き換えや削除）のために確かめられないと結論した場合である。
   */
  RETAINED_IDENTITY_LOST: 'OBSERVED_NO_CHANGE',
} as const satisfies Readonly<Record<InteractionNotVerifiableReasonCode, InteractionNotVerifiableKind>>);

/**
 * 凍結の前に下準備の handle で対象を観測したときの、凍結せずに終える理由の code。観測の目的（安定性の確認、focus の前後の比較）ごとに持つ。
 * - `deadline`: 観測を期限までに終えられなかった。
 * - `domWorkExhausted`: 観測で、共有の DOM の作業量の上限に達した。
 * - `inspection`: 観測が、対象の事実を得られずに終わった。
 */
interface PreparedObservationReasons {
  readonly deadline: InteractionNotVerifiableReasonCode;
  readonly domWorkExhausted: InteractionNotVerifiableReasonCode;
  readonly inspection: Readonly<
    Record<'DISCONNECTED' | 'CANDIDATE_LIMIT_REACHED' | 'TEXT_NODE_LIMIT_REACHED', InteractionNotVerifiableReasonCode>
  >;
}

/** 安定性の確認（同じ要素かの確認を含む）の観測の理由。 */
const STABILITY_CHECK_OBSERVATION_REASONS: PreparedObservationReasons = Object.freeze({
  deadline: 'STABILITY_CHECK_DEADLINE',
  domWorkExhausted: 'STABILITY_CHECK_DOM_WORK_EXHAUSTED',
  inspection: Object.freeze({
    DISCONNECTED: 'STABILITY_CHECK_TARGET_DISCONNECTED',
    CANDIDATE_LIMIT_REACHED: 'STABILITY_CHECK_CANDIDATE_LIMIT_REACHED',
    TEXT_NODE_LIMIT_REACHED: 'STABILITY_CHECK_TEXT_NODE_LIMIT_REACHED',
  }),
});

/** 下準備の focus の前後の比較（設計書 2026-09-23 4.4.2 手順4、R8 の Important-2）の観測の理由。 */
const FOCUS_PREPARATION_OBSERVATION_REASONS: PreparedObservationReasons = Object.freeze({
  deadline: 'FOCUS_PREPARATION_DEADLINE',
  domWorkExhausted: 'FOCUS_PREPARATION_DOM_WORK_EXHAUSTED',
  inspection: Object.freeze({
    DISCONNECTED: 'FOCUS_PREPARATION_TARGET_DISCONNECTED',
    CANDIDATE_LIMIT_REACHED: 'FOCUS_PREPARATION_CANDIDATE_LIMIT_REACHED',
    TEXT_NODE_LIMIT_REACHED: 'FOCUS_PREPARATION_TEXT_NODE_LIMIT_REACHED',
  }),
});

/** 安定性の確認の間に、対象を観測する間隔。観測のたびに、共有の DOM の作業量を差し引く。 */
const STABILITY_SAMPLE_INTERVAL_MS = 100;
/**
 * 観測できた変化が対象の `boundingBox` の変化だけだった場合の区別（設計書 2026-09-23 4.4.1、4.4.3）。
 * 位置と大きさの変化は、どの場合も VERIFIED の根拠にしない。区別は NOT_VERIFIABLE の理由にだけ使う。
 * - `SCROLLED`・`UNCOMPARABLE`: click の再試行などで、対象のスクロールする祖先がスクロールした場合と、スクロールしたかを判定できない場合。
 * - `GEOMETRY`: スクロールはなく、対象の位置か大きさが変わっただけの場合。
 */
type GeometryOnlyChange = Exclude<InteractionScrollComparison, 'UNCHANGED'> | 'GEOMETRY';

/** `GeometryOnlyChange` ごとの、NOT_VERIFIABLE の理由の code。 */
const GEOMETRY_ONLY_CHANGE_REASONS: Readonly<Record<GeometryOnlyChange, InteractionNotVerifiableReasonCode>> =
  Object.freeze({
    SCROLLED: 'GEOMETRY_ONLY_CHANGED_WHILE_SCROLLED',
    UNCOMPARABLE: 'GEOMETRY_ONLY_CHANGED_SCROLL_UNCOMPARABLE',
    GEOMETRY: 'GEOMETRY_ONLY_CHANGED',
  });
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
/** エスケープシーケンスを除いた後に残る、C0・C1 の制御文字。 */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/gu;
/**
 * 表示の向きを変える、双方向の制御文字。埋め込み・上書き（U+202A〜U+202E）、分離（U+2066〜U+2069）、
 * 向きの印の LRM（U+200E）・RLM（U+200F）・ALM（U+061C）（R6 の M-3）。
 */
const BIDI_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
/** 対になっていないサロゲート（孤立した上位・下位サロゲート）。`u` フラグでは、対になったサロゲートには一致しない（R6 の M-3）。 */
const LONE_SURROGATE_PATTERN = /[\ud800-\udfff]/gu;
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

/**
 * エラーの文言を、切り詰めずに取り出す。切り詰めは、不要な部分を除いた後に `interactionFailureDetail` が行う
 * （先に切り詰めると、途中で切れた ANSI のエスケープシーケンスの断片が残るため）。
 */
function fullErrorMessage(error: unknown): string {
  return safeErrorMessage(error, Number.MAX_SAFE_INTEGER, UNINSPECTABLE_INTERACTION_ERROR_MESSAGE);
}

/** 文言を上限の長さで切り詰める。切り詰めた位置でサロゲートペアが分かれる場合は、残った上位サロゲートも除く（R5 の N-6）。 */
function boundedReason(reason: string): string {
  const { text, truncated } = truncateText(reason, MAX_INTERACTION_REASON_LENGTH);
  if (!truncated) {
    return text;
  }
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

/** 理由の詳細を上限の長さで切り詰める。詳細がなければ null のまま。 */
function boundedReasonDetail(reasonDetail: string | null): string | null {
  return reasonDetail === null ? null : boundedReason(reasonDetail);
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
    work: Object.freeze({ status, reason, reasonDetail: boundedReasonDetail(reasonDetail), evidence }),
    notVerifiableKind: null,
  });
}

/**
 * NOT_VERIFIABLE の作業の結果。区分は、理由のコードから対応表（`INTERACTION_NOT_VERIFIABLE_REASONS`）で決める。
 * 技術的な詳細（completeness の値、identityStatus の値、整えたエラーの文言）は `reasonDetail` に渡す。詳細がなければ null。
 */
function notVerifiable(
  code: InteractionNotVerifiableReasonCode,
  evidence: InteractionChangeEvidence,
  reasonDetail: string | null = null,
): ClassifiedWorkOutcome {
  return Object.freeze({
    work: Object.freeze({
      status: NOT_VERIFIABLE_STATUS,
      reason: code,
      reasonDetail: boundedReasonDetail(reasonDetail),
      evidence,
    }),
    notVerifiableKind: INTERACTION_NOT_VERIFIABLE_REASONS[code],
  });
}

/** 候補の探し直しが完了しなかった場合の結果。詳細は、探し直しの completeness の値。 */
function incompleteRediscovery(completeness: string, evidence: InteractionChangeEvidence): ClassifiedWorkOutcome {
  return notVerifiable('CANDIDATE_REDISCOVERY_INCOMPLETE', evidence, completeness);
}

/** 終端（`CLOSED`）に達した lifecycle。理由がなければ、理由も詳細も null。 */
function closedLifecycle(
  reason: InteractionLifecycleReasonCode | null,
  reasonDetail: string | null = null,
): InteractionClosedLifecycle {
  return Object.freeze({
    status: 'CLOSED',
    reason,
    reasonDetail: reason === null ? null : boundedReasonDetail(reasonDetail),
  });
}

function nonTerminalLifecycle(
  reason: InteractionLifecycleReasonCode,
  reasonDetail: string | null,
): InteractionNonTerminalLifecycle {
  return Object.freeze({
    status: 'NON_TERMINAL',
    reason,
    reasonDetail: boundedReasonDetail(reasonDetail),
  });
}

/**
 * Interaction の失敗の詳細を、エラーの文言から作る。click・下準備・作業の失敗と、owner の close の失敗の詳細（`reasonDetail`）と、
 * Ledger に記録する文言（`interactionFailureMessage`）は、すべてこの関数で整形する。
 * エスケープシーケンス（制御文字列の本体を含む）と、Playwright の `Call log:` から後ろと、双方向の制御文字と、孤立したサロゲートを除き、
 * 残った制御文字と連続する空白を1つの空白にする。何も残らなかった場合は null を返す。
 * 最後に、上限（`MAX_INTERACTION_REASON_LENGTH`）で、サロゲートペアを分けずに切り詰める。
 */
function interactionFailureDetail(error: unknown): string | null {
  const withoutAnsi = fullErrorMessage(error).replace(ANSI_ESCAPE_SEQUENCE_PATTERN, '');
  const callLogAt = withoutAnsi.search(PLAYWRIGHT_CALL_LOG_PATTERN);
  const summary = callLogAt === -1 ? withoutAnsi : withoutAnsi.slice(0, callLogAt);
  const cleaned = normalizeWhitespace(
    summary.replace(BIDI_CONTROL_PATTERN, '').replace(LONE_SURROGATE_PATTERN, '').replace(CONTROL_CHARACTER_PATTERN, ' '),
  );
  return cleaned === '' ? null : boundedReason(cleaned);
}

/** Ledger に記録する失敗の文言。整えたエラーの文言で、何も残らなかった場合は `fallbackMessage`。 */
function interactionFailureMessage(error: unknown, fallbackMessage: string): string {
  return interactionFailureDetail(error) ?? boundedReason(fallbackMessage);
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
 */
function hasFreezeEvent(snapshot: SafetyLedgerSnapshot): boolean {
  return snapshot.blockedInteractionRequests.length > 0
    || snapshot.blockedInteractionNavigations.length > 0
    || snapshot.blockedPopups.length > 0
    || snapshot.blockedDownloads.some(({ reason }) => reason === 'INTERACTION_FROZEN')
    || snapshot.blockedInteractionWebSockets.length > 0
    || snapshot.externalSchemeNavigations.some(({ phase }) => phase === 'INTERACTION');
}

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
      await resolution.handle.dispose();
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

/** 2回の観測の間の、候補の事実の外にある状態の変化。 */
function targetStateDifference(before: TargetObservation, after: TargetObservation): InteractionStateDifference {
  return Object.freeze({
    changedAttributeNames: changedInteractionAttributeNames(before.attributes, after.attributes),
    changedClassNames: changedInteractionClassNames(before.attributes, after.attributes),
    detailsOpen: Object.freeze({ before: before.detailsOpen, after: after.detailsOpen }),
  });
}

/** 安定性の確認で不安定になった項目を集める。 */
class InstabilityRecorder {
  readonly #fields = new Set<string>();
  readonly #attributeNames = new Set<string>();
  readonly #classNames = new Set<string>();

  /** 2回の観測の間に変わった項目を、不安定な項目に加える。class は、中の名前ごとに加える（R6 の M-2）。 */
  record(before: TargetObservation, after: TargetObservation): void {
    const changes = interactionStateChanges(before.candidate, after.candidate, targetStateDifference(before, after));
    for (const field of changes.fields) this.#fields.add(field);
    for (const name of changes.attributeNames) this.#attributeNames.add(name);
    for (const name of changes.classNames) this.#classNames.add(name);
  }

  snapshot(): InteractionInstability {
    return Object.freeze({
      fields: new Set(this.#fields) as ReadonlySet<string>,
      attributeNames: new Set(this.#attributeNames) as ReadonlySet<string>,
      classNames: new Set(this.#classNames) as ReadonlySet<string>,
    });
  }
}

/**
 * 凍結の前の下準備の結果（設計書 2026-09-23 4.4、選択肢 A）。
 * - `SCROLLED`: 対象を画面内にスクロールし、hover し、focus し、ページが落ち着くのを待ち、安定性の確認を終えた。
 *   `observation` は安定性の確認の時間の終わりの対象の状態で、凍結の後の探し直しの目印にする（R5 の N-4）。
 *   `recorder` は、安定性の確認で不安定になった項目を持つ。
 * - `SKIPPED`: 対象を一意に特定できなかった、または受け入れの判定で除外される見込みなので、スクロールしなかった。
 *   結果は凍結の後の、これまでと同じ判定で決まる。受け入れられた場合は、click せずに `NOT_VERIFIABLE` にする。
 * - `STOPPED`: 期限切れ・DOM の作業量の上限・スクロール、hover、focus、安定性の確認の失敗。凍結せずに、その結果で終える。
 */
type ScrollPreparation =
  | {
      readonly status: 'SCROLLED';
      readonly observation: TargetObservation;
      readonly recorder: InstabilityRecorder;
    }
  | { readonly status: 'SKIPPED' }
  | StoppedPreparation;

type StoppedPreparation = { readonly status: 'STOPPED'; readonly outcome: ClassifiedWorkOutcome };

/** 凍結せずに終える結果を作る。`reasonDetail` は、整えたエラーの文言などの詳細（`notVerifiable` と同じ）。 */
type StopPreparation = (code: InteractionNotVerifiableReasonCode, reasonDetail?: string | null) => StoppedPreparation;

interface SharedDomWork {
  readonly remaining: () => number;
  /** 使った作業量を差し引く。上限を使い切った場合は true を返す。 */
  readonly debit: (domWorkUsed: number) => boolean;
}

/**
 * 凍結の前（Passive フェーズ）に、候補を探し直して handle を解決し、期限付きで画面内にスクロールし、期限付きで対象に hover し、
 * focus し、ページが落ち着くのを待ってから、安定性の確認を行い、handle を破棄する。click のときにスクロールが起きないようにし、
 * hover と focus による変化を観測の前の状態に含め、click と関係なく変わる項目を根拠から外すためである（設計書 2026-09-23 4.4.1、4.4.2）。
 * `role="tab"` を明示した要素には focus をせず、それ以外の要素で focus が対象の ARIA の状態か `aria-controls` の先の表示を変えた場合は、
 * 凍結せずに NOT_VERIFIABLE で終える（4.4.2 手順4、R8 の Important-2）。
 * DOM の作業量は、1回の audit で共有する上限から差し引く。この間の通信は Passive フェーズの通信として Guard の判定を受ける。
 * 探索や解決がブラウザから不正な値を受け取った場合は、凍結の後と同じく例外をそのまま投げる。
 */
async function prepareTargetScroll(
  session: InteractionAuditSession,
  candidate: InteractionCandidate,
  effectiveDeadlineAtMs: number,
  domWork: SharedDomWork,
): Promise<ScrollPreparation> {
  const stop: StopPreparation = (code, reasonDetail) => Object.freeze({
    status: 'STOPPED' as const,
    outcome: notVerifiable(code, emptyEvidence(candidate), reasonDetail),
  });
  const skipped: ScrollPreparation = Object.freeze({ status: 'SKIPPED' });

  const discoveryWork = await awaitBrowserWork(
    () => discoverInteractionCandidates(session.page, domWork.remaining()),
    effectiveDeadlineAtMs,
  );
  if (discoveryWork.status === 'PENDING_AT_DEADLINE') {
    return stop('SCROLL_PREPARATION_DEADLINE');
  }
  if (domWork.debit(discoveryWork.value.domWorkUsed)) {
    return stop('SCROLL_PREPARATION_DOM_WORK_EXHAUSTED');
  }
  if (Date.now() >= effectiveDeadlineAtMs) {
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
    () => resolveInteractionCandidateHandle(session.page, prepared.ordinal, domWork.remaining()),
    effectiveDeadlineAtMs,
    disposeLateResolvedHandle(session),
  );
  if (resolutionWork.status === 'PENDING_AT_DEADLINE') {
    return stop('SCROLL_PREPARATION_DEADLINE');
  }
  const resolution = resolutionWork.value;
  const resolutionExhaustedBudget = domWork.debit(resolution.domWorkUsed);
  if (resolution.status !== 'FOUND') {
    return resolutionExhaustedBudget || resolution.status === 'DOM_WORK_BUDGET_REACHED'
      ? stop('SCROLL_PREPARATION_DOM_WORK_EXHAUSTED')
      : skipped;
  }
  try {
    if (resolutionExhaustedBudget) {
      return stop('SCROLL_PREPARATION_DOM_WORK_EXHAUSTED');
    }
    // 下準備の handle が、探索で見つけた候補と同じ要素かを、hover の前に確かめる（R5 の N-4）。安定性の確認で読んだ状態を、
    // 凍結の後の探し直しの目印にするので、探索と解決の間に別の要素が差し込まれた場合に、別の要素を目印にしないためである。
    // 同じ要素でなければ、下準備をせずに（SKIPPED）、凍結の後のこれまでと同じ判定に任せる。
    const identity = await observePreparedTarget(
      resolution.handle,
      prepared.ordinal,
      effectiveDeadlineAtMs,
      domWork,
      stop,
      STABILITY_CHECK_OBSERVATION_REASONS,
    );
    if ('outcome' in identity) {
      return identity;
    }
    if (identity.candidate.candidateId !== prepared.candidateId) {
      return skipped;
    }
    const scrollBudgetMs = Math.max(0, effectiveDeadlineAtMs - Date.now());
    if (scrollBudgetMs === 0) {
      return stop('SCROLL_PREPARATION_DEADLINE');
    }
    try {
      const scrollWork = await awaitBrowserWork(
        () => resolution.handle.scrollIntoViewIfNeeded({ timeout: scrollBudgetMs }),
        effectiveDeadlineAtMs,
      );
      if (scrollWork.status === 'PENDING_AT_DEADLINE') {
        return stop('SCROLL_PREPARATION_DEADLINE');
      }
    } catch (error) {
      return isPlaywrightTimeoutError(error)
        ? stop('SCROLL_PREPARATION_DEADLINE')
        : stop('SCROLL_PREPARATION_FAILED', interactionFailureDetail(error));
    }
    // 対象に hover し、hover の後の状態を観測の前の状態にする（設計書 2026-09-23 4.4.1、4.4.2）。
    // CSS の `:hover` や JavaScript の hover の処理による変化を前後の差に出さないためである。
    // 凍結の前に行うので、hover で始まる通信は Passive フェーズの通信として Guard の判定を受ける。
    const hoverBudgetMs = Math.max(0, effectiveDeadlineAtMs - Date.now());
    if (hoverBudgetMs === 0) {
      return stop('HOVER_PREPARATION_DEADLINE');
    }
    try {
      const hoverWork = await awaitBrowserWork(
        () => resolution.handle.hover({ timeout: hoverBudgetMs }),
        effectiveDeadlineAtMs,
      );
      if (hoverWork.status === 'PENDING_AT_DEADLINE') {
        return stop('HOVER_PREPARATION_DEADLINE');
      }
    } catch (error) {
      return isPlaywrightTimeoutError(error)
        ? stop('HOVER_PREPARATION_DEADLINE')
        : stop('HOVER_PREPARATION_FAILED', interactionFailureDetail(error));
    }
    // hover の後に、対象に focus する（設計書 2026-09-23 4.4.1、R5 の N-3）。focus で付く class や属性
    // （UI の部品集の focus の監視など）を、観測の前の状態に含めるためである。ただし、`role="tab"` を明示した要素には
    // focus をしない（R8 の Important-2）。自動で切り替わるタブは、focus だけで切り替わるためである。
    if (!hasExplicitTabRole(identity.candidate.role)) {
      const focusFailure = await focusPreparedTarget(
        resolution.handle,
        prepared.ordinal,
        effectiveDeadlineAtMs,
        domWork,
        stop,
      );
      if (focusFailure !== null) {
        return focusFailure;
      }
    }
    // ページが落ち着くのを待つ。スクロールと hover の後の最初の描画で IntersectionObserver の通知が task として積まれるので、
    // 次の描画まで待ち、遅延読み込みなどの通信を凍結の前（Passive フェーズ）に始めさせる。
    for (let frame = 0; frame < SCROLL_PREPARATION_SETTLE_FRAMES; frame += 1) {
      if (!await awaitInitialRender(session.page, effectiveDeadlineAtMs)) {
        return stop('SCROLL_PREPARATION_SETTLE_DEADLINE');
      }
    }
    // 安定性の確認は、下準備の handle で観測する。同じ要素の、hover と focus の後の状態を得るためである（R5 の N-4）。
    // そのため、handle の破棄は、安定性の確認の後に行う。
    return await observePreparedStability(
      resolution.handle,
      prepared.ordinal,
      effectiveDeadlineAtMs,
      domWork,
      stop,
    );
  } finally {
    await disposeRetainedHandleUntil(session, resolution.handle, effectiveDeadlineAtMs);
  }
}

/**
 * 下準備の focus（設計書 2026-09-23 4.4.1、4.4.2 手順4）。focus の前後で下準備の handle で対象を観測し、対象の ARIA の状態か
 * `aria-controls` の先の表示の状態が変わった場合は、凍結せずに終える結果を返す（R8 の Important-2）。focus による状態の変化は、
 * click で起きる変化と区別できないためである。観測の DOM の作業量は、共有の上限から差し引く。前後の状態を比べられない場合も、
 * 凍結せずに終える（fail-closed）。focus の失敗・期限切れも、凍結せずに終える。問題がなければ null を返す。
 * Playwright の focus は期限を受け取らないので、作業フェーズのブラウザ内の処理と同じく、実効の期限で待つ。
 */
async function focusPreparedTarget(
  handle: Parameters<typeof inspectInteractionCandidateHandle>[0],
  ordinal: number,
  effectiveDeadlineAtMs: number,
  domWork: SharedDomWork,
  stop: StopPreparation,
): Promise<StoppedPreparation | null> {
  const observe = (): Promise<TargetObservation | StoppedPreparation> => observePreparedTarget(
    handle,
    ordinal,
    effectiveDeadlineAtMs,
    domWork,
    stop,
    FOCUS_PREPARATION_OBSERVATION_REASONS,
  );
  const beforeFocus = await observe();
  if ('outcome' in beforeFocus) {
    return beforeFocus;
  }
  try {
    const focusWork = await awaitBrowserWork(() => handle.focus(), effectiveDeadlineAtMs);
    if (focusWork.status === 'PENDING_AT_DEADLINE') {
      return stop('FOCUS_PREPARATION_DEADLINE');
    }
  } catch (error) {
    return isPlaywrightTimeoutError(error)
      ? stop('FOCUS_PREPARATION_DEADLINE')
      : stop('FOCUS_PREPARATION_FAILED', interactionFailureDetail(error));
  }
  const afterFocus = await observe();
  if ('outcome' in afterFocus) {
    return afterFocus;
  }
  const changed = interactionTargetStateChanged(
    beforeFocus.candidate,
    afterFocus.candidate,
    changedInteractionAttributeNames(beforeFocus.attributes, afterFocus.attributes),
  );
  if (changed === null) {
    return stop('FOCUS_PREPARATION_STATE_UNCOMPARABLE');
  }
  return changed ? stop('FOCUS_PREPARATION_STATE_CHANGED') : null;
}

/**
 * 凍結の前に、下準備の handle で対象を1回観測する（同じ要素かの確認、focus の前後の比較、安定性の確認に使う）。期限付きで行い、
 * DOM の作業量を共有の上限から差し引く。期限切れ・作業量の上限・対象の事実を得られなかった場合は、凍結せずに終える結果を返す。
 * 理由は、観測の目的ごとの `reasons` を使う（同じ要素かの確認は、安定性の確認の最初の観測として扱い、安定性の確認の理由を使う）。
 */
async function observePreparedTarget(
  handle: Parameters<typeof inspectInteractionCandidateHandle>[0],
  ordinal: number,
  effectiveDeadlineAtMs: number,
  domWork: SharedDomWork,
  stop: StopPreparation,
  reasons: PreparedObservationReasons,
): Promise<TargetObservation | StoppedPreparation> {
  const inspectionWork = await awaitBrowserWork(
    () => inspectInteractionCandidateHandle(handle, ordinal, domWork.remaining()),
    effectiveDeadlineAtMs,
  );
  if (inspectionWork.status === 'PENDING_AT_DEADLINE') {
    return stop(reasons.deadline);
  }
  const snapshot = inspectionWork.value;
  if (domWork.debit(snapshot.domWorkUsed) || snapshot.status === 'DOM_WORK_BUDGET_REACHED') {
    return stop(reasons.domWorkExhausted);
  }
  if (snapshot.status !== 'CONNECTED') {
    return stop(reasons.inspection[snapshot.status]);
  }
  if (Date.now() >= effectiveDeadlineAtMs) {
    return stop(reasons.deadline);
  }
  return Object.freeze({
    candidate: snapshot.candidate,
    attributes: snapshot.attributes,
    detailsOpen: snapshot.detailsOpen,
  });
}

/**
 * 安定性の確認（設計書 2026-09-23 4.4.1、R5 の N-1）。凍結の前に、`INTERACTION_STABILITY_WINDOW_MS` の間、`STABILITY_SAMPLE_INTERVAL_MS` ごとに
 * 下準備の handle で対象を観測し、続く2回の観測の間に変わった項目を「不安定」として記録する。観測する項目は、click の後の根拠になる
 * 項目と同じである。観測の前の状態（凍結の後の探し直しの目印）は、この時間の終わりの観測とする。
 * 期限の内側で行い、始める時点で時間が足りない場合と、途中で期限を過ぎた場合は、凍結せずに NOT_VERIFIABLE にする。
 * 観測の DOM の作業量は、1回の audit で共有する上限から差し引く。
 */
async function observePreparedStability(
  handle: Parameters<typeof inspectInteractionCandidateHandle>[0],
  ordinal: number,
  effectiveDeadlineAtMs: number,
  domWork: SharedDomWork,
  stop: StopPreparation,
): Promise<ScrollPreparation> {
  if (effectiveDeadlineAtMs - Date.now() <= INTERACTION_STABILITY_WINDOW_MS) {
    return stop('STABILITY_CHECK_DEADLINE');
  }
  const windowEndsAtMs = Date.now() + INTERACTION_STABILITY_WINDOW_MS;
  const observe = (): Promise<TargetObservation | StoppedPreparation> => observePreparedTarget(
    handle,
    ordinal,
    effectiveDeadlineAtMs,
    domWork,
    stop,
    STABILITY_CHECK_OBSERVATION_REASONS,
  );
  const recorder = new InstabilityRecorder();
  let previous = await observe();
  if ('outcome' in previous) {
    return previous;
  }
  while (Date.now() < windowEndsAtMs) {
    const nextObservationAtMs = Math.min(Date.now() + STABILITY_SAMPLE_INTERVAL_MS, windowEndsAtMs);
    await wait(Math.max(0, nextObservationAtMs - Date.now()));
    const current = await observe();
    if ('outcome' in current) {
      return current;
    }
    recorder.record(previous, current);
    previous = current;
  }
  return Object.freeze({ status: 'SCROLLED', observation: previous, recorder });
}

/**
 * 隔離された Context で対象のページを読み込み、初期描画を待つ（設計書 2026-09-23 4.4.1、R6 の I-2）。どちらも読み込みの期限
 * （`navigationDeadlineAtMs`）で待つ。期限を過ぎた場合は、読み込みの期限切れと分かる理由の NOT_VERIFIABLE を返し、終えた場合は null を返す。
 * 読み込みのほかの失敗は、そのまま投げる（`auditInteraction` が EXECUTION_FAILED にする）。
 */
async function loadInteractionTarget(
  session: InteractionAuditSession,
  targetUrl: string,
  candidate: InteractionCandidate,
  navigationDeadlineAtMs: number,
): Promise<ClassifiedWorkOutcome | null> {
  const navigationBudgetMs = Math.max(0, navigationDeadlineAtMs - Date.now());
  if (navigationBudgetMs === 0) {
    return notVerifiable('INITIAL_LOAD_BEFORE_LOAD', emptyEvidence(candidate));
  }
  try {
    await session.page.goto(targetUrl, {
      waitUntil: 'load',
      timeout: navigationBudgetMs,
    });
  } catch (error) {
    if (isPlaywrightTimeoutError(error)) {
      return notVerifiable('INITIAL_LOAD_DURING_LOAD', emptyEvidence(candidate));
    }
    throw error;
  }
  if (Date.now() >= navigationDeadlineAtMs) {
    return notVerifiable('INITIAL_LOAD_AFTER_LOAD', emptyEvidence(candidate));
  }
  if (!await awaitInitialRender(session.page, navigationDeadlineAtMs)) {
    return notVerifiable('INITIAL_LOAD_BEFORE_RENDER', emptyEvidence(candidate));
  }
  return null;
}

async function executeInteraction(
  session: InteractionAuditSession,
  input: InteractionAuditInput,
  candidate: InteractionCandidate,
  navigationDeadlineAtMs: number,
): Promise<ClassifiedWorkOutcome> {
  const loadFailure = await loadInteractionTarget(session, input.targetUrl, candidate, navigationDeadlineAtMs);
  if (loadFailure !== null) {
    return loadFailure;
  }
  // Interaction の期限は、読み込みと初期描画が終わったここから数える（設計書 2026-09-23 4.4.1、R6 の I-2）。
  // 読み込みの遅いページで、読み込みの時間が、下準備・安定性の確認・click・持続の確認の時間を削らないようにするためである。
  const effectiveDeadlineAtMs = Math.min(input.deadlineAtMs, Date.now() + input.timeoutMs);
  const remaining = (): number => Math.max(0, effectiveDeadlineAtMs - Date.now());
  let domWorkRemaining = INTERACTION_CANDIDATE_LIMITS.maxDomWork;
  const debitDomWork = (domWorkUsed: number): boolean => {
    if (!isNonNegativeSafeInteger(domWorkUsed) || domWorkUsed > domWorkRemaining) {
      throw new Error('Interaction DOM work exceeded the remaining bounded contract');
    }
    domWorkRemaining -= domWorkUsed;
    return domWorkRemaining === 0;
  };
  const domWorkExhausted = (before: InteractionCandidate): ClassifiedWorkOutcome => notVerifiable(
    'DOM_WORK_EXHAUSTED',
    emptyEvidence(before, 'UNESTABLISHED'),
  );
  const scrollPreparation = await prepareTargetScroll(session, candidate, effectiveDeadlineAtMs, {
    remaining: () => domWorkRemaining,
    debit: debitDomWork,
  });
  if (scrollPreparation.status === 'STOPPED') {
    return scrollPreparation.outcome;
  }
  await activateFreezeBeforeDeadline(session, input.freezeActivationTimeoutMs ?? CONTEXT_CLOSE_TIMEOUT_MS);
  if (remaining() === 0) {
    return notVerifiable('DEADLINE_AFTER_SAFETY_FREEZE', emptyEvidence(candidate));
  }

  const rediscoveryWork = await awaitBrowserWork(
    () => discoverInteractionCandidates(session.page, domWorkRemaining),
    effectiveDeadlineAtMs,
  );
  if (rediscoveryWork.status === 'PENDING_AT_DEADLINE') {
    return notVerifiable('DEADLINE_DURING_CANDIDATE_REDISCOVERY', emptyEvidence(candidate));
  }
  const rediscoveredResult = rediscoveryWork.value;
  if (debitDomWork(rediscoveredResult.domWorkUsed)) {
    return domWorkExhausted(candidate);
  }
  if (remaining() === 0) {
    return notVerifiable('DEADLINE_DURING_CANDIDATE_REDISCOVERY', emptyEvidence(candidate));
  }
  const rediscovered = rediscoveredResult.candidates;
  // 下準備を終えた場合は、下準備の handle で読んだ、hover と focus の後の同じ要素の状態を目印にして探し直す（R5 の N-4）。
  // hover で文字が変わる対象は、同じ要素でも、凍結の前の探索とは別の候補の ID になるためである。受け入れの判定は、この後に行う。
  const expectedCandidateId = scrollPreparation.status === 'SCROLLED'
    ? scrollPreparation.observation.candidate.candidateId
    : candidate.candidateId;
  const matching = rediscovered.filter((item) => item.candidateId === expectedCandidateId);
  if (matching.length === 0 && rediscoveredResult.completeness !== 'COMPLETE') {
    return incompleteRediscovery(rediscoveredResult.completeness, emptyEvidence(candidate, 'UNESTABLISHED'));
  }
  if (matching.length === 0) {
    return notVerifiable('CANDIDATE_IDENTITY_NOT_REDISCOVERED', emptyEvidence(candidate, 'MISSING'));
  }
  if (matching.length !== 1) {
    return notVerifiable('CANDIDATE_IDENTITY_AMBIGUOUS', emptyEvidence(candidate, 'AMBIGUOUS'));
  }
  const before = matching[0] as InteractionCandidate;
  if (remaining() === 0) {
    return notVerifiable('DEADLINE_BEFORE_TARGET_HANDLE_ACQUISITION', emptyEvidence(before));
  }
  const resolutionWork = await awaitBrowserWork(
    () => resolveInteractionCandidateHandle(session.page, before.ordinal, domWorkRemaining),
    effectiveDeadlineAtMs,
    disposeLateResolvedHandle(session),
  );
  if (resolutionWork.status === 'PENDING_AT_DEADLINE') {
    return notVerifiable('DEADLINE_DURING_TARGET_HANDLE_ACQUISITION', emptyEvidence(before));
  }
  const resolution = resolutionWork.value;
  const resolutionExhaustedInteractionBudget = debitDomWork(resolution.domWorkUsed);
  if (resolution.status !== 'FOUND' && resolutionExhaustedInteractionBudget) {
    return domWorkExhausted(before);
  }
  if (resolution.status === 'MISSING') {
    return notVerifiable('TARGET_HANDLE_NOT_RESOLVED', emptyEvidence(before, 'MISSING'));
  }
  if (resolution.status === 'DOM_WORK_BUDGET_REACHED') {
    return notVerifiable(
      'TARGET_HANDLE_RESOLUTION_DOM_WORK_EXHAUSTED',
      emptyEvidence(before, 'UNESTABLISHED'),
    );
  }
  const targetHandle = resolution.handle;

  try {
    if (resolutionExhaustedInteractionBudget) {
      return domWorkExhausted(before);
    }
    if (remaining() === 0) {
      return notVerifiable('DEADLINE_DURING_TARGET_HANDLE_ACQUISITION', emptyEvidence(before));
    }
    const resolvedSnapshotWork = await awaitBrowserWork(
      () => inspectInteractionCandidateHandle(targetHandle, before.ordinal, domWorkRemaining),
      effectiveDeadlineAtMs,
    );
    if (resolvedSnapshotWork.status === 'PENDING_AT_DEADLINE') {
      return notVerifiable('DEADLINE_DURING_TARGET_FACT_COLLECTION', emptyEvidence(before));
    }
    const resolvedSnapshot = resolvedSnapshotWork.value;
    if (debitDomWork(resolvedSnapshot.domWorkUsed)) {
      return domWorkExhausted(before);
    }
    if (remaining() === 0) {
      return notVerifiable('DEADLINE_DURING_TARGET_FACT_COLLECTION', emptyEvidence(before));
    }
    if (resolvedSnapshot.status === 'DOM_WORK_BUDGET_REACHED') {
      return notVerifiable(
        'TARGET_INSPECTION_DOM_WORK_EXHAUSTED',
        emptyEvidence(before, 'UNESTABLISHED'),
      );
    }
    if (resolvedSnapshot.status === 'CANDIDATE_LIMIT_REACHED') {
      return notVerifiable(
        'TARGET_INSPECTION_CANDIDATE_LIMIT_REACHED',
        emptyEvidence(before, 'UNESTABLISHED'),
      );
    }
    if (resolvedSnapshot.status === 'TEXT_NODE_LIMIT_REACHED') {
      return notVerifiable(
        'TARGET_INSPECTION_TEXT_NODE_LIMIT_REACHED',
        emptyEvidence(before, 'UNESTABLISHED'),
      );
    }
    if (resolvedSnapshot.status === 'DISCONNECTED') {
      return notVerifiable(
        'TARGET_DISCONNECTED_BEFORE_ADMISSION',
        emptyEvidence(before, 'MISSING'),
      );
    }
    const resolvedCandidate = resolvedSnapshot.candidate;
    // click の前のスクロール位置。click の後の観測の記録と比べ、スクロールが起きたかを判定する（設計書 2026-09-23 4.4 の追記）。
    const scrollBeforeClick = resolvedSnapshot.scroll;
    // click の前の、対象の状態（候補の事実、対象自身の属性、親の details の開閉）。click の後の観測と比べる（設計書 2026-09-23 4.4.1）。
    // 下準備で hover と focus をし、安定性の確認をした後に取るので、hover と focus による変化は、前後の差に出ない。
    const observationBeforeClick: TargetObservation = Object.freeze({
      candidate: resolvedCandidate,
      attributes: resolvedSnapshot.attributes,
      detailsOpen: resolvedSnapshot.detailsOpen,
    });
    if (resolvedCandidate.candidateId !== before.candidateId) {
      return notVerifiable('TARGET_CHANGED_DURING_EXACT_NODE_RESOLUTION', emptyEvidence(before));
    }
    const exactAdmission = classifyInteractionCandidate(resolvedCandidate);
    if (remaining() === 0) {
      return notVerifiable('DEADLINE_DURING_EXACT_NODE_ADMISSION', emptyEvidence(before));
    }
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
    if (scrollPreparation.status !== 'SCROLLED') {
      return notVerifiable('TARGET_NOT_SCROLL_PREPARED', emptyEvidence(resolvedCandidate));
    }
    // 安定性の確認の終わりから、凍結の後の click の前の観測までに変わった項目も、不安定とする。
    scrollPreparation.recorder.record(scrollPreparation.observation, observationBeforeClick);
    const instability = scrollPreparation.recorder.snapshot();

    const clickBudgetMs = remaining();
    if (clickBudgetMs === 0) {
      return notVerifiable('DEADLINE_BEFORE_EXACT_NODE_CLICK', emptyEvidence(resolvedCandidate));
    }
    let clickFailed = false;
    let clickError: unknown;
    try {
      await targetHandle.click({ timeout: clickBudgetMs });
    } catch (error) {
      clickFailed = true;
      clickError = error;
    }

    let lastEvidence = emptyEvidence(resolvedCandidate);
    // 最後の観測で、変化が `boundingBox` だけだった場合の区別。
    let geometryOnlyChange: GeometryOnlyChange | null = null;
    // 持続の確認の途中の状態（設計書 2026-09-23 4.4.1、R5 の N-3）。根拠となる変化を見つけた観測の Evidence と、
    // その変化が続いているかを確かめる時刻。
    let persistence: { readonly evidence: InteractionChangeEvidence; readonly checkAtMs: number } | null = null;
    // 期限までに変化を確かめられなかった場合の結果（I15a で、区分が期限の切れる時点によらないようにした）。
    // - 最後の観測で、変化が `boundingBox` だけだった（根拠にしなかった）場合は、それが分かる理由にする。
    // - click の後の観測を終えて、根拠となる変化が見えないまま期限が切れた場合は、持続の確認の途中でなければ、観測の前・途中・描画の
    //   待ちのどこで期限が切れても `NO_OBSERVABLE_CHANGE` にする。確かめる手順を終えて、変化が見えなかった場合だからである。
    // - それ以外（click の後の観測を1回も終えていない、持続の確認の途中）は、渡された code にする。
    const unverifiedAtDeadline = (code: InteractionNotVerifiableReasonCode): ClassifiedWorkOutcome => {
      if (geometryOnlyChange !== null) {
        return notVerifiable(GEOMETRY_ONLY_CHANGE_REASONS[geometryOnlyChange], lastEvidence);
      }
      const observedNoChange = persistence === null
        && lastEvidence.identityStatus === 'MATCHED'
        && lastEvidence.changedFields.length === 0;
      return notVerifiable(observedNoChange ? 'NO_OBSERVABLE_CHANGE' : code, lastEvidence);
    };
    while (true) {
      // 保持した対象が切断された場合の詳細（切断の後の identityStatus の値）。
      let identityLossDetail: string | undefined;
      let observationDeadlineExpired = false;
      const safety = session.ledger.snapshot();
      if (hasFreezeEvent(safety)) {
        return outcome('BLOCKED_BY_SAFETY', 'SAFETY_FREEZE_BLOCKED', null, lastEvidence);
      }
      if (clickFailed && remaining() === 0) {
        return clickFailureOutcome(clickError, lastEvidence);
      }
      if (remaining() === 0) {
        return unverifiedAtDeadline('DEADLINE_BEFORE_POST_CONDITION_OBSERVATION');
      }
      try {
        const retainedSnapshotWork = await awaitBrowserWork(
          () => inspectInteractionCandidateHandle(targetHandle, resolvedCandidate.ordinal, domWorkRemaining),
          effectiveDeadlineAtMs,
        );
        if (retainedSnapshotWork.status === 'PENDING_AT_DEADLINE') {
          return unverifiedAtDeadline('DEADLINE_DURING_POST_CONDITION_OBSERVATION');
        }
        const retainedSnapshot = retainedSnapshotWork.value;
        if (debitDomWork(retainedSnapshot.domWorkUsed)) {
          return domWorkExhausted(resolvedCandidate);
        }
        observationDeadlineExpired = remaining() === 0;
        if (retainedSnapshot.status === 'CONNECTED') {
          // 対象の位置と大きさの変化は、根拠にしない（`collectInteractionChangeEvidence` は `boundingBox` を数えない）。
          // 対象自身の属性は、前後の記録を比べられて、1つでも変わった場合だけ根拠にする。安定性の確認で不安定になった項目と
          // 属性は、根拠にしない。スクロールの比較は、位置と大きさだけが変わった場合の NOT_VERIFIABLE の理由を区別するために使う。
          // `role="tab"` を明示した要素は、下準備で focus をしないので、focus や mousedown で変わる属性が前後の差に出る。
          // そのため、属性の変化は ARIA の状態だけを根拠にする（設計書 2026-09-23 4.4.1、R9 の Important-1）。判定は、下準備で
          // focus を飛ばす判定と同じ `hasExplicitTabRole` を使う。
          lastEvidence = collectInteractionChangeEvidence(resolvedCandidate, retainedSnapshot.candidate, {
            difference: targetStateDifference(observationBeforeClick, {
              candidate: retainedSnapshot.candidate,
              attributes: retainedSnapshot.attributes,
              detailsOpen: retainedSnapshot.detailsOpen,
            }),
            instability,
            ariaStateAttributesOnly: hasExplicitTabRole(resolvedCandidate.role),
          });
          const scrollComparison = compareInteractionScrollRecords(scrollBeforeClick, retainedSnapshot.scroll);
          geometryOnlyChange = lastEvidence.changedFields.length === 0
            && interactionGeometryChanged(resolvedCandidate, retainedSnapshot.candidate)
            ? (scrollComparison === 'UNCHANGED' ? 'GEOMETRY' : scrollComparison)
            : null;
        } else if (retainedSnapshot.status === 'DOM_WORK_BUDGET_REACHED') {
          return notVerifiable(
            'RETAINED_INSPECTION_DOM_WORK_EXHAUSTED',
            emptyEvidence(resolvedCandidate, 'UNESTABLISHED'),
          );
        } else if (retainedSnapshot.status === 'CANDIDATE_LIMIT_REACHED') {
          return notVerifiable(
            'RETAINED_INSPECTION_CANDIDATE_LIMIT_REACHED',
            emptyEvidence(resolvedCandidate, 'UNESTABLISHED'),
          );
        } else if (retainedSnapshot.status === 'TEXT_NODE_LIMIT_REACHED') {
          return notVerifiable(
            'RETAINED_INSPECTION_TEXT_NODE_LIMIT_REACHED',
            emptyEvidence(resolvedCandidate, 'UNESTABLISHED'),
          );
        } else if (!observationDeadlineExpired) {
          const liveCandidatesWork = await awaitBrowserWork(
            () => discoverInteractionCandidates(session.page, domWorkRemaining),
            effectiveDeadlineAtMs,
          );
          if (liveCandidatesWork.status === 'PENDING_AT_DEADLINE') {
            return unverifiedAtDeadline('DEADLINE_DURING_POST_CONDITION_OBSERVATION');
          }
          const liveCandidatesResult = liveCandidatesWork.value;
          if (debitDomWork(liveCandidatesResult.domWorkUsed)) {
            return domWorkExhausted(resolvedCandidate);
          }
          if (liveCandidatesResult.completeness !== 'COMPLETE'
            && !liveCandidatesResult.candidates.some((item) => item.candidateId === resolvedCandidate.candidateId)) {
            return incompleteRediscovery(
              liveCandidatesResult.completeness,
              emptyEvidence(resolvedCandidate, 'UNESTABLISHED'),
            );
          }
          observationDeadlineExpired = remaining() === 0;
          lastEvidence = collectDisconnectedInteractionEvidence(resolvedCandidate, liveCandidatesResult.candidates);
          geometryOnlyChange = null;
          identityLossDetail = lastEvidence.identityStatus;
        }
      } catch (error) {
        if (hasFreezeEvent(session.ledger.snapshot())) {
          return outcome('BLOCKED_BY_SAFETY', 'SAFETY_FREEZE_BLOCKED', null, lastEvidence);
        }
        throw error;
      }
      const afterObservationSafety = session.ledger.snapshot();
      if (hasFreezeEvent(afterObservationSafety)) {
        return outcome('BLOCKED_BY_SAFETY', 'SAFETY_FREEZE_BLOCKED', null, lastEvidence);
      }
      if (clickFailed) {
        return clickFailureOutcome(clickError, lastEvidence);
      }
      if (identityLossDetail !== undefined) {
        return notVerifiable('RETAINED_IDENTITY_LOST', lastEvidence, identityLossDetail);
      }
      if (observationDeadlineExpired || remaining() === 0) {
        return unverifiedAtDeadline('DEADLINE_DURING_POST_CONDITION_OBSERVATION');
      }
      if (lastEvidence.identityStatus === 'MATCHED' && lastEvidence.changedFields.length > 0) {
        // 持続の確認: 根拠となる変化を見つけたら、`INTERACTION_PERSISTENCE_WINDOW_MS` の後にもう一度観測し、その時にも続いている
        // 項目だけを根拠にする。元に戻った変化は根拠にせず、新しい変化があれば、そこから持続の確認をやり直す。
        if (persistence !== null && Date.now() >= persistence.checkAtMs) {
          const persistent = retainPersistentInteractionChanges(lastEvidence, persistence.evidence);
          if (persistent.changedFields.length > 0) {
            return outcome('VERIFIED', 'OBSERVABLE_STATE_CHANGED', null, persistent);
          }
          persistence = null;
        }
        persistence ??= Object.freeze({ evidence: lastEvidence, checkAtMs: Date.now() + INTERACTION_PERSISTENCE_WINDOW_MS });
        if (persistence.checkAtMs >= effectiveDeadlineAtMs) {
          return unverifiedAtDeadline('PERSISTENCE_CHECK_DEADLINE');
        }
        await wait(Math.max(0, persistence.checkAtMs - Date.now()));
        continue;
      }
      persistence = null;
      if (!await awaitInitialRender(session.page, effectiveDeadlineAtMs)) {
        return unverifiedAtDeadline('NO_OBSERVABLE_CHANGE');
      }
    }
  } finally {
    await disposeRetainedHandleUntil(session, targetHandle, effectiveDeadlineAtMs);
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
  const { releaseLateSessionFailure } = input;
  if (releaseLateSessionFailure !== undefined && typeof releaseLateSessionFailure !== 'function') {
    throw new Error('The receiver of late interaction session failures must be a function');
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
  const navigationDeadlineAtMs = Math.min(input.deadlineAtMs, Date.now() + input.navigationTimeoutMs);
  if (navigationDeadlineAtMs <= Date.now()) {
    throw new Error('Interaction deadline has already expired');
  }

  // session の作成は、候補の予算の中（読み込みの期限と、今から `sessionOpenTimeoutMs` 後の早い方）で待つ（DEF-008）。
  // 期限の中の失敗は、今までどおり、そのまま投げる。期限を過ぎた場合は NOT_VERIFIABLE を返し、遅れて届いた session は閉じ、
  // 遅れて届いた失敗は受け取る口に渡す（Context を持つ失敗の Context は、呼び出し側が閉じる）。
  const sessionOpenDeadlineAtMs = Math.min(navigationDeadlineAtMs, Date.now() + sessionOpenTimeoutMs);
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
  let classifiedWork: ClassifiedWorkOutcome;
  try {
    classifiedWork = await executeInteraction(session, input, candidate, navigationDeadlineAtMs);
  } catch (error) {
    classifiedWork = outcome('EXECUTION_FAILED', 'EXECUTION_FAILED', interactionFailureDetail(error), emptyEvidence(candidate));
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
  const cleanupDeadlineAtMs = cleanupStartedAtMs + input.timeoutMs;
  const firstAttemptDeadlineAtMs = cleanupStartedAtMs + Math.floor(input.timeoutMs / 2);
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

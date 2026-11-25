import type { Page } from 'playwright';
import type { IncompleteReasonCode, PageLoadPhase, PartialFailureReason } from '../core/contracts.js';
import { SYSTEM_CLOCK, type Clock } from '../core/clock.js';
import { awaitBeforeDeadline, type DeadlineOutcome } from '../core/deadline.js';
import { isPositiveFiniteNumber } from '../core/guards.js';
import type { LoadingIndicatorEvidence } from '../core/evidence-types.js';
import { PRODUCTION_OBSERVATION_WINDOWS } from '../core/observation-windows.js';
import { DATA_STILL_LOADING, LOADING_INDICATOR_REMAINED, pageReadyOf } from '../core/page-readiness.js';
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';
import type { ProgressSignals } from '../core/progress-watch.js';
import { composeInPage, type StandardReaders } from './in-page-readers.js';
import { scrollStructureSignaturesOf, structureSignaturesInPage } from './controlled-scroll.js';
import { pageFailureReason, type PageFailureReason } from './page-failure.js';

export interface PageSettlingPolicy {
  readonly deadlineAtMs: number;
  readonly pollIntervalMs: number;
  readonly stableWindowMs: number;
  /**
   * L0（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 進みの見張りの口（`src/core/progress-watch.ts`。差し込み口。省略すると今のまま）。
   * 読み取りで新しい値（まだ見ていない高さか、変わった `readyState`）を見たときだけ、中身の進みの印を付ける。同じ値を繰り返し読んだだけ（周期的に
   * 伸び縮みする画面など）は進みと見なさない。見張りが段を終えたら（`signal` の abort）、待ちをやめて、それまでの観察で PARTIAL を返す。
   */
  readonly progress?: Pick<ProgressSignals, 'mark' | 'signal'> | undefined;
  /**
   * AUD-2b（整理の文書 `2026-11-09-beaksight-audit-precision-triage.md` の AUD-2b）: データの要求（fetch・XHR）の今の数（network の collector の
   * `dataRequestActivity`）。渡すと、データが届いた（途中の数が 0、または窓の間にデータの通信が動かなかった）ことも、落ち着きの条件にする。省略すると、データの
   * 条件は満たしたものとして扱う（今までの判定に DOM の変化の静まりを足したもの）。
   */
  readonly dataActivity?: (() => DataActivity) | undefined;
  /** AUD-2b: 開いたままのデータの要求を「届いた」とみなす、全く動かない長さ（ms。テスト用。省略すると `OPEN_DATA_REQUEST_QUIET_MS`）。 */
  readonly openDataRequestQuietMs?: number | undefined;
  /**
   * EV-3（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.3）: 真なら、見える読み込み中の表示が消えた（`pageReadyOf`）ことも、落ち着きの条件に
   * する。表示が残る間は落ち着きにしない。表示が残ったまま何も動かなくなったら（進みが止まった。長さは開いた要求の静まり `openDataRequestQuietMs` を
   * 使い、回数や新しい長さを足さない）、`LOADING_INDICATOR_REMAINED` で終える。省略は今のまま（押した後の待ちなど）。
   */
  readonly awaitLoadingIndicators?: boolean | undefined;
}

/**
 * AUD-2b: データの要求が途中のままでも、高さ・DOM・データの通信のどれも動かない状態がこの長さ続いたら、データは届いたとみなす（ms）。
 * 長く開いたままの要求（ロングポーリングなど）で、落ち着きの判定が終わらないのを避ける待ちの長さ（INV-LIMITS の表 D の「待ち」。網羅の上限ではない）。
 * 外枠だけ先に出す画面のデータの要求（ふつうは数秒以内に返る）を待つため、静まりの窓（500ms）より十分に長くする。これより遅いデータで後から出た中身は、
 * 落ち着いた後の確かめ直し（AUD-2d）が `LATE` として記録する。RB-2: 値は観察の窓の一式（`pageSettle.openDataRequestQuietMs`）の本番の値。
 */
export const OPEN_DATA_REQUEST_QUIET_MS = PRODUCTION_OBSERVATION_WINDOWS.pageSettle.openDataRequestQuietMs;

/** AUD-2b: データの要求の今の数（`inFlight`: 終わっていない数、`events`: 始まり・終わりの通しの数）。 */
export interface DataActivity {
  readonly inFlight: number;
  readonly events: number;
  /**
   * 設計者の判断（2026-11-10）: 口（メソッドと Origin と path。`src/core/request-endpoint-key.ts` の `requestEndpointKeyOf`）ごとの事実。渡すと、データの
   * 静まりを口ごとに見る（`dataQuietnessOf`）。省略すると、口を見ない今までの判定（`inFlight`・`events`）。
   */
  readonly endpoints?: DataEndpointActivity | undefined;
}

/**
 * 口ごとの事実。`inFlight` は終わっていない要求の口（要求ごと）、`completed` は応答を返し終えた口、`failed` は要求が失敗で終わった口（DEF-245 の C。省略は
 * なし）。
 */
export interface DataEndpointActivity {
  readonly inFlight: readonly string[];
  readonly completed: readonly string[];
  readonly failed?: readonly string[] | undefined;
  /**
   * QUIET-3: 口ごとの、要求が始まった数（通しの数。省略はなし）。押下の窓の外で出た口を、押下の前後の数の差で見分ける（操作さがしの押下の観察）。静まりの判定は
   * 読まない。
   */
  readonly started?: Readonly<Record<string, number>> | undefined;
}

/** 落ち着きの判定が読む、データの静まりの事実。 */
interface DataQuietness {
  /** まだ一度も応答を返し終えていない口への、途中の要求の数。 */
  readonly pending: number;
  /** 動いたかを比べる印（変われば、データの通信が動いた）。 */
  readonly mark: string;
  /** REV-WSO2: まだ届いていない口（口ごとの事実がないときは、途中の要求があれば 1 つの印）。 */
  readonly pendingEndpoints: readonly string[];
}

/** 口ごとの事実がないときの、途中の要求の印（`DataQuietness.pendingEndpoints`）。 */
const UNKNOWN_PENDING_ENDPOINT = 'in-flight';

/** REV-WSO2: まだ届いていない口ごとの、途中と見た最初と最後の時刻と、窓の長さ以上開いていた要求を最後に見た時刻。 */
interface OpenEndpoints {
  readonly seen: Map<string, { readonly firstMs: number; lastMs: number }>;
  longOpenSeenAtMs: number | undefined;
}

/**
 * REV-WSO2（設計者の判断 2026-11-17）: 直近の窓（`windowMs`）の間に、まだ届いていない口への要求が、窓の長さ以上開いていたか。その瞬間の途中の数ではなく、
 * 要求の持続で見る（窓より短く開くだけの送り続けは数えない。鎖の 1 歩は、歩の間の隙間に当たっても数える）。長さは窓の値だけを使う。
 */
function longOpenRequestsOf(open: OpenEndpoints, pending: readonly string[], observedAtMs: number, windowMs: number): boolean {
  for (const endpoint of pending) {
    const seen = open.seen.get(endpoint);
    if (seen === undefined) {
      open.seen.set(endpoint, { firstMs: observedAtMs, lastMs: observedAtMs });
    } else {
      seen.lastMs = observedAtMs;
    }
  }
  for (const [endpoint, seen] of open.seen) {
    if (seen.lastMs - seen.firstMs >= windowMs) {
      open.longOpenSeenAtMs = Math.max(open.longOpenSeenAtMs ?? seen.lastMs, seen.lastMs);
    }
    if (seen.lastMs !== observedAtMs) {
      open.seen.delete(endpoint);
    }
  }
  return open.longOpenSeenAtMs !== undefined && observedAtMs - open.longOpenSeenAtMs <= windowMs;
}

/**
 * 設計者の判断（2026-11-10。判定はここだけ）: データの静まりは、要求の口ごとに見る。
 * - 一度でも応答を返し終えた口へのくり返しの要求は「データが届いた後のくり返し」として、途中の数にも動きにも数えない（回数や間隔では決めない）。
 * - まだ一度も応答を返し終えていない口への要求は、途中の数に数える。新しい口の要求が始まったり、口が初めて応答を返し終えたりしたら、動いたとする。
 * 口ごとの事実がないときは、今までどおり全部の要求の数と事象の通しの数で見る。
 * DEF-245 の C（設計者の判断 2026-11-11）: 「一度でも終わった口」は、応答を返し終えた口と、要求が失敗で終わった口の両方。失敗し続ける口へのくり返しも、
 * 新しいデータが届く途中ではないので、途中の数にも動きにも数えない。
 * DEF-283 の B（設計者の判断 2026-11-16）: 動きは「まだ届いていない口の途中の要求の組」の変わりだけで見る。一度終わった口が増えるだけ（新しい path へ送り続ける
 * 画面で、観測の間に要求が始まって終わる）は、動きにしない。
 */
export function dataQuietnessOf(data: DataActivity): DataQuietness {
  if (data.endpoints === undefined) {
    return { pending: data.inFlight, mark: String(data.events), pendingEndpoints: data.inFlight > 0 ? [UNKNOWN_PENDING_ENDPOINT] : [] };
  }
  const ended = new Set([...data.endpoints.completed, ...(data.endpoints.failed ?? [])]);
  const pending = data.endpoints.inFlight.filter((endpoint) => !ended.has(endpoint));
  return { pending: pending.length, mark: JSON.stringify([...pending].sort()), pendingEndpoints: [...new Set(pending)] };
}

/**
 * DEF-283 の C（設計者の判断 2026-11-16。判定はここだけ）: 動き（中身の進み・まだ届いていない口の途中の要求の組の変わり）が最後にあった時刻から、開いた要求の
 * 静まりの長さ（`openDataRequestQuietMs`）が過ぎたか。過ぎたら、まだ届いていない要求が残っていても、進みが止まったとみなす（送り続ける画面・答えない長い要求で、
 * 見張りまで待たない）。DEF-290: 発見の前の落ち着きの待ち（`src/discovery/settle.ts`）も、この判定を使う。
 */
export const progressStoppedOf = (lastMovedAtMs: number, nowMs: number, openDataRequestQuietMs: number | undefined): boolean =>
  nowMs - lastMovedAtMs >= openDataRequestQuietOf(openDataRequestQuietMs);

/** 開いた要求の静まりの長さ（差し込まれた値。なければ本番の値）。 */
const openDataRequestQuietOf = (given: number | undefined): number => given ?? OPEN_DATA_REQUEST_QUIET_MS;

export interface PageSettlingObservation {
  readonly observedAtMs: number;
  readonly readyState: DocumentReadyState;
  readonly scrollHeight: number;
  /** AUD-2b: 文書の要素の数と、文字の長さ（DOM の変化の静まりを見る。中身は読まない）。 */
  readonly elementCount?: number;
  readonly textLength?: number;
  /** AUD-2b: 観測した時の、終わっていないデータの要求の数（`dataActivity` を渡したときだけ）。 */
  readonly dataInFlight?: number;
  /** EV-3: 見えている読み込み中の表示の数（読めたときだけ）。 */
  readonly loadingIndicators?: LoadingIndicatorEvidence;
}

/** AUD-2b: 段が変わった時刻（`Date.now()` の基準）。段の一覧の owner は `src/core/contracts.ts` の `PAGE_LOAD_PHASES`。 */
export interface PageLoadPhaseTransition {
  readonly phase: PageLoadPhase;
  readonly observedAtMs: number;
}

export type PageSettlingResult = Readonly<{
  readonly status: 'SETTLED';
  /**
   * EV-3: `LOADING_INDICATOR_REMAINED` は、見える読み込み中の表示が残ったまま、何も動かなくなって終えた（準備が終わらない。`awaitLoadingIndicators` のとき
   * だけ）。その後の読み取りは今どおり行い、内容の規則の指摘は、表示用モデルが保留の理由 `PAGE_NOT_READY` で出す。
   * REV-WSO: `DATA_STILL_LOADING` は、中身の進みが止まったので、まだ届いていないデータの要求が残ったまま終えた（DEF-283 の C。準備が終わらないのと同じ扱い）。
   */
  readonly reason: 'DOM_AND_HEIGHT_STABLE' | typeof LOADING_INDICATOR_REMAINED | typeof DATA_STILL_LOADING;
  readonly observations: readonly Readonly<PageSettlingObservation>[];
  /** AUD-2b: 読み込みの段の移り変わり（変わった時だけ。最初は `AFTER_DOM_CONTENT_LOADED`）。 */
  readonly loadPhases?: readonly Readonly<PageLoadPhaseTransition>[];
}> | Readonly<{
  readonly status: 'PARTIAL';
  readonly reason: PartialFailureReason | Extract<IncompleteReasonCode, 'DOM_READINESS_FAILED'>;
  readonly observations: readonly Readonly<PageSettlingObservation>[];
  readonly loadPhases?: readonly Readonly<PageLoadPhaseTransition>[];
}>;

function validatePolicy(policy: PageSettlingPolicy): void {
  if (!Number.isFinite(policy.deadlineAtMs)) {
    throw new Error('Page settling deadline must be finite');
  }
  if (!isPositiveFiniteNumber(policy.pollIntervalMs)) {
    throw new Error('Page settling poll interval must be positive and finite');
  }
  if (!isPositiveFiniteNumber(policy.stableWindowMs)) {
    throw new Error('Page settling stable window must be positive and finite');
  }
}

function immutableResult(result: PageSettlingResult): PageSettlingResult {
  const observations = Object.freeze(result.observations.map((observation) => Object.freeze({ ...observation })));
  const loadPhases = result.loadPhases === undefined
    ? undefined
    : Object.freeze(result.loadPhases.map((transition) => Object.freeze({ ...transition })));
  return Object.freeze({ ...result, observations, ...(loadPhases === undefined ? {} : { loadPhases }) });
}

function partial(
  reason: Extract<PageSettlingResult, { readonly status: 'PARTIAL' }>['reason'],
  observations: readonly PageSettlingObservation[],
  loadPhases?: readonly PageLoadPhaseTransition[],
): PageSettlingResult {
  return immutableResult({ status: 'PARTIAL', reason, observations, ...(loadPhases === undefined ? {} : { loadPhases }) });
}

function settledBeforeDeadline(
  clock: Pick<Clock, 'now'>,
  deadlineAtMs: number,
  observations: readonly PageSettlingObservation[],
  loadPhases: readonly PageLoadPhaseTransition[],
  reason: Extract<PageSettlingResult, { readonly status: 'SETTLED' }>['reason'] = 'DOM_AND_HEIGHT_STABLE',
): PageSettlingResult {
  if (clock.now() >= deadlineAtMs) {
    return partial('DEADLINE_EXCEEDED', observations, loadPhases);
  }
  const settled = immutableResult({
    status: 'SETTLED',
    reason,
    observations,
    loadPhases,
  });
  return clock.now() >= deadlineAtMs
    ? partial('DEADLINE_EXCEEDED', observations, loadPhases)
    : settled;
}

/** 文書の状態の読み取りの値（EV-3: 読み込み中の表示の数は、読めたときだけ）。 */
export type PageSettlingDocumentState = Required<Pick<PageSettlingObservation, 'readyState' | 'scrollHeight' | 'elementCount' | 'textLength'>>
  & Pick<PageSettlingObservation, 'loadingIndicators'>;

/**
 * 落ち着きの待ちが頼むページの読み（RB-9。本物は `pageSettlingPortOf(page)`、テストは偽の口）。期限は絶対時刻（時計の基準）。どれも例外を投げず、期限の
 * 結果（`DeadlineOutcome`）で返す。
 */
export interface PageSettlingPort {
  isClosed(): boolean;
  /** 読み取りに失敗したときの理由（閉じていれば `PAGE_CLOSED`）。 */
  failureReason(): PageFailureReason;
  waitForDomContentLoaded(deadlineAtMs: number): Promise<DeadlineOutcome<void>>;
  readDocumentState(deadlineAtMs: number): Promise<DeadlineOutcome<PageSettlingDocumentState>>;
  /** 作りの印（文字列の配列のはず。形は呼ぶ側が確かめる）。 */
  readStructureSignatures(deadlineAtMs: number): Promise<DeadlineOutcome<unknown>>;
}

/**
 * ブラウザ内で、文書の `readyState` と、文書の要素の高さを読む。部品（`R`）を `composeInPage` で組み込んで `page.evaluate` に渡すため、
 * この関数の外にあるものを参照しない。
 * DOM clobbering（DEF-073）: 名前つきの img・form など（`<form name="readyState">` など）は、`document` の同じ名前のプロパティを隠すので、
 * `Document.prototype` の getter で読む（部品の `documentProperty`。`src/browser/in-page-readers.ts`。CC-068）。html は名前つきの子で隠れない。
 */
function readDocumentSettlingStateReader(R: StandardReaders, visibilityOptions: CheckVisibilityOptions): PageSettlingDocumentState {
  const root = R.documentProperty<HTMLElement>('documentElement');
  // AUD-2b: DOM の変化の静まりを見るための、要素の数と文字の長さ（中身は返さない）。EV-3: 見えている読み込み中の表示の数（DOM の記録と同じ部品）。
  return {
    readyState: R.documentProperty<DocumentReadyState>('readyState'),
    scrollHeight: root.scrollHeight,
    elementCount: root.getElementsByTagName('*').length,
    textLength: (root.textContent ?? '').length,
    loadingIndicators: R.loadingIndicatorsIn(visibilityOptions),
  };
}
const readDocumentSettlingStateInPage = composeInPage(readDocumentSettlingStateReader);

/** 本物の口（Playwright の page）。 */
export const pageSettlingPortOf = (page: Page): PageSettlingPort => Object.freeze({
  isClosed: () => page.isClosed(),
  failureReason: () => pageFailureReason(page),
  waitForDomContentLoaded: (deadlineAtMs: number) => awaitBeforeDeadline(
    page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, deadlineAtMs - Date.now()) }),
    deadlineAtMs,
  ),
  readDocumentState: (deadlineAtMs: number) => awaitBeforeDeadline(page.evaluate(readDocumentSettlingStateInPage, VISIBILITY_CHECK_OPTIONS), deadlineAtMs),
  readStructureSignatures: (deadlineAtMs: number) => awaitBeforeDeadline(page.evaluate(structureSignaturesInPage, null), deadlineAtMs),
});

export function waitForPageSettled(page: Page, policy: PageSettlingPolicy): Promise<PageSettlingResult> {
  return waitForPageSettledWith(pageSettlingPortOf(page), policy, SYSTEM_CLOCK);
}

/**
 * 落ち着きを待つ輪（RB-9。口と時計を差し込める）。判定はここだけ。
 * - AUD-2b: 静まりの窓。新しい作りの印が出ず、データが届いている状態が、窓の長さ続いたら落ち着いた。
 * - DEF-245 の B・D（設計者の判断 2026-11-11）: 窓を始め直すのは、新しい作りの印が出たときだけ。高さが前に見た値に戻るだけの行き来も、新しい作りの印が出ない
 *   まま高さだけが伸び続ける画面も、窓を続ける（網羅は作りの印で決める。L9 の scroll の決まりと同じ）。高さの新しい値は、見張りの中身の進みにだけ使う。
 * - データが届いた: 途中の数が 0 か、窓を始めてから高さ・DOM・データの通信のどれも動かないまま `openDataRequestQuietMs` が過ぎた（開いたままの要求で
 *   待ち続けないため）。データの通信が動いたら、窓を始め直す。データの通信は、ページの自発の変化なので、中身の進みにしない。
 * - EV-3: `awaitLoadingIndicators` なら、見える読み込み中の表示が残る間は、文書の読み込み中と同じく窓を始めない（段は `LOADING`）。表示が残ったまま、
 *   高さ・作り・表示の数・データの通信のどれも動かないまま `openDataRequestQuietMs` が過ぎたら、`LOADING_INDICATOR_REMAINED` で終える。
 * - DEF-283 の C（設計者の判断 2026-11-16）: 中身の進み（新しい作りの印・`readyState` の変わり・新しい表示の数。高さは DEF-245 の D のとおり数えない）が
 *   `openDataRequestQuietMs` の間止まったら、新しい口の要求が続いていても、表示あり・なしのどちらの側も終える（送り続ける画面で、見張りまで待たない）。
 *   切れ目なく読み続け、その間に中身が変わらない鎖で後から出た中身は、1 本の遅いデータと同じく、確かめ直し（AUD-2d）が記録する。
 *   REV-WSO（設計者の判断 2026-11-16）: そのとき、まだ届いていないデータの要求が残っていれば、理由を `DATA_STILL_LOADING`（準備が終わっていない）にする。
 *   待ちは延ばさない。
 */
export async function waitForPageSettledWith(
  port: PageSettlingPort,
  policy: PageSettlingPolicy,
  clock: Pick<Clock, 'now' | 'sleep'>,
): Promise<PageSettlingResult> {
  validatePolicy(policy);
  const { deadlineAtMs, pollIntervalMs, stableWindowMs } = policy;
  const observations: PageSettlingObservation[] = [];

  if (port.isClosed()) {
    return partial('PAGE_CLOSED', observations);
  }

  const domReady = await port.waitForDomContentLoaded(deadlineAtMs);
  if (domReady.status === 'DEADLINE_EXCEEDED') {
    return partial('DEADLINE_EXCEEDED', observations);
  }
  if (domReady.status === 'REJECTED') {
    return partial(port.isClosed() ? 'PAGE_CLOSED' : 'DOM_READINESS_FAILED', observations);
  }

  // AUD-2b: 読み込みの段の移り変わり（最初は DOM の準備ができた時）。
  const loadPhases: PageLoadPhaseTransition[] = [{ phase: 'AFTER_DOM_CONTENT_LOADED', observedAtMs: clock.now() }];
  const enterPhase = (phase: PageLoadPhase, observedAtMs: number): void => {
    if (loadPhases.at(-1)?.phase !== phase) loadPhases.push({ phase, observedAtMs });
  };
  const openDataRequestQuietMs = openDataRequestQuietOf(policy.openDataRequestQuietMs);
  const progress = policy.progress;
  /** 今までに見た作りの印（L9 の `scrollStructureSignaturesOf` の集合）と、L0 の見た高さ・前の `readyState`。 */
  const seenStructure = new Set<string>();
  const seenHeights = new Set<string>();
  const seenIndicators = new Set<string>();
  let previousReadyState: DocumentReadyState | undefined;
  /** 静まりの窓を始めた時刻と、そのときのデータの通信の動きの印（`dataQuietnessOf` の `mark`）。 */
  let stableSinceMs: number | undefined;
  let stableSinceDataMark: string | undefined;
  /** EV-3: 読み込み中の表示が残ったまま、何も動かなくなった時刻と、そのときのデータの通信の動きの印。 */
  let notReadySinceMs: number | undefined;
  let notReadyDataMark: string | undefined;
  /** DEF-283 の C: 中身の進みが最後にあった時刻。 */
  let contentMovedAtMs: number | undefined;
  /** REV-WSO2: まだ届いていない口ごとの、途中と見た最初と最後の時刻（`longOpenRequestsOf`）。 */
  const openEndpoints: OpenEndpoints = { seen: new Map(), longOpenSeenAtMs: undefined };
  while (clock.now() < deadlineAtMs) {
    if (progress?.signal.aborted === true) {
      return partial('DEADLINE_EXCEEDED', observations, loadPhases);
    }
    if (port.isClosed()) {
      return partial('PAGE_CLOSED', observations, loadPhases);
    }
    const evaluated = await port.readDocumentState(deadlineAtMs);
    if (evaluated.status === 'REJECTED') {
      return partial(port.failureReason(), observations, loadPhases);
    }
    if (evaluated.status === 'DEADLINE_EXCEEDED') {
      return partial('DEADLINE_EXCEEDED', observations, loadPhases);
    }
    const { readyState, scrollHeight } = evaluated.value;
    const data = policy.dataActivity?.();

    const observedAtMs = clock.now();
    if (observedAtMs >= deadlineAtMs) {
      return partial('DEADLINE_EXCEEDED', observations, loadPhases);
    }
    observations.push({ observedAtMs, ...evaluated.value, ...(data === undefined ? {} : { dataInFlight: data.inFlight }) });
    // AUD-2b の直し: DOM の変化の静まりは「新しい作りの印が出ない」で見る（L9・COV-2c と同じ読み取り `structureSignaturesInPage` と判定）。
    // 同じ作りの部品が入れ替わるだけ（回転する告知・スライド）なら、静まったとみなす。
    const structure = await port.readStructureSignatures(deadlineAtMs);
    if (structure.status === 'REJECTED') {
      return partial(port.failureReason(), observations, loadPhases);
    }
    if (structure.status === 'DEADLINE_EXCEEDED') {
      return partial('DEADLINE_EXCEEDED', observations, loadPhases);
    }
    // 読み取りの値が文字列の配列でなければ（読み方の誤り）、新しい作りはなかったものとして扱う。
    const read: readonly unknown[] = Array.isArray(structure.value) ? structure.value : [];
    const newStructure = scrollStructureSignaturesOf(seenStructure, read.filter((signature): signature is string => typeof signature === 'string'));
    const heightKey = String(scrollHeight);
    // EV-3: 読み込み中の表示の数も、新しい値を読んだときだけ中身の進みにする。
    const indicatorKey = JSON.stringify(evaluated.value.loadingIndicators ?? null);
    const contentMoved = newStructure || previousReadyState !== readyState || !seenIndicators.has(indicatorKey);
    const progressed = contentMoved || !seenHeights.has(heightKey);
    if (contentMoved || contentMovedAtMs === undefined) {
      contentMovedAtMs = observedAtMs;
    }
    const contentStopped = progressStoppedOf(contentMovedAtMs, observedAtMs, openDataRequestQuietMs);
    if (progressed) {
      progress?.mark('BROWSER_RESPONSE');
    }
    seenHeights.add(heightKey);
    seenIndicators.add(indicatorKey);
    previousReadyState = readyState;
    // 設計者の判断（2026-11-10）: 口ごとのデータの静まり（一度届いた口のくり返しは数えない）。
    const quiet = data === undefined ? undefined : dataQuietnessOf(data);
    // EV-3: 頼まれたら、見える読み込み中の表示が消えるまで、文書の読み込み中と同じく窓を始めない。
    const notReady = policy.awaitLoadingIndicators === true && !pageReadyOf(evaluated.value.loadingIndicators);
    // REV-WSO2: まだ届いていない口への要求が、直近の窓の間に、窓の長さ以上開いていたか（その瞬間の数でなく、要求の持続で見る）。
    const longRequestOpen = longOpenRequestsOf(openEndpoints, quiet?.pendingEndpoints ?? [], observedAtMs, stableWindowMs);
    if (readyState === 'loading' || notReady) {
      enterPhase('LOADING', observedAtMs);
      stableSinceMs = undefined;
      stableSinceDataMark = undefined;
      // EV-3: 表示が残ったまま、高さ・作り・表示の数・データの通信のどれも動かない状態が、開いた要求の静まりと同じ長さ続いたら、進みが止まったとして、
      // 準備が終わらないまま終える（見張りの反応なしで段ごと見放すと、その状態の記録が残らない）。
      if (notReady && readyState !== 'loading') {
        if (progressed || notReadySinceMs === undefined || quiet?.mark !== notReadyDataMark) {
          notReadySinceMs = observedAtMs;
          notReadyDataMark = quiet?.mark;
        }
        const nothingMoved = observedAtMs - notReadySinceMs >= openDataRequestQuietMs;
        if (nothingMoved || contentStopped) {
          // REV-WSO: 中身だけが止まり、まだ届いていないデータの要求が長く開いていれば、データが届く前に終えたと残す。
          const reason = !nothingMoved && longRequestOpen ? DATA_STILL_LOADING : LOADING_INDICATOR_REMAINED;
          return settledBeforeDeadline(clock, deadlineAtMs, observations, loadPhases, reason);
        }
      }
    } else if (!newStructure && stableSinceMs !== undefined) {
      const dataMoved = quiet !== undefined && quiet.mark !== stableSinceDataMark;
      const dataReached = quiet === undefined || quiet.pending === 0 || (!dataMoved && observedAtMs - stableSinceMs >= openDataRequestQuietMs);
      if (dataMoved && !contentStopped) {
        stableSinceMs = observedAtMs;
        stableSinceDataMark = quiet.mark;
      }
      // REV-WSO: 中身が止まり、まだ届いていない口への要求が長く開いたまま終えるなら、データが届く前に終えたと残す（段は `AFTER_DATA` にしない）。
      const stillLoading = !dataReached && longRequestOpen;
      if (!dataReached && !contentStopped) {
        enterPhase('LOADING', observedAtMs);
      } else {
        enterPhase(stillLoading ? 'LOADING' : 'AFTER_DATA', observedAtMs);
        // 窓は、中身が止まった後も同じ長さ待つ（読み込み中の表示を出し入れする鎖の、歩の間の一瞬で終えない）。
        if (observedAtMs - stableSinceMs >= stableWindowMs) {
          enterPhase('SETTLED', observedAtMs);
          return settledBeforeDeadline(clock, deadlineAtMs, observations, loadPhases, stillLoading ? DATA_STILL_LOADING : 'DOM_AND_HEIGHT_STABLE');
        }
      }
    } else {
      enterPhase(quiet !== undefined && quiet.pending > 0 ? 'LOADING' : 'AFTER_DATA', observedAtMs);
      stableSinceMs = observedAtMs;
      stableSinceDataMark = quiet?.mark;
    }

    const remainingMs = deadlineAtMs - clock.now();
    if (remainingMs <= 0) {
      break;
    }
    await clock.sleep(Math.min(pollIntervalMs, remainingMs));
  }

  return partial('DEADLINE_EXCEEDED', observations, loadPhases);
}

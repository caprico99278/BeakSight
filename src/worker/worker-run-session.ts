/**
 * 監査の流れ（`page-auditor.ts`、Run Coordinator）を通らないワーカーのジョブ（発見 `DISCOVERY`、READ の確かめ `READ_CHECK`）が共有する、Run の
 * ディレクトリとロックと、1 画面の読み込みの部品（Task 27 の設計書 3 章、4.2、4.5。T27d の `discovery-run.ts` から T27e で切り出した。振る舞いは
 * 変えない）。
 *
 * 1. Run の始め（`startWorkerRun`。監査と同じ。CLI の監査から、動いている Run として見える）:
 *    - 出力先の監査中の印を、CLI の監査と同じ部品（`src/core/run-exclusion.ts` の `acquireRunExclusion`。SPEC-2）で取る。
 *      ほかの起動が持っていれば `RUN_ACTIVE`。印の持ち主は、このワーカーの process（終われば OS が放す）。
 *    - Run の ID は今の決まり（`createRunIdFromTime`。DEF-281: 同じ秒の名前がすでにあれば 2 桁の連番を足す）。Run のディレクトリを排他的に作り
 *      （`createRunArtifactDirectoryForStart`）、作れなければ
 *      `RUN_DIRECTORY_UNAVAILABLE`。印を持てたかを決められなかったときは、Run のディレクトリを作れても、その失敗で reject する（止まる側）。
 *      保存の状態は書かない（再開の対象にしない）。
 * 2. Run の終わり（`endWorkerRun`）: 出力先のロックを離す。
 * 3. 1 画面の読み込み（`visitGuardedPage`。凍結は戻せないので、画面ごとに新しい Context）: Guard の付いた新しい Passive の Context と page
 *    （`openPassiveSessionBeforeDeadline`。認証の状態は factory が世代つきで受け継ぐ）→ 進行中の要求の数え方（`InFlightRequestCounter`）を
 *    `goto` の前に作る → 読み込みの間隔を待つ（読み込みの直前）→ 読み込み（`navigatePage`）→ セッションの切れの確かめ（Task 25 の設計書 4.3。
 *    Page Auditor と同じ部品 `sessionLostUrlOf`）→ 呼ぶ側の読み取り → Context を閉じる。Safety Ledger の違反と、Guard が止めた要求の数は、
 *    閉じた後に数える。DF-3（DEF-167）: セッションの切れは、決めた時機（`SESSION_LOSS_CHECK_POINTS`。補助 `sessionLostUrlAt` を通す）に確かめる。
 *    読み込みの直後（`navigation`）、呼ぶ側が落ち着きを待った後（`settled`。`stopIfSessionLostAfterSettling`）、読み取りの後と Context を閉じた後
 *    （`pageEnd`）。どこで見つけても、その画面はセッションの切れ（`SESSION_LOST`。`detail` は今のとおり `null`）で、読み取った値は使わない。
 * 秘密（Cookie、localStorage）は、メモリの認証の指定のまま factory に渡し、ここで読まない・書かない。
 * DEF-138: セッションの切れ（`SESSION_LOST`）には、Page Auditor と同じ部品（`authenticated-run.ts` の `observeSessionLossNavigation`・
 * `sessionLossEvidenceOf`）で組み立てた証拠（値を持たない）を付ける。経路は読み込みの前に付けた記録、状態の名前は閉じるときに factory が読んだもの。
 * T37a（Task 37 の設計書 3.1）: 指定に監査の段の状態（`auditStage`）があれば、閉じた後に次の 2 つを確かめる（判定は Run Coordinator と共有する
 * `audit-stage-run.ts` の 1 か所）。状態のない呼び出し（書き込みのジョブ）は、今のまま。
 * - ログインの状態の鍵がなくなった（`sessionKeyLostDetailOf`）: 読めた画面と、読み込みか読み取りが失敗した画面を、セッションの切れ（`SESSION_LOST`。
 *   URL は読み込んだ URL、詳しい理由 `session-key`）にする（Run Coordinator と同じく、そのページを捨てる）。path による切れが先。
 * - 読み込みの前と後の監査の段の数の差（`auditStageObservation`。T37R-fix-B（T37R の M-2）: 上限で断った要求と 401、登録した手続きの呼び出しを止めた数、
 *   サービスの Origin への読み取りでない要求を止めた数、許可 Origin への `fetch`・`xhr` の読み取りでない要求を止めた数。数え方は `audit-stage-run.ts` の
 *   `auditStageReadCountsOf`・`auditStageReadObservationBetween` の 1 か所。画面は 1 つずつ読むので、差はその画面の Context の分。安全側に、閉じるまでの分を
 *   含める）。描けなかった画面かの判定は、呼ぶ側が `isAuditStageReadObstructed` で行う（発見と READ の確かめが共有する）。
 * DEF-144: 指定に違反の中身を受ける口（`onSafetyViolation`）があれば、閉じた後の Ledger に違反があるときに 1 回だけ、違反の中身（`jobSafetyViolationOf`）を
 * 渡す。段は、最初に違反を見た段（Context を作る間 `CONTEXT_OPEN`、読み込みと読み取り `PAGE_LOAD`、呼ぶ側が `enterSubmissionProbe` で入った probe の押下の中
 * `SUBMISSION_PROBE`（押した候補つき）、閉じた後に初めて見た `CONTEXT_CLOSE`）。違反の判定（`violation`）と止まり方は変えない。
 */
import type { BrowserContext, Page } from 'playwright';
import type { BrowserContextFactory } from '../browser/context-factory.js';
import { EXIT_CODES, RUN_UNAVAILABLE_EXIT_CODE } from '../cli/exit-codes.js';
import type { AuditConfig } from '../config/types.js';
import { createRunArtifactDirectoryForStart } from '../core/artifact-layout.js';
import { acquireRunExclusion } from '../core/run-exclusion.js';
import type { RunId, RunStatus, SessionLostDetail } from '../core/contracts.js';
import type { SessionLossEvidence } from '../core/evidence-types.js';
import { CONTEXT_CLOSE_TIMEOUT_MS } from '../core/limits.js';
import type { ObservationWindows } from '../core/observation-windows.js';
import type { NavigationPacer } from '../crawl/navigation-pacer.js';
import { InFlightRequestCounter, type DataEndpointMemory } from '../discovery/settle.js';
import type { PageTimePart, PageTimeRecorder } from '../discovery/page-time-breakdown.js';
import { attachScreenTiming } from '../discovery/screen-watch.js';
import type { ReadCheckAuditStageObservation } from '../discovery/read-check-evaluation.js';
import {
  auditStageReadCountsOf,
  auditStageReadObservationBetween,
  isAuditStageReadObstructed,
  serviceUnauthorizedCountOf,
  serviceUnauthorizedSessionLostDetailOf,
  sessionKeyLostDetailOf,
  type AuditStageRunState,
} from '../orchestration/audit-stage-run.js';
import {
  SESSION_LOSS_CHECK_POINTS,
  isOutsideRunAuditScope,
  observeSessionLossNavigation,
  sessionLossEvidenceOf,
  sessionLostUrlAt,
  type RunAuthentication,
  type SessionLossCheckPoint,
  type SessionLossNavigationRecord,
} from '../orchestration/authenticated-run.js';
import { navigatePage, type PageNavigationResult } from '../orchestration/page-navigation.js';
import { watchAuditScope } from '../orchestration/audit-scope-watch.js';
import { closePassiveContextBeforeDeadline } from '../orchestration/passive-session-close.js';
import { openPassiveSessionBeforeDeadline, passiveSessionOpenDeadlineAtMs } from '../orchestration/passive-session-open.js';
import { blockedRequestsDuringPacingWait, waitWithPageShown } from '../orchestration/visible-pacing-wait.js';
import { createRunIdFromTime } from '../orchestration/run-id.js';
import { jobSafetyViolationOf, type JobSafetyViolation, type JobSafetyViolationPress } from '../safety/job-safety-violation.js';
import { pageLoadFactsOf, type PageLoadFacts } from '../safety/passive-request-guard.js';
import type { SafetyLedger } from '../safety/safety-ledger.js';

/** DEF-129: main frame の文書の要求を受けなかった画面の事実。 */
const NO_PAGE_LOAD: PageLoadFacts = Object.freeze({ limitReached: false });

/** Run を始めた結果（Run のディレクトリは絶対パス）。 */
export type WorkerRunStart =
  | {
    readonly kind: 'STARTED';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly startedAt: Date;
    /** 出力先のロックを離す（`endWorkerRun` が呼ぶ。何回呼んでもよい。reject しない）。 */
    readonly releaseLock: () => Promise<void>;
  }
  | { readonly kind: 'RUN_ACTIVE'; readonly exitCode: number }
  | {
    readonly kind: 'RUN_DIRECTORY_UNAVAILABLE';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly runStatus: RunStatus;
    readonly exitCode: number;
  };

/**
 * Run を始める（ファイルの先頭の 1）。印は出力先 + 対象の ID（設定の `target.id`。PAR-a）。Run の外の失敗は reject する。始めなかったとき
 * （reject を含む）は、取ったロックを離す。
 */
export async function startWorkerRun(
  outputDirectory: string,
  targetId: string,
  clock: () => Date,
): Promise<WorkerRunStart> {
  const runLock = await acquireRunExclusion(outputDirectory, targetId);
  if (runLock.kind === 'HELD') {
    return { kind: 'RUN_ACTIVE', exitCode: RUN_UNAVAILABLE_EXIT_CODE };
  }
  const releaseLock = runLock.kind === 'ACQUIRED' ? runLock.release : async (): Promise<void> => undefined;
  let started = false;
  try {
    const startedAt = clock();
    // DEF-281: 同じ出力先で同じ秒に始めた Run があれば、2 桁の連番を足した Run の ID で作る。
    const created = await createRunArtifactDirectoryForStart(outputDirectory, createRunIdFromTime(startedAt));
    const { runId } = created;
    if (!created.ok) {
      return { kind: 'RUN_DIRECTORY_UNAVAILABLE', runId, runDirectory: created.runDirectory, runStatus: 'FAILED', exitCode: EXIT_CODES.FAILED };
    }
    if (runLock.kind === 'UNAVAILABLE') {
      // ロックなしで Run を進めない（止まる側）。
      throw runLock.cause;
    }
    started = true;
    return { kind: 'STARTED', runId, runDirectory: created.runDirectory, startedAt, releaseLock };
  } finally {
    if (!started) {
      await releaseLock();
    }
  }
}

/** Run を終える（ファイルの先頭の 2）。保存の状態は書かない（再開の対象にしない）。出力先のロックを離す。 */
export async function endWorkerRun(run: Extract<WorkerRunStart, { readonly kind: 'STARTED' }>): Promise<void> {
  await run.releaseLock();
}

/** Safety Ledger の、止めた要求の数（ページ自身が出した送信。method ごとの数の合計）。 */
export const blockedRequestCountOf = (ledger: SafetyLedger): number =>
  Object.values(ledger.snapshot().blockedRequestsByMethod).reduce((total, count) => total + count, 0);

/** Safety Ledger に不変条件の違反があるか。 */
export const hasViolation = (ledger: SafetyLedger): boolean => ledger.snapshot().invariantViolationCount > 0;

/**
 * 1 画面の読み込みの指定（`visitGuardedPage` が受ける形）。T43c: 認証つきの Run の指定（セッションの切れの path）を省略できる形にした（入口の確かめの
 * ジョブ。ログインの状態を持たないので、セッションの切れを確かめない）。認証つきのジョブ（発見・READ の確かめ・書き込み）は、今までどおり認証の
 * 指定を必ず持つ `GuardedPageVisitOptions` を渡す。
 */
export interface GuardedPageLoadOptions {
  readonly config: AuditConfig;
  /** 最終 URL の正規化に使う、残してよい query の名前（`navigatePage` の指定。読み込む URL は変えない）。 */
  readonly allowedQueryParameters: ReadonlySet<string>;
  /** 認証つきの Run の指定（省略すると、セッションの切れを確かめない）。 */
  readonly authentication?: RunAuthentication | undefined;
  /**
   * ジョブの監査の段の状態（T37a。`jobContextFactoryOptions` が作ったもの。発見と READ の確かめだけが渡す）。省略か `null` なら、鍵の消失と、断った要求・
   * 401 の数を確かめない（書き込みのジョブは今のまま）。
   */
  readonly auditStage?: AuditStageRunState | null;
  /**
   * DEF-144: その画面の Context の Ledger に不変条件の違反があったときに、閉じた後に 1 回だけ呼ぶ（違反の中身 `jobSafetyViolationOf`。段は、最初に違反を
   * 見た段）。発見と READ の確かめが、成果物と IPC の要約に残すために渡す。省略すると呼ばない。
   */
  readonly onSafetyViolation?: ((violation: JobSafetyViolation) => void) | undefined;
  /**
   * DEF-233（設計書 `2026-11-09-beaksight-discovery-token-refresh-design.md` 2.3）: 承認したサービスの Origin の 401 で描けなかった画面を、セッションの切れ
   * （詳しい理由 `SERVICE_UNAUTHORIZED`）にするか（判定は `serviceUnauthorizedSessionLostDetailOf`）。操作さがしと READ の確かめのジョブだけが真を渡す
   * （書き込みのジョブは渡さない。今のとおり）。監査の段の状態がなければ使わない。
   */
  readonly serviceUnauthorizedSessionLoss?: boolean | undefined;
  /**
   * DEF-236（設計書 `2026-11-09-beaksight-visible-pacing-wait-design.md` 3.2）: 読み取りを終えた後、閉じる前に、この画面を見せたまま次の読み込みの間隔を待つか。
   * 省略と真は待つ（次の読み込みがあるとみなす）。呼ぶ側が、この画面の後に読み込みがないと分かっているときは偽を渡す（待たずに閉じる）。セッションの切れと
   * 違反の後は、この指定によらず待たない。
   */
  readonly pacingWaitBeforeClose?: boolean | undefined;
  /**
   * COV-2c の M-1（SAFE-2 の 1 の口の後。設計者の判断）: 最初から凍結した Context で読み込むか。真なら、`openFrozenObservationContext` で Context を開き
   * （読み込む前の page を凍結する）、`loadFrozenDocument` で読み込む（読み込みのときの自動の書き込みを届けない）。操作さがしが、2 回目からの祖先の画面に使う。
   * 省略すると今どおり（凍結せずに読み込む）。
   */
  readonly frozenFromStart?: true | undefined;
  /**
   * REV-DQF fix round 3: Run の中で、前の画面までに出たデータの送り先の覚え（発見の流れが Run ごとに 1 つ渡す）。落ち着きの待ちは、まだ届いていない要求がこの画面で
   * 新しい送り先へのものであるときだけ答えを待つ。省略すると、どの送り先も新しい（覚えない）。
   */
  readonly dataEndpointMemory?: DataEndpointMemory | undefined;
  /**
   * DTIME: 操作さがしの 1 画面の時間の内訳を測る口（操作さがしだけが渡す）。間隔の待ちと読み込みを測り、読み取りの間は page ごとの口に置く（深い部品が
   * `timedOnScreen` で待ちを測る）。測るだけで、待ちを変えない。省略すると測らない。
   */
  readonly timing?: PageTimeRecorder | undefined;
  /**
   * RB-8 の残り（RB-12 で行った）: 観察の窓の一式（進行中の要求の数え方の、応答の後の本文の猶予 `discoverySettle.responseBodyGraceMs` を読む）。省略すると本番の値。
   * テストだけが渡す（本番の入口は渡さない。`worker-login-hooks` の (n)・(p)）。
   */
  readonly observationWindows?: ObservationWindows | undefined;
  /**
   * REV-SD の I-1: 読み込みの後、押す前に点検の範囲の外へ移った画面を、呼ぶ側が自分で扱うか（入口の確かめ。移った先を伝えるため）。省略すると、その画面は
   * 読めなかった（`FAILED`）とする。
   */
  readonly outsideAuditScopeHandledByCaller?: true | undefined;
}

/** 認証つきのジョブの 1 画面の読み込みの指定（認証の指定を必ず持つ。今の形）。 */
export interface GuardedPageVisitOptions extends GuardedPageLoadOptions {
  readonly authentication: RunAuthentication;
}

/** 読み込んだ画面で、呼ぶ側が行う読み取りの入力。 */
export interface GuardedPageView {
  readonly page: Page;
  readonly ledger: SafetyLedger;
  /** 読み込みの前に作った、進行中の要求の数え方（呼ぶ側は `dispose` しない）。 */
  readonly counter: InFlightRequestCounter;
  readonly navigation: PageNavigationResult;
  /**
   * DEF-144: 呼ぶ側の読み取りが、送らずに観察する probe の段に入る（`press` は、これから押す候補。押す前の読み直しなど押していない間は `null`）。呼ぶたびに、
   * それまでに Ledger に違反があれば、それを前の段（と前の押下）に結びつける（違反の中身の段 `stage` と `press`）。
   */
  readonly enterSubmissionProbe: (press: JobSafetyViolationPress | null) => void;
  /**
   * DF-3（DEF-167）: 呼ぶ側が、落ち着きを待った後に呼ぶ（時機 `settled`）。セッションが切れていれば、読み取りを止める（例外を投げ、その画面はセッションの
   * 切れ `SESSION_LOST` になる）。認証の指定がなければ何もしない。呼ばなくても、読み取りの後（時機 `pageEnd`）に確かめる。
   */
  readonly stopIfSessionLostAfterSettling: () => void;
  /**
   * REV-SD の I-1: 読み込みから probe の段に入るまでに、main frame が点検の範囲の外へ移った最初の URL（移っていなければ `null`。判定は
   * `audit-scope-watch.ts` の 1 か所）。probe の段に入る時（`enterSubmissionProbe` の最初）と、落ち着いた後（`stopIfSessionLostAfterSettling`）にも見直し、
   * 移っていれば読み取りを止める（その画面は `FAILED`）。
   */
  readonly outsideAuditScope: () => string | null;
}

/** REV-SD の I-1: 押す前に点検の範囲の外へ移ったので、読み取りを止めたことを伝える（`visitGuardedPage` の中だけで使う。その画面は `FAILED`）。 */
class OutsideAuditScopeDuringReadError extends Error {
  constructor() {
    super('the page moved out of the audit scope before BeakSight operated on it; the read was stopped');
    this.name = 'OutsideAuditScopeDuringReadError';
  }
}

/** DF-3: 落ち着きを待った後にセッションの切れを見つけたので、読み取りを止めたことを伝える（`visitGuardedPage` の中だけで使う）。 */
class SessionLostDuringReadError extends Error {
  readonly url: string;

  constructor(url: string) {
    super('the authenticated session was lost after the page settled; the read was stopped');
    this.name = 'SessionLostDuringReadError';
    this.url = url;
  }
}

/**
 * 1 画面の読み込みの結果。`violation` と `blockedRequests` は、Context を閉じた後の Ledger で数える。T37R-fix-B: `auditStageObservation` は、その画面の
 * Context の監査の段の事実（監査の段の状態がなければ `null`）。`SESSION_LOST` の `detail` は、鍵の消失なら `session-key`、path の切れなら `null`。
 */
export type GuardedPageVisit<T> =
  | {
    readonly kind: 'VISITED';
    readonly value: T;
    readonly blockedRequests: number;
    readonly violation: boolean;
    readonly auditStageObservation: ReadCheckAuditStageObservation | null;
    /**
     * DEF-129: その画面の Context で Guard が通した main frame の文書の要求の数（BeakSight 自身の読み込み、リダイレクトの続き、ページが始めた読み込みを
     * 含む。成果物に残す）、T37R2-fix で子の frame の文書の要求の数（別の数）、DEF-130-fix で文書でない要求の数（別の数）、ページが始めた読み込み
     * （main frame か子の frame）と文書でない要求を、それぞれ上限で止めたか（止めたら、その画面は読み切れない）。読み込みの文書の要求がなければ 0 と偽。
     */
    readonly pageLoad: PageLoadFacts;
  }
  | { readonly kind: 'NOT_OPENED'; readonly violation: boolean }
  | { readonly kind: 'FAILED'; readonly blockedRequests: number; readonly violation: boolean }
  | {
    readonly kind: 'SESSION_LOST';
    readonly url: string;
    /** DEF-233: サービスの 401 で描けなかった画面は `SERVICE_UNAUTHORIZED`。 */
    readonly detail: SessionLostDetail | null;
    readonly blockedRequests: number;
    readonly violation: boolean;
    /** DEF-138: セッションの切れの証拠（Page Auditor と同じ部品で組み立てる。値を持たない。組み立てられなければ `null`）。 */
    readonly sessionLoss: SessionLossEvidence | null;
  };

/** DEF-144: 違反の段と押した候補。 */
type SafetyViolationPlace = Pick<JobSafetyViolation, 'stage' | 'press'>;

/**
 * DEF-144: 1 画面の Context で、最初に違反を見た段（と probe の押下の中なら押した候補）を決める部品。段が変わる前（probe の段に入る・次の候補を押す前）と
 * 閉じる前に、Ledger に違反があれば、それを今の段に結びつける（最初の 1 回だけ）。
 */
class SafetyViolationStages {
  readonly #ledger: SafetyLedger;
  #current: SafetyViolationPlace = { stage: 'PAGE_LOAD', press: null };
  #first: SafetyViolationPlace | null = null;

  constructor(ledger: SafetyLedger) {
    this.#ledger = ledger;
  }

  /** probe の段に入る（`press` は、これから押す候補）。 */
  enter(press: JobSafetyViolationPress | null): void {
    this.settle();
    this.#current = { stage: 'SUBMISSION_PROBE', press };
  }

  /** それまでの違反を、今の段に結びつける。 */
  settle(): void {
    if (this.#first === null && hasViolation(this.#ledger)) {
      this.#first = this.#current;
    }
  }

  /** 最初に違反を見た段（閉じる前に見ていなければ `null`）。 */
  first(): SafetyViolationPlace | null {
    return this.#first;
  }
}

/**
 * COV-2c の M-1: 最初から凍結した Context を開く（`openFrozenObservationContext`。開けなければ factory が Context を閉じて投げるので、`FAILED` で返す。
 * 閉じる Context はない）。形は `openPassiveSessionBeforeDeadline` の結果に合わせる。
 */
const openFrozenFromStart = async (
  factory: BrowserContextFactory,
  viewport: Parameters<BrowserContextFactory['openFrozenObservationContext']>[0],
): Promise<
  | Readonly<{ status: 'OPENED'; context: BrowserContext; page: Page; ledger: SafetyLedger }>
  | Readonly<{ status: 'FAILED'; context: undefined; ledger: null }>
> => {
  try {
    const { context, page } = await factory.openFrozenObservationContext(viewport);
    return Object.freeze({ status: 'OPENED', context, page, ledger: factory.getSafetyLedger(context) });
  } catch {
    return Object.freeze({ status: 'FAILED', context: undefined, ledger: null });
  }
};

/** DEF-144: 違反の中身を組み立てて、呼ぶ側に渡す（閉じた後の Ledger）。 */
const reportSafetyViolation = (options: GuardedPageLoadOptions, url: string, ledger: SafetyLedger, place: SafetyViolationPlace): void => {
  options.onSafetyViolation?.(jobSafetyViolationOf({ url, snapshot: ledger.snapshot(), stage: place.stage, press: place.press }));
};

/**
 * 1 画面を読み込み、呼ぶ側の読み取り（`use`）を行う（ファイルの先頭の 3）。例外を投げない（Context と page を作れなければ `NOT_OPENED`、
 * 読み込みか読み取りが例外を投げたら `FAILED`）。Context は必ず閉じる。
 */
export async function visitGuardedPage<T>(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  url: string,
  options: GuardedPageLoadOptions,
  use: (view: GuardedPageView) => Promise<T>,
): Promise<GuardedPageVisit<T>> {
  // DEF-236（設計書 `2026-11-09-beaksight-visible-pacing-wait-design.md` 3.2）: 読み込みの間隔は、セッションを作る前に待つ（新しい空の page を見せたまま待たない。
  // 監査と同じ順）。前の画面は、閉じる前に見せたまま待ったので、ふつうは待たない。
  // DTIME: 口があれば、間隔の待ちと読み込みを測る（測るだけ）。
  const { timing } = options;
  const timed = <R>(part: PageTimePart, work: () => PromiseLike<R>): Promise<R> => (timing === undefined ? Promise.resolve(work()) : timing.measure(part, work));
  await timed('PACING_WAIT', () => pacer.beforeNavigation());
  // COV-2c の M-1: 最初から凍結した Context（`frozenFromStart`）は、factory の口で開く（失敗したら、factory が Context を閉じて投げる）。
  const opened = options.frozenFromStart === true
    ? await openFrozenFromStart(factory, options.config.viewports.primaryDesktop)
    : await openPassiveSessionBeforeDeadline(factory, options.config.viewports.primaryDesktop, passiveSessionOpenDeadlineAtMs());
  if (opened.status !== 'OPENED') {
    if (opened.status === 'FAILED' && opened.context !== undefined) {
      await closePassiveContextBeforeDeadline(factory, opened.context, { timeoutMs: CONTEXT_CLOSE_TIMEOUT_MS });
    }
    const violation = opened.ledger !== null && hasViolation(opened.ledger);
    if (violation && opened.ledger !== null) {
      reportSafetyViolation(options, url, opened.ledger, { stage: 'CONTEXT_OPEN', press: null });
    }
    return { kind: 'NOT_OPENED', violation };
  }
  const { context, page, ledger } = opened;
  // DTIME: 読み取りの間、page ごとの口に時間の内訳の口を置く（閉じる前に外す）。
  const detachTiming = timing === undefined ? null : attachScreenTiming(page, timing);
  // DEF-144: 最初に違反を見た段（と押した候補）。今の段は、読み込みと読み取り。呼ぶ側が probe の段に入るたびと、読み取りの後に、それまでの違反を今の段に
  // 結びつける。
  const stages = new SafetyViolationStages(ledger);
  const auditStage = options.auditStage ?? null;
  const countsBefore = auditStage === null ? null : auditStageReadCountsOf(auditStage);
  // DEF-233: 読み込みの前の 401 の数（後と比べて、この画面の 401 を見分ける）。
  const unauthorizedBefore = serviceUnauthorizedCountOf(auditStage);
  let visit: { readonly kind: 'VISITED'; readonly value: T } | { readonly kind: 'FAILED' } | { readonly kind: 'SESSION_LOST'; readonly url: string };
  // DEF-138: 認証つきのジョブでは、main frame の文書の要求の経路を、セッションの切れの確かめまで記録する（要求を足さない。証拠だけに使う）。DF-3:
  // 確かめは読み取りの後まで続くので、記録は Context を閉じる前に外す。
  const { authentication } = options;
  const route = authentication === undefined ? null : observeSessionLossNavigation(page);
  let routeRecord: SessionLossNavigationRecord | null = null;
  /**
   * DF-3（DEF-167）: 決めた時機（`SESSION_LOSS_CHECK_POINTS`）に、セッションが切れたかを確かめる（Page Auditor と同じ部品 `sessionLostUrlAt`）。当たれば、
   * 証拠の経路を、その時点の記録にする。認証の指定がなければ、いつも `null`。
   */
  const lostUrlAt = (point: SessionLossCheckPoint): string | null => {
    if (authentication === undefined) {
      return null;
    }
    const lost = sessionLostUrlAt(point, page, ledger, authentication.sessionLostPathPrefix);
    if (lost !== null) {
      routeRecord = route?.snapshot() ?? null;
    }
    return lost?.url ?? null;
  };
  // SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 点検の範囲（Page Auditor と同じ Run の範囲 `isOutsideRunAuditScope`）。
  const allowedOrigins = new Set(options.config.site.allowedOrigins);
  const isOutsideAuditScope = (target: string): boolean => isOutsideRunAuditScope(target, allowedOrigins, options.authentication ?? null);
  // REV-SD の I-1: 読み込みから probe の段に入るまで、main frame の移動を見張る（probe の段の後の移動は、BeakSight の押下の結果として probe の部品が扱う）。
  const scope = watchAuditScope(page, isOutsideAuditScope, url);
  let probeEntered = false;
  /** 範囲の外へ移っていれば、読み取りを止める（その画面は `FAILED`）。 */
  const stopIfOutsideAuditScope = (): void => {
    if (scope.outsideUrl() !== null) {
      throw new OutsideAuditScopeDuringReadError();
    }
  };
  try {
    // 進行中の要求の数え方は、読み込みの前に作る（それより前に始まった要求は数えられない）。
    // REV-DQF fix round 3: ほかの画面で出た送り先（`dataEndpointMemory`）は、この画面で新しい送り先でない（答えを待たない）。
    const counter = new InFlightRequestCounter(page, {
      responseBodyGraceMs: options.observationWindows?.discoverySettle.responseBodyGraceMs, knownEndpoints: options.dataEndpointMemory?.known,
    });
    try {
      const load = (): ReturnType<typeof navigatePage> => navigatePage(page, url, {
        timeoutMs: options.config.crawl.navigationTimeoutMs,
        ledger,
        allowedQueryParameters: options.allowedQueryParameters,
        // SD-2: 点検の範囲の外へ移った画面は読まない（読み込みの失敗の扱い）。
        isOutsideAuditScope,
      });
      // COV-2c の M-1: 最初から凍結した Context では、凍結を解かずに読み込む（`loadFrozenDocument`）。
      const navigation = await timed('LOAD', () => (options.frozenFromStart === true ? factory.loadFrozenDocument(page, url, load) : load()));
      // 経路の記録は、読み込みの直後の写しを証拠に使う（鍵の消失の証拠も、この写し）。後の時機で path の切れを見つけたら、その時点の写しにする。
      routeRecord = route?.snapshot() ?? null;
      const lostUrl = lostUrlAt(SESSION_LOSS_CHECK_POINTS.navigation);
      if (lostUrl !== null) {
        visit = { kind: 'SESSION_LOST', url: lostUrl };
      } else {
        const value = await use({
          page,
          ledger,
          counter,
          navigation,
          enterSubmissionProbe: (press) => {
            // REV-SD の I-1: probe の段に入る前に見直し、範囲の外へ移っていれば押さない。入った後は見張らない。
            if (!probeEntered) {
              stopIfOutsideAuditScope();
              probeEntered = true;
              scope.dispose();
            }
            stages.enter(press);
          },
          stopIfSessionLostAfterSettling: () => {
            const lostAfterSettling = lostUrlAt(SESSION_LOSS_CHECK_POINTS.settled);
            if (lostAfterSettling !== null) {
              throw new SessionLostDuringReadError(lostAfterSettling);
            }
            if (!probeEntered) stopIfOutsideAuditScope();
          },
          outsideAuditScope: () => scope.outsideUrl(),
        });
        // DF-3: 読み取りの後（成果物に書く前）にも確かめる。当たれば、読み取った値を使わない。
        const lostAtEnd = lostUrlAt(SESSION_LOSS_CHECK_POINTS.pageEnd);
        // REV-SD の I-1: probe の段に入るまでに範囲の外へ移った画面は、読めなかったとする（呼ぶ側が自分で扱う入口の確かめを除く）。
        if (lostAtEnd === null && options.outsideAuditScopeHandledByCaller !== true) stopIfOutsideAuditScope();
        visit = lostAtEnd === null ? { kind: 'VISITED', value } : { kind: 'SESSION_LOST', url: lostAtEnd };
      }
    } finally {
      // REV-DQF fix round 3: この画面で出た送り先を覚える（後の画面では、新しい送り先でない）。
      options.dataEndpointMemory?.remember(counter.seenEndpoints());
      counter.dispose();
    }
  } catch (error) {
    visit = error instanceof SessionLostDuringReadError ? { kind: 'SESSION_LOST', url: error.url } : { kind: 'FAILED' };
  } finally {
    route?.dispose();
    scope.dispose();
    // DEF-144: 閉じる前に、それまでの違反を今の段に結びつける（閉じた後に初めて見た違反は、閉じる段）。
    stages.settle();
  }
  // DEF-236（設計書 3.2）: 読み取りを終えた後、閉じる前に、この画面を見せたまま次の読み込みの間隔を待つ（監査と同じ部品）。セッションの切れ・違反の後と、呼ぶ側が
  // 次の読み込みがないと伝えた時（`pacingWaitBeforeClose` が偽）は、待たずに閉じる。
  const pacingWait = visit.kind !== 'SESSION_LOST' && !hasViolation(ledger) && options.pacingWaitBeforeClose !== false
    ? await timed('PACING_WAIT', () => waitWithPageShown({ page, ledger, pacer }))
    : null;
  detachTiming?.();
  await closePassiveContextBeforeDeadline(factory, context, { timeoutMs: CONTEXT_CLOSE_TIMEOUT_MS });
  // DF-3: Context を閉じた後にも、もう一度確かめる（閉じる間に Guard が止めた main frame の移動を含める。時機はページの終わり）。
  if (visit.kind !== 'SESSION_LOST') {
    const lostAfterClose = lostUrlAt(SESSION_LOSS_CHECK_POINTS.pageEnd);
    if (lostAfterClose !== null) {
      visit = { kind: 'SESSION_LOST', url: lostAfterClose };
    }
  }
  // 閉じた後の Ledger で数える（閉じる間に Guard が止めた送信と、記録された違反も含める）。DEF-236: 見せたままの待ちの間に止めた送信は、数えない（記録には残る）。
  const counts = {
    blockedRequests: blockedRequestCountOf(ledger) - (pacingWait === null ? 0 : blockedRequestsDuringPacingWait(pacingWait)),
    violation: hasViolation(ledger),
  };
  if (counts.violation) {
    reportSafetyViolation(options, url, ledger, stages.first() ?? { stage: 'CONTEXT_CLOSE', press: null });
  }
  // DEF-138: 証拠は、閉じた後に組み立てる（閉じるときに factory が読んだ状態の名前と、閉じる間に止めた要求を含める）。
  const evidenceOf = (stage: SessionLostDetail | null): SessionLossEvidence | null =>
    sessionLossEvidenceOfVisit(factory, { url, page, context, ledger, route: routeRecord, stage, options });
  if (visit.kind === 'SESSION_LOST') {
    return { ...visit, detail: null, ...counts, sessionLoss: evidenceOf(null) };
  }
  // T37a: 鍵の消失は、閉じるときに factory が状態を読み直して知らせる（閉じた後に確かめる）。
  const keyLostDetail = sessionKeyLostDetailOf(auditStage);
  if (keyLostDetail !== null) {
    return { kind: 'SESSION_LOST', url, detail: keyLostDetail, ...counts, sessionLoss: evidenceOf(keyLostDetail) };
  }
  if (visit.kind === 'FAILED') {
    return { ...visit, ...counts };
  }
  const auditStageObservation = auditStage === null || countsBefore === null
    ? null
    : auditStageReadObservationBetween(countsBefore, auditStageReadCountsOf(auditStage));
  // DEF-233（設計書 2.3）: 承認したサービスの Origin の 401 を受け、描けなかった画面（`SERVICE_READ_REFUSED` の判定）は、セッションの切れにする（その画面の
  // 結果は採らない。DEF-200 のログインし直しの後に読み直す）。指定のあるジョブだけ。
  const unauthorizedDetail = options.serviceUnauthorizedSessionLoss === true
    ? serviceUnauthorizedSessionLostDetailOf(
      auditStage, unauthorizedBefore, isAuditStageReadObstructed(auditStageObservation), options.authentication?.automatedRelogin === true,
    )
    : null;
  if (unauthorizedDetail !== null) {
    return { kind: 'SESSION_LOST', url, detail: unauthorizedDetail, ...counts, sessionLoss: evidenceOf(unauthorizedDetail) };
  }
  // DEF-129: Context を閉じた後に、文書の読み込みの事実を読む（Guard の 1 か所が数えた値）。
  const pageLoad = pageLoadFactsOf(page) ?? NO_PAGE_LOAD;
  return { ...visit, auditStageObservation, pageLoad, ...counts };
}

/**
 * DEF-138: 1 画面の読み込みのセッションの切れの証拠（Page Auditor と同じ部品 `sessionLossEvidenceOf`）。認証の指定がなければ `null`。組み立てに失敗しても
 * `null`（セッションの切れの判定と止まり方は変えない）。サイトへの要求を出さない。
 */
function sessionLossEvidenceOfVisit(
  factory: BrowserContextFactory,
  visit: {
    readonly url: string;
    readonly page: Page;
    readonly context: BrowserContext;
    readonly ledger: SafetyLedger;
    readonly route: SessionLossNavigationRecord | null;
    readonly stage: SessionLostDetail | null;
    readonly options: GuardedPageLoadOptions;
  },
): SessionLossEvidence | null {
  const { authentication, config } = visit.options;
  if (authentication === undefined) {
    return null;
  }
  try {
    return sessionLossEvidenceOf({
      stage: visit.stage,
      requestedUrl: visit.url,
      page: visit.page,
      ledger: visit.ledger,
      sessionLostPathPrefix: authentication.sessionLostPathPrefix,
      navigation: visit.route,
      stateNames: typeof factory.authenticatedStateNamesOf === 'function' ? factory.authenticatedStateNamesOf(visit.context) : null,
      allowedOrigins: config.site.allowedOrigins,
      serviceOrigins: authentication.auditStage?.approvedServiceOrigins ?? [],
    });
  } catch {
    return null;
  }
}

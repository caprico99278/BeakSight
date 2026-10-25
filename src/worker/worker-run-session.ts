/**
 * 監査の流れ（`page-auditor.ts`、Run Coordinator）を通らないワーカーのジョブ（発見 `DISCOVERY`、READ の確かめ `READ_CHECK`）が共有する、Run の
 * ディレクトリとロックと、1 画面の読み込みの部品（Task 27 の設計書 3 章、4.2、4.5。T27d の `discovery-run.ts` から T27e で切り出した。振る舞いは
 * 変えない）。
 *
 * 1. Run の始め（`startWorkerRun`。監査と同じ。CLI の監査から、動いている Run として見える）:
 *    - 出力先の開始のロックを、CLI の監査と同じ部品（`src/orchestration/output-start-lock.ts` の `holdOutputStartLock`。CCX-6）で取る。
 *      動いている持ち主のものなら `RUN_ACTIVE`。
 *    - 出力先に動いている Run（Run のロックが `ACTIVE`。`findActiveRunInOutputDirectory`）があれば `RUN_ACTIVE`。
 *    - Run の ID は今の決まり（`createRunIdFromTime`）。Run のディレクトリを排他的に作り（`createRunArtifactDirectory`）、作れなければ
 *      `RUN_DIRECTORY_UNAVAILABLE`。Run のロックは保存のセッション（`RunCheckpointSession` の `NEW_RUN`。ロックとハートビートだけを使い、保存の
 *      状態は書かない。再開の対象にしない）で取る。開始のロックは、Run のロックを取った後に離す。
 * 2. Run の終わり（`endWorkerRun`）: ハートビートを止めてから、Run のロックを消す。
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
import { createRunArtifactDirectory } from '../core/artifact-layout.js';
import type { RunId, RunStatus, SessionKeyLostDetail } from '../core/contracts.js';
import type { SessionLossEvidence } from '../core/evidence-types.js';
import { CONTEXT_CLOSE_TIMEOUT_MS } from '../core/limits.js';
import type { NavigationPacer } from '../crawl/navigation-pacer.js';
import { InFlightRequestCounter } from '../discovery/settle.js';
import type { ReadCheckAuditStageObservation } from '../discovery/read-check-evaluation.js';
import {
  auditStageReadCountsOf,
  auditStageReadObservationBetween,
  sessionKeyLostDetailOf,
  type AuditStageRunState,
} from '../orchestration/audit-stage-run.js';
import {
  SESSION_LOSS_CHECK_POINTS,
  observeSessionLossNavigation,
  sessionLossEvidenceOf,
  sessionLostUrlAt,
  type RunAuthentication,
  type SessionLossCheckPoint,
  type SessionLossNavigationRecord,
} from '../orchestration/authenticated-run.js';
import { findActiveRunInOutputDirectory, holdOutputStartLock, type OutputLockGraceOptions } from '../orchestration/output-start-lock.js';
import { navigatePage, type PageNavigationResult } from '../orchestration/page-navigation.js';
import { closePassiveContextBeforeDeadline } from '../orchestration/passive-session-close.js';
import { openPassiveSessionBeforeDeadline, passiveSessionOpenDeadlineAtMs } from '../orchestration/passive-session-open.js';
import { RunCheckpointSession } from '../orchestration/run-checkpoint-session.js';
import { createRunIdFromTime } from '../orchestration/run-id.js';
import type { ArtifactWriter } from '../report/artifact-writer.js';
import { jobSafetyViolationOf, type JobSafetyViolation, type JobSafetyViolationPress } from '../safety/job-safety-violation.js';
import { pageLoadFactsOf, type PageLoadFacts } from '../safety/passive-request-guard.js';
import type { SafetyLedger } from '../safety/safety-ledger.js';

/** DEF-129: main frame の文書の要求を受けなかった画面の事実。 */
const NO_PAGE_LOAD: PageLoadFacts = Object.freeze({
  documentRequests: 0, childFrameDocumentRequests: 0, subresourceRequests: 0, limitReached: false, subresourceLimitReached: false,
});

/** 開始のロックを持たなかった（`UNAVAILABLE`）ときの、離す処理（何もしない。ロックなしで進める）。 */
const releaseNothing = async (): Promise<void> => undefined;

/** Run を始めた結果（Run のディレクトリは絶対パス）。 */
export type WorkerRunStart =
  | {
    readonly kind: 'STARTED';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly startedAt: Date;
    readonly session: RunCheckpointSession;
  }
  | { readonly kind: 'RUN_ACTIVE'; readonly activeRunId: RunId | null; readonly exitCode: number }
  | {
    readonly kind: 'RUN_DIRECTORY_UNAVAILABLE';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly runStatus: RunStatus;
    readonly exitCode: number;
  };

/** Run を始める（ファイルの先頭の 1）。Run の外の失敗は reject する。 */
export async function startWorkerRun(
  writer: ArtifactWriter,
  outputDirectory: string,
  clock: () => Date,
  now: () => number,
  lockGrace: OutputLockGraceOptions = {},
): Promise<WorkerRunStart> {
  // DEF-172: 動いている持ち主のロックが古く見えるときは、取り直す前・動いている Run と決める前に、猶予の後に読み直す（`lockGrace` の待ちは、
  // 省略すると本番の待ち。テストは注入した待ち）。
  const startLock = await holdOutputStartLock(writer, outputDirectory, now(), lockGrace);
  if (startLock.kind === 'HELD_BY_ANOTHER_START') {
    return {
      kind: 'RUN_ACTIVE',
      activeRunId: await findActiveRunInOutputDirectory(writer, outputDirectory, now()),
      exitCode: RUN_UNAVAILABLE_EXIT_CODE,
    };
  }
  const releaseStartLock = startLock.kind === 'ACQUIRED' ? startLock.release : releaseNothing;
  const startedAt = clock();
  try {
    const activeRunId = await findActiveRunInOutputDirectory(writer, outputDirectory, now(), lockGrace);
    if (activeRunId !== null) {
      return { kind: 'RUN_ACTIVE', activeRunId, exitCode: RUN_UNAVAILABLE_EXIT_CODE };
    }
    // DEF-170: Run のディレクトリと Run のロックを作る前に、開始のロックが今も自分のものかを読み直す（違えば、別の起動が開始の段にいるときと同じ）。
    if (startLock.kind === 'ACQUIRED' && !(await startLock.confirm())) {
      return { kind: 'RUN_ACTIVE', activeRunId: await findActiveRunInOutputDirectory(writer, outputDirectory, now()), exitCode: RUN_UNAVAILABLE_EXIT_CODE };
    }
    const runId = createRunIdFromTime(startedAt);
    const created = await createRunArtifactDirectory(outputDirectory, runId);
    if (!created.ok) {
      return { kind: 'RUN_DIRECTORY_UNAVAILABLE', runId, runDirectory: created.runDirectory, runStatus: 'FAILED', exitCode: EXIT_CODES.FAILED };
    }
    const session = new RunCheckpointSession({ store: writer, now });
    const started = await session.start(created.runDirectory, { mode: 'NEW_RUN' });
    if (!started.ok) {
      return { kind: 'RUN_DIRECTORY_UNAVAILABLE', runId, runDirectory: created.runDirectory, runStatus: 'FAILED', exitCode: EXIT_CODES.FAILED };
    }
    return { kind: 'STARTED', runId, runDirectory: created.runDirectory, startedAt, session };
  } finally {
    await releaseStartLock();
  }
}

/** Run を終える（ファイルの先頭の 2）。保存の状態は書かない（再開の対象にしない）。ハートビートを止めてから、Run のロックを消す。 */
export async function endWorkerRun(writer: ArtifactWriter, run: Extract<WorkerRunStart, { readonly kind: 'STARTED' }>): Promise<void> {
  await run.session.abandon();
  await writer.releaseRunLock(run.runDirectory).catch(() => undefined);
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
    readonly detail: SessionKeyLostDetail | null;
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
  const opened = await openPassiveSessionBeforeDeadline(factory, options.config.viewports.primaryDesktop, passiveSessionOpenDeadlineAtMs());
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
  // DEF-144: 最初に違反を見た段（と押した候補）。今の段は、読み込みと読み取り。呼ぶ側が probe の段に入るたびと、読み取りの後に、それまでの違反を今の段に
  // 結びつける。
  const stages = new SafetyViolationStages(ledger);
  const auditStage = options.auditStage ?? null;
  const countsBefore = auditStage === null ? null : auditStageReadCountsOf(auditStage);
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
  try {
    // 進行中の要求の数え方は、読み込みの前に作る（それより前に始まった要求は数えられない）。
    const counter = new InFlightRequestCounter(page);
    try {
      // 読み込みの間隔は、読み込みの直前で待つ（Context の作成の時間に左右されず、読み込みの開始どうしの間隔を設定の値以上にする）。
      await pacer.beforeNavigation();
      const navigation = await navigatePage(page, url, {
        timeoutMs: options.config.crawl.navigationTimeoutMs,
        ledger,
        allowedQueryParameters: options.allowedQueryParameters,
      });
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
          enterSubmissionProbe: (press) => stages.enter(press),
          stopIfSessionLostAfterSettling: () => {
            const lostAfterSettling = lostUrlAt(SESSION_LOSS_CHECK_POINTS.settled);
            if (lostAfterSettling !== null) {
              throw new SessionLostDuringReadError(lostAfterSettling);
            }
          },
        });
        // DF-3: 読み取りの後（成果物に書く前）にも確かめる。当たれば、読み取った値を使わない。
        const lostAtEnd = lostUrlAt(SESSION_LOSS_CHECK_POINTS.pageEnd);
        visit = lostAtEnd === null ? { kind: 'VISITED', value } : { kind: 'SESSION_LOST', url: lostAtEnd };
      }
    } finally {
      counter.dispose();
    }
  } catch (error) {
    visit = error instanceof SessionLostDuringReadError ? { kind: 'SESSION_LOST', url: error.url } : { kind: 'FAILED' };
  } finally {
    route?.dispose();
    // DEF-144: 閉じる前に、それまでの違反を今の段に結びつける（閉じた後に初めて見た違反は、閉じる段）。
    stages.settle();
    await closePassiveContextBeforeDeadline(factory, context, { timeoutMs: CONTEXT_CLOSE_TIMEOUT_MS });
  }
  // DF-3: Context を閉じた後にも、もう一度確かめる（閉じる間に Guard が止めた main frame の移動を含める。時機はページの終わり）。
  if (visit.kind !== 'SESSION_LOST') {
    const lostAfterClose = lostUrlAt(SESSION_LOSS_CHECK_POINTS.pageEnd);
    if (lostAfterClose !== null) {
      visit = { kind: 'SESSION_LOST', url: lostAfterClose };
    }
  }
  // 閉じた後の Ledger で数える（閉じる間に Guard が止めた送信と、記録された違反も含める）。
  const counts = { blockedRequests: blockedRequestCountOf(ledger), violation: hasViolation(ledger) };
  if (counts.violation) {
    reportSafetyViolation(options, url, ledger, stages.first() ?? { stage: 'CONTEXT_CLOSE', press: null });
  }
  // DEF-138: 証拠は、閉じた後に組み立てる（閉じるときに factory が読んだ状態の名前と、閉じる間に止めた要求を含める）。
  const evidenceOf = (stage: SessionKeyLostDetail | null): SessionLossEvidence | null =>
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
    readonly stage: SessionKeyLostDetail | null;
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

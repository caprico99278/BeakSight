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
 *    閉じた後に数える。
 * 秘密（Cookie、localStorage）は、メモリの認証の指定のまま factory に渡し、ここで読まない・書かない。
 */
import type { Page } from 'playwright';
import type { BrowserContextFactory } from '../browser/context-factory.js';
import { EXIT_CODES, RUN_UNAVAILABLE_EXIT_CODE } from '../cli/exit-codes.js';
import type { AuditConfig } from '../config/types.js';
import { createRunArtifactDirectory } from '../core/artifact-layout.js';
import type { RunId, RunStatus } from '../core/contracts.js';
import { CONTEXT_CLOSE_TIMEOUT_MS } from '../core/limits.js';
import type { NavigationPacer } from '../crawl/navigation-pacer.js';
import { InFlightRequestCounter } from '../discovery/settle.js';
import { sessionLostUrlOf, type RunAuthentication } from '../orchestration/authenticated-run.js';
import { findActiveRunInOutputDirectory, holdOutputStartLock } from '../orchestration/output-start-lock.js';
import { navigatePage, type PageNavigationResult } from '../orchestration/page-navigation.js';
import { closePassiveContextBeforeDeadline } from '../orchestration/passive-session-close.js';
import { openPassiveSessionBeforeDeadline, passiveSessionOpenDeadlineAtMs } from '../orchestration/passive-session-open.js';
import { RunCheckpointSession } from '../orchestration/run-checkpoint-session.js';
import { createRunIdFromTime } from '../orchestration/run-id.js';
import type { ArtifactWriter } from '../report/artifact-writer.js';
import type { SafetyLedger } from '../safety/safety-ledger.js';

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
): Promise<WorkerRunStart> {
  const startLock = await holdOutputStartLock(writer, outputDirectory, now());
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
    const activeRunId = await findActiveRunInOutputDirectory(writer, outputDirectory, now());
    if (activeRunId !== null) {
      return { kind: 'RUN_ACTIVE', activeRunId, exitCode: RUN_UNAVAILABLE_EXIT_CODE };
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

/** 1 画面の読み込みの指定。 */
export interface GuardedPageVisitOptions {
  readonly config: AuditConfig;
  /** 最終 URL の正規化に使う、残してよい query の名前（`navigatePage` の指定。読み込む URL は変えない）。 */
  readonly allowedQueryParameters: ReadonlySet<string>;
  readonly authentication: RunAuthentication;
}

/** 読み込んだ画面で、呼ぶ側が行う読み取りの入力。 */
export interface GuardedPageView {
  readonly page: Page;
  readonly ledger: SafetyLedger;
  /** 読み込みの前に作った、進行中の要求の数え方（呼ぶ側は `dispose` しない）。 */
  readonly counter: InFlightRequestCounter;
  readonly navigation: PageNavigationResult;
}

/** 1 画面の読み込みの結果。`violation` と `blockedRequests` は、Context を閉じた後の Ledger で数える。 */
export type GuardedPageVisit<T> =
  | { readonly kind: 'VISITED'; readonly value: T; readonly blockedRequests: number; readonly violation: boolean }
  | { readonly kind: 'NOT_OPENED'; readonly violation: boolean }
  | { readonly kind: 'FAILED'; readonly blockedRequests: number; readonly violation: boolean }
  | { readonly kind: 'SESSION_LOST'; readonly url: string; readonly blockedRequests: number; readonly violation: boolean };

/**
 * 1 画面を読み込み、呼ぶ側の読み取り（`use`）を行う（ファイルの先頭の 3）。例外を投げない（Context と page を作れなければ `NOT_OPENED`、
 * 読み込みか読み取りが例外を投げたら `FAILED`）。Context は必ず閉じる。
 */
export async function visitGuardedPage<T>(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  url: string,
  options: GuardedPageVisitOptions,
  use: (view: GuardedPageView) => Promise<T>,
): Promise<GuardedPageVisit<T>> {
  const opened = await openPassiveSessionBeforeDeadline(factory, options.config.viewports.primaryDesktop, passiveSessionOpenDeadlineAtMs());
  if (opened.status !== 'OPENED') {
    if (opened.status === 'FAILED' && opened.context !== undefined) {
      await closePassiveContextBeforeDeadline(factory, opened.context, { timeoutMs: CONTEXT_CLOSE_TIMEOUT_MS });
    }
    return { kind: 'NOT_OPENED', violation: opened.ledger !== null && hasViolation(opened.ledger) };
  }
  const { context, page, ledger } = opened;
  let visit: { readonly kind: 'VISITED'; readonly value: T } | { readonly kind: 'FAILED' } | { readonly kind: 'SESSION_LOST'; readonly url: string };
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
      const lostUrl = sessionLostUrlOf(page, ledger, options.authentication.sessionLostPathPrefix);
      visit = lostUrl !== null
        ? { kind: 'SESSION_LOST', url: lostUrl }
        : { kind: 'VISITED', value: await use({ page, ledger, counter, navigation }) };
    } finally {
      counter.dispose();
    }
  } catch {
    visit = { kind: 'FAILED' };
  } finally {
    await closePassiveContextBeforeDeadline(factory, context, { timeoutMs: CONTEXT_CLOSE_TIMEOUT_MS });
  }
  // 閉じた後の Ledger で数える（閉じる間に Guard が止めた送信と、記録された違反も含める）。
  return { ...visit, blockedRequests: blockedRequestCountOf(ledger), violation: hasViolation(ledger) };
}

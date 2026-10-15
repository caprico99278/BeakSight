/**
 * READ の確かめのジョブ（`READ_CHECK`）の流れ（Task 27 の設計書 3 章、4.5、4.8 と、変更履歴の「T27a の報告」の (6)、「Blocker: T27c」の行。
 * T27e）。ワーカーの流れ（`audit-worker-session.ts`）が、ログインの段の後に、認証の指定（`RunAuthentication`）と `START` の定義の一覧を付けて
 * 呼ぶ。今の監査の流れには手を入れない。サイトへの要求は GET（Guard の付いた Passive の Context の読み込み）だけ。
 *
 * 1. Run の始めと終わり（発見のジョブと同じ部品 `startWorkerRun`・`endWorkerRun`。出力先の開始のロックと Run のロック）。
 * 2. Run の前の確認（`runPreflight`。認証の指定を付けた factory）。失敗したら、どの定義も確かめずに `PREFLIGHT_FAILED`。
 * 3. 定義を、対象の候補の画面ごとにまとめ（`START` の順に、最初に出た画面の順）、画面ごとに:
 *    a. 対象の画面の URL を、事前の判定（`isReadUrlAllowed`）に通す（止まれば、その画面の定義はすべて `READ_BLOCKED_BY_POLICY`）。
 *    b. 新しい Context で画面を読み込み（間隔を守る。`visitGuardedPage`）、発見の入口で候補を読む（`readCandidatePage`。凍結をかける）。
 *    c. 定義ごとに、候補の今の形を確かめる（`confirmReadTargetOnPage`。識別の digest が同じ候補が 1 つあり、今の分類が `READ`）。
 *    d. URL を組み立てる（`buildReadCheckUrl`。候補の送信先と、定義の送る値だけ。秘密に見える名前を確かめ直し、送る値の名前と値が発見の分類の
 *       危険な語に当たれば読まずに `READ_BLOCKED_BY_POLICY`・`PARAMETER_DANGEROUS_WORD`。T27R-fix-1。DEF-088）。送る値の名前が、今の候補の
 *       送れる欄（純粋な契約の `unsendableReadCheckParameterNames`。保存の確かめと同じ判定）であることを確かめ直す（保存の後に欄が見えない・
 *       readonly・disabled に変わったら、読まずに `READ_BLOCKED_BY_POLICY`・`PARAMETER_NOT_SENDABLE`。fail-closed。CCX-10）。
 *    e. 事前の判定（`isReadUrlAllowed`。止まれば読まずに `READ_BLOCKED_BY_POLICY`）。
 *    f. 凍結した Context では読み込めないので、別の新しい Context で、間隔を守って READ の URL を読み込む（GET）。HTTP の状態を記録する。4xx・5xx は
 *       照らさずに `UNDETERMINED`。落ち着いた後に、構造を 1 回の evaluate で読み（`readSettledPageStructure`）、期待と照らす。
 * 4. 止まり方（発見のジョブと同じ）: 止める要求（今の定義を終えてから）、実行の時間の上限（`crawl.maxRuntimeMs`）、セッションの切れ（Task 25 の
 *    判定。止まった画面の URL を伏せ字を通して知らせる。再開しない）、Safety Ledger の不変条件の違反。止まった後の定義は `NOT_EXECUTED`。
 * 5. 成果物: Run のディレクトリの `read-evidence.json` を、ArtifactWriter（URL の秘密を伏せる書き手）の `writeReadEvidence` で書く。表の全体は
 *    写さない（件数と照らした項目だけ）。結果は、Run の ID、Run のディレクトリ、Run Status、件数の要約（IPC に結果を載せない）。
 * 事前の判定（`isReadUrlAllowed`）: 読み込みの事前の判定の共通の部品（`isRunNavigationBlocked`。巡回の候補の除外 `isExcludedCrawlCandidate` と
 * 同じ部品。CCX-10）を、どの BLOCK でも止める範囲（`ANY_BLOCK`）で呼ぶ。要求の判定の owner（`classifyPassiveRequest`）に、main frame の
 * ナビゲーションの GET として、設定の許可 Origin と認証の設定の監査の段の除外（読まないパス、読む範囲、既定の危険な語）を渡し、BLOCK なら
 * 止め、セッションの切れの path（ログインの画面）も止める。加えて、プロファイルの許可 Origin の外も止める（fail-closed）。
 * 秘密（Cookie、localStorage）は、メモリの認証の指定のまま factory に渡し、ここで読まない・書かない。
 */
import { resolve } from 'node:path';
import type { BrowserContextFactory } from '../browser/context-factory.js';
import { EXIT_CODES } from '../cli/exit-codes.js';
import type { AuditConfig } from '../config/types.js';
import type { WorkerStartReadCheck } from '../control/worker-protocol.js';
import type { RunId, RunStatus } from '../core/contracts.js';
import { wait } from '../core/deadline.js';
import { formatCompactUtcTimestamp } from '../core/utc-timestamp.js';
import { createNavigationPacer, type NavigationPacer } from '../crawl/navigation-pacer.js';
import type { CandidateLocation } from '../discovery/candidate-contracts.js';
import { unsendableReadCheckParameterNames } from '../discovery/read-check-contracts.js';
import {
  READ_CHECK_DETAIL_RESULTS,
  READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION,
  buildReadCheckUrl,
  confirmReadTargetOnPage,
  evaluateReadExpectations,
  readCheckResultOf,
  readEvidenceRunStatusOf,
  readEvidenceSummaryOf,
  readStructureSummaryOf,
  type ReadCandidateConfirmation,
  type ReadCheckDetail,
  type ReadCheckEndReason,
  type ReadCheckEvidence,
  type ReadCheckExecutedEvidence,
  type ReadEvidenceDocument,
  type ReadEvidenceSummary,
} from '../discovery/read-check-evaluation.js';
import { readCandidatePage, readSettledPageStructure, type ReadCandidatePage, type ReadStructureOutcome } from '../discovery/read-executor.js';
import { authenticatedContextOptions, isRunNavigationBlocked, type RunAuthentication } from '../orchestration/authenticated-run.js';
import { closeBrowserBeforeDeadline, runPreflight, type BrowserLauncher } from '../orchestration/preflight.js';
import { ArtifactWriter } from '../report/artifact-writer.js';
import { redactUrlSecrets } from '../safety/redact.js';
import { hasAllowedOrigin } from '../safety/request-policy.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import { endWorkerRun, startWorkerRun, visitGuardedPage, type GuardedPageVisit, type GuardedPageVisitOptions } from './worker-run-session.js';

/** 日時の名前（誤りの文に使う）。 */
const READ_CHECK_TIME_SUBJECT = 'read check run time';

/** HTTP の状態の、誤りの始まり（4xx・5xx は照らさない）。 */
const HTTP_ERROR_STATUS_MIN = 400;

/** READ の確かめの流れの入力。秘密（認証の状態）はメモリの認証の指定の中だけ。 */
export interface ReadCheckRunRequest {
  /** ワーカーが読んだ設定（`WORKER_CONFIG_OVERRIDES` の headless）。 */
  readonly config: AuditConfig;
  /** ジョブの ID（成果物に書き、親が照らし合わせる）。 */
  readonly jobId: string;
  /** ログインの段の後の、認証つきの Run の指定。 */
  readonly authentication: RunAuthentication;
  /** `START` の定義の一覧（契約で、1〜`MAX_WORKER_READ_CHECKS` 件、秘密に見える名前なし）。 */
  readonly readChecks: readonly WorkerStartReadCheck[];
  readonly launchBrowser: BrowserLauncher;
  readonly clock: () => Date;
  readonly now: () => number;
  /** 止める印（今の定義を終えてから止まる）。 */
  readonly stopSignal: AbortSignal;
  /** 読み込みの間隔を守る部品（省略すると、設定の `crawl.minNavigationIntervalMs` で作る。テストが読み込みの開始の時刻を記録するために渡す）。 */
  readonly navigationPacer?: NavigationPacer | undefined;
}

/** 観測の口（ワーカーの流れが IPC に写す）。 */
export interface ReadCheckRunObserver {
  /** Run のディレクトリとロックを作った（`RUN_STARTED`）。 */
  readonly onRunStarted: (event: { readonly runId: RunId; readonly runDirectory: string }) => void;
  /** セッションの切れを見つけた（`AUTH_STATE` の `SESSION_LOST`。URL は伏せ字を通した値）。 */
  readonly onSessionLost: (url: string) => void;
}

/** READ の確かめの流れの結果（Run のディレクトリは絶対パス）。 */
export type ReadCheckRunOutcome =
  | {
    readonly kind: 'RAN';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly runStatus: RunStatus;
    readonly exitCode: number;
    readonly summary: ReadEvidenceSummary;
  }
  | { readonly kind: 'RUN_ACTIVE'; readonly activeRunId: RunId | null; readonly exitCode: number }
  | {
    readonly kind: 'RUN_DIRECTORY_UNAVAILABLE';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly runStatus: RunStatus;
    readonly exitCode: number;
  };

/** 確かめた結果（`checks` は `START` の定義の ID から）。 */
interface CheckResult {
  readonly endReason: ReadCheckEndReason;
  readonly checks: ReadonlyMap<string, ReadCheckEvidence>;
}

/** 画面ごとの定義のまとまり（`START` の順に、最初に出た画面の順）。 */
interface PageGroup {
  readonly page: CandidateLocation | null;
  readonly readChecks: readonly WorkerStartReadCheck[];
}

/** 対象の画面の URL（Origin と path）。 */
const pageUrlOf = (page: CandidateLocation): string => `${page.origin}${page.path}`;

/** 定義を、対象の画面ごとにまとめる（画面の分からない定義は、1 つずつ）。 */
const groupByPage = (readChecks: readonly WorkerStartReadCheck[]): readonly PageGroup[] => {
  const groups: { page: CandidateLocation | null; readChecks: WorkerStartReadCheck[] }[] = [];
  const byUrl = new Map<string, { page: CandidateLocation | null; readChecks: WorkerStartReadCheck[] }>();
  for (const readCheck of readChecks) {
    if (readCheck.targetPage === null) {
      groups.push({ page: null, readChecks: [readCheck] });
      continue;
    }
    const url = pageUrlOf(readCheck.targetPage);
    const group = byUrl.get(url);
    if (group === undefined) {
      const created = { page: readCheck.targetPage, readChecks: [readCheck] };
      byUrl.set(url, created);
      groups.push(created);
    } else {
      group.readChecks.push(readCheck);
    }
  }
  return groups;
};

/**
 * 事前の判定（ファイルの先頭の説明）。読み込みの事前の判定の共通の部品を、どの BLOCK でも止める範囲で呼び、止まれば偽（要求の判定の BLOCK と、
 * セッションの切れの path）。プロファイルの許可 Origin の外も偽。
 */
export const isReadUrlAllowed = (url: string, config: AuditConfig, authentication: RunAuthentication): boolean =>
  !isRunNavigationBlocked(url, new Set(config.site.allowedOrigins), authentication, 'ANY_BLOCK')
  && hasAllowedOrigin(url, new Set(authentication.approvedTestOrigins));

/** 読まずに結果が決まった定義（詳しい理由から結果を決める）。 */
const decidedEvidence = (
  readCheck: WorkerStartReadCheck,
  detail: Exclude<ReadCheckDetail, 'EXPECTATIONS_EVALUATED'>,
  values: { readonly url?: string | null; readonly httpStatus?: number | null; readonly blockedRequests?: number } = {},
): ReadCheckExecutedEvidence => {
  const result = READ_CHECK_DETAIL_RESULTS[detail];
  if (result === null) {
    throw new RangeError(`the READ check detail ${detail} has no result of its own`);
  }
  return Object.freeze({
    readCheckId: readCheck.readCheckId,
    readCheckRevision: readCheck.readCheckRevision,
    targetIdentityDigest: readCheck.definition.targetIdentityDigest,
    state: 'EXECUTED',
    result,
    detail,
    url: values.url ?? null,
    httpStatus: values.httpStatus ?? null,
    blockedRequests: values.blockedRequests ?? 0,
    structure: null,
    expectations: Object.freeze([]),
  });
};

/** 確かめなかった定義。 */
const notExecutedEvidence = (readCheck: WorkerStartReadCheck, reason: Exclude<ReadCheckEndReason, 'COMPLETED'>): ReadCheckEvidence => Object.freeze({
  readCheckId: readCheck.readCheckId,
  readCheckRevision: readCheck.readCheckRevision,
  targetIdentityDigest: readCheck.definition.targetIdentityDigest,
  state: 'NOT_EXECUTED',
  reason,
});

/** READ の URL の読み込みの、読み取りの結果。 */
type ResultPageRead =
  | { readonly kind: 'NAVIGATION_FAILED' }
  | { readonly kind: 'HTTP_ERROR'; readonly httpStatus: number }
  | { readonly kind: 'READ'; readonly httpStatus: number | null; readonly structure: ReadStructureOutcome };

/** 1 つの定義の READ（ファイルの先頭の 3 の c〜f）。止まるべき事象（セッションの切れ、違反）も返す。 */
async function executeReadCheck(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  readCheck: WorkerStartReadCheck,
  confirmation: ReadCandidateConfirmation,
  options: GuardedPageVisitOptions,
): Promise<{ readonly evidence: ReadCheckExecutedEvidence; readonly sessionLostUrl: string | null; readonly violation: boolean }> {
  const done = (evidence: ReadCheckExecutedEvidence): { evidence: ReadCheckExecutedEvidence; sessionLostUrl: null; violation: false } =>
    ({ evidence, sessionLostUrl: null, violation: false });
  switch (confirmation.kind) {
    case 'UNREADABLE':
      return done(decidedEvidence(readCheck, 'TARGET_PAGE_UNREADABLE'));
    case 'NOT_FOUND':
      return done(decidedEvidence(readCheck, 'CANDIDATE_NOT_FOUND'));
    case 'NOT_READ':
      return done(decidedEvidence(readCheck, 'CANDIDATE_NOT_READ'));
    case 'CONFIRMED':
      break;
  }
  const { action } = confirmation.candidate;
  const built = action === null ? { ok: false as const, detail: 'URL_NOT_BUILT' as const } : buildReadCheckUrl(action, readCheck.definition.parameters);
  if (!built.ok) {
    return done(decidedEvidence(readCheck, built.detail));
  }
  // 保存の後に欄が変わった（見えない・readonly・disabled・ない）なら、読まない（保存の確かめと同じ判定。CCX-10）。URL は記録しない。
  if (unsendableReadCheckParameterNames(confirmation.candidate, readCheck.definition.parameters).length > 0) {
    return done(decidedEvidence(readCheck, 'PARAMETER_NOT_SENDABLE'));
  }
  const { url } = built;
  if (!isReadUrlAllowed(url, options.config, options.authentication)) {
    return done(decidedEvidence(readCheck, 'REQUEST_POLICY', { url }));
  }
  const visit = await visitGuardedPage(factory, pacer, url, options, async ({ page, counter, navigation }): Promise<ResultPageRead> => {
    if (navigation.navigationOutcome !== 'OK') {
      return { kind: 'NAVIGATION_FAILED' };
    }
    if (navigation.httpStatus !== null && navigation.httpStatus >= HTTP_ERROR_STATUS_MIN) {
      return { kind: 'HTTP_ERROR', httpStatus: navigation.httpStatus };
    }
    return { kind: 'READ', httpStatus: navigation.httpStatus, structure: await readSettledPageStructure(page, counter) };
  });
  switch (visit.kind) {
    case 'NOT_OPENED':
      return { evidence: decidedEvidence(readCheck, 'NAVIGATION_FAILED', { url }), sessionLostUrl: null, violation: visit.violation };
    case 'FAILED':
      return {
        evidence: decidedEvidence(readCheck, 'NAVIGATION_FAILED', { url, blockedRequests: visit.blockedRequests }),
        sessionLostUrl: null,
        violation: visit.violation,
      };
    case 'SESSION_LOST':
      return {
        evidence: decidedEvidence(readCheck, 'SESSION_LOST', { url, blockedRequests: visit.blockedRequests }),
        sessionLostUrl: visit.url,
        violation: visit.violation,
      };
    case 'VISITED':
      break;
  }
  const read = visit.value;
  const common = { url, blockedRequests: visit.blockedRequests };
  if (read.kind === 'NAVIGATION_FAILED') {
    return { evidence: decidedEvidence(readCheck, 'NAVIGATION_FAILED', common), sessionLostUrl: null, violation: visit.violation };
  }
  if (read.kind === 'HTTP_ERROR') {
    return {
      evidence: decidedEvidence(readCheck, 'HTTP_ERROR_STATUS', { ...common, httpStatus: read.httpStatus }),
      sessionLostUrl: null,
      violation: visit.violation,
    };
  }
  if (read.structure.status !== 'READ') {
    return {
      evidence: decidedEvidence(readCheck, 'RESULT_PAGE_UNREADABLE', { ...common, httpStatus: read.httpStatus }),
      sessionLostUrl: null,
      violation: visit.violation,
    };
  }
  const { structure } = read.structure;
  const expectations = evaluateReadExpectations(structure, readCheck.definition.expectations);
  return {
    evidence: Object.freeze({
      readCheckId: readCheck.readCheckId,
      readCheckRevision: readCheck.readCheckRevision,
      targetIdentityDigest: readCheck.definition.targetIdentityDigest,
      state: 'EXECUTED',
      result: readCheckResultOf(expectations),
      detail: 'EXPECTATIONS_EVALUATED',
      url,
      httpStatus: read.httpStatus,
      blockedRequests: visit.blockedRequests,
      structure: readStructureSummaryOf(structure),
      expectations,
    }),
    sessionLostUrl: null,
    violation: visit.violation,
  };
}

/**
 * 対象の画面を、新しい Context で 1 回だけ読み、発見の入口で候補を読む（ファイルの先頭の 3 の b。凍結をかけるので、READ の URL は別の Context で
 * 読む）。読み込みか HTTP の状態が失敗なら、候補は null。
 */
const readTargetCandidates = (
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  pageUrl: string,
  options: GuardedPageVisitOptions,
): Promise<GuardedPageVisit<ReadCandidatePage | null>> => {
  const classificationPolicy = { allowedOrigins: new Set(options.authentication.approvedTestOrigins) };
  return visitGuardedPage(factory, pacer, pageUrl, options, async ({ page, counter, navigation }) =>
    (navigation.navigationOutcome === 'OK' && (navigation.httpStatus === null || navigation.httpStatus < HTTP_ERROR_STATUS_MIN)
      ? readCandidatePage(page, { classificationPolicy, requestCounter: counter })
      : null));
};

/**
 * 1 つの定義の READ の確かめ（T30f。書き込みのジョブの照合の READ が使う。READ の確かめのジョブの 1 画面 1 定義と同じ手順）: 対象の画面の
 * 事前の判定 → 対象の画面の候補の読み取り（`readTargetCandidates`）→ 候補の確かめ → READ（`executeReadCheck`）。止まるべき事象（セッションの切れ、
 * 違反）も返す。例外を投げない（読み込みの部品が投げない）。
 */
export async function verifyReadCheck(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  readCheck: WorkerStartReadCheck,
  options: GuardedPageVisitOptions,
): Promise<{ readonly evidence: ReadCheckEvidence; readonly sessionLostUrl: string | null; readonly violation: boolean }> {
  if (readCheck.targetPage === null) {
    return { evidence: decidedEvidence(readCheck, 'TARGET_PAGE_UNKNOWN'), sessionLostUrl: null, violation: false };
  }
  const pageUrl = pageUrlOf(readCheck.targetPage);
  if (!isReadUrlAllowed(pageUrl, options.config, options.authentication)) {
    return { evidence: decidedEvidence(readCheck, 'REQUEST_POLICY'), sessionLostUrl: null, violation: false };
  }
  const visit = await readTargetCandidates(factory, pacer, pageUrl, options);
  if (visit.violation) {
    return { evidence: decidedEvidence(readCheck, 'TARGET_PAGE_UNREADABLE'), sessionLostUrl: null, violation: true };
  }
  if (visit.kind === 'SESSION_LOST') {
    return { evidence: decidedEvidence(readCheck, 'SESSION_LOST'), sessionLostUrl: visit.url, violation: false };
  }
  const candidatePage = visit.kind === 'VISITED' ? visit.value : null;
  const confirmation: ReadCandidateConfirmation = candidatePage === null
    ? { kind: 'UNREADABLE' }
    : confirmReadTargetOnPage(candidatePage, readCheck.definition.targetIdentityDigest);
  return executeReadCheck(factory, pacer, readCheck, confirmation, options);
}

/** 確かめる（ファイルの先頭の 2〜4）。 */
async function check(request: ReadCheckRunRequest, outputDirectory: string, observer: ReadCheckRunObserver): Promise<CheckResult> {
  const { config, authentication, stopSignal, now } = request;
  const checks = new Map<string, ReadCheckEvidence>();
  const markRest = (reason: Exclude<ReadCheckEndReason, 'COMPLETED'>): void => {
    for (const readCheck of request.readChecks) {
      if (!checks.has(readCheck.readCheckId)) {
        checks.set(readCheck.readCheckId, notExecutedEvidence(readCheck, reason));
      }
    }
  };
  // DEF-100 fix: pacer は PREFLIGHT の前に作り、factory にも渡す（Guard が main frame の文書の要求を送った時刻を記録する）。
  const pacer = request.navigationPacer ?? createNavigationPacer({ minIntervalMs: config.crawl.minNavigationIntervalMs, now, sleep: wait });
  const preflight = await runPreflight({
    config,
    launchBrowser: request.launchBrowser,
    createSafetyLedger: () => new SafetyLedger(),
    outputDirectory,
    contextFactoryOptions: { authentication: authenticatedContextOptions(authentication), navigationPacer: pacer },
  });
  if (!preflight.ok) {
    markRest('PREFLIGHT_FAILED');
    return { endReason: 'PREFLIGHT_FAILED', checks };
  }
  const { browser, factory } = preflight;
  try {
    const options: GuardedPageVisitOptions = {
      config,
      allowedQueryParameters: new Set(config.crawl.allowedQueryParameters),
      authentication,
    };
    const startedAtMs = now();
    /** 止まる理由（止める要求・時間の上限）。止まらなければ null。 */
    const stopReason = (): Extract<ReadCheckEndReason, 'STOPPED' | 'MAX_RUNTIME_REACHED'> | null => {
      if (stopSignal.aborted) {
        return 'STOPPED';
      }
      return now() - startedAtMs >= config.crawl.maxRuntimeMs ? 'MAX_RUNTIME_REACHED' : null;
    };
    for (const group of groupByPage(request.readChecks)) {
      const stopped = stopReason();
      if (stopped !== null) {
        markRest(stopped);
        return { endReason: stopped, checks };
      }
      if (group.page === null) {
        for (const readCheck of group.readChecks) {
          checks.set(readCheck.readCheckId, decidedEvidence(readCheck, 'TARGET_PAGE_UNKNOWN'));
        }
        continue;
      }
      const pageUrl = pageUrlOf(group.page);
      if (!isReadUrlAllowed(pageUrl, config, authentication)) {
        for (const readCheck of group.readChecks) {
          checks.set(readCheck.readCheckId, decidedEvidence(readCheck, 'REQUEST_POLICY'));
        }
        continue;
      }
      // 対象の画面の候補を、新しい Context で 1 回だけ読む（凍結をかけるので、READ の URL は別の Context で読む）。
      const candidateVisit = await readTargetCandidates(factory, pacer, pageUrl, options);
      if (candidateVisit.violation) {
        markRest('SAFETY_VIOLATION');
        return { endReason: 'SAFETY_VIOLATION', checks };
      }
      if (candidateVisit.kind === 'SESSION_LOST') {
        observer.onSessionLost(redactUrlSecrets(candidateVisit.url));
        markRest('AUTH_SESSION_LOST');
        return { endReason: 'AUTH_SESSION_LOST', checks };
      }
      const candidatePage: ReadCandidatePage | null = candidateVisit.kind === 'VISITED' ? candidateVisit.value : null;
      for (const [index, readCheck] of group.readChecks.entries()) {
        // 同じ画面の 2 つ目からの定義の前にも、止める要求と時間の上限を確かめる（今の定義を終えてから止まる）。
        const stoppedBetween = index === 0 ? null : stopReason();
        if (stoppedBetween !== null) {
          markRest(stoppedBetween);
          return { endReason: stoppedBetween, checks };
        }
        const confirmation: ReadCandidateConfirmation = candidatePage === null
          ? { kind: 'UNREADABLE' }
          : confirmReadTargetOnPage(candidatePage, readCheck.definition.targetIdentityDigest);
        const executed = await executeReadCheck(factory, pacer, readCheck, confirmation, options);
        checks.set(readCheck.readCheckId, executed.evidence);
        if (executed.violation) {
          markRest('SAFETY_VIOLATION');
          return { endReason: 'SAFETY_VIOLATION', checks };
        }
        if (executed.sessionLostUrl !== null) {
          observer.onSessionLost(redactUrlSecrets(executed.sessionLostUrl));
          markRest('AUTH_SESSION_LOST');
          return { endReason: 'AUTH_SESSION_LOST', checks };
        }
      }
    }
    return { endReason: 'COMPLETED', checks };
  } finally {
    await closeBrowserBeforeDeadline(browser);
  }
}

/**
 * READ の確かめのジョブを実行する（流れはファイルの先頭）。Run の外の失敗（成果物を書けない `ArtifactWriteError`、予期しない例外）は、そのまま
 * reject する（ワーカーの流れが `classifyCliFailure` で `FAILED` にする）。
 */
export async function executeReadCheckRun(request: ReadCheckRunRequest, observer: ReadCheckRunObserver): Promise<ReadCheckRunOutcome> {
  const outputDirectory = resolve(request.config.output.directory);
  const writer = new ArtifactWriter({ urlSecretRedaction: true });
  const run = await startWorkerRun(writer, outputDirectory, request.clock, request.now);
  if (run.kind !== 'STARTED') {
    return run;
  }
  const { runId, runDirectory, startedAt } = run;
  observer.onRunStarted({ runId, runDirectory });
  try {
    const checked = await check(request, outputDirectory, observer);
    const checks = request.readChecks.flatMap(({ readCheckId }) => {
      const evidence = checked.checks.get(readCheckId);
      return evidence === undefined ? [] : [evidence];
    });
    const base = { endReason: checked.endReason, checks };
    const document: ReadEvidenceDocument = {
      schemaVersion: READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION,
      jobId: request.jobId,
      runId,
      startedAt: formatCompactUtcTimestamp(startedAt, READ_CHECK_TIME_SUBJECT),
      finishedAt: formatCompactUtcTimestamp(request.clock(), READ_CHECK_TIME_SUBJECT),
      runStatus: readEvidenceRunStatusOf(base),
      ...base,
    };
    await writer.writeReadEvidence(runDirectory, document);
    return {
      kind: 'RAN',
      runId,
      runDirectory,
      runStatus: document.runStatus,
      exitCode: EXIT_CODES[document.runStatus],
      summary: readEvidenceSummaryOf(document),
    };
  } finally {
    // 保存の状態は書かない（再開の対象にしない）。ハートビートを止めてから、Run のロックを消す。
    await endWorkerRun(writer, run);
  }
}

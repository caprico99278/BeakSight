import type { Browser } from 'playwright';
import { evaluateCrossPageRules } from '../audit/cross-page-rules.js';
import type { BrowserContextFactory, SafetyLedgerFactory } from '../browser/context-factory.js';
import type { AuditConfig } from '../config/types.js';
import { createRunArtifactDirectory } from '../core/artifact-layout.js';
import type {
  AuditRunResult,
  CrawlLimitState,
  EvidenceRecord,
  Finding,
  IncompleteReason,
  IncompleteReasonCode,
  PageAuditOutcome,
  PageAuditResult,
  PageId,
  RunEnvironment,
  RunId,
  RunRetryRecord,
  RunSummary,
  ViewportAuditResult,
} from '../core/contracts.js';
import { resolveTimeoutMs } from '../core/deadline.js';
import type { NormalizedHttpUrlEvidence, SitemapEvidence } from '../core/evidence-types.js';
import { safeErrorMessage } from '../core/errors.js';
import { isRecord } from '../core/guards.js';
import { deepFreeze } from '../core/immutable.js';
import { BROWSER_CLOSE_TIMEOUT_MS, MAX_ERROR_MESSAGE_LENGTH } from '../core/limits.js';
import { validateArtifact } from '../core/schema-validator.js';
import {
  deriveRunStatus,
  requiredArtifactInvalidReason,
  ruleEvaluationFailureReason,
  unhandledFailureReason,
  type RunStatusInput,
} from '../core/status.js';
import { normalizeUrl } from '../crawl/normalize-url.js';
import { collectSiteMetadata as collectSiteMetadataDefault, type SiteMetadataResult } from '../crawl/site-metadata.js';
import type { SafetyLedger } from '../safety/safety-ledger.js';
import { CrawlFrontier, type CrawlUrlEntry } from './crawl-frontier.js';
import {
  collectRunEnvironment as collectRunEnvironmentDefault,
  readToolVersion as readToolVersionDefault,
} from './environment.js';
import { IdAllocator } from './id-allocator.js';
import {
  navigationFailureDetail,
  PageAuditor,
  SAFETY_VIOLATION_ABORT_REASON,
  type PageAuditorDependencies,
} from './page-auditor.js';
import {
  resolvePassiveSessionDeadlines,
  type PassiveSessionDeadlineOptions,
  type ResolvedPassiveSessionDeadlines,
} from './passive-session-open.js';
import { closeBrowserBeforeDeadline, runPreflight as runPreflightDefault, type BrowserLauncher } from './preflight.js';
import {
  countInteractionOutcomes,
  countPagesByStatus,
  countPartialViewports,
  countViewportPages,
  summarizeRunSafety,
  viewportEvidenceOfType,
} from './run-aggregation.js';
import { createRunIdFromTime } from './run-id.js';
import { skippedPageResult } from './skipped-page.js';

/** Run Coordinator が使う、1ページを監査するもの（`PageAuditor` の入口）。テストでは偽のものを渡せる。 */
export type RunPageAuditor = Pick<PageAuditor, 'audit'>;

/** `RunCoordinator` に注入するもの（Task 14〜17 の設計書 5.6.1）。 */
export interface RunCoordinatorDependencies {
  /** `loadConfig` で検証済みの設定。 */
  readonly config: AuditConfig;
  /** Chromium を起動する関数（本番では `chromium.launch`）。 */
  readonly launchBrowser: BrowserLauncher;
  /** Context ごとに新しい `SafetyLedger` を作る関数。 */
  readonly createSafetyLedger: SafetyLedgerFactory;
  /** 時刻（`startedAt`、`finishedAt`、`runId`、Evidence の `observedAt`）に使う時計。 */
  readonly clock: () => Date;
  /** 期限と実行時間に使う、現在の時刻（ミリ秒）。`Date.now()` と同じ基準でなければならない（`PageAuditorDependencies.now`）。 */
  readonly now: () => number;
  /**
   * 出力先の根のディレクトリ。Run の artifact は、この下の `<runId>` のディレクトリ（`runArtifactDirectory`）に置く。
   * そのディレクトリは、Run の開始の時点で、Run Coordinator が排他的に作る（`createRunArtifactDirectory`。DEF-009）。
   * PREFLIGHT は、そのディレクトリに書けることを確かめる。スクリーンショットも、そのディレクトリの下に置く。
   */
  readonly outputDirectory: string;
  /** `PageAuditor` を作る関数（テストで偽の Page Auditor を渡すため）。省略すると `new PageAuditor(dependencies)`。 */
  readonly createPageAuditor?: (dependencies: PageAuditorDependencies) => RunPageAuditor;
  /** robots.txt と sitemap.xml の取得（テスト用の差し替え口）。省略すると `collectSiteMetadata`。 */
  readonly collectSiteMetadata?: typeof collectSiteMetadataDefault;
  /** PREFLIGHT（テスト用の差し替え口）。省略すると `runPreflight`。 */
  readonly runPreflight?: typeof runPreflightDefault;
  /** 環境の事実の収集（テスト用の差し替え口）。省略すると `collectRunEnvironment`。 */
  readonly collectRunEnvironment?: typeof collectRunEnvironmentDefault;
  /** BeakSight の版の読み取り（テスト用の差し替え口）。省略すると `readToolVersion`。 */
  readonly readToolVersion?: typeof readToolVersionDefault;
  /**
   * Browser を閉じる処理を待つ上限（ms。R15r-4）。省略すると `BROWSER_CLOSE_TIMEOUT_MS`。テストで短い期限を注入するための口である。
   * 正の安全な整数でない場合は、コンストラクタが `RangeError` を投げる。
   */
  readonly browserCloseTimeoutMs?: number;
  /**
   * Context と page の作成・終了の期限の注入口（RP18 の指摘2。DEF-008、R15r-4）。PREFLIGHT、環境の事実、サイトの metadata、
   * Page Auditor に、そのまま渡す（PREFLIGHT には、Browser を閉じる期限 `browserCloseTimeoutMs` も加えて渡す）。
   * 省略した項目は、`limits.ts` の定数（`SESSION_OPEN_TIMEOUT_MS`、`PAGE_CLOSE_TIMEOUT_MS`、`CONTEXT_CLOSE_TIMEOUT_MS`）を使う。
   * 期限が正の安全な整数でない場合は `RangeError`、形が不正な場合は `TypeError` を、コンストラクタが投げる。
   */
  readonly deadlines?: PassiveSessionDeadlineOptions | undefined;
}

/**
 * 再試行の対象の、Desktop の `NAVIGATION_FAILED` の理由の `detail` の一覧（Task 14〜17 の設計書 5.2、5.6.4）。
 * 一時的なナビゲーションの失敗（期限切れと、接続の一時的な失敗）だけである。detail の形は、`navigationFailureDetail` だけが作る。
 * 4xx・5xx の応答（ナビゲーションは `OK`）、安全のための遮断（`BLOCKED_EXTERNAL_REDIRECT`）、そのほかのエラーは、再試行しない。
 */
export const RETRYABLE_NAVIGATION_FAILURE_DETAILS: readonly string[] = Object.freeze([
  navigationFailureDetail({ navigationOutcome: 'TIMEOUT', failureDetail: null }),
  ...[
    'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_EMPTY_RESPONSE',
    'net::ERR_NETWORK_CHANGED',
  ].map((code) => navigationFailureDetail({ navigationOutcome: 'FAILED', failureDetail: code })),
]);

/**
 * Run のディレクトリを、Run の開始の時点で作れなかった（DEF-009。Task 18 の前の整理の設計書 第6章）。`RunCoordinator.run()` が、
 * これで reject する。
 * - `result` は、確定した Run である。PREFLIGHT の失敗と同じく、対象のサイトにアクセスせず、Browser も起動せずに確定したもので、
 *   Run Status は `deriveRunStatus` が導いた `FAILED`、理由は `RUN_DIRECTORY_UNAVAILABLE` である。
 * - この Run の artifact は、書かない（書く場所が、別の Run のディレクトリだから）。確定した Run を返り値にせず、例外にするのは、
 *   呼び出し側が `ArtifactWriter` に渡さないようにするためである。
 * - `alreadyExists` は、同じ名前の Run のディレクトリがすでにあった（`EEXIST`）場合に真。出力先を作れなかった場合などは偽。
 */
export class RunDirectoryUnavailableError extends Error {
  /** 確定した Run（Run Status は `FAILED`）。 */
  readonly result: AuditRunResult;
  /** 作ろうとした Run のディレクトリ。 */
  readonly runDirectory: string;
  /** 同じ名前の Run のディレクトリが、すでにあったか。 */
  readonly alreadyExists: boolean;

  constructor(input: {
    readonly result: AuditRunResult;
    readonly runDirectory: string;
    readonly alreadyExists: boolean;
    readonly cause: unknown;
  }) {
    super(
      `run directory could not be created: ${input.runDirectory}: ${safeErrorMessage(input.cause, MAX_ERROR_MESSAGE_LENGTH)}`,
      { cause: input.cause },
    );
    this.name = 'RunDirectoryUnavailableError';
    this.result = input.result;
    this.runDirectory = input.runDirectory;
    this.alreadyExists = input.alreadyExists;
  }
}

/** 1つの URL の試行の合計の上限（最初の試行と、1回の再試行）。 */
const MAX_NAVIGATION_ATTEMPTS = 2;

/** クロールの上限の理由のコード（Run の理由に並べる順）。 */
const CRAWL_LIMIT_REASON_CODES = Object.freeze([
  'MAX_PAGES_REACHED',
  'MAX_DEPTH_REACHED',
  'MAX_RUNTIME_REACHED',
] as const satisfies readonly IncompleteReasonCode[]);
type CrawlLimitReasonCode = (typeof CRAWL_LIMIT_REASON_CODES)[number];

/** Run Coordinator の `UNHANDLED_FAILURE` の理由の `detail`（`<場面>:<メッセージ>`）の場面の名前。 */
const RUN_FAILURE_LABELS = Object.freeze({
  /** クロール（開始の URL の正規化、metadata、ページの監査、Link の取り出し）の予期しない例外。 */
  crawl: 'run-crawl',
  /** Cross-page rule の評価の予期しない例外。 */
  crossPage: 'run-cross-page',
  /** スキーマの検証の予期しない例外。 */
  validation: 'run-validation',
  /** Browser を閉じる処理の失敗と、期限切れ。 */
  browserClose: 'browser-close',
  /** metadata の取得に使った page を閉じる処理の失敗。 */
  metadataPageClose: 'site-metadata-page-close',
  /** metadata の取得に使った Context を閉じる処理の失敗。 */
  metadataContextClose: 'site-metadata-context-close',
  /** 環境の事実（User-Agent）の読み取りに使った page を閉じる処理の失敗と、期限切れ（RP18 の指摘1）。 */
  environmentPageClose: 'environment-page-close',
  /** 環境の事実（User-Agent）の読み取りに使った Context を閉じる処理の失敗と、期限切れ（RP18 の指摘1）。 */
  environmentContextClose: 'environment-context-close',
} as const);

/**
 * 違反を検出したため、robots.txt と sitemap.xml の取得を始めなかったことを表す Run の理由（Task 19 の前の整理の設計書 4.5。C18f）。
 * `detail` は、始めなかった取得の場面の名前（`site-metadata`）。取得しなかったので、metadata の Evidence は作らない。
 */
const SITE_METADATA_SAFETY_ABORT_REASON: IncompleteReason = Object.freeze({
  code: SAFETY_VIOLATION_ABORT_REASON.code,
  detail: 'site-metadata',
});

/** 予期しない例外で監査を終えられなかった URL の理由。 */
const EXECUTION_INCOMPLETE_REASON: IncompleteReason = Object.freeze({ code: 'EXECUTION_INCOMPLETE', detail: null });

/** 1回の `run()` の途中の状態。 */
interface RunProgress {
  readonly reasons: IncompleteReason[];
  readonly retries: RunRetryRecord[];
  /**
   * この Run で作ったすべての Safety Ledger の登録（作った順。設計書 5.6.5、R15 の I2）。注入された `createSafetyLedger` を包んだ
   * factory が、作るたびに加える。PREFLIGHT、環境の事実、metadata の取得、各ページ（Passive、Interaction、幅の走査）、再試行の前の
   * 試行の Ledger のすべてである。Page Auditor が例外を投げた場合も、その試行の Ledger は、ここにある。
   * Run の Safety の集計（違反、記録の切り詰め、遮断の件数）は、Browser を閉じた後に、ここの snapshot からだけ行う。
   */
  readonly safetyLedgers: SafetyLedger[];
  /**
   * 違反を検出したか（Task 19 の前の整理の設計書 4.5。C18f）。一度真になったら、戻さない（Ledger の違反は減らないため）。
   * `#safetyViolationRecorded` だけが変える。
   */
  safetyViolationDetected: boolean;
  /**
   * 違反を検出したため、監査を始めなかったものがあるか（ページ、ビューポート、幅の走査の幅、Interaction の候補）。
   * 真なら、Run の理由に `SAFETY_VIOLATION_ABORT` を1件だけ加える。違反の確かめが真を返すと、呼び出し側は必ず監査を始めないので、
   * `#safetyViolationRecorded` が真を返したときに真にする。
   */
  stoppedBySafetyViolation: boolean;
  /** 今のページの監査を始めた時点の、Ledger の登録の件数（Page Auditor の中の確かめは、ここから後の Ledger を調べる）。 */
  pageLedgerStart: number;
  /** 監査した URL の、最終の試行の結果。 */
  readonly results: Map<string, PageAuditResult>;
  /** 再試行した URL の、再試行の前の試行の Evidence（最終のページの `evidence` に残す。設計書 5.6.4、R15 の Minor-6）。 */
  readonly retryEvidence: Map<string, readonly EvidenceRecord[]>;
  /**
   * 実行時間の上限を超えたか（設計書 5.6.3）。ページとページの間でだけ確かめるので、最後のページで超え、監査していない URL が
   * 残らない場合も、事実として `crawlLimits.maxRuntimeReached` に記録する（その場合は、Run の理由は付けない。R15 の Minor-4）。
   */
  maxRuntimeExceeded: boolean;
  unhandledFailures: number;
  executionComplete: boolean;
  preflightFailed: boolean;
  guardEnabled: boolean;
  frontier: CrawlFrontier | null;
  allocator: IdAllocator | null;
  startUrl: NormalizedHttpUrlEvidence | null;
  metadata: SiteMetadataResult | null;
}

/**
 * 開始の URL から BFS でクロールし、確定した Run（`AuditRunResult`）を返す（Task 14〜17 の設計書 第5章、5.6）。
 * 同時実行数は1である。依存するものは、コンストラクタで注入する（`RunCoordinatorDependencies`）。
 */
export class RunCoordinator {
  readonly #config: AuditConfig;
  readonly #launchBrowser: BrowserLauncher;
  readonly #createSafetyLedger: SafetyLedgerFactory;
  readonly #clock: () => Date;
  readonly #now: () => number;
  readonly #outputDirectory: string;
  readonly #createPageAuditor: (dependencies: PageAuditorDependencies) => RunPageAuditor;
  readonly #collectSiteMetadata: typeof collectSiteMetadataDefault;
  readonly #runPreflight: typeof runPreflightDefault;
  readonly #collectRunEnvironment: typeof collectRunEnvironmentDefault;
  readonly #readToolVersion: typeof readToolVersionDefault;
  readonly #browserCloseTimeoutMs: number;
  readonly #deadlines: ResolvedPassiveSessionDeadlines;

  constructor(dependencies: RunCoordinatorDependencies) {
    if (!isRecord(dependencies)) {
      throw new TypeError('RunCoordinator dependencies are required');
    }
    const { config, launchBrowser, createSafetyLedger, clock, now, outputDirectory } = dependencies;
    if (!isRecord(config) || !isRecord(config.site) || !isRecord(config.crawl) || !isRecord(config.target)) {
      throw new TypeError('RunCoordinator requires a validated audit configuration');
    }
    for (const [name, value] of [
      ['launchBrowser', launchBrowser],
      ['createSafetyLedger', createSafetyLedger],
      ['clock', clock],
      ['now', now],
    ] as const) {
      if (typeof value !== 'function') {
        throw new TypeError(`RunCoordinator requires a ${name} function`);
      }
    }
    if (typeof outputDirectory !== 'string' || outputDirectory.length === 0) {
      throw new TypeError('RunCoordinator requires a non-empty output directory');
    }
    for (const [name, value] of [
      ['createPageAuditor', dependencies.createPageAuditor],
      ['collectSiteMetadata', dependencies.collectSiteMetadata],
      ['runPreflight', dependencies.runPreflight],
      ['collectRunEnvironment', dependencies.collectRunEnvironment],
      ['readToolVersion', dependencies.readToolVersion],
    ] as const) {
      if (value !== undefined && typeof value !== 'function') {
        throw new TypeError(`RunCoordinator ${name} must be a function when given`);
      }
    }
    this.#config = config;
    this.#launchBrowser = launchBrowser;
    this.#createSafetyLedger = createSafetyLedger;
    this.#clock = clock;
    this.#now = now;
    this.#outputDirectory = outputDirectory;
    this.#createPageAuditor = dependencies.createPageAuditor ?? ((pageAuditorDependencies) => new PageAuditor(pageAuditorDependencies));
    this.#collectSiteMetadata = dependencies.collectSiteMetadata ?? collectSiteMetadataDefault;
    this.#runPreflight = dependencies.runPreflight ?? runPreflightDefault;
    this.#collectRunEnvironment = dependencies.collectRunEnvironment ?? collectRunEnvironmentDefault;
    this.#readToolVersion = dependencies.readToolVersion ?? readToolVersionDefault;
    // 期限の値の検証は、期限の部品と同じもので行う（正の安全な整数でなければ `RangeError`）。
    this.#browserCloseTimeoutMs = resolveTimeoutMs(dependencies.browserCloseTimeoutMs, BROWSER_CLOSE_TIMEOUT_MS);
    // 作成・終了の期限は、ここで検証し、既定値で埋めたものを下へ渡す（RP18 の指摘2）。
    this.#deadlines = resolvePassiveSessionDeadlines(dependencies.deadlines);
  }

  /**
   * Run を実行し、確定した Run を返す（設計書 5.6.1）。
   *
   * 1. 開始の時刻から `runId` を作る。Run のディレクトリを、排他的に作る（DEF-009）。作れなかった場合は、PREFLIGHT を行わず、
   *    対象のサイトにアクセスせず、Browser も起動せずに確定し（環境の事実は集める）、`RunDirectoryUnavailableError` で reject する。
   *    Run Status は、PREFLIGHT の失敗と同じく `FAILED` で、理由は `RUN_DIRECTORY_UNAVAILABLE` である。
   * 2. PREFLIGHT を行う。失敗した場合は、対象のサイトにアクセスせずに確定する（環境の事実は集める）。Run Status は `FAILED`
   *    で、違反が記録された場合は `ABORTED_BY_SAFETY` である（設計書 5.6.7）。
   * 3. 環境の事実を集める。User-Agent を読んだ page と Context の閉じる処理の失敗（期限切れを含む）は、Run の理由に加える。
   * 4. 採番器を作り、開始の URL のページの ID を採番する。
   * 5. robots.txt と sitemap.xml を取得する。Evidence は、開始の URL のページに置く（設計書 5.6.2）。
   * 6. BFS でクロールする（5.6.3）。一時的なナビゲーションの失敗は、1回だけ再試行する（5.6.4）。安全の不変条件の違反を検出した後は、
   *    新しいページを始めず、残りの URL を理由 `SAFETY_VIOLATION_ABORT` の SKIPPED にする。Page Auditor にも、次のビューポート、
   *    幅の走査の次の幅、Interaction の次の候補を始めないよう、違反の確かめを渡す（Task 19 の前の整理の設計書 4.5）。
   * 7. Browser を閉じる（閉じる処理の失敗は、Run の理由に加える）。
   * 8. Cross-page rule を評価する。評価の失敗は、Run の理由に加える。
   * 9. すべてのページと Finding を、スキーマで確かめる。
   * 10. `RunSummary` を組み立て、Run Status を `deriveRunStatus` で導く（5.6.5、5.6.6）。
   *
   * 予期しない例外は、`unhandledFailures` に数え、Run を確定して返す。reject するのは、Run のディレクトリを作れなかった場合
   * （`RunDirectoryUnavailableError`）と、注入した依存が不正な場合（時計が不正な時刻を返す、BeakSight か Playwright の
   * `package.json` が読めない、など）だけである。
   */
  async run(): Promise<AuditRunResult> {
    const config = this.#config;
    const startedAt = this.#clock();
    const runId = createRunIdFromTime(startedAt);
    const startedAtMs = this.#now();
    const toolVersion = await this.#readToolVersion();

    const progress: RunProgress = {
      reasons: [],
      retries: [],
      safetyLedgers: [],
      safetyViolationDetected: false,
      stoppedBySafetyViolation: false,
      pageLedgerStart: 0,
      results: new Map(),
      retryEvidence: new Map(),
      maxRuntimeExceeded: false,
      unhandledFailures: 0,
      executionComplete: false,
      preflightFailed: false,
      guardEnabled: false,
      frontier: null,
      allocator: null,
      startUrl: null,
      metadata: null,
    };

    // この Run の Ledger は、すべて、この factory で作る（PREFLIGHT が作る Context の factory も、これを使う）。作った Ledger は、
    // 登録に加える（設計書 5.6.5）。
    const createSafetyLedger: SafetyLedgerFactory = () => {
      const ledger = this.#createSafetyLedger();
      progress.safetyLedgers.push(ledger);
      return ledger;
    };

    // 1. Run のディレクトリを、排他的に作る（DEF-009）。PREFLIGHT と、対象のサイトへのアクセスの前である。
    const created = await createRunArtifactDirectory(this.#outputDirectory, runId);
    const { runDirectory } = created;

    // 2. PREFLIGHT。PREFLIGHT の Ledger は、上の factory で作るので、登録にある（`safetyLedgers` は集計に使わない）。
    // Run のディレクトリを作れなかった場合は、PREFLIGHT を行わない（Browser を起動しない）。扱いは、PREFLIGHT の失敗と同じである。
    const preflight = created.ok
      ? await this.#runPreflight({
        config,
        launchBrowser: this.#launchBrowser,
        createSafetyLedger,
        outputDirectory: runDirectory,
        deadlines: { ...this.#deadlines, browserCloseTimeoutMs: this.#browserCloseTimeoutMs },
      })
      : null;
    const browser: Browser | null = preflight?.ok === true ? preflight.browser : null;
    const factory: BrowserContextFactory | null = preflight?.ok === true ? preflight.factory : null;
    if (!created.ok) {
      progress.preflightFailed = true;
      progress.reasons.push(runDirectoryUnavailableReason(created.error));
    } else if (preflight?.ok === false) {
      progress.preflightFailed = true;
      progress.reasons.push(preflight.reason);
    } else {
      progress.guardEnabled = true;
    }

    let environment: RunEnvironment;
    try {
      // 3. 環境の事実。PREFLIGHT が失敗した場合も、Browser なしで集める。
      environment = await this.#collectRunEnvironment({
        config,
        browser,
        factory,
        // この Ledger は、Context の factory が作ったもので、すでに登録にある（Safety の集計は、登録からだけ行う）。
        onSafetyLedger: () => undefined,
        // 閉じる処理の失敗（期限切れを含む）は、Run の理由にする（RP18 の指摘1。Context が閉じたことを確かめられていないため、
        // Run は `COMPLETE` にならない。Task 18 の前の整理の設計書 4.2）。
        onCloseFailure: ({ step, error }) => {
          progress.reasons.push(unhandledFailureReason(
            step === 'page' ? RUN_FAILURE_LABELS.environmentPageClose : RUN_FAILURE_LABELS.environmentContextClose,
            error,
          ));
        },
        deadlines: this.#deadlines,
      });
      if (browser !== null && factory !== null) {
        await this.#crawl(factory, runDirectory, startedAtMs, progress);
      }
    } finally {
      // 7. Browser を閉じる。閉じる処理の失敗と、期限（`BROWSER_CLOSE_TIMEOUT_MS`）を過ぎたことは、Run の理由にする（R15 の Minor-2）。
      if (browser !== null) {
        const closeFailure = await closeBrowserBeforeDeadline(browser, { timeoutMs: this.#browserCloseTimeoutMs });
        if (closeFailure !== null) {
          progress.reasons.push(unhandledFailureReason(RUN_FAILURE_LABELS.browserClose, closeFailure.error));
        }
      }
    }

    const result = await this.#finalize({ runId, toolVersion, startedAt, environment, progress });
    if (!created.ok) {
      throw new RunDirectoryUnavailableError({
        result,
        runDirectory,
        alreadyExists: created.alreadyExists,
        cause: created.error,
      });
    }
    return result;
  }

  /** 設計書 5.6.1 の手順4〜6（採番器、metadata、BFS、再試行）。予期しない例外は、数えて、クロールを止める。 */
  async #crawl(
    factory: BrowserContextFactory,
    runDirectory: string,
    startedAtMs: number,
    progress: RunProgress,
  ): Promise<void> {
    const config = this.#config;
    const runtimeLimitReached = (): boolean => this.#now() - startedAtMs >= config.crawl.maxRuntimeMs;
    try {
      const allowedQueryParameters: ReadonlySet<string> = new Set(config.crawl.allowedQueryParameters);
      const startUrl = normalizeUrl(config.site.startUrl, config.site.startUrl, allowedQueryParameters);
      if (!startUrl.ok) {
        throw new Error(`start URL could not be normalized: ${startUrl.reason}`);
      }
      progress.startUrl = startUrl.url;

      // 4. 採番器を作り、開始の URL のページの ID を採番する（metadata の取得の前）。
      const allocator = new IdAllocator();
      progress.allocator = allocator;
      const frontier = new CrawlFrontier(config.crawl.maxDepth, allocator);
      progress.frontier = frontier;
      frontier.discover(startUrl.url, 0);
      const [startEntry] = frontier.entries();
      if (startEntry === undefined) {
        throw new Error('start URL was not discovered');
      }

      // 5. robots.txt と sitemap.xml。違反（PREFLIGHT や環境の事実の Ledger など）を検出した後は、対象のサイトへの新しいアクセスなので、
      // 取得を始めない（Task 19 の前の整理の設計書 4.5）。始めなかったことは Run の理由に残し、metadata の Evidence は作らない
      // （sitemap がないものとして、Cross-page rule は sitemap の判定をしない）。
      if (this.#safetyViolationRecorded(progress, 0)) {
        progress.reasons.push(SITE_METADATA_SAFETY_ABORT_REASON);
      } else {
        const metadata = await this.#collectSiteMetadata({
          contextFactory: factory,
          origin: new URL(startUrl.url).origin,
          config,
          pageId: startEntry.pageId,
          allocator,
          clock: this.#clock,
          deadlines: this.#deadlines,
        });
        // metadata の取得の Ledger は、Context の factory が作ったもので、すでに登録にある（`ledgerSnapshot` は集計に使わない）。
        progress.metadata = metadata;
        for (const { step, error } of metadata.closeFailures) {
          progress.reasons.push(unhandledFailureReason(
            step === 'page' ? RUN_FAILURE_LABELS.metadataPageClose : RUN_FAILURE_LABELS.metadataContextClose,
            error,
          ));
        }
      }

      // 6. BFS。
      const auditor = this.#createPageAuditor({
        contextFactory: factory,
        config,
        allocator,
        clock: this.#clock,
        now: this.#now,
        screenshotRootDirectory: runDirectory,
        deadlines: this.#deadlines,
        // ページの中（次のビューポート、幅の走査の次の幅、Interaction の次の候補の前）の確かめ。今のページで作った Ledger を調べる
        // （それより前の Ledger は、ページを始める前に調べた）。
        safetyViolationRecorded: () => this.#safetyViolationRecorded(progress, progress.pageLedgerStart),
      });
      let limitReason: CrawlLimitReasonCode | null = null;
      let pagesStarted = 0;
      for (let entry = frontier.next(); entry !== undefined; entry = frontier.next()) {
        // 違反を検出した後は、新しいページを始めない（Task 19 の前の整理の設計書 4.5）。ページを始める前に、Run の間に作ったすべての
        // Ledger を調べる。違反の後の URL は、上限より先に、理由 `SAFETY_VIOLATION_ABORT` の SKIPPED にする。
        if (limitReason === null && this.#safetyViolationRecorded(progress, 0)) {
          frontier.markSkipped(entry.url, SAFETY_VIOLATION_ABORT_REASON);
          continue;
        }
        // 次のページを始める前に、毎回、ページ数と実行時間を確かめる。上限に達した後の URL は、すべて SKIPPED にする。
        if (limitReason === null) {
          if (pagesStarted >= config.crawl.maxPages) {
            limitReason = 'MAX_PAGES_REACHED';
          } else if (runtimeLimitReached()) {
            limitReason = 'MAX_RUNTIME_REACHED';
          }
        }
        if (limitReason !== null) {
          frontier.markSkipped(entry.url, Object.freeze({ code: limitReason, detail: null }));
          continue;
        }
        pagesStarted += 1;
        progress.pageLedgerStart = progress.safetyLedgers.length;
        frontier.markAuditing(entry.url);
        const result = await this.#auditWithRetry(auditor, entry, progress);
        progress.results.set(entry.url, result);
        frontier.markFinished(entry.url, result.status);
        // Link は、Desktop の `link` の Evidence から取り、`INTERNAL_NAVIGABLE` のものだけをキューに入れる（ARCH03）。
        for (const url of internalNavigableLinks(result)) {
          frontier.discover(url, entry.depth + 1);
        }
      }
      // 実行時間の上限を超えたかを、事実として記録する。最後のページで超え、監査していない URL が残らない場合も含む
      // （その場合、SKIPPED の URL がないので、Run の理由は付かない）。
      progress.maxRuntimeExceeded = runtimeLimitReached();
      progress.executionComplete = true;
    } catch (error) {
      progress.unhandledFailures += 1;
      progress.reasons.push(unhandledFailureReason(RUN_FAILURE_LABELS.crawl, error));
      // 例外で止まった経路でも、実行時間の上限を超えたかを、事実として記録する（R15r-3。規則は上と同じ 5.6.3）。監査を終えられなかった
      // URL の理由は `EXECUTION_INCOMPLETE` なので、`MAX_RUNTIME_REACHED` の Run の理由は付かず、Run Status の決め方も変わらない。
      progress.maxRuntimeExceeded = runtimeLimitReached();
      // 監査を終えられなかった URL（監査中と、キューに残っているもの）は、隠さずに SKIPPED の結果にする。
      const frontier = progress.frontier;
      if (frontier !== null) {
        for (const entry of frontier.entries()) {
          if (entry.state === 'AUDITING') {
            frontier.markSkipped(entry.url, EXECUTION_INCOMPLETE_REASON);
          }
        }
        for (const entry of frontier.drain()) {
          frontier.markSkipped(entry.url, EXECUTION_INCOMPLETE_REASON);
        }
      }
    }
  }

  /**
   * この Run で作った Ledger（登録の `fromIndex` 番目から後）に、安全の不変条件の違反が1件でも記録されたかを返す（Task 19 の前の
   * 整理の設計書 4.5。C18f）。違反の検出は、ここだけで行う（Run Coordinator が、Ledger の登録を調べる方法）。
   * - 一度検出したら、それ以後は、調べずに真を返す（Ledger の違反は減らないため）。
   * - 真を返したときは、呼び出し側が監査を始めないので、止めたことを記録する（Run の理由の `SAFETY_VIOLATION_ABORT`）。
   * 違反の種類は問わない。件数は、Ledger の snapshot の `invariantViolationCount` で読む（Run の Safety の集計と同じ値）。
   */
  #safetyViolationRecorded(progress: RunProgress, fromIndex: number): boolean {
    if (!progress.safetyViolationDetected) {
      progress.safetyViolationDetected = progress.safetyLedgers
        .slice(fromIndex)
        .some((ledger) => ledger.snapshot().invariantViolationCount > 0);
    }
    if (progress.safetyViolationDetected) {
      progress.stoppedBySafetyViolation = true;
    }
    return progress.safetyViolationDetected;
  }

  /**
   * 1つの URL を監査する。Desktop の `NAVIGATION_FAILED` の detail が再試行の対象なら、同じ `pageId` で1回だけ再試行する
   * （設計書 5.6.4）。Page Auditor には、試行の番号と再試行の判断を渡す（再試行の前の試行のスクリーンショットは、
   * `pages/<pageId>/retry-<n>/<ビューポート>/` に置かれる。DEF-007）。最初の試行は `retries` に記録し、その Evidence は、最終のページの `evidence` に残すために取っておく。
   * 最初の試行の Finding は残さない。その試行の Ledger は登録にあるので、Safety の集計に入る。
   */
  async #auditWithRetry(auditor: RunPageAuditor, entry: CrawlUrlEntry, progress: RunProgress): Promise<PageAuditResult> {
    let outcome: PageAuditOutcome | undefined;
    const earlierEvidence: EvidenceRecord[] = [];
    for (let attempt = 1; attempt <= MAX_NAVIGATION_ATTEMPTS; attempt += 1) {
      // 再試行の判断は、ここだけで行う。Page Auditor には、同じ判断を渡し、再試行の前の試行のスクリーンショットの置き場所を
      // 分けさせる（DEF-007）。再試行も対象のサイトへの新しい監査なので、違反を検出した後は再試行しない（Task 19 の前の整理の
      // 設計書 4.5）。違反は、再試行の対象の失敗のときだけ調べる（止めたことを記録するのは、実際に再試行を止めた場合だけにする）。
      const retryAfter = (desktop: ViewportAuditResult): Pick<RunRetryRecord, 'navigationOutcome' | 'detail'> | null => {
        const retryable = attempt < MAX_NAVIGATION_ATTEMPTS ? retryableNavigationFailure(desktop) : null;
        return retryable === null || this.#safetyViolationRecorded(progress, 0) ? null : retryable;
      };
      outcome = await auditor.audit(entry.url, entry.pageId, {
        attempt,
        precedesRetry: (desktop) => retryAfter(desktop) !== null,
      });
      const retryable = retryAfter(outcome.result.viewports.desktop);
      if (retryable === null) {
        break;
      }
      const { evidence } = outcome.result;
      progress.retries.push(Object.freeze({
        url: entry.url,
        attempt,
        ...retryable,
        evidenceIds: Object.freeze(evidence.map(({ evidenceId }) => evidenceId)),
      }));
      // 再試行が例外で終わった場合も、`retries` の `evidenceIds` の行き先がページに残るよう、ここで記録する。
      earlierEvidence.push(...evidence);
      progress.retryEvidence.set(entry.url, earlierEvidence);
    }
    if (outcome === undefined) {
      throw new Error('page audit did not run');
    }
    return outcome.result;
  }

  /** 設計書 5.6.1 の手順8〜11。 */
  async #finalize(input: {
    readonly runId: RunId;
    readonly toolVersion: string;
    readonly startedAt: Date;
    readonly environment: RunEnvironment;
    readonly progress: RunProgress;
  }): Promise<AuditRunResult> {
    const config = this.#config;
    const { progress } = input;

    // 監査しなかった URL にも結果を作り、発見の順に並べる。metadata の Evidence は、開始の URL のページに置く。
    // `evaluatedPages` は、最終の試行の Evidence だけを持つ（Cross-page rule と件数の入力。設計書 5.6.4）。`pages`（出力）は、
    // それに、再試行の前の試行の Evidence を加えたものである。Evidence は、metadata、再試行の前の試行、最終の試行の順に並べる。
    const evaluatedPages: PageAuditResult[] = [];
    const pages: PageAuditResult[] = [];
    for (const entry of progress.frontier?.entries() ?? []) {
      const result = progress.results.get(entry.url)
        ?? skippedPageResult(entry.url, entry.pageId, entry.skipReason ?? EXECUTION_INCOMPLETE_REASON);
      const metadataRecords = entry.url === progress.startUrl && progress.metadata !== null ? progress.metadata.records : [];
      evaluatedPages.push(withLeadingEvidence(result, metadataRecords));
      pages.push(withLeadingEvidence(result, [...metadataRecords, ...(progress.retryEvidence.get(entry.url) ?? [])]));
    }

    // 8. Cross-page rule。
    const findings: Finding[] = pages.flatMap((page) => page.findings);
    let unverifiedInternalLinkCount = 0;
    if (!progress.preflightFailed && progress.allocator !== null) {
      try {
        const crossPage = evaluateCrossPageRules({
          targetId: config.target.id,
          firstFindingSequence: progress.allocator.nextFindingSequence,
          allowedOrigins: config.site.allowedOrigins,
          allowedQueryParameters: config.crawl.allowedQueryParameters,
          pages: evaluatedPages,
          sitemap: sitemapOf(progress.metadata),
        });
        progress.allocator.advanceFindingSequence(crossPage.nextFindingSequence);
        findings.push(...crossPage.findings);
        progress.reasons.push(...crossPage.failures.map(ruleEvaluationFailureReason));
        unverifiedInternalLinkCount = crossPage.unverifiedInternalLinkCount;
      } catch (error) {
        progress.unhandledFailures += 1;
        progress.reasons.push(unhandledFailureReason(RUN_FAILURE_LABELS.crossPage, error));
      }
    }

    // 9. スキーマの検証。
    let requiredArtifactsValid = true;
    try {
      const invalid = await invalidArtifactReasons(pages, findings);
      requiredArtifactsValid = invalid.length === 0;
      progress.reasons.push(...invalid);
    } catch (error) {
      requiredArtifactsValid = false;
      progress.unhandledFailures += 1;
      progress.reasons.push(unhandledFailureReason(RUN_FAILURE_LABELS.validation, error));
    }

    // 上限への到達（設計書 5.6.3）。
    const skipCodes = new Set(pages.flatMap((page) => (page.status === 'SKIPPED' ? page.incompleteReasons.map(({ code }) => code) : [])));
    const reached = (code: CrawlLimitReasonCode): boolean => skipCodes.has(code);
    const crawlLimits: CrawlLimitState = {
      maxPagesReached: reached('MAX_PAGES_REACHED'),
      maxDepthReached: reached('MAX_DEPTH_REACHED'),
      maxRuntimeReached: reached('MAX_RUNTIME_REACHED') || progress.maxRuntimeExceeded,
    };
    const limitReasons = CRAWL_LIMIT_REASON_CODES
      .filter(reached)
      .map((code): IncompleteReason => Object.freeze({ code, detail: null }));
    // 違反を検出したため、監査を始めなかったものがあれば、止めたことを Run の理由に1件だけ残す（Task 19 の前の整理の設計書 4.5）。
    // Run Status は、違反の件数から `deriveRunStatus` が `ABORTED_BY_SAFETY` と導く（この理由では決めない）。
    const safetyAbortReasons = progress.stoppedBySafetyViolation ? [SAFETY_VIOLATION_ABORT_REASON] : [];
    const reasons = [...limitReasons, ...safetyAbortReasons, ...progress.reasons];

    // Safety の集計（設計書 5.6.5）。この Run で作ったすべての Ledger の、Browser を閉じた後の snapshot からだけ集計する。
    const runSafety = summarizeRunSafety({
      guardEnabled: progress.guardEnabled,
      snapshots: progress.safetyLedgers.map((ledger) => ledger.snapshot()),
    });

    // Run Status の入力（設計書 5.6.6）。Finding の件数は渡さない。件数は、最終の試行の結果から数える。
    const pageCounts = countPagesByStatus(evaluatedPages);
    const interactions = countInteractionOutcomes(evaluatedPages);
    const statusInput: RunStatusInput = {
      preflightFailed: progress.preflightFailed,
      safetyInvariantViolations: runSafety.invariantViolationCount,
      safetyLedgerTruncated: runSafety.recordTruncated,
      incompleteReasons: reasons,
      unhandledFailures: progress.unhandledFailures,
      crawlLimitReached: limitReasons.length > 0,
      requiredArtifactsValid,
      executionComplete: progress.executionComplete,
      skippedRequiredWork: pageCounts.skipped,
      blockedRequiredWork: 0,
      timedOutRequiredWork: 0,
      notObservedRequiredWork: 0,
      notVerifiedRequiredWork: interactions.checkNotCompleted,
      failedRequiredWork: pageCounts.failed + interactions.executionFailed,
      incompleteCollectorCount: countPartialViewports(evaluatedPages),
    };

    const run: RunSummary = {
      schemaVersion: 'run-schema/1.0',
      runId: input.runId,
      toolVersion: input.toolVersion,
      target: { id: config.target.id },
      startUrl: config.site.startUrl,
      allowedOrigins: [...config.site.allowedOrigins],
      runStatus: deriveRunStatus(statusInput),
      startedAt: input.startedAt.toISOString(),
      finishedAt: this.#clock().toISOString(),
      discoveredPageCount: progress.frontier?.discoveredCount ?? 0,
      auditedPageCount: pageCounts.audited,
      partialPageCount: pageCounts.partial,
      failedPageCount: pageCounts.failed,
      skippedPageCount: pageCounts.skipped,
      viewportPageCounts: countViewportPages(evaluatedPages),
      environment: input.environment,
      // 注入した設定そのものを凍結しないよう、写しを記録する。
      effectiveConfig: structuredClone(config),
      safety: runSafety,
      unverifiedInteractionCount: interactions.unverified,
      unverifiedInternalLinkCount,
      retries: [...progress.retries],
      crawlLimits,
      incompleteReasons: reasons,
    };
    // `statusInput` は、`deriveRunStatus` に渡したものと同じ値である（設計書 6.1.1。artifact の書き出しが、Run Status を導き直すのに使う）。
    return deepFreeze({ run, pages, findings, statusInput });
  }
}

/**
 * Run のディレクトリを作れなかった理由（DEF-009）。`detail` は、失敗した作成の例外のメッセージ（`MAX_ERROR_MESSAGE_LENGTH` 以内）。
 * 結果は凍結する。
 */
function runDirectoryUnavailableReason(error: unknown): IncompleteReason {
  return Object.freeze({ code: 'RUN_DIRECTORY_UNAVAILABLE', detail: safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH) });
}

/** Desktop のビューポートの `NAVIGATION_FAILED` の detail が再試行の対象なら、再試行の記録の項目を返す。対象でなければ `null`。 */
function retryableNavigationFailure(
  desktop: ViewportAuditResult,
): Pick<RunRetryRecord, 'navigationOutcome' | 'detail'> | null {
  if (desktop.navigationOutcome === null || desktop.navigationOutcome === 'OK') {
    return null;
  }
  const reason = desktop.incompleteReasons.find(
    ({ code, detail }) => code === 'NAVIGATION_FAILED' && detail !== null && RETRYABLE_NAVIGATION_FAILURE_DETAILS.includes(detail),
  );
  return reason === undefined ? null : { navigationOutcome: desktop.navigationOutcome, detail: reason.detail };
}

/** ページの Desktop の `link` の Evidence のうち、`INTERNAL_NAVIGABLE` のリンクの正規化した URL（文書の順）。 */
function internalNavigableLinks(result: PageAuditResult): NormalizedHttpUrlEvidence[] {
  return viewportEvidenceOfType(result, 'link', ['desktop']).flatMap(({ payload }) =>
    payload.links.flatMap((link) =>
      (link.admission.kind === 'INTERNAL_NAVIGABLE' && link.normalized.ok ? [link.normalized.url] : [])));
}

/**
 * ページの結果の Evidence の先頭に、`records` を加える（metadata の Evidence は設計書 5.6.2、再試行の前の試行の Evidence は 5.6.4）。
 * 加えるものがなければ、結果をそのまま返す。
 */
function withLeadingEvidence(result: PageAuditResult, records: readonly EvidenceRecord[]): PageAuditResult {
  return records.length === 0 ? result : { ...result, evidence: [...records, ...result.evidence] };
}

function sitemapOf(metadata: SiteMetadataResult | null): SitemapEvidence | null {
  return metadata === null ? null : metadata.sitemap;
}

/**
 * スキーマに合わないページと Finding の理由（`REQUIRED_ARTIFACT_INVALID`。`detail` は `<スキーマ>:<ID>:<最初の誤り>`）。
 * 理由の組み立ては `requiredArtifactInvalidReason` だけで行う（CC-022。`ArtifactWriter` と同じ理由になり、重複を除ける）。
 */
async function invalidArtifactReasons(
  pages: readonly PageAuditResult[],
  findings: readonly Finding[],
): Promise<IncompleteReason[]> {
  const reasons: IncompleteReason[] = [];
  const check = async (schema: 'page' | 'finding', id: PageId | string, value: unknown): Promise<void> => {
    const validation = await validateArtifact(schema, value);
    if (!validation.ok) {
      reasons.push(requiredArtifactInvalidReason(schema, id, validation.errors));
    }
  };
  for (const page of pages) {
    await check('page', page.pageId, page);
  }
  for (const finding of findings) {
    await check('finding', finding.findingId, finding);
  }
  return reasons;
}

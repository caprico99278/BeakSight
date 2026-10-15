/**
 * 監査の中核（Task 24 の設計書 3 章、4.1。T24a）: `run` のコマンドから、CLI の表示を除いた部分を切り出したもの。CLI（`run-command.ts`）と
 * ワーカー（Task 24 の 4.2）で共用する。新しい実行の経路は作らない（Run の実行は `RunCoordinator`、判定は `run-checkpoint.ts`）。
 *
 * 段の順（今の `run` のコマンドと同じ。中断した Run の再開の設計書 4.7、4.7.1）:
 * 0. 出力先の開始のロック（DEF-057。Task 24 の設計書 4.6。`output-start-lock.ts` の `holdOutputStartLock`）を取る。別の起動が持っていれば
 *    `RUN_ACTIVE`（終了コード 4。実行中の Run があればその ID、なければ `null`）。開始のロックは、1〜4 の開始の段（Run のロックの作成まで）の
 *    間だけ持ち、保存のセッションの始め方の後に離す。例外の経路と、Run のロックを作る前に終わる経路でも、必ず離す。
 * 1. 出力先の実行中の Run を確かめる（`output-start-lock.ts` の `findActiveRunInOutputDirectory`）。あれば `RUN_ACTIVE`（終了コード 4。
 *    `startNew` でも同じ）。Run も出力も作らない。
 * 2. `startNew` でなければ、途中の Run を選ぶ（`chooseRunToResume`）。版が違えば `VERSION_MISMATCH`（終了コード 4）。
 * 3. 再開の判断と開始の知らせ（設定が違う、壊れた保存）を、観測の口 `onRunStarting` に渡す。
 * 4. 保存のセッションを作り、Run Coordinator に、保存のセッション、再開の入力、止める印を渡して、Run を実行する。保存のセッションが始まると、
 *    観測の口 `onRunStarted` に、Run の ID、Run のディレクトリ、再開の判断を渡す。
 * 5. Run の後:
 *    1. `RunDirectoryUnavailableError` なら `RUN_DIRECTORY_UNAVAILABLE`（終了コードは、確定した Run の Run Status のとおり）。
 *    2. `RunResumeUnavailableError` なら `RESUME_UNAVAILABLE`（終了コード 4）。
 *    3. ほかの例外なら、保存の終わり方が `ABANDON` のときに `abandon()` を呼んでから、例外をそのまま返す（呼び出し側が扱う）。
 *    4. 出力を書く（`writeAuditRunOutputs`）。失敗したら、保存の終わり方に従ってから、例外をそのまま返す。
 *    5. 保存の終わり方に従い（失敗は警告の値として結果に入れる）、`RAN` を返す（終了コードは、書き出した後の Run Status のとおり）。
 *
 * 中核は、日本語の文を書かず、出力先（標準出力、標準エラー）も持たない。結果は、閉じた一覧の `kind` と、外から要る値だけを持つ。CLI の表示は、
 * 結果と観測の口の値から、今と同じ行を組み立てる。
 * 観測の口（`AuditRunObserver`）は、どれも任意である。口の例外と、口が返した Promise の reject は、握りつぶして監査を止めない（Run Coordinator の
 * `onProgress` と同じ扱い）。口は待たない。
 * 判定（ロック、再開できるか、設定、版、選び方、保存の終わり方）は、`run-checkpoint.ts` と Run Coordinator の関数を呼ぶだけで、ここには書かない。
 * ファイルの読み書きと削除は、`ArtifactWriter` に任せる（ARCH08）。
 * 認証つきの Run（`AuditRunDependencies.authentication`）では、この Run の書き手を、URL の秘密を伏せる書き手にする（T25f。`writerFor`）。保存、
 * 診断の記録、最後の出力のすべてを、同じ書き手で書く。
 */
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../browser/chromium-launch.js';
import type { AuditConfig } from '../config/types.js';
import type { NavigationPacer } from '../crawl/navigation-pacer.js';
import type { AuditRunResult, RunId, RunProgressReport, RunStatus } from '../core/contracts.js';
import {
  artifactFilePath,
  isPortableRelativeArtifactPath,
  listCheckpointRunDirectories,
  runArtifactDirectory,
} from '../core/artifact-layout.js';
import { errorCodeOf } from '../core/errors.js';
import { isRunId } from '../core/ids.js';
import { authenticatedRunConfig, runCheckpointAuthenticationOf, type RunAuthentication } from '../orchestration/authenticated-run.js';
import { readPlaywrightVersion, readToolVersion } from '../orchestration/environment.js';
import { findActiveRunInOutputDirectory, holdOutputStartLock } from '../orchestration/output-start-lock.js';
import type { BrowserLauncher } from '../orchestration/preflight.js';
import {
  checkRunCheckpointConsistency,
  checkRunCheckpointPageConsistency,
  decideRunResumption,
  runVersionDifferences,
  selectRunToResume,
  type RunCheckpointAuthentication,
  type RunResumeCandidate,
  type RunResumptionDecision,
  type RunVersionDifference,
} from '../orchestration/run-checkpoint.js';
import {
  RunCheckpointSession,
  type RunCheckpointSessionOptions,
  type RunCheckpointSessionStart,
  type RunCheckpointSessionStartOptions,
} from '../orchestration/run-checkpoint-session.js';
import {
  RunCoordinator,
  RunDirectoryUnavailableError,
  RunResumeUnavailableError,
  type RunCoordinatorCheckpointConclusion,
  type RunCoordinatorDependencies,
  type RunCoordinatorResumeInput,
  type RunNotice,
  type RunResumeUnavailableReason,
} from '../orchestration/run-coordinator.js';
import { ArtifactWriteError, ArtifactWriter } from '../report/artifact-writer.js';
import { createChatGptBundle, type ReadArtifactFile } from '../report/chatgpt-bundle.js';
import { renderHtmlReport } from '../report/html-report.js';
import { buildReportViewModel, type RunSummaryView } from '../report/view-model.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import { RUN_UNAVAILABLE_EXIT_CODE, exitCodeForRunStatus } from './exit-codes.js';

// ---------------------------------------------------------------------------------------------------------------
// 依存と指定
// ---------------------------------------------------------------------------------------------------------------

/** 監査の中核に注入するもの（本番の既定値は `PRODUCTION_RUN_DEPENDENCIES`）。CLI の `RunCommandDependencies` と同じものである。 */
export interface AuditRunDependencies {
  /** Chromium を起動する関数。 */
  readonly launchBrowser: BrowserLauncher;
  /** 時刻に使う時計。 */
  readonly clock: () => Date;
  /** 期限と実行時間に使う、現在の時刻（ミリ秒。`Date.now()` と同じ基準）。保存のセッションのロックの時刻と、ロックの判定にも使う。 */
  readonly now: () => number;
  /**
   * Run Coordinator を作る関数（テスト用の差し替え口。R17r の Minor-2）。省略すると `new RunCoordinator(dependencies)`。
   * 本番の `run` が、確定した Run を書き出すことと、Run の後に保存の終わり方（`checkpointConclusion()`）に従うことを、テストで確かめるために使う。
   */
  readonly createRunCoordinator?: (dependencies: RunCoordinatorDependencies) => Pick<RunCoordinator, 'run' | 'checkpointConclusion'>;
  /**
   * 止める印（中断した Run の再開の設計書 4.6.1）。省略すると、止めない。Run Coordinator に、そのまま渡す（CLI はシグナル、ワーカーは
   * 止める要求とつなぐ）。
   */
  readonly stopSignal?: AbortSignal | undefined;
  /**
   * 認証つきの Run の指定（Task 25 の設計書 4.4 と、変更履歴の 2026-10-10 の T25d の Blocker の行の (1)。T25d）。ワーカーが、ログインの段の後に
   * 渡す（秘密はメモリだけ）。Run Coordinator に、そのまま渡す。渡したときは、再開の比べ（設定の違い）に、認証つきの Run の有効な設定
   * （`authenticatedRunConfig`。`audit.interactions` が false）を使う（Run Coordinator が保存する有効な設定と同じ形にして、止まった Run を
   * 再開できるようにする）。省略すると、今と完全に同じ（CLI は渡さない）。
   * T25f: 渡したときは、Run のディレクトリの書き出し（`ArtifactWriter`。保存、診断の記録、最後の出力）を、URL の秘密を伏せる書き手
   * （`urlSecretRedaction: true`。Task 25 の設計書 4.6）にする。
   */
  readonly authentication?: RunAuthentication | undefined;
  /**
   * 外から渡す、ページの読み込みの間隔を守る部品（CCX-22。CC-085）。ワーカーが、自動ログインの段と同じものを渡す。Run Coordinator に、そのまま
   * 渡す（使い方と、再開のときに使わないことは `RunCoordinatorDependencies.navigationPacer`）。省略すると、今と完全に同じ（CLI は渡さない）。
   */
  readonly navigationPacer?: NavigationPacer | undefined;
}

/** 監査の中核の指定（CLI の引数から決まるもの）。 */
export interface AuditRunOptions {
  /** `--new` を付けた（途中の Run を探さずに、新しい Run を始める。中断した Run の再開の設計書 4.7）。 */
  readonly startNew: boolean;
}

/** 監査の中核の指定の既定値（`--new` なし）。 */
export const DEFAULT_AUDIT_RUN_OPTIONS: AuditRunOptions = Object.freeze({ startNew: false });

/**
 * 本番の依存（Playwright の Chromium と、実際の時計）。Chromium は、CLI の起動の設定（`chromiumLaunchOptions`。channel、ページの先読みを
 * 止める引数、Playwright の既定のシグナルの処理を止める指定）で起動する。設定の値と理由は、`src/browser/chromium-launch.ts` の1か所に置く
 * （中断した Run の再開の設計書 4.7、4.10、サイトへの負荷の制御の設計書 4.9）。
 */
export const PRODUCTION_RUN_DEPENDENCIES: AuditRunDependencies = Object.freeze<AuditRunDependencies>({
  launchBrowser: (options) => chromium.launch(chromiumLaunchOptions({ headless: options.headless })),
  clock: () => new Date(),
  now: () => Date.now(),
});

// ---------------------------------------------------------------------------------------------------------------
// 結果と観測の口
// ---------------------------------------------------------------------------------------------------------------

/**
 * 再開の判断の種類の閉じた一覧。
 * - `NEW_RUN`: 新しい Run を始める（`startNew`、途中の Run がない、設定が違う、壊れた保存、再開できない保存）。
 * - `RESUME`: 途中の Run を、続きから再開する（`decideRunResumption` の `RESUME`）。
 * - `FINALIZE_ONLY`: 違反を検出した後の途中の Run なので、新しいページを監査せずに、最後の処理だけを行う（`decideRunResumption` の値）。
 */
export const AUDIT_RUN_RESUME_DECISION_KINDS = Object.freeze([
  'NEW_RUN',
  'RESUME',
  'FINALIZE_ONLY',
] as const satisfies readonly ('NEW_RUN' | Exclude<RunResumptionDecision, 'NOT_RESUMABLE'>)[]);
export type AuditRunResumeDecisionKind = (typeof AUDIT_RUN_RESUME_DECISION_KINDS)[number];

/** 再開の判断。再開するときは、途中の Run の ID と Run のディレクトリ、`RESUME` なら監査を終えたページの数を持つ。 */
export type AuditRunResumeDecision =
  | { readonly kind: Extract<AuditRunResumeDecisionKind, 'NEW_RUN'> }
  | {
    readonly kind: Extract<AuditRunResumeDecisionKind, 'RESUME'>;
    readonly runId: RunId;
    readonly runDirectory: string;
    /** 保存の、監査を終えたページの数（`completedPageIds` の数）。 */
    readonly completedPages: number;
  }
  | { readonly kind: Extract<AuditRunResumeDecisionKind, 'FINALIZE_ONLY'>; readonly runId: RunId; readonly runDirectory: string };

/**
 * 開始の知らせの種類の閉じた一覧（Run を始める前に、途中の Run について知らせること）。
 * - `CHECKPOINT_UNREADABLE`: 途中の Run の保存を読めないので、再開の対象にしない（壊れた保存）。
 * - `CONFIG_DIFFERS`: 設定が違うので、途中の Run を再開せずに、新しい Run を始める（違う項目のパスを持つ）。
 */
export const AUDIT_RUN_START_NOTICE_KINDS = Object.freeze(['CHECKPOINT_UNREADABLE', 'CONFIG_DIFFERS'] as const);
export type AuditRunStartNoticeKind = (typeof AUDIT_RUN_START_NOTICE_KINDS)[number];

/** 開始の知らせ（知らせる順に並べる）。 */
export type AuditRunStartNotice =
  | { readonly kind: Extract<AuditRunStartNoticeKind, 'CHECKPOINT_UNREADABLE'>; readonly runId: RunId }
  | { readonly kind: Extract<AuditRunStartNoticeKind, 'CONFIG_DIFFERS'>; readonly runId: RunId; readonly differences: readonly string[] };

/** Run を始める前の判断（観測の口 `onRunStarting` に渡す値）。 */
export interface AuditRunStart {
  readonly resumeDecision: AuditRunResumeDecision;
  readonly notices: readonly AuditRunStartNotice[];
}

/** 保存のセッションが始まった Run（観測の口 `onRunStarted` に渡す値）。 */
export interface AuditRunStarted {
  readonly runId: RunId;
  /** Run のディレクトリ（出力先の中。絶対のパス）。 */
  readonly runDirectory: string;
  readonly resumeDecision: AuditRunResumeDecision;
}

/**
 * Run の後の保存の終わり方の失敗の種類の閉じた一覧（終了コードは変えない警告）。
 * - `CHECKPOINT_FINISH_FAILED`: 最後の出力を書いた後に、保存の終わり（最後の状態）を書けなかった（セッションはやめた）。
 * - `CHECKPOINT_CLEANUP_FAILED`: 終わった Run の、使わない再開のための保存を消せなかった（`path` は、消せなかったもの）。
 */
export const AUDIT_RUN_CHECKPOINT_WARNING_KINDS = Object.freeze(['CHECKPOINT_FINISH_FAILED', 'CHECKPOINT_CLEANUP_FAILED'] as const);
export type AuditRunCheckpointWarningKind = (typeof AUDIT_RUN_CHECKPOINT_WARNING_KINDS)[number];

export type AuditRunCheckpointWarning =
  | { readonly kind: Extract<AuditRunCheckpointWarningKind, 'CHECKPOINT_FINISH_FAILED'> }
  | { readonly kind: Extract<AuditRunCheckpointWarningKind, 'CHECKPOINT_CLEANUP_FAILED'>; readonly path: string };

/**
 * 監査の中核の結果の種類の閉じた一覧（今の `run` のコマンドの分岐）。
 * - `RAN`: Run を実行し、出力を書いた（終了コードは、書き出した後の Run Status のとおり）。
 * - `RUN_ACTIVE`: 出力先で別の Run が実行中か、別の起動が開始の段にいる（出力先の開始のロック。DEF-057）ので、Run を始めなかった（終了コード 4）。
 * - `VERSION_MISMATCH`: 途中の Run の版が違うので、Run を始めなかった（終了コード 4）。
 * - `RUN_DIRECTORY_UNAVAILABLE`: Run のディレクトリを作れなかったので、出力を書かなかった（DEF-009。終了コードは、確定した Run の Run Status
 *   のとおり）。
 * - `RESUME_UNAVAILABLE`: 再開のときに、保存のセッションを始められなかった（終了コード 4）。
 * 設定が違う途中の Run は、Run を始めない結果ではなく、知らせ（`CONFIG_DIFFERS`）を添えて新しい Run を始める（今の振る舞い）。
 */
export const AUDIT_RUN_OUTCOME_KINDS = Object.freeze([
  'RAN',
  'RUN_ACTIVE',
  'VERSION_MISMATCH',
  'RUN_DIRECTORY_UNAVAILABLE',
  'RESUME_UNAVAILABLE',
] as const);
export type AuditRunOutcomeKind = (typeof AUDIT_RUN_OUTCOME_KINDS)[number];

/** 監査の中核の結果。どれも終了コード（`exit-codes.ts` の表の値）を持つ。 */
export type AuditRunOutcome =
  | {
    readonly kind: Extract<AuditRunOutcomeKind, 'RAN'>;
    readonly runId: RunId;
    /** 出力を書いた Run のディレクトリ。 */
    readonly runDirectory: string;
    /** 書き出した後の Run Status（スキーマに合わない場合は、導き直した後のもの）。 */
    readonly runStatus: RunStatus;
    readonly exitCode: number;
    readonly resumeDecision: AuditRunResumeDecision;
    readonly notices: readonly AuditRunStartNotice[];
    /** 表示用モデルの要約（結果の表示に使う。数え直さない）。 */
    readonly summary: RunSummaryView;
    readonly checkpointWarnings: readonly AuditRunCheckpointWarning[];
  }
  | {
    readonly kind: Extract<AuditRunOutcomeKind, 'RUN_ACTIVE'>;
    /**
     * 実行中の Run の ID。別の起動が開始の段にいて（出力先の開始のロックを持っていて。DEF-057）、まだ Run のロックがないときは `null`
     * （その起動の Run の ID は、まだ決まっていない）。
     */
    readonly activeRunId: RunId | null;
    readonly exitCode: number;
  }
  | {
    readonly kind: Extract<AuditRunOutcomeKind, 'VERSION_MISMATCH'>;
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly differences: readonly RunVersionDifference[];
    readonly exitCode: number;
  }
  | {
    readonly kind: Extract<AuditRunOutcomeKind, 'RUN_DIRECTORY_UNAVAILABLE'>;
    readonly runId: RunId;
    /** 作れなかった Run のディレクトリ。 */
    readonly runDirectory: string;
    readonly runStatus: RunStatus;
    /** 同じ名前の Run のディレクトリが、すでにあったか。 */
    readonly alreadyExists: boolean;
    /** 作成の失敗（技術的な詳細）。 */
    readonly cause: unknown;
    readonly exitCode: number;
    readonly resumeDecision: AuditRunResumeDecision;
    readonly notices: readonly AuditRunStartNotice[];
  }
  | {
    readonly kind: Extract<AuditRunOutcomeKind, 'RESUME_UNAVAILABLE'>;
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly reason: RunResumeUnavailableReason;
    /** `CHECKPOINT_STORE_FAILED` では、始め方の reject の値（技術的な詳細）。 */
    readonly cause: unknown;
    readonly exitCode: number;
    readonly resumeDecision: AuditRunResumeDecision;
    readonly notices: readonly AuditRunStartNotice[];
  };

/**
 * 観測の口。どれも任意である。口の例外と、口が返した Promise の reject は、握りつぶして監査を止めない。口は待たない。
 * 呼ばれる順: `onRunStarting`（Run を始める前に1回）→ `onRunStarted`（保存のセッションが始まったときに1回）→ `onProgress`・`onNotice`
 * （Run の途中で、Run Coordinator が渡すたびに）。Run を始めない結果（`RUN_ACTIVE`、`VERSION_MISMATCH`）では、どれも呼ばない。
 * Run のディレクトリを作れなかった場合と、保存のセッションを始められなかった場合は、`onRunStarted` を呼ばない。
 */
export interface AuditRunObserver {
  /** 再開の判断と開始の知らせ（Run Coordinator を作る前）。 */
  readonly onRunStarting?: ((start: AuditRunStart) => void) | undefined;
  /** Run の ID、Run のディレクトリ、再開の判断（保存のセッションが始まった直後。PREFLIGHT の前）。 */
  readonly onRunStarted?: ((started: AuditRunStarted) => void) | undefined;
  /** 実行中の進み具合（Run Coordinator の `onProgress` の値そのもの）。 */
  readonly onProgress?: ((report: RunProgressReport) => void) | undefined;
  /** 実行中の知らせ（Run Coordinator の `onNotice` の値そのもの）。 */
  readonly onNotice?: ((notice: RunNotice) => void) | undefined;
}

/** 観測の口を、例外と reject を握りつぶして呼ぶ（Run Coordinator の `#reportProgress` と同じ扱い）。 */
function notifyObserver<T>(hook: ((value: T) => void) | undefined, value: T): void {
  if (hook === undefined) {
    return;
  }
  try {
    // 型は `void` を返す関数だが、async の関数も渡せるので、返った Promise の reject も握りつぶす（扱われない reject にしない）。
    const returned: unknown = hook(value);
    if (returned instanceof Promise) {
      returned.catch(() => undefined);
    }
  } catch {
    // 観測の失敗で、監査を止めない。
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 監査の中核
// ---------------------------------------------------------------------------------------------------------------

/**
 * 保存のセッションが始まったら、Run のディレクトリを知らせるセッション（`RunCheckpointSession` の意味は変えない）。Run Coordinator は、
 * 新しい Run では Run のディレクトリを作った直後、再開では前の回の Run のディレクトリで、`start` を呼ぶ。その結果が `ok` のときだけ、
 * `onStarted` を呼ぶ（呼び出し側が、例外を握りつぶす）。
 */
class StartNotifyingRunCheckpointSession extends RunCheckpointSession {
  readonly #onStarted: (runDirectory: string) => void;
  readonly #afterStartAttempt: () => Promise<void>;

  /**
   * `afterStartAttempt` は、`start` の結果によらず（始められた、始めなかった、reject した）、`start` の後に1回ずつ待つ処理（出力先の開始のロックを
   * 離す。DEF-057）。reject しないものを渡す。
   */
  constructor(options: RunCheckpointSessionOptions, onStarted: (runDirectory: string) => void, afterStartAttempt: () => Promise<void>) {
    super(options);
    this.#onStarted = onStarted;
    this.#afterStartAttempt = afterStartAttempt;
  }

  override async start(runDirectory: string, options: RunCheckpointSessionStartOptions): Promise<RunCheckpointSessionStart> {
    let started: RunCheckpointSessionStart;
    try {
      started = await super.start(runDirectory, options);
    } finally {
      await this.#afterStartAttempt();
    }
    if (started.ok) {
      this.#onStarted(runDirectory);
    }
    return started;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 出力先の開始のロック（DEF-057。Task 24 の設計書 4.6）
// ---------------------------------------------------------------------------------------------------------------

// 開始のロックの取り方と離し方は `src/orchestration/output-start-lock.ts` の `holdOutputStartLock`（CCX-6。ワーカーの Run と同じ部品。DEF-081）。

/**
 * この Run の書き手（T25f。Task 25 の設計書 4.6）。認証つきの Run（`authentication` あり）なら、Run のディレクトリに書く値の URL の秘密を伏せる
 * 書き手（`urlSecretRedaction: true`）、公開監査なら、今と同じ既定の書き手。
 */
function writerFor(dependencies: Pick<AuditRunDependencies, 'authentication'>): ArtifactWriter {
  return dependencies.authentication === undefined ? new ArtifactWriter() : new ArtifactWriter({ urlSecretRedaction: true });
}

/** 開始のロックを持たなかった（`UNAVAILABLE`）ときの、離す処理（何もしない）。 */
const releaseNothing = async (): Promise<void> => undefined;

/**
 * 保存のセッションが始まった Run のディレクトリから、Run の ID を求める。再開なら、再開の判断の Run の ID。新しい Run なら、Run のディレクトリの
 * 名前が Run の ID の形で、出力先の中のその Run のディレクトリ（`runArtifactDirectory`）と同じときの、その名前。どちらでもなければ `null`。
 */
function startedRunId(outputDirectory: string, runDirectory: string, decision: AuditRunResumeDecision): RunId | null {
  if (decision.kind !== 'NEW_RUN') {
    return decision.runDirectory === runDirectory ? decision.runId : null;
  }
  const name = basename(runDirectory);
  return isRunId(name) && runArtifactDirectory(outputDirectory, name) === runDirectory ? name : null;
}

/**
 * 監査を実行し、型つきの結果を返す（段の順は、ファイルの先頭の説明）。Run の外の失敗（出力の書き出しの `ArtifactWriteError`、予期しない例外）は、
 * 保存の終わり方に従ってから、そのまま reject する（呼び出し側が `classifyCliFailure` で終了コードにする）。
 */
export async function executeAuditRun(
  config: AuditConfig,
  dependencies: AuditRunDependencies = PRODUCTION_RUN_DEPENDENCIES,
  options: AuditRunOptions = DEFAULT_AUDIT_RUN_OPTIONS,
  observer: AuditRunObserver = {},
): Promise<AuditRunOutcome> {
  const outputDirectory = resolve(config.output.directory);
  const writer = writerFor(dependencies);
  const nowMs = dependencies.now();

  // 0. 出力先の開始のロック（DEF-057）。別の起動が開始の段にいれば、Run を始めない（実行中の Run がある場合と同じ扱い。その Run の ID が
  // 分かれば、それを返す）。
  const startLock = await holdOutputStartLock(writer, outputDirectory, nowMs);
  if (startLock.kind === 'HELD_BY_ANOTHER_START') {
    return {
      kind: 'RUN_ACTIVE',
      activeRunId: await findActiveRunInOutputDirectory(writer, outputDirectory, nowMs),
      exitCode: RUN_UNAVAILABLE_EXIT_CODE,
    };
  }
  const releaseStartLock = startLock.kind === 'ACQUIRED' ? startLock.release : releaseNothing;
  try {
    return await startAndRunAudit({ config, dependencies, options, observer, outputDirectory, writer, nowMs, releaseStartLock });
  } finally {
    // 例外の経路と、Run のロックを作る前に終わった経路でも、必ず離す（保存のセッションが始まった後なら、すでに離している）。
    await releaseStartLock();
  }
}

/**
 * 開始のロックを持ったまま、開始の段（実行中の Run の確かめ → 再開する Run の選択 → Run のディレクトリとロックの作成）を行い、Run を実行する
 * （`executeAuditRun` の 1〜5。ファイルの先頭の説明）。開始のロックは、保存のセッションの始め方（Run のロックの作成）の後に離す
 * （`releaseStartLock`）。
 */
async function startAndRunAudit(input: {
  readonly config: AuditConfig;
  readonly dependencies: AuditRunDependencies;
  readonly options: AuditRunOptions;
  readonly observer: AuditRunObserver;
  readonly outputDirectory: string;
  readonly writer: ArtifactWriter;
  readonly nowMs: number;
  readonly releaseStartLock: () => Promise<void>;
}): Promise<AuditRunOutcome> {
  const { config, dependencies, options, observer, outputDirectory, writer, nowMs, releaseStartLock } = input;

  // 1. 出力先の実行中の Run（設計書 4.7.1）。
  const activeRunId = await findActiveRunInOutputDirectory(writer, outputDirectory, nowMs);
  if (activeRunId !== null) {
    return { kind: 'RUN_ACTIVE', activeRunId, exitCode: RUN_UNAVAILABLE_EXIT_CODE };
  }

  // 2. 途中の Run を選ぶ（`startNew` のときは探さない）。
  // T25d: 認証つきの Run は、Run Coordinator が保存する有効な設定（`authenticatedRunConfig`）と同じ形で比べる。
  const resumeComparisonConfig = dependencies.authentication === undefined ? config : authenticatedRunConfig(config);
  // T25g-2: Run の種類（認証つきかどうかと、認証の設定を区別する値）も比べる（認証つきの Run と公開監査の Run は、互いに再開しない）。
  const resumeComparisonKind = dependencies.authentication === undefined
    ? null
    : runCheckpointAuthenticationOf(dependencies.authentication);
  const choice: RunResumeChoice = options.startNew
    ? NEW_RUN_CHOICE
    : await chooseRunToResume(writer, outputDirectory, resumeComparisonConfig, resumeComparisonKind);
  if (choice.kind === 'VERSION_DIFFERS') {
    return {
      kind: 'VERSION_MISMATCH',
      runId: choice.runId,
      runDirectory: choice.runDirectory,
      differences: choice.differences,
      exitCode: RUN_UNAVAILABLE_EXIT_CODE,
    };
  }
  const { resumeDecision, notices } = choice;
  notifyObserver(observer.onRunStarting, { resumeDecision, notices });

  // 3. 保存のセッションと Run Coordinator。
  const session = new StartNotifyingRunCheckpointSession({ store: writer, now: dependencies.now }, (runDirectory) => {
    const runId = startedRunId(outputDirectory, runDirectory, resumeDecision);
    if (runId !== null) {
      notifyObserver(observer.onRunStarted, { runId, runDirectory, resumeDecision });
    }
  }, releaseStartLock);
  const resumeFrom = choice.kind === 'RESUME' ? choice.resumeFrom : undefined;
  const createRunCoordinator = dependencies.createRunCoordinator
    ?? ((coordinatorDependencies: RunCoordinatorDependencies) => new RunCoordinator(coordinatorDependencies));
  const coordinator = createRunCoordinator({
    config,
    launchBrowser: dependencies.launchBrowser,
    createSafetyLedger: () => new SafetyLedger(),
    clock: dependencies.clock,
    now: dependencies.now,
    outputDirectory,
    // 進み具合と知らせは、観測の口に渡す（Run Coordinator も、受け手の例外を握りつぶす）。
    onProgress: (report) => notifyObserver(observer.onProgress, report),
    onNotice: (notice) => notifyObserver(observer.onNotice, notice),
    checkpointSession: session,
    ...(resumeFrom === undefined ? {} : { resumeFrom }),
    ...(dependencies.stopSignal === undefined ? {} : { stopSignal: dependencies.stopSignal }),
    ...(dependencies.authentication === undefined ? {} : { authentication: dependencies.authentication }),
    ...(dependencies.navigationPacer === undefined ? {} : { navigationPacer: dependencies.navigationPacer }),
    // サイトの不調で止めたときの診断の記録（サイトの不調で止めたときの診断の記録の設計書 2.3）。Run Coordinator が渡す Run のディレクトリに、
    // `ArtifactWriter` が書く（ARCH08。試行の番号は、ファイルの名前に使う）。失敗は Run Coordinator が握りつぶす。
    writeSiteUnavailableDiagnostic: async (runDirectory, record, attemptNumber) => {
      await writer.writeSiteUnavailableDiagnostic(runDirectory, record, attemptNumber);
    },
  });

  // 4. Run の後。
  let result: AuditRunResult;
  try {
    result = await coordinator.run();
  } catch (error) {
    if (error instanceof RunDirectoryUnavailableError) {
      const { runId, runStatus } = error.result.run;
      return {
        kind: 'RUN_DIRECTORY_UNAVAILABLE',
        runId,
        runDirectory: error.runDirectory,
        runStatus,
        alreadyExists: error.alreadyExists,
        cause: error.cause,
        exitCode: exitCodeForRunStatus(runStatus),
        resumeDecision,
        notices,
      };
    }
    if (error instanceof RunResumeUnavailableError) {
      return {
        kind: 'RESUME_UNAVAILABLE',
        runId: error.runId,
        runDirectory: error.runDirectory,
        reason: error.reason,
        cause: error.cause,
        exitCode: RUN_UNAVAILABLE_EXIT_CODE,
        resumeDecision,
        notices,
      };
    }
    if (coordinator.checkpointConclusion().action === 'ABANDON') {
      await session.abandon();
    }
    throw error;
  }
  const conclusion = coordinator.checkpointConclusion();
  let outputs: AuditRunOutputs;
  try {
    outputs = await writeAuditRunOutputs(result, outputDirectory, writer);
  } catch (error) {
    await concludeCheckpointAfterOutputFailure(conclusion, session);
    throw error;
  }
  const checkpointRunDirectory = resumeFrom?.runDirectory ?? runArtifactDirectory(outputDirectory, result.run.runId);
  const checkpointWarnings = await concludeCheckpoint({ conclusion, session, writer, runDirectory: checkpointRunDirectory });
  return {
    kind: 'RAN',
    runId: outputs.runId,
    runDirectory: outputs.runDirectory,
    runStatus: outputs.runStatus,
    exitCode: outputs.exitCode,
    resumeDecision,
    notices,
    summary: outputs.summary,
    checkpointWarnings,
  };
}

/**
 * 途中の Run の選び方の結果。
 * - `NEW_RUN`: 新しい Run を始める。`notices` は、開始の前の知らせ（設定が違う、壊れた保存）。
 * - `RESUME`: `resumeFrom` で再開する（再開の判断は `RESUME` か `FINALIZE_ONLY`）。`notices` は、ほかの知らせ。
 * - `VERSION_DIFFERS`: 版が違うので、Run を始めずに終える。
 */
type RunResumeChoice =
  | {
    readonly kind: 'NEW_RUN';
    readonly resumeDecision: AuditRunResumeDecision;
    readonly notices: readonly AuditRunStartNotice[];
  }
  | {
    readonly kind: 'RESUME';
    readonly resumeFrom: RunCoordinatorResumeInput;
    readonly resumeDecision: AuditRunResumeDecision;
    readonly notices: readonly AuditRunStartNotice[];
  }
  | {
    readonly kind: 'VERSION_DIFFERS';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly differences: readonly RunVersionDifference[];
  };

const NEW_RUN_DECISION: AuditRunResumeDecision = Object.freeze({ kind: 'NEW_RUN' });

const NEW_RUN_CHOICE: RunResumeChoice = Object.freeze({ kind: 'NEW_RUN', resumeDecision: NEW_RUN_DECISION, notices: Object.freeze([]) });

/**
 * 途中の Run を探して選ぶ（中断した Run の再開の設計書 4.7.1 の「途中の Run を探す読み方」「選び方」「版の確かめ」）。
 * 1. 保存のある Run のディレクトリ（`listCheckpointRunDirectories`）の `state.json`（使えなければ `state.prev.json`）だけを読む
 *    （`readCheckpointState`）。読めなかった Run は、壊れた保存として知らせる。
 * 2. 読めた Run から、`selectRunToResume` で選ぶ。設定が違えば知らせて、新しい Run を始める。
 * 3. 再開するなら、今の BeakSight と Playwright の版を、`runVersionDifferences` で保存の版と比べる。違えば `VERSION_DIFFERS`。
 * 4. 版が同じなら、ページの保存まで読む（`readCheckpoint`）。読めなければ、壊れた保存として知らせ、新しい Run を始める。読めた保存の
 *    `decideRunResumption` が `NOT_RESUMABLE` なら（`state.prev.json` に戻った場合などに起こりうる）、知らせずに新しい Run を始める。
 * 5. 再開するなら、`RESUME` なら監査を終えたページの数を添えて、`FINALIZE_ONLY` なら最後の処理だけを行うと、再開の判断に入れる。
 */
async function chooseRunToResume(
  writer: ArtifactWriter,
  outputDirectory: string,
  config: AuditConfig,
  currentKind: RunCheckpointAuthentication | null,
): Promise<RunResumeChoice> {
  const notices: AuditRunStartNotice[] = [];
  const readable: RunResumeCandidate[] = [];
  for (const { runId, runDirectory } of await listCheckpointRunDirectories(outputDirectory)) {
    const read = await writer.readCheckpointState(runDirectory, checkRunCheckpointConsistency);
    if (read.ok) {
      readable.push({ runId, runDirectory, checkpoint: read.state });
    } else {
      notices.push({ kind: 'CHECKPOINT_UNREADABLE', runId });
    }
  }
  const selection = selectRunToResume(readable, config, currentKind);
  if (selection.kind === 'START_NEW') {
    return { kind: 'NEW_RUN', resumeDecision: NEW_RUN_DECISION, notices };
  }
  const { candidate } = selection;
  if (selection.kind === 'CONFIG_DIFFERS') {
    return {
      kind: 'NEW_RUN',
      resumeDecision: NEW_RUN_DECISION,
      notices: [...notices, { kind: 'CONFIG_DIFFERS', runId: candidate.runId, differences: selection.differences }],
    };
  }
  const versionDifferences = runVersionDifferences(candidate.checkpoint, {
    toolVersion: await readToolVersion(),
    playwrightVersion: readPlaywrightVersion(),
  });
  if (versionDifferences.length > 0) {
    return { kind: 'VERSION_DIFFERS', runId: candidate.runId, runDirectory: candidate.runDirectory, differences: versionDifferences };
  }
  const full = await writer.readCheckpoint(candidate.runDirectory, {
    checkState: checkRunCheckpointConsistency,
    checkPage: checkRunCheckpointPageConsistency,
  });
  if (!full.ok) {
    return {
      kind: 'NEW_RUN',
      resumeDecision: NEW_RUN_DECISION,
      notices: [...notices, { kind: 'CHECKPOINT_UNREADABLE', runId: candidate.runId }],
    };
  }
  const decision = decideRunResumption(full.state);
  if (decision === 'NOT_RESUMABLE') {
    return { kind: 'NEW_RUN', resumeDecision: NEW_RUN_DECISION, notices };
  }
  return {
    kind: 'RESUME',
    resumeFrom: { runDirectory: candidate.runDirectory, checkpoint: full.state, pages: full.pages },
    resumeDecision: decision === 'RESUME'
      ? { kind: 'RESUME', runId: candidate.runId, runDirectory: candidate.runDirectory, completedPages: full.state.completedPageIds.length }
      : { kind: 'FINALIZE_ONLY', runId: candidate.runId, runDirectory: candidate.runDirectory },
    notices,
  };
}

/**
 * 出力を書き終えた後に、保存の終わり方（Run Coordinator の `checkpointConclusion()`）に従う（中断した Run の再開の設計書 4.7.1 の「Run の後」）。
 * - `FINISH`: セッションの `finish` に最後の状態の保存を渡す。失敗したら、警告（`CHECKPOINT_FINISH_FAILED`）を加え、`abandon()` を呼ぶ。
 *   最後の状態が `FINISHED` で、`finish` が成功したら、`ArtifactWriter.removeFinishedCheckpointFiles` で、使わない保存を片付ける。失敗したら、
 *   警告（`CHECKPOINT_CLEANUP_FAILED`。消せなかったパス）を加える。
 * - `ABANDON`: `abandon()` を呼ぶ。
 * - `NONE`: 何もしない。
 * どれも、終了コードを変えない（Run Status のとおり）。警告を、起きた順に返す。
 */
async function concludeCheckpoint(input: {
  readonly conclusion: RunCoordinatorCheckpointConclusion;
  readonly session: RunCheckpointSession;
  readonly writer: ArtifactWriter;
  readonly runDirectory: string;
}): Promise<readonly AuditRunCheckpointWarning[]> {
  const { conclusion, session, writer, runDirectory } = input;
  if (conclusion.action === 'ABANDON') {
    await session.abandon();
    return [];
  }
  if (conclusion.action !== 'FINISH') {
    return [];
  }
  try {
    await session.finish(conclusion.checkpoint);
  } catch {
    await session.abandon();
    return [{ kind: 'CHECKPOINT_FINISH_FAILED' }];
  }
  if (conclusion.checkpoint.state !== 'FINISHED') {
    return [];
  }
  try {
    await writer.removeFinishedCheckpointFiles(runDirectory);
  } catch (error) {
    return [{ kind: 'CHECKPOINT_CLEANUP_FAILED', path: error instanceof ArtifactWriteError ? error.path : runDirectory }];
  }
  return [];
}

/**
 * 最後の出力の書き出し（`writeAuditRunOutputs`）に失敗したときに、保存の終わり方（Run Coordinator の `checkpointConclusion()`）に従う（中断した
 * Run の再開の設計書 4.7.1 の「Run の後」、4.10 の Important-1 の (b)）。呼び出し側は、この後に、出力の失敗を今のとおり返す。
 * - `FINISH` で `finishEvenIfOutputFails` が真: セッションの `finish` に最後の状態の保存を渡す（違反を検出した Run を、出力がなくても再開
 *   しない状態にする）。失敗したら、`abandon()` を呼ぶ。どちらの場合も、終わった Run の保存の片付け（`removeFinishedCheckpointFiles`）は
 *   しない（出力がないので、ページの保存を残す）。
 * - `FINISH` で偽と、`ABANDON`: `abandon()` を呼ぶ（出力をやり直せるよう、保存の状態を変えない）。
 * - `NONE`: 何もしない。
 * どれを行うかは、項目の値だけで決める（Run Status は見ない。真にするかは `decideRunCheckpointConclusion` が決める）。
 */
async function concludeCheckpointAfterOutputFailure(
  conclusion: RunCoordinatorCheckpointConclusion,
  session: RunCheckpointSession,
): Promise<void> {
  if (conclusion.action === 'NONE') {
    return;
  }
  if (conclusion.action === 'FINISH' && conclusion.finishEvenIfOutputFails) {
    try {
      await session.finish(conclusion.checkpoint);
      return;
    } catch {
      // 最後の状態を書けなかった場合も、出力の失敗を返す（下で `abandon()` を呼んで、セッションをやめる）。
    }
  }
  await session.abandon();
}

// ---------------------------------------------------------------------------------------------------------------
// 出力の書き出し
// ---------------------------------------------------------------------------------------------------------------

/**
 * 書き出し済みのファイルを、Run のディレクトリからの相対パスで読む関数を作る（設計書 6.1.9、U16d の報告）。
 * ファイルがない（`ENOENT`）場合は `null` を返し、ほかの入出力の失敗は、そのまま投げる。
 * 相対パスが安全でない場合は、読まずに `RangeError` を投げる（検証は `isPortableRelativeArtifactPath` の1か所。CC-027）。
 */
export const artifactFileReader = (runDirectory: string): ReadArtifactFile => async (relativePath) => {
  if (!isPortableRelativeArtifactPath(relativePath)) {
    throw new RangeError(`not a portable relative artifact path: ${JSON.stringify(relativePath)}`);
  }
  try {
    return await readFile(artifactFilePath(runDirectory, relativePath));
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

/** 確定した Run を書き出した結果（`writeAuditRunOutputs`）。 */
export interface AuditRunOutputs {
  readonly runId: RunId;
  /** 書き出した Run のディレクトリ。 */
  readonly runDirectory: string;
  /** 書き出した後の Run Status（スキーマに合わない場合は、導き直した後のもの）。 */
  readonly runStatus: RunStatus;
  /** 書き出した後の Run Status の終了コード。 */
  readonly exitCode: number;
  /** 表示用モデルの要約。 */
  readonly summary: RunSummaryView;
}

/**
 * 確定した Run（`AuditRunResult`）を書き出し、表示用モデルの要約と終了コードを返す（設計書 第7章、R17 の指摘2）。表示はしない。
 * Run Coordinator の実行とは分ける。書き出しの順（設計書 6.1.8）:
 * 1. `ArtifactWriter.writeRun`（スキーマに合わない場合は、ここで Run Status が導き直される）
 * 2. `buildReportViewModel(written.result)`
 * 3. `renderHtmlReport(viewModel)`
 * 4. `createChatGptBundle(viewModel, written.result, readArtifactFile)`
 * 5. `ArtifactWriter.writePresentation(written, { reportHtml, bundle: { bytes, lastExecutionFinishedAt } })`（バンドルの名前は、最後の
 *    実行の終わりの時刻から作る。結果の行と同じ、表示用モデルの `executions.lastFinishedAt` を使う。ChatGPT 用バンドルのファイル名の
 *    設計書 2.1）
 * 終了コードは、`writeRun` が返した最終の Run（導き直した後の Run Status）から、`exit-codes.ts` の表で決める。
 * 渡された `result` の Run Status（導き直しの前）は使わない。
 * `writer` は省略できる（既定は、公開監査の既定の書き手。`executeAuditRun` は、その Run の書き手を渡す。認証つきの Run では、URL の秘密を伏せる
 * 書き手なので、表示用モデル、HTML、バンドルも、伏せ字の後の最終の Run から作る。T25f）。
 */
export async function writeAuditRunOutputs(
  result: AuditRunResult,
  outputDirectory: string,
  writer: ArtifactWriter = new ArtifactWriter(),
): Promise<AuditRunOutputs> {
  const written = await writer.writeRun(result, { outputDirectory });
  const viewModel = buildReportViewModel(written.result);
  const reportHtml = renderHtmlReport(viewModel);
  const bundle = await createChatGptBundle(viewModel, written.result, artifactFileReader(written.runDirectory));
  await writer.writePresentation(written, {
    reportHtml,
    bundle: { bytes: bundle, lastExecutionFinishedAt: viewModel.summary.executions.lastFinishedAt },
  });
  const { runId, runStatus } = written.result.run;
  return { runId, runDirectory: written.runDirectory, runStatus, exitCode: exitCodeForRunStatus(runStatus), summary: viewModel.summary };
}

/**
 * artifact の書き出しの唯一の owner（ARCH08。Task 14〜17 の設計書 6.1.1、6.1.2）。
 * - 配置（Run のディレクトリ、ファイルの名前、Run のディレクトリからの相対パス）は、`src/core/artifact-layout.ts` から取る
 *   （設計書 6.1.8。CC-023）。このファイルは、配置の名前やパスを組み立てない。
 * - JSON は、メモリの上で組み立て、`validateArtifact` で検証してから書く。スキーマに合わない場合は、Run Status を
 *   `deriveRunStatus` で導き直す（ARCH05。このファイルは Run Status を決めない）。スキーマに合わない JSON も、隠さずに書く。
 * - パスに使う ID（`runId`、`pageId`）は、ID の形（`isRunId`、`isPageId`。ID の owner は `src/core/ids.ts`。C16d）と、
 *   安全な区切り1つかどうか（`isPortableArtifactPathSegment`。CC-027）の両方で確かめる。形の違う値は、何も書かずに `RangeError`。
 * - ファイルは、同じディレクトリの一時ファイルに書いてから rename する。テキストは UTF-8（BOM なし）で、改行は LF にする。
 *   JSON の書式は、`serializeArtifactJson`（`src/core/artifact-json.ts`）だけで組み立てる（CC-026）。
 *   rename は、すべて `renameWithRetry`（`src/core/rename-retry.ts`）を通し、一時的な失敗（`RENAME_RETRY_ERROR_CODES`）のときだけ、短く待ってやり直す（中断した Run の
 *   再開の設計書 4.10。RR の Minor-5）。
 * - 入出力の失敗は、`ArtifactWriteError` を投げる。
 * - HTML レポートと ChatGPT 用バンドルは、描画する側が作った中身を `writePresentation` で書く（書き出しの owner は、ここだけ）。
 * - サイトの不調で止めたときの診断の記録（`diagnostics/`）も、Run Coordinator が組み立てた値を `writeSiteUnavailableDiagnostic` で、
 *   スキーマで検証してから書く（サイトの不調で止めたときの診断の記録の設計書 2.3）。
 * - 発見のジョブの成果物（`discovery.json`。Task 27 の T27d）も、ワーカーが組み立てた値を `writeDiscovery` で、伏せ字を通してスキーマで
 *   検証してから書く。
 * - 中断した Run の再開のための保存（チェックポイント）の書き出しと読み込み（状態の保存だけの読み込みを含む）、ロックのファイルの作成・
 *   書き換え・削除、再開のときの後始末、終わった Run の使わない保存の片付けも、ここで行う（中断した Run の再開の設計書 4.1〜4.5、4.7.1。
 *   保存のファイルの読み書きを1か所にする）。
 *   - 保存とロックのファイルは、一時ファイルに書いて `fsync` で確定してから rename する。rename の後に、Windows 以外では
 *     ディレクトリも `fsync` する（設計書 4.3）。最後の artifact の書き出し（`writeRun`、`writePresentation`）には `fsync` を加えない。
 *   - 保存の中身の形は、スキーマ（`checkpoint`、`checkpoint-page`）で、書くときと読むときの両方で確かめる。保存の型
 *     （`RunCheckpoint` など）は `src/orchestration/run-checkpoint.ts` にあり、report は orchestration を import しない（UI Gate）ので、
 *     ここの関数は総称にし、知るのは core の型だけで書ける最小の形（`runId`、`completedPageIds`、`pageId`）だけにする。スキーマでは確かめられない
 *     整合の確かめ（R2 の `checkRunCheckpointConsistency` など）は、呼び出し側が読み込みの引数で渡す。
 *   - ロックの中身は、呼び出し側（`createRunLock`、`renewRunLock`）が作った値をそのまま書く。ロックの判定（`judgeRunLock`）はしない。
 * - 出力先の開始のロック（DEF-057。Task 24 の設計書 4.6。出力先の直下の `OUTPUT_START_LOCK_FILE_NAME`）の作成・書き換え・読み取り・削除も、
 *   Run のロックと同じ書き方で、ここで行う。
 * - 認証つきの Run の URL の伏せ字（Task 25 の設計書 4.6。T25f）: `urlSecretRedaction` を真にした書き手は、Run のディレクトリに書く値
 *   （`writeRun` の Run、保存のページと状態、診断の記録）のすべての文字列の URL に、伏せ字の owner の `redactUrlSecretsInValue`
 *   （`src/safety/redact.ts`）を、書く前に 1 か所（`#outgoing`）で通す。`writeRun` が返す最終の Run も伏せ字の後の値なので、そこから作る
 *   HTML レポートと ChatGPT 用バンドルにも、伏せ字の前の値は入らない。既定（偽。公開監査）では値を通さない（出力は変わらない）。
 */
import { link, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { evidenceOfType } from '../audit/rule-helpers.js';
import {
  CHECKPOINT_ARTIFACT_DIRECTORY,
  CHECKPOINT_PAGES_ARTIFACT_DIRECTORY,
  DISCOVERY_ARTIFACT_FILE_NAME,
  PAGES_ARTIFACT_DIRECTORY,
  READ_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_RUN_ARTIFACT_FILE_NAME,
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
  APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
  RUN_ARTIFACT_FILE_NAMES,
  actionBundleFileName,
  artifactFilePath,
  bundleFileName,
  checkpointArtifactRelativePath,
  checkpointPageArtifactRelativePath,
  checkpointPageIdOfFileName,
  isBundleFileName,
  isPortableArtifactPathSegment,
  isPreflightTemporaryFileName,
  outputStartLockPath,
  pageArtifactRelativePath,
  runArtifactDirectory,
  siteUnavailableDiagnosticRelativePath,
  type CheckpointArtifactFile,
} from '../core/artifact-layout.js';
import { serializeArtifactJson } from '../core/artifact-json.js';
import type {
  AuditRunResult,
  EvidenceId,
  IncompleteReason,
  PageAuditResult,
  PageId,
  RunId,
  RunRetryRecord,
  RunSummary,
  ViewportProfile,
} from '../core/contracts.js';
import { wait } from '../core/deadline.js';
import { errorCodeOf, safeErrorMessage } from '../core/errors.js';
import { isRecord } from '../core/guards.js';
import { isPageId, isRunId } from '../core/ids.js';
import { deepFreeze } from '../core/immutable.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../core/limits.js';
import { takeOverLockFile } from '../core/lock-file.js';
import { renameWithRetry } from '../core/rename-retry.js';
import type { RunLockTakeover } from '../core/process-lock.js';
import { validateArtifact, type ArtifactSchemaName, type ArtifactValidationResult } from '../core/schema-validator.js';
import { deriveRunStatus, requiredArtifactInvalidReason, type RunStatusInput } from '../core/status.js';
import { isTemporaryFileName, temporaryPathFor } from '../core/temporary-file-name.js';
import { compareCodeUnits } from '../core/text.js';
import { redactUrlSecretsInValue } from '../safety/redact.js';

/** audit.json の `schemaVersion`（`schemas/audit.schema.json`）。 */
export const AUDIT_ARTIFACT_SCHEMA_VERSION = 'audit-schema/1.0';

// ---------------------------------------------------------------------------------------------------------------
// 再試行の前の試行の Evidence と、可視テキスト
// ---------------------------------------------------------------------------------------------------------------

/**
 * ページの、再試行の前の試行の記録（`RunSummary.retries` のうち、URL がページの URL のもの。試行の順）。
 * 再試行したページの `evidence` には、再試行の前の試行の Evidence も入っている（設計書 5.6.4、第6章）。
 */
export const retryRecordsOf = (
  run: Pick<RunSummary, 'retries'>,
  page: Pick<PageAuditResult, 'pageUrl'>,
): readonly RunRetryRecord[] => run.retries.filter((retry) => retry.url === page.pageUrl);

/** ページの Evidence のうち、再試行の前の試行のものの ID（`retries[].evidenceIds` で区別する）。 */
export const earlierAttemptEvidenceIds = (
  run: Pick<RunSummary, 'retries'>,
  page: Pick<PageAuditResult, 'pageUrl'>,
): ReadonlySet<EvidenceId> => new Set(retryRecordsOf(run, page).flatMap((retry) => retry.evidenceIds));

/** 可視テキストを取るビューポートの順（設計書 6.1.2: Desktop にない場合は Mobile）。 */
const VISIBLE_TEXT_VIEWPORTS = Object.freeze(['desktop', 'mobile'] as const satisfies readonly ViewportProfile[]);

/**
 * `visible-text.txt` の中身（改行の正規化の前）。最終の試行の DOM の Evidence の可視テキストで、Desktop になければ Mobile から取る。
 * どちらにもない場合は `null`（ファイルを書かない）。
 */
export const visibleTextOf = (run: Pick<RunSummary, 'retries'>, page: PageAuditResult): string | null => {
  const earlier = earlierAttemptEvidenceIds(run, page);
  for (const viewport of VISIBLE_TEXT_VIEWPORTS) {
    const dom = evidenceOfType({ viewport, evidence: page.evidence }, 'dom').find((record) => !earlier.has(record.evidenceId));
    if (dom !== undefined) {
      return dom.payload.visibleText.text;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------------------------------------------
// 書き出しの型
// ---------------------------------------------------------------------------------------------------------------

export interface WriteRunOptions {
  /** 出力先の根のディレクトリ（`RunCoordinator` の `outputDirectory` と同じ）。Run のディレクトリは、この下の `<runId>`。 */
  readonly outputDirectory: string;
}

/** スキーマに合わなかった artifact。 */
export interface InvalidArtifact {
  /** Run のディレクトリからの相対パス（区切りは `/`）。 */
  readonly path: string;
  readonly schema: ArtifactSchemaName;
  /** `validateArtifact` の誤りの一覧。 */
  readonly errors: readonly string[];
}

/** `writeRun` の結果。 */
export interface ArtifactWriteResult {
  /**
   * 最終の Run。スキーマに合わない artifact があった場合は、`statusInput.requiredArtifactsValid` を偽にし、Run Status を
   * `deriveRunStatus` で導き直し、Run の理由に `REQUIRED_ARTIFACT_INVALID` を加えたもの。表示用モデルは、これから組み立てる。
   */
  readonly result: AuditRunResult;
  /** Run のディレクトリ（`runArtifactDirectory(outputDirectory, runId)`）。 */
  readonly runDirectory: string;
  /** 書いたファイルの、Run のディレクトリからの相対パス（書いた順。区切りは `/`）。 */
  readonly files: readonly string[];
  /** 書いたすべての JSON が、スキーマに合ったか。 */
  readonly schemaValid: boolean;
  /** 書いた JSON のうち、スキーマに合わなかったもの（ページの順、run.json、audit.json の順）。 */
  readonly invalidArtifacts: readonly InvalidArtifact[];
}

/** `writePresentation` で書く、表示用モデルから作ったファイル（U16c の HTML レポート、U16d の ChatGPT 用バンドル）。 */
export interface RunPresentationFiles {
  /** `report.html` の中身。改行は LF にして、UTF-8 で書く。 */
  readonly reportHtml?: string;
  /** ChatGPT 用バンドル（`beaksight-audit-bundle_YYYYMMDDHHmmss.zip`。ChatGPT 用バンドルのファイル名の設計書 2.1、2.2）。 */
  readonly bundle?: RunPresentationBundle;
}

/** `writePresentation` で書く ChatGPT 用バンドルの、中身と、名前を決める時刻。 */
export interface RunPresentationBundle {
  /** ZIP の中身（バイト列のまま書く）。 */
  readonly bytes: Uint8Array;
  /**
   * その Run の最後の実行の終わりの時刻（`RunExecution.finishedAt`。ISO 8601）。名前は、これから `bundleFileName`
   * （`src/core/artifact-layout.ts`）で作る。
   */
  readonly lastExecutionFinishedAt: string;
}

/** artifact の入出力の失敗。`path` は、書けなかったファイルかディレクトリ。 */
export class ArtifactWriteError extends Error {
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`failed to write the artifact ${path}: ${safeErrorMessage(cause, MAX_ERROR_MESSAGE_LENGTH)}`, { cause });
    this.name = 'ArtifactWriteError';
    this.path = path;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 再開のための保存（チェックポイント）とロックの型（中断した Run の再開の設計書 4.1〜4.4）
// ---------------------------------------------------------------------------------------------------------------

/**
 * `state.json` の値のうち、ArtifactWriter が知る最小の形（Run の ID と終わったページの ID。Run の ID は、Run のディレクトリの名前と同じことを
 * 読むときに確かめ、終わったページの ID は、ページの保存を探すのに使う）。
 * 値の全体の形は `schemas/checkpoint.schema.json` が決め、その型は `src/orchestration/run-checkpoint.ts` の `RunCheckpoint`。
 */
export interface CheckpointStateShape {
  readonly runId: RunId;
  readonly completedPageIds: readonly PageId[];
}

/**
 * ページの保存（`checkpoint/pages/<pageId>.json`）の値のうち、ArtifactWriter が知る最小の形（保存の名前に使うページの ID）。
 * 値の全体の形は `schemas/checkpoint-page.schema.json` が決め、その型は `run-checkpoint.ts` の `RunCheckpointPage`。
 */
export interface CheckpointPageShape {
  readonly pageId: PageId;
}

/**
 * サイトの不調で止めたときの診断の記録の値のうち、ArtifactWriter が知る最小の形（ファイルの名前に使う、ページの ID と実行の番号。サイトの
 * 不調で止めたときの診断の記録の設計書 2.3）。値の全体の形は `schemas/site-unavailable-diagnostic.schema.json` が決め、その型は
 * `src/orchestration/run-coordinator.ts` の `SiteUnavailableDiagnosticRecord`（report は orchestration を import しないので、総称で受ける）。
 */
export interface SiteUnavailableDiagnosticShape {
  readonly pageId: PageId;
  readonly executionNumber: number;
}

/**
 * 保存の読み込みで使う、スキーマでは確かめられない整合の確かめ（呼び出し側が渡す。Run Coordinator は R2 の
 * `checkRunCheckpointConsistency` と `checkRunCheckpointPageConsistency` を渡す）。型の引数は、この関数の型から推論される。
 */
export interface CheckpointConsistencyChecks<TState extends CheckpointStateShape, TPage extends CheckpointPageShape> {
  readonly checkState: (state: TState) => ArtifactValidationResult;
  readonly checkPage: (page: TPage, state: TState) => ArtifactValidationResult;
}

/**
 * 保存の読み込みで確かめる、状態の保存のファイルの閉じた一覧（確かめる順）。
 * - `state`: `checkpoint/state.json`
 * - `prev`: `checkpoint/state.prev.json`（`state.json` が使えない場合に使う。設計書 4.3）
 */
export const CHECKPOINT_READ_SOURCES = Object.freeze(['state', 'prev'] as const);
export type CheckpointReadSource = (typeof CHECKPOINT_READ_SOURCES)[number];

const CHECKPOINT_READ_SOURCE_FILES = Object.freeze({
  state: 'state',
  prev: 'previousState',
} as const satisfies Record<CheckpointReadSource, CheckpointArtifactFile>);

/** 状態の保存のファイル（`source`）を使えなかった理由。 */
export interface CheckpointReadFailure {
  readonly source: CheckpointReadSource;
  /** 使えなかったファイル（状態の保存か、それに載ったページの保存）の、Run のディレクトリからの相対パス（区切りは `/`）。 */
  readonly path: string;
  /** 英語の技術的な詳細（URL を含めない。上限は `MAX_ERROR_MESSAGE_LENGTH`）。 */
  readonly reason: string;
}

/**
 * `readCheckpoint` の結果（深く凍結した値）。
 * - `ok` が真: `source` のファイルの保存を使えた。`pages` は、`state.completedPageIds` の順のページの保存。`failures` は、先に確かめて
 *   使えなかったファイルの理由（`state` を使えた場合は空。`prev` を使った場合は `state` の理由の1件）。
 * - `ok` が偽: どちらも使えなかった。`failures` は、`state`、`prev` の順の2件。
 */
export type CheckpointReadResult<TState, TPage> =
  | {
    readonly ok: true;
    readonly source: CheckpointReadSource;
    readonly state: TState;
    readonly pages: readonly TPage[];
    readonly failures: readonly CheckpointReadFailure[];
  }
  | { readonly ok: false; readonly failures: readonly CheckpointReadFailure[] };

/**
 * `readCheckpointState` の結果（深く凍結した値。中断した Run の再開の設計書 4.7.1）。`readCheckpoint` の結果から、ページの保存を除いた形。
 * - `ok` が真: `source` のファイルの状態の保存を使えた。`failures` は、先に確かめて使えなかったファイルの理由。
 * - `ok` が偽: どちらも使えなかった。`failures` は、`state`、`prev` の順の2件。
 */
export type CheckpointStateReadResult<TState> =
  | {
    readonly ok: true;
    readonly source: CheckpointReadSource;
    readonly state: TState;
    readonly failures: readonly CheckpointReadFailure[];
  }
  | { readonly ok: false; readonly failures: readonly CheckpointReadFailure[] };

/**
 * `acquireRunLock` の結果。
 * - `acquired` が真: この呼び出しで、ロックのファイルを新しく作った。
 * - `acquired` が偽: ロックのファイルがすでにあった。`existing` は、その中身を JSON として読んだ値（判定は `judgeRunLock`）。
 *   読めない、または JSON でない場合は `null`。
 */
export type RunLockAcquisition =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly existing: unknown };

/**
 * 古いロックの原子的な取り直し（`takeOverRunLock`・`takeOverOutputStartLock`。DEF-060）の結果。形と意味は `src/core/process-lock.ts` の
 * `RunLockTakeover`（`LOCK_TAKEOVER_OUTCOMES`。T24h-3 で移した）。
 */
export type LockTakeover = RunLockTakeover;

/**
 * `acquireOutputStartLock` の結果（DEF-057）。`acquireRunLock` の結果に、作れたときの `createdDirectory`（出力先を作るために作った、いちばん
 * 上のディレクトリ。出力先がすでにあれば `null`）を加えた形。
 */
export type OutputStartLockAcquisition =
  | { readonly acquired: true; readonly createdDirectory: string | null }
  | { readonly acquired: false; readonly existing: unknown };

/** 保存とロックの書き出しで使う、開いたファイル（`node:fs/promises` の `FileHandle` の一部）。 */
export interface CheckpointFileHandle {
  writeFile(data: string, options: { readonly encoding: 'utf8' }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * 保存とロックの書き出しで使うファイルの操作（`node:fs/promises` の一部。書き出しの順を確かめるテストのための差し替え口）。
 * `open` の `wx` は、ファイルを新しく作る場合だけ開く（すでにあれば `EEXIST`）。`r` は、ディレクトリを `fsync` のために開く。
 */
export interface CheckpointFileOperations {
  mkdir(path: string, options: { readonly recursive: true }): Promise<unknown>;
  open(path: string, flags: 'wx' | 'r'): Promise<CheckpointFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options: { readonly force: true }): Promise<void>;
}

const NODE_CHECKPOINT_FILE_OPERATIONS: CheckpointFileOperations = Object.freeze({ mkdir, open, rename, rm });
const CHECKPOINT_FILE_OPERATION_NAMES = Object.freeze(['mkdir', 'open', 'rename', 'rm'] as const);

/** `ArtifactWriter` の設定（どれも省略できる）。 */
export interface ArtifactWriterOptions {
  /**
   * 保存とロックの書き出しで使うファイルの操作。省略すると `node:fs/promises`。名前の変更（`rename`）は、最後の artifact の書き出しでも
   * 使う（名前の変更のやり直しを1か所にするため。`renameWithRetry`）。
   */
  readonly fileOperations?: CheckpointFileOperations;
  /** 実行している環境（`process.platform` の値）。省略すると `process.platform`。`win32` では、ディレクトリの `fsync` を行わない。 */
  readonly platform?: string;
  /** 名前の変更をやり直す前の待ち。省略すると `wait`（`src/core/deadline.ts`）。テストで、実際には待たずに確かめるための差し替え口。 */
  readonly wait?: typeof wait;
  /**
   * 認証つきの Run の URL の伏せ字（Task 25 の設計書 4.6。T25f）。真なら、Run のディレクトリに書く値の文字列の URL の秘密（userinfo と、
   * 秘密に見える query の値）を、書く前に伏せる（`redactUrlSecretsInValue`）。省略すると偽（公開監査。値を通さない）。真偽でなければ `TypeError`。
   */
  readonly urlSecretRedaction?: boolean;
}

// 名前の変更のやり直しの決まり（失敗のコード `RENAME_RETRY_ERROR_CODES`、回数 `RENAME_MAX_ATTEMPTS`、待ち `RENAME_RETRY_DELAY_MS`、
// `renameWithRetry`）は、資格情報のファイルと共用するため、`src/core/rename-retry.ts` に移した（CC-062。CCX-11）。

/**
 * 最後の状態が `FINISHED` の Run で消す、再開のための保存（Run のディレクトリからの相対パスと、その種類。消す順。中断した Run の再開の
 * 設計書 4.7.1）。
 */
const FINISHED_RUN_REMOVED_CHECKPOINT_FILES = Object.freeze([
  Object.freeze({ relativePath: CHECKPOINT_PAGES_ARTIFACT_DIRECTORY, kind: 'directory' }),
  Object.freeze({ relativePath: checkpointArtifactRelativePath('previousState'), kind: 'file' }),
] as const);

/** ディレクトリの `fsync` ができない環境（`process.platform` の値。設計書 4.3）。 */
const PLATFORM_WITHOUT_DIRECTORY_SYNC = 'win32';

// ---------------------------------------------------------------------------------------------------------------
// 書き出しの補助
// ---------------------------------------------------------------------------------------------------------------

/** 改行を LF にする（CRLF と CR を LF にする）。 */
const toLf = (text: string): string => text.replace(/\r\n?/gu, '\n');

// 書き出しの途中の一時ファイルの名前の決まり（`temporaryPathFor`、`isTemporaryFileName`）は、`src/core/temporary-file-name.ts` に移した
// （T24h-3。古いロックを動かす先の名前と共用するため）。

/** 名前の変更（`ArtifactWriter` の `#rename`。`renameWithRetry` を通したもの）。 */
type RenameFile = (oldPath: string, newPath: string) => Promise<void>;

/**
 * 同じディレクトリの一時ファイルに書いてから、rename する（`renameFile`。`renameWithRetry` を通したもの）。失敗した場合は、一時ファイルを
 * 消してから `ArtifactWriteError` を投げる。
 */
async function writeFileAtomically(path: string, data: string | Uint8Array, renameFile: RenameFile): Promise<void> {
  const temporaryPath = temporaryPathFor(path);
  try {
    await mkdir(dirname(path), { recursive: true });
    if (typeof data === 'string') {
      await writeFile(temporaryPath, data, { encoding: 'utf8' });
    } else {
      await writeFile(temporaryPath, data);
    }
    await renameFile(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new ArtifactWriteError(path, error);
  }
}

/** ファイルがあれば消す（なければ何もしない）。失敗した場合は `ArtifactWriteError` を投げる。 */
async function removeFileIfPresent(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (error) {
    throw new ArtifactWriteError(path, error);
  }
}

// 入出力の例外の `code`（`ENOENT` など）の取り出し（`errorCodeOf`）は、`src/core/errors.ts` に移した（CC-062。CCX-11）。

/** 保存とロックの関数の引数の Run のディレクトリが、空でない文字列か。 */
function assertRunDirectory(runDirectory: unknown, method: string): asserts runDirectory is string {
  if (typeof runDirectory !== 'string' || runDirectory.length === 0) {
    throw new TypeError(`ArtifactWriter.${method} requires a non-empty run directory`);
  }
}

/** 出力先が空でない文字列か（開始のロックの読み書きの引数。DEF-057）。 */
function assertOutputDirectory(outputDirectory: unknown, method: string): asserts outputDirectory is string {
  if (typeof outputDirectory !== 'string' || outputDirectory.length === 0) {
    throw new TypeError(`ArtifactWriter.${method} requires a non-empty output directory`);
  }
}

/** パスに使うページの ID の形（`isPageId`）と、安全なパスの区切りかどうか（`isPortableArtifactPathSegment`）を確かめる。 */
function assertPathPageId(pageId: unknown): asserts pageId is PageId {
  if (!isPageId(pageId) || !isPortableArtifactPathSegment(pageId)) {
    throw new RangeError(`page ID does not have the shape of a page ID: ${JSON.stringify(pageId)}`);
  }
}

/** スキーマと伏せ字を通した文書 1 つ（書くのと同じ文字列と、その値。`prepareActionReport` の結果。T32f）。 */
export interface PreparedJobDocument<TValue> {
  readonly text: string;
  readonly value: TValue;
}

/** ジョブの成果物（Run のディレクトリの直下の JSON。`#writeJobDocument` が書く）のスキーマの名前。T32e: 書き込みの報告の 2 つを足した。 */
type JobDocumentSchemaName = Extract<ArtifactSchemaName, 'discovery' | 'read-evidence' | 'action-run' | 'action-evidence' | 'approval-summary'>;

/**
 * 保存の値（と、サイトの不調で止めたときの診断の記録）を、artifact の JSON の書式（`serializeArtifactJson`）の文字列にする。書く文字列を
 * JSON として読み戻した値を、スキーマ（`schema`）で検証し、合わなければ何も書かずに `ArtifactWriteError` を投げる（読み戻した値で
 * 確かめるので、書いたものは読むときにも同じ検証を通る）。
 */
async function checkpointJson(
  schema: 'checkpoint' | 'checkpoint-page' | 'site-unavailable-diagnostic' | JobDocumentSchemaName,
  path: string,
  value: unknown,
): Promise<string> {
  let data: string;
  let written: unknown;
  try {
    data = serializeArtifactJson(value);
    written = JSON.parse(data);
  } catch (error) {
    throw new ArtifactWriteError(path, error);
  }
  const validation = await validateArtifact(schema, written);
  if (!validation.ok) {
    throw new ArtifactWriteError(path, new Error(`the value does not match the schema ${schema}: ${validation.errors.join('; ')}`));
  }
  return data;
}

/** ロックの中身を、artifact の JSON の書式の文字列にする。オブジェクトでない、または JSON にできない値は、`TypeError` を投げる。 */
function runLockJson(lock: object): string {
  if (!isRecord(lock)) {
    throw new TypeError('run lock must be an object');
  }
  try {
    return serializeArtifactJson(lock);
  } catch (error) {
    throw new TypeError(`run lock cannot be written as JSON: ${safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH)}`);
  }
}

/** 開いたファイルに書いて `fsync` し、閉じる。失敗した場合も閉じてから、その例外を投げる。 */
async function writeAndSync(handle: CheckpointFileHandle, data: string): Promise<void> {
  try {
    await handle.writeFile(data, { encoding: 'utf8' });
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  await handle.close();
}

/** `path` が、`directory` の中（`directory` そのものを除く）にあるか（どちらも絶対パス）。 */
const isInsideDirectory = (directory: string, path: string): boolean => {
  const fromDirectory = relative(directory, path);
  return fromDirectory.length > 0 && fromDirectory !== '..' && !fromDirectory.startsWith(`..${sep}`) && !isAbsolute(fromDirectory);
};

/** 保存を使えなかった理由を、上限（`MAX_ERROR_MESSAGE_LENGTH`）までの長さにする。 */
const boundedReason = (reason: string): string => safeErrorMessage(reason, MAX_ERROR_MESSAGE_LENGTH);

type CheckpointJsonReading = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string };

/**
 * Run のディレクトリからの相対パス（`relativePath`）の保存のファイルを読み、`JSON.parse`（`SyntaxError` を捕まえる）と、スキーマの
 * 検証を行う。例外を投げずに、使えない理由を返す（理由に、ファイルの中身や URL を含めない）。
 */
async function readCheckpointJson(
  runDirectory: string,
  relativePath: string,
  schema: 'checkpoint' | 'checkpoint-page',
): Promise<CheckpointJsonReading> {
  let text: string;
  try {
    text = await readFile(artifactFilePath(runDirectory, relativePath), 'utf8');
  } catch (error) {
    const code = errorCodeOf(error);
    return { ok: false, reason: code === 'ENOENT' ? 'does not exist' : `could not be read (${code ?? 'unknown error'})` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    // `SyntaxError` のメッセージは、ファイルの中身の一部を含むことがあるので、理由に入れない。
    return { ok: false, reason: 'is not valid JSON' };
  }
  const validation = await validateArtifact(schema, value);
  return validation.ok ? { ok: true, value } : { ok: false, reason: `does not match the schema ${schema}: ${validation.errors.join('; ')}` };
}

/** 整合の確かめの結果を、使えない理由（使える場合は `null`）にする。確かめの関数が例外を投げた場合も、理由にする。 */
function consistencyProblem(check: () => ArtifactValidationResult): string | null {
  try {
    const result = check();
    return result.ok ? null : `is not consistent: ${result.errors.join('; ')}`;
  } catch (error) {
    return `the consistency check failed: ${safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH)}`;
  }
}

/**
 * スキーマの検証を通った値を、呼び出し側の型として扱う（保存の値の型の主張は、ここ1か所だけ）。保存の形は
 * `schemas/checkpoint.schema.json` と `schemas/checkpoint-page.schema.json` が保証し、その形の型（`RunCheckpoint`、`RunCheckpointPage`）は、
 * 呼び出し側が整合の確かめの関数の型で示す。ArtifactWriter は、その型のある orchestration を import できない（UI Gate）ので、
 * 型の引数のまま受け取る。
 */
const asSchemaValidated = <T>(value: unknown): T => value as T;

/** 1つの状態の保存のファイル（`source`）の読み取りの結果（使えた値か、最初に使えなかったファイルと、その理由）。 */
type CheckpointSourceReading<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: CheckpointReadFailure };

/** 使えなかったファイル（`path`）と、その理由（上限までの長さにする）の結果。 */
const sourceFailure = (source: CheckpointReadSource, path: string, reason: string): { readonly ok: false; readonly failure: CheckpointReadFailure } => ({
  ok: false,
  failure: { source, path, reason: boundedReason(reason) },
});

/**
 * 状態の保存の Run の ID（`runId`）が、Run のディレクトリの名前と違う場合の、使えない理由（同じなら `null`。中断した Run の再開の
 * 設計書 4.2）。違う保存から再開すると、出力は `<出力先>/<runId>` に、保存は読んだ Run のディレクトリに書かれ、別のディレクトリに
 * 分かれるため、その保存は使えないものとする。
 */
const runDirectoryNameProblem = (runDirectory: string, runId: RunId): string | null => {
  const directoryName = basename(runDirectory);
  return runId === directoryName ? null : `/runId (${runId}) differs from the name of the run directory (${directoryName})`;
};

/**
 * 状態の保存の1つのファイル（`source`）を、読んで確かめる（設計書 4.2、4.3、4.7.1）。読む → `JSON.parse` → スキーマ（`checkpoint`）→
 * Run の ID が Run のディレクトリの名前と同じ → `checkState`。使えなければ、そのファイルと理由を返す。ページの保存は読まない
 * （`readCheckpoint` と `readCheckpointState` の共通の部分。Run の ID の確かめは、ここだけで行う）。
 */
async function readCheckpointStateSource<TState extends CheckpointStateShape>(
  runDirectory: string,
  source: CheckpointReadSource,
  checkState: (state: TState) => ArtifactValidationResult,
): Promise<CheckpointSourceReading<TState>> {
  const statePath = checkpointArtifactRelativePath(CHECKPOINT_READ_SOURCE_FILES[source]);
  const stateReading = await readCheckpointJson(runDirectory, statePath, 'checkpoint');
  if (!stateReading.ok) {
    return sourceFailure(source, statePath, stateReading.reason);
  }
  const state = asSchemaValidated<TState>(stateReading.value);
  const runIdProblem = runDirectoryNameProblem(runDirectory, state.runId);
  if (runIdProblem !== null) {
    return sourceFailure(source, statePath, runIdProblem);
  }
  const stateProblem = consistencyProblem(() => checkState(state));
  return stateProblem === null ? { ok: true, value: state } : sourceFailure(source, statePath, stateProblem);
}

/**
 * 状態の保存の1つのファイル（`source`）と、それに載ったページの保存を、読んで確かめる（設計書 4.2、4.3）。
 * 状態の保存: `readCheckpointStateSource`（読む → `JSON.parse` → スキーマ（`checkpoint`）→ Run の ID とディレクトリの名前 →
 * `checks.checkState`）。
 * ページの保存（`completedPageIds` の順）: 読む → `JSON.parse` → スキーマ（`checkpoint-page`）→ 保存の名前とページの ID が同じ →
 * `checks.checkPage`。最初に使えなかったファイルと、その理由を返す。
 */
async function readCheckpointSource<TState extends CheckpointStateShape, TPage extends CheckpointPageShape>(
  runDirectory: string,
  source: CheckpointReadSource,
  checks: CheckpointConsistencyChecks<TState, TPage>,
): Promise<CheckpointSourceReading<{ readonly state: TState; readonly pages: readonly TPage[] }>> {
  const fail = (path: string, reason: string) => sourceFailure(source, path, reason);
  const stateReading = await readCheckpointStateSource(runDirectory, source, checks.checkState);
  if (!stateReading.ok) {
    return stateReading;
  }
  const state = stateReading.value;
  const statePath = checkpointArtifactRelativePath(CHECKPOINT_READ_SOURCE_FILES[source]);
  const pages: TPage[] = [];
  for (const pageId of state.completedPageIds) {
    // スキーマが、ページの ID の形を保証する。パスに使う前に、もう一度確かめる（二重の守り）。
    if (!isPageId(pageId) || !isPortableArtifactPathSegment(pageId)) {
      return fail(statePath, 'lists a completed page ID that cannot be a file name');
    }
    const pagePath = checkpointPageArtifactRelativePath(pageId);
    const pageReading = await readCheckpointJson(runDirectory, pagePath, 'checkpoint-page');
    if (!pageReading.ok) {
      return fail(pagePath, pageReading.reason);
    }
    const page = asSchemaValidated<TPage>(pageReading.value);
    if (page.pageId !== pageId) {
      return fail(pagePath, `holds the page ID ${page.pageId} instead of ${pageId}`);
    }
    const pageProblem = consistencyProblem(() => checks.checkPage(page, state));
    if (pageProblem !== null) {
      return fail(pagePath, pageProblem);
    }
    pages.push(page);
  }
  return { ok: true, value: { state, pages } };
}

/**
 * 状態の保存のファイルを、`CHECKPOINT_READ_SOURCES` の順（`state.json`、`state.prev.json`）に `read` で読み、最初に使えたものの値と、
 * 先に使えなかったファイルの理由を返す（設計書 4.3）。どちらも使えなければ、2件の理由を返す（`readCheckpoint` と `readCheckpointState`
 * の共通の部分）。
 */
async function readFirstUsableCheckpointSource<T>(
  read: (source: CheckpointReadSource) => Promise<CheckpointSourceReading<T>>,
): Promise<
  | { readonly ok: true; readonly source: CheckpointReadSource; readonly value: T; readonly failures: readonly CheckpointReadFailure[] }
  | { readonly ok: false; readonly failures: readonly CheckpointReadFailure[] }
> {
  const failures: CheckpointReadFailure[] = [];
  for (const source of CHECKPOINT_READ_SOURCES) {
    const reading = await read(source);
    if (reading.ok) {
      return { ok: true, source, value: reading.value, failures };
    }
    failures.push(reading.failure);
  }
  return { ok: false, failures };
}

/** `reasons` に、まだない理由（コードと detail が同じものがない理由）を加えた新しい配列。 */
const withReasons = (reasons: readonly IncompleteReason[], added: readonly IncompleteReason[]): readonly IncompleteReason[] => {
  const merged = [...reasons];
  for (const reason of added) {
    if (!merged.some(({ code, detail }) => code === reason.code && detail === reason.detail)) {
      merged.push(reason);
    }
  }
  return merged;
};

interface CheckedArtifact {
  readonly invalid: InvalidArtifact | null;
  readonly reason: IncompleteReason | null;
}

async function checkArtifact(schema: ArtifactSchemaName, path: string, id: string, value: unknown): Promise<CheckedArtifact> {
  const validation = await validateArtifact(schema, value);
  if (validation.ok) {
    return { invalid: null, reason: null };
  }
  return {
    invalid: { path, schema, errors: [...validation.errors] },
    reason: requiredArtifactInvalidReason(schema, id, validation.errors),
  };
}

/** audit.json の中身（`statusInput` は含めない）。 */
const auditArtifact = (result: AuditRunResult): object => ({
  schemaVersion: AUDIT_ARTIFACT_SCHEMA_VERSION,
  run: result.run,
  pages: result.pages,
  findings: result.findings,
});

function assertWritableRun(result: AuditRunResult, options: WriteRunOptions): void {
  if (
    !isRecord(result)
    || !isRecord(result.run)
    || !Array.isArray(result.pages)
    || !Array.isArray(result.findings)
    || !isRecord(result.statusInput)
  ) {
    throw new TypeError('ArtifactWriter.writeRun requires a confirmed Run with its Run Status input');
  }
  if (!isRecord(options) || typeof options.outputDirectory !== 'string' || options.outputDirectory.length === 0) {
    throw new TypeError('ArtifactWriter.writeRun requires a non-empty output directory');
  }
  // ID の形（`isRunId`、`isPageId`）で確かめ、安全なパスの区切りかどうかも確かめる（二重の守り。C16d）。
  const runId: unknown = result.run.runId;
  if (!isRunId(runId) || !isPortableArtifactPathSegment(runId)) {
    throw new RangeError(`run ID does not have the shape of a run ID: ${JSON.stringify(runId)}`);
  }
  const pageIds = new Set<string>();
  for (const page of result.pages) {
    const pageId: unknown = isRecord(page) ? page.pageId : undefined;
    if (!isPageId(pageId) || !isPortableArtifactPathSegment(pageId)) {
      throw new RangeError(`page ID does not have the shape of a page ID: ${JSON.stringify(pageId)}`);
    }
    if (pageIds.has(pageId)) {
      throw new RangeError(`page ID is used by more than one page: ${pageId}`);
    }
    pageIds.add(pageId);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------------------------------------------

/** artifact の書き出しの唯一の owner（ARCH08）。 */
export class ArtifactWriter {
  readonly #fileOperations: CheckpointFileOperations;
  readonly #platform: string;
  readonly #wait: typeof wait;
  /** 認証つきの Run の URL の伏せ字（`ArtifactWriterOptions.urlSecretRedaction`）。 */
  readonly #urlSecretRedaction: boolean;
  /**
   * この ArtifactWriter の名前の変更（差し替えたファイルの操作の `rename` を、待ち `#wait` で `renameWithRetry` に通したもの）。最後の
   * artifact の書き出し、保存とロックの書き出し、`state.json` から `state.prev.json` への移し替えは、すべてこれを使う。
   */
  readonly #rename: RenameFile = async (oldPath, newPath) =>
    renameWithRetry((from, to) => this.#fileOperations.rename(from, to), this.#wait, oldPath, newPath);

  /**
   * `options` は省略できる（保存とロックの書き出しのファイルの操作、実行している環境、名前の変更をやり直す前の待ち。テスト用の差し替え口）。
   * 最後の artifact の書き出し（`writeRun`、`writePresentation`）は、差し替えたファイルの操作のうち、名前の変更（`rename`）だけを使う
   * （名前の変更のやり直しを、保存と同じ1か所にするため。`renameWithRetry`）。ただし、`writePresentation` が古い ChatGPT 用バンドルを
   * 消すときは、差し替えたファイルの操作の `rm` を使う（ロックのファイルを消すときと同じ。消せなかった場合を確かめるテストのため）。
   * 不正な設定は `TypeError` を投げる。
   */
  constructor(options: ArtifactWriterOptions = {}) {
    // 型の絞り込みで `options` の型を変えないよう、`unknown` の値で確かめる。
    const given: unknown = options;
    if (!isRecord(given)) {
      throw new TypeError('ArtifactWriter options must be an object');
    }
    const {
      fileOperations = NODE_CHECKPOINT_FILE_OPERATIONS,
      platform = process.platform,
      wait: retryWait = wait,
      urlSecretRedaction = false,
    } = options;
    const operations: unknown = fileOperations;
    if (!isRecord(operations) || !CHECKPOINT_FILE_OPERATION_NAMES.every((name) => typeof operations[name] === 'function')) {
      throw new TypeError(`ArtifactWriter file operations must have ${CHECKPOINT_FILE_OPERATION_NAMES.join(', ')}`);
    }
    if (typeof platform !== 'string' || platform.length === 0) {
      throw new TypeError('ArtifactWriter platform must be a non-empty string');
    }
    if (typeof retryWait !== 'function') {
      throw new TypeError('ArtifactWriter wait must be a function');
    }
    if (typeof urlSecretRedaction !== 'boolean') {
      throw new TypeError('ArtifactWriter urlSecretRedaction must be a boolean');
    }
    this.#fileOperations = fileOperations;
    this.#platform = platform;
    this.#wait = retryWait;
    this.#urlSecretRedaction = urlSecretRedaction;
  }

  /**
   * Run のディレクトリに書く値（T25f）。`urlSecretRedaction` が真なら、伏せ字の owner の `redactUrlSecretsInValue` を通した写し、偽なら、
   * 値そのもの（公開監査。今のまま）。書き出しの関数は、値を受けたら最初にここを通す（伏せ字を通す場所を、この 1 か所にする）。
   */
  #outgoing<TValue>(value: TValue): TValue {
    return this.#urlSecretRedaction ? redactUrlSecretsInValue(value) : value;
  }

  /**
   * 確定した Run を、Run のディレクトリに書く（設計書 6.1.1、6.1.2）。
   *
   * 1. run.json、audit.json、各ページの page.json をメモリの上で組み立て、`validateArtifact` で検証する。
   * 2. どれかがスキーマに合わない場合は、`statusInput.requiredArtifactsValid` を偽にし、Run の理由に `REQUIRED_ARTIFACT_INVALID`
   *    を加えて、Run Status を `deriveRunStatus` で導き直す。導き直した Run で、run.json と audit.json を組み立て直す（1回だけ）。
   * 3. ページのファイル（page.json、visible-text.txt）、run.json、audit.json の順に、一時ファイルと rename で書く。
   *    スキーマに合わない JSON も書く。visible-text.txt を書かないページで、前の回（中断した Run の、途中で止めた回）の
   *    visible-text.txt が残っていれば消す（中断した Run の再開の設計書 4.5）。
   *
   * 入力は変えない（写しから組み立てる）。戻り値の `result` は深く凍結する。入出力の失敗は `ArtifactWriteError` を投げる。
   * Run Status の入力がない Run と、パスに使えない ID（`runId`、`pageId`）、重なった `pageId` は、書く前に例外を投げる。
   */
  async writeRun(result: AuditRunResult, options: WriteRunOptions): Promise<ArtifactWriteResult> {
    assertWritableRun(result, options);
    const source: AuditRunResult = this.#outgoing(structuredClone(result));
    const runDirectory = runArtifactDirectory(options.outputDirectory, source.run.runId);

    // 1. 検証。
    const pageChecks: CheckedArtifact[] = [];
    for (const page of source.pages) {
      pageChecks.push(await checkArtifact('page', pageArtifactRelativePath(page.pageId, 'page'), page.pageId, page));
    }
    const checkRunAndAudit = async (candidate: AuditRunResult): Promise<readonly CheckedArtifact[]> => [
      await checkArtifact('run', RUN_ARTIFACT_FILE_NAMES.run, candidate.run.runId, candidate.run),
      await checkArtifact('audit', RUN_ARTIFACT_FILE_NAMES.audit, candidate.run.runId, auditArtifact(candidate)),
    ];
    let runChecks = await checkRunAndAudit(source);
    const addedReasons = [...pageChecks, ...runChecks].flatMap(({ reason }) => (reason === null ? [] : [reason]));

    // 2. スキーマに合わない場合は、Run Status を `deriveRunStatus` で導き直す（ARCH05）。
    let final = source;
    if (addedReasons.length > 0) {
      const statusInput: RunStatusInput = {
        ...source.statusInput,
        requiredArtifactsValid: false,
        incompleteReasons: withReasons(source.statusInput.incompleteReasons, addedReasons),
      };
      const run: RunSummary = {
        ...source.run,
        runStatus: deriveRunStatus(statusInput),
        incompleteReasons: withReasons(source.run.incompleteReasons, addedReasons),
      };
      final = { ...source, run, statusInput };
      // Run Status と理由の追加は、スキーマの検証の結果を変えないので、組み立て直しは1回で終わる。書く中身の検証の結果を返すため、
      // 組み立て直した run.json と audit.json を、もう一度検証する。
      runChecks = await checkRunAndAudit(final);
    }
    const invalidArtifacts = [...pageChecks, ...runChecks].flatMap(({ invalid }) => (invalid === null ? [] : [invalid]));

    // 3. 書く。
    try {
      await mkdir(runDirectory, { recursive: true });
    } catch (error) {
      throw new ArtifactWriteError(runDirectory, error);
    }
    const files: string[] = [];
    const write = async (relativePath: string, data: string): Promise<void> => {
      await writeFileAtomically(artifactFilePath(runDirectory, relativePath), data, this.#rename);
      files.push(relativePath);
    };
    for (const page of final.pages) {
      await write(pageArtifactRelativePath(page.pageId, 'page'), serializeArtifactJson(page));
      const visibleText = visibleTextOf(final.run, page);
      if (visibleText !== null) {
        await write(pageArtifactRelativePath(page.pageId, 'visibleText'), toLf(visibleText));
      } else {
        // 前の回（中断した Run の、途中で止めた回）の `visible-text.txt` が残っていれば消す（中断した Run の再開の設計書 4.5）。
        await removeFileIfPresent(artifactFilePath(runDirectory, pageArtifactRelativePath(page.pageId, 'visibleText')));
      }
    }
    await write(RUN_ARTIFACT_FILE_NAMES.run, serializeArtifactJson(final.run));
    await write(RUN_ARTIFACT_FILE_NAMES.audit, serializeArtifactJson(auditArtifact(final)));

    return deepFreeze({
      result: final,
      runDirectory,
      files,
      schemaValid: invalidArtifacts.length === 0,
      invalidArtifacts,
    });
  }

  /**
   * 表示用モデルから作ったファイル（`report.html`、ChatGPT 用バンドル）を、`writeRun` が書いた Run のディレクトリに書く。
   * 与えられたものだけを、この順に、一時ファイルと rename で書く。書いたファイルの相対パスを返す。入出力の失敗は
   * `ArtifactWriteError` を投げる。
   * - バンドルの名前は、`bundle.lastExecutionFinishedAt`（最後の実行の終わりの時刻）から `bundleFileName` で作る（ChatGPT 用バンドルの
   *   ファイル名の設計書 2.1）。時刻が不正なら、何も書かずに `RangeError` を投げる。
   * - バンドルを書き終えた後に、Run のディレクトリの直下の、ほかのバンドルの名前（`isBundleFileName`。前の形と、日時の違う新しい形）の
   *   普通のファイルを消す（設計書 2.2。Run のディレクトリには、最新のバンドルを1つだけ残す）。リンク（symlink、junction）は、たどらず、
   *   消さない。ほかのファイルと、下のディレクトリには触れない。消す前に、パスが Run のディレクトリの中にあることを確かめる。
   *   新しいバンドルを書けなかった場合は、古いバンドルを消さない。古いバンドルを消せなかった場合は `ArtifactWriteError`（`path` は、
   *   消せなかったファイル）を投げる。
   */
  async writePresentation(
    written: Pick<ArtifactWriteResult, 'runDirectory'>,
    files: RunPresentationFiles,
  ): Promise<readonly string[]> {
    if (!isRecord(written) || typeof written.runDirectory !== 'string' || written.runDirectory.length === 0) {
      throw new TypeError('ArtifactWriter.writePresentation requires the result of writeRun');
    }
    // 書く前に、バンドルの名前を作る（時刻が不正なら、何も書かずに `RangeError`）。
    const bundle = files.bundle === undefined
      ? null
      : { name: bundleFileName(files.bundle.lastExecutionFinishedAt), bytes: files.bundle.bytes };
    const writtenFiles: string[] = [];
    if (files.reportHtml !== undefined) {
      await writeFileAtomically(artifactFilePath(written.runDirectory, RUN_ARTIFACT_FILE_NAMES.report), toLf(files.reportHtml), this.#rename);
      writtenFiles.push(RUN_ARTIFACT_FILE_NAMES.report);
    }
    if (bundle !== null) {
      await writeFileAtomically(artifactFilePath(written.runDirectory, bundle.name), bundle.bytes, this.#rename);
      writtenFiles.push(bundle.name);
      await this.#removeOtherBundles(written.runDirectory, bundle.name);
    }
    return Object.freeze(writtenFiles);
  }

  /**
   * Run のディレクトリの直下の、`keptName` 以外のバンドルの名前（`isBundleFileName`）の普通のファイルを消す（ChatGPT 用バンドルの
   * ファイル名の設計書 2.2）。リンク（symlink、junction）と、ファイルでないものは消さない。消す前に、パスが Run のディレクトリの中に
   * あることを確かめる。消せなかった場合は `ArtifactWriteError` を投げる。
   */
  async #removeOtherBundles(runDirectory: string, keptName: string): Promise<void> {
    const root = resolve(runDirectory);
    for (const entry of await listRealDirectory(root, null)) {
      if (!entry.isFile() || entry.name === keptName || !isBundleFileName(entry.name)) {
        continue;
      }
      const path = artifactFilePath(root, entry.name);
      if (!isInsideDirectory(root, path)) {
        throw new RangeError(`refusing to remove a path outside the run directory: ${entry.name}`);
      }
      try {
        await this.#fileOperations.rm(path, { force: true });
      } catch (error) {
        throw new ArtifactWriteError(path, error);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // サイトの不調で止めたときの診断の記録（サイトの不調で止めたときの診断の記録の設計書 2.3）
  // -------------------------------------------------------------------------------------------------------------

  /**
   * サイトの不調で止めたときの診断の記録（Run Coordinator の `SiteUnavailableDiagnosticRecord`）を、Run のディレクトリの
   * `diagnostics/site-unavailable-<pageId>-<実行の番号>-<試行の番号>.json`（`siteUnavailableDiagnosticRelativePath`）に書き、その相対パスを
   * 返す。`attemptNumber` は、その実行の中でそのページを監査した試行の番号（1 回目が 1。捨てた後の確かめ直しの試行は 2〜5。サイトが
   * 応答しないときに Run を止める設計書 3.5.2、3.6.2）。記録の中には入れない（記録の形は変えない。名前にだけ使う）。
   * - 値を `site-unavailable-diagnostic` のスキーマで検証し、合わなければ何も書かずに `ArtifactWriteError` を投げる（呼び出し側が捨てる）。
   * - 合えば、今の artifact の書き方（同じディレクトリの一時ファイルに書いて、名前を変える。`renameWithRetry`）で書く。`diagnostics/`
   *   （と Run のディレクトリ）がなければ作る。同じ名前のファイルがあれば置き換える。ほかのファイルには触れない。
   * - 監査の結果ではないので、Run Status は導き直さない。`fsync` も加えない（最後の artifact の書き出しと同じ）。
   * Run のディレクトリが空なら `TypeError`、ページの ID か実行の番号か試行の番号がファイルの名前に使えない形なら `RangeError` を、
   * 何も書かずに投げる。
   */
  async writeSiteUnavailableDiagnostic<TRecord extends SiteUnavailableDiagnosticShape>(
    runDirectory: string,
    record: TRecord,
    attemptNumber: number,
  ): Promise<string> {
    assertRunDirectory(runDirectory, 'writeSiteUnavailableDiagnostic');
    const pageId: unknown = isRecord(record) ? record.pageId : undefined;
    assertPathPageId(pageId);
    const relativePath = siteUnavailableDiagnosticRelativePath(pageId, record.executionNumber, attemptNumber);
    const path = artifactFilePath(runDirectory, relativePath);
    await writeFileAtomically(path, await checkpointJson('site-unavailable-diagnostic', path, this.#outgoing(record)), this.#rename);
    return relativePath;
  }

  /**
   * 発見のジョブの成果物（`src/discovery/discovery-result.ts` の `DiscoveryDocument`。Task 27 の設計書の変更履歴「Blocker: T27d」の行の (1)）を、
   * Run のディレクトリの `discovery.json`（`DISCOVERY_ARTIFACT_FILE_NAME`）に書き、その相対パスを返す。
   * - 値を、URL の伏せ字の 1 か所（`#outgoing`。認証つきの書き手では、すべての文字列の URL の秘密を伏せる）に通してから、`discovery` のスキーマで
   *   検証し、合わなければ何も書かずに `ArtifactWriteError` を投げる（呼び出し側が扱う）。
   * - 合えば、今の artifact の書き方（同じディレクトリの一時ファイルに書いて、名前を変える。`renameWithRetry`）で書く。同じ名前のファイルが
   *   あれば置き換える。ほかのファイルには触れない。`fsync` は加えない（最後の artifact の書き出しと同じ）。
   * Run のディレクトリが空なら、何も書かずに `TypeError`。report は discovery を import しない（UI Gate）ので、値の型は呼び出し側の型のまま受ける。
   */
  async writeDiscovery<TDocument extends object>(runDirectory: string, document: TDocument): Promise<string> {
    return this.#writeJobDocument('writeDiscovery', 'discovery', DISCOVERY_ARTIFACT_FILE_NAME, runDirectory, document);
  }

  /**
   * ジョブの成果物 1 つ（Run のディレクトリの直下の JSON）を書く共通の手順（T32e で、発見・READ の確かめ・書き込みのジョブの 5 つの口を 1 か所に
   * まとめた。書き方は変えない）: Run のディレクトリを確かめ（空なら何も書かずに `TypeError`）、値を URL の伏せ字の 1 か所（`#outgoing`）に通し、
   * `schema` で検証し（合わなければ何も書かずに `ArtifactWriteError`）、一時ファイルに書いて名前を変える。書いたファイルの相対パス（`fileName`）を返す。
   */
  async #writeJobDocument(method: string, schema: JobDocumentSchemaName, fileName: string, runDirectory: string, document: object): Promise<string> {
    assertRunDirectory(runDirectory, method);
    const path = artifactFilePath(runDirectory, fileName);
    await writeFileAtomically(path, await checkpointJson(schema, path, this.#outgoing(document)), this.#rename);
    return fileName;
  }

  /**
   * READ の確かめのジョブの成果物（`src/discovery/read-check-evaluation.ts` の `ReadEvidenceDocument`。Task 27 の設計書 4.5。T27e）を、Run の
   * ディレクトリの `read-evidence.json`（`READ_EVIDENCE_ARTIFACT_FILE_NAME`）に書き、その相対パスを返す。書き方は `writeDiscovery` と同じ（URL の
   * 伏せ字の 1 か所 `#outgoing` を通してから `read-evidence` のスキーマで検証し、合わなければ何も書かずに `ArtifactWriteError`）。
   * Run のディレクトリが空なら、何も書かずに `TypeError`。report は discovery を import しない（UI Gate）ので、値の型は呼び出し側の型のまま受ける。
   */
  async writeReadEvidence<TDocument extends object>(runDirectory: string, document: TDocument): Promise<string> {
    return this.#writeJobDocument('writeReadEvidence', 'read-evidence', READ_EVIDENCE_ARTIFACT_FILE_NAME, runDirectory, document);
  }

  /**
   * 書き込みのジョブの成果物（`src/control/actions/action-contracts.ts` の `ActionRunDocument`。Task 30 の設計書 3 章の「記録」。T30f）を、Run の
   * ディレクトリの `action-run.json`（`ACTION_RUN_ARTIFACT_FILE_NAME`）に書き、その相対パスを返す。書き方は `writeReadEvidence` と同じ（URL の伏せ字の
   * 1 か所 `#outgoing` を通してから `action-run` のスキーマで検証し、合わなければ何も書かずに `ArtifactWriteError`）。
   * Run のディレクトリが空なら、何も書かずに `TypeError`。値の型は呼び出し側の型のまま受ける。
   */
  async writeActionRun<TDocument extends object>(runDirectory: string, document: TDocument): Promise<string> {
    return this.#writeJobDocument('writeActionRun', 'action-run', ACTION_RUN_ARTIFACT_FILE_NAME, runDirectory, document);
  }

  /**
   * 書き込みの報告の証拠（`src/control/actions/action-contracts.ts` の `ActionEvidenceDocument`。Task 32 の設計書 4.1。T32e）を、Run のディレクトリの
   * `action-evidence.json`（`ACTION_EVIDENCE_ARTIFACT_FILE_NAME`）に書き、その相対パスを返す。書き方は `writeActionRun` と同じ（`#outgoing` を通して
   * から `action-evidence` のスキーマで検証し、合わなければ何も書かずに `ArtifactWriteError`）。照合の READ の URL は、ここで伏せ字を通る。
   * Run のディレクトリが空なら、何も書かずに `TypeError`。report は control を import しない（`control-boundary` (a)）ので、値の型は呼び出し側の型の
   * まま受ける。
   */
  async writeActionEvidence<TDocument extends object>(runDirectory: string, document: TDocument): Promise<string> {
    return this.#writeJobDocument('writeActionEvidence', 'action-evidence', ACTION_EVIDENCE_ARTIFACT_FILE_NAME, runDirectory, document);
  }

  /**
   * 書き込みの報告の承認の要約（`ApprovalSummaryDocument`。Task 32 の設計書 4.1。T32e）を、Run のディレクトリの `approval-summary.json`
   * （`APPROVAL_SUMMARY_ARTIFACT_FILE_NAME`）に書き、その相対パスを返す。書き方は `writeActionEvidence` と同じ（スキーマ `approval-summary`）。
   */
  async writeApprovalSummary<TDocument extends object>(runDirectory: string, document: TDocument): Promise<string> {
    return this.#writeJobDocument('writeApprovalSummary', 'approval-summary', APPROVAL_SUMMARY_ARTIFACT_FILE_NAME, runDirectory, document);
  }

  /**
   * 書き込みの報告の HTML とバンドルを組み立てる前に、3 つの文書（`action-run.json`・`action-evidence.json`・`approval-summary.json`）を、書くときと
   * 同じ手順（URL の伏せ字の 1 か所 `#outgoing`、それぞれのスキーマの検証、artifact の JSON の書式）に通した文字列と、その値を返す（T32f。Task 32 の
   * 設計書 4.1）。ファイルは書かない。返す文字列は、`writeActionRun`・`writeActionEvidence`・`writeApprovalSummary` が書くバイト列と同じ（バンドルの中の
   * JSON と、表示用モデルの値（伏せ字の後の URL）は、これから作る）。どれかがスキーマに合わなければ `ArtifactWriteError`、Run のディレクトリが空なら
   * `TypeError`（どちらも何も書かない）。
   */
  async prepareActionReport<TRun extends object, TEvidence extends object, TSummary extends object>(
    runDirectory: string,
    documents: { readonly actionRun: TRun; readonly evidence: TEvidence; readonly approvalSummary: TSummary },
  ): Promise<{
    readonly actionRun: PreparedJobDocument<TRun>;
    readonly evidence: PreparedJobDocument<TEvidence>;
    readonly approvalSummary: PreparedJobDocument<TSummary>;
  }> {
    assertRunDirectory(runDirectory, 'prepareActionReport');
    const prepare = async <TValue extends object>(schema: JobDocumentSchemaName, fileName: string, document: TValue): Promise<PreparedJobDocument<TValue>> => {
      const text = await checkpointJson(schema, artifactFilePath(runDirectory, fileName), this.#outgoing(document));
      return deepFreeze({ text, value: JSON.parse(text) as TValue });
    };
    return {
      actionRun: await prepare('action-run', ACTION_RUN_ARTIFACT_FILE_NAME, documents.actionRun),
      evidence: await prepare('action-evidence', ACTION_EVIDENCE_ARTIFACT_FILE_NAME, documents.evidence),
      approvalSummary: await prepare('approval-summary', APPROVAL_SUMMARY_ARTIFACT_FILE_NAME, documents.approvalSummary),
    };
  }

  /**
   * 書き込みの報告の HTML（`action-report.html`）と書き込みのバンドル（`actionBundleFileName(bundle.finishedAt)`。`finishedAt` は `action-run.json` の
   * 終わりの時刻）を、この順に、一時ファイルと rename で書き、書いたファイルの相対パスを返す（T32f）。バンドルの名前を作れない時刻なら、何も書かずに
   * `RangeError`。入出力の失敗は `ArtifactWriteError`。HTML は LF にして書く（`writePresentation` と同じ）。
   */
  async writeActionPresentation(
    runDirectory: string,
    presentation: { readonly reportHtml: string; readonly bundle: { readonly bytes: Uint8Array; readonly finishedAt: string } },
  ): Promise<readonly string[]> {
    assertRunDirectory(runDirectory, 'writeActionPresentation');
    const bundleName = actionBundleFileName(presentation.bundle.finishedAt);
    await writeFileAtomically(artifactFilePath(runDirectory, ACTION_REPORT_ARTIFACT_FILE_NAME), toLf(presentation.reportHtml), this.#rename);
    await writeFileAtomically(artifactFilePath(runDirectory, bundleName), presentation.bundle.bytes, this.#rename);
    return Object.freeze([ACTION_REPORT_ARTIFACT_FILE_NAME, bundleName]);
  }

  // -------------------------------------------------------------------------------------------------------------
  // 再開のための保存（チェックポイント。中断した Run の再開の設計書 4.1〜4.3）
  // -------------------------------------------------------------------------------------------------------------

  /**
   * ページの保存（R2 の `createRunCheckpointPage` の値）を、`checkpoint/pages/<pageId>.json` に書く（設計書 4.1、4.3）。
   * 値を `checkpoint-page` のスキーマで検証し、合わなければ何も書かずに `ArtifactWriteError` を投げる。合えば、一時ファイルに書いて
   * `fsync` し、rename する（Windows 以外では、その後にディレクトリも `fsync` する）。書いたファイルの、Run のディレクトリからの
   * 相対パスを返す。ページの ID がパスに使えない形なら、何も書かずに `RangeError` を投げる。
   */
  async writeCheckpointPage<TPage extends CheckpointPageShape>(runDirectory: string, page: TPage): Promise<string> {
    assertRunDirectory(runDirectory, 'writeCheckpointPage');
    const pageId: unknown = isRecord(page) ? page.pageId : undefined;
    assertPathPageId(pageId);
    const relativePath = checkpointPageArtifactRelativePath(pageId);
    const path = artifactFilePath(runDirectory, relativePath);
    await this.#writeFileDurably(path, await checkpointJson('checkpoint-page', path, this.#outgoing(page)));
    return relativePath;
  }

  /**
   * 状態の保存（R2 の `createRunCheckpoint` の値）を、`checkpoint/state.json` に書く（設計書 4.1、4.3）。
   * 値を `checkpoint` のスキーマで検証し、合わなければ何も書かずに（今の `state.json` も動かさずに）`ArtifactWriteError` を投げる。
   * 合えば、次の順に書く。
   * 1. 一時ファイルに書き、`fsync` で確定する。
   * 2. 今の `state.json` があれば、`state.prev.json` に名前を変える（前の `state.prev.json` は置き換わる）。
   * 3. 一時ファイルの名前を `state.json` に変える。
   * 4. Windows でなければ、`checkpoint/` を開いて `fsync` する（できなくても、保存の失敗にはしない）。
   * 2 と 3 の間で止まった場合は、`state.json` がなく `state.prev.json` だけが残る。`readCheckpoint` は、そのとき `state.prev.json` を使う。
   * 呼び出し側は、`completedPageIds` に載せるページの保存を、先に `writeCheckpointPage` で書く（設計書 4.3）。
   */
  async writeCheckpointState<TState extends CheckpointStateShape>(runDirectory: string, state: TState): Promise<void> {
    assertRunDirectory(runDirectory, 'writeCheckpointState');
    const path = artifactFilePath(runDirectory, checkpointArtifactRelativePath('state'));
    const previousPath = artifactFilePath(runDirectory, checkpointArtifactRelativePath('previousState'));
    const data = await checkpointJson('checkpoint', path, this.#outgoing(state));
    await this.#writeFileDurably(path, data, async () => {
      try {
        await this.#rename(path, previousPath);
      } catch (error) {
        // 今の `state.json` がない（最初の保存か、前の回が 2 と 3 の間で止まった）場合は、移すものがない。
        if (errorCodeOf(error) !== 'ENOENT') {
          throw error;
        }
      }
    });
  }

  /**
   * 保存を読み、確かめる（設計書 4.2、4.3）。例外を投げずに結果を返す（引数が不正な場合の `TypeError` を除く）。
   * 1. `checkpoint/state.json` を読み、`JSON.parse`、`checkpoint` のスキーマ、Run の ID（`runId`）が Run のディレクトリの名前
   *    （`basename(runDirectory)`）と同じこと、`checks.checkState` の順に確かめる。続けて、
   *    `completedPageIds` のそれぞれのページの保存を読み、`JSON.parse`、`checkpoint-page` のスキーマ、保存の名前とページの ID が
   *    同じこと、`checks.checkPage` の順に確かめる。
   * 2. どれかが失敗したら（ファイルがない場合を含む）、`checkpoint/state.prev.json` で同じことを行う。
   * 型の引数は、`checks` の関数の型から推論される（Run Coordinator は R2 の関数を渡すので、`RunCheckpoint` と `RunCheckpointPage`）。
   * スキーマの検証を通った値を、その型として扱う。結果は深く凍結する。
   */
  async readCheckpoint<TState extends CheckpointStateShape, TPage extends CheckpointPageShape>(
    runDirectory: string,
    checks: CheckpointConsistencyChecks<TState, TPage>,
  ): Promise<CheckpointReadResult<TState, TPage>> {
    assertRunDirectory(runDirectory, 'readCheckpoint');
    if (!isRecord(checks) || typeof checks.checkState !== 'function' || typeof checks.checkPage !== 'function') {
      throw new TypeError('ArtifactWriter.readCheckpoint requires checkState and checkPage functions');
    }
    const read = await readFirstUsableCheckpointSource((source) => readCheckpointSource(runDirectory, source, checks));
    return deepFreeze(read.ok
      ? { ok: true, source: read.source, state: read.value.state, pages: read.value.pages, failures: read.failures }
      : { ok: false, failures: read.failures });
  }

  /**
   * 状態の保存だけを読み、確かめる（中断した Run の再開の設計書 4.7.1 の「途中の Run を探す読み方」）。ページの保存は読まない（終わった
   * Run が出力先に増えても、起動が遅くならないようにするため）。確かめの順と結果の形は `readCheckpoint` と同じで、ページの保存を除いたもの
   * である。例外を投げずに結果を返す（引数が不正な場合の `TypeError` を除く）。
   * 1. `checkpoint/state.json` を読み、`JSON.parse`、`checkpoint` のスキーマ、Run の ID が Run のディレクトリの名前と同じこと、
   *    `checkState` の順に確かめる。
   * 2. どれかが失敗したら（ファイルがない場合を含む）、`checkpoint/state.prev.json` で同じことを行う。
   * 型の引数は、`checkState` の型から推論される（CLI は R2 の `checkRunCheckpointConsistency` を渡すので、`RunCheckpoint`）。結果は深く凍結する。
   */
  async readCheckpointState<TState extends CheckpointStateShape>(
    runDirectory: string,
    checkState: (state: TState) => ArtifactValidationResult,
  ): Promise<CheckpointStateReadResult<TState>> {
    assertRunDirectory(runDirectory, 'readCheckpointState');
    if (typeof checkState !== 'function') {
      throw new TypeError('ArtifactWriter.readCheckpointState requires a checkState function');
    }
    const read = await readFirstUsableCheckpointSource((source) => readCheckpointStateSource(runDirectory, source, checkState));
    return deepFreeze(read.ok
      ? { ok: true, source: read.source, state: read.value, failures: read.failures }
      : { ok: false, failures: read.failures });
  }

  // -------------------------------------------------------------------------------------------------------------
  // ロック（中断した Run の再開の設計書 4.4。判定は `run-checkpoint.ts` の `judgeRunLock` が行う）
  // -------------------------------------------------------------------------------------------------------------

  /**
   * `checkpoint/run.lock` を排他的に作り（`open` の `wx`）、ロックの中身（R2 の `createRunLock` の値）を JSON で書いて `fsync` する
   * （Windows 以外では、その後に `checkpoint/` も `fsync` する）。
   * すでにあれば、例外にせず、何も変えずに、今の中身（JSON として読めなければ `null`）を返す。書いている途中で失敗した場合は、
   * この呼び出しで作ったロックのファイルを消してから `ArtifactWriteError` を投げる。JSON にできない中身は、何も書かずに `TypeError`。
   */
  async acquireRunLock(runDirectory: string, lock: object): Promise<RunLockAcquisition> {
    assertRunDirectory(runDirectory, 'acquireRunLock');
    return await this.#acquireLockFile(artifactFilePath(runDirectory, checkpointArtifactRelativePath('lock')), lock);
  }

  /**
   * `checkpoint/run.lock` を、ロックの中身（古いロックを作り直す場合は `createRunLock`、ハートビートは `renewRunLock` の値）で、
   * まるごと書き換える（一時ファイルに書いて `fsync` し、rename する。Windows 以外では、その後に `checkpoint/` も `fsync` する）。
   * JSON にできない中身は、何も書かずに `TypeError`。入出力の失敗は `ArtifactWriteError`。
   */
  async rewriteRunLock(runDirectory: string, lock: object): Promise<void> {
    assertRunDirectory(runDirectory, 'rewriteRunLock');
    const data = runLockJson(lock);
    await this.#writeFileDurably(artifactFilePath(runDirectory, checkpointArtifactRelativePath('lock')), data);
  }

  /**
   * `checkpoint/run.lock` の今の中身を、JSON として読んだ値を返す（設計書 4.4。古いロックを作り直した後に、自分のものかを読み直す
   * ため）。ファイルがない、読めない、または JSON でない場合は `null`。読むだけで、何も書かない（ファイルの操作の差し替え口も使わない）。
   * 値は深く凍結する。ロックの判定（`judgeRunLock`）はしない。
   */
  async readRunLock(runDirectory: string): Promise<unknown> {
    assertRunDirectory(runDirectory, 'readRunLock');
    return deepFreeze(await readJsonOrNull(artifactFilePath(runDirectory, checkpointArtifactRelativePath('lock'))));
  }

  /** `checkpoint/run.lock` を消す（なければ何もしない）。入出力の失敗は `ArtifactWriteError`。 */
  async releaseRunLock(runDirectory: string): Promise<void> {
    assertRunDirectory(runDirectory, 'releaseRunLock');
    await this.#removeLockFile(artifactFilePath(runDirectory, checkpointArtifactRelativePath('lock')));
  }

  /**
   * 判定した古い `checkpoint/run.lock`（`judged`。読んだ中身）を、原子的に取り直す（DEF-060。手順は `#takeOverLockFile`）。判定はしない
   * （呼び出し側が `judgeRunLock` で判定し、`takeOverStaleLock` で判定し直す）。
   */
  async takeOverRunLock(runDirectory: string, judged: unknown, lock: object): Promise<LockTakeover> {
    assertRunDirectory(runDirectory, 'takeOverRunLock');
    return await this.#takeOverLockFile(artifactFilePath(runDirectory, checkpointArtifactRelativePath('lock')), judged, lock);
  }

  // -------------------------------------------------------------------------------------------------------------
  // 出力先の開始のロック（DEF-057。Task 24 の設計書 4.6。持つ・離す・古さの判定は `src/cli/audit-run.ts` が、判定の部品は
  // `run-checkpoint.ts` の `judgeRunLock` を使って行う）。書き方は、Run のロックと同じ（`wx` で作る、一時ファイルから rename で書き換える）。
  // -------------------------------------------------------------------------------------------------------------

  /**
   * 出力先の開始のロック（`outputStartLockPath(outputDirectory)`）を排他的に作り（`open` の `wx`）、ロックの中身（`createRunLock` の値）を
   * JSON で書いて `fsync` する。出力先がなければ作る（`recursive`）。作れたら、作る前になかったディレクトリのいちばん上のもの（`createdDirectory`。
   * 出力先がすでにあれば `null`）を返す（離すときに、空のまま残さないため。`releaseOutputStartLock`）。すでにあれば、例外にせず、何も変えずに、
   * 今の中身（JSON として読めなければ `null`）を返す。失敗の扱いは `acquireRunLock` と同じ（書いている途中の失敗は、作ったファイルを消してから
   * `ArtifactWriteError`）。
   */
  async acquireOutputStartLock(outputDirectory: string, lock: object): Promise<OutputStartLockAcquisition> {
    assertOutputDirectory(outputDirectory, 'acquireOutputStartLock');
    const missingDirectory = await topmostMissingDirectory(resolve(outputDirectory));
    const acquisition = await this.#acquireLockFile(outputStartLockPath(outputDirectory), lock);
    return acquisition.acquired ? deepFreeze({ acquired: true, createdDirectory: missingDirectory }) : acquisition;
  }

  /** 判定した古い出力先の開始のロック（`judged`）を、原子的に取り直す（DEF-060。手順は `#takeOverLockFile`。`takeOverRunLock` と同じ）。 */
  async takeOverOutputStartLock(outputDirectory: string, judged: unknown, lock: object): Promise<LockTakeover> {
    assertOutputDirectory(outputDirectory, 'takeOverOutputStartLock');
    return await this.#takeOverLockFile(outputStartLockPath(outputDirectory), judged, lock);
  }

  /** 出力先の開始のロックを、ロックの中身でまるごと書き換える（書き方は `rewriteRunLock` と同じ）。 */
  async rewriteOutputStartLock(outputDirectory: string, lock: object): Promise<void> {
    assertOutputDirectory(outputDirectory, 'rewriteOutputStartLock');
    const data = runLockJson(lock);
    await this.#writeFileDurably(outputStartLockPath(outputDirectory), data);
  }

  /** 出力先の開始のロックの今の中身を、JSON として読んだ値を返す（ない、読めない、JSON でなければ `null`。読み方は `readRunLock` と同じ）。 */
  async readOutputStartLock(outputDirectory: string): Promise<unknown> {
    assertOutputDirectory(outputDirectory, 'readOutputStartLock');
    return deepFreeze(await readJsonOrNull(outputStartLockPath(outputDirectory)));
  }

  /**
   * 出力先の開始のロックを消す（なければ何もしない）。入出力の失敗は `ArtifactWriteError`。`createdDirectory`（`acquireOutputStartLock` が
   * 作ったディレクトリ）を渡すと、その後に、出力先からそのディレクトリまでを、空であるものだけ、深い方から消す（開始のロックのために作った
   * 出力先を、Run を始めずに終わったときに残さない。空でなければ（Run のディレクトリができていれば）、何も消さずに止める）。
   */
  async releaseOutputStartLock(outputDirectory: string, createdDirectory: string | null = null): Promise<void> {
    assertOutputDirectory(outputDirectory, 'releaseOutputStartLock');
    await this.#removeLockFile(outputStartLockPath(outputDirectory));
    if (createdDirectory === null) {
      return;
    }
    const top = resolve(createdDirectory);
    let directory = resolve(outputDirectory);
    if (directory !== top && !isInsideDirectory(top, directory)) {
      throw new RangeError('the created directory of the output start lock must contain the output directory');
    }
    for (;;) {
      try {
        await rmdir(directory);
      } catch {
        // 空でない（Run のディレクトリなどがある）か、すでにない。そこで止める（中身は消さない）。
        return;
      }
      if (directory === top) {
        return;
      }
      directory = dirname(directory);
    }
  }

  /** ロックのファイル（`path`）を排他的に作って中身を書く（`acquireRunLock` と `acquireOutputStartLock` の本体）。 */
  async #acquireLockFile(path: string, lock: object): Promise<RunLockAcquisition> {
    const data = runLockJson(lock);
    try {
      await this.#fileOperations.mkdir(dirname(path), { recursive: true });
    } catch (error) {
      throw new ArtifactWriteError(dirname(path), error);
    }
    let handle: CheckpointFileHandle;
    try {
      handle = await this.#fileOperations.open(path, 'wx');
    } catch (error) {
      if (errorCodeOf(error) === 'EEXIST') {
        return deepFreeze({ acquired: false, existing: await readJsonOrNull(path) });
      }
      throw new ArtifactWriteError(path, error);
    }
    try {
      await writeAndSync(handle, data);
    } catch (error) {
      await this.#fileOperations.rm(path, { force: true }).catch(() => undefined);
      throw new ArtifactWriteError(path, error);
    }
    await this.#syncDirectory(dirname(path));
    return deepFreeze({ acquired: true });
  }

  /**
   * 判定した古いロックのファイル（`path`。読んだ中身が `judged`）を、原子的に取り直す（DEF-060。`takeOverRunLock` と `takeOverOutputStartLock`
   * の本体）。
   * 手順の判断は `src/core/lock-file.ts` の `takeOverLockFile`、ここはファイルの操作を渡すだけ（T24h-3）。
   * 1. ロックを、一意の名前（`movedStaleLockPathFor`）へ `rename` する。ないなら（`ENOENT`。ほかの起動が先に動かした、持ち主が消した）、
   *    `CHANGED`。
   * 2. 動かしたファイルの中身が `judged` と違えば（ほかの起動が新しく作ったロックや、ハートビートで書き換えたロックを動かしてしまった）、
   *    上書きせずに元の名前へ戻し（`link`。すでにあれば戻さない）、動かした名前を消して、`CHANGED`。
   * 3. 同じなら、古いロックを動かせたのは自分だけなので、`wx` で新しいロックを作る（`#acquireLockFile`）。作れたら `ACQUIRED`、すでに
   *    あれば（ほかの起動が先に作った）`LOST`。
   * 4. 動かした古いファイルは消す。消せなくても進む（警告にしない。名前は一時ファイルの形なので、Run のディレクトリでは再開の後始末が消す）。
   * JSON にできない中身は、何も動かさずに `TypeError`。入出力の失敗は `ArtifactWriteError`。
   */
  async #takeOverLockFile(path: string, judged: unknown, lock: object): Promise<LockTakeover> {
    runLockJson(lock);
    // 手順の判断は `src/core/lock-file.ts` の `takeOverLockFile`（T24h-3 で移した）。ファイルの操作は、ここで行う（ARCH08）。
    return await takeOverLockFile({
      moveAway: async (from, to) => {
        try {
          await this.#rename(from, to);
          return true;
        } catch (error) {
          if (errorCodeOf(error) === 'ENOENT') {
            return false;
          }
          throw new ArtifactWriteError(from, error);
        }
      },
      readJson: readJsonOrNull,
      createExclusive: async (target) => (await this.#acquireLockFile(target, lock)).acquired,
      restore: async (movedPath, target) => await this.#restoreMovedLock(movedPath, target),
      remove: async (target) => {
        await this.#fileOperations.rm(target, { force: true }).catch(() => undefined);
      },
    }, path, judged);
  }

  /**
   * 取り直しで動かしてしまった他人のロック（`movedPath`）を、元の名前（`path`）へ、上書きせずに戻す（DEF-060）。`link` で戻し、すでにあれば
   * （`EEXIST`。ほかの起動が作った）戻さない。`link` を使えないファイルシステムでは、中身を `wx` で書いて戻す。戻せなくても、例外にしない
   * （戻せなかったロックの持ち主は、ロックのファイルなしで動く。ほかの起動が戻す前に新しいロックを作った、ごく短い間の 3 つの起動の重なりだけで起きる）。
   */
  async #restoreMovedLock(movedPath: string, path: string): Promise<void> {
    try {
      await link(movedPath, path);
      return;
    } catch (error) {
      if (errorCodeOf(error) === 'EEXIST') {
        return;
      }
    }
    try {
      const content = await readFile(movedPath, 'utf8');
      await writeAndSync(await this.#fileOperations.open(path, 'wx'), content);
    } catch {
      // 戻せなかった（上の説明）。
    }
  }

  /** ロックのファイル（`path`）を消す（なければ何もしない。`releaseRunLock` と `releaseOutputStartLock` の本体）。 */
  async #removeLockFile(path: string): Promise<void> {
    try {
      await this.#fileOperations.rm(path, { force: true });
    } catch (error) {
      throw new ArtifactWriteError(path, error);
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // 再開のときの後始末（中断した Run の再開の設計書 4.5）
  // -------------------------------------------------------------------------------------------------------------

  /**
   * 再開する前に、Run のディレクトリの中の、前の回の途中のものを消す（設計書 4.5）。`completedPageIds` は、使う保存の
   * `completedPageIds`（終わったページの ID）。消すもの:
   * - `pages/` の直下の、名前がページの ID の形（`isPageId`）で、終わったページにないディレクトリ
   * - `checkpoint/pages/` の直下の、終わったページにない ID のページの保存（`<pageId>.json`）
   * - 書き出しの途中の一時ファイル（`.<名前>.<UUID>.tmp`）。探す場所は、Run のディレクトリの直下、`checkpoint/`、`checkpoint/pages/`、
   *   終わったページの `pages/<pageId>/`
   * - PREFLIGHT の一時ファイル（Run のディレクトリの直下の、`PREFLIGHT_TEMPORARY_FILE_PREFIX` と `PREFLIGHT_TEMPORARY_FILE_SUFFIX` の名前）
   * ほかの名前のものは残す。リンク（symlink、junction）は、たどらず、消さない。消す前に、パスが Run のディレクトリの中にあることを
   * 確かめる。消したものの、Run のディレクトリからの相対パス（区切りは `/`）を、消した順に返す。
   * 保存やロックの書き出しと同時に呼ばない（書いている途中の一時ファイルを消すため）。再開の始めに、保存を書く前に呼ぶ。
   * 終わったページの ID の形が正しくなければ、何も消さずに `RangeError` を投げる。入出力の失敗は `ArtifactWriteError`。
   */
  async cleanUpForResume(runDirectory: string, completedPageIds: readonly PageId[]): Promise<readonly string[]> {
    assertRunDirectory(runDirectory, 'cleanUpForResume');
    if (!Array.isArray(completedPageIds)) {
      throw new TypeError('ArtifactWriter.cleanUpForResume requires the list of completed page IDs');
    }
    for (const pageId of completedPageIds) {
      assertPathPageId(pageId);
    }
    const completed: ReadonlySet<string> = new Set(completedPageIds);
    const root = resolve(runDirectory);
    const removed: string[] = [];
    const remove = async (relativePath: string, recursive: boolean): Promise<void> => {
      const path = artifactFilePath(root, relativePath);
      if (!isInsideDirectory(root, path)) {
        throw new RangeError(`refusing to remove a path outside the run directory: ${relativePath}`);
      }
      try {
        await rm(path, { recursive, force: true });
      } catch (error) {
        throw new ArtifactWriteError(path, error);
      }
      removed.push(relativePath);
    };

    for (const entry of await listRealDirectory(root, null)) {
      if (entry.isFile() && (isTemporaryFileName(entry.name) || isPreflightTemporaryFileName(entry.name))) {
        await remove(entry.name, false);
      }
    }
    for (const entry of await listRealDirectory(root, PAGES_ARTIFACT_DIRECTORY)) {
      if (!entry.isDirectory() || !isPageId(entry.name)) {
        continue;
      }
      const pageDirectory = `${PAGES_ARTIFACT_DIRECTORY}/${entry.name}`;
      if (!completed.has(entry.name)) {
        await remove(pageDirectory, true);
        continue;
      }
      for (const file of await listRealDirectory(root, pageDirectory)) {
        if (file.isFile() && isTemporaryFileName(file.name)) {
          await remove(`${pageDirectory}/${file.name}`, false);
        }
      }
    }
    for (const entry of await listRealDirectory(root, CHECKPOINT_ARTIFACT_DIRECTORY)) {
      if (entry.isFile() && isTemporaryFileName(entry.name)) {
        await remove(`${CHECKPOINT_ARTIFACT_DIRECTORY}/${entry.name}`, false);
      }
    }
    for (const entry of await listRealDirectory(root, CHECKPOINT_PAGES_ARTIFACT_DIRECTORY)) {
      if (!entry.isFile()) {
        continue;
      }
      const pageId = checkpointPageIdOfFileName(entry.name);
      if (isTemporaryFileName(entry.name) || (pageId !== null && !completed.has(pageId))) {
        await remove(`${CHECKPOINT_PAGES_ARTIFACT_DIRECTORY}/${entry.name}`, false);
      }
    }
    return Object.freeze(removed);
  }

  /**
   * 最後の状態が `FINISHED` の Run の、使わなくなった再開のための保存を消す（中断した Run の再開の設計書 4.7.1 の「Run の後」）。
   * 消すのは、ページの保存（`checkpoint/pages/`。ディレクトリごと）と `checkpoint/state.prev.json` だけで、`checkpoint/state.json`（同じ対象の
   * 最も新しい Run を知るために残す）と、ほかの出力は残す。ページの保存は出力の `page.json` とほぼ同じ中身で、終わった Run では使わないので、
   * ディスクを2倍使わないようにするためである。
   * - 消す前に、パスが Run のディレクトリの `checkpoint/` の中にあることを確かめる。
   * - リンク（symlink、junction）は、たどらず、消さない（`checkpoint/` か `checkpoint/pages/` がリンクなら、何も消さない。
   *   `state.prev.json` がファイルでなければ、消さない）。
   * - ないものは、何もしない。消したものの、Run のディレクトリからの相対パス（区切りは `/`）を、消した順に返す。
   * 保存の状態は判定しない（`FINISHED` の保存を書き終えた後に呼ぶのは、呼び出し側の CLI である）。入出力の失敗は `ArtifactWriteError`
   * （`path` は、消せなかったもの）。
   */
  async removeFinishedCheckpointFiles(runDirectory: string): Promise<readonly string[]> {
    assertRunDirectory(runDirectory, 'removeFinishedCheckpointFiles');
    const root = resolve(runDirectory);
    const checkpointDirectory = artifactFilePath(root, CHECKPOINT_ARTIFACT_DIRECTORY);
    const removed: string[] = [];
    for (const { relativePath, kind } of FINISHED_RUN_REMOVED_CHECKPOINT_FILES) {
      const path = artifactFilePath(root, relativePath);
      if (!isInsideDirectory(checkpointDirectory, path)) {
        throw new RangeError(`refusing to remove a path outside checkpoint/ of the run directory: ${relativePath}`);
      }
      if (!(await isRealEntry(root, relativePath, kind))) {
        continue;
      }
      try {
        await rm(path, { recursive: kind === 'directory', force: true });
      } catch (error) {
        throw new ArtifactWriteError(path, error);
      }
      removed.push(relativePath);
    }
    return Object.freeze(removed);
  }

  // -------------------------------------------------------------------------------------------------------------
  // 保存とロックの書き出しの補助
  // -------------------------------------------------------------------------------------------------------------

  /**
   * 確定する書き方（設計書 4.3）。同じディレクトリの一時ファイルに書いて `fsync` し、`beforeRename`（あれば）の後に rename する（`#rename`）。
   * Windows 以外では、その後にディレクトリを `fsync` する。失敗した場合は、一時ファイルを消してから `ArtifactWriteError` を投げる。
   */
  async #writeFileDurably(path: string, data: string, beforeRename?: () => Promise<void>): Promise<void> {
    const operations = this.#fileOperations;
    const temporaryPath = temporaryPathFor(path);
    try {
      await operations.mkdir(dirname(path), { recursive: true });
      await writeAndSync(await operations.open(temporaryPath, 'wx'), data);
      await beforeRename?.();
      await this.#rename(temporaryPath, path);
    } catch (error) {
      await operations.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new ArtifactWriteError(path, error);
    }
    await this.#syncDirectory(dirname(path));
  }

  /**
   * ディレクトリを開いて `fsync` する（rename を確定する。設計書 4.3）。Windows では、ディレクトリの `fsync` ができないので行わない。
   * ファイルの中身は rename の前に `fsync` で確定しているので、ディレクトリの `fsync` ができない環境（ファイルシステム）でも、
   * 保存の失敗にはしない（できる限り行う）。
   */
  async #syncDirectory(directory: string): Promise<void> {
    if (this.#platform === PLATFORM_WITHOUT_DIRECTORY_SYNC) {
      return;
    }
    let handle: CheckpointFileHandle | undefined;
    try {
      handle = await this.#fileOperations.open(directory, 'r');
      await handle.sync();
    } catch {
      // できる限り行う（上のとおり、保存の失敗にはしない）。
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

/**
 * `path`（絶対のパス）とその親のうち、今ないもの（`lstat` が `ENOENT`）の、いちばん上のもの。`path` があれば `null`。ほかの失敗（途中の区切りが
 * ファイルなど）では、そこで止める（そこまでに見つけたものを返す）。出力先の開始のロックを作る前に、作ることになるディレクトリを知るために使う。
 */
async function topmostMissingDirectory(path: string): Promise<string | null> {
  let missing: string | null = null;
  let current = path;
  for (;;) {
    try {
      await lstat(current);
      return missing;
    } catch (error) {
      if (errorCodeOf(error) !== 'ENOENT') {
        return missing;
      }
    }
    missing = current;
    const parent = dirname(current);
    if (parent === current) {
      return missing;
    }
    current = parent;
  }
}

/** ファイルを JSON として読んだ値。読めない、または JSON でない場合は `null`。 */
async function readJsonOrNull(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * Run のディレクトリ（`root`。絶対パス）の中のディレクトリ（`relativeDirectory`。`null` は Run のディレクトリそのもの）の中身を、
 * 名前の順に返す。ない場合と、途中のどれかの区切り（例: `checkpoint/pages` の `checkpoint`）を含めて、リンク（symlink、junction）か、
 * ディレクトリでない場合は、空の一覧にする（リンクをたどらない。`lstat` は最後の区切りのリンクしか見分けないので、区切りごとに確かめる）。
 * 読めないほかの失敗は `ArtifactWriteError` を投げる。
 */
async function listRealDirectory(root: string, relativeDirectory: string | null): Promise<readonly Dirent[]> {
  const path = relativeDirectory === null ? root : artifactFilePath(root, relativeDirectory);
  try {
    if (relativeDirectory !== null && !(await hasRealDirectorySegments(root, relativeDirectory))) {
      return [];
    }
    const entries = await readdir(path, { withFileTypes: true });
    return entries.sort((left, right) => compareCodeUnits(left.name, right.name));
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') {
      return [];
    }
    throw new ArtifactWriteError(path, error);
  }
}

/**
 * Run のディレクトリ（`root`）からの相対パス（`relativeDirectory`。区切りは `/`）の、どの区切りも、リンク（symlink、junction）でない
 * ディレクトリか（`lstat` は最後の区切りのリンクしか見分けないので、区切りごとに確かめる）。区切りがない場合は、`lstat` の `ENOENT` を
 * そのまま投げる（呼び出し側が、ないものとして扱う）。
 */
async function hasRealDirectorySegments(root: string, relativeDirectory: string): Promise<boolean> {
  const segments = relativeDirectory.split('/');
  for (let count = 1; count <= segments.length; count += 1) {
    if (!(await lstat(artifactFilePath(root, segments.slice(0, count).join('/')))).isDirectory()) {
      return false;
    }
  }
  return true;
}

/**
 * Run のディレクトリ（`root`）からの相対パス（`relativePath`）に、リンクをたどらずに、その種類（`kind`）のものがあるか。親の区切りも、
 * どれもリンクでないディレクトリでなければならない。ない場合は偽。調べられないほかの失敗は `ArtifactWriteError` を投げる。
 */
async function isRealEntry(root: string, relativePath: string, kind: 'directory' | 'file'): Promise<boolean> {
  const separator = relativePath.lastIndexOf('/');
  const path = artifactFilePath(root, relativePath);
  try {
    if (separator > 0 && !(await hasRealDirectorySegments(root, relativePath.slice(0, separator)))) {
      return false;
    }
    const entry = await lstat(path);
    return kind === 'directory' ? entry.isDirectory() : entry.isFile();
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') {
      return false;
    }
    throw new ArtifactWriteError(path, error);
  }
}

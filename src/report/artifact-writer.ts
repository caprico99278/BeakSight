/**
 * artifact の書き出しの唯一の owner（ARCH08。Task 14〜17 の設計書 6.1.1、6.1.2）。
 * - 配置（Run のディレクトリ、ファイルの名前、Run のディレクトリからの相対パス）は、`src/core/artifact-layout.ts` から取る
 *   （設計書 6.1.8。CC-023）。このファイルは、配置の名前やパスを組み立てない。
 * - JSON は、`validateArtifact` で検証してから書く（`writeRun` は、ページごとに伏せて確かめて書き、audit.json は断片を書き足す。MEM-1）。スキーマに合わない場合は、Run Status を
 *   `deriveRunStatus` で導き直す（ARCH05。このファイルは Run Status を決めない）。スキーマに合わない JSON も、隠さずに書く。
 * - パスに使う ID（`runId`、`pageId`）は、ID の形（`isRunId`、`isPageId`。ID の owner は `src/core/ids.ts`。C16d）と、
 *   安全な区切り1つかどうか（`isPortableArtifactPathSegment`。CC-027）の両方で確かめる。形の違う値は、何も書かずに `RangeError`。
 * - ファイルは、同じディレクトリの一時ファイルに書いてから rename する。テキストは UTF-8（BOM なし）で、改行は LF にする。
 *   JSON の書式は、`serializeArtifactJson`（`src/core/artifact-json.ts`）だけで組み立てる（CC-026）。
 *   rename は、すべて `renameWithRetry`（`src/core/rename-retry.ts`）を通し、一時的な失敗（`RENAME_RETRY_ERROR_CODES`）のときだけ、短く待ってやり直す（中断した Run の
 *   再開の設計書 4.10。RR の Minor-5）。
 * - 入出力の失敗は、`ArtifactWriteError` を投げる。
 * - HTML レポートと ChatGPT 用バンドルは、描画する側が作った中身を `writePresentation` で書く（書き出しの owner は、ここだけ）。
 * - 発見のジョブの成果物（`discovery.json`。Task 27 の T27d）も、ワーカーが組み立てた値を `writeDiscovery` で、伏せ字を通してスキーマで
 *   検証してから書く。
 * - 中断した Run の再開のための保存（チェックポイント）の書き出しと読み込み（状態の保存だけの読み込みを含む）、
 *   再開のときの後始末、終わった Run の使わない保存の片付けも、ここで行う（中断した Run の再開の設計書 4.1〜4.5、4.7.1。
 *   保存のファイルの読み書きを1か所にする）。
 *   - 保存のファイルは、一時ファイルに書いて `fsync` で確定してから rename する。rename の後に、Windows 以外では
 *     ディレクトリも `fsync` する（設計書 4.3）。最後の artifact の書き出し（`writeRun`、`writePresentation`）には `fsync` を加えない。
 *   - 保存の中身の形は、スキーマ（`checkpoint`、`checkpoint-page`）で、書くときと読むときの両方で確かめる。保存の型
 *     （`RunCheckpoint` など）は `src/orchestration/run-checkpoint.ts` にあり、report は orchestration を import しない（UI Gate）ので、
 *     ここの関数は総称にし、知るのは core の型だけで書ける最小の形（`runId`、`completedPageIds`、`pageId`）だけにする。スキーマでは確かめられない
 *     整合の確かめ（R2 の `checkRunCheckpointConsistency` など）は、呼び出し側が読み込みの引数で渡す。
 * - 認証つきの Run の URL の伏せ字（Task 25 の設計書 4.6。T25f）: `urlSecretRedaction` を真にした書き手は、Run のディレクトリに書く値
 *   （`writeRun` の Run、保存のページと状態）のすべての文字列の URL に、伏せ字の owner の `redactUrlSecretsInValue`
 *   （`src/safety/redact.ts`）を、書く前に 1 か所（`#outgoing`）で通す。`writeRun` が返す最終の Run も伏せ字の後の値なので、そこから作る
 *   HTML レポートと ChatGPT 用バンドルにも、伏せ字の前の値は入らない。T44g（Task 44 の設計書 P4-1。案 2）: 既定は真（公開の監査も同じ段を通る）。
 *   加えて、どの書き手でも、記録した要求の URL（network の Evidence・resource timing・Safety の止めた記録）の query のすべての値・値に見える path の区切り・
 *   fragment の値・userinfo を、同じ 1 か所で伏せる（`redactRecordedRequestUrlsInValue`）。
 */
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { evidenceOfType } from '../audit/rule-helpers.js';
import {
  CHECKPOINT_ARTIFACT_DIRECTORY,
  CHECKPOINT_PAGES_ARTIFACT_DIRECTORY,
  DISCOVERY_ARTIFACT_FILE_NAME,
  DISCOVERY_CHECKPOINT_RELATIVE_PATH,
  ENTRY_CHECK_ARTIFACT_FILE_NAME,
  PAGES_ARTIFACT_DIRECTORY,
  READ_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_RUN_ARTIFACT_FILE_NAME,
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
  APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
  REPORT_SUMMARY_ARTIFACT_FILE_NAME,
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
  pageArtifactRelativePath,
  runArtifactDirectory,
  type CheckpointArtifactFile,
} from '../core/artifact-layout.js';
import { artifactJsonObjectChunks, serializeArtifactJson } from '../core/artifact-json.js';
import { runOnlyFindingsByPageFindingIds } from '../core/audit-artifact-findings.js';
import { decodeCheckpointPageRecord, encodeCheckpointPageRecord, encodePageRecord } from '../core/page-record-codec.js';
import type {
  AuditRunResult,
  EvidenceId,
  EvidenceRecordFor,
  Finding,
  IncompleteReason,
  PageAuditResult,
  PageId,
  RunId,
  RunRetryRecord,
  RunSummary,
  ViewportProfile,
} from '../core/contracts.js';
import { wait } from '../core/deadline.js';
import { errorCodeOf, errorMessageOrString, safeErrorMessage } from '../core/errors.js';
import { isRecord } from '../core/guards.js';
import { isPageId, isRunId } from '../core/ids.js';
import { deepFreeze } from '../core/immutable.js';
import { jsonPointerOf } from '../core/json-pointer.js';
import { renameWithRetry } from '../core/rename-retry.js';
import { forEachRunPage, isRunPageStoreValue, type RunPages } from '../core/run-page-store.js';
import {
  schemaValidationResultAt,
  validateArtifact,
  type ArtifactSchemaName,
  type ArtifactValidationResult,
  type LocatedSchemaValidationResult,
} from '../core/schema-validator.js';
import { deriveRunStatus, requiredArtifactInvalidReason, type RunStatusInput } from '../core/status.js';
import { isTemporaryFileName, temporaryPathFor } from '../core/temporary-file-name.js';
import { compareCodeUnits } from '../core/text.js';
import {
  createRecordedRequestUrlRedactionTableBuilder,
  redactRecordedRequestUrlsByTable,
  redactRecordedRequestUrlsInValue,
  redactUrlSecretsInValue,
  type RecordedRequestUrlRedactionOptions,
  type RecordedRequestUrlRedactionTable,
} from '../safety/redact.js';
import { reportSummaryBytesOf, type ReportSummaryDocument } from './report-summary.js';

/** audit.json の `schemaVersion`（`schemas/audit.schema.json`）。 */
export const AUDIT_ARTIFACT_SCHEMA_VERSION = 'audit-schema/2.0';

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
export const visibleTextOf = (run: Pick<RunSummary, 'retries'>, page: PageAuditResult): string | null =>
  visibleTextSourceOf(run, page)?.payload.visibleText.text ?? null;

/**
 * AUD-1a: `visible-text.txt` の元の DOM の Evidence（`visibleTextOf` と同じ選び方。最終の試行の Desktop、なければ Mobile）。どちらにもない場合は `null`。
 * 表示用モデルの参照の一覧（`src/report/artifact-references.ts`）が、証拠 ID とビューポートを持つために使う。
 */
export const visibleTextSourceOf = (
  run: Pick<RunSummary, 'retries'>,
  page: PageAuditResult,
): EvidenceRecordFor<'dom'> | null => {
  const earlier = earlierAttemptEvidenceIds(run, page);
  for (const viewport of VISIBLE_TEXT_VIEWPORTS) {
    const dom = evidenceOfType({ viewport, evidence: page.evidence }, 'dom').find((record) => !earlier.has(record.evidenceId));
    if (dom !== undefined) {
      return dom;
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
export interface ArtifactWriteResult<TPages extends RunPages = readonly PageAuditResult[]> {
  /**
   * 最終の Run。スキーマに合わない artifact があった場合は、`statusInput.requiredArtifactsValid` を偽にし、Run Status を
   * `deriveRunStatus` で導き直し、Run の理由に `REQUIRED_ARTIFACT_INVALID` を加えたもの。表示用モデルは、これから組み立てる。
   * MEM-3d: ページは、入力と同じ形（配列なら伏せたページの配列、置き場所なら伏せた本体の置き場所。要約は入力のまま）。
   */
  readonly result: AuditRunResult<TPages extends readonly PageAuditResult[] ? readonly PageAuditResult[] : TPages>;
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
  /**
   * `report.html` の中身。改行は LF にして、UTF-8 で書く。MEM-4（DEF-266）: 断片を順に渡す形（`renderHtmlReportChunks`）も受け取り、断片を受け取るたびに
   * 書き足す（全部を 1 つの文字列にしない）。バイト列は、断片をつないだ文字列を書いたものと同じ。
   */
  readonly reportHtml?: string | Iterable<string>;
  /**
   * PL-R（plain UI の設計書 14 章、13 章の 13）: 報告の小さなまとめ（`report-summary.json`。`reportSummaryDocumentOf` で、報告と同じ表示用モデルから作ったもの）。
   * 成果物の JSON の書式（`reportSummaryBytesOf`）で書く。
   */
  readonly reportSummary?: ReportSummaryDocument;
  /**
   * ChatGPT 用バンドル（`beaksight-audit-bundle_YYYYMMDDHHmmss.zip`。画面のジョブは `beaksight-audit-bundle_<名前の部分>_YYYYMMDDHHmmss.zip`。
   * ChatGPT 用バンドルのファイル名の設計書 2.1、2.2。PRE42-BN）。
   */
  readonly bundle?: RunPresentationBundle;
}

/**
 * MEM-2（DEF-266）: 1 つずつ渡る部（部の数 `partCount` と、第 1 部から順に部の ZIP を作って渡す `parts`）。`writePresentation` は、部を受け取るたびに書き、
 * 書き終えてから次の部を受け取る（全部の部を同時に持たない）。
 */
export interface StreamedBundleParts {
  readonly partCount: number;
  readonly parts: AsyncIterable<Uint8Array>;
}

/** AUD-1d・MEM-2: バンドルの中身を、部の数と、部を順に渡すものにする（1 つの ZIP は 1 部）。 */
const bundlePartsOf = (bytes: Uint8Array | readonly Uint8Array[] | StreamedBundleParts): StreamedBundleParts => {
  if (bytes instanceof Uint8Array) {
    return { partCount: 1, parts: arrayParts([bytes]) };
  }
  return isStreamedBundleParts(bytes) ? bytes : { partCount: bytes.length, parts: arrayParts(bytes) };
};

const isStreamedBundleParts = (bytes: readonly Uint8Array[] | StreamedBundleParts): bytes is StreamedBundleParts => !Array.isArray(bytes);

async function* arrayParts(parts: readonly Uint8Array[]): AsyncGenerator<Uint8Array, void, undefined> {
  yield* parts;
}

/** `writePresentation` で書く ChatGPT 用バンドルの、中身と、名前を決める時刻。 */
export interface RunPresentationBundle {
  /**
   * ZIP の中身（バイト列のまま書く）。AUD-1d: 部に分けたバンドルは、部の順の配列（第 1 部から）。2 部以上なら、名前に `_part<番号>` が付く（`bundleFileName`）。
   * MEM-2: 部を 1 つずつ渡す形（`StreamedBundleParts`）も受け取る。
   */
  readonly bytes: Uint8Array | readonly Uint8Array[] | StreamedBundleParts;
  /**
   * その Run の最後の実行の終わりの時刻（`RunExecution.finishedAt`。ISO 8601）。名前は、これから `bundleFileName`
   * （`src/core/artifact-layout.ts`）で作る。
   */
  readonly lastExecutionFinishedAt: string;
  /**
   * PRE42-BN: 画面のジョブのプロファイルの名前（`beaksight-audit-bundle_<名前の部分>_YYYYMMDDHHmmss.zip`。名前の部分は `bundleFileNameLabelOf` で
   * 作る）。ファイル名だけに使い、バンドルの中身・`run.json`・`audit.json` には入れない。省略（CLI の実行）は、名前の部分のない今の形。
   */
  readonly profileName?: string | undefined;
}

/** artifact の入出力の失敗。`path` は、書けなかったファイルかディレクトリ。 */
export class ArtifactWriteError extends Error {
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`failed to write the artifact ${path}: ${safeErrorMessage(cause)}`, { cause });
    this.name = 'ArtifactWriteError';
    this.path = path;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 再開のための保存（チェックポイント）の型（中断した Run の再開の設計書 4.1〜4.3）
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
  /** 英語の技術的な詳細（URL を含めない。切り詰めない）。 */
  readonly reason: string;
}

/**
 * `readCheckpoint` の結果（深く凍結した値）。
 * - `ok` が真: `source` のファイルの保存を使えた。`pages` は、`state.completedPageIds` の順のページの保存。`failures` は、先に確かめて
 *   使えなかったファイルの理由（`state` を使えた場合は空。`prev` を使った場合は `state` の理由の1件）。
 * - `ok` が偽: どちらも使えなかった。`failures` は、`state`、`prev` の順の2件。
 */
export type CheckpointReadResult<TState, TPage> = CheckpointCollectedReadResult<TState, readonly TPage[]>;

/** MEM-3c: `readCheckpointCollected` の結果（`pages` は、ページを集める口の値）。 */
export type CheckpointCollectedReadResult<TState, TCollected> =
  | {
    readonly ok: true;
    readonly source: CheckpointReadSource;
    readonly state: TState;
    readonly pages: TCollected;
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

/** 保存の書き出しで使う、開いたファイル（`node:fs/promises` の `FileHandle` の一部）。 */
export interface CheckpointFileHandle {
  writeFile(data: string, options: { readonly encoding: 'utf8' }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * 保存の書き出しで使うファイルの操作（`node:fs/promises` の一部。書き出しの順を確かめるテストのための差し替え口）。
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
   * 保存の書き出しで使うファイルの操作。省略すると `node:fs/promises`。名前の変更（`rename`）は、最後の artifact の書き出しでも
   * 使う（名前の変更のやり直しを1か所にするため。`renameWithRetry`）。
   */
  readonly fileOperations?: CheckpointFileOperations;
  /** 実行している環境（`process.platform` の値）。省略すると `process.platform`。`win32` では、ディレクトリの `fsync` を行わない。 */
  readonly platform?: string;
  /** 名前の変更をやり直す前の待ち。省略すると `wait`（`src/core/deadline.ts`）。テストで、実際には待たずに確かめるための差し替え口。 */
  readonly wait?: typeof wait;
  /**
   * URL の名前で伏せる段（Task 25 の設計書 4.6。T25f）。真なら、Run のディレクトリに書く値の文字列の URL の秘密（userinfo と、秘密に見える query の値）を、
   * 書く前に伏せる（`redactUrlSecretsInValue`）。T44g（Task 44 の設計書 P4-1。案 2）: 省略すると真（公開の監査も同じ段を通る）。記録した要求の URL の値を
   * 伏せる段（`redactRecordedRequestUrlsInValue`）は、この指定によらず、いつも通す。真偽でなければ `TypeError`。
   */
  readonly urlSecretRedaction?: boolean;
  /**
   * T35c（Task 35 の設計書 3.6）: 承認したサービスの Origin（スクリプトで送るログインの監査の Run だけ）。`urlSecretRedaction` が真のときだけ使い、その
   * Origin の URL は、query のすべての値と path の値に見える区切りも伏せる（`redactUrlSecretsInValue` の `serviceOrigins`）。省略すると空（今のまま）。
   * 文字列の配列でなければ `TypeError`。
   */
  readonly serviceOrigins?: readonly string[];
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

/**
 * MEM-4（DEF-266）: 断片の並びの改行を LF にする（`toLf` を、つないだ文字列に当てたものと同じ）。断片の終わりの CR は、次の断片の頭の LF と組になりうるので、
 * 次の断片まで持ち越す。空の断片は返さない。
 */
function* lfChunks(chunks: Iterable<string>): Generator<string, void, undefined> {
  let carried = '';
  for (const chunk of chunks) {
    const text = carried + chunk;
    carried = text.endsWith('\r') ? '\r' : '';
    const converted = toLf(carried === '' ? text : text.slice(0, -1));
    if (converted.length > 0) {
      yield converted;
    }
  }
  if (carried !== '') {
    yield toLf(carried);
  }
}

// 書き出しの途中の一時ファイルの名前の決まり（`temporaryPathFor`、`isTemporaryFileName`）は、`src/core/temporary-file-name.ts` に移した
// （T24h-3）。

/** 名前の変更（`ArtifactWriter` の `#rename`。`renameWithRetry` を通したもの）。 */
type RenameFile = (oldPath: string, newPath: string) => Promise<void>;

/**
 * 同じディレクトリの一時ファイルに書いてから、rename する（`renameFile`。`renameWithRetry` を通したもの）。失敗した場合は、一時ファイルを
 * 消してから `ArtifactWriteError` を投げる。
 */
async function writeFileAtomically(path: string, data: string | Uint8Array, renameFile: RenameFile): Promise<void> {
  await writeThroughTemporaryFile(path, async (temporaryPath) => {
    if (typeof data === 'string') {
      await writeFile(temporaryPath, data, { encoding: 'utf8' });
    } else {
      await writeFile(temporaryPath, data);
    }
  }, renameFile);
}

/**
 * 同じディレクトリの一時ファイルに `writeTemporary` で書いてから、rename する（`writeFileAtomically` と、断片を書き足す `#writeChunksAtomically` の共通の
 * 書き方）。失敗した場合は、一時ファイルを消してから `ArtifactWriteError` を投げる。
 */
async function writeThroughTemporaryFile(
  path: string,
  writeTemporary: (temporaryPath: string) => Promise<void>,
  renameFile: RenameFile,
): Promise<void> {
  const temporaryPath = temporaryPathFor(path);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeTemporary(temporaryPath);
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

/** 保存の関数の引数の Run のディレクトリが、空でない文字列か。 */
function assertRunDirectory(runDirectory: unknown, method: string): asserts runDirectory is string {
  if (typeof runDirectory !== 'string' || runDirectory.length === 0) {
    throw new TypeError(`ArtifactWriter.${method} requires a non-empty run directory`);
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

/**
 * ジョブの成果物（Run のディレクトリの直下の JSON。`#writeJobDocument` が書く）のスキーマの名前。T32e: 書き込みの報告の 2 つを足した。T43c: 入口の
 * 確かめの成果物を足した。
 */
type JobDocumentSchemaName = Extract<
  ArtifactSchemaName,
  'discovery' | 'discovery-checkpoint' | 'read-evidence' | 'action-run' | 'action-evidence' | 'approval-summary' | 'entry-check'
>;

/**
 * 保存の値を、artifact の JSON の書式（`serializeArtifactJson`）の文字列にする。書く文字列を
 * JSON として読み戻した値を、スキーマ（`schema`）で検証し、合わなければ何も書かずに `ArtifactWriteError` を投げる（読み戻した値で
 * 確かめるので、書いたものは読むときにも同じ検証を通る）。
 */
async function checkpointJson(
  schema: 'checkpoint' | 'checkpoint-page' | JobDocumentSchemaName,
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
    return `the consistency check failed: ${safeErrorMessage(error)}`;
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
  failure: { source, path, reason },
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
async function readCheckpointSource<TState extends CheckpointStateShape, TPage extends CheckpointPageShape, TCollected>(
  runDirectory: string,
  source: CheckpointReadSource,
  checks: CheckpointConsistencyChecks<TState, TPage>,
  collector: CheckpointPageCollector<TPage, TCollected>,
): Promise<CheckpointSourceReading<{ readonly state: TState; readonly pages: TCollected }>> {
  const fail = (path: string, reason: string) => sourceFailure(source, path, reason);
  const stateReading = await readCheckpointStateSource(runDirectory, source, checks.checkState);
  if (!stateReading.ok) {
    return stateReading;
  }
  const state = stateReading.value;
  const statePath = checkpointArtifactRelativePath(CHECKPOINT_READ_SOURCE_FILES[source]);
  // MEM-3c: 確かめたページを、1 つずつ集める口に渡す（全部を配列で持つかは、集める側が決める）。このファイルが使えなければ、集めたものは捨てる。
  const pages = collector.begin();
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
    // REC-3: ディスクの形の `result` と `retryEvidence` を、メモリの形に戻す（戻せなければ、このファイルは使えない）。
    let page: TPage;
    try {
      page = decodeCheckpointPageRecord(asSchemaValidated<TPage>(pageReading.value));
    } catch (error) {
      return fail(pagePath, `cannot be decoded: ${errorMessageOrString(error)}`);
    }
    if (page.pageId !== pageId) {
      return fail(pagePath, `holds the page ID ${page.pageId} instead of ${pageId}`);
    }
    const pageProblem = consistencyProblem(() => checks.checkPage(page, state));
    if (pageProblem !== null) {
      return fail(pagePath, pageProblem);
    }
    await pages.add(page);
  }
  return { ok: true, value: { state, pages: pages.finish() } };
}

/**
 * MEM-3c（DEF-266）: 保存のページを 1 つずつ集める口（`readCheckpointCollected`）。状態の保存のファイルを読み始めるたびに `begin` で新しい集まりを作り、
 * 確かめたページを `completedPageIds` の順に `add` に渡す。そのファイルを使えたら `finish` の値を返し、使えなかったら、その集まりは捨てる。
 */
export interface CheckpointPageCollector<TPage, TCollected> {
  begin(): {
    add(page: TPage): Promise<void>;
    finish(): TCollected;
  };
}

/** ページを配列に集める（`readCheckpoint` の形）。 */
const arrayPageCollector = <TPage>(): CheckpointPageCollector<TPage, readonly TPage[]> => ({
  begin: () => {
    const pages: TPage[] = [];
    return {
      add: async (page) => {
        pages.push(page);
      },
      finish: () => pages,
    };
  },
});

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

/** 確かめた誤り（`errors`。空なら合う）の、スキーマに合わなかった artifact と、Run の理由。 */
function checkedArtifactOf(schema: ArtifactSchemaName, path: string, id: string, errors: readonly string[]): CheckedArtifact {
  if (errors.length === 0) {
    return { invalid: null, reason: null };
  }
  return {
    invalid: { path, schema, errors: [...errors] },
    reason: requiredArtifactInvalidReason(schema, id, errors),
  };
}

/** 確かめた結果の誤りの一覧（合えば空）。 */
const validationErrorsOf = (validation: LocatedSchemaValidationResult): readonly string[] => (validation.ok ? [] : validation.errors);

/** audit.json の項目の名前（書く順。`schemas/audit.schema.json` の `properties` の順）。 */
const AUDIT_ARTIFACT_FIELDS = Object.freeze({ schemaVersion: 'schemaVersion', run: 'run', pages: 'pages', findings: 'findings' } as const);

/**
 * REC-2: audit.json（目録。`audit-schema/2.0`）を、項目と Finding ごとの断片にしたもの（つなぐと、中身の全体の `serializeArtifactJson`。MEM-1）。
 * 持つのは、run.json のパス、ページの page.json のパスの一覧（ページの順）、Run だけの Finding（`runOnlyFindings`。T44f: ページの結果に入っていない
 * Finding。ページの Finding は page.json の中にある。読む側は `findingsOfAuditArtifact`）だけ。run とページの写しは持たない。
 */
const auditArtifactChunks = (
  pagePaths: readonly string[],
  runOnlyFindings: readonly Finding[],
): AsyncIterable<string> => artifactJsonObjectChunks([
  { name: AUDIT_ARTIFACT_FIELDS.schemaVersion, value: AUDIT_ARTIFACT_SCHEMA_VERSION },
  { name: AUDIT_ARTIFACT_FIELDS.run, value: RUN_ARTIFACT_FILE_NAMES.run },
  { name: AUDIT_ARTIFACT_FIELDS.pages, items: pagePaths },
  { name: AUDIT_ARTIFACT_FIELDS.findings, items: runOnlyFindings },
]);

/**
 * MEM-1: audit.json の、部分ごとに確かめた誤り（Run だけの Finding の順。audit.json の中の位置の文。audit.json をまるごと確かめた誤りと同じ）。REC-2: パスの
 * 項目は、書き手が決まった形で作るので、確かめるのは Finding だけ。
 */
const auditArtifactErrorsOf = (findingValidations: readonly LocatedSchemaValidationResult[]): readonly string[] =>
  findingValidations.flatMap((validation, index) =>
    validationErrorsOf(schemaValidationResultAt(validation, jsonPointerOf([AUDIT_ARTIFACT_FIELDS.findings, String(index)]))));

function assertWritableRun(result: AuditRunResult<RunPages>, options: WriteRunOptions): void {
  if (
    !isRecord(result)
    || !isRecord(result.run)
    || !(Array.isArray(result.pages) || isRunPageStoreValue(result.pages))
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
}

/**
 * ページの ID が、パスに使える形（`isPageId` と、安全なパスの区切り）で、ほかのページ（`pageIds`。見たページの ID を足していく）と重ならないことを確かめる
 * （MEM-3d: `writeRun` の 1 回目に、ページを 1 つずつ確かめる。書く前に例外を投げる）。
 */
function assertWritablePageId(page: unknown, pageIds: Set<string>): void {
  const pageId: unknown = isRecord(page) ? page['pageId'] : undefined;
  if (!isPageId(pageId) || !isPortableArtifactPathSegment(pageId)) {
    throw new RangeError(`page ID does not have the shape of a page ID: ${JSON.stringify(pageId)}`);
  }
  if (pageIds.has(pageId)) {
    throw new RangeError(`page ID is used by more than one page: ${pageId}`);
  }
  pageIds.add(pageId);
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
  /** T35c: 承認したサービスの Origin（`ArtifactWriterOptions.serviceOrigins`）。 */
  readonly #serviceOrigins: readonly string[];
  /**
   * この ArtifactWriter の名前の変更（差し替えたファイルの操作の `rename` を、待ち `#wait` で `renameWithRetry` に通したもの）。最後の
   * artifact の書き出し、保存の書き出し、`state.json` から `state.prev.json` への移し替えは、すべてこれを使う。
   */
  readonly #rename: RenameFile = async (oldPath, newPath) =>
    renameWithRetry((from, to) => this.#fileOperations.rename(from, to), this.#wait, oldPath, newPath);

  /**
   * `options` は省略できる（保存の書き出しのファイルの操作、実行している環境、名前の変更をやり直す前の待ち。テスト用の差し替え口）。
   * 最後の artifact の書き出し（`writeRun`、`writePresentation`）は、差し替えたファイルの操作のうち、名前の変更（`rename`）だけを使う
   * （名前の変更のやり直しを、保存と同じ1か所にするため。`renameWithRetry`）。ただし、`writePresentation` が古い ChatGPT 用バンドルを
   * 消すときは、差し替えたファイルの操作の `rm` を使う（消せなかった場合を確かめるテストのため）。
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
      // T44g（P4-1。案 2）: 既定は真（公開の監査も、名前で伏せる段を通る）。
      urlSecretRedaction = true,
      serviceOrigins = [],
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
    if (!Array.isArray(serviceOrigins) || !serviceOrigins.every((origin: unknown) => typeof origin === 'string')) {
      throw new TypeError('ArtifactWriter serviceOrigins must be strings');
    }
    this.#fileOperations = fileOperations;
    this.#platform = platform;
    this.#wait = retryWait;
    this.#urlSecretRedaction = urlSecretRedaction;
    this.#serviceOrigins = Object.freeze([...serviceOrigins]);
  }

  /**
   * Run のディレクトリに書く値（T25f）。記録した要求の URL の値を伏せ（T44g）、`urlSecretRedaction` が真（既定）なら、伏せ字の owner の
   * `redactUrlSecretsInValue` も通した写し。書き出しの関数は、値を受けたら最初にここを通す（伏せ字を通す場所を、この 1 か所にする。`writeRun` だけは、
   * 同じ段をページごとに行う `#outgoingPart` を通す。MEM-1）。
   */
  #outgoing<TValue>(value: TValue, requestUrlRedaction: RecordedRequestUrlRedactionOptions = {}): TValue {
    // T44g（P4-1。案 2）: 公開の監査と認証つきの Run の両方で、記録した要求の URL の値を伏せ（構造を知る段）、すべての文字列の URL の秘密に見える名前の値を
    // 伏せる（名前で伏せる段）。判定は、この前（伏せる前の値）で終わっている。T44R の C-1: 記録した要求の URL と同じ値を持つほかの文字列も伏せる（値で照らす段。
    // `matchValues`）。再開の保存の状態（巡回の待ち行列の URL）は、identity を変えないよう、値で照らす段を行わない（呼び出し側が偽を渡す）。T44R3 の M-2:
    // 再開の保存のページは、巡回が知っている URL（`keptUrls`）を照らさない（呼び出し側が渡す）。
    return this.#urlSecretsRedacted(redactRecordedRequestUrlsInValue(value, requestUrlRedaction));
  }

  /**
   * MEM-1（DEF-266）: `#outgoing` を部分ごとに行う形（`writeRun`）。記録した要求の URL は、1 回目に Run 全体から作った表（`table`）で伏せる。部分ごとの結果を
   * 元の位置に戻すと、Run 全体を `#outgoing` に通した結果と同じ。
   */
  #outgoingPart<TValue>(value: TValue, table: RecordedRequestUrlRedactionTable): TValue {
    return this.#urlSecretsRedacted(redactRecordedRequestUrlsByTable(value, table));
  }

  /** `urlSecretRedaction` が真（既定）なら、すべての文字列の URL の秘密に見える名前の値を伏せた写し（名前で伏せる段）。 */
  #urlSecretsRedacted<TValue>(value: TValue): TValue {
    return this.#urlSecretRedaction ? redactUrlSecretsInValue(value, { serviceOrigins: this.#serviceOrigins }) : value;
  }

  /**
   * MEM-1（DEF-266）: 断片（`chunks`）を順に書き足したファイルを、ほかの artifact と同じ書き方（同じディレクトリの一時ファイルに書いてから、名前を変える。
   * 失敗したら一時ファイルを消して `ArtifactWriteError`）で書く。一時ファイルは、差し替えたファイルの操作の `open`（`wx`）で開く。`fsync` は加えない。
   */
  async #writeChunksAtomically(path: string, chunks: Iterable<string> | AsyncIterable<string>): Promise<void> {
    await writeThroughTemporaryFile(path, async (temporaryPath) => {
      const handle = await this.#fileOperations.open(temporaryPath, 'wx');
      try {
        for await (const chunk of chunks) {
          await handle.writeFile(chunk, { encoding: 'utf8' });
        }
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
      await handle.close();
    }, this.#rename);
  }

  /**
   * 確定した Run を、Run のディレクトリに書く（設計書 6.1.1、6.1.2）。
   *
   * MEM-1（DEF-266）: Run 全体を 1 つの文字列や写しにせず、ページごとに伏せて、確かめて、書く。
   * 1. 伏せ字の 1 回目: ページの一覧を空にした Run と、各ページを順に見て、Run 全体の照らす表を作る（`recordedRequestUrlRedactionTableOf`。部分の写しは捨てる）。
   * 2. ページごとに、表で伏せ（`#outgoingPart`）、page.json を `validateArtifact` で確かめ、ページのファイル（page.json、visible-text.txt）を書く。
   *    visible-text.txt を書かないページで、前の回（中断した Run の、途中で止めた回）の visible-text.txt が残っていれば消す（中断した Run の再開の
   *    設計書 4.5）。伏せたページは、戻り値の Run のために持つ（1 つの写し）。
   * 3. run.json と、audit.json の最上位の Finding を確かめる。audit.json の誤りは、Finding の誤りを audit.json の中の位置に置いたもの
   *    （`schemaValidationResultAt`。まるごと確かめた誤りと同じ）。REC-2: audit.json は目録なので、run とページの誤りは run.json と page.json の誤りだけ。
   * 4. どれかがスキーマに合わない場合は、`statusInput.requiredArtifactsValid` を偽にし、Run の理由に `REQUIRED_ARTIFACT_INVALID`
   *    を加えて、Run Status を `deriveRunStatus` で導き直す。導き直した run.json を、もう一度だけ確かめる（書く中身の誤りを返すため）。
   * 5. run.json を書き、audit.json（目録: run.json のパス・ページの page.json のパス・Run だけの Finding）を断片に分けて書き足す（`auditArtifactChunks`。
   *    バイト列は 1 つの文字列の形と同じ）。スキーマに合わない JSON も書く。どのファイルも、一時ファイルと rename で書く。
   *
   * MEM-3d（DEF-266）: ページは、配列でも置き場所（`RunPageStore`）でもよい。`forEachRunPage` で 2 回だけなめる（1 回目は表とページの ID の確かめ、2 回目は
   * 伏せて書く）。戻り値の `pages` は、入力と同じ形（置き場所は、
   * 入力を写した置き場所に伏せた本体を `replace` で入れたもの。要約は入力のまま）。全ページの写しを同時に持たない（配列の入力では、今どおり伏せたページの配列）。
   *
   * 入力は変えない（伏せ字の段が写しを作る。入力の Run は Run Coordinator が深く凍結した値）。戻り値の `result` は深く凍結する。入出力の失敗は
   * `ArtifactWriteError` を投げる。Run Status の入力がない Run と、パスに使えない ID（`runId`、`pageId`）、重なった `pageId` は、書く前に例外を投げる。
   */
  async writeRun<TPages extends RunPages>(result: AuditRunResult<TPages>, options: WriteRunOptions): Promise<ArtifactWriteResult<TPages>> {
    assertWritableRun(result, options);
    // 1. 伏せ字の 1 回目（ページの一覧は、ページの位置が名前で伏せる段に効かない所で分ける）。MEM-3d: ページの ID の確かめも、ここで 1 ページずつ行う。
    const withoutPages: AuditRunResult = { ...result, pages: [] };
    const tableBuilder = createRecordedRequestUrlRedactionTableBuilder();
    tableBuilder.add(withoutPages);
    const pageIds = new Set<string>();
    await forEachRunPage(result.pages, (page) => {
      assertWritablePageId(page, pageIds);
      tableBuilder.add(page);
    });
    const table = tableBuilder.table();
    const source: AuditRunResult = this.#outgoingPart(withoutPages, table);
    const runDirectory = runArtifactDirectory(options.outputDirectory, source.run.runId);
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

    // 2. ページごとに、伏せて、確かめて、書く。MEM-3d: 伏せたページは、配列の入力なら配列に、置き場所の入力なら、入力を写した置き場所（圧縮した本体を
    //    共有する。入力は変えない）に `replace` で戻す。
    const storedPages = isRunPageStoreValue(result.pages) ? result.pages.ordered(Array.from({ length: result.pages.length }, (_unused, index) => index)) : null;
    const pages: PageAuditResult[] = [];
    const writtenPagePaths: string[] = [];
    const pageFindingIds = new Set<string>();
    const pageChecks: CheckedArtifact[] = [];
    await forEachRunPage(result.pages, async (input, index) => {
      const page = this.#outgoingPart(input, table);
      const pagePath = pageArtifactRelativePath(page.pageId, 'page');
      // REC-3: 伏せた後の値を、ディスクの形（`page-schema/2.0`）にして確かめて書く（メモリの形は変えない）。
      const record = encodePageRecord(page);
      const validation = await validateArtifact('page', record);
      pageChecks.push(checkedArtifactOf('page', pagePath, page.pageId, validationErrorsOf(validation)));
      await write(pagePath, serializeArtifactJson(record));
      // 可視テキストの選び方は、Run の再試行の記録だけを見る（導き直しで変わらない）。
      const visibleText = visibleTextOf(source.run, page);
      if (visibleText !== null) {
        await write(pageArtifactRelativePath(page.pageId, 'visibleText'), toLf(visibleText));
      } else {
        // 前の回（中断した Run の、途中で止めた回）の `visible-text.txt` が残っていれば消す（中断した Run の再開の設計書 4.5）。
        await removeFileIfPresent(artifactFilePath(runDirectory, pageArtifactRelativePath(page.pageId, 'visibleText')));
      }
      writtenPagePaths.push(pagePath);
      for (const { findingId } of page.findings) {
        pageFindingIds.add(findingId);
      }
      if (storedPages === null) {
        pages.push(page);
      } else {
        await storedPages.replace(index, page);
      }
    });

    // 3. run.json と audit.json の確かめ。
    const runOnlyFindings = runOnlyFindingsByPageFindingIds(source.findings, pageFindingIds);
    const findingValidations: LocatedSchemaValidationResult[] = [];
    for (const finding of runOnlyFindings) {
      findingValidations.push(await validateArtifact('finding', finding));
    }
    const checkRun = async (run: RunSummary): Promise<CheckedArtifact> =>
      checkedArtifactOf('run', RUN_ARTIFACT_FILE_NAMES.run, run.runId, validationErrorsOf(await validateArtifact('run', run)));
    const auditCheck = checkedArtifactOf('audit', RUN_ARTIFACT_FILE_NAMES.audit, source.run.runId, auditArtifactErrorsOf(findingValidations));
    let runCheck = await checkRun(source.run);
    const addedReasons = [...pageChecks, runCheck, auditCheck].flatMap(({ reason }) => (reason === null ? [] : [reason]));

    // 4. スキーマに合わない場合は、Run Status を `deriveRunStatus` で導き直す（ARCH05）。
    let final: AuditRunResult<RunPages> = { ...source, pages: storedPages ?? pages };
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
      final = { ...final, run, statusInput };
      // Run Status と理由の追加は、スキーマの検証の結果を変えないので、組み立て直しは1回で終わる。書く中身の検証の結果を返すため、
      // 組み立て直した run.json を、もう一度検証する。
      runCheck = await checkRun(run);
    }
    const invalidArtifacts = [...pageChecks, runCheck, auditCheck].flatMap(({ invalid }) => (invalid === null ? [] : [invalid]));

    // 5. run.json と audit.json（目録）を書く。
    await write(RUN_ARTIFACT_FILE_NAMES.run, serializeArtifactJson(final.run));
    await this.#writeChunksAtomically(
      artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.audit),
      auditArtifactChunks(writtenPagePaths, runOnlyFindings),
    );
    files.push(RUN_ARTIFACT_FILE_NAMES.audit);

    // 入力が配列なら `pages` は配列、置き場所なら置き場所（`ArtifactWriteResult` の型のとおり）。
    return deepFreeze({
      result: final,
      runDirectory,
      files,
      schemaValid: invalidArtifacts.length === 0,
      invalidArtifacts,
    }) as unknown as ArtifactWriteResult<TPages>;
  }

  /**
   * 表示用モデルから作ったファイル（`report.html`、報告の小さなまとめ `report-summary.json`（PL-R）、ChatGPT 用バンドル）を、`writeRun` が書いた Run の
   * ディレクトリに書く。
   * 与えられたものだけを、この順に、一時ファイルと rename で書く。書いたファイルの相対パスを返す。入出力の失敗は
   * `ArtifactWriteError` を投げる。
   * - バンドルの名前は、`bundle.lastExecutionFinishedAt`（最後の実行の終わりの時刻）と `bundle.profileName`（画面のジョブのプロファイルの名前。
   *   PRE42-BN）から `bundleFileName` で作る（ChatGPT 用バンドルのファイル名の設計書 2.1）。時刻が不正なら、何も書かずに `RangeError` を投げる。
   * - バンドルを書き終えた後に、Run のディレクトリの直下の、ほかのバンドルの名前（`isBundleFileName`。日時の違う形と、プロファイルの名前の
   *   違う形。LG-4: 日時のない前の形は見分けないので消さない）の
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
    // 書く前に、バンドルの名前を作る（時刻が不正なら、何も書かずに `RangeError`）。AUD-1d: 部に分けたバンドルは、部ごとの名前。
    const { bundle } = files;
    const bundleParts = bundle === undefined ? null : bundlePartsOf(bundle.bytes);
    if (bundleParts !== null && bundleParts.partCount === 0) {
      throw new RangeError('the bundle has no part');
    }
    const bundleNames = bundle === undefined || bundleParts === null
      ? []
      : Array.from({ length: bundleParts.partCount }, (_unused, index) =>
          bundleFileName(bundle.lastExecutionFinishedAt, bundle.profileName, { partNumber: index + 1, partCount: bundleParts.partCount }));
    const writtenFiles: string[] = [];
    if (files.reportHtml !== undefined) {
      const reportPath = artifactFilePath(written.runDirectory, RUN_ARTIFACT_FILE_NAMES.report);
      if (typeof files.reportHtml === 'string') {
        await writeFileAtomically(reportPath, toLf(files.reportHtml), this.#rename);
      } else {
        await this.#writeChunksAtomically(reportPath, lfChunks(files.reportHtml));
      }
      writtenFiles.push(RUN_ARTIFACT_FILE_NAMES.report);
    }
    if (files.reportSummary !== undefined) {
      await writeFileAtomically(
        artifactFilePath(written.runDirectory, REPORT_SUMMARY_ARTIFACT_FILE_NAME),
        reportSummaryBytesOf(files.reportSummary),
        this.#rename,
      );
      writtenFiles.push(REPORT_SUMMARY_ARTIFACT_FILE_NAME);
    }
    if (bundleParts !== null) {
      // MEM-2: 部を受け取るたびに書く（書き終えてから、次の部を受け取る）。渡った部の数が `partCount` と違えば、古いバンドルを消さずに `RangeError`。
      let partIndex = 0;
      for await (const bytes of bundleParts.parts) {
        const name = bundleNames[partIndex];
        if (name === undefined) {
          throw new RangeError(`the bundle has more parts than its part count ${String(bundleParts.partCount)}`);
        }
        await writeFileAtomically(artifactFilePath(written.runDirectory, name), bytes, this.#rename);
        writtenFiles.push(name);
        partIndex += 1;
      }
      if (partIndex !== bundleNames.length) {
        throw new RangeError(`the bundle has ${String(partIndex)} parts instead of its part count ${String(bundleParts.partCount)}`);
      }
      // AUD-1d: 全部の部を書き終えた後に、ほかのバンドル（前の回の部を含む）を消す。
      await this.#removeOtherBundles(written.runDirectory, new Set(bundleNames));
    }
    return Object.freeze(writtenFiles);
  }

  /**
   * Run のディレクトリの直下の、`keptNames` 以外のバンドルの名前（`isBundleFileName`。AUD-1d: 部の名前を含む）の普通のファイルを消す（ChatGPT 用バンドルの
   * ファイル名の設計書 2.2）。リンク（symlink、junction）と、ファイルでないものは消さない。消す前に、パスが Run のディレクトリの中に
   * あることを確かめる。消せなかった場合は `ArtifactWriteError` を投げる。
   */
  async #removeOtherBundles(runDirectory: string, keptNames: ReadonlySet<string>): Promise<void> {
    const root = resolve(runDirectory);
    for (const entry of await listRealDirectory(root, null)) {
      if (!entry.isFile() || keptNames.has(entry.name) || !isBundleFileName(entry.name)) {
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
   * DEF-200（設計書 `2026-11-04-beaksight-login-session-design.md` 3.4 の 9）: 操作さがしの続きのための状態の保存を、Run のディレクトリの
   * `checkpoint/discovery-state.json` に書く。書き方は `writeDiscovery` と同じ（URL の伏せ字の 1 か所 `#outgoing` を通してから `discovery-checkpoint` のスキーマで
   * 検証し、合わなければ何も書かずに `ArtifactWriteError`。一時ファイルに書いて名前を変える）。値は発見の成果物と同じ範囲の事実だけ（資格情報・token・入れた値を
   * 持たない）。
   */
  async writeDiscoveryCheckpoint<TDocument extends object>(runDirectory: string, document: TDocument): Promise<string> {
    return this.#writeJobDocument('writeDiscoveryCheckpoint', 'discovery-checkpoint', DISCOVERY_CHECKPOINT_RELATIVE_PATH, runDirectory, document);
  }

  /**
   * DEF-200: 操作さがしの続きのための状態の保存を読み、`discovery-checkpoint` のスキーマで確かめる（例外を投げない。ない・読めない・JSON でない・形が違うなら
   * `null`）。Run・ジョブ・認証の設定・ターゲット設定の一致は、呼ぶ側（`src/worker/discovery-run.ts`）が確かめる。結果は深く凍結する。
   */
  async readDiscoveryCheckpoint(runDirectory: string): Promise<unknown> {
    assertRunDirectory(runDirectory, 'readDiscoveryCheckpoint');
    let value: unknown;
    try {
      value = JSON.parse(await readFile(artifactFilePath(runDirectory, DISCOVERY_CHECKPOINT_RELATIVE_PATH), 'utf8')) as unknown;
    } catch {
      return null;
    }
    return (await validateArtifact('discovery-checkpoint', value)).ok ? deepFreeze(value) : null;
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
   * 入口の確かめのジョブの成果物（`src/control/entry-check.ts` の `EntryCheckDocument`。Task 43 の設計書 4.3。T43c）を、Run のディレクトリの
   * `entry-check.json`（`ENTRY_CHECK_ARTIFACT_FILE_NAME`）に書き、その相対パスを返す。書き方は `writeReadEvidence` と同じ（URL の伏せ字の 1 か所
   * `#outgoing` を通してから `entry-check` のスキーマで検証し、合わなければ何も書かずに `ArtifactWriteError`）。Run のディレクトリが空なら、何も
   * 書かずに `TypeError`。report は control を import しない（`control-boundary` (a)）ので、値の型は呼び出し側の型のまま受ける。
   */
  async writeEntryCheck<TDocument extends object>(runDirectory: string, document: TDocument): Promise<string> {
    return this.#writeJobDocument('writeEntryCheck', 'entry-check', ENTRY_CHECK_ARTIFACT_FILE_NAME, runDirectory, document);
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
   * 相対パスを返す。ページの ID がパスに使えない形なら、何も書かずに `RangeError` を投げる。T44R3 の M-2: `options.keptUrls`（巡回が知っている
   * URL）は、記録した要求の URL を値で照らす段で照らさない（続けて終えた Run と同じ結果にする）。
   */
  async writeCheckpointPage<TPage extends CheckpointPageShape>(
    runDirectory: string,
    page: TPage,
    options: { readonly keptUrls?: readonly string[] } = {},
  ): Promise<string> {
    assertRunDirectory(runDirectory, 'writeCheckpointPage');
    const pageId: unknown = isRecord(page) ? page.pageId : undefined;
    assertPathPageId(pageId);
    const relativePath = checkpointPageArtifactRelativePath(pageId);
    const path = artifactFilePath(runDirectory, relativePath);
    // REC-3: 伏せた後の値の `result` と `retryEvidence` を、ディスクの形にして書く（読むときに戻す。`readCheckpointSource`）。
    const record = encodeCheckpointPageRecord(this.#outgoing(page, { keptUrls: options.keptUrls }));
    await this.#writeFileDurably(path, await checkpointJson('checkpoint-page', path, record));
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
    const data = await checkpointJson('checkpoint', path, this.#outgoing(state, { matchValues: false }));
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
    return deepFreeze(await this.readCheckpointCollected(runDirectory, checks, arrayPageCollector<TPage>()));
  }

  /**
   * MEM-3c（DEF-266）: `readCheckpoint` と同じ確かめで保存を読み、ページの保存を 1 つずつ `collector` に渡す（全部を配列で持たない。再開の入力を、ページの
   * 置き場所に入れながら作るため）。`state.json` のページが使えなければ、その集まりを捨てて、`state.prev.json` から集め直す。結果の `state` と `failures` は
   * 深く凍結する。`pages` は `collector` の値のまま。
   */
  async readCheckpointCollected<TState extends CheckpointStateShape, TPage extends CheckpointPageShape, TCollected>(
    runDirectory: string,
    checks: CheckpointConsistencyChecks<TState, TPage>,
    collector: CheckpointPageCollector<TPage, TCollected>,
  ): Promise<CheckpointCollectedReadResult<TState, TCollected>> {
    assertRunDirectory(runDirectory, 'readCheckpoint');
    if (!isRecord(checks) || typeof checks.checkState !== 'function' || typeof checks.checkPage !== 'function') {
      throw new TypeError('ArtifactWriter.readCheckpoint requires checkState and checkPage functions');
    }
    if (!isRecord(collector) || typeof collector.begin !== 'function') {
      throw new TypeError('ArtifactWriter.readCheckpointCollected requires a page collector');
    }
    const read = await readFirstUsableCheckpointSource((source) => readCheckpointSource(runDirectory, source, checks, collector));
    return read.ok
      ? { ok: true, source: read.source, state: deepFreeze(read.value.state), pages: read.value.pages, failures: deepFreeze(read.failures) }
      : { ok: false, failures: deepFreeze(read.failures) };
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
   * 保存の書き出しと同時に呼ばない（書いている途中の一時ファイルを消すため）。再開の始めに、保存を書く前に呼ぶ。
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
  // 保存の書き出しの補助
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

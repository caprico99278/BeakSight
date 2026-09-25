/**
 * artifact の書き出しの唯一の owner（ARCH08。Task 14〜17 の設計書 6.1.1、6.1.2）。
 * - 配置（Run のディレクトリ、ファイルの名前、Run のディレクトリからの相対パス）は、`src/core/artifact-layout.ts` から取る
 *   （設計書 6.1.8。CC-023）。このファイルは、配置の名前やパスを組み立てない。
 * - JSON は、メモリの上で組み立て、`validateArtifact` で検証してから書く。スキーマに合わない場合は、Run Status を
 *   `deriveRunStatus` で導き直す（ARCH05。このファイルは Run Status を決めない）。スキーマに合わない JSON も、隠さずに書く。
 * - パスに使う ID（`runId`、`pageId`）は、ID の形（`isRunId`、`isPageId`。ID の owner は `src/core/ids.ts`。C16d）と、
 *   安全な区切り1つかどうか（`isPortableArtifactPathSegment`。CC-027）の両方で確かめる。形の違う値は、何も書かずに `RangeError`。
 * - ファイルは、同じディレクトリの一時ファイルに書いてから rename する。テキストは UTF-8（BOM なし）で、改行は LF にする。
 *   JSON の書式は、`serializeArtifactJson`（`./artifact-json.ts`）だけで組み立てる（CC-026）。
 * - 入出力の失敗は、`ArtifactWriteError` を投げる。
 * - HTML レポートと ChatGPT 用バンドルは、描画する側が作った中身を `writePresentation` で書く（書き出しの owner は、ここだけ）。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { evidenceOfType } from '../audit/rule-helpers.js';
import {
  RUN_ARTIFACT_FILE_NAMES,
  artifactFilePath,
  isPortableArtifactPathSegment,
  pageArtifactRelativePath,
  runArtifactDirectory,
} from '../core/artifact-layout.js';
import type {
  AuditRunResult,
  EvidenceId,
  IncompleteReason,
  PageAuditResult,
  RunRetryRecord,
  RunSummary,
  ViewportProfile,
} from '../core/contracts.js';
import { safeErrorMessage } from '../core/errors.js';
import { isRecord } from '../core/guards.js';
import { isPageId, isRunId } from '../core/ids.js';
import { deepFreeze } from '../core/immutable.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../core/limits.js';
import { validateArtifact, type ArtifactSchemaName } from '../core/schema-validator.js';
import { deriveRunStatus, requiredArtifactInvalidReason, type RunStatusInput } from '../core/status.js';
import { serializeArtifactJson } from './artifact-json.js';

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
  /** `beaksight-audit-bundle.zip` の中身（バイト列のまま書く）。 */
  readonly bundle?: Uint8Array;
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
// 書き出しの補助
// ---------------------------------------------------------------------------------------------------------------

/** 改行を LF にする（CRLF と CR を LF にする）。 */
const toLf = (text: string): string => text.replace(/\r\n?/gu, '\n');

/** 同じディレクトリの一時ファイルに書いてから、rename する。失敗した場合は、一時ファイルを消してから `ArtifactWriteError` を投げる。 */
async function writeFileAtomically(path: string, data: string | Uint8Array): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await mkdir(dirname(path), { recursive: true });
    if (typeof data === 'string') {
      await writeFile(temporaryPath, data, { encoding: 'utf8' });
    } else {
      await writeFile(temporaryPath, data);
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new ArtifactWriteError(path, error);
  }
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
  /**
   * 確定した Run を、Run のディレクトリに書く（設計書 6.1.1、6.1.2）。
   *
   * 1. run.json、audit.json、各ページの page.json をメモリの上で組み立て、`validateArtifact` で検証する。
   * 2. どれかがスキーマに合わない場合は、`statusInput.requiredArtifactsValid` を偽にし、Run の理由に `REQUIRED_ARTIFACT_INVALID`
   *    を加えて、Run Status を `deriveRunStatus` で導き直す。導き直した Run で、run.json と audit.json を組み立て直す（1回だけ）。
   * 3. ページのファイル（page.json、visible-text.txt）、run.json、audit.json の順に、一時ファイルと rename で書く。
   *    スキーマに合わない JSON も書く。
   *
   * 入力は変えない（写しから組み立てる）。戻り値の `result` は深く凍結する。入出力の失敗は `ArtifactWriteError` を投げる。
   * Run Status の入力がない Run と、パスに使えない ID（`runId`、`pageId`）、重なった `pageId` は、書く前に例外を投げる。
   */
  async writeRun(result: AuditRunResult, options: WriteRunOptions): Promise<ArtifactWriteResult> {
    assertWritableRun(result, options);
    const source: AuditRunResult = structuredClone(result);
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
      await writeFileAtomically(artifactFilePath(runDirectory, relativePath), data);
      files.push(relativePath);
    };
    for (const page of final.pages) {
      await write(pageArtifactRelativePath(page.pageId, 'page'), serializeArtifactJson(page));
      const visibleText = visibleTextOf(final.run, page);
      if (visibleText !== null) {
        await write(pageArtifactRelativePath(page.pageId, 'visibleText'), toLf(visibleText));
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
   * 表示用モデルから作ったファイル（`report.html`、`beaksight-audit-bundle.zip`）を、`writeRun` が書いた Run のディレクトリに書く。
   * 与えられたものだけを、この順に、一時ファイルと rename で書く。書いたファイルの相対パスを返す。入出力の失敗は
   * `ArtifactWriteError` を投げる。
   */
  async writePresentation(
    written: Pick<ArtifactWriteResult, 'runDirectory'>,
    files: RunPresentationFiles,
  ): Promise<readonly string[]> {
    if (!isRecord(written) || typeof written.runDirectory !== 'string' || written.runDirectory.length === 0) {
      throw new TypeError('ArtifactWriter.writePresentation requires the result of writeRun');
    }
    const writtenFiles: string[] = [];
    if (files.reportHtml !== undefined) {
      await writeFileAtomically(artifactFilePath(written.runDirectory, RUN_ARTIFACT_FILE_NAMES.report), toLf(files.reportHtml));
      writtenFiles.push(RUN_ARTIFACT_FILE_NAMES.report);
    }
    if (files.bundle !== undefined) {
      await writeFileAtomically(artifactFilePath(written.runDirectory, RUN_ARTIFACT_FILE_NAMES.bundle), files.bundle);
      writtenFiles.push(RUN_ARTIFACT_FILE_NAMES.bundle);
    }
    return Object.freeze(writtenFiles);
  }
}

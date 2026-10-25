/**
 * 監査のジョブの成果物の取り出し（Task 24 の設計書 4.5。T24f）。サーバだけで使う。成果物の Server Routes（`src/routes/artifacts/$jobId/$.tsx`。
 * GET だけ）と、ジョブの詳細の成果物の一覧が使う。
 * - 対象は、ジョブの行の Run のディレクトリ（出力先の中の相対）の中だけ。出力先は、ジョブのプロファイルのターゲット設定の `output.directory` を
 *   リポジトリの root で解決したもの（監査のワーカーと同じ解決。ワーカーは cwd をリポジトリの root にして `resolve` する）。
 * - 配るのは、許可の一覧のファイルだけ: `run.json`、`audit.json`、`report.html`、ChatGPT 用バンドルの ZIP（`isBundleFileName`）、`audit.json` が
 *   参照するもの（`audit.json` の `pages` のページの `page.json` と `visible-text.txt`、Evidence のスクリーンショットの相対パス）。
 *   `audit.json` は `run.json` の内容（`run`）を含むので、`run.json` の参照も `audit.json` から読む（`run.json` そのものは、相対パスを持たない）。
 *   スクリーンショットの相対パスは、そのページの `pages/<pageId>/` の下の、スクリーンショットのファイルの名前（`SCREENSHOT_FILE_NAMES`）のもの
 *   だけを受ける（`checkpoint/` など、ほかの場所を指す値は受けない）。それ以外は 404。
 *   T27f: 発見のジョブの `discovery.json` と、READ の確かめのジョブの `read-evidence.json` も、決まった名前の成果物として配る（ダウンロード）。
 *   画面のサーバは、その 2 つを読んで表示に使う（`readJobResultDocument`。スキーマとジョブの ID を確かめる）。
 * - 読み取りは、リンクをたどらない部品（`readContainedArtifactFile`。安全なパス、どの区切りもリンクでない、Run のディレクトリの中、大きさの上限、
 *   確かめと開くの間の入れ替え）だけで行う。上限は名前つきの定数（`ARTIFACT_FILE_MAX_BYTES`）。
 * - URL のパスは、要求の URL（URL の構文で正規化したもの）から、区切りごとに decode して読む（Router の解釈に頼らない）。decode できない区切り、
 *   decode して `/`・`\`・NUL を含む区切りは 404。
 * - `report.html` は、`<head>` の `<style>` の中身の SHA-256 を、内部の header で守りの部品に渡す（守りの部品が、script を動かさない CSP に
 *   入れる）。JSON と ZIP は `Content-Disposition: attachment`（ファイル名は ASCII の決まった形。PRE42-BN: プロファイルの名前の入ったバンドルの
 *   名前が ASCII の外の文字を含むときは、ASCII の代わりの名前と、UTF-8 の `filename*` の両方）。応答の守りの header（CSP、`nosniff` など）は、
 *   守りの部品（`launcher/request-guard.ts`）が付ける。
 * - T32g（Task 32 の設計書 4.1 の「親の確かめと画面の配布」）: 書き込みのジョブの報告の 4 つ（`action-report.html`、`action-evidence.json`、
 *   `approval-summary.json`、書き込みのバンドルの ZIP）を、親の確かめ（ジョブの行の `writeReportCheck`）が `VALID` のジョブだけ配る（それ以外の
 *   ジョブは、ファイルがあっても 404）。バンドルは、`action-run.json` の `finishedAt` から決まる名前（`actionBundleFileName`）の 1 つだけ。2 つの JSON
 *   は、配る前に成果物のスキーマと、文書のジョブの ID がこのジョブであることを確かめ直す（`JOB_RESULT_DOCUMENTS`）。style の hash の header を付ける
 *   HTML は、名前の閉じた一覧（`report.html`、`action-report.html`）だけ。`action-run.json` は配らない（画面は書き込みの結果の欄で示す）。
 * - T43c（Task 43 の設計書 4.3）: 入口の確かめのジョブの `entry-check.json` も、決まった名前の成果物として配り（ダウンロード）、画面のサーバが読んで
 *   ジョブの詳細と認証の設定の案に使う（`readJobResultDocument`。スキーマとジョブの ID を確かめる）。
 */
import { createServerOnlyFn } from '@tanstack/react-start';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { WriteReportCheck } from '../../../../src/control/job/job-records.js';
import type { AuditJobView } from '../../../../src/control/job/job-store.js';
import { getProfile } from '../../../../src/control/store/profile-store.js';
import { WORKER_JOB_ID_PATTERN } from '../../../../src/control/worker-protocol.js';
import {
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
  ACTION_RUN_ARTIFACT_FILE_NAME,
  APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
  DISCOVERY_ARTIFACT_FILE_NAME,
  ENTRY_CHECK_ARTIFACT_FILE_NAME,
  PAGES_ARTIFACT_DIRECTORY,
  READ_EVIDENCE_ARTIFACT_FILE_NAME,
  RUN_ARTIFACT_FILE_NAMES,
  SCREENSHOT_FILE_NAMES,
  actionBundleFileName,
  artifactFilePath,
  bundleFileNameTimestampOf,
  isActionBundleFileName,
  isBundleFileName,
  isPortableRelativeArtifactPath,
  pageArtifactRelativePath,
} from '../../../../src/core/artifact-layout.js';
import {
  DEFAULT_CONTAINED_ARTIFACT_FILE_MAX_BYTES,
  inspectRealArtifactEntry,
  readContainedArtifactFile,
} from '../../../../src/core/contained-artifact-file.js';
import { isRecord } from '../../../../src/core/guards.js';
import { isPageId } from '../../../../src/core/ids.js';
import { compareCodeUnits } from '../../../../src/core/text.js';
import { validateArtifact, type ArtifactSchemaName } from '../../../../src/core/schema-validator.js';
import { LOCAL_UI_AUDIT_TEXT } from '../../../../src/presentation/messages.js';
import { ARTIFACT_ROUTE_PREFIX, ARTIFACT_STYLE_HASH_RESPONSE_HEADER, artifactRoutePath } from '../security/artifact-route';
import { localUiAuditJobs } from './audit-jobs';
import { localUiRepositoryRoot, localUiStore } from './control-store';
import { loadTargetContext } from './target-config';

/**
 * 成果物の 1 つのファイルを読む大きさの上限（バイト）。値は、リンクをたどらない読み取りの部品の既定の上限（ChatGPT 用バンドルの ZIP を
 * 十分に超える値）と同じにする（同じ意味の値を 2 つ持たない）。`audit.json` を読んで参照を集めるときも、この上限で読む。
 */
export const ARTIFACT_FILE_MAX_BYTES = DEFAULT_CONTAINED_ARTIFACT_FILE_MAX_BYTES;

/** 成果物の応答の状態。 */
const ARTIFACT_STATUS = Object.freeze({ OK: 200, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405 } as const);

/** 配るファイルの拡張子と Content-Type（ここにない拡張子は配らない）。 */
const ARTIFACT_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
});

/** ダウンロード（`Content-Disposition: attachment`）にする拡張子（JSON と ZIP）。 */
const ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set(['.json', '.zip']);

/** ダウンロードのファイル名に使う文字（ASCII の英数字、`.`、`_`、`-`）の外の文字を置き換える文字。 */
const FILE_NAME_REPLACEMENT = '_';
const FILE_NAME_UNSAFE_CHARACTER = /[^A-Za-z0-9._-]/gu;

/**
 * PRE42-BN: `filename*` の値（RFC 5987 の UTF-8 の percent-encode）で、`encodeURIComponent` が符号化せずに残すが、attr-char の外の文字。
 * `!` は attr-char なので残す。
 */
const NON_ATTR_CHARACTERS = /['()*]/gu;

/** 1 文字（ASCII）を `%XX`（大文字の 16 進）にする。 */
const percentEncodedOf = (character: string): string => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * ダウンロードの `Content-Disposition` の値（PRE42-BN）。名前が ASCII の決まった文字（英数字、`.`、`_`、`-`）だけなら、今の
 * `attachment; filename="<名前>"` のまま。ほかの文字（日本語、空白、括弧など）を含む名前は、`filename` に ASCII の代わりの名前（ほかの文字を `_` に
 * したもの）を置き、`filename*` に UTF-8 の percent-encode の名前（RFC 6266、RFC 5987）を置く（`filename*` を読むブラウザは、元の名前で保存する）。
 * header の値は ASCII だけになる。
 */
const attachmentContentDispositionOf = (fileName: string): string => {
  const fallback = fileName.replace(FILE_NAME_UNSAFE_CHARACTER, FILE_NAME_REPLACEMENT);
  if (fallback === fileName) {
    return `attachment; filename="${fileName}"`;
  }
  const encoded = encodeURIComponent(fileName).replace(NON_ATTR_CHARACTERS, percentEncodedOf);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

/** スクリーンショットのファイルの名前（撮り方ごと）。 */
const SCREENSHOT_NAMES: ReadonlySet<string> = new Set(Object.values(SCREENSHOT_FILE_NAMES));

/**
 * ジョブの詳細に出す成果物の種類（表示の文言は画面の側で選ぶ）。T27f: 発見のジョブの `discovery.json` と、READ の確かめのジョブの
 * `read-evidence.json` を足した（どちらも、値・トークン・選択肢の label を持たない成果物。URL は書くときに伏せ字を通してある）。
 */
export const JOB_ARTIFACT_KINDS = Object.freeze([
  'REPORT',
  'RUN_JSON',
  'AUDIT_JSON',
  'BUNDLE',
  'DISCOVERY_JSON',
  'READ_EVIDENCE_JSON',
  // T32g: 書き込みのジョブの報告（親の確かめが `VALID` のジョブだけ）。
  'ACTION_REPORT',
  'ACTION_EVIDENCE_JSON',
  'APPROVAL_SUMMARY_JSON',
  'ACTION_BUNDLE',
  // T43c: 入口の確かめのジョブの成果物（読んだ事実と案だけ。欄の値は持たない。URL は書くときに伏せ字を通してある）。
  'ENTRY_CHECK_JSON',
] as const);
export type JobArtifactKind = (typeof JOB_ARTIFACT_KINDS)[number];

/** ジョブの詳細に出す成果物の 1 つ。 */
export interface JobArtifactView {
  readonly kind: JobArtifactKind;
  /** Run のディレクトリからの相対パス（区切りは `/`）。 */
  readonly relativePath: string;
  /** 成果物の Server Routes の URL のパス。 */
  readonly href: string;
}

/** 書き込みのジョブの報告の成果物の種類（T32g。親の確かめが `VALID` のジョブだけ配る）。 */
type WriteReportArtifactKind = 'ACTION_REPORT' | 'ACTION_EVIDENCE_JSON' | 'APPROVAL_SUMMARY_JSON' | 'ACTION_BUNDLE';

/** Run のディレクトリの直下の、決まった名前の成果物。 */
const FIXED_ARTIFACTS: readonly {
  readonly kind: Exclude<JobArtifactKind, 'BUNDLE' | WriteReportArtifactKind>;
  readonly relativePath: string;
}[] = Object.freeze([
  { kind: 'REPORT', relativePath: RUN_ARTIFACT_FILE_NAMES.report },
  { kind: 'RUN_JSON', relativePath: RUN_ARTIFACT_FILE_NAMES.run },
  { kind: 'AUDIT_JSON', relativePath: RUN_ARTIFACT_FILE_NAMES.audit },
  { kind: 'DISCOVERY_JSON', relativePath: DISCOVERY_ARTIFACT_FILE_NAME },
  { kind: 'READ_EVIDENCE_JSON', relativePath: READ_EVIDENCE_ARTIFACT_FILE_NAME },
  { kind: 'ENTRY_CHECK_JSON', relativePath: ENTRY_CHECK_ARTIFACT_FILE_NAME },
]);
const FIXED_ARTIFACT_PATHS: ReadonlySet<string> = new Set(FIXED_ARTIFACTS.map((artifact) => artifact.relativePath));

/** T32g: 書き込みのジョブの報告の、決まった名前の成果物（バンドルの ZIP は `action-run.json` から名前を決める）。 */
const WRITE_REPORT_ARTIFACTS: readonly { readonly kind: Exclude<WriteReportArtifactKind, 'ACTION_BUNDLE'>; readonly relativePath: string }[] =
  Object.freeze([
    { kind: 'ACTION_REPORT', relativePath: ACTION_REPORT_ARTIFACT_FILE_NAME },
    { kind: 'ACTION_EVIDENCE_JSON', relativePath: ACTION_EVIDENCE_ARTIFACT_FILE_NAME },
    { kind: 'APPROVAL_SUMMARY_JSON', relativePath: APPROVAL_SUMMARY_ARTIFACT_FILE_NAME },
  ]);
const WRITE_REPORT_ARTIFACT_PATHS: ReadonlySet<string> = new Set(WRITE_REPORT_ARTIFACTS.map((artifact) => artifact.relativePath));

/** T32g: 報告を配る親の確かめの結果（これ以外と、確かめていないジョブは配らない）。 */
const DISTRIBUTABLE_WRITE_REPORT_CHECK = 'VALID' satisfies WriteReportCheck;

/** T32g: ジョブの書き込みの報告を配るか（親の確かめが `VALID`）。 */
const isWriteReportDistributable = (job: AuditJobView): boolean => job.writeReportCheck === DISTRIBUTABLE_WRITE_REPORT_CHECK;

/**
 * T32g: style の hash の header を付ける HTML の名前の閉じた一覧（監査のレポートと書き込みの報告。どちらも `<head>` の `<style>` の 1 つだけで
 * 見た目を作る）。
 */
const STYLE_HASHED_HTML_FILE_NAMES: ReadonlySet<string> = new Set([RUN_ARTIFACT_FILE_NAMES.report, ACTION_REPORT_ARTIFACT_FILE_NAME]);

/**
 * ジョブの Run のディレクトリ（絶対パス）。Run がまだない、プロファイルがない、ターゲット設定を読めない場合は `null`。
 * 出力先は、今のプロファイルが指すターゲット設定の `output.directory`（設定が変わった後は、前の Run を見つけられないことがある。そのときは 404）。
 */
const runDirectoryOf = async (job: AuditJobView): Promise<string | null> => {
  if (job.runDirectory === null || !isPortableRelativeArtifactPath(job.runDirectory)) {
    return null;
  }
  const stored = getProfile(localUiStore(), job.profileId);
  if (stored === null) {
    return null;
  }
  const { context } = await loadTargetContext(stored.profile.targetConfigPath);
  if (context === undefined) {
    return null;
  }
  return artifactFilePath(resolve(localUiRepositoryRoot(), context.targetConfig.output.directory), job.runDirectory);
};

/** 相対パスが、リンクでないファイルとしてあるか（調べられないときは、ないとみなす）。 */
const isRealFile = async (runDirectory: string, relativePath: string): Promise<boolean> => {
  try {
    return (await inspectRealArtifactEntry(runDirectory, relativePath)).kind === 'FILE';
  } catch {
    return false;
  }
};

/**
 * バンドルの名前の、新しい順（名前の日時 `bundleFileNameTimestampOf` の新しい順。日時が同じなら、名前のコード単位の逆の順）。
 * PRE42-BN: 名前にプロファイルの名前が入るので、名前の順では新しい順にならない。
 */
const compareBundleNamesNewestFirst = (left: string, right: string): number =>
  compareCodeUnits(bundleFileNameTimestampOf(right) ?? '', bundleFileNameTimestampOf(left) ?? '') || compareCodeUnits(right, left);

/** Run のディレクトリの直下の ChatGPT 用バンドルの名前（日時の新しい順の最初。なければ `null`）。リンクは数えない。 */
const bundleNameOf = async (runDirectory: string): Promise<string | null> => {
  let names: readonly string[];
  try {
    names = (await readdir(runDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && isBundleFileName(entry.name))
      .map((entry) => entry.name)
      .sort(compareBundleNamesNewestFirst);
  } catch {
    return null;
  }
  for (const name of names) {
    if (await isRealFile(runDirectory, name)) {
      return name;
    }
  }
  return null;
};

/**
 * 画面のサーバが読んで表示に使う、または配る前に確かめ直す、ジョブの成果物の JSON（T27f。成果物の名前と、確かめるスキーマ）。T32g: 書き込みの
 * 報告の 2 つの JSON と、バンドルの名前を決める `action-run.json` を足した。
 */
const JOB_RESULT_DOCUMENTS = Object.freeze({
  discovery: { fileName: DISCOVERY_ARTIFACT_FILE_NAME, schema: 'discovery' },
  'read-evidence': { fileName: READ_EVIDENCE_ARTIFACT_FILE_NAME, schema: 'read-evidence' },
  'action-run': { fileName: ACTION_RUN_ARTIFACT_FILE_NAME, schema: 'action-run' },
  'action-evidence': { fileName: ACTION_EVIDENCE_ARTIFACT_FILE_NAME, schema: 'action-evidence' },
  'approval-summary': { fileName: APPROVAL_SUMMARY_ARTIFACT_FILE_NAME, schema: 'approval-summary' },
  // T43c: 入口の確かめの成果物（ジョブの詳細と、認証の設定の画面の案が読む）。
  'entry-check': { fileName: ENTRY_CHECK_ARTIFACT_FILE_NAME, schema: 'entry-check' },
  // AS-b: 監査の Run の `run.json`（ジョブの詳細が、監査の段の送信の扱いと通した数を読む）。ジョブの ID を持たないので、Run の ID がこのジョブの Run の ID で
  // あることを確かめる（`isDocumentOfJob`）。
  run: { fileName: RUN_ARTIFACT_FILE_NAMES.run, schema: 'run' },
} as const satisfies Record<string, { readonly fileName: string; readonly schema: ArtifactSchemaName }>);
export type JobResultDocumentKind = keyof typeof JOB_RESULT_DOCUMENTS;

/** 文書がこのジョブのものか（`run.json` は Run の ID、ほかはジョブの ID で確かめる）。 */
const isDocumentOfJob = (job: AuditJobView, kind: JobResultDocumentKind, value: Readonly<Record<string, unknown>>): boolean =>
  kind === 'run' ? job.runId !== null && value['runId'] === job.runId : value['jobId'] === job.jobId;

/** T32g: 配る前にスキーマとジョブの ID を確かめ直す、書き込みの報告の JSON（Run のディレクトリからの相対パス → 文書の種類）。 */
const CHECKED_WRITE_REPORT_DOCUMENTS: ReadonlyMap<string, JobResultDocumentKind> = new Map([
  [ACTION_EVIDENCE_ARTIFACT_FILE_NAME, 'action-evidence'],
  [APPROVAL_SUMMARY_ARTIFACT_FILE_NAME, 'approval-summary'],
]);

/**
 * 成果物の JSON のバイト列が、成果物のスキーマに合い、文書のジョブの ID がこのジョブであれば、その値（ほかは `null`。例外を投げない）。
 * 読んで表示に使うときと、配る前に確かめ直すとき（T32g）が共用する。
 */
const checkedJobDocumentOf = async (job: AuditJobView, bytes: Buffer, kind: JobResultDocumentKind): Promise<unknown> => {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    const valid = (await validateArtifact(JOB_RESULT_DOCUMENTS[kind].schema, value)).ok;
    return valid && isRecord(value) && isDocumentOfJob(job, kind, value) ? value : null;
  } catch {
    return null;
  }
};

/** Run のディレクトリの成果物の JSON を読み、確かめた値を返す（Run がない、読めない、確かめに通らなければ `null`。例外を投げない）。 */
const readCheckedJobDocument = async (job: AuditJobView, runDirectory: string, kind: JobResultDocumentKind): Promise<unknown> => {
  try {
    const reading = await readContainedArtifactFile(runDirectory, JOB_RESULT_DOCUMENTS[kind].fileName, { maxBytes: ARTIFACT_FILE_MAX_BYTES });
    return reading.ok ? await checkedJobDocumentOf(job, reading.bytes, kind) : null;
  } catch {
    return null;
  }
};

/**
 * T32g: 配る書き込みのバンドルの名前（報告を配るジョブで、`action-run.json` がスキーマとジョブの ID の確かめに通り、その `finishedAt` から決まる
 * 名前。親の確かめが照らしたバンドルと同じ名前）。配らないジョブ、読めない・確かめに通らないときは `null`。
 */
const actionBundleNameOf = async (job: AuditJobView, runDirectory: string): Promise<string | null> => {
  if (!isWriteReportDistributable(job)) {
    return null;
  }
  const actionRun = await readCheckedJobDocument(job, runDirectory, 'action-run');
  const finishedAt = isRecord(actionRun) ? actionRun['finishedAt'] : undefined;
  if (typeof finishedAt !== 'string') {
    return null;
  }
  try {
    return actionBundleFileName(finishedAt);
  } catch {
    return null;
  }
};

/**
 * ジョブの詳細に出す成果物の一覧（あるものだけ。`report.html`、`run.json`、`audit.json`、バンドルの順。T32g: 報告を配る書き込みのジョブは、その後に
 * 書き込みの報告の HTML・2 つの JSON・バンドル）。Server Function の中だけで使うので、サーバだけの関数にする（このファイルは成果物の route が
 * ブラウザ側から import するため。DEF-066、`local-ui-boundary` の (i)）。
 */
export const listJobArtifacts = createServerOnlyFn(async (job: AuditJobView): Promise<readonly JobArtifactView[]> => {
  const runDirectory = await runDirectoryOf(job);
  if (runDirectory === null) {
    return [];
  }
  const found: JobArtifactView[] = [];
  for (const artifact of FIXED_ARTIFACTS) {
    if (await isRealFile(runDirectory, artifact.relativePath)) {
      found.push({ ...artifact, href: artifactRoutePath(job.jobId, artifact.relativePath) });
    }
  }
  const bundle = await bundleNameOf(runDirectory);
  if (bundle !== null) {
    found.push({ kind: 'BUNDLE', relativePath: bundle, href: artifactRoutePath(job.jobId, bundle) });
  }
  if (isWriteReportDistributable(job)) {
    for (const artifact of WRITE_REPORT_ARTIFACTS) {
      if (await isRealFile(runDirectory, artifact.relativePath)) {
        found.push({ ...artifact, href: artifactRoutePath(job.jobId, artifact.relativePath) });
      }
    }
    const actionBundle = await actionBundleNameOf(job, runDirectory);
    if (actionBundle !== null && (await isRealFile(runDirectory, actionBundle))) {
      found.push({ kind: 'ACTION_BUNDLE', relativePath: actionBundle, href: artifactRoutePath(job.jobId, actionBundle) });
    }
  }
  return Object.freeze(found);
});

/**
 * ジョブの Run のディレクトリの成果物の JSON（発見の `discovery.json`、READ の確かめの `read-evidence.json`）を、リンクをたどらない読み取りの部品で
 * 読み、成果物のスキーマ（`validateArtifact`）と、文書のジョブの ID がこのジョブであることを確かめた値を返す（T27f。Task 27 の設計書 4.7）。
 * Run がない、読めない、JSON でない、スキーマに合わない、別のジョブの文書なら `null`（例外を投げない）。画面に出す前の確かめは、呼び出し側が
 * 項目を選んで写す（値・トークン・選択肢の label は、成果物の契約にない）。Server Function の中だけで使うので、サーバだけの関数にする。
 */
export const readJobResultDocument = createServerOnlyFn(async (job: AuditJobView, kind: JobResultDocumentKind): Promise<unknown> => {
  try {
    const runDirectory = await runDirectoryOf(job);
    return runDirectory === null ? null : await readCheckedJobDocument(job, runDirectory, kind);
  } catch {
    return null;
  }
});

/** スクリーンショットの相対パスとして受けるか（そのページの `pages/<pageId>/` の下の、スクリーンショットのファイルの名前のもの）。 */
const isScreenshotPathOfPage = (relativePath: unknown, pageId: string): relativePath is string =>
  isPortableRelativeArtifactPath(relativePath)
  && relativePath.startsWith(`${PAGES_ARTIFACT_DIRECTORY}/${pageId}/`)
  && SCREENSHOT_NAMES.has(relativePath.slice(relativePath.lastIndexOf('/') + 1));

/** `audit.json` が参照する相対パス（読めない、形が違う場合は空）。 */
const referencedPathsOf = async (runDirectory: string): Promise<ReadonlySet<string>> => {
  const reading = await readContainedArtifactFile(runDirectory, RUN_ARTIFACT_FILE_NAMES.audit, { maxBytes: ARTIFACT_FILE_MAX_BYTES });
  if (!reading.ok) {
    return new Set();
  }
  let document: unknown;
  try {
    document = JSON.parse(reading.bytes.toString('utf8')) as unknown;
  } catch {
    return new Set();
  }
  const pages = isRecord(document) && Array.isArray(document['pages']) ? (document['pages'] as unknown[]) : [];
  const paths = new Set<string>();
  for (const page of pages) {
    if (!isRecord(page) || !isPageId(page['pageId'])) {
      continue;
    }
    const pageId = page['pageId'];
    paths.add(pageArtifactRelativePath(pageId, 'page'));
    paths.add(pageArtifactRelativePath(pageId, 'visibleText'));
    const evidence = Array.isArray(page['evidence']) ? (page['evidence'] as unknown[]) : [];
    for (const record of evidence) {
      const payload = isRecord(record) && record['type'] === 'screenshot' && isRecord(record['payload']) ? record['payload'] : null;
      if (payload !== null && isScreenshotPathOfPage(payload['relativePath'], pageId)) {
        paths.add(payload['relativePath']);
      }
    }
  }
  return paths;
};

/**
 * 許可の一覧に入るか（決まった名前とバンドルは、そのまま。ほかは `audit.json` の参照）。T32g: 書き込みの報告の 3 つの決まった名前と、
 * `action-run.json` から決まる書き込みのバンドルの名前は、報告を配るジョブ（親の確かめが `VALID`）だけ。
 */
const isAllowedArtifactPath = async (job: AuditJobView, runDirectory: string, relativePath: string): Promise<boolean> => {
  if (WRITE_REPORT_ARTIFACT_PATHS.has(relativePath)) {
    return isWriteReportDistributable(job);
  }
  if (isActionBundleFileName(relativePath)) {
    return relativePath === (await actionBundleNameOf(job, runDirectory));
  }
  return FIXED_ARTIFACT_PATHS.has(relativePath)
    || isBundleFileName(relativePath)
    || (await referencedPathsOf(runDirectory)).has(relativePath);
};

/** 要求の URL のパスから、ジョブの ID と、Run のディレクトリからの相対パスを読む。読めなければ `null`。 */
const parseArtifactPath = (pathname: string): { readonly jobId: string; readonly relativePath: string } | null => {
  if (!pathname.startsWith(ARTIFACT_ROUTE_PREFIX)) {
    return null;
  }
  const segments: string[] = [];
  for (const raw of pathname.slice(ARTIFACT_ROUTE_PREFIX.length).split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (decoded.length === 0 || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
      return null;
    }
    segments.push(decoded);
  }
  const [jobId, ...rest] = segments;
  const relativePath = rest.join('/');
  if (jobId === undefined || !WORKER_JOB_ID_PATTERN.test(jobId) || !isPortableRelativeArtifactPath(relativePath)) {
    return null;
  }
  return { jobId, relativePath };
};

/** 404 の応答（本文は日本語の短い文。守りの header は守りの部品が付ける）。 */
const notFound = (): Response =>
  new Response(LOCAL_UI_AUDIT_TEXT.artifactNotFound, {
    status: ARTIFACT_STATUS.NOT_FOUND,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });

/** GET のほかのメソッドの応答（405。本文なし。成果物の Server Routes は読むだけ）。 */
export const rejectArtifactMethod = (): Response =>
  new Response(null, { status: ARTIFACT_STATUS.METHOD_NOT_ALLOWED, headers: { Allow: 'GET' } });

/** HTML（`report.html`・`action-report.html`）の `<head>` の最初の `<style>` の中身の SHA-256（base64）。なければ `null`。 */
const headStyleHashOf = (html: string): string | null => {
  const headEnd = html.indexOf('</head>');
  const match = headEnd < 0 ? null : /<style>([\s\S]*?)<\/style>/u.exec(html.slice(0, headEnd));
  return match?.[1] === undefined ? null : createHash('sha256').update(match[1], 'utf8').digest('base64');
};

/**
 * ダウンロードのファイル名（決まった形: `<Run のディレクトリ>-<相対パスの区切りを - にしたもの>`。バンドルは、その名前のまま。T32g: 書き込みの
 * バンドルも、その名前のまま）。PRE42-BN: ASCII の決まった文字の外の文字は、ここでは置き換えない（`attachmentContentDispositionOf` が、ASCII の代わりの
 * 名前と `filename*` を作る。プロファイルの名前の入ったバンドルの名前を、日本語のまま渡すため）。
 */
const attachmentFileNameOf = (runDirectory: string, relativePath: string): string =>
  (isBundleFileName(relativePath) || isActionBundleFileName(relativePath)
    ? relativePath
    : `${runDirectory.replaceAll('/', '-')}-${relativePath.replaceAll('/', '-')}`);

/**
 * 成果物の Server Routes の GET の応答を作る。許可の一覧の外、読めないもの（ない、リンク、Run のディレクトリの外、大きすぎる、入れ替わった）、
 * 配らない拡張子は 404。
 */
export const serveJobArtifact = async (request: Request): Promise<Response> => {
  const parsed = parseArtifactPath(new URL(request.url).pathname);
  if (parsed === null) {
    return notFound();
  }
  const contentType = ARTIFACT_CONTENT_TYPES[extname(parsed.relativePath).toLowerCase()];
  const job = localUiAuditJobs().getAuditJob(parsed.jobId);
  if (contentType === undefined || job === null || job.runDirectory === null) {
    return notFound();
  }
  const runDirectory = await runDirectoryOf(job);
  if (runDirectory === null || !(await isAllowedArtifactPath(job, runDirectory, parsed.relativePath))) {
    return notFound();
  }
  const reading = await readContainedArtifactFile(runDirectory, parsed.relativePath, { maxBytes: ARTIFACT_FILE_MAX_BYTES });
  if (!reading.ok) {
    return notFound();
  }
  // T32g: 書き込みの報告の JSON は、配る前にスキーマとジョブの ID を確かめ直す（親の確かめの後に入れ替わったものを配らない）。
  const checkedKind = CHECKED_WRITE_REPORT_DOCUMENTS.get(parsed.relativePath);
  if (checkedKind !== undefined && (await checkedJobDocumentOf(job, reading.bytes, checkedKind)) === null) {
    return notFound();
  }
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': String(reading.bytes.byteLength),
    'X-Content-Type-Options': 'nosniff',
  };
  const extension = extname(parsed.relativePath).toLowerCase();
  if (ATTACHMENT_EXTENSIONS.has(extension)) {
    headers['Content-Disposition'] = attachmentContentDispositionOf(attachmentFileNameOf(job.runDirectory, parsed.relativePath));
  }
  if (STYLE_HASHED_HTML_FILE_NAMES.has(parsed.relativePath)) {
    const styleHash = headStyleHashOf(reading.bytes.toString('utf8'));
    if (styleHash !== null) {
      headers[ARTIFACT_STYLE_HASH_RESPONSE_HEADER] = styleHash;
    }
  }
  return new Response(new Uint8Array(reading.bytes), { status: ARTIFACT_STATUS.OK, headers });
};

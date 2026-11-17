// U16d（Task 14〜17 の設計書 6.1.2、6.1.8、6.1.9。上位の設計書 第19章）: 表示用モデルから、ChatGPT 用バンドル
// （`beaksight-audit-bundle_YYYYMMDDHHmmss.zip`。名前はバンドルのファイル名の設計書 2.1）の中身を作る。ファイルは書かない。ZIP の中身とパスは決定論的で、生のレスポンス本文を含まず、
// `evidence-index.json` から一次証跡（`page.json` と JSON Pointer）へたどれる。
// R16f（設計書 6.1.11）: 各ページの `page.json` を ZIP に入れ、ZIP だけで一次証跡へたどれるようにする。AUD-1d: スクリーンショットの大きさの上限で外す決まりは
// やめ、集めた証拠を全部入れる（大きいときの部の分け方は `bundle-parts.test.ts`）。
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PAGES_ARTIFACT_DIRECTORY,
  PAGE_ARTIFACT_FILE_NAMES,
  RUN_ARTIFACT_FILE_NAMES,
  pageArtifactRelativePath,
} from '../../src/core/artifact-layout.js';
import { SEVERITIES, type AuditRunResult, type EvidenceId, type EvidenceRecord, type PageAuditResult } from '../../src/core/contracts.js';
import { createRunId } from '../../src/core/ids.js';
import { CHATGPT_BUNDLE_PART_SIZE_BYTES } from '../../src/core/limits.js';
import {
  AUDIT_SEND_POLICY_CATALOG,
  BEAKSIGHT_BLOCK_RELATION_CATALOG,
  FINDING_CATEGORY_CATALOG,
  RUN_EXECUTION_END_REASON_CATALOG,
  RUN_STATUS_CATALOG,
  SEVERITY_CATALOG,
  SEVERITY_GROUP_CATALOG,
  sortByDisplayOrder,
  type DisplaySpec,
} from '../../src/presentation/catalog.js';
import { AUDIT_SEND_TEXT, CHATGPT_BUNDLE_GUIDE_TEXT, HTML_REPORT_TEXT, RUN_SUMMARY_TEXT, listText } from '../../src/presentation/messages.js';
import {
  CHATGPT_BUNDLE_FILE_NAMES,
  CHATGPT_BUNDLE_OMISSION_REASONS,
  CHATGPT_BUNDLE_SCHEMA_VERSION,
  createChatGptBundle,
  createChatGptBundleParts,
  type ReadArtifactFile,
} from '../../src/report/chatgpt-bundle.js';
import { buildReportViewModel, type ReportViewModel, type ScreenshotView } from '../../src/report/view-model.js';
import {
  FIXTURE_ORIGIN,
  JAPANESE_TEXT,
  PAGE_1,
  auditRun,
  beaksightBlockAuditRun,
  dom,
  edgeCaseAuditRun,
  executionsDisplaySample,
  finding,
  fixtureUrl,
  idOf,
  loadDisplaySample,
  metadata,
  page,
  screenshot,
} from '../helpers/audit-run-fixture.js';

// ---------------------------------------------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------------------------------------------

const encoder = new TextEncoder();
const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const sha256Of = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** スクリーンショットの見本のバイト列（PNG の署名と、パスごとに異なる中身）。 */
const pngBytes = (path: string): Uint8Array => Uint8Array.from([...PNG_SIGNATURE, ...encoder.encode(path)]);

/** 見本の run.json の中身。バンドルが組み立て直していないことを確かめるため、字下げのない形にしておく。 */
const runJsonBytes = (result: AuditRunResult): Uint8Array => encoder.encode(JSON.stringify(result.run));

/** 書き出し済みの Run のディレクトリの代わり（Run のディレクトリからの相対パス → 中身）。読んだパスを記録する。 */
interface ArtifactStore {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly calls: string[];
  readonly readArtifactFile: ReadArtifactFile;
}

/**
 * @param missing 置かないファイル（読むと `null`）。
 * @param replacements 中身を差し替えるファイル（スクリーンショットの大きさを変える、など。R16f）。
 */
function artifactStore(
  result: AuditRunResult,
  missing: readonly string[] = [],
  replacements: ReadonlyMap<string, Uint8Array> = new Map(),
): ArtifactStore {
  const files = new Map<string, Uint8Array>();
  files.set(RUN_ARTIFACT_FILE_NAMES.run, runJsonBytes(result));
  for (const value of result.pages) {
    files.set(pageArtifactRelativePath(value.pageId, 'page'), encoder.encode(`${JSON.stringify(value, null, 2)}\n`));
    files.set(pageArtifactRelativePath(value.pageId, 'visibleText'), encoder.encode(JSON.stringify(value.evidence)));
    for (const evidence of value.evidence) {
      if (evidence.type === 'screenshot') {
        files.set(evidence.payload.relativePath, pngBytes(evidence.payload.relativePath));
      }
    }
  }
  for (const [path, bytes] of replacements) {
    files.set(path, bytes);
  }
  for (const path of missing) {
    files.delete(path);
  }
  const calls: string[] = [];
  return {
    files,
    calls,
    readArtifactFile: async (relativePath) => {
      calls.push(relativePath);
      const bytes = files.get(relativePath);
      return bytes === undefined ? null : Uint8Array.from(bytes);
    },
  };
}

async function bundleOf(result: AuditRunResult, store: ArtifactStore = artifactStore(result)): Promise<Uint8Array> {
  return createChatGptBundle(buildReportViewModel(result), result, store.readArtifactFile);
}

const jsonOf = (entries: Readonly<Record<string, Uint8Array>>, path: string): unknown => {
  const bytes = entries[path];
  if (bytes === undefined) {
    throw new Error(`missing bundle entry ${path}`);
  }
  return JSON.parse(decodeUtf8(bytes)) as unknown;
};

interface Manifest {
  readonly bundleSchemaVersion: string;
  readonly runId: string;
  readonly runStatus: string;
  readonly toolVersion: string;
  readonly generatedAt: string | null;
  readonly partCount: number;
  readonly partSizeBytes: number | null;
  readonly files: readonly { readonly path: string; readonly byteLength: number; readonly sha256: string; readonly part: number }[];
  readonly omittedFiles: readonly { readonly path: string; readonly evidenceIds: readonly string[]; readonly reason: string }[];
  readonly missingArtifactCount: number | null;
}

/** JSON Pointer（RFC 6901）で、値をたどる。 */
function resolvePointer(document: unknown, pointer: string): unknown {
  expect(pointer.startsWith('/')).toBe(true);
  let current: unknown = document;
  for (const token of pointer.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    expect(current !== null && typeof current === 'object', `pointer ${pointer}`).toBe(true);
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

/** ページの中の、指定したスクリーンショットの Evidence の相対パスを変えた Run（見本の加工）。 */
function withScreenshotPath(result: AuditRunResult, evidenceId: EvidenceId, relativePath: string): AuditRunResult {
  const pages = result.pages.map((value): PageAuditResult => ({
    ...value,
    evidence: value.evidence.map((record): EvidenceRecord =>
      record.type === 'screenshot' && record.evidenceId === evidenceId ? { ...record, payload: { ...record.payload, relativePath } } : record,
    ),
  }));
  return { ...result, pages };
}

const screenshotPathOf = (result: AuditRunResult, evidenceId: EvidenceId): string => {
  for (const value of result.pages) {
    for (const record of value.evidence) {
      if (record.type === 'screenshot' && record.evidenceId === evidenceId) {
        return record.payload.relativePath;
      }
    }
  }
  throw new Error(`missing screenshot ${evidenceId}`);
};

/** `edgeCaseAuditRun()` のスクリーンショットの ID（見本の順の番号）。 */
const EDGE_SHOTS = Object.freeze({
  retryDesktopViewport: 'EV-SHOT-000002' as EvidenceId,
  desktopViewport: 'EV-SHOT-000004' as EvidenceId,
  desktopFullPage: 'EV-SHOT-000005' as EvidenceId,
  mobileViewport: 'EV-SHOT-000007' as EvidenceId,
  secondDesktopViewport: 'EV-SHOT-000011' as EvidenceId,
});

/** `edgeCaseAuditRun()` の再試行の前の試行の画像（指摘が直接参照しない）。 */
const EDGE_RETRY_SHOT_PATH = 'pages/PAGE-000001/retry-1/desktop/viewport.png';

/**
 * `edgeCaseAuditRun()` の、バンドルに入れるスクリーンショット（パスの順）。AUD-1b・1d: 集めた画像を全部（最終の試行の見える範囲とページ全体、再試行の前の試行の
 * 画像）入れる。
 */
const EDGE_RELATED_SCREENSHOT_PATHS = [
  'pages/PAGE-000001/desktop/full-page.png',
  'pages/PAGE-000001/desktop/viewport.png',
  'pages/PAGE-000001/mobile/viewport.png',
  EDGE_RETRY_SHOT_PATH,
  'pages/PAGE-000002/desktop/viewport.png',
];

/**
 * ZIP の中で、各ページの `page.json` の前に並ぶ、第 1 部のファイル（ZIP の中の順）。REC-4: 第 1 部は入口だけ（指摘の一覧はページごとのファイルに分け、その場所の
 * 一覧 `finding-files.json` を置く。Evidence の索引は置かない）。
 */
const LEADING_FILE_PATHS = [
  CHATGPT_BUNDLE_FILE_NAMES.manifest,
  CHATGPT_BUNDLE_FILE_NAMES.readme,
  RUN_ARTIFACT_FILE_NAMES.run,
  CHATGPT_BUNDLE_FILE_NAMES.summary,
  CHATGPT_BUNDLE_FILE_NAMES.findingsByRule,
  CHATGPT_BUNDLE_FILE_NAMES.findingFiles,
  CHATGPT_BUNDLE_FILE_NAMES.findingGroups,
  CHATGPT_BUNDLE_FILE_NAMES.pages,
  CHATGPT_BUNDLE_FILE_NAMES.links,
];

/** REC-4: `edgeCaseAuditRun()` の指摘のファイル（ページの順、ページに属さない指摘のファイルは最後）。 */
const EDGE_FINDING_FILE_PATHS = ['pages/PAGE-000001/findings.json', 'pages/PAGE-000002/findings.json', 'run-findings.json'];

/** ZIP の中の JSON のうち、`page.json` を除くもの（ZIP の中の順）。 */
const JSON_FILE_PATHS = [...LEADING_FILE_PATHS.filter((path) => path !== CHATGPT_BUNDLE_FILE_NAMES.readme), ...EDGE_FINDING_FILE_PATHS];

/** `edgeCaseAuditRun()` の各ページの `page.json` のパス（パスの順。R16f）。 */
const EDGE_PAGE_JSON_PATHS = ['pages/PAGE-000001/page.json', 'pages/PAGE-000002/page.json'];

/** AUD-1b: `edgeCaseAuditRun()` の各ページの `visible-text.txt` のパス（パスの順）。 */
const EDGE_VISIBLE_TEXT_PATHS = ['pages/PAGE-000001/visible-text.txt', 'pages/PAGE-000002/visible-text.txt'];

/** ZIP の中で、スクリーンショットの前に並ぶファイル（第 1 部の JSON・README、指摘のファイル、各ページの `page.json` と `visible-text.txt`）の数。 */
const EDGE_FILES_BEFORE_SCREENSHOTS = LEADING_FILE_PATHS.length + EDGE_FINDING_FILE_PATHS.length + EDGE_PAGE_JSON_PATHS.length + EDGE_VISIBLE_TEXT_PATHS.length;

/** REC-4: 指摘のファイルの 1 件（`main`・`excluded`・`initialOnly` の指摘）。 */
interface FindingFile {
  readonly pageId: string | null;
  readonly main: readonly BundledFindingEntry[];
  readonly excluded: readonly BundledFindingEntry[];
  readonly initialOnly: readonly BundledFindingEntry[];
}

interface BundledFindingEntry {
  readonly finding: { readonly findingId: string; readonly message: string; readonly severity: string };
  readonly evidence: readonly { readonly evidenceId: string; readonly path: string | null; readonly pointer: string | null }[];
  readonly screenshotPaths: readonly string[];
  readonly groupId: string | null;
  readonly beaksightBlockRelation?: { readonly relation: string } | null;
}

/** ZIP の中の、すべての指摘のファイルの本体の指摘（ファイルの順）。 */
const mainEntriesOf = (entries: Readonly<Record<string, Uint8Array>>, paths: readonly string[] = EDGE_FINDING_FILE_PATHS): readonly BundledFindingEntry[] =>
  paths.flatMap((path) => (jsonOf(entries, path) as FindingFile).main);

/**
 * `edgeCaseAuditRun()` のスクリーンショットを、入れる順（AUD-1b: `VIEWPORT` の指摘に関係するもの、`VIEWPORT` の残り、`FULL_PAGE` の指摘に関係するもの。それぞれ
 * パスの順）に並べたもの。AUD-1d: 再試行の前の試行の画像は最後。
 */
const EDGE_RELATED_SCREENSHOT_READ_ORDER = [
  'pages/PAGE-000001/desktop/viewport.png',
  'pages/PAGE-000002/desktop/viewport.png',
  'pages/PAGE-000001/mobile/viewport.png',
  'pages/PAGE-000001/desktop/full-page.png',
  EDGE_RETRY_SHOT_PATH,
];

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------------------------------------------

describe('createChatGptBundle', () => {
  it('puts the entrance first, then the Finding files, page.json, the visible text and the related screenshots in path order', async () => {
    const result = edgeCaseAuditRun();
    // 見本の前提: バンドルに入れるスクリーンショットのパスは、5 つ全部である（AUD-1d: 再試行の前の試行の画像も入れる）。
    expect([
      screenshotPathOf(result, EDGE_SHOTS.desktopViewport),
      screenshotPathOf(result, EDGE_SHOTS.desktopFullPage),
      screenshotPathOf(result, EDGE_SHOTS.mobileViewport),
      screenshotPathOf(result, EDGE_SHOTS.retryDesktopViewport),
      screenshotPathOf(result, EDGE_SHOTS.secondDesktopViewport),
    ].sort()).toEqual(EDGE_RELATED_SCREENSHOT_PATHS);

    const entries = unzipSync(await bundleOf(result));

    expect(Object.keys(entries)).toEqual([
      'manifest.json',
      // T44i: 読み方の案内と、Rule ごとの要約。
      'README.md',
      'run.json',
      'summary.json',
      'findings-by-rule.json',
      // REC-4: 指摘のファイルの場所の一覧。
      'finding-files.json',
      // AUD-9c: 同じ UI の繰り返しの候補群。
      'finding-groups.json',
      'pages.json',
      // AUD-6b: リンクごとの確かめの状態。
      'links.json',
      // REC-4: ページごとの指摘のファイルと、ページに属さない指摘のファイル。
      ...EDGE_FINDING_FILE_PATHS,
      // R16f: 各ページの page.json（パスの順）を、スクリーンショットの前に入れる。
      ...EDGE_PAGE_JSON_PATHS,
      // AUD-1b: 各ページの見える文字（パスの順）を、page.json の次に入れる。
      ...EDGE_VISIBLE_TEXT_PATHS,
      ...EDGE_RELATED_SCREENSHOT_PATHS,
    ]);
    expect(LEADING_FILE_PATHS).toEqual(Object.keys(entries).slice(0, LEADING_FILE_PATHS.length));
    expect(EDGE_PAGE_JSON_PATHS).toEqual(result.pages.map((value) => pageArtifactRelativePath(value.pageId, 'page')).sort());
  });

  it('lists every file but the manifest itself with its byte length and SHA-256, and the facts of the Run', async () => {
    const result = edgeCaseAuditRun();
    const entries = unzipSync(await bundleOf(result));
    const manifest = jsonOf(entries, 'manifest.json') as Manifest;

    // T44i: README.md と findings-by-rule.json を足したので、版を 1.1 にした。BN-d: 本体と外した指摘を分けたので、1.2 にした。AUD-1: 入れる画像と欠けの一覧を
    // 変えたので、1.3 にした。AUD-6a・6c・9c: 検証の状態・Web Vitals の観測の範囲・候補群を足したので、1.4 にした。
    // AUD-2d: 確かめ直しの印と、初めの表示だけの指摘のファイルを足したので、1.6 にした。AUD-3c: 固定の要素の重なりの区分と数を足したので、1.7 にした。
    // AUD-3d: 指摘の画像の参照と対象の領域を足したので、1.8 にした。AUD-3d の続き: 確かめ直しの画像と axe の矩形の理由を足したので、1.9 にした。
    // AUD-4b・4c・4d: 名前の文脈・フォーカスの確かめ・特殊な scheme のリンクを足したので、1.10 にした。
    // AUD-7・6b・6c: 応答の区分・リンクの確かめ（links.json）・性能の観測の範囲を足したので、1.11 にした。
    // COV-4 の区切り 3: 操作で開いた状態の数（summary.json の openedStates）と読み方を足したので、1.12 にした。
    // 設計者の判断 2026-11-11: 同じ口のくり返しをまとめた記録の数（summary.json の repeatedReads）と読み方を足したので、1.13 にした。
    // REC-4: 第 1 部を入口だけにし、指摘をページごとのファイルに分け、Evidence の索引を外したので、2.0 にした。
    expect(CHATGPT_BUNDLE_SCHEMA_VERSION).toBe('chatgpt-bundle/2.0');
    expect(manifest).toEqual({
      bundleSchemaVersion: 'chatgpt-bundle/2.0',
      runId: result.run.runId,
      runStatus: result.run.runStatus,
      toolVersion: result.run.toolVersion,
      generatedAt: result.run.finishedAt,
      // AUD-1d: 1 つの ZIP にまとめた形（部は 1 つ、部の大きさの目安なし）。
      partCount: 1,
      partSizeBytes: null,
      files: Object.keys(entries)
        .filter((path) => path !== 'manifest.json')
        .map((path) => {
          const bytes = entries[path] ?? new Uint8Array();
          return { path, byteLength: bytes.byteLength, sha256: sha256Of(bytes), part: 1 };
        }),
      // AUD-1d: 集めた証拠は全部入れるので、ファイルがそろっていれば欠けはない。
      omittedFiles: [],
      // AUD-1c: 発表の前の確かめをしていない表示用モデルは、欠けの数が null。
      missingArtifactCount: null,
    });
    expect(manifest.files.map(({ path }) => path)).toEqual(Object.keys(entries).slice(1));
    expect(manifest.files.map(({ path }) => path)).toEqual(expect.arrayContaining(EDGE_PAGE_JSON_PATHS));
    // T44i: 目録は、読み方の案内と Rule ごとの要約も、大きさと SHA-256 つきで持つ。
    expect(manifest.files.map(({ path }) => path).slice(0, 4)).toEqual(['README.md', 'run.json', 'summary.json', 'findings-by-rule.json']);
    expect(result.run.runStatus).toBe('PARTIAL');
  });

  it('puts the run.json read from the Run directory as is, without building it again', async () => {
    const result = edgeCaseAuditRun();
    const store = artifactStore(result);
    const entries = unzipSync(await bundleOf(result, store));

    expect(entries['run.json']).toEqual(store.files.get('run.json'));
    expect(entries['run.json']).toEqual(runJsonBytes(result));
  });

  it('reads and puts every screenshot of the final attempt, the visible text and page.json, with their bytes as read', async () => {
    const result = edgeCaseAuditRun();
    const store = artifactStore(result);
    const entries = unzipSync(await bundleOf(result, store));

    // R16f・AUD-1b: run.json、各ページの page.json（パスの順）、visible-text.txt（パスの順）、スクリーンショット（入れる順）を、1回ずつ読む（指摘のファイルは
    // バンドルが組み立てるので読まない）。
    expect(store.calls).toEqual(['run.json', ...EDGE_PAGE_JSON_PATHS, ...EDGE_VISIBLE_TEXT_PATHS, ...EDGE_RELATED_SCREENSHOT_READ_ORDER]);
    expect([...EDGE_RELATED_SCREENSHOT_READ_ORDER].sort()).toEqual(EDGE_RELATED_SCREENSHOT_PATHS);
    for (const path of EDGE_RELATED_SCREENSHOT_PATHS) {
      expect(entries[path], path).toEqual(pngBytes(path));
    }
    // AUD-1b: 関係のない Mobile の画像も入る。AUD-1d: 直接の参照のない再試行の前の試行の画像も入る。
    expect(Object.keys(entries)).toContain(screenshotPathOf(result, EDGE_SHOTS.mobileViewport));
    expect(Object.keys(entries)).toContain(screenshotPathOf(result, EDGE_SHOTS.retryDesktopViewport));
    // R16f: page.json は入れる。AUD-1b: visible-text.txt も、読んだバイト列のまま入れる。
    expect(Object.keys(entries).filter((path) => path.endsWith(PAGE_ARTIFACT_FILE_NAMES.page))).toEqual(EDGE_PAGE_JSON_PATHS);
    expect(Object.keys(entries).filter((path) => path.endsWith(PAGE_ARTIFACT_FILE_NAMES.visibleText))).toEqual(EDGE_VISIBLE_TEXT_PATHS);
    for (const path of EDGE_VISIBLE_TEXT_PATHS) {
      expect(entries[path], path).toEqual(store.files.get(path));
    }
  });

  it('puts a screenshot of an attempt before a retry when a Finding refers to it directly', async () => {
    const base = edgeCaseAuditRun();
    const result: AuditRunResult = {
      ...base,
      findings: [...base.findings, finding(7, 'INFO', 'LAYOUT', PAGE_1, [EDGE_SHOTS.retryDesktopViewport])],
    };
    const retryPath = screenshotPathOf(result, EDGE_SHOTS.retryDesktopViewport);
    expect(retryPath).toBe('pages/PAGE-000001/retry-1/desktop/viewport.png');

    const entries = unzipSync(await bundleOf(result));

    expect(Object.keys(entries).slice(EDGE_FILES_BEFORE_SCREENSHOTS)).toEqual(EDGE_RELATED_SCREENSHOT_PATHS);
    expect(EDGE_RELATED_SCREENSHOT_PATHS).toContain(retryPath);
    expect(entries[retryPath]).toEqual(pngBytes(retryPath));
  });

  it('makes the same bytes from the same input, whatever the clock and the time zone are', async () => {
    const result = edgeCaseAuditRun();
    const originalTimeZone = process.env.TZ;
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      process.env.TZ = 'UTC';
      vi.setSystemTime(new Date('2031-05-06T07:08:10.000Z'));
      const first = await bundleOf(result);
      process.env.TZ = 'Asia/Tokyo';
      vi.setSystemTime(new Date('2044-11-12T13:14:16.000Z'));
      const second = await bundleOf(result);

      expect(second).toEqual(first);
    } finally {
      if (originalTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTimeZone;
      }
    }
    // 入力（表示用モデルの元の Run）は変えない。
    expect(result).toEqual(edgeCaseAuditRun());
  });

  it('leaves out a screenshot that cannot be read and records it in the manifest', async () => {
    const result = edgeCaseAuditRun();
    const missing = 'pages/PAGE-000001/desktop/viewport.png';
    const entries = unzipSync(await bundleOf(result, artifactStore(result, [missing])));
    const manifest = jsonOf(entries, 'manifest.json') as Manifest;

    expect(Object.keys(entries)).not.toContain(missing);
    expect(Object.keys(entries).slice(EDGE_FILES_BEFORE_SCREENSHOTS)).toEqual(EDGE_RELATED_SCREENSHOT_PATHS.filter((path) => path !== missing));
    // AUD-1a: 欠けの一覧は、証拠 ID を持つ。AUD-1d: 欠けは、ファイルがないものだけ。
    expect(manifest.omittedFiles).toEqual([{ path: missing, evidenceIds: [EDGE_SHOTS.desktopViewport], reason: CHATGPT_BUNDLE_OMISSION_REASONS[0] }]);
    expect(CHATGPT_BUNDLE_OMISSION_REASONS).toEqual(['ARTIFACT_FILE_NOT_FOUND']);
    expect(manifest.files.map(({ path }) => path)).not.toContain(missing);
    // Run Status は変えない（バンドルの不完全さの記録だけ）。
    expect(manifest.runStatus).toBe(result.run.runStatus);
  });

  it('leaves out run.json when it cannot be read and records it in the manifest', async () => {
    const result = edgeCaseAuditRun();
    const missingScreenshot = 'pages/PAGE-000002/desktop/viewport.png';
    const entries = unzipSync(await bundleOf(result, artifactStore(result, ['run.json', missingScreenshot])));
    const manifest = jsonOf(entries, 'manifest.json') as Manifest;

    expect(Object.keys(entries)).not.toContain('run.json');
    expect(Object.keys(entries).slice(0, LEADING_FILE_PATHS.length - 1)).toEqual(LEADING_FILE_PATHS.filter((path) => path !== 'run.json'));
    // 入れられなかったファイルは、ZIP の中の順（run.json、スクリーンショットのパスの順）に並ぶ。
    expect(manifest.omittedFiles).toEqual([
      { path: 'run.json', evidenceIds: [], reason: 'ARTIFACT_FILE_NOT_FOUND' },
      { path: missingScreenshot, evidenceIds: [EDGE_SHOTS.secondDesktopViewport], reason: 'ARTIFACT_FILE_NOT_FOUND' },
    ]);
  });

  // REC-4: Evidence の索引（evidence-index.json）は置かない。指摘の `evidence` の `path` と `pointer` で、ZIP の中の page.json の記録をたどれる。
  it('lets each Evidence of a Finding be traced to its record in page.json by path and pointer, within the ZIP alone', async () => {
    const result = edgeCaseAuditRun();
    const entries = unzipSync(await bundleOf(result));
    const references = mainEntriesOf(entries).flatMap((entry) => entry.evidence);

    expect(Object.keys(entries)).not.toContain('evidence-index.json');
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference.path === null ? null : Object.keys(entries).includes(reference.path)).toBe(true);
      const record = resolvePointer(jsonOf(entries, reference.path ?? ''), reference.pointer ?? '') as EvidenceRecord;
      expect(record.evidenceId).toBe(reference.evidenceId);
    }
  });

  it('puts each Finding of a page in the file of the page, with the location of each Evidence, the paths of its related screenshots and its group', async () => {
    const base = edgeCaseAuditRun();
    const unknownEvidence = 'EV-DOM-999999' as EvidenceId;
    const result: AuditRunResult = {
      ...base,
      findings: [...base.findings, finding(7, 'INFO', 'CROSS_PAGE', null, [unknownEvidence])],
    };
    const model = buildReportViewModel(result);
    const entries = unzipSync(await bundleOf(result));
    const groupOf = new Map(model.findingGroups.flatMap((group) => group.findingIds.map((id) => [id, group.groupId] as const)));
    const entryOf = (view: (typeof model.mainFindings)[number]): unknown => ({
      finding: view.finding,
      evidence: view.evidence.map(({ evidenceId, location }) => ({ evidenceId, path: location?.path ?? null, pointer: location?.pointer ?? null })),
      // AUD-1a: ZIP に入れたスクリーンショットだけ（この見本では、Finding に関係づくものは全部入る）。
      screenshotPaths: view.screenshots.map((shot) => shot.relativePath),
      verification: view.verification,
      imageRegion: view.imageRegion,
      groupId: groupOf.get(view.finding.findingId) ?? null,
    });

    expect(jsonOf(entries, 'pages/PAGE-000001/findings.json')).toEqual(JSON.parse(JSON.stringify({
      pageId: PAGE_1,
      main: model.mainFindings.filter((view) => view.finding.pageId === PAGE_1).map(entryOf),
      excluded: model.excludedFindings.filter((view) => view.finding.pageId === PAGE_1).map((view) => ({
        ...(entryOf(view) as object),
        beaksightBlockRelation: view.beaksightBlockRelation,
        safetyBlockPhaseCounts: view.safetyBlockPhaseCounts,
      })),
      initialOnly: [],
    })));
    // どのページにもない Evidence は、場所が null。ページに属さない指摘は、run-findings.json にある。
    expect((jsonOf(entries, 'run-findings.json') as FindingFile).main.at(-1)?.evidence).toEqual([{ evidenceId: unknownEvidence, path: null, pointer: null }]);
    expect(mainEntriesOf(entries)[0]?.screenshotPaths).toEqual(['pages/PAGE-000001/desktop/viewport.png', 'pages/PAGE-000001/desktop/full-page.png']);
  });

  it('puts the summary and the pages of the view model, referring to Findings and Evidence by ID and without the reason descriptions', async () => {
    const result = edgeCaseAuditRun();
    const model = buildReportViewModel(result);
    const entries = unzipSync(await bundleOf(result));
    const withoutDescription = (reasons: readonly { readonly code: string; readonly detail: string | null }[]): unknown =>
      reasons.map(({ code, detail }) => ({ code, detail }));

    // CCX-19: 実行の記録の最後の実行の終わりの時刻（`lastFinishedAt`）は、`summary.json` に入れない（形を変えない）。
    const { lastFinishedAt: _lastFinishedAt, ...executions } = model.summary.executions;
    expect(jsonOf(entries, 'summary.json')).toEqual(
      JSON.parse(JSON.stringify({ ...model.summary, executions, incompleteReasons: withoutDescription(model.summary.incompleteReasons) })),
    );
    // AUD-1a: スクリーンショットは ZIP に入れたものだけ（`missing` は書かない）。AUD-1d: この見本では、全部入る。
    // REC-4: 指摘の ID の一覧（ページと画像の）は持たない（指摘はページごとの指摘のファイルにある）。
    const bundled = (shots: readonly ScreenshotView[]): unknown => shots.map(({ missing: _missing, relatedFindingIds: _related, ...shot }) => shot);
    expect(jsonOf(entries, 'pages.json')).toEqual(
      JSON.parse(JSON.stringify(model.pages.map(({
        findings: _findings, mainFindingIds: _main, excludedFindingIds: _excluded, initialOnlyFindingIds: _initialOnly, retryAttempts, incompleteReasons, viewports, screenshots, ...rest
      }) => ({
        ...rest,
        incompleteReasons: withoutDescription(incompleteReasons),
        viewports: viewports.map((viewport) => ({ ...viewport, incompleteReasons: withoutDescription(viewport.incompleteReasons) })),
        screenshots: bundled(screenshots),
        retryAttempts: retryAttempts.map(({ evidence, screenshots: attemptScreenshots, ...attempt }) => ({
          ...attempt,
          evidenceIds: evidence.map((location) => location.evidenceId),
          screenshots: bundled(attemptScreenshots),
        })),
      })))),
    );
  });

  // L6（サイトへの負荷の制御の設計書 4.5）・R6（中断した Run の再開の設計書 4.8 の「表示」）・R9（同 2026-10-08 の追補）・AS-b（監査の段の送信の扱いの設計書 2.3）:
  // `summary.json` の `load`・`executions`・`auditSend` は、表示用モデルの要約の同じ欄と同じ値である。バンドルの側で組み立て直したり、数え直したりしない。
  // 終わり方はコードのまま入れる（日本語のラベルは入れない）。CCX-19（CC-048）: 表示用モデルの最後の実行の終わりの時刻（`lastFinishedAt`）は入れない。
  // AS-c（fix round 1 も）: 持たない Run は、ほかの Origin へ通した数・WebSocket の接続の数を 0 と読み、その知らせは出さない。
  const auditSend = { policy: 'PASS_EXCEPT_DELETE', passedRequests: 5, passedRequestsByMethod: { POST: 4, PUT: 1 } } as const;
  const stoppedBySignal: AuditRunResult['run']['executions'] = [
    ...executionsDisplaySample(),
    { startedAt: '2026-10-03T00:00:00.000Z', finishedAt: '2026-10-03T00:10:00.000Z', endReason: 'STOPPED_BY_SIGNAL' },
  ];
  it.each<readonly [string, (run: AuditRunResult['run']) => AuditRunResult['run'], 'load' | 'executions' | 'auditSend', object]>([
    ['site load (the copy of run.json load)', (run) => ({ ...run, load: loadDisplaySample() }), 'load', loadDisplaySample()],
    [
      'executions (the counts and the copy of run.json executions)',
      (run) => ({ ...run, executions: executionsDisplaySample() }),
      'executions',
      { count: 3, resumeCount: 2, lastEndReason: 'COMPLETED', items: executionsDisplaySample() },
    ],
    [
      'executions of a Run that was not interrupted',
      (run) => ({ ...run, executions: auditRun().run.executions }),
      'executions',
      { count: 1, resumeCount: 0, lastEndReason: 'COMPLETED' },
    ],
    ['end reason of the last execution', (run) => ({ ...run, executions: stoppedBySignal }), 'executions', { lastEndReason: 'STOPPED_BY_SIGNAL' }],
    [
      'audit send policy and passed counts',
      (run) => ({ ...run, safety: { ...run.safety, auditSend } }),
      'auditSend',
      {
        ...auditSend,
        prominent: true,
        passedOtherOriginRequests: 0,
        passedWebSockets: 0,
        passedWebSocketsOutsideGuard: 0,
        passedDangerousWebSockets: 0,
        webSocketCaution: false,
      },
    ],
  ])('puts the same %s as the view model summary in summary.json, without Japanese labels', async (_label, patch, key, expected) => {
    const base = edgeCaseAuditRun();
    const result: AuditRunResult = { ...base, run: patch(base.run) };
    const model = buildReportViewModel(result);
    const entries = unzipSync(await bundleOf(result));
    const summary = jsonOf(entries, 'summary.json') as Readonly<Record<string, unknown>>;

    expect(summary[key]).toMatchObject(expected);
    const { lastFinishedAt: _lastFinishedAt, ...fromModel } = model.summary[key] as unknown as Readonly<Record<string, unknown>>;
    expect(summary[key]).toEqual(JSON.parse(JSON.stringify(fromModel)));
    const text = decodeUtf8(entries['summary.json'] ?? new Uint8Array());
    for (const spec of Object.values<DisplaySpec>(RUN_EXECUTION_END_REASON_CATALOG)) {
      expect(text).not.toContain(spec.label);
    }
  });

  // T44f（Task 44 の設計書 P3-1）: artifact の JSON の書式は字下げなし。
  it('writes JSON without indentation and with a trailing LF, keeping codes and leaving out Japanese labels', async () => {
    const result = edgeCaseAuditRun();
    const model = buildReportViewModel(result);
    const entries = unzipSync(await bundleOf(result));
    const descriptions = model.summary.incompleteReasons.map((reason) => reason.description);
    expect(descriptions.length).toBeGreaterThan(0);

    for (const path of JSON_FILE_PATHS.filter((value) => value !== 'run.json')) {
      const text = decodeUtf8(entries[path] ?? new Uint8Array());
      expect(text, path).toBe(`${JSON.stringify(JSON.parse(text))}\n`);
      expect(text.includes('\r'), path).toBe(false);
      for (const description of descriptions) {
        expect(text.includes(description), path).toBe(false);
      }
      expect(text.includes('"description"'), path).toBe(false);
    }
    expect(decodeUtf8(entries['summary.json'] ?? new Uint8Array())).toContain('"REQUIRED_WORK_NOT_VERIFIED"');
  });

  it('puts Japanese paths and values in UTF-8, marking the file names as UTF-8', async () => {
    const japanesePath = `${PAGES_ARTIFACT_DIRECTORY}/PAGE-000002/desktop/画面の写し.png`;
    const result = withScreenshotPath(edgeCaseAuditRun(), EDGE_SHOTS.secondDesktopViewport, japanesePath);
    const store = artifactStore(result);
    const zip = await bundleOf(result, store);
    const entries = unzipSync(zip);

    expect(Object.keys(entries)).toContain(japanesePath);
    expect(entries[japanesePath]).toEqual(pngBytes(japanesePath));
    const manifest = jsonOf(entries, 'manifest.json') as Manifest;
    expect(manifest.files.map(({ path }) => path)).toContain(japanesePath);
    const findings = mainEntriesOf(entries);
    expect(findings[0]?.finding.message).toBe(result.findings[0]?.message);
    expect(findings[0]?.finding.message).toContain('日本語の指摘');
    expect((jsonOf(entries, 'pages/PAGE-000002/findings.json') as FindingFile).main[0]?.screenshotPaths).toEqual([japanesePath]);

    // ZIP の中のファイル名は UTF-8 のバイト列で、ローカルヘッダと中央ディレクトリの両方で UTF-8 の印（bit 11）が立つ。
    const nameBytes = encoder.encode(japanesePath);
    const positions: number[] = [];
    for (let index = 0; index + nameBytes.length <= zip.length; index += 1) {
      if (nameBytes.every((byte, offset) => zip[index + offset] === byte)) {
        positions.push(index);
      }
    }
    const signatureAt = (offset: number): number =>
      (zip[offset] ?? 0) | ((zip[offset + 1] ?? 0) << 8) | ((zip[offset + 2] ?? 0) << 16) | ((zip[offset + 3] ?? 0) << 24);
    const flagsAt = (offset: number): number => (zip[offset] ?? 0) | ((zip[offset + 1] ?? 0) << 8);
    const local = positions.find((position) => signatureAt(position - 30) === 0x04034b50);
    const central = positions.find((position) => signatureAt(position - 46) === 0x02014b50);
    expect(local).toBeDefined();
    expect(central).toBeDefined();
    expect(flagsAt((local ?? 0) - 30 + 6) & 0x800).toBe(0x800);
    expect(flagsAt((central ?? 0) - 46 + 8) & 0x800).toBe(0x800);
  });

  // R16f（設計書 6.1.11）: page.json を、そのまま入れるようにしたので、page.json の中の Evidence の文字列（可視テキストと、
  // robots.txt の Evidence の上限付きの本文）は、ZIP の page.json の中にある。このテストは、それ以外のところに本文が入らないことを
  // 確かめる: バンドルが組み立てる JSON（manifest、summary、findings、pages、evidence-index）に本文がなく、visible-text.txt を
  // 読まず、page.json は読んだバイト列のまま（本文の写しを増やさない）で、本文があるのは page.json だけである。
  it('does not put a raw response body anywhere in the ZIP but in the page.json put as read', async () => {
    const rawBody = 'RAW-RESPONSE-BODY-2f9c1e';
    const desktopDom = dom(2, PAGE_1, 'desktop', `${JAPANESE_TEXT} ${rawBody}`);
    const shot = screenshot(3, PAGE_1, 'desktop', 'VIEWPORT');
    const evidence = [metadata(1, PAGE_1, { text: `User-agent: *\n# ${rawBody}` }), desktopDom, shot];
    const result = auditRun({
      pages: [page(PAGE_1, '/', 'AUDITED', evidence, [finding(1, 'WARN', 'LAYOUT', PAGE_1, [idOf(desktopDom)])])],
    });
    // 見本の前提: 本文らしい値は、page.json と visible-text.txt（Run のディレクトリ）にはある。
    const store = artifactStore(result);
    const pageJsonPath = 'pages/PAGE-000001/page.json';
    const visibleTextPath = 'pages/PAGE-000001/visible-text.txt';
    expect(decodeUtf8(store.files.get(pageJsonPath) ?? new Uint8Array())).toContain(rawBody);
    expect(decodeUtf8(store.files.get(visibleTextPath) ?? new Uint8Array())).toContain(rawBody);

    const entries = unzipSync(await bundleOf(result, store));

    expect(Object.keys(entries)).toContain(shot.payload.relativePath);
    // AUD-1b: visible-text.txt（一次の証拠）も、page.json と同じく読んだバイト列のまま入れる。本文があるのは、この 2 つだけ。
    expect(store.calls).toContain(visibleTextPath);
    expect(entries[pageJsonPath]).toEqual(store.files.get(pageJsonPath));
    expect(entries[visibleTextPath]).toEqual(store.files.get(visibleTextPath));
    for (const [path, bytes] of Object.entries(entries)) {
      expect(new TextDecoder('utf-8').decode(bytes).includes(rawBody), path).toBe(path === pageJsonPath || path === visibleTextPath);
    }
  });

  it.each([
    ['a parent segment', 'pages/PAGE-000002/../../secret.png'],
    ['a POSIX absolute path', '/pages/PAGE-000002/desktop/viewport.png'],
    ['a Windows drive path', 'C:/pages/PAGE-000002/desktop/viewport.png'],
    ['a backslash separator', 'pages\\PAGE-000002\\desktop\\viewport.png'],
    ['an empty segment', 'pages/PAGE-000002//viewport.png'],
    ['a current-directory segment', 'pages/./PAGE-000002/desktop/viewport.png'],
    ['a NUL character', 'pages/PAGE-000002/desktop/viewport\0.png'],
    ['a trailing separator', 'pages/PAGE-000002/desktop/'],
    ['a path outside the pages directory', 'manifest.json'],
    ['a URL', 'file:///pages/PAGE-000002/desktop/viewport.png'],
  ])('rejects a related screenshot path with %s', async (_name, relativePath) => {
    const result = withScreenshotPath(edgeCaseAuditRun(), EDGE_SHOTS.secondDesktopViewport, relativePath);
    const store = artifactStore(result);

    await expect(bundleOf(result, store)).rejects.toThrow(RangeError);
    // 不正なパスでは、ファイルを読まない。
    expect(store.calls).not.toContain(relativePath);
  });

  // C16c（CC-027）: 相対パスの規則は `isPortableRelativeArtifactPath` に従い、すべての制御文字（C1 を含む）を拒む。
  it.each([
    ['a tab', 'pages/PAGE-000002/desktop/view\tport.png'],
    ['a DEL character', 'pages/PAGE-000002/desktop/view\u007fport.png'],
    ['a C1 control character', 'pages/PAGE-000002/desktop/view\u0085port.png'],
  ])('rejects a related screenshot path with %s (every control character)', async (_name, relativePath) => {
    const result = withScreenshotPath(edgeCaseAuditRun(), EDGE_SHOTS.secondDesktopViewport, relativePath);
    const store = artifactStore(result);

    await expect(bundleOf(result, store)).rejects.toThrow(RangeError);
    expect(store.calls).not.toContain(relativePath);
  });

  it('rejects a view model that was built from a different Run', async () => {
    const result = edgeCaseAuditRun();
    const other = auditRun({ run: { runId: createRunId(1) } });
    const store = artifactStore(result);

    await expect(createChatGptBundle(buildReportViewModel(other), result, store.readArtifactFile)).rejects.toThrow(RangeError);
    expect(store.calls).toEqual([]);
  });

  // WSO: 「チェックした画面だけ」の点検の Run（`run.json` の `pageScope`）は、案内に点検した範囲を 1 行で言う（報告のまとめと同じ文）。全部の画面の Run は言わない。
  it('says in the guide that only the checked screens were inspected, from the scope of the Run', async () => {
    const line = HTML_REPORT_TEXT.overview.checkedScreensOnly('2');
    const plain = edgeCaseAuditRun();
    const scoped: AuditRunResult = { ...plain, run: { ...plain.run, pageScope: { kind: 'CHECKED_WRITE_SCREENS', pageCount: 2 } } };
    const readmeOf = async (result: AuditRunResult): Promise<string> => decodeUtf8(unzipSync(await bundleOf(result))['README.md'] ?? new Uint8Array());
    expect(await readmeOf(scoped)).toContain(line);
    expect(await readmeOf(plain)).not.toContain(line);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R16f（設計書 6.1.11）: 各ページの page.json と、スクリーンショットの大きさの上限
// ---------------------------------------------------------------------------------------------------------------

describe('createChatGptBundle: the page.json of each page (R16f, design 6.1.11)', () => {
  it('puts the page.json of every page as read, with the same path as in the Run directory, in path order', async () => {
    const base = edgeCaseAuditRun();
    // ページの並び（表示用モデルの順）を逆にしても、ZIP の中は、パスの順に並ぶ。
    const result: AuditRunResult = { ...base, pages: [...base.pages].reverse() };
    const store = artifactStore(result);
    const entries = unzipSync(await bundleOf(result, store));
    const paths = Object.keys(entries);

    const pageJsonStart = LEADING_FILE_PATHS.length + EDGE_FINDING_FILE_PATHS.length;
    expect(paths.slice(pageJsonStart, pageJsonStart + EDGE_PAGE_JSON_PATHS.length)).toEqual(EDGE_PAGE_JSON_PATHS);
    expect(store.calls.slice(1, 1 + EDGE_PAGE_JSON_PATHS.length)).toEqual(EDGE_PAGE_JSON_PATHS);
    for (const path of EDGE_PAGE_JSON_PATHS) {
      expect(entries[path], path).toEqual(store.files.get(path));
    }
  });

  it('leaves out a page.json that cannot be read and records it in the manifest, in the order of the ZIP', async () => {
    const result = edgeCaseAuditRun();
    const [missingPage, presentPage] = EDGE_PAGE_JSON_PATHS as [string, string];
    // T44f: バンドルに入れるのは見える範囲のスクリーンショットだけなので、読めないものも見える範囲のもので確かめる。
    const missingScreenshot = 'pages/PAGE-000002/desktop/viewport.png';
    const entries = unzipSync(await bundleOf(result, artifactStore(result, [missingScreenshot, missingPage, 'run.json'])));
    const manifest = jsonOf(entries, 'manifest.json') as Manifest;

    expect(Object.keys(entries)).not.toContain(missingPage);
    expect(Object.keys(entries)).toContain(presentPage);
    expect(manifest.omittedFiles).toEqual([
      { path: 'run.json', evidenceIds: [], reason: 'ARTIFACT_FILE_NOT_FOUND' },
      { path: missingPage, evidenceIds: [], reason: 'ARTIFACT_FILE_NOT_FOUND' },
      { path: missingScreenshot, evidenceIds: [EDGE_SHOTS.secondDesktopViewport], reason: 'ARTIFACT_FILE_NOT_FOUND' },
    ]);
    expect(manifest.files.map(({ path }) => path)).not.toContain(missingPage);
  });

  it.each([
    ['a parent segment', 'pages/../secret.json'],
    ['a POSIX absolute path', '/pages/PAGE-000001/page.json'],
    ['a path outside the pages directory', 'run.json'],
  ])('rejects a page.json path with %s before reading any file', async (_name, pageJsonPath) => {
    const result = edgeCaseAuditRun();
    const model = buildReportViewModel(result);
    // AUD-1a: バンドルは、表示用モデルの参照の一覧で読むものを決める。
    const altered: ReportViewModel = {
      ...model,
      artifactReferences: model.artifactReferences.map((reference) =>
        reference.path === EDGE_PAGE_JSON_PATHS[0] ? { ...reference, path: pageJsonPath } : reference,
      ),
    };
    const store = artifactStore(result);

    await expect(createChatGptBundle(altered, result, store.readArtifactFile)).rejects.toThrow(RangeError);
    expect(store.calls).toEqual([]);
  });
});

// AUD-1d（ユーザーの判断 2026-11-09）: 画像の大きさの上限で外す決まり（R16f・AUD-1b）をやめ、集めた証拠を全部入れる。大きいときは部に分ける（部の決まりは
// `bundle-parts.test.ts`）。ここでは、1 つの ZIP の形と、部の大きさの目安の検証を確かめる。
describe('createChatGptBundle: every screenshot in the bundle, without a size limit (AUD-1d)', () => {
  const [p1Viewport] = EDGE_RELATED_SCREENSHOT_READ_ORDER as [string];
  const p1FullPage = screenshotPathOf(edgeCaseAuditRun(), EDGE_SHOTS.desktopFullPage);
  const screenshotEntriesOf = (entries: Readonly<Record<string, Uint8Array>>): string[] =>
    Object.keys(entries).slice(EDGE_FILES_BEFORE_SCREENSHOTS);

  it('puts every screenshot of every attempt, writes them in the screenshot paths of the Findings, and leaves nothing out', async () => {
    const result = edgeCaseAuditRun();
    const store = artifactStore(result);
    const entries = unzipSync(await bundleOf(result, store));
    expect(screenshotEntriesOf(entries)).toEqual(EDGE_RELATED_SCREENSHOT_PATHS);
    const manifest = jsonOf(entries, 'manifest.json') as Manifest;
    expect(manifest.omittedFiles).toEqual([]);
    expect(manifest).toMatchObject({ partCount: 1, partSizeBytes: null });
    expect(mainEntriesOf(entries)[0]?.screenshotPaths).toEqual([p1Viewport, p1FullPage]);
  });

  it('puts a big screenshot as it is', async () => {
    const result = edgeCaseAuditRun();
    const big = new Uint8Array(CHATGPT_BUNDLE_PART_SIZE_BYTES / 1024).fill(9);
    const entries = unzipSync(await bundleOf(result, artifactStore(result, [], new Map([[p1Viewport, big]]))));
    expect(entries[p1Viewport]).toEqual(big);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects the part size %s before reading any file',
    async (partSizeBytes) => {
      const result = edgeCaseAuditRun();
      const store = artifactStore(result);
      await expect(createChatGptBundleParts(buildReportViewModel(result), result, store.readArtifactFile, { partSizeBytes })).rejects.toThrow(RangeError);
      expect(store.calls).toEqual([]);
    },
  );

  it('has the default part size of 64 MiB', () => {
    expect(CHATGPT_BUNDLE_PART_SIZE_BYTES).toBe(64 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T44i（Task 44 の設計書 6 章の 2026-10-22 の行。P2-9）: 読み方の案内（README.md）と、Rule ごとの要約（findings-by-rule.json）
// ---------------------------------------------------------------------------------------------------------------

describe('createChatGptBundle: the guide and the digests by Rule (T44i)', () => {
  const textOf = (entries: Readonly<Record<string, Uint8Array>>, path: string): string => decodeUtf8(entries[path] ?? new Uint8Array());
  const code = (value: string): string => `\`${value}\``;
  const tableRow = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;

  /** 見分けやすい値を、案内に出してはならない欄に入れた見本（targetId、startUrl、許可 Origin、Finding の文と pageUrl）。 */
  const DISTINCT = Object.freeze({
    targetId: 'readme-distinct-target-4c1d',
    startPath: '/readme-distinct-start-8e2b',
    message: 'README-DISTINCT-MESSAGE-71f0',
    pagePath: '/readme-distinct-page-93aa',
  });
  const distinctRun = (): AuditRunResult => {
    const base = edgeCaseAuditRun();
    return {
      ...base,
      run: { ...base.run, target: { id: DISTINCT.targetId }, startUrl: fixtureUrl(DISTINCT.startPath) },
      findings: base.findings.map((value) => ({
        ...value,
        message: `${DISTINCT.message} ${value.message}`,
        pageUrl: value.pageId === null ? value.pageUrl : fixtureUrl(DISTINCT.pagePath),
      })),
    };
  };

  it('puts the digests by Rule of the view model, with the paths of the screenshots put in the ZIP only', async () => {
    const result = edgeCaseAuditRun();
    const model = buildReportViewModel(result);
    const entries = unzipSync(await bundleOf(result));

    const digestEntries = (digests: typeof model.ruleDigests): unknown =>
      digests.map(({ examples, ...digest }) => ({
        ...digest,
        examples: examples.map(({ screenshots, ...example }) => ({
          ...example,
          // AUD-1a: ZIP に入れたものだけ（この見本では、例の Finding に関係づくものは全部入る）。
          screenshotPaths: screenshots.map((shot) => shot.relativePath),
        })),
      }));
    // BN-d: 本体の Finding の要約（`main`）と、外した Finding の要約（`excluded`）。AUD-2d: 初めの表示だけの Finding の要約（`initialOnly`）。
    expect(jsonOf(entries, 'findings-by-rule.json')).toEqual(
      JSON.parse(JSON.stringify({
        main: digestEntries(model.mainRuleDigests),
        excluded: digestEntries(model.excludedRuleDigests),
        initialOnly: digestEntries(model.initialOnlyRuleDigests),
      })),
    );
    // 見本の確かめ: ERROR の Rule（TEST_RULE_1）の例は、見える範囲とページ全体のスクリーンショットを持つ（AUD-1b: どちらも ZIP に入る）。
    const digests = (jsonOf(entries, 'findings-by-rule.json') as {
      readonly main: readonly { readonly ruleId: string; readonly examples: readonly { readonly screenshotPaths: readonly string[] }[] }[];
    }).main;
    expect(digests[0]?.ruleId).toBe('TEST_RULE_1');
    expect(digests[0]?.examples[0]?.screenshotPaths).toEqual(['pages/PAGE-000001/desktop/viewport.png', 'pages/PAGE-000001/desktop/full-page.png']);
  });

  it('puts the counts by category and by Rule of the view model in summary.json', async () => {
    const result = edgeCaseAuditRun();
    const model = buildReportViewModel(result);
    const summary = jsonOf(unzipSync(await bundleOf(result)), 'summary.json') as { readonly findingCountsByCategory?: unknown; readonly findingCountsByRule?: unknown };

    expect(summary.findingCountsByCategory).toEqual(JSON.parse(JSON.stringify(model.summary.findingCountsByCategory)));
    expect(summary.findingCountsByRule).toEqual(JSON.parse(JSON.stringify(model.summary.findingCountsByRule)));
  });

  it('writes the guide as UTF-8 Markdown with LF line ends and one trailing LF, the same bytes from the same input', async () => {
    const result = edgeCaseAuditRun();
    const first = unzipSync(await bundleOf(result));
    const second = unzipSync(await bundleOf(result));
    const text = textOf(first, 'README.md');

    expect(first['README.md']).toEqual(second['README.md']);
    expect(text.includes('\r')).toBe(false);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text.startsWith(`# ${CHATGPT_BUNDLE_GUIDE_TEXT.title}\n`)).toBe(true);
  });

  it('names the files in the reading order, and explains the repetition of the same Finding on each page', async () => {
    const text = textOf(unzipSync(await bundleOf(edgeCaseAuditRun())), 'README.md');
    // REC-4: 指摘は、場所の一覧（finding-files.json）からページごとの指摘のファイルへたどる。
    const readingOrder = ['summary.json', 'findings-by-rule.json', 'finding-files.json', 'pages.json', 'pages/<pageId>/page.json'];
    const order = readingOrder.map((name, index) => text.indexOf(`${String(index + 1)}. ${code(name)}`));

    expect(order.every((position) => position >= 0), String(order)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(text).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.readingOrderHeading);
    expect(text).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.repetitionNote(code('pages/<pageId>/findings.json'), code('findings-by-rule.json')));
  });

  // REC-4: page.json 2.0 の短い形（同じ欄を 1 回だけ書く形・確かめ直しの違い・重なりの要素の番号）の読み方。
  it('tells how to read the short form of page.json', async () => {
    const text = textOf(unzipSync(await bundleOf(edgeCaseAuditRun())), 'README.md');

    expect(text.split('\n')).toContain(`## ${CHATGPT_BUNDLE_GUIDE_TEXT.pageRecordHeading}`);
    expect(text).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.pageRecordNote);
    for (const name of ['common', 'keys', 'items', 'sameAs', 'recheckBase', 'overlapElements']) {
      expect(CHATGPT_BUNDLE_GUIDE_TEXT.pageRecordNote, name).toContain(code(name));
    }
  });

  it('has the table of the counts by category (every category, in the display order) and the table of the Rules', async () => {
    const result = edgeCaseAuditRun();
    const model = buildReportViewModel(result);
    const text = textOf(unzipSync(await bundleOf(result)), 'README.md');
    const lines = text.split('\n');

    expect(lines).toContain(tableRow([...CHATGPT_BUNDLE_GUIDE_TEXT.categoryColumns]));
    const categoryRows = model.summary.findingCountsByCategory.map((entry) =>
      tableRow([FINDING_CATEGORY_CATALOG[entry.category].label, code(entry.category), String(entry.count)]));
    const categoryPositions = categoryRows.map((row) => lines.indexOf(row));
    expect(categoryPositions.every((position) => position >= 0), categoryRows.join('\n')).toBe(true);
    expect([...categoryPositions].sort((left, right) => left - right)).toEqual(categoryPositions);
    // 見本の確かめ: 0 件の category（HTTP）も、行を持つ。
    expect(lines).toContain(tableRow([FINDING_CATEGORY_CATALOG.HTTP.label, code('HTTP'), '0']));

    expect(lines).toContain(tableRow([...CHATGPT_BUNDLE_GUIDE_TEXT.ruleColumns]));
    // BN-d: Rule の表は、本体の Finding の要約。
    const ruleRows = model.mainRuleDigests.map((digest) =>
      tableRow([
        code(digest.ruleId),
        listText(sortByDisplayOrder(SEVERITIES, SEVERITY_CATALOG).filter((severity) => digest.bySeverity[severity] > 0).map((severity) => SEVERITY_CATALOG[severity].label)),
        FINDING_CATEGORY_CATALOG[digest.category].label,
        String(digest.count),
        String(digest.pageCount),
      ]));
    const rulePositions = ruleRows.map((row) => lines.indexOf(row));
    expect(rulePositions.every((position) => position >= 0), ruleRows.join('\n')).toBe(true);
    expect([...rulePositions].sort((left, right) => left - right)).toEqual(rulePositions);
  });

  it('tells the Run Status, the page coverage and that the Findings of the Safety group are records of BeakSight, not defects of the site', async () => {
    const result = edgeCaseAuditRun();
    const text = textOf(unzipSync(await bundleOf(result)), 'README.md');

    expect(text).toContain(`${RUN_STATUS_CATALOG.PARTIAL.label}（${code('PARTIAL')}）`);
    expect(text).toContain(code(result.run.runId));
    expect(text).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.incompletePagesNote(code('summary.json')));
    expect(text).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.safetyNote(SEVERITY_GROUP_CATALOG.SAFETY.label));
    expect(text).toContain(`${RUN_SUMMARY_TEXT.coverage.discovered} 2件`);
  });

  // T44R2 の I-5・M-6: 送信の扱いが PASS_EXCEPT_DELETE の Run や認証つきの Run は、読むだけではないので、「読むだけで」と書かない。安全の区分の Finding は、
  // BeakSight の決まりで止めた送信や操作（多くはページが出した送信）の記録であると書く（重大度と区分を混ぜない）。
  it('does not say that the audit only read the site, and tells what the Findings of the Safety group record', async () => {
    const text = textOf(unzipSync(await bundleOf(edgeCaseAuditRun())), 'README.md');

    expect(text).not.toContain('読むだけ');
    expect(text).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.intro);
    const safetyNote = CHATGPT_BUNDLE_GUIDE_TEXT.safetyNote(SEVERITY_GROUP_CATALOG.SAFETY.label);
    expect(text).toContain(safetyNote);
    expect(safetyNote).toContain('ページが出した送信');
    expect(safetyNote).toContain(`重大度の区分が「${SEVERITY_GROUP_CATALOG.SAFETY.label}」`);
  });

  // T44R2 の I-5: 送信の扱いの行（`summary.auditSend.policy` を `AUDIT_SEND_POLICY_CATALOG` の名前で）と、ログインの送信の一般の文。扱いが違えば README も違う。
  it('writes the audit send policy of the Run with its catalog name, so READ_ONLY and PASS_EXCEPT_DELETE give different guides', async () => {
    const base = edgeCaseAuditRun();
    const withPolicy = (policy: 'READ_ONLY' | 'PASS_EXCEPT_DELETE'): AuditRunResult => ({
      ...base,
      run: { ...base.run, safety: { ...base.run.safety, auditSend: { policy, passedRequests: 0, passedRequestsByMethod: {} } } },
    });
    const readOnly = textOf(unzipSync(await bundleOf(withPolicy('READ_ONLY'))), 'README.md');
    const passExceptDelete = textOf(unzipSync(await bundleOf(withPolicy('PASS_EXCEPT_DELETE'))), 'README.md');
    const policyLine = (policy: 'READ_ONLY' | 'PASS_EXCEPT_DELETE'): string =>
      `- ${AUDIT_SEND_TEXT.label}: ${AUDIT_SEND_POLICY_CATALOG[policy].label}（${code(policy)}）`;

    expect(readOnly).not.toBe(passExceptDelete);
    expect(readOnly.split('\n')).toContain(policyLine('READ_ONLY'));
    expect(passExceptDelete.split('\n')).toContain(policyLine('PASS_EXCEPT_DELETE'));
    expect(readOnly).not.toContain(AUDIT_SEND_POLICY_CATALOG.PASS_EXCEPT_DELETE.label);
    expect(passExceptDelete).not.toContain(AUDIT_SEND_POLICY_CATALOG.READ_ONLY.label);
    for (const text of [readOnly, passExceptDelete]) {
      expect(text).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.loginNote);
    }
  });

  it('says that there is no Finding instead of an empty table of the Rules', async () => {
    const base = auditRun();
    const result: AuditRunResult = { ...base, findings: [] };
    const text = textOf(unzipSync(await bundleOf(result)), 'README.md');

    expect(text).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.noRules);
    expect(text.split('\n')).not.toContain(tableRow([...CHATGPT_BUNDLE_GUIDE_TEXT.ruleColumns]));
  });

  it('does not write a URL, the targetId, the startUrl or the message of a Finding in the guide', async () => {
    const result = distinctRun();
    const entries = unzipSync(await bundleOf(result));
    const text = textOf(entries, 'README.md');
    // 見本の確かめ: 見分けやすい値は、バンドルのほかのファイルには入っている。
    expect(textOf(entries, 'summary.json')).toContain(DISTINCT.targetId);
    expect(textOf(entries, 'summary.json')).toContain(DISTINCT.startPath);
    expect(textOf(entries, EDGE_FINDING_FILE_PATHS[0] ?? '')).toContain(DISTINCT.message);
    expect(textOf(entries, EDGE_FINDING_FILE_PATHS[0] ?? '')).toContain(DISTINCT.pagePath);
    expect(textOf(entries, 'findings-by-rule.json')).toContain(DISTINCT.message);

    for (const value of [
      DISTINCT.targetId,
      DISTINCT.startPath,
      DISTINCT.message,
      DISTINCT.pagePath,
      FIXTURE_ORIGIN,
      '127.0.0.1',
      '://',
      'mailto:',
      'tel:',
      'javascript:',
      ...result.findings.map((value) => value.message),
    ]) {
      expect(text.includes(value), value).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// BN-d（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.5）: 本体（`findings.json`）と、外した指摘（`beaksight-related-findings.json`）
// ---------------------------------------------------------------------------------------------------------------

describe('createChatGptBundle: the body and the Findings related to the BeakSight blocks (BN-d)', () => {
  const textOf = (entries: Readonly<Record<string, Uint8Array>>, path: string): string => decodeUtf8(entries[path] ?? new Uint8Array());
  const code = (value: string): string => `\`${value}\``;
  const BLOCK_FINDING_FILE_PATHS = ['pages/PAGE-000001/findings.json', 'pages/PAGE-000002/findings.json'];

  it('puts only the site quality Findings not linked to a block in main, and the CAUSED, POSSIBLE and SAFETY ones with their relation in excluded', async () => {
    const result = beaksightBlockAuditRun();
    const model = buildReportViewModel(result);
    const entries = unzipSync(await bundleOf(result));
    const files = BLOCK_FINDING_FILE_PATHS.map((path) => jsonOf(entries, path) as FindingFile);
    const body = files.flatMap((file) => file.main);
    const related = files.flatMap((file) => file.excluded);

    expect(body.map((entry) => entry.finding.findingId)).toEqual(['FIND-000003', 'FIND-000004']);
    expect(body.some((entry) => 'beaksightBlockRelation' in entry)).toBe(false);
    expect(related.map((entry) => [entry.finding.findingId, entry.beaksightBlockRelation?.relation ?? null])).toEqual([
      ['FIND-000001', 'CAUSED'],
      ['FIND-000002', 'POSSIBLE'],
      ['FIND-000005', null],
    ]);
    expect(related[0]?.beaksightBlockRelation).toEqual(JSON.parse(JSON.stringify(model.findings[0]?.beaksightBlockRelation)));
    // 本体には、CAUSED・POSSIBLE・SAFETY の指摘が入らない。
    const bodyIds = new Set(body.map((entry) => entry.finding.findingId));
    for (const view of model.excludedFindings) {
      expect(bodyIds.has(view.finding.findingId), view.finding.findingId).toBe(false);
    }
  });

  it('splits the counts of summary.json, findings-by-rule.json, pages.json and finding-files.json into the body and the excluded ones', async () => {
    const result = beaksightBlockAuditRun();
    const model = buildReportViewModel(result);
    const entries = unzipSync(await bundleOf(result));
    const summary = jsonOf(entries, 'summary.json') as { readonly beaksightBlockRelation: unknown };
    expect(summary.beaksightBlockRelation).toEqual(JSON.parse(JSON.stringify(model.summary.beaksightBlockRelation)));

    const byRule = jsonOf(entries, 'findings-by-rule.json') as {
      readonly main: readonly { readonly ruleId: string; readonly count: number }[];
      readonly excluded: readonly { readonly ruleId: string; readonly count: number }[];
    };
    // AUD-2d: 初めの表示だけの指摘の要約（`initialOnly`）を足した。
    expect(Object.keys(byRule)).toEqual(['main', 'excluded', 'initialOnly']);
    expect(byRule.main.map((digest) => [digest.ruleId, digest.count])).toEqual([['HTTP_4XX', 1], ['MISSING_TITLE', 1]]);
    expect(byRule.excluded.map((digest) => [digest.ruleId, digest.count])).toEqual([
      ['SCRIPT_LOAD_FAILED', 1],
      ['MISSING_TITLE', 1],
      ['SAFETY_NON_READ_REQUEST_BLOCKED', 1],
    ]);

    const pages = jsonOf(entries, 'pages.json') as readonly {
      readonly mainFindingCounts: { readonly total: number };
      readonly excludedFindingCounts: { readonly total: number };
    }[];
    expect(pages.map((entry) => [entry.mainFindingCounts.total, entry.excludedFindingCounts.total])).toEqual([[1, 3], [1, 0]]);
    // REC-4: 指摘のファイルの場所の一覧は、ファイルごとの件数を持つ（本体と外した指摘の件数は、ファイルの件数と同じ）。
    expect(jsonOf(entries, 'finding-files.json')).toEqual([
      { pageId: 'PAGE-000001', path: BLOCK_FINDING_FILE_PATHS[0], main: 1, excluded: 3, initialOnly: 0 },
      { pageId: 'PAGE-000002', path: BLOCK_FINDING_FILE_PATHS[1], main: 1, excluded: 0, initialOnly: 0 },
    ]);
    expect(model.summary.beaksightBlockRelation.mainFindingCounts.total).toBe(2);
    expect(model.summary.beaksightBlockRelation.excludedFindingCounts.total).toBe(3);
  });

  it('tells in the guide what the body means, the excluded counts by relation, the BeakSight blocks in page.json and the blocks while closing', async () => {
    const result = beaksightBlockAuditRun();
    const text = textOf(unzipSync(await bundleOf(result)), 'README.md');
    const lines = text.split('\n');
    const guide = CHATGPT_BUNDLE_GUIDE_TEXT;

    expect(lines).toContain(`## ${guide.blockHeading}`);
    expect(text).toContain(guide.bodyNote(code('main'), code('excluded')));
    expect(lines).toContain(`- ${guide.bodyCount}: 2件`);
    for (const relation of ['CAUSED', 'POSSIBLE'] as const) {
      const spec = BEAKSIGHT_BLOCK_RELATION_CATALOG[relation];
      expect(lines).toContain(`- ${guide.excludedCount(spec.label)}（${code(relation)}）: ${guide.excludedCountValue('1件', spec.description)}`);
    }
    expect(text).not.toContain(guide.excludedCount(BEAKSIGHT_BLOCK_RELATION_CATALOG.NONE.label));
    expect(lines).toContain(`- ${guide.excludedCount(SEVERITY_GROUP_CATALOG.SAFETY.label)}: 1件`);
    expect(text).toContain(guide.blockedByClientNote(code('pages/<pageId>/page.json')));
    expect(text).toContain(guide.closingNote);
    // BN-R1 の M-5: 指摘の件数の行と category の別の件数の表は、外した指摘を含む全部の件数であることを書く。閉じる途中の遮断は、影響の可能性の元に使わない。
    expect(text).toContain(`- ${guide.findingCounts}: 5件`);
    expect(lines).toContain(`## ${guide.categoryHeading}`);
    for (const label of [guide.findingCounts, guide.categoryHeading]) {
      expect(label).toContain('本体と外した指摘を合わせた全部');
    }
    expect(guide.closingNote).toContain('影響の可能性（`POSSIBLE`）の元には使いません');
  });

  it('makes the same bytes from the same input', async () => {
    expect(sha256Of(await bundleOf(beaksightBlockAuditRun()))).toBe(sha256Of(await bundleOf(beaksightBlockAuditRun())));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// REC-4（設計書 `2026-11-14-beaksight-slim-and-simplify-design.md` 5.3）: 第 1 部は入口だけ。指摘はページごとのファイル。
// ---------------------------------------------------------------------------------------------------------------

describe('createChatGptBundleParts: the first part is the entrance, and the Findings are in the files of each page (REC-4)', () => {
  it('keeps every Finding out of the first part, and lists the Finding files of each page with their counts', async () => {
    const result = edgeCaseAuditRun();
    const model = buildReportViewModel(result);
    const parts = await createChatGptBundleParts(model, result, artifactStore(result).readArtifactFile, { partSizeBytes: 1 });
    const [first, ...rest] = parts.map((part) => unzipSync(part.bytes));

    expect(Object.keys(first ?? {})).toEqual(LEADING_FILE_PATHS);
    const later: Record<string, Uint8Array> = Object.assign({}, ...rest);
    const countOf = (views: readonly { readonly finding: { readonly pageId: string | null } }[], pageId: string | null): number =>
      views.filter((view) => view.finding.pageId === pageId).length;
    expect(jsonOf(first ?? {}, 'finding-files.json')).toEqual([PAGE_1, 'PAGE-000002', null].map((pageId, index) => ({
      pageId,
      path: EDGE_FINDING_FILE_PATHS[index],
      main: countOf(model.mainFindings, pageId),
      excluded: countOf(model.excludedFindings, pageId),
      initialOnly: countOf(model.initialOnlyFindings, pageId),
    })));
    const bundledIds = EDGE_FINDING_FILE_PATHS.flatMap((path) => {
      const file = jsonOf(later, path) as FindingFile;
      return [...file.main, ...file.excluded, ...file.initialOnly].map((entry) => entry.finding.findingId);
    });
    expect([...bundledIds].sort()).toEqual(result.findings.map((value) => value.findingId).sort());
  });
});

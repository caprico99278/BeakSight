// U16d（Task 14〜17 の設計書 6.1.2、6.1.8、6.1.9。上位の設計書 第19章）: 表示用モデルから、ChatGPT 用バンドル
// （`beaksight-audit-bundle_YYYYMMDDHHmmss.zip`。名前はバンドルのファイル名の設計書 2.1）の中身を作る。ファイルは書かない。ZIP の中身とパスは決定論的で、生のレスポンス本文を含まず、
// `evidence-index.json` から一次証跡（`page.json` と JSON Pointer）へたどれる。
// R16f（設計書 6.1.11）: 各ページの `page.json` を ZIP に入れ、ZIP だけで一次証跡へたどれるようにする。スクリーンショットの
// 合計の大きさに上限（`CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES`）を設ける。
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
import { CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES } from '../../src/core/limits.js';
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
import { AUDIT_SEND_TEXT, CHATGPT_BUNDLE_GUIDE_TEXT, RUN_SUMMARY_TEXT, listText } from '../../src/presentation/messages.js';
import {
  CHATGPT_BUNDLE_FILE_NAMES,
  CHATGPT_BUNDLE_OMISSION_REASONS,
  CHATGPT_BUNDLE_SCHEMA_VERSION,
  createChatGptBundle,
  type ReadArtifactFile,
} from '../../src/report/chatgpt-bundle.js';
import { buildReportViewModel, type ReportViewModel } from '../../src/report/view-model.js';
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

async function bundleOf(
  result: AuditRunResult,
  store: ArtifactStore = artifactStore(result),
  options?: { readonly screenshotBudgetBytes?: number },
): Promise<Uint8Array> {
  return createChatGptBundle(buildReportViewModel(result), result, store.readArtifactFile, options);
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
  readonly screenshotBudgetBytes: number;
  readonly files: readonly { readonly path: string; readonly byteLength: number; readonly sha256: string }[];
  readonly omittedFiles: readonly { readonly path: string; readonly reason: string }[];
}

interface EvidenceIndexEntry {
  readonly evidenceId: string;
  readonly type: string;
  readonly pageId: string;
  readonly viewport: string | null;
  readonly path: string;
  readonly pointer: string;
  readonly retryAttempt: number | null;
  readonly relatedFindingIds: readonly string[];
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

/**
 * `edgeCaseAuditRun()` の、バンドルに入れる関係するスクリーンショット（パスの順）。T44f: 関係するページ全体のスクリーンショット
 * （`pages/PAGE-000001/desktop/full-page.png`）は、バンドルに入れない。
 */
const EDGE_RELATED_SCREENSHOT_PATHS = [
  'pages/PAGE-000001/desktop/viewport.png',
  'pages/PAGE-000002/desktop/viewport.png',
];

/** ZIP の中の JSON のうち、`page.json` を除くもの（ZIP の中の順。T44i: `findings-by-rule.json` を足した。BN-d: 外した指摘のファイルを足した）。 */
const JSON_FILE_PATHS = [
  CHATGPT_BUNDLE_FILE_NAMES.manifest,
  RUN_ARTIFACT_FILE_NAMES.run,
  CHATGPT_BUNDLE_FILE_NAMES.summary,
  CHATGPT_BUNDLE_FILE_NAMES.findingsByRule,
  CHATGPT_BUNDLE_FILE_NAMES.findings,
  CHATGPT_BUNDLE_FILE_NAMES.relatedFindings,
  CHATGPT_BUNDLE_FILE_NAMES.pages,
  CHATGPT_BUNDLE_FILE_NAMES.evidenceIndex,
];

/**
 * ZIP の中で、各ページの `page.json` の前に並ぶファイル（ZIP の中の順）。T44i（Task 44 の設計書 6 章の 2026-10-22 の行）: 読み方の案内（`README.md`。JSON では
 * ない）を `manifest.json` の次に、Rule ごとの要約（`findings-by-rule.json`）を `summary.json` の次に入れる。BN-d: 外した指摘（`beaksight-related-findings.json`）を
 * `findings.json` の次に入れる。
 */
const LEADING_FILE_PATHS = [
  CHATGPT_BUNDLE_FILE_NAMES.manifest,
  CHATGPT_BUNDLE_FILE_NAMES.readme,
  RUN_ARTIFACT_FILE_NAMES.run,
  CHATGPT_BUNDLE_FILE_NAMES.summary,
  CHATGPT_BUNDLE_FILE_NAMES.findingsByRule,
  CHATGPT_BUNDLE_FILE_NAMES.findings,
  CHATGPT_BUNDLE_FILE_NAMES.relatedFindings,
  CHATGPT_BUNDLE_FILE_NAMES.pages,
  CHATGPT_BUNDLE_FILE_NAMES.evidenceIndex,
];

/** `edgeCaseAuditRun()` の各ページの `page.json` のパス（パスの順。R16f）。 */
const EDGE_PAGE_JSON_PATHS = ['pages/PAGE-000001/page.json', 'pages/PAGE-000002/page.json'];

/** ZIP の中で、スクリーンショットの前に並ぶファイル（JSON・README と、各ページの `page.json`）の数。 */
const EDGE_FILES_BEFORE_SCREENSHOTS = LEADING_FILE_PATHS.length + EDGE_PAGE_JSON_PATHS.length;

/** `edgeCaseAuditRun()` の関係するスクリーンショットを、入れる順（`VIEWPORT` のパスの順。T44f: `FULL_PAGE` は入れない）に並べたもの。 */
const EDGE_RELATED_SCREENSHOT_READ_ORDER = [
  'pages/PAGE-000001/desktop/viewport.png',
  'pages/PAGE-000002/desktop/viewport.png',
];

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------------------------------------------

describe('createChatGptBundle', () => {
  it('puts manifest, README, run, summary, the digests by Rule, findings, pages and the Evidence index first, then the related screenshots in path order', async () => {
    const result = edgeCaseAuditRun();
    // 見本の前提: バンドルに入れる関係するスクリーンショット（見える範囲）のパスは、この 2 つである（T44f: 関係するページ全体のものは入れない）。
    expect([
      screenshotPathOf(result, EDGE_SHOTS.desktopViewport),
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
      'findings.json',
      // BN-d: 本体から外した指摘（遮断が原因・影響の可能性・安全の区分）。
      'beaksight-related-findings.json',
      'pages.json',
      'evidence-index.json',
      // R16f: 各ページの page.json（パスの順）を、evidence-index.json の後、スクリーンショットの前に入れる。
      ...EDGE_PAGE_JSON_PATHS,
      ...EDGE_RELATED_SCREENSHOT_PATHS,
    ]);
    expect(LEADING_FILE_PATHS).toEqual(Object.keys(entries).slice(0, LEADING_FILE_PATHS.length));
    expect(EDGE_PAGE_JSON_PATHS).toEqual(result.pages.map((value) => pageArtifactRelativePath(value.pageId, 'page')).sort());
  });

  it('lists every file but the manifest itself with its byte length and SHA-256, and the facts of the Run', async () => {
    const result = edgeCaseAuditRun();
    const entries = unzipSync(await bundleOf(result));
    const manifest = jsonOf(entries, 'manifest.json') as Manifest;

    // T44i: README.md と findings-by-rule.json を足したので、版を 1.1 にした。BN-d: 本体と外した指摘を分けたので、1.2 にした。
    expect(CHATGPT_BUNDLE_SCHEMA_VERSION).toBe('chatgpt-bundle/1.2');
    expect(manifest).toEqual({
      bundleSchemaVersion: 'chatgpt-bundle/1.2',
      runId: result.run.runId,
      runStatus: result.run.runStatus,
      toolVersion: result.run.toolVersion,
      generatedAt: result.run.finishedAt,
      screenshotBudgetBytes: CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES,
      files: Object.keys(entries)
        .filter((path) => path !== 'manifest.json')
        .map((path) => {
          const bytes = entries[path] ?? new Uint8Array();
          return { path, byteLength: bytes.byteLength, sha256: sha256Of(bytes) };
        }),
      omittedFiles: [],
    });
    expect(manifest.files.map(({ path }) => path)).toEqual(Object.keys(entries).slice(1));
    expect(manifest.files.map(({ path }) => path)).toEqual(expect.arrayContaining(EDGE_PAGE_JSON_PATHS));
    // T44i: 目録は、読み方の案内と Rule ごとの要約も、大きさと SHA-256 つきで持つ。
    expect(manifest.files.map(({ path }) => path).slice(0, 4)).toEqual(['README.md', 'run.json', 'summary.json', 'findings-by-rule.json']);
    expect(CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES).toBe(64 * 1024 * 1024);
    expect(result.run.runStatus).toBe('PARTIAL');
  });

  it('puts the run.json read from the Run directory as is, without building it again', async () => {
    const result = edgeCaseAuditRun();
    const store = artifactStore(result);
    const entries = unzipSync(await bundleOf(result, store));

    expect(entries['run.json']).toEqual(store.files.get('run.json'));
    expect(entries['run.json']).toEqual(runJsonBytes(result));
  });

  it('reads and puts only the screenshots related to a Finding, with their bytes as read', async () => {
    const result = edgeCaseAuditRun();
    const store = artifactStore(result);
    const entries = unzipSync(await bundleOf(result, store));

    // R16f: run.json、各ページの page.json（パスの順）、関係するスクリーンショット（入れる順）を、1回ずつ読む。
    expect(store.calls).toEqual(['run.json', ...EDGE_PAGE_JSON_PATHS, ...EDGE_RELATED_SCREENSHOT_READ_ORDER]);
    expect([...EDGE_RELATED_SCREENSHOT_READ_ORDER].sort()).toEqual(EDGE_RELATED_SCREENSHOT_PATHS);
    for (const path of EDGE_RELATED_SCREENSHOT_PATHS) {
      expect(entries[path], path).toEqual(pngBytes(path));
    }
    // 関係のないスクリーンショット（Mobile と、直接の参照のない再試行の前の試行）は入らない。
    for (const unrelated of [EDGE_SHOTS.mobileViewport, EDGE_SHOTS.retryDesktopViewport]) {
      expect(Object.keys(entries)).not.toContain(screenshotPathOf(result, unrelated));
    }
    // R16f: page.json は入れる。visible-text.txt は、読まず、入れない。
    expect(Object.keys(entries).filter((path) => path.endsWith(PAGE_ARTIFACT_FILE_NAMES.page))).toEqual(EDGE_PAGE_JSON_PATHS);
    expect(Object.keys(entries).some((path) => path.endsWith(PAGE_ARTIFACT_FILE_NAMES.visibleText))).toBe(false);
    expect(store.calls.some((path) => path.endsWith(PAGE_ARTIFACT_FILE_NAMES.visibleText))).toBe(false);
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

    expect(Object.keys(entries).slice(EDGE_FILES_BEFORE_SCREENSHOTS)).toEqual([...EDGE_RELATED_SCREENSHOT_PATHS, retryPath].sort());
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
    expect(manifest.omittedFiles).toEqual([{ path: missing, reason: CHATGPT_BUNDLE_OMISSION_REASONS[0] }]);
    // R16f: 上限で入れなかったものの理由 BUNDLE_SIZE_LIMIT を加えた。
    expect(CHATGPT_BUNDLE_OMISSION_REASONS).toEqual(['ARTIFACT_FILE_NOT_FOUND', 'BUNDLE_SIZE_LIMIT']);
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
      { path: 'run.json', reason: 'ARTIFACT_FILE_NOT_FOUND' },
      { path: missingScreenshot, reason: 'ARTIFACT_FILE_NOT_FOUND' },
    ]);
  });

  it('lets each Evidence be traced from evidence-index.json to its record in page.json by path and pointer, within the ZIP alone', async () => {
    const result = edgeCaseAuditRun();
    const entries = unzipSync(await bundleOf(result));
    const index = jsonOf(entries, 'evidence-index.json') as readonly EvidenceIndexEntry[];

    expect(index).toHaveLength(result.pages.reduce((sum, value) => sum + value.evidence.length, 0));
    // R16f: たどる先は、ZIP の中の page.json だけである（Run のディレクトリや、元の Run を使わない）。
    expect([...new Set(index.map((entry) => entry.path))].sort()).toEqual(EDGE_PAGE_JSON_PATHS);
    for (const entry of index) {
      expect(Object.keys(entries), entry.path).toContain(entry.path);
      const document = jsonOf(entries, entry.path);
      const record = resolvePointer(document, entry.pointer) as EvidenceRecord;
      expect(record.evidenceId).toBe(entry.evidenceId);
      expect(record.type).toBe(entry.type);
      expect(record.pageId).toBe(entry.pageId);
      expect(record.viewport).toBe(entry.viewport);
      // 直接の参照の Finding（`EvidenceLocationView.relatedFindingIds`）。
      expect(entry.relatedFindingIds).toEqual(
        result.findings.filter((value) => value.evidenceRefs.includes(record.evidenceId)).map((value) => value.findingId),
      );
    }
    // 再試行の前の試行の Evidence は、その試行の番号を持つ。
    expect(index.filter((entry) => entry.retryAttempt !== null).map((entry) => [entry.evidenceId, entry.retryAttempt])).toEqual([
      ['EV-DOM-000001', 1],
      [EDGE_SHOTS.retryDesktopViewport, 1],
    ]);
    expect(index).toEqual(JSON.parse(JSON.stringify(buildReportViewModel(result).evidence)));
  });

  it('puts each Finding with the location of each Evidence it refers to and the paths of its related screenshots', async () => {
    const base = edgeCaseAuditRun();
    const unknownEvidence = 'EV-DOM-999999' as EvidenceId;
    const result: AuditRunResult = {
      ...base,
      findings: [...base.findings, finding(7, 'INFO', 'CROSS_PAGE', null, [unknownEvidence])],
    };
    const model = buildReportViewModel(result);
    const entries = unzipSync(await bundleOf(result));
    const findings = jsonOf(entries, 'findings.json');

    // BN-d: `findings.json` は本体の Finding（表示用モデルの `mainFindings`。この見本では SAFETY の 6 番を除く全部）だけ。
    expect(model.mainFindings.map((view) => view.finding.findingId)).toEqual(
      result.findings.filter((value) => value.severity !== 'SAFETY').map((value) => value.findingId),
    );
    expect(findings).toEqual(
      JSON.parse(JSON.stringify(model.mainFindings.map((view) => ({
        finding: view.finding,
        evidence: view.evidence.map(({ evidenceId, location }) => ({ evidenceId, path: location?.path ?? null, pointer: location?.pointer ?? null })),
        // T44f: バンドルに入れる撮り方（見える範囲）のスクリーンショットだけ。
        screenshotPaths: view.screenshots.filter((shot) => shot.captureType === 'VIEWPORT').map((shot) => shot.relativePath),
      })))),
    );
    // 見本の確認: ERROR の Finding は、Desktop の2枚のスクリーンショットに関係づくが、バンドルの screenshotPaths は見える範囲の 1 枚だけ（T44f）。どのページにも
    // ない Evidence は、場所が null。
    const parsed = findings as readonly { readonly evidence: readonly { readonly path: string | null }[]; readonly screenshotPaths: readonly string[] }[];
    expect(model.findings[0]?.screenshots.map((shot) => shot.relativePath)).toEqual(['pages/PAGE-000001/desktop/viewport.png', 'pages/PAGE-000001/desktop/full-page.png']);
    expect(parsed[0]?.screenshotPaths).toEqual(['pages/PAGE-000001/desktop/viewport.png']);
    expect(parsed.at(-1)?.evidence).toEqual([{ evidenceId: unknownEvidence, path: null, pointer: null }]);
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
    expect(jsonOf(entries, 'pages.json')).toEqual(
      JSON.parse(JSON.stringify(model.pages.map(({ findings: _findings, mainFindingIds, excludedFindingIds, retryAttempts, incompleteReasons, viewports, ...rest }) => ({
        ...rest,
        incompleteReasons: withoutDescription(incompleteReasons),
        viewports: viewports.map((viewport) => ({ ...viewport, incompleteReasons: withoutDescription(viewport.incompleteReasons) })),
        // BN-d: 本体の Finding の ID と、外した Finding の ID。
        findingIds: mainFindingIds,
        excludedFindingIds,
        retryAttempts: retryAttempts.map(({ evidence, ...attempt }) => ({
          ...attempt,
          evidenceIds: evidence.map((location) => location.evidenceId),
        })),
      })))),
    );
  });

  // L6（サイトへの負荷の制御の設計書 4.5）: `summary.json` の `load` は、表示用モデルの要約の `load`（`run.json` の `load` の写し）と
  // 同じ値である。バンドルの側で組み立て直したり、数え直したりしない。
  it('puts the same site load as the view model summary (the copy of run.json load) in summary.json', async () => {
    const base = edgeCaseAuditRun();
    const result: AuditRunResult = { ...base, run: { ...base.run, load: loadDisplaySample() } };
    const model = buildReportViewModel(result);
    const entries = unzipSync(await bundleOf(result));
    const summary = jsonOf(entries, 'summary.json') as { readonly load?: unknown };

    expect(summary.load).toEqual(loadDisplaySample());
    expect(summary.load).toEqual(JSON.parse(JSON.stringify(model.summary.load)));
  });

  // R6（中断した Run の再開の設計書 4.8 の「表示」）: `summary.json` の `executions` は、表示用モデルの要約の `executions`（実行の回数、
  // 再開の回数、`run.json` の `executions` の写し）と同じ値である。バンドルの側で数え直さない。終わり方は、コードのまま入れる
  // （日本語のラベルと説明は入れない）。CCX-19（CC-048）: 表示用モデルの最後の実行の終わりの時刻（`lastFinishedAt`）は入れない（形を変えない）。
  it('puts the same executions as the view model summary (the counts and the copy of run.json executions) in summary.json', async () => {
    const base = edgeCaseAuditRun();
    const result: AuditRunResult = { ...base, run: { ...base.run, executions: executionsDisplaySample() } };
    const model = buildReportViewModel(result);
    const entries = unzipSync(await bundleOf(result));
    const summary = jsonOf(entries, 'summary.json') as { readonly executions?: unknown };

    expect(summary.executions).toEqual({ count: 3, resumeCount: 2, lastEndReason: 'COMPLETED', items: executionsDisplaySample() });
    const { lastFinishedAt: _lastFinishedAt, ...withoutLastFinishedAt } = model.summary.executions;
    expect(summary.executions).toEqual(JSON.parse(JSON.stringify(withoutLastFinishedAt)));
    const text = decodeUtf8(entries['summary.json'] ?? new Uint8Array());
    for (const spec of Object.values<DisplaySpec>(RUN_EXECUTION_END_REASON_CATALOG)) {
      expect(text).not.toContain(spec.label);
    }
  });

  // AS-b（監査の段の送信の扱いの設計書 2.3）: `summary.json` の `auditSend` は、表示用モデルの要約の `auditSend`（扱い、目立つ形で出すか、通した数）と同じ値。
  // バンドルの側で数え直さない。日本語の文言は入れない。
  it('puts the same audit send policy and passed counts as the view model summary in summary.json', async () => {
    const base = edgeCaseAuditRun();
    const auditSend = { policy: 'PASS_EXCEPT_DELETE', passedRequests: 5, passedRequestsByMethod: { POST: 4, PUT: 1 } } as const;
    const result: AuditRunResult = { ...base, run: { ...base.run, safety: { ...base.run.safety, auditSend } } };
    const model = buildReportViewModel(result);
    const entries = unzipSync(await bundleOf(result));
    const summary = jsonOf(entries, 'summary.json') as { readonly auditSend?: unknown };

    // AS-c: 持たない Run は、ほかの Origin へ通した数と WebSocket の接続の数を 0 と読む。
    // AS-c fix round 1: Guard の判定を通らずに開いた接続と危険な語の接続も 0 と読み、その知らせは出さない。
    expect(summary.auditSend).toEqual({
      ...auditSend,
      prominent: true,
      passedOtherOriginRequests: 0,
      passedWebSockets: 0,
      passedWebSocketsOutsideGuard: 0,
      passedDangerousWebSockets: 0,
      webSocketCaution: false,
    });
    expect(summary.auditSend).toEqual(JSON.parse(JSON.stringify(model.summary.auditSend)));
  });

  it('puts one execution and no resume in summary.json for a Run that was not interrupted', async () => {
    const result = auditRun();
    const entries = unzipSync(await bundleOf(result));
    const summary = jsonOf(entries, 'summary.json') as { readonly executions?: unknown };

    expect(summary.executions).toEqual({
      count: 1,
      resumeCount: 0,
      lastEndReason: 'COMPLETED',
      items: JSON.parse(JSON.stringify(result.run.executions)),
    });
  });

  // R9（中断した Run の再開の設計書 4.8 の 2026-10-08 の追補）: この起動の終わり方（最後の実行の終わり方）は、`summary.json` の
  // `executions` の中に、コードのまま入る（日本語のラベルは入れない）。
  it('puts the end reason of the last execution as a code in the executions of summary.json, without the label', async () => {
    const base = edgeCaseAuditRun();
    const executions: AuditRunResult['run']['executions'] = [
      ...executionsDisplaySample(),
      { startedAt: '2026-10-03T00:00:00.000Z', finishedAt: '2026-10-03T00:10:00.000Z', endReason: 'STOPPED_BY_SIGNAL' },
    ];
    const result: AuditRunResult = { ...base, run: { ...base.run, executions } };
    const entries = unzipSync(await bundleOf(result));
    const summary = jsonOf(entries, 'summary.json') as { readonly executions?: { readonly lastEndReason?: unknown } };

    expect(summary.executions?.lastEndReason).toBe('STOPPED_BY_SIGNAL');
    const text = decodeUtf8(entries['summary.json'] ?? new Uint8Array());
    expect(text).not.toContain(RUN_EXECUTION_END_REASON_CATALOG.STOPPED_BY_SIGNAL.label);
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
    const findings = jsonOf(entries, 'findings.json') as readonly { readonly finding: { readonly message: string }; readonly screenshotPaths: readonly string[] }[];
    expect(findings[0]?.finding.message).toBe(result.findings[0]?.message);
    expect(findings[0]?.finding.message).toContain('日本語の指摘');
    expect(findings[4]?.screenshotPaths).toEqual([japanesePath]);

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
    expect(store.calls).not.toContain(visibleTextPath);
    expect(entries[pageJsonPath]).toEqual(store.files.get(pageJsonPath));
    for (const [path, bytes] of Object.entries(entries)) {
      expect(new TextDecoder('utf-8').decode(bytes).includes(rawBody), path).toBe(path === pageJsonPath);
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

    expect(paths.slice(LEADING_FILE_PATHS.length, EDGE_FILES_BEFORE_SCREENSHOTS)).toEqual(EDGE_PAGE_JSON_PATHS);
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
      { path: 'run.json', reason: 'ARTIFACT_FILE_NOT_FOUND' },
      { path: missingPage, reason: 'ARTIFACT_FILE_NOT_FOUND' },
      { path: missingScreenshot, reason: 'ARTIFACT_FILE_NOT_FOUND' },
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
    const [first, ...rest] = model.pages;
    const altered: ReportViewModel = { ...model, pages: [{ ...first!, pageJsonPath }, ...rest] };
    const store = artifactStore(result);

    await expect(createChatGptBundle(altered, result, store.readArtifactFile)).rejects.toThrow(RangeError);
    expect(store.calls).toEqual([]);
  });
});

describe('createChatGptBundle: the budget of the screenshots (R16f, design 6.1.11)', () => {
  const [p1Viewport, p2Viewport] = EDGE_RELATED_SCREENSHOT_READ_ORDER as [string, string];
  /** T44f: 関係はあるが、バンドルに入れないページ全体のスクリーンショット。 */
  const p1FullPage = screenshotPathOf(edgeCaseAuditRun(), EDGE_SHOTS.desktopFullPage);
  /** T44f: 見える範囲のスクリーンショットを 3 つにする（再試行の前の試行のスクリーンショットを直接参照する Finding を足す）。 */
  const withRetryShot = (): AuditRunResult => {
    const base = edgeCaseAuditRun();
    return { ...base, findings: [...base.findings, finding(7, 'INFO', 'LAYOUT', PAGE_1, [EDGE_SHOTS.retryDesktopViewport])] };
  };
  const retryViewport = 'pages/PAGE-000001/retry-1/desktop/viewport.png';

  /** 大きさを変えたスクリーンショットを置いた、書き出し済みの Run のディレクトリの代わり。 */
  const sizedStore = (
    result: AuditRunResult,
    sizes: readonly (readonly [string, number])[],
    missing: readonly string[] = [],
  ): ArtifactStore => artifactStore(result, missing, new Map(sizes.map(([path, size]) => [path, new Uint8Array(size).fill(size % 251)])));

  const screenshotEntriesOf = (entries: Readonly<Record<string, Uint8Array>>): string[] =>
    Object.keys(entries).slice(EDGE_FILES_BEFORE_SCREENSHOTS);

  it('writes the budget in the manifest, and the default budget is CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES', async () => {
    const result = edgeCaseAuditRun();
    const byDefault = jsonOf(unzipSync(await bundleOf(result)), 'manifest.json') as Manifest;
    expect(byDefault.screenshotBudgetBytes).toBe(CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES);
    const injected = jsonOf(
      unzipSync(await bundleOf(result, artifactStore(result), { screenshotBudgetBytes: 12_345 })),
      'manifest.json',
    ) as Manifest;
    expect(injected.screenshotBudgetBytes).toBe(12_345);
  });

  // T44f（Task 44 の設計書 P3-1 の E）: バンドルには、ページ全体のスクリーンショット（FULL_PAGE）を入れない（読まない。成果物のフォルダには残る）。
  // findings.json の screenshotPaths も、バンドルに入る見える範囲のスクリーンショット（VIEWPORT）だけ。
  it('leaves the FULL_PAGE screenshots out of the bundle and out of the screenshot paths of findings.json (T44f)', async () => {
    const result = edgeCaseAuditRun();
    const store = artifactStore(result);
    const entries = unzipSync(await bundleOf(result, store));
    expect(store.calls).not.toContain(p1FullPage);
    expect(Object.keys(entries)).not.toContain(p1FullPage);
    expect(screenshotEntriesOf(entries)).toEqual([p1Viewport, p2Viewport].sort());
    const manifest = jsonOf(entries, 'manifest.json') as Manifest;
    expect(manifest.omittedFiles).toEqual([]);
    const findings = jsonOf(entries, 'findings.json') as readonly { readonly screenshotPaths: readonly string[] }[];
    expect(findings.flatMap(({ screenshotPaths }) => screenshotPaths)).not.toContain(p1FullPage);
    expect(findings[0]?.screenshotPaths).toEqual([p1Viewport]);
  });

  it('leaves out a screenshot that would go over the budget', async () => {
    const result = edgeCaseAuditRun();
    // 60（入る）→ 50（合計 110 で超えるので、入れない）。
    const store = sizedStore(result, [[p1Viewport, 60], [p2Viewport, 50]]);
    const entries = unzipSync(await bundleOf(result, store, { screenshotBudgetBytes: 100 }));
    const manifest = jsonOf(entries, 'manifest.json') as Manifest;

    expect(screenshotEntriesOf(entries)).toEqual([p1Viewport]);
    expect(manifest.omittedFiles).toEqual([{ path: p2Viewport, reason: 'BUNDLE_SIZE_LIMIT' }]);
    expect(manifest.files.map(({ path }) => path)).not.toContain(p2Viewport);
    expect(manifest.runStatus).toBe(result.run.runStatus);
  });

  it('still puts a smaller screenshot after one that went over the budget, keeping the path order in the ZIP', async () => {
    const result = withRetryShot();
    // 入れる順はパスの順（p1、retry、p2）。60（入る。合計 60）→ 50（合計 110 で超えるので、入れない）→ 30（合計 90 で入る）。
    const store = sizedStore(result, [[p1Viewport, 60], [retryViewport, 50], [p2Viewport, 30]]);
    const entries = unzipSync(await bundleOf(result, store, { screenshotBudgetBytes: 100 }));
    const manifest = jsonOf(entries, 'manifest.json') as Manifest;

    expect(screenshotEntriesOf(entries)).toEqual([p1Viewport, p2Viewport]);
    expect(manifest.omittedFiles).toEqual([{ path: retryViewport, reason: 'BUNDLE_SIZE_LIMIT' }]);
    expect(entries[p2Viewport]?.byteLength).toBe(30);
    expect(entries[p1Viewport]?.byteLength).toBe(60);
    expect(Object.keys(entries)).not.toContain(p1FullPage);
  });

  it('puts every screenshot when the total is exactly the budget, and none when the budget is 0', async () => {
    const result = edgeCaseAuditRun();
    const sizes = [[p1Viewport, 40], [p2Viewport, 40]] as const;
    const exact = unzipSync(await bundleOf(result, sizedStore(result, sizes), { screenshotBudgetBytes: 80 }));
    expect(screenshotEntriesOf(exact)).toEqual(EDGE_RELATED_SCREENSHOT_PATHS);
    expect((jsonOf(exact, 'manifest.json') as Manifest).omittedFiles).toEqual([]);

    const zero = unzipSync(await bundleOf(result, sizedStore(result, sizes), { screenshotBudgetBytes: 0 }));
    expect(screenshotEntriesOf(zero)).toEqual([]);
    // 入れなかったものは、ZIP の中の順（パスの順）に並ぶ。
    expect((jsonOf(zero, 'manifest.json') as Manifest).omittedFiles).toEqual(
      EDGE_RELATED_SCREENSHOT_PATHS.map((path) => ({ path, reason: 'BUNDLE_SIZE_LIMIT' })),
    );
    // page.json と JSON（と README）は、上限の対象ではない。
    expect(Object.keys(zero)).toEqual([...LEADING_FILE_PATHS, ...EDGE_PAGE_JSON_PATHS]);
  });

  it('does not count a screenshot that cannot be read against the budget', async () => {
    const result = edgeCaseAuditRun();
    const store = sizedStore(result, [[p1Viewport, 60], [p2Viewport, 50]], [p1Viewport]);
    const entries = unzipSync(await bundleOf(result, store, { screenshotBudgetBytes: 100 }));
    const manifest = jsonOf(entries, 'manifest.json') as Manifest;

    // 読めなかった 60 は数えないので、50 が入る（数えると 110 で超える）。
    expect(screenshotEntriesOf(entries)).toEqual([p2Viewport]);
    expect(manifest.omittedFiles).toEqual([{ path: p1Viewport, reason: 'ARTIFACT_FILE_NOT_FOUND' }]);
  });

  it('makes the same bytes from the same input and the same budget', async () => {
    const result = edgeCaseAuditRun();
    const sizes = [[p1Viewport, 60], [p2Viewport, 50]] as const;
    const first = await bundleOf(result, sizedStore(result, sizes), { screenshotBudgetBytes: 100 });
    const second = await bundleOf(result, sizedStore(result, sizes), { screenshotBudgetBytes: 100 });
    expect(second).toEqual(first);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects the budget %s before reading any file',
    async (screenshotBudgetBytes) => {
      const result = edgeCaseAuditRun();
      const store = artifactStore(result);
      await expect(bundleOf(result, store, { screenshotBudgetBytes })).rejects.toThrow(RangeError);
      expect(store.calls).toEqual([]);
    },
  );
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

  it('puts the digests by Rule of the view model, with the paths of the screenshots of the bundled capture types only', async () => {
    const result = edgeCaseAuditRun();
    const model = buildReportViewModel(result);
    const entries = unzipSync(await bundleOf(result));

    const digestEntries = (digests: typeof model.ruleDigests): unknown =>
      digests.map(({ examples, ...digest }) => ({
        ...digest,
        examples: examples.map(({ screenshots, ...example }) => ({
          ...example,
          screenshotPaths: screenshots.filter((shot) => shot.captureType === 'VIEWPORT').map((shot) => shot.relativePath),
        })),
      }));
    // BN-d: 本体の Finding の要約（`main`）と、外した Finding の要約（`excluded`）。
    expect(jsonOf(entries, 'findings-by-rule.json')).toEqual(
      JSON.parse(JSON.stringify({ main: digestEntries(model.mainRuleDigests), excluded: digestEntries(model.excludedRuleDigests) })),
    );
    // 見本の確かめ: ERROR の Rule（TEST_RULE_1）の例は、見える範囲のスクリーンショットだけを持つ（ページ全体のものは、バンドルに入らない）。
    const digests = (jsonOf(entries, 'findings-by-rule.json') as {
      readonly main: readonly { readonly ruleId: string; readonly examples: readonly { readonly screenshotPaths: readonly string[] }[] }[];
    }).main;
    expect(digests[0]?.ruleId).toBe('TEST_RULE_1');
    expect(digests[0]?.examples[0]?.screenshotPaths).toEqual(['pages/PAGE-000001/desktop/viewport.png']);
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
    // BN-d: 外した指摘のファイルを、本体の次に読む。
    const readingOrder = ['summary.json', 'findings-by-rule.json', 'findings.json', 'beaksight-related-findings.json', 'pages.json', 'evidence-index.json'];
    const order = readingOrder.map((name, index) => text.indexOf(`${String(index + 1)}. ${code(name)}`));

    expect(order.every((position) => position >= 0), String(order)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(text).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.readingOrderHeading);
    expect(text).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.repetitionNote(code('findings.json'), code('findings-by-rule.json')));
    expect(text).toContain(code('pages/<pageId>/page.json'));
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
    expect(textOf(entries, 'findings.json')).toContain(DISTINCT.message);
    expect(textOf(entries, 'findings.json')).toContain(DISTINCT.pagePath);
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
  interface BundledFinding {
    readonly finding: { readonly findingId: string; readonly severity: string };
    readonly beaksightBlockRelation?: { readonly relation: string; readonly reason: string; readonly blocks: readonly unknown[]; readonly blockCount: number } | null;
  }

  it('is the version 1.2, and puts beaksight-related-findings.json right after findings.json', async () => {
    const entries = unzipSync(await bundleOf(beaksightBlockAuditRun()));
    expect(CHATGPT_BUNDLE_SCHEMA_VERSION).toBe('chatgpt-bundle/1.2');
    expect((jsonOf(entries, 'manifest.json') as Manifest).bundleSchemaVersion).toBe('chatgpt-bundle/1.2');
    const paths = Object.keys(entries);
    expect(paths.indexOf(CHATGPT_BUNDLE_FILE_NAMES.relatedFindings)).toBe(paths.indexOf(CHATGPT_BUNDLE_FILE_NAMES.findings) + 1);
    expect(CHATGPT_BUNDLE_FILE_NAMES.relatedFindings).toBe('beaksight-related-findings.json');
  });

  it('puts only the site quality Findings not linked to a block in findings.json, and the CAUSED, POSSIBLE and SAFETY ones with their relation in the related file', async () => {
    const result = beaksightBlockAuditRun();
    const model = buildReportViewModel(result);
    const entries = unzipSync(await bundleOf(result));
    const body = jsonOf(entries, 'findings.json') as readonly BundledFinding[];
    const related = jsonOf(entries, 'beaksight-related-findings.json') as readonly BundledFinding[];

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

  it('splits the counts and the IDs of summary.json, findings-by-rule.json and pages.json into the body and the excluded ones', async () => {
    const result = beaksightBlockAuditRun();
    const model = buildReportViewModel(result);
    const entries = unzipSync(await bundleOf(result));
    const summary = jsonOf(entries, 'summary.json') as { readonly beaksightBlockRelation: unknown };
    expect(summary.beaksightBlockRelation).toEqual(JSON.parse(JSON.stringify(model.summary.beaksightBlockRelation)));

    const byRule = jsonOf(entries, 'findings-by-rule.json') as {
      readonly main: readonly { readonly ruleId: string; readonly count: number }[];
      readonly excluded: readonly { readonly ruleId: string; readonly count: number }[];
    };
    expect(Object.keys(byRule)).toEqual(['main', 'excluded']);
    expect(byRule.main.map((digest) => [digest.ruleId, digest.count])).toEqual([['HTTP_4XX', 1], ['MISSING_TITLE', 1]]);
    expect(byRule.excluded.map((digest) => [digest.ruleId, digest.count])).toEqual([
      ['SCRIPT_LOAD_FAILED', 1],
      ['MISSING_TITLE', 1],
      ['SAFETY_NON_READ_REQUEST_BLOCKED', 1],
    ]);

    const pages = jsonOf(entries, 'pages.json') as readonly {
      readonly findingIds: readonly string[];
      readonly excludedFindingIds: readonly string[];
      readonly mainFindingCounts: { readonly total: number };
      readonly excludedFindingCounts: { readonly total: number };
    }[];
    expect(pages.map((entry) => [entry.findingIds, entry.excludedFindingIds])).toEqual([
      [['FIND-000003'], ['FIND-000001', 'FIND-000002', 'FIND-000005']],
      [['FIND-000004'], []],
    ]);
    expect(pages.map((entry) => [entry.mainFindingCounts.total, entry.excludedFindingCounts.total])).toEqual([[1, 3], [1, 0]]);
    // 件数の一致: 本体と外した指摘の件数は、ファイルの件数と同じ。
    const relatedCount = (jsonOf(entries, 'beaksight-related-findings.json') as readonly unknown[]).length;
    expect(model.summary.beaksightBlockRelation.mainFindingCounts.total).toBe((jsonOf(entries, 'findings.json') as readonly unknown[]).length);
    expect(model.summary.beaksightBlockRelation.excludedFindingCounts.total).toBe(relatedCount);
  });

  it('tells in the guide what the body means, the excluded counts by relation, the BeakSight blocks in page.json and the blocks while closing', async () => {
    const result = beaksightBlockAuditRun();
    const text = textOf(unzipSync(await bundleOf(result)), 'README.md');
    const lines = text.split('\n');
    const guide = CHATGPT_BUNDLE_GUIDE_TEXT;

    expect(lines).toContain(`## ${guide.blockHeading}`);
    expect(text).toContain(guide.bodyNote(code('findings.json'), code('beaksight-related-findings.json')));
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
    // 読む順に、外した指摘のファイルが、本体の次に入る。
    const readingOrder = ['summary.json', 'findings-by-rule.json', 'findings.json', 'beaksight-related-findings.json', 'pages.json', 'evidence-index.json'];
    const order = readingOrder.map((name, index) => text.indexOf(`${String(index + 1)}. ${code(name)}`));
    expect(order.every((position) => position >= 0), String(order)).toBe(true);
  });

  it('makes the same bytes from the same input', async () => {
    expect(sha256Of(await bundleOf(beaksightBlockAuditRun()))).toBe(sha256Of(await bundleOf(beaksightBlockAuditRun())));
  });
});

// T32f（Task 32 の設計書 4.1 の「決定論の ZIP」）: ZIP の組み立て（時刻の固定、目録の sha256）を共通の部品 `deterministic-zip.ts`（T32R2 M-2 から `src/core/`）に
// 出す前に、今のバンドルのバイト列を sha256 で固定する（移した後も、監査のバンドルは 1 バイトも変わらない）。
// AS-b（監査の段の送信の扱いの設計書 2.1・2.3）で、値を求め直した: 見本の実効の設定に `audit.sendPolicy`（既定の `READ_ONLY`）が入り（`run.json`）、表示用モデルの要約に
// `auditSend` が入った（`summary.json`）ため。ZIP の組み立ては変えていない。AS-c でも求め直した: 要約の `auditSend` に、ほかの Origin へ通した数と WebSocket の
// 接続の数（持たない見本は 0）が入ったため。AS-c fix round 1 でも求め直した: 要約の `auditSend` に、Guard の判定を通らずに開いた WebSocket の接続と危険な語の
// 接続の数（持たない見本は 0）と、その知らせを出すか（偽）が入ったため。T44f（Task 44 の設計書 P3-1 の A・E）でも求め直した: JSON を字下げなしで書き、
// ページ全体のスクリーンショットを入れなくなったため。ZIP の組み立ては変えていない。
// T44i（Task 44 の設計書 6 章の 2026-10-22 の行）でも求め直した: 読み方の案内（README.md）と Rule ごとの要約（findings-by-rule.json）を足し、版を 1.1 にし、要約に
// category の別・Rule の別の件数が入ったため。ZIP の組み立ては変えていない。
// BN-d（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.5）でも求め直した: 版を 1.2 にし、外した指摘のファイル（beaksight-related-findings.json）を
// 足し、findings.json を本体の指摘だけにし、summary.json・findings-by-rule.json・pages.json の件数と ID を本体の分と外した分に分け、README.md に本体と外した
// 指摘の節を足したため（BN-R0 の M-1・M-3 の印も含む）。ZIP の組み立ては変えていない。
// BN-R1 の M-5 でも求め直した: README.md の指摘の件数の行と category の別の件数の表の名前に「本体と外した指摘を合わせた全部」を足し、閉じる途中の遮断の文を事実に
// 合わせたため。ZIP の組み立ては変えていない。
// BN-R1 の確かめ直しの N-3 でも求め直した: README.md の「遮断が原因」の説明（表示カタログの説明）を、`output.md` と同じ意味（指摘の対象の要求か、行き先の移動か、測った
// 画面そのものを、BeakSight の遮断が決めた）に直したため。ZIP の組み立ては変えていない。
describe('createChatGptBundle: the bytes stay the same when the ZIP is built by a shared part (T32f)', () => {
  it.each<readonly [string, () => AuditRunResult, string]>([
    // T44R2 の I-5・M-6 でも求め直した（担当 T の M-8 の後の値）: README.md の前書きと安全の区分の文を直し、送信の扱いの行とログインの送信の文を足したため。
    // LG-4 でも求め直した: 見本の page.json を `page-schema/1.1` にし、BeakSight の遮断の記録の印（時点・要求の種類・読み込みの種類・network の失敗の印）を
    // 足したため（page.json のバイト列が変わった）。ZIP の組み立ては変えていない。
    ['the audit run sample', auditRun, 'sha256:e67d58af2a6956f91b4453ca694ca834a334ffa78ace9d69f2b8e25a3f5a577a'],
    ['the edge case sample', edgeCaseAuditRun, 'sha256:39a268abeb4ebd65819957ca04adfc577f8a644fc3664fa2d9d70f8ea41234ed'],
  ])('keeps the SHA-256 of the bundle of %s', async (_label, sample, expected) => {
    expect(sha256Of(await bundleOf(sample()))).toBe(expected);
  });
});

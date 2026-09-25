// U16d（Task 14〜17 の設計書 6.1.2、6.1.8、6.1.9。上位の設計書 第19章）: 表示用モデルから、ChatGPT 用バンドル
// （`beaksight-audit-bundle.zip`）の中身を作る。ファイルは書かない。ZIP の中身とパスは決定論的で、生のレスポンス本文を含まず、
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
import type { AuditRunResult, EvidenceId, EvidenceRecord, PageAuditResult } from '../../src/core/contracts.js';
import { createRunId } from '../../src/core/ids.js';
import { CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES } from '../../src/core/limits.js';
import {
  CHATGPT_BUNDLE_FILE_NAMES,
  CHATGPT_BUNDLE_OMISSION_REASONS,
  CHATGPT_BUNDLE_SCHEMA_VERSION,
  createChatGptBundle,
  type ReadArtifactFile,
} from '../../src/report/chatgpt-bundle.js';
import { buildReportViewModel, type ReportViewModel } from '../../src/report/view-model.js';
import {
  JAPANESE_TEXT,
  PAGE_1,
  auditRun,
  dom,
  edgeCaseAuditRun,
  finding,
  idOf,
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

const EDGE_RELATED_SCREENSHOT_PATHS = [
  'pages/PAGE-000001/desktop/full-page.png',
  'pages/PAGE-000001/desktop/viewport.png',
  'pages/PAGE-000002/desktop/viewport.png',
];

const JSON_FILE_PATHS = [
  CHATGPT_BUNDLE_FILE_NAMES.manifest,
  RUN_ARTIFACT_FILE_NAMES.run,
  CHATGPT_BUNDLE_FILE_NAMES.summary,
  CHATGPT_BUNDLE_FILE_NAMES.findings,
  CHATGPT_BUNDLE_FILE_NAMES.pages,
  CHATGPT_BUNDLE_FILE_NAMES.evidenceIndex,
];

/** `edgeCaseAuditRun()` の各ページの `page.json` のパス（パスの順。R16f）。 */
const EDGE_PAGE_JSON_PATHS = ['pages/PAGE-000001/page.json', 'pages/PAGE-000002/page.json'];

/** ZIP の中で、スクリーンショットの前に並ぶファイル（JSON と、各ページの `page.json`）の数。 */
const EDGE_FILES_BEFORE_SCREENSHOTS = JSON_FILE_PATHS.length + EDGE_PAGE_JSON_PATHS.length;

/** `edgeCaseAuditRun()` の関係するスクリーンショットを、入れる順（`VIEWPORT` のパスの順、`FULL_PAGE` のパスの順。設計書 6.1.11）に並べたもの。 */
const EDGE_RELATED_SCREENSHOT_READ_ORDER = [
  'pages/PAGE-000001/desktop/viewport.png',
  'pages/PAGE-000002/desktop/viewport.png',
  'pages/PAGE-000001/desktop/full-page.png',
];

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------------------------------------------

describe('createChatGptBundle', () => {
  it('puts manifest, run, summary, findings, pages and the Evidence index first, then the related screenshots in path order', async () => {
    const result = edgeCaseAuditRun();
    // 見本の前提: 関係するスクリーンショットのパスは、この3つである。
    expect([
      screenshotPathOf(result, EDGE_SHOTS.desktopViewport),
      screenshotPathOf(result, EDGE_SHOTS.desktopFullPage),
      screenshotPathOf(result, EDGE_SHOTS.secondDesktopViewport),
    ].sort()).toEqual(EDGE_RELATED_SCREENSHOT_PATHS);

    const entries = unzipSync(await bundleOf(result));

    expect(Object.keys(entries)).toEqual([
      'manifest.json',
      'run.json',
      'summary.json',
      'findings.json',
      'pages.json',
      'evidence-index.json',
      // R16f: 各ページの page.json（パスの順）を、evidence-index.json の後、スクリーンショットの前に入れる。
      ...EDGE_PAGE_JSON_PATHS,
      ...EDGE_RELATED_SCREENSHOT_PATHS,
    ]);
    expect(JSON_FILE_PATHS).toEqual(Object.keys(entries).slice(0, JSON_FILE_PATHS.length));
    expect(EDGE_PAGE_JSON_PATHS).toEqual(result.pages.map((value) => pageArtifactRelativePath(value.pageId, 'page')).sort());
  });

  it('lists every file but the manifest itself with its byte length and SHA-256, and the facts of the Run', async () => {
    const result = edgeCaseAuditRun();
    const entries = unzipSync(await bundleOf(result));
    const manifest = jsonOf(entries, 'manifest.json') as Manifest;

    expect(CHATGPT_BUNDLE_SCHEMA_VERSION).toBe('chatgpt-bundle/1.0');
    expect(manifest).toEqual({
      bundleSchemaVersion: 'chatgpt-bundle/1.0',
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
    expect(Object.keys(entries).slice(0, 5)).toEqual(JSON_FILE_PATHS.filter((path) => path !== 'run.json'));
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

    expect(findings).toEqual(
      JSON.parse(JSON.stringify(result.findings.map((value, index) => ({
        finding: value,
        evidence: value.evidenceRefs.map((evidenceId) => {
          const location = model.findings[index]?.evidence.find((ref) => ref.evidenceId === evidenceId)?.location ?? null;
          return { evidenceId, path: location?.path ?? null, pointer: location?.pointer ?? null };
        }),
        screenshotPaths: model.findings[index]?.screenshots.map((shot) => shot.relativePath) ?? [],
      })))),
    );
    // 見本の確認: ERROR の Finding は、Desktop の2枚のスクリーンショットに関係づく。どのページにもない Evidence は、場所が null。
    const parsed = findings as readonly { readonly evidence: readonly { readonly path: string | null }[]; readonly screenshotPaths: readonly string[] }[];
    expect(parsed[0]?.screenshotPaths).toEqual(['pages/PAGE-000001/desktop/viewport.png', 'pages/PAGE-000001/desktop/full-page.png']);
    expect(parsed[6]?.evidence).toEqual([{ evidenceId: unknownEvidence, path: null, pointer: null }]);
  });

  it('puts the summary and the pages of the view model, referring to Findings and Evidence by ID and without the reason descriptions', async () => {
    const result = edgeCaseAuditRun();
    const model = buildReportViewModel(result);
    const entries = unzipSync(await bundleOf(result));
    const withoutDescription = (reasons: readonly { readonly code: string; readonly detail: string | null }[]): unknown =>
      reasons.map(({ code, detail }) => ({ code, detail }));

    expect(jsonOf(entries, 'summary.json')).toEqual(
      JSON.parse(JSON.stringify({ ...model.summary, incompleteReasons: withoutDescription(model.summary.incompleteReasons) })),
    );
    expect(jsonOf(entries, 'pages.json')).toEqual(
      JSON.parse(JSON.stringify(model.pages.map(({ findings, retryAttempts, incompleteReasons, viewports, ...rest }) => ({
        ...rest,
        incompleteReasons: withoutDescription(incompleteReasons),
        viewports: viewports.map((viewport) => ({ ...viewport, incompleteReasons: withoutDescription(viewport.incompleteReasons) })),
        findingIds: findings.map((value) => value.finding.findingId),
        retryAttempts: retryAttempts.map(({ evidence, ...attempt }) => ({
          ...attempt,
          evidenceIds: evidence.map((location) => location.evidenceId),
        })),
      })))),
    );
  });

  it('writes JSON with two-space indentation and a trailing LF, keeping codes and leaving out Japanese labels', async () => {
    const result = edgeCaseAuditRun();
    const model = buildReportViewModel(result);
    const entries = unzipSync(await bundleOf(result));
    const descriptions = model.summary.incompleteReasons.map((reason) => reason.description);
    expect(descriptions.length).toBeGreaterThan(0);

    for (const path of JSON_FILE_PATHS.filter((value) => value !== 'run.json')) {
      const text = decodeUtf8(entries[path] ?? new Uint8Array());
      expect(text, path).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
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

    expect(paths.slice(JSON_FILE_PATHS.length, EDGE_FILES_BEFORE_SCREENSHOTS)).toEqual(EDGE_PAGE_JSON_PATHS);
    expect(store.calls.slice(1, 1 + EDGE_PAGE_JSON_PATHS.length)).toEqual(EDGE_PAGE_JSON_PATHS);
    for (const path of EDGE_PAGE_JSON_PATHS) {
      expect(entries[path], path).toEqual(store.files.get(path));
    }
  });

  it('leaves out a page.json that cannot be read and records it in the manifest, in the order of the ZIP', async () => {
    const result = edgeCaseAuditRun();
    const [missingPage, presentPage] = EDGE_PAGE_JSON_PATHS as [string, string];
    const missingScreenshot = 'pages/PAGE-000001/desktop/full-page.png';
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
  const [p1Viewport, p2Viewport, p1FullPage] = EDGE_RELATED_SCREENSHOT_READ_ORDER as [string, string, string];

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

  it('puts the VIEWPORT screenshots first and leaves out a FULL_PAGE one that would go over the budget', async () => {
    const result = edgeCaseAuditRun();
    // どれも 40 バイト。パスの順（full-page.png が先）に入れると、PAGE-000002 の VIEWPORT が入らない。
    const store = sizedStore(result, [[p1Viewport, 40], [p2Viewport, 40], [p1FullPage, 40]]);
    const entries = unzipSync(await bundleOf(result, store, { screenshotBudgetBytes: 100 }));
    const manifest = jsonOf(entries, 'manifest.json') as Manifest;

    expect(screenshotEntriesOf(entries)).toEqual([p1Viewport, p2Viewport].sort());
    expect(manifest.omittedFiles).toEqual([{ path: p1FullPage, reason: 'BUNDLE_SIZE_LIMIT' }]);
    expect(manifest.files.map(({ path }) => path)).not.toContain(p1FullPage);
    expect(manifest.runStatus).toBe(result.run.runStatus);
  });

  it('still puts a smaller screenshot after one that went over the budget, keeping the path order in the ZIP', async () => {
    const result = edgeCaseAuditRun();
    // 60（入る。合計 60）→ 50（合計 110 で超えるので、入れない）→ 30（合計 90 で入る）。
    const store = sizedStore(result, [[p1Viewport, 60], [p2Viewport, 50], [p1FullPage, 30]]);
    const entries = unzipSync(await bundleOf(result, store, { screenshotBudgetBytes: 100 }));
    const manifest = jsonOf(entries, 'manifest.json') as Manifest;

    expect(screenshotEntriesOf(entries)).toEqual([p1FullPage, p1Viewport]);
    expect(manifest.omittedFiles).toEqual([{ path: p2Viewport, reason: 'BUNDLE_SIZE_LIMIT' }]);
    expect(entries[p1FullPage]?.byteLength).toBe(30);
    expect(entries[p1Viewport]?.byteLength).toBe(60);
  });

  it('puts every screenshot when the total is exactly the budget, and none when the budget is 0', async () => {
    const result = edgeCaseAuditRun();
    const sizes = [[p1Viewport, 40], [p2Viewport, 40], [p1FullPage, 40]] as const;
    const exact = unzipSync(await bundleOf(result, sizedStore(result, sizes), { screenshotBudgetBytes: 120 }));
    expect(screenshotEntriesOf(exact)).toEqual(EDGE_RELATED_SCREENSHOT_PATHS);
    expect((jsonOf(exact, 'manifest.json') as Manifest).omittedFiles).toEqual([]);

    const zero = unzipSync(await bundleOf(result, sizedStore(result, sizes), { screenshotBudgetBytes: 0 }));
    expect(screenshotEntriesOf(zero)).toEqual([]);
    // 入れなかったものは、ZIP の中の順（パスの順）に並ぶ。
    expect((jsonOf(zero, 'manifest.json') as Manifest).omittedFiles).toEqual(
      EDGE_RELATED_SCREENSHOT_PATHS.map((path) => ({ path, reason: 'BUNDLE_SIZE_LIMIT' })),
    );
    // page.json と JSON は、上限の対象ではない。
    expect(Object.keys(zero)).toEqual([...JSON_FILE_PATHS, ...EDGE_PAGE_JSON_PATHS]);
  });

  it('does not count a screenshot that cannot be read against the budget', async () => {
    const result = edgeCaseAuditRun();
    const store = sizedStore(result, [[p1Viewport, 60], [p2Viewport, 50], [p1FullPage, 40]], [p1Viewport]);
    const entries = unzipSync(await bundleOf(result, store, { screenshotBudgetBytes: 100 }));
    const manifest = jsonOf(entries, 'manifest.json') as Manifest;

    expect(screenshotEntriesOf(entries)).toEqual([p1FullPage, p2Viewport]);
    expect(manifest.omittedFiles).toEqual([{ path: p1Viewport, reason: 'ARTIFACT_FILE_NOT_FOUND' }]);
  });

  it('makes the same bytes from the same input and the same budget', async () => {
    const result = edgeCaseAuditRun();
    const sizes = [[p1Viewport, 60], [p2Viewport, 50], [p1FullPage, 30]] as const;
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

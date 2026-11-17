// AUD-1（設計書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-1a・1b・1c）: 証拠の参照（`pages/…` のファイル）と、ChatGPT 用バンドルの
// 実ファイルをそろえる。
// - AUD-1a: 表示用モデルが参照の一覧（`artifactReferences`）を 1 回だけ作る。バンドルは、入れない参照をすべて `omittedFiles`（パス・証拠 ID・理由）に出し、
//   ZIP の中の全 JSON の参照が「ZIP にある」か「欠けの一覧にある」ことを、作る時点で確かめる（fail-closed）。`pages.json` の画像のパスは、入れたものだけ。
// - AUD-1b: 最終の試行の見える範囲の画像は全部、`visible-text.txt` も入れる。指摘に関係する画像を先に入れ、ページ全体の画像は予算の余りで入れる。
// - AUD-1c: 発表の前に参照先があるかを確かめ（`missingArtifactReferencePaths`）、欠けの数を表示用モデルの事実にする。HTML とバンドルは同じ数を示す。
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { RUN_ARTIFACT_FILE_NAMES, pageArtifactRelativePath } from '../../src/core/artifact-layout.js';
import type { AuditRunResult } from '../../src/core/contracts.js';
import { CHATGPT_BUNDLE_OMISSION_REASON_CATALOG } from '../../src/presentation/catalog.js';
import { CHATGPT_BUNDLE_GUIDE_TEXT, HTML_REPORT_TEXT, screenshotMissingText } from '../../src/presentation/messages.js';
import {
  isPageArtifactReferencePath,
  missingArtifactReferencePaths,
  pageArtifactReferencePathsIn,
  type ArtifactFileExists,
} from '../../src/report/artifact-references.js';
import {
  CHATGPT_BUNDLE_FILE_NAMES,
  CHATGPT_BUNDLE_OMISSION_REASONS,
  CHATGPT_BUNDLE_SCHEMA_VERSION,
  createChatGptBundle,
  type ReadArtifactFile,
} from '../../src/report/chatgpt-bundle.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildPublishedReportViewModel, buildReportViewModel, type ReportViewModel } from '../../src/report/view-model.js';
import { edgeCaseAuditRun } from '../helpers/audit-run-fixture.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 見本の Run の参照（`edgeCaseAuditRun` の page.json の中の順）。 */
const EDGE = Object.freeze({
  page1Json: 'pages/PAGE-000001/page.json',
  page1Text: 'pages/PAGE-000001/visible-text.txt',
  retryDesktop: 'pages/PAGE-000001/retry-1/desktop/viewport.png',
  page1Desktop: 'pages/PAGE-000001/desktop/viewport.png',
  page1FullPage: 'pages/PAGE-000001/desktop/full-page.png',
  page1Mobile: 'pages/PAGE-000001/mobile/viewport.png',
  page2Json: 'pages/PAGE-000002/page.json',
  page2Text: 'pages/PAGE-000002/visible-text.txt',
  page2Desktop: 'pages/PAGE-000002/desktop/viewport.png',
});

/** 書き出し済みの Run のディレクトリの代わり。`sizes` で画像の大きさを変える。`missing` は置かない。 */
function store(
  result: AuditRunResult,
  options: { readonly missing?: readonly string[]; readonly sizes?: Readonly<Record<string, number>> } = {},
): { readonly files: Map<string, Uint8Array>; readonly calls: string[]; readonly read: ReadArtifactFile; readonly exists: ArtifactFileExists } {
  const files = new Map<string, Uint8Array>();
  files.set(RUN_ARTIFACT_FILE_NAMES.run, encoder.encode(JSON.stringify(result.run)));
  for (const value of result.pages) {
    files.set(pageArtifactRelativePath(value.pageId, 'page'), encoder.encode(`${JSON.stringify(value, null, 2)}\n`));
    files.set(pageArtifactRelativePath(value.pageId, 'visibleText'), encoder.encode(`text of ${value.pageId}\n`));
    for (const record of value.evidence) {
      if (record.type === 'screenshot') {
        const path = record.payload.relativePath;
        files.set(path, new Uint8Array(options.sizes?.[path] ?? 10).fill(1));
      }
    }
  }
  for (const path of options.missing ?? []) {
    files.delete(path);
  }
  const calls: string[] = [];
  return {
    files,
    calls,
    read: async (relativePath) => {
      calls.push(relativePath);
      const bytes = files.get(relativePath);
      return bytes === undefined ? null : Uint8Array.from(bytes);
    },
    exists: async (relativePath) => {
      calls.push(relativePath);
      return files.has(relativePath);
    },
  };
}

interface Omitted {
  readonly path: string;
  readonly evidenceIds: readonly string[];
  readonly reason: string;
}

interface Bundle {
  readonly entries: Readonly<Record<string, Uint8Array>>;
  readonly manifest: { readonly bundleSchemaVersion: string; readonly omittedFiles: readonly Omitted[]; readonly missingArtifactCount: number | null };
}

async function bundleOf(model: ReportViewModel, result: AuditRunResult, read: ReadArtifactFile): Promise<Bundle> {
  const entries = unzipSync(await createChatGptBundle(model, result, read));
  const manifest = JSON.parse(decoder.decode(entries[CHATGPT_BUNDLE_FILE_NAMES.manifest])) as Bundle['manifest'];
  return { entries, manifest };
}

/** ZIP の中の各 JSON の、ZIP にも欠けの一覧にもない参照（説明のない参照）。 */
function unexplainedReferences(bundle: Bundle): Record<string, string[]> {
  const omitted = new Set(bundle.manifest.omittedFiles.map(({ path }) => path));
  const unexplained: Record<string, string[]> = {};
  for (const [name, bytes] of Object.entries(bundle.entries)) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const missing = pageArtifactReferencePathsIn(JSON.parse(decoder.decode(bytes)) as unknown).filter(
      (path) => bundle.entries[path] === undefined && !omitted.has(path),
    );
    if (missing.length > 0) {
      unexplained[name] = missing;
    }
  }
  return unexplained;
}

describe('AUD-1a: the list of the artifact references of the view model', () => {
  it('recognizes only the paths of the page artifacts (page.json, visible-text.txt and the screenshots), not a link of the site', () => {
    for (const path of Object.values(EDGE)) {
      expect(isPageArtifactReferencePath(path), path).toBe(true);
    }
    for (const value of ['pages/about.html', 'pages/PAGE-1/page.json', 'pages/PAGE-000001/other.png', 'pages/PAGE-000001/tablet/viewport.png', '/pages/PAGE-000001/page.json', 'run.json', 42, null]) {
      expect(isPageArtifactReferencePath(value), String(value)).toBe(false);
    }
  });

  it('has every reference of page.json and of the pages of the view model, once, with the kind, the Evidence IDs, the page, the viewport and the attempt', () => {
    const result = edgeCaseAuditRun();
    const model = buildReportViewModel(result);
    const fromPageJson = result.pages.flatMap((value) => pageArtifactReferencePathsIn(value));
    const fromPages = pageArtifactReferencePathsIn(model.pages);
    const paths = model.artifactReferences.map(({ path }) => path);

    expect(new Set(paths).size).toBe(paths.length);
    expect([...paths].sort()).toEqual([...new Set([...fromPageJson, ...fromPages])].sort());
    expect(model.artifactReferences.find(({ path }) => path === EDGE.retryDesktop)).toEqual({
      path: EDGE.retryDesktop,
      kind: 'SCREENSHOT',
      captureType: 'VIEWPORT',
      evidenceIds: ['EV-SHOT-000002'],
      pageId: 'PAGE-000001',
      viewport: 'desktop',
      retryAttempt: 1,
      relatedFindingIds: [],
      missing: false,
    });
    expect(model.artifactReferences.find(({ path }) => path === EDGE.page1Text)).toMatchObject({
      kind: 'VISIBLE_TEXT',
      captureType: null,
      evidenceIds: ['EV-DOM-000003'],
      viewport: 'desktop',
      retryAttempt: null,
    });
    expect(model.artifactReferences.find(({ path }) => path === EDGE.page1Json)).toMatchObject({ kind: 'PAGE_JSON', evidenceIds: [], viewport: null });
    // 発表の前の確かめをしていない表示用モデルは、欠けの数が「未確認」（null）。
    expect(model.missingArtifactCount).toBeNull();
  });
});

describe('AUD-1a・1b: the bundle puts or explains every reference', () => {
  it('puts every screenshot (the retry one too) and the visible text, and leaves nothing out when every file is there', async () => {
    const result = edgeCaseAuditRun();
    const model = buildReportViewModel(result);
    const bundle = await bundleOf(model, result, store(result).read);

    // 版の期待は `chatgpt-bundle.test.ts` の 1 か所（REC-4 で 2.0）。
    expect(bundle.manifest.bundleSchemaVersion).toBe(CHATGPT_BUNDLE_SCHEMA_VERSION);
    // AUD-1d: 再試行の前の試行の画像も入れる（集めた証拠は外さない）。
    for (const path of [EDGE.page1Desktop, EDGE.page1Mobile, EDGE.page2Desktop, EDGE.page1Text, EDGE.page2Text, EDGE.page1FullPage, EDGE.retryDesktop]) {
      expect(bundle.entries[path], path).toBeDefined();
    }
    expect(bundle.manifest.omittedFiles).toEqual([]);
    expect(unexplainedReferences(bundle)).toEqual({});
    // pages.json の画像のパスは、ZIP に入れたものだけ。
    const pages = JSON.parse(decoder.decode(bundle.entries[CHATGPT_BUNDLE_FILE_NAMES.pages])) as unknown;
    expect(pageArtifactReferencePathsIn(pages).filter((path) => bundle.entries[path] === undefined)).toEqual([]);
    expect(bundle.manifest.missingArtifactCount).toBeNull();
  });

  it('keeps page.json as read', async () => {
    const result = edgeCaseAuditRun();
    const files = store(result);
    const bundle = await bundleOf(buildReportViewModel(result), result, files.read);

    expect(bundle.entries[EDGE.page1Json]).toEqual(files.files.get(EDGE.page1Json));
  });

  it('reads the screenshots related to a Finding first, then the other viewport ones, then the full-page ones, then the retry one', async () => {
    const result = edgeCaseAuditRun();
    const files = store(result);
    await bundleOf(buildReportViewModel(result), result, files.read);

    // AUD-1b の順のまま（部に詰める順）。AUD-1d: 再試行の前の試行の画像は最後。
    expect(files.calls.filter((path) => path.endsWith('.png'))).toEqual([
      EDGE.page1Desktop, EDGE.page2Desktop, EDGE.page1Mobile, EDGE.page1FullPage, EDGE.retryDesktop,
    ]);
  });

  it('has a closed list of the omission reasons, each with a description in the display catalog, and explains them in the guide', async () => {
    // AUD-1d: 残る理由は、ファイルがないことだけ。
    expect(CHATGPT_BUNDLE_OMISSION_REASONS).toEqual(['ARTIFACT_FILE_NOT_FOUND']);
    expect(Object.keys(CHATGPT_BUNDLE_OMISSION_REASON_CATALOG).sort()).toEqual([...CHATGPT_BUNDLE_OMISSION_REASONS].sort());
    const result = edgeCaseAuditRun();
    const bundle = await bundleOf(buildReportViewModel(result), result, store(result).read);
    const guide = decoder.decode(bundle.entries[CHATGPT_BUNDLE_FILE_NAMES.readme]);
    expect(guide).toContain(`## ${CHATGPT_BUNDLE_GUIDE_TEXT.artifactsHeading}`);
    for (const reason of CHATGPT_BUNDLE_OMISSION_REASONS) {
      expect(guide).toContain(CHATGPT_BUNDLE_OMISSION_REASON_CATALOG[reason].description);
    }
  });

  it('fails to make the bundle when a JSON in the ZIP refers to a file that is neither put nor explained', async () => {
    const result = edgeCaseAuditRun();
    const model = buildReportViewModel(result);
    // 参照の一覧から、再試行の前の画像を落とした表示用モデル（page.json はその画像を参照したまま）。
    const broken: ReportViewModel = { ...model, artifactReferences: model.artifactReferences.filter(({ path }) => path !== EDGE.retryDesktop) };

    await expect(createChatGptBundle(broken, result, store(result).read)).rejects.toThrow(EDGE.retryDesktop);
  });
});

describe('AUD-1c: the check of the references before publishing', () => {
  it('finds the references whose file is missing, and the HTML and the bundle show the same count', async () => {
    const result = edgeCaseAuditRun();
    const missing = [EDGE.page1Desktop, EDGE.page1Text];
    const files = store(result, { missing });
    const firstModel = buildReportViewModel(result);
    const found = await missingArtifactReferencePaths(firstModel.artifactReferences, files.exists);
    expect([...found].sort()).toEqual([...missing].sort());

    const model = buildReportViewModel(result, { missingArtifactPaths: found });
    expect(model.missingArtifactCount).toBe(2);
    expect(model.artifactReferences.filter((reference) => reference.missing).map(({ path }) => path).sort()).toEqual([...missing].sort());

    const bundle = await bundleOf(model, result, files.read);
    expect(bundle.manifest.missingArtifactCount).toBe(2);
    expect(bundle.manifest.omittedFiles.filter(({ reason }) => reason === 'ARTIFACT_FILE_NOT_FOUND').map(({ path }) => path).sort()).toEqual(
      [...missing].sort(),
    );
    expect(unexplainedReferences(bundle)).toEqual({});

    const html = renderHtmlReport(model);
    expect(html).toContain(HTML_REPORT_TEXT.record.missingArtifacts('2'));
    expect(html).toContain(screenshotMissingText);
    // 欠けがなければ、HTML は欠けの文を出さない。
    expect(renderHtmlReport(buildReportViewModel(result, { missingArtifactPaths: [] }))).not.toContain(screenshotMissingText);
  });

  // AUD-1d（ユーザーの判断 2026-11-09）: ファイルがないときも、作る処理は止めない。欠けの一覧に、起きたことを残す。
  it('keeps making the bundle when a file found before publishing is gone afterwards, and lists that file', async () => {
    const result = edgeCaseAuditRun();
    const model = buildReportViewModel(result, { missingArtifactPaths: [] });
    const bundle = await bundleOf(model, result, store(result, { missing: [EDGE.page2Desktop] }).read);

    expect(bundle.manifest.omittedFiles).toEqual([{ path: EDGE.page2Desktop, evidenceIds: ['EV-SHOT-000011'], reason: 'ARTIFACT_FILE_NOT_FOUND' }]);
    expect(unexplainedReferences(bundle)).toEqual({});
  });

  it('builds the view model to publish after checking the references once each, keeping the other facts', async () => {
    const result = edgeCaseAuditRun();
    const files = store(result, { missing: [EDGE.page2Desktop] });
    const model = await buildPublishedReportViewModel(result, files.exists, { plannedWriteScreenCount: 2 });

    expect(model.missingArtifactCount).toBe(1);
    expect(model.artifactReferences.filter((reference) => reference.missing).map(({ path }) => path)).toEqual([EDGE.page2Desktop]);
    expect(model.overview.plannedWriteScreenCount).toBe(2);
    expect([...files.calls].sort()).toEqual(model.artifactReferences.map(({ path }) => path).sort());
    expect(model).toEqual(buildReportViewModel(result, { plannedWriteScreenCount: 2, missingArtifactPaths: [EDGE.page2Desktop] }));
  });

  it('rejects a missing path that is not one of the references', () => {
    expect(() => buildReportViewModel(edgeCaseAuditRun(), { missingArtifactPaths: ['pages/PAGE-000009/page.json'] })).toThrow(RangeError);
  });
});

// AUD-1d（ユーザーの判断 2026-11-09「徹底的に端から端まで監査できなければ価値が無い」）: 集めた証拠を、BeakSight の都合（大きさの上限）で外さない。
// 1 つの ZIP に入りきらないときは、部（第 1 部・第 2 部…）に分ける。欠けの一覧に残るのは、本当にファイルがない（ARTIFACT_FILE_NOT_FOUND）ものだけ。
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { RUN_ARTIFACT_FILE_NAMES, pageArtifactRelativePath } from '../../src/core/artifact-layout.js';
import type { AuditRunResult } from '../../src/core/contracts.js';
import { CHATGPT_BUNDLE_GUIDE_TEXT } from '../../src/presentation/messages.js';
import { pageArtifactReferencePathsIn, type BundleArtifactFiles } from '../../src/report/artifact-references.js';
import {
  CHATGPT_BUNDLE_FILE_NAMES,
  CHATGPT_BUNDLE_OMISSION_REASONS,
  createChatGptBundle,
  createChatGptBundleParts,
  prepareChatGptBundleParts,
  type ReadArtifactFile,
} from '../../src/report/chatgpt-bundle.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { createPageId, createSha256FingerprintOfBytes } from '../../src/core/ids.js';
import { auditRun, dom, edgeCaseAuditRun, page } from '../helpers/audit-run-fixture.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const RETRY_SHOT = 'pages/PAGE-000001/retry-1/desktop/viewport.png';

/** 書き出し済みの Run のディレクトリの代わり（画像は 40 バイト、見える文字は 10 バイト）。`missing` は置かない。 */
function store(result: AuditRunResult, missing: readonly string[] = []): ReadArtifactFile {
  const files = new Map<string, Uint8Array>();
  files.set(RUN_ARTIFACT_FILE_NAMES.run, encoder.encode(JSON.stringify(result.run)));
  for (const value of result.pages) {
    files.set(pageArtifactRelativePath(value.pageId, 'page'), encoder.encode(JSON.stringify(value)));
    files.set(pageArtifactRelativePath(value.pageId, 'visibleText'), new Uint8Array(10).fill(65));
    for (const record of value.evidence) {
      if (record.type === 'screenshot') {
        files.set(record.payload.relativePath, new Uint8Array(40).fill(1));
      }
    }
  }
  for (const path of missing) {
    files.delete(path);
  }
  return async (path) => files.get(path) ?? null;
}

interface PartManifest {
  readonly partCount: number;
  readonly partSizeBytes: number;
  readonly files: readonly { readonly path: string; readonly part: number }[];
  readonly omittedFiles: readonly { readonly path: string; readonly reason: string }[];
}

async function partsOf(result: AuditRunResult, read: ReadArtifactFile, partSizeBytes: number) {
  const model = buildReportViewModel(result);
  const parts = await createChatGptBundleParts(model, result, read, { partSizeBytes });
  const entries = parts.map((part) => unzipSync(part.bytes));
  const manifest = JSON.parse(decoder.decode(entries[0]?.[CHATGPT_BUNDLE_FILE_NAMES.manifest])) as PartManifest;
  return { model, parts, entries, manifest };
}

describe('AUD-1d: the bundle in parts, leaving no collected evidence out', () => {
  it('leaves nothing out for the size and splits the files into parts, with the retry screenshot too', async () => {
    const result = edgeCaseAuditRun();
    const { parts, entries, manifest } = await partsOf(result, store(result), 60);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((part) => [part.partNumber, part.partCount])).toEqual(parts.map((_, index) => [index + 1, parts.length]));
    expect(manifest.omittedFiles).toEqual([]);
    expect(entries.some((part) => part[RETRY_SHOT] !== undefined)).toBe(true);
    // 欠けの理由は、ファイルがないことだけ。
    expect(CHATGPT_BUNDLE_OMISSION_REASONS).toEqual(['ARTIFACT_FILE_NOT_FOUND']);
  });

  // 設計者の判断 (a)（2026-11-09）: 第 1 部には、バンドルが組み立てる JSON と run.json だけを入れる。page.json は、画像より先に、第 1 部の残りと次の部に詰める。
  it('puts the JSON made by the bundle in the first part, and page.json, the visible texts and the screenshots in the first part and the next parts', async () => {
    const result = edgeCaseAuditRun();
    const { entries } = await partsOf(result, store(result), 60);
    const first = Object.keys(entries[0] ?? {});
    for (const name of [
      CHATGPT_BUNDLE_FILE_NAMES.manifest,
      CHATGPT_BUNDLE_FILE_NAMES.readme,
      RUN_ARTIFACT_FILE_NAMES.run,
      CHATGPT_BUNDLE_FILE_NAMES.summary,
      CHATGPT_BUNDLE_FILE_NAMES.findingsByRule,
      // REC-4: 第 1 部は入口だけ（指摘はページごとのファイルにあり、第 1 部には、その場所の一覧がある）。
      CHATGPT_BUNDLE_FILE_NAMES.findingFiles,
      CHATGPT_BUNDLE_FILE_NAMES.findingGroups,
      CHATGPT_BUNDLE_FILE_NAMES.pages,
      CHATGPT_BUNDLE_FILE_NAMES.links,
    ]) {
      expect(first, name).toContain(name);
    }
    // この見本では、バンドルの JSON だけで目安を超えるので、page.json は第 2 部以降にある。
    expect(first.filter((name) => name.startsWith('pages/'))).toEqual([]);
    const later = entries.slice(1).flatMap((part) => Object.keys(part));
    for (const name of ['pages/PAGE-000001/page.json', 'pages/PAGE-000002/page.json']) {
      expect(later, name).toContain(name);
    }
    // 後の部の JSON は、指摘のファイル（REC-4）と page.json だけ。
    expect(later.filter((name) => name.endsWith('.json') && !name.endsWith('/page.json'))).toEqual(
      ['pages/PAGE-000001/findings.json', 'pages/PAGE-000002/findings.json', 'run-findings.json'],
    );
  });

  it('lists every file with its part in the manifest, and the union of the parts covers every reference', async () => {
    const result = edgeCaseAuditRun();
    const { model, entries, manifest } = await partsOf(result, store(result), 60);

    const actual = entries.flatMap((part, index) => Object.keys(part).filter((name) => name !== CHATGPT_BUNDLE_FILE_NAMES.manifest).map((path) => ({ path, part: index + 1 })));
    expect(manifest.files.map(({ path, part }) => ({ path, part }))).toEqual(actual);
    expect(manifest.partCount).toBe(entries.length);
    const inZip = new Set(entries.flatMap((part) => Object.keys(part)));
    for (const reference of model.artifactReferences) {
      expect(inZip.has(reference.path), reference.path).toBe(true);
    }
    for (const part of entries) {
      for (const [name, bytes] of Object.entries(part)) {
        if (name.endsWith('.json')) {
          expect(pageArtifactReferencePathsIn(JSON.parse(decoder.decode(bytes))).filter((path) => !inZip.has(path)), name).toEqual([]);
        }
      }
    }
  });

  it('tells in the guide of each part which part of how many it is', async () => {
    const result = edgeCaseAuditRun();
    const { entries } = await partsOf(result, store(result), 60);
    entries.forEach((part, index) => {
      const guide = decoder.decode(part[CHATGPT_BUNDLE_FILE_NAMES.readme]);
      expect(guide.split('\n')[2], `part ${index + 1}`).toBe(CHATGPT_BUNDLE_GUIDE_TEXT.partOf(String(entries.length), String(index + 1)));
    });
  });

  it('keeps making the bundle when a file is missing, and lists only that file', async () => {
    const result = edgeCaseAuditRun();
    const missing = 'pages/PAGE-000002/desktop/viewport.png';
    const { manifest, entries } = await partsOf(result, store(result, [missing]), 60);
    expect(manifest.omittedFiles).toEqual([{ path: missing, evidenceIds: ['EV-SHOT-000011'], reason: 'ARTIFACT_FILE_NOT_FOUND' }]);
    expect(entries.length).toBeGreaterThan(1);
  });

  it('makes one part with everything when the part size is large, and createChatGptBundle gives that one ZIP', async () => {
    const result = edgeCaseAuditRun();
    const { parts } = await partsOf(result, store(result), 64 * 1024 * 1024);
    expect(parts).toHaveLength(1);
    const single = unzipSync(await createChatGptBundle(buildReportViewModel(result), result, store(result)));
    const onePart = unzipSync(parts[0]?.bytes ?? new Uint8Array());
    // 中身は同じ（manifest の部の大きさの目安だけが違う: 1 つにまとめた ZIP は null）。
    expect(Object.keys(single)).toEqual(Object.keys(onePart));
    for (const name of Object.keys(single).filter((key) => key !== CHATGPT_BUNDLE_FILE_NAMES.manifest)) {
      expect(single[name], name).toEqual(onePart[name]);
    }
    expect(JSON.parse(decoder.decode(single[CHATGPT_BUNDLE_FILE_NAMES.manifest]))).toMatchObject({ partCount: 1, partSizeBytes: null });
    expect(single[RETRY_SHOT]).toBeDefined();
  });
});

// 設計者の判断 (a)（2026-11-09。実サイトの page.json は平均 0.43MB・最大 1.16MB。ページの上限を外す方針）: page.json の多い Run でも、第 1 部に page.json を
// 入れず、どの部も目安を大きく超えない。1 つのファイルだけで目安を超えるものは、そのファイル 1 つで 1 部にする。
describe('AUD-1d: a Run with many page.json files', () => {
  const PAGE_COUNT = 40;
  const PART_SIZE = 3_000;
  const HUGE_PAGE_INDEX = 7;

  function manyPagesRun(): AuditRunResult {
    return auditRun({
      pages: Array.from({ length: PAGE_COUNT }, (_, index) => {
        const pageId = createPageId(index + 1);
        return page(pageId, `/p${index}.html`, 'AUDITED', [dom(index + 1, pageId, 'desktop', `page ${index}`)], []);
      }),
      findings: [],
    });
  }

  /** page.json は 600 バイト（1 つだけ 10,000 バイト。JSON として読めるよう、空白で埋める）。見える文字は 10 バイト。 */
  function manyPagesFiles(result: AuditRunResult): ReadonlyMap<string, Uint8Array> {
    const files = new Map<string, Uint8Array>();
    files.set(RUN_ARTIFACT_FILE_NAMES.run, encoder.encode(JSON.stringify(result.run)));
    result.pages.forEach((value, index) => {
      const json = JSON.stringify(value);
      const size = Math.max(index === HUGE_PAGE_INDEX ? 10_000 : 600, json.length);
      files.set(pageArtifactRelativePath(value.pageId, 'page'), encoder.encode(json + ' '.repeat(size - json.length)));
      files.set(pageArtifactRelativePath(value.pageId, 'visibleText'), new Uint8Array(10).fill(65));
    });
    return files;
  }

  it('keeps page.json out of the first part, puts a huge one alone, and keeps every other part within the size', async () => {
    const result = manyPagesRun();
    const files = manyPagesFiles(result);
    const { entries, manifest } = await partsOf(result, async (path) => files.get(path) ?? null, PART_SIZE);
    const sizesOf = (part: Readonly<Record<string, Uint8Array>>): readonly number[] =>
      Object.entries(part).filter(([name]) => name !== CHATGPT_BUNDLE_FILE_NAMES.manifest && name !== CHATGPT_BUNDLE_FILE_NAMES.readme).map(([, bytes]) => bytes.byteLength);

    expect(Object.keys(entries[0] ?? {}).filter((name) => name.endsWith('/page.json'))).toEqual([]);
    const huge = pageArtifactRelativePath(createPageId(HUGE_PAGE_INDEX + 1), 'page');
    const hugePart = entries.find((part) => part[huge] !== undefined);
    expect(Object.keys(hugePart ?? {}).filter((name) => name !== CHATGPT_BUNDLE_FILE_NAMES.readme)).toEqual([huge]);
    for (const [index, part] of entries.entries()) {
      const sizes = sizesOf(part);
      if (index > 0 && sizes.length > 1) {
        expect(sizes.reduce((sum, size) => sum + size, 0), `part ${index + 1}`).toBeLessThanOrEqual(PART_SIZE);
      }
    }
    // どのページの page.json がどの部にあるかは、manifest だけで分かる（実際に入っている部と同じ）。
    for (const value of result.pages) {
      const path = pageArtifactRelativePath(value.pageId, 'page');
      const listed = manifest.files.find((file) => file.path === path)?.part;
      expect(listed, path).toBeDefined();
      expect(entries[(listed ?? 0) - 1]?.[path], path).toBeDefined();
    }
    expect(manifest.omittedFiles).toEqual([]);
  });

  // MEM-2（DEF-266）: 大きさと sha256 は先に測り（中身を持たない）、部ごとに、その部のファイルだけを読んで作る。バイト列は、まとめて作る形と同じ。
  it('reads the files of one part at a time while making the parts, with the same bytes (MEM-2)', async () => {
    const result = manyPagesRun();
    const files = manyPagesFiles(result);
    const model = buildReportViewModel(result);
    let held = 0;
    let maxHeld = 0;
    const preparationReads: string[] = [];
    let preparing = true;
    const bundleFiles: BundleArtifactFiles = {
      measure: async (path) => {
        const bytes = files.get(path);
        return bytes === undefined ? null : { byteLength: bytes.byteLength, sha256: createSha256FingerprintOfBytes(bytes) };
      },
      read: async (path) => {
        const bytes = files.get(path) ?? null;
        if (preparing) {
          preparationReads.push(path);
        } else {
          held += bytes?.byteLength ?? 0;
          maxHeld = Math.max(maxHeld, held);
        }
        return bytes;
      },
    };

    const prepared = await prepareChatGptBundleParts(model, result, bundleFiles, { partSizeBytes: PART_SIZE });
    preparing = false;
    const streamed: Uint8Array[] = [];
    for await (const part of prepared.parts()) {
      streamed.push(part.bytes);
      held = 0;
    }

    const whole = await createChatGptBundleParts(model, result, async (path) => files.get(path) ?? null, { partSizeBytes: PART_SIZE });
    expect(streamed).toEqual(whole.map(({ bytes }) => bytes));
    expect(prepared.partCount).toBe(whole.length);
    // 用意の段で読むのは、参照を確かめる JSON だけ（画像や見える文字は読まない）。部を作る段では、1 つの部の分（いちばん大きいファイル 1 つか、目安）を超えて持たない。
    expect(preparationReads.every((path) => path.endsWith('.json'))).toBe(true);
    const largestFile = Math.max(...[...files.values()].map((bytes) => bytes.byteLength));
    expect(maxHeld).toBeLessThanOrEqual(Math.max(PART_SIZE, largestFile));
  });
});

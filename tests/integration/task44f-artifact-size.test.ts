// T44f（Task 44 の設計書 P3-1。指示書 `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/T44f-brief.md`）: 成果物の大きさの内訳を測る（判定はしない）。
// ふだんの `npm test` では流さない（`TASK44F_SIZE=1` のときだけ）。結果は Markdown の表で `TASK44F_SIZE_OUTPUT` のファイルに書く（省略すると一時のフォルダの
// `beaksight-task44f-size.md`）。
// - サイト: DEF-143 の重いページの fixture（`startHeavyPageSite`。127.0.0.1 だけ）。ページ数と行の数は `TASK44F_PAGES`・`TASK44F_ROWS`（既定 5・200）。
// - 設定: 製品の既定（幅の走査・スクリーンショット・Interaction・性能・アクセシビリティ）に、出力先・画面の上限・読み込みの間隔 0 だけを重ねる。
// - 数えるもの: ファイルごとの大きさ、`audit.json` の項目ごとの大きさ（Run、ページ（Evidence の種類ごと、ページの Finding、ビューポート）、Finding）、
//   `page.json` との重なり、ChatGPT 用バンドルの中のファイル（`evidence-index.json` の項目ごと）、`report.html` の節ごと。字下げの分（同じ値を字下げなしで
//   書いた大きさ）も数える。
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeAuditRun } from '../../src/cli/audit-run.js';
import { RUN_ARTIFACT_FILE_NAMES } from '../../src/core/artifact-layout.js';
import type { Finding, PageAuditResult, RunSummary } from '../../src/core/contracts.js';
import { STRESS_VIEWPORT_HEIGHT, collectLayoutEvidence } from '../../src/evidence/layout-collector.js';
import { REPORT_CLASS_NAMES } from '../../src/report/html-tokens.js';
import { formatBytes, markdownTable } from '../helpers/audit-metrics.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { startHeavyPageSite } from '../helpers/large-checkpoint-fixture.js';
import { readRunArtifactFiles } from '../helpers/run-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

const ENABLED = process.env['TASK44F_SIZE'] === '1';
const PAGES = Number(process.env['TASK44F_PAGES'] ?? '5');
const ROWS = Number(process.env['TASK44F_ROWS'] ?? '200');
const TIMEOUT_MS = 1_800_000;

const encoder = new TextEncoder();
/** 成果物の書式（字下げ 2 文字）の大きさ。 */
const indentedBytes = (value: unknown): number => encoder.encode(`${JSON.stringify(value, null, 2)}\n`).byteLength;
/** 字下げなしの大きさ。 */
const compactBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

/** 名前ごとの大きさを足す。 */
const addTo = (map: Map<string, number>, name: string, bytes: number): void => {
  map.set(name, (map.get(name) ?? 0) + bytes);
};

const rowsOf = (map: Map<string, number>, total: number): (readonly [string, string, string])[] =>
  [...map].sort(([, left], [, right]) => right - left).map(([name, bytes]) => [name, formatBytes(bytes), `${((bytes / total) * 100).toFixed(1)}%`] as const);

// T44R2 の I-6（P1-5 の落ち着きの待ちの予備）: 重いページの fixture で、幅の走査の幅ごとの形を測る時間（`collectLayoutEvidence`）を測る（判定はしない）。
// `TASK44F_LAYOUT_TIME=1` のときだけ流れる。行の数は `TASK44F_LAYOUT_ROWS`（既定 200,1000）、回数は `TASK44F_LAYOUT_REPEATS`（既定 3）。結果は標準出力に書く。
describe.runIf(process.env['TASK44F_LAYOUT_TIME'] === '1')('T44R2 I-6: the time to measure the layout of the heavy pages at the stress widths', () => {
  it('measures collectLayoutEvidence at 320, 768 and 1024 px', async () => {
    const rowsList = (process.env['TASK44F_LAYOUT_ROWS'] ?? '200,1000').split(',').map(Number);
    const repeats = Number(process.env['TASK44F_LAYOUT_REPEATS'] ?? '3');
    const browser = await launchHeadlessChromium();
    const lines: string[] = [];
    try {
      for (const rows of rowsList) {
        const site = await startHeavyPageSite(2, rows);
        try {
          for (const width of [320, 768, 1024]) {
            const times: number[] = [];
            for (let attempt = 0; attempt < repeats; attempt += 1) {
              const viewport = { width, height: STRESS_VIEWPORT_HEIGHT };
              const context = await browser.newContext({ viewport });
              try {
                const page = await context.newPage();
                await page.goto(`${site.origin}${site.pagePath(2)}`, { waitUntil: 'load' });
                const started = performance.now();
                const collected = await collectLayoutEvidence(page, viewport, { deadlineAtMs: Date.now() + TIMEOUT_MS });
                times.push(performance.now() - started);
                expect(collected.status).not.toBe('DEADLINE_EXCEEDED');
              } finally {
                await context.close();
              }
            }
            lines.push(`rows ${String(rows)} width ${String(width)}: ${times.map((ms) => ms.toFixed(0)).join(', ')} ms (max ${Math.max(...times).toFixed(0)})`);
          }
        } finally {
          await site.close();
        }
      }
    } finally {
      await browser.close();
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  }, TIMEOUT_MS);
});

describe.runIf(ENABLED)('T44f: the composition of the artifact sizes on the heavy pages', () => {
  it('measures the sizes of audit.json, page.json, the bundle and report.html by item', async () => {
    const site = await startHeavyPageSite(PAGES, ROWS);
    const outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-task44f-'));
    try {
      const config = createTestConfig(site.origin, site.pagePath(1), {
        target: { id: 'task44f-heavy' },
        crawl: { maxPages: PAGES, minNavigationIntervalMs: 0 },
        output: { directory: outputDirectory },
      });
      const outcome = await executeAuditRun(config, { launchBrowser: () => launchHeadlessChromium(), clock: () => new Date(), now: () => Date.now() }, { startNew: true });
      if (outcome.kind !== 'RAN') throw new Error(`the audit did not run: ${outcome.kind}`);
      const files = await readRunArtifactFiles(outcome.runDirectory);
      const sizeOf = (path: string): number => files.find((file) => file.path === path)?.bytes.byteLength ?? 0;
      const bundle = files.find((file) => file.path.endsWith('.zip') && !file.path.includes('!/'));
      const auditText = readFileSync(join(outcome.runDirectory, RUN_ARTIFACT_FILE_NAMES.audit), 'utf8');
      const audit = JSON.parse(auditText) as { readonly run: RunSummary; readonly pages: readonly PageAuditResult[]; readonly findings: readonly Finding[] };
      const auditBytes = encoder.encode(auditText).byteLength;

      // 1. ファイル。
      const fileRows = files.filter((file) => !file.path.startsWith('pages/') || file.path.endsWith('page.json'))
        .map((file) => [file.path, formatBytes(file.bytes.byteLength)] as const);
      const pageJsonTotal = files.filter((file) => file.path.startsWith('pages/') && file.path.endsWith('/page.json'))
        .reduce((sum, file) => sum + file.bytes.byteLength, 0);

      // 2. audit.json の項目。
      const auditItems = new Map<string, number>();
      addTo(auditItems, 'run', indentedBytes(audit.run));
      addTo(auditItems, 'findings（最上位）', indentedBytes(audit.findings));
      for (const page of audit.pages) {
        for (const record of page.evidence) {
          addTo(auditItems, `pages[].evidence（${record.type}）`, indentedBytes(record));
        }
        addTo(auditItems, 'pages[].findings', indentedBytes(page.findings));
        addTo(auditItems, 'pages[].viewports', indentedBytes(page.viewports));
      }
      const pageFindingIds = new Set(audit.pages.flatMap((page) => page.findings.map(({ findingId }) => findingId)));
      const duplicatedFindings = audit.findings.filter(({ findingId }) => pageFindingIds.has(findingId)).length;

      // 3. Evidence の種類ごとの数と、字下げの分。
      const evidenceCounts = new Map<string, number>();
      for (const page of audit.pages) {
        for (const record of page.evidence) addTo(evidenceCounts, record.type, 1);
      }

      // 4. バンドルの中のファイル。
      const bundleRows = files.filter((file) => bundle !== undefined && file.path.startsWith(`${bundle.path}!/`) && !file.path.endsWith('.png'))
        .map((file) => [file.path.slice((bundle?.path.length ?? 0) + 2), formatBytes(file.bytes.byteLength)] as const)
        .filter(([path]) => !path.startsWith('pages/') || path === 'pages/PAGE-000001/page.json');
      const bundlePageJsons = files.filter((file) => bundle !== undefined && file.path.startsWith(`${bundle.path}!/pages/`) && file.path.endsWith('page.json'))
        .reduce((sum, file) => sum + file.bytes.byteLength, 0);
      const indexFile = files.find((file) => bundle !== undefined && file.path === `${bundle.path}!/evidence-index.json`);
      const index = indexFile === undefined ? [] : JSON.parse(new TextDecoder().decode(indexFile.bytes)) as readonly Record<string, unknown>[];
      const indexItems = new Map<string, number>();
      for (const entry of index) {
        for (const [key, value] of Object.entries(entry)) addTo(indexItems, key, indentedBytes({ [key]: value }) - indentedBytes({}));
      }
      const relatedTotal = index.reduce((sum, entry) => sum + (Array.isArray(entry['relatedFindingIds']) ? entry['relatedFindingIds'].length : 0), 0);

      // 5. report.html の節（最上位の見出し `<h2 id="…">` の始まりで分ける）と、Finding の行の大きさ。
      const html = readFileSync(join(outcome.runDirectory, RUN_ARTIFACT_FILE_NAMES.report), 'utf8');
      const htmlItems = new Map<string, number>();
      const parts = html.split('<h2 id="');
      addTo(htmlItems, '（最初の節の前。CSS を含む）', encoder.encode(parts[0] ?? '').byteLength);
      for (const part of parts.slice(1)) {
        const id = /^([^"]+)"/u.exec(part)?.[1] ?? '（id なし）';
        addTo(htmlItems, id, encoder.encode(`<h2 id="${part}`).byteLength);
      }
      const htmlBytes = encoder.encode(html).byteLength;
      const findingRows = html.match(new RegExp(`<tr [^>]*class="${REPORT_CLASS_NAMES.findingRow}"[\\s\\S]*?</tr>`, 'gu')) ?? [];
      const findingRowBytes = findingRows.reduce((sum, row) => sum + encoder.encode(row).byteLength, 0);

      // 6. 中身を確かめるための写し（`TASK44F_KEEP_DIR` のときだけ。report.html と、1 ページ目の page.json）。
      const keep = process.env['TASK44F_KEEP_DIR'];
      if (keep !== undefined) {
        writeFileSync(join(keep, 'report.html'), html, 'utf8');
        writeFileSync(join(keep, 'page-1.json'), readFileSync(join(outcome.runDirectory, 'pages', 'PAGE-000001', 'page.json')));
        writeFileSync(join(keep, 'audit-findings.json'), JSON.stringify(audit.findings.slice(0, 20), null, 2), 'utf8');
      }
      const output = process.env['TASK44F_SIZE_OUTPUT'] ?? join(tmpdir(), 'beaksight-task44f-size.md');
      writeFileSync(output, [
        `測った日時: ${new Date().toISOString()}。重いページ ${String(PAGES)} 枚 × ${String(ROWS)} 行。製品の既定の設定（テストの既定の Chromium）。`,
        '',
        '## ファイル',
        '',
        markdownTable(['ファイル', '大きさ'], fileRows),
        '',
        `page.json の合計: ${formatBytes(pageJsonTotal)}。audit.json: ${formatBytes(auditBytes)}（字下げなしなら ${formatBytes(compactBytes(audit))}）。`,
        '',
        '## audit.json の項目（字下げ 2 文字で数えた大きさ）',
        '',
        markdownTable(['項目', '大きさ', '割合'], rowsOf(auditItems, auditBytes)),
        '',
        `最上位の findings ${String(audit.findings.length)} 件のうち、ページの findings と同じ ID のもの ${String(duplicatedFindings)} 件。`,
        `Evidence の数: ${[...evidenceCounts].map(([type, count]) => `${type} ${String(count)}`).join('、')}。`,
        '',
        '## ChatGPT 用バンドルの中（スクリーンショットとページの page.json を除く。page.json は 1 つだけ例に出す）',
        '',
        markdownTable(['ファイル', '大きさ'], bundleRows),
        '',
        `バンドルの ZIP: ${formatBytes(bundle?.bytes.byteLength ?? 0)}。中の page.json の合計: ${formatBytes(bundlePageJsons)}。`,
        `evidence-index.json の件数 ${String(index.length)}、relatedFindingIds の合計 ${String(relatedTotal)}。項目ごと: `
          + rowsOf(indexItems, indexFile?.bytes.byteLength ?? 1).map(([name, bytes, rate]) => `${name} ${bytes}（${rate}）`).join('、'),
        '',
        '## report.html の節',
        '',
        markdownTable(['節（数字は N）', '大きさ', '割合'], rowsOf(htmlItems, htmlBytes)),
        '',
        `report.html: ${formatBytes(htmlBytes)}。Finding の行 ${String(findingRows.length)} 行、合計 ${formatBytes(findingRowBytes)}。`
          + `run.json: ${formatBytes(sizeOf('run.json'))}。`,
        '',
      ].join('\n'), 'utf8');
      expect(site.nonReadRequests()).toBe(0);
    } finally {
      await site.close();
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});

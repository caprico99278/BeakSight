/**
 * DEF-143（設計書 `2026-10-20-beaksight-worker-heartbeat-heavy-steps-design.md`）: 大きなページの保存を持つ Run を作るテストの補助（テストのファイルではない）。
 * - 重いページの fixture のサーバ（`startHeavyPageSite`）: 127.0.0.1 だけで待ち受け、GET と HEAD だけに答える。`/heavy/p<n>.html` は、多数の行（低い
 *   コントラストの文字、ラベルのない入力、alt のない画像、リンク、ボタン）を持つ。1 ページ目だけが、すべてのページへのリンクを持つ（巡回の記録に全ページが入る）。
 * - 保存の大きな写し（`inflateCheckpoint`）: 本物の Run が止めた後の保存（`checkpoint/state.json` と、監査を終えた 1 ページの保存）を雛形にして、巡回の記録の
 *   先頭から `completedPages` ページを、監査を終えたページにする。各ページの保存は雛形の写しで、ページの ID・URL、Evidence と Finding の ID を、ページごとに
 *   付け直す（ID が Run の中で重ならない）。採番器の連番は、付け直した ID より後にする。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkpointArtifactRelativePath, checkpointPageArtifactRelativePath } from '../../src/core/artifact-layout.js';
import type { PageId } from '../../src/core/contracts.js';
import { startLoopbackHttpServer } from './loopback-server.js';

/** 重いページの fixture のサーバ。 */
export interface HeavyPageSite {
  readonly origin: string;
  /** `n` ページ目のパス（1 から）。 */
  pagePath(n: number): string;
  /** GET と HEAD 以外の要求の数。 */
  nonReadRequests(): number;
  close(): Promise<void>;
}

/** 1 ページ目以外のページが持つ、ほかのページへのリンクの数。 */
const OTHER_PAGE_LINKS = 20;
/** 画像の種類の数（同じ画像を何度も読む）。 */
const IMAGE_VARIANTS = 20;
/** 1 画素の PNG。 */
const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PAGE_PATTERN = /^\/heavy\/p(\d+)\.html$/u;

const pagePath = (n: number): string => `/heavy/p${n}.html`;

/** 重いページの HTML（`rows` 行）。 */
const heavyPageHtml = (index: number, pageCount: number, rows: number): string => {
  const linkCount = index === 1 ? pageCount : Math.min(OTHER_PAGE_LINKS, pageCount);
  const links = Array.from({ length: linkCount }, (_, i) => `<a href="${pagePath(i + 1)}">ページ ${i + 1}</a>`).join(' ');
  const body = Array.from({ length: rows }, (_, row) => [
    `<tr id="row-${row}">`,
    `<td><span style="color:#bbb;background:#ccc">行 ${row} の項目 ${index}</span></td>`,
    `<td><a href="${pagePath((row % pageCount) + 1)}">詳細 ${row}</a></td>`,
    `<td><input type="text" value="値 ${row}"></td>`,
    `<td><img src="/heavy/img/${row % IMAGE_VARIANTS}.png" alt=""></td>`,
    `<td><button type="button" aria-expanded="false">開く ${row}</button></td>`,
    '</tr>',
  ].join('')).join('\n');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>重いページ ${index}</title></head>`
    + `<body><h1>重いページ ${index}</h1><nav>${links}</nav><table>${body}</table></body></html>`;
};

/** 重いページの fixture のサーバを起動する（`pageCount` ページ、各 `rows` 行）。 */
export async function startHeavyPageSite(pageCount: number, rows: number): Promise<HeavyPageSite> {
  let nonRead = 0;
  const server = await startLoopbackHttpServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      nonRead += 1;
      response.writeHead(405).end();
      return;
    }
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
    const match = PAGE_PATTERN.exec(pathname);
    const index = match === null ? Number.NaN : Number(match[1]);
    if (Number.isInteger(index) && index >= 1 && index <= pageCount) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(heavyPageHtml(index, pageCount, rows));
      return;
    }
    if (pathname.startsWith('/heavy/img/')) {
      response.writeHead(200, { 'content-type': 'image/png' }).end(ONE_PIXEL_PNG);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  return {
    origin: server.origin,
    pagePath,
    nonReadRequests: () => nonRead,
    close: () => server.close(),
  };
}

/** 保存の大きな写しの結果。 */
export interface InflatedCheckpoint {
  /** 監査を終えたページの数。 */
  readonly completedPages: number;
  /** 書いたページの保存の大きさの合計と最大（バイト）。 */
  readonly totalBytes: number;
  readonly maxBytes: number;
}

/** 連番の幅（`src/core/ids.ts` の `formatSequence` と同じ 6 桁以上）。 */
const SEQUENCE_WIDTH = 6;
/** ページごとに Evidence と Finding の連番をずらす量（雛形の 1 ページの連番の数より大きい）。 */
const EVIDENCE_SEQUENCE_STRIDE = 10_000;
const FINDING_SEQUENCE_STRIDE = 100_000;

const sequenceText = (sequence: number): string => String(sequence).padStart(SEQUENCE_WIDTH, '0');

interface MutableCheckpointState {
  frontier: { entries: { url: string; pageId: PageId; state: string; skipReason: unknown }[] };
  allocator: { nextPageSequence: number; nextEvidenceSequence: number; nextFindingSequence: number };
  progress: { pagesStarted: number };
  completedPageIds: PageId[];
}

/**
 * 止めた Run の保存（`runDirectory` の `checkpoint/`）を、巡回の記録の先頭から `completedPages` ページを監査を終えたページにした、大きな保存にする。
 * 各ページの保存は、雛形のページ（`templatePageId`。監査を終えたページ）の写しで、ページの ID・URL、Evidence と Finding の ID を付け直す。
 * 残りのページは、止めたときのまま（再開で待ち行列に戻る）。`state.prev.json` は変えない（`state.json` が使える）。
 */
export async function inflateCheckpoint(runDirectory: string, templatePageId: PageId, completedPages: number): Promise<InflatedCheckpoint> {
  const statePath = join(runDirectory, checkpointArtifactRelativePath('state'));
  const state = JSON.parse(await readFile(statePath, 'utf8')) as MutableCheckpointState;
  const template = await readFile(join(runDirectory, checkpointPageArtifactRelativePath(templatePageId)), 'utf8');
  const templateUrl = state.frontier.entries.find(({ pageId }) => pageId === templatePageId)?.url;
  if (templateUrl === undefined || completedPages > state.frontier.entries.length) {
    throw new Error('the checkpoint cannot be inflated');
  }
  let totalBytes = 0;
  let maxBytes = 0;
  const completed: PageId[] = [];
  for (const [index, entry] of state.frontier.entries.slice(0, completedPages).entries()) {
    const shift = index + 1;
    const text = template
      .split(templatePageId).join(entry.pageId)
      .split(JSON.stringify(templateUrl)).join(JSON.stringify(entry.url))
      .replace(/EV-([A-Z]+)-(\d{6,})/gu, (_, type: string, sequence: string) => `EV-${type}-${sequenceText(Number(sequence) + shift * EVIDENCE_SEQUENCE_STRIDE)}`)
      .replace(/FIND-(\d{6,})/gu, (_, sequence: string) => `FIND-${sequenceText(Number(sequence) + shift * FINDING_SEQUENCE_STRIDE)}`);
    await writeFile(join(runDirectory, checkpointPageArtifactRelativePath(entry.pageId)), text, 'utf8');
    const bytes = Buffer.byteLength(text, 'utf8');
    totalBytes += bytes;
    maxBytes = Math.max(maxBytes, bytes);
    entry.state = 'AUDITED';
    entry.skipReason = null;
    completed.push(entry.pageId);
  }
  state.completedPageIds = completed;
  state.progress.pagesStarted = completedPages;
  state.allocator.nextEvidenceSequence = (completedPages + 2) * EVIDENCE_SEQUENCE_STRIDE;
  state.allocator.nextFindingSequence = (completedPages + 2) * FINDING_SEQUENCE_STRIDE;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return { completedPages, totalBytes, maxBytes };
}

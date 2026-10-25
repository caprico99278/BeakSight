// T44R2 の I-4（Task 44 の設計書の履歴の「T44R2 …と設計者の判断」の行）: Guard と factory の守りが起こした例外（Service Worker の登録の拒否、
// WebRTC の構築子の例外）は、サイトの欠陥ではないので、PAGE_ERROR の Finding にしない。再レビューの実験（misc.exp.ts）の形を、確かめの形にした。
// 公開の監査（CLI の Run）で、ページが、捕捉せずに Service Worker を登録し、WebRTC の構築子を呼ぶ。あわせて、ページ自身の捕捉されない例外（名前は同じ
// でも文言の違うもの）も起こす。
// - 守りの例外は、PAGE_ERROR の Finding にならない（desktop と mobile のどちらでも）。
// - ページ自身の例外は、今どおり PAGE_ERROR の Finding になる。
// - page.json の Evidence（記録した事実）には、守りの例外も残る（Rule の側だけで見分ける）。
// BN-b（`2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` の 3.2）: BeakSight の起動の引数（`--disable-shared-workers`）で
// SharedWorker がないときに、ページが捕捉せずに `new SharedWorker` を呼んで起こる `ReferenceError` も、PAGE_ERROR の Finding にしない。
// ページ自身の `ReferenceError`（別の名前の未定義）は、今どおり Finding になる。
// Chromium はテストの既定と CLI の起動の設定の両方。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { cliTargetConfig, readRunArtifactFiles, runCliInProcess } from '../helpers/run-harness.js';

const TEST_TIMEOUT_MS = 240_000;

/** ページ自身の例外の文言（守りの例外と、名前は同じで文言が違う）。 */
const PAGE_OWN_SECURITY_ERROR = 'page own security failure';
const PAGE_OWN_NOT_SUPPORTED_ERROR = 'page own unsupported failure';

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>guard page errors</title></head>
<body><main><h1>guard page errors</h1><p>本文</p></main>
<script>if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js'); }</script>
<script>new RTCPeerConnection();</script>
<script>Promise.reject(new DOMException('${PAGE_OWN_SECURITY_ERROR}', 'SecurityError'));</script>
<script>throw new DOMException('${PAGE_OWN_NOT_SUPPORTED_ERROR}', 'NotSupportedError');</script>
</body></html>`;

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];

/** ページ自身の、別の名前の未定義の関数（SharedWorker の例外と、名前は同じで文言が違う `ReferenceError` を起こす）。 */
const PAGE_OWN_UNDEFINED_FUNCTION = 'pageOwnUndefinedFunction';

/** BN-b: 捕捉せずに `new SharedWorker` を呼ぶページ（ページ自身の `ReferenceError` も起こす）。 */
const SHARED_WORKER_PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>shared worker page errors</title></head>
<body><main><h1>shared worker page errors</h1><p>本文</p></main>
<script>new SharedWorker('/shared-worker.js');</script>
<script>${PAGE_OWN_UNDEFINED_FUNCTION}();</script>
</body></html>`;

interface AuditFinding {
  readonly ruleId?: string;
  readonly message?: string;
}

/** CLI の Run の結果から、PAGE_ERROR の Finding の文言と、1 ページ目の page.json の本文を読む。 */
async function pageErrorsOfRun(runDirectory: string): Promise<{ readonly pageErrorMessages: readonly string[]; readonly pageJson: string }> {
  const files = await readRunArtifactFiles(runDirectory);
  const textOf = (path: string): string => {
    const file = files.find((candidate) => candidate.path === path);
    if (file === undefined) throw new Error(`missing ${path}`);
    return Buffer.from(file.bytes).toString('utf8');
  };
  const audit = JSON.parse(textOf('audit.json')) as {
    readonly findings?: readonly AuditFinding[];
    readonly pages?: readonly { readonly findings?: readonly AuditFinding[] }[];
  };
  const findings = [...(audit.findings ?? []), ...(audit.pages ?? []).flatMap((page) => page.findings ?? [])];
  return {
    pageErrorMessages: findings.filter((finding) => finding.ruleId === 'PAGE_ERROR').map((finding) => finding.message ?? ''),
    pageJson: textOf('pages/PAGE-000001/page.json'),
  };
}

/** 1 つの HTML を `/` で返す、127.0.0.1 の fixture のサーバ（ほかのパスは 404）。 */
function startSinglePageServer(html: string): Promise<LoopbackHttpServer> {
  return startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
    request.on('data', () => undefined);
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
      } else if (url.pathname === '/sw.js' || url.pathname === '/shared-worker.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' }).end('/* worker */');
      } else {
        response.writeHead(404).end();
      }
    });
  });
}

/** 1 ページだけを監査する CLI の Run（画面の写し・性能・アクセシビリティ・Interaction は切る）。 */
function runSinglePageAudit(directory: string, name: string, origin: string, launch: () => Promise<Browser>): ReturnType<typeof runCliInProcess> {
  return runCliInProcess({
    directory,
    name,
    config: cliTargetConfig(name, origin, '/', {
      audit: { screenshots: false, performance: false, accessibility: false, interactions: false },
      crawl: { minNavigationIntervalMs: 0, maxPages: 1 },
    }),
    launchBrowser: () => launch(),
  });
}

describe.each(LAUNCHERS)('T44R2 I-4: the exceptions raised by the guards are not PAGE_ERROR findings, with %s', (_label, launch) => {
  let server: LoopbackHttpServer;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'beaksight-t44r2-i4-'));
    server = await startSinglePageServer(PAGE);
  });

  afterAll(async () => {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('writes PAGE_ERROR findings only for the page own exceptions, and keeps every exception in page.json', async () => {
    const outcome = await runSinglePageAudit(directory, 't44r2-i4', server.origin, launch);
    const { pageErrorMessages, pageJson } = await pageErrorsOfRun(outcome.runDirectory);

    // 守りの例外は、Finding にならない。
    expect(pageErrorMessages.filter((message) => message.includes('ServiceWorker') || message.includes('RTCPeerConnection'))).toEqual([]);
    // ページ自身の例外は、今どおり Finding になる（desktop と mobile）。
    expect(pageErrorMessages.filter((message) => message.includes(PAGE_OWN_SECURITY_ERROR)).length).toBeGreaterThan(0);
    expect(pageErrorMessages.filter((message) => message.includes(PAGE_OWN_NOT_SUPPORTED_ERROR)).length).toBeGreaterThan(0);
    // Evidence（記録した事実）は変えない: 守りの例外も page.json に残る。
    expect(pageJson).toContain('Failed to register a ServiceWorker');
    expect(pageJson).toContain("Failed to construct 'RTCPeerConnection'");
  }, TEST_TIMEOUT_MS);
});

describe.each(LAUNCHERS)('BN-b: the SharedWorker exception caused by the launch arguments is not a PAGE_ERROR finding, with %s', (_label, launch) => {
  let server: LoopbackHttpServer;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'beaksight-bn-b-'));
    server = await startSinglePageServer(SHARED_WORKER_PAGE);
  });

  afterAll(async () => {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('writes no PAGE_ERROR finding for the SharedWorker exception, keeps the page own ReferenceError, and keeps both in page.json', async () => {
    const outcome = await runSinglePageAudit(directory, 'bn-b', server.origin, launch);
    const { pageErrorMessages, pageJson } = await pageErrorsOfRun(outcome.runDirectory);

    // SharedWorker の例外は、Finding にならない（desktop と mobile のどちらでも）。
    expect(pageErrorMessages.filter((message) => message.includes('SharedWorker'))).toEqual([]);
    // ページ自身の ReferenceError は、今どおり Finding になる。ほかの PAGE_ERROR の Finding はない。
    expect(pageErrorMessages.length).toBeGreaterThan(0);
    expect(pageErrorMessages.every((message) => message.includes(`ReferenceError: ${PAGE_OWN_UNDEFINED_FUNCTION} is not defined`))).toBe(true);
    // Evidence（記録した事実）は変えない: SharedWorker の例外も page.json に残る。
    expect(pageJson).toContain('SharedWorker is not defined');
    expect(pageJson).toContain(`${PAGE_OWN_UNDEFINED_FUNCTION} is not defined`);
  }, TEST_TIMEOUT_MS);
});

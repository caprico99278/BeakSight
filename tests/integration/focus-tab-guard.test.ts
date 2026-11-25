// AUD-3（設計書 `doc/design/2026-11-19-beaksight-audit-result-review-fixes-design.md` 6.2 の 4）の安全の結合のテスト（両方の Chromium）。
// - 通常の Tab の確かめの間に、ページが keydown・focus で出す POST は、監査の段の送信の扱い（`PASS_EXCEPT_DELETE` と `READ_ONLY`）のまま扱われ、記録されずに
//   サーバへ届く要求は 0。BeakSight の読み込み（画面の GET）は、主の読み込みのほかに増えない。全部の後に、名前つきの時間だけ待って確かめ直す。
// - REV-AUD3 の I-3: フォーカスが値を入れる欄に来たら Tab を押さずに終える（Tab で欄の中身を変え、サイトの自動保存を起こさない）。2 回目の M-A・M-B:
//   role の文字の欄・closed な影の木の中の欄でも止め、始めから欄にフォーカスがあれば、欄から外してから押す。
// 仮のサイトは 127.0.0.1 のサーバで、一般の文言だけを使う。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditSendPolicyName } from '../../src/core/audit-send-policy.js';
import type { PageAuditOutcome } from '../../src/core/contracts.js';
import { wait } from '../../src/core/deadline.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { auditSendOptionsOf } from '../../src/orchestration/audit-send-options.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { BOTH_CHROMIUM_LAUNCHERS, testContextsOf, useSharedRunBrowser, withoutBrowserFaviconRequestLines } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

/** 全部の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
const PATH = '/tab-sends';

/**
 * 直の focus で隠れたままのリンク（Tab の確かめの候補）があり、ページが Tab の keydown と focus のたびに POST を出し、keydown のたびに読み取りの目印
 * （`/key-mark`。Tab を押したかをサーバで見る）を送る画面。
 */
const PAGE = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>送信</title></head><body>'
  + '<a id="hidden" href="#main" style="position: absolute; left: -9999px; top: 0">本文へ</a>'
  + '<main id="main"><h1>見出し</h1><button type="button">押す</button><a href="#main">戻る</a></main>'
  + '<script>addEventListener("keydown", (e) => { if (e.key !== "Tab") return; new Image().src = "/key-mark";'
  + ' fetch("/key-post", { method: "POST", body: "k" }).catch(() => undefined);'
  // 2026-11-16 の決まり: サイト自身の削除の通信は、送信の扱いのまま（PASS_EXCEPT_DELETE では通して記録する）。
  + ' fetch("/key-delete", { method: "DELETE" }).catch(() => undefined); }, true);'
  + 'addEventListener("focusin", () => { fetch("/focus-post", { method: "POST", body: "f" }).catch(() => undefined); }, true);</script>'
  + '</body></html>';

/** Tab のキーで字を入れて自動保存する（`/autosave` へ POST）、欄の keydown の処理（`field` は欄の要素を表す式）。 */
const saveOnTab = (field: string): string => `${field}.addEventListener("keydown", (e) => { if (e.key !== "Tab") return; e.preventDefault();`
  + ` ${field}.value = (${field}.value ?? "") + "\\t"; fetch("/autosave", { method: "POST", body: "t" }).catch(() => undefined); });`;
/** 先頭の隠れたリンク（文書の先頭からなら Tab で届く）と、前のボタン、欄 `field`、後のボタンの画面。 */
const editorPage = (field: string, script: string): string => '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,">'
  + '<title>編集</title></head><body><a id="hidden" href="#main" style="position: absolute; left: -9999px; top: 0">本文へ</a>'
  + `<main id="main"><button type="button">前</button>${field}<button type="button">後</button></main>`
  + `<script>addEventListener("keydown", (e) => { if (e.key === "Tab") new Image().src = "/key-mark"; }, true);${script}</script></body></html>`;
/**
 * REV-AUD3 の I-3・2 回目の M-A・M-B: Tab のキーで字を入れて自動保存する欄の形（文字の欄、role の文字の欄、closed な影の木の中の欄、始めからフォーカスの
 * ある欄）。
 */
const EDITOR_PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/editor': editorPage('<textarea id="ed">abc</textarea>', saveOnTab('document.getElementById("ed")')),
  '/role-textbox': editorPage('<div id="ed" role="textbox" tabindex="0" aria-label="本文">abc</div>', saveOnTab('document.getElementById("ed")')),
  '/closed-shadow': editorPage('<x-ed></x-ed>', 'customElements.define("x-ed", class extends HTMLElement { constructor() { super();'
    + ' const root = this.attachShadow({ mode: "closed" }); root.innerHTML = "<textarea>abc</textarea>"; const t = root.querySelector("textarea");'
    + ` ${saveOnTab('t')} } });`),
  '/autofocus': editorPage('<textarea id="ed" autofocus>abc</textarea>', saveOnTab('document.getElementById("ed")')),
});

const PAGES: Readonly<Record<string, string>> = Object.freeze({ [PATH]: PAGE, ...EDITOR_PAGES });

const requests: string[] = [];
let server: LoopbackHttpServer;

beforeAll(async () => {
  server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push(`${request.method ?? ''} ${path}`);
    request.resume();
    const page = PAGES[path];
    response.writeHead(200, { 'content-type': page === undefined ? 'text/plain' : 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(page ?? 'ok');
  });
});

afterAll(async () => {
  await server.close();
});

/** 1 つの画面を、送信の扱い `sendPolicy` で、見るだけの点検で監査する。Guard が通して記録した読み取りでない要求（`<method> <path>` の数）を返す。 */
async function auditPage(
  browser: Browser,
  sendPolicy: AuditSendPolicyName,
  path = PATH,
): Promise<{ readonly outcome: PageAuditOutcome; readonly passed: ReadonlyMap<string, number> }> {
  requests.length = 0;
  const ledgers: SafetyLedger[] = [];
  const config = createTestConfig(server.origin, path, {
    viewports: { stressWidths: [] },
    audit: { performance: false, accessibility: false, screenshots: false, interactions: false, sendPolicy },
  });
  const navigationPacer = createTestNavigationPacer(config);
  const allocator = new IdAllocator();
  const root = await mkdtemp(join(tmpdir(), 'beaksight-focus-tab-'));
  try {
    const auditor = new PageAuditor({
      contextFactory: new BrowserContextFactory(browser, config, () => {
        const ledger = new SafetyLedger();
        ledgers.push(ledger);
        return ledger;
      }, { ...TEST_FACTORY_OPTIONS, navigationPacer, ...auditSendOptionsOf(config, []) }),
      config,
      allocator,
      clock: () => new Date(),
      now: () => Date.now(),
      screenshotRootDirectory: root,
      navigationPacer,
      safetyViolationRecorded: () => false,
    });
    const normalized = normalizeUrl(`${server.origin}${path}`, `${server.origin}${path}`, new Set());
    if (!normalized.ok) throw new Error('fixture URL must normalize');
    const outcome = await auditor.audit(normalized.url, allocator.allocatePageId());
    const passed = new Map<string, number>();
    for (const ledger of ledgers) {
      for (const row of ledger.snapshot().passedAuditSendRequests?.requests ?? []) {
        passed.set(`${row.method} ${row.path}`, (passed.get(`${row.method} ${row.path}`) ?? 0) + row.count);
      }
    }
    return { outcome, passed };
  } finally {
    for (const context of testContextsOf(browser)) await context.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

/** 届いた読み取りでない要求のうち、Guard が通して記録した数を超えて届いたもの。 */
const unrecordedOf = (passed: ReadonlyMap<string, number>): readonly string[] => {
  const counts = new Map<string, number>();
  for (const line of withoutBrowserFaviconRequestLines(requests).filter((value) => !value.startsWith('GET '))) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return [...counts].filter(([line, count]) => count > (passed.get(line) ?? 0)).map(([line]) => line);
};

/** 主の読み込みの数（ビューポートごとに 1 回。確かめ直しは読み込みでない）。 */
const mainLoadsOf = (outcome: PageAuditOutcome): number =>
  outcome.result.evidence.filter((record) => record.type === 'dom' && record.capture?.phase !== 'recheck').length;

describe.each(BOTH_CHROMIUM_LAUNCHERS)('AUD-3: the page sends during the sequential Tab (%s)', (_name, launch) => {
  const sharedBrowser = useSharedRunBrowser(launch);

  it.each(['PASS_EXCEPT_DELETE', 'READ_ONLY'] as const)('keeps the send policy %s, without unrecorded requests and without more loads', async (sendPolicy) => {
    const { outcome, passed } = await auditPage(await sharedBrowser(), sendPolicy);
    const check = (): void => {
      const lines = withoutBrowserFaviconRequestLines(requests);
      // Tab を押した（ページの目印が届いた）。
      expect(lines).toContain('GET /key-mark');
      expect(unrecordedOf(passed)).toEqual([]);
      if (sendPolicy === 'READ_ONLY') {
        expect(lines.filter((line) => !line.startsWith('GET '))).toEqual([]);
      } else {
        // Tab の keydown の POST は、通して記録した上で届いた。
        expect(lines).toContain('POST /key-post');
      }
      // BeakSight の読み込みは、主の読み込みだけ。
      expect(lines.filter((line) => line === `GET ${PATH}`)).toHaveLength(mainLoadsOf(outcome));
    };
    check();
    await wait(LATE_REQUEST_WAIT_MS);
    check();
  });

  it.each(Object.keys(EDITOR_PAGES))('REV-AUD3: does not type Tab into the editor of %s, so that it does not change and save', async (path) => {
    const { outcome, passed } = await auditPage(await sharedBrowser(), 'PASS_EXCEPT_DELETE', path);
    // 先頭から届く隠れたリンクを「届かない」と決めない。
    expect(outcome.result.evidence.flatMap((record) => (record.type === 'focus' ? record.payload.items : [])).map(({ sequentialTab }) => sequentialTab?.reached))
      .not.toContain(false);
    const check = (): void => {
      const lines = withoutBrowserFaviconRequestLines(requests);
      // Tab の確かめを始めた（始めから欄にフォーカスがあっても、欄の外から押す）。
      expect(lines).toContain('GET /key-mark');
      expect(lines).not.toContain('POST /autosave');
      expect(unrecordedOf(passed)).toEqual([]);
      expect(lines.filter((line) => line === `GET ${path}`)).toHaveLength(mainLoadsOf(outcome));
    };
    check();
    await wait(LATE_REQUEST_WAIT_MS);
    check();
  });
});

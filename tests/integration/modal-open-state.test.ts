// AUD-2（設計書 `doc/design/2026-11-19-beaksight-audit-result-review-fixes-design.md` 5.3 と「REV-AUD2 の後の判断」）の結合のテスト（両方の Chromium）。
// - 使い捨ての Context の押下の後に、押す前になかったモーダルの小窓が見えるようになった事実も `VERIFIED` の根拠にし、開いた状態を点検する（属性の変わらない
//   ボタンで小窓が開く形）。何も開かないボタンは今どおり `NO_OBSERVABLE_CHANGE`。
// - REV-AUD2 の I-1: 開いた状態がモーダルなら、入れ子の点検は小窓の中の候補だけを押す（背景のボタンを押さない）。
// - DEF-294: 覆われた対象は押さずに理由を残す（違反にならず、待ち続けない）。全面のアプリの殻（I-2）は暗転とみなさず、案内は今どおり隠して指摘にする。
// - どの画面でも、Guard の違反は 0 で、サーバに届くのは読み取りの要求だけ（全部の後に、名前つきの時間だけ待って確かめ直す）。
// 仮のサイトは 127.0.0.1 のサーバで、一般の文言だけを使う。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { PageAuditOutcome } from '../../src/core/contracts.js';
import { wait } from '../../src/core/deadline.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { MODAL_DIALOG_OPENED_CHANGED_FIELD } from '../../src/evidence/interaction-collector.js';
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

const head = (title: string): string =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${title}</title></head><body>`;
const TOGGLE = 'onclick="this.setAttribute(\'aria-expanded\', \'true\')"';

/**
 * 属性の変わらないボタンで、閉じる語のないモーダルの小窓（暗転は別の要素）が開く画面。小窓の中に開閉のボタン、背景に開閉のボタン（小窓が開いている間に押されると
 * 目印の読み取りを送る）と、何も開かないボタン。
 */
const OPEN_PAGE = `${head('小窓')}<main><h1>予定</h1><button type="button" id="open">詳しい内容</button><button type="button" id="nothing">印</button>`
  + '<button type="button" id="bg" aria-expanded="false">背景の項目</button></main>'
  + '<div id="backdrop" hidden style="position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 10;"></div>'
  + '<div id="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" hidden'
  + ' style="position: fixed; left: 20vw; top: 20vh; width: 60vw; height: 60vh; background: rgb(255, 255, 255); z-index: 11;">'
  + `<h2 id="dialog-title">予定の詳しい内容</h2><p>一般の案内の文です。</p><button type="button" aria-expanded="false" ${TOGGLE}>中の項目</button></div>`
  + "<script>const $ = (id) => document.getElementById(id);"
  + "$('open').addEventListener('click', () => { $('backdrop').hidden = false; $('dialog').hidden = false; });"
  + "$('bg').addEventListener('click', () => { $('bg').setAttribute('aria-expanded', 'true'); if (!$('dialog').hidden) new Image().src = '/bg-pressed-while-open'; });"
  + '</script></body></html>';

/** 役割のない全面の覆い（モーダルでない）の下の開閉のボタン。 */
const COVERED_PAGE = `${head('覆い')}<main><h1>案内</h1><button type="button" aria-expanded="false" ${TOGGLE}>項目</button></main>`
  + '<div style="position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); z-index: 100;"></div></body></html>';

/** 最初の読み込みで出る、閉じる語のない全面の同意の小窓（暗転は別の要素）と、背後の開閉のボタン。 */
const CONSENT_PAGE = `${head('同意')}<main><h1>案内</h1><button type="button" aria-expanded="false" ${TOGGLE}>項目</button></main>`
  + '<div style="position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); z-index: 100;"></div>'
  + '<div role="dialog" aria-modal="true" aria-label="クッキーの利用" style="position: fixed; left: 10vw; top: 10vh; width: 80vw; height: 80vh; background: #fff; z-index: 101;">'
  + '<p>クッキーを使います。</p><button type="button">同意する</button></div></body></html>';

/** 全面の固定の入れ物（アプリの殻）の中のページと、モーダルでない大きな案内（閉じる語なし）。 */
const SHELL_PAGE = `${head('殻')}<div id="app" style="position: fixed; inset: 0; background: #fff; overflow: auto; padding: 12px; box-sizing: border-box;">`
  + `<h1>一覧</h1><button type="button" aria-expanded="false" ${TOGGLE}>開く</button></div>`
  + '<div role="dialog" aria-label="お知らせ" style="position: fixed; left: 8vw; top: 8vh; width: 84vw; height: 84vh; background: #ffd; z-index: 5;"><p>お知らせの文です。</p></div>'
  + '</body></html>';

/** REV-AUD2 の M-a: 中心だけを別の要素（押すと送って移る、候補にならない要素）が覆う開閉のボタン。 */
const CORNER_PAGE = `${head('隅')}<main><h1>隅</h1><div style="position: relative; display: inline-block;">`
  + `<button type="button" aria-expanded="false" style="width: 240px; height: 80px;" ${TOGGLE}>対象の開閉</button>`
  + '<span style="position: absolute; left: 60px; top: 20px; width: 120px; height: 40px; background: #c00; z-index: 2;"'
  + " onclick=\"fetch('/cover-clicked', { method: 'POST' }); location.href = '/cover-nav';\">覆い</span></div></main></body></html>";

const PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/open': OPEN_PAGE, '/covered': COVERED_PAGE, '/consent': CONSENT_PAGE, '/shell': SHELL_PAGE, '/corner': CORNER_PAGE,
});

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

/** 1 つの画面を見るだけの点検で監査する（押下の点検つき）。Guard の違反の数と、届いた要求を返す。 */
async function auditPage(browser: Browser, path: string): Promise<{ readonly outcome: PageAuditOutcome; readonly violations: number; readonly received: readonly string[] }> {
  requests.length = 0;
  const ledgers: SafetyLedger[] = [];
  const config = createTestConfig(server.origin, path, {
    viewports: { stressWidths: [] },
    audit: { performance: false, accessibility: false, screenshots: false, interactions: true, sendPolicy: 'PASS_EXCEPT_DELETE' },
  });
  const navigationPacer = createTestNavigationPacer(config);
  const allocator = new IdAllocator();
  const root = await mkdtemp(join(tmpdir(), 'beaksight-modal-open-'));
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
    return {
      outcome,
      violations: ledgers.reduce((count, ledger) => count + ledger.snapshot().invariantViolations.length, 0),
      received: withoutBrowserFaviconRequestLines(requests),
    };
  } finally {
    for (const context of testContextsOf(browser)) await context.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

const interactionsOf = (outcome: PageAuditOutcome) => outcome.result.evidence.flatMap((record) => (record.type === 'interaction' ? [record.payload] : []));
/** 主の読み込みの数（ビューポートごとに 1 回。確かめ直しと開いた状態の読み取りは読み込みでない）。 */
const mainLoadsOf = (outcome: PageAuditOutcome): number => outcome.result.evidence
  .filter((record) => record.type === 'dom' && record.capture?.phase !== 'recheck' && record.capture?.phase !== 'opened-state').length;
/** 届いた要求が、画面の読み込み（主の読み込みと、押下ごとの使い捨ての Context の 1 回）だけか。 */
const onlyLoads = (path: string, outcome: PageAuditOutcome): readonly string[] =>
  Array.from({ length: mainLoadsOf(outcome) + interactionsOf(outcome).length }, () => `GET ${path}`);

describe.each(BOTH_CHROMIUM_LAUNCHERS)('AUD-2: presses around modal dialogs (%s)', (_name, launch) => {
  const sharedBrowser = useSharedRunBrowser(launch);

  it('verifies the press by the opened modal dialog, audits the open state, and presses only inside the dialog there', async () => {
    const { outcome, violations, received } = await auditPage(await sharedBrowser(), '/open');
    const interactions = interactionsOf(outcome);
    const first = (name: string) => interactions.find((payload) => payload.pressTrail === undefined && payload.evidence.before?.accessibleName === name);

    expect([first('詳しい内容')?.status, first('詳しい内容')?.evidence.changedFields]).toEqual(['VERIFIED', [MODAL_DIALOG_OPENED_CHANGED_FIELD]]);
    expect(first('詳しい内容')?.openedState?.status).toBe('AUDITED');
    expect([first('印')?.status, first('印')?.reason]).toEqual(['NOT_VERIFIABLE', 'NO_OBSERVABLE_CHANGE']);
    // 小窓が開いた状態の中で押すのは、小窓の中の候補だけ（背景の項目で開いた状態はモーダルでないので、絞らない）。
    const openedByDialog = first('詳しい内容')?.candidateId;
    expect([...new Set(interactions.filter((payload) => payload.pressTrail?.[0]?.candidateId === openedByDialog)
      .map((payload) => payload.evidence.before?.accessibleName))]).toEqual(['中の項目']);
    expect(withoutBrowserFaviconRequestLines(requests)).not.toContain('GET /bg-pressed-while-open');
    expect(violations).toBe(0);
    expect(received).toEqual(onlyLoads('/open', outcome));
    await wait(LATE_REQUEST_WAIT_MS);
    expect(withoutBrowserFaviconRequestLines(requests)).toEqual(onlyLoads('/open', outcome));
  });

  it('does not press a covered target, without a violation and without waiting for it, under a plain overlay and a first-load consent dialog', async () => {
    for (const path of ['/covered', '/consent']) {
      const { outcome, violations, received } = await auditPage(await sharedBrowser(), path);
      const covered = interactionsOf(outcome).find((payload) => payload.evidence.before?.accessibleName === '項目');
      expect([covered?.status, covered?.reason], path).toEqual(['NOT_VERIFIABLE', 'TARGET_COVERED_BY_OTHER']);
      expect(violations, path).toBe(0);
      expect(received, path).toEqual(onlyLoads(path, outcome));
      await wait(LATE_REQUEST_WAIT_MS);
      expect(withoutBrowserFaviconRequestLines(requests), path).toEqual(onlyLoads(path, outcome));
    }
  });

  it('presses a target whose centre is covered at a reachable corner, also when it presses again to reopen the state, without pressing the cover', async () => {
    const { outcome, violations, received } = await auditPage(await sharedBrowser(), '/corner');
    const interactions = interactionsOf(outcome);
    expect(interactions.filter((payload) => payload.evidence.before?.accessibleName === '対象の開閉').map((payload) => [payload.pressTrail === undefined, payload.status]))
      .toContainEqual([true, 'VERIFIED']);
    expect(interactions.some((payload) => payload.pressTrail !== undefined)).toBe(true);
    expect(violations).toBe(0);
    expect(received).toEqual(onlyLoads('/corner', outcome));
    await wait(LATE_REQUEST_WAIT_MS);
    expect(withoutBrowserFaviconRequestLines(requests)).toEqual(onlyLoads('/corner', outcome));
  });

  it('does not take a full fixed app shell as a backdrop, and hides and reports the notice as before', async () => {
    const { outcome, violations, received } = await auditPage(await sharedBrowser(), '/shell');
    const frames = outcome.result.evidence.flatMap((record) => (record.type === 'layout' && record.capture?.phase !== 'recheck'
      ? record.payload.notificationOverlay?.frames ?? [] : []));
    expect(frames.some((frame) => frame.hidden)).toBe(true);
    expect(frames.every((frame) => frame.keptOpen === undefined)).toBe(true);
    expect(outcome.result.findings.filter((finding) => finding.ruleId === 'NOTIFICATION_NOT_DISMISSIBLE').length).toBeGreaterThan(0);
    expect(violations).toBe(0);
    expect(received).toEqual(onlyLoads('/shell', outcome));
  });
});

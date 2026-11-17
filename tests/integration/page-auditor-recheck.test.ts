// AUD-2b・2d（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-2b・2d）の結合のテスト（既定の Chromium。サーバは 127.0.0.1 だけ）。
// - AUD-2b: 外枠だけを先に出し、遅れて届くデータで見出しを入れる画面では、データが届くまで待ってから測る（見出しの指摘は出ない）。
// - AUD-2d: 落ち着いた後の確かめ直し（読み込み直さない。DOM が静まるまで待ち、1 回目に違反のあった Rule だけで axe を流し直す）で、指摘ごとに
//   `PERSISTENT`（ずっとある）・`INITIAL_ONLY`（初めだけ）・`LATE`（後から）を付ける。表はビューポートの記録の `recheck` の 1 か所。
//   - 1 回目の axe の後に見出しを入れる画面: 見出しの指摘は `INITIAL_ONLY`。
//   - ずっと見出しのない画面: `PERSISTENT`。
// - AUD-2e: 確かめ直しの axe は全部のルールで流し、主の layout も集め直して Rule にかける。
//   - 1 回目の axe の後に名前のないボタンが出る画面: `A11Y_BUTTON_NAME` が `LATE`。
//   - 1 回目の後に固定の覆いが出る画面: `FIXED_ELEMENT_OCCLUSION` が `LATE`。ずっとある固定のヘッダ: `PERSISTENT`。
// - EV-3: 読み込み中の表示から完成する画面は、完成した後に測る（見出しの指摘は出ない）。表示が消えない画面の見出しの指摘は、保留の理由 `PAGE_NOT_READY`。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { artifactFilePath } from '../../src/core/artifact-layout.js';
import type { AuditRunResult, PageAuditOutcome } from '../../src/core/contracts.js';
import { findingImageRegionIndexOf } from '../../src/core/finding-image-regions.js';
import { readPngPixels } from '../helpers/png-pixels.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { testContextsOf, useHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { TEST_RUN_PROGRESS_QUIET_LIMIT_MS } from '../helpers/run-harness.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';
import { PRODUCTION_OBSERVATION_WINDOWS } from '../../src/core/observation-windows.js';

const TEST_TIMEOUT_MS = 3 * 60_000;
/** 遅れて返すデータの待ち（ms。開いた要求を「届いた」とみなす長さより短い）。 */
const DATA_DELAY_MS = 1_500;
const HEADING_RULE_ID = 'A11Y_PAGE_HAS_HEADING_ONE';
/** 回転する告知の画面で、落ち着きの待ちが終わるまでの長さの上限（テストの確かめの値。数秒。反応なしの長さ 3 分より十分に短い）。 */
const ROTATING_SETTLE_LIMIT_MS = 5_000;
/** EV-3: 読み込み中の表示を見出しへ入れ替えるまでの長さ（落ち着きの静まりの窓の数倍。前の判定では、入れ替えの前に axe を流した）。 */
const BUSY_DELAY_MS = PRODUCTION_OBSERVATION_WINDOWS.pageSettle.stableWindowMs * 8;
/** DEF-283: 送り続ける画面の送る間隔（観測の間隔の 2 倍。観測の間に新しい口の要求が始まって終わる）。 */
const SEND_INTERVAL_MS = PRODUCTION_OBSERVATION_WINDOWS.pageSettle.pollIntervalMs * 2;
/** DEF-283: 切れ目のない鎖の 1 つの読みの長さ（3 つで、開いた要求の静まりの長さを超える）。 */
const CHAIN_STEP_MS = PRODUCTION_OBSERVATION_WINDOWS.pageSettle.openDataRequestQuietMs / 2;
/** REV-WSO（DEF-283 の直しの後退）: 中身が変わらないまま続く長い鎖の 1 歩の長さと、表示を出し入れする鎖の 1 歩の長さ・歩の間。 */
const LONG_CHAIN_STEP_MS = (PRODUCTION_OBSERVATION_WINDOWS.pageSettle.openDataRequestQuietMs * 2) / 5;
const TOGGLE_STEP_MS = (PRODUCTION_OBSERVATION_WINDOWS.pageSettle.openDataRequestQuietMs * 3) / 10;
const TOGGLE_GAP_MS = (PRODUCTION_OBSERVATION_WINDOWS.pageSettle.pollIntervalMs * 3) / 2;
const SPINNER = '<div id="sp" role="progressbar" aria-label="読み込み中" style="width: 40px; height: 40px; background: #ccc"></div>';
/** `steps` 歩の鎖（新しい口を 1 歩 `stepMs` で順に読む）の後に、見出しと本文を入れる。 */
const chainPage = (steps: number, stepMs: number, spinner: boolean): string => `${head('chain')}<body>${spinner ? SPINNER : '<div id="sp"></div>'}<div id="app"></div><script>`
  + `(async () => { for (let step = 1; step <= ${String(steps)}; step += 1) { await fetch('/api/step' + step + '?ms=${String(stepMs)}').then((response) => response.json()); }`
  + " document.getElementById('sp').remove(); document.getElementById('app').innerHTML = '<main><h1>届いた見出し</h1><p>本文です。</p></main>'; })();</script></body></html>";
const SEND_TO_NEW_PATHS =`<script>let sent = 0; setInterval(() => { sent += 1; fetch('/beacon/' + sent).catch(() => {}); }, ${String(SEND_INTERVAL_MS)});</script>`;

const head = (title: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${title}</title></head>`;

const PAGES: Readonly<Record<string, string>> = Object.freeze({
  // 外枠（高さは初めから決まっている）。データが届いたら見出しと本文を入れる。
  '/late-data': `${head('late data')}<body><main style="min-height: 600px"><div id="app"><p>読み込み中</p></div></main><script>`
    + "fetch('/api/data').then((response) => response.json()).then((data) => {"
    + " document.getElementById('app').innerHTML = '<h1>' + data.title + '</h1><p>' + data.body + '</p>'; });"
    + '</script></body></html>',
  // 1 回目の axe の後に見出しを入れる: axe が入ったら（1 回目の axe の時）、遅れて返るデータを求め、届いたら見出しを入れる（1 回目の axe は、データの前に終わる。
  // 確かめ直しは、データの要求が届き、DOM が静まるまで待つ）。
  '/heading-after-axe': `${head('heading after axe')}<body><main><div id="app"><p>本文です。</p></div></main><script>`
    + 'const timer = setInterval(() => {'
    + '  if (typeof window.axe !== "object") return;'
    + '  clearInterval(timer);'
    + "  fetch('/api/data').then((response) => response.json()).then((data) => {"
    + '    const h = document.createElement("h1"); h.textContent = data.heading; document.getElementById("app").prepend(h); });'
    + '}, 10);'
    + '</script></body></html>',
  '/no-heading': `${head('no heading')}<body><main><p>見出しのない本文です。</p></main></body></html>`,
  // EV-3: 読み込み中の表示（aria-busy）だけを出し、少し後に見出しと本文へ入れ替える（DOM もデータの通信も、入れ替えまで動かない）。
  '/busy-then-heading': `${head('busy then heading')}<body><main id="app" aria-busy="true"><p>読み込み中</p></main><script>`
    + `setTimeout(() => { const app = document.getElementById('app'); app.removeAttribute('aria-busy'); app.innerHTML = '<h1>見出し</h1><p>本文です。</p>'; }, ${String(BUSY_DELAY_MS)});`
    + '</script></body></html>',
  // EV-3: 読み込み中の表示が消えない画面。
  '/busy-forever': `${head('busy forever')}<body><main aria-busy="true"><p>読み込み中</p></main></body></html>`,
  // DEF-283: 新しい path へ送り続ける画面（読み込み中の表示が消えない形と、表示のない形）。
  '/busy-sending': `${head('busy sending')}<body><main aria-busy="true"><p>読み込み中</p></main>${SEND_TO_NEW_PATHS}</body></html>`,
  '/sending': `${head('sending')}<body><main><h1>見出し</h1><p>本文です。</p></main>${SEND_TO_NEW_PATHS}</body></html>`,
  // DEF-283: 新しい口を切れ目なく順に読み、最後に見出しを入れる（DOM は最後まで変わらない）。
  '/chain': `${head('chain')}<body><main><div id="app"><p>本文です。</p></div></main><script>`
    + "(async () => { for (let step = 1; step <= 3; step += 1) { await fetch('/api/step' + step).then((response) => response.json()); }"
    + " const h = document.createElement('h1'); h.textContent = '届いた見出し'; document.getElementById('app').prepend(h); })();</script></body></html>",
  // REV-WSO: 中身が変わらないまま、確かめ直しの後まで続く鎖（表示なし 8 歩と、表示あり 6 歩）。
  '/long-chain': chainPage(8, LONG_CHAIN_STEP_MS, false),
  '/long-chain-busy': chainPage(6, LONG_CHAIN_STEP_MS, true),
  // REV-WSO: 1 歩ごとに読み込み中の表示を出し、歩の間だけ消す鎖（中身は最後まで変わらない）。
  '/toggling-steps': `${head('toggling steps')}<body><div id="app"></div><script>(async () => { for (let step = 1; step <= 10; step += 1) {`
    + " const s = document.createElement('div'); s.setAttribute('role', 'progressbar'); s.setAttribute('aria-label', '読み込み中'); s.style.cssText = 'width: 40px; height: 40px; background: #ccc'; document.body.prepend(s);"
    + ` await fetch('/api/step' + step + '?ms=${String(TOGGLE_STEP_MS)}').then((response) => response.json()); s.remove(); await new Promise((resolve) => setTimeout(resolve, ${String(TOGGLE_GAP_MS)})); }`
    + " document.getElementById('app').innerHTML = '<main><h1>届いた見出し</h1><p>本文です。</p></main>'; })();</script></body></html>",
  // AUD-2b の直し: 1 秒ごとに文字が入れ替わる告知（同じ作りの部品の文字だけが変わる。長さも変わる）。
  '/rotating': `${head('rotating')}<body><main><h1>見出し</h1><p id="notice">お知らせ 1</p></main><script>`
    + "const messages = ['お知らせ 1', '少し長いお知らせの 2', '3']; let index = 0;"
    + "setInterval(() => { index = (index + 1) % messages.length; document.getElementById('notice').textContent = messages[index]; }, 1000);"
    + '</script></body></html>',
  // AUD-2d の直し: 1 回目の axe の後に、代替の文のない画像をもう 1 つ入れる（同じ Rule の新しい要素は、確かめ直しで `LATE` の指摘になる）。
  '/late-image': `${head('late image')}<body><main><h1>見出し</h1><img id="first" src="data:," width="10" height="10"><div id="app"></div></main><script>`
    + 'const timer = setInterval(() => {'
    + '  if (typeof window.axe !== "object") return;'
    + '  clearInterval(timer);'
    + "  fetch('/api/data').then((response) => response.json()).then(() => {"
    + '    const image = document.createElement("img"); image.id = "second"; image.src = "data:,"; image.width = 10; image.height = 10;'
    + '    document.getElementById("app").append(image); });'
    + '}, 10);'
    + '</script></body></html>',
  // AUD-2e: 1 回目の axe の後に、名前のないボタンを入れる（1 回目に違反のなかったルールの新しい違反は、確かめ直しの全部のルールの axe で `LATE` になる）。
  '/late-button': `${head('late button')}<body><main><h1>見出し</h1><p>本文です。</p><div id="app"></div></main><script>`
    + 'const timer = setInterval(() => {'
    + '  if (typeof window.axe !== "object") return;'
    + '  clearInterval(timer);'
    + "  fetch('/api/data').then((response) => response.json()).then(() => {"
    + '    const button = document.createElement("button"); button.id = "late-button"; button.type = "button";'
    + '    document.getElementById("app").append(button); });'
    + '}, 10);'
    + '</script></body></html>',
  // AUD-2e: 1 回目の layout と axe の後に、内容を覆う固定の覆いを出す（確かめ直しで layout を集め直すと、覆いの指摘が `LATE` になる）。
  '/late-overlay': `${head('late overlay')}<body><main><h1>見出し</h1><p>本文です。本文です。本文です。</p><div id="app"></div></main><script>`
    + 'const timer = setInterval(() => {'
    + '  if (typeof window.axe !== "object") return;'
    + '  clearInterval(timer);'
    + "  fetch('/api/data').then((response) => response.json()).then(() => {"
    + '    const cover = document.createElement("div"); cover.id = "late-cover";'
    + '    cover.style.cssText = "position: fixed; top: 0; left: 0; width: 100%; height: 70vh; background: #eee; z-index: 10";'
    + '    document.getElementById("app").append(cover); });'
    + '}, 10);'
    + '</script></body></html>',
  // AUD-2e: 初めから内容を覆う固定のヘッダ（ずっとあるので、覆いの指摘は `PERSISTENT`）。ヘッダの landmark は通知の枠に数えないので、隠されずに残る。
  '/persistent-overlay': `${head('persistent overlay')}<body>`
    + '<header id="cover" style="position: fixed; top: 0; left: 0; width: 100%; height: 70vh; background: #eee; z-index: 10"><p>ヘッダです。</p></header>'
    + '<main><h1>見出し</h1><p>本文です。本文です。本文です。</p></main></body></html>',
});

const OCCLUSION_RULE_ID = 'FIXED_ELEMENT_OCCLUSION';
/** 後から出る覆いの色（`#eee`）。 */
const COVER_RGB: readonly [number, number, number] = [238, 238, 238];

let browser: Browser;
let server: LoopbackHttpServer | undefined;
const temporaryDirectories: string[] = [];

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  const leftover = testContextsOf(browser);
  for (const context of leftover) {
    await context.close();
  }
  await server?.close();
  server = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  expect(leftover, 'Contexts left in the browser after the test').toHaveLength(0);
});

const startServer = async (): Promise<LoopbackHttpServer> => {
  server = await startLoopbackHttpServer((request, response) => {
    if (request.url === '/api/data') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ title: '届いた見出し', body: '届いた本文です。', heading: '見出し' }));
      }, DATA_DELAY_MS);
      return;
    }
    if (request.url?.startsWith('/beacon/') === true) {
      response.writeHead(204).end();
      return;
    }
    if (request.url?.startsWith('/api/step') === true) {
      const stepMs = Number(new URL(request.url, 'http://127.0.0.1').searchParams.get('ms') ?? CHAIN_STEP_MS);
      setTimeout(() => response.writeHead(200, { 'content-type': 'application/json' }).end('{}'), stepMs);
      return;
    }
    const body = PAGES[request.url ?? ''];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  return server;
};

const normalized = (url: string, config: AuditConfig): NormalizedHttpUrlEvidence => {
  const result = normalizeUrl(url, url, new Set(config.crawl.allowedQueryParameters));
  if (!result.ok) {
    throw new Error(`fixture URL must normalize: ${url}`);
  }
  return result.url;
};

/** 最後に監査したときの、画像の置き場所（Run のディレクトリ）。 */
let lastScreenshotRoot = '';

const audit = async (
  path: string,
  { screenshots = false, progressWatchQuietLimitMs }: { readonly screenshots?: boolean; readonly progressWatchQuietLimitMs?: number } = {},
): Promise<PageAuditOutcome> => {
  const { origin } = await startServer();
  const config = createTestConfig(origin, '/', {
    viewports: { stressWidths: [] },
    audit: { interactions: false, performance: false, screenshots },
  });
  const allocator = new IdAllocator();
  const root = await mkdtemp(join(tmpdir(), 'beaksight-recheck-'));
  temporaryDirectories.push(root);
  lastScreenshotRoot = root;
  const auditor = new PageAuditor({
    contextFactory: new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS),
    config,
    allocator,
    clock: () => new Date(),
    now: () => Date.now(),
    screenshotRootDirectory: root,
    navigationPacer: createTestNavigationPacer(config),
    safetyViolationRecorded: () => false,
    ...(progressWatchQuietLimitMs === undefined ? {} : { progressWatchQuietLimitMs }),
  });
  const outcome = await auditor.audit(normalized(`${origin}${path}`, config), allocator.allocatePageId());
  await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown)).resolves.toEqual({ ok: true });
  return outcome;
};

/** そのビューポートの、その Rule の指摘の、確かめ直しの印。 */
const statesOf = (outcome: PageAuditOutcome, viewport: 'desktop' | 'mobile', ruleId: string): readonly string[] => {
  const findings = outcome.result.findings.filter((finding) => finding.viewport === viewport && finding.ruleId === ruleId);
  const table = outcome.result.viewports[viewport].recheck?.findings ?? [];
  return findings.map((finding) => table.find((entry) => entry.fingerprint === finding.fingerprint)?.state ?? 'NONE');
};

/** そのビューポートの見出しの指摘の、確かめ直しの印。 */
const headingStatesOf = (outcome: PageAuditOutcome, viewport: 'desktop' | 'mobile'): readonly string[] =>
  statesOf(outcome, viewport, HEADING_RULE_ID);

/** その指摘が参照する Evidence。 */
const evidenceOfFinding = (outcome: PageAuditOutcome, viewport: 'desktop' | 'mobile', ruleId: string, state: string) => {
  const findings = outcome.result.findings.filter((finding) => finding.viewport === viewport && finding.ruleId === ruleId);
  const finding = findings[statesOf(outcome, viewport, ruleId).indexOf(state)];
  return outcome.result.evidence.find((record) => record.evidenceId === finding?.evidenceRefs[0]);
};

describe('AUD-2b: waits for the data that arrives late into a fixed-height skeleton', () => {
  it('measures after the data, so the heading finding does not appear, and records the load phases', async () => {
    const outcome = await audit('/late-data');

    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(headingStatesOf(outcome, viewport), viewport).toEqual([]);
      const phases = outcome.result.viewports[viewport].settling?.loadPhases?.map(({ phase }) => phase) ?? [];
      expect(phases[0]).toBe('AFTER_DOM_CONTENT_LOADED');
      expect(phases).toContain('LOADING');
      expect(phases.slice(-2)).toEqual(['AFTER_DATA', 'SETTLED']);
      const dom = outcome.result.evidence.find((record) => record.viewport === viewport && record.type === 'dom');
      expect((dom?.payload as { readonly headings: readonly { readonly text: string }[] }).headings.map(({ text }) => text)).toEqual(['届いた見出し']);
    }
  }, TEST_TIMEOUT_MS);
});

describe('AUD-2d: the recheck after the page settled', () => {
  it('marks the heading finding INITIAL_ONLY when the heading appears after the first axe run', async () => {
    const outcome = await audit('/heading-after-axe');

    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(headingStatesOf(outcome, viewport), viewport).toEqual(['INITIAL_ONLY']);
      const recheck = outcome.result.viewports[viewport].recheck;
      expect(recheck).toMatchObject({ status: 'RECHECKED', stateId: `${outcome.result.pageId}:${viewport}:1` });
      expect(recheck?.axeRuleIds).toContain('page-has-heading-one');
      // 見出しを読み直した: 後から出た見出しは `LATE`。
      expect(recheck?.headings).toEqual([{ level: 1, text: '見出し', state: 'LATE' }]);
    }
  }, TEST_TIMEOUT_MS);

  // AUD-2d の直し: 確かめ直しで新しく出た問題も、`LATE` の印つきで Finding にする（見落とさないため）。
  it('makes a LATE finding for the element that appears after the first axe run', async () => {
    const outcome = await audit('/late-image');

    for (const viewport of ['desktop', 'mobile'] as const) {
      const findings = outcome.result.findings.filter((finding) => finding.viewport === viewport && finding.ruleId === 'A11Y_IMAGE_ALT');
      const table = outcome.result.viewports[viewport].recheck?.findings ?? [];
      const marks = findings.map((finding) => table.find((entry) => entry.fingerprint === finding.fingerprint)?.state ?? 'NONE');
      expect([...marks].sort(), viewport).toEqual(['LATE', 'PERSISTENT']);
      // `LATE` の指摘は、確かめ直しの axe の Evidence（段は `recheck`）を参照する。
      const late = findings[marks.indexOf('LATE')];
      const evidence = outcome.result.evidence.find((record) => record.evidenceId === late?.evidenceRefs[0]);
      expect(evidence).toMatchObject({ type: 'accessibility', viewport, capture: { phase: 'recheck' } });
    }
    // 採番は重ならない。
    const ids = outcome.result.findings.map(({ findingId }) => findingId);
    expect(new Set(ids).size).toBe(ids.length);
  }, TEST_TIMEOUT_MS);

  // AUD-2b の直し: 1 秒ごとに文字が入れ替わる告知のある画面でも、落ち着きの判定と確かめ直しの待ちが、数秒で終わる（反応なしの長さまで待たない）。
  it('finishes the settling and the recheck in a few seconds with a rotating notice', async () => {
    const outcome = await audit('/rotating');

    for (const viewport of ['desktop', 'mobile'] as const) {
      const record = outcome.result.viewports[viewport];
      expect(record.settling).toMatchObject({ status: 'SETTLED', watchEnd: null });
      expect(record.settling?.elapsedMs, viewport).toBeLessThan(ROTATING_SETTLE_LIMIT_MS);
      expect(record.recheck).toMatchObject({ status: 'RECHECKED' });
      expect(record.recheck?.settling).toMatchObject({ status: 'SETTLED', watchEnd: null });
      expect(record.recheck?.settling?.elapsedMs, viewport).toBeLessThan(ROTATING_SETTLE_LIMIT_MS);
    }
  }, TEST_TIMEOUT_MS);

  it('marks the heading finding PERSISTENT when the page never has a heading', async () => {
    const outcome = await audit('/no-heading');

    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(headingStatesOf(outcome, viewport), viewport).toEqual(['PERSISTENT']);
      // EV-3: 完成した画面の本当の欠けは、保留にしない。
      expect(holdReasonsOf(outcome, viewport), viewport).toEqual([null]);
    }
  }, TEST_TIMEOUT_MS);
});

/** そのビューポートの見出しの指摘の、保留の理由（表示用モデルの値）。 */
const holdReasonsOf = (outcome: PageAuditOutcome, viewport: 'desktop' | 'mobile'): readonly (string | null)[] => {
  const regionOf = findingImageRegionIndexOf({ pages: [outcome.result] } as unknown as AuditRunResult);
  return outcome.result.findings.filter((finding) => finding.viewport === viewport && finding.ruleId === HEADING_RULE_ID)
    .map((finding) => regionOf(finding)?.holdReason ?? null);
};

// EV-3（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.3）: 見える読み込み中の表示が消えるまで落ち着きにしない。残ったまま何も動かなく
// なったら、準備が終わらないまま読み取り、内容の指摘を保留の理由で出す。
describe('EV-3: the readiness of the page', () => {
  it('waits until the loading indicator is gone, so no heading finding is left after the page completes', async () => {
    const outcome = await audit('/busy-then-heading');

    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(headingStatesOf(outcome, viewport), viewport).toEqual([]);
    }
  });

  it('holds the heading finding as not ready when the loading indicator never goes away', async () => {
    const outcome = await audit('/busy-forever');

    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(holdReasonsOf(outcome, viewport), viewport).toEqual(['PAGE_NOT_READY']);
    }
  });
});

// DEF-283（設計者の判断 2026-11-16）: 新しい path へ送り続ける画面でも、落ち着きと確かめ直しの待ちが、進みの見張りに頼らずに終わる。切れ目のない鎖で
// 最初の落ち着きの後に出た見出しは、確かめ直しが後から見て記録する。
describe('DEF-283: the pages that keep sending to new paths', () => {
  it.each(['/busy-sending', '/sending'])('finishes the settling and the recheck of %s without the progress watch', async (path) => {
    const outcome = await audit(path, { progressWatchQuietLimitMs: TEST_RUN_PROGRESS_QUIET_LIMIT_MS });

    for (const viewport of ['desktop', 'mobile'] as const) {
      const record = outcome.result.viewports[viewport];
      expect(record.settling, viewport).toMatchObject({ status: 'SETTLED', watchEnd: null });
      expect(record.recheck, viewport).toMatchObject({ status: 'RECHECKED', settling: { status: 'SETTLED', watchEnd: null } });
    }
  });

  it('records the heading that a seamless chain of loads brings after the first settling, at the recheck', async () => {
    const outcome = await audit('/chain');

    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(headingStatesOf(outcome, viewport), viewport).toEqual(['INITIAL_ONLY']);
      expect(outcome.result.viewports[viewport].recheck?.headings, viewport).toEqual([{ level: 1, text: '届いた見出し', state: 'LATE' }]);
    }
  });

  // REV-WSO: データが届く前に終えた落ち着きは、準備が終わっていない状態として、見出しの不足を保留にする（黙って空の画面に内容の規則を当てない）。
  it.each(['/long-chain', '/long-chain-busy', '/toggling-steps'])('does not report a missing heading of %s without the hold', async (path) => {
    const outcome = await audit(path);

    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(holdReasonsOf(outcome, viewport).filter((reason) => reason !== 'PAGE_NOT_READY'), viewport).toEqual([]);
    }
  });
});

describe('AUD-2e: the recheck runs all the axe rules and the layout rules', () => {
  it('makes a LATE finding for a rule that had no violation in the first axe run', async () => {
    const outcome = await audit('/late-button');

    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(statesOf(outcome, viewport, 'A11Y_BUTTON_NAME'), viewport).toEqual(['LATE']);
      expect(evidenceOfFinding(outcome, viewport, 'A11Y_BUTTON_NAME', 'LATE')).toMatchObject({ type: 'accessibility', viewport, capture: { phase: 'recheck' } });
    }
    const ids = outcome.result.findings.map(({ findingId }) => findingId);
    expect(new Set(ids).size).toBe(ids.length);
  }, TEST_TIMEOUT_MS);

  it('makes a LATE layout finding for a fixed cover that appears after the first pass', async () => {
    const outcome = await audit('/late-overlay');

    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(statesOf(outcome, viewport, OCCLUSION_RULE_ID), viewport).toEqual(['LATE']);
      expect(evidenceOfFinding(outcome, viewport, OCCLUSION_RULE_ID, 'LATE')).toMatchObject({ type: 'layout', viewport, capture: { phase: 'recheck' } });
    }
    const ids = outcome.result.findings.map(({ findingId }) => findingId);
    expect(new Set(ids).size).toBe(ids.length);
  }, TEST_TIMEOUT_MS);

  // 確かめ直しの段でも viewport の画像を撮り、確かめ直しの layout から出た指摘（`LATE`）は、その画像を参照する（後から出た覆いが写っている）。
  it('takes the viewport image at the recheck, and points the LATE layout finding at it', async () => {
    const outcome = await audit('/late-overlay', { screenshots: true });

    for (const viewport of ['desktop', 'mobile'] as const) {
      const findings = outcome.result.findings.filter((finding) => finding.viewport === viewport && finding.ruleId === OCCLUSION_RULE_ID);
      const late = findings[statesOf(outcome, viewport, OCCLUSION_RULE_ID).indexOf('LATE')];
      expect(late, viewport).toBeDefined();
      const region = late === undefined ? null : findingImageRegionIndexOf({ pages: [outcome.result] } as unknown as AuditRunResult)(late);
      const shot = outcome.result.evidence.find((record) => record.evidenceId === region?.screenshotEvidenceId);
      expect(shot, viewport).toMatchObject({ type: 'screenshot', viewport, capture: { phase: 'recheck' } });
      const overlay = region?.regions.find((entry) => entry.role === 'OVERLAY');
      expect(overlay?.selector).toBe('#late-cover');
      if (shot?.type !== 'screenshot' || overlay === undefined) {
        throw new Error('the recheck image or the region is missing');
      }
      // 後から出た覆い（#eee）が、確かめ直しの画像の矩形の中に写っている。1 回目の画像には写っていない。
      const { x, y, width, height } = overlay.rect;
      const center = [x + width / 2, y + height / 2] as const;
      expect(readPngPixels(artifactFilePath(lastScreenshotRoot, shot.payload.relativePath)).rgbAt(...center), viewport).toEqual(COVER_RGB);
      const first = outcome.result.evidence.find((record) => record.type === 'screenshot' && record.viewport === viewport
        && record.payload.captureType === 'VIEWPORT' && record.capture?.phase !== 'recheck');
      if (first?.type !== 'screenshot') {
        throw new Error('the first viewport image is missing');
      }
      expect(readPngPixels(artifactFilePath(lastScreenshotRoot, first.payload.relativePath)).rgbAt(...center), viewport).not.toEqual(COVER_RGB);
    }
  }, TEST_TIMEOUT_MS);

  it('marks the layout finding PERSISTENT when the fixed cover is always there', async () => {
    const outcome = await audit('/persistent-overlay');

    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(statesOf(outcome, viewport, OCCLUSION_RULE_ID), viewport).toEqual(['PERSISTENT']);
      // 確かめ直しの layout の Evidence は、1 回目の Rule の評価に入れない（同じ指摘を 2 回作らない）。
      expect(evidenceOfFinding(outcome, viewport, OCCLUSION_RULE_ID, 'PERSISTENT')).toMatchObject({ type: 'layout', viewport });
      expect(evidenceOfFinding(outcome, viewport, OCCLUSION_RULE_ID, 'PERSISTENT')?.capture?.phase).not.toBe('recheck');
    }
  }, TEST_TIMEOUT_MS);
});

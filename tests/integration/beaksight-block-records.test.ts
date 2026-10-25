// BN-a（設計書 `doc/design/2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.1）: BeakSight の遮断の記録の時点・種類・読み込みの印。
// 通す部品は本物（`BrowserContextFactory`・Guard・`PageAuditor`）。Chromium はテストの既定の headless と、CLI の起動の設定の両方。サイトは 127.0.0.1 の自前のサーバ。
// - 読み込みの最中に止めた要求は、page.json の safety の Evidence に `phase: LOAD` と要求の種類（`resourceType`）つきで残る。
// - 閉じる途中・ページを離れた後に止めた要求も、page.json の safety の Evidence に `phase: CLOSING` で残る（BN-a の前は、snapshot を閉じる前に取ったので残らなかった）。
//   - 監査の段の送信の扱い `PASS_EXCEPT_DELETE`: ページを離れるとき（`pagehide`）の `DELETE` は、止めた要求（`blockedRequests`）に `CLOSING` で残る。
//   - 既定（`READ_ONLY`）: Context を閉じる途中に止めた要求は、閉じる途中の記録（`blockedClosingRequests`）に残る（ブラウザの内部の順に左右されるので、
//     全部の回のうち少なくとも 1 回）。止めた要求の数（`blockedRequestsByMethod`）と SAFETY の Finding には入れない。
// - network の Evidence の失敗に、BeakSight の遮断か（`blockedByBeakSight`）と時点（`phase`）が付く。
// - safety の Evidence に、読み込みの種類（ページの監査・幅の走査の幅・Interaction の候補の番号）が付く。
// - 止める決まりと届く要求は変わらない（サーバの記録で数え、全部の回の後に名前つきの時間だけ待って数え直す）。
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import type { EvidenceRecord, PageAuditOutcome, ViewportProfile } from '../../src/core/contracts.js';
import { PAGE_SCHEMA_VERSION, type NetworkEvidence, type SafetyEventsEvidence } from '../../src/core/evidence-types.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { AuditConfig } from '../../src/config/types.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { closedLoopbackOrigin, startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 180_000;
/** 閉じた後に遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_500;
/** 閉じる途中の遮断を確かめる回の数（ブラウザの内部の順に左右されるので、回ごとに新しい監査で読み込む）。 */
const CLOSING_ROUNDS = 3;
/** 幅の走査で読む 1 つの幅（CSS px。主要な 2 つのビューポートの幅でないもの）。 */
const STRESS_WIDTH = 768;
/** Guard が正規化した、ページの fetch の要求の種類（keepalive の fetch を、Chromium は `xhr` として渡すことがある）。 */
const FETCH_RESOURCE_TYPES: readonly string[] = ['fetch', 'xhr'];
const HTTP_OK = 200;

const LOAD_PAGE_PATH = '/bn/load';
const CLOSING_PAGE_PATH = '/bn/closing';
const LOAD_POST_PATH = '/api/load-post';
const LOAD_BEACON_PATH = '/api/load-beacon';
const CLOSE_DELETE_PATH = '/api/close-delete';
const CLOSE_POLL_PATH_PREFIX = '/api/close-poll';

/** 読み込みの最中に、POST の fetch と beacon（止める）と、閉じたポートの画像（BeakSight でない失敗）を出す。Interaction の候補のボタンを 1 つ持つ。 */
const loadPageHtml = (closedOrigin: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>読み込み</title></head>
<body><main><h1>読み込み</h1><button type="button" id="toggle" aria-expanded="false" onclick="this.setAttribute('aria-expanded', String(this.getAttribute('aria-expanded') !== 'true'))">開く</button>
<img alt="x" src="${closedOrigin}/missing.png"></main><script>
fetch('${LOAD_POST_PATH}', { method: 'POST', body: 'x' }).catch(() => 0);
navigator.sendBeacon('${LOAD_BEACON_PATH}', 'b');
</script></body></html>`;

/**
 * 閉じるときに要求を出す画面: `pagehide` で keepalive の `DELETE` と GET を、短い間隔で GET を出し続ける（閉じる途中に Guard が止める要求を作る）。
 */
const CLOSING_PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>閉じる</title></head>
<body><main><h1>閉じる</h1></main><script>
let n = 0;
setInterval(() => { fetch('${CLOSE_POLL_PATH_PREFIX}?i=' + (n += 1), { keepalive: true }).catch(() => 0); }, 100);
addEventListener('pagehide', () => {
  fetch('${CLOSE_DELETE_PATH}', { method: 'DELETE', keepalive: true }).catch(() => 0);
  for (let i = 0; i < 20; i += 1) fetch('${CLOSE_POLL_PATH_PREFIX}-hide?i=' + i, { keepalive: true }).catch(() => 0);
});
</script></body></html>`;

interface ServerRecord {
  readonly method: string;
  readonly path: string;
}

const pathOf = (url: string): string => new URL(url).pathname;

/** page.json のスキーマの誤り（なければ空）。 */
const pageSchemaErrorsOf = async (value: unknown): Promise<readonly string[]> => {
  const validation = await validateArtifact('page', value);
  return validation.ok ? [] : validation.errors;
};

const evidenceOf = <TPayload>(outcome: PageAuditOutcome, type: EvidenceRecord['type'], viewport: ViewportProfile): readonly TPayload[] =>
  outcome.result.evidence.filter((record) => record.type === type && record.viewport === viewport).map((record) => record.payload as TPayload);

describe.each(LAUNCHERS)('BN-a: the records of the BeakSight blocks with %s', (_label, launch) => {
  let browser: Browser;
  let app: LoopbackHttpServer;
  let closedOrigin: string;
  const records: ServerRecord[] = [];
  const directories: string[] = [];

  beforeAll(async () => {
    browser = await launch();
    closedOrigin = await closedLoopbackOrigin();
    app = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.on('data', () => undefined);
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        records.push({ method: request.method ?? 'GET', path: url.pathname });
        if (url.pathname === LOAD_PAGE_PATH) {
          response.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' }).end(loadPageHtml(closedOrigin));
        } else if (url.pathname === CLOSING_PAGE_PATH) {
          response.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' }).end(CLOSING_PAGE_HTML);
        } else {
          response.writeHead(HTTP_OK, { 'content-type': 'application/json' }).end('{}');
        }
      });
    });
  });

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  /** ページを 1 回監査する（`auditSend` が真なら `PASS_EXCEPT_DELETE`）。 */
  const audit = async (path: string, options: { readonly auditSend: boolean; readonly config: AuditConfig }): Promise<PageAuditOutcome> => {
    const { config } = options;
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      ...(options.auditSend
        ? { auditSend: { policy: 'PASS_EXCEPT_DELETE' as const, approvedServiceOrigins: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS } }
        : {}),
    });
    const allocator = new IdAllocator();
    const screenshotRootDirectory = await mkdtemp(join(tmpdir(), 'beaksight-bn-a-'));
    directories.push(screenshotRootDirectory);
    try {
      const auditor = new PageAuditor({
        contextFactory: factory,
        config,
        allocator,
        clock: () => new Date(),
        now: () => Date.now(),
        screenshotRootDirectory,
        navigationPacer: createTestNavigationPacer(config),
        safetyViolationRecorded: () => false,
      });
      const normalized = normalizeUrl(`${app.origin}${path}`, `${app.origin}${path}`, new Set());
      if (!normalized.ok) {
        throw new Error('the fixture URL must normalize');
      }
      return await auditor.audit(normalized.url, allocator.allocatePageId());
    } finally {
      await factory.close();
    }
  };

  const quietConfig = (): AuditConfig => createTestConfig(app.origin, '/', {
    viewports: { stressWidths: [] },
    audit: { interactions: false, screenshots: false, accessibility: false, performance: false },
  });

  it('records a block during the load with phase LOAD and the resource type, marks the network failures, and marks each safety evidence with its load', async () => {
    const config = createTestConfig(app.origin, '/', {
      viewports: { stressWidths: [STRESS_WIDTH] },
      audit: { interactions: true, screenshots: false, accessibility: false, performance: false },
    });
    const start = records.length;
    const outcome = await audit(LOAD_PAGE_PATH, { auditSend: false, config });
    expect(outcome.result.schemaVersion).toBe(PAGE_SCHEMA_VERSION);
    expect(await pageSchemaErrorsOf(outcome.result)).toEqual([]);
    expect(outcome.safety.invariantViolationCount).toBe(0);

    const desktopSafety = evidenceOf<SafetyEventsEvidence>(outcome, 'safety', 'desktop');
    // 読み込みの印: Desktop はページの監査・Interaction の候補 0・幅の走査の幅（記録の順）。Mobile はページの監査だけ。
    expect(desktopSafety.map(({ load }) => load)).toEqual([
      { kind: 'PAGE_AUDIT' },
      { kind: 'INTERACTION', candidateIndex: 0 },
      { kind: 'STRESS_WIDTH', width: STRESS_WIDTH },
    ]);
    expect(evidenceOf<SafetyEventsEvidence>(outcome, 'safety', 'mobile').map(({ load }) => load)).toEqual([{ kind: 'PAGE_AUDIT' }]);

    for (const viewport of ['desktop', 'mobile'] as const) {
      const [pageAudit] = evidenceOf<SafetyEventsEvidence>(outcome, 'safety', viewport);
      const blocked = (pageAudit?.blockedRequests ?? []).map(({ method, url, reason, resourceType, phase }) => ({ method, path: pathOf(url), reason, resourceType, phase }))
        .sort((left, right) => left.path.localeCompare(right.path));
      expect(blocked).toEqual([
        { method: 'POST', path: LOAD_BEACON_PATH, reason: 'NON_READ_METHOD', resourceType: 'ping', phase: 'LOAD' },
        { method: 'POST', path: LOAD_POST_PATH, reason: 'NON_READ_METHOD', resourceType: expect.any(String), phase: 'LOAD' },
      ]);
      // Guard の記録の口（CDP）は、ページの fetch を `xhr` として渡すことがある（network の Evidence の Playwright の種類は `fetch`）。
      expect(FETCH_RESOURCE_TYPES).toContain(blocked[1]?.resourceType);
      const [network] = evidenceOf<NetworkEvidence>(outcome, 'network', viewport);
      const failures = (network?.failures ?? []).map(({ url, resourceType, blockedByBeakSight, phase }) => ({ path: pathOf(url), resourceType, blockedByBeakSight, phase }));
      expect(failures).toEqual(expect.arrayContaining([
        { path: LOAD_POST_PATH, resourceType: 'fetch', blockedByBeakSight: true, phase: 'LOAD' },
        { path: '/missing.png', resourceType: 'image', blockedByBeakSight: false, phase: 'LOAD' },
      ]));
      // 失敗のすべての行が、2 つの印を持つ。
      for (const failure of network?.failures ?? []) {
        expect(typeof failure.blockedByBeakSight).toBe('boolean');
        expect(failure.phase).toBe('LOAD');
      }
    }
    // 止める決まりは変わらない（読み込みの最中の POST と beacon は届かない）。
    await wait(LATE_REQUEST_WAIT_MS);
    expect(records.slice(start).filter(({ method }) => method !== 'GET')).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('records the DELETE stopped while leaving the page (PASS_EXCEPT_DELETE) in page.json with phase CLOSING, and it never arrives', async () => {
    const start = records.length;
    for (let round = 0; round < CLOSING_ROUNDS; round += 1) {
      const outcome = await audit(CLOSING_PAGE_PATH, { auditSend: true, config: quietConfig() });
      expect(await pageSchemaErrorsOf(outcome.result)).toEqual([]);
      expect(outcome.safety.invariantViolationCount).toBe(0);
      for (const viewport of ['desktop', 'mobile'] as const) {
        const [pageAudit] = evidenceOf<SafetyEventsEvidence>(outcome, 'safety', viewport);
        const deleted = pageAudit?.blockedRequests.filter(({ method, url }) => method === 'DELETE' && pathOf(url) === CLOSE_DELETE_PATH) ?? [];
        expect(deleted).toHaveLength(1);
        expect(deleted[0]).toMatchObject({ reason: 'NON_READ_METHOD', phase: 'CLOSING' });
        expect(FETCH_RESOURCE_TYPES).toContain(deleted[0]?.resourceType);
        // 読み込みの最中に止めた要求はない（離れる前の要求は通す扱い）。
        expect(pageAudit?.blockedRequests.filter(({ phase }) => phase === 'LOAD')).toEqual([]);
      }
    }
    await wait(LATE_REQUEST_WAIT_MS);
    expect(records.slice(start).filter(({ method }) => method === 'DELETE')).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('keeps the READ_ONLY page audit of the closing page free of blocks during the load, with no SAFETY finding and nothing late', async () => {
    const start = records.length;
    const outcome = await audit(CLOSING_PAGE_PATH, { auditSend: false, config: quietConfig() });
    expect(await pageSchemaErrorsOf(outcome.result)).toEqual([]);
    expect(outcome.safety.invariantViolationCount).toBe(0);
    expect(outcome.safety.recordTruncated).toBe(false);
    for (const viewport of ['desktop', 'mobile'] as const) {
      const [pageAudit] = evidenceOf<SafetyEventsEvidence>(outcome, 'safety', viewport);
      // 閉じる途中に止めた要求は、止めた要求の一覧と数には入れない（READ_ONLY の閉じる画面は、読み込みの最中に何も止めない）。
      expect(pageAudit?.blockedRequests).toEqual([]);
      expect(pageAudit?.blockedRequestsByMethod).toEqual({});
      for (const event of pageAudit?.blockedClosingRequests?.events ?? []) {
        expect(event.phase).toBe('CLOSING');
      }
    }
    expect(outcome.result.findings.filter(({ category }) => category === 'SAFETY')).toEqual([]);
    const beforeLateWait = records.length;
    await wait(LATE_REQUEST_WAIT_MS);
    expect(records.slice(beforeLateWait)).toEqual([]);
    expect(records.slice(start).filter(({ method }) => method !== 'GET')).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // Guard が閉じる途中（持ち主が閉じ始めた page。段階 `PASSIVE_CLOSING` の後と同じ扱い `BLOCK_LIFECYCLE`）に止めた要求は、閉じる途中の記録
  // （`blockedClosingRequests`）に残る。持ち主が page を閉じると、page の `pagehide` の keepalive の要求が Guard に来る（Context を閉じる途中は、ほぼ来ない。
  // 報告を参照）。ブラウザの内部の順に左右されるので、全部の回のうち少なくとも 1 回、記録が残ることを確かめる。止めた要求の数と一覧、記録の上限の印には入れない。
  // DEF-159: 強い混雑の下では、`pagehide` の keepalive の DELETE が Guard の横取りを通らずに出る回が多く、その回は Passive の Context の出口の中継が
  // 要求の方針で拒んで `blockedInteractionRequests` に `GUARD_BYPASS_EGRESS` で記録する（閉じる途中の記録は残らない）。止める経路が働いた証拠には、
  // その中継の記録（DELETE の 1 件）も数える。DELETE がサーバに届かないことの確かめは変えない。
  it('records the requests the Guard stopped while closing (an owner closing page) in blockedClosingRequests with phase CLOSING, apart from the blocked request counts', async () => {
    const start = records.length;
    let closingRecords = 0;
    let egressRecords = 0;
    for (let round = 0; round < CLOSING_ROUNDS; round += 1) {
      const config = quietConfig();
      const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
      try {
        const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY', { pageAuditLoad: true });
        const page = await factory.createPassivePage(context);
        await page.goto(`${app.origin}${CLOSING_PAGE_PATH}`);
        await factory.closePassivePage(page);
        await wait(LATE_REQUEST_WAIT_MS);
        const snapshot = factory.getSafetyLedger(context).snapshot();
        expect(snapshot.invariantViolations).toEqual([]);
        expect(snapshot.recordLimits.truncated).toBe(false);
        // 閉じる途中の要求は、止めた要求の一覧と数には入れない（この画面は、読み込みの最中に何も止めない）。
        expect(snapshot.blockedRequests).toEqual([]);
        expect(snapshot.blockedRequestsByMethod).toEqual({});
        const closing = snapshot.blockedClosingRequests;
        if (closing !== undefined) {
          closingRecords += 1;
          expect(closing.count).toBeGreaterThanOrEqual(closing.events.length);
          for (const event of closing.events) {
            expect(event.phase).toBe('CLOSING');
            expect(FETCH_RESOURCE_TYPES).toContain(event.resourceType);
            expect(pathOf(event.url).startsWith(CLOSE_POLL_PATH_PREFIX) || pathOf(event.url) === CLOSE_DELETE_PATH).toBe(true);
          }
        }
        // 中継が拒んだ要求は、Guard を通らずに出ようとした DELETE だけ（GET の poll は中継の方針で通る）。
        const egress = snapshot.blockedInteractionRequests.map(({ method, url, reason }) => `${method} ${pathOf(url)} ${reason}`);
        expect(egress.every((line) => line === `DELETE ${CLOSE_DELETE_PATH} GUARD_BYPASS_EGRESS`)).toBe(true);
        if (egress.length > 0) {
          egressRecords += 1;
        }
        console.info(`BN-a closing round ${round}: closing records ${closing?.events.length ?? 0}; egress ${JSON.stringify(egress)}`);
        await factory.closePassiveContext(context);
      } finally {
        await factory.close();
      }
    }
    // 止める経路が働いた証拠（Guard の閉じる途中の記録か、中継の記録が残った回）が、少なくとも 1 回ある。
    expect(closingRecords + egressRecords).toBeGreaterThan(0);
    // 閉じた後に、要求が遅れて届かない。読み込みの最中の POST と beacon も届かない。
    const beforeLateWait = records.length;
    await wait(LATE_REQUEST_WAIT_MS);
    expect(records.slice(beforeLateWait)).toEqual([]);
    expect(records.slice(start).filter(({ method }) => method !== 'GET')).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

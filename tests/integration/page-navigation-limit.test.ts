// DEF-129・L10（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4。INV-LIMITS の S4 と設計者の判断）: ページが始めた移動は、同じ frame で同じ移り
// （前の URL → 次の URL）がこの読み込みの中でくり返されたら（輪）止めて記録し、その画面は読み切れない（入口の確かめは `READ_FAILED`、発見は
// `INCOMPLETE_PAGE_NAVIGATION_LIMIT`、READ は `PAGE_NOT_SETTLED`、監査はビューポートの `PAGE_NAVIGATION_LIMIT_REACHED`）。子の frame も同じ（T37R2-fix）。
// 1 回の JS の転送と 1 回の meta の転送の画面は、今どおり読める。
// SPEC-1: 撤廃した回数・数の上限（DEF-129 の 2 回、DEF-130-fix の 1,000 件）を超える場面と、成果物の要求の数の確かめは消した（撤廃の確かめは単体の
// `page-navigation-loop.test.ts`・`guard-request-verdict.test.ts`）。
// 自前の 127.0.0.1 のサーバ。Chromium はテストの既定の headless だけ。全部の後に、名前つきの時間だけ待ってから数え直す。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeAuditRun } from '../../src/cli/audit-run.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { EntryCheckDocument } from '../../src/control/entry-check.js';
import { ENTRY_CHECK_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import type { PageAuditResult } from '../../src/core/contracts.js';
import { wait } from '../../src/core/deadline.js';
import { observationWindowsOf, type ObservationWindows } from '../../src/core/observation-windows.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { ReadEvidenceDocument } from '../../src/discovery/read-check-evaluation.js';
import { DISCOVERY_SETTLE_POLICY, type DiscoverySettlePolicy } from '../../src/discovery/settle.js';
import { executeReadCheckRun } from '../../src/worker/read-check-run.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { executeEntryCheckRun } from '../../src/worker/entry-check-run.js';
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { LOADED_DEADLINE_FACTOR, LOADED_RESOURCE_SETTLING_TIMEOUT_MS } from '../helpers/loaded-deadline.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer, forwardingNavigationPacer } from '../helpers/navigation-pacer.js';
import { createQuietLimitedRunCoordinator, fastRunConfig, readRunAudit } from '../helpers/run-harness.js';

const TEST_TIMEOUT_MS = 240_000;
/**
 * TS-c: 落ち着きの待ちの上限（ms）。この画面たちの多くは落ち着かない（読み込み直し・移動・要求を出し続ける）ので、どの段も上限まで待つ。入口の確かめ・
 * 発見・画面の READ には、本番の上限（`DISCOVERY_SETTLE_TIMEOUT_MS`。5 秒）の代わりに、この上限の指定（`SETTLE_POLICY`）を注入し、監査の段には、
 * 設定の `crawl.resourceSettlingTimeoutMs`（既定 5 秒）にこの値を入れる。期限そのものは、落ち着きの待ちの単体テスト（`tests/unit/discovery-settle.test.ts`）と
 * 発見の probe の結合テスト（`tests/integration/discovery-probe.test.ts`）が確かめる。要求を出し続ける画面は、1 秒ほどで上限（1,000 件）に届くので、
 * 混雑の下の余裕を見て 3 秒にする。
 */
const SETTLE_TIMEOUT_MS = 3_000;
const SETTLE_POLICY: DiscoverySettlePolicy = Object.freeze({ ...DISCOVERY_SETTLE_POLICY, timeoutMs: SETTLE_TIMEOUT_MS });
/**
 * DEF-174: 落ち着くことを確かめる場面（落ち着かない理由が付かない、COMPLETE、READ・NOT_MATCHED になる）の落ち着きの待ちの指定。短い上限
 * （`SETTLE_POLICY`）では、混雑の下で落ち着く前に切れて `INCOMPLETE_SETTLE_TIMEOUT` になったので、本番の上限に混雑の倍率（`loaded-deadline.ts`）を
 * 掛ける。落ち着く画面は上限より前に終わるので、ふだんの時間は変わらない。監査の段の期限は `LOADED_RESOURCE_SETTLING_TIMEOUT_MS`。
 */
const SETTLING_POLICY: DiscoverySettlePolicy = Object.freeze({
  ...DISCOVERY_SETTLE_POLICY, timeoutMs: DISCOVERY_SETTLE_POLICY.timeoutMs * LOADED_DEADLINE_FACTOR,
});
/** 場面の画面が落ち着くか（`SETTLING`: 落ち着くことを確かめる。`NOT_SETTLING`: 落ち着かず、短い上限で切れることを確かめる）。 */
type SettleMode = 'SETTLING' | 'NOT_SETTLING';
const settlePolicyOf = (mode: SettleMode): DiscoverySettlePolicy => (mode === 'SETTLING' ? SETTLING_POLICY : SETTLE_POLICY);
/** 発見の Run に渡す観察の窓の一式（落ち着きの待ちの上限だけを、上の指定にする。ほかは本番の値）。 */
const observationWindowsFor = (mode: SettleMode): ObservationWindows =>
  observationWindowsOf({ discoverySettle: { timeoutMs: settlePolicyOf(mode).timeoutMs } });
/** 各ジョブの後に、遅れて届く要求を待つ時間（ms。読み込み直しが続いていれば、その間にも届く）。 */
const LATE_REQUEST_WAIT_MS = 1_500;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
/** 画面の READ の期待の、どの画面にもない文字。 */
const ABSENT_TEXT = '画面にない文字';

const PATHS = Object.freeze({
  reload: '/reload',
  jsRedirect: '/js-redirect',
  meta: '/meta',
  landing: '/landing',
  // T37R2-fix（T37R2 の I-1）: 子の frame の読み込み直しと移動。
  iframeReload: '/iframe-reload',
  frameReload: '/frame-reload',
  frameTarget: '/frame-target',
  iframeForward: '/iframe-forward',
  frameForward: '/frame-forward',
} as const);

/**
 * L10 の S4（設計者の判断。2026-11-12）: 自分を読み込み直し続ける画面（frame）で、1 回の読み込みごとに届く文書の要求の数。最初の文書と、1 回目の読み込み直し
 * （A→A。通す）。2 回目の読み込み直しは、同じ移りのくり返しなので止める。
 */
const DOCUMENTS_UNTIL_REPEATED_RELOAD = 2;

const pageOf = (body: string, head = ''): string =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8">${head}<title>画面</title></head><body><main>${body}</main></body></html>`;
const LOGIN_FORM = '<form method="post" action="/session"><label>ユーザー <input id="u" name="u" type="text"></label>'
  + '<label>パスワード <input id="p" name="p" type="password"></label><button id="s" type="submit">ログイン</button></form>';

const PAGES: Readonly<Record<string, string>> = Object.freeze({
  [PATHS.reload]: pageOf(`${LOGIN_FORM}<form method="get" action="/search"><input name="q"><button type="submit">検索</button></form>`
    + '<script>setTimeout(() => location.reload(), 80);</script>'),
  [PATHS.jsRedirect]: pageOf(`<p>移ります</p><script>setTimeout(() => { location.href = '${PATHS.landing}'; }, 50);</script>`),
  [PATHS.meta]: pageOf('<p>移ります</p>', `<meta http-equiv="refresh" content="0;url=${PATHS.landing}">`),
  [PATHS.landing]: pageOf(`${LOGIN_FORM}<form method="get" action="/search"><input name="q"><button type="submit">検索</button></form>`),
  // T37R2-fix: 子の frame が自分を読み込み直す画面、子の frame が 1 回だけ転送する画面。
  [PATHS.iframeReload]: pageOf(`${LOGIN_FORM}<iframe src="${PATHS.frameReload}" title="子" style="width:10px;height:10px"></iframe>`),
  [PATHS.frameReload]: pageOf('<p>子</p><script>setTimeout(() => location.reload(), 80);</script>'),
  [PATHS.frameTarget]: pageOf('<p>子</p>'),
  [PATHS.iframeForward]: pageOf(`${LOGIN_FORM}<iframe src="${PATHS.frameForward}" title="子" style="width:10px;height:10px"></iframe>`),
  [PATHS.frameForward]: pageOf(`<p>移ります</p><script>setTimeout(() => { location.href = '${PATHS.frameTarget}'; }, 50);</script>`),
});

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('DEF-129: the main frame loads started by the page itself with %s', (_label, launch) => {
  let site: LoopbackHttpServer;
  let workDirectory = '';
  let runCount = 0;
  const documents: string[] = [];

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-page-navigation-limit-'));
    site = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      const pathname = new URL(request.url ?? '/', 'http://x').pathname;
      const body = PAGES[pathname];
      if (request.method === 'GET' && body !== undefined) {
        documents.push(pathname);
        response.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
        return;
      }
      response.writeHead(HTTP_NOT_FOUND, { 'content-type': 'text/plain' }).end('nf');
    });
  });

  afterAll(async () => {
    await site?.close();
    await rm(workDirectory, { recursive: true, force: true });
  });

  const configOf = (path: string, mode: SettleMode = 'NOT_SETTLING'): AuditConfig => {
    runCount += 1;
    return fastRunConfig(site.origin, path, {
      target: { id: `navigation-limit-${runCount}` }, output: { directory: join(workDirectory, `run-${runCount}`) },
      crawl: { maxPages: 1, resourceSettlingTimeoutMs: mode === 'SETTLING' ? LOADED_RESOURCE_SETTLING_TIMEOUT_MS : SETTLE_TIMEOUT_MS },
    });
  };

  /** この流れの間に、`path` の文書の要求がサーバに届いた数（全部の後に待って数え直す）。 */
  const documentsSince = async (start: number, path: string): Promise<number> => {
    await wait(LATE_REQUEST_WAIT_MS);
    return documents.slice(start).filter((reached) => reached === path).length;
  };

  const entryCheck = async (
    path: string,
    mode: SettleMode = 'NOT_SETTLING',
  ): Promise<{ readonly document: EntryCheckDocument; readonly reached: number; readonly own: number }> => {
    const config = configOf(path, mode);
    const pacer = createTestNavigationPacer(config);
    let own = 0;
    const start = documents.length;
    const outcome = await executeEntryCheckRun({
      config, jobId: `job-entry-${runCount}`, launchBrowser: launch, clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
      settlePolicy: settlePolicyOf(mode),
      navigationPacer: forwardingNavigationPacer(pacer, async () => {
        own += 1;
        return pacer.beforeNavigation();
      }),
    }, { onRunStarted: () => undefined });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the entry check did not run: ${outcome.kind}`);
    }
    const reached = await documentsSince(start, path);
    const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, ENTRY_CHECK_ARTIFACT_FILE_NAME), 'utf8')) as EntryCheckDocument;
    return { document, reached, own };
  };

  const discover = async (
    path: string,
    mode: SettleMode = 'NOT_SETTLING',
  ): Promise<{ readonly document: DiscoveryDocument; readonly reached: number }> => {
    const config = configOf(path, mode);
    const start = documents.length;
    const outcome = await executeDiscoveryRun({
      config, jobId: `job-discovery-${runCount}`, launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
      stopSignal: new AbortController().signal, observationWindows: observationWindowsFor(mode),
      authentication: {
        initialState: { cookies: [], origins: [] },
        approvedTestOrigins: [site.origin],
        auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        sessionLostPathPrefix: '/login-page',
        filterState: filterAuthenticatedState,
      },
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the discovery did not run: ${outcome.kind}`);
    }
    const reached = await documentsSince(start, path);
    return { document: JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument, reached };
  };

  // L10（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4。INV-LIMITS の S4 と設計者の判断）: 回数の上限（前は 2 回）でなく、同じ移りのくり返しで止める。
  // 自分を読み込み直し続ける画面は、1 回目の読み込み直し（A→A）を通し、2 回目（同じ移り）で止めて記録する。
  it('passes the first reload of a page and stops the repeated reload in the entry check, and does not read it (L10)', async () => {
    const { document, reached, own } = await entryCheck(PATHS.reload);
    expect(own).toBe(1);
    expect(reached).toBe(DOCUMENTS_UNTIL_REPEATED_RELOAD);
    expect(document.endReason).toBe('READ_FAILED');
  }, TEST_TIMEOUT_MS);

  it('passes the first reload of a page and stops the repeated reload in the discovery, and marks the page as not read in full (L10)', async () => {
    const { document, reached } = await discover(PATHS.reload);
    expect(reached).toBe(DOCUMENTS_UNTIL_REPEATED_RELOAD);
    const [page] = document.pages;
    expect(page?.state).toBe('READ');
    expect(page?.state === 'READ' ? page.record.incompleteReasons : []).toContain('INCOMPLETE_PAGE_NAVIGATION_LIMIT');
    expect(document.runStatus).toBe('PARTIAL');
  }, TEST_TIMEOUT_MS);

  it('passes the first reload of a page and stops the repeated reload for each load of BeakSight in the audit (L10)', async () => {
    const config = configOf(PATHS.reload);
    const pacer = createTestNavigationPacer(config);
    let own = 0;
    const start = documents.length;
    const outcome = await executeAuditRun(config, {
      launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
      // SLIM-GROUP（DEF-244・DEF-245 の A）: 止まる画面の見張りの反応なしの長さを短くする（本番の 180 秒を待たない）。
      createRunCoordinator: createQuietLimitedRunCoordinator,
      navigationPacer: forwardingNavigationPacer(pacer, async () => {
        own += 1;
        return pacer.beforeNavigation();
      }),
    }, { startNew: true });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the audit did not run: ${outcome.kind}`);
    }
    const reached = await documentsSince(start, PATHS.reload);
    expect(own).toBeGreaterThan(0);
    expect(reached).toBeLessThanOrEqual(own * DOCUMENTS_UNTIL_REPEATED_RELOAD);
    // 成果物: ビューポートは読み切れない（止めた理由は前と同じ `PAGE_NAVIGATION_LIMIT_REACHED`）。
    const [page] = (await readRunAudit(outcome.runDirectory)).pages;
    const desktop = page?.viewports.desktop ?? { incompleteReasons: [], status: null };
    expect(desktop.incompleteReasons.map(({ code }) => code)).toContain('PAGE_NAVIGATION_LIMIT_REACHED');
    expect(desktop.status).toBe('PARTIAL');
  }, TEST_TIMEOUT_MS);

  /** 画面の path の READ の確かめ（期待は、画面にない文字）。 */
  const pageReadCheck = async (
    path: string,
    mode: SettleMode = 'NOT_SETTLING',
  ): Promise<{ readonly document: ReadEvidenceDocument; readonly reached: number }> => {
    const config = configOf(path, mode);
    const start = documents.length;
    const outcome = await executeReadCheckRun({
      config, jobId: `job-read-${runCount}`, launchBrowser: launch, clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
      settlePolicy: settlePolicyOf(mode),
      authentication: {
        initialState: { cookies: [], origins: [] },
        approvedTestOrigins: [site.origin],
        auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        sessionLostPathPrefix: '/login-page',
        filterState: filterAuthenticatedState,
      },
      readChecks: [{
        readCheckId: 'read-1', readCheckRevision: 1, targetPage: { origin: site.origin, path },
        definition: { targetPagePath: path, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: ABSENT_TEXT }] },
      }],
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the READ check did not run: ${outcome.kind}`);
    }
    const reached = await documentsSince(start, path);
    return { document: JSON.parse(readFileSync(join(outcome.runDirectory, 'read-evidence.json'), 'utf8')) as ReadEvidenceDocument, reached };
  };

  it('passes the first reload of a page and stops the repeated reload in the page READ, and does not judge the page that did not settle (L10)', async () => {
    const { document, reached } = await pageReadCheck(PATHS.reload);
    expect(reached).toBe(DOCUMENTS_UNTIL_REPEATED_RELOAD);
    const [check] = document.checks;
    expect(check?.state === 'EXECUTED' ? [check.result, check.expectations[0]?.undeterminedReason] : null)
      .toEqual(['UNDETERMINED', 'PAGE_NOT_SETTLED']);
  }, TEST_TIMEOUT_MS);

  it('judges the page READ after one JS forward as before', async () => {
    const { document } = await pageReadCheck(PATHS.jsRedirect, 'SETTLING');
    const [check] = document.checks;
    expect(check?.state === 'EXECUTED' ? check.result : null).toBe('NOT_MATCHED');
  }, TEST_TIMEOUT_MS);

  // SLIM-GROUP: 1 回の転送の形は JS の 1 つ（meta の転送の 1 回は、単体 `tests/unit/page-navigation-loop.test.ts` の数え方と同じ）。
  it.each([PATHS.jsRedirect])('still reads the page after one forward (%s)', async (path) => {
    const entry = await entryCheck(path, 'SETTLING');
    expect(entry.document.endReason).toBe('READ');
    expect(entry.document.landing?.path).toBe(PATHS.landing);
    const { document } = await discover(path, 'SETTLING');
    const [page] = document.pages;
    expect(page?.state === 'READ' ? [page.record.location?.path, page.record.incompleteReasons] : null).toEqual([PATHS.landing, []]);
    expect(document.runStatus).toBe('COMPLETE');
  }, TEST_TIMEOUT_MS);

  // T37R2-fix（T37R2 の I-1。設計書 8 章の最後の行）: 子の frame の、ページが始めた文書の読み込みも、frame ごとに上限（2 回）まで。数え方は main frame と
  // 同じ（各 frame の最初の文書の後から数える。転送の続きは数えない。判定が通した後だけ数える）。超えたら Guard が止めて記録し、その画面を読み切れない
  // 画面にする（main frame と同じ扱い）。
  const audit = async (path: string): Promise<{
    readonly own: number;
    readonly start: number;
    readonly page: PageAuditResult;
  }> => {
    const config = configOf(path);
    const pacer = createTestNavigationPacer(config);
    let own = 0;
    const start = documents.length;
    const outcome = await executeAuditRun(config, {
      launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
      createRunCoordinator: createQuietLimitedRunCoordinator,
      navigationPacer: forwardingNavigationPacer(pacer, async () => {
        own += 1;
        return pacer.beforeNavigation();
      }),
    }, { startNew: true });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the audit did not run: ${outcome.kind}`);
    }
    const [page] = (await readRunAudit(outcome.runDirectory)).pages;
    if (page === undefined) {
      throw new Error('the audit has no page');
    }
    return { own, start, page };
  };

  // L10 の S4（設計者の判断）: 子の frame が自分を読み込み直し続けると、1 回目の読み込み直しは通し、2 回目（同じ移りのくり返し）で止めて記録する。
  it('passes the first reload of a child frame and stops the repeated reload in the entry check, the discovery, the page READ and the audit (L10)', async () => {
    const path = PATHS.iframeReload;
    const frame = PATHS.frameReload;
    let start = documents.length;
    const entry = await entryCheck(path);
    const entryFrames = await documentsSince(start, frame);
    expect(entry.own).toBe(1);
    expect(entryFrames).toBe(DOCUMENTS_UNTIL_REPEATED_RELOAD);
    expect(entry.document.endReason).toBe('READ_FAILED');

    start = documents.length;
    const discovery = await discover(path);
    expect(await documentsSince(start, frame)).toBe(DOCUMENTS_UNTIL_REPEATED_RELOAD);
    const [page] = discovery.document.pages;
    expect(page?.state === 'READ' ? page.record.incompleteReasons : []).toContain('INCOMPLETE_PAGE_NAVIGATION_LIMIT');
    expect(discovery.document.runStatus).toBe('PARTIAL');

    start = documents.length;
    const read = await pageReadCheck(path);
    expect(await documentsSince(start, frame)).toBe(DOCUMENTS_UNTIL_REPEATED_RELOAD);
    const [check] = read.document.checks;
    expect(check?.state === 'EXECUTED' ? [check.result, check.expectations[0]?.undeterminedReason] : null).toEqual(['UNDETERMINED', 'PAGE_NOT_SETTLED']);

    const audited = await audit(path);
    expect(audited.own).toBeGreaterThan(0);
    expect(await documentsSince(audited.start, frame)).toBeLessThanOrEqual(audited.own * DOCUMENTS_UNTIL_REPEATED_RELOAD);
    const desktop = audited.page.viewports.desktop;
    expect(desktop.incompleteReasons.map(({ code }) => code)).toContain('PAGE_NAVIGATION_LIMIT_REACHED');
  }, TEST_TIMEOUT_MS);

  // SPEC-1: 親が子の frame を毎回違う URL へ移し続ける画面（前の上限を超える移動）の場面は消した。撤廃の確かめは単体
  // （`tests/unit/page-navigation-loop.test.ts`）の 1 つにした。
  it('still reads the page whose child frame forwards once', async () => {
    const entry = await entryCheck(PATHS.iframeForward, 'SETTLING');
    expect(entry.document.endReason).toBe('READ');
    const { document } = await discover(PATHS.iframeForward, 'SETTLING');
    const [page] = document.pages;
    // 子の frame のある画面は、今どおり子の frame を読まない印（`INCOMPLETE_FRAME_OR_CLOSED_SHADOW`）が付く。上限の印は付かない。
    expect(page?.state === 'READ' ? page.record.incompleteReasons : null).toEqual(['INCOMPLETE_FRAME_OR_CLOSED_SHADOW']);
    const read = await pageReadCheck(PATHS.iframeForward, 'SETTLING');
    const [check] = read.document.checks;
    expect(check?.state === 'EXECUTED' ? check.result : null).toBe('NOT_MATCHED');
  }, TEST_TIMEOUT_MS);

  // SPEC-1: 文書でない要求の数の上限（DEF-130-fix。L10 で撤廃）の場面（前の上限を超える要求・要求を出し続ける画面・少しの要求の数）は消した。
  // 撤廃の確かめは単体（`tests/unit/guard-request-verdict.test.ts`）の 1 つにした。要求の数は成果物に書かない。
});

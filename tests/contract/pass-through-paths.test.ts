/**
 * ずれの確かめ: 通信の通り道ごとの代表（RB-3 の枠。設計書 `doc/design/2026-11-15-beaksight-test-rebuild-design.md` 2 章 2・2 章 9・3.3、
 * 案 4 章 B）。確かめるのは「口で止めたら、本物の Chromium でもサイトに届かない」こと。
 * - 代表は、残す 8 つの守り（2 章 9）が要る通り道だけに置く。守りを外す通り道（Worker の中の WebSocket・WebRTC・先読み・Passive の WebSocket・
 *   読み込み直しの輪など）の代表は置かない。
 * - 両方の Chromium（テストの既定の headless shell と CLI の起動の設定）で流す。組は入口 `chromiumRunsOf`（`BOTH_CHROMIUM_LAUNCHERS`）を通すので、
 *   区切りの遅い組では CLI の起動の設定の 1 回（端から端の観点 V6）、両方に広げる回（`BEAKSIGHT_TEST_BOTH_CHROMIUM`。`safety`・`chromium-upgrade`・
 *   `related --both-chromium`）では 2 回になる。
 * - RB-4b: 止め方を「既定は通す。止めるのは削除・凍結・資格情報。READ_ONLY は読み取りでない HTTP の要求だけ」に裏返した後の、本番の止め方（本物の factory と
 *   Guard と出口の中継）で、守り 1・2・3・7・8 の代表を流す。fixture のページは `contract-site.ts` の 1 つのサーバにあり、「届いていない」はサーバの受けた
 *   要求で確かめる（閉じた後は、受けている途中の要求がなくなるまで待ってから数える）。
 * - FIN-1: ここに置かない代表と、確かめている所（両方の Chromium の回は、安全の一覧・漏れの確かめの一覧の 2 回）。
 *   - 押した後の書き込み（守り 2）: この組の「凍結の後の移動・ポップアップ・WebSocket」と、`discovery-submission-probe`・`discovery-coverage-safety`。
 *   - 別の process の iframe（OOPIF）の凍結の後の送信（守り 2）: `safety-gates` の GATE-S03 の Interaction OOPIF の場面。
 *   - 出口の中継の凍結と CONNECT（守り 2）: `egress-tunnel-admission`（両方の Chromium）と `egress-proxy-frozen-read`・`egress-proxy-tunnel-admission`。
 *   - 届く間隔（守り 4・5）: BeakSight の側の待ちで、Chromium の通り道によらない。`navigation-pacing`・`automated-login-pacing`。
 * - RB-4 fix・DEF-276: Worker の中の WebSocket は、凍結の後に押す操作さがしの PRIMARY でだけ止める（守り 2）。押さない凍結の PRIMARY と監査の PRIMARY で
 *   届くことも確かめる。
 * - DEF-276-relay: 操作さがしの PRIMARY の文書の WebSocket は、Node の側の中継でつなぐ。凍結の前は Cookie と Origin つきで届き（ws と wss）、凍結の後と
 *   最初から凍結では、文書と Worker の WebSocket が届かない。
 * - SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.1・2.4）: 守り 1 は BeakSight の操作の前の判定に移した（代表は
 *   `tests/integration/destructive-action-guard.test.ts`）。ページ自身の削除・削除の上書き・削除とログアウトの語・危険な語の WebSocket・Worker の削除・読み込み直しと
 *   閉じる時の後始末の削除は、監査（公開・認証つき）・ログインの段（自動・手動）・操作さがしの押す前・READ の確かめ・Interaction の押す前で届き、止めた記録は出ない
 *   （ログインの段の WebSocket は守り 3 で止める）。
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXTERNAL_SCHEME_TARGETS } from '../../fixtures/external-scheme-targets.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { AUDIT_SEND_PASS_EXCEPT_DELETE } from '../../src/core/audit-send-policy.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { isOutsideRunAuditScope } from '../../src/orchestration/authenticated-run.js';
import { navigatePage } from '../../src/orchestration/page-navigation.js';
import { createLoginCredentialGuard } from '../../src/safety/login-credential-guard.js';
import { LoginStageMonitor, activateInteractionFreeze } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { BOTH_CHROMIUM_LAUNCHERS, ONCE_CHROMIUM_LABEL } from '../helpers/chromium.js';
import { closedLoopbackOrigin, startLoopbackHttpServer } from '../helpers/loopback-server.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';
import { LOOPBACK_TEST_CERTIFICATE, LOOPBACK_TEST_KEY } from '../helpers/tls-test-certificate.js';
import {
  PASS_THROUGH_DANGEROUS_SOCKET_PATH,
  PASS_THROUGH_HITS,
  PASS_THROUGH_MOVE_TARGETS,
  PASS_THROUGH_PAGES,
  type PassThroughMoveTarget,
  PASS_THROUGH_RELAY_SOCKET_PATH,
  PASS_THROUGH_SOCKET_PATH,
  PASS_THROUGH_WORKER_SOCKET_PATH,
  REDIRECT_SECOND_HOP,
  SLOW_REDIRECT_MS,
  acceptEchoWebSocket,
  crossOriginOf,
  startContractSite,
  type ContractSite,
} from './contract-site.js';

/** 届くべき要求が届くまで待つ上限（ms）と、届いてはいけない要求を数える前の待ち（ms。閉じた後は `whenIdle` も待つ）。 */
const ARRIVAL_POLL_MS = 3_000;
const LATE_ARRIVAL_MS = 300;
/** 資格情報の守りの値（比べる長さ以上の、テストだけの値）。 */
const CREDENTIALS = Object.freeze({ username: 'contract-user', password: 'contract-pass-0001' });

/** SD-2: `sends` のページ自身の HTTP の送信（READ_ONLY のほかは、どれも届く）。 */
const PAGE_SENDS = Object.freeze([
  PASS_THROUGH_HITS.delete,
  PASS_THROUGH_HITS.override,
  PASS_THROUGH_HITS.bodyOverride,
  PASS_THROUGH_HITS.plain,
  PASS_THROUGH_HITS.deleteWord,
  PASS_THROUGH_HITS.logoutWord,
  PASS_THROUGH_HITS.beaconDelete,
  PASS_THROUGH_HITS.workerDelete,
  PASS_THROUGH_HITS.reloadDelete,
  PASS_THROUGH_HITS.closeDelete,
]);

describe.each(BOTH_CHROMIUM_LAUNCHERS)('RB-4b: a stop by the Guard never reaches the site through each path (%s)', (name, launch) => {
  let site: ContractSite;
  let browser: Browser;

  beforeAll(async () => {
    site = await startContractSite(`${await closedLoopbackOrigin()}/unreachable`);
    browser = await launch();
  });

  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  const receivedPaths = (start: number): readonly string[] => site.received().slice(start).map((line) => line.split(' ')[1] ?? '');
  const arrived = (start: number, path: string): boolean => receivedPaths(start).includes(path);
  /** 閉じた後に、遅れて届く分を待ってから数える（ずれの確かめの中だけに置く。設計書 2 章 3）。 */
  const settle = async (): Promise<void> => {
    await site.whenIdle(LATE_ARRIVAL_MS);
    await new Promise((resolve) => setTimeout(resolve, LATE_ARRIVAL_MS));
  };
  /** `run`: 監査の Run（`pageAuditRun`）か、操作さがしの Run（`submissionProbeRun`）の印。省略は印なし（READ の確かめ・入口の確かめ・書き込みのジョブ）。 */
  const factoryOf = (sendPolicy: 'PASS_EXCEPT_DELETE' | 'READ_ONLY', run?: 'PAGE_AUDIT' | 'SUBMISSION_PROBE'): BrowserContextFactory =>
    new BrowserContextFactory(browser, createTestConfig(site.origin, '/'), () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      ...(run === 'PAGE_AUDIT' ? { pageAuditRun: true as const } : {}),
      ...(run === 'SUBMISSION_PROBE' ? { submissionProbeRun: true as const } : {}),
      ...(sendPolicy === 'PASS_EXCEPT_DELETE'
        ? { auditSend: { policy: AUDIT_SEND_PASS_EXCEPT_DELETE, approvedServiceOrigins: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS } }
        : {}),
    });
  /** Passive の Context でページを開き、`run` の後に Context を閉じる（閉じるときの送信も数える）。 */
  const inPassive = async (sendPolicy: 'PASS_EXCEPT_DELETE' | 'READ_ONLY', path: string, run: (page: Page) => Promise<void>): Promise<SafetyLedger> => {
    const factory = factoryOf(sendPolicy);
    try {
      const context = await factory.createPassiveContext(createTestConfig(site.origin, '/').viewports.primaryDesktop, 'REVISIT');
      const page = await factory.createPassivePage(context);
      // 読み込みの中で form を送るページは load の事象を待てない（204 の移動）ので、文書の始まりまで待つ。
      await page.goto(`${site.origin}${path}`, { waitUntil: 'commit' });
      await run(page);
      await factory.closePassiveContext(context);
      return factory.getSafetyLedger(context);
    } finally {
      await factory.close();
    }
  };

  /** SD-2: 止めた記録（要求・WebSocket・監査の段の除外・閉じる途中）のうち、fixture の通り道の代表の宛先のもの。 */
  const blockedSendsOf = (ledger: SafetyLedger): readonly string[] => {
    const snapshot = ledger.snapshot();
    return [
      ...snapshot.blockedRequests.map(({ url }) => url),
      ...snapshot.blockedWebSockets.map(({ url }) => url),
      ...(snapshot.blockedAuditExclusions?.events ?? []).map(({ url }) => url),
      ...(snapshot.blockedClosingRequests?.events ?? []).map(({ url }) => url ?? ''),
    ].filter((url) => url.includes('/pt/hit/') || url.includes(PASS_THROUGH_DANGEROUS_SOCKET_PATH));
  };
  const viewport = (): ReturnType<typeof createTestConfig>['viewports']['primaryDesktop'] => createTestConfig(site.origin, '/').viewports.primaryDesktop;
  const scriptRequest = (): { readonly scriptLogin: { readonly origin: string; readonly path: string; readonly requiredQuery: readonly [] }; readonly loginSideRequests: readonly []; readonly approvedServiceOrigins: readonly [] } =>
    ({ scriptLogin: { origin: site.origin, path: '/token', requiredQuery: [] }, loginSideRequests: [], approvedServiceOrigins: [] });
  const auditSendOption = { auditSend: { policy: AUDIT_SEND_PASS_EXCEPT_DELETE, approvedServiceOrigins: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS } } as const;
  /** SD-2 の場面: 名前、factory、Context の作り方、ログインの段か（ログインの段の WebSocket は守り 3 で止める）。 */
  const SELF_SEND_SCENES: readonly {
    readonly name: string;
    readonly loginStage: boolean;
    readonly open: () => { readonly factory: BrowserContextFactory; readonly context: (factory: BrowserContextFactory) => Promise<BrowserContext> };
  }[] = [
    {
      name: 'public audit',
      loginStage: false,
      open: () => ({ factory: factoryOf('PASS_EXCEPT_DELETE', 'PAGE_AUDIT'), context: (factory) => factory.createPassiveContext(viewport(), 'PRIMARY', { pageAuditLoad: true }) }),
    },
    {
      name: 'authenticated audit',
      loginStage: false,
      open: () => ({
        factory: new BrowserContextFactory(browser, createTestConfig(site.origin, '/'), () => new SafetyLedger(), {
          ...TEST_FACTORY_OPTIONS,
          pageAuditRun: true,
          ...auditSendOption,
          authentication: {
            initialState: { cookies: [], origins: [] },
            filterState: (state) => state,
            auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
          },
        }),
        context: (factory) => factory.createPassiveContext(viewport(), 'PRIMARY', { pageAuditLoad: true }),
      }),
    },
    {
      name: 'automated login stage',
      loginStage: true,
      // 自動ログインの段の印は、設定の送信の扱い（`PASS_EXCEPT_DELETE`）から factory が付ける。
      open: () => ({
        factory: new BrowserContextFactory(browser, createTestConfig(site.origin, '/', { audit: { sendPolicy: AUDIT_SEND_PASS_EXCEPT_DELETE } }), () => new SafetyLedger(), TEST_FACTORY_OPTIONS),
        context: (factory) => factory.createLoginStageContext(viewport(), {
          loginPostEndpoints: [],
          maxLoginPosts: 1,
          monitor: new LoginStageMonitor(),
          scriptRequest: scriptRequest(),
          credentialGuard: createLoginCredentialGuard(CREDENTIALS),
        }),
      }),
    },
    {
      name: 'manual login stage',
      loginStage: true,
      open: () => ({
        factory: new BrowserContextFactory(browser, createTestConfig(site.origin, '/'), () => new SafetyLedger(), TEST_FACTORY_OPTIONS),
        context: (factory) => factory.createLoginStageContext(viewport(), {
          loginPostEndpoints: [],
          maxLoginPosts: 1,
          monitor: new LoginStageMonitor(),
          scriptRequest: scriptRequest(),
          manualPassThrough: true,
        }),
      }),
    },
    {
      name: 'discovery before the press',
      loginStage: false,
      open: () => ({ factory: factoryOf('PASS_EXCEPT_DELETE', 'SUBMISSION_PROBE'), context: (factory) => factory.createPassiveContext(viewport(), 'PRIMARY') }),
    },
    {
      name: 'READ check',
      loginStage: false,
      open: () => ({ factory: factoryOf('PASS_EXCEPT_DELETE'), context: (factory) => factory.createPassiveContext(viewport(), 'PRIMARY') }),
    },
  ];

  it.each(SELF_SEND_SCENES)('page own sends in the $name (SD-2): the deletes, the delete and logout words, the Worker, the reload and close cleanups arrive, and nothing is recorded as stopped', async ({ open, loginStage }) => {
    const start = site.received().length;
    const { factory, context: contextOf } = open();
    let ledger: SafetyLedger;
    try {
      const context = await contextOf(factory);
      const page = await factory.createPassivePage(context);
      await page.goto(`${site.origin}${PASS_THROUGH_PAGES.sends}`, { waitUntil: 'commit' });
      // 読み込み直しの後始末が届き、読み込み直した文書の送信が届くまで待つ。
      await expect.poll(() => arrived(start, PASS_THROUGH_HITS.reloadDelete)
        && receivedPaths(start).filter((path) => path === PASS_THROUGH_HITS.plain).length >= 2, { timeout: ARRIVAL_POLL_MS }).toBe(true);
      await factory.closePassiveContext(context);
      ledger = factory.getSafetyLedger(context);
    } finally {
      await factory.close();
    }
    await settle();
    expect(PAGE_SENDS.filter((path) => !arrived(start, path))).toEqual([]);
    expect(site.received().slice(start).includes(`UPGRADE ${PASS_THROUGH_DANGEROUS_SOCKET_PATH}`)).toBe(!loginStage);
    expect(blockedSendsOf(ledger).filter((url) => !(loginStage && url.includes(PASS_THROUGH_DANGEROUS_SOCKET_PATH)))).toEqual([]);
  });

  // SD-2（設計書 2.4 の「main frame の文書の移動」）: ページの script の移動とサーバの 3xx は、削除の語の path・読まないパス・許可 Origin の外へも届き、止めた記録は
  // 出ない。移った画面は、読み込みの部品（`navigatePage` と Run の範囲の判定 `isOutsideRunAuditScope`。監査の Page Auditor と発見の 1 画面の読み込みが同じ口を
  // 渡す）が点検しない（`BLOCKED_EXTERNAL_REDIRECT`）。BeakSight の巡回が削除の語のリンクへ移らないことは SD-1 の `destructive-action-guard.test.ts` が確かめる。
  it.each(['PAGE_AUDIT', 'SUBMISSION_PROBE'] as const)('main frame moves of the page in a %s Run (SD-2): they arrive without a stop record, and the moved screen is not audited', async (run) => {
    const exclusions = { excludedPathPrefixes: ['/pt/hit/private'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS };
    const runAuthentication = { auditExclusions: exclusions, sessionLostPathPrefix: null };
    const allowed: ReadonlySet<string> = new Set([site.origin]);
    for (const target of Object.keys(PASS_THROUGH_MOVE_TARGETS) as PassThroughMoveTarget[]) {
      const factory = new BrowserContextFactory(browser, createTestConfig(site.origin, '/'), () => new SafetyLedger(), {
        ...TEST_FACTORY_OPTIONS,
        ...(run === 'PAGE_AUDIT' ? { pageAuditRun: true as const } : { submissionProbeRun: true as const }),
        ...auditSendOption,
        authentication: { initialState: { cookies: [], origins: [] }, filterState: (state) => state, auditExclusions: exclusions },
      });
      const start = site.received().length;
      const movedTo = (): boolean => arrived(start, PASS_THROUGH_MOVE_TARGETS[target]);
      try {
        const context = await factory.createPassiveContext(viewport(), 'PRIMARY');
        const page = await factory.createPassivePage(context);
        await page.goto(`${site.origin}${PASS_THROUGH_PAGES.scriptMove}?to=${target}`);
        await expect.poll(movedTo, { timeout: ARRIVAL_POLL_MS }).toBe(true);
        const redirectStart = site.received().length;
        const navigation = await navigatePage(page, `${site.origin}${PASS_THROUGH_PAGES.redirectMove}?to=${target}`, {
          timeoutMs: ARRIVAL_POLL_MS,
          ledger: factory.getSafetyLedger(context),
          allowedQueryParameters: new Set(),
          isOutsideAuditScope: (url) => isOutsideRunAuditScope(url, allowed, runAuthentication),
        });
        expect(navigation.navigationOutcome, target).toBe('BLOCKED_EXTERNAL_REDIRECT');
        expect(arrived(redirectStart, PASS_THROUGH_MOVE_TARGETS[target]), target).toBe(true);
        await factory.closePassiveContext(context);
        const snapshot = factory.getSafetyLedger(context).snapshot();
        expect([...blockedSendsOf(factory.getSafetyLedger(context)), ...snapshot.blockedNavigations.map(({ url }) => url)], target).toEqual([]);
      } finally {
        await factory.close();
      }
    }
  });

  it('form submission of the page script (SD-2): a form POST with _method=DELETE and a plain form POST arrive', async () => {
    const start = site.received().length;
    await inPassive('PASS_EXCEPT_DELETE', PASS_THROUGH_PAGES.formDelete, async () => {
      await expect.poll(() => arrived(start, PASS_THROUGH_HITS.formDelete), { timeout: ARRIVAL_POLL_MS }).toBe(true);
    });
    await inPassive('PASS_EXCEPT_DELETE', PASS_THROUGH_PAGES.formPost, async () => {
      await expect.poll(() => arrived(start, PASS_THROUGH_HITS.formPost), { timeout: ARRIVAL_POLL_MS }).toBe(true);
    });
  });

  it('READ_ONLY chosen by a person: no non-read HTTP request arrives, and a WebSocket (realtime) arrives', async () => {
    const start = site.received().length;
    await inPassive('READ_ONLY', PASS_THROUGH_PAGES.sends, async () => {
      await expect.poll(() => site.received().slice(start).includes(`UPGRADE ${PASS_THROUGH_DANGEROUS_SOCKET_PATH}`), { timeout: ARRIVAL_POLL_MS }).toBe(true);
    });
    await settle();
    expect(PAGE_SENDS.filter((path) => arrived(start, path))).toEqual([]);
  });

  // RB-14b: 人が選んだ READ_ONLY では、ページの script の form の POST（文書の移動）も届かない（PASS_EXCEPT_DELETE では届く。上の form の場面）。
  it('READ_ONLY chosen by a person: a plain form POST of the page script never arrives', async () => {
    const start = site.received().length;
    const ledger = await inPassive('READ_ONLY', PASS_THROUGH_PAGES.formPost, async () => {
      await new Promise((resolve) => setTimeout(resolve, LATE_ARRIVAL_MS));
    });
    await settle();
    expect(arrived(start, PASS_THROUGH_PAGES.formPost)).toBe(true);
    expect(arrived(start, PASS_THROUGH_HITS.formPost)).toBe(false);
    // REV-RB14 の M-4: 送らなかったのでなく、Guard が止めたこと。
    expect(ledger.snapshot().blockedRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'POST', url: `${site.origin}${PASS_THROUGH_HITS.formPost}`, reason: 'NON_READ_METHOD' }),
    ]));
  });

  // REV-RB14 の I-1: 凍結しない監査の Context の PASS_EXCEPT_DELETE では、別の許可 Origin への CORS の事前確認もサーバへ送り、サーバの答えで満たす。サーバが拒んだ
  // 本番の PUT は、ブラウザが送らない。
  it('CORS preflight to another allowed origin (PASS_EXCEPT_DELETE audit): the preflight arrives, and the PUT the server refused never arrives', async () => {
    const base = createTestConfig(site.origin, '/');
    const config = { ...base, site: { ...base.site, allowedOrigins: [site.origin, crossOriginOf(site.origin)] } };
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      pageAuditRun: true,
      auditSend: { policy: AUDIT_SEND_PASS_EXCEPT_DELETE, approvedServiceOrigins: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
    });
    const start = site.received().length;
    const preflighted = (): boolean => site.received().slice(start).includes(`OPTIONS ${PASS_THROUGH_HITS.corsReject}`);
    try {
      const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY');
      const page = await factory.createPassivePage(context);
      await page.goto(`${site.origin}${PASS_THROUGH_PAGES.cors}`);
      await expect.poll(preflighted, { timeout: ARRIVAL_POLL_MS }).toBe(true);
      await factory.closePassiveContext(context);
    } finally {
      await factory.close();
    }
    await settle();
    expect(site.received().slice(start)).not.toContain(`PUT ${PASS_THROUGH_HITS.corsReject}`);
  });

  // RB-14b: サーバの 3xx の続きは route に来ず、CDP の要求の段でだけ判定する（passive-request-guard-browser の Playwright の前提）。SD-2（設計書 2.4 の「main frame の
  // 文書の移動」）: 認証つきの監査（危険な語の読まない URL を Guard に渡す Run）でも、2 回の 3xx の先の、削除の語の path への続きは届く（サーバのリダイレクトは
  // サイトのもの。移った画面は読み込みの部品が点検しない）。
  it('server redirect of an own navigation in an authenticated audit (SD-2): a multi-hop 3xx follow-up to a delete-term path arrives', async () => {
    const factory = new BrowserContextFactory(browser, createTestConfig(site.origin, '/'), () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      auditSend: { policy: AUDIT_SEND_PASS_EXCEPT_DELETE, approvedServiceOrigins: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      authentication: {
        initialState: { cookies: [], origins: [] },
        filterState: (state) => state,
        auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      },
    });
    const start = site.received().length;
    try {
      const context = await factory.createPassiveContext(createTestConfig(site.origin, '/').viewports.primaryDesktop, 'REVISIT');
      const page = await factory.createPassivePage(context);
      await page.goto(`${site.origin}${PASS_THROUGH_PAGES.redirectHops}`).catch(() => undefined);
      await factory.closePassiveContext(context);
    } finally {
      await factory.close();
    }
    await settle();
    // REV-RB14 の M-4: 2 段目の 3xx まで届いた（続きをたどった）こと。
    expect(arrived(start, PASS_THROUGH_PAGES.redirectHops)).toBe(true);
    expect(arrived(start, REDIRECT_SECOND_HOP)).toBe(true);
    expect(arrived(start, PASS_THROUGH_HITS.redirectDelete)).toBe(true);
  });

  // RB-14b: 凍結の前に始まった移動の 3xx の応答が、凍結の後に届いても、その続きは届かない。
  it('server redirect after the freeze (PROBE_FREEZE): the 3xx follow-up of a navigation started before the freeze never arrives', async () => {
    const factory = factoryOf('PASS_EXCEPT_DELETE');
    const start = site.received().length;
    try {
      const session = await factory.createInteractionSession(createTestConfig(site.origin, '/').viewports.primaryDesktop);
      await session.page.goto(`${site.origin}${PASS_THROUGH_PAGES.credential}`);
      await session.page.evaluate((url) => { location.href = url; }, PASS_THROUGH_PAGES.slowRedirect);
      await expect.poll(() => arrived(start, PASS_THROUGH_PAGES.slowRedirect), { timeout: ARRIVAL_POLL_MS }).toBe(true);
      await session.activateInteractionFreeze();
      await new Promise((resolve) => setTimeout(resolve, SLOW_REDIRECT_MS + LATE_ARRIVAL_MS));
      await session.close();
    } finally {
      await factory.close();
    }
    await settle();
    expect(arrived(start, PASS_THROUGH_HITS.frozenRedirect)).toBe(false);
  });

  // RB-4b（設計者の判断）・SD-2: Isolated Interaction Context の押す前の段も、ページ自身の送信を通す（削除も）。WebSocket は、押した後の凍結を迂回させないため止める。
  it('Interaction before the press (SD-2): the page own sends arrive, and a WebSocket does not', async () => {
    const factory = factoryOf('PASS_EXCEPT_DELETE');
    const start = site.received().length;
    try {
      const session = await factory.createInteractionSession(createTestConfig(site.origin, '/').viewports.primaryDesktop);
      await session.page.goto(`${site.origin}${PASS_THROUGH_PAGES.sends}`, { waitUntil: 'commit' });
      await expect.poll(() => arrived(start, PASS_THROUGH_HITS.reloadDelete), { timeout: ARRIVAL_POLL_MS }).toBe(true);
      await session.close();
    } finally {
      await factory.close();
    }
    await settle();
    expect(PAGE_SENDS.filter((path) => !arrived(start, path))).toEqual([]);
    expect(site.received().slice(start)).not.toContain(`UPGRADE ${PASS_THROUGH_DANGEROUS_SOCKET_PATH}`);
  });

  it('navigation, popup and WebSocket after the freeze (PROBE_FREEZE): nothing sent after the freeze arrives', async () => {
    const factory = factoryOf('PASS_EXCEPT_DELETE');
    const start = site.received().length;
    try {
      const session = await factory.createInteractionSession(createTestConfig(site.origin, '/').viewports.primaryDesktop);
      await session.page.goto(`${site.origin}${PASS_THROUGH_PAGES.frozen}`);
      const frozenStart = site.received().length;
      await session.activateInteractionFreeze();
      await session.page.evaluate(() => (window as unknown as { afterFreeze(): boolean }).afterFreeze()).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, LATE_ARRIVAL_MS * 2));
      await session.close();
      await settle();
      expect(site.received().slice(frozenStart)).toEqual([]);
    } finally {
      await factory.close();
    }
    expect(arrived(start, PASS_THROUGH_PAGES.frozen)).toBe(true);
  });

  // RB-4 fix（REV-RB4 の C-1）: 凍結の後に押す操作さがしの PRIMARY では、凍結の読み取りで宛先を通した後も、Worker の中の WebSocket が届かない。
  it('Worker WebSocket after the freeze of a discovery PRIMARY (PROBE_FREEZE): it never arrives, while the frozen read arrives', async () => {
    const factory = factoryOf('PASS_EXCEPT_DELETE', 'SUBMISSION_PROBE');
    let frozenStart = 0;
    try {
      const context = await factory.createPassiveContext(createTestConfig(site.origin, '/').viewports.primaryDesktop, 'PRIMARY');
      const page = await factory.createPassivePage(context);
      await page.goto(`${site.origin}${PASS_THROUGH_PAGES.frozenWorker}`);
      await activateInteractionFreeze(page);
      frozenStart = site.received().length;
      await page.evaluate(() => (window as unknown as { afterFreeze(): boolean }).afterFreeze()).catch(() => undefined);
      await expect.poll(() => arrived(frozenStart, PASS_THROUGH_HITS.frozenRead), { timeout: ARRIVAL_POLL_MS }).toBe(true);
      await factory.closePassiveContext(context);
    } finally {
      await factory.close();
    }
    await settle();
    expect(site.received().slice(frozenStart)).not.toContain(`UPGRADE ${PASS_THROUGH_WORKER_SOCKET_PATH}`);
  });

  // DEF-276-relay: 操作さがしの PRIMARY の文書の WebSocket は、Node の側の中継でつなぐ（ws を止める CSP は残す）。凍結の前は届き、凍結の後は届かない。
  type RelayWindow = { openRelay(url: string): Promise<string>; sendRelay(text: string): string };
  const relaySocketUrl = (origin: string): string => `${origin.replace(/^http/u, 'ws')}${PASS_THROUGH_RELAY_SOCKET_PATH}`;
  const openRelay = (page: Page, url: string): Promise<string> => page.evaluate((target) => (window as unknown as RelayWindow).openRelay(target), url);
  /** 操作さがしの PRIMARY の Context で `path` を開き、`run` の後に閉じる（閉じた後の Ledger を返す）。 */
  const inProbePrimary = async (path: string, run: (page: Page) => Promise<void>, factory = factoryOf('PASS_EXCEPT_DELETE', 'SUBMISSION_PROBE')): Promise<SafetyLedger> => {
    try {
      const context = await factory.createPassiveContext(createTestConfig(site.origin, '/').viewports.primaryDesktop, 'PRIMARY');
      const page = await factory.createPassivePage(context);
      await page.goto(`${site.origin}${path}`);
      await run(page);
      await factory.closePassiveContext(context);
      return factory.getSafetyLedger(context);
    } finally {
      await factory.close();
    }
  };

  it('document WebSocket of a discovery PRIMARY before the freeze (relayed): it arrives with the Cookie and the Origin, and the reply returns', async () => {
    const start = site.received().length;
    const ledger = await inProbePrimary(PASS_THROUGH_PAGES.relay, async (page) => {
      expect(await openRelay(page, relaySocketUrl(site.origin))).toBe('echo:hello');
    });
    expect(site.received().slice(start)).toEqual(expect.arrayContaining([`UPGRADE-HEADERS ${site.origin} pt=relay`, 'FRAME hello']));
    // 通した接続として 1 本（Guard の route を通った接続）を記録する。
    expect(ledger.snapshot().passedAuditSendWebSockets).toMatchObject({ count: 1, outsideGuard: 0 });
  });

  // REV-DEF276 の I-1: 別の Origin の iframe があっても、握手の Origin は main frame の Origin で、SameSite=Lax の Cookie も届く（ブラウザと同じ。1 回だけ流す）。
  it.runIf(name === ONCE_CHROMIUM_LABEL)('document WebSocket of a discovery PRIMARY with a cross-origin iframe (relayed): the Origin of the main frame and the Lax Cookie arrive', async () => {
    const start = site.received().length;
    await inProbePrimary(PASS_THROUGH_PAGES.relayFramed, async (page) => {
      await expect.poll(() => page.frames().some((frame) => frame.url().startsWith('http://localhost'))).toBe(true);
      expect(await openRelay(page, relaySocketUrl(site.origin))).toBe('echo:hello');
    });
    expect(site.received().slice(start)).toContain(`UPGRADE-HEADERS ${site.origin} pt=relay`);
  });

  it('document WebSocket of a discovery PRIMARY after the freeze (PROBE_FREEZE): the relayed connection is cut, and a new one never arrives', async () => {
    let frozenStart = 0;
    await inProbePrimary(PASS_THROUGH_PAGES.relay, async (page) => {
      expect(await openRelay(page, relaySocketUrl(site.origin))).toBe('echo:hello');
      await activateInteractionFreeze(page);
      frozenStart = site.received().length;
      await page.evaluate(() => (window as unknown as RelayWindow).sendRelay('after-freeze'));
      expect(await openRelay(page, relaySocketUrl(site.origin))).toBe('close');
    });
    await settle();
    expect(site.received().slice(frozenStart)).toEqual([]);
  });

  it('a discovery PRIMARY frozen from the start (PROBE_FREEZE): neither the document nor the Worker WebSocket arrives', async () => {
    const factory = factoryOf('PASS_EXCEPT_DELETE', 'SUBMISSION_PROBE');
    const start = site.received().length;
    try {
      const { context, page } = await factory.openFrozenObservationContext(createTestConfig(site.origin, '/').viewports.primaryDesktop);
      const url = `${site.origin}${PASS_THROUGH_PAGES.frozenWorker}`;
      await factory.loadFrozenDocument(page, url, () => page.goto(url));
      await page.evaluate((target) => { try { new WebSocket(target); } catch { /* CSP */ } }, relaySocketUrl(site.origin));
      await new Promise((resolve) => setTimeout(resolve, LATE_ARRIVAL_MS));
      await factory.closePassiveContext(context);
    } finally {
      await factory.close();
    }
    await settle();
    expect(site.received().slice(start).filter((line) => line.startsWith('UPGRADE'))).toEqual([]);
  });

  it('document WebSocket of a discovery PRIMARY over wss (relayed, the test-trusted certificate): it arrives and the reply returns', async () => {
    const tlsReceived: string[] = [];
    const tlsServer = await startLoopbackHttpServer((_request, response) => response.writeHead(404).end(), { tls: { cert: LOOPBACK_TEST_CERTIFICATE, key: LOOPBACK_TEST_KEY } });
    tlsServer.server.on('upgrade', (request: IncomingMessage, socket: Duplex) => acceptEchoWebSocket(request, socket, tlsReceived));
    try {
      const factory = new BrowserContextFactory(browser, createTestConfig(site.origin, '/'), () => new SafetyLedger(), {
        ...TEST_FACTORY_OPTIONS,
        submissionProbeRun: true,
        writeSubmissionCertificates: [LOOPBACK_TEST_CERTIFICATE],
        auditSend: { policy: AUDIT_SEND_PASS_EXCEPT_DELETE, approvedServiceOrigins: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      });
      await inProbePrimary(PASS_THROUGH_PAGES.relay, async (page) => {
        expect(await openRelay(page, relaySocketUrl(tlsServer.origin))).toBe('echo:hello');
      }, factory);
    } finally {
      await tlsServer.close();
    }
    expect(tlsReceived).toContain('FRAME hello');
  });

  // DEF-276: 読み取りの安定のためだけに凍結する PRIMARY（印なし。凍結の後に押さない）では、凍結の前の文書と Worker の WebSocket が届く。
  it('freeze-only PRIMARY (intended): a WebSocket of the document and of a Worker arrive before the freeze', async () => {
    const factory = factoryOf('PASS_EXCEPT_DELETE');
    const start = site.received().length;
    const upgraded = (path: string): boolean => site.received().slice(start).includes(`UPGRADE ${path}`);
    try {
      const context = await factory.createPassiveContext(createTestConfig(site.origin, '/').viewports.primaryDesktop, 'PRIMARY');
      const page = await factory.createPassivePage(context);
      await page.goto(`${site.origin}${PASS_THROUGH_PAGES.frozenWorker}`);
      await page.evaluate((url) => { try { new WebSocket(url); } catch { /* CSP */ } }, `${site.origin.replace('http', 'ws')}${PASS_THROUGH_SOCKET_PATH}`);
      await expect.poll(() => [upgraded(PASS_THROUGH_SOCKET_PATH), upgraded(PASS_THROUGH_WORKER_SOCKET_PATH)], { timeout: ARRIVAL_POLL_MS }).toEqual([true, true]);
      // 守り 2 の仕組み: この Context では、押す観察を始められない（印を付け損ねても、通信を止めていない Context で押さない）。
      expect(() => factory.submissionObservationOf(context)?.begin({ pagePath: '/', markers: [] })).toThrow(Error);
      await factory.closePassiveContext(context);
    } finally {
      await factory.close();
    }
  });

  it('audit PRIMARY (intended): a WebSocket in a Worker arrives', async () => {
    const factory = factoryOf('READ_ONLY', 'PAGE_AUDIT');
    const start = site.received().length;
    try {
      const context = await factory.createPassiveContext(createTestConfig(site.origin, '/').viewports.primaryDesktop, 'PRIMARY');
      const page = await factory.createPassivePage(context);
      await page.goto(`${site.origin}${PASS_THROUGH_PAGES.frozenWorker}`);
      await expect.poll(() => site.received().slice(start).includes(`UPGRADE ${PASS_THROUGH_WORKER_SOCKET_PATH}`), { timeout: ARRIVAL_POLL_MS }).toBe(true);
      await factory.closePassiveContext(context);
    } finally {
      await factory.close();
    }
  });

  it('credential destination: a request carrying the credentials never arrives outside the registered destination', async () => {
    const factory = new BrowserContextFactory(browser, createTestConfig(site.origin, '/'), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    const start = site.received().length;
    try {
      const context = await factory.createLoginStageContext(createTestConfig(site.origin, '/').viewports.primaryDesktop, {
        loginPostEndpoints: [],
        maxLoginPosts: 1,
        monitor: new LoginStageMonitor(),
        scriptRequest: { scriptLogin: { origin: site.origin, path: '/token', requiredQuery: [] }, loginSideRequests: [], approvedServiceOrigins: [] },
        credentialGuard: createLoginCredentialGuard(CREDENTIALS),
      });
      const page = await factory.createPassivePage(context);
      await page.goto(`${site.origin}${PASS_THROUGH_PAGES.credential}`);
      await page.evaluate((value) => (window as unknown as { sendCredential(text: string): Promise<string> }).sendCredential(value), CREDENTIALS.password);
      await factory.closePassiveContext(context);
    } finally {
      await factory.close();
    }
    await settle();
    expect(arrived(start, PASS_THROUGH_HITS.credential)).toBe(false);
  });

  // 外のアプリを起こさないことそのものは、CLI の起動の設定の `url_blocklist` と自己検査が受け持つ（`external-launch-block.test.ts`）。ここでは、Guard が
  // 試みを 1 回だけ記録することを、両方の Chromium で確かめる。
  it('external scheme (EXTERNAL_APP): a script navigation to tel: is recorded once', async () => {
    const ledger = await inPassive('PASS_EXCEPT_DELETE', PASS_THROUGH_PAGES.credential, async (page) => {
      await page.evaluate((url) => { location.href = url; }, EXTERNAL_SCHEME_TARGETS.tel.url).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, LATE_ARRIVAL_MS * 2));
    });
    expect(ledger.snapshot().externalSchemeNavigations.map(({ scheme }) => scheme)).toEqual([EXTERNAL_SCHEME_TARGETS.tel.scheme]);
  });
});

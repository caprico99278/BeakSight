// T39b（Task 39 の設計書 `2026-10-17-beaksight-task-39-api-write-guard-design.md` 3.1、3.3、4 章、5 章の 1〜3）: API のシナリオの書き込みの段の Context の
// 読み取りと、Guard の API の分岐。通す部品（どれも本物。Chromium はテストの既定の headless と、CLI の起動の設定の両方）: 認証つきの `BrowserContextFactory`
// （監査の段の口、要求の上限の部品）の `createWriteStageContext`（送り方 `API`、承認した API の指定と生成した値、送り手の口）と、その Guard と中継。サイトは
// fixture（`startSpaAuthSite` の form のない会員の画面。`hostileMemberSave`・`hostileMemberInput` の敵対的な形）。
// - 押下の前に SPA の画面が描ける（書き込みの段でも、承認したサービスの Origin の読み取りが上限の中で通る）。
// - 送信の窓の中の、照合に一致する 1 回目だけが送り手の口に渡り（T39c の前は口が呼ばれたことを確かめる）、口の応答がページに返る。
// - 敵対的な形（2 回送る、値の書き換え、鍵の追加・削除、filter の値の書き換え、別の Origin・path、upsert、array、method の上書き、許していないヘッダ、
//   窓の外の送信、送信の直前の値の書き換え、Worker・iframe・beacon から送る、DELETE・手続きの呼び出し）は、止まって口に渡らず、サーバに届かない。
// - T39R-fix: 窓の中の、承認の endpoint の path でない要求（別の path、手続きの呼び出し）は照合にかけずに止め、書き込みの機会を使わない（M-2）。
//   同じ Origin の iframe が親の realm の送り方（`parent.fetch`・`top.XMLHttpRequest`）で送る形は、照合に一致した 1 回だけが渡り、2 回目は止まる（M-3。限界の固定）。
// 届いたかは fixture の記録で数える（読み取りでない要求。CORS の事前確認は Guard が満たすので届かない）。各場面は判定（ページの保存の結果、送り手の口、止めた
// 記録）が揃うまで poll して数え、全部の場面の後（Context を閉じた後）に `settleLateDeliveries` で静まるのを待ってから、場面ごとに数えた分と数え直す。値は出力しない。
// SLIM: Chromium とサイトは describe で共有する。照合の形の網羅（敵対的な形・ページの送信・前の値の写し）は単体 `api-write-payload-policy`・
// `api-write-payload-policy-update`・`request-policy-api-write-stage` に任せ、ここには代表と「照合で止めた要求が届かない」「DELETE・2 回目・Worker・iframe・
// beacon・中継へ直が届かない」を残す。
import { request as httpRequest } from 'node:http';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import { BrowserContextFactory, type AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import { AUDIT_SEND_PASS_EXCEPT_DELETE } from '../../src/core/audit-send-policy.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';
import type { ApiWritePayloadExpectation } from '../../src/safety/api-write-payload-policy.js';
import {
  AuditStageMonitor,
  WriteStageMonitor,
  type AdmittedApiWriteRequest,
  type GuardApiWriteStage,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import type { WriteSubmissionOutcome } from '../../src/safety/write-submission-sender.js';
import { overrideBrowser } from '../helpers/browser-proxies.js';
import { BOTH_CHROMIUM_LAUNCHERS, closeTestContexts } from '../helpers/chromium.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_API_KEY_HEADER,
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_FORMLESS_MEMBER_BOX,
  SPA_GRANT_TYPES,
  SPA_MEMBER_FIELDS,
  SPA_PREFER_HEADER,
  SPA_STATE_ELEMENTS,
  spaMemberEditPathOf,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
  type SpaHostileMemberSave,
} from '../helpers/spa-auth-site-fixture.js';
import { settleLateDeliveries } from '../helpers/loopback-server.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const TEST_TIMEOUT_MS = 120_000;
const UI_TIMEOUT_MS = 15_000;
/** 全部の場面の後（Context を閉じた後）に、遅れて届く要求を待つ上限（ms。`settleLateDeliveries`）。 */
const LATE_DELIVERY_SETTLE_MS = 1_500;
/** 押した後のページの保存の結果（`saved` か `error`）。判定が揃ったことの印。 */
const SAVE_SETTLED_STATES: readonly (string | null)[] = ['saved', 'error'];
/** 生成した値（テストの仮の値。結果の記録に出ないことは単体で確かめる）。 */
const VALUES = Object.freeze({ name: '試験 太郎', email: 't39b@example.test', note: '備考' });
const EXISTING_NAME = '既存花子';
/** 送り手の口が返す応答（T39c の前の仮の応答。ページに返ることを確かめる）。 */
const HANDOFF_BODY = '[{"id":999}]';

type Kind = 'CREATE' | 'UPDATE';

/** 承認した API の指定（fixture の form のない会員の画面のふつうの要求の型）と、生成した値。 */
const expectationOf = (site: SpaAuthSite, kind: Kind, recordId: string | null): ApiWritePayloadExpectation => ({
  spec: {
    request: {
      method: kind === 'CREATE' ? 'POST' : 'PATCH',
      origin: site.backendOrigin,
      pathShape: SPA_BACKEND_PATHS.members,
      queryNames: [],
      contentType: 'application/json',
      prefer: [SPA_PREFER_HEADER.value],
    },
    keyFields: [
      { key: 'email', type: 'string' },
      { key: 'name', type: 'string' },
      { key: 'note', type: 'string' },
    ],
    pageKeys: [],
    headerNames: [SPA_API_KEY_HEADER, 'authorization', 'content-type', SPA_PREFER_HEADER.name].sort(),
    filterName: kind === 'CREATE' ? null : 'id',
  },
  values: VALUES,
  recordId,
});

/**
 * T41c: 更新（UPDATE）の、変える鍵（名前）と保つ鍵（メールと備考。前の値は、送る前に読んだ既存の会員の値）の期待。fixture の form のない画面は、
 * 3 つの鍵をすべて本文に入れて送る。
 */
const updateKeptExpectationOf = (site: SpaAuthSite, id: number): ApiWritePayloadExpectation => {
  const base = expectationOf(site, 'UPDATE', String(id));
  const member = site.memberOf(id);
  return {
    ...base,
    spec: { ...base.spec, keyFields: [{ key: 'name', type: 'string' }] },
    values: { name: VALUES.name },
    keptKeys: [{ key: 'email', value: member?.email ?? '' }, { key: 'note', value: member?.note ?? '' }],
    pageKeyPriorValues: [],
  };
};

/**
 * LU-5（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0 の D1、5.3 の 1・3）: path に番号が入る形の更新の、型の path（最後の区切りが `{id}`）。
 * fixture のバックエンドは、知らない path の要求も記録する（届いたかを数えられる）。
 */
const PATH_SHAPE_ITEMS = '/api/items';
const PATH_SHAPE_TEMPLATE = `${PATH_SHAPE_ITEMS}/{id}`;
const PATH_SHAPE_RECORD_ID = '4';
const PATH_SHAPE_OTHER_ID = '5';
/** 窓の前（N2）に送る、承認した送信先の下でない読み取りでない要求の path（届くこと＝N2 の口が開いていることの確かめ）。 */
const PATH_SHAPE_UNRELATED = '/api/notes/1';

/** LU-5: path の形の更新の期待（filter なし、型の path の最後の区切りが `{id}`、台帳の番号）。 */
const pathShapeExpectationOf = (site: SpaAuthSite): ApiWritePayloadExpectation => {
  const base = expectationOf(site, 'UPDATE', PATH_SHAPE_RECORD_ID);
  return { ...base, spec: { ...base.spec, request: { ...base.spec.request, pathShape: PATH_SHAPE_TEMPLATE }, filterName: null } };
};

/** 送り手の口の偽物（呼ばれた要求の method と URL と、本文の長さだけを覚える。値は覚えない）。 */
interface HandoffSpy {
  readonly calls: { readonly method: string; readonly path: string; readonly bodyBytes: number; readonly pageKeys: readonly string[] }[];
  readonly handoff: (request: AdmittedApiWriteRequest) => Promise<WriteSubmissionOutcome>;
}

const handoffSpy = (site: SpaAuthSite): HandoffSpy => {
  const calls: HandoffSpy['calls'] = [];
  return {
    calls,
    handoff: async (request) => {
      calls.push({ method: request.method, path: new URL(request.url).pathname, bodyBytes: request.body.byteLength, pageKeys: Object.keys(request.pageKeyValues) });
      return {
        kind: 'RESPONDED',
        status: 201,
        headers: [
          { name: 'content-type', value: 'application/json' },
          { name: 'access-control-allow-origin', value: site.appOrigin },
        ],
        body: Buffer.from(HANDOFF_BODY),
        decoded: true,
      };
    },
  };
};

/** サービスの Origin（と承認していない Origin）に届いた、読み取りでない本番の要求（`<origin> <method> <path>`）。 */
const nonReadAtServices = (site: SpaAuthSite): readonly string[] => site.requests
  .filter((request) => request.origin !== 'app' && !request.preflight && request.method !== 'GET' && request.method !== 'HEAD')
  .map(({ origin, method, path }) => `${origin} ${method} ${path.split('?')[0] ?? ''}`);

describe.each(BOTH_CHROMIUM_LAUNCHERS)('T39b: the API write stage Guard with %s', (_label, launch) => {
  let realBrowser: Browser;
  let browser: Browser;
  /** SLIM: 全部の場面で共有するサイト（敵対的な保存の形は `setHostileMemberSave` で場面ごとに替える）。 */
  let shared: SpaAuthSite;
  /** 起動の指定が要る場面だけの、自分のサイト（場面の終わりに閉じる）。 */
  let own: SpaAuthSite | undefined;
  const factories: BrowserContextFactory[] = [];
  /** LU-SFIX1（Important-2）: 中継に直に送る確かめのため、Context の proxy の server を覚える（製品のコードは変えない）。 */
  const proxyServers = new WeakMap<BrowserContext, string>();
  /** これまでの場面で、共有のサイトに届いてよいと確かめた読み取りでない要求（全部の場面の後に数え直す）。 */
  const expectedReached: string[] = [];

  beforeAll(async () => {
    realBrowser = await launch();
    browser = overrideBrowser(realBrowser, {
      newContext: async (options?: BrowserContextOptions): Promise<BrowserContext> => {
        const context = await realBrowser.newContext(options);
        if (options?.proxy?.server !== undefined) proxyServers.set(context, options.proxy.server);
        return context;
      },
    });
    shared = await startSpaAuthSite({ memberScreenLayout: 'formless' });
  });

  const closeFactories = async (): Promise<void> => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await closeTestContexts(realBrowser);
  };

  afterEach(async () => {
    await closeFactories();
    shared.setHostileMemberSave(null);
    await own?.close();
    own = undefined;
  });

  afterAll(async () => {
    await shared?.close();
    await realBrowser?.close();
  });

  /** 共有のサイト（指定があれば、その場面だけの自分のサイト）。 */
  const startSite = async (options: SpaAuthSiteOptions = {}): Promise<SpaAuthSite> => {
    if (Object.keys(options).length === 0) return shared;
    own = await startSpaAuthSite({ memberScreenLayout: 'formless', ...options });
    return own;
  };

  const auditStageOf = (site: SpaAuthSite): AuditStageServiceRequests => ({
    approvedServiceOrigins: [site.backendOrigin],
    auditReadRequests: [],
    scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },  });

  /** 認証つきの factory で、API の書き込みの段の Context を開き、`path` を読み込む。 */
  const openStage = async (
    site: SpaAuthSite,
    kind: Kind,
    path: string,
    recordId: string | null = null,
    expectation: ApiWritePayloadExpectation = expectationOf(site, kind, recordId),
    withWriteStageAuditSend = false,
    /** LU-SFIX1（Important-2）: 送り手の口の偽物を渡さず、Guard の既定の送り手（中継を通す本物）で送る。 */
    realSender = false,
  ) => {
    const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.admin);
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.admin}`, allowedOrigins: [site.appOrigin] } };
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: {
        initialState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: site.issueStoredSession() }] }] },
        filterState: (state) => state,
        auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
        auditStage: auditStageOf(site),
      },
      serviceRequestBudget: createServiceRequestBudget({ now: () => Date.now() }),
      auditStageMonitor: new AuditStageMonitor(),
      // LU-5: 窓の前（N2）の守りを確かめる場面だけ、書き込みの段の送信の扱い（サイトの通信は止めない）を渡す。
      ...(withWriteStageAuditSend
        ? { writeStageAuditSend: { policy: AUDIT_SEND_PASS_EXCEPT_DELETE, approvedServiceOrigins: [site.backendOrigin], dangerousTerms: [] } }
        : {}),
    });
    factories.push(factory);
    const monitor = new WriteStageMonitor();
    const spy = handoffSpy(site);
    const stage: GuardApiWriteStage = realSender ? { transport: 'API', expectation, monitor } : { transport: 'API', expectation, monitor, handoff: spy.handoff };
    const context = await factory.createWriteStageContext(VIEWPORT, stage);
    const page = await factory.createPassivePage(context);
    const before = nonReadAtServices(site).length;
    await page.goto(`${site.appOrigin}${path}`);
    const ledger = factory.getSafetyLedger(context);
    /** この場面で、サービスの Origin に届いた読み取りでない要求。 */
    const reached = (): readonly string[] => nonReadAtServices(site).slice(before);
    return { page, monitor, spy, ledger, context, reached };
  };

  /** 場面の終わり: この場面で届いた要求が `expected` だけ（共有のサイトなら、全部の場面の後の数え直しに足す）。 */
  const expectReached = (site: SpaAuthSite, reached: () => readonly string[], expected: readonly string[] = []): void => {
    expect(reached()).toEqual(expected);
    if (site === shared) expectedReached.push(...expected);
  };

  /** 判定が揃うまで待つ（`check` が真になるまで poll。上限は `UI_TIMEOUT_MS`）。 */
  const untilSettled = async (check: () => boolean | Promise<boolean>): Promise<void> => {
    await expect.poll(check, { timeout: UI_TIMEOUT_MS }).toBe(true);
  };

  const boxState = (page: Page): Promise<string | null> =>
    page.locator(`#${SPA_FORMLESS_MEMBER_BOX}`).getAttribute('data-state').catch(() => null);
  const waitReady = async (page: Page): Promise<void> => {
    await page.locator(`#${SPA_FORMLESS_MEMBER_BOX}[data-state="ready"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
  };
  const fillValues = async (page: Page): Promise<void> => {
    await page.fill(SPA_MEMBER_FIELDS.name, VALUES.name);
    await page.fill(SPA_MEMBER_FIELDS.email, VALUES.email);
    await page.fill(SPA_MEMBER_FIELDS.note, VALUES.note);
  };
  const memberState = (page: Page): Promise<string | null> =>
    page.locator(`#${SPA_STATE_ELEMENTS.member}`).getAttribute('data-state').catch(() => null);
  /** 保存を押し、ページの保存の結果（`saved` か `error`）が出るまで待つ（Guard の判定が揃った印）。 */
  const pressSave = async (page: Page): Promise<void> => {
    await page.click(SPA_MEMBER_FIELDS.submit);
    await untilSettled(async () => SAVE_SETTLED_STATES.includes(await memberState(page)));
  };
  /** 窓を開いて値を入れ、保存を押し、保存の結果を待つ。 */
  const saveInWindow = async (page: Page, monitor: WriteStageMonitor): Promise<void> => {
    await waitReady(page);
    await monitor.openSubmissionWindow(page);
    await fillValues(page);
    // T40R-fix-A: 値を入れる間は窓の観察の段。押す直前に送信の段を開く（書き込みの入力の部品と同じ順）。
    monitor.openSubmissionPhase();
    await pressSave(page);
  };
  const blockedSum = (monitor: WriteStageMonitor): number => Object.values(monitor.snapshot().blockedByPayloadReason).reduce((sum, count) => sum + count, 0);
  const blockedLines = (ledger: SafetyLedger): readonly string[] =>
    ledger.snapshot().blockedRequests.map(({ method, url, reason }) => `${method} ${new URL(url).pathname} ${reason}`);

  /** ページの main world のスクリプトとして、承認した型の要求を送る式（本文・ヘッダ・URL を差し替えられる）。 */
  const sendSource = (site: SpaAuthSite, options: {
    readonly method?: string;
    readonly url?: string;
    readonly body?: Record<string, unknown>;
    readonly extraHeaders?: Record<string, string>;
  } = {}): string => {
    const url = options.url ?? `${site.backendOrigin}${SPA_BACKEND_PATHS.members}`;
    const body = JSON.stringify(options.body ?? VALUES);
    return `(() => {
      const session = JSON.parse(localStorage.getItem(${JSON.stringify(SPA_AUTH_STORAGE_KEY)}));
      const headers = Object.assign({ ${JSON.stringify(SPA_API_KEY_HEADER)}: ${JSON.stringify(site.apiKeyMarker())}, authorization: 'Bearer ' + session.access_token,
        'content-type': 'application/json', ${JSON.stringify(SPA_PREFER_HEADER.name)}: ${JSON.stringify(SPA_PREFER_HEADER.value)} }, ${JSON.stringify(options.extraHeaders ?? {})});
      return { url: ${JSON.stringify(url)}, init: { method: ${JSON.stringify(options.method ?? 'POST')}, headers, body: ${JSON.stringify(body)} } };
    })()`;
  };
  /** 窓の中で、page の main world から要求を送る（送れたかは問わない）。 */
  const sendFromPage = async (page: Page, source: string): Promise<void> => {
    await page.evaluate(`(() => { const r = ${source}; return fetch(r.url, r.init).then(() => 'sent', () => 'failed'); })()`).catch(() => undefined);
  };

  it('renders the SPA screen before the press (the service origin read passes within the limits in the write stage)', async () => {
    const site = await startSite();
    const id = site.addMember(EXISTING_NAME);
    const { page, spy, reached } = await openStage(site, 'UPDATE', spaMemberEditPathOf(id), String(id));
    await page.locator(`#${SPA_FORMLESS_MEMBER_BOX}`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    await expect.poll(() => boxState(page), { timeout: UI_TIMEOUT_MS }).not.toBe('loading');
    expect(await boxState(page)).toBe('ready');
    expect(await page.inputValue(SPA_MEMBER_FIELDS.name)).toBe(EXISTING_NAME);
    expectReached(site, reached);
    expect(spy.calls).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it.each<[Kind]>([['CREATE'], ['UPDATE']])('hands the first matching %s request in the window to the sender and returns its response to the page', async (kind) => {
    const site = await startSite();
    const id = kind === 'UPDATE' ? site.addMember(EXISTING_NAME) : null;
    const path = id === null ? SPA_APP_PATHS.memberNew : spaMemberEditPathOf(id);
    const { page, monitor, spy, reached } = await openStage(site, kind, path, id === null ? null : String(id));
    await saveInWindow(page, monitor);
    expect(spy.calls).toEqual([{ method: kind === 'CREATE' ? 'POST' : 'PATCH', path: SPA_BACKEND_PATHS.members, bodyBytes: expect.any(Number) as number, pageKeys: [] }]);
    expect(await memberState(page)).toBe('saved');
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', sendAttempts: 1, sendOutcome: 'RESPONDED', responseReceived: true, responseStatus: 201 });
    expect(monitor.isSubmissionWindowOpen()).toBe(false);
    // 送り手の口の偽物は送らないので、サービスの Origin には何も届かない（T39c の前）。
    expectReached(site, reached);
    expect(blockedSum(monitor)).toBe(0);
  }, TEST_TIMEOUT_MS);

  /**
   * 押下で敵対的な送り方をする場面（fixture の `hostileMemberSave`）。`handed` は口に渡る回数（`doubleSend` の 1 回目だけ）。SLIM: 12 通りの代表（2 回目・DELETE・
   * 手続きの呼び出し・承認していない Origin）。upsert・array・鍵の追加・method の上書き・filter のない PATCH・符号化した手続きの path は単体
   * `api-write-payload-policy`（「the upsert query on_conflict」「an array at the top」「a key added」「a method override header」「the _method key in the body」
   * 「an UPDATE without the filter」と手続きの path の一覧）に任せる。
   */
  const HOSTILE_SAVES: readonly (readonly [SpaHostileMemberSave, number])[] = [
    ['doubleSend', 1],
    ['unapprovedOrigin', 0],
    ['deleteOnSave', 0],
    ['rpcCall', 0],
  ];
  it.each(HOSTILE_SAVES)('blocks the hostile save %s and nothing reaches the services', async (save, handed) => {
    const site = await startSite();
    site.setHostileMemberSave(save);
    const { page, monitor, spy, ledger, reached } = await openStage(site, 'CREATE', SPA_APP_PATHS.memberNew);
    await saveInWindow(page, monitor);
    const payload = Object.entries(monitor.snapshot().blockedByPayloadReason).filter(([, count]) => count > 0);
    console.info(`T39b ${_label} hostile save ${save}: ${JSON.stringify({ handed: spy.calls.length, payload, blocked: blockedLines(ledger) })}`);
    expect(spy.calls).toHaveLength(handed);
    expectReached(site, reached);
    // 止める経路が働いた証拠: 照合で止めた数か、Guard が止めた要求の記録。
    expect(blockedSum(monitor) + ledger.snapshot().blockedRequests.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  /**
   * page の main world のスクリプトとして、窓の中で送る敵対的な要求。SLIM: 5 通りの代表。鍵の削除と承認していない select の query は単体
   * `api-write-payload-policy`（「a key field removed」「the upsert query on_conflict」ほかの QUERY_MISMATCH）に任せる。
   */
  const PAGE_SENDS: readonly (readonly [string, (site: SpaAuthSite) => string])[] = [
    ['a value rewritten', (site) => sendSource(site, { body: { ...VALUES, name: '書き換え' } })],
    ['a key added', (site) => sendSource(site, { body: { ...VALUES, role: 'admin' } })],
    ['a header that is not approved', (site) => sendSource(site, { extraHeaders: { 'x-extra': '1' } })],
  ];
  it.each(PAGE_SENDS)('blocks %s sent by the page script in the window, and nothing reaches the services', async (_name, source) => {
    const site = await startSite();
    const { page, monitor, spy, reached } = await openStage(site, 'CREATE', SPA_APP_PATHS.memberNew);
    await waitReady(page);
    await monitor.openSubmissionWindow(page);
    // T40R-fix-A: 照合を確かめるため、送信の段を開いてからページが送る（観察の段では照合にかけずに止める）。
    monitor.openSubmissionPhase();
    await sendFromPage(page, source(site));
    // 1 回目が止まった後は、ふつうの保存も通らない（1 回だけ）。
    await fillValues(page);
    await pressSave(page);
    expect(spy.calls).toEqual([]);
    expectReached(site, reached);
    expect(blockedSum(monitor)).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  /** T39R-fix（M-2）: 窓の中の、承認の endpoint の path でない読み取りでない要求（照合にかけず、書き込みの機会を使わない）。 */
  const OFF_ENDPOINT_SENDS: readonly (readonly [string, (site: SpaAuthSite) => string])[] = [
    ['another path', (site) => sendSource(site, { url: `${site.backendOrigin}/rest/v1/admins` })],
    ['a procedure call', (site) => sendSource(site, { url: `${site.backendOrigin}/rest/v1/rpc/search`, body: {} })],
  ];
  it.each(OFF_ENDPOINT_SENDS)('blocks %s sent in the window without the check, and still hands the approved save once', async (_name, source) => {
    const site = await startSite();
    const { page, monitor, spy, ledger, reached } = await openStage(site, 'CREATE', SPA_APP_PATHS.memberNew);
    await waitReady(page);
    await monitor.openSubmissionWindow(page);
    // T40R-fix-A: 送信の段の中でも、承認の endpoint でない要求は照合にかけずに止まる（送信の段を開いてからページが送る）。
    monitor.openSubmissionPhase();
    await sendFromPage(page, source(site));
    await fillValues(page);
    await pressSave(page);
    expect(spy.calls).toEqual([{ method: 'POST', path: SPA_BACKEND_PATHS.members, bodyBytes: expect.any(Number) as number, pageKeys: [] }]);
    expectReached(site, reached);
    expect(blockedSum(monitor)).toBe(0);
    expect(blockedLines(ledger).some((line) => line.startsWith('POST ') && line.endsWith(' NON_READ_METHOD'))).toBe(true);
    expect(await memberState(page)).toBe('saved');
  }, TEST_TIMEOUT_MS);

  it('blocks the filter value rewritten on an UPDATE, and nothing reaches the services', async () => {
    const site = await startSite();
    const id = site.addMember(EXISTING_NAME);
    const other = site.addMember('別の会員');
    const { page, monitor, spy, reached } = await openStage(site, 'UPDATE', spaMemberEditPathOf(id), String(id));
    await waitReady(page);
    await monitor.openSubmissionWindow(page);
    // T40R-fix-A: 照合を確かめるため、送信の段を開いてからページが送る（`sendFromPage` は要求の結果まで待つ）。
    monitor.openSubmissionPhase();
    await sendFromPage(page, sendSource(site, { method: 'PATCH', url: `${site.backendOrigin}${SPA_BACKEND_PATHS.members}?id=eq.${String(other)}` }));
    expect(spy.calls).toEqual([]);
    expectReached(site, reached);
    expect(monitor.snapshot().blockedByPayloadReason.FILTER_MISMATCH).toBe(1);
  }, TEST_TIMEOUT_MS);

  // LU-5（設計書 5.3 の 1・3、fix round 1 の案 A）: path の形の更新。照合へ回すのは `{id}` を台帳の番号にした具体的な path だけ。窓の前（N2）の
  // 「承認した送信先とその下」の守りは、型の path（`{id}` はどの 1 区切りにも当たる）のまま。
  it('hands only the PATCH to the concrete path of the record id, and another id and the DELETE do not reach the services (LU-5)', async () => {
    const site = await startSite();
    const { page, monitor, spy, ledger, reached } = await openStage(site, 'UPDATE', spaMemberEditPathOf(site.addMember(EXISTING_NAME)), PATH_SHAPE_RECORD_ID, pathShapeExpectationOf(site));
    await waitReady(page);
    await monitor.openSubmissionWindow(page);
    monitor.openSubmissionPhase();
    const itemUrl = (id: string): string => `${site.backendOrigin}${PATH_SHAPE_ITEMS}/${id}`;
    await sendFromPage(page, sendSource(site, { method: 'PATCH', url: itemUrl(PATH_SHAPE_OTHER_ID) }));
    await sendFromPage(page, sendSource(site, { method: 'DELETE', url: itemUrl(PATH_SHAPE_RECORD_ID) }));
    await sendFromPage(page, sendSource(site, { method: 'PATCH', url: itemUrl(PATH_SHAPE_RECORD_ID) }));
    console.info(`LU-5 ${_label} path shape: ${JSON.stringify({ handed: spy.calls, blocked: blockedLines(ledger), report: monitor.submissionReport() })}`);
    expect(spy.calls).toEqual([{ method: 'PATCH', path: `${PATH_SHAPE_ITEMS}/${PATH_SHAPE_RECORD_ID}`, bodyBytes: expect.any(Number) as number, pageKeys: [] }]);
    expectReached(site, reached);
    expect(blockedSum(monitor)).toBe(0);
    expect(blockedLines(ledger)).toEqual(expect.arrayContaining([
      `PATCH ${PATH_SHAPE_ITEMS}/${PATH_SHAPE_OTHER_ID} NON_READ_METHOD`,
      `DELETE ${PATH_SHAPE_ITEMS}/${PATH_SHAPE_RECORD_ID} NON_READ_METHOD`,
    ]));
  }, TEST_TIMEOUT_MS);

  it('does not let the PATCH to another id under the approved path shape reach the services before the window (N2, LU-5)', async () => {
    const site = await startSite();
    const { page, monitor, spy, reached } = await openStage(site, 'UPDATE', spaMemberEditPathOf(site.addMember(EXISTING_NAME)), PATH_SHAPE_RECORD_ID, pathShapeExpectationOf(site), true);
    await waitReady(page);
    // 窓の前（値を入れる前）。承認した送信先の下でない要求は通る（N2 の口が開いていることの確かめ）。
    await sendFromPage(page, sendSource(site, { method: 'PATCH', url: `${site.backendOrigin}${PATH_SHAPE_UNRELATED}` }));
    for (const id of [PATH_SHAPE_OTHER_ID, PATH_SHAPE_RECORD_ID]) {
      await sendFromPage(page, sendSource(site, { method: 'PATCH', url: `${site.backendOrigin}${PATH_SHAPE_ITEMS}/${id}` }));
    }
    console.info(`LU-5 ${_label} N2: ${JSON.stringify({ reached: reached() })}`);
    expectReached(site, reached, [`backend PATCH ${PATH_SHAPE_UNRELATED}`]);
    expect(spy.calls).toEqual([]);
    expect(monitor.isSubmissionWindowOpen()).toBe(false);
  }, TEST_TIMEOUT_MS);

  // LU-SFIX1（設計書 5.3 の 3。LU-SREV1 の Important-1・W4）: path の形の期待では、窓の前（N2）に、`{id}` の 1 つ上の path（表の一覧の path）への書き込みも
  // 届かない（filter の形の期待と同じ強さ）。別の表は今のとおり届く（N2 の口が開いていることの確かめ）。
  it('does not let the writes to the list path one above the record id reach the services before the window (N2, LU-SFIX1)', async () => {
    const site = await startSite();
    const { page, monitor, spy, reached } = await openStage(site, 'UPDATE', spaMemberEditPathOf(site.addMember(EXISTING_NAME)), PATH_SHAPE_RECORD_ID, pathShapeExpectationOf(site), true);
    await waitReady(page);
    const tries: readonly (readonly [string, string])[] = [
      ['POST', PATH_SHAPE_ITEMS],
      ['PATCH', PATH_SHAPE_ITEMS],
      ['PATCH', `${PATH_SHAPE_ITEMS}?id=eq.${PATH_SHAPE_OTHER_ID}`],
      ['PATCH', `${PATH_SHAPE_ITEMS}X/${PATH_SHAPE_OTHER_ID}`],
      ['POST', PATH_SHAPE_UNRELATED],
    ];
    for (const [method, path] of tries) {
      await sendFromPage(page, sendSource(site, { method, url: `${site.backendOrigin}${path}` }));
    }
    console.info(`LU-SFIX1 ${_label} N2 list path: ${JSON.stringify({ reached: reached() })}`);
    expectReached(site, reached, [`backend POST ${PATH_SHAPE_UNRELATED}`]);
    expect(spy.calls).toEqual([]);
    expect(monitor.isSubmissionWindowOpen()).toBe(false);
  }, TEST_TIMEOUT_MS);

  /** LU-SFIX1（Important-2）: 窓の中で送る、具体的な path（`/api/items/4`）でない path（レビューの W1 の 15 種類）。 */
  const PATH_SHAPE_BAD_PATHS: readonly string[] = [
    `${PATH_SHAPE_ITEMS}/${PATH_SHAPE_OTHER_ID}`, `${PATH_SHAPE_ITEMS}/%34`, `/API/items/${PATH_SHAPE_RECORD_ID}`, `/api/ITEMS/${PATH_SHAPE_RECORD_ID}`,
    `${PATH_SHAPE_ITEMS}/${PATH_SHAPE_RECORD_ID}/`, `/${PATH_SHAPE_ITEMS}/${PATH_SHAPE_RECORD_ID}`, `${PATH_SHAPE_ITEMS}/${PATH_SHAPE_RECORD_ID}/..`,
    `${PATH_SHAPE_ITEMS}/${PATH_SHAPE_RECORD_ID}/sub`, `${PATH_SHAPE_ITEMS}/0${PATH_SHAPE_RECORD_ID}`, `${PATH_SHAPE_ITEMS}/${PATH_SHAPE_RECORD_ID};x`,
    `${PATH_SHAPE_ITEMS}/${PATH_SHAPE_RECORD_ID}%2f`, `/api/item/${PATH_SHAPE_RECORD_ID}`, PATH_SHAPE_ITEMS, `${PATH_SHAPE_ITEMS}/${PATH_SHAPE_RECORD_ID}%20`,
    `${PATH_SHAPE_ITEMS}/+${PATH_SHAPE_RECORD_ID}`,
  ];
  const PATH_SHAPE_CONCRETE = `${PATH_SHAPE_ITEMS}/${PATH_SHAPE_RECORD_ID}`;

  // LU-SFIX1（LU-SREV1 の Important-2・W1）: 本物の送り手と中継を通る path の形の更新。窓の中で、悪い path・DELETE・PUT・正しい PATCH を同時に 2 つ・その後の
  // 1 つを送っても、サーバに届くのは具体的な path への PATCH の 1 件だけ。
  it('sends only one PATCH to the concrete path with the real sender, and the wrong paths, the DELETE, the PUT and the second PATCH do not reach the services (LU-SFIX1)', async () => {
    const site = await startSite();
    const { page, monitor, ledger, reached } = await openStage(
      site, 'UPDATE', spaMemberEditPathOf(site.addMember(EXISTING_NAME)), PATH_SHAPE_RECORD_ID, pathShapeExpectationOf(site), false, true,
    );
    await waitReady(page);
    await monitor.openSubmissionWindow(page);
    monitor.openSubmissionPhase();
    for (const path of PATH_SHAPE_BAD_PATHS) {
      await sendFromPage(page, sendSource(site, { method: 'PATCH', url: `${site.backendOrigin}${path}` }));
    }
    await sendFromPage(page, sendSource(site, { method: 'DELETE', url: `${site.backendOrigin}${PATH_SHAPE_CONCRETE}` }));
    await sendFromPage(page, sendSource(site, { method: 'PUT', url: `${site.backendOrigin}${PATH_SHAPE_CONCRETE}` }));
    const correct = sendSource(site, { method: 'PATCH', url: `${site.backendOrigin}${PATH_SHAPE_CONCRETE}` });
    await Promise.all([sendFromPage(page, correct), sendFromPage(page, correct)]);
    await sendFromPage(page, correct);
    await untilSettled(() => monitor.submissionReport().sendOutcome !== null);
    console.info(`LU-SFIX1 ${_label} real sender: ${JSON.stringify({ reached: reached(), blocked: blockedLines(ledger), report: monitor.submissionReport() })}`);
    expectReached(site, reached, [`backend PATCH ${PATH_SHAPE_CONCRETE}`]);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', sendAttempts: 1 });
    expect(blockedSum(monitor)).toBe(0);
  }, TEST_TIMEOUT_MS);

  // LU-SFIX1（LU-SREV1 の Minor-5）: 中継の送信先と予算の path は、Guard と同じ 1 つの写しから作る（呼び手の生の期待を読み直さない）。台帳の番号を読むたびに
  // 違う値を返す期待でも、番号は 1 回だけ読まれ、中継と Guard の具体的な path が揃うので、その path への 1 件だけが届く。
  it('builds the relay path from the same copy as the Guard, so the caller expectation is read once and the one PATCH reaches the services (LU-SFIX1)', async () => {
    const site = await startSite();
    let reads = 0;
    const base = pathShapeExpectationOf(site);
    const flipping: ApiWritePayloadExpectation = {
      spec: base.spec,
      values: base.values,
      get recordId(): string {
        reads += 1;
        return reads === 1 ? PATH_SHAPE_RECORD_ID : PATH_SHAPE_OTHER_ID;
      },
    };
    const { page, monitor, reached } = await openStage(site, 'UPDATE', spaMemberEditPathOf(site.addMember(EXISTING_NAME)), PATH_SHAPE_RECORD_ID, flipping, false, true);
    expect(reads).toBe(1);
    await waitReady(page);
    await monitor.openSubmissionWindow(page);
    monitor.openSubmissionPhase();
    await sendFromPage(page, sendSource(site, { method: 'PATCH', url: `${site.backendOrigin}${PATH_SHAPE_CONCRETE}` }));
    await untilSettled(() => monitor.submissionReport().sendOutcome !== null);
    expectReached(site, reached, [`backend PATCH ${PATH_SHAPE_CONCRETE}`]);
    expect(reads).toBe(1);
  }, TEST_TIMEOUT_MS);

  /** LU-SFIX1（Important-2）: 中継に直に、絶対形の HTTP の要求を送り、status を返す（届かなければ 0）。 */
  const sendToRelay = (context: BrowserContext, site: SpaAuthSite, method: string, path: string): Promise<number> => {
    const proxy = new URL(proxyServers.get(context) ?? 'http://127.0.0.1:9');
    return new Promise<number>((resolvePromise) => {
      const request = httpRequest({
        host: proxy.hostname, port: Number(proxy.port), method, path: `${site.backendOrigin}${path}`,
        headers: { host: new URL(site.backendOrigin).host, 'content-type': 'application/json', connection: 'close' },
      }, (response) => {
        response.resume();
        response.on('end', () => resolvePromise(response.statusCode ?? 0));
      });
      request.on('error', () => resolvePromise(0));
      request.end(JSON.stringify(VALUES));
    });
  };

  // LU-SFIX1（LU-SREV1 の Important-2。レビューの relay.exp.ts）: 中継（`apiWriteEndpointOf`）の通す口と予算は、具体的な path の 1 件だけ。中継へ直に送った
  // 別の番号・符号化した番号・`{id}` のまま・表の一覧の path・送り手の 1 回の後の 2 回目は、どれも 403 で、サーバに届かない。
  it('lets the relay pass only one write to the concrete path, and rejects the other paths and the second one sent straight to it (LU-SFIX1)', async () => {
    const site = await startSite();
    const { page, monitor, ledger, context, reached } = await openStage(
      site, 'UPDATE', spaMemberEditPathOf(site.addMember(EXISTING_NAME)), PATH_SHAPE_RECORD_ID, pathShapeExpectationOf(site), false, true,
    );
    await waitReady(page);
    const before: string[] = [];
    for (const path of [`${PATH_SHAPE_ITEMS}/${PATH_SHAPE_OTHER_ID}`, `${PATH_SHAPE_ITEMS}/%34`, PATH_SHAPE_TEMPLATE, `${PATH_SHAPE_ITEMS}/%7Bid%7D`, PATH_SHAPE_ITEMS]) {
      before.push(`${path} ${String(await sendToRelay(context, site, 'PATCH', path))}`);
    }
    await monitor.openSubmissionWindow(page);
    monitor.openSubmissionPhase();
    await sendFromPage(page, sendSource(site, { method: 'PATCH', url: `${site.backendOrigin}${PATH_SHAPE_CONCRETE}` }));
    await untilSettled(() => monitor.submissionReport().sendOutcome !== null);
    const after = await sendToRelay(context, site, 'PATCH', PATH_SHAPE_CONCRETE);
    console.info(`LU-SFIX1 ${_label} relay: ${JSON.stringify({ before, after, reached: reached() })}`);
    expect(before.map((line) => line.split(' ').at(-1))).toEqual(['403', '403', '403', '403', '403']);
    expect(after).toBe(403);
    expectReached(site, reached, [`backend PATCH ${PATH_SHAPE_CONCRETE}`]);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', sendAttempts: 1 });
    expect(ledger.snapshot().blockedInteractionRequests.map(({ method, url, reason }) => `${method} ${new URL(url).pathname} ${reason}`))
      .toContain(`PATCH ${PATH_SHAPE_CONCRETE} GUARD_BYPASS_EGRESS`);
  }, TEST_TIMEOUT_MS);

  // LU-SFIX2-B（LU-SREV2 の Minor-2）: 中継の 2 段目の守り。中継が通す承認の送信先への書き込みは、Guard が通した要求の写しに当たるものだけ。Guard を通らずに
  // 中継へ直に送った正しい形の PATCH（具体的な path）は、窓を開く前も、開いた後（Guard が通す前）も 403 で、サーバに届かない。Guard が通した PATCH は今の
  // とおり 1 件だけ届く。
  it('rejects the correct PATCH sent straight to the relay before and after the window opens, and lets only the one that the Guard passed through (LU-SFIX2-B)', async () => {
    const site = await startSite();
    const { page, monitor, ledger, context, reached } = await openStage(
      site, 'UPDATE', spaMemberEditPathOf(site.addMember(EXISTING_NAME)), PATH_SHAPE_RECORD_ID, pathShapeExpectationOf(site), false, true,
    );
    await waitReady(page);
    const beforeWindow = await sendToRelay(context, site, 'PATCH', PATH_SHAPE_CONCRETE);
    await monitor.openSubmissionWindow(page);
    const inWindow = await sendToRelay(context, site, 'PATCH', PATH_SHAPE_CONCRETE);
    monitor.openSubmissionPhase();
    const inPhase = await sendToRelay(context, site, 'PATCH', PATH_SHAPE_CONCRETE);
    const reachedBeforeGuard = reached();
    await sendFromPage(page, sendSource(site, { method: 'PATCH', url: `${site.backendOrigin}${PATH_SHAPE_CONCRETE}` }));
    await untilSettled(() => monitor.submissionReport().sendOutcome !== null);
    const after = await sendToRelay(context, site, 'PATCH', PATH_SHAPE_CONCRETE);
    console.info(`LU-SFIX2-B ${_label} relay: ${JSON.stringify({ beforeWindow, inWindow, inPhase, after, reachedBeforeGuard, reached: reached() })}`);
    expect([beforeWindow, inWindow, inPhase, after]).toEqual([403, 403, 403, 403]);
    expect(reachedBeforeGuard).toEqual([]);
    expectReached(site, reached, [`backend PATCH ${PATH_SHAPE_CONCRETE}`]);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', sendAttempts: 1, sendOutcome: 'RESPONDED' });
    expect(ledger.snapshot().blockedInteractionRequests.filter(({ method, url, reason }) => method === 'PATCH'
      && new URL(url).pathname === PATH_SHAPE_CONCRETE && reason === 'GUARD_BYPASS_EGRESS')).toHaveLength(4);
  }, TEST_TIMEOUT_MS);

  /** T41c: 保つ鍵を前の値のまま、変える鍵（名前）だけに新しい値を入れて保存する。`rewriteKept` なら、ページのスクリプトが押す前にメールの値を書き換える。 */
  const saveUpdateKeepingValues = async (page: Page, monitor: WriteStageMonitor, rewriteKept: boolean, ledger?: SafetyLedger): Promise<void> => {
    await waitReady(page);
    await monitor.openSubmissionWindow(page);
    await page.fill(SPA_MEMBER_FIELDS.name, VALUES.name);
    if (rewriteKept) {
      await page.evaluate((selector) => {
        const input = document.querySelector(selector);
        if (input instanceof HTMLInputElement) input.value = 'rewritten-by-page@example.invalid';
      }, SPA_MEMBER_FIELDS.email);
    }
    // T40R-fix-A: 押す直前に送信の段を開く（書き込みの入力の部品と同じ順）。
    monitor.openSubmissionPhase();
    await pressSave(page);
    const payload = Object.entries(monitor.snapshot().blockedByPayloadReason).filter(([, count]) => count > 0);
    console.info(`T41c ${_label} update rewriteKept=${String(rewriteKept)}: ${JSON.stringify({ payload, member: await memberState(page), report: monitor.submissionReport(), blocked: ledger === undefined ? [] : blockedLines(ledger) })}`);
  };

  // LU-9（SLIM で、もとの「印のない期待の口は拒み、今の UPDATE を保つ」をまとめた）: 印のない期待に前の値を入れる口は拒み、今の UPDATE は変わらない。
  it('hands the UPDATE that changes only the changed key and sends the kept keys at their prior values, and rejects prior values on an expectation without the mark (T41c, LU-9)', async () => {
    const site = await startSite();
    const id = site.addMember(EXISTING_NAME);
    const { page, monitor, spy, ledger, reached } = await openStage(site, 'UPDATE', spaMemberEditPathOf(id), String(id), updateKeptExpectationOf(site, id));
    expect(monitor.supplyApiPriorValues({ keptKeys: [{ key: 'email', value: 'other@example.invalid' }, { key: 'note', value: '' }], pageKeyPriorValues: [] })).toBe(false);
    await saveUpdateKeepingValues(page, monitor, false, ledger);
    expect(spy.calls).toEqual([{ method: 'PATCH', path: SPA_BACKEND_PATHS.members, bodyBytes: expect.any(Number) as number, pageKeys: [] }]);
    expect(blockedSum(monitor)).toBe(0);
    expectReached(site, reached);
  }, TEST_TIMEOUT_MS);

  it('blocks the UPDATE whose kept key value the page rewrote, and nothing reaches the services (T41c)', async () => {
    const site = await startSite();
    const id = site.addMember(EXISTING_NAME);
    const { page, monitor, spy, ledger, reached } = await openStage(site, 'UPDATE', spaMemberEditPathOf(id), String(id), updateKeptExpectationOf(site, id));
    await saveUpdateKeepingValues(page, monitor, true, ledger);
    expect(spy.calls).toEqual([]);
    expectReached(site, reached);
    expect(monitor.snapshot().blockedByPayloadReason.BODY_VALUE_MISMATCH).toBe(1);
    expect(site.memberOf(id)?.email).not.toBe('rewritten-by-page@example.invalid');
  }, TEST_TIMEOUT_MS);

  // LU-9（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0.1 の K1、5.3 の 2）: 前の値を後から入れる印のある期待。前の値は、窓を一度も開いていない
  // 間に 1 回だけ、Guard の口（`supplyApiPriorValues`）で入れる。入れていなければ、窓の中の正しい PATCH も照合で止まる（fail-closed）。
  /** LU-9: 保つ鍵（メールと備考）の前の値を後から入れる印のある更新の期待（前の値を持たない）。 */
  const deferredUpdateExpectationOf = (site: SpaAuthSite, id: number): ApiWritePayloadExpectation => {
    const { keptKeys: _kept, pageKeyPriorValues: _page, ...base } = updateKeptExpectationOf(site, id);
    return { ...base, deferredPriorValues: { keptKeys: ['email', 'note'] } };
  };
  /** LU-9: 後から入れる前の値（書き換えられる一覧。写しを確かめる）。 */
  const suppliedPriorValuesOf = (site: SpaAuthSite, id: number): { keptKeys: { key: string; value: string }[]; pageKeyPriorValues: [] } => {
    const member = site.memberOf(id);
    return { keptKeys: [{ key: 'email', value: member?.email ?? '' }, { key: 'note', value: member?.note ?? '' }], pageKeyPriorValues: [] };
  };

  // SLIM: LU-9 の前の値の 5 場面を 2 つに。入れていない（窓を開いた後に入れようとした）PATCH が止まる場面と、窓の前に入れた PATCH が 1 回だけ渡る場面。
  // `map` を差し替えた一覧の写しは単体 `api-write-payload-policy-update`（「does not call the map of the supplied list」「copies by index without calling map」）。
  it('rejects the prior values supplied after the window opened, and the PATCH without the prior values does not reach the services (LU-9)', async () => {
    const site = await startSite();
    const id = site.addMember(EXISTING_NAME);
    const { page, monitor, spy, reached } = await openStage(site, 'UPDATE', spaMemberEditPathOf(id), String(id), deferredUpdateExpectationOf(site, id));
    await waitReady(page);
    await monitor.openSubmissionWindow(page);
    expect(monitor.supplyApiPriorValues(suppliedPriorValuesOf(site, id))).toBe(false);
    await page.fill(SPA_MEMBER_FIELDS.name, VALUES.name);
    monitor.openSubmissionPhase();
    expect(monitor.supplyApiPriorValues(suppliedPriorValuesOf(site, id))).toBe(false);
    await pressSave(page);
    expect(spy.calls).toEqual([]);
    expectReached(site, reached);
    expect(monitor.snapshot().blockedByPayloadReason.EXPECTATION_INVALID).toBe(1);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'NOT_SENT', sendAttempts: 0 });
    expect(site.memberOf(id)?.name).toBe(EXISTING_NAME);
  }, TEST_TIMEOUT_MS);

  it('hands the PATCH once after the prior values are supplied before the window, and rejects a wrong key set, a second supply and a monitor without a Guard (LU-9)', async () => {
    expect(new WriteStageMonitor().supplyApiPriorValues({ keptKeys: [], pageKeyPriorValues: [] })).toBe(false);
    const site = await startSite();
    const id = site.addMember(EXISTING_NAME);
    const { page, monitor, spy, ledger, reached } = await openStage(site, 'UPDATE', spaMemberEditPathOf(id), String(id), deferredUpdateExpectationOf(site, id));
    const prior = suppliedPriorValuesOf(site, id);
    // 鍵の集合が違えば拒み、Guard の状態を変えない（続く正しい 1 回を受ける）。
    expect(monitor.supplyApiPriorValues({ keptKeys: prior.keptKeys.slice(0, 1), pageKeyPriorValues: [] })).toBe(false);
    expect(monitor.supplyApiPriorValues({ keptKeys: [...prior.keptKeys, { key: 'role', value: 'x' }], pageKeyPriorValues: [] })).toBe(false);
    // LU-12a: フォームの口は、API の段では拒む（共通の部品の、送り方の確かめ）。
    expect(monitor.supplyFormPriorValues({ keptFields: [{ name: 'email', value: 'x' }], checkedPassthroughFields: [], checkboxPairs: [] })).toBe(false);
    expect(monitor.supplyApiPriorValues(prior)).toBe(true);
    // 2 回目は、同じ値でも拒む。
    expect(monitor.supplyApiPriorValues(prior)).toBe(false);
    // 入れた値は写して持つ（呼び手が後で元の object を変えても照合は変わらない）。
    const [first] = prior.keptKeys;
    if (first !== undefined) first.value = 'mutated-after-supply@example.invalid';
    await saveUpdateKeepingValues(page, monitor, false, ledger);
    expect(spy.calls).toEqual([{ method: 'PATCH', path: SPA_BACKEND_PATHS.members, bodyBytes: expect.any(Number) as number, pageKeys: [] }]);
    expect(blockedSum(monitor)).toBe(0);
    expectReached(site, reached);
  }, TEST_TIMEOUT_MS);

  it('blocks the matching request sent outside the window, and nothing reaches the services', async () => {
    const site = await startSite();
    const { page, monitor, spy, ledger, reached } = await openStage(site, 'CREATE', SPA_APP_PATHS.memberNew);
    await waitReady(page);
    await sendFromPage(page, sendSource(site));
    expect(spy.calls).toEqual([]);
    expectReached(site, reached);
    expect(blockedLines(ledger)).toContain(`POST ${SPA_BACKEND_PATHS.members} NON_READ_METHOD`);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'NOT_SENT', sendAttempts: 0 });
  }, TEST_TIMEOUT_MS);

  // T40R-fix-A（Task 40 の設計書 7 章の T40R の I-1）: 窓の観察の段（窓を開いた後、送信の段を開く前）では、承認どおりの要求も照合にかけずに止めて数える
  // （送り手の口に渡さない）。送信の段は Node の側の部品の口（`openSubmissionPhase`）でだけ開き、窓を開く前は開けない。ページの要求は段を変えない。
  it('blocks the matching request in the observation phase of the window without the check, and counts it as unexpected', async () => {
    const site = await startSite();
    const { page, monitor, spy, ledger, reached } = await openStage(site, 'CREATE', SPA_APP_PATHS.memberNew);
    await waitReady(page);
    expect(monitor.openSubmissionPhase()).toBe(false);
    await monitor.openSubmissionWindow(page);
    await sendFromPage(page, sendSource(site));
    expect(spy.calls).toEqual([]);
    expectReached(site, reached);
    expect(monitor.unexpectedRequestCount()).toBeGreaterThan(0);
    expect(blockedSum(monitor)).toBe(0);
    expect(monitor.isSubmissionPhaseOpen()).toBe(false);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'NOT_SENT', sendAttempts: 0 });
    expect(blockedLines(ledger)).toContain(`POST ${SPA_BACKEND_PATHS.members} NON_READ_METHOD`);
  }, TEST_TIMEOUT_MS);

  it('blocks the value rewritten by the page script just before the send (rewriteOnInput), and nothing reaches the services', async () => {
    // この場面だけ自分のサイト（起動の指定が要る）。閉じた後に静まるのを待ってから数え直す。
    const site = await startSite({ hostileMemberInput: 'rewriteOnInput' });
    const { page, monitor, spy, reached } = await openStage(site, 'CREATE', SPA_APP_PATHS.memberNew);
    await saveInWindow(page, monitor);
    expect(spy.calls).toEqual([]);
    expect(reached()).toEqual([]);
    expect(monitor.snapshot().blockedByPayloadReason.BODY_VALUE_MISMATCH).toBe(1);
    await closeFactories();
    await settleLateDeliveries(LATE_DELIVERY_SETTLE_MS, site);
    expect(reached()).toEqual([]);
  }, TEST_TIMEOUT_MS);

  /** Worker・iframe・beacon から、承認した型の要求をそのまま送る式（main frame のページのスクリプトでない）。 */
  const OTHER_SENDERS: readonly (readonly [string, (request: string) => string])[] = [
    ['a dedicated Worker', (request) => `(() => { const r = ${request};
      const source = 'fetch(' + JSON.stringify(r.url) + ', ' + JSON.stringify(r.init) + ').then(() => postMessage(1), () => postMessage(0));';
      const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      return new Promise((resolve) => { worker.onmessage = () => resolve('done'); setTimeout(() => resolve('timeout'), 3000); }); })()`],
    ['a same-origin iframe', (request) => `(() => { const r = ${request}; const frame = document.createElement('iframe'); document.body.append(frame);
      return frame.contentWindow.fetch(r.url, r.init).then(() => 'sent', () => 'failed'); })()`],
    ['a srcdoc iframe', (request) => `(() => { const r = ${request}; const frame = document.createElement('iframe');
      frame.srcdoc = '<script>fetch(' + JSON.stringify(r.url) + ', ' + JSON.stringify(r.init) + ');<' + '/script>'; document.body.append(frame); return 'appended'; })()`],
    ['a beacon', (request) => `(() => { const r = ${request}; return navigator.sendBeacon(r.url, new Blob([r.init.body], { type: 'text/plain' })); })()`],
  ];
  /**
   * T39R-fix（M-3）: 同じ Origin の子の frame のスクリプトが、親の realm の送り方（`parent.fetch`・`top.XMLHttpRequest`）で 2 回送る式。要求は
   * 送り方の realm（main frame）のものになる（限界。守りの本体は照合と 1 回の上限）。子の frame は窓の中で作り、終わったら親に知らせる。
   */
  const PARENT_REALM_SENDERS: readonly (readonly [string, string])[] = [
    ['parent.fetch', `const send = () => parent.fetch(r.url, r.init).then(() => 'sent', () => 'failed');
      send().then((first) => send().then((second) => parent.postMessage({ m3: first + '/' + second }, '*')));`],
    ['top.XMLHttpRequest', `const send = () => new Promise((resolve) => { const x = new top.XMLHttpRequest(); x.open(r.init.method, r.url);
        for (const [name, value] of Object.entries(r.init.headers)) x.setRequestHeader(name, value);
        x.onloadend = () => resolve(String(x.status)); x.send(r.init.body); });
      send().then((first) => send().then((second) => parent.postMessage({ m3: first + '/' + second }, '*')));`],
  ];
  it.each(PARENT_REALM_SENDERS)('hands only the first matching request sent by a same-origin iframe with %s, and blocks the second', async (_name, body) => {
    const site = await startSite();
    const { page, monitor, spy, ledger, reached } = await openStage(site, 'CREATE', SPA_APP_PATHS.memberNew);
    await waitReady(page);
    await monitor.openSubmissionWindow(page);
    // T40R-fix-A: 送信の段を開いてから送る（送信の段の中の、子の frame からの要求の扱いを確かめる）。
    monitor.openSubmissionPhase();
    // 子の frame が 2 回の送信の結果を知らせるまで待つ（判定が揃った印）。
    const out = await page.evaluate(`(() => { const r = ${sendSource(site)};
      const frame = document.createElement('iframe');
      frame.srcdoc = '<script>const r = ' + JSON.stringify(r).split('<').join('\\\\u003c') + ';' + ${JSON.stringify(body)} + '<' + '/script>';
      return new Promise((resolve) => { window.addEventListener('message', (event) => { if (event.data && event.data.m3) resolve(event.data.m3); });
        document.body.append(frame); setTimeout(() => resolve('timeout'), 8000); }); })()`).catch(() => 'evaluate-failed');
    console.info(`T39R-fix ${_label} ${_name}: ${JSON.stringify({ out, handed: spy.calls.length, blocked: blockedLines(ledger) })}`);
    expect(out).not.toBe('timeout');
    expect(spy.calls).toEqual([{ method: 'POST', path: SPA_BACKEND_PATHS.members, bodyBytes: expect.any(Number) as number, pageKeys: [] }]);
    expectReached(site, reached);
    expect(blockedLines(ledger)).toContain(`POST ${SPA_BACKEND_PATHS.members} NON_READ_METHOD`);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', sendAttempts: 1 });
  }, TEST_TIMEOUT_MS);

  it.each(OTHER_SENDERS)('blocks the matching request from %s, and nothing reaches the services', async (_name, wrap) => {
    const site = await startSite();
    const { page, monitor, spy, ledger, reached } = await openStage(site, 'CREATE', SPA_APP_PATHS.memberNew);
    await waitReady(page);
    await monitor.openSubmissionWindow(page);
    // T40R-fix-A: 送信の段を開いてから送る（送信の段の中でも、対象の外の送り方は止まる）。
    monitor.openSubmissionPhase();
    await page.evaluate(wrap(sendSource(site))).catch(() => undefined);
    // srcdoc と beacon は送った結果を待てないので、Guard が止めた記録が出るまで待つ。
    await untilSettled(() => ledger.snapshot().blockedRequests.some(({ method }) => method === 'POST'));
    expect(spy.calls).toEqual([]);
    expectReached(site, reached);
  }, TEST_TIMEOUT_MS);

  // 全部の場面の後（Context を閉じた後）に、共有のサイトが静まるのを待ってから、場面ごとに数えた分と数え直す（遅れて届く要求がない）。
  it('after all the scenes, no request reaches the services late', async () => {
    await settleLateDeliveries(LATE_DELIVERY_SETTLE_MS, shared);
    console.info(`T39b ${_label} late check: ${JSON.stringify({ expected: expectedReached, reached: nonReadAtServices(shared) })}`);
    expect(nonReadAtServices(shared)).toEqual(expectedReached);
  }, TEST_TIMEOUT_MS);
});

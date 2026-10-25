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
// 届いたかは fixture の記録で数える（読み取りでない要求。CORS の事前確認は Guard が満たすので届かない）。各場面の終わりに、名前つきの時間
// （`LATE_DELIVERY_SETTLE_MS`）だけ待ってから数え直す。値は出力しない。
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import { BrowserContextFactory, type AuditStageServiceRequests } from '../../src/browser/context-factory.js';
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
import { closeTestContexts, launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
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
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const TEST_TIMEOUT_MS = 120_000;
const UI_TIMEOUT_MS = 15_000;
/** 各場面の終わりに、遅れて届く要求を待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 1_500;
/** 押した後、ページの送信が Guard に届くのを待つ時間（ms。状態の要素が変わらない場面の待ち）。 */
const SEND_SETTLE_MS = 1_500;
const SERVICE_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
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

describe.each(LAUNCHERS)('T39b: the API write stage Guard with %s', (_label, launch) => {
  let browser: Browser;
  let spa: SpaAuthSite | undefined;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await closeTestContexts(browser);
    await spa?.close();
    spa = undefined;
  });

  afterAll(async () => {
    await browser?.close();
  });

  const startSite = async (options: SpaAuthSiteOptions = {}): Promise<SpaAuthSite> => {
    spa = await startSpaAuthSite({ memberScreenLayout: 'formless', ...options });
    return spa;
  };

  const auditStageOf = (site: SpaAuthSite): AuditStageServiceRequests => ({
    approvedServiceOrigins: [site.backendOrigin],
    auditReadRequests: [],
    scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
    serviceRequestLimits: SERVICE_LIMITS,
  });

  /** 認証つきの factory で、API の書き込みの段の Context を開き、`path` を読み込む。 */
  const openStage = async (
    site: SpaAuthSite,
    kind: Kind,
    path: string,
    recordId: string | null = null,
    expectation: ApiWritePayloadExpectation = expectationOf(site, kind, recordId),
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
      serviceRequestBudget: createServiceRequestBudget({ ...SERVICE_LIMITS, now: () => Date.now() }),
      auditStageMonitor: new AuditStageMonitor(),
    });
    factories.push(factory);
    const monitor = new WriteStageMonitor();
    const spy = handoffSpy(site);
    const stage: GuardApiWriteStage = { transport: 'API', expectation, monitor, handoff: spy.handoff };
    const context = await factory.createWriteStageContext(VIEWPORT, stage);
    const page = await factory.createPassivePage(context);
    await page.goto(`${site.appOrigin}${path}`);
    const ledger = factory.getSafetyLedger(context);
    return { page, monitor, spy, ledger };
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
  /** 窓を開いて値を入れ、保存を押し、送信を待つ。 */
  const saveInWindow = async (page: Page, monitor: WriteStageMonitor): Promise<void> => {
    await waitReady(page);
    await monitor.openSubmissionWindow(page);
    await fillValues(page);
    // T40R-fix-A: 値を入れる間は窓の観察の段。押す直前に送信の段を開く（書き込みの入力の部品と同じ順）。
    monitor.openSubmissionPhase();
    await page.click(SPA_MEMBER_FIELDS.submit);
    await page.waitForFunction((id) => document.getElementById(id)?.dataset['state'] !== 'idle', SPA_STATE_ELEMENTS.member, { timeout: UI_TIMEOUT_MS })
      .catch(() => undefined);
    await page.waitForTimeout(SEND_SETTLE_MS);
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
    const { page, spy } = await openStage(site, 'UPDATE', spaMemberEditPathOf(id), String(id));
    await page.locator(`#${SPA_FORMLESS_MEMBER_BOX}`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    await expect.poll(() => boxState(page), { timeout: UI_TIMEOUT_MS }).not.toBe('loading');
    expect(await boxState(page)).toBe('ready');
    expect(await page.inputValue(SPA_MEMBER_FIELDS.name)).toBe(EXISTING_NAME);
    await page.waitForTimeout(LATE_DELIVERY_SETTLE_MS);
    expect(nonReadAtServices(site)).toEqual([]);
    expect(spy.calls).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it.each<[Kind]>([['CREATE'], ['UPDATE']])('hands the first matching %s request in the window to the sender and returns its response to the page', async (kind) => {
    const site = await startSite();
    const id = kind === 'UPDATE' ? site.addMember(EXISTING_NAME) : null;
    const path = id === null ? SPA_APP_PATHS.memberNew : spaMemberEditPathOf(id);
    const { page, monitor, spy } = await openStage(site, kind, path, id === null ? null : String(id));
    await saveInWindow(page, monitor);
    await page.waitForTimeout(LATE_DELIVERY_SETTLE_MS);
    expect(spy.calls).toEqual([{ method: kind === 'CREATE' ? 'POST' : 'PATCH', path: SPA_BACKEND_PATHS.members, bodyBytes: expect.any(Number) as number, pageKeys: [] }]);
    expect(await memberState(page)).toBe('saved');
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', sendAttempts: 1, sendOutcome: 'RESPONDED', responseReceived: true, responseStatus: 201 });
    expect(monitor.isSubmissionWindowOpen()).toBe(false);
    // 送り手の口の偽物は送らないので、サービスの Origin には何も届かない（T39c の前）。
    expect(nonReadAtServices(site)).toEqual([]);
    expect(blockedSum(monitor)).toBe(0);
  }, TEST_TIMEOUT_MS);

  /** 押下で敵対的な送り方をする場面（fixture の `hostileMemberSave`）。`handed` は口に渡る回数（`doubleSend` の 1 回目だけ）。 */
  const HOSTILE_SAVES: readonly (readonly [SpaHostileMemberSave, number])[] = [
    ['doubleSend', 1],
    ['upsert', 0],
    ['arrayBody', 0],
    ['softDeleteKey', 0],
    ['unapprovedOrigin', 0],
    ['methodOverrideHeader', 0],
    ['bodyMethodOverride', 0],
    ['unfilteredPatch', 0],
    ['deleteOnSave', 0],
    ['rpcCall', 0],
    ['encodedRpcPath', 0],
    ['paramRpcPath', 0],
  ];
  it.each(HOSTILE_SAVES)('blocks the hostile save %s and nothing reaches the services', async (save, handed) => {
    const site = await startSite({ hostileMemberSave: save });
    const { page, monitor, spy, ledger } = await openStage(site, 'CREATE', SPA_APP_PATHS.memberNew);
    await saveInWindow(page, monitor);
    await page.waitForTimeout(LATE_DELIVERY_SETTLE_MS);
    const payload = Object.entries(monitor.snapshot().blockedByPayloadReason).filter(([, count]) => count > 0);
    console.info(`T39b ${_label} hostile save ${save}: ${JSON.stringify({ handed: spy.calls.length, payload, blocked: blockedLines(ledger) })}`);
    expect(spy.calls).toHaveLength(handed);
    expect(nonReadAtServices(site)).toEqual([]);
    // 止める経路が働いた証拠: 照合で止めた数か、Guard が止めた要求の記録。
    expect(blockedSum(monitor) + ledger.snapshot().blockedRequests.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  /** page の main world のスクリプトとして、窓の中で送る敵対的な要求。 */
  const PAGE_SENDS: readonly (readonly [string, (site: SpaAuthSite) => string])[] = [
    ['a value rewritten', (site) => sendSource(site, { body: { ...VALUES, name: '書き換え' } })],
    ['a key added', (site) => sendSource(site, { body: { ...VALUES, role: 'admin' } })],
    ['a key removed', (site) => sendSource(site, { body: { name: VALUES.name, email: VALUES.email } })],
    ['a header that is not approved', (site) => sendSource(site, { extraHeaders: { 'x-extra': '1' } })],
    ['a select query that is not approved', (site) => sendSource(site, { url: `${site.backendOrigin}${SPA_BACKEND_PATHS.members}?select=*` })],
  ];
  it.each(PAGE_SENDS)('blocks %s sent by the page script in the window, and nothing reaches the services', async (_name, source) => {
    const site = await startSite();
    const { page, monitor, spy } = await openStage(site, 'CREATE', SPA_APP_PATHS.memberNew);
    await waitReady(page);
    await monitor.openSubmissionWindow(page);
    // T40R-fix-A: 照合を確かめるため、送信の段を開いてからページが送る（観察の段では照合にかけずに止める）。
    monitor.openSubmissionPhase();
    await sendFromPage(page, source(site));
    // 1 回目が止まった後は、ふつうの保存も通らない（1 回だけ）。
    await fillValues(page);
    await page.click(SPA_MEMBER_FIELDS.submit);
    await page.waitForTimeout(SEND_SETTLE_MS + LATE_DELIVERY_SETTLE_MS);
    expect(spy.calls).toEqual([]);
    expect(nonReadAtServices(site)).toEqual([]);
    expect(blockedSum(monitor)).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  /** T39R-fix（M-2）: 窓の中の、承認の endpoint の path でない読み取りでない要求（照合にかけず、書き込みの機会を使わない）。 */
  const OFF_ENDPOINT_SENDS: readonly (readonly [string, (site: SpaAuthSite) => string])[] = [
    ['another path', (site) => sendSource(site, { url: `${site.backendOrigin}/rest/v1/admins` })],
    ['a procedure call', (site) => sendSource(site, { url: `${site.backendOrigin}/rest/v1/rpc/search`, body: {} })],
  ];
  it.each(OFF_ENDPOINT_SENDS)('blocks %s sent in the window without the check, and still hands the approved save once', async (_name, source) => {
    const site = await startSite();
    const { page, monitor, spy, ledger } = await openStage(site, 'CREATE', SPA_APP_PATHS.memberNew);
    await waitReady(page);
    await monitor.openSubmissionWindow(page);
    // T40R-fix-A: 送信の段の中でも、承認の endpoint でない要求は照合にかけずに止まる（送信の段を開いてからページが送る）。
    monitor.openSubmissionPhase();
    await sendFromPage(page, source(site));
    await fillValues(page);
    await page.click(SPA_MEMBER_FIELDS.submit);
    await page.waitForTimeout(SEND_SETTLE_MS + LATE_DELIVERY_SETTLE_MS);
    expect(spy.calls).toEqual([{ method: 'POST', path: SPA_BACKEND_PATHS.members, bodyBytes: expect.any(Number) as number, pageKeys: [] }]);
    expect(nonReadAtServices(site)).toEqual([]);
    expect(blockedSum(monitor)).toBe(0);
    expect(blockedLines(ledger).some((line) => line.startsWith('POST ') && line.endsWith(' NON_READ_METHOD'))).toBe(true);
    expect(await memberState(page)).toBe('saved');
  }, TEST_TIMEOUT_MS);

  it('blocks the filter value rewritten on an UPDATE, and nothing reaches the services', async () => {
    const site = await startSite();
    const id = site.addMember(EXISTING_NAME);
    const other = site.addMember('別の会員');
    const { page, monitor, spy } = await openStage(site, 'UPDATE', spaMemberEditPathOf(id), String(id));
    await waitReady(page);
    await monitor.openSubmissionWindow(page);
    // T40R-fix-A: 照合を確かめるため、送信の段を開いてからページが送る。
    monitor.openSubmissionPhase();
    await sendFromPage(page, sendSource(site, { method: 'PATCH', url: `${site.backendOrigin}${SPA_BACKEND_PATHS.members}?id=eq.${String(other)}` }));
    await page.waitForTimeout(SEND_SETTLE_MS + LATE_DELIVERY_SETTLE_MS);
    expect(spy.calls).toEqual([]);
    expect(nonReadAtServices(site)).toEqual([]);
    expect(monitor.snapshot().blockedByPayloadReason.FILTER_MISMATCH).toBe(1);
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
    await page.click(SPA_MEMBER_FIELDS.submit);
    await page.waitForTimeout(SEND_SETTLE_MS + LATE_DELIVERY_SETTLE_MS);
    const payload = Object.entries(monitor.snapshot().blockedByPayloadReason).filter(([, count]) => count > 0);
    console.info(`T41c ${_label} update rewriteKept=${String(rewriteKept)}: ${JSON.stringify({ payload, member: await memberState(page), report: monitor.submissionReport(), blocked: ledger === undefined ? [] : blockedLines(ledger) })}`);
  };

  it('hands the UPDATE that changes only the changed key and sends the kept keys at their prior values (T41c)', async () => {
    const site = await startSite();
    const id = site.addMember(EXISTING_NAME);
    const { page, monitor, spy, ledger } = await openStage(site, 'UPDATE', spaMemberEditPathOf(id), String(id), updateKeptExpectationOf(site, id));
    await saveUpdateKeepingValues(page, monitor, false, ledger);
    expect(spy.calls).toEqual([{ method: 'PATCH', path: SPA_BACKEND_PATHS.members, bodyBytes: expect.any(Number) as number, pageKeys: [] }]);
    expect(blockedSum(monitor)).toBe(0);
    expect(nonReadAtServices(site)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('blocks the UPDATE whose kept key value the page rewrote, and nothing reaches the services (T41c)', async () => {
    const site = await startSite();
    const id = site.addMember(EXISTING_NAME);
    const { page, monitor, spy, ledger } = await openStage(site, 'UPDATE', spaMemberEditPathOf(id), String(id), updateKeptExpectationOf(site, id));
    await saveUpdateKeepingValues(page, monitor, true, ledger);
    expect(spy.calls).toEqual([]);
    expect(nonReadAtServices(site)).toEqual([]);
    expect(monitor.snapshot().blockedByPayloadReason.BODY_VALUE_MISMATCH).toBe(1);
    expect(site.memberOf(id)?.email).not.toBe('rewritten-by-page@example.invalid');
  }, TEST_TIMEOUT_MS);

  it('blocks the matching request sent outside the window, and nothing reaches the services', async () => {
    const site = await startSite();
    const { page, monitor, spy, ledger } = await openStage(site, 'CREATE', SPA_APP_PATHS.memberNew);
    await waitReady(page);
    await sendFromPage(page, sendSource(site));
    await page.waitForTimeout(SEND_SETTLE_MS + LATE_DELIVERY_SETTLE_MS);
    expect(spy.calls).toEqual([]);
    expect(nonReadAtServices(site)).toEqual([]);
    expect(blockedLines(ledger)).toContain(`POST ${SPA_BACKEND_PATHS.members} NON_READ_METHOD`);
  }, TEST_TIMEOUT_MS);

  // T40R-fix-A（Task 40 の設計書 7 章の T40R の I-1）: 窓の観察の段（窓を開いた後、送信の段を開く前）では、承認どおりの要求も照合にかけずに止めて数える
  // （送り手の口に渡さない）。送信の段は Node の側の部品の口（`openSubmissionPhase`）でだけ開き、窓を開く前は開けない。ページの要求は段を変えない。
  it('blocks the matching request in the observation phase of the window without the check, and counts it as unexpected', async () => {
    const site = await startSite();
    const { page, monitor, spy, ledger } = await openStage(site, 'CREATE', SPA_APP_PATHS.memberNew);
    await waitReady(page);
    expect(monitor.openSubmissionPhase()).toBe(false);
    await monitor.openSubmissionWindow(page);
    await sendFromPage(page, sendSource(site));
    await page.waitForTimeout(SEND_SETTLE_MS + LATE_DELIVERY_SETTLE_MS);
    expect(spy.calls).toEqual([]);
    expect(nonReadAtServices(site)).toEqual([]);
    expect(monitor.unexpectedRequestCount()).toBeGreaterThan(0);
    expect(blockedSum(monitor)).toBe(0);
    expect(monitor.isSubmissionPhaseOpen()).toBe(false);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'NOT_SENT', sendAttempts: 0 });
    expect(blockedLines(ledger)).toContain(`POST ${SPA_BACKEND_PATHS.members} NON_READ_METHOD`);
  }, TEST_TIMEOUT_MS);

  it('blocks the value rewritten by the page script just before the send (rewriteOnInput), and nothing reaches the services', async () => {
    const site = await startSite({ hostileMemberInput: 'rewriteOnInput' });
    const { page, monitor, spy } = await openStage(site, 'CREATE', SPA_APP_PATHS.memberNew);
    await saveInWindow(page, monitor);
    await page.waitForTimeout(LATE_DELIVERY_SETTLE_MS);
    expect(spy.calls).toEqual([]);
    expect(nonReadAtServices(site)).toEqual([]);
    expect(monitor.snapshot().blockedByPayloadReason.BODY_VALUE_MISMATCH).toBe(1);
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
    const { page, monitor, spy, ledger } = await openStage(site, 'CREATE', SPA_APP_PATHS.memberNew);
    await waitReady(page);
    await monitor.openSubmissionWindow(page);
    // T40R-fix-A: 送信の段を開いてから送る（送信の段の中の、子の frame からの要求の扱いを確かめる）。
    monitor.openSubmissionPhase();
    const out = await page.evaluate(`(() => { const r = ${sendSource(site)};
      const frame = document.createElement('iframe');
      frame.srcdoc = '<script>const r = ' + JSON.stringify(r).split('<').join('\\\\u003c') + ';' + ${JSON.stringify(body)} + '<' + '/script>';
      return new Promise((resolve) => { window.addEventListener('message', (event) => { if (event.data && event.data.m3) resolve(event.data.m3); });
        document.body.append(frame); setTimeout(() => resolve('timeout'), 8000); }); })()`).catch(() => 'evaluate-failed');
    await page.waitForTimeout(SEND_SETTLE_MS + LATE_DELIVERY_SETTLE_MS);
    console.info(`T39R-fix ${_label} ${_name}: ${JSON.stringify({ out, handed: spy.calls.length, blocked: blockedLines(ledger) })}`);
    expect(out).not.toBe('timeout');
    expect(spy.calls).toEqual([{ method: 'POST', path: SPA_BACKEND_PATHS.members, bodyBytes: expect.any(Number) as number, pageKeys: [] }]);
    expect(nonReadAtServices(site)).toEqual([]);
    expect(blockedLines(ledger)).toContain(`POST ${SPA_BACKEND_PATHS.members} NON_READ_METHOD`);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', sendAttempts: 1 });
  }, TEST_TIMEOUT_MS);

  it.each(OTHER_SENDERS)('blocks the matching request from %s, and nothing reaches the services', async (_name, wrap) => {
    const site = await startSite();
    const { page, monitor, spy, ledger } = await openStage(site, 'CREATE', SPA_APP_PATHS.memberNew);
    await waitReady(page);
    await monitor.openSubmissionWindow(page);
    // T40R-fix-A: 送信の段を開いてから送る（送信の段の中でも、対象の外の送り方は止まる）。
    monitor.openSubmissionPhase();
    await page.evaluate(wrap(sendSource(site))).catch(() => undefined);
    await page.waitForTimeout(SEND_SETTLE_MS + LATE_DELIVERY_SETTLE_MS);
    expect(spy.calls).toEqual([]);
    expect(nonReadAtServices(site)).toEqual([]);
    expect(ledger.snapshot().blockedRequests.some(({ method }) => method === 'POST')).toBe(true);
  }, TEST_TIMEOUT_MS);
});

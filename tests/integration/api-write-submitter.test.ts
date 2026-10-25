// T39d（Task 39 の設計書 3.5）: API のシナリオの書き込みの、入力と押下の部品（`src/browser/api-write-submitter.ts`）。本物の factory と Guard（書き込みの段の
// Context）と、fixture（`startSpaAuthSite` の form のない会員の画面 `memberScreenLayout: 'formless'` と、form のある画面、入力の敵対的な形
// `hostileMemberInput`）で確かめる。Chromium はテストの既定と、CLI の起動の設定の両方。
// - 入力の前の確かめ（`inspectApiWriteInput`）: 欄は `NAME`・`SELECTOR` の識別で、その画面でちょうど 1 つ・見える・編集できる。送信の要素は、probe の時の
//   候補の識別の digest で探し、ちょうど 1 つ・`href` のある祖先がない。
// - 入力（`fillApiWriteInput`）: 送信の窓を開いてから入れ、入れた後に DOM の値を読み直す（ページの JS が書き換えれば `VALUE_CHANGED`）。
// - 押下（`submitApiWriteInput`）: 押す直前に値を読み直してから押す。押したことは、書き込みの段の Guard が止めた記録で確かめる（Guard の窓の作りが API の形に
//   広がるのは T39b なので、今は API の要求は止まる）。
// - 安全: どの場面でも、サーバに届いた読み取りでない要求と事前確認は 0（fixture の記録で数え、全部の後に名前つきの時間だけ待って数え直す）。違反は 0。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import {
  API_WRITE_INPUT_REASONS,
  fillApiWriteInput,
  inspectApiWriteInput,
  readApiWriteFieldValues,
  submitApiWriteInput,
  type ApiWriteInputSpec,
} from '../../src/browser/api-write-submitter.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig, Viewport } from '../../src/config/types.js';
import { probedCandidateIdentityDigestOf } from '../../src/discovery/discover-page.js';
import { locationOfUrl, probePageCandidates } from '../../src/discovery/probe.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';
import { AuditStageMonitor, WriteStageMonitor } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { API_WRITE_INPUT_REASON_DESCRIPTIONS } from '../../src/presentation/messages.js';
import { closeTestContexts, launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_FORMLESS_MEMBER_BOX,
  spaMemberEditPathOf,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
} from '../helpers/spa-auth-site-fixture.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 120_000;
const UI_TIMEOUT_MS = 15_000;
/** 押した後、ページの要求が静まるまで待つ時間（ms）。 */
const QUIET_WAIT_MS = 1_000;
/** 全部の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
const VIEWPORT: Viewport = Object.freeze({ width: 1280, height: 800 });
/** T41d: 承認したサービスの Origin への要求の上限（設定の上限の値）。 */
const SERVICE_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
const SAVE_WORD = '保存';
/** 入れる値（テストの値。秘密ではない）。 */
const VALUES = Object.freeze({ name: 'T39D 名前', email: 't39d-member@example.invalid', note: 'T39D 備考' });

describe('T39d: the closed list of the reasons of the API write input', () => {
  it('has a description for every reason', () => {
    expect(Object.keys(API_WRITE_INPUT_REASON_DESCRIPTIONS).sort()).toEqual([...API_WRITE_INPUT_REASONS].sort());
  });
});

describe.each(LAUNCHERS)('T39d: the input and the press of the API write with %s', (_label, launch) => {
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

  /**
   * 認証つきの factory の書き込みの段の Context で、会員の登録の画面を開き、準備を待つ。T41d: `pathOf` で開く画面を替えられる（更新の画面など。fixture の
   * 準備（会員を足す、切り替え）もその中で行う）。
   */
  const openCreateScreen = async (
    options: SpaAuthSiteOptions,
    readySelector: string,
    pathOf: (site: SpaAuthSite) => string = () => SPA_APP_PATHS.memberNew,
    /** T41d: 承認したサービスの Origin（バックエンド）への読み取りを通す（更新の画面が前の値を読むため）。 */
    serviceReads = false,
  ) => {
    spa = await startSpaAuthSite(options);
    const site = spa;
    const screenPath = pathOf(site);
    const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.memberNew);
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.memberNew}`, allowedOrigins: [site.appOrigin] } };
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: {
        initialState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: site.issueStoredSession() }] }] },
        filterState: (state) => state,
        auditExclusions: { excludedPathPrefixes: [SPA_APP_PATHS.logout], auditPathPrefixes: [], dangerousTerms: [] },
        ...(serviceReads
          ? {
            auditStage: {
              approvedServiceOrigins: [site.backendOrigin],
              auditReadRequests: [],
              scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [] },
              serviceRequestLimits: SERVICE_LIMITS,
            },
          }
          : {}),
      },
      ...(serviceReads
        ? { serviceRequestBudget: createServiceRequestBudget({ ...SERVICE_LIMITS, now: () => Date.now() }), auditStageMonitor: new AuditStageMonitor() }
        : {}),
    });
    factories.push(factory);
    const monitor = new WriteStageMonitor();
    // 書き込みの段の指定（form の承認の形。API の要求はこの形に当たらないので、Guard が止める。API の分岐は T39b）。
    // T41d: 更新の画面の値の読み取りは、ワーカーの前の読み取りと同じく、凍結する Passive の Context で読む（form の書き込みの段の Context は、サービスの
    // Origin への読み取りを通さない）。
    const context: BrowserContext = serviceReads ? await factory.createPassiveContext(VIEWPORT) : await factory.createWriteStageContext(VIEWPORT, {
      expectation: {
        request: { origin: site.appOrigin, path: '/t39d-never', enctype: 'application/x-www-form-urlencoded' },
        submittedFields: [{ name: 'name', value: VALUES.name }],
        passthroughFieldNames: [],
        emptyFileFieldNames: [],
      },
      monitor,
    });
    // DEF-134-fix: 要素の位置の engine は、factory が page を作る前に登録する（下の準備の待ちが先に Playwright のセレクタを使っても、合図つきの Locator が
    // 使える）。
    const page: Page = await factory.createPassivePage(context);
    await page.goto(`${site.appOrigin}${screenPath}`);
    await page.locator(readySelector).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    return { site, page, monitor, ledger: () => factory.getSafetyLedger(context).snapshot() };
  };

  /** 画面の、語を持つ候補の識別の digest（probe の時の候補の識別の代わり。画面の読み取りで求める）。 */
  const identityOf = async (page: Page, word: string): Promise<string> => {
    const probe = await probePageCandidates(page, Date.now() + UI_TIMEOUT_MS);
    const { location } = locationOfUrl(page.url());
    const found = probe.status === 'READ' ? probe.candidates.find((candidate) => candidate.submitterWords.includes(word)) : undefined;
    if (found === undefined) throw new Error('the screen has no candidate with the word');
    return probedCandidateIdentityDigestOf(location, found);
  };

  const specOf = async (page: Page): Promise<ApiWriteInputSpec> => ({
    submitterIdentityDigest: await identityOf(page, SAVE_WORD),
    fields: [
      { field: { kind: 'NAME', name: 'name' }, value: VALUES.name },
      { field: { kind: 'NAME', name: 'email' }, value: VALUES.email },
      { field: { kind: 'SELECTOR', selector: '#note' }, value: VALUES.note },
    ],
  });

  /** サーバに届いた、読み取りでない要求と事前確認（全部の後に待って数え直す）。 */
  const reachedNonReads = async (site: SpaAuthSite): Promise<readonly string[]> => {
    await wait(LATE_REQUEST_WAIT_MS);
    return site.requests
      .filter((request) => request.preflight || !READ_METHODS.has(request.method))
      .map(({ origin, method, path }) => `${origin} ${method} ${path}`);
  };

  /** 書き込みの段の Guard が止めた、バックエンドの会員の表への要求（押下が起きた証拠）。 */
  const blockedMemberWrites = (snapshot: ReturnType<SafetyLedger['snapshot']>, site: SpaAuthSite): readonly string[] =>
    snapshot.blockedRequests
      .filter(({ url }) => url.startsWith(`${site.backendOrigin}${SPA_BACKEND_PATHS.members}`))
      .map(({ method }) => method);

  /** 確かめ・入力・押下を順に行う。 */
  const run = async (page: Page, monitor: WriteStageMonitor, spec: ApiWriteInputSpec) => {
    const inspected = await inspectApiWriteInput(page, spec);
    if (!inspected.ok) return { stage: 'inspect', reason: inspected.reason } as const;
    const filled = await fillApiWriteInput(page, inspected.input, monitor);
    if (!filled.ok) return { stage: 'fill', reason: filled.reason } as const;
    const submitted = await submitApiWriteInput(page, inspected.input);
    if (!submitted.ok) return { stage: 'submit', reason: submitted.reason } as const;
    await wait(QUIET_WAIT_MS);
    return { stage: 'submitted', reason: null } as const;
  };

  it('fills the fields of the formless screen (NAME and SELECTOR) and presses the BUTTON; the Guard of the write stage blocks the request', async () => {
    const { site, page, monitor, ledger } = await openCreateScreen({ memberScreenLayout: 'formless' }, `#${SPA_FORMLESS_MEMBER_BOX}[data-state="ready"]`);
    const outcome = await run(page, monitor, await specOf(page));
    expect(outcome).toEqual({ stage: 'submitted', reason: null });
    expect(await page.inputValue('#name')).toBe(VALUES.name);
    expect(await page.inputValue('#member-email')).toBe(VALUES.email);
    expect(await page.inputValue('#note')).toBe(VALUES.note);
    expect(blockedMemberWrites(ledger(), site).length).toBeGreaterThan(0);
    expect(await reachedNonReads(site)).toEqual([]);
    expect(ledger().invariantViolations).toEqual([]);
    expect(site.memberCount).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('fills the fields of the form screen and presses its submit button (FORM)', async () => {
    const { site, page, monitor, ledger } = await openCreateScreen({}, '#member-form[data-state="ready"]');
    const outcome = await run(page, monitor, await specOf(page));
    expect(outcome).toEqual({ stage: 'submitted', reason: null });
    expect(await page.inputValue('#name')).toBe(VALUES.name);
    expect(blockedMemberWrites(ledger(), site).length).toBeGreaterThan(0);
    expect(await reachedNonReads(site)).toEqual([]);
    expect(ledger().invariantViolations).toEqual([]);
  }, TEST_TIMEOUT_MS);

  const HOSTILE_CASES = [
    ['duplicateName', 'inspect', 'FIELD_AMBIGUOUS'],
    ['duplicateSubmit', 'inspect', 'SUBMITTER_AMBIGUOUS'],
    ['hiddenField', 'inspect', 'FIELD_NOT_VISIBLE'],
    ['linkWrappedSubmit', 'inspect', 'SUBMITTER_INSIDE_LINK'],
    ['rewriteOnInput', 'fill', 'VALUE_CHANGED'],
  ] as const;

  it.each(HOSTILE_CASES)('stops the hostile input %s at %s with %s and never presses', async (hostile, stage, reason) => {
    const { site, page, monitor, ledger } = await openCreateScreen({ hostileMemberInput: hostile }, `#${SPA_FORMLESS_MEMBER_BOX}[data-state="ready"]`);
    const outcome = await run(page, monitor, await specOf(page));
    expect(outcome).toEqual({ stage, reason });
    await wait(QUIET_WAIT_MS);
    // 押していない（Guard の止めた記録に、会員の表への要求がない）。
    expect(blockedMemberWrites(ledger(), site)).toEqual([]);
    expect(await reachedNonReads(site)).toEqual([]);
    expect(ledger().invariantViolations).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('stops a spec whose field or submitter is not on the screen', async () => {
    const { site, page } = await openCreateScreen({ memberScreenLayout: 'formless' }, `#${SPA_FORMLESS_MEMBER_BOX}[data-state="ready"]`);
    const spec = await specOf(page);
    expect(await inspectApiWriteInput(page, { ...spec, fields: [{ field: { kind: 'NAME', name: 'missing' }, value: 'x' }] }))
      .toEqual({ ok: false, reason: 'FIELD_NOT_FOUND' });
    expect(await inspectApiWriteInput(page, { ...spec, submitterIdentityDigest: `sha256:${'0'.repeat(64)}` }))
      .toEqual({ ok: false, reason: 'SUBMITTER_NOT_FOUND' });
    expect(await inspectApiWriteInput(page, { ...spec, fields: [] })).toEqual({ ok: false, reason: 'SPEC_INVALID' });
    expect(await reachedNonReads(site)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // T41d（Task 41 の設計書 3.4 の 1）: 欄の識別（`NAME`・`SELECTOR`）で、更新の画面の欄の今の値を読む（form の外の欄も。値は記録しない）。値が落ち着くまで、
  // 間隔を置いて 2 回読み、同じになるまで待つ。
  const UPDATE_FIELDS = Object.freeze([
    { kind: 'NAME', name: 'name' },
    { kind: 'NAME', name: 'email' },
    { kind: 'SELECTOR', selector: '#note' },
  ] as const);
  const EXISTING_NAME = '既存 会員';

  it('reads the current values of the fields of the formless update screen by the field identities', async () => {
    const { site, page } = await openCreateScreen({ memberScreenLayout: 'formless' }, `#${SPA_FORMLESS_MEMBER_BOX}[data-state="ready"]`,
      (target) => spaMemberEditPathOf(target.addMember(EXISTING_NAME)), true);
    const member = site.memberOf(1);
    expect(await readApiWriteFieldValues(page, UPDATE_FIELDS)).toEqual({ ok: true, values: [EXISTING_NAME, member?.email, member?.note] });
    expect(await reachedNonReads(site)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('waits until the page fills the values later, and reads the filled values (not the empty ones)', async () => {
    const { site, page } = await openCreateScreen({ memberScreenLayout: 'formless' }, `#${SPA_FORMLESS_MEMBER_BOX}[data-state="ready"]`, (target) => {
      target.setMemberValuesDelayed(true);
      return spaMemberEditPathOf(target.addMember(EXISTING_NAME));
    }, true);
    // 準備の印の直後は、まだ値が入っていない（遅れて入れる形）。
    expect(await page.inputValue('#name')).toBe('');
    const member = site.memberOf(1);
    expect(await readApiWriteFieldValues(page, UPDATE_FIELDS)).toEqual({ ok: true, values: [EXISTING_NAME, member?.email, member?.note] });
  }, TEST_TIMEOUT_MS);

  it('gives up when a value keeps changing, and stops a field that is missing or ambiguous', async () => {
    const { page } = await openCreateScreen({ memberScreenLayout: 'formless' }, `#${SPA_FORMLESS_MEMBER_BOX}[data-state="ready"]`,
      (target) => spaMemberEditPathOf(target.addMember(EXISTING_NAME)), true);
    expect(await readApiWriteFieldValues(page, [{ kind: 'NAME', name: 'missing' }])).toEqual({ ok: false, reason: 'FIELD_NOT_FOUND' });
    expect(await readApiWriteFieldValues(page, [{ kind: 'SELECTOR', selector: 'input' }])).toEqual({ ok: false, reason: 'FIELD_AMBIGUOUS' });
    expect(await readApiWriteFieldValues(page, [])).toEqual({ ok: false, reason: 'SPEC_INVALID' });
    // テストの中で、値を書き換え続ける（落ち着かない）。
    await page.evaluate(() => {
      let count = 0;
      setInterval(() => { count += 1; (document.getElementById('note') as HTMLInputElement).value = `changing ${String(count)}`; }, 100);
    });
    expect(await readApiWriteFieldValues(page, UPDATE_FIELDS)).toEqual({ ok: false, reason: 'PAGE_UNREADABLE' });
  }, TEST_TIMEOUT_MS);
});

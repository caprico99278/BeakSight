// T27b（Task 27 の設計書 4.2、6 章）: 発見の入口（`discoverPageCandidates`）を、本物の factory の Passive の Context（Guard つき）と、127.0.0.1 の
// fixture のサーバ（`tests/helpers/discovery-fixture.ts`）で確かめる。Chromium は headless だけ（テストの既定と、CLI の起動の設定の両方）。
// - 候補の形と分類（T27a の分類を通した結果）、値・トークン・選択肢の label・hidden の値が結果に出ない、候補が成果物のスキーマに通る。
// - 発見の間（呼んでから、終わって `QUIET_PERIOD_MS` 待つまで）に fixture のサーバが受けた要求は 0 件。サーバが受けた GET 以外の要求は、
//   全体で 0 件（ページ自身の beacon と fetch の POST は、Guard が止めて Safety Ledger に記録する）。
// - SPA の待ち（読み込みの後の GET の応答を待って描く画面を読む）、落ち着かない画面の不完全の記録（上限の時間）、closed な shadow root と
//   iframe の不完全の記録、open な shadow root の中の form、DOM clobbering のフォーム、凍結の後のページの JS の送信がサーバに届かないこと、
//   凍結の条件（page が 1 つ）が満たされないときは読まずに不完全として返すこと。
// - DEF-087: ページの JS が標準の getter とメソッドを偽っても、probe と READ の結果の構造の読み取りが本来の値を返すこと（isolated world で
//   読む）、読み取りの間にページの JS が走らないこと、読み込み直しで古くなった world と期限切れが、読めなかった結果（fail-closed）になること。
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { validateControlDocument } from '../../src/control/control-schema-validator.js';
import { wait } from '../../src/core/deadline.js';
import { MAX_SELECT_OPTION_VALUES, type DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { DISCOVERY_READ_TIMEOUT_MS, discoverPageCandidates } from '../../src/discovery/discover-page.js';
import type { DiscoveryReadPageRecord } from '../../src/discovery/discovery-result.js';
import { probePageCandidates } from '../../src/discovery/probe.js';
import { readPageStructure, readSettledPageStructure } from '../../src/discovery/read-executor.js';
import { DISCOVERY_SETTLE_TIMEOUT_MS, InFlightRequestCounter } from '../../src/discovery/settle.js';
import { assertPassiveRequestGuardActive } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import {
  DISCOVERY_FIXTURE_PATHS,
  MANY_OPTIONS_COUNT,
  PAGE_HITS_GLOBAL,
  startDiscoveryFixture,
  type DiscoveryFixture,
  type DiscoveryFixtureRequest,
} from '../helpers/discovery-fixture.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;
/** 発見の後に、遅れて届く要求を待つ時間（ms）。 */
const QUIET_PERIOD_MS = 500;
/** 落ち着かない画面のテストの上限（ms）。落ち着きの待ちの上限と、読み取りの時間を含む。 */
const UNSTABLE_TEST_TIMEOUT_MS = 60_000;
const NO_LISTENERS = { form: [], submitter: [], ancestor: [], document: [], window: [], inlineHandler: false };
const NO_CONSTRAINTS = { pattern: null, min: null, max: null, step: null, minlength: null, maxlength: null, autocomplete: null };
/** DEF-087: ページの主の thread を占める時間（ms）と、占めている間の読み取りの期限（ms）、占め始めるのを待つ時間（ms）。 */
const BUSY_PAGE_MS = 3_000;
const BUSY_READ_DEADLINE_MS = 300;
const BUSY_START_WAIT_MS = 100;

/**
 * DEF-087: ページの JS が走った回数（`PAGE_HITS_GLOBAL`）を、CDP の `Runtime.evaluate` で値として読む（global の値を読むだけで、ページの
 * getter やメソッドを呼ばない。Playwright の `evaluate` は、ページの JS を呼びうるので使わない）。
 */
const readPageHits = async (page: Page): Promise<number> => {
  const session = await page.context().newCDPSession(page);
  try {
    const { result } = await session.send('Runtime.evaluate', { expression: `window.${PAGE_HITS_GLOBAL}`, returnByValue: true });
    return typeof result.value === 'number' ? result.value : Number.NaN;
  } finally {
    await session.detach();
  }
};

interface DiscoveryRun {
  readonly record: DiscoveryReadPageRecord;
  /** 発見を呼んでから、終わって `QUIET_PERIOD_MS` 待つまでに、サーバが受けた要求。 */
  readonly requestsDuringDiscovery: readonly DiscoveryFixtureRequest[];
  readonly elapsedMs: number;
  readonly page: Page;
  readonly context: BrowserContext;
  readonly ledger: SafetyLedger;
}

describe.each(LAUNCHERS)('T27b: discovering candidates by reading only (%s)', (_name, launch) => {
  let browser: Browser;
  let fixture: DiscoveryFixture;
  const resources: { factory: BrowserContextFactory; context: BrowserContext }[] = [];

  beforeAll(async () => {
    browser = await launch();
    fixture = await startDiscoveryFixture();
  });

  afterEach(async () => {
    for (const resource of resources.splice(0)) {
      await closePassiveResources(resource);
      await resource.factory.close();
    }
  });

  afterAll(async () => {
    // 全体で、GET と HEAD 以外の要求は 1 件もサーバに届かない。
    expect(fixture?.requests.filter(({ method }) => !READ_METHODS.has(method)) ?? []).toEqual([]);
    await fixture?.close();
    await browser?.close();
  });

  /** Guard つきの Passive の Context で画面を開く（要求の数え方は、読み込みの前に付ける）。 */
  const open = async (path: string): Promise<{ page: Page; context: BrowserContext; ledger: SafetyLedger; counter: InFlightRequestCounter; factory: BrowserContextFactory }> => {
    const config = createTestConfig(fixture.origin);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop);
    resources.push({ factory, context });
    const page = await factory.createPassivePage(context);
    const counter = new InFlightRequestCounter(page);
    await page.goto(fixture.url(path));
    return { page, context, ledger: factory.getSafetyLedger(context), counter, factory };
  };

  /** `ready` は、発見を始める前に待つこと（ページ自身の要求がサーバに届くのを待つなど）。 */
  const discover = async (path: string, ready?: () => Promise<void>): Promise<DiscoveryRun> => {
    const { page, context, ledger, counter } = await open(path);
    await ready?.();
    const start = fixture.requests.length;
    const startedAt = Date.now();
    const record = await discoverPageCandidates(page, {
      classificationPolicy: { allowedOrigins: new Set([fixture.origin]) },
      requestCounter: counter,
    });
    const elapsedMs = Date.now() - startedAt;
    counter.dispose();
    await wait(QUIET_PERIOD_MS);
    return { record, requestsDuringDiscovery: fixture.requests.slice(start), elapsedMs, page, context, ledger };
  };

  /** 値・トークン・選択肢の label・hidden の値の目印が、結果のどこにも出ない。候補は成果物のスキーマに通る。 */
  const expectSafeRecord = (record: DiscoveryReadPageRecord): void => {
    const text = JSON.stringify(record);
    for (const value of Object.values(fixture.markers)) {
      expect(text.includes(value), value).toBe(false);
    }
    for (const candidate of record.candidates) {
      const result = validateControlDocument('candidate', candidate);
      expect(result.ok ? [] : result.errors).toEqual([]);
      expect(candidate.incompleteReasons).toEqual(record.incompleteReasons);
      expect(candidate.page).toEqual(record.location);
    }
  };

  const byName = (candidate: DiscoveryCandidate | undefined, name: string) => candidate?.fields.find((field) => field.name === name);

  it('reads a GET search form as READ, with option values but without input values or option labels', async () => {
    const { record, requestsDuringDiscovery } = await discover(DISCOVERY_FIXTURE_PATHS.search);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(record.location).toEqual({ origin: fixture.origin, path: DISCOVERY_FIXTURE_PATHS.search });
    expect(record.incompleteReasons).toEqual([]);
    expect(record.candidates).toHaveLength(1);
    const [candidate] = record.candidates;
    expect(candidate).toMatchObject({
      kind: 'FORM',
      formMethod: 'GET',
      methodOverride: null,
      action: { origin: fixture.origin, path: '/items', queryNames: [] },
      enctype: 'application/x-www-form-urlencoded',
      target: '',
      // T27R-fix-1（DEF-086）: ボタンの文言「検索」は持たず、分類の語だけを持つ。
      submitterWords: ['検索'],
      jsBinding: NO_LISTENERS,
      classification: 'READ',
      reasonCode: 'READ_GET_FORM',
      hasStateField: false,
    });
    expect(candidate?.identityDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(candidate?.fields).toEqual([
      {
        name: 'q', tag: 'input', type: 'search', required: true, readonly: false, disabled: false, hidden: false,
        constraints: { ...NO_CONSTRAINTS, pattern: '[^<>]*', maxlength: '50' }, options: null, omittedOptionCount: 0, hasValue: true,
      },
      {
        name: 'category', tag: 'select', type: 'select-one', required: false, readonly: false, disabled: false, hidden: false,
        constraints: NO_CONSTRAINTS, options: ['', 'a', ''], omittedOptionCount: 0, hasValue: true,
      },
      {
        name: 'in_stock', tag: 'input', type: 'checkbox', required: false, readonly: false, disabled: false, hidden: false,
        constraints: NO_CONSTRAINTS, options: ['1'], omittedOptionCount: 0, hasValue: true,
      },
      {
        name: 'sort', tag: 'input', type: 'radio', required: false, readonly: false, disabled: false, hidden: false,
        constraints: NO_CONSTRAINTS, options: ['new'], omittedOptionCount: 0, hasValue: false,
      },
      {
        name: 'sort', tag: 'input', type: 'radio', required: false, readonly: false, disabled: false, hidden: false,
        constraints: NO_CONSTRAINTS, options: ['on'], omittedOptionCount: 0, hasValue: false,
      },
    ]);
  });

  it('reads the registration, update and delete forms (CREATE, UPDATE by _method, NOT_EXECUTABLE), without tokens', async () => {
    const create = await discover(DISCOVERY_FIXTURE_PATHS.create);
    expect(create.requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(create.record);
    expect(create.record.candidates.map(({ classification, reasonCode, formMethod }) => [classification, reasonCode, formMethod]))
      .toEqual([['CREATE', 'CREATE_WORD', 'POST']]);
    expect(byName(create.record.candidates[0], 'authenticity_token')).toMatchObject({ type: 'hidden', hidden: true, hasValue: true });
    expect(byName(create.record.candidates[0], 'note')).toMatchObject({ tag: 'textarea', type: 'textarea', hasValue: true });

    const update = await discover(DISCOVERY_FIXTURE_PATHS.update);
    expect(update.requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(update.record);
    expect(update.record.candidates.map(({ classification, reasonCode, methodOverride }) => [classification, reasonCode, methodOverride]))
      .toEqual([['UPDATE', 'UPDATE_METHOD', 'PATCH']]);

    const remove = await discover(DISCOVERY_FIXTURE_PATHS.remove);
    expect(remove.requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(remove.record);
    expect(remove.record.candidates.map(({ classification, reasonCode, methodOverride, submitterWords }) =>
      [classification, reasonCode, methodOverride, submitterWords])).toEqual([['NOT_EXECUTABLE', 'DESTRUCTIVE', 'DELETE', ['削除']]]);
  });

  it('keeps only the classification words of the row buttons, not their text, aria-label or title (T27R-fix-1, DEF-086)', async () => {
    const { record, requestsDuringDiscovery } = await discover(DISCOVERY_FIXTURE_PATHS.rowButtons);
    expect(requestsDuringDiscovery).toEqual([]);
    // 行の目印（ボタンの文字・`aria-label`・`title` に置いた）が、結果のどこにも出ない（`expectSafeRecord` は目印のすべてを探す）。
    expectSafeRecord(record);
    const rows = [1, 2, 3];
    expect(record.candidates.map(({ kind, submitterWords, classification, reasonCode }) => [kind, submitterWords, classification, reasonCode])).toEqual([
      ...rows.flatMap(() => [['FORM', ['編集'], 'UPDATE', 'UPDATE_WORD'], ['FORM', ['削除'], 'NOT_EXECUTABLE', 'DESTRUCTIVE']]),
      ...rows.map(() => ['BUTTON', ['検索'], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION']),
    ]);
    // 行ごとの文言の違いは、識別の digest を変えない（同じ語の組のボタンは、行が違っても同じ識別）。
    expect(new Set(record.candidates.map(({ identityDigest }) => identityDigest)).size).toBe(3);
  });

  it('keeps the identity digest when the page is loaded again with a new token', async () => {
    const first = await discover(DISCOVERY_FIXTURE_PATHS.create);
    const second = await discover(DISCOVERY_FIXTURE_PATHS.create);
    expect(second.record.candidates[0]?.identityDigest).toBe(first.record.candidates[0]?.identityDigest);
    expect(second.record.candidates[0]?.ruleDigest).toBe(first.record.candidates[0]?.ruleDigest);
  });

  it('reads the JS bindings (element listeners, inline onsubmit, buttons outside the forms) through CDP', async () => {
    const { record, requestsDuringDiscovery } = await discover(DISCOVERY_FIXTURE_PATHS.jsBound);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(record.candidates.map(({ kind, submitterWords, classification, reasonCode }) => [kind, submitterWords, classification, reasonCode])).toEqual([
      // T27R-fix-1（DEF-086）: 候補は文言（送る、メモ、実行、閉じる、開く）を持たず、分類の語だけを持つ（どれも語なし）。
      ['FORM', [], 'NEEDS_BINDING', 'JS_BOUND'],
      ['FORM', [], 'NEEDS_BINDING', 'JS_BOUND'],
      ['BUTTON', [], 'NEEDS_BINDING', 'JS_BOUND'],
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
    ]);
    const [element, inline, outsideBound, outsidePlain] = record.candidates;
    expect(element?.jsBinding).toEqual({ ...NO_LISTENERS, form: ['submit'] });
    expect(inline?.jsBinding).toEqual({ ...NO_LISTENERS, form: ['submit'], inlineHandler: true });
    expect(outsideBound?.jsBinding).toEqual({ ...NO_LISTENERS, submitter: ['click'] });
    expect(outsidePlain?.jsBinding).toEqual(NO_LISTENERS);
    expect(outsideBound).toMatchObject({ formMethod: null, action: null, enctype: null, target: null, fields: [] });
  });

  it('lists the buttons inside a form that are not submit buttons as BUTTON candidates that cannot be run (round 1)', async () => {
    const { record, requestsDuringDiscovery } = await discover(DISCOVERY_FIXTURE_PATHS.formButtons);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(record.incompleteReasons).toEqual([]);
    expect(record.candidates.map(({ kind, submitterWords, classification, reasonCode }) => [kind, submitterWords, classification, reasonCode])).toEqual([
      // T27R-fix-1（DEF-086）: 文言（登録、下書きを送る、プレビュー、計算、クリア、空、開く、削除）は持たず、分類の語だけを持つ。
      ['FORM', ['登録'], 'CREATE', 'CREATE_WORD'],
      // JS で送るボタン（要素の click の listener）。
      ['BUTTON', [], 'NEEDS_BINDING', 'JS_BOUND'],
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
      // リセット（入力を消すだけで、サーバへ送らない）。
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
      ['BUTTON', ['削除'], 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
    ]);
    const buttons = record.candidates.filter(({ kind }) => kind === 'BUTTON');
    for (const button of buttons) {
      expect(button).toMatchObject({ formMethod: null, methodOverride: null, action: null, enctype: null, target: null, fields: [] });
    }
    expect(buttons[0]?.jsBinding).toEqual({ ...NO_LISTENERS, submitter: ['click'] });
    // どの候補も実行の権限を持たない分類（READ・CREATE・UPDATE にならない）。
    expect(buttons.every(({ classification }) => ['NEEDS_BINDING', 'DISPLAY_ONLY', 'NOT_EXECUTABLE'].includes(classification))).toBe(true);
  });

  it('marks every candidate as NEEDS_BINDING when the document delegates clicks', async () => {
    const { record, requestsDuringDiscovery } = await discover(DISCOVERY_FIXTURE_PATHS.jsDelegated);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(record.candidates.map(({ formMethod, classification, reasonCode, jsBinding }) => [formMethod, classification, reasonCode, jsBinding.document]))
      .toEqual([['GET', 'NEEDS_BINDING', 'JS_DELEGATED', ['click']], ['POST', 'NEEDS_BINDING', 'JS_DELEGATED', ['click']]]);
  });

  it('finds no candidate on the list and detail pages, and reads them completely', async () => {
    for (const path of [DISCOVERY_FIXTURE_PATHS.list, DISCOVERY_FIXTURE_PATHS.detail]) {
      const { record, requestsDuringDiscovery } = await discover(path);
      expect(requestsDuringDiscovery).toEqual([]);
      expect(record).toEqual({ location: { origin: fixture.origin, path }, incompleteReasons: [], candidates: [] });
    }
  });

  it('waits for a SPA that renders its form after a GET response', async () => {
    // ページ自身の GET（応答はサーバが遅らせる）がサーバに届いてから、発見を始める（発見の間に届く要求を、ページ自身のものと分けるため）。
    const apiRequests = (): number => fixture.requests.filter(({ path }) => path === DISCOVERY_FIXTURE_PATHS.apiItems).length;
    const before = apiRequests();
    const { record, requestsDuringDiscovery } = await discover(DISCOVERY_FIXTURE_PATHS.spa, async () => {
      await expect.poll(apiRequests).toBe(before + 1);
    });
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(record.incompleteReasons).toEqual([]);
    expect(record.candidates.map(({ classification, fields }) => [classification, fields.map(({ name }) => name)])).toEqual([['READ', ['q']]]);
  });

  it('records a page that does not settle within the limit as incomplete (INCOMPLETE_SETTLE_TIMEOUT)', async () => {
    const { record, requestsDuringDiscovery, elapsedMs } = await discover(DISCOVERY_FIXTURE_PATHS.spaUnstable);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(elapsedMs).toBeGreaterThanOrEqual(DISCOVERY_SETTLE_TIMEOUT_MS);
    expect(record.incompleteReasons).toEqual(['INCOMPLETE_SETTLE_TIMEOUT']);
    expect(record.candidates.length).toBeGreaterThan(0);
  }, UNSTABLE_TEST_TIMEOUT_MS);

  it('reads readonly, disabled (fieldset), hidden, select, checkbox, file fields and the submit button overrides', async () => {
    const { record, requestsDuringDiscovery } = await discover(DISCOVERY_FIXTURE_PATHS.controls);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(record.incompleteReasons).toEqual([]);
    const [preview, save] = record.candidates;
    expect(record.candidates.map(({ kind, submitterWords, classification, reasonCode }) => [kind, submitterWords, classification, reasonCode])).toEqual([
      // T27R-fix-1（DEF-086）: 文言（プレビュー、保存、戻す、ボタン）は持たず、分類の語だけを持つ。
      ['FORM', [], 'READ', 'READ_GET_FORM'],
      ['FORM', ['保存'], 'UPDATE', 'UPDATE_WORD'],
      // T27b round 1: form の中の、送信ボタンでないボタン（リセットと普通のボタン）も、実行できない `BUTTON` の候補にする。
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
    ]);
    expect(preview).toMatchObject({
      kind: 'FORM',
      formMethod: 'GET',
      action: { origin: fixture.origin, path: '/preview', queryNames: ['mode', 'lang'] },
      enctype: 'text/plain',
      target: 'preview',
      submitterWords: [],
      hasStateField: true,
    });
    expect(save).toMatchObject({
      kind: 'FORM',
      formMethod: 'POST',
      action: { origin: fixture.origin, path: '/settings', queryNames: [] },
      enctype: 'multipart/form-data',
      target: '_self',
      submitterWords: ['保存'],
      classification: 'UPDATE',
      reasonCode: 'UPDATE_WORD',
    });
    expect(save?.fields.map(({ name, type }) => [name, type])).toEqual([
      ['csrf', 'hidden'], ['secret_hidden', 'hidden'], ['title', 'text'], ['locked', 'text'], ['invisible', 'text'], ['count', 'number'],
      ['mail', 'email'], ['upload', 'file'], ['many', 'select-one'], ['multi', 'select-multiple'], ['active', 'checkbox'],
      ['body', 'textarea'], ['weird', 'text'], ['', 'text'],
    ]);
    expect(byName(save, 'csrf')).toMatchObject({ hidden: true, hasValue: true });
    expect(byName(save, 'title')).toMatchObject({ readonly: true, disabled: false, hidden: false, hasValue: true });
    expect(byName(save, 'locked')).toMatchObject({ readonly: false, disabled: true, hidden: false, hasValue: true });
    expect(byName(save, 'invisible')).toMatchObject({ hidden: true, hasValue: false });
    expect(byName(save, 'count')?.constraints).toEqual({ ...NO_CONSTRAINTS, min: '1', max: '10', step: '1' });
    expect(byName(save, 'mail')?.constraints).toEqual({ ...NO_CONSTRAINTS, minlength: '3', autocomplete: 'email' });
    expect(byName(save, 'upload')).toMatchObject({ hasValue: false, options: null });
    const many = byName(save, 'many');
    expect(many?.options).toHaveLength(MAX_SELECT_OPTION_VALUES);
    expect(many?.options?.[0]).toBe('o0');
    expect(many?.omittedOptionCount).toBe(MANY_OPTIONS_COUNT - MAX_SELECT_OPTION_VALUES);
    expect(byName(save, 'multi')).toMatchObject({ options: ['x'], hasValue: true });
    expect(byName(save, 'active')).toMatchObject({ options: ['yes'], hasValue: false });
    expect(byName(save, 'body')).toMatchObject({ hasValue: true });
    // 送信ボタンとリセット・普通のボタンは、欄に含めない。
    expect(save?.fields.some(({ name }) => name === 'op')).toBe(false);
  });

  it('reads a form inside an open shadow root', async () => {
    const { record, requestsDuringDiscovery } = await discover(DISCOVERY_FIXTURE_PATHS.shadowOpen);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(record.incompleteReasons).toEqual([]);
    expect(record.candidates.map(({ classification, fields }) => [classification, fields.map(({ name }) => name)])).toEqual([['READ', ['q']]]);
  });

  it('records pages with a closed shadow root or an iframe as incomplete, and still reads the rest', async () => {
    for (const path of [DISCOVERY_FIXTURE_PATHS.shadowClosed, DISCOVERY_FIXTURE_PATHS.iframe]) {
      const { record, requestsDuringDiscovery } = await discover(path);
      expect(requestsDuringDiscovery, path).toEqual([]);
      expectSafeRecord(record);
      expect(record.incompleteReasons, path).toEqual(['INCOMPLETE_FRAME_OR_CLOSED_SHADOW']);
      expect(record.candidates.map(({ formMethod, classification }) => [formMethod, classification]), path).toEqual([['GET', 'READ']]);
    }
  });

  it('is not misled by DOM clobbering on the form and on the document', async () => {
    const { record, requestsDuringDiscovery } = await discover(DISCOVERY_FIXTURE_PATHS.clobber);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(record.incompleteReasons).toEqual([]);
    expect(record.candidates).toHaveLength(2);
    const [named, clobbered] = record.candidates;
    expect(named).toMatchObject({ formMethod: 'GET', action: { path: DISCOVERY_FIXTURE_PATHS.clobber }, fields: [], submitterWords: [] });
    expect(clobbered).toMatchObject({
      formMethod: 'POST',
      action: { origin: fixture.origin, path: '/clobbered', queryNames: [] },
      enctype: 'application/x-www-form-urlencoded',
      target: '',
      submitterWords: ['登録'],
      classification: 'CREATE',
    });
    expect(clobbered?.fields.map(({ name }) => name)).toEqual([
      'action', 'method', 'elements', 'attributes', 'getAttribute', 'hasAttribute', 'enctype', 'target', 'children', 'localName', 'nodeType',
      'parentNode', 'submit', 'id',
    ]);
  });

  it('lets the Guard block and record the beacon and fetch POSTs of the page itself (the server never receives them)', async () => {
    const { record, requestsDuringDiscovery, ledger } = await discover(DISCOVERY_FIXTURE_PATHS.beacon);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(record.candidates.map(({ classification }) => classification)).toEqual(['READ']);
    expect(fixture.requests.filter(({ path }) => path === DISCOVERY_FIXTURE_PATHS.collect)).toEqual([]);
    const snapshot = ledger.snapshot();
    expect(snapshot.blockedRequests.filter(({ method }) => method === 'POST').length).toBeGreaterThan(0);
    expect(snapshot.invariantViolations).toEqual([]);
  });

  it('freezes the page before reading, so that the scripts of the page cannot send anything afterwards', async () => {
    const { record, requestsDuringDiscovery, page, ledger } = await discover(DISCOVERY_FIXTURE_PATHS.sender);
    expect(requestsDuringDiscovery).toEqual([]);
    expect(record.candidates).toHaveLength(1);
    const start = fixture.requests.length;
    await page.evaluate((collect) => {
      navigator.sendBeacon(collect, 'after-freeze');
      void fetch(collect, { method: 'POST', body: 'after-freeze' }).catch(() => undefined);
      void fetch(`${collect}?get=after-freeze`).catch(() => undefined);
      const image = new Image();
      image.src = `${collect}?image=after-freeze`;
      const form = document.getElementById('send');
      if (form instanceof HTMLFormElement) {
        HTMLFormElement.prototype.submit.call(form);
      }
    }, DISCOVERY_FIXTURE_PATHS.collect).catch(() => undefined);
    await wait(QUIET_PERIOD_MS);
    expect(fixture.requests.slice(start)).toEqual([]);
    const snapshot = ledger.snapshot();
    expect(snapshot.blockedInteractionRequests.length + snapshot.blockedInteractionNavigations.length).toBeGreaterThan(0);
  });

  it('does not read a page whose context has another page (the freeze conditions do not hold)', async () => {
    const { page, context, counter, factory } = await open(DISCOVERY_FIXTURE_PATHS.search);
    await factory.createPassivePage(context);
    const start = fixture.requests.length;
    const record = await discoverPageCandidates(page, {
      classificationPolicy: { allowedOrigins: new Set([fixture.origin]) },
      requestCounter: counter,
    });
    counter.dispose();
    await wait(QUIET_PERIOD_MS);
    expect(fixture.requests.slice(start)).toEqual([]);
    expect(record).toEqual({
      location: { origin: fixture.origin, path: DISCOVERY_FIXTURE_PATHS.search },
      incompleteReasons: ['INCOMPLETE_FREEZE_UNAVAILABLE'],
      candidates: [],
    });
    // 凍結を呼ばないので、Guard は無効にならない。
    expect(() => assertPassiveRequestGuardActive(context)).not.toThrow();
  });

  // DEF-087: probe と構造の読み取りは、CDP の isolated world で動く（ページの JS が、標準の getter とメソッドの結果を偽れない）。
  it.each([
    ['Function.prototype.call', DISCOVERY_FIXTURE_PATHS.forgedCall],
    ['the prototype getters', DISCOVERY_FIXTURE_PATHS.forgedPrototype],
    ['Function.prototype.call, in an open shadow root', DISCOVERY_FIXTURE_PATHS.forgedShadow],
  ])('keeps the delete form DESTRUCTIVE when the page forges the standard getters by %s (DEF-087)', async (_forgery, path) => {
    const { record, requestsDuringDiscovery, page } = await discover(path);
    expect(requestsDuringDiscovery).toEqual([]);
    expect(record.incompleteReasons).toEqual([]);
    expect(record.candidates.map(({ formMethod, methodOverride, action, classification, reasonCode }) =>
      [formMethod, methodOverride, action?.path, classification, reasonCode])).toEqual([['POST', 'DELETE', '/items/1', 'NOT_EXECUTABLE', 'DESTRUCTIVE']]);
    // 偽りは、main world では効いている（fixture が壊れていて GREEN になったのではない）。
    const forgedMethod = await page.evaluate(() => {
      const form = document.getElementById('del') ?? document.getElementById('host')?.shadowRoot?.getElementById('del');
      return Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'method')?.get?.call(form);
    });
    expect(forgedMethod).toBe('get');
  });

  it('reads the structure of a READ result honestly when the page forges the collection length and innerText (DEF-087)', async () => {
    const { page, counter } = await open(DISCOVERY_FIXTURE_PATHS.forgedStructure);
    const read = await readSettledPageStructure(page, counter);
    counter.dispose();
    expect(read).toMatchObject({
      status: 'READ',
      structure: {
        region: 'MAIN', tableRowCounts: [3], listItemCounts: [2], detailEntries: [{ term: '状態', value: '有効' }], text: 'h 1 2 3 a b 状態 有効',
      },
    });
    // 偽りは、main world では効いている。
    const forgedLength = await page.evaluate(() =>
      Object.getOwnPropertyDescriptor(HTMLCollection.prototype, 'length')?.get?.call(document.querySelector('ul')?.children));
    expect(forgedLength).toBe(1);
  });

  it('does not run the page JS while discovering and reading the structure (DEF-087)', async () => {
    const { page, counter } = await open(DISCOVERY_FIXTURE_PATHS.countingHooks);
    const before = await readPageHits(page);
    expect(Number.isSafeInteger(before)).toBe(true);
    const record = await discoverPageCandidates(page, {
      classificationPolicy: { allowedOrigins: new Set([fixture.origin]) },
      requestCounter: counter,
    });
    expect(record.incompleteReasons).toEqual([]);
    expect(record.candidates.map(({ kind, formMethod, methodOverride }) => [kind, formMethod, methodOverride])).toEqual([
      ['FORM', 'POST', 'DELETE'],
      ['BUTTON', null, null],
    ]);
    expect(record.candidates[0]?.classification).toBe('NOT_EXECUTABLE');
    expect(await readPageHits(page)).toBe(before);
    const read = await readSettledPageStructure(page, counter);
    counter.dispose();
    expect(read).toMatchObject({ status: 'READ', structure: { tableRowCounts: [3], listItemCounts: [2] } });
    expect(await readPageHits(page)).toBe(before);
    // 数える仕掛けは、main world の読み取りでは数える（仕掛けが効いている）。
    await page.evaluate(() => document.documentElement.localName);
    expect(await readPageHits(page)).toBeGreaterThan(before);
  });

  it('fails to read (fail-closed) when the isolated world is gone because the page was loaded again (DEF-087)', async () => {
    const { page, context, counter } = await open(DISCOVERY_FIXTURE_PATHS.search);
    counter.dispose();
    const openSession = context.newCDPSession.bind(context);
    let reloads = 0;
    const spy = vi.spyOn(context, 'newCDPSession').mockImplementation(async (target) => {
      const session = await openSession(target);
      // world を作った直後に、ページを読み込み直す（作った world の id は古くなる）。
      const send: CDPSession['send'] = async (method, params) => {
        const result = await session.send(method, params);
        if (method === 'Page.createIsolatedWorld') {
          reloads += 1;
          await page.reload();
        }
        return result;
      };
      return new Proxy(session, { get: (object, key) => (key === 'send' ? send : Reflect.get(object, key) as unknown) });
    });
    try {
      expect(await probePageCandidates(page, Date.now() + DISCOVERY_READ_TIMEOUT_MS)).toEqual({ status: 'FAILED' });
      expect(await readPageStructure(page, Date.now() + DISCOVERY_READ_TIMEOUT_MS)).toEqual({ status: 'FAILED' });
    } finally {
      spy.mockRestore();
    }
    expect(reloads).toBe(2);
  });

  it('fails to read (fail-closed) by the deadline while the page is busy (DEF-087)', async () => {
    const { page, counter } = await open(DISCOVERY_FIXTURE_PATHS.search);
    counter.dispose();
    await page.evaluate((busyMs) => {
      setTimeout(() => {
        const end = Date.now() + busyMs;
        while (Date.now() < end) {
          // ページの主の thread を占める（読み取りの関数は動けない）。
        }
      }, 0);
    }, BUSY_PAGE_MS);
    await wait(BUSY_START_WAIT_MS);
    const startedAt = Date.now();
    expect(await probePageCandidates(page, startedAt + BUSY_READ_DEADLINE_MS)).toEqual({ status: 'FAILED' });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(BUSY_PAGE_MS - BUSY_START_WAIT_MS);
    // 後片付けの前に、ページが空くのを待つ。
    await wait(BUSY_PAGE_MS - BUSY_START_WAIT_MS - elapsedMs);
  });
});

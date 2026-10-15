// DEF-114（T32j-4。Task 32 の設計書 4.4 の「CC-068 の設計」の 2）: 書き込みの段の「同じ要素か」の確かめ（`write-form-submitter.ts` の確かめ直し）
// を、ページの JS が偽れないこと。最初の確かめの後に、form を同じ形の写し（`cloneNode`）に差し替えると、位置と形は同じでも要素は別なので、
// 押す直前の確かめ直しが `FORM_CHANGED` で止まる（承認の POST はサーバに届かない）。ページの JS が、Playwright の main world の部品が
// 使いうる組み込み（`Object.prototype` の getter など）を書き換えても、同じ結果になる。
// - 修正の前（main world の `(a, b) => a === b`）は、`Object.prototype.v` の getter で、別の要素を「同じ」と見せられた（DEF-114 の RED）。
// - 修正の後は、isolated world で読んだ backendNodeId を比べる（ページの JS は読む間に走らない）。
// 本物の Guard（書き込みの段）と、127.0.0.1 の fixture のサーバ（`tests/helpers/write-fixture-server.ts` の `richForm`）。Chromium は headless
// だけ（テストの既定と、CLI の起動の設定の両方）。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  fillWriteForm,
  inspectWriteForm,
  submitWriteForm,
  writeFormFieldListsOf,
  type WriteFormFieldSpec,
  type WriteFormSpec,
} from '../../src/browser/write-form-submitter.js';
import { wait } from '../../src/core/deadline.js';
import { compareCodeUnits } from '../../src/core/text.js';
import {
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  installPassiveRequestGuard,
  WriteStageMonitor,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { QUIET_PERIOD_MS } from '../helpers/gate-harness.js';
import { startWriteSubmissionProxy, type WriteSubmissionProxy } from '../helpers/write-submission-proxy.js';
import { WRITE_FIXTURE_PATHS, startWriteFixtureServer, type WriteFixturePostBody, type WriteFixtureServer } from '../helpers/write-fixture-server.js';

const VIEWPORT = Object.freeze({ width: 900, height: 700 });
const ROUND_TIMEOUT_MS = 60_000;
/** 全部の回の後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 2_000;

const LAUNCHES = [
  { name: 'the headless shell (test default)', launch: (): Promise<Browser> => launchHeadlessChromium() },
  { name: 'the CLI Chromium (launchCliChromium, headless)', launch: (): Promise<Browser> => launchCliChromium() },
] as const;

const field = (name: string, type: WriteFormFieldSpec['type'], flags: Partial<Pick<WriteFormFieldSpec, 'readonly' | 'hidden'>> = {}): WriteFormFieldSpec =>
  ({ name, type, readonly: false, hidden: false, disabled: false, ...flags });

/** fixture の `richForm` の欄（承認した候補の欄の代わり。`write-form-submitter.test.ts` と同じ形）。 */
const RICH_FIELDS: readonly WriteFormFieldSpec[] = [
  field('csrf_token', 'hidden', { hidden: true }),
  field('customer_name', 'text'),
  field('memo', 'textarea'),
  field('serial', 'text', { readonly: true }),
  field('plan', 'select-one'),
  field('agree', 'checkbox'),
  field('contact', 'radio'),
  field('contact', 'radio'),
  field('att', 'file'),
];
const SUBMITTED_NAMES = ['customer_name', 'memo', 'plan', 'agree', 'contact'] as const;
const GENERATED_VALUES: Readonly<Record<string, string | null>> = Object.freeze({
  customer_name: 'same element',
  memo: 'memo',
  plan: 'b',
  agree: 'yes',
  contact: 'phone',
});

/**
 * ページの JS の偽り（読み込みの後に入れる）。Playwright の main world の部品が戻り値を直列化するときに読みうる名前（`v`）を、
 * `Object.prototype` の getter で `'true'` にする（DEF-114 の調査の形）。偽りが働いた回数は `window.__forgeHits`。
 */
const FORGE_SAME_ELEMENT = (): void => {
  const scope = window as unknown as Record<string, number>;
  scope['__forgeHits'] = 0;
  Object.defineProperty(Object.prototype, 'v', {
    configurable: true,
    get() {
      scope['__forgeHits'] = (scope['__forgeHits'] ?? 0) + 1;
      return 'true';
    },
  });
};

/** form を、同じ形の写しに差し替える（入れた値は写しに引き継がれる。位置と形は同じで、要素は別）。 */
const REPLACE_FORM_WITH_CLONE = (): void => {
  const form = document.getElementById('f');
  if (form === null) throw new Error('Missing form');
  form.replaceWith(form.cloneNode(true));
};

/** 入れ替えを続けるページの確かめの回数と、その時間の上限（ms）。 */
const SWAP_WRITE_ROUNDS = 10;
const SWAP_WRITE_TIMEOUT_MS = 300_000;
/** 入れ替えの間隔の上限（ms。0 から、この値の手前までの乱数）。 */
const SWAP_INTERVAL_LIMIT_MS = 40;

/**
 * ページの JS: 欄 `customer_name` と送信ボタン `#go`（A）を、同じ位置の写し（B）と、0〜`intervalLimitMs` の乱数の間隔で入れ替え続ける。A と B に届いた
 * input と click を、Node の側の記録（`SWAP_EVENT_BINDING` の binding）に送る（送信で画面が移っても、Guard が送信を止めても数えられる）。
 */
const SWAP_FIELD_AND_BUTTON = ({ intervalLimitMs, binding }: { readonly intervalLimitMs: number; readonly binding: string }): void => {
  const record = (window as unknown as Record<string, (which: string, kind: string) => Promise<void>>)[binding];
  if (typeof record !== 'function') throw new Error('Missing the swap event binding');
  const pairs = ['customer_name', 'go'].map((id) => {
    const a = document.getElementById(id);
    if (a === null) throw new Error(`Missing ${id}`);
    const b = a.cloneNode(true) as HTMLElement;
    for (const [element, which] of [[a, 'A'], [b, 'B']] as const) {
      element.addEventListener('input', () => { void record(which, 'input'); });
      element.addEventListener('click', () => { void record(which, 'click'); });
    }
    return [a, b] as const;
  });
  let flip = false;
  const tick = (): void => {
    for (const [a, b] of pairs) {
      (flip ? b : a).replaceWith(flip ? a : b);
    }
    flip = !flip;
    setTimeout(tick, Math.floor(Math.random() * intervalLimitMs));
  };
  setTimeout(tick, 0);
};

/** 入れ替えを続けるページが、A と B に届いた事象を Node の側へ送る binding の名前。 */
const SWAP_EVENT_BINDING = '__recordSwapEvent';
/** focus を移すページの確かめの回数。 */
const FOCUS_REDIRECT_ROUNDS = 3;

/**
 * T32R2 の I-1 の形: 欄 A（`customer_name`）に focus が来たら、form の外の囮の form の欄 B へ focus を移し、B に入った値を A に写す（入れた後の
 * 読み直しを通すため）。Playwright の `fill` は、A に focus を当ててから focus のある要素に文字を打つので、生成した値は B にも入る。B に入った
 * input を、Node の側の記録（binding）に送る。
 */
const FOCUS_REDIRECT = ({ otherPath, binding }: { readonly otherPath: string; readonly binding: string }): void => {
  const record = (window as unknown as Record<string, (which: string, kind: string) => Promise<void>>)[binding];
  if (typeof record !== 'function') throw new Error('Missing the swap event binding');
  const decoyForm = document.createElement('form');
  decoyForm.method = 'post';
  decoyForm.action = otherPath;
  const decoy = document.createElement('input');
  decoy.name = 'customer_name';
  decoyForm.append(decoy);
  document.body.append(decoyForm);
  const field = document.getElementById('customer_name') as HTMLInputElement;
  field.addEventListener('focus', () => { decoy.focus(); });
  decoy.addEventListener('input', () => { field.value = decoy.value; void record('B', 'input'); });
};

/** 本文の名前と値の組を、名前（UTF-16 のコード単位）の順に並べる比べ方。 */
const byFieldName = (left: readonly [string, string], right: readonly [string, string]): number => compareCodeUnits(left[0], right[0]);

describe.each(LAUNCHES)('DEF-114: the same-element check of the write stage, with $name', ({ launch }) => {
  let browser: Browser;
  let server: WriteFixtureServer;
  let submissionProxy: WriteSubmissionProxy;
  const contexts: BrowserContext[] = [];

  beforeAll(async () => {
    browser = await launch();
    server = await startWriteFixtureServer();
    submissionProxy = await startWriteSubmissionProxy();
  });
  afterAll(async () => {
    await submissionProxy?.close();
    await server?.close();
    await browser?.close();
  });
  afterEach(async () => {
    for (const context of contexts.splice(0)) {
      await closePassiveGuardedContext(context).catch(() => context.close().catch(() => undefined));
    }
  });

  const spec = (): WriteFormSpec => ({
    endpoint: { origin: server.originA, path: WRITE_FIXTURE_PATHS.create },
    enctype: 'application/x-www-form-urlencoded',
    candidateFields: RICH_FIELDS,
    submittedFieldNames: [...SUBMITTED_NAMES],
    methodOverride: null,
  });

  /**
   * 承認の期待の、本文の全体（名前と値の組。名前の順に並べる）: 送る欄の生成した値、CSRF の hidden と readonly の欄の値（ページの値のまま）、
   * 空の file の欄（urlencoded では空の値）。届いた POST の本文は、これと全体で一致しなければならない。
   */
  const approvedBodyEntries = (): readonly (readonly [string, string])[] => {
    const entries: (readonly [string, string])[] = [
      ['csrf_token', server.csrfMarker],
      ['serial', server.readonlyMarker],
      ['att', ''],
      ...Object.entries(GENERATED_VALUES).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ];
    return entries.sort(byFieldName);
  };
  /** 届いた POST の、送信先と本文の全体（名前の順に並べた、名前と値の組）。 */
  const receivedPostOf = (post: WriteFixturePostBody) => ({
    path: post.path,
    entries: [...new URLSearchParams(post.body.toString('ascii'))].sort(byFieldName),
  });

  /** 書き込みの段の Guard の付いた page（承認の形と、生成した値の照合の指定。`write-form-submitter.test.ts` と同じ形）。 */
  const openWriteStage = async (writeSpec: WriteFormSpec): Promise<{ readonly page: Page; readonly monitor: WriteStageMonitor; readonly ledger: SafetyLedger }> => {
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block', acceptDownloads: false });
    contexts.push(context);
    const monitor = new WriteStageMonitor();
    const lists = writeFormFieldListsOf(writeSpec);
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(context, ledger, new Set([server.originA]), {
      writeStage: {
        expectation: {
          request: { ...writeSpec.endpoint, enctype: writeSpec.enctype },
          submittedFields: Object.entries(GENERATED_VALUES)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            .map(([name, value]) => ({ name, value })),
          passthroughFieldNames: lists.passthroughFieldNames,
          emptyFileFieldNames: lists.emptyFileFieldNames,
          methodOverride: lists.methodOverride,
          absentFieldNames: lists.absentFieldNames,
          checkedPassthroughFields: lists.checkedPassthroughFieldNames.map((name) => ({ name, value: name === 'serial' ? server.readonlyMarker : '' })),
        },
        monitor,
      },
      writeSubmission: submissionProxy.options,
    });
    const page = await context.newPage();
    await awaitPassiveRequestGuardReady(page);
    return { page, monitor, ledger };
  };

  it.each([
    ['without page JS forgery', false],
    ['with the Object.prototype getter forgery', true],
  ] as const)('stops with FORM_CHANGED when the form is replaced by a clone after the fill (%s)', async (_label, forge) => {
    const writeSpec = spec();
    const { page, monitor } = await openWriteStage(writeSpec);
    await page.goto(server.richFormUrl('plain'));
    const postsBefore = server.postBodies.length;
    const inspection = await inspectWriteForm(page, writeSpec);
    if (!inspection.ok) throw new Error(`inspection failed: ${inspection.reason}`);
    await expect(fillWriteForm(page, inspection.form, GENERATED_VALUES, monitor)).resolves.toEqual({ ok: true });
    await page.evaluate(REPLACE_FORM_WITH_CLONE);
    if (forge) {
      await page.evaluate(FORGE_SAME_ELEMENT);
    }
    await expect(submitWriteForm(page, inspection.form, GENERATED_VALUES)).resolves.toEqual({ ok: false, reason: 'FORM_CHANGED', clickAttempted: false });
    await wait(QUIET_PERIOD_MS);
    expect(server.postBodies.length).toBe(postsBefore);
  }, ROUND_TIMEOUT_MS);

  it.each([
    ['without page JS forgery', false],
    ['with the Object.prototype getter forgery', true],
  ] as const)('stops with FORM_CHANGED before the fill when the form is replaced by a clone after the inspection (%s)', async (_label, forge) => {
    const writeSpec = spec();
    const { page, monitor } = await openWriteStage(writeSpec);
    await page.goto(server.richFormUrl('plain'));
    const postsBefore = server.postBodies.length;
    const inspection = await inspectWriteForm(page, writeSpec);
    if (!inspection.ok) throw new Error(`inspection failed: ${inspection.reason}`);
    await page.evaluate(REPLACE_FORM_WITH_CLONE);
    if (forge) {
      await page.evaluate(FORGE_SAME_ELEMENT);
    }
    await expect(fillWriteForm(page, inspection.form, GENERATED_VALUES, monitor)).resolves.toEqual({ ok: false, reason: 'FORM_CHANGED' });
    await wait(QUIET_PERIOD_MS);
    expect(server.postBodies.length).toBe(postsBefore);
  }, ROUND_TIMEOUT_MS);

  // T32R-fix-I1（独立レビュー T32R の I-1）: ページの JS が、欄（`customer_name`）と送信ボタン（`#go`）を、同じ位置の写し B とタイマーで
  // 入れ替え続けても、入力と click の的は確かめの時の要素 A で、同じ位置の写し B は的にならない（操作のたびに、合図つきの Locator で、位置の
  // 要素が確かめの時の要素かを照らす）。止まる理由は `FORM_CHANGED`・`INPUT_FAILED`・`VALUE_NOT_APPLIED` など（どれも止める側）。
  // T32R2 の M-1: A と B に届いた事象は Node の側に記録する（送信で画面が移っても、Guard が送信を止めても数える）。A が押されて送られた回は、
  // 承認の期待の全体と一致する本文の POST だけが届く。届いた POST は、A を押した回より多くない。
  it('aims every input and click at the inspected element, never at the swapped copy at the same position', async () => {
    const writeSpec = spec();
    const counts = { A: { input: 0, click: 0 }, B: { input: 0, click: 0 } };
    const postsBefore = server.postBodies.length;
    for (let round = 0; round < SWAP_WRITE_ROUNDS; round += 1) {
      const { page, monitor } = await openWriteStage(writeSpec);
      await page.exposeBinding(SWAP_EVENT_BINDING, (_source, which: 'A' | 'B', kind: 'input' | 'click') => {
        counts[which][kind] += 1;
      });
      await page.goto(server.richFormUrl('plain'));
      const inspection = await inspectWriteForm(page, writeSpec);
      if (!inspection.ok) throw new Error(`inspection failed: ${inspection.reason}`);
      await page.evaluate(SWAP_FIELD_AND_BUTTON, { intervalLimitMs: SWAP_INTERVAL_LIMIT_MS, binding: SWAP_EVENT_BINDING });
      const filled = await fillWriteForm(page, inspection.form, GENERATED_VALUES, monitor);
      if (filled.ok) {
        await submitWriteForm(page, inspection.form, GENERATED_VALUES);
      }
      await wait(QUIET_PERIOD_MS);
    }
    expect(counts.B).toEqual({ input: 0, click: 0 });
    const arrived = server.postBodies.slice(postsBefore).map(receivedPostOf);
    expect(arrived.length).toBeLessThanOrEqual(counts.A.click);
    for (const post of arrived) {
      expect(post).toEqual({ path: WRITE_FIXTURE_PATHS.create, entries: approvedBodyEntries() });
    }
  }, SWAP_WRITE_TIMEOUT_MS);

  // T32R2 の I-1: 操作の的の要素は照らすが、キーボードの入力は focus のある要素に入り、ページのスクリプトは focus を移せる（`fill` の値が、
  // form の外の囮 B に入る）。それでも、入れた後の値の読み直しと Guard の照合が守るので、承認の外の POST は届かず（届く POST は承認の期待の
  // 全体と一致する本文だけ）、違反は 0。
  it('lets the page move the focus during the fill, and still lets only the approved POST through (the typed value may reach the focused decoy)', async () => {
    const writeSpec = spec();
    const counts = { A: { input: 0, click: 0 }, B: { input: 0, click: 0 } };
    const postsBefore = server.postBodies.length;
    const violations: string[] = [];
    for (let round = 0; round < FOCUS_REDIRECT_ROUNDS; round += 1) {
      const { page, monitor, ledger } = await openWriteStage(writeSpec);
      await page.exposeBinding(SWAP_EVENT_BINDING, (_source, which: 'A' | 'B', kind: 'input' | 'click') => {
        counts[which][kind] += 1;
      });
      await page.goto(server.richFormUrl('plain'));
      const inspection = await inspectWriteForm(page, writeSpec);
      if (!inspection.ok) throw new Error(`inspection failed: ${inspection.reason}`);
      await page.evaluate(FOCUS_REDIRECT, { otherPath: WRITE_FIXTURE_PATHS.otherPath, binding: SWAP_EVENT_BINDING });
      const filled = await fillWriteForm(page, inspection.form, GENERATED_VALUES, monitor);
      if (filled.ok) {
        await submitWriteForm(page, inspection.form, GENERATED_VALUES);
      }
      await wait(QUIET_PERIOD_MS);
      violations.push(...ledger.snapshot().invariantViolations.map(({ code }) => code));
    }
    await wait(LATE_DELIVERY_SETTLE_MS);
    const arrived = server.postBodies.slice(postsBefore).map(receivedPostOf);
    // 偽りが働いた（生成した値が囮に入った）ことと、送信まで進んだこと（照らす条件を空で通していない）の確かめ。
    expect(counts.B.input).toBeGreaterThan(0);
    expect(arrived.length).toBeGreaterThan(0);
    for (const post of arrived) {
      expect(post).toEqual({ path: WRITE_FIXTURE_PATHS.create, entries: approvedBodyEntries() });
    }
    expect(violations).toEqual([]);
  }, SWAP_WRITE_TIMEOUT_MS);

  it('after all the rounds, no POST arrives late', async () => {
    const posts = server.postBodies.length;
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(server.postBodies.length).toBe(posts);
  }, ROUND_TIMEOUT_MS);
});

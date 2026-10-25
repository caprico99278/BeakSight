// T31g-1（Task 31 の設計書 3 章の「更新の前の読み取り」「欄の役割」「値の照らし方」「削除にあたる変更の遮断」「同じ名前の hidden と checkbox の
// 組」）: 書き込みのフォームの入力と読み取りの owner（`src/browser/write-form-submitter.ts`）の UPDATE の口。本物の Guard（書き込みの段）と、
// 127.0.0.1 の fixture のサーバ（`tests/helpers/update-form-fixture-server.ts`）で確かめる。Chromium は headless だけ（テストの既定と、CLI の
// 起動の設定の両方）。
// - 前の値の読み取り（`readUpdateFormValues`）: 変える欄と保つ欄の今の値、状態の名前の hidden の値、組の hidden の値だけを返し、CSRF の
//   hidden・`lock_version` の値を返さない。組の hidden と checkbox が DOM で隣り合わなければ読まない。
// - 期待の作り手（`updatePayloadFieldsOf`）で作った期待を本物の Guard の照合に通し、入力（`inspectUpdateForm`・`fillWriteForm`・
//   `submitWriteForm`）で、承認の形の更新の POST が urlencoded・multipart のそれぞれで 1 回だけ届く（保つ欄は前の値、変える欄は新しい値）。
// - 送信の前にページの JS が、保つ欄の値・状態の hidden・組の hidden を書き換える、組の checkbox を外す、`_method` を `DELETE` にする、保つ
//   select・radio を変える、ないはずの checkbox をチェックする、のどれでも POST は届かない。
// - 書き込みの段の画面の値が前の値と違う回は、入力の前の確かめで止まる（送らない）。
// - サーバの記録で回ごとに数え、全部の回の後に `LATE_DELIVERY_SETTLE_MS` だけ待ってもう一度数える。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  fillWriteForm,
  type UpdatePayloadFieldsResult,
  inspectUpdateForm,
  readUpdateFormValues,
  submitWriteForm,
  updatePayloadFieldsOf,
  type UpdateFormValues,
  type WriteFormFieldSpec,
  type WriteFormReason,
  type WriteUpdateFormSpec,
} from '../../src/browser/write-form-submitter.js';
import { wait } from '../../src/core/deadline.js';
import {
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  installPassiveRequestGuard,
  WriteStageMonitor,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import type { WriteFormEnctype } from '../../src/safety/write-payload-policy.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { QUIET_PERIOD_MS } from '../helpers/gate-harness.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import {
  UPDATE_FORM_PATHS,
  UPDATE_FORM_VALUES,
  startUpdateFormFixtureServer,
  type UpdateFormFixtureEnctype,
  type UpdateFormFixtureRequest,
  type UpdateFormFixtureServer,
  type UpdateFormFixtureVariant,
} from '../helpers/update-form-fixture-server.js';
import { startWriteSubmissionProxy, type WriteSubmissionProxy } from '../helpers/write-submission-proxy.js';

const VIEWPORT = Object.freeze({ width: 900, height: 700 });
const NAVIGATION_SETTLE_TIMEOUT_MS = 5_000;
/** 全部の回の後に、遅れて届く要求を見逃さないために待つ時間（ms。Task 30 の設計書 6 章の「2 秒」）。 */
const LATE_DELIVERY_SETTLE_MS = 2_000;
const ROUND_TIMEOUT_MS = 60_000;
/** 変える欄に入れる新しい値。 */
const NEW_NAME = '佐藤 花子';

const ENCTYPES: Readonly<Record<UpdateFormFixtureEnctype, WriteFormEnctype>> = Object.freeze({
  urlencoded: 'application/x-www-form-urlencoded',
  multipart: 'multipart/form-data',
});

const LAUNCHES = [
  { name: 'the headless shell (test default)', launch: (): Promise<Browser> => launchHeadlessChromium() },
  { name: 'the CLI Chromium (launchCliChromium, headless)', launch: (): Promise<Browser> => launchCliChromium() },
] as const;

const field = (name: string, type: WriteFormFieldSpec['type'], flags: Partial<Pick<WriteFormFieldSpec, 'readonly' | 'hidden' | 'disabled'>> = {}): WriteFormFieldSpec =>
  ({ name, type, readonly: false, hidden: false, disabled: false, ...flags });

/** fixture の更新の画面の欄（承認した候補の欄の代わり。DOM の順）。 */
const UPDATE_FIELDS: readonly WriteFormFieldSpec[] = [
  field('_method', 'hidden', { hidden: true }),
  field('authenticity_token', 'hidden', { hidden: true }),
  field('customer_name', 'text'),
  field('memo', 'textarea'),
  field('plan', 'select-one'),
  field('contact', 'radio'),
  field('contact', 'radio'),
  field('newsletter', 'checkbox'),
  field('notify', 'checkbox'),
  field('active', 'hidden', { hidden: true }),
  field('published', 'hidden', { hidden: true }),
  field('published', 'checkbox'),
  field('lock_version', 'hidden', { hidden: true }),
];

const KEPT_NAMES = ['memo', 'plan', 'contact', 'newsletter', 'notify', 'published'] as const;

/** 前の値（fixture の更新の画面の値）。T31R-fix-1（C-1）: 値を照らす hidden（`lock_version`）の前の値は、起動のたびの目印なので、下で足す。 */
const EXPECTED_PRIOR: Omit<UpdateFormValues, 'passthroughValues'> = {
  fields: {
    customer_name: UPDATE_FORM_VALUES.customerName,
    memo: UPDATE_FORM_VALUES.memo,
    plan: UPDATE_FORM_VALUES.plan,
    contact: UPDATE_FORM_VALUES.contact,
    newsletter: UPDATE_FORM_VALUES.newsletter,
    notify: null,
    published: UPDATE_FORM_VALUES.publishedOn,
  },
  stateHiddenValues: { active: UPDATE_FORM_VALUES.active },
  pairOffValues: { published: UPDATE_FORM_VALUES.publishedOff },
};

/** サーバに届いた POST。 */
const posts = (requests: readonly UpdateFormFixtureRequest[]): string[] => requests
  .filter((entry) => !READ_METHODS.has(entry.method))
  .map((entry) => `${entry.method} ${entry.path}`);

/** multipart の本文を、名前と値（UTF-8）に分ける（テストの補助）。 */
const multipartFields = (body: Buffer, contentType: string): Map<string, string[]> => {
  const boundary = /boundary=(.+)$/u.exec(contentType)?.[1] ?? '';
  const fields = new Map<string, string[]>();
  for (const part of body.toString('utf8').split(`--${boundary}`).slice(1, -1)) {
    const [header = '', ...rest] = part.replace(/^\r\n/u, '').split('\r\n\r\n');
    const name = /name="([^"]*)"/u.exec(header)?.[1] ?? '';
    fields.set(name, [...(fields.get(name) ?? []), rest.join('\r\n\r\n').replace(/\r\n$/u, '')]);
  }
  return fields;
};

const urlencodedFields = (body: Buffer): Map<string, string[]> => {
  const fields = new Map<string, string[]>();
  for (const [name, value] of new URLSearchParams(body.toString('ascii'))) {
    fields.set(name, [...(fields.get(name) ?? []), value]);
  }
  return fields;
};

/** 止める回（送信の前にページの JS が中身を変える形）。 */
const BLOCKED_VARIANTS: readonly { readonly round: string; readonly variant: UpdateFormFixtureVariant }[] = [
  { round: 'a kept value that the page rewrites', variant: 'js-kept' },
  { round: 'the state hidden that the page sets to 0', variant: 'js-state' },
  { round: 'the hidden of the pair that the page rewrites', variant: 'js-pair-hidden' },
  { round: 'the checkbox of the pair that the page unchecks', variant: 'js-pair-uncheck' },
  { round: '_method that the page sets to DELETE', variant: 'js-method-delete' },
  { round: 'a kept select that the page changes', variant: 'js-select' },
  { round: 'a kept radio that the page changes', variant: 'js-radio' },
  { round: 'an unchecked checkbox that the page checks', variant: 'js-absent' },
];

describe.each(LAUNCHES)('T31g-1: the update form reading and input, with $name', ({ name, launch }) => {
  let browser: Browser;
  let server: UpdateFormFixtureServer;
  let submissionProxy: WriteSubmissionProxy;
  const contexts: BrowserContext[] = [];
  /** これまでの回で、サーバに届いてよいと確かめた POST（承認の POST だけ）。 */
  const expectedPosts: string[] = [];
  /** 止めた証拠のあった回。 */
  const blockedRounds: string[] = [];

  beforeAll(async () => {
    browser = await launch();
    server = await startUpdateFormFixtureServer();
    submissionProxy = await startWriteSubmissionProxy();
  });

  afterAll(async () => {
    await submissionProxy?.close();
    await server?.close();
    await browser?.close();
  });

  afterEach(async () => {
    server.setDrift(false);
    for (const context of contexts.splice(0)) {
      await closePassiveGuardedContext(context).catch(() => context.close().catch(() => undefined));
    }
  });

  const specFor = (enctype: UpdateFormFixtureEnctype): WriteUpdateFormSpec => ({
    endpoint: { origin: server.origin, path: UPDATE_FORM_PATHS.record },
    enctype: ENCTYPES[enctype],
    candidateFields: UPDATE_FIELDS,
    methodOverride: 'PATCH',
    changedFieldNames: ['customer_name'],
    keptFieldNames: KEPT_NAMES,
  });

  /** 前の値を読む（Guard のない、読むだけの Context。ワーカーでは凍結した Context）。 */
  const readPrior = async (variant: UpdateFormFixtureVariant, enctype: UpdateFormFixtureEnctype = 'urlencoded', spec = specFor(enctype)) => {
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block', acceptDownloads: false });
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(server.formUrl(variant, enctype));
    return readUpdateFormValues(page, spec);
  };

  /** 前の値から期待を作り、本物の Guard を付けた Context で更新の画面を開いて、確かめ・入力・送信をする。 */
  const writeUpdate = async (
    variant: UpdateFormFixtureVariant,
    enctype: UpdateFormFixtureEnctype,
    prior: UpdateFormValues,
    spec = specFor(enctype),
  ): Promise<{
    readonly page: Page;
    readonly ledger: SafetyLedger;
    readonly monitor: WriteStageMonitor;
    readonly stoppedAt: WriteFormReason | null;
  }> => {
    const fields = updatePayloadFieldsOf(spec, prior, { customer_name: NEW_NAME });
    if (!fields.ok) {
      throw new Error(`the expectation was not built: ${fields.reason}`);
    }
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block', acceptDownloads: false });
    contexts.push(context);
    const ledger = new SafetyLedger();
    const monitor = new WriteStageMonitor();
    await installPassiveRequestGuard(context, ledger, new Set([server.origin]), {
      writeStage: { expectation: { request: { origin: server.origin, path: UPDATE_FORM_PATHS.record, enctype: ENCTYPES[enctype] }, ...fields.fields }, monitor },
      writeSubmission: submissionProxy.options,
    });
    const page = await context.newPage();
    await awaitPassiveRequestGuardReady(page);
    await page.goto(server.formUrl(variant, enctype));
    const inspection = await inspectUpdateForm(page, spec, prior);
    if (!inspection.ok) {
      return { page, ledger, monitor, stoppedAt: inspection.reason };
    }
    const filled = await fillWriteForm(page, inspection.form, { customer_name: NEW_NAME }, monitor);
    if (!filled.ok) {
      return { page, ledger, monitor, stoppedAt: filled.reason };
    }
    await Promise.all([
      page.waitForEvent('framenavigated', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined),
      submitWriteForm(page, inspection.form, { customer_name: NEW_NAME }).then((submitted) => {
        if (!submitted.ok) {
          throw new Error(`the submission failed: ${submitted.reason}`);
        }
      }),
    ]);
    await page.waitForLoadState('load', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined);
    await wait(QUIET_PERIOD_MS);
    return { page, ledger, monitor, stoppedAt: null };
  };

  /** T31R-fix-1（C-1）: 前の値（値を照らす hidden の `lock_version` を含む。CSRF の hidden は読まない）。 */
  const expectedPriorOf = (): UpdateFormValues => ({ ...EXPECTED_PRIOR, passthroughValues: { lock_version: server.lockMarker } });

  const expectNoMarker = (text: string): void => {
    expect(text).not.toContain(server.csrfMarker);
    expect(text).not.toContain(server.lockMarker);
  };

  // T31R-fix-1（C-1）: 秘密に見えない hidden（`lock_version`）の値も読む（照合で前の値と照らす。記録しない）。CSRF の hidden の値は読まない。
  it('reads the current values of the changed and kept fields, the state hidden, the hidden of the pair and the checked hidden, and not the CSRF token', async () => {
    const read = await readPrior('plain');
    expect(read).toEqual({ ok: true, values: expectedPriorOf() });
    expect(JSON.stringify(read)).not.toContain(server.csrfMarker);
    expect(JSON.stringify(read.ok ? { ...read.values, passthroughValues: {} } : read)).not.toContain(server.lockMarker);
    expect(posts(server.requests)).toEqual(expectedPosts);
  }, ROUND_TIMEOUT_MS);

  it('does not read a form whose pair of hidden and checkbox is not adjacent in the DOM', async () => {
    expect(await readPrior('pair-split')).toEqual({ ok: false, reason: 'CHECKBOX_PAIR_NOT_ADJACENT' });
  }, ROUND_TIMEOUT_MS);

  it.each<UpdateFormFixtureEnctype>(['urlencoded', 'multipart'])('delivers the approved %s update POST once, with the kept fields as before', async (enctype) => {
    const read = await readPrior('plain', enctype);
    if (!read.ok) {
      throw new Error(`the prior values were not read: ${read.reason}`);
    }
    const { page, ledger, monitor, stoppedAt } = await writeUpdate('plain', enctype, read.values);
    expect(stoppedAt).toBeNull();
    expectedPosts.push(`POST ${UPDATE_FORM_PATHS.record}`);
    console.info(`T31g-1 (${name}) approved ${enctype}: server ${JSON.stringify(posts(server.requests))}; monitor ${JSON.stringify(monitor.snapshot())}`);
    expect(posts(server.requests)).toEqual(expectedPosts);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', sendAttempts: 1, sendOutcome: 'RESPONDED' });
    expect(new URL(page.url()).pathname).toBe(UPDATE_FORM_PATHS.record);
    const body = server.postBodies.at(-1) ?? Buffer.alloc(0);
    const contentType = server.requests.filter((entry) => entry.method === 'POST').at(-1)?.contentType ?? '';
    const sent = enctype === 'multipart' ? multipartFields(body, contentType) : urlencodedFields(body);
    expect(Object.fromEntries([...sent].filter(([key]) => key !== 'authenticity_token' && key !== 'lock_version'))).toEqual({
      _method: ['PATCH'],
      customer_name: [NEW_NAME],
      memo: [UPDATE_FORM_VALUES.memo.split('\n').join('\r\n')],
      plan: [UPDATE_FORM_VALUES.plan],
      contact: [UPDATE_FORM_VALUES.contact],
      newsletter: [UPDATE_FORM_VALUES.newsletter],
      active: [UPDATE_FORM_VALUES.active],
      published: [UPDATE_FORM_VALUES.publishedOff, UPDATE_FORM_VALUES.publishedOn],
    });
    expect(sent.get('authenticity_token')).toEqual([server.csrfMarker]);
    expect(sent.get('lock_version')).toEqual([server.lockMarker]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expectNoMarker(JSON.stringify([ledger.snapshot(), monitor.snapshot(), monitor.submissionReport()]));
  }, ROUND_TIMEOUT_MS);

  it.each(BLOCKED_VARIANTS)('does not deliver $round', async ({ round, variant }) => {
    const read = await readPrior(variant);
    if (!read.ok) {
      throw new Error(`the prior values were not read: ${read.reason}`);
    }
    const { ledger, monitor, stoppedAt } = await writeUpdate(variant, 'urlencoded', read.values);
    console.info(`T31g-1 (${name}) ${round}: stopped ${stoppedAt}; server ${JSON.stringify(posts(server.requests))}; monitor ${JSON.stringify(monitor.snapshot())}`);
    expect(stoppedAt).toBeNull();
    expect(posts(server.requests)).toEqual(expectedPosts);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'NOT_SENT', sendAttempts: 0 });
    expect(Object.values(monitor.snapshot().blockedByPayloadReason).reduce((sum, count) => sum + count, 0), `${round}: blocking evidence`).toBe(1);
    expectNoMarker(JSON.stringify([ledger.snapshot(), monitor.snapshot()]));
    blockedRounds.push(round);
  }, ROUND_TIMEOUT_MS);

  it('stops before the input when the form of the write stage has another value than the prior value', async () => {
    const read = await readPrior('plain');
    if (!read.ok) {
      throw new Error(`the prior values were not read: ${read.reason}`);
    }
    server.setDrift(true);
    const { monitor, stoppedAt } = await writeUpdate('plain', 'urlencoded', read.values);
    expect(stoppedAt).toBe('PRIOR_VALUE_CHANGED');
    expect(posts(server.requests)).toEqual(expectedPosts);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'NOT_SENT', sendAttempts: 0 });
    blockedRounds.push('drift');
  }, ROUND_TIMEOUT_MS);

  // T31g-1 fix round 1: 状態の語でもあり秘密に見える名前でもある hidden（`state`）がある画面は、値を読めず照らせないので、実行しない（期待を
  // 作らない）。前の作りでは名前だけを照らしたので、ページの JS が `state` を変えても POST が届いた。
  it('does not run an update on a form with a state hidden whose name looks like a secret, and sends nothing', async () => {
    const spec: WriteUpdateFormSpec = {
      ...specFor('urlencoded'),
      candidateFields: [...UPDATE_FIELDS, field('state', 'hidden', { hidden: true })],
    };
    const read = await readPrior('secret-state', 'urlencoded', spec);
    let made: UpdatePayloadFieldsResult | null = null;
    if (read.ok) {
      made = updatePayloadFieldsOf(spec, read.values, { customer_name: NEW_NAME });
      if (made.ok) {
        await writeUpdate('secret-state', 'urlencoded', read.values, spec);
      }
    }
    console.info(`T31g-1 fix round 1 (${name}) secret-like state: read ${JSON.stringify(read.ok ? 'ok' : read.reason)}; server ${JSON.stringify(posts(server.requests))}`);
    expect(posts(server.requests)).toEqual(expectedPosts);
    expect(read).toEqual({ ok: false, reason: 'SECRET_LIKE_STATE_FIELD' });
    expect(made).toBeNull();
    expect(updatePayloadFieldsOf(spec, expectedPriorOf(), { customer_name: NEW_NAME })).toEqual({ ok: false, reason: 'SECRET_LIKE_STATE_FIELD' });
    blockedRounds.push('secret-like state');
  }, ROUND_TIMEOUT_MS);

  it('after all the rounds, no POST arrives late (counted again after a named wait)', async () => {
    await wait(LATE_DELIVERY_SETTLE_MS);
    console.info(`T31g-1 (${name}) late check: blocked rounds ${blockedRounds.length}; server ${JSON.stringify(posts(server.requests))}`);
    expect(posts(server.requests)).toEqual(expectedPosts);
    expect(expectedPosts).toHaveLength(2);
    expect(blockedRounds).toHaveLength(BLOCKED_VARIANTS.length + 2);
  }, ROUND_TIMEOUT_MS);
});

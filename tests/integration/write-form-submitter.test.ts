// T30c（Task 30 の設計書 `2026-10-13-beaksight-task-30-approved-create-design.md` 3 章の「フォームの入力」、5 章、6 章）: 書き込みのフォームの
// 入力の owner（`src/browser/write-form-submitter.ts`）。本物の Guard（書き込みの段）と、127.0.0.1 の fixture のサーバ
// （`tests/helpers/write-fixture-server.ts` の `richForm`）で確かめる。Chromium は headless だけ（テストの既定と、CLI の起動の設定の両方）。
// - 送る前の確かめ（`inspectWriteForm`。isolated world で読む）の表: action の違い（大文字、percent-encode、末尾の `/`、別の port、`..`）、
//   `formaction`・`formmethod`・`formenctype` の上書き、target `_blank`（`formtarget`、`<base target>`）、`accept-charset`、`form` 属性の欄、
//   別の form の欄、欄の型の違い、DOM clobbering、ページの JS の getter の上書き、form がない・2 つある、送信ボタンが 2 つ、欄が足された。
// - 入力と送信（`fillWriteForm`・`submitWriteForm`）: text・textarea・select・checkbox・radio の値が生成した値どおりに送られる（Guard の照合が
//   `ALLOW` になり、サーバが受けた本文で確かめる）。file の欄は空で送られる。checkbox の外し方。入力の間に form を差し替える・欄を足すと止まる。
// - 秘密: hidden（CSRF）と readonly の値が、確かめと入力と送信の結果に出ない。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  WRITE_FORM_REASONS,
  fillWriteForm,
  inspectWriteForm,
  submitWriteForm,
  writeFormFieldListsOf,
  type WriteFormFieldSpec,
  type WriteFormReason,
  type WriteFormSpec,
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
import { startWriteSubmissionProxy, type WriteSubmissionProxy } from '../helpers/write-submission-proxy.js';
import {
  WRITE_FIXTURE_PATHS,
  startWriteFixtureServer,
  type RichFormEnctype,
  type RichFormVariant,
  type WriteFixtureServer,
} from '../helpers/write-fixture-server.js';

const VIEWPORT = Object.freeze({ width: 900, height: 700 });
const NAVIGATION_SETTLE_TIMEOUT_MS = 5_000;
/** 全部の回の後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 2_000;
const ROUND_TIMEOUT_MS = 60_000;
const URLENCODED: WriteFormEnctype = 'application/x-www-form-urlencoded';
const MULTIPART: WriteFormEnctype = 'multipart/form-data';

const LAUNCHES = [
  { name: 'the headless shell (test default)', launch: (): Promise<Browser> => launchHeadlessChromium() },
  { name: 'the CLI Chromium (launchCliChromium, headless)', launch: (): Promise<Browser> => launchCliChromium() },
] as const;

const field = (name: string, type: WriteFormFieldSpec['type'], flags: Partial<Pick<WriteFormFieldSpec, 'readonly' | 'hidden' | 'disabled'>> = {}): WriteFormFieldSpec =>
  ({ name, type, readonly: false, hidden: false, disabled: false, ...flags });

/** fixture の `richForm` の欄（承認した候補の欄の代わり）。 */
const richFields = (extraHidden: readonly string[] = []): readonly WriteFormFieldSpec[] => [
  field('csrf_token', 'hidden', { hidden: true }),
  ...extraHidden.map((name) => field(name, 'hidden', { hidden: true })),
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
  customer_name: '山田 太郎',
  memo: 'メモ & 1+1=2\n二行目',
  plan: 'b',
  agree: 'yes',
  contact: 'phone',
});

/** multipart の本文を、名前と値（UTF-8）に分ける（テストの補助。file の部品はファイル名も持つ）。 */
const multipartFields = (body: Buffer, contentType: string): Map<string, string[]> => {
  const boundary = /boundary=(.+)$/u.exec(contentType)?.[1] ?? '';
  const fields = new Map<string, string[]>();
  for (const part of body.toString('utf8').split(`--${boundary}`).slice(1, -1)) {
    const [header = '', ...rest] = part.replace(/^\r\n/u, '').split('\r\n\r\n');
    const name = /name="([^"]*)"/u.exec(header)?.[1] ?? '';
    const filename = /filename="([^"]*)"/u.exec(header)?.[1];
    const value = rest.join('\r\n\r\n').replace(/\r\n$/u, '');
    fields.set(name, [...(fields.get(name) ?? []), filename === undefined ? value : `file:${filename}:${value}`]);
  }
  return fields;
};

const urlencodedFields = (body: Buffer): Map<string, string[]> => {
  const fields = new Map<string, string[]>();
  // ブラウザの urlencoded の本文は ASCII（UTF-8 の percent-encode）。`URLSearchParams` が UTF-8 として decode する。
  for (const [name, value] of new URLSearchParams(body.toString('ascii'))) {
    fields.set(name, [...(fields.get(name) ?? []), value]);
  }
  return fields;
};

describe.each(LAUNCHES)('T30c: the write form submitter, with $name', ({ name, launch }) => {
  let browser: Browser;
  let server: WriteFixtureServer;
  const contexts: BrowserContext[] = [];
  /** これまでの回で、サーバに届いてよいと確かめた POST（承認の送信だけ）。 */
  let expectedPosts = 0;

  let submissionProxy: WriteSubmissionProxy;

  beforeAll(async () => {
    browser = await launch();
    server = await startWriteFixtureServer();
    // DEF-099 fix: 承認の POST は、Guard が送り手に送らせる（中継を通して 1 回だけ）。
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

  const specFor = (enctype: WriteFormEnctype = URLENCODED, extraHidden: readonly string[] = []): WriteFormSpec => ({
    endpoint: { origin: server.originA, path: WRITE_FIXTURE_PATHS.create },
    enctype,
    candidateFields: richFields(extraHidden),
    submittedFieldNames: [...SUBMITTED_NAMES],
    methodOverride: null,
  });

  /** 書き込みの段の Guard の付いた Context と page（承認の形と、生成した値の照合の指定）。 */
  const openWriteStage = async (spec: WriteFormSpec, values: Readonly<Record<string, string | null>>): Promise<{
    readonly page: Page;
    readonly ledger: SafetyLedger;
    readonly monitor: WriteStageMonitor;
  }> => {
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block', acceptDownloads: false });
    contexts.push(context);
    const ledger = new SafetyLedger();
    const monitor = new WriteStageMonitor();
    const submittedFields = Object.entries(values)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([fieldName, value]) => ({ name: fieldName, value }));
    // T31R2-fix-1（C-1）: 値を照らす readonly の欄（`serial`）は、fixture の値で照らす（ワーカーでは画面の確かめで読んだ値）。
    const lists = writeFormFieldListsOf(spec);
    const knownValues: Readonly<Record<string, string>> = { serial: server.readonlyMarker };
    await installPassiveRequestGuard(context, ledger, new Set([server.originA]), {
      writeStage: {
        expectation: {
          request: { ...spec.endpoint, enctype: spec.enctype },
          submittedFields,
          passthroughFieldNames: lists.passthroughFieldNames,
          emptyFileFieldNames: lists.emptyFileFieldNames,
          methodOverride: lists.methodOverride,
          absentFieldNames: lists.absentFieldNames,
          checkedPassthroughFields: lists.checkedPassthroughFieldNames.map((fieldName) => ({ name: fieldName, value: knownValues[fieldName] ?? '' })),
        },
        monitor,
      },
      writeSubmission: submissionProxy.options,
    });
    const page = await context.newPage();
    await awaitPassiveRequestGuardReady(page);
    return { page, ledger, monitor };
  };

  const posts = (): number => server.postBodies.length;

  /** 結果と記録に、秘密の目印が出ない。 */
  const expectNoMarkers = (...values: readonly unknown[]): void => {
    const text = JSON.stringify(values);
    expect(text).not.toContain(server.csrfMarker);
    expect(text).not.toContain(server.readonlyMarker);
  };

  it('closes the list of the reasons', () => {
    expect(WRITE_FORM_REASONS).toEqual([
      'SPEC_INVALID',
      'FORM_UNREADABLE',
      'FORM_NOT_FOUND',
      'FORM_AMBIGUOUS',
      'FIELD_OWNED_BY_OTHER_FORM',
      'FORM_FIELDS_CHANGED',
      'FIELD_TYPE_MISMATCH',
      'SUBMITTER_NOT_FOUND',
      'SUBMITTER_AMBIGUOUS',
      'METHOD_NOT_POST',
      'ACTION_NOT_ALLOWED',
      'ENCTYPE_NOT_ALLOWED',
      'ENCTYPE_MISMATCH',
      'FORM_TARGET_NOT_SELF',
      'ACCEPT_CHARSET_NOT_UTF8',
      'FORM_CHANGED',
      'VALUE_NOT_SUPPORTED',
      'INPUT_FAILED',
      'VALUE_NOT_APPLIED',
      'SUBMIT_FAILED',
      // T31g-1: UPDATE の入力の前の確かめと、組の隣り合い。
      'PRIOR_VALUE_CHANGED',
      'CHECKBOX_PAIR_NOT_ADJACENT',
      // T31g-1 fix round 1: 秘密に見える名前の状態の欄。
      'SECRET_LIKE_STATE_FIELD',
      // T31R2-fix-1（C-1）: ページが作る値の名前でない、秘密に見える名前の値を送る欄。
      'SECRET_LIKE_PASSTHROUGH_FIELD',
    ]);
  });

  it('computes the field lists for the payload check from the approved candidate', () => {
    // T30f fix round 1（DEF-098）: 見える欄をすべて送る欄に選んだ画面は、選ばなかった見える欄の一覧が空。
    // T31R2-fix-1（C-1）: 名前だけを照らすのは、ページが読み込みごとに作る値（CSRF の hidden）だけ。readonly の `serial` は値を照らす。
    const noUnchosen = { emptyValueFieldNames: [], absentFieldNames: [], checkedPassthroughFieldNames: ['serial'] };
    expect(writeFormFieldListsOf(specFor())).toEqual({
      passthroughFieldNames: ['csrf_token'], emptyFileFieldNames: ['att'], methodOverride: null, ...noUnchosen,
    });
    // T30b fix round 1: `_method` の hidden の欄は、名前だけの一覧に入れず、承認した候補の method の上書きの値で照らす。
    const overridden: WriteFormSpec = { ...specFor(URLENCODED, ['_method']), methodOverride: 'PUT' };
    expect(writeFormFieldListsOf(overridden)).toEqual({
      passthroughFieldNames: ['csrf_token'], emptyFileFieldNames: ['att'], methodOverride: 'PUT', ...noUnchosen,
    });
    expect(writeFormFieldListsOf({ ...specFor(URLENCODED, ['_METHOD']), methodOverride: null }).passthroughFieldNames).toEqual(['csrf_token']);
  });

  it.each<[RichFormVariant, WriteFormReason | 'OK', RichFormEnctype?, string[]?]>([
    ['plain', 'OK'],
    ['action-dots', 'OK'],
    ['form-attribute', 'OK'],
    ['accept-charset-utf8', 'OK'],
    ['clobber-approved', 'OK', 'urlencoded', ['action']],
    ['action-upper', 'ACTION_NOT_ALLOWED'],
    ['action-encoded', 'ACTION_NOT_ALLOWED'],
    ['action-slash', 'ACTION_NOT_ALLOWED'],
    ['action-port', 'ACTION_NOT_ALLOWED'],
    ['formaction', 'ACTION_NOT_ALLOWED'],
    ['clobber', 'ACTION_NOT_ALLOWED', 'urlencoded', ['action']],
    ['getter-override', 'ACTION_NOT_ALLOWED'],
    ['formmethod', 'METHOD_NOT_POST'],
    ['formenctype', 'ENCTYPE_NOT_ALLOWED'],
    ['target-blank', 'FORM_TARGET_NOT_SELF'],
    ['formtarget', 'FORM_TARGET_NOT_SELF'],
    ['base-target', 'FORM_TARGET_NOT_SELF'],
    ['accept-charset', 'ACCEPT_CHARSET_NOT_UTF8'],
    ['other-form-field', 'FIELD_OWNED_BY_OTHER_FORM'],
    ['type-mismatch', 'FIELD_TYPE_MISMATCH'],
    ['extra-field', 'FORM_FIELDS_CHANGED'],
    ['duplicate-form', 'FORM_AMBIGUOUS'],
    ['no-form', 'FORM_NOT_FOUND'],
    ['two-submitters', 'SUBMITTER_AMBIGUOUS'],
  ])('inspects the %s form: %s', async (variant, expected, enctype = 'urlencoded', extraHidden = []) => {
    const spec = specFor(enctype === 'multipart' ? MULTIPART : URLENCODED, extraHidden);
    const { page } = await openWriteStage(spec, GENERATED_VALUES);
    await page.goto(server.richFormUrl(variant, enctype));
    const inspection = await inspectWriteForm(page, spec);
    expectNoMarkers(inspection);
    if (expected === 'OK') {
      expect(inspection).toEqual({ ok: true, form: writeFormFieldListsOf(spec) });
    } else {
      expect(inspection).toEqual({ ok: false, reason: expected });
    }
    if (variant === 'getter-override') {
      // ページの JS は、main world の action の getter を偽っている（isolated world で読むので、確かめは偽れない）。
      await expect(page.evaluate(() => (document.getElementById('f') as HTMLFormElement).action)).resolves.toBe(`${server.originA}${WRITE_FIXTURE_PATHS.create}`);
    }
  }, ROUND_TIMEOUT_MS);

  it('blocks an approved multipart spec on an urlencoded form (ENCTYPE_MISMATCH), and an invalid spec', async () => {
    const { page } = await openWriteStage(specFor(), GENERATED_VALUES);
    await page.goto(server.richFormUrl('plain'));
    await expect(inspectWriteForm(page, specFor(MULTIPART))).resolves.toEqual({ ok: false, reason: 'ENCTYPE_MISMATCH' });
    const invalidSpecs: readonly WriteFormSpec[] = [
      { ...specFor(), submittedFieldNames: ['att'] },
      { ...specFor(), submittedFieldNames: ['csrf_token'] },
      { ...specFor(), submittedFieldNames: ['serial'] },
      { ...specFor(), submittedFieldNames: ['missing'] },
      { ...specFor(), submittedFieldNames: ['memo', 'memo'] },
      { ...specFor(), enctype: 'text/plain' as never },
      // T30b fix round 1: DELETE の上書きは書き込みで送らない。上書きの値は PUT・PATCH・null だけ。
      { ...specFor(), methodOverride: 'DELETE' as never },
      { ...specFor(), methodOverride: undefined as never },
    ];
    for (const spec of invalidSpecs) {
      await expect(inspectWriteForm(page, spec), JSON.stringify(spec.submittedFieldNames)).resolves.toEqual({ ok: false, reason: 'SPEC_INVALID' });
    }
  }, ROUND_TIMEOUT_MS);

  it.each<RichFormEnctype>(['urlencoded', 'multipart'])('fills and submits the %s form: the server receives the generated values and an empty file, once', async (enctype) => {
    const spec = specFor(enctype === 'multipart' ? MULTIPART : URLENCODED);
    const { page, ledger, monitor } = await openWriteStage(spec, GENERATED_VALUES);
    await page.goto(server.richFormUrl('plain', enctype));
    const inspection = await inspectWriteForm(page, spec);
    if (!inspection.ok) throw new Error(`inspection failed: ${inspection.reason}`);
    const filled = await fillWriteForm(page, inspection.form, GENERATED_VALUES, monitor);
    expect(filled).toEqual({ ok: true });
    expect(monitor.snapshot().submissionWindowOpen).toBe(true);
    const submitted = await submitWriteForm(page, inspection.form, GENERATED_VALUES);
    expect(submitted).toEqual({ ok: true, outcome: 'SUBMITTED' });
    await page.waitForURL(`**${WRITE_FIXTURE_PATHS.created}`, { timeout: NAVIGATION_SETTLE_TIMEOUT_MS });
    await wait(QUIET_PERIOD_MS);
    expectedPosts += 1;

    expect(posts()).toBe(expectedPosts);
    expect(monitor.submissionReport()).toEqual({ submission: 'SENT', responseReceived: true, responseStatus: 303, sendAttempts: 1, sendOutcome: 'RESPONDED' });
    expect(monitor.unexpectedRequestCount()).toBe(0);
    const received = server.postBodies.at(-1);
    expect(received?.path).toBe(WRITE_FIXTURE_PATHS.create);
    const fields = enctype === 'multipart'
      ? multipartFields(received?.body ?? Buffer.alloc(0), received?.contentType ?? '')
      : urlencodedFields(received?.body ?? Buffer.alloc(0));
    expect(fields.get('customer_name')).toEqual(['山田 太郎']);
    expect(fields.get('memo')).toEqual(['メモ & 1+1=2\r\n二行目']);
    expect(fields.get('plan')).toEqual(['b']);
    expect(fields.get('agree')).toEqual(['yes']);
    expect(fields.get('contact')).toEqual(['phone']);
    expect(fields.get('att')).toEqual([enctype === 'multipart' ? 'file::' : '']);
    expect(fields.get('csrf_token')).toEqual([server.csrfMarker]);
    expect(fields.get('serial')).toEqual([server.readonlyMarker]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expectNoMarkers(inspection, filled, submitted, monitor.snapshot(), ledger.snapshot());
  }, ROUND_TIMEOUT_MS);

  it('unchecks a checkbox whose generated value is null, and checks the generated radio', async () => {
    const values = { ...GENERATED_VALUES, agree: null };
    const spec = specFor();
    const { page, monitor } = await openWriteStage(spec, values);
    await page.goto(server.richFormUrl('checked'));
    const inspection = await inspectWriteForm(page, spec);
    if (!inspection.ok) throw new Error(`inspection failed: ${inspection.reason}`);
    await expect(fillWriteForm(page, inspection.form, values, monitor)).resolves.toEqual({ ok: true });
    await expect(submitWriteForm(page, inspection.form, values)).resolves.toEqual({ ok: true, outcome: 'SUBMITTED' });
    await page.waitForURL(`**${WRITE_FIXTURE_PATHS.created}`, { timeout: NAVIGATION_SETTLE_TIMEOUT_MS });
    expectedPosts += 1;
    const fields = urlencodedFields(server.postBodies.at(-1)?.body ?? Buffer.alloc(0));
    expect(fields.has('agree')).toBe(false);
    expect(fields.get('contact')).toEqual(['phone']);
    expect(monitor.submissionReport().submission).toBe('SENT');
  }, ROUND_TIMEOUT_MS);

  it.each<[string, RichFormVariant, Readonly<Record<string, string | null>>, readonly WriteFormReason[]]>([
    ['a form replaced while filling', 'replace-on-input', GENERATED_VALUES, ['FORM_CHANGED', 'VALUE_NOT_APPLIED']],
    ['a field added while filling', 'add-field-on-input', GENERATED_VALUES, ['FORM_CHANGED']],
    ['a checked radio whose generated value is null', 'checked', { ...GENERATED_VALUES, contact: null }, ['VALUE_NOT_SUPPORTED']],
    ['a text field whose generated value is null', 'plain', { ...GENERATED_VALUES, customer_name: null }, ['VALUE_NOT_SUPPORTED']],
    ['a checkbox value that is not an option', 'plain', { ...GENERATED_VALUES, agree: 'no' }, ['VALUE_NOT_SUPPORTED']],
    ['a missing generated value', 'plain', { customer_name: '山田 太郎' }, ['VALUE_NOT_SUPPORTED']],
  ])('stops %s, and nothing reaches the server', async (_label, variant, values, reasons) => {
    const spec = specFor();
    const { page, monitor } = await openWriteStage(spec, values);
    await page.goto(server.richFormUrl(variant));
    const inspection = await inspectWriteForm(page, spec);
    if (!inspection.ok) throw new Error(`inspection failed: ${inspection.reason}`);
    const filled = await fillWriteForm(page, inspection.form, values, monitor);
    const submitted = filled.ok ? await submitWriteForm(page, inspection.form, values) : null;
    console.info(`T30c (${name}) ${variant}: filled ${JSON.stringify(filled)}; submitted ${JSON.stringify(submitted)}`);
    const reason = !filled.ok ? filled.reason : submitted !== null && !submitted.ok ? submitted.reason : null;
    expect(reasons).toContain(reason);
    await wait(QUIET_PERIOD_MS);
    expect(posts()).toBe(expectedPosts);
    expect(monitor.submissionReport().submission).toBe('NOT_SENT');
    expectNoMarkers(filled, submitted);
  }, ROUND_TIMEOUT_MS);

  it('submits nothing when the form changes between the fill and the submission', async () => {
    const spec = specFor();
    const { page, monitor } = await openWriteStage(spec, GENERATED_VALUES);
    await page.goto(server.richFormUrl('plain'));
    const inspection = await inspectWriteForm(page, spec);
    if (!inspection.ok) throw new Error(`inspection failed: ${inspection.reason}`);
    await expect(fillWriteForm(page, inspection.form, GENERATED_VALUES, monitor)).resolves.toEqual({ ok: true });
    await page.evaluate(() => {
      const extra = document.createElement('input');
      extra.type = 'hidden';
      extra.name = 'extra';
      document.getElementById('f')?.append(extra);
    });
    await expect(submitWriteForm(page, inspection.form, GENERATED_VALUES)).resolves.toEqual({ ok: false, reason: 'FORM_CHANGED', clickAttempted: false });
    await wait(QUIET_PERIOD_MS);
    expect(posts()).toBe(expectedPosts);
  }, ROUND_TIMEOUT_MS);

  it('after all the rounds, no POST arrives late', async () => {
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(posts()).toBe(expectedPosts);
    expect(expectedPosts).toBe(3);
  }, ROUND_TIMEOUT_MS);
});

// T30c（Task 30 の設計書 `2026-10-13-beaksight-task-30-approved-create-design.md` 3 章の「フォームの入力」、5 章、6 章）: 書き込みのフォームの
// 入力の owner（`src/browser/write-form-submitter.ts`）。本物の Guard（書き込みの段）と、127.0.0.1 の fixture のサーバ
// （`tests/helpers/write-fixture-server.ts` の `richForm`）で確かめる。Chromium はテストの既定の headless。
// - 送る前の確かめ（`inspectWriteForm`。isolated world で読む）の表: action の違い（大文字、percent-encode、末尾の `/`、別の port、`..`）、
//   `formaction`・`formmethod`・`formenctype` の上書き、target `_blank`（`formtarget`、`<base target>`）、`accept-charset`、`form` 属性の欄、
//   別の form の欄、欄の型の違い、DOM clobbering、ページの JS の getter の上書き、form がない・2 つある、送信ボタンが 2 つ、欄が足された。
// - 入力と送信（`fillWriteForm`・`submitWriteForm`）: text・textarea・select・checkbox・radio の値が生成した値どおりに送られる（Guard の照合が
//   `ALLOW` になり、サーバが受けた本文で確かめる）。file の欄は空で送られる。checkbox の外し方。入力の間に form を差し替える・欄を足すと止まる。
// - 秘密: hidden（CSRF）と readonly の値が、確かめと入力と送信の結果に出ない。
// - SLIM（W-4）: 押す時点の確かめを、同じ Browser でここにまとめた（もとの write-form-same-element・write-form-press-owner）。
//   - DEF-114: 「同じ要素か」の確かめ直しを、ページの JS（`Object.prototype` の getter の偽り）が偽れない。入れ替え続ける写しと focus を移すページでも、
//     承認の外の POST は届かない。
//   - FIX-237 fix round 1: 押す時点に送信ボタンを別の form に移す・付け替える・別のボタンを重ねると止める（届いた数 0）。
import type { IncomingMessage } from 'node:http';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
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
import { compareCodeUnits } from '../../src/core/text.js';
import {
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  installPassiveRequestGuard,
  WriteStageMonitor,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import type { WriteFormEnctype } from '../../src/safety/write-payload-policy.js';
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { QUIET_PERIOD_MS } from '../helpers/gate-harness.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';
import { startWriteSubmissionProxy, type WriteSubmissionProxy } from '../helpers/write-submission-proxy.js';
import {
  WRITE_FIXTURE_PATHS,
  startWriteFixtureServer,
  type RichFormEnctype,
  type RichFormVariant,
  type WriteFixturePostBody,
  type WriteFixtureServer,
} from '../helpers/write-fixture-server.js';

const VIEWPORT = Object.freeze({ width: 900, height: 700 });
const NAVIGATION_SETTLE_TIMEOUT_MS = 5_000;
/** 全部の回の後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 2_000;
const ROUND_TIMEOUT_MS = 60_000;
const URLENCODED: WriteFormEnctype = 'application/x-www-form-urlencoded';
const MULTIPART: WriteFormEnctype = 'multipart/form-data';


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

// ---- DEF-114（T32j-4。もとの write-form-same-element）: 「同じ要素か」の確かめ直しを、ページの JS が偽れない。----

/** DEF-114: 同じ要素の場面の生成した値（本文の全体を名前と値の組で比べるので、改行を含まない値）。 */
const SAME_ELEMENT_VALUES: Readonly<Record<string, string | null>> = Object.freeze({
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

// ---- FIX-237 fix round 1（SREV-237 の Critical-1・Minor-1。もとの write-form-press-owner）: 押す時点の form owner。----

/** 押した後に、届く要求を待つ時間（ms）。 */
const PRESS_SETTLE_MS = 1_500;
const PRESS_CREATE_PATH = '/items';
const PRESS_VALUES: Readonly<Record<string, string | null>> = Object.freeze({ name: 'approved-name', memo: 'approved-memo' });
const PRESS_FORM_A = `<form id="a" method="post" action="${PRESS_CREATE_PATH}"><label>名前 <input id="name" name="name" type="text"></label>`
  + `<label>備考 <input id="memo" name="memo" type="text"></label><button id="go" type="submit">保存</button></form>`;
const PRESS_FORM_B = `<form id="b" method="post" action="${PRESS_CREATE_PATH}"><input type="hidden" name="role" value="admin"><input name="title" value="other">`
  + '<button id="gob" type="submit">送る</button></form>';
const PRESS_PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>登録</title><link rel="icon" href="data:,"></head>
<body><main><h1>登録</h1><div id="box">${PRESS_FORM_A}</div><div id="other">${PRESS_FORM_B}</div></main></body></html>`;

/** ページの変え方（押す瞬間・押し始めに 1 回だけ）。 */
type PressChange = 'moveButtonToBSame' | 'formAttrToBSame' | 'overlay';
const CHANGE_ON = (input: { readonly change: string; readonly when: string }): void => {
  const byId = (id: string): HTMLElement => {
    const element = document.getElementById(id);
    if (element === null) throw new Error(`missing ${id}`);
    return element;
  };
  const copyOf = (name: string): HTMLInputElement => {
    const field = document.createElement('input');
    field.name = name;
    field.value = (byId(name) as HTMLInputElement).value;
    return field;
  };
  // `click@go` は、送信ボタンそのものの受け手（的の段。押す時点の確かめの受け手より後に動く）。ほかは window の capture 段。
  const [type = '', on] = input.when.split('@');
  const listenOn: EventTarget = on === 'go' ? byId('go') : window;
  listenOn.addEventListener(type, () => {
    switch (input.change) {
      case 'moveButtonToBSame':
        // B を、A と同じ値の欄だけにして、送信ボタンを B に移す（届く本文は承認と同じ。別の form の送信）。
        byId('b').replaceChildren(copyOf('name'), copyOf('memo'));
        byId('b').append(byId('go'));
        break;
      case 'formAttrToBSame':
        byId('b').replaceChildren(copyOf('name'), copyOf('memo'));
        byId('go').setAttribute('form', 'b');
        break;
      case 'overlay': {
        const rect = byId('go').getBoundingClientRect();
        byId('gob').style.cssText = `position:fixed;left:${String(rect.left - 5)}px;top:${String(rect.top - 5)}px;`
          + `width:${String(rect.width + 10)}px;height:${String(rect.height + 10)}px;z-index:99`;
        break;
      }
      default:
        break;
    }
  }, { capture: true, once: true });
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('T30c: the write form submitter, with %s', (name, launch) => {
  let browser: Browser;
  let server: WriteFixtureServer;
  const contexts: BrowserContext[] = [];
  /** これまでの回で、サーバに届いてよいと確かめた POST（承認の送信だけ）。 */
  let expectedPosts = 0;

  let submissionProxy: WriteSubmissionProxy;
  /** FIX-237: form A と B の仮のサイト（その describe の beforeAll で起動する）と、届いた読み取りでない要求。 */
  let pressServer: LoopbackHttpServer | undefined;
  const pressArrivals: string[] = [];
  let expectedPressArrivals = 0;

  beforeAll(async () => {
    browser = await launch();
    server = await startWriteFixtureServer();
    // DEF-099 fix: 承認の POST は、Guard が送り手に送らせる（中継を通して 1 回だけ）。
    submissionProxy = await startWriteSubmissionProxy();
  });

  afterAll(async () => {
    await pressServer?.close();
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

  // DEF-237（設計書 `2026-11-09-beaksight-element-identity-design.md` 2 の 3）: 名前の欄に入れると、ページが同じ親の備考の欄の前に要素を 1 つ足す
  // （後ろの欄と送信ボタンの位置の道がずれる）。欄でない要素なら、同じ要素（backendNodeId）のまま入れて 1 回だけ届く。名前のない欄が足されて form の形が
  // 変わったときは、今のとおり止める（届いた数は増えない）。
  const ADD_BEFORE_MEMO_ON_INPUT = (kind: string): void => {
    const nameField = document.getElementById('customer_name');
    if (nameField === null) throw new Error('no name field');
    nameField.addEventListener('input', () => {
      const memo = document.querySelector('[name="memo"]');
      if (memo === null) return;
      const added = document.createElement(kind === 'unnamedField' ? 'input' : 'span');
      if (kind === 'text') added.textContent = 'hint';
      memo.before(added);
    }, { once: true });
  };

  it('fills and submits once when the page adds an element before a field while filling (DEF-237)', async () => {
    const spec = specFor();
    const { page, ledger, monitor } = await openWriteStage(spec, GENERATED_VALUES);
    await page.goto(server.richFormUrl('plain'));
    await page.evaluate(ADD_BEFORE_MEMO_ON_INPUT, 'text');
    const inspection = await inspectWriteForm(page, spec);
    if (!inspection.ok) throw new Error(`inspection failed: ${inspection.reason}`);
    await expect(fillWriteForm(page, inspection.form, GENERATED_VALUES, monitor)).resolves.toEqual({ ok: true });
    await expect(submitWriteForm(page, inspection.form, GENERATED_VALUES)).resolves.toEqual({ ok: true, outcome: 'SUBMITTED' });
    await page.waitForURL(`**${WRITE_FIXTURE_PATHS.created}`, { timeout: NAVIGATION_SETTLE_TIMEOUT_MS });
    await wait(QUIET_PERIOD_MS);
    expectedPosts += 1;
    expect(posts()).toBe(expectedPosts);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', sendAttempts: 1 });
    const fields = urlencodedFields(server.postBodies.at(-1)?.body ?? Buffer.alloc(0));
    expect(fields.get('customer_name')).toEqual(['山田 太郎']);
    expect(fields.get('memo')).toEqual(['メモ & 1+1=2\r\n二行目']);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  }, ROUND_TIMEOUT_MS);

  it('stops when the page adds an unnamed field before a field while filling, and nothing reaches the server (DEF-237)', async () => {
    const spec = specFor();
    const { page, monitor } = await openWriteStage(spec, GENERATED_VALUES);
    await page.goto(server.richFormUrl('plain'));
    await page.evaluate(ADD_BEFORE_MEMO_ON_INPUT, 'unnamedField');
    const inspection = await inspectWriteForm(page, spec);
    if (!inspection.ok) throw new Error(`inspection failed: ${inspection.reason}`);
    const filled = await fillWriteForm(page, inspection.form, GENERATED_VALUES, monitor);
    expect(filled).toEqual({ ok: false, reason: 'FORM_CHANGED' });
    await wait(QUIET_PERIOD_MS);
    expect(posts()).toBe(expectedPosts);
    expect(monitor.submissionReport().submission).toBe('NOT_SENT');
  }, ROUND_TIMEOUT_MS);

  it('stops the press at the press time when the submit button is rewritten while being pressed (LU-SFIX3-A)', async () => {
    const spec = specFor();
    const { page, monitor } = await openWriteStage(spec, GENERATED_VALUES);
    await page.goto(server.richFormUrl('plain'));
    const inspection = await inspectWriteForm(page, spec);
    if (!inspection.ok) throw new Error(`inspection failed: ${inspection.reason}`);
    await expect(fillWriteForm(page, inspection.form, GENERATED_VALUES, monitor)).resolves.toEqual({ ok: true });
    // 同じ送信ボタンのまま、押し始め（pointerdown）に、送信先を上書きする属性を付ける。
    await page.evaluate(() => {
      const submit = document.querySelector('#f [type="submit"]');
      if (submit === null) throw new Error('no submit button');
      submit.addEventListener('pointerdown', () => { submit.setAttribute('formaction', '/elsewhere'); }, { capture: true });
    });
    await expect(submitWriteForm(page, inspection.form, GENERATED_VALUES)).resolves.toEqual({ ok: false, reason: 'FORM_CHANGED', clickAttempted: false });
    await wait(QUIET_PERIOD_MS);
    expect(posts()).toBe(expectedPosts);
    expect(monitor.submissionReport().submission).toBe('NOT_SENT');
  }, ROUND_TIMEOUT_MS);

  describe('DEF-114: the same-element check of the write stage', () => {
    /**
     * 承認の期待の、本文の全体（名前と値の組。名前の順に並べる）: 送る欄の生成した値、CSRF の hidden と readonly の欄の値（ページの値のまま）、
     * 空の file の欄（urlencoded では空の値）。届いた POST の本文は、これと全体で一致しなければならない。
     */
    const approvedBodyEntries = (): readonly (readonly [string, string])[] => {
      const entries: (readonly [string, string])[] = [
        ['csrf_token', server.csrfMarker],
        ['serial', server.readonlyMarker],
        ['att', ''],
        ...Object.entries(SAME_ELEMENT_VALUES).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      ];
      return entries.sort(byFieldName);
    };
    /** 届いた POST の、送信先と本文の全体（名前の順に並べた、名前と値の組）。 */
    const receivedPostOf = (post: WriteFixturePostBody) => ({
      path: post.path,
      entries: [...new URLSearchParams(post.body.toString('ascii'))].sort(byFieldName),
    });

    // 修正の前（main world の `(a, b) => a === b`）は、`Object.prototype.v` の getter で、別の要素を「同じ」と見せられた（DEF-114 の RED）。修正の後は、
    // isolated world で読んだ backendNodeId を比べる。SLIM: 偽りのない形は、偽りのある形（差し替えに偽りを足す）に含まれるので、代表 2（入力の後・確かめの後）。
    it.each([
      ['after the fill', 'submit'],
      ['after the inspection', 'fill'],
    ] as const)('stops with FORM_CHANGED when the form is replaced by a clone %s, with the Object.prototype getter forgery', async (_label, stoppedAt) => {
      const writeSpec = specFor();
      const { page, monitor } = await openWriteStage(writeSpec, SAME_ELEMENT_VALUES);
      await page.goto(server.richFormUrl('plain'));
      const inspection = await inspectWriteForm(page, writeSpec);
      if (!inspection.ok) throw new Error(`inspection failed: ${inspection.reason}`);
      if (stoppedAt === 'submit') {
        await expect(fillWriteForm(page, inspection.form, SAME_ELEMENT_VALUES, monitor)).resolves.toEqual({ ok: true });
      }
      await page.evaluate(REPLACE_FORM_WITH_CLONE);
      await page.evaluate(FORGE_SAME_ELEMENT);
      if (stoppedAt === 'submit') {
        await expect(submitWriteForm(page, inspection.form, SAME_ELEMENT_VALUES)).resolves.toEqual({ ok: false, reason: 'FORM_CHANGED', clickAttempted: false });
      } else {
        await expect(fillWriteForm(page, inspection.form, SAME_ELEMENT_VALUES, monitor)).resolves.toEqual({ ok: false, reason: 'FORM_CHANGED' });
      }
      await wait(QUIET_PERIOD_MS);
      expect(posts()).toBe(expectedPosts);
    }, ROUND_TIMEOUT_MS);

    // T32R-fix-I1（独立レビュー T32R の I-1）: ページの JS が、欄（`customer_name`）と送信ボタン（`#go`）を、同じ位置の写し B とタイマーで
    // 入れ替え続けても、入力と click の的は確かめの時の要素 A で、同じ位置の写し B は的にならない（操作のたびに、合図つきの Locator で、位置の
    // 要素が確かめの時の要素かを照らす）。止まる理由は `FORM_CHANGED`・`INPUT_FAILED`・`VALUE_NOT_APPLIED` など（どれも止める側）。
    // T32R2 の M-1: A と B に届いた事象は Node の側に記録する（送信で画面が移っても、Guard が送信を止めても数える）。A が押されて送られた回は、
    // 承認の期待の全体と一致する本文の POST だけが届く。届いた POST は、A を押した回より多くない。
    it('aims every input and click at the inspected element, never at the swapped copy at the same position', async () => {
      const writeSpec = specFor();
      const counts = { A: { input: 0, click: 0 }, B: { input: 0, click: 0 } };
      const postsBefore = posts();
      for (let round = 0; round < SWAP_WRITE_ROUNDS; round += 1) {
        const { page, monitor } = await openWriteStage(writeSpec, SAME_ELEMENT_VALUES);
        await page.exposeBinding(SWAP_EVENT_BINDING, (_source, which: 'A' | 'B', kind: 'input' | 'click') => {
          counts[which][kind] += 1;
        });
        await page.goto(server.richFormUrl('plain'));
        const inspection = await inspectWriteForm(page, writeSpec);
        if (!inspection.ok) throw new Error(`inspection failed: ${inspection.reason}`);
        await page.evaluate(SWAP_FIELD_AND_BUTTON, { intervalLimitMs: SWAP_INTERVAL_LIMIT_MS, binding: SWAP_EVENT_BINDING });
        const filled = await fillWriteForm(page, inspection.form, SAME_ELEMENT_VALUES, monitor);
        if (filled.ok) {
          await submitWriteForm(page, inspection.form, SAME_ELEMENT_VALUES);
        }
        await wait(QUIET_PERIOD_MS);
      }
      expect(counts.B).toEqual({ input: 0, click: 0 });
      const arrived = server.postBodies.slice(postsBefore).map(receivedPostOf);
      expect(arrived.length).toBeLessThanOrEqual(counts.A.click);
      for (const post of arrived) {
        expect(post).toEqual({ path: WRITE_FIXTURE_PATHS.create, entries: approvedBodyEntries() });
      }
      expectedPosts += arrived.length;
    }, SWAP_WRITE_TIMEOUT_MS);

    // T32R2 の I-1: 操作の的の要素は照らすが、キーボードの入力は focus のある要素に入り、ページのスクリプトは focus を移せる（`fill` の値が、
    // form の外の囮 B に入る）。それでも、入れた後の値の読み直しと Guard の照合が守るので、承認の外の POST は届かず（届く POST は承認の期待の
    // 全体と一致する本文だけ）、違反は 0。
    it('lets the page move the focus during the fill, and still lets only the approved POST through (the typed value may reach the focused decoy)', async () => {
      const writeSpec = specFor();
      const counts = { A: { input: 0, click: 0 }, B: { input: 0, click: 0 } };
      const postsBefore = posts();
      const violations: string[] = [];
      for (let round = 0; round < FOCUS_REDIRECT_ROUNDS; round += 1) {
        const { page, monitor, ledger } = await openWriteStage(writeSpec, SAME_ELEMENT_VALUES);
        await page.exposeBinding(SWAP_EVENT_BINDING, (_source, which: 'A' | 'B', kind: 'input' | 'click') => {
          counts[which][kind] += 1;
        });
        await page.goto(server.richFormUrl('plain'));
        const inspection = await inspectWriteForm(page, writeSpec);
        if (!inspection.ok) throw new Error(`inspection failed: ${inspection.reason}`);
        await page.evaluate(FOCUS_REDIRECT, { otherPath: WRITE_FIXTURE_PATHS.otherPath, binding: SWAP_EVENT_BINDING });
        const filled = await fillWriteForm(page, inspection.form, SAME_ELEMENT_VALUES, monitor);
        if (filled.ok) {
          await submitWriteForm(page, inspection.form, SAME_ELEMENT_VALUES);
        }
        await wait(QUIET_PERIOD_MS);
        violations.push(...ledger.snapshot().invariantViolations.map(({ code }) => code));
      }
      const arrived = server.postBodies.slice(postsBefore).map(receivedPostOf);
      // 偽りが働いた（生成した値が囮に入った）ことと、送信まで進んだこと（照らす条件を空で通していない）の確かめ。遅れて届く POST は、全部の回の後に数え直す。
      expect(counts.B.input).toBeGreaterThan(0);
      expect(arrived.length).toBeGreaterThan(0);
      for (const post of arrived) {
        expect(post).toEqual({ path: WRITE_FIXTURE_PATHS.create, entries: approvedBodyEntries() });
      }
      expect(violations).toEqual([]);
      expectedPosts += arrived.length;
    }, SWAP_WRITE_TIMEOUT_MS);
  });

  describe('FIX-237 fix round 1: the form owner at the press time', () => {
    beforeAll(async () => {
      pressServer = await startLoopbackHttpServer((request, response) => {
        void (async (): Promise<void> => {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1');
          const method = request.method ?? 'GET';
          if (!READ_METHODS.has(method)) {
            pressArrivals.push(`${method} ${url.pathname} ${await readBody(request)}`);
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html><body><p>ok</p></body></html>');
            return;
          }
          if (url.pathname !== '/form') {
            response.writeHead(404).end();
            return;
          }
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PRESS_PAGE_HTML);
        })();
      });
    });

    /** 書き込みの段の Context で画面を開き、確かめ・入力・押下を行う（`change` があれば、`when` の事象で 1 回だけページが変える）。 */
    const runOnce = async (change: PressChange | null, when: string) => {
      const origin = pressServer?.origin ?? '';
      const factory = new BrowserContextFactory(browser, createTestConfig(origin, '/form'), () => new SafetyLedger(), {
        ...TEST_FACTORY_OPTIONS,
        authentication: {
          initialState: { cookies: [], origins: [] },
          filterState: (state) => state,
          auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
        },
      });
      try {
        const textField = (fieldName: string): WriteFormFieldSpec => field(fieldName, 'text');
        const spec: WriteFormSpec = {
          endpoint: { origin, path: PRESS_CREATE_PATH }, enctype: URLENCODED,
          candidateFields: [textField('name'), textField('memo')], submittedFieldNames: ['name', 'memo'], methodOverride: null,
        };
        const lists = writeFormFieldListsOf(spec);
        const monitor = new WriteStageMonitor();
        const context = await factory.createWriteStageContext(VIEWPORT, {
          expectation: {
            request: { ...spec.endpoint, enctype: spec.enctype },
            submittedFields: Object.entries(PRESS_VALUES).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([fieldName, value]) => ({ name: fieldName, value })),
            passthroughFieldNames: lists.passthroughFieldNames, emptyFileFieldNames: lists.emptyFileFieldNames, methodOverride: lists.methodOverride,
            absentFieldNames: lists.absentFieldNames, checkedPassthroughFields: [],
          },
          monitor,
        });
        const page: Page = await factory.createPassivePage(context);
        await page.goto(`${origin}/form`);
        if (change !== null) await page.evaluate(CHANGE_ON, { change, when });
        const inspection = await inspectWriteForm(page, spec);
        if (!inspection.ok) throw new Error(`inspection failed: ${inspection.reason}`);
        const filled = await fillWriteForm(page, inspection.form, PRESS_VALUES, monitor);
        const submitted = filled.ok ? await submitWriteForm(page, inspection.form, PRESS_VALUES) : null;
        await wait(PRESS_SETTLE_MS);
        return { filled, submitted, report: monitor.submissionReport(), violations: factory.getSafetyLedger(context).snapshot().invariantViolations };
      } finally {
        await factory.close().catch(() => undefined);
      }
    };

    it('sends the approved form once when the page changes nothing (the base)', async () => {
      const before = pressArrivals.length;
      const outcome = await runOnce(null, 'none');
      expect(outcome.submitted).toEqual({ ok: true, outcome: 'SUBMITTED' });
      expectedPressArrivals += 1;
      expect(pressArrivals.slice(before)).toEqual([`POST ${PRESS_CREATE_PATH} name=approved-name&memo=approved-memo`]);
      expect(outcome.violations).toEqual([]);
    }, ROUND_TIMEOUT_MS);

    it.each<[PressChange, string]>([
      ['moveButtonToBSame', 'click'],
      ['formAttrToBSame', 'click'],
      // 送信ボタンそのものの click の受け手で移す（押す時点の確かめの click の受け手の後。送る form は submit の事象の的で確かめる）。
      ['moveButtonToBSame', 'click@go'],
      ['formAttrToBSame', 'click@go'],
    ])(
      'stops the press when the page gives the submit button to another form (%s at %s), and nothing reaches the server',
      async (change, when) => {
        const before = pressArrivals.length;
        const outcome = await runOnce(change, when);
        expect(outcome.filled).toEqual({ ok: true });
        expect(outcome.submitted?.ok).toBe(false);
        expect(outcome.report.submission).toBe('NOT_SENT');
        expect(pressArrivals.slice(before)).toEqual([]);
      },
      ROUND_TIMEOUT_MS,
    );

    it('does not tell SUBMITTED when the press did not start a submission (another button laid over at the pointerdown)', async () => {
      const before = pressArrivals.length;
      const outcome = await runOnce('overlay', 'pointerdown');
      expect(outcome.filled).toEqual({ ok: true });
      expect(outcome.report.submission).toBe('NOT_SENT');
      expect(outcome.submitted?.ok).toBe(false);
      expect(pressArrivals.slice(before)).toEqual([]);
    }, ROUND_TIMEOUT_MS);
  });

  it('after all the rounds, no POST arrives late', async () => {
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(posts()).toBe(expectedPosts);
    // 3 つの送信と、DEF-237 の前に要素が足される画面の 1 つと、DEF-114 の入れ替え・focus の回で届いた分（focus の回は 1 つ以上）。
    expect(expectedPosts).toBeGreaterThanOrEqual(5);
    // FIX-237: 何もしない画面の 1 回だけ。
    expect(pressArrivals).toHaveLength(expectedPressArrivals);
    expect(expectedPressArrivals).toBe(1);
  }, ROUND_TIMEOUT_MS);
});

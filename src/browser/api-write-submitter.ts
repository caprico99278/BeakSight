/**
 * API のシナリオの書き込みの、入力と押下の部品（T39d。Task 39 の設計書 3.5、Task 38 の設計書 3.6）。ページの入力の欄に値を入れる操作を使ってよい
 * ファイルの閉じた一覧（`tests/architecture/worker-login-hooks.test.ts` の (q)）の 1 つ。書き込みの段の口（`WriteStageMonitor`）を参照してよい一覧
 * （`tests/architecture/write-stage-boundary.test.ts` の (c)）にも入れる。
 * 書き込みの form の部品（`write-form-submitter.ts`）は action のある form の POST を前提に、form の欄の一覧と送信ボタンの形を確かめるので、広げずに
 * 別のファイルにした。form のない画面（`BUTTON` の候補）と、`NEEDS_BINDING` の form（`FORM` の候補。ページの JS が送る）の両方を扱う。
 *
 * 1. `inspectApiWriteInput`（入力の前の確かめ。値を入れない）:
 *    - 送信の要素: 画面を isolated world で読み直し（発見の probe `probePageCandidates`）、probe の時の候補の識別の digest（`submitterIdentityDigest`。
 *      `FORM` は送信の要素、`BUTTON` はその要素。UPDATE では、呼ぶ側が書き込みの画面の path で求めた digest を渡す）の候補がちょうど 1 つで、送信の要素の
 *      位置があること（0 なら `SUBMITTER_NOT_FOUND`、2 以上なら `SUBMITTER_AMBIGUOUS`）。要素か祖先（shadow root では host）に `href` があれば
 *      `SUBMITTER_INSIDE_LINK`（押すとページが移りうる。部品 `StandardReaders.hasLinkAncestor`）。
 *    - 欄: `NAME`（`name` の属性が同じ `input`・`textarea`・`select`）か `SELECTOR`（その CSS）で、文書と open な shadow root の中を探し（部品
 *      `openRoots`・`queryAllInRoots`）、ちょうど 1 つ（`FIELD_NOT_FOUND`・`FIELD_AMBIGUOUS`）、入れられる種類（text 系の `input`・`textarea`・`select`。
 *      `FIELD_TYPE_NOT_SUPPORTED`）、見える（`FIELD_NOT_VISIBLE`）、編集できる（disabled・readonly でない。`FIELD_NOT_EDITABLE`）。2 つの指定が同じ欄に
 *      当たる・CSS が標準の CSS でないのは `SPEC_INVALID`。
 *    - 読み取りは isolated world（`readElementsInIsolatedWorld`。標準の getter で読み、ページの JS は偽れない）。値は読まない。
 * 2. `fillApiWriteInput`: 書き込みの段の送信の窓を開き（`WriteStageMonitor.openSubmissionWindow`。値を入れ始める前。書き込みの form の部品と同じ開き方）、
 *    確かめた要素に合図の受け手を付けて（`withSignaledElements`。位置の要素が確かめた要素のときだけ要素を返す。入れ替わっていれば `ELEMENT_CHANGED`）、
 *    text 系と `textarea` は `fill`、`select` は値で選ぶ（probe と同じ入れ方。ページが決める鍵の欄は指定に入らないので、何も入れない）。入れた後に、
 *    DOM の欄の値を読み直し（確かめた要素を backendNodeId で解決して isolated world で読む）、入れた値のまま（`sameValue`）でなければ `VALUE_CHANGED`。
 *    T40R-fix-A: このとき開くのは窓の観察の段（承認の形の要求も Guard が通さずに止めて数える）。
 * 3. `submitApiWriteInput`: 押す直前に、値をもう一度読み直し（違えば押さずに `VALUE_CHANGED`）、T40R-fix-A から、値を入れたときの部品で送信の窓の送信の段を
 *    開いて（`WriteStageMonitor.openSubmissionPhase`。開けなければ押さない）、送信の要素を Playwright の `click` で押す（押した後の
 *    ナビゲーションは待たない）。押した後の失敗は `SUBMIT_FAILED`（`clickAttempted: true`。送信が分からない）。押した後（押そうとした後）は、同じ確かめで
 *    2 回押さない。
 * 例外を投げない。Playwright の誤りの文には値が入りうるので、誤りは捨てて理由の語だけを返す。値はどこにも記録しない。
 */
import type { Page } from 'playwright';
import type { ApiFieldIdentity } from '../core/api-field-identity.js';
import { isRecord } from '../core/guards.js';
import { isSha256Fingerprint } from '../core/ids.js';
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';
import { CANDIDATE_FIELD_TYPES, SELECT_FIELD_TYPES } from '../discovery/candidate-contracts.js';
import { probedCandidateIdentityDigestOf } from '../discovery/discover-page.js';
import { cssStringOf } from '../discovery/entry-check-selectors.js';
import {
  readElementInIsolatedWorld,
  readElementsInIsolatedWorld,
  readInIsolatedWorld,
  withSignaledElements,
  type InPageElementsResult,
} from '../discovery/isolated-read.js';
import { locationOfUrl, probePageCandidates } from '../discovery/probe.js';
import {
  DISCOVERY_SETTLE_POLICY,
  waitForDiscoverySettled,
  type DiscoverySettlePolicy,
  type QuietSource,
} from '../discovery/settle.js';
import { SUBMISSION_PROBE_FILL_FIELD_TYPES } from '../discovery/submission-probe-contracts.js';
import type { WriteStageMonitor } from '../safety/passive-request-guard.js';
import { elementPathSelectorOf, ensureElementPathEngine } from './element-path-engine.js';
import { FORM_STEP_TIMEOUT_MS, sameValue } from './form-submission-common.js';
import { composeInPage, type StandardReaders } from './in-page-readers.js';

/** 読む・入れる・押す、それぞれの時間の上限（ms。フォームの入力の部品と同じ値）。 */
export const API_WRITE_STEP_TIMEOUT_MS = FORM_STEP_TIMEOUT_MS;

/**
 * 止めた理由（閉じた一覧。確かめの理由、入力と押下の理由の順。文言は `src/presentation/messages.ts` の `API_WRITE_INPUT_REASON_DESCRIPTIONS`）。
 * - `SPEC_INVALID`: 指定が正しくない（欄がない、識別の形の誤り、同じ欄を 2 回指定、標準の CSS でない、digest の形の誤り、確かめの後でない入力と押下）。
 * - `PAGE_UNREADABLE`: 画面を読めなかった（期限、読む間の移動、形の誤り）。
 * - `FIELD_NOT_FOUND`・`FIELD_AMBIGUOUS`・`FIELD_TYPE_NOT_SUPPORTED`・`FIELD_NOT_VISIBLE`・`FIELD_NOT_EDITABLE`: 欄の確かめ。
 * - `SUBMITTER_NOT_FOUND`・`SUBMITTER_AMBIGUOUS`・`SUBMITTER_INSIDE_LINK`: 送信の要素の確かめ。
 * - `ELEMENT_CHANGED`: 入れる・押すときに、確かめた要素が入れ替わっていた（合図の受け手を付けられない、位置の要素が違う）。
 * - `INPUT_FAILED`: Playwright の入力の操作が失敗した。
 * - `VALUE_CHANGED`: 入れた後か押す直前に読み直した値が、入れた値と違う（ページの JS の書き換え）。押さない。
 * - `SUBMIT_FAILED`: 押す操作が失敗した（押したかは分からない）。
 */
export const API_WRITE_INPUT_REASONS = Object.freeze([
  'SPEC_INVALID',
  'PAGE_UNREADABLE',
  'FIELD_NOT_FOUND',
  'FIELD_AMBIGUOUS',
  'FIELD_TYPE_NOT_SUPPORTED',
  'FIELD_NOT_VISIBLE',
  'FIELD_NOT_EDITABLE',
  'SUBMITTER_NOT_FOUND',
  'SUBMITTER_AMBIGUOUS',
  'SUBMITTER_INSIDE_LINK',
  'ELEMENT_CHANGED',
  'INPUT_FAILED',
  'VALUE_CHANGED',
  'SUBMIT_FAILED',
] as const);
export type ApiWriteInputReason = (typeof API_WRITE_INPUT_REASONS)[number];

/**
 * 欄の識別（`name` があれば名前、なければその画面で一意な CSS。シナリオの `api.keyFields[].field` と同じ型。値は持たない）。CC-102: 契約の owner は
 * `src/core/api-field-identity.ts`（シナリオの契約と共有する）。ここは公開し直すだけ。
 */
export type ApiWriteFieldIdentity = ApiFieldIdentity;

/** 入れる欄 1 つ（欄の識別と、生成した値。ページが決める鍵は入れない）。 */
export interface ApiWriteInputField {
  readonly field: ApiWriteFieldIdentity;
  readonly value: string;
}

/** 入力と押下の指定。 */
export interface ApiWriteInputSpec {
  /** 押す送信の要素の候補の識別の digest（probe の時の候補。書き込みの画面の path で求めたもの）。 */
  readonly submitterIdentityDigest: string;
  /** 入れる欄（1 つ以上）。 */
  readonly fields: readonly ApiWriteInputField[];
}

/** 確かめの結果の手がかり（中身は、このファイルの中だけで持つ）。 */
export interface InspectedApiWriteInput {
  readonly fieldCount: number;
}

export type ApiWriteInputInspection = { readonly ok: true; readonly input: InspectedApiWriteInput } | { readonly ok: false; readonly reason: ApiWriteInputReason };
export type ApiWriteInputStep = { readonly ok: true } | { readonly ok: false; readonly reason: ApiWriteInputReason };
export type ApiWriteSubmission = { readonly ok: true } | { readonly ok: false; readonly reason: ApiWriteInputReason; readonly clickAttempted: boolean };

/** 確かめた要素（送信の要素と欄の位置と backendNodeId、欄の種類と値）。 */
interface InspectedState {
  readonly paths: readonly (readonly number[])[];
  readonly backendNodeIds: readonly number[];
  readonly kinds: readonly ('FILL' | 'SELECT')[];
  readonly values: readonly string[];
}

const inspectedStates = new WeakMap<InspectedApiWriteInput, InspectedState>();

/** T40R-fix-A: 値を入れたときに送信の窓を開いた、書き込みの段の部品（押す直前に、同じ部品で送信の段を開く）。 */
const windowMonitors = new WeakMap<InspectedApiWriteInput, WriteStageMonitor>();

/** ページの中の読み取りの入力（外を参照できないので、値はすべてここで渡す）。 */
interface ScopeInput {
  readonly submitterPath: readonly number[];
  readonly selectors: readonly { readonly css: string; readonly fieldsOnly: boolean }[];
  readonly visibilityOptions: CheckVisibilityOptions;
  readonly fieldTypes: readonly string[];
  readonly fillTypes: readonly string[];
  readonly selectTypes: readonly string[];
}

/** 欄 1 つの読み取りの結果（`status` は理由か `OK`）。 */
interface ScopeFieldFacts {
  readonly status: string;
  readonly kind: 'FILL' | 'SELECT' | null;
}

/**
 * 送信の要素と欄を読む（ページの中で動く。標準の getter とメソッドで読み、ページに何も書かない。値は読まない）。要素の参照は、送信の要素と欄
 * （どれもちょうど 1 つのときだけ）。
 */
const readApiWriteScopeInPage = composeInPage((R: StandardReaders, input: ScopeInput): InPageElementsResult => {
  const localNameOf = R.standardGetter<string>(Element.prototype, 'localName');
  const inputTypeOf = R.standardGetter<string>(HTMLInputElement.prototype, 'type');
  const selectTypeOf = R.standardGetter<string>(HTMLSelectElement.prototype, 'type');
  const inputReadOnlyOf = R.standardGetter<boolean>(HTMLInputElement.prototype, 'readOnly');
  const textAreaReadOnlyOf = R.standardGetter<boolean>(HTMLTextAreaElement.prototype, 'readOnly');
  const submitter = R.elementAtPath(input.submitterPath);
  if (submitter === null) {
    return { value: { submitter: 'SUBMITTER_NOT_FOUND', fields: [] }, elements: [] };
  }
  const insideLink = Element.prototype.hasAttribute.call(submitter, 'href') || R.hasLinkAncestor(submitter);
  const roots = R.openRoots();
  const found: Element[] = [];
  const fields: { status: string; kind: 'FILL' | 'SELECT' | null }[] = [];
  for (let index = 0; index < input.selectors.length; index += 1) {
    const spec = input.selectors[index];
    if (spec === undefined) {
      fields.push({ status: 'SPEC_INVALID', kind: null });
      continue;
    }
    let nodes: Node[];
    try {
      nodes = R.queryAllInRoots(roots, spec.css);
    } catch {
      fields.push({ status: 'SPEC_INVALID', kind: null });
      continue;
    }
    const matches = nodes.filter((node): node is Element => node instanceof Element
      && (!spec.fieldsOnly || ['input', 'textarea', 'select'].includes(localNameOf(node))));
    if (matches.length === 0) {
      fields.push({ status: 'FIELD_NOT_FOUND', kind: null });
      continue;
    }
    if (matches.length > 1) {
      fields.push({ status: 'FIELD_AMBIGUOUS', kind: null });
      continue;
    }
    const element = matches[0] as Element;
    if (found.includes(element)) {
      fields.push({ status: 'SPEC_INVALID', kind: null });
      continue;
    }
    const name = localNameOf(element);
    const type = name === 'input' ? inputTypeOf(element) : (name === 'textarea' ? 'textarea' : (name === 'select' ? selectTypeOf(element) : ''));
    const kind = input.fillTypes.includes(type) ? 'FILL' : (input.selectTypes.includes(type) ? 'SELECT' : null);
    if (kind === null || !input.fieldTypes.includes(type)) {
      fields.push({ status: 'FIELD_TYPE_NOT_SUPPORTED', kind: null });
      continue;
    }
    if (!Element.prototype.checkVisibility.call(element, input.visibilityOptions)) {
      fields.push({ status: 'FIELD_NOT_VISIBLE', kind });
      continue;
    }
    const readOnly = name === 'input' ? inputReadOnlyOf(element) : (name === 'textarea' ? textAreaReadOnlyOf(element) : false);
    if (Element.prototype.matches.call(element, ':disabled') || readOnly) {
      fields.push({ status: 'FIELD_NOT_EDITABLE', kind });
      continue;
    }
    found.push(element);
    fields.push({ status: 'OK', kind });
  }
  const allFound = found.length === input.selectors.length;
  return {
    value: { submitter: insideLink ? 'SUBMITTER_INSIDE_LINK' : 'OK', fields },
    elements: allFound && !insideLink ? [submitter, ...found] : [],
  };
});

/** 欄の値を読む（ページの中で動く。backendNodeId で解決した要素。標準の getter で読む）。 */
const readFieldValueInPage = composeInPage((R: StandardReaders, element: Element): string | null => {
  const name = R.standardGetter<string>(Element.prototype, 'localName')(element);
  if (name === 'input') return R.standardGetter<string>(HTMLInputElement.prototype, 'value')(element);
  if (name === 'textarea') return R.standardGetter<string>(HTMLTextAreaElement.prototype, 'value')(element);
  if (name === 'select') return R.standardGetter<string>(HTMLSelectElement.prototype, 'value')(element);
  return null;
});

const SCOPE_INPUT_BASE = Object.freeze({
  visibilityOptions: VISIBILITY_CHECK_OPTIONS,
  fieldTypes: CANDIDATE_FIELD_TYPES,
  fillTypes: SUBMISSION_PROBE_FILL_FIELD_TYPES,
  selectTypes: SELECT_FIELD_TYPES,
});

/** 欄の識別から、探す CSS（`NAME` は名前の属性。欄の要素だけに絞る）。形が違えば null。 */
const cssOf = (identity: unknown): { readonly css: string; readonly fieldsOnly: boolean } | null => {
  if (!isRecord(identity)) return null;
  if (identity['kind'] === 'NAME' && typeof identity['name'] === 'string' && identity['name'].length > 0) {
    return { css: `[name=${cssStringOf(identity['name'])}]`, fieldsOnly: true };
  }
  if (identity['kind'] === 'SELECTOR' && typeof identity['selector'] === 'string' && identity['selector'].length > 0) {
    return { css: identity['selector'], fieldsOnly: false };
  }
  return null;
};

const isReason = (value: unknown): value is ApiWriteInputReason =>
  typeof value === 'string' && (API_WRITE_INPUT_REASONS as readonly string[]).includes(value);

/** 送信の要素の位置（probe の候補の識別の digest で、ちょうど 1 つ）。 */
async function submitterPathOf(page: Page, digest: string, deadlineAtMs: number): Promise<{ readonly path: readonly number[] } | { readonly reason: ApiWriteInputReason }> {
  const probe = await probePageCandidates(page, deadlineAtMs);
  if (probe.status !== 'READ') {
    return { reason: 'PAGE_UNREADABLE' };
  }
  const { location, url } = locationOfUrl(page.url());
  if (url === null) {
    return { reason: 'PAGE_UNREADABLE' };
  }
  const matches = probe.candidates.filter((candidate) => probedCandidateIdentityDigestOf(location, candidate) === digest);
  const [only] = matches;
  if (only === undefined) {
    return { reason: 'SUBMITTER_NOT_FOUND' };
  }
  if (matches.length > 1) {
    return { reason: 'SUBMITTER_AMBIGUOUS' };
  }
  const path = only.submitter?.path;
  return path === undefined || path.some((step) => step < 0) ? { reason: 'SUBMITTER_NOT_FOUND' } : { path };
}

/** 入力の前の確かめ（ファイルの先頭の 1）。例外を投げない。 */
async function inspectWithin(page: Page, spec: ApiWriteInputSpec, timeoutMs: number): Promise<ApiWriteInputInspection> {
  if (!isRecord(spec) || typeof spec.submitterIdentityDigest !== 'string' || !isSha256Fingerprint(spec.submitterIdentityDigest)
    || !Array.isArray(spec.fields) || spec.fields.length === 0) {
    return { ok: false, reason: 'SPEC_INVALID' };
  }
  const selectors = spec.fields.map((entry) => (isRecord(entry) && typeof entry.value === 'string' ? cssOf(entry.field) : null));
  if (selectors.some((selector) => selector === null)) {
    return { ok: false, reason: 'SPEC_INVALID' };
  }
  // 要素の位置の engine は、factory が page を作る前に登録する（DEF-134-fix）。ここでも登録を確かめる（重ねの守り。登録の済んだ後は同じ約束を返す）。
  await ensureElementPathEngine();
  const deadlineAtMs = Date.now() + timeoutMs;
  const submitter = await submitterPathOf(page, spec.submitterIdentityDigest, deadlineAtMs);
  if ('reason' in submitter) {
    return { ok: false, reason: submitter.reason };
  }
  const outcome = await readElementsInIsolatedWorld(page, readApiWriteScopeInPage, {
    ...SCOPE_INPUT_BASE,
    submitterPath: submitter.path,
    selectors: selectors as readonly { readonly css: string; readonly fieldsOnly: boolean }[],
  }, deadlineAtMs);
  if (outcome.status !== 'READ' || !isRecord(outcome.value) || !Array.isArray(outcome.value['fields'])
    || outcome.value['fields'].length !== spec.fields.length) {
    return { ok: false, reason: 'PAGE_UNREADABLE' };
  }
  const submitterStatus = outcome.value['submitter'];
  if (submitterStatus !== 'OK') {
    return { ok: false, reason: isReason(submitterStatus) ? submitterStatus : 'PAGE_UNREADABLE' };
  }
  const facts = outcome.value['fields'] as readonly unknown[];
  for (const fact of facts) {
    const status = isRecord(fact) ? fact['status'] : undefined;
    if (status !== 'OK') {
      return { ok: false, reason: isReason(status) ? status : 'PAGE_UNREADABLE' };
    }
  }
  const paths = outcome.elements.map(({ path }) => path);
  if (outcome.elements.length !== spec.fields.length + 1 || paths.some((path) => path === null)) {
    return { ok: false, reason: 'PAGE_UNREADABLE' };
  }
  const kinds = facts.map((fact) => (isRecord(fact) && fact['kind'] === 'SELECT' ? 'SELECT' : 'FILL') as 'FILL' | 'SELECT');
  const input: InspectedApiWriteInput = Object.freeze({ fieldCount: spec.fields.length });
  inspectedStates.set(input, Object.freeze({
    paths: Object.freeze(paths as readonly (readonly number[])[]),
    backendNodeIds: Object.freeze(outcome.elements.map(({ backendNodeId }) => backendNodeId)),
    kinds: Object.freeze(kinds),
    values: Object.freeze(spec.fields.map(({ value }) => value)),
  }));
  return { ok: true, input };
}

// ---------------------------------------------------------------------------------------------------------------
// T41d（Task 41 の設計書 3.4 の 1）: 欄の識別で、欄の今の値を読む（API の更新の前の読み取りと後の照合）
// ---------------------------------------------------------------------------------------------------------------

/** T41d: 値の落ち着きを確かめる間隔（ms。間隔を置いた 2 回の読み取りが同じなら落ち着いたとする）。 */
export const API_WRITE_VALUE_SETTLE_INTERVAL_MS = 500;
/** T41d: 値の落ち着きを確かめる読み取りの上限の回数（超えたら読めなかったとする。上限の待ちは間隔 × (回数 − 1)）。 */
export const API_WRITE_VALUE_SETTLE_MAX_READS = 10;

/** T41d: 欄の値の読み取りの結果（欄の識別の順の値。値はメモリの中だけで扱い、記録しない）。 */
export type ApiWriteFieldValues = { readonly ok: true; readonly values: readonly string[] } | { readonly ok: false; readonly reason: ApiWriteInputReason };

/** 欄 1 つの値の読み取り（ページの中の結果。`status` は理由か `OK`）。 */
interface FieldValueFact {
  readonly status: string;
  readonly value: string | null;
}

/**
 * 欄の値を読む（ページの中で動く。標準の getter で読み、ページに何も書かない）。欄は、文書と open な shadow root の中でちょうど 1 つ（form の外も）、
 * 入れられる種類（text 系の `input`・`textarea`・`select`）であること。見える・編集できるかは問わない（保つ欄が readonly でも読む）。
 */
const readApiFieldValuesInPage = composeInPage((R: StandardReaders, input: {
  readonly selectors: readonly { readonly css: string; readonly fieldsOnly: boolean }[];
  readonly fillTypes: readonly string[];
  readonly selectTypes: readonly string[];
}): readonly FieldValueFact[] => {
  const localNameOf = R.standardGetter<string>(Element.prototype, 'localName');
  const inputTypeOf = R.standardGetter<string>(HTMLInputElement.prototype, 'type');
  const selectTypeOf = R.standardGetter<string>(HTMLSelectElement.prototype, 'type');
  const inputValueOf = R.standardGetter<string>(HTMLInputElement.prototype, 'value');
  const textAreaValueOf = R.standardGetter<string>(HTMLTextAreaElement.prototype, 'value');
  const selectValueOf = R.standardGetter<string>(HTMLSelectElement.prototype, 'value');
  const roots = R.openRoots();
  return input.selectors.map((spec): FieldValueFact => {
    let nodes: Node[];
    try {
      nodes = R.queryAllInRoots(roots, spec.css);
    } catch {
      return { status: 'SPEC_INVALID', value: null };
    }
    const matches = nodes.filter((node): node is Element => node instanceof Element
      && (!spec.fieldsOnly || ['input', 'textarea', 'select'].includes(localNameOf(node))));
    if (matches.length === 0) return { status: 'FIELD_NOT_FOUND', value: null };
    if (matches.length > 1) return { status: 'FIELD_AMBIGUOUS', value: null };
    const element = matches[0] as Element;
    const name = localNameOf(element);
    if (name === 'textarea') return { status: 'OK', value: textAreaValueOf(element) };
    if (name === 'select' && input.selectTypes.includes(selectTypeOf(element))) return { status: 'OK', value: selectValueOf(element) };
    if (name === 'input' && input.fillTypes.includes(inputTypeOf(element))) return { status: 'OK', value: inputValueOf(element) };
    return { status: 'FIELD_TYPE_NOT_SUPPORTED', value: null };
  });
});

/** 欄の値を 1 回読む（落ち着きは待たない）。例外を投げない。 */
async function readFieldValuesOnce(page: Page, fields: readonly ApiWriteFieldIdentity[], timeoutMs: number): Promise<ApiWriteFieldValues> {
  if (!Array.isArray(fields) || fields.length === 0) {
    return { ok: false, reason: 'SPEC_INVALID' };
  }
  const selectors = fields.map(cssOf);
  if (selectors.some((selector) => selector === null)) {
    return { ok: false, reason: 'SPEC_INVALID' };
  }
  try {
    const read = await readInIsolatedWorld(page, readApiFieldValuesInPage, {
      selectors: selectors as readonly { readonly css: string; readonly fieldsOnly: boolean }[],
      fillTypes: SUBMISSION_PROBE_FILL_FIELD_TYPES,
      selectTypes: SELECT_FIELD_TYPES,
    }, Date.now() + timeoutMs);
    if (read.status !== 'READ' || !Array.isArray(read.value) || read.value.length !== fields.length) {
      return { ok: false, reason: 'PAGE_UNREADABLE' };
    }
    const values: string[] = [];
    for (const fact of read.value as readonly unknown[]) {
      const status = isRecord(fact) ? fact['status'] : undefined;
      if (status !== 'OK' || !isRecord(fact) || typeof fact['value'] !== 'string') {
        return { ok: false, reason: isReason(status) ? status : 'PAGE_UNREADABLE' };
      }
      values.push(fact['value']);
    }
    return { ok: true, values: Object.freeze(values) };
  } catch {
    return { ok: false, reason: 'PAGE_UNREADABLE' };
  }
}

/**
 * T41d: 値が落ち着くまで読む（純粋な手順。読み取りと待ちは引数で受ける）。間隔（`intervalMs`）を置いて 2 回読み、同じ（位置と数も）になったら、その値を返す。
 * 読めない誤りはそのまま返す。上限の回数（`maxReads`）まで落ち着かなければ `PAGE_UNREADABLE`（読めなかったとする。送らない側に倒す）。
 * 限界: 間隔より長く遅れて値を入れるページは、入れる前の値で落ち着いたと見えうる（書き込みの段で開き直した画面の値と照らし、違えば送らない）。
 */
export async function settledFieldValues(
  read: () => Promise<ApiWriteFieldValues>,
  waitFor: (ms: number) => Promise<void>,
  intervalMs = API_WRITE_VALUE_SETTLE_INTERVAL_MS,
  maxReads = API_WRITE_VALUE_SETTLE_MAX_READS,
): Promise<ApiWriteFieldValues> {
  const first = await read();
  if (!first.ok) {
    return first;
  }
  let previous: readonly string[] = first.values;
  for (let reads = 1; reads < maxReads; reads += 1) {
    await waitFor(intervalMs);
    const current = await read();
    if (!current.ok) {
      return current;
    }
    const before = previous;
    if (current.values.length === before.length && current.values.every((value, index) => value === before[index])) {
      return current;
    }
    previous = current.values;
  }
  return { ok: false, reason: 'PAGE_UNREADABLE' };
}

/** T41R-fix: 値の組を、落ち着きの待ちの集合の形にする（位置を付けて、順と数も比べる）。 */
const settleSetOf = (values: readonly string[]): readonly string[] => values.map((value, index) => `${String(index)}:${JSON.stringify(value)}`);

/**
 * T41R2-fix（設計書 8 章の「T41R2」の (3)）: 欄の値の読み取りで、要求が止むのを待つ上限（ms）。発見の落ち着きの上限（`DISCOVERY_SETTLE_TIMEOUT_MS`）より
 * 短い（前の読み取りと後の照合は、その前に画面の候補の落ち着きを待っている）。上限に届いたら、間隔を置いた 2 回の読み取りの落ち着きで進む。
 */
export const API_WRITE_VALUE_QUIET_TIMEOUT_MS = 3_000;

/** T41R2-fix: 欄の値の、要求が止むのを待つ落ち着きの指定（上限のほかは発見と同じ）。 */
const API_WRITE_VALUE_QUIET_POLICY: DiscoverySettlePolicy = Object.freeze({ ...DISCOVERY_SETTLE_POLICY, timeoutMs: API_WRITE_VALUE_QUIET_TIMEOUT_MS });

/** 時間を待つ（ms）。 */
const waitMs = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));

/**
 * T41R-fix（Task 41 の設計書 8 章の「T41R の途中の報告」の (1)）: 要求が止んだ後に落ち着いた値を読む。落ち着きの判定は発見と READ の owner の部品
 * （`waitForDiscoverySettled`。進行中の要求がなく、最後の終わりから静かな時間が過ぎ、2 回続けて同じ集合）で、集合は位置を付けた値（`settleSetOf`）。
 * 落ち着いたら、最後の読み取りの値を返す。
 * T41R2-fix（同じ章の「T41R2」の (3)）: 上限（`API_WRITE_VALUE_QUIET_TIMEOUT_MS`）までに落ち着かなければ（開いたままの要求がある realtime の SPA など）、
 * 止めずに、間隔を置いた 2 回の読み取りの落ち着き（`settledFieldValues`）で進む。値が入る前の値は、呼ぶ側の確かめ（台帳が知る保つ鍵の値）で止める。
 * T41R3-fix（M-1）: 上限に届いたとき、要求がまだ止んでいなければ（静かな時間に届いていない）、`onQuietTimedOut` で知らせる（呼ぶ側が、同じ画面の残りの
 * 読み取りで待ちを省くため）。
 */
export async function settledFieldValuesWhenQuiet(
  source: QuietSource,
  read: () => Promise<ApiWriteFieldValues>,
  policy: DiscoverySettlePolicy = API_WRITE_VALUE_QUIET_POLICY,
  waitFor: (ms: number) => Promise<void> = waitMs,
  onQuietTimedOut?: () => void,
): Promise<ApiWriteFieldValues> {
  const state: { last: ApiWriteFieldValues } = { last: { ok: false, reason: 'PAGE_UNREADABLE' } };
  const settled = await waitForDiscoverySettled(source, async () => {
    const current = await read();
    state.last = current;
    return current.ok ? settleSetOf(current.values) : null;
  }, policy);
  if (settled.status === 'SETTLED' && state.last.ok) {
    return state.last;
  }
  const quietSince = source.quietSinceMs();
  if (quietSince === null || Date.now() - quietSince < policy.networkQuietMs) {
    onQuietTimedOut?.();
  }
  return settledFieldValues(read, waitFor);
}

/** T41R3-fix: 欄の値の読み取りの、要求が止む待ちの指定（数え方と、上限に届いたときの知らせ）。 */
export interface ApiWriteValueQuiet {
  readonly source: QuietSource;
  readonly onQuietTimedOut?: (() => void) | undefined;
}

/**
 * T41d: 欄の識別（`NAME`・`SELECTOR`）で、欄の今の値を、落ち着くまで待って読む。値はメモリの中だけで扱い、記録しない。例外を投げない。欄がない・2 つ以上・
 * 入れられない種類は、その理由（`FIELD_NOT_FOUND`・`FIELD_AMBIGUOUS`・`FIELD_TYPE_NOT_SUPPORTED`）。
 * T41R-fix: 進行中の要求の数え方（`quiet.source`。画面を読み込む前に作った `InFlightRequestCounter`）を渡せば、要求が止んだ後に落ち着いた値を読む
 * （`settledFieldValuesWhenQuiet`。T41R3-fix: 上限に届いたら `quiet.onQuietTimedOut` で知らせる）。渡さなければ、間隔を置いた 2 回の読み取り
 * （`settledFieldValues`。要求が止む待ちを省く読み取りにも使う）。
 */
export function readApiWriteFieldValues(
  page: Page,
  fields: readonly ApiWriteFieldIdentity[],
  quiet?: ApiWriteValueQuiet,
  timeoutMs = API_WRITE_STEP_TIMEOUT_MS,
): Promise<ApiWriteFieldValues> {
  const read = (): Promise<ApiWriteFieldValues> => readFieldValuesOnce(page, fields, timeoutMs);
  if (quiet !== undefined) {
    return settledFieldValuesWhenQuiet(quiet.source, read, API_WRITE_VALUE_QUIET_POLICY, waitMs, quiet.onQuietTimedOut);
  }
  return settledFieldValues(read, waitMs);
}

/** 入力の前の確かめ（値を入れない）。読めなければ `PAGE_UNREADABLE`。例外を投げない。 */
export async function inspectApiWriteInput(page: Page, spec: ApiWriteInputSpec, timeoutMs = API_WRITE_STEP_TIMEOUT_MS): Promise<ApiWriteInputInspection> {
  try {
    return await inspectWithin(page, spec, timeoutMs);
  } catch {
    return { ok: false, reason: 'PAGE_UNREADABLE' };
  }
}

/** 合図つきの Locator が、確かめた要素を指さない。 */
class SignaledElementMissing extends Error {}

/** 操作の結果（`CHANGED`: 確かめた要素が入れ替わった。`FAILED`: 操作そのものの失敗）。 */
type SignaledRun = { readonly status: 'DONE' } | { readonly status: 'CHANGED' } | { readonly status: 'FAILED' };

/** 確かめた要素に合図の受け手を付けて、位置の要素（0 は送信の要素、1 以降は欄）の Locator で `run` を動かす。Playwright の誤りの文は捨てる。 */
async function runOnInspected(
  page: Page,
  state: InspectedState,
  timeoutMs: number,
  run: (locate: (index: number) => Promise<ReturnType<Page['locator']>>) => Promise<void>,
): Promise<SignaledRun> {
  const outcome = await withSignaledElements(page, state.backendNodeIds, Date.now() + timeoutMs, async (signals) => {
    const locate = async (index: number): Promise<ReturnType<Page['locator']>> => {
      const path = state.paths[index];
      const signal = signals[index];
      if (path === undefined || signal === undefined) {
        throw new SignaledElementMissing();
      }
      const locator = page.locator(elementPathSelectorOf(path, signal));
      if (await locator.count() !== 1) {
        throw new SignaledElementMissing();
      }
      return locator;
    };
    await run(locate);
    return true;
  });
  if (outcome.status === 'DONE') {
    return { status: 'DONE' };
  }
  return outcome.error === undefined || outcome.error instanceof SignaledElementMissing ? { status: 'CHANGED' } : { status: 'FAILED' };
}

/** 欄の今の値が、入れた値のままか（確かめた要素を backendNodeId で解決して読む。読めなければ偽）。 */
async function valuesKept(page: Page, state: InspectedState, timeoutMs: number): Promise<boolean> {
  for (const [index, expected] of state.values.entries()) {
    const backendNodeId = state.backendNodeIds[index + 1];
    if (backendNodeId === undefined) {
      return false;
    }
    const read = await readElementInIsolatedWorld(page, backendNodeId, readFieldValueInPage, undefined, Date.now() + timeoutMs);
    if (read.status !== 'READ' || typeof read.value !== 'string' || !sameValue(read.value, expected)) {
      return false;
    }
  }
  return true;
}

/** 送信の窓を開き、確かめた欄に値を入れ、読み直す（ファイルの先頭の 2）。例外を投げない。 */
export async function fillApiWriteInput(
  page: Page,
  input: InspectedApiWriteInput,
  monitor: WriteStageMonitor,
  timeoutMs = API_WRITE_STEP_TIMEOUT_MS,
): Promise<ApiWriteInputStep> {
  const state = inspectedStates.get(input);
  if (state === undefined) {
    return { ok: false, reason: 'SPEC_INVALID' };
  }
  try {
    // T40R-fix-A: 開くのは窓の観察の段（値を入れる間。承認の形の要求も通さずに止めて数える）。送信の段は、押す直前に `submitApiWriteInput` が開く。
    await monitor.openSubmissionWindow(page);
    windowMonitors.set(input, monitor);
    const filled = await runOnInspected(page, state, timeoutMs, async (locate) => {
      for (const [index, value] of state.values.entries()) {
        const locator = await locate(index + 1);
        if (state.kinds[index] === 'SELECT') {
          await locator.selectOption({ value }, { timeout: timeoutMs });
        } else {
          await locator.fill(value, { timeout: timeoutMs });
        }
      }
    });
    if (filled.status === 'CHANGED') {
      return { ok: false, reason: 'ELEMENT_CHANGED' };
    }
    if (filled.status === 'FAILED') {
      return { ok: false, reason: 'INPUT_FAILED' };
    }
    return await valuesKept(page, state, timeoutMs) ? { ok: true } : { ok: false, reason: 'VALUE_CHANGED' };
  } catch {
    return { ok: false, reason: 'INPUT_FAILED' };
  }
}

/** 押す直前に値を読み直し、送信の要素を押す（ファイルの先頭の 3）。押した後のナビゲーションは待たない。例外を投げない。 */
export async function submitApiWriteInput(
  page: Page,
  input: InspectedApiWriteInput,
  timeoutMs = API_WRITE_STEP_TIMEOUT_MS,
): Promise<ApiWriteSubmission> {
  const state = inspectedStates.get(input);
  if (state === undefined) {
    return { ok: false, reason: 'SPEC_INVALID', clickAttempted: false };
  }
  try {
    if (!(await valuesKept(page, state, timeoutMs))) {
      return { ok: false, reason: 'VALUE_CHANGED', clickAttempted: false };
    }
    let clickAttempted = false;
    const clicked = await runOnInspected(page, state, timeoutMs, async (locate) => {
      const submitter = await locate(0);
      // T40R-fix-A（Task 40 の設計書 7 章の T40R の I-1）: 押す直前に、値を入れたときの部品で送信の窓の送信の段を開く（Guard が承認の形の要求を照合に
      // かけて 1 回だけ通すのは、この後だけ）。開けなければ（窓が開いていない、値を入れていない）押さない。
      const monitor = windowMonitors.get(input);
      if (monitor === undefined || !monitor.openSubmissionPhase()) {
        throw new SignaledElementMissing();
      }
      clickAttempted = true;
      await submitter.click({ timeout: timeoutMs, noWaitAfter: true });
    });
    if (clicked.status === 'DONE') {
      return { ok: true };
    }
    if (!clickAttempted) {
      return { ok: false, reason: 'ELEMENT_CHANGED', clickAttempted: false };
    }
    return { ok: false, reason: 'SUBMIT_FAILED', clickAttempted: true };
  } catch {
    return { ok: false, reason: 'SUBMIT_FAILED', clickAttempted: true };
  } finally {
    // 押した（押そうとした）後は、この確かめの結果を使わない（同じ確かめで 2 回押さない）。
    inspectedStates.delete(input);
  }
}

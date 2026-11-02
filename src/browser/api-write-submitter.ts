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
 *    OP-O（O2 の (a)・(c)）: 欄が作り直された（`ELEMENT_CHANGED`）・入れた値が戻った（`VALUE_CHANGED`）ときは、上限（`API_WRITE_FILL_MAX_ATTEMPTS`）の中で
 *    1 回だけ、同じ指定で確かめ直してから入れ直す（窓は開いたまま。確かめの決まりと、送る中身・回数は変えない）。入れ直しの形は、実験で `fill` の入れ直しに
 *    決めた（`pressSequentially` は、最初の入力を戻す形で 1 文字目を失い、入力の事象も文字の数だけ増える）。
 *    OP-O（O1）: 失敗は、欄の位置・欄の種類・属性の有無（`WRITE_INPUT_FIELD_ATTRIBUTES`）・値の変わり方の区分（`valueChangeKindOf`）を添えて返す（値は返さない）。
 * 3. `submitApiWriteInput`: 押す直前に、値をもう一度読み直し（違えば押さずに `VALUE_CHANGED`）、T40R-fix-A から、値を入れたときの部品で送信の窓の送信の段を
 *    開いて（`WriteStageMonitor.openSubmissionPhase`。開けなければ押さない）、送信の要素を Playwright の `click` で押す（押した後の
 *    ナビゲーションは待たない）。押した後の失敗は `SUBMIT_FAILED`（`clickAttempted: true`。送信が分からない）。押した後（押そうとした後）は、同じ確かめで
 *    2 回押さない。
 *    OP-P（P1・P2）: 押す前に、SPA が送信の要素か欄を作り直していた（`ELEMENT_CHANGED`。欄の読み直しは、文書から外れた古い要素の値を読まない）ときは、
 *    上限（`API_WRITE_SUBMIT_MAX_ATTEMPTS`）の中で 1 回だけ、待たずに、同じ指定で今の画面から確かめ直し（送信の要素は承認の識別の digest でちょうど 1 つ）、
 *    今の要素の値を読み直してから押す。値が入れた値のままでなければ、入れ直さずに押さない。押すのは 1 回だけ。
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
  DISCOVERY_SETTLE_TIMEOUT_MS,
  waitForDiscoverySettled,
  type DiscoverySettlePolicy,
  type QuietSource,
} from '../discovery/settle.js';
import { SUBMISSION_PROBE_FILL_FIELD_TYPES } from '../discovery/submission-probe-contracts.js';
import type { WriteStageMonitor } from '../safety/passive-request-guard.js';
import { elementPathSelectorOf, ensureElementPathEngine } from './element-path-engine.js';
import {
  FORM_STEP_TIMEOUT_MS,
  sameValue,
  valueChangeKindOf,
  WRITE_INPUT_FIELD_ATTRIBUTES,
  type WriteInputFieldAttribute,
  type WriteInputFieldFacts,
  type WriteInputValueChange,
} from './form-submission-common.js';
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

/**
 * OP-O（O1）: 失敗の細目（値と、値の長さは持たない。分かったときだけ持つ）。
 * - `fieldIndex`: 外れた欄の位置（指定の `fields` の順の 0 から。送信の要素や画面の誤りでは持たない）。
 * - `field`: その欄の種類と属性の有無（欄の要素を読めたときだけ）。
 * - `valueChange`: `VALUE_CHANGED` のときの、変わり方の区分（読み直した値を読めたときだけ）。
 */
export interface ApiWriteInputFailureDetail {
  readonly fieldIndex?: number;
  readonly field?: WriteInputFieldFacts;
  readonly valueChange?: WriteInputValueChange;
}

/**
 * 確かめの結果。OP-L（L1）: 欄の確かめで外れたときは、外れた欄の位置（`fieldIndex`。指定の `fields` の順の 0 から）も返す（値は返さない。送信の要素や画面の
 * 誤りでは持たない）。OP-O（O1）: 欄の要素を読めたときは、その種類と属性の有無（`field`）も返す。
 */
export type ApiWriteInputInspection =
  | { readonly ok: true; readonly input: InspectedApiWriteInput }
  | ({ readonly ok: false; readonly reason: ApiWriteInputReason } & ApiWriteInputFailureDetail);
/** OP-O（O1）: 入れる・押すときの失敗も、細目（欄の位置・種類と属性の有無・値の変わり方の区分）を返す。 */
export type ApiWriteInputStep = { readonly ok: true } | ({ readonly ok: false; readonly reason: ApiWriteInputReason } & ApiWriteInputFailureDetail);
export type ApiWriteSubmission =
  | { readonly ok: true }
  | ({ readonly ok: false; readonly reason: ApiWriteInputReason; readonly clickAttempted: boolean } & ApiWriteInputFailureDetail);

/** 確かめた要素（送信の要素と欄の位置と backendNodeId、欄の種類と値。OP-O: 確かめ直しのための指定と、記録のための欄の事実）。 */
interface InspectedState {
  readonly spec: ApiWriteInputSpec;
  readonly paths: readonly (readonly number[])[];
  readonly backendNodeIds: readonly number[];
  readonly kinds: readonly ('FILL' | 'SELECT')[];
  readonly values: readonly string[];
  readonly fields: readonly WriteInputFieldFacts[];
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
  /** OP-O（O1）: 有無を読む属性の名前（値は読まない）。 */
  readonly attributeNames: readonly string[];
}

/** 欄 1 つの読み取りの結果（`status` は理由か `OK`。OP-O: 欄の要素があれば、その種類と属性の有無）。 */
interface ScopeFieldFacts {
  readonly status: string;
  readonly kind: 'FILL' | 'SELECT' | null;
  readonly type?: string;
  readonly attributes?: readonly string[];
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
  const fields: ScopeFieldFacts[] = [];
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
    // OP-O（O1）: 欄の種類と、属性の有無（値は読まない）。
    const facts = { type, attributes: input.attributeNames.filter((attribute) => Element.prototype.hasAttribute.call(element, attribute)) };
    const kind = input.fillTypes.includes(type) ? 'FILL' : (input.selectTypes.includes(type) ? 'SELECT' : null);
    if (kind === null || !input.fieldTypes.includes(type)) {
      fields.push({ status: 'FIELD_TYPE_NOT_SUPPORTED', kind: null, ...facts });
      continue;
    }
    if (!Element.prototype.checkVisibility.call(element, input.visibilityOptions)) {
      fields.push({ status: 'FIELD_NOT_VISIBLE', kind, ...facts });
      continue;
    }
    const readOnly = name === 'input' ? inputReadOnlyOf(element) : (name === 'textarea' ? textAreaReadOnlyOf(element) : false);
    if (Element.prototype.matches.call(element, ':disabled') || readOnly) {
      fields.push({ status: 'FIELD_NOT_EDITABLE', kind, ...facts });
      continue;
    }
    found.push(element);
    fields.push({ status: 'OK', kind, ...facts });
  }
  const allFound = found.length === input.selectors.length;
  return {
    value: { submitter: insideLink ? 'SUBMITTER_INSIDE_LINK' : 'OK', fields },
    elements: allFound && !insideLink ? [submitter, ...found] : [],
  };
});

/**
 * 欄の値を読む（ページの中で動く。backendNodeId で解決した要素。標準の getter で読む）。OP-P（P2）: 文書から外れた要素（SPA が作り直した古い要素。
 * backendNodeId では、外れていても解決できて値を読める）は、値を読まずに `detached: true` を返す（古い要素の値で通さない）。
 */
const readFieldValueInPage = composeInPage((R: StandardReaders, element: Element): { readonly detached: boolean; readonly value: string | null } => {
  if (!R.standardGetter<boolean>(Node.prototype, 'isConnected')(element)) return { detached: true, value: null };
  const name = R.standardGetter<string>(Element.prototype, 'localName')(element);
  if (name === 'input') return { detached: false, value: R.standardGetter<string>(HTMLInputElement.prototype, 'value')(element) };
  if (name === 'textarea') return { detached: false, value: R.standardGetter<string>(HTMLTextAreaElement.prototype, 'value')(element) };
  if (name === 'select') return { detached: false, value: R.standardGetter<string>(HTMLSelectElement.prototype, 'value')(element) };
  return { detached: false, value: null };
});

const SCOPE_INPUT_BASE = Object.freeze({
  visibilityOptions: VISIBILITY_CHECK_OPTIONS,
  fieldTypes: CANDIDATE_FIELD_TYPES,
  fillTypes: SUBMISSION_PROBE_FILL_FIELD_TYPES,
  selectTypes: SELECT_FIELD_TYPES,
  attributeNames: WRITE_INPUT_FIELD_ATTRIBUTES,
});

/** OP-O（O1）: ページの中で読んだ欄の事実を、記録の形にする（種類は候補の欄の型の一覧の値だけ、属性は有無を読む属性の名前だけ。形が違えば持たない）。 */
const fieldFactsOf = (fact: unknown): WriteInputFieldFacts | undefined => {
  if (!isRecord(fact) || typeof fact['type'] !== 'string' || !Array.isArray(fact['attributes'])) {
    return undefined;
  }
  const type = (CANDIDATE_FIELD_TYPES as readonly string[]).includes(fact['type']) ? fact['type'] : null;
  const present = new Set((fact['attributes'] as readonly unknown[]).filter((attribute): attribute is string => typeof attribute === 'string'));
  return Object.freeze({ type, attributes: Object.freeze(WRITE_INPUT_FIELD_ATTRIBUTES.filter((attribute: WriteInputFieldAttribute) => present.has(attribute))) });
};

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
  for (const [fieldIndex, fact] of facts.entries()) {
    const status = isRecord(fact) ? fact['status'] : undefined;
    if (status !== 'OK') {
      const field = fieldFactsOf(fact);
      return isReason(status) ? { ok: false, reason: status, fieldIndex, ...(field === undefined ? {} : { field }) } : { ok: false, reason: 'PAGE_UNREADABLE' };
    }
  }
  const paths = outcome.elements.map(({ path }) => path);
  if (outcome.elements.length !== spec.fields.length + 1 || paths.some((path) => path === null)) {
    return { ok: false, reason: 'PAGE_UNREADABLE' };
  }
  const kinds = facts.map((fact) => (isRecord(fact) && fact['kind'] === 'SELECT' ? 'SELECT' : 'FILL') as 'FILL' | 'SELECT');
  const input: InspectedApiWriteInput = Object.freeze({ fieldCount: spec.fields.length });
  inspectedStates.set(input, Object.freeze({
    spec,
    paths: Object.freeze(paths as readonly (readonly number[])[]),
    backendNodeIds: Object.freeze(outcome.elements.map(({ backendNodeId }) => backendNodeId)),
    kinds: Object.freeze(kinds),
    values: Object.freeze(spec.fields.map(({ value }) => value)),
    fields: Object.freeze(facts.map((fact) => fieldFactsOf(fact) ?? Object.freeze({ type: null, attributes: null }))),
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

/**
 * OP-L（L1）: SPA が欄と送信の要素を後から描くのを待つ上限（ms）。発見の落ち着きの上限（`DISCOVERY_SETTLE_TIMEOUT_MS`。発見は、この画面の候補を、
 * 落ち着くのを待ってから読んだ）と同じ値にする。読み込みは足さない（同じ画面を読み直すだけ）。
 */
export const API_WRITE_INPUT_APPEAR_WAIT_MS = DISCOVERY_SETTLE_TIMEOUT_MS;
/** OP-L（L1）: 欄が出そろうのを待つ間に、確かめ直す間隔（ms。見出し・ログインの欄の待ちと同じ間隔）。 */
export const API_WRITE_INPUT_APPEAR_POLL_MS = 100;

/** OP-L（L1）: 後から描かれれば当たりうる、確かめの理由（欄・送信の要素がまだない・まだ見えない・まだ入れられない）。ほかの理由は待たない。 */
const LATE_RENDER_REASONS: ReadonlySet<ApiWriteInputReason> = new Set([
  'FIELD_NOT_FOUND',
  'FIELD_NOT_VISIBLE',
  'FIELD_NOT_EDITABLE',
  'SUBMITTER_NOT_FOUND',
]);

/**
 * OP-L（L1。指示書 OP-L の 1。OP-K の K1・K3 と同じ考え方）: 入力の前の確かめ（`inspectApiWriteInput`）を、欄と送信の要素が出そろうまで、上限
 * （`API_WRITE_INPUT_APPEAR_WAIT_MS`）の中で繰り返す。確かめは読むだけで、値を入れない・押さない・読み込まない。当たれば、その結果を返す。後から描かれれば
 * 当たりうる理由（`LATE_RENDER_REASONS`）でなければ、待たずに返す。上限を過ぎたら、最後の確かめの結果を返す（確かめの決まりは変えない）。例外を投げない。
 */
export async function inspectApiWriteInputWhenRendered(
  page: Page,
  spec: ApiWriteInputSpec,
  limitMs = API_WRITE_INPUT_APPEAR_WAIT_MS,
): Promise<ApiWriteInputInspection> {
  const deadlineAtMs = Date.now() + limitMs;
  for (;;) {
    const inspection = await inspectApiWriteInput(page, spec);
    if (inspection.ok || !LATE_RENDER_REASONS.has(inspection.reason) || page.isClosed()
      || Date.now() + API_WRITE_INPUT_APPEAR_POLL_MS >= deadlineAtMs) {
      return inspection;
    }
    await waitMs(API_WRITE_INPUT_APPEAR_POLL_MS);
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

/** 欄の値の読み直しで、入れた値のままでなかった欄（OP-P（P2）: `detached` は、確かめた要素が文書から外れていた（作り直された）こと）。 */
interface ChangedField {
  readonly index: number;
  readonly valueChange?: WriteInputValueChange;
  readonly detached?: true;
}

/**
 * 欄の今の値が、入れた値のままか（確かめた要素を backendNodeId で解決して読む）。OP-O（O1）: 違えば、最初の違う欄の位置と、変わり方の区分（読めなければ
 * 持たない）を返す（値は返さない）。すべて同じなら null。OP-P（P2）: 確かめた要素が文書から外れていれば、値を読まずに `detached` を返す（作り直された古い
 * 要素の値で通さない）。
 */
async function firstChangedValue(page: Page, state: InspectedState, timeoutMs: number): Promise<ChangedField | null> {
  for (const [index, expected] of state.values.entries()) {
    const backendNodeId = state.backendNodeIds[index + 1];
    if (backendNodeId === undefined) {
      return { index };
    }
    const read = await readElementInIsolatedWorld(page, backendNodeId, readFieldValueInPage, undefined, Date.now() + timeoutMs);
    if (read.status !== 'READ' || !isRecord(read.value)) {
      return { index };
    }
    if (read.value['detached'] === true) {
      return { index, detached: true };
    }
    const value = read.value['value'];
    if (typeof value !== 'string') {
      return { index };
    }
    if (!sameValue(value, expected)) {
      return { index, valueChange: valueChangeKindOf(expected, value) };
    }
  }
  return null;
}

/** OP-O（O1）: 欄の位置の失敗の細目（欄の位置と、確かめで読んだ種類と属性の有無）。 */
const fieldDetailOf = (state: InspectedState, index: number | null): ApiWriteInputFailureDetail => {
  if (index === null) {
    return {};
  }
  const field = state.fields[index];
  return field === undefined ? { fieldIndex: index } : { fieldIndex: index, field };
};

/** OP-O（O1）: 値を読み直して違ったときの失敗（理由は `VALUE_CHANGED`。欄の位置・事実と変わり方の区分を添える）。 */
const valueChangedOf = (
  state: InspectedState,
  changed: ChangedField,
): { readonly ok: false; readonly reason: 'VALUE_CHANGED' | 'ELEMENT_CHANGED' } & ApiWriteInputFailureDetail => (changed.detached === true
  // OP-P（P2）: 欄が作り直されて外れていた（値は読んでいない）。
  ? { ok: false, reason: 'ELEMENT_CHANGED', ...fieldDetailOf(state, changed.index) }
  : {
    ok: false,
    reason: 'VALUE_CHANGED',
    ...fieldDetailOf(state, changed.index),
    ...(changed.valueChange === undefined ? {} : { valueChange: changed.valueChange }),
  });

/**
 * OP-O（O2 の (a)・(c)）: 値を入れる回数の上限（最初の 1 回と、入れ直しの 1 回）。SPA が値を入れる途中で欄を作り直した（React の再描画。`ELEMENT_CHANGED`）、
 * 制御された入力が入れた値を戻した（`VALUE_CHANGED`）ときだけ、上限の中で 1 回だけ、確かめ直してから入れ直す。
 */
export const API_WRITE_FILL_MAX_ATTEMPTS = 2;
/** OP-O（O2）: 入れ直す前に、ページの描き直しが終わるのを待つ時間（ms。欄が出そろうのを待つ間に確かめ直す間隔と同じ）。 */
export const API_WRITE_REFILL_SETTLE_MS = API_WRITE_INPUT_APPEAR_POLL_MS;
/** OP-O（O2）: 入れ直してよい理由（ほかの理由は、入れ直さずに返す）。 */
const REFILL_REASONS: ReadonlySet<ApiWriteInputReason> = new Set(['ELEMENT_CHANGED', 'VALUE_CHANGED']);

/** 確かめた欄に値を 1 回入れ、読み直す（OP-O: 失敗は、欄の位置・事実と変わり方の区分を添える）。例外を投げない。 */
async function fillOnce(page: Page, state: InspectedState, timeoutMs: number): Promise<ApiWriteInputStep> {
  const progress: { current: number | null } = { current: null };
  const filled = await runOnInspected(page, state, timeoutMs, async (locate) => {
    for (const [index, value] of state.values.entries()) {
      progress.current = index;
      const locator = await locate(index + 1);
      if (state.kinds[index] === 'SELECT') {
        await locator.selectOption({ value }, { timeout: timeoutMs });
      } else {
        await locator.fill(value, { timeout: timeoutMs });
      }
    }
  });
  if (filled.status === 'CHANGED') {
    return { ok: false, reason: 'ELEMENT_CHANGED', ...fieldDetailOf(state, progress.current) };
  }
  if (filled.status === 'FAILED') {
    return { ok: false, reason: 'INPUT_FAILED', ...fieldDetailOf(state, progress.current) };
  }
  const changed = await firstChangedValue(page, state, timeoutMs);
  return changed === null ? { ok: true } : valueChangedOf(state, changed);
}

/**
 * 送信の窓を開き、確かめた欄に値を入れ、読み直す（ファイルの先頭の 2）。例外を投げない。
 * OP-O（O2 の (a)・(c)）: 欄が作り直された（`ELEMENT_CHANGED`）か、入れた値が戻った（`VALUE_CHANGED`）ときは、上限（`API_WRITE_FILL_MAX_ATTEMPTS`）の中で 1 回
 * だけ、描き直しを待ってから、同じ指定で確かめ直し（`inspectApiWriteInputWhenRendered`。送信の要素は同じ識別の digest でちょうど 1 つ、欄はちょうど 1 つ・
 * 見える・編集できる。確かめの決まりは変えない）、同じ値を入れ直す。窓は開いたまま（入れ直しの間の要求も、窓の決まりで止める）。押す操作と、送る中身は
 * 変えない。確かめ直しで外れたら、その理由を返す。入れ直しても外れたら、最後の失敗を返す。
 */
export async function fillApiWriteInput(
  page: Page,
  input: InspectedApiWriteInput,
  monitor: WriteStageMonitor,
  timeoutMs = API_WRITE_STEP_TIMEOUT_MS,
): Promise<ApiWriteInputStep> {
  let state = inspectedStates.get(input);
  if (state === undefined) {
    return { ok: false, reason: 'SPEC_INVALID' };
  }
  try {
    // T40R-fix-A: 開くのは窓の観察の段（値を入れる間。承認の形の要求も通さずに止めて数える）。送信の段は、押す直前に `submitApiWriteInput` が開く。
    await monitor.openSubmissionWindow(page);
    windowMonitors.set(input, monitor);
    let result = await fillOnce(page, state, timeoutMs);
    for (let attempt = 1; attempt < API_WRITE_FILL_MAX_ATTEMPTS && !result.ok && REFILL_REASONS.has(result.reason) && !page.isClosed(); attempt += 1) {
      await waitMs(API_WRITE_REFILL_SETTLE_MS);
      const again = await inspectApiWriteInputWhenRendered(page, state.spec);
      if (!again.ok) {
        return again;
      }
      const againState = inspectedStates.get(again.input);
      // 押す操作は、渡された確かめの結果で行う（確かめ直した要素に差し替え、確かめ直しの結果そのものは使わない）。
      inspectedStates.delete(again.input);
      if (againState === undefined) {
        return { ok: false, reason: 'PAGE_UNREADABLE' };
      }
      inspectedStates.set(input, againState);
      state = againState;
      result = await fillOnce(page, state, timeoutMs);
    }
    return result;
  } catch {
    return { ok: false, reason: 'INPUT_FAILED' };
  }
}

/**
 * OP-P（P1・P2）: 押す回数の上限（最初の 1 回と、探し直しの 1 回）。値を入れ終えた後、押す前に、SPA が送信の要素か欄を作り直した（React の再描画。
 * `ELEMENT_CHANGED`）ときだけ、上限の中で 1 回だけ、今の画面から探し直す。押すのは、どの回でも 1 回だけ。
 */
export const API_WRITE_SUBMIT_MAX_ATTEMPTS = 2;

/** 送信の窓の送信の段を開けなかった（押さない。探し直さない）。 */
class SubmissionPhaseUnavailable extends Error {}

/** 押す操作の 1 回の結果（`CHANGED`: 押す前に、確かめた要素が入れ替わっていた。探し直してよい）。 */
type PressOutcome = { readonly status: 'DONE' } | { readonly status: 'CHANGED' } | { readonly status: 'STOPPED'; readonly result: ApiWriteSubmission };

/** 確かめた要素で、値を読み直してから送信の要素を押す（1 回）。例外は呼ぶ側が受ける。 */
async function pressOnce(page: Page, input: InspectedApiWriteInput, state: InspectedState, timeoutMs: number): Promise<PressOutcome> {
  const changed = await firstChangedValue(page, state, timeoutMs);
  if (changed !== null) {
    // OP-P（P2）: 欄が作り直されて外れていれば、探し直してよい（古い要素の値で通さない）。今の要素の値が違えば、押さない（今どおり）。
    return changed.detached === true ? { status: 'CHANGED' } : { status: 'STOPPED', result: { ...valueChangedOf(state, changed), clickAttempted: false } };
  }
  let clickAttempted = false;
  const clicked = await runOnInspected(page, state, timeoutMs, async (locate) => {
    const submitter = await locate(0);
    // T40R-fix-A（Task 40 の設計書 7 章の T40R の I-1）: 押す直前に、値を入れたときの部品で送信の窓の送信の段を開く（Guard が承認の形の要求を照合に
    // かけて 1 回だけ通すのは、この後だけ）。開けなければ（窓が開いていない、値を入れていない）押さない。
    const monitor = windowMonitors.get(input);
    if (monitor === undefined || !monitor.openSubmissionPhase()) {
      throw new SubmissionPhaseUnavailable();
    }
    clickAttempted = true;
    await submitter.click({ timeout: timeoutMs, noWaitAfter: true });
  });
  if (clicked.status === 'DONE') {
    return { status: 'DONE' };
  }
  if (clickAttempted) {
    return { status: 'STOPPED', result: { ok: false, reason: 'SUBMIT_FAILED', clickAttempted: true } };
  }
  // 送信の段を開けなかったときは、理由を今どおり `ELEMENT_CHANGED` にし、探し直さない（`runOnInspected` は、その誤りを `FAILED` にする）。
  return clicked.status === 'CHANGED' ? { status: 'CHANGED' } : { status: 'STOPPED', result: { ok: false, reason: 'ELEMENT_CHANGED', clickAttempted: false } };
}

/**
 * 押す直前に値を読み直し、送信の要素を押す（ファイルの先頭の 3）。押した後のナビゲーションは待たない。例外を投げない。
 * OP-P（P1・P2）: 押す前に、確かめた送信の要素か欄が作り直されていた（`ELEMENT_CHANGED`。欄は、文書から外れていた）ときは、上限
 * （`API_WRITE_SUBMIT_MAX_ATTEMPTS`）の中で 1 回だけ、待たずに、同じ指定で今の画面から確かめ直す（`inspectApiWriteInput`。送信の要素は承認の識別の digest で
 * ちょうど 1 つ・`href` のある祖先がない、欄はちょうど 1 つ・見える・編集できる。確かめの決まりは変えない）。確かめ直しで外れたら、その理由で押さない。
 * 確かめ直した今の要素の値を読み直し、入れた値のままでなければ押さない（入れ直さない。送る直前の確かめ直しの後に、値を入れる操作と待ちを足さない）。
 * 押すのは 1 回だけ（送信の段を開いた後は、探し直さない）。押した後の送る中身は、今どおり Guard が照らす。
 */
export async function submitApiWriteInput(
  page: Page,
  input: InspectedApiWriteInput,
  timeoutMs = API_WRITE_STEP_TIMEOUT_MS,
): Promise<ApiWriteSubmission> {
  let state = inspectedStates.get(input);
  if (state === undefined) {
    return { ok: false, reason: 'SPEC_INVALID', clickAttempted: false };
  }
  try {
    for (let attempt = 1; ; attempt += 1) {
      const pressed = await pressOnce(page, input, state, timeoutMs);
      if (pressed.status === 'DONE') {
        return { ok: true };
      }
      if (pressed.status === 'STOPPED') {
        return pressed.result;
      }
      if (attempt >= API_WRITE_SUBMIT_MAX_ATTEMPTS || page.isClosed()) {
        return { ok: false, reason: 'ELEMENT_CHANGED', clickAttempted: false };
      }
      const again = await inspectApiWriteInput(page, state.spec);
      if (!again.ok) {
        return { ...again, clickAttempted: false };
      }
      const againState = inspectedStates.get(again.input);
      // 押す操作は、渡された確かめの結果で行う（確かめ直した要素に差し替え、確かめ直しの結果そのものは使わない）。
      inspectedStates.delete(again.input);
      if (againState === undefined) {
        return { ok: false, reason: 'PAGE_UNREADABLE', clickAttempted: false };
      }
      state = againState;
    }
  } catch {
    return { ok: false, reason: 'SUBMIT_FAILED', clickAttempted: true };
  } finally {
    // 押した（押そうとした）後は、この確かめの結果を使わない（同じ確かめで 2 回押さない）。
    inspectedStates.delete(input);
  }
}

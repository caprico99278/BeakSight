/**
 * API のシナリオの書き込みの、入力と押下の部品（T39d。Task 39 の設計書 3.5、Task 38 の設計書 3.6）。ページの入力の欄に値を入れる操作を使ってよい
 * ファイルの閉じた一覧（`tests/architecture/worker-login-hooks.test.ts` の (q)）の 1 つ。書き込みの段の口（`WriteStageMonitor`）を参照してよい一覧
 * （`tests/architecture/write-stage-boundary.test.ts` の (c)）にも入れる。
 * 書き込みの form の部品（`write-form-submitter.ts`）は action のある form の POST を前提に、form の欄の一覧と送信ボタンの形を確かめるので、広げずに
 * 別のファイルにした。form のない画面（`BUTTON` の候補）と、`NEEDS_BINDING` の form（`FORM` の候補。ページの JS が送る）の両方を扱う。
 *
 * 1. `inspectApiWriteInput`（入力の前の確かめ。値を入れない）:
 *    - 送信の要素: 画面を isolated world で読み直し（発見の probe と同じ読み方の `probePageCandidatesWithSubmitters`。LU-SFIX2-A: 押す要素を決める部品
 *      `pressTargetOf`。確かめた要素そのものの番号を同じ読み取りで受け、欄の読み取りにはその要素を渡す。位置で引き直さない）、probe の時の候補の識別の digest（`submitterIdentityDigest`。
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
 *    OP-O（O2 の (a)・(c)）: 欄が作り直された（`ELEMENT_CHANGED`）・入れた値が戻った（`VALUE_CHANGED`）ときは、同じ指定で
 *    確かめ直してから入れ直す（L12b: 回数の上限なし。L0 の進みの見張りが終える）（窓は開いたまま。確かめの決まりと、送る中身・回数は変えない）。入れ直しの形は、実験で `fill` の入れ直しに
 *    決めた（`pressSequentially` は、最初の入力を戻す形で 1 文字目を失い、入力の事象も文字の数だけ増える）。
 *    OP-O（O1）: 失敗は、欄の位置・欄の種類・属性の有無（`WRITE_INPUT_FIELD_ATTRIBUTES`）・値の変わり方の区分（`valueChangeKindOf`）を添えて返す（値は返さない）。
 * 3. `submitApiWriteInput`: 押す直前に、値をもう一度読み直し（違えば押さずに `VALUE_CHANGED`）、T40R-fix-A から、値を入れたときの部品で送信の窓の送信の段を
 *    開いて（`WriteStageMonitor.openSubmissionPhase`。開けなければ押さない）、送信の要素を Playwright の `click` で押す（押した後の
 *    ナビゲーションは待たない）。押した後の失敗は `SUBMIT_FAILED`（`clickAttempted: true`。送信が分からない）。押した後（押そうとした後）は、同じ確かめで
 *    2 回押さない。
 *    OP-P（P1・P2）: 押す前に、SPA が送信の要素か欄を作り直していた（`ELEMENT_CHANGED`。欄の読み直しは、文書から外れた古い要素の値を読まない）ときは、
 *    待たずに、同じ指定で今の画面から確かめ直し（L12b: 回数の上限なし）（送信の要素は承認の識別の digest でちょうど 1 つ）、
 *    今の要素の値を読み直してから押す。値が入れた値のままでなければ、入れ直さずに押さない。押すのは 1 回だけ。
 * 4. LU-3（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.5 の 3、4.0 の D2・D3）: `pressListRowOpener`（一覧の行の中の開き手を押す。API とフォームの
 *    形の両方が使う）。窓を開く前（N2）に、値を含む行（`findListRowsContainingValue` が返した行の参照）の中で、識別の digest が同じで名前（文字・`aria-label`・
 *    `title`）のある開き手がちょうど 1 つなら、Playwright の `click` で 1 回押す。削除の語のある候補・名前のないアイコンだけの候補は押さない。値は入れない。
 * 例外を投げない。Playwright の誤りの文には値が入りうるので、誤りは捨てて理由の語だけを返す。値はどこにも記録しない。
 */
import type { Page } from 'playwright';
import type { ApiFieldIdentity } from '../core/api-field-identity.js';
import { isNonNegativeSafeInteger, isRecord } from '../core/guards.js';
import { isSha256Fingerprint } from '../core/ids.js';
import { observationWindowsOrProduction, type ObservationWindows } from '../core/observation-windows.js';
import { normalizeWhitespace } from '../core/text.js';
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';
import { CANDIDATE_FIELD_TYPES, SELECT_FIELD_TYPES } from '../discovery/candidate-contracts.js';
import { submitterWordsOf } from '../discovery/classify.js';
import { DISCOVERY_DESTRUCTIVE_WORDS } from '../discovery/classification-words.js';
import { probedCandidateIdentityDigestOf } from '../discovery/discover-page.js';
import { cssStringOf } from '../discovery/entry-check-selectors.js';
import {
  readElementInIsolatedWorld,
  readElementsInIsolatedWorld,
  readInIsolatedWorld,
  pressWithPressTimeGuard,
  withSignaledElements,
  type InPageElementsResult,
  type IsolatedElementReference,
  type PressTimeFacts,
} from '../discovery/isolated-read.js';
import { locationOfUrl, probePageCandidatesWithSubmitters, type ProbedCandidate } from '../discovery/probe.js';
import type { ListRowReference } from '../discovery/read-executor.js';
import {
  settlePolicyOfWindows,
  waitForDiscoverySettled,
  type DiscoverySettlePolicy,
  type QuietSource,
} from '../discovery/settle.js';
import { SUBMISSION_PROBE_FILL_FIELD_TYPES } from '../discovery/submission-probe-contracts.js';
import type { WriteStageMonitor } from '../safety/passive-request-guard.js';
import { elementPathSelectorOf, ensureElementPathEngine } from './element-path-engine.js';
import {
  sameValue,
  valueChangeKindOf,
  WRITE_INPUT_FIELD_ATTRIBUTES,
  WRITE_STEP_TIMEOUT_MS,
  type WriteInputFieldAttribute,
  type WriteInputFieldFacts,
  type WriteInputValueChange,
} from './form-submission-common.js';
import { composeInPage, type StandardReaders } from './in-page-readers.js';
import { attachPageProgressSignals } from './page-progress-signals.js';
import { waitForPageSettled } from './page-settling.js';
import { openEndedStageDeadline } from '../orchestration/stage-deadline.js';
import { watchProgress } from '../core/progress-watch.js';

/**
 * 読む・入れる・押す、それぞれを待つ長さ（ms）。L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。T23）: 前の上限（10 秒）を撤廃し、書き込みの入力の
 * 部品の共通の値（`WRITE_STEP_TIMEOUT_MS`。L0 の反応なしの長さ）にした。
 */
export const API_WRITE_STEP_TIMEOUT_MS = WRITE_STEP_TIMEOUT_MS;

/** REV-RB8911 M-6: 見張りの指定に観察の窓の一式がないときの一式（本番の一式。引数の既定の 1 か所）。 */
const DEFAULT_WINDOWS = observationWindowsOrProduction(undefined);

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
 * LU-SFIX2-A（LU-SREV2 の Minor-1）: 送信の要素は、位置で引き直さずに、probe で確かめた要素そのもの（`elements` の 1 つ目。押す要素を決める部品
 * `pressTargetOf` が同じ読み取りで取った番号の要素）を受ける。文書から外れていれば `SUBMITTER_NOT_FOUND`。
 */
const readApiWriteScopeInPage = composeInPage((R: StandardReaders, input: ScopeInput, elements?: readonly Element[]): InPageElementsResult => {
  const localNameOf = R.standardGetter<string>(Element.prototype, 'localName');
  const inputTypeOf = R.standardGetter<string>(HTMLInputElement.prototype, 'type');
  const selectTypeOf = R.standardGetter<string>(HTMLSelectElement.prototype, 'type');
  const inputReadOnlyOf = R.standardGetter<boolean>(HTMLInputElement.prototype, 'readOnly');
  const textAreaReadOnlyOf = R.standardGetter<boolean>(HTMLTextAreaElement.prototype, 'readOnly');
  const submitter = elements?.[0];
  if (!(submitter instanceof Element) || !R.standardGetter<boolean>(Node.prototype, 'isConnected')(submitter)) {
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

/**
 * LU-SFIX2-A（LU-SREV2 の Critical-1・Minor-1）: 押す要素を決める、ただ 1 つの部品（API の送り手 `inspectWithin` と、一覧の行の開き手 `pressListRowOpener` が
 * 使う）。画面を isolated world の 1 回の読み取りで読み（`probePageCandidatesWithSubmitters`。発見の probe と同じ読み方）、候補の識別の digest
 * （`probedCandidateIdentityDigestOf`）が `digest` と同じで、送信の要素の位置が `within`（行の位置。null なら画面の全体）の中にある候補を集める。
 * `pressable` が真（集めた候補を見て、押してよいと決めた）で、ちょうど 1 つのときだけ、同じ読み取りで確かめた要素そのものの番号（`backendNodeId`）と
 * 文書の根からの位置を返す（位置で引き直さない）。shadow root の中（位置がない）は返さない。読めなければ null。
 */
interface PressTarget {
  readonly matches: readonly ProbedCandidate[];
  readonly element: IsolatedElementReference | null;
}

async function pressTargetOf(
  page: Page,
  digest: string,
  within: readonly number[] | null,
  deadlineAtMs: number,
  pressable: (matches: readonly ProbedCandidate[]) => boolean,
): Promise<PressTarget | null> {
  const { location, url } = locationOfUrl(page.url());
  if (url === null) {
    return null;
  }
  const state: { matchIndexes: readonly number[]; chosen: boolean } = { matchIndexes: [], chosen: false };
  const probe = await probePageCandidatesWithSubmitters(page, deadlineAtMs, (candidates) => {
    // 画面の全体（`within` が null）では、送信の要素のない候補も数える（同じ識別の候補が 2 つ以上なら、どれを押すか決まらない）。
    const matchIndexes = candidates.flatMap((candidate, index) => {
      const path = candidate.submitter?.path;
      return (within === null || (path !== undefined && isInsideRowPath(within, path)))
        && probedCandidateIdentityDigestOf(location, candidate) === digest ? [index] : [];
    });
    state.matchIndexes = matchIndexes;
    const matches = matchIndexes.map((index) => candidates[index] as ProbedCandidate);
    const [only] = matchIndexes;
    state.chosen = only !== undefined && matchIndexes.length === 1 && (matches[0]?.submitter ?? null) !== null && pressable(matches);
    return state.chosen && only !== undefined ? [only] : [];
  });
  if (probe.status !== 'READ') {
    return null;
  }
  const matches = state.matchIndexes.map((index) => probe.candidates[index]).filter((candidate): candidate is ProbedCandidate => candidate !== undefined);
  const [chosen] = probe.chosen;
  const element = state.chosen && chosen !== undefined && chosen.element.path !== null ? chosen.element : null;
  return { matches, element };
}

/**
 * LU-SFIX3-A: 押す時点の確かめの受け手を付けた時点の事実が、押す要素を決める部品で確かめた候補と同じか（文書につながり、文言から求めた語と名前の有無が同じ。
 * 語の求め方は発見の probe と同じ `submitterWordsOf`。文言は比べた後に捨てる）。
 */
const pressTimeFactsMatchCandidate = (facts: PressTimeFacts, candidate: ProbedCandidate): boolean => {
  const read = pressTimeSubmitterWordsOf(facts);
  return read !== null && read.hasText === candidate.hasSubmitterText && sameWordList(read.words, candidate.submitterWords);
};

/**
 * LU-SFIX4（LU-REV の I-2）: 押す時点の受け手を付けた時点の要素の、文言から求めた語（語の求め方は発見の probe と同じ `submitterWordsOf`。文言は返さない）と
 * 文言の有無。文書につながっていなければ null。API の送り手・一覧の行の開き手・フォームの送り手（`write-form-submitter.ts`）が共有する唯一の求め方。
 */
export const pressTimeSubmitterWordsOf = (facts: PressTimeFacts): { readonly hasText: boolean; readonly words: readonly string[] } | null => {
  if (!facts.connected) {
    return null;
  }
  // LZ-3c: 文言は切らずに全部から語を求める（前は `MAX_SUBMITTER_TEXT_LENGTH` 256 で切った。発見の probe も同じに全部を読む）。
  const text = normalizeWhitespace(facts.text);
  return { hasText: text.length > 0, words: submitterWordsOf(text) };
};

/** 2 つの語の一覧が、同じ順で同じか。 */
const sameWordList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((word, index) => word === right[index]);

/**
 * LU-SFIX4（LU-REV の I-2）: 押す時点の要素の語が、承認の候補の送信ボタンの語（`approvedWords`）と同じで、削除の語（`DISCOVERY_DESTRUCTIVE_WORDS`）を含まないか
 * （フォームの送り手が押す時点の確かめで使う）。
 */
export const pressTimeWordsMatchApproved = (facts: PressTimeFacts, approvedWords: readonly string[]): boolean => {
  const read = pressTimeSubmitterWordsOf(facts);
  return read !== null && sameWordList(read.words, approvedWords) && !read.words.some((word) => DESTRUCTIVE_SUBMITTER_WORDS.has(word));
};

/** 送信の要素（probe の候補の識別の digest で、ちょうど 1 つ。同じ読み取りで確かめた要素の番号と位置）。 */
async function submitterElementOf(page: Page, digest: string, deadlineAtMs: number): Promise<{ readonly element: IsolatedElementReference } | { readonly reason: ApiWriteInputReason }> {
  const target = await pressTargetOf(page, digest, null, deadlineAtMs, () => true);
  if (target === null) {
    return { reason: 'PAGE_UNREADABLE' };
  }
  if (target.matches.length === 0) {
    return { reason: 'SUBMITTER_NOT_FOUND' };
  }
  if (target.matches.length > 1) {
    return { reason: 'SUBMITTER_AMBIGUOUS' };
  }
  return target.element === null ? { reason: 'SUBMITTER_NOT_FOUND' } : { element: target.element };
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
  const submitter = await submitterElementOf(page, spec.submitterIdentityDigest, deadlineAtMs);
  if ('reason' in submitter) {
    return { ok: false, reason: submitter.reason };
  }
  const outcome = await readElementsInIsolatedWorld(page, readApiWriteScopeInPage, {
    ...SCOPE_INPUT_BASE,
    selectors: selectors as readonly { readonly css: string; readonly fieldsOnly: boolean }[],
  }, deadlineAtMs, { argumentElements: [submitter.element.backendNodeId] });
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
  if (outcome.elements.length !== spec.fields.length + 1 || paths.some((path) => path === null)
    || outcome.elements[0]?.backendNodeId !== submitter.element.backendNodeId) {
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
 * T41d: 値が落ち着くまで読む（純粋な手順。読み取りと待ちは引数で受ける）。間隔（`intervalMs`。省略は観察の窓の一式の `write.apiValueSettleIntervalMs`）を置いて
 * 2 回読み、同じ（位置と数も）になったら、その値を返す。
 * 読めない誤りはそのまま返す。上限の回数（`maxReads`）まで落ち着かなければ `PAGE_UNREADABLE`（読めなかったとする。送らない側に倒す）。
 * 限界: 間隔より長く遅れて値を入れるページは、入れる前の値で落ち着いたと見えうる（書き込みの段で開き直した画面の値と照らし、違えば送らない）。
 */
export async function settledFieldValues(
  read: () => Promise<ApiWriteFieldValues>,
  waitFor: (ms: number) => Promise<void>,
  intervalMs = DEFAULT_WINDOWS.write.apiValueSettleIntervalMs,
  maxReads?: number,
  signal?: AbortSignal,
): Promise<ApiWriteFieldValues> {
  // L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。T25）: 読む回数の上限（前は既定で 10 回）は、
  // 指定したときだけ当てる。指定がなければ、落ち着くか、見張り（`signal`。L0 の進みの見張り）が終えるまで読む。
  const first = await read();
  if (!first.ok) {
    return first;
  }
  let previous: readonly string[] = first.values;
  for (let reads = 1; maxReads === undefined || reads < maxReads; reads += 1) {
    if (signal?.aborted === true) {
      break;
    }
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
 * T41R2-fix（設計書 8 章の「T41R2」の (3)）: 欄の値の、要求が止むのを待つ落ち着きの指定。上限は観察の窓の一式の `discoverySettle.busyTimeoutMs` で、発見の落ち着きの
 * 上限より短い（前の読み取りと後の照合は、その前に画面の候補の落ち着きを待っている）。上限に届いたら、間隔を置いた 2 回の読み取りの落ち着きで進む。ほかは発見と同じ。
 */
const valueQuietPolicyOf = (windows: ObservationWindows): DiscoverySettlePolicy => settlePolicyOfWindows(windows, true);

/** 時間を待つ（ms）。 */
const waitMs = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));

/**
 * T41R-fix（Task 41 の設計書 8 章の「T41R の途中の報告」の (1)）: 要求が止んだ後に落ち着いた値を読む。落ち着きの判定は発見と READ の owner の部品
 * （`waitForDiscoverySettled`。進行中の要求がなく、最後の終わりから静かな時間が過ぎ、2 回続けて同じ集合）で、集合は位置を付けた値（`settleSetOf`）。
 * 落ち着いたら、最後の読み取りの値を返す。
 * T41R2-fix（同じ章の「T41R2」の (3)）: 上限（`policy.timeoutMs`）までに落ち着かなければ（開いたままの要求がある realtime の SPA など）、
 * 止めずに、間隔（`intervalMs`）を置いた 2 回の読み取りの落ち着き（`settledFieldValues`）で進む。値が入る前の値は、呼ぶ側の確かめ（台帳が知る保つ鍵の値）で止める。
 * T41R3-fix（M-1）: 上限に届いたとき、要求がまだ止んでいなければ（静かな時間に届いていない）、`onQuietTimedOut` で知らせる（呼ぶ側が、同じ画面の残りの
 * 読み取りで待ちを省くため）。指定の省略は、本番の観察の窓の一式から作る。
 */
export async function settledFieldValuesWhenQuiet(
  source: QuietSource,
  read: () => Promise<ApiWriteFieldValues>,
  policy: DiscoverySettlePolicy = valueQuietPolicyOf(DEFAULT_WINDOWS),
  waitFor: (ms: number) => Promise<void> = waitMs,
  onQuietTimedOut?: () => void,
  /** L12b（T25）: 落ち着きの読み取りを終える見張りの口（L0。省略は、落ち着くまで読む）。 */
  signal?: AbortSignal,
  intervalMs = DEFAULT_WINDOWS.write.apiValueSettleIntervalMs,
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
  return settledFieldValues(read, waitFor, intervalMs, undefined, signal);
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
  watch: ApiWriteWatchOptions = {},
): Promise<ApiWriteFieldValues> {
  const read = (): Promise<ApiWriteFieldValues> => readFieldValuesOnce(page, fields, timeoutMs);
  return settledFieldValuesWatched(page, read, quiet, watch);
}

/**
 * L12b: 回数・時間の上限を撤廃した待ちを包む、L0 の進みの見張りの指定（テストが反応なしの長さを短くする。省略は `PROGRESS_WATCH_QUIET_LIMIT_MS`）。
 * RB-11: 見張りの中の待ち（欄の値の落ち着きの間隔と上限、欄が描かれるのを確かめ直す間隔、入れ直す前の待ち）は、観察の窓の一式（`observationWindows`。
 * テストだけが差し込む。省略は本番の一式）から読む。
 */
export interface ApiWriteWatchOptions {
  readonly quietLimitMs?: number | undefined;
  readonly observationWindows?: ObservationWindows | undefined;
}

/**
 * L12b（T25）: 値の落ち着きを、回数の上限なしで待つ（L0 の進みの見張りで包む）。要求の数え方（`quiet`）があれば、要求が止んだ後の落ち着き
 * （`settledFieldValuesWhenQuiet`）、なければ間隔を置いた 2 回の読み取り（`settledFieldValues`）。まだ見ていない値の組を読んだときだけ中身の進みにする（同じ値を
 * 繰り返し読むだけ・周期的に入れ替わるだけは進みにしない）。見張りが終えたら、読めなかった（`PAGE_UNREADABLE`。送らない側）。
 */
async function settledFieldValuesWatched(
  page: Page,
  read: () => Promise<ApiWriteFieldValues>,
  quiet: ApiWriteValueQuiet | undefined,
  watch: ApiWriteWatchOptions,
): Promise<ApiWriteFieldValues> {
  // 値の読み取りは、中身の進みにしない（値が変わり続けるのはページの自発の変化。数えると、書き換え続ける欄で待ち続ける）。全く落ち着かないまま反応なしの
  // 長さが過ぎたら、見張りが終える（読めなかった）。
  const windows = observationWindowsOrProduction(watch.observationWindows);
  const intervalMs = windows.write.apiValueSettleIntervalMs;
  const outcome = await watchProgress(async (signals) => {
    const detach = attachPageProgressSignals(page, signals);
    try {
      return quiet === undefined
        ? await settledFieldValues(read, waitMs, intervalMs, undefined, signals.signal)
        : await settledFieldValuesWhenQuiet(quiet.source, read, valueQuietPolicyOf(windows), waitMs, quiet.onQuietTimedOut, signals.signal, intervalMs);
    } finally {
      detach();
    }
  }, { quietLimitMs: watch.quietLimitMs });
  return outcome.status === 'FULFILLED' ? outcome.value : { ok: false, reason: 'PAGE_UNREADABLE' };
}

/** 入力の前の確かめ（値を入れない）。読めなければ `PAGE_UNREADABLE`。例外を投げない。 */
export async function inspectApiWriteInput(page: Page, spec: ApiWriteInputSpec, timeoutMs = API_WRITE_STEP_TIMEOUT_MS): Promise<ApiWriteInputInspection> {
  try {
    return await inspectWithin(page, spec, timeoutMs);
  } catch {
    return { ok: false, reason: 'PAGE_UNREADABLE' };
  }
}

/** OP-L（L1）: 後から描かれれば当たりうる、確かめの理由（欄・送信の要素がまだない・まだ見えない・まだ入れられない）。ほかの理由は待たない。 */
const LATE_RENDER_REASONS: ReadonlySet<ApiWriteInputReason> = new Set([
  'FIELD_NOT_FOUND',
  'FIELD_NOT_VISIBLE',
  'FIELD_NOT_EDITABLE',
  'SUBMITTER_NOT_FOUND',
]);

/**
 * RB-11: 入力の前の確かめの 1 回の後の次の一手（純粋）。当たらず、後から描かれれば当たりうる理由（`LATE_RENDER_REASONS`）で、ページが開いていて見張りも上限も
 * 終えていなければ、間隔を置いて確かめ直す（`INSPECT_AGAIN`）。ほかは、その結果で終える（`DONE`）。
 */
export const inspectAgainStepOf = (
  inspection: { readonly ok: true } | { readonly ok: false; readonly reason: ApiWriteInputReason },
  facts: { readonly pageGone: boolean; readonly limitReached: boolean },
): 'INSPECT_AGAIN' | 'DONE' =>
  (!inspection.ok && LATE_RENDER_REASONS.has(inspection.reason) && !facts.pageGone && !facts.limitReached ? 'INSPECT_AGAIN' : 'DONE');

/**
 * OP-L（L1。指示書 OP-L の 1。OP-K の K1・K3 と同じ考え方）: 入力の前の確かめ（`inspectApiWriteInput`）を、欄と送信の要素が出そろうまで、上限
 * （`API_WRITE_INPUT_APPEAR_WAIT_MS`）の中で繰り返す。確かめは読むだけで、値を入れない・押さない・読み込まない。当たれば、その結果を返す。後から描かれれば
 * 当たりうる理由（`LATE_RENDER_REASONS`）でなければ、待たずに返す。上限を過ぎたら、最後の確かめの結果を返す（確かめの決まりは変えない）。例外を投げない。
 */
export async function inspectApiWriteInputWhenRendered(
  page: Page,
  spec: ApiWriteInputSpec,
  limitMs?: number,
  watch: ApiWriteWatchOptions = {},
): Promise<ApiWriteInputInspection> {
  // L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。T26）: 待つ上限（前は既定で 5 秒）は、指定した
  // ときだけ当てる。指定がなければ、出そろうか、L0 の進みの見張りが終えるまで確かめ直す（確かめの理由が変わったときを中身の進みにする。同じ理由の繰り返しは
  // 進みにしない）。見張りが終えたら、最後の確かめの結果を返す。RB-11: 確かめ直す間隔は、観察の窓の一式の `write.apiInputAppearPollMs`（見出し・ログインの欄の
  // 待ちと同じ間隔）。
  const pollMs = observationWindowsOrProduction(watch.observationWindows).write.apiInputAppearPollMs;
  const deadlineAtMs = limitMs === undefined ? undefined : Date.now() + limitMs;
  let last: ApiWriteInputInspection | null = null;
  const loop = async (signal: AbortSignal | undefined, mark: () => void): Promise<ApiWriteInputInspection> => {
    let previousReason: string | null = null;
    for (;;) {
      const inspection = await inspectApiWriteInput(page, spec);
      last = inspection;
      const reason = inspection.ok ? 'OK' : inspection.reason;
      if (reason !== previousReason) {
        previousReason = reason;
        mark();
      }
      if (inspectAgainStepOf(inspection, {
        pageGone: page.isClosed() || signal?.aborted === true, limitReached: deadlineAtMs !== undefined && Date.now() + pollMs >= deadlineAtMs,
      }) === 'DONE') {
        return inspection;
      }
      await waitMs(pollMs);
    }
  };
  if (deadlineAtMs !== undefined) {
    return loop(undefined, () => undefined);
  }
  const outcome = await watchProgress(async (signals) => {
    const detach = attachPageProgressSignals(page, signals);
    try {
      return await loop(signals.signal, () => signals.mark('BROWSER_RESPONSE'));
    } finally {
      detach();
    }
  }, { quietLimitMs: watch.quietLimitMs });
  return outcome.status === 'FULFILLED' ? outcome.value : last ?? { ok: false, reason: 'PAGE_UNREADABLE' };
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

/** OP-O（O2）: 入れ直してよい理由（ほかの理由は、入れ直さずに返す）。 */
const REFILL_REASONS: ReadonlySet<ApiWriteInputReason> = new Set(['ELEMENT_CHANGED', 'VALUE_CHANGED']);

/**
 * RB-11（plan の 2 章の 14）: 値を入れた 1 回の結果の後の次の一手（純粋）。欄が作り直された・入れた値が戻った（`REFILL_REASONS`）で、ページが開いていて見張りも
 * 終えていなければ、描き直しを待って確かめ直し、入れ直す（`REFILL`）。ほかは、その結果で終える（`DONE`）。入れ直しは送信ではないので、回数の上限は置かない。
 */
export const refillStepOf = (result: ApiWriteInputStep, facts: { readonly pageGone: boolean }): 'REFILL' | 'DONE' =>
  (!result.ok && REFILL_REASONS.has(result.reason) && !facts.pageGone ? 'REFILL' : 'DONE');

/**
 * RB-11: 押す 1 回の結果の後の次の一手（純粋）。押した → 送った（`ok`）、押さずに止めた → その結果、押す前に要素が作り直されていた → ページが閉じた・見張りが
 * 終えたら押さずに `ELEMENT_CHANGED`、ほかは今の画面から確かめ直す（`REINSPECT`。押していないので、押すのは 1 回だけの守りは変わらない）。
 */
export const pressRetryStepOf = (
  pressed: { readonly status: 'DONE' } | { readonly status: 'CHANGED' } | { readonly status: 'STOPPED'; readonly result: ApiWriteSubmission },
  facts: { readonly pageGone: boolean },
): { readonly kind: 'END'; readonly result: ApiWriteSubmission } | { readonly kind: 'REINSPECT' } => {
  if (pressed.status === 'DONE') {
    return { kind: 'END', result: { ok: true } };
  }
  if (pressed.status === 'STOPPED') {
    return { kind: 'END', result: pressed.result };
  }
  return facts.pageGone ? { kind: 'END', result: { ok: false, reason: 'ELEMENT_CHANGED', clickAttempted: false } } : { kind: 'REINSPECT' };
};

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
  watch: ApiWriteWatchOptions = {},
): Promise<ApiWriteInputStep> {
  const state = inspectedStates.get(input);
  if (state === undefined) {
    return { ok: false, reason: 'SPEC_INVALID' };
  }
  try {
    // T40R-fix-A: 開くのは窓の観察の段（値を入れる間。承認の形の要求も通さずに止めて数える）。送信の段は、押す直前に `submitApiWriteInput` が開く。
    await monitor.openSubmissionWindow(page);
    windowMonitors.set(input, monitor);
    const filled = await fillWithRefill(page, input, state, timeoutMs, watch);
    // WBF（DEF-291 の C）: 入れた値をページが遅れて受け取る作り（入力の後に間を置いて値を持つ欄など）のため、入れ終えた後に、ページが落ち着くまで待つ（落ち着きの
    // 待ちの唯一の部品 `waitForPageSettled`。長さは観察の窓の一式。押す前の値の読み直しは今どおり `submitApiWriteInput` が行う。送る回数は変えない）。
    if (filled.ok) {
      await settleAfterFill(page, watch);
    }
    return filled;
  } catch {
    return { ok: false, reason: 'INPUT_FAILED' };
  }
}

/** WBF（DEF-291 の C）: 入れた後の落ち着きの待ち（期限は置かず、反応がなければ L0 の進みの見張りが終える）。例外を投げない。 */
async function settleAfterFill(page: Page, watch: ApiWriteWatchOptions): Promise<void> {
  const windows = observationWindowsOrProduction(watch.observationWindows).pageSettle;
  await watchProgress(async (signals) => {
    const detach = attachPageProgressSignals(page, signals);
    try {
      await waitForPageSettled(page, {
        deadlineAtMs: openEndedStageDeadline(Date.now()),
        pollIntervalMs: windows.pollIntervalMs,
        stableWindowMs: windows.stableWindowMs,
        openDataRequestQuietMs: windows.openDataRequestQuietMs,
        progress: signals,
      });
    } finally {
      detach();
    }
  }, { quietLimitMs: watch.quietLimitMs }).catch(() => undefined);
}

/** 確かめた欄に値を入れ、作り直し・値の戻りがあれば入れ直す（`fillApiWriteInput` の中身）。 */
async function fillWithRefill(
  page: Page,
  input: InspectedApiWriteInput,
  state: InspectedState,
  timeoutMs: number,
  watch: ApiWriteWatchOptions,
): Promise<ApiWriteInputStep> {
  // 入れ直しの手順の中身は、WBF の前の `fillApiWriteInput` のまま（字下げを保つため、ブロックで包む）。
  {
    let result = await fillOnce(page, state, timeoutMs);
    if (refillStepOf(result, { pageGone: false }) === 'DONE') {
      return result;
    }
    const refillSettleMs = observationWindowsOrProduction(watch.observationWindows).write.apiInputAppearPollMs;
    // L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。S13）: 入れ直しの回数の上限（前は 2 回）は
    // 置かない（入れ直しは送信ではない）。作り直しが続く間は、L0 の進みの見張りが終えるまで入れ直す（見張りが終えたら、最後の結果）。
    let current: InspectedState = state;
    const watched = await watchProgress(async (signals) => {
      const detach = attachPageProgressSignals(page, signals);
      try {
        // OP-O（O2）: 入れ直す前に、ページの描き直しが終わるのを待つ（欄が出そろうのを待つ間に確かめ直す間隔と同じ長さ）。
        while (refillStepOf(result, { pageGone: page.isClosed() || signals.signal.aborted }) === 'REFILL') {
          await waitMs(refillSettleMs);
          const again = await inspectApiWriteInputWhenRendered(page, current.spec, undefined, watch);
          if (!again.ok) {
            return again;
          }
          const againState = inspectedStates.get(again.input);
          // 押す操作は、渡された確かめの結果で行う（確かめ直した要素に差し替え、確かめ直しの結果そのものは使わない）。
          inspectedStates.delete(again.input);
          if (againState === undefined) {
            return { ok: false, reason: 'PAGE_UNREADABLE' } as const;
          }
          inspectedStates.set(input, againState);
          current = againState;
          result = await fillOnce(page, current, timeoutMs);
        }
        return result;
      } finally {
        detach();
      }
    }, { quietLimitMs: watch.quietLimitMs });
    return watched.status === 'FULFILLED' ? watched.value : result;
  }
}

/** 送信の窓の送信の段を開けなかった（押さない。探し直さない）。 */
class SubmissionPhaseUnavailable extends Error {}
/** LU-SFIX2-A fix round 1: 押す直前の読み直しで、送信の要素の事実（語・識別）が確かめた時と違った（押さない。探し直さない）。 */
class SubmitterFactsChanged extends Error {}

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
  let stoppedAtPress = false;
  const clicked = await runOnInspected(page, state, timeoutMs, async (locate) => {
    const submitter = await locate(0);
    // LU-SFIX2-A fix round 1: 押す直前に、押す要素を決める部品（`pressTargetOf`）で画面を読み直し、承認の識別の digest の候補がちょうど 1 つで、その要素が
    // 確かめた要素そのもの（同じ番号）であること（同じ要素の語が書き換わっていれば、識別の digest が違うので当たらない）。外れたら押さない
    // （`ELEMENT_CHANGED`。探し直さない）。DEF-237: 同じ要素かは番号（backendNodeId）で決める。位置の道は比べない（前の位置に行が足される画面で、
    // 道がずれても同じ要素なら押す）。
    // LU-SFIX3-A: 押す時点の確かめ（受け手を先に付け、付けた時点の事実を、読み直した候補と比べる）。
    const submitterId = state.backendNodeIds[0];
    if (submitterId === undefined) {
      throw new SubmitterFactsChanged();
    }
    const pressed = await pressWithPressTimeGuard(page, submitterId, Date.now() + timeoutMs, async (armedFacts) => {
      const again = await pressTargetOf(page, state.spec.submitterIdentityDigest, null, Date.now() + timeoutMs, () => true);
      const [candidate] = again?.matches ?? [];
      return again !== null && candidate !== undefined && again.matches.length === 1 && again.element !== null
        && again.element.backendNodeId === submitterId && pressTimeFactsMatchCandidate(armedFacts, candidate);
    }, async () => {
      // T40R-fix-A（Task 40 の設計書 7 章の T40R の I-1）: 押す直前に、値を入れたときの部品で送信の窓の送信の段を開く（Guard が承認の形の要求を照合に
      // かけて 1 回だけ通すのは、この後だけ）。開けなければ（窓が開いていない、値を入れていない）押さない。
      const monitor = windowMonitors.get(input);
      if (monitor === undefined || !monitor.openSubmissionPhase()) {
        throw new SubmissionPhaseUnavailable();
      }
      clickAttempted = true;
      await submitter.click({ timeout: timeoutMs, noWaitAfter: true });
    });
    if (pressed === 'STOPPED') {
      stoppedAtPress = true;
    }
    if (pressed !== 'PRESSED') {
      throw new SubmitterFactsChanged();
    }
  });
  if (clicked.status === 'DONE') {
    return { status: 'DONE' };
  }
  // LU-SFIX3-A: 押す時点の確かめの受け手が事象を止めた（ページの要素の受け手に届いていない）。押さなかった扱い（探し直さない）。
  if (stoppedAtPress) {
    return { status: 'STOPPED', result: { ok: false, reason: 'PAGE_UNREADABLE', clickAttempted: false } };
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
  watch: ApiWriteWatchOptions = {},
): Promise<ApiWriteSubmission> {
  const state = inspectedStates.get(input);
  if (state === undefined) {
    return { ok: false, reason: 'SPEC_INVALID', clickAttempted: false };
  }
  try {
    // L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。S13）: 探し直しの回数の上限（前は 2 回）は
    // 置かない。探し直すのは、押す前に要素が作り直されたとき（`CHANGED`。押していない）だけで、押した（押そうとした）後は探し直さない（押すのは 1 回だけ。2 回
    // 送らない守りは今のまま）。作り直しが続く間は、L0 の進みの見張りが終えるまで探し直す（見張りが終えたら、押さずに `ELEMENT_CHANGED`）。
    let current: InspectedState = state;
    const watched = await watchProgress(async (signals): Promise<ApiWriteSubmission> => {
      const detach = attachPageProgressSignals(page, signals);
      try {
        for (;;) {
          // 見張りが終えた後は、新しく押さない（見放した処理が、後から押し始めないため）。
          if (signals.signal.aborted) {
            return { ok: false, reason: 'ELEMENT_CHANGED', clickAttempted: false };
          }
          const pressed = await pressOnce(page, input, current, timeoutMs);
          const step = pressRetryStepOf(pressed, { pageGone: page.isClosed() || signals.signal.aborted });
          if (step.kind === 'END') {
            return step.result;
          }
          const again = await inspectApiWriteInput(page, current.spec);
          if (!again.ok) {
            return { ...again, clickAttempted: false };
          }
          const againState = inspectedStates.get(again.input);
          // 押す操作は、渡された確かめの結果で行う（確かめ直した要素に差し替え、確かめ直しの結果そのものは使わない）。
          inspectedStates.delete(again.input);
          if (againState === undefined) {
            return { ok: false, reason: 'PAGE_UNREADABLE', clickAttempted: false };
          }
          current = againState;
        }
      } finally {
        detach();
      }
    }, { quietLimitMs: watch.quietLimitMs });
    if (watched.status === 'FULFILLED') {
      return watched.value;
    }
    if (watched.status === 'REJECTED') {
      throw watched.reason;
    }
    // 見張りが終えた: 押している途中なら、押したかは分からない側（`SUBMIT_FAILED`、押そうとした）に倒す。
    return { ok: false, reason: 'SUBMIT_FAILED', clickAttempted: true };
  } catch {
    return { ok: false, reason: 'SUBMIT_FAILED', clickAttempted: true };
  } finally {
    // 押した（押そうとした）後は、この確かめの結果を使わない（同じ確かめで 2 回押さない）。
    inspectedStates.delete(input);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// LU-3（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.5 の 3、4.0 の D2・D3）: 一覧の行の中の開き手を押す
// ---------------------------------------------------------------------------------------------------------------

/**
 * 行の中の開き手を押した結果（閉じた一覧。ここが 1 か所の定義）。
 * - `PRESSED`: 押した（押した後の画面の移り変わりは待たない）。
 * - `OPENER_NOT_FOUND`: 行の中に、識別の digest が同じ候補がない、または 2 つ以上ある（どれを押すか決まらない。押さない）。
 * - `OPENER_UNNAMED`: 同じ識別の候補に名前（文字・`aria-label`・`title`）がない（アイコンだけ。D3。押さない）。
 * - `OPENER_DELETE_LIKE`: 同じ識別の候補に削除の語（`DISCOVERY_DESTRUCTIVE_WORDS`）がある（押さない）。
 * - `SPEC_INVALID`: 指定の形の誤り（行の参照・digest の形）。押さない。
 * - `PAGE_UNREADABLE`: 画面を読めなかった、または行の位置の要素が読んだ行でない（行が作り直された）。押さない。
 * - `PRESS_FAILED`: 押す操作が失敗した（押したかは分からない）。
 */
export const LIST_ROW_OPENER_PRESS_RESULTS = Object.freeze([
  'PRESSED',
  'OPENER_NOT_FOUND',
  'OPENER_UNNAMED',
  'OPENER_DELETE_LIKE',
  'SPEC_INVALID',
  'PAGE_UNREADABLE',
  'PRESS_FAILED',
] as const);
export type ListRowOpenerPressResult = (typeof LIST_ROW_OPENER_PRESS_RESULTS)[number];

/** 削除の語（送らずに観察する probe の対象の選び方と同じ一覧）。 */
const DESTRUCTIVE_SUBMITTER_WORDS: ReadonlySet<string> = new Set(DISCOVERY_DESTRUCTIVE_WORDS);

/** 位置 `path` が、行の位置 `rowPath` の子孫か（行そのものは含まない）。 */
const isInsideRowPath = (rowPath: readonly number[], path: readonly number[]): boolean =>
  path.length > rowPath.length && rowPath.every((step, index) => path[index] === step);

/** 行の参照の形か。 */
const isListRowReference = (row: unknown): row is ListRowReference => isRecord(row)
  && Array.isArray(row['path']) && row['path'].length > 0 && (row['path'] as readonly unknown[]).every(isNonNegativeSafeInteger)
  && isNonNegativeSafeInteger(row['backendNodeId']);

/** 押せない理由（集めた候補から。押してよければ null）。 */
const openerProblemOf = (matches: readonly ProbedCandidate[]): Exclude<ListRowOpenerPressResult, 'PRESSED' | 'SPEC_INVALID' | 'PAGE_UNREADABLE' | 'PRESS_FAILED'> | null => {
  if (matches.length === 0) {
    return 'OPENER_NOT_FOUND';
  }
  if (matches.some((candidate) => candidate.submitterWords.some((word) => DESTRUCTIVE_SUBMITTER_WORDS.has(word)))) {
    return 'OPENER_DELETE_LIKE';
  }
  if (!matches.some((candidate) => candidate.hasSubmitterText)) {
    return 'OPENER_UNNAMED';
  }
  return matches.length === 1 ? null : 'OPENER_NOT_FOUND';
};

/** LU-SFIX2-A: 押してよい開き手か（押せない理由がない。ちょうど 1 つ・削除の語がない・名前がある）。 */
const pressableOpeners = (matches: readonly ProbedCandidate[]): boolean => openerProblemOf(matches) === null;

/** 押す候補の事実（語・名前の有無。押す直前の作り直しと比べる）。 */
const openerFactsOf = (candidate: ProbedCandidate | undefined): string =>
  JSON.stringify(candidate === undefined ? null : [candidate.submitterWords, candidate.hasSubmitterText, candidate.submitter?.path ?? null]);

/** 位置が同じか。 */
const samePath = (left: readonly number[] | null, right: readonly number[] | null): boolean =>
  left !== null && right !== null && left.length === right.length && left.every((step, index) => right[index] === step);

/**
 * LU-SFIX2-A: 押す直前の確かめ（ページの中で動く。標準の getter とメソッドで読む）。番号で解決した開き手（`elements[0]`）と行（`elements[1]`）が、どちらも文書に
 * つながり、開き手が行の子孫で、開き手の今の位置が押す位置（`input.openerPath`）のままか。
 */
const openerStillInRowInPage = composeInPage((R: StandardReaders, input: { readonly openerPath: readonly number[] }, elements?: readonly Element[]): InPageElementsResult => {
  const opener = elements?.[0];
  const row = elements?.[1];
  const isConnected = R.standardGetter<boolean>(Node.prototype, 'isConnected');
  if (!(opener instanceof Element) || !(row instanceof Element) || opener === row || !isConnected(opener) || !isConnected(row)
    || !Node.prototype.contains.call(row, opener)) {
    return { value: false, elements: [] };
  }
  const path = R.elementPathOf(opener);
  const same = path !== null && path.length === input.openerPath.length && path.every((step, index) => input.openerPath[index] === step);
  return { value: same, elements: [] };
});

/** 押す直前の確かめで外れた（押さない）。 */
class OpenerChanged extends Error {}

/**
 * LU-3: 一覧の行（`findListRowsContainingValue` が返した参照）の中の開き手を、1 回押す（ファイルの先頭の 4）。例外を投げない。
 * 1. 押す要素を決める部品（`pressTargetOf`）で、画面を isolated world の 1 回の読み取りで読み、送信の要素の位置が行の中にあり、候補の識別の digest
 *    （`probedCandidateIdentityDigestOf`）が `openerIdentityDigest` と同じ候補を集める。0 なら `OPENER_NOT_FOUND`。削除の語があれば `OPENER_DELETE_LIKE`、
 *    名前のあるものがなければ `OPENER_UNNAMED`、2 つ以上なら `OPENER_NOT_FOUND`（押さない）。押してよい 1 つのときだけ、同じ読み取りで確かめた要素そのものの
 *    番号を受ける（LU-SFIX2-A。位置で引き直さない）。
 * 2. その番号の要素に合図の受け手を付けて（`withSignaledElements`）、押す直前に、(a) 同じ部品で画面を読み直し、同じ番号の要素が同じ識別の候補で、語・名前・
 *    位置が 1 の時と同じ、ちょうど 1 つの押してよい開き手であること（同じ要素の中身の書き換えを見る）、(b) その要素と行（`row.backendNodeId`）が文書に
 *    つながり、行の子孫であることを確かめる。外れたら `PAGE_UNREADABLE`（押さない）。位置の要素がその要素のときだけ `click` で押す（押した後の
 *    ナビゲーションは待たない）。押す操作が失敗したら `PRESS_FAILED`。
 * 押すのは、書き込みの段の送信の窓を開く前（N2）。窓を開かない・値を入れない。押した後の要求は、今どおり Guard が扱う。
 */
export async function pressListRowOpener(
  page: Page,
  row: ListRowReference,
  openerIdentityDigest: string,
  timeoutMs = API_WRITE_STEP_TIMEOUT_MS,
): Promise<ListRowOpenerPressResult> {
  if (!isListRowReference(row) || typeof openerIdentityDigest !== 'string' || !isSha256Fingerprint(openerIdentityDigest)) {
    return 'SPEC_INVALID';
  }
  try {
    await ensureElementPathEngine();
    const deadlineAtMs = Date.now() + timeoutMs;
    const target = await pressTargetOf(page, openerIdentityDigest, row.path, deadlineAtMs, pressableOpeners);
    if (target === null) {
      return 'PAGE_UNREADABLE';
    }
    const problem = openerProblemOf(target.matches);
    if (problem !== null) {
      return problem;
    }
    const opener = target.element;
    const openerPath = opener?.path ?? null;
    if (opener === null || openerPath === null) {
      return 'OPENER_NOT_FOUND';
    }
    const facts = openerFactsOf(target.matches[0]);
    let clickAttempted = false;
    let stopped = false;
    const outcome = await withSignaledElements(page, [opener.backendNodeId], deadlineAtMs, async ([signal]) => {
      if (signal === undefined) {
        throw new SignaledElementMissing();
      }
      const locator = page.locator(elementPathSelectorOf(openerPath, signal));
      // LU-SFIX3-A: 押す時点の確かめ（受け手を先に付け、付けた時点の事実を、読み直した候補と比べる。押した後、事象が届いた時点の事実が違えば受け手が止める）。
      const pressed = await pressWithPressTimeGuard(page, opener.backendNodeId, deadlineAtMs, async (armedFacts) => {
        // (a) 同じ部品で読み直し、同じ番号の要素が、同じ事実の、ちょうど 1 つの押してよい開き手か。受け手を付けた時点の語と名前も同じか。
        const again = await pressTargetOf(page, openerIdentityDigest, row.path, deadlineAtMs, pressableOpeners);
        const [candidate] = again?.matches ?? [];
        if (again === null || candidate === undefined || openerProblemOf(again.matches) !== null || again.element?.backendNodeId !== opener.backendNodeId
          || !samePath(again.element.path, openerPath) || openerFactsOf(candidate) !== facts || !pressTimeFactsMatchCandidate(armedFacts, candidate)) {
          return false;
        }
        // (b) 番号の要素が文書につながり、行の子孫で、位置が押す位置のままか。
        const inRow = await readElementsInIsolatedWorld(page, openerStillInRowInPage, { openerPath }, deadlineAtMs, {
          argumentElements: [opener.backendNodeId, row.backendNodeId],
        });
        return inRow.status === 'READ' && inRow.value === true && await locator.count() === 1;
      }, async () => {
        clickAttempted = true;
        await locator.click({ timeout: timeoutMs, noWaitAfter: true });
      });
      if (pressed !== 'PRESSED') {
        stopped = true;
        throw new OpenerChanged();
      }
    });
    if (outcome.status === 'DONE') {
      return 'PRESSED';
    }
    // 押す時点の確かめで止めた・押す前に外れたときは、押さなかった扱い。
    return stopped || !clickAttempted ? 'PAGE_UNREADABLE' : 'PRESS_FAILED';
  } catch {
    return 'PAGE_UNREADABLE';
  }
}

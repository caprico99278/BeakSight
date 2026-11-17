// isolated world の読み取り（DEF-087。Task 27 の設計書 4.2、4.5）。ブラウザの部品（`tests/architecture/discovery-boundary.test.ts` の
// `BROWSER_DISCOVERY_FILES`）。発見の probe（`probe.ts`）と READ の結果の構造の読み取り（`read-executor.ts`）の、ページの中の関数を動かす
// ただ 1 つの入口（`src/discovery/` は `page.evaluate` などの main world の呼び出しを使わない。Gate `discovery-boundary` の (e)）。
// - なぜ isolated world か: main world で動かすと、ページの JS が、標準の getter とメソッド（`Function.prototype.call`、prototype の getter、
//   組み込みのメソッドなど）を書き換えて、読み取りの結果を偽れる（削除の form を GET の検索の form と読ませる、表の行の数を偽るなど）。
//   読み取りの間に、書き換えた getter としてページの JS が走ることもある。isolated world は、同じ DOM を、ページの JS と別の global と
//   prototype で読むので、ページの JS は結果を偽れず、読み取りの間に走らない（DEF-087 の調査で、試した 6 種類の偽りを両方の Chromium で
//   確かめた）。DOM clobbering（要素の名前が document や form のプロパティを隠す）は isolated world でも起きるので、関数の本体は、今までどおり
//   標準の prototype の getter とメソッドで読む。
// - 送る CDP の命令は、閉じた一覧（`ISOLATED_READ_CDP_COMMANDS`）の 3 つだけ: `Page.getFrameTree`（main frame の id）→ `Page.createIsolatedWorld`
//   （main frame に、名前 `ISOLATED_READ_WORLD_NAME` の world を作る。全権のアクセスは与えない）→ `Runtime.callFunctionOn`（その world の
//   実行の文脈の id で、関数を文字列にして動かす。引数は JSON で渡せる値だけ。結果は値で受け取る）。session は呼ぶたびに新しく開き、
//   読み終わったら（失敗しても）切る（`cdp-session.ts`）。
// - 期限（`deadlineAtMs`）は、呼ぶ側の名前つきの定数（発見の `DISCOVERY_READ_TIMEOUT_MS`、READ の `READ_STRUCTURE_READ_TIMEOUT_MS`、落ち着きの
//   待ちの期限）から決まる（main world で読んでいたときと同じ扱い）。
// - 読めなかった（fail-closed）: session を開けない、期限切れ、命令の失敗（読み込み直しの後の古い world の id を含む）、関数の例外
//   （`exceptionDetails`）、結果の形の誤り。どれも `FAILED` を返し、呼ぶ側は、今の読めなかった場合（`INCOMPLETE_READ_FAILED`、構造の `FAILED`）
//   と同じ結果にする。
// - 要素の橋渡し（T32j-4。Task 32 の設計書 4.4 の「CC-068 の設計」の 2。調査 T32j-3 の Ri・Ii・Bx）: ログインの form の確かめ、Interaction の
//   候補の解決と読み取り、書き込みの段の同じ要素の確かめが、要素を isolated world の外へ持ち出さずに扱うための、ただ 1 つの部品。
//   (a) `readElementsInIsolatedWorld`: 読み、値と要素の参照（CDP の backendNodeId と、文書の根からの位置）を返す（LU-SFIX2-A: 前に確かめた要素を
//   番号で渡して読む `argumentElements` と、読んだ値で返す要素を選ぶ `choose`。確かめと番号を同じ 1 回の読み取りにするため）。(b) `readElementInIsolatedWorld`:
//   backendNodeId の要素を isolated world の文脈で解決して読む。(c) `elementHandleOf`: 合図つきの位置の Locator で ElementHandle を得る（操作は
//   handle で行う）。(d) `withSignaledElements`（T32R-fix-I1。独立レビュー T32R の I-1）: backendNodeId の要素に、isolated world で合図の受け手を
//   付けて使い、終わったら（失敗・期限切れでも）外す。受け手は、合図の事象の的が、その要素のときだけ取り消す。合図つきの Locator
//   （`src/browser/element-path-engine.ts` の自前の selector engine。Playwright の utility world で、標準の getter で位置をたどる）は、位置の
//   要素に合図を送り、取り消されたときだけ要素を返すので、位置の要素と確かめの時の要素を 1 つの同期の呼び出しの中で照らす（照らした後に
//   入れ替わる窓がない）。合図の名前は 1 回ごとの暗号の乱数で、ページの JS からは読めない（既知の限界は engine の説明）。
//   同じ要素かの確かめ（DEF-114）は、確かめた読み取りと同じ読み取りの番号（(a) の `choose`）で行う（LU-SFIX2-A。位置で番号を引く部品は除いた）。命令の閉じた一覧は `ISOLATED_ELEMENT_CDP_COMMANDS`
//   （上の 3 つに、`DOM.describeNode`（要素の backendNodeId）と `DOM.resolveNode`（backendNodeId の要素を isolated world の文脈に解決）を足す）。
//   backendNodeId は CDP の session をまたげる（objectId はまたげない）。session は今の決まりどおり読むたびに開く。命令の失敗（ページが移った、
//   要素が消えた）は `FAILED` で返し、呼ぶ側は今の evaluate の例外と同じ扱いにする。
import type { CDPSession, ElementHandle, Page } from 'playwright';
import { isRecord } from '../core/guards.js';
import { DISCOVERY_SESSION_DETACH_TIMEOUT_MS, DiscoveryCdpReadFailure, readWithDiscoveryCdpSession, sendDiscoveryCdpCommand } from './cdp-session.js';
import { elementPathSelectorOf, ensureElementPathEngine, isElementPathSignal, newElementPathSignal } from '../browser/element-path-engine.js';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';
import type { ElementRef } from '../browser/port/browser-port.js';

/** この部品が送る CDP の命令の閉じた一覧（送る順）。 */
export const ISOLATED_READ_CDP_COMMANDS = Object.freeze([
  'Page.getFrameTree',
  'Page.createIsolatedWorld',
  'Runtime.callFunctionOn',
] as const);
/** 要素の橋渡し（T32j-4）が送る CDP の命令の閉じた一覧（`ISOLATED_READ_CDP_COMMANDS` に、要素の backendNodeId を読む命令と、解決する命令を足す）。 */
export const ISOLATED_ELEMENT_CDP_COMMANDS = Object.freeze([
  ...ISOLATED_READ_CDP_COMMANDS,
  'DOM.describeNode',
  'DOM.resolveNode',
] as const);
type IsolatedReadCdpCommand = (typeof ISOLATED_ELEMENT_CDP_COMMANDS)[number];

/** isolated world の名前（ページの JS からは見えない。DevTools などで、BeakSight の読み取りの world と分かるようにする）。 */
export const ISOLATED_READ_WORLD_NAME = 'beaksight-discovery-read';

/** isolated world の読み取りの結果。`READ` の値は、関数の戻り値（JSON の値。形は呼ぶ側が確かめる）。 */
export type IsolatedReadOutcome = { readonly status: 'READ'; readonly value: unknown } | { readonly status: 'FAILED' };

const ISOLATED_READ_FAILED: IsolatedReadOutcome = Object.freeze({ status: 'FAILED' });

const send = (
  session: CDPSession,
  method: IsolatedReadCdpCommand,
  params: Record<string, unknown>,
  deadlineAtMs: number | undefined,
): Promise<Record<string, unknown>> => sendDiscoveryCdpCommand(session, method, params, deadlineAtMs);

/** main frame に isolated world（名前 `ISOLATED_READ_WORLD_NAME`。同じ名前なら同じ文脈）を作り、その実行の文脈の id を返す。 */
async function isolatedContextOf(session: CDPSession, deadlineAtMs: number | undefined): Promise<number> {
  const { frameTree } = await send(session, 'Page.getFrameTree', {}, deadlineAtMs);
  const frameId = isRecord(frameTree) && isRecord(frameTree['frame']) ? frameTree['frame']['id'] : undefined;
  if (typeof frameId !== 'string') {
    throw new DiscoveryCdpReadFailure();
  }
  const { executionContextId } = await send(session, 'Page.createIsolatedWorld', { frameId, worldName: ISOLATED_READ_WORLD_NAME }, deadlineAtMs);
  if (!Number.isSafeInteger(executionContextId)) {
    throw new DiscoveryCdpReadFailure();
  }
  return executionContextId as number;
}

/**
 * `readInPage(input)` を、page の main frame の isolated world で動かし、戻り値を返す（例外を投げない）。`readInPage` はページの中で動く関数
 * （外の値を参照しない。文字列にして渡す）。`input` は JSON で渡せる値だけ。`deadlineAtMs` までに読めなければ `FAILED`（LZ-3b: `undefined` は期限なし）。
 */
export async function readInIsolatedWorld<Input>(
  page: Page,
  readInPage: (input: Input) => unknown,
  input: Input,
  deadlineAtMs: number | undefined,
): Promise<IsolatedReadOutcome> {
  return readWithDiscoveryCdpSession(page, deadlineAtMs, ISOLATED_READ_FAILED, async (session) => {
    const executionContextId = await isolatedContextOf(session, deadlineAtMs);
    const { result, exceptionDetails } = await send(session, 'Runtime.callFunctionOn', {
      functionDeclaration: String(readInPage),
      executionContextId,
      arguments: [{ value: input }],
      returnByValue: true,
      silent: true,
    }, deadlineAtMs);
    if (exceptionDetails !== undefined || !isRecord(result)) {
      throw new DiscoveryCdpReadFailure();
    }
    return Object.freeze({ status: 'READ', value: result['value'] } satisfies IsolatedReadOutcome);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// 要素の橋渡し（T32j-4）
// ---------------------------------------------------------------------------------------------------------------

/** ページの中の関数が、要素の参照を返すときの形（`value` は JSON で渡せる値、`elements` は参照を返す要素）。 */
export interface InPageElementsResult {
  readonly value: unknown;
  readonly elements: readonly Element[];
}

/**
 * isolated world で読んだ要素の参照。`backendNodeId` は CDP の要素の番号（文書が同じ間は変わらない。session をまたげる）。形の owner は
 * ブラウザに頼む口の型（RB-1。`src/browser/port/browser-port.ts` の `ElementRef`）。
 */
export type IsolatedElementReference = ElementRef;

/** 要素の参照を返す読み取りの結果。 */
export type IsolatedElementsOutcome =
  | { readonly status: 'READ'; readonly value: unknown; readonly elements: readonly IsolatedElementReference[] }
  | { readonly status: 'FAILED' };

const ISOLATED_ELEMENTS_FAILED: IsolatedElementsOutcome = Object.freeze({ status: 'FAILED' });

/** 読んだ結果（`this`）の値と、要素の位置を、値で返す（ページの中で動く）。形が違えば例外（読めなかった）。 */
const summarizeElementsInPage = composeInPage((R: StandardReaders, envelope: InPageElementsResult) => {
  const elements: unknown = envelope.elements;
  if (!Array.isArray(elements) || !elements.every((element) => element instanceof Element)) {
    throw new Error('Invalid element references');
  }
  return { value: envelope.value, paths: elements.map((element: Element) => R.elementPathOf(element)) };
});
/** `this` の読んだ結果を、上の関数に渡す宣言。 */
const SUMMARIZE_DECLARATION = `function () { return (${String(summarizeElementsInPage)})(this); }`;
/** `this` の読んだ結果の、`index` 番目の要素を返す宣言（結果は objectId で受ける）。 */
const ELEMENT_AT_DECLARATION = 'function (index) { return this.elements[index]; }';

/** objectId の要素の backendNodeId。 */
async function backendNodeIdOf(session: CDPSession, objectId: unknown, deadlineAtMs: number | undefined): Promise<number> {
  if (typeof objectId !== 'string') {
    throw new DiscoveryCdpReadFailure();
  }
  const { node } = await send(session, 'DOM.describeNode', { objectId }, deadlineAtMs);
  const backendNodeId = isRecord(node) ? node['backendNodeId'] : undefined;
  if (typeof backendNodeId !== 'number' || !Number.isSafeInteger(backendNodeId)) {
    throw new DiscoveryCdpReadFailure();
  }
  return backendNodeId;
}

const isPathValue = (value: unknown): value is readonly number[] | null =>
  value === null || (Array.isArray(value) && value.every((step) => Number.isSafeInteger(step) && step >= 0));

/**
 * LU-SFIX2-A（LU-SREV2 の Critical-1・Minor-1）: 要素の参照を返す読み取りの、任意の指定。
 * - `argumentElements`: 読む関数に渡す要素の backendNodeId（並びの順）。isolated world の文脈に解決し（`DOM.resolveNode`）、読む関数の 2 つ目の引数（要素の
 *   並び）で渡す。位置で引き直さずに、前に確かめた要素そのものを読むため。どれかを解決できなければ `FAILED`。
 * - `choose`: 読んだ値（`value`）を見て、参照を返す要素の番号（`elements` の中の位置）を決める。同じ読み取りの要素（読んだ時に `elements` に入れた要素
 *   そのもの）の参照を返すので、確かめた要素と参照の要素の間に、ページの JS が入れ替える窓がない。null・範囲の外・重なりは `FAILED`。省くと、すべての要素。
 */
export interface IsolatedElementsReadOptions {
  readonly argumentElements?: readonly number[];
  readonly choose?: (value: unknown) => readonly number[] | null;
}

/** 読む関数に要素の並びを 2 つ目の引数で渡す宣言（要素は `arguments` の objectId で受ける）。 */
const withArgumentElementsDeclaration = (readInPage: (...args: never[]) => unknown): string =>
  `function (input, ...elements) { return (${String(readInPage)})(input, elements); }`;

/**
 * (a) `readInPage(input)` を isolated world で動かし（`readInPage` は `InPageElementsResult` を返す）、値と、要素の参照を返す（例外を投げない）。
 * 命令: 文脈を作る 2 つ →（`argumentElements` があれば、要素ごとに `DOM.resolveNode`）→ `Runtime.callFunctionOn`（結果を objectId で受ける）→
 * `Runtime.callFunctionOn`（値と位置を値で受ける）→ 返す要素ごとに `Runtime.callFunctionOn`（要素を objectId で受ける）と `DOM.describeNode`。
 * LU-SFIX2-A: 返す要素は `options.choose` で選べる（選んだ要素だけ命令を送る）。
 */
export async function readElementsInIsolatedWorld<Input>(
  page: Page,
  readInPage: (input: Input, elements?: readonly Element[]) => InPageElementsResult,
  input: Input,
  deadlineAtMs: number | undefined,
  options: IsolatedElementsReadOptions = {},
): Promise<IsolatedElementsOutcome> {
  return readWithDiscoveryCdpSession(page, deadlineAtMs, ISOLATED_ELEMENTS_FAILED, async (session) => {
    const executionContextId = await isolatedContextOf(session, deadlineAtMs);
    const elementArguments: { readonly objectId: string }[] = [];
    for (const backendNodeId of options.argumentElements ?? []) {
      const { object } = await send(session, 'DOM.resolveNode', { backendNodeId, executionContextId }, deadlineAtMs);
      const objectId = isRecord(object) ? object['objectId'] : undefined;
      if (typeof objectId !== 'string') {
        throw new DiscoveryCdpReadFailure();
      }
      elementArguments.push({ objectId });
    }
    const read = await send(session, 'Runtime.callFunctionOn', {
      functionDeclaration: options.argumentElements === undefined ? String(readInPage) : withArgumentElementsDeclaration(readInPage),
      executionContextId,
      arguments: [{ value: input }, ...elementArguments],
      returnByValue: false,
      silent: true,
    }, deadlineAtMs);
    const envelopeId = isRecord(read['result']) ? read['result']['objectId'] : undefined;
    if (read['exceptionDetails'] !== undefined || typeof envelopeId !== 'string') {
      throw new DiscoveryCdpReadFailure();
    }
    const summary = await send(session, 'Runtime.callFunctionOn', {
      functionDeclaration: SUMMARIZE_DECLARATION,
      objectId: envelopeId,
      returnByValue: true,
      silent: true,
    }, deadlineAtMs);
    const summarized = isRecord(summary['result']) ? summary['result']['value'] : undefined;
    if (summary['exceptionDetails'] !== undefined || !isRecord(summarized) || !Array.isArray(summarized['paths'])
      || !summarized['paths'].every(isPathValue)) {
      throw new DiscoveryCdpReadFailure();
    }
    const paths: readonly (readonly number[] | null)[] = summarized['paths'];
    const chosen = options.choose === undefined ? paths.map((_path, index) => index) : options.choose(summarized['value']);
    if (chosen === null || !Array.isArray(chosen) || new Set(chosen).size !== chosen.length
      || !chosen.every((index) => Number.isSafeInteger(index) && index >= 0 && index < paths.length)) {
      throw new DiscoveryCdpReadFailure();
    }
    const elements: IsolatedElementReference[] = [];
    for (const index of chosen) {
      const path = paths[index] ?? null;
      const element = await send(session, 'Runtime.callFunctionOn', {
        functionDeclaration: ELEMENT_AT_DECLARATION,
        objectId: envelopeId,
        arguments: [{ value: index }],
        returnByValue: false,
        silent: true,
      }, deadlineAtMs);
      if (element['exceptionDetails'] !== undefined || !isRecord(element['result'])) {
        throw new DiscoveryCdpReadFailure();
      }
      const backendNodeId = await backendNodeIdOf(session, element['result']['objectId'], deadlineAtMs);
      elements.push(Object.freeze({ backendNodeId, path: path === null ? null : Object.freeze([...path]) }));
    }
    return Object.freeze({ status: 'READ', value: summarized['value'], elements: Object.freeze(elements) } satisfies IsolatedElementsOutcome);
  });
}

/**
 * (b) backendNodeId の要素を isolated world の文脈に解決し、`readInPage(element, input)` を動かして、戻り値を返す（例外を投げない）。要素が
 * 文書から外されていても読める（`isConnected` が false）。ページが移った後など、解決できなければ `FAILED`。
 */
export async function readElementInIsolatedWorld<Input>(
  page: Page,
  backendNodeId: number,
  readInPage: (element: Element, input: Input) => unknown,
  input: Input,
  deadlineAtMs: number,
): Promise<IsolatedReadOutcome> {
  return readWithDiscoveryCdpSession(page, deadlineAtMs, ISOLATED_READ_FAILED, async (session) => {
    const executionContextId = await isolatedContextOf(session, deadlineAtMs);
    const { object } = await send(session, 'DOM.resolveNode', { backendNodeId, executionContextId }, deadlineAtMs);
    const objectId = isRecord(object) ? object['objectId'] : undefined;
    if (typeof objectId !== 'string') {
      throw new DiscoveryCdpReadFailure();
    }
    const { result, exceptionDetails } = await send(session, 'Runtime.callFunctionOn', {
      functionDeclaration: `function (input) { return (${String(readInPage)})(this, input); }`,
      objectId,
      arguments: [{ value: input }],
      returnByValue: true,
      silent: true,
    }, deadlineAtMs);
    if (exceptionDetails !== undefined || !isRecord(result)) {
      throw new DiscoveryCdpReadFailure();
    }
    return Object.freeze({ status: 'READ', value: result['value'] } satisfies IsolatedReadOutcome);
  });
}

/**
 * 合図の受け手を付ける宣言（isolated world で動く。`this` は backendNodeId の要素）。合図の事象の的が `this` のときだけ取り消す。受け手は、
 * isolated world の global の表に、合図の名前で持つ（ページの JS からは見えない）。DOM clobbering を受けないように、標準のメソッドで付ける。
 */
const ARM_SIGNAL_DECLARATION = `function (signal) {
  const target = this;
  const registry = globalThis.__beaksightElementSignals || (globalThis.__beaksightElementSignals = new Map());
  const receiver = (event) => { if (event.target === target) { Event.prototype.preventDefault.call(event); } };
  EventTarget.prototype.addEventListener.call(target, signal, receiver, { capture: true });
  registry.set(signal, { target, receiver });
  return true;
}`;
/** 合図の受け手を外す宣言（isolated world の文脈で動く）。外した数を返す。 */
const DISARM_SIGNALS_DECLARATION = `function (signals) {
  const registry = globalThis.__beaksightElementSignals;
  let removed = 0;
  for (let index = 0; index < signals.length; index += 1) {
    const entry = registry && registry.get(signals[index]);
    if (entry) {
      EventTarget.prototype.removeEventListener.call(entry.target, signals[index], entry.receiver, { capture: true });
      registry.delete(signals[index]);
      removed += 1;
    }
  }
  return removed;
}`;

/** 合図の受け手を付けて使った結果。`FAILED` の `error` は、`use` が投げた例外（付けられなかったときなどは undefined）。 */
export type SignaledElementsOutcome<T> =
  | { readonly status: 'DONE'; readonly value: T }
  | { readonly status: 'FAILED'; readonly error?: unknown };

/**
 * (d) backendNodeId の要素（並びの順）に、isolated world で合図の受け手を付け（要素ごとに 1 回ごとの合図の名前）、`use(signals)` を動かし、
 * 終わったら（成功・失敗・期限切れのどれでも）受け手を外す。`use` の中では、`elementPathSelectorOf(path, signals[i])` の Locator が、位置の
 * 要素が i 番目の要素のときだけ要素を返す。付けられない（要素が解決できない、命令の失敗、期限切れ）・`use` が投げたときは `FAILED`（`use` の
 * 例外は `error` に入れて返す）。外すのに失敗しても、結果は変えない（例外を投げない）。
 */
export async function withSignaledElements<T>(
  page: Page,
  backendNodeIds: readonly number[],
  deadlineAtMs: number,
  use: (signals: readonly string[]) => Promise<T>,
): Promise<SignaledElementsOutcome<T>> {
  let executionContextId: number | undefined;
  const signals: string[] = [];
  let useFailure: { readonly error: unknown } | undefined;
  const outcome = await readWithDiscoveryCdpSession<SignaledElementsOutcome<T>>(page, deadlineAtMs, Object.freeze({ status: 'FAILED' }), async (session) => {
    executionContextId = await isolatedContextOf(session, deadlineAtMs);
    for (const backendNodeId of backendNodeIds) {
      const { object } = await send(session, 'DOM.resolveNode', { backendNodeId, executionContextId }, deadlineAtMs);
      const objectId = isRecord(object) ? object['objectId'] : undefined;
      if (typeof objectId !== 'string') {
        throw new DiscoveryCdpReadFailure();
      }
      const signal = newElementPathSignal();
      if (!isElementPathSignal(signal)) {
        throw new DiscoveryCdpReadFailure();
      }
      signals.push(signal);
      const armed = await send(session, 'Runtime.callFunctionOn', {
        functionDeclaration: ARM_SIGNAL_DECLARATION,
        objectId,
        arguments: [{ value: signal }],
        returnByValue: true,
        silent: true,
      }, deadlineAtMs);
      if (armed['exceptionDetails'] !== undefined) {
        throw new DiscoveryCdpReadFailure();
      }
    }
    await ensureElementPathEngine();
    try {
      return Object.freeze({ status: 'DONE', value: await use(Object.freeze([...signals])) } as SignaledElementsOutcome<T>);
    } catch (error) {
      useFailure = { error };
      throw error;
    }
  }, async (session, releaseDeadlineAtMs) => {
    if (executionContextId === undefined || signals.length === 0) {
      return;
    }
    await send(session, 'Runtime.callFunctionOn', {
      functionDeclaration: DISARM_SIGNALS_DECLARATION,
      executionContextId,
      arguments: [{ value: signals }],
      returnByValue: true,
      silent: true,
    }, releaseDeadlineAtMs).catch(() => undefined);
  });
  return useFailure === undefined ? outcome : Object.freeze({ status: 'FAILED' as const, error: useFailure.error });
}

// ---------------------------------------------------------------------------------------------------------------
// LU-SFIX3-A（LU-SREV3 の Critical-1）: 押す時点の確かめ（ただ 1 つの部品。一覧の行の開き手・API の送り手・フォームの送り手の押す所が使う）
// ---------------------------------------------------------------------------------------------------------------

/** 押す時点の確かめの受け手を付ける事象の型（閉じた一覧。`window` の capture の段）。 */
export const PRESS_TIME_GUARD_EVENT_TYPES = Object.freeze(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'submit'] as const);

/**
 * 押す時点の、要素の事実（押す要素を決めた確かめと比べるもの。ページの中で、受け手を付けた時点と、事象が届いた時点に作る）。
 * - `text`: 送信ボタンの文言（発見の probe の `submitterTextOf` と同じ決まり: `input` は `value`（画像は `alt`）、ほかは文字。`aria-label`・`title` を足し、
 *   空白をまとめ、同じものを除いて空白でつなぐ）。呼ぶ側が語（`submitterWordsOf`）と名前の有無にして、確かめた候補と比べる。値は記録しない。
 * - `overrides`: `formaction`・`formmethod`・`formenctype`・`formtarget` の属性があるか（フォームの送り手が、確かめた送信ボタンと比べる）。
 * - `formOwnerMatches`（FIX-237 fix round 1。SREV-237 の Critical-1）: 押す要素の属する form（form owner。`button`・`input` の `form`。ほかの要素は
 *   null）が、期待の form の要素と同一か（isolated world の参照で比べる）。期待の form は、呼ぶ側が渡した backendNodeId の要素（form の書き込み）か、
 *   渡さなければ受け手を付けた時点の form owner。押す瞬間にページが送信ボタンを別の form に移す・form 属性で付け替えると偽になり、受け手が止める。
 */
export interface PressTimeFacts {
  readonly connected: boolean;
  readonly localName: string;
  readonly type: string | null;
  readonly role: string | null;
  readonly disabled: boolean;
  readonly text: string;
  readonly overrides: readonly boolean[];
  readonly formOwnerMatches: boolean;
}

/** 送信ボタンの上書きの属性（`PressTimeFacts.overrides` の順）。 */
export const PRESS_TIME_OVERRIDE_ATTRIBUTES = Object.freeze(['formaction', 'formmethod', 'formenctype', 'formtarget'] as const);

/** 押す時点の要素の事実を作る（ページの中で動く。標準の getter とメソッドで読み、ページに何も書かない）。 */
const pressTimeFactsInPage = composeInPage((R: StandardReaders, element: Element, overrideAttributes: readonly string[]): Omit<PressTimeFacts, 'formOwnerMatches'> => {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const attribute = (name: string): string | null => Element.prototype.getAttribute.call(element, name);
  const localName = text(R.standardGetter<string>(Element.prototype, 'localName')(element));
  const own = localName === 'input'
    ? text(attribute(text(attribute('type')).toLowerCase() === 'image' ? 'alt' : 'value'))
    : text(R.standardGetter<string | null>(Node.prototype, 'textContent')(element));
  const parts = [own, text(attribute('aria-label')), text(attribute('title'))]
    .map((part) => part.replace(/\s+/gu, ' ').trim())
    .filter((part, index, all) => part.length > 0 && all.indexOf(part) === index);
  return {
    connected: R.standardGetter<boolean>(Node.prototype, 'isConnected')(element),
    localName,
    type: attribute('type'),
    role: attribute('role'),
    disabled: Element.prototype.matches.call(element, ':disabled'),
    text: parts.join(' '),
    overrides: overrideAttributes.map((name) => Element.prototype.hasAttribute.call(element, name)),
  };
});

/**
 * FIX-237 fix round 1: 押す要素の属する form（form owner。`button`・`input` の標準の `form` の getter で読む。ほかの要素は null）。ページの中で動く。
 */
const formOwnerInPage = composeInPage((R: StandardReaders, element: Element): HTMLFormElement | null => {
  if (element instanceof HTMLButtonElement) {
    return R.standardGetter<HTMLFormElement | null>(HTMLButtonElement.prototype, 'form')(element);
  }
  if (element instanceof HTMLInputElement) {
    return R.standardGetter<HTMLFormElement | null>(HTMLInputElement.prototype, 'form')(element);
  }
  return null;
});

/**
 * 押す時点の確かめの受け手を付ける宣言（isolated world で動く。`this` は押す要素）。付けた時点の事実を作って持ち、`window` の capture の段の受け手で、
 * 事象が届いた時点に、(1) 事象の的が押す要素そのものか、その中の要素で、(2) 押す要素の事実が付けた時点と同じか、を確かめる。外れたら（一度外れた後は、
 * どの事象も）`stopImmediatePropagation` と `preventDefault` で止め、止めた印を立てる。付けた時点の事実を返す。FIX-237 fix round 1: 事実に、押す要素の
 * form owner が期待の form と同一か（`formOwnerMatches`）を入れる（押す瞬間に別の form へ移す・form 属性で付け替えると、事実が変わって止める）。
 * 期待の form を渡されたとき（form の書き込み）は、`submit` の事象を、的が期待の form のときだけ通す（この受け手の後に、送信ボタンの受け手などが別の form
 * へ移したときも、送る前に止める）。渡されないとき（操作さがし・API の送り手・開き手）は、submit を確かめない（form のない要素から送る SPA の作りを
 * 止めない）。宣言の文字列の中には説明を書かない（文言の検査 GATE-UI06）。
 */
const ARM_PRESS_GUARD_DECLARATION = `function (token, types, overrideAttributes, identityOnly, expectedFormGiven, expectedFormElement) {
  const element = this;
  const factsOf = (${String(pressTimeFactsInPage)});
  const formOwnerOf = (${String(formOwnerInPage)});
  const expectedForm = expectedFormGiven === true ? (expectedFormElement === undefined ? null : expectedFormElement) : formOwnerOf(element);
  const factsNow = () => Object.assign(factsOf(element, overrideAttributes), { formOwnerMatches: formOwnerOf(element) === expectedForm });
  const keyOf = (facts) => JSON.stringify(identityOnly === true ? [facts.connected, facts.formOwnerMatches] : facts);
  const armedFacts = factsNow();
  const armedKey = keyOf(armedFacts);
  const armed = JSON.stringify(armedFacts);
  const registry = globalThis.__beaksightPressGuards || (globalThis.__beaksightPressGuards = new Map());
  const entry = { tripped: false, types, receiver: null };
  entry.receiver = (event) => {
    let ok = !entry.tripped;
    if (ok && event.type === 'submit') {
      ok = expectedFormGiven !== true || (expectedForm !== null && event.target === expectedForm);
    } else if (ok) {
      const hit = event.target;
      ok = hit instanceof Node && (hit === element || Node.prototype.contains.call(element, hit));
    }
    if (ok && event.type !== 'submit') {
      try { ok = keyOf(factsNow()) === armedKey; } catch (error) { ok = false; }
    }
    if (!ok) {
      entry.tripped = true;
      Event.prototype.stopImmediatePropagation.call(event);
      Event.prototype.preventDefault.call(event);
    }
  };
  for (let index = 0; index < types.length; index += 1) {
    EventTarget.prototype.addEventListener.call(window, types[index], entry.receiver, { capture: true });
  }
  registry.set(token, entry);
  return armed;
}`;
/** 止めた印を読む宣言（印がなければ止めた側に倒す）。 */
const PRESS_GUARD_TRIPPED_DECLARATION = `function (token) {
  const entry = globalThis.__beaksightPressGuards && globalThis.__beaksightPressGuards.get(token);
  return entry ? entry.tripped === true : true;
}`;
/** 受け手を外す宣言。 */
const DISARM_PRESS_GUARD_DECLARATION = `function (token) {
  const registry = globalThis.__beaksightPressGuards;
  const entry = registry && registry.get(token);
  if (entry) {
    for (let index = 0; index < entry.types.length; index += 1) {
      EventTarget.prototype.removeEventListener.call(window, entry.types[index], entry.receiver, { capture: true });
    }
    registry.delete(token);
  }
  return true;
}`;

const isPressTimeFacts = (value: unknown): value is PressTimeFacts => isRecord(value)
  && typeof value['connected'] === 'boolean' && typeof value['localName'] === 'string'
  && (value['type'] === null || typeof value['type'] === 'string') && (value['role'] === null || typeof value['role'] === 'string')
  && typeof value['disabled'] === 'boolean' && typeof value['text'] === 'string'
  && Array.isArray(value['overrides']) && value['overrides'].length === PRESS_TIME_OVERRIDE_ATTRIBUTES.length
  && value['overrides'].every((flag) => typeof flag === 'boolean') && typeof value['formOwnerMatches'] === 'boolean';

/** FIX-237 fix round 1: 押す時点の確かめの指定。`formBackendNodeId`: 押す要素の属する form であるべき要素（form の書き込みの、確かめの時の form）。 */
export interface PressTimeGuardOptions {
  readonly formBackendNodeId?: number;
  /**
   * FIX-237 fix round 2（SREV-237 の Minor-A）: 事象が届いた時点に比べる事実。`ALL`（既定。書き込みの段の form・API の送り手・開き手）は全部、`IDENTITY`
   * （操作さがし。届けない）は、つながり（isConnected）と form owner の一致だけ（文言・属性は比べない。的は、どちらでも確かめる）。
   */
  readonly comparedFacts?: PressTimeComparedFacts;
}

/** FIX-237 fix round 2: 押す時点の受け手が比べる事実の選び方（`PressTimeGuardOptions.comparedFacts`）。 */
export type PressTimeComparedFacts = 'ALL' | 'IDENTITY';

/** 押す時点の確かめ（付けた時点の事実と、止めたかを読む口）。 */
export interface PressTimeGuard {
  /** 受け手を付けた時点の事実（呼ぶ側が、確かめた候補と比べる。違えば押さない）。 */
  readonly armedFacts: PressTimeFacts;
  /** 受け手が事象を止めたか（読めなければ止めた側に倒す）。押した後に呼ぶ。 */
  readonly tripped: () => Promise<boolean>;
}

/**
 * LU-SFIX3-A（LU-SREV3 の Critical-1）: 押す要素（backendNodeId）に、isolated world で押す時点の確かめの受け手（`window` の capture の段。
 * `PRESS_TIME_GUARD_EVENT_TYPES`）を付けて `use(guard)` を動かし、終わったら（成功・失敗・期限切れのどれでも）外す。受け手は、事象が届いた時点の、事象の的と
 * 要素の事実（`PressTimeFacts`）を確かめ、付けた時点と違えば事象を止める（ページの要素の受け手に届かない）。付けられないとき・`use` が投げたときは `FAILED`。
 * 限界: ページが先に `window` の capture の段に付けた受け手は、この受け手より前に動く（止められない）。
 */
export async function withPressTimeGuard<T>(
  page: Page,
  backendNodeId: number,
  deadlineAtMs: number,
  use: (guard: PressTimeGuard) => Promise<T>,
  options: PressTimeGuardOptions = {},
): Promise<SignaledElementsOutcome<T>> {
  let executionContextId: number | undefined;
  let token: string | null = null;
  let useFailure: { readonly error: unknown } | undefined;
  const outcome = await readWithDiscoveryCdpSession<SignaledElementsOutcome<T>>(page, deadlineAtMs, Object.freeze({ status: 'FAILED' }), async (session) => {
    executionContextId = await isolatedContextOf(session, deadlineAtMs);
    const contextId = executionContextId;
    const objectIdOf = async (id: number): Promise<string> => {
      const { object } = await send(session, 'DOM.resolveNode', { backendNodeId: id, executionContextId: contextId }, deadlineAtMs);
      const resolved = isRecord(object) ? object['objectId'] : undefined;
      if (typeof resolved !== 'string') {
        throw new DiscoveryCdpReadFailure();
      }
      return resolved;
    };
    const objectId = await objectIdOf(backendNodeId);
    // FIX-237 fix round 1: 期待の form（渡されたときだけ。同じ isolated world の参照にして、受け手が `===` で比べる）。
    const formArguments = options.formBackendNodeId === undefined
      ? [{ value: false }]
      : [{ value: true }, { objectId: await objectIdOf(options.formBackendNodeId) }];
    const signal = newElementPathSignal();
    if (!isElementPathSignal(signal)) {
      throw new DiscoveryCdpReadFailure();
    }
    token = signal;
    const armed = await send(session, 'Runtime.callFunctionOn', {
      functionDeclaration: ARM_PRESS_GUARD_DECLARATION,
      objectId,
      arguments: [{ value: signal }, { value: [...PRESS_TIME_GUARD_EVENT_TYPES] }, { value: [...PRESS_TIME_OVERRIDE_ATTRIBUTES] },
        { value: options.comparedFacts === 'IDENTITY' }, ...formArguments],
      returnByValue: true,
      silent: true,
    }, deadlineAtMs);
    const armedValue = isRecord(armed['result']) ? armed['result']['value'] : undefined;
    let armedFacts: unknown = null;
    try {
      armedFacts = typeof armedValue === 'string' ? JSON.parse(armedValue) : null;
    } catch {
      armedFacts = null;
    }
    if (armed['exceptionDetails'] !== undefined || !isPressTimeFacts(armedFacts)) {
      throw new DiscoveryCdpReadFailure();
    }
    const facts: PressTimeFacts = armedFacts;
    const tripped = async (): Promise<boolean> => {
      try {
        const read = await send(session, 'Runtime.callFunctionOn', {
          functionDeclaration: PRESS_GUARD_TRIPPED_DECLARATION,
          executionContextId: contextId,
          arguments: [{ value: signal }],
          returnByValue: true,
          silent: true,
        }, Math.max(deadlineAtMs, Date.now() + DISCOVERY_SESSION_DETACH_TIMEOUT_MS));
        const value = isRecord(read['result']) ? read['result']['value'] : undefined;
        return read['exceptionDetails'] !== undefined || value !== false;
      } catch {
        return true;
      }
    };
    try {
      return Object.freeze({ status: 'DONE', value: await use(Object.freeze({ armedFacts: Object.freeze(facts), tripped })) } as SignaledElementsOutcome<T>);
    } catch (error) {
      useFailure = { error };
      throw error;
    }
  }, async (session, releaseDeadlineAtMs) => {
    if (executionContextId === undefined || token === null) {
      return;
    }
    await send(session, 'Runtime.callFunctionOn', {
      functionDeclaration: DISARM_PRESS_GUARD_DECLARATION,
      executionContextId,
      arguments: [{ value: token }],
      returnByValue: true,
      silent: true,
    }, releaseDeadlineAtMs).catch(() => undefined);
  });
  return useFailure === undefined ? outcome : Object.freeze({ status: 'FAILED' as const, error: useFailure.error });
}

/** LU-SFIX3-A: 押す時点の確かめを通した押下の結果（押す例外は、そのまま呼ぶ側へ投げる）。 */
export type PressTimeOutcome =
  /** 押し、受け手は事象を止めなかった。 */
  | 'PRESSED'
  /** 押したが、受け手が事象を止めた（ページの要素の受け手に届いていない。押さなかった扱い）。 */
  | 'STOPPED'
  /** 受け手を付けた時点の事実が、確かめた候補と違った（押していない）。 */
  | 'NOT_VERIFIED'
  /** 受け手を付けられなかった（押していない）。 */
  | 'UNAVAILABLE';

/**
 * LU-SFIX3-A: 押す時点の確かめを通して押す、ただ 1 つの手順（一覧の行の開き手・API の送り手・フォームの送り手が使う）。受け手を付け（`withPressTimeGuard`）、
 * 付けた時点の事実を `verify` で確かめた候補と比べ（偽なら押さない）、`press` で押し、受け手が事象を止めたかを読む。`verify`・`press` の例外は呼ぶ側へ投げる。
 */
export async function pressWithPressTimeGuard(
  page: Page,
  backendNodeId: number,
  deadlineAtMs: number,
  verify: (facts: PressTimeFacts) => Promise<boolean>,
  press: () => Promise<void>,
  options: PressTimeGuardOptions = {},
): Promise<PressTimeOutcome> {
  const outcome = await withPressTimeGuard(page, backendNodeId, deadlineAtMs, async (guard): Promise<PressTimeOutcome> => {
    // FIX-237 fix round 1: 受け手を付けた時点で、押す要素の form owner が期待の form でなければ押さない（どの呼ぶ側にも共通）。
    if (!guard.armedFacts.formOwnerMatches || !(await verify(guard.armedFacts))) {
      return 'NOT_VERIFIED';
    }
    await press();
    return (await guard.tripped()) ? 'STOPPED' : 'PRESSED';
  }, options);
  if (outcome.status === 'DONE') {
    return outcome.value;
  }
  if (outcome.error !== undefined) {
    throw outcome.error;
  }
  return 'UNAVAILABLE';
}

/**
 * (c) 参照の要素の ElementHandle（操作に使う）。要素に合図の受け手を付け（`withSignaledElements`）、合図つきの位置の Locator（自前の
 * selector engine。Playwright の utility world で、標準の getter でたどる。ページの JS は偽れず、DOM clobbering も受けない）で handle を
 * 得る（待たない）。engine は、位置の要素が参照の要素のときだけ返すので、得た handle は参照の要素を指す。位置がない（shadow root の中など）・
 * handle を得られない・位置の要素が参照の要素でないときは null（得た handle は手放す）。例外を投げない。
 */
export async function elementHandleOf(
  page: Page,
  reference: IsolatedElementReference,
  deadlineAtMs: number,
): Promise<ElementHandle<Element> | null> {
  const path = reference.path;
  if (path === null) {
    return null;
  }
  const outcome = await withSignaledElements(page, [reference.backendNodeId], deadlineAtMs, async ([signal]) => {
    if (signal === undefined) {
      return null;
    }
    const handles = await page.locator(elementPathSelectorOf(path, signal)).elementHandles();
    const [only] = handles;
    if (handles.length !== 1 || only === undefined) {
      await Promise.all(handles.map((extra) => extra.dispose().catch(() => undefined)));
      return null;
    }
    return only as ElementHandle<Element>;
  });
  return outcome.status === 'DONE' ? outcome.value : null;
}

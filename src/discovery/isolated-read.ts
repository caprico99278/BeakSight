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
//   (a) `readElementsInIsolatedWorld`: 読み、値と要素の参照（CDP の backendNodeId と、文書の根からの位置）を返す。(b) `readElementInIsolatedWorld`:
//   backendNodeId の要素を isolated world の文脈で解決して読む。(c) `elementHandleOf`: 合図つきの位置の Locator で ElementHandle を得る（操作は
//   handle で行う）。(d) `withSignaledElements`（T32R-fix-I1。独立レビュー T32R の I-1）: backendNodeId の要素に、isolated world で合図の受け手を
//   付けて使い、終わったら（失敗・期限切れでも）外す。受け手は、合図の事象の的が、その要素のときだけ取り消す。合図つきの Locator
//   （`src/browser/element-path-engine.ts` の自前の selector engine。Playwright の utility world で、標準の getter で位置をたどる）は、位置の
//   要素に合図を送り、取り消されたときだけ要素を返すので、位置の要素と確かめの時の要素を 1 つの同期の呼び出しの中で照らす（照らした後に
//   入れ替わる窓がない）。合図の名前は 1 回ごとの暗号の乱数で、ページの JS からは読めない（既知の限界は engine の説明）。
//   `backendNodeIdsAtPaths` は位置の要素の backendNodeId（同じ要素かの確かめ。DEF-114）。命令の閉じた一覧は `ISOLATED_ELEMENT_CDP_COMMANDS`
//   （上の 3 つに、`DOM.describeNode`（要素の backendNodeId）と `DOM.resolveNode`（backendNodeId の要素を isolated world の文脈に解決）を足す）。
//   backendNodeId は CDP の session をまたげる（objectId はまたげない）。session は今の決まりどおり読むたびに開く。命令の失敗（ページが移った、
//   要素が消えた）は `FAILED` で返し、呼ぶ側は今の evaluate の例外と同じ扱いにする。
import type { CDPSession, ElementHandle, Page } from 'playwright';
import { isRecord } from '../core/guards.js';
import { DiscoveryCdpReadFailure, readWithDiscoveryCdpSession, sendDiscoveryCdpCommand } from './cdp-session.js';
import { elementPathSelectorOf, ensureElementPathEngine, isElementPathSignal, newElementPathSignal } from '../browser/element-path-engine.js';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';

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
  deadlineAtMs: number,
): Promise<Record<string, unknown>> => sendDiscoveryCdpCommand(session, method, params, deadlineAtMs);

/** main frame に isolated world（名前 `ISOLATED_READ_WORLD_NAME`。同じ名前なら同じ文脈）を作り、その実行の文脈の id を返す。 */
async function isolatedContextOf(session: CDPSession, deadlineAtMs: number): Promise<number> {
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
 * （外の値を参照しない。文字列にして渡す）。`input` は JSON で渡せる値だけ。`deadlineAtMs` までに読めなければ `FAILED`。
 */
export async function readInIsolatedWorld<Input>(
  page: Page,
  readInPage: (input: Input) => unknown,
  input: Input,
  deadlineAtMs: number,
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
 * isolated world で読んだ要素の参照。`backendNodeId` は CDP の要素の番号（文書が同じ間は変わらない。session をまたげる）。`path` は文書の根から
 * の位置（`StandardReaders` の `elementPathOf`。shadow root の中と、文書につながっていない要素は null）。
 */
export interface IsolatedElementReference {
  readonly backendNodeId: number;
  readonly path: readonly number[] | null;
}

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
async function backendNodeIdOf(session: CDPSession, objectId: unknown, deadlineAtMs: number): Promise<number> {
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
 * (a) `readInPage(input)` を isolated world で動かし（`readInPage` は `InPageElementsResult` を返す）、値と、要素の参照を返す（例外を投げない）。
 * 命令: 文脈を作る 2 つ → `Runtime.callFunctionOn`（結果を objectId で受ける）→ `Runtime.callFunctionOn`（値と位置を値で受ける）→ 要素ごとに
 * `Runtime.callFunctionOn`（要素を objectId で受ける）と `DOM.describeNode`。
 */
export async function readElementsInIsolatedWorld<Input>(
  page: Page,
  readInPage: (input: Input) => InPageElementsResult,
  input: Input,
  deadlineAtMs: number,
): Promise<IsolatedElementsOutcome> {
  return readWithDiscoveryCdpSession(page, deadlineAtMs, ISOLATED_ELEMENTS_FAILED, async (session) => {
    const executionContextId = await isolatedContextOf(session, deadlineAtMs);
    const read = await send(session, 'Runtime.callFunctionOn', {
      functionDeclaration: String(readInPage),
      executionContextId,
      arguments: [{ value: input }],
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
    const elements: IsolatedElementReference[] = [];
    for (let index = 0; index < paths.length; index += 1) {
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

/** 位置の要素を返す（ページの中で動く）。どれかの位置に要素がなければ、値を `false` にする。 */
const elementsAtPathsInPage = composeInPage((R: StandardReaders, input: { readonly paths: readonly (readonly number[])[] }): InPageElementsResult => {
  const elements: Element[] = [];
  for (let index = 0; index < input.paths.length; index += 1) {
    const element = R.elementAtPath(input.paths[index] ?? []);
    if (element === null) {
      return { value: false, elements: [] };
    }
    elements.push(element);
  }
  return { value: true, elements };
});

/**
 * 位置の要素の backendNodeId（位置の順。読めない・どれかの位置に要素がないときは null）。同じ位置の要素が、前に読んだ要素と同じかを確かめる
 * （DEF-114。ページの JS は読む間に走らない）。
 */
export async function backendNodeIdsAtPaths(
  page: Page,
  paths: readonly (readonly number[])[],
  deadlineAtMs: number,
): Promise<readonly number[] | null> {
  const outcome = await readElementsInIsolatedWorld(page, elementsAtPathsInPage, { paths }, deadlineAtMs);
  if (outcome.status !== 'READ' || outcome.value !== true || outcome.elements.length !== paths.length) {
    return null;
  }
  return Object.freeze(outcome.elements.map(({ backendNodeId }) => backendNodeId));
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

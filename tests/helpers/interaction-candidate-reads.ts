/**
 * Interaction の候補の読み取りのテストの補助（T32j-4 fix round 1）。候補の発見・解決・読み取りは isolated world で行う（製品の口
 * `InteractionCandidateReads`。既定は `ISOLATED_INTERACTION_CANDIDATE_READS`）ので、テストは次の形で準備する。テストの期待（何を確かめるか）は
 * 変えず、準備の形だけを新しい読み取りに合わせる。
 * - `readsFromEvaluateMocks`: 偽の page の `evaluate`（`DISCOVER` の結果）・`evaluateHandle`（`RESOLVE` の封筒）と、封筒の要素の偽の handle の
 *   `evaluate`（`INSPECT` の結果）を、製品の口の形に写す（偽の結果と、偽の関数が投げた例外を、そのまま製品に届ける）。
 * - `adaptFakePage`: 本物の page（`mainFrame` を持つ）でない偽の page に、上の写しを登録する（本物の page は既定の読み取りのまま）。
 * - `fakeCandidateReference`: 保持した要素の読み取り（`INSPECT`）の結果を差し込む、偽の参照。
 * - `candidateReferenceOf`: 本物の page の、CSS セレクタの要素の参照（CDP の `DOM.querySelector` と `DOM.describeNode`。light DOM だけ）。
 * - `evaluateInCandidateReadWorld`: 計測の仕掛けを、製品が読む isolated world（`ISOLATED_READ_WORLD_NAME`。同じ名前の world は同じ文脈になる）
 *   で動かす（main world の仕掛けは、isolated world の読み取りに効かない）。
 */
import type { ElementHandle, Page } from 'playwright';
import { ISOLATED_READ_WORLD_NAME } from '../../src/discovery/isolated-read.js';
import {
  interactionCandidateReadsOf,
  ISOLATED_INTERACTION_CANDIDATE_READS,
  withInteractionCandidateReads,
  type InteractionCandidateReads,
} from '../../src/interaction/discover-candidates.js';

/** 偽の page の、今までの差し込みの口（`evaluate` と `evaluateHandle`）。 */
interface EvaluateMocks {
  readonly evaluate?: (callback: unknown, argument?: unknown) => Promise<unknown>;
  readonly evaluateHandle?: (callback: unknown, argument?: unknown) => Promise<unknown>;
}

/** 偽の封筒の項目（`jsonValue`・`asElement`・`dispose`）。 */
interface EnvelopeProperty {
  readonly jsonValue?: () => Promise<unknown>;
  readonly asElement?: () => unknown;
  readonly dispose?: () => Promise<unknown>;
}

/** 偽の handle（`evaluate` で `INSPECT` の結果を返す）。 */
interface MockHandle {
  readonly evaluate: (callback: unknown, argument?: unknown) => Promise<unknown>;
}

const read = (value: unknown) => ({ status: 'READ' as const, value });

/**
 * 偽の page の差し込みを、製品の口の形に写す。偽の handle は、写しの中だけの番号（backendNodeId の代わり）で持つ。`fallback` があれば、偽の
 * page が持たない口（`evaluate` がない、`evaluateHandle` がない）は `fallback` に任せる。
 */
export function readsFromEvaluateMocks(fake: EvaluateMocks, fallback?: InteractionCandidateReads): InteractionCandidateReads {
  const handles = new Map<number, MockHandle>();
  let nextId = 1;
  const handleIdOf = (handle: MockHandle): number => {
    for (const [id, known] of handles) {
      if (known === handle) return id;
    }
    const id = nextId;
    nextId += 1;
    handles.set(id, handle);
    return id;
  };
  return {
    discover: async (page, input, deadlineAtMs) => {
      if (fake.evaluate === undefined) {
        if (fallback === undefined) throw new Error('The fake page has no evaluate');
        return fallback.discover(page, input, deadlineAtMs);
      }
      return read(await fake.evaluate(undefined, input));
    },
    resolve: async (page, input, deadlineAtMs) => {
      if (fake.evaluateHandle === undefined) {
        if (fallback === undefined) throw new Error('The fake page has no evaluateHandle');
        return fallback.resolve(page, input, deadlineAtMs);
      }
      const envelope = await fake.evaluateHandle(undefined, input) as {
        readonly getProperties: () => Promise<ReadonlyMap<string, EnvelopeProperty>>;
        readonly dispose?: () => Promise<unknown>;
      };
      try {
        const properties = await envelope.getProperties();
        const status = await properties.get('status')?.jsonValue?.();
        const domWorkUsed = await properties.get('domWorkUsed')?.jsonValue?.();
        const element = properties.get('element')?.asElement?.() as MockHandle | null | undefined;
        return {
          status: 'READ',
          value: { status, domWorkUsed },
          elements: element === null || element === undefined ? [] : [{ backendNodeId: handleIdOf(element), path: [] }],
        };
      } finally {
        await envelope.dispose?.();
      }
    },
    handleOf: async (page, reference, deadlineAtMs) => {
      const handle = handles.get(reference.backendNodeId);
      if (handle !== undefined) return handle as unknown as ElementHandle<Element>;
      return fallback === undefined ? null : fallback.handleOf(page, reference, deadlineAtMs);
    },
    inspect: async (page, backendNodeId, input, deadlineAtMs) => {
      const handle = handles.get(backendNodeId);
      if (handle === undefined) {
        if (fallback === undefined) throw new Error('Unknown fake handle');
        return fallback.inspect(page, backendNodeId, input, deadlineAtMs);
      }
      return read(await handle.evaluate(undefined, input));
    },
  };
}

/** 本物の page（Playwright の page か、それを包んだもの）か。偽の page は `mainFrame` を持たない。 */
export const isRealPage = (page: unknown): boolean =>
  typeof page === 'object' && page !== null && typeof (page as { readonly mainFrame?: unknown }).mainFrame === 'function';

/** 偽の page なら、今までの差し込みを製品の口に写して登録する（すでに差し替えた page と、本物の page は、そのまま）。 */
export function adaptFakePage<P extends object>(page: P): P {
  if (isRealPage(page) || interactionCandidateReadsOf(page as unknown as Page) !== ISOLATED_INTERACTION_CANDIDATE_READS) {
    return page;
  }
  return withInteractionCandidateReads(page, readsFromEvaluateMocks(page as EvaluateMocks));
}

/** 保持した要素の読み取り（`INSPECT`）の結果を、`inspect` で差し込む偽の参照（`inspectInteractionCandidateHandle` に渡す）。 */
export function fakeCandidateReference(inspect: (input: unknown) => unknown): { readonly page: Page; readonly backendNodeId: number } {
  const backendNodeId = 1;
  const page = withInteractionCandidateReads({}, {
    ...ISOLATED_INTERACTION_CANDIDATE_READS,
    inspect: async (_page, _id, input) => read(await inspect(input)),
  }) as unknown as Page;
  return { page, backendNodeId };
}

/** 本物の page の、CSS セレクタ（light DOM）の `index` 番目の要素の参照（CDP で読む。テストの準備だけに使う）。 */
export async function candidateReferenceOf(page: Page, selector: string, index = 0): Promise<{ readonly page: Page; readonly backendNodeId: number }> {
  const session = await page.context().newCDPSession(page);
  try {
    const { root } = await session.send('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await session.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
    const nodeId = nodeIds[index];
    if (nodeId === undefined) throw new Error(`No element for ${selector}`);
    const { node } = await session.send('DOM.describeNode', { nodeId });
    return { page, backendNodeId: node.backendNodeId };
  } finally {
    await session.detach();
  }
}

/**
 * `fn(arg)` を、製品が候補を読む isolated world（`ISOLATED_READ_WORLD_NAME`）で動かし、戻り値（値）を返す。計測の仕掛け（prototype の差し替え）
 * を、製品の読み取りが動く world に入れるために使う（同じ名前の isolated world は、同じ文脈になる）。
 */
export async function evaluateInCandidateReadWorld<Arg, Result>(
  page: Page,
  fn: (arg: Arg) => Result | Promise<Result>,
  arg?: Arg,
): Promise<Result> {
  const session = await page.context().newCDPSession(page);
  try {
    const { frameTree } = await session.send('Page.getFrameTree');
    const { executionContextId } = await session.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: ISOLATED_READ_WORLD_NAME });
    const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', {
      functionDeclaration: String(fn),
      executionContextId,
      arguments: arg === undefined ? [] : [{ value: arg }],
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails !== undefined) {
      throw new Error(`The read world function failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    }
    return result.value as Result;
  } finally {
    await session.detach();
  }
}

/** `page` の候補の読み取り（差し替えがなければ isolated world の読み取り）を、呼ばれた page によらず `page` で行う読み取り（包んだ page の準備に使う）。 */
export function readsOnPage(page: Page): InteractionCandidateReads {
  const reads = interactionCandidateReadsOf(page);
  return {
    discover: (_target, input, deadlineAtMs) => reads.discover(page, input, deadlineAtMs),
    resolve: (_target, input, deadlineAtMs) => reads.resolve(page, input, deadlineAtMs),
    handleOf: (_target, reference, deadlineAtMs) => reads.handleOf(page, reference, deadlineAtMs),
    inspect: (_target, backendNodeId, input, deadlineAtMs) => reads.inspect(page, backendNodeId, input, deadlineAtMs),
  };
}

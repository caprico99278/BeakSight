// 発見の JS の結び付き（Task 27 の設計書 4.2。T27b）。ブラウザの部品（`tests/architecture/discovery-boundary.test.ts` の
// `BROWSER_DISCOVERY_FILES`）。
// - CDP の `DOMDebugger.getEventListeners` で、form・送信ボタン・祖先・document・window の listener の種類を読む。ページを動かさない（事象を
//   起こさない。listener を呼ばない。DOM を変えない）。記録する種類は、閉じた一覧（`LISTENER_KINDS`）に当たるものだけ（重複なし、一覧の順）。
//   inline の処理（`onsubmit` などの属性）も、CDP では listener として見える。
// - CDP の session は、発見の session の共通の部品（`cdp-session.ts` の `readWithDiscoveryCdpSession`）で開き、読み終わったら（失敗しても）、
//   remote object の群を手放してから切る。送る命令は閉じた一覧（`DISCOVERY_LISTENER_CDP_COMMANDS`。読むだけの命令）だけ。
// - main world のままにする（DEF-087）: probe と構造の読み取りは isolated world で動く（`isolated-read.ts`）が、ここは main world の
//   remote object（`DOM.resolveNode` の既定の world と、`Runtime.evaluate` の `window`）の objectId で `DOMDebugger.getEventListeners` を呼ぶ。
//   `getEventListeners` は、objectId の world で登録された listener しか返さないため（ページの listener は main world にある。isolated world
//   の objectId では 0 件になる）。どの命令も CDP の側で読むだけで、ページの JS を呼ばない（`window` の式は、上書きできない global を読むだけ）
//   ので、ページの JS は結果を偽れず、読み取りの間に走らない。
// - 要素の探し方: `DOM.getDocument`（`depth: -1`、`pierce: true`）の木を、probe が読んだ要素の位置（`ProbedElement.path`。要素の子の中の番号と、
//   open な shadow root に入る印）でたどる。たどり着いた要素の名前が probe の名前と違えば（読み取りの間に DOM が変わった）、読み取りの失敗にする
//   （fail-closed。結び付きの分からない候補を出さない）。
// - 祖先: form（form の外のボタンは、その要素）の祖先と、送信ボタンの祖先（form の中の包みの要素を含む。form 自身は `form` に数えるので除く）。
//   html を含み、document を含まない。open な shadow root と、その host も含む（事象は shadow の境を越えて伝わるため）。
// - 同じ木で、closed な shadow root（`shadowRootType` が `closed`）と、別の文書を持つ要素（`contentDocument` か `frameId` を持つ要素）を探す。
//   あれば、その画面を `INCOMPLETE_FRAME_OR_CLOSED_SHADOW` にする（中は読まない）。ブラウザ自身の shadow root（`user-agent`）は数えない。
import type { CDPSession, Page } from 'playwright';
import { isRecord } from '../core/guards.js';
import { LISTENER_KINDS, type ListenerKind } from './candidate-contracts.js';
import { readWithDiscoveryCdpSession, sendDiscoveryCdpCommand } from './cdp-session.js';
import { SHADOW_ROOT_STEP, type ProbedElement } from './probe.js';

/** この部品が送る CDP の命令の閉じた一覧（読むだけの命令）。 */
export const DISCOVERY_LISTENER_CDP_COMMANDS = Object.freeze([
  'DOM.getDocument',
  'DOM.resolveNode',
  'DOMDebugger.getEventListeners',
  'Runtime.evaluate',
  'Runtime.releaseObjectGroup',
] as const);
type ListenerCdpCommand = (typeof DISCOVERY_LISTENER_CDP_COMMANDS)[number];

/** CDP の remote object の群の名前（読み終わったら群ごと手放す）。 */
const OBJECT_GROUP = 'beaksight-discovery-listeners';
/** `DOM.getDocument` の、木の全体を返す深さ。 */
const WHOLE_TREE_DEPTH = -1;
/** CDP の node の種類（要素）。 */
const ELEMENT_NODE_TYPE = 1;
/** 文書の根の要素の名前（CDP は、この要素にも `frameId` を付ける）。 */
const DOCUMENT_ROOT_ELEMENT_NAME = 'html';
/** CDP の shadow root の種類。 */
const OPEN_SHADOW_ROOT_TYPE = 'open';
const CLOSED_SHADOW_ROOT_TYPE = 'closed';
/** window の remote object を得る式（`window` は上書きできない）。 */
const WINDOW_EXPRESSION = 'window';
/** `getEventListeners` で、要素の子孫の listener を読まない深さ。 */
const OWN_LISTENERS_DEPTH = 0;

/** 1 つの候補の、結び付きを読む要素。 */
export interface ListenerReadTarget {
  readonly form: ProbedElement | null;
  readonly submitter: ProbedElement | null;
}

/** 1 つの候補の listener の種類。 */
export interface CandidateListenerKinds {
  readonly form: readonly ListenerKind[];
  readonly submitter: readonly ListenerKind[];
  readonly ancestor: readonly ListenerKind[];
}

/** 結び付きの読み取りの結果。`FAILED` は、読めなかった（命令の失敗、時間の上限、要素の不一致）。 */
export type ListenerReadOutcome =
  | {
    readonly status: 'READ';
    readonly document: readonly ListenerKind[];
    readonly window: readonly ListenerKind[];
    /** `targets` と同じ順。 */
    readonly candidates: readonly CandidateListenerKinds[];
    readonly closedShadowRootFound: boolean;
    readonly frameFound: boolean;
  }
  | { readonly status: 'FAILED' };

const LISTENERS_FAILED: ListenerReadOutcome = Object.freeze({ status: 'FAILED' });

/** 読み取りの失敗（命令の失敗、時間の上限、形の誤り、要素の不一致）。 */
class ListenerReadFailure extends Error {}

/** `DOM.getDocument` の node の、使う部分。 */
interface DomTreeNode {
  readonly backendNodeId: number;
  readonly nodeType: number;
  readonly localName: string;
  readonly children: readonly DomTreeNode[];
  readonly shadowRoots: readonly DomTreeNode[];
  readonly shadowRootType: string | null;
  readonly hasFrame: boolean;
}

const nodeOf = (value: unknown): DomTreeNode => {
  if (!isRecord(value) || typeof value['backendNodeId'] !== 'number' || typeof value['nodeType'] !== 'number') {
    throw new ListenerReadFailure();
  }
  const listOf = (items: unknown): readonly DomTreeNode[] => (Array.isArray(items) ? items.map(nodeOf) : []);
  return {
    backendNodeId: value['backendNodeId'],
    nodeType: value['nodeType'],
    localName: typeof value['localName'] === 'string' ? value['localName'] : '',
    children: listOf(value['children']),
    shadowRoots: listOf(value['shadowRoots']),
    shadowRootType: typeof value['shadowRootType'] === 'string' ? value['shadowRootType'] : null,
    // `frameId` は、frame の持ち主の要素（iframe など）のほかに、どの文書の根の要素（html）にも付くので、根の要素の分は数えない。
    hasFrame: value['contentDocument'] !== undefined
      || (value['frameId'] !== undefined && value['localName'] !== DOCUMENT_ROOT_ELEMENT_NAME),
  };
};

/** 木の中の、closed な shadow root と、別の文書を持つ要素を探す（根の document は数えない）。 */
const scanTree = (root: DomTreeNode): { readonly closedShadowRootFound: boolean; readonly frameFound: boolean } => {
  let closedShadowRootFound = false;
  let frameFound = false;
  const stack: DomTreeNode[] = [...root.children, ...root.shadowRoots];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.shadowRootType === CLOSED_SHADOW_ROOT_TYPE) {
      closedShadowRootFound = true;
    }
    if (node.hasFrame) {
      frameFound = true;
    }
    stack.push(...node.children, ...node.shadowRoots);
  }
  return { closedShadowRootFound, frameFound };
};

/** 要素の位置をたどり、途中の node（document を除き、最後の要素を含む）を返す。最後の要素の名前が違えば失敗。 */
const nodesAlong = (root: DomTreeNode, element: ProbedElement): readonly DomTreeNode[] => {
  const nodes: DomTreeNode[] = [];
  let current = root;
  for (const step of element.path) {
    let next: DomTreeNode | undefined;
    if (step === SHADOW_ROOT_STEP) {
      next = current.shadowRoots.find(({ shadowRootType }) => shadowRootType === OPEN_SHADOW_ROOT_TYPE);
    } else {
      next = current.children.filter(({ nodeType }) => nodeType === ELEMENT_NODE_TYPE)[step];
    }
    if (next === undefined) {
      throw new ListenerReadFailure();
    }
    nodes.push(next);
    current = next;
  }
  if (nodes.length === 0 || current.nodeType !== ELEMENT_NODE_TYPE || current.localName !== element.localName) {
    throw new ListenerReadFailure();
  }
  return nodes;
};

/** 閉じた一覧の種類だけを、一覧の順に、重複なく。 */
const kindsOf = (types: Iterable<string>): readonly ListenerKind[] => {
  const seen = new Set(types);
  return LISTENER_KINDS.filter((kind) => seen.has(kind));
};

/** 1 つの session での読み取り（命令は、すべて期限の中で送る）。 */
class ListenerReader {
  readonly #session: CDPSession;
  readonly #deadlineAtMs: number;
  readonly #kindsByNode = new Map<number, ReadonlySet<string>>();

  constructor(session: CDPSession, deadlineAtMs: number) {
    this.#session = session;
    this.#deadlineAtMs = deadlineAtMs;
  }

  send(method: ListenerCdpCommand, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    // 命令は閉じた一覧の名前だけ。引数の形は CDP の定義に任せ、結果は形を見てから使う（失敗は `DiscoveryCdpReadFailure`）。
    return sendDiscoveryCdpCommand(this.#session, method, params, this.#deadlineAtMs);
  }

  /** remote object の listener の種類（すべての種類。絞るのは呼ぶ側）。 */
  async typesOfObject(objectId: unknown): Promise<ReadonlySet<string>> {
    if (typeof objectId !== 'string') {
      throw new ListenerReadFailure();
    }
    const { listeners } = await this.send('DOMDebugger.getEventListeners', { objectId, depth: OWN_LISTENERS_DEPTH, pierce: false });
    if (!Array.isArray(listeners)) {
      throw new ListenerReadFailure();
    }
    return new Set(listeners.map((listener: unknown) => (isRecord(listener) && typeof listener['type'] === 'string' ? listener['type'] : '')));
  }

  /** node の listener の種類（同じ node は 1 回だけ読む）。 */
  async typesOfNode(node: DomTreeNode): Promise<ReadonlySet<string>> {
    const known = this.#kindsByNode.get(node.backendNodeId);
    if (known !== undefined) {
      return known;
    }
    const { object } = await this.send('DOM.resolveNode', { backendNodeId: node.backendNodeId, objectGroup: OBJECT_GROUP });
    const types = await this.typesOfObject(isRecord(object) ? object['objectId'] : undefined);
    this.#kindsByNode.set(node.backendNodeId, types);
    return types;
  }

  async typesOfNodes(nodes: readonly DomTreeNode[]): Promise<readonly ListenerKind[]> {
    const types: string[] = [];
    for (const node of nodes) {
      types.push(...await this.typesOfNode(node));
    }
    return kindsOf(types);
  }
}

/** 1 つの候補の listener の種類を読む。 */
const readCandidate = async (reader: ListenerReader, root: DomTreeNode, target: ListenerReadTarget): Promise<CandidateListenerKinds> => {
  const formNodes = target.form === null ? null : nodesAlong(root, target.form);
  const submitterNodes = target.submitter === null ? null : nodesAlong(root, target.submitter);
  const formNode = formNodes?.at(-1);
  const submitterNode = submitterNodes?.at(-1);
  const ancestors = new Map<number, DomTreeNode>();
  for (const nodes of [formNodes, submitterNodes]) {
    for (const node of nodes?.slice(0, -1) ?? []) {
      if (node.backendNodeId !== formNode?.backendNodeId) {
        ancestors.set(node.backendNodeId, node);
      }
    }
  }
  return {
    form: formNode === undefined ? [] : await reader.typesOfNodes([formNode]),
    submitter: submitterNode === undefined ? [] : await reader.typesOfNodes([submitterNode]),
    ancestor: await reader.typesOfNodes([...ancestors.values()]),
  };
};

/** session を切る前に、remote object の群を手放す（期限は、session の共通の部品が決める。失敗は、共通の部品が捨てる）。 */
const releaseObjectGroup = (session: CDPSession, releaseDeadlineAtMs: number): Promise<Record<string, unknown>> =>
  sendDiscoveryCdpCommand(session, 'Runtime.releaseObjectGroup' satisfies ListenerCdpCommand, { objectGroup: OBJECT_GROUP }, releaseDeadlineAtMs);

/**
 * 候補ごとの JS の結び付きと、document・window の listener を読む（例外を投げない）。`deadlineAtMs` までに読めなければ `FAILED`。
 * session は、読み終わったら（失敗しても）切る。
 */
export async function readCandidateListeners(
  page: Page,
  targets: readonly ListenerReadTarget[],
  deadlineAtMs: number,
): Promise<ListenerReadOutcome> {
  return readWithDiscoveryCdpSession(page, deadlineAtMs, LISTENERS_FAILED, async (session) => {
    const reader = new ListenerReader(session, deadlineAtMs);
    const { root: rawRoot } = await reader.send('DOM.getDocument', { depth: WHOLE_TREE_DEPTH, pierce: true });
    const root = nodeOf(rawRoot);
    const { closedShadowRootFound, frameFound } = scanTree(root);
    const candidates: CandidateListenerKinds[] = [];
    for (const target of targets) {
      candidates.push(await readCandidate(reader, root, target));
    }
    const documentKinds = kindsOf(await reader.typesOfNode(root));
    const { result: windowObject } = await reader.send('Runtime.evaluate', { expression: WINDOW_EXPRESSION, objectGroup: OBJECT_GROUP });
    const windowKinds = kindsOf(await reader.typesOfObject(isRecord(windowObject) ? windowObject['objectId'] : undefined));
    return Object.freeze({
      status: 'READ',
      document: documentKinds,
      window: windowKinds,
      candidates,
      closedShadowRootFound,
      frameFound,
    } satisfies ListenerReadOutcome);
  }, releaseObjectGroup);
}

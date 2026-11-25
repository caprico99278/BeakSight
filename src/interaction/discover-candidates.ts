import type { ElementHandle, Page } from 'playwright';
import { isNonNegativeSafeInteger, isRecord } from '../core/guards.js';
import { createSha256Fingerprint } from '../core/ids.js';
import { compareCodeUnits } from '../core/text.js';
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';
import {
  elementHandleOf,
  readElementInIsolatedWorld,
  readElementsInIsolatedWorld,
  readInIsolatedWorld,
  type InPageElementsResult,
  type IsolatedElementReference,
  type IsolatedElementsOutcome,
  type IsolatedReadOutcome,
} from '../discovery/isolated-read.js';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';
import { destructiveActionFactsFrom, isAiAction, isDestructiveAction, type DestructiveActionFacts } from '../discovery/destructive-action.js';
import { isHttpProtocol } from '../crawl/normalize-url.js';
import { CLASS_ATTRIBUTE_NAME } from '../evidence/interaction-collector.js';
import {
  freezeInteractionCandidate,
  INTERACTION_CANDIDATE_ID_PREFIX,
  type InteractionBoundingBox,
  type InteractionCandidate,
  type InteractionHrefKind,
} from '../safety/interaction-policy.js';

export const INTERACTION_CANDIDATE_SELECTOR = [
  'button',
  '[role="button"]',
  '[role="tab"]',
  '[aria-expanded]',
  '[aria-controls]',
  'details > summary',
].join(',');

/**
 * Interaction の候補の要素の参照（T32j-4。Task 32 の設計書 4.4 の「CC-068 の設計」の 2。調査 T32j-3 の Ri・Ii・Bx）。読み取りは、isolated world
 * で `backendNodeId` の要素を解決して行う（ページの JS は結果を偽れず、読む間に走らない）。操作（scroll、hover、click）は `handle`
 * （要素の橋渡しの部品 `elementHandleOf` で得た、同じ要素の ElementHandle）で行う。使い終わったら `handle` を手放す。
 */
export interface InteractionCandidateReference {
  readonly page: Page;
  readonly backendNodeId: number;
  readonly handle: ElementHandle<Element>;
}

/**
 * 候補の読み取り（発見・解決・保持した要素の読み取り）の、isolated world の CDP の命令の期限（ms。呼ぶ側が期限を渡さないとき）。呼ぶ側の
 * 期限（Interaction の作業の期限、collector の期限）は、今までどおり外側で効く。
 */
export const INTERACTION_CANDIDATE_READ_TIMEOUT_MS = 10_000;

/**
 * 候補の読み取りの口（T32j-4 fix round 1。依存の注入）。発見（`DISCOVER`）・解決（`RESOLVE`）と操作の handle の取り直し・保持した要素の読み取り
 * （`INSPECT`）の 3 つを、この 1 か所で受け持つ。既定（`ISOLATED_INTERACTION_CANDIDATE_READS`）は、isolated world の読み取り（要素の橋渡しの
 * 部品 `src/discovery/isolated-read.ts`）。本番の呼び出し側（`isolated-auditor.ts`、`page-auditor.ts`）は既定のまま使い、page ごとに差し替える
 * `withInteractionCandidateReads` はテストだけが使う（Gate `discovery-boundary` の (e3)）。差し替えた読み取りが投げた例外は、そのまま呼ぶ側に
 * 届く（今までの evaluate の例外と同じ扱い）。
 */
export interface InteractionCandidateReads {
  /** 発見（`DISCOVER` の入力。値は関数の戻り値）。 */
  readonly discover: (page: Page, input: PageInteractionProbeInput, deadlineAtMs: number) => Promise<IsolatedReadOutcome>;
  /** 解決（`RESOLVE` の入力。値は `{ status, domWorkUsed }`、要素は見つかった要素の参照 1 つか 0）。 */
  readonly resolve: (page: Page, input: PageInteractionProbeInput, deadlineAtMs: number) => Promise<IsolatedElementsOutcome>;
  /** 解決した要素の、操作に使う handle（同じ要素を指すと確かめられなければ null）。 */
  readonly handleOf: (page: Page, reference: IsolatedElementReference, deadlineAtMs: number) => Promise<ElementHandle<Element> | null>;
  /** 保持した要素の読み取り（`INSPECT` の入力。値は関数の戻り値）。 */
  readonly inspect: (page: Page, backendNodeId: number, input: HandleInteractionProbeInput, deadlineAtMs: number) => Promise<IsolatedReadOutcome>;
}

/** 既定の読み取り（isolated world。ページの JS は結果を偽れず、読む間に走らない）。 */
export const ISOLATED_INTERACTION_CANDIDATE_READS: InteractionCandidateReads = Object.freeze({
  discover: (page: Page, input: PageInteractionProbeInput, deadlineAtMs: number) =>
    readInIsolatedWorld(page, pageInteractionCandidateProbe, input, deadlineAtMs),
  resolve: (page: Page, input: PageInteractionProbeInput, deadlineAtMs: number) =>
    readElementsInIsolatedWorld(page, resolveInteractionCandidateProbe, input, deadlineAtMs),
  handleOf: (page: Page, reference: IsolatedElementReference, deadlineAtMs: number) => elementHandleOf(page, reference, deadlineAtMs),
  inspect: (page: Page, backendNodeId: number, input: HandleInteractionProbeInput, deadlineAtMs: number) =>
    readElementInIsolatedWorld(page, backendNodeId, handleInteractionCandidateProbe, input, deadlineAtMs),
});

/** page ごとに差し替えた読み取り（テストだけが登録する。本番の page は登録しない）。 */
const injectedCandidateReads = new WeakMap<object, InteractionCandidateReads>();

/** テストのための差し替え: `page` の候補の読み取りを `reads` にする（`page` を返す）。本番のコードからは呼ばない（Gate `discovery-boundary` の (e3)）。 */
export function withInteractionCandidateReads<P extends object>(page: P, reads: InteractionCandidateReads): P {
  injectedCandidateReads.set(page, reads);
  return page;
}

/** `page` の候補の読み取り（差し替えがなければ既定の isolated world の読み取り）。 */
export const interactionCandidateReadsOf = (page: Page): InteractionCandidateReads =>
  injectedCandidateReads.get(page) ?? ISOLATED_INTERACTION_CANDIDATE_READS;

export type InteractionHandleResolution =
  | { readonly status: 'FOUND'; readonly reference: InteractionCandidateReference; readonly domWorkUsed: number }
  | { readonly status: 'MISSING'; readonly domWorkUsed: number }
  | { readonly status: 'DOM_WORK_BUDGET_REACHED'; readonly domWorkUsed: number };

/**
 * 探索がどこまで完全か。`TEXT_NODE_LIMIT_REACHED` は、テキストのノード上限（`maxTextNodes`）で走査を止めたことを表し、
 * DOM作業量の上限（`DOM_WORK_BUDGET_REACHED`）とは区別する（設計書 2026-09-23 4.5）。
 */
export type InteractionCandidateDiscoveryCompleteness =
  | 'COMPLETE'
  | 'CANDIDATE_LIMIT_REACHED'
  | 'DOM_WORK_BUDGET_REACHED'
  | 'TEXT_NODE_LIMIT_REACHED';

const DISCOVERY_COMPLETENESS_VALUES: readonly InteractionCandidateDiscoveryCompleteness[] = Object.freeze([
  'COMPLETE',
  'CANDIDATE_LIMIT_REACHED',
  'DOM_WORK_BUDGET_REACHED',
  'TEXT_NODE_LIMIT_REACHED',
]);

export interface InteractionCandidateDiscoveryResult {
  readonly candidates: readonly InteractionCandidate[];
  readonly completeness: InteractionCandidateDiscoveryCompleteness;
  readonly domWorkUsed: number;
}

/**
 * DOM の作業量の上限（任意の入力）。L10（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4。INV-LIMITS の N3・N4）: 本番は渡さない（数えるだけで、止めない）。
 * テストが小さな値を注入するときだけ、その値で止める。渡すなら 0 以上の安全な整数。
 */
function validatedDomWorkLimit(value: number | undefined): number | undefined {
  if (value !== undefined && !isNonNegativeSafeInteger(value)) {
    throw new Error('Interaction DOM work limit is outside the bounded contract');
  }
  return value;
}

function isDiscoveryCompleteness(value: unknown): value is InteractionCandidateDiscoveryCompleteness {
  return (DISCOVERY_COMPLETENESS_VALUES as readonly unknown[]).includes(value);
}

function validDomWorkCount(value: unknown, maxDomWork: number | undefined): value is number {
  return isNonNegativeSafeInteger(value) && (maxDomWork === undefined || value <= maxDomWork);
}

/**
 * ブラウザの中の処理に渡す上限。L10（INV-LIMITS の N3・N4）: 候補の数・順番・テキストのノード・長さの上限は撤廃した（渡さない）。DOM の作業量の上限は、任意の
 * 入力（`undefined` は数えるだけで止めない。テストが注入するときだけ渡す）。
 */
type InteractionProbeLimits = { readonly maxDomWork?: number | undefined };

/**
 * ブラウザの中の処理（`interactionCandidateProbe`）に渡す入力。`mode` で、何をするかを選ぶ（CC-008）。
 * - `DISCOVER`: 文書の先頭から候補を探し、候補の一覧を返す（`discoverInteractionCandidates`）。
 * - `RESOLVE`: 文書の先頭から数えて `targetOrdinal` 番目の候補の要素を返す（`resolveInteractionCandidateHandle`）。
 * - `INSPECT`: 保持した要素の、今の候補の値と、属性・開閉の記録を返す（`inspectInteractionCandidateHandle`）。
 */
type InteractionProbeInput =
  | {
      readonly mode: 'DISCOVER';
      readonly selector: string;
      readonly limits: InteractionProbeLimits;
      readonly visibilityOptions: CheckVisibilityOptions;
    }
  | {
      readonly mode: 'RESOLVE';
      readonly selector: string;
      readonly limits: InteractionProbeLimits;
      readonly targetOrdinal: number;
    }
  | {
      readonly mode: 'INSPECT';
      readonly selector: string;
      readonly limits: InteractionProbeLimits;
      readonly visibilityOptions: CheckVisibilityOptions;
      readonly classAttributeName: string;
    };

/**
 * Interaction の候補を扱う、ブラウザの中の唯一の処理（CC-008）。作業量のカウンタ、要素の走査、テキストの切り詰め、可視判定、
 * アクセシブルネーム、候補の組み立てを、探索・handle の解決・保持した handle の読み取りで共有する。
 * `page.evaluate` などに関数の本体の文字列として渡るので、この関数の外の値（定数・関数）を参照してはいけない。必要な値は入力で渡す。
 * T32j-4: isolated world で動く。`DISCOVER` は `readInIsolatedWorld` で（入力）、`RESOLVE` は `readElementsInIsolatedWorld` で（入力）、`INSPECT` は
 * `readElementInIsolatedWorld` で（保持した要素, 入力）で呼ぶ（`src/discovery/isolated-read.ts`）。部品（`R`）は `composeInPage` で組み込む
 * （`src/browser/in-page-readers.ts`。CC-068。渡すのは `pageInteractionCandidateProbe`・`resolveInteractionCandidateProbe`・
 * `handleInteractionCandidateProbe`）。
 */
const interactionCandidateProbe = (
  R: StandardReaders,
  retainedOrInput: Element | InteractionProbeInput,
  handleInput?: InteractionProbeInput,
) => {
  const input = handleInput ?? (retainedOrInput as InteractionProbeInput);
  const { selector, limits } = input;
  // DOM clobbering（DEF-069）: form の中の名前つきの入力の欄は、form の同じ名前のプロパティとメソッドを隠す（`<input name="method">` で
  // `form.method` が入力の欄になる）。form になりうる要素（走査するすべての要素、候補、制御される要素、祖先、関連する form）の標準のプロパティと
  // メソッドは、標準の prototype の getter とメソッドで読む（`src/browser/login-form-submitter.ts` の `readLoginFormFactsInPage` と同じ読み方）。
  // ボタンと入力の欄（`formControl`）、details は、名前つきの子でプロパティが隠れないので、そのまま読む。
  // getter は部品の `standardGetter`（`src/browser/in-page-readers.ts`。CC-068。`dom-collector.ts` の `collectDomEvidence` も同じ部品を使う）。
  const { standardGetter } = R;
  const nodeTypeOf = standardGetter<number>(Node.prototype, 'nodeType');
  const isConnectedOf = standardGetter<boolean>(Node.prototype, 'isConnected');
  const parentElementOf = standardGetter<HTMLElement | null>(Node.prototype, 'parentElement');
  const tagNameOf = standardGetter<string>(Element.prototype, 'tagName');
  const attributesOf = standardGetter<NamedNodeMap>(Element.prototype, 'attributes');
  const formMethodOf = standardGetter<string>(HTMLFormElement.prototype, 'method');
  const formActionOf = standardGetter<string>(HTMLFormElement.prototype, 'action');
  const getAttributeOf = (element: Element, name: string): string | null => Element.prototype.getAttribute.call(element, name);
  const hasAttributeOf = (element: Element, name: string): boolean => Element.prototype.hasAttribute.call(element, name);
  const matchesOf = (element: Element, selectors: string): boolean => Element.prototype.matches.call(element, selectors);
  const checkVisibilityOf = (element: Element, options: CheckVisibilityOptions): boolean => (
    Element.prototype.checkVisibility.call(element, options)
  );
  const boundingClientRectOf = (element: Element): DOMRect => Element.prototype.getBoundingClientRect.call(element);
  // DOM clobbering（DEF-073）: 名前つきの img・form など（`<img name="createTreeWalker">` など）は、`document` の同じ名前のプロパティと
  // メソッドを隠す。`document` の標準のプロパティとメソッドも、`Document.prototype` の getter とメソッドで読む。
  const documentElementOf = standardGetter<HTMLElement>(Document.prototype, 'documentElement');
  const createTreeWalker = (root: Node, whatToShow: number): TreeWalker => (
    Document.prototype.createTreeWalker.call(document, root, whatToShow)
  );
  const elementById = (id: string): HTMLElement | null => Document.prototype.getElementById.call(document, id);
  // L10（INV-LIMITS の N3・N4）: DOM の作業量は数えるだけで、上限（任意の入力 `maxDomWork`）を渡されたときだけ止める。
  const { maxDomWork } = limits;
  const budgetReached = (): boolean => maxDomWork !== undefined && domWork.used >= maxDomWork;
  const domWork = {
    used: 0,
    consume(): boolean {
      if (budgetReached()) {
        return false;
      }
      this.used += 1;
      return true;
    },
  };
  // L10: テキストのノードの数の上限（前は 512）は撤廃した（数えるだけ。`limitReached` は立たない）。
  const textWork = { used: 0, limitReached: false };
  // 走査は、最初の要素を求めたときに始める（INSPECT は、保持した要素が文書にあることを確かめてから走査する）。
  let walker: TreeWalker | null = null;
  const nextElement = (): Element | null => {
    if (walker === null) {
      const documentElement = documentElementOf(document);
      walker = createTreeWalker(documentElement, NodeFilter.SHOW_ELEMENT);
      return documentElement;
    }
    return walker.nextNode() as Element | null;
  };
  // 文書の順に、次の候補の要素を返す。要素1つを調べるのに作業量1、候補に当たったらさらに作業量1を消費する。
  const nextCandidateElement = (): Element | 'END' | 'DOM_WORK_BUDGET_REACHED' => {
    while (true) {
      if (budgetReached()) {
        return 'DOM_WORK_BUDGET_REACHED';
      }
      const element = nextElement();
      if (element === null) return 'END';
      if (!domWork.consume()) return 'DOM_WORK_BUDGET_REACHED';
      if (!matchesOf(element, selector)) continue;
      if (!domWork.consume()) return 'DOM_WORK_BUDGET_REACHED';
      return element;
    }
  };

  if (input.mode === 'RESOLVE') {
    let candidateOrdinal = 0;
    while (true) {
      const element = nextCandidateElement();
      // 要素の参照は、要素の橋渡しの部品の形（`{ value, elements }`）で返す（T32j-4）。
      if (element === 'DOM_WORK_BUDGET_REACHED') {
        return { value: { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used }, elements: [] };
      }
      if (element === 'END') {
        return { value: { status: 'MISSING' as const, domWorkUsed: domWork.used }, elements: [] };
      }
      if (candidateOrdinal === input.targetOrdinal) {
        return { value: { status: 'FOUND' as const, domWorkUsed: domWork.used }, elements: [element] };
      }
      candidateOrdinal += 1;
    }
  }

  const { visibilityOptions } = input;
  // L10（INV-LIMITS の N3・N4）: テキストと属性の長さの上限（前はテキスト 256・属性 512・URL 2,048 で切り詰めた）は撤廃した。値は切り詰めない。
  const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();
  const descendantText = (roots: readonly Element[]): string | null => {
    let result = '';
    for (const root of roots) {
      if (budgetReached()) {
        return null;
      }
      const textWalker = createTreeWalker(root, NodeFilter.SHOW_ALL);
      while (true) {
        if (budgetReached()) {
          return null;
        }
        const node = textWalker.nextNode();
        if (node === null) break;
        if (!domWork.consume()) return null;
        textWork.used += 1;
        if (nodeTypeOf(node) !== Node.TEXT_NODE) continue;
        result += (node as Text).data;
      }
      if (result.length > 0) result += ' ';
    }
    return result;
  };
  // 可視判定は標準の checkVisibility に共通のオプションで任せる（設計書 2026-09-23 5.5）。
  // 祖先をたどらないので、呼び出し1回につき作業量1を消費する。大きさが0の要素は、見えないものとして扱う。
  const visibility = (subject: Element): boolean | null => {
    if (!domWork.consume()) return null;
    if (!checkVisibilityOf(subject, visibilityOptions)) return false;
    if (budgetReached()) {
      return null;
    }
    const rect = boundingClientRectOf(subject);
    return rect.width > 0 && rect.height > 0;
  };
  const accessibleName = (subject: Element): string | null => {
    const ariaLabel = getAttributeOf(subject, 'aria-label');
    if (ariaLabel !== null) return normalize(ariaLabel);
    const labelledBy = getAttributeOf(subject, 'aria-labelledby');
    if (labelledBy !== null) {
      const labelRoots: Element[] = [];
      // L10（INV-LIMITS の N3・N4）: 参照する ID の数の上限（前は 16 個）は撤廃した。
      for (const id of labelledBy.split(/\s+/u)) {
        if (!domWork.consume()) return null;
        const labelRoot = elementById(id);
        if (labelRoot !== null) labelRoots.push(labelRoot);
      }
      const labels = descendantText(labelRoots);
      if (labels === null) return null;
      const normalized = normalize(labels);
      if (normalized.length > 0) return normalized;
    }
    const title = getAttributeOf(subject, 'title');
    if (title !== null) return normalize(title);
    const text = descendantText([subject]);
    return text === null ? null : normalize(text);
  };
  // 候補を組み立てられなかった（null）ときの理由。テキストのノードの上限に達したかで分ける（設計書 2026-09-23 4.5）。
  const incompleteStatus = (): 'TEXT_NODE_LIMIT_REACHED' | 'DOM_WORK_BUDGET_REACHED' => (
    textWork.limitReached ? 'TEXT_NODE_LIMIT_REACHED' : 'DOM_WORK_BUDGET_REACHED'
  );
  // 候補の値を組み立てる。作業量かテキストのノードの上限に達したら null を返す（理由は incompleteStatus で分かる）。
  const collectCandidate = (element: Element, ordinal: number): RawInteractionCandidate | null => {
    const htmlElement = element instanceof HTMLElement ? element : null;
    const formControl = element instanceof HTMLButtonElement || element instanceof HTMLInputElement
      ? element
      : null;
    const form = formControl?.form ?? null;
    // 候補の要素の属性を、標準のメソッドで読む（候補が form の場合に、名前つきの子に隠されない）。
    const getAttribute = (name: string): string | null => getAttributeOf(element, name);
    const ariaControls = getAttribute('aria-controls');
    let controlled: Element | null = null;
    if (ariaControls !== null) {
      if (!domWork.consume()) return null;
      controlled = elementById(ariaControls);
    }
    const controlledVisible = controlled === null ? null : visibility(controlled);
    if (controlledVisible === null && controlled !== null) return null;
    if (budgetReached()) {
      return null;
    }
    const name = accessibleName(element);
    if (name === null) return null;
    if (budgetReached()) {
      return null;
    }
    const text = descendantText([element]);
    if (text === null) return null;
    if (budgetReached()) {
      return null;
    }
    const visible = visibility(element);
    if (visible === null) return null;
    if (budgetReached()) {
      return null;
    }
    const rect = boundingClientRectOf(element);
    const pageOffsetX = window.scrollX;
    const pageOffsetY = window.scrollY;
    return {
      ordinal,
      tagName: tagNameOf(element).toLowerCase(),
      role: getAttribute('role'),
      accessibleName: name,
      normalizedText: normalize(text),
      ariaExpanded: getAttribute('aria-expanded'),
      ariaControls,
      ariaSelected: getAttribute('aria-selected'),
      controlledVisible,
      controlledHidden: controlled === null ? null : !controlledVisible,
      formAssociated: form !== null,
      formMethod: form === null ? null : formMethodOf(form),
      formAction: form === null ? null : formActionOf(form),
      rawHref: getAttribute('href'),
      documentUrl: location.href,
      documentOrigin: location.origin,
      download: hasAttributeOf(element, 'download'),
      type: formControl?.type ?? (htmlElement === null ? null : getAttribute('type')),
      disabled: (formControl?.disabled ?? false) || getAttribute('aria-disabled') === 'true',
      visible,
      // SD-1（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.3）: 操作の前の判定の事実（判定は Node の側の `isDestructiveAction`）。
      destructiveFacts: R.destructiveActionFactsOf(element),
      boundingBox: {
        x: rect.x + pageOffsetX,
        y: rect.y + pageOffsetY,
        width: rect.width,
        height: rect.height,
        top: rect.top + pageOffsetY,
        right: rect.right + pageOffsetX,
        bottom: rect.bottom + pageOffsetY,
        left: rect.left + pageOffsetX,
      },
    };
  };

  if (input.mode === 'DISCOVER') {
    const selected: RawInteractionCandidate[] = [];
    let completeness: InteractionCandidateDiscoveryCompleteness = 'COMPLETE';
    // L10（INV-LIMITS の N3・N4）: 候補の数の上限（前は 100。`CANDIDATE_LIMIT_REACHED`）は撤廃した。文書の終わりまで探す。
    while (true) {
      const element = nextCandidateElement();
      if (element === 'END') break;
      if (element === 'DOM_WORK_BUDGET_REACHED') {
        completeness = 'DOM_WORK_BUDGET_REACHED';
        break;
      }
      const candidate = collectCandidate(element, selected.length);
      if (candidate === null) {
        completeness = incompleteStatus();
        break;
      }
      selected.push(candidate);
    }
    return { candidates: selected, completeness, domWorkUsed: domWork.used };
  }

  // INSPECT: 保持した要素が、今の文書で何番目の候補かを数えてから、その要素の値を読む。
  const element = retainedOrInput as Element;
  if (!isConnectedOf(element)) return { status: 'DISCONNECTED' as const, domWorkUsed: domWork.used };
  let liveOrdinal = 0;
  let found = false;
  while (true) {
    const candidate = nextCandidateElement();
    if (candidate === 'DOM_WORK_BUDGET_REACHED') {
      return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
    }
    if (candidate === 'END') break;
    if (candidate === element) {
      found = true;
      break;
    }
    liveOrdinal += 1;
  }
  if (!found) {
    return { status: 'DISCONNECTED' as const, domWorkUsed: domWork.used };
  }
  // L10（INV-LIMITS の N3・N4）: 順番の上限（前は 99。`CANDIDATE_LIMIT_REACHED`）は撤廃した。
  if (!domWork.consume()) {
    return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
  }
  const raw = collectCandidate(element, liveOrdinal);
  // L10: テキストのノードの上限は撤廃したので、候補を組み立てられないのは DOM の作業量の上限（注入したときだけ）に達した場合だけ。
  if (raw === null) return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
  // 対象の要素そのものの属性（名前と値）を記録する（設計書 2026-09-23 4.4.1）。子孫の属性は含めない。
  // 属性1つにつき作業量1を消費し、上限に達したら、比べられない記録（complete: false）にする。
  // L10（INV-LIMITS の N3・N4）: 値の長さの上限（前は class 4,096、ほかの属性 512。F20b）は撤廃した。名前と値を切り詰めずに記録する。
  const attributeEntries: string[] = [];
  let attributesComplete = true;
  const ownAttributes = attributesOf(element);
  for (let index = 0; index < ownAttributes.length; index += 1) {
    if (!domWork.consume()) {
      attributesComplete = false;
      break;
    }
    const attribute = ownAttributes[index];
    if (attribute === undefined) break;
    attributeEntries.push(attribute.name, attribute.value);
  }
  // 対象が details の子の summary なら、親の details の開閉の状態を記録する（設計書 2026-09-23 4.4.1）。
  const parentDetails = parentElementOf(element);
  const detailsOpen = tagNameOf(element) === 'SUMMARY' && parentDetails instanceof HTMLDetailsElement
    ? parentDetails.open
    : null;
  return {
    status: 'CONNECTED' as const,
    domWorkUsed: domWork.used,
    detailsOpen,
    attributes: { complete: attributesComplete, entries: attributesComplete ? attributeEntries : [] },
    raw,
  };
};

/**
 * 要素を渡さずに動かすときの入力（`DISCOVER` と `RESOLVE` だけ）。保持した要素がないので、`INSPECT` を受け取ると
 * 例外にならずに誤った結果を返す。そのため、型で受け取れなくする（RC18 の M3）。
 */
export type PageInteractionProbeInput = Extract<InteractionProbeInput, { readonly mode: 'DISCOVER' | 'RESOLVE' }>;
/** 保持した要素で動かすときの入力（`INSPECT` だけ）。 */
export type HandleInteractionProbeInput = Extract<InteractionProbeInput, { readonly mode: 'INSPECT' }>;

/** `interactionCandidateProbe` に部品を組み込んだ、ページの中で動く関数（モジュールの読み込みのときに 1 回だけ組み立てる）。 */
const composedInteractionCandidateProbe = composeInPage(interactionCandidateProbe);
/** `readInIsolatedWorld` に渡す形（`DISCOVER` の入力だけを受け取る）。関数そのものは `composedInteractionCandidateProbe` と同じ。 */
const pageInteractionCandidateProbe = composedInteractionCandidateProbe as (input: PageInteractionProbeInput) => unknown;
/** `readElementsInIsolatedWorld` に渡す形（`RESOLVE` の入力だけを受け取り、要素の参照を返す）。関数そのものは `composedInteractionCandidateProbe` と同じ。 */
const resolveInteractionCandidateProbe = composedInteractionCandidateProbe as unknown as (input: PageInteractionProbeInput) => InPageElementsResult;
/** `readElementInIsolatedWorld` に渡す形（保持した要素と入力を受け取る）。関数そのものは `composedInteractionCandidateProbe` と同じ。 */
const handleInteractionCandidateProbe = composedInteractionCandidateProbe as (element: Element, input: HandleInteractionProbeInput) => unknown;

/** L10: ページの中の処理に渡す上限（DOM の作業量の上限を渡されたときだけ入れる。ほかの上限は渡さない）。 */
const probeLimitsOf = (maxDomWork: number | undefined): InteractionProbeLimits =>
  (maxDomWork === undefined ? {} : { maxDomWork });

/**
 * 文書の先頭から `ordinal` 番目の候補の要素を解決する。L10（INV-LIMITS の N3・N4）: 順番の上限（前は 99）は撤廃した。`maxDomWork` は任意の入力（省略は数えるだけで
 * 止めない。テストが小さな値を注入するときだけ渡す）。
 */
export async function resolveInteractionCandidateHandle(
  page: Page,
  ordinal: number,
  maxDomWork: number | undefined = undefined,
  deadlineAtMs: number = Date.now() + INTERACTION_CANDIDATE_READ_TIMEOUT_MS,
): Promise<InteractionHandleResolution> {
  if (!isNonNegativeSafeInteger(ordinal)) {
    throw new Error('Interaction candidate ordinal is outside the bounded contract');
  }
  const boundedMaxDomWork = validatedDomWorkLimit(maxDomWork);
  if (boundedMaxDomWork === 0) {
    return Object.freeze({ status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 0 });
  }
  // T32j-4: isolated world で探し、要素は backendNodeId と位置で受け取る（ページの JS は偽れない）。操作に使う handle は、位置の Locator
  // （自前の selector engine）で得て、同じ backendNodeId を指すことを確かめ直す（`elementHandleOf`）。読めない・確かめられないときは、今の evaluate の失敗と
  // 同じく例外にする。
  const reads = interactionCandidateReadsOf(page);
  const outcome = await reads.resolve(page, {
    mode: 'RESOLVE',
    selector: INTERACTION_CANDIDATE_SELECTOR,
    limits: probeLimitsOf(boundedMaxDomWork),
    targetOrdinal: ordinal,
  }, deadlineAtMs);
  if (outcome.status !== 'READ') {
    throw new Error('Interaction candidate isolated read failed');
  }
  const { value, elements } = outcome;
  const status = isRecord(value) ? value['status'] : undefined;
  const domWorkUsed = isRecord(value) ? value['domWorkUsed'] : undefined;
  if ((status !== 'FOUND' && status !== 'MISSING' && status !== 'DOM_WORK_BUDGET_REACHED')
    || !validDomWorkCount(domWorkUsed, boundedMaxDomWork)
    || elements.length !== (status === 'FOUND' ? 1 : 0)) {
    throw new Error('Invalid bounded interaction handle resolution envelope');
  }
  if (status !== 'FOUND') {
    return Object.freeze({ status, domWorkUsed });
  }
  const element = elements[0];
  if (element === undefined) {
    throw new Error('Invalid bounded interaction handle resolution envelope');
  }
  const handle = await reads.handleOf(page, element, deadlineAtMs);
  if (handle === null) {
    throw new Error('Interaction candidate handle is unavailable');
  }
  const reference: InteractionCandidateReference = Object.freeze({ page, backendNodeId: element.backendNodeId, handle });
  return Object.freeze({ status: 'FOUND', reference, domWorkUsed });
}

interface RawInteractionCandidate {
  readonly ordinal: number;
  readonly tagName: string;
  readonly role: string | null;
  readonly accessibleName: string;
  readonly normalizedText: string;
  readonly ariaExpanded: string | null;
  readonly ariaControls: string | null;
  readonly ariaSelected: string | null;
  readonly controlledVisible: boolean | null;
  readonly controlledHidden: boolean | null;
  readonly formAssociated: boolean;
  readonly formMethod: string | null;
  readonly formAction: string | null;
  readonly rawHref: string | null;
  readonly documentUrl: string;
  readonly documentOrigin: string;
  readonly download: boolean;
  readonly type: string | null;
  readonly disabled: boolean;
  readonly visible: boolean;
  /** SD-1: 操作の前の判定の事実（ページの中の部品 `destructiveActionFactsOf` が読む）。 */
  readonly destructiveFacts: DestructiveActionFacts;
  /** ページ座標（ビューポート座標にスクロール量を足したもの）。スクロールだけによる位置の変化を、変化とみなさない。 */
  readonly boundingBox: InteractionBoundingBox;
}

const BOUNDING_BOX_FIELDS = Object.freeze(['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'] as const);

function booleanField(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid browser interaction boolean: ${name}`);
  }
  return value;
}

function nullableBooleanField(value: unknown, name: string): boolean | null {
  return value === null ? null : booleanField(value, name);
}

function ordinalField(value: unknown, name: string): number {
  if (!isNonNegativeSafeInteger(value)) {
    throw new Error(`Invalid browser interaction ordinal: ${name}`);
  }
  return value;
}

function boundingBoxField(value: unknown, name: string): InteractionBoundingBox {
  if (!isRecord(value)) {
    throw new Error(`Invalid browser interaction bounding box: ${name}`);
  }
  const box: Record<(typeof BOUNDING_BOX_FIELDS)[number], number> = {
    x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0,
  };
  for (const field of BOUNDING_BOX_FIELDS) {
    const coordinate = value[field];
    if (typeof coordinate !== 'number' || !Number.isFinite(coordinate)) {
      throw new Error(`Invalid browser interaction bounding box: ${name}`);
    }
    box[field] = coordinate;
  }
  return box;
}

/** ブラウザから受け取った文字列（L10（INV-LIMITS の N3・N4）: 長さの上限は撤廃した。切り詰めない）。 */
function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid browser interaction string: ${name}`);
  }
  return value;
}

function nullableStringField(value: unknown, name: string): string | null {
  return value === null ? null : stringField(value, name);
}

/** SD-1: ブラウザから受け取った操作の前の判定の事実（形が違えば拒否する）。 */
function destructiveFactsField(value: unknown, name: string): DestructiveActionFacts {
  const facts = destructiveActionFactsFrom(value);
  if (facts === null) {
    throw new Error(`Invalid browser interaction destructive facts: ${name}`);
  }
  return facts;
}

/** L10: URL の長さの上限（前は 2,048。超えたら `MALFORMED` にして切り詰めた）は撤廃した。 */
function classifyHref(rawHref: unknown, documentUrlInput: unknown, documentOriginInput: unknown): {
  readonly href: string | null;
  readonly hrefKind: InteractionHrefKind;
} {
  if (rawHref === null) {
    return { href: null, hrefKind: 'NONE' };
  }
  if (typeof rawHref !== 'string') {
    return { href: '', hrefKind: 'MALFORMED' };
  }
  if (typeof documentUrlInput !== 'string' || typeof documentOriginInput !== 'string') {
    return { href: rawHref, hrefKind: 'MALFORMED' };
  }
  const documentUrl = documentUrlInput;
  const documentOrigin = documentOriginInput;
  let url: URL;
  try {
    url = new URL(rawHref, documentUrl);
  } catch {
    return { href: rawHref, hrefKind: 'MALFORMED' };
  }
  if (!isHttpProtocol(url.protocol.toLowerCase())) {
    return { href: url.href, hrefKind: 'SPECIAL_SCHEME' };
  }
  return {
    href: url.href,
    hrefKind: url.origin === documentOrigin ? 'SAME_ORIGIN_HTTP' : 'EXTERNAL_ORIGIN_HTTP',
  };
}

function identityFor(candidate: Omit<InteractionCandidate, 'candidateId'>): string {
  return JSON.stringify({
    tagName: candidate.tagName,
    role: candidate.role,
    accessibleName: candidate.accessibleName,
    textFingerprint: candidate.textFingerprint,
    ariaControls: candidate.ariaControls,
    formAssociated: candidate.formAssociated,
    formMethod: candidate.formMethod,
    formAction: candidate.formAction,
    href: candidate.href,
    hrefKind: candidate.hrefKind,
    download: candidate.download,
    type: candidate.type,
  });
}

/** ブラウザから受け取った値を、型を確かめながら候補にする。不正な値は、上限付きの名前だけを含むメッセージで拒否する。 */
function candidateFromRaw(candidate: unknown, label: string): InteractionCandidate {
  if (!isRecord(candidate)) {
    throw new Error(`Invalid browser interaction candidate: ${label}`);
  }
  const { href, hrefKind } = classifyHref(candidate.rawHref, candidate.documentUrl, candidate.documentOrigin);
  const actionFacts = destructiveFactsField(candidate.destructiveFacts, `${label}.destructiveFacts`);
  const withoutId: Omit<InteractionCandidate, 'candidateId'> = {
    ordinal: ordinalField(candidate.ordinal, `${label}.ordinal`),
    tagName: stringField(candidate.tagName, `${label}.tagName`),
    role: nullableStringField(candidate.role, `${label}.role`),
    accessibleName: stringField(candidate.accessibleName, `${label}.accessibleName`),
    textFingerprint: createSha256Fingerprint(stringField(candidate.normalizedText, `${label}.normalizedText`)),
    ariaExpanded: nullableStringField(candidate.ariaExpanded, `${label}.ariaExpanded`),
    ariaControls: nullableStringField(candidate.ariaControls, `${label}.ariaControls`),
    ariaSelected: nullableStringField(candidate.ariaSelected, `${label}.ariaSelected`),
    controlledVisible: nullableBooleanField(candidate.controlledVisible, `${label}.controlledVisible`),
    controlledHidden: nullableBooleanField(candidate.controlledHidden, `${label}.controlledHidden`),
    formAssociated: booleanField(candidate.formAssociated, `${label}.formAssociated`),
    formMethod: nullableStringField(candidate.formMethod, `${label}.formMethod`),
    formAction: nullableStringField(candidate.formAction, `${label}.formAction`),
    href,
    hrefKind,
    download: booleanField(candidate.download, `${label}.download`),
    type: nullableStringField(candidate.type, `${label}.type`),
    disabled: booleanField(candidate.disabled, `${label}.disabled`),
    visible: booleanField(candidate.visible, `${label}.visible`),
    destructiveAction: isDestructiveAction(actionFacts),
    // AIW: AI の操作の印は、当たるときだけ付ける（前の記録の形のまま）。
    ...(isAiAction(actionFacts) ? { aiAction: true } : {}),
    boundingBox: boundingBoxField(candidate.boundingBox, `${label}.boundingBox`),
  };
  return freezeInteractionCandidate({
    ...withoutId,
    candidateId: `${INTERACTION_CANDIDATE_ID_PREFIX}${createSha256Fingerprint(identityFor(withoutId))}`,
  });
}

/**
 * DOM から切り離された汎用インタラクションのスナップショットを、単一の読み取り専用 evaluation で探索する。L10（INV-LIMITS の N3・N4）: 候補の数・長さの上限は
 * 撤廃した（文書の終わりまで探し、切り詰めない）。`maxDomWork` は任意の入力（省略は数えるだけで止めない。テストが小さな値を注入するときだけ渡す）。
 */
export async function discoverInteractionCandidates(
  page: Page,
  maxDomWork: number | undefined = undefined,
  deadlineAtMs: number = Date.now() + INTERACTION_CANDIDATE_READ_TIMEOUT_MS,
): Promise<InteractionCandidateDiscoveryResult> {
  const boundedMaxDomWork = validatedDomWorkLimit(maxDomWork);
  if (boundedMaxDomWork === 0) {
    return Object.freeze({
      candidates: Object.freeze([]),
      completeness: 'DOM_WORK_BUDGET_REACHED',
      domWorkUsed: 0,
    });
  }
  // T32j-4: isolated world で読む（ページの JS は結果を偽れず、読む間に走らない）。読めなければ、今の evaluate の失敗と同じく例外にする。
  const outcome = await interactionCandidateReadsOf(page).discover(page, {
    mode: 'DISCOVER',
    selector: INTERACTION_CANDIDATE_SELECTOR,
    limits: probeLimitsOf(boundedMaxDomWork),
    visibilityOptions: VISIBILITY_CHECK_OPTIONS,
  }, deadlineAtMs);
  if (outcome.status !== 'READ') {
    throw new Error('Interaction candidate isolated read failed');
  }
  const raw: unknown = outcome.value;

  if (!isRecord(raw) || !Array.isArray(raw.candidates)) {
    throw new Error('Invalid browser interaction candidate container');
  }
  if (!isDiscoveryCompleteness(raw.completeness)) {
    throw new Error('Invalid browser interaction completeness');
  }
  if (!validDomWorkCount(raw.domWorkUsed, boundedMaxDomWork)) {
    throw new Error('Invalid browser interaction DOM work count');
  }
  const candidates = raw.candidates.map((candidate, index) => candidateFromRaw(candidate, `[${index}]`));
  return Object.freeze({
    candidates: Object.freeze(candidates),
    completeness: raw.completeness,
    domWorkUsed: raw.domWorkUsed,
  });
}

/**
 * 保持した対象の要素そのものの属性の記録（設計書 2026-09-23 4.4.1）。子孫の属性は含めない。
 * auditor の内部の判定（観測の前後で対象自身の属性が変わったか）に使う。記録そのものは Evidence に含めず、
 * 根拠になった場合に、変わった属性の名前だけを Evidence（`changedAttributes`）に残す（設計書 2026-09-23 4.4.1、R5 の N-5）。
 * - `RECORDED`: `entries` に、属性の順に `名前, 値` を並べる。名前も値も切り詰めない（前の `maxAttributeLength`・`maxClassAttributeLength` は、
 *   もうない。LZ-3b で説明を今のコードに合わせた）。
 * - `INCOMPLETE`: 属性の走査が、共有の DOM の作業量の上限に達した。属性が変わったかを判定できない。
 * - `UNRECORDED`: ブラウザから記録を受け取らなかった。属性が変わったかを判定できない。
 */
export type InteractionAttributeRecord =
  | { readonly status: 'RECORDED'; readonly entries: readonly string[] }
  | { readonly status: 'INCOMPLETE' | 'UNRECORDED' };

/** 属性の記録の名前と値の組（JSON の文字列）を並べる。値が空白だけの `class` は、ないものとみなす（`classList.remove` の後に残る空の class）。 */
function effectiveAttributePairs(entries: readonly string[]): { readonly name: string; readonly pair: string }[] {
  const pairs: { readonly name: string; readonly pair: string }[] = [];
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const name = entries[index] as string;
    const value = entries[index + 1] as string;
    if (name === CLASS_ATTRIBUTE_NAME && value.trim() === '') continue;
    pairs.push({ name, pair: JSON.stringify([name, value]) });
  }
  return pairs;
}

/** 属性の記録から、名前が `name` の属性の値を返す。属性がない場合は空文字列を返す（空と同じ意味の属性の扱いに合わせる）。 */
function recordedAttributeValue(entries: readonly string[], name: string): string {
  for (let index = 0; index + 1 < entries.length; index += 2) {
    if (entries[index] === name) return entries[index + 1] as string;
  }
  return '';
}

// L10（INV-LIMITS の N3・N4）: 属性の値の長さの上限（前は class 4,096、ほかの属性 512。F20b）は撤廃し、ブラウザの中の記録も切り詰めないので、切り詰めの
// 確かめ（前の `mayBeTruncatedAttributeValue`。いつも偽）は LZ-1 で消した（いつも分解して比べる）。

/**
 * 空白で区切った値（class の値）の中の名前を区切る、ASCII の空白（HTML の `classList` と同じ区切り）。
 */
const ASCII_WHITESPACE_SEPARATOR_PATTERN = /[\t\n\f\r ]+/u;

/**
 * class の値の中の名前の集まり。L10 で値を切り詰めなくなったので、いつも名前ごとに分ける（前は、切り詰められた可能性がある値は null。設計書 2026-09-23
 * 4.4.1「長い class」）。
 */
function classNamesOf(value: string): ReadonlySet<string> {
  return new Set(value.split(ASCII_WHITESPACE_SEPARATOR_PATTERN).filter((name) => name !== ''));
}

/**
 * 2つの属性の記録で、class の中で増えた、または減った名前を、UTF-16 のコード単位の順に重複なく返す（設計書 2026-09-23 4.4.1、R6 の M-2）。
 * class がない場合と、値が空白だけの場合は、名前のない class とみなす。
 * どちらかが記録を持たない場合は、名前ごとに比べられないので null を返す（L10 で値を切り詰めなくなったので、長い class でも比べる）。
 */
export function changedInteractionClassNames(
  before: InteractionAttributeRecord,
  after: InteractionAttributeRecord,
): readonly string[] | null {
  if (before.status !== 'RECORDED' || after.status !== 'RECORDED') {
    return null;
  }
  const beforeNames = classNamesOf(recordedAttributeValue(before.entries, CLASS_ATTRIBUTE_NAME));
  const afterNames = classNamesOf(recordedAttributeValue(after.entries, CLASS_ATTRIBUTE_NAME));
  const changed = [
    ...[...beforeNames].filter((name) => !afterNames.has(name)),
    ...[...afterNames].filter((name) => !beforeNames.has(name)),
  ];
  return Object.freeze(changed.sort(compareCodeUnits));
}

/**
 * 値の組が変わった属性が、意味の上でも変わったか。class は中の名前の集まりで比べる（名前の順と空白の違いは変化とみなさない。R6 の M-2）。
 * ほかの属性は、値の組が変われば変わったとみなす。SPEC-5: style は根拠にしないので、宣言に分けて比べる処理（R6 の I-1）はやめた。
 */
function attributeChangedInMeaning(name: string, beforeEntries: readonly string[], afterEntries: readonly string[]): boolean {
  if (name !== CLASS_ATTRIBUTE_NAME) {
    return true;
  }
  const beforeNames = classNamesOf(recordedAttributeValue(beforeEntries, name));
  const afterNames = classNamesOf(recordedAttributeValue(afterEntries, name));
  return beforeNames.size !== afterNames.size || [...beforeNames].some((className) => !afterNames.has(className));
}

/**
 * 2つの属性の記録で、加わった、除かれた、または値が変わった属性の名前を、UTF-16 のコード単位の順に重複なく返す。
 * どちらかが記録を持たない（比べられない）場合は null を返す。値が空白だけの `class` は、ないものとみなす。
 * class は中の名前の集まりが変わった場合だけ、変わったとする（R6 の M-2）。
 */
export function changedInteractionAttributeNames(
  before: InteractionAttributeRecord,
  after: InteractionAttributeRecord,
): readonly string[] | null {
  if (before.status !== 'RECORDED' || after.status !== 'RECORDED') {
    return null;
  }
  const beforePairs = effectiveAttributePairs(before.entries);
  const afterPairs = effectiveAttributePairs(after.entries);
  const names = new Set<string>();
  const collect = (
    pairs: readonly { readonly name: string; readonly pair: string }[],
    counterpart: ReadonlySet<string>,
  ): void => {
    for (const { name, pair } of pairs) {
      if (!counterpart.has(pair)) names.add(name);
    }
  };
  collect(beforePairs, new Set(afterPairs.map(({ pair }) => pair)));
  collect(afterPairs, new Set(beforePairs.map(({ pair }) => pair)));
  return Object.freeze(
    [...names]
      .filter((name) => attributeChangedInMeaning(name, before.entries, after.entries))
      .sort(compareCodeUnits),
  );
}

const UNRECORDED_ATTRIBUTES: InteractionAttributeRecord = Object.freeze({ status: 'UNRECORDED' });
const INCOMPLETE_ATTRIBUTES: InteractionAttributeRecord = Object.freeze({ status: 'INCOMPLETE' });

/** ブラウザから受け取った属性の記録を確かめる。記録がない場合は `UNRECORDED`、不正な値は拒否する。 */
function attributeRecordFromRaw(snapshot: Record<string, unknown>): InteractionAttributeRecord {
  if (!Object.hasOwn(snapshot, 'attributes')) {
    return UNRECORDED_ATTRIBUTES;
  }
  const raw = snapshot.attributes;
  if (!isRecord(raw) || typeof raw.complete !== 'boolean' || !Array.isArray(raw.entries)) {
    throw new Error('Invalid bounded interaction handle snapshot');
  }
  const entries: unknown[] = raw.entries;
  // L10（INV-LIMITS の N3・N4）: 名前と値の数と長さの上限は撤廃した（形だけを確かめる）。
  if (entries.length % 2 !== 0
    || !entries.every((entry) => typeof entry === 'string')) {
    throw new Error('Invalid bounded interaction handle snapshot');
  }
  if (!raw.complete) {
    return INCOMPLETE_ATTRIBUTES;
  }
  return Object.freeze({ status: 'RECORDED', entries: Object.freeze([...entries as string[]]) });
}

/**
 * ブラウザから受け取った、親の `details` の開閉の状態を確かめる（設計書 2026-09-23 4.4.1）。
 * 記録がない場合は null（対象が `details` の子の `summary` でない場合と同じ）とし、不正な値は拒否する。
 */
function detailsOpenFromRaw(snapshot: Record<string, unknown>): boolean | null {
  if (!Object.hasOwn(snapshot, 'detailsOpen')) {
    return null;
  }
  const raw = snapshot.detailsOpen;
  if (raw !== null && typeof raw !== 'boolean') {
    throw new Error('Invalid bounded interaction handle snapshot');
  }
  return raw;
}

export type InteractionHandleSnapshot =
  | {
      readonly status: 'CONNECTED';
      readonly candidate: InteractionCandidate;
      readonly attributes: InteractionAttributeRecord;
      /**
       * 対象が `details` の子の `summary` の場合は、親の `details` の `open` の有無（開閉の状態）。それ以外は null。
       * auditor の内部の判定（観測の前後で開閉の状態が変わったか）だけに使う（設計書 2026-09-23 4.4.1）。
       */
      readonly detailsOpen: boolean | null;
      readonly domWorkUsed: number;
    }
  | { readonly status: 'DISCONNECTED'; readonly domWorkUsed: number }
  | { readonly status: 'DOM_WORK_BUDGET_REACHED'; readonly domWorkUsed: number };

/**
 * 他のノードを解決することなく、保持している単一のブラウザノード（参照の backendNodeId の要素を isolated world で解決したもの。T32j-4）から
 * 候補の情報を読み取る。読めなければ（ページが移った後など）、今の evaluate の失敗と同じく例外にする。
 */
export async function inspectInteractionCandidateHandle(
  reference: Pick<InteractionCandidateReference, 'page' | 'backendNodeId'>,
  ordinalHint: number,
  // L10（INV-LIMITS の N3・N4）: 任意の入力（省略は数えるだけで止めない。テストが小さな値を注入するときだけ渡す）。順番の上限（前は 99）は撤廃した。
  maxDomWork: number | undefined = undefined,
  deadlineAtMs: number = Date.now() + INTERACTION_CANDIDATE_READ_TIMEOUT_MS,
): Promise<InteractionHandleSnapshot> {
  if (!isNonNegativeSafeInteger(ordinalHint)) {
    throw new Error('Interaction candidate ordinal hint is outside the bounded contract');
  }
  const boundedMaxDomWork = validatedDomWorkLimit(maxDomWork);
  if (boundedMaxDomWork === 0) {
    return Object.freeze({ status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 0 });
  }
  const input: HandleInteractionProbeInput = {
    mode: 'INSPECT',
    selector: INTERACTION_CANDIDATE_SELECTOR,
    limits: probeLimitsOf(boundedMaxDomWork),
    visibilityOptions: VISIBILITY_CHECK_OPTIONS,
    classAttributeName: CLASS_ATTRIBUTE_NAME,
  };
  const outcome = await interactionCandidateReadsOf(reference.page).inspect(reference.page, reference.backendNodeId, input, deadlineAtMs);
  if (outcome.status !== 'READ') {
    throw new Error('Interaction candidate isolated read failed');
  }
  const snapshot: unknown = outcome.value;
  if (!isRecord(snapshot)) {
    throw new Error('Invalid bounded interaction handle snapshot');
  }
  const status = (snapshot as { readonly status?: unknown }).status;
  const domWorkUsed = (snapshot as { readonly domWorkUsed?: unknown }).domWorkUsed;
  // L10・SPEC-5: 候補の数とテキストのノードの上限は撤廃したので、`CANDIDATE_LIMIT_REACHED`・`TEXT_NODE_LIMIT_REACHED` は受け取らない（不正な値）。
  if (!validDomWorkCount(domWorkUsed, boundedMaxDomWork)
    || (status !== 'CONNECTED'
      && status !== 'DISCONNECTED'
      && status !== 'DOM_WORK_BUDGET_REACHED')) {
    throw new Error('Invalid bounded interaction handle snapshot');
  }
  const hasRaw = Object.hasOwn(snapshot, 'raw');
  if (status === 'CONNECTED') {
    const raw = (snapshot as { readonly raw?: unknown }).raw;
    if (!hasRaw || !isRecord(raw)) {
      throw new Error('Invalid bounded interaction handle snapshot');
    }
    return Object.freeze({
      status: 'CONNECTED',
      candidate: candidateFromRaw(raw, '[retained-handle]'),
      attributes: attributeRecordFromRaw(snapshot),
      detailsOpen: detailsOpenFromRaw(snapshot),
      domWorkUsed,
    });
  }
  if (hasRaw || Object.hasOwn(snapshot, 'attributes') || Object.hasOwn(snapshot, 'detailsOpen')) {
    throw new Error('Invalid bounded interaction handle snapshot');
  }
  return Object.freeze({ status, domWorkUsed });
}

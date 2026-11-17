// ページの中で読む部品と、型つきの組み立て（CC-068。Task 32 の設計書 4.4 の「CC-068 の設計」の 1）。
// - 部品（`StandardReaders`）: 標準の prototype の getter で読む 4 つの読み方。DOM clobbering（form の中の名前つきの入力の欄が form の、
//   名前つきの img・form などが `document` の、同じ名前のプロパティを隠す。DEF-069・DEF-072・DEF-073）を受けずに読むため、ページの中の関数は
//   要素や `document` のプロパティを、標準の prototype の getter で読む。今までは、その読み方を、ページの中の関数ごとに書いていた（15 関数）。
// - ページの中の関数（`page.evaluate`・`ElementHandle.evaluate`・`page.evaluateHandle`・`readInIsolatedWorld` に渡す関数）は、関数の外の値を
//   参照できない（関数の本文の文字列だけが渡る）。そこで、`composeInPage` が、Node の側で、部品を作る関数の本文と、読む関数の本文を、1 つの
//   関数に組み立てる。読む関数は、部品を最初の引数で受け取る。ページの中では文字列を eval しない（`new Function` は Node の側で 1 回だけ。
//   CSP の `script-src 'self'` と Trusted Types の `'none'` のページでも、今までの関数と同じ道で動く）。evaluate の回数は変わらない。
// - ページの JS の偽りへの強さは、今までの読み方と同じに保つ: 部品は、今までと同じく `Object.getOwnPropertyDescriptor` と `.call` だけを使い、
//   `Function.prototype.bind`・`Object.freeze`・配列の展開（反復子）など、ページの JS が書き換えられる別の入口を足さない。部品を作る時点では
//   DOM を読まない（getter を取り出すのは、各部品を呼んだとき）。main world で読む限り、ページの JS は `getOwnPropertyDescriptor` と `call` を
//   書き換えて結果を偽れる（DEF-087。今までと同じ限界）。偽れないのは isolated world（`readInIsolatedWorld`）で動かした場合。
// - `getOwnPropertyDescriptor` を書くのは、このファイルだけ（Gate `in-page-readers-ownership`）。
// - このファイルは Playwright を読み込まない（型も使わない）。どの層からでも import できる。
// - CC-128・CC-129（2026-11-06）: 枠の landmark の判定（`isLayoutLandmark`）と、要素が描く面の事実の読み方（`ownSurfaceFactsOf`）も、ここで 1 か所に持つ。
//   部品は呼ばれた関数の中に本文として入るので、読み取りが main world か isolated world かは、呼ぶ側の今までのまま変わらない。

import type { LoadingIndicatorEvidence } from '../core/evidence-types.js';
import type { OwnSurfaceFacts } from '../core/own-surface.js';
import type { DestructiveActionFacts } from '../discovery/destructive-action.js';
import type { StateStructureField } from '../discovery/state-keys.js';

/** DEF-208-4（A）・SLK-1: 共通の枠の目印の基準（目印にする要素の名前と role、本文の印にする要素の名前と role、区分の中では目印にしない要素と区分の selector）。 */
export interface LayoutLandmarkCriteria {
  readonly layoutNames: readonly string[];
  readonly layoutRoles: readonly string[];
  readonly bodyNames: readonly string[];
  readonly bodyRoles: readonly string[];
  readonly scopedNames: readonly string[];
  readonly sectioningScopeSelector: string;
}

/** COV-1・SLK-1: 見える欄の読み取りの基準（見え方の確かめの指定、欄の selector、受ける input の型）。 */
export interface StateFieldCriteria {
  readonly visibilityOptions: CheckVisibilityOptions;
  readonly fieldSelector: string;
  readonly fieldTypes: readonly string[];
}

/**
 * ページの中で使う、標準の prototype の getter で読む部品。どれも、ページの中で `createStandardReadersInPage` が作る。
 * 型の引数 `T` は呼ぶ側の宣言（ページの中で値の形は確かめない。今までの `as T` と同じ）。
 */
export interface StandardReaders {
  /**
   * `prototype` の `name` の標準の getter を、呼んだ時点で取り出し、`target` で呼ぶ関数を返す。getter がなければ、呼んだ時点で例外
   * （`Missing standard DOM getter: <name>`）。今までの `standardGetter`・`getterOf` と同じ。
   */
  readonly standardGetter: <T = unknown>(prototype: object, name: string) => (target: unknown) => T;
  /**
   * `standardGetter` と同じく、呼んだ時点で getter を取り出すが、getter がなければ例外にせず、返す関数が `undefined` を返す
   * （今までの `discover-links.ts` の `shadowRootGetter?.call(…)` と同じ。`optionalOpenRoots` が使う）。
   */
  readonly optionalStandardGetter: <T = unknown>(prototype: object, name: string) => (target: unknown) => T | undefined;
  /**
   * `prototype` の `name` の標準の getter を、呼ぶたびに取り出して `target` で呼ぶ。getter がなければ `undefined`（型は `T` のまま。今までの
   * `login-form-submitter.ts` の `read`、`documentProperty` の `as T` と同じ）。
   */
  readonly standardProperty: <T = unknown>(prototype: object, name: string, target: unknown) => T;
  /** `document` の `name` を、`Document.prototype` の標準の getter で読む（`standardProperty` と同じ扱い。今までの `documentProperty`）。 */
  readonly documentProperty: <T = unknown>(name: string) => T;
  /**
   * 要素の位置（文書の根からの、要素の子の中の番号の並び。XPath の `/*[n]` の並びと同じ数え方）。shadow root の中と、文書につながって
   * いない要素は `null`（T32j-4。要素の橋渡し `src/discovery/isolated-read.ts` と、書き込みの form の読み取りが共有する）。
   */
  readonly elementPathOf: (element: Element) => number[] | null;
  /** 位置（`elementPathOf` の並び）の要素。なければ `null`（空の並びも `null`）。 */
  readonly elementAtPath: (path: readonly number[]) => Element | null;
  /**
   * CC-099（T37c fix round 1）: 文書と、その中の open な shadow root（入れ子を含む。文書の順）。closed な shadow root はページの中から見えない。
   * ログインの form の事前の確かめと、入口の確かめの CSS の数え方が共有する（`queryAllInRoots` と組みで使う）。
   */
  readonly openRoots: () => (Document | ShadowRoot)[];
  /**
   * PRE42-CC 組 5b（CC-099）: `openRoots` と同じ根を同じ順で返すが、`Element.prototype` の `shadowRoot` の標準の getter がない（ページの JS が
   * 消した）ときは、例外にせず shadow root を飛ばす（文書だけになる）。link の取り出し（`src/crawl/discover-links.ts`）が使う（細工したページで
   * 発見が止まらない。今までの link の取り出しの振る舞い）。
   */
  readonly optionalOpenRoots: () => (Document | ShadowRoot)[];
  /** CC-099: `openRoots` の根ごとに CSS で探した要素（根の順）。CSS が標準の CSS でなければ例外。 */
  readonly queryAllInRoots: (roots: readonly (Document | ShadowRoot)[], selector: string) => Node[];
  /**
   * CC-099: 要素の祖先（shadow root では host へ移る）に、`href` のある `a`・`area` があるか（押すとページが移りうる）。移動の要素の名前と `href` 属性で
   * 見る（リンクの取り出しの owner の書き方は使わない。GATE-ARCH03）。ログインの form の事前の確かめと、入口の確かめの送信の要素の受け方が共有する。
   */
  readonly hasLinkAncestor: (node: Node) => boolean;
  /**
   * T43d fix round 1: 要素が見えるか（`checkVisibility` があれば、不透明度と `visibility` を含めて見え、さらに枠の幅と高さが 0 より大きい）。入口の確かめの
   * 欄の読み取り（`src/worker/entry-check-page.ts`）と、ログインの段の観察（`src/worker/login-stage-observation.ts`）が共有する。
   */
  readonly isVisible: (element: Element) => boolean;
  /**
   * CC-128: 要素が、枠の landmark（`names` の要素の名前か `roles` の role）か。ARIA の決まり（HTML-AAM）で見る: 明示の `role` がある要素は `role` だけで
   * 決める。`scopedNames` の要素（`header`・`footer`）は、親から上が区分の要素（`sectioningScopeSelector`）の中にないときだけ landmark にする。
   * 通知の枠の見分け（`src/interaction/notification-overlay.ts`）と、操作さがしの共通の枠の目印（`src/interaction/submission-probe.ts`）が共有する。
   * 祖先のたどり方は呼ぶ側が持つ（この部品は要素 1 つを見る）。
   */
  readonly isLayoutLandmark: (
    element: Element,
    names: readonly string[],
    roles: readonly string[],
    scopedNames: readonly string[],
    sectioningScopeSelector: string,
  ) => boolean;
  /**
   * DEF-208-4（A）・SLK-1: 要素の祖先の、共通の枠の目印（`criteria` の名前と role。判定は `isLayoutLandmark`。内から外の順に `名前[role]`）と、その最も外の
   * 要素（共通の枠の部分）。祖先に本文の印（`criteria.bodyNames`・`bodyRoles`）があれば、目印なし（空と `null`）。操作さがしの共通の枠の目印の読み取りと、
   * 枠の部分の事実の読み取りが共有する。
   */
  readonly layoutLandmarksOf: (element: Element, criteria: LayoutLandmarkCriteria) => { readonly landmarks: string[]; readonly frame: Element | null };
  /**
   * COV-1・SLK-1: `root`（文書か要素）の中の見える欄の事実（名前・型・必須・無効・選択肢の値。文字の値は読まない）。状態の構造の鍵の読み取りと、共通の枠の
   * 部分の事実の読み取りが共有する。
   */
  readonly visibleStateFieldsIn: (root: Document | Element, input: StateFieldCriteria) => StateStructureField[];
  /** COV-1・SLK-1: `root`（文書か要素）の中の見える見出し（h1〜h6）の段（文書の順）。 */
  readonly visibleHeadingLevelsIn: (root: Document | Element, visibilityOptions: CheckVisibilityOptions) => number[];
  /**
   * CC-129: 要素そのものが描く面の事実（`OwnSurfaceFacts` の、`replacedContent` を除いた項目。判定は Node の側の `paintsOwnSurfaceOf`）。計算値は
   * 呼ぶ側が取った `style`（その要素の `getComputedStyle`）から読む。自分の文字は、子のノードが `maxOwnTextNodeScan` を超えたら、あるものとして扱う。
   * 固定の要素の収集（`src/evidence/layout-collector.ts`）と、通知の枠の読み取り（`src/interaction/notification-overlay.ts`）が共有する。
   */
  readonly ownSurfaceFactsOf: (element: Element, style: CSSStyleDeclaration, maxOwnTextNodeScan: number) => Omit<OwnSurfaceFacts, 'replacedContent'>;
  /**
   * SD-1（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.2）: 操作の前の判定（Node の側の `isDestructiveAction`）に渡す、要素の事実（名前・
   * method・送り先・選ばれた選択肢・行・枠・確かめの枠の文）。知らせの枠の読み取り・Interaction の候補の読み取り・発見の押す前の確かめが共有する。配列の
   * 反復子を使うので、isolated world の読み取り（ページの JS が配列の関数を書き換えられない）からだけ呼ぶ。
   */
  readonly destructiveActionFactsOf: (element: Element) => DestructiveActionFacts;
  /**
   * EV-1（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.1）: 要素のスクロールの祖先（内から外の順）。`overflow-x` か `overflow-y` が `auto`・`scroll`・
   * `overlay` で、その方向の内容が箱より大きい祖先。文書の根・body・`scrollingElement` は含めない（文書のスクロールは別に読む）。固定の枠の覆いの判定（layout の
   * 読み取り）と、フォーカスの確かめの前と後の位置（フォーカスの確かめの読み取り）が共有する。
   */
  readonly scrollAncestorsOf: (element: Element) => Element[];
  /**
   * EV-1: 要素の selector（id があれば `#id`、なければ、文書の根の下からの `名前:nth-of-type(n)` の並び。段は `maxDepth` まで）。フォーカスの確かめの読み取りが使う
   * （layout の読み取りは、番号を親ごとに覚える自分の書き方を使う）。
   */
  readonly selectorOf: (element: Element, maxDepth: number) => string;
  /**
   * EV-2（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.2）: hit-test の点の作り方の 1 か所。矩形のビューポートの中の部分の中心と、内側へ `insetPx`
   * （部分の幅・高さの 4 分の 1 まで）寄せた四隅。ビューポートの中に部分がなければ点なし。layout の読み取り（固定の要素の重なり）・フォーカスの確かめ・対象まで
   * 動かして撮る部品が共有する。
   */
  readonly hitPointsOf: (
    area: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
    viewportWidth: number,
    viewportHeight: number,
    insetPx: number,
  ) => (readonly [number, number])[];
  /**
   * EV-1・EV-3: 文書の中の、見えている読み込み中の表示の数（`LoadingIndicatorEvidence`。見えて、大きさが 0 でなく、文書の範囲に入るもの）。DOM の読み取り
   * （その状態の記録）と、落ち着きの待ち（準備の状態）が共有する。
   */
  readonly loadingIndicatorsIn: (visibilityOptions: CheckVisibilityOptions) => LoadingIndicatorEvidence;
}

/**
 * ページの中で部品を作る（`composeInPage` が本文を文字列にして組み込む。関数の外の値を参照しない）。部品を作る時点では DOM を読まない。
 * 返す値は、ふつうの object のリテラル（`Object.freeze` などのページの JS が書き換えられる関数を呼ばない）。
 */
function createStandardReadersInPage(): StandardReaders {
  const standardGetter = <T = unknown>(prototype: object, name: string): ((target: unknown) => T) => {
    const getter = Object.getOwnPropertyDescriptor(prototype, name)?.get;
    if (getter === undefined) {
      throw new Error(`Missing standard DOM getter: ${name}`);
    }
    return (target) => getter.call(target) as T;
  };
  const optionalStandardGetter = <T = unknown>(prototype: object, name: string): ((target: unknown) => T | undefined) => {
    const getter = Object.getOwnPropertyDescriptor(prototype, name)?.get;
    return (target) => getter?.call(target) as T | undefined;
  };
  const standardProperty = <T = unknown>(prototype: object, name: string, target: unknown): T =>
    Object.getOwnPropertyDescriptor(prototype, name)?.get?.call(target) as T;
  const documentProperty = <T = unknown>(name: string): T => standardProperty<T>(Document.prototype, name, document);
  const elementPathOf = (element: Element): number[] | null => {
    const previousElementSiblingOf = standardGetter<Element | null | undefined>(Element.prototype, 'previousElementSibling');
    const parentNodeOf = standardGetter<Node | null | undefined>(Node.prototype, 'parentNode');
    const nodeTypeOf = standardGetter<number>(Node.prototype, 'nodeType');
    const steps: number[] = [];
    let current: Node = element;
    for (;;) {
      let index = 0;
      let sibling = previousElementSiblingOf(current);
      while (sibling !== null && sibling !== undefined) {
        index += 1;
        sibling = previousElementSiblingOf(sibling);
      }
      steps.push(index);
      const parent = parentNodeOf(current);
      if (parent === null || parent === undefined) {
        return null;
      }
      if (nodeTypeOf(parent) === Node.DOCUMENT_NODE) {
        break;
      }
      if (nodeTypeOf(parent) !== Node.ELEMENT_NODE) {
        return null;
      }
      current = parent;
    }
    return steps.reverse();
  };
  const elementAtPath = (path: readonly number[]): Element | null => {
    const documentFirstElementChildOf = standardGetter<Element | null>(Document.prototype, 'firstElementChild');
    const firstElementChildOf = standardGetter<Element | null>(Element.prototype, 'firstElementChild');
    const nextElementSiblingOf = standardGetter<Element | null>(Element.prototype, 'nextElementSibling');
    let current: Element | null = null;
    for (let depth = 0; depth < path.length; depth += 1) {
      const step = path[depth] ?? -1;
      let child: Element | null = current === null ? documentFirstElementChildOf(document) : firstElementChildOf(current);
      for (let index = 0; index < step && child !== null; index += 1) {
        child = nextElementSiblingOf(child);
      }
      if (child === null || step < 0) {
        return null;
      }
      current = child;
    }
    return current;
  };
  // 根の取り出しの本体（`openRoots`・`optionalOpenRoots` が、shadow root の読み方だけを変えて共有する）。
  const openRootsWith = (shadowRootOf: (element: Node) => ShadowRoot | null): (Document | ShadowRoot)[] => {
    const roots: (Document | ShadowRoot)[] = [document];
    const walk = (root: Document | ShadowRoot): void => {
      const walker = Document.prototype.createTreeWalker.call(document, root, NodeFilter.SHOW_ELEMENT);
      for (let node = TreeWalker.prototype.nextNode.call(walker); node !== null; node = TreeWalker.prototype.nextNode.call(walker)) {
        const shadowRoot = shadowRootOf(node);
        if (shadowRoot !== null) {
          roots.push(shadowRoot);
          walk(shadowRoot);
        }
      }
    };
    walk(document);
    return roots;
  };
  const openRoots = (): (Document | ShadowRoot)[] => openRootsWith(standardGetter<ShadowRoot | null>(Element.prototype, 'shadowRoot'));
  const optionalOpenRoots = (): (Document | ShadowRoot)[] => {
    const shadowRootGetterOf = optionalStandardGetter<ShadowRoot | null>(Element.prototype, 'shadowRoot');
    return openRootsWith((element) => shadowRootGetterOf(element) ?? null);
  };
  const queryAllInRoots = (roots: readonly (Document | ShadowRoot)[], selector: string): Node[] => {
    const nodeListLengthOf = standardGetter<number>(NodeList.prototype, 'length');
    const found: Node[] = [];
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      const list = root instanceof Document
        ? Document.prototype.querySelectorAll.call(root, selector)
        : DocumentFragment.prototype.querySelectorAll.call(root as ShadowRoot, selector);
      for (let item = 0; item < nodeListLengthOf(list); item += 1) {
        const node = NodeList.prototype.item.call(list, item);
        if (node !== null) found.push(node);
      }
    }
    return found;
  };
  const hasLinkAncestor = (node: Node): boolean => {
    const parentNodeOf = standardGetter<Node | null>(Node.prototype, 'parentNode');
    const hostOf = standardGetter<Element>(ShadowRoot.prototype, 'host');
    const localNameOf = standardGetter<unknown>(Element.prototype, 'localName');
    for (let current: Node | null = parentNodeOf(node); current !== null;) {
      const name = current instanceof Element ? localNameOf(current) : '';
      if ((name === 'a' || name === 'area') && current instanceof Element && Element.prototype.hasAttribute.call(current, 'href')) return true;
      current = current instanceof ShadowRoot ? hostOf(current) : parentNodeOf(current);
    }
    return false;
  };
  const isVisible = (element: Element): boolean => {
    const checkVisibility = Element.prototype.checkVisibility;
    if (typeof checkVisibility === 'function'
      && !checkVisibility.call(element, { checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) {
      return false;
    }
    const rect = Element.prototype.getBoundingClientRect.call(element);
    const width: unknown = standardProperty(DOMRectReadOnly.prototype, 'width', rect);
    const height: unknown = standardProperty(DOMRectReadOnly.prototype, 'height', rect);
    return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0;
  };
  const isLayoutLandmark = (
    element: Element,
    names: readonly string[],
    roles: readonly string[],
    scopedNames: readonly string[],
    sectioningScopeSelector: string,
  ): boolean => {
    const roleValue: unknown = Element.prototype.getAttribute.call(element, 'role');
    const role = typeof roleValue === 'string' ? roleValue.trim().toLowerCase() : '';
    if (role !== '') return roles.includes(role);
    const name = standardGetter<string>(Element.prototype, 'localName')(element);
    if (!names.includes(name)) return false;
    if (!scopedNames.includes(name)) return true;
    const parent = standardGetter<Element | null>(Node.prototype, 'parentElement')(element);
    return parent === null || Element.prototype.closest.call(parent, sectioningScopeSelector) === null;
  };
  const layoutLandmarksOf = (element: Element, criteria: LayoutLandmarkCriteria): { landmarks: string[]; frame: Element | null } => {
    const localNameOf = standardGetter<string>(Element.prototype, 'localName');
    const parentOf = standardGetter<Element | null>(Node.prototype, 'parentElement');
    const landmarks: string[] = [];
    let frame: Element | null = null;
    for (let node: Element | null = parentOf(element); node !== null; node = parentOf(node)) {
      const name = localNameOf(node);
      const roleValue: unknown = Element.prototype.getAttribute.call(node, 'role');
      const role = typeof roleValue === 'string' ? roleValue.trim().toLowerCase() : '';
      if (criteria.bodyNames.includes(name) || criteria.bodyRoles.includes(role)) return { landmarks: [], frame: null };
      // NO-2（ARIA の決まり。通知の枠の見分け方と同じ）: 明示の role がある要素は role だけで決める。header・footer は、区分の要素の中では枠の目印にしない。
      if (isLayoutLandmark(node, criteria.layoutNames, criteria.layoutRoles, criteria.scopedNames, criteria.sectioningScopeSelector)) {
        landmarks.push(name + '[' + role + ']');
        frame = node;
      }
    }
    return { landmarks, frame };
  };
  const eachIn = (root: Document | Element, selector: string, visit: (element: Element) => void): void => {
    const nodeListLengthOf = standardGetter<number>(NodeList.prototype, 'length');
    const list = root instanceof Document ? Document.prototype.querySelectorAll.call(root, selector) : Element.prototype.querySelectorAll.call(root, selector);
    const length = nodeListLengthOf(list);
    for (let index = 0; index < length; index += 1) {
      const item = NodeList.prototype.item.call(list, index);
      if (item instanceof Element) visit(item);
    }
  };
  const visibleStateFieldsIn = (root: Document | Element, input: StateFieldCriteria): StateStructureField[] => {
    const localNameOf = standardGetter<string>(Element.prototype, 'localName');
    const inputTypeOf = standardGetter<string>(HTMLInputElement.prototype, 'type');
    const selectTypeOf = standardGetter<string>(HTMLSelectElement.prototype, 'type');
    const selectOptionsOf = standardGetter<unknown>(HTMLSelectElement.prototype, 'options');
    const collectionLengthOf = standardGetter<number>(HTMLCollection.prototype, 'length');
    const optionValueOf = standardGetter<string>(HTMLOptionElement.prototype, 'value');
    const attributeOf = (element: Element, name: string): string | null => {
      const value: unknown = Element.prototype.getAttribute.call(element, name);
      return typeof value === 'string' ? value : null;
    };
    const fields: StateStructureField[] = [];
    eachIn(root, input.fieldSelector, (element) => {
      if (!Element.prototype.checkVisibility.call(element, input.visibilityOptions)) return;
      const name = localNameOf(element);
      const type = name === 'input' ? inputTypeOf(element) : (name === 'textarea' ? 'textarea' : selectTypeOf(element));
      if (name === 'input' && !input.fieldTypes.includes(type)) return;
      let optionValues: string[] | null = null;
      if (name === 'select') {
        const options = selectOptionsOf(element);
        const length = collectionLengthOf(options);
        optionValues = [];
        for (let index = 0; index < length; index += 1) {
          const option = HTMLCollection.prototype.item.call(options as HTMLCollection, index);
          if (option !== null) optionValues.push(optionValueOf(option));
        }
      } else if (type === 'radio' || type === 'checkbox') {
        optionValues = [attributeOf(element, 'value') ?? 'on'];
      }
      fields.push({
        name: attributeOf(element, 'name') ?? '',
        type,
        required: Element.prototype.hasAttribute.call(element, 'required'),
        disabled: Element.prototype.matches.call(element, ':disabled'),
        optionValues,
      });
    });
    return fields;
  };
  const visibleHeadingLevelsIn = (root: Document | Element, visibilityOptions: CheckVisibilityOptions): number[] => {
    const localNameOf = standardGetter<string>(Element.prototype, 'localName');
    const levels: number[] = [];
    eachIn(root, 'h1, h2, h3, h4, h5, h6', (element) => {
      if (Element.prototype.checkVisibility.call(element, visibilityOptions)) levels.push(Number(localNameOf(element).slice(1)));
    });
    return levels;
  };
  const ownSurfaceFactsOf = (element: Element, style: CSSStyleDeclaration, maxOwnTextNodeScan: number): Omit<OwnSurfaceFacts, 'replacedContent'> => {
    const childNodesOf = standardGetter<NodeList>(Node.prototype, 'childNodes');
    const nodeListLengthOf = standardGetter<number>(NodeList.prototype, 'length');
    const nodeTypeOf = standardGetter<number>(Node.prototype, 'nodeType');
    const characterDataOf = standardGetter<string>(CharacterData.prototype, 'data');
    const hasOwnTextOf = (): boolean => {
      const children = childNodesOf(element);
      const length = nodeListLengthOf(children);
      if (length > maxOwnTextNodeScan) return true;
      for (let index = 0; index < length; index += 1) {
        const child = NodeList.prototype.item.call(children, index);
        if (child !== null && nodeTypeOf(child) === Node.TEXT_NODE && characterDataOf(child).trim().length > 0) return true;
      }
      return false;
    };
    const hasPseudoContentOf = (): boolean => ['::before', '::after'].some((pseudo) => {
      const content = window.getComputedStyle(element, pseudo).content;
      return content !== 'none' && content !== 'normal' && content !== '';
    });
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      borderWidths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
      borderStyles: [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle],
      borderColors: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor],
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
      outlineColor: style.outlineColor,
      boxShadow: style.boxShadow,
      backdropFilter: style.backdropFilter,
      hasOwnText: hasOwnTextOf(),
      hasPseudoContent: hasPseudoContentOf(),
    };
  };
  const destructiveActionFactsOf = (element: Element): DestructiveActionFacts => {
    // 行・枠・確かめの枠・押せる要素の selector（ページの中では外の値を読めないので、ここに書く。意味は `src/discovery/destructive-action.ts` の説明）。
    const rowSelector = 'tr, li, [role="row"], [role="listitem"], article';
    const frameSelector = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], [role="region"], [popover]';
    const confirmSelector = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]';
    const pressableSelector = 'button, [role="button"], a, input, select, textarea, option, label';
    const urlAttributes = ['href', 'formaction', 'hx-get', 'hx-post', 'hx-put', 'hx-patch', 'hx-delete', 'data-hx-get', 'data-hx-post', 'data-hx-put',
      'data-hx-patch', 'data-hx-delete', 'data-url', 'data-href', 'data-action'];
    const innerTextOf = standardGetter<string>(HTMLElement.prototype, 'innerText');
    const parentElementOf = standardGetter<Element | null>(Node.prototype, 'parentElement');
    const characterDataOf = standardGetter<string>(CharacterData.prototype, 'data');
    const squeezed = (value: string): string => value.replace(/\s+/gu, ' ').trim();
    const attributeOf = (target: Element, name: string): string | null => {
      const value: unknown = Element.prototype.getAttribute.call(target, name);
      return typeof value === 'string' ? value : null;
    };
    const closestOf = (target: Element, selector: string): Element | null => {
      try {
        return Element.prototype.closest.call(target, selector);
      } catch {
        return null;
      }
    };
    const textOf = (target: Element): string => (target instanceof HTMLElement ? squeezed(String(innerTextOf(target) ?? '')) : '');
    const nodeListLengthOf = standardGetter<number>(NodeList.prototype, 'length');
    const queryAll = (root: Element, selector: string): Element[] => {
      const list = Element.prototype.querySelectorAll.call(root, selector);
      const found: Element[] = [];
      for (let index = 0; index < nodeListLengthOf(list); index += 1) {
        const item = NodeList.prototype.item.call(list, index);
        if (item instanceof Element) found.push(item);
      }
      return found;
    };
    const labelledTexts = (target: Element): string[] => (attributeOf(target, 'aria-labelledby') ?? '').split(/\s+/u).filter((id) => id !== '')
      .map((id) => Document.prototype.getElementById.call(document, id))
      .flatMap((labelled) => (labelled === null ? [] : [textOf(labelled)]));
    const names = [textOf(element), attributeOf(element, 'aria-label') ?? '', ...labelledTexts(element), attributeOf(element, 'title') ?? '',
      attributeOf(element, 'value') ?? '', attributeOf(element, 'alt') ?? '', ...queryAll(element, 'img[alt]').map((image) => attributeOf(image, 'alt') ?? '')]
      .map(squeezed).filter((name) => name !== '');
    const ownerForm = element instanceof HTMLButtonElement || element instanceof HTMLInputElement
      ? standardProperty<HTMLFormElement | null>(element instanceof HTMLButtonElement ? HTMLButtonElement.prototype : HTMLInputElement.prototype, 'form', element)
      : closestOf(element, 'form');
    const methods: string[] = [];
    const urls: string[] = [];
    const chosenTexts: string[] = [];
    const formMethod = attributeOf(element, 'formmethod');
    if (formMethod !== null) methods.push(formMethod);
    const dataMethodOwner = closestOf(element, '[data-method]');
    if (dataMethodOwner !== null) methods.push(attributeOf(dataMethodOwner, 'data-method') ?? '');
    // REV-SD の I-4 (c): 送り先の属性（`hx-*` を含む）は、要素と、その属性を持つ最も近い祖先と、属する form から読む（`href` の祖先はリンクで読む）。
    const urlOwners = (name: string): Element[] => {
      const owners: Element[] = [];
      const own = name === 'href' || name === 'formaction' ? element : closestOf(element, `[${name}]`);
      if (own !== null) owners.push(own);
      if (ownerForm !== null && own !== ownerForm) owners.push(ownerForm);
      return owners;
    };
    for (const name of urlAttributes) {
      for (const owner of urlOwners(name)) {
        const value = attributeOf(owner, name);
        if (value !== null) urls.push(value);
      }
    }
    const htmxDeleteSelector = '[hx-delete], [data-hx-delete]';
    const htmxDelete = closestOf(element, htmxDeleteSelector) !== null || (ownerForm !== null && Element.prototype.matches.call(ownerForm, htmxDeleteSelector));
    // 祖先のリンクの移る先（押すと移りうる。リンクの抽出ではない）。
    const link = closestOf(element, 'a[href], area[href]');
    if (link !== null && link !== element) urls.push(attributeOf(link, 'href') ?? '');
    if (ownerForm !== null) {
      const method = attributeOf(ownerForm, 'method');
      if (method !== null) methods.push(method);
      const action = attributeOf(ownerForm, 'action');
      if (action !== null) urls.push(action);
      for (const override of queryAll(ownerForm, 'input[name="_method"]')) methods.push(attributeOf(override, 'value') ?? '');
    }
    const row = closestOf(element, rowSelector);
    const frameElement = closestOf(element, frameSelector);
    const inRow = row !== null && (frameElement === null || (frameElement !== row && Node.prototype.contains.call(frameElement, row)));
    // REV-SD の I-4 (b): 選んだ選択肢は、押す要素の範囲から読む（属する form。なければ同じ枠か、select・radio のある最も近い祖先の区画の、form に属さない欄）。
    const choiceSelector = 'select, input[type="radio" i]';
    const fieldFormOf = (field: Element): unknown => (field instanceof HTMLSelectElement
      ? standardProperty<unknown>(HTMLSelectElement.prototype, 'form', field)
      : standardProperty<unknown>(HTMLInputElement.prototype, 'form', field));
    // REV-SD2 の I-1: 祖先をたどるのは、区画の境（section・main・article・body・landmark・table・form）までにする。境の要素そのものは見るが、その外へは
    // 上がらない（同じ区画の選択肢だけを見て、画面の別の区画の select・radio で、関係のないボタンを削除と判定しない）。
    const choiceBoundarySelector = 'section, main, article, body, nav, aside, header, footer, table, form, '
      + '[role="region"], [role="navigation"], [role="main"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="form"], [role="search"]';
    let choiceScope: Element | null = ownerForm ?? frameElement;
    for (let node: Element | null = element; choiceScope === null && node !== null; node = parentElementOf(node)) {
      if (Element.prototype.querySelector.call(node, choiceSelector) !== null) choiceScope = node;
      if (node !== element && Element.prototype.matches.call(node, choiceBoundarySelector)) break;
    }
    for (const field of choiceScope === null ? [] : queryAll(choiceScope, choiceSelector)) {
      if (ownerForm === null && fieldFormOf(field) !== null) continue;
      if (field instanceof HTMLSelectElement) {
        for (const option of queryAll(field, 'option')) {
          if (option instanceof HTMLOptionElement && standardProperty<boolean>(HTMLOptionElement.prototype, 'selected', option)) {
            chosenTexts.push(standardProperty<string>(HTMLOptionElement.prototype, 'text', option), standardProperty<string>(HTMLOptionElement.prototype, 'value', option));
          }
        }
      } else if (field instanceof HTMLInputElement && standardProperty<boolean>(HTMLInputElement.prototype, 'checked', field)) {
        chosenTexts.push(attributeOf(field, 'value') ?? '');
        const labels = standardProperty<NodeList | null>(HTMLInputElement.prototype, 'labels', field);
        for (let index = 0; labels !== null && index < nodeListLengthOf(labels); index += 1) {
          const label = NodeList.prototype.item.call(labels, index);
          if (label instanceof Element) chosenTexts.push(textOf(label));
        }
      }
    }
    const frameNamesOf = (frame: Element): string[] => {
      const heading = Element.prototype.querySelector.call(frame, 'h1, h2, h3, h4, h5, h6, [role="heading"]');
      return [attributeOf(frame, 'aria-label') ?? '', ...labelledTexts(frame), heading === null ? '' : textOf(heading)].map(squeezed).filter((name) => name !== '');
    };
    // 枠の文（押せる要素と入力の欄の中の文字を除く）。確かめの枠の文と、枠の本文（REV-SD の I-2）に使う。
    const bodyTextOf = (frame: Element): string => {
      const parts: string[] = [];
      const walker = Document.prototype.createTreeWalker.call(document, frame, NodeFilter.SHOW_TEXT);
      for (let node = TreeWalker.prototype.nextNode.call(walker); node !== null; node = TreeWalker.prototype.nextNode.call(walker)) {
        const parent = parentElementOf(node);
        const pressable = parent === null ? null : closestOf(parent, pressableSelector);
        if (pressable !== null && Node.prototype.contains.call(frame, pressable)) continue;
        parts.push(characterDataOf(node as CharacterData));
      }
      return squeezed(parts.join(' '));
    };
    const confirmElement = closestOf(element, confirmSelector);
    const confirmText = confirmElement === null ? null : bodyTextOf(confirmElement);
    return {
      names, methods, htmxDelete,
      urls, baseUrl: documentProperty<string>('URL'), chosenTexts: chosenTexts.map(squeezed).filter((text) => text !== ''), inRow,
      frame: frameElement !== null && !inRow ? { names: frameNamesOf(frameElement), text: bodyTextOf(frameElement) } : null, confirmText,
    };
  };
  const scrollAncestorsOf = (element: Element): Element[] => {
    const parentOf = standardGetter<Element | null>(Node.prototype, 'parentElement');
    const scrollingElement = documentProperty<Element | null>('scrollingElement');
    const root = documentProperty<Element | null>('documentElement');
    const body = documentProperty<Element | null>('body');
    const scrollable = ['auto', 'scroll', 'overlay'];
    const ancestors: Element[] = [];
    for (let node = parentOf(element); node !== null; node = parentOf(node)) {
      if (node === root || node === body || node === scrollingElement) continue;
      const style = window.getComputedStyle(node);
      const vertical = scrollable.includes(style.overflowY)
        && standardGetter<number>(Element.prototype, 'scrollHeight')(node) > standardGetter<number>(Element.prototype, 'clientHeight')(node);
      const horizontal = scrollable.includes(style.overflowX)
        && standardGetter<number>(Element.prototype, 'scrollWidth')(node) > standardGetter<number>(Element.prototype, 'clientWidth')(node);
      if (vertical || horizontal) ancestors.push(node);
    }
    return ancestors;
  };
  const selectorOf = (element: Element, maxDepth: number): string => {
    const parentOf = standardGetter<Element | null>(Node.prototype, 'parentElement');
    const childrenOf = standardGetter<HTMLCollection>(Element.prototype, 'children');
    const tagNameOf = standardGetter<string>(Element.prototype, 'tagName');
    const id = standardGetter<string>(Element.prototype, 'id')(element);
    if (id.length > 0) return `#${CSS.escape(id)}`;
    const nthOfType = (node: Element): number => {
      const parent = parentOf(node);
      if (parent === null) return 1;
      let index = 0;
      for (const child of childrenOf(parent)) {
        if (tagNameOf(child) === tagNameOf(node)) index += 1;
        if (child === node) return index;
      }
      return 1;
    };
    const root = documentProperty<Element | null>('documentElement');
    const segments: string[] = [];
    for (let current: Element | null = element; current !== null && current !== root && segments.length < maxDepth; current = parentOf(current)) {
      segments.unshift(`${tagNameOf(current).toLowerCase()}:nth-of-type(${nthOfType(current)})`);
    }
    return segments.join(' > ');
  };
  const hitPointsOf = (
    area: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
    viewportWidth: number,
    viewportHeight: number,
    insetPx: number,
  ): (readonly [number, number])[] => {
    const left = Math.max(area.left, 0);
    const top = Math.max(area.top, 0);
    const right = Math.min(area.right, viewportWidth);
    const bottom = Math.min(area.bottom, viewportHeight);
    if (right <= left || bottom <= top) return [];
    const insetX = Math.min(insetPx, (right - left) / 4);
    const insetY = Math.min(insetPx, (bottom - top) / 4);
    return [
      [(left + right) / 2, (top + bottom) / 2],
      [left + insetX, top + insetY],
      [right - insetX, top + insetY],
      [left + insetX, bottom - insetY],
      [right - insetX, bottom - insetY],
    ];
  };
  const loadingIndicatorsIn = (visibilityOptions: CheckVisibilityOptions): LoadingIndicatorEvidence => {
    // EV-3（REV-EV3 の M-3）: 見える（`checkVisibility`）うえに、大きさが 0 でなく、文書の範囲（スクロールで届く所）に入る表示だけを数える。
    const root = documentProperty<Element>('documentElement');
    const documentWidth = standardGetter<number>(Element.prototype, 'scrollWidth')(root);
    const documentHeight = standardGetter<number>(Element.prototype, 'scrollHeight')(root);
    const shown = (element: Element): boolean => {
      if (!Element.prototype.checkVisibility.call(element, visibilityOptions)) return false;
      const box = Element.prototype.getBoundingClientRect.call(element);
      const left = box.left + window.scrollX;
      const top = box.top + window.scrollY;
      return box.width > 0 && box.height > 0 && left + box.width > 0 && top + box.height > 0 && left < documentWidth && top < documentHeight;
    };
    const visibleCountOf = (selector: string): number => {
      let visibleCount = 0;
      for (const element of Document.prototype.querySelectorAll.call(document, selector)) {
        if (shown(element)) visibleCount += 1;
      }
      return visibleCount;
    };
    return {
      ariaBusyCount: visibleCountOf('[aria-busy="true" i]'),
      progressbarCount: visibleCountOf('[role="progressbar" i], progress'),
      indeterminateProgressCount: visibleCountOf('progress:indeterminate, [role="progressbar" i]:not(progress):not([aria-valuenow])'),
    };
  };
  return {
    standardGetter, optionalStandardGetter, standardProperty, documentProperty, elementPathOf, elementAtPath, openRoots, optionalOpenRoots, queryAllInRoots,
    hasLinkAncestor, isVisible, isLayoutLandmark, layoutLandmarksOf, visibleStateFieldsIn, visibleHeadingLevelsIn, ownSurfaceFactsOf, destructiveActionFactsOf,
    scrollAncestorsOf, selectorOf, hitPointsOf, loadingIndicatorsIn,
  };
}

/** 部品を作る関数の本文（モジュールを読み込んだときに 1 回だけ文字列にする）。 */
const STANDARD_READERS_SOURCE = String(createStandardReadersInPage);

/**
 * ページの中の関数が受け取る引数（部品の後に、0〜2 個）。`page.evaluate` などは（入力）で、`ElementHandle.evaluate` は（要素, 入力）で呼ぶ。
 * 組み立てた関数は、受け取った 2 つの引数を、そのまま読む関数に渡す（配列の展開を使わない。渡されなかった引数は `undefined`）。
 */
export type InPageArguments = readonly [unknown?, unknown?];

/** ページの中で読む関数。最初の引数で部品を受け取る。関数の外の値（定数・関数）を参照してはいけない（必要な値は入力で渡す）。 */
export type InPageReader<A extends InPageArguments, O> = (readers: StandardReaders, ...args: A) => O;

/**
 * 読む関数 `reader` に部品を組み込み、ページの中で動く 1 つの関数を返す（入力と出力の型は `reader` のまま）。返した関数を、今までの
 * ページの中の関数と同じく `page.evaluate`・`ElementHandle.evaluate`・`page.evaluateHandle`・`readInIsolatedWorld` に渡す。
 * 組み立ては Node の側で行う（呼ぶ側はモジュールの読み込みのときに 1 回だけ呼び、結果を定数に持つ）。
 */
export function composeInPage<A extends InPageArguments, O>(reader: InPageReader<A, O>): (...args: A) => O {
  // Node の側で、本文の文字列から関数を作る（ページの中では eval しない）。部品はページの中で、呼ばれるたびに作る。
  return new Function('first', 'second', `return (${String(reader)})((${STANDARD_READERS_SOURCE})(), first, second);`) as (...args: A) => O;
}

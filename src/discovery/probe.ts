// 発見の probe（Task 27 の設計書 4.1、4.2、4.8。T27b）。ブラウザの部品（`tests/architecture/discovery-boundary.test.ts` の
// `BROWSER_DISCOVERY_FILES`）。
// - isolated world の 1 回の読み取り（`readInIsolatedWorld`。DEF-087）で、ページの form と、押せるボタン（form の外のボタンと、form の中の
//   送信ボタンでないボタン。T27b round 1）を読み、T27a の候補の形（`DiscoveredCandidate` の、JS の結び付きと不完全の理由を除いた部分）にする。
//   isolated world で読むので、ページの JS は、標準の getter とメソッドを書き換えて結果を偽れず、読み取りの間に走らない。ページを操作しない
//   （入力・押す・送る・事象を起こす・焦点を移す呼び出しをしない。同じ Gate の (w)）。
// - 読み方: 標準の prototype の getter とメソッドで読む（DOM clobbering を受けない。isolated world でも要素の名前は document や form の
//   プロパティを隠すので、この読み方は要る。DEF-069〜073 と同じ。`document` も `Document.prototype` で読む。
//   `src/browser/login-form-submitter.ts` の `readLoginFormFactsInPage`、`src/interaction/discover-candidates.ts` と同じ読み方。
//   ブラウザの中で動き、外を参照できないので、読み方はここに書く。CC-068 と同じ扱い）。
// - 値は持たない: 入力の値・CSRF のトークン・hidden の値・選択肢の label を返さない。値は「あるか」の真偽だけ。`_method` の hidden の値は、
//   ページの中で trim して大文字にし、閉じた一覧（`METHOD_OVERRIDE_VALUES`）に当たるときだけ、その値を返す（ほかは null）。select の選択肢は
//   `value` の属性（属性のない option は、送られる値が label の文言になるので、空の文字列にする）、checkbox と radio は `value` の属性（なければ
//   `on`）。送信ボタンの文言は、ボタンの文字（`input` は `value`、画像は `alt`）と `aria-label`・`title`（分類の語を求めるため）。
// - 送信ボタンの文言は持たない（T27R-fix-1。DEF-086）: ページの中で読んだ文言は、Node の側（`candidateOf`）で、分類の owner の `submitterWordsOf`
//   （`classify.ts`）により送信ボタンの語の閉じた一覧の語だけに変え、文言は捨てる（表の行の中身を候補に写さない）。
// - 送信ボタンの上書き（`formmethod`・`formaction`・`formenctype`・`formtarget`）を、属性があるときに、ボタンの標準の getter で読む。target は、
//   ボタン、form、`<base target>` の順（実際の送信の先）。
// - 範囲: 文書と、open な shadow root の中（`Element.prototype.shadowRoot` の getter が返すもの）。closed な shadow root はページの中からは
//   見えない（`listeners.ts` が CDP で見つける）。iframe などの別の文書の要素（`FRAME_ELEMENT_NAMES`）があれば `frameFound`。
// - COV-6b-1（INV-LIMITS の N26・N27）: 走査する要素の数と画面の候補の数の上限は外した（全部の要素を読み、候補は `PAGE_CANDIDATE_PART_SIZE` ずつ
//   `readInParts` で分けて読む。送信の要素も返す読み取りは、同じ読み取りの要素を返すため、分けずに 1 回で全部読む）。
// - 上限: 文字列の長さ（選択肢の値・制約・送信ボタンの文言。契約の名前つきの定数）。L13（N28〜N30）: 欄と選択肢の数、欄と送信先の query の名前の
//   数と長さでは切らない（前は `limitReached` を立て、呼ぶ側が `INCOMPLETE_LIMIT_REACHED` にした）。
// - 要素の位置（`path`）: 文書の根からの、要素の子の中の番号の並び。open な shadow root に入る所は `SHADOW_ROOT_STEP`。JS の結び付きを CDP で
//   読むときに、同じ要素を探すために使う（`listeners.ts`）。
import type { Page } from 'playwright';
import { isNonNegativeSafeInteger, isRecord } from '../core/guards.js';
import { createSha256Fingerprint } from '../core/ids.js';
import { normalizeWhitespace } from '../core/text.js';
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';
import { isHttpProtocol } from '../crawl/normalize-url.js';
import {
  CANDIDATE_FIELD_TAGS,
  CANDIDATE_FIELD_TYPES,
  FIELD_CONSTRAINT_NAMES,
  FORM_ENCTYPES,
  FORM_METHODS,
  METHOD_OVERRIDE_FIELD_NAME,
  METHOD_OVERRIDE_VALUES,
  type CandidateAction,
  type CandidateField,
  type CandidateFieldConstraints,
  type CandidateFieldTag,
  type CandidateFieldType,
  type CandidateKind,
  type CandidateLocation,
  type FormEnctype,
  type FormMethod,
  type MethodOverride,
} from './candidate-contracts.js';
import { submitterTextHasSubmitWord, submitterWordsOf } from './classify.js';
import { textsHaveDestructiveActionWord } from './destructive-action.js';
import { digitTemplateOf } from './state-keys.js';
import { readElementsInIsolatedWorld, readInIsolatedWorld, type InPageElementsResult, type IsolatedElementReference } from './isolated-read.js';
import { readInParts } from '../core/read-in-parts.js';
import {
  composeInPage, DISCOVERY_CANDIDATE_ELEMENT_CRITERIA, type DiscoveryCandidateElementCriteria, type StandardReaders,
} from '../browser/in-page-readers.js';

// COV-6b-1（N26・N27）: 1 つの画面で走査する要素の数（前は 100,000）と候補の数（前は 500）の上限は撤廃した（全部の要素を、分けて全部読む）。
// 定数は LZ-1 で消した。
/** 要素の位置の、open な shadow root に入る所の印（要素の番号は 0 以上なので、負の数にする）。 */
export const SHADOW_ROOT_STEP = -1;
/** 別の文書を持ちうる要素の名前（あれば、その画面を `INCOMPLETE_FRAME_OR_CLOSED_SHADOW` にする）。 */
export const FRAME_ELEMENT_NAMES = Object.freeze(['iframe', 'frame', 'frameset', 'object', 'embed', 'fencedframe', 'portal'] as const);
/** checkbox と radio の `value` の属性がないときの値（HTML の既定）。 */
const DEFAULT_CHECKABLE_VALUE = 'on';
/** `NodeFilter.SHOW_ELEMENT` の値（ページの中の `NodeFilter` を読まずに渡す）。 */
const NODE_FILTER_SHOW_ELEMENT = 1;
/** 送信先の URL の、Origin が決まらない（http(s) でない、解析できない）ときの Origin と path。許可 Origin の外に分類される。 */
const OPAQUE_ORIGIN = 'null';
const ROOT_PATH = '/';

/**
 * COV-6b-1（網羅の設計書 3.3、INV-LIMITS の N27）: 候補を分けて読む 1 回の読み取りの候補の数（自分の処理の大きさ。網羅の上限ではない。候補は全部読む）。
 */
export const PAGE_CANDIDATE_PART_SIZE = 500;

// probe の上限（前はページの中に渡した）: COV-6b-1 で要素の数と候補の数、L13 で欄・選択肢の数と欄の名前の長さ、LZ-2 で選択肢の値と制約の属性の値の長さ、
// LZ-3c で送信ボタンの文言の長さ（前は `MAX_SUBMITTER_TEXT_LENGTH` 256 と読む倍率 4）を外した。上限はもう渡さない。

/** probe の入力（ページの中の関数は外を参照できないので、値はすべてここで渡す）。 */
interface DiscoveryProbeInput {
  readonly visibilityOptions: CheckVisibilityOptions;
  readonly showElement: number;
  readonly shadowRootStep: number;
  readonly constraintNames: readonly string[];
  readonly frameElementNames: readonly string[];
  /** SKIP-1: 候補になる要素の基準（`DISCOVERY_CANDIDATE_ELEMENT_CRITERIA`。form の欄からボタンの形の `input` を除くのにも使う）。 */
  readonly candidateElements: DiscoveryCandidateElementCriteria;
  readonly defaultCheckableValue: string;
  readonly methodOverrideFieldName: string;
  readonly methodOverrideValues: readonly string[];
  /**
   * LU-SFIX2-A（LU-SREV2 の Critical-1）: 送信の要素そのもの（要素の参照）も返すか。真なら、結果を `InPageElementsResult` の形にし、`elements` に送信の
   * 要素を候補の順で入れ、`value` の `submitterElementIndexes` に候補ごとの `elements` の中の位置（送信の要素のない候補は null）を入れる。
   */
  readonly withSubmitterElements: boolean;
  /**
   * COV-6b-1: 返す候補の範囲（候補の順の位置 `start` から `size` 個。`null` は全部）。範囲の後ろに候補が残れば、結果の `more` を真にする（呼ぶ側が
   * `readInParts` で次の範囲を読む）。
   */
  readonly part: { readonly start: number; readonly size: number } | null;
}

/** ページの中で読んだ欄（検査の前）。 */
interface RawProbeField {
  readonly name: string;
  readonly tag: string;
  readonly type: string;
  readonly required: boolean;
  readonly readonly: boolean;
  readonly disabled: boolean;
  readonly hidden: boolean;
  readonly constraints: readonly (string | null)[];
  readonly options: readonly string[] | null;
  /** REV-RCA の I-3: 選択肢ごとの表示の文字（select は option の文字、checkbox と radio は label の文字。Node の側で削除の語の判定にだけ使い、捨てる）。 */
  readonly optionTexts?: readonly (readonly string[])[] | null;
  readonly omittedOptionCount: number;
  readonly hasValue: boolean;
}

/** ページの中で読んだ要素の位置と名前。 */
interface RawProbeElement {
  readonly path: readonly number[];
  readonly localName: string;
}

/** ページの中で読んだ候補（検査の前）。 */
interface RawProbeCandidate {
  readonly kind: string;
  readonly formMethod: string | null;
  readonly methodOverride: string | null;
  readonly action: string | null;
  readonly enctype: string | null;
  readonly target: string | null;
  readonly fields: readonly RawProbeField[];
  readonly submitterText: string | null;
  /** CALDAY fix round 1: 押す組の決めだけに使う文字（`submitterShapeTextOf`）。 */
  readonly submitterShapeText: string | null;
  readonly inlineHandler: boolean;
  readonly form: RawProbeElement | null;
  readonly submitter: RawProbeElement | null;
}

/** ページの中で読んだ結果（検査の前）。 */
interface RawProbeResult {
  readonly candidates: readonly RawProbeCandidate[];
  readonly frameFound: boolean;
  /** COV-6b-1: 読んだ範囲の後ろに、まだ候補があるか。 */
  readonly more: boolean;
}

/** LU-SFIX2-A: 送信の要素も返すときの、ページの中の結果（`readElementsInIsolatedWorld` が受ける形）。 */
interface RawProbeElementsResult {
  readonly value: RawProbeResult & { readonly submitterElementIndexes: readonly (number | null)[] };
  readonly elements: readonly Element[];
}

/**
 * ページの中で、form と、ボタンの候補（form の外のボタン、form の中の送信ボタンでないボタン）を読む（ページに何も書かない。操作しない）。この関数はページの中で動く（外の値を参照しない）。
 * 部品（`R`）は `composeInPage` で組み込む（`src/browser/in-page-readers.ts`。CC-068）。
 */
function discoveryProbeReader(R: StandardReaders, input: DiscoveryProbeInput): RawProbeResult | RawProbeElementsResult {
  // 標準の prototype の getter（部品の `standardGetter`。`src/browser/in-page-readers.ts`。CC-068）。
  const { standardGetter: getterOf } = R;
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const localNameOf = getterOf(Element.prototype, 'localName');
  const shadowRootOf = getterOf(Element.prototype, 'shadowRoot');
  const previousElementSiblingOf = getterOf(Element.prototype, 'previousElementSibling');
  const parentNodeOf = getterOf(Node.prototype, 'parentNode');
  const nodeTypeOf = getterOf(Node.prototype, 'nodeType');
  const textContentOf = getterOf(Node.prototype, 'textContent');
  const hostOf = getterOf(ShadowRoot.prototype, 'host');
  const documentElementOf = getterOf(Document.prototype, 'documentElement');
  const formMethodOf = getterOf(HTMLFormElement.prototype, 'method');
  const formActionOf = getterOf(HTMLFormElement.prototype, 'action');
  const formEnctypeOf = getterOf(HTMLFormElement.prototype, 'enctype');
  const formTargetOf = getterOf(HTMLFormElement.prototype, 'target');
  const formElementsOf = getterOf(HTMLFormElement.prototype, 'elements');
  const collectionLengthOf = getterOf(HTMLCollection.prototype, 'length');
  const inputTypeOf = getterOf(HTMLInputElement.prototype, 'type');
  const inputValueOf = getterOf(HTMLInputElement.prototype, 'value');
  const inputCheckedOf = getterOf(HTMLInputElement.prototype, 'checked');
  const inputFilesOf = getterOf(HTMLInputElement.prototype, 'files');
  const inputLabelsOf = getterOf(HTMLInputElement.prototype, 'labels');
  const nodeListLengthOf = getterOf(NodeList.prototype, 'length');
  const fileListLengthOf = getterOf(FileList.prototype, 'length');
  const selectTypeOf = getterOf(HTMLSelectElement.prototype, 'type');
  const selectOptionsOf = getterOf(HTMLSelectElement.prototype, 'options');
  const selectValueOf = getterOf(HTMLSelectElement.prototype, 'value');
  const textAreaValueOf = getterOf(HTMLTextAreaElement.prototype, 'value');
  const itemOf = (collection: unknown, index: number): Element | null =>
    HTMLCollection.prototype.item.call(collection as HTMLCollection, index);
  const lengthOf = (collection: unknown): number => {
    const length = collectionLengthOf(collection);
    return typeof length === 'number' ? length : 0;
  };
  const getAttribute = (element: Element, name: string): string | null => Element.prototype.getAttribute.call(element, name);
  const hasAttribute = (element: Element, name: string): boolean => Element.prototype.hasAttribute.call(element, name);
  const matches = (element: Element, selectors: string): boolean => Element.prototype.matches.call(element, selectors);
  const isVisible = (element: Element): boolean => {
    if (!Element.prototype.checkVisibility.call(element, input.visibilityOptions)) {
      return false;
    }
    const rect = Element.prototype.getBoundingClientRect.call(element);
    return rect.width > 0 && rect.height > 0;
  };
  const createElementWalker = (root: Node): TreeWalker => Document.prototype.createTreeWalker.call(document, root, input.showElement);
  const baseTarget = (): string => {
    const base = Document.prototype.querySelector.call(document, 'base[target]');
    return base === null ? '' : text(getAttribute(base, 'target'));
  };

  // 文書と open な shadow root の要素を集める（shadow root の中は、文書の後に、見つけた順に読む）。
  const elements: Element[] = [];
  const shadowRoots: Node[] = [];
  const collect = (root: Node, includeRoot: boolean): void => {
    const walker = createElementWalker(root);
    let node: Node | null = includeRoot ? root : walker.nextNode();
    // COV-6b-1（N26）: 走査する要素の数の上限はない（全部の要素を読む）。
    while (node !== null) {
      const element = node as Element;
      elements.push(element);
      const shadowRoot = shadowRootOf(element);
      if (shadowRoot !== null && shadowRoot !== undefined) {
        shadowRoots.push(shadowRoot as Node);
      }
      node = walker.nextNode();
    }
  };
  const documentElement = documentElementOf(document);
  if (documentElement !== null && documentElement !== undefined) {
    collect(documentElement as Node, true);
  }
  for (let index = 0; index < shadowRoots.length; index += 1) {
    const shadowRoot = shadowRoots[index];
    if (shadowRoot !== undefined) {
      collect(shadowRoot, false);
    }
  }

  // 要素の位置（文書の根からの、要素の子の中の番号。open な shadow root に入る所は印）。
  const pathOf = (element: Element): number[] => {
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
      if (parent === null || parent === undefined || nodeTypeOf(parent) === Node.DOCUMENT_NODE) {
        break;
      }
      if (nodeTypeOf(parent) === Node.DOCUMENT_FRAGMENT_NODE) {
        steps.push(input.shadowRootStep);
        const host = hostOf(parent);
        if (host === null || host === undefined) {
          break;
        }
        current = host as Node;
        continue;
      }
      current = parent as Node;
    }
    return steps.reverse();
  };
  const describe = (element: Element): RawProbeElement => ({ path: pathOf(element), localName: text(localNameOf(element)) });

  // form、送信ボタン、ボタンの候補（form の外のボタンと、form の中の送信ボタンでないボタン。T27b round 1）を分ける。
  let frameFound = false;
  const forms: Element[] = [];
  const submittersByForm = new Map<unknown, Element[]>();
  const buttonCandidates: Element[] = [];
  // SKIP-1: 候補の選び方は、点検の段の DOM の数え方と共通の部品（`discoveryCandidateElementOf`）。
  for (const element of elements) {
    if (input.frameElementNames.includes(text(localNameOf(element)))) {
      frameFound = true;
    }
    const found = R.discoveryCandidateElementOf(element, input.candidateElements);
    if (found === null) {
      continue;
    }
    if (found.kind === 'FORM') {
      forms.push(element);
    } else if (found.kind === 'BUTTON') {
      buttonCandidates.push(element);
    } else {
      const list = submittersByForm.get(found.form) ?? [];
      list.push(element);
      submittersByForm.set(found.form, list);
    }
  }

  const submitterPrototypeOf = (element: Element): object => (text(localNameOf(element)) === 'button'
    ? HTMLButtonElement.prototype
    : HTMLInputElement.prototype);
  const overrideOf = (submitter: Element | null, attribute: string, property: string): string | null =>
    submitter !== null && hasAttribute(submitter, attribute) ? text(getterOf(submitterPrototypeOf(submitter), property)(submitter)) : null;
  const submitterTextOf = (element: Element): string => {
    const name = text(localNameOf(element));
    const own = name === 'input'
      ? text(getAttribute(element, text(inputTypeOf(element)) === 'image' ? 'alt' : 'value'))
      : text(textContentOf(element));
    // LZ-3c: 文言は切らずに全部を読む（前は 1 つを 1,024・全体を 256 で切った）。押す時点の確かめ（`pressTimeFactsInPage`）と同じ決まり。
    const parts = [own, text(getAttribute(element, 'aria-label')), text(getAttribute(element, 'title'))]
      .map((part) => part.replace(/\s+/gu, ' ').trim())
      .filter((part, index, all) => part.length > 0 && all.indexOf(part) === index);
    return parts.join(' ');
  };
  /**
   * CALDAY fix round 1: 押す組の決めだけに使う文字（見える文字。空なら支援技術の名前 `aria-label`・`title`）。Node の側で数字を `{n}` にした型の digest にし、
   * 文字は持たない。
   */
  const submitterShapeTextOf = (element: Element): string => {
    const name = text(localNameOf(element));
    const own = (name === 'input'
      ? text(getAttribute(element, text(inputTypeOf(element)) === 'image' ? 'alt' : 'value'))
      : text(textContentOf(element))).replace(/\s+/gu, ' ').trim();
    if (own.length > 0) return own;
    return [text(getAttribute(element, 'aria-label')), text(getAttribute(element, 'title'))]
      .map((part) => part.replace(/\s+/gu, ' ').trim())
      .filter((part, index, all) => part.length > 0 && all.indexOf(part) === index)
      .join(' ');
  };

  // form の欄（form に属する入力の欄。送信ボタンとリセット・普通のボタンは含めない）と `_method` の値。
  const fieldsOf = (form: Element): { fields: RawProbeField[]; methodOverride: string | null } => {
    const controls = formElementsOf(form);
    const count = lengthOf(controls);
    const fields: RawProbeField[] = [];
    const overrideValues = new Set<string>();
    for (let index = 0; index < count; index += 1) {
      const element = itemOf(controls, index);
      if (element === null) {
        continue;
      }
      const tag = text(localNameOf(element));
      let type: string;
      if (tag === 'input') {
        type = text(inputTypeOf(element));
        if (input.candidateElements.buttonInputTypes.includes(type)) {
          continue;
        }
      } else if (tag === 'select') {
        type = text(selectTypeOf(element));
      } else if (tag === 'textarea') {
        type = 'textarea';
      } else {
        continue;
      }
      const name = text(getAttribute(element, 'name'));
      if (tag === 'input' && type === 'hidden' && name.toLowerCase() === input.methodOverrideFieldName) {
        overrideValues.add(text(inputValueOf(element)).trim().toUpperCase());
      }
      // L13（N28・N29）: 欄と選択肢は数で打ち切らない（前は 200 個目・50 個目の後を読まなかった。省いた選択肢の数の項目は 0 のまま。候補の識別に入るので残す）。
      let options: string[] | null = null;
      // REV-RCA の I-3: 選択肢ごとの表示の文字（Node の側で削除の語の判定にだけ使う）。
      let optionTexts: string[][] | null = null;
      const omittedOptionCount = 0;
      let hasValue: boolean;
      if (tag === 'select') {
        const optionElements = selectOptionsOf(element);
        const optionCount = lengthOf(optionElements);
        options = [];
        optionTexts = [];
        for (let optionIndex = 0; optionIndex < optionCount; optionIndex += 1) {
          const option = itemOf(optionElements, optionIndex);
          // LZ-2: 選択肢の値は切り詰めない（前は 256 文字まで）。
          options.push(option === null ? '' : text(getAttribute(option, 'value')));
          optionTexts.push(option === null ? [] : [text(textContentOf(option))]);
        }
        hasValue = text(selectValueOf(element)).length > 0;
      } else if (tag === 'textarea') {
        hasValue = text(textAreaValueOf(element)).length > 0;
      } else if (type === 'checkbox' || type === 'radio') {
        options = [getAttribute(element, 'value') ?? input.defaultCheckableValue];
        const labels = inputLabelsOf(element) as NodeList | null;
        const labelTexts: string[] = [];
        for (let labelIndex = 0; labels !== null && labelIndex < Number(nodeListLengthOf(labels)); labelIndex += 1) {
          labelTexts.push(text(textContentOf(NodeList.prototype.item.call(labels, labelIndex))));
        }
        optionTexts = [labelTexts];
        hasValue = inputCheckedOf(element) === true;
      } else if (type === 'file') {
        const files = inputFilesOf(element);
        hasValue = files !== null && Number(fileListLengthOf(files)) > 0;
      } else {
        hasValue = text(inputValueOf(element)).length > 0;
      }
      fields.push({
        // L13（N30）: 欄の名前は切り詰めない（前は 256 文字まで）。
        name,
        tag,
        type,
        required: hasAttribute(element, 'required'),
        readonly: hasAttribute(element, 'readonly'),
        disabled: matches(element, ':disabled'),
        hidden: type === 'hidden' || !isVisible(element),
        // LZ-2: 制約の属性の値は切り詰めない（前は 512 文字まで）。
        constraints: input.constraintNames.map((constraint) => getAttribute(element, constraint)),
        options,
        optionTexts,
        omittedOptionCount,
        hasValue,
      });
    }
    const [onlyValue] = [...overrideValues];
    const methodOverride = overrideValues.size === 1 && onlyValue !== undefined && input.methodOverrideValues.includes(onlyValue)
      ? onlyValue
      : null;
    return { fields, methodOverride };
  };

  const candidates: RawProbeCandidate[] = [];
  // LU-SFIX2-A: 送信の要素そのもの（候補の順）と、候補ごとの位置（`withSubmitterElements` のときだけ返す）。
  const submitterElements: Element[] = [];
  const submitterElementIndexes: (number | null)[] = [];
  // COV-6b-1（N27）: 候補の数の上限はない。返す範囲（`input.part`）の外の候補は数えるだけで、組み立てない（次の範囲の読み取りで組み立てる）。
  const part = input.part;
  let seen = 0;
  const inPart = (): boolean => {
    const position = seen;
    seen += 1;
    return part === null || (position >= part.start && position < part.start + part.size);
  };
  const pushCandidate = (build: () => RawProbeCandidate, submitterElement: Element | null): boolean => {
    if (!inPart()) {
      return true;
    }
    const candidate = build();
    candidates.push(candidate);
    if (submitterElement === null) {
      submitterElementIndexes.push(null);
    } else {
      submitterElementIndexes.push(submitterElements.length);
      submitterElements.push(submitterElement);
    }
    return true;
  };
  for (const form of forms) {
    const { fields, methodOverride } = fieldsOf(form);
    const submitters: (Element | null)[] = submittersByForm.get(form) ?? [null];
    for (const submitter of submitters) {
      const action = overrideOf(submitter, 'formaction', 'formAction') ?? text(formActionOf(form));
      const target = overrideOf(submitter, 'formtarget', 'formTarget')
        ?? (hasAttribute(form, 'target') ? text(formTargetOf(form)) : baseTarget());
      const pushed = pushCandidate(() => ({
        kind: 'FORM',
        formMethod: (overrideOf(submitter, 'formmethod', 'formMethod') ?? text(formMethodOf(form))).toUpperCase(),
        methodOverride,
        // URL-LEN: 送信先の URL と target は、ページの中でも切り詰めない。
        action,
        enctype: overrideOf(submitter, 'formenctype', 'formEnctype') ?? text(formEnctypeOf(form)),
        target,
        fields,
        submitterText: submitter === null ? null : submitterTextOf(submitter),
        submitterShapeText: submitter === null ? null : submitterShapeTextOf(submitter),
        inlineHandler: hasAttribute(form, 'onsubmit') || (submitter !== null && hasAttribute(submitter, 'onclick')),
        form: describe(form),
        submitter: submitter === null ? null : describe(submitter),
      }), submitter);
      if (!pushed) {
        break;
      }
    }
  }
  for (const button of buttonCandidates) {
    const pushed = pushCandidate(() => ({
      kind: 'BUTTON',
      formMethod: null,
      methodOverride: null,
      action: null,
      enctype: null,
      target: null,
      fields: [],
      submitterText: submitterTextOf(button),
      submitterShapeText: submitterShapeTextOf(button),
      inlineHandler: hasAttribute(button, 'onclick'),
      form: null,
      submitter: describe(button),
    }), button);
    if (!pushed) {
      break;
    }
  }
  const more = part !== null && seen > part.start + part.size;
  if (input.withSubmitterElements) {
    return { value: { candidates, frameFound, more, submitterElementIndexes }, elements: submitterElements };
  }
  return { candidates, frameFound, more };
}
const discoveryProbeInPage = composeInPage(discoveryProbeReader);

/** probe の入力（本番の値）。 */
const DISCOVERY_PROBE_INPUT: DiscoveryProbeInput = Object.freeze({
  visibilityOptions: VISIBILITY_CHECK_OPTIONS,
  showElement: NODE_FILTER_SHOW_ELEMENT,
  shadowRootStep: SHADOW_ROOT_STEP,
  constraintNames: FIELD_CONSTRAINT_NAMES,
  frameElementNames: FRAME_ELEMENT_NAMES,
  candidateElements: DISCOVERY_CANDIDATE_ELEMENT_CRITERIA,
  defaultCheckableValue: DEFAULT_CHECKABLE_VALUE,
  methodOverrideFieldName: METHOD_OVERRIDE_FIELD_NAME,
  methodOverrideValues: METHOD_OVERRIDE_VALUES,
  withSubmitterElements: false,
  part: null,
});

// ---------------------------------------------------------------------------------------------------------------
// Node の側の検査と、契約の形への変換（ページの中の結果は信じずに形を見る）
// ---------------------------------------------------------------------------------------------------------------

/** 要素の位置と名前（`listeners.ts` が CDP で同じ要素を探すために使う）。 */
export interface ProbedElement {
  readonly path: readonly number[];
  readonly localName: string;
}

/** probe で読んだ候補（契約の形の部分と、JS の結び付きを読むための要素）。 */
export interface ProbedCandidate {
  readonly kind: CandidateKind;
  readonly formMethod: FormMethod | null;
  readonly methodOverride: MethodOverride | null;
  readonly action: CandidateAction | null;
  readonly enctype: FormEnctype | null;
  readonly target: string | null;
  readonly fields: readonly CandidateField[];
  /** 送信ボタンの語（文言から `submitterWordsOf` で求めた語。文言は持たない）。 */
  readonly submitterWords: readonly string[];
  /**
   * DEF-142: 送信ボタンの文言（ボタンの文字・`aria-label`・`title`）が空白を除いて空でないか（文言は持たない）。送らずに観察する probe の押す順だけが
   * 使う（候補の契約・識別の digest・成果物には入れない）。送信ボタンのない form は false。
   */
  readonly hasSubmitterText: boolean;
  /**
   * T44c（設計者の判断）: 送信ボタンの文言に、送信の語（「送信」「確定」「submit」。`submitterTextHasSubmitWord`）があるか（文言は持たない）。送らずに観察する
   * probe の押す順だけが使う（候補の契約・識別の digest・成果物には入れない）。送信ボタンのない form は false。
   */
  readonly hasSubmitWord: boolean;
  /**
   * CALDAY fix round 1（設計者の判断 1）: 送信ボタンの文字の型の digest（`submitterTextShapeOf`。見える文字、空なら支援技術の名前の、数字を `{n}` にした型）。
   * 送らずに観察する probe の押す組の決めだけが使う（候補の契約・識別の digest・成果物には入れない。`hasSubmitWord` と同じ扱い）。省略は読んでいない。
   */
  readonly submitterTextShape?: string;
  /** inline の処理（form の `onsubmit`、送信ボタンの `onclick` の属性）があるか。 */
  readonly inlineHandler: boolean;
  /** form（`BUTTON` は null）。 */
  readonly form: ProbedElement | null;
  /** 送信ボタン（`BUTTON` は、その要素。送信ボタンのない form は null）。 */
  readonly submitter: ProbedElement | null;
}

/** probe の結果。`FAILED` は、読めなかった（時間の上限、ページの移動、形の誤りなど）。 */
export type PageProbeOutcome =
  | {
    readonly status: 'READ';
    readonly candidates: readonly ProbedCandidate[];
    /** iframe などの別の文書の要素があった。 */
    readonly frameFound: boolean;
  }
  | { readonly status: 'FAILED' };

const PROBE_FAILED: PageProbeOutcome = Object.freeze({ status: 'FAILED' });

/** 形の誤り（ページの中の結果が、期待の形でない）。 */
class ProbeShapeError extends Error {}

const requireString = (value: unknown): string => {
  if (typeof value !== 'string') throw new ProbeShapeError();
  return value;
};
const requireNullableString = (value: unknown): string | null => (value === null ? null : requireString(value));
const requireBoolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new ProbeShapeError();
  return value;
};
const requireOneOf = <T extends string>(values: readonly T[], value: unknown): T => {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw new ProbeShapeError();
  return found;
};
const requireArray = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) throw new ProbeShapeError();
  return value;
};
const requireRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new ProbeShapeError();
  return value;
};

/**
 * URL の Origin と path（http(s) でない、解析できない URL は、決まらない Origin）。URL-LEN: 長さでは切り詰めない（前は 2,048 で切り詰め、`truncated` を立てた）。
 */
export const locationOfUrl = (raw: string): { readonly location: CandidateLocation; readonly url: URL | null } => {
  const url = URL.canParse(raw) ? new URL(raw) : null;
  if (url === null || !isHttpProtocol(url.protocol)) {
    return { location: { origin: OPAQUE_ORIGIN, path: ROOT_PATH }, url: null };
  }
  return { location: { origin: url.origin, path: url.pathname }, url };
};

/** 送信先（query は名前だけ。値は持たない）。URL-LEN・L13（N30）: URL も query の名前の数と長さも切り詰めない。 */
const actionOf = (raw: string): CandidateAction => {
  const { location, url } = locationOfUrl(raw);
  return { ...location, queryNames: url === null ? [] : [...url.searchParams.keys()] };
};

const fieldOf = (value: unknown): CandidateField => {
  const raw = requireRecord(value);
  const constraintValues = requireArray(raw['constraints']);
  if (constraintValues.length !== FIELD_CONSTRAINT_NAMES.length) throw new ProbeShapeError();
  const constraints = Object.fromEntries(FIELD_CONSTRAINT_NAMES.map((name, index) => [
    name,
    requireNullableString(constraintValues[index]),
  ])) as CandidateFieldConstraints;
  // L13（N29・N30）: 選択肢の数と欄の名前の長さで切らない。
  const options = raw['options'] === null
    ? null
    : requireArray(raw['options']).map((option) => requireString(option));
  const omittedOptionCount = raw['omittedOptionCount'];
  if (!isNonNegativeSafeInteger(omittedOptionCount)) throw new ProbeShapeError();
  // REV-RCA の I-3: 値か表示の文字が削除の語に当たる選択肢の位置（判定は操作さがしの選び方 REV-SD の I-4 (a) と同じ `textsHaveDestructiveActionWord`）。文字は捨てる。
  const optionTexts = raw['optionTexts'] === null || raw['optionTexts'] === undefined ? [] : requireArray(raw['optionTexts']);
  const destructiveOptionIndexes = (options ?? []).flatMap((option, index) => {
    const texts = optionTexts[index] === undefined ? [] : requireArray(optionTexts[index]).map((entry) => requireString(entry));
    return textsHaveDestructiveActionWord([option, ...texts]) ? [index] : [];
  });
  return {
    name: requireString(raw['name']),
    tag: requireOneOf<CandidateFieldTag>(CANDIDATE_FIELD_TAGS, raw['tag']),
    type: requireOneOf<CandidateFieldType>(CANDIDATE_FIELD_TYPES, raw['type']),
    required: requireBoolean(raw['required']),
    readonly: requireBoolean(raw['readonly']),
    disabled: requireBoolean(raw['disabled']),
    hidden: requireBoolean(raw['hidden']),
    constraints,
    options,
    omittedOptionCount,
    hasValue: requireBoolean(raw['hasValue']),
    ...(destructiveOptionIndexes.length === 0 ? {} : { destructiveOptionIndexes }),
  };
};

const elementOf = (value: unknown): ProbedElement | null => {
  if (value === null) {
    return null;
  }
  const raw = requireRecord(value);
  const path = requireArray(raw['path']).map((step) => {
    if (step !== SHADOW_ROOT_STEP && !isNonNegativeSafeInteger(step)) throw new ProbeShapeError();
    return step as number;
  });
  return { path, localName: requireString(raw['localName']) };
};

/** CALDAY fix round 1: 文字の型の digest の入力の形の印（版つき）。 */
const SUBMITTER_TEXT_SHAPE_FORMAT = 'beaksight-probe-submitter-text-shape/1';

/**
 * CALDAY fix round 1（設計者の判断 1）: 押す組の決めだけに使う、送信ボタンの文字の型の digest（数字の並びを `{n}` にした型。`digitTemplateOf`）。文字がない
 * （送信ボタンのない form）は空の文字と同じ型。
 */
export const submitterTextShapeOf = (shapeText: string | null): string =>
  createSha256Fingerprint(JSON.stringify([SUBMITTER_TEXT_SHAPE_FORMAT, digitTemplateOf(normalizeWhitespace(shapeText ?? ''))]));

const candidateOf = (value: unknown): ProbedCandidate => {
  const raw = requireRecord(value);
  const kind = requireOneOf<CandidateKind>(['FORM', 'BUTTON'], raw['kind']);
  const submitterText = requireNullableString(raw['submitterText']);
  const common = {
    // T27R-fix-1（DEF-086）: 文言は、分類の語を求めるためだけに使い、持たない。LZ-3c: 文言は切らずに全部から求める（押す時点の確かめと同じ）。
    submitterWords: submitterText === null ? Object.freeze([]) : submitterWordsOf(normalizeWhitespace(submitterText)),
    hasSubmitterText: submitterText !== null && normalizeWhitespace(submitterText).length > 0,
    // T44c: 押す順だけの送信の語の印（文言は持たない）。
    hasSubmitWord: submitterText !== null && submitterTextHasSubmitWord(normalizeWhitespace(submitterText)),
    // CALDAY fix round 1: 押す組の決めだけの文字の型（文字は持たない）。
    submitterTextShape: submitterTextShapeOf(raw['submitterShapeText'] === undefined ? null : requireNullableString(raw['submitterShapeText'])),
    inlineHandler: requireBoolean(raw['inlineHandler']),
    submitter: elementOf(raw['submitter']),
  };
  if (kind === 'BUTTON') {
    return { kind, formMethod: null, methodOverride: null, action: null, enctype: null, target: null, fields: [], ...common, form: null };
  }
  const methodOverride = raw['methodOverride'] === null ? null : requireOneOf<MethodOverride>(METHOD_OVERRIDE_VALUES, raw['methodOverride']);
  return {
    kind,
    formMethod: requireOneOf<FormMethod>(FORM_METHODS, raw['formMethod']),
    methodOverride,
    action: actionOf(requireString(raw['action'])),
    enctype: requireOneOf<FormEnctype>(FORM_ENCTYPES, raw['enctype']),
    // URL-LEN: form の target は切り詰めない（前は 256）。
    target: requireString(raw['target']),
    // L13（N28）: 欄は数で切らない（前は 200 個まで）。
    fields: requireArray(raw['fields']).map(fieldOf),
    ...common,
    form: elementOf(raw['form']),
  };
};

/**
 * 画面の候補を、isolated world の 1 回の読み取り（`readInIsolatedWorld`）で読む（例外を投げない）。`deadlineAtMs` までに読めなければ（古い
 * world、例外の詳細などを含む）`FAILED`。
 */
export async function probePageCandidates(page: Page, deadlineAtMs: number): Promise<PageProbeOutcome> {
  // COV-6b-1（N27）: 候補を `PAGE_CANDIDATE_PART_SIZE` ずつ分けて読み（`readInParts`）、全部を記録する。どれかの部分を読めなければ、読めなかった結果。
  try {
    const parts = await readInParts(0, async (start) => {
      const outcome = await readInIsolatedWorld(page, discoveryProbeInPage, {
        ...DISCOVERY_PROBE_INPUT, part: { start, size: PAGE_CANDIDATE_PART_SIZE },
      }, deadlineAtMs);
      if (outcome.status !== 'READ') {
        throw new ProbeShapeError();
      }
      const read = probeOutcomeOf(outcome.value);
      return { part: read, next: requireBoolean(requireRecord(outcome.value)['more']) ? start + PAGE_CANDIDATE_PART_SIZE : null };
    });
    return Object.freeze({
      status: 'READ',
      candidates: Object.freeze(parts.flatMap(({ candidates }) => candidates)),
      frameFound: parts.some(({ frameFound }) => frameFound),
    });
  } catch {
    return PROBE_FAILED;
  }
}

/** ページの中の結果を、probe の結果にする（形が違えば `ProbeShapeError`）。 */
const probeOutcomeOf = (value: unknown): Extract<PageProbeOutcome, { readonly status: 'READ' }> => {
  const raw = requireRecord(value);
  return Object.freeze({
    status: 'READ',
    candidates: requireArray(raw['candidates']).map(candidateOf),
    frameFound: requireBoolean(raw['frameFound']),
  });
};

/** LU-SFIX2-A: 選んだ候補の送信の要素の参照（候補の位置と、同じ読み取りの要素の backendNodeId・文書の根からの位置）。 */
export interface ProbedSubmitterElement {
  readonly candidateIndex: number;
  readonly element: IsolatedElementReference;
}

/** LU-SFIX2-A: 送信の要素の参照も返す probe の結果。 */
export type PageProbeWithSubmittersOutcome =
  | (Extract<PageProbeOutcome, { readonly status: 'READ' }> & { readonly chosen: readonly ProbedSubmitterElement[] })
  | { readonly status: 'FAILED' };

/**
 * LU-SFIX2-A（LU-SREV2 の Critical-1・Minor-1）: 画面の候補を、isolated world の 1 回の読み取りで読み（`probePageCandidates` と同じ読み方と同じ候補）、
 * `choose` が選んだ候補（候補の位置。送信の要素のある候補だけ）の送信の要素の参照を、同じ読み取りの要素そのものから返す（例外を投げない）。確かめた候補の
 * 要素と、参照の要素の間に、ページの JS が要素を入れ替える窓がない（位置で引き直さない）。読めない・形の誤り・`choose` が null か、送信の要素のない候補を
 * 選んだときは `FAILED`。
 */
export async function probePageCandidatesWithSubmitters(
  page: Page,
  deadlineAtMs: number,
  choose: (candidates: readonly ProbedCandidate[]) => readonly number[] | null,
): Promise<PageProbeWithSubmittersOutcome> {
  const state: { probe: Extract<PageProbeOutcome, { readonly status: 'READ' }> | null; candidateIndexes: readonly number[] } = { probe: null, candidateIndexes: [] };
  const outcome = await readElementsInIsolatedWorld(page, discoveryProbeInPage as (input: DiscoveryProbeInput) => InPageElementsResult, {
    ...DISCOVERY_PROBE_INPUT,
    withSubmitterElements: true,
  }, deadlineAtMs, {
    choose: (value) => {
      try {
        const probe = probeOutcomeOf(value);
        const indexes = requireArray(requireRecord(value)['submitterElementIndexes']);
        if (indexes.length !== probe.candidates.length) {
          return null;
        }
        const candidateIndexes = choose(probe.candidates);
        if (candidateIndexes === null) {
          return null;
        }
        const elementIndexes = candidateIndexes.map((candidateIndex) => indexes[candidateIndex]);
        if (!elementIndexes.every(isNonNegativeSafeInteger)) {
          return null;
        }
        state.probe = probe;
        state.candidateIndexes = candidateIndexes;
        return elementIndexes;
      } catch {
        return null;
      }
    },
  });
  const { probe, candidateIndexes } = state;
  if (outcome.status !== 'READ' || probe === null || outcome.elements.length !== candidateIndexes.length) {
    return Object.freeze({ status: 'FAILED' });
  }
  const chosen = candidateIndexes.map((candidateIndex, index) => Object.freeze({ candidateIndex, element: outcome.elements[index] as IsolatedElementReference }));
  return Object.freeze({ ...probe, chosen: Object.freeze(chosen) });
}

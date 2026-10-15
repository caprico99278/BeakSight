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
// - 上限: 走査する要素の数（`MAX_DISCOVERY_ELEMENTS`）、画面の候補の数（`MAX_PAGE_CANDIDATES`）、候補の欄の数（`MAX_CANDIDATE_FIELDS`）、
//   選択肢の数（`MAX_SELECT_OPTION_VALUES`。超えた分は件数）、文字列の長さ（契約の名前つきの定数）。上限で読み切れなかったら `limitReached`
//   （呼ぶ側が `INCOMPLETE_LIMIT_REACHED` にする）。
// - 要素の位置（`path`）: 文書の根からの、要素の子の中の番号の並び。open な shadow root に入る所は `SHADOW_ROOT_STEP`。JS の結び付きを CDP で
//   読むときに、同じ要素を探すために使う（`listeners.ts`）。
import type { Page } from 'playwright';
import { isNonNegativeSafeInteger, isRecord } from '../core/guards.js';
import { MAX_URL_LENGTH } from '../core/limits.js';
import { normalizeWhitespace } from '../core/text.js';
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';
import { isHttpProtocol } from '../crawl/normalize-url.js';
import {
  CANDIDATE_FIELD_TAGS,
  CANDIDATE_FIELD_TYPES,
  FIELD_CONSTRAINT_NAMES,
  FORM_ENCTYPES,
  FORM_METHODS,
  MAX_ACTION_QUERY_NAMES,
  MAX_CANDIDATE_FIELDS,
  MAX_CANDIDATE_URL_PART_LENGTH,
  MAX_CONSTRAINT_VALUE_LENGTH,
  MAX_FIELD_NAME_LENGTH,
  MAX_FORM_TARGET_LENGTH,
  MAX_OPTION_VALUE_LENGTH,
  MAX_SELECT_OPTION_VALUES,
  MAX_SUBMITTER_TEXT_LENGTH,
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
import { submitterWordsOf } from './classify.js';
import { readInIsolatedWorld } from './isolated-read.js';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';

/** 1 つの画面で走査する要素の数の上限（文書と open な shadow root の要素の合計）。 */
export const MAX_DISCOVERY_ELEMENTS = 100_000;
/** 1 つの画面の候補の数の上限。 */
export const MAX_PAGE_CANDIDATES = 500;
/** 送信先の URL を、ページの中で読む長さの倍率（Origin と path の上限に対して。解析の前に、上限より長く読んでおく）。 */
export const ACTION_URL_READ_FACTOR = 4;
/** 送信ボタンの文字を、空白をまとめる前に読む長さの倍率（文言の上限に対して）。 */
export const SUBMITTER_TEXT_READ_FACTOR = 4;
/** 要素の位置の、open な shadow root に入る所の印（要素の番号は 0 以上なので、負の数にする）。 */
export const SHADOW_ROOT_STEP = -1;
/** 別の文書を持ちうる要素の名前（あれば、その画面を `INCOMPLETE_FRAME_OR_CLOSED_SHADOW` にする）。 */
export const FRAME_ELEMENT_NAMES = Object.freeze(['iframe', 'frame', 'frameset', 'object', 'embed', 'fencedframe', 'portal'] as const);
/** ボタンの候補として読む `input` の `type`（ボタンの形。送信の形は、form に属すれば送信ボタン、属さなければボタンの候補）。 */
const BUTTON_INPUT_TYPES = Object.freeze(['submit', 'image', 'button', 'reset'] as const);
/** 送信ボタンになる `input` の `type`。 */
const SUBMIT_INPUT_TYPES = Object.freeze(['submit', 'image'] as const);
/** checkbox と radio の `value` の属性がないときの値（HTML の既定）。 */
const DEFAULT_CHECKABLE_VALUE = 'on';
/** `NodeFilter.SHOW_ELEMENT` の値（ページの中の `NodeFilter` を読まずに渡す）。 */
const NODE_FILTER_SHOW_ELEMENT = 1;
/** 送信先の URL の、Origin が決まらない（http(s) でない、解析できない）ときの Origin と path。許可 Origin の外に分類される。 */
const OPAQUE_ORIGIN = 'null';
const ROOT_PATH = '/';

/** probe の上限（ページの中に渡す）。 */
interface DiscoveryProbeLimits {
  readonly maxElements: number;
  readonly maxCandidates: number;
  readonly maxFields: number;
  readonly maxOptions: number;
  readonly maxOptionLength: number;
  readonly maxFieldNameLength: number;
  readonly maxConstraintLength: number;
  readonly maxSubmitterTextLength: number;
  readonly submitterTextReadLength: number;
  readonly maxTargetLength: number;
  readonly maxActionUrlLength: number;
}

/** probe の入力（ページの中の関数は外を参照できないので、値はすべてここで渡す）。 */
interface DiscoveryProbeInput {
  readonly limits: DiscoveryProbeLimits;
  readonly visibilityOptions: CheckVisibilityOptions;
  readonly showElement: number;
  readonly shadowRootStep: number;
  readonly constraintNames: readonly string[];
  readonly frameElementNames: readonly string[];
  readonly buttonInputTypes: readonly string[];
  readonly submitInputTypes: readonly string[];
  readonly defaultCheckableValue: string;
  readonly methodOverrideFieldName: string;
  readonly methodOverrideValues: readonly string[];
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
  readonly actionTruncated: boolean;
  readonly enctype: string | null;
  readonly target: string | null;
  readonly fields: readonly RawProbeField[];
  readonly submitterText: string | null;
  readonly inlineHandler: boolean;
  readonly form: RawProbeElement | null;
  readonly submitter: RawProbeElement | null;
}

/** ページの中で読んだ結果（検査の前）。 */
interface RawProbeResult {
  readonly candidates: readonly RawProbeCandidate[];
  readonly frameFound: boolean;
  readonly limitReached: boolean;
}

/**
 * ページの中で、form と、ボタンの候補（form の外のボタン、form の中の送信ボタンでないボタン）を読む（ページに何も書かない。操作しない）。この関数はページの中で動く（外の値を参照しない）。
 * 部品（`R`）は `composeInPage` で組み込む（`src/browser/in-page-readers.ts`。CC-068）。
 */
function discoveryProbeReader(R: StandardReaders, input: DiscoveryProbeInput): RawProbeResult {
  const { limits } = input;
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
  const inputFormOf = getterOf(HTMLInputElement.prototype, 'form');
  const fileListLengthOf = getterOf(FileList.prototype, 'length');
  const buttonTypeOf = getterOf(HTMLButtonElement.prototype, 'type');
  const buttonFormOf = getterOf(HTMLButtonElement.prototype, 'form');
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
  let limitReached = false;
  const shadowRoots: Node[] = [];
  const collect = (root: Node, includeRoot: boolean): void => {
    const walker = createElementWalker(root);
    let node: Node | null = includeRoot ? root : walker.nextNode();
    while (node !== null) {
      if (elements.length >= limits.maxElements) {
        limitReached = true;
        return;
      }
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
  for (let index = 0; index < shadowRoots.length && !limitReached; index += 1) {
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
  for (const element of elements) {
    const name = text(localNameOf(element));
    if (input.frameElementNames.includes(name)) {
      frameFound = true;
    }
    if (name === 'form') {
      forms.push(element);
      continue;
    }
    let owner: unknown = null;
    let submitter = false;
    if (name === 'button') {
      owner = buttonFormOf(element);
      submitter = text(buttonTypeOf(element)) === 'submit';
    } else if (name === 'input') {
      const type = text(inputTypeOf(element));
      if (!input.buttonInputTypes.includes(type)) {
        continue;
      }
      owner = inputFormOf(element);
      submitter = input.submitInputTypes.includes(type);
    } else if (text(getAttribute(element, 'role')).trim().toLowerCase().split(/\s+/u)[0] === 'button') {
      // `role=button` の要素は送信ボタンにならないので、form の中でも外でもボタンの候補にする。
    } else {
      continue;
    }
    if (owner === null || !submitter) {
      buttonCandidates.push(element);
    } else {
      const list = submittersByForm.get(owner) ?? [];
      list.push(element);
      submittersByForm.set(owner, list);
    }
  }

  const submitterPrototypeOf = (element: Element): object => (text(localNameOf(element)) === 'button'
    ? HTMLButtonElement.prototype
    : HTMLInputElement.prototype);
  const overrideOf = (submitter: Element | null, attribute: string, property: string): string | null =>
    submitter !== null && hasAttribute(submitter, attribute) ? text(getterOf(submitterPrototypeOf(submitter), property)(submitter)) : null;
  const bounded = (value: string | null, maxLength: number): string | null => (value === null ? null : value.slice(0, maxLength));
  const submitterTextOf = (element: Element): string => {
    const name = text(localNameOf(element));
    const own = name === 'input'
      ? text(getAttribute(element, text(inputTypeOf(element)) === 'image' ? 'alt' : 'value'))
      : text(textContentOf(element));
    const parts = [own, text(getAttribute(element, 'aria-label')), text(getAttribute(element, 'title'))]
      .map((part) => part.slice(0, limits.submitterTextReadLength).replace(/\s+/gu, ' ').trim())
      .filter((part, index, all) => part.length > 0 && all.indexOf(part) === index);
    return parts.join(' ').slice(0, limits.maxSubmitterTextLength);
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
        if (input.buttonInputTypes.includes(type)) {
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
      if (fields.length >= limits.maxFields) {
        limitReached = true;
        continue;
      }
      let options: string[] | null = null;
      let omittedOptionCount = 0;
      let hasValue: boolean;
      if (tag === 'select') {
        const optionElements = selectOptionsOf(element);
        const optionCount = lengthOf(optionElements);
        options = [];
        for (let optionIndex = 0; optionIndex < Math.min(optionCount, limits.maxOptions); optionIndex += 1) {
          const option = itemOf(optionElements, optionIndex);
          options.push(option === null ? '' : text(getAttribute(option, 'value')).slice(0, limits.maxOptionLength));
        }
        omittedOptionCount = Math.max(0, optionCount - limits.maxOptions);
        hasValue = text(selectValueOf(element)).length > 0;
      } else if (tag === 'textarea') {
        hasValue = text(textAreaValueOf(element)).length > 0;
      } else if (type === 'checkbox' || type === 'radio') {
        options = [(getAttribute(element, 'value') ?? input.defaultCheckableValue).slice(0, limits.maxOptionLength)];
        hasValue = inputCheckedOf(element) === true;
      } else if (type === 'file') {
        const files = inputFilesOf(element);
        hasValue = files !== null && Number(fileListLengthOf(files)) > 0;
      } else {
        hasValue = text(inputValueOf(element)).length > 0;
      }
      fields.push({
        name: name.slice(0, limits.maxFieldNameLength),
        tag,
        type,
        required: hasAttribute(element, 'required'),
        readonly: hasAttribute(element, 'readonly'),
        disabled: matches(element, ':disabled'),
        hidden: type === 'hidden' || !isVisible(element),
        constraints: input.constraintNames.map((constraint) => bounded(getAttribute(element, constraint), limits.maxConstraintLength)),
        options,
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
  const pushCandidate = (candidate: RawProbeCandidate): boolean => {
    if (candidates.length >= limits.maxCandidates) {
      limitReached = true;
      return false;
    }
    candidates.push(candidate);
    return true;
  };
  for (const form of forms) {
    const { fields, methodOverride } = fieldsOf(form);
    const submitters: (Element | null)[] = submittersByForm.get(form) ?? [null];
    for (const submitter of submitters) {
      const action = overrideOf(submitter, 'formaction', 'formAction') ?? text(formActionOf(form));
      const target = overrideOf(submitter, 'formtarget', 'formTarget')
        ?? (hasAttribute(form, 'target') ? text(formTargetOf(form)) : baseTarget());
      const pushed = pushCandidate({
        kind: 'FORM',
        formMethod: (overrideOf(submitter, 'formmethod', 'formMethod') ?? text(formMethodOf(form))).toUpperCase(),
        methodOverride,
        action: action.slice(0, limits.maxActionUrlLength),
        actionTruncated: action.length > limits.maxActionUrlLength,
        enctype: overrideOf(submitter, 'formenctype', 'formEnctype') ?? text(formEnctypeOf(form)),
        target: target.slice(0, limits.maxTargetLength),
        fields,
        submitterText: submitter === null ? null : submitterTextOf(submitter),
        inlineHandler: hasAttribute(form, 'onsubmit') || (submitter !== null && hasAttribute(submitter, 'onclick')),
        form: describe(form),
        submitter: submitter === null ? null : describe(submitter),
      });
      if (!pushed) {
        break;
      }
    }
  }
  for (const button of buttonCandidates) {
    const pushed = pushCandidate({
      kind: 'BUTTON',
      formMethod: null,
      methodOverride: null,
      action: null,
      actionTruncated: false,
      enctype: null,
      target: null,
      fields: [],
      submitterText: submitterTextOf(button),
      inlineHandler: hasAttribute(button, 'onclick'),
      form: null,
      submitter: describe(button),
    });
    if (!pushed) {
      break;
    }
  }
  return { candidates, frameFound, limitReached };
}
const discoveryProbeInPage = composeInPage(discoveryProbeReader);

/** probe の入力（本番の値）。 */
const DISCOVERY_PROBE_INPUT: DiscoveryProbeInput = Object.freeze({
  limits: Object.freeze({
    maxElements: MAX_DISCOVERY_ELEMENTS,
    maxCandidates: MAX_PAGE_CANDIDATES,
    maxFields: MAX_CANDIDATE_FIELDS,
    maxOptions: MAX_SELECT_OPTION_VALUES,
    maxOptionLength: MAX_OPTION_VALUE_LENGTH,
    maxFieldNameLength: MAX_FIELD_NAME_LENGTH,
    maxConstraintLength: MAX_CONSTRAINT_VALUE_LENGTH,
    maxSubmitterTextLength: MAX_SUBMITTER_TEXT_LENGTH,
    submitterTextReadLength: MAX_SUBMITTER_TEXT_LENGTH * SUBMITTER_TEXT_READ_FACTOR,
    maxTargetLength: MAX_FORM_TARGET_LENGTH,
    maxActionUrlLength: MAX_CANDIDATE_URL_PART_LENGTH * ACTION_URL_READ_FACTOR,
  }),
  visibilityOptions: VISIBILITY_CHECK_OPTIONS,
  showElement: NODE_FILTER_SHOW_ELEMENT,
  shadowRootStep: SHADOW_ROOT_STEP,
  constraintNames: FIELD_CONSTRAINT_NAMES,
  frameElementNames: FRAME_ELEMENT_NAMES,
  buttonInputTypes: BUTTON_INPUT_TYPES,
  submitInputTypes: SUBMIT_INPUT_TYPES,
  defaultCheckableValue: DEFAULT_CHECKABLE_VALUE,
  methodOverrideFieldName: METHOD_OVERRIDE_FIELD_NAME,
  methodOverrideValues: METHOD_OVERRIDE_VALUES,
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
    /** 上限で読み切れなかった。 */
    readonly limitReached: boolean;
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

/** URL の Origin と path（http(s) でない、解析できない URL は、決まらない Origin）。上限を超えたら切り詰め、`truncated` を立てる。 */
export const locationOfUrl = (raw: string): { readonly location: CandidateLocation; readonly url: URL | null; readonly truncated: boolean } => {
  const url = URL.canParse(raw) ? new URL(raw) : null;
  if (url === null || !isHttpProtocol(url.protocol)) {
    return { location: { origin: OPAQUE_ORIGIN, path: ROOT_PATH }, url: null, truncated: false };
  }
  const { origin, pathname } = url;
  return {
    location: { origin: origin.slice(0, MAX_CANDIDATE_URL_PART_LENGTH), path: pathname.slice(0, MAX_CANDIDATE_URL_PART_LENGTH) },
    url,
    truncated: origin.length > MAX_CANDIDATE_URL_PART_LENGTH || pathname.length > MAX_CANDIDATE_URL_PART_LENGTH,
  };
};

/** 送信先（query は名前だけ。値は持たない）。 */
const actionOf = (raw: string, readTruncated: boolean): { readonly action: CandidateAction; readonly truncated: boolean } => {
  const { location, url, truncated } = locationOfUrl(raw);
  const allNames = url === null ? [] : [...url.searchParams.keys()];
  const queryNames = allNames.slice(0, MAX_ACTION_QUERY_NAMES).map((name) => name.slice(0, MAX_FIELD_NAME_LENGTH));
  return {
    action: { ...location, queryNames },
    truncated: readTruncated || truncated || allNames.length > MAX_ACTION_QUERY_NAMES
      || allNames.some((name) => name.length > MAX_FIELD_NAME_LENGTH),
  };
};

const fieldOf = (value: unknown): CandidateField => {
  const raw = requireRecord(value);
  const constraintValues = requireArray(raw['constraints']);
  if (constraintValues.length !== FIELD_CONSTRAINT_NAMES.length) throw new ProbeShapeError();
  const constraints = Object.fromEntries(FIELD_CONSTRAINT_NAMES.map((name, index) => [
    name,
    requireNullableString(constraintValues[index])?.slice(0, MAX_CONSTRAINT_VALUE_LENGTH) ?? null,
  ])) as CandidateFieldConstraints;
  const options = raw['options'] === null
    ? null
    : requireArray(raw['options']).slice(0, MAX_SELECT_OPTION_VALUES).map((option) => requireString(option).slice(0, MAX_OPTION_VALUE_LENGTH));
  const omittedOptionCount = raw['omittedOptionCount'];
  if (!isNonNegativeSafeInteger(omittedOptionCount)) throw new ProbeShapeError();
  return {
    name: requireString(raw['name']).slice(0, MAX_FIELD_NAME_LENGTH),
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

const candidateOf = (value: unknown): { readonly candidate: ProbedCandidate; readonly truncated: boolean } => {
  const raw = requireRecord(value);
  const kind = requireOneOf<CandidateKind>(['FORM', 'BUTTON'], raw['kind']);
  const submitterText = requireNullableString(raw['submitterText']);
  const common = {
    // T27R-fix-1（DEF-086）: 文言は、分類の語を求めるためだけに使い、持たない。
    submitterWords: submitterText === null ? Object.freeze([]) : submitterWordsOf(normalizeWhitespace(submitterText).slice(0, MAX_SUBMITTER_TEXT_LENGTH)),
    inlineHandler: requireBoolean(raw['inlineHandler']),
    submitter: elementOf(raw['submitter']),
  };
  if (kind === 'BUTTON') {
    return {
      candidate: {
        kind, formMethod: null, methodOverride: null, action: null, enctype: null, target: null, fields: [], ...common, form: null,
      },
      truncated: false,
    };
  }
  const allFields = requireArray(raw['fields']);
  const { action, truncated } = actionOf(requireString(raw['action']), requireBoolean(raw['actionTruncated']));
  const methodOverride = raw['methodOverride'] === null ? null : requireOneOf<MethodOverride>(METHOD_OVERRIDE_VALUES, raw['methodOverride']);
  return {
    candidate: {
      kind,
      formMethod: requireOneOf<FormMethod>(FORM_METHODS, raw['formMethod']),
      methodOverride,
      action,
      enctype: requireOneOf<FormEnctype>(FORM_ENCTYPES, raw['enctype']),
      target: requireString(raw['target']).slice(0, MAX_FORM_TARGET_LENGTH),
      fields: allFields.slice(0, MAX_CANDIDATE_FIELDS).map(fieldOf),
      ...common,
      form: elementOf(raw['form']),
    },
    truncated: truncated || allFields.length > MAX_CANDIDATE_FIELDS,
  };
};

/**
 * 画面の候補を、isolated world の 1 回の読み取り（`readInIsolatedWorld`）で読む（例外を投げない）。`deadlineAtMs` までに読めなければ（古い
 * world、例外の詳細などを含む）`FAILED`。
 */
export async function probePageCandidates(page: Page, deadlineAtMs: number): Promise<PageProbeOutcome> {
  const outcome = await readInIsolatedWorld(page, discoveryProbeInPage, DISCOVERY_PROBE_INPUT, deadlineAtMs);
  if (outcome.status !== 'READ') {
    return PROBE_FAILED;
  }
  try {
    const raw = requireRecord(outcome.value);
    const read = requireArray(raw['candidates']).map(candidateOf);
    return Object.freeze({
      status: 'READ',
      candidates: read.map(({ candidate }) => candidate),
      frameFound: requireBoolean(raw['frameFound']),
      limitReached: requireBoolean(raw['limitReached']) || read.some(({ truncated }) => truncated),
    });
  } catch {
    return PROBE_FAILED;
  }
}

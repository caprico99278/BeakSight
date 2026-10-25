/**
 * 入口の確かめのジョブ（`ENTRY_CHECK`。Task 43 の設計書 4.3。T43c）の、1 つの画面の読み取り（ワーカーの部品。ページを操作しない）。
 * `entry-check-run.ts` が、Guard の付いた読み取りだけの Context（ログインの状態を持たない）で開始の URL を 1 回読み込んだ page を渡す。
 *
 * 1. 落ち着きの待ちと凍結は、発見の入口の部品（`settleAndFreezePage`。`src/discovery/discover-page.ts`）をそのまま使う（凍結の条件の確かめ → 落ち着きの
 *    待ち → `activateInteractionFreeze`。同じ意味の手順を写さない。CC-099 で、候補の probe と JS の結び付きの読み取りを行わない形にした）。凍結できなければ
 *    （`UNAVAILABLE`）、何も読まない。読み込みは足さない。
 * 2. 凍結の後に、isolated world（`readInIsolatedWorld`。ページの JS は結果を偽れず、読む間に走らない）で 1 回読む: main frame の文書（shadow root の
 *    外）の、見える `input[type=password]` の候補、ユーザー名の欄（見える・押せる `input` の text・email・tel）の候補、送信の要素の候補と、それぞれの
 *    要素の名前・id・name・type の属性と、文書の根からの位置。候補はパスワードの欄がちょうど 1 つのとき、その欄と同じ form の中（form の外なら
 *    form の外）だけで探す。送信の要素は、form の中なら送信のボタン（`button[type=submit]`・`input[type=submit]`）、form の外なら `button`・
 *    `input[type=submit|button]`・`role="button"`（`href` のある要素と、`href` のある `a`・`area` の中の要素は除く。ログインの form の事前の確かめと
 *    同じ受け方）。3 つがちょうど 1 つずつなら、form の置き方（同じ form の中・3 つとも外・混ざっている）。パスワードの欄の form の method と、action の
 *    属性があるときの action（送信の要素の `formmethod`・`formaction` を含む）。**欄の値は読まない**（`value` を読まない）。
 * 3. 候補がちょうど 1 つの欄だけ、純粋な部品（`src/discovery/entry-check-selectors.ts`）で候補の CSS を組み立て、認証の設定として受ける形
 *    （`isAcceptedEntrySelector`）に絞り、isolated world でもう 1 回、文書と open な shadow root の中で当たる数と、当たった要素が読んだ要素かを数える。
 *    ちょうど 1 つに当たる最初の CSS を、その欄の案にする。
 * どの読み取りも失敗したら（読めない・形が違う・期限切れ）、読めなかった（`NOT_READ`）として返す（例外を投げない）。
 */
import type { Page } from 'playwright';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';
import {
  ENTRY_CHECK_FIELDS,
  ENTRY_CHECK_FORM_METHODS,
  ENTRY_CHECK_FORM_PLACEMENTS,
  entryCheckLocationOf,
  isAcceptedEntrySelector,
  type EntryCheckFacts,
  type EntryCheckField,
  type EntryCheckFieldFacts,
  type EntryCheckFormMethod,
  type EntryCheckFormPlacement,
} from '../control/entry-check.js';
import { isRecord } from '../core/guards.js';
import type { CandidateLocation } from '../discovery/candidate-contracts.js';
import { DISCOVERY_READ_TIMEOUT_MS, settleAndFreezePage } from '../discovery/discover-page.js';
import {
  entryFieldSelectorOf,
  entrySelectorCandidatesOf,
  type EntryElementFacts,
  type EntrySelectorCheck,
} from '../discovery/entry-check-selectors.js';
import { readInIsolatedWorld } from '../discovery/isolated-read.js';
import { countReadingOf, countSelectorsInPage } from '../discovery/selector-count.js';
import type { DiscoverySettlePolicy, InFlightRequestCounter } from '../discovery/settle.js';

/** 1 つの欄の、読み取りで返す候補の最大の数（数そのものは全部数える。返す事実の大きさを抑える）。 */
export const MAX_ENTRY_FIELD_CANDIDATES = 20;

/** ページの中で読んだ、1 つの候補の要素の事実（値は持たない）。 */
interface InPageCandidate extends EntryElementFacts {
  /** 文書の根からの位置（shadow root の中は `null`）。 */
  readonly path: readonly number[] | null;
}

/** ページの中で読んだ欄の候補（返す候補と、全部の数）。 */
interface InPageField {
  readonly count: number;
  readonly candidates: readonly InPageCandidate[];
}

/** ページの中の 1 回目の読み取りの結果。 */
interface InPageEntryReading {
  readonly fields: Readonly<Record<EntryCheckField, InPageField>>;
  readonly placement: string | null;
  /** パスワードの欄の form の method（form がなければ空）。 */
  readonly method: string;
  /** action の属性があるときの、解決した action（なければ `null`）。 */
  readonly action: string | null;
}

/**
 * ページの中の 1 回目の読み取り（ファイルの先頭の 2）。isolated world で動く（部品 `R` を `composeInPage` で組み込む。外の値を参照しない）。
 * プロパティは標準の prototype の getter で読む（DOM clobbering を受けない）。`value` は読まない。
 */
function readEntryElementsReader(R: StandardReaders, input: { readonly maxCandidates: number }): InPageEntryReading {
  const read = R.standardProperty;
  const nodeListLengthOf = R.standardGetter<number>(NodeList.prototype, 'length');
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const tagOf = (node: Node): string => (node instanceof Element ? text(read(Element.prototype, 'localName', node)) : '');
  const attributeOf = (element: Element, name: string): string => text(Element.prototype.getAttribute.call(element, name));
  const hasAttribute = (node: Node, name: string): boolean => node instanceof Element && Element.prototype.hasAttribute.call(node, name);
  const all = (selector: string): Element[] => {
    const list = Document.prototype.querySelectorAll.call(document, selector);
    const found: Element[] = [];
    for (let index = 0; index < nodeListLengthOf(list); index += 1) {
      const node = NodeList.prototype.item.call(list, index);
      if (node instanceof Element) found.push(node);
    }
    return found;
  };
  const prototypeOf = (element: Element): object | null => {
    if (element instanceof HTMLInputElement) return HTMLInputElement.prototype;
    if (element instanceof HTMLButtonElement) return HTMLButtonElement.prototype;
    return null;
  };
  const typeOf = (element: Element): string => {
    const prototype = prototypeOf(element);
    return prototype === null ? '' : text(read(prototype, 'type', element));
  };
  const disabledOf = (element: Element): boolean => {
    const prototype = prototypeOf(element);
    return prototype !== null && read(prototype, 'disabled', element) === true;
  };
  // T43d fix round 1: 見えるかの判定は部品の `isVisible`（ログインの段の観察と共有）。
  const visible = R.isVisible;
  // 要素の form（form の持ち主か、なければ祖先の form。ログインの form の事前の確かめと同じ見方）。
  const formOf = (element: Element): HTMLFormElement | null => {
    const prototype = prototypeOf(element);
    const owner: unknown = prototype === null ? null : read(prototype, 'form', element);
    if (owner instanceof HTMLFormElement) return owner;
    const closest = Element.prototype.closest.call(element, 'form');
    return closest instanceof HTMLFormElement ? closest : null;
  };
  const inputs = all('input');
  const passwords = inputs.filter((element) => typeOf(element) === 'password' && visible(element));
  // パスワードの欄がちょうど 1 つなら、その欄の form（なければ form の外）の中だけで探す。ほかは文書の全体。
  const onlyPassword = passwords.length === 1 ? passwords[0] : undefined;
  const scoped = onlyPassword !== undefined;
  const container = onlyPassword === undefined ? null : formOf(onlyPassword);
  const inScope = (element: Element): boolean => !scoped || formOf(element) === container;
  const usernameTypes = ['text', 'email', 'tel'];
  const usernames = inputs.filter((element) => usernameTypes.includes(typeOf(element)) && visible(element) && !disabledOf(element) && inScope(element));
  const isFormSubmit = (element: Element): boolean =>
    (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) && typeOf(element) === 'submit';
  const isFormlessSubmit = (element: Element): boolean => {
    // 祖先（shadow root では host へ移る）に `href` のある `a`・`area` があれば除く（押すとページが移りうる。CC-099: 部品の `hasLinkAncestor`）。
    if (hasAttribute(element, 'href') || R.hasLinkAncestor(element)) return false;
    const type = typeOf(element);
    return tagOf(element) === 'button'
      || (element instanceof HTMLInputElement && (type === 'submit' || type === 'button'))
      || attributeOf(element, 'role').trim().toLowerCase() === 'button';
  };
  const submits = all('button, input, [role]').filter((element) => {
    if (!visible(element) || disabledOf(element) || !inScope(element)) return false;
    if (!scoped) return isFormSubmit(element) || isFormlessSubmit(element);
    return container === null ? isFormlessSubmit(element) : isFormSubmit(element);
  });
  const candidateOf = (element: Element): InPageCandidate => ({
    tag: tagOf(element),
    id: attributeOf(element, 'id'),
    name: attributeOf(element, 'name'),
    type: attributeOf(element, 'type'),
    path: R.elementPathOf(element),
  });
  const fieldOf = (elements: readonly Element[]): InPageField => ({
    count: elements.length,
    candidates: elements.slice(0, input.maxCandidates).map(candidateOf),
  });
  const username = usernames.length === 1 ? usernames[0] : undefined;
  const submit = submits.length === 1 ? submits[0] : undefined;
  let placement: string | null = null;
  if (username !== undefined && onlyPassword !== undefined && submit !== undefined) {
    const containers = [formOf(username), container, formOf(submit)];
    placement = containers.every((form) => form === null)
      ? 'NONE'
      : containers.every((form) => form !== null && form === containers[0]) ? 'SAME' : 'MIXED';
  }
  // form の method と action（送信の要素の `formmethod`・`formaction` を含む。action の属性がなければ `null`）。
  let method = '';
  let action: string | null = null;
  if (container !== null) {
    const submitPrototype = submit === undefined ? null : prototypeOf(submit);
    const override = (attribute: string, property: string): string | null =>
      submit !== undefined && submitPrototype !== null && attributeOf(submit, attribute).trim().length > 0
        ? text(read(submitPrototype, property, submit))
        : null;
    method = override('formmethod', 'formMethod') ?? text(read(HTMLFormElement.prototype, 'method', container));
    action = override('formaction', 'formAction')
      ?? (attributeOf(container, 'action').trim().length > 0 ? text(read(HTMLFormElement.prototype, 'action', container)) : null);
  }
  return {
    fields: { username: fieldOf(usernames), password: fieldOf(passwords), submit: fieldOf(submits) },
    placement,
    method,
    action,
  };
}
const readEntryElementsInPage = composeInPage(readEntryElementsReader);

// ページの中の 2 回目の読み取り（ファイルの先頭の 3。CSS の当たる数）は、T38a で `src/discovery/selector-count.ts` に移した（送らずに観察する probe の欄の
// CSS と共有する）。T43d の成功の画面のセレクタの案（`login-stage-observation.ts`）は、移した先を直接使う。

/** 画面の読み取りの結果。`READ` の `location` は、読んだ時点の page の Origin と path（http(s) でなければ `null`）。 */
export type EntryPageReading =
  | { readonly kind: 'READ'; readonly facts: EntryCheckFacts; readonly location: CandidateLocation | null }
  | { readonly kind: 'NOT_READ'; readonly location: CandidateLocation | null };

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isString = (value: unknown): value is string => typeof value === 'string';
const isPath = (value: unknown): value is readonly number[] | null =>
  value === null || (Array.isArray(value) && value.every((step) => isCount(step)));

/** 1 回目の読み取りの値の形を確かめる（形が違えば `null`）。 */
const entryReadingOf = (value: unknown): InPageEntryReading | null => {
  if (!isRecord(value) || !isRecord(value['fields'])) {
    return null;
  }
  const fields = value['fields'];
  const fieldsOk = ENTRY_CHECK_FIELDS.every((field) => {
    const entry = fields[field];
    return isRecord(entry) && isCount(entry['count']) && Array.isArray(entry['candidates'])
      && entry['candidates'].length <= MAX_ENTRY_FIELD_CANDIDATES
      && entry['candidates'].every((candidate: unknown) => isRecord(candidate) && isString(candidate['tag']) && isString(candidate['id'])
        && isString(candidate['name']) && isString(candidate['type']) && isPath(candidate['path']));
  });
  const placement = value['placement'];
  const action = value['action'];
  return fieldsOk && (placement === null || isString(placement)) && isString(value['method']) && (action === null || isString(action))
    ? value as unknown as InPageEntryReading
    : null;
};

const placementOf = (value: string | null): EntryCheckFormPlacement | null =>
  ENTRY_CHECK_FORM_PLACEMENTS.find((placement) => placement === value) ?? null;

const methodOf = (value: string): EntryCheckFormMethod | null =>
  ENTRY_CHECK_FORM_METHODS.find((method) => method === value.toUpperCase()) ?? null;

/**
 * ログインの欄の検出の結果（FM2e で `readEntryPage` から分けた共通の部品の結果）。欄ごとの見える候補の数と、候補がちょうど 1 つのときの一意な CSS、
 * form の置き方と、パスワードの欄の form の method と action（ページの値のまま。場所への写しは呼ぶ側）。欄の値は持たない。
 */
export interface LoginFormFieldsReading {
  readonly fields: Readonly<Record<EntryCheckField, EntryCheckFieldFacts>>;
  readonly placement: string | null;
  readonly method: string;
  readonly action: string | null;
}

/**
 * ログインの画面の 3 つの欄（ユーザー名の欄・パスワードの欄・送信の要素）を、isolated world で 2 回読んで検出する（ファイルの先頭の 2 と 3）。
 * 入口の確かめ（`readEntryPage`。凍結の後に呼ぶ）と、手動のログインの段の始めの観察（`login-stage-observation.ts`。FM2e。人が操作する画面なので凍結
 * しない）が共用する唯一の検出の部品。各欄の候補がちょうど 1 つのときだけ、その欄の CSS の案を出す（`entryFieldSelectorOf`）。**欄の値は読まない**。
 * ページを操作しない・読み込みも要求も足さない（isolated world の CDP の命令だけ）。読めなければ（読めない・形が違う・期限切れ）`null`。例外を投げない
 * （読み取りの部品が例外を返さない形）。
 */
export async function readLoginFormFields(page: Page): Promise<LoginFormFieldsReading | null> {
  const first = await readInIsolatedWorld(page, readEntryElementsInPage, { maxCandidates: MAX_ENTRY_FIELD_CANDIDATES },
    Date.now() + DISCOVERY_READ_TIMEOUT_MS);
  const reading = first.status === 'READ' ? entryReadingOf(first.value) : null;
  if (reading === null) {
    return null;
  }
  // 候補がちょうど 1 つの欄だけ、CSS を組み立てて数える。
  const plans = ENTRY_CHECK_FIELDS.map((field) => {
    const { count, candidates } = reading.fields[field];
    const [candidate] = candidates;
    return count === 1 && candidate !== undefined
      ? { field, path: candidate.path, selectors: entrySelectorCandidatesOf(candidate).filter(isAcceptedEntrySelector) }
      : { field, path: null, selectors: [] as string[] };
  });
  const second = await readInIsolatedWorld(page, countSelectorsInPage, { checks: plans.map(({ path, selectors }) => ({ path, selectors })) },
    Date.now() + DISCOVERY_READ_TIMEOUT_MS);
  const counts = second.status === 'READ' ? countReadingOf(second.value, plans.map(({ selectors }) => selectors.length)) : null;
  if (counts === null) {
    return null;
  }
  const fieldFacts = (field: EntryCheckField, index: number): EntryCheckFieldFacts => {
    const checks: EntrySelectorCheck[] = (plans[index]?.selectors ?? []).map((selector, at) => ({
      selector,
      matches: counts[index]?.[at]?.matches ?? 0,
      matchesElement: counts[index]?.[at]?.matchesElement ?? false,
    }));
    const { count } = reading.fields[field];
    return { candidates: count, selector: entryFieldSelectorOf(count, checks) };
  };
  return {
    fields: { username: fieldFacts('username', 0), password: fieldFacts('password', 1), submit: fieldFacts('submit', 2) },
    placement: reading.placement,
    method: reading.method,
    action: reading.action,
  };
}

/**
 * 読み込んだ画面を、落ち着いた後に凍結して読む（ファイルの先頭）。例外を投げない。`counter` は読み込みの前に作った進行中の要求の数え方（呼ぶ側が
 * `dispose` する）。`allowedOrigins` は対象の設定の許可 Origin。`settlePolicy` は落ち着きの待ちの指定（TS-c。省略は本番の `DISCOVERY_SETTLE_POLICY`。
 * テストだけが渡す）。
 */
export async function readEntryPage(
  page: Page,
  counter: InFlightRequestCounter,
  allowedOrigins: readonly string[],
  settlePolicy?: DiscoverySettlePolicy,
): Promise<EntryPageReading> {
  // CC-099（T37c fix round 1）: 落ち着きと凍結だけを使う（候補の probe と JS の結び付きの読み取りはしない）。
  const frozen = await settleAndFreezePage(page, { requestCounter: counter, settlePolicy });
  const { location } = frozen;
  if (frozen.status !== 'FROZEN') {
    return { kind: 'NOT_READ', location };
  }
  // FM2e: 欄の検出は共通の部品（`readLoginFormFields`）。
  const reading = await readLoginFormFields(page);
  if (reading === null) {
    return { kind: 'NOT_READ', location };
  }
  const facts: EntryCheckFacts = {
    loginPage: reading.fields.password.candidates > 0,
    fields: reading.fields,
    form: {
      placement: placementOf(reading.placement),
      action: reading.action === null ? null : entryCheckLocationOf(reading.action, allowedOrigins),
      method: methodOf(reading.method),
    },
  };
  return { kind: 'READ', facts, location };
}

/**
 * ログインの段で観察すること（Task 43 の設計書 3 章、4.4。T43d。T43R-fix の C-1 で、残すものを接頭辞と接尾辞とログアウトの属性の CSS に絞った）。
 * 手動のログインの段（`authenticated-login.ts`）と自動ログインの段（`automated-login.ts`）が共通に使うワーカーの部品。ページを操作しない（押さない・
 * 入れない）。値を読まない。
 *
 * 1. 始め（ログインの画面を開いた直後。`observeLoginPageStart`）: isolated world（`readInIsolatedWorld`。ページの JS は結果を偽れない）で、
 *    (a) ログインの画面の Origin のローカル ストレージの鍵の名前（`Storage.prototype.key` で名前だけを読む。値は読まない）と、
 *    (b) ログインの画面の、見えるリンク・ボタンの候補の CSS（ログインの後の画面の案から外すため。Node の側のメモリにだけ置き、どこにも送らない）を読む。
 *        page の Origin がログインの画面の Origin でなければ (a) は読まない。
 *    (c) FM2e（手を減らす段 2 の設計書 3A.4）: 手動のログインの段だけ、ログインの 3 つの欄（ユーザー名・パスワード・送信）を、入口の確かめと同じ検出の部品
 *        （`readLoginFormFields`。各欄の候補がちょうど 1 つのときだけ案。欄の値は読まない）で検出する。成功のときだけ、観察の `loginFields` に載せる。
 * 2. 終わり（`observeLoginStageEnd`）: 同じ page で、
 *    - 成功のときだけ、落ち着きの待ちと凍結（`settleAndFreezePage`。発見の入口と同じ部品）をしてから読む（設計書 4.4「凍結の後に isolated world で
 *      読み」）。凍結できなければ、成功の画面のセレクタの案は出さない。
 *    - 鍵の名前をもう一度読み、始めになく終わりにある名前の、接頭辞と接尾辞の案を作る（`newStorageKeyShapesOf`。名前の全体と間の部分は残さない。
 *      T43R-fix の C-1 (a)）。読んだ名前は、このメモリの外へ出さない。
 *    - 成功のときだけ、ログアウトの語（`DISCOVERY_LOGOUT_WORDS`。閉じた一覧）に当たる見えるリンクやボタンの事実（名前・id・name・type・href の属性と位置。
 *      要素の文字は返さず、当たった語だけを返す）を読み、ログアウトの語を含む属性から作った CSS（`successSelectorCandidatesOf`。T43R-fix の C-1 (b)）を
 *      認証の設定として受ける形（`isAcceptedEntrySelector`）に絞り、ログインの画面にもあった CSS を外し、入口の確かめと同じ数え方
 *      （`countSelectorsInPage`）でちょうど 1 つに当たるものを選ぶ（`successSelectorProposalOf`）。
 *    - 自動ログインでは、呼ぶ側が資格情報と照らす関数を渡し、入れた資格情報を含む案を捨て、捨てた数だけを記録する（`withoutCredentialProposals`。
 *      T43R-fix の C-1 (c)。比べは資格情報の守りの部品の比べる形。ここに比べの処理を書かない）。
 * どの読み取りも失敗したら、その項目を出さない（例外を投げない）。読み込みも要求も足さない（isolated world の CDP の命令だけ）。
 */
import type { Page } from 'playwright';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';
import { isAcceptedEntrySelector } from '../control/entry-check.js';
import type { WorkerLoginFieldProposals, WorkerLoginObservation } from '../control/worker-protocol.js';
import { isRecord } from '../core/guards.js';
import { canonicalHttpOriginOf } from '../crawl/normalize-url.js';
import { DISCOVERY_LOGOUT_WORDS } from '../discovery/classification-words.js';
import { DISCOVERY_READ_TIMEOUT_MS, settleAndFreezePage } from '../discovery/discover-page.js';
import { readInIsolatedWorld } from '../discovery/isolated-read.js';
import {
  newStorageKeyShapesOf,
  successSelectorCandidatesOf,
  successSelectorProposalOf,
  type SuccessSelectorCandidateCheck,
  type SuccessSelectorElementFacts,
} from '../discovery/login-observation.js';
import { countReadingOf, countSelectorsInPage } from '../discovery/selector-count.js';
import { readLoginFormFields } from './entry-check-page.js';

/** 読む鍵の名前の数の上限（超えた名前は読まない。差分は読んだ名前の中で求める）。 */
export const MAX_READ_STORAGE_KEY_NAMES = 200;
/** ログインの画面で読む要素の数の上限（外す CSS を作るため）。 */
export const MAX_LOGIN_PAGE_LANDMARKS = 200;
/** ログインの後の画面で読む候補の要素の数の上限。 */
export const MAX_SUCCESS_SELECTOR_CANDIDATES = 20;

/** 始めに読んだこと（Node の側のメモリにだけ置く）。 */
export interface LoginPageBaseline {
  /** ログインの画面の Origin（正規の直列化。作れなければ `null`）。 */
  readonly origin: string | null;
  /** 始めの鍵の名前（読めなければ `null`。そのときは差分を出さない）。 */
  readonly storageKeyNames: readonly string[] | null;
  /** ログインの画面の要素の候補の CSS（案から外す）。 */
  readonly selectors: ReadonlySet<string>;
  /**
   * FM2e: ログインの 3 つの欄の CSS の案（手動のログインの段だけが検出を頼む。検出しないか、どの欄にも案がなければ `null`）。成功のときだけ観察に載せる。
   */
  readonly loginFields: WorkerLoginFieldProposals | null;
}

/** 読まなかった始め（ページを開けなかったときなど）。 */
export const EMPTY_LOGIN_PAGE_BASELINE: LoginPageBaseline = Object.freeze({
  origin: null, storageKeyNames: null, selectors: new Set<string>(), loginFields: null,
});

/** 始めの観察の指定。 */
export interface LoginPageStartOptions {
  /**
   * FM2e（手を減らす段 2 の設計書 3A.4）: ログインの 3 つの欄を検出するか（手動のログインの段だけが真を渡す。自動ログインの段は、保存したセレクタを
   * 使うので検出しない）。検出は入口の確かめと同じ部品（`readLoginFormFields`）で、欄の値を読まない。
   */
  readonly detectLoginFields?: boolean;
}

/** 文字列のどれかが、入れた資格情報を含むか（自動ログインの段が、資格情報の守りの部品の比べる口で作って渡す）。 */
export type CredentialCarryCheck = (texts: readonly string[]) => boolean;

// ---------------------------------------------------------------------------------------------------------------
// ページの中の読み取り（isolated world で動く。外の値を参照しない）
// ---------------------------------------------------------------------------------------------------------------

/** 鍵の名前の読み取りの結果（ページの Origin と、読んだ名前）。 */
interface InPageStorageKeys {
  readonly origin: string;
  readonly names: readonly string[];
}

/** ローカル ストレージの鍵の名前だけを読む（`Storage.prototype.key`。値は読まない）。読めなければ例外（読めなかった）。 */
function readStorageKeyNamesReader(R: StandardReaders, input: { readonly max: number }): InPageStorageKeys {
  const storage: unknown = window.localStorage;
  if (!(storage instanceof Storage)) {
    throw new Error('No local storage');
  }
  const length = R.standardProperty<number>(Storage.prototype, 'length', storage);
  const names: string[] = [];
  for (let index = 0; index < length && names.length < input.max; index += 1) {
    const name = Storage.prototype.key.call(storage, index);
    if (typeof name === 'string') names.push(name);
  }
  // `Location` の属性は prototype でなく実体の上にある（偽れない属性）。isolated world なので、ページの JS は書き換えられない。
  return { origin: String(location.origin), names };
}
const readStorageKeyNamesInPage = composeInPage(readStorageKeyNamesReader);

/** ページの中で読んだ 1 つの候補の要素（文字は持たない。当たったログアウトの語だけ。当たらなければ `null`）。 */
interface InPageLandmark extends SuccessSelectorElementFacts {
  readonly logoutWord: string | null;
  readonly path: readonly number[] | null;
}

/** 候補の読み取りの入力。`all` なら、見えるリンク・ボタンのすべて（ログインの画面。外す CSS を作る）。 */
interface LandmarkInput {
  readonly words: readonly string[];
  readonly max: number;
  readonly all: boolean;
}

/**
 * 見えるリンク・ボタン（`href` のある `a`・`button`・`[role=button]`・`input[type=submit|button]`）のうち、文字・`aria-label`・`title`・`href` に
 * ログアウトの語を含むもの。`all` なら、当たらない見えるリンク・ボタンも返す（語は `null`）。要素の文字は返さない（語の照合はページの中で行い、当たった語
 * だけを返す）。`value` は読まない。T43R-fix の C-1 (b): nav・header の中の要素は候補にしない。
 */
function readLandmarksReader(R: StandardReaders, input: LandmarkInput): InPageLandmark[] {
  const read = R.standardProperty;
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const attributeOf = (element: Element, name: string): string => text(Element.prototype.getAttribute.call(element, name));
  const tagOf = (element: Element): string => text(read(Element.prototype, 'localName', element));
  // 見えるかの判定は部品の `isVisible`（入口の確かめと共有。T43d fix round 1）。
  const visible = R.isVisible;
  // 大文字と小文字を畳み、空白の並びを 1 つにする（ページの中では部品を import できないので、Unicode の正規化はしない）。
  const folded = (value: string): string => value.toLowerCase().split(/\s+/u).join(' ');
  const words = input.words.map(folded);
  // 移動の要素は名前で拾い、`href` 属性の有無は後で見る（リンクの取り出しの owner の書き方は使わない。GATE-ARCH03）。
  const list = Document.prototype.querySelectorAll.call(document, 'a, button, [role="button"], input[type="submit"], input[type="button"]');
  const lengthOf = R.standardGetter<number>(NodeList.prototype, 'length');
  const found: InPageLandmark[] = [];
  for (let index = 0; index < lengthOf(list) && found.length < input.max; index += 1) {
    const element = NodeList.prototype.item.call(list, index);
    if (!(element instanceof Element) || !visible(element)) continue;
    const tag = tagOf(element);
    const control = (tag === 'a' && Element.prototype.hasAttribute.call(element, 'href')) || tag === 'button'
      || attributeOf(element, 'role').trim().toLowerCase() === 'button'
      || (tag === 'input' && ['submit', 'button'].includes(attributeOf(element, 'type').toLowerCase()));
    if (!control) continue;
    const haystack = folded([text(read(Node.prototype, 'textContent', element)), attributeOf(element, 'aria-label'), attributeOf(element, 'title'),
      attributeOf(element, 'href')].join(' '));
    const logoutWord = input.words.find((_word, at) => haystack.includes(words[at] ?? '\u0000')) ?? null;
    if (logoutWord === null && !input.all) continue;
    found.push({
      logoutWord,
      tag,
      id: attributeOf(element, 'id'),
      name: attributeOf(element, 'name'),
      type: attributeOf(element, 'type'),
      href: tag === 'a' ? attributeOf(element, 'href') : '',
      path: R.elementPathOf(element),
    });
  }
  return found;
}
const readLandmarksInPage = composeInPage(readLandmarksReader);

// ---------------------------------------------------------------------------------------------------------------
// 形の確かめ（Node の側）
// ---------------------------------------------------------------------------------------------------------------

const isString = (value: unknown): value is string => typeof value === 'string';
const isPath = (value: unknown): value is readonly number[] | null =>
  value === null || (Array.isArray(value) && value.every((step) => Number.isSafeInteger(step) && (step as number) >= 0));

const storageKeysOf = (value: unknown): InPageStorageKeys | null =>
  isRecord(value) && isString(value['origin']) && Array.isArray(value['names']) && value['names'].length <= MAX_READ_STORAGE_KEY_NAMES
  && value['names'].every(isString)
    ? value as unknown as InPageStorageKeys
    : null;

const landmarksOf = (value: unknown, max: number): readonly InPageLandmark[] | null =>
  Array.isArray(value) && value.length <= max && value.every((item: unknown) => isRecord(item)
    && (item['logoutWord'] === null || (DISCOVERY_LOGOUT_WORDS as readonly unknown[]).includes(item['logoutWord']))
    && isString(item['tag']) && isString(item['id']) && isString(item['name']) && isString(item['type']) && isString(item['href']) && isPath(item['path']))
    ? value as readonly InPageLandmark[]
    : null;

/** page の今の Origin（読めなければ `null`）。 */
const pageOriginOf = (page: Page): string | null => {
  try {
    return canonicalHttpOriginOf(new URL(page.url()).origin) ?? null;
  } catch {
    return null;
  }
};

/** ログインの画面の Origin の page なら、鍵の名前を読む（読めなければ `null`）。 */
const readStorageKeyNames = async (page: Page, origin: string | null): Promise<readonly string[] | null> => {
  if (origin === null || page.isClosed() || pageOriginOf(page) !== origin) {
    return null;
  }
  const outcome = await readInIsolatedWorld(page, readStorageKeyNamesInPage, { max: MAX_READ_STORAGE_KEY_NAMES }, Date.now() + DISCOVERY_READ_TIMEOUT_MS);
  const keys = outcome.status === 'READ' ? storageKeysOf(outcome.value) : null;
  return keys !== null && canonicalHttpOriginOf(keys.origin) === origin ? keys.names : null;
};

/** 候補の要素を読む（読めなければ `null`）。 */
const readLandmarks = async (page: Page, max: number, all: boolean): Promise<readonly InPageLandmark[] | null> => {
  if (page.isClosed()) {
    return null;
  }
  const outcome = await readInIsolatedWorld(page, readLandmarksInPage, { words: [...DISCOVERY_LOGOUT_WORDS], max, all }, Date.now() + DISCOVERY_READ_TIMEOUT_MS);
  return outcome.status === 'READ' ? landmarksOf(outcome.value, max) : null;
};

/** 要素の、認証の設定として受ける候補の CSS（ログアウトの語を含む属性から作ったものだけ）。 */
const acceptedSelectorsOf = (landmark: SuccessSelectorElementFacts): readonly string[] =>
  successSelectorCandidatesOf(landmark).filter(isAcceptedEntrySelector);

/**
 * T43R-fix の C-1 (c): 入れた資格情報を含む案（接頭辞か接尾辞、セレクタ）を捨て、捨てた数を `credentialDiscarded` に足す（純粋。比べは渡された関数）。
 * 何も残らず捨てた数もなければ `undefined`。
 */
export const withoutCredentialProposals = (
  observation: WorkerLoginObservation | undefined,
  carriesCredential: CredentialCarryCheck,
): WorkerLoginObservation | undefined => {
  if (observation === undefined) {
    return undefined;
  }
  const { storageKeys, successSelector } = observation;
  const shapes = storageKeys?.shapes.filter(({ prefix, suffix }) => !carriesCredential([prefix, suffix])) ?? [];
  const keepSelector = successSelector !== undefined && !carriesCredential([successSelector.selector]);
  const discarded = (storageKeys?.shapes.length ?? 0) - shapes.length + (successSelector !== undefined && !keepSelector ? 1 : 0)
    + (observation.credentialDiscarded ?? 0);
  const result: WorkerLoginObservation = {
    ...(storageKeys === undefined || shapes.length === 0 ? {} : { storageKeys: { ...storageKeys, shapes } }),
    ...(keepSelector ? { successSelector } : {}),
    ...(discarded === 0 ? {} : { credentialDiscarded: discarded }),
  };
  return Object.keys(result).length === 0 ? undefined : result;
};

// ---------------------------------------------------------------------------------------------------------------
// 公開の入口
// ---------------------------------------------------------------------------------------------------------------

/**
 * FM2e: ログインの 3 つの欄の CSS の案（入口の確かめと同じ検出の部品。各欄の候補がちょうど 1 つのときだけ。どの欄にも案がなければ `null`）。欄の値は
 * 読まない。読めなければ `null`。
 */
const loginFieldProposalsOf = async (page: Page): Promise<WorkerLoginFieldProposals | null> => {
  if (page.isClosed()) {
    return null;
  }
  const reading = await readLoginFormFields(page);
  if (reading === null) {
    return null;
  }
  const { username, password, submit } = reading.fields;
  const proposals: WorkerLoginFieldProposals = { username: username.selector, password: password.selector, submit: submit.selector };
  const selectors = [proposals.username, proposals.password, proposals.submit].filter((selector) => selector !== null);
  // 案どうしが同じ CSS になることはない（別の要素にちょうど 1 つずつ当たる）が、IPC の契約に合わせて、重なれば出さない。
  return selectors.length === 0 || new Set(selectors).size !== selectors.length ? null : proposals;
};

/**
 * ログインの画面を開いた直後に読む（ファイルの先頭の 1）。例外を投げない。`loginStartUrl` は認証の設定のログインの画面の URL。FM2e: 手動のログインの段は
 * `detectLoginFields` でログインの 3 つの欄の検出も頼む（人が操作する画面なので凍結しない。isolated world で読むだけ）。
 */
export async function observeLoginPageStart(page: Page, loginStartUrl: string, options: LoginPageStartOptions = {}): Promise<LoginPageBaseline> {
  try {
    const origin = canonicalHttpOriginOf(new URL(loginStartUrl).origin) ?? null;
    const storageKeyNames = await readStorageKeyNames(page, origin);
    const landmarks = await readLandmarks(page, MAX_LOGIN_PAGE_LANDMARKS, true);
    const loginFields = options.detectLoginFields === true ? await loginFieldProposalsOf(page) : null;
    return { origin, storageKeyNames, selectors: new Set((landmarks ?? []).flatMap(acceptedSelectorsOf)), loginFields };
  } catch {
    return EMPTY_LOGIN_PAGE_BASELINE;
  }
}

/** 成功の画面のセレクタの案（凍結した page で読む。なければ `undefined`）。 */
const successSelectorOf = async (page: Page, baseline: LoginPageBaseline): Promise<WorkerLoginObservation['successSelector']> => {
  const landmarks = (await readLandmarks(page, MAX_SUCCESS_SELECTOR_CANDIDATES, false))?.flatMap((landmark) =>
    (landmark.logoutWord === null ? [] : [{ ...landmark, logoutWord: landmark.logoutWord }]));
  if (landmarks === undefined || landmarks.length === 0) {
    return undefined;
  }
  const plans = landmarks.map((landmark) => ({ landmark, selectors: acceptedSelectorsOf(landmark).filter((selector) => !baseline.selectors.has(selector)) }));
  const outcome = await readInIsolatedWorld(page, countSelectorsInPage, { checks: plans.map(({ landmark, selectors }) => ({ path: landmark.path, selectors })) },
    Date.now() + DISCOVERY_READ_TIMEOUT_MS);
  const counts = outcome.status === 'READ' ? countReadingOf(outcome.value, plans.map(({ selectors }) => selectors.length)) : null;
  if (counts === null) {
    return undefined;
  }
  const candidates: SuccessSelectorCandidateCheck[] = plans.map(({ landmark, selectors }, index) => ({
    logoutWord: landmark.logoutWord,
    checks: selectors.map((selector, at) => ({
      selector,
      matches: counts[index]?.[at]?.matches ?? 0,
      matchesElement: counts[index]?.[at]?.matchesElement ?? false,
    })),
  }));
  return successSelectorProposalOf(candidates, baseline.selectors) ?? undefined;
};

/**
 * ログインの段の終わりに読む（ファイルの先頭の 2）。`succeeded` はログインの段が成功したか（成功の画面のセレクタの案と凍結は成功のときだけ）。
 * `carriesCredential` は自動ログインだけが渡す（入れた資格情報を含む案を捨てる）。観察したことがなければ `undefined`。例外を投げない。凍結した page は、
 * 呼ぶ側がそのまま閉じる（ほかの読み取りをしない）。
 */
export async function observeLoginStageEnd(
  page: Page | undefined,
  baseline: LoginPageBaseline,
  succeeded: boolean,
  carriesCredential?: CredentialCarryCheck,
): Promise<WorkerLoginObservation | undefined> {
  if (page === undefined) {
    return undefined;
  }
  try {
    const frozen = succeeded ? (await settleAndFreezePage(page, {})).status === 'FROZEN' : false;
    const { origin: loginOrigin, storageKeyNames: before } = baseline;
    const after = before === null ? null : await readStorageKeyNames(page, loginOrigin);
    const keys = after === null || before === null ? null : newStorageKeyShapesOf(before, after);
    const successSelector = frozen ? await successSelectorOf(page, baseline) : undefined;
    // FM2e: ログインの欄の案は、成功のときだけ載せる（自動ログインの段は検出しないので、ここに来ない。来ても資格情報の照らしの部品が落とす）。
    const loginFields = succeeded ? baseline.loginFields : null;
    const observation: WorkerLoginObservation = {
      ...(keys === null || loginOrigin === null ? {} : { storageKeys: { origin: loginOrigin, shapes: [...keys.shapes], omitted: keys.omitted } }),
      ...(successSelector === undefined ? {} : { successSelector }),
      ...(loginFields === null ? {} : { loginFields }),
    };
    const observed = Object.keys(observation).length === 0 ? undefined : observation;
    return carriesCredential === undefined ? observed : withoutCredentialProposals(observed, carriesCredential);
  } catch {
    return undefined;
  }
}

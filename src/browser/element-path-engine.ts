// 位置で要素を指す、自前の selector engine（T32j-4 fix round 1。T32R-fix-I1 で合図の事象を足した）。Playwright の `selectors` に登録し、
// Playwright の utility world（ページの JS と別の global と prototype）で動く。
// - セレクタは `beaksight-element-path=<位置>;<合図>` の形だけを受ける。位置は文書の根からの、要素の子の中の番号の並び（`0/1/10`。
//   `StandardReaders` の `elementPathOf`・`elementAtPath` の数え方。標準の getter でたどるので、DOM clobbering を受けない）。合図は
//   `beaksight-` と暗号の乱数 32 桁の 16 進（`newElementPathSignal`）。合図がない・形が違うときは、要素を返さない（fail-closed）。
// - 位置の要素に、合図の名前の、取り消せて泡立たない事象を送り、取り消されたときだけ要素を返す。取り消すのは、isolated world に付けた受け手
//   （`src/discovery/isolated-read.ts` の `withSignaledElements`。的が、確かめの時の backendNodeId の要素のときだけ取り消す）。位置の要素と、
//   確かめの時の要素を、1 つの同期の呼び出しの中で照らすので、照らした後に入れ替わる窓がない（独立レビュー T32R の I-1）。
// - 既知の限界（設計書と `doc/spec/safety.md` の扱いのとおり）:
//   1. Playwright の操作（click など）が送る pointer の事象は、ページの JS が window の capture 段で見うる（Playwright の操作と同じ性質。
//      照らした後の座標の事象の的は、Playwright の当たりの確かめに任せる）。
//   2. hover の状態（`:hover`）は、合図では照らせない（読み取りの結果に使わない）。
//   3. 受け手を外すのに失敗しても害はない（合図の名前は 1 回ごとに変わり、受け手は取り消すだけで何もしない）。結果は変えない。
//   4. 合図の名前は、ページの JS から読めない前提（utility world と isolated world と Node の中だけにあり、ページの global や DOM に置かない）。
//   5. 照らすのは操作の的の要素だけ。キーボードの入力（`fill` など）は、的に focus を当てた後に focus のある要素に入るので、ページの JS が
//      focus を移すと、値は別の要素（form の外を含む）に入りうる（T32R2 の I-1）。送る中身は、入れた後の値の読み直しと Guard の照合が守る。
import { randomBytes } from 'node:crypto';
import { selectors } from 'playwright';
import { composeInPage, type StandardReaders } from './in-page-readers.js';

/** 位置で要素を指す、自前の selector engine の名前（Playwright の `selectors` に登録する）。 */
export const ELEMENT_PATH_ENGINE_NAME = 'beaksight-element-path';
/** 位置の番号の区切り（`0/1/10`）。 */
const ELEMENT_PATH_SEPARATOR = '/';
/** 位置と合図の区切り（`0/1/10;beaksight-…`）。 */
const ELEMENT_PATH_SIGNAL_SEPARATOR = ';';
/** 合図の名前の頭。 */
const ELEMENT_PATH_SIGNAL_PREFIX = 'beaksight-';
/** 合図の名前の乱数のバイト数（16 進で 32 桁）。 */
const ELEMENT_PATH_SIGNAL_RANDOM_BYTES = 16;
/** 合図の名前の形（頭と、小文字の 16 進の 32 桁）。 */
const ELEMENT_PATH_SIGNAL_PATTERN = new RegExp(`^${ELEMENT_PATH_SIGNAL_PREFIX}[0-9a-f]{${String(ELEMENT_PATH_SIGNAL_RANDOM_BYTES * 2)}}$`, 'u');

/** 新しい合図の名前（暗号の乱数。1 回の使用ごとに作る）。 */
export const newElementPathSignal = (): string => `${ELEMENT_PATH_SIGNAL_PREFIX}${randomBytes(ELEMENT_PATH_SIGNAL_RANDOM_BYTES).toString('hex')}`;

/** 合図の名前の形か。 */
export const isElementPathSignal = (value: unknown): value is string => typeof value === 'string' && ELEMENT_PATH_SIGNAL_PATTERN.test(value);

/** engine に渡す決まり（ページの中の関数は外を参照できないので、値で渡す）。 */
interface ElementPathEngineRules {
  readonly pathSeparator: string;
  readonly signalSeparator: string;
  readonly signalPattern: string;
}
const ELEMENT_PATH_ENGINE_RULES: ElementPathEngineRules = Object.freeze({
  pathSeparator: ELEMENT_PATH_SEPARATOR,
  signalSeparator: ELEMENT_PATH_SIGNAL_SEPARATOR,
  signalPattern: ELEMENT_PATH_SIGNAL_PATTERN.source,
});

/**
 * 位置の要素に合図の事象を送り、取り消されたときだけ要素を返す（Playwright の utility world で動く。標準の getter でたどる）。形が違う・
 * 位置に要素がない・取り消されないときは null。
 */
const elementAtSignaledPathInPage = composeInPage((R: StandardReaders, selector: string, rules: ElementPathEngineRules): Element | null => {
  const text = String(selector);
  const at = text.indexOf(rules.signalSeparator);
  if (at < 0) {
    return null;
  }
  const signal = text.slice(at + rules.signalSeparator.length);
  if (!new RegExp(rules.signalPattern, 'u').test(signal)) {
    return null;
  }
  const pathText = text.slice(0, at);
  const steps = pathText === '' ? [] : pathText.split(rules.pathSeparator).map((step) => Number(step));
  if (steps.length === 0 || !steps.every((step) => Number.isSafeInteger(step) && step >= 0)) {
    return null;
  }
  const element = R.elementAtPath(steps);
  if (element === null) {
    return null;
  }
  const event = new Event(signal, { cancelable: true, bubbles: false, composed: false });
  return EventTarget.prototype.dispatchEvent.call(element, event) ? null : element;
});

/** 自前の selector engine の本文（`query`・`queryAll`。`root` は使わず、文書の根からたどる。shadow root を突き抜けない）。 */
const ELEMENT_PATH_ENGINE_SOURCE = `({
  query(_root, selector) { return (${String(elementAtSignaledPathInPage)})(selector, ${JSON.stringify(ELEMENT_PATH_ENGINE_RULES)}); },
  queryAll(_root, selector) {
    const element = (${String(elementAtSignaledPathInPage)})(selector, ${JSON.stringify(ELEMENT_PATH_ENGINE_RULES)});
    return element === null ? [] : [element];
  },
})`;

/** 登録の済んだか（Playwright の `selectors` は、この process の中で 1 つ。同じ名前の 2 回目の登録は失敗するので、1 回だけ行う）。 */
let elementPathEngineRegistration: Promise<void> | undefined;

/**
 * 自前の selector engine を、Playwright の `selectors` に登録する（1 回だけ。登録は、すでにある Context にも届く）。utility world で動かす
 * （`contentScript: true`）。すでに同じ名前で登録されていれば、そのまま使う。
 */
export function ensureElementPathEngine(): Promise<void> {
  elementPathEngineRegistration ??= selectors.register(ELEMENT_PATH_ENGINE_NAME, ELEMENT_PATH_ENGINE_SOURCE, { contentScript: true })
    .catch((error: unknown) => {
      if (String(error).includes('has been already registered')) {
        return;
      }
      elementPathEngineRegistration = undefined;
      throw error;
    });
  return elementPathEngineRegistration;
}

/**
 * 位置の要素の、合図つきの Playwright のセレクタ（`beaksight-element-path=0/1/10;beaksight-…`）。使う前に `ensureElementPathEngine` を済ませ、
 * 合図の受け手を付けておく（`src/discovery/isolated-read.ts` の `withSignaledElements`）。
 */
export const elementPathSelectorOf = (path: readonly number[], signal: string): string =>
  `${ELEMENT_PATH_ENGINE_NAME}=${path.join(ELEMENT_PATH_SEPARATOR)}${ELEMENT_PATH_SIGNAL_SEPARATOR}${signal}`;

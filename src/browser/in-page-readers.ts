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
   * （今までの `discover-links.ts` の `shadowRootGetter?.call(…)` と同じ）。
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
  return { standardGetter, optionalStandardGetter, standardProperty, documentProperty, elementPathOf, elementAtPath };
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

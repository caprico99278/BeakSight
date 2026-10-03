/**
 * Browser の Proxy（テストの補助。CC-029 で1か所にまとめた）。
 *
 * - 製品のコード（Guard、factory、PREFLIGHT、Run Coordinator）を変えずに、Context の作成の失敗や、閉じる処理が終わらない状態を作る。
 * - 差し替えたプロパティ以外は、元の Browser のものを返す（関数は元の Browser に束縛する）。
 * - `newContext` の直後に page を開く Proxy（`browserOpeningPageAfterNewContext`）は、多くのテストが使うので、
 *   `browser-opening-page.ts` に置いたまま、ここの `overrideBrowser` を使う。
 */
import type { Browser, BrowserContext } from 'playwright';
import { createDeferred, type Deferred } from './deferred.js';

/** 決して終わらない Promise（止まったままの処理を表す）。 */
export const neverSettles = (): Promise<never> => new Promise<never>(() => undefined);

/** `overrideBrowser` で差し替えられる、Browser のプロパティ。 */
export interface BrowserOverrides {
  readonly newContext?: Browser['newContext'];
  readonly close?: Browser['close'];
}

/**
 * `overrides` のプロパティだけを差し替えた、Browser の Proxy。ほかのプロパティは、元の Browser のものを返す
 * （関数は元の Browser に束縛する）。Proxy を重ねてもよい（外側で差し替えないプロパティは、内側の Proxy が返す）。
 */
export function overrideBrowser(real: Browser, overrides: BrowserOverrides): Browser {
  return new Proxy(real, {
    get(target, property, receiver) {
      if (Object.hasOwn(overrides, property)) {
        return overrides[property as keyof BrowserOverrides];
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** `newContext` が必ず失敗する Browser の Proxy（Guard の取り付けに進まずに、Context の作成が失敗する場合を作る）。 */
export function browserFailingNewContext(real: Browser, message = 'newContext failed in the Safety Gate test'): Browser {
  return overrideBrowser(real, {
    newContext: async (): Promise<never> => {
      throw new Error(message);
    },
  });
}

/** `newContext` が終わらない Browser の Proxy（Context の作成が止まる場合を作る）。 */
export function browserHangingNewContext(real: Browser): Browser {
  return overrideBrowser(real, { newContext: neverSettles });
}

/** `browserStallingContextClose` の指定。 */
export interface StallingContextCloseOptions {
  /**
   * `close()` を止める Context の、`newContext` の呼び出しの順番（1から数える）。省略すると、すべての Context の `close()` を止める。
   */
  readonly contextNumbers?: ReadonlySet<number>;
}

/** `browserStallingContextClose` の結果。 */
export interface StallingContextCloseBrowser {
  /** `newContext` で作った Context の `close()` を、`release()` まで止める Browser の Proxy。 */
  readonly browser: Browser;
  /** 止めた `close()` の呼び出しの回数（すべての Context の合計）。 */
  readonly stalledCloseCalls: () => number;
  /** 止めていた `close()` を進め、作ったすべての Context を閉じる（後片付け）。 */
  release(): Promise<void>;
}

/**
 * `newContext` で作った Context の `close()` を、`release()` まで終わらせない Browser の Proxy（RP18 の指摘4、RP18 の指摘1・2）。
 * - Guard の無効化（`failClosed` の後の Context を閉じる処理）や、環境の読み取りの Context を閉じる処理が終わらない状態を、
 *   製品のコードを変えずに作る。
 * - Context そのものは本物で、`close` だけを、その Context の自身のプロパティで置き換える（`page.context()` が同じ Context を返すので、
 *   Guard の Context と Ledger の対応は保たれる）。
 * - Browser を閉じれば、止めた Context も閉じる。
 */
export function browserStallingContextClose(
  real: Browser,
  options: StallingContextCloseOptions = {},
): StallingContextCloseBrowser {
  const gate: Deferred<void> = createDeferred<void>();
  const created: { readonly context: BrowserContext; readonly close: () => Promise<void> }[] = [];
  let createdCount = 0;
  let stalledCloseCalls = 0;
  const browser = overrideBrowser(real, {
    newContext: async (...args: Parameters<Browser['newContext']>): Promise<BrowserContext> => {
      const context = await real.newContext(...args);
      createdCount += 1;
      if (options.contextNumbers !== undefined && !options.contextNumbers.has(createdCount)) {
        return context;
      }
      const realClose = context.close.bind(context);
      created.push({ context, close: () => realClose() });
      Object.defineProperty(context, 'close', {
        configurable: true,
        writable: true,
        value: async (...closeArgs: Parameters<BrowserContext['close']>): Promise<void> => {
          stalledCloseCalls += 1;
          await gate.promise;
          await realClose(...closeArgs);
        },
      });
      return context;
    },
  });
  return Object.freeze({
    browser,
    stalledCloseCalls: () => stalledCloseCalls,
    async release(): Promise<void> {
      gate.resolve(undefined);
      await Promise.all(created.map(({ close }) => close().catch(() => undefined)));
    },
  });
}

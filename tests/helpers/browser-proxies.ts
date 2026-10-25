/**
 * Browser の Proxy（テストの補助。CC-029 で1か所にまとめた）。
 *
 * - 製品のコード（Guard、factory、PREFLIGHT、Run Coordinator）を変えずに、Context の作成の失敗や、閉じる処理が終わらない状態を作る。
 * - 差し替えたプロパティ以外は、元の Browser のものを返す（関数は元の Browser に束縛する）。
 * - `newContext` の直後に page を開く Proxy（`browserOpeningPageAfterNewContext`）は、多くのテストが使うので、
 *   `browser-opening-page.ts` に置いたまま、ここの `overrideBrowser` を使う。
 */
import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright';
import { wait } from '../../src/core/deadline.js';
import { WEBRTC_BLOCK_INIT_SCRIPT } from '../../src/safety/passive-request-guard.js';
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

/**
 * Context の初期化のスクリプトのうち、内容が `content` と同じものだけを、付けずに捨てる Browser の Proxy（CC-098。Guard が付ける守りの初期化の
 * スクリプトを 1 つだけ外し、その奥の守り（factory の自己検査、起動の引数、中継）を確かめるテストだけが、明示して選ぶ）。
 * - 製品のコードは変えない。`newContext` で作った本物の Context の `addInitScript` を、その Context の自身のプロパティで置き換える
 *   （`page.context()` が同じ Context を返すので、Guard の Context と Ledger の対応は保たれる）。ほかの初期化のスクリプトは、そのまま付ける。
 * - production の起動は Browser を Proxy にしないので、production では外せない。
 */
export function browserWithoutInitScript(real: Browser, content: string): Browser {
  return overrideBrowser(real, {
    newContext: async (options?: BrowserContextOptions): Promise<BrowserContext> => {
      const context = await real.newContext(options);
      const addInitScript = context.addInitScript.bind(context);
      Object.defineProperty(context, 'addInitScript', {
        configurable: true,
        value: async (...args: Parameters<BrowserContext['addInitScript']>): Promise<void> => {
          const [script] = args;
          if (typeof script === 'object' && script !== null && 'content' in script && script.content === content) {
            return;
          }
          await addInitScript(...args);
        },
      });
      return context;
    },
  });
}

/**
 * Guard が Context に付ける WebRTC の入口を塞ぐ初期化のスクリプト（`WEBRTC_BLOCK_INIT_SCRIPT`。DEF-124）だけを、付けずに捨てる Browser の Proxy
 * （起動の引数の守りと中継の CONNECT の守りを確かめるテストだけが、明示して選ぶ。作りは `browserWithoutInitScript`。CC-098。PRE42-CC 組 S2 で
 * `webrtc-egress-blocked.test.ts` と `egress-tunnel-admission.test.ts` の写しをここに寄せた）。
 */
export const browserWithoutWebRtcBlock = (real: Browser): Browser => browserWithoutInitScript(real, WEBRTC_BLOCK_INIT_SCRIPT);

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

/**
 * `newContext` の前に、`delayMsOf` が返す時間（ms）だけ実際に待つ Browser の Proxy（DEF-100 fix。Context の作成が遅い・揺れる環境を作る）。
 * `delayMsOf` には、`newContext` に渡された指定（省略なら `undefined`）を渡す。待った後に、元の `newContext` に同じ指定を渡す。
 */
export function browserDelayingNewContext(
  real: Browser,
  delayMsOf: (options: Parameters<Browser['newContext']>[0]) => number,
): Browser {
  return overrideBrowser(real, {
    newContext: async (...args: Parameters<Browser['newContext']>) => {
      const delayMs = delayMsOf(args[0]);
      await wait(delayMs);
      return await real.newContext(...args);
    },
  });
}

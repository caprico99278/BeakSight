import type { Browser, BrowserContext } from 'playwright';
import { overrideBrowser } from './browser-proxies.js';

export interface BrowserOpeningPageOptions {
  /**
   * page を開く `newContext` の呼び出しの回（1から数える）。省略すると、すべての呼び出しで page を開く。
   * 指定した回以外の呼び出しでは、作った Context をそのまま返す。
   */
  readonly onlyOnCall?: number;
  /** 作ったすべての Context を、page を開く前に受け取る（テストの後片付けに使う）。 */
  readonly onContextCreated?: (context: BrowserContext) => void;
}

/**
 * `newContext` で Context を作った直後に、その Context に page を1つ開く Browser の Proxy（CC-019。テストの補助はここだけに置く）。
 * page が開いている Context では、Guard の取り付けが `GUARD_INSTALLATION_FAILED` で失敗し、Guard が Context を閉じる
 * （Task 14〜17 の設計書 4.3、R14r の Important-1）。
 * `newContext` 以外のプロパティは、元の Browser のものを返す（`overrideBrowser`。ほかの Browser の Proxy は `browser-proxies.ts`）。
 */
export function browserOpeningPageAfterNewContext(real: Browser, options: BrowserOpeningPageOptions = {}): Browser {
  const { onlyOnCall, onContextCreated } = options;
  let calls = 0;
  return overrideBrowser(real, {
    newContext: async (...args: Parameters<Browser['newContext']>): Promise<BrowserContext> => {
      calls += 1;
      const context = await real.newContext(...args);
      onContextCreated?.(context);
      if (onlyOnCall === undefined || calls === onlyOnCall) {
        await context.newPage();
      }
      return context;
    },
  });
}

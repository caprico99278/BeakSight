import type { BrowserContext, Page } from 'playwright';
import type { BrowserContextFactory } from '../../src/browser/context-factory.js';

export interface PassiveResources {
  readonly factory: BrowserContextFactory | undefined;
  readonly context: BrowserContext | undefined;
  /**
   * Context の page。個別には閉じない（Context と一緒に閉じる。DEF-038）。呼び出し側の形を変えないために受け取るが、閉じる手順には
   * 使わない。
   */
  readonly page?: Page | undefined;
}

export interface PassiveCleanupOptions {
  /** factory 経由で context を閉じられなかったとき、`context.close()` で直接閉じる。その失敗は呼び出し側に返す。 */
  readonly forceCloseContextOnFailure?: boolean;
}

/**
 * `afterEach` の後片付け。factory が作った page と context を、factory 経由で閉じる。
 *
 * - page は個別に閉じない。製品と同じく、Context と一緒に閉じる（DEF-038。Guard の付いたページを個別に閉じると、ページを離れるときの
 *   送信が Guard を通らずに出るため。Chromium が page を閉じない場合（DEF-005）も、Context を閉じれば page も閉じる）。
 * - context がまだブラウザにつながっていれば `closePassiveContext` で閉じる。
 *   失敗は無視する（`forceCloseContextOnFailure` のときは `context.close()` で閉じる）。
 * - factory がなければ何もしない。
 */
export async function closePassiveResources(
  { factory, context }: PassiveResources,
  options: PassiveCleanupOptions = {},
): Promise<void> {
  if (factory === undefined) {
    return;
  }
  if (context !== undefined && context.browser() !== null) {
    await factory.closePassiveContext(context).catch(
      options.forceCloseContextOnFailure === true ? () => context.close() : () => undefined,
    );
  }
}

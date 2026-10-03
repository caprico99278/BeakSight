import type { BrowserContext, Page } from 'playwright';
import type { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { closePassivePageBeforeDeadline } from '../../src/orchestration/passive-session-close.js';

export interface PassiveResources {
  readonly factory: BrowserContextFactory | undefined;
  readonly context: BrowserContext | undefined;
  readonly page?: Page | undefined;
}

export interface PassiveCleanupOptions {
  /** factory 経由で context を閉じられなかったとき、`context.close()` で直接閉じる。その失敗は呼び出し側に返す。 */
  readonly forceCloseContextOnFailure?: boolean;
  /**
   * page を閉じる処理を待つ上限（ms。P18e）。省略すると、製品の既定（`PAGE_CLOSE_TIMEOUT_MS`）。
   * page を閉じる処理が止まる場合を確かめるテストは、短い期限を注入して、実際の時間を待たない。
   */
  readonly pageCloseTimeoutMs?: number;
}

/**
 * `afterEach` の後片付け。factory が作った page と context を、factory 経由で閉じる。
 *
 * - page が開いていれば、製品と同じ `closePassivePageBeforeDeadline`（期限は `options.pageCloseTimeoutMs`、既定は
 *   `PAGE_CLOSE_TIMEOUT_MS`）で閉じる。失敗と期限切れは
 *   無視して、context を閉じる処理に進む（DEF-006。Chromium が page を閉じない場合も、context を閉じれば page も閉じる）。
 * - context がまだブラウザにつながっていれば `closePassiveContext` で閉じる。
 *   失敗は無視する（`forceCloseContextOnFailure` のときは `context.close()` で閉じる）。
 * - factory がなければ何もしない。
 */
export async function closePassiveResources(
  { factory, context, page }: PassiveResources,
  options: PassiveCleanupOptions = {},
): Promise<void> {
  if (factory === undefined) {
    return;
  }
  if (page !== undefined && !page.isClosed()) {
    await closePassivePageBeforeDeadline(factory, page, { timeoutMs: options.pageCloseTimeoutMs });
  }
  if (context !== undefined && context.browser() !== null) {
    await factory.closePassiveContext(context).catch(
      options.forceCloseContextOnFailure === true ? () => context.close() : () => undefined,
    );
  }
}

/**
 * 画面のテストのページの補助（CCX-16。CC-071）。画面のテストのファイルごとにあった、記録つきのページを開く関数（CSP の違反・console の誤り・
 * ページの例外・外部への要求の記録）、記録の確かめと後始末、Tab だけでフォーカスを動かす関数、スクリーンショットを、ここに 1 つにした。
 * - 記録の確かめ（`expectCleanPages`）: 開いているページの CSP の違反が 0、すべてのページの console の誤り（`console.error` とページの例外）が 0、
 *   画面のサーバの Origin の外への要求が 0。
 * - 状態（開いたページの記録）は、`createUiPageKit` が返す値の中だけに持つ（テストのファイルごとに 1 つ作る）。
 * - Chromium の context と画面のサーバの Origin は、テストの途中で替わることがある（サーバの再起動）ので、関数で受け取る。
 * - 目印の検査（`*-secret-markers`）は、記録を付けずに開くこともできる（`recordPages: false`。開いたページは閉じるために覚える）。
 */
import { mkdirSync } from 'node:fs';
import type { BrowserContext, Locator, Page } from 'playwright';
import { expect } from 'vitest';

/** ページごとの記録（CSP の違反は、ページの中の `window.__cspViolations` に持つ）。 */
export interface UiPageRecord {
  readonly page: Page;
  readonly consoleErrors: string[];
  readonly externalRequests: string[];
}

/** ページの補助の設定。 */
export interface UiPageKitOptions {
  /** 今の Chromium の context（ない間は `undefined`）。 */
  readonly contextOf: () => BrowserContext | undefined;
  /** 今の画面のサーバの Origin（`http://127.0.0.1:<port>`）。外への要求の判定と、ページを開く URL に使う。 */
  readonly originOf: () => string;
  /** Tab を押す回数の上限（`tabTo`。画面ごとのフォーカスできる要素の数に合わせる）。 */
  readonly maxTabPresses?: number;
  /** スクリーンショットを書くフォルダ（環境変数で渡す。ないときは書かない）。 */
  readonly screenshotDirectory?: string | undefined;
  /**
   * CSP の違反の記録がないページを誤りにするか（既定は偽: 記録がなければ違反 0 と読む）。記録はページを開く前の init script が作るので、
   * 真にすると、init script が動かなかった文書も見逃さない。
   */
  readonly requireCspRecord?: boolean;
  /** 開いたページに記録（CSP の違反、console の誤り、外への要求）を付けるか（既定は真）。偽のときは、ページを閉じるために覚えるだけ。 */
  readonly recordPages?: boolean;
  /** ページを作った直後（記録を付けた後、開く前）に呼ぶ（Server Function の応答を集めるなど）。 */
  readonly onPageCreated?: (page: Page) => void;
  /** ページを開いた後に呼ぶ（画面の HTML を集めるなど）。 */
  readonly afterOpen?: (page: Page) => Promise<void>;
}

/** CSP の違反を、ページの中の `window.__cspViolations` に集める init script（ページを開く前に入れる）。 */
const recordCspViolations = (): void => {
  const violations: string[] = [];
  Object.defineProperty(window, '__cspViolations', { value: violations });
  document.addEventListener('securitypolicyviolation', (event) => violations.push(`${event.violatedDirective} ${event.blockedURI}`));
};

/** 画面のテストのページの補助を作る（状態はこの値の中だけに持つ）。 */
export const createUiPageKit = (options: UiPageKitOptions) => {
  const records: UiPageRecord[] = [];

  /** `page` に記録を付ける（CSP の違反、console の誤り、ページの例外、画面のサーバの Origin の外への要求）。 */
  const recordPage = async (page: Page): Promise<UiPageRecord> => {
    const record: UiPageRecord = { page, consoleErrors: [], externalRequests: [] };
    records.push(record);
    await page.addInitScript(recordCspViolations);
    page.on('console', (message) => {
      if (message.type() === 'error') {
        record.consoleErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => record.consoleErrors.push(String(error)));
    page.on('request', (request) => {
      if (!request.url().startsWith(`${options.originOf()}/`)) {
        record.externalRequests.push(request.url());
      }
    });
    return record;
  };

  /** 記録つきのページを開く（cookie は context が持つ。`networkidle` まで待つ）。 */
  const openPage = async (path: string): Promise<Page> => {
    const context = options.contextOf();
    if (context === undefined) {
      throw new Error('Chromium の context がない');
    }
    const page = await context.newPage();
    if (options.recordPages === false) {
      records.push({ page, consoleErrors: [], externalRequests: [] });
    } else {
      await recordPage(page);
    }
    options.onPageCreated?.(page);
    await page.goto(`${options.originOf()}${path}`, { waitUntil: 'networkidle' });
    await options.afterOpen?.(page);
    return page;
  };

  /** 開いているページの CSP の違反が 0、すべてのページの console の誤りと外への要求が 0。 */
  const expectCleanPages = async (): Promise<void> => {
    for (const record of records) {
      if (record.page.isClosed()) {
        continue;
      }
      const violations = await record.page.evaluate((required) => {
        const recorded = (window as unknown as { __cspViolations?: string[] }).__cspViolations;
        return recorded ?? (required ? ['the CSP violation record is missing'] : []);
      }, options.requireCspRecord === true);
      expect(violations).toEqual([]);
    }
    expect(records.flatMap((record) => record.consoleErrors)).toEqual([]);
    expect(records.flatMap((record) => record.externalRequests)).toEqual([]);
  };

  /** 開いたページを閉じ、記録を捨てる（確かめない）。 */
  const forgetPages = async (): Promise<void> => {
    for (const record of records.splice(0)) {
      if (!record.page.isClosed()) {
        await record.page.close();
      }
    }
  };

  /** 記録を確かめてから、ページを閉じる（各テストの後）。 */
  const expectCleanAndClosePages = async (): Promise<void> => {
    await expectCleanPages();
    await forgetPages();
  };

  /** Tab だけで、対象にフォーカスを動かす（マウスを使わない。上限の回数で動かせなければ誤り）。 */
  const tabTo = async (page: Page, target: Locator): Promise<void> => {
    const maxPresses = options.maxTabPresses;
    if (maxPresses === undefined) {
      throw new Error('Tab を押す回数の上限がない');
    }
    for (let count = 0; count < maxPresses; count += 1) {
      if (await target.evaluate((element) => element === document.activeElement)) {
        return;
      }
      await page.keyboard.press('Tab');
    }
    throw new Error('Tab で対象にフォーカスを動かせなかった');
  };

  /** ページ全体のスクリーンショットを、設定のフォルダ（なければ作る）に `<name>.png` で書く（フォルダの設定がなければ何もしない）。 */
  const screenshot = async (page: Page, name: string): Promise<void> => {
    if (options.screenshotDirectory !== undefined) {
      mkdirSync(options.screenshotDirectory, { recursive: true });
      await page.screenshot({ path: `${options.screenshotDirectory}/${name}.png`, fullPage: true });
    }
  };

  return { records, recordPage, openPage, expectCleanPages, forgetPages, expectCleanAndClosePages, tabTo, screenshot };
};

export type UiPageKit = ReturnType<typeof createUiPageKit>;

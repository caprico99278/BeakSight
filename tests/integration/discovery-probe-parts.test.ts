// COV-6b-1（網羅の設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.3、INV-LIMITS の N26・N27）: 発見の入口（`discoverPageCandidates`）は、
// 画面の候補の数と、走査する要素の数の上限で打ち切らない。候補は部分に分けて読み（`readInParts`）、全部を記録する。本物の factory の Passive の
// Context（Guard つき）と、127.0.0.1 の仮のサイト（一般の文言）で確かめる。Chromium はテストの既定だけ（安全に関わらない読み取りの件数）。
// - 前の上限（候補 500）より多いボタンの画面で、全部のボタンが候補になり、`INCOMPLETE_LIMIT_REACHED` が付かない。
// - 前の上限（要素 100,000）より多い要素の後ろにある form も候補になる。
// - L13（N28〜N30）: 前の上限より多い欄・選択肢・送信先の query の名前と、長い名前を、切らずに記録する。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { discoverPageCandidates } from '../../src/discovery/discover-page.js';
import { InFlightRequestCounter } from '../../src/discovery/settle.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 180_000;
/** 前の候補の上限（500）より多いボタンの数（部分に分けて読む数を、2 つより多くする）。 */
const MANY_BUTTONS = 1_201;
/** 前の要素の上限（100,000）より多い、form の前に置く要素の数。 */
const MANY_ELEMENTS = 100_500;
/** L13: 前の上限（欄 200・選択肢 50・query の名前 50・名前 256 文字）を超える数と長さ。 */
const MANY_FIELDS = 201;
const MANY_OPTIONS = 51;
const MANY_QUERY_NAMES = 51;
const LONG_NAME = 'n'.repeat(300);

const htmlOf = (body: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>部分</title><link rel="icon" href="data:,"></head><body>${body}</body></html>`;
const PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/many-buttons': htmlOf(`<main><h1>一覧</h1>${Array.from({ length: MANY_BUTTONS }, (_value, at) => `<button type="button" id="b${String(at)}">行 ${String(at)}</button>`).join('')}</main>`),
  '/many-elements': htmlOf(`<main><h1>長い画面</h1><div>${'<span></span>'.repeat(MANY_ELEMENTS)}</div>`
    + '<form method="post" action="/save"><label>名前 <input name="name"></label><button type="submit">登録</button></form></main>'),
  // L13（N28〜N30）: 前の上限（欄 200・選択肢 50・送信先の query の名前 50・名前の長さ 256）を超える form。
  '/many-fields': htmlOf(`<main><h1>多い欄</h1><form method="post" action="/save?${Array.from({ length: MANY_QUERY_NAMES }, (_value, at) => `q${String(at)}=1`).join('&')}&${LONG_NAME}=1">`
    + `${Array.from({ length: MANY_FIELDS }, (_value, at) => `<input name="f${String(at)}">`).join('')}`
    + `<input name="${LONG_NAME}"><select name="s">${Array.from({ length: MANY_OPTIONS }, (_value, at) => `<option value="o${String(at)}">選択 ${String(at)}</option>`).join('')}</select>`
    + '<button type="submit">登録</button></form></main>'),
});

describe('COV-6b-1: the discovery reads every candidate in parts (the default test Chromium)', () => {
  let browser: Browser;
  let server: LoopbackHttpServer;

  beforeAll(async () => {
    browser = await launchHeadlessChromium();
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      const page = PAGES[new URL(request.url ?? '/', 'http://127.0.0.1').pathname];
      response.writeHead(page === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(page ?? '');
    });
  });

  afterAll(async () => {
    await server?.close();
    await browser?.close();
  });

  const discover = async (path: string): Promise<Awaited<ReturnType<typeof discoverPageCandidates>>> => {
    const config = createTestConfig(server.origin);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop);
    try {
      const page = await factory.createPassivePage(context);
      const counter = new InFlightRequestCounter(page);
      await page.goto(`${server.origin}${path}`);
      const record = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([server.origin]) }, requestCounter: counter });
      counter.dispose();
      return record;
    } finally {
      await closePassiveResources({ factory, context });
      await factory.close();
    }
  };

  it(`records all ${String(MANY_BUTTONS)} buttons (more than the former limit of 500 candidates)`, async () => {
    const record = await discover('/many-buttons');
    expect(record.candidates.filter((candidate) => candidate.kind === 'BUTTON')).toHaveLength(MANY_BUTTONS);
    expect(record.incompleteReasons).not.toContain('INCOMPLETE_LIMIT_REACHED');
  }, TEST_TIMEOUT_MS);

  it(`records the form after ${String(MANY_ELEMENTS)} elements (more than the former limit of 100,000 elements)`, async () => {
    const record = await discover('/many-elements');
    expect(record.candidates.filter((candidate) => candidate.kind === 'FORM')).toHaveLength(1);
    expect(record.incompleteReasons).not.toContain('INCOMPLETE_LIMIT_REACHED');
  }, TEST_TIMEOUT_MS);

  it('records every field, option and query name of a form, with the long names (L13: more than the former limits)', async () => {
    const record = await discover('/many-fields');
    const form = record.candidates.find((candidate) => candidate.kind === 'FORM');
    expect(form?.fields.map(({ name }) => name)).toEqual([...Array.from({ length: MANY_FIELDS }, (_value, at) => `f${String(at)}`), LONG_NAME, 's']);
    expect(form?.fields.at(-1)).toMatchObject({ omittedOptionCount: 0 });
    expect(form?.fields.at(-1)?.options).toHaveLength(MANY_OPTIONS);
    expect(form?.action?.queryNames).toHaveLength(MANY_QUERY_NAMES + 1);
    expect(form?.action?.queryNames.at(-1)).toBe(LONG_NAME);
    expect(record.incompleteReasons).not.toContain('INCOMPLETE_LIMIT_REACHED');
  }, TEST_TIMEOUT_MS);
});

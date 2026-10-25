// FM2e（手を減らす段 2 の設計書 3A.4）: ログインの 3 つの欄（ユーザー名・パスワード・送信）の検出の部品（`readLoginFormFields`。入口の確かめと、手動の
// ログインの段の始めの観察が共用する。`src/worker/entry-check-page.ts`）を、本物の page（isolated world の読み取り）で確かめる。Chromium はテストの既定の
// headless と CLI の起動の設定の両方。
// - 各欄の見える候補がちょうど 1 つなら、その一意な CSS の案を出す。0 なら案なし（数は 0）。2 つ以上なら案なし（数は数える）。
// - 欄の値は読まない: 属性の `value` と、入れた値（目印）は、結果のどこにも出ない。
// 例の値は匿名の値だけ。
import { randomBytes, randomUUID } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readLoginFormFields } from '../../src/worker/entry-check-page.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 120_000;
/** 実行ごとの目印（値を出力しない。比べるときは真偽だけを見る）。 */
const VALUE_MARKER = `fm2e-value-${randomUUID()}`;
const TYPED_MARKER = `fm2e-typed-${randomUUID()}`;
/** 秘密に見える値（64 桁の 16 進。実行ごと）。 */
const SECRET_HEX = `${randomUUID()}${randomUUID()}`.split('-').join('');
/** 実行ごとの、案に入れてはいけない値の形（レビューの D5 の形。匿名の合成の値）。 */
const base64Of = (bytes: number): string => randomBytes(bytes).toString('base64').replace(/[+/=]/gu, 'x');
const SECRET_SHAPES: readonly (readonly [string, string])[] = [
  ['hex64', randomBytes(32).toString('hex')],
  ['hex32', randomBytes(16).toString('hex')],
  ['hex16', randomBytes(8).toString('hex')],
  ['uuid', randomUUID()],
  ['jwt-like', `eyJ${base64Of(18)}.eyJ${base64Of(24)}.${base64Of(24)}`],
  ['prefixed-hex', `user_${randomBytes(16).toString('hex')}`],
  ['bracket', `login[${randomBytes(16).toString('hex')}]`],
  ['email-like', 'someone@example.com'],
  ['digits-12', '482910374615'],
];
/** ふつうの名前と、その案（今どおり使う）。 */
const PLAIN_NAMES: readonly (readonly ['id' | 'name', string, string])[] = [
  ['id', 'username', '#username'],
  ['name', 'username', 'input[name="username"]'],
  ['name', 'login[email]', 'input[name="login[email]"]'],
  ['id', 'login-email-2', '#login-email-2'],
];

/** 3 つの欄がちょうど 1 つずつある画面（属性の `value` に目印を入れる）。 */
const ONE_EACH = `<form id="login-form" action="/session" method="post">
  <input id="email" name="email" type="email" value="${VALUE_MARKER}">
  <input name="password" type="password" value="${VALUE_MARKER}">
  <button type="submit">ログイン</button>
</form>`;

describe.each(LAUNCHERS)('FM2e: detecting the login fields without reading the values (%s)', (_label, launch) => {
  let browser: Browser | undefined;

  beforeAll(async () => {
    browser = await launch();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
  });

  const withPage = async <T>(html: string, use: (page: Page) => Promise<T>): Promise<T> => {
    const page = await (browser as Browser).newPage();
    try {
      await page.setContent(html);
      return await use(page);
    } finally {
      await page.close();
    }
  };

  it('proposes the unique CSS of each field with exactly one candidate, and never reads the values', async () => {
    const reading = await withPage(ONE_EACH, async (page) => {
      await page.locator('#email').fill(TYPED_MARKER);
      await page.locator('input[type="password"]').fill(TYPED_MARKER);
      return readLoginFormFields(page);
    });
    expect(reading?.fields).toEqual({
      username: { candidates: 1, selector: '#email' },
      password: { candidates: 1, selector: 'input[name="password"]' },
      submit: { candidates: 1, selector: 'button[type="submit"]' },
    });
    expect(reading?.placement).toBe('SAME');
    const text = JSON.stringify(reading);
    expect(text.includes(VALUE_MARKER)).toBe(false);
    expect(text.includes(TYPED_MARKER)).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('proposes nothing for a field without a candidate', async () => {
    const reading = await withPage('<form><input id="q" name="q" type="search"><button type="submit">検索</button></form>', readLoginFormFields);
    expect(reading?.fields.username).toEqual({ candidates: 0, selector: null });
    expect(reading?.fields.password).toEqual({ candidates: 0, selector: null });
  }, TEST_TIMEOUT_MS);

  // FM2R の Minor 14（レビューの D3 の形）: 秘密に見える `id`・`name`（64 桁の 16 進など。判定は `isValueLikeText`）は、案の CSS に使わない。ほかの形
  // （`tag[type="…"]`）がちょうど 1 つに当たれば、それを案にする。値は、どの結果にも出ない。
  it('never puts a secret-looking id or name into the proposals, and falls back to another unique form', async () => {
    const reading = await withPage(`<form action="/session" method="post">
      <input id="t${SECRET_HEX}" type="text">
      <input name="p${SECRET_HEX}" type="password">
      <input id="pw-${SECRET_HEX}" name="pw_${SECRET_HEX}" type="hidden">
      <button id="go-${SECRET_HEX}" type="submit">ログイン</button>
    </form>`, readLoginFormFields);
    expect(JSON.stringify(reading).includes(SECRET_HEX)).toBe(false);
    expect(reading?.fields).toEqual({
      username: { candidates: 1, selector: 'input[type="text"]' },
      password: { candidates: 1, selector: 'input[type="password"]' },
      submit: { candidates: 1, selector: 'button[type="submit"]' },
    });
  }, TEST_TIMEOUT_MS);

  // FM2R の確かめ直しの R-2（レビューの D5 の形）: 値の形ごとに、`id` と `name` に入れても案に入らない（UUID、16 桁の 16 進、角括弧の中の 16 進、
  // 12 桁の数字などを含む）。ふつうの名前（`username`・`login[email]`）は、今どおり案に使う。
  it('never puts a value of any secret-looking shape into the proposals, and still uses the plain names', async () => {
    const carried: string[] = [];
    for (const [label, value] of SECRET_SHAPES) {
      for (const attribute of ['id', 'name'] as const) {
        const reading = await withPage(`<input type="text" class="other"><form action="/session" method="post">
          <input type="text" ${attribute}="${value.split('"').join('&quot;')}"><input type="password" name="pw"><button type="submit">ログイン</button>
        </form>`, readLoginFormFields);
        const text = JSON.stringify(reading);
        if (text.includes(value) || value.split(/[^A-Za-z0-9]+/u).some((part) => part.length >= 8 && text.includes(part))) {
          carried.push(`${label}/${attribute}`);
        }
      }
    }
    expect(carried).toEqual([]);
    for (const [attribute, value, selector] of PLAIN_NAMES) {
      const reading = await withPage(`<input type="text" class="other"><form action="/session" method="post">
        <input type="text" ${attribute}="${value}"><input type="password" name="pw"><button type="submit">ログイン</button>
      </form>`, readLoginFormFields);
      expect(reading?.fields.username.selector, `${attribute}=${value}`).toBe(selector);
    }
  }, TEST_TIMEOUT_MS);

  it('proposes nothing for a field with two or more candidates, and still proposes the other fields', async () => {
    const reading = await withPage(`<form>
      <input id="user" name="user" type="text"><input id="tenant" name="tenant" type="text">
      <input id="secret" name="secret" type="password">
      <button id="go" type="submit">ログイン</button><button id="again" type="submit">もう一度</button>
    </form>`, readLoginFormFields);
    expect(reading?.fields).toEqual({
      username: { candidates: 2, selector: null },
      password: { candidates: 1, selector: '#secret' },
      submit: { candidates: 2, selector: null },
    });
  }, TEST_TIMEOUT_MS);
});

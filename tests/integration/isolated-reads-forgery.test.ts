// T32j-4（Task 32 の設計書 4.4 の「CC-068 の設計」の 2 と 4。DEF-087・DEF-089 の残り）: ログインの form の事前の確かめ（`inspectLoginForm`）と、
// Interaction の候補の発見・解決・読み取り（`discoverInteractionCandidates`・`resolveInteractionCandidateHandle`・
// `inspectInteractionCandidateHandle`）を isolated world で読む。ページの JS の偽り（`tests/helpers/page-forgery.ts`: `Function.prototype.call`、
// `getOwnPropertyDescriptor`、prototype の getter、`bind`・`apply`、戻り値の直列化を狙う偽り、走査の偽り、DOM clobbering）の下でも、偽りのない
// ページと同じ結果を返し、読む間にページの JS が走らない（CSP あり・なし）。
// - 修正の前（main world の読み取り）は、prototype の getter などの偽りで、ログインの form を `METHOD_NOT_POST` などと読み、候補の発見は
//   走査の偽りで候補を見失った（RED は T32j-4 の報告に記録）。
// - 「名前つきの要素がプロパティを隠すこと」は main world の前提にしない（isolated world では起きるとは限らない）。結果だけを比べる。
// Chromium は headless だけ（テストの既定と、CLI の起動の設定の両方）。サーバは 127.0.0.1 のテストの中のサーバだけ。
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectLoginForm, type LoginFormSelectors, type LoginFormTarget } from '../../src/browser/login-form-submitter.js';
import {
  discoverInteractionCandidates,
  inspectInteractionCandidateHandle,
  resolveInteractionCandidateHandle,
} from '../../src/interaction/discover-candidates.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import {
  PAGE_FORGERY_KINDS,
  PAGE_FORGERY_SCRIPT_PATH,
  pageForgeryHtml,
  pageForgeryInstalled,
  pageForgeryScript,
  readPageHits,
  type PageForgeryKind,
} from '../helpers/page-forgery.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;

const STRICT_CSP = "script-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const LOGIN_ACTION_PATH = '/login';
const LOGIN_SELECTORS: LoginFormSelectors = Object.freeze({ username: '#user', password: '#pass', submit: '#go' });
/** ログインの form と、Interaction の候補（開閉のボタン 2 つ）のページ。 */
const BODY = [
  `<form id="f" method="post" action="${LOGIN_ACTION_PATH}">`,
  '<input id="user" name="user" type="email"><input id="pass" name="pass" type="password"><button id="go" type="submit">Sign in</button>',
  '</form>',
  '<button id="c0" type="button" aria-expanded="false" aria-controls="p0">Open first</button><div id="p0" hidden>first panel</div>',
  '<button id="c1" type="button" aria-expanded="false" aria-controls="p1">Open second</button><div id="p1" hidden>second panel</div>',
].join('');

describe.each(LAUNCHERS)('T32j-4: the login form check and the interaction candidates read in the isolated world (%s)', (_label, launch) => {
  let browser: Browser;
  let server: LoopbackHttpServer;

  beforeAll(async () => {
    browser = await launch();
    server = await startLoopbackHttpServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === PAGE_FORGERY_SCRIPT_PATH) {
        response.writeHead(200, { 'content-type': 'text/javascript' }).end(pageForgeryScript(url.searchParams.get('k')));
        return;
      }
      const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
      if (url.searchParams.get('csp') === '1') {
        headers['content-security-policy'] = STRICT_CSP;
      }
      if (url.pathname !== '/page') {
        response.writeHead(404, headers).end();
        return;
      }
      response.writeHead(200, headers).end(pageForgeryHtml(BODY, url.searchParams.get('k') ?? 'none'));
    });
  });
  afterAll(async () => {
    await server.close();
    await browser.close();
  });

  const open = async (kind: PageForgeryKind | 'none', csp: boolean): Promise<Page> => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/page?k=${kind}&csp=${csp ? '1' : '0'}`);
    return page;
  };
  const loginTarget = (page: Page): LoginFormTarget => ({
    username: page.locator(`css=${LOGIN_SELECTORS.username}`),
    password: page.locator(`css=${LOGIN_SELECTORS.password}`),
    submit: page.locator(`css=${LOGIN_SELECTORS.submit}`),
    selectors: LOGIN_SELECTORS,
    isAllowedAction: (actionUrl) => actionUrl === `${server.origin}${LOGIN_ACTION_PATH}`,
  });
  /** 候補の比べる項目（位置と時刻に左右されない項目）。 */
  const projected = (candidates: Awaited<ReturnType<typeof discoverInteractionCandidates>>['candidates']) =>
    candidates.map(({ ordinal, tagName, accessibleName, ariaExpanded, ariaControls, type, visible }) =>
      ({ ordinal, tagName, accessibleName, ariaExpanded, ariaControls, type, visible }));

  describe.each([false, true])('with CSP %s', (csp) => {
    let truth: { readonly discovered: unknown; readonly inspected: unknown };

    beforeAll(async () => {
      const page = await open('none', csp);
      try {
        const discovered = await discoverInteractionCandidates(page);
        const resolution = await resolveInteractionCandidateHandle(page, 1);
        if (resolution.status !== 'FOUND') throw new Error('not found');
        try {
          const snapshot = await inspectInteractionCandidateHandle(resolution.reference, 1);
          if (snapshot.status !== 'CONNECTED') throw new Error('not connected');
          truth = { discovered: projected(discovered.candidates), inspected: projected([snapshot.candidate]) };
        } finally {
          await resolution.reference.handle.dispose();
        }
        expect(discovered.candidates.map(({ accessibleName }) => accessibleName)).toEqual(['Sign in', 'Open first', 'Open second']);
      } finally { await page.close(); }
    });

    it('reads the login form as valid without page JS forgery', async () => {
      const page = await open('none', csp);
      try {
        expect(await inspectLoginForm(loginTarget(page))).toEqual({ ok: true });
      } finally { await page.close(); }
    });

    it.each([...PAGE_FORGERY_KINDS])('reads the login form honestly and runs no page JS when the page forges by %s', async (kind) => {
      const page = await open(kind, csp);
      try {
        expect(await pageForgeryInstalled(page)).toBe(true);
        const before = await readPageHits(page);
        expect(await inspectLoginForm(loginTarget(page))).toEqual({ ok: true });
        expect(await readPageHits(page)).toBe(before);
      } finally { await page.close(); }
    });

    it.each([...PAGE_FORGERY_KINDS])('discovers, resolves and inspects the candidates honestly and runs no page JS when the page forges by %s', async (kind) => {
      const page = await open(kind, csp);
      try {
        expect(await pageForgeryInstalled(page)).toBe(true);
        const before = await readPageHits(page);
        const discovered = await discoverInteractionCandidates(page);
        expect(projected(discovered.candidates)).toEqual(truth.discovered);
        expect(await readPageHits(page)).toBe(before);
        // 操作に使う handle を得る所（`elementHandleOf`。Playwright の Locator）では、Playwright の main world の部品が組み込みを呼びうる（調査
        // T32j-3 の Bx。`bind` の偽りで 16 回）。handle の要素は、isolated world で同じ backendNodeId を指すことを確かめ直すので偽れない。
        // 読み取り（発見と、保持した要素の読み取り）の間は、ページの JS が走らない。
        const resolution = await resolveInteractionCandidateHandle(page, 1);
        if (resolution.status !== 'FOUND') throw new Error('not found');
        const afterResolution = await readPageHits(page);
        try {
          const snapshot = await inspectInteractionCandidateHandle(resolution.reference, 1);
          expect(snapshot.status).toBe('CONNECTED');
          expect(snapshot.status === 'CONNECTED' ? projected([snapshot.candidate]) : null).toEqual(truth.inspected);
          expect(await readPageHits(page)).toBe(afterResolution);
        } finally {
          await resolution.reference.handle.dispose();
        }
      } finally { await page.close(); }
    });
  });

  it('stops with FORM_UNREADABLE when a selector crosses into a shadow root (Playwright counts it, the standard CSS does not)', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<div id="host"><template shadowrootmode="open"><form method="post" action="${server.origin}${LOGIN_ACTION_PATH}">`
        + '<input id="user" type="email"><input id="pass" type="password"><button id="go" type="submit">Sign in</button></form></template></div>');
      const selectors: LoginFormSelectors = { username: '#host #user', password: '#pass', submit: '#go' };
      const target: LoginFormTarget = {
        ...loginTarget(page),
        username: page.locator(`css=${selectors.username}`),
        selectors,
      };
      expect(await page.locator(`css=${selectors.username}`).count()).toBe(1);
      expect(await inspectLoginForm(target)).toEqual({ ok: false, reason: 'FORM_UNREADABLE' });
      // shadow root の中の要素そのものを指す標準の CSS なら、読める。
      expect(await inspectLoginForm({ ...loginTarget(page), username: page.locator('css=#user'), selectors: { ...selectors, username: '#user' } }))
        .toEqual({ ok: true });
    } finally { await page.close(); }
  });

  it('stops with FORM_UNREADABLE when a selector is a Playwright-only form (the saved settings stop at the run)', async () => {
    const page = await open('none', false);
    try {
      const selectors: LoginFormSelectors = { ...LOGIN_SELECTORS, submit: '#go:has-text("Sign in")' };
      const target: LoginFormTarget = { ...loginTarget(page), submit: page.locator(`css=${selectors.submit}`), selectors };
      expect(await page.locator(`css=${selectors.submit}`).count()).toBe(1);
      expect(await inspectLoginForm(target)).toEqual({ ok: false, reason: 'FORM_UNREADABLE' });
    } finally { await page.close(); }
  });
});

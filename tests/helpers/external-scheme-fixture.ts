/**
 * 外部スキームへの移動の fixture と、その確かめ方の補助（C18a、C18b、C18g、C18i。DEF-012、GATE-S03。CC-029 で1か所にまとめた）。
 *
 * - 宛先は、どれも実在しないものだけである。値の定義は `fixtures/external-scheme-targets.ts` の1か所にあり、ここは
 *   それを export し直す（`fixtures/server.ts` も、同じファイルから import する）。`fixtures/site/external-scheme-*.html` の
 *   スクリプトは、値を import できないので複製を持つ。同じ値であることは、`tests/unit/external-scheme-fixture.test.ts` で
 *   確かめる（CC-031）。
 * - 経路の名前は、fixture のクエリの `via` の値（`location-href` など）にそろえる。
 * - 別のサイトの iframe（OOPIF）の fixture は、同じ fixture のサーバを、別のホスト名（`127.0.0.1` と `localhost`）で読む。
 */
import type { Page } from 'playwright';
import type { PageAuditResult } from '../../src/core/contracts.js';
import type { ExternalSchemeNavigationEvent } from '../../src/core/evidence-types.js';
import {
  EXTERNAL_SCHEME_KEYS,
  EXTERNAL_SCHEME_TARGETS,
  type ExternalSchemeKey,
} from '../../fixtures/external-scheme-targets.js';

// ---------------------------------------------------------------------------------------------------------------
// 宛先と経路
// ---------------------------------------------------------------------------------------------------------------

/** 外部スキームの宛先（値の定義は `fixtures/external-scheme-targets.ts`。既存のテストの import を変えないため、export し直す）。 */
export { EXTERNAL_SCHEME_KEYS, EXTERNAL_SCHEME_TARGETS, type ExternalSchemeKey };

/**
 * 外部スキームへの移動の経路（Task 19 の前の整理の設計書 4.1）。`window.open` は、別の違反になるので含めない。
 * - `button-click` 以外は、`/external-scheme-navigation.html?via=<経路>&to=<スキーム>` のページのスクリプトが、読み込みの後に自分で試みる。
 * - `button-click` は、`/external-scheme-button.html?to=<スキーム>` のボタン（`href` を持たない `button`）の本物の click で移動する。
 */
export const EXTERNAL_SCHEME_ROUTES = Object.freeze([
  'location-href',
  'location-assign',
  'meta-refresh',
  'iframe-src',
  'anchor-click',
  'form-action',
  'button-click',
] as const);
export type ExternalSchemeRoute = (typeof EXTERNAL_SCHEME_ROUTES)[number];

/** Chromium が、`route` の移動のリクエストに付ける URL（form の GET の送信は、空のクエリの `?` が付く）。 */
export function externalSchemeRequestUrl(route: ExternalSchemeRoute, key: ExternalSchemeKey): string {
  const { url } = EXTERNAL_SCHEME_TARGETS[key];
  return route === 'form-action' ? `${url}?` : url;
}

/** `route` の移動を行う frame の種類（iframe の src だけが subframe）。 */
export function externalSchemeFrame(route: ExternalSchemeRoute): 'MAIN' | 'SUB' {
  return route === 'iframe-src' ? 'SUB' : 'MAIN';
}

// ---------------------------------------------------------------------------------------------------------------
// fixture のパス
// ---------------------------------------------------------------------------------------------------------------

/** 読み込みの後に、ページのスクリプトが外部スキームへの移動を試みる fixture のパス名。 */
export const EXTERNAL_SCHEME_NAVIGATION_PAGE = '/external-scheme-navigation.html';
/** ボタンの click で外部スキームへ移動する fixture のパス名。 */
export const EXTERNAL_SCHEME_BUTTON_PAGE = '/external-scheme-button.html';
/** `EXTERNAL_SCHEME_BUTTON_PAGE` のボタンの名前（Interaction の候補のアクセシブルネーム）。 */
export const EXTERNAL_SCHEME_BUTTON_NAME = 'Open external application';
/** iframe で `EXTERNAL_SCHEME_REDIRECT_PATH` を読む、fixture のページのパス名（`fixtures/site/`）。 */
export const EXTERNAL_SCHEME_REDIRECT_FRAME_PAGE = '/external-scheme-redirect-frame.html';
/** `302 Location: <外部スキーム>` を返す、fixture のサーバの経路（宛先は、サーバの中の固定の一覧。`fixtures/server.ts`）。 */
export const EXTERNAL_SCHEME_REDIRECT_PATH = '/__external-scheme-redirect';
/** 同じ Origin へ、1.5秒待ってから 302 を返す、fixture のサーバの経路（DEF-013）。 */
export const SLOW_REDIRECT_PATH = '/__slow-redirect';
/**
 * スクリプトも外部への参照もない、静かなページ（`fixtures/site/navigation-target.html`）。
 * `/__slow-redirect` の宛先であり、OOPIF の fixture のボタンが一番上の frame を移動させる宛先でもある。
 */
export const NAVIGATION_TARGET_PAGE = '/navigation-target.html';
/** `NAVIGATION_TARGET_PAGE` の見出しと title。 */
export const NAVIGATION_TARGET_HEADING = 'Fixture Navigation Target';
/** 別のホスト名（`127.0.0.1` と `localhost` を入れ替える）の iframe を加える、fixture のページ（`fixtures/site/`）。 */
export const CROSS_SITE_FRAME_PAGE = '/cross-site-frame.html';
/** 読み込みの後に、自分で移動する iframe の中のページ（`fixtures/site/`）。 */
export const SELF_NAVIGATING_FRAME_PAGE = '/self-navigating-frame.html';

/** `route` と `key` の fixture のパス（クエリを含む）。 */
export function externalSchemeFixturePath(route: ExternalSchemeRoute, key: ExternalSchemeKey): string {
  return route === 'button-click'
    ? `${EXTERNAL_SCHEME_BUTTON_PAGE}?to=${key}`
    : `${EXTERNAL_SCHEME_NAVIGATION_PAGE}?via=${route}&to=${key}`;
}

/** `route` の fixture のパス名（サーバが記録する `pathname`。クエリを含まない）。 */
export function externalSchemeFixturePathname(route: ExternalSchemeRoute): string {
  return route === 'button-click' ? EXTERNAL_SCHEME_BUTTON_PAGE : EXTERNAL_SCHEME_NAVIGATION_PAGE;
}

/** `key` の宛先へリダイレクトする、fixture のサーバの経路のパス（クエリを含む）。 */
export const externalSchemeRedirectPath = (key: ExternalSchemeKey): string => `${EXTERNAL_SCHEME_REDIRECT_PATH}?to=${key}`;
/** iframe で `key` の宛先へのリダイレクトを読む、fixture のページのパス（クエリを含む）。 */
export const externalSchemeRedirectFramePath = (key: ExternalSchemeKey): string => `${EXTERNAL_SCHEME_REDIRECT_FRAME_PAGE}?to=${key}`;

/** `cross-site-frame.html` で、別のホスト名の iframe に `framePath` を読ませるパス（入れ子にする場合は、`framePath` に同じ形を渡す）。 */
export const crossSiteFramePath = (framePath: string): string => `${CROSS_SITE_FRAME_PAGE}?src=${encodeURIComponent(framePath)}`;
/**
 * iframe の中で、読み込みの後に `to` へ自分で移動するページのパス。`to` を省略すると、移動しない（ボタンだけのページ）。
 * `to` は、`tel`・`mailto`・`custom`（外部スキームへのリダイレクト）、`slow`（遅いリダイレクト）、`post-form`（POST の form の送信）。
 */
export const selfNavigatingFramePath = (to?: ExternalSchemeKey | 'slow' | 'post-form'): string =>
  (to === undefined ? SELF_NAVIGATING_FRAME_PAGE : `${SELF_NAVIGATING_FRAME_PAGE}?to=${to}`);

/** `origin`（`127.0.0.1` の fixture のサーバ）と同じサーバを、別のホスト名（`localhost`）で読む Origin（別のサイト）。 */
export function crossSiteOriginOf(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//localhost:${url.port}`;
}

// ---------------------------------------------------------------------------------------------------------------
// 移動の試み（Guard のない対照の Context と、Guard の付いた Context の両方で使う）
// ---------------------------------------------------------------------------------------------------------------

/**
 * ページの中で、`route` の経路で `url` への移動を試みる（fixture の `external-scheme-navigation.html` の経路と同じ処理を、
 * 読み込みの後の任意の時点で行う）。`button-click` は、ボタンを加え、Playwright の本物の click で押す。
 */
export async function attemptExternalSchemeNavigation(page: Page, route: ExternalSchemeRoute, url: string): Promise<void> {
  if (route === 'button-click') {
    await page.evaluate((target) => {
      const button = document.createElement('button');
      button.id = 'external-scheme-trigger';
      button.textContent = 'Go';
      button.addEventListener('click', () => {
        window.location.href = target;
      });
      document.body.append(button);
    }, url);
    await page.click('#external-scheme-trigger');
    return;
  }
  await page.evaluate(({ kind, target }) => {
    switch (kind) {
      case 'location-href':
        window.location.href = target;
        return;
      case 'location-assign':
        window.location.assign(target);
        return;
      case 'meta-refresh': {
        const meta = document.createElement('meta');
        meta.httpEquiv = 'refresh';
        meta.content = `0;url=${target}`;
        document.head.append(meta);
        return;
      }
      case 'iframe-src': {
        const frame = document.createElement('iframe');
        frame.src = target;
        document.body.append(frame);
        return;
      }
      case 'anchor-click': {
        const anchor = document.createElement('a');
        anchor.href = target;
        anchor.textContent = 'link';
        document.body.append(anchor);
        anchor.click();
        return;
      }
      case 'form-action': {
        const form = document.createElement('form');
        form.method = 'get';
        form.action = target;
        document.body.append(form);
        form.submit();
        return;
      }
      default:
        throw new Error(`unknown navigation route: ${kind}`);
    }
  }, { kind: route, target: url });
}

// ---------------------------------------------------------------------------------------------------------------
// 確かめ方
// ---------------------------------------------------------------------------------------------------------------

/** ページのスクリプトによる、`route` の経路の `key` への移動の試みの、Ledger の記録。 */
export function externalSchemeAttemptRecord(
  route: ExternalSchemeRoute,
  key: ExternalSchemeKey,
  phase: ExternalSchemeNavigationEvent['phase'],
): ExternalSchemeNavigationEvent {
  return {
    url: externalSchemeRequestUrl(route, key),
    scheme: EXTERNAL_SCHEME_TARGETS[key].scheme,
    frame: externalSchemeFrame(route),
    phase,
    reason: 'EXTERNAL_SCHEME_NAVIGATION',
  };
}

/** Guard が、たどる前に止めた、`key` への外部スキームのリダイレクトの、Ledger の記録。 */
export function stoppedRedirectRecord(
  key: ExternalSchemeKey,
  frame: ExternalSchemeNavigationEvent['frame'],
  phase: ExternalSchemeNavigationEvent['phase'] = 'PASSIVE',
): ExternalSchemeNavigationEvent {
  return {
    url: EXTERNAL_SCHEME_TARGETS[key].url,
    scheme: EXTERNAL_SCHEME_TARGETS[key].scheme,
    frame,
    phase,
    reason: 'EXTERNAL_SCHEME_REDIRECT_BLOCKED',
  };
}

/** page の frame の URL のうち、外部スキームの宛先（`EXTERNAL_SCHEME_TARGETS`）のどれかで始まるもの。 */
export function externalSchemeTargetFrameUrls(page: Page): string[] {
  return page.frames().map((frame) => frame.url())
    .filter((url) => EXTERNAL_SCHEME_KEYS.some((key) => url.startsWith(EXTERNAL_SCHEME_TARGETS[key].url)));
}

/** page の、リダイレクトの後の navigation のリクエスト（`<URL> <- <リダイレクトの元の URL>`）を集める。 */
export function collectRedirectedNavigations(page: Page): string[] {
  const redirected: string[] = [];
  page.on('request', (request) => {
    const from = request.redirectedFrom();
    if (request.isNavigationRequest() && from !== null) {
      redirected.push(`${request.url()} <- ${from.url()}`);
    }
  });
  return redirected;
}

/** ページの結果の Safety の Evidence にある、外部スキームへの移動の記録（ページの順）。 */
export function safetyExternalSchemeNavigations(pages: readonly PageAuditResult[]): ExternalSchemeNavigationEvent[] {
  return pages.flatMap((page) => page.evidence.flatMap((record) => (
    record.type === 'safety' ? record.payload.externalSchemeNavigations : []
  )));
}

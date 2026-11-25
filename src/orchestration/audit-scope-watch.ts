/**
 * REV-SD の I-1（設計書 `doc/design/2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4 の「main frame の文書の移動」）: 1 画面の main frame が、点検の範囲の
 * 外（許可 Origin の外・読まないパス・読む範囲の外・危険な語。範囲は呼ぶ側が Run で作る `isOutsideAuditScope`）へ移ったかの判定（判定はここだけ）。
 * Guard は main frame の移動を止めないので、読み込みの後にページが自分で範囲の外へ移っても、移動は届く。移ったと分かった画面では、BeakSight はそれ以降の操作
 * （押下・幅の走査・証拠の取得）をせず、その画面は点検しない（読み込みで移ったときと同じ `BLOCKED_EXTERNAL_REDIRECT`）。
 * - 見張り（`watchAuditScope`）: main frame の移動（`framenavigated`）ごとに URL を判定し、範囲の外の最初の URL を覚える（移った後に戻っても、覚えたまま）。
 * - 操作の直前の見直し: `outsideUrl()` は、覚えた URL がなければ、今の URL も判定する（見張りの取りこぼしの備え）。
 * http(s) でない URL（読み込む前の `about:blank`・誤りの画面・閉じる前に離れた先）は判定しない（範囲の外にしない）。
 * Page Auditor（Desktop・Mobile・幅の走査の各幅・Interaction の Context）と、ワーカーの 1 画面の読み込み（操作さがし・READ の確かめ・入口の確かめ・書き込みの前の確かめ）が使う。
 */
import { normalizeUrl, withRequestedQueryOnSamePath } from '../crawl/normalize-url.js';
import type { PageNavigationResult } from './page-navigation.js';

/** 範囲の判定（呼ぶ側が Run の範囲で作る。真なら範囲の外）。 */
export type AuditScopeJudge = (url: string) => boolean;

/**
 * `url` が範囲の外なら、その URL。http(s) でない URL と範囲の中の URL は `null`。
 * DEF-304（設計書 `2026-11-20-beaksight-audit-precision-and-scope-design.md` 2.1）: 読み込みを頼んだ URL（`requestedUrl`）と Origin と path が同じで、query だけが
 * 違うとき（画面自身が読み込みの後に query を変えた）は、今の query を判定に使わず、頼んだ URL の query に置き換えて判定する（危険な語は、頼んだ URL の query と
 * path で今どおり見る。Origin・読まないパス・読む範囲・セッションの切れは path で決まるので今どおり）。path が違えば、今の URL をそのまま判定する。
 */
export function auditScopeLeftUrl(url: string, isOutside: AuditScopeJudge, requestedUrl: string): string | null {
  return /^https?:/iu.test(url) && isOutside(withRequestedQueryOnSamePath(url, requestedUrl)) ? url : null;
}

/** 見張る page（Playwright の page の形だけ。main frame の移動の事象と、今の URL）。 */
export interface AuditScopeWatchedPage {
  url(): string;
  mainFrame(): unknown;
  on(event: 'framenavigated', listener: (frame: { url(): string }) => void): unknown;
  off(event: 'framenavigated', listener: (frame: { url(): string }) => void): unknown;
}

/** 1 画面の見張り。 */
export interface AuditScopeWatch {
  /** 範囲の外へ移ったと分かった最初の URL（覚えていなければ、今の URL も見直す。外へ移っていなければ `null`）。見張りをやめた後は、覚えた URL だけを返す。 */
  readonly outsideUrl: () => string | null;
  /** 見張りをやめる（何度呼んでもよい）。 */
  readonly dispose: () => void;
}

/** 範囲の判定がなければ、見張らない（いつも `null`）。 */
const UNWATCHED: AuditScopeWatch = Object.freeze({ outsideUrl: () => null, dispose: () => undefined });

/** page ごとの見張り（同じ page を受け取る部品が、操作の直前に見る。見張りをやめた後も、覚えた URL を答える）。 */
const WATCHES = new WeakMap<object, AuditScopeWatch>();

/**
 * `page` が点検の範囲の中か（`watchAuditScope` で見張っている page が範囲の外へ移っていれば偽。見張っていなければ真）。page だけを受け取る部品（知らせの枠を
 * 閉じる押下）が、押す直前に見る。
 */
export function isPageInAuditScope(page: object): boolean {
  return (WATCHES.get(page)?.outsideUrl() ?? null) === null;
}

/** 1 画面の main frame の移動を見張る（`requestedUrl` は読み込みを頼んだ URL）。`isOutside` がなければ見張らない。 */
export function watchAuditScope(page: AuditScopeWatchedPage, isOutside: AuditScopeJudge | undefined, requestedUrl: string): AuditScopeWatch {
  if (isOutside === undefined) {
    return UNWATCHED;
  }
  const watch = startWatch(page, isOutside, requestedUrl);
  WATCHES.set(page, watch);
  return watch;
}

function startWatch(page: AuditScopeWatchedPage, isOutside: AuditScopeJudge, requestedUrl: string): AuditScopeWatch {
  let left: string | null = null;
  let watching = true;
  const judge = (url: string): void => {
    left ??= auditScopeLeftUrl(url, isOutside, requestedUrl);
  };
  const listener = (frame: { url(): string }): void => {
    if (frame === page.mainFrame()) judge(frame.url());
  };
  page.on('framenavigated', listener);
  return Object.freeze({
    outsideUrl: () => {
      if (left === null && watching) {
        try {
          judge(page.url());
        } catch {
          // 閉じた page は、覚えた URL だけで答える。
        }
      }
      return left;
    },
    dispose: () => {
      if (!watching) return;
      watching = false;
      page.off('framenavigated', listener);
    },
  });
}

/**
 * 読み込めた画面（`OK`）が、その後に範囲の外（`outsideUrl`）へ移ったときの読み込みの結果（読み込みで移ったときの `navigatePage` と同じ形。`httpStatus` は
 * `null`、最後の URL は移った先を正規化したもの）。
 */
export function movedOutsideAuditScopeNavigation(
  navigation: PageNavigationResult,
  outsideUrl: string,
  requestedUrl: string,
  allowedQueryParameters: ReadonlySet<string>,
): PageNavigationResult {
  const normalized = normalizeUrl(outsideUrl, requestedUrl, allowedQueryParameters);
  return Object.freeze({
    ...navigation,
    navigationOutcome: 'BLOCKED_EXTERNAL_REDIRECT',
    httpStatus: null,
    finalUrl: normalized.ok ? normalized.url : null,
  });
}

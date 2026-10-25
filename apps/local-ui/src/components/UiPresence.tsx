/**
 * UI-close（設計書 `doc/design/2026-10-19-beaksight-ui-close-stops-server-design.md` の 2 章）: 管理画面のページが開いている間、画面のサーバへ生きている
 * 知らせを送り、閉じるとき（`pagehide`）に閉じたことを知らせる（`navigator.sendBeacon`）。画面のサーバは、どのページも開いていなくなり、動いている
 * ジョブがなければ止まる。口と間隔は `src/security/ui-presence.ts`。何も描かない。
 * - 知らせは、どちらも `navigator.sendBeacon` による同じ Origin への POST（token の cookie が付く）。ページの ID は、読み込みごとの乱数（値を持たない）。
 * - 隠れていたタブが前に出たとき（`visibilitychange`）と、戻る・進むで戻ったとき（`pageshow` の `persisted`）にも、すぐに送る。
 * - 送れなかったとき（画面のサーバが止まった後など）は、何もしない。
 */
import { useEffect } from 'react';
import {
  UI_PRESENCE_ALIVE_PATH,
  UI_PRESENCE_CLOSED_PATH,
  UI_PRESENCE_INTERVAL_MS,
  UI_PRESENCE_PAGE_PARAMETER,
} from '../security/ui-presence';

/** 読み込みごとのページの ID。 */
const newPageId = (): string =>
  (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export function UiPresence() {
  useEffect(() => {
    const pageId = newPageId();
    const urlOf = (path: string): string => `${path}?${new URLSearchParams({ [UI_PRESENCE_PAGE_PARAMETER]: pageId }).toString()}`;
    // 生きている知らせも、閉じたときの知らせと同じ `sendBeacon`（同じ Origin への本文のない POST）で送る（応答を待たない。送れなくても何もしない）。
    const sendAlive = (): void => {
      navigator.sendBeacon(urlOf(UI_PRESENCE_ALIVE_PATH));
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        sendAlive();
      }
    };
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) {
        sendAlive();
      }
    };
    const onPageHide = (): void => {
      navigator.sendBeacon(urlOf(UI_PRESENCE_CLOSED_PATH));
    };
    sendAlive();
    const timer = window.setInterval(sendAlive, UI_PRESENCE_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);
  return null;
}

/**
 * UI-close（設計書 `doc/design/2026-10-19-beaksight-ui-close-stops-server-design.md` の 2 章）: 管理画面のページの知らせから、画面のサーバを止めるかを
 * 決める部品と、知らせの口の受け手。本番の起動の部品（`serve.ts`）が使う（口と間隔の値は `src/security/ui-presence.ts`）。
 * - 止める決まり: 起動の後にページが一度は生きている知らせを送り、どのページも開いていない（閉じた知らせで最後のページが閉じたときは猶予の後、
 *   知らせが途絶えたページは途絶えの上限の後）、かつ動いているジョブがない。ジョブが動いている間は止めず、確かめの度に確かめ直す（ジョブが
 *   終わった後に止まる。その間にページが開き直せば止めない）。止めるのは 1 回だけ（`onIdle`）。
 * - 知らせの口: 要求の守り（`request-guard.ts`。Host、token の cookie）を通った要求のうち、知らせの口のパスだけを受ける。POST だけで、`Origin` が
 *   画面のサーバの Origin と同じ、`Sec-Fetch-Site` があれば `same-origin` のときだけ受け（204）、ほかは 403。
 * Node の型の除去で動くので、消せる型の書き方だけを使う。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  UI_PRESENCE_ALIVE_PATH,
  UI_PRESENCE_CLOSED_PATH,
  UI_PRESENCE_PAGE_ID_PATTERN,
  UI_PRESENCE_PAGE_PARAMETER,
} from '../src/security/ui-presence.ts';

/** 判定の部品の指定。 */
export interface PresenceMonitorOptions {
  /** 閉じた知らせで最後のページが閉じた後、止めるまでの猶予（ms）。 */
  readonly closedGraceMs: number;
  /** 生きている知らせが途絶えたページを、閉じたと見なすまでの上限（ms）。 */
  readonly silenceLimitMs: number;
  /** 動いている監査のジョブの数。 */
  readonly runningJobCount: () => number;
  /** 止める決まりがそろったとき（1 回だけ）。 */
  readonly onIdle: () => void;
  /** 今の時刻（ms。既定は `Date.now`。テストは注入する）。 */
  readonly now?: () => number;
}

/** 判定の部品。 */
export interface PresenceMonitor {
  /** 生きている知らせ（ページの ID）。 */
  alive(pageId: string): void;
  /** 閉じたときの知らせ（ページの ID）。 */
  closed(pageId: string): void;
  /** 止める決まりを確かめる（間隔ごとに呼ぶ）。 */
  check(): void;
}

export const createPresenceMonitor = (options: PresenceMonitorOptions): PresenceMonitor => {
  const now = options.now ?? Date.now;
  /** 開いているページの ID と、最後の生きている知らせの時刻。 */
  const pages = new Map<string, number>();
  let seen = false;
  let stopped = false;
  /** 開いているページがなくなった時刻と、そこから止めるまでの猶予（ページがあるときは `null`）。 */
  let empty: { readonly since: number; readonly graceMs: number } | null = null;

  const expireSilentPages = (at: number): void => {
    for (const [pageId, lastAliveAt] of pages) {
      if (at - lastAliveAt >= options.silenceLimitMs) {
        pages.delete(pageId);
        if (pages.size === 0) {
          // 途絶えの上限で、すでに待った。猶予は足さない。
          empty = { since: at, graceMs: 0 };
        }
      }
    }
  };

  return {
    alive(pageId) {
      seen = true;
      empty = null;
      pages.set(pageId, now());
    },
    closed(pageId) {
      if (!pages.delete(pageId)) {
        return;
      }
      if (pages.size === 0) {
        empty = { since: now(), graceMs: options.closedGraceMs };
      }
    },
    check() {
      if (stopped || !seen) {
        return;
      }
      const at = now();
      expireSilentPages(at);
      if (empty === null || at - empty.since < empty.graceMs || options.runningJobCount() > 0) {
        return;
      }
      stopped = true;
      options.onIdle();
    },
  };
};

/** 知らせの口の応答の状態。 */
const PRESENCE_STATUS = Object.freeze({ NO_CONTENT: 204, FORBIDDEN: 403 } as const);

/**
 * 知らせの口の要求なら受けて `true`（応答を書き終える）。ほかの要求は `false`（何もしない）。要求の守りを通った要求にだけ使う。
 * `monitor` が `null`（止める決まりを使わない画面のサーバ）でも、口の要求には応答する（ページの知らせを誤りにしない）。
 */
export const handlePresenceRequest = (
  monitor: PresenceMonitor | null,
  origin: string,
  request: IncomingMessage,
  response: ServerResponse,
): boolean => {
  const url = new URL(request.url ?? '/', origin);
  const kind = url.pathname === UI_PRESENCE_ALIVE_PATH ? 'alive' : url.pathname === UI_PRESENCE_CLOSED_PATH ? 'closed' : null;
  if (kind === null) {
    return false;
  }
  const fetchSite = request.headers['sec-fetch-site'];
  const pageId = url.searchParams.get(UI_PRESENCE_PAGE_PARAMETER) ?? '';
  const accepted = request.method === 'POST'
    && request.headers.origin === origin
    && (fetchSite === undefined || fetchSite === 'same-origin')
    && UI_PRESENCE_PAGE_ID_PATTERN.test(pageId);
  // 本文は使わない（読み捨てる）。
  request.resume();
  if (!accepted) {
    response.writeHead(PRESENCE_STATUS.FORBIDDEN, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end();
    return true;
  }
  if (monitor !== null) {
    if (kind === 'alive') {
      monitor.alive(pageId);
    } else {
      monitor.closed(pageId);
    }
  }
  response.writeHead(PRESENCE_STATUS.NO_CONTENT);
  response.end();
  return true;
};

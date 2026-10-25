// T32j-1（Task 32 の設計書 4.4 の CC-050・DEF-113）: Guard が CDP の session を付けていない page（ポップアップ）の要求の網は、Context の
// `route` だけである（T32-research-3 の実験: PASSIVE のポップアップの最初の要求と、凍結の段のポップアップ）。その網が働くことを、サーバの側で
// 「届かなかった」ことと、Safety Ledger の「止めた記録」で確かめる。
// - PASSIVE の段のポップアップ（同じ Origin で POST・beacon・GET を出すページ、別の Origin のページ）: サーバに 1 件も届かない（今の結果の 0 を
//   増やさない）。止めた記録は、明示の理由（CDP の付いていない page の要求。違反 `PASSIVE_GUARD_PAGE_NOT_READY`。URL つき）で、frame の判定の
//   失敗（`FRAME_CLASSIFICATION_FAILED`）に頼らない（DEF-113）。
// - 凍結の段のポップアップ: サーバに 1 件も届かない。Guard の route が、ポップアップの移動を `INTERACTION_FROZEN` で記録する（出口の中継が拒む
//   だけでは、この記録は残らない。今までのテストは凍結の段の route の分岐を外しても検出しなかった。T32-research-3）。
// - 出口の中継あり（本物の factory）となし（Guard だけの Context）、両方の Chromium（CLI の起動の設定と、テストの既定の headless shell）。
// - route の分岐を外した Guard の変種（PASSIVE の段の判定を外す・route をキャッシュの返しだけにする）では、このテストが落ちることを、実装者が
//   scratchpad の写しと vitest の alias で確かめた（製品のコードは書き換えない。T32j-1 の報告）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { wait } from '../../src/core/deadline.js';
import {
  activateInteractionFreeze,
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  installPassiveRequestGuard,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger, type SafetyLedgerSnapshot } from '../../src/safety/safety-ledger.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { QUIET_PERIOD_MS } from '../helpers/gate-harness.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

/** ポップアップのページと、ポップアップが出す要求のパスの前方一致（このパスへの要求は、どの Origin でも届いてはいけない）。 */
const POPUP_PATH_PREFIX = '/popup/';
/** ポップアップのページ（どの `POPUP_PATH_PREFIX` の下のパスでも、このページを返す）が出す要求。 */
const POPUP_SUBRESOURCES = Object.freeze({
  image: `${POPUP_PATH_PREFIX}image.png`,
  post: `${POPUP_PATH_PREFIX}post`,
  beacon: `${POPUP_PATH_PREFIX}beacon`,
  get: `${POPUP_PATH_PREFIX}get`,
});
/** 開くページ（PASSIVE の段で、読み込んだらすぐに同じ Origin のポップアップを開く）。 */
const SAME_ORIGIN_OPENER_PATH = '/opener/same';
/** 開くページ（PASSIVE の段で、読み込んだらすぐに別の Origin のポップアップを開く）。 */
const CROSS_ORIGIN_OPENER_PATH = '/opener/cross';
/** 開くページ（凍結の段のテスト。読み込みでは何も開かない）。 */
const FROZEN_OPENER_PATH = '/opener/frozen';
const SAME_ORIGIN_POPUP_PATH = `${POPUP_PATH_PREFIX}same`;
const CROSS_ORIGIN_POPUP_PATH = `${POPUP_PATH_PREFIX}cross`;
const FROZEN_SAME_ORIGIN_POPUP_PATH = `${POPUP_PATH_PREFIX}frozen-same`;
const FROZEN_CROSS_ORIGIN_POPUP_PATH = `${POPUP_PATH_PREFIX}frozen-cross`;
/** 場面ごとの回数（回ごとに Context を作り直す）。 */
const ROUNDS = 3;
/** ポップアップを開いた後に、要求と記録を待つ時間（ms）。期限ではなく、確かめる前の余裕である。 */
const POPUP_SETTLE_MS = 1_000;
/** 全部の回の後に、閉じた後に遅れて届く要求を見逃さないために待つ時間（ms）。期限ではなく、確かめる前の余裕である。 */
const LATE_DELIVERY_SETTLE_MS = 1_000;
/** 1 回の見積もりの上限（ms）。期限の値ではない。 */
const ROUND_BUDGET_MS = 5_000;
const SCENARIO_TIMEOUT_MS = ROUNDS * (ROUND_BUDGET_MS + POPUP_SETTLE_MS + QUIET_PERIOD_MS) + LATE_DELIVERY_SETTLE_MS;
const VIEWPORT = Object.freeze({ width: 1000, height: 700 });
/** DEF-113: CDP の付いていない page の要求を止めた、明示の理由（違反のコード）。 */
const UNGUARDED_PAGE_VIOLATION = 'PASSIVE_GUARD_PAGE_NOT_READY';

interface ObservedRequest {
  readonly server: 'opener' | 'other';
  readonly method: string;
  readonly path: string;
}

const html = (body: string): string => `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body>${body}</body></html>`;

/** ポップアップのページ（読み込んだら、画像の GET、POST、beacon、fetch の GET を出す）。 */
const POPUP_PAGE = html(`<img src="${POPUP_SUBRESOURCES.image}"><script>
fetch(${JSON.stringify(POPUP_SUBRESOURCES.post)}, { method: 'POST', body: 'x' }).catch(() => {});
try { navigator.sendBeacon(${JSON.stringify(POPUP_SUBRESOURCES.beacon)}, 'x'); } catch {}
fetch(${JSON.stringify(POPUP_SUBRESOURCES.get)}).catch(() => {});
</script>`);

type ChromiumLaunch = { readonly name: string; launch(): Promise<Browser> };
const CHROMIUM_LAUNCHES: readonly ChromiumLaunch[] = [
  { name: 'the CLI Chromium (launchCliChromium, headless)', launch: () => launchCliChromium() },
  { name: 'the headless shell (test default)', launch: () => launchHeadlessChromium() },
];

/** 1 つの回の、Guard の付いた page と、その Ledger と、閉じる処理。 */
interface GuardedRound {
  readonly page: Page;
  readonly ledger: SafetyLedger;
  /** 凍結の段に入る（凍結の段の場面だけが使う）。 */
  freeze(): Promise<void>;
  close(): Promise<void>;
}

/** 出口の中継の有無（中継ありは本物の factory、なしは Guard だけの Context）。 */
interface EgressMode {
  readonly label: string;
  open(browser: Browser, openerOrigin: string, stage: 'PASSIVE' | 'FROZEN'): Promise<GuardedRound>;
}

const EGRESS_MODES: readonly EgressMode[] = [
  {
    label: 'with the egress relay (the real factory)',
    async open(browser, openerOrigin, stage) {
      const factory = new BrowserContextFactory(browser, createTestConfig(openerOrigin), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
      if (stage === 'FROZEN') {
        const session = await factory.createInteractionSession(VIEWPORT);
        return {
          page: session.page,
          ledger: session.ledger,
          freeze: () => session.activateInteractionFreeze(),
          close: async () => {
            await session.close().catch(() => undefined);
            await factory.close();
          },
        };
      }
      const context = await factory.createPassiveContext(VIEWPORT);
      const ledger = factory.getSafetyLedger(context);
      const page = await factory.createPassivePage(context);
      return {
        page,
        ledger,
        freeze: () => activateInteractionFreeze(page),
        close: async () => {
          await factory.closePassiveContext(context).catch(() => undefined);
          await factory.close();
        },
      };
    },
  },
  {
    label: 'without the egress relay (the Guard alone)',
    async open(browser, openerOrigin) {
      const context: BrowserContext = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: VIEWPORT });
      const ledger = new SafetyLedger();
      await installPassiveRequestGuard(context, ledger, new Set([openerOrigin]));
      const page = await context.newPage();
      await awaitPassiveRequestGuardReady(page);
      return {
        page,
        ledger,
        freeze: () => activateInteractionFreeze(page),
        close: async () => {
          await closePassiveGuardedContext(context).catch(() => undefined);
          await context.close().catch(() => undefined);
        },
      };
    },
  },
];

describe.each(CHROMIUM_LAUNCHES)('T32j-1 (CC-050, DEF-113): requests of popups without the Guard CDP session never reach the server, with $name', ({ name, launch }) => {
  let browser: Browser;
  let opener: LoopbackHttpServer;
  let other: LoopbackHttpServer;
  const observed: ObservedRequest[] = [];

  const listener = (server: ObservedRequest['server']) => (request: IncomingMessage, response: ServerResponse): void => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    observed.push({ server, method: request.method ?? '', path });
    request.resume();
    const send = (body: string): void => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(body);
    };
    if (path.startsWith(POPUP_PATH_PREFIX)) {
      send(POPUP_PAGE);
    } else if (path === SAME_ORIGIN_OPENER_PATH) {
      send(html(`<script>window.open(${JSON.stringify(SAME_ORIGIN_POPUP_PATH)});</script>`));
    } else if (path === CROSS_ORIGIN_OPENER_PATH) {
      send(html(`<script>window.open(${JSON.stringify(`${other.origin}${CROSS_ORIGIN_POPUP_PATH}`)});</script>`));
    } else {
      send(html('<p>opener</p>'));
    }
  };

  beforeAll(async () => {
    browser = await launch();
    opener = await startLoopbackHttpServer(listener('opener'));
    other = await startLoopbackHttpServer(listener('other'));
  });

  afterAll(async () => {
    await browser?.close();
    await opener?.close();
    await other?.close();
  });

  /** 印の位置から後に、サーバに届いた要求のうち、届いてはいけないもの（ポップアップのパス、別の Origin のすべて、GET・HEAD 以外）。 */
  const forbiddenSince = (mark: number): readonly ObservedRequest[] => observed.slice(mark).filter((entry) =>
    entry.path.startsWith(POPUP_PATH_PREFIX) || entry.server === 'other' || !READ_METHODS.has(entry.method));

  const violationCodes = (snapshot: SafetyLedgerSnapshot): readonly string[] =>
    [...new Set(snapshot.invariantViolations.map(({ code }) => code))].sort();

  describe.each(EGRESS_MODES)('$label', (mode) => {
    it.each([
      { scenario: 'a same-Origin popup that sends POST, beacon and GET', openerPath: SAME_ORIGIN_OPENER_PATH, popup: () => `${opener.origin}${SAME_ORIGIN_POPUP_PATH}` },
      { scenario: 'a popup to another Origin', openerPath: CROSS_ORIGIN_OPENER_PATH, popup: () => `${other.origin}${CROSS_ORIGIN_POPUP_PATH}` },
    ])('PASSIVE: $scenario is stopped with the explicit reason and nothing reaches the server', async ({ scenario, openerPath, popup }) => {
      const allRounds = observed.length;
      const failedRounds: unknown[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        const mark = observed.length;
        const guarded = await mode.open(browser, opener.origin, 'PASSIVE');
        let snapshot: SafetyLedgerSnapshot;
        try {
          // Guard が Context を閉じると、開くページの読み込みも失敗しうる（場面の一部）。
          await guarded.page.goto(`${opener.origin}${openerPath}`, { waitUntil: 'load' }).catch(() => undefined);
          await wait(POPUP_SETTLE_MS);
        } finally {
          snapshot = guarded.ledger.snapshot();
          await guarded.close();
        }
        await wait(QUIET_PERIOD_MS);
        const forbidden = forbiddenSince(mark);
        const codes = violationCodes(snapshot);
        const explicit = snapshot.invariantViolations.some(({ code, message }) =>
          code === UNGUARDED_PAGE_VIOLATION && message.includes(popup()));
        if (forbidden.length > 0 || codes.join(',') !== UNGUARDED_PAGE_VIOLATION || !explicit) {
          failedRounds.push({ round, forbidden, codes, violations: snapshot.invariantViolations });
        }
      }
      await wait(LATE_DELIVERY_SETTLE_MS);
      console.info(`T32j-1 ${name} ${mode.label} PASSIVE ${scenario}: failed rounds ${JSON.stringify(failedRounds)}`);
      expect(failedRounds).toEqual([]);
      expect(forbiddenSince(allRounds)).toEqual([]);
    }, SCENARIO_TIMEOUT_MS);

    it('frozen: popups opened after the freeze are stopped and recorded by the Guard, and nothing reaches the server', async () => {
      const allRounds = observed.length;
      const failedRounds: unknown[] = [];
      const popupUrls = (): readonly string[] => [
        `${opener.origin}${FROZEN_SAME_ORIGIN_POPUP_PATH}`,
        `${other.origin}${FROZEN_CROSS_ORIGIN_POPUP_PATH}`,
      ];
      for (let round = 0; round < ROUNDS; round += 1) {
        const guarded = await mode.open(browser, opener.origin, 'FROZEN');
        let snapshot: SafetyLedgerSnapshot;
        let mark = observed.length;
        try {
          await guarded.page.goto(`${opener.origin}${FROZEN_OPENER_PATH}`, { waitUntil: 'load' });
          await guarded.freeze();
          mark = observed.length;
          await guarded.page.evaluate((urls) => {
            for (const url of urls) window.open(url);
          }, popupUrls()).catch(() => undefined);
          await wait(POPUP_SETTLE_MS);
        } finally {
          snapshot = guarded.ledger.snapshot();
          await guarded.close();
        }
        await wait(QUIET_PERIOD_MS);
        const forbidden = forbiddenSince(mark);
        const recordedNavigations = popupUrls().filter((url) => snapshot.blockedInteractionNavigations
          .some((entry) => entry.method === 'GET' && entry.url === url && entry.reason === 'INTERACTION_FROZEN'));
        const recordedRequests = popupUrls().filter((url) => snapshot.blockedInteractionRequests
          .some((entry) => entry.method === 'GET' && entry.url === url && entry.reason === 'INTERACTION_FROZEN'));
        if (
          forbidden.length > 0
          || recordedNavigations.length !== popupUrls().length
          || recordedRequests.length !== popupUrls().length
          || snapshot.blockedPopups.length < popupUrls().length
          || snapshot.invariantViolations.length > 0
        ) {
          failedRounds.push({
            round,
            forbidden,
            recordedNavigations,
            recordedRequests,
            blockedPopups: snapshot.blockedPopups.length,
            violations: snapshot.invariantViolations,
          });
        }
      }
      await wait(LATE_DELIVERY_SETTLE_MS);
      console.info(`T32j-1 ${name} ${mode.label} frozen popups: failed rounds ${JSON.stringify(failedRounds)}`);
      expect(failedRounds).toEqual([]);
      expect(observed.slice(allRounds).filter((entry) => entry.path.startsWith(POPUP_PATH_PREFIX) || entry.server === 'other')).toEqual([]);
    }, SCENARIO_TIMEOUT_MS);
  });
});

// DEF-208（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 6 章）: 操作さがしの調べの場面を、127.0.0.1 の仮のサイトで 1 画面だけ押す補助
// （DEF-208-1 と DEF-208-2 のテストが共用する）。
// - サイト（`startProbeSceneSite`）: 画面の Origin（場面の HTML を返す）、API の Origin（承認したサービスの Origin。CORS で画面の Origin に答える）、許可の外の
//   Origin の 3 つ。http か https（テストだけの自前の証明書 `tls-test-certificate.ts`）。どのサーバも、届いた要求を `hits` に記録する（画面の Origin は
//   `app:`、許可の外は `other:` を前に付ける）。場面の HTML では、`API` と `OTHER` が、それぞれの Origin の文字列になる。
// - 押す（`probeSceneOf`）: 本物の認証つきの factory（監査の段の口で API の Origin を承認したサービスの Origin にし、監査の段の送信の扱いの口
//   `auditSendOptionsOf`。読まないパス `PROBE_SCENE_EXCLUDED_PATH`）と Guard と出口の中継で画面を開き、発見の入口（凍結）と押す部品
//   （`probeDiscoveredSubmissions`）を通す。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Browser, Page } from 'playwright';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';
import { discoverPageCandidates } from '../../src/discovery/discover-page.js';
import type { DiscoveryReadPageRecord } from '../../src/discovery/discovery-result.js';
import { probeDiscoveredSubmissions, type SubmissionProbeOptions } from '../../src/interaction/submission-probe.js';
import { auditSendOptionsOf } from '../../src/orchestration/audit-send-options.js';
import { AuditStageMonitor, pageLoadFactsOf, type PageLoadFacts } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger, type SafetyLedgerSnapshot } from '../../src/safety/safety-ledger.js';
import { chromiumRunsOf, launchCliChromium, launchHeadlessChromium } from './chromium.js';
import { READ_METHODS } from './leak-places.js';
import { settleLateDeliveries, startLoopbackHttpServer } from './loopback-server.js';
import { fastRunConfig } from './run-harness.js';
import { PROBE_FACTORY_OPTIONS } from './test-config.js';
import { LOOPBACK_TEST_CERTIFICATE, LOOPBACK_TEST_KEY, TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS } from './tls-test-certificate.js';

/** 仮のサイトの scheme（https は自前の証明書。Chromium は証明書の誤りを無視する引数で起動する）。 */
export type ProbeSceneScheme = 'http' | 'https';

/** 2 つの Chromium（テストの既定と CLI の起動の設定。どちらも証明書の誤りを無視する引数）。SLIM-B0: 組は `chromiumRunsOf` で選ぶ。 */
export const PROBE_SCENE_LAUNCHERS = chromiumRunsOf([
  ['the default test Chromium', () => launchHeadlessChromium({ args: TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS })],
  ['the CLI launch settings', () => launchCliChromium({ args: TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS })],
]);

/** 押した後に静まるまで待つ時間（ms。ループバックの仮のサイトなので短くする）。 */
export const PROBE_SCENE_QUIET_WAIT_MS = 800;
/** 全部の後に、遅れて届く要求を数え直すまで待つ時間（ms）。 */
export const PROBE_SCENE_LATE_ARRIVAL_WAIT_MS = 1_500;
/** 読まないパス（監査の段の除外の口）。 */
export const PROBE_SCENE_EXCLUDED_PATH = '/api/private';
/** API の Origin で、接続を切って答える path の始まり（網の失敗）。 */
export const PROBE_SCENE_BROKEN_PATH = '/api/network-broken';

/** サーバに届いた要求（method と、`app:`・`other:` を前に付けた URL の path と query）。 */
export interface ProbeSceneHit {
  readonly method: string;
  readonly path: string;
}

export interface ProbeSceneSite {
  readonly appOrigin: string;
  readonly apiOrigin: string;
  readonly hits: ProbeSceneHit[];
  close(): Promise<void>;
  /** SLIM-2（X1）: 3 つのサーバの受けている途中の要求が 0 になるまで待つ（`settleProbeSceneSite` が使う）。 */
  whenIdle(limitMs?: number): Promise<void>;
}

/**
 * SLIM-2（X1）: 押す部品の factory を閉じた後（`probeSceneOf` の後）に、遅れて届く要求を数え直す前の待ち。サーバが静まるまで
 * （`PROBE_SCENE_LATE_ARRIVAL_WAIT_MS` まで。`settleLateDeliveries`）。ページが開いたままの所では使わない。
 */
export const settleProbeSceneSite = (site: ProbeSceneSite): Promise<void> => settleLateDeliveries(PROBE_SCENE_LATE_ARRIVAL_WAIT_MS, site);

const html = (body: string, apiOrigin: string, otherOrigin: string): string =>
  '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>t</title>'
  + `<script>const API = ${JSON.stringify(apiOrigin)}; const OTHER = ${JSON.stringify(otherOrigin)};</script></head><body>${body}</body></html>`;

/** 場面の画面（path ごとの body の HTML）を返す仮のサイトを起動する。 */
export async function startProbeSceneSite(pages: Readonly<Record<string, string>>, scheme: ProbeSceneScheme): Promise<ProbeSceneSite> {
  const hits: ProbeSceneHit[] = [];
  let apiOrigin = '';
  let appOrigin = '';
  const tls = scheme === 'https' ? { tls: { cert: LOOPBACK_TEST_CERTIFICATE, key: LOOPBACK_TEST_KEY } } : {};
  // 許可 Origin でも承認したサービスの Origin でもない Origin（https では、知らせのない宛先への CONNECT になる）。
  const other = await startLoopbackHttpServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push({ method: req.method ?? '', path: `other:${req.url ?? ''}` });
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end('{}');
  }, tls);
  const app = await startLoopbackHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    hits.push({ method: req.method ?? '', path: `app:${req.url ?? ''}` });
    const page = pages[path];
    if (page !== undefined) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html(page, apiOrigin, other.origin));
      return;
    }
    res.writeHead(path === '/app-read' ? 200 : 404, { 'content-type': 'application/json' });
    res.end('{}');
  }, tls);
  appOrigin = app.origin;
  const api = await startLoopbackHttpServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push({ method: req.method ?? '', path: req.url ?? '' });
    if ((req.url ?? '').startsWith(PROBE_SCENE_BROKEN_PATH)) {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': appOrigin,
      'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE',
      'access-control-allow-headers': 'content-type, x-http-method-override',
    });
    res.end('{}');
  }, tls);
  apiOrigin = api.origin;
  return {
    appOrigin,
    apiOrigin,
    hits,
    close: async () => {
      await app.close();
      await api.close();
      await other.close();
    },
    whenIdle: async (limitMs) => {
      await Promise.all([app, api, other].map((server) => server.whenIdle(limitMs)));
    },
  };
}

/** 1 画面を押した結果。 */
export interface ProbeSceneOutcome {
  readonly probed: DiscoveryReadPageRecord;
  readonly hitsAfterFreeze: readonly ProbeSceneHit[];
  readonly ledger: SafetyLedgerSnapshot;
  readonly pageLoad: PageLoadFacts | null;
}

/** 場面の画面を、本物の factory と Guard で開き、発見（凍結）と押す部品を通す（ファイルの先頭の説明）。 */
export async function probeSceneOf(
  browser: Browser,
  site: ProbeSceneSite,
  path: string,
  options: Pick<SubmissionProbeOptions, 'onOpenerPageChanged'> & {
    /**
     * COV-2c: 監査の段の送信の扱い（省略すると、テストの設定の既定の `READ_ONLY`。そのときは送信の扱いの口を渡さない）。本番の既定の `PASS_EXCEPT_DELETE` を
     * 渡すと、factory に送信の扱いの口（`auditSendOptionsOf`）を渡す（凍結の外の送信が届く設定でも、押下の送信が届かないことを確かめる）。
     */
    readonly sendPolicy?: AuditConfig['audit']['sendPolicy'];
  } = {},
): Promise<ProbeSceneOutcome> {
  const base = fastRunConfig(site.appOrigin, path, options.sendPolicy === undefined ? {} : { audit: { sendPolicy: options.sendPolicy } });
  const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${path}`, allowedOrigins: [site.appOrigin] } };
  const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
    ...PROBE_FACTORY_OPTIONS,
    ...auditSendOptionsOf(config, [site.apiOrigin]),
    authentication: {
      initialState: { cookies: [], origins: [] },
      filterState: (state) => filterAuthenticatedState(state, [site.appOrigin]),
      auditExclusions: { excludedPathPrefixes: [PROBE_SCENE_EXCLUDED_PATH], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      auditStage: {
        approvedServiceOrigins: [site.apiOrigin],
        auditReadRequests: [],
        scriptLogin: { origin: site.apiOrigin, path: '/token', requiredQuery: [] },
      },
    },
    serviceRequestBudget: createServiceRequestBudget({ now: () => Date.now() }),
    auditStageMonitor: new AuditStageMonitor(),
  });
  try {
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY');
    const page: Page = await factory.createPassivePage(context);
    await page.goto(`${site.appOrigin}${path}`);
    const discovered = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([site.appOrigin]) } });
    const observation = factory.submissionObservationOf(context);
    if (observation === null) throw new Error('the PRIMARY context has no submission observation');
    const before = site.hits.length;
    const probed = await probeDiscoveredSubmissions(page, observation, discovered, {
      targetPolicy: { allowedOrigins: new Set([site.appOrigin]), isExcludedPage: () => false },
      quietWaitMs: PROBE_SCENE_QUIET_WAIT_MS,
      ...(options.onOpenerPageChanged === undefined ? {} : { onOpenerPageChanged: options.onOpenerPageChanged }),
    });
    return {
      probed,
      hitsAfterFreeze: site.hits.slice(before),
      ledger: factory.getSafetyLedger(context).snapshot(),
      pageLoad: pageLoadFactsOf(page),
    };
  } finally {
    await factory.close().catch(() => undefined);
  }
}

/** 候補のうち、送信ボタンの語にその語のある最初の候補の probe の結果と理由（`<result> <reason>`）。 */
export const probeResultOfWord = (record: DiscoveryReadPageRecord, word: string): string => {
  const probe = record.candidates.find((candidate) => candidate.submitterWords.includes(word))?.submissionProbe;
  return `${String(probe?.result)} ${String(probe?.reason)}`;
};

/** 読み取りでない要求（サーバに届いてはならないもの）。 */
export const nonReadHitsOf = (hits: readonly ProbeSceneHit[]): ProbeSceneHit[] => hits.filter((hit) => !READ_METHODS.has(hit.method));

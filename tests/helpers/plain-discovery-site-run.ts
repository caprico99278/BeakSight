// DEF-208（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 6 章）: 127.0.0.1 の仮のサイト（path ごとの HTML。ログインなし）で、本物の発見の流れ
// （`executeDiscoveryRun`）を 1 回動かし、成果物 `discovery.json`（スキーマで確かめる）と、サーバに届いた要求（method と path）を返す。DEF-208-4 と SREV-1105-3 の
// テストが共用する。
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { expect } from 'vitest';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { DEBUG_TIMING_FILE_NAME, type DebugTimingEntry } from '../../src/core/debug-timing.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun, type DiscoveryRunObserver } from '../../src/worker/discovery-run.js';
import { settleLateDeliveries, startLoopbackHttpServer } from './loopback-server.js';
import { createTestConfig, type TestConfigOverrides } from './test-config.js';
import { probeQuietWindowsOf } from './test-waits.js';

/** 押した後に静まるまで待つ時間（ms。テストの値）。 */
const SHORT_QUIET_WAIT_MS = 300;
/** 遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;

/** 認証の指定（状態なし。読まないパスと、セッションの切れの path）。 */
const plainAuthenticationOf = (origin: string): RunAuthentication => ({
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: [origin],
  auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix: '/login',
  filterState: filterAuthenticatedState,
});

export interface PlainSiteRun {
  readonly document: DiscoveryDocument;
  readonly seen: readonly { readonly method: string; readonly path: string }[];
  /** DBG-1: 測りの記録の行（記録のファイルがなければ null）。 */
  readonly debugLines: readonly DebugTimingEntry[] | null;
}

/** DEF-225: HTML でない 200 の応答（ヘッダと本文。例: `Content-Disposition: attachment` の JSON）。 */
export interface PlainSiteRawResponse {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** `pageOf(path)` が HTML を返す path は 200 で返し（DEF-225: `PlainSiteRawResponse` はそのヘッダと本文の 200）、ほかは 404 にするサイトで、発見を 1 回動かす。 */
export async function runDiscoveryOnPlainSite(
  launch: () => Promise<Browser>,
  pageOf: (path: string) => string | PlainSiteRawResponse | null,
  startPath: string,
  maxPages: number,
  jobId: string,
  /** NO-2 fix round 2: 監査の設定の上書き（例: 監査の段の送信の扱い `sendPolicy`）。省略は今のまま。 */
  auditOverrides: TestConfigOverrides['audit'] = {},
  /** DEF-195: 進み具合の受け手（省略は受けない。今のまま）。 */
  onProgress?: DiscoveryRunObserver['onProgress'],
  /** L6/L3-1: 1 画面の見張りの反応なしの長さ（ms。テストで短くする。省略は本番の長さ）。 */
  progressQuietLimitMs?: number,
  /** DBG-1: 測りの記録の入切（省略は切。DTIME の内訳を確かめる場面だけ入にする）。 */
  debugTiming?: boolean,
): Promise<PlainSiteRun> {
  const seen: { readonly method: string; readonly path: string }[] = [];
  const server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    seen.push({ method: request.method ?? '', path: url.pathname });
    request.resume();
    const html = pageOf(url.pathname);
    if (html !== null && typeof html !== 'string') {
      response.writeHead(200, html.headers);
      response.end(html.body);
      return;
    }
    if (html !== null) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const output = await mkdtemp(join(tmpdir(), 'beaksight-plain-discovery-'));
  try {
    const config = createTestConfig(server.origin, startPath, {
      crawl: { maxPages, minNavigationIntervalMs: 200 }, audit: { screenshots: false, ...auditOverrides }, output: { directory: output },
    });
    const outcome = await executeDiscoveryRun({
      config, jobId, authentication: plainAuthenticationOf(server.origin), launchBrowser: launch, clock: () => new Date(),
      now: () => Date.now(), stopSignal: new AbortController().signal, observationWindows: probeQuietWindowsOf(SHORT_QUIET_WAIT_MS),
      ...(progressQuietLimitMs === undefined ? {} : { progressQuietLimitMs }),
      ...(debugTiming === undefined ? {} : { debugTimingSwitch: async () => debugTiming }),
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined, ...(onProgress === undefined ? {} : { onProgress }) });
    if (outcome.kind !== 'RAN') throw new Error(`the discovery did not run: ${outcome.kind}`);
    // SLIM-2（X1）: 発見の流れは Browser を閉じて終わるので、閉じた後の数え直しの待ちは、サーバが静まるまで（`LATE_REQUEST_WAIT_MS` まで）。
    await settleLateDeliveries(LATE_REQUEST_WAIT_MS, server);
    const result = JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument;
    const validation = await validateArtifact('discovery', result);
    expect(validation.ok ? [] : validation.errors).toEqual([]);
    const debugPath = join(outcome.runDirectory, DEBUG_TIMING_FILE_NAME);
    const debugLines = existsSync(debugPath)
      ? readFileSync(debugPath, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as DebugTimingEntry)
      : null;
    return { document: result, seen: [...seen], debugLines };
  } finally {
    await server.close();
    await rm(output, { recursive: true, force: true });
  }
}

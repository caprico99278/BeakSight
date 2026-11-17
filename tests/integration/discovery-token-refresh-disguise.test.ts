// DEF-233 fix round 2（安全のレビュー SREV-233 の C-1・C-2・C-3・M-2 の実験を写した）: 凍結の段で通すサイトの token の更新は、本物の更新の形だけに限る。
// 見せかけの送信を混ぜるサイト（`tests/helpers/token-refresh-disguise-site.ts`）を、本物の操作さがしの流れ（`executeDiscoveryRun`）で読む。
// - disguise: 押下と、押下の後のタイマーが、token の送り先へ見せかけの送信を送る（押下の値を header・本文・query・符号化で運ぶもの、鍵にない本文、数の値、
//   query の名前の違い、押下の観察の間の本物の形の更新など）。どれもサーバに届かない（0）。
// - carry: 押下でページが鍵の値に数・真偽・文字の番号・鍵の名前・文字列を書き足し、すぐ更新する。A2 の重ねで、次の画面へ渡らない（渡った印の beacon が 0）。
// 届いたかはサーバの記録で数え、名前つきの時間だけ待って数え直す。Chromium は、テストの既定の headless と CLI の起動の設定の両方。
// DEF-233 の M3（SLIM L-3 で `discovery-token-refresh.test.ts` から移した。凍結の間の更新の結合はこの 1 本。単体 1 は
// `request-policy-frozen-token-refresh.test.ts`。場面の中身は変えていない）: スクリプトがタイマーで token を更新するサイト（`tests/helpers/token-refresh-site.ts`）で、
// 押下の目印を本文に運ぶ更新・危険な語・DELETE は、凍結の段でも届かない（目印のない更新の形は届く）。押した送信（`POST /api/items`）も届かない。
// FIN-1（SD-2）: 凍結の前のサイト自身の確かめの送信（危険な語・DELETE を含む）は届く。凍結の段（押した後から次の画面まで）で届かないことを、サーバの記録の順で確かめる。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { DISCOVERY_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { hasSuccessStorageKey, isSuccessStorageKeyName } from '../../src/worker/login-stage-checks.js';
import { BOTH_CHROMIUM_LAUNCHERS, useSharedRunBrowser } from '../helpers/chromium.js';
import { READ_METHODS, nonReadRequestsOf } from '../helpers/leak-places.js';
import { settleLateDeliveries } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig } from '../helpers/test-config.js';
import { TEST_OBSERVATION_WINDOWS } from '../helpers/test-waits.js';
import {
  DISGUISE_KEY_SHAPE,
  DISGUISE_PATHS,
  DISGUISE_STORAGE_KEY,
  startDisguiseSite,
  type DisguiseSite,
  type DisguiseSiteOptions,
} from '../helpers/token-refresh-disguise-site.js';
import {
  TOKEN_REFRESH_KEY_SHAPE,
  TOKEN_REFRESH_PATHS,
  TOKEN_REFRESH_STORAGE_KEY,
  startTokenRefreshSite,
  type TokenRefreshSite,
  type TokenRefreshSiteOptions,
} from '../helpers/token-refresh-site.js';

const PAGES = 3;
const ACCESS_LIFETIME_MS = 20_000;
const MARGIN_MS = 8_000;
/** 更新のタイマーの間隔。SLIM-2（X2）: probe の観察をテストの短い値（`TEST_PROBE_QUIET_WAIT_MS`）にしたので、それより短くする（凍結の間に必ず動く）。 */
const TICK_MS = 400;
const NAVIGATION_INTERVAL_MS = 200;
/** fix round 4（I-1）: carry3 の画面の数と token の期限（2 画面目の読み込みで凍結の前の更新が起きる長さ）。 */
const CARRY3_PAGES = 5;
const CARRY3_ACCESS_LIFETIME_MS = 12_000;
/** 操作さがしの後に、遅れて届く要求を待つ時間（数え直す）。 */
const LATE_REQUEST_WAIT_MS = 3_000;
const TEST_TIMEOUT_MS = 240_000;

const authenticationOf = (site: DisguiseSite): RunAuthentication => {
  const key = { origin: site.appOrigin, ...DISGUISE_KEY_SHAPE };
  return {
    initialState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: DISGUISE_STORAGE_KEY, value: site.issueStoredSession() }] }] },
    approvedTestOrigins: [site.appOrigin],
    auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
    sessionLostPathPrefix: DISGUISE_PATHS.auth,
    filterState: filterAuthenticatedState,
    auditStage: {
      approvedServiceOrigins: [site.svcOrigin],
      auditReadRequests: [],
      scriptLogin: { origin: site.svcOrigin, path: DISGUISE_PATHS.token, requiredQuery: [{ name: 'grant_type', value: 'password' }] },    },
    sessionKeyPresent: (state) => hasSuccessStorageKey(state, key),
    sessionKeyName: (origin, name) => isSuccessStorageKeyName(origin, name, key),
    automatedRelogin: true,
  };
};

describe.each(BOTH_CHROMIUM_LAUNCHERS)('DEF-233 fix round 2: only a real token refresh passes while frozen (%s)', (_label, launch) => {
  let site: DisguiseSite | undefined;
  let directory = '';
  // SLIM-2（X7）: 場面ごとに Chromium を起こし直さない（操作さがしは、自分の Context だけを閉じて終わる）。
  const launchShared = useSharedRunBrowser(() => launch());

  afterEach(async () => {
    await site?.close();
    site = undefined;
    if (directory !== '') await rm(directory, { recursive: true, force: true });
    directory = '';
  });

  const discover = async (options: Omit<DisguiseSiteOptions, 'pages' | 'accessLifetimeMs' | 'marginMs' | 'tickMs'> & Partial<DisguiseSiteOptions>): Promise<{
    readonly site: DisguiseSite;
    readonly document: DiscoveryDocument;
  }> => {
    site = await startDisguiseSite({ pages: PAGES, accessLifetimeMs: ACCESS_LIFETIME_MS, marginMs: MARGIN_MS, tickMs: TICK_MS, ...options });
    const started = site;
    directory = await mkdtemp(join(tmpdir(), 'beaksight-def233-disguise-'));
    const config = createTestConfig(started.appOrigin, `${DISGUISE_PATHS.pagePrefix}1`, {
      target: { id: 'def233-disguise' },
      crawl: { maxPages: options.pages ?? PAGES, minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
      audit: { sendPolicy: 'PASS_EXCEPT_DELETE', screenshots: false },
      output: { directory },
    });
    const outcome = await executeDiscoveryRun({
      config, jobId: 'job-def233-disguise', authentication: authenticationOf(started),
      launchBrowser: launchShared,
      clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal, navigationPacer: createTestNavigationPacer(config),
      observationWindows: TEST_OBSERVATION_WINDOWS,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') throw new Error(`the discovery did not run: ${outcome.kind}`);
    const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
    // TEST-TIME-B（案 9）: 操作さがしは Browser を閉じて終わるので、受けている途中の要求が 0 になってから短い余白だけ待つ（上限は前の固定の待ち）。
    await settleLateDeliveries(LATE_REQUEST_WAIT_MS, started);
    return { site: started, document };
  };

  const beaconsOf = (served: DisguiseSite, prefix: string): readonly string[] =>
    served.arrivals.filter(({ origin, path, kind }) => origin === 'app' && path === '/beacon' && (kind ?? '').startsWith(prefix)).map(({ kind }) => kind ?? '');

  it('delivers none of the disguised sends to the token endpoint after the press (C-1, C-2, M-2)', async () => {
    const { site: served, document } = await discover({ mode: 'disguise' });
    expect(document.pages.filter((page) => page.state === 'READ').length).toBe(PAGES);
    // 押下の後に、見せかけの送信を試した（値を送らない beacon が届いた）。
    expect(beaconsOf(served, 'draft-filled').length).toBeGreaterThan(0);
    const delivered = served.arrivals.filter(({ origin, kind, filled }) => origin === 'svc' && kind !== null && filled)
      .map(({ method, kind }) => `${method} ${kind ?? ''}`);
    expect(delivered).toEqual([]);
    expect(nonReadRequestsOf(served.arrivals.filter(({ origin }) => origin === 'app'))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // fix round 3（SREV-233 の確かめ直しの N-1・N-2）: 凍結の前に仕込んだ値（鍵の中の符号表・読み取りの header・取り消しの query）を使って、押下の値を運ぶ形。
  // 読み込みの時の更新（凍結の前の更新）がある本物の SDK の形で、凍結の段の更新を通す道が働く中で確かめる。
  it('delivers none of the sends that use what the page primed before the freeze (N-1, N-2)', async () => {
    // DEF-248: 余裕を期限と同じにして、どのタイマーでも更新する（更新が起きるかを、発見の速さに頼らない）。
    const { site: served, document } = await discover({ mode: 'prime', refreshOnLoad: true, marginMs: ACCESS_LIFETIME_MS });
    expect(document.pages.filter((page) => page.state === 'READ').length).toBe(PAGES);
    expect(served.refreshes.length).toBeGreaterThan(0);
    expect(beaconsOf(served, 'draft-filled').length).toBeGreaterThan(0);
    const delivered = served.arrivals.filter(({ origin, kind, filled }) => origin === 'svc' && kind !== null && filled)
      .map(({ method, kind }) => `${method} ${kind ?? ''}`);
    expect(delivered).toEqual([]);
    expect(nonReadRequestsOf(served.arrivals.filter(({ origin }) => origin === 'app'))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // fix round 3（N-3）: 押下の値の符号を、鍵の配列に、更新の応答の 2 つの文字列の選び方で書く形。A2 の重ねで次の画面へ渡らない。
  it('does not carry the choice of the response strings written by the press to the next page (N-3)', async () => {
    // DEF-248: 余裕を期限と同じにして、どのタイマーでも更新する（更新が起きるかを、発見の速さに頼らない）。
    const { site: served, document } = await discover({ mode: 'carry2', refreshOnLoad: true, marginMs: ACCESS_LIFETIME_MS });
    expect(document.pages.filter((page) => page.state === 'READ').length).toBe(PAGES);
    expect(served.refreshes.length).toBeGreaterThan(0);
    expect(beaconsOf(served, 'carried')).toEqual([]);
    expect(nonReadRequestsOf(served.arrivals.filter(({ origin }) => origin === 'app'))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // fix round 4（3 回目の確かめ直しの I-1）: 押下の後に 2 回続けて更新し、鍵に 1 回目と 2 回目のどちらの応答の値を置くかで運ぶ形。A2 は最後の 1 つの応答の値だけを
  // 認めるので、1 回目の応答の値は次の画面へ渡らない。
  it('does not carry a value of an earlier refresh response chosen by the press to the next page (I-1)', async () => {
    // 画面を増やし、期限を短くして、凍結の前の更新（読み込みの時）の後の画面で押下の 2 回の更新が起き、その次の画面が読まれるようにする。
    // 渡さなかった（押す前の値のままの）次の画面は、使い終えた鍵で更新してセッションが切れうる（渡さない側。本番は B のログインし直しが受ける）。読んだ画面の数は問わない。
    const { site: served } = await discover({ mode: 'carry3', refreshOnLoad: true, pages: CARRY3_PAGES, accessLifetimeMs: CARRY3_ACCESS_LIFETIME_MS });
    const values = (prefix: string): readonly string[] => beaconsOf(served, prefix).map((kind) => kind.slice(prefix.length));
    const first = values('carry3-first-');
    // 押下の後の 2 回の更新を試した。
    expect(first.length).toBeGreaterThan(0);
    const next = values('nextaccess-');
    // 押下の後の 2 回の更新の後に、次の画面を読んだ（比べる相手がある）。
    expect(next.length).toBeGreaterThan(first.length > 0 ? 1 : 0);
    expect(next.filter((value) => first.includes(value))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // 文字列を書き足さない形（更新の応答の文字列だけが変わり、押下の数・真偽・鍵の名前が混ざる）と、文字列も書き足す形。
  it.each([false, true])('does not carry what the press wrote into the session key to the next page (C-3; with a string: %s)', async (carryString) => {
    // DEF-248: 余裕を期限と同じにして、どのタイマーでも更新する（更新が起きるかを、発見の速さに頼らない）。
    const { site: served, document } = await discover({ mode: 'carry', carryString, marginMs: ACCESS_LIFETIME_MS });
    expect(document.pages.filter((page) => page.state === 'READ').length).toBe(PAGES);
    expect(served.refreshes.length).toBeGreaterThan(0);
    expect(beaconsOf(served, 'carried')).toEqual([]);
    expect(nonReadRequestsOf(served.arrivals.filter(({ origin }) => origin === 'app'))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

/** M3: token の期限（TEST-TIME-B・SLIM-GROUP L-4 で縮めた値。前の `discovery-token-refresh.test.ts` と同じ）と、期限まで更新を始める余裕。 */
const M3_ACCESS_LIFETIME_MS = 3_000;
const M3_MARGIN_MS = 1_500;
/** M3: 確かめの送信の間隔（押下の後の欄の値を運ぶ送信を、凍結の間に送らせる。probe の観察 `TEST_PROBE_QUIET_WAIT_MS` より短い）。 */
const M3_TICK_MS = 400;
const M3_PAGES = 3;
/** M3: 操作さがしの後に、遅れて届く要求を待つ時間の上限（数え直す）。 */
const M3_LATE_REQUEST_WAIT_MS = 2_000;
/** DEF-200 の段ごとのログインし直しの上限（ジョブの親の決まり。テストは同じ数で止める）。 */
const M3_MAX_RELOGINS = 2;
const M3_TEST_TIMEOUT_MS = 280_000;

const m3AuthenticationOf = (site: TokenRefreshSite, session: string): RunAuthentication => {
  const key = { origin: site.appOrigin, ...TOKEN_REFRESH_KEY_SHAPE };
  return {
    initialState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: TOKEN_REFRESH_STORAGE_KEY, value: session }] }] },
    approvedTestOrigins: [site.appOrigin],
    auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
    sessionLostPathPrefix: TOKEN_REFRESH_PATHS.auth,
    filterState: filterAuthenticatedState,
    auditStage: {
      approvedServiceOrigins: [site.svcOrigin],
      auditReadRequests: [],
      scriptLogin: { origin: site.svcOrigin, path: TOKEN_REFRESH_PATHS.token, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    },
    // ワーカーと同じ作り（`auditStageItemOf`）: 成功の鍵の形で、鍵があるかと、鍵の名前かを判定する。
    sessionKeyPresent: (state) => hasSuccessStorageKey(state, key),
    sessionKeyName: (origin, name) => isSuccessStorageKeyName(origin, name, key),
    // 自動ログインのプロファイル（DEF-200 のログインし直しができる）。
    automatedRelogin: true,
  };
};

describe.each(BOTH_CHROMIUM_LAUNCHERS)('DEF-233: the discovery keeps the sign-in of a site that refreshes the token by a timer (%s)', (_label, launch) => {
  let site: TokenRefreshSite | undefined;
  let directory = '';
  // SLIM-2（X7）: 操作さがしの回ごとに Chromium を起こし直さない（操作さがしは、自分の Context だけを閉じて終わる）。
  const launchShared = useSharedRunBrowser(() => launch());

  afterEach(async () => {
    await site?.close();
    site = undefined;
    if (directory !== '') await rm(directory, { recursive: true, force: true });
    directory = '';
  });

  /** 操作さがしを流す。セッションの切れで止まったら、サーバから新しいログインの状態を受けて、同じ Run の続きから始める（DEF-200 のログインし直しの代わり）。 */
  const discover = async (options: TokenRefreshSiteOptions): Promise<{ readonly site: TokenRefreshSite; readonly document: DiscoveryDocument; readonly elapsedMs: number }> => {
    site = await startTokenRefreshSite(options);
    const started = site;
    directory = await mkdtemp(join(tmpdir(), 'beaksight-def233-'));
    const config = createTestConfig(started.appOrigin, `${TOKEN_REFRESH_PATHS.pagePrefix}1`, {
      target: { id: 'def233' },
      crawl: { maxPages: options.pages, minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
      audit: { sendPolicy: 'PASS_EXCEPT_DELETE', screenshots: false },
      output: { directory },
    });
    const identity = { authenticationSha256: 'a'.repeat(64), targetConfigSha256: 'b'.repeat(64) };
    let session = started.issueStoredSession();
    let resume: { readonly runDirectory: string; readonly previousJobId: string } | undefined;
    const startedAt = Date.now();
    for (let attempt = 0; ; attempt += 1) {
      const jobId = `job-def233-${String(attempt)}`;
      const outcome = await executeDiscoveryRun({
        config, jobId, authentication: m3AuthenticationOf(started, session), launchBrowser: launchShared,
        clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal, navigationPacer: createTestNavigationPacer(config),
        observationWindows: TEST_OBSERVATION_WINDOWS,
        checkpoint: { identity, ...(resume === undefined ? {} : { resume }) },
      }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
      if (outcome.kind !== 'RAN') throw new Error(`the discovery did not run: ${outcome.kind}`);
      const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
      const validation = await validateArtifact('discovery', document);
      expect(validation.ok ? [] : validation.errors).toEqual([]);
      if (document.endReason !== 'AUTH_SESSION_LOST' || attempt >= M3_MAX_RELOGINS) {
        return { site: started, document, elapsedMs: Date.now() - startedAt };
      }
      session = started.issueStoredSession();
      resume = { runDirectory: outcome.runDirectory, previousJobId: jobId };
    }
  };

  /** アプリの Origin に届いた、読み取りでない要求（名前つきの時間だけ待ってから数える）。 */
  const appNonReads = async (served: TokenRefreshSite): Promise<readonly string[]> => {
    // TEST-TIME-B（案 9）: 操作さがしは Browser を閉じて終わるので、受けている途中の要求が 0 になってから短い余白だけ待つ（上限は前の固定の待ち）。
    await settleLateDeliveries(M3_LATE_REQUEST_WAIT_MS, served);
    return nonReadRequestsOf(served.requestLog.filter(({ origin }) => origin === 'app'));
  };

  it('M3: does not deliver a refresh that carries the value entered by the press, a dangerous word or DELETE while frozen', async () => {
    const { site: served, document, elapsedMs } = await discover({
      pages: M3_PAGES, accessLifetimeMs: M3_ACCESS_LIFETIME_MS, marginMs: M3_MARGIN_MS, tickMs: M3_TICK_MS, decoys: true,
    });
    expect(document.pages.some((page) => page.state === 'READ')).toBe(true);
    // TEST-TIME-B: 縮めた期限を操作さがしの長さが越え、本物の更新が少なくとも 1 回起きた（通す道が働いた上で、目印を運ぶ送信が届かない）。
    expect(elapsedMs).toBeGreaterThan(M3_ACCESS_LIFETIME_MS);
    expect(served.refreshRecords.length).toBeGreaterThan(0);
    // 押下の後に、欄の値を運ぶ送信を試した（値を送らない beacon が届いた）。
    expect(served.requestLog.filter(({ path }) => path.startsWith('/beacon?e=draft-filled')).length).toBeGreaterThan(0);
    await settleLateDeliveries(M3_LATE_REQUEST_WAIT_MS, served);
    const decoys = served.decoyRecords.map(({ kind, method, draftFilled }) => `${method} ${kind}${draftFilled ? ' filled' : ''}`);
    // SD-2: 凍結の前は、サイト自身の確かめの送信（危険な語・DELETE を含む）も届く（止めない）。押下の値を運ぶ送信は届かず、押した後（凍結の段）から次の画面の
    // 読み込みまでに、確かめの送信（サーバが 204 で受ける形）は 1 件も届かない。本物の更新（200）は凍結の段でも通る。
    expect(decoys.filter((decoy) => decoy.endsWith(' filled'))).toEqual([]);
    expect(decoys.length).toBeGreaterThan(0);
    const decoysAfterPress: string[] = [];
    let pressed = false;
    for (const { origin, method, path, status } of served.requestLog) {
      if (path.startsWith('/beacon?e=draft-filled')) pressed = true;
      else if (origin === 'svc' && path === TOKEN_REFRESH_PATHS.items) pressed = false;
      else if (pressed && origin === 'svc' && method !== 'OPTIONS' && !READ_METHODS.has(method) && status !== 200) decoysAfterPress.push(`${method} ${path} ${String(status)}`);
    }
    expect(decoysAfterPress).toEqual([]);
    expect(await appNonReads(served)).toEqual([]);
  }, M3_TEST_TIMEOUT_MS);
});

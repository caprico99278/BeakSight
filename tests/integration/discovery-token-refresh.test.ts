// DEF-233（設計書 `doc/design/2026-11-09-beaksight-discovery-token-refresh-design.md` 6 章）: 操作さがしで、サイトの token の更新を通し、401 が続いたらログインし直す。
// スクリプトがタイマーで token を更新するサイト（`tests/helpers/token-refresh-site.ts`。token の期限 6 秒（TEST-TIME-B で 20 秒から縮めた）、鍵を回し使い回しで取り消す、401 でログアウトの POST）を、
// 本物の操作さがしの流れ（`executeDiscoveryRun`。factory・Guard・中継・probe）で読む。
// - M1（凍結の間にタイマーが当たる）: 凍結の段でも更新が今の鍵で回り（A1）、更新した鍵が次の画面へ渡る（A2）。401 は 0、押下の型は `API_CREATE` のまま
//   （通した更新を押下の観察に混ぜない）。直す前は、凍結の間の更新を止め、後半の画面が 401 で `SERVICE_READ_REFUSED` になる。
// - M2（更新の間隔が 1 画面より長い）: 401 で描けなかった画面をセッションの切れ（`SERVICE_UNAUTHORIZED`）にする（B）。DEF-200 のログインし直しの代わりに、
//   テストがサーバから新しいログインの状態を受け、同じ Run の続きから読み直す（ジョブの親のログインし直しの回数と間隔の決まりは、親のテストが確かめる）。
//   残りの画面は 401 にならない。直す前は、セッションの切れにならず、401 の画面を残したまま終わる。
// - M3（確かめの送信。押下の目印を運ぶ更新・危険な語・DELETE が凍結の段で届かない）は、凍結の間の更新の結合の 1 本
//   `discovery-token-refresh-disguise.test.ts` へ移した（SLIM L-3。場面の中身は変えていない）。
// どの形でも、押した送信（`POST /api/items`）は届かない（サーバの記録。名前つきの時間だけ待って数え直す）。Chromium は、1 回だけ流す回の Chromium。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { DISCOVERY_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { discoveryCandidatesOf, mergeDiscoveryCandidates, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { hasSuccessStorageKey, isSuccessStorageKeyName } from '../../src/worker/login-stage-checks.js';
import { BOTH_CHROMIUM_LAUNCHERS, ONCE_CHROMIUM_LABEL, useSharedRunBrowser } from '../helpers/chromium.js';
import { nonReadRequestsOf } from '../helpers/leak-places.js';
import { settleLateDeliveries } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig } from '../helpers/test-config.js';
import { TEST_OBSERVATION_WINDOWS } from '../helpers/test-waits.js';
import {
  TOKEN_REFRESH_KEY_SHAPE,
  TOKEN_REFRESH_PATHS,
  TOKEN_REFRESH_STORAGE_KEY,
  startTokenRefreshSite,
  type TokenRefreshSite,
  type TokenRefreshSiteOptions,
} from '../helpers/token-refresh-site.js';

/** TEST-SLIM D2: M1・M2 は 1 回だけ流す（2 つの Chromium で流していた M3 は disguise へ移した）。 */
const DEFAULT_LABEL = ONCE_CHROMIUM_LABEL;
/**
 * 読む画面の数（後半の画面が token の期限を越える数）。TEST-TIME-B: 期限を 6 秒に縮め、画面の数も 12 から 4 に減らした（前は 20 秒の期限を越えるための数）。
 * 期限を越えたことは、各場面で「Run の長さが期限より長い」ことで確かめる（縮めても、直す前は後半の画面が 401 になる意味を保つ）。
 */
const PAGES = 3;
/**
 * token の期限を数秒に縮める（長い時間を待つ再現はしない）。TEST-TIME-B: 20 秒から 6 秒へ（期限まで `MARGIN_MS` を切ったら更新）。SLIM-GROUP L-4: 3 秒へ縮め、
 * 画面の数も 1 つずつ減らした（期限を越えたことは、今どおり Run の長さで確かめる）。
 */
const ACCESS_LIFETIME_MS = 3_000;
const MARGIN_MS = 1_500;
/**
 * M1: 更新のタイマーの間隔。期限までの残りを問わず更新させ（`marginMs` を期限と同じにする）、押した後の最短の観察の長さ（SLIM-2（X2）: テストの値
 * `TEST_PROBE_QUIET_WAIT_MS`。500ms）より短い間隔にする。押すたびに凍結の中でその長さ以上待つので、凍結の間に必ず更新が起きる（タイマーと凍結の時間が偶然重なる
 * ことに頼らない。TEST-POLICY の 4）。
 */
// SLIM-2: 200ms では更新どうしが重なり、fixture が使い回しの取り消し（PARENT_RETRY）を記録した。観察（500ms）より短く、重ならない長さにする。
const M1_TICK_MS = 400;
/**
 * M2: 時間で期限を切らさない（期限を Run より十分に長くし、タイマーの更新も起きない長さにする）。題材が、items の決めた回数目の読み取りで 1 回だけ期限を
 * 切らす（`expireOnceAtItemRead`）。1 画面の時間の長さに頼らず、ちょうど 1 回だけ期限が切れる（自動ログインの回数の決まり、段ごとに 2 回の中）。
 */
const M2_ACCESS_LIFETIME_MS = 600_000;
const M2_TICK_MS = 600_000;
const M2_EXPIRE_AT_ITEM_READ = 3;
/** M2: 読む画面の数（期限を切らす読み取りの回より多く、ログインし直した後にも画面が残る数。TEST-TIME-B: 12 から 5 へ）。 */
const M2_PAGES = 4;
const NAVIGATION_INTERVAL_MS = 200;
/** 操作さがしの後に、遅れて届く要求を待つ時間（数え直す）。 */
const LATE_REQUEST_WAIT_MS = 2_000;
/** DEF-200 の段ごとのログインし直しの上限（ジョブの親の決まり。テストは同じ数で止める）。 */
const MAX_RELOGINS = 2;
const TEST_TIMEOUT_MS = 280_000;

const authenticationOf = (site: TokenRefreshSite, session: string): RunAuthentication => {
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
      scriptLogin: { origin: site.svcOrigin, path: TOKEN_REFRESH_PATHS.token, requiredQuery: [{ name: 'grant_type', value: 'password' }] },    },
    // ワーカーと同じ作り（`auditStageItemOf`）: 成功の鍵の形で、鍵があるかと、鍵の名前かを判定する。
    sessionKeyPresent: (state) => hasSuccessStorageKey(state, key),
    sessionKeyName: (origin, name) => isSuccessStorageKeyName(origin, name, key),
    // 自動ログインのプロファイル（DEF-200 のログインし直しができる）。
    automatedRelogin: true,
  };
};

interface DiscoveryRound {
  readonly document: DiscoveryDocument;
  /** ログインし直しの前に終わった操作さがしの終わり方と詳しい理由（ログインし直した数だけ）。 */
  readonly lost: readonly string[];
  /** TEST-TIME-B: 最初の操作さがしを始めてから最後の操作さがしが終わるまでの長さ（ms。期限を越えたことの確かめ）。 */
  readonly elapsedMs: number;
}

describe.each(BOTH_CHROMIUM_LAUNCHERS)('DEF-233: the discovery keeps the sign-in of a site that refreshes the token by a timer (%s)', (label, launch) => {
  const itOnDefault = it.runIf(label === DEFAULT_LABEL);
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
  const discover = async (options: TokenRefreshSiteOptions): Promise<DiscoveryRound & { readonly site: TokenRefreshSite }> => {
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
    const lost: string[] = [];
    const startedAt = Date.now();
    for (let attempt = 0; ; attempt += 1) {
      const jobId = `job-def233-${String(attempt)}`;
      const outcome = await executeDiscoveryRun({
        config, jobId, authentication: authenticationOf(started, session), launchBrowser: launchShared,
        clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal, navigationPacer: createTestNavigationPacer(config),
        observationWindows: TEST_OBSERVATION_WINDOWS,
        checkpoint: { identity, ...(resume === undefined ? {} : { resume }) },
      }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
      if (outcome.kind !== 'RAN') throw new Error(`the discovery did not run: ${outcome.kind}`);
      const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
      const validation = await validateArtifact('discovery', document);
      expect(validation.ok ? [] : validation.errors).toEqual([]);
      if (document.endReason !== 'AUTH_SESSION_LOST' || attempt >= MAX_RELOGINS) {
        return { site: started, document, lost, elapsedMs: Date.now() - startedAt };
      }
      lost.push(`${document.endReason} ${document.endReasonDetail ?? ''}`);
      session = started.issueStoredSession();
      resume = { runDirectory: outcome.runDirectory, previousJobId: jobId };
    }
  };

  const refusedPagesOf = (document: DiscoveryDocument): readonly string[] => document.pages.flatMap((page) =>
    (page.state === 'READ' && page.record.incompleteReasons.some((reason) => reason === 'SERVICE_READ_REFUSED') ? [new URL(page.url).pathname] : []));
  const probesOf = (document: DiscoveryDocument): readonly string[] => mergeDiscoveryCandidates(discoveryCandidatesOf(document))
    .flatMap((candidate) => (candidate.submissionProbe === undefined ? [] : [`${candidate.submissionProbe.result} ${candidate.submissionProbe.reason ?? ''}`]));
  const tokenRefreshesOf = (document: DiscoveryDocument): number => document.pages
    .reduce((sum, page) => sum + (page.state === 'READ' ? page.frozenReadRequests?.tokenRefreshes ?? 0 : 0), 0);
  const count401 = (served: TokenRefreshSite): number =>
    served.requestLog.filter(({ origin, path, status }) => origin === 'svc' && path === TOKEN_REFRESH_PATHS.items && status === 401).length;
  /** アプリの Origin に届いた、読み取りでない要求（名前つきの時間だけ待ってから数える）。 */
  const appNonReads = async (served: TokenRefreshSite): Promise<readonly string[]> => {
    // TEST-TIME-B（案 9）: 操作さがしは Browser を閉じて終わるので、受けている途中の要求が 0 になってから短い余白だけ待つ（上限は前の固定の待ち）。
    await settleLateDeliveries(LATE_REQUEST_WAIT_MS, served);
    return nonReadRequestsOf(served.requestLog.filter(({ origin }) => origin === 'app'));
  };

  // fix round 3: 本物の SDK と同じく、読み込みの時にも更新する（凍結の前の更新。BeakSight は、それと同じ形の更新だけを凍結の段で通す）。
  itOnDefault('M1: refreshes the token with the current key while frozen, carries it to the next page and gets no 401', async () => {
    const { site: served, document, lost, elapsedMs } = await discover({
      pages: PAGES, accessLifetimeMs: ACCESS_LIFETIME_MS, marginMs: ACCESS_LIFETIME_MS, tickMs: M1_TICK_MS, refreshOnLoad: true,
    });
    // TEST-TIME-B: 縮めた期限を、操作さがしの長さが越えた（更新しなければ、後半の画面は期限切れの 401 になる長さ）。
    expect(elapsedMs).toBeGreaterThan(ACCESS_LIFETIME_MS);
    expect(lost).toEqual([]);
    expect(document.endReason).toBe('COMPLETED');
    expect(refusedPagesOf(document)).toEqual([]);
    expect(count401(served)).toBe(0);
    // 更新はどれも今の鍵で回った（使い回しの取り消しも、知らない鍵もない）。凍結の間にも通した（A1）。
    expect(served.refreshRecords.length).toBeGreaterThan(0);
    expect(served.refreshRecords.filter(({ outcome }) => outcome !== 'ROTATED')).toEqual([]);
    expect(tokenRefreshesOf(document)).toBeGreaterThan(0);
    // 押下の型は取れ、通した更新が混ざって `MULTIPLE_REQUESTS` にならない。
    const probes = probesOf(document);
    expect(probes).toContain('API_CREATE ');
    expect(probes.filter((probe) => probe.includes('MULTIPLE_REQUESTS'))).toEqual([]);
    expect(await appNonReads(served)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  itOnDefault('M2: takes a page made unreadable by a 401 as the loss of the session, reads it again after the sign-in and leaves no 401 page', async () => {
    const { site: served, document, lost } = await discover({
      pages: M2_PAGES, accessLifetimeMs: M2_ACCESS_LIFETIME_MS, marginMs: MARGIN_MS, tickMs: M2_TICK_MS, expireOnceAtItemRead: M2_EXPIRE_AT_ITEM_READ,
    });
    // 1 回だけ期限が切れ、ログインし直して続けた。
    expect(lost).toEqual(['AUTH_SESSION_LOST SERVICE_UNAUTHORIZED']);
    expect(document.endReason).toBe('COMPLETED');
    expect(refusedPagesOf(document)).toEqual([]);
    // 401 を受けた画面は、ログインし直した後に読み直した（401 は、ログインし直した数だけ）。
    expect(count401(served)).toBe(lost.length);
    // SD-2: 401 を受けた画面の読み込み（凍結の前）でサイト自身が送るログアウトの POST は届く（止めない）。押した送信は届かない。
    expect(await appNonReads(served)).toEqual(['POST /api/session/logout']);
  }, TEST_TIMEOUT_MS);
});

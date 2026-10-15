/**
 * シナリオの画面の目印の検査（Task 28 の設計書 4.7。T28e）。T27f（`discovery-ui-flows.test.ts`）の作りで、ビルドした画面を一時の root の起動の
 * 部品で起動し、テストだけの入口（`helpers/auth-worker.ts`。手動のログインの段で、人の操作の代わりに受け渡しのサーバの資格情報を入れる。ログイン用の
 * Browser も headless）で、本物の発見を 127.0.0.1 の fixture のサイト（`tests/helpers/discovery-site-fixture.ts`）に対して 1 回動かす。その後、
 * 書き込みのモードのプロファイルで、登録（CREATE）の候補からシナリオを作り、変え、承認し、撤回して、次を確かめる。
 * - 秘密の目印（fixture の `secretValues()`: セッションの Cookie、資格情報、CSRF のトークン、入力の欄の今の値、hidden の値、選択肢の label など）と、
 *   画面の Cookie と token が、シナリオの画面の HTML（サーバで描いたものと、ブラウザで開いたもの）と、シナリオの Server Function の応答
 *   （テストが呼んだものと、ブラウザが受けたもの）に、UTF-8 でも UTF-16LE でも出ない（検索は T26f の補助 `leakedPlaces`）。
 * - 対照: 同じ検索で、わざと置いた目印（UTF-16LE）が見つかる。
 * - fixture のサイトに届いた GET と HEAD 以外の要求は、ログインの POST の 1 回だけ（シナリオの作成・承認・撤回は、サイトに何も送らない）。
 * - すべての画面で、CSP の違反と console の誤りが 0 件、外部への要求が 0 件。ワーカーと Chromium の process が残らない。
 * 目印の値は実行ごとのランダムな値で、出力しない（漏れた場所の名前だけを出す）。
 */
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import {
  DISCOVERY_SITE_PATHS,
  startDiscoverySite,
  type DiscoverySite,
} from '../../../tests/helpers/discovery-site-fixture.js';
import { descendantsOf, listProcesses, waitUntilExited, type ProcessIdentity } from '../../../tests/helpers/process-tree.js';
import {
  installTestAuthWorkerEntry,
  startCredentialRelay,
  writeAuthTargetConfig,
  type CredentialRelay,
} from './helpers/auth-worker.ts';
import {
  createTemporaryUiRoot,
  findFreePort,
  parseSetCookie,
  rawRequest,
  startLauncher,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';
import { credentialsOf } from './helpers/scenario-marker-flow.ts';
import { leakedPlaces, textPlace, type SearchedPlace } from './helpers/secret-markers.ts';
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

/** ジョブの終わりを待つ上限と、読み直す間隔（ms）。 */
const JOB_TIMEOUT_MS = 240_000;
const WAIT_POLL_MS = 500;
/** 1 つの場面の上限（ms）。 */
const SCENARIO_TIMEOUT_MS = 360_000;
/** process が消えるのを待つ上限（ms）。 */
const PROCESS_EXIT_LIMIT_MS = 60_000;
/** テストだけの入口の、ログインを待つ時間（ms）。 */
const TEST_LOGIN_TIMEOUT_MS = 120_000;
/** 巡回の上限。 */
const MAX_PAGES = 30;
const PROFILE_ID = 't28e-markers';
const FIRST_REVISION = 1;
/** 対照の目印（わざと置く。実行ごとのランダムな値）。 */
const CONTROL_MARKER = `t28e-control-${Math.random().toString(36).slice(2)}`;

let root: TemporaryUiRoot | undefined;
let site: DiscoverySite | undefined;
let relay: CredentialRelay | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();
const descendants: ProcessIdentity[] = [];
/** ブラウザが受けた Server Function の応答。 */
const browserResponses: SearchedPlace[] = [];

const started = (): StartedServer => {
  if (server === undefined) {
    throw new Error('サーバが起動していない');
  }
  return server;
};
const siteOf = (): DiscoverySite => {
  if (site === undefined) {
    throw new Error('fixture のサイトが起動していない');
  }
  return site;
};

const call = (name: string, method: 'GET' | 'POST', data?: unknown) =>
  callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);

const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await call(name, method, data);
  expect(result.response.status, `${name} ${result.response.body.slice(0, 200)}`).toBe(200);
  return result.value as T;
};

/** 記録つきのページ（CSP の違反、console の誤り、外部への要求。CCX-16 の共通の補助）。 */
const { openPage, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  // ブラウザが受けた Server Function の応答を集める（検索する場所）。
  onPageCreated: (page) => {
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.startsWith('/_serverFn/')) {
        void response.text().then((body) => browserResponses.push(textPlace(`browser response ${new URL(response.url()).pathname}`, body)), () => undefined);
      }
    });
  },
});

const waitForEnd = async (jobId: string): Promise<{ readonly state: string }> => {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  for (;;) {
    const job = await valueOf<{ state: string; active: boolean } | null>('getAuditJobFn', 'GET', { jobId });
    if (job !== null && !job.active) {
      return job;
    }
    if (Date.now() > deadline) {
      throw new Error(`ジョブが終わらなかった: ${JSON.stringify(job)}`);
    }
    descendants.push(...descendantsOf(started().child.pid ?? 0, await listProcesses()));
    await new Promise((resolveWait) => setTimeout(resolveWait, WAIT_POLL_MS));
  }
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  site = await startDiscoverySite();
  relay = await startCredentialRelay();
  installTestAuthWorkerEntry(root.root, relay.url, TEST_LOGIN_TIMEOUT_MS);
  const target = writeAuthTargetConfig(root.root, PROFILE_ID, site.origin, DISCOVERY_SITE_PATHS.admin, MAX_PAGES);
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  expect(await valueOf('createProfileFn', 'POST', {
    profile: {
      schemaVersion: 'beaksight-profile/1',
      profileId: PROFILE_ID,
      revision: FIRST_REVISION,
      targetConfigPath: target,
      environment: 'TEST',
      mode: 'TEST_APPROVED_WRITE',
      auth: 'MANUAL_SESSION',
      approvedTestOrigins: [site.origin],
      environmentEvidenceRef: 't28e-evidence',
    },
  })).toMatchObject({ ok: true });
  expect(await valueOf('saveAuthSetupFn', 'POST', {
    setup: {
      schemaVersion: 'beaksight-auth-setup/2',
      profileId: PROFILE_ID,
      profileRevision: FIRST_REVISION,
      loginStartUrl: `${site.origin}${DISCOVERY_SITE_PATHS.login}`,
      loginPostEndpoints: [{ origin: site.origin, path: DISCOVERY_SITE_PATHS.login }],
      successCondition: { pathPrefix: DISCOVERY_SITE_PATHS.admin, selector: '#admin-ok' },
      sessionLostCondition: { pathPrefix: null },
      excludedPaths: [DISCOVERY_SITE_PATHS.logout, DISCOVERY_SITE_PATHS.spa, DISCOVERY_SITE_PATHS.beacon],
      auditPathPrefixes: [DISCOVERY_SITE_PATHS.admin],
      maxLoginAttempts: 2,
      allowedIdpOrigins: [],
      automatedLogin: null,
    },
  })).toMatchObject({ ok: true });
});

afterEach(async () => {
  await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  expect(await waitUntilExited(descendants, PROCESS_EXIT_LIMIT_MS)).toEqual([]);
  await relay?.close();
  await site?.close();
  root?.remove();
});

describe('T28e: no secret marker on the scenario screens', () => {
  it('discovers, makes, changes, approves and revokes a scenario, and no secret marker is on the scenario screens or in their responses', async () => {
    relay?.provide(await credentialsOf(siteOf()));
    const job = await valueOf<{ ok: boolean; jobId: string }>('startDiscoveryFn', 'POST', { profileId: PROFILE_ID, expectedRevision: FIRST_REVISION });
    expect(job.ok).toBe(true);
    expect(await waitForEnd(job.jobId)).toMatchObject({ state: 'FINISHED' });

    const discovery = await valueOf<{ candidates: readonly { identityDigest: string; pagePath: string; classification: string; scenarioCreatable: boolean }[] }>(
      'discoveryPageFn', 'GET', { profileId: PROFILE_ID });
    const create = discovery.candidates.find((candidate) => candidate.pagePath === DISCOVERY_SITE_PATHS.create && candidate.classification === 'CREATE');
    expect(create?.scenarioCreatable).toBe(true);
    const digest = create?.identityDigest ?? '';
    const form = await valueOf<{ candidate: { fields: readonly { name: string; rejection: string | null }[] } | null }>(
      'scenarioFormPageFn', 'GET', { profileId: PROFILE_ID, candidateIdentityDigest: digest });
    expect(form.candidate?.fields.map(({ name, rejection }) => [name, rejection])).toEqual([
      ['authenticity_token', 'SCENARIO_FIELD_SECRET_LIKE'],
      ['name', null],
      ['secret_hidden', 'SCENARIO_FIELD_NOT_ALLOWED'],
    ]);
    const confirmed = { TEST_RECORDS_ONLY: true, NO_EXTERNAL_NOTIFICATION: true, NO_PAYMENT_OR_EXTERNAL_SERVICE: true, NOT_DESTRUCTIVE: true };
    const draft = { fieldNames: ['name'], readChecks: [], sideEffectConfirmations: confirmed, limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 }, approvalTtlDays: 30 };
    const created = await valueOf<{ ok: boolean; scenarioId: string }>('createScenarioFn', 'POST', {
      draft: { profileId: PROFILE_ID, candidateIdentityDigest: digest, ...draft },
    });
    expect(created.ok).toBe(true);
    const { scenarioId } = created;
    expect(await valueOf('updateScenarioFn', 'POST', { scenarioId, expectedRevision: 1, draft: { ...draft, approvalTtlDays: 7 } }))
      .toMatchObject({ ok: true, revision: 2 });
    const detail = await valueOf<{ status: { approvalDigest: string } | null }>('scenarioDetailPageFn', 'GET', { scenarioId });
    expect(await valueOf('approveScenarioFn', 'POST', { scenarioId, expectedRevision: 2, expectedApprovalDigest: detail.status?.approvalDigest }))
      .toMatchObject({ ok: true });
    expect(await valueOf('updateScenarioFn', 'POST', { scenarioId, expectedRevision: 2, draft }))
      .toMatchObject({ ok: true, revision: 3 });
    const again = await valueOf<{ status: { approvalDigest: string } | null }>('scenarioDetailPageFn', 'GET', { scenarioId });
    expect(await valueOf('approveScenarioFn', 'POST', { scenarioId, expectedRevision: 3, expectedApprovalDigest: again.status?.approvalDigest }))
      .toMatchObject({ ok: true });
    expect(await valueOf('revokeScenarioFn', 'POST', { scenarioId, expectedRevision: 3 })).toMatchObject({ ok: true });

    const places: SearchedPlace[] = [];
    const paths = [
      `/scenarios/${PROFILE_ID}`,
      `/scenarios/${PROFILE_ID}/new?candidate=${encodeURIComponent(digest)}`,
      `/scenarios/${PROFILE_ID}/${scenarioId}`,
      `/scenarios/${PROFILE_ID}/${scenarioId}/edit`,
      `/profiles/${PROFILE_ID}`,
    ];
    for (const path of paths) {
      const response = await rawRequest(started().port, path, { headers: { cookie } });
      expect(response.status, path).toBe(200);
      places.push(textPlace(`server HTML ${path}`, response.body));
      const page = await openPage(path);
      places.push(textPlace(`browser HTML ${path}`, await page.content()));
    }
    for (const [name, data] of [
      ['scenarioListPageFn', { profileId: PROFILE_ID }],
      ['scenarioFormPageFn', { profileId: PROFILE_ID, candidateIdentityDigest: digest }],
      ['scenarioDetailPageFn', { scenarioId }],
    ] as const) {
      places.push(textPlace(`test response ${name}`, (await call(name, 'GET', data)).response.body));
    }
    expect(browserResponses.length).toBeGreaterThan(0);
    places.push(...browserResponses);
    console.info(`[CCX-16] t28e searched places: ${places.length}`);

    const cookieValue = cookie.split('=').slice(1).join('=');
    const screenToken = started().tokenUrl.searchParams.values().next().value ?? '';
    const markers = [...siteOf().secretValues(), cookieValue, screenToken].filter((marker) => marker.length > 0);
    expect(markers.length).toBeGreaterThan(5);
    expect(leakedPlaces(places, markers)).toEqual([]);
    // 対照: 同じ検索で、わざと置いた目印（UTF-16LE）が見つかる。
    expect(leakedPlaces([{ place: 'control', bytes: Buffer.from(`x${CONTROL_MARKER}y`, 'utf16le') }], [CONTROL_MARKER])).toEqual(['control (utf16le)']);

    // サイトに届いた GET と HEAD 以外の要求は、ログインの POST の 1 回だけ。
    expect(siteOf().requests.filter(({ method }) => method !== 'GET' && method !== 'HEAD').map(({ method, path }) => `${method} ${path}`))
      .toEqual([`POST ${DISCOVERY_SITE_PATHS.login}`]);
  }, SCENARIO_TIMEOUT_MS);
});

/**
 * シナリオの画面の流れの目印の検査の作り（T28f の検査の作りを、T29f の入力の規則の画面の目印の検査と共用するために、ここへ移した。T29f）。
 * SLIM-GROUP UI-6 で、T27g と T28f の検査は `discovery-approval-secret-markers.test.ts`、T25f と T26f の検査は `login-secret-markers.test.ts` になり、
 * どちらもこの作りを使う（プロファイルのモード、読み込みの間隔、プロファイルごとに読む画面と Server Function を
 * 設定で替える。既定は T28f・T29f の値）。
 * - ビルドした画面を一時の root の起動の部品で起動し（子プロセスの起動を記録する、テストだけの前処理つき）、ワーカーの入口をテストだけの入口
 *   （`helpers/auth-worker.ts` の `installTestAuthWorkerEntry`。IPC と親から受けたメッセージを記録する）に替える。手動のログインは、受け渡しの
 *   サーバ（`startCredentialRelay`）がテストだけの入口に資格情報を渡す。
 * - 画面の操作: 発見のジョブ（候補の画面の開始のボタン）、READ の確かめの定義の作成、サイトの画面の一覧のチェックを入れる・外す（SPEC-4。書き込みの
 *   手順の下書き・承認・撤回は、チェックの保存が行う。手で作る作成の画面と承認・撤回のダイアログは外した）、資格情報の登録、書き込みのモードのプロファイルと
 *   認証の設定の作成。ブラウザで開いた画面の HTML と、ブラウザが受けた Server Function の応答を集める。ジョブごとに、サイトへの要求の窓を記録する。
 * - 検索する場所（`searchedPlaces`）: 一時の root のすべてのファイル（`node_modules` の junction は除く）、管理データのすべての表のすべての行、画面の
 *   サーバの標準出力と標準エラー、子プロセスの起動の記録、すべての画面の HTML（サーバで描いたもの・ブラウザで開いたもの・成果物の画面。足す画面は
 *   `extraScreenPaths`）、Server Function の応答（集めたものと、いま読むもの。足す呼び出しは `extraFunctionCalls`）。検索は
 *   `helpers/secret-markers.ts` を使う（UTF-8 と UTF-16LE）。
 * - 目印の値は出力しない（漏れた場所の名前と、文字の形だけを出す）。fixture のサイトは 127.0.0.1 だけ。Chromium は headless だけ。
 */
import { mkdirSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import { expect } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../../tests/helpers/auth-setup-samples.js';
import {AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS } from '../../../../src/control/auth/auth-setup-contracts.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../../../src/control/store/control-database.js';
import { CONTROL_DATA_DIRECTORY_NAME, resolveControlDatabasePath } from '../../../../src/control/store/database-path.js';
import { formatCompactUtcTimestamp } from '../../../../src/core/utc-timestamp.js';
import { READ_CHECK_EXPECTATION_KIND_CATALOG } from '../../../../src/presentation/catalog.js';
import { LOCAL_UI_CREDENTIAL_TEXT, LOCAL_UI_READ_CHECK_TEXT } from '../../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../../tests/helpers/chromium.js';
import { nonReadRequestsOf } from '../../../../tests/helpers/leak-places.js';
import {
  DISCOVERY_SITE_BEACON_BODY,
  DISCOVERY_SITE_LOGIN_FIELDS,
  DISCOVERY_SITE_PATHS,
  DISCOVERY_SITE_READ_CHECK_PATHS,
  type DiscoverySite,
  type DiscoverySiteRequest,
} from '../../../../tests/helpers/discovery-site-fixture.js';
import { descendantsOf, listProcesses, waitUntilExited, type ProcessIdentity } from '../../../../tests/helpers/process-tree.js';
import {
  WORKER_PARENT_MESSAGE_RECORD,
  WORKER_RECORD_FILES,
  installTestAuthWorkerEntry,
  startCredentialRelay,
  writeAuthTargetConfig,
  type CredentialRelay,
  type RelayedCredentials,
} from './auth-worker.ts';
import {
  BUILT_SERVER_ENTRY,
  createTemporaryUiRoot,
  findFreePort,
  parseSetCookie,
  rawRequest,
  startLauncherWithNodeArguments,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './local-server.ts';
import {
  childProcessRecordingSource,
  childProcessRecordsOf,
  databaseRowsPlace,
  filesUnder,
  leakedPlaces,
  textPlace,
  writeChildProcessRecordingPreload,
  type SearchedPlace,
} from './secret-markers.ts';
import { callServerFunction, readServerFunctionIds, type ServerFunctionCall } from './server-functions.ts';
import { waitForJobViaServerFunctions } from './server-function-job-wait.ts';
import { createProfileInStore, saveAuthSetupRequestInStore } from './profile-store-setup.ts';
import { createUiPageKit } from './ui-page.ts';

/** 画面の操作を待つ上限（ms）。 */
export const UI_TIMEOUT_MS = 20_000;
/** 状態を読み直す間隔（ms）。 */
const POLL_MS = 250;
/** ジョブの終わりを待つ上限（ms。ワーカーの起動、ログイン、Chromium を含む）。 */
export const JOB_TIMEOUT_MS = 240_000;
/** 1 つの場面の上限（ms）。 */
export const SCENARIO_TIMEOUT_MS = 540_000;
/** process が消えるのを待つ上限（ms）。 */
const PROCESS_EXIT_LIMIT_MS = 60_000;
/** テストだけの入口の、手動のログインを待つ時間（ms）。 */
const TEST_LOGIN_TIMEOUT_MS = 120_000;
/** 巡回の上限（読む範囲の画面をすべて読める数）。 */
const MAX_PAGES = 30;
export const FIRST_REVISION = 1;
/** 手動のログインの送信の回数の上限（認証の設定の値）。 */
const MANUAL_MAX_LOGIN_ATTEMPTS = 2;
/** HTTP の状態。 */
export const STATUS = Object.freeze({ OK: 200 });
/** 一時の root の検索で読まないフォルダ（リポジトリの `node_modules` への junction）。 */
const SKIPPED_DIRECTORY_NAMES = Object.freeze(['node_modules']);
/** 子プロセスの起動の記録（記録のフォルダの中）。 */
const SERVER_CHILD_PROCESS_RECORD = 'server-child-processes.jsonl';
const WORKER_CHILD_PROCESS_RECORD = 'worker-child-processes.jsonl';
/** ジョブ 1 回のログインの POST の数。 */
export const LOGIN_POSTS_PER_JOB = 1;
/** 照会の定義の送る値と期待（fixture の注文の 1 行目。秘密ではない）。 */
const LOOKUP_ID = 'A-1';
const DETAIL_FIELD = '名前';
const DETAIL_VALUE = 'りんご';
/** プロファイルごとの画面のパスの頭（すべての画面の HTML を検索する。設定の既定）。 */
const PROFILE_SCREEN_PREFIXES = Object.freeze(['/profiles/', '/auth-setup/', '/credentials/', '/login-check/', '/discovery/', '/read-checks/']);
/** プロファイルごとに、いま読む Server Function（設定の既定）。 */
const PROFILE_FUNCTIONS = Object.freeze(['getProfileFn', 'getAuthSetupFn', 'getCredentialPageFn', 'discoveryPageFn', 'readCheckPageFn', 'scenarioListPageFn']);

const readText = LOCAL_UI_READ_CHECK_TEXT;
const credentialText = LOCAL_UI_CREDENTIAL_TEXT;

/** ジョブの詳細（画面の Server Function の値のうち、確かめに使うもの）。 */
export interface JobDetail {
  readonly jobId: string;
  readonly jobKind: string;
  readonly active: boolean;
  readonly state: string;
  readonly runStatus: string | null;
  readonly lastAuthState: string | null;
  readonly autoLogin: { readonly result: string | null; readonly submitted: string | null } | null;
  readonly artifacts: readonly { readonly href: string }[];
}

/** ジョブごとのサイトへの要求の窓。 */
export interface JobWindow {
  readonly label: string;
  readonly site: DiscoverySite;
  readonly from: number;
  readonly to: number;
}

/** 作りの設定。 */
export interface ScenarioMarkerFlowOptions {
  /** テストの名前（記録のフォルダ `<label>-records`、前処理のファイル、環境の証跡の参照、管理データの時刻の用途に使う。匿名の値）。 */
  readonly label: string;
  /** 画面と Server Function を読むプロファイル。 */
  readonly profileIds: () => readonly string[];
  /** 秘密の目印（どこにも出てはならない）。 */
  readonly secretMarkers: () => readonly string[];
  /** 足して検索する、サーバで描く画面のパス。 */
  readonly extraScreenPaths: () => readonly string[];
  /** 足して呼ぶ Server Function（名前と入力。GET）。 */
  readonly extraFunctionCalls: () => readonly (readonly [string, unknown])[];
  /** 画面の Cookie と token を探す場所か（場所の名前で決める）。 */
  readonly isScreenSecretPlace: (place: string) => boolean;
  /** 作るプロファイルのモード（既定は `TEST_APPROVED_WRITE`）。 */
  readonly profileMode?: 'TEST_APPROVED_WRITE' | 'TEST_AUTH_PASSIVE';
  /** ターゲット設定の読み込みの最小の間隔（ms。既定は 0）。 */
  readonly navigationIntervalMs?: number;
  /** プロファイルごとの画面のパスの頭（既定は `PROFILE_SCREEN_PREFIXES`）。 */
  readonly profileScreenPrefixes?: readonly string[];
  /** プロファイルごとに、いま読む Server Function（既定は `PROFILE_FUNCTIONS`）。 */
  readonly profileFunctions?: readonly string[];
  /**
   * T32h: 開いたページに記録（CSP の違反・console の誤り・外への要求）を付けるか（既定は偽。目印の検査は記録を付けずに開く）。真にすると、
   * `expectCleanPages` で確かめられる。
   */
  readonly recordPages?: boolean;
  /** UI-6: Tab を押す回数の上限（`tabTo` を使うときだけ渡す）。 */
  readonly maxTabPresses?: number;
}

/** UI-6（INV-SLIM）: 検索の画面と Server Function を、同時にこの本数まで読む（読む場所と数は変えない）。 */
const SEARCH_READ_CONCURRENCY = 4;

/** `items` を、同時に `limit` 本まで `read` で読み、元の順に並べて返す。 */
const readInPool = async <T, R>(items: readonly T[], limit: number, read: (item: T) => Promise<R>): Promise<readonly R[]> => {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await read(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
};

/** 窓の中の、GET と HEAD 以外の要求（`<method> <path>`。CC-093: 定義は `tests/helpers/leak-places.ts` の 1 か所）。 */
export { nonReadRequestsOf };

/** ログインの POST を `count` 回（`<method> <path>`）。 */
export const loginPosts = (count: number): readonly string[] => Array.from({ length: count }, () => `POST ${DISCOVERY_SITE_PATHS.login}`);

/** DEF-257: 仮のサイトの beacon の画面が、読み込みで自分で送る POST（`<method> <path>`。既定の送信の扱い `PASS_EXCEPT_DELETE` の決まりどおり通る）。 */
const SITE_BEACON_POST = `POST ${DISCOVERY_SITE_PATHS.collect}`;

/**
 * DEF-257: 要求の、GET・HEAD と、beacon の POST のほかの要求（`<method> <path>`。3 つの secret-markers の唯一の数え方）。beacon の POST は、本文が決まった文字
 * （`DISCOVERY_SITE_BEACON_BODY`。目印を含まない）であることを、ここで確かめる。
 */
export const nonReadRequestsBesidesBeaconOf = (requests: readonly DiscoverySiteRequest[], label?: string): readonly string[] => {
  const nonRead = nonReadRequestsOf(requests);
  const beacons = requests.filter(({ method, path }) => `${method} ${path}` === SITE_BEACON_POST);
  expect(beacons.map(({ body }) => body), label).toEqual(beacons.map(() => DISCOVERY_SITE_BEACON_BODY));
  return nonRead.filter((request) => request !== SITE_BEACON_POST);
};

/** `<場所> (<文字の形>)` から場所の名前を取り出す。 */
export const placeNameOf = (leaked: string): string => leaked.slice(0, leaked.lastIndexOf(' ('));

/** fixture の正しい資格情報（値はテストの process の中だけ。出力しない）。 */
export const credentialsOf = async (site: DiscoverySite): Promise<RelayedCredentials> => {
  const fields: (readonly [string, string])[] = [];
  await site.fillCredentials(async (selector, value) => {
    fields.push([selector, value]);
  });
  return { fields, submit: DISCOVERY_SITE_LOGIN_FIELDS.submit };
};

/** 認証の設定（自動ログインなら、自動ログインの項目つき）。 */
const authSetupOf = (profileId: string, site: DiscoverySite, automated: boolean): Record<string, unknown> => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId,
  profileRevision: FIRST_REVISION,
  loginStartUrl: `${site.origin}${DISCOVERY_SITE_PATHS.login}`,
  loginPostEndpoints: [{ origin: site.origin, path: DISCOVERY_SITE_PATHS.login }],
  successCondition: { pathPrefix: DISCOVERY_SITE_PATHS.admin, selector: '#admin-ok' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [DISCOVERY_SITE_PATHS.logout, DISCOVERY_SITE_READ_CHECK_PATHS.privateArea],
  auditPathPrefixes: [DISCOVERY_SITE_PATHS.admin],
  maxLoginAttempts: automated ? AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS : MANUAL_MAX_LOGIN_ATTEMPTS,
  allowedIdpOrigins: [],
  automatedLogin: automated
    ? {
      usernameSelector: DISCOVERY_SITE_LOGIN_FIELDS.user,
      passwordSelector: DISCOVERY_SITE_LOGIN_FIELDS.pass,
      submitSelector: DISCOVERY_SITE_LOGIN_FIELDS.submit,
      failureConditions: {
        invalidCredentials: { pathPrefix: DISCOVERY_SITE_PATHS.loginError, selector: '#invalid' },
        accountLocked: null,
        mfaRequired: null,
        credentialExpired: null,
      },
    }
    : null,
});

/** 候補の画面の、ある画面のある分類の候補の selector。 */
const candidateSelectorOf = (path: string, classification: string): string =>
  `[data-testid="discovery-page"][data-page-path="${path}"] [data-testid="discovery-candidate"][data-classification="${classification}"]`;

/** シナリオの画面の流れの目印の検査の作り（状態はこの値の中だけに持つ）。 */
export const createScenarioMarkerFlow = (options: ScenarioMarkerFlowOptions) => {
  let root: TemporaryUiRoot | undefined;
  let relay: CredentialRelay | undefined;
  let server: StartedServer | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let cookie = '';
  let ids: ReadonlyMap<string, string> = new Map();
  /** Server Function の id から名前への表（ブラウザが受けた応答の場所の名前に使う）。 */
  let functionNames: ReadonlyMap<string, string> = new Map();
  /** 監査の間に見つけた、画面のサーバの子孫（ワーカーと Chromium）。 */
  const descendants: ProcessIdentity[] = [];
  /** 画面の HTML（ブラウザで開いたもの）。 */
  const htmlSnapshots: { readonly path: string; readonly html: string }[] = [];
  /** Server Function の応答の本文（関数の名前つき。ブラウザとテストの両方）。 */
  const responseBodies: { readonly name: string; readonly body: string }[] = [];
  /** 始めたジョブ。 */
  const jobs: { readonly jobId: string; readonly profileId: string }[] = [];
  const windows: JobWindow[] = [];

  const rootOf = (): string => {
    if (root === undefined) {
      throw new Error('一時の root がない');
    }
    return root.root;
  };
  const started = (): StartedServer => {
    if (server === undefined) {
      throw new Error('サーバが起動していない');
    }
    return server;
  };
  const relayOf = (): CredentialRelay => {
    if (relay === undefined) {
      throw new Error('受け渡しのサーバがない');
    }
    return relay;
  };
  const recordDirectoryName = `${options.label}-records`;
  const recordDirectory = (): string => `${rootOf()}/${recordDirectoryName}`;
  const databasePath = (): string => resolveControlDatabasePath(rootOf());
  const nowTimestamp = (): string => formatCompactUtcTimestamp(new Date(), `${options.label} test-only control data write`);

  /** 画面の Cookie と token（決まった範囲の画面の HTML と Server Function の応答に出てはならない）。 */
  const screenSecrets = (): readonly string[] => [
    cookie.split('=').slice(1).join('='),
    started().tokenUrl.searchParams.values().next().value ?? '',
  ].filter((value) => value.length > 0);

  /** 一時の root、受け渡しのサーバ、テストだけのワーカーの入口、画面のサーバ（記録の前処理つき）、headless の Chromium を用意し、token を Cookie にする。 */
  const start = async (): Promise<void> => {
    root = createTemporaryUiRoot('built');
    mkdirSync(recordDirectory(), { recursive: true });
    relay = await startCredentialRelay();
    installTestAuthWorkerEntry(rootOf(), relay.url, TEST_LOGIN_TIMEOUT_MS, recordDirectory(), {
      recordParentMessages: true,
      prelude: childProcessRecordingSource(`${recordDirectory()}/${WORKER_CHILD_PROCESS_RECORD}`, 'worker'),
    });
    const preload = writeChildProcessRecordingPreload(`${rootOf()}/${options.label}-child-process-recording.mjs`,
      `${recordDirectory()}/${SERVER_CHILD_PROCESS_RECORD}`, 'server');
    ids = readServerFunctionIds(BUILT_SERVER_ENTRY);
    functionNames = new Map([...ids].map(([name, id]) => [id, name]));
    browser = await launchHeadlessChromium();
    server = await startLauncherWithNodeArguments(root, await findFreePort(), ['--import', preload]);
    context = await browser.newContext();
    const tokenPage = await context.newPage();
    await tokenPage.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
    await tokenPage.close();
    const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
    cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  };

  /** Chromium、画面のサーバ、受け渡しのサーバを止め、子孫の process が残らないことを確かめ、一時の root を消す。 */
  const stop = async (): Promise<void> => {
    await context?.close();
    await browser?.close();
    await stopServer(server);
    expect(await waitUntilExited(descendants, PROCESS_EXIT_LIMIT_MS)).toEqual([]);
    await relay?.close();
    root?.remove();
  };

  /**
   * 画面のページを開く（記録は付けない。ブラウザが受けた Server Function の応答の本文を集める）と、開いたページを閉じる（各テストの後）。
   * CCX-16 の共通の補助（`ui-page.ts`）。
   */
  const { openPage, forgetPages: closePages, expectCleanPages, tabTo } = createUiPageKit({
    contextOf: () => context,
    originOf: () => started().origin,
    recordPages: options.recordPages ?? false,
    ...(options.maxTabPresses === undefined ? {} : { maxTabPresses: options.maxTabPresses }),
    onPageCreated: (page) => {
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.pathname.startsWith('/_serverFn/')) {
          const name = functionNames.get(url.pathname.split('/').at(-1) ?? '') ?? 'unknown';
          void response.text().then((body) => responseBodies.push({ name, body }), () => undefined);
        }
      });
    },
  });

  const snapshot = async (page: Page): Promise<void> => {
    htmlSnapshots.push({ path: new URL(page.url()).pathname, html: await page.content() });
  };

  const callFunction = async (name: string, method: 'GET' | 'POST', data?: unknown): Promise<ServerFunctionCall> => {
    const result = await callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
    responseBodies.push({ name, body: result.response.body });
    return result;
  };

  const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
    const result = await callFunction(name, method, data);
    expect(result.response.status, name).toBe(STATUS.OK);
    return result.value as T;
  };

  /** 画面のサーバが開いている管理データに、別の接続で（テストだけの操作として）読み書きする。 */
  const withControlData = <T>(use: (database: ControlDatabase) => T): T => {
    const database = openControlDatabase(databasePath());
    try {
      return use(database);
    } finally {
      closeControlDatabase(database);
    }
  };

  /** 画面のサーバの子孫（ワーカーと Chromium）を記録する（止めるときに、残らないことを確かめる）。見つけた子孫を返す。 */
  const recordDescendants = async (): Promise<readonly ProcessIdentity[]> => {
    const found = descendantsOf(started().child.pid ?? 0, await listProcesses());
    descendants.push(...found);
    return found;
  };

  /** ジョブが終わるまで待つ（その間の画面のサーバの子孫を記録する）。 */
  const waitForJobEnd = async (jobId: string): Promise<JobDetail> => {
    await recordDescendants();
    // PRE42-CC 組 UI-K2（CC-112）: 読み直して待つのは補助 `waitForJobViaServerFunctions`（上限と間隔は前と同じ）。
    return waitForJobViaServerFunctions(
      (id) => valueOf<JobDetail | null>('getAuditJobFn', 'GET', { jobId: id }),
      jobId,
      (job) => !job.active,
      { limitMs: JOB_TIMEOUT_MS, stepMs: POLL_MS },
    );
  };

  /** 候補の画面の開始のボタンで発見のジョブを始め、終わるまで待つ。ジョブの画面の HTML を集め、サイトへの要求の窓を記録する。 */
  const runDiscoveryFrom = async (profileId: string, site: DiscoverySite): Promise<JobDetail> => {
    const page = await openPage(`/discovery/${profileId}`);
    const from = site.requests.length;
    await page.getByTestId('discovery-start').click();
    await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
    const jobId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    jobs.push({ jobId, profileId });
    const job = await waitForJobEnd(jobId);
    await page.locator('[data-testid="job-state"]:not([data-state="STARTING"]):not([data-state="RUNNING"]):not([data-state="STOPPING"])')
      .waitFor({ timeout: JOB_TIMEOUT_MS });
    await snapshot(page);
    windows.push({ label: `${profileId} DISCOVERY`, site, from, to: site.requests.length });
    return job;
  };

  /** 照会の画面の READ の候補で、READ の確かめの定義を画面で作る（照会の id と、詳細の欄の期待）。定義の ID を返す。 */
  const saveLookupDefinition = async (profileId: string): Promise<string> => {
    const discovery = await openPage(`/discovery/${profileId}`);
    await snapshot(discovery);
    const digest = await discovery.locator(candidateSelectorOf(DISCOVERY_SITE_READ_CHECK_PATHS.lookup, 'READ')).first().getAttribute('data-digest');
    expect(digest, 'the READ candidate of the lookup').not.toBeNull();
    const page = await openPage(`/read-checks/${profileId}/new?candidate=${encodeURIComponent(digest ?? '')}`);
    await page.getByTestId('read-check-form').waitFor({ timeout: UI_TIMEOUT_MS });
    await page.getByTestId('read-check-parameters').getByLabel('id', { exact: true }).fill(LOOKUP_ID);
    const row = page.locator('[data-testid="read-check-expectation"][data-index="0"]');
    await row.getByLabel(readText.expectationKind, { exact: true }).selectOption({ label: READ_CHECK_EXPECTATION_KIND_CATALOG.DETAIL_FIELD_EQUALS.label });
    await row.getByLabel(readText.expectationField, { exact: true }).fill(DETAIL_FIELD);
    await row.getByLabel(readText.expectationValue, { exact: true }).fill(DETAIL_VALUE);
    await page.getByTestId('read-check-save').click();
    await page.waitForURL(new RegExp(`/read-checks/${profileId}\\?notice=saved$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await page.getByTestId('read-check-definition').first().waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    await snapshot(page);
    const all = await page.getByTestId('read-check-definition').evaluateAll((rows) => rows.map((element) => element.getAttribute('data-read-check-id') ?? ''));
    expect(all).toHaveLength(1);
    return all[0] ?? '';
  };

  /** 操作さがしの画面の、登録の画面の登録（CREATE）の候補の digest（サイトの画面の一覧の行の鍵と同じ値）。 */
  const createCandidateDigestOf = async (profileId: string): Promise<string> => {
    const discovery = await openPage(`/discovery/${profileId}`);
    const candidate = discovery.locator(candidateSelectorOf(DISCOVERY_SITE_PATHS.create, 'CREATE')).first();
    await candidate.waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    return await candidate.getAttribute('data-digest') ?? '';
  };

  /**
   * SPEC-4（設計書 `2026-11-14-beaksight-slim-and-simplify-design.md` 5.1）: サイトの画面の「登録・更新を試せる画面」の一覧で、登録の画面の行のチェックを入れる
   * （`checked`）か外す。チェックの保存が、書き込みのモードへの切り替え・下書き・承認（外すと撤回）を 1 回で行う。行の状態が変わるまで待ち、前後の画面の HTML を
   * 集める。行の鍵（候補の digest）を返す。
   */
  const setWriteScreenCheckOnList = async (profileId: string, checked: boolean): Promise<string> => {
    const rowKey = await createCandidateDigestOf(profileId);
    const page = await openPage(`/profiles/${profileId}`);
    const row = page.locator(`[data-testid="write-screen-row"][data-row-key="${rowKey}"]`);
    await row.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await row.getAttribute('data-state')).toBe(checked ? 'CHECKABLE' : 'CHECKED');
    await snapshot(page);
    await row.getByTestId('write-screen-check').click();
    await expect.poll(() => row.getAttribute('data-state'), { timeout: UI_TIMEOUT_MS }).toBe(checked ? 'CHECKED' : 'CHECKABLE');
    expect(await row.getByTestId('write-screen-rejection').count()).toBe(0);
    await snapshot(page);
    return rowKey;
  };

  /**
   * プロファイル（モードは設定。既定は書き込みのモード）と認証の設定を作る（ターゲット設定は、fixture のサイトの Origin だけを許し、読み込みの
   * 間隔は設定の値）。
   */
  const prepareProfile = async (profileId: string, site: DiscoverySite, automated: boolean): Promise<void> => {
    const targetConfigPath = writeAuthTargetConfig(rootOf(), profileId, site.origin, DISCOVERY_SITE_PATHS.admin, MAX_PAGES,
      options.navigationIntervalMs ?? 0);
    const profile = {
      schemaVersion: 'beaksight-profile/1',
      profileId,
      revision: FIRST_REVISION,
      targetConfigPath,
      environment: 'TEST',
      mode: options.profileMode ?? 'TEST_APPROVED_WRITE',
      auth: automated ? 'AUTOMATED_LOGIN' : 'MANUAL_SESSION',
      approvedTestOrigins: [site.origin],
      environmentEvidenceRef: `${options.label}-evidence`,
    };
    // MI-F1（設計書 4.7.1 の 2）: 自動ログインのプロファイルは、画面の作成の口では作れない（切り替えだけで入る）。テストの準備は、保存の部品で直接作る。
    expect(automated ? await createProfileInStore(rootOf(), profile) : await valueOf('createProfileFn', 'POST', { profile })).toMatchObject({ ok: true });
    expect(await saveAuthSetupRequestInStore(root, { setup: authSetupOf(profileId, site, automated) })).toMatchObject({ ok: true });
  };

  /** 資格情報の画面で、新しく登録する（パスワードは 2 回）。登録の後の画面の HTML を集める。 */
  const registerCredentialOnPage = async (profileId: string, site: DiscoverySite): Promise<void> => {
    const values = new Map((await credentialsOf(site)).fields);
    const page = await openPage(`/credentials/${profileId}`);
    await page.getByTestId('credential-register-form').waitFor({ timeout: UI_TIMEOUT_MS });
    const password = values.get(DISCOVERY_SITE_LOGIN_FIELDS.pass) ?? '';
    await page.getByLabel(credentialText.username, { exact: true }).fill(values.get(DISCOVERY_SITE_LOGIN_FIELDS.user) ?? '');
    await page.getByLabel(credentialText.password, { exact: true }).fill(password);
    const confirmation = page.getByLabel(credentialText.passwordConfirmation, { exact: true });
    await confirmation.fill(password);
    await confirmation.press('Enter');
    await page.locator('[data-testid="credential-done"], [data-testid="credential-rejection"]').first().waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('credential-rejection').count()).toBe(0);
    await snapshot(page);
  };

  /** 画面の HTML（すべての画面。サーバで描いたもの）と、成果物の画面と、ブラウザで開いた画面。 */
  const screenPlaces = async (): Promise<readonly SearchedPlace[]> => {
    const paths = ['/', '/jobs', '/environment'];
    for (const profileId of options.profileIds()) {
      paths.push(...(options.profileScreenPrefixes ?? PROFILE_SCREEN_PREFIXES).map((prefix) => `${prefix}${profileId}`));
    }
    paths.push(...options.extraScreenPaths());
    paths.push(...jobs.map(({ jobId }) => `/jobs/${jobId}`));
    const artifactPaths = (await readInPool(jobs, SEARCH_READ_CONCURRENCY, ({ jobId }) => valueOf<JobDetail | null>('getAuditJobFn', 'GET', { jobId })))
      .flatMap((job) => (job?.artifacts ?? []).map(({ href }) => href));
    const places: SearchedPlace[] = [...await readInPool([...paths, ...artifactPaths], SEARCH_READ_CONCURRENCY, async (path) => {
      const response = await rawRequest(started().port, path, { headers: { cookie } });
      expect(response.status, path).toBe(STATUS.OK);
      return textPlace(`html:${path}`, response.body);
    })];
    places.push(...htmlSnapshots.map(({ path, html }, index) => textPlace(`browser-html:${index}:${path}`, html)));
    return places;
  };

  /** Server Function の応答（読むもののすべてを、いま読む。集めた応答も含める）。 */
  const functionPlaces = async (): Promise<readonly SearchedPlace[]> => {
    const calls: (readonly [string, unknown])[] = [['listProfilesFn', undefined], ['listAuditJobsFn', undefined], ['environmentStatusFn', undefined]];
    for (const profileId of options.profileIds()) {
      calls.push(...(options.profileFunctions ?? PROFILE_FUNCTIONS).map((name) => [name, { profileId }] as const));
    }
    calls.push(...options.extraFunctionCalls());
    calls.push(...jobs.map(({ jobId }) => ['getAuditJobFn', { jobId }] as const));
    await readInPool(calls, SEARCH_READ_CONCURRENCY, ([name, data]) => callFunction(name, 'GET', data));
    return responseBodies.map(({ name, body }, index) => textPlace(`function:${name}:${index}`, body));
  };

  /** 検索するすべての場所。 */
  const searchedPlaces = async (): Promise<readonly SearchedPlace[]> => [
    ...filesUnder(rootOf(), 'root', SKIPPED_DIRECTORY_NAMES),
    databaseRowsPlace(databasePath(), 'database:rows').place,
    textPlace('server:output', started().output()),
    ...childProcessRecordsOf(`${recordDirectory()}/${SERVER_CHILD_PROCESS_RECORD}`, 'server-process').places,
    ...childProcessRecordsOf(`${recordDirectory()}/${WORKER_CHILD_PROCESS_RECORD}`, 'worker-process').places,
    ...await screenPlaces(),
    ...await functionPlaces(),
  ];

  /** 秘密の目印がどこにもないことを確かめ、検索した場所を返す（漏れた場所の名前と文字の形だけを出す）。 */
  const expectNoSecretMarker = async (label: string): Promise<readonly SearchedPlace[]> => {
    const places = await searchedPlaces();
    console.info(`[CCX-16] ${options.label} searched places (${label}): ${places.length}; without the function responses: ${places.filter(({ place }) => !place.startsWith('function:')).length}`);
    expect(leakedPlaces(places, options.secretMarkers()), `${label}: secret markers`).toEqual([]);
    expect(leakedPlaces(places.filter(({ place }) => options.isScreenSecretPlace(place)), screenSecrets()), `${label}: the screen cookie and token`)
      .toEqual([]);
    // 検索した場所に、管理データのファイルと WAL と SHM、IPC の記録（両方向）、決まった範囲の画面と応答が入っている。
    const names = places.map(({ place }) => place);
    const localData = `root:${CONTROL_DATA_DIRECTORY_NAME}/`;
    expect(names.some((name) => name.startsWith(localData) && name.endsWith('-wal')), label).toBe(true);
    expect(names.some((name) => name.startsWith(localData) && name.endsWith('-shm')), label).toBe(true);
    expect(names).toContain(`root:${recordDirectoryName}/${WORKER_RECORD_FILES.ipc}`);
    expect(names).toContain(`root:${recordDirectoryName}/${WORKER_PARENT_MESSAGE_RECORD}`);
    expect(names.filter((name) => options.isScreenSecretPlace(name)).length, label).toBeGreaterThan(0);
    return places;
  };

  /** IPC の記録のファイル（記録のフォルダの中の名前）の、メッセージの `type` の並び。 */
  const recordedMessageTypesOf = (places: readonly SearchedPlace[], fileName: string): readonly string[] =>
    Buffer.from(places.find((entry) => entry.place === `root:${recordDirectoryName}/${fileName}`)?.bytes ?? new Uint8Array())
      .toString('utf8').split('\n').filter((line) => line.length > 0).map((line) => String((JSON.parse(line) as Record<string, unknown>)['type']));

  return {
    start,
    stop,
    closePages,
    // T32h: 記録を付けたとき（`recordPages`）の、開いたページの記録の確かめ。
    expectCleanPages,
    // UI-6: Tab だけのフォーカスの移動（`maxTabPresses` を渡したとき）と、画面のサーバの子孫の記録と、画面の Cookie と token。
    tabTo,
    recordDescendants,
    screenSecrets,
    rootOf,
    started,
    relayOf,
    recordDirectory,
    recordDirectoryName,
    databasePath,
    nowTimestamp,
    jobs,
    windows,
    openPage,
    snapshot,
    callFunction,
    valueOf,
    withControlData,
    waitForJobEnd,
    runDiscoveryFrom,
    saveLookupDefinition,
    setWriteScreenCheckOnList,
    prepareProfile,
    registerCredentialOnPage,
    searchedPlaces,
    expectNoSecretMarker,
    recordedMessageTypesOf,
  };
};

export type ScenarioMarkerFlow = ReturnType<typeof createScenarioMarkerFlow>;

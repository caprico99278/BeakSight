/**
 * 操作さがし・READ の確かめ・書き込みの承認の目印の検査（端から端まで。T27g と T28f を 1 つにした。UI-6。設計書
 * `2026-11-14-beaksight-slim-and-simplify-design.md` 5.4）。ビルドした画面を一時の root の起動の部品で起動し（`helpers/scenario-marker-flow.ts` の作り）、
 * 書き込みのモード（`TEST_APPROVED_WRITE`）のプロファイルで、手動のログインと自動のログインのそれぞれについて、画面から「操作の候補を探す」（`DISCOVERY`）→
 * READ の確かめの定義の作成 → 「READ を確かめる」（`READ_CHECK`）→ サイトの画面の「登録・更新を試せる画面」の一覧で登録の画面にチェックを入れる（書き込みの
 * 手順の下書きと承認）→ チェックを外す（撤回）を行う（UI-6: 前は 2 つのファイルで発見を 4 回流していた。同じ fixture・同じ補助なので、発見を 2 回にした）。
 * - T27g（Task 27 の設計書 4.8、6 章、8 章）: 秘密の目印（fixture のサイト `tests/helpers/discovery-site-fixture.ts` の `secretValues()`: セッションの Cookie、
 *   localStorage、資格情報、CSRF のトークン、hidden の値、入力の欄の今の値、選択肢の label、表の行の中身。表の行の中身は、注文の一覧の各行のボタンの文字・
 *   `aria-label`・`title`（T27R の I2。DEF-086）と、form の中の送信ボタンの `value`、画像の送信ボタンの `alt`、`<label>`、`aria-labelledby`・
 *   `aria-describedby` の指す要素の文字（T27R2 の I3。fixture の `markerShapes` の画面）にも置く。加えて、秘密に見える名前の欄に入れて拒まれた送る値）が、
 *   検索するすべての場所に、UTF-8 でも UTF-16LE でも出ない。READ の送る値は、定義の画面（HTML と `readCheckPageFn` の応答）・管理データ・
 *   `read-evidence.json`・ワーカーが親から受けた `START` にだけ出る。サイトへの要求（ジョブごとの窓）は、GET と HEAD と仮のサイトの beacon のほかは、
 *   ログインの POST の 1 回だけ。読まないパス・危険な語・範囲の外へは 0 件。READ の URL の query は、定義の欄の名前だけ。DEF-300: 検索の確かめ（RCA）の
 *   GET のフォームの組も読む（読んだ組の数だけ query のある読み込みが増え、その query の名前は組が変えた欄の名前で、秘密に見える名前はない）。
 * - T28f（Task 28 の設計書 4.7、6 章、8 章）: 一覧でチェックを入れる・外す（承認と撤回。SPEC-4）の間、サイトへの要求は 0 件（書き込みの要求 0）。画面の
 *   Cookie と token は、シナリオの画面の HTML と、シナリオと一覧の Server Function の応答に出ない。撤回で実行の許可が無効になり、予約が返り、次の発行が
 *   拒まれる。T31h-1・OP-2: チェックの保存は、登録の台帳に結ぶ更新（UPDATE）の下書きも作って承認する（UPDATE のシナリオの詳細の画面と応答も検索する）。
 * - 検索する場所: 一時の root のすべてのファイル（`node_modules` の junction は除く）、管理データのすべての表のすべての行、画面のサーバの標準出力と標準
 *   エラー、ワーカーの標準出力と標準エラー、IPC の記録（両方向）、子プロセスの起動の記録、すべての画面の HTML（サーバで描いたもの・ブラウザで開いたもの・
 *   成果物の画面。サイトの画面の一覧、シナリオの一覧・詳細、監査済みデータの台帳を含む）、Server Function の応答。
 * - 対照: (1) Run のディレクトリと同じ形の一時のフォルダに置いた目印が見つかる、(2) fixture の目印の形の画面の目印が見つかる、(3) 最後の検索で、この一時の
 *   root にわざと置いた目印（UTF-16LE）だけが見つかり（UI-6: わざと置く目印を最後の検索に入れ、検索を 1 回減らした）、READ の送る値が出てよい場所で
 *   見つかり、秘密でない値（シナリオの id、承認の digest、実行の許可の id、一覧の行の鍵）が管理データの表の行とシナリオの画面で見つかる。
 * - 場面: (1) 手動のログイン（どの OS でも。人の操作の代わりに、テストだけの入口が受け渡しのサーバの資格情報を入れる）、(2) 自動ログイン（Windows
 *   だけ。本物の DPAPI。資格情報は画面で登録する。資格情報マネージャーは使わない）。
 * fixture のサイトは 127.0.0.1 だけ。Chromium は headless だけ。目印の値は実行ごとのランダムな値で、出力しない（漏れた場所の名前と、文字の形だけを出す）。
 * TEST-TIME-A: 読み込みの間隔は 0（流れの既定）。間隔を守ることは `tests/integration/navigation-pacing.test.ts` と navigation-pacer の場面で確かめる。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MAX_CREATES_PER_RUN, updateLedgerScenarioIdOf } from '../../../src/control/approval/scenario-contracts.js';
import {
  issueExecutionGrant,
  listScenarios,
  readApprovalReceipts,
  readExecutionGrant,
  readScenario,
  type ExecutionGrantResult,
} from '../../../src/control/approval/scenario-store.js';
import { AUTO_LOGIN_MIN_INTERVAL_MS } from '../../../src/control/job/auto-login-limits.js';
import type { ControlDatabase } from '../../../src/control/store/control-database.js';
import { CONTROL_DATA_DIRECTORY_NAME } from '../../../src/control/store/database-path.js';
import { isSecretUrlQueryParameterName } from '../../../src/core/secret-query-names.js';
import { DISCOVERY_ARTIFACT_FILE_NAME, READ_EVIDENCE_ARTIFACT_FILE_NAME } from '../../../src/core/artifact-layout.js';
import { READ_CHECK_EXPECTATION_KIND_CATALOG } from '../../../src/presentation/catalog.js';
import { LOCAL_UI_READ_CHECK_TEXT } from '../../../src/presentation/messages.js';
import { openWalControlDatabase, shiftAutoLoginAttemptsBack } from '../../../tests/helpers/control-data-test-writes.js';
import {
  DISCOVERY_SITE_EXTRA_PATHS,
  DISCOVERY_SITE_FORBIDDEN_PATHS,
  DISCOVERY_SITE_PATHS,
  DISCOVERY_SITE_READ_CHECK_PATHS,
  DISCOVERY_SITE_READ_PAGES,
  DISCOVERY_SITE_SESSION_COOKIE,
  startDiscoverySite,
  type DiscoverySite,
  type DiscoverySiteRequest,
} from '../../../tests/helpers/discovery-site-fixture.js';
import { READ_METHODS } from '../../../tests/helpers/leak-places.js';
import { WORKER_PARENT_MESSAGE_RECORD, WORKER_RECORD_FILES } from './helpers/auth-worker.ts';
import {
  FIRST_REVISION,
  JOB_TIMEOUT_MS,
  LOGIN_POSTS_PER_JOB,
  STATUS,
  UI_TIMEOUT_MS,
  createScenarioMarkerFlow,
  credentialsOf,
  loginPosts,
  nonReadRequestsBesidesBeaconOf,
  placeNameOf,
  type JobDetail,
} from './helpers/scenario-marker-flow.ts';
import { databaseRowsPlace, filesUnder, leakedPlaces, textPlace, type SearchedPlace } from './helpers/secret-markers.ts';

const IS_WINDOWS = process.platform === 'win32';
const AUTOMATED_SKIP_REASON = 'the automated login saves the credential with the real DPAPI, which exists only on Windows';

/** 1 つの場面の上限（ms）。 */
const SCENARIO_TIMEOUT_MS = 900_000;
/** 一時の root の検索で読まないフォルダ（リポジトリの `node_modules` への junction）。 */
const SKIPPED_DIRECTORY_NAMES = Object.freeze(['node_modules']);
/** ログインの段の着地（管理画面の HTML の 1 つ目）は、発見と READ の読み込みに数えない。 */
const LOGIN_LANDING_DOCUMENTS = 1;

/** テストの名前（記録のフォルダ `t27g-records`、前処理のファイル、環境の証跡の参照。匿名の値）。 */
const FLOW_LABEL = 't27g';
/** テストの値（匿名）。 */
const MANUAL_PROFILE = 't27g-manual';
const AUTO_PROFILE = 't27g-auto';
const PROFILE_IDS = Object.freeze([MANUAL_PROFILE, AUTO_PROFILE]);

/** 実行ごとの目印（値を出力しない。`[a-z0-9-]` だけなので、URL・JSON・HTML のどの書き方でも形が変わらない）。 */
const markerOf = (name: string): string => `t27g-${name}-${randomUUID()}`;
/** READ の送る値（テスト用の値。定義の画面・管理データ・`read-evidence.json`・`START` にだけ出てよい）。 */
const SEND_VALUE_MANUAL = markerOf('send-manual');
const SEND_VALUE_AUTO = markerOf('send-auto');
/** 秘密に見える名前の欄に入れて拒まれる送る値（保存されないので、どこにも出ない）。 */
const REJECTED_VALUE_MANUAL = markerOf('rejected-manual');
const REJECTED_VALUE_AUTO = markerOf('rejected-auto');
/** 照会の定義の送る値と期待（fixture の注文の 1 行目。秘密ではない）。 */
const LOOKUP_ID = 'A-1';
const DETAIL_FIELD = '名前';
const DETAIL_VALUE = 'りんご';
/** 送る値の目印で検索した注文の一覧の行の数（どの名前にも当たらない）。 */
const NO_ROWS = 0;
/** 保存する定義の数（送る値の目印の検索と、照会）。 */
const SAVED_DEFINITIONS = 2;
/** 1 つの場面のジョブの数（発見と READ の確かめ。ジョブごとにログインする。チェックを入れる・外すはジョブを始めない）。 */
const JOBS_PER_SCENARIO = 2;
/** T27R2 の I3: fixture の `markerShapes` の画面の form の数（送信ボタンの `value`、画像の送信ボタンの `alt`、ARIA の参照）。 */
const MARKER_SHAPE_FORMS = 3;
/** 実行の許可で予約する件数（1 回の Run の既定の上限）。 */
const GRANT_COUNT = DEFAULT_MAX_CREATES_PER_RUN;

const readText = LOCAL_UI_READ_CHECK_TEXT;

// ---------------------------------------------------------------------------------------------------------------
// 対照（どの OS でも。端から端の前に）
// ---------------------------------------------------------------------------------------------------------------

describe('T27g: the marker search finds markers placed on purpose in the shape of the discovery and READ check artifacts (the control)', () => {
  it('finds a marker in discovery.json, read-evidence.json, a compressed ZIP entry, the WAL, the table rows and a UTF-16LE IPC record', () => {
    const directory = mkdtempSync(join(tmpdir(), 'beaksight-t27g-control-'));
    const control = markerOf('control');
    let database: { readonly close: () => void } | undefined;
    try {
      const run = join(directory, 'output', 'run-1');
      mkdirSync(run, { recursive: true });
      mkdirSync(join(directory, CONTROL_DATA_DIRECTORY_NAME), { recursive: true });
      database = openWalControlDatabase(join(directory, CONTROL_DATA_DIRECTORY_NAME, 'control.sqlite'), control);
      writeFileSync(join(run, DISCOVERY_ARTIFACT_FILE_NAME), JSON.stringify({ pages: [{ candidates: [{ fields: [{ name: control }] }] }] }), 'utf8');
      writeFileSync(join(run, READ_EVIDENCE_ARTIFACT_FILE_NAME), JSON.stringify({ checks: [{ url: `http://127.0.0.1/admin/orders?q=${control}` }] }), 'utf8');
      writeFileSync(join(run, 'bundle.zip'), zipSync({ 'inner/read-evidence.json': strToU8(JSON.stringify({ values: [control, control] })) }));
      mkdirSync(join(directory, 'records'));
      writeFileSync(join(directory, 'records', WORKER_RECORD_FILES.ipc), Buffer.from(`{"type":"FINISHED","value":"${control}"}`, 'utf16le'));
      writeFileSync(join(run, 'clean.json'), '{}', 'utf8');

      const places = filesUnder(directory, 'control', SKIPPED_DIRECTORY_NAMES);
      const rows = databaseRowsPlace(join(directory, CONTROL_DATA_DIRECTORY_NAME, 'control.sqlite'), 'control-rows');
      const leaked = leakedPlaces([...places, rows.place], [control]);
      expect(leaked).toEqual(expect.arrayContaining([
        `control:output/run-1/${DISCOVERY_ARTIFACT_FILE_NAME} (utf8)`,
        `control:output/run-1/${READ_EVIDENCE_ARTIFACT_FILE_NAME} (utf8)`,
        'control:output/run-1/bundle.zip!inner/read-evidence.json (utf8)',
        `control:${CONTROL_DATA_DIRECTORY_NAME}/control.sqlite-wal (utf8)`,
        'control-rows (utf8)',
        `control:records/${WORKER_RECORD_FILES.ipc} (utf16le)`,
      ]));
      expect(leaked.filter((place) => place.includes('clean.json'))).toEqual([]);
      expect(leakedPlaces(places, [markerOf('absent')])).toEqual([]);
    } finally {
      database?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('finds the row markers that the fixture places in the button and label shapes (T27R2 I3), in UTF-8 and UTF-16LE', async () => {
    // 端から端の fixture のサーバとは別のサーバ（端から端のサーバへの要求の数を変えない）。
    const site = await startDiscoverySite({ markerShapes: true });
    const directory = mkdtempSync(join(tmpdir(), 'beaksight-t27r2-shapes-'));
    try {
      const response = await fetch(`${site.origin}${DISCOVERY_SITE_EXTRA_PATHS.markerShapes}`, {
        headers: { cookie: `${DISCOVERY_SITE_SESSION_COOKIE}=${site.issueSession()}` },
      });
      expect(response.status).toBe(STATUS.OK);
      const html = await response.text();
      // 管理画面に共通の localStorage の script（別の目印）を除き、画面の form の部分だけにする。
      const markup = html.slice(0, html.indexOf('<script>'));
      // 誤りの文に HTML（目印）を載せないため、数で比べる。
      expect(markup.split('<form').length - 1, 'the forms of the shapes').toBe(MARKER_SHAPE_FORMS);
      writeFileSync(join(directory, 'shapes.html'), Buffer.from(markup, 'utf16le'));
      const places = [textPlace('control:marker-shapes', markup), ...filesUnder(directory, 'control', SKIPPED_DIRECTORY_NAMES)];
      expect(leakedPlaces(places, site.secretValues())).toEqual(['control:marker-shapes (utf8)', 'control:shapes.html (utf16le)']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await site.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 端から端
// ---------------------------------------------------------------------------------------------------------------

let manualSite: DiscoverySite | undefined;
let autoSite: DiscoverySite | undefined;
/** 始めたジョブ（ID と種類とプロファイル）。 */
const jobs: { readonly jobId: string; readonly kind: 'DISCOVERY' | 'READ_CHECK'; readonly profileId: string }[] = [];
/** ジョブごとのサイトへの要求の窓。 */
interface JobWindow {
  readonly label: string;
  readonly kind: 'DISCOVERY' | 'READ_CHECK';
  readonly site: DiscoverySite;
  readonly from: number;
  readonly to: number;
  /** READ の確かめの定義の送る値の名前（READ の確かめのジョブだけ）。 */
  readonly parameterNames: readonly string[];
}
const windows: JobWindow[] = [];
/** 作った定義の ID（プロファイルごと）。 */
const definitionIds = new Map<string, string[]>();
/** プロファイルごとの、チェックの保存が作ったもの（一覧の行の鍵、シナリオ、実行の許可、承認の digest）。 */
interface SceneRecord {
  readonly rowKey: string;
  readonly scenarioId: string;
  readonly grantId: string;
  readonly approvalDigest: string;
  /** T31h-1・OP-2: チェックの保存が規則 F で作った、登録の台帳に結ぶ更新（UPDATE）のシナリオ。 */
  readonly updateScenarioId: string;
}
const sceneRecords = new Map<string, SceneRecord>();
/** DEF-300: READ の確かめのジョブ（窓の名前）ごとの、読んだ検索の確かめの GET のフォームの組の、変えた欄の名前（基準の組は null）。 */
const formSearchChecks = new Map<string, readonly (string | null)[]>();

/** DEF-300: 検索の確かめの組の結果のうち、ここで読む所（成果物 `read-evidence.json` の `searchChecks`）。 */
interface SearchCheckRow {
  readonly trigger: string;
  readonly state: string;
  readonly detail?: string;
  readonly how: { readonly kind: string; readonly field?: string };
}

/** DEF-300: ジョブの `read-evidence.json` の、読んだ（守りが止めていない）GET のフォームの組の、変えた欄の名前。 */
const formSearchChecksOf = (jobId: string): readonly (string | null)[] => {
  const root = flow.rootOf();
  const document = (readdirSync(root, { recursive: true }) as string[])
    .filter((name) => name.endsWith(READ_EVIDENCE_ARTIFACT_FILE_NAME))
    .map((name) => JSON.parse(readFileSync(join(root, name), 'utf8')) as { readonly jobId: string; readonly searchChecks: readonly SearchCheckRow[] })
    .find((evidence) => evidence.jobId === jobId);
  expect(document, jobId).toBeDefined();
  return (document?.searchChecks ?? [])
    .filter(({ trigger, state, detail }) => trigger === 'FORM' && state === 'EXECUTED' && detail !== 'BLOCKED_BY_BEAKSIGHT')
    .map(({ how }) => how.field ?? null);
};

const siteOf = (site: DiscoverySite | undefined): DiscoverySite => {
  if (site === undefined) {
    throw new Error('fixture のサイトが起動していない');
  }
  return site;
};

/** 秘密の目印（どこにも出てはならない）。 */
const secretMarkers = (): readonly string[] => [
  ...siteOf(manualSite).secretValues(),
  ...(autoSite?.secretValues() ?? []),
  REJECTED_VALUE_MANUAL,
  REJECTED_VALUE_AUTO,
];
/** READ の送る値（出てよい場所が決まっている）。 */
const SEND_VALUES = Object.freeze([SEND_VALUE_MANUAL, SEND_VALUE_AUTO]);

/** シナリオの画面のパス（一覧・詳細）。 */
const scenarioPathsOf = (profileId: string): readonly string[] => {
  const record = sceneRecords.get(profileId);
  return [
    `/scenarios/${profileId}`,
    ...(record === undefined ? [] : [`/scenarios/${profileId}/${record.scenarioId}`, `/scenarios/${profileId}/${record.updateScenarioId}`]),
  ];
};

/** シナリオの画面の HTML と、シナリオと一覧のチェックの Server Function の応答か（画面の Cookie と token を探す範囲。T28e と同じ）。 */
const isScenarioScreenPlace = (place: string): boolean =>
  /^(?:html:|browser-html:\d+:)\/scenarios\//u.test(place) || /^function:(?:scenario[A-Za-z]+|writeScreens|saveWriteScreenCheck)Fn:/u.test(place);

/**
 * 画面の端から端の目印の検査の流れ（CCX-16）。検索する画面は、プロファイルごとの画面（開始の画面を含む）、READ の確かめの定義を作る画面と定義の画面、
 * シナリオの一覧と詳細、監査済みデータの台帳（T32g）。いま読む Server Function は、プロファイルごとの画面の関数と、台帳とサイトの画面の一覧の値と、
 * シナリオの詳細の値。
 */
const flow = createScenarioMarkerFlow({
  label: FLOW_LABEL,
  profileIds: () => PROFILE_IDS,
  secretMarkers,
  extraScreenPaths: () => PROFILE_IDS.flatMap((profileId) => [
    `/read-checks/${profileId}/new`,
    ...(definitionIds.get(profileId) ?? []).map((id) => `/read-checks/${profileId}/${id}`),
    ...scenarioPathsOf(profileId),
    `/ledger/${profileId}`,
  ]),
  extraFunctionCalls: () => PROFILE_IDS.flatMap((profileId) => {
    const record = sceneRecords.get(profileId);
    const always = [['auditedDataLedgerPageFn', { profileId }] as const, ['writeScreensFn', { profileId }] as const];
    return record === undefined ? always : [
      ...always,
      ['scenarioDetailPageFn', { scenarioId: record.scenarioId }] as const,
      ['scenarioDetailPageFn', { scenarioId: record.updateScenarioId }] as const,
    ];
  }),
  isScreenSecretPlace: isScenarioScreenPlace,
  profileScreenPrefixes: ['/profiles/', '/auth-setup/', '/credentials/', '/login-check/', '/start/', '/discovery/', '/read-checks/'],
  profileFunctions: ['getProfileFn', 'getAuthSetupFn', 'getCredentialPageFn', 'auditStartSummaryFn', 'discoveryPageFn', 'readCheckPageFn', 'scenarioListPageFn'],
});
const { openPage, snapshot, databasePath, recordDirectory, waitForJobEnd, prepareProfile, registerCredentialOnPage, searchedPlaces } = flow;
/** 記録のフォルダの名前（一時の root の中。`t27g-records`）。 */
const RECORD_DIRECTORY_NAME = flow.recordDirectoryName;

/** 開始のボタンを押し、ジョブの画面に移るのを待って、終わるまで待つ。ジョブの画面の HTML を集め、サイトへの要求の窓を記録する。 */
const runJobFrom = async (
  path: string,
  startTestId: string,
  kind: 'DISCOVERY' | 'READ_CHECK',
  profileId: string,
  site: DiscoverySite,
  parameterNames: readonly string[] = [],
): Promise<JobDetail> => {
  const page = await openPage(path);
  const from = site.requests.length;
  await page.getByTestId(startTestId).click();
  await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
  const jobId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  jobs.push({ jobId, kind, profileId });
  flow.jobs.push({ jobId, profileId });
  const job = await waitForJobEnd(jobId);
  await page.locator('[data-testid="job-state"]:not([data-state="STARTING"]):not([data-state="RUNNING"]):not([data-state="STOPPING"])')
    .waitFor({ timeout: JOB_TIMEOUT_MS });
  await snapshot(page);
  windows.push({ label: `${profileId} ${kind}`, kind, site, from, to: site.requests.length, parameterNames });
  return job;
};

/** 候補の画面で、ある画面の READ の候補の識別の digest を読む（候補の画面の HTML を集める）。 */
const readDigestOf = async (profileId: string, path: string): Promise<string> => {
  const page = await openPage(`/discovery/${profileId}`);
  await snapshot(page);
  const digest = await page.locator(`[data-testid="discovery-page"][data-page-path="${path}"] [data-testid="discovery-candidate"][data-classification="READ"]`)
    .first().getAttribute('data-digest');
  expect(digest, path).not.toBeNull();
  return digest ?? '';
};

/**
 * 定義を作る画面で、送る値と期待を入れて保存する。保存できたら定義の一覧の画面に移るので、その HTML を集める。拒まれたら理由を返す（値を入れたままの
 * 画面の HTML は集めない）。
 */
const saveDefinition = async (
  profileId: string,
  path: string,
  parameters: Readonly<Record<string, string>>,
  expectation: { readonly kindLabel: string; readonly values: Readonly<Record<string, string>> },
): Promise<string | null> => {
  const digest = await readDigestOf(profileId, path);
  const page = await openPage(`/read-checks/${profileId}/new?candidate=${encodeURIComponent(digest)}`);
  await page.getByTestId('read-check-form').waitFor({ timeout: UI_TIMEOUT_MS });
  for (const [name, value] of Object.entries(parameters)) {
    await page.getByTestId('read-check-parameters').getByLabel(name, { exact: true }).fill(value);
  }
  const row = page.locator('[data-testid="read-check-expectation"][data-index="0"]');
  await row.getByLabel(readText.expectationKind, { exact: true }).selectOption({ label: expectation.kindLabel });
  for (const [label, value] of Object.entries(expectation.values)) {
    await row.getByLabel(label, { exact: true }).fill(value);
  }
  await page.getByTestId('read-check-save').click();
  const saved = page.waitForURL(new RegExp(`/read-checks/${profileId}\\?notice=saved$`, 'u'), { timeout: UI_TIMEOUT_MS }).then(() => null);
  const rejected = page.getByTestId('read-check-rejection').waitFor({ timeout: UI_TIMEOUT_MS })
    .then(async () => page.getByTestId('read-check-rejection').getAttribute('data-reason'));
  const reason = await Promise.race([saved, rejected]);
  if (reason === null) {
    await page.getByTestId('read-check-definition').first().waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    await snapshot(page);
    const all = await page.getByTestId('read-check-definition').evaluateAll((rows) => rows.map((element) => element.getAttribute('data-read-check-id') ?? ''));
    definitionIds.set(profileId, all);
  }
  return reason;
};

/** T27R2 の I3: 候補の画面に、目印の形の画面の form がすべて候補として出ている（発見がその画面を読み、probe が form を読んだ）。 */
const expectMarkerShapeCandidates = async (profileId: string): Promise<void> => {
  const page = await openPage(`/discovery/${profileId}`);
  await snapshot(page);
  const candidates = page.locator(
    `[data-testid="discovery-page"][data-page-path="${DISCOVERY_SITE_EXTRA_PATHS.markerShapes}"] [data-testid="discovery-candidate"]`,
  );
  expect(await candidates.count(), `${profileId}: the candidates of the marker shapes`).toBe(MARKER_SHAPE_FORMS);
};

/** READ の確かめの定義を 2 つ作り（送る値の目印の検索と、照会）、秘密に見える名前の欄の定義が拒まれることを確かめる。 */
const createDefinitions = async (profileId: string, sendValue: string, rejectedValue: string): Promise<void> => {
  const r = DISCOVERY_SITE_READ_CHECK_PATHS;
  expect(await saveDefinition(profileId, r.secretSearch, { api_key: rejectedValue, q: sendValue }, {
    kindLabel: READ_CHECK_EXPECTATION_KIND_CATALOG.ROW_COUNT_AT_LEAST.label,
    values: { [readText.expectationCount]: String(NO_ROWS) },
  })).toBe('READ_PARAMETER_SECRET_LIKE');
  expect(await saveDefinition(profileId, r.orders, { q: sendValue }, {
    kindLabel: READ_CHECK_EXPECTATION_KIND_CATALOG.ROW_COUNT_EQUALS.label,
    values: { [readText.expectationCount]: String(NO_ROWS) },
  })).toBeNull();
  expect(await saveDefinition(profileId, r.lookup, { id: LOOKUP_ID }, {
    kindLabel: READ_CHECK_EXPECTATION_KIND_CATALOG.DETAIL_FIELD_EQUALS.label,
    values: { [readText.expectationField]: DETAIL_FIELD, [readText.expectationValue]: DETAIL_VALUE },
  })).toBeNull();
  expect(definitionIds.get(profileId)).toHaveLength(SAVED_DEFINITIONS);
};

/** 定義の画面で、最後の READ の確かめのジョブの結果（定義ごとの結果）を読む（HTML を集める）。 */
const readCheckResultsOf = async (profileId: string, jobId: string): Promise<readonly string[]> => {
  const page = await openPage(`/read-checks/${profileId}`);
  const results = page.locator(`[data-testid="read-check-result"][data-job-id="${jobId}"]`);
  await results.first().waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
  await snapshot(page);
  return (await results.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-result') ?? ''))).sort();
};

/** 最後の承認の記録（なければ誤り）。 */
const lastApprovalOf = (database: ControlDatabase, scenarioId: string) => {
  const approval = readApprovalReceipts(database, scenarioId).findLast((receipt) => receipt.kind === 'APPROVAL');
  if (approval?.kind !== 'APPROVAL') {
    throw new Error('承認の記録がない');
  }
  return approval;
};

/** テストだけの操作: 最後の承認の記録が縛った事実で、実行の許可を出す（書き込みのジョブはまだないので、ジョブの ID は仮の値）。 */
const issueGrant = (scenarioId: string, grantId: string): ExecutionGrantResult => flow.withControlData((database) => {
  const { authSetupDigest, targetConfigDigest } = lastApprovalOf(database, scenarioId).bound;
  return issueExecutionGrant(database, {
    scenarioId,
    expectedRevision: readScenario(database, scenarioId)?.revision ?? FIRST_REVISION,
    grantId,
    jobId: `${grantId}-job`,
    count: GRANT_COUNT,
    external: { authSetupDigest, targetConfigDigest },
    at: flow.nowTimestamp(),
  });
});

/**
 * T28f: 一覧で登録の画面にチェックを入れる（下書きと承認）→（テストだけ）実行の許可 → チェックを外す（撤回）。撤回で許可が無効になり、予約が返り、次の発行が
 * 拒まれることと、この間にサイトへの要求がないこと（書き込みの要求 0）を確かめる。
 */
const checkAndUncheckOnList = async (profileId: string, site: DiscoverySite): Promise<void> => {
  const before = site.requests.length;
  const rowKey = await flow.setWriteScreenCheckOnList(profileId, true);
  // チェックの保存が作った登録と、その台帳に結ぶ更新の書き込みの手順（どちらも承認した。副作用の確認はチェックが兼ねる）。
  const { scenarioId, updateScenarioId } = flow.withControlData((database) => {
    const scenarios = listScenarios(database, profileId);
    const create = scenarios.find(({ current }) => current.kind === 'CREATE' && current.candidate.identityDigest === rowKey);
    const update = scenarios.find(({ current }) => current.kind === 'UPDATE' && updateLedgerScenarioIdOf(current) === create?.scenarioId);
    expect(create?.state).toBe('APPROVED');
    expect(update?.state).toBe('APPROVED');
    expect(Object.values(create?.current.sideEffectConfirmations ?? {})).toEqual([true, true, true, true]);
    return { scenarioId: create?.scenarioId ?? '', updateScenarioId: update?.scenarioId ?? '' };
  });
  const grantId = `t28f-grant-${profileId}`;
  const issued = issueGrant(scenarioId, grantId);
  const approvedRevision = flow.withControlData((database) => lastApprovalOf(database, scenarioId).scenarioRevision);
  expect(issued.ok && issued.grant).toMatchObject({ scenarioRevision: approvedRevision, consumedAt: null, reservation: { state: 'RESERVED' } });
  const approvalDigest = flow.withControlData((database) => lastApprovalOf(database, scenarioId).approvalDigest);
  await flow.setWriteScreenCheckOnList(profileId, false);

  flow.withControlData((database) => {
    const grant = readExecutionGrant(database, grantId);
    expect(grant).toMatchObject({ consumedAt: null, reservation: { state: 'RELEASED' } });
    expect(grant?.invalidatedAt).not.toBeNull();
    expect(readApprovalReceipts(database, scenarioId).map(({ kind }) => kind)).toEqual(['APPROVAL', 'REVOCATION']);
    expect(readScenario(database, updateScenarioId)?.state).toBe('REVOKED');
  });
  const rejected = issueGrant(scenarioId, `${grantId}-after`);
  expect(rejected.ok ? null : [rejected.reason, rejected.invalidityReasons]).toEqual(['GRANT_APPROVAL_INVALID', ['REVOKED']]);
  sceneRecords.set(profileId, { rowKey, scenarioId, grantId, approvalDigest, updateScenarioId });
  // チェックを入れる・外す（と、テストだけの許可の発行）の間、サイトへの要求は 0 件。
  expect(site.requests.length, `${profileId}: requests while checking and unchecking`).toBe(before);
};

/**
 * READ の送る値が出てよい場所: 定義の画面（HTML と `readCheckPageFn` の応答）、管理データ（ファイルと表の行）、`read-evidence.json`（Run の
 * ディレクトリのファイルと、成果物の画面）、ワーカーが親から受けた `START` の記録（READ の確かめのジョブの定義の一覧。T27e の設計）。
 * T27R の M4: ワーカーから親への `AUTH_STATE` の `SESSION_LOST` も設計では出てよいが、この検査の場面はどれもセッションが切れないので、加えない。
 */
const isSendValueAllowedPlace = (place: string): boolean =>
  place.startsWith(`root:${CONTROL_DATA_DIRECTORY_NAME}/`)
  || place === 'database:rows'
  || (place.startsWith('root:') && place.endsWith(`/${READ_EVIDENCE_ARTIFACT_FILE_NAME}`))
  || (place.startsWith('html:/artifacts/') && place.endsWith(`/${READ_EVIDENCE_ARTIFACT_FILE_NAME}`))
  || place.startsWith('html:/read-checks/')
  || /^browser-html:\d+:\/read-checks\//u.test(place)
  || place.startsWith('function:readCheckPageFn:')
  || place === `root:${RECORD_DIRECTORY_NAME}/${WORKER_PARENT_MESSAGE_RECORD}`;

/** 目印の検索の結果。 */
interface MarkerSearch {
  readonly places: readonly SearchedPlace[];
  /** READ の送る値が出た場所（`<場所> (<文字の形>)`）。 */
  readonly sendValuePlaces: readonly string[];
}

/**
 * 検索するすべての場所で、秘密の目印が `expectedLeaks`（ふつうは空。最後の検索では、わざと置いた目印の場所）のほかになく、READ の送る値が出てよい場所に
 * だけあり、画面の Cookie と token がシナリオの画面と応答に出ないことを確かめる（漏れた場所の名前と文字の形だけを出す）。
 */
const expectNoMarkerOutsideAllowedPlaces = async (scenario: string, expectedLeaks: readonly string[] = []): Promise<MarkerSearch> => {
  const places = await searchedPlaces();
  console.info(`[CCX-16] t27g searched places (${scenario}): ${places.length}`);
  expect(leakedPlaces(places, secretMarkers()), `${scenario}: secret markers`).toEqual(expectedLeaks);
  const sendValuePlaces = leakedPlaces(places, SEND_VALUES);
  expect(sendValuePlaces.filter((place) => !isSendValueAllowedPlace(placeNameOf(place))), `${scenario}: READ values outside the allowed places`).toEqual([]);
  const screenPlaces = places.filter(({ place }) => isScenarioScreenPlace(place));
  expect(screenPlaces.length, scenario).toBeGreaterThan(0);
  expect(leakedPlaces(screenPlaces, flow.screenSecrets()), `${scenario}: the screen cookie and token`).toEqual([]);
  // 検索した場所に、管理データのファイルと WAL と SHM、IPC の記録（両方向）が入っている。
  const names = places.map(({ place }) => place);
  const localData = `root:${CONTROL_DATA_DIRECTORY_NAME}/`;
  expect(names.some((name) => name.startsWith(localData) && name.endsWith('-wal')), scenario).toBe(true);
  expect(names.some((name) => name.startsWith(localData) && name.endsWith('-shm')), scenario).toBe(true);
  expect(names).toContain(`root:${RECORD_DIRECTORY_NAME}/${WORKER_RECORD_FILES.ipc}`);
  expect(names).toContain(`root:${RECORD_DIRECTORY_NAME}/${WORKER_PARENT_MESSAGE_RECORD}`);
  return { places, sendValuePlaces };
};

/** 要求の path（query を除く）。 */
const pathnameOf = (request: DiscoverySiteRequest): string => request.path.split('?')[0] ?? request.path;

/** READ の確かめの画面のうち、巡回で読む画面（リンクでつながっているもの）と、T27R2 の I3 の目印の形の画面。 */
const readCheckPagePaths = (): readonly string[] => {
  const r = DISCOVERY_SITE_READ_CHECK_PATHS;
  return [r.orders, r.lookup, r.brokenSearch, r.shape, r.secretSearch, r.exitSearch, r.order, DISCOVERY_SITE_EXTRA_PATHS.markerShapes];
};

/** READ の確かめのジョブの定義の数（プロファイルの定義の数）。 */
const definitionCountOf = (window: JobWindow): number => (definitionIds.get(window.label.split(' ')[0] ?? '') ?? []).length;

/** ジョブの窓の、サイトへの要求を確かめる。 */
const expectSiteRequestsOf = (window: JobWindow): void => {
  const requests = window.site.requests.slice(window.from, window.to);
  // GET と HEAD と、仮のサイトが読み込みで自分で送る beacon の POST（DEF-257。本文に目印がない）のほかは、ログインの POST の 1 回だけ。
  expect(nonReadRequestsBesidesBeaconOf(requests, window.label), window.label).toEqual(loginPosts(LOGIN_POSTS_PER_JOB));
  // 読まないパス・危険な語・範囲の外へは 0 件。
  expect(requests.filter((request) => DISCOVERY_SITE_FORBIDDEN_PATHS.includes(pathnameOf(request))
    || pathnameOf(request).startsWith(DISCOVERY_SITE_READ_CHECK_PATHS.privateArea)).map(({ path }) => path), window.label).toEqual([]);
  // ログインの POST の後の、管理画面の HTML（BeakSight の読み込み）。ログインの段の着地を除く。
  const postIndex = requests.findIndex(({ method }) => !READ_METHODS.has(method));
  const afterLogin = requests.slice(postIndex + 1);
  const documents = afterLogin.filter(({ adminDocument }) => adminDocument).slice(LOGIN_LANDING_DOCUMENTS);
  expect(documents.length, window.label).toBeGreaterThan(1);
  if (window.kind === 'DISCOVERY') {
    // 発見の間の要求: 管理画面の HTML の読み込みのほかは、ページ自身の GET（SPA の画面の fetch）と、ページ自身の beacon（DEF-257。上で確かめた）だけ。
    expect([...new Set(afterLogin.filter(({ adminDocument }) => !adminDocument).map(pathnameOf))]
      .filter((path) => path !== DISCOVERY_SITE_PATHS.collect), window.label).toEqual([DISCOVERY_SITE_PATHS.api]);
    expect([...new Set(documents.map(pathnameOf))].sort(), window.label).toEqual([...DISCOVERY_SITE_READ_PAGES, ...readCheckPagePaths()].sort());
  } else {
    // READ の URL（query のある管理画面の読み込み）は、定義の数と、読んだ検索の確かめの GET のフォームの組の数（DEF-300。読まないパスへ送る組は始める前に
    // 除くので入らない）。query は、定義の欄の名前と、組が変えた欄の名前だけ（秘密に見える名前はない）。
    const formChecks = formSearchChecks.get(window.label) ?? [];
    const names = new Set([...window.parameterNames, ...formChecks.flatMap((field) => (field === null ? [] : [field]))]);
    const readUrls = documents.filter(({ path }) => path.includes('?')).map(({ path }) => new URL(path, window.site.origin));
    expect(readUrls.length, window.label).toBe(definitionCountOf(window) + formChecks.length);
    for (const url of readUrls) {
      expect([...url.searchParams.keys()].every((name) => names.has(name) && !isSecretUrlQueryParameterName(name)), `${window.label} ${url.pathname}`)
        .toBe(true);
    }
    // 検索の確かめで開いた画面自身の GET（SPA の画面の fetch）と beacon（DEF-257。上で確かめた）のほかに、管理画面の HTML でない要求はない。
    expect([...new Set(afterLogin.filter(({ adminDocument }) => !adminDocument).map(pathnameOf))]
      .filter((path) => path !== DISCOVERY_SITE_PATHS.collect && path !== DISCOVERY_SITE_PATHS.api), window.label).toEqual([]);
  }
};

/**
 * 1 つの場面: 発見 → 目印の形の候補 → 検索 → READ の定義 → READ の確かめ → 一覧でチェックを入れる・外す → 検索。`login` は、ジョブの前の手動のログインの
 * 資格情報の受け渡し（自動のログインは何もしない）。
 */
const runScene = async (
  profileId: string,
  site: DiscoverySite,
  automated: boolean,
  sendValue: string,
  rejectedValue: string,
  login: () => Promise<void>,
): Promise<void> => {
  const autoLogin = automated ? { result: 'SUCCEEDED', submitted: 'YES' } : null;
  await login();
  const discovery = await runJobFrom(`/discovery/${profileId}`, 'discovery-start', 'DISCOVERY', profileId, site);
  expect(discovery).toMatchObject({ jobKind: 'DISCOVERY', state: 'FINISHED', runStatus: 'COMPLETE', lastAuthState: 'AUTHENTICATED', autoLogin });
  await expectMarkerShapeCandidates(profileId);
  await expectNoMarkerOutsideAllowedPlaces(`${profileId} discovery`);

  await createDefinitions(profileId, sendValue, rejectedValue);
  if (automated) {
    // 自動ログインどうしの最小の間隔を待たずに次のジョブを始める（ジョブが動いていない間に、試し始めた時刻を前へずらす。テストだけの操作）。
    expect(shiftAutoLoginAttemptsBack(databasePath(), profileId, AUTO_LOGIN_MIN_INTERVAL_MS)).toBeGreaterThan(0);
  }
  await login();
  const readCheck = await runJobFrom(`/read-checks/${profileId}`, 'read-check-start', 'READ_CHECK', profileId, site, ['q', 'id']);
  expect(readCheck).toMatchObject({ jobKind: 'READ_CHECK', state: 'FINISHED', runStatus: 'COMPLETE', lastAuthState: 'AUTHENTICATED', autoLogin });
  formSearchChecks.set(`${profileId} READ_CHECK`, formSearchChecksOf(readCheck.jobId));
  expect(await readCheckResultsOf(profileId, readCheck.jobId)).toEqual(['MATCHED', 'MATCHED']);
  expect(site.successfulLogins).toBe(JOBS_PER_SCENARIO);

  await checkAndUncheckOnList(profileId, site);
  await expectNoMarkerOutsideAllowedPlaces(`${profileId} READ check and the check on the list`);
};

describe('T27g and T28f: no secret marker anywhere and no write request in the discovery, READ check and approval flows from the screens', () => {
  beforeAll(async () => {
    manualSite = await startDiscoverySite({ readCheckPages: true, markerShapes: true });
    autoSite = await startDiscoverySite({ readCheckPages: true, markerShapes: true });
    await flow.start();
    await prepareProfile(MANUAL_PROFILE, manualSite, false);
    if (IS_WINDOWS) {
      await prepareProfile(AUTO_PROFILE, autoSite, true);
    }
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await flow.closePages();
  });

  afterAll(async () => {
    await flow.stop();
    await manualSite?.close();
    await autoSite?.close();
  }, SCENARIO_TIMEOUT_MS);

  it('with the manual login: discovers, defines and runs READ checks, checks and unchecks the screen on the list, and no secret marker is anywhere', async () => {
    const site = siteOf(manualSite);
    await runScene(MANUAL_PROFILE, site, false, SEND_VALUE_MANUAL, REJECTED_VALUE_MANUAL, async () => {
      flow.relayOf().provide(await credentialsOf(site));
    });
  }, SCENARIO_TIMEOUT_MS);

  it.skipIf(!IS_WINDOWS)(`with the automated login: registers on the screen, discovers, defines and runs READ checks, checks and unchecks the screen on the list, and no secret marker is anywhere${IS_WINDOWS ? '' : ` [skipped: ${AUTOMATED_SKIP_REASON}]`}`, async () => {
    const site = siteOf(autoSite);
    const relayRequestsBefore = flow.relayOf().requested();
    await registerCredentialOnPage(AUTO_PROFILE, site);
    await runScene(AUTO_PROFILE, site, true, SEND_VALUE_AUTO, REJECTED_VALUE_AUTO, async () => undefined);
    // 自動ログインは、手動のログインの段（受け渡しのサーバ）を使わない。
    expect(flow.relayOf().requested()).toBe(relayRequestsBefore);
  }, SCENARIO_TIMEOUT_MS);

  it('sent only reads besides one login POST per job, with no request to the excluded paths and nothing outside the jobs (no write request)', () => {
    expect(windows.map(({ label }) => label)).toEqual([
      `${MANUAL_PROFILE} DISCOVERY`,
      `${MANUAL_PROFILE} READ_CHECK`,
      ...(IS_WINDOWS ? [`${AUTO_PROFILE} DISCOVERY`, `${AUTO_PROFILE} READ_CHECK`] : []),
    ]);
    for (const window of windows) {
      expectSiteRequestsOf(window);
    }
    // ジョブの外（定義の作成、チェックを入れる・外すの間など）には、サイトへの要求がない。
    for (const site of [siteOf(manualSite), siteOf(autoSite)]) {
      const siteWindows = windows.filter((window) => window.site === site);
      expect(site.requests.length).toBe(siteWindows.reduce((count, window) => count + (window.to - window.from), 0));
      expect(nonReadRequestsBesidesBeaconOf(site.requests)).toEqual(loginPosts(siteWindows.length * LOGIN_POSTS_PER_JOB));
    }
  });

  it('finds only the marker placed on purpose in the final search, the READ values and the non-secret values in their places, and records the IPC both ways', async () => {
    // 対照（この一時の root の中で）: わざと目印を置いたファイルは、同じ検索で見つかる（UTF-16LE）。ほかの場所に秘密の目印はない（UI-6: 最後の検索を兼ねる）。
    const plantedName = `t27g-planted-control-${randomUUID()}.txt`;
    const planted = `${recordDirectory()}/${plantedName}`;
    const [plantedMarker = ''] = siteOf(manualSite).secretValues();
    writeFileSync(planted, Buffer.from(`planted ${plantedMarker}`, 'utf16le'));
    let search: MarkerSearch;
    try {
      search = await expectNoMarkerOutsideAllowedPlaces('final', [`root:${RECORD_DIRECTORY_NAME}/${plantedName} (utf16le)`]);
    } finally {
      rmSync(planted, { force: true });
    }
    const { places } = search;
    // 対照: READ の送る値は、出てよい場所で見つかる（定義の画面、管理データの表の行、read-evidence.json、定義の画面の Server Function の応答）。
    const sendPlaces = search.sendValuePlaces.map(placeNameOf);
    expect(sendPlaces).toContain('database:rows');
    expect(sendPlaces).toContain(`html:/read-checks/${MANUAL_PROFILE}`);
    expect(sendPlaces.some((place) => place.startsWith('root:') && place.endsWith(`/${READ_EVIDENCE_ARTIFACT_FILE_NAME}`))).toBe(true);
    expect(sendPlaces.some((place) => place.startsWith('function:readCheckPageFn:'))).toBe(true);
    // Run のディレクトリの成果物（discovery.json と read-evidence.json）を検索した。
    const names = places.map(({ place }) => place);
    expect(names.filter((name) => name.endsWith(`/${DISCOVERY_ARTIFACT_FILE_NAME}`) && name.startsWith('root:')).length)
      .toBe(jobs.filter(({ kind }) => kind === 'DISCOVERY').length);
    expect(names.filter((name) => name.endsWith(`/${READ_EVIDENCE_ARTIFACT_FILE_NAME}`) && name.startsWith('root:')).length)
      .toBe(jobs.filter(({ kind }) => kind === 'READ_CHECK').length);
    // IPC の記録: 親から受けた `START`（ジョブの数）と、親へ送った `FINISHED`。
    expect(flow.recordedMessageTypesOf(places, WORKER_PARENT_MESSAGE_RECORD).filter((type) => type === 'START').length).toBe(jobs.length);
    expect(flow.recordedMessageTypesOf(places, WORKER_RECORD_FILES.ipc).filter((type) => type === 'FINISHED').length).toBe(jobs.length);
    // 管理データの表に行がある（発見・READ の確かめと、版 6 の 5 つの表と版 7 の 2 つの表。検索した行が空でない）。
    const rows = databaseRowsPlace(databasePath(), 'database:rows');
    for (const table of ['jobs', 'discovery_candidates', 'discovery_jobs', 'read_checks', 'read_check_results', 'scenarios', 'scenario_revisions',
      'approval_receipts', 'execution_grants', 'write_reservations', 'rule_sets', 'rule_set_revisions']) {
      expect(rows.rowCounts.get(table) ?? 0, table).toBeGreaterThan(0);
    }
    // 対照: 秘密でない値（シナリオの id、承認の digest、実行の許可の id）は、同じ検索で、管理データの表の行とシナリオの詳細の画面に見つかる。
    for (const profileId of IS_WINDOWS ? PROFILE_IDS : [MANUAL_PROFILE]) {
      const record = sceneRecords.get(profileId);
      if (record === undefined) {
        throw new Error(`${profileId}: the scene did not finish`);
      }
      const found = (value: string): readonly string[] => leakedPlaces(places, [value]).map(placeNameOf);
      const detail = `html:/scenarios/${profileId}/${record.scenarioId}`;
      expect(found(record.scenarioId)).toEqual(expect.arrayContaining(['database:rows', detail]));
      expect(found(record.approvalDigest)).toEqual(expect.arrayContaining(['database:rows', detail]));
      expect(found(record.grantId)).toContain('database:rows');
      // T31h-1: UPDATE のシナリオの id も、表の行と、その詳細の画面に見つかる（UPDATE の画面を確かに検索した）。
      expect(found(record.updateScenarioId)).toEqual(expect.arrayContaining(['database:rows', `html:/scenarios/${profileId}/${record.updateScenarioId}`]));
      // SPEC-4: 一覧のチェックの保存の応答と、一覧の値も検索した（行の鍵が見つかる）。
      expect(found(record.rowKey).some((place) => place.startsWith('function:writeScreensFn:'))).toBe(true);
    }
  }, SCENARIO_TIMEOUT_MS);
});

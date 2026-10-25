/**
 * 操作の候補の発見と READ の確かめの目印の検査（端から端まで。Task 27 の設計書 4.8、6 章、8 章。T27g）。T26f（`credential-secret-markers.test.ts`）の
 * 作りで、ビルドした画面を一時の root の起動の部品で起動し、手動のログインと自動のログインのそれぞれで、画面から「操作の候補を探す」（`DISCOVERY`）→
 * READ の確かめの定義の作成 → 「READ を確かめる」（`READ_CHECK`）を行って、次を確かめる。
 * - 秘密の目印（fixture のサイト `tests/helpers/discovery-site-fixture.ts` の `secretValues()`: セッションの Cookie、localStorage、資格情報、CSRF の
 *   トークン、hidden の値、入力の欄の今の値、選択肢の label、表の行の中身。加えて、秘密に見える名前の欄に入れて拒まれた送る値）が、検索するすべての
 *   場所に、UTF-8 でも UTF-16LE でも出ない。表の行の中身の目印は、注文の一覧の各行のボタンの文字・`aria-label`・`title` にも置く（T27R の I2。
 *   DEF-086: 候補はボタンの文言を持たず、分類の語だけを持つ。修正の前は `discovery.json`、候補の画面、Server Function の応答に出た）。
 *   T27R2 の I3: 行の目印を、form の中の送信ボタンの `value`、画像の送信ボタンの `alt`、`<label>`（`for` と包む形）、`aria-labelledby`・
 *   `aria-describedby` の指す要素の文字にも置く（fixture の `markerShapes` の画面。発見で読む画面に入れ、候補の画面に 3 つの form が出ることを
 *   確かめる）。目印がその画面の HTML にあって検索で見つかることは、別の fixture のサーバの同じ画面で確かめる（対照）。probe が読みうる所
 *   （main world の DOM）に目印があることは `tests/integration/discovery-marker-shapes.test.ts` が確かめる。
 * - READ の送る値（テスト用の値。目印の形にしたもの）は、設計どおり、定義の画面（HTML と `readCheckPageFn` の応答）と、管理データ（ファイルと表の行）と、
 *   `read-evidence.json`（URL。伏せ字の後）と、ワーカーが親から受けた `START`（READ の確かめのジョブの定義の一覧。T27e の設計）にだけ出る。
 *   それ以外の場所に出ない。出てよい場所で見つかること（対照）も確かめる。
 * - 検索する場所: 一時の root のすべてのファイル（Run のディレクトリの `discovery.json`・`read-evidence.json`、ZIP があれば中身、管理データのファイルと
 *   WAL と SHM、資格情報のフォルダ、記録のフォルダ。`node_modules` の junction は除く）、管理データのすべての表のすべての行、画面のサーバの標準出力と
 *   標準エラー、ワーカーの標準出力と標準エラー、IPC の記録（ワーカーが親へ送ったすべてのメッセージと、親から受けたすべてのメッセージ）、すべての画面の
 *   HTML（サーバで描いたものと、ブラウザで開いたもの）と成果物の画面、Server Function の応答（ブラウザが受けたものと、テストが呼んだもの）、子プロセスの
 *   起動の記録（画面のサーバとワーカー。PowerShell の `-EncodedCommand` は戻した本文も）。
 * - 対照: 検索の読み方は T26f の対照（`credential-secret-markers.test.ts`）が確かめる。この検査では、(1) 最初に、Run のディレクトリと同じ形の一時の
 *   フォルダ（`discovery.json`、`read-evidence.json`、ZIP の中、WAL、表の行、UTF-16LE）に置いた目印が見つかること、(2) 最後に、この一時の root の中に
 *   わざと置いた目印（UTF-16LE）が、同じ検索で見つかること、(3) READ の送る値が、出てよい場所で見つかること、を確かめる。
 * - サイトへの要求（手動と自動のそれぞれの fixture のサイト。ジョブごとの窓で）: GET と HEAD のほかは、ログインの POST の 1 回だけ。発見の窓の
 *   GET は、BeakSight の読み込み（管理画面の HTML）と、ページ自身の GET（SPA の画面の fetch）とログインの画面だけ。読まないパス・危険な語・範囲の外へは
 *   0 件。管理画面の読み込みの間隔は、設定の値以上（サーバに届いた時刻の、最初から最後までの長さで。T27d と同じ許容）。READ の URL の query は、
 *   定義の欄の名前だけ。
 * - 場面: (1) 手動のログイン（どの OS でも。人の操作の代わりに、テストだけの入口が受け渡しのサーバの資格情報を入れる）、(2) 自動ログイン（Windows
 *   だけ。本物の DPAPI。資格情報は画面で登録する。資格情報マネージャーは使わない）。
 * ワーカーは、一時の root の入口をテストだけの入口（`helpers/auth-worker.ts` の `installTestAuthWorkerEntry`。手動のログインの段の口だけを替え、
 * 自動ログインの段は本番のまま）に替えて動かす。fixture のサイトは 127.0.0.1 だけ。Chromium は headless だけ。目印の値は実行ごとのランダムな値で、
 * 出力しない（漏れた場所の名前と、文字の形だけを出す）。
 * CCX-16（CC-081）: 一時の root と画面のサーバの起動、プロファイルと認証の設定の作成、資格情報の画面での登録、ジョブの終わりの待ち、検索する
 * 場所の集め方は、画面の端から端の目印の検査の流れ（`helpers/scenario-marker-flow.ts`）を使う（この検査のモード・読み込みの間隔・プロファイルごとに
 * 読む画面と Server Function を設定で渡す）。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUTO_LOGIN_MIN_INTERVAL_MS } from '../../../src/control/job/auto-login-limits.js';
import { CONTROL_DATA_DIRECTORY_NAME } from '../../../src/control/store/database-path.js';
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
  JOB_TIMEOUT_MS,
  LOGIN_POSTS_PER_JOB,
  STATUS,
  UI_TIMEOUT_MS,
  createScenarioMarkerFlow,
  credentialsOf,
  nonReadRequestsOf,
  placeNameOf,
  type JobDetail,
} from './helpers/scenario-marker-flow.ts';
import { databaseRowsPlace, filesUnder, leakedPlaces, textPlace, type SearchedPlace } from './helpers/secret-markers.ts';

const IS_WINDOWS = process.platform === 'win32';
const AUTOMATED_SKIP_REASON = 'the automated login saves the credential with the real DPAPI, which exists only on Windows';

/** 1 つの場面の上限（ms）。 */
const SCENARIO_TIMEOUT_MS = 900_000;
/**
 * 読み込みの最小の間隔（ms）。1 つの画面の発見（落ち着きの待ちと読み取り）にかかる時間より長くして、間隔の確かめが、設定の間隔を守らないときに
 * 失敗するようにする（間隔を 0 にした変異で、確かめが失敗することを確かめた値。T27g の報告）。
 */
const NAVIGATION_INTERVAL_MS = 3_000;
/**
 * サーバに届いた時刻の長さで許す不足（ms。最初の回の「読み込みの開始から要求が届くまで」の遅れ。`discovery-job-fork.test.ts` の
 * `SERVER_ARRIVAL_DELAY_TOLERANCE_MS` と同じ根拠の値）。
 */
const SERVER_ARRIVAL_DELAY_TOLERANCE_MS = 0;
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
/** 1 つの場面のジョブの数（発見と READ の確かめ。ジョブごとにログインする）。 */
const JOBS_PER_SCENARIO = 2;
/** T27R2 の I3: fixture の `markerShapes` の画面の form の数（送信ボタンの `value`、画像の送信ボタンの `alt`、ARIA の参照）。 */
const MARKER_SHAPE_FORMS = 3;

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

/**
 * 画面の端から端の目印の検査の流れ（CCX-16。CC-081）。検索する画面は、プロファイルごとの画面（開始の画面を含む）と、READ の確かめの定義を作る画面と
 * 定義の画面。いま読む Server Function は、プロファイルごとの画面の関数（開始の画面の要約を含む）。
 */
const flow = createScenarioMarkerFlow({
  label: FLOW_LABEL,
  profileIds: () => PROFILE_IDS,
  secretMarkers,
  extraScreenPaths: () => PROFILE_IDS.flatMap((profileId) => [
    `/read-checks/${profileId}/new`,
    ...(definitionIds.get(profileId) ?? []).map((id) => `/read-checks/${profileId}/${id}`),
  ]),
  extraFunctionCalls: () => [],
  // この検査は、画面の Cookie と token の場所を分けて確かめない（`expectNoSecretMarker` を使わない）。
  isScreenSecretPlace: () => false,
  profileMode: 'TEST_AUTH_PASSIVE',
  navigationIntervalMs: NAVIGATION_INTERVAL_MS,
  profileScreenPrefixes: ['/profiles/', '/auth-setup/', '/credentials/', '/login-check/', '/start/', '/discovery/', '/read-checks/'],
  profileFunctions: ['getProfileFn', 'getAuthSetupFn', 'getCredentialPageFn', 'auditStartSummaryFn', 'discoveryPageFn', 'readCheckPageFn'],
});
const { openPage, snapshot, databasePath, recordDirectory, waitForJobEnd, prepareProfile, registerCredentialOnPage, searchedPlaces } = flow;
/** 記録のフォルダの名前（一時の root の中。`t27g-records`）。 */
const RECORD_DIRECTORY_NAME = flow.recordDirectoryName;

/** 開始のボタンを押し、ジョブの画面に移るのを待って、終わるまで待つ。ジョブの画面の HTML を集める。 */
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
 * 定義を作る画面で、送る値と期待を入れて保存する。保存できたら定義の一覧の画面（定義の画面）に移るので、その HTML を集める。拒まれたら理由を返す
 * （値を入れたままの画面の HTML は集めない）。
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
    await page.getByTestId('read-check-definition').first().waitFor({ timeout: UI_TIMEOUT_MS });
    await snapshot(page);
    const all = await page.getByTestId('read-check-definition').evaluateAll((rows) => rows.map((element) => element.getAttribute('data-read-check-id') ?? ''));
    definitionIds.set(profileId, all);
  }
  return reason;
};

/**
 * T27R2 の I3: 候補の画面に、目印の形の画面の form がすべて候補として出ている（発見がその画面を読み、probe が form を読んだ）。候補の画面の
 * HTML を集める。
 */
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
  await results.first().waitFor({ timeout: UI_TIMEOUT_MS });
  await snapshot(page);
  return (await results.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-result') ?? ''))).sort();
};

/**
 * READ の送る値が出てよい場所: 定義の画面（HTML と `readCheckPageFn` の応答）、管理データ（ファイルと表の行）、`read-evidence.json`（Run の
 * ディレクトリのファイルと、成果物の画面）、ワーカーが親から受けた `START` の記録（READ の確かめのジョブの定義の一覧。T27e の設計）。
 * T27R の M4: 設計では、ワーカーから親への `AUTH_STATE` の `SESSION_LOST`（止まったページの URL。送る値を含みうる）も出てよい場所だが、この
 * 検査の場面はどれもセッションが切れない（ジョブの `lastAuthState` は `AUTHENTICATED`。`SESSION_LOST` だけが URL を持つ）ので、加えない。
 * ワーカーから親への記録の全体を出てよい場所にすると、ほかのメッセージ（`FINISHED` など）の漏れを見逃すため、厳しいままにする。
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
  /** 秘密の目印が出た場所（`<場所> (<文字の形>)`）。 */
  readonly secretLeaks: readonly string[];
  /** READ の送る値が出た場所（`<場所> (<文字の形>)`）。 */
  readonly sendValuePlaces: readonly string[];
}

const searchEverywhere = async (): Promise<MarkerSearch> => {
  const places = await searchedPlaces();
  console.info(`[CCX-16] t27g searched places: ${places.length}; without the function responses: ${places.filter(({ place }) => !place.startsWith('function:')).length}`);
  return { places, secretLeaks: leakedPlaces(places, secretMarkers()), sendValuePlaces: leakedPlaces(places, SEND_VALUES) };
};

/** 秘密の目印がどこにもなく、READ の送る値が出てよい場所にだけあることを確かめる（漏れた場所の名前と文字の形だけを出す）。 */
const expectNoMarkerOutsideAllowedPlaces = async (scenario: string): Promise<MarkerSearch> => {
  const search = await searchEverywhere();
  expect(search.secretLeaks, `${scenario}: secret markers`).toEqual([]);
  expect(search.sendValuePlaces.filter((place) => !isSendValueAllowedPlace(placeNameOf(place))), `${scenario}: READ values outside the allowed places`).toEqual([]);
  // 検索した場所に、管理データのファイルと WAL と SHM、IPC の記録（両方向）、ワーカーの出力の記録が入っている。
  const names = search.places.map(({ place }) => place);
  const localData = `root:${CONTROL_DATA_DIRECTORY_NAME}/`;
  expect(names.some((name) => name.startsWith(localData) && name.endsWith('-wal')), scenario).toBe(true);
  expect(names.some((name) => name.startsWith(localData) && name.endsWith('-shm')), scenario).toBe(true);
  expect(names).toContain(`root:${RECORD_DIRECTORY_NAME}/${WORKER_RECORD_FILES.ipc}`);
  expect(names).toContain(`root:${RECORD_DIRECTORY_NAME}/${WORKER_PARENT_MESSAGE_RECORD}`);
  return search;
};

/** 要求の path（query を除く）。 */
const pathnameOf = (request: DiscoverySiteRequest): string => request.path.split('?')[0] ?? request.path;

/** ジョブの窓の、サイトへの要求を確かめる。 */
const expectSiteRequestsOf = (window: JobWindow): void => {
  const requests = window.site.requests.slice(window.from, window.to);
  // GET と HEAD のほかは、ログインの POST の 1 回だけ。
  expect(nonReadRequestsOf(requests), window.label).toEqual(Array.from({ length: LOGIN_POSTS_PER_JOB }, () => `POST ${DISCOVERY_SITE_PATHS.login}`));
  // 読まないパス・危険な語・範囲の外へは 0 件。
  expect(requests.filter((request) => DISCOVERY_SITE_FORBIDDEN_PATHS.includes(pathnameOf(request))
    || pathnameOf(request).startsWith(DISCOVERY_SITE_READ_CHECK_PATHS.privateArea)).map(({ path }) => path), window.label).toEqual([]);
  // ログインの POST の後の、管理画面の HTML（BeakSight の読み込み）。ログインの段の着地を除く。
  const postIndex = requests.findIndex(({ method }) => !READ_METHODS.has(method));
  const afterLogin = requests.slice(postIndex + 1);
  const documents = afterLogin.filter(({ adminDocument }) => adminDocument).slice(LOGIN_LANDING_DOCUMENTS);
  expect(documents.length, window.label).toBeGreaterThan(1);
  const first = documents[0];
  const last = documents.at(-1);
  if (first !== undefined && last !== undefined) {
    expect(last.at - first.at, `${window.label}: the navigation interval`)
      .toBeGreaterThanOrEqual((documents.length - 1) * NAVIGATION_INTERVAL_MS - SERVER_ARRIVAL_DELAY_TOLERANCE_MS);
  }
  if (window.kind === 'DISCOVERY') {
    // 発見の間の要求: 管理画面の HTML の読み込みのほかは、ページ自身の GET（SPA の画面の fetch）だけ。
    expect([...new Set(afterLogin.filter(({ adminDocument }) => !adminDocument).map(pathnameOf))], window.label).toEqual([DISCOVERY_SITE_PATHS.api]);
    expect([...new Set(documents.map(pathnameOf))].sort(), window.label).toEqual([...DISCOVERY_SITE_READ_PAGES, ...readCheckPagePaths()].sort());
  } else {
    // READ の URL（query のある管理画面の読み込み）の query は、定義の欄の名前だけ。
    const readUrls = documents.filter(({ path }) => path.includes('?')).map(({ path }) => new URL(path, window.site.origin));
    expect(readUrls.length, window.label).toBe(definitionCountOf(window));
    for (const url of readUrls) {
      expect([...url.searchParams.keys()].every((name) => window.parameterNames.includes(name)), `${window.label} ${url.pathname}`).toBe(true);
    }
    expect(afterLogin.filter(({ adminDocument }) => !adminDocument).map(pathnameOf), window.label).toEqual([]);
  }
};

/** READ の確かめの画面のうち、巡回で読む画面（リンクでつながっているもの）と、T27R2 の I3 の目印の形の画面。 */
const readCheckPagePaths = (): readonly string[] => {
  const r = DISCOVERY_SITE_READ_CHECK_PATHS;
  return [r.orders, r.lookup, r.brokenSearch, r.shape, r.secretSearch, r.exitSearch, r.order, DISCOVERY_SITE_EXTRA_PATHS.markerShapes];
};

/** READ の確かめのジョブの定義の数（プロファイルの定義の数）。 */
const definitionCountOf = (window: JobWindow): number => (definitionIds.get(window.label.split(' ')[0] ?? '') ?? []).length;

describe('T27g: no secret marker anywhere in the discovery and READ check flows from the screens', () => {
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

  it('with the manual login: discovers, defines READ checks, runs them, and no secret marker is anywhere', async () => {
    const site = siteOf(manualSite);
    flow.relayOf().provide(await credentialsOf(site));
    const discovery = await runJobFrom(`/discovery/${MANUAL_PROFILE}`, 'discovery-start', 'DISCOVERY', MANUAL_PROFILE, site);
    expect(discovery).toMatchObject({ jobKind: 'DISCOVERY', state: 'FINISHED', runStatus: 'COMPLETE', lastAuthState: 'AUTHENTICATED', autoLogin: null });
    await expectMarkerShapeCandidates(MANUAL_PROFILE);
    await expectNoMarkerOutsideAllowedPlaces('manual discovery');

    await createDefinitions(MANUAL_PROFILE, SEND_VALUE_MANUAL, REJECTED_VALUE_MANUAL);
    flow.relayOf().provide(await credentialsOf(site));
    const readCheck = await runJobFrom(`/read-checks/${MANUAL_PROFILE}`, 'read-check-start', 'READ_CHECK', MANUAL_PROFILE, site, ['q', 'id']);
    expect(readCheck).toMatchObject({ jobKind: 'READ_CHECK', state: 'FINISHED', runStatus: 'COMPLETE', lastAuthState: 'AUTHENTICATED' });
    expect(await readCheckResultsOf(MANUAL_PROFILE, readCheck.jobId)).toEqual(['MATCHED', 'MATCHED']);
    expect(site.successfulLogins).toBe(JOBS_PER_SCENARIO);
    await expectNoMarkerOutsideAllowedPlaces('manual READ check');
  }, SCENARIO_TIMEOUT_MS);

  it.skipIf(!IS_WINDOWS)(`with the automated login: registers on the screen, discovers, defines READ checks, runs them, and no secret marker is anywhere${IS_WINDOWS ? '' : ` [skipped: ${AUTOMATED_SKIP_REASON}]`}`, async () => {
    const site = siteOf(autoSite);
    const relayRequestsBefore = flow.relayOf().requested();
    await registerCredentialOnPage(AUTO_PROFILE, site);
    const discovery = await runJobFrom(`/discovery/${AUTO_PROFILE}`, 'discovery-start', 'DISCOVERY', AUTO_PROFILE, site);
    expect(discovery).toMatchObject({
      jobKind: 'DISCOVERY', state: 'FINISHED', runStatus: 'COMPLETE', lastAuthState: 'AUTHENTICATED', autoLogin: { result: 'SUCCEEDED', submitted: 'YES' },
    });
    await expectMarkerShapeCandidates(AUTO_PROFILE);
    await expectNoMarkerOutsideAllowedPlaces('automated discovery');

    await createDefinitions(AUTO_PROFILE, SEND_VALUE_AUTO, REJECTED_VALUE_AUTO);
    // 自動ログインどうしの最小の間隔を待たずに次のジョブを始める（ジョブが動いていない間に、試し始めた時刻を前へずらす。テストだけの操作）。
    expect(shiftAutoLoginAttemptsBack(databasePath(), AUTO_PROFILE, AUTO_LOGIN_MIN_INTERVAL_MS)).toBeGreaterThan(0);
    const readCheck = await runJobFrom(`/read-checks/${AUTO_PROFILE}`, 'read-check-start', 'READ_CHECK', AUTO_PROFILE, site, ['q', 'id']);
    expect(readCheck).toMatchObject({
      jobKind: 'READ_CHECK', state: 'FINISHED', runStatus: 'COMPLETE', lastAuthState: 'AUTHENTICATED', autoLogin: { result: 'SUCCEEDED', submitted: 'YES' },
    });
    expect(await readCheckResultsOf(AUTO_PROFILE, readCheck.jobId)).toEqual(['MATCHED', 'MATCHED']);
    expect(site.successfulLogins).toBe(JOBS_PER_SCENARIO);
    // 自動ログインは、手動のログインの段（受け渡しのサーバ）を使わない。
    expect(flow.relayOf().requested()).toBe(relayRequestsBefore);
    await expectNoMarkerOutsideAllowedPlaces('automated READ check');
  }, SCENARIO_TIMEOUT_MS);

  it('sent only reads besides one login POST per job, with no request to the excluded paths, and kept the navigation interval', () => {
    expect(windows.map(({ label }) => label)).toEqual([
      `${MANUAL_PROFILE} DISCOVERY`,
      `${MANUAL_PROFILE} READ_CHECK`,
      ...(IS_WINDOWS ? [`${AUTO_PROFILE} DISCOVERY`, `${AUTO_PROFILE} READ_CHECK`] : []),
    ]);
    for (const window of windows) {
      expectSiteRequestsOf(window);
    }
    // ジョブの外（定義の作成の間など）には、サイトへの要求がない。
    for (const site of [siteOf(manualSite), siteOf(autoSite)]) {
      const covered = windows.filter((window) => window.site === site).reduce((count, window) => count + (window.to - window.from), 0);
      expect(site.requests.length).toBe(covered);
    }
  });

  it('finds the READ values in the allowed places and a marker placed on purpose (the controls), and records the IPC both ways', async () => {
    const search = await expectNoMarkerOutsideAllowedPlaces('final');
    // 対照: READ の送る値は、出てよい場所で見つかる（定義の画面、管理データの表の行、read-evidence.json、定義の画面の Server Function の応答）。
    const sendPlaces = search.sendValuePlaces.map(placeNameOf);
    expect(sendPlaces).toContain('database:rows');
    expect(sendPlaces).toContain(`html:/read-checks/${MANUAL_PROFILE}`);
    expect(sendPlaces.some((place) => place.startsWith('root:') && place.endsWith(`/${READ_EVIDENCE_ARTIFACT_FILE_NAME}`))).toBe(true);
    expect(sendPlaces.some((place) => place.startsWith('function:readCheckPageFn:'))).toBe(true);
    // Run のディレクトリの成果物（discovery.json と read-evidence.json）を検索した。
    const names = search.places.map(({ place }) => place);
    expect(names.filter((name) => name.endsWith(`/${DISCOVERY_ARTIFACT_FILE_NAME}`) && name.startsWith('root:')).length)
      .toBe(jobs.filter(({ kind }) => kind === 'DISCOVERY').length);
    expect(names.filter((name) => name.endsWith(`/${READ_EVIDENCE_ARTIFACT_FILE_NAME}`) && name.startsWith('root:')).length)
      .toBe(jobs.filter(({ kind }) => kind === 'READ_CHECK').length);
    // IPC の記録: 親から受けた `START`（ジョブの数）と、親へ送った `FINISHED`。
    const typesOf = (place: string): readonly string[] => Buffer.from(search.places.find((entry) => entry.place === place)?.bytes ?? new Uint8Array())
      .toString('utf8').split('\n').filter((line) => line.length > 0).map((line) => String((JSON.parse(line) as Record<string, unknown>)['type']));
    expect(typesOf(`root:${RECORD_DIRECTORY_NAME}/${WORKER_PARENT_MESSAGE_RECORD}`).filter((type) => type === 'START').length).toBe(jobs.length);
    expect(typesOf(`root:${RECORD_DIRECTORY_NAME}/${WORKER_RECORD_FILES.ipc}`).filter((type) => type === 'FINISHED').length).toBe(jobs.length);
    // 管理データの表に行がある（検索した行が空でない）。
    const rows = databaseRowsPlace(databasePath(), 'database:rows');
    for (const table of ['jobs', 'discovery_candidates', 'discovery_jobs', 'read_checks', 'read_check_results']) {
      expect(rows.rowCounts.get(table) ?? 0, table).toBeGreaterThan(0);
    }

    // 対照（この一時の root の中で）: わざと目印を置いたファイルは、同じ検索で見つかる（UTF-16LE）。
    const planted = `${recordDirectory()}/t27g-planted-control.txt`;
    const [plantedMarker = ''] = siteOf(manualSite).secretValues();
    writeFileSync(planted, Buffer.from(`planted ${plantedMarker}`, 'utf16le'));
    try {
      expect((await searchEverywhere()).secretLeaks).toEqual([`root:${RECORD_DIRECTORY_NAME}/t27g-planted-control.txt (utf16le)`]);
    } finally {
      rmSync(planted, { force: true });
    }
  }, SCENARIO_TIMEOUT_MS);
});

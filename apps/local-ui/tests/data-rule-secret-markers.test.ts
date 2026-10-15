/**
 * 入力の規則（補完）の目印の検査（端から端まで。Task 29 の設計書 3 章の「補完の画面」、6 章の画面の目印の検査、8 章。T29f）。T28f の作り
 * （`helpers/scenario-marker-flow.ts`）で、ビルドした画面を一時の root の起動の部品で起動し、書き込みのモード（`TEST_APPROVED_WRITE`）の手動のログインの
 * プロファイルで、画面から次を行う:
 *   発見（`DISCOVERY`）→ READ の確かめの定義の作成 → 登録（CREATE）の候補からシナリオの作成 → シナリオの詳細から入力の規則の画面を開く（データの例の
 *   表示。業務テンプレートで決まる）→ 保存（確認のダイアログ）→ 承認 → 入力の規則の補完（人の固定の値）→ 保存（確認のダイアログ。承認していたので
 *   再承認になる）→ データの例の表示（人の固定の値）→ 再承認。
 * 確かめること:
 * - 秘密の目印（fixture のサイト `tests/helpers/discovery-site-fixture.ts` の `secretValues()`: セッションの Cookie、localStorage、資格情報、CSRF の
 *   トークン、hidden の値、入力の欄の今の値（送る欄 `name` の今の値を含む）、選択肢の label、表の行の中身）が、検索するすべての場所に、UTF-8 でも
 *   UTF-16LE でも出ない。検索する場所は T28f と同じ（一時の root のすべてのファイル（Run のディレクトリ、管理データのファイルと WAL と SHM、記録の
 *   フォルダ）、管理データのすべての表のすべての行（版 7 の `rule_sets`・`rule_set_revisions` を含む）、画面のサーバの標準出力と標準エラー、ワーカーの
 *   標準出力と標準エラー、IPC の記録（両方向）、子プロセスの起動の記録、すべての画面の HTML（入力の規則の画面を含む）、Server Function の応答
 *   （`dataRulePageFn`・`saveDataRulesFn` を含む））。
 * - 画面の Cookie と token は、シナリオと入力の規則の画面の HTML と Server Function の応答に出ない。
 * - 対照: (1) この一時の root にわざと置いた目印（UTF-16LE）が、同じ検索で見つかる。(2) 設計どおり出てよい値（人の固定の値、データの例の値）が、
 *   同じ検索で、入力の規則の画面と管理データの表の行に見つかる（版 7 の表と規則の画面を確かに検索した）。
 * - サイトへの要求: 発見のジョブのログインの POST の 1 回のほかは GET と HEAD だけ。入力の規則の画面の表示・データの例・保存・承認の間は、サイトへの
 *   要求が 0 件（データの例は送らない）。
 * fixture のサイトは 127.0.0.1 だけ。Chromium は headless だけ。目印の値は実行ごとのランダムな値で、出力しない（漏れた場所の名前と、文字の形だけを出す）。
 * 場面は手動のログインだけ（入力の規則の流れは、ログインの方式によらない。自動ログインの場面は T28f が確かめる）。
 */
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DISCOVERY_ARTIFACT_FILE_NAME } from '../../../src/core/artifact-layout.js';
import { LOCAL_UI_DATA_RULE_TEXT } from '../../../src/presentation/messages.js';
import { startDiscoverySite, type DiscoverySite } from '../../../tests/helpers/discovery-site-fixture.js';
import { WORKER_PARENT_MESSAGE_RECORD, WORKER_RECORD_FILES } from './helpers/auth-worker.ts';
import {
  FIRST_REVISION,
  LOGIN_POSTS_PER_JOB,
  SCENARIO_FIELD_NAME,
  SCENARIO_TIMEOUT_MS,
  UI_TIMEOUT_MS,
  createScenarioMarkerFlow,
  credentialsOf,
  loginPosts,
  nonReadRequestsOf,
  placeNameOf,
} from './helpers/scenario-marker-flow.ts';
import { databaseRowsPlace, leakedPlaces } from './helpers/secret-markers.ts';

const text = LOCAL_UI_DATA_RULE_TEXT;

/** テストの値（匿名）。 */
const PROFILE = 't29f-manual';
const PROFILE_IDS = Object.freeze([PROFILE]);
/** 人の固定の値（秘密でない、匿名の値。規則の画面と管理データに出てよい）。 */
const FIXED_VALUES = Object.freeze(['t29f-fixed-alpha', 't29f-fixed-beta']);
/** 画面の例の数（`data-rule-functions.ts` の `EXAMPLE_COUNT`）。 */
const EXAMPLE_COUNT = 3;
/** 1 つの場面のジョブの数（発見だけ。規則の保存と承認はジョブを始めない）。 */
const JOBS_PER_SCENE = 1;
/** 保存と承認の数: 規則の保存が 2 回（版 1 と版 2）、承認が 2 回（保存の後と、再承認）。 */
const RULE_SET_REVISIONS = 2;
const APPROVALS = 2;
/** シナリオの版: 作成で 1、規則の保存ごとに 1 つ上がる。 */
const REVISION_AFTER_RULES = FIRST_REVISION + RULE_SET_REVISIONS;

let site: DiscoverySite | undefined;
/** 場面で作ったもの。 */
interface SceneRecord {
  readonly readCheckId: string;
  readonly candidateDigest: string;
  readonly scenarioId: string;
  /** テンプレートで作ったデータの例の値（送る欄の 1 つ目の例。規則の画面に出てよい）。 */
  readonly templateExample: string;
}
let scene: SceneRecord | undefined;

const siteOf = (): DiscoverySite => {
  if (site === undefined) {
    throw new Error('fixture のサイトが起動していない');
  }
  return site;
};
const sceneOf = (): SceneRecord => {
  if (scene === undefined) {
    throw new Error('場面が終わっていない');
  }
  return scene;
};

/** 秘密の目印（どこにも出てはならない）。 */
const secretMarkers = (): readonly string[] => siteOf().secretValues();

const rulesPathOf = (scenarioId: string): string => `/scenarios/${PROFILE}/${scenarioId}/rules`;

/** シナリオと入力の規則の画面の HTML と、その Server Function の応答か（画面の Cookie と token を探す範囲）。 */
const isScenarioOrRuleScreenPlace = (place: string): boolean =>
  /^(?:html:|browser-html:\d+:)\/scenarios\//u.test(place) || /^function:(?:scenario[A-Za-z]+Fn|dataRulePageFn|saveDataRulesFn):/u.test(place);

const flow = createScenarioMarkerFlow({
  label: 't29f',
  profileIds: () => PROFILE_IDS,
  secretMarkers,
  extraScreenPaths: () => (scene === undefined ? [`/scenarios/${PROFILE}`] : [
    `/read-checks/${PROFILE}/${scene.readCheckId}`,
    `/scenarios/${PROFILE}`,
    `/scenarios/${PROFILE}/new?candidate=${encodeURIComponent(scene.candidateDigest)}`,
    `/scenarios/${PROFILE}/${scene.scenarioId}`,
    `/scenarios/${PROFILE}/${scene.scenarioId}/edit`,
    rulesPathOf(scene.scenarioId),
  ]),
  extraFunctionCalls: () => (scene === undefined ? [] : [
    ['scenarioFormPageFn', { profileId: PROFILE, candidateIdentityDigest: scene.candidateDigest }] as const,
    ['scenarioDetailPageFn', { scenarioId: scene.scenarioId }] as const,
    ['dataRulePageFn', { scenarioId: scene.scenarioId }] as const,
  ]),
  isScreenSecretPlace: isScenarioOrRuleScreenPlace,
});

/** シナリオの詳細の画面から、入力の規則の画面を開く（リンクをたどる）。 */
const openRulesFromDetail = async (scenarioId: string): Promise<Page> => {
  const page = await flow.openPage(`/scenarios/${PROFILE}/${scenarioId}`);
  await page.getByTestId('scenario-open-rules').click();
  await page.waitForURL(new RegExp(`${rulesPathOf(scenarioId)}$`, 'u'), { timeout: UI_TIMEOUT_MS });
  await page.getByTestId('data-rule-form').waitFor({ timeout: UI_TIMEOUT_MS });
  return page;
};

/** データの例の、送る欄の値（例の順）。 */
const exampleValuesOf = (page: Page): Promise<readonly string[]> =>
  page.locator(`[data-testid="data-rule-example"] tr[data-field-name="${SCENARIO_FIELD_NAME}"] td code`).allTextContents();

/** 確認のダイアログの後に保存し、知らせが出て、すべて決まった状態になるまで待つ（ダイアログと保存の後の HTML を集める）。 */
const saveRulesOnScreen = async (page: Page): Promise<void> => {
  await page.getByTestId('data-rule-save').click();
  const dialog = page.getByRole('dialog', { name: text.saveDialog.title });
  await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
  expect(await dialog.textContent()).toContain(text.saveDialog.body);
  await flow.snapshot(page);
  await dialog.getByRole('button', { name: text.saveDialog.confirm, exact: true }).click();
  await page.waitForURL(/\/rules\?notice=saved$/u, { timeout: UI_TIMEOUT_MS });
  await expect.poll(() => page.getByTestId('data-rule-state').getAttribute('data-state'), { timeout: UI_TIMEOUT_MS }).toBe('DECIDED');
  await expect.poll(() => page.getByTestId('data-rule-example').count(), { timeout: UI_TIMEOUT_MS }).toBe(EXAMPLE_COUNT);
  await flow.snapshot(page);
};

interface DetailView {
  readonly scenario: { readonly revision: number; readonly state: string };
  readonly status: { readonly displayState: string; readonly reasons: readonly string[] } | null;
}

/**
 * 場面: 発見 → READ の定義 → シナリオの作成 → 規則の画面（テンプレートのデータの例）→ 保存 → 承認 → 人の固定の値を入れて保存（再承認になる）→
 * データの例 → 再承認。発見のジョブの後に、サイトへの要求がないことを確かめる。
 */
const runScene = async (): Promise<void> => {
  const discovery = await flow.runDiscoveryFrom(PROFILE, siteOf());
  expect(discovery).toMatchObject({ jobKind: 'DISCOVERY', state: 'FINISHED', runStatus: 'COMPLETE', lastAuthState: 'AUTHENTICATED' });
  const afterJob = siteOf().requests.length;

  const readCheckId = await flow.saveLookupDefinition(PROFILE);
  const { candidateDigest, scenarioId } = await flow.createScenarioOnScreen(PROFILE, readCheckId);

  // 入力の規則の画面: 送る欄は業務テンプレートで決まり、データの例が出る（まだ保存していない。送らない）。
  const first = await openRulesFromDetail(scenarioId);
  const field = first.locator(`[data-testid="data-rule-field"][data-field-name="${SCENARIO_FIELD_NAME}"]`);
  expect(await field.getByTestId('data-rule-status').getAttribute('data-status')).toBe('DECIDED');
  expect(await first.getByTestId('data-rule-no-execution').textContent()).toBe(text.noExecution);
  expect(await first.getByTestId('data-rule-example').count()).toBe(EXAMPLE_COUNT);
  const [templateExample = ''] = await exampleValuesOf(first);
  expect(templateExample.length).toBeGreaterThan(0);
  await flow.snapshot(first);
  await saveRulesOnScreen(first);
  await flow.approveOnScreen(PROFILE, scenarioId);

  // 人の固定の値を入れて保存する（承認していたので、再承認になる）。
  const second = await openRulesFromDetail(scenarioId);
  await second.locator(`select[data-kind-for="${SCENARIO_FIELD_NAME}"]`).selectOption('FIXED_LIST');
  await second.locator(`select[data-method-for="${SCENARIO_FIELD_NAME}"]`).selectOption('FROM_FIXED_LIST');
  await second.locator(`textarea[data-fixed-for="${SCENARIO_FIELD_NAME}"]`).fill(FIXED_VALUES.join('\n'));
  await flow.snapshot(second);
  await saveRulesOnScreen(second);
  for (const value of await exampleValuesOf(second)) {
    expect(FIXED_VALUES).toContain(value);
  }
  expect(await second.locator(`[data-testid="data-rule-field"][data-field-name="${SCENARIO_FIELD_NAME}"]`).getAttribute('data-source')).toBe('HUMAN');

  const changed = await flow.valueOf<DetailView>('scenarioDetailPageFn', 'GET', { scenarioId });
  expect(changed.scenario).toEqual(expect.objectContaining({ revision: REVISION_AFTER_RULES, state: 'DRAFT' }));
  expect(changed.status?.displayState).toBe('NEEDS_REAPPROVAL');
  expect(changed.status?.reasons).toEqual(expect.arrayContaining(['SCENARIO_REVISION_CHANGED', 'INPUT_RULES_CHANGED']));
  await flow.approveOnScreen(PROFILE, scenarioId);
  scene = { readCheckId, candidateDigest, scenarioId, templateExample };

  // 入力の規則の画面の表示・データの例・保存・承認の間、サイトへの要求は 0 件。
  expect(siteOf().requests.length, 'requests after the discovery job').toBe(afterJob);
};

describe('T29f: no secret marker anywhere and no site request in the data rule flow from the screens', () => {
  beforeAll(async () => {
    site = await startDiscoverySite({ readCheckPages: true, markerShapes: true });
    await flow.start();
    await flow.prepareProfile(PROFILE, site, false);
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await flow.closePages();
  });

  afterAll(async () => {
    await flow.stop();
    await site?.close();
  }, SCENARIO_TIMEOUT_MS);

  it('discovers, makes a scenario, completes and saves its data rules with fixed values, shows examples and approves it again on the screens, and no secret marker is anywhere', async () => {
    flow.relayOf().provide(await credentialsOf(siteOf()));
    await runScene();
    expect(siteOf().successfulLogins).toBe(JOBS_PER_SCENE);
    await flow.expectNoSecretMarker('manual');
  }, SCENARIO_TIMEOUT_MS);

  it('sent only reads besides one login POST in the discovery job, and nothing outside the job (no request for the examples)', () => {
    expect(flow.windows.map(({ label }) => label)).toEqual([`${PROFILE} DISCOVERY`]);
    for (const window of flow.windows) {
      expect(nonReadRequestsOf(window.site.requests.slice(window.from, window.to)), window.label).toEqual(loginPosts(LOGIN_POSTS_PER_JOB));
    }
    const total = flow.windows.reduce((count, window) => count + (window.to - window.from), 0);
    expect(siteOf().requests.length).toBe(total);
    expect(nonReadRequestsOf(siteOf().requests)).toEqual(loginPosts(flow.windows.length * LOGIN_POSTS_PER_JOB));
  });

  it('finds a marker placed on purpose first, then searched the version 7 tables and the data rule screens (the fixed values and the examples are found there)', async () => {
    // 対照（先に。この一時の root の中で）: わざと目印を置いたファイルは、同じ検索で見つかる（UTF-16LE）。
    const plantedName = `t29f-planted-control-${randomUUID()}.txt`;
    const planted = `${flow.recordDirectory()}/${plantedName}`;
    const [plantedMarker = ''] = secretMarkers();
    writeFileSync(planted, Buffer.from(`planted ${plantedMarker}`, 'utf16le'));
    try {
      expect(leakedPlaces(await flow.searchedPlaces(), secretMarkers())).toEqual([`root:${flow.recordDirectoryName}/${plantedName} (utf16le)`]);
    } finally {
      rmSync(planted, { force: true });
    }

    const places = await flow.expectNoSecretMarker('final');
    const names = places.map(({ place }) => place);
    const { scenarioId, templateExample } = sceneOf();
    // Run のディレクトリの成果物（discovery.json）と、IPC の記録（親から受けた `START`、親へ送った `FINISHED`）を検索した。
    expect(names.filter((name) => name.startsWith('root:') && name.endsWith(`/${DISCOVERY_ARTIFACT_FILE_NAME}`)).length).toBe(flow.jobs.length);
    expect(flow.recordedMessageTypesOf(places, WORKER_PARENT_MESSAGE_RECORD).filter((type) => type === 'START').length).toBe(flow.jobs.length);
    expect(flow.recordedMessageTypesOf(places, WORKER_RECORD_FILES.ipc).filter((type) => type === 'FINISHED').length).toBe(flow.jobs.length);
    // 版 7 の 2 つの表（規則の版は 2 つ）と、シナリオの表と承認の記録に行がある（検索した行が空でない）。
    const rows = databaseRowsPlace(flow.databasePath(), 'database:rows');
    expect(rows.rowCounts.get('rule_sets')).toBeGreaterThan(0);
    expect(rows.rowCounts.get('rule_set_revisions')).toBe(RULE_SET_REVISIONS);
    expect(rows.rowCounts.get('scenario_revisions')).toBe(REVISION_AFTER_RULES);
    expect(rows.rowCounts.get('approval_receipts')).toBe(APPROVALS);

    // 対照: 設計どおり出てよい値は、同じ検索で見つかる。人の固定の値は、管理データの表の行と、規則の画面（サーバで描いたもの）と、その Server Function の
    // 応答に。テンプレートで作ったデータの例は、ブラウザで開いた規則の画面に。
    const found = (value: string): readonly string[] => leakedPlaces(places, [value]).map(placeNameOf);
    for (const value of FIXED_VALUES) {
      expect(found(value)).toEqual(expect.arrayContaining(['database:rows', `html:${rulesPathOf(scenarioId)}`]));
      expect(found(value).some((place) => place.startsWith('function:dataRulePageFn:'))).toBe(true);
    }
    expect(found(templateExample).some((place) => place.startsWith(`browser-html:`) && place.endsWith(rulesPathOf(scenarioId)))).toBe(true);
    expect(found(scenarioId)).toEqual(expect.arrayContaining(['database:rows', `html:${rulesPathOf(scenarioId)}`]));
  }, SCENARIO_TIMEOUT_MS);
});

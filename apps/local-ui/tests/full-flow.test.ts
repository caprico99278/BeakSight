/**
 * 画面だけで全段を通す E2E（T32h。Task 32 の設計書 4.2）。ビルドした画面を一時の root の起動の部品で起動し（`helpers/scenario-marker-flow.ts` の
 * 作り。記録つきのページ）、headless の Chromium の画面の操作（クリックと入力）だけで、127.0.0.1 の書き込みの fixture
 * （`tests/helpers/write-site-fixture.ts`）に対して、次の段を順に通す。ワーカーは本物（CLI の起動の設定の Chromium）。手動のログインだけは、テスト
 * だけの入口が受け渡しのサーバから資格情報を受けて入れる（人の操作の代わり。`helpers/auth-worker.ts`）。
 * 1. プロファイルの作成（公開の監査・認証つきの監査・書き込みのモードの 3 つ）と、認証の設定の保存（画面）。
 * 2. 公開の監査（PUBLIC_PASSIVE）→ `report.html` を開き、監査の ZIP を落とす。
 * 3. 認証つきの監査（TEST_AUTH_PASSIVE。手動のセッションの引き継ぎ）。
 * 4. 候補の発見 → READ の定義と確かめ。
 * 5. CREATE のシナリオの作成 → 入力の規則 → 承認 → CREATE の開始と結果（`VERIFIED`）。
 * 6. UPDATE のシナリオの作成 → 入力の規則 → 承認 → UPDATE の開始と結果（`VERIFIED`。前後の差分）。
 * 7. 監査済みデータの台帳（CREATE の ID の行が UPDATE 1 回・`VERIFIED`）。
 * 8. 書き込みの報告（`data-check="VALID"`、`action-report.html` を開く、書き込みの ZIP を落とす）。
 * 確かめること: 落とした 2 つの ZIP の中の JSON がスキーマに合い、目録の sha256 が中身と一致する。2 つの HTML が本物のブラウザで開き、主な見出しと
 * 結果の値があり、CSP の違反・console の誤り・外への要求が 0（ページの記録の補助）。サイトに届いた読み取りでない要求は、ログインの POST（認証の
 * ジョブごとに 1 回）と、書き込みの POST の CREATE 1・UPDATE 1 だけ（全部の後に 2 秒待って数え直す）。秘密の目印（資格情報・セッション・CSRF・
 * hidden・readonly・保つ欄の値）は、画面・Server Function の応答・管理データ（WAL を含む）・成果物（ZIP の中身を含む）に出ない。送った値と人の値は、
 * 出力先と落としたファイルの中では決まった成果物（`isWriteValueArtifactPlace`）だけにある。
 * Server Function を直接呼ぶのは、確かめ（ジョブの状態と、画面と同じ値）のためだけ。目印の値は出力しない。
 */
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { unzipSync } from 'fflate';
import type { Download, Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../../src/core/deadline.js';
import { ACTION_RUN_SCHEMA_VERSION, type ActionRunDocument } from '../../../src/control/actions/action-contracts.js';
import {
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
  ACTION_RUN_ARTIFACT_FILE_NAME,
  APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
  RUN_ARTIFACT_FILE_NAMES,
  artifactFilePath,
  isActionBundleFileName,
  isBundleFileName,
} from '../../../src/core/artifact-layout.js';
import { createSha256FingerprintOfBytes } from '../../../src/core/ids.js';
import { validateArtifact } from '../../../src/core/schema-validator.js';
import { READ_CHECK_EXPECTATION_KIND_CATALOG } from '../../../src/presentation/catalog.js';
import {
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_DATA_RULE_TEXT,
  LOCAL_UI_READ_CHECK_TEXT,
  LOCAL_UI_SCENARIO_TEXT,
  LOCAL_UI_TEXT,
  LOCAL_UI_WRITE_TEXT,
} from '../../../src/presentation/messages.js';
import { ACTION_BUNDLE_MANIFEST_FILE_NAME } from '../../../src/report/action-bundle.js';
import { CHATGPT_BUNDLE_FILE_NAMES } from '../../../src/report/chatgpt-bundle.js';
import { REPORT_CLASS_NAMES } from '../../../src/report/html-tokens.js';
import { nonReadRequestsOf } from '../../../tests/helpers/leak-places.js';
import { isWriteValueArtifactPlace, readWriteReportFiles } from '../../../tests/helpers/write-report-checks.js';
import { WRITE_SITE_LOGIN_FIELDS, WRITE_SITE_PATHS, startWriteSite, writeSiteEditPathOf, writeSiteRecordPathOf, type WriteSite } from '../../../tests/helpers/write-site-fixture.js';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
import { chooseExistingTargetConfig } from './helpers/profile-form.ts';
import { SCENARIO_TIMEOUT_MS, UI_TIMEOUT_MS, createScenarioMarkerFlow, type JobDetail } from './helpers/scenario-marker-flow.ts';

const PUBLIC_PROFILE = 't32h-public';
const AUTH_PROFILE = 't32h-auth';
const WRITE_PROFILE = 't32h-write';
/** fixture のサイトの、BeakSight が登録していない会員（発見のジョブが更新の画面を見つけるため。テストの準備）。 */
const EXISTING_NAME = '既存花子';
/** CREATE で送る名前と、UPDATE で変える名前（人の固定の値の規則。匿名の値）。 */
const CREATED_NAME = '台帳一郎';
const UPDATED_NAME = '更新太郎';
/** 巡回の上限と、読み込みの最小の間隔（ms。ループバックの fixture）。 */
const MAX_PAGES = 20;
const NAVIGATION_INTERVAL_MS = 0;
/** 全部の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 2_000;
/** 落としたファイルを置く、一時の root の中のフォルダ（目印の検査の対象に入る）。 */
const DOWNLOAD_DIRECTORY_NAME = 't32h-downloads';
/** 書き込みの検証の指定（成功は登録の画面、入力の誤りは `.error`、ID は URL のパスから、照合は一覧の検索）。値ではなく構造だけ。 */
const VERIFICATION = Object.freeze({
  successPathPrefix: `${WRITE_SITE_PATHS.create}/`,
  successSelector: '.registered',
  inputErrorPathPrefix: WRITE_SITE_PATHS.create,
  inputErrorSelector: '.error',
  recordIdPathPattern: `${WRITE_SITE_PATHS.create}/{id}`,
  lookupParameter: 'q',
  fieldName: 'name',
});

const auditText = LOCAL_UI_AUDIT_TEXT;
const authText = LOCAL_UI_AUTH_TEXT.setup;
const profileText = LOCAL_UI_TEXT.profileForm;
const readText = LOCAL_UI_READ_CHECK_TEXT;
const scenarioText = LOCAL_UI_SCENARIO_TEXT;
const writeText = LOCAL_UI_WRITE_TEXT;
const ruleText = LOCAL_UI_DATA_RULE_TEXT;

/** ジョブの詳細のうち、ここで確かめる項目（`JobDetail` に足すもの）。 */
type JobView = Omit<JobDetail, 'artifacts'> & {
  readonly runId: string | null;
  readonly artifacts: readonly { readonly kind: string; readonly relativePath: string; readonly href: string }[];
  readonly write: { readonly recordId: string | null; readonly result: string | null } | null;
};

let site: WriteSite | undefined;
const siteOf = (): WriteSite => {
  if (site === undefined) {
    throw new Error('fixture のサイトが起動していない');
  }
  return site;
};

/** 段をまたぐ値。 */
const state = {
  existingId: 0,
  readCheckId: '',
  createScenarioId: '',
  updateScenarioId: '',
  createJobId: '',
  updateJobId: '',
  createdId: '',
  downloads: [] as string[],
  durations: [] as string[],
};

const flow = createScenarioMarkerFlow({
  label: 't32h',
  profileIds: () => [AUTH_PROFILE, WRITE_PROFILE],
  secretMarkers: () => siteOf().secretValues(),
  extraScreenPaths: () => [
    `/profiles/${PUBLIC_PROFILE}`,
    `/start/${PUBLIC_PROFILE}`,
    `/start/${AUTH_PROFILE}`,
    `/scenarios/${WRITE_PROFILE}`,
    ...[state.createScenarioId, state.updateScenarioId].filter((id) => id.length > 0).flatMap((id) => [
      `/scenarios/${WRITE_PROFILE}/${id}`, `/scenarios/${WRITE_PROFILE}/${id}/rules`, `/scenarios/${WRITE_PROFILE}/${id}/write`,
    ]),
    `/ledger/${WRITE_PROFILE}`,
  ],
  extraFunctionCalls: () => [
    ['auditedDataLedgerPageFn', { profileId: WRITE_PROFILE }] as const,
    ...[state.createScenarioId, state.updateScenarioId].filter((id) => id.length > 0).flatMap((scenarioId) => [
      ['scenarioDetailPageFn', { scenarioId }] as const,
      ['writeStartPageFn', { scenarioId }] as const,
    ]),
  ],
  isScreenSecretPlace: (place) => /^(?:html:|browser-html:\d+:|function:)/u.test(place),
  recordPages: true,
});

/** 段の時間を覚える（報告のため）。 */
const timed = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    state.durations.push(`${label}: ${String(Date.now() - startedAt)}ms`);
  }
};

/** fixture のサイトの仮の資格情報を、受け渡しのサーバに 1 組渡す（手動のログインの代わり。認証のジョブごとに 1 回）。 */
const provideWriteSiteCredentials = async (): Promise<void> => {
  const fields: (readonly [string, string])[] = [];
  await siteOf().fillCredentials(async (selector, value) => {
    fields.push([selector, value]);
  });
  flow.relayOf().provide({ fields, submit: WRITE_SITE_LOGIN_FIELDS.submit });
};

/** ページの URL の最後の区切り（ジョブやシナリオの ID）。 */
const lastSegmentOf = (page: Page): string => new URL(page.url()).pathname.split('/').at(-1) ?? '';

/** 画面の新しいプロファイルの form で登録する。 */
const createProfileOnScreen = async (
  profileId: string,
  targetConfigPath: string,
  test: { readonly mode: string; readonly auth: string } | null,
): Promise<void> => {
  const page = await flow.openPage('/profiles/new');
  await page.getByLabel(profileText.profileId, { exact: true }).fill(profileId);
  // T43b: 作成の画面の既定は「開始の URL から新しく作る」。この流れは、すでにある設定のファイルを選ぶ。
  await chooseExistingTargetConfig(page, targetConfigPath, UI_TIMEOUT_MS);
  await page.getByText(profileText.configOk).waitFor({ timeout: UI_TIMEOUT_MS });
  if (test !== null) {
    await page.getByLabel(profileText.environment, { exact: true }).selectOption('TEST');
    await page.getByLabel(profileText.mode, { exact: true }).selectOption(test.mode);
    await page.getByLabel(profileText.auth, { exact: true }).selectOption(test.auth);
    await page.getByLabel(profileText.approvedTestOrigins, { exact: true }).fill(siteOf().origin);
    await page.getByLabel(profileText.environmentEvidenceRef, { exact: true }).fill(`${profileId}-evidence`);
  }
  await page.getByRole('button', { name: profileText.save }).click();
  await page.getByText(profileText.created).waitFor({ timeout: UI_TIMEOUT_MS });
  await flow.snapshot(page);
};

/** プロファイルの画面から認証の設定の画面へ移り、fixture のサイトのログインと読む範囲を入れて保存する。 */
const saveAuthSetupOnScreen = async (profileId: string): Promise<void> => {
  const profile = await flow.openPage(`/profiles/${profileId}`);
  await profile.getByTestId('profile-auth-setup').getByRole('link', { name: LOCAL_UI_AUTH_TEXT.profileDetail.open }).click();
  await profile.waitForURL(new RegExp(`/auth-setup/${profileId}$`, 'u'), { timeout: UI_TIMEOUT_MS });
  await profile.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
  const origin = siteOf().origin;
  for (const [label, value] of [
    [authText.loginStartUrl, `${origin}${WRITE_SITE_PATHS.login}`],
    [authText.loginPostEndpoints, `${origin}${WRITE_SITE_PATHS.login}`],
    [authText.successPathPrefix, WRITE_SITE_PATHS.list],
    [authText.successSelector, '#search'],
    [authText.sessionLostPathPrefix, WRITE_SITE_PATHS.login],
    [authText.excludedPaths, '/logout'],
    [authText.auditPathPrefixes, WRITE_SITE_PATHS.list],
  ] as const) {
    await profile.getByLabel(label, { exact: true }).fill(value);
  }
  await profile.getByRole('button', { name: authText.save }).click();
  await profile.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
  await profile.locator('[data-testid="auth-setup-freshness"][data-freshness="CURRENT"]').waitFor({ timeout: UI_TIMEOUT_MS });
  await flow.snapshot(profile);
};

/** 開始の画面から監査を新しく始め、ジョブの画面へ移る。ジョブの ID を返す。 */
const startAuditOnScreen = async (profileId: string): Promise<{ readonly page: Page; readonly jobId: string }> => {
  const list = await flow.openPage('/');
  await list.locator(`tr[data-profile-id="${profileId}"]`).getByRole('link', { name: auditText.profileList.startAudit }).click();
  await list.waitForURL(new RegExp(`/start/${profileId}$`, 'u'), { timeout: UI_TIMEOUT_MS });
  await list.getByTestId('start-target').waitFor({ timeout: UI_TIMEOUT_MS });
  await flow.snapshot(list);
  const startNew = list.getByRole('radio', { name: auditText.start.startNew });
  if (await startNew.count() > 0) {
    await startNew.check();
  }
  await list.getByRole('button', { name: auditText.start.submit }).click();
  await list.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
  const jobId = lastSegmentOf(list);
  flow.jobs.push({ jobId, profileId });
  return { page: list, jobId };
};

/** ジョブの終わりを待ち、ジョブの画面が終わりの状態を出すまで待つ。ジョブの値を返す。 */
const waitForJobOnScreen = async (page: Page, jobId: string): Promise<JobView> => {
  const job = await flow.waitForJobEnd(jobId) as JobView;
  await page.locator('[data-testid="job-state"]:not([data-state="STARTING"]):not([data-state="RUNNING"]):not([data-state="STOPPING"])')
    .waitFor({ timeout: UI_TIMEOUT_MS });
  await flow.snapshot(page);
  return job;
};

/** リンクをクリックして落とし、一時の root の中のフォルダに、その名前で置く。置いたパスを返す。 */
const downloadFrom = async (page: Page, link: Locator): Promise<string> => {
  const [download]: [Download, void] = await Promise.all([page.waitForEvent('download'), link.click()]);
  const directory = `${flow.rootOf()}/${DOWNLOAD_DIRECTORY_NAME}`;
  mkdirSync(directory, { recursive: true });
  const path = `${directory}/${download.suggestedFilename()}`;
  await download.saveAs(path);
  state.downloads.push(path);
  return path;
};

/** ZIP の目録（`manifest.json`）の `files` の path と sha256 が、目録を除く中身（ZIP の中の順）と一致する。 */
const expectManifestMatches = (entries: Readonly<Record<string, Uint8Array>>, manifestName: string): void => {
  const manifest = JSON.parse(new TextDecoder().decode(entries[manifestName])) as { readonly files: readonly { readonly path: string; readonly sha256: string }[] };
  expect(manifest.files.map(({ path, sha256 }) => [path, sha256])).toEqual(Object.entries(entries)
    .filter(([path]) => path !== manifestName)
    .map(([path, bytes]) => [path, createSha256FingerprintOfBytes(bytes)]));
};

/** ZIP の中の JSON を読み、成果物のスキーマで確かめた値を返す。 */
const schemaCheckedEntryOf = async (entries: Readonly<Record<string, Uint8Array>>, path: string, schema: Parameters<typeof validateArtifact>[0]): Promise<unknown> => {
  const bytes = entries[path];
  expect(bytes, path).toBeDefined();
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  expect(await validateArtifact(schema, value), path).toEqual({ ok: true });
  return value;
};

/**
 * 成果物の HTML を記録つきのページで開き、主な見出し（`h1`）と結果の値（バッジの `data-value`）があり、`<head>` の `<style>` が成果物の CSP の下で
 * 効く（見た目のクラスのバッジが `inline-block`）ことを確かめる。CSP の違反・console の誤り・外への要求は、各段の後の記録の確かめで 0 を確かめる。
 */
const expectArtifactHtml = async (href: string, resultValue: string): Promise<Page> => {
  const page = await flow.openPage(href);
  expect(await page.locator('h1').count()).toBeGreaterThan(0);
  const badge = page.locator(`.${REPORT_CLASS_NAMES.badge}[data-value="${resultValue}"]`).first();
  expect(await badge.count()).toBe(1);
  expect(await badge.evaluate((element) => getComputedStyle(element).display)).toBe('inline-block');
  await flow.snapshot(page);
  return page;
};

/** 候補の画面の、ある画面のある分類の候補。 */
const candidateOf = (page: Page, path: string, classification: string) =>
  page.locator(`[data-testid="discovery-page"][data-page-path="${path}"] [data-testid="discovery-candidate"][data-classification="${classification}"]`).first();

/** シナリオの form の検証の指定（成功と入力の誤りの条件、登録の ID の取り方、照合の READ）を画面で入れる。 */
const fillVerificationOnScreen = async (page: Page): Promise<void> => {
  const success = page.getByTestId('scenario-verification-successCondition');
  await success.getByLabel(writeText.conditionPathPrefix, { exact: true }).fill(VERIFICATION.successPathPrefix);
  await success.getByLabel(writeText.conditionSelector, { exact: true }).fill(VERIFICATION.successSelector);
  const inputError = page.getByTestId('scenario-verification-inputErrorCondition');
  await inputError.getByLabel(writeText.conditionPathPrefix, { exact: true }).fill(VERIFICATION.inputErrorPathPrefix);
  await inputError.getByLabel(writeText.conditionSelector, { exact: true }).fill(VERIFICATION.inputErrorSelector);
  const recordId = page.getByTestId('scenario-verification-recordId');
  await recordId.getByLabel(writeText.recordIdSource, { exact: true }).selectOption('URL_PATH_PATTERN');
  await recordId.getByLabel(writeText.recordIdValue, { exact: true }).fill(VERIFICATION.recordIdPathPattern);
  const read = page.getByTestId('scenario-verification-readVerification');
  await read.getByLabel(writeText.readVerificationCheck, { exact: true }).selectOption(state.readCheckId);
  await read.locator(`[data-testid="scenario-verification-binding"][data-parameter-name="${VERIFICATION.lookupParameter}"] select`)
    .selectOption(VERIFICATION.fieldName);
  await read.getByTestId('scenario-verification-add-expectation').click();
};

/** シナリオの form の副作用の確認をすべて入れて保存し、詳細の画面へ移る。シナリオの ID を返す。 */
const saveScenarioOnScreen = async (page: Page): Promise<string> => {
  for (const item of await page.locator('input[data-side-effect]').all()) {
    await item.check();
  }
  await page.getByTestId('scenario-save').click();
  await page.waitForURL(new RegExp(`/scenarios/${WRITE_PROFILE}/[a-z0-9-]+\\?notice=saved$`, 'u'), { timeout: UI_TIMEOUT_MS });
  await page.getByTestId('scenario-state').waitFor({ timeout: UI_TIMEOUT_MS });
  await flow.snapshot(page);
  return lastSegmentOf(page);
};

/** 入力の規則の画面で、名前の欄を人の固定の値 1 つにし、一意にする欄にして、確認のダイアログの後に保存する。 */
const saveNameRuleOnScreen = async (scenarioId: string, value: string): Promise<void> => {
  const page = await flow.openPage(`/scenarios/${WRITE_PROFILE}/${scenarioId}/rules`);
  await page.getByTestId('data-rule-form').waitFor({ timeout: UI_TIMEOUT_MS });
  await page.locator(`select[data-kind-for="${VERIFICATION.fieldName}"]`).selectOption('FIXED_LIST');
  await page.locator(`select[data-method-for="${VERIFICATION.fieldName}"]`).selectOption('FROM_FIXED_LIST');
  await page.locator(`textarea[data-fixed-for="${VERIFICATION.fieldName}"]`).fill(value);
  await page.locator(`input[data-unique="${VERIFICATION.fieldName}"]`).check();
  await page.getByTestId('data-rule-save').click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
  await dialog.getByRole('button', { name: ruleText.saveDialog.confirm, exact: true }).click();
  // DEF-137: 知らせの search は、保存した規則の集まりの版も持つ。
  await page.waitForURL(/\/rules\?notice=saved&savedRevision=[1-9]\d*$/u, { timeout: UI_TIMEOUT_MS });
  await expect.poll(() => page.getByTestId('data-rule-state').getAttribute('data-state'), { timeout: UI_TIMEOUT_MS }).toBe('DECIDED');
  await flow.snapshot(page);
};

/** 書き込みの開始の画面から、確認のダイアログの後に書き込みを始め、終わるまで待つ。ジョブの画面とジョブの値を返す。 */
const runWriteOnScreen = async (scenarioId: string): Promise<{ readonly page: Page; readonly job: JobView }> => {
  await provideWriteSiteCredentials();
  const page = await flow.openPage(`/scenarios/${WRITE_PROFILE}/${scenarioId}/write`);
  await page.getByTestId('write-start-open').waitFor({ timeout: UI_TIMEOUT_MS });
  await flow.snapshot(page);
  await page.getByTestId('write-start-open').click();
  const dialog = page.getByRole('dialog', { name: writeText.startDialog.title });
  await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
  await dialog.getByRole('button', { name: writeText.startDialog.confirm, exact: true }).click();
  await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
  const jobId = lastSegmentOf(page);
  flow.jobs.push({ jobId, profileId: WRITE_PROFILE });
  const job = await waitForJobOnScreen(page, jobId);
  await page.locator('[data-testid="write-result"]:not([data-result=""])').waitFor({ timeout: UI_TIMEOUT_MS });
  await page.locator('[data-testid="write-report"]:not([data-check=""])').waitFor({ timeout: UI_TIMEOUT_MS });
  await flow.snapshot(page);
  return { page, job };
};

/** 書き込みのジョブの Run のディレクトリ（出力先の中）。 */
const writeRunDirectoryOf = (job: JobView): string => `${flow.rootOf()}/t25e-output-${WRITE_PROFILE}/${job.runId ?? ''}`;

beforeAll(async () => {
  await flow.start();
  site = await startWriteSite();
  site.enableUpdatePages();
  state.existingId = site.addMember(EXISTING_NAME);
  writeAuthTargetConfig(flow.rootOf(), PUBLIC_PROFILE, site.origin, WRITE_SITE_PATHS.login, MAX_PAGES, NAVIGATION_INTERVAL_MS);
  writeAuthTargetConfig(flow.rootOf(), AUTH_PROFILE, site.origin, WRITE_SITE_PATHS.list, MAX_PAGES, NAVIGATION_INTERVAL_MS);
  writeAuthTargetConfig(flow.rootOf(), WRITE_PROFILE, site.origin, WRITE_SITE_PATHS.list, MAX_PAGES, NAVIGATION_INTERVAL_MS);
}, SCENARIO_TIMEOUT_MS);

afterEach(async () => {
  // 開いたページの CSP の違反・console の誤り・外への要求が 0（記録つきのページ）。
  try {
    await flow.expectCleanPages();
  } finally {
    await flow.closePages();
  }
});

afterAll(async () => {
  console.info(`[T32h] stage durations: ${state.durations.join(', ')}`);
  await flow.stop();
  await site?.close();
}, SCENARIO_TIMEOUT_MS);

describe('T32h: the whole flow on the screen only, with the real worker', () => {
  it('1. creates the three profiles and the two auth setups on the screen', async () => {
    await timed('profiles', async () => {
      await createProfileOnScreen(PUBLIC_PROFILE, `config/targets/${PUBLIC_PROFILE}.json`, null);
      await createProfileOnScreen(AUTH_PROFILE, `config/targets/${AUTH_PROFILE}.json`, { mode: 'TEST_AUTH_PASSIVE', auth: 'MANUAL_SESSION' });
      await createProfileOnScreen(WRITE_PROFILE, `config/targets/${WRITE_PROFILE}.json`, { mode: 'TEST_APPROVED_WRITE', auth: 'MANUAL_SESSION' });
      await saveAuthSetupOnScreen(AUTH_PROFILE);
      await saveAuthSetupOnScreen(WRITE_PROFILE);
    });
    const list = await flow.openPage('/');
    for (const profileId of [PUBLIC_PROFILE, AUTH_PROFILE, WRITE_PROFILE]) {
      expect(await list.locator(`tr[data-profile-id="${profileId}"]`).count(), profileId).toBe(1);
    }
  }, SCENARIO_TIMEOUT_MS);

  it('2. runs the public audit, opens report.html and downloads the audit ZIP whose JSON match the schemas and the manifest', async () => {
    const { page, jobId } = await timed('public audit', () => startAuditOnScreen(PUBLIC_PROFILE));
    const job = await timed('public audit job', () => waitForJobOnScreen(page, jobId));
    expect(job).toMatchObject({ jobKind: 'AUDIT', state: 'FINISHED' });
    expect(job.runStatus).toMatch(/^(?:COMPLETE|PARTIAL)$/u);
    const report = job.artifacts.find(({ kind }) => kind === 'REPORT');
    expect(report?.href).toBe(`/artifacts/${jobId}/${RUN_ARTIFACT_FILE_NAMES.report}`);
    await expectArtifactHtml(report?.href ?? '', job.runStatus ?? '');

    const zipPath = await downloadFrom(page, page.locator('[data-artifact="BUNDLE"]'));
    expect(isBundleFileName(zipPath.slice(zipPath.lastIndexOf('/') + 1))).toBe(true);
    const entries = unzipSync(readFileSync(zipPath));
    expect(Object.keys(entries)[0]).toBe(CHATGPT_BUNDLE_FILE_NAMES.manifest);
    expectManifestMatches(entries, CHATGPT_BUNDLE_FILE_NAMES.manifest);
    const run = await schemaCheckedEntryOf(entries, RUN_ARTIFACT_FILE_NAMES.run, 'run') as { readonly runId: string; readonly schemaVersion: string };
    expect(run).toMatchObject({ runId: job.runId, schemaVersion: 'run-schema/1.0' });
    const pageEntries = Object.keys(entries).filter((path) => path.endsWith('/page.json'));
    expect(pageEntries.length).toBeGreaterThan(0);
    for (const path of pageEntries) {
      await schemaCheckedEntryOf(entries, path, 'page');
    }
  }, SCENARIO_TIMEOUT_MS);

  it('3. runs the authenticated audit (TEST_AUTH_PASSIVE) with the manual session handed over', async () => {
    await provideWriteSiteCredentials();
    const { page, jobId } = await timed('auth audit', () => startAuditOnScreen(AUTH_PROFILE));
    const job = await timed('auth audit job', () => waitForJobOnScreen(page, jobId));
    expect(job).toMatchObject({ jobKind: 'AUDIT', state: 'FINISHED', lastAuthState: 'AUTHENTICATED' });
    expect(job.runStatus).toMatch(/^(?:COMPLETE|PARTIAL)$/u);
    expect(await page.getByTestId('job-auth-state').count()).toBe(1);
  }, SCENARIO_TIMEOUT_MS);

  it('4. discovers the candidates, saves a READ definition and runs the READ check', async () => {
    await provideWriteSiteCredentials();
    const discovery = await flow.openPage(`/discovery/${WRITE_PROFILE}`);
    await discovery.getByTestId('discovery-start').click();
    await discovery.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
    const discoveryJobId = lastSegmentOf(discovery);
    flow.jobs.push({ jobId: discoveryJobId, profileId: WRITE_PROFILE });
    expect(await timed('discovery job', () => waitForJobOnScreen(discovery, discoveryJobId))).toMatchObject({ jobKind: 'DISCOVERY', state: 'FINISHED' });

    const candidates = await flow.openPage(`/discovery/${WRITE_PROFILE}`);
    await flow.snapshot(candidates);
    expect(await candidateOf(candidates, WRITE_SITE_PATHS.form, 'CREATE').count()).toBe(1);
    expect(await candidateOf(candidates, writeSiteEditPathOf(state.existingId), 'UPDATE').count()).toBe(1);
    const digest = await candidateOf(candidates, WRITE_SITE_PATHS.list, 'READ').getAttribute('data-digest');
    expect(digest).not.toBeNull();

    const form = await flow.openPage(`/read-checks/${WRITE_PROFILE}/new?candidate=${encodeURIComponent(digest ?? '')}`);
    await form.getByTestId('read-check-form').waitFor({ timeout: UI_TIMEOUT_MS });
    await form.getByTestId('read-check-parameters').getByLabel(VERIFICATION.lookupParameter, { exact: true }).fill(EXISTING_NAME);
    const row = form.locator('[data-testid="read-check-expectation"][data-index="0"]');
    await row.getByLabel(readText.expectationKind, { exact: true }).selectOption({ label: READ_CHECK_EXPECTATION_KIND_CATALOG.ROW_COUNT_EQUALS.label });
    await row.getByLabel(readText.expectationCount, { exact: true }).fill('1');
    await form.getByTestId('read-check-save').click();
    await form.waitForURL(new RegExp(`/read-checks/${WRITE_PROFILE}\\?notice=saved$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await form.getByTestId('read-check-definition').first().waitFor({ timeout: UI_TIMEOUT_MS });
    state.readCheckId = await form.getByTestId('read-check-definition').first().getAttribute('data-read-check-id') ?? '';
    expect(state.readCheckId).not.toBe('');
    await flow.snapshot(form);

    await provideWriteSiteCredentials();
    await form.getByTestId('read-check-start').click();
    await form.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
    const readJobId = lastSegmentOf(form);
    flow.jobs.push({ jobId: readJobId, profileId: WRITE_PROFILE });
    expect(await timed('READ check job', () => waitForJobOnScreen(form, readJobId))).toMatchObject({ jobKind: 'READ_CHECK', state: 'FINISHED' });
    const results = await flow.openPage(`/read-checks/${WRITE_PROFILE}`);
    const result = results.locator(`[data-testid="read-check-result"][data-job-id="${readJobId}"][data-read-check-id="${state.readCheckId}"]`);
    await result.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await result.getAttribute('data-result')).toBe('MATCHED');
    await flow.snapshot(results);
  }, SCENARIO_TIMEOUT_MS);

  it('5. creates, rules and approves the CREATE scenario on the screen, and the CREATE ends VERIFIED', async () => {
    const page = await flow.openPage(`/discovery/${WRITE_PROFILE}`);
    await candidateOf(page, WRITE_SITE_PATHS.form, 'CREATE').getByTestId('candidate-create-scenario').click();
    await page.getByTestId('scenario-form').waitFor({ timeout: UI_TIMEOUT_MS });
    await page.locator(`[data-testid="scenario-field"][data-field-name="${VERIFICATION.fieldName}"] input[type="checkbox"]`).check();
    await fillVerificationOnScreen(page);
    state.createScenarioId = await saveScenarioOnScreen(page);
    await saveNameRuleOnScreen(state.createScenarioId, CREATED_NAME);
    await flow.approveOnScreen(WRITE_PROFILE, state.createScenarioId);

    const { page: jobPage, job } = await timed('CREATE job', () => runWriteOnScreen(state.createScenarioId));
    state.createJobId = job.jobId;
    expect(job).toMatchObject({ jobKind: 'WRITE_CREATE', state: 'FINISHED' });
    const result = jobPage.getByTestId('write-result');
    expect(await result.getAttribute('data-result')).toBe('VERIFIED');
    expect(await result.getAttribute('data-kind')).toBe('CREATE');
    state.createdId = (await jobPage.getByTestId('write-result-record-id').textContent())?.trim() ?? '';
    expect(state.createdId).not.toBe('');
    expect(state.createdId).not.toBe(String(state.existingId));
    expect(siteOf().memberOf(Number(state.createdId))).toMatchObject({ name: CREATED_NAME });
    expect(await jobPage.getByTestId('write-report').getAttribute('data-check')).toBe('VALID');
  }, SCENARIO_TIMEOUT_MS);

  it('6. creates, rules and approves the UPDATE scenario on the screen, and the UPDATE ends VERIFIED with the before and after values', async () => {
    const page = await flow.openPage(`/discovery/${WRITE_PROFILE}`);
    await candidateOf(page, writeSiteEditPathOf(state.existingId), 'UPDATE').getByTestId('candidate-create-scenario').click();
    await page.getByTestId('scenario-update').waitFor({ timeout: UI_TIMEOUT_MS });
    await page.getByTestId('scenario-update-ledger').selectOption(state.createScenarioId);
    await page.locator(`[data-testid="scenario-update-role"][data-field-name="${VERIFICATION.fieldName}"] input[type="radio"][value="CHANGE"]`).check();
    await fillVerificationOnScreen(page);
    state.updateScenarioId = await saveScenarioOnScreen(page);
    await saveNameRuleOnScreen(state.updateScenarioId, UPDATED_NAME);
    await flow.approveOnScreen(WRITE_PROFILE, state.updateScenarioId);

    const start = await flow.openPage(`/scenarios/${WRITE_PROFILE}/${state.updateScenarioId}/write`);
    await start.getByTestId('write-start-target').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await start.getByTestId('write-start-target').getAttribute('data-target')).toBe(state.createdId);

    const { page: jobPage, job } = await timed('UPDATE job', () => runWriteOnScreen(state.updateScenarioId));
    state.updateJobId = job.jobId;
    expect(job).toMatchObject({ jobKind: 'WRITE_UPDATE', state: 'FINISHED' });
    const result = jobPage.getByTestId('write-result');
    expect(await result.getAttribute('data-result')).toBe('VERIFIED');
    expect(await result.getAttribute('data-kind')).toBe('UPDATE');
    expect((await jobPage.getByTestId('write-result-target').textContent())?.trim()).toBe(state.createdId);
    const changed = jobPage.getByTestId('write-result-diff-changed');
    expect(await changed.evaluateAll((rows) => rows.map((row) => [row.getAttribute('data-field-name'), row.getAttribute('data-matched')])))
      .toEqual([[VERIFICATION.fieldName, 'true']]);
    expect(await changed.getByTestId('write-result-diff-previous').textContent()).toBe(CREATED_NAME);
    expect(await changed.getByTestId('write-result-diff-new').textContent()).toBe(UPDATED_NAME);
    expect(siteOf().memberOf(Number(state.createdId))).toMatchObject({ name: UPDATED_NAME, note: siteOf().keptMarker });
  }, SCENARIO_TIMEOUT_MS);

  it('7. shows the created record in the audited data ledger with one VERIFIED update', async () => {
    const profile = await flow.openPage(`/profiles/${WRITE_PROFILE}`);
    await profile.getByTestId('profile-open-ledger').click();
    await profile.waitForURL(new RegExp(`/ledger/${WRITE_PROFILE}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    const entry = profile.locator(`[data-testid="ledger-entry"][data-record-id="${state.createdId}"]`);
    await entry.waitFor({ timeout: UI_TIMEOUT_MS });
    expect([
      await entry.getAttribute('data-job-id'), await entry.getAttribute('data-scenario-id'), await entry.getAttribute('data-update-count'),
      await entry.getAttribute('data-last-update-result'),
    ]).toEqual([state.createJobId, state.createScenarioId, '1', 'VERIFIED']);
    expect(await profile.getByTestId('ledger-entry').count()).toBe(1);
    expect(await profile.getByTestId('ledger-note').count()).toBe(1);
    await flow.snapshot(profile);
  }, SCENARIO_TIMEOUT_MS);

  it('8. offers the VALID write reports: opens action-report.html and downloads the write ZIP whose JSON match the schemas and the manifest', async () => {
    for (const [jobId, kind] of [[state.createJobId, 'CREATE'], [state.updateJobId, 'UPDATE']] as const) {
      const job = await flow.valueOf<JobView>('getAuditJobFn', 'GET', { jobId });
      const page = await flow.openPage(`/jobs/${jobId}`);
      const report = page.getByTestId('write-report');
      await report.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await report.getAttribute('data-check'), kind).toBe('VALID');
      const href = await page.getByTestId('write-report-open').getAttribute('href');
      expect(href).toBe(`/artifacts/${jobId}/${ACTION_REPORT_ARTIFACT_FILE_NAME}`);
      const html = await expectArtifactHtml(href ?? '', 'VERIFIED');
      expect(await html.locator('code', { hasText: state.createdId }).count()).toBeGreaterThan(0);

      const zipPath = await downloadFrom(page, page.getByTestId('write-report-download'));
      expect(isActionBundleFileName(zipPath.slice(zipPath.lastIndexOf('/') + 1))).toBe(true);
      const entries = unzipSync(readFileSync(zipPath));
      expect(Object.keys(entries)).toEqual([
        ACTION_BUNDLE_MANIFEST_FILE_NAME, ACTION_RUN_ARTIFACT_FILE_NAME, ACTION_EVIDENCE_ARTIFACT_FILE_NAME, APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
        ACTION_REPORT_ARTIFACT_FILE_NAME,
      ]);
      expectManifestMatches(entries, ACTION_BUNDLE_MANIFEST_FILE_NAME);
      const actionRun = await schemaCheckedEntryOf(entries, ACTION_RUN_ARTIFACT_FILE_NAME, 'action-run') as ActionRunDocument;
      // T40c: 書き手は版 1.1（送り方 FORM、API の要約なし）を書く。
      expect(actionRun).toMatchObject({
        schemaVersion: ACTION_RUN_SCHEMA_VERSION, transport: 'FORM', api: null, jobId, result: 'VERIFIED', recordId: state.createdId,
      });
      await schemaCheckedEntryOf(entries, ACTION_EVIDENCE_ARTIFACT_FILE_NAME, 'action-evidence');
      await schemaCheckedEntryOf(entries, APPROVAL_SUMMARY_ARTIFACT_FILE_NAME, 'approval-summary');
      // 落とした ZIP は、Run のディレクトリのバンドルと同じバイト列で、Run のディレクトリの報告の確かめ（スキーマ・`action-run.json` との一致・目印）も通る。
      const runDirectory = writeRunDirectoryOf(job);
      expect(readFileSync(zipPath).equals(readFileSync(artifactFilePath(runDirectory, zipPath.slice(zipPath.lastIndexOf('/') + 1))))).toBe(true);
      await readWriteReportFiles(runDirectory, actionRun, { markers: siteOf().secretValues() });
    }
  }, SCENARIO_TIMEOUT_MS);

  it('9. received only the login POSTs and one CREATE and one UPDATE POST, and no marker or value leaks', async () => {
    const expected = [
      // 認証つきの監査・発見・READ の確かめ・CREATE・UPDATE の、ジョブごとのログイン（手動のセッションの引き継ぎ）。公開の監査はログインしない。
      `POST ${WRITE_SITE_PATHS.login}`,
      `POST ${WRITE_SITE_PATHS.login}`,
      `POST ${WRITE_SITE_PATHS.login}`,
      `POST ${WRITE_SITE_PATHS.login}`,
      `POST ${WRITE_SITE_PATHS.create}`,
      `POST ${WRITE_SITE_PATHS.login}`,
      `POST ${writeSiteRecordPathOf(state.createdId)}`,
    ];
    expect(nonReadRequestsOf(siteOf().requests)).toEqual(expected);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReadRequestsOf(siteOf().requests)).toEqual(expected);
    expect(siteOf().members).toBe(2);
    expect(siteOf().successfulLogins).toBe(5);

    const places = await timed('marker search', () => flow.expectNoSecretMarker('full-flow'));
    // 検索した場所に、落とした 2 つの ZIP の中身と、成果物の画面（2 つの HTML）が入っている。
    const names = places.map(({ place }) => place);
    expect(state.downloads).toHaveLength(3);
    for (const path of state.downloads) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      expect(names.some((place) => place.startsWith(`root:${DOWNLOAD_DIRECTORY_NAME}/${name}!`)), name).toBe(true);
    }
    expect(names.some((place) => place.endsWith(`/${ACTION_REPORT_ARTIFACT_FILE_NAME}`) && place.startsWith('html:'))).toBe(true);
    // 送った値と人の値（CREATE の名前は UPDATE の前の値）は、出力先と落としたファイルの中では、決まった成果物だけにある。
    const valuePlaces = places
      .filter(({ place }) => place.startsWith('root:t25e-output-') || place.startsWith(`root:${DOWNLOAD_DIRECTORY_NAME}/`))
      .filter(({ bytes }) => [CREATED_NAME, UPDATED_NAME].some((value) => Buffer.from(bytes).toString('utf8').includes(value)))
      .map(({ place }) => place);
    expect(valuePlaces.length).toBeGreaterThan(0);
    expect(valuePlaces.filter((place) => !isWriteValueArtifactPlace(place))).toEqual([]);
    // 落とした監査の ZIP（公開の監査）には、書き込みの値がない。
    expect(readdirSync(`${flow.rootOf()}/${DOWNLOAD_DIRECTORY_NAME}`).filter((name) => isBundleFileName(name))).toHaveLength(1);
  }, SCENARIO_TIMEOUT_MS);
});

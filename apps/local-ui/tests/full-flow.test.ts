/**
 * 画面だけで全段を通す E2E（T32h。Task 32 の設計書 4.2）。ビルドした画面を一時の root の起動の部品で起動し（`helpers/scenario-marker-flow.ts` の
 * 作り。記録つきのページ）、headless の Chromium の画面の操作（クリックと入力）だけで、127.0.0.1 の書き込みの fixture
 * （`tests/helpers/write-site-fixture.ts`）に対して、次の段を順に通す。ワーカーは本物（CLI の起動の設定の Chromium）。手動のログインだけは、テスト
 * だけの入口が受け渡しのサーバから資格情報を受けて入れる（人の操作の代わり。`helpers/auth-worker.ts`）。
 * 1. プロファイルの作成（公開の監査と、認証つきの読み取りの監査（手動のログイン）の 2 つ）。認証つきのプロファイルは「保存して入口を確かめる」で、
 *    入口の確かめの後に BeakSight が認証の設定を案で保存する（自動保存。認証の設定の画面は開かない）。
 * 2. 公開の監査（PUBLIC_PASSIVE）→ `report.html` を開き、監査の ZIP を落とす。
 * 3. 認証つきの監査（TEST_AUTH_PASSIVE。手動のログイン。このサイトのログインはフォームの送信なので、自動の登録で足すものはない）。
 * 4. OP-2 の修正の 1 回目（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'）: サイトの画面の「登録・更新を試せる画面」の一覧で、登録の画面に
 *    チェックする（ボタンもダイアログもない）。チェックの保存が、書き込みのモード（TEST_APPROVED_WRITE）への切り替え・登録と更新（規則 F）の下書き・承認を
 *    1 回で行う。
 * 5. 切り替えの前の候補（3 のまとめて実行の操作さがし）をそのまま使う（PL-U の U5。操作さがしをやり直さない）→ READ の定義と確かめ。
 * 6. 次の点検（まとめて実行。ログインは 1 回）の最後に、チェックした画面で登録 → 更新（どちらも `VERIFIED`）。点検が終わると、作業の画面からサイトの画面へ自動で
 *    移り、行に結果が出る。人が押すのは、チェック・点検を始める・始めるの確定の 3 だけ（入力は 0）。
 * 7. 登録と更新の作業の画面の結果（番号、前後の差分）。
 * 8. 監査済みデータの台帳（CREATE の ID の行が UPDATE 1 回・`VERIFIED`）。
 * 9. 書き込みの報告（`data-check="VALID"`、`action-report.html` を開く、書き込みの ZIP を落とす）。
 * MI-F2（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.1、6 章の受け入れ条件 5。独立レビュー MI-R の I-3。前は書き込みのモードのプロファイルを
 * 詳しい設定で別に作り、認証の設定の画面で保存していた流れを、4.1 の流れに直した）: 書き込みは、認証つきの読み取りのプロファイルと同じプロファイルで行い、
 * 別のプロファイルを作らない。全部の段で、ブラウザが移った先を記録し、認証の設定の画面（`/auth-setup/`）を一度も開かないことを確かめる。
 * 確かめること: 落とした 2 つの ZIP の中の JSON がスキーマに合い、目録の sha256 が中身と一致する。2 つの HTML が本物のブラウザで開き、主な見出しと
 * 結果の値があり、CSP の違反・console の誤り・外への要求が 0（ページの記録の補助）。サイトに届いた読み取りでない要求は、ログインの POST（認証の
 * ジョブごとに 1 回）と、書き込みの POST の CREATE 1・UPDATE 1 だけ（全部の後に 2 秒待って数え直す）。秘密の目印（資格情報・セッション・CSRF・
 * hidden・readonly・保つ欄の値）は、画面・Server Function の応答・管理データ（WAL を含む）・成果物（ZIP の中身を含む）に出ない。送った値と人の値は、
 * 出力先と落としたファイルの中では決まった成果物（`isWriteValueArtifactPlace`）だけにある。
 * Server Function を直接呼ぶのは、確かめ（ジョブの状態と、画面と同じ値を読むだけ）のためだけ。操作（保存・切り替え・承認・開始）は、すべて画面の操作で行う。
 * 目印の値は出力しない。
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
import { WORKER_ENTRY_CHECK_JOB_KIND } from '../../../src/control/worker-protocol.js';
import { validateArtifact } from '../../../src/core/schema-validator.js';
import { READ_CHECK_EXPECTATION_KIND_CATALOG } from '../../../src/presentation/catalog.js';
import {
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_NEXT_STEP_TEXT,
  LOCAL_UI_READ_CHECK_TEXT,
  LOCAL_UI_WRITE_SCREENS_TEXT,
} from '../../../src/presentation/messages.js';
import { axeViolationsOf, expectAtMostOnePrimaryButton } from './helpers/screen-shape.ts';
import { ACTION_BUNDLE_MANIFEST_FILE_NAME } from '../../../src/report/action-bundle.js';
import { CHATGPT_BUNDLE_FILE_NAMES } from '../../../src/report/chatgpt-bundle.js';
import { REPORT_CLASS_NAMES } from '../../../src/report/html-tokens.js';
import { nonReadRequestsOf } from '../../../tests/helpers/leak-places.js';
import { isWriteValueArtifactPlace, readWriteReportFiles } from '../../../tests/helpers/write-report-checks.js';
import { WRITE_SITE_LOGIN_FIELDS, WRITE_SITE_PATHS, startWriteSite, writeSiteEditPathOf, writeSiteRecordPathOf, type WriteSite } from '../../../tests/helpers/write-site-fixture.js';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
import { openAdvancedSettings } from './helpers/advanced-settings.ts';
import { createProfileOnScreen, openProfileAdvancedSettings } from './helpers/profile-form.ts';
import { JOB_TIMEOUT_MS, SCENARIO_TIMEOUT_MS, UI_TIMEOUT_MS, createScenarioMarkerFlow, type JobDetail } from './helpers/scenario-marker-flow.ts';
import { waitForNoActiveJobViaServerFunctions, type ServerFunctionJobRow } from './helpers/server-function-job-wait.ts';

/**
 * PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 6 章の 1）: 作成の画面に名前の欄はなく、名前は開始のアドレスのホスト名から決まる（同じ名前があれば
 * `-2` を付ける）。fixture のサイトは 127.0.0.1 で待ち受け、公開の画面だけのプロファイルを先に作るので、名前はこの 2 つになる（設定のファイルの名前もそろえる）。
 */
const PUBLIC_PROFILE = '127-0-0-1';
const AUTH_PROFILE = '127-0-0-1-2';
/** OP-2 の修正の 1 回目（判断 2）: 一覧の行の名前（fixture の登録の画面の見出し。操作さがしが記録する）。 */
const CREATE_SCREEN_NAME = '会員の登録';
/** MI-F2: 書き込みは、認証つきの読み取りのプロファイルを、一覧のチェックの保存で書き込みのモードにした、同じプロファイルで行う（別に作らない）。 */
const WRITE_PROFILE = AUTH_PROFILE;
/** MI-F2: 認証の設定の画面のパスの頭（この流れでは一度も開かない）。 */
const AUTH_SETUP_SCREEN_PREFIX = '/auth-setup/';

/** fixture のサイトの、BeakSight が登録していない会員（発見のジョブが更新の画面を見つけるため。テストの準備）。 */
const EXISTING_NAME = '既存花子';
/** 巡回の上限と、読み込みの最小の間隔（ms。ループバックの fixture）。 */
const MAX_PAGES = 20;
const NAVIGATION_INTERVAL_MS = 0;
/** 全部の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 2_000;
/** PL-3: まとめて実行の残りの段の終わりを読み直す間隔（ms。画面のサーバの管理データを読むだけ）。 */
const CHAIN_POLL_MS = 250;
/** 落としたファイルを置く、一時の root の中のフォルダ（目印の検査の対象に入る）。 */
const DOWNLOAD_DIRECTORY_NAME = 't32h-downloads';
/**
 * 書き込みの検証の指定（ID は URL のパスの型、照合は一覧の検索）。値ではなく構造だけ。PL-6b: どれも BeakSight が発見の候補から決める（人は入れない）。ID の型は、
 * 書き換えの候補の送信先の型と画面の型の 2 つ。
 */
const VERIFICATION = Object.freeze({
  recordIdPathPatterns: [`${WRITE_SITE_PATHS.create}/{id}`, `${WRITE_SITE_PATHS.create}/{id}/edit`],
  lookupParameter: 'q',
  fieldName: 'name',
});

const auditText = LOCAL_UI_AUDIT_TEXT;
const readText = LOCAL_UI_READ_CHECK_TEXT;

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
  /** PL-6b: 入れる値の決まりは BeakSight が推して付けるので、作った名前と書き換えた名前は、サイトの記録から読む（値は出力しない）。 */
  createdName: '',
  updatedName: '',
  downloads: [] as string[],
  durations: [] as string[],
  /** MI-F2: ブラウザの main frame が移った先（開いたパスと、その後の移動。全部の段）。 */
  visitedPaths: [] as string[],
};

const flow = createScenarioMarkerFlow({
  label: 't32h',
  profileIds: () => [AUTH_PROFILE],
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

/**
 * MI-F2: 記録つきのページを開き、開いたパスと、その後に main frame が移った先を `state.visitedPaths` に記録する（認証の設定の画面を開かないことの確かめ）。
 * この流れのページは、すべてここから開く。
 */
const openTrackedPage = async (path: string): Promise<Page> => {
  const page = await flow.openPage(path);
  state.visitedPaths.push(new URL(page.url()).pathname);
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      state.visitedPaths.push(new URL(frame.url()).pathname);
    }
  });
  return page;
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
/** PL-5: 操作さがしから結果までの押下の数（人の入力なしに通ることの確かめ）。 */
const presses = { count: 0 };

const lastSegmentOf = (page: Page): string => new URL(page.url()).pathname.split('/').at(-1) ?? '';

/**
 * 画面の新しいプロファイルの form で登録する。`test` が真なら「ログインして読む（テスト環境）」で、監査モード・認証の方式・テスト環境の Origin は、使い方と
 * 設定のファイルから決まる既定のまま（MI-F2: 前は詳しい設定で監査モードと認証の方式を選び、テスト環境の Origin を入れていた）。
 * PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 6 章の 1）: 見える入力は開始のアドレス・使い方・保存だけ（前は、隔離の扱いの「確かめた記録がある」と
 * 参照、たたんだ詳しい設定の名前と設定のファイルを入れていた）。開始のアドレスが同じ設定のファイルが 1 つあれば、それを使う。名前は開始のアドレスから決まり
 * （`profileId` と同じになることを確かめる）、確かめた記録の参照は、保存した日の未確認の形になる。
 */
const registerProfileOnScreen = async (profileId: string, startUrl: string, test: boolean): Promise<void> => {
  // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D1・D11、4.1.3 の 3）: テスト環境のプロファイルは「点検を始める」1 つで、下調べ → 点検（まとめて
  // 実行。手でのログイン）へ自動で進む。人の代わりに、テスト対象のログインの画面で ID とパスワードを入れる値を、先に受け渡しのサーバへ渡す。
  if (test) {
    await provideWriteSiteCredentials();
  }
  const page = await openTrackedPage('/profiles/new');
  await createProfileOnScreen(page, { startUrl, usage: test ? 'TEST_AUTH' : 'PUBLIC' }, UI_TIMEOUT_MS);
  if (test) {
    // MI-2（同 4.2）: テスト環境のプロファイルは、保存に続けて下調べを 1 回始め、ジョブの画面へ移る（ログインしない GET だけ）。終わるまで待つ。
    await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
    const entryJobId = lastSegmentOf(page);
    expect(await flow.waitForJobEnd(entryJobId)).toMatchObject({ jobKind: WORKER_ENTRY_CHECK_JOB_KIND, state: 'FINISHED' });
    // OP-1: 見ていた下調べの後に、ジョブの管理が続けて点検を始め、作業の画面がその点検の作業へ移る。
    await page.waitForURL((url) => url.pathname.startsWith('/jobs/') && !url.pathname.endsWith(entryJobId), { timeout: JOB_TIMEOUT_MS });
    // MI-3（同 4.3、受け入れ条件 2）: 下調べがログインの画面を見つけたので、BeakSight が認証の設定を案で保存した。下調べのジョブの画面は、認証の設定の画面への
    // リンクを出さない。
    const entryJob = await openTrackedPage(`/jobs/${entryJobId}`);
    await entryJob.locator('[data-testid="job-result"][data-result="ENTRY_CHECK_LOGIN_PAGE"]').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await entryJob.locator(`a[href^="${AUTH_SETUP_SCREEN_PREFIX}"]`).count()).toBe(0);
    // まとめて実行（点検 → 操作さがし → 見るだけの確かめ）が終わるまで待つ。
    await timed('first chain', () => waitForNoActiveJob(profileId));
    for (const job of (await flow.valueOf<readonly (ServerFunctionJobRow & { readonly jobId: string })[]>('listAuditJobsFn', 'GET')).filter((row) => row.profileId === profileId)) {
      flow.jobs.push({ jobId: job.jobId, profileId });
    }
  } else {
    // OP-1 修正の 2 回目（設計書 4.1.3 の 3。設計者の判断「公開のサイトも点検を始める 1 つ」。前は、保存だけでサイトの画面へ移り、保存の知らせを出した）: ログイン
    // しなくても見られるサイトも、保存に続けて下調べを 1 回始め、ジョブの管理が続けて単独の点検を始める。終わるまで待つ（次のサイトの作成の作業を始められるように）。
    await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
    const entryJobId = lastSegmentOf(page);
    expect(await flow.waitForJobEnd(entryJobId)).toMatchObject({ jobKind: WORKER_ENTRY_CHECK_JOB_KIND, state: 'FINISHED' });
    await timed('public first audit', () => waitForNoActiveJob(profileId));
    // 名前は開始のアドレスから決まり（作業の記録のサイトの名前が `profileId`）、作業は下調べと、続けて始めた単独の点検の 2 つ。
    const rows = (await flow.valueOf<readonly (ServerFunctionJobRow & { readonly jobId: string; readonly jobKind: string })[]>('listAuditJobsFn', 'GET'))
      .filter((row) => row.profileId === profileId);
    expect(rows.map((row) => row.jobKind).sort()).toEqual(['AUDIT', WORKER_ENTRY_CHECK_JOB_KIND]);
    expect(rows.some((row) => row.jobId === entryJobId)).toBe(true);
    for (const job of rows) {
      flow.jobs.push({ jobId: job.jobId, profileId });
    }
  }
  await flow.snapshot(page);
};

/** 開始の画面から監査を新しく始め、ジョブの画面へ移る。ジョブの ID を返す。 */
const startAuditOnScreen = async (profileId: string): Promise<{ readonly page: Page; readonly jobId: string }> => {
  // PL-1（設計書 3 章、4 章の 1）: 一覧の行は「続ける」1 つ。サイトの画面の要点のパネルの「点検を始める」から開始の画面へ。
  const list = await openTrackedPage('/');
  await list.locator(`tr[data-profile-id="${profileId}"]`).getByRole('link', { name: LOCAL_UI_NEXT_STEP_TEXT.continue }).click();
  await list.waitForURL(new RegExp(`/profiles/${profileId}$`, 'u'), { timeout: UI_TIMEOUT_MS });
  await list.getByTestId('profile-summary').getByRole('link', { name: auditText.profileList.startAudit }).click();
  await list.waitForURL(new RegExp(`/start/${profileId}$`, 'u'), { timeout: UI_TIMEOUT_MS });
  await list.getByTestId('start-summary').waitFor({ timeout: UI_TIMEOUT_MS });
  await flow.snapshot(list);
  // PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 4 章の 4）: 始め方の選択は、前回の点検が最後まで終わらなかったときだけ、詳しい内容に出る。
  if (await list.locator('input[name="start-mode"]').count() > 0) {
    await openAdvancedSettings(list, 'start-advanced-settings', UI_TIMEOUT_MS);
    await list.getByRole('radio', { name: auditText.start.startNew }).check();
  }
  await list.getByRole('button', { name: auditText.start.submit }).click();
  await list.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
  const jobId = lastSegmentOf(list);
  flow.jobs.push({ jobId, profileId });
  return { page: list, jobId };
};

/** PL-3: まとめて実行のすべての段が終わるまで待つ（このプロファイルの、終わっていないジョブがなくなるまで）。 */
const waitForNoActiveJob = (profileId: string): Promise<void> => waitForNoActiveJobViaServerFunctions(
  () => flow.valueOf<readonly ServerFunctionJobRow[]>('listAuditJobsFn', 'GET'),
  profileId,
  { limitMs: JOB_TIMEOUT_MS, stepMs: CHAIN_POLL_MS },
);

/** ジョブの終わりを待ち、ジョブの画面が終わりの状態を出すまで待つ。ジョブの値を返す。 */
const waitForJobOnScreen = async (page: Page, jobId: string): Promise<JobView> => {
  const job = await flow.waitForJobEnd(jobId) as JobView;
  // PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 5）: 見ていた作業が成功で終わると、次の画面へ自動で移る。終わった作業の画面を開き直して
  // から確かめる（開き直した画面は移らない）。
  await page.goto(new URL(`/jobs/${jobId}`, page.url()).href);
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
  const page = await openTrackedPage(href);
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

/** 書き込みのジョブの Run のディレクトリ（出力先の中）。 */
const writeRunDirectoryOf = (job: JobView): string => `${flow.rootOf()}/t25e-output-${WRITE_PROFILE}/${job.runId ?? ''}`;

beforeAll(async () => {
  await flow.start();
  site = await startWriteSite();
  site.enableUpdatePages();
  state.existingId = site.addMember(EXISTING_NAME);
  writeAuthTargetConfig(flow.rootOf(), PUBLIC_PROFILE, site.origin, WRITE_SITE_PATHS.login, MAX_PAGES, NAVIGATION_INTERVAL_MS);
  writeAuthTargetConfig(flow.rootOf(), AUTH_PROFILE, site.origin, WRITE_SITE_PATHS.list, MAX_PAGES, NAVIGATION_INTERVAL_MS);
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
  it('1. creates the two profiles on the screen, and BeakSight saves the auth setup after the entry check', async () => {
    await timed('profiles', async () => {
      await registerProfileOnScreen(PUBLIC_PROFILE, `${siteOf().origin}${WRITE_SITE_PATHS.login}`, false);
      await registerProfileOnScreen(AUTH_PROFILE, `${siteOf().origin}${WRITE_SITE_PATHS.list}`, true);
    });
    const list = await openTrackedPage('/');
    for (const profileId of [PUBLIC_PROFILE, AUTH_PROFILE]) {
      expect(await list.locator(`tr[data-profile-id="${profileId}"]`).count(), profileId).toBe(1);
    }
    expect(await list.locator('tr[data-profile-id]').count()).toBe(2);
    // 認証つきの読み取りのプロファイル。テスト環境の Origin は、設定のファイルの許可 Origin を写した値。OP-1（4.1.3 の 1）: 1 回目の点検の手でのログインの値を
    // BeakSight が受け取り、ログインの直後の 1 回の保存で、自動ログインへ切り替えた（改訂 2）。
    const profile = await flow.valueOf<{ profile: Record<string, unknown> }>('getProfileFn', 'GET', { profileId: AUTH_PROFILE });
    expect(profile.profile).toMatchObject({
      revision: 2, mode: 'TEST_AUTH_PASSIVE', auth: 'AUTOMATED_LOGIN', approvedTestOrigins: [siteOf().origin], targetConfigPath: `config/targets/${AUTH_PROFILE}.json`,
    });
    // PL-1（設計書 6 章の 1）: 隔離の扱いは作成で聞かず、保存した日の未確認の参照をサーバが作る（確かめた記録の参照は「書き込みも試す」の確認で選ぶ。PL-5）。
    expect(profile.profile['environmentEvidenceRef']).toMatch(/^isolation-unverified-\d{8}$/u);
    // MI-3: 認証の設定は、入口の確かめの案で BeakSight が保存した（ログインの画面と、その送信先。読む範囲は開始の URL の path）。
    const setup = await flow.valueOf<{ stored: { freshness: string; setup: Record<string, unknown> } | null }>('getAuthSetupFn', 'GET', { profileId: AUTH_PROFILE });
    expect(setup.stored?.freshness).toBe('CURRENT');
    expect(setup.stored?.setup).toMatchObject({
      profileRevision: 2,
      loginStartUrl: `${siteOf().origin}${WRITE_SITE_PATHS.login}`,
      loginPostEndpoints: [{ origin: siteOf().origin, path: WRITE_SITE_PATHS.login }],
      auditPathPrefixes: [WRITE_SITE_PATHS.list],
      maxLoginAttempts: 1,
    });
    expect((setup.stored?.setup as { automatedLogin: unknown } | undefined)?.automatedLogin).not.toBeNull();
  }, SCENARIO_TIMEOUT_MS);

  it('2. runs the public audit, opens report.html and downloads the audit ZIP whose JSON match the schemas and the manifest', async () => {
    const { page, jobId } = await timed('public audit', () => startAuditOnScreen(PUBLIC_PROFILE));
    const job = await timed('public audit job', () => waitForJobOnScreen(page, jobId));
    expect(job).toMatchObject({ jobKind: 'AUDIT', state: 'FINISHED' });
    expect(job.runStatus).toMatch(/^(?:COMPLETE|PARTIAL)$/u);
    const report = job.artifacts.find(({ kind }) => kind === 'REPORT');
    expect(report?.href).toBe(`/artifacts/${jobId}/${RUN_ARTIFACT_FILE_NAMES.report}`);
    await expectArtifactHtml(report?.href ?? '', job.runStatus ?? '');

    // PL-2（13 章の 13）: ChatGPT 用のファイル（ZIP）は、たたんだ詳しい内容の中。
    await openAdvancedSettings(page, 'job-details', UI_TIMEOUT_MS);
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

  // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D1・D4・D5）: 1 回目の点検（1 の作成の「点検を始める」で始まった）の手でのログインの後に、
  // 自動ログインへ切り替わった（1 回目の作業に、切り替えた 1 行が出る）。この通しでは、この後に読み取りと書き込みの作業を続けて行い、自動ログインは続けて行えない
  // 決まりがあるので、サイトの設定（詳しい内容）の「毎回手でログインする」を入れてから、2 回目の点検を行う（ID とパスワードはテスト対象のログインの画面でだけ入れる。
  // 2 回目の点検を押すだけで自動ログインすることは、`automated-login-setup-ui.test.ts` と `tests/integration/login-registration-fork.test.ts`）。
  it('3. switched to the automated login after the first manual login; logs in by hand every time, then runs the second authenticated audit', async () => {
    const firstAudit = (await flow.valueOf<readonly (ServerFunctionJobRow & { readonly jobId: string; readonly jobKind: string })[]>('listAuditJobsFn', 'GET'))
      .filter((row) => row.profileId === AUTH_PROFILE && row.jobKind === 'AUDIT').at(-1);
    const first = await openTrackedPage(`/jobs/${firstAudit?.jobId ?? ''}`);
    expect(await first.getByTestId('job-automated-login-switch').getAttribute('data-result')).toBe('SWITCHED');
    // OP-1（設計書 4.1 の D5、4.1.3 の 2）: 書き込みの作業は続けて行うので、サイトの設定（詳しい内容）の「毎回手でログインする」を入れる（自動ログインは続けて
    // 行えない決まりがあるため。保存しても、ログインの設定は古くならない）。
    const settings = await openTrackedPage(`/profiles/${AUTH_PROFILE}`);
    await openProfileAdvancedSettings(settings, UI_TIMEOUT_MS);
    const toggle = settings.getByTestId('profile-manual-login-every-time');
    await toggle.check();
    await toggle.locator('xpath=ancestor::form').locator('button[type="submit"]').click();
    await expect.poll(async () => (await flow.valueOf<{ profile: { revision: number; loginPreference?: string } }>('getProfileFn', 'GET', { profileId: AUTH_PROFILE })).profile,
      { timeout: UI_TIMEOUT_MS }).toMatchObject({ revision: 3, loginPreference: 'MANUAL_EVERY_TIME' });
    expect(await flow.valueOf('getAuthSetupFn', 'GET', { profileId: AUTH_PROFILE })).toMatchObject({ stored: { freshness: 'CURRENT', setup: { profileRevision: 3 } } });
    await provideWriteSiteCredentials();
    const { page, jobId } = await timed('auth audit', () => startAuditOnScreen(AUTH_PROFILE));
    // PL-U（設計書 14.1 の U6）: 順を固定する。自動の登録（入口の確かめの後に BeakSight が案で保存した認証の設定）が先で、まとめて実行の点検のステップは、
    // その保存の後に、その設定が結びつく改訂で始まる。
    const setupBeforeChain = await flow.valueOf<{ stored: { updatedAt: string; freshness: string; setup: { profileRevision: number } } | null }>(
      'getAuthSetupFn', 'GET', { profileId: AUTH_PROFILE },
    );
    const chainAudit = await flow.valueOf<{ createdAt: string; profileRevision: number; stageChain: { profileRevision: number } | null }>(
      'getAuditJobFn', 'GET', { jobId },
    );
    expect(setupBeforeChain.stored?.freshness).toBe('CURRENT');
    expect(Date.parse(setupBeforeChain.stored?.updatedAt ?? '')).toBeLessThanOrEqual(Date.parse(chainAudit.createdAt));
    expect(chainAudit.stageChain?.profileRevision).toBe(setupBeforeChain.stored?.setup.profileRevision);
    expect(chainAudit.profileRevision).toBe(setupBeforeChain.stored?.setup.profileRevision);
    // PL-3（設計書 2 章の判断 3）: 主のボタン「点検を始める」は、まとめて実行を始めた（点検 → 操作さがし → 見るだけの確かめ。ログインは最初の 1 回だけ）。残りの
    // ステップが終わるまで待ってから（見るだけの確かめの定義はまだないので、行わずに終える）、点検のステップの作業の画面を開き直して確かめる。
    await flow.waitForJobEnd(jobId);
    const chain = await flow.valueOf<{ stageChain: { stages: readonly { kind: string }[] } | null }>('getAuditJobFn', 'GET', { jobId });
    expect(chain.stageChain?.stages.map((stage) => stage.kind)).toEqual(['AUDIT', 'DISCOVERY', 'READ_CHECK']);
    await timed('auth chain', () => waitForNoActiveJob(AUTH_PROFILE));
    const job = await timed('auth audit job', () => waitForJobOnScreen(page, jobId));
    expect(job).toMatchObject({ jobKind: 'AUDIT', state: 'FINISHED', lastAuthState: 'AUTHENTICATED' });
    expect(job.runStatus).toMatch(/^(?:COMPLETE|PARTIAL)$/u);
    expect(await page.getByTestId('job-auth-state').count()).toBe(1);
    // 毎回手でログインする: 自動ログインは使わず、手でログインした（自動ログインのプロファイルなので、手でのログインの登録も受け取りもしない）。改訂は進まない。
    const detail = await flow.valueOf<{ autoLogin: { result: string } | null; loginStage: { autoRegistration?: unknown } | null }>('getAuditJobFn', 'GET', { jobId });
    expect(detail.autoLogin).toBeNull();
    expect(detail.loginStage?.autoRegistration).toBeUndefined();
    expect((await flow.valueOf<{ profile: { revision: number } }>('getProfileFn', 'GET', { profileId: AUTH_PROFILE })).profile.revision).toBe(3);
  }, SCENARIO_TIMEOUT_MS);

  // OP-2 の修正の 1 回目（指示書の 7。設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'、4.1.2 の「チェックの保存」）: 書き込みは、サイトの画面の
  // 「登録・更新を試せる画面」の一覧でチェックするだけ（ボタンもダイアログもない）。チェックの保存が、書き込みのモードへの切り替え・下書き・承認を 1 回で行う。
  // 前は、Server Function で書き込みのモードに切り替え、操作さがしの画面・書き込みの手順・OK・開始の画面を順に押していた。
  it('4. checks the screen on the list of the site screen, which switches the profile to writes and approves its create and update at once', async () => {
    const page = await openTrackedPage(`/profiles/${AUTH_PROFILE}`);
    const summary = page.getByTestId('profile-summary');
    await summary.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await summary.getAttribute('data-stage')).toBe('AUDIT_AGAIN');
    expect(await page.locator('main [data-action="WRITE_MODE_SWITCH"]').count()).toBe(0);
    const list = page.getByTestId('write-screens');
    expect(await list.getByTestId('write-screens-intro').textContent()).toBe(LOCAL_UI_WRITE_SCREENS_TEXT.intro);
    // 行の名前は、操作さがしで記録した画面の見出し（アドレスは出さない）。メールの欄があるので、その 1 行を出す。
    const row = list.locator('[data-testid="write-screen-row"]').filter({ hasText: CREATE_SCREEN_NAME });
    expect(await row.count()).toBe(1);
    expect(await row.getAttribute('data-state')).toBe('CHECKABLE');
    expect(await row.getByTestId('write-screen-may-notify').textContent()).toBe(LOCAL_UI_WRITE_SCREENS_TEXT.mayNotify);
    expect((await list.textContent()) ?? '').not.toContain(WRITE_SITE_PATHS.form);
    await expectAtMostOnePrimaryButton(page);
    expect(await axeViolationsOf(page)).toEqual([]);
    await flow.snapshot(page);
    presses.count = 1;
    await row.getByTestId('write-screen-check').click();
    await expect.poll(() => row.getAttribute('data-state'), { timeout: SCENARIO_TIMEOUT_MS }).toBe('CHECKED');
    expect(await row.getByTestId('write-screen-rejection').count()).toBe(0);
    expect(await page.getByRole('dialog').count()).toBe(0);
    expect(await page.getByTestId('profile-isolation-unverified').count()).toBe(0);
    await expectAtMostOnePrimaryButton(page);
    expect(await axeViolationsOf(page)).toEqual([]);
    await flow.snapshot(page);
    // 同じプロファイルが、書き込みのモードの次の改訂になった（隔離の参照は内部の固定の値。D6）。認証の設定は、次の改訂に結びつけ直した（古いにならない）。
    const written = (await flow.valueOf<{ profile: Record<string, unknown> }>('getProfileFn', 'GET', { profileId: WRITE_PROFILE })).profile;
    expect(written).toMatchObject({ revision: 4, mode: 'TEST_APPROVED_WRITE', auth: 'AUTOMATED_LOGIN', loginPreference: 'MANUAL_EVERY_TIME' });
    expect(written['environmentEvidenceRef']).toMatch(/^isolation-unverified-\d{8}$/u);
    expect(await flow.valueOf('getAuthSetupFn', 'GET', { profileId: WRITE_PROFILE }))
      .toMatchObject({ stored: { freshness: 'CURRENT', setup: { profileRevision: 4 } } });
    // チェックの保存が作った登録と、その台帳に結ぶ更新の書き込みの手順（規則 F で変える欄を決めた）は、どちらも承認した。副作用の確認は、チェックで兼ねた。
    const scenarios = await flow.valueOf<{ scenarios: readonly { scenarioId: string; kind: string }[] }>('scenarioListPageFn', 'GET', { profileId: WRITE_PROFILE });
    state.createScenarioId = scenarios.scenarios.find(({ kind }) => kind === 'CREATE')?.scenarioId ?? '';
    state.updateScenarioId = scenarios.scenarios.find(({ kind }) => kind === 'UPDATE')?.scenarioId ?? '';
    expect(scenarios.scenarios).toHaveLength(2);
    for (const scenarioId of [state.createScenarioId, state.updateScenarioId]) {
      const detail = await flow.valueOf<{ scenario: { state: string; sideEffectConfirmations: Readonly<Record<string, boolean>> } }>(
        'scenarioDetailPageFn', 'GET', { scenarioId },
      );
      expect(detail.scenario.state, scenarioId).toBe('APPROVED');
      expect(Object.values(detail.scenario.sideEffectConfirmations)).toEqual([true, true, true, true]);
    }
    const drafted = await flow.valueOf<{ scenario: { fieldNames: readonly string[]; inputRuleReference: unknown; verification: Record<string, unknown> } }>(
      'scenarioDetailPageFn', 'GET', { scenarioId: state.createScenarioId },
    );
    expect(drafted.scenario.fieldNames).toEqual([VERIFICATION.fieldName]);
    expect(drafted.scenario.inputRuleReference).not.toBeNull();
    expect(drafted.scenario.verification).toMatchObject({
      resultJudgement: 'FORM_STRUCTURE',
      recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: VERIFICATION.recordIdPathPatterns },
      readVerification: {
        bindings: [{ parameterName: VERIFICATION.lookupParameter, fieldName: VERIFICATION.fieldName }],
        expectations: [{ kind: 'TEXT_CONTAINS', fieldName: VERIFICATION.fieldName }],
        verificationOnly: true,
      },
    });
    const list2 = await openTrackedPage('/');
    expect(await list2.locator('tr[data-profile-id]').count()).toBe(2);
  }, SCENARIO_TIMEOUT_MS);

  it('5. uses the candidates found before the switch, saves a READ definition and runs the READ check', async () => {
    // PL-U の修正の 1 回目（設計書 14.1 の U5）: 書き込みのモードへの切り替えだけで進んだ改訂では、操作さがしをやり直さない。3 の点検のまとめて実行が
    // 切り替えの前に見つけた候補を、そのまま使う（古いとしない。OP-2: 切り替えは 4 のチェックの保存が行った。書き込みは 6 の点検で通す）。
    const jobsBefore = await flow.valueOf<readonly { jobKind: string; profileId: string }[]>('listAuditJobsFn', 'GET');
    const discoveryCount = jobsBefore.filter((job) => job.profileId === WRITE_PROFILE && job.jobKind === 'DISCOVERY').length;
    // OP-1: 1 回目（手でのログイン）と 2 回目（自動ログイン）のまとめて実行の 2 回。
    expect(discoveryCount).toBe(2);
    const candidates = await openTrackedPage(`/discovery/${WRITE_PROFILE}`);
    await candidates.getByTestId('discovery-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await candidates.getByTestId('auto-draft-blocker').count()).toBe(0);
    // OP-2: 4 のチェックの保存が書き込みの手順を作ったので、操作さがしの画面（直す道）の主のボタンは「書き込みの手順を見る」。
    expect(await candidates.getByTestId('discovery-summary').getAttribute('data-primary')).toBe('OPEN');
    await flow.snapshot(candidates);
    expect(await candidateOf(candidates, WRITE_SITE_PATHS.form, 'CREATE').count()).toBe(1);
    expect(await candidateOf(candidates, writeSiteEditPathOf(state.existingId), 'UPDATE').count()).toBe(1);
    const digest = await candidateOf(candidates, WRITE_SITE_PATHS.list, 'READ').getAttribute('data-digest');
    expect(digest).not.toBeNull();

    // OP-2: 4 のチェックの保存が、答え合わせの照合の専用の定義を作っている。ここで保存する定義は、保存の前になかった定義（一覧の順に頼らない）。
    const definitionIdsOf = async (page: Page): Promise<readonly string[]> =>
      (await page.getByTestId('read-check-definition').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-read-check-id') ?? '')));
    const before = await openTrackedPage(`/read-checks/${WRITE_PROFILE}`);
    await before.getByTestId('read-check-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    const idsBefore = await definitionIdsOf(before);
    const form = await openTrackedPage(`/read-checks/${WRITE_PROFILE}/new?candidate=${encodeURIComponent(digest ?? '')}`);
    await form.getByTestId('read-check-form').waitFor({ timeout: UI_TIMEOUT_MS });
    await form.getByTestId('read-check-parameters').getByLabel(VERIFICATION.lookupParameter, { exact: true }).fill(EXISTING_NAME);
    const row = form.locator('[data-testid="read-check-expectation"][data-index="0"]');
    await row.getByLabel(readText.expectationKind, { exact: true }).selectOption({ label: READ_CHECK_EXPECTATION_KIND_CATALOG.ROW_COUNT_EQUALS.label });
    await row.getByLabel(readText.expectationCount, { exact: true }).fill('1');
    await form.getByTestId('read-check-save').click();
    await form.waitForURL(new RegExp(`/read-checks/${WRITE_PROFILE}\\?notice=saved$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await form.getByTestId('read-check-definition').first().waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    const added = (await definitionIdsOf(form)).filter((id) => !idsBefore.includes(id));
    expect(added).toHaveLength(1);
    state.readCheckId = added[0] ?? '';
    expect(state.readCheckId).not.toBe('');
    await flow.snapshot(form);

    await provideWriteSiteCredentials();
    await form.getByTestId('read-check-start').click();
    await form.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
    const readJobId = lastSegmentOf(form);
    flow.jobs.push({ jobId: readJobId, profileId: WRITE_PROFILE });
    expect(await timed('READ check job', () => waitForJobOnScreen(form, readJobId))).toMatchObject({ jobKind: 'READ_CHECK', state: 'FINISHED' });
    const results = await openTrackedPage(`/read-checks/${WRITE_PROFILE}`);
    const result = results.locator(`[data-testid="read-check-result"][data-job-id="${readJobId}"][data-read-check-id="${state.readCheckId}"]`);
    await result.waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    expect(await result.getAttribute('data-result')).toBe('MATCHED');
    await flow.snapshot(results);
    // 操作さがしは、やり直していない（切り替えの前の 1 回だけ）。
    expect((await flow.valueOf<readonly { jobKind: string; profileId: string }[]>('listAuditJobsFn', 'GET'))
      .filter((job) => job.profileId === WRITE_PROFILE && job.jobKind === 'DISCOVERY').length).toBe(discoveryCount);
  }, SCENARIO_TIMEOUT_MS);

  // OP-2 の修正の 1 回目（指示書の 7・8。設計書 4.1.2 の案 C）: 次の点検（まとめて実行）の最後に、チェックした画面で登録 → 更新を行う。人がするのは「点検を始める」と
  // 始めるの確定だけ。ログインは点検の 1 回で、書き込みにもそのまま使う。点検が終わると、作業の画面からサイトの画面へ自動で移り、行に結果が出る（操作さがしや書き込みの
  // 手順への案内は出さない）。
  it('6. runs the next inspection that creates then updates the checked screen, both VERIFIED, and comes back to the site screen with the results on the row', async () => {
    await provideWriteSiteCredentials();
    const { page, jobId } = await timed('inspection with writes', () => startAuditOnScreen(WRITE_PROFILE));
    presses.count += 2;
    await timed('inspection chain', () => waitForNoActiveJob(WRITE_PROFILE));
    const chained = await flow.valueOf<{ stageChain: { state: string; stopReason: string | null; stages: readonly { kind: string; jobId: string | null }[]; writeStageJobIds: readonly string[] } | null }>(
      'getAuditJobFn', 'GET', { jobId },
    );
    expect(chained.stageChain).toMatchObject({ state: 'FINISHED', stopReason: null });
    expect(chained.stageChain?.stages.map(({ kind }) => kind)).toEqual(['AUDIT', 'DISCOVERY', 'READ_CHECK']);
    const [createJobId, updateJobId] = chained.stageChain?.writeStageJobIds ?? [];
    expect(chained.stageChain?.writeStageJobIds).toHaveLength(2);
    state.createJobId = createJobId ?? '';
    state.updateJobId = updateJobId ?? '';
    for (const stageJobId of [...(chained.stageChain?.stages ?? []).flatMap(({ jobId: id }) => (id === null || id === jobId ? [] : [id])), state.createJobId, state.updateJobId]) {
      flow.jobs.push({ jobId: stageJobId, profileId: WRITE_PROFILE });
    }
    // 指示書の 8: 作業の画面は、点検が終わるとサイトの画面へ自動で移る。
    await page.waitForURL(new RegExp(`/profiles/${WRITE_PROFILE}\\?`, 'u'), { timeout: JOB_TIMEOUT_MS });
    await page.getByTestId('profile-arrival-wrote').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('profile-arrival-wrote').textContent()).toBe(LOCAL_UI_WRITE_SCREENS_TEXT.inspectionWrite.WROTE);
    const row = page.getByTestId('write-screens').locator('[data-testid="write-screen-row"]').filter({ hasText: CREATE_SCREEN_NAME });
    expect(await row.getAttribute('data-state')).toBe('CHECKED');
    expect(await row.getByTestId('write-screen-last-result').textContent())
      .toBe(LOCAL_UI_WRITE_SCREENS_TEXT.lastResult.line(LOCAL_UI_WRITE_SCREENS_TEXT.lastResult.created, LOCAL_UI_WRITE_SCREENS_TEXT.lastResult.updated));
    // サイトの画面に、操作さがしの結果・書き込みの手順への案内はない。
    expect(await page.locator('main a[href^="/discovery/"], main a[href^="/scenarios/"]').filter({ visible: true }).count()).toBe(0);
    await expectAtMostOnePrimaryButton(page);
    expect(await axeViolationsOf(page)).toEqual([]);
    await flow.snapshot(page);
    // 押下は、チェック・点検を始める・始めるの確定の 3 だけ（入力は 0。画面を開く移動は数えない）。前は、登録が 5、更新が 4、書き込みのモードの切り替えが 1。
    expect(presses.count).toBe(3);
    console.info(`[OP-2] presses from the check to the results of the create and the update: ${String(presses.count)}`);

    const create = await flow.valueOf<JobView>('getAuditJobFn', 'GET', { jobId: state.createJobId });
    const update = await flow.valueOf<JobView>('getAuditJobFn', 'GET', { jobId: state.updateJobId });
    expect(create).toMatchObject({ jobKind: 'WRITE_CREATE', state: 'FINISHED', write: { result: 'VERIFIED' } });
    expect(update).toMatchObject({ jobKind: 'WRITE_UPDATE', state: 'FINISHED', write: { result: 'VERIFIED' } });
    state.createdId = create.write?.recordId ?? '';
    expect(state.createdId).not.toBe('');
    expect(state.createdId).not.toBe(String(state.existingId));
    // 作った名前は、更新の前の値（7 で、更新の作業の画面の前後の差分から読む。サイトの記録は、もう更新した後の値）。
  }, SCENARIO_TIMEOUT_MS);

  it('7. shows the create and the update results with the before and after values on the job screens', async () => {
    const createPage = await openTrackedPage(`/jobs/${state.createJobId}`);
    const created = createPage.getByTestId('write-result');
    await created.waitFor({ timeout: UI_TIMEOUT_MS });
    expect([await created.getAttribute('data-result'), await created.getAttribute('data-kind')]).toEqual(['VERIFIED', 'CREATE']);
    expect((await createPage.getByTestId('write-result-record-id').textContent())?.trim()).toBe(state.createdId);
    // PL-2（13 章の 13）: 親の確かめに通った報告（VALID）は、要点の主のボタン「結果を見る」で開く（配らない理由の欄は出ない）。
    expect(await createPage.getByTestId('write-report-open').count()).toBe(1);
    expect(await createPage.getByTestId('write-report').count()).toBe(0);
    // OP-3（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D12）: まとめて実行の段の作業の画面に、まとめて実行の欄を別に出さない。ステップの一覧は
    // 詳しい内容の中、止まっていなければ要点に理由の行も出さない。「まとめて実行をやめる」のボタンはない（止めるのは要点の「点検を止める」の 1 つ）。
    expect(await createPage.getByTestId('job-details').getByTestId('job-stage-chain-stages').count()).toBe(1);
    expect(await createPage.getByTestId('job-summary-panel').getByTestId('job-stage-chain-stages').count()).toBe(0);
    expect(await createPage.getByTestId('job-stage-chain').count()).toBe(0);
    expect(await createPage.getByRole('button', { name: 'まとめて実行をやめる' }).count()).toBe(0);
    await flow.snapshot(createPage);

    const jobPage = await openTrackedPage(`/jobs/${state.updateJobId}`);
    const result = jobPage.getByTestId('write-result');
    await result.waitFor({ timeout: UI_TIMEOUT_MS });
    expect([await result.getAttribute('data-result'), await result.getAttribute('data-kind')]).toEqual(['VERIFIED', 'UPDATE']);
    expect((await jobPage.getByTestId('write-result-target').textContent())?.trim()).toBe(state.createdId);
    const changed = jobPage.getByTestId('write-result-diff-changed');
    expect(await changed.evaluateAll((rows) => rows.map((row) => [row.getAttribute('data-field-name'), row.getAttribute('data-matched')])))
      .toEqual([[VERIFICATION.fieldName, 'true']]);
    state.createdName = (await changed.getByTestId('write-result-diff-previous').textContent()) ?? '';
    state.updatedName = siteOf().memberOf(Number(state.createdId))?.name ?? '';
    expect(state.createdName).not.toBe('');
    expect(state.createdName).not.toBe(EXISTING_NAME);
    expect(state.updatedName).not.toBe('');
    expect(state.updatedName).not.toBe(state.createdName);
    expect(await changed.getByTestId('write-result-diff-new').textContent()).toBe(state.updatedName);
    expect(siteOf().memberOf(Number(state.createdId))).toMatchObject({ name: state.updatedName, note: siteOf().keptMarker });
    await flow.snapshot(jobPage);
  }, SCENARIO_TIMEOUT_MS);

  it('8. shows the created record in the audited data ledger with one VERIFIED update', async () => {
    const profile = await openTrackedPage(`/profiles/${WRITE_PROFILE}`);
    // PL-1: 作ったデータの一覧への入口は、サイトの画面の詳しい内容の中。
    await openProfileAdvancedSettings(profile, UI_TIMEOUT_MS);
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

  it('9. offers the VALID write reports: opens action-report.html and downloads the write ZIP whose JSON match the schemas and the manifest', async () => {
    for (const [jobId, kind] of [[state.createJobId, 'CREATE'], [state.updateJobId, 'UPDATE']] as const) {
      const job = await flow.valueOf<JobView>('getAuditJobFn', 'GET', { jobId });
      const page = await openTrackedPage(`/jobs/${jobId}`);
      // PL-2（13 章の 13）: 親の確かめに通った報告（VALID）は、要点の主のボタン「結果を見る」で開き、ZIP はたたんだ詳しい内容の中。
      const open = page.getByTestId('job-summary-panel').getByTestId('write-report-open');
      await open.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await page.getByTestId('write-report').count(), kind).toBe(0);
      const href = await open.getAttribute('href');
      expect(href).toBe(`/artifacts/${jobId}/${ACTION_REPORT_ARTIFACT_FILE_NAME}`);
      const html = await expectArtifactHtml(href ?? '', 'VERIFIED');
      expect(await html.locator('code', { hasText: state.createdId }).count()).toBeGreaterThan(0);

      await openAdvancedSettings(page, 'job-details', UI_TIMEOUT_MS);
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

  it('10. never opened the auth setup screen, received only the login POSTs and one CREATE and one UPDATE POST, and no marker or value leaks', async () => {
    // MI-F2（受け入れ条件 5）: 全部の段で、ブラウザは認証の設定の画面を一度も開いていない（移った先の記録。目印の検索で開く画面より前に確かめる）。
    expect(state.visitedPaths).toContain(`/profiles/${AUTH_PROFILE}`);
    expect(state.visitedPaths.filter((path) => path.startsWith(AUTH_SETUP_SCREEN_PREFIX))).toEqual([]);
    const expected = [
      // 認証つきの点検（まとめて実行。ログインは最初の 1 回）と、READ の確かめの、ジョブごとのログイン（手動のセッションの引き継ぎ）。公開の監査はログインしない。
      // OP-1: 認証つきの点検は、1 の作成の「点検を始める」で始まった 1 回目と、3 の 2 回目。OP-2 の修正の 1 回目: 6 の 3 回目の点検は、ログインの 1 回で、
      // 読み取りの段の後に登録と更新を送る（前は、登録と更新の作業ごとにログインした）。
      `POST ${WRITE_SITE_PATHS.login}`,
      `POST ${WRITE_SITE_PATHS.login}`,
      `POST ${WRITE_SITE_PATHS.login}`,
      `POST ${WRITE_SITE_PATHS.login}`,
      `POST ${WRITE_SITE_PATHS.create}`,
      `POST ${writeSiteRecordPathOf(state.createdId)}`,
    ];
    expect(nonReadRequestsOf(siteOf().requests)).toEqual(expected);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReadRequestsOf(siteOf().requests)).toEqual(expected);
    expect(siteOf().members).toBe(2);
    // OP-2 の修正の 1 回目: 成功したログインは、1 回目・2 回目の点検、READ の確かめ、3 回目の点検（書き込みを含む）の 4 つ（前は、登録と更新の作業ごとに 1 つで 5）。
    expect(siteOf().successfulLogins).toBe(4);

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
      .filter(({ bytes }) => [state.createdName, state.updatedName].some((value) => Buffer.from(bytes).toString('utf8').includes(value)))
      .map(({ place }) => place);
    expect(valuePlaces.length).toBeGreaterThan(0);
    expect(valuePlaces.filter((place) => !isWriteValueArtifactPlace(place))).toEqual([]);
    // 落とした監査の ZIP（公開の監査）には、書き込みの値がない。
    expect(readdirSync(`${flow.rootOf()}/${DOWNLOAD_DIRECTORY_NAME}`).filter((name) => isBundleFileName(name))).toHaveLength(1);
  }, SCENARIO_TIMEOUT_MS);
});

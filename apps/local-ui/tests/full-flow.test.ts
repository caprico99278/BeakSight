/**
 * 画面だけで全段を通す E2E（T32h。Task 32 の設計書 4.2）。ビルドした画面を一時の root の起動の部品で起動し（`helpers/scenario-marker-flow.ts` の
 * 作り。記録つきのページ）、headless の Chromium の画面の操作（クリックと入力）だけで、127.0.0.1 の書き込みの fixture
 * （`tests/helpers/write-site-fixture.ts`）に対して、次の段を順に通す。ワーカーは本物（CLI の起動の設定の Chromium）。手動のログインだけは、テスト
 * だけの入口が受け渡しのサーバから資格情報を受けて入れる（人の操作の代わり。`helpers/auth-worker.ts`）。
 * 1. プロファイルの作成（公開の監査と、認証つきの読み取りの監査（手動のログイン）の 2 つ）。認証つきのプロファイルは「保存して入口を確かめる」で、
 *    入口の確かめの後に BeakSight が認証の設定を案で保存する（自動保存。認証の設定の画面は開かない）。
 * 2. 作成が続けて始めた公開の監査（PUBLIC_PASSIVE）→ `report.html` を開き、監査の ZIP を落とす。
 * 3. 作成が続けて始めた認証つきの点検（まとめて実行。手動のログインの後に自動ログインへ切り替わる）。
 * 4. まとめて実行の操作さがしの候補から、画面で READ の定義を保存する。
 * SLIM-GROUP UI-7（ユーザーの判断 2026-11-15）: 前の 2 回目の公開の監査・2 回目の認証つきの点検・単独の READ の確かめと、フォームの形の書き込み（一覧の
 * チェック → 次の点検で登録と更新 → 作業の画面・台帳・書き込みの報告）は外した。画面だけで通す書き込みは `one-pass-write-flow.test.ts` の 1 本。
 * MI-F2（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.1、6 章の受け入れ条件 5）: 全部の段で、ブラウザが移った先を記録し、認証の設定の画面
 * （`/auth-setup/`）を一度も開かないことを確かめる。
 * 確かめること: 落とした ZIP の中の JSON がスキーマに合い、目録の sha256 が中身と一致する。report.html が本物のブラウザで開き、主な見出しと
 * 結果の値があり、CSP の違反・console の誤り・外への要求が 0（ページの記録の補助）。サイトに届いた読み取りでない要求は、ログインの POST 1 つだけ
 * （全部の後に余白を待って数え直す）。秘密の目印（資格情報・セッション・CSRF・hidden・readonly・保つ欄の値）は、画面・Server Function の応答・管理データ
 * （WAL を含む）・成果物（ZIP の中身を含む）に出ない。
 * Server Function を直接呼ぶのは、確かめ（ジョブの状態と、画面と同じ値を読むだけ）のためだけ。操作（保存・開始）は、すべて画面の操作で行う。
 * 目印の値は出力しない。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import type { Download, Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RUN_ARTIFACT_FILE_NAMES, isBundleFileName } from '../../../src/core/artifact-layout.js';
import { createSha256FingerprintOfBytes } from '../../../src/core/ids.js';
import { WORKER_ENTRY_CHECK_JOB_KIND } from '../../../src/control/worker-protocol.js';
import { validateArtifact } from '../../../src/core/schema-validator.js';
import { READ_CHECK_EXPECTATION_KIND_CATALOG } from '../../../src/presentation/catalog.js';
import { LOCAL_UI_READ_CHECK_TEXT } from '../../../src/presentation/messages.js';
import { CHATGPT_BUNDLE_FILE_NAMES } from '../../../src/report/chatgpt-bundle.js';
import { REPORT_CLASS_NAMES } from '../../../src/report/html-tokens.js';
import { nonReadRequestsOf } from '../../../tests/helpers/leak-places.js';
import { settleLateDeliveries } from '../../../tests/helpers/loopback-server.js';
import { WRITE_SITE_LOGIN_FIELDS, WRITE_SITE_PATHS, startWriteSite, writeSiteEditPathOf, type WriteSite } from '../../../tests/helpers/write-site-fixture.js';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
import { openAdvancedSettings } from './helpers/advanced-settings.ts';
import { createProfileOnScreen } from './helpers/profile-form.ts';
import { JOB_TIMEOUT_MS, SCENARIO_TIMEOUT_MS, UI_TIMEOUT_MS, createScenarioMarkerFlow, type JobDetail } from './helpers/scenario-marker-flow.ts';
import { waitForNoActiveJobViaServerFunctions, type ServerFunctionJobRow } from './helpers/server-function-job-wait.ts';

/**
 * PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 6 章の 1）: 作成の画面に名前の欄はなく、名前は開始のアドレスのホスト名から決まる（同じ名前があれば
 * `-2` を付ける）。fixture のサイトは 127.0.0.1 で待ち受け、公開の画面だけのプロファイルを先に作るので、名前はこの 2 つになる（設定のファイルの名前もそろえる）。
 */
const PUBLIC_PROFILE = '127-0-0-1';
const AUTH_PROFILE = '127-0-0-1-2';
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
/** READ の定義の検索の項目（一覧の検索の query の名前）。 */
const LOOKUP_PARAMETER = 'q';

const readText = LOCAL_UI_READ_CHECK_TEXT;

/** ジョブの詳細のうち、ここで確かめる項目（`JobDetail` に足すもの）。 */
type JobView = Omit<JobDetail, 'artifacts'> & {
  readonly runId: string | null;
  readonly artifacts: readonly { readonly kind: string; readonly relativePath: string; readonly href: string }[];
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
  /** 1 の作成で始まった、認証つきの点検（まとめて実行の点検の段）のジョブ。 */
  authAuditJobId: '',
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
  ],
  extraFunctionCalls: () => [],
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

/** ページの URL の最後の区切り（ジョブの ID）。 */
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

  // SLIM-GROUP UI-7: 前は、ここで公開の監査をもう 1 回始めていた。1 の作成の「点検を始める」が続けて始めた単独の点検（公開の監査）の結果を使う。
  it('2. the public audit started by the creation: opens report.html and downloads the audit ZIP whose JSON match the schemas and the manifest', async () => {
    const jobId = (await flow.valueOf<readonly (ServerFunctionJobRow & { readonly jobId: string; readonly jobKind: string })[]>('listAuditJobsFn', 'GET'))
      .find((row) => row.profileId === PUBLIC_PROFILE && row.jobKind === 'AUDIT')?.jobId ?? '';
    const page = await openTrackedPage(`/jobs/${jobId}`);
    const job = await waitForJobOnScreen(page, jobId);
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
  // 自動ログインへ切り替わった（1 回目の作業に、切り替えた 1 行が出る）。SLIM-GROUP UI-7: 前は、この後に「毎回手でログインする」を入れて 2 回目の認証つきの点検を
  // 流していた（2 回目の点検で自動ログインすることは `one-pass-write-flow.test.ts` と偽のワーカーの `tests/integration/control-login-registration.test.ts`）。ここでは 1 回目の点検の
  // まとめて実行（点検 → 操作さがし → 見るだけの確かめ）と、手でのログインで認証した結果を、作業の画面で確かめる。
  it('3. switched to the automated login after the first manual login, on the chained authenticated audit', async () => {
    const firstAudit = (await flow.valueOf<readonly (ServerFunctionJobRow & { readonly jobId: string; readonly jobKind: string })[]>('listAuditJobsFn', 'GET'))
      .filter((row) => row.profileId === AUTH_PROFILE && row.jobKind === 'AUDIT').at(-1);
    const jobId = firstAudit?.jobId ?? '';
    state.authAuditJobId = jobId;
    const page = await openTrackedPage(`/jobs/${jobId}`);
    expect(await page.getByTestId('job-automated-login-switch').getAttribute('data-result')).toBe('SWITCHED');
    const chain = await flow.valueOf<{ stageChain: { stages: readonly { kind: string }[] } | null }>('getAuditJobFn', 'GET', { jobId });
    expect(chain.stageChain?.stages.map((stage) => stage.kind)).toEqual(['AUDIT', 'DISCOVERY', 'READ_CHECK']);
    const job = await waitForJobOnScreen(page, jobId);
    expect(job).toMatchObject({ jobKind: 'AUDIT', state: 'FINISHED', lastAuthState: 'AUTHENTICATED' });
    expect(job.runStatus).toMatch(/^(?:COMPLETE|PARTIAL)$/u);
    expect(await page.getByTestId('job-auth-state').count()).toBe(1);
  }, SCENARIO_TIMEOUT_MS);

  // SLIM-GROUP UI-7（ユーザーの判断 2026-11-15）: 前の 4・6〜9（一覧のチェックで書き込みのモードへ切り替え、次の点検でフォームの形の登録と更新を送り、
  // 作業の画面・台帳・書き込みの報告を確かめる）は外した。画面だけで通す書き込みは `one-pass-write-flow.test.ts`（SPA・スクリプトのログイン・API の形）の 1 本。
  // フォームの形の書き込みは、本物の Chromium の段の結合（`tests/integration/write-create-run.test.ts` ほか）と、偽のワーカーの親の順
  // （`tests/integration/control-write-jobs.test.ts`）で確かめる（RB-6 で、子 process の書き込みの連鎖の fork は消した）。
  it('4. uses the candidates of the chained discovery and saves a READ definition from a candidate on the screen', async () => {
    const jobsBefore = await flow.valueOf<readonly { jobKind: string; profileId: string }[]>('listAuditJobsFn', 'GET');
    const discoveryCount = jobsBefore.filter((job) => job.profileId === AUTH_PROFILE && job.jobKind === 'DISCOVERY').length;
    // OP-1: 1 回目（手でのログイン）のまとめて実行の 1 回。
    expect(discoveryCount).toBe(1);
    const candidates = await openTrackedPage(`/discovery/${AUTH_PROFILE}`);
    await candidates.getByTestId('discovery-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    await flow.snapshot(candidates);
    expect(await candidateOf(candidates, WRITE_SITE_PATHS.form, 'CREATE').count()).toBe(1);
    expect(await candidateOf(candidates, writeSiteEditPathOf(state.existingId), 'UPDATE').count()).toBe(1);
    const digest = await candidateOf(candidates, WRITE_SITE_PATHS.list, 'READ').getAttribute('data-digest');
    expect(digest).not.toBeNull();

    // ここで保存する定義は、保存の前になかった定義（一覧の順に頼らない）。
    const definitionIdsOf = async (page: Page): Promise<readonly string[]> =>
      (await page.getByTestId('read-check-definition').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-read-check-id') ?? '')));
    const before = await openTrackedPage(`/read-checks/${AUTH_PROFILE}`);
    await before.getByTestId('read-check-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    const idsBefore = await definitionIdsOf(before);
    const form = await openTrackedPage(`/read-checks/${AUTH_PROFILE}/new?candidate=${encodeURIComponent(digest ?? '')}`);
    await form.getByTestId('read-check-form').waitFor({ timeout: UI_TIMEOUT_MS });
    await form.getByTestId('read-check-parameters').getByLabel(LOOKUP_PARAMETER, { exact: true }).fill(EXISTING_NAME);
    const row = form.locator('[data-testid="read-check-expectation"][data-index="0"]');
    await row.getByLabel(readText.expectationKind, { exact: true }).selectOption({ label: READ_CHECK_EXPECTATION_KIND_CATALOG.ROW_COUNT_EQUALS.label });
    await row.getByLabel(readText.expectationCount, { exact: true }).fill('1');
    await form.getByTestId('read-check-save').click();
    await form.waitForURL(new RegExp(`/read-checks/${AUTH_PROFILE}\\?notice=saved$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await form.getByTestId('read-check-definition').first().waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    const added = (await definitionIdsOf(form)).filter((id) => !idsBefore.includes(id));
    expect(added).toHaveLength(1);
    expect(added[0] ?? '').not.toBe('');
    await flow.snapshot(form);
    // SLIM-GROUP UI-7: 前は、ここで単独の READ の確かめのジョブを流していた。READ の確かめは、1 のまとめて実行の見るだけの確かめの段と、
    // `tests/integration/read-check-run.test.ts`・`discovery-approval-secret-markers` の流れで確かめる。
  }, SCENARIO_TIMEOUT_MS);

  it('5. never opened the auth setup screen, received only the login POST, and no marker leaks', async () => {
    // MI-F2（受け入れ条件 5）: 全部の段で、ブラウザは認証の設定の画面を一度も開いていない（移った先の記録。目印の検索で開く画面より前に確かめる）。
    expect(state.visitedPaths).toContain(`/jobs/${state.authAuditJobId}`);
    expect(state.visitedPaths.filter((path) => path.startsWith(AUTH_SETUP_SCREEN_PREFIX))).toEqual([]);
    // 認証つきの点検（まとめて実行。ログインは最初の 1 回）のログインだけ。公開の監査はログインしない。書き込みの要求は 0。
    const expected = [`POST ${WRITE_SITE_PATHS.login}`];
    expect(nonReadRequestsOf(siteOf().requests)).toEqual(expected);
    // TEST-TIME-B（案 9）: どのジョブのワーカー（と Browser）も終わった後なので、受けている途中の要求が 0 になってから短い余白だけ待つ（上限は前の固定の待ち）。
    await settleLateDeliveries(LATE_REQUEST_WAIT_MS, siteOf());
    expect(nonReadRequestsOf(siteOf().requests)).toEqual(expected);
    expect(siteOf().members).toBe(1);
    expect(siteOf().successfulLogins).toBe(1);

    const places = await timed('marker search', () => flow.expectNoSecretMarker('full-flow'));
    // 検索した場所に、落とした監査の ZIP の中身と、成果物の画面（report.html）が入っている。
    const names = places.map(({ place }) => place);
    expect(state.downloads).toHaveLength(1);
    for (const path of state.downloads) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      expect(names.some((place) => place.startsWith(`root:${DOWNLOAD_DIRECTORY_NAME}/${name}!`)), name).toBe(true);
    }
    expect(names.some((place) => place.endsWith(`/${RUN_ARTIFACT_FILE_NAMES.report}`) && place.startsWith('html:'))).toBe(true);
  }, SCENARIO_TIMEOUT_MS);
});

/**
 * MI-5（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 3 章の判断 1、4.5、6 章の受け入れ条件 5）: プロファイルの詳細の「書き込みにも使う」を、
 * ビルドした画面のサーバ（一時の root）と headless の Chromium（`tests/helpers/chromium.ts` の既定）で確かめる。サイトへは接続しない（ジョブを始めない）。
 * - 出す: 認証つきの読み取りの監査で、認証の設定があるプロファイルだけ。公開のプロファイル、認証の設定のないプロファイルには出さない。
 * - 確認のダイアログ: 書き込みの段に進めるようになること（書き込みそのものは、シナリオの承認と開始の押下の後だけ）、隔離の扱い（`isolation-unverified-` の参照なら
 *   「テスト環境の隔離はまだ確かめていません」を目立つ形で、ほかは参照の値）、プロファイルの改訂が 1 つ進むこと。やめると何も変えない。
 * - 確定すると、同じプロファイルが書き込みのモードの次の改訂になり、認証の設定は `CURRENT` のまま。欄は消え、シナリオの欄が出る。監査も始められる（開始の
 *   確かめの理由がない）。
 * - OP-3: 「書き込みにも使う」の Server Function は消した（使い先がない）。切り替えの部品は、対象でない・認証の設定がない・改訂の衝突を、閉じた一覧の理由で
 *   拒み、書かない（部品を管理データで直接呼んで確かめる）。
 */
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { createStartingJob, recordFinished, recordRunStarted } from '../../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { LOCAL_UI_NEXT_STEP_TEXT, LOCAL_UI_TEXT } from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
import { publicProfileDocument, writeAuditTargetConfig } from './helpers/audit-site.ts';
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
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';
import { isIsolationUnverifiedEvidenceRef, isolationUnverifiedEvidenceRefOf } from '../src/server/isolation-evidence-ref';
import { saveAuthSetupRequestInStore, switchToWriteModeInStore } from './helpers/profile-store-setup.ts';
import { openProfileAdvancedSettings } from './helpers/profile-form.ts';

const UI_TIMEOUT_MS = 15_000;
const SCENARIO_TIMEOUT_MS = 120_000;
const MAX_TAB_PRESSES = 80;
const FIRST_REVISION = 1;
/** 許可 Origin（ループバックでない、予約のドメイン。接続しない）。 */
const ORIGIN = 'https://mi5.example.test';
const UNVERIFIED_PROFILE = 'mi5-unverified';
const VERIFIED_PROFILE = 'mi5-verified';
/** PL-5: 確かめた記録の参照を書き換えて確定する、もう 1 つのサイト（ほかのテストの改訂を動かさない）。 */
const VERIFIED_SAVE_PROFILE = 'mi5-verified-save';
const NO_SETUP_PROFILE = 'mi5-no-setup';
const PUBLIC_PROFILE = 'mi5-public';
/** MI-F3（MI-R の Minor 12）: 隔離が未確認の参照は、形の owner（`isolation-evidence-ref.ts`）の日付の関数で作る（日付はどの日でもよい）。 */
const UNVERIFIED_REF = isolationUnverifiedEvidenceRefOf(new Date('2026-10-26T03:00:00Z'));
const VERIFIED_REF = 'evidence/mi5/isolation-check-1';
const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400 });
/** 読み込みの間隔（ループバックでない許可 Origin の下限より長い。ジョブは始めない）。 */
const NAVIGATION_INTERVAL_MS = 10_000;


let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();

const started = (): StartedServer => {
  if (server === undefined) throw new Error('サーバが起動していない');
  return server;
};
const rootOf = (): TemporaryUiRoot => {
  if (root === undefined) throw new Error('一時の root がない');
  return root;
};

const { openPage, tabTo, screenshot, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  screenshotDirectory: process.env['MI5_SCREENSHOT_DIR'],
});

const call = (name: string, method: 'GET' | 'POST', data?: unknown) =>
  callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await call(name, method, data);
  expect(result.response.status, name).toBe(STATUS.OK);
  return result.value as T;
};

/** 認証つきの読み取りの監査のプロファイルの文書。 */
const passiveProfileOf = (profileId: string, environmentEvidenceRef: string): Record<string, unknown> => ({
  schemaVersion: 'beaksight-profile/1',
  profileId,
  revision: FIRST_REVISION,
  targetConfigPath: writeAuthTargetConfig(rootOf().root, profileId, ORIGIN, '/admin/', 1, NAVIGATION_INTERVAL_MS),
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [ORIGIN],
  environmentEvidenceRef,
});

/** 手動のログインの認証の設定。 */
const setupOf = (profileId: string): Record<string, unknown> => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId,
  profileRevision: FIRST_REVISION,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin/', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin/'],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

interface ProfileValue {
  readonly profile: { readonly revision: number; readonly mode: string; readonly auth: string; readonly environmentEvidenceRef: string | null };
}
const profileOf = (profileId: string): Promise<ProfileValue> => valueOf<ProfileValue>('getProfileFn', 'GET', { profileId });

/**
 * 「書き込みも試す」のボタン（PL-1。設計書 `2026-10-26-beaksight-plain-ui-design.md` 4 章の 1、6 章の 6: 点検が 1 回終わってから、主のボタンか、詳しい内容の中の入口と
 * して出す。前は「書き込みにも使う」の欄）。
 */
const panelOf = (page: Page): Locator => page.locator('main [data-testid="profile-write-mode-open"]');

/** サイトの画面を開き、詳しい内容を開く（「書き込みも試す」が詳しい内容の中にあるときのため）。 */
const openProfileWithDetails = async (profileId: string): Promise<Page> => {
  const page = await openPage(`/profiles/${profileId}`);
  await page.getByTestId('profile-summary').waitFor({ timeout: UI_TIMEOUT_MS });
  await openProfileAdvancedSettings(page, UI_TIMEOUT_MS);
  return page;
};

/** テストだけの操作: 手でログインした点検が 1 回終わった記録（ジョブの行。ワーカーの代わり）を書く。 */
const writeFinishedAudit = (profileId: string): void => {
  const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
  const jobId = `job-${profileId}-audit`;
  const runId = profileId === UNVERIFIED_PROFILE ? 'RUN-20261026010000' : 'RUN-20261026010001';
  try {
    expect(createStartingJob(database, { jobId, jobKind: 'AUDIT', profileId, profileRevision: FIRST_REVISION, startNew: true, createdAt: '20261026010000' }, () => null))
      .toEqual({ ok: true });
    expect(recordRunStarted(database, jobId, { runId: runId as never, runDirectory: runId, startedAt: '20261026010001' })).toBe(true);
    expect(recordFinished(database, jobId, { kind: 'RAN', exitCode: 0, runId: runId as never, runDirectory: runId, runStatus: 'COMPLETE' }, '20261026010100'))
      .toBe(true);
  } finally {
    closeControlDatabase(database);
  }
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  const publicPath = writeAuditTargetConfig(root.root, PUBLIC_PROFILE, 'http://127.0.0.1:9', { minNavigationIntervalMs: 0, screenshots: false });
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  for (const [profileId, reference] of [
    [UNVERIFIED_PROFILE, UNVERIFIED_REF], [VERIFIED_PROFILE, VERIFIED_REF], [VERIFIED_SAVE_PROFILE, VERIFIED_REF], [NO_SETUP_PROFILE, VERIFIED_REF],
  ] as const) {
    const created = await valueOf('createProfileFn', 'POST', { profile: passiveProfileOf(profileId, reference) });
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
  }
  for (const profileId of [UNVERIFIED_PROFILE, VERIFIED_PROFILE, VERIFIED_SAVE_PROFILE]) {
    expect(await saveAuthSetupRequestInStore(root, { setup: setupOf(profileId) })).toMatchObject({ ok: true });
    // PL-1（4 章の 1）: 「書き込みも試す」は、点検が 1 回終わってから出す。
    writeFinishedAudit(profileId);
  }
  expect(await valueOf('createProfileFn', 'POST', { profile: publicProfileDocument(PUBLIC_PROFILE, publicPath) })).toMatchObject({ ok: true });
}, SCENARIO_TIMEOUT_MS);

afterEach(async () => {
  await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  root?.remove();
});

describe('MI-5: "use for writes too" on the profile screen', () => {
  // OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'、4.1 の D6）: 「書き込みも試す」のボタンと確認のダイアログ（隔離の 2 択を含む）は
  // なくした。書き込みのモードへの切り替えは、「登録・更新を試せる画面」の一覧のチェックの保存が、中で行う（隔離の参照は内部の「確かめていない」の固定の値）。
  // 前の UI の確かめ（ダイアログの文と 2 択）は、同じ値を保存の層（Server Function）で確かめる形に替えた。
  it('has no "write too" button nor the isolation mark, and the internal switch still saves the next revision with an unverified reference', async () => {
    const page = await openProfileWithDetails(UNVERIFIED_PROFILE);
    expect(await panelOf(page).count()).toBe(0);
    expect(await page.getByTestId('profile-isolation-unverified').count()).toBe(0);
    expect(await page.locator('main [data-action="WRITE_MODE_SWITCH"]').count()).toBe(0);
    await page.close();
    // 切り替えの部品（チェックの保存が中で使う）は、今どおり、次の改訂を書き込みのモードで保存し、認証の設定を結び直す。OP-3: 前の Server Function は消したので、
    // 部品を管理データで直接呼ぶ（画面のサーバは同じ管理データを読む）。
    expect(await switchToWriteModeInStore(rootOf().root, UNVERIFIED_PROFILE, FIRST_REVISION))
      .toEqual({ ok: true, profileRevision: FIRST_REVISION + 1 });
    const savedProfile = (await profileOf(UNVERIFIED_PROFILE)).profile;
    expect(savedProfile).toMatchObject({ revision: FIRST_REVISION + 1, mode: 'TEST_APPROVED_WRITE', auth: 'MANUAL_SESSION' });
    expect(isIsolationUnverifiedEvidenceRef(savedProfile.environmentEvidenceRef)).toBe(true);
    expect(await valueOf('getAuthSetupFn', 'GET', { profileId: UNVERIFIED_PROFILE })).toMatchObject({
      stored: { freshness: 'CURRENT', setup: { profileRevision: FIRST_REVISION + 1, excludedPaths: ['/admin/logout'] } },
    });
    // 書き込みのモードのサイトでも、要点に隔離の印を出さず、主のボタンは点検の段のまま（書き込みの手順の画面は、ふだんの流れから外した）。
    const after = await openProfileWithDetails(UNVERIFIED_PROFILE);
    expect(await after.getByTestId('profile-isolation-unverified').count()).toBe(0);
    expect(await after.getByTestId('profile-summary').getAttribute('data-stage')).not.toBe('SCENARIOS');
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: UNVERIFIED_PROFILE })).toMatchObject({
      mode: 'TEST_APPROVED_WRITE',
      blocker: null,
      authRequired: true,
    });
    await screenshot(after, 'op2-write-mode-without-dialog');
  }, SCENARIO_TIMEOUT_MS);

  it('does not show the panel for a profile without an auth setup or a public profile, and the internal switch rejects them', async () => {
    for (const profileId of [NO_SETUP_PROFILE, PUBLIC_PROFILE]) {
      const page = await openProfileWithDetails(profileId);
      expect(await panelOf(page).count(), profileId).toBe(0);
      await page.close();
    }
    // OP-3: 「書き込みにも使う」の 2 つの Server Function（保存と確認のダイアログの値）は、使い先がなくなったので消した（画面のサーバから呼べない）。
    expect(ids.has('switchToWriteModeFn')).toBe(false);
    expect(ids.has('writeModeSwitchProposalFn')).toBe(false);
    // 切り替えの部品（チェックの保存が中で使う）は、閉じた一覧の理由で拒み、書かない（入力の形の誤りは、部品の単体のテスト `write-mode-switch.test.ts`）。
    expect(await switchToWriteModeInStore(rootOf().root, NO_SETUP_PROFILE, FIRST_REVISION))
      .toEqual({ ok: false, reason: 'AUTH_SETUP_NOT_CURRENT', authSetupErrors: [] });
    expect(await switchToWriteModeInStore(rootOf().root, PUBLIC_PROFILE, FIRST_REVISION))
      .toEqual({ ok: false, reason: 'NOT_OFFERED', authSetupErrors: [] });
    expect(await switchToWriteModeInStore(rootOf().root, VERIFIED_PROFILE, FIRST_REVISION + 1))
      .toEqual({ ok: false, reason: 'PROFILE_REVISION_CONFLICT', authSetupErrors: [] });
    for (const profileId of [NO_SETUP_PROFILE, PUBLIC_PROFILE, VERIFIED_PROFILE]) {
      expect((await profileOf(profileId)).profile.revision, profileId).toBe(FIRST_REVISION);
    }
  }, SCENARIO_TIMEOUT_MS);
});

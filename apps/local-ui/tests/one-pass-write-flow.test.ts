/**
 * OP-G（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1・4.1.1・4.1.2）: 画面の操作だけで、作成 → 1 回目の点検（手でのログイン）→ 一覧でチェック →
 * 2 回目の点検（自動ログイン）→（データのないサイトなので）3 回目の点検（自動ログイン）をたどり、チェックした画面の登録と更新が本当に送られ、確かめられ、画面の
 * 行と点検の要点が、実際に行ったことと一致することを確かめる（UI-W3 の撮り直しで、画面の流れでは書き込みが通らなかった不具合の再現）。
 * - 部 A: スクリプトで token を取りに行く SPA（token は別の Origin）。会員の画面は form のない API の形（`memberScreenLayout: 'formless'`）で、詳細の画面がある。
 *   会員は 0 人。
 * - 部 B: フォームの形のサイト（`write-site-fixture`）。ログインはフォーム。会員は 0 人。更新の画面がある。
 * 前のテスト（`tests/integration/write-chain-stage-fork.test.ts`・`full-flow.test.ts`）との違い: 前のテストは、書き込みの手順（検証の指定・照合の READ）をテストの
 * 補助で直接作るか、データのあるサイトで、手でのログインを毎回行っていた。ここでは、チェックの保存（画面の操作）が作る手順だけを使い、データのないサイトで、
 * 自動ログインの点検を続ける（3 回目の前は、自動ログインの間隔の決まりの時間だけ、本当に待つ）。
 * ワーカーは本物。手でのログイン（1 回目）だけは、テストだけの入口が受け渡しのサーバから資格情報を受けて入れる（人の操作の代わり）。サイトは 127.0.0.1 だけ。
 * 端末の負荷を上げないよう、サーバ・ワーカー・ブラウザは同時に 1 組だけ（部 A と部 B は順に流す）。
 */
import type { Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../../src/core/deadline.js';
import { AUTO_LOGIN_MIN_INTERVAL_MS } from '../../../src/control/job/auto-login-limits.js';
import { WORKER_ENTRY_CHECK_JOB_KIND } from '../../../src/control/worker-protocol.js';
import { LOCAL_UI_AUDIT_TEXT, LOCAL_UI_WRITE_SCREENS_TEXT } from '../../../src/presentation/messages.js';
import { SPA_APP_PATHS, SPA_LOGIN_FIELDS, startSpaAuthSite, type SpaAuthSite } from '../../../tests/helpers/spa-auth-site-fixture.js';
import { WRITE_SITE_LOGIN_FIELDS, WRITE_SITE_PATHS, startWriteSite, type WriteSite } from '../../../tests/helpers/write-site-fixture.js';
import { openAdvancedSettings } from './helpers/advanced-settings.ts';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
import { createProfileOnScreen } from './helpers/profile-form.ts';
import { JOB_TIMEOUT_MS, UI_TIMEOUT_MS, createScenarioMarkerFlow } from './helpers/scenario-marker-flow.ts';
import { waitForNoActiveJobViaServerFunctions, type ServerFunctionJobRow } from './helpers/server-function-job-wait.ts';

/** 名前は開始のアドレスのホスト名から決まる（127.0.0.1）。部ごとに一時の root が別なので、どちらも同じ名前。 */
const PROFILE_ID = '127-0-0-1';
/** 巡回の上限と、読み込みの最小の間隔（ms。ループバックの fixture）。 */
const MAX_PAGES = 5;
const NAVIGATION_INTERVAL_MS = 0;
/** 1 つの部の上限（ms。3 回の点検と、自動ログインの間隔の待ちを含む）。 */
const PART_TIMEOUT_MS = 1_500_000;
/** まとめて実行の終わりを読み直す間隔（ms）。 */
const CHAIN_POLL_MS = 500;
/** 自動ログインの間隔の待ちの間に、サイトの画面を読み直す間隔（ms）と、上限の余裕（ms）。 */
const INTERVAL_POLL_MS = 15_000;
const INTERVAL_MARGIN_MS = 120_000;
/** 全部の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 2_000;

const writeText = LOCAL_UI_WRITE_SCREENS_TEXT;

/** 点検の連鎖の値（`getAuditJobFn` の `stageChain`）。 */
interface ChainValue {
  readonly state: string;
  readonly stopReason: string | null;
  readonly stages: readonly { readonly kind: string; readonly state: string; readonly jobId: string | null }[];
  readonly writeStageJobIds: readonly string[];
}

/** 書き込みの段のジョブの値（`getAuditJobFn` の一部）。 */
interface WriteJobValue {
  readonly jobKind: string;
  readonly state: string;
  readonly failureReason: string | null;
  readonly write: { readonly recordId: string | null; readonly result: string | null; readonly targetRecordId?: string | null } | null;
}

/** 1 回の点検の結果（画面で見たもの）。 */
interface InspectionSeen {
  readonly chain: ChainValue;
  readonly writes: readonly WriteJobValue[];
  /** 点検の後に、サイトの画面へ自動で移ったか。 */
  readonly arrivedAutomatically: boolean;
  /** サイトの画面の要点の、書き込みの 1 行（なければ null）。 */
  readonly wroteLine: string | null;
  /** チェックした行の、前の点検の結果の 1 行と、更新の 1 行。 */
  readonly rowLastResult: string | null;
  readonly rowUpdateState: string | null;
  /** サイトの画面の要点の主のボタンの行き先（`data-action`）。 */
  readonly primaryActions: readonly string[];
  /** OP-G2: 点検を始めてからサイトの画面へ移るまでに、見ていた画面が開いた作業の画面の path（点検の作業の画面だけのはず）と、点検の作業の画面の path。 */
  readonly visitedJobPaths: readonly string[];
  readonly inspectionJobPath: string;
  /** OP-G2: 点検の作業の画面の要点の 1 行目が言った、今の段（`data-chain-stage`。見えた順ではない）。 */
  readonly chainStagesSeen: readonly string[];
}

/** 部ごとの差（サイトの起動、資格情報、開始のパス、書き込みの要求の数え方）。 */
interface PartSite {
  readonly origin: string;
  readonly startPath: string;
  readonly secretValues: () => readonly string[];
  readonly credentials: () => Promise<{ readonly fields: readonly (readonly [string, string])[]; readonly submit: string }>;
  /** 登録と更新の要求（`<method> <path>`。ログインの要求と事前確認を除く）。 */
  readonly createRequests: () => readonly string[];
  readonly updateRequests: () => readonly string[];
  readonly members: () => number;
  readonly close: () => Promise<void>;
}

/** 部 1 つの、画面の操作だけの通し。 */
const describePart = (label: string, startSite: () => Promise<PartSite>): void => {
  let site: PartSite | undefined;
  const siteOf = (): PartSite => {
    if (site === undefined) {
      throw new Error('fixture のサイトが起動していない');
    }
    return site;
  };
  const flow = createScenarioMarkerFlow({
    label: `opg-${label.toLowerCase()}`,
    profileIds: () => [PROFILE_ID],
    secretMarkers: () => siteOf().secretValues(),
    extraScreenPaths: () => [],
    extraFunctionCalls: () => [],
    isScreenSecretPlace: (place) => /^(?:html:|browser-html:\d+:|function:)/u.test(place),
  });
  const listJobs = (): Promise<readonly (ServerFunctionJobRow & { readonly jobId: string; readonly jobKind: string })[]> =>
    flow.valueOf('listAuditJobsFn', 'GET');
  const waitForNoActiveJob = (): Promise<void> =>
    waitForNoActiveJobViaServerFunctions(listJobs, PROFILE_ID, { limitMs: JOB_TIMEOUT_MS, stepMs: CHAIN_POLL_MS });

  /** サイトの画面の今の様子（要点の書き込みの 1 行、チェックした行の結果、主のボタン）。 */
  const siteScreenOf = async (page: Page): Promise<Omit<InspectionSeen, 'chain' | 'writes' | 'arrivedAutomatically' | 'visitedJobPaths' | 'inspectionJobPath' | 'chainStagesSeen'>> => {
    await page.getByTestId('profile-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    const wrote = page.getByTestId('profile-arrival-wrote');
    const row = page.getByTestId('write-screens').locator('[data-testid="write-screen-row"][data-state="CHECKED"]').first();
    const last = row.getByTestId('write-screen-last-result');
    const update = row.getByTestId('write-screen-update-state');
    return {
      wroteLine: await wrote.count() === 0 ? null : await wrote.textContent(),
      rowLastResult: await last.count() === 0 ? null : await last.textContent(),
      rowUpdateState: await update.count() === 0 ? null : await update.textContent(),
      primaryActions: await page.locator('main .button--primary').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-action') ?? '')),
    };
  };

  /** サイトの画面の主のボタン「点検を始める」→ 開始の画面の「点検を始める」で点検を始め、終わるまで待ち、画面で結果を見る。 */
  const inspectOnScreen = async (): Promise<InspectionSeen> => {
    const page = await flow.openPage(`/profiles/${PROFILE_ID}`);
    await page.getByTestId('profile-summary').locator('[data-action="AUDIT_START"]').click({ timeout: UI_TIMEOUT_MS });
    await page.waitForURL(new RegExp(`/start/${PROFILE_ID}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await page.getByTestId('start-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    // OP-G（指示書の 5）: チェックした画面があるので、開始の画面は「チェックした画面では登録・更新します」と言い、「読むだけ」と言わない。
    expect(await page.getByTestId('start-what-happens').textContent()).toBe(LOCAL_UI_AUDIT_TEXT.start.whatHappensWithWrites);
    expect(await page.getByTestId('start-write-mode-read-only').count()).toBe(0);
    if (await page.locator('input[name="start-mode"]').count() > 0) {
      await openAdvancedSettings(page, 'start-advanced-settings', UI_TIMEOUT_MS);
      await page.getByRole('radio', { name: LOCAL_UI_AUDIT_TEXT.start.startNew }).check();
    }
    await page.getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.start.submit }).click();
    await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
    const jobId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    flow.jobs.push({ jobId, profileId: PROFILE_ID });
    // OP-G2（OP-G の指示書の 6）: 段が進んでも、見ている画面は点検の作業の画面にとどまり、要点の 1 行目が今の段を言う。開いた作業の画面の path と、言った段を集める
    // （画面は同じ文書の中で移るので、集めた値は、サイトの画面へ移った後も読める）。
    const visitedJobPaths = new Set<string>([new URL(page.url()).pathname]);
    const onNavigated = (frame: ReturnType<Page['mainFrame']>): void => {
      const path = new URL(frame.url()).pathname;
      if (frame === page.mainFrame() && path.startsWith('/jobs/')) {
        visitedJobPaths.add(path);
      }
    };
    page.on('framenavigated', onNavigated);
    await page.evaluate(() => {
      const seen = new Set<string>();
      const record = (): void => {
        for (const element of document.querySelectorAll('[data-chain-stage]')) {
          const stage = element.getAttribute('data-chain-stage') ?? '';
          if (stage !== '') {
            seen.add(stage);
          }
        }
      };
      new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      record();
      (window as unknown as { opg2ChainStages: Set<string> }).opg2ChainStages = seen;
    });
    await waitForNoActiveJob();
    const { stageChain } = await flow.valueOf<{ readonly stageChain: ChainValue | null }>('getAuditJobFn', 'GET', { jobId });
    if (stageChain === null) {
      throw new Error('the inspection is not a chain');
    }
    const writes = await Promise.all(stageChain.writeStageJobIds.map((id) => flow.valueOf<WriteJobValue>('getAuditJobFn', 'GET', { jobId: id })));
    // 見ていた作業の画面は、点検が終わるとサイトの画面へ自動で移る（設計書 PL 3 章の 5。OP-G の指示書の 4）。
    let arrivedAutomatically = true;
    try {
      await page.waitForURL(new RegExp(`/profiles/${PROFILE_ID}\\?`, 'u'), { timeout: UI_TIMEOUT_MS });
    } catch {
      arrivedAutomatically = false;
      await page.goto(new URL(`/profiles/${PROFILE_ID}`, page.url()).href);
    }
    page.off('framenavigated', onNavigated);
    const chainStagesSeen = arrivedAutomatically
      ? await page.evaluate(() => [...((window as unknown as { opg2ChainStages?: Set<string> }).opg2ChainStages ?? [])])
      : [];
    const seen = await siteScreenOf(page);
    const screens = { visitedJobPaths: [...visitedJobPaths], inspectionJobPath: `/jobs/${jobId}`, chainStagesSeen };
    console.info(`[OP-G ${label}] inspection: ${JSON.stringify({ chain: stageChain, writes, arrivedAutomatically, ...screens, ...seen })}`);
    return { chain: stageChain, writes, arrivedAutomatically, ...screens, ...seen };
  };

  beforeAll(async () => {
    await flow.start();
    site = await startSite();
    writeAuthTargetConfig(flow.rootOf(), PROFILE_ID, site.origin, site.startPath, MAX_PAGES, NAVIGATION_INTERVAL_MS);
  }, PART_TIMEOUT_MS);

  afterEach(async () => {
    await flow.closePages();
  });

  afterAll(async () => {
    await flow.stop();
    await site?.close();
  }, PART_TIMEOUT_MS);

  it(`${label}: creates, checks the screen, then the next inspections create and update it, and the screen tells exactly what was done`, async () => {
    // 1. 作成の画面: 開始のアドレスだけを入れて「点検を始める」。下調べ → 1 回目の点検（手でのログイン。人の代わりに入口が入れる）→ 操作さがし。
    flow.relayOf().provide(await siteOf().credentials());
    const create = await flow.openPage('/profiles/new');
    await createProfileOnScreen(create, { startUrl: `${siteOf().origin}${siteOf().startPath}`, usage: 'TEST_AUTH' }, UI_TIMEOUT_MS);
    await create.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
    const entryJobId = new URL(create.url()).pathname.split('/').at(-1) ?? '';
    expect(await flow.waitForJobEnd(entryJobId)).toMatchObject({ jobKind: WORKER_ENTRY_CHECK_JOB_KIND, state: 'FINISHED' });
    await create.waitForURL((url) => url.pathname.startsWith('/jobs/') && !url.pathname.endsWith(entryJobId), { timeout: JOB_TIMEOUT_MS });
    await waitForNoActiveJob();
    for (const job of (await listJobs()).filter((row) => row.profileId === PROFILE_ID)) {
      flow.jobs.push({ jobId: job.jobId, profileId: PROFILE_ID });
    }
    expect((await flow.valueOf<{ profile: Record<string, unknown> }>('getProfileFn', 'GET', { profileId: PROFILE_ID })).profile)
      .toMatchObject({ auth: 'AUTOMATED_LOGIN' });

    // 2. サイトの画面の「登録・更新を試せる画面」の一覧で、登録の画面にチェックする（ボタンもダイアログもない）。
    const profile = await flow.openPage(`/profiles/${PROFILE_ID}`);
    const rows = profile.getByTestId('write-screens').locator('[data-testid="write-screen-row"][data-state="CHECKABLE"]');
    await rows.first().waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await rows.count()).toBe(1);
    // OP-G（指示書の 7）: 行の名前に英字の path を出さない（見出しが取れないときは「登録の画面（1）」の形）。
    expect(await rows.first().textContent()).not.toMatch(/[A-Za-z]/u);
    const rowKey = await rows.first().getAttribute('data-row-key');
    await rows.first().getByTestId('write-screen-check').click();
    const checked = profile.locator(`[data-testid="write-screen-row"][data-row-key="${rowKey ?? ''}"]`);
    await expect.poll(() => checked.getAttribute('data-state'), { timeout: JOB_TIMEOUT_MS }).toBe('CHECKED');
    expect(await checked.getByTestId('write-screen-rejection').count()).toBe(0);
    await flow.closePages();

    // 3. 2 回目の点検（自動ログイン）: 読み取りの段の後に、チェックした画面の登録。データがないので、更新の画面はまだない（次の点検で試す）。
    const creates0 = siteOf().createRequests().length;
    const updates0 = siteOf().updateRequests().length;
    const second = await inspectOnScreen();
    await wait(LATE_REQUEST_WAIT_MS);
    expect(second.chain).toMatchObject({ state: 'FINISHED', stopReason: null });
    expect(second.writes.map(({ jobKind, write }) => [jobKind, write?.result ?? null])).toEqual([['WRITE_CREATE', 'VERIFIED']]);
    expect(siteOf().createRequests().length - creates0).toBe(1);
    expect(siteOf().updateRequests().length - updates0).toBe(0);
    expect(second.arrivedAutomatically).toBe(true);
    expect(second.visitedJobPaths).toEqual([second.inspectionJobPath]);
    expect(second.chainStagesSeen.length).toBeGreaterThan(0);
    expect(second.rowLastResult).toBe(writeText.lastResult.createdOnly);
    expect(second.rowUpdateState).toBe(writeText.update.NEXT_INSPECTION);
    expect(second.wroteLine).toBe(writeText.inspectionWrite.CREATED);
    expect(second.primaryActions).toEqual(['AUDIT_RESULT']);
    await flow.closePages();

    // 4. 自動ログインの間隔の決まりの間は、サイトの画面の主のボタンは「結果を見る」。間隔が過ぎたら「点検を始める」が出る（画面を読み直して待つ）。
    const waiting = await flow.openPage(`/profiles/${PROFILE_ID}`);
    await waiting.getByTestId('profile-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await waiting.locator('main .button--primary').count()).toBe(1);
    expect(await waiting.getByTestId('profile-summary').locator('.button--primary[data-action="AUDIT_RESULT"]').count()).toBe(1);
    const deadline = Date.now() + AUTO_LOGIN_MIN_INTERVAL_MS + INTERVAL_MARGIN_MS;
    for (;;) {
      await waiting.reload();
      await waiting.getByTestId('profile-summary').waitFor({ timeout: UI_TIMEOUT_MS });
      if (await waiting.getByTestId('profile-summary').locator('[data-action="AUDIT_START"]').count() > 0) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error('the automated login interval did not pass');
      }
      await wait(INTERVAL_POLL_MS);
    }
    await flow.closePages();

    // 5. 3 回目の点検（自動ログイン）: 操作さがしが作ったデータの更新の画面を見つけるので、同じ点検で登録 → 更新。どちらも確かめられ、行と要点が一致する。
    const creates1 = siteOf().createRequests().length;
    const updates1 = siteOf().updateRequests().length;
    const third = await inspectOnScreen();
    await wait(LATE_REQUEST_WAIT_MS);
    expect(third.chain).toMatchObject({ state: 'FINISHED', stopReason: null });
    expect(third.writes.map(({ jobKind, write }) => [jobKind, write?.result ?? null])).toEqual([['WRITE_CREATE', 'VERIFIED'], ['WRITE_UPDATE', 'VERIFIED']]);
    expect(siteOf().createRequests().length - creates1).toBe(1);
    expect(siteOf().updateRequests().length - updates1).toBe(1);
    expect(third.arrivedAutomatically).toBe(true);
    expect(third.visitedJobPaths).toEqual([third.inspectionJobPath]);
    expect(third.chainStagesSeen.length).toBeGreaterThan(0);
    expect(third.rowLastResult).toBe(writeText.lastResult.line(writeText.lastResult.created, writeText.lastResult.updated));
    expect(third.wroteLine).toBe(writeText.inspectionWrite.WROTE);
    expect(third.primaryActions).toEqual(['AUDIT_RESULT']);
    expect(siteOf().members()).toBe(2);
    await flow.closePages();

    // 6. OP-H（撮影 UI-W4 の 1）: 更新の後も、作ったデータの一覧が開ける（前は API の形の更新の後に 500 で開けなかった）。登録 2 件の行が出て、3 回目の更新は、
    // その台帳の登録の 1 行にだけ数えられ、確かめられている。
    const ledger = await flow.openPage(`/ledger/${PROFILE_ID}`);
    await ledger.getByTestId('ledger').waitFor({ timeout: UI_TIMEOUT_MS });
    const entries = ledger.getByTestId('ledger-entry');
    expect(await entries.count()).toBe(2);
    const updated = await entries.evaluateAll((elements) => elements.map((element) =>
      [element.getAttribute('data-update-count'), element.getAttribute('data-last-update-result')]));
    expect([...updated].sort()).toEqual([['0', ''], ['1', 'VERIFIED']]);
  }, PART_TIMEOUT_MS);
};

describe('OP-G part A: the SPA with the API-shaped member screens, on the screen only', () => {
  describePart('A', async () => {
    const spa: SpaAuthSite = await startSpaAuthSite({ memberScreenLayout: 'formless', memberDetailPage: true });
    const memberPath = '/rest/v1/members';
    const writes = (method: string): readonly string[] => spa.requests
      .filter((request) => !request.preflight && request.method === method && request.path.split('?')[0] === memberPath)
      .map((request) => `${request.method} ${request.path}`);
    return {
      origin: spa.appOrigin,
      startPath: SPA_APP_PATHS.admin,
      secretValues: () => spa.secretValues(),
      credentials: async () => {
        const fields: (readonly [string, string])[] = [];
        await spa.fillCredentials(async (selector, value) => {
          fields.push([selector, value]);
        });
        return { fields, submit: SPA_LOGIN_FIELDS.submit };
      },
      createRequests: () => writes('POST'),
      updateRequests: () => writes('PATCH'),
      members: () => spa.memberCount,
      close: () => spa.close(),
    };
  });
});

describe('OP-G part B: the form-shaped site, on the screen only', () => {
  describePart('B', async () => {
    const form: WriteSite = await startWriteSite();
    form.enableUpdatePages();
    const posts = (update: boolean): readonly string[] => nonLoginPostsOf(form)
      .filter((path) => (path === WRITE_SITE_PATHS.create) !== update)
      .map((path) => `POST ${path}`);
    return {
      origin: form.origin,
      startPath: WRITE_SITE_PATHS.list,
      secretValues: () => form.secretValues(),
      credentials: async () => {
        const fields: (readonly [string, string])[] = [];
        await form.fillCredentials(async (selector, value) => {
          fields.push([selector, value]);
        });
        return { fields, submit: WRITE_SITE_LOGIN_FIELDS.submit };
      },
      createRequests: () => posts(false),
      updateRequests: () => posts(true),
      members: () => form.members,
      close: () => form.close(),
    };
  });
});

/** フォームの形のサイトに届いた、ログインでない POST の path。 */
const nonLoginPostsOf = (form: WriteSite): readonly string[] => form.requests
  .filter(({ method, path }) => method === 'POST' && path.split('?')[0] !== WRITE_SITE_PATHS.login)
  .map(({ path }) => path.split('?')[0] ?? path);

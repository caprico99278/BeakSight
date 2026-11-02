// OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'〜D9'、4.1.2 の案 C）: 点検（まとめて実行。監査 → 発見 → READ の確かめ）の最後に、
// チェックした画面（承認した登録のシナリオと、その台帳の更新のシナリオ）ごとに、登録 → 更新の書き込みの段を足す。ジョブの管理・本物のワーカー（fork）・
// 書き込みの流れ・factory・Guard を、127.0.0.1 の fixture のサイトで、2 つの Chromium（CLI の起動の設定と、テストの既定の headless shell）で確かめる。
// - ログインは点検の 1 回だけ（サーバのログインの成功の数）。書き込みの POST は、画面ごとに登録 1 件と更新 1 件。どちらも照合まで済む（`VERIFIED`）。
// - 読み込みの間隔（境目を含む。登録の POST の直後の redirect の GET と、ログインの POST とその着地を除く）を守る。秘密の目印はどこにも出ない。
// - チェックしていない（承認していない）プロファイルの点検は、書き込みの段を持たず、何も送らない（読み取りの段の報告は今のまま）。
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DISCOVERY_ARTIFACT_FILE_NAME,
  READ_EVIDENCE_ARTIFACT_FILE_NAME,
  RUN_ARTIFACT_FILE_NAMES,
  artifactFilePath,
} from '../../src/core/artifact-layout.js';
import { discoveryCandidatesOf, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { listScenarios } from '../../src/control/approval/scenario-store.js';
import { updateLedgerScenarioIdOf } from '../../src/control/approval/scenario-contracts.js';
import { readWriteResult, readWriteResults } from '../../src/control/actions/write-result-facts.js';
import { getProfile } from '../../src/control/store/profile-store.js';
import { wait } from '../../src/core/deadline.js';
import {
  LATE_DELIVERY_SETTLE_MS,
  MINUTE_MS,
  READ_METHODS,
  WRITE_JOB_NAVIGATION_INTERVAL_MS,
  startWriteJobHarness,
  type WriteJobHarness,
  type WriteJobRunBrowser,
} from '../helpers/write-job-harness.js';
import { WRITE_SITE_PATHS } from '../helpers/write-site-fixture.js';
import { HTML_REPORT_TEXT } from '../../src/presentation/messages.js';
import { escapeHtml } from '../../src/report/html-components.js';

const TEST_TIMEOUT_MS = 600_000;
/** 連鎖の終わりを待つ上限（ms）と、確かめる間隔（ms）。 */
const CHAIN_WAIT_LIMIT_MS = 300_000;
const CHAIN_POLL_MS = 200;
/** 次の点検の前に、管理の時計を進める長さ（自動ログインと書き込みの、続けて行えない間隔を越える）。 */
const NEXT_INSPECTION_CLOCK_STEP_MS = 10 * MINUTE_MS;

const harnesses: WriteJobHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
}, TEST_TIMEOUT_MS);

/** 点検（まとめて実行）を始め、連鎖が終わり、最後の段のジョブのワーカーが終わるまで待つ。 */
async function runInspection(
  harness: WriteJobHarness,
  onStarted?: (chainId: string) => void,
): Promise<{ readonly chainId: string; readonly view: NonNullable<ReturnType<WriteJobHarness['manager']['getStageChainOfJob']>> }> {
  const revision = getProfile(harness.database, harness.profileId)?.profile.revision ?? 0;
  const started = await harness.manager.startStageChain({ profileId: harness.profileId, expectedRevision: revision, startNew: true });
  if (!started.ok) {
    throw new Error(`the inspection did not start: ${JSON.stringify(started)}`);
  }
  const chainId = started.job.jobId;
  onStarted?.(chainId);
  const deadline = Date.now() + CHAIN_WAIT_LIMIT_MS;
  for (;;) {
    const view = harness.manager.getStageChainOfJob(chainId);
    if (view !== null && view.state !== 'RUNNING') {
      const lastJobId = view.writeStageJobIds.at(-1) ?? [...view.stages].reverse().find(({ jobId }) => jobId !== null)?.jobId ?? chainId;
      await harness.waitForEnd(lastJobId);
      return { chainId, view };
    }
    if (Date.now() > deadline) {
      throw new Error(`the inspection did not end: ${JSON.stringify(view)}`);
    }
    await wait(CHAIN_POLL_MS);
  }
}

/** 隣り合う文書の読み込みの差（ms）。登録・更新の POST の直後の redirect の GET と、ログインの POST とその着地を除く。 */
const navigationGapsOf = (requests: readonly { readonly method: string; readonly path: string; readonly at: number }[]): readonly number[] => {
  const pathOf = (path: string): string => path.split('?')[0] ?? path;
  const navigations = requests.filter((request, index) => {
    const previous = requests[index - 1];
    if (pathOf(request.path) === WRITE_SITE_PATHS.login) {
      return false;
    }
    return !(request.method === 'GET' && previous !== undefined && previous.method === 'POST');
  });
  return navigations.slice(1).map((request, index) => request.at - (navigations[index]?.at ?? request.at));
};

/**
 * OP-H（撮影 UI-W4 の 3）: 点検の監査の段の報告（`report.html`）が、まとめの段で「この後に、チェックした画面で登録・更新する」と言うか（ジョブの管理が `START` で
 * 渡したチェックした画面の数から、表示用モデルが作る）。
 */
function auditReportSaysPlannedWrites(harness: WriteJobHarness, view: { readonly stages: readonly { readonly kind: string; readonly jobId: string | null }[] }): boolean {
  const job = harness.manager.getAuditJob(view.stages.find(({ kind }) => kind === 'AUDIT')?.jobId ?? '');
  if (job === null) {
    throw new Error('no audit stage');
  }
  return readFileSync(artifactFilePath(harness.runDirectoryOf(job), RUN_ARTIFACT_FILE_NAMES.report), 'utf8').includes(escapeHtml(HTML_REPORT_TEXT.overview.plannedWrites));
}

/** OP-2 の修正の 1 回目（指示書の 9）: 違反の数を数えた段の種類ごとの数と、違反の合計。 */
interface GuardViolationTally {
  readonly stagesCounted: Readonly<Record<string, number>>;
  readonly violations: number;
}

/**
 * 点検の段ごとに、Guard（Safety Ledger）の不変条件の違反の数を、成果物と Run の状態から直接数える。
 * - 監査の段: `run.json` の `safety.invariantViolationCount`。
 * - 発見の段・READ の確かめの段: `discovery.json`・`read-evidence.json` の `safetyViolation.invariantViolationCount`（違反がなければ項目がない）。
 * - 書き込みの段: 違反があれば Run は `ABORTED_BY_SAFETY` になる（`action-run.json` は違反の数を持たない）。その段を 1 つの違反として数える。
 */
function guardViolationsOf(harness: WriteJobHarness, view: { readonly stages: readonly { readonly kind: string; readonly jobId: string | null }[]; readonly writeStageJobIds: readonly string[] }): GuardViolationTally {
  const stagesCounted: Record<string, number> = {};
  let violations = 0;
  const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const jobViolationOf = (document: Record<string, unknown>): number =>
    ((document['safetyViolation'] as { readonly invariantViolationCount?: number } | undefined)?.invariantViolationCount ?? 0);
  const stages = [...view.stages.filter(({ jobId }) => jobId !== null), ...view.writeStageJobIds.map((jobId) => ({ kind: 'WRITE', jobId }))];
  for (const { kind, jobId } of stages) {
    const job = harness.manager.getAuditJob(jobId ?? '');
    if (job === null) {
      throw new Error(`no job for the stage ${kind}`);
    }
    if (job.resultRunStatus === 'ABORTED_BY_SAFETY') {
      violations += 1;
    }
    if (kind === 'AUDIT') {
      const run = readJson(artifactFilePath(harness.runDirectoryOf(job), RUN_ARTIFACT_FILE_NAMES.run));
      violations += (run['safety'] as { readonly invariantViolationCount: number }).invariantViolationCount;
    } else if (kind === 'DISCOVERY') {
      violations += jobViolationOf(readJson(artifactFilePath(harness.runDirectoryOf(job), DISCOVERY_ARTIFACT_FILE_NAME)));
    } else if (kind === 'READ_CHECK') {
      violations += jobViolationOf(readJson(artifactFilePath(harness.runDirectoryOf(job), READ_EVIDENCE_ARTIFACT_FILE_NAME)));
    }
    stagesCounted[kind] = (stagesCounted[kind] ?? 0) + 1;
  }
  return { stagesCounted, violations };
}

describe.each<WriteJobRunBrowser>(['CLI', 'TEST_DEFAULT'])('OP-2: the write stages at the end of the inspection (%s Chromium)', (runBrowser) => {
  it('logs in once and creates then updates on the checked screen, each sent once and verified, keeping the interval', async () => {
    const harness = await startWriteJobHarness({ profileId: `example-op2-${runBrowser.toLowerCase().replace('_', '-')}`, clockOffsetMs: -60 * MINUTE_MS, runBrowser });
    harnesses.push(harness);
    const { site, database } = harness;
    site.enableUpdatePages();
    site.addMember('既存一郎');
    // 1 回目の点検（ログインの直後の登録を済ませる。設計書 4.1 の D4）。その後に、操作さがしの結果から、答え合わせと、チェック（承認）した登録と更新を作る。
    const first = await runInspection(harness);
    expect(first.view.writeStageJobIds).toEqual([]);
    // OP-H: チェックした画面がまだない点検の報告は、書き込みのことを言わない。
    expect(auditReportSaysPlannedWrites(harness, first.view)).toBe(false);
    const discoveryJob = harness.manager.getAuditJob(first.view.stages.find(({ kind }) => kind === 'DISCOVERY')?.jobId ?? '');
    if (discoveryJob === null) {
      throw new Error('no discovery stage');
    }
    const document = JSON.parse(readFileSync(artifactFilePath(harness.runDirectoryOf(discoveryJob), DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
    harness.createReadCheck(document);
    await harness.approvedScenario(document, { scenarioId: 'sc-create', names: ['甲一郎', '甲二郎'] });
    await harness.approvedUpdateScenario(document, {
      scenarioId: 'sc-update', names: ['乙一郎', '乙二郎'], targetCreateScenarioId: 'sc-create', keepFieldNames: ['email', 'note', 'newsletter', 'published'],
    });
    const since = site.requests.length;
    const loginsBefore = site.successfulLogins;

    // 2 回目の点検: 読み取りの段の後に、登録 → 更新。
    const { view } = await runInspection(harness);
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(view.state).toBe('FINISHED');
    expect(view.stopReason).toBeNull();
    expect(view.writeStageJobIds).toHaveLength(2);
    // OP-H: チェックした画面がある点検の監査の段の報告は、まとめの段で、この後に登録・更新することを言う。
    expect(auditReportSaysPlannedWrites(harness, view)).toBe(true);
    const [createJobId, updateJobId] = view.writeStageJobIds;
    expect(readWriteResult(database, createJobId ?? '')).toMatchObject({ writeKind: 'CREATE', submission: 'SENT', result: 'VERIFIED', reservationState: 'COMMITTED' });
    const created = readWriteResult(database, createJobId ?? '');
    expect(readWriteResult(database, updateJobId ?? '')).toMatchObject({
      writeKind: 'UPDATE', submission: 'SENT', result: 'VERIFIED', reservationState: 'COMMITTED', targetRecordId: created?.recordId,
    });
    for (const jobId of [createJobId, updateJobId]) {
      expect(harness.manager.getAuditJob(jobId ?? '')).toMatchObject({ state: 'FINISHED', failureReason: null, writeReportCheck: 'VALID' });
    }
    // ログインは点検の 1 回だけ。書き込みの POST は、登録 1 件と更新 1 件だけ。
    expect(site.successfulLogins - loginsBefore).toBe(1);
    expect(harness.createPosts(since)).toEqual([WRITE_SITE_PATHS.create]);
    expect(harness.updatePosts(since)).toHaveLength(1);
    const nonReads = site.requests.slice(since).filter(({ method, path }) => !READ_METHODS.has(method) && path !== WRITE_SITE_PATHS.login);
    expect(nonReads).toHaveLength(2);
    // 読み込みの間隔（段の境目を含む）。
    const gaps = navigationGapsOf(site.requests.slice(since));
    expect(gaps.length).toBeGreaterThan(5);
    expect(gaps.filter((gap) => gap < WRITE_JOB_NAVIGATION_INTERVAL_MS)).toEqual([]);
    // 指示書の 9: Guard の違反の数を、段ごとの成果物から直接数える（監査・発見・READ の確かめ・書き込みの 2 段を、すべて数えたこと）。
    expect(guardViolationsOf(harness, view)).toEqual({ stagesCounted: { AUDIT: 1, DISCOVERY: 1, READ_CHECK: 1, WRITE: 2 }, violations: 0 });
    expect(harness.leakedPlaces()).toEqual([]);
    await harness.expectNoProcessLeft();
  }, TEST_TIMEOUT_MS);

  // OP-2 の修正の 3 回目（設計書 4.1.2 の R1。設計者の判断（案 A））: データのないサイトでは、チェックした画面の最初の点検は登録だけ（更新の画面はまだない）。次の点検の
  // 操作さがしが、作ったデータの更新の画面を見つけるので、ジョブの管理が書き込みの段の前に、その点検の操作さがしの結果で更新の下書きと承認を 1 回だけ行い、同じ点検で
  // 登録 → 更新を送る。どの点検もログインは 1 回、POST は点検ごとに数のとおり、間隔を守り、違反 0。
  it('creates only on the first inspection without data, then drafts, approves and runs the update in the next inspection', async () => {
    const harness = await startWriteJobHarness({ profileId: `example-op2r-${runBrowser.toLowerCase().replace('_', '-')}`, clockOffsetMs: -60 * MINUTE_MS, runBrowser });
    harnesses.push(harness);
    const { site, database } = harness;
    site.enableUpdatePages();
    // 下準備の点検（ログインの直後の登録を済ませる）。データがないので、更新の画面の候補はない。
    const first = await runInspection(harness);
    const discoveryJob = harness.manager.getAuditJob(first.view.stages.find(({ kind }) => kind === 'DISCOVERY')?.jobId ?? '');
    if (discoveryJob === null) {
      throw new Error('no discovery stage');
    }
    const document = JSON.parse(readFileSync(artifactFilePath(harness.runDirectoryOf(discoveryJob), DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
    expect(discoveryCandidatesOf(document).filter(({ classification }) => classification === 'UPDATE')).toEqual([]);
    harness.createReadCheck(document);
    await harness.approvedScenario(document, { scenarioId: 'sc-create', names: ['丙一郎', '丙二郎', '丙三郎'] });

    // 1 回目（チェックの後）: 登録だけ。更新のシナリオは作らない。
    const since1 = site.requests.length;
    const logins1 = site.successfulLogins;
    const once = await runInspection(harness);
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(once.view).toMatchObject({ state: 'FINISHED', stopReason: null });
    expect(once.view.writeStageJobIds).toHaveLength(1);
    expect(readWriteResult(database, once.view.writeStageJobIds[0] ?? '')).toMatchObject({ writeKind: 'CREATE', result: 'VERIFIED' });
    expect(listScenarios(database, harness.profileId).filter(({ current }) => current.kind === 'UPDATE')).toEqual([]);
    expect(site.successfulLogins - logins1).toBe(1);
    expect(harness.createPosts(since1)).toEqual([WRITE_SITE_PATHS.create]);
    expect(harness.updatePosts(since1)).toEqual([]);
    expect(navigationGapsOf(site.requests.slice(since1)).filter((gap) => gap < WRITE_JOB_NAVIGATION_INTERVAL_MS)).toEqual([]);
    expect(guardViolationsOf(harness, once.view)).toEqual({ stagesCounted: { AUDIT: 1, DISCOVERY: 1, READ_CHECK: 1, WRITE: 1 }, violations: 0 });

    // 2 回目: 操作さがしが作ったデータの更新の画面を見つけ、ジョブの管理が更新の下書きと承認をして、登録 → 更新。自動ログインの間隔（5 分）と書き込みの間隔
    // （5 分）の決まりを越えるよう、管理の時計を進める（サイトへの要求の速さは変えない）。
    harness.clockOffsetMs += NEXT_INSPECTION_CLOCK_STEP_MS;
    const since2 = site.requests.length;
    const logins2 = site.successfulLogins;
    const twice = await runInspection(harness);
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(twice.view).toMatchObject({ state: 'FINISHED', stopReason: null });
    expect(twice.view.writeStageJobIds).toHaveLength(2);
    const [createJobId, updateJobId] = twice.view.writeStageJobIds;
    const created = readWriteResult(database, createJobId ?? '');
    expect(created).toMatchObject({ writeKind: 'CREATE', submission: 'SENT', result: 'VERIFIED' });
    expect(readWriteResult(database, updateJobId ?? '')).toMatchObject({
      writeKind: 'UPDATE', submission: 'SENT', result: 'VERIFIED', targetRecordId: created?.recordId,
    });
    // 更新のシナリオは、登録の台帳に結び、チェックの範囲で承認した（副作用の確認を兼ねた版）。
    const updates = listScenarios(database, harness.profileId).filter(({ current }) => current.kind === 'UPDATE');
    expect(updates.map(({ state }) => state)).toEqual(['APPROVED']);
    expect(updateLedgerScenarioIdOf(updates[0]?.current ?? (undefined as never))).toBe('sc-create');
    expect(Object.values(updates[0]?.current.sideEffectConfirmations ?? {})).toEqual([true, true, true, true]);
    expect(site.successfulLogins - logins2).toBe(1);
    expect(harness.createPosts(since2)).toEqual([WRITE_SITE_PATHS.create]);
    expect(harness.updatePosts(since2)).toHaveLength(1);
    expect(site.requests.slice(since2).filter(({ method, path }) => !READ_METHODS.has(method) && path !== WRITE_SITE_PATHS.login)).toHaveLength(2);
    expect(navigationGapsOf(site.requests.slice(since2)).filter((gap) => gap < WRITE_JOB_NAVIGATION_INTERVAL_MS)).toEqual([]);
    expect(guardViolationsOf(harness, twice.view)).toEqual({ stagesCounted: { AUDIT: 1, DISCOVERY: 1, READ_CHECK: 1, WRITE: 2 }, violations: 0 });
    expect(harness.leakedPlaces()).toEqual([]);
    await harness.expectNoProcessLeft();
  }, TEST_TIMEOUT_MS);

  it('has no write stage and sends nothing when no screen is checked', async () => {
    const harness = await startWriteJobHarness({ profileId: `example-op2n-${runBrowser.toLowerCase().replace('_', '-')}`, clockOffsetMs: -60 * MINUTE_MS, runBrowser });
    harnesses.push(harness);
    const { site } = harness;
    const { document } = await harness.discover();
    harness.createReadCheck(document);
    const since = site.requests.length;
    const { view } = await runInspection(harness);
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(view.state).toBe('FINISHED');
    expect(view.writeStageJobIds).toEqual([]);
    expect(site.requests.slice(since).filter(({ method, path }) => !READ_METHODS.has(method) && path !== WRITE_SITE_PATHS.login)).toEqual([]);
    expect(guardViolationsOf(harness, view)).toMatchObject({ stagesCounted: { AUDIT: 1, DISCOVERY: 1, READ_CHECK: 1 }, violations: 0 });
    expect(harness.leakedPlaces()).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

// OP-F（安全のレビュー OP-REV の M-1）: 「やめる」を押したのが、親が書き込みの段を準備している間（最後の読み取りの段の後、`NEXT_STAGE` の前）でも、書き込みの段を
// 始めない。値の候補が尽きてチェックした画面を試せなかった点検は、黙って「最後まで行った」にせず、試せなかった理由で終える。送らずに止めた回の値は、使った扱いに
// しない（設計書 4.1.2 の R4）。押す時を時間に頼らずに作るため、ジョブの管理が書き込みの準備の中で資格情報のメタデータを読む時に押す（テストの口）。
describe.each<WriteJobRunBrowser>(['CLI', 'TEST_DEFAULT'])('OP-F M-1: the stop while the parent prepares the write stage (%s Chromium)', (runBrowser) => {
  it('does not start the write stage after the stop, then creates with the same value, and ends with the reason when no value is left', async () => {
    const harness = await startWriteJobHarness({ profileId: `example-opf-m1-${runBrowser.toLowerCase().replace('_', '-')}`, clockOffsetMs: -60 * MINUTE_MS, runBrowser });
    harnesses.push(harness);
    const { site, database } = harness;
    // 下準備の点検（ログインの直後の登録を済ませる）。値の候補が 1 つだけの登録の画面をチェックする。
    const first = await runInspection(harness);
    expect(getProfile(database, harness.profileId)?.profile.auth).toBe('AUTOMATED_LOGIN');
    const discoveryJob = harness.manager.getAuditJob(first.view.stages.find(({ kind }) => kind === 'DISCOVERY')?.jobId ?? '');
    if (discoveryJob === null) {
      throw new Error('no discovery stage');
    }
    const document = JSON.parse(readFileSync(artifactFilePath(harness.runDirectoryOf(discoveryJob), DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
    harness.createReadCheck(document);
    await harness.approvedScenario(document, { scenarioId: 'sc-create', names: ['丁一郎'] });

    /** 書き込みの準備の中の、`where` に当たる資格情報のメタデータの読み出しで「やめる」を押す点検。 */
    const inspectStoppingAt = async (where: (stack: string) => boolean): Promise<Awaited<ReturnType<typeof runInspection>>> => {
      let chainId: string | null = null;
      let stopped: unknown = null;
      harness.setCredentialMetadataReadHook((stack) => {
        if (stopped === null && chainId !== null && where(stack)) {
          stopped = harness.manager.stopAuditJob(chainId);
        }
      });
      const inspected = await runInspection(harness, (id) => {
        chainId = id;
      });
      harness.setCredentialMetadataReadHook(null);
      await wait(LATE_DELIVERY_SETTLE_MS);
      expect(stopped).toMatchObject({ ok: true });
      return inspected;
    };
    const writeResultCount = (): number => readWriteResults(database, 'sc-create').length;

    // 1 回目: 許可の発行の前（書き込みの段の準備の、承認の事実を読む間）に「やめる」を押す。許可を出さず（記録の行もない）、利用者の停止で終わる。
    harness.clockOffsetMs += NEXT_INSPECTION_CLOCK_STEP_MS;
    const since1 = site.requests.length;
    const resultsBefore = writeResultCount();
    const beforeGrant = await inspectStoppingAt((stack) => stack.includes('advanceToWriteStage') && !stack.includes('prepareWrite') && !stack.includes('prepareChainUpdates'));
    expect(beforeGrant.view).toMatchObject({ state: 'STOPPED', stopReason: 'USER_STOPPED' });
    expect(beforeGrant.view.writeStageJobIds).toEqual([]);
    expect(writeResultCount()).toBe(resultsBefore);

    // 2 回目: 書き込みの準備の中（`NEXT_STAGE` の前）で「やめる」を押す。書き込みの段を始めず（送らずに締める）、利用者の停止で終わる。
    harness.clockOffsetMs += NEXT_INSPECTION_CLOCK_STEP_MS;
    const once = await inspectStoppingAt((stack) => stack.includes('prepareWrite'));
    expect(once.view).toMatchObject({ state: 'STOPPED', stopReason: 'USER_STOPPED' });
    expect(once.view.writeStageJobIds).toEqual([]);
    expect(harness.createPosts(since1)).toEqual([]);

    // 3 回目: 送らずに止めた回の値は使った扱いにしないので、同じ値で登録できる。
    harness.clockOffsetMs += NEXT_INSPECTION_CLOCK_STEP_MS;
    const since2 = site.requests.length;
    const twice = await runInspection(harness);
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(twice.view).toMatchObject({ state: 'FINISHED', stopReason: null });
    expect(twice.view.writeStageJobIds).toHaveLength(1);
    expect(readWriteResult(database, twice.view.writeStageJobIds[0] ?? '')).toMatchObject({ writeKind: 'CREATE', submission: 'SENT', result: 'VERIFIED' });
    expect(harness.createPosts(since2)).toEqual([WRITE_SITE_PATHS.create]);

    // 4 回目: 値の候補が尽きたので、チェックした画面を試せない。黙って「最後まで行った」にせず、試せなかった理由で終える。何も送らない。
    harness.clockOffsetMs += NEXT_INSPECTION_CLOCK_STEP_MS;
    const since3 = site.requests.length;
    const third = await runInspection(harness);
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(third.view).toMatchObject({ state: 'STOPPED', stopReason: 'WRITE_NOT_TRIED' });
    expect(third.view.writeStageJobIds).toEqual([]);
    expect(harness.createPosts(since3)).toEqual([]);
    expect(site.requests.slice(since1).filter(({ method, path }) => !READ_METHODS.has(method) && path !== WRITE_SITE_PATHS.login)).toHaveLength(1);
    expect(harness.leakedPlaces()).toEqual([]);
    await harness.expectNoProcessLeft();
  }, TEST_TIMEOUT_MS);
});

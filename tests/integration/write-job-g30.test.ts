// T30h-1（Task 30 の設計書 6 章、8 章の G30）: 承認された CREATE の完了条件を、ジョブの管理（`createAuditJobManager`）から本物のワーカー
// （`child_process.fork`。一時のビルド）と本物の Chromium（headless だけ）と 127.0.0.1 の fixture のサイト（`tests/helpers/write-site-fixture.ts`）で、
// 端から端まで確かめる。準備は `tests/helpers/write-job-harness.ts`。
// - 二重の登録 0: 同じ許可で同時に 2 回始める（1 つだけ始まる）、書き込みの間に別のシナリオの許可を出す（同時に 1 つの枠）、同じ許可の 2 回目の開始
//   （消費の 2 回目）、終わった直後の次の許可（5 分の間隔）。登録の POST は 1 件だけ。
// - 上限の超過 0: 1 回の Run に 2 件の許可、累積の上限 1（`UNKNOWN` も使った件数として数える）、5 分の間隔、24 時間に 5 件（記録の時刻を入れた形）。
//   上限を超える開始は拒まれ、POST は届かない。
// - 結果が分からないのに成功と偽る 0: サーバが 5xx を返す・応答の前に接続を切る・POST の後にワーカーを止める（異常終了）・POST の後に画面のサーバを
//   止めて作り直す（再起動の後の回復）で、結果は `UNKNOWN`（`VERIFIED` にならない）、予約は `UNKNOWN`。自動の再試行はない（POST は回ごとに 1 件）。
//   件数を使ったものとして数え、間隔の後の次の Run は実行できる（`VERIFIED`）。
// - 承認の範囲の外の書き込み 0: 撤回の後、承認の後にシナリオを変えた後（開始で止まる）、開始の後の撤回（送る直前の確かめ直しで止まる）、画面の
//   候補が変わった後（画面の確かめで止まる）、発見の後に候補が変わった後（許可が出ない）。POST は 0。T30R-fix-1（DEF-103）: 書き込みの段の
//   書き込みの画面の GET が届いた後の撤回（前の確かめ直しの位置を過ぎた後）でも、POST は 0（親の STOP と、押す直前の確かめ直しのそれぞれで）。
// - 全部の回の後に 2 秒待って、サーバの記録をもう一度数える。秘密の目印が、管理データ（WAL を含む）、IPC、ワーカーの出力、出力先のすべてのファイル、
//   ジョブの値に出ない。送った値（合成のテストデータ）は、管理データの決まった表（書き込みの結果、送る前の記録）と `action-run.json` だけ。
// - 時計: ワーカーは本物の時計で時刻を書くので、ジョブの管理の時計（`clockOffsetMs`）を本物の時計より前に置いて、段ごとに進める（5 分の間隔を
//   待たずに越える）。24 時間に 5 件は、記録の時刻を入れた許可・消費・送る前の記録・締め（本番の部品の公開の口）で作る。
// - ワーカーの Chromium は、本番の依存（CLI の起動の設定の headless）。テストの既定の Chromium と CLI の Chromium の両方の流れは、同じ process の中の
//   `write-create-run.test.ts` が確かめる（このファイルは、環境の変数に関わらず同じ Browser を使う）。
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import { readWriteResult } from '../../src/control/actions/write-result-facts.js';
import {
  consumeExecutionGrant,
  issueExecutionGrant,
  readExecutionGrant,
  readScenario,
  recordWriteAttempt,
  revokeScenarioApproval,
  settleWriteResult,
  updateScenario,
} from '../../src/control/approval/scenario-store.js';
import type { DataSeed } from '../../src/control/data-rules/deterministic-stream.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import { ACTION_RUN_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { discoveryCandidatesOf, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { ALL_CONFIRMED } from '../unit/approval-samples.js';
import {
  LATE_DELIVERY_SETTLE_MS,
  MINUTE_MS,
  WRITE_JOB_VERIFICATION,
  startWriteJobHarness,
  type WriteJobHarness,
} from '../helpers/write-job-harness.js';
import { isWriteValueArtifactPlace } from '../helpers/write-report-checks.js';
import { WRITE_SITE_PATHS } from '../helpers/write-site-fixture.js';

const SUITE_TIMEOUT_MS = 900_000;
const STEP_TIMEOUT_MS = 240_000;
const WAIT_POLL_MS = 50;
const POST_WAIT_LIMIT_MS = 60_000;
/** 管理の時計の始まり（本物の時計の 4 時間前。段ごとに進める）。 */
const START_OFFSET_MS = -240 * MINUTE_MS;
/** 段の間に進める時間（5 分の間隔と許可の 5 分の期限を越える）。 */
const STEP_MS = 10 * MINUTE_MS;
/** 24 時間に 5 件の確かめで作る書き込みの間隔（5 分の間隔を越える）。 */
const DAILY_SPACING_MS = 6 * MINUTE_MS;
const DAILY_WRITES = 5;
/** 書き込みのジョブの中の、書き込みの段の書き込みの画面の GET の順番（1 件目は画面の確かめの段）。 */
const WRITE_STAGE_FORM_GET_ORDINAL = 2;

/** シナリオ（名前は、照合の READ の行が混ざらないようにシナリオごとに別の値）。 */
const S = Object.freeze({
  dup: { scenarioId: 'scenario-dup', names: ['重複一郎'] },
  cumulative: { scenarioId: 'scenario-cumulative', names: ['累積一郎', '累積二郎'], limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 1 } },
  unknown: { scenarioId: 'scenario-unknown', names: ['不明一郎', '不明二郎', '不明三郎', '不明四郎'] },
  daily: { scenarioId: 'scenario-daily', names: ['日次一郎'] },
  revoke: { scenarioId: 'scenario-revoke', names: ['撤回一郎'] },
  change: { scenarioId: 'scenario-change', names: ['変更一郎'] },
  recheck: { scenarioId: 'scenario-recheck', names: ['直前一郎'] },
  lateStop: { scenarioId: 'scenario-late-stop', names: ['後撤一郎'] },
  lateRecheck: { scenarioId: 'scenario-late-recheck', names: ['後撤二郎'] },
  form: { scenarioId: 'scenario-form', names: ['画面一郎'] },
});

let harness: WriteJobHarness;
let discovery: DiscoveryDocument;
/** これまでに届いてよいと確かめた登録の POST の数。 */
let expectedPosts = 0;

beforeAll(async () => {
  harness = await startWriteJobHarness({ profileId: 'example-write-g30', clockOffsetMs: START_OFFSET_MS });
  discovery = (await harness.discover()).document;
  harness.createReadCheck(discovery);
  for (const scenario of Object.values(S)) {
    await harness.approvedScenario(discovery, scenario);
  }
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  await harness?.close();
}, SUITE_TIMEOUT_MS);

/** 管理の時計を進める。 */
const advance = (ms = STEP_MS): void => {
  harness.clockOffsetMs += ms;
};

/** 登録の POST が `since` から 1 件届くまで待つ。 */
async function waitForPost(since: number): Promise<void> {
  const deadline = Date.now() + POST_WAIT_LIMIT_MS;
  while (harness.createPosts(since).length === 0) {
    if (Date.now() > deadline) {
      throw new Error('the POST did not arrive');
    }
    await wait(WAIT_POLL_MS);
  }
}

/**
 * T30R-fix-1（DEF-103）: 書き込みの段の書き込みの画面の GET（`since` から 2 件目の書き込みの画面の GET。1 件目は画面の確かめ）が届くまで待つ。
 */
async function waitForWriteStageFormGet(since: number): Promise<void> {
  const deadline = Date.now() + POST_WAIT_LIMIT_MS;
  const formGets = (): number => harness.site.requests.slice(since)
    .filter(({ method, path }) => method === 'GET' && path === WRITE_SITE_PATHS.form).length;
  while (formGets() < WRITE_STAGE_FORM_GET_ORDINAL) {
    if (Date.now() > deadline) {
      throw new Error('the form GET of the write stage did not arrive');
    }
    await wait(WAIT_POLL_MS);
  }
}

/** 許可を発行し、拒まれた理由を返す（通れば null）。 */
const issueRejection = async (scenarioId: string, grantId: string, count = 1): Promise<string | null> => {
  const issued = await harness.issue(scenarioId, grantId, count);
  return issued.ok ? null : issued.reason;
};

const reservationOf = (grantId: string): string | undefined => readExecutionGrant(harness.database, grantId)?.reservation.state;

/** `action-run.json`（スキーマに通ることも確かめる）。 */
async function actionRunOf(job: AuditJobView): Promise<ActionRunDocument> {
  const value = JSON.parse(readFileSync(artifactFilePath(harness.runDirectoryOf(job), ACTION_RUN_ARTIFACT_FILE_NAME), 'utf8')) as ActionRunDocument;
  expect(await validateArtifact('action-run', value)).toEqual({ ok: true });
  return value;
}

/** 書き込みのジョブを 1 回行い、終わったジョブと、その回に届いた登録の POST の数を返す。 */
async function runWrite(scenarioId: string, grantId: string): Promise<{ readonly job: AuditJobView; readonly posts: number }> {
  const started = await harness.issueAndStart(scenarioId, grantId);
  const job = await harness.waitForEnd(started.jobId);
  return { job, posts: harness.createPosts(started.since).length };
}

describe('T30h-1: the G30 conditions end to end with the real worker', () => {
  it('no duplicate registration: one start of a grant raced twice, one write slot, no second consumption, and the interval', async () => {
    harness.site.setMode('success');
    const issued = await harness.issue(S.dup.scenarioId, 'g-dup-1');
    expect(issued.ok).toBe(true);
    const since = harness.site.requests.length;
    const starts = await Promise.all([harness.start(S.dup.scenarioId, 'g-dup-1'), harness.start(S.dup.scenarioId, 'g-dup-1')]);
    expect(starts.filter(({ ok }) => ok)).toHaveLength(1);
    expect(starts.find(({ ok }) => !ok)).toMatchObject({ ok: false });
    // 書き込みの間は、別のシナリオの許可も出ない（同時に 1 つの枠）。
    expect(await issueRejection(S.cumulative.scenarioId, 'g-cum-while')).toBe('GRANT_WRITE_CONCURRENCY_EXCEEDED');
    const job = await harness.waitForEnd('job-g-dup-1');
    expect(job).toMatchObject({ state: 'FINISHED', resultRunStatus: 'COMPLETE' });
    expect(readWriteResult(harness.database, job.jobId)).toMatchObject({ submission: 'SENT', result: 'VERIFIED', reservationState: 'COMMITTED' });
    expectedPosts += 1;
    expect(harness.createPosts(since)).toHaveLength(1);
    // 同じ許可の 2 回目の開始（消費の 2 回目）は拒まれ、消費の時刻は変わらない。
    const consumedAt = readExecutionGrant(harness.database, 'g-dup-1')?.consumedAt;
    expect(await harness.start(S.dup.scenarioId, 'g-dup-1')).toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    expect(readExecutionGrant(harness.database, 'g-dup-1')?.consumedAt).toBe(consumedAt);
    // 直後の次の許可は、5 分の間隔で出ない。
    expect(await issueRejection(S.dup.scenarioId, 'g-dup-2')).toBe('GRANT_WRITE_INTERVAL_NOT_ELAPSED');
    expect(harness.createPosts()).toHaveLength(expectedPosts);
  }, STEP_TIMEOUT_MS);

  it('no limit exceeded: two writes in a run, and the cumulative limit counts a write whose result is UNKNOWN', async () => {
    advance();
    expect(await issueRejection(S.dup.scenarioId, 'g-dup-run', 2)).toBe('GRANT_RUN_LIMIT_EXCEEDED');
    harness.site.setMode('server-error');
    const { job, posts } = await runWrite(S.cumulative.scenarioId, 'g-cum-1');
    expectedPosts += 1;
    expect(posts).toBe(1);
    // 5xx は送って応答があった回: 結果は `UNKNOWN`（成功と偽らない）、予約は `COMMITTED`（使った件数。`reservationSettlementOf` の決まり）。
    expect(readWriteResult(harness.database, job.jobId)).toMatchObject({
      submission: 'SENT', httpStatus: 500, responseJudgement: 'SERVER_ERROR', result: 'UNKNOWN', reservationState: 'COMMITTED',
    });
    expect(reservationOf('g-cum-1')).toBe('COMMITTED');
    // 結果が分からない書き込みも使った件数（累積の上限 1）。間隔の後も、許可は出ない。
    advance();
    expect(await issueRejection(S.cumulative.scenarioId, 'g-cum-2')).toBe('GRANT_CUMULATIVE_LIMIT_REACHED');
    expect(harness.createPosts()).toHaveLength(expectedPosts);
  }, STEP_TIMEOUT_MS);

  it('never claims success for an unknown result: a dropped connection, a worker stopped and a server restarted after the POST', async () => {
    advance();
    // 応答の前に接続を切る → 応答なし → UNKNOWN。
    harness.site.setMode('connection-drop');
    const dropped = await runWrite(S.unknown.scenarioId, 'g-unk-1');
    expectedPosts += 1;
    expect(dropped.posts).toBe(1);
    expect(readWriteResult(harness.database, dropped.job.jobId)).toMatchObject({
      submission: 'SENT', httpStatus: null, result: 'UNKNOWN', reservationState: 'UNKNOWN',
    });
    expect((await actionRunOf(dropped.job)).result).toBe('UNKNOWN');
    // 件数を使ったものとして数える（直後は 5 分の間隔で出ない）。
    expect(await issueRejection(S.unknown.scenarioId, 'g-unk-early')).toBe('GRANT_WRITE_INTERVAL_NOT_ELAPSED');

    // POST の後にワーカーを止める（異常終了）→ UNKNOWN。
    advance();
    harness.site.setMode('hang');
    const killed = await harness.issueAndStart(S.unknown.scenarioId, 'g-unk-2');
    await waitForPost(killed.since);
    harness.children.at(-1)?.kill();
    const killedJob = await harness.waitForEnd(killed.jobId);
    expect(harness.site.releaseHeld()).toBe(1);
    expectedPosts += 1;
    expect(harness.createPosts(killed.since)).toHaveLength(1);
    expect(killedJob).toMatchObject({ state: 'INTERRUPTED', failureReason: 'WORKER_EXITED' });
    expect(readWriteResult(harness.database, killed.jobId)).toMatchObject({ submission: 'UNKNOWN', result: 'UNKNOWN', reservationState: 'UNKNOWN' });

    // POST の後に画面のサーバ（ジョブの管理）を止めて作り直す → UNKNOWN。作り直した後の回復は、締めた結果を変えない（二重に締めない）。
    advance();
    const restarted = await harness.issueAndStart(S.unknown.scenarioId, 'g-unk-3');
    await waitForPost(restarted.since);
    const manager = await harness.recreateManager();
    expect(manager.recoverInterruptedJobs()).toBe(0);
    expect(harness.site.releaseHeld()).toBe(1);
    expectedPosts += 1;
    expect(harness.createPosts(restarted.since)).toHaveLength(1);
    expect(manager.getAuditJob(restarted.jobId)).toMatchObject({ state: 'INTERRUPTED', failureReason: 'SERVER_SHUTDOWN' });
    expect(readWriteResult(harness.database, restarted.jobId)).toMatchObject({ submission: 'UNKNOWN', result: 'UNKNOWN', reservationState: 'UNKNOWN' });
    await harness.expectNoProcessLeft();

    // 間隔の後の次の Run は実行できる（結果が分からない回の後も止まらない）。
    advance();
    harness.site.setMode('success');
    const next = await runWrite(S.unknown.scenarioId, 'g-unk-4');
    expectedPosts += 1;
    expect(next.posts).toBe(1);
    expect(readWriteResult(harness.database, next.job.jobId)).toMatchObject({ submission: 'SENT', result: 'VERIFIED', reservationState: 'COMMITTED' });
    expect(['g-unk-1', 'g-unk-2', 'g-unk-3', 'g-unk-4'].map(reservationOf)).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'COMMITTED']);
    expect(harness.createPosts()).toHaveLength(expectedPosts);
  }, STEP_TIMEOUT_MS);

  it('no limit exceeded: five writes in 24 hours (recorded at the given times) stop the next grant', async () => {
    advance();
    const baseMs = Date.now() + harness.clockOffsetMs;
    const at = (index: number): string => formatCompactUtcTimestamp(new Date(baseMs + index * DAILY_SPACING_MS), 'daily write time');
    const facts = await harness.externalFacts();
    const revision = readScenario(harness.database, S.daily.scenarioId)?.revision ?? 0;
    for (let index = 0; index < DAILY_WRITES; index += 1) {
      const grantId = `g-daily-${index}`;
      const jobId = `job-${grantId}`;
      expect(issueExecutionGrant(harness.database, {
        scenarioId: S.daily.scenarioId, expectedRevision: revision, grantId, jobId, count: 1, external: facts, at: at(index),
      }).ok).toBe(true);
      expect(consumeExecutionGrant(harness.database, {
        grantId, scenarioId: S.daily.scenarioId, scenarioRevision: revision, jobId, profileId: harness.profileId, external: facts, at: at(index),
      }).ok).toBe(true);
      expect(recordWriteAttempt(harness.database, {
        jobId, grantId,
        seedRecord: {
          seed: 'd'.repeat(64) as DataSeed,
          seedInput: { profileId: harness.profileId, scenarioId: S.daily.scenarioId, scenarioRevision: revision, ruleSetDigest: `sha256:${'e'.repeat(64)}`,
            executionGrantId: grantId },
          baseDate: at(index).slice(0, 8).replace(/^(\d{4})(\d{2})(\d{2})$/u, '$1-$2-$3'),
          attempt: 0,
        },
        submittedValues: {}, uniqueKey: null, phoneNumbers: [], at: at(index),
      }).ok).toBe(true);
      expect(settleWriteResult(harness.database, {
        jobId, submission: 'SENT', blockReason: null, httpStatus: 200, responseJudgement: 'INPUT_ERROR', recordId: null, readVerification: null,
        submittedAt: at(index), at: at(index),
      }).ok).toBe(true);
    }
    harness.clockOffsetMs = baseMs + DAILY_WRITES * DAILY_SPACING_MS - Date.now();
    expect(await issueRejection(S.daily.scenarioId, 'g-daily-next')).toBe('GRANT_DAILY_WRITE_LIMIT_REACHED');
    expect(harness.createPosts()).toHaveLength(expectedPosts);
  }, STEP_TIMEOUT_MS);

  it('no write outside the approval: after a revocation, after a change of the scenario, and a revocation during the job', async () => {
    advance();
    harness.site.setMode('success');
    // 撤回の後: 消費していない許可は無効になり、開始は拒まれる。
    expect((await harness.issue(S.revoke.scenarioId, 'g-revoke')).ok).toBe(true);
    expect(revokeScenarioApproval(harness.database, {
      scenarioId: S.revoke.scenarioId, expectedRevision: readScenario(harness.database, S.revoke.scenarioId)?.revision ?? 0, receiptId: 'revoke-1',
      at: harness.nowText(),
    }).ok).toBe(true);
    expect(await harness.start(S.revoke.scenarioId, 'g-revoke')).toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    expect(reservationOf('g-revoke')).toBe('RELEASED');

    // 承認の後にシナリオを変えた: 開始は拒まれる。
    advance();
    expect((await harness.issue(S.change.scenarioId, 'g-change')).ok).toBe(true);
    const form = discoveryCandidatesOf(discovery).find((candidate) => candidate.kind === 'FORM' && candidate.page.path === WRITE_SITE_PATHS.form);
    expect(updateScenario(harness.database, {
      scenarioId: S.change.scenarioId, expectedRevision: readScenario(harness.database, S.change.scenarioId)?.revision ?? 0,
      draft: {
        profileId: harness.profileId, candidateIdentityDigest: form?.identityDigest ?? '', fieldNames: ['name', 'email', 'newsletter'], readChecks: [],
        sideEffectConfirmations: ALL_CONFIRMED, limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 10 }, approvalTtlDays: 30,
        verification: WRITE_JOB_VERIFICATION,
      },
      discovery, at: harness.nowText(),
    }).ok).toBe(true);
    expect(await harness.start(S.change.scenarioId, 'g-change')).toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    expect(await issueRejection(S.change.scenarioId, 'g-change-2')).toBe('GRANT_APPROVAL_INVALID');

    // 開始の後に撤回: 送る直前の確かめ直しが拒み、送らない（NOT_SENT、RELEASED）。
    advance();
    const recheck = await harness.issueAndStart(S.recheck.scenarioId, 'g-recheck');
    expect(revokeScenarioApproval(harness.database, {
      scenarioId: S.recheck.scenarioId, expectedRevision: readScenario(harness.database, S.recheck.scenarioId)?.revision ?? 0, receiptId: 'revoke-2',
      at: harness.nowText(),
    }).ok).toBe(true);
    const recheckJob = await harness.waitForEnd(recheck.jobId);
    expect(recheckJob).toMatchObject({ state: 'FAILED', failureReason: 'WRITE_GRANT_REJECTED' });
    expect(readWriteResult(harness.database, recheck.jobId)).toMatchObject({ submission: 'NOT_SENT', result: 'BLOCKED', reservationState: 'RELEASED' });
    expect(harness.workerMessages().filter((message) => message.type === 'WRITE_RECHECK_REQUEST').length).toBeGreaterThan(0);
    expect(harness.createPosts(recheck.since)).toEqual([]);
    expect(harness.createPosts()).toHaveLength(expectedPosts);
  }, STEP_TIMEOUT_MS);

  // T30R-fix-1（DEF-103）: 前は、確かめ直しが書き込みの段の前にあり、その後の撤回でも押していた（POST が届き VERIFIED）。今は、親が撤回の後に
  // そのシナリオの書き込みのジョブに STOP を送り（画面のサーバの撤回・変更の口が呼ぶ `stopWriteJobsOfScenario`）、ワーカーは最後の待ちの後に止める印と
  // 押す直前の確かめ直しを見る。
  it('no write outside the approval: a revocation after the write stage read the form page (with STOP, and with the recheck alone)', async () => {
    harness.site.setMode('success');
    for (const [scenario, grantId, stop] of [[S.lateStop, 'g-late-stop', true], [S.lateRecheck, 'g-late-recheck', false]] as const) {
      advance();
      const started = await harness.issueAndStart(scenario.scenarioId, grantId);
      await waitForWriteStageFormGet(started.since);
      expect(revokeScenarioApproval(harness.database, {
        scenarioId: scenario.scenarioId, expectedRevision: readScenario(harness.database, scenario.scenarioId)?.revision ?? 0,
        receiptId: `revoke-${grantId}`, at: harness.nowText(),
      }).ok).toBe(true);
      if (stop) {
        expect(harness.manager.stopWriteJobsOfScenario(scenario.scenarioId)).toBe(1);
      }
      // ジョブの状態は、止めたとき（STOP）は FINISHED（Run は途中まで）、確かめ直しが拒んだときは FAILED。書き込みの結果を確かめる。
      await harness.waitForEnd(started.jobId);
      expect(readWriteResult(harness.database, started.jobId)).toMatchObject({ submission: 'NOT_SENT', result: 'BLOCKED', reservationState: 'RELEASED' });
      expect(reservationOf(grantId)).toBe('RELEASED');
      expect(harness.createPosts(started.since)).toEqual([]);
    }
    expect(harness.createPosts()).toHaveLength(expectedPosts);
  }, STEP_TIMEOUT_MS);

  it('no write outside the approval: a candidate changed on the page, and a candidate changed by a later discovery', async () => {
    advance();
    // 画面の候補が変わった: 画面の確かめ（2 つの digest）で止まる。
    harness.site.setMode('form-changed');
    const changed = await runWrite(S.form.scenarioId, 'g-form');
    expect(changed.posts).toBe(0);
    expect(readWriteResult(harness.database, changed.job.jobId)).toMatchObject({
      submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', result: 'BLOCKED', reservationState: 'RELEASED',
    });
    // 発見の後に候補が変わった: 承認が有効でなくなり、許可が出ない。
    advance();
    await harness.discover();
    expect(await issueRejection(S.dup.scenarioId, 'g-after-discovery')).toBe('GRANT_APPROVAL_INVALID');
    expect(harness.createPosts()).toHaveLength(expectedPosts);
  }, STEP_TIMEOUT_MS);

  it('after all the runs: no POST arrives late, and no secret marker or sent value is outside its places', async () => {
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(harness.createPosts()).toHaveLength(expectedPosts);
    expect(expectedPosts).toBe(6);
    expect(harness.leakedPlaces()).toEqual([]);
    // 送った値（合成のテストデータ。生成したメールの宛先）は、管理データ（決まった表）と `action-run.json`、T32e から書き込みの報告の証拠
    // `action-evidence.json`（ユーザーの判断 6。`isWriteValueArtifactPlace`）だけ。承認の要約とほかのファイルには出ない。
    const sent = harness.manager.listAuditJobs().flatMap(({ jobId }) => {
      const email = readWriteResult(harness.database, jobId)?.submittedValues['email'];
      return typeof email === 'string' && email.length > 0 ? [email] : [];
    });
    expect(sent.length).toBeGreaterThan(0);
    const { databasePath } = harness;
    expect(harness.placesContaining(sent).filter((place) => !isWriteValueArtifactPlace(place) && !place.startsWith(databasePath)))
      .toEqual([]);
    const raw = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { readonly name: string }[]).map(({ name }) => name);
      const holding = tables.filter((table) => {
        const text = JSON.stringify(raw.prepare(`SELECT * FROM "${table}"`).all());
        return sent.some((value) => text.includes(value));
      });
      expect(holding).toEqual(['write_results']);
    } finally {
      raw.close();
    }
    await harness.expectNoProcessLeft();
  }, STEP_TIMEOUT_MS);
});

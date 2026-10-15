// T31i（Task 31 の設計書 6 章、8 章の G31）: 承認された UPDATE の完了条件を、ジョブの管理（`createAuditJobManager`）から本物のワーカー
// （`child_process.fork`。一時のビルド）と本物の Chromium（headless だけ。CLI の起動の設定）と 127.0.0.1 の fixture のサイト
// （`tests/helpers/write-site-fixture.ts` の更新の画面）で、端から端まで確かめる。準備は `tests/helpers/write-job-harness.ts`。テストの既定の
// Chromium の側は、同じ process の中の流れ（`write-update-run.test.ts`）が同じ形を確かめる。
// - 準備: CREATE のシナリオで 1 件を登録して照合し（`VERIFIED`）、もう一度発見して、更新の画面の候補から UPDATE のシナリオを場面ごとに作り承認する。
//   どの UPDATE も、許可の発行が選ぶ対象（参照した CREATE のシナリオの照合まで済んだ最新の登録）を更新する。
// - 削除にあたる作用 0: 送信の前にページの JS が状態の hidden を変える・`_method` を `DELETE` にする・組の checkbox を外す・`deleted=1` の hidden
//   を足す → 更新の POST は届かない（`BLOCKED`、`RELEASED`）。サーバが状態を変える → 届いても `UNKNOWN`（`UNEXPECTED_FIELD_CHANGE`）。
// - 予期しない副作用 0（成功と偽らない）: サーバが保つ欄を変える → `UNKNOWN`、成功の画面の ID が対象と違う → `UNKNOWN`（`RECORD_ID_MISMATCH`）。
// - 二重の更新 0: 同じ許可で同時に 2 回始める（1 つだけ始まる）、同じ許可の 2 回目の開始（消費の 2 回目）、応答の前の切断（送り手が 1 回だけ）。
//   回ごとの更新の POST は 1 件以下。
// - 上限の超過 0: 1 回の Run に 2 件の許可、累積の上限 1、5 分の間隔、24 時間に 5 件（記録の時刻を入れた形）。UPDATE のシナリオにも効く。
// - 承認の範囲の外 0: 撤回の後、シナリオの変更の後（開始で止まる）、書き込みの段の画面の GET の後の撤回と STOP（DEF-103 の形）、画面が見せた
//   予定の対象と違うレコード（`TARGET_SELECTION_CHANGED`。許可が出ない）。更新の POST は 0。
// - `UNKNOWN` の後も同じレコードを更新できる（ユーザーの判断 5）。
// - 全部の回の後に 2 秒待って数え直す。秘密の目印（セッション、資格情報、CSRF、readonly、`lock_version`、保つ欄の人の値）が、管理データ（WAL を
//   含む）・IPC・ワーカーの出力・出力先のすべてのファイル・ジョブの値に出ない。変える欄の前の値と新しい値は、決まった場所（管理データの書き込みの
//   結果、`action-run.json`、テストが渡した入力の規則の値）だけ。前の値は、BeakSight が登録した・更新した値だけ（保つ欄の人の値が入らない）。
// - 時計: ワーカーは本物の時計で時刻を書くので、ジョブの管理の時計（`clockOffsetMs`）を本物の時計より前に置いて、段ごとに進める。
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import { readWriteResult } from '../../src/control/actions/write-result-facts.js';
import {
  issueExecutionGrant,
  readExecutionGrant,
  readPlannedUpdateTarget,
  readScenario,
  revokeScenarioApproval,
  updateScenario,
} from '../../src/control/approval/scenario-store.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import { ACTION_RUN_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import {
  LATE_DELIVERY_SETTLE_MS,
  MINUTE_MS,
  startWriteJobHarness,
  updateScenarioDraftOf,
  type WriteJobHarness,
  type WriteJobUpdateScenarioOptions,
} from '../helpers/write-job-harness.js';
import { isWriteValueArtifactPlace } from '../helpers/write-report-checks.js';
import { seedWriteResultForTest } from '../helpers/write-result-fixtures.js';
import { WRITE_SITE_MEMBER_DEFAULTS, writeSiteEditPathOf, writeSiteRecordPathOf, type WriteSiteUpdateMode } from '../helpers/write-site-fixture.js';

const SUITE_TIMEOUT_MS = 900_000;
const STEP_TIMEOUT_MS = 300_000;
const WAIT_POLL_MS = 50;
const POST_WAIT_LIMIT_MS = 60_000;
/** 管理の時計の始まり（本物の時計の 6 時間前。段ごとに進める）。 */
const START_OFFSET_MS = -360 * MINUTE_MS;
/** 段の間に進める時間（5 分の間隔と許可の 5 分の期限を越える）。 */
const STEP_MS = 10 * MINUTE_MS;
/** 24 時間に 5 件の確かめで作る書き込みの間隔（5 分の間隔を越える）。 */
const DAILY_SPACING_MS = 6 * MINUTE_MS;
const DAILY_WRITES = 5;
/** 24 時間に 5 件の確かめで締める書き込みの HTTP の状態（入力の誤りの画面）。 */
const DAILY_HTTP_STATUS = 200;
/** 書き込みのジョブの中の、書き込みの段の更新の画面の GET の順番（1 件目は更新の前の読み取り）。 */
const WRITE_STAGE_FORM_GET_ORDINAL = 2;
const CREATE_SCENARIO_ID = 'scenario-create';
const CREATED_NAMES = ['登録一郎', '登録二郎'] as const;
const KEPT_FIELD_NAMES = ['email', 'note', 'newsletter', 'published'] as const;

/** UPDATE のシナリオ（変える欄の値の候補は、シナリオごとに別の値）。 */
const updateScenarioOf = (scenarioId: string, prefix: string, limits?: WriteJobUpdateScenarioOptions['limits']): WriteJobUpdateScenarioOptions => ({
  scenarioId,
  names: Array.from({ length: 6 }, (_value, index) => `${prefix}${index + 1}`),
  targetCreateScenarioId: CREATE_SCENARIO_ID,
  keepFieldNames: KEPT_FIELD_NAMES,
  ...(limits === undefined ? {} : { limits }),
});

const S = Object.freeze({
  // 値に危険な語（削除など）を含めない（入力の規則が受けない）。
  delete: updateScenarioOf('u-delete', '守り確認'),
  side: updateScenarioOf('u-side', '副作用確認'),
  dup: updateScenarioOf('u-dup', '重複確認'),
  cumulative: updateScenarioOf('u-cumulative', '累積確認', { maxCreatesPerRun: 1, maxCumulativeCreates: 1 }),
  unknown: updateScenarioOf('u-unknown', '不明確認'),
  daily: updateScenarioOf('u-daily', '日次確認'),
  revoke: updateScenarioOf('u-revoke', '撤回確認'),
  change: updateScenarioOf('u-change', '変更確認'),
  late: updateScenarioOf('u-late', '後撤確認'),
});

let harness: WriteJobHarness;
let updateDiscovery: DiscoveryDocument;
/** 更新の対象のレコードの ID（CREATE の 1 件目）。 */
let targetId = '';
/** これまでに届いてよいと確かめた更新の POST の数。 */
let expectedUpdatePosts = 0;
/** 送った・登録した名前（前の値として読まれてよい値。台帳の値と、BeakSight が更新した値）。 */
const writtenNames = new Set<string>();
/** 証拠を持つ UPDATE のジョブ。 */
const updateJobs: AuditJobView[] = [];

beforeAll(async () => {
  harness = await startWriteJobHarness({ profileId: 'example-write-g31', clockOffsetMs: START_OFFSET_MS });
  harness.site.enableUpdatePages();
  const first = (await harness.discover()).document;
  harness.createReadCheck(first);
  await harness.approvedScenario(first, { scenarioId: CREATE_SCENARIO_ID, names: CREATED_NAMES });
  const created = await harness.issueAndStart(CREATE_SCENARIO_ID, 'g-create-1');
  const createdJob = await harness.waitForEnd(created.jobId);
  expect(readWriteResult(harness.database, createdJob.jobId)).toMatchObject({ result: 'VERIFIED' });
  targetId = readWriteResult(harness.database, createdJob.jobId)?.recordId ?? '';
  writtenNames.add(harness.site.memberOf(Number(targetId))?.name ?? '');
  advance();
  updateDiscovery = (await harness.discover()).document;
  for (const scenario of Object.values(S)) {
    await harness.approvedUpdateScenario(updateDiscovery, scenario);
  }
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  await harness?.close();
}, SUITE_TIMEOUT_MS);

/** 管理の時計を進める。 */
function advance(ms = STEP_MS): void {
  harness.clockOffsetMs += ms;
}

const reservationOf = (grantId: string): string | undefined => readExecutionGrant(harness.database, grantId)?.reservation.state;

/** 許可を発行し、拒まれた理由を返す（通れば null）。 */
const issueRejection = async (scenarioId: string, grantId: string, count = 1): Promise<string | null> => {
  const issued = await harness.issue(scenarioId, grantId, count);
  return issued.ok ? null : issued.reason;
};

/** `action-run.json`（スキーマに通ることも確かめる）。 */
async function actionRunOf(job: AuditJobView): Promise<ActionRunDocument> {
  const value = JSON.parse(readFileSync(artifactFilePath(harness.runDirectoryOf(job), ACTION_RUN_ARTIFACT_FILE_NAME), 'utf8')) as ActionRunDocument;
  expect(await validateArtifact('action-run', value)).toEqual({ ok: true });
  return value;
}

/** UPDATE を 1 回行い、終わったジョブと、その回に届いた更新の POST の数を返す（送った新しい値を覚える）。 */
async function runUpdate(scenarioId: string, grantId: string, mode: WriteSiteUpdateMode = 'success'): Promise<{ readonly job: AuditJobView; readonly posts: number }> {
  harness.site.setUpdateMode(mode);
  const started = await harness.issueAndStartUpdate(scenarioId, grantId);
  const job = await harness.waitForEnd(started.jobId);
  harness.site.setUpdateMode('success');
  const run = await actionRunOf(job);
  if (run.submission !== 'NOT_SENT') {
    writtenNames.add(run.submittedValues['name'] ?? '');
  }
  updateJobs.push(job);
  return { job, posts: harness.updatePosts(started.since).length };
}

/** 書き込みの段の更新の画面の GET（`since` から 2 件目の更新の画面の GET）が届くまで待つ。 */
async function waitForWriteStageFormGet(since: number): Promise<void> {
  const deadline = Date.now() + POST_WAIT_LIMIT_MS;
  const formGets = (): number => harness.site.requests.slice(since)
    .filter(({ method, path }) => method === 'GET' && path === writeSiteEditPathOf(targetId)).length;
  while (formGets() < WRITE_STAGE_FORM_GET_ORDINAL) {
    if (Date.now() > deadline) {
      throw new Error('the form GET of the write stage did not arrive');
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, WAIT_POLL_MS));
  }
}

describe('T31i: the G31 conditions end to end with the real worker', () => {
  it('no deleting effect: the page script changes the state, _method, the pair or adds deleted=1, and the server changing the state is not VERIFIED', async () => {
    for (const [index, mode] of (['js-state', 'js-method', 'js-pair-uncheck', 'js-add-deleted'] as const).entries()) {
      advance();
      const { job, posts } = await runUpdate(S.delete.scenarioId, `g-delete-${index}`, mode);
      expect(posts, mode).toBe(0);
      expect(readWriteResult(harness.database, job.jobId), mode).toMatchObject({
        submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', result: 'BLOCKED', reservationState: 'RELEASED',
      });
      expect(harness.site.memberOf(Number(targetId)), mode).toMatchObject({ active: WRITE_SITE_MEMBER_DEFAULTS.active, published: true });
    }
    advance();
    const { job, posts } = await runUpdate(S.delete.scenarioId, 'g-delete-server', 'server-changes-state');
    expectedUpdatePosts += 1;
    expect(posts).toBe(1);
    expect(readWriteResult(harness.database, job.jobId)).toMatchObject({ submission: 'SENT', result: 'UNKNOWN', reason: 'UNEXPECTED_FIELD_CHANGE' });
    expect(harness.updatePosts()).toHaveLength(expectedUpdatePosts);
  }, STEP_TIMEOUT_MS);

  it('no unexpected side effect claimed as success: the server changes a kept field, or the success page shows another record', async () => {
    for (const [mode, reason] of [['server-changes-kept', 'UNEXPECTED_FIELD_CHANGE'], ['id-mismatch', 'RECORD_ID_MISMATCH']] as const) {
      advance();
      const { job, posts } = await runUpdate(S.side.scenarioId, `g-side-${mode}`, mode);
      expectedUpdatePosts += 1;
      expect(posts, mode).toBe(1);
      expect(readWriteResult(harness.database, job.jobId), mode).toMatchObject({ submission: 'SENT', result: 'UNKNOWN', reason });
    }
    expect(harness.updatePosts()).toHaveLength(expectedUpdatePosts);
  }, STEP_TIMEOUT_MS);

  it('no duplicate update: one start of a grant raced twice, no second consumption, and one POST after a dropped connection', async () => {
    advance();
    expect((await harness.issue(S.dup.scenarioId, 'g-dup-1')).ok).toBe(true);
    const since = harness.site.requests.length;
    const starts = await Promise.all([
      harness.manager.startWriteUpdate({ profileId: harness.profileId, expectedRevision: 1, scenarioId: S.dup.scenarioId, grantId: 'g-dup-1' }),
      harness.manager.startWriteUpdate({ profileId: harness.profileId, expectedRevision: 1, scenarioId: S.dup.scenarioId, grantId: 'g-dup-1' }),
    ]);
    expect(starts.filter(({ ok }) => ok)).toHaveLength(1);
    const job = await harness.waitForEnd('job-g-dup-1');
    updateJobs.push(job);
    writtenNames.add((await actionRunOf(job)).submittedValues['name'] ?? '');
    expectedUpdatePosts += 1;
    expect(readWriteResult(harness.database, job.jobId)).toMatchObject({ submission: 'SENT', result: 'VERIFIED', reservationState: 'COMMITTED' });
    expect(harness.updatePosts(since)).toHaveLength(1);
    const consumedAt = readExecutionGrant(harness.database, 'g-dup-1')?.consumedAt;
    expect(await harness.manager.startWriteUpdate({ profileId: harness.profileId, expectedRevision: 1, scenarioId: S.dup.scenarioId, grantId: 'g-dup-1' }))
      .toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    expect(readExecutionGrant(harness.database, 'g-dup-1')?.consumedAt).toBe(consumedAt);
    // 直後の次の許可は、5 分の間隔で出ない（UPDATE のシナリオにも効く）。
    expect(await issueRejection(S.dup.scenarioId, 'g-dup-2')).toBe('GRANT_WRITE_INTERVAL_NOT_ELAPSED');
    // 応答の前に接続を切る → 更新の POST は 1 件（送り手は送り直さない）、`UNKNOWN`。
    advance();
    const dropped = await runUpdate(S.dup.scenarioId, 'g-dup-drop', 'connection-drop');
    expectedUpdatePosts += 1;
    expect(dropped.posts).toBe(1);
    expect(readWriteResult(harness.database, dropped.job.jobId)).toMatchObject({ submission: 'SENT', httpStatus: null, result: 'UNKNOWN', reservationState: 'UNKNOWN' });
    expect(harness.updatePosts()).toHaveLength(expectedUpdatePosts);
  }, STEP_TIMEOUT_MS);

  it('no limit exceeded: two writes in a run, the cumulative limit, the interval, and five writes in 24 hours', async () => {
    advance();
    expect(await issueRejection(S.cumulative.scenarioId, 'g-cum-run', 2)).toBe('GRANT_RUN_LIMIT_EXCEEDED');
    const { posts } = await runUpdate(S.cumulative.scenarioId, 'g-cum-1');
    expectedUpdatePosts += 1;
    expect(posts).toBe(1);
    advance();
    expect(await issueRejection(S.cumulative.scenarioId, 'g-cum-2')).toBe('GRANT_CUMULATIVE_LIMIT_REACHED');

    advance();
    const baseMs = Date.now() + harness.clockOffsetMs;
    const at = (index: number): string => formatCompactUtcTimestamp(new Date(baseMs + index * DAILY_SPACING_MS), 'daily write time');
    const facts = await harness.externalFacts();
    const revision = readScenario(harness.database, S.daily.scenarioId)?.revision ?? 0;
    // 発行・消費・送る前の記録・締めは、テストだけの補助（`write-result-fixtures.ts`）で、記録の時刻を入れて作る。
    for (let index = 0; index < DAILY_WRITES; index += 1) {
      seedWriteResultForTest(harness.database, {
        profileId: harness.profileId, scenarioId: S.daily.scenarioId, scenarioRevision: revision, grantId: `g-daily-${index}`,
        jobId: `job-g-daily-${index}`, external: facts, at: at(index), submittedValues: {},
        expectedTargetRecordId: readPlannedUpdateTarget(harness.database, S.daily.scenarioId) ?? '',
        report: {
          submission: 'SENT', blockReason: null, httpStatus: DAILY_HTTP_STATUS, responseJudgement: 'INPUT_ERROR', recordId: null, readVerification: null,
          submittedAt: at(index),
        },
      });
    }
    harness.clockOffsetMs = baseMs + DAILY_WRITES * DAILY_SPACING_MS - Date.now();
    expect(await issueRejection(S.daily.scenarioId, 'g-daily-next')).toBe('GRANT_DAILY_WRITE_LIMIT_REACHED');
    expect(harness.updatePosts()).toHaveLength(expectedUpdatePosts);
  }, STEP_TIMEOUT_MS);

  it('no write outside the approval: after a revocation, after a change of the scenario, and a revocation after the write stage read the form', async () => {
    advance();
    expect((await harness.issue(S.revoke.scenarioId, 'g-revoke')).ok).toBe(true);
    expect(revokeScenarioApproval(harness.database, {
      scenarioId: S.revoke.scenarioId, expectedRevision: readScenario(harness.database, S.revoke.scenarioId)?.revision ?? 0, receiptId: 'revoke-1',
      at: harness.nowText(),
    }).ok).toBe(true);
    expect(await harness.manager.startWriteUpdate({ profileId: harness.profileId, expectedRevision: 1, scenarioId: S.revoke.scenarioId, grantId: 'g-revoke' }))
      .toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    expect(reservationOf('g-revoke')).toBe('RELEASED');

    advance();
    expect((await harness.issue(S.change.scenarioId, 'g-change')).ok).toBe(true);
    expect(updateScenario(harness.database, {
      scenarioId: S.change.scenarioId, expectedRevision: readScenario(harness.database, S.change.scenarioId)?.revision ?? 0,
      draft: updateScenarioDraftOf(harness.profileId, updateDiscovery, { ...S.change, limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 10 } }),
      discovery: updateDiscovery, at: harness.nowText(),
    }).ok).toBe(true);
    expect(await harness.manager.startWriteUpdate({ profileId: harness.profileId, expectedRevision: 1, scenarioId: S.change.scenarioId, grantId: 'g-change' }))
      .toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    expect(await issueRejection(S.change.scenarioId, 'g-change-2')).toBe('GRANT_APPROVAL_INVALID');

    // DEF-103 の形: 書き込みの段の更新の画面の GET が届いた後に撤回し、ジョブの管理が STOP を送る。
    advance();
    const late = await harness.issueAndStartUpdate(S.late.scenarioId, 'g-late');
    await waitForWriteStageFormGet(late.since);
    expect(revokeScenarioApproval(harness.database, {
      scenarioId: S.late.scenarioId, expectedRevision: readScenario(harness.database, S.late.scenarioId)?.revision ?? 0, receiptId: 'revoke-late',
      at: harness.nowText(),
    }).ok).toBe(true);
    expect(harness.manager.stopWriteJobsOfScenario(S.late.scenarioId)).toBe(1);
    await harness.waitForEnd(late.jobId);
    expect(readWriteResult(harness.database, late.jobId)).toMatchObject({ submission: 'NOT_SENT', result: 'BLOCKED', reservationState: 'RELEASED' });
    expect(harness.updatePosts(late.since)).toEqual([]);
    expect(harness.updatePosts()).toHaveLength(expectedUpdatePosts);
  }, STEP_TIMEOUT_MS);

  it('updates the same record again after an UNKNOWN result', async () => {
    advance();
    const dropped = await runUpdate(S.unknown.scenarioId, 'g-unknown-1', 'connection-drop');
    expectedUpdatePosts += 1;
    expect(dropped.posts).toBe(1);
    expect(readWriteResult(harness.database, dropped.job.jobId)).toMatchObject({ result: 'UNKNOWN', reservationState: 'UNKNOWN' });
    advance();
    const next = await runUpdate(S.unknown.scenarioId, 'g-unknown-2');
    expectedUpdatePosts += 1;
    expect(next.posts).toBe(1);
    expect(readWriteResult(harness.database, next.job.jobId)).toMatchObject({ result: 'VERIFIED', reservationState: 'COMMITTED', recordId: targetId });
    expect(harness.updatePosts()).toHaveLength(expectedUpdatePosts);
  }, STEP_TIMEOUT_MS);

  it('no write to another record: a grant for the planned record is not issued after another record became the target (TARGET_SELECTION_CHANGED)', async () => {
    advance();
    const created = await harness.issueAndStart(CREATE_SCENARIO_ID, 'g-create-2');
    const createdJob = await harness.waitForEnd(created.jobId);
    expect(readWriteResult(harness.database, createdJob.jobId)).toMatchObject({ result: 'VERIFIED' });
    const newer = readWriteResult(harness.database, createdJob.jobId)?.recordId ?? '';
    writtenNames.add(harness.site.memberOf(Number(newer))?.name ?? '');
    expect(readPlannedUpdateTarget(harness.database, S.unknown.scenarioId)).toBe(newer);
    advance();
    const since = harness.site.requests.length;
    const issued = issueExecutionGrant(harness.database, {
      scenarioId: S.unknown.scenarioId, expectedRevision: readScenario(harness.database, S.unknown.scenarioId)?.revision ?? 0, grantId: 'g-target',
      jobId: 'job-g-target', count: 1, external: await harness.externalFacts(), at: harness.nowText(), expectedTargetRecordId: targetId,
    });
    expect(issued).toMatchObject({ ok: false, reason: 'TARGET_SELECTION_CHANGED' });
    expect(harness.updatePosts(since)).toEqual([]);
  }, STEP_TIMEOUT_MS);

  it('after all the runs: no POST arrives late, and no secret marker or kept value is outside its places', async () => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, LATE_DELIVERY_SETTLE_MS));
    expect(harness.updatePosts()).toHaveLength(expectedUpdatePosts);
    // サーバが状態を変える 1、副作用の 2、重複の場面の 2（同時の開始の 1 と切断の 1）、累積の 1、`UNKNOWN` の後の 2。
    expect(expectedUpdatePosts).toBe(8);
    expect(harness.updatePosts().every((path) => path === writeSiteRecordPathOf(targetId))).toBe(true);
    // 秘密の目印と保つ欄の人の値（`keptMarker`）は、管理データ・WAL・IPC・ワーカーの出力・ジョブの値・出力先のすべてのファイルに出ない。
    expect(harness.leakedPlaces()).toEqual([]);
    expect(harness.placesContaining([harness.site.keptMarker])).toEqual([]);
    // 前の値は、BeakSight が登録した値と更新した値だけ（保つ欄の人の値や、ほかの欄の値が入らない）。
    const previousValues: string[] = [];
    for (const job of updateJobs) {
      for (const field of (await actionRunOf(job)).update?.updateEvidence?.fields ?? []) {
        if (field.role === 'CHANGED') {
          previousValues.push(field.previousValue ?? '');
        } else {
          expect([field.previousValue, field.newValue]).toEqual([null, null]);
        }
      }
    }
    expect(previousValues.length).toBeGreaterThan(0);
    expect(previousValues.filter((value) => !writtenNames.has(value))).toEqual([]);
    // 変える欄の値（前と新しい）は、管理データの決まった表と `action-run.json`、T32e から書き込みの報告の証拠 `action-evidence.json`（ユーザーの
    // 判断 6。`isWriteValueArtifactPlace`）だけ。
    const changedValues = [...writtenNames].filter((value) => value.length > 0);
    const { databasePath } = harness;
    expect(harness.placesContaining(changedValues).filter((place) => !isWriteValueArtifactPlace(place) && !place.startsWith(databasePath)))
      .toEqual([]);
    const raw = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { readonly name: string }[]).map(({ name }) => name);
      const holding = tables.filter((table) => {
        const text = JSON.stringify(raw.prepare(`SELECT * FROM "${table}"`).all());
        return changedValues.some((value) => text.includes(value));
      });
      // 入力の規則の版（テストが渡した固定の値の一覧）と、書き込みの結果だけ。
      expect(holding).toEqual(['rule_set_revisions', 'write_results']);
    } finally {
      raw.close();
    }
    await harness.expectNoProcessLeft();
  }, STEP_TIMEOUT_MS);
});

// T31g-2（Task 31 の設計書 3 章、4 章の「IPC」「読み込みの回数と間隔」、6 章）: 更新の書き込みのジョブ（`WRITE_UPDATE`）を、ジョブの管理
// （`createAuditJobManager`）から本物のワーカー（`child_process.fork`。一時のビルド）と本物の Chromium（headless だけ。CLI の起動の設定）と
// 127.0.0.1 の fixture のサイト（`tests/helpers/write-site-fixture.ts` の更新の画面）で、端から端まで確かめる。準備は
// `tests/helpers/write-job-harness.ts`。
// - CREATE のシナリオで 1 件を登録して照合し（`VERIFIED`）、もう一度発見して更新の画面の候補から UPDATE のシナリオを作って承認する。許可の発行が
//   対象（照合まで済んだ最新の登録）を選び、ジョブの管理が具体的な path を `START` に入れる。
// - 成功: 更新の POST が 1 件、結果は `VERIFIED`、予約は `COMMITTED`、変える欄だけが変わる。読み込みの間隔は設定以上。
// - 止めた回（送信の前にページの JS が状態の hidden を変える）: POST は 0、`BLOCKED`、予約は `RELEASED`。
// - 全部の回の後に 2 秒待って数え直す。秘密の目印（セッション、資格情報、CSRF、readonly、`lock_version`）と保つ欄の値が、管理データ（WAL を
//   含む）・IPC・ワーカーの出力・出力先のファイル・ジョブの値に出ない。変える欄の前の値と新しい値は、決まった場所（管理データの書き込みの結果と
//   `action-run.json`）だけ。
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import { readWriteResult } from '../../src/control/actions/write-result-facts.js';
import { readExecutionGrant } from '../../src/control/approval/scenario-store.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import { ACTION_RUN_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { LATE_DELIVERY_SETTLE_MS, MINUTE_MS, startWriteJobHarness, type WriteJobHarness } from '../helpers/write-job-harness.js';
import { isWriteValueArtifactPlace } from '../helpers/write-report-checks.js';
import { WRITE_SITE_MEMBER_DEFAULTS, WRITE_SITE_PATHS, writeSiteEditPathOf, writeSiteRecordPathOf } from '../helpers/write-site-fixture.js';

const SUITE_TIMEOUT_MS = 900_000;
const STEP_TIMEOUT_MS = 300_000;
/** 管理の時計の始まり（本物の時計の 4 時間前。段ごとに進める）。 */
const START_OFFSET_MS = -240 * MINUTE_MS;
/** 段の間に進める時間（5 分の間隔と許可の 5 分の期限を越える）。 */
const STEP_MS = 10 * MINUTE_MS;
const CREATE_SCENARIO_ID = 'scenario-create';
const UPDATE_SCENARIO_ID = 'scenario-update';
const CREATED_NAME = '登録一郎';
/** 変える欄の値の候補（2 回目の UPDATE の生成が、使った値と重ならないように 2 つ）。 */
const UPDATED_NAMES = ['更新一郎', '更新二郎'] as const;
/** T31i: 保つ欄に、人の値（目印 `keptMarker`）の入った備考（`note`）を足した。 */
const KEPT_FIELD_NAMES = ['email', 'note', 'newsletter', 'published'] as const;

let harness: WriteJobHarness;
let targetId = '';
/** 1 回目の UPDATE で送った新しい値。 */
let updatedName = '';

beforeAll(async () => {
  harness = await startWriteJobHarness({ profileId: 'example-write-update', clockOffsetMs: START_OFFSET_MS });
  harness.site.enableUpdatePages();
  const { document } = await harness.discover();
  harness.createReadCheck(document);
  await harness.approvedScenario(document, { scenarioId: CREATE_SCENARIO_ID, names: [CREATED_NAME] });
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  await harness?.close();
}, SUITE_TIMEOUT_MS);

const advance = (): void => {
  harness.clockOffsetMs += STEP_MS;
};

/** `action-run.json`（スキーマに通ることも確かめる）。 */
async function actionRunOf(job: AuditJobView): Promise<ActionRunDocument> {
  const value = JSON.parse(readFileSync(artifactFilePath(harness.runDirectoryOf(job), ACTION_RUN_ARTIFACT_FILE_NAME), 'utf8')) as ActionRunDocument;
  expect(await validateArtifact('action-run', value)).toEqual({ ok: true });
  return value;
}

describe('T31g-2: the update write job end to end with the real worker', () => {
  it('registers a record, approves an update scenario on its update form, and updates only the changed field (VERIFIED, COMMITTED)', async () => {
    const created = await harness.issueAndStart(CREATE_SCENARIO_ID, 'g-create');
    const createdJob = await harness.waitForEnd(created.jobId);
    expect(readWriteResult(harness.database, createdJob.jobId)).toMatchObject({ result: 'VERIFIED', reservationState: 'COMMITTED' });
    targetId = readWriteResult(harness.database, createdJob.jobId)?.recordId ?? '';
    expect(targetId).not.toBe('');

    advance();
    const { document } = await harness.discover();
    await harness.approvedUpdateScenario(document, {
      scenarioId: UPDATE_SCENARIO_ID, names: UPDATED_NAMES, targetCreateScenarioId: CREATE_SCENARIO_ID, keepFieldNames: KEPT_FIELD_NAMES,
    });
    advance();
    const before = harness.site.memberOf(Number(targetId));
    const updated = await harness.issueAndStartUpdate(UPDATE_SCENARIO_ID, 'g-update-1');
    const job = await harness.waitForEnd(updated.jobId);
    expect(job).toMatchObject({
      jobKind: 'WRITE_UPDATE', state: 'FINISHED', endKind: 'RAN', resultRunStatus: 'COMPLETE', failureReason: null, writeReportCheck: 'VALID',
    });
    expect(readExecutionGrant(harness.database, updated.grantId)).toMatchObject({ consumedAt: expect.any(String), reservation: { state: 'COMMITTED' } });
    expect(readWriteResult(harness.database, job.jobId)).toMatchObject({
      submission: 'SENT', result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED', reservationState: 'COMMITTED', recordId: targetId,
    });
    const run = await actionRunOf(job);
    updatedName = run.submittedValues['name'] ?? '';
    expect(UPDATED_NAMES).toContain(updatedName);
    expect(run).toMatchObject({ jobId: job.jobId, submission: 'SENT', result: 'VERIFIED', recordId: targetId, submittedValues: { name: updatedName } });
    expect(run.update).toEqual({
      targetRecordId: targetId,
      updateEvidence: {
        fields: [
          { fieldName: 'name', role: 'CHANGED', previousValue: CREATED_NAME, newValue: updatedName, matched: true },
          // 保つ欄は、シナリオの保存の形の順（UTF-16 のコード単位の順）で `START` に入り、その順で並ぶ。状態の名前の欄はその後。
          ...[...[...KEPT_FIELD_NAMES].sort(), 'active'].map((fieldName) => ({ fieldName, role: 'KEPT', previousValue: null, newValue: null, matched: true })),
        ],
      },
    });
    expect(harness.updatePosts(updated.since)).toEqual([writeSiteRecordPathOf(targetId)]);
    expect(harness.site.memberOf(Number(targetId))).toEqual({ ...before, name: updatedName });
    // 読み込み: 更新の前の読み取り、書き込みの画面、更新の POST（redirect の続きは除く）、更新の後の読み取り、照合の READ の対象の画面と READ の URL。
    harness.expectPacedNavigations(updated.since, [
      `GET ${writeSiteEditPathOf(targetId)}`, `GET ${writeSiteEditPathOf(targetId)}`, `POST ${writeSiteRecordPathOf(targetId)}`,
      `GET ${writeSiteEditPathOf(targetId)}`, `GET ${WRITE_SITE_PATHS.list}`, `GET ${WRITE_SITE_PATHS.list}`,
    ]);
  }, STEP_TIMEOUT_MS);

  it('does not send when the page script changes the state hidden before the submission (BLOCKED, RELEASED)', async () => {
    advance();
    harness.site.setUpdateMode('js-state');
    const blocked = await harness.issueAndStartUpdate(UPDATE_SCENARIO_ID, 'g-update-2');
    const job = await harness.waitForEnd(blocked.jobId);
    expect(job).toMatchObject({ jobKind: 'WRITE_UPDATE', state: 'FINISHED', endKind: 'RAN', failureReason: null, writeReportCheck: 'VALID' });
    expect(readExecutionGrant(harness.database, blocked.grantId)).toMatchObject({ reservation: { state: 'RELEASED' } });
    expect(readWriteResult(harness.database, job.jobId)).toMatchObject({
      submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', result: 'BLOCKED', reservationState: 'RELEASED',
    });
    expect((await actionRunOf(job)).update).toEqual({ targetRecordId: targetId, updateEvidence: null });
    expect(harness.updatePosts(blocked.since)).toEqual([]);
    expect(harness.site.memberOf(Number(targetId))?.active).toBe(WRITE_SITE_MEMBER_DEFAULTS.active);
    harness.site.setUpdateMode('success');
  }, STEP_TIMEOUT_MS);

  it('after all the runs: no POST arrives late, and no secret marker or kept value is outside its places', async () => {
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(harness.updatePosts()).toEqual([writeSiteRecordPathOf(targetId)]);
    expect(harness.createPosts()).toEqual([WRITE_SITE_PATHS.create]);
    expect(harness.leakedPlaces()).toEqual([]);
    // 保つ欄の人の値（備考の目印）は、どこにも記録しない（管理データ・WAL・出力先のファイル・IPC）。
    expect(harness.placesContaining([harness.site.keptMarker])).toEqual([]);
    expect(JSON.stringify(harness.workerMessages())).not.toContain(harness.site.keptMarker);
    // 変える欄の前の値と新しい値は、管理データの書き込みの結果と `action-run.json`、T32e から書き込みの報告の証拠 `action-evidence.json`
    // （ユーザーの判断 6。`isWriteValueArtifactPlace`）だけ。
    const { databasePath } = harness;
    expect(harness.placesContaining([updatedName]).filter((place) => !isWriteValueArtifactPlace(place) && !place.startsWith(databasePath)))
      .toEqual([]);
    const raw = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { readonly name: string }[]).map(({ name }) => name);
      const holding = tables.filter((table) => JSON.stringify(raw.prepare(`SELECT * FROM "${table}"`).all()).includes(updatedName));
      // 入力の規則の版（人の固定の値の一覧。テストが渡した候補）と、書き込みの結果だけ。
      expect(holding).toEqual(['rule_set_revisions', 'write_results']);
    } finally {
      raw.close();
    }
    await harness.expectNoProcessLeft();
  }, STEP_TIMEOUT_MS);
});

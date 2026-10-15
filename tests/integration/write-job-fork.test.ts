// T30f（Task 30 の設計書 3 章の「予約の締め」、4 章の「IPC」、6 章）: 書き込みのジョブ（`WRITE_CREATE`）を、ジョブの管理（`createAuditJobManager` の
// `startWriteCreate`）から、本物のワーカー（`child_process.fork`。一時のビルド）と本物の Chromium（headless だけ）で、端から端まで確かめる結合テスト
// （T30e の偽のワーカーではない）。準備の作りは `tests/helpers/write-job-harness.ts`（T30h-1 で `write-job-g30.test.ts` と共通にした）。
// - 1 回目: ページの JS が送信の前に欄を足す（fixture の `js-field`）→ 書き込みの段の見張りが POST を止める（`NOT_SENT`）→ 予約は `RELEASED`。
//   サーバに登録の POST は届かない。
// - 2 回目: 成功（fixture の `success`）→ 登録の POST が 1 回だけ届き、ID を取り、照合の READ が一致（`VERIFIED`）→ 予約は `COMMITTED`。
// - どちらも: 送信の報告は 1 回、締めは 1 回。読み込みの間隔は設定の値以上（サーバに届いた時刻の、最初から最後までの長さで）。全部の回の後に待って
//   POST を数え直す。秘密の目印（セッションの値、資格情報、CSRF、readonly の値）が、成果物、管理データ、IPC、ワーカーの出力に出ない。process が
//   残らない。
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTION_RUN_SCHEMA_VERSION, type ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import { readWriteResult } from '../../src/control/actions/write-result-facts.js';
import { readExecutionGrant } from '../../src/control/approval/scenario-store.js';
import {
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
  ACTION_RUN_ARTIFACT_FILE_NAME,
  artifactFilePath,
} from '../../src/core/artifact-layout.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import {
  LATE_DELIVERY_SETTLE_MS,
  READ_METHODS,
  WRITE_JOB_READ_CHECK_ID,
  startWriteJobHarness,
  type WriteJobHarness,
} from '../helpers/write-job-harness.js';
import { isWriteValueArtifactPlace, readWriteReportFiles } from '../helpers/write-report-checks.js';
import { WRITE_SITE_PATHS } from '../helpers/write-site-fixture.js';

const SUITE_TIMEOUT_MS = 900_000;
const TEST_TIMEOUT_MS = 480_000;
const SCENARIO_ID = 'scenario-fork';
/** 人の固定の値の規則で決める名前（照合の READ の検索の値になる）。 */
const NAMES = Object.freeze(['試験一郎', '試験二郎']);

let harness: WriteJobHarness;

beforeAll(async () => {
  harness = await startWriteJobHarness({ profileId: 'example-write-fork' });
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  await harness?.close();
}, SUITE_TIMEOUT_MS);

/** Run のディレクトリの `action-run.json`（スキーマに通ることも確かめる）。 */
async function actionRunOf(job: AuditJobView): Promise<ActionRunDocument> {
  const value = JSON.parse(readFileSync(artifactFilePath(harness.runDirectoryOf(job), ACTION_RUN_ARTIFACT_FILE_NAME), 'utf8')) as ActionRunDocument;
  expect(await validateArtifact('action-run', value)).toEqual({ ok: true });
  return value;
}

describe('T30f: the write job end to end with the real worker', () => {
  it('releases the reservation of a run that the write stage stopped, then commits a verified write sent once', async () => {
    const { site, database } = harness;
    const { document } = await harness.discover();
    expect(site.requests.filter(({ method, path }) => !READ_METHODS.has(method) && path !== WRITE_SITE_PATHS.login)).toEqual([]);
    harness.createReadCheck(document);
    await harness.approvedScenario(document, { scenarioId: SCENARIO_ID, names: NAMES });

    // 1 回目: ページの JS が送信の前に欄を足す → 書き込みの段の見張りが止める（NOT_SENT）→ RELEASED。登録の POST は届かない。
    site.setMode('js-field');
    const first = await harness.issueAndStart(SCENARIO_ID, 'grant-1');
    const stopped = await harness.waitForEnd(first.jobId);
    expect(stopped).toMatchObject({ jobKind: 'WRITE_CREATE', state: 'FINISHED', endKind: 'RAN', failureReason: null, writeReportCheck: 'VALID' });
    expect(readExecutionGrant(database, first.grantId)).toMatchObject({ consumedAt: expect.any(String), reservation: { state: 'RELEASED' } });
    expect(readWriteResult(database, stopped.jobId)).toMatchObject({
      submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', result: 'BLOCKED', reservationState: 'RELEASED', httpStatus: null, recordId: null,
    });
    expect(await actionRunOf(stopped)).toMatchObject({ schemaVersion: ACTION_RUN_SCHEMA_VERSION, jobId: stopped.jobId, submission: 'NOT_SENT', result: 'BLOCKED' });
    expect(harness.createPosts()).toEqual([]);
    harness.expectPacedNavigations(first.since, [`GET ${WRITE_SITE_PATHS.form}`, `GET ${WRITE_SITE_PATHS.form}`]);

    // 2 回目: 成功 → 登録の POST が 1 回だけ届き、ID を取り、照合の READ が一致 → VERIFIED、COMMITTED。
    site.setMode('success');
    const second = await harness.issueAndStart(SCENARIO_ID, 'grant-2');
    const written = await harness.waitForEnd(second.jobId);
    expect(written).toMatchObject({
      jobKind: 'WRITE_CREATE', state: 'FINISHED', endKind: 'RAN', resultRunStatus: 'COMPLETE', failureReason: null, writeReportCheck: 'VALID',
    });
    expect(readExecutionGrant(database, second.grantId)).toMatchObject({ consumedAt: expect.any(String), reservation: { state: 'COMMITTED' } });
    const result = readWriteResult(database, written.jobId);
    expect(result).toMatchObject({
      submission: 'SENT', blockReason: null, httpStatus: 200, responseJudgement: 'SUCCESS', recordId: '1001', result: 'VERIFIED',
      reason: 'READ_VERIFICATION_MATCHED', reservationState: 'COMMITTED', readVerification: 'MATCHED',
    });
    const writtenRun = await actionRunOf(written);
    expect(writtenRun).toMatchObject({
      jobId: written.jobId, submission: 'SENT', result: 'VERIFIED', recordId: '1001',
      readVerification: { readCheckId: WRITE_JOB_READ_CHECK_ID, readCheckRevision: 1, result: 'MATCHED' },
    });
    expect(writtenRun.submittedValues).toEqual(result?.submittedValues);
    expect(NAMES).toContain(result?.submittedValues['name']);
    // T32e: 本物のワーカーが、書き込みの報告の 2 つの JSON を書く（スキーマ、`action-run.json` との一致、承認の要約のジョブ・Run・許可。秘密の
    // 目印は、下の `leakedPlaces` が出力先のすべてのファイルで確かめる）。送らなかった 1 回目も書く。
    const writtenReport = await readWriteReportFiles(harness.runDirectoryOf(written), writtenRun, { markers: [] });
    expect(writtenReport.evidence).toMatchObject({
      kind: 'CREATE', submission: { state: 'SENT', actionPath: WRITE_SITE_PATHS.create },
      readVerification: { state: 'EXECUTED', result: 'MATCHED' }, guard: { documentCharsetRead: true },
    });
    expect(writtenReport.approvalSummary).toMatchObject({ scenario: { scenarioId: SCENARIO_ID, kind: 'CREATE' }, grantAtStart: { grantId: second.grantId } });
    const stoppedReport = await readWriteReportFiles(harness.runDirectoryOf(stopped), await actionRunOf(stopped), { markers: [] });
    expect(stoppedReport.evidence).toMatchObject({ submission: { state: 'NOT_SENT', submittedValues: {} }, response: null, result: 'BLOCKED' });
    expect(stoppedReport.approvalSummary.grantAtStart.grantId).toBe(first.grantId);
    // T32f: 値と目印の場所の検査は、書き込みのバンドルを展開した中身まで届く（送った名前が、バンドルの中の証拠と HTML に見つかる）。
    const sentName = String(result?.submittedValues['name']);
    const zipPlaces = harness.placesContaining([sentName]).filter((place) => place.includes('!/'));
    expect(zipPlaces.some((place) => place.endsWith(`!/${ACTION_EVIDENCE_ARTIFACT_FILE_NAME}`))).toBe(true);
    expect(zipPlaces.some((place) => place.endsWith(`!/${ACTION_REPORT_ARTIFACT_FILE_NAME}`))).toBe(true);
    expect(zipPlaces.every((place) => isWriteValueArtifactPlace(place))).toBe(true);
    expect(harness.createPosts()).toEqual([WRITE_SITE_PATHS.create]);
    expect(site.members).toBe(1);
    harness.expectPacedNavigations(second.since, [
      `GET ${WRITE_SITE_PATHS.form}`, `GET ${WRITE_SITE_PATHS.form}`, `POST ${WRITE_SITE_PATHS.create}`, `GET ${WRITE_SITE_PATHS.list}`,
      `GET ${WRITE_SITE_PATHS.list}`,
    ]);

    // IPC: 送信の報告は回ごとに 1 回で、成果物と同じ。確かめ直しの依頼も回ごとに 1 回。
    const messages = harness.workerMessages();
    expect(messages.filter((message) => message.type === 'WRITE_SUBMISSION').map((message) => (message.type === 'WRITE_SUBMISSION'
      ? [message.submission, message.blockReason] : null))).toEqual([['NOT_SENT', 'PAYLOAD_MISMATCH'], ['SENT', null]]);
    expect(messages.filter((message) => message.type === 'WRITE_RECHECK_REQUEST')).toHaveLength(2);

    // 全部の回の後に待って、遅れて届く POST がないことを数え直す。秘密の目印がどこにも出ない。process が残らない。
    await new Promise((resolvePromise) => setTimeout(resolvePromise, LATE_DELIVERY_SETTLE_MS));
    expect(harness.createPosts()).toEqual([WRITE_SITE_PATHS.create]);
    expect(site.successfulLogins).toBe(3);
    expect(harness.leakedPlaces()).toEqual([]);
    await harness.expectNoProcessLeft();
  }, TEST_TIMEOUT_MS);
});

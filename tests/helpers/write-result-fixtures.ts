/**
 * テストだけの、書き込みの結果を管理データに入れる補助（T30g。画面のテストが、記録だけを入れた結果の表示を確かめるために使う）。
 * - 実行の許可の発行・消費・送る前の記録・締めを、保存の部品（`src/control/approval/scenario-store.ts`）の公開の口で、同じ時刻で順に行う
 *   （`tests/integration/execution-grant-fixtures.ts` の `settleWriteForTest` と同じ作り。結果の判定は締めの部品が決め直す）。
 * - 予約を締める口（Architecture Gate `control-store-boundary` の (n)）を参照するのは、製品のコードでは保存の部品とジョブの管理だけ。画面のテストの
 *   ファイルは、この補助を通す。
 */
import {
  consumeExecutionGrant,
  issueExecutionGrant,
  recordWriteAttempt,
  settleWriteResult,
  type ApprovalExternalFacts,
  type WriteOutcomeReport,
} from '../../src/control/approval/scenario-store.js';
import type { DataSeed } from '../../src/control/data-rules/deterministic-stream.js';
import type { ControlDatabase } from '../../src/control/store/control-database.js';

/** テストだけの seed の値（64 桁）と、規則の集まりの digest の値。 */
const TEST_SEED = 'a'.repeat(64) as DataSeed;
const TEST_RULE_SET_DIGEST = `sha256:${'b'.repeat(64)}`;
/** テストだけの基準日。 */
const TEST_BASE_DATE = '2026-10-13';
/** 予約する件数（1 回の Run で 1 件）。 */
const TEST_COUNT = 1;

/** 入れる結果 1 件の入力。 */
export interface SeededWriteResult {
  readonly profileId: string;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  readonly grantId: string;
  readonly jobId: string;
  /** 管理データの外の事実（最後の承認の記録が縛った値）。 */
  readonly external: ApprovalExternalFacts;
  /** 発行・消費・記録・締めの時刻（UTC の 14 桁）。 */
  readonly at: string;
  /** 送った値（合成のテストデータ）。 */
  readonly submittedValues: Readonly<Record<string, string>>;
  /** 締めの報告（ジョブの id と時刻は、この入力の値。T31h-2: UPDATE の証拠は報告の `updateEvidence`）。 */
  readonly report: Omit<WriteOutcomeReport, 'jobId' | 'at'>;
  /** T31h-2: UPDATE のシナリオの、画面が見せた予定のレコードの ID（発行に渡す。CREATE は省略）。 */
  readonly expectedTargetRecordId?: string;
}

/** 書き込みの結果 1 件を入れる（どの段でも拒まれたら `Error`）。 */
export const seedWriteResultForTest = (database: ControlDatabase, input: SeededWriteResult): void => {
  const { scenarioId, scenarioRevision, grantId, jobId, profileId, external, at } = input;
  const issued = issueExecutionGrant(database, {
    scenarioId, expectedRevision: scenarioRevision, grantId, jobId, count: TEST_COUNT, external, at,
    ...(input.expectedTargetRecordId === undefined ? {} : { expectedTargetRecordId: input.expectedTargetRecordId }),
  });
  if (!issued.ok) {
    throw new Error(`the test-only grant was not issued: ${issued.reason}`);
  }
  const consumed = consumeExecutionGrant(database, { grantId, scenarioId, scenarioRevision, jobId, profileId, external, at });
  if (!consumed.ok) {
    throw new Error(`the test-only grant was not consumed: ${consumed.reason}`);
  }
  const recorded = recordWriteAttempt(database, {
    jobId,
    grantId,
    seedRecord: {
      seed: TEST_SEED,
      seedInput: { profileId, scenarioId, scenarioRevision, ruleSetDigest: TEST_RULE_SET_DIGEST, executionGrantId: grantId },
      baseDate: TEST_BASE_DATE,
      attempt: 0,
    },
    submittedValues: input.submittedValues,
    uniqueKey: null,
    phoneNumbers: [],
    at,
  });
  if (!recorded.ok) {
    throw new Error(`the test-only write attempt was not recorded: ${recorded.reason}`);
  }
  const settled = settleWriteResult(database, { ...input.report, jobId, at });
  if (!settled.ok) {
    throw new Error(`the test-only write result was not settled: ${settled.reason}`);
  }
};

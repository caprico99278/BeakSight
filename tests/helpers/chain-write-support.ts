// SLIM W-1: 点検（まとめて実行。監査 → 発見 → READ の確かめ → 書き込みの段）の書き込みの段を、ジョブの管理（`createAuditJobManager`）と偽のワーカー
// （`fake-audit-worker.ts` の `chain`。本物の `fork`）で通す結合のテストの補助。単独で書き込みを始める口を外したので、許可の発行・消費・値の生成・送る前の記録
// （`#prepareWrite`）と、確かめ直しの往復・締め・報告の確かめは、どれも点検の書き込みの段を通して確かめる（`control-write-jobs`・`control-write-api-jobs`・
// `*-grant-start` のテストが共用する。複製しない）。
// - 発見の段の成果物は、テストが渡す文書（ジョブの ID と Run の ID は、偽のワーカーがその段の値に置き換える）。発見の索引は、この点検の発見の段で記録し直される。
// - READ の確かめの段は、偽のワーカーが定義ごとに `MATCHED` を書く（書き込みの段の前に、照合の専用でない定義があれば行う）。
import type { ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import { actionApiSummaryOf } from '../../src/control/actions/action-api-summary.js';
import type { ScenarioApiSpec } from '../../src/control/approval/scenario-contracts.js';
import type { AuditJobManager } from '../../src/control/job/audit-job-manager.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import type { StageChainView } from '../../src/control/job/stage-chain-policy.js';
import type { AuditPageScopeKind } from '../../src/core/audit-page-scope.js';
import { wait } from '../../src/core/deadline.js';
import { discoverySummaryOf, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { verifiedApiCreateDocuments } from './action-report-samples.js';
import type { FakeWorkerValues } from './fake-audit-worker.js';
import { fakeWorkerValuesOf } from './job-test-support.js';

/** 読み取りの段（監査・発見・READ の確かめ）の Run の ID。 */
export const CHAIN_READ_STAGE_RUN_IDS = Object.freeze(['RUN-20261101000000', 'RUN-20261101000100', 'RUN-20261101000200']);
/** 形は正しいが、どの段の Run でもない Run の ID。 */
const OTHER_RUN_ID = 'RUN-20261101009999';

/** 点検を待つ上限と、読み直す間隔（ms）。 */
const CHAIN_WAIT_LIMIT_MS = 30_000;
const CHAIN_POLL_MS = 25;

/** 書き込みの段を持つ点検の、偽のワーカーの値（書き込みの段の Run の ID は `writeRunId`。2 つ目からは `write.runIds`）。 */
export const chainWriteWorkerValues = (input: {
  readonly outputDirectory: string;
  readonly discovery: DiscoveryDocument;
  readonly writeRunId: string;
  readonly write: NonNullable<FakeWorkerValues['write']>;
}): FakeWorkerValues => {
  const document = { ...input.discovery, jobId: '__JOB_ID__', runId: '__RUN_ID__' };
  return fakeWorkerValuesOf({ runId: input.writeRunId, otherRunId: OTHER_RUN_ID }, {
    chain: { runIds: CHAIN_READ_STAGE_RUN_IDS },
    discovery: {
      outputDirectory: input.outputDirectory,
      documentText: JSON.stringify(document),
      summary: { ...discoverySummaryOf(input.discovery) },
      runStatus: 'COMPLETE',
    },
    readCheck: { outputDirectory: input.outputDirectory, results: [] },
    write: input.write,
  });
};

/** 点検の結果（連鎖の見え方と、書き込みのジョブ。始めた段は行った順、準備で止まった段はその後）。 */
export interface WriteChainResult {
  readonly chain: StageChainView;
  readonly writeJobs: readonly AuditJobView[];
}

/** 点検を始め、連鎖とすべての段のジョブが終わり、ワーカーが終わるまで待つ。 */
export async function runWriteChain(
  manager: AuditJobManager,
  profileId: string,
  expectedRevision: number,
  onStarted?: (chainId: string) => void,
  /** WSO: 点検の範囲（「チェックした画面だけ」）。省略はサイトの全部の画面。 */
  scope?: AuditPageScopeKind,
): Promise<WriteChainResult> {
  const started = await manager.startStageChain({ profileId, expectedRevision, startNew: true, ...(scope === undefined ? {} : { scope }) });
  if (!started.ok) {
    throw new Error(`the inspection did not start: ${JSON.stringify(started)}`);
  }
  onStarted?.(started.job.jobId);
  const deadline = Date.now() + CHAIN_WAIT_LIMIT_MS;
  for (;;) {
    const chain = manager.getStageChainOfJob(started.job.jobId);
    const jobs = manager.listAuditJobs();
    if (chain !== null && chain.state !== 'RUNNING' && jobs.every(({ finishedAt }) => finishedAt !== null) && manager.runningWorkerCount() === 0) {
      const writes = jobs.filter(({ jobKind }) => jobKind === 'WRITE_CREATE' || jobKind === 'WRITE_UPDATE');
      const ordered = [
        ...chain.writeStageJobIds.flatMap((jobId) => writes.filter((job) => job.jobId === jobId)),
        ...writes.filter(({ jobId }) => !chain.writeStageJobIds.includes(jobId)),
      ];
      return { chain, writeJobs: ordered };
    }
    if (Date.now() > deadline) {
      throw new Error(`the inspection did not end: ${JSON.stringify(chain)}`);
    }
    await wait(CHAIN_POLL_MS);
  }
}

/**
 * API の登録の段の、照合まで済んだ `action-run.json` の中身（版 1.1）。段のジョブの id・許可の id・seed の記録・送った値は、偽のワーカーが書き込みの指定の値に
 * 置き換える印。API の要約は、承認した API の指定とページが決める鍵の値から作る。登録の後の更新の段を、同じ点検で通すために使う。
 */
export const verifiedApiCreateRunText = (input: {
  readonly profileId: string;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  readonly api: ScenarioApiSpec;
  readonly runId: string;
  readonly recordId: string;
  readonly at: string;
  readonly pageKeyValues?: Readonly<Record<string, string>>;
}): string => JSON.stringify({
  ...verifiedApiCreateDocuments().actionRun,
  jobId: '__START_JOB_ID__',
  runId: input.runId,
  profileId: input.profileId,
  scenarioId: input.scenarioId,
  scenarioRevision: input.scenarioRevision,
  grantId: '__START_GRANT_ID__',
  seedRecord: '__START_SEED_RECORD__' as never,
  submittedValues: '__START_VALUES__' as never,
  api: actionApiSummaryOf(input.api, input.pageKeyValues ?? {}),
  recordId: input.recordId,
  startedAt: input.at,
  submittedAt: input.at,
  finishedAt: input.at,
} satisfies ActionRunDocument);

/** 偽のワーカーが受けた、書き込みの段の指定（書き込みの指定つきの `NEXT_STAGE`。行った順）。 */
export const writeStagesOf = (received: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] =>
  received.filter((message) => message['type'] === 'NEXT_STAGE' && message['write'] !== undefined);

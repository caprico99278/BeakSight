/**
 * 「登録してから更新する」の予定と状態の置き場（T41g。Task 41 の設計書 3.5.1）。メモリの中だけに持つ（管理データに書かない。画面のサーバが止まれば消え、
 * 更新は始めない。安全側）。書くのは続けて始める部品（`write-job-functions.ts`）だけで、ジョブの詳細（`audit-job-functions.ts`）と開始の画面が読む。
 * 決まり（状態・理由の閉じた一覧、続けて始めるかの判定）は `write-chain-policy.ts`。
 */
import type { WriteChainState, WriteChainStopReason } from './write-chain-policy';

/** 続けて始める予定と状態 1 件（登録のジョブごと）。 */
export interface WriteChainView {
  readonly createJobId: string;
  readonly createScenarioId: string;
  readonly updateScenarioId: string;
  readonly state: WriteChainState;
  /** 更新を始めなかった理由（`NOT_STARTED` だけ）。 */
  readonly reason: WriteChainStopReason | null;
  /** 始めた更新のジョブ（`UPDATE_STARTED` だけ）。 */
  readonly updateJobId: string | null;
  /** T41g-3: 自動ログインの間隔を待った後に更新を始め直す時刻（ISO 8601。`WAITING_LOGIN_INTERVAL` だけ）。 */
  readonly nextStartAt: string | null;
}

/** 登録のジョブの id → 予定と状態。 */
const chainsByCreateJob = new Map<string, WriteChainView>();
/** 更新のシナリオの id → 最後に始めた登録のジョブの id。 */
const latestCreateJobByUpdateScenario = new Map<string, string>();

/** 予定と状態を書く（同じ登録のジョブなら置き換える）。 */
export const recordWriteChain = (chain: WriteChainView): void => {
  chainsByCreateJob.set(chain.createJobId, Object.freeze({ ...chain }));
  latestCreateJobByUpdateScenario.set(chain.updateScenarioId, chain.createJobId);
};

/** 登録のジョブの、続けて始める予定と状態（なければ null）。 */
export const writeChainOfCreateJob = (createJobId: string): WriteChainView | null => chainsByCreateJob.get(createJobId) ?? null;

/** 更新のシナリオの、最後に続けて始めた予定と状態（なければ null）。 */
export const latestWriteChainOfUpdateScenario = (updateScenarioId: string): WriteChainView | null => {
  const createJobId = latestCreateJobByUpdateScenario.get(updateScenarioId);
  return createJobId === undefined ? null : writeChainOfCreateJob(createJobId);
};

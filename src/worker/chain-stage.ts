/**
 * まとめて実行の段 1 つ（RB-6。設計書 `2026-11-15-beaksight-test-rebuild-design.md` 2 章 5、案 6 章 B）。ワーカーの `runChain`（`audit-worker-session.ts`）は、段ごとに
 * `runChainStageOnce` を呼ぶ。テストは、前の段の結果（`ChainStageSeed`）を与えて、段 1 つだけに入る（前の段を本物で流さない）。
 * - 前の段の結果は、メモリの中だけで渡す（IPC・成果物・ログに出さない。Gate `chain-stage-entry`）。
 * - 書き込みの段の指定は、`START` と同じ確かめを通った値（`ValidatedChainWrite`。`validatedChainWriteOf` だけが作る）しか受けない。
 * 本番の順（親の承認の確かめ直し `issueExecutionGrant` の後に、書き込みつきの `NEXT_STAGE` が来る）は変えない。
 */
import type { AuditRunOptions } from '../cli/audit-run.js';
import type { AuditConfig } from '../config/types.js';
import {
  WORKER_AUDIT_JOB_KIND,
  WORKER_DISCOVERY_JOB_KIND,
  WORKER_READ_CHECK_JOB_KIND,
  WORKER_WRITE_CREATE_JOB_KIND,
  WORKER_WRITE_UPDATE_JOB_KIND,
  isWorkerChainWriteStageJobKind,
  nextStageWriteStartOf,
  validateParentToWorkerMessage,
  type WorkerChainStageKind,
  type WorkerChainWriteStageJobKind,
  type WorkerNextStageMessage,
  type WorkerStartApiWrite,
  type WorkerStartMessage,
  type WorkerStartReadCheck,
  type WorkerStartWrite,
} from '../control/worker-protocol.js';
import type { NavigationPacer } from '../crawl/navigation-pacer.js';
import type { RunStageCarried, RunStageCarry } from '../orchestration/audit-stage-run.js';
import type { RunAuthentication } from '../orchestration/authenticated-run.js';
import type { DiscoveryCheckpointOptions } from './discovery-run.js';

declare const VALIDATED_CHAIN_WRITE: unique symbol;

/** `START` と同じ確かめ（承認したサービスの Origin を含む）を通った、書き込みの段の指定（`validatedChainWriteOf` だけが作る）。 */
export type ValidatedChainWrite = (WorkerStartWrite | WorkerStartApiWrite) & { readonly [VALIDATED_CHAIN_WRITE]: true };

/**
 * 書き込みの段の `NEXT_STAGE` の指定を、`START` と同じ確かめに通す（OP-2）。書き込みの段でない・指定がない・確かめに通らないなら `null`。
 */
export function validatedChainWriteOf(start: WorkerStartMessage, next: WorkerNextStageMessage): ValidatedChainWrite | null {
  const writeStart = nextStageWriteStartOf(start, next);
  if (writeStart === null || next.write === undefined || !validateParentToWorkerMessage(writeStart).ok) {
    return null;
  }
  return next.write as ValidatedChainWrite;
}

/** まとめて実行の段 1 つ（OP-2: 書き込みの段は確かめを通った書き込みの指定を持つ）。 */
export interface ChainStage {
  readonly kind: WorkerChainStageKind | WorkerChainWriteStageJobKind;
  readonly jobId: string;
  readonly readChecks: readonly WorkerStartReadCheck[] | undefined;
  readonly write: ValidatedChainWrite | undefined;
  /** DEF-200: ログインし直して始めた段なら、その段のログインし直しの回数（1 から）。ほかは `undefined`。 */
  readonly relogin?: number | undefined;
}

/** 前の段の結果（段に入るときに与えるもの。メモリの中だけ）。 */
export interface ChainStageSeed {
  /** 段の認証の指定（初めの状態は、前の段の最新の状態。最初の段はログインの段の後の状態）。 */
  readonly authentication: RunAuthentication;
  /** 段の読み込みの間隔の部品（前の段の持ち越しから作ったもの。最初の段はログインの段と同じもの）。 */
  readonly navigationPacer: NavigationPacer;
  /** 前の段のサービスの Origin への要求の 1 分の窓（最初の段は空）。 */
  readonly serviceRequestWindowMs: readonly number[];
  /** OP-J（J1）: 直前の点検の段の Run のディレクトリ（操作さがしの段だけが使う）。 */
  readonly chainedAuditRunDirectory?: string | undefined;
  /** DEF-200: 操作さがしの状態の保存と続きの指定（自動ログインの連鎖の操作さがしだけ）。 */
  readonly discoveryCheckpoint?: DiscoveryCheckpointOptions | undefined;
}

/** 段の流れを始める関数（ワーカーの本番は、IPC を送る流れ）。終了コードを返す。渡されていない種類の段は `null`。 */
export interface ChainStageRunners {
  readonly audit: (
    runOptions: AuditRunOptions, config: AuditConfig, authentication: RunAuthentication, navigationPacer: NavigationPacer,
    automatedLogin: boolean, stageCarry: RunStageCarry, onRan: (runDirectory: string) => void,
  ) => Promise<number>;
  readonly discover: ((
    jobId: string, config: AuditConfig, authentication: RunAuthentication, navigationPacer: NavigationPacer, stageCarry: RunStageCarry,
    chainedAuditRunDirectory: string | undefined, checkpoint: DiscoveryCheckpointOptions | undefined, onRan: (runDirectory: string) => void,
  ) => Promise<number>) | null;
  readonly readCheck: ((
    jobId: string, readChecks: readonly WorkerStartReadCheck[], config: AuditConfig, authentication: RunAuthentication,
    navigationPacer: NavigationPacer, stageCarry: RunStageCarry,
  ) => Promise<number>) | null;
  readonly write: ((
    stage: ChainStage & { readonly kind: WorkerChainWriteStageJobKind }, write: ValidatedChainWrite, config: AuditConfig,
    authentication: RunAuthentication, navigationPacer: NavigationPacer, stageCarry: RunStageCarry,
  ) => Promise<number>) | null;
  /** 流れのない段（`JOB_KIND_NOT_SUPPORTED`）。終了コードを返す。 */
  readonly unsupported: (stage: ChainStage) => number;
}

export interface ChainStageInput {
  readonly stage: ChainStage;
  readonly runOptions: AuditRunOptions;
  readonly config: AuditConfig;
  readonly automatedLogin: boolean;
  readonly seed: ChainStageSeed;
}

export interface ChainStageResult {
  readonly exitCode: number;
  /** 段の終わりの持ち越し（段が記録しなかったら `null`）。 */
  readonly carried: RunStageCarried | null;
  /** 段が Run を実行したときの Run のディレクトリ（実行しなかったら `null`）。 */
  readonly runDirectory: string | null;
}

/** 段 1 つを行う（種類に対応する流れ。流れがない・定義がないなら `unsupported`）。 */
export async function runChainStageOnce(input: ChainStageInput, runners: ChainStageRunners): Promise<ChainStageResult> {
  const { stage, seed } = input;
  let carried: RunStageCarried | null = null;
  let runDirectory: string | null = null;
  const stageCarry: RunStageCarry = Object.freeze({
    serviceRequestWindowMs: seed.serviceRequestWindowMs,
    record: (value: RunStageCarried): void => {
      carried = value;
    },
  });
  const onRan = (directory: string): void => {
    runDirectory = directory;
  };
  const exitCode = await (async (): Promise<number> => {
    switch (stage.kind) {
      case WORKER_AUDIT_JOB_KIND:
        return runners.audit(input.runOptions, input.config, seed.authentication, seed.navigationPacer, input.automatedLogin, stageCarry, onRan);
      case WORKER_DISCOVERY_JOB_KIND:
        return runners.discover === null
          ? runners.unsupported(stage)
          : runners.discover(stage.jobId, input.config, seed.authentication, seed.navigationPacer, stageCarry, seed.chainedAuditRunDirectory,
            seed.discoveryCheckpoint, onRan);
      case WORKER_READ_CHECK_JOB_KIND:
        return runners.readCheck === null || stage.readChecks === undefined
          ? runners.unsupported(stage)
          : runners.readCheck(stage.jobId, stage.readChecks, input.config, seed.authentication, seed.navigationPacer, stageCarry);
      case WORKER_WRITE_CREATE_JOB_KIND:
      case WORKER_WRITE_UPDATE_JOB_KIND:
        return runners.write === null || stage.write === undefined || !isWorkerChainWriteStageJobKind(stage.kind)
          ? runners.unsupported(stage)
          : runners.write({ ...stage, kind: stage.kind }, stage.write, input.config, seed.authentication, seed.navigationPacer, stageCarry);
    }
  })();
  return Object.freeze({ exitCode, carried, runDirectory });
}

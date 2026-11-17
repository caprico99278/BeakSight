/**
 * Architecture Gate（RB-6。設計書 `2026-11-15-beaksight-test-rebuild-design.md` 2 章 5、案 6 章 B）: テストだけが使う段の入口（`runChainStageOnce`）を足しても、本番の順
 * （親が承認を確かめ直してから、書き込みつきの `NEXT_STAGE` を送る）が変わらないこと。判定は `fs`、正規表現、文字列の走査だけ（`source-scan.ts`）。
 * - (1) `runChainStageOnce` を呼ぶ src は、ワーカーの流れ（`audit-worker-session.ts` の `runChain`）の 1 か所だけ。
 * - (2) 前の段の結果の型（`ChainStageSeed`）は、段の部品の外に現れない（契約・IPC の検証・ジョブの管理・画面のサーバから持ち越しを渡す口を作らない）。
 * - (3) 書き込みの段の指定の印（`ValidatedChainWrite`）を付けるのは、`START` と同じ確かめを通す `validatedChainWriteOf` だけ。
 * - (4) 親が書き込みつきの `NEXT_STAGE` を送るのは 1 か所（`#startChainWriteStage`）。それを始めるのは `#advanceToWriteStage` の 1 か所で、その中の
 *   `issueExecutionGrant` の後。送る直前の確かめ直しを許す印（`recheckAllowed = true`）を立てるのは `#recheckWrite` だけ。
 * - ファイル全体を 1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import { MAX_GATE_MS, countIdentifier, findCallSites, loadLocalUiSourceFiles, loadSourceFiles, startCpuStopwatch } from './source-scan.js';

const GATE_STOPWATCH = startCpuStopwatch();
const SOURCE_FILES = loadSourceFiles();
const ALL_FILES = [...SOURCE_FILES, ...loadLocalUiSourceFiles()];

const CHAIN_STAGE_PATH = 'src/worker/chain-stage.ts';
const WORKER_SESSION_PATH = 'src/worker/audit-worker-session.ts';
const JOB_MANAGER_PATH = 'src/control/job/audit-job-manager.ts';

/** 親が `NEXT_STAGE` を送るオブジェクト（`type: 'NEXT_STAGE'` から閉じ括弧まで。引用符は `\x27` で書く）。 */
const NEXT_STAGE_SEND = /type:\s*\x27NEXT_STAGE\x27[^}]*\}/gu;

/** 書き込みの段の指定の印を付ける型の言い切り（`as ValidatedChainWrite` と `<ValidatedChainWrite>`。型の引数 `Readonly<…>` は数えない）。 */
const VALIDATED_WRITE_ASSERTION = /\bas\s+ValidatedChainWrite\b|(?<![\w$])<\s*ValidatedChainWrite\s*>/gu;

const fileOf = (path: string): (typeof SOURCE_FILES)[number] | undefined => SOURCE_FILES.find((file) => file.path === path);

/** class の中の private のメソッド `#name` の本文（定義の行から、次のメソッドの定義の行の前まで）。見つからなければ空。 */
const methodBodyOf = (code: string, name: string): string => {
  const start = new RegExp(String.raw`\n  (?:async )?#${name}\(`, 'u').exec(code);
  if (start === null) {
    return '';
  }
  const rest = code.slice(start.index + start[0].length);
  const next = /\n  (?:async )?#\w+\(/u.exec(rest);
  return rest.slice(0, next === null ? undefined : next.index);
};

describe('RB-6: the test-only stage entry keeps the production order of the chained run', () => {
  it('(1) only the chained run of the worker calls runChainStageOnce', () => {
    const callers = SOURCE_FILES.filter(({ path, bare }) => path !== CHAIN_STAGE_PATH && findCallSites(bare, 'runChainStageOnce').length > 0)
      .map(({ path }) => path);
    expect(callers).toEqual([WORKER_SESSION_PATH]);
    expect(findCallSites(fileOf(WORKER_SESSION_PATH)?.bare ?? '', 'runChainStageOnce')).toHaveLength(1);
  });

  it('(2) the seed of the stage before stays inside the stage owner (no contract, IPC check, job manager or screen server knows it)', () => {
    expect(ALL_FILES.filter(({ bare }) => countIdentifier(bare, 'ChainStageSeed') > 0).map(({ path }) => path)).toEqual([CHAIN_STAGE_PATH]);
  });

  it('(3) only validatedChainWriteOf marks a write specification as checked', () => {
    const marks = SOURCE_FILES.flatMap(({ path, bare }) => [...bare.matchAll(VALIDATED_WRITE_ASSERTION)].map(() => path));
    expect(marks).toEqual([CHAIN_STAGE_PATH]);
    const owner = fileOf(CHAIN_STAGE_PATH)?.bare ?? '';
    const body = owner.slice(owner.indexOf('function validatedChainWriteOf('));
    expect(body.indexOf('as ValidatedChainWrite')).toBeGreaterThan(body.indexOf('validateParentToWorkerMessage('));
  });

  it('(3) finds both forms of the type assertion (control)', () => {
    const found = (code: string): number => [...code.matchAll(VALIDATED_WRITE_ASSERTION)].length;
    expect(found('const w = next.write as ValidatedChainWrite;')).toBe(1);
    expect(found('const w = <ValidatedChainWrite>next.write;')).toBe(1);
    expect(found('const w: ValidatedChainWrite | null = validatedChainWriteOf(start, next);')).toBe(0);
    expect(found('const ws: Readonly<ValidatedChainWrite>[] = [];')).toBe(0);
  });

  it('(4) the parent sends the write stage once, after it issued the execution grant, and only the recheck allows the submission', () => {
    const code = fileOf(JOB_MANAGER_PATH)?.code ?? '';
    const nextStageSends = [...code.matchAll(NEXT_STAGE_SEND)].map(([send]) => send);
    expect(nextStageSends.filter((send) => /\bwrite\b/u.test(send))).toHaveLength(1);
    expect([...methodBodyOf(code, 'startChainWriteStage').matchAll(NEXT_STAGE_SEND)].filter(([send]) => /\bwrite\b/u.test(send))).toHaveLength(1);
    expect(findCallSites(code, 'this.#startChainWriteStage')).toHaveLength(1);
    const advance = methodBodyOf(code, 'advanceToWriteStage');
    const grant = advance.indexOf('issueExecutionGrant(');
    expect(grant).toBeGreaterThanOrEqual(0);
    expect(advance.indexOf('this.#startChainWriteStage(')).toBeGreaterThan(grant);
    expect([...code.matchAll(/\.recheckAllowed\s*=\s*true\b/gu)]).toHaveLength(1);
    expect(methodBodyOf(code, 'recheckWrite')).toMatch(/\.recheckAllowed\s*=\s*true\b/u);
  });

  it('finishes within the gate time limit', () => {
    expect(GATE_STOPWATCH.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });
});

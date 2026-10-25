/**
 * ジョブの種類の定数の Gate（T44g。Task 44 の設計書 P4-8 の CC-105）。
 * - ジョブの種類の値（`WORKER_JOB_KINDS` の値）の名前つきの定数は、`WORKER_*_JOB_KIND` として 1 つずつ置く。
 *   画面（`apps/local-ui/src/`）では、`'AUDIT' satisfies AuditJobKind` のような同じ定数を置き直さず、owner の定数を読む。
 * - PRE42-CC 組 UI-K（N4-8f・CC-105 の `$jobId.tsx`）: ジョブの種類と状態の値（一覧と名前つきの定数）の owner は、純粋なファイル
 *   `src/core/audit-job-values.ts`（import を持たない。Node の部品と管理データに触れない）。IPC の契約（`src/control/worker-protocol.ts`）と
 *   ジョブの記録（`src/control/job/job-records.ts`）は、そこを公開し直す。画面のブラウザ側（`apps/local-ui/src/` の `server/` の外）も、そこから読む。
 *   owner の外（`src/` と画面）では、種類の名前つきの定数（`'AUDIT' satisfies WorkerJobKind` の形）を置かない。
 * - (b) PRE42-CC 組 3（CC-105 の B）: 画面のサーバ（`apps/local-ui/src/server/`）では、ジョブの種類の値を、値の位置（オブジェクトの値、比べる式、
 *   `case`、三項の式の値、定数の定義）に文字列リテラルで書かず、`WORKER_*_JOB_KIND` を読む。型の位置（`readonly kind: 'DISCOVERY';`、
 *   `Extract<AuditJobKind, 'WRITE_CREATE' | …>`）と関数の引数の位置は数えない（`isProfileOperationAllowed('LOGIN_CHECK', …)` はプロファイルの操作の
 *   値で、意味が違う）。組 UI-K: 範囲を画面のブラウザ側に広げる（`satisfies` のない定数 `const LOGIN_CHECK_JOB_KIND = 'LOGIN_CHECK'` も数える）。
 *   同じ文字列で意味の違う値（「次にすること」の手順の値）は、ファイルと形の組で、理由を付けて除外する。
 * - (c) PRE42-CC 組 3（N4-8b）: ジョブの状態の値（`AUDIT_JOB_STATES` の値）の名前つきの定数は、owner に置く（`FINISHED_AUDIT_JOB_STATE`。組 UI-K で
 *   `STOPPING_AUDIT_JOB_STATE`・`FAILED_AUDIT_JOB_STATE` を足し、owner を `src/core/audit-job-values.ts` に移した）。owner の外（`src/` と画面）では、
 *   `'FINISHED' satisfies AuditJobState`、`: AuditJobState = 'FINISHED'` の形の定数を置かない。画面では、型をつけない形
 *   （`const FINISHED_STATE = 'FINISHED'`。名前に `STATE` を含む定数）も置かない（組 UI-K: 画面のサーバから画面全体に広げた）。
 *   組 UI-K: ジョブの状態を文字列リテラルと比べない（`job.state !== 'STOPPING'`。左右どちらでも。受け手の名前が `job`・`…Job` の `state` か
 *   `jobState`。`src/` と画面）。ほかの状態の一覧（まとめて実行の `chain.state`、チェックポイントの `checkpoint.state`）は、受け手の名前で除く。
 * - (d) PRE42-CC 組 UI-K（組 2 の引き継ぎ。CC-106 の残り）: 画面（`apps/local-ui/src/`）では、シナリオの種類（`SCENARIO_KINDS` の値）を文字列リテラルと
 *   比べない（`scenario.kind !== 'UPDATE'`、`candidate.scenarioKind === 'UPDATE'`、`case 'UPDATE'`）。`src/core/scenario-kind.ts` の定数を読む。
 *   同じ文字列で意味の違う値（自動の下書きの READ の確かめの選び方 `choice.kind`）は、ファイルと形の組で、理由を付けて除外する。
 * - 判定は、Node.js 標準の `fs`、正規表現、文字列の検索だけで行う（近似の検査。コメントは数えない）。走査は重いので、本文の文字列で絞ってから行う
 *   （DEF-107）。1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import { AUDIT_JOB_STATES } from '../../src/control/job/job-records.js';
import { WORKER_JOB_KINDS } from '../../src/control/worker-protocol.js';
import { SCENARIO_KINDS } from '../../src/core/scenario-kind.js';
import {
  LOCAL_UI_SOURCE_DIRECTORY,
  MAX_GATE_MS,
  findModuleSpecifiers,
  readTypeScriptFilesUnder,
  scanSource,
  startCpuStopwatch,
  unusedExclusionsOf,
  violationsOf,
  type UnscannedFile,
} from './source-scan.js';

/** 判定の上限（ms。`source-scan.ts` の `MAX_GATE_MS`。PRE42-CC 組 G）。 */
const MAX_MS = MAX_GATE_MS;

const LOCAL_UI_FILES = readTypeScriptFilesUnder(LOCAL_UI_SOURCE_DIRECTORY);
const SOURCE_FILES = readTypeScriptFilesUnder('src');

/** 画面のサーバの置き場所。 */
const LOCAL_UI_SERVER_DIRECTORY = `${LOCAL_UI_SOURCE_DIRECTORY}/server/`;
/** ジョブの種類と状態の値の owner（組 UI-K。純粋なファイル）。 */
const JOB_VALUES_OWNER_PATH = 'src/core/audit-job-values.ts';
/** owner を公開し直すファイル（定義を置き直さない）。 */
const JOB_VALUES_REEXPORT_PATHS: readonly string[] = ['src/control/worker-protocol.ts', 'src/control/job/job-records.ts'];

const KIND_ALTERNATIVES = WORKER_JOB_KINDS.join('|');
const STATE_ALTERNATIVES = AUDIT_JOB_STATES.join('|');
const SCENARIO_KIND_ALTERNATIVES = SCENARIO_KINDS.join('|');

/** ジョブの種類の値を、ジョブの種類の型で確かめた定数（`'<値>' satisfies AuditJobKind` か `WorkerJobKind`）。 */
const LOCAL_JOB_KIND_CONSTANT = new RegExp(`'(${KIND_ALTERNATIVES})'\\s+satisfies\\s+(AuditJobKind|WorkerJobKind)\\b`, 'gu');

/**
 * (b) 値の位置のジョブの種類の文字列リテラル（近似）。
 * - オブジェクトの値（`jobKind: 'LOGIN_CHECK'`、`CREATE: 'WRITE_CREATE',`。型の `readonly kind: 'DISCOVERY';` は、前の `readonly` と後ろの `;` で除く）。
 * - 比べる式（`=== 'AUDIT'`、`'AUDIT' !==`）、`case 'AUDIT':`、三項の式の値（`? 'AUDIT'`）、定数の定義（`const X = 'AUDIT'`、`const X: T = 'AUDIT'`）。
 */
const KIND_VALUE_POSITIONS: readonly RegExp[] = [
  new RegExp(`(?<![\\w$])(?<!\\breadonly\\s+)[\\w$]+\\s*:\\s*'(?:${KIND_ALTERNATIVES})'(?=\\s*(?:[,}]|$))`, 'gmu'),
  new RegExp(`[=!]==?\\s*'(?:${KIND_ALTERNATIVES})'`, 'gu'),
  new RegExp(`'(?:${KIND_ALTERNATIVES})'\\s*[=!]==?`, 'gu'),
  new RegExp(`\\bcase\\s+'(?:${KIND_ALTERNATIVES})'`, 'gu'),
  new RegExp(`\\?\\s*'(?:${KIND_ALTERNATIVES})'`, 'gu'),
  new RegExp(`\\bconst\\s+[\\w$]+\\s*(?::\\s*[\\w$.]+\\s*)?=\\s*'(?:${KIND_ALTERNATIVES})'`, 'gu'),
];
const KIND_LITERAL_PREFILTER = new RegExp(`'(?:${KIND_ALTERNATIVES})'`, 'u');
/** (b) の除外（`<ファイル>: <形>` と理由。組 UI-K）。除外の一覧は、このファイルの中の 1 か所だけ。 */
const KIND_VALUE_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  [
    `${LOCAL_UI_SOURCE_DIRECTORY}/components/NextSteps.tsx: case 'LOGIN_CHECK'`,
    '「次にすること」の手順の値（`PROFILE_NEXT_STEPS` の `LOGIN_CHECK`。ログインの確かめの画面への手順）で、ジョブの種類ではない',
  ],
  [
    `${LOCAL_UI_SOURCE_DIRECTORY}/display/next-steps.ts: case 'LOGIN_CHECK'`,
    '「次にすること」の手順の値（`PROFILE_NEXT_STEPS` の owner。ログインの確かめの画面への手順）で、ジョブの種類ではない',
  ],
]);

/** (c) ジョブの状態の型の名前（owner と `job-records.ts` の型）。 */
const JOB_STATE_TYPES = 'AuditJobState|ActiveAuditJobState|FinalAuditJobState';
/** (c) 型で確かめたジョブの状態の定数（`src/` と画面の両方）。 */
const TYPED_JOB_STATE_CONSTANTS: readonly RegExp[] = [
  new RegExp(`'(?:${STATE_ALTERNATIVES})'\\s+satisfies\\s+(?:${JOB_STATE_TYPES})\\b`, 'gu'),
  new RegExp(`:\\s*(?:${JOB_STATE_TYPES})\\s*=\\s*'(?:${STATE_ALTERNATIVES})'`, 'gu'),
];
/** (c) 画面の、型をつけないジョブの状態の定数（名前に `STATE` を含む）。 */
const UNTYPED_JOB_STATE_CONSTANT = new RegExp(`\\bconst\\s+[\\w$]*STATE[\\w$]*\\s*=\\s*'(?:${STATE_ALTERNATIVES})'`, 'gu');
/** (c) 組 UI-K: ジョブの状態と文字列リテラルの比べ（受け手は `job.state`・`…Job.state`・`…job?.state`・`jobState`）。 */
const JOB_STATE_RECEIVER = String.raw`(?:(?:[\w$]+\s*\??\.\s*)*[\w$]*[jJ]ob\s*\??\.\s*state|[\w$]*[jJ]obState)(?![\w$])`;
const JOB_STATE_COMPARISONS: readonly RegExp[] = [
  new RegExp(`${JOB_STATE_RECEIVER}\\s*[=!]==?\\s*'(?:${STATE_ALTERNATIVES})'`, 'gu'),
  new RegExp(`'(?:${STATE_ALTERNATIVES})'\\s*[=!]==?\\s*${JOB_STATE_RECEIVER}`, 'gu'),
];
const STATE_LITERAL_PREFILTER = new RegExp(`'(?:${STATE_ALTERNATIVES})'`, 'u');
/** (c) owner が置く、状態の名前つきの定数。 */
const OWNER_JOB_STATE_CONSTANTS: readonly (readonly [string, string])[] = [
  ['FINISHED_AUDIT_JOB_STATE', 'FINISHED'],
  ['STOPPING_AUDIT_JOB_STATE', 'STOPPING'],
  ['FAILED_AUDIT_JOB_STATE', 'FAILED'],
];

/** (d) シナリオの種類と文字列リテラルの比べ（受け手の名前が `kind`・`…Kind`）と、`case`。 */
const SCENARIO_KIND_RECEIVER = String.raw`(?:[\w$]+\s*\??\.\s*)*[\w$]*[kK]ind(?![\w$])`;
const SCENARIO_KIND_COMPARISONS: readonly RegExp[] = [
  new RegExp(`${SCENARIO_KIND_RECEIVER}\\s*[=!]==?\\s*'(?:${SCENARIO_KIND_ALTERNATIVES})'`, 'gu'),
  new RegExp(`'(?:${SCENARIO_KIND_ALTERNATIVES})'\\s*[=!]==?\\s*${SCENARIO_KIND_RECEIVER}`, 'gu'),
  new RegExp(`\\bcase\\s+'(?:${SCENARIO_KIND_ALTERNATIVES})'`, 'gu'),
];
const SCENARIO_KIND_PREFILTER = new RegExp(`'(?:${SCENARIO_KIND_ALTERNATIVES})'`, 'u');
/** (d) の除外（`<ファイル>: <形>` と理由）。除外の一覧は、このファイルの中の 1 か所だけ。 */
const AUTO_DRAFT_CHOICE_REASON = '自動の下書きの READ の確かめの選び方（`autoDraftReadCheckChoiceOf` の `EXISTING`・`CREATE`・`NOT_INFERRED`）で、シナリオの種類ではない';
const SCENARIO_KIND_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  [`${LOCAL_UI_SERVER_DIRECTORY}scenario-autodraft-functions.ts: choice.kind === 'CREATE'`, AUTO_DRAFT_CHOICE_REASON],
  [`${LOCAL_UI_SERVER_DIRECTORY}scenario-autodraft-functions.ts: choice.kind !== 'CREATE'`, AUTO_DRAFT_CHOICE_REASON],
]);

const matchesOf = (code: string, patterns: readonly RegExp[]): readonly string[] =>
  patterns.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[0]));

/** (b) 1 つの本文の、値の位置のジョブの種類の文字列リテラル（コメントを除く）。 */
const findKindValueLiterals = (content: string): readonly string[] => matchesOf(scanSource(content).code, KIND_VALUE_POSITIONS);

/** (c) 1 つの本文の、ジョブの状態の定数（`untyped` は、型をつけない形も数えるか）。 */
const findJobStateConstants = (content: string, untyped: boolean): readonly string[] =>
  matchesOf(scanSource(content).code, untyped ? [...TYPED_JOB_STATE_CONSTANTS, UNTYPED_JOB_STATE_CONSTANT] : TYPED_JOB_STATE_CONSTANTS);

/** (c) 1 つの本文の、ジョブの状態と文字列リテラルの比べ（コメントを除く）。 */
const findJobStateComparisons = (content: string): readonly string[] => matchesOf(scanSource(content).code, JOB_STATE_COMPARISONS);

/** (d) 1 つの本文の、シナリオの種類と文字列リテラルの比べ（コメントを除く）。 */
const findScenarioKindComparisons = (content: string): readonly string[] => matchesOf(scanSource(content).code, SCENARIO_KIND_COMPARISONS);

/** 本文の文字列で絞ってから、見つけたものを `<パス>: <見つけたもの>` の形で並べる（`source-scan.ts` の `violationsOf`。PRE42-CC 組 G）。 */
const prefilteredViolationsOf = (
  files: readonly UnscannedFile[],
  prefilter: RegExp,
  find: (file: UnscannedFile) => readonly string[],
): readonly string[] => violationsOf(files.filter(({ content }) => prefilter.test(content)), find);

const ownerFile = (): UnscannedFile | undefined => SOURCE_FILES.find(({ path }) => path === JOB_VALUES_OWNER_PATH);

describe('Architecture Gate: the job kind constants (T44g, CC-105)', () => {
  it('keeps no local constant of a job kind in the local UI sources (they read WORKER_*_JOB_KIND of the IPC contract)', () => {
    const stopwatch = startCpuStopwatch();
    const found = LOCAL_UI_FILES
      .flatMap(({ path, content }) => [...content.matchAll(LOCAL_JOB_KIND_CONSTANT)].map((match) => `${path}: ${match[0]}`));
    expect(found).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS);
  });

  it('defines the job kinds and states only in the pure src/core/audit-job-values.ts (PRE42-CC group UI-K, N4-8f)', () => {
    const stopwatch = startCpuStopwatch();
    const owner = ownerFile();
    expect(owner, JOB_VALUES_OWNER_PATH).toBeDefined();
    const ownerCode = scanSource(owner?.content ?? '').code;
    // 純粋なファイル: import を持たない（Node の部品と管理データに触れないので、画面のブラウザ側から読める）。
    expect(findModuleSpecifiers(ownerCode)).toEqual([]);
    expect(/\bexport\s+const\s+WORKER_JOB_KINDS\s*=\s*Object\.freeze\(\[/u.test(ownerCode), 'WORKER_JOB_KINDS').toBe(true);
    expect(/\bexport\s+const\s+AUDIT_JOB_STATES\s*=\s*Object\.freeze\(\[/u.test(ownerCode), 'AUDIT_JOB_STATES').toBe(true);
    for (const kind of WORKER_JOB_KINDS) {
      expect(new RegExp(`\\bexport\\s+const\\s+WORKER_${kind}_JOB_KIND\\s*=\\s*'${kind}'\\s+satisfies\\s+WorkerJobKind\\b`, 'u').test(ownerCode), kind).toBe(true);
    }
    // owner の外の `src/` は、種類の名前つきの定数と、一覧の定義を置かない（公開し直すだけ）。
    const others = SOURCE_FILES.filter(({ path }) => path !== JOB_VALUES_OWNER_PATH);
    expect(others.flatMap(({ path, content }) =>
      [...scanSource(content).code.matchAll(LOCAL_JOB_KIND_CONSTANT)].map((match) => `${path}: ${match[0]}`))).toEqual([]);
    for (const path of JOB_VALUES_REEXPORT_PATHS) {
      const code = scanSource(SOURCE_FILES.find((file) => file.path === path)?.content ?? '').code;
      expect(code, path).toMatch(/audit-job-values\.js/u);
      expect(/\bexport\s+const\s+(?:WORKER_JOB_KINDS|AUDIT_JOB_STATES)\s*=/u.test(code), path).toBe(false);
    }
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS);
  });

  it('(b) writes no job kind literal at a value position in the local UI (PRE42-CC, CC-105 B; the browser side by group UI-K)', () => {
    const stopwatch = startCpuStopwatch();
    expect(LOCAL_UI_FILES.some(({ path }) => path.startsWith(LOCAL_UI_SERVER_DIRECTORY))).toBe(true);
    expect(LOCAL_UI_FILES.some(({ path }) => !path.startsWith(LOCAL_UI_SERVER_DIRECTORY))).toBe(true);
    const found = prefilteredViolationsOf(LOCAL_UI_FILES, KIND_LITERAL_PREFILTER, ({ content }) => findKindValueLiterals(content));
    expect(found.filter((entry) => !KIND_VALUE_EXCLUSIONS.has(entry))).toEqual([]);
    // 除外は、まだ使われている（使われない除外が、新しい書き写しを隠さない）。
    expect(unusedExclusionsOf(KIND_VALUE_EXCLUSIONS.keys(), found)).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS);
  });

  it('(c) keeps the named job state constants in the owner only and compares no job state with a literal (PRE42-CC, N4-8b, group UI-K)', () => {
    const stopwatch = startCpuStopwatch();
    const violations = [
      ...prefilteredViolationsOf(SOURCE_FILES.filter(({ path }) => path !== JOB_VALUES_OWNER_PATH), STATE_LITERAL_PREFILTER, ({ content }) =>
        findJobStateConstants(content, false)),
      ...prefilteredViolationsOf(LOCAL_UI_FILES, STATE_LITERAL_PREFILTER, ({ content }) => findJobStateConstants(content, true)),
      ...prefilteredViolationsOf([...SOURCE_FILES, ...LOCAL_UI_FILES], STATE_LITERAL_PREFILTER, ({ content }) => findJobStateComparisons(content)),
    ];
    expect(violations).toEqual([]);
    const ownerCode = scanSource(ownerFile()?.content ?? '').code;
    for (const [name, value] of OWNER_JOB_STATE_CONSTANTS) {
      expect(new RegExp(`\\bexport\\s+const\\s+${name}\\s*=\\s*'${value}'\\s+satisfies\\s+AuditJobState\\b`, 'u').test(ownerCode), `${JOB_VALUES_OWNER_PATH} defines ${name}`)
        .toBe(true);
    }
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS);
  });

  it('(d) compares no scenario kind with a literal in the local UI (PRE42-CC group UI-K, CC-106)', () => {
    const stopwatch = startCpuStopwatch();
    const found = prefilteredViolationsOf(LOCAL_UI_FILES, SCENARIO_KIND_PREFILTER, ({ content }) => findScenarioKindComparisons(content));
    expect(found.filter((entry) => !SCENARIO_KIND_EXCLUSIONS.has(entry))).toEqual([]);
    expect(unusedExclusionsOf(SCENARIO_KIND_EXCLUSIONS.keys(), found)).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS);
  });

  // 各規則が、現実的な書き方の違反で RED になり、型の位置と意味の違う値では RED にならないこと（検出の関数の自己確認）。
  it('detects realistic violations and ignores type positions (detector self-check)', () => {
    // (b) 値の位置。
    expect(findKindValueLiterals("const c = check({ ...input, jobKind: 'LOGIN_CHECK' });")).toHaveLength(1);
    expect(findKindValueLiterals("const MAP = Object.freeze({\n  CREATE: 'WRITE_CREATE',\n  UPDATE: 'WRITE_UPDATE',\n});")).toHaveLength(2);
    expect(findKindValueLiterals("return ok ? { kind: 'DISCOVERY', endReason } : { kind: 'READ_CHECK' };")).toHaveLength(2);
    expect(findKindValueLiterals("const kind = ok ? 'DISCOVERY' : WORKER_READ_CHECK_JOB_KIND;")).toHaveLength(1);
    expect(findKindValueLiterals("if (job.jobKind === 'AUDIT') {}")).toHaveLength(1);
    expect(findKindValueLiterals("if ('AUDIT' !== job.jobKind) {}")).toHaveLength(1);
    expect(findKindValueLiterals("switch (kind) { case 'ENTRY_CHECK': break; }")).toHaveLength(1);
    expect(findKindValueLiterals("const AUDIT_KIND = 'AUDIT';")).toHaveLength(1);
    expect(findKindValueLiterals("const AUDIT_KIND: AuditJobKind = 'AUDIT';")).toHaveLength(1);
    // (b) 組 UI-K: 画面のブラウザ側の、型をつけない定数と比べ（`$jobId.tsx`・`StageChainPanel.tsx` の形）。
    expect(findKindValueLiterals("const LOGIN_CHECK_JOB_KIND = 'LOGIN_CHECK';")).toEqual(["const LOGIN_CHECK_JOB_KIND = 'LOGIN_CHECK'"]);
    expect(findKindValueLiterals("{chain.stages[0] === 'AUDIT' ? <p /> : null}")).toEqual(["=== 'AUDIT'"]);
    // (b) 型の位置、関数の引数、コメントは数えない。
    expect(findKindValueLiterals("type V =\n  | { readonly kind: 'DISCOVERY'; readonly endReason: string }\n  | { readonly kind: 'READ_CHECK'; readonly endReason: string };")).toHaveLength(0);
    expect(findKindValueLiterals("export type WriteJobKind = Extract<AuditJobKind, 'WRITE_CREATE' | 'WRITE_UPDATE'>;")).toHaveLength(0);
    expect(findKindValueLiterals("if (!isProfileOperationAllowed('LOGIN_CHECK', profile.mode, profile.auth)) {}")).toHaveLength(0);
    expect(findKindValueLiterals("// jobKind: 'LOGIN_CHECK' is read from the contract\nconst x = 1;")).toHaveLength(0);
    expect(findKindValueLiterals("const c = check({ ...input, jobKind: WORKER_LOGIN_CHECK_JOB_KIND });")).toHaveLength(0);
    // (c) 型で確かめた定数（どこでも）と、型をつけない定数（画面だけ）。
    expect(findJobStateConstants("const FINISHED_STATE = 'FINISHED' satisfies AuditJobState;", false)).toHaveLength(1);
    expect(findJobStateConstants("const AUDIT_STAGE_JOB_STATE: AuditJobState = 'FINISHED';", false)).toHaveLength(1);
    expect(findJobStateConstants("const FINISHED_STATE = 'FINISHED';", false)).toHaveLength(0);
    expect(findJobStateConstants("const FINISHED_STATE = 'FINISHED';", true)).toHaveLength(1);
    expect(findJobStateConstants("const FINISHED_JOB_STATE = 'FINISHED';", true)).toHaveLength(1);
    // (c) 意味の違う値（ジョブの状態の型でない定数、名前に STATE を含まない定数）と、owner の定数を読む形は数えない。
    expect(findJobStateConstants("export const CHAIN_STATES = Object.freeze(['RUNNING', 'FINISHED', 'STOPPED'] as const);", true)).toHaveLength(0);
    expect(findJobStateConstants("const RESULT = 'FAILED';", true)).toHaveLength(0);
    expect(findJobStateConstants('if (job.state !== FINISHED_AUDIT_JOB_STATE) {}', true)).toHaveLength(0);
    // (c) 組 UI-K: ジョブの状態と文字列リテラルの比べ（`audit-job-functions.ts`・`$jobId.tsx` の形。左右どちらでも）。
    expect(findJobStateComparisons("if (job.state !== 'STOPPING' || job.stopRequestedAt === null) {}")).toEqual(["job.state !== 'STOPPING'"]);
    expect(findJobStateComparisons("<Notice kind={job.state === 'FAILED' ? 'critical' : 'caution'} />")).toEqual(["job.state === 'FAILED'"]);
    expect(findJobStateComparisons("const done = data?.job?.state === 'FINISHED' || 'RUNNING' === currentJob.state;")).toHaveLength(2);
    expect(findJobStateComparisons("if (jobState === 'INTERRUPTED') {}")).toHaveLength(1);
    // (c) ほかの状態の一覧（まとめて実行・チェックポイント・観測）と、owner の定数を読む形と、コメントは数えない。
    expect(findJobStateComparisons("{chain.state !== 'RUNNING' ? null : <p />}")).toHaveLength(0);
    expect(findJobStateComparisons("return data?.stageChain?.state === 'RUNNING';")).toHaveLength(0);
    expect(findJobStateComparisons("if (conclusion.checkpoint.state !== 'FINISHED') {}")).toHaveLength(0);
    expect(findJobStateComparisons('if (job.state === STOPPING_AUDIT_JOB_STATE) {}')).toHaveLength(0);
    expect(findJobStateComparisons("// job.state !== 'STOPPING'\nconst x = 1;")).toHaveLength(0);
    // (d) シナリオの種類の比べ（`ScenarioForm.tsx`・`scenarios/…/index.tsx` の形）と `case`。
    expect(findScenarioKindComparisons("const updateView = candidate.scenarioKind === 'UPDATE' && api === null ? update : null;"))
      .toEqual(["candidate.scenarioKind === 'UPDATE'"]);
    expect(findScenarioKindComparisons("{scenario.kind !== 'UPDATE' ? null : <p />}")).toEqual(["scenario.kind !== 'UPDATE'"]);
    expect(findScenarioKindComparisons("if ('CREATE' === kind) {}\nswitch (kind) { case 'UPDATE': break; }")).toHaveLength(2);
    // (d) 定数を読む形、受け手の名前が種類でない値、コメントは数えない。
    expect(findScenarioKindComparisons('{scenario.kind !== UPDATE_SCENARIO_KIND ? null : <p />}')).toHaveLength(0);
    expect(findScenarioKindComparisons("if (item.status === 'CREATE') {}")).toHaveLength(0);
    expect(findScenarioKindComparisons("// scenario.kind === 'UPDATE'\nconst x = 1;")).toHaveLength(0);
  });
});

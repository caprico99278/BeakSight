/**
 * シナリオの承認の判定の SSOT と、承認の部品の境界の Architecture Gate（Task 28 の設計書 5 章、6 章の Gate。T28a）。
 * - (a) 承認が有効かの判定（`evaluateApprovalValidity`、期限の計算 `approvalExpiresAtOf`、理由の一覧 `APPROVAL_INVALIDITY_REASONS`）は、
 *   `src/control/approval/approval-validity.ts` にだけ定義する。承認の digest（`computeApprovalDigest`、`approvalBoundFactsOf`、
 *   `APPROVAL_DIGEST_FORMAT`）は `approval-digest.ts` にだけ、下書きの確かめ（`validateScenarioDraft`）は `scenario-policy.ts` にだけ定義する。
 * - (b) 同じ意味の判定を owner の外に書かない: 承認の期限の 1 日の長さ（`APPROVAL_TTL_DAY_MS`）は、定義（`scenario-contracts.ts`）と期限の
 *   計算の owner（`approval-validity.ts`）の外で参照しない。期限の日数（`APPROVAL_TTL_DAYS`、`approvalTtlDays`）を掛け算に使う（日数から時刻を
 *   求める）のは owner だけ。
 * - (c) `src/control/approval/` は、`src/browser/`・`src/worker/`・`src/orchestration/`・Playwright を参照しない（型だけの import を含む）。
 *   実行時に読み込む import をたどった先にも現れない（書き込みの要求を送る部品に届かない）。T30a fix round 1: 書き込みの結果の契約と判定
 *   （`src/control/actions/`。Task 30 の設計書 3 章）にも、同じ (c) を当てる。
 * - (d)（T28e）: 画面向けの公開し直し（`src/control/approval-view.ts`）は、承認の期限の 1 日の長さ（`APPROVAL_TTL_DAY_MS`）と、実行の許可と予約と
 *   入力の規則の参照の口（`issueExecutionGrant`、`consumeExecutionGrant`、`assertGrantStillValid`、`settleWriteReservation`、
 *   `readExecutionGrant`、`attachInputRuleReference`）を公開し直さない（この Task の画面は、書き込みの要求の動線を持たない。許可の発行は
 *   Task 30、入力の規則は Task 29）。公開し直すのは `src/control/approval/` のものだけで、判定を持たない（定義の文を持たない）。
 *   T30g（T30g の Blocker の判断（案 A）。注記の「許可の発行は Task 30」のとおり）: 実行の許可の発行（`issueExecutionGrant`）を、公開しない名前の
 *   一覧から外した。消費・確かめ直し・予約の締め・`readExecutionGrant`・入力の規則の参照を付ける口は、今どおり公開しない。
 * - (e)（T30g）: 画面のコード（`apps/local-ui/src/`）で実行の許可の発行（`issueExecutionGrant`）を参照するのは、書き込みの開始の Server Function の
 *   ファイル（`apps/local-ui/src/server/write-job-functions.ts`）1 つだけ。
 * - 判定は、`fs`、正規表現、文字列の走査だけ（`source-scan.ts` の共通の部品）。`src/**` の読み込みは、このファイルの読み込み時に 1 回だけ。
 *   1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import {
  PLAYWRIGHT_PACKAGE_PATTERN,
  countIdentifier,
  findModuleSpecifiers,
  findTransitiveForbiddenReferences,
  loadLocalUiSourceFiles,
  loadSourceFiles,
  moduleReferenceCandidatesOf,
  resolveRelativeSpecifier,
  scanSource,
  type ScannedSource,
  type SourceFile,
} from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

const APPROVAL_DIRECTORY = 'src/control/approval/';
/** (c) 同じ境界を当てる、書き込みの結果の契約と判定のディレクトリ（T30a fix round 1）。 */
const ACTIONS_DIRECTORY = 'src/control/actions/';
const ACTIONS_CONTRACTS_FILE = 'src/control/actions/action-contracts.ts';
const ACTIONS_OUTCOME_FILE = 'src/control/actions/action-outcome.ts';
const CONTRACTS_FILE = 'src/control/approval/scenario-contracts.ts';
const VALIDITY_OWNER = 'src/control/approval/approval-validity.ts';
const DIGEST_OWNER = 'src/control/approval/approval-digest.ts';
const POLICY_OWNER = 'src/control/approval/scenario-policy.ts';

/** owner と、owner にだけ定義する名前。 */
const OWNERSHIPS: readonly { readonly owner: string; readonly names: readonly string[] }[] = [
  { owner: VALIDITY_OWNER, names: ['evaluateApprovalValidity', 'approvalExpiresAtOf', 'APPROVAL_INVALIDITY_REASONS'] },
  // T28e: 承認の digest の項目の一覧と項目ごとの値と差分も、digest の owner にだけ定義する（差分の項目と並びを書き写さない）。
  {
    owner: DIGEST_OWNER,
    names: [
      'computeApprovalDigest',
      'approvalBoundFactsOf',
      'APPROVAL_DIGEST_FORMAT',
      'APPROVAL_DIGEST_ITEMS',
      'approvalDigestEntriesOf',
      'approvalDigestDifferencesOf',
    ],
  },
  { owner: POLICY_OWNER, names: ['validateScenarioDraft', 'SCENARIO_DRAFT_REJECTION_REASONS'] },
];

/** (b) 承認の期限の 1 日の長さの名前と、参照してよいファイル。 */
const TTL_DAY_MS_NAME = 'APPROVAL_TTL_DAY_MS';
const TTL_DAY_MS_FILES: ReadonlySet<string> = new Set([CONTRACTS_FILE, VALIDITY_OWNER]);
/** (b) 掛け算に使ってはいけない期限の日数の名前（owner の外）。 */
const TTL_DAYS_NAMES: readonly string[] = ['APPROVAL_TTL_DAYS', 'approvalTtlDays'];

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数（近似）
// ---------------------------------------------------------------------------------------------------------------

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** (a) `bare` の中の `name` の定義の数（`function name`、`const`・`let`・`var` の `name =`・`name:`、`class name`）。 */
const countDefinitions = (bare: string, name: string): number => {
  const escaped = escapeRegExp(name);
  const pattern = new RegExp(
    `(?<![\\w$])(?:function\\s*\\*?\\s*${escaped}(?![\\w$])|(?:const|let|var)\\s+${escaped}\\s*[=:]|class\\s+${escaped}(?![\\w$]))`,
    'gu',
  );
  return [...bare.matchAll(pattern)].length;
};

/** (a) owner の外で owner の名前を定義している箇所（`パス: 名前`）。 */
const copiedDefinitionsOf = (files: readonly (Pick<SourceFile, 'path'> & ScannedSource)[]): readonly string[] =>
  files.flatMap((file) => OWNERSHIPS
    .filter((ownership) => ownership.owner !== file.path)
    .flatMap((ownership) => ownership.names)
    .filter((name) => countDefinitions(file.bare, name) > 0)
    .map((name) => `${file.path}: ${name}`));

/** (b) 期限の判定の書き写し（`パス: 名前`）: 1 日の長さの参照（許すファイルの外）と、期限の日数の掛け算（owner の外）。 */
const copiedExpiryJudgementsOf = (files: readonly (Pick<SourceFile, 'path'> & ScannedSource)[]): readonly string[] =>
  files.flatMap((file) => [
    ...(TTL_DAY_MS_FILES.has(file.path) || countIdentifier(file.bare, TTL_DAY_MS_NAME) === 0 ? [] : [`${file.path}: ${TTL_DAY_MS_NAME}`]),
    ...(file.path === VALIDITY_OWNER ? [] : TTL_DAYS_NAMES.filter((name) => {
      const escaped = escapeRegExp(name);
      return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])\\s*\\*|\\*\\s*(?:[\\w$]+\\s*\\.\\s*)*${escaped}(?![\\w$])`, 'u').test(file.bare);
    }).map((name) => `${file.path}: ${name} *`)),
  ]);

/** (c) `src/control/approval/` から参照しないディレクトリ。 */
const FORBIDDEN_DIRECTORIES: readonly string[] = ['src/browser/', 'src/worker/', 'src/orchestration/'];

const isForbiddenPath = (path: string): boolean => FORBIDDEN_DIRECTORIES.some((directory) => `${path}/`.startsWith(directory));

/** (d) 画面向けの公開し直しのファイル（T28e）。 */
const APPROVAL_VIEW_FILE = 'src/control/approval-view.ts';
/** (d) 画面向けの公開し直しが公開しない名前（期限の 1 日の長さ、実行の許可と予約、入力の規則の参照を付ける口）。 */
const APPROVAL_VIEW_WITHHELD_NAMES: readonly string[] = [
  TTL_DAY_MS_NAME,
  // T30g: `issueExecutionGrant` は公開する（呼べる画面のコードは (e) で 1 ファイルに限る）。
  'consumeExecutionGrant',
  'assertGrantStillValid',
  'settleWriteReservation',
  'readExecutionGrant',
  'attachInputRuleReference',
];

/** (d) 公開し直しのファイルの違反（`名前` か `<指定子>`）: 公開しない名前の参照、`src/control/approval/` の外からの公開し直し、定義の文。 */
const approvalViewViolationsOf = (path: string, source: ScannedSource): readonly string[] => [
  ...APPROVAL_VIEW_WITHHELD_NAMES.filter((name) => countIdentifier(source.bare, name) > 0),
  ...findModuleSpecifiers(source.code)
    .filter((specifier) => {
      const resolved = resolveRelativeSpecifier(path, specifier);
      return resolved === null || !`${resolved}/`.startsWith(APPROVAL_DIRECTORY);
    })
    .map((specifier) => `<${specifier}>`),
  ...(/(?<![\w$])(?:function|class|let|var)\s|(?<![\w$])const\s+[\w$]+\s*[=:]/u.test(source.bare) ? ['<definition>'] : []),
];

/** (e) 実行の許可の発行を参照してよい、画面のコードのファイル（書き込みの開始の Server Function。T30g）。 */
const WRITE_START_FUNCTIONS_FILE = 'apps/local-ui/src/server/write-job-functions.ts';
/** (e) 実行の許可の発行の参照の数（コメントと文字列の中身を除いた本文の識別子）。 */
const grantIssueReferencesOf = (source: ScannedSource): number => countIdentifier(source.bare, 'issueExecutionGrant');

/** (c) `text`（指定子か相対パスのリテラル）が禁止の対象を指すか。 */
const pointsToForbidden = (fromPath: string, text: string): boolean => {
  const resolved = resolveRelativeSpecifier(fromPath, text);
  if (resolved !== null) {
    return isForbiddenPath(resolved);
  }
  return PLAYWRIGHT_PACKAGE_PATTERN.test(text) || /(?:^|\/)src\/(?:browser|worker|orchestration)(?:\/|$)/u.test(text);
};

/** (c) 禁止の対象を指す参照（指定子のすべて（型だけの import を含む）と、相対パス・Playwright の名前の文字列リテラル）。 */
const findForbiddenReferences = (path: string, source: ScannedSource): readonly string[] =>
  moduleReferenceCandidatesOf(source, [PLAYWRIGHT_PACKAGE_PATTERN]).filter((text) => pointsToForbidden(path, text));

/** (c) 実行時の import をたどった先の、禁止の対象（`<始まり> -> … -> <先>`）。 */
const findTransitiveForbidden = (files: ReadonlyMap<string, ScannedSource>, starts: readonly string[]): readonly string[] =>
  findTransitiveForbiddenReferences(files, starts, isForbiddenPath, (specifier) => PLAYWRIGHT_PACKAGE_PATTERN.test(specifier));

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数の単体テスト（違反の例で RED）
// ---------------------------------------------------------------------------------------------------------------

describe('approval SSOT detectors (T28a)', () => {
  it('(a) reports a copied definition of the judgement outside the owner, and not the uses', () => {
    const copy = { path: 'src/control/approval-view.ts', ...scanSource('const evaluateApprovalValidity = (input) => ({ approved: true });') };
    const digest = { path: 'src/control/job/x.ts', ...scanSource('export function computeApprovalDigest(scenario) { return ""; }') };
    const owner = { path: VALIDITY_OWNER, ...scanSource('export const evaluateApprovalValidity = (input) => input;') };
    const user = { path: 'src/control/job/y.ts', ...scanSource([
      "import { evaluateApprovalValidity } from '../approval/approval-validity.js';",
      'const validity = evaluateApprovalValidity(input);',
      '// const approvalExpiresAtOf = () => 0;',
      "const text = 'const APPROVAL_INVALIDITY_REASONS = []';",
    ].join('\n')) };
    expect(copiedDefinitionsOf([copy, digest, owner, user])).toEqual([
      'src/control/approval-view.ts: evaluateApprovalValidity',
      'src/control/job/x.ts: computeApprovalDigest',
    ]);
  });

  it('(b) reports the day length outside the owner and a multiplication of the TTL days outside the owner', () => {
    const files = [
      { path: 'src/control/job/grant.ts', ...scanSource("import { APPROVAL_TTL_DAY_MS } from '../approval/scenario-contracts.js';") },
      { path: 'src/control/job/expiry.ts', ...scanSource('const expiresAt = approvedAt + scenario.approvalTtlDays * dayMs;') },
      { path: 'src/control/job/expiry2.ts', ...scanSource('const span = DAY * APPROVAL_TTL_DAYS;') },
      { path: 'src/control/job/expiry3.ts', ...scanSource('const span = DAY * scenario.limits.approvalTtlDays;') },
      { path: VALIDITY_OWNER, ...scanSource('const span = ttlDays * APPROVAL_TTL_DAY_MS; const d = scenario.approvalTtlDays * 1;') },
      { path: CONTRACTS_FILE, ...scanSource('export const APPROVAL_TTL_DAY_MS = 1;') },
      { path: 'src/control/approval-view.ts', ...scanSource([
        'const days = scenario.approvalTtlDays;',
        'const label = `${APPROVAL_TTL_DAYS} days`;',
        'const ok = draft.approvalTtlDays <= APPROVAL_TTL_DAYS;',
        '// const span = APPROVAL_TTL_DAYS * APPROVAL_TTL_DAY_MS;',
      ].join('\n')) },
    ];
    expect(copiedExpiryJudgementsOf(files)).toEqual([
      'src/control/job/grant.ts: APPROVAL_TTL_DAY_MS',
      'src/control/job/expiry.ts: approvalTtlDays *',
      'src/control/job/expiry2.ts: APPROVAL_TTL_DAYS *',
      'src/control/job/expiry3.ts: approvalTtlDays *',
    ]);
  });

  it('(c) detects references to the browser, the worker, the orchestration and Playwright from src/control/approval/', () => {
    const path = 'src/control/approval/x.ts';
    for (const line of [
      "import { chromium } from 'playwright';",
      "import type { Page } from 'playwright-core';",
      "import { AxeBuilder } from '@axe-core/playwright';",
      "import { createContext } from '../../browser/context-factory.js';",
      "import type { WorkerRun } from '../../worker/read-check-run.js';",
      "export { runAudit } from '../../orchestration/run-coordinator.js';",
      "const worker = await import('../../worker/audit-worker.js');",
      "const directory = '../../worker/';",
    ]) {
      expect(findForbiddenReferences(path, scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "import { createSha256Fingerprint } from '../../core/ids.js';",
      "import { WORKER_JOB_ID_PATTERN } from '../worker-protocol.js';",
      "import type { DiscoveryCandidate } from '../../discovery/candidate-contracts.js';",
      "// import { chromium } from 'playwright';",
      "const note = 'a worker of the browser';",
    ]) {
      expect(findForbiddenReferences(path, scanSource(line)), line).toHaveLength(0);
    }
  });

  it('(d) reports what the screen re-export must not publish, a re-export from outside src/control/approval/ and a definition (T28e)', () => {
    const withheld = scanSource([
      "export { APPROVAL_TTL_DAYS, APPROVAL_TTL_DAY_MS } from './approval/scenario-contracts.js';",
      "export { consumeExecutionGrant, readScenario } from './approval/scenario-store.js';",
      "export { attachInputRuleReference } from './approval/scenario-store.js';",
      "export { classifyCandidate } from '../discovery/classify.js';",
      'export const usesScenarios = (mode) => mode === 1;',
    ].join('\n'));
    expect(approvalViewViolationsOf(APPROVAL_VIEW_FILE, withheld)).toEqual([
      'APPROVAL_TTL_DAY_MS',
      'consumeExecutionGrant',
      'attachInputRuleReference',
      '<../discovery/classify.js>',
      '<definition>',
    ]);
    const clean = scanSource([
      '// issueExecutionGrant は公開し直さない。',
      "export { APPROVAL_TTL_DAYS, SCENARIO_KINDS } from './approval/scenario-contracts.js';",
      "export { approveScenario, readScenarioApprovalStatus } from './approval/scenario-store.js';",
      "export type { ScenarioView } from './approval/scenario-facts.js';",
      // T30g: 発行は公開してよい。
      "export { issueExecutionGrant } from './approval/scenario-store.js';",
    ].join('\n'));
    expect(approvalViewViolationsOf(APPROVAL_VIEW_FILE, clean)).toEqual([]);
  });

  it('(e) counts the references to the grant issue in the screen code, and ignores comments and strings (T30g)', () => {
    expect(grantIssueReferencesOf(scanSource("import { issueExecutionGrant } from '../../../../src/control/approval-view.js';"))).toBe(1);
    expect(grantIssueReferencesOf(scanSource('const result = issueExecutionGrant(database, input);'))).toBe(1);
    expect(grantIssueReferencesOf(scanSource("// issueExecutionGrant(database, input);\nconst name = 'issueExecutionGrant';"))).toBe(0);
    expect(grantIssueReferencesOf(scanSource('issueExecutionGrants(); myissueExecutionGrant();'))).toBe(0);
  });

  it('(c) detects the same references from src/control/actions/ (T30a fix round 1)', () => {
    const path = 'src/control/actions/x.ts';
    for (const line of [
      "import type { Page } from 'playwright';",
      "import { WriteFormSubmitter } from '../../browser/write-form-submitter.js';",
      "import type { WriteStageReport } from '../../worker/write-stage.js';",
      "import { runAudit } from '../../orchestration/run-coordinator.js';",
    ]) {
      expect(findForbiddenReferences(path, scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "import type { ReadCheckResult } from '../../discovery/read-check-contracts.js';",
      "import { MAX_RECORD_ID_LENGTH } from '../approval/scenario-contracts.js';",
    ]) {
      expect(findForbiddenReferences(path, scanSource(line)), line).toHaveLength(0);
    }
    const files = new Map<string, ScannedSource>([
      ['src/control/actions/a.ts', scanSource("import { b } from '../b.js';")],
      ['src/control/b.ts', scanSource("import { c } from '../browser/c.js';")],
    ]);
    expect(findTransitiveForbidden(files, ['src/control/actions/a.ts'])).toEqual(['src/control/actions/a.ts -> src/control/b.ts -> src/browser/c.ts']);
  });

  it('(c) follows runtime imports transitively, and skips type-only imports', () => {
    const files = new Map<string, ScannedSource>([
      ['src/control/approval/a.ts', scanSource("import { b } from '../b.js';\nimport type { T } from '../../worker/t.js';")],
      ['src/control/b.ts', scanSource("import { c } from '../worker/c.js';")],
      ['src/control/approval/clean.ts', scanSource("import { d } from '../../core/d.js';")],
      ['src/core/d.ts', scanSource("import { readFileSync } from 'node:fs';")],
    ]);
    expect(findTransitiveForbidden(files, ['src/control/approval/a.ts'])).toEqual(['src/control/approval/a.ts -> src/control/b.ts -> src/worker/c.ts']);
    expect(findTransitiveForbidden(files, ['src/control/approval/clean.ts'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------------------------

const fileOf = (path: string): SourceFile => {
  const file = SOURCE_FILES.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`missing source file: ${path}`);
  }
  return file;
};

const APPROVAL_FILES = SOURCE_FILES.filter((file) => file.path.startsWith(APPROVAL_DIRECTORY));
const ACTIONS_FILES = SOURCE_FILES.filter((file) => file.path.startsWith(ACTIONS_DIRECTORY));

describe('approval SSOT and boundary (Task 28 design 5, 6)', () => {
  it('reads the approval files once', () => {
    expect(APPROVAL_FILES.map((file) => file.path)).toEqual(expect.arrayContaining([CONTRACTS_FILE, VALIDITY_OWNER, DIGEST_OWNER, POLICY_OWNER]));
  });

  it.each(OWNERSHIPS.map((ownership) => [ownership.owner, ownership] as const))('(a) defines the judgements of %s once, only in the owner', (_owner, ownership) => {
    const owner = fileOf(ownership.owner);
    expect(ownership.names.map((name) => [name, countDefinitions(owner.bare, name)])).toEqual(ownership.names.map((name) => [name, 1]));
  });

  it('(a) defines no judgement of an owner outside the owner', () => {
    expect(copiedDefinitionsOf(SOURCE_FILES)).toEqual([]);
  });

  it('(a) computes the approval digest with createSha256Fingerprint (not a copy of SHA-256)', () => {
    const digest = fileOf(DIGEST_OWNER);
    expect(countIdentifier(digest.bare, 'createSha256Fingerprint')).toBeGreaterThanOrEqual(2);
    expect(countIdentifier(digest.bare, 'createHash')).toBe(0);
  });

  it('(b) keeps the expiry computation in the owner', () => {
    expect(countIdentifier(fileOf(VALIDITY_OWNER).bare, TTL_DAY_MS_NAME)).toBeGreaterThanOrEqual(2);
    expect(copiedExpiryJudgementsOf(SOURCE_FILES)).toEqual([]);
  });

  it('(c) src/control/approval/ does not refer to the browser, the worker, the orchestration or Playwright', () => {
    expect(APPROVAL_FILES.flatMap((file) => findForbiddenReferences(file.path, file).map((text) => `${file.path}: ${text}`))).toEqual([]);
  });

  it('(c) nothing that src/control/approval/ loads at run time reaches them', () => {
    const files = new Map<string, ScannedSource>(SOURCE_FILES.map((file) => [file.path, file]));
    expect(findTransitiveForbidden(files, APPROVAL_FILES.map((file) => file.path))).toEqual([]);
  });

  it('(c) src/control/actions/ does not refer to the browser, the worker, the orchestration or Playwright, even at run time (T30a fix round 1)', () => {
    expect(ACTIONS_FILES.map((file) => file.path)).toEqual(expect.arrayContaining([ACTIONS_CONTRACTS_FILE, ACTIONS_OUTCOME_FILE]));
    expect(ACTIONS_FILES.flatMap((file) => findForbiddenReferences(file.path, file).map((text) => `${file.path}: ${text}`))).toEqual([]);
    const files = new Map<string, ScannedSource>(SOURCE_FILES.map((file) => [file.path, file]));
    expect(findTransitiveForbidden(files, ACTIONS_FILES.map((file) => file.path))).toEqual([]);
  });

  it('(e) only the write start Server Function file of the screen refers to the grant issue (T30g)', () => {
    const uiFiles = loadLocalUiSourceFiles();
    const owner = uiFiles.find((file) => file.path === WRITE_START_FUNCTIONS_FILE);
    expect(owner === undefined ? 0 : grantIssueReferencesOf(owner)).toBeGreaterThan(0);
    expect(uiFiles.filter((file) => file.path !== WRITE_START_FUNCTIONS_FILE && grantIssueReferencesOf(file) > 0).map((file) => file.path)).toEqual([]);
  });

  it('(d) the screen re-export publishes only names of src/control/approval/, without the TTL day length and the execution paths (T28e)', () => {
    const view = fileOf(APPROVAL_VIEW_FILE);
    // 読み方が実際のファイルで働いていることの確かめ（公開し直す名前が見えている）。
    expect(countIdentifier(view.bare, 'approveScenario')).toBeGreaterThan(0);
    expect(approvalViewViolationsOf(view.path, view)).toEqual([]);
  });
});

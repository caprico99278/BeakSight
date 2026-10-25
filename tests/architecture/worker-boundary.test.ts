/**
 * 監査のワーカー（`src/worker/`）の境界の Architecture Gate（Task 24 の設計書 4.3 の「Gate の例外」。T24d）。
 * - (j) `src/worker/` が参照してよい `src/control/` のファイルは、`worker-boundary-policy.ts` の `WORKER_ALLOWED_CONTROL_FILES`（IPC の契約、
 *   Control のスキーマの検証、契約の型、パスの確かめ）だけ（型だけの import、`export … from`、動的 import、`require`、相対パスの文字列
 *   リテラルを含む。相対でない `src/control/...` の指定子は許さない）。
 * - (k) `src/worker/` が実行時に読み込むものを（`src/` の中の相対の import を）たどった先にも、`src/control/store/`、`src/control/job/`、
 *   `node:sqlite` が現れない（型だけの import はたどらない。実行時に消えるため。`control-boundary.test.ts` と同じ扱い）。
 * - (l) `src/control/` は `src/worker/` を参照しない（ワーカーは、ファイルのパスの文字列で子のプロセスとして起動するだけ。ビルドの出力
 *   `dist/worker/...` の文字列は参照に数えない）。
 * - (m) 画面のコード（`apps/local-ui/` の中の `tests/` 以外）は、`src/worker/` を参照しない。実行時の import をたどった先にも現れない。
 * - 判定は、`fs`、正規表現、文字列の走査だけで行う（`source-scan.ts` の走査を共用する。AST・子 process・`dist/` を使わない）。近似の検査で
 *   ある（指定子を実行時に組み立てる import は、相対パスの文字列リテラルの検出で補う）。ファイル全体を 1 秒以内に終える。
 * - CCX-9（台帳の CC-054、CC-056）: 指定子の取り出し（`findModuleSpecifiers`）、import のたどり（`findImportChains`）、相対の指定子の
 *   解決（`resolveRelativeSpecifier`）は、`source-scan.ts` の共通の部品を使う（指定子を取り出す正規表現は、このファイルに書かない）。
 */
import { describe, expect, it } from 'vitest';
import {
  LOCAL_UI_APP_DIRECTORY,
  findImportChains,
  isPathUnderAny,
  loadLocalUiAppFiles,
  loadSourceFiles,
  modulePattern,
  pathReferenceCandidatesOf,
  refersUnderAny,
  resolveRelativeSpecifier,
  scanSource,
  type ScannedSource,
} from './source-scan.js';
import { WORKER_ALLOWED_CONTROL_FILES, WORKER_DIRECTORY, isAllowedWorkerControlReference } from './worker-boundary-policy.js';

const CONTROL_DIRECTORY = 'src/control/';
/** (k): ワーカーから、間接にも届いてはならないもの。 */
const WORKER_FORBIDDEN_DIRECTORIES: readonly string[] = ['src/control/store/', 'src/control/job/'];
/** `node:sqlite`（`source-scan.ts` の `modulePattern`。`node:` のない形、下位のパス、文字列の中の `node:sqlite` も当てる。PRE42-CC 組 G）。 */
const NODE_SQLITE_PATTERN = modulePattern(['sqlite']);
const APP_TESTS_DIRECTORY = `${LOCAL_UI_APP_DIRECTORY}tests/`;

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数（近似）
// ---------------------------------------------------------------------------------------------------------------

/** 参照の候補（指定子のすべてと、相対パス・`src/` のパス・`node:sqlite` の文字列リテラル。同じ文字列は 1 つにまとめる）。 */
const referencesOf = (source: ScannedSource): readonly string[] => pathReferenceCandidatesOf(source, [NODE_SQLITE_PATTERN]);

/**
 * `text`（指定子かリテラル）が、`directory`（`src/control/` など）の中を指すか。相対でない参照は、文字列の中の `src/` からのパス（区切りの `\` を
 * 含む）で判定する（`source-scan.ts` の `refersUnderAny`。PRE42-CC 組 G）。
 */
const pointsInto = (fromPath: string, text: string, directory: string): boolean => refersUnderAny(fromPath, text, [directory]);

/** (j): `src/worker/` のファイルの、許さない `src/control/` への参照。 */
const findWorkerControlViolations = (path: string, source: ScannedSource): readonly string[] =>
  referencesOf(source).filter((text) => pointsInto(path, text, CONTROL_DIRECTORY) && !isAllowedWorkerControlReference(path, text));

/** (l)(m): `src/worker/` への参照。 */
const findWorkerReferences = (path: string, source: ScannedSource): readonly string[] =>
  referencesOf(source).filter((text) => pointsInto(path, text, WORKER_DIRECTORY));

/**
 * (k)(m) 間接: `starts` から、実行時に読み込む相対の import を、`source-scan.ts` の `findImportChains`（CCX-9）でたどり、`forbidden` の
 * フォルダか（`sqlite` が真なら）`node:sqlite` に届いたら、`<始まり> -> … -> <先>` の形で返す。`files` にないファイル（`node_modules` の
 * パッケージなど）はたどらない。
 */
const findTransitiveViolations = (
  files: ReadonlyMap<string, ScannedSource>,
  starts: readonly string[],
  forbidden: readonly string[],
  sqlite: boolean,
): readonly string[] => findImportChains(files, starts, ({ specifier, resolved }) => {
  if (sqlite && NODE_SQLITE_PATTERN.test(specifier)) {
    return specifier;
  }
  return resolved !== null && isPathUnderAny(resolved, forbidden) ? resolved : undefined;
});

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数の単体テスト（違反の例と、違反でない例）
// ---------------------------------------------------------------------------------------------------------------

describe('Worker boundary detectors', () => {
  it('(j) detects references from src/worker/ to src/control/ files outside the allowed list', () => {
    const path = 'src/worker/audit-worker.ts';
    for (const line of [
      "import { openControlDatabase } from '../control/store/control-database.js';",
      "import type { ControlDatabase } from '../control/store/control-database.js';",
      "import { startAuditJob } from '../control/job/job-manager.js';",
      "export * from '../control/job/job-manager.js';",
      "const m = await import('../control/store/sqlite-module.js');",
      'const m = await import(`../control/job/${name}.js`);',
      "const m = require('../control/setup-local.js');",
      "const directory = '../control/store/';",
      "import { validateWorkerToParentMessage } from 'beaksight/src/control/worker-protocol.js';",
      "import { checkControlEnvironment } from '../control/environment/control-environment.js';",
      // T26d-1: 資格情報は、ファイルの部品を通してだけ読む（暗号化の部品を直接は使わない）。上限の判定（ジョブ）にも届かない。
      "import { createDpapiCredentialProtector } from '../control/credentials/dpapi-protector.js';",
      "import { retryAfterUntilOf } from '../control/job/auto-login-limits.js';",
    ]) {
      expect(findWorkerControlViolations(path, scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "import { validateWorkerToParentMessage } from '../control/worker-protocol.js';",
      "import type { WorkerToParentMessage } from '../control/worker-protocol.js';",
      "import { validateControlDocument } from '../control/control-schema-validator.js';",
      "import type { SiteProfile } from '../control/contracts.js';",
      "import { isAcceptedTargetConfigPath } from '../control/profile-policy.js';",
      // T26d-1: 自動ログインの結果の一覧と時間、資格情報のファイルの読み出し。
      "import { loginOriginOf } from '../control/auth/automated-login-results.js';",
      "import { retryAfterUntilDateOf } from '../control/auth/automated-login-timing.js';",
      "import type { CredentialStore } from '../control/credentials/credential-store.js';",
      "import { executeAuditRun } from '../cli/audit-run.js';",
      "// import { openControlDatabase } from '../control/store/control-database.js';",
      "const label = 'control/store';",
    ]) {
      expect(findWorkerControlViolations(path, scanSource(line)), line).toHaveLength(0);
    }
  });

  it('(l)(m) detects references to src/worker/, and ignores the path of the built worker', () => {
    for (const [path, line] of [
      ['src/control/job/job-manager.ts', "import { startAuditWorker } from '../../worker/audit-worker-session.js';"],
      ['src/control/worker-protocol.ts', "import type { AuditWorker } from '../worker/audit-worker-session.js';"],
      ['src/control/job/job-manager.ts', "const m = await import('../../worker/audit-worker.js');"],
      ['src/control/job/job-manager.ts', "const entry = '../../worker/audit-worker.ts';"],
      ['apps/local-ui/src/server/jobs.ts', "import { startAuditWorker } from '../../../../src/worker/audit-worker-session.js';"],
      ['apps/local-ui/src/server/jobs.ts', "const m = await import('beaksight/src/worker/audit-worker.js');"],
    ] as const) {
      expect(findWorkerReferences(path, scanSource(line)), `${path}: ${line}`).toHaveLength(1);
    }
    for (const [path, line] of [
      ['src/control/job/job-manager.ts', "const WORKER_ENTRY = ['dist', 'worker', 'audit-worker.js'];"],
      ['src/control/job/job-manager.ts', "const entry = 'dist/worker/audit-worker.js';"],
      ['src/control/job/job-manager.ts', "import { validateWorkerToParentMessage } from '../worker-protocol.js';"],
      ['apps/local-ui/src/server/jobs.ts', "import { startAuditJob } from '../../../../src/control/job/job-manager.js';"],
      ['apps/local-ui/src/server/jobs.ts', "// import { startAuditWorker } from '../../../../src/worker/audit-worker-session.js';"],
    ] as const) {
      expect(findWorkerReferences(path, scanSource(line)), `${path}: ${line}`).toHaveLength(0);
    }
  });

  it('(k)(m) follows runtime imports transitively, and skips type-only imports', () => {
    const files = new Map<string, ScannedSource>([
      ['src/worker/a.ts', scanSource("import { b } from '../core/b.js';\nimport type { T } from '../control/store/t.js';")],
      ['src/core/b.ts', scanSource("import { c } from '../control/job/c.js';")],
      ['src/worker/clean.ts', scanSource("import { p } from '../control/worker-protocol.js';")],
      ['src/control/worker-protocol.ts', scanSource("import { v } from './control-schema-validator.js';")],
      ['src/control/control-schema-validator.ts', scanSource("import { readFileSync } from 'node:fs';")],
      ['src/worker/sqlite.ts', scanSource("import { e } from '../core/e.js';")],
      ['src/core/e.ts', scanSource("import { DatabaseSync } from 'node:sqlite';")],
      ['apps/local-ui/src/server/x.ts', scanSource("import { y } from '../../../../src/control/y.js';")],
      ['src/control/y.ts', scanSource("import { w } from '../worker/audit-worker-session.js';")],
    ]);
    expect(findTransitiveViolations(files, ['src/worker/a.ts'], WORKER_FORBIDDEN_DIRECTORIES, true)).toEqual([
      'src/worker/a.ts -> src/core/b.ts -> src/control/job/c.js',
    ]);
    expect(findTransitiveViolations(files, ['src/worker/clean.ts'], WORKER_FORBIDDEN_DIRECTORIES, true)).toEqual([]);
    expect(findTransitiveViolations(files, ['src/worker/sqlite.ts'], WORKER_FORBIDDEN_DIRECTORIES, true)).toEqual([
      'src/worker/sqlite.ts -> src/core/e.ts -> node:sqlite',
    ]);
    expect(findTransitiveViolations(files, ['apps/local-ui/src/server/x.ts'], [WORKER_DIRECTORY], false)).toEqual([
      'apps/local-ui/src/server/x.ts -> src/control/y.ts -> src/worker/audit-worker-session.js',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------------------------

const SOURCE_FILES = loadSourceFiles();
const WORKER_FILES = SOURCE_FILES.filter((file) => file.path.startsWith(WORKER_DIRECTORY));
const CONTROL_FILES = SOURCE_FILES.filter((file) => file.path.startsWith(CONTROL_DIRECTORY));
/** `apps/local-ui/` の TypeScript（`dist/` と `node_modules/` を除く。`source-scan.ts` の `loadLocalUiAppFiles`）のうち、`tests/` の外。 */
const APP_CODE_FILES = loadLocalUiAppFiles().filter((file) => !file.path.startsWith(APP_TESTS_DIRECTORY));

describe('Worker boundary (Task 24 design 4.3)', () => {
  it('reads src/worker/, src/control/ and apps/local-ui/ once, and the worker uses the IPC contract', () => {
    expect(WORKER_FILES.map((file) => file.path)).toEqual(expect.arrayContaining(['src/worker/audit-worker.ts']));
    expect(CONTROL_FILES.map((file) => file.path)).toEqual(expect.arrayContaining(['src/control/worker-protocol.ts']));
    expect(APP_CODE_FILES.length).toBeGreaterThan(0);
    // 許す一覧のファイルが、実際にある（一覧が古くなっていない）。
    for (const allowed of WORKER_ALLOWED_CONTROL_FILES) {
      expect(SOURCE_FILES.some((file) => file.path === `${allowed}.ts`), allowed).toBe(true);
    }
    // 検出の関数が、実際のファイルの import を解決できていることの確かめ（ワーカーが IPC の契約を参照している）。
    const resolved = WORKER_FILES.flatMap((file) => referencesOf(file).map((text) => resolveRelativeSpecifier(file.path, text)));
    expect(resolved).toContain('src/control/worker-protocol.js');
  });

  it('(j) src/worker/ refers only to the allowed files of src/control/', () => {
    const violations = WORKER_FILES.flatMap((file) => findWorkerControlViolations(file.path, file).map((text) => `${file.path}: ${text}`));
    expect(violations).toEqual([]);
  });

  it('(k) nothing src/worker/ loads at run time reaches src/control/store/, src/control/job/ or node:sqlite', () => {
    const files = new Map<string, ScannedSource>(SOURCE_FILES.map((file) => [file.path, file]));
    expect(findTransitiveViolations(files, WORKER_FILES.map((file) => file.path), WORKER_FORBIDDEN_DIRECTORIES, true)).toEqual([]);
    // たどり方が実際のファイルで働いていることの確かめ（ワーカーから、監査の中核を通って src/orchestration/ に届く）。
    const reached = findTransitiveViolations(files, ['src/worker/audit-worker.ts'], ['src/orchestration/'], false);
    expect(reached.some((chain) => chain.includes(' -> src/cli/audit-run.ts -> '))).toBe(true);
  });

  it('(l) src/control/ never refers to src/worker/', () => {
    const violations = CONTROL_FILES.flatMap((file) => findWorkerReferences(file.path, file).map((text) => `${file.path}: ${text}`));
    expect(violations).toEqual([]);
  });

  it('(m) the UI code never refers to src/worker/, and nothing it loads at run time reaches src/worker/', () => {
    const violations = APP_CODE_FILES.flatMap((file) => findWorkerReferences(file.path, file).map((text) => `${file.path}: ${text}`));
    expect(violations).toEqual([]);
    const files = new Map<string, ScannedSource>([
      ...SOURCE_FILES.map((file) => [file.path, file] as const),
      ...APP_CODE_FILES.map((file) => [file.path, file] as const),
    ]);
    expect(findTransitiveViolations(files, APP_CODE_FILES.map((file) => file.path), [WORKER_DIRECTORY], false)).toEqual([]);
  });
});

/**
 * Run の起動と、Run の結果の確かめ方の補助（Gate と統合テストが共通に使う。CC-029 で1か所にまとめた）。
 *
 * - Run の起動: 本物の headless Chromium を起動する launcher、Run Coordinator での Run、CLI（同じプロセスの中の `runCli`）での Run。
 * - CLI の出力の受け取りと、書き出した artifact（ZIP は展開した中身）を読む補助。
 * - 確かめ方: Finding の取り出し、スキーマの確認、GET と HEAD だけが届いたことの確認。検証の内容（期待値）は、各テストに置く。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { unzipSync } from 'fflate';
import type { Browser } from 'playwright';
import { expect } from 'vitest';
import type { FixtureServerCounters } from '../../fixtures/server.js';
import { runCli } from '../../src/cli/main.js';
import type { CliOutput } from '../../src/cli/output-stream.js';
import type { AuditConfig } from '../../src/config/types.js';
import { RUN_ARTIFACT_FILE_NAMES } from '../../src/core/artifact-layout.js';
import type { AuditRunResult, Finding, PageAuditResult, RunSummary } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { BrowserLauncher } from '../../src/orchestration/preflight.js';
import { RunCoordinator, type RunCoordinatorDependencies } from '../../src/orchestration/run-coordinator.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { launchHeadlessChromium } from './chromium.js';
import { createTestConfig, type TestConfigOverrides } from './test-config.js';

// ---------------------------------------------------------------------------------------------------------------
// Run の設定
// ---------------------------------------------------------------------------------------------------------------

/** 実行時間を抑える Run の設定（幅の走査とスクリーンショットをしない。Interaction の段階は既定のまま有効）。 */
export const FAST_RUN_OVERRIDES: TestConfigOverrides = Object.freeze({
  viewports: Object.freeze({ stressWidths: [] }),
  audit: Object.freeze({ screenshots: false }),
});

/** `FAST_RUN_OVERRIDES` に、`overrides` をセクションの項目ごとに重ねる（`overrides` の項目が優先する）。 */
export function fastRunOverrides(overrides: TestConfigOverrides = {}): TestConfigOverrides {
  const merged: Record<string, unknown> = { ...FAST_RUN_OVERRIDES, ...overrides };
  for (const section of Object.keys(FAST_RUN_OVERRIDES) as (keyof TestConfigOverrides)[]) {
    merged[section] = { ...FAST_RUN_OVERRIDES[section], ...overrides[section] };
  }
  return merged as TestConfigOverrides;
}

/** `origin` の `startPath` から始める、実行時間を抑えた Run の設定（`createTestConfig` と `fastRunOverrides`）。 */
export function fastRunConfig(origin: string, startPath: string, overrides: TestConfigOverrides = {}): AuditConfig {
  return createTestConfig(origin, startPath, fastRunOverrides(overrides));
}

// ---------------------------------------------------------------------------------------------------------------
// Chromium の起動
// ---------------------------------------------------------------------------------------------------------------

/** `createRunLauncher` の結果。 */
export interface RunLauncher {
  /** Run Coordinator、CLI、PREFLIGHT に渡す、本物の headless Chromium を起動する関数（`createRunLauncher` の `wrap` で差し替える）。 */
  readonly launcher: BrowserLauncher;
  /** `wrap` で差し替える launcher を作る。起動した Browser と要求は、この `RunLauncher` の一覧に記録する。 */
  wrapped(wrap: (browser: Browser) => Browser): BrowserLauncher;
  /** 起動した本物の Browser（Proxy を返した場合も、元の Browser。起動の順）。 */
  readonly browsers: readonly Browser[];
  /** launcher が受けた起動の要求（`headless` の値。要求の順）。 */
  readonly calls: readonly { readonly headless: boolean }[];
  /** 残っている Browser を閉じる（後片付け）。閉じる前につながっていた Browser の数を返す。 */
  closeAll(): Promise<number>;
}

/**
 * 本物の Chromium を起動する launcher。Run Coordinator は、Run の終わりに Browser を閉じるので、Run ごとに新しく起動する。
 * 厳守事項: 要求された `headless` の値は記録するが、起動は、いつも headless で行う（`launchHeadlessChromium`）。
 * headed の扱いは、設定の注入（`browser.headed: true`）と、記録した要求で確かめる。
 */
export function createRunLauncher(wrap: (browser: Browser) => Browser = (browser) => browser): RunLauncher {
  const browsers: Browser[] = [];
  const calls: { readonly headless: boolean }[] = [];
  const wrapped = (wrapBrowser: (browser: Browser) => Browser): BrowserLauncher => async (options) => {
    calls.push({ headless: options.headless });
    const browser = await launchHeadlessChromium();
    browsers.push(browser);
    return wrapBrowser(browser);
  };
  return Object.freeze({
    launcher: wrapped(wrap),
    wrapped,
    browsers,
    calls,
    async closeAll(): Promise<number> {
      const connected = browsers.filter((browser) => browser.isConnected());
      await Promise.all(connected.map((browser) => browser.close().catch(() => undefined)));
      return connected.length;
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Run Coordinator での Run
// ---------------------------------------------------------------------------------------------------------------

/** `runWithCoordinator` の指定。 */
export interface CoordinatorRunOptions {
  readonly config: AuditConfig;
  readonly launchBrowser: BrowserLauncher;
  readonly outputDirectory: string;
  /** 省略すると、呼び出しごとに新しい `SafetyLedger`。 */
  readonly createSafetyLedger?: RunCoordinatorDependencies['createSafetyLedger'];
  /** 注入する期限（省略すると、製品の既定）。 */
  readonly deadlines?: RunCoordinatorDependencies['deadlines'];
}

/** Run Coordinator で Run を行う（時計は実際の時刻）。 */
export async function runWithCoordinator(options: CoordinatorRunOptions): Promise<AuditRunResult> {
  return await new RunCoordinator({
    config: options.config,
    launchBrowser: options.launchBrowser,
    createSafetyLedger: options.createSafetyLedger ?? (() => new SafetyLedger()),
    clock: () => new Date(),
    now: () => Date.now(),
    outputDirectory: options.outputDirectory,
    ...(options.deadlines === undefined ? {} : { deadlines: options.deadlines }),
  }).run();
}

// ---------------------------------------------------------------------------------------------------------------
// CLI での Run
// ---------------------------------------------------------------------------------------------------------------

/** CLI の出力を受け取る `CliOutput` と、受け取った文字列。 */
export function captureCliOutput(): { readonly output: CliOutput; readonly text: () => string } {
  const texts: string[] = [];
  return {
    output: {
      write: async (text) => {
        texts.push(text);
      },
    },
    text: () => texts.join(''),
  };
}

/**
 * CLI の設定のファイル（`--config`）の内容。`origin` だけを許可し、`${origin}${startPath}` から始め、幅の走査はしない。
 * `extra` は、最上位のセクションを置き換える（例: `{ audit: { screenshots: false } }`）。
 */
export function cliTargetConfig(
  targetId: string,
  origin: string,
  startPath: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    target: { id: targetId },
    site: { startUrl: `${origin}${startPath}`, allowedOrigins: [origin] },
    viewports: { stressWidths: [] },
    ...extra,
  };
}

/** `runCliInProcess` の指定。 */
export interface CliRunOptions {
  /** 設定のファイルと出力先を置く、作業のディレクトリ。 */
  readonly directory: string;
  /** 作業のディレクトリの中の名前（設定のファイルは `<name>.json`、出力先は `<name>-output`）。 */
  readonly name: string;
  /** 設定のファイルの内容（`cliTargetConfig`）。 */
  readonly config: Record<string, unknown>;
  readonly launchBrowser: BrowserLauncher;
}

/** `runCliInProcess` の結果。 */
export interface CliRunOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** 出力先にできた、ただ1つの Run のディレクトリ。 */
  readonly runDirectory: string;
  /** 書き出した run.json。 */
  readonly run: RunSummary;
}

/**
 * 設定のファイルを書き、同じプロセスの中で `runCli`（`run --config <ファイル> --output <出力先> --headless`）を実行する。
 * Browser の起動だけを差し替える。出力先には、Run のディレクトリが1つだけできることを確かめる。
 */
export async function runCliInProcess(options: CliRunOptions): Promise<CliRunOutcome> {
  const configPath = join(options.directory, `${options.name}.json`);
  const outputDirectory = join(options.directory, `${options.name}-output`);
  await writeFile(configPath, JSON.stringify(options.config), 'utf8');
  const stdout = captureCliOutput();
  const stderr = captureCliOutput();
  const code = await runCli(
    ['run', '--config', configPath, '--output', outputDirectory, '--headless'],
    { stdout: stdout.output, stderr: stderr.output },
    { run: { launchBrowser: options.launchBrowser, clock: () => new Date(), now: () => Date.now() } },
  );
  const entries = (await readdir(outputDirectory, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  expect(entries).toHaveLength(1);
  const runDirectory = join(outputDirectory, entries[0]?.name ?? '');
  const run = await readJson(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.run)) as RunSummary;
  return { code, stdout: stdout.text(), stderr: stderr.text(), runDirectory, run };
}

/** JSON のファイルを読む。 */
export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

/** Run のディレクトリの audit.json（ページの結果と、Run の Finding の一覧）を読む。 */
export async function readRunAudit(runDirectory: string): Promise<{
  readonly pages: readonly PageAuditResult[];
  readonly findings: readonly Finding[];
}> {
  return await readJson(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.audit)) as {
    readonly pages: readonly PageAuditResult[];
    readonly findings: readonly Finding[];
  };
}

/** 書き出した artifact の1つ（ZIP の中のファイルは `<ZIP の相対パス>!/<項目の名前>`）。 */
export interface ArtifactFileContent {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * Run のディレクトリの下のすべてのファイルを読む（相対パスの順）。`.zip` のファイルは、そのものに加えて、展開した各項目も返す。
 * リンクはたどらない（通常のファイルとディレクトリだけを読む）。
 */
export async function readRunArtifactFiles(runDirectory: string): Promise<readonly ArtifactFileContent[]> {
  const files: ArtifactFileContent[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const relativePath = relative(runDirectory, path).split('\\').join('/');
        const bytes = new Uint8Array(await readFile(path));
        files.push({ path: relativePath, bytes });
        if (entry.name.endsWith('.zip')) {
          for (const [name, content] of Object.entries(unzipSync(bytes))) {
            files.push({ path: `${relativePath}!/${name}`, bytes: content });
          }
        }
      }
    }
  };
  await visit(runDirectory);
  return files;
}

/** 書き出したページの結果（`pages/<pageId>/page.json`）の artifact か。 */
export const isPageJsonArtifact = (file: ArtifactFileContent): boolean => /^pages\/[^/]+\/page\.json$/u.test(file.path);

/** `files` のうち、ページの結果（`pages/<pageId>/page.json`）を読んだもの（`files` の順）。 */
export function writtenPageResults(files: readonly ArtifactFileContent[]): PageAuditResult[] {
  return files.filter(isPageJsonArtifact).map((file) => JSON.parse(Buffer.from(file.bytes).toString('utf8')) as PageAuditResult);
}

/** `files` のうち、`needles` のどれかを（UTF-8 のバイト列として）含むものを、`<パス>: <文字列>` の一覧で返す。 */
export function findTextOccurrences(files: readonly ArtifactFileContent[], needles: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (const file of files) {
    const buffer = Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
    for (const needle of needles) {
      if (buffer.includes(Buffer.from(needle, 'utf8'))) {
        found.push(`${file.path}: ${needle}`);
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------
// 確かめ方
// ---------------------------------------------------------------------------------------------------------------

/** Run の Finding の一覧のうち、`ruleId` のもの（一覧の順）。 */
export function findingsOf(result: { readonly findings: readonly Finding[] }, ruleId: string): Finding[] {
  return result.findings.filter((finding) => finding.ruleId === ruleId);
}

/** Run の要約、各ページの結果、各 Finding が、それぞれのスキーマに合う。 */
export async function expectSchemaValid(result: {
  readonly run: RunSummary;
  readonly pages: readonly PageAuditResult[];
  readonly findings: readonly Finding[];
}): Promise<void> {
  await expect(validateArtifact('run', result.run)).resolves.toEqual({ ok: true });
  for (const page of result.pages) {
    await expect(validateArtifact('page', page)).resolves.toEqual({ ok: true });
  }
  for (const finding of result.findings) {
    await expect(validateArtifact('finding', finding)).resolves.toEqual({ ok: true });
  }
}

/**
 * fixture のサーバに、GET と HEAD 以外のリクエスト（変更系のメソッド、OPTIONS、そのほかのメソッド、WebSocket の Upgrade、
 * ダウンロード）が1件も届いていない。`observations` を渡すと、記録したリクエストのメソッドが GET か HEAD だけであることも確かめる。
 */
export function expectOnlyReadRequests(
  counters: Readonly<FixtureServerCounters>,
  observations: readonly { readonly method: string }[] = [],
): void {
  expect({ ...counters, get: 0, head: 0 }).toEqual({
    get: 0,
    head: 0,
    post: 0,
    put: 0,
    patch: 0,
    delete: 0,
    options: 0,
    other: 0,
    webSocketUpgrade: 0,
    download: 0,
  });
  expect(observations.every(({ method }) => method === 'GET' || method === 'HEAD')).toBe(true);
}

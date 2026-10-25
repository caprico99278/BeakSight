/**
 * CLI と画面のジョブの比べの結合テスト（Task 24 の設計書 7 章「CLI と画面の比べ」、10 章 G24。T24g）。
 * - 同じ fixture のサイト（127.0.0.1）と同じターゲット設定で、(a) ビルドした CLI（一時の root の `dist/cli/index.js`）を別の process で、
 *   (b) 画面のジョブ（ビルドした画面のサーバが起動するワーカー。一時の root の `dist/worker/audit-worker.js`）で、1 回ずつ監査する。
 *   どちらも本番の起動の設定（`PRODUCTION_RUN_DEPENDENCIES`。`channel: 'chromium'`）で動く（`run.json` の `environment` が同じことで確かめる）。
 *   出力先は別々（CLI は `--output` の一時のフォルダ、画面はターゲット設定の `output.directory`。どちらも一時の root の中）。
 * - 同じであることを確かめる: `run.json` と `audit.json` がスキーマの検証を通る、終了コード、Run の状態、ページの数と各ページの状態・未完了の
 *   理由・Evidence の種類、Finding の種類と数、Safety Ledger（Guard が有効、不変条件の違反 0、止めた要求と操作の数）、サイトに届いた要求
 *   （メソッドとパスの多重集合。GET と HEAD だけ）、成果物のファイルの一覧（`report.html`、ZIP の有無を含む）。
 * - 除く値: 時刻（`startedAt`、`finishedAt`、実行の記録の時刻）、Run の ID、所要時間と待った時間、パス（出力先）、ID（Finding・Evidence）、
 *   バンドルの名前の日時、ブラウザ自身のアイコンの要求（`/favicon.ico`）。
 * - 途中で止めた場面（PARTIAL。T24h-5、T24R の M4。Windows だけ）: 別の同じ fixture の設定（ページの読み込みの間隔 3 秒）で、(a) CLI を自分の
 *   コンソールで動かし、2 ページ目の進み具合の行を見た直後に本物の Ctrl+C（1 回目）を送る（`tests/helpers/windows-console-ctrl.ts`。
 *   `tests/integration/cli-interrupt-windows.test.ts` と同じ止め方）。(b) 画面のジョブは、監査を終えたページが 2 になったのを見た直後に
 *   `stopAuditJobFn`（`force` なし）で止める。どちらも、止める印の前に始めていた 3 ページ目を最後まで監査して止まる（間隔を 3 秒にして、
 *   止める合図が 3 ページ目の 2 つ目の読み込みより前に届くようにする。画面は、進み具合を管理データに書く間引き（最大 1 秒）と読み直しの
 *   間隔の分だけ遅れるので、CLI の例より長い間隔にした）。同じ数のページを終えて止まるので、COMPLETE の場面と同じ項目を比べる。
 *   加えて、両方が PARTIAL（終了コードも PARTIAL）、実行の終わり方が `STOPPED_BY_SIGNAL`、Run の未完了の理由が `RUN_INTERRUPTED`、止めた後の
 *   ページが `SKIPPED`（`RUN_INTERRUPTED`）であることを確かめる。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { formatCount } from '../../../src/presentation/format.js';
import { CLI_TEXT, cliCountText, cliFieldText } from '../../../src/presentation/messages.js';
import { startCliInWindowsConsole, type WindowsConsoleCliRun } from '../../../tests/helpers/windows-console-ctrl.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../../../src/cli/exit-codes.js';
import { isBundleFileName } from '../../../src/core/artifact-layout.js';
import { validateArtifact } from '../../../src/core/schema-validator.js';
import { BROWSER_DEFAULT_FAVICON_PATH } from '../../../tests/helpers/chromium.js';
import { expectFinishedInTime, onlyRunDirectory, runCliProcess, type CliProcessResult } from '../../../tests/helpers/cli-process.js';
import { READ_METHODS } from '../../../tests/helpers/leak-places.js';
import { descendantsOf, listProcesses, waitUntilExited, type ProcessIdentity } from '../../../tests/helpers/process-tree.js';
import {
  outputDirectoryOf,
  publicProfileDocument,
  startTimedSite,
  writeAuditTargetConfig,
  type SiteRequest,
  type TimedSite,
} from './helpers/audit-site.ts';
import {
  createTemporaryUiRoot,
  findFreePort,
  parseSetCookie,
  rawRequest,
  startLauncher,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { waitForJobViaServerFunctions } from './helpers/server-function-job-wait.ts';

/** テストの値（匿名）。 */
const PROFILE_ID = 't24g-parity';
/** CLI の出力先（一時の root からの相対）。 */
const CLI_OUTPUT_DIRECTORY = 't24g-output-cli';
/** ページの読み込みの最小の間隔（ms。ループバックの fixture なので 0）。 */
const NO_INTERVAL_MS = 0;
/** 状態が変わるのを待つ上限と、読み直す間隔（ms）。 */
const WAIT_LIMIT_MS = 150_000;
const WAIT_POLL_MS = 250;
/** process が消えるのを待つ上限（ms）。 */
const PROCESS_EXIT_LIMIT_MS = 30_000;
/** バンドルの名前の日時を除いた、比べのための名前。 */
const BUNDLE_PLACEHOLDER = '<bundle>.zip';

/** 1 回の監査の結果（比べる値）。 */
interface AuditOutcome {
  readonly exitCode: number | null;
  readonly runDirectory: string;
  readonly run: Record<string, unknown>;
  readonly audit: { readonly run: unknown; readonly pages: readonly Record<string, unknown>[]; readonly findings: readonly Record<string, unknown>[] };
  readonly requests: readonly SiteRequest[];
}

/** 画面のジョブの詳細のうち、ここで使う値。 */
interface UiJob {
  readonly active: boolean;
  readonly state: string;
  readonly runId: string | null;
  readonly exitCode: number | null;
  readonly lastProgress: { readonly pagesFinished: number } | null;
}

/** 途中で止める場面のプロファイル（設定は COMPLETE の場面と別。CLI と画面は、同じ設定を使う）。 */
const PARTIAL_PROFILE_ID = 't24h-partial';
/** 途中で止める場面の CLI の出力先と、自分のコンソールの作業のフォルダ（一時の root からの相対）。 */
const PARTIAL_CLI_OUTPUT_DIRECTORY = 't24h-output-cli-partial';
const PARTIAL_CLI_CONSOLE_DIRECTORY = 't24h-console';
/**
 * 途中で止める場面のページの読み込みの最小の間隔（ms）。止める合図が、3 ページ目の 2 つ目の読み込み（Mobile）が始まる前に届き、4 ページ目を
 * 始めないようにするための値（このファイルの先頭の説明）。
 */
const PARTIAL_INTERVAL_MS = 3_000;
/** 止める合図を送る前に、監査を終えるページの数。 */
const PAGES_BEFORE_STOP = 2;
/** 止める合図の前に始めていたので、最後まで監査するページの数。 */
const PAGES_IN_PROGRESS_AT_STOP = 1;
/** 止めた後に始めなかったページと、Run の未完了の理由。 */
const RUN_INTERRUPTED_REASON = Object.freeze({ code: 'RUN_INTERRUPTED', detail: null });

/** 画面の Server Function を呼ぶ関数（`beforeAll` で作る）。 */
type CallServerFunction = (name: string, method: 'GET' | 'POST', data: unknown) => ReturnType<typeof callServerFunction>;
let callFunction: CallServerFunction | undefined;
let partialTargetConfigPath = '';
let partialCli: AuditOutcome | undefined;
let partialUi: AuditOutcome | undefined;
const consoleRuns: WindowsConsoleCliRun[] = [];

/** CLI の進み具合の行の、監査を終えたページの数までの頭（`tests/integration/cli-interrupt-windows.test.ts` と同じ形）。 */
const progressLinePrefix = (pagesFinished: number): string =>
  `${cliFieldText(CLI_TEXT.progress.heading, cliCountText(CLI_TEXT.progress.pagesFinished, formatCount(pagesFinished)))}（`;
const hasProgressLineOf = (pagesFinished: number) => (stdout: string): boolean =>
  stdout.split(/\r?\n/u).some((line) => line.startsWith(progressLinePrefix(pagesFinished)));

let root: TemporaryUiRoot | undefined;
let site: TimedSite | undefined;
let server: StartedServer | undefined;
let cliResult: CliProcessResult | undefined;
let cli: AuditOutcome | undefined;
let ui: AuditOutcome | undefined;
const descendants: ProcessIdentity[] = [];

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

const outcomeOf = (exitCode: number | null, runDirectory: string, requests: readonly SiteRequest[]): AuditOutcome => ({
  exitCode,
  runDirectory,
  run: readJson(`${runDirectory}/run.json`),
  audit: readJson(`${runDirectory}/audit.json`),
  requests,
});

const requestsBetween = (fromMs: number, untilMs: number): readonly SiteRequest[] =>
  (site?.requests() ?? []).filter((request) => request.atMs >= fromMs && request.atMs <= untilMs);

/** Run のディレクトリの中のファイルの一覧（区切りは `/`。バンドルの名前の日時は除く）。 */
const artifactFilesOf = (runDirectory: string): readonly string[] =>
  readdirSync(runDirectory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.parentPath.replaceAll('\\', '/')}/${entry.name}`.slice(runDirectory.replaceAll('\\', '/').length + 1))
    .map((path) => (isBundleFileName(path) ? BUNDLE_PLACEHOLDER : path))
    .sort();

/** Run の要約の、揺れない値（時刻、Run の ID、所要時間、パスを除く）。 */
const stableRunOf = (run: Record<string, unknown>): Record<string, unknown> => {
  const {
    runId: _runId,
    startedAt: _startedAt,
    finishedAt: _finishedAt,
    executions,
    effectiveConfig,
    load,
    ...rest
  } = run as Record<string, unknown> & {
    executions: readonly { readonly endReason: string }[];
    effectiveConfig: Record<string, unknown>;
    load: { readonly minNavigationIntervalMs: number; readonly maxInteractionsPerPage: number; readonly navigationCount: number };
  };
  const { output: _output, ...config } = effectiveConfig;
  return {
    ...rest,
    executionEndReasons: executions.map((execution) => execution.endReason),
    effectiveConfig: config,
    load: { minNavigationIntervalMs: load.minNavigationIntervalMs, maxInteractionsPerPage: load.maxInteractionsPerPage, navigationCount: load.navigationCount },
  };
};

/** ページの揺れない値（URL、状態、未完了の理由のコード、Evidence の種類とビューポートの多重集合）。 */
const stablePagesOf = (pages: readonly Record<string, unknown>[]): readonly unknown[] =>
  pages.map((page) => ({
    pageUrl: page['pageUrl'],
    status: page['status'],
    incompleteReasons: (page['incompleteReasons'] as readonly { readonly code: string }[]).map((reason) => reason.code).sort(),
    evidence: (page['evidence'] as readonly { readonly type: string; readonly viewport?: string | null }[])
      .map((record) => `${record.type}:${record.viewport ?? '-'}`)
      .sort(),
  })).sort((left, right) => String(left.pageUrl).localeCompare(String(right.pageUrl)));

/** Finding の種類と数（ID と指紋を除く）。 */
const stableFindingsOf = (findings: readonly Record<string, unknown>[]): readonly string[] =>
  findings.map((finding) => [finding['ruleId'], finding['category'], finding['severity'], finding['pageUrl'], finding['viewport']].join(' ')).sort();

/** サイトに届いた要求（メソッドとパスの多重集合。ブラウザ自身のアイコンの要求を除く）。 */
const stableRequestsOf = (requests: readonly SiteRequest[]): readonly string[] =>
  requests.filter((request) => request.pathname !== BROWSER_DEFAULT_FAVICON_PATH).map((request) => `${request.method} ${request.pathname}`).sort();

const outcomes = (): { readonly cli: AuditOutcome; readonly ui: AuditOutcome } => {
  if (cli === undefined || ui === undefined) {
    throw new Error('監査の結果がない');
  }
  return { cli, ui };
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  site = await startTimedSite();
  const targetConfigPath = writeAuditTargetConfig(root.root, PROFILE_ID, site.origin, {
    minNavigationIntervalMs: NO_INTERVAL_MS,
    screenshots: true,
    accessibilityAndInteractions: true,
  });

  // (a) CLI（一時の root の dist を、一時の root を cwd にして、別の process で動かす）。
  const cliStartedAt = Date.now();
  cliResult = await runCliProcess(
    { rootDirectory: root.root, distDirectory: `${root.root}/dist`, remove: async () => undefined },
    root.root,
    ['run', '--config', targetConfigPath, '--output', CLI_OUTPUT_DIRECTORY, '--headless'],
  );
  const cliFinishedAt = Date.now();
  cli = outcomeOf(cliResult.status, await onlyRunDirectory(`${root.root}/${CLI_OUTPUT_DIRECTORY}`), requestsBetween(cliStartedAt, cliFinishedAt));

  // (b) 画面のジョブ（同じターゲット設定。出力先は、ターゲット設定の `output.directory`）。
  server = await startLauncher(root, await findFreePort());
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  const cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  const ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  const started = server;
  const call: CallServerFunction = (name, method, data) =>
    callServerFunction({ port: started.port, origin: started.origin, cookie, ids }, name, method, data);
  callFunction = call;
  expect((await call('createProfileFn', 'POST', { profile: publicProfileDocument(PROFILE_ID, targetConfigPath) })).value).toMatchObject({ ok: true });
  const uiStartedAt = Date.now();
  const start = (await call('startAuditJobFn', 'POST', { profileId: PROFILE_ID, expectedRevision: 1, startNew: true })).value as { jobId: string };
  // PRE42-CC 組 UI-K2（CC-112）: 読み直して待つのは補助（上限と間隔は前と同じ）。読むたびに、動いている間は画面のサーバの子孫を記録する。
  const job = await waitForJobViaServerFunctions(
    (jobId) => readUiJobRecording(call, started, jobId),
    start.jobId,
    (current) => !current.active,
    { limitMs: WAIT_LIMIT_MS, stepMs: WAIT_POLL_MS },
  );
  const uiFinishedAt = Date.now();
  expect(job.state).toBe('FINISHED');
  ui = outcomeOf(job.exitCode, `${root.root}/${outputDirectoryOf(PROFILE_ID)}/${job.runId ?? ''}`, requestsBetween(uiStartedAt, uiFinishedAt));
  console.info(`CLI and UI parity: run status ${String(cli.run['runStatus'])} / ${String(ui.run['runStatus'])}, exit code ${String(cli.exitCode)} / `
    + `${String(ui.exitCode)}, pages ${cli.audit.pages.length} / ${ui.audit.pages.length}, findings ${cli.audit.findings.length} / `
    + `${ui.audit.findings.length}, requests ${cli.requests.length} / ${ui.requests.length}, chromium ${JSON.stringify((cli.run['environment'] as { chromiumVersion?: string }).chromiumVersion)}`);
});

afterAll(async () => {
  for (const consoleRun of consoleRuns) {
    await consoleRun.stop();
  }
  await stopServer(server);
  expect(await waitUntilExited(descendants, PROCESS_EXIT_LIMIT_MS)).toEqual([]);
  await site?.close();
  root?.remove();
});

describe('CLI and the UI job give the same audit (Task 24 design 7, G24)', () => {
  it('both finished, with the same exit code (the CLI process within its limit)', () => {
    const { cli: cliOutcome, ui: uiOutcome } = outcomes();
    if (cliResult !== undefined) {
      expectFinishedInTime(cliResult);
    }
    expect(cliOutcome.exitCode).not.toBeNull();
    expect(uiOutcome.exitCode).toBe(cliOutcome.exitCode);
    expect(cliOutcome.runDirectory).not.toBe(uiOutcome.runDirectory);
  });

  it('writes run.json and audit.json that pass the schemas, on both sides', async () => {
    for (const outcome of [outcomes().cli, outcomes().ui]) {
      await expect(validateArtifact('run', outcome.run)).resolves.toEqual({ ok: true });
      await expect(validateArtifact('audit', outcome.audit)).resolves.toEqual({ ok: true });
    }
  });

  it('has the same Run status, counts, environment (production Chromium) and configuration, except times, IDs and paths', () => {
    const { cli: cliOutcome, ui: uiOutcome } = outcomes();
    expect(uiOutcome.run['runStatus']).toBe(cliOutcome.run['runStatus']);
    expect(EXIT_CODES[cliOutcome.run['runStatus'] as keyof typeof EXIT_CODES]).toBe(cliOutcome.exitCode);
    expect(stableRunOf(uiOutcome.run)).toEqual(stableRunOf(cliOutcome.run));
  });

  it('has the same pages (status, incomplete reasons, evidence kinds) and the same findings', () => {
    const { cli: cliOutcome, ui: uiOutcome } = outcomes();
    expect(cliOutcome.audit.pages.length).toBeGreaterThan(1);
    expect(stablePagesOf(uiOutcome.audit.pages)).toEqual(stablePagesOf(cliOutcome.audit.pages));
    expect(stableFindingsOf(uiOutcome.audit.findings)).toEqual(stableFindingsOf(cliOutcome.audit.findings));
  });

  it('keeps the Safety Ledger clean on both sides (Guard on, no invariant violation, the same blocked counts)', () => {
    const { cli: cliOutcome, ui: uiOutcome } = outcomes();
    for (const outcome of [cliOutcome, uiOutcome]) {
      expect(outcome.run['safety']).toMatchObject({ guardEnabled: true, invariantViolationCount: 0, invariantViolations: [] });
    }
    expect(uiOutcome.run['safety']).toEqual(cliOutcome.run['safety']);
  });

  it('sent only GET and HEAD to the fixture site, and the same requests from both sides', () => {
    const { cli: cliOutcome, ui: uiOutcome } = outcomes();
    for (const outcome of [cliOutcome, uiOutcome]) {
      expect(outcome.requests.length).toBeGreaterThan(0);
      expect(outcome.requests.filter((request) => !READ_METHODS.has(request.method))).toEqual([]);
    }
    expect(stableRequestsOf(uiOutcome.requests)).toEqual(stableRequestsOf(cliOutcome.requests));
  });

  it('writes the same artifact files (report.html, the bundle ZIP, pages and screenshots)', () => {
    const { cli: cliOutcome, ui: uiOutcome } = outcomes();
    const files = artifactFilesOf(cliOutcome.runDirectory);
    expect(files).toEqual(expect.arrayContaining(['report.html', 'run.json', 'audit.json', BUNDLE_PLACEHOLDER]));
    expect(files.some((path) => path.endsWith('.png'))).toBe(true);
    expect(artifactFilesOf(uiOutcome.runDirectory)).toEqual(files);
  });
});

/** 画面のジョブを 1 回読み、動いている間は画面のサーバの子孫を記録する（PRE42-CC 組 UI-K2。待つのは補助 `waitForJobViaServerFunctions`）。 */
async function readUiJobRecording(call: CallServerFunction, uiServer: StartedServer, jobId: string): Promise<UiJob | null> {
  const job = (await call('getAuditJobFn', 'GET', { jobId })).value as UiJob | null;
  if (job?.active === true) {
    descendants.push(...descendantsOf(uiServer.child.pid ?? 0, await listProcesses()));
  }
  return job;
}

/** 画面のジョブが `predicate` を満たすまで読み直す（動いている間は、画面のサーバの子孫を記録する）。 */
async function waitForUiJob(jobId: string, predicate: (job: UiJob) => boolean): Promise<UiJob> {
  const call = callFunction;
  const uiServer = server;
  if (call === undefined || uiServer === undefined) {
    throw new Error('画面のサーバがない');
  }
  return waitForJobViaServerFunctions((id) => readUiJobRecording(call, uiServer, id), jobId, predicate, { limitMs: WAIT_LIMIT_MS, stepMs: WAIT_POLL_MS / 5 });
}

const partialOutcomes = (): { readonly cli: AuditOutcome; readonly ui: AuditOutcome } => {
  if (partialCli === undefined || partialUi === undefined) {
    throw new Error('途中で止めた監査の結果がない');
  }
  return { cli: partialCli, ui: partialUi };
};

/** ページの状態と未完了の理由（クロールの順。止めた時点が同じかを確かめる）。 */
const pageStatusesOf = (pages: readonly Record<string, unknown>[]): readonly unknown[] =>
  pages.map((page) => ({ pageUrl: page['pageUrl'], status: page['status'], incompleteReasons: page['incompleteReasons'] }));

describe.skipIf(process.platform !== 'win32')('CLI and the UI job give the same PARTIAL audit when stopped after the same page (T24h-5)', () => {
  beforeAll(async () => {
    const call = callFunction;
    if (root === undefined || site === undefined || call === undefined) {
      throw new Error('準備ができていない');
    }
    partialTargetConfigPath = writeAuditTargetConfig(root.root, PARTIAL_PROFILE_ID, site.origin, {
      minNavigationIntervalMs: PARTIAL_INTERVAL_MS,
      screenshots: false,
    });

    // (a) CLI: 自分のコンソールで動かし、2 ページ目の進み具合の行を見た直後に、1 回目の Ctrl+C を送る。
    const cliStartedAt = Date.now();
    const consoleRun = await startCliInWindowsConsole(
      { rootDirectory: root.root, distDirectory: `${root.root}/dist`, remove: async () => undefined },
      {
        directory: `${root.root}/${PARTIAL_CLI_CONSOLE_DIRECTORY}`,
        cwd: root.root,
        arguments: ['run', '--config', partialTargetConfigPath, '--output', PARTIAL_CLI_OUTPUT_DIRECTORY, '--headless'],
      },
    );
    consoleRuns.push(consoleRun);
    await consoleRun.waitForOutput('stdout', hasProgressLineOf(PAGES_BEFORE_STOP));
    await consoleRun.sendCtrlC();
    const cliFinished = await consoleRun.finished;
    expect(cliFinished.scriptStatus, cliFinished.scriptOutput).toBe(0);
    expect(cliFinished.stderr).toContain(CLI_TEXT.interrupt.stopRequested);
    const cliFinishedAt = Date.now();
    partialCli = outcomeOf(
      cliFinished.status,
      await onlyRunDirectory(`${root.root}/${PARTIAL_CLI_OUTPUT_DIRECTORY}`),
      requestsBetween(cliStartedAt, cliFinishedAt),
    );

    // (b) 画面のジョブ: 同じ設定で始め、監査を終えたページが 2 になったのを見た直後に止める。
    expect((await call('createProfileFn', 'POST', { profile: publicProfileDocument(PARTIAL_PROFILE_ID, partialTargetConfigPath) })).value)
      .toMatchObject({ ok: true });
    const uiStartedAt = Date.now();
    const start = (await call('startAuditJobFn', 'POST', { profileId: PARTIAL_PROFILE_ID, expectedRevision: 1, startNew: true })).value as {
      jobId: string;
    };
    const atStop = await waitForUiJob(start.jobId, (job) => (job.lastProgress?.pagesFinished ?? 0) >= PAGES_BEFORE_STOP || !job.active);
    expect(atStop.lastProgress?.pagesFinished).toBe(PAGES_BEFORE_STOP);
    expect((await call('stopAuditJobFn', 'POST', { jobId: start.jobId, force: false })).value).toMatchObject({ ok: true });
    const finished = await waitForUiJob(start.jobId, (job) => !job.active);
    const uiFinishedAt = Date.now();
    expect(finished.state).toBe('FINISHED');
    partialUi = outcomeOf(
      finished.exitCode,
      `${root.root}/${outputDirectoryOf(PARTIAL_PROFILE_ID)}/${finished.runId ?? ''}`,
      requestsBetween(uiStartedAt, uiFinishedAt),
    );
    console.info(`CLI and UI parity (PARTIAL): run status ${String(partialCli.run['runStatus'])} / ${String(partialUi.run['runStatus'])}, `
      + `audited pages ${String(partialCli.run['auditedPageCount'])} / ${String(partialUi.run['auditedPageCount'])}, `
      + `requests ${partialCli.requests.length} / ${partialUi.requests.length}`);
  }, WAIT_LIMIT_MS * 2);

  it('both stopped with PARTIAL (exit code of PARTIAL), the last execution STOPPED_BY_SIGNAL and the Run reason RUN_INTERRUPTED', async () => {
    const { cli: cliOutcome, ui: uiOutcome } = partialOutcomes();
    for (const outcome of [cliOutcome, uiOutcome]) {
      expect(outcome.exitCode).toBe(EXIT_CODES.PARTIAL);
      expect(outcome.run['runStatus']).toBe('PARTIAL');
      expect((outcome.run['executions'] as readonly { readonly endReason: string }[]).map(({ endReason }) => endReason))
        .toEqual(['STOPPED_BY_SIGNAL']);
      expect(outcome.run['incompleteReasons']).toEqual([RUN_INTERRUPTED_REASON]);
      await expect(validateArtifact('run', outcome.run)).resolves.toEqual({ ok: true });
      await expect(validateArtifact('audit', outcome.audit)).resolves.toEqual({ ok: true });
    }
  });

  it('stopped after the same pages: the audited pages, then the pages SKIPPED by RUN_INTERRUPTED', () => {
    const { cli: cliOutcome, ui: uiOutcome } = partialOutcomes();
    const auditedPages = PAGES_BEFORE_STOP + PAGES_IN_PROGRESS_AT_STOP;
    const statuses = pageStatusesOf(cliOutcome.audit.pages);
    expect(statuses.length).toBeGreaterThan(auditedPages);
    const shapeOf = (page: unknown): unknown => ({
      status: (page as { status: unknown }).status,
      incompleteReasons: (page as { incompleteReasons: unknown }).incompleteReasons,
    });
    // 止める前に始めていたページまでは監査し（SKIPPED でない）、その後のページは RUN_INTERRUPTED で SKIPPED。
    expect(statuses.slice(0, auditedPages).every((page) => (page as { status: string }).status !== 'SKIPPED')).toBe(true);
    expect(statuses.slice(auditedPages).map(shapeOf))
      .toEqual(Array.from({ length: statuses.length - auditedPages }, () => ({ status: 'SKIPPED', incompleteReasons: [RUN_INTERRUPTED_REASON] })));
    expect(pageStatusesOf(uiOutcome.audit.pages)).toEqual(statuses);
  });

  it('has the same Run summary, pages, findings and artifact files, except times, IDs and paths', () => {
    const { cli: cliOutcome, ui: uiOutcome } = partialOutcomes();
    expect(stableRunOf(uiOutcome.run)).toEqual(stableRunOf(cliOutcome.run));
    expect(stablePagesOf(uiOutcome.audit.pages)).toEqual(stablePagesOf(cliOutcome.audit.pages));
    expect(stableFindingsOf(uiOutcome.audit.findings)).toEqual(stableFindingsOf(cliOutcome.audit.findings));
    expect(artifactFilesOf(uiOutcome.runDirectory)).toEqual(artifactFilesOf(cliOutcome.runDirectory));
  });

  it('keeps the Safety Ledger clean, and sent only GET and HEAD, the same requests from both sides', () => {
    const { cli: cliOutcome, ui: uiOutcome } = partialOutcomes();
    for (const outcome of [cliOutcome, uiOutcome]) {
      expect(outcome.run['safety']).toMatchObject({ guardEnabled: true, invariantViolationCount: 0, invariantViolations: [] });
      expect(outcome.requests.length).toBeGreaterThan(0);
      expect(outcome.requests.filter((request) => !READ_METHODS.has(request.method))).toEqual([]);
    }
    expect(uiOutcome.run['safety']).toEqual(cliOutcome.run['safety']);
    expect(stableRequestsOf(uiOutcome.requests)).toEqual(stableRequestsOf(cliOutcome.requests));
  });
});

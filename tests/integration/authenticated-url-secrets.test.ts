// T25f（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 4.6）: 認証つきの Run の成果物の URL の query の伏せ字。
// 本物の監査の中核（`executeAuditRun`、Run Coordinator、factory、Guard、保存のセッション、`ArtifactWriter`）と、127.0.0.1 の fixture のサーバ
// （`tests/helpers/authenticated-site-fixture.ts` の `queryTokens`）で確かめる。Chromium は headless だけ（テストの既定と、CLI の起動の設定の両方）。
// - 認証つきの Run: query の秘密の目印（リンク、画像、移動の先の `code` と `state`）が、Run のディレクトリのどのファイル（保存、ZIP の中身を含む）
//   にも現れず、伏せ字の印（`token=[REDACTED]` など）に替わって現れる。サーバには、目印つきの要求が届いている（巡回は伏せ字の前の URL で行う）。
// - T25f round 1: 認証つきの Run では、`crawl.allowedQueryParameters` に伏せ字の一覧の名前（`token`）があれば、設定のエラーで始めない（Browser を
//   起動せず、サイトへ何も送らない）。公開監査では今のまま始まる。
// - セッションの切れで止まった Run: 知らせ（`AUTH_SESSION_LOST`）と保存に目印が出ず、保存には伏せ字の印が現れる。もう一度ログインした状態で、
//   同じ Run を再開できる（ページの URL は伏せ字の対象にならないので、伏せ字の後の保存から再開できる）。
// - 公開監査（認証の指定なし）では、伏せ字を通さない（今の出力のまま、目印がそのまま残る）。
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  executeAuditRun,
  type AuditRunDependencies,
  type AuditRunOutcome,
  type AuditRunStart,
} from '../../src/cli/audit-run.js';
import { ConfigError } from '../../src/config/config-error.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/control/auth/auth-setup-contracts.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { RUN_ARTIFACT_FILE_NAMES, listRunDirectories } from '../../src/core/artifact-layout.js';
import { REDACTED } from '../../src/core/redaction.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import type { RunNotice } from '../../src/orchestration/run-coordinator.js';
import {
  AUTH_SITE_PATHS,
  AUTH_SITE_TOKEN_PATHS,
  authenticatedStateFor,
  startAuthenticatedSite,
  type AuthenticatedSite,
  type AuthenticatedSiteOptions,
} from '../helpers/authenticated-site-fixture.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { createTestConfig } from '../helpers/test-config.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;
/** 巡回するページの数の上限（管理画面、report、item、jump、second、frames）。 */
const MAX_PAGES = 6;
/** セッションの切れの場面の上限（管理画面、report、item の 1 つ目で止まる）。 */
const SESSION_LOST_MAX_PAGES = 4;
const TEST_TIMEOUT_MS = 240_000;
/** `crawl.allowedQueryParameters` に入れる、伏せ字の一覧の名前（認証つきの Run では受けない。公開監査では今のまま）。 */
const TOKEN_QUERY_NAME = 'token';

/** ディレクトリの下のすべてのファイルの中身（ZIP は展開した中身も）。 */
async function readAllFiles(directory: string): Promise<{ readonly path: string; readonly bytes: Uint8Array }[]> {
  const files: { readonly path: string; readonly bytes: Uint8Array }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const bytes = new Uint8Array(await readFile(path));
    files.push({ path, bytes });
    if (entry.name.endsWith('.zip')) {
      for (const [name, content] of Object.entries(unzipSync(bytes))) {
        files.push({ path: `${path}!${name}`, bytes: content });
      }
    }
  }
  return files;
}

/** `bytes` が、`needle`（UTF-8）を含むか。 */
const containsBytes = (bytes: Uint8Array, needle: string): boolean => Buffer.from(bytes).includes(Buffer.from(needle, 'utf8'));

/** 目印を含むファイルの `<path>` の一覧（目印の値は出さない）。 */
const leakedFiles = (files: readonly { readonly path: string; readonly bytes: Uint8Array }[], markers: readonly string[]): readonly string[] =>
  files.flatMap(({ path, bytes }) => (markers.some((marker) => containsBytes(bytes, marker)) ? [path] : []));

describe.each(LAUNCHERS)('T25f: the URL secrets of an authenticated Run (%s)', (_name, launch) => {
  let workDirectory: string;
  let site: AuthenticatedSite | undefined;
  const browsers: Browser[] = [];

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-authenticated-url-secrets-'));
  });

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close().catch(() => undefined)));
    await site?.close();
    site = undefined;
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  async function startSite(options: AuthenticatedSiteOptions): Promise<AuthenticatedSite> {
    site = await startAuthenticatedSite({ queryTokens: true, ...options });
    return site;
  }

  const dependenciesWith = (authentication?: RunAuthentication): AuditRunDependencies => ({
    launchBrowser: async () => {
      const browser = await launch();
      browsers.push(browser);
      return browser;
    },
    clock: () => new Date(),
    now: () => Date.now(),
    ...(authentication === undefined ? {} : { authentication }),
  });

  /** 認証の指定と、状態に入れた秘密の値。 */
  const authenticationFor = (started: AuthenticatedSite): { readonly authentication: RunAuthentication; readonly secrets: readonly string[] } => {
    const { state, secrets } = authenticatedStateFor(started);
    return {
      authentication: {
        initialState: state,
        approvedTestOrigins: [started.originA],
        auditExclusions: {
          excludedPathPrefixes: [AUTH_SITE_PATHS.adminLogout],
          auditPathPrefixes: [AUTH_SITE_PATHS.admin],
          dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
        },
        sessionLostPathPrefix: AUTH_SITE_PATHS.login,
        filterState: filterAuthenticatedState,
      },
      secrets,
    };
  };

  const configFor = (
    started: AuthenticatedSite,
    startPath: string,
    outputDirectory: string,
    overrides: { readonly maxPages?: number; readonly allowedQueryParameters?: readonly string[] } = {},
  ): AuditConfig =>
    createTestConfig(started.originA, startPath, {
      crawl: { maxPages: overrides.maxPages ?? MAX_PAGES, allowedQueryParameters: [...(overrides.allowedQueryParameters ?? [])] },
      viewports: { stressWidths: [] },
      audit: { screenshots: true },
      output: { directory: outputDirectory },
    });

  const ranOf = (outcome: AuditRunOutcome): Extract<AuditRunOutcome, { kind: 'RAN' }> => {
    if (outcome.kind !== 'RAN') {
      throw new Error(`the audit did not run: ${outcome.kind}`);
    }
    return outcome;
  };

  /** サーバに届いた要求のうち、path と query に `value` を含むものの数（値は出力しない）。 */
  const requestsWith = (started: AuthenticatedSite, value: string): number =>
    started.requests.filter(({ path }) => path.includes(value)).length;

  const nonReadRequests = (started: AuthenticatedSite): readonly string[] =>
    started.requests.filter(({ method }) => method !== 'GET' && method !== 'HEAD').map(({ method, path }) => `${method} ${path}`);

  it('writes no query secret to any file of the Run directory and shows the redaction marker instead', async () => {
    const started = await startSite({ rotate: true });
    const { authentication, secrets } = authenticationFor(started);
    const outputDirectory = join(workDirectory, `redacted-${browsers.length}-${Date.now()}`);
    const ran = ranOf(await executeAuditRun(configFor(started, AUTH_SITE_PATHS.admin, outputDirectory), dependenciesWith(authentication), {
      startNew: true,
    }));

    // 巡回は、伏せ字の前の URL で行った: 画像の目印と、移動の先の code と state の目印つきの要求が、サーバに届いた。
    const [, , , pixel, code, state] = started.queryTokenValues();
    for (const value of [pixel, code, state]) {
      expect(requestsWith(started, value ?? '')).toBeGreaterThan(0);
    }
    expect(nonReadRequests(started)).toEqual([]);

    const files = await readAllFiles(ran.runDirectory);
    expect(files.some(({ path }) => path.endsWith('.zip'))).toBe(true);
    const markers = [...new Set([...started.queryTokenValues(), ...secrets, ...started.secretValues()])];
    expect(leakedFiles(files, markers)).toEqual([]);
    // 伏せ字の印に替わって現れる（Evidence のリンクの生の値、画像の要求、移動の先の最後の URL）。
    const audit = files.find(({ path }) => path.endsWith(RUN_ARTIFACT_FILE_NAMES.audit));
    for (const expected of [`token=${REDACTED}&page=2`, `access_token=${REDACTED}`, `code=${REDACTED}&state=${REDACTED}`]) {
      expect(containsBytes(audit?.bytes ?? new Uint8Array(), expected), expected).toBe(true);
    }
  }, TEST_TIMEOUT_MS);

  it('does not start an authenticated Run that keeps a secret name in crawl.allowedQueryParameters, and the public audit starts as it does now', async () => {
    const started = await startSite({});
    const outputDirectory = join(workDirectory, `rejected-${browsers.length}-${Date.now()}`);
    const config = configFor(started, AUTH_SITE_PATHS.admin, outputDirectory, { allowedQueryParameters: [TOKEN_QUERY_NAME] });

    // 認証つきの Run: 設定のエラーで、Browser を起動せず、サイトへ何も送らず、Run のディレクトリも作らない。
    const launchedBefore = browsers.length;
    await expect(executeAuditRun(config, dependenciesWith(authenticationFor(started).authentication), { startNew: true }))
      .rejects.toBeInstanceOf(ConfigError);
    expect(browsers.length).toBe(launchedBefore);
    expect(started.requests).toEqual([]);
    expect(await listRunDirectories(outputDirectory)).toEqual([]);

    // 公開監査（認証の指定なし。同じサイトのセッションを問わない画面）: 今のまま始まり、`token` つきのページも読む。
    const publicConfig = configFor(started, AUTH_SITE_TOKEN_PATHS.publicTokens, join(workDirectory, `public-allowed-${Date.now()}`), {
      maxPages: 2,
      allowedQueryParameters: [TOKEN_QUERY_NAME],
    });
    const ran = ranOf(await executeAuditRun(publicConfig, dependenciesWith(), { startNew: true }));
    const [publicLink] = started.queryTokenValues().slice(-2);
    expect(requestsWith(started, publicLink ?? '')).toBeGreaterThan(0);
    expect(ran.runStatus).not.toBe('FAILED');
  }, TEST_TIMEOUT_MS);

  it('stops with AUTH_SESSION_LOST without any secret in the notice or the checkpoint, and resumes with a new login', async () => {
    const started = await startSite({ rotate: true, expireFirstSessionAtPath: AUTH_SITE_TOKEN_PATHS.item });
    const outputDirectory = join(workDirectory, `lost-${browsers.length}-${Date.now()}`);
    const config = configFor(started, AUTH_SITE_PATHS.admin, outputDirectory, { maxPages: SESSION_LOST_MAX_PAGES });
    const notices: RunNotice[] = [];
    const firstAuthentication = authenticationFor(started);
    const first = ranOf(await executeAuditRun(config, dependenciesWith(firstAuthentication.authentication), { startNew: true }, {
      onNotice: (notice) => notices.push(notice),
    }));
    expect(first.summary.executions.lastEndReason).toBe('STOPPED_BY_AUTH_SESSION_LOST');
    const lost = notices.filter((notice) => notice.kind === 'AUTH_SESSION_LOST');
    expect(lost).toHaveLength(1);
    expect(lost[0]?.kind === 'AUTH_SESSION_LOST' ? lost[0].url : '').toBe(`${started.originA}${AUTH_SITE_TOKEN_PATHS.item}`);
    const markers = [...new Set([...started.queryTokenValues(), ...firstAuthentication.secrets, ...started.secretValues()])];
    expect(leakedFiles(notices.map((notice) => ({ path: notice.kind, bytes: Buffer.from(JSON.stringify(notice)) })), markers)).toEqual([]);
    const stoppedFiles = await readAllFiles(first.runDirectory);
    const checkpointFiles = stoppedFiles.filter(({ path }) => path.includes('checkpoint'));
    expect(checkpointFiles.length).toBeGreaterThan(0);
    expect(checkpointFiles.some(({ bytes }) => containsBytes(bytes, `token=${REDACTED}`))).toBe(true);
    expect(leakedFiles(stoppedFiles, markers)).toEqual([]);

    // もう一度ログインした状態（新しいセッション）で、止まった Run を再開する（保存は伏せ字の後でも読める）。
    const starts: AuditRunStart[] = [];
    const secondAuthentication = authenticationFor(started);
    const resumed = ranOf(await executeAuditRun(config, dependenciesWith(secondAuthentication.authentication), { startNew: false }, {
      onRunStarting: (start) => starts.push(start),
    }));
    expect(starts[0]?.resumeDecision.kind).toBe('RESUME');
    expect(resumed.runDirectory).toBe(first.runDirectory);
    const allMarkers = [...new Set([...markers, ...secondAuthentication.secrets, ...started.secretValues()])];
    expect(leakedFiles(await readAllFiles(resumed.runDirectory), allMarkers)).toEqual([]);
    expect(nonReadRequests(started)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('keeps the public audit unchanged: the query values stay as they are without the authentication', async () => {
    const started = await startSite({});
    const outputDirectory = join(workDirectory, `public-${browsers.length}-${Date.now()}`);
    const ran = ranOf(await executeAuditRun(
      configFor(started, AUTH_SITE_TOKEN_PATHS.publicTokens, outputDirectory, { maxPages: 1 }),
      dependenciesWith(),
      { startNew: true },
    ));

    const publicValues = started.queryTokenValues().slice(-2);
    const files = await readAllFiles(ran.runDirectory);
    const audit = files.find(({ path }) => path.endsWith(RUN_ARTIFACT_FILE_NAMES.audit));
    for (const value of publicValues) {
      expect(containsBytes(audit?.bytes ?? new Uint8Array(), value)).toBe(true);
    }
    for (const redacted of [`token=${REDACTED}`, `access_token=${REDACTED}`]) {
      expect(files.some(({ bytes }) => containsBytes(bytes, redacted)), redacted).toBe(false);
    }
  }, TEST_TIMEOUT_MS);
});

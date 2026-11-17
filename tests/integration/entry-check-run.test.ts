// T43c（Task 43 の設計書 3 章、4.3、5 章の 3）: 入口の確かめのジョブの流れ（`src/worker/entry-check-run.ts` の `executeEntryCheckRun`）を、同じ process の
// 中で、本物の factory と Guard と Chromium（テストの既定。外の Origin に届かないことの場面だけ、CLI の起動の設定でも）と、127.0.0.1 の fixture のサーバで確かめる結合テスト。
// - 案が正しく埋まる: form のあるログイン（SPA の fixture の今の画面。action のない form → スクリプトで送る）、form のないログイン（`loginLayout` の
//   `formless`。スクリプトで送る）、form の送信のログイン（自動ログインの fixture の `standard`。フォームの送信とその送信先）、値の目印を入れた form
//   （同じ form の中だけで探す）、パスワードの欄が 2 つの画面（その欄の案を出さない）、値に見える区切りを含む path（開始の URL の案を出さない）。
// - 許可 Origin の外へ移るログイン（302 と、読み込みの後のページの JS）: 移ろうとした Origin だけを記録し、案を作らない。外の Origin に要求は届かない。
// - 安全: 読み込みは 1 回（pacer の読み込みの開始の数と、サーバに届いた開始の URL の文書の要求の数）。読み取りでない要求は 0（サーバの記録で数え、
//   全部の後に名前つきの時間だけ待って数え直す）。成果物はスキーマに通り、欄の値の目印が出ない。
// 出力先は一時のフォルダだけ。サーバは 127.0.0.1 だけで待ち受ける。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import type { EntryCheckDocument } from '../../src/control/entry-check.js';
import { ENTRY_CHECK_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import type { RunId } from '../../src/core/contracts.js';
import { wait } from '../../src/core/deadline.js';
import { REDACTED_PATH_SEGMENT } from '../../src/core/url-path-redaction.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { executeEntryCheckRun, type EntryCheckRunOutcome } from '../../src/worker/entry-check-run.js';
import {
  AUTOMATED_LOGIN_FIXTURE_SELECTORS,
  startAutomatedLoginFixture,
  type AutomatedLoginFixture,
} from '../helpers/automated-login-fixture.js';
import { BOTH_CHROMIUM_LAUNCHERS, ONCE_CHROMIUM_LABEL } from '../helpers/chromium.js';
import {
  ENTRY_CHECK_SITE_PATHS,
  ENTRY_CHECK_VALUE_MARKERS,
  startEntryCheckSite,
  type EntryCheckSite,
} from '../helpers/entry-check-site.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { createTestNavigationPacer, forwardingNavigationPacer } from '../helpers/navigation-pacer.js';
import { SPA_APP_PATHS, SPA_LOGIN_FIELDS, startSpaAuthSite, type SpaAuthSite } from '../helpers/spa-auth-site-fixture.js';
import { createTestConfig } from '../helpers/test-config.js';

/**
 * TEST-SLIM D2（TEST-POLICY の 3）: 2 つの Chromium で流すのは、許可 Origin の外に何も届かないことを確かめる場面だけ。ほかの場面（案の中身）は、
 * 既定の Chromium だけで流す。
 */
const DEFAULT_LABEL = ONCE_CHROMIUM_LABEL;
const TEST_TIMEOUT_MS = 120_000;
/** 全部の回の後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_500;

interface Run {
  readonly outcome: EntryCheckRunOutcome;
  readonly document: EntryCheckDocument | null;
  readonly text: string;
  readonly started: readonly { readonly runId: RunId; readonly runDirectory: string }[];
  /** 読み込みの開始の数（pacer の `beforeNavigation` を呼んだ数）。 */
  readonly navigations: number;
  /** DEF-236: 画面を見せたまま次の読み込みを待った数（pacer の `waitUntilNextNavigationDue` を呼んだ数）。 */
  readonly pacingWaits: number;
}

/** 読み取りでない要求（method が GET・HEAD でない）。 */
const nonReadOf = <T extends { readonly method: string; readonly path: string }>(requests: readonly T[]): readonly T[] =>
  requests.filter(({ method }) => !READ_METHODS.has(method));

const pathnameOf = (path: string): string => new URL(path, 'http://127.0.0.1').pathname;

describe.each(BOTH_CHROMIUM_LAUNCHERS)('T43c: the entry check job flow (%s)', (name, launch) => {
  const itOnDefault = it.runIf(name === DEFAULT_LABEL);
  let outputDirectory: string;
  let entrySite: EntryCheckSite;
  let loginFixture: AutomatedLoginFixture;
  const spaSites: SpaAuthSite[] = [];

  beforeAll(async () => {
    // 起動できることを先に確かめる（起動の失敗を、入口の確かめの失敗と取り違えない）。
    const browser: Browser = await launch();
    await browser.close();
    entrySite = await startEntryCheckSite();
    loginFixture = await startAutomatedLoginFixture({ username: 'entry-user', password: 'entry-pass' });
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    // 全部の回の後に、名前つきの時間だけ待ってから、サーバの記録を数え直す（閉じた後に遅れて届く要求を見逃さない）。
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReadOf(entrySite.requests), 'non-read requests to the entry check site').toEqual([]);
    // SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 許可の外への main frame の移動は止めないので、外の Origin には移動の GET だけが届く。
    expect(entrySite.requests.filter(({ site, method }) => site === 'B' && method !== 'GET'), 'non-read requests outside the allowed origins').toEqual([]);
    expect(nonReadOf(loginFixture.requests), 'non-read requests to the login fixture').toEqual([]);
    expect(loginFixture.requests.filter(({ site }) => site !== 'A'), 'requests outside the allowed origins').toEqual([]);
    for (const site of spaSites) {
      expect(nonReadOf(site.requests), 'non-read requests to the SPA fixture').toEqual([]);
      expect(site.requests.filter(({ origin }) => origin !== 'app'), 'requests outside the app origin').toEqual([]);
    }
    await entrySite.close();
    await loginFixture.close();
    await Promise.all(spaSites.map((site) => site.close()));
  }, TEST_TIMEOUT_MS);

  beforeEach(async () => {
    outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-entry-check-run-'));
  });

  afterEach(async () => {
    await rm(outputDirectory, { recursive: true, force: true });
  });

  const configFor = (origin: string, startPath: string): AuditConfig => createTestConfig(origin, startPath, {
    audit: { screenshots: false },
    output: { directory: outputDirectory },
  });

  const run = async (config: AuditConfig): Promise<Run> => {
    const started: { runId: RunId; runDirectory: string }[] = [];
    const pacer = createTestNavigationPacer(config);
    let navigations = 0;
    let pacingWaits = 0;
    const forwarding = forwardingNavigationPacer(pacer, async () => {
      navigations += 1;
      return pacer.beforeNavigation();
    });
    const outcome = await executeEntryCheckRun({
      config,
      jobId: 'job-entry-1',
      launchBrowser: launch,
      clock: () => new Date(),
      now: () => Date.now(),
      stopSignal: new AbortController().signal,
      navigationPacer: {
        ...forwarding,
        // DEF-236: 画面を見せたまま待った数（入口の確かめは 1 画面だけなので、待たない）。
        waitUntilNextNavigationDue: async () => {
          pacingWaits += 1;
          return forwarding.waitUntilNextNavigationDue();
        },
      },
    }, { onRunStarted: (event) => started.push(event) });
    const text = outcome.kind === 'RAN' ? readFileSync(artifactFilePath(outcome.runDirectory, ENTRY_CHECK_ARTIFACT_FILE_NAME), 'utf8') : '';
    return { outcome, document: text === '' ? null : JSON.parse(text) as EntryCheckDocument, text, started, navigations, pacingWaits };
  };

  /** 成果物の確かめ（スキーマ、要約、1 回の読み込み）。 */
  const expectDocument = async (result: Run): Promise<EntryCheckDocument> => {
    expect(result.outcome.kind).toBe('RAN');
    const { document } = result;
    if (document === null || result.outcome.kind !== 'RAN') {
      throw new Error('no entry-check.json');
    }
    expect(await validateArtifact('entry-check', document)).toEqual({ ok: true });
    expect(document.jobId).toBe('job-entry-1');
    expect(document.runId).toBe(result.outcome.runId);
    expect(result.started.map(({ runId }) => runId)).toEqual([result.outcome.runId]);
    expect(result.navigations, 'navigations').toBe(1);
    expect(document.blockedRequests).toBe(0);
    return document;
  };

  itOnDefault('proposes the script request for the SPA login page with a form without an action (loads it once)', async () => {
    const site = await startSpaAuthSite();
    spaSites.push(site);
    const result = await run(configFor(site.appOrigin, SPA_APP_PATHS.auth));
    const document = await expectDocument(result);
    expect(document).toMatchObject({ runStatus: 'COMPLETE', endReason: 'READ', landing: { origin: site.appOrigin, path: SPA_APP_PATHS.auth, inAllowedOrigins: true } });
    expect(document.facts).toMatchObject({ loginPage: true, form: { placement: 'SAME', action: null, method: 'GET' } });
    expect(document.proposal).toEqual({
      loginStartUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`,
      sessionLostPathPrefix: SPA_APP_PATHS.auth,
      loginTransport: 'SCRIPT_REQUEST',
      loginPostEndpoint: null,
      selectors: { username: SPA_LOGIN_FIELDS.email, password: SPA_LOGIN_FIELDS.password, submit: SPA_LOGIN_FIELDS.submit },
    });
    expect(result.outcome.kind === 'RAN' ? result.outcome.summary : null).toEqual({ endReason: 'READ', loginPage: true, proposedSelectors: 3 });
    expect(site.requests.filter(({ path }) => pathnameOf(path) === SPA_APP_PATHS.auth), 'document requests').toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  itOnDefault('proposes the script request for the SPA login page without a form (loginLayout formless)', async () => {
    const site = await startSpaAuthSite({ loginLayout: 'formless' });
    spaSites.push(site);
    const result = await run(configFor(site.appOrigin, SPA_APP_PATHS.auth));
    const document = await expectDocument(result);
    expect(document.facts).toMatchObject({ loginPage: true, form: { placement: 'NONE', action: null, method: null } });
    expect(document.proposal).toMatchObject({
      loginTransport: 'SCRIPT_REQUEST',
      loginPostEndpoint: null,
      selectors: { username: SPA_LOGIN_FIELDS.email, password: SPA_LOGIN_FIELDS.password, submit: SPA_LOGIN_FIELDS.submit },
    });
    expect(site.requests.filter(({ path }) => pathnameOf(path) === SPA_APP_PATHS.auth), 'document requests').toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  itOnDefault('proposes the form submission and its endpoint for the form login page (the existing form login fixture)', async () => {
    const formUrl = new URL(loginFixture.formUrl('standard', 'success'));
    const before = loginFixture.requests.length;
    const result = await run(configFor(loginFixture.originA, `${formUrl.pathname}${formUrl.search}`));
    const document = await expectDocument(result);
    expect(document.facts).toMatchObject({
      loginPage: true,
      form: { placement: 'SAME', action: { origin: loginFixture.originA, path: loginFixture.authPath('success'), inAllowedOrigins: true }, method: 'POST' },
    });
    expect(document.proposal).toEqual({
      loginStartUrl: `${loginFixture.originA}${formUrl.pathname}`,
      sessionLostPathPrefix: formUrl.pathname,
      loginTransport: 'FORM_NAVIGATION',
      loginPostEndpoint: { origin: loginFixture.originA, path: loginFixture.authPath('success') },
      selectors: {
        username: AUTOMATED_LOGIN_FIXTURE_SELECTORS.username,
        password: AUTOMATED_LOGIN_FIXTURE_SELECTORS.password,
        submit: AUTOMATED_LOGIN_FIXTURE_SELECTORS.submit,
      },
    });
    expect(loginFixture.requests.slice(before).filter(({ path }) => pathnameOf(path) === formUrl.pathname), 'document requests').toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  itOnDefault('searches only in the form of the password field and never reads the values of the fields', async () => {
    const result = await run(configFor(entrySite.originA, ENTRY_CHECK_SITE_PATHS.prefilled));
    const document = await expectDocument(result);
    expect(document.facts?.fields).toEqual({
      username: { candidates: 1, selector: '#login-id' },
      password: { candidates: 1, selector: '#login-password' },
      submit: { candidates: 1, selector: '#login-submit' },
    });
    expect(document.proposal).toMatchObject({
      loginTransport: 'FORM_NAVIGATION',
      loginPostEndpoint: { origin: entrySite.originA, path: ENTRY_CHECK_SITE_PATHS.session },
    });
    for (const marker of Object.values(ENTRY_CHECK_VALUE_MARKERS)) {
      expect(result.text.includes(marker), marker).toBe(false);
    }
    expect(entrySite.requests.filter(({ path }) => pathnameOf(path) === ENTRY_CHECK_SITE_PATHS.prefilled), 'document requests').toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  itOnDefault('does not propose the selector of a field with two candidates (two password fields)', async () => {
    const result = await run(configFor(entrySite.originA, ENTRY_CHECK_SITE_PATHS.twoPasswords));
    const document = await expectDocument(result);
    expect(document.facts).toMatchObject({ loginPage: true, form: { placement: null } });
    expect(document.facts?.fields.password).toEqual({ candidates: 2, selector: null });
    expect(document.proposal?.selectors.password).toBeNull();
    expect(document.proposal?.loginTransport).toBeNull();
  }, TEST_TIMEOUT_MS);

  itOnDefault('hides a value-like segment of the landing path and does not propose the login start URL from it', async () => {
    const result = await run(configFor(entrySite.originA, ENTRY_CHECK_SITE_PATHS.valueLikeLogin));
    const document = await expectDocument(result);
    expect(document.landing).toEqual({ origin: entrySite.originA, path: `/invite/${REDACTED_PATH_SEGMENT}/login`, inAllowedOrigins: true });
    expect(document.proposal).toMatchObject({ loginStartUrl: null, sessionLostPathPrefix: null, loginTransport: 'FORM_NAVIGATION' });
    expect(result.text.includes('0123456789abcdef0123456789abcdef')).toBe(false);
  }, TEST_TIMEOUT_MS);

  // DEF-236（設計書 `2026-11-09-beaksight-visible-pacing-wait-design.md` 3.1 の 4・3.2）: 入口の確かめは 1 画面だけ読むので、その画面の後に読み込みの間隔を待たずに
  // 閉じる（最後の画面の後に待つと、結果が間隔の分だけ遅れる）。間隔のある設定で確かめる。
  itOnDefault('does not wait for the next load after the only page (the last page of the job)', async () => {
    const config = createTestConfig(entrySite.originA, ENTRY_CHECK_SITE_PATHS.valueLikeLogin, {
      audit: { screenshots: false },
      output: { directory: outputDirectory },
      crawl: { minNavigationIntervalMs: 5_000 },
    });
    const result = await run(config);
    await expectDocument(result);
    expect(result.pacingWaits).toBe(0);
  }, TEST_TIMEOUT_MS);

  it.each([
    ['a 302 to another origin', ENTRY_CHECK_SITE_PATHS.redirectOut],
    ['the page script moving to another origin after the load', ENTRY_CHECK_SITE_PATHS.scriptOut],
  ])('records only the other origin for %s, proposes nothing, and only the move reaches the other origin (SD-2)', async (_name, startPath) => {
    const result = await run(configFor(entrySite.originA, startPath));
    const document = await expectDocument(result);
    expect(document).toMatchObject({
      runStatus: 'COMPLETE',
      endReason: 'LEFT_ALLOWED_ORIGINS',
      landing: { origin: entrySite.originB, path: null, inAllowedOrigins: false },
      facts: null,
      proposal: null,
    });
    expect(result.text.includes(ENTRY_CHECK_SITE_PATHS.sso)).toBe(false);
    // SD-2: 外の Origin へは、移動の GET だけが届く（移った画面は読まない）。
    expect(entrySite.requests.filter(({ site, method }) => site === 'B' && method !== 'GET')).toEqual([]);
    expect(entrySite.requests.filter(({ path }) => pathnameOf(path) === startPath), 'document requests').toHaveLength(1);
  }, TEST_TIMEOUT_MS);
});

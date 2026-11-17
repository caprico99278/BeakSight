// L4（L0 につなぐ。設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: READ の確かめの段（`executeReadCheckRun`）は、構造の読み取りに期限を置かず、L0 の進み
// の見張りで包む。読み込みの後に固まる画面（ページの main thread が止まる）は、反応なしの長さの後に「応答しなかった」（`STAGE_UNRESPONSIVE`。判定できない）で
// 終え、ほかの定義へ進む。本物の factory と Guard、テストの既定の Chromium（headless）、127.0.0.1 の自前のサーバ（一般の文言）。反応なしの長さと落ち着きの
// 待ちは、テストだけ短くする。
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { WorkerStartReadCheck } from '../../src/control/worker-protocol.js';
import type { ReadEvidenceDocument } from '../../src/discovery/read-check-evaluation.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeReadCheckRun } from '../../src/worker/read-check-run.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 180_000;
const START_PATH = '/admin';
const FROZEN_PATH = '/admin/frozen';
const NORMAL_PATH = '/admin/normal';
/** テストの反応なしの長さ（ms。本番は `PROGRESS_WATCH_QUIET_LIMIT_MS`）。 */
const QUIET_LIMIT_MS = 4_000;
/** テストの落ち着きの待ち（短くする）。 */
const SETTLE_POLICY = Object.freeze({ timeoutMs: 1_500, networkQuietMs: 200, pollIntervalMs: 100, probeIntervalMs: 200 });
const noObserver = { onRunStarted: (): void => undefined, onSessionLost: (): void => undefined };

const html = (body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>example</title></head><body><main>${body}</main></body></html>`;

describe('L4: the READ check stage ends the read of a page that stops responding, and goes on to the other definitions', () => {
  let server: LoopbackHttpServer;
  let requests: { readonly method: string; readonly path: string }[];
  let outputDirectory = '';

  beforeEach(async () => {
    requests = [];
    outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-read-check-unresponsive-'));
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      requests.push({ method: request.method ?? '', path });
      response.writeHead(path.startsWith('/admin') ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      // 固まる画面: 読み込みの後に、ページの main thread を止める（何も描かず、通信もしない）。
      response.end(path === FROZEN_PATH
        ? html('<p>example frozen</p><script>setTimeout(() => { for (;;) { /* stop */ } }, 300);</script>')
        : html(`<p>example ${path}</p>`));
    });
  });

  afterEach(async () => {
    await server.close();
    await rm(outputDirectory, { recursive: true, force: true });
  });

  const pageCheck = (readCheckId: string, path: string): WorkerStartReadCheck => ({
    readCheckId,
    readCheckRevision: 1,
    targetPage: { origin: server.origin, path },
    definition: { targetPagePath: path, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'example' }] },
  });

  it('says STAGE_UNRESPONSIVE (UNDETERMINED) for the frozen page and MATCHED for the next one', async () => {
    const authentication: RunAuthentication = {
      initialState: { cookies: [], origins: [] },
      approvedTestOrigins: [server.origin],
      auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [START_PATH], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: '/login',
      filterState: filterAuthenticatedState,
    };
    const outcome = await executeReadCheckRun({
      config: createTestConfig(server.origin, START_PATH, { output: { directory: outputDirectory }, audit: { screenshots: false } }),
      jobId: 'job-read-unresponsive',
      authentication,
      readChecks: [pageCheck('read-frozen', FROZEN_PATH), pageCheck('read-normal', NORMAL_PATH)],
      launchBrowser: () => launchHeadlessChromium(),
      clock: () => new Date(),
      now: () => Date.now(),
      stopSignal: new AbortController().signal,
      settlePolicy: SETTLE_POLICY,
      progressQuietLimitMs: QUIET_LIMIT_MS,
    }, noObserver);
    if (outcome.kind !== 'RAN') {
      throw new Error(`the READ check did not run: ${outcome.kind}`);
    }
    const document: unknown = JSON.parse(readFileSync(join(outcome.runDirectory, 'read-evidence.json'), 'utf8'));
    expect(await validateArtifact('read-evidence', document)).toEqual({ ok: true });
    const read = document as ReadEvidenceDocument;
    expect(read.checks.map((check) => (check.state === 'EXECUTED' ? `${check.readCheckId} ${check.result}/${check.detail}` : check.state))).toEqual([
      'read-frozen UNDETERMINED/STAGE_UNRESPONSIVE',
      'read-normal MATCHED/EXPECTATIONS_EVALUATED',
    ]);
    expect(read.endReason).toBe('COMPLETED');
    expect(requests.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

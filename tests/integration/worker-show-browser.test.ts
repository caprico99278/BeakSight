// FM-2（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 2.2）: ワーカーが、`START` の `showJobBrowser` が真のときに、監査のジョブの Browser を
// headed で起動する（偽か省略は今どおり headless）。通す部品: ワーカーの流れ（`startAuditWorker`）、設定の読み込み（本物の `loadConfig`。一時のフォルダの
// ターゲット JSON）、監査の中核（本物の `executeAuditRun`）。Browser の起動の部品（`runDependencies.launchBrowser`）だけを差し替えて、渡された起動の引数を
// 覚え、起動せずに失敗させる（本物の画面は出さない）。一時のフォルダだけを使い、終わったら消す。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { executeAuditRun } from '../../src/cli/audit-run.js';
import { loadConfig } from '../../src/config/load-config.js';
import { WORKER_PROTOCOL_VERSION, targetConfigDigestOf, type WorkerToParentMessage } from '../../src/control/worker-protocol.js';
import { startAuditWorker, type AuditWorker } from '../../src/worker/audit-worker-session.js';
import { cliTargetConfig } from '../helpers/run-harness.js';

const TEST_TIMEOUT_MS = 30_000;
const WAIT_STEP_MS = 20;
const TARGET_CONFIG_PATH = 'config/targets/example-show-browser.json';

let workDirectory = '';
const workers: AuditWorker[] = [];

afterEach(() => {
  for (const worker of workers.splice(0)) worker.dispose();
  if (workDirectory !== '') rmSync(workDirectory, { recursive: true, force: true });
  workDirectory = '';
});

/** ワーカーを起動し、`START` を送って、Browser の起動の引数を受けるまで待つ。 */
const launchOptionsFor = async (item: Record<string, unknown>): Promise<readonly { readonly headless: boolean }[]> => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-worker-show-browser-'));
  const targetPath = join(workDirectory, 'target.json');
  const bytes = new TextEncoder().encode(JSON.stringify(cliTargetConfig('example-show-browser', 'http://127.0.0.1:9', '/', {
    output: { directory: join(workDirectory, 'output') },
  })));
  writeFileSync(targetPath, bytes);
  const sent: WorkerToParentMessage[] = [];
  const launches: { readonly headless: boolean }[] = [];
  const listeners: ((value: unknown) => void)[] = [];
  const worker = startAuditWorker({
    channel: {
      send: (message) => { sent.push(message); return Promise.resolve(true); },
      onMessage: (listener) => { listeners.push(listener); },
      onDisconnect: () => undefined,
    },
    stderr: { write: () => Promise.resolve() },
    exit: () => undefined,
    // 本物の読み込みを、一時のフォルダのターゲット JSON で行う（`START` の相対パスは受ける形のまま）。
    loadConfig: (_path, overrides) => loadConfig(targetPath, overrides),
    readTargetConfig: () => Promise.resolve(bytes),
    executeAuditRun,
    runDependencies: {
      launchBrowser: (options) => {
        launches.push({ headless: options.headless });
        return Promise.reject(new Error('the test does not launch a browser'));
      },
      clock: () => new Date(),
      now: () => Date.now(),
    },
  });
  workers.push(worker);
  await wait(0);
  for (const listener of listeners) {
    listener({
      protocol: WORKER_PROTOCOL_VERSION, type: 'START', jobId: 'job-show-browser', jobKind: 'AUDIT', targetConfigPath: TARGET_CONFIG_PATH,
      startNew: true, targetConfigSha256: targetConfigDigestOf(bytes), ...item,
    });
  }
  for (let waited = 0; launches.length === 0 && !sent.some(({ type }) => type === 'FAILED' || type === 'FINISHED') && waited < TEST_TIMEOUT_MS; waited += WAIT_STEP_MS) {
    await wait(WAIT_STEP_MS);
  }
  return launches;
};

describe('FM-2: the worker launches the job browser headed when START says so', () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    ['shown', { showJobBrowser: true }, false],
    ['not shown', { showJobBrowser: false }, true],
    ['absent (as before)', {}, true],
  ])('launches the audit browser with headless %s → %s', async (_label, item, headless) => {
    const launches = await launchOptionsFor(item);
    expect(launches).toEqual([{ headless }]);
  }, TEST_TIMEOUT_MS);
});

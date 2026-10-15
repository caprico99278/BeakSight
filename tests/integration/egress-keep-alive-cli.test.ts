// DEF-085 fix round 4（3 回目の独立レビュー T27R3 の I-1）: Passive の Context の出口の中継（`PASS_THROUGH`）が、keep-alive の同じクライアントの
// 接続の要求ごとに listener を積み増さないことを、本物の CLI（一時ディレクトリにビルドした `dist/cli/index.js` の `run`。127.0.0.1 の fixture の
// サーバだけ）で確かめる。修正の前は、同じ Origin の画像 60 枚のページで、CLI の標準エラーに `MaxListenersExceededWarning` が出た。
// - ページは `fixtures/site/many-images.html`（同じ Origin の画像を 60 枚。query を変えて、別々の要求にする）。
// - 確かめること: 終了コードが期限で止められていない、画像の要求がサーバに届いた、標準エラーに `MaxListenersExceededWarning` がない。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { runCliProcess, type CliProcessResult } from '../helpers/cli-process.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';

/** ビルドと、CLI の 1 回の Run を含む `beforeAll` の上限（ms）。 */
const SUITE_TIMEOUT_MS = 300_000;
const TARGET_ID = 'egress-keep-alive-cli';
const IMAGES_PAGE = '/many-images.html';
const IMAGE_PATH = '/external-image.svg';
/** ページの画像の枚数（`fixtures/site/many-images.html`）。 */
const IMAGE_COUNT = 60;
/** listener の積み増しの警告の名前。 */
const MAX_LISTENERS_WARNING = 'MaxListenersExceededWarning';

let server: FixtureServer;
let build: TemporaryBuild;
let workDirectory: string;
let result: CliProcessResult;
let imageRequests = 0;

beforeAll(async () => {
  server = await startFixtureServer();
  build = await buildIntoTemporaryDirectory();
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-egress-keep-alive-'));
  const configPath = join(workDirectory, 'config.json');
  // 製品の既定値のまま、`site` と、ページの読み込みの最小の間隔（0。対象はループバックの fixture のサーバ）だけを変える。
  await writeFile(configPath, JSON.stringify({
    target: { id: TARGET_ID },
    site: { startUrl: `${server.origin}${IMAGES_PAGE}`, allowedOrigins: [server.origin] },
    crawl: { minNavigationIntervalMs: 0 },
  }), 'utf8');
  server.resetRequestObservations();
  // 厳守事項: Chromium は headless だけで起動する（`--headless` を必ず付ける）。
  result = await runCliProcess(build, workDirectory, ['run', '--config', configPath, '--output', join(workDirectory, 'output'), '--headless']);
  imageRequests = server.getRequestObservations().filter(({ pathname }) => pathname === IMAGE_PATH).length;
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  await build?.remove();
  await server?.close();
  if (workDirectory !== undefined) {
    await rm(workDirectory, { recursive: true, force: true });
  }
});

describe('DEF-085 fix round 4: the egress proxy does not pile up listeners on keep-alive connections in the real CLI (T27R3 I-1)', () => {
  it('audits the page with 60 images, and prints no MaxListenersExceededWarning on the standard error', () => {
    const warningLines = result.stderr.split(/\r?\n/u).filter((line) => line.includes(MAX_LISTENERS_WARNING));
    console.info(`DEF-085 I-1 CLI run: ${JSON.stringify({ status: result.status, imageRequests, warningLines })}`);
    expect(result.killedByLimit).toBe(false);
    expect(imageRequests).toBeGreaterThanOrEqual(IMAGE_COUNT);
    expect(warningLines).toEqual([]);
  });
});

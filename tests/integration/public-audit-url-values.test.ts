// T44g（Task 44 の設計書 P4-1 と、設計の変更の履歴の「T44g の Blocker」の行。案 2）: 公開の監査（認証のない Run）の成果物に、URL の値の目印が残らない。
// 自前の 127.0.0.1 のサーバのページが、成功する subresource の要求（fetch）の query に目印の値を入れ、秘密に見える名前（`token`）の query に別の目印を持つ
// リンクを置く。CLI の Run（`executeAuditRun`。書き手の選び方は製品と同じ）の Run のディレクトリのすべてのファイル（page.json・audit.json・run.json・
// report.html・バンドルの中身・保存）に、どちらの目印も出ない。要求そのものはサーバに目印つきで届く（判定と送信は値ごと行い、伏せるのは記録の前だけ）。
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeAuditRun } from '../../src/cli/audit-run.js';
import { REDACTED } from '../../src/core/redaction.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { fastRunConfig, findTextOccurrences, readRunArtifactFiles } from '../helpers/run-harness.js';

const TEST_TIMEOUT_MS = 180_000;
/** 成功する subresource の要求の query の目印（ページのスクリプトが実行の時に組み立てる。HTML には、つないだ形では書かない）。 */
const SUBRESOURCE_MARKER = 'subresource-mark-7q4';
const SUBRESOURCE_MARKER_PARTS = SUBRESOURCE_MARKER.split('-');
/** 秘密に見える名前（`token`）の query の目印（リンクの生の URL に入る。巡回の正規化で query を落とすので、ページの URL には入らない）。 */
const SECRET_NAME_MARKER = 'secretname-mark-9k2';
const DATA_PATH = '/api/data';

const PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>トップ</title></head><body>
<main><h1>トップ</h1><p><a href="/next?token=${SECRET_NAME_MARKER}">次のページ</a></p></main>
<script>
const value = ${JSON.stringify(SUBRESOURCE_MARKER_PARTS)}.join('-');
fetch('${DATA_PATH}?marker=' + value + '&page=1').then((response) => response.text()).catch(() => undefined);
</script></body></html>`;
const NEXT_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>次</title></head><body><main><h1>次</h1></main></body></html>';

describe('T44g: the public audit artifacts keep no URL values of the recorded requests (P4-1)', () => {
  let server: LoopbackHttpServer;
  const received: string[] = [];

  beforeAll(async () => {
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      received.push(`${request.method ?? 'GET'} ${url.pathname}${url.search}`);
      if (url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE_HTML);
      } else if (url.pathname === '/next') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(NEXT_HTML);
      } else if (url.pathname === DATA_PATH) {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      } else {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      }
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  it('writes no marker of a successful subresource request query and of a secret-like query name anywhere in the Run directory', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-t44g-public-'));
    try {
      const config = fastRunConfig(server.origin, '/', { output: { directory: outputDirectory } });
      const outcome = await executeAuditRun(config, {
        launchBrowser: () => launchHeadlessChromium(), clock: () => new Date(), now: () => Date.now(),
      }, { startNew: true }, {});
      expect(outcome.kind).toBe('RAN');
      if (outcome.kind !== 'RAN') {
        return;
      }
      // 要求は、値ごとサーバに届いた（送信は変えない）。
      expect(received, JSON.stringify(received)).toContain(`GET ${DATA_PATH}?marker=${SUBRESOURCE_MARKER}&page=1`);
      // リンクの先は、巡回の正規化で許した名前のほかの query を落として読む（`/next`）。目印は、リンクの Evidence の生の URL に入る。
      expect(received).toContain('GET /next');
      const files = await readRunArtifactFiles(outcome.runDirectory);
      expect(files.some(({ path }) => path.endsWith('report.html'))).toBe(true);
      expect(findTextOccurrences(files, [SUBRESOURCE_MARKER, SECRET_NAME_MARKER])).toEqual([]);
      // network の Evidence には、名前を残して値を伏せた URL が残る。
      expect(findTextOccurrences(files, [`${DATA_PATH}?marker=${REDACTED}&page=${REDACTED}`]).length).toBeGreaterThan(0);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});

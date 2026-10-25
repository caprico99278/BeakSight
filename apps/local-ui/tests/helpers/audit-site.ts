/**
 * 画面から動かす監査のテストの補助（T24f）。
 * - 127.0.0.1 の小さな fixture のサイト（`fixtures/site/crawl/` の 5 ページ。`/robots.txt` と `/sitemap.xml` は 404）。届いた要求のメソッド、
 *   パス、届いた時刻を記録する（`fixtures/server.ts` の記録には時刻がないので、ページの読み込みの間隔を確かめるために、テストの中だけの
 *   サーバで記録する。`tests/integration/navigation-pacing.test.ts` と同じ考え方）。WebSocket の upgrade と CONNECT も記録する。
 * - 一時の root に、ターゲット設定（`config/targets/<name>.json`）を書く。出力先は一時の root の中（`t24f-output-<name>`）。
 * - 外部には繋がない（サイトも画面のサーバも 127.0.0.1）。
 */
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startLoopbackHttpServer } from '../../../../tests/helpers/loopback-server.js';
import { REPO_ROOT } from './local-server.ts';

/** fixture のサイトで配るページ（`fixtures/site/crawl/` の中）。 */
const SITE_DIRECTORY = `${REPO_ROOT}/fixtures/site/crawl`;
/** 配るパスの接頭辞。 */
const CRAWL_PREFIX = '/crawl/';
/** 開始のページ。 */
export const START_PATH = '/crawl/index.html';
/** fixture のサイトの応答の状態。 */
const SITE_STATUS = Object.freeze({ OK: 200, NOT_FOUND: 404 } as const);
/** HTML のページの名前（`fixtures/site/crawl/` の中のファイル）。 */
const PAGE_NAME_PATTERN = /^[a-z0-9-]+\.html$/u;

/** 届いた要求の記録。 */
export interface SiteRequest {
  /** HTTP のメソッド。upgrade と CONNECT は、それぞれ `UPGRADE`、`CONNECT`。 */
  readonly method: string;
  readonly pathname: string;
  /** 届いた時刻（`Date.now()`）。 */
  readonly atMs: number;
}

/** 起動した fixture のサイト。 */
export interface TimedSite {
  readonly origin: string;
  readonly requests: () => readonly SiteRequest[];
  readonly close: () => Promise<void>;
}

/** fixture のサイトを 127.0.0.1 の空きの port で起動する。 */
export const startTimedSite = async (): Promise<TimedSite> => {
  const requests: SiteRequest[] = [];
  const server = await startLoopbackHttpServer((request, response) => {
    const pathname = (request.url ?? '/').split(/[?#]/u, 1)[0] ?? '/';
    requests.push({ method: request.method ?? '', pathname, atMs: Date.now() });
    const name = pathname.startsWith(CRAWL_PREFIX) ? pathname.slice(CRAWL_PREFIX.length) : '';
    if (!PAGE_NAME_PATTERN.test(name)) {
      response.writeHead(SITE_STATUS.NOT_FOUND, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found\n');
      return;
    }
    void readFile(`${SITE_DIRECTORY}/${name}`, 'utf8').then((body) => {
      response.writeHead(SITE_STATUS.OK, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : body);
    }, () => {
      response.writeHead(SITE_STATUS.NOT_FOUND, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found\n');
    });
  });
  server.server.on('upgrade', (request, socket) => {
    requests.push({ method: 'UPGRADE', pathname: request.url ?? '', atMs: Date.now() });
    socket.destroy();
  });
  server.server.on('connect', (request, socket) => {
    requests.push({ method: 'CONNECT', pathname: request.url ?? '', atMs: Date.now() });
    socket.destroy();
  });
  return {
    origin: server.origin,
    requests: () => [...requests],
    close: () => server.close(),
  };
};

/** ターゲット設定の指定。 */
export interface AuditTargetOptions {
  /** ページの読み込みの最小の間隔（ms）。 */
  readonly minNavigationIntervalMs: number;
  /** スクリーンショットを撮るか。 */
  readonly screenshots: boolean;
  /** accessibility と Interaction の監査を行うか（既定は行わない。T24g の CLI と画面の比べで使う）。 */
  readonly accessibilityAndInteractions?: boolean;
  /** T44e: ページの上限（省くと既定値。上限で止まる Run の理由を確かめるときに小さくする）。 */
  readonly maxPages?: number;
  /** T44g: URL の正規化で残す query の名前（省くと既定値。秘密に見える名前で始めない理由を確かめるときに渡す）。 */
  readonly allowedQueryParameters?: readonly string[];
}

/** 一時の root の中の、出力先（一時の root からの相対）。 */
export const outputDirectoryOf = (name: string): string => `t24f-output-${name}`;

/** 一時の root からの、ターゲット設定の相対パス。 */
export const targetConfigPathOf = (name: string): string => `config/targets/${name}.json`;

/**
 * 一時の root に、fixture のサイトを監査するターゲット設定を書く（target の ID は `name`。幅の走査、performance、accessibility、
 * Interaction は省いて短くする。出力先は一時の root の中）。
 */
export const writeAuditTargetConfig = (root: string, name: string, origin: string, options: AuditTargetOptions): string => {
  const path = targetConfigPathOf(name);
  mkdirSync(`${root}/config/targets`, { recursive: true });
  writeFileSync(`${root}/${path}`, `${JSON.stringify({
    target: { id: name },
    site: { startUrl: `${origin}${START_PATH}`, allowedOrigins: [origin] },
    crawl: {
      minNavigationIntervalMs: options.minNavigationIntervalMs,
      ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
      ...(options.allowedQueryParameters === undefined ? {} : { allowedQueryParameters: [...options.allowedQueryParameters] }),
    },
    viewports: { stressWidths: [] },
    audit: {
      performance: false,
      accessibility: options.accessibilityAndInteractions === true,
      interactions: options.accessibilityAndInteractions === true,
      screenshots: options.screenshots,
    },
    output: { directory: outputDirectoryOf(name) },
  }, null, 2)}\n`, 'utf8');
  return path;
};

/** 公開の監査のプロファイルの文書（改訂 1）。 */
export const publicProfileDocument = (profileId: string, targetConfigPath: string): Record<string, unknown> => ({
  schemaVersion: 'beaksight-profile/1',
  profileId,
  revision: 1,
  targetConfigPath,
  environment: 'PUBLIC',
  mode: 'PUBLIC_PASSIVE',
  auth: 'NONE',
  approvedTestOrigins: [],
  environmentEvidenceRef: null,
});

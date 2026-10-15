/**
 * ローカルの管理画面（TanStack Start）の Vite の設定（Task 23 設計書 4.2、4.4、11 章の T23b、T23e の行。T23f）。
 * - 待ち受けは 127.0.0.1 だけ。port が使用中なら別の port を選ばずに止める（`strictPort`）。
 * - `allowedHosts` は既定（空）のまま変えない。要求の守りの部品（`launcher/vite-guard-plugin.ts`）が、Host を `127.0.0.1:<port>` に限る。
 * - 開発のサーバにも、本番と同じ要求の守り（Host、token と cookie、応答の header、CSP の nonce）を掛ける（plugin の先頭）。
 *   開発のサーバは、待ち受けを始めたときに管理データを準備する（失敗したら説明を出して止まる）。
 * - `server.fs.allow` を、ブラウザが実際に読み込む範囲（`apps/local-ui`、`src/presentation`、`src/core`、`src/control`、依存の
 *   `node_modules`）に絞る。`src/config` の部品はサーバの側だけで使う（ブラウザへは配らない）ので足さない。
 * - `server.fs.deny` は、Vite の既定の一覧を「置き換える」（足し合わせない。Vite 8.2.4 の `mergeWithDefaults` は配列を上書きする）。
 *   そのため、既定の一覧を書き写したうえで、`local/`、`artifacts/`、`local-data/`、`.git` を絶対パスで足す。
 * - Vite の preview（`vite preview`）は使わない（守りの plugin が起動を止める。画面は `npm run ui` の起動の部品で動かす）。そのため `preview`
 *   の節は置かない（T23i）。
 * - SSR のビルドに 2 つ目の入口（`launcher-bridge`）を足す。本番の起動の部品が、待ち受けの前に管理データを準備するために読む。
 * - 開発のサーバも、監査のジョブの管理を準備し、終わりのときに動いているジョブを止める（`jobsModule`。T24f）。
 */
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { AUDIT_JOB_SHUTDOWN_WAIT_MS } from '../../src/control/job/job-records.js';
import { formatCount, formatDuration } from '../../src/presentation/format.js';
import {
  LOCAL_UI_CONSOLE_TEXT,
  LOCAL_UI_GUARD_REJECTION_TEXT,
  LOCAL_UI_JOB_CONSOLE_TEXT,
  describeLocalUiStartFailure,
} from '../../src/presentation/messages.js';
import { controlSchemasPlugin } from './build-tools/control-schemas-plugin.ts';
import { localUiGuardPlugin } from './launcher/vite-guard-plugin.ts';

/** この設定のフォルダ（`apps/local-ui/`）。Vite の root にする。 */
const APP_ROOT = fileURLToPath(new URL('./', import.meta.url));

/** リポジトリの root（`/` 区切り、末尾の `/` なし）。fs の allow と deny の絶対パスに使う。 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');

/** 依存のパッケージの実際の置き場所（`node_modules`。symlink の先の実際のパス）。`/@fs/` で配ってよい範囲に入れる。 */
const NODE_MODULES_DIRECTORY = dirname(dirname(createRequire(import.meta.url).resolve('vite/package.json'))).replaceAll('\\', '/');

/** ビルドの出力のフォルダ。 */
const DISTRIBUTION_DIRECTORY = `${APP_ROOT}dist`;

/** Vite 8.2.4 の `server.fs.deny` の既定の一覧（設定すると置き換わるため書き写す）。 */
const VITE_DEFAULT_FS_DENY = ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**'] as const;

/** 開発のサーバで配らない、リポジトリの中のフォルダ（Task 23 設計書 4.4）。 */
const REPO_PRIVATE_DIRECTORIES = ['local', 'artifacts', 'local-data', '.git'] as const;

/** ブラウザが実際に読み込む、`src/` の中のフォルダ（`/@fs/` で配ってよい範囲）。 */
const UI_IMPORTED_SRC_DIRECTORIES = ['src/presentation', 'src/core', 'src/control'] as const;

export default defineConfig({
  root: APP_ROOT,
  plugins: [
    localUiGuardPlugin({
      rejectionText: LOCAL_UI_GUARD_REJECTION_TEXT,
      consoleText: LOCAL_UI_CONSOLE_TEXT,
      describeStartFailure: describeLocalUiStartFailure,
      storeModule: '/src/server/control-store.ts',
      jobsModule: '/src/server/audit-jobs.ts',
      jobConsoleText: {
        jobsStopping: LOCAL_UI_JOB_CONSOLE_TEXT.jobsStopping(formatDuration(AUDIT_JOB_SHUTDOWN_WAIT_MS)),
        exitingNow: LOCAL_UI_JOB_CONSOLE_TEXT.exitingNow,
        recoveredJobs: (count) => LOCAL_UI_JOB_CONSOLE_TEXT.recoveredJobs(formatCount(count)),
      },
    }),
    tanstackStart(),
    viteReact(),
    controlSchemasPlugin(REPO_ROOT, DISTRIBUTION_DIRECTORY),
  ],
  server: {
    host: '127.0.0.1',
    strictPort: true,
    fs: {
      strict: true,
      allow: [APP_ROOT, ...UI_IMPORTED_SRC_DIRECTORIES.map((directory) => `${REPO_ROOT}/${directory}`), NODE_MODULES_DIRECTORY],
      deny: [
        ...VITE_DEFAULT_FS_DENY,
        ...REPO_PRIVATE_DIRECTORIES.flatMap((directory) => [`${REPO_ROOT}/${directory}`, `${REPO_ROOT}/${directory}/**`]),
      ],
    },
  },
  environments: {
    ssr: {
      build: {
        rollupOptions: {
          input: { server: 'virtual:tanstack-start-server-entry', 'launcher-bridge': `${APP_ROOT}src/server/launcher-bridge.ts` },
        },
      },
    },
  },
});

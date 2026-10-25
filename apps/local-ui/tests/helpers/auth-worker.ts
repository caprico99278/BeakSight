/**
 * 画面から動かす認証つきの監査のテストの補助（Task 25 の設計書 4.4、4.5。T25e）。
 * - 監査のワーカーの入口の差し替え: 一時の root の `dist/worker/audit-worker.js`（画面のサーバが fork する入口。リポジトリの `dist/` ではない）を、
 *   テストだけの入口に書き換える。本番の process の組み立て（`runAuditWorkerProcess`）を、テストだけの口（関数の引数。T25d）で、ログイン用の
 *   Browser を CLI の起動の設定の headless に替え、待つ時間を短くして呼ぶ。監査の Browser は、本番と同じく headless。本番の入口は変えない
 *   （`tests/integration/audit-worker-auth-fork.test.ts` と同じ考え方。入口の本文は、`tests/helpers/test-login-worker-entry.ts` を共用する。CCX-23）。
 * - 人の操作の代わり: テストだけの入口は、ログインの画面を開いたら、テストの process の 127.0.0.1 の受け渡しのサーバ（`startCredentialRelay`）に
 *   資格情報を取りに行き、欄に入れて送る。受け渡しのサーバは、テストが `provide` するまで応答を待たせる（その間、画面は「ログイン待ち」）。
 *   資格情報は、ファイルにも環境変数にも書かない（入口のファイルに書くのは、受け渡しのサーバの URL だけ）。値を出力しない。
 * - 一時の root に、認証つきの fixture のサイト（`tests/helpers/authenticated-site-fixture.ts`）を監査するターゲット設定を書く。
 * - T25f（秘密の目印の検査）: 記録のフォルダを渡すと、テストだけの入口は、ワーカーが親へ送ったメッセージのすべて（`ipc.jsonl`）と、ワーカーの
 *   標準出力（`stdout.log`）と標準エラー（`stderr.log`）を、そのフォルダに書き足す（画面のサーバはワーカーの標準出力と標準エラーを捨てるので、
 *   テストだけの入口で写す）。本番の入口は変えない。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { startLoopbackHttpServer } from '../../../../tests/helpers/loopback-server.js';
import { testLoginWorkerEntrySource } from '../../../../tests/helpers/test-login-worker-entry.js';

/** 画面のサーバが fork する、一時の root の中の監査のワーカーの入口（`localUiWorkerPath` の写しの場所）。 */
const WORKER_ENTRY_PATH = 'dist/worker/audit-worker.js';
/** 入口（`dist/worker/` の中）から見た、ビルドの `dist/` の場所。 */
const WORKER_ENTRY_DIST_PREFIX = '../';

/** T25f: テストだけの入口が書き足す記録のファイルの名前（ワーカーが親へ送ったメッセージ、標準出力、標準エラー）。 */
export const WORKER_RECORD_FILES = Object.freeze({ ipc: 'ipc.jsonl', stdout: 'stdout.log', stderr: 'stderr.log' } as const);

/** 受け渡しのサーバのパス。 */
const RELAY_PATH = '/credentials';

const STATUS_OK = 200;
const STATUS_NOT_FOUND = 404;

/**
 * T25f: テストだけの入口の、記録の部分（`__RECORDS__` を、記録のフォルダに置き換える）。`process.send` と、標準出力と標準エラーの `write` を包み、
 * 送ったメッセージと書いた中身を、記録のフォルダのファイルに書き足してから、元の関数に渡す。
 */
const RECORDING_SOURCE = String.raw`
import { appendFileSync } from 'node:fs';
const RECORD_DIRECTORY = __RECORDS__;
const record = (name, chunk) => appendFileSync(RECORD_DIRECTORY + '/' + name, chunk);
if (typeof process.send === 'function') {
  const send = process.send.bind(process);
  process.send = (message, ...rest) => {
    record('${WORKER_RECORD_FILES.ipc}', JSON.stringify(message) + '\n');
    return send(message, ...rest);
  };
}
for (const [name, file] of [['stdout', '${WORKER_RECORD_FILES.stdout}'], ['stderr', '${WORKER_RECORD_FILES.stderr}']]) {
  const stream = process[name];
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    record(file, typeof chunk === 'string' ? chunk : Buffer.from(chunk));
    return write(chunk, ...rest);
  };
}
`;

/**
 * 一時の root の監査のワーカーの入口を、テストだけの入口に書き換える。`recordDirectory` を渡すと（T25f）、ワーカーが親へ送ったメッセージと、標準出力と
 * 標準エラーを、そのフォルダ（`WORKER_RECORD_FILES` の名前）に書き足す入口にする。T27g: `options` で、親から受けたメッセージの記録と、テストだけの
 * 本文を足せる（`recordDirectory` を渡したときだけ。渡さなければ、今までと同じ入口）。自動ログインのプロファイルのジョブは、この入口でも、自動ログインの
 * 段を本番のまま（資格情報のファイルの部品も本番の既定）で動かす（入口が替えるのは、手動のログインの段の口だけ）。
 */
export const installTestAuthWorkerEntry = (
  root: string,
  relayUrl: string,
  loginTimeoutMs: number,
  recordDirectory?: string,
  options: AutomatedLoginWorkerEntryOptions = {},
): void => {
  const recording = recordDirectory === undefined ? '' : [
    RECORDING_SOURCE.split('__RECORDS__').join(JSON.stringify(recordDirectory)),
    options.recordParentMessages === true ? PARENT_MESSAGE_RECORDING_SOURCE : '',
    options.prelude ?? '',
  ].join('');
  // 本文は、ワーカーの fork の結合テストと共用する（CCX-23。CC-061）。資格情報は、ログインの画面を開いてから受け渡しのサーバに取りに行く。
  const source = testLoginWorkerEntrySource({
    distPrefix: WORKER_ENTRY_DIST_PREFIX,
    loginTimeoutMs,
    prelude: recording,
    credentialsExpression: `fetch(${JSON.stringify(relayUrl)}).then((response) => response.json())`,
    // TS-g: 画面のテストのジョブのブラウザは headless（`local-server.ts` の入口と同じテストだけの口。プロファイルの表示の設定の既定は表示）。
    additionalHooks: '\n  hideJobBrowser: true,',
  });
  writeFileSync(`${root}/${WORKER_ENTRY_PATH}`, source, 'utf8');
};

/** 資格情報の 1 組（欄のセレクタと値の組と、送るボタンのセレクタ）。 */
export interface RelayedCredentials {
  readonly fields: readonly (readonly [string, string])[];
  readonly submit: string;
}

/** 資格情報の受け渡しのサーバ。 */
export interface CredentialRelay {
  readonly url: string;
  /** 取りに来た回数（応答したかどうかを問わない）。 */
  readonly requested: () => number;
  /** 1 組を渡す（取りに来ていれば、すぐに応答する。まだなら、次に来たときに応答する）。 */
  readonly provide: (credentials: RelayedCredentials) => void;
  readonly close: () => Promise<void>;
}

/** 127.0.0.1 の空きの port で、資格情報の受け渡しのサーバを起動する。 */
export const startCredentialRelay = async (): Promise<CredentialRelay> => {
  const waiting: ServerResponse[] = [];
  const ready: RelayedCredentials[] = [];
  let requested = 0;
  const answer = (response: ServerResponse, credentials: RelayedCredentials): void => {
    response.writeHead(STATUS_OK, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(credentials));
  };
  const server = await startLoopbackHttpServer((request, response) => {
    if (request.method !== 'GET' || request.url !== RELAY_PATH) {
      response.writeHead(STATUS_NOT_FOUND);
      response.end();
      return;
    }
    requested += 1;
    const credentials = ready.shift();
    if (credentials === undefined) {
      waiting.push(response);
    } else {
      answer(response, credentials);
    }
  });
  return {
    url: `${server.origin}${RELAY_PATH}`,
    requested: () => requested,
    provide: (credentials) => {
      const response = waiting.shift();
      if (response === undefined) {
        ready.push(credentials);
      } else {
        answer(response, credentials);
      }
    },
    close: () => {
      for (const response of waiting.splice(0)) {
        response.destroy();
      }
      return server.close();
    },
  };
};

/** 一時の root からの、ターゲット設定の相対パス。 */
export const authTargetConfigPathOf = (name: string): string => `config/targets/${name}.json`;

/**
 * 一時の root に、認証つきの fixture のサイトの管理画面（`startPath`）から監査するターゲット設定を書く（幅の走査、performance、accessibility、
 * Interaction、スクリーンショットは省いて短くする。出力先は一時の root の中）。T27g: `minNavigationIntervalMs` で読み込みの最小の間隔を指定できる
 * （省略は 0。今までと同じ）。
 */
export const writeAuthTargetConfig = (
  root: string,
  name: string,
  origin: string,
  startPath: string,
  maxPages: number,
  minNavigationIntervalMs = 0,
): string => {
  const path = authTargetConfigPathOf(name);
  mkdirSync(`${root}/config/targets`, { recursive: true });
  writeFileSync(`${root}/${path}`, `${JSON.stringify({
    target: { id: name },
    site: { startUrl: `${origin}${startPath}`, allowedOrigins: [origin] },
    crawl: { minNavigationIntervalMs, maxPages },
    viewports: { stressWidths: [] },
    audit: { performance: false, accessibility: false, interactions: false, screenshots: false },
    output: { directory: `t25e-output-${name}` },
  }, null, 2)}\n`, 'utf8');
  return path;
};

/**
 * T26e（Task 26 の設計書 4.6、6 章）: 自動ログインのジョブ（ログインの確かめ）のための、テストだけの入口。本番の process の組み立て
 * （`runAuditWorkerProcess`）を、自動ログインの段は本番のまま（資格情報のファイルの部品も、Browser の起動も本番の既定。headless）で呼ぶ。手動の
 * ログインの段の口が呼ばれたら、記録のフォルダの `manual-login-stage.log` に書いて止める（自動ログインが手動へ切り替えないことの確かめ）。記録の
 * フォルダには、ワーカーが親へ送ったメッセージと、標準出力と標準エラーも書き足す（`WORKER_RECORD_FILES`）。資格情報の値は、入口に書かない。
 * TS-g: ジョブのブラウザは headless（テストだけの口 `hideJobBrowser`。Gate `ui-test-job-browser-hidden`）。
 */
const AUTOMATED_ENTRY_SOURCE = String.raw`
__RECORDING__
import { appendFileSync as appendManualRecord } from 'node:fs';
import { runAuditWorkerProcess } from './audit-worker-process.js';
const MANUAL_RECORD = __MANUAL__;
runAuditWorkerProcess(process, {
  loginStage: {
    launchLoginBrowser: async () => {
      appendManualRecord(MANUAL_RECORD, 'launchLoginBrowser\n');
      throw new Error('the manual login stage must not run');
    },
    onLoginPageReady: async () => appendManualRecord(MANUAL_RECORD, 'onLoginPageReady\n'),
  },
  hideJobBrowser: true,
});
`;

/** T26e: 手動のログインの段が呼ばれたときに書く記録のファイルの名前。 */
export const MANUAL_LOGIN_STAGE_RECORD = 'manual-login-stage.log';

/** T26f: 親から受けたメッセージ（`START` など）を書き足す記録のファイルの名前。 */
export const WORKER_PARENT_MESSAGE_RECORD = 'ipc-from-parent.jsonl';

/** T26f: 親から受けたメッセージを、記録のフォルダに書き足す本文（`RECORDING_SOURCE` の `record` を使う）。 */
const PARENT_MESSAGE_RECORDING_SOURCE = String.raw`
process.on('message', (message) => record('${WORKER_PARENT_MESSAGE_RECORD}', JSON.stringify(message) + '\n'));
`;

/** T26f: 自動ログインのテストだけの入口に足す記録。 */
export interface AutomatedLoginWorkerEntryOptions {
  /** 親から受けたメッセージ（`START` を含む）を、記録のフォルダの `WORKER_PARENT_MESSAGE_RECORD` に書き足す。 */
  readonly recordParentMessages?: boolean;
  /** 記録の部分の後に足す、テストだけの本文（ESM。子プロセスの起動の記録など）。 */
  readonly prelude?: string;
}

/**
 * T26e: 一時の root の監査のワーカーの入口を、自動ログインのテストだけの入口に書き換える（記録は `recordDirectory`）。T26f: `options` で、親から
 * 受けたメッセージの記録と、テストだけの本文を足せる（渡さなければ、T26e と同じ入口）。
 */
export const installTestAutomatedLoginWorkerEntry = (root: string, recordDirectory: string, options: AutomatedLoginWorkerEntryOptions = {}): void => {
  mkdirSync(recordDirectory, { recursive: true });
  const recording = [
    RECORDING_SOURCE.split('__RECORDS__').join(JSON.stringify(recordDirectory)),
    options.recordParentMessages === true ? PARENT_MESSAGE_RECORDING_SOURCE : '',
    options.prelude ?? '',
  ].join('');
  const source = AUTOMATED_ENTRY_SOURCE
    .split('__RECORDING__').join(recording)
    .split('__MANUAL__').join(JSON.stringify(`${recordDirectory}/${MANUAL_LOGIN_STAGE_RECORD}`));
  writeFileSync(`${root}/${WORKER_ENTRY_PATH}`, source, 'utf8');
};

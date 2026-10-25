// CC-095（T36c）: ワーカーの fork のテスト（スクリプトで送るログインの手動のログイン `script-login-worker-fork`、SPA の監査 `spa-audit-worker-fork`、
// スクリプトで送るログインの自動ログイン `automated-script-login-fork`）の共通の補助（テストのファイルではない）。テストのファイルに書き写さない。
// - 標準入力の資格情報の準備（テストだけの入口の `prelude` と `credentialsExpression`）。
// - process とその子孫（Chromium）の一覧（`processTreeOf`）と、状態を待つ（`waitForValue`）。
// - fork のテストのプロファイル（版の決まった欄を埋める `createForkTestProfile`）。
// - Run の成果物の読み取り（`readRunArtifacts`。ZIP の中身を除いた `run.json` と `page.json`、見えている文字。目印の検査は ZIP の中身を含む `places`）。
// - 記録つきの fork（`createRecordingFork`。CC-097。PRE42-CC の組 6a）: ジョブの管理に渡す、ワーカーを起動する関数。IPC の受けたものと送ったもの、
//   標準出力と標準エラーを記録し、標準入力に資格情報などを渡す。戻りは Gate `fork-test-helper-reuse` が止める。
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import type { AuditConfig } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import { MIN_PROFILE_REVISION, SITE_PROFILE_SCHEMA_VERSION, type AuthStrategy } from '../../src/control/contracts.js';
import type { AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import type { ControlDatabase } from '../../src/control/store/control-database.js';
import { createProfile, saveProfileDisplaySettings } from '../../src/control/store/profile-store.js';
import type { RunSummary } from '../../src/core/contracts.js';
import { filesUnder, ZIP_ENTRY_PLACE_SEPARATOR, type LeakPlace } from './leak-places.js';
import { descendantsOf, listProcesses, type ProcessIdentity } from './process-tree.js';

/** テストだけの入口の、資格情報の読み取りの準備（標準入力から受ける）。 */
export const STDIN_CREDENTIALS_PRELUDE = String.raw`
const credentials = new Promise((resolve) => {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { text += chunk; });
  process.stdin.on('end', () => resolve(JSON.parse(text)));
});
`;
/** 上の準備が作る、資格情報の組の式。 */
export const STDIN_CREDENTIALS_EXPRESSION = 'credentials';

/** 記録つきの fork の口（CC-097）。省いた口は、記録しない。 */
export interface RecordingForkHooks {
  /** 起動する入口（テストだけの入口の `.mjs`）。省略は、ジョブの管理が渡したワーカーのパス。 */
  readonly entry?: string;
  /** 起動のたびに、標準入力に書いて閉じる本文。省略は、標準入力を開かない（`ignore`）。 */
  readonly stdinText?: () => string;
  /** 起動した子（後片付けと、process の一覧のため）。 */
  readonly onChild?: (child: ChildProcess) => void;
  /** 子から受けたメッセージ（ジョブの管理の受け手より先に呼ばれる）。 */
  readonly onReceived?: (message: unknown) => void;
  /** 標準出力と標準エラーの文字。省略は、読み捨てる。 */
  readonly onOutput?: (chunk: string) => void;
  /** 親が子へ送ったメッセージ（送る前に呼ぶ）。省略は、`send` を包まない。 */
  readonly onSent?: (message: unknown) => void;
}

/**
 * ジョブの管理に渡す、記録つきの fork（CC-097）。ジョブの管理が渡した起動の設定に、標準入力・標準出力・標準エラーの pipe だけを替えて起動する
 * （標準入力は `stdinText` があるときだけ pipe）。
 */
export const createRecordingFork = (hooks: RecordingForkHooks): AuditWorkerForker => (modulePath, args, options: ForkOptions) => {
  const { stdinText, onSent, onReceived, onOutput } = hooks;
  const child = fork(hooks.entry ?? modulePath, [...args], { ...options, stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', 'ipc'] });
  hooks.onChild?.(child);
  if (onSent !== undefined) {
    const send = child.send.bind(child) as (message: unknown, ...rest: unknown[]) => boolean;
    child.send = ((message: unknown, ...rest: unknown[]): boolean => {
      onSent(message);
      return send(message, ...rest);
    }) as ChildProcess['send'];
  }
  if (onReceived !== undefined) {
    child.on('message', (message: unknown) => onReceived(message));
  }
  for (const stream of [child.stdout, child.stderr]) {
    if (onOutput === undefined) {
      stream?.resume();
    } else {
      stream?.setEncoding('utf8').on('data', (chunk: string) => onOutput(chunk));
    }
  }
  if (stdinText !== undefined) {
    child.stdin?.end(stdinText());
  }
  return child;
};

/** process と、その子孫（Chromium）。 */
export async function processTreeOf(processId: number): Promise<readonly ProcessIdentity[]> {
  const processes = await listProcesses();
  return [...processes.filter((identity) => identity.processId === processId), ...descendantsOf(processId, processes)];
}

/** 待つ時間の上限と間隔（ms）。 */
export interface WaitTiming {
  readonly limitMs: number;
  readonly pollMs: number;
}

/** `read` が `null` でない値を返すまで待つ（上限を過ぎたら投げる）。 */
export async function waitForValue<T>(read: () => T | null, timing: WaitTiming): Promise<T> {
  const deadline = Date.now() + timing.limitMs;
  for (;;) {
    const value = read();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('the expected state was not reached');
    }
    await wait(timing.pollMs);
  }
}

/** fork のテストのプロファイルの入力（ほかの欄は、テストの環境の決まった値）。 */
export interface ForkTestProfileInput {
  readonly profileId: string;
  readonly targetConfigPath: string;
  readonly auth: AuthStrategy;
  readonly approvedTestOrigins: readonly string[];
  readonly approvedServiceOrigins?: readonly string[];
}

/**
 * fork のテストのプロファイルを作る（`TEST` の環境、`TEST_AUTH_PASSIVE`、最初の版、環境の確かめの記録の参照）。FM-2: 作れたら、表示の設定を切る（テストのジョブの
 * ブラウザは今どおり headless。既定は表示）。
 */
export const createForkTestProfile = (
  database: ControlDatabase,
  input: ForkTestProfileInput,
  resolveContext: (path: string) => { readonly targetConfig: AuditConfig } | undefined,
): ReturnType<typeof createProfile> => {
  const created = createProfile(database, {
    schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
    profileId: input.profileId,
    revision: MIN_PROFILE_REVISION,
    targetConfigPath: input.targetConfigPath,
    environment: 'TEST',
    mode: 'TEST_AUTH_PASSIVE',
    auth: input.auth,
    approvedTestOrigins: [...input.approvedTestOrigins],
    ...(input.approvedServiceOrigins === undefined ? {} : { approvedServiceOrigins: [...input.approvedServiceOrigins] }),
    environmentEvidenceRef: `evidence/${input.profileId}/isolation-check-1`,
  }, { resolveContext });
  if (created.ok) {
    hideJobBrowser(database, input.profileId);
  }
  return created;
};

/** FM-2: テストのプロファイルの表示の設定を切る（テストのジョブのブラウザは今どおり headless。既定は表示）。 */
export const hideJobBrowser = (database: ControlDatabase, profileId: string): void => {
  const saved = saveProfileDisplaySettings(database, profileId, { showJobBrowser: false });
  if (!saved.ok) {
    throw new Error(`the display setting of the test profile could not be saved (${saved.reason})`);
  }
};

/** `page.json` の、テストが読む項目。 */
export interface ForkTestPageDocument {
  readonly pageUrl: string;
  readonly viewports: Readonly<Record<string, { readonly status: string }>>;
}

/** Run の成果物（出力先の下）。 */
export interface RunArtifacts {
  /** すべての場所（ZIP の中身を含む。目印の検査に使う）。 */
  readonly places: readonly LeakPlace[];
  /** `run.json`（ZIP の中身を除く。最初の 1 つ）。 */
  readonly run: RunSummary | undefined;
  /** `page.json`（ZIP の中身を除く）。 */
  readonly pages: readonly ForkTestPageDocument[];
  /** 見えている文字（`visible-text.txt`。ZIP の中身を除く）。 */
  readonly visibleTexts: readonly string[];
}

const RUN_FILE = 'run.json';
const PAGE_FILE = 'page.json';
const VISIBLE_TEXT_FILE = 'visible-text.txt';

/** 出力先の下の Run の成果物を読む。 */
export function readRunArtifacts(outputDirectory: string): RunArtifacts {
  const places = filesUnder(outputDirectory);
  const files = places.filter(([path]) => !path.includes(ZIP_ENTRY_PLACE_SEPARATOR));
  const textsOf = (name: string): readonly string[] => files.filter(([path]) => path.endsWith(name)).map(([, bytes]) => bytes.toString('utf8'));
  const [run] = textsOf(RUN_FILE).map((text) => JSON.parse(text) as RunSummary);
  return {
    places,
    run,
    pages: textsOf(PAGE_FILE).map((text) => JSON.parse(text) as ForkTestPageDocument),
    visibleTexts: textsOf(VISIBLE_TEXT_FILE),
  };
}

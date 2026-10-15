// `npm run setup:local` の入口（Task 23 の設計書 4.5、4.6。T23d）。何もない状態から、管理データを準備する。冪等（何回実行してもよい）。
// 手順: 環境の確かめ → `resolveControlDatabasePath(repoRoot)` → `openControlDatabase`（フォルダとファイルを作るか開き、版を最新にし、
// `quick_check`）→ `getStoreStatus` → 結果の表示 → 閉じる。
// - 表示の文言は `src/presentation/messages.ts`（`SETUP_LOCAL_TEXT`、`CONTROL_STORE_FAILURE_DESCRIPTIONS`）が持つ。ここは組み立てて出すだけ。
// - 失敗は、理由ごとの日本語の説明と取るべき手順を標準エラーに出し、0 でない終了コード（`FAILURE_EXIT_CODE`）で終える。
//   利用者のファイルを消さない・上書きしない・移さない（`openControlDatabase` の決まり）。
// - 本番の入口（`node dist/control/setup-local.js`）は、リポジトリの root を自分の場所（`dist/control/` の 2 つ上）から決め、
//   場所は `resolveControlDatabasePath` だけで決める。データの場所を変える引数や環境変数は作らない。
// - 監査の CLI（`src/cli/`）は、このファイルを読み込まない（`tests/architecture/cli-control-boundary.test.ts`）。
// - T26e（Task 26 の設計書 4.1 の「起動のとき」）: 管理データの準備ができた後に、資格情報のフォルダ（`local/secrets/`）に残った書きかけの一時の
//   ファイルを消し（`removeTemporaryFiles`）、暗号化が使えるか（`checkProtection`）を 1 回確かめて、結果を出す（値は出さない）。使えなくても
//   終了コードは変えない（自動ログインが始められないだけ）。フォルダがなければ何も作らない。資格情報のファイルの部品は `createCredentialStore`。
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FAILURE_EXIT_CODE, SUCCESS_EXIT_CODE } from '../cli/exit-codes.js';
import { formatCount } from '../presentation/format.js';
import {
  CONTROL_STORE_FAILURE_DESCRIPTIONS,
  SETUP_LOCAL_TEXT,
  cliFieldText,
  labelWithCodeText,
  type CONTROL_ENVIRONMENT_FAILURE_DESCRIPTIONS,
  type PROFILE_STORE_REJECTION_DESCRIPTIONS,
} from '../presentation/messages.js';
import {
  checkControlEnvironment,
  MIN_CONTROL_NODE_VERSION,
  type ControlEnvironmentFailureReason,
  type ControlEnvironmentResult,
} from './environment/control-environment.js';
import { prepareCredentialStorage, type CredentialStoragePreparation } from './credentials/credential-preparation.js';
import { createCredentialStore, type CredentialProtectionState } from './credentials/credential-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from './store/control-database.js';
import { resolveControlDatabasePath } from './store/database-path.js';
import type { ProfileStoreRejectionReason } from './store/profile-store.js';
import { getStoreStatus, type ControlStoreStatus } from './store/store-status.js';
import { controlStoreFailureOf, type ControlStoreFailureReason } from './store/store-errors.js';

// ---------------------------------------------------------------------------------------------------------------
// 文言の網羅（`messages.ts` は `src/control/` を import しないので、確かめはこちら側に置く。`config-error.ts` と同じ方式）
// ---------------------------------------------------------------------------------------------------------------

type SameKeys<Left extends PropertyKey, Right extends PropertyKey> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type AssertTrue<Condition extends true> = Condition;
export type ControlEnvironmentDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<ControlEnvironmentFailureReason, keyof typeof CONTROL_ENVIRONMENT_FAILURE_DESCRIPTIONS>
>;
export type ControlStoreDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<ControlStoreFailureReason, keyof typeof CONTROL_STORE_FAILURE_DESCRIPTIONS>
>;
export type ProfileStoreRejectionDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<ProfileStoreRejectionReason, keyof typeof PROFILE_STORE_REJECTION_DESCRIPTIONS>
>;

// ---------------------------------------------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------------------------------------------

/** 表示の出力先（1 行ずつ）。 */
export interface SetupLocalOutput {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** `runSetupLocal` の指定。 */
export interface SetupLocalOptions {
  /** リポジトリの root（絶対パス）。管理データの場所は `resolveControlDatabasePath(repoRoot)` だけで決める。 */
  readonly repoRoot: string;
  readonly output: SetupLocalOutput;
  /** 環境の確かめ（既定は今の process の `checkControlEnvironment`。テストは結果を渡せる）。 */
  readonly checkEnvironment?: () => ControlEnvironmentResult;
}

/** 準備の結果。 */
export type SetupLocalResult =
  | { readonly exitCode: number; readonly outcome: 'CREATED' | 'EXISTING' | 'UPGRADED' }
  | { readonly exitCode: number; readonly outcome: 'FAILED'; readonly reason: ControlStoreFailureReason };

/** 止めたときの表示（標準エラー）。 */
const reportFailure = (
  output: SetupLocalOutput,
  reason: ControlStoreFailureReason,
  details: { readonly databasePath: string | null; readonly nodeVersion: string | null; readonly detail: string | null },
): SetupLocalResult => {
  const text = CONTROL_STORE_FAILURE_DESCRIPTIONS[reason];
  output.stderr(SETUP_LOCAL_TEXT.failedHeading);
  output.stderr(cliFieldText(SETUP_LOCAL_TEXT.reasonLabel, labelWithCodeText(text.description, reason)));
  if (details.nodeVersion !== null) {
    output.stderr(SETUP_LOCAL_TEXT.nodeVersionText(details.nodeVersion, MIN_CONTROL_NODE_VERSION));
  }
  if (details.databasePath !== null) {
    output.stderr(cliFieldText(SETUP_LOCAL_TEXT.locationLabel, details.databasePath));
  }
  output.stderr(cliFieldText(SETUP_LOCAL_TEXT.actionLabel, text.action));
  if (details.detail !== null) {
    output.stderr(cliFieldText(SETUP_LOCAL_TEXT.detailLabel, details.detail));
  }
  return Object.freeze({ exitCode: FAILURE_EXIT_CODE, outcome: 'FAILED', reason });
};

/** 準備ができたときの表示（標準出力）。 */
const reportDone = (output: SetupLocalOutput, database: ControlDatabase, status: ControlStoreStatus): SetupLocalResult => {
  const outcome = database.foundSchemaVersion === 0
    ? 'CREATED'
    : database.foundSchemaVersion < database.schemaVersion ? 'UPGRADED' : 'EXISTING';
  const resultText = outcome === 'CREATED'
    ? SETUP_LOCAL_TEXT.createdText(database.schemaVersion)
    : outcome === 'UPGRADED'
      ? SETUP_LOCAL_TEXT.upgradedText(database.foundSchemaVersion, database.schemaVersion)
      : SETUP_LOCAL_TEXT.existingText(database.schemaVersion);
  output.stdout(SETUP_LOCAL_TEXT.doneHeading);
  output.stdout(cliFieldText(SETUP_LOCAL_TEXT.locationLabel, status.path));
  output.stdout(cliFieldText(SETUP_LOCAL_TEXT.resultLabel, resultText));
  output.stdout(cliFieldText(SETUP_LOCAL_TEXT.sqliteVersionLabel, status.sqliteVersion));
  output.stdout(cliFieldText(
    SETUP_LOCAL_TEXT.profilesLabel,
    SETUP_LOCAL_TEXT.profileCountsText(formatCount(status.profileCounts.ACTIVE), formatCount(status.profileCounts.RETIRED)),
  ));
  output.stdout(cliFieldText(
    SETUP_LOCAL_TEXT.quickCheckLabel,
    status.quickCheck.ok ? SETUP_LOCAL_TEXT.quickCheckOk : SETUP_LOCAL_TEXT.quickCheckProblemText(formatCount(status.quickCheck.messages.length)),
  ));
  output.stdout(SETUP_LOCAL_TEXT.nextStep);
  return Object.freeze({ exitCode: SUCCESS_EXIT_CODE, outcome });
};

/**
 * 管理データを準備する（設計書 4.6）。表示を出し、結果（終了コードと結果の種類）を返す。例外は投げない。
 */
export const runSetupLocal = (options: SetupLocalOptions): SetupLocalResult => {
  const { output } = options;
  const environment = (options.checkEnvironment ?? checkControlEnvironment)();
  if (!environment.ok) {
    return reportFailure(output, environment.reason, { databasePath: null, nodeVersion: environment.nodeVersion, detail: null });
  }

  let databasePath: string;
  try {
    databasePath = resolveControlDatabasePath(options.repoRoot);
  } catch (error) {
    const failure = controlStoreFailureOf(error);
    return reportFailure(output, failure.reason, { databasePath: null, nodeVersion: null, detail: failure.detail });
  }

  let database: ControlDatabase;
  try {
    database = openControlDatabase(databasePath);
  } catch (error) {
    const failure = controlStoreFailureOf(error);
    const nodeVersion = failure.reason === 'NODE_VERSION_UNSUPPORTED' || failure.reason === 'NODE_SQLITE_UNAVAILABLE'
      ? environment.nodeVersion
      : null;
    return reportFailure(output, failure.reason, { databasePath, nodeVersion, detail: failure.detail });
  }

  try {
    return reportDone(output, database, getStoreStatus(database));
  } catch (error) {
    const failure = controlStoreFailureOf(error);
    return reportFailure(output, failure.reason, { databasePath, nodeVersion: null, detail: failure.detail });
  } finally {
    closeControlDatabase(database);
  }
};

// ---------------------------------------------------------------------------------------------------------------
// 資格情報のフォルダの準備（T26e）
// ---------------------------------------------------------------------------------------------------------------

/** 暗号化が使える状態。 */
const PROTECTION_AVAILABLE = 'AVAILABLE' satisfies CredentialProtectionState;

// 準備の手順（`prepareCredentialStorage`）の owner は `credentials/credential-preparation.ts`（CCX-5。画面のサーバと共用）。ここからも公開し続ける。
export { prepareCredentialStorage, type CredentialStoragePreparation };

/** 資格情報のフォルダの準備の結果の表示の行（標準出力。値を出さない）。 */
export const credentialStorageLines = (preparation: CredentialStoragePreparation): readonly string[] => {
  const lines: string[] = [];
  if (preparation.removedTemporaryFiles === null) {
    lines.push(SETUP_LOCAL_TEXT.temporaryCredentialFilesUnreadable);
  } else if (preparation.removedTemporaryFiles > 0) {
    lines.push(SETUP_LOCAL_TEXT.temporaryCredentialFilesRemovedText(formatCount(preparation.removedTemporaryFiles)));
  }
  lines.push(cliFieldText(
    SETUP_LOCAL_TEXT.credentialProtectionLabel,
    preparation.protection === PROTECTION_AVAILABLE ? SETUP_LOCAL_TEXT.credentialProtectionAvailable : SETUP_LOCAL_TEXT.credentialProtectionUnavailable,
  ));
  return Object.freeze(lines);
};

/** 本番の入口として実行されたか（`node dist/control/setup-local.js`）。 */
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  // リポジトリの root は、この入口の場所（`dist/control/` の 2 つ上）から決める（今の作業のフォルダに依存しない）。
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const result = runSetupLocal({
    repoRoot,
    output: {
      stdout: (line) => process.stdout.write(`${line}\n`),
      stderr: (line) => process.stderr.write(`${line}\n`),
    },
  });
  process.exitCode = result.exitCode;
  // T26e: 管理データの準備ができたときだけ、資格情報のフォルダを準備する（結果は終了コードを変えない）。
  if (result.outcome !== 'FAILED') {
    for (const line of credentialStorageLines(await prepareCredentialStorage(createCredentialStore(repoRoot)))) {
      process.stdout.write(`${line}
`);
    }
  }
}

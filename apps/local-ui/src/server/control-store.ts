/**
 * 画面のサーバの管理データの接続（Task 23 設計書 4.3、4.6。T23f）。サーバだけで使う。
 * - リポジトリの root を自分の場所から決め（`repositoryRootOf`）、`openControlDatabase(resolveControlDatabasePath(root))` を 1 回だけ行って
 *   使い回す（`npm run setup:local` と同じ準備の部品）。データの場所を変える引数や環境変数はない。
 * - 本番の起動の部品は、待ち受けの前に `launcher-bridge` を通して `prepareLocalUiStore` を呼ぶ。失敗したら、`npm run setup:local` と同じ
 *   説明の文（`src/presentation/messages.ts`）を出して止まる。開発のサーバも、待ち受けを始めたときに準備する。
 * - 準備に失敗した後は、Server Function も同じ理由で止まる（何度も開き直さない）。
 * - process の終わりに閉じる（`closeLocalUiStore`。起動の部品は SIGINT と SIGTERM でも呼ぶ）。
 */
import { relative } from 'node:path';
import { MIN_CONTROL_NODE_VERSION } from '../../../../src/control/environment/control-environment.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../../src/control/store/database-path.js';
import {
  ControlStoreError,
  controlStoreFailureOf,
  type ControlStoreFailure,
  type ControlStoreFailureReason,
} from '../../../../src/control/store/store-errors.js';
import {
  CONTROL_STORE_FAILURE_DESCRIPTIONS,
  SETUP_LOCAL_TEXT,
  cliFieldText,
  labelWithCodeText,
} from '../../../../src/presentation/messages.js';
import { repositoryRootOf } from './repository-root';

/** 準備の失敗（理由と英語の詳細。振り分けは `controlStoreFailureOf`）。 */
export type LocalUiStoreFailure = ControlStoreFailure;

/** 準備の結果。失敗のときは、コンソールに出す行（日本語の説明と手順）。 */
export type LocalUiStorePreparation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ControlStoreFailureReason; readonly lines: readonly string[] };

type StoreState =
  | { readonly kind: 'unprepared' }
  | { readonly kind: 'ready'; readonly database: ControlDatabase }
  | { readonly kind: 'failed'; readonly failure: LocalUiStoreFailure }
  | { readonly kind: 'closed' };

let state: StoreState = { kind: 'unprepared' };

/** 環境の理由（Node の版を添えて出す）。 */
const ENVIRONMENT_REASONS: ReadonlySet<ControlStoreFailureReason> = new Set(['NODE_VERSION_UNSUPPORTED', 'NODE_SQLITE_UNAVAILABLE']);

/** このサーバのリポジトリの root（区切りは `/`）。 */
export const localUiRepositoryRoot = (): string => repositoryRootOf(import.meta.url);

/** 管理データのファイルの場所（絶対パス）。 */
const databasePath = (): string => resolveControlDatabasePath(localUiRepositoryRoot());

/** 管理データの場所を、リポジトリの root からの相対の形で（画面に出す。区切りは `/`）。 */
export const relativeDatabaseLocation = (): string => relative(localUiRepositoryRoot(), databasePath()).replaceAll('\\', '/');

/** 準備の失敗を、コンソールに出す行にする（`npm run setup:local` と同じ説明と手順）。 */
const failureLines = (failure: LocalUiStoreFailure): readonly string[] => {
  const text = CONTROL_STORE_FAILURE_DESCRIPTIONS[failure.reason];
  return Object.freeze([
    SETUP_LOCAL_TEXT.failedHeading,
    cliFieldText(SETUP_LOCAL_TEXT.reasonLabel, labelWithCodeText(text.description, failure.reason)),
    ...(ENVIRONMENT_REASONS.has(failure.reason) ? [SETUP_LOCAL_TEXT.nodeVersionText(process.versions.node, MIN_CONTROL_NODE_VERSION)] : []),
    cliFieldText(SETUP_LOCAL_TEXT.locationLabel, relativeDatabaseLocation()),
    cliFieldText(SETUP_LOCAL_TEXT.actionLabel, text.action),
    cliFieldText(SETUP_LOCAL_TEXT.detailLabel, failure.detail),
  ]);
};

/** 管理データを準備する（冪等。2 回目からは前の結果を返す）。 */
export const prepareLocalUiStore = (): LocalUiStorePreparation => {
  if (state.kind === 'unprepared') {
    try {
      state = { kind: 'ready', database: openControlDatabase(databasePath()) };
      process.once('exit', closeLocalUiStore);
    } catch (error) {
      state = { kind: 'failed', failure: controlStoreFailureOf(error) };
    }
  }
  if (state.kind === 'failed') {
    return Object.freeze({ ok: false, reason: state.failure.reason, lines: failureLines(state.failure) });
  }
  return Object.freeze({ ok: true });
};

/** 準備した管理データ（Server Function が使う）。準備できていなければ準備し、失敗なら `ControlStoreError` を投げる。 */
export const localUiStore = (): ControlDatabase => {
  prepareLocalUiStore();
  if (state.kind === 'ready') {
    return state.database;
  }
  if (state.kind === 'failed') {
    throw new ControlStoreError(state.failure.reason, state.failure.detail);
  }
  throw new ControlStoreError('DATABASE_OPEN_FAILED', 'the local UI control store is closed');
};

/** 管理データを閉じる（2 回呼んでもよい）。閉じた後は開き直さない。 */
export function closeLocalUiStore(): void {
  if (state.kind === 'ready') {
    closeControlDatabase(state.database);
  }
  state = { kind: 'closed' };
}

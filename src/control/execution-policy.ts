// 「どのモードのプロファイルで、何を許すか」の唯一の owner（Task 24 の設計書 4.4 の開始の 1、5 章。T24e。T28b で操作ごとの閉じた一覧にした）。
// - 監査モードの一覧（`AUDIT_MODES`）のうち、今の BeakSight が監査を動かせるものだけ。保存はできても、後の Task まで動かせないモード
//   （書き込みが要るもの）は含めない。
// - ジョブの管理（`src/control/job/`）が、開始の直前にこの判定を使う。画面の表示の部品（`apps/local-ui/src/display/labels.ts`）も、この owner を使う。
// - 値の一覧の追加は、そのモードの監査の実行ができたときだけ行う。
// - T25d（Task 25 の設計書 4.4、4.5）: 認証つきの読み取りの監査（`TEST_AUTH_PASSIVE`）を足した。実行できるのは、認証の方式が手動のログイン
//   （`MANUAL_SESSION`）で、認証の設定が有効なときだけ（認証の設定の確かめは、ジョブの管理が開始の直前に行う）。書き込みの監査
//   （`TEST_APPROVED_WRITE`）は、引き続き実行できない。
// - T26d-2（Task 26 の設計書 4.3、変更履歴の「Blocker: T26d-2」の行）: 認証つきの読み取りの監査に、自動ログイン（`AUTOMATED_LOGIN`）を足した。
//   この判定は、プラットフォームを問わない純粋な判定（このファイルはブラウザでも読み込まれるので、`process` を使わない）。Windows だけで動くことは、
//   サーバの側のジョブの管理の開始の確かめで強制する（資格情報の暗号化の確かめ `checkProtection` が、Windows でなければ使えないを返し、
//   `CREDENTIAL_PROTECTION_UNAVAILABLE` で拒む）。資格情報・上限の確かめも、ジョブの管理が開始の直前に行う。
// - T28b（Task 28 の設計書 2 章のユーザーの判断 1、3 章の「モードの拡張」、4.5、10 章の 5）: 「どのモードで何を許すか」を、操作（ジョブの種類と、
//   認証の設定・資格情報の保存）ごとの閉じた一覧（`PROFILE_OPERATION_POLICY`）にまとめた。書き込みのモード（`TEST_APPROVED_WRITE`）でも、認証の設定・
//   資格情報・ログインの確かめ・操作の候補の発見（`DISCOVERY`）・READ の確かめ（`READ_CHECK`。定義の保存を含む）を、認証つきの読み取りの監査と
//   同じ条件で許す。認証つきの監査（`AUDIT`）は、書き込みのモードでは今までどおり許さない。ジョブの管理（`audit-job-manager.ts`）、認証の設定の
//   検証（`auth-setup-policy.ts`）、画面の開始の確かめ（`audit-start-check.ts`）と出し分け（`labels.ts`）は、すべてこの判定を呼ぶ。
//   拒む理由は、今までの判定の順（モード → 認証の方式）と同じ値になるように表で表す: 操作の行にモードがなければ `MODE_NOT_EXECUTABLE`、モードは
//   あっても方式が一覧になければ `AUTH_STRATEGY_NOT_EXECUTABLE`（例: 公開の監査のログインの確かめは、モードは受けるが方式が `NONE` なので
//   方式の理由。T26d-2 から変えない）。
import { deepFreeze } from '../core/immutable.js';
import type { AuditMode, AuthStrategy } from './contracts.js';
import type { AuditJobStartRejectionReason } from './job/job-records.js';
import type { WorkerJobKind } from './worker-protocol.js';

/**
 * プロファイルに対する操作（T28b）。ジョブの種類（`WORKER_JOB_KINDS` と同じ値。監査、ログインの確かめ、操作の候補の発見、READ の確かめ）と、
 * 認証の設定の保存（`AUTH_SETUP`）、資格情報の保存と変更（`CREDENTIAL`）。READ の確かめの定義の保存は `READ_CHECK` に含める。
 * T28e fix round 1: 書き込みのシナリオ（`SCENARIO`。作成・変更・承認。書き込みの実行ではない）を足した。
 * T30e: 書き込みのジョブ（`WRITE_CREATE`。承認された CREATE の実行）を足した。
 * T31e fix round 1: 更新の書き込みのジョブ（`WRITE_UPDATE`。承認された UPDATE の実行。始める口は T31f）を足した。
 * T43c（Task 43 の設計書 4.3）: 入口の確かめのジョブ（`ENTRY_CHECK`。開始の URL を読み取りだけで 1 回読み、ログインの画面の案を作る）を足した。
 */
export const PROFILE_OPERATIONS = deepFreeze(
  [
    'AUDIT',
    'LOGIN_CHECK',
    'DISCOVERY',
    'READ_CHECK',
    'AUTH_SETUP',
    'CREDENTIAL',
    'SCENARIO',
    'WRITE_CREATE',
    'WRITE_UPDATE',
    'ENTRY_CHECK',
  ] as const satisfies readonly (WorkerJobKind | 'AUTH_SETUP' | 'CREDENTIAL' | 'SCENARIO')[],
);
export type ProfileOperation = (typeof PROFILE_OPERATIONS)[number];

/** 操作を拒む理由（ジョブの開始の拒否の理由の値と同じ）。 */
export type ProfileOperationRejection = Extract<AuditJobStartRejectionReason, 'MODE_NOT_EXECUTABLE' | 'AUTH_STRATEGY_NOT_EXECUTABLE'>;
const MODE_NOT_EXECUTABLE = 'MODE_NOT_EXECUTABLE' satisfies ProfileOperationRejection;
const AUTH_STRATEGY_NOT_EXECUTABLE = 'AUTH_STRATEGY_NOT_EXECUTABLE' satisfies ProfileOperationRejection;

/** ログインを使う方式（手動のログインと自動ログイン）。 */
const LOGIN_STRATEGIES = ['MANUAL_SESSION', 'AUTOMATED_LOGIN'] as const satisfies readonly AuthStrategy[];
/** 自動ログインの方式だけ（ログインの確かめと資格情報）。 */
const AUTOMATED_LOGIN_ONLY = ['AUTOMATED_LOGIN'] as const satisfies readonly AuthStrategy[];

/**
 * 操作ごとの、許すモードと、そのモードで許す認証の方式（T28b。閉じた一覧）。行にないモードは `MODE_NOT_EXECUTABLE`、行にあっても方式が
 * 一覧にない組み合わせは `AUTH_STRATEGY_NOT_EXECUTABLE`。書き込みのモードで許すのは、認証の設定・資格情報・ログインの確かめ・発見・READ の
 * 確かめ（Task 28 の設計書 10 章の 5）と、書き込みのシナリオ（T28e fix round 1。書き込みのモードだけの操作。書き込みは実行しない）だけ。
 */
export const PROFILE_OPERATION_POLICY: Readonly<Record<ProfileOperation, Readonly<Partial<Record<AuditMode, readonly AuthStrategy[]>>>>> = deepFreeze({
  AUDIT: { PUBLIC_PASSIVE: ['NONE'], TEST_AUTH_PASSIVE: LOGIN_STRATEGIES },
  // 公開の監査のプロファイルのログインの確かめは、方式の理由で拒む（T26d-2 から変えない）。
  LOGIN_CHECK: { PUBLIC_PASSIVE: [], TEST_AUTH_PASSIVE: AUTOMATED_LOGIN_ONLY, TEST_APPROVED_WRITE: AUTOMATED_LOGIN_ONLY },
  DISCOVERY: { TEST_AUTH_PASSIVE: LOGIN_STRATEGIES, TEST_APPROVED_WRITE: LOGIN_STRATEGIES },
  READ_CHECK: { TEST_AUTH_PASSIVE: LOGIN_STRATEGIES, TEST_APPROVED_WRITE: LOGIN_STRATEGIES },
  AUTH_SETUP: { TEST_AUTH_PASSIVE: LOGIN_STRATEGIES, TEST_APPROVED_WRITE: LOGIN_STRATEGIES },
  CREDENTIAL: { TEST_AUTH_PASSIVE: AUTOMATED_LOGIN_ONLY, TEST_APPROVED_WRITE: AUTOMATED_LOGIN_ONLY },
  // T28e fix round 1: 書き込みのシナリオ（作成・変更・承認）は、書き込みのモードだけ（発見と同じ方式。書き込みは実行しない）。
  SCENARIO: { TEST_APPROVED_WRITE: LOGIN_STRATEGIES },
  // T30e: 書き込みのジョブ（承認された CREATE）は、書き込みのモードで、ログインを使う方式だけ（Task 30 の設計書 3 章）。
  WRITE_CREATE: { TEST_APPROVED_WRITE: LOGIN_STRATEGIES },
  // T31e fix round 1: 更新の書き込みのジョブ（承認された UPDATE）も、書き込みのモードで、ログインを使う方式だけ（Task 31 の設計書 3 章。CREATE と同じ）。
  WRITE_UPDATE: { TEST_APPROVED_WRITE: LOGIN_STRATEGIES },
  // T43c: 入口の確かめは、公開のモードは認証なし、テストの 2 つのモードはログインを使う方式（ログインはしない。認証の設定がなくても始められる。
  // `AUTH_SETUP_FREE_OPERATIONS`）。
  ENTRY_CHECK: { PUBLIC_PASSIVE: ['NONE'], TEST_AUTH_PASSIVE: LOGIN_STRATEGIES, TEST_APPROVED_WRITE: LOGIN_STRATEGIES },
});

/**
 * 認証の設定が要らない操作（T43c。閉じた一覧）。ログインをしないので、認証の設定が要るモードのプロファイルでも、認証の設定がない・古いまま始められる。
 * ジョブの管理（開始の直前の確かめ）と画面の開始の確かめは、`operationRequiresAuthSetup` を通して、この一覧を使う。
 */
export const AUTH_SETUP_FREE_OPERATIONS = deepFreeze(['ENTRY_CHECK'] as const satisfies readonly ProfileOperation[]);

/** 認証の設定が要らない操作か。 */
const isAuthSetupFreeOperation = (operation: ProfileOperation): boolean =>
  (AUTH_SETUP_FREE_OPERATIONS as readonly ProfileOperation[]).includes(operation);

/** 操作の行（一覧にない値、文字列でない値は `undefined`。継承した名前（`constructor` など）を見ない）。 */
const operationRowOf = (operation: unknown): Readonly<Partial<Record<AuditMode, readonly AuthStrategy[]>>> | undefined =>
  typeof operation === 'string' && Object.hasOwn(PROFILE_OPERATION_POLICY, operation)
    ? PROFILE_OPERATION_POLICY[operation as ProfileOperation]
    : undefined;

/** 操作の行のうち、そのモードで許す方式（行にないモード、文字列でない値は `undefined`）。 */
const strategiesOf = (operation: unknown, mode: unknown): readonly AuthStrategy[] | undefined => {
  const row = operationRowOf(operation);
  return row !== undefined && typeof mode === 'string' && Object.hasOwn(row, mode) ? row[mode as AuditMode] : undefined;
};

/**
 * 操作を、そのモードと認証の方式のプロファイルで許すか（T28b）。許すなら `null`、拒むなら理由（モード → 方式の順。一覧にない値は fail-closed で
 * 拒む）。プラットフォーム・認証の設定・資格情報・上限の確かめは、ジョブの管理と画面の開始の確かめが、この後に行う。
 */
export const profileOperationRejectionOf = (operation: ProfileOperation, mode: unknown, auth: unknown): ProfileOperationRejection | null => {
  const strategies = strategiesOf(operation, mode);
  if (strategies === undefined) {
    return MODE_NOT_EXECUTABLE;
  }
  return typeof auth === 'string' && strategies.some((strategy) => strategy === auth) ? null : AUTH_STRATEGY_NOT_EXECUTABLE;
};

/** 操作を、そのモードと認証の方式のプロファイルで許すか（T28b）。 */
export const isProfileOperationAllowed = (operation: ProfileOperation, mode: unknown, auth: unknown): boolean =>
  profileOperationRejectionOf(operation, mode, auth) === null;

/** 今実行できる監査モード（公開の監査と、認証つきの読み取りの監査。`PROFILE_OPERATION_POLICY` の `AUDIT` の行）。 */
export const EXECUTABLE_AUDIT_MODES: readonly AuditMode[] = deepFreeze(Object.keys(PROFILE_OPERATION_POLICY.AUDIT) as AuditMode[]);

/** 今実行できる監査モードか（一覧にない値、文字列でない値は偽）。 */
export const isExecutableAuditMode = (mode: unknown): mode is AuditMode => strategiesOf('AUDIT', mode) !== undefined;

/**
 * 今実行できるモードごとの、今実行できる認証の方式（T25d。`PROFILE_OPERATION_POLICY` の `AUDIT` の行）。公開の監査は認証なし、認証つきの読み取りの
 * 監査は手動のログインと自動ログイン（T26d-2。方式として実行できる。Windows だけであることは、ジョブの管理の開始の確かめで強制する）。一覧にない
 * モードは、どの方式でも実行できない。
 */
export const EXECUTABLE_AUTH_STRATEGIES: Readonly<Partial<Record<AuditMode, readonly AuthStrategy[]>>> = PROFILE_OPERATION_POLICY.AUDIT;

/** 今実行できるモードと認証の方式の組み合わせか（どちらかが一覧にない値なら偽）。プラットフォームを問わない。 */
export const isExecutableAuthStrategy = (mode: unknown, auth: unknown): boolean => isProfileOperationAllowed('AUDIT', mode, auth);

/**
 * 開始の前に、有効な認証の設定（`beaksight-auth-setup/3`）が要るモード（T25d。T28b で書き込みのモードを足した。`PROFILE_OPERATION_POLICY` の
 * `AUTH_SETUP` の行）。
 */
export const AUTH_SETUP_REQUIRED_AUDIT_MODES: readonly AuditMode[] = deepFreeze(Object.keys(PROFILE_OPERATION_POLICY.AUTH_SETUP) as AuditMode[]);

/** 開始の前に、有効な認証の設定が要るモードか。 */
export const requiresAuthSetup = (mode: unknown): boolean => strategiesOf('AUTH_SETUP', mode) !== undefined;

/**
 * その操作に、有効な認証の設定が要るか（T28b）。操作の行にあるモードで、認証の設定が要るモードのときだけ真（書き込みのモードの監査は、始められない
 * ので偽。開始の画面が、ログインの案内を出すかに使う）。T43c: 認証の設定が要らない操作（`AUTH_SETUP_FREE_OPERATIONS`）は、どのモードでも偽。
 */
export const operationRequiresAuthSetup = (operation: ProfileOperation, mode: unknown): boolean =>
  !isAuthSetupFreeOperation(operation) && strategiesOf(operation, mode) !== undefined && requiresAuthSetup(mode);

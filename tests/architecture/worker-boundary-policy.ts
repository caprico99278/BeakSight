/**
 * 監査のワーカー（`src/worker/`）の境界の決まり（Task 24 の設計書 4.3 の「Gate の例外」。T24d）。`control-boundary.test.ts` の (a) の例外と、
 * `worker-boundary.test.ts` が共用する（同じ一覧を 2 か所に書かない）。テストのファイルではない（テストを持たない）。
 */
import { resolveRelativeSpecifier, withoutModuleExtension } from './source-scan.js';

/** 監査のワーカーのフォルダ。 */
export const WORKER_DIRECTORY = 'src/worker/';

/**
 * `src/worker/` が import してよい `src/control/` のファイル（拡張子なし）。IPC の契約、Control のスキーマの検証、契約の型、パスの確かめ
 * （`isAcceptedTargetConfigPath`）、認証の設定と状態の絞り込み（T25d）、自動ログインの結果と時間、資格情報のファイルの読み出し（T26d-1）だけ。
 * `src/control/store/`、`src/control/job/` などには届かない。
 */
export const WORKER_ALLOWED_CONTROL_FILES: ReadonlySet<string> = new Set([
  'src/control/worker-protocol',
  'src/control/control-schema-validator',
  'src/control/contracts',
  'src/control/profile-policy',
  // T25d（Task 25 の設計書 4.4）: 認証の設定の契約（`DEFAULT_EXCLUDED_URL_WORDS`、型）、検証（`sessionLostPathPrefixOf`）、状態の絞り込み
  // （`filterAuthenticatedState`）。保存（`src/control/store/`）とジョブ（`src/control/job/`）には、引き続き届かない（(k) で確かめる）。
  'src/control/auth/auth-setup-contracts',
  'src/control/auth/auth-setup-policy',
  'src/control/auth/authenticated-state',
  // T26d-1（Task 26 の設計書 4.4、4.5、変更履歴の「Blocker: T26c」の行の (3)）: 自動ログインの段（`src/worker/automated-login.ts`）が、結果の
  // 閉じた一覧とログインの Origin（`loginOriginOf`）、結果を待つ時間と `Retry-After` の読み方を使う。どちらも純粋な定義だけのファイル。
  'src/control/auth/automated-login-results',
  'src/control/auth/automated-login-timing',
  // T26d-1（設計書 3 章の「復号はワーカーだけ」、4.4 の 1 と 4）: ワーカーが、資格情報のファイルの秘密でない項目（改訂の番号、ログインの
  // Origin）を読み、フォームに値を入れる直前に復号する。書く操作（登録・変更・削除）を呼ぶのは画面のサーバだけ（T26e）。暗号化の部品
  // （`dpapi-protector.ts`）は、ファイルの部品を通してだけ使う（直接の参照は許さない）。
  'src/control/credentials/credential-store',
  // T30f（Task 30 の設計書 3 章の「結果の判定」「記録」）: 書き込みの流れ（`src/worker/write-create-run.ts`）が、`action-run.json` の契約と、判定
  // （`actionOutcomeOf`・`reservationSettlementOf`・登録の ID の形）と、登録の ID の path の型の印（`RECORD_ID_PLACEHOLDER`）を使う。どれも純粋な
  // 定義と関数だけのファイル（親も同じ判定で決め直す）。
  'src/control/actions/action-contracts',
  'src/control/actions/action-outcome',
  'src/control/approval/scenario-contracts',
  // T40b-1（Task 40 の設計書 3.3）: API の書き込みの流れ（`src/worker/write-create-run.ts`）が、記録と報告の API の要約の組み立て（`actionApiSummaryOf`）と、
  // 応答の本文から登録の ID を取り出す口（`apiRecordIdOfResponseBody`。Guard の `recordIdOf` に渡す）を使う。どちらも純粋な関数だけのファイル（親も同じ
  // 要約で照らす）。
  'src/control/actions/action-api-summary',
  'src/control/actions/api-record-id',
  // T40b-2（Task 40 の設計書 7 章の「T40b-2 の設計」）: API の書き込みの照合の READ（`src/worker/read-check-run.ts`）が、`{id}` に ID を入れた画面の path に、
  // 保存の時と同じ画面の path の確かめ（`readCheckPagePathRejectionsOf`）をかけ直す。純粋な関数だけのファイル（保存の確かめと同じ owner）。
  'src/control/read-check-page-path',
  // T43c（Task 43 の設計書 4.3）: 入口の確かめの流れ（`src/worker/entry-check-run.ts`・`entry-check-page.ts`）が、成果物 `entry-check.json` の契約と、
  // 場所の作り方・案への写し・セレクタの受け入れ・Run Status の写しを使う。純粋な定義と関数だけのファイル（親も同じ要約で照らす）。
  'src/control/entry-check',
]);

/**
 * `src/worker/` のファイル（`fromPath`）の参照（`text`。指定子か、相対パスの文字列リテラル）が、許す `src/control/` のファイルを指すか。
 * 相対の指定子だけを許す（`src/control/...` を含む相対でない指定子は、許さない）。相対の指定子の解決と拡張子の除き方は、
 * `source-scan.ts` の共通の部品（CCX-9）。
 */
export const isAllowedWorkerControlReference = (fromPath: string, text: string): boolean => {
  const resolved = fromPath.startsWith(WORKER_DIRECTORY) ? resolveRelativeSpecifier(fromPath, text) : null;
  return resolved !== null && WORKER_ALLOWED_CONTROL_FILES.has(withoutModuleExtension(resolved));
};

// 書き込みの結果の契約の SSOT（Task 30 の設計書 3 章の「結果の判定」「登録の ID」「READ による照合」「予約の締め」「`UNKNOWN` の後」「記録」、
// ロードマップ 5 章の `ActionResult`。T30a）。
// - 閉じた一覧は `as const` の凍結した配列として 1 回だけ定義し、TypeScript の型はその配列から導く（`src/control/contracts.ts` と同じ方式）。
//   成果物 `action-run.json` のスキーマ（`schemas/action-run.schema.json`）の enum は、ここの配列と一致する
//   （`tests/unit/schema-enum-consistency.test.ts`）。上限と分岐の const は `tests/unit/action-run-schema.test.ts`。
// - 判定（予約の締め方、`ActionResult` の決め方）は `action-outcome.ts` の純粋な関数。ここは定義だけ。
// - 記録は、資格情報・Cookie・CSRF のトークン・hidden の値・認証の状態を持たない（項目を作らない）。送った値は合成のテストデータなので平文
//   （READ の定義の送る値と同じ扱い）。
// - 純粋な定義だけのファイル。管理データ・画面・ブラウザ・ワーカーに触れない。
// - T32c（Task 32 の設計書 4.1 の成果物の表、5 章、6 章）: 書き込みの報告の契約（`action-evidence.json` の `ActionEvidenceDocument`、
//   `approval-summary.json` の `ApprovalSummaryDocument`、「人が決めたこと」と「自動で行うこと」の閉じた一覧）を、ファイルの末尾の節に足した。
//   ワーカーが使える契約のファイル（`tests/architecture/worker-boundary-policy.ts` の `WORKER_ALLOWED_CONTROL_FILES`）なので、別のファイルに
//   分けずにここに置く。値の一覧は既存の配列から導き、二重に定義しない。
// - T40c（Task 40 の設計書 3.4、7 章の履歴の「T40a の報告（API の検証の指定）」「設計者の判断（順の入れ替え）」）: 記録と報告の版 1.1。書き手は 1.1 を
//   書き、読み手は 1.1 だけを受ける（LG-4 で前の版 1.0 を捨てた。`ACTION_RUN_READABLE_SCHEMA_VERSIONS`・`ACTION_EVIDENCE_READABLE_SCHEMA_VERSIONS`。
//   スキーマの `schemaVersion` の enum と同じ）。1.1 は送り方（`transport`）と API の要約（`ActionApiSummary`。FORM は null）を持ち、API の記録は成否の
//   条件（`resultConditions`）を持たない（null）。組み立てと照らし合わせの純粋な部品は `action-api-summary.ts`。承認の要約（`approval-summary.json`）は、
//   API のシナリオも今の形（種類は CREATE）で表せるので 1.0 のまま。
import type {
  APPROVER_LOCAL_OPERATOR,
  ApprovalBoundFacts,
  InputRuleReference,
  ScenarioApiMethod,
  ScenarioKind,
  ScenarioLimits,
  ScenarioResultCondition,
  ScenarioTransport,
  SideEffectConfirmations,
  WriteReservationState,
} from '../approval/scenario-contracts.js';
import type { SeedRecord } from '../data-rules/scenario-data.js';
import type { ReadCheckResult } from '../../discovery/read-check-contracts.js';
import type { ReadCheckEvidenceState, ReadCheckExecutedEvidence } from '../../discovery/read-check-evaluation.js';

/** `action-run.json` の文書の形の印（書き手が書く版。T40c で 1.1）。 */
export const ACTION_RUN_SCHEMA_VERSION = 'action-run-schema/1.1';

/**
 * `action-run.json` の読み手が受ける版（T40c。スキーマの `schemaVersion` の enum と同じ）。LG-4（テストの組の設計書 3.7.3）: 前の版 1.0 は捨て、今の版だけを
 * 受ける（前の版の記録は、スキーマに合わないので、親の締めでも画面の読み出しでも使わない）。
 */
export const ACTION_RUN_READABLE_SCHEMA_VERSIONS = Object.freeze([ACTION_RUN_SCHEMA_VERSION] as const);
export type ActionRunSchemaVersion = (typeof ACTION_RUN_READABLE_SCHEMA_VERSIONS)[number];

/**
 * 書き込みの結果（ロードマップ 5 章の `ActionResult`。閉じた一覧）。
 * - `VERIFIED`: 成功の条件に当たり、登録の ID を取り、照合の READ が一致した。
 * - `PARTIAL`: 成功の条件に当たったが、照合できない（ID が取れない、READ の照合を判定できない）。完了（`COMPLETE`）にしない。
 * - `BLOCKED`: 送らずに止めた（Guard の照合、送る前の確かめ）。
 * - `UNKNOWN`: 送ったが結果が分からない（応答がない、5xx、どの条件にも当たらない・2 つ以上に当たる、セッションが切れた、307・308、READ の
 *   照合が成功の条件と食い違う）。成功と偽らない。件数は使ったものとして数える。5xx は、サーバが 5xx の前に登録を済ませていることがあるので、
 *   失敗と言い切らない（T30a fix round 1。設計者の判断。設計書 11 章）。
 * - `FAILED`: 送ったが、サイトが登録しなかったと判定できる（入力の誤り、429）。
 */
/** 照合まで済んだ結果（`ACTION_RESULTS` の値の名前つきの定数。PRE42-CC 組 1b の N4-8d: ほかのファイルは、ここから読む）。 */
export const VERIFIED_ACTION_RESULT = 'VERIFIED';
export const ACTION_RESULTS = Object.freeze([VERIFIED_ACTION_RESULT, 'PARTIAL', 'BLOCKED', 'UNKNOWN', 'FAILED'] as const);
export type ActionResult = (typeof ACTION_RESULTS)[number];

/**
 * 送信の状態（閉じた一覧）。
 * - `NOT_SENT`: Guard が POST を通さなかった（ワーカーが報告できた）。
 * - `SENT`: Guard が承認の形の POST を通した。
 * - `UNKNOWN`: 送ったか分からない（ワーカーが落ちた、報告が届かないなど）。
 */
/** 送らずに止めた送信の状態（`SUBMISSION_STATES` の値の名前つきの定数。PRE42-CC 組 1b の N4-8d: ほかのファイルは、ここから読む）。 */
export const NOT_SENT_SUBMISSION_STATE = 'NOT_SENT';
export const SUBMISSION_STATES = Object.freeze([NOT_SENT_SUBMISSION_STATE, 'SENT', 'UNKNOWN'] as const);
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

/**
 * 送らずに止めた理由（閉じた一覧）。
 * - `PAYLOAD_MISMATCH`: Guard が送る中身の照合で止めた。
 * - `PRECHECK_FAILED`: 送る前の確かめ（画面の確かめ、送る直前の承認と許可の確かめ直し、フォームの確かめ）で止めた。
 */
export const ACTION_BLOCK_REASONS = Object.freeze(['PAYLOAD_MISMATCH', 'PRECHECK_FAILED'] as const);
export type ActionBlockReason = (typeof ACTION_BLOCK_REASONS)[number];

/**
 * 送信の後の画面の結果の判定（閉じた一覧。Task 26 の結果の判定の作り）。
 * - `SUCCESS`: 成功の条件だけに当たった。`INPUT_ERROR`: 入力の誤りの条件だけに当たった。
 * - `RATE_LIMITED`: HTTP 429。`SERVER_ERROR`: HTTP 5xx。
 * - `NO_CONDITION_MATCHED`: どの条件にも当たらない。`MULTIPLE_CONDITIONS_MATCHED`: 2 つ以上に当たった。
 * - `SESSION_LOST`: セッションが切れた（認証の設定のセッションの切れの条件）。
 * - `REPOST_REDIRECT`: 307・308 の再 POST を止めた。
 * - `RESPONSE_NOT_DELIVERED`（T30R2-fix-1 の M-b）: 送り手は応答を受けたが、ブラウザが登録の POST の要求を取り消した（ページの JS が別の画面へ
 *   移ったなど）ので、応答をブラウザに返せなかった。今の画面は POST の応答ではないので、成功の条件と ID を判定しない（結果は `UNKNOWN`）。
 */
export const RESPONSE_JUDGEMENTS = Object.freeze([
  'SUCCESS',
  'INPUT_ERROR',
  'RATE_LIMITED',
  'SERVER_ERROR',
  'NO_CONDITION_MATCHED',
  'MULTIPLE_CONDITIONS_MATCHED',
  'SESSION_LOST',
  'REPOST_REDIRECT',
  'RESPONSE_NOT_DELIVERED',
] as const);
export type ResponseJudgement = (typeof RESPONSE_JUDGEMENTS)[number];

/**
 * `ActionResult` を決めた理由（閉じた一覧）。送らずに止めた理由と、成功でない結果の判定は、それぞれの一覧の値をそのまま理由にする（理由の型に
 * 入ることは、判定の関数 `actionOutcomeOf` の型で確かめる）。
 * - `NO_RESPONSE`: 送った後に応答がない、または送ったか分からない（接続の断、ワーカーの異常終了）。
 * - `RECORD_ID_NOT_FOUND`: 成功の条件に当たったが、登録の ID が取れない。
 * - `RECORD_ID_UNSAFE`（T30f。設計書 11 章）: 成功の条件に当たり、登録の ID らしい値は取れたが、path の 1 区切りに入れて安全な閉じた形（英数字・`_`・
 *   `-`、1〜`MAX_SAFE_RECORD_ID_LENGTH` 文字。`action-outcome.ts` の `isUsableRecordId`）でない。ID なしとして扱う（`PARTIAL`）。
 * - `READ_VERIFICATION_MATCHED`・`READ_VERIFICATION_NOT_MATCHED`: 照合の READ が一致した・一致しなかった。
 * - `READ_VERIFICATION_UNDETERMINED`: 照合の READ を判定できない（読めない、止められた、候補が変わった、実行できなかった）。
 * - `RECORD_ID_MISMATCH`（T31e fix round 1。Task 31 の設計書 3 章の「結果の判定」）: UPDATE で、成功の後に取れた ID が対象のレコードの ID と違う
 *   （`UNKNOWN`。どのレコードが変わったか分からない）。
 * - `UNEXPECTED_FIELD_CHANGE`（T31e fix round 1。設計書 3 章の「更新の後の照合」）: UPDATE の更新の後の照合で、変えた欄が新しい値でない、保つ欄・
 *   状態の欄が変わった（`UNKNOWN`。副作用の疑いがあり、成功と偽らない）。
 * - `UPDATE_POSTCHECK_UNDETERMINED`（T31f。T31e fix round 1 の発見事項 1）: UPDATE の更新の後の照合を判定できない（証拠がない、照合できない欄が
 *   ある）（`PARTIAL`）。照合の READ を判定できない（`READ_VERIFICATION_UNDETERMINED`）とは分ける。
 */
export const ACTION_OUTCOME_REASONS = Object.freeze([
  'PAYLOAD_MISMATCH',
  'PRECHECK_FAILED',
  'NO_RESPONSE',
  'INPUT_ERROR',
  'RATE_LIMITED',
  'SERVER_ERROR',
  'NO_CONDITION_MATCHED',
  'MULTIPLE_CONDITIONS_MATCHED',
  'SESSION_LOST',
  'REPOST_REDIRECT',
  'RESPONSE_NOT_DELIVERED',
  'RECORD_ID_NOT_FOUND',
  'RECORD_ID_UNSAFE',
  'READ_VERIFICATION_MATCHED',
  'READ_VERIFICATION_NOT_MATCHED',
  'READ_VERIFICATION_UNDETERMINED',
  'RECORD_ID_MISMATCH',
  'UNEXPECTED_FIELD_CHANGE',
  'UPDATE_POSTCHECK_UNDETERMINED',
] as const);
export type ActionOutcomeReason = (typeof ACTION_OUTCOME_REASONS)[number];

/**
 * UPDATE の証拠の欄の役割（T31e。Task 31 の設計書 3 章の「証拠と記録」。閉じた一覧）。`CHANGED` は変えた欄（前の値と新しい値を持つ）、`KEPT` は保つ欄と
 * 状態の hidden の欄・組の hidden の欄（値を持たない。後の照合の一致の真偽だけ）。
 */
export const UPDATE_EVIDENCE_FIELD_ROLES = Object.freeze(['CHANGED', 'KEPT'] as const);
export type UpdateEvidenceFieldRole = (typeof UPDATE_EVIDENCE_FIELD_ROLES)[number];

/**
 * UPDATE の証拠の欄 1 つ（T31e）。`CHANGED` は、更新の前に読んだ値（`previousValue`）と送った新しい値（`newValue`）を持つ（BeakSight が登録した
 * テストのレコードの値なので、送った値と同じ扱いの平文）。`KEPT` は、どちらも null（保つ欄の値・hidden の値・CSRF のトークンは記録しない）。
 * `matched` は、更新の後の照合で期待と一致したか（照合できなければ null）。
 */
export interface WriteUpdateFieldEvidence {
  readonly fieldName: string;
  readonly role: UpdateEvidenceFieldRole;
  readonly previousValue: string | null;
  readonly newValue: string | null;
  readonly matched: boolean | null;
}

/** UPDATE の証拠（T31e。管理データの版 9 の `write_results.update_evidence`。欄は 1 つの名前に 1 つ）。 */
export interface WriteUpdateEvidence {
  readonly fields: readonly WriteUpdateFieldEvidence[];
}

/** 締めた予約の状態（Task 28 の予約の状態のうち、`RESERVED` から移る 3 つ。設計書 3 章の「予約の締め」）。 */
export const SETTLED_RESERVATION_STATES = Object.freeze(['COMMITTED', 'UNKNOWN', 'RELEASED'] as const satisfies readonly WriteReservationState[]);
export type SettledReservationState = (typeof SETTLED_RESERVATION_STATES)[number];

/** HTTP の状態の最小と最大（`action-run.json` の `httpStatus`）。 */
export const MIN_HTTP_STATUS = 100;
export const MAX_HTTP_STATUS = 599;

/**
 * 送った値 1 つの最大長（UTF-16 のコード単位。`action-run.json` の `submittedValues`）。生成の部品（Task 29）が作る値（辞書、固定の値、単純な
 * pattern）より十分大きい値にした（推測で決めた上限。超える値を生成したら、記録を書く前の確かめで止まる）。
 */
export const MAX_SUBMITTED_VALUE_LENGTH = 8_192;

/** `ActionResult` を決める入力（送信の状態で分かれる閉じた形）。 */
export type ActionOutcomeInput =
  /** 送らずに止めた（ワーカーが報告できた）。 */
  | { readonly submission: 'NOT_SENT'; readonly blockReason: ActionBlockReason }
  /** 送ったか分からない。 */
  | { readonly submission: 'UNKNOWN' }
  /**
   * 送った。`responseJudgement` は応答がなければ null。`recordId` は取れなければ null。`readVerification` は照合の READ の結果（Task 27 の結果。
   * 実行できなければ null）。`update` は UPDATE の書き込みだけ（T31e fix round 1）: 対象のレコードの ID と、更新の後の照合で欄がすべて一致したか
   * （一致しない欄があれば false、照合できない欄があれば null）。
   */
  | {
    readonly submission: 'SENT';
    readonly responseJudgement: ResponseJudgement | null;
    readonly recordId: string | null;
    readonly readVerification: ReadCheckResult | null;
    readonly update?: ActionOutcomeUpdateInput | undefined;
  };

/** UPDATE の書き込みの、結果を決める入力（T31e fix round 1）。 */
export interface ActionOutcomeUpdateInput {
  readonly targetRecordId: string;
  readonly fieldsMatched: boolean | null;
}

/** `ActionResult` と、それを決めた理由。 */
export interface ActionOutcome {
  readonly result: ActionResult;
  readonly reason: ActionOutcomeReason;
}

/** 照合の READ の記録（照合の READ の定義の id と版と、Task 27 の結果）。 */
export interface ActionRunReadVerification {
  readonly readCheckId: string;
  readonly readCheckRevision: number;
  readonly result: ReadCheckResult;
}

/**
 * 1 回の書き込みのジョブの記録（`action-run.json`。`schemas/action-run.schema.json` の形。日時は UTC の 14 桁）。資格情報・Cookie・CSRF の
 * トークン・hidden の値・認証の状態の項目を持たない。
 */
/**
 * UPDATE の書き込みの記録（T31f。`action-run.json` の `update`。Task 31 の設計書 3 章の「証拠と記録」。書くのは T31g-2 のワーカー）。
 * - `targetRecordId`: 更新の対象のレコードの ID（親が実行の許可から `START` に写した値。ワーカーはそのまま書く）。
 * - `updateEvidence`: 更新の後の照合の証拠（照合まで進まなかったときは null）。取れた ID は、CREATE と同じ `recordId`。
 * CREATE の記録は持たない（ジョブの管理が、ジョブの種類と照らす）。
 */
export interface ActionRunUpdate {
  readonly targetRecordId: string;
  readonly updateEvidence: WriteUpdateEvidence | null;
}

/** 結果の判定に使った条件（シナリオの検証の指定の写し。FORM の記録だけ）。 */
export interface ActionRunResultConditions {
  readonly successCondition: ScenarioResultCondition;
  readonly inputErrorCondition: ScenarioResultCondition;
}

/**
 * API の書き込みの要約（T40c。`action-run.json` と `action-evidence.json` の `api`。承認した API の指定の要約と、Guard の照合が返したページが決める鍵の
 * 値）。組み立ては `action-api-summary.ts` の `actionApiSummaryOf` だけ。ヘッダの値・応答の本文・本文の生の値・欄に入れた値は持たない（I22）。
 * - `method`・`origin`・`pathShape`・`shapeDigest`: 承認した要求の型（method、送り先の Origin の文字列、path の型）と型の digest。
 * - `keyNames`: 欄に対応する鍵の名前（鍵の UTF-16 のコード単位の順。1 件以上）。`pageKeyNames`: ページが決める鍵の名前（同じ順）。
 * - `httpFieldNames`: 許すヘッダの名前（ページが付ける名前だけ。小文字の順。値は持たない。成果物の項目の名前に秘密の語を使わないので、HTTP の
 *   field の名前と呼ぶ）。`recordIdKey`: 登録の ID を取る応答の本文の鍵（なければ null）。
 * - `pageKeyValues`: ページが決める鍵の値（Task 38 の判断 (1) で残す値。鍵ごとに、JSON の scalar を JSON の文字列にした形。例 `"tenant-1"`・`7`・
 *   `true`・`null`）。長さが `MAX_SUBMITTED_VALUE_LENGTH` を超えた値は、値を残さずに null の印にする（JSON の null は文字列の `null`）。照合まで
 *   進まなかった（送らなかった、読めていない）ときは、項目の全体が null。持つときの鍵は `pageKeyNames` とちょうど同じ。
 */
export interface ActionApiSummary {
  readonly method: ScenarioApiMethod;
  readonly origin: string;
  readonly pathShape: string;
  readonly shapeDigest: string;
  readonly keyNames: readonly string[];
  readonly pageKeyNames: readonly string[];
  readonly httpFieldNames: readonly string[];
  readonly recordIdKey: string | null;
  readonly pageKeyValues: Readonly<Record<string, string | null>> | null;
}

export interface ActionRunDocument {
  readonly schemaVersion: ActionRunSchemaVersion;
  readonly jobId: string;
  readonly runId: string;
  readonly profileId: string;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  /** 消費した実行の許可の id。 */
  readonly grantId: string;
  /** 生成の seed の記録（Task 29 の `SeedRecord`）。 */
  readonly seedRecord: SeedRecord;
  /**
   * 送った値（欄の名前 → 値。送らなかった欄は持たない。合成のテストデータなので平文）。T40c: API の記録は、欄に対応する鍵ごとの生成した値（文字列。
   * 鍵は `api.keyNames` の中）。
   */
  readonly submittedValues: Readonly<Record<string, string>>;
  /** 結果の判定に使った条件（シナリオの検証の指定の写し）。T40c: API の記録は null（成否の条件を使わない。FORM は必須）。 */
  readonly resultConditions: ActionRunResultConditions | null;
  readonly submission: SubmissionState;
  /** 送らずに止めた理由（送らずに止めたときだけ。ほかは null）。 */
  readonly blockReason: ActionBlockReason | null;
  /** 送信の後の main frame の文書の HTTP の状態（応答がなければ null）。 */
  readonly httpStatus: number | null;
  readonly responseJudgement: ResponseJudgement | null;
  readonly recordId: string | null;
  readonly readVerification: ActionRunReadVerification | null;
  readonly reservationState: SettledReservationState;
  readonly result: ActionResult;
  readonly reason: ActionOutcomeReason;
  readonly startedAt: string;
  /** 送信の時刻（送らなければ null）。 */
  readonly submittedAt: string | null;
  readonly finishedAt: string;
  /** T31f: UPDATE の書き込みの記録（UPDATE だけ。CREATE は持たない）。 */
  readonly update?: ActionRunUpdate;
  /** T40c: 送り方。 */
  readonly transport: ScenarioTransport;
  /** T40c: API の要約（FORM は null）。 */
  readonly api: ActionApiSummary | null;
  /** T44e（Task 44 の設計書 P2-4）: 送らずに止めた具体的な理由（`PRECHECK_FAILED` のときだけの任意の項目。前に書いた記録は持たない）。 */
  readonly precheckDetail?: PrecheckFailureDetail;
}

/**
 * T44e（Task 44 の設計書 P2-4。設計の変更の履歴の T44e の行の (2)）: 送る前の確かめで送らずに止めた（`PRECHECK_FAILED`）ときの、具体的な理由の閉じた一覧。
 * 送る・送らないの判定は変えない（理由を細かくするだけ）。書くのはワーカー（`write-create-run.ts`）で、`action-run.json` の任意の項目 `precheckDetail`。
 * - `STOPPED`: 止める合図（撤回・シナリオの変更・止める操作）。
 * - `SESSION_LOST`: 書き込みの画面でログインの状態が切れていた。
 * - `PAGE_UNAVAILABLE`: 書き込みの画面を読めなかった（読み込みの失敗、4xx・5xx、欄を読めない）。
 * - `CANDIDATE_CHANGED`: 画面の候補が、承認した候補と合わない（画面が変わった）。
 * - `PRIOR_VALUES_EMPTY`: 更新の前の読み取りで、目印の欄がすべて空（値が入る前の画面）。
 * - `KNOWN_KEPT_VALUE_MISMATCH`: 台帳が知る保つ鍵の値と、画面の値が違う（BeakSight の外で値が変わったレコード、結果が分からない更新の後のレコード、仮の値）。
 * - `PRIOR_VALUE_UNUSABLE`: 前の値を記録・照合に使えない（長すぎる、承認した型に変えられない）。
 * - `PRIOR_VALUE_CHANGED`: 書き込みの段で開き直した画面か、押す直前の読み直しの値が、前の読み取りと違う。
 * - `FORM_NOT_READY`: 入力の前の確かめ、値の入力、押す操作のどれかに失敗した。
 * - `UNEXPECTED_REQUEST`: 値を入れた後に、承認した送信のほかの要求が出た。
 * - `RECHECK_REFUSED`: 送る直前の確かめ直しで、承認か実行の許可が外れていた。
 * - `AUDIT_STAGE_STOPPED`: 監査の段の事実（ログインの状態の鍵の消失、サービスへの要求の上限）。
 * - `PREFLIGHT_FAILED`: Run の前の確認（ブラウザの起動など）に失敗した。
 */
export const PRECHECK_FAILURE_DETAILS = Object.freeze([
  'STOPPED',
  'SESSION_LOST',
  'PAGE_UNAVAILABLE',
  'CANDIDATE_CHANGED',
  'PRIOR_VALUES_EMPTY',
  'KNOWN_KEPT_VALUE_MISMATCH',
  'PRIOR_VALUE_UNUSABLE',
  'PRIOR_VALUE_CHANGED',
  'FORM_NOT_READY',
  'UNEXPECTED_REQUEST',
  'RECHECK_REFUSED',
  'AUDIT_STAGE_STOPPED',
  'PREFLIGHT_FAILED',
] as const);
export type PrecheckFailureDetail = (typeof PRECHECK_FAILURE_DETAILS)[number];

// ---------------------------------------------------------------------------------------------------------------
// 書き込みの報告（T32c。Task 32 の設計書 4.1、ユーザーの判断 3・6・7）
// - 書くのはワーカー（Run の終わり。結果の判定と照合の READ の後）。報告の対象は、ワーカーが Run の終わりまで進んだ回すべて（`BLOCKED` を含む）。
// - スキーマは `schemas/action-evidence.schema.json`・`schemas/approval-summary.schema.json`。値の一覧と上限は、`action-run`・`read-evidence`・
//   `control/scenario`・`control/approval-receipt` のスキーマを `$ref` で使う（書き写さない）。ここで新しく定義する閉じた一覧は「人が決めたこと」と
//   「自動で行うこと」だけ（enum の一致は `tests/unit/schema-enum-consistency.test.ts`）。
// - 秘密（資格情報、Cookie、CSRF のトークン、hidden・readonly・保つ欄の値、`lock_version`、認証の状態）の項目は作らない。人の値（UPDATE の変えた
//   欄の前の値、照合の READ の取れた値）は入れ、`containsHumanEnteredValues` で示す（ユーザーの判断 6）。
// ---------------------------------------------------------------------------------------------------------------

/** `action-evidence.json` の文書の形の印（書き手が書く版。T40c で 1.1）。 */
export const ACTION_EVIDENCE_SCHEMA_VERSION = 'action-evidence-schema/1.1';

/** `action-evidence.json` の読み手が受ける版（T40c。スキーマの `schemaVersion` の enum と同じ。LG-4 で前の版 1.0 を捨てた）。 */
export const ACTION_EVIDENCE_READABLE_SCHEMA_VERSIONS = Object.freeze([ACTION_EVIDENCE_SCHEMA_VERSION] as const);
export type ActionEvidenceSchemaVersion = (typeof ACTION_EVIDENCE_READABLE_SCHEMA_VERSIONS)[number];

/** `approval-summary.json` の文書の形の印（スキーマの `schemaVersion` の const）。 */
export const APPROVAL_SUMMARY_SCHEMA_VERSION = 'approval-summary-schema/1.0';

/**
 * 送る前の確かめの結果（`action-evidence.json` の `precheck`）。
 * - `candidateDigestMatched`: 今の画面の候補の digest（CREATE は識別と規則、UPDATE は型にした識別と規則）が承認のものと一致したか。確かめまで
 *   進まなかったら null。送った回は真だけ（スキーマで確かめる）。
 * - `blockReason`: 送らずに止めた理由（送った回は null。`action-run.json` の `blockReason` と同じ値）。
 */
export interface ActionEvidencePrecheck {
  readonly candidateDigestMatched: boolean | null;
  readonly blockReason: ActionBlockReason | null;
}

/**
 * 送信（`action-evidence.json` の `submission`）。送らなかった回（`NOT_SENT`）は、`submittedValues` が空、`actionPath`・`submittedAt` が null。
 * - `submittedValues`: 送った欄（名前 → 値。合成のテストデータなので平文。`action-run.json` の `submittedValues` と同じ形）。
 * - `actionPath`: 送信先の path（`/` で始まる。query は持たない。ArtifactWriter が書くときに伏せ字を通す）。
 * - `submittedAt`: 送信の時刻（UTC の 14 桁。`action-run.json` の `submittedAt` と同じ値）。
 */
export interface ActionEvidenceSubmission {
  readonly state: SubmissionState;
  readonly submittedValues: Readonly<Record<string, string>>;
  readonly actionPath: string | null;
  readonly submittedAt: string | null;
}

/**
 * 応答（`action-evidence.json` の `response`。送らなかった回は、この項目の全体が null）。送ったが応答がない回は、3 つとも null。
 * - `judgedAt`: 送信の後の画面の結果を判定した時刻（UTC の 14 桁。判定しなかったら null）。
 */
export interface ActionEvidenceResponse {
  readonly httpStatus: number | null;
  readonly judgement: ResponseJudgement | null;
  readonly judgedAt: string | null;
}

/** 照合の READ を実行しなかった印（送らなかった、成功でなかった、UPDATE の照合で止めたなど。理由は結果の理由（`reason`）が示す）。 */
export interface ActionReadVerificationNotExecuted {
  readonly readCheckId: string;
  readonly readCheckRevision: number;
  readonly state: Extract<ReadCheckEvidenceState, 'NOT_EXECUTED'>;
}

/**
 * 照合の READ（`action-evidence.json` の `readVerification`）。実行したときは、READ の確かめの成果物の 1 件と同じ証拠の全体
 * （`ReadCheckExecutedEvidence`。URL は ArtifactWriter が伏せ字を通す。期待ごとの `observedValue` は人の値でありうる）。
 */
export type ActionEvidenceReadVerification = ReadCheckExecutedEvidence | ActionReadVerificationNotExecuted;

/**
 * Guard の数の要約（`action-evidence.json` の `guard`）。書き込みの段の記録の写し（`src/safety/passive-request-guard.ts` の
 * `WriteStageMonitorSnapshot`）と同じ項目の名前で、数と印だけ（URL・値・本文を持たない）。`src/control/` は `src/safety/` を読み込めない
 * （`control-boundary` (b)）ので、理由の閉じた一覧（`SUBMISSION_STAGE_BLOCK_REASONS`、`WRITE_PAYLOAD_BLOCK_REASONS`）をここに書き写さず、鍵は
 * 文字列で受ける。鍵の閉じた一覧はスキーマの `propertyNames` の enum が持ち、Guard の一覧との一致は `schema-enum-consistency.test.ts` で、写しを
 * そのまま渡せることは `action-evidence-schema.test.ts` の型の確かめで固定する。
 */
export interface ActionGuardSummary {
  /** 送信の段だけの理由で止めた数（理由ごと）。 */
  readonly blockedByReason: Readonly<Record<string, number>>;
  /** 送信の窓の中で、今の判定で止めた数。 */
  readonly blockedByOtherRulesInWindow: number;
  /** Run の終わりの時点で、送信の窓が開いていたか（送らなかった印）。 */
  readonly submissionWindowOpen: boolean;
  /** 送る中身の照合で止めた数（理由ごと）。 */
  readonly blockedByPayloadReason: Readonly<Record<string, number>>;
  /** 送信の窓を開いたときに、文書の文字コードを読めたか。 */
  readonly documentCharsetRead: boolean;
  /** 応答をブラウザに返せなかった印（`RESPONSE_NOT_DELIVERED` の根拠）。 */
  readonly responseDeliveryCanceled: boolean;
}

/**
 * 書き込みの報告の証拠（`action-evidence.json`。`schemas/action-evidence.schema.json` の形。日時は UTC の 14 桁）。`action-run.json` と同じ
 * メモリの事実から組み立て、重なる値（ID、送信、応答、登録の ID、結果と理由、時刻）は一致する。
 * - `kind`: 書き込みの種類（シナリオの種類）。`update` は UPDATE だけが持つ（CREATE は null。`action-run.json` の `update` と同じ形）。
 * - `containsHumanEnteredValues`: 人の値が入りうる項目（UPDATE の変えた欄の前の値、照合の READ の取れた値）があるときに真（スキーマは、それらが
 *   あるのに偽の文書を拒む）。
 * - `response`: 送らなかった回は null。`guard`: 書き込みの段に入らなかった回は null。
 */
export interface ActionEvidenceDocument {
  readonly schemaVersion: ActionEvidenceSchemaVersion;
  readonly jobId: string;
  readonly runId: string;
  readonly profileId: string;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  readonly kind: ScenarioKind;
  readonly containsHumanEnteredValues: boolean;
  readonly precheck: ActionEvidencePrecheck;
  readonly submission: ActionEvidenceSubmission;
  readonly response: ActionEvidenceResponse | null;
  readonly recordId: string | null;
  readonly update: ActionRunUpdate | null;
  readonly readVerification: ActionEvidenceReadVerification;
  readonly guard: ActionGuardSummary | null;
  readonly result: ActionResult;
  readonly reason: ActionOutcomeReason;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** T40c: 送り方と API の要約（`action-run.json` と同じ値）。API の `submission.actionPath` は API の path。 */
  readonly transport: ScenarioTransport;
  readonly api: ActionApiSummary | null;
}

/**
 * 人が決めたこと（閉じた一覧。`approval-summary.json` の `humanDecisions`。表示の文言はカタログ）。
 * - `SCENARIO_APPROVAL`: シナリオの版の承認。`INPUT_RULES`: 入力の規則。`LIMITS`: 件数の上限と承認の期限の日数。
 * - `SIDE_EFFECT_CONFIRMATIONS`: 副作用の確認。`UPDATE_FIELD_ROLES`: UPDATE の欄の役割（変える欄と保つ欄。UPDATE だけ）。
 */
export const HUMAN_DECISIONS = Object.freeze([
  'SCENARIO_APPROVAL',
  'INPUT_RULES',
  'LIMITS',
  'SIDE_EFFECT_CONFIRMATIONS',
  'UPDATE_FIELD_ROLES',
] as const);
export type HumanDecision = (typeof HUMAN_DECISIONS)[number];

/**
 * BeakSight が自動で行うこと（閉じた一覧。`approval-summary.json` の `automatedActions`。表示の文言はカタログ）。
 * - `VALUE_GENERATION`: 送る値の生成。`TARGET_RECORD_SELECTION`: 更新の対象のレコードの選択（UPDATE だけ）。`SUBMISSION`: 送信。
 * - `RESULT_JUDGEMENT`: 結果の判定。`READ_VERIFICATION`: 照合の READ。
 */
export const AUTOMATED_ACTIONS = Object.freeze([
  'VALUE_GENERATION',
  'TARGET_RECORD_SELECTION',
  'SUBMISSION',
  'RESULT_JUDGEMENT',
  'READ_VERIFICATION',
] as const);
export type AutomatedAction = (typeof AUTOMATED_ACTIONS)[number];

/** UPDATE だけに当たる「人が決めたこと」（CREATE の要約は持たない。スキーマの分岐の enum）。 */
export const UPDATE_ONLY_HUMAN_DECISIONS = Object.freeze(['UPDATE_FIELD_ROLES'] as const satisfies readonly HumanDecision[]);

/** UPDATE だけに当たる「自動で行うこと」（CREATE の要約は持たない。スキーマの分岐の enum）。 */
export const UPDATE_ONLY_AUTOMATED_ACTIONS = Object.freeze(['TARGET_RECORD_SELECTION'] as const satisfies readonly AutomatedAction[]);

/** 承認の記録の要約（承認の記録 `ApprovalReceipt` の項目のうち、報告に書くもの。承認者は固定の `LOCAL_OPERATOR` だけで、人の名前は持たない）。 */
export interface ApprovalSummaryApproval {
  readonly receiptId: string;
  readonly approvalDigest: string;
  readonly bound: ApprovalBoundFacts;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly approver: typeof APPROVER_LOCAL_OPERATOR;
}

/** 開始の時点の実行の許可（消費はジョブの開始で済んでいる）。 */
export interface ApprovalSummaryGrantAtStart {
  readonly grantId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string;
}

/** 開始の時点の件数の予約（状態は `RESERVED`。締めた後の状態は画面の結果の表示と台帳で示し、報告には持たない）。 */
export interface ApprovalSummaryReservationAtStart {
  readonly count: number;
  readonly reservedAt: string;
}

/** 開始の時点の累積の件数（`used` はこの Run の予約を含む使った数。`limit` はシナリオの累積の上限）。 */
export interface ApprovalSummaryCumulativeAtStart {
  readonly used: number;
  readonly limit: number;
}

/**
 * 承認の要約の事実（親が開始の時点で読み、`START` の `write.approvalFacts` でワーカーに渡す値。ワーカーは照らさずに書き写す）。値はすべて開始の
 * 時点のもの（名前の `AtStart`、`capturedAt`）。秘密を持たない。組み立ては `approval-summary-facts.ts` の `approvalSummaryFactsOf`（T32d）。
 * スキーマは `schemas/approval-summary.schema.json` の `$defs/facts`（IPC の `START` も同じ定義を `$ref` で使う）。ジョブの ID は `START` が持つので、
 * 事実には持たない（文書にはワーカーが足す）。
 */
export interface ApprovalSummaryFacts {
  readonly profileId: string;
  readonly scenario: { readonly scenarioId: string; readonly revision: number; readonly kind: ScenarioKind };
  readonly approval: ApprovalSummaryApproval;
  /** 開始の時点で、この承認が撤回されていたか。 */
  readonly revokedAtStart: boolean;
  readonly inputRuleReference: InputRuleReference | null;
  readonly limits: ScenarioLimits;
  readonly approvalTtlDays: number;
  readonly sideEffectConfirmations: SideEffectConfirmations;
  readonly grantAtStart: ApprovalSummaryGrantAtStart;
  readonly reservationAtStart: ApprovalSummaryReservationAtStart;
  readonly cumulativeAtStart: ApprovalSummaryCumulativeAtStart;
  /** 人が決めたこと（`HUMAN_DECISIONS` の順。CREATE は `UPDATE_ONLY_HUMAN_DECISIONS` を除くすべて、UPDATE はすべて）。 */
  readonly humanDecisions: readonly HumanDecision[];
  /** 自動で行うこと（`AUTOMATED_ACTIONS` の順。CREATE は `UPDATE_ONLY_AUTOMATED_ACTIONS` を除くすべて、UPDATE はすべて）。 */
  readonly automatedActions: readonly AutomatedAction[];
  /** 開始の時点の値を読んだ時刻（UTC の 14 桁）。 */
  readonly capturedAt: string;
}

/** 書き込みの報告の承認の要約（`approval-summary.json`。`schemas/approval-summary.schema.json` の形。事実に、ワーカーが 3 つの項目を足す）。 */
export interface ApprovalSummaryDocument extends ApprovalSummaryFacts {
  readonly schemaVersion: typeof APPROVAL_SUMMARY_SCHEMA_VERSION;
  readonly jobId: string;
  readonly runId: string;
}

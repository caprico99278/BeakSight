// シナリオの承認の契約の SSOT（Task 28 の設計書 3 章、4.1。T28a）。
// - 閉じた一覧は `as const` の凍結した配列として 1 回だけ定義し、TypeScript の型はその配列から導く（`src/control/contracts.ts` と同じ方式）。
// - JSON Schema（`schemas/control/scenario.schema.json`、`approval-receipt.schema.json`）の enum は、ここの配列と一致する
//   （`tests/unit/schema-enum-consistency.test.ts`）。上限・既定値・分岐の const は、ここの名前つきの定数と一致する
//   （`tests/unit/approval-schemas.test.ts`）。
// - シナリオ = 書き込みの候補 1 つ（分類が `CREATE` か `UPDATE`）と、結果を照らす READ の確かめの定義の参照 0〜n 件。版ごとに変えない写し。
//   状態（`SCENARIO_STATES`）は管理データの行に持ち、版の写しには持たない。`EXPIRED` は保存せず、読むときに時計から求める（判定は
//   `approval-validity.ts`）。
// - 値は持たない: 入力の値、CSRF のトークン、hidden の値、選択肢の label、資格情報の項目を作らない（設計書 4.7）。ページが書いた値（送信先の
//   path、欄の名前）は持つ（`discovery.json` と同じ）。
// - 既定の上限と期限（ユーザー承認済み。設計書 10 章）は名前つきの定数。シナリオは既定以下だけを持てる（確かめは `scenario-policy.ts`）。
// - 純粋な定義だけのファイル。管理データ・画面・ブラウザ・ワーカーに触れない（`tests/architecture/approval-ssot.test.ts`）。
// - T30a（Task 30 の設計書 2 章のユーザーの判断 4、3 章の「結果の判定」「登録の ID」「READ による照合」「検証の指定」、10 章の 5）: シナリオの
//   中身に、検証の指定（`ScenarioVerification`。成功の条件・入力の誤りの条件・登録の ID の取り方・照合の READ）を足した。どれかが未指定
//   （null）でも下書きと承認はできるが、実行の許可は出せない（`VERIFICATION_SPEC_MISSING`。判定は `scenario-policy.ts` の
//   `missingVerificationItemsOf`）。結果の条件は Task 26 の結果の条件と同じ型（`LoginResultCondition`。書き写さない）。
// - T31b（Task 31 の設計書 3 章の「UPDATE の指定」、4 章の「契約」、11 章の T31b の Blocker の判断）: シナリオの中身に、UPDATE の指定
//   （`ScenarioUpdateSpec`。台帳の参照、更新の画面と送信先の path の型、保つ欄、候補から求めた型にした識別の digest）を足した。kind が `UPDATE` の
//   下書きでは必須、`CREATE` は持てない（null）。UPDATE の指定の前に保存した UPDATE の版は null として読め、承認と発行はできない
//   （`SCENARIO_UPDATE_SPEC_MISSING`）。変える欄は今の送る欄（`fieldNames`）、保つ欄は `keepFieldNames`。path の型の `{id}` の印は、候補の識別の
//   owner（`src/discovery/fingerprint.ts` の `PATH_TEMPLATE_ID_SEGMENT`）と同じ値（登録の ID の取り方の path の型と共用）。
import { WRITE_AUDIT_MODE } from '../contracts.js';
import {
  MAX_AUTH_SETUP_URL_LENGTH,
  MAX_SUCCESS_SELECTOR_LENGTH,
  type LoginResultCondition,
} from '../auth/auth-setup-contracts.js';
import type { ReadCheckView } from '../job/read-check-store.js';
import { WORKER_JOB_ID_PATTERN } from '../worker-protocol.js';
import { PATH_TEMPLATE_ID_SEGMENT } from '../../discovery/fingerprint.js';
import { DAY_MS, MINUTE_MS } from '../../core/time-units.js';
import {
  MAX_CANDIDATE_FIELDS,
  MAX_CANDIDATE_URL_PART_LENGTH,
  type CandidateClassification,
  type FormEnctype,
  type FormMethod,
  type MethodOverride,
} from '../../discovery/candidate-contracts.js';
import {
  MAX_READ_CHECK_DEFINITIONS_PER_PROFILE,
  MAX_READ_CHECK_EXPECTATIONS,
  MAX_READ_CHECK_PARAMETERS,
  MAX_READ_CHECK_ROW_COUNT,
  type ReadCheckExpectationKind,
} from '../../discovery/read-check-contracts.js';

// ---------------------------------------------------------------------------------------------------------------
// 版の印と閉じた一覧
// ---------------------------------------------------------------------------------------------------------------

/** シナリオの版の文書の形の印（スキーマの `schemaVersion` の const）。 */
export const SCENARIO_SCHEMA_VERSION = 'beaksight-scenario/1';

/** 承認と撤回の記録の文書の形の印（スキーマの `schemaVersion` の const）。 */
export const APPROVAL_RECEIPT_SCHEMA_VERSION = 'beaksight-approval-receipt/1';

/** シナリオの種類（候補の分類のうち、書き込みの 2 つ）。 */
export const SCENARIO_KINDS = Object.freeze(['CREATE', 'UPDATE'] as const satisfies readonly CandidateClassification[]);
export type ScenarioKind = (typeof SCENARIO_KINDS)[number];

/** シナリオの保存する状態（管理データの行）。`EXPIRED` は保存しない（読むときに時計から求める）。 */
export const SCENARIO_STATES = Object.freeze(['DRAFT', 'APPROVED', 'REVOKED'] as const);
export type ScenarioState = (typeof SCENARIO_STATES)[number];

/**
 * 副作用の確認（承認の前に人がすべて確かめる。設計書 4.1）。
 * - `TEST_RECORDS_ONLY`: 登録・更新されるのはテスト環境のレコードだけ。
 * - `NO_EXTERNAL_NOTIFICATION`: メール・SMS・外部の通知が送られない設定である。
 * - `NO_PAYMENT_OR_EXTERNAL_SERVICE`: 決済や外部のサービスに及ばない。
 * - `NOT_DESTRUCTIVE`: 削除・無効化・取り消しに当たらない。
 */
export const SIDE_EFFECT_CONFIRMATIONS = Object.freeze([
  'TEST_RECORDS_ONLY',
  'NO_EXTERNAL_NOTIFICATION',
  'NO_PAYMENT_OR_EXTERNAL_SERVICE',
  'NOT_DESTRUCTIVE',
] as const);
export type SideEffectConfirmation = (typeof SIDE_EFFECT_CONFIRMATIONS)[number];

/** 副作用の確認（項目ごとに、人が確かめたか）。 */
export type SideEffectConfirmations = { readonly [Item in SideEffectConfirmation]: boolean };

/**
 * シナリオの要求の form の method（CREATE・UPDATE の候補は、書き込みの method の form。PUT・PATCH は `_method` の上書きで表す。実際の method の
 * 判定の owner は `src/discovery/classify.ts`。ここでは form の method と上書きを 2 つのまま持つ（`discovery-index-store.ts` と同じ））。
 */
export const SCENARIO_FORM_METHOD = 'POST' satisfies FormMethod;

/** シナリオの要求の `_method` の上書き（`DELETE` は持たない）。上書きがなければ null。 */
export const SCENARIO_METHOD_OVERRIDES = Object.freeze(['PUT', 'PATCH'] as const satisfies readonly MethodOverride[]);
export type ScenarioMethodOverride = (typeof SCENARIO_METHOD_OVERRIDES)[number];

/** 承認の記録の種類（承認、撤回。どちらも追記だけ）。 */
export const APPROVAL_RECEIPT_KINDS = Object.freeze(['APPROVAL', 'REVOCATION'] as const);
export type ApprovalReceiptKind = (typeof APPROVAL_RECEIPT_KINDS)[number];

/** 撤回の理由（閉じた一覧。今は人が画面で撤回したものだけ）。 */
export const REVOCATION_REASONS = Object.freeze(['OPERATOR_REQUEST'] as const);
export type RevocationReason = (typeof REVOCATION_REASONS)[number];

/**
 * 書き込みの件数の予約の状態（Task 28 の設計書 3 章の「件数の予約」。T28c で管理データの版 6 の CHECK に使う。書く口は T28d・Task 30）。
 * - `RESERVED`: 予約中（累積に数える）。`RELEASED`: 送る前に返した（数えない）。`COMMITTED`: 送った（数える）。`UNKNOWN`: 送ったか分からない（数える）。
 */
export const WRITE_RESERVATION_STATES = Object.freeze(['RESERVED', 'RELEASED', 'COMMITTED', 'UNKNOWN'] as const);
export type WriteReservationState = (typeof WRITE_RESERVATION_STATES)[number];

/** 承認者（利用者の ID がない単独の利用者なので、固定の値。設計書 10 章の 3。OS のユーザー名などは記録しない）。 */
export const APPROVER_LOCAL_OPERATOR = 'LOCAL_OPERATOR';

/** 書き込みを許すモード（承認が有効でありうるプロファイルのモード）。定義は `../contracts.ts`（CCX-29）。ここでは公開し直すだけ。 */
export { WRITE_AUDIT_MODE };

// ---------------------------------------------------------------------------------------------------------------
// 既定値（ユーザー承認済み。設計書 3 章の判断 3、10 章）
// ---------------------------------------------------------------------------------------------------------------

/** 承認の期限の日数の既定（シナリオは、これ以下だけを持てる）。 */
export const APPROVAL_TTL_DAYS = 30;

/** 承認の期限の 1 日の長さ（ms。UTC の暦の 1 日）。期限の時刻の計算は `approval-validity.ts` の `approvalExpiresAtOf` だけが使う。 */
export const APPROVAL_TTL_DAY_MS = DAY_MS;

/** 1 回の Run の書き込みの件数の上限の既定（UPDATE も同じ値。Task 31 で見直す）。 */
export const DEFAULT_MAX_CREATES_PER_RUN = 1;

/** 累積の書き込みの件数の上限の既定（UPDATE も同じ値）。 */
export const DEFAULT_MAX_CUMULATIVE_CREATES = 20;

/** 書き込みのジョブの同時実行の数。 */
export const WRITE_JOB_CONCURRENCY = 1;

/** 実行の許可（ExecutionGrant）の期限（ms。許可を発行してから書き込みのジョブを始めるまで。1 回だけ使える）。 */
export const EXECUTION_GRANT_TTL_MS = 5 * MINUTE_MS;

/**
 * 同じシナリオの連続の書き込みの最小の間隔（ms。Task 30 の設計書 2 章のユーザーの判断 3。T30d）。最後の書き込み（予約を `COMMITTED`・`UNKNOWN` で
 * 締めた時刻）からこの時間が経つまで、実行の許可を出さない。既定値を変えるのはユーザーの判断。
 */
export const MIN_WRITE_INTERVAL_MS = 5 * MINUTE_MS;

/** 同じシナリオの、窓（`WRITE_RATE_WINDOW_MS`）の中の書き込みの最大の件数（ユーザーの判断 3。T30d。この件数に達したら許可を出さない）。 */
export const MAX_WRITES_PER_DAY = 5;

/** 書き込みの件数を数える窓の長さ（ms。24 時間。T30d）。窓は「判定の時刻の 24 時間前より後、判定の時刻まで」。 */
export const WRITE_RATE_WINDOW_MS = DAY_MS;

/** シナリオの上限の最小。 */
export const MIN_SCENARIO_LIMIT = 1;

/** シナリオの期限の日数の最小。 */
export const MIN_APPROVAL_TTL_DAYS = 1;

/** シナリオの版（と、照らす READ の定義の版、入力の規則の版）の最小。 */
export const MIN_SCENARIO_REVISION = 1;

/** 送る欄の名前の最大の件数（1 つの候補の欄の数の上限と同じ）。 */
export const MAX_SCENARIO_FIELD_NAMES = MAX_CANDIDATE_FIELDS;

/** 照らす READ の定義の参照の最大の件数（1 つのプロファイルの定義の数の上限と同じ）。 */
export const MAX_SCENARIO_READ_CHECKS = MAX_READ_CHECK_DEFINITIONS_PER_PROFILE;

/**
 * シナリオ・承認の記録・照らす READ の定義・入力の規則の集まりの ID の形（ジョブの ID と同じ形。READ の確かめの定義の ID と同じ決め）。
 * スキーマの pattern と一致する。
 */
export const SCENARIO_ID_PATTERN = WORKER_JOB_ID_PATTERN;

// ---------------------------------------------------------------------------------------------------------------
// 検証の指定（T30a。Task 30 の設計書 3 章、10 章の 5）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 検証の指定の項目（閉じた一覧）。どれかが未指定（null）なら、実行の許可を出さない（`VERIFICATION_SPEC_MISSING`）。
 * - `successCondition`: 送信の後の画面が登録の成功に当たる条件。
 * - `inputErrorCondition`: 送信の後の画面が入力の誤りに当たる条件。
 * - `recordId`: 登録の ID の取り方。
 * - `readVerification`: 生成した値で読み直す照合の READ。
 */
export const SCENARIO_VERIFICATION_ITEMS = Object.freeze(['successCondition', 'inputErrorCondition', 'recordId', 'readVerification'] as const);
export type ScenarioVerificationItem = (typeof SCENARIO_VERIFICATION_ITEMS)[number];

/**
 * 登録の ID の取り方（閉じた一覧）。
 * - `URL_PATH_PATTERN`: 成功の後の URL の path を、型（例 `/items/{id}`）に当てて取る。
 * - `ELEMENT`: 成功の画面の要素（CSS セレクタ）の文字から取る。
 */
export const RECORD_ID_SOURCES = Object.freeze(['URL_PATH_PATTERN', 'ELEMENT'] as const);
export type RecordIdSource = (typeof RECORD_ID_SOURCES)[number];

/** path の型の中の、登録の ID の場所の印（型にちょうど 1 つ。path の 1 つの区切りの全体。T31b: 候補の識別の owner の印と同じ値）。 */
export const RECORD_ID_PLACEHOLDER = PATH_TEMPLATE_ID_SEGMENT;

/** path の型の最大長（UTF-16 のコード単位。シナリオの要求の path の上限と同じ）。 */
export const MAX_RECORD_ID_PATH_PATTERN_LENGTH = MAX_CANDIDATE_URL_PART_LENGTH;

/** 取り出した登録の ID の最大長（UTF-16 のコード単位。`action-run.json` の `recordId`）。 */
export const MAX_RECORD_ID_LENGTH = 256;

/** 結果の条件の path の前方一致の最大長（Task 26 の結果の条件と同じ上限）。 */
export const MAX_RESULT_CONDITION_PATH_LENGTH = MAX_AUTH_SETUP_URL_LENGTH;

/** 検証の指定のセレクタ（結果の条件、ID の要素）の最大長（Task 26 の結果の条件のセレクタと同じ上限）。 */
export const MAX_VERIFICATION_SELECTOR_LENGTH = MAX_SUCCESS_SELECTOR_LENGTH;

/**
 * 照合の READ で使える期待の種類（Task 27 の期待の種類のうち、1 件の登録を確かめられるもの）。`ROW_COUNT_AT_LEAST` は、二重の登録を見分け
 * られないので使わない。`TEXT_CONTAINS`・`DETAIL_FIELD_EQUALS` の比べる値は、生成した値（送る欄の名前で指す）。
 */
export const VERIFICATION_EXPECTATION_KINDS = Object.freeze(
  ['ROW_COUNT_EQUALS', 'TEXT_CONTAINS', 'DETAIL_FIELD_EQUALS'] as const satisfies readonly ReadCheckExpectationKind[],
);
export type VerificationExpectationKind = (typeof VERIFICATION_EXPECTATION_KINDS)[number];

/** 照合の READ の行の数の期待の最小（登録した 1 件が見えること）と最大（Task 27 の期待の上限）。 */
export const MIN_VERIFICATION_ROW_COUNT = 1;
export const MAX_VERIFICATION_ROW_COUNT = MAX_READ_CHECK_ROW_COUNT;

/** 照合の READ の、生成した値に結び付ける送る値の最大の件数（1 つの READ の定義の送る値の上限と同じ。最小は 1 件）。 */
export const MAX_VERIFICATION_BINDINGS = MAX_READ_CHECK_PARAMETERS;

/** 照合の READ の期待の最大の件数（1 つの READ の定義の期待の上限と同じ。最小は 1 件）。 */
export const MAX_VERIFICATION_EXPECTATIONS = MAX_READ_CHECK_EXPECTATIONS;

// ---------------------------------------------------------------------------------------------------------------
// UPDATE の指定（T31b。Task 31 の設計書 3 章、4 章）
// ---------------------------------------------------------------------------------------------------------------

/** 更新の画面の path と送信先の path の型の最大長（UTF-16 のコード単位。シナリオの要求の path の上限と同じ）。 */
export const MAX_UPDATE_PATH_TEMPLATE_LENGTH = MAX_CANDIDATE_URL_PART_LENGTH;

/** 保つ欄の名前の最大の件数（1 つの候補の欄の数の上限と同じ）。 */
export const MAX_SCENARIO_KEEP_FIELD_NAMES = MAX_CANDIDATE_FIELDS;

/** 人が決める UPDATE の指定（下書きの入力）。 */
export interface ScenarioUpdateDraft {
  /** 台帳の参照（同じプロファイルの、自分でない kind `CREATE` のシナリオの id）。 */
  readonly targetCreateScenarioId: string;
  /** 更新の画面の path の型（`{id}` をちょうど 1 つ、区切りの全体に持つ。query は持たない）。 */
  readonly formPathTemplate: string;
  /** 送信先の path の型（同じ形）。 */
  readonly actionPathTemplate: string;
  /** 保つ欄（見えていて編集できる欄のうち、変える欄（`fieldNames`）でないもの。保存の形では UTF-16 のコード単位の順）。 */
  readonly keepFieldNames: readonly string[];
}

/** UPDATE の指定（シナリオの中身。人の入力に、候補から求めた型にした識別の digest を足したもの。承認の digest の項目）。 */
export interface ScenarioUpdateSpec extends ScenarioUpdateDraft {
  /** 候補の型にした識別の digest（`fingerprint.ts` の `templatedIdentityDigestOf`）。承認の有効性は、これで候補を確かめる。 */
  readonly templatedIdentityDigest: string;
}

/** 下書きの確かめが見る、ほかのシナリオの事実（台帳の参照の確かめ。今の版の kind）。 */
export interface ScenarioKindFact {
  readonly scenarioId: string;
  readonly profileId: string;
  readonly kind: ScenarioKind;
  /**
   * T31R-fix-1 の I-2: 今の版の検証の指定の登録の ID の取り方（未指定なら null。事実を持たない文脈は省く）。UPDATE の path の型の `{id}` の位置を
   * 台帳の取り方に結ぶ確かめ（`scenario-policy.ts` の `isUpdatePathBoundToLedger`）が使う。
   */
  readonly recordId?: ScenarioRecordIdSpec | null;
}

/** 結果の条件（Task 26 の結果の条件と同じ型。`{ pathPrefix, selector }`）。 */
export type ScenarioResultCondition = LoginResultCondition;

/** 登録の ID の取り方。 */
export type ScenarioRecordIdSpec =
  | { readonly source: 'URL_PATH_PATTERN'; readonly pathPattern: string }
  | { readonly source: 'ELEMENT'; readonly selector: string };

/** 照合の READ の送る値 1 つを、生成した値（送る欄）に結び付ける（READ の送る値の名前 → シナリオの送る欄の名前）。 */
export interface VerificationBinding {
  readonly parameterName: string;
  readonly fieldName: string;
}

/** 照合の READ の期待 1 件（`kind` で分かれる閉じた形。比べる値は生成した値を送る欄の名前で指す）。 */
export type VerificationExpectation =
  | { readonly kind: 'ROW_COUNT_EQUALS'; readonly count: number }
  | { readonly kind: 'TEXT_CONTAINS'; readonly fieldName: string }
  | { readonly kind: 'DETAIL_FIELD_EQUALS'; readonly field: string; readonly fieldName: string };

/** 照合の READ（Task 27 の READ の定義の id と版の参照、生成した値への結び付け、期待）。 */
export interface ScenarioReadVerification {
  readonly readCheckId: string;
  readonly revision: number;
  /** 結び付け（1 件以上。READ の送る値の名前の重複なし。保存の形では名前の UTF-16 のコード単位の順）。 */
  readonly bindings: readonly VerificationBinding[];
  /** 期待（1 件以上。入力の順）。 */
  readonly expectations: readonly VerificationExpectation[];
}

/** 検証の指定（項目ごとに、未指定なら null）。 */
export interface ScenarioVerification {
  readonly successCondition: ScenarioResultCondition | null;
  readonly inputErrorCondition: ScenarioResultCondition | null;
  readonly recordId: ScenarioRecordIdSpec | null;
  readonly readVerification: ScenarioReadVerification | null;
}

/** すべて未指定の検証の指定（下書きに検証の指定がないとき、検証の指定の前に保存した版を読むとき）。 */
export const UNSPECIFIED_VERIFICATION: ScenarioVerification = Object.freeze({
  successCondition: null,
  inputErrorCondition: null,
  recordId: null,
  readVerification: null,
});

// ---------------------------------------------------------------------------------------------------------------
// 形
// ---------------------------------------------------------------------------------------------------------------

/** 候補の 2 つの digest（Task 27 の `computeCandidateDigests`）。 */
export interface ScenarioCandidateDigests {
  readonly identityDigest: string;
  readonly ruleDigest: string;
}

/** 要求の形（値は持たない。query の名前は候補の識別の digest が縛る）。 */
export interface ScenarioRequestShape {
  readonly formMethod: typeof SCENARIO_FORM_METHOD;
  readonly methodOverride: ScenarioMethodOverride | null;
  /** 送信先の Origin（`URL.origin`）。 */
  readonly origin: string;
  /** 送信先の path（`/` で始まる。query は持たない）。 */
  readonly path: string;
  readonly enctype: FormEnctype;
}

/** 照らす READ の確かめの定義の参照（id と版）。 */
export interface ReadCheckReference {
  readonly readCheckId: string;
  readonly revision: number;
}

/** 入力の規則の参照（規則の集まりの id・版・digest。中身は Task 29）。参照がないシナリオは null。 */
export interface InputRuleReference {
  readonly ruleSetId: string;
  readonly revision: number;
  readonly digest: string;
}

/** 上限（1 回の Run と累積。既定以下）。 */
export interface ScenarioLimits {
  readonly maxCreatesPerRun: number;
  readonly maxCumulativeCreates: number;
}

/** シナリオの中身（下書きの確かめ `validateScenarioDraft` が、人の入力と候補から作る。ID・版・時刻・入力の規則の参照は保存の部品が足す）。 */
export interface ScenarioContent {
  readonly profileId: string;
  readonly kind: ScenarioKind;
  readonly candidate: ScenarioCandidateDigests;
  readonly request: ScenarioRequestShape;
  /** 送る欄の名前（重複なし。UTF-16 のコード単位の順）。 */
  readonly fieldNames: readonly string[];
  /** 照らす READ の定義の参照（id の重複なし。id の UTF-16 のコード単位の順）。 */
  readonly readChecks: readonly ReadCheckReference[];
  readonly sideEffectConfirmations: SideEffectConfirmations;
  readonly limits: ScenarioLimits;
  readonly approvalTtlDays: number;
  /** 検証の指定（T30a）。 */
  readonly verification: ScenarioVerification;
  /**
   * UPDATE の指定（T31b）。`CREATE` は null。`UPDATE` の下書きの確かめは必須にする（UPDATE の指定の前に保存した UPDATE の版だけが null で、
   * 承認と発行はできない）。
   */
  readonly update: ScenarioUpdateSpec | null;
}

/** シナリオの版 1 つ（変えない写し。`schemas/control/scenario.schema.json` の形。日時は UTC の 14 桁）。 */
export interface ScenarioRevision extends ScenarioContent {
  readonly schemaVersion: typeof SCENARIO_SCHEMA_VERSION;
  readonly scenarioId: string;
  readonly revision: number;
  readonly inputRuleReference: InputRuleReference | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 承認が縛った事実の値（承認の記録に固定する。比べるのは `approval-validity.ts`）。 */
export interface ApprovalBoundFacts {
  /** プロファイルの改訂（`profile_revisions`。どの編集でも上がる）。 */
  readonly profileRevision: number;
  /** 認証の設定の digest（`sha256:<16進64桁>`。設定がなければ null）。 */
  readonly authSetupDigest: string | null;
  /** ターゲットの設定の digest（`targetConfigDigestOf` の形。小文字の 16 進 64 桁）。 */
  readonly targetConfigDigest: string;
  readonly candidateIdentityDigest: string;
  readonly candidateRuleDigest: string;
  readonly inputRuleReference: InputRuleReference | null;
}

/** 承認の記録（追記だけ。`approval-receipt.schema.json` の `approval`）。 */
export interface ApprovalReceipt {
  readonly schemaVersion: typeof APPROVAL_RECEIPT_SCHEMA_VERSION;
  readonly kind: 'APPROVAL';
  readonly receiptId: string;
  readonly profileId: string;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  /** 承認の digest（`computeApprovalDigest`）。 */
  readonly approvalDigest: string;
  readonly bound: ApprovalBoundFacts;
  readonly approvedAt: string;
  /** 期限の時刻（`approvalExpiresAtOf(approvedAt, approvalTtlDays)`）。 */
  readonly expiresAt: string;
  readonly approver: typeof APPROVER_LOCAL_OPERATOR;
}

/** 撤回の記録（追記だけ。`approval-receipt.schema.json` の `revocation`）。 */
export interface RevocationReceipt {
  readonly schemaVersion: typeof APPROVAL_RECEIPT_SCHEMA_VERSION;
  readonly kind: 'REVOCATION';
  readonly receiptId: string;
  readonly profileId: string;
  readonly scenarioId: string;
  /** 撤回した承認の記録の id。 */
  readonly targetReceiptId: string;
  readonly revokedAt: string;
  readonly reason: RevocationReason;
}

/** 承認の記録 1 件（承認か撤回）。 */
export type ApprovalReceiptRecord = ApprovalReceipt | RevocationReceipt;

/** 照らす READ の定義の今の事実（READ の確かめの定義の保存の owner `read-check-store.ts` の読み出しの形から、要る項目だけ）。 */
export type ScenarioReadCheckFact = Pick<ReadCheckView, 'readCheckId' | 'profileId' | 'revision' | 'canceledAt'>;

/**
 * 照らす READ の定義の今の事実に、今の版の送る値の名前（定義の順）を足したもの（T30a。下書きの確かめが、照合の READ の結び付けを確かめる。
 * 値は持たない）。
 */
export interface ScenarioReadCheckDefinitionFact extends ScenarioReadCheckFact {
  readonly parameterNames: readonly string[];
}

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
//   下書きでは必須、`CREATE` は持てない（null）。LG-3: UPDATE の指定の前に保存した UPDATE の版（null）は、スキーマが拒むので読まない。変える欄は今の送る欄（`fieldNames`）、保つ欄は `keepFieldNames`。path の型の `{id}` の印は、候補の識別の
//   owner（`src/discovery/fingerprint.ts` の `PATH_TEMPLATE_ID_SEGMENT`）と同じ値（登録の ID の取り方の path の型と共用）。
import { WRITE_AUDIT_MODE } from '../contracts.js';
import {
  MAX_AUTH_SETUP_URL_LENGTH,
  MAX_SUCCESS_SELECTOR_LENGTH,
  type LoginResultCondition,
} from '../auth/auth-setup-contracts.js';
import type { ReadCheckView } from '../job/read-check-store.js';
import { WORKER_JOB_ID_PATTERN } from '../worker-protocol.js';
import { API_SCENARIO_TRANSPORT, FORM_SCENARIO_TRANSPORT, type ScenarioTransport } from '../../core/scenario-transport.js';
import { SCENARIO_KINDS as CORE_SCENARIO_KINDS, type ScenarioKind } from '../../core/scenario-kind.js';
import { isPublicationStateKeyName } from '../../discovery/classify.js';
import { PATH_TEMPLATE_ID_SEGMENT } from '../../discovery/fingerprint.js';
import {
  API_WRITE_METHODS,
  MAX_API_SHAPE_BODY_KEYS,
  MAX_API_SHAPE_HEADER_NAMES,
  MAX_API_SHAPE_MEDIA_TYPE_LENGTH,
  MAX_API_SHAPE_NAME_LENGTH,
  MAX_API_SHAPE_PATH_LENGTH,
  type API_SELECTION_QUERY_NAMES,
  type ApiJsonValueType,
  type ApiPreferShape,
} from '../../core/api-request-shape.js';
import {
  MAX_SUBMISSION_PROBE_FIELD_SELECTOR_LENGTH,
  submissionProbeKeyFieldsOf,
  type SubmissionProbeInputField,
  type SubmissionProbeRecord,
} from '../../discovery/submission-probe-contracts.js';
import { createSha256Fingerprint } from '../../core/ids.js';
// PRE42-CC 組 UI-K3（台帳の CC-113）: 照合の READ の期待の種類の値（画面のブラウザ側も読む、import を持たない純粋な core のファイル）。ここは公開し直す。
import { VERIFICATION_EXPECTATION_KINDS, type VerificationExpectationKind } from '../../core/read-check-expectation-kinds.js';
import { compareCodeUnits } from '../../core/text.js';
import { DAY_MS, MINUTE_MS } from '../../core/time-units.js';
import { API_FIELD_IDENTITY_KINDS, apiFieldIdentityValueOf, type ApiFieldIdentity, type ApiFieldIdentityKind } from '../../core/api-field-identity.js';
import {
  MAX_CANDIDATE_FIELDS,
  MAX_CANDIDATE_URL_PART_LENGTH,
  type CandidateClassification,
  type CandidateFieldType,
  type FormEnctype,
  type FormMethod,
  type MethodOverride,
} from '../../discovery/candidate-contracts.js';
import {
  MAX_READ_CHECK_DEFINITIONS_PER_PROFILE,
  MAX_READ_CHECK_EXPECTATIONS,
  MAX_READ_CHECK_PARAMETERS,
  MAX_READ_CHECK_ROW_COUNT,
  type ReadCheckTargetKind,
} from '../../discovery/read-check-contracts.js';

// ---------------------------------------------------------------------------------------------------------------
// 版の印と閉じた一覧
// ---------------------------------------------------------------------------------------------------------------

/** シナリオの版の文書の形の印（スキーマの `schemaVersion` の const）。 */
export const SCENARIO_SCHEMA_VERSION = 'beaksight-scenario/1';

/** 承認と撤回の記録の文書の形の印（スキーマの `schemaVersion` の const）。 */
export const APPROVAL_RECEIPT_SCHEMA_VERSION = 'beaksight-approval-receipt/1';

/**
 * シナリオの種類の値の名前つきの定数（登録 `CREATE_SCENARIO_KIND`・更新 `UPDATE_SCENARIO_KIND`）。CC-106: 契約の owner は `src/core/scenario-kind.ts`
 * （PRE42-CC の組 2。IPC の契約と画面のブラウザ側も読めるように core に置いた）。ここは公開し直すだけ。`'CREATE' satisfies ScenarioKind` を書き写さない。
 */
export { CREATE_SCENARIO_KIND, UPDATE_SCENARIO_KIND } from '../../core/scenario-kind.js';
export type { ScenarioKind };

/** シナリオの種類（候補の分類のうち、書き込みの 2 つ。core の一覧と同じ凍結した配列。候補の分類の一部であることを、ここで型で確かめる）。 */
export const SCENARIO_KINDS = CORE_SCENARIO_KINDS satisfies readonly CandidateClassification[];

/** シナリオの保存する状態（管理データの行）。`EXPIRED` は保存しない（読むときに時計から求める）。 */
/** 下書きの状態（`SCENARIO_STATES` の値の名前つきの定数。FM2R の Minor 13: ほかのファイルは、ここから読む）。 */
export const DRAFT_SCENARIO_STATE = 'DRAFT';
export const SCENARIO_STATES = Object.freeze([DRAFT_SCENARIO_STATE, 'APPROVED', 'REVOKED'] as const);
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
 * T40a-fix（Task 40 の設計書 7 章の「T40a の報告（API の検証の指定）」）: API のシナリオの検証の指定で求める項目（`SCENARIO_VERIFICATION_ITEMS` の
 * 部分。同じ順）。結果の判定は送り手の応答の状態と ID で行うので、成否の条件と入力の誤りの条件は求めず、使わない。`recordId` は、API の指定の
 * `recordId`（応答の本文の鍵）か検証の指定の `recordId` のどちらかがあればよい（判定は `scenario-policy.ts` の `missingVerificationItemsOf`）。
 */
export const API_SCENARIO_VERIFICATION_ITEMS = Object.freeze(['recordId', 'readVerification'] as const satisfies readonly ScenarioVerificationItem[]);
/**
 * T41e-2（T41b の申し送り。Task 41 の設計書 3.4 の 3）: API の更新（台帳の参照 `api.ledger` を持つ）で求める項目（照合の READ だけ。登録の ID は許可が
 * 台帳から選ぶ対象の ID）。
 */
export const API_UPDATE_SCENARIO_VERIFICATION_ITEMS = Object.freeze(['readVerification'] as const satisfies readonly ScenarioVerificationItem[]);

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
 * られないので使わない。`TEXT_CONTAINS`・`DETAIL_FIELD_EQUALS` の比べる値は、生成した値（送る欄の名前で指す）。PRE42-CC 組 UI-K3: 一覧の値は
 * `src/core/read-check-expectation-kinds.ts` に移し、ここは同じ名前で公開し直す。
 */
export { VERIFICATION_EXPECTATION_KINDS, type VerificationExpectationKind };

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

// ---------------------------------------------------------------------------------------------------------------
// 送り方と API のシナリオ（T38b。Task 38 の設計書 3.2、7 章の履歴のユーザーの判断）
// ---------------------------------------------------------------------------------------------------------------

/**
 * シナリオの送り方（閉じた一覧 `SCENARIO_TRANSPORTS`）と、送り方の値の名前つきの定数（`FORM_SCENARIO_TRANSPORT`・`API_SCENARIO_TRANSPORT`）。
 * - `FORM`: form の送信（Task 28〜32 の今のシナリオ。送り方の項目のない前の文書も `FORM`）。
 * - `API`: ページのスクリプトが承認した API の Origin へ送る要求（Task 37 の probe の `API_CREATE`・`API_UPDATE` の候補）。
 * T40R-fix-B（Task 40 の設計書 7 章の「T40R」の行の M-2）: 定義は core の `scenario-transport.ts`（IPC の契約がこのファイルを読めない（循環する）ため。
 * CC-102 の欄の識別と同じ置き方）。ここは公開し直すだけ。記録の要約・台帳・承認の要約の項目・IPC・書き込みの流れ・画面のサーバは、この定数を使う。
 */
export { API_SCENARIO_TRANSPORT, FORM_SCENARIO_TRANSPORT, SCENARIO_TRANSPORTS } from '../../core/scenario-transport.js';
export type { ScenarioTransport } from '../../core/scenario-transport.js';

/** API のシナリオの method（`POST` は CREATE、`PATCH` は UPDATE。probe の分類と同じ組。T39a: 一覧は core の `API_WRITE_METHODS`）。 */
export const SCENARIO_API_METHODS = API_WRITE_METHODS;
export type ScenarioApiMethod = (typeof SCENARIO_API_METHODS)[number];

/**
 * 欄の識別の種類（`name` があれば名前、なければその画面で一意な CSS。T38a の申し送り）。CC-102: 契約の owner は `src/core/api-field-identity.ts`
 * （書き込みの入力の部品と共有する）。ここは公開し直すだけ。
 */
export const SCENARIO_API_FIELD_IDENTITY_KINDS = API_FIELD_IDENTITY_KINDS;
export type ScenarioApiFieldIdentityKind = ApiFieldIdentityKind;

/** API のシナリオの登録の ID の取り方（応答の本文の鍵。指定しなければ、検証の指定の今の取り方）。 */
export const SCENARIO_API_RECORD_ID_SOURCES = Object.freeze(['RESPONSE_BODY_KEY'] as const);
export type ScenarioApiRecordIdSource = (typeof SCENARIO_API_RECORD_ID_SOURCES)[number];

/**
 * ブラウザ（Chromium）が要求に付けるヘッダの名前の閉じた一覧と、ページが付けた名前かの判定（ユーザーの判断「ヘッダの名前は結ぶ。ブラウザが付ける名前は
 * 除く」）。T39a で、書き込みの段の照合（`src/safety/`）も読めるよう `src/core/api-request-shape.ts` へ移した。ここは、今までの呼び出し側のために
 * 再び export する（第二の一覧を持たない）。
 */
export { BROWSER_SUPPLIED_HEADER_NAMES, BROWSER_SUPPLIED_HEADER_NAME_PREFIXES, isPageSuppliedHeaderName } from '../../core/api-request-shape.js';

/** API のシナリオの鍵（本文の鍵、ページが決める鍵）の最大の件数（probe の型の鍵の上限と同じ）。 */
export const MAX_SCENARIO_API_KEYS = MAX_API_SHAPE_BODY_KEYS;
/** 許すヘッダの名前の最大の件数（probe の型のヘッダの名前の上限と同じ）。 */
export const MAX_SCENARIO_API_HEADER_NAMES = MAX_API_SHAPE_HEADER_NAMES;
/** 鍵・ヘッダ・filter・query の名前の最大長（probe の型の名前の上限と同じ）。 */
export const MAX_SCENARIO_API_KEY_LENGTH = MAX_API_SHAPE_NAME_LENGTH;
/** path の型の最大長（probe の型の path の上限と同じ）。 */
export const MAX_SCENARIO_API_PATH_LENGTH = MAX_API_SHAPE_PATH_LENGTH;
/** `Content-Type` の媒体の型の最大長（probe の型の上限と同じ）。 */
export const MAX_SCENARIO_API_MEDIA_TYPE_LENGTH = MAX_API_SHAPE_MEDIA_TYPE_LENGTH;
/** 欄の CSS の最大長（probe の欄の識別の上限と同じ）。 */
export const MAX_SCENARIO_API_FIELD_SELECTOR_LENGTH = MAX_SUBMISSION_PROBE_FIELD_SELECTOR_LENGTH;

/** 欄の識別（値は持たない。CC-102: 契約の owner `src/core/api-field-identity.ts` の公開し直し）。 */
export type ScenarioApiFieldIdentity = ApiFieldIdentity;

/**
 * 欄の型ごとの、受ける値の JSON の型（目印を入れる欄だけ。ほかの欄は鍵に対応しない）。T38b の下書きの確かめと、T38e の入力の規則の判定
 * （`field-evaluation.ts`）が使う唯一の表。
 */
export const SCENARIO_API_FIELD_JSON_TYPES: Readonly<Partial<Record<CandidateFieldType, readonly ApiJsonValueType[]>>> = Object.freeze({
  text: ['string'],
  search: ['string'],
  email: ['string'],
  url: ['string'],
  tel: ['string'],
  date: ['string'],
  textarea: ['string'],
  number: ['number'],
});

/**
 * 送る鍵の欄の型（T38R2-fix の M-2。`SCENARIO_API_FIELD_JSON_TYPES` の欄の型。そこから作る。スキーマの `$defs/apiFieldType` の enum と一致する）。
 * 下書きは、この型の欄の鍵だけを送れる（ほかの型は `SCENARIO_API_FIELD_TYPE_MISMATCH`）。
 */
export const SCENARIO_API_FIELD_TYPES: readonly CandidateFieldType[] = Object.freeze(Object.keys(SCENARIO_API_FIELD_JSON_TYPES) as CandidateFieldType[]);

/** 欄の型と鍵の JSON の型の組が、`SCENARIO_API_FIELD_JSON_TYPES` の組か。 */
export const isScenarioApiFieldJsonTypePair = (fieldType: CandidateFieldType, jsonType: ApiJsonValueType): boolean =>
  (SCENARIO_API_FIELD_JSON_TYPES[fieldType] ?? []).includes(jsonType);

/** probe の欄の識別（`name` があれば名前、なければ CSS。どちらもなければ null）。下書きの確かめと入力の規則の判定が使う唯一の決まり。 */
export const scenarioApiFieldIdentityOf = (field: SubmissionProbeInputField): ScenarioApiFieldIdentity | null => {
  if (field.name !== null && field.name.length > 0) {
    return { kind: 'NAME', name: field.name };
  }
  return field.selector !== null && field.selector.length > 0 ? { kind: 'SELECTOR', selector: field.selector } : null;
};

/**
 * probe の型の、欄に対応する鍵と、その欄の識別と型（T38R-fix の I-1、T38R2-fix の M-2。`submissionProbeKeyFieldsOf` の鍵のうち、欄を持ち、欄の識別
 * （`scenarioApiFieldIdentityOf`）を作れるもの。鍵の UTF-16 のコード単位の順。値は持たない）。索引の鍵と欄の digest と、画面の案が使う。
 */
export const scenarioApiKeyFieldsOfProbe = (probe: SubmissionProbeRecord): readonly ScenarioApiKeyField[] =>
  Object.freeze(submissionProbeKeyFieldsOf(probe)
    .flatMap(({ key, type, field }) => {
      const identity = field === null ? null : scenarioApiFieldIdentityOf(field);
      return field === null || identity === null ? [] : [Object.freeze({ key, type, field: identity, fieldType: field.type })];
    })
    .sort((left, right) => compareCodeUnits(left.key, right.key)));

/** 鍵と欄の対応の digest の形の印（版つき。T38R-fix の I-1。T38R2-fix の M-2 で欄の型を足して 2 にした。版 13 とともに未公開）。 */
export const API_KEY_FIELDS_DIGEST_FORMAT = 'beaksight:api-key-fields/2';

/**
 * 鍵と欄の対応の digest（T38R-fix の I-1。索引（`discovery-index-store.ts`）と、承認の有効性（`approval-validity.ts`）が照らす唯一の作り方）。型の digest と、
 * 鍵ごとの `[鍵, JSON の型, 欄の識別の種類, 名前か CSS, 欄の型]` を鍵の順に並べた JSON の SHA-256。欄の識別か欄の型（T38R2-fix の M-2。text と number の
 * 入れ替えなど）が変われば、型が同じでも digest が変わる。
 */
export const apiKeyFieldsDigestOf = (shapeDigest: string, keyFields: readonly ScenarioApiKeyField[]): string =>
  createSha256Fingerprint(JSON.stringify([
    API_KEY_FIELDS_DIGEST_FORMAT,
    shapeDigest,
    [...keyFields]
      .sort((left, right) => compareCodeUnits(left.key, right.key))
      .map(({ key, type, field, fieldType }) => [key, type, field.kind, apiFieldIdentityValueOf(field), fieldType]),
  ]));

/** 2 つの欄の識別が同じか。 */
export const isSameScenarioApiFieldIdentity =(left: ScenarioApiFieldIdentity, right: ScenarioApiFieldIdentity): boolean =>
  (left.kind === 'NAME' ? right.kind === 'NAME' && left.name === right.name : right.kind === 'SELECTOR' && left.selector === right.selector);

/** 送る鍵 1 つ（本文の鍵、値の JSON の型、目印を入れた欄、その欄の型）。 */
export interface ScenarioApiKeyField {
  readonly key: string;
  readonly type: ApiJsonValueType;
  readonly field: ScenarioApiFieldIdentity;
  /** 目印を入れた欄の型（T38R2-fix の M-2。probe の欄の型。`SCENARIO_API_FIELD_TYPES` のどれか）。 */
  readonly fieldType: CandidateFieldType;
}

/** ページが決める鍵 1 つ（欄に対応しない鍵のうち、承認で名前を示したもの。登録では値は照らさない）。 */
export interface ScenarioApiPageKey {
  readonly key: string;
  readonly type: ApiJsonValueType;
  /**
   * T41a（Task 41 の設計書 3.3、ユーザーの判断 2）: 更新の画面の欄としての識別（UPDATE だけ。probe が選んだ欄（目印なし）のうち、名前が鍵と同じ欄が
   * ちょうど 1 つ）。Guard は前の読み取りで読んだ値と照らす（T41c）。登録は持たない。
   */
  readonly field?: ScenarioApiFieldIdentity;
}

/** API の要求の型（値を持たない。probe の型から作る）。 */
export interface ScenarioApiRequestShape {
  readonly method: ScenarioApiMethod;
  /** 送り先の Origin（承認したサービスの Origin の文字列。probe の型の番号でなく文字列で持つ）。 */
  readonly origin: string;
  /** path の型（probe の型の `pathShape`）。 */
  readonly pathShape: string;
  /** 許す query の名前（`select` だけ。filter の名前は `filterName`）。 */
  readonly queryNames: readonly (typeof API_SELECTION_QUERY_NAMES)[number][];
  readonly contentType: string | null;
  readonly prefer: readonly ApiPreferShape[];
}

/** API のシナリオの登録の ID の取り方（応答の本文の鍵）。 */
export interface ScenarioApiRecordId {
  readonly source: ScenarioApiRecordIdSource;
  readonly key: string;
}

/** API の UPDATE の台帳の参照（同じプロファイルの CREATE のシナリオと、更新の画面の path の型。`{id}` が台帳の ID）。 */
export interface ScenarioApiLedger {
  readonly targetCreateScenarioId: string;
  readonly formPathTemplate: string;
}

/** 人が決める API の指定（下書きの入力。ほかの項目は、候補の probe から作る）。 */
export interface ScenarioApiDraft {
  /** 候補の行を選ぶ型の digest（`candidateOfDiscoveryDocumentByShape`）。 */
  readonly shapeDigest: string;
  /** ページが決める鍵（欄に対応しない鍵のうち、承認で名前を示すもの）の名前。 */
  readonly pageKeys: readonly string[];
  /** UPDATE の filter の名前（型の filter と同じであること。CREATE は null）。 */
  readonly filterName: string | null;
  readonly recordId: ScenarioApiRecordId | null;
  /** UPDATE の台帳の参照（CREATE は null）。 */
  readonly ledger: ScenarioApiLedger | null;
  /**
   * T41a（Task 41 の設計書 3.1）: UPDATE の保つ鍵（目印の付いた欄の鍵のうち、変える鍵（`fieldNames`）でないもの）の名前。省けば、目印の付いた欄の鍵の
   * うち変える鍵でないものをすべて保つ（既定は保つ。メールと電話も保つ）。登録は持てない（持つなら空）。
   */
  readonly keptKeys?: readonly string[];
}

/** API の指定（シナリオの中身。承認の digest v4 の項目は T38c）。 */
export interface ScenarioApiSpec {
  readonly shapeDigest: string;
  readonly request: ScenarioApiRequestShape;
  /** 送る鍵（鍵の UTF-16 のコード単位の順）。T41a: UPDATE では変える鍵（生成した値を作る鍵）だけ。 */
  readonly keyFields: readonly ScenarioApiKeyField[];
  /**
   * T41a（Task 41 の設計書 3.1）: UPDATE の保つ鍵（鍵の順。生成した値を作らない。Guard は本文にあれば前の値と完全一致を求め、なければ通す）。UPDATE は
   * 必ず持つ（空でもよい）。登録は持たない。目印の付いた欄の鍵は、`keyFields` か `keptKeys` のどちらかにちょうど 1 回ある（`scenarioApiMarkedKeyFieldsOf`）。
   */
  readonly keptKeys?: readonly ScenarioApiKeyField[];
  /** ページが決める鍵（鍵の順）。T41a: UPDATE では、どれも欄の識別（`field`）を持つ。 */
  readonly pageKeys: readonly ScenarioApiPageKey[];
  /** 許すヘッダの名前（ページが付ける名前だけ。小文字の順）。 */
  readonly headerNames: readonly string[];
  readonly filterName: string | null;
  readonly recordId: ScenarioApiRecordId | null;
  readonly ledger: ScenarioApiLedger | null;
  /**
   * T41a（Task 41 の設計書 3.1）: UPDATE の候補の、画面の path の最後の ID を `{id}` にした識別の digest（`fingerprint.ts` の
   * `pagePathTemplatedIdentityDigestOf`）。承認の有効性は、これが最新の索引にあることで判定し、ワーカー（T41d）は対象の ID の画面の候補で求め直して照らす。
   * UPDATE は必ず持つ（LG-3: T41a の前に保存した、持たない版は、スキーマが拒むので読まない）。登録は持たない。
   */
  readonly templatedIdentityDigest?: string;
}

/**
 * 目印の付いた欄の鍵の全体（T41a。変える鍵 `keyFields` と保つ鍵 `keptKeys` を合わせて鍵の順に並べた写し）。索引の鍵と欄の対応の digest
 * （`apiKeyFieldsDigestOf`。probe の欄に対応する鍵の全体から作る）と照らすときに使う。
 */
export const scenarioApiMarkedKeyFieldsOf = (api: Pick<ScenarioApiSpec, 'keyFields' | 'keptKeys'>): readonly ScenarioApiKeyField[] =>
  [...api.keyFields, ...(api.keptKeys ?? [])].sort((left, right) => compareCodeUnits(left.key, right.key));

/**
 * DEF-147（設計書 `2026-10-21-beaksight-api-state-keys-design.md` 2 章）: API のシナリオの鍵のうち、公開の状態にあたる鍵（status・is_published・
 * published_at など。`isPublicationStateKeyName`）の名前（変える鍵、保つ鍵、ページが決める鍵から。重なりなし、鍵の順）。承認の画面と作成の画面が、注意の印を
 * 出すために使う（判断は持たない。値は持たない）。
 */
export const scenarioApiPublicationStateKeysOf = (
  api: Pick<ScenarioApiSpec, 'keyFields' | 'keptKeys' | 'pageKeys'>,
): readonly string[] => Object.freeze([...new Set([...api.keyFields, ...(api.keptKeys ?? []), ...api.pageKeys]
  .map(({ key }) => key)
  .filter(isPublicationStateKeyName))]
  .sort(compareCodeUnits));

/** シナリオの送り方（項目のない前の文書と FORM の中身は `FORM`）。 */
export const scenarioTransportOf = (content: Pick<ScenarioContent, 'transport'>): ScenarioTransport => content.transport ?? FORM_SCENARIO_TRANSPORT;

/**
 * UPDATE のシナリオの台帳の参照（T41b で `scenario-store.ts` に作り、T41R2-fix-B で同じ台帳のシナリオの集まり（`scenario-facts.ts` の
 * `writeFamilyScenarioIdsIn`）と共用するためにここへ移した唯一の決まり）: form の UPDATE は UPDATE の指定の、API の UPDATE は API の指定の台帳
 * （`api.ledger`）の CREATE のシナリオ。UPDATE でない・台帳の参照がないシナリオは null。
 */
export const updateLedgerScenarioIdOf = (scenario: Pick<ScenarioContent, 'kind' | 'transport' | 'update' | 'api'>): string | null => {
  if (scenario.kind !== 'UPDATE') {
    return null;
  }
  return scenarioTransportOf(scenario) === API_SCENARIO_TRANSPORT
    ? scenario.api?.ledger?.targetCreateScenarioId ?? null
    : scenario.update?.targetCreateScenarioId ?? null;
};

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
  /**
   * T41a（Task 41 の設計書 3.1 の「台帳の ID と filter の結び付け」）: 今の版の API の指定の登録の ID の取り方（応答の本文の鍵。API の登録でないか未指定
   * なら null。事実を持たない文脈は省く）。API の UPDATE の filter の名前を台帳の ID に結ぶ確かめ（`scenario-policy.ts` の
   * `apiUpdateLedgerBindingRejectionOf`）が使う。
   */
  readonly apiRecordId?: ScenarioApiRecordId | null;
  /**
   * T41R-fix-B（Task 41 の設計書 8 章の「T41R の完全版」の I-1）: 今の版の API の要求の送り先（Origin の文字列と path の型。API のシナリオでなければ null。
   * 事実を持たない文脈は省く）。API の更新の台帳が、同じ表（同じ Origin と path の型）の API の登録であることの確かめ（`apiUpdateLedgerBindingRejectionOf`）が使う。
   */
  readonly apiRequest?: Pick<ScenarioApiRequestShape, 'origin' | 'pathShape'> | null;
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

/** すべて未指定の検証の指定（下書きに検証の指定がないとき）。 */
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
  /**
   * T38b: 送り方（`scenarioTransportOf`）。FORM のシナリオは項目を持たない（送り方の項目の前に保存した文書と同じ形のまま。`FORM` を書いた文書も
   * 読める）。API のシナリオは `API`。
   */
  readonly transport?: ScenarioTransport;
  /** form の要求の形。T38b: API のシナリオは null（要求の型は `api`）。 */
  readonly request: ScenarioRequestShape | null;
  /** T38b: API の指定（API のシナリオだけ。FORM のシナリオは持たない）。 */
  readonly api?: ScenarioApiSpec;
  /** 送る欄の名前（重複なし。UTF-16 のコード単位の順）。T38b: API のシナリオは、送る本文の鍵（`api.keyFields` の鍵）。 */
  readonly fieldNames: readonly string[];
  /** 照らす READ の定義の参照（id の重複なし。id の UTF-16 のコード単位の順）。 */
  readonly readChecks: readonly ReadCheckReference[];
  readonly sideEffectConfirmations: SideEffectConfirmations;
  readonly limits: ScenarioLimits;
  readonly approvalTtlDays: number;
  /** 検証の指定（T30a）。 */
  readonly verification: ScenarioVerification;
  /**
   * UPDATE の指定（T31b）。`CREATE` と API のシナリオは null。form の `UPDATE` は必須（下書きの確かめとスキーマ。LG-3: 前に保存した null の版は
   * 読まない）。
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
  /**
   * T37d fix round 1: 定義の対象の種類（`read-check-contracts.ts` の `READ_CHECK_TARGET_KINDS`。省略は候補）。画面の path を読む定義は、照合の READ に
   * 使わない（下書きの確かめが拒む）。
   */
  readonly targetKind?: ReadCheckTargetKind;
  /**
   * T38c: 画面の path の定義が `{id}` つきの型か（`read-check-contracts.ts` の `isReadCheckPageTemplatePath`。画面の path の定義だけが持つ。省略は型で
   * ない）。API のシナリオだけ、型の定義を照合の READ に使える（結び付けは 0 件。`{id}` には台帳の ID だけを入れる。実際の照合は Task 40）。
   */
  readonly pageTemplate?: boolean;
}

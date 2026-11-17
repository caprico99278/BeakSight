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
// - PL-6a（設計書 `2026-10-26-beaksight-plain-ui-design.md` 8.1。設計者の判断 (a)〜(f)）: 検証の指定の成功の条件と入力の誤りの条件（人が入れる path の
//   前方一致と CSS セレクタ）を、結果の判定のしかたの印（`resultJudgement`。form は `FORM_STRUCTURE`、API は null）に置き換えた。form の登録の ID の取り方は
//   ID の型の一覧（`FormRecordIdSpec`。`URL_PATH_PATTERNS`、2 つまで）だけ。照合の READ に照合の専用の印（`verificationOnly`）を足した。前の文書の成否の
//   条件の項目（`RETIRED_SCENARIO_VERIFICATION_ITEMS`）は、スキーマが受け、読むときに捨てる。
import { WRITE_AUDIT_MODE } from '../contracts.js';
import type { LoginResultCondition } from '../auth/auth-setup-contracts.js';
import type { ReadCheckView } from '../job/read-check-store.js';
import { WORKER_JOB_ID_PATTERN } from '../worker-protocol.js';
import { API_SCENARIO_TRANSPORT, FORM_SCENARIO_TRANSPORT, type ScenarioTransport } from '../../core/scenario-transport.js';
import { SCENARIO_KINDS as CORE_SCENARIO_KINDS, type ScenarioKind } from '../../core/scenario-kind.js';
import { isPublicationStateKeyName } from '../../discovery/classify.js';
import { PATH_TEMPLATE_ID_SEGMENT } from '../../discovery/fingerprint.js';
import {
  API_WRITE_METHODS,
  apiArrayFieldPositionsOf,
  apiArrayObjectRowsOf,
  type ApiArrayFieldPosition,
  type ApiArrayRowRole,
  type API_SELECTION_QUERY_NAMES,
  type ApiJsonValueType,
  type ApiPreferShape,
} from '../../core/api-request-shape.js';
import {
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
  type CandidateClassification,
  type CandidateFieldType,
  type FormEnctype,
  type FormMethod,
  type MethodOverride,
} from '../../discovery/candidate-contracts.js';
import type { ReadCheckTargetKind } from '../../discovery/read-check-contracts.js';

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

/**
 * 新しく作るシナリオに入れる承認の期限の日数（前の既定と同じ値）。LZ-3c: 承認の digest の版を変えないための名残。判定には使わない（承認は期限で切れない。
 * L12b）。利用者には見せず、上限もない（前に保存した値はそのまま読む）。
 */
export const APPROVAL_TTL_DAYS = 30;

/** 承認の期限の 1 日の長さ（ms。UTC の暦の 1 日）。期限の時刻の計算は `approval-validity.ts` の `approvalExpiresAtOf` だけが使う。 */
export const APPROVAL_TTL_DAY_MS = DAY_MS;

/** 1 回の Run の書き込みの件数の上限の既定（UPDATE も同じ値。Task 31 で見直す）。 */
export const DEFAULT_MAX_CREATES_PER_RUN = 1;

/**
 * 新しく作るシナリオに入れる累積の件数（前の既定と同じ値。UPDATE も同じ）。LZ-3c: 承認の digest の版を変えないための名残。判定には使わない（累積の上限は
 * L12b で撤廃した）。利用者には見せず、上限もない（前に保存した値はそのまま読む）。
 */
export const DEFAULT_MAX_CUMULATIVE_CREATES = 20;

/** 書き込みのジョブの同時実行の数。 */
export const WRITE_JOB_CONCURRENCY = 1;

/** 実行の許可（ExecutionGrant）の期限（ms。許可を発行してから書き込みのジョブを始めるまで。1 回だけ使える）。 */
export const EXECUTION_GRANT_TTL_MS = 5 * MINUTE_MS;

// LZ-3c: 連続の書き込みの間隔（前は `MIN_WRITE_INTERVAL_MS` 5 分）と 24 時間の件数（前は `MAX_WRITES_PER_DAY` 5 件・`WRITE_RATE_WINDOW_MS`）は、L12b で
// 撤廃した後の名残として捨てた。

/** シナリオの上限の最小。 */
export const MIN_SCENARIO_LIMIT = 1;

/** シナリオの期限の日数の最小。 */
export const MIN_APPROVAL_TTL_DAYS = 1;

/** シナリオの版（と、照らす READ の定義の版、入力の規則の版）の最小。 */
export const MIN_SCENARIO_REVISION = 1;

// L13（N28）・L4（COV-7）: 送る欄の名前の数と、照らす READ の定義の参照の数の上限は撤廃した（定数は LZ-1 で消した）。

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
 * - `resultJudgement`（PL-6a。設計書 `2026-10-26-beaksight-plain-ui-design.md` 8.1。人が入れた成功の条件と入力の誤りの条件を置き換えた）: 結果の判定の
 *   しかたの印。form のシナリオは構造の判定（`FORM_STRUCTURE_RESULT_JUDGEMENT`。下書きの確かめが付ける。人は入れない）、API のシナリオは null（応答の
 *   状態で決めるので使わない）。
 * - `recordId`: 登録の ID の取り方。
 * - `readVerification`: 生成した値で読み直す照合の READ。
 */
export const SCENARIO_VERIFICATION_ITEMS = Object.freeze(['resultJudgement', 'recordId', 'readVerification'] as const);
export type ScenarioVerificationItem = (typeof SCENARIO_VERIFICATION_ITEMS)[number];

/**
 * PL-6a: 結果の判定のしかたの印（閉じた一覧）。`FORM_STRUCTURE`: form の書き込みの構造の判定（`src/control/actions/action-outcome.ts` の
 * `formResultJudgementOf`。照合と、送った値を保った同じフォームの形と、URL の ID の型で決める）。承認の digest の項目なので、判定のしかたを変えたら印を変える。
 */
export const FORM_STRUCTURE_RESULT_JUDGEMENT = 'FORM_STRUCTURE';
export const SCENARIO_RESULT_JUDGEMENTS = Object.freeze([FORM_STRUCTURE_RESULT_JUDGEMENT] as const);
export type ScenarioResultJudgement = (typeof SCENARIO_RESULT_JUDGEMENTS)[number];

/** PL-6a: form のシナリオで求める項目（`SCENARIO_VERIFICATION_ITEMS` のすべて。同じ順）。 */
export const FORM_SCENARIO_VERIFICATION_ITEMS = SCENARIO_VERIFICATION_ITEMS;

/**
 * PL-6a（設計書 8.1 の「契約の変更」。LG の決まり（設計者の判断 (c)）: 前の文書の成否の条件の項目）: 前に保存したシナリオの文書が持つ、人が入れた成否の
 * 条件の項目の名前。スキーマは受け、読むとき（`scenario-store.ts`）に捨てる。新しく書く文書は持たない。
 */
export const RETIRED_SCENARIO_VERIFICATION_ITEMS = Object.freeze(['successCondition', 'inputErrorCondition'] as const);

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
 * - `URL_PATH_PATTERN`: 成功の後の URL の path を、型（例 `/items/{id}`）に当てて取る（API のシナリオの画面の取り方）。
 * - `ELEMENT`: 成功の画面の要素（CSS セレクタ）の文字から取る（API のシナリオの画面の取り方）。
 * - `URL_PATH_PATTERNS`（PL-6a。設計書 8.1）: form のシナリオの取り方。送った後の URL を、ID の型（1 つ以上）に順に当てて取る。
 *   form は、この取り方だけを持てる（人が入れる CSS セレクタの `ELEMENT` は使わない）。API は前の 2 つだけ。
 */
export const RECORD_ID_SOURCES = Object.freeze(['URL_PATH_PATTERN', 'ELEMENT', 'URL_PATH_PATTERNS'] as const);
export type RecordIdSource = (typeof RECORD_ID_SOURCES)[number];
/** PL-6a: form のシナリオの ID の取り方の値（`RECORD_ID_SOURCES` の名前つきの定数）。 */
export const FORM_RECORD_ID_SOURCE = 'URL_PATH_PATTERNS' satisfies RecordIdSource;

/** path の型の中の、登録の ID の場所の印（型にちょうど 1 つ。path の 1 つの区切りの全体。T31b: 候補の識別の owner の印と同じ値）。 */
export const RECORD_ID_PLACEHOLDER = PATH_TEMPLATE_ID_SEGMENT;

// URL-LEN: path の型の長さの上限（前は 2,048）は撤廃した。

// LZ-3c: form の登録の ID の型の件数の上限（前は `MAX_FORM_RECORD_ID_PATTERNS` 2。PL-6a）は撤廃した（スキーマにも maxItems を置かない）。型は 1 つ以上で、
// 送った後の URL に順に当てる（判定は `action-outcome.ts` の `recordIdOfResultUrl`）。

// L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。設計者の判断 2）: 取り出した登録の ID の最大長（前は `MAX_RECORD_ID_LENGTH` の
// 256）は撤廃した（`action-run.json` の `recordId` と管理データの `write_results.record_id`。版 19 で列の上限も外した）。

// URL-LEN: 結果の条件の path の前方一致の長さの上限（前は 2,048）は撤廃した。

// LZ-2: 検証の指定のセレクタ（結果の条件、ID の要素）の長さの上限（前は `MAX_VERIFICATION_SELECTOR_LENGTH` 256）は撤廃した。

/**
 * 照合の READ で使える期待の種類（Task 27 の期待の種類のうち、1 件の登録を確かめられるもの）。`ROW_COUNT_AT_LEAST` は、二重の登録を見分け
 * られないので使わない。`TEXT_CONTAINS`・`DETAIL_FIELD_EQUALS` の比べる値は、生成した値（送る欄の名前で指す）。PRE42-CC 組 UI-K3: 一覧の値は
 * `src/core/read-check-expectation-kinds.ts` に移し、ここは同じ名前で公開し直す。
 */
export { VERIFICATION_EXPECTATION_KINDS, type VerificationExpectationKind };

/** 照合の READ の行の数の期待の最小（登録した 1 件が見えること）。 */
export const MIN_VERIFICATION_ROW_COUNT = 1;

// LZ-3a: 照合の READ の行の数（前は `MAX_VERIFICATION_ROW_COUNT` 100,000）・結び付ける送る値の件数（前は `MAX_VERIFICATION_BINDINGS` 50）・期待の件数（前は
// `MAX_VERIFICATION_EXPECTATIONS` 10）の上限は撤廃した（スキーマにも置かない）。

// ---------------------------------------------------------------------------------------------------------------
// UPDATE の指定（T31b。Task 31 の設計書 3 章、4 章）
// ---------------------------------------------------------------------------------------------------------------

// URL-LEN: 更新の画面の path と送信先の path の型の長さの上限（前は 2,048）は撤廃した。

// L13（N28）: 保つ欄の名前の数の上限は撤廃した（定数は LZ-1 で消した）。

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
  /**
   * LU-6（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.4 の 1）: 一覧の行から開く入力の更新（形 B）の、行の選び方（任意。値は持たない）。
   * 型の上だけ（確かめは LU-12。今の下書きの確かめは、この項目を受けない）。
   */
  readonly listRow?: ScenarioListRow;
}

/**
 * LU-6（設計書 5.4 の 1）: 一覧の行の更新の、行の選び方（API の台帳 `ScenarioApiLedger` と form の UPDATE の指定 `ScenarioUpdateDraft` の任意の項目）。
 * 値（行の中身）は持たない。
 * - `listPagePath`: 一覧の画面の path（`{id}` なし。候補の画面の path と同じ）。
 * - `openerIdentityDigest`: 行の中の開き手の識別の digest（probe の記録の `opener.identityDigest`。名前のある開き手だけ。D3）。
 * - `rowKeyField`: 行を選ぶ欄の名前（台帳の登録の、実行のたびに違う値になる欄の 1 つ。`uniqueEachRunFieldNamesOf`）。
 */
export interface ScenarioListRow {
  readonly listPagePath: string;
  readonly openerIdentityDigest: string;
  readonly rowKeyField: string;
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

// L13（N25）・URL-LEN: 鍵の数・ヘッダの名前の数・名前の長さ・媒体の型の長さ・path の型の長さの上限は撤廃した（定数は LZ-1 で消した）。
// LZ-2: 欄の CSS の長さの上限（前は `MAX_SCENARIO_API_FIELD_SELECTOR_LENGTH` 512）も撤廃した。

/** 欄の識別（値は持たない。CC-102: 契約の owner `src/core/api-field-identity.ts` の公開し直し）。 */
export type ScenarioApiFieldIdentity = ApiFieldIdentity;

/**
 * 欄の型ごとの、受ける値の JSON の型（目印を入れる欄だけ。ほかの欄は鍵に対応しない）。T38b の下書きの確かめと、T38e の入力の規則の判定
 * （`field-evaluation.ts`）が使う唯一の表。ARR-2（設計書 `2026-11-08-beaksight-api-array-keys-design.md` 3.3 の 1）: 文字の欄は、文字の一覧（array。
 * 要素は欄の文字 1 つ。要素の型と数は下書きの確かめが probe の型で確かめる）にも入る。
 */
export const SCENARIO_API_FIELD_JSON_TYPES: Readonly<Partial<Record<CandidateFieldType, readonly ApiJsonValueType[]>>> = Object.freeze({
  text: ['string', 'array'],
  search: ['string', 'array'],
  email: ['string', 'array'],
  url: ['string', 'array'],
  tel: ['string', 'array'],
  date: ['string', 'array'],
  textarea: ['string', 'array'],
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
    .flatMap(({ key, type, field, element }) => {
      const keyField = field === null ? null : scenarioApiKeyFieldOfProbe(probe, key, type, field, element);
      return keyField === null ? [] : [keyField];
    })
    .sort((left, right) => compareCodeUnits(left.key, right.key)));

/**
 * ARR-3（設計書 `2026-11-09-beaksight-api-array-rows-design.md` 2.2 の 2）: 欄に対応づけた一覧の鍵の、位置ごとの役（probe の型の位置の情報から。要素が
 * 2 つ以上で、欄 1 つと空の位置の形のときだけ。ほかの鍵・要素 1 つの一覧（DEF-226 の形）・受けない形は undefined）。ARR-4（設計書 2.3）: 要素の位置の欄
 * （`element`）は、欄の位置が 1 つ以上で、その位置が欄の形のとき（一覧の全体の役）。
 */
export const scenarioApiArrayPositionsOfProbe = (
  probe: SubmissionProbeRecord,
  key: string,
  element?: ScenarioApiArrayElementRef,
): readonly ApiArrayFieldPosition[] | undefined => {
  const listKey = element?.key ?? key;
  const elements = probe.shape?.body.keys.find(({ name, type }) => name === listKey && type === 'array')?.elements;
  // ARR-5: 行の中の鍵の欄は、位置の役でなく行の役（`scenarioApiArrayRowsOfProbe`）を持つ。
  const positions = elements === undefined || element?.name !== undefined ? null : apiArrayFieldPositionsOf(elements);
  if (positions === null || positions.length < 2) {
    return undefined;
  }
  const fieldCount = positions.filter((position) => position === 'FIELD').length;
  if (element === undefined) {
    return fieldCount === 1 ? positions : undefined;
  }
  return positions[element.index] === 'FIELD' ? positions : undefined;
};

/**
 * ARR-5（設計書 2.4）: object の一覧の行の中の鍵の欄の、行ごとの中の鍵の役（probe の型の位置の情報から。行の中の鍵の欄で、その鍵が欄の形のときだけ。
 * ほかは undefined）。
 */
export const scenarioApiArrayRowsOfProbe = (
  probe: SubmissionProbeRecord,
  element: ScenarioApiArrayElementRef | undefined,
): readonly (readonly ApiArrayRowRole[])[] | undefined => {
  if (element?.name === undefined) {
    return undefined;
  }
  const elements = probe.shape?.body.keys.find(({ name, type }) => name === element.key && type === 'array')?.elements;
  const rows = elements === undefined ? null : apiArrayObjectRowsOf(elements);
  if (rows === null || !rows.ok) {
    return undefined;
  }
  return rows.rows[element.index]?.some(({ name, role }) => name === element.name && role === 'FIELD') === true ? rows.rows : undefined;
};

/**
 * ARR-4（設計書 2.3）: 一覧の要素の位置の欄の、本文の一覧の鍵と位置（鍵と欄の対応の `key` は道 `key[i]`）。ARR-5（設計書 2.4）: object の行の中の鍵の
 * 欄は、中の鍵の名前も持つ（`key` は道 `key[i].name`）。
 */
export interface ScenarioApiArrayElementRef {
  readonly key: string;
  readonly index: number;
  readonly name?: string;
}

/**
 * 鍵と欄の対応 1 件（欄の識別を作れなければ null）。索引の鍵と欄の digest と、承認の内容が使う唯一の作り方（ARR-3: 欄の一覧の位置の役を持つ）。
 */
export const scenarioApiKeyFieldOfProbe = (
  probe: SubmissionProbeRecord,
  key: string,
  type: ApiJsonValueType,
  field: SubmissionProbeInputField,
  element?: ScenarioApiArrayElementRef,
): ScenarioApiKeyField | null => {
  const identity = scenarioApiFieldIdentityOf(field);
  if (identity === null) {
    return null;
  }
  const positions = type === 'array' ? scenarioApiArrayPositionsOfProbe(probe, key, element) : undefined;
  const rows = type === 'array' ? scenarioApiArrayRowsOfProbe(probe, element) : undefined;
  const elementCopy = element === undefined ? undefined
    : element.name === undefined ? { key: element.key, index: element.index } : { key: element.key, index: element.index, name: element.name };
  return Object.freeze({
    key,
    type,
    field: identity,
    fieldType: field.type,
    ...(elementCopy === undefined ? {} : { element: elementCopy }),
    ...(positions === undefined ? {} : { positions: [...positions] }),
    ...(rows === undefined ? {} : { rows: rows.map((row) => row.map(({ name, role }) => ({ name, role }))) }),
  });
};

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
      .map(apiKeyFieldDigestEntryOf),
  ]));

/** ARR-3: 鍵と欄の対応の digest と承認の digest の、位置の役の値の印（印で、ほかの値と取り違えない）。 */
export const API_ARRAY_POSITIONS_ENTRY_MARK = 'ARRAY_POSITIONS';

/**
 * 鍵と欄の対応 1 件の digest の値（`[鍵, JSON の型, 欄の識別の種類, 名前か CSS, 欄の型]`）。ARR-3（設計書 2.2 の 5）: 位置の役を持つ鍵だけ、末尾に
 * `[印, 役…]` を足す（持たない鍵の値は変えない）。承認の digest（`approval-digest.ts`）も同じ値を使う。
 */
export const apiKeyFieldDigestEntryOf = ({ key, type, field, fieldType, positions, element, rows }: ScenarioApiKeyField): readonly unknown[] => [
  key, type, field.kind, apiFieldIdentityValueOf(field), fieldType,
  ...(positions === undefined ? [] : [[API_ARRAY_POSITIONS_ENTRY_MARK, ...positions]]),
  // ARR-4（設計書 2.3）: 要素の位置の欄だけ、末尾に `[印, 一覧の鍵, 位置]` を足す（持たない鍵の値は変えない）。ARR-5: 行の中の鍵の欄は、中の鍵の名前も足す。
  ...(element === undefined ? [] : [[API_ARRAY_ELEMENT_ENTRY_MARK, element.key, element.index, ...(element.name === undefined ? [] : [element.name])]]),
  // ARR-5（設計書 2.4）: 行の役を持つ欄だけ、`[印, [[中の鍵, 役]…]…]` を足す。
  ...(rows === undefined ? [] : [[API_ARRAY_ROWS_ENTRY_MARK, ...rows.map((row) => row.map(({ name, role }) => [name, role]))]]),
];

/** ARR-5: 鍵と欄の対応の digest と承認の digest の、行の役の値の印。 */
export const API_ARRAY_ROWS_ENTRY_MARK = 'ARRAY_ROWS';

/** ARR-4: 鍵と欄の対応の digest と承認の digest の、要素の位置の値の印。 */
export const API_ARRAY_ELEMENT_ENTRY_MARK = 'ARRAY_ELEMENT';

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
  /**
   * ARR-3（設計書 `2026-11-09-beaksight-api-array-rows-design.md` 2.2 の 2・4）: 型が array で要素が 2 つ以上のときだけ持つ、位置ごとの役（要素の順。
   * 欄 `FIELD` はちょうど 1 つ、ほかは空の位置）。書き込みの段の照合は、位置ごとに一致することを求める。要素 1 つの一覧（DEF-226 の形）は持たない。
   * ARR-4: 要素の位置の欄（`element`）は、一覧の全体の役（欄の位置は 1 つ以上。同じ一覧の鍵の欄はみな同じ役を持つ）。
   */
  readonly positions?: readonly ApiArrayFieldPosition[];
  /**
   * ARR-4（設計書 `2026-11-09-beaksight-api-array-rows-design.md` 2.3）: 欄の印が 2 つ以上入る一覧の、1 つの位置の欄のときだけ持つ、本文の一覧の鍵と
   * 位置（`key` は道 `key[i]`。`apiArrayElementPathOf`）。値は欄ごと（道ごと）に作る。
   */
  readonly element?: ScenarioApiArrayElementRef;
  /**
   * ARR-5（設計書 `2026-11-09-beaksight-api-array-rows-design.md` 2.4）: object の一覧の行の中の鍵の欄（`element.name` あり）だけが持つ、行ごとの中の鍵の役
   * （行の順、中の鍵の名前の順。同じ一覧の鍵の欄はみな同じ役）。書き込みの段の照合は、行の数・行ごとの中の鍵の集合・値を、この役と完全一致で照らす。
   */
  readonly rows?: readonly (readonly ApiArrayRowRole[])[];
}

/**
 * ARR-2（設計書 `2026-11-08-beaksight-api-array-keys-design.md` 3.3 の 2）: ページが決める一覧の鍵（array）の、承認した要素の形（probe の型の
 * `ApiRequestArrayElements` の要素の型の集合と数。値は持たない）。書き込みの段の照合は、送る本文の一覧がこの形と同じことを求める。
 */
export interface ScenarioApiArrayElements {
  /** 要素の JSON の型の集合（scalar だけ。重なりなし、コード単位の順）。 */
  readonly types: readonly ApiJsonValueType[];
  /** 要素の数（L13 fix round 1: 上限なし）。 */
  readonly count: number;
}

/** ページが決める鍵 1 つ（欄に対応しない鍵のうち、承認で名前を示したもの。登録では値は照らさない）。 */
export interface ScenarioApiPageKey {
  readonly key: string;
  readonly type: ApiJsonValueType;
  /** ARR-2: 型が array のときだけ持つ、承認した要素の形（登録だけ。一覧のない鍵は持たない）。 */
  readonly elements?: ScenarioApiArrayElements;
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
  /** 更新の画面の path の型（`{id}` をちょうど 1 つ）。LU-6: 一覧の行の更新（`listRow` あり）では、一覧の画面の path（`listRow.listPagePath` と同じ。`{id}` なし）。 */
  readonly formPathTemplate: string;
  /** LU-6（設計書 5.4 の 1）: 一覧の行の更新の行の選び方（任意。なければ今の更新の画面の更新）。 */
  readonly listRow?: ScenarioListRow;
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
  /**
   * DEF-198（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.9 の 2）: UPDATE の、番号の filter（`filterName`）のほかの filter の名前（所属の
   * 絞り込みなど。名前の順。1 つ以上）。人は入れず、下書きの確かめが probe の型から作る（`apiUpdateFiltersOf`）。ほかの filter のない版は持たない（空の一覧も
   * 持たない。今の承認の digest は変わらない）。照らす値は、同じ点検で登録した行のページが決めた同じ名前の鍵の値（書き込みの段の開始の指定。シナリオは持たない）。
   */
  readonly otherFilterNames?: readonly string[];
  /**
   * DEF-203（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.10 の 2）: UPDATE の本文の、更新の画面の欄と結びつかない鍵（番号・所属の鍵のほか）のうち、
   * 台帳の登録のページが決める鍵にもある鍵の名前（名前の順。1 つ以上）。人は入れず、下書きの確かめが probe の型と台帳の事実から作る。照らす値は、同じ点検で
   * 登録した行のページが決めた同じ名前の鍵の値（書き込みの段の開始の指定 `update.ledgerKeyValues`。シナリオは持たない）。ない版は持たない（空の一覧も持たない）。
   */
  readonly ledgerPageKeys?: readonly string[];
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
  readonly recordId?: ScenarioVerificationRecordId | null;
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
  /**
   * LU-6（設計書 5.4 の 2）: 今の版の、実行のたびに違う値になる欄の名前（値の生成の持ち主の判定 `uniqueEachRunFieldNamesOf`。入力の規則から親が求める。
   * 事実を持たない文脈は省く）。一覧の行の更新の行を選ぶ欄（`listRow.rowKeyField`）が、この中にあることの確かめが使う（省けば拒む。fail-closed）。
   */
  readonly uniqueEachRunFieldNames?: readonly string[] | null;
  /**
   * DEF-203（設計書 5.10 の 2）: 今の版の API の指定のページが決める鍵の名前（API のシナリオでなければ null。事実を持たない文脈は省く）。API の更新の本文の、
   * 欄と結びつかない鍵を、台帳の登録の値と照らす鍵として受けてよいかの確かめ（`scenario-policy.ts` の `ledgerBoundPageKeyNamesOf`）が使う（省けば受けない）。
   */
  readonly apiPageKeyNames?: readonly string[] | null;
}

/** 結果の条件（Task 26 の結果の条件と同じ型。`{ pathPrefix, selector }`）。PL-6a: 前の文書と版 1.1 の記録の、読むだけの形。 */
export type ScenarioResultCondition = LoginResultCondition;

/** 登録の ID の取り方（API のシナリオの、保存の後の画面の取り方）。 */
export type ScenarioRecordIdSpec =
  | { readonly source: 'URL_PATH_PATTERN'; readonly pathPattern: string }
  | { readonly source: 'ELEMENT'; readonly selector: string };

/** PL-6a: form のシナリオの登録の ID の取り方（ID の型 1 件以上。送った後の URL に順に当てる）。 */
export interface FormRecordIdSpec {
  readonly source: typeof FORM_RECORD_ID_SOURCE;
  readonly pathPatterns: readonly string[];
}

/** PL-6a: 検証の指定の登録の ID の取り方（form は `FormRecordIdSpec`、API は `ScenarioRecordIdSpec`。下書きの確かめが送り方で分ける）。 */
export type ScenarioVerificationRecordId = FormRecordIdSpec | ScenarioRecordIdSpec;

/** PL-6a: 登録の ID の取り方が form の取り方か。 */
export const isFormRecordIdSpec = (spec: ScenarioVerificationRecordId | null): spec is FormRecordIdSpec => spec?.source === FORM_RECORD_ID_SOURCE;

/**
 * PL-6a: 登録の ID の取り方の、URL の path の型の一覧（form は型のすべて、API の `URL_PATH_PATTERN` はその型、`ELEMENT` と null は空）。台帳の ID の
 * 結び付けの確かめと、画面の注意が使う。
 */
export const recordIdPathPatternsOf = (spec: ScenarioVerificationRecordId | null): readonly string[] => {
  if (spec === null || spec.source === 'ELEMENT') {
    return [];
  }
  return spec.source === 'URL_PATH_PATTERN' ? [spec.pathPattern] : spec.pathPatterns;
};

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
  /**
   * PL-6a（設計書 8.1 の「契約の変更」、設計者の判断 (f)）: 照合の専用の印（真なら、参照する READ の定義は、このシナリオの照合だけに使い、単独の READ の
   * 確かめのジョブでは読まない。管理データの版を上げずに、シナリオの文書に持つ）。省けば偽（人が作った READ の定義を照合にも使う今の形）。
   */
  readonly verificationOnly?: boolean;
}

/** 検証の指定（項目ごとに、未指定なら null）。PL-6a: 成否の条件の 2 項目を、結果の判定のしかたの印（`resultJudgement`）に置き換えた。 */
export interface ScenarioVerification {
  readonly resultJudgement: ScenarioResultJudgement | null;
  readonly recordId: ScenarioVerificationRecordId | null;
  readonly readVerification: ScenarioReadVerification | null;
}

/** PL-6a: 下書きの検証の指定（結果の判定のしかたの印は、下書きの確かめが送り方から付ける。省いてよい。入れるなら付ける値と同じ）。 */
export type ScenarioVerificationDraft = Omit<ScenarioVerification, 'resultJudgement'> & { readonly resultJudgement?: ScenarioResultJudgement | null };

/** すべて未指定の検証の指定（下書きに検証の指定がないとき）。 */
export const UNSPECIFIED_VERIFICATION: ScenarioVerification = Object.freeze({
  resultJudgement: null,
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
  /**
   * OP-R（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.9 の R1）: 画面の path の定義の path（画面の path の定義だけが持つ。省略は分からない）。API の
   * 登録のシナリオだけ、登録の画面の 1 つ上の一覧の画面（`read-list-page.ts` の `readListPagePathOf`）の定義を照合の READ に使える（結び付けは 0 件）。
   */
  readonly pagePath?: string;
}

// シナリオの下書きの確かめの唯一の owner（Task 28 の設計書 3 章、4.1。T28a）。純粋な関数。手本は `src/control/read-check-policy.ts`。
// - 人の入力（`ScenarioDraftInput`）の形を確かめる。形が違えば `SCENARIO_INPUT_INVALID` だけを返す（ほかの確かめをしない）。
// - 対象の候補は引数で受ける（`DiscoveryCandidate`。最後の発見のジョブの `discovery.json` から呼び出し側が読んで渡す）。渡されない、識別の
//   digest が違う → `SCENARIO_CANDIDATE_UNKNOWN`。分類が `CREATE`・`UPDATE` でない → `SCENARIO_CANDIDATE_NOT_WRITABLE`（`NEEDS_BINDING`・
//   `NOT_EXECUTABLE`・`UNSUPPORTED_READ_TRANSPORT`・`BLOCKED_EXTERNAL`・`DISPLAY_ONLY`・`READ` から作らない）。分類は書き込みでも、要求の形
//   （POST の form、送信先と enctype があり、`_method` の上書きは PUT・PATCH だけ）に当たらない → `SCENARIO_CANDIDATE_REQUEST_UNSUPPORTED`
//   （fail-closed）。シナリオの kind と要求の形は、候補から作る（人の入力から取らない）。
// - 送る欄（名前ごとに、この順で最初の 1 件）: 秘密に見える名前（`isSecretUrlQueryParameterName`。READ の確かめと同じ今の方針）→
//   `SCENARIO_FIELD_SECRET_LIKE`。危険な語（発見の分類が GET の form の欄の名前に使うのと同じ判定。owner は `src/discovery/classify.ts` の
//   `fieldNameHasDestructiveWord`。英語の語は語の単位、日本語の語は部分一致。T28a fix round 1）→ `SCENARIO_FIELD_DANGEROUS_WORD`。候補が分かるときは、
//   その名前の欄のどれかが値を送れない型（`password`・`file`。owner は `src/discovery/candidate-contracts.ts` の `isUnsendableFieldType`。名前が
//   秘密に見えなくても拒む。DEF-094）→ `SCENARIO_FIELD_TYPE_NOT_SENDABLE`。候補の送れる欄
//   でない（`isSendableReadCheckParameter`。owner は `src/discovery/read-check-contracts.ts`）か、`_method` の欄（送ると method の上書きになる）
//   → `SCENARIO_FIELD_NOT_ALLOWED`。
// - 照らす READ の定義（参照ごと）: 同じプロファイルの定義がない → `SCENARIO_READ_CHECK_NOT_FOUND`、取り消した → `SCENARIO_READ_CHECK_CANCELED`、
//   版が違う → `SCENARIO_READ_CHECK_REVISION_MISMATCH`。
// - 上限と期限は既定以下（`SCENARIO_LIMIT_ABOVE_DEFAULT`、`SCENARIO_TTL_ABOVE_DEFAULT`）。1 回の Run の上限は累積の上限以下
//   （`SCENARIO_LIMIT_INCONSISTENT`）。副作用の確認は形だけ（4 項目の真偽。未確認でも下書きは保存できる。承認の前の確かめは
//   `unconfirmedSideEffectsOf`）。
// - 誤りの詳しい文には、欄の名前と項目の位置だけを書く（値は入力にない）。
// - 保存の前の確かめ直し（`assertStorableScenarioRevision`、`assertStorableApprovalReceipt`）は、スキーマ（`scenario`、`approval-receipt`）で形を
//   確かめた凍結した写しを返す（保存の部品が書く前と読んだ後に使う。T28c）。
// - T30a（Task 30 の設計書 3 章の「検証の指定」、10 章の 5）: 検証の指定（`verification`。下書きでは省ける。省けばすべて未指定）の確かめ。
//   形（結果の条件の `{ pathPrefix, selector }`、登録の ID の取り方（path の型は `{id}` をちょうど 1 つ、path の 1 つの区切りの全体に持つ）、照合の
//   READ の参照・結び付け・期待（`VERIFICATION_EXPECTATION_KINDS` だけ））が違えば `SCENARIO_INPUT_INVALID`。照合の READ の定義は、照らす READ の
//   定義と同じ理由（同じプロファイルにない・取り消した・版が違う）で拒む。使える定義のときだけ、結び付ける READ の送る値が今の版の送る値に
//   あることを確かめる（`SCENARIO_VERIFICATION_PARAMETER_UNKNOWN`）。結び付けと期待の欄は、シナリオの送る欄にあること
//   （`SCENARIO_VERIFICATION_FIELD_NOT_SENT`）。誤りの順は、照らす READ の定義の後、上限の前。
// - 未指定の項目の判定（`missingVerificationItemsOf`）: どれかが未指定なら、承認はできるが実行の許可は出せない（`VERIFICATION_SPEC_MISSING`。発行の
//   確かめに足すのは T30d）。
// - 検証の指定の前に保存した版（`verification` の項目がない）は、読むとき（`storedScenarioRevisionOf`）にすべて未指定として読む（項目がない
//   ときだけ。壊れた検証の指定は既定に直さない）。
// - T30a fix round 1: 結果の条件の path の前方一致と、登録の ID の path の型（`{id}` の区切りを置き換えた形）の形は `isAcceptedPath`、セレクタの
//   形は `isAcceptedSelector`、成功の条件と入力の誤りの条件が同時に当たりうるか（`SCENARIO_VERIFICATION_CONDITIONS_AMBIGUOUS`）は
//   `mayMatchTogether`（どれも Task 26 の判定の owner `src/control/auth/auth-setup-policy.ts`。書き写さない）。
// - T31b（Task 31 の設計書 2 章のユーザーの判断 1〜5、3 章の「UPDATE の指定」「削除にあたる変更の遮断」、4 章の「契約」、11 章の T31b の Blocker の
//   判断）: UPDATE の指定（`update`。下書きでは省ける。省くか null なら指定なし）の確かめ。誤りの順は、送る欄の後、照らす READ の定義の前。
//   - 形（台帳の参照の id の形、2 つの path の型（`{id}` をちょうど 1 つ、区切りの全体。query を持たない。上限の長さ）、保つ欄（件数・長さ・重複））
//     が違えば `SCENARIO_INPUT_INVALID`。
//   - kind が `UPDATE` の候補で指定がない → `SCENARIO_UPDATE_SPEC_MISSING`（ほかの UPDATE の確かめをしない）。`CREATE` の候補で指定がある →
//     `SCENARIO_UPDATE_SPEC_NOT_ALLOWED`。
//   - 台帳の参照（下書きの確かめの文脈 `ScenarioDraftContext` のシナリオの事実で確かめる。既定は事実なし）: 同じプロファイルにない →
//     `SCENARIO_UPDATE_TARGET_NOT_FOUND`、kind が `CREATE` でないか自分 → `SCENARIO_UPDATE_TARGET_NOT_CREATE`。
//   - path の型: 候補の同じ位置の区切りの値を入れて、画面の path と送信先の path の両方に同じ値で戻らない → `SCENARIO_UPDATE_PATH_MISMATCH`
//     （`fingerprint.ts` の `recordIdOfTemplates`）。戻る値がレコードの ID の形でない → `SCENARIO_UPDATE_RECORD_ID_UNSAFE`（判定は
//     `src/control/actions/action-outcome.ts` の `usableRecordIdOf`。形を書き写さない）。
//   - T31R-fix-1 の I-2: path の型の `{id}` の位置を、台帳の登録の ID の取り方（文脈の事実 `ScenarioKindFact.recordId`）に結ぶ
//     （`isUpdatePathBoundToLedger`。`URL_PATH_PATTERN` なら、T31R2-fix-1 の I-1 から、送信先の型の `{id}` の後ろの並びが台帳の型と同じで、前の並びが
//     台帳の型の前の並び全体と後ろから一致する。`ELEMENT` なら
//     送信先の型の `{id}` が最後の区切り。台帳の取り方が未指定なら確かめない）。外れる → `SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID`（台帳の参照と
//     path の型のほかの誤りがないときだけ）。発行（`scenario-store.ts`）も、台帳の今の取り方で同じ判定を確かめ直す。
//   - 秘密に見える名前（`isSecretUrlQueryParameterName`）の見える欄（hidden でない、名前のある欄）がある → 欄ごとに
//     `SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD`（値を読めないので、UPDATE の指定を受けない）。
//   - T31e fix round 1: 状態の語に当たり、秘密に見える名前でもある、値を送る欄（disabled でない hidden の型・見えない欄・readonly。判定は
//     `src/discovery/read-check-contracts.ts` の `isSecretLikeStateField`）がある → 欄ごとに `SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_STATE_FIELD`（値を
//     読めず照らせないので、UPDATE の指定を受けない。ワーカーの欄の役割の `SECRET_LIKE_STATE_FIELD` と同じ判定）。
//   - 変える欄（`fieldNames`）: 状態の欄（`src/discovery/classify.ts` の `fieldNameHasStateWord`）→ `SCENARIO_STATE_FIELD_NOT_CHANGEABLE`（保つだけ）。
//     T31R-fix-1 の I-1: 危険な語・削除の語に当たる名前の欄（`classify.ts` の `fieldNameHasRemovalWord`）→ `SCENARIO_REMOVAL_FIELD_NOT_CHANGEABLE`
//     （保つだけ。危険な語の欄は、送る欄の確かめの `SCENARIO_FIELD_DANGEROUS_WORD` も出る）。
//     秘密に見える名前・危険な語・送れない型は、送る欄の確かめ（CREATE と同じ）。
//   - 保つ欄: 見えていて編集できる欄（値を送る欄すべてが送れる欄（`isSendableWriteFieldName`。T31b fix round 1）で、`_method` でない）でない →
//     `SCENARIO_FIELD_NOT_ALLOWED`。変える欄と重なる → `SCENARIO_UPDATE_FIELD_ROLE_OVERLAP`。
//   - 見えていて編集できる欄で、どちらの役割も持たない → 欄ごとに `SCENARIO_UPDATE_FIELD_ROLE_MISSING`（候補の欄の順）。変える欄がない →
//     `SCENARIO_UPDATE_NO_CHANGED_FIELD`。
//   - 受けた UPDATE の指定には、候補の型にした識別の digest（`templatedIdentityDigestOf`）を足す（保つ欄は UTF-16 のコード単位の順）。
// - T31b fix round 1（Task 31 の設計書 3 章の「同じ名前の hidden と checkbox の組（Rails 型）」）: 送る欄・保つ欄が「見えていて編集できる欄」かは、
//   書き込みで値を送る欄（`candidate-contracts.ts` の `writeFieldsOfName`。組の名前は組の checkbox だけ、ほかは同じ名前の欄のすべて）がすべて
//   送れる欄（`isSendableField`）であることで決める（`src/discovery/read-check-contracts.ts` の `isSendableWriteFieldName`）。組の checkbox は役割を持ち、組の hidden は役割を持たない。
//   組でない同じ名前の欄は、今どおり受けない。CREATE の送る欄も同じ判定（入力の規則の欄の判定も、これを使う）。
// - T31b: UPDATE の指定の前に保存した版（`update` の項目がない）は、読むとき（`storedScenarioRevisionOf`）に指定なし（null）として読む。
// - T30f fix round 1・2（DEF-098）: CREATE の候補の、見えていて編集できる、既定の値が分からない欄（`candidate-contracts.ts` の
//   `DEFAULT_VALUE_FIELD_TYPES`。select-one・select-multiple・range・color）が送る欄にない → 欄ごとに `SCENARIO_CREATE_DEFAULT_VALUE_FIELD_NOT_SENT`
//   （候補の欄の順。ブラウザが既定の値で送るので、書き込みの照合の期待を作れない。書き込みの入力の部品も同じ一覧で `SPEC_INVALID` にして送らない）。見えていて編集できるかは、UPDATE の欄の役割と同じ判定（`isEditableFieldName`）。UPDATE は欄の役割で必ず扱うので
//   対象の外。誤りの順は、送る欄の後、UPDATE の指定の前。
import { isSha256Fingerprint } from '../../core/ids.js';
import { deepFreeze } from '../../core/immutable.js';
import { isPositiveSafeInteger, isRecord } from '../../core/guards.js';
import { isSecretUrlQueryParameterName } from '../../core/secret-query-names.js';
import { compareCodeUnits } from '../../core/text.js';
import {
  MAX_FIELD_NAME_LENGTH,
  isDefaultValueFieldType,
  isMethodOverrideFieldName,
  isUnsendableFieldType,
  type DiscoveryCandidate,
} from '../../discovery/candidate-contracts.js';
import { fieldNameHasDestructiveWord, fieldNameHasRemovalWord, fieldNameHasStateWord } from '../../discovery/classify.js';
import { recordIdOfTemplates, recordIdSegmentPairOfTemplates, templatedIdentityDigestOf } from '../../discovery/fingerprint.js';
import { usableRecordIdOf } from '../actions/action-outcome.js';
import { isAcceptedPath, isAcceptedSelector, mayMatchTogether } from '../auth/auth-setup-policy.js';
import {
  MAX_READ_CHECK_DETAIL_FIELD_LENGTH,
  isSecretLikeStateField,
  isSendableWriteFieldName,
  isUnreadableSecretField,
} from '../../discovery/read-check-contracts.js';
import { PROFILE_ID_PATTERN } from '../contracts.js';
import { requireSchemaCheckedCopy } from '../schema-checked-copy.js';
import {
  APPROVAL_TTL_DAYS,
  DEFAULT_MAX_CREATES_PER_RUN,
  DEFAULT_MAX_CUMULATIVE_CREATES,
  MAX_RECORD_ID_PATH_PATTERN_LENGTH,
  MAX_RESULT_CONDITION_PATH_LENGTH,
  MAX_SCENARIO_FIELD_NAMES,
  MAX_SCENARIO_KEEP_FIELD_NAMES,
  MAX_UPDATE_PATH_TEMPLATE_LENGTH,
  MAX_SCENARIO_READ_CHECKS,
  MAX_VERIFICATION_BINDINGS,
  MAX_VERIFICATION_EXPECTATIONS,
  MAX_VERIFICATION_ROW_COUNT,
  MAX_VERIFICATION_SELECTOR_LENGTH,
  MIN_APPROVAL_TTL_DAYS,
  MIN_SCENARIO_LIMIT,
  MIN_SCENARIO_REVISION,
  MIN_VERIFICATION_ROW_COUNT,
  RECORD_ID_PLACEHOLDER,
  SCENARIO_FORM_METHOD,
  SCENARIO_ID_PATTERN,
  SCENARIO_KINDS,
  SCENARIO_METHOD_OVERRIDES,
  SCENARIO_VERIFICATION_ITEMS,
  SIDE_EFFECT_CONFIRMATIONS,
  UNSPECIFIED_VERIFICATION,
  type ApprovalReceiptRecord,
  type ReadCheckReference,
  type ScenarioContent,
  type ScenarioKind,
  type ScenarioKindFact,
  type ScenarioLimits,
  type ScenarioReadCheckDefinitionFact,
  type ScenarioReadVerification,
  type ScenarioRecordIdSpec,
  type ScenarioRequestShape,
  type ScenarioResultCondition,
  type ScenarioRevision,
  type ScenarioUpdateDraft,
  type ScenarioUpdateSpec,
  type ScenarioVerification,
  type ScenarioVerificationItem,
  type SideEffectConfirmation,
  type SideEffectConfirmations,
  type VerificationExpectation,
} from './scenario-contracts.js';

/**
 * シナリオの下書きを拒む理由（閉じた一覧。項目ごと）。
 * - `SCENARIO_INPUT_INVALID`: 入力の形が契約と違う（項目の過不足、型、ID と digest の形、件数と長さの上限、重複、上限と期限の最小）。
 * - `SCENARIO_CANDIDATE_UNKNOWN`: 対象の候補が分からない（渡されない、識別の digest が違う）。
 * - `SCENARIO_CANDIDATE_NOT_WRITABLE`: 対象の候補の分類が `CREATE`・`UPDATE` でない。
 * - `SCENARIO_CANDIDATE_REQUEST_UNSUPPORTED`: 対象の候補の要求の形が、シナリオの要求の形に当たらない。
 * - `SCENARIO_FIELD_SECRET_LIKE`: 送る欄の名前が秘密に見える。
 * - `SCENARIO_FIELD_DANGEROUS_WORD`: 送る欄の名前が危険な語に当たる。
 * - `SCENARIO_FIELD_TYPE_NOT_SENDABLE`: 送る欄（同じ名前の欄のどれか）の型が、値を送れない型（`password`・`file`）。名前が秘密に見えなくても
 *   拒む（DEF-094）。
 * - `SCENARIO_FIELD_NOT_ALLOWED`: 送る欄が、候補の送れる欄でない（ない、名前がない、hidden、readonly、disabled、`_method`）。
 * - `SCENARIO_CREATE_DEFAULT_VALUE_FIELD_NOT_SENT`（T30f fix round 1・2。DEF-098）: CREATE の候補の、見えていて編集できる、既定の値が分からない欄
 *   （select・range・color）が送る欄にない（既定の値で送られるので、送る中身の照合の期待を作れない）。
 * - `SCENARIO_FORM_HAS_UNREADABLE_SECRET_FIELD`（T31R2-fix-1。DEF-108 の残り）: 登録・更新の候補に、値を読めず照らせない、秘密に見える名前の欄
 *   （`read-check-contracts.ts` の `isUnreadableSecretField`。hidden の型・見えない欄・readonly で、ページが作る値の名前（CSRF のトークンなど。名前だけを
 *   照らす）でない）がある（欄ごと。更新で状態の語にも当たる欄は `SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_STATE_FIELD` だけ）。
 * - T31b（UPDATE の指定）: `SCENARIO_UPDATE_SPEC_MISSING`（UPDATE の候補で指定がない）、`SCENARIO_UPDATE_SPEC_NOT_ALLOWED`（CREATE の候補で指定が
 *   ある）、`SCENARIO_UPDATE_TARGET_NOT_FOUND`（台帳の参照が同じプロファイルのシナリオでない）、`SCENARIO_UPDATE_TARGET_NOT_CREATE`（台帳の参照が
 *   CREATE でないか自分）、`SCENARIO_UPDATE_PATH_MISMATCH`（path の型が候補の path に同じ値で戻らない）、`SCENARIO_UPDATE_RECORD_ID_UNSAFE`（戻る
 *   値がレコードの ID の形でない）、`SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID`（T31R-fix-1 の I-2。送信先の型の `{id}` の位置が、台帳の登録の ID の
 *   取り方に結び付かない）、`SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD`（秘密に見える名前の見える欄がある）、
 *   `SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_STATE_FIELD`（T31e fix round 1。状態の語に当たり、秘密に見える名前でもある、値を送る見えない欄がある）、
 *   `SCENARIO_STATE_FIELD_NOT_CHANGEABLE`（変える欄が状態の欄）、`SCENARIO_REMOVAL_FIELD_NOT_CHANGEABLE`（T31R-fix-1 の I-1。変える欄が危険な語・
 *   削除の語に当たる名前の欄）、`SCENARIO_UPDATE_FIELD_ROLE_OVERLAP`（変える欄と保つ欄が重なる）、
 *   `SCENARIO_UPDATE_FIELD_ROLE_MISSING`（見えていて編集できる欄が役割を持たない）、`SCENARIO_UPDATE_NO_CHANGED_FIELD`（変える欄がない）。
 * - `SCENARIO_READ_CHECK_NOT_FOUND`: 照らす READ の定義が、同じプロファイルにない。
 * - `SCENARIO_READ_CHECK_CANCELED`: 照らす READ の定義を取り消した。
 * - `SCENARIO_READ_CHECK_REVISION_MISMATCH`: 照らす READ の定義の版が、今の版と違う。
 *   （T30a: 上の 3 つは、検証の指定の照合の READ の定義にも使う。）
 * - `SCENARIO_VERIFICATION_CONDITIONS_AMBIGUOUS`: 成功の条件と入力の誤りの条件が同時に当たりうる（path の前方一致が同じで、セレクタも同じか、
 *   どちらかにない。Task 26 の `mayMatchTogether`。T30a fix round 1）。
 * - `SCENARIO_VERIFICATION_PARAMETER_UNKNOWN`: 照合の READ で結び付ける送る値の名前が、READ の定義の今の版の送る値にない（T30a）。
 * - `SCENARIO_VERIFICATION_FIELD_NOT_SENT`: 照合の READ の結び付けか期待の欄が、シナリオの送る欄にない（生成した値がない。T30a）。
 * - `SCENARIO_LIMIT_ABOVE_DEFAULT`: 上限（1 回の Run、累積のそれぞれ）が既定を超える。
 * - `SCENARIO_LIMIT_INCONSISTENT`: 1 回の Run の上限が、累積の上限を超える。
 * - `SCENARIO_TTL_ABOVE_DEFAULT`: 期限の日数が既定を超える。
 */
export const SCENARIO_DRAFT_REJECTION_REASONS = Object.freeze([
  'SCENARIO_INPUT_INVALID',
  'SCENARIO_CANDIDATE_UNKNOWN',
  'SCENARIO_CANDIDATE_NOT_WRITABLE',
  'SCENARIO_CANDIDATE_REQUEST_UNSUPPORTED',
  'SCENARIO_FIELD_SECRET_LIKE',
  'SCENARIO_FIELD_DANGEROUS_WORD',
  'SCENARIO_FIELD_TYPE_NOT_SENDABLE',
  'SCENARIO_FIELD_NOT_ALLOWED',
  // T30f fix round 1・2（DEF-098）: CREATE の送らない、既定の値が分からない欄。
  'SCENARIO_CREATE_DEFAULT_VALUE_FIELD_NOT_SENT',
  // T31R2-fix-1: 値を読めず照らせない、秘密に見える名前の欄がある画面（登録と更新）。
  'SCENARIO_FORM_HAS_UNREADABLE_SECRET_FIELD',
  // T31b: UPDATE の指定。
  'SCENARIO_UPDATE_SPEC_MISSING',
  'SCENARIO_UPDATE_SPEC_NOT_ALLOWED',
  'SCENARIO_UPDATE_TARGET_NOT_FOUND',
  'SCENARIO_UPDATE_TARGET_NOT_CREATE',
  'SCENARIO_UPDATE_PATH_MISMATCH',
  'SCENARIO_UPDATE_RECORD_ID_UNSAFE',
  // T31R-fix-1 の I-2: path の型の `{id}` の位置が、台帳の登録の ID の取り方に結び付かない。
  'SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID',
  'SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD',
  'SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_STATE_FIELD',
  'SCENARIO_STATE_FIELD_NOT_CHANGEABLE',
  // T31R-fix-1 の I-1: 危険な語・削除の語に当たる名前の欄は、保つだけ。
  'SCENARIO_REMOVAL_FIELD_NOT_CHANGEABLE',
  'SCENARIO_UPDATE_FIELD_ROLE_OVERLAP',
  'SCENARIO_UPDATE_FIELD_ROLE_MISSING',
  'SCENARIO_UPDATE_NO_CHANGED_FIELD',
  'SCENARIO_READ_CHECK_NOT_FOUND',
  'SCENARIO_READ_CHECK_CANCELED',
  'SCENARIO_READ_CHECK_REVISION_MISMATCH',
  'SCENARIO_VERIFICATION_CONDITIONS_AMBIGUOUS',
  'SCENARIO_VERIFICATION_PARAMETER_UNKNOWN',
  'SCENARIO_VERIFICATION_FIELD_NOT_SENT',
  'SCENARIO_LIMIT_ABOVE_DEFAULT',
  'SCENARIO_LIMIT_INCONSISTENT',
  'SCENARIO_TTL_ABOVE_DEFAULT',
] as const);
export type ScenarioDraftRejectionReason = (typeof SCENARIO_DRAFT_REJECTION_REASONS)[number];

/** シナリオの下書きの入力（人が画面で決める。値は持たない）。 */
export interface ScenarioDraftInput {
  readonly profileId: string;
  /** 対象の候補の識別の digest。 */
  readonly candidateIdentityDigest: string;
  readonly fieldNames: readonly string[];
  readonly readChecks: readonly ReadCheckReference[];
  readonly sideEffectConfirmations: SideEffectConfirmations;
  readonly limits: ScenarioLimits;
  readonly approvalTtlDays: number;
  /** 検証の指定（T30a。省けば、すべて未指定）。 */
  readonly verification?: ScenarioVerification;
  /** UPDATE の指定（T31b。kind が UPDATE の候補では必須。省くか null なら指定なし）。 */
  readonly update?: ScenarioUpdateDraft | null;
}

/**
 * 下書きの確かめの文脈（T31b）: 確かめるシナリオの id（作成と版の更新。分からなければ null）と、台帳の参照を確かめるシナリオの事実（今の版の
 * kind。ほかのプロファイルを含んでよい）。
 */
export interface ScenarioDraftContext {
  readonly scenarioId: string | null;
  readonly scenarios: readonly ScenarioKindFact[];
}

/** シナリオの事実のない文脈（既定。台帳の参照は見つからない）。 */
export const NO_SCENARIO_DRAFT_CONTEXT: ScenarioDraftContext = Object.freeze({ scenarioId: null, scenarios: Object.freeze([]) });

/**
 * 確かめの誤り 1 件（`detail` は英語の診断の文。欄の名前と項目の位置だけ）。`fieldName` は送る欄の誤りのときだけ、その名前。`readCheckId` は
 * 照らす READ の定義の誤りのときだけ、その id（画面が項目ごとに誤りを出すため）。ほかは null。
 */
export interface ScenarioDraftError {
  readonly code: ScenarioDraftRejectionReason;
  readonly detail: string;
  readonly fieldName: string | null;
  readonly readCheckId: string | null;
}

/** 確かめの結果。受けるときは凍結したシナリオの中身、拒むときは当たった誤りのすべて（1 件以上）。 */
export type ScenarioDraftValidationResult =
  | { readonly ok: true; readonly content: ScenarioContent }
  | { readonly ok: false; readonly errors: readonly ScenarioDraftError[] };

const DRAFT_KEYS: readonly (keyof ScenarioDraftInput)[] = Object.freeze([
  'profileId',
  'candidateIdentityDigest',
  'fieldNames',
  'readChecks',
  'sideEffectConfirmations',
  'limits',
  'approvalTtlDays',
]);
/** 下書きで省ける項目（T30a。省けば、検証の指定はすべて未指定）。 */
const OPTIONAL_DRAFT_KEYS: readonly (keyof ScenarioDraftInput)[] = Object.freeze(['verification', 'update']);
/** UPDATE の指定の鍵（T31b）。 */
const UPDATE_DRAFT_KEYS: readonly (keyof ScenarioUpdateDraft)[] = Object.freeze([
  'targetCreateScenarioId',
  'formPathTemplate',
  'actionPathTemplate',
  'keepFieldNames',
]);
const READ_CHECK_REFERENCE_KEYS: readonly (keyof ReadCheckReference)[] = Object.freeze(['readCheckId', 'revision']);
const LIMIT_KEYS: readonly (keyof ScenarioLimits)[] = Object.freeze(['maxCreatesPerRun', 'maxCumulativeCreates']);
const RESULT_CONDITION_KEYS: readonly (keyof ScenarioResultCondition)[] = Object.freeze(['pathPrefix', 'selector']);
const READ_VERIFICATION_KEYS: readonly (keyof ScenarioReadVerification)[] = Object.freeze(['readCheckId', 'revision', 'bindings', 'expectations']);
const BINDING_KEYS = Object.freeze(['parameterName', 'fieldName'] as const);
/** 登録の ID の取り方ごとの鍵。 */
const RECORD_ID_KEYS: Readonly<Record<ScenarioRecordIdSpec['source'], readonly string[]>> = Object.freeze({
  URL_PATH_PATTERN: Object.freeze(['source', 'pathPattern']),
  ELEMENT: Object.freeze(['source', 'selector']),
});
/** 照合の READ の期待の種類ごとの鍵。 */
const VERIFICATION_EXPECTATION_KEYS: Readonly<Record<VerificationExpectation['kind'], readonly string[]>> = Object.freeze({
  ROW_COUNT_EQUALS: Object.freeze(['kind', 'count']),
  TEXT_CONTAINS: Object.freeze(['kind', 'fieldName']),
  DETAIL_FIELD_EQUALS: Object.freeze(['kind', 'field', 'fieldName']),
});
/** path の区切り。 */
const PATH_SEPARATOR = '/';
/**
 * path の型の形を確かめるときに、`{id}` の区切りの代わりに置く区切り（path に書ける文字だけ）。置いた後の path を Task 26 の path の形
 * （`isAcceptedPath`）で確かめる（`{id}` の外の波括弧・query・fragment は、使える文字でないので拒まれる）。
 */
const RECORD_ID_SEGMENT_SAMPLE = 'id';

const errorOf = (
  code: ScenarioDraftRejectionReason,
  detail: string,
  item: { readonly fieldName?: string; readonly readCheckId?: string } = {},
): ScenarioDraftError => Object.freeze({ code, detail, fieldName: item.fieldName ?? null, readCheckId: item.readCheckId ?? null });

const rejected = (errors: readonly ScenarioDraftError[]): ScenarioDraftValidationResult =>
  Object.freeze({ ok: false, errors: Object.freeze([...errors]) });

const invalid = (detail: string): ScenarioDraftError => errorOf('SCENARIO_INPUT_INVALID', detail);

/** 鍵がちょうど `keys`（と、省ける `optionalKeys`）の記録か（過不足の誤り）。 */
const keyErrorsOf = (
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  optionalKeys: readonly string[] = [],
): readonly ScenarioDraftError[] => [
  ...keys.filter((key) => !Object.hasOwn(value, key)).map((key) => invalid(`${path}/${key} is required`)),
  ...Object.keys(value).filter((key) => !keys.includes(key) && !optionalKeys.includes(key))
    .map((key) => invalid(`${path}/${JSON.stringify(key)} is not a property of the draft`)),
];

/** 最小以上の安全な整数か（最小は 1。上限と版と日数）。 */
const isAtLeastMinimum = (value: unknown, minimum: number): value is number => isPositiveSafeInteger(value) && value >= minimum;

const fieldNamesShapeErrorsOf = (value: unknown): readonly ScenarioDraftError[] => {
  if (!Array.isArray(value)) {
    return [invalid('/fieldNames must be an array')];
  }
  const errors: ScenarioDraftError[] = [];
  if (value.length > MAX_SCENARIO_FIELD_NAMES) {
    errors.push(invalid(`/fieldNames must have at most ${MAX_SCENARIO_FIELD_NAMES} items`));
  }
  value.forEach((name: unknown, index) => {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_FIELD_NAME_LENGTH) {
      errors.push(invalid(`/fieldNames/${index} must be a string of 1 to ${MAX_FIELD_NAME_LENGTH} code units`));
    } else if (value.indexOf(name) !== index) {
      errors.push(invalid(`/fieldNames/${index} is a duplicate`));
    }
  });
  return errors;
};

const readChecksShapeErrorsOf = (value: unknown): readonly ScenarioDraftError[] => {
  if (!Array.isArray(value)) {
    return [invalid('/readChecks must be an array')];
  }
  const errors: ScenarioDraftError[] = [];
  if (value.length > MAX_SCENARIO_READ_CHECKS) {
    errors.push(invalid(`/readChecks must have at most ${MAX_SCENARIO_READ_CHECKS} items`));
  }
  const seen = new Set<string>();
  value.forEach((reference: unknown, index) => {
    const path = `/readChecks/${index}`;
    if (!isRecord(reference)) {
      errors.push(invalid(`${path} must be an object`));
      return;
    }
    errors.push(...keyErrorsOf(reference, READ_CHECK_REFERENCE_KEYS, path));
    const { readCheckId, revision } = reference;
    if (typeof readCheckId !== 'string' || !SCENARIO_ID_PATTERN.test(readCheckId)) {
      errors.push(invalid(`${path}/readCheckId must match ${SCENARIO_ID_PATTERN.source}`));
    } else if (seen.has(readCheckId)) {
      errors.push(invalid(`${path}/readCheckId is a duplicate`));
    } else {
      seen.add(readCheckId);
    }
    if (!isAtLeastMinimum(revision, MIN_SCENARIO_REVISION)) {
      errors.push(invalid(`${path}/revision must be an integer of at least ${MIN_SCENARIO_REVISION}`));
    }
  });
  return errors;
};

const sideEffectsShapeErrorsOf = (value: unknown): readonly ScenarioDraftError[] => {
  if (!isRecord(value)) {
    return [invalid('/sideEffectConfirmations must be an object')];
  }
  return [
    ...keyErrorsOf(value, SIDE_EFFECT_CONFIRMATIONS, '/sideEffectConfirmations'),
    ...SIDE_EFFECT_CONFIRMATIONS.filter((item) => Object.hasOwn(value, item) && typeof value[item] !== 'boolean')
      .map((item) => invalid(`/sideEffectConfirmations/${item} must be a boolean`)),
  ];
};

const limitsShapeErrorsOf = (value: unknown): readonly ScenarioDraftError[] => {
  if (!isRecord(value)) {
    return [invalid('/limits must be an object')];
  }
  return [
    ...keyErrorsOf(value, LIMIT_KEYS, '/limits'),
    ...LIMIT_KEYS.filter((key) => Object.hasOwn(value, key) && !isAtLeastMinimum(value[key], MIN_SCENARIO_LIMIT))
      .map((key) => invalid(`/limits/${key} must be an integer of at least ${MIN_SCENARIO_LIMIT}`)),
  ];
};

// ---------------------------------------------------------------------------------------------------------------
// 検証の指定の形（T30a。すべて `SCENARIO_INPUT_INVALID`）
// ---------------------------------------------------------------------------------------------------------------

/** 1 文字以上 `maxLength` 以下の文字列か。 */
const isBoundedText = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maxLength;

/** 上限以下で、Task 26 のセレクタの形（`isAcceptedSelector`）のセレクタか。 */
const isVerificationSelector = (value: unknown): value is string =>
  isBoundedText(value, MAX_VERIFICATION_SELECTOR_LENGTH) && isAcceptedSelector(value);

/** 結果の条件の形の誤り（null は未指定）。 */
const resultConditionShapeErrorsOf = (value: unknown, path: string): readonly ScenarioDraftError[] => {
  if (value === null) {
    return [];
  }
  if (!isRecord(value)) {
    return [invalid(`${path} must be null or an object`)];
  }
  const errors = [...keyErrorsOf(value, RESULT_CONDITION_KEYS, path)];
  if (!isBoundedText(value.pathPrefix, MAX_RESULT_CONDITION_PATH_LENGTH) || !isAcceptedPath(value.pathPrefix)) {
    errors.push(invalid(
      `${path}/pathPrefix must be a path of at most ${MAX_RESULT_CONDITION_PATH_LENGTH} code units that starts with "/", without "//", ".." or an encoded dot`,
    ));
  }
  if (value.selector !== null && !isVerificationSelector(value.selector)) {
    errors.push(invalid(
      `${path}/selector must be null or a non-blank selector of at most ${MAX_VERIFICATION_SELECTOR_LENGTH} code units, without control characters`,
    ));
  }
  return errors;
};

/**
 * path の型か（`{id}` をちょうど 1 つ、path の 1 つの区切りの全体に持ち、`{id}` の区切りを置き換えた path が Task 26 の path の形
 * （`isAcceptedPath`。`/` で始まり、`//`・`..`・符号化した `.` を含まず、使える文字だけ）に当たる）。
 */
const isRecordIdPathPattern = (value: unknown, maxLength: number = MAX_RECORD_ID_PATH_PATTERN_LENGTH): value is string => {
  if (!isBoundedText(value, maxLength)) {
    return false;
  }
  const segments = value.split(PATH_SEPARATOR);
  const placeholders = segments.filter((segment) => segment === RECORD_ID_PLACEHOLDER).length;
  const sample = segments.map((segment) => (segment === RECORD_ID_PLACEHOLDER ? RECORD_ID_SEGMENT_SAMPLE : segment)).join(PATH_SEPARATOR);
  return placeholders === 1 && isAcceptedPath(sample);
};

/** 登録の ID の取り方の形の誤り（null は未指定）。 */
const recordIdShapeErrorsOf = (value: unknown): readonly ScenarioDraftError[] => {
  const path = '/verification/recordId';
  if (value === null) {
    return [];
  }
  if (!isRecord(value) || (value.source !== 'URL_PATH_PATTERN' && value.source !== 'ELEMENT')) {
    return [invalid(`${path} must be null or an object with a source of URL_PATH_PATTERN or ELEMENT`)];
  }
  const errors = [...keyErrorsOf(value, RECORD_ID_KEYS[value.source], path)];
  if (value.source === 'URL_PATH_PATTERN' && !isRecordIdPathPattern(value.pathPattern)) {
    errors.push(invalid(`${path}/pathPattern must be a path with ${RECORD_ID_PLACEHOLDER} once as a whole segment, without a query`));
  }
  if (value.source === 'ELEMENT' && !isVerificationSelector(value.selector)) {
    errors.push(invalid(`${path}/selector must be a non-blank selector of at most ${MAX_VERIFICATION_SELECTOR_LENGTH} code units, without control characters`));
  }
  return errors;
};

/** 欄の名前の形か。 */
const isFieldNameText = (value: unknown): value is string => isBoundedText(value, MAX_FIELD_NAME_LENGTH);

const bindingsShapeErrorsOf = (value: unknown, path: string): readonly ScenarioDraftError[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_VERIFICATION_BINDINGS) {
    return [invalid(`${path} must be an array of 1 to ${MAX_VERIFICATION_BINDINGS} bindings`)];
  }
  const seen = new Set<string>();
  return value.flatMap((binding: unknown, index): readonly ScenarioDraftError[] => {
    const itemPath = `${path}/${index}`;
    if (!isRecord(binding)) {
      return [invalid(`${itemPath} must be an object`)];
    }
    const errors = [...keyErrorsOf(binding, BINDING_KEYS, itemPath)];
    if (!isFieldNameText(binding.parameterName)) {
      errors.push(invalid(`${itemPath}/parameterName must be a string of 1 to ${MAX_FIELD_NAME_LENGTH} code units`));
    } else if (seen.has(binding.parameterName)) {
      errors.push(invalid(`${itemPath}/parameterName is a duplicate`));
    } else {
      seen.add(binding.parameterName);
    }
    if (!isFieldNameText(binding.fieldName)) {
      errors.push(invalid(`${itemPath}/fieldName must be a string of 1 to ${MAX_FIELD_NAME_LENGTH} code units`));
    }
    return errors;
  });
};

/** 照合の READ の期待 1 件の形の誤り。 */
const expectationShapeErrorsOf = (expectation: unknown, path: string): readonly ScenarioDraftError[] => {
  if (!isRecord(expectation) || typeof expectation.kind !== 'string' || !Object.hasOwn(VERIFICATION_EXPECTATION_KEYS, expectation.kind)) {
    return [invalid(`${path} must be an expectation of ROW_COUNT_EQUALS, TEXT_CONTAINS or DETAIL_FIELD_EQUALS`)];
  }
  const kind = expectation.kind as VerificationExpectation['kind'];
  const errors = [...keyErrorsOf(expectation, VERIFICATION_EXPECTATION_KEYS[kind], path)];
  if (kind === 'ROW_COUNT_EQUALS') {
    if (!isAtLeastMinimum(expectation.count, MIN_VERIFICATION_ROW_COUNT) || expectation.count > MAX_VERIFICATION_ROW_COUNT) {
      errors.push(invalid(`${path}/count must be an integer of ${MIN_VERIFICATION_ROW_COUNT} to ${MAX_VERIFICATION_ROW_COUNT}`));
    }
    return errors;
  }
  if (!isFieldNameText(expectation.fieldName)) {
    errors.push(invalid(`${path}/fieldName must be a string of 1 to ${MAX_FIELD_NAME_LENGTH} code units`));
  }
  if (kind === 'DETAIL_FIELD_EQUALS' && !isBoundedText(expectation.field, MAX_READ_CHECK_DETAIL_FIELD_LENGTH)) {
    errors.push(invalid(`${path}/field must be a string of 1 to ${MAX_READ_CHECK_DETAIL_FIELD_LENGTH} code units`));
  }
  return errors;
};

const expectationsShapeErrorsOf = (value: unknown, path: string): readonly ScenarioDraftError[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_VERIFICATION_EXPECTATIONS) {
    return [invalid(`${path} must be an array of 1 to ${MAX_VERIFICATION_EXPECTATIONS} expectations`)];
  }
  const errors = value.flatMap((expectation: unknown, index) => expectationShapeErrorsOf(expectation, `${path}/${index}`));
  if (errors.length === 0) {
    const entries = value.map((expectation) => JSON.stringify(expectation));
    errors.push(...entries.flatMap((entry, index) => (entries.indexOf(entry) === index ? [] : [invalid(`${path}/${index} is a duplicate`)])));
  }
  return errors;
};

/** 照合の READ の形の誤り（null は未指定）。 */
const readVerificationShapeErrorsOf = (value: unknown): readonly ScenarioDraftError[] => {
  const path = '/verification/readVerification';
  if (value === null) {
    return [];
  }
  if (!isRecord(value)) {
    return [invalid(`${path} must be null or an object`)];
  }
  const errors = [...keyErrorsOf(value, READ_VERIFICATION_KEYS, path)];
  if (typeof value.readCheckId !== 'string' || !SCENARIO_ID_PATTERN.test(value.readCheckId)) {
    errors.push(invalid(`${path}/readCheckId must match ${SCENARIO_ID_PATTERN.source}`));
  }
  if (!isAtLeastMinimum(value.revision, MIN_SCENARIO_REVISION)) {
    errors.push(invalid(`${path}/revision must be an integer of at least ${MIN_SCENARIO_REVISION}`));
  }
  errors.push(...bindingsShapeErrorsOf(value.bindings, `${path}/bindings`), ...expectationsShapeErrorsOf(value.expectations, `${path}/expectations`));
  return errors;
};

/** 検証の指定の形の誤り。 */
const verificationShapeErrorsOf = (value: unknown): readonly ScenarioDraftError[] => {
  if (!isRecord(value)) {
    return [invalid('/verification must be an object')];
  }
  return [
    ...keyErrorsOf(value, SCENARIO_VERIFICATION_ITEMS, '/verification'),
    ...resultConditionShapeErrorsOf(value.successCondition ?? null, '/verification/successCondition'),
    ...resultConditionShapeErrorsOf(value.inputErrorCondition ?? null, '/verification/inputErrorCondition'),
    ...recordIdShapeErrorsOf(value.recordId ?? null),
    ...readVerificationShapeErrorsOf(value.readVerification ?? null),
  ];
};

/** 保つ欄の形の誤り（T31b）。 */
const keepFieldNamesShapeErrorsOf = (value: unknown, path: string): readonly ScenarioDraftError[] => {
  if (!Array.isArray(value) || value.length > MAX_SCENARIO_KEEP_FIELD_NAMES) {
    return [invalid(`${path} must be an array of at most ${MAX_SCENARIO_KEEP_FIELD_NAMES} names`)];
  }
  return value.flatMap((name: unknown, index): readonly ScenarioDraftError[] => {
    if (!isFieldNameText(name)) {
      return [invalid(`${path}/${index} must be a string of 1 to ${MAX_FIELD_NAME_LENGTH} code units`)];
    }
    return value.indexOf(name) === index ? [] : [invalid(`${path}/${index} is a duplicate`)];
  });
};

/** UPDATE の指定の形の誤り（T31b。省くか null なら指定なし）。 */
const updateShapeErrorsOf = (value: unknown): readonly ScenarioDraftError[] => {
  const path = '/update';
  if (value === undefined || value === null) {
    return [];
  }
  if (!isRecord(value)) {
    return [invalid(`${path} must be null or an object`)];
  }
  const errors = [...keyErrorsOf(value, UPDATE_DRAFT_KEYS, path)];
  if (typeof value.targetCreateScenarioId !== 'string' || !SCENARIO_ID_PATTERN.test(value.targetCreateScenarioId)) {
    errors.push(invalid(`${path}/targetCreateScenarioId must match ${SCENARIO_ID_PATTERN.source}`));
  }
  for (const key of ['formPathTemplate', 'actionPathTemplate'] as const) {
    if (!isRecordIdPathPattern(value[key], MAX_UPDATE_PATH_TEMPLATE_LENGTH)) {
      errors.push(invalid(
        `${path}/${key} must be a path of at most ${MAX_UPDATE_PATH_TEMPLATE_LENGTH} code units with ${RECORD_ID_PLACEHOLDER} once as a whole segment, without a query`,
      ));
    }
  }
  errors.push(...keepFieldNamesShapeErrorsOf(value.keepFieldNames, `${path}/keepFieldNames`));
  return errors;
};

/** 入力の形の誤り（すべて `SCENARIO_INPUT_INVALID`）。 */
const shapeErrorsOf = (input: unknown): readonly ScenarioDraftError[] => {
  if (!isRecord(input)) {
    return [invalid('/ the draft must be an object')];
  }
  const errors = [...keyErrorsOf(input, DRAFT_KEYS, '', OPTIONAL_DRAFT_KEYS)];
  if (typeof input.profileId !== 'string' || !PROFILE_ID_PATTERN.test(input.profileId)) {
    errors.push(invalid(`/profileId must match ${PROFILE_ID_PATTERN.source}`));
  }
  if (!isSha256Fingerprint(input.candidateIdentityDigest)) {
    errors.push(invalid('/candidateIdentityDigest must be an identity digest of a candidate'));
  }
  errors.push(
    ...fieldNamesShapeErrorsOf(input.fieldNames),
    ...readChecksShapeErrorsOf(input.readChecks),
    ...sideEffectsShapeErrorsOf(input.sideEffectConfirmations),
    ...limitsShapeErrorsOf(input.limits),
  );
  if (!isAtLeastMinimum(input.approvalTtlDays, MIN_APPROVAL_TTL_DAYS)) {
    errors.push(invalid(`/approvalTtlDays must be an integer of at least ${MIN_APPROVAL_TTL_DAYS}`));
  }
  if (Object.hasOwn(input, 'verification')) {
    errors.push(...verificationShapeErrorsOf(input.verification));
  }
  errors.push(...updateShapeErrorsOf(input.update));
  return errors;
};

/** 分類が書き込み（シナリオの kind）か。 */
const scenarioKindOf = (classification: DiscoveryCandidate['classification']): ScenarioKind | null =>
  SCENARIO_KINDS.find((kind) => kind === classification) ?? null;

/** 候補の要求の形（当たらなければ null）。 */
const requestShapeOf = (candidate: DiscoveryCandidate): ScenarioRequestShape | null => {
  const { action, enctype, formMethod, methodOverride } = candidate;
  if (action === null || enctype === null || formMethod !== SCENARIO_FORM_METHOD) {
    return null;
  }
  const override = methodOverride === null ? null : SCENARIO_METHOD_OVERRIDES.find((value) => value === methodOverride);
  if (override === undefined) {
    return null;
  }
  return { formMethod, methodOverride: override, origin: action.origin, path: action.path, enctype };
};

/** 対象の候補の誤り。 */
const candidateErrorsOf = (draft: ScenarioDraftInput, candidate: DiscoveryCandidate | null): readonly ScenarioDraftError[] => {
  if (candidate === null || candidate.identityDigest !== draft.candidateIdentityDigest) {
    return [errorOf('SCENARIO_CANDIDATE_UNKNOWN', 'the target candidate is not the given candidate of the latest discovery')];
  }
  if (scenarioKindOf(candidate.classification) === null) {
    return [errorOf('SCENARIO_CANDIDATE_NOT_WRITABLE', `the target candidate is classified as ${candidate.classification}, not CREATE or UPDATE`)];
  }
  return requestShapeOf(candidate) === null
    ? [errorOf('SCENARIO_CANDIDATE_REQUEST_UNSUPPORTED', 'the target candidate is not a POST form (PUT or PATCH by _method) with an action and an enctype')]
    : [];
};

/** 送る欄の名前の誤り（名前ごとに最初の 1 件。`candidate` が null（分からない候補）なら、候補の欄は確かめない）。 */
const fieldErrorsOf = (draft: ScenarioDraftInput, candidate: DiscoveryCandidate | null): readonly ScenarioDraftError[] =>
  draft.fieldNames.flatMap((fieldName) => {
    const label = JSON.stringify(fieldName);
    if (isSecretUrlQueryParameterName(fieldName)) {
      return [errorOf('SCENARIO_FIELD_SECRET_LIKE', `the field ${label} looks like a secret and is never sent`, { fieldName })];
    }
    if (fieldNameHasDestructiveWord(fieldName)) {
      return [errorOf('SCENARIO_FIELD_DANGEROUS_WORD', `the field ${label} has a dangerous word and is never sent`, { fieldName })];
    }
    // DEF-094: 同じ名前の欄のどれかが値を送れない型なら拒む（fail-closed）。
    if (candidate !== null && candidate.fields.some((field) => field.name === fieldName && isUnsendableFieldType(field.type))) {
      return [errorOf('SCENARIO_FIELD_TYPE_NOT_SENDABLE', `the field ${label} is a password or file field and is never sent`, { fieldName })];
    }
    if (candidate !== null
      && (!isSendableWriteFieldName(candidate, fieldName) || isMethodOverrideFieldName(fieldName))) {
      return [errorOf('SCENARIO_FIELD_NOT_ALLOWED', `the field ${label} is not a visible, editable field of the candidate`, { fieldName })];
    }
    return [];
  });

// ---------------------------------------------------------------------------------------------------------------
// UPDATE の指定（T31b）
// ---------------------------------------------------------------------------------------------------------------

/** 下書きの UPDATE の指定（省くか null なら null）。 */
const updateDraftOf = (draft: ScenarioDraftInput): ScenarioUpdateDraft | null => draft.update ?? null;

/** 候補の、名前のある欄の名前（候補の欄の順。重なりなし）。 */
const fieldNamesOf = (candidate: DiscoveryCandidate, include: (field: DiscoveryCandidate['fields'][number]) => boolean): readonly string[] =>
  [...new Set(candidate.fields.filter((field) => field.name.length > 0 && include(field)).map((field) => field.name))];

/** 見えていて編集できる欄か（値を送る欄すべてが送れる欄で、`_method` でない。組の名前は組の checkbox で決める。T31b fix round 1）。 */
const isEditableFieldName = (candidate: DiscoveryCandidate, name: string): boolean =>
  isSendableWriteFieldName(candidate, name) && !isMethodOverrideFieldName(name);

/**
 * DEF-098: CREATE の候補の、見えていて編集できる、既定の値が分からない欄（`isDefaultValueFieldType`。書き込みの入力の部品と同じ一覧）で送る欄に
 * ないもの（欄ごと。候補の欄の順）。
 */
const createSelectErrorsOf = (draft: ScenarioDraftInput, candidate: DiscoveryCandidate | null): readonly ScenarioDraftError[] => {
  if (candidate === null || scenarioKindOf(candidate.classification) !== 'CREATE') {
    return [];
  }
  return fieldNamesOf(candidate, (field) => isDefaultValueFieldType(field.type))
    .filter((name) => isEditableFieldName(candidate, name) && !draft.fieldNames.includes(name))
    .map((fieldName) => errorOf(
      'SCENARIO_CREATE_DEFAULT_VALUE_FIELD_NOT_SENT',
      `the visible, editable field ${JSON.stringify(fieldName)} (a select, a range or a color) is not a field to send, and its default value cannot be checked before sending`,
      { fieldName },
    ));
};

/**
 * T31R2-fix-1（DEF-108 の残り）: 登録・更新の候補の、値を読めず照らせない、秘密に見える名前の欄（`isUnreadableSecretField`。欄ごと。候補の欄の順）。
 * 書き込みは、名前だけを照らす欄をページが作る値の名前の閉じた一覧に限り、ほかの hidden・readonly・見えない欄の値を照らすので、値を読めない欄が
 * ある画面は受けない。更新で、見える readonly の欄は `SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD`、状態の語にも当たる見えない欄は
 * `SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_STATE_FIELD` だけを出す（重ねない）。
 */
const unreadableSecretFieldErrorsOf = (candidate: DiscoveryCandidate | null): readonly ScenarioDraftError[] => {
  const kind = candidate === null ? null : scenarioKindOf(candidate.classification);
  if (candidate === null || kind === null) {
    return [];
  }
  // 更新で、今の理由（見える欄の秘密に見える名前、状態の語にも当たる見えない欄）が出る欄には重ねない。
  const reportedByUpdate = (field: DiscoveryCandidate['fields'][number]): boolean =>
    kind === 'UPDATE' && (isSecretLikeStateField(field) || (!field.hidden && isSecretUrlQueryParameterName(field.name)));
  return fieldNamesOf(candidate, (field) => isUnreadableSecretField(field) && !reportedByUpdate(field))
    .map((fieldName) => errorOf(
      'SCENARIO_FORM_HAS_UNREADABLE_SECRET_FIELD',
      `the hidden, readonly or invisible field ${JSON.stringify(fieldName)} looks like a secret, and its value cannot be read and checked for a write`,
      { fieldName },
    ));
};

/** 台帳の参照の誤り。 */
const updateTargetErrorsOf = (draft: ScenarioDraftInput, update: ScenarioUpdateDraft, context: ScenarioDraftContext): readonly ScenarioDraftError[] => {
  const label = JSON.stringify(update.targetCreateScenarioId);
  const target = context.scenarios.find(({ scenarioId, profileId }) => scenarioId === update.targetCreateScenarioId && profileId === draft.profileId);
  if (target === undefined) {
    return [errorOf('SCENARIO_UPDATE_TARGET_NOT_FOUND', `/update/targetCreateScenarioId ${label} is not a scenario of the profile`)];
  }
  return target.kind !== 'CREATE' || target.scenarioId === context.scenarioId
    ? [errorOf('SCENARIO_UPDATE_TARGET_NOT_CREATE', `/update/targetCreateScenarioId ${label} is not another CREATE scenario of the profile`)]
    : [];
};

/** path の型の誤り（候補の path に同じ値で戻らない、戻る値がレコードの ID の形でない）。 */
const updatePathErrorsOf = (update: ScenarioUpdateDraft, candidate: DiscoveryCandidate): readonly ScenarioDraftError[] => {
  const recordId = recordIdOfTemplates(candidate, update.formPathTemplate, update.actionPathTemplate);
  if (recordId === null) {
    return [errorOf('SCENARIO_UPDATE_PATH_MISMATCH', '/update the path templates do not give back the paths of the candidate with the same value')];
  }
  return usableRecordIdOf(recordId) === null
    ? [errorOf('SCENARIO_UPDATE_RECORD_ID_UNSAFE', '/update the record id segment of the candidate paths is not of the record id form')]
    : [];
};

/**
 * UPDATE の送信先の path の型の `{id}` の位置が、台帳（参照した CREATE のシナリオ）の登録の ID の取り方に結び付くか（T31R-fix-1 の I-2。純粋。下書きの
 * 確かめ、発行の確かめ直し、画面の型の選択肢が共用する唯一の判定）。
 * - `URL_PATH_PATTERN`（T31R2-fix-1 の I-1 で厳しくした）: (a) 送信先の型の `{id}` の後ろの区切りの並びが、台帳の型の `{id}` の後ろの並びと同じ
 *   （台帳が `/members/{id}` なら後ろなし）。(b) 送信先の型の `{id}` の前の区切りの並びが、台帳の型の `{id}` の前の並び全体と、後ろから続けて一致する
 *   （`/admin/members/{id}` は台帳 `/members/{id}` に合い、`/b/members/{id}` は台帳 `/a/members/{id}` に合わない）。
 * - `ELEMENT`: 送信先の型の `{id}` が、最後の区切り（成功の画面の要素から取る ID は、送信先の最後の区切りのレコードの ID とみなす）。
 * - 取り方が未指定（null）なら確かめない（真）。照合まで済んだ登録がないので、発行が対象なしで止まる。型の形が違えば偽。
 */
export const isUpdatePathBoundToLedger = (actionPathTemplate: string, ledgerRecordId: ScenarioRecordIdSpec | null): boolean => {
  if (ledgerRecordId === null) {
    return true;
  }
  const actionSegments = actionPathTemplate.split(PATH_SEPARATOR);
  if (ledgerRecordId.source === 'ELEMENT') {
    const own = recordIdSegmentPairOfTemplates(actionPathTemplate, actionPathTemplate);
    return own !== null && own.actionSegment === actionSegments.length - 1;
  }
  const pair = recordIdSegmentPairOfTemplates(ledgerRecordId.pathPattern, actionPathTemplate);
  if (pair === null) {
    return false;
  }
  const ledgerSegments = ledgerRecordId.pathPattern.split(PATH_SEPARATOR);
  // 先頭の空の区切り（`/` の前）は比べない。
  const ledgerBefore = ledgerSegments.slice(1, pair.pageSegment);
  const actionBefore = actionSegments.slice(1, pair.actionSegment);
  const ledgerAfter = ledgerSegments.slice(pair.pageSegment + 1);
  const actionAfter = actionSegments.slice(pair.actionSegment + 1);
  const offset = actionBefore.length - ledgerBefore.length;
  return offset >= 0
    && ledgerBefore.every((segment, index) => actionBefore[offset + index] === segment)
    && ledgerAfter.length === actionAfter.length
    && ledgerAfter.every((segment, index) => actionAfter[index] === segment);
};

/** 台帳の参照の事実（同じプロファイルの、自分でない CREATE のシナリオ。なければ undefined）。 */
const ledgerFactOf = (draft: ScenarioDraftInput, update: ScenarioUpdateDraft, context: ScenarioDraftContext): ScenarioKindFact | undefined =>
  context.scenarios.find(({ scenarioId, profileId, kind }) =>
    scenarioId === update.targetCreateScenarioId && profileId === draft.profileId && kind === 'CREATE' && scenarioId !== context.scenarioId);

/** path の型の `{id}` の位置の、台帳の登録の ID の取り方への結び付きの誤り（T31R-fix-1 の I-2）。 */
const updateLedgerBindingErrorsOf = (
  draft: ScenarioDraftInput,
  update: ScenarioUpdateDraft,
  context: ScenarioDraftContext,
): readonly ScenarioDraftError[] => {
  const ledger = ledgerFactOf(draft, update, context);
  return ledger === undefined || isUpdatePathBoundToLedger(update.actionPathTemplate, ledger.recordId ?? null)
    ? []
    : [errorOf('SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID',
      '/update the record id segment of the action path template is not where the ledger scenario takes its record id from')];
};

/** 欄の役割の誤り（秘密に見える名前の見える欄、状態の欄の変更、保つ欄、重なり、漏れ、変える欄なし）。 */
const updateFieldErrorsOf = (draft: ScenarioDraftInput, update: ScenarioUpdateDraft, candidate: DiscoveryCandidate): readonly ScenarioDraftError[] => {
  const secretLike = fieldNamesOf(candidate, (field) => !field.hidden && isSecretUrlQueryParameterName(field.name)).map((fieldName) => errorOf(
    'SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD',
    `the visible field ${JSON.stringify(fieldName)} looks like a secret, and its value cannot be read for an update`,
    { fieldName },
  ));
  // T31e fix round 1: 状態の語に当たり、秘密に見える名前でもある、値を送る見えない欄（値を読めず照らせない）。
  const secretLikeStates = fieldNamesOf(candidate, isSecretLikeStateField).map((fieldName) => errorOf(
    'SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_STATE_FIELD',
    `the field ${JSON.stringify(fieldName)} is a state field with a secret-looking name, and its value cannot be read and checked for an update`,
    { fieldName },
  ));
  const stateChanges = draft.fieldNames.filter(fieldNameHasStateWord).map((fieldName) => errorOf(
    'SCENARIO_STATE_FIELD_NOT_CHANGEABLE',
    `the field ${JSON.stringify(fieldName)} is a state field and can only be kept`,
    { fieldName },
  ));
  // T31R-fix-1 の I-1: 危険な語・削除の語に当たる名前の欄は、状態の欄と同じく保つだけ。
  const removalChanges = draft.fieldNames.filter(fieldNameHasRemovalWord).map((fieldName) => errorOf(
    'SCENARIO_REMOVAL_FIELD_NOT_CHANGEABLE',
    `the field ${JSON.stringify(fieldName)} has a removal word and can only be kept`,
    { fieldName },
  ));
  const keepErrors = update.keepFieldNames.flatMap((fieldName) => {
    if (!isEditableFieldName(candidate, fieldName)) {
      return [errorOf('SCENARIO_FIELD_NOT_ALLOWED', `the field ${JSON.stringify(fieldName)} to keep is not a visible, editable field of the candidate`, { fieldName })];
    }
    return draft.fieldNames.includes(fieldName)
      ? [errorOf('SCENARIO_UPDATE_FIELD_ROLE_OVERLAP', `the field ${JSON.stringify(fieldName)} is both a field to change and a field to keep`, { fieldName })]
      : [];
  });
  const missing = fieldNamesOf(candidate, () => true)
    .filter((name) => isEditableFieldName(candidate, name) && !draft.fieldNames.includes(name) && !update.keepFieldNames.includes(name))
    .map((fieldName) => errorOf(
      'SCENARIO_UPDATE_FIELD_ROLE_MISSING',
      `the visible, editable field ${JSON.stringify(fieldName)} is neither a field to change nor a field to keep`,
      { fieldName },
    ));
  const noChange = draft.fieldNames.length === 0
    ? [errorOf('SCENARIO_UPDATE_NO_CHANGED_FIELD', '/fieldNames must have at least one field to change for an update')]
    : [];
  return [...secretLike, ...secretLikeStates, ...stateChanges, ...removalChanges, ...keepErrors, ...missing, ...noChange];
};

/** UPDATE の指定の誤り（候補が分かるときだけ。kind ごとの有無、台帳の参照、path の型、欄の役割の順）。 */
const updateErrorsOf = (
  draft: ScenarioDraftInput,
  candidate: DiscoveryCandidate | null,
  context: ScenarioDraftContext,
): readonly ScenarioDraftError[] => {
  const kind = candidate === null ? null : scenarioKindOf(candidate.classification);
  const update = updateDraftOf(draft);
  if (candidate === null || kind === null) {
    return [];
  }
  if (kind === 'CREATE') {
    return update === null ? [] : [errorOf('SCENARIO_UPDATE_SPEC_NOT_ALLOWED', '/update must be null for a CREATE candidate')];
  }
  if (update === null) {
    return [errorOf('SCENARIO_UPDATE_SPEC_MISSING', '/update is required for an UPDATE candidate')];
  }
  const pathErrors = updatePathErrorsOf(update, candidate);
  return [
    ...updateTargetErrorsOf(draft, update, context),
    ...pathErrors,
    // T31R-fix-1 の I-2: 型が候補の path に戻るときだけ、台帳の取り方への結び付きを確かめる。
    ...(pathErrors.length === 0 ? updateLedgerBindingErrorsOf(draft, update, context) : []),
    ...updateFieldErrorsOf(draft, update, candidate),
  ];
};

/** 受けた UPDATE の指定の中身（候補の型にした識別の digest を足す。CREATE は null）。 */
const updateContentOf = (draft: ScenarioDraftInput, candidate: DiscoveryCandidate, kind: ScenarioKind): ScenarioUpdateSpec | null => {
  const update = updateDraftOf(draft);
  if (kind === 'CREATE' || update === null) {
    return null;
  }
  const pair = recordIdSegmentPairOfTemplates(update.formPathTemplate, update.actionPathTemplate);
  const templatedIdentityDigest = pair === null ? null : templatedIdentityDigestOf(candidate, pair);
  if (templatedIdentityDigest === null) {
    throw new Error('validateScenarioDraft accepted path templates without a templated identity digest');
  }
  return {
    targetCreateScenarioId: update.targetCreateScenarioId,
    formPathTemplate: update.formPathTemplate,
    actionPathTemplate: update.actionPathTemplate,
    keepFieldNames: [...update.keepFieldNames].sort(compareCodeUnits),
    templatedIdentityDigest,
  };
};

/**
 * READ の定義の参照 1 件の誤り（同じプロファイルにない・取り消した・版が違う。最初の 1 件）と、使える定義の今の事実。照らす READ の定義と、
 * 検証の指定の照合の READ（T30a）に共通。
 */
const readCheckReferenceCheckOf = (
  profileId: string,
  { readCheckId, revision }: ReadCheckReference,
  readChecks: readonly ScenarioReadCheckDefinitionFact[],
): { readonly error: ScenarioDraftError; readonly fact: null } | { readonly error: null; readonly fact: ScenarioReadCheckDefinitionFact } => {
  const label = JSON.stringify(readCheckId);
  const fact = readChecks.find((candidate) => candidate.readCheckId === readCheckId && candidate.profileId === profileId);
  if (fact === undefined) {
    return { error: errorOf('SCENARIO_READ_CHECK_NOT_FOUND', `the READ check ${label} is not a definition of the profile`, { readCheckId }), fact: null };
  }
  if (fact.canceledAt !== null) {
    return { error: errorOf('SCENARIO_READ_CHECK_CANCELED', `the READ check ${label} is canceled`, { readCheckId }), fact: null };
  }
  return fact.revision === revision
    ? { error: null, fact }
    : {
      error: errorOf('SCENARIO_READ_CHECK_REVISION_MISMATCH', `the READ check ${label} is at revision ${fact.revision}, not ${revision}`, { readCheckId }),
      fact: null,
    };
};

/** 照らす READ の定義の参照の誤り（参照ごとに 1 件）。 */
const readCheckErrorsOf = (draft: ScenarioDraftInput, readChecks: readonly ScenarioReadCheckDefinitionFact[]): readonly ScenarioDraftError[] =>
  draft.readChecks.flatMap((reference) => {
    const { error } = readCheckReferenceCheckOf(draft.profileId, reference, readChecks);
    return error === null ? [] : [error];
  });

/** 照合の READ の欄の名前が、シナリオの送る欄にないときの誤り。 */
const notSentErrorOf = (draft: ScenarioDraftInput, fieldName: string, readCheckId: string): readonly ScenarioDraftError[] =>
  draft.fieldNames.includes(fieldName)
    ? []
    : [errorOf(
      'SCENARIO_VERIFICATION_FIELD_NOT_SENT',
      `the field ${JSON.stringify(fieldName)} of the READ verification is not a field to send`,
      { fieldName, readCheckId },
    )];

/** 成功の条件と入力の誤りの条件が同時に当たりうるときの誤り（どちらかが未指定なら確かめない。T30a fix round 1）。 */
const conditionOverlapErrorsOf = (verification: ScenarioVerification | undefined): readonly ScenarioDraftError[] => {
  const success = verification?.successCondition ?? null;
  const inputError = verification?.inputErrorCondition ?? null;
  return success !== null && inputError !== null && mayMatchTogether(success, inputError)
    ? [errorOf(
      'SCENARIO_VERIFICATION_CONDITIONS_AMBIGUOUS',
      '/verification/successCondition and /verification/inputErrorCondition may match the same page',
    )]
    : [];
};

/** 照合の READ の誤り。 */
const readVerificationErrorsOf = (draft: ScenarioDraftInput, readChecks: readonly ScenarioReadCheckDefinitionFact[]): readonly ScenarioDraftError[] => {
  const read = draft.verification?.readVerification ?? null;
  if (read === null) {
    return [];
  }
  const { readCheckId } = read;
  const { error, fact } = readCheckReferenceCheckOf(draft.profileId, read, readChecks);
  return [
    ...(error === null ? [] : [error]),
    ...read.bindings.flatMap(({ parameterName, fieldName }) => [
      ...(fact === null || fact.parameterNames.includes(parameterName)
        ? []
        : [errorOf(
          'SCENARIO_VERIFICATION_PARAMETER_UNKNOWN',
          `the READ check ${JSON.stringify(readCheckId)} does not send a value named ${JSON.stringify(parameterName)}`,
          { readCheckId },
        )]),
      ...notSentErrorOf(draft, fieldName, readCheckId),
    ]),
    ...read.expectations.flatMap((expectation) => (expectation.kind === 'ROW_COUNT_EQUALS' ? [] : notSentErrorOf(draft, expectation.fieldName, readCheckId))),
  ];
};

/**
 * 検証の指定の誤り（T30a）: 2 つの結果の条件の重なり（fix round 1）、照合の READ の定義の参照（照らす READ の定義と同じ理由。1 件）、結び付けごと
 * に READ の送る値の名前（使える定義のときだけ）と送る欄、期待の欄（入力の順）。
 */
const verificationErrorsOf = (draft: ScenarioDraftInput, readChecks: readonly ScenarioReadCheckDefinitionFact[]): readonly ScenarioDraftError[] => [
  ...conditionOverlapErrorsOf(draft.verification),
  ...readVerificationErrorsOf(draft, readChecks),
];

/** 上限と期限の誤り（1 回の Run、累積、上限どうし、期限の順）。 */
const limitErrorsOf = (draft: ScenarioDraftInput): readonly ScenarioDraftError[] => {
  const { maxCreatesPerRun, maxCumulativeCreates } = draft.limits;
  return [
    ...(maxCreatesPerRun > DEFAULT_MAX_CREATES_PER_RUN
      ? [errorOf('SCENARIO_LIMIT_ABOVE_DEFAULT', `/limits/maxCreatesPerRun must be at most ${DEFAULT_MAX_CREATES_PER_RUN}`)]
      : []),
    ...(maxCumulativeCreates > DEFAULT_MAX_CUMULATIVE_CREATES
      ? [errorOf('SCENARIO_LIMIT_ABOVE_DEFAULT', `/limits/maxCumulativeCreates must be at most ${DEFAULT_MAX_CUMULATIVE_CREATES}`)]
      : []),
    ...(maxCreatesPerRun > maxCumulativeCreates
      ? [errorOf('SCENARIO_LIMIT_INCONSISTENT', '/limits/maxCreatesPerRun must be at most /limits/maxCumulativeCreates')]
      : []),
    ...(draft.approvalTtlDays > APPROVAL_TTL_DAYS
      ? [errorOf('SCENARIO_TTL_ABOVE_DEFAULT', `/approvalTtlDays must be at most ${APPROVAL_TTL_DAYS}`)]
      : []),
  ];
};

/** 結果の条件の写し（鍵の順を決める）。 */
const resultConditionContentOf = (condition: ScenarioResultCondition | null): ScenarioResultCondition | null =>
  condition === null ? null : { pathPrefix: condition.pathPrefix, selector: condition.selector };

/** 登録の ID の取り方の写し。 */
const recordIdContentOf = (spec: ScenarioRecordIdSpec | null): ScenarioRecordIdSpec | null => {
  if (spec === null) {
    return null;
  }
  return spec.source === 'URL_PATH_PATTERN' ? { source: spec.source, pathPattern: spec.pathPattern } : { source: spec.source, selector: spec.selector };
};

/** 照合の READ の期待の写し（鍵の順を決める）。 */
const expectationContentOf = (expectation: VerificationExpectation): VerificationExpectation => {
  switch (expectation.kind) {
    case 'ROW_COUNT_EQUALS':
      return { kind: expectation.kind, count: expectation.count };
    case 'TEXT_CONTAINS':
      return { kind: expectation.kind, fieldName: expectation.fieldName };
    case 'DETAIL_FIELD_EQUALS':
      return { kind: expectation.kind, field: expectation.field, fieldName: expectation.fieldName };
  }
};

/** 検証の指定の写し（照合の READ の結び付けは READ の送る値の名前の UTF-16 のコード単位の順。期待は入力の順）。 */
const verificationContentOf = (verification: ScenarioVerification): ScenarioVerification => {
  const read = verification.readVerification;
  return {
    successCondition: resultConditionContentOf(verification.successCondition),
    inputErrorCondition: resultConditionContentOf(verification.inputErrorCondition),
    recordId: recordIdContentOf(verification.recordId),
    readVerification: read === null ? null : {
      readCheckId: read.readCheckId,
      revision: read.revision,
      bindings: read.bindings
        .map(({ parameterName, fieldName }) => ({ parameterName, fieldName }))
        .sort((left, right) => compareCodeUnits(left.parameterName, right.parameterName)),
      expectations: read.expectations.map(expectationContentOf),
    },
  };
};

/** 受けた下書きと候補から、シナリオの中身を作る（凍結）。 */
const contentOf = (draft: ScenarioDraftInput, candidate: DiscoveryCandidate, kind: ScenarioKind, request: ScenarioRequestShape): ScenarioContent =>
  deepFreeze({
    profileId: draft.profileId,
    kind,
    candidate: { identityDigest: candidate.identityDigest, ruleDigest: candidate.ruleDigest },
    request,
    fieldNames: [...draft.fieldNames].sort(compareCodeUnits),
    readChecks: draft.readChecks
      .map(({ readCheckId, revision }) => ({ readCheckId, revision }))
      .sort((left, right) => compareCodeUnits(left.readCheckId, right.readCheckId)),
    sideEffectConfirmations: Object.fromEntries(SIDE_EFFECT_CONFIRMATIONS.map((item) => [item, draft.sideEffectConfirmations[item]])) as
      unknown as SideEffectConfirmations,
    limits: { maxCreatesPerRun: draft.limits.maxCreatesPerRun, maxCumulativeCreates: draft.limits.maxCumulativeCreates },
    approvalTtlDays: draft.approvalTtlDays,
    verification: verificationContentOf(draft.verification ?? UNSPECIFIED_VERIFICATION),
    update: updateContentOf(draft, candidate, kind),
  });

/**
 * シナリオの下書きを、対象の候補と照らす READ の定義の今の事実に照らして確かめる（純粋。入力を変えない）。誤りの順は、対象の候補、送る欄
 * （入力の順）、UPDATE の指定（T31b）、照らす READ の定義（入力の順）、検証の指定（T30a）、上限、期限。形が違えば、`SCENARIO_INPUT_INVALID` だけを
 * 返す。台帳の参照は、文脈（`context`。既定はシナリオの事実なし）のシナリオの事実で確かめる。
 */
export const validateScenarioDraft = (
  input: unknown,
  candidate: DiscoveryCandidate | null,
  readChecks: readonly ScenarioReadCheckDefinitionFact[],
  context: ScenarioDraftContext = NO_SCENARIO_DRAFT_CONTEXT,
): ScenarioDraftValidationResult => {
  const shapeErrors = shapeErrorsOf(input);
  if (shapeErrors.length > 0) {
    return rejected(shapeErrors);
  }
  const draft = input as unknown as ScenarioDraftInput;
  const candidateErrors = candidateErrorsOf(draft, candidate);
  const known = candidate !== null && candidate.identityDigest === draft.candidateIdentityDigest ? candidate : null;
  const errors = [
    ...candidateErrors,
    ...fieldErrorsOf(draft, known),
    ...createSelectErrorsOf(draft, known),
    ...unreadableSecretFieldErrorsOf(known),
    ...updateErrorsOf(draft, known, context),
    ...readCheckErrorsOf(draft, readChecks),
    ...verificationErrorsOf(draft, readChecks),
    ...limitErrorsOf(draft),
  ];
  const kind = known === null ? null : scenarioKindOf(known.classification);
  const request = known === null ? null : requestShapeOf(known);
  if (errors.length > 0 || known === null || kind === null || request === null) {
    return rejected(errors);
  }
  return Object.freeze({ ok: true, content: contentOf(draft, known, kind, request) });
};

/** 副作用の確認のうち、まだ確かめていない項目（閉じた一覧の順）。空なら、承認の前の確認はすべて済んでいる。 */
export const unconfirmedSideEffectsOf = (confirmations: SideEffectConfirmations): readonly SideEffectConfirmation[] =>
  Object.freeze(SIDE_EFFECT_CONFIRMATIONS.filter((item) => confirmations[item] !== true));

/** 検証の指定の未指定の項目（T30a。閉じた一覧の順。凍結）。空でなければ、実行の許可を出さない（`VERIFICATION_SPEC_MISSING`）。 */
export const missingVerificationItemsOf = (verification: ScenarioVerification): readonly ScenarioVerificationItem[] =>
  Object.freeze(SCENARIO_VERIFICATION_ITEMS.filter((item) => verification[item] === null));

/** スキーマで形を確かめた凍結した写し。通らなければ `RangeError`（呼び出し側の誤り）。手順は `schema-checked-copy.ts`（CCX-17。CC-077）。 */
const storableCopyOf = <T>(schemaName: 'scenario' | 'approval-receipt', subject: string, value: T): T =>
  requireSchemaCheckedCopy<T>(schemaName, subject, value);

/** 保存の前の確かめ直し（シナリオの版 1 つ）。凍結した写しを返す。 */
export const assertStorableScenarioRevision = (revision: ScenarioRevision): ScenarioRevision =>
  storableCopyOf('scenario', 'scenario revision', revision);

/**
 * 保存した版の文書を読む（T30a）。検証の指定の前に保存した版（`verification` の項目がない）は、すべて未指定として読む。そのあと
 * `assertStorableScenarioRevision` と同じく、スキーマで形を確かめた凍結した写しを返す（通らなければ `RangeError`。壊れた検証の指定は既定に
 * 直さない）。
 */
export const storedScenarioRevisionOf = (document: unknown): ScenarioRevision => {
  const withVerification = isRecord(document) && !Object.hasOwn(document, 'verification')
    ? { ...document, verification: UNSPECIFIED_VERIFICATION }
    : document;
  // T31b: UPDATE の指定の前に保存した版（`update` の項目がない）は、指定なしとして読む（UPDATE の版は、承認と発行ができない）。
  const withUpdate = isRecord(withVerification) && !Object.hasOwn(withVerification, 'update')
    ? { ...withVerification, update: null }
    : withVerification;
  return storableCopyOf('scenario', 'stored scenario revision', withUpdate as ScenarioRevision);
};

/** 保存の前の確かめ直し（承認か撤回の記録 1 件）。凍結した写しを返す。 */
export const assertStorableApprovalReceipt = <T extends ApprovalReceiptRecord>(receipt: T): T =>
  storableCopyOf('approval-receipt', 'approval receipt', receipt);

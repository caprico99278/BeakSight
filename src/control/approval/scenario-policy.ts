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
// - T40a-fix（Task 40 の設計書 7 章の「T40a の報告（API の検証の指定）」）: API のシナリオで求める項目は、照合の READ と ID の取り方だけ
//   （`API_SCENARIO_VERIFICATION_ITEMS`。ID の取り方は API の指定の `recordId` か検証の指定の `recordId` のどちらか）。成否の条件と入力の誤りの条件は、
//   API のシナリオの下書きに入っていても拒まない（形と同時に当たりうるかの確かめは FORM と同じに行うが、許可の判定と開始の指定（`START` では null）
//   と画面では使わない）。
// - T40R-fix-B（Task 40 の設計書 7 章の「T40R」の行の I-2）: API のシナリオの `{id}` の照合の READ は、生成した値と比べる期待を 1 つ以上求める
//   （`SCENARIO_API_READ_VERIFICATION_NOT_BOUND`。判定は `hasGeneratedValueExpectation`。IPC の手書きの確かめと同じ部品）。
// - T40R2-fix（Task 40 の設計書 7 章の「T40R2」の行）: 比べる欄が実行のたびに変わる値か（M-1）は、入力の規則がまだない保存の時には判定できないので、
//   許可の発行（`READ_VERIFICATION_NOT_VARYING`。`src/control/data-rules/varying-values.ts`）で確かめる。画面から ID を取る型が書き込みの画面に当たる
//   場合は、保存で拒まず、画面に注意を出す（使える度合い。core の `recordIdPatternMatchesPagePath`）。
// - LG-3（2026-10-24 のテストの組の設計 3.7.2）: 検証の指定の前に保存した版（`verification` の項目がない）を、すべて未指定として読む読み替えは
//   捨てた。読むとき（`storedScenarioRevisionOf`）にスキーマの誤りになる（壊れた検証の指定と同じく、既定に直さない）。
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
// - LG-3: UPDATE の指定の前に保存した版（`update` の項目がない。form の UPDATE で null）と、T41a の前に保存した API の更新（保つ鍵・型にした識別の
//   digest・台帳の参照がない）は、読むとき（`storedScenarioRevisionOf`）にスキーマの誤りになる（T31b の「指定なし（null）として読む」は捨てた）。
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
  PATH_NOT_BOUND_TO_LEDGER_ID_REJECTION_REASON,
  SCENARIO_DRAFT_REJECTION_REASONS,
  type ScenarioDraftRejectionReason,
} from '../../core/scenario-draft-rejection-reasons.js';
import {
  MAX_FIELD_NAME_LENGTH,
  isDefaultValueFieldType,
  isMethodOverrideFieldName,
  isUnsendableFieldType,
  type DiscoveryCandidate,
} from '../../discovery/candidate-contracts.js';
import {
  fieldNameHasDestructiveWord,
  fieldNameHasRemovalWord,
  fieldNameHasStateWord,
  isApiWriteKeyNameSecretLike,
} from '../../discovery/classify.js';
import {
  concretePathOfTemplate,
  pagePathTemplatedIdentityDigestOf,
  recordIdOfTemplates,
  recordIdSegmentPairOfTemplates,
  templatedIdentityDigestOf,
} from '../../discovery/fingerprint.js';
import { usableRecordIdOf } from '../actions/action-outcome.js';
import { isAcceptedPath, isAcceptedSelector, mayMatchTogether } from '../auth/auth-setup-policy.js';
import { isOriginInAllowedOrigins } from '../../crawl/normalize-url.js';
import {
  MAX_READ_CHECK_DETAIL_FIELD_LENGTH,
  hasGeneratedValueExpectation,
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
  API_SCENARIO_VERIFICATION_ITEMS,
  API_UPDATE_SCENARIO_VERIFICATION_ITEMS,
  API_SCENARIO_TRANSPORT,
  scenarioTransportOf,
  SIDE_EFFECT_CONFIRMATIONS,
  UNSPECIFIED_VERIFICATION,
  type ApprovalReceiptRecord,
  type ReadCheckReference,
  type ScenarioContent,
  type ScenarioKind,
  type ScenarioApiRequestShape,
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
  MAX_SCENARIO_API_KEY_LENGTH,
  MAX_SCENARIO_API_KEYS,
  SCENARIO_API_RECORD_ID_SOURCES,
  SCENARIO_TRANSPORTS,
  isScenarioApiFieldJsonTypePair,
  scenarioApiFieldIdentityOf,
  type ScenarioApiDraft,
  type ScenarioApiFieldIdentity,
  type ScenarioApiKeyField,
  type ScenarioApiMethod,
  type ScenarioApiPageKey,
  type ScenarioApiSpec,
  type ScenarioTransport,
} from './scenario-contracts.js';
import {
  API_METHOD_OVERRIDE_HEADER_NAMES,
  API_SELECTION_QUERY_NAMES,
  isRecordIdLikePathSegment,
  lastRecordIdLikePathSegmentIndexOf,
  pageHeaderNamesOf,
  type ApiJsonValueType,
  type ApiRequestShape,
} from '../../core/api-request-shape.js';
import { apiShapeDigestOf, apiShapeHasSoftDeleteKey, classifyApiShapeObservation } from '../../discovery/api-shape-classification.js';
import { submissionProbeKeyFieldsOf, submissionProbeWriteOf, type SubmissionProbeRecord } from '../../discovery/submission-probe-contracts.js';

/** ページが決める鍵に許す JSON の型（scalar だけ。T38R-fix の I-2）。 */
const API_SCALAR_JSON_TYPES = Object.freeze(['string', 'number', 'boolean', 'null'] as const satisfies readonly ApiJsonValueType[]);

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
 * - `SCENARIO_VERIFICATION_READ_CHECK_PAGE_TARGET`（T37d fix round 1）: 照合の READ の定義が、画面の path を読む定義（照合は、候補の送信先に生成した
 *   値を付けて読む形だけ）。書き込みの開始の拒否（`WRITE_READ_VERIFICATION_PAGE_TARGET`）と同じ意味で、保存の時点で拒む。T38c: API のシナリオの
 *   `{id}` つきの画面の path の定義だけは受ける（下の API の確かめの節）。
 * PRE42-CC 組 UI-K3（台帳の CC-113）: 一覧の値は、画面のブラウザ側からも読める純粋なファイル `src/core/scenario-draft-rejection-reasons.ts` に移し、
 * ここは同じ名前で公開し直す（意味の説明と判定はここのまま。Gate `approval-ssot` の (a)）。
 */
export {
  PATH_NOT_BOUND_TO_LEDGER_ID_REJECTION_REASON,
  SCENARIO_DRAFT_REJECTION_REASONS,
  type ScenarioDraftRejectionReason,
};

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
  /** T38b: 送り方（省けば `FORM`）。`API` のときは `api` が必須で、`fieldNames` は送る本文の鍵。 */
  readonly transport?: ScenarioTransport;
  /** T38b: API の指定（送り方が `API` のときだけ）。 */
  readonly api?: ScenarioApiDraft;
}

/**
 * 下書きの確かめの文脈（T31b）: 確かめるシナリオの id（作成と版の更新。分からなければ null）と、台帳の参照を確かめるシナリオの事実（今の版の
 * kind。ほかのプロファイルを含んでよい）。
 */
export interface ScenarioDraftContext {
  readonly scenarioId: string | null;
  readonly scenarios: readonly ScenarioKindFact[];
  /**
   * T38b: プロファイルの承認したサービスの Origin（プロファイルの一覧の順。probe の型の Origin の番号を文字列にする。省けば空。API の候補は、ここにない
   * Origin を拒む）。
   */
  readonly approvedServiceOrigins?: readonly string[];
  /**
   * T38c（T38b の報告の (2)）: 候補を見つけた発見のジョブのプロファイルの改訂（ジョブの行の `profile_revision`。分からなければ null）と、今の改訂。型の
   * Origin は probe の時の承認したサービスの Origin の一覧の番号なので、API の下書きは 2 つが同じであることを求める（省けば拒む。fail-closed）。
   */
  readonly profileRevisions?: { readonly discoveryJob: number | null; readonly current: number };
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
const OPTIONAL_DRAFT_KEYS: readonly (keyof ScenarioDraftInput)[] = Object.freeze(['verification', 'update', 'transport', 'api']);
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

/**
 * 照合の READ の結び付けの形の誤り。T38c: API の下書きだけ、0 件を形として受ける（`{id}` つきの画面の path の READ は送る値を持たない。定義に照らした
 * 確かめは `readVerificationErrorsOf`）。FORM の下書きは今どおり 1 件以上。
 */
const bindingsShapeErrorsOf = (value: unknown, path: string, allowEmpty: boolean): readonly ScenarioDraftError[] => {
  const minimum = allowEmpty ? 0 : 1;
  if (!Array.isArray(value) || value.length < minimum || value.length > MAX_VERIFICATION_BINDINGS) {
    return [invalid(`${path} must be an array of ${minimum} to ${MAX_VERIFICATION_BINDINGS} bindings`)];
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
const readVerificationShapeErrorsOf = (value: unknown, allowEmptyBindings: boolean): readonly ScenarioDraftError[] => {
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
  errors.push(
    ...bindingsShapeErrorsOf(value.bindings, `${path}/bindings`, allowEmptyBindings),
    ...expectationsShapeErrorsOf(value.expectations, `${path}/expectations`),
  );
  return errors;
};

/** 検証の指定の形の誤り（T38c: 照合の READ の結び付けの 0 件は、API の下書きだけ形として受ける）。 */
const verificationShapeErrorsOf = (value: unknown, allowEmptyBindings: boolean): readonly ScenarioDraftError[] => {
  if (!isRecord(value)) {
    return [invalid('/verification must be an object')];
  }
  return [
    ...keyErrorsOf(value, SCENARIO_VERIFICATION_ITEMS, '/verification'),
    ...resultConditionShapeErrorsOf(value.successCondition ?? null, '/verification/successCondition'),
    ...resultConditionShapeErrorsOf(value.inputErrorCondition ?? null, '/verification/inputErrorCondition'),
    ...recordIdShapeErrorsOf(value.recordId ?? null),
    ...readVerificationShapeErrorsOf(value.readVerification ?? null, allowEmptyBindings),
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
    errors.push(...verificationShapeErrorsOf(input.verification, input.transport === API_SCENARIO_TRANSPORT));
  }
  errors.push(...updateShapeErrorsOf(input.update));
  errors.push(...transportShapeErrorsOf(input));
  return errors;
};

// ---------------------------------------------------------------------------------------------------------------
// T38b: 送り方と API の指定の形（すべて `SCENARIO_INPUT_INVALID`）
// ---------------------------------------------------------------------------------------------------------------

/** API の指定の鍵。 */
const API_DRAFT_KEYS: readonly (keyof ScenarioApiDraft)[] = Object.freeze(['shapeDigest', 'pageKeys', 'filterName', 'recordId', 'ledger']);
const API_RECORD_ID_KEYS = Object.freeze(['source', 'key'] as const);
const API_LEDGER_KEYS = Object.freeze(['targetCreateScenarioId', 'formPathTemplate'] as const);

/** T41a: API の指定の省ける鍵（保つ鍵）。 */
const OPTIONAL_API_DRAFT_KEYS: readonly (keyof ScenarioApiDraft)[] = Object.freeze(['keptKeys']);

/** API の名前（鍵・filter）の形か（1 文字以上、`MAX_SCENARIO_API_KEY_LENGTH` 以下）。 */
const isApiNameText = (value: unknown): value is string => isBoundedText(value, MAX_SCENARIO_API_KEY_LENGTH);

/** 鍵の名前の一覧（ページが決める鍵、T41a の保つ鍵）の形の誤り（配列、件数の上限、名前の形、重複）。 */
const apiKeyNamesShapeErrorsOf = (value: unknown, path: string): readonly ScenarioDraftError[] => {
  if (!Array.isArray(value) || value.length > MAX_SCENARIO_API_KEYS) {
    return [invalid(`${path} must be an array of at most ${MAX_SCENARIO_API_KEYS} keys`)];
  }
  return value.flatMap((key: unknown, index) => {
    if (!isApiNameText(key)) {
      return [invalid(`${path}/${index} must be a string of 1 to ${MAX_SCENARIO_API_KEY_LENGTH} code units`)];
    }
    return value.indexOf(key) === index ? [] : [invalid(`${path}/${index} is a duplicate`)];
  });
};

/** API の指定の形の誤り。 */
const apiShapeErrorsOf = (value: unknown): readonly ScenarioDraftError[] => {
  const path = '/api';
  if (!isRecord(value)) {
    return [invalid(`${path} must be an object`)];
  }
  const errors = [...keyErrorsOf(value, API_DRAFT_KEYS, path, OPTIONAL_API_DRAFT_KEYS)];
  if (!isSha256Fingerprint(value.shapeDigest)) {
    errors.push(invalid(`${path}/shapeDigest must be a shape digest of a submission probe`));
  }
  errors.push(...apiKeyNamesShapeErrorsOf(value.pageKeys, `${path}/pageKeys`));
  // T41a: 保つ鍵（省ける。省けば既定）。
  if (Object.hasOwn(value, 'keptKeys')) {
    errors.push(...apiKeyNamesShapeErrorsOf(value.keptKeys, `${path}/keptKeys`));
  }
  if (value.filterName !== null && !isApiNameText(value.filterName)) {
    errors.push(invalid(`${path}/filterName must be null or a string of 1 to ${MAX_SCENARIO_API_KEY_LENGTH} code units`));
  }
  const { recordId, ledger } = value;
  if (recordId !== null) {
    if (!isRecord(recordId) || !(SCENARIO_API_RECORD_ID_SOURCES as readonly unknown[]).includes(recordId.source) || !isApiNameText(recordId.key)) {
      errors.push(invalid(`${path}/recordId must be null or a key of the response body (${SCENARIO_API_RECORD_ID_SOURCES.join(', ')})`));
    } else {
      errors.push(...keyErrorsOf(recordId, API_RECORD_ID_KEYS, `${path}/recordId`));
    }
  }
  if (ledger !== null) {
    if (!isRecord(ledger)) {
      errors.push(invalid(`${path}/ledger must be null or an object`));
    } else {
      errors.push(...keyErrorsOf(ledger, API_LEDGER_KEYS, `${path}/ledger`));
      if (typeof ledger.targetCreateScenarioId !== 'string' || !SCENARIO_ID_PATTERN.test(ledger.targetCreateScenarioId)) {
        errors.push(invalid(`${path}/ledger/targetCreateScenarioId must match ${SCENARIO_ID_PATTERN.source}`));
      }
      if (!isRecordIdPathPattern(ledger.formPathTemplate, MAX_UPDATE_PATH_TEMPLATE_LENGTH)) {
        errors.push(invalid(`${path}/ledger/formPathTemplate must be a path with ${RECORD_ID_PLACEHOLDER} once as a whole segment, without a query`));
      }
    }
  }
  return errors;
};

/** 送り方と API の指定の形の誤り（送り方が `API` のときだけ API の指定を持ち、`API` なら必ず持つ）。 */
const transportShapeErrorsOf = (input: Record<string, unknown>): readonly ScenarioDraftError[] => {
  const { transport } = input;
  if (Object.hasOwn(input, 'transport') && !(SCENARIO_TRANSPORTS as readonly unknown[]).includes(transport)) {
    return [invalid(`/transport must be one of ${SCENARIO_TRANSPORTS.join(', ')}`)];
  }
  if (transport !== API_SCENARIO_TRANSPORT) {
    return Object.hasOwn(input, 'api') ? [invalid('/api is allowed only for the transport API')] : [];
  }
  return Object.hasOwn(input, 'api') ? apiShapeErrorsOf(input.api) : [invalid('/api is required for the transport API')];
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

/** 台帳の結び付けの決まり（T41b）: form の UPDATE の送信先の型（今まで）と、API の UPDATE の更新の画面の型。 */
const FORM_ACTION_LEDGER_BINDING = 'FORM_ACTION';
const API_PAGE_LEDGER_BINDING = 'API_PAGE';
type LedgerBinding = typeof FORM_ACTION_LEDGER_BINDING | typeof API_PAGE_LEDGER_BINDING;

/**
 * UPDATE の送信先の path の型の `{id}` の位置が、台帳（参照した CREATE のシナリオ）の登録の ID の取り方に結び付くか（T31R-fix-1 の I-2。純粋。下書きの
 * 確かめ、発行の確かめ直し、画面の型の選択肢が共用する唯一の判定）。
 * - `URL_PATH_PATTERN`（T31R2-fix-1 の I-1 で厳しくした）: (a) 送信先の型の `{id}` の後ろの区切りの並びが、台帳の型の `{id}` の後ろの並びと同じ
 *   （台帳が `/members/{id}` なら後ろなし）。(b) 送信先の型の `{id}` の前の区切りの並びが、台帳の型の `{id}` の前の並び全体と、後ろから続けて一致する
 *   （`/admin/members/{id}` は台帳 `/members/{id}` に合い、`/b/members/{id}` は台帳 `/a/members/{id}` に合わない）。
 * - `ELEMENT`: 送信先の型の `{id}` が、最後の区切り（成功の画面の要素から取る ID は、送信先の最後の区切りのレコードの ID とみなす）。
 * - 取り方が未指定（null）なら確かめない（真）。照合まで済んだ登録がないので、発行が対象なしで止まる。型の形が違えば偽。
 * T41a: API の UPDATE は、送信先の型の代わりに更新の画面の path の型を渡す（`apiUpdateLedgerBindingRejectionOf`）。
 * T41b（Task 41 の設計書 8 章の「T41a・T41c の報告と設計者の判断」の (1)）: 結び付けの決まりを引数（`binding`）で選ぶ。既定の
 * `FORM_ACTION_LEDGER_BINDING` は上のとおり（form の UPDATE。変えない）。`API_PAGE_LEDGER_BINDING`（API の UPDATE の更新の画面の型）は、`URL_PATH_PATTERN`
 * なら `{id}` の位置（区切りの番号）と `{id}` より前の区切りがすべて同じであること（後ろの区切りは違ってよい。台帳 `/admin/members/{id}` と更新の画面
 * `/admin/members/{id}/edit` は結び付く）、`ELEMENT` なら `{id}` より後ろに ID の区切り（core の `isRecordIdLikePathSegment`）がないこと。
 */
export const isUpdatePathBoundToLedger = (
  actionPathTemplate: string,
  ledgerRecordId: ScenarioRecordIdSpec | null,
  binding: LedgerBinding = FORM_ACTION_LEDGER_BINDING,
): boolean => {
  if (ledgerRecordId === null) {
    return true;
  }
  const actionSegments = actionPathTemplate.split(PATH_SEPARATOR);
  if (ledgerRecordId.source === 'ELEMENT') {
    const own = recordIdSegmentPairOfTemplates(actionPathTemplate, actionPathTemplate);
    if (own === null) {
      return false;
    }
    return binding === API_PAGE_LEDGER_BINDING
      ? actionSegments.slice(own.actionSegment + 1).every((segment) => !isRecordIdLikePathSegment(segment))
      : own.actionSegment === actionSegments.length - 1;
  }
  const pair = recordIdSegmentPairOfTemplates(ledgerRecordId.pathPattern, actionPathTemplate);
  if (pair === null) {
    return false;
  }
  const ledgerSegments = ledgerRecordId.pathPattern.split(PATH_SEPARATOR);
  // 先頭の空の区切り（`/` の前）は比べない。
  const ledgerBefore = ledgerSegments.slice(1, pair.pageSegment);
  const actionBefore = actionSegments.slice(1, pair.actionSegment);
  if (binding === API_PAGE_LEDGER_BINDING) {
    return pair.pageSegment === pair.actionSegment && ledgerBefore.every((segment, index) => actionBefore[index] === segment);
  }
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
  const reference = readCheckReferenceCheckOf(draft.profileId, read, readChecks);
  // T38c（ユーザーの判断 (3)、T38c の Blocker の判断（案 A））: API のシナリオに限って、`{id}` つきの画面の path の定義を照合の READ に使える（送る値が
  // ないので、結び付けは 0 件。1 件でもあれば、送る値の名前の誤り）。
  const apiPageTemplate = draft.transport === API_SCENARIO_TRANSPORT && reference.fact?.targetKind === 'PAGE' && reference.fact.pageTemplate === true;
  // T37d fix round 1: ほかの画面の path を読む定義は、照合の READ に使わない（送る値がないので、結び付けの名前の誤りとは言わずに、この理由だけを出す）。
  const pageTarget = reference.fact?.targetKind === 'PAGE' && !apiPageTemplate;
  const error = pageTarget
    ? errorOf('SCENARIO_VERIFICATION_READ_CHECK_PAGE_TARGET', `the READ check ${JSON.stringify(readCheckId)} reads a page path, not a READ candidate`,
      { readCheckId })
    : reference.error;
  const fact = pageTarget ? null : reference.fact;
  // T38c: 候補の READ は、結び付けが 1 件以上（形で 0 件を受けるのは API の下書きだけ）。
  const unbound = fact !== null && !apiPageTemplate && read.bindings.length === 0
    ? [invalid(`/verification/readVerification/bindings the READ check ${JSON.stringify(readCheckId)} needs at least one binding`)]
    : [];
  // T40R-fix-B（I-2 (a)）: `{id}` の照合の READ は送る値を持たないので、生成した値と比べる期待が 1 つ以上要る（行の数だけでは、取り違えた ID の画面でも
  // 一致しうる）。判定は IPC と同じ `hasGeneratedValueExpectation`。
  const valueUnbound = apiPageTemplate && !hasGeneratedValueExpectation(read.expectations)
    ? [errorOf('SCENARIO_API_READ_VERIFICATION_NOT_BOUND',
      `the READ check ${JSON.stringify(readCheckId)} reads a page path template and needs an expectation compared with a generated value`, { readCheckId })]
    : [];
  return [
    ...(error === null ? [] : [error]),
    ...unbound,
    ...valueUnbound,
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

// ---------------------------------------------------------------------------------------------------------------
// T38b: API のシナリオの下書き（Task 38 の設計書 3.2、4 章、7 章の履歴のユーザーの判断）
// ---------------------------------------------------------------------------------------------------------------
// 対象は、probe の結果が `API_CREATE`・`API_UPDATE` で、欄の範囲（`inputFields`。T38a の後の probe）を持ち、型の digest が下書きの `api.shapeDigest` の
// 候補の行（呼び出し側が `candidateOfDiscoveryDocumentByShape` で選ぶ）。候補の誤りは、ここで 1 件だけ返し、ほかの API の確かめをしない（上から順）:
// - `SCENARIO_API_CANDIDATE_NOT_API`: probe がない、結果が `API_CREATE`・`API_UPDATE` でない、型か欄の範囲がない、型の digest が下書きと違う・型から
//   求め直した digest と違う。
// - `SCENARIO_API_STATE_KEY`: 論理削除にあたる鍵（`stateKeyPresent`、状態の語の鍵）。DEF-147: 判定は型の分類と同じ `apiShapeHasSoftDeleteKey`（公開の状態の
//   鍵 status・is_published・published_at などだけなら論理削除にしない）。
// - `SCENARIO_API_METHOD_OVERRIDE`: 本文の最上位の鍵 `_method`（`isMethodOverrideFieldName`）。
// - `SCENARIO_API_HEADER_METHOD_OVERRIDE`: 許すヘッダの名前（ページが付けた名前）に、method を上書きする名前（`API_METHOD_OVERRIDE_HEADER_NAMES`）。
// - `SCENARIO_API_ORIGIN_NOT_APPROVED`: 型の Origin が、プロファイルの承認したサービスの Origin（文脈の一覧の番号）にない。
// - `SCENARIO_API_SHAPE_NOT_EXECUTABLE`: I21 の確かめ直し（probe の分類と同じ部品 `classifyApiShapeObservation` で 1 つの型を分類し直した結果が、probe の
//   結果と違う。method が `POST`（CREATE）・`PATCH`（UPDATE）と組でない）。
// 鍵と欄（送る欄 `fieldNames` は送る本文の鍵。鍵と欄の対応は `submissionProbeKeyFieldsOf`）:
// - 送る鍵の名前が秘密に見える・危険な語 → FORM と同じ `SCENARIO_FIELD_SECRET_LIKE`・`SCENARIO_FIELD_DANGEROUS_WORD`。
// - `SCENARIO_API_FIELD_KEY_MISMATCH`: 送る鍵が型の鍵でない・欄にちょうど 1 つ対応しない、同じ欄が 2 つ以上の鍵に対応する、欄に対応する鍵を送らない。
// - `SCENARIO_API_FIELD_TYPE_MISMATCH`: 欄の型と JSON の型が合わない（`SCENARIO_API_FIELD_JSON_TYPES`。number の欄 × string など）。
// - `SCENARIO_API_KEY_NOT_ALLOWED`: 欄に対応しない鍵が、ページが決める鍵の一覧にない。ページが決める鍵の一覧の名前が、型の鍵でないか、欄に対応する鍵。
// - `SCENARIO_API_PAGE_KEY_SECRET_LIKE`: ページが決める鍵の名前が秘密に見える（値を照らさない鍵に秘密を運ばせない）。T38R-fix の I-2: 比べ方は
//   部分一致の fail-closed の方針（`isApiWriteKeyNameSecretLike`）。
// - T38R-fix の I-2: `SCENARIO_API_PAGE_KEY_NOT_SCALAR`（ページが決める鍵の JSON の型が scalar でない）、`SCENARIO_API_RECORD_ID_KEY_SECRET_LIKE`（登録の
//   ID を読む応答の鍵の名前が秘密に見える）。
// - T38R-fix の C-1: probe に記録できなかった型がある、probe の読み取りでない要求の数で分類し直すと書き込みの probe でない →
//   `SCENARIO_API_SHAPE_NOT_EXECUTABLE`。
// - `SCENARIO_API_FILTER_MISMATCH`: UPDATE の filter の名前が、型の filter の名前と違う。CREATE が filter の名前を持つ。
// UPDATE の台帳の参照（`api.ledger`）は FORM の UPDATE と同じ理由（`SCENARIO_UPDATE_SPEC_MISSING`・`_NOT_ALLOWED`・`_TARGET_NOT_FOUND`・
// `_TARGET_NOT_CREATE`・`_PATH_MISMATCH`・`_RECORD_ID_UNSAFE`）。FORM の UPDATE の指定（`update`）は持てない（`SCENARIO_UPDATE_SPEC_NOT_ALLOWED`）。
// T38c:
// - `SCENARIO_API_DISCOVERY_PROFILE_STALE`: 候補を見つけた発見のジョブのプロファイルの改訂が、今の改訂と違う（文脈の `profileRevisions`。分からないときも）。
// - 照合の READ に、`{id}` つきの画面の path の定義（文脈の READ の事実の `pageTemplate`）を使える（結び付けは 0 件）。型でない画面の path の定義は
//   FORM と同じく `SCENARIO_VERIFICATION_READ_CHECK_PAGE_TARGET`。候補の READ の結び付けが 0 件なら `SCENARIO_INPUT_INVALID`。

// T41a（Task 41 の設計書 3.1、3.3 のページが決める鍵）: API の UPDATE。
// - 保つ鍵（`api.keptKeys`。省けば、目印の付いた欄の鍵のうち変える鍵でないものすべて）: 変える鍵と重なる → `SCENARIO_UPDATE_FIELD_ROLE_OVERLAP`、欄に
//   ちょうど 1 つ対応しない → `SCENARIO_API_FIELD_KEY_MISMATCH`、秘密に見える名前 → `SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD`（値を読めない）、目印の
//   付いた欄の鍵がどちらでもない → `SCENARIO_UPDATE_FIELD_ROLE_MISSING`、変える鍵がない → `SCENARIO_UPDATE_NO_CHANGED_FIELD`。登録は保つ鍵を持てない
//   （`SCENARIO_API_FIELD_KEY_MISMATCH`）。
// - ページが決める鍵: 更新の画面の欄として識別できない（選んだ欄で名前が同じものがちょうど 1 つでない）→ `SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE`。
// - 台帳の型の `{id}` が画面の path の最後の ID の区切りでない → `SCENARIO_UPDATE_PATH_MISMATCH`。台帳の ID の取り方への結び付き
//   （`apiUpdateLedgerBindingRejectionOf`）→ `SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID`・`SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID`。
// - 受けた UPDATE の指定は、保つ鍵、ページが決める鍵の欄の識別、画面の path を型にした識別の digest（`pagePathTemplatedIdentityDigestOf`）を持つ。

// T38R-fix の M-2: probe の結果ごとのシナリオの kind と method は、契約の 1 か所（`submissionProbeWriteOf`）。

// T38e: 欄の型と JSON の型の組（`SCENARIO_API_FIELD_JSON_TYPES`）と、probe の欄の識別（`scenarioApiFieldIdentityOf`）は、入力の規則の判定と
// 共用するので `scenario-contracts.ts` に置く。

/** 欄の識別の比べる形。 */
const fieldIdentityKeyOf = (identity: ScenarioApiFieldIdentity): string => JSON.stringify(identity);

/** 受けた API の候補の事実（候補の誤りがないとき）。 */
interface AcceptedApiCandidate {
  readonly probe: SubmissionProbeRecord;
  readonly shape: ApiRequestShape;
  readonly kind: ScenarioKind;
  readonly method: ScenarioApiMethod;
  readonly origin: string;
  readonly headerNames: readonly string[];
}

/** 型の送り先の Origin の文字列（承認したサービスの Origin の一覧の番号から。承認した Origin でなければ undefined）。 */
const apiShapeOriginOf = (shape: ApiRequestShape, approvedServiceOrigins: readonly string[]): string | undefined =>
  (shape.origin.kind === 'APPROVED_API' ? approvedServiceOrigins[shape.origin.index] : undefined);

/**
 * T41e-3（T41R-fix-B の申し送り）: probe の型の要求の送り先（Origin の文字列と path の型。下書きの確かめが API の指定の `request` に写すのと同じ値）。型が
 * ないか、承認したサービスの Origin でなければ null。画面が、API の更新の台帳の選択肢を絞る確かめ（`apiUpdateLedgerBindingRejectionOf`）の、確かめのための
 * 事実に使う。
 */
export const apiRequestTargetOfProbe = (
  probe: SubmissionProbeRecord,
  approvedServiceOrigins: readonly string[],
): Pick<ScenarioApiRequestShape, 'origin' | 'pathShape'> | null => {
  const shape = probe.shape ?? null;
  const origin = shape === null ? undefined : apiShapeOriginOf(shape, approvedServiceOrigins);
  return shape === null || origin === undefined ? null : { origin, pathShape: shape.pathShape };
};

/** API の候補の誤り（ファイルの説明の順で最初の 1 件）か、受けた候補の事実。 */
const apiCandidateOf = (
  draft: ScenarioDraftInput,
  api: ScenarioApiDraft,
  candidate: DiscoveryCandidate | null,
  context: ScenarioDraftContext,
): { readonly ok: true; readonly accepted: AcceptedApiCandidate } | { readonly ok: false; readonly error: ScenarioDraftError } => {
  const failed = (code: ScenarioDraftRejectionReason, detail: string) => ({ ok: false as const, error: errorOf(code, detail) });
  if (candidate === null || candidate.identityDigest !== draft.candidateIdentityDigest) {
    return failed('SCENARIO_CANDIDATE_UNKNOWN', 'the target candidate is not the given candidate of the latest discovery');
  }
  const probe = candidate.submissionProbe;
  const expected = probe === undefined ? null : submissionProbeWriteOf(probe.result);
  const shape = probe?.shape ?? null;
  if (probe === undefined || expected === null || shape === null || probe.inputFields === undefined || probe.shapeDigest !== api.shapeDigest
    || apiShapeDigestOf(shape) !== probe.shapeDigest) {
    return failed('SCENARIO_API_CANDIDATE_NOT_API', 'the target candidate has no submission probe of API_CREATE or API_UPDATE with the input fields and the shape digest');
  }
  // DEF-147: 論理削除にあたる鍵の判定は、型の分類と同じ 1 か所（公開の状態の鍵だけなら論理削除にしない）。
  if (apiShapeHasSoftDeleteKey(shape)) {
    return failed('SCENARIO_API_STATE_KEY', 'the body of the request has a key of a state (a soft delete)');
  }
  if (shape.body.keys.some(({ name }) => isMethodOverrideFieldName(name))) {
    return failed('SCENARIO_API_METHOD_OVERRIDE', 'the body of the request overrides the method');
  }
  // T38R-fix の M-2: ページが付けたヘッダの名前の正規化は、契約の 1 か所（型の digest と同じ）。
  const headerNames = pageHeaderNamesOf(shape.headerNames);
  if (headerNames.some((name) => (API_METHOD_OVERRIDE_HEADER_NAMES as readonly string[]).includes(name))) {
    return failed('SCENARIO_API_HEADER_METHOD_OVERRIDE', 'a header name of the request overrides the method');
  }
  const origin = apiShapeOriginOf(shape, context.approvedServiceOrigins ?? []);
  if (origin === undefined) {
    return failed('SCENARIO_API_ORIGIN_NOT_APPROVED', 'the origin of the request is not an approved service origin of the profile');
  }
  // T38R-fix の C-1: 記録できなかった型がある probe は、どの要求を承認するか分からないので拒む。
  if (probe.unrecordedShapeCount > 0) {
    return failed('SCENARIO_API_SHAPE_NOT_EXECUTABLE', 'the probe has a request whose shape was not recorded');
  }
  // I21 の確かめ直し: probe の分類と同じ部品で、この 1 つの型を分類し直す（probe の結果を信じない）。T38R-fix の C-1: 読み取りでない要求の数は、probe
  // の記録の数を使う（2 つの要求なら `MULTIPLE_REQUESTS`）。
  const reclassified = classifyApiShapeObservation({ shapes: [shape], nonReadRequestCount: probe.nonReadRequestCount });
  if (reclassified.classification !== probe.result || shape.method !== expected.method) {
    return failed('SCENARIO_API_SHAPE_NOT_EXECUTABLE',
      `the shape is ${reclassified.classification}${reclassified.reason === null ? '' : ` (${reclassified.reason})`}, not ${probe.result}`);
  }
  return { ok: true, accepted: { probe, shape, kind: expected.kind, method: expected.method, origin, headerNames } };
};

/**
 * 保つ鍵の名前（T41a。下書きの明示の一覧。省けば、UPDATE は目印の付いた欄の鍵のうち変える鍵でないものすべて（既定は保つ。Task 31 の判断 3 と同じく、
 * メールと電話も保つ）、登録は空）。
 */
const keptKeyNamesOf = (draft: ScenarioDraftInput, api: ScenarioApiDraft, accepted: AcceptedApiCandidate): readonly string[] => {
  if (api.keptKeys !== undefined) {
    return api.keptKeys;
  }
  return accepted.kind === 'UPDATE'
    ? submissionProbeKeyFieldsOf(accepted.probe).filter(({ key, field }) => field !== null && !draft.fieldNames.includes(key)).map(({ key }) => key)
    : [];
};

/**
 * ページが決める鍵の、更新の画面の欄としての識別（T41a。ユーザーの判断 2）: probe が選んだ欄（目印のない欄）のうち、名前が鍵と同じ欄がちょうど 1 つの
 * ときの、その欄の識別（`scenarioApiFieldIdentityOf`）。ほかは null（どの欄の値と照らすか決められない）。
 */
const pageKeyFieldOf = (probe: SubmissionProbeRecord, key: string): ScenarioApiFieldIdentity | null => {
  const fields = (probe.inputFields ?? []).filter(({ marker, name }) => marker === null && name === key);
  const [only] = fields;
  return fields.length === 1 && only !== undefined ? scenarioApiFieldIdentityOf(only) : null;
};

/**
 * T41e-2（Task 41 の設計書 3.3。発見事項 1 の設計者の判断）: その型から API のシナリオを作れない理由（候補の一覧の入口で示す。作れるなら null）。更新の型の、
 * 欄に対応しないページが決める鍵のうち、更新の画面の欄として識別できない鍵（`pageKeyFieldOf` が null）があれば、その鍵を許すと
 * `SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE`、外すと `SCENARIO_API_KEY_NOT_ALLOWED` で、どう選んでも保存できない。判定は下書きの確かめ
 * （`apiKeyErrorsOf`）と同じ部品。
 */
export const apiScenarioShapeRejectionOf = (probe: SubmissionProbeRecord): 'SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE' | null =>
  (submissionProbeWriteOf(probe.result)?.kind === 'UPDATE'
    && submissionProbeKeyFieldsOf(probe).some(({ key, field }) => field === null && pageKeyFieldOf(probe, key) === null)
    ? 'SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE'
    : null);

/** 送る鍵と欄の対応の誤り、ページが決める鍵の誤り、filter の名前の誤り（ファイルの説明の順）。 */
const apiKeyErrorsOf = (draft: ScenarioDraftInput, api: ScenarioApiDraft, accepted: AcceptedApiCandidate): readonly ScenarioDraftError[] => {
  const keyFields = submissionProbeKeyFieldsOf(accepted.probe);
  const sent = new Set(draft.fieldNames);
  const identities = keyFields.map(({ field }) => (field === null ? null : scenarioApiFieldIdentityOf(field)));
  const identityCounts = new Map<string, number>();
  for (const identity of identities) {
    if (identity !== null) {
      identityCounts.set(fieldIdentityKeyOf(identity), (identityCounts.get(fieldIdentityKeyOf(identity)) ?? 0) + 1);
    }
  }
  const errors: ScenarioDraftError[] = [];
  const mismatch = (key: string, detail: string): ScenarioDraftError =>
    errorOf('SCENARIO_API_FIELD_KEY_MISMATCH', `the key ${JSON.stringify(key)} ${detail}`, { fieldName: key });
  for (const fieldName of draft.fieldNames) {
    const index = keyFields.findIndex(({ key }) => key === fieldName);
    const keyField = keyFields[index];
    const identity = identities[index] ?? null;
    if (keyField === undefined || keyField.field === null || identity === null) {
      errors.push(mismatch(fieldName, 'to send is not a key of the request with exactly one input field'));
    } else if ((identityCounts.get(fieldIdentityKeyOf(identity)) ?? 0) > 1) {
      errors.push(mismatch(fieldName, 'shares its input field with another key'));
    } else if (!isScenarioApiFieldJsonTypePair(keyField.field.type, keyField.type)) {
      errors.push(errorOf('SCENARIO_API_FIELD_TYPE_MISMATCH',
        `the key ${JSON.stringify(fieldName)} is a JSON ${keyField.type} from a ${keyField.field.type} field`, { fieldName }));
    }
  }
  const update = accepted.kind === 'UPDATE';
  const kept = keptKeyNamesOf(draft, api, accepted);
  if (!update && kept.length > 0) {
    errors.push(mismatch(kept[0] ?? '', 'is kept, but a CREATE sends every key with an input field'));
  }
  // T41a: UPDATE の保つ鍵（明示の一覧か既定）。変える鍵と重ならない、欄にちょうど 1 つ対応する、秘密に見える名前でない（値を読めない）。
  for (const keptKey of update ? kept : []) {
    const index = keyFields.findIndex(({ key }) => key === keptKey);
    const identity = identities[index] ?? null;
    if (sent.has(keptKey)) {
      errors.push(errorOf('SCENARIO_UPDATE_FIELD_ROLE_OVERLAP', `the key ${JSON.stringify(keptKey)} is both changed and kept`, { fieldName: keptKey }));
    } else if (identity === null) {
      errors.push(mismatch(keptKey, 'to keep is not a key of the request with exactly one input field'));
    } else if ((identityCounts.get(fieldIdentityKeyOf(identity)) ?? 0) > 1) {
      errors.push(mismatch(keptKey, 'shares its input field with another key'));
    } else if (isApiWriteKeyNameSecretLike(keptKey)) {
      errors.push(errorOf('SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD',
        `the kept key ${JSON.stringify(keptKey)} looks like a secret, and its value cannot be read for an update`, { fieldName: keptKey }));
    }
  }
  const keptSet = new Set(update ? kept : []);
  keyFields.forEach(({ key, field }) => {
    if (field !== null && !sent.has(key) && !keptSet.has(key)) {
      errors.push(update
        ? errorOf('SCENARIO_UPDATE_FIELD_ROLE_MISSING', `the key ${JSON.stringify(key)} has an input field but is neither changed nor kept`, { fieldName: key })
        : mismatch(key, 'has an input field but is not sent'));
    }
  });
  if (update && draft.fieldNames.length === 0) {
    errors.push(errorOf('SCENARIO_UPDATE_NO_CHANGED_FIELD', 'an UPDATE changes at least one key'));
  }
  const pageKeys = new Set(api.pageKeys);
  for (const { key, field } of keyFields) {
    if (field === null && !sent.has(key) && !pageKeys.has(key)) {
      errors.push(errorOf('SCENARIO_API_KEY_NOT_ALLOWED', `the key ${JSON.stringify(key)} has no input field and is not a key decided by the page`));
    }
  }
  for (const pageKey of api.pageKeys) {
    const keyField = keyFields.find(({ key }) => key === pageKey);
    if (keyField === undefined || keyField.field !== null || sent.has(pageKey)) {
      errors.push(errorOf('SCENARIO_API_KEY_NOT_ALLOWED', `the page key ${JSON.stringify(pageKey)} is not a key of the request without an input field`));
    } else if (isApiWriteKeyNameSecretLike(pageKey)) {
      // T38R-fix の I-2: 秘密に見える名前は、部分一致の fail-closed の方針（`src/core/secret-query-names.ts` の方針 6）で拒む。
      errors.push(errorOf('SCENARIO_API_PAGE_KEY_SECRET_LIKE', `the page key ${JSON.stringify(pageKey)} looks like a secret`));
    } else if (!(API_SCALAR_JSON_TYPES as readonly string[]).includes(keyField.type)) {
      // T38R-fix の I-2: ページが決める鍵は scalar の値だけ（object・array の中の値は照らせない）。
      errors.push(errorOf('SCENARIO_API_PAGE_KEY_NOT_SCALAR', `the page key ${JSON.stringify(pageKey)} is a JSON ${keyField.type}, not a scalar`));
    } else if (update && pageKeyFieldOf(accepted.probe, pageKey) === null) {
      // T41a（ユーザーの判断 2）: 更新では、前の値と照らせる鍵（更新の画面の欄として識別できる鍵）だけを受ける。
      errors.push(errorOf('SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE',
        `the page key ${JSON.stringify(pageKey)} of an UPDATE is not identified as a field of the update page`));
    }
  }
  // T38R-fix の I-2: 登録の ID を読む応答の鍵も、秘密に見える名前を拒む（値を照らさない鍵に秘密を運ばせない）。
  if (api.recordId !== null && isApiWriteKeyNameSecretLike(api.recordId.key)) {
    errors.push(errorOf('SCENARIO_API_RECORD_ID_KEY_SECRET_LIKE', `the record id key ${JSON.stringify(api.recordId.key)} looks like a secret`));
  }
  const [filter] = accepted.shape.filters;
  const expectedFilter = accepted.kind === 'UPDATE' ? filter?.name ?? null : null;
  if (api.filterName !== expectedFilter) {
    errors.push(errorOf('SCENARIO_API_FILTER_MISMATCH', 'the filter name is not the filter of the request (an UPDATE has exactly one, a CREATE has none)'));
  }
  return errors;
};

/** API の UPDATE の台帳の参照の誤り（FORM の UPDATE と同じ理由）。 */
const apiLedgerErrorsOf = (
  draft: ScenarioDraftInput,
  api: ScenarioApiDraft,
  accepted: AcceptedApiCandidate,
  candidate: DiscoveryCandidate,
  context: ScenarioDraftContext,
): readonly ScenarioDraftError[] => {
  const { kind } = accepted;
  const errors: ScenarioDraftError[] = [];
  if (draft.update !== undefined && draft.update !== null) {
    errors.push(errorOf('SCENARIO_UPDATE_SPEC_NOT_ALLOWED', '/update an API scenario has no UPDATE spec of a form (it has /api/ledger)'));
  }
  const { ledger } = api;
  if (kind === 'CREATE') {
    return ledger === null ? errors : [...errors, errorOf('SCENARIO_UPDATE_SPEC_NOT_ALLOWED', '/api/ledger a CREATE scenario has no ledger')];
  }
  if (ledger === null) {
    return [...errors, errorOf('SCENARIO_UPDATE_SPEC_MISSING', '/api/ledger an UPDATE scenario needs the ledger')];
  }
  const fact = context.scenarios.find(({ scenarioId, profileId }) => scenarioId === ledger.targetCreateScenarioId && profileId === draft.profileId);
  const ledgerErrorCount = errors.length;
  if (fact === undefined) {
    errors.push(errorOf('SCENARIO_UPDATE_TARGET_NOT_FOUND', '/api/ledger/targetCreateScenarioId is not a scenario of the profile'));
  } else if (fact.kind !== 'CREATE' || fact.scenarioId === context.scenarioId) {
    errors.push(errorOf('SCENARIO_UPDATE_TARGET_NOT_CREATE', '/api/ledger/targetCreateScenarioId is not another CREATE scenario'));
  }
  // 更新の画面の path の型に、候補の画面の同じ位置の区切りの値を入れて、候補の画面の path に戻る（型の owner の部品）。
  const pair = recordIdSegmentPairOfTemplates(ledger.formPathTemplate, ledger.formPathTemplate);
  const recordId = pair === null ? undefined : candidate.page.path.split(PATH_SEPARATOR)[pair.pageSegment];
  if (recordId === undefined || concretePathOfTemplate(ledger.formPathTemplate, recordId) !== candidate.page.path) {
    errors.push(errorOf('SCENARIO_UPDATE_PATH_MISMATCH', '/api/ledger/formPathTemplate does not give back the page path of the candidate'));
  } else if (pair?.pageSegment !== lastRecordIdLikePathSegmentIndexOf(candidate.page.path) || pagePathTemplatedIdentityDigestOf(candidate) === null) {
    // T41a: 型の `{id}` は、画面の path の最後の ID の区切り（probe の分類が filter の値と比べる ID。型にした識別の digest もこの区切りで求める）。
    errors.push(errorOf('SCENARIO_UPDATE_PATH_MISMATCH', '/api/ledger/formPathTemplate the {id} is not the last record id segment of the page path'));
  } else if (usableRecordIdOf(recordId) === null) {
    errors.push(errorOf('SCENARIO_UPDATE_RECORD_ID_UNSAFE', '/api/ledger the record id segment of the page path is not of the record id form'));
  }
  // T41a: 台帳の ID の取り方と filter の名前・画面の path の型の結び付き（台帳の参照と path の型のほかの誤りがないときだけ）。
  const rejection = fact === undefined || errors.length > ledgerErrorCount
    ? null
    : apiUpdateLedgerBindingRejectionOf({
      filterName: api.filterName, formPathTemplate: ledger.formPathTemplate, origin: accepted.origin, pathShape: accepted.shape.pathShape,
    }, fact);
  if (rejection !== null) {
    errors.push(errorOf(rejection, '/api/ledger the record id of the ledger scenario is not bound to the filter of the update'));
  }
  return errors;
};

/**
 * API の UPDATE の、台帳の登録の ID の取り方への結び付きの拒否の理由（T41a。Task 41 の設計書 3.1 の「台帳の ID と filter の結び付け」。純粋。下書きの確かめと、
 * 発行の確かめ直し（T41b）が共用する唯一の判定。結び付けば null）。
 * - 台帳が API の登録で、ID を応答の本文の鍵から取る（`apiRecordId`。ワーカーはこの取り方を先に使う）: その鍵の名前が filter の名前と同じ →
 *   null、違う → `SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID`。
 * - ほか（URL の型・画面の要素から ID を取る台帳）: form の UPDATE と同じ部品（`isUpdatePathBoundToLedger`）に、更新の画面の path の型と、API の
 *   決まり（T41b。設計者の判断 (1): `{id}` の位置と前の区切りが同じ。後ろは違ってよい。要素の台帳は `{id}` の後ろに ID の区切りがない）を渡す。外れる →
 *   `SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID`。取り方が未指定なら確かめない。
 * - T41R-fix-B（Task 41 の設計書 8 章の「T41R の完全版」の I-1）: 上の 2 つの前に、台帳が同じ表の API の登録であることを求める。台帳の事実に API の要求の
 *   送り先（`apiRequest`）がない（form の登録、事実が分からない）、Origin が違う（比べ方は URL の意味の owner の `isOriginInAllowedOrigins`。GATE-ARCH04）、
 *   path の型が違う → `SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID`（台帳の ID が、更新の filter が選ぶ行に結び付かない。理由は使い回す）。
 */
export const apiUpdateLedgerBindingRejectionOf = (
  update: {
    readonly filterName: string | null;
    readonly formPathTemplate: string;
    /** 更新の API の要求の Origin の文字列と path の型（シナリオの `api.request`）。 */
    readonly origin: string;
    readonly pathShape: string;
  },
  ledger: Pick<ScenarioKindFact, 'recordId' | 'apiRecordId' | 'apiRequest'>,
): 'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID' | 'SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID' | null => {
  const ledgerRequest = ledger.apiRequest ?? null;
  if (ledgerRequest === null || ledgerRequest.pathShape !== update.pathShape || !isOriginInAllowedOrigins([ledgerRequest.origin], update.origin)) {
    return 'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID';
  }
  const apiRecordId = ledger.apiRecordId ?? null;
  if (apiRecordId !== null) {
    return apiRecordId.key === update.filterName ? null : 'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID';
  }
  return isUpdatePathBoundToLedger(update.formPathTemplate, ledger.recordId ?? null, API_PAGE_LEDGER_BINDING)
    ? null
    : 'SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID';
};

/**
 * 発見のジョブのプロファイルの改訂の誤り（T38c。T38b の報告の (2)）: 型の Origin は probe の時の承認したサービスの Origin の一覧の番号なので、候補を
 * 見つけた発見のジョブの改訂が今の改訂と同じであること。文脈にない・分からない・違うなら拒む（fail-closed。発見のやり直しが要る）。
 */
const apiProfileRevisionErrorsOf = (context: ScenarioDraftContext): readonly ScenarioDraftError[] => {
  const revisions = context.profileRevisions;
  return revisions !== undefined && revisions.discoveryJob !== null && revisions.discoveryJob === revisions.current
    ? []
    : [errorOf('SCENARIO_API_DISCOVERY_PROFILE_STALE', 'the discovery job that found the candidate was run with another revision of the profile')];
};

/** 送る鍵の名前の誤り（FORM の送る欄と同じ、秘密に見える名前と危険な語）。 */
const apiFieldNameErrorsOf = (draft: ScenarioDraftInput): readonly ScenarioDraftError[] => draft.fieldNames.flatMap((fieldName) => {
  const label = JSON.stringify(fieldName);
  if (isSecretUrlQueryParameterName(fieldName)) {
    return [errorOf('SCENARIO_FIELD_SECRET_LIKE', `the key ${label} looks like a secret and is never sent`, { fieldName })];
  }
  return fieldNameHasDestructiveWord(fieldName)
    ? [errorOf('SCENARIO_FIELD_DANGEROUS_WORD', `the key ${label} has a dangerous word and is never sent`, { fieldName })]
    : [];
});

/** 受けた API の指定（型から作る。値を持たない）。 */
const apiSpecOf = (draft: ScenarioDraftInput, api: ScenarioApiDraft, accepted: AcceptedApiCandidate, candidate: DiscoveryCandidate): ScenarioApiSpec => {
  const keyFields = submissionProbeKeyFieldsOf(accepted.probe);
  const keyFieldsNamed = (names: readonly string[]): ScenarioApiKeyField[] => keyFields.flatMap(({ key, type, field }) => {
    const identity = field === null ? null : scenarioApiFieldIdentityOf(field);
    return names.includes(key) && field !== null && identity !== null ? [{ key, type, field: identity, fieldType: field.type }] : [];
  });
  const sentKeyFields = keyFieldsNamed(draft.fieldNames);
  const { shape } = accepted;
  // T41a: UPDATE は、保つ鍵と、ページが決める鍵の欄の識別と、画面の path を型にした識別の digest を持つ（登録は持たない）。
  const update = accepted.kind === 'UPDATE';
  const templatedIdentityDigest = update ? pagePathTemplatedIdentityDigestOf(candidate) : null;
  const updateItems = update ? {
    keptKeys: keyFieldsNamed(keptKeyNamesOf(draft, api, accepted)).sort((left, right) => compareCodeUnits(left.key, right.key)),
    ...(templatedIdentityDigest === null ? {} : { templatedIdentityDigest }),
  } : {};
  const pageKeyOf = (key: string, type: ApiJsonValueType): ScenarioApiPageKey => {
    const field = update ? pageKeyFieldOf(accepted.probe, key) : null;
    return field === null ? { key, type } : { key, type, field };
  };
  return {
    ...updateItems,
    shapeDigest: api.shapeDigest,
    request: {
      method: accepted.method,
      origin: accepted.origin,
      pathShape: shape.pathShape,
      queryNames: [...new Set(shape.queryNames.filter((name): name is (typeof API_SELECTION_QUERY_NAMES)[number] =>
        (API_SELECTION_QUERY_NAMES as readonly string[]).includes(name)))].sort(compareCodeUnits),
      contentType: shape.contentType,
      prefer: [...shape.prefer].sort(compareCodeUnits),
    },
    keyFields: sentKeyFields.sort((left, right) => compareCodeUnits(left.key, right.key)),
    pageKeys: keyFields.filter(({ key }) => api.pageKeys.includes(key)).map(({ key, type }) => pageKeyOf(key, type))
      .sort((left, right) => compareCodeUnits(left.key, right.key)),
    headerNames: accepted.headerNames,
    filterName: api.filterName,
    recordId: api.recordId === null ? null : { source: api.recordId.source, key: api.recordId.key },
    ledger: api.ledger === null ? null : { targetCreateScenarioId: api.ledger.targetCreateScenarioId, formPathTemplate: api.ledger.formPathTemplate },
  };
};

/** API のシナリオの下書きの確かめ（`validateScenarioDraft` の送り方 `API` の分岐）。 */
const validateApiScenarioDraft = (
  draft: ScenarioDraftInput,
  api: ScenarioApiDraft,
  candidate: DiscoveryCandidate | null,
  readChecks: readonly ScenarioReadCheckDefinitionFact[],
  context: ScenarioDraftContext,
): ScenarioDraftValidationResult => {
  const candidateResult = apiCandidateOf(draft, api, candidate, context);
  const errors: ScenarioDraftError[] = [
    ...(candidateResult.ok ? [] : [candidateResult.error]),
    ...apiProfileRevisionErrorsOf(context),
    ...apiFieldNameErrorsOf(draft),
  ];
  if (candidateResult.ok && candidate !== null) {
    errors.push(
      ...apiKeyErrorsOf(draft, api, candidateResult.accepted),
      ...apiLedgerErrorsOf(draft, api, candidateResult.accepted, candidate, context),
    );
  }
  errors.push(...readCheckErrorsOf(draft, readChecks), ...verificationErrorsOf(draft, readChecks), ...limitErrorsOf(draft));
  if (errors.length > 0 || !candidateResult.ok || candidate === null) {
    return rejected(errors);
  }
  const { accepted } = candidateResult;
  return Object.freeze({
    ok: true,
    content: deepFreeze({
      ...contentOf(draft, candidate, accepted.kind, null),
      transport: API_SCENARIO_TRANSPORT,
      api: apiSpecOf(draft, api, accepted, candidate),
      update: null,
    }),
  });
};

/** 受けた下書きと候補から、シナリオの中身を作る（凍結）。 */
const contentOf = (draft: ScenarioDraftInput, candidate: DiscoveryCandidate, kind: ScenarioKind, request: ScenarioRequestShape | null): ScenarioContent =>
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
  // T38b: 送り方 `API` の下書きは、API の候補の確かめ（形の確かめで `api` があることを確かめ済み）。
  if (draft.transport === API_SCENARIO_TRANSPORT && draft.api !== undefined) {
    return validateApiScenarioDraft(draft, draft.api, candidate, readChecks, context);
  }
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

/**
 * 送り方ごとの、検証の指定で求める項目（T40a-fix。閉じた一覧の順）: FORM（送り方の項目なしを含む）はすべて（`SCENARIO_VERIFICATION_ITEMS`）、API は
 * 照合の READ と ID の取り方だけ（`API_SCENARIO_VERIFICATION_ITEMS`）。画面の検証の指定の表示もこの一覧に従う。
 */
export const requiredVerificationItemsOf = (scenario: Pick<ScenarioContent, 'transport' | 'api'>): readonly ScenarioVerificationItem[] => {
  if (scenarioTransportOf(scenario) !== API_SCENARIO_TRANSPORT) {
    return SCENARIO_VERIFICATION_ITEMS;
  }
  // T41e-2（T41b の申し送り）: API の更新（台帳の参照を持つ）の登録の ID は対象の ID なので、ID の取り方を求めない（不足の判定と同じ一覧）。
  return (scenario.api?.ledger ?? null) === null ? API_SCENARIO_VERIFICATION_ITEMS : API_UPDATE_SCENARIO_VERIFICATION_ITEMS;
};

/**
 * 検証の指定の未指定の項目（T30a。閉じた一覧の順。凍結）。空でなければ、実行の許可を出さない（`VERIFICATION_SPEC_MISSING`）。許可の発行、詳細の画面、
 * 開始の画面、開始の口が使う唯一の判定。
 * T40a-fix: 送り方と API の指定（`scenario`）を見て、求める項目を決める（`requiredVerificationItemsOf`）。API のシナリオの `recordId` は、API の指定の
 * `recordId`（応答の本文の鍵）か検証の指定の `recordId` のどちらかがあれば足りる。`scenario` を省けば FORM のシナリオとして判定する（求める項目が
 * 多い側。fail-closed）。
 * T41b（Task 41 の設計書 3.4 の 3）: API の更新（台帳の参照 `api.ledger` を持つ）の登録の ID は対象の ID（許可が台帳から選ぶ）なので、ID の取り方は求めない。
 */
export const missingVerificationItemsOf = (
  verification: ScenarioVerification,
  scenario: Pick<ScenarioContent, 'transport' | 'api'> = {},
): readonly ScenarioVerificationItem[] => {
  const api = scenarioTransportOf(scenario) === API_SCENARIO_TRANSPORT;
  // T41e-2: API の更新は、求める一覧（`requiredVerificationItemsOf`）に ID の取り方が入らない。
  return Object.freeze(requiredVerificationItemsOf(scenario).filter((item) => (api && item === 'recordId'
    ? verification.recordId === null && (scenario.api?.recordId ?? null) === null
    : verification[item] === null)));
};

/** スキーマで形を確かめた凍結した写し。通らなければ `RangeError`（呼び出し側の誤り）。手順は `schema-checked-copy.ts`（CCX-17。CC-077）。 */
const storableCopyOf = <T>(schemaName: 'scenario' | 'approval-receipt', subject: string, value: T): T =>
  requireSchemaCheckedCopy<T>(schemaName, subject, value);

/** 保存の前の確かめ直し（シナリオの版 1 つ）。凍結した写しを返す。 */
export const assertStorableScenarioRevision = (revision: ScenarioRevision): ScenarioRevision =>
  storableCopyOf('scenario', 'scenario revision', revision);

/**
 * 保存した版の文書を読む（T30a）。`assertStorableScenarioRevision` と同じく、スキーマで形を確かめた凍結した写しを返す（通らなければ `RangeError`）。
 * LG-3: 前の形（`verification`・`update` の項目がない、form の UPDATE で `update` が null、T41a の契約のない API の更新）を読み替えない。
 */
export const storedScenarioRevisionOf = (document: unknown): ScenarioRevision =>
  storableCopyOf('scenario', 'stored scenario revision', document as ScenarioRevision);

/** 保存の前の確かめ直し（承認か撤回の記録 1 件）。凍結した写しを返す。 */
export const assertStorableApprovalReceipt = <T extends ApprovalReceiptRecord>(receipt: T): T =>
  storableCopyOf('approval-receipt', 'approval receipt', receipt);

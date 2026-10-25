/**
 * 書き込みのフォームへの入力の部品（T30c。Task 30 の設計書 `2026-10-13-beaksight-task-30-approved-create-design.md` 3 章の「フォームの入力」、
 * 5 章の SSOT）。ページの入力の欄に値を入れる操作（`fill`、`selectOption`、`check`、`uncheck`、`click` による送信）を使ってよいのは、`src/` の中で
 * ログインの入力の部品（`login-form-submitter.ts`）と、このファイルだけ（`tests/architecture/worker-login-hooks.test.ts` の (q)）。公開の口を
 * 呼べるのは、ワーカーの書き込みの流れ（`src/worker/write-create-run.ts`）だけ（`tests/architecture/write-stage-boundary.test.ts` の (d)）。
 *
 * 1. `inspectWriteForm`（送る前の確かめ。値を受けない）: main frame の form を、isolated world で読む（Task 27 の部品 `readInIsolatedWorld`。
 *    ページの JS が標準の getter を書き換えても、読み取りを偽れない。DOM clobbering を受けないように、関数の本体は標準の prototype の getter で
 *    読む）。承認した候補の欄（名前と型）と送る欄の名前から、送る form と送信ボタンを決め、次の順に確かめて、最初に外れた理由
 *    （`WRITE_FORM_REASONS`）を返す。
 *    - 送る欄の名前をすべて持つ（form の要素か、form の中の要素として）form がちょうど 1 つ（0 なら `FORM_NOT_FOUND`、2 以上なら `FORM_AMBIGUOUS`）。
 *    - form の中に、別の form に結び付いた（`form` 属性）候補の名前の欄がない（`FIELD_OWNED_BY_OTHER_FORM`）。form の外から `form` 属性でこの form に
 *      結び付いた欄は、ブラウザが送るので、この form の欄として扱う。
 *    - form の欄（`form.elements` の入力の欄。送信ボタンなどを除く）の名前の一覧が、候補の欄と同じ（`FORM_FIELDS_CHANGED`）。名前と型の組も同じ
 *      （`FIELD_TYPE_MISMATCH`）。
 *    - 送信ボタン（`button[type=submit]`、`input[type=submit|image]`）のうち、次をすべて満たすものがちょうど 1 つ（ない・満たすものがないなら
 *      `SUBMITTER_NOT_FOUND` かその理由、2 つ以上なら `SUBMITTER_AMBIGUOUS`）: method（`formmethod` を含む）が POST、action（`formaction` を含む）を
 *      解決した URL が承認の送信先（要求の判定の owner の `isWriteEndpointUrl`。Guard と同じ比べ方）、enctype（`formenctype` を含む）が
 *      urlencoded か multipart（`ENCTYPE_NOT_ALLOWED`）で承認と同じ（`ENCTYPE_MISMATCH`）、送信の先（`formtarget`・`target`・`<base target>`）が
 *      同じ page（`FORM_TARGET_NOT_SELF`）、`accept-charset` がないか UTF-8 だけ（`ACCEPT_CHARSET_NOT_UTF8`）。
 *    値は、送る欄（hidden・password・file でない型）の値と選択の状態だけを読む（hidden の値、CSRF のトークン、readonly の値は読まない。値を照らす
 *    欄は 5 と 6 の読み取りで読む）。結果に返すのは、照合に渡す名前の一覧（`writeFormFieldListsOf`）だけ。
 *    T30f fix round 1（DEF-098）: 送る欄に選ばなかった「見えていて編集できる欄」も、照合の期待に入れる（`unsubmittedFieldRoleOf` が唯一の判定）。
 *    text 系（値が 1 つの欄。password と textarea を含む）は送る欄に値 `""` で入れる（ブラウザが空の値で送る。この部品は値を入れない）。checkbox・
 *    radio（組でない）は送らないことを期待する欄（`absentFieldNames`）。同じ名前の hidden と checkbox の組（`checkboxHiddenPairsOf`）で checkbox を
 *    選ばなかったものは、hidden の名前を名前だけの一覧に入れ、checkbox はチェックしない（本文に名前が 1 回だけ出る）。disabled の欄はブラウザが
 *    送らないので、どの一覧にも入れない。select・select-multiple・range・color は既定の値が分からないので、選ばなければ送らない（`SPEC_INVALID`）。
 *    一覧の名前が重なる指定も `SPEC_INVALID`（照合の期待を作れない）。照合の期待そのもの（`WritePayloadExpectation` の欄の部分）は
 *    `writePayloadFieldsOf` が作る。
 * 2. `fillWriteForm`: 書き込みの段の送信の窓を開き（`WriteStageMonitor.openSubmissionWindow`。値を入れ始める前。窓の中で、Guard は承認の POST の
 *    ほかの要求を止める）、確かめ直して（form と欄の位置が確かめの時と同じ。違えば `FORM_CHANGED`）、Playwright で入れる: text 系と textarea は
 *    `fill`、select は `selectOption`（値で）、checkbox は生成した値の欄だけ `check` して残りを `uncheck`（値が null なら全部 `uncheck`）、radio は
 *    生成した値の欄を `check`（null なら、どれも選ばれていないことを求める）。file の欄は触らない（空のまま）。入れた後に、もう一度確かめ、値が
 *    生成した値のとおりか読み直す（`VALUE_NOT_APPLIED`）。
 *    T40R-fix-A: このとき開くのは窓の観察の段（承認の形の POST も Guard が通さずに止めて数える）。
 * 3. `submitWriteForm`: 押す直前にもう一度確かめ、値を読み直してから、T40R-fix-A から、値を入れたときの部品で送信の窓の送信の段を開いて
 *    （`WriteStageMonitor.openSubmissionPhase`。開けなければ押さずに `FORM_CHANGED`）、決めた送信ボタンを Playwright の `click` で押す（押した後の
 *    ナビゲーションは待たない）。押した後の失敗は `SUBMIT_FAILED`（`clickAttempted: true`。送信が分からない）。
 * 4. T31g-1（Task 31 の設計書 3 章の「更新の前の読み取り」「欄の役割」「値の照らし方」「削除にあたる変更の遮断」「同じ名前の hidden と checkbox
 *    の組」。UPDATE の口。`WriteUpdateFormSpec` は、変える欄と保つ欄の名前を持つ）:
 *    - `readUpdateFormValues`（前の値と後の値の読み取り。ワーカーが凍結した Context で、更新の前と後に使う）: 1 の確かめと同じ読み取りの部品
 *      （isolated world、prototype の getter）で form を決め、変える欄と保つ欄の今の値（text 系・textarea は値、select は選んだ値、checkbox・
 *      radio はチェックした欄の値。どれもなければ null）、状態の名前の hidden の欄（`fieldNameHasStateWord`。秘密に見える名前は読まない）の値、
 *      組の hidden の値を返す。**読むのはこれらだけ**（CSRF・`lock_version` などのほかの hidden、readonly の値、役割のない欄の値は読まない）。
 *      読んだ値は返すだけで、記録しない。組の hidden と checkbox が DOM（`form.elements` の欄の順）で隣り合わなければ
 *      `CHECKBOX_PAIR_NOT_ADJACENT`（照合は順だけを見るので、ここで確かめる）。同じ名前の checkbox・radio で 2 つ以上チェックした欄、2 つ以上
 *      選んだ select は `VALUE_NOT_SUPPORTED`（照合の期待を作れない）。
 *    - `updatePayloadFieldsOf`（照合の期待の作り手。純粋。CREATE の `writePayloadFieldsOf` と同じく、役割のない欄の扱いは
 *      `unsubmittedFieldRoleOf`）: 変える欄は送る欄に新しい値、保つ見える欄は送る欄に前の値（前の値が null の checkbox・radio・select は
 *      `absentFieldNames`）、状態の名前の hidden は `checkedPassthroughFields` に前の値、組は `checkboxPairs`（`offValue` は hidden の前の値、
 *      `checkedValue` は送るときにチェックするなら checkbox の値）、ほかの hidden・readonly・見えない欄は名前だけ、file は空、`_method` は
 *      `methodOverride`。見えていて編集できる欄は、すべて変える欄か保つ欄（漏れ・重なりは `SPEC_INVALID`）。変える欄に状態の欄（T31R-fix-1 の
 *      I-1: 削除の語に当たる名前の欄も）、秘密に見える
 *      名前の見える欄、期待を作れない欄（同じ名前の hidden と text など）、6 つの一覧の名前の重なりも `SPEC_INVALID`。T31g-1 fix round 1:
 *      状態の語に当たり、秘密に見える名前でもある欄（hidden・見えない欄・readonly。`state` など）があれば `SECRET_LIKE_STATE_FIELD`（秘密に
 *      見える名前の値は読まないので照らせず、名前だけを照らすと、ページの JS が値を変えても止まらない。その画面の UPDATE は実行しない。
 *      `readUpdateFormValues`・`inspectUpdateForm` も同じ理由で止める）。
 *    - `inspectUpdateForm`（入力の前の確かめ）: 1 の確かめに加えて、書き込みの段の画面の値（変える欄・保つ欄・状態の hidden・組の hidden）が
 *      前の値と同じか（完全な一致。改行だけ CR LF・CR・LF を同じと見なす）を確かめる（違えば `PRIOR_VALUE_CHANGED`。送らない）。入力
 *      （`fillWriteForm`）は変える欄だけに値を入れ、保つ欄には触らない。入れる前・入れた後・押す直前（`submitWriteForm`）にも、変える欄でない
 *      値が前の値のままかを確かめる（`PRIOR_VALUE_CHANGED`）。照合の期待は `updatePayloadFieldsOf` で作る（`inspectUpdateForm` の結果の名前の
 *      一覧は、照合に使わない）。
 * 5. T31R-fix-1（C-1。DEF-108。ユーザーの判断「更新と登録の両方で値も照らす」）: 送る欄でない hidden・readonly・見えない欄のうち、秘密に見える
 *    名前（`isSecretUrlQueryParameterName`。CSRF のトークンなど）でない、値が 1 つの欄（text 系・textarea・hidden。disabled・password・file・
 *    checkbox・radio・select を除く）は、名前だけでなく値も照らす（照合の期待の `checkedPassthroughFields`。`unsubmittedFieldRoleOf` の `CHECKED_PASSTHROUGH` が唯一の
 *    判定）。値は送る前の読み取りで読む（登録は画面の確かめの `readWritePassthroughValues`、更新は前の読み取りの `readUpdateFormValues` の
 *    `passthroughValues`）。読んだ値は返すだけで記録しない。名前だけを照らすのは、秘密に見える名前の欄と、値を読めない形の欄だけ。値を照らす欄が
 *    同じ名前で 2 つ以上あれば、期待を作れない（`SPEC_INVALID`）。更新の後の照合は、この欄（`lock_version` など、更新で変わってよい値）を比べない
 *    （ワーカーの証拠は、状態の名前の欄だけを比べる）。
 * 6. T31R2-fix-1（C-1。DEF-108 の残り）: 送る欄でない欄の扱い（`unsubmittedFieldRoleOf` が唯一の判定。登録と更新で共用）を次にした。
 *    - disabled の欄（型を問わない）は「送られない」（`absentFieldNames`。ページの JS が有効にして値を入れれば照合が止める）。同じ名前のほかの欄と
 *      重なれば、期待を作れない（`SPEC_INVALID`）。
 *    - hidden・readonly・見えない欄のうち、名前だけを照らすのは、ページが読み込みごとに作る値の閉じた一覧の名前（CSRF のトークンなど。
 *      `src/discovery/read-check-contracts.ts` の `isPageIssuedTokenFieldName`）だけ。ほかの秘密に見える名前（`isSecretUrlQueryParameterName`。
 *      `code`・`key`・`ticket` など）の欄がある画面は、値を読めず照らせないので、期待を作らず止める（`SECRET_LIKE_PASSTHROUGH_FIELD`）。
 *    - 見えない checkbox・radio・select（select-one）は、チェック・選択の状態と値を読み、チェック・選択があればその値を照らし
 *      （`checkedPassthroughFields`）、なければ「送られない」にする（`absentFieldNames`）。同じ名前で 2 つ以上チェックしていれば
 *      `VALUE_NOT_SUPPORTED`。見えない select-multiple と、hidden・readonly・見えない password は、期待を作れない（`SPEC_INVALID`）。
 * 要素は、isolated world で読んだ位置（文書の根からの要素の番号）の XPath で Playwright に渡す。最初の確かめで、form・送信ボタン・送る欄の要素を
 * Playwright の要素の参照で持ち、確かめ直しのたびに、同じ位置の要素が同じものか（`===`。ページの JS は偽れない）を比べる（同じ形の写しに
 * 差し替えた form も `FORM_CHANGED` で止める）。読んだ後に DOM が変わっても、入れた後と押す直前の確かめ直し（位置・要素・値）と、Guard の
 * 送る中身の照合（T30b）が止める。Playwright の誤りの文には値が入りうるので、誤りは捨てて理由の語だけを返す。
 * 例外を投げない。
 */
import type { Locator, Page } from 'playwright';
import { isRecord } from '../core/guards.js';
import { isSecretUrlQueryParameterName } from '../core/secret-query-names.js';
import { fieldNameHasRemovalWord, fieldNameHasStateWord } from '../discovery/classify.js';
import { backendNodeIdsAtPaths, readInIsolatedWorld, withSignaledElements } from '../discovery/isolated-read.js';
import { composeInPage, type StandardReaders } from './in-page-readers.js';
import {
  CANDIDATE_FIELD_TYPES,
  SELECT_FIELD_TYPES,
  checkboxHiddenPairsOf,
  isDefaultValueFieldType,
  isMethodOverrideFieldName,
  isUnsendableFieldType,
  UNSENDABLE_FIELD_TYPES,
  writeFieldsOfName,
  type CandidateField,
  type CandidateFieldType,
} from '../discovery/candidate-contracts.js';
import type { WriteStageMonitor } from '../safety/passive-request-guard.js';
import { isWriteEndpointUrl } from '../safety/request-policy.js';
import {
  WRITE_FORM_ENCTYPES,
  WRITE_METHOD_OVERRIDES,
  type WriteCheckboxPair,
  type WriteFormEnctype,
  type WriteMethodOverride,
  type WritePayloadExpectation,
  type WriteSubmittedField,
} from '../safety/write-payload-policy.js';
import { isPageIssuedTokenFieldName, isSecretLikeStateField, isUnreadableSecretField } from '../discovery/read-check-contracts.js';
import { elementPathSelectorOf } from './element-path-engine.js';
import { FORM_POST_METHOD, FORM_SELF_TARGETS, FORM_STEP_TIMEOUT_MS, lineFeedForm, sameValue } from './form-submission-common.js';

/** フォームを読む・値を入れる・送る、それぞれの時間の上限（ms。ログインの入力の部品と同じ値）。 */
export const WRITE_FORM_STEP_TIMEOUT_MS = FORM_STEP_TIMEOUT_MS;

/**
 * 止めた理由（閉じた一覧。確かめの理由、入力と送信の理由の順）。
 * - `SPEC_INVALID`: 指定が正しくない（送る欄が候補にない、送れない型（password・file・hidden）、readonly・disabled・見えない欄、名前の重複など）。
 * - `FORM_UNREADABLE`: 読めなかった（期限、読む間の移動、読み取りの上限、形の誤り）。
 * - `FORM_NOT_FOUND`・`FORM_AMBIGUOUS`・`FIELD_OWNED_BY_OTHER_FORM`・`FORM_FIELDS_CHANGED`・`FIELD_TYPE_MISMATCH`・`SUBMITTER_NOT_FOUND`・
 *   `SUBMITTER_AMBIGUOUS`・`METHOD_NOT_POST`・`ACTION_NOT_ALLOWED`・`ENCTYPE_NOT_ALLOWED`・`ENCTYPE_MISMATCH`・`FORM_TARGET_NOT_SELF`・
 *   `ACCEPT_CHARSET_NOT_UTF8`: 送る前の確かめ（ファイルの先頭の説明）。
 * - `FORM_CHANGED`: 入れる前・入れた後・押す直前の確かめ直しで、form・送信ボタン・欄の位置が、最初の確かめと違う（確かめが通らない場合を含む）。
 * - `VALUE_NOT_SUPPORTED`: 生成した値を、その欄に入れられない（値がない、text 系の欄に null、checkbox・radio の選択肢にない値、選ばれた radio を
 *   null にする）。
 * - `INPUT_FAILED`: Playwright の入力の操作が失敗した。
 * - `VALUE_NOT_APPLIED`: 入れた後（押す直前）に読み直した値が、生成した値と違う。
 * - `SUBMIT_FAILED`: 押す操作が失敗した（押したかは分からない）。
 * - `PRIOR_VALUE_CHANGED`（T31g-1。UPDATE）: 書き込みの段の画面の値（変える欄・保つ欄・状態の hidden・組の hidden）が前の値と違う、または
 *   入れた後・押す直前に、変える欄でない値が前の値と違う。
 * - `CHECKBOX_PAIR_NOT_ADJACENT`（T31g-1。UPDATE）: 同じ名前の hidden と checkbox の組が、form の欄の順で隣り合わない。
 * - `SECRET_LIKE_STATE_FIELD`（T31g-1 fix round 1。UPDATE）: 状態の語に当たり、秘密に見える名前でもある、値を送る欄（hidden・見えない欄・
 *   readonly）がある（値を読めないので照らせない。指定の誤りの一種）。
 * - `SECRET_LIKE_PASSTHROUGH_FIELD`（T31R2-fix-1。C-1。登録と更新）: ページが読み込みごとに作る値の名前（`isPageIssuedTokenFieldName`）でない、
 *   秘密に見える名前（`code`・`key`・`ticket` など）の、値を送る欄（hidden・見えない欄・readonly）がある（値を読めないので照らせない。指定の
 *   誤りの一種）。
 */
export const WRITE_FORM_REASONS = Object.freeze([
  'SPEC_INVALID',
  'FORM_UNREADABLE',
  'FORM_NOT_FOUND',
  'FORM_AMBIGUOUS',
  'FIELD_OWNED_BY_OTHER_FORM',
  'FORM_FIELDS_CHANGED',
  'FIELD_TYPE_MISMATCH',
  'SUBMITTER_NOT_FOUND',
  'SUBMITTER_AMBIGUOUS',
  'METHOD_NOT_POST',
  'ACTION_NOT_ALLOWED',
  'ENCTYPE_NOT_ALLOWED',
  'ENCTYPE_MISMATCH',
  'FORM_TARGET_NOT_SELF',
  'ACCEPT_CHARSET_NOT_UTF8',
  'FORM_CHANGED',
  'VALUE_NOT_SUPPORTED',
  'INPUT_FAILED',
  'VALUE_NOT_APPLIED',
  'SUBMIT_FAILED',
  'PRIOR_VALUE_CHANGED',
  'CHECKBOX_PAIR_NOT_ADJACENT',
  'SECRET_LIKE_STATE_FIELD',
  'SECRET_LIKE_PASSTHROUGH_FIELD',
] as const);
export type WriteFormReason = (typeof WRITE_FORM_REASONS)[number];

/** 承認した候補の欄 1 件（`CandidateField` の、確かめに使う項目）。 */
export type WriteFormFieldSpec = Pick<CandidateField, 'name' | 'type' | 'readonly' | 'hidden' | 'disabled'>;

/**
 * 送る form の指定（承認の要求の形と、承認した候補の欄と、送る欄の名前）。
 * - `endpoint`: 承認の送信先（Origin と path）。`enctype`: 承認の enctype。
 * - `candidateFields`: 承認した候補の欄（`DiscoveryCandidate.fields` の順）。
 * - `submittedFieldNames`: 生成した値を入れる欄の名前（重複なし）。
 * - `methodOverride`（T30b fix round 1）: 承認した候補の method の上書き（`DiscoveredCandidate.methodOverride`。書き込みで送れるのは `PUT`・`PATCH`。
 *   ないときは null）。
 */
export interface WriteFormSpec {
  readonly endpoint: { readonly origin: string; readonly path: string };
  readonly enctype: WriteFormEnctype;
  readonly candidateFields: readonly WriteFormFieldSpec[];
  readonly submittedFieldNames: readonly string[];
  readonly methodOverride: WriteMethodOverride | null;
}

/** 送る中身の照合（Guard の `WritePayloadExpectation`）に渡す、名前の一覧と、値を照らす欄の期待（承認した候補から求める）。 */
export interface WriteFormFieldLists {
  /**
   * 送る欄でない、hidden・readonly・見えない欄のうち、名前だけを照らす欄の名前（値は照合しない。method の上書きの欄 `_method` は含めない）。
   * T31R2-fix-1（C-1）: ページが読み込みごとに作る値の名前（`isPageIssuedTokenFieldName`）の欄だけ。
   */
  readonly passthroughFieldNames: readonly string[];
  /** file の欄の名前（空のときだけ送ってよい）。 */
  readonly emptyFileFieldNames: readonly string[];
  /** T30b fix round 1: 値を照らす欄（`_method`）の期待。承認した候補の method の上書き（ないときは null）。 */
  readonly methodOverride: WriteMethodOverride | null;
  /** DEF-098: 送る欄に選ばなかった、見えていて編集できる text 系の欄の名前（空の値 `""` で送ることを照らす。この部品は値を入れない）。 */
  readonly emptyValueFieldNames: readonly string[];
  /**
   * DEF-098: 送る欄に選ばなかった、見えていて編集できる checkbox・radio（組でない）の名前（本文に出ないことを照らす）。T31R2-fix-1（C-1）:
   * disabled の欄の名前も入る（候補の欄の順）。
   */
  readonly absentFieldNames: readonly string[];
  /**
   * T31R-fix-1（C-1）: 値を照らす hidden・readonly・見えない欄の名前（`unsubmittedFieldRoleOf` の `CHECKED_PASSTHROUGH`。T31R2-fix-1: 見えない
   * checkbox・radio・select の `CHECKED_CHOICE` も）。値は送る前の読み取りで読み、`writePayloadFieldsOf` が期待に入れる（チェック・選択の
   * ない choice は「送られない」）。`passthroughFieldNames` には入らない。
   */
  readonly checkedPassthroughFieldNames: readonly string[];
}

/** 送る中身の照合の期待のうち、欄の部分（`writePayloadFieldsOf`。承認の要求の形は呼び出し側が足す）。 */
export type WritePayloadFields = Required<Pick<
  WritePayloadExpectation,
  'submittedFields' | 'passthroughFieldNames' | 'emptyFileFieldNames' | 'methodOverride' | 'absentFieldNames' | 'checkedPassthroughFields'
>>;

/** `writePayloadFieldsOf` の結果（値を照らす欄の値がそろわない・choice でない欄の値が null なら `SPEC_INVALID`）。 */
export type WritePayloadFieldsResult =
  | { readonly ok: true; readonly fields: WritePayloadFields }
  | { readonly ok: false; readonly reason: Extract<WriteFormReason, 'SPEC_INVALID'> };

/**
 * T31R-fix-1（C-1）: 送る前の読み取りで読んだ、値を照らす欄の値（`readWritePassthroughValues`。返すだけで記録しない）。T31R2-fix-1: null は、
 * チェック・選択のない見えない checkbox・radio・select（送られない）。
 */
export type WritePassthroughRead =
  | { readonly ok: true; readonly values: Readonly<Record<string, string | null>> }
  | { readonly ok: false; readonly reason: WriteFormReason };

/** 確かめが通った form（照合に渡す名前の一覧。位置は、この部品の中だけに持つ）。 */
export type InspectedWriteForm = WriteFormFieldLists;

export type WriteFormInspection =
  | { readonly ok: true; readonly form: InspectedWriteForm }
  | { readonly ok: false; readonly reason: WriteFormReason };

export type WriteFormStepResult = { readonly ok: true } | { readonly ok: false; readonly reason: WriteFormReason };

export type WriteFormSubmission =
  | { readonly ok: true; readonly outcome: 'SUBMITTED' }
  | { readonly ok: false; readonly reason: WriteFormReason; readonly clickAttempted: boolean };

/** 選んで送る欄の型（checkbox と radio）。 */
const CHECKABLE_TYPES: ReadonlySet<CandidateFieldType> = new Set(['checkbox', 'radio']);
/** 選択の欄の型（owner は `candidate-contracts.ts` の `SELECT_FIELD_TYPES`）。 */
const SELECT_TYPES: ReadonlySet<CandidateFieldType> = new Set(SELECT_FIELD_TYPES);
/** 値を入れない hidden の型。 */
const HIDDEN_FIELD_TYPE: CandidateFieldType = 'hidden';
const FILE_FIELD_TYPE: CandidateFieldType = 'file';
/** T31R2-fix-1（C-1）: 値を照らせない見えない選択の型（選んだ値が 2 つ以上になりうる）。 */
const SELECT_MULTIPLE_FIELD_TYPE: CandidateFieldType = 'select-multiple';
const TEXTAREA_FIELD_TYPE: CandidateFieldType = 'textarea';
/** `input` のうち、欄に含めない型（送信ボタン・リセット・普通のボタン。discovery の probe と同じ）と、送信ボタンの型。 */
const BUTTON_INPUT_TYPES: readonly string[] = Object.freeze(['submit', 'image', 'reset', 'button']);
const SUBMIT_INPUT_TYPES: readonly string[] = Object.freeze(['submit', 'image']);
/** 値を読まない欄の型（hidden の値・CSRF のトークン、password、file）。 */
const UNREAD_VALUE_TYPES: readonly string[] = Object.freeze(['hidden', 'password', 'file']);
/** T31g-1: 名前で読むと決めた欄でも、値を読まない型（`candidate-contracts.ts` の値を送れない型。password・file）。 */
const NEVER_READ_VALUE_TYPES: readonly string[] = Object.freeze([...UNSENDABLE_FIELD_TYPES]);
/** 読み取りの上限（文書の form の数、1 つの form の要素の数）。超えたら読めなかったとする（fail-closed）。 */
const MAX_READ_FORMS = 256;
const MAX_READ_FORM_CONTROLS = 512;
/** `accept-charset` で受ける文字コードの名前（小文字。ほかの名前は止める）。 */
const UTF8_ACCEPT_CHARSET = 'utf-8';
/** checkbox・radio の `value` の属性がないときの値（HTML の既定）。 */
const DEFAULT_CHECKABLE_VALUE = 'on';

// ---------------------------------------------------------------------------------------------------------------
// ページの中の読み取り（isolated world で動く。外の値を参照しない）
// ---------------------------------------------------------------------------------------------------------------

interface WriteFormReadInput {
  readonly candidateNames: readonly string[];
  /** 値を読む見える欄の名前（CREATE は送る欄、UPDATE は変える欄と保つ欄）。`unreadValueTypes` の型の欄は読まない。 */
  readonly valueNames: readonly string[];
  /** T31g-1: 型が hidden でも値を読む欄の名前（UPDATE の状態の名前の hidden と、組の hidden）。`neverReadTypes` の型の欄は読まない。 */
  readonly hiddenValueNames: readonly string[];
  readonly buttonInputTypes: readonly string[];
  readonly submitInputTypes: readonly string[];
  readonly unreadValueTypes: readonly string[];
  readonly neverReadTypes: readonly string[];
  readonly defaultCheckableValue: string;
  readonly maxForms: number;
  readonly maxControls: number;
}

/** 読んだ欄（値を読む欄だけ、値と選択の状態を持つ）。 */
interface ReadControl {
  readonly name: string;
  readonly type: string;
  readonly path: readonly number[] | null;
  /** text 系・textarea の値（値を読む欄だけ。T31g-1: 値を読む hidden の欄も）。 */
  readonly value: string | null;
  /** select の選ばれた値（値を読む欄だけ）。 */
  readonly selected: readonly string[] | null;
  /** checkbox・radio の選択と、選択肢の値（値を読む欄だけ）。 */
  readonly checked: boolean | null;
  readonly optionValue: string | null;
}

interface ReadSubmitter {
  readonly path: readonly number[] | null;
  readonly method: string | null;
  readonly action: string | null;
  readonly enctype: string | null;
  readonly target: string | null;
}

interface ReadForm {
  readonly path: readonly number[] | null;
  readonly method: string;
  readonly action: string;
  readonly enctype: string;
  /** form の `target` の属性があればその値、なければ null（`<base target>` を使う）。 */
  readonly target: string | null;
  readonly acceptCharset: string;
  readonly controls: readonly ReadControl[];
  readonly submitters: readonly ReadSubmitter[];
  /** form の中の要素のうち、候補の名前を持ち、別の form に結び付いた欄の名前。 */
  readonly foreignNames: readonly string[];
}

interface ReadDocument {
  readonly forms: readonly ReadForm[];
  readonly baseTarget: string;
  readonly limitReached: boolean;
}

/**
 * ページの中で、文書の form を読む（ページに何も書かない。操作しない）。この関数は isolated world で動く（外の値を参照しない）。値は、値を読む
 * 欄（`valueNames` の、hidden・password・file でない型の欄と、`hiddenValueNames` の、password・file でない型の欄）だけを読む。
 * 部品（`R`）は `composeInPage` で組み込む（`src/browser/in-page-readers.ts`。CC-068）。
 */
function readWriteFormsReader(R: StandardReaders, input: WriteFormReadInput): ReadDocument {
  // 標準の prototype の getter（部品の `standardGetter`。`src/browser/in-page-readers.ts`。CC-068）。
  const { standardGetter: getterOf } = R;
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const localNameOf = getterOf(Element.prototype, 'localName');
  const formsOf = getterOf(Document.prototype, 'forms');
  const collectionLengthOf = getterOf(HTMLCollection.prototype, 'length');
  const itemOf = (collection: unknown, index: number): Element | null => HTMLCollection.prototype.item.call(collection as HTMLCollection, index);
  const nodeListLengthOf = getterOf(NodeList.prototype, 'length');
  const nodeItemOf = (list: unknown, index: number): Node | null => NodeList.prototype.item.call(list as NodeList, index);
  const formElementsOf = getterOf(HTMLFormElement.prototype, 'elements');
  const formMethodOf = getterOf(HTMLFormElement.prototype, 'method');
  const formActionOf = getterOf(HTMLFormElement.prototype, 'action');
  const formEnctypeOf = getterOf(HTMLFormElement.prototype, 'enctype');
  const formTargetOf = getterOf(HTMLFormElement.prototype, 'target');
  const formAcceptCharsetOf = getterOf(HTMLFormElement.prototype, 'acceptCharset');
  const inputTypeOf = getterOf(HTMLInputElement.prototype, 'type');
  const inputValueOf = getterOf(HTMLInputElement.prototype, 'value');
  const inputCheckedOf = getterOf(HTMLInputElement.prototype, 'checked');
  const textAreaValueOf = getterOf(HTMLTextAreaElement.prototype, 'value');
  const selectTypeOf = getterOf(HTMLSelectElement.prototype, 'type');
  const selectedOptionsOf = getterOf(HTMLSelectElement.prototype, 'selectedOptions');
  const optionValueOf = getterOf(HTMLOptionElement.prototype, 'value');
  const buttonTypeOf = getterOf(HTMLButtonElement.prototype, 'type');
  const ownerGetters: Readonly<Record<string, (target: unknown) => unknown>> = {
    input: getterOf(HTMLInputElement.prototype, 'form'),
    select: getterOf(HTMLSelectElement.prototype, 'form'),
    textarea: getterOf(HTMLTextAreaElement.prototype, 'form'),
    button: getterOf(HTMLButtonElement.prototype, 'form'),
  };
  const getAttribute = (element: Element, name: string): string | null => Element.prototype.getAttribute.call(element, name);
  const hasAttribute = (element: Element, name: string): boolean => Element.prototype.hasAttribute.call(element, name);
  const querySelectorAll = (root: Element, selectors: string): unknown => Element.prototype.querySelectorAll.call(root, selectors);

  // 要素の位置（文書の根からの、要素の子の中の番号）。shadow root の中なら null（部品の `elementPathOf`。要素の橋渡しと同じ数え方。T32j-4）。
  const pathOf = R.elementPathOf;
  const valueRead = (name: string, type: string): boolean => (input.valueNames.includes(name) && !input.unreadValueTypes.includes(type))
    || (input.hiddenValueNames.includes(name) && !input.neverReadTypes.includes(type));
  const overrideOf = (element: Element, prototype: object, attribute: string, property: string): string | null =>
    hasAttribute(element, attribute) ? text(getterOf(prototype, property)(element)) : null;

  let limitReached = false;
  const forms: ReadForm[] = [];
  const formCollection = formsOf(document);
  const formCount = Number(collectionLengthOf(formCollection));
  if (formCount > input.maxForms) {
    limitReached = true;
  }
  for (let formIndex = 0; formIndex < Math.min(formCount, input.maxForms); formIndex += 1) {
    const form = itemOf(formCollection, formIndex);
    if (form === null) {
      continue;
    }
    const elements = formElementsOf(form);
    const count = Number(collectionLengthOf(elements));
    if (count > input.maxControls) {
      limitReached = true;
      continue;
    }
    const controls: ReadControl[] = [];
    const submitters: ReadSubmitter[] = [];
    for (let index = 0; index < count; index += 1) {
      const element = itemOf(elements, index);
      if (element === null) {
        continue;
      }
      const tag = text(localNameOf(element));
      let type: string;
      if (tag === 'input') {
        type = text(inputTypeOf(element));
        if (input.buttonInputTypes.includes(type)) {
          if (input.submitInputTypes.includes(type)) {
            submitters.push({
              path: pathOf(element),
              method: overrideOf(element, HTMLInputElement.prototype, 'formmethod', 'formMethod'),
              action: overrideOf(element, HTMLInputElement.prototype, 'formaction', 'formAction'),
              enctype: overrideOf(element, HTMLInputElement.prototype, 'formenctype', 'formEnctype'),
              target: overrideOf(element, HTMLInputElement.prototype, 'formtarget', 'formTarget'),
            });
          }
          continue;
        }
      } else if (tag === 'select') {
        type = text(selectTypeOf(element));
      } else if (tag === 'textarea') {
        type = 'textarea';
      } else if (tag === 'button') {
        if (text(buttonTypeOf(element)) === 'submit') {
          submitters.push({
            path: pathOf(element),
            method: overrideOf(element, HTMLButtonElement.prototype, 'formmethod', 'formMethod'),
            action: overrideOf(element, HTMLButtonElement.prototype, 'formaction', 'formAction'),
            enctype: overrideOf(element, HTMLButtonElement.prototype, 'formenctype', 'formEnctype'),
            target: overrideOf(element, HTMLButtonElement.prototype, 'formtarget', 'formTarget'),
          });
        }
        continue;
      } else {
        continue;
      }
      const name = getAttribute(element, 'name') ?? '';
      const readValue = valueRead(name, type);
      let value: string | null = null;
      let selected: string[] | null = null;
      let checked: boolean | null = null;
      let optionValue: string | null = null;
      if (readValue) {
        if (tag === 'select') {
          const options = selectedOptionsOf(element);
          selected = [];
          for (let optionIndex = 0; optionIndex < Number(collectionLengthOf(options)); optionIndex += 1) {
            const option = itemOf(options, optionIndex);
            selected.push(option === null ? '' : text(optionValueOf(option)));
          }
        } else if (tag === 'textarea') {
          value = text(textAreaValueOf(element));
        } else if (type === 'checkbox' || type === 'radio') {
          checked = inputCheckedOf(element) === true;
          optionValue = getAttribute(element, 'value') ?? input.defaultCheckableValue;
        } else {
          value = text(inputValueOf(element));
        }
      }
      controls.push({ name, type, path: pathOf(element), value, selected, checked, optionValue });
    }
    const foreignNames: string[] = [];
    const descendants = querySelectorAll(form, 'input, select, textarea');
    for (let index = 0; index < Number(nodeListLengthOf(descendants)); index += 1) {
      const node = nodeItemOf(descendants, index);
      if (!(node instanceof Element)) {
        continue;
      }
      const ownerOf = ownerGetters[text(localNameOf(node))];
      const name = getAttribute(node, 'name') ?? '';
      if (ownerOf !== undefined && input.candidateNames.includes(name) && ownerOf(node) !== form) {
        foreignNames.push(name);
      }
    }
    forms.push({
      path: pathOf(form),
      method: text(formMethodOf(form)),
      action: text(formActionOf(form)),
      enctype: text(formEnctypeOf(form)),
      target: hasAttribute(form, 'target') ? text(formTargetOf(form)) : null,
      acceptCharset: text(formAcceptCharsetOf(form)),
      controls,
      submitters,
      foreignNames,
    });
  }
  // `document` の名前つきの要素（`<img name="querySelector">` など）に隠されないように、標準のメソッドで読む。
  const base = Document.prototype.querySelector.call(document, 'base[target]');
  return { forms, baseTarget: base === null ? '' : text(getAttribute(base, 'target')), limitReached };
}
const readWriteFormsInPage = composeInPage(readWriteFormsReader);

// ---------------------------------------------------------------------------------------------------------------
// 読み取りの形の確かめ（ページの中の結果は、信じずに形を見る）
// ---------------------------------------------------------------------------------------------------------------

const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isPath = (value: unknown): value is readonly number[] | null =>
  value === null || (Array.isArray(value) && value.length > 0 && value.every((step) => Number.isSafeInteger(step) && step >= 0));

const isReadControl = (value: unknown): value is ReadControl => isRecord(value)
  && isString(value['name']) && isString(value['type']) && isPath(value['path'])
  && isNullableString(value['value']) && isNullableString(value['optionValue'])
  && (value['checked'] === null || typeof value['checked'] === 'boolean')
  && (value['selected'] === null || (Array.isArray(value['selected']) && value['selected'].every(isString)));

const isReadSubmitter = (value: unknown): value is ReadSubmitter => isRecord(value)
  && isPath(value['path']) && ['method', 'action', 'enctype', 'target'].every((key) => isNullableString(value[key]));

const isReadForm = (value: unknown): value is ReadForm => isRecord(value)
  && isPath(value['path']) && ['method', 'action', 'enctype', 'acceptCharset'].every((key) => isString(value[key]))
  && isNullableString(value['target'])
  && Array.isArray(value['controls']) && value['controls'].every(isReadControl)
  && Array.isArray(value['submitters']) && value['submitters'].every(isReadSubmitter)
  && Array.isArray(value['foreignNames']) && value['foreignNames'].every(isString);

const isReadDocument = (value: unknown): value is ReadDocument => isRecord(value)
  && Array.isArray(value['forms']) && value['forms'].every(isReadForm)
  && isString(value['baseTarget']) && typeof value['limitReached'] === 'boolean';

// ---------------------------------------------------------------------------------------------------------------
// 判定（Node の側）
// ---------------------------------------------------------------------------------------------------------------

/** 確かめが通った form の位置（form、送信ボタン、欄）と、送る欄の位置。 */
interface WriteFormLayout {
  readonly formPath: readonly number[];
  readonly submitterPath: readonly number[];
  readonly controls: readonly { readonly name: string; readonly type: string; readonly path: readonly number[] }[];
}

/** 確かめが通った form の位置と、確かめに使った指定と、要素の参照（`InspectedWriteForm` ごと。この部品の中だけ）。 */
interface InspectedState {
  readonly spec: WriteFormSpec;
  readonly signature: string;
  /**
   * form・送信ボタン・送る欄の位置と、最初の確かめの時の要素の backendNodeId（isolated world で読む。同じ要素かを、ページの JS に偽られずに
   * 確かめる。DEF-114。T32j-4）。
   */
  readonly elements: TrackedElements;
  /** T31g-1: UPDATE の確かめ（欄の役割と前の値）。CREATE はない。 */
  readonly update?: { readonly roles: UpdateRoles; readonly prior: UpdateFormValues } | undefined;
}
const inspectedStates = new WeakMap<InspectedWriteForm, InspectedState>();

/** T40R-fix-A: 値を入れたときに送信の窓を開いた、書き込みの段の部品（押す直前に、同じ部品で送信の段を開く）。 */
const windowMonitors = new WeakMap<InspectedWriteForm, WriteStageMonitor>();

type Decision =
  | { readonly ok: true; readonly layout: WriteFormLayout; readonly form: ReadForm }
  | { readonly ok: false; readonly reason: WriteFormReason };

/** 欄の一覧が `WriteFormFieldSpec` の形か。 */
const isFieldSpecList = (value: unknown): value is readonly WriteFormFieldSpec[] => Array.isArray(value)
  && (value as readonly unknown[]).every((candidate) => isRecord(candidate)
    && isString(candidate['name'])
    && (CANDIDATE_FIELD_TYPES as readonly unknown[]).includes(candidate['type'])
    && ['readonly', 'hidden', 'disabled'].every((key) => typeof candidate[key] === 'boolean'));

/** 指定が正しいか（ファイルの先頭の説明と `SPEC_INVALID`）。 */
function isValidSpec(spec: WriteFormSpec): boolean {
  if (!isRecord(spec) || !isRecord(spec.endpoint) || !isString(spec.endpoint.origin) || !isString(spec.endpoint.path)) {
    return false;
  }
  if (!(WRITE_FORM_ENCTYPES as readonly unknown[]).includes(spec.enctype)) {
    return false;
  }
  if (spec.methodOverride !== null && !(WRITE_METHOD_OVERRIDES as readonly unknown[]).includes(spec.methodOverride)) {
    return false;
  }
  const { candidateFields, submittedFieldNames } = spec;
  if (!isFieldSpecList(candidateFields) || !Array.isArray(submittedFieldNames) || submittedFieldNames.length === 0) {
    return false;
  }
  if (new Set(submittedFieldNames).size !== submittedFieldNames.length) {
    return false;
  }
  return submittedFieldNames.every((name) => {
    if (!isString(name) || name.length === 0 || isMethodOverrideFieldName(name)) {
      return false;
    }
    const matching = candidateFields.filter((candidate) => candidate.name === name);
    const [first] = matching;
    if (first === undefined || !matching.every((candidate) => candidate.type === first.type)) {
      return false;
    }
    const sendable = !isUnsendableFieldType(first.type) && first.type !== HIDDEN_FIELD_TYPE
      && matching.every((candidate) => !candidate.readonly && !candidate.hidden && !candidate.disabled);
    return sendable && (CHECKABLE_TYPES.has(first.type) || matching.length === 1);
  }) && unsubmittedFieldsExpectable(spec);
}

/**
 * DEF-098: 送る欄に選ばなかった欄の、照合の期待での扱い（唯一の判定。登録と更新で共用）。
 * - `PASSTHROUGH`: 名前だけを照らす欄（値は読まない）。T31R2-fix-1（C-1）: hidden の型・見えない・readonly の欄のうち、ページが読み込みごとに
 *   作る値の名前（`isPageIssuedTokenFieldName`。CSRF のトークンなど）の欄だけ。
 * - `CHECKED_PASSTHROUGH`（T31R-fix-1。C-1）: そのほかの hidden・readonly・見えない、値が 1 つの欄（text 系・textarea・hidden。選ばなかった組の
 *   hidden を含む。値を読んで照らす）。
 * - `CHECKED_CHOICE`（T31R2-fix-1。C-1）: 見えない（hidden・readonly を含む）checkbox・radio・select-one（チェック・選択の状態と値を読み、あれば
 *   値を照らし、なければ送られないことを照らす）。
 * - `UNREADABLE_SECRET`（T31R2-fix-1。C-1）: ページが作る値の名前でない、秘密に見える名前の hidden・readonly・見えない欄（値を読めず照らせない。
 *   期待を作らず `SECRET_LIKE_PASSTHROUGH_FIELD` で止める。判定は owner `src/discovery/read-check-contracts.ts` の `isUnreadableSecretField`。
 *   シナリオの下書きの確かめと共用）。
 * - `UNSUPPORTED_PASSTHROUGH`（T31R2-fix-1。C-1）: 値を照らせない形の hidden・readonly・見えない欄（select-multiple と password。期待を作れない）。
 * - `EMPTY_FILE`: file の欄（空のときだけ送ってよい）。
 * - `NOT_SENT`: 選ばなかった組の checkbox（組の hidden の名前で照らす）。
 * - `DISABLED`（T31R2-fix-1。C-1）: disabled の欄（ブラウザが送らない。送られないことを照らす。同じ名前のほかの欄と重なれば期待を作れない）。
 * - `ABSENT`: checkbox・radio（チェックしない・選ばないまま。本文に出ないことを照らす）。
 * - `DEFAULT_VALUE`: 既定の値が分からない欄（`candidate-contracts.ts` の `DEFAULT_VALUE_FIELD_TYPES`。select・range・color。ブラウザが既定の値で
 *   送る。期待を作れない。シナリオの下書きの確かめも同じ一覧で受けない）。
 * - `EMPTY_VALUE`: ほかの text 系（値が 1 つの欄。password と textarea を含む。空の値で送ることを照らす）。
 */
type UnsubmittedFieldRole = 'PASSTHROUGH' | 'CHECKED_PASSTHROUGH' | 'CHECKED_CHOICE' | 'UNREADABLE_SECRET' | 'UNSUPPORTED_PASSTHROUGH' | 'EMPTY_FILE'
  | 'NOT_SENT' | 'DISABLED' | 'ABSENT' | 'DEFAULT_VALUE' | 'EMPTY_VALUE';

/** 送る欄に選ばなかった欄 1 つと、その扱い。 */
interface UnsubmittedFieldEntry {
  readonly name: string;
  readonly type: CandidateFieldType;
  readonly role: UnsubmittedFieldRole;
}

/** 値を送る形の見えない欄か（hidden の型・見えない・readonly のどれか）。 */
const isConcealedField = (candidate: WriteFormFieldSpec): boolean =>
  candidate.type === HIDDEN_FIELD_TYPE || candidate.hidden || candidate.readonly;

/** T31R2-fix-1（C-1）: checkbox・radio・select（チェック・選択がなければ送られない欄）の型か。 */
const isChoiceType = (type: CandidateFieldType | undefined): boolean => type !== undefined && (CHECKABLE_TYPES.has(type) || SELECT_TYPES.has(type));

/** 送る欄に選ばなかった、名前のある欄（method の上書きの欄を除く）と、その扱い（候補の欄の順）。 */
function unsubmittedFieldRolesOf(spec: WriteFormSpec): readonly UnsubmittedFieldEntry[] {
  const submittedNames = new Set(spec.submittedFieldNames);
  const pairCheckboxIndexes = new Set(checkboxHiddenPairsOf(spec.candidateFields).map(({ checkboxIndex }) => checkboxIndex));
  return spec.candidateFields.flatMap((candidate, index) => {
    if (candidate.name.length === 0 || submittedNames.has(candidate.name) || isMethodOverrideFieldName(candidate.name)) {
      return [];
    }
    return [{ name: candidate.name, type: candidate.type, role: unsubmittedFieldRoleOf(candidate, pairCheckboxIndexes.has(index)) }];
  });
}

/** 送る欄に選ばなかった欄 1 つの扱い（`UnsubmittedFieldRole`）。 */
function unsubmittedFieldRoleOf(candidate: WriteFormFieldSpec, pairCheckbox: boolean): UnsubmittedFieldRole {
  if (candidate.disabled) {
    return 'DISABLED';
  }
  if (candidate.type === FILE_FIELD_TYPE) {
    return 'EMPTY_FILE';
  }
  if (pairCheckbox) {
    return 'NOT_SENT';
  }
  if (isConcealedField(candidate)) {
    return concealedFieldRoleOf(candidate);
  }
  if (CHECKABLE_TYPES.has(candidate.type)) {
    return 'ABSENT';
  }
  return isDefaultValueFieldType(candidate.type) ? 'DEFAULT_VALUE' : 'EMPTY_VALUE';
}

/** T31R2-fix-1（C-1）: disabled でない、hidden の型・見えない・readonly の欄の扱い（`UnsubmittedFieldRole` の説明）。 */
function concealedFieldRoleOf(candidate: WriteFormFieldSpec): UnsubmittedFieldRole {
  if (isPageIssuedTokenFieldName(candidate.name)) {
    return 'PASSTHROUGH';
  }
  if (isUnreadableSecretField(candidate)) {
    return 'UNREADABLE_SECRET';
  }
  if (isUnsendableFieldType(candidate.type) || candidate.type === SELECT_MULTIPLE_FIELD_TYPE) {
    return 'UNSUPPORTED_PASSTHROUGH';
  }
  return isChoiceType(candidate.type) ? 'CHECKED_CHOICE' : 'CHECKED_PASSTHROUGH';
}

/**
 * DEF-098: 選ばなかった欄の期待を作れるか（既定の値で送る欄・値を照らせない欄がなく、一覧の名前が重ならない）。T31R-fix-1（C-1）: 値を照らす
 * 欄は、名前ごとに 1 つ（照合は、その名前の欄が本文にちょうど 1 つであることを求める）。T31R2-fix-1: choice は、同じ名前の欄がすべて同じ型で、
 * checkbox・radio のほかは 1 つ。
 */
function unsubmittedFieldsExpectable(spec: WriteFormSpec): boolean {
  const roles = unsubmittedFieldRolesOf(spec);
  if (roles.some(({ role }) => role === 'DEFAULT_VALUE' || role === 'UNREADABLE_SECRET' || role === 'UNSUPPORTED_PASSTHROUGH')) {
    return false;
  }
  const rolesByName = new Map<string, Set<UnsubmittedFieldRole>>();
  for (const { name, role } of roles) {
    if (role !== 'NOT_SENT') {
      rolesByName.set(name, (rolesByName.get(name) ?? new Set<UnsubmittedFieldRole>()).add(role));
    }
  }
  const valueChecked = (name: string): boolean => {
    const entries = roles.filter((entry) => entry.name === name && entry.role !== 'NOT_SENT');
    const [first] = entries;
    if (first === undefined) {
      return false;
    }
    if (first.role === 'CHECKED_PASSTHROUGH') {
      return entries.length === 1;
    }
    return entries.every((entry) => entry.type === first.type) && (CHECKABLE_TYPES.has(first.type) || entries.length === 1);
  };
  return [...rolesByName.values()].every((set) => set.size === 1)
    && [...rolesByName.entries()].every(([name, set]) => !(set.has('CHECKED_PASSTHROUGH') || set.has('CHECKED_CHOICE')) || valueChecked(name));
}

/** 登録の指定の誤り（正しければ null。秘密に見える名前の欄があれば、名前の分かる理由）。 */
function writeSpecProblemOf(spec: WriteFormSpec): Extract<WriteFormReason, 'SPEC_INVALID' | 'SECRET_LIKE_PASSTHROUGH_FIELD'> | null {
  if (isValidSpec(spec)) {
    return null;
  }
  return isRecord(spec) && isFieldSpecList(spec.candidateFields) && spec.candidateFields.some(isUnreadableSecretField)
    ? 'SECRET_LIKE_PASSTHROUGH_FIELD'
    : 'SPEC_INVALID';
}

/**
 * 照合（Guard の `WritePayloadExpectation`）に渡す名前の一覧と値を照らす欄の期待を、承認した候補から求める（純粋）。送る欄に選ばなかった欄の
 * 扱いは `unsubmittedFieldRoleOf`（hidden・readonly・見えない欄と選ばなかった組の hidden、file の欄、DEF-098 の text 系と checkbox・radio）。
 * 名前のない欄は送られないので含めない。T30b fix round 1: method の上書きの欄（`_method`。Task 27 の判定と同じ畳み込み）は名前だけの一覧に
 * 入れず、承認した候補の上書きの値（`methodOverride`）で照らす。期待を作れない指定（`DEFAULT_VALUE` の欄、名前の重なり）は、確かめ
 * （`inspectWriteForm`）が `SPEC_INVALID` で止める。
 */
export function writeFormFieldListsOf(spec: WriteFormSpec): WriteFormFieldLists {
  const roles = unsubmittedFieldRolesOf(spec);
  const namesOf = (...wanted: readonly UnsubmittedFieldRole[]): readonly string[] =>
    Object.freeze([...new Set(roles.filter((entry) => wanted.includes(entry.role)).map(({ name }) => name))]);
  return Object.freeze({
    passthroughFieldNames: namesOf('PASSTHROUGH'),
    emptyFileFieldNames: namesOf('EMPTY_FILE'),
    methodOverride: spec.methodOverride,
    emptyValueFieldNames: namesOf('EMPTY_VALUE'),
    // T31R2-fix-1（C-1）: disabled の欄も「送られない」（候補の欄の順）。
    absentFieldNames: namesOf('ABSENT', 'DISABLED'),
    checkedPassthroughFieldNames: namesOf('CHECKED_PASSTHROUGH', 'CHECKED_CHOICE'),
  });
}

/**
 * DEF-098: 送る中身の照合の期待のうち欄の部分（純粋。凍結）: 送る欄は、生成した値の null でない欄と、選ばなかった text 系の欄（値 `""`）。
 * 名前だけの一覧・file の欄・method の上書き・送らない欄は `writeFormFieldListsOf` のとおり。承認の要求の形（`request`）は呼び出し側が足す。
 * T31R2-fix-1（C-1）: 値を照らす欄の値が null（チェック・選択のない見えない choice）なら、その名前は「送られない」（`absentFieldNames` の後ろ）。
 */
export function writePayloadFieldsOf(
  spec: WriteFormSpec,
  values: Readonly<Record<string, string | null>>,
  passthroughValues: Readonly<Record<string, string | null>>,
): WritePayloadFieldsResult {
  const lists = writeFormFieldListsOf(spec);
  const choiceNames = new Set(unsubmittedFieldRolesOf(spec).filter(({ role }) => role === 'CHECKED_CHOICE').map(({ name }) => name));
  // T31R-fix-1（C-1）: 値を照らす欄は、送る前の読み取りで読んだ値（そろわなければ期待を作れない。null は choice だけ）。
  if (!isRecord(passthroughValues) || !lists.checkedPassthroughFieldNames.every((name) => Object.hasOwn(passthroughValues, name)
    && (isString(passthroughValues[name]) || (passthroughValues[name] === null && choiceNames.has(name))))) {
    return { ok: false, reason: 'SPEC_INVALID' };
  }
  const checkedPassthroughFields = lists.checkedPassthroughFieldNames.flatMap((name) => {
    const value = passthroughValues[name];
    return isString(value) ? [Object.freeze({ name, value })] : [];
  });
  const unsentChoiceNames = lists.checkedPassthroughFieldNames.filter((name) => passthroughValues[name] === null);
  return {
    ok: true,
    fields: Object.freeze({
      submittedFields: Object.freeze([
        ...Object.entries(values).flatMap(([name, value]) => (value === null ? [] : [Object.freeze({ name, value })])),
        ...lists.emptyValueFieldNames.map((name) => Object.freeze({ name, value: '' })),
      ]),
      passthroughFieldNames: lists.passthroughFieldNames,
      emptyFileFieldNames: lists.emptyFileFieldNames,
      methodOverride: lists.methodOverride,
      absentFieldNames: Object.freeze([...lists.absentFieldNames, ...unsentChoiceNames]),
      checkedPassthroughFields: Object.freeze(checkedPassthroughFields),
    }),
  };
}

/** 読んだ値 1 つ（null は、チェック・選択のない checkbox・radio・select）か、読めなかった理由。 */
type ChosenValueRead = { readonly ok: true; readonly value: string | null } | { readonly ok: false; readonly reason: WriteFormReason };

/**
 * 同じ名前・同じ型 `type` の、読んだ欄の送られる値（唯一の読み方。更新の変える欄・保つ欄と、値を照らす欄で共用）: checkbox・radio はチェック
 * した欄の値、select は選んだ値（欄は 1 つ）、ほかは値（欄は 1 つ）。どれもなければ null。値が 2 つ以上なら `VALUE_NOT_SUPPORTED`（照合の
 * 期待を作れない）、読めなければ `FORM_UNREADABLE`。
 */
function chosenValueOf(controls: readonly ReadControl[], type: CandidateFieldType | undefined): ChosenValueRead {
  const unreadable: ChosenValueRead = { ok: false, reason: 'FORM_UNREADABLE' };
  const [first] = controls;
  if (first === undefined || type === undefined) {
    return unreadable;
  }
  let chosen: readonly string[];
  if (CHECKABLE_TYPES.has(type)) {
    if (controls.some((control) => control.checked === null || control.optionValue === null)) {
      return unreadable;
    }
    chosen = controls.filter((control) => control.checked === true).map((control) => control.optionValue ?? '');
  } else if (SELECT_TYPES.has(type)) {
    if (controls.length !== 1 || first.selected === null) {
      return unreadable;
    }
    chosen = first.selected;
  } else {
    if (controls.length !== 1 || first.value === null) {
      return unreadable;
    }
    chosen = [first.value];
  }
  // 同じ名前の値が 2 つ以上（照合は、組のほかの同じ名前を 1 回だけ受ける）。
  return chosen.length > 1 ? { ok: false, reason: 'VALUE_NOT_SUPPORTED' } : { ok: true, value: chosen[0] ?? null };
}

/** T31R2-fix-1（C-1）: 値を照らす欄（名前と型）の値を、読んだ form から取り出す（`chosenValueOf`）。 */
function concealedValuesOf(
  form: ReadForm,
  names: readonly string[],
  typeOf: ReadonlyMap<string, CandidateFieldType>,
): { readonly ok: true; readonly values: Readonly<Record<string, string | null>> } | { readonly ok: false; readonly reason: WriteFormReason } {
  const values: Record<string, string | null> = {};
  for (const name of names) {
    const type = typeOf.get(name);
    const read = chosenValueOf(form.controls.filter((control) => control.name === name && control.type === type), type);
    if (!read.ok) {
      return read;
    }
    values[name] = read.value;
  }
  return { ok: true, values: Object.freeze(values) };
}

/**
 * T31R-fix-1（C-1）: 登録の送る前の読み取り（画面の確かめと同じ凍結した画面で）。値を照らす欄（`writeFormFieldListsOf` の
 * `checkedPassthroughFieldNames`）の値だけを読む（秘密に見える名前の欄、送る欄、ほかの欄の値は読まない）。読んだ値は返すだけで記録しない。
 * T31R2-fix-1: 見えない checkbox・radio・select は、チェック・選択した値（なければ null）。秘密に見える名前の欄がある画面は
 * `SECRET_LIKE_PASSTHROUGH_FIELD`。例外を投げない。
 */
export async function readWritePassthroughValues(page: Page, spec: WriteFormSpec, timeoutMs = WRITE_FORM_STEP_TIMEOUT_MS): Promise<WritePassthroughRead> {
  try {
    const problem = writeSpecProblemOf(spec);
    if (problem !== null) {
      return { ok: false, reason: problem };
    }
    const typeOf = new Map(unsubmittedFieldRolesOf(spec)
      .filter(({ role }) => role === 'CHECKED_PASSTHROUGH' || role === 'CHECKED_CHOICE')
      .map(({ name, type }): [string, CandidateFieldType] => [name, type]));
    const names = [...typeOf.keys()];
    const decision = await readAndDecide(page, spec, timeoutMs, { valueNames: [], hiddenValueNames: names });
    if (!decision.ok) {
      return decision;
    }
    return concealedValuesOf(decision.form, names, typeOf);
  } catch {
    return { ok: false, reason: 'FORM_UNREADABLE' };
  }
}

/** 名前の一覧の比べ（重複を含めて同じか）。 */
const sameMultiset = (left: readonly string[], right: readonly string[]): boolean => {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
};

/** `accept-charset` がないか、UTF-8 だけか。 */
const acceptsOnlyUtf8 = (acceptCharset: string): boolean => acceptCharset.trim().split(/\s+/u)
  .filter((token) => token.length > 0)
  .every((token) => token.toLowerCase() === UTF8_ACCEPT_CHARSET);

/** 送信ボタン 1 つの、送り方の確かめ（通れば null）。 */
function submitterProblemOf(spec: WriteFormSpec, form: ReadForm, submitter: ReadSubmitter, baseTarget: string): WriteFormReason | null {
  if ((submitter.method ?? form.method).toLowerCase() !== FORM_POST_METHOD) {
    return 'METHOD_NOT_POST';
  }
  if (!isWriteEndpointUrl(submitter.action ?? form.action, spec.endpoint)) {
    return 'ACTION_NOT_ALLOWED';
  }
  const enctype = (submitter.enctype ?? form.enctype).toLowerCase();
  if (!(WRITE_FORM_ENCTYPES as readonly string[]).includes(enctype)) {
    return 'ENCTYPE_NOT_ALLOWED';
  }
  if (enctype !== spec.enctype) {
    return 'ENCTYPE_MISMATCH';
  }
  const target = (submitter.target ?? form.target ?? baseTarget).trim().toLowerCase();
  if (!FORM_SELF_TARGETS.has(target)) {
    return 'FORM_TARGET_NOT_SELF';
  }
  return acceptsOnlyUtf8(form.acceptCharset) ? null : 'ACCEPT_CHARSET_NOT_UTF8';
}

/** 読んだ文書から、送る form と送信ボタンを決めて確かめる（ファイルの先頭の説明の順）。 */
function decideWriteForm(spec: WriteFormSpec, read: ReadDocument): Decision {
  if (read.limitReached) {
    return { ok: false, reason: 'FORM_UNREADABLE' };
  }
  const forms = read.forms.filter((form) => spec.submittedFieldNames.every((name) =>
    form.controls.some((control) => control.name === name) || form.foreignNames.includes(name)));
  const [form, ...others] = forms;
  if (form === undefined) {
    return { ok: false, reason: 'FORM_NOT_FOUND' };
  }
  if (others.length > 0) {
    return { ok: false, reason: 'FORM_AMBIGUOUS' };
  }
  if (form.foreignNames.length > 0) {
    return { ok: false, reason: 'FIELD_OWNED_BY_OTHER_FORM' };
  }
  if (!sameMultiset(form.controls.map((control) => control.name), spec.candidateFields.map((candidate) => candidate.name))) {
    return { ok: false, reason: 'FORM_FIELDS_CHANGED' };
  }
  const pairOf = (name: string, type: string): string => JSON.stringify([name, type]);
  if (!sameMultiset(
    form.controls.map((control) => pairOf(control.name, control.type)),
    spec.candidateFields.map((candidate) => pairOf(candidate.name, candidate.type)),
  )) {
    return { ok: false, reason: 'FIELD_TYPE_MISMATCH' };
  }
  const [firstSubmitter] = form.submitters;
  if (firstSubmitter === undefined) {
    return { ok: false, reason: 'SUBMITTER_NOT_FOUND' };
  }
  const passing = form.submitters.filter((submitter) => submitterProblemOf(spec, form, submitter, read.baseTarget) === null);
  const [submitter, ...otherSubmitters] = passing;
  if (submitter === undefined) {
    return { ok: false, reason: submitterProblemOf(spec, form, firstSubmitter, read.baseTarget) ?? 'SUBMITTER_NOT_FOUND' };
  }
  if (otherSubmitters.length > 0) {
    return { ok: false, reason: 'SUBMITTER_AMBIGUOUS' };
  }
  const submitted = new Set(spec.submittedFieldNames);
  const controls: WriteFormLayout['controls'][number][] = [];
  for (const control of form.controls) {
    if (submitted.has(control.name) && control.path === null) {
      return { ok: false, reason: 'FORM_UNREADABLE' };
    }
    if (control.path !== null) {
      controls.push({ name: control.name, type: control.type, path: control.path });
    }
  }
  if (form.path === null || submitter.path === null) {
    return { ok: false, reason: 'FORM_UNREADABLE' };
  }
  return { ok: true, form, layout: { formPath: form.path, submitterPath: submitter.path, controls } };
}

/** 値を読む欄の名前（見える欄と、型が hidden でも読む欄。T31g-1）。 */
interface ValueReadNames {
  readonly valueNames: readonly string[];
  readonly hiddenValueNames: readonly string[];
}

/**
 * 読んで決める（期限の中で。読めなければ `FORM_UNREADABLE`）。値を読む欄は、省略すると送る欄だけ（CREATE）。
 */
async function readAndDecide(
  page: Page,
  spec: WriteFormSpec,
  timeoutMs: number,
  names: ValueReadNames = { valueNames: spec.submittedFieldNames, hiddenValueNames: [] },
): Promise<Decision> {
  const input: WriteFormReadInput = {
    candidateNames: [...new Set(spec.candidateFields.map((candidate) => candidate.name))],
    valueNames: [...names.valueNames],
    hiddenValueNames: [...names.hiddenValueNames],
    buttonInputTypes: BUTTON_INPUT_TYPES,
    submitInputTypes: SUBMIT_INPUT_TYPES,
    unreadValueTypes: UNREAD_VALUE_TYPES,
    neverReadTypes: NEVER_READ_VALUE_TYPES,
    defaultCheckableValue: DEFAULT_CHECKABLE_VALUE,
    maxForms: MAX_READ_FORMS,
    maxControls: MAX_READ_FORM_CONTROLS,
  };
  const outcome = await readInIsolatedWorld(page, readWriteFormsInPage, input, Date.now() + timeoutMs);
  if (outcome.status !== 'READ' || !isReadDocument(outcome.value)) {
    return { ok: false, reason: 'FORM_UNREADABLE' };
  }
  return decideWriteForm(spec, outcome.value);
}

const signatureOf = (layout: WriteFormLayout): string => JSON.stringify(layout);

/** 要素の参照を持つ位置（form、送信ボタン、送る欄）。 */
const trackedPathsOf = (spec: WriteFormSpec, layout: WriteFormLayout): readonly (readonly number[])[] => [
  layout.formPath,
  layout.submitterPath,
  ...layout.controls.filter((control) => spec.submittedFieldNames.includes(control.name)).map((control) => control.path),
];

/** 確かめの時の要素（位置と、その要素の backendNodeId）。 */
interface TrackedElements {
  readonly paths: readonly (readonly number[])[];
  readonly backendNodeIds: readonly number[];
}

/**
 * 位置の要素の backendNodeId を、isolated world で読む（要素の橋渡しの部品 `backendNodeIdsAtPaths`。DEF-114。T32j-4）。読めなければ投げる
 * （呼ぶ側が `FORM_UNREADABLE` か `FORM_CHANGED` にする）。
 */
async function trackedElementsOf(page: Page, paths: readonly (readonly number[])[], timeoutMs: number): Promise<TrackedElements> {
  const backendNodeIds = await backendNodeIdsAtPaths(page, paths, Date.now() + timeoutMs);
  if (backendNodeIds === null) {
    throw new Error('Write form elements unreadable');
  }
  return { paths, backendNodeIds };
}

/**
 * 今の位置の要素が、最初の確かめの時の要素と同じものか（isolated world で読んだ backendNodeId を比べる。ページの JS は読む間に走らず、
 * 偽れない。DEF-114 の前は main world の `===` で、`Object.prototype` の getter で偽れた）。
 */
async function sameElements(page: Page, state: InspectedState, timeoutMs: number): Promise<boolean> {
  const current = await trackedElementsOf(page, state.elements.paths, timeoutMs);
  return current.backendNodeIds.length === state.elements.backendNodeIds.length
    && current.backendNodeIds.every((backendNodeId, index) => backendNodeId === state.elements.backendNodeIds[index]);
}

/**
 * 送る前の確かめ（ファイルの先頭の説明の 1）。値を受けない。通れば、照合に渡す名前の一覧を返す（位置は、この部品の中だけに持つ）。例外を投げない。
 */
export async function inspectWriteForm(page: Page, spec: WriteFormSpec, timeoutMs = WRITE_FORM_STEP_TIMEOUT_MS): Promise<WriteFormInspection> {
  try {
    const problem = writeSpecProblemOf(spec);
    if (problem !== null) {
      return { ok: false, reason: problem };
    }
    const decision = await readAndDecide(page, spec, timeoutMs);
    if (!decision.ok) {
      return decision;
    }
    let elements: InspectedState['elements'];
    try {
      elements = await trackedElementsOf(page, trackedPathsOf(spec, decision.layout), timeoutMs);
    } catch {
      return { ok: false, reason: 'FORM_UNREADABLE' };
    }
    const form: InspectedWriteForm = writeFormFieldListsOf(spec);
    inspectedStates.set(form, { spec, signature: signatureOf(decision.layout), elements });
    return { ok: true, form };
  } catch {
    return { ok: false, reason: 'FORM_UNREADABLE' };
  }
}

/**
 * 確かめ直し: 最初の確かめと同じ位置で、同じ要素なら、読んだ form と位置を返す。違えば・通らなければ・要素の参照を取れなければ null
 * （`FORM_CHANGED`）。
 */
async function reinspect(page: Page, state: InspectedState, timeoutMs: number): Promise<{ readonly form: ReadForm; readonly layout: WriteFormLayout } | null> {
  const decision = await readAndDecide(page, state.spec, timeoutMs, state.update === undefined ? undefined : valueReadNamesOf(state.update.roles));
  if (!decision.ok || signatureOf(decision.layout) !== state.signature) {
    return null;
  }
  if (state.update !== undefined && !pairsAdjacent(decision.form, state.update.roles)) {
    return null;
  }
  try {
    return await sameElements(page, state, timeoutMs) ? { form: decision.form, layout: decision.layout } : null;
  } catch {
    return null;
  }
}

/**
 * 位置の要素の、合図つきの Locator（T32R-fix-I1）。位置の要素が確かめの時の要素でなければ（入れ替わっていれば）`SignaledElementMissing` を
 * 投げる（待たずに `count()` で確かめる。Playwright の操作も、同じ合図つきのセレクタで要素を解き直すので、操作の間に入れ替わった要素には
 * 届かない）。
 */
type LocateTrackedElement = (path: readonly number[]) => Promise<Locator>;

/** 1 つの欄の操作（合図つきの Locator への操作）。 */
type InputOperation = (locate: LocateTrackedElement, timeoutMs: number) => Promise<unknown>;

/** 合図つきの Locator が、確かめの時の要素を指さない（位置の要素が入れ替わった）。 */
class SignaledElementMissing extends Error {}

/** 操作の結果（`CHANGED`: 位置の要素が確かめの時の要素でない、か合図の受け手を付けられない。`FAILED`: 操作そのものの失敗）。 */
type SignaledRun<T> = { readonly status: 'DONE'; readonly value: T } | { readonly status: 'CHANGED' } | { readonly status: 'FAILED' };

/**
 * 確かめの時の要素（form・送信ボタン・送る欄）に合図の受け手を付けて（要素の橋渡しの部品 `withSignaledElements`）、`run(locate)` を動かす。
 * 終わったら（失敗・期限切れでも）受け手を外す。Playwright の誤りの文は捨てる（値が入りうるため）。
 */
async function runOnTrackedElements<T>(
  page: Page,
  state: InspectedState,
  timeoutMs: number,
  run: (locate: LocateTrackedElement) => Promise<T>,
): Promise<SignaledRun<T>> {
  const outcome = await withSignaledElements(page, state.elements.backendNodeIds, Date.now() + timeoutMs, async (signals) => {
    const signalOf = new Map(state.elements.paths.map((path, index) => [path.join(PATH_KEY_SEPARATOR), signals[index]] as const));
    const locate: LocateTrackedElement = async (path) => {
      const signal = signalOf.get(path.join(PATH_KEY_SEPARATOR));
      if (signal === undefined) {
        throw new SignaledElementMissing();
      }
      const locator = page.locator(elementPathSelectorOf(path, signal));
      if (await locator.count() !== 1) {
        throw new SignaledElementMissing();
      }
      return locator;
    };
    return run(locate);
  });
  if (outcome.status === 'DONE') {
    return outcome;
  }
  return outcome.error === undefined || outcome.error instanceof SignaledElementMissing ? { status: 'CHANGED' } : { status: 'FAILED' };
}

/** 位置を表の鍵にするときの区切り。 */
const PATH_KEY_SEPARATOR = '/';


/**
 * 生成した値を入れる操作の一覧（入れられない値なら `VALUE_NOT_SUPPORTED`）。`form` は、入れる直前に読んだ form（checkbox・radio の選択肢と状態）。
 */
function inputOperationsOf(
  spec: WriteFormSpec,
  form: ReadForm,
  values: Readonly<Record<string, string | null>>,
): readonly InputOperation[] | null {
  const operations: InputOperation[] = [];
  for (const name of spec.submittedFieldNames) {
    if (!Object.hasOwn(values, name)) {
      return null;
    }
    const value = values[name];
    if (value !== null && typeof value !== 'string') {
      return null;
    }
    const controls = form.controls.filter((control) => control.name === name);
    const [first] = controls;
    if (first === undefined || controls.some((control) => control.path === null)) {
      return null;
    }
    const type = first.type as CandidateFieldType;
    if (type === 'checkbox') {
      if (value !== null && !controls.some((control) => control.optionValue === value)) {
        return null;
      }
      for (const control of controls) {
        const path = control.path ?? [];
        operations.push(control.optionValue === value
          ? async (locate, timeoutMs) => (await locate(path)).check({ timeout: timeoutMs })
          : async (locate, timeoutMs) => (await locate(path)).uncheck({ timeout: timeoutMs }));
      }
    } else if (type === 'radio') {
      if (value === null) {
        if (controls.some((control) => control.checked === true)) {
          return null;
        }
        continue;
      }
      const chosen = controls.find((control) => control.optionValue === value);
      if (chosen === undefined) {
        return null;
      }
      const path = chosen.path ?? [];
      operations.push(async (locate, timeoutMs) => (await locate(path)).check({ timeout: timeoutMs }));
    } else if (value === null) {
      return null;
    } else if (SELECT_TYPES.has(type)) {
      const path = first.path ?? [];
      operations.push(async (locate, timeoutMs) => (await locate(path)).selectOption([{ value }], { timeout: timeoutMs }));
    } else {
      const path = first.path ?? [];
      operations.push(async (locate, timeoutMs) => (await locate(path)).fill(value, { timeout: timeoutMs }));
    }
  }
  return operations;
}

/** 読み直した値が、生成した値のとおりか。 */
function valuesApplied(spec: WriteFormSpec, form: ReadForm, values: Readonly<Record<string, string | null>>): boolean {
  return spec.submittedFieldNames.every((name) => {
    const value = values[name] ?? null;
    const controls = form.controls.filter((control) => control.name === name);
    const [first] = controls;
    if (first === undefined) {
      return false;
    }
    const type = first.type as CandidateFieldType;
    if (CHECKABLE_TYPES.has(type)) {
      return controls.every((control) => control.checked === (value !== null && control.optionValue === value));
    }
    if (SELECT_TYPES.has(type)) {
      return value !== null && JSON.stringify(first.selected) === JSON.stringify([value]);
    }
    if (value === null || first.value === null) {
      return false;
    }
    return type === TEXTAREA_FIELD_TYPE ? lineFeedForm(first.value) === lineFeedForm(value) : first.value === value;
  });
}

/**
 * 送信の窓を開き、確かめ直して、生成した値を入れ、入れた後に確かめ直して値を読み直す（ファイルの先頭の説明の 2）。例外を投げない。
 */
export async function fillWriteForm(
  page: Page,
  form: InspectedWriteForm,
  values: Readonly<Record<string, string | null>>,
  monitor: WriteStageMonitor,
  timeoutMs = WRITE_FORM_STEP_TIMEOUT_MS,
): Promise<WriteFormStepResult> {
  const state = inspectedStates.get(form);
  if (state === undefined || !isRecord(values)) {
    return { ok: false, reason: 'SPEC_INVALID' };
  }
  try {
    // T40R-fix-A: 開くのは窓の観察の段（値を入れる間。承認の形の POST も通さずに止めて数える）。送信の段は、押す直前に `submitWriteForm` が開く。
    await monitor.openSubmissionWindow(page);
    windowMonitors.set(form, monitor);
    const before = await reinspect(page, state, timeoutMs);
    if (before === null) {
      return { ok: false, reason: 'FORM_CHANGED' };
    }
    // T31g-1: UPDATE は、入れる前に、書き込みの段の画面の値（変える欄を含む）が前の値と同じかを確かめる。
    if (state.update !== undefined && !matchesPrior(before.form, state.update.roles, state.update.prior, true)) {
      return { ok: false, reason: 'PRIOR_VALUE_CHANGED' };
    }
    const operations = inputOperationsOf(state.spec, before.form, values);
    if (operations === null) {
      return { ok: false, reason: 'VALUE_NOT_SUPPORTED' };
    }
    // T32R-fix-I1: 操作のたびに、合図つきの Locator で、位置の要素が確かめの時の要素かを照らす（入れ替わっていれば `FORM_CHANGED`）。
    const filled = await runOnTrackedElements(page, state, timeoutMs, async (locate) => {
      for (const operation of operations) {
        await operation(locate, timeoutMs);
      }
    });
    if (filled.status === 'CHANGED') {
      return { ok: false, reason: 'FORM_CHANGED' };
    }
    if (filled.status === 'FAILED') {
      // Playwright の誤りの文には値が入りうるので、捨てる。
      return { ok: false, reason: 'INPUT_FAILED' };
    }
    const after = await reinspect(page, state, timeoutMs);
    if (after === null) {
      return { ok: false, reason: 'FORM_CHANGED' };
    }
    if (state.update !== undefined && !matchesPrior(after.form, state.update.roles, state.update.prior, false)) {
      return { ok: false, reason: 'PRIOR_VALUE_CHANGED' };
    }
    return valuesApplied(state.spec, after.form, values) ? { ok: true } : { ok: false, reason: 'VALUE_NOT_APPLIED' };
  } catch {
    return { ok: false, reason: 'INPUT_FAILED' };
  }
}

/**
 * 押す直前に確かめ直し、値を読み直してから、決めた送信ボタンを押す（ファイルの先頭の説明の 3）。押した後のナビゲーションは待たない。例外を投げない。
 */
export async function submitWriteForm(
  page: Page,
  form: InspectedWriteForm,
  values: Readonly<Record<string, string | null>>,
  timeoutMs = WRITE_FORM_STEP_TIMEOUT_MS,
): Promise<WriteFormSubmission> {
  const state = inspectedStates.get(form);
  if (state === undefined || !isRecord(values)) {
    return { ok: false, reason: 'SPEC_INVALID', clickAttempted: false };
  }
  let checked: { readonly form: ReadForm; readonly layout: WriteFormLayout } | null;
  try {
    checked = await reinspect(page, state, timeoutMs);
  } catch {
    checked = null;
  }
  if (checked === null) {
    return { ok: false, reason: 'FORM_CHANGED', clickAttempted: false };
  }
  if (state.update !== undefined && !matchesPrior(checked.form, state.update.roles, state.update.prior, false)) {
    return { ok: false, reason: 'PRIOR_VALUE_CHANGED', clickAttempted: false };
  }
  if (!valuesApplied(state.spec, checked.form, values)) {
    return { ok: false, reason: 'VALUE_NOT_APPLIED', clickAttempted: false };
  }
  try {
    // T32R-fix-I1: 合図つきの Locator で、送信ボタンの位置の要素が確かめの時の要素かを照らしてから押す（入れ替わっていれば押さずに
    // `FORM_CHANGED`）。押す操作も、同じ合図つきのセレクタで要素を解き直す。
    const submitterPath = checked.layout.submitterPath;
    let clickAttempted = false;
    const clicked = await runOnTrackedElements(page, state, timeoutMs, async (locate) => {
      const submitter = await locate(submitterPath);
      // T40R-fix-A（Task 40 の設計書 7 章の T40R の I-1）: 押す直前に、値を入れたときの部品で送信の窓の送信の段を開く（Guard が承認の形の POST を照合に
      // かけて 1 回だけ通すのは、この後だけ）。開けなければ（窓が開いていない、値を入れていない）押さない。
      const monitor = windowMonitors.get(form);
      if (monitor === undefined || !monitor.openSubmissionPhase()) {
        throw new SignaledElementMissing();
      }
      clickAttempted = true;
      await submitter.click({ timeout: timeoutMs, noWaitAfter: true });
    });
    if (clicked.status === 'DONE') {
      return { ok: true, outcome: 'SUBMITTED' };
    }
    if (!clickAttempted) {
      return { ok: false, reason: 'FORM_CHANGED', clickAttempted: false };
    }
    // 押した後の失敗かもしれない（送信は分からない）。Playwright の誤りの文は捨てる。
    return { ok: false, reason: 'SUBMIT_FAILED', clickAttempted: true };
  } finally {
    // 押した（押そうとした）後は、この確かめの結果を使わない（同じ結果で 2 回押さない）。
    inspectedStates.delete(form);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// T31g-1: UPDATE の前と後の値の読み取り、照合の期待の作り手、入力の前の確かめ（ファイルの先頭の説明の 4）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 更新の form の指定（承認の要求の形と、承認した候補の欄と、欄の役割）。
 * - `changedFieldNames`: 変える欄の名前（1 つ以上。新しい値を入れる）。
 * - `keptFieldNames`: 保つ欄の名前（前の値のまま送る。触らない）。
 * 見えていて編集できる欄（名前ごと。組の名前は組の checkbox で決める）は、すべてどちらかに入れる。
 */
export interface WriteUpdateFormSpec {
  readonly endpoint: { readonly origin: string; readonly path: string };
  readonly enctype: WriteFormEnctype;
  readonly candidateFields: readonly WriteFormFieldSpec[];
  readonly methodOverride: WriteMethodOverride | null;
  readonly changedFieldNames: readonly string[];
  readonly keptFieldNames: readonly string[];
}

/**
 * 読んだ値（前の値・後の値。返すだけで記録しない）。
 * - `fields`: 変える欄と保つ欄の今の値（text 系・textarea は値、select は選んだ値、checkbox・radio はチェックした欄の値。組の名前は組の
 *   checkbox の値。どれもなければ null）。
 * - `stateHiddenValues`: 状態の名前の hidden の欄の値。
 * - `pairOffValues`: 組の hidden の値（役割を持つ組だけ）。
 * - `passthroughValues`（T31R-fix-1。C-1）: 値を照らすほかの hidden・readonly・見えない欄の値（秘密に見える名前の欄は読まない）。更新の後の照合では
 *   比べない（`lock_version` など、更新で変わってよい値）。
 * T31R2-fix-1（C-1）: `stateHiddenValues`・`passthroughValues` の null は、チェック・選択のない見えない checkbox・radio・select（送られない）。
 */
export interface UpdateFormValues {
  readonly fields: Readonly<Record<string, string | null>>;
  readonly stateHiddenValues: Readonly<Record<string, string | null>>;
  readonly pairOffValues: Readonly<Record<string, string>>;
  readonly passthroughValues: Readonly<Record<string, string | null>>;
}

export type UpdateFormRead =
  | { readonly ok: true; readonly values: UpdateFormValues }
  | { readonly ok: false; readonly reason: WriteFormReason };

/** UPDATE の送る中身の照合の期待のうち、欄の部分（`updatePayloadFieldsOf`。承認の要求の形は呼び出し側が足す）。 */
export type UpdatePayloadFields = Required<Pick<
  WritePayloadExpectation,
  'submittedFields' | 'passthroughFieldNames' | 'emptyFileFieldNames' | 'methodOverride' | 'absentFieldNames' | 'checkedPassthroughFields' | 'checkboxPairs'
>>;

export type UpdatePayloadFieldsResult =
  | { readonly ok: true; readonly fields: UpdatePayloadFields }
  | { readonly ok: false; readonly reason: UpdateSpecReason };

/**
 * UPDATE の指定から期待を作れない理由（T31g-1 fix round 1: 秘密に見える名前の状態の欄は、名前の分かる理由にした。T31R2-fix-1: ほかの秘密に
 * 見える名前の値を送る欄も）。
 */
type UpdateSpecReason = Extract<WriteFormReason, 'SPEC_INVALID' | 'SECRET_LIKE_STATE_FIELD' | 'SECRET_LIKE_PASSTHROUGH_FIELD'>;

/** 欄の役割（`updateRolesOf`。候補の欄から求める。値は持たない）。 */
interface UpdateRoles {
  readonly changed: readonly string[];
  readonly kept: readonly string[];
  /** 役割を持つ組の名前（組の checkbox が変える欄か保つ欄）。 */
  readonly pairNames: readonly string[];
  /** 値を照らす状態の名前の欄（hidden・見えない欄・readonly。名前ごとに 1 つの欄。秘密に見える名前の欄がある画面は受けない）。 */
  readonly stateHiddenNames: readonly string[];
  /** T31R-fix-1（C-1）: 値を照らすほかの hidden・readonly・見えない欄（状態の語でない。名前ごとに 1 つの欄）。 */
  readonly checkedPassthroughNames: readonly string[];
  /** 名前だけを照らす欄（T31R2-fix-1: ページが読み込みごとに作る値の名前の欄だけ）。 */
  readonly passthroughNames: readonly string[];
  readonly emptyFileNames: readonly string[];
  /** T31R2-fix-1（C-1）: 値を照らす欄（状態の名前の欄とほかの欄）の型（名前ごと。choice の型なら、値は null になりうる）。 */
  readonly concealedTypeOf: ReadonlyMap<string, CandidateFieldType>;
  /** T31R2-fix-1（C-1）: disabled の欄の名前（送られないことを照らす。候補の欄の順）。 */
  readonly absentNames: readonly string[];
  /** 名前ごとの、値を送る欄の型（変える欄と保つ欄。組の名前は checkbox）。 */
  readonly typeOf: ReadonlyMap<string, CandidateFieldType>;
}

/** 名前の一覧が、空でない文字列の重複のない一覧か。 */
const isNameList = (value: unknown): value is readonly string[] => Array.isArray(value)
  && (value as readonly unknown[]).every((name) => isString(name) && name.length > 0)
  && new Set(value as readonly unknown[]).size === value.length;

/** 値を送る欄 1 つとして送れるか（送れる型で、hidden の型・見えない・readonly・disabled でない）。 */
const isEditableField = (candidate: WriteFormFieldSpec): boolean => !isUnsendableFieldType(candidate.type) && candidate.type !== HIDDEN_FIELD_TYPE
  && !candidate.hidden && !candidate.readonly && !candidate.disabled;

/**
 * 欄の役割を、承認した候補の欄から求める（純粋。正しくない指定は理由。ファイルの先頭の説明の 4 の `updatePayloadFieldsOf`）。名前ごとの値を
 * 送る欄は、組の名前なら組の checkbox だけ、ほかは同じ名前の欄のすべて（`candidate-contracts.ts` の `writeFieldsOfName`）。
 */
function updateRolesOf(spec: WriteUpdateFormSpec): UpdateRoles | UpdateSpecReason {
  if (!isRecord(spec) || !isRecord(spec.endpoint) || !isString(spec.endpoint.origin) || !isString(spec.endpoint.path)
    || !(WRITE_FORM_ENCTYPES as readonly unknown[]).includes(spec.enctype)
    || (spec.methodOverride !== null && !(WRITE_METHOD_OVERRIDES as readonly unknown[]).includes(spec.methodOverride))
    || !isFieldSpecList(spec.candidateFields) || !isNameList(spec.changedFieldNames) || !isNameList(spec.keptFieldNames)
    || spec.changedFieldNames.length === 0) {
    return 'SPEC_INVALID';
  }
  const fields = spec.candidateFields;
  const roleNames = [...spec.changedFieldNames, ...spec.keptFieldNames];
  // T31R-fix-1（I-1）: 削除の語に当たる名前の欄（`classify.ts` の `fieldNameHasRemovalWord`。下書きの確かめの
  // `SCENARIO_REMOVAL_FIELD_NOT_CHANGEABLE` と共用）も、状態の欄と同じく変える欄にできない（`SPEC_INVALID`）。
  if (new Set(roleNames).size !== roleNames.length || roleNames.some(isMethodOverrideFieldName)
    || spec.changedFieldNames.some((name) => fieldNameHasStateWord(name) || fieldNameHasRemovalWord(name))) {
    return 'SPEC_INVALID';
  }
  // T31g-1 fix round 1: 状態の語に当たり、秘密に見える名前でもある、値を送る欄（disabled でない hidden・見えない欄・readonly）がある画面は、
  // 値を読めず照らせないので UPDATE を受けない（見える編集できる欄は、下の見える欄の決まりでも受けない）。T31e fix round 1: 判定は owner
  // （`src/discovery/read-check-contracts.ts` の `isSecretLikeStateField`。UPDATE の下書きの確かめと共用）。
  if (fields.some(isSecretLikeStateField)) {
    return 'SECRET_LIKE_STATE_FIELD';
  }
  // T31R2-fix-1（C-1）: ページが作る値の名前でない、秘密に見える名前の値を送る欄（hidden・見えない欄・readonly）がある画面も、値を読めず照らせない
  // ので UPDATE を受けない（登録と同じ判定 `isUnreadableSecretField`）。
  if (fields.some(isUnreadableSecretField)) {
    return 'SECRET_LIKE_PASSTHROUGH_FIELD';
  }
  // 秘密に見える名前の見える欄がある画面は、値を読めないので UPDATE を受けない（下書きの確かめの `SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD`）。
  if (fields.some((candidate) => candidate.name.length > 0 && !candidate.hidden && candidate.type !== HIDDEN_FIELD_TYPE
    && isSecretUrlQueryParameterName(candidate.name))) {
    return 'SPEC_INVALID';
  }
  const pairs = checkboxHiddenPairsOf(fields);
  const editableTypeOf = (name: string): CandidateFieldType | null => {
    const sending = writeFieldsOfName(fields, name);
    const [first] = sending;
    if (first === undefined || isMethodOverrideFieldName(name) || !sending.every((candidate) => candidate.type === first.type && isEditableField(candidate))) {
      return null;
    }
    return CHECKABLE_TYPES.has(first.type) || sending.length === 1 ? first.type : null;
  };
  const typeOf = new Map<string, CandidateFieldType>();
  for (const name of roleNames) {
    const type = editableTypeOf(name);
    if (type === null) {
      return 'SPEC_INVALID';
    }
    typeOf.set(name, type);
  }
  // 見えていて編集できる欄（名前ごと）は、すべて役割を持つ。
  const names = [...new Set(fields.map((candidate) => candidate.name).filter((name) => name.length > 0))];
  if (names.some((name) => editableTypeOf(name) !== null && !typeOf.has(name))) {
    return 'SPEC_INVALID';
  }
  const pairNames = pairs.map(({ name }) => name).filter((name) => typeOf.has(name));
  const pairHiddenIndexes = new Set(pairs.filter(({ name }) => typeOf.has(name)).map(({ hiddenIndex }) => hiddenIndex));
  const pairCheckboxIndexes = new Set(pairs.map(({ checkboxIndex }) => checkboxIndex));
  const stateHiddenNames: string[] = [];
  const checkedPassthroughNames: string[] = [];
  const passthroughNames: string[] = [];
  const emptyFileNames: string[] = [];
  const absentNames: string[] = [];
  const concealedTypeOf = new Map<string, CandidateFieldType>();
  for (const [index, candidate] of fields.entries()) {
    if (candidate.name.length === 0 || isMethodOverrideFieldName(candidate.name) || typeOf.has(candidate.name) || pairHiddenIndexes.has(index)) {
      continue;
    }
    const role = unsubmittedFieldRoleOf(candidate, pairCheckboxIndexes.has(index));
    if (role === 'CHECKED_PASSTHROUGH' || role === 'CHECKED_CHOICE') {
      // 秘密に見える名前の欄は、上で受けていない。T31R-fix-1（C-1）: 状態の語でない欄も値を照らす。T31R2-fix-1: 見えない choice も（同じ名前の
      // 欄は同じ型。radio・checkbox の組は名前 1 つ）。
      const names = fieldNameHasStateWord(candidate.name) ? stateHiddenNames : checkedPassthroughNames;
      if ((concealedTypeOf.get(candidate.name) ?? candidate.type) !== candidate.type) {
        return 'SPEC_INVALID';
      }
      concealedTypeOf.set(candidate.name, candidate.type);
      if (!names.includes(candidate.name)) {
        names.push(candidate.name);
      }
    } else if (role === 'PASSTHROUGH') {
      passthroughNames.push(candidate.name);
    } else if (role === 'EMPTY_FILE') {
      emptyFileNames.push(candidate.name);
    } else if (role === 'DISABLED') {
      absentNames.push(candidate.name);
    } else if (role !== 'NOT_SENT') {
      // 役割のない、見えていて送られる欄（同じ名前の hidden と text など）と、値を照らせない形の見えない欄（select-multiple・password）。期待を
      // 作れない。
      return 'SPEC_INVALID';
    }
  }
  // 値を照らす欄は、名前ごとに 1 つの欄だけ（照合は、その名前の欄がちょうど 1 つであることを求める）。T31R2-fix-1: checkbox・radio は、同じ名前・
  // 同じ型の欄の組でよい（チェックした欄の値を読む）。
  if ([...stateHiddenNames, ...checkedPassthroughNames].some((name) => {
    const named = fields.filter((candidate) => candidate.name === name);
    const type = concealedTypeOf.get(name);
    return type === undefined || !named.every((candidate) => candidate.type === type) || (!CHECKABLE_TYPES.has(type) && named.length !== 1);
  })) {
    return 'SPEC_INVALID';
  }
  const uniquePassthrough = [...new Set(passthroughNames)];
  const uniqueEmptyFile = [...new Set(emptyFileNames)];
  const uniqueAbsent = [...new Set(absentNames)];
  const all = [...roleNames, ...stateHiddenNames, ...checkedPassthroughNames, ...uniquePassthrough, ...uniqueEmptyFile, ...uniqueAbsent];
  if (new Set(all).size !== all.length) {
    return 'SPEC_INVALID';
  }
  return {
    changed: Object.freeze([...spec.changedFieldNames]),
    kept: Object.freeze([...spec.keptFieldNames]),
    pairNames: Object.freeze(pairNames),
    stateHiddenNames: Object.freeze(stateHiddenNames),
    checkedPassthroughNames: Object.freeze(checkedPassthroughNames),
    passthroughNames: Object.freeze(uniquePassthrough),
    emptyFileNames: Object.freeze(uniqueEmptyFile),
    concealedTypeOf,
    absentNames: Object.freeze(uniqueAbsent),
    typeOf,
  };
}

/** 確かめと入力の部品に渡す form の指定（送る欄は変える欄。form を決めるのと、入れる欄に使う）。 */
const formSpecOf = (spec: WriteUpdateFormSpec): WriteFormSpec => ({
  endpoint: spec.endpoint,
  enctype: spec.enctype,
  candidateFields: spec.candidateFields,
  submittedFieldNames: spec.changedFieldNames,
  methodOverride: spec.methodOverride,
});

/** 値を読む欄の名前（変える欄と保つ欄、状態の hidden と組の hidden）。 */
function valueReadNamesOf(roles: UpdateRoles): ValueReadNames {
  return {
    valueNames: [...roles.changed, ...roles.kept],
    hiddenValueNames: [...roles.stateHiddenNames, ...roles.pairNames, ...roles.checkedPassthroughNames],
  };
}

/** 組の hidden と checkbox が、form の欄の順で隣り合うか（役割を持つ組ごと。hidden がちょうど 1 つで、そのすぐ後が同じ名前の checkbox）。 */
function pairsAdjacent(form: ReadForm, roles: UpdateRoles): boolean {
  return roles.pairNames.every((name) => {
    const hiddenIndexes = form.controls.flatMap((control, index) => (control.name === name && control.type === HIDDEN_FIELD_TYPE ? [index] : []));
    const [hiddenIndex] = hiddenIndexes;
    const next = hiddenIndex === undefined ? undefined : form.controls[hiddenIndex + 1];
    return hiddenIndexes.length === 1 && next !== undefined && next.name === name && next.type === 'checkbox';
  });
}

type ReadValues = { readonly ok: true; readonly values: UpdateFormValues } | { readonly ok: false; readonly reason: WriteFormReason };

/** 読んだ form から、役割の欄の値を取り出す（ファイルの先頭の説明の 4 の `readUpdateFormValues`）。 */
function updateValuesOf(form: ReadForm, roles: UpdateRoles): ReadValues {
  const fields = concealedValuesOf(form, [...roles.changed, ...roles.kept], roles.typeOf);
  if (!fields.ok) {
    return fields;
  }
  const hiddenValueOf = (name: string): string | null => {
    const controls = form.controls.filter((control) => control.name === name && control.type === HIDDEN_FIELD_TYPE);
    const [only] = controls;
    return controls.length === 1 && only !== undefined ? only.value : null;
  };
  const hiddenValuesOf = (names: readonly string[]): Record<string, string> | null => {
    const read: Record<string, string> = {};
    for (const name of names) {
      const value = hiddenValueOf(name);
      if (value === null) {
        return null;
      }
      read[name] = value;
    }
    return read;
  };
  // T31R-fix-1（C-1）: 状態の名前の欄と、値を照らすほかの欄は、値を読んだ欄（hidden・readonly の text 系など）がちょうど 1 つ。T31R2-fix-1:
  // 見えない checkbox・radio・select は、チェック・選択した値（なければ null）。
  const stateHiddenValues = concealedValuesOf(form, roles.stateHiddenNames, roles.concealedTypeOf);
  if (!stateHiddenValues.ok) {
    return stateHiddenValues;
  }
  const passthroughValues = concealedValuesOf(form, roles.checkedPassthroughNames, roles.concealedTypeOf);
  if (!passthroughValues.ok) {
    return passthroughValues;
  }
  const pairOffValues = hiddenValuesOf(roles.pairNames);
  if (pairOffValues === null) {
    return { ok: false, reason: 'FORM_UNREADABLE' };
  }
  return {
    ok: true,
    values: Object.freeze({
      fields: fields.values,
      stateHiddenValues: stateHiddenValues.values,
      pairOffValues: Object.freeze(pairOffValues),
      passthroughValues: passthroughValues.values,
    }),
  };
}

/**
 * 2 つの値が同じか（T39d で `form-submission-common.ts` に移した唯一の比べ方を、今の参照先（ワーカーの書き込みの流れ）のために公開し直す）。
 */
export { sameValue };

/** 前の値の形が、役割の欄のとおりか（変える欄と保つ欄、状態の hidden、組の hidden のすべての値がある）。 */
function isPriorOf(prior: unknown, roles: UpdateRoles): prior is UpdateFormValues {
  if (!isRecord(prior) || !isRecord(prior['fields']) || !isRecord(prior['stateHiddenValues']) || !isRecord(prior['pairOffValues'])
    || !isRecord(prior['passthroughValues'])) {
    return false;
  }
  const fields = prior['fields'];
  const stateHidden = prior['stateHiddenValues'];
  const pairOff = prior['pairOffValues'];
  const passthrough = prior['passthroughValues'];
  // T31R2-fix-1（C-1）: 値を照らす欄の null は、choice（見えない checkbox・radio・select）だけ。
  const concealedValueValid = (values: Readonly<Record<string, unknown>>, name: string): boolean => Object.hasOwn(values, name)
    && (isString(values[name]) || (values[name] === null && isChoiceType(roles.concealedTypeOf.get(name))));
  return [...roles.changed, ...roles.kept].every((name) => Object.hasOwn(fields, name) && isNullableString(fields[name]))
    && roles.stateHiddenNames.every((name) => concealedValueValid(stateHidden, name))
    && roles.pairNames.every((name) => Object.hasOwn(pairOff, name) && isString(pairOff[name]))
    && roles.checkedPassthroughNames.every((name) => concealedValueValid(passthrough, name));
}

/**
 * 読んだ form の値が前の値と同じか（`includeChanged` が偽なら、変える欄を比べない。入れた後と押す直前）。読めなければ偽。
 */
function matchesPrior(form: ReadForm, roles: UpdateRoles, prior: UpdateFormValues, includeChanged: boolean): boolean {
  const current = updateValuesOf(form, roles);
  if (!current.ok) {
    return false;
  }
  const { values } = current;
  return [...(includeChanged ? roles.changed : []), ...roles.kept].every((name) => sameValue(values.fields[name] ?? null, prior.fields[name] ?? null))
    && roles.stateHiddenNames.every((name) => sameValue(values.stateHiddenValues[name] ?? null, prior.stateHiddenValues[name] ?? null))
    && roles.pairNames.every((name) => sameValue(values.pairOffValues[name] ?? null, prior.pairOffValues[name] ?? null))
    // T31R-fix-1（C-1）: 値を照らすほかの欄も、書き込みの段の画面で前の値のままか。
    && roles.checkedPassthroughNames.every((name) => sameValue(values.passthroughValues[name] ?? null, prior.passthroughValues[name] ?? null));
}

/**
 * 前の値・後の値を読む（ファイルの先頭の説明の 4）。読むのは、変える欄と保つ欄、状態の名前の hidden、組の hidden の値だけ。例外を投げない。
 */
export async function readUpdateFormValues(page: Page, spec: WriteUpdateFormSpec, timeoutMs = WRITE_FORM_STEP_TIMEOUT_MS): Promise<UpdateFormRead> {
  try {
    const roles = updateRolesOf(spec);
    if (typeof roles === 'string') {
      return { ok: false, reason: roles };
    }
    const decision = await readAndDecide(page, formSpecOf(spec), timeoutMs, valueReadNamesOf(roles));
    if (!decision.ok) {
      return decision;
    }
    if (!pairsAdjacent(decision.form, roles)) {
      return { ok: false, reason: 'CHECKBOX_PAIR_NOT_ADJACENT' };
    }
    return updateValuesOf(decision.form, roles);
  } catch {
    return { ok: false, reason: 'FORM_UNREADABLE' };
  }
}

/**
 * UPDATE の送る中身の照合の期待のうち欄の部分（ファイルの先頭の説明の 4。純粋。凍結）。`prior` は前の値（`readUpdateFormValues`）、`values` は
 * 変える欄の新しい値（変える欄の名前をちょうど持つ。null は checkbox を外す・radio を選ばない）。作れなければ `SPEC_INVALID`。
 */
export function updatePayloadFieldsOf(
  spec: WriteUpdateFormSpec,
  prior: UpdateFormValues,
  values: Readonly<Record<string, string | null>>,
): UpdatePayloadFieldsResult {
  const invalid: UpdatePayloadFieldsResult = { ok: false, reason: 'SPEC_INVALID' };
  const roles = updateRolesOf(spec);
  if (typeof roles === 'string') {
    return { ok: false, reason: roles };
  }
  if (!isPriorOf(prior, roles) || !isRecord(values)) {
    return invalid;
  }
  const valueNames = Object.keys(values);
  if (valueNames.length !== roles.changed.length || !roles.changed.every((name) => Object.hasOwn(values, name) && isNullableString(values[name]))) {
    return invalid;
  }
  const submittedFields: WriteSubmittedField[] = [];
  const absentFieldNames: string[] = [];
  const checkboxPairs: WriteCheckboxPair[] = [];
  const place = (name: string, value: string | null): boolean => {
    const type = roles.typeOf.get(name);
    if (roles.pairNames.includes(name)) {
      const offValue = prior.pairOffValues[name];
      if (offValue === undefined) {
        return false;
      }
      checkboxPairs.push(Object.freeze({ name, offValue, checkedValue: value }));
      return true;
    }
    if (value === null) {
      // ブラウザが送らない欄だけ（チェックしていない checkbox、選んでいない radio、選んでいない select）。text 系は空の値で送られる。
      if (type === undefined || !(CHECKABLE_TYPES.has(type) || SELECT_TYPES.has(type))) {
        return false;
      }
      absentFieldNames.push(name);
      return true;
    }
    submittedFields.push(Object.freeze({ name, value }));
    return true;
  };
  const changedPlaced = roles.changed.every((name) => {
    const value = values[name] ?? null;
    // 変える select・text 系は、新しい値が要る（null は checkbox・radio だけ）。
    const type = roles.typeOf.get(name);
    return (value !== null || (type !== undefined && CHECKABLE_TYPES.has(type))) && place(name, value);
  });
  if (!changedPlaced || !roles.kept.every((name) => place(name, prior.fields[name] ?? null))) {
    return invalid;
  }
  // T31R-fix-1（C-1）: 値を照らすほかの hidden・readonly・見えない欄も、前の値で照らす。T31R2-fix-1: 前の値が null の choice は「送られない」
  // （disabled の欄の後ろ）。
  const concealedPrior: readonly (readonly [string, string | null])[] = [
    ...roles.stateHiddenNames.map((name) => [name, prior.stateHiddenValues[name] ?? null] as const),
    ...roles.checkedPassthroughNames.map((name) => [name, prior.passthroughValues[name] ?? null] as const),
  ];
  const checkedPassthroughFields = concealedPrior.flatMap(([name, value]) => (value === null ? [] : [Object.freeze({ name, value })]));
  absentFieldNames.push(...roles.absentNames, ...concealedPrior.flatMap(([name, value]) => (value === null ? [name] : [])));
  const lists = [
    submittedFields.map(({ name }) => name),
    roles.passthroughNames,
    roles.emptyFileNames,
    checkedPassthroughFields.map(({ name }) => name),
    checkboxPairs.map(({ name }) => name),
    absentFieldNames,
  ].flat();
  if (new Set(lists).size !== lists.length || lists.some(isMethodOverrideFieldName)) {
    return invalid;
  }
  return {
    ok: true,
    fields: Object.freeze({
      submittedFields: Object.freeze(submittedFields),
      passthroughFieldNames: roles.passthroughNames,
      emptyFileFieldNames: roles.emptyFileNames,
      methodOverride: spec.methodOverride,
      absentFieldNames: Object.freeze(absentFieldNames),
      checkedPassthroughFields: Object.freeze(checkedPassthroughFields),
      checkboxPairs: Object.freeze(checkboxPairs),
    }),
  };
}

/**
 * UPDATE の送る前の確かめ（ファイルの先頭の説明の 1 と 4）。1 の確かめに加えて、組が隣り合うこと、書き込みの段の画面の値が前の値と同じこと
 * （`PRIOR_VALUE_CHANGED`）を確かめる。通れば、`fillWriteForm`・`submitWriteForm` に渡す確かめの結果を返す（入れるのは変える欄だけ。返す名前の
 * 一覧は照合に使わない。照合の期待は `updatePayloadFieldsOf`）。例外を投げない。
 */
export async function inspectUpdateForm(
  page: Page,
  spec: WriteUpdateFormSpec,
  prior: UpdateFormValues,
  timeoutMs = WRITE_FORM_STEP_TIMEOUT_MS,
): Promise<WriteFormInspection> {
  try {
    const roles = updateRolesOf(spec);
    if (typeof roles === 'string') {
      return { ok: false, reason: roles };
    }
    if (!isPriorOf(prior, roles)) {
      return { ok: false, reason: 'SPEC_INVALID' };
    }
    const formSpec = formSpecOf(spec);
    const decision = await readAndDecide(page, formSpec, timeoutMs, valueReadNamesOf(roles));
    if (!decision.ok) {
      return decision;
    }
    if (!pairsAdjacent(decision.form, roles)) {
      return { ok: false, reason: 'CHECKBOX_PAIR_NOT_ADJACENT' };
    }
    const current = updateValuesOf(decision.form, roles);
    if (!current.ok) {
      return current;
    }
    if (!matchesPrior(decision.form, roles, prior, true)) {
      return { ok: false, reason: 'PRIOR_VALUE_CHANGED' };
    }
    let elements: InspectedState['elements'];
    try {
      elements = await trackedElementsOf(page, trackedPathsOf(formSpec, decision.layout), timeoutMs);
    } catch {
      return { ok: false, reason: 'FORM_UNREADABLE' };
    }
    const form: InspectedWriteForm = Object.freeze({
      passthroughFieldNames: roles.passthroughNames,
      emptyFileFieldNames: roles.emptyFileNames,
      methodOverride: spec.methodOverride,
      emptyValueFieldNames: Object.freeze([]),
      absentFieldNames: Object.freeze([]),
      checkedPassthroughFieldNames: Object.freeze([...roles.stateHiddenNames, ...roles.checkedPassthroughNames]),
    });
    inspectedStates.set(form, { spec: formSpec, signature: signatureOf(decision.layout), elements, update: { roles, prior } });
    return { ok: true, form };
  } catch {
    return { ok: false, reason: 'FORM_UNREADABLE' };
  }
}

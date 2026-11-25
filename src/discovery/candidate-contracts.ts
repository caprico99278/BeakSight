// 副作用のない操作の候補（発見の候補）の契約の SSOT（Task 27 の設計書 4.1、4.3、4.4。T27a）。
// - 閉じた一覧は `as const` の凍結した配列として 1 回だけ定義し、TypeScript の型はその配列から導く（`src/control/contracts.ts` と同じ方式）。
// - JSON Schema（`schemas/control/candidate.schema.json`。成果物 `discovery.json` の候補の形）の enum は、ここの配列と一致する
//   （`tests/unit/schema-enum-consistency.test.ts`）。上限は、ここの名前つきの定数と一致する（`tests/unit/discovery-candidate-schema.test.ts`）。
// - 値は持たない: 入力の値、CSRF のトークン、hidden の値、選択肢の label の項目を作らない。`_method` は閉じた一覧の値だけを持つ。
//   送信ボタンの文言も持たない（T27R-fix-1。DEF-086。表の行の中身を写さないため）。文言が当たった、送信ボタンの語の閉じた一覧の語だけを持つ。
// - 純粋な定義だけのファイル。Playwright、ブラウザ、`node:fs`、`src/control/`、監査エンジンを import しない（`src/control/`（T27c）と
//   ワーカーから import できるようにするため。`tests/architecture/discovery-boundary.test.ts`）。
// - CCX-12（CC-076）: `_method` の欄の名前の判定（`isMethodOverrideFieldName`）と、実際の method の式（`effectiveFormMethodOf`）は、この
//   ファイルだけに書く（発見の分類とシナリオの下書きの確かめが共用する。`tests/architecture/core-small-parts-ownership.test.ts` の (f)）。
import { CANDIDATE_FIELD_TYPES, CONTACT_CANDIDATE_FIELD_TYPES, type CandidateFieldType } from '../core/candidate-field-types.js';
import { foldNfkcCase } from '../core/text.js';
import type { SubmissionProbeOpener, SubmissionProbeRecord } from './submission-probe-contracts.js';

/**
 * 候補の種類（設計書 4.1）。`FORM` は form の送信ボタン 1 つ（ボタンがなければ form）ごと、`BUTTON` はボタンの役割の要素のうち送信ボタンで
 * ないもの（form の外のボタンと、T27b round 1 で足した form の中の送信ボタンでないボタン（`type=button`・`reset`、`role=button`））。
 * このファイルの「form の外のボタン」は、`BUTTON` の候補を指す（form の中のボタンの祖先には、その form も入る）。
 */
export const CANDIDATE_KINDS = Object.freeze(['FORM', 'BUTTON'] as const);
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

/**
 * 候補の分類（設計書 4.3）。`NEEDS_BINDING`・`DISPLAY_ONLY`・`NOT_EXECUTABLE` は、どの Task でも実行の権限を持たない。
 * `CREATE`・`UPDATE` は、この Task では表示だけ（実行は Task 28 以降）。
 */
export const CANDIDATE_CLASSIFICATIONS = Object.freeze([
  'READ',
  'CREATE',
  'UPDATE',
  'NOT_EXECUTABLE',
  'NEEDS_BINDING',
  'UNSUPPORTED_READ_TRANSPORT',
  'BLOCKED_EXTERNAL',
  'DISPLAY_ONLY',
] as const);
export type CandidateClassification = (typeof CANDIDATE_CLASSIFICATIONS)[number];

/**
 * 読み取りの候補の分類（PRE42-CC 組 4。N4-8e）。READ の確かめの対象にできる分類は、これだけ。保存の確かめ（`src/control/read-check-policy.ts`）と、
 * READ の確かめの評価（`read-check-evaluation.ts`）が読む（`tests/architecture/read-check-ssot.test.ts` の (d)）。
 */
export const READ_CANDIDATE_CLASSIFICATION = 'READ' satisfies CandidateClassification;

/** 分類の理由のコード（閉じた一覧。設計書 4.3 の表の各段）。分類との対応は `CANDIDATE_REASON_CLASSIFICATIONS`。 */
export const CANDIDATE_REASON_CODES = Object.freeze([
  // 1: 送信先が許可 Origin の外（解析できない Origin を含む）。
  'ACTION_OUTSIDE_ALLOWED_ORIGINS',
  // 2: 実際の method が DELETE、または危険な語（送信ボタンの語、送信先の path、query の名前、GET の form の欄の名前）、または GET の form の
  //    `_method` の欄（型を問わない。T27R-fix-1。DEF-088）。
  'DESTRUCTIVE',
  // 3: GET。password の欄を持つ GET と multipart の GET は扱えない読み取り。
  'READ_GET_FORM',
  'GET_WITH_PASSWORD_FIELD',
  'GET_WITH_MULTIPART',
  // 4: POST の検索と、`/graphql` への POST。
  'POST_SEARCH',
  'GRAPHQL_ENDPOINT',
  // 5: JS の結び付き（要素の listener か inline の処理）と、委譲（document・window・祖先の、押す・送る listener）。
  'JS_BOUND',
  'JS_DELEGATED',
  // 5 の後: listener のない form の外のボタン、`dialog` の form、値が閉じた一覧に当たらない `_method`（実際の method が決まらない）。
  'NO_KNOWN_ACTION',
  'DIALOG_METHOD',
  'METHOD_OVERRIDE_UNRECOGNIZED',
  // 6: PATCH・PUT、または更新の語。
  'UPDATE_METHOD',
  'UPDATE_WORD',
  // 7: 登録の語。
  'CREATE_WORD',
  // 8: それ以外。
  'UNCLASSIFIED',
  // 表の外（T27d。設計書の変更履歴「T27b・T27c の報告と T27d の前の判断」の (4)）: 同じジョブの中で、同じ識別の digest で中身（規則の
  // digest・分類・理由・状態の欄の印）の違う候補を 1 件にまとめた（`src/discovery/discovery-result.ts` の `mergeDiscoveryCandidates`）。
  'DUPLICATE_IDENTITY_CONFLICT',
] as const);
export type CandidateReasonCode = (typeof CANDIDATE_REASON_CODES)[number];

/** 理由のコードごとの分類（1 つのコードは 1 つの分類だけ）。 */
export const CANDIDATE_REASON_CLASSIFICATIONS: Readonly<Record<CandidateReasonCode, CandidateClassification>> = Object.freeze({
  ACTION_OUTSIDE_ALLOWED_ORIGINS: 'BLOCKED_EXTERNAL',
  DESTRUCTIVE: 'NOT_EXECUTABLE',
  READ_GET_FORM: 'READ',
  GET_WITH_PASSWORD_FIELD: 'UNSUPPORTED_READ_TRANSPORT',
  GET_WITH_MULTIPART: 'UNSUPPORTED_READ_TRANSPORT',
  POST_SEARCH: 'UNSUPPORTED_READ_TRANSPORT',
  GRAPHQL_ENDPOINT: 'UNSUPPORTED_READ_TRANSPORT',
  JS_BOUND: 'NEEDS_BINDING',
  JS_DELEGATED: 'NEEDS_BINDING',
  NO_KNOWN_ACTION: 'DISPLAY_ONLY',
  DIALOG_METHOD: 'DISPLAY_ONLY',
  METHOD_OVERRIDE_UNRECOGNIZED: 'DISPLAY_ONLY',
  UPDATE_METHOD: 'UPDATE',
  UPDATE_WORD: 'UPDATE',
  CREATE_WORD: 'CREATE',
  UNCLASSIFIED: 'DISPLAY_ONLY',
  DUPLICATE_IDENTITY_CONFLICT: 'DISPLAY_ONLY',
});

/**
 * form の method（HTML の `method` の属性の正規の値を大文字にしたもの）。送信ボタンの `formmethod` があれば、その値（probe が入れる。T27b）。
 * form の外のボタンは null。
 */
export const FORM_METHODS = Object.freeze(['GET', 'POST', 'DIALOG'] as const);
export type FormMethod = (typeof FORM_METHODS)[number];

/** `_method` の hidden の欄で上書きする method の閉じた一覧（設計書 4.1。この値だけを持つ。ほかの値は null として持つ）。 */
export const METHOD_OVERRIDE_VALUES = Object.freeze(['PUT', 'PATCH', 'DELETE'] as const);
export type MethodOverride = (typeof METHOD_OVERRIDE_VALUES)[number];

/** method を上書きする hidden の欄の名前（大文字と小文字を区別しない）。 */
export const METHOD_OVERRIDE_FIELD_NAME = '_method';

/**
 * 欄の名前が `_method` の欄か（NFKC と大文字小文字の畳み込み（`foldNfkcCase`）で比べる。型を問わない）。発見の分類（`classify.ts`）と
 * シナリオの下書きの確かめ（`src/control/approval/scenario-policy.ts`）が共用する（CC-076。CCX-12）。
 */
export const isMethodOverrideFieldName = (name: string): boolean => foldNfkcCase(name) === METHOD_OVERRIDE_FIELD_NAME;

/**
 * 実際の method（POST の form だけ、`_method` の上書きを反映する。GET・DIALOG の form の上書きは反映しない。form の外のボタンは null）
 * （CC-076。CCX-12）。
 */
export const effectiveFormMethodOf = (
  candidate: Pick<DiscoveredCandidate, 'formMethod' | 'methodOverride'>,
): FormMethod | MethodOverride | null =>
  (candidate.formMethod === 'POST' && candidate.methodOverride !== null ? candidate.methodOverride : candidate.formMethod);

/** form の enctype（HTML の `enctype` の正規の値。送信ボタンの `formenctype` があれば、その値）。form の外のボタンは null。 */
export const FORM_ENCTYPES = Object.freeze([
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
] as const);
export type FormEnctype = (typeof FORM_ENCTYPES)[number];

/** 入力の欄の要素の名前（送信ボタンは欄に含めない）。 */
export const CANDIDATE_FIELD_TAGS = Object.freeze(['input', 'select', 'textarea'] as const);
export type CandidateFieldTag = (typeof CANDIDATE_FIELD_TAGS)[number];

/**
 * 入力の欄の型。`input` は HTML の `type` の正規の値（未知の値は、ブラウザが `text` として扱う）。送信ボタンとリセット
 * （`submit`・`image`・`reset`・`button`）は欄に含めない。`select` は `select-one`・`select-multiple`、`textarea` は `textarea`。
 * PRE42-CC 組 UI-K2（CC-113）: 一覧の定義は、画面のブラウザ側からも読める純粋なファイル `src/core/candidate-field-types.ts` に移し、ここは同じ名前で
 * 公開し直す（連絡先の欄の型 `CONTACT_CANDIDATE_FIELD_TYPES` も）。
 */
export { CANDIDATE_FIELD_TYPES, CONTACT_CANDIDATE_FIELD_TYPES, type CandidateFieldType };

/**
 * 値を送れない欄の型（閉じた一覧。DEF-094）: `password`（秘密）と `file`（ファイルの中身）。名前が秘密に見えなくても、この型の欄には値を
 * 送らない。シナリオの送る欄の確かめ（`src/control/approval/scenario-policy.ts`）が使う。
 */
export const UNSENDABLE_FIELD_TYPES = Object.freeze(['password', 'file'] as const satisfies readonly CandidateFieldType[]);

/** 値を送れない型（`UNSENDABLE_FIELD_TYPES`）の欄か（DEF-094）。 */
export const isUnsendableFieldType = (type: CandidateFieldType): boolean =>
  (UNSENDABLE_FIELD_TYPES as readonly CandidateFieldType[]).includes(type);

/**
 * select の欄の型（閉じた一覧。T30f fix round 2）。書き込みの入力の部品（`src/browser/write-form-submitter.ts`）が使い、下の 2 つの一覧の元になる。
 * 同じ一覧を書き写さない（`tests/architecture/field-type-lists-ownership.test.ts`）。
 */
export const SELECT_FIELD_TYPES = Object.freeze(['select-one', 'select-multiple'] as const satisfies readonly CandidateFieldType[]);

/**
 * REV-RCA の M-5（検索の確かめの設計書 2.1・2.2）: 検索の確かめで決まった値（空・「a」・「あ」）を入れ、打つだけの検索を探す文字の欄の型（閉じた一覧の唯一の置き場）。
 * 組の作り手（`search-check-plan.ts`）と押下の部品（`submission-probe.ts`）が使う。
 */
export const SEARCH_TEXT_FIELD_TYPES = Object.freeze(['text', 'search', 'textarea'] as const satisfies readonly CandidateFieldType[]);

/**
 * 既定の値が分からない欄の型（閉じた一覧。T30f fix round 1・2。DEF-098）: 送る欄に選ばなくても、ブラウザがページの決めた既定の値で送る欄（select と、
 * 空にならない range・color）。書き込みの入力の部品は、送る欄に選ばなければ送らない（`SPEC_INVALID`）。シナリオの下書きの確かめ
 * （`src/control/approval/scenario-policy.ts`）は、CREATE で送る欄に選ばなければ受けない（`SCENARIO_CREATE_DEFAULT_VALUE_FIELD_NOT_SENT`）。
 * 両方がこの一覧を使う（承認できても実行で必ず送らないシナリオを作らせない）。
 */
export const DEFAULT_VALUE_FIELD_TYPES = Object.freeze([...SELECT_FIELD_TYPES, 'range', 'color'] as const satisfies readonly CandidateFieldType[]);

/** 既定の値が分からない型（`DEFAULT_VALUE_FIELD_TYPES`）の欄か。 */
export const isDefaultValueFieldType = (type: CandidateFieldType): boolean =>
  (DEFAULT_VALUE_FIELD_TYPES as readonly CandidateFieldType[]).includes(type);

/** 選択の欄の型（閉じた一覧。select と checkbox・radio）。入力の規則の汎用の選択（`business-templates.ts`）と欄の評価（`field-evaluation.ts`）が使う。 */
export const CHOICE_FIELD_TYPES = Object.freeze([...SELECT_FIELD_TYPES, 'radio', 'checkbox'] as const satisfies readonly CandidateFieldType[]);

/** hidden の欄の型（ページが値を決める欄。BeakSight は値を入れない）。 */
const HIDDEN_FIELD_TYPE: CandidateFieldType = 'hidden';

/**
 * 値を入れて送れる欄の型（CCX-20。T30f fix round 2 の発見事項 2）: 候補の欄の型（`CANDIDATE_FIELD_TYPES`）から、値を送れない型
 * （`UNSENDABLE_FIELD_TYPES`。password・file）と hidden を除いたもの（候補の欄の型の順）。入力の規則の人の固定の一覧で値を入れられる型
 * （`business-templates.ts` の `FIXED_LIST`・`OUT_OF_TEMPLATE`）が使う。同じ一覧を書き写さない（`tests/architecture/field-type-lists-ownership.test.ts`）。
 */
export const VALUE_INPUT_FIELD_TYPES: readonly CandidateFieldType[] = Object.freeze(
  CANDIDATE_FIELD_TYPES.filter((type) => !isUnsendableFieldType(type) && type !== HIDDEN_FIELD_TYPE),
);

/** 入力の欄の制約の属性の名前（属性の文字列をそのまま持つ。属性がなければ null）。 */
export const FIELD_CONSTRAINT_NAMES = Object.freeze([
  'pattern',
  'min',
  'max',
  'step',
  'minlength',
  'maxlength',
  'autocomplete',
] as const);
export type FieldConstraintName = (typeof FIELD_CONSTRAINT_NAMES)[number];

/**
 * JS の結び付きとして記録する listener の種類（閉じた一覧。CDP の `DOMDebugger.getEventListeners` の `type` のうち、送信や操作に
 * 結び付きうるもの。ほかの種類（`focus`、`scroll` など）は記録しない）。
 */
export const LISTENER_KINDS = Object.freeze([
  'click',
  'dblclick',
  'auxclick',
  'submit',
  'formdata',
  'keydown',
  'keyup',
  'keypress',
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'touchstart',
  'touchend',
  'change',
  'input',
] as const);
export type ListenerKind = (typeof LISTENER_KINDS)[number];

/**
 * 画面を読み切れなかった理由（設計書 4.2。その画面の候補に付ける）。T27b で 3 つを足した（どれも fail-closed の向き）:
 * - `INCOMPLETE_FREEZE_UNAVAILABLE`: 凍結の条件（page が 1 つで読み込み済み、Guard が凍結の前の段階）が満たされず、読まなかった（候補は 0 件）。
 * - `INCOMPLETE_READ_FAILED`: 凍結の後の読み取り（probe か JS の結び付き）が失敗したか、時間の上限を超えたか、読んだ要素と CDP の要素が
 *   対応しなかった（読み取りの間に DOM が変わった）。結び付きの分からない候補を出さないので、候補は 0 件。
 * - `INCOMPLETE_LIMIT_REACHED`: 走査した要素の数、画面の候補の数、候補の欄の数、query の名前の数、URL の長さのどれかの上限に達し、
 *   読み切れなかった（読めた分の候補は出す）。COV-6b-1・URL-LEN・L13 でどの上限も撤廃したので、今は付けない（前の記録を読むために値は残す。管理データの候補の schema の enum にあるので、LZ-1 でも消さない）。
 * - `INCOMPLETE_PAGE_NAVIGATION_LIMIT`（DEF-129）: その画面の Context で、ページが始めた文書の読み込み（main frame か、T37R2-fix で子の frame の、
 *   JS の読み込み直しや移動、meta の転送）を、Guard が frame ごとの上限（`PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME`）で止めた（画面が落ち着かず、
 *   読んだ内容が途中のものかもしれない。読めた分の候補は出す）。
 *   ジョブの流れが、画面を閉じた後に付ける。
 * - `INCOMPLETE_PAGE_SUBRESOURCE_LIMIT`（DEF-130-fix）: その画面の Context で、1 画面の読み込みあたりの、ページが出す文書でない要求（画像・`fetch`・
 *   `xhr` など）を、Guard が上限（前は 1,000。L10 で撤廃した）で止めた（画面がデータを描き切れなかったかもしれない。読めた分の候補は出す）。
 *   ジョブの流れが、画面を閉じた後に付ける。
 * - `SERVICE_READ_REFUSED`（T37a。Task 37 の設計書 3.1。T37R-fix-B2 で数える項目を更新）: その画面の Context で、承認したサービスの Origin への要求を
 *   上限で断った、サービスの Origin から 401 を受けた、登録した読み取りの手続きの呼び出しを回数の上限か送り方で止めた、承認したサービスの Origin への
 *   読み取りでない要求を止めた、のどれかがあった（画面がデータを描けなかったかもしれない。読めた分の候補は出す）。判定は
 *   `src/orchestration/audit-stage-run.ts` の `isAuditStageReadObstructed`（READ の確かめと共有）。許可 Origin への `fetch`・`xhr` を止めたことは
 *   数えない（記録だけ）。ジョブの流れが、画面を閉じた後に付ける（`discovery-result.ts` の `withServiceReadRefused`）。
 */
export const INCOMPLETE_REASONS = Object.freeze([
  'INCOMPLETE_SETTLE_TIMEOUT',
  'INCOMPLETE_FRAME_OR_CLOSED_SHADOW',
  'INCOMPLETE_FREEZE_UNAVAILABLE',
  'INCOMPLETE_READ_FAILED',
  'INCOMPLETE_LIMIT_REACHED',
  'INCOMPLETE_PAGE_NAVIGATION_LIMIT',
  'INCOMPLETE_PAGE_SUBRESOURCE_LIMIT',
  // fix round 4（通知の枠の設計書 3.2.3 の 3）: 閉じる押下か隠しの押す期間に、Guard が移動かポップアップを止めた画面（誤りの画面を読んだおそれがある。候補は 0 件）。
  'NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED',
  'SERVICE_READ_REFUSED',
  // L6/L3-1（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 1 画面の進みの見張り（L0）が、全く反応がない・静まらない画面を、それまでの記録で終えた
  // （理由の名前は L0 の理由 `PROGRESS_WATCH_END_REASON_CODES` と同じ）。
  'STAGE_UNRESPONSIVE',
  'STAGE_NEVER_QUIET',
] as const);
export type IncompleteReason = (typeof INCOMPLETE_REASONS)[number];

// L13（N28〜N30）: 選択肢の数・欄の数・欄と query の名前の長さ・query の名前の数の上限は撤廃した（定数は LZ-1 で消した）。

// LZ-2: 選択肢の値・欄の名前・制約の属性の値の長さの上限（前は `MAX_OPTION_VALUE_LENGTH` 256・`MAX_FIELD_NAME_LENGTH` 256・
// `MAX_CONSTRAINT_VALUE_LENGTH` 512）は撤廃した（切り詰めない）。

// LZ-3c: 送信ボタンの文言を読む最大長（前は `MAX_SUBMITTER_TEXT_LENGTH` 256）は撤廃した。probe と押す時点の確かめは、文言の全部から送信ボタンの語を
// 求め、文言は捨てる（候補には持たない。T27R-fix-1。DEF-086）。照合は厳しくなる向きだけ（前の長さの後ろの語も比べる）。

// URL-LEN: form の `target` の長さの上限（前は 256）と、画面と送信先の Origin と path の長さの上限（前は 2,048）は撤廃した（切り詰めない）。

/** 画面（候補を見つけたページ）。 */
export interface CandidateLocation {
  /** Origin の直列化（`URL.origin`）。 */
  readonly origin: string;
  /** `/` で始まる path（`URL.pathname`。percent-encode のまま）。query と fragment は持たない。 */
  readonly path: string;
}

/** 送信先（form の action。送信ボタンの `formaction` があれば、その値）。query は名前だけ。 */
export interface CandidateAction extends CandidateLocation {
  /** query の名前（出てきた順。値は持たない）。 */
  readonly queryNames: readonly string[];
}

/** 入力の欄の制約（属性の文字列。属性がなければ null）。 */
export type CandidateFieldConstraints = { readonly [Name in FieldConstraintName]: string | null };

/** 入力の欄 1 件（値と label は持たない）。 */
export interface CandidateField {
  /** `name` の属性（ない場合は空の文字列。名前のない欄は送られないので、指紋に入れない）。 */
  readonly name: string;
  readonly tag: CandidateFieldTag;
  readonly type: CandidateFieldType;
  readonly required: boolean;
  readonly readonly: boolean;
  /** disabled（disabled の fieldset の中を含む）。 */
  readonly disabled: boolean;
  /** `type=hidden` か、見えない。 */
  readonly hidden: boolean;
  readonly constraints: CandidateFieldConstraints;
  /**
   * 選択肢の値（L13: 件数で切らない。label の文言は持たない）。select は option の値、checkbox と radio は `value` の属性
   * （ないときは `on`）。ほかの欄は null。
   */
  readonly options: readonly string[] | null;
  /**
   * 省いた選択肢の件数（0 以上。L13: 件数で切らないので、今の probe は常に 0）。候補の識別（`fingerprint.ts`）に入り、管理データの候補の schema も
   * 求めるので残す（LZ-1: digest の版の決まりがないため、消さない）。
   */
  readonly omittedOptionCount: number;
  /** 値があるか（値そのものは持たない）。 */
  readonly hasValue: boolean;
  /**
   * REV-RCA の I-3（検索の確かめの設計書 2.5。任意の項目。版は変えず、識別の digest に入れない）: 値か表示の文字が削除の語に当たる選択肢の位置（`options` の位置。
   * 当たる選択肢がなければ項目を持たない）。表示の文字は持たない。検索の確かめの組の作り手が、その選択肢を組から除く。
   */
  readonly destructiveOptionIndexes?: readonly number[];
}

/** JS の結び付き（listener の種類。重複なし）。form の外のボタンの `form` は空。 */
export interface CandidateJsBinding {
  readonly form: readonly ListenerKind[];
  /** 送信ボタン（form の外のボタンは、その要素）。 */
  readonly submitter: readonly ListenerKind[];
  /** form（form の外のボタンは、その要素）の祖先の要素（root を含む。document は含まない）。 */
  readonly ancestor: readonly ListenerKind[];
  readonly document: readonly ListenerKind[];
  readonly window: readonly ListenerKind[];
  /** inline の処理（form の `onsubmit`、送信ボタンの `onclick` の属性）があるか。 */
  readonly inlineHandler: boolean;
}

/** 発見で読んだ候補（probe の結果。T27b が作る）。分類と指紋の入力。 */
export interface DiscoveredCandidate {
  readonly page: CandidateLocation;
  readonly kind: CandidateKind;
  /** `FORM` は必ずある。`BUTTON` は null。 */
  readonly formMethod: FormMethod | null;
  /** `_method` の hidden の欄の値が `METHOD_OVERRIDE_VALUES` に当たるときだけ、その値。ほかは null。 */
  readonly methodOverride: MethodOverride | null;
  /** `FORM` は必ずある。`BUTTON` は null。 */
  readonly action: CandidateAction | null;
  /** `FORM` は必ずある。`BUTTON` は null。 */
  readonly enctype: FormEnctype | null;
  /** form の `target`（`formtarget` を含む。指定がなければ空の文字列）。`BUTTON` は null。 */
  readonly target: string | null;
  /** 入力の欄（`BUTTON` は空）。 */
  readonly fields: readonly CandidateField[];
  /**
   * 送信ボタンの語（T27R-fix-1。DEF-086）: probe が読んだ送信ボタンの文言（ボタンの文字・`aria-label`・`title`）が当たった、送信ボタンの語の
   * 閉じた一覧（`classification-words.ts` の `DISCOVERY_SUBMITTER_WORDS`）の語（`classify.ts` の `submitterWordsOf`。UTF-16 のコード単位の順、
   * 重なりなし）。文言そのものは持たない。語がない・ボタンがない form は空。分類と識別の digest に使う。成果物には持つが、索引には持たない。
   */
  readonly submitterWords: readonly string[];
  readonly jsBinding: CandidateJsBinding;
  /** その画面を読み切れなかった理由（重複なし。読み切れたら空）。 */
  readonly incompleteReasons: readonly IncompleteReason[];
}

/** 分類の結果（`classifyCandidate`）。 */
export interface CandidateClassificationResult {
  readonly classification: CandidateClassification;
  readonly reasonCode: CandidateReasonCode;
  /** 状態の欄（`active`・`status`・`deleted` など）の印（Task 31 の削除相当の判断に使う）。 */
  readonly hasStateField: boolean;
}

/** 2 つの digest（`computeCandidateDigests`。`sha256:<小文字の16進64桁>`）。 */
export interface CandidateDigests {
  /** 識別の digest（画面、種類、method、送信先、欄の名前と型、送信ボタンの語）。 */
  readonly identityDigest: string;
  /** 入力規則の digest（欄の必須・readonly・disabled・hidden・制約・選択肢の値）。 */
  readonly ruleDigest: string;
}

/**
 * 成果物（`discovery.json`）の候補 1 件。`schemas/control/candidate.schema.json` の形。T37c（Task 37 の設計書 3.4）: 送らずに観察する probe の結果
 * （任意の項目 `submissionProbe`。probe の対象にした候補だけ。契約は `submission-probe-contracts.ts`）。識別の digest と規則の digest には入れない。
 * LU-11（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.4 の 4、D5）: フォームの候補の、同じ行の開き手（任意の項目 `rowOpener`。形は probe の
 * `opener` と同じ。開き手のボタンの候補の識別の digest・名前があるか・開き手の語。値は持たない）。結び付く開き手がちょうど 1 つのときだけ。識別の digest と
 * 規則の digest には入れない。
 */
export interface DiscoveryCandidate extends DiscoveredCandidate, CandidateClassificationResult, CandidateDigests {
  readonly submissionProbe?: SubmissionProbeRecord;
  readonly rowOpener?: SubmissionProbeOpener;
}

// ---------------------------------------------------------------------------------------------------------------
// 同じ名前の hidden と checkbox の組（T31b fix round 1。Task 31 の設計書 3 章の「同じ名前の hidden と checkbox の組（Rails 型）」）
// ---------------------------------------------------------------------------------------------------------------

/** 組の欄の数（同じ名前の欄がちょうどこの数）。 */
const CHECKBOX_PAIR_FIELD_COUNT = 2;

/**
 * 同じ名前の hidden と checkbox の組（checkbox の「外した値」を送る hidden）。位置は候補の欄の一覧の位置（DOM の順。probe の `form.elements` の順で、
 * 送信ボタンなどは含めない）。
 */
export interface CheckboxHiddenPair {
  readonly name: string;
  readonly hiddenIndex: number;
  readonly checkboxIndex: number;
}

/**
 * 候補の欄の一覧（1 つの form）の、同じ名前の hidden と checkbox の組（純粋。欄の順。凍結）。組は、名前のある同じ名前の欄がちょうど 2 つで、型が
 * `hidden` の欄のすぐ後に型が `checkbox` の欄があるときだけ。3 つ以上、逆の順、間に別の欄、hidden の型でない、checkbox でない、は組にしない。
 * シナリオの欄の役割の判定（`src/control/approval/scenario-policy.ts`）と、送る中身の期待の作り手（T31g）が使う。
 */
export const checkboxHiddenPairsOf = (fields: readonly Pick<CandidateField, 'name' | 'type'>[]): readonly CheckboxHiddenPair[] =>
  Object.freeze(fields.flatMap((field, index): readonly CheckboxHiddenPair[] => {
    const next = fields[index + 1];
    if (field.name.length === 0 || field.type !== 'hidden' || next === undefined || next.name !== field.name || next.type !== 'checkbox') {
      return [];
    }
    return fields.filter((other) => other.name === field.name).length === CHECKBOX_PAIR_FIELD_COUNT
      ? [Object.freeze({ name: field.name, hiddenIndex: index, checkboxIndex: index + 1 })]
      : [];
  }));

/**
 * 書き込みで、その名前の値を送る欄（純粋。凍結）: 組の名前は組の checkbox だけ（組の hidden は組の一部で、役割を持たない）。ほかは同じ名前の欄の
 * すべて（なければ空）。T31g-1: 名前と型だけを持つ欄の一覧も受ける（書き込みの入力の部品の `WriteFormFieldSpec`）。
 */
export const writeFieldsOfName = <Field extends Pick<CandidateField, 'name' | 'type'>>(fields: readonly Field[], name: string): readonly Field[] => {
  const pair = checkboxHiddenPairsOf(fields).find((candidate) => candidate.name === name);
  const checkbox = pair === undefined ? undefined : fields[pair.checkboxIndex];
  return Object.freeze(checkbox === undefined ? fields.filter((field) => field.name === name) : [checkbox]);
};

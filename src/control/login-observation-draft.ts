// 観察した要求の「登録する」の振り分けと、認証の設定の画面へ渡す下書きの唯一の owner（Task 43 の設計書 3 章、4.4。T43d）。純粋な部品（入出力を持たない）。
// ジョブの詳細の画面（ボタンの出し方と下書きの作り方）、認証の設定の画面（下書きの読み直しと、プロファイルに足す Origin）、テストが使う。
// - 振り分け（`loginStageRegistrationOf`）: 伏せた path の区切りがある行は手で入れる（`REDACTED_PATH`）。登録した token の送信先・ログインに伴う送信の
//   上限や送り方や必須の query の違い（`TOKEN_REQUEST_QUERY_MISMATCH`。T43R-fix の M-2: 登録した token の送り方を置き換えない。I17）で止めた行は手で直す
//   （`ALREADY_REGISTERED`）。`grant_type` の値を記録した、まだ登録していない行（token の送信の形）は token の送信先（Origin、path、必須の query
//   `grant_type=<記録した値>`）。ほかの、まだ登録していない読み取りでない要求は、ログインに伴う送信（Origin、path、POST、回数の上限は既定 1。行は method を
//   持たないので、送る method は認証の設定の閉じた一覧（`LOGIN_SIDE_REQUEST_METHODS`）の POST。Guard は method も照らすので、違えば今どおり止まる）。
//   プロファイルの承認したサービスの Origin に足すべき Origin は、画面が保存の時点の欄の値とプロファイルから決める（`approvedServiceOriginsToAdd`。M-3）。
// - 下書き（`ObservedAuthSetupDraft`）: 保存しない形（URL の search）で渡す。値は Origin・path・method・必須の query（`grant_type` とその値）と、観察の
//   成功の鍵の名前の接頭辞と接尾辞（T43R-fix の C-1 (a)。名前の全体は持たない）と成功の画面のセレクタ（ログアウトの属性の CSS だけ）。読み直す
//   （`parseObservedAuthSetupDraft`）ときは、閉じた形と値の形を確かめ、合わなければ下書きなし（`null`）。path の形は保存の側の owner
//   （`isAcceptedPath`）で確かめる（M-1）。保存は利用者が押し、保存の部品が今どおり検証する（設計書 3 章「埋めた値は、保存されていない案」）。
// - FM2e（手を減らす段 2 の設計書 3A.4）: 手動のログインの段の観察のログインの欄の案から、自動ログインの設定の画面の 3 つのセレクタの案を作る
//   （`loginFieldDraftsOf`。推測の印つき。保存しない）。
import { isRecord } from '../core/guards.js';
import { hasRedactedPathSegment, hasValueLikePathSegment } from '../core/url-path-redaction.js';
import { canonicalHttpOriginOf, isOriginInAllowedOrigins } from '../crawl/normalize-url.js';
import {
  LOGIN_OBSERVED_QUERY_VALUE_NAMES,
  isLoginObservedQueryValue,
  isLoginObservedStorageKeyShape,
  isLoginObservedSuccessSelector,
  type LoginObservedQueryValueName,
} from '../discovery/login-observation.js';
import { LOGIN_SIDE_REQUEST_METHODS, MAX_LOGIN_SIDE_REQUESTS, MIN_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE, type LoginSideRequestMethod } from './auth/auth-setup-contracts.js';
import { isAcceptedPath } from './auth/auth-setup-policy.js';
import { draftValueOf, type DraftValue } from './approval/draft-value-origin.js';
import { ENTRY_CHECK_FIELDS, isAcceptedEntrySelector, type EntryCheckField } from './entry-check.js';
import {
  MAX_WORKER_LOGIN_STAGE_BLOCKED_PATH_LENGTH,
  type WorkerLoginObservation,
  type WorkerLoginStageBlockedRequest,
  type WorkerLoginStageBlockReason,
} from './worker-protocol.js';

/** ログインに伴う送信として登録する method（認証の設定の閉じた一覧の POST だけ）。 */
const [SIDE_REQUEST_METHOD] = LOGIN_SIDE_REQUEST_METHODS;

/** まだ登録していない要求を止めた理由（登録の形を作れる行）。 */
const UNREGISTERED_REASONS: readonly WorkerLoginStageBlockReason[] = Object.freeze(['UNREGISTERED_NON_READ', 'NON_READ_METHOD']);

/** 必須の query の組 1 つ（閉じた一覧の名前と、記録した値）。 */
export interface ObservedRequiredQuery {
  readonly name: LoginObservedQueryValueName;
  readonly value: string;
}

/** 行の登録先（`MANUAL` はボタンを出さず、手で入れる）。 */
export type LoginStageRegistration =
  | { readonly kind: 'TOKEN_TARGET'; readonly origin: string; readonly path: string; readonly requiredQuery: readonly ObservedRequiredQuery[] }
  | {
    readonly kind: 'SIDE_REQUEST';
    readonly origin: string;
    readonly path: string;
    readonly method: LoginSideRequestMethod;
    readonly maxPerLoginStage: number;
  }
  | { readonly kind: 'MANUAL'; readonly reason: 'REDACTED_PATH' | 'ALREADY_REGISTERED' };

/** 止めた要求の行の登録先（ファイルの先頭の「振り分け」）。 */
export const loginStageRegistrationOf = (row: WorkerLoginStageBlockedRequest): LoginStageRegistration => {
  if (hasRedactedPathSegment(row.path)) {
    return { kind: 'MANUAL', reason: 'REDACTED_PATH' };
  }
  if (!UNREGISTERED_REASONS.includes(row.reason)) {
    return { kind: 'MANUAL', reason: 'ALREADY_REGISTERED' };
  }
  const requiredQuery = (row.query?.values ?? []).map(({ name, value }) => ({ name, value }));
  if (requiredQuery.length > 0) {
    return { kind: 'TOKEN_TARGET', origin: row.origin, path: row.path, requiredQuery };
  }
  return { kind: 'SIDE_REQUEST', origin: row.origin, path: row.path, method: SIDE_REQUEST_METHOD, maxPerLoginStage: MIN_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE };
};

/** 下書きのログインに伴う送信 1 つ（回数の上限は、欄の既定の 1。画面で変えられる）。 */
export interface ObservedSideRequestDraft {
  readonly origin: string;
  readonly path: string;
  readonly method: LoginSideRequestMethod;
}

/** 認証の設定の画面へ渡す下書き（保存しない。どれかの項目を持つ）。 */
export interface ObservedAuthSetupDraft {
  readonly scriptLogin?: { readonly origin: string; readonly path: string; readonly requiredQuery: readonly ObservedRequiredQuery[] };
  readonly sideRequests?: readonly ObservedSideRequestDraft[];
  /** 成功の鍵の名前の案（接頭辞と接尾辞。名前の全体と値は持たない。T43R-fix の C-1 (a)）。 */
  readonly storageKey?: { readonly origin: string; readonly prefix: string; readonly suffix: string };
  /** 成功の画面のセレクタの案（CSS だけ）。 */
  readonly successSelector?: string;
}

/** 登録先から、下書きを作る（`MANUAL` は `null`）。 */
export const observedDraftOfRegistration = (registration: LoginStageRegistration): ObservedAuthSetupDraft | null => {
  switch (registration.kind) {
    case 'TOKEN_TARGET':
      return { scriptLogin: { origin: registration.origin, path: registration.path, requiredQuery: registration.requiredQuery.map((query) => ({ ...query })) } };
    case 'SIDE_REQUEST':
      return { sideRequests: [{ origin: registration.origin, path: registration.path, method: registration.method }] };
    default:
      return null;
  }
};

/** 観察から、下書きを作る（最初の接頭辞と接尾辞の案と、成功の画面のセレクタ。どちらもなければ `null`）。 */
export const observedDraftOfObservation = (observation: WorkerLoginObservation): ObservedAuthSetupDraft | null => {
  const shape = observation.storageKeys?.shapes[0];
  const draft: ObservedAuthSetupDraft = {
    ...(observation.storageKeys === undefined || shape === undefined
      ? {}
      : { storageKey: { origin: observation.storageKeys.origin, prefix: shape.prefix, suffix: shape.suffix } }),
    ...(observation.successSelector === undefined ? {} : { successSelector: observation.successSelector.selector }),
  };
  return Object.keys(draft).length === 0 ? null : draft;
};

/** FM2e: 自動ログインの 3 つのセレクタの案（推測の印つき。案のない欄は `null`）。 */
export type LoginFieldDrafts = Readonly<Record<EntryCheckField, DraftValue<string> | null>>;

/**
 * FM2e（手を減らす段 2 の設計書 3A.4）: 手動のログインの段の観察のログインの欄の案（`loginFields`）から、自動ログインの設定の画面の 3 つのセレクタの案を
 * 作る。どの案も推測（根拠 `LOGIN_FIELD_SINGLE_CANDIDATE`。人が確かめて直せる）。保存した記録は信用しないので、認証の設定として受ける形
 * （`isAcceptedEntrySelector`）だけを案にする。案が 1 つもなければ `null`。画面の案だけに使い、保存しない。
 */
export const loginFieldDraftsOf = (observation: WorkerLoginObservation | undefined): LoginFieldDrafts | null => {
  const fields = observation?.loginFields;
  if (fields === undefined) {
    return null;
  }
  const draftOf = (field: EntryCheckField): DraftValue<string> | null => {
    const selector = fields[field];
    return typeof selector === 'string' && isAcceptedEntrySelector(selector) ? draftValueOf(selector, 'LOGIN_FIELD_SINGLE_CANDIDATE') : null;
  };
  const drafts = { username: draftOf('username'), password: draftOf('password'), submit: draftOf('submit') };
  return ENTRY_CHECK_FIELDS.some((field) => drafts[field] !== null) ? Object.freeze(drafts) : null;
};

// ---------------------------------------------------------------------------------------------------------------
// 読み直し（URL の search の値。信用しない）
// ---------------------------------------------------------------------------------------------------------------

const DRAFT_KEYS: readonly (keyof ObservedAuthSetupDraft)[] = Object.freeze(['scriptLogin', 'sideRequests', 'storageKey', 'successSelector']);

/** 閉じた形の object か（`keys` のほかの項目を持たない）。 */
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));

const isOrigin = (value: unknown): value is string => typeof value === 'string' && canonicalHttpOriginOf(value) === value;

/**
 * 下書きの path か（T43R-fix の M-1: 形は保存の側の owner `isAcceptedPath`、長さの上限は止めた一覧の path の IPC の上限。加えて、伏せた区切りと値に
 * 見える区切りがない）。
 */
const isDraftPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_WORKER_LOGIN_STAGE_BLOCKED_PATH_LENGTH && isAcceptedPath(value)
  && !hasRedactedPathSegment(value) && !hasValueLikePathSegment(value);

const isRequiredQuery = (value: unknown): value is ObservedRequiredQuery =>
  isRecord(value) && hasOnlyKeys(value, ['name', 'value']) && typeof value['name'] === 'string' && typeof value['value'] === 'string'
  && (LOGIN_OBSERVED_QUERY_VALUE_NAMES as readonly string[]).includes(value['name']) && isLoginObservedQueryValue(value['name'], value['value']);

const isScriptLoginDraft = (value: unknown): boolean =>
  isRecord(value) && hasOnlyKeys(value, ['origin', 'path', 'requiredQuery']) && isOrigin(value['origin']) && isDraftPath(value['path'])
  && Array.isArray(value['requiredQuery']) && value['requiredQuery'].length <= LOGIN_OBSERVED_QUERY_VALUE_NAMES.length
  && value['requiredQuery'].every(isRequiredQuery);

const isSideRequestDraft = (value: unknown): boolean =>
  isRecord(value) && hasOnlyKeys(value, ['origin', 'path', 'method']) && isOrigin(value['origin']) && isDraftPath(value['path'])
  && value['method'] === SIDE_REQUEST_METHOD;

const isStorageKeyDraft = (value: unknown): boolean =>
  isRecord(value) && hasOnlyKeys(value, ['origin', 'prefix', 'suffix']) && isOrigin(value['origin'])
  && typeof value['prefix'] === 'string' && typeof value['suffix'] === 'string'
  && isLoginObservedStorageKeyShape({ prefix: value['prefix'], suffix: value['suffix'] });

/** URL の search の値を、下書きとして読む（閉じた形と値の形に合わなければ `null`）。 */
export const parseObservedAuthSetupDraft = (value: unknown): ObservedAuthSetupDraft | null => {
  if (!isRecord(value) || Object.keys(value).length === 0 || !hasOnlyKeys(value, DRAFT_KEYS)) {
    return null;
  }
  const { scriptLogin, sideRequests, storageKey, successSelector } = value;
  const ok = (scriptLogin === undefined || isScriptLoginDraft(scriptLogin))
    && (sideRequests === undefined
      || (Array.isArray(sideRequests) && sideRequests.length > 0 && sideRequests.length <= MAX_LOGIN_SIDE_REQUESTS && sideRequests.every(isSideRequestDraft)))
    && (storageKey === undefined || isStorageKeyDraft(storageKey))
    && (successSelector === undefined
      || (typeof successSelector === 'string' && isAcceptedEntrySelector(successSelector) && isLoginObservedSuccessSelector(successSelector)));
  return ok ? structuredClone(value) as ObservedAuthSetupDraft : null;
};

/** 足すべき Origin を決める入力（下書き、または保存の時点の欄の値。T43R-fix の M-3）。 */
export interface ServiceOriginSources {
  readonly scriptLogin?: { readonly origin: string } | undefined;
  readonly sideRequests?: readonly { readonly origin: string }[] | undefined;
}

/**
 * 保存するために、プロファイルの承認したサービスの Origin に足すべき Origin（足す順。重ならない）。token の送信先はサービスの Origin でなければならず、
 * ログインに伴う送信はテストの Origin かサービスの Origin でなければならない（認証の設定の検証と同じ決まり）。T43R-fix の M-3: 画面は、保存の時点の欄の
 * 値（token の送信先、ログインに伴う送信の Origin）から決め直す。Origin の正規の直列化でない値（空の欄など）は足さない（保存の検証が誤りにする）。
 */
export const approvedServiceOriginsToAdd = (
  sources: ServiceOriginSources,
  profile: { readonly approvedTestOrigins: readonly string[]; readonly approvedServiceOrigins: readonly string[] },
): readonly string[] => {
  const added: string[] = [];
  const add = (candidate: string, alsoAccepted: readonly string[]): void => {
    if (isOrigin(candidate) && !isOriginInAllowedOrigins([...profile.approvedServiceOrigins, ...alsoAccepted], candidate) && !added.includes(candidate)) {
      added.push(candidate);
    }
  };
  if (sources.scriptLogin !== undefined) {
    add(sources.scriptLogin.origin, []);
  }
  for (const side of sources.sideRequests ?? []) {
    add(side.origin, profile.approvedTestOrigins);
  }
  return added;
};

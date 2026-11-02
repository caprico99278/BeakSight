// 手動のログインの成功から、Guard を通るための認証の設定を組み立てる唯一の owner（ML-a。設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md`
// 2.3、ユーザーの指示 2026-10-19）。純粋な部品（入出力を持たない）。ジョブの管理（`src/control/job/audit-job-manager.ts`）が、手動のログインのジョブの
// 終わりに呼び、結果を保存の部品（`saveProfileAndAuthSetup`）で保存する。
// - 材料は、手動のログインの段で通した読み取りでない要求の一覧（`AUTH_STATE` の `passedRequests`。形だけ）と、ログインの段の観察（`loginObservation`。
//   成功の鍵の名前の接頭辞と接尾辞の案）。値（パスワード、token、query の値）は、材料にも結果にもない（`grant_type` の閉じた一覧の値だけ）。
// - 行の振り分けは、今の「登録する」の部品（`loginStageRegistrationOf`。Task 43）をそのまま使う: `grant_type` を記録した行は token の送信先、ほかの行は
//   ログインに伴う送信、伏せた path と登録済みの理由の行は使わない。成功の鍵は観察の案（`observedDraftOfObservation`）、足す Origin は
//   `approvedServiceOriginsToAdd`。
// - 加える決まり: 読まないパス・危険な語の path（`isExcludedReadPath`。登録した読み取りの手続きの呼び出しと同じ判定）は入れない。ML-a-fix（ML-R の I-1）:
//   ログインに伴う送信は、token の送信より前に通した（行の `beforeToken`）、種類が fetch・xhr の、手続きの呼び出しの path（`hasApiProcedureCallSegment`）だけ
//   （第三者の解析の送信、アプリの計測、データを書く送り先、token の後の送信は登録しない。表の「登録する」の案として出るだけ）。足す Origin は、token の送信先と
//   自動で登録した送信の送り先だけ。ログインに伴う送信の回数の上限は、閉じた上限（`MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE`。ML-a-fix-2）。件数は閉じた上限まで。すでにスクリプトで送るログインの設定なら、token の送信先と成功の鍵は
//   今のまま、まだない送信だけを足す。
// - 組み立てられないときは、閉じた一覧の理由だけを返す（`MANUAL_LOGIN_REGISTRATION_SKIP_REASONS`）。検証（`validateAuthSetup`）は保存の部品が行う。
import { API_PROCEDURE_PATH_SEGMENT, hasApiProcedureCallSegment } from '../core/api-request-shape.js';
import { WORKER_LOGIN_CHECK_JOB_KIND, type WorkerJobKind } from '../core/audit-job-values.js';
import { isOriginInAllowedOrigins } from '../crawl/normalize-url.js';
import { procedureNameHasWriteWord } from '../discovery/classify.js';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  MAX_LOGIN_SIDE_REQUESTS,
  MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE,
  SCRIPT_REQUEST_TRANSPORT,
  loginTransportOf,
  type AuthSetup,
  type AuthSetupV3,
  type LoginSideRequest,
  type ScriptLoginTarget,
  type SuccessStorageKey,
} from './auth/auth-setup-contracts.js';
import { isEmptySuccessCondition, isExcludedReadPath, sessionLostPathPrefixOf } from './auth/auth-setup-policy.js';
import {
  CREDENTIAL_DESTINATION_LOCKED_REASON,
  authSetupCredentialDestinationChangesOf,
  isAutomatedLoginProfileAuth,
} from './auth/credential-destination.js';
import type { AuthStrategy } from './contracts.js';
import {
  approvedServiceOriginsToAdd,
  loginStageRegistrationOf,
  observedDraftOfObservation,
  observedDraftOfRegistration,
} from './login-observation-draft.js';
import type {
  WorkerLoginObservation,
  WorkerLoginStageBlockedRequest,
  WorkerLoginStageBlockedRequests,
  WorkerRequestResourceType,
} from './worker-protocol.js';

/**
 * 組み立てない理由（閉じた一覧）。
 * - `NO_PASSED_REQUESTS`: 通した送信の一覧がない。
 * - `NO_TOKEN_REQUEST`: token の送信の形（`grant_type` を記録した行）で、登録できる path の行がない（スクリプトで送るログインの設定でもない）。
 * - `NO_STORAGE_KEY`: 成功の鍵の案がない（許可 Origin の案がない）。版 3 のスクリプトで送るログインは、成功の鍵が要る。
 * - `NOTHING_NEW`: すでにスクリプトで送るログインの設定で、足す送信がない。
 */
export const MANUAL_LOGIN_REGISTRATION_SKIP_REASONS = Object.freeze([
  'NO_PASSED_REQUESTS',
  'NO_TOKEN_REQUEST',
  'NO_STORAGE_KEY',
  'NOTHING_NEW',
  // ML-a-fix-3（ML-R2 の M-1）: token の送信先（Origin と path）が 2 つ以上あり、1 つに決まらない（今の設定の送信先と違う token の形の行を含む）。
  'MULTIPLE_TOKEN_TARGETS',
  // DEF-182（OP-DEF 修正の 1 回目。案 (b)）: token の送信先が、テスト環境と同じ Origin（プロファイルの許可 Origin）。token の送信先は承認したサービスの Origin で
  // なければならず、サービスの Origin は許可 Origin と重なれない（安全の境目は変えない）ので、登録しない。自動ログインへも切り替えない（手動のログインのまま）。
  'TOKEN_TARGET_ON_TEST_ORIGIN',
] as const);
export type ManualLoginRegistrationSkipReason = (typeof MANUAL_LOGIN_REGISTRATION_SKIP_REASONS)[number];

/** 組み立ての入力。 */
export interface ManualLoginRegistrationInput {
  /** 今の認証の設定（ジョブが使ったもの）。 */
  readonly setup: AuthSetup;
  /** プロファイルの承認した Origin。 */
  readonly profile: { readonly approvedTestOrigins: readonly string[]; readonly approvedServiceOrigins: readonly string[] };
  /** 手動のログインの段で通した送信の一覧（なければ `undefined`）。 */
  readonly passedRequests: WorkerLoginStageBlockedRequests | undefined;
  /** ログインの段の観察（なければ `undefined`）。 */
  readonly observation: WorkerLoginObservation | undefined;
  /** 保存するプロファイルの次の改訂（設定はこの改訂に結ぶ）。 */
  readonly nextProfileRevision: number;
}

/** 組み立ての結果（設定と、プロファイルに足す承認したサービスの Origin。または理由）。 */
export type ManualLoginRegistration =
  | { readonly ok: true; readonly setup: AuthSetupV3; readonly addServiceOrigins: readonly string[] }
  | { readonly ok: false; readonly reason: ManualLoginRegistrationSkipReason };

const skipped = (reason: ManualLoginRegistrationSkipReason): ManualLoginRegistration => ({ ok: false, reason });

/** ML-a-fix: ログインに伴う送信として自動で登録する要求の種類（スクリプトの送信。beacon・文書の送信などは登録しない）。 */
const SIDE_REQUEST_RESOURCE_TYPES: readonly WorkerRequestResourceType[] = Object.freeze(['fetch', 'xhr']);


/** 今のスクリプトで送るログインの項目（なければ `null`）。 */
const currentScriptLoginOf = (setup: AuthSetup): AuthSetupV3 | null =>
  loginTransportOf(setup) === SCRIPT_REQUEST_TRANSPORT && setup.scriptLogin !== null
    ? setup
    : null;

/**
 * 成功の鍵: 今のスクリプトで送るログインの設定の鍵か、ログインの段の観察の案（許可 Origin のものだけ）。なければ `null`。自動の登録と、表の 1 行の
 * 「登録する」（FM-1）が共用する。
 */
const successStorageKeyOf = (
  current: AuthSetupV3 | null,
  observation: WorkerLoginObservation | undefined,
  profile: ManualLoginRegistrationInput['profile'],
): SuccessStorageKey | null => {
  if (current?.successStorageKey !== undefined && current.successStorageKey !== null) {
    return current.successStorageKey;
  }
  const proposal = observedDraftOfObservation(observation ?? {})?.storageKey;
  return proposal !== undefined && isOriginInAllowedOrigins(profile.approvedTestOrigins, proposal.origin)
    ? { origin: proposal.origin, prefix: proposal.prefix, suffix: proposal.suffix }
    : null;
};

/** 手動のログインの成功から、認証の設定の版 3 と足す Origin を組み立てる（ファイルの先頭）。 */
export const manualLoginRegistrationOf = (input: ManualLoginRegistrationInput): ManualLoginRegistration => {
  const { setup, profile, passedRequests, observation, nextProfileRevision } = input;
  if (passedRequests === undefined || passedRequests.requests.length === 0) {
    return skipped('NO_PASSED_REQUESTS');
  }
  const usable = (path: string): boolean => !isExcludedReadPath(path, setup.excludedPaths);
  const current = currentScriptLoginOf(setup);
  // Origin の比べは、URL の意味の owner の部品（`isOriginInAllowedOrigins`。GATE-ARCH04）で行う。
  const sameTarget = (origin: string, path: string, target: { readonly origin: string; readonly path: string } | null): boolean =>
    target !== null && isOriginInAllowedOrigins([target.origin], origin) && target.path === path;
  const registrations = passedRequests.requests.flatMap((row) => {
    const registration = loginStageRegistrationOf(row);
    return registration.kind === 'MANUAL' || !usable(registration.path) ? [] : [{ row, registration }];
  });
  // ML-a-fix-3（ML-R2 の M-1）: token の送信先は 1 つに決まるときだけ（今の設定の送信先と、token の形の行の送信先（Origin と path）が 2 つ以上なら登録しない）。
  const targets: ScriptLoginTarget[] = current?.scriptLogin === null || current === null ? [] : [current.scriptLogin];
  for (const { registration } of registrations) {
    if (registration.kind === 'TOKEN_TARGET' && !targets.some((target) => sameTarget(registration.origin, registration.path, target))) {
      targets.push({ origin: registration.origin, path: registration.path, requiredQuery: registration.requiredQuery.map(({ name, value }) => ({ name, value })) });
    }
  }
  const [token, ...otherTargets] = targets;
  if (token === undefined) {
    return skipped('NO_TOKEN_REQUEST');
  }
  if (otherTargets.length > 0) {
    return skipped('MULTIPLE_TOKEN_TARGETS');
  }
  if (isOriginInAllowedOrigins(profile.approvedTestOrigins, token.origin)) {
    return skipped('TOKEN_TARGET_ON_TEST_ORIGIN');
  }
  const sides: LoginSideRequest[] = [...(current?.loginSideRequests ?? [])];
  let added = 0;
  for (const { row, registration } of registrations) {
    // ML-a-fix（ML-R の I-1）・ML-a-fix-3（ML-R2 の M-1・M-2）: ログインに伴う送信として自動で登録するのは、(a) token の送信より前に通した、(b) 種類が
    // fetch・xhr、(c) path が符号化していない手続きの呼び出し（`isPlainProcedureCallPath`）で、名前に書き込みの語がない（`procedureNameHasWriteWord`）、
    // (d) 危険な語・読まないパスでない（上で除いた）、(e) token の送信先と同じ Origin、のものだけ。ほかの通した送信は、表の「登録する」の案だけ。
    if (
      registration.kind !== 'SIDE_REQUEST' || row.beforeToken !== true || !SIDE_REQUEST_RESOURCE_TYPES.includes(row.resourceType)
      || !isPlainProcedureCallPath(registration.path) || procedureNameHasWriteWord(registration.path)
      || !isOriginInAllowedOrigins([token.origin], registration.origin)
    ) {
      continue;
    }
    if (sameTarget(registration.origin, registration.path, token)
      || sides.some((side) => sameTarget(registration.origin, registration.path, side) && side.method === registration.method)
      || sides.length >= MAX_LOGIN_SIDE_REQUESTS) {
      continue;
    }
    // ML-a-fix-2: 回数の上限は、手動の段で見えた回数でなく、閉じた上限（今の決まりの最大）。ログインの後の呼び出しが、自動ログインの段で上限で止まらない。
    sides.push({ origin: registration.origin, path: registration.path, method: registration.method, maxPerLoginStage: MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE });
    added += 1;
  }
  const loginSideRequests = sides;
  if (current !== null && added === 0) {
    return skipped('NOTHING_NEW');
  }
  const successStorageKey = successStorageKeyOf(current, observation, profile);
  if (successStorageKey === null) {
    return skipped('NO_STORAGE_KEY');
  }
  const built: AuthSetupV3 = {
    ...setup,
    schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
    profileRevision: nextProfileRevision,
    loginTransport: SCRIPT_REQUEST_TRANSPORT,
    scriptLogin: token,
    loginSideRequests,
    successStorageKey,
  };
  // ML-a-fix-3（ML-R2 の M-1）: 承認したサービスの Origin に足すのは、token の送信先の Origin だけ（ログインに伴う送信は同じ Origin だけを登録した）。
  return { ok: true, setup: built, addServiceOrigins: approvedServiceOriginsToAdd({ scriptLogin: token }, profile) };
};

/**
 * ML-a-fix-3（ML-R2 の M-2）: 符号化していない手続きの呼び出しの path か。path の区切りに `API_PROCEDURE_PATH_SEGMENT` がそのまま（小文字で）あり、
 * `%`・`;`・`\` を含まない（decode した形でだけ手続きの呼び出しになる path は、止める側に倒して登録しない）。core の `hasApiProcedureCallSegment` でも
 * 手続きの呼び出しであること。
 */
const isPlainProcedureCallPath = (path: string): boolean =>
  !/[%;\\]/u.test(path) && path.split('/').includes(API_PROCEDURE_PATH_SEGMENT) && hasApiProcedureCallSegment(path);

/**
 * FM-1（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 2.1）: 表の 1 行の「登録する」で足せない理由（閉じた一覧）。
 * - `REDACTED_PATH`: 値に見える区切りを伏せた path（送信先が決まらない）。
 * - `EXCLUDED_PATH`: 読まないパスか、危険な語を含む path（自動の登録と同じ判定）。
 * - `ALREADY_REGISTERED`: 登録済みの送信の理由で止めた行か、今の設定にすでにある送信。
 * - `NO_TOKEN_TARGET`: ログインに伴う送信を足すのに、token の送信先がない（スクリプトで送るログインの設定でない）。
 * - `NO_STORAGE_KEY`: 成功の鍵がない（今の設定にも、ジョブのログインの観察にも、許可 Origin の案がない）。
 * - `SIDE_REQUEST_LIMIT`: ログインに伴う送信が上限の数まである。
 * - `NEW_TARGET_FROM_AUTOMATED_LOGIN`（MI-G。設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.7）: 自動ログインの文脈（`isAutomatedLoginSource`）の
 *   行から、token の送信先か、承認したサービスの Origin を足そうとした（まだ人が手動のログインで観察していない送信先へ、資格情報を送らないため）。
 */
export const LOGIN_STAGE_ROW_REGISTRATION_REJECTIONS = Object.freeze([
  'REDACTED_PATH',
  'EXCLUDED_PATH',
  'ALREADY_REGISTERED',
  'NO_TOKEN_TARGET',
  'NO_STORAGE_KEY',
  'SIDE_REQUEST_LIMIT',
  'NEW_TARGET_FROM_AUTOMATED_LOGIN',
  // MI-F1（設計書 4.7.1 の 3）: 自動ログインのプロファイルで、資格情報の送信先（ログインに伴う送信の送信先、送り方など）が変わる（保存の部品の層と同じ判定
  // `authSetupCredentialDestinationChangesOf`。案の時点で拒む）。
  CREDENTIAL_DESTINATION_LOCKED_REASON,
] as const);
export type LoginStageRowRegistrationRejection = (typeof LOGIN_STAGE_ROW_REGISTRATION_REJECTIONS)[number];

/**
 * MI-G（設計書 4.7）: 表の行の出どころ（ジョブの記録とプロファイルから、画面のサーバが渡す。値を持たない）。
 * - `jobKind`: 行を記録したジョブの種類。`autoLoginAttempt`: そのジョブに自動ログインの試しの記録があるか。
 * - `profileAuth`: 今のプロファイルの認証の方式。
 */
export interface LoginStageRowSource {
  readonly jobKind: WorkerJobKind;
  readonly autoLoginAttempt: boolean;
  readonly profileAuth: AuthStrategy;
}

/**
 * MI-F3（独立レビュー MI-R の Minor 12）: ジョブの記録とプロファイルの今の方式から、行の出どころを組み立てる（組み立ての唯一の場所。表の行の「登録する」と下書き
 * からの保存の行の読み出し、ジョブの画面の「自動ログインの文脈か」が共用する）。`autoLoginAttempt` は、ジョブに自動ログインの試しの記録があるか。
 */
export const loginStageRowSourceOf = (
  job: { readonly jobKind: WorkerJobKind; readonly autoLoginAttempt: object | null },
  profileAuth: AuthStrategy,
): LoginStageRowSource => ({ jobKind: job.jobKind, autoLoginAttempt: job.autoLoginAttempt !== null, profileAuth });

// MI-C 項目 12 の `isAutomatedLoginProfileAuth`（プロファイルの方式が自動ログインか）と `newServiceOriginsOf`（新しく足す Origin。`newOriginsOf` に改名）は、
// MI-F1 で資格情報の送信先の不変条件の owner（`src/control/auth/credential-destination.ts`）へ移した。

/**
 * MI-G（設計書 4.7）: 自動ログインの文脈か（判定の唯一の場所）。自動ログインの試しのあるジョブ、ログインの確かめのジョブ（自動ログインだけの操作）、
 * 認証の方式が自動ログインのプロファイル（`isAutomatedLoginProfileAuth`）。この文脈の行からは、token の送信先と承認したサービスの Origin を足さない。
 * MI-C 項目 12: ジョブの画面は、この文脈の行に、認証の設定の画面を下書きつきで開くリンクを出さない（判定はサーバがこれで行い、画面に渡す）。
 */
export const isAutomatedLoginSource = (source: LoginStageRowSource): boolean =>
  source.autoLoginAttempt || source.jobKind === WORKER_LOGIN_CHECK_JOB_KIND || isAutomatedLoginProfileAuth(source.profileAuth);

/**
 * MI-F1（設計書 4.7.1 の 1）: 認証の設定の画面の下書きからの保存で、承認したサービスの Origin に足してよい Origin（ジョブの記録の行を、表の行の「登録する」と
 * 同じ部品（`loginStageRegistrationOf`・`observedDraftOfRegistration`・`approvedServiceOriginsToAdd`）で読み直した値。画面が送る Origin は信用しない）。
 * 自動ログインの文脈（`isAutomatedLoginSource`）の行からは足さない（MI-G と同じ理由）。手で入れる行（`MANUAL`）は、足す Origin がない。
 */
export const observedServiceOriginsOfRow = (input: {
  readonly row: WorkerLoginStageBlockedRequest;
  readonly source: LoginStageRowSource;
  readonly profile: ManualLoginRegistrationInput['profile'];
}):
  | { readonly ok: true; readonly origins: readonly string[] }
  | { readonly ok: false; readonly reason: Extract<LoginStageRowRegistrationRejection, 'NEW_TARGET_FROM_AUTOMATED_LOGIN'> } => {
  if (isAutomatedLoginSource(input.source)) {
    return { ok: false, reason: 'NEW_TARGET_FROM_AUTOMATED_LOGIN' };
  }
  const draft = observedDraftOfRegistration(loginStageRegistrationOf(input.row));
  return { ok: true, origins: draft === null ? Object.freeze([]) : approvedServiceOriginsToAdd(draft, input.profile) };
};

/** FM-1: 表の 1 行の「登録する」の入力（自動の登録の入力の、通した一覧の代わりに 1 行）。 */
export interface LoginStageRowRegistrationInput extends Omit<ManualLoginRegistrationInput, 'passedRequests'> {
  readonly row: WorkerLoginStageBlockedRequest;
  /** MI-G: 行の出どころ（自動ログインの文脈かを決める）。 */
  readonly source: LoginStageRowSource;
}

/** FM-1: 足すもの（確認のダイアログに出す。値を持たない。token の送信先の query は名前だけ）。 */
export type LoginStageRowAddition =
  | { readonly kind: 'TOKEN_TARGET'; readonly origin: string; readonly path: string; readonly queryNames: readonly string[] }
  | { readonly kind: 'SIDE_REQUEST'; readonly origin: string; readonly path: string; readonly method: LoginSideRequest['method']; readonly maxPerLoginStage: number };

/** FM-1: 表の 1 行の「登録する」の組み立ての結果。 */
export type LoginStageRowRegistration =
  | { readonly ok: true; readonly added: LoginStageRowAddition; readonly setup: AuthSetupV3; readonly addServiceOrigins: readonly string[] }
  | { readonly ok: false; readonly reason: LoginStageRowRegistrationRejection };

const rowRejected = (reason: LoginStageRowRegistrationRejection): LoginStageRowRegistration => ({ ok: false, reason });

/**
 * FM-1（設計書 2.1）: ログインの段の表（止めた送信・手動のログインの間に通した送信）の 1 行を、利用者が確かめて今の認証の設定に足す組み立て。行の振り分けは
 * 自動の登録と同じ部品（`loginStageRegistrationOf`）、読まないパス・危険な語の判定（`isExcludedReadPath`）、成功の鍵（`successStorageKeyOf`）、足す
 * Origin（`approvedServiceOriginsToAdd`）を使う。
 * - token の送信の行: token の送信先にする（今の送信先と違えば、利用者の選んだ行に替える。ログインに伴う送信は今のまま）。
 * - ほかの行: ログインに伴う送信として足す（回数は閉じた上限 `MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE`。自動の登録が足さない行（token の後の送信、
 *   別の Origin の送信）も、利用者は足せる。足す Origin は確認のダイアログに出す）。
 * - 版 2 のフォームの送信の設定は、版 3 のスクリプトで送るログインの設定にする。保存するプロファイルの改訂（`nextProfileRevision`）に結ぶ。
 * - MI-G（設計書 4.7）: 自動ログインの文脈（`isAutomatedLoginSource`）の行は、token の送信先を足さず、承認したサービスの Origin を足す送信も足さない
 *   （`NEW_TARGET_FROM_AUTOMATED_LOGIN`）。送信先の Origin がすでに承認したサービスの Origin か許可 Origin の中で、足す Origin のない、ログインに伴う送信だけ通す。
 */
export const loginStageRowRegistrationOf = (input: LoginStageRowRegistrationInput): LoginStageRowRegistration => {
  const { setup, profile, row, observation, nextProfileRevision, source } = input;
  const registration = loginStageRegistrationOf(row);
  if (registration.kind === 'MANUAL') {
    return rowRejected(registration.reason === 'REDACTED_PATH' ? 'REDACTED_PATH' : 'ALREADY_REGISTERED');
  }
  if (isExcludedReadPath(registration.path, setup.excludedPaths)) {
    return rowRejected('EXCLUDED_PATH');
  }
  const current = currentScriptLoginOf(setup);
  const sameTarget = (target: { readonly origin: string; readonly path: string } | null | undefined): boolean =>
    target !== null && target !== undefined && isOriginInAllowedOrigins([target.origin], registration.origin) && target.path === registration.path;
  let token: ScriptLoginTarget | null = current?.scriptLogin ?? null;
  const sides: LoginSideRequest[] = [...(current?.loginSideRequests ?? [])];
  let added: LoginStageRowAddition;
  if (registration.kind === 'TOKEN_TARGET') {
    if (sameTarget(token)) {
      return rowRejected('ALREADY_REGISTERED');
    }
    token = { origin: registration.origin, path: registration.path, requiredQuery: registration.requiredQuery.map(({ name, value }) => ({ name, value })) };
    added = { kind: 'TOKEN_TARGET', origin: registration.origin, path: registration.path, queryNames: registration.requiredQuery.map(({ name }) => name) };
  } else {
    if (token === null) {
      return rowRejected('NO_TOKEN_TARGET');
    }
    if (sameTarget(token) || sides.some((side) => sameTarget(side) && side.method === registration.method)) {
      return rowRejected('ALREADY_REGISTERED');
    }
    if (sides.length >= MAX_LOGIN_SIDE_REQUESTS) {
      return rowRejected('SIDE_REQUEST_LIMIT');
    }
    const side: LoginSideRequest = {
      origin: registration.origin, path: registration.path, method: registration.method, maxPerLoginStage: MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE,
    };
    sides.push(side);
    added = { kind: 'SIDE_REQUEST', ...side };
  }
  const addServiceOrigins = approvedServiceOriginsToAdd({ scriptLogin: token, sideRequests: sides }, profile);
  if (isAutomatedLoginSource(source) && (added.kind === 'TOKEN_TARGET' || addServiceOrigins.length > 0)) {
    return rowRejected('NEW_TARGET_FROM_AUTOMATED_LOGIN');
  }
  const successStorageKey = successStorageKeyOf(current, observation, profile);
  if (successStorageKey === null) {
    return rowRejected('NO_STORAGE_KEY');
  }
  const built: AuthSetupV3 = {
    ...setup,
    schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
    profileRevision: nextProfileRevision,
    loginTransport: SCRIPT_REQUEST_TRANSPORT,
    scriptLogin: token,
    loginSideRequests: sides,
    successStorageKey,
  };
  // MI-F1（設計書 4.7.1 の 3）: 自動ログインのプロファイルでは、送信先を変える登録を拒む（保存の部品の層と同じ判定。今の設定と登録の後の設定を比べる）。
  // 4.7 の「承認済みの Origin へのログインに伴う送信は、自動ログインのプロファイルでも足せる」は、4.7.1 の 3 で閉じた。
  const profileAuth: AuthStrategy = source.profileAuth;
  if (authSetupCredentialDestinationChangesOf({ beforeAuth: profileAuth, afterAuth: profileAuth, before: setup, after: built }).length > 0) {
    return rowRejected(CREDENTIAL_DESTINATION_LOCKED_REASON);
  }
  return { ok: true, added, setup: built, addServiceOrigins };
};

/** OP-1: ログインの直後の登録の組み立ての結果。 */
export interface LoginRegistrationAfterLogin {
  /** 次の改訂に結んだ認証の設定（版 3）。 */
  readonly setup: AuthSetupV3;
  /** プロファイルに足す承認したサービスの Origin。 */
  readonly addServiceOrigins: readonly string[];
  /** 今の設定から変わったか（改訂のほかに、送信先・成功の条件・読む範囲のパスのどれかが変わった）。 */
  readonly changed: boolean;
  /**
   * DEF-182: 自動ログインへ切り替えない理由（`TOKEN_TARGET_ON_TEST_ORIGIN`。token の送信先を登録できないので、手動のログインのまま）。切り替えてよければ `null`。
   */
  readonly automatedLoginBlocked: Extract<ManualLoginRegistrationSkipReason, 'TOKEN_TARGET_ON_TEST_ORIGIN'> | null;
}

/**
 * OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D3・D4。4.1.3 の 1）: 手動のログインの直後の登録を組み立てる（ジョブの管理が、点検の段の前に
 * 呼ぶ。保存は呼ぶ側が、自動ログインへの切り替えと一緒に `saveProfileAndAuthSetup` の 1 回で行う）。
 * - 送信先と承認したサービスの Origin は、今の自動の登録の部品（`manualLoginRegistrationOf`）のまま。組み立てられないとき（フォームの送信のログインで通した送信が
 *   ない、など）は、今の設定のまま（送信先を足さない）。
 * - 成功の条件が空（path もセレクタもない）なら、観察した成功の画面の path（`successPathPrefix`）で埋める（DEF-181 の守りで、空の条件は成功にならないため）。
 *   読む範囲のパスが、どれもセッションの切れの path（ログインの画面）に当たるときも、成功の画面の path にする（開始の URL がログインの画面のとき）。
 * - 結果はいつも `nextProfileRevision` に結ぶ。変わったかを `changed` で返す。
 */
export const loginRegistrationAfterLoginOf = (input: ManualLoginRegistrationInput): LoginRegistrationAfterLogin => {
  const { setup, observation, nextProfileRevision } = input;
  const built = manualLoginRegistrationOf(input);
  const base: AuthSetupV3 = built.ok ? built.setup : { ...setup, schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3, profileRevision: nextProfileRevision };
  const observedPath = observation?.successPathPrefix;
  const emptySuccess = isEmptySuccessCondition(base);
  const sessionLostPath = sessionLostPathPrefixOf(setup);
  const auditOnlyLoginPage = base.auditPathPrefixes.length > 0 && base.auditPathPrefixes.every((prefix) => prefix.startsWith(sessionLostPath));
  const next: AuthSetupV3 = observedPath === undefined
    ? base
    : {
      ...base,
      ...(emptySuccess ? { successCondition: { pathPrefix: observedPath, selector: null } } : {}),
      ...(auditOnlyLoginPage ? { auditPathPrefixes: [observedPath] } : {}),
    };
  const changed = built.ok || next.successCondition !== base.successCondition || next.auditPathPrefixes !== base.auditPathPrefixes;
  return {
    setup: next,
    addServiceOrigins: built.ok ? built.addServiceOrigins : [],
    changed,
    automatedLoginBlocked: !built.ok && built.reason === 'TOKEN_TARGET_ON_TEST_ORIGIN' ? built.reason : null,
  };
};

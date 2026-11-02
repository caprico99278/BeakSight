/**
 * 認証の設定の案（MI-3。設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 3 章の判断 3、4.3）。純粋な関数だけ（ジョブの管理、画面の
 * サーバ、ブラウザ側の認証の設定の画面が使う。案を組み立てる判断は、この 1 か所）。
 * - 開始の URL の path の案（T43b。読む範囲のパスと成功の画面の path）と、入口の確かめの案（T43c。`entry-check.json` の `proposal`）から、版 3 の
 *   認証の設定を作る。入口の確かめの案は、開始の URL の path の案より優先する。開始の URL の path で埋めた成功の画面の path が、ログインの画面の path
 *   （セッションの切れの path）に当たるなら、成功の画面の path は空にする（ログインの画面の path に当たる成功の条件は、検証が誤りにするため）。案のない
 *   項目は空のまま。読まないパスは空。回数の上限は、自動ログインなら固定の値、手動のログインなら下限。
 * - PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 10 章の PL-S の 8。MI の 4.7.1 の 6 の持ち越し）: 送り方の案がない（入口の確かめの案がない、か、案の
 *   送り方が `null`）ときは、フォームの送信先の案があればフォームの送信、なければ送信先のない形（スクリプトの送信。token の送信先は手動のログインの観察が
 *   入れる）にする。前の既定（送信先が空のフォームの送信）は、保存の検証を通らず、最初の保存の比べ（送信先のない形）にも当たらなかった。
 * - 入口の確かめの後に案で保存するか（`entryCheckAuthSetupDecisionOf`）: 認証の設定を使うプロファイルで、設定がまだなく、入口の確かめが「読んだ」で
 *   終わり、ログインの画面に見えたときだけ案を作る（`PROPOSE`）。保存の検証（`validateAuthSetup`）は、呼ぶ側が今の保存の部品で行う。
 * - 画面の側の状態（`ENTRY_CHECK_AUTH_SETUP_STATES`）は、この判定に、案が検証を通るか（`PROPOSAL_INVALID`）と、通るのに設定がない（`NOT_SAVED`。保存が
 *   改訂の衝突などで済まなかった）を足したもの。管理データには記録しない（設計者の判断。成果物と今の認証の設定から求める）。
 */
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  FORM_NAVIGATION_TRANSPORT,
  MIN_LOGIN_ATTEMPTS,
  SCRIPT_REQUEST_TRANSPORT,
  type AuthSetup,
} from './auth-setup-contracts.js';
import type { AuthStrategy, AuditMode } from '../contracts.js';
import type { EntryCheckDocument, EntryCheckProposal } from '../entry-check.js';
import { isProfileOperationAllowed } from '../execution-policy.js';

/** 開始の URL の path の案（読む範囲のパスと成功の画面の path）。 */
export interface AuthSetupDraft {
  readonly auditPathPrefixes: readonly string[];
  readonly successPathPrefix: string;
}

/** 開始の URL の path から、新しい認証の設定の案を作る（T43b）。path がなければ（対象の設定を読めない）、どちらも空。 */
export const authSetupDraftOf = (startUrlPath: string | null): AuthSetupDraft =>
  startUrlPath === null ? { auditPathPrefixes: [], successPathPrefix: '' } : { auditPathPrefixes: [startUrlPath], successPathPrefix: startUrlPath };

/** 認証の設定の、プロファイルに結びつける項目を除いた中身（画面の欄に写すときにも使う）。 */
export type AuthSetupBody = Omit<AuthSetup, 'schemaVersion' | 'profileId' | 'profileRevision'>;

/** 案を作る値。 */
export interface AuthSetupProposalInput {
  /** 認証の方式が自動ログインのプロファイルか（`execution-policy.ts` の `CREDENTIAL` の行）。 */
  readonly automated: boolean;
  /** 対象の設定の開始の URL の path（読めなければ `null`）。 */
  readonly startUrlPath: string | null;
  /** 入口の確かめの案（なければ `null`）。 */
  readonly entryProposal: EntryCheckProposal | null;
}

/** 開始の URL の path で埋めた成功の画面の path を、残すか（案のセッションの切れの path がそれで始まるなら残さない）。 */
const keepsStartUrlSuccessPath = (successPathPrefix: string, sessionLostPathPrefix: string | null): boolean =>
  successPathPrefix.length === 0 || sessionLostPathPrefix === null || !sessionLostPathPrefix.startsWith(successPathPrefix);

/** 案の中身（結びつけるプロファイルの項目を除く）。 */
export const proposedAuthSetupBodyOf = ({ automated, startUrlPath, entryProposal }: AuthSetupProposalInput): AuthSetupBody => {
  const draft = authSetupDraftOf(startUrlPath);
  const sessionLostPathPrefix = entryProposal?.sessionLostPathPrefix ?? null;
  const endpoint = entryProposal?.loginPostEndpoint ?? null;
  // PL-S: 送り方の案がなければ、フォームの送信先の案があるときだけフォームの送信。ほかは送信先のない形（最初の保存が通る形）。
  const transport = entryProposal?.loginTransport ?? (endpoint === null ? SCRIPT_REQUEST_TRANSPORT : FORM_NAVIGATION_TRANSPORT);
  const selectors = entryProposal?.selectors;
  return {
    loginStartUrl: entryProposal?.loginStartUrl ?? '',
    // フォームの送信先は、フォームの送信のときだけ（スクリプトで送るログインの送信先は、手動のログインの後の自動の登録が足す）。
    loginPostEndpoints: transport === FORM_NAVIGATION_TRANSPORT && endpoint !== null ? [{ origin: endpoint.origin, path: endpoint.path }] : [],
    successCondition: {
      pathPrefix: keepsStartUrlSuccessPath(draft.successPathPrefix, sessionLostPathPrefix) ? draft.successPathPrefix : '',
      selector: null,
    },
    sessionLostCondition: { pathPrefix: sessionLostPathPrefix },
    excludedPaths: [],
    auditPathPrefixes: [...draft.auditPathPrefixes],
    maxLoginAttempts: automated ? AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS : MIN_LOGIN_ATTEMPTS,
    allowedIdpOrigins: [],
    automatedLogin: automated
      ? {
        usernameSelector: selectors?.username ?? '',
        passwordSelector: selectors?.password ?? '',
        submitSelector: selectors?.submit ?? '',
        failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
      }
      : null,
    loginTransport: transport,
    scriptLogin: null,
    loginSideRequests: [],
    successStorageKey: null,
  };
};

/** 案の認証の設定（版 3。プロファイル `profileId` の改訂 `profileRevision` に結びつける）。 */
export const proposedAuthSetupOf = (
  input: AuthSetupProposalInput & { readonly profileId: string; readonly profileRevision: number },
): AuthSetup => ({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  profileId: input.profileId,
  profileRevision: input.profileRevision,
  ...proposedAuthSetupBodyOf(input),
});

/** プロファイルのモードと認証の方式から、案に要る事実（認証の設定を使うか、自動ログインか。`execution-policy.ts` の行の判定）。 */
export const authSetupProposalProfileOf = (mode: AuditMode, auth: AuthStrategy): { readonly usesAuthSetup: boolean; readonly automated: boolean } => ({
  usesAuthSetup: isProfileOperationAllowed('AUTH_SETUP', mode, auth),
  automated: isProfileOperationAllowed('CREDENTIAL', mode, auth),
});

/**
 * 入口の確かめの後の、認証の設定の状態（閉じた一覧。並びは判定の順）。
 * - `NOT_USED`: 認証の設定を使わないプロファイル。
 * - `PRESENT`: 認証の設定がある（入口の確かめの案から保存したものか、前からあったものかは区別しない。画面は文を出さず、次の段だけを案内する）。
 * - `NOT_CHECKED`: 入口の確かめの結果がない（まだ確かめていない、成果物を読めない）。
 * - `NOT_READ`: 入口の確かめが「読んだ」で終わっていない。
 * - `NOT_LOGIN_PAGE`: 読んだが、ログインの画面に見えなかった。
 * - `PROPOSAL_INVALID`: 案が保存の検証を通らない（画面のサーバが求める）。
 * - `NOT_SAVED`: 案は検証を通るのに、設定がない（保存が改訂の衝突などで済まなかった。画面のサーバが求める）。
 */
export const ENTRY_CHECK_AUTH_SETUP_STATES = Object.freeze([
  'NOT_USED',
  'PRESENT',
  'NOT_CHECKED',
  'NOT_READ',
  'NOT_LOGIN_PAGE',
  'PROPOSAL_INVALID',
  'NOT_SAVED',
] as const);
export type EntryCheckAuthSetupState = (typeof ENTRY_CHECK_AUTH_SETUP_STATES)[number];

/** 案で保存するかの判定（`PROPOSE` は、案を作って保存の検証にかける）。 */
export type EntryCheckAuthSetupDecision = Exclude<EntryCheckAuthSetupState, 'PROPOSAL_INVALID' | 'NOT_SAVED'> | 'PROPOSE';

/** 判定に使う事実。 */
export interface EntryCheckAuthSetupFacts {
  readonly usesAuthSetup: boolean;
  /** 認証の設定が保存してあるか（今の改訂に結びつかない古い設定も、ある）。 */
  readonly hasAuthSetup: boolean;
  /** 入口の確かめの結果（なければ `null`）。 */
  readonly entryCheck: Pick<EntryCheckDocument, 'endReason' | 'facts'> | null;
}

/** 入口の確かめの「読んだ」の終わり方。 */
const READ_END_REASON = 'READ' satisfies EntryCheckDocument['endReason'];

/** 入口の確かめの後に、案で認証の設定を保存するか（理由つき。並びは `ENTRY_CHECK_AUTH_SETUP_STATES` の順）。 */
export const entryCheckAuthSetupDecisionOf = ({ usesAuthSetup, hasAuthSetup, entryCheck }: EntryCheckAuthSetupFacts): EntryCheckAuthSetupDecision => {
  if (!usesAuthSetup) {
    return 'NOT_USED';
  }
  if (hasAuthSetup) {
    return 'PRESENT';
  }
  if (entryCheck === null) {
    return 'NOT_CHECKED';
  }
  if (entryCheck.endReason !== READ_END_REASON) {
    return 'NOT_READ';
  }
  return entryCheck.facts?.loginPage === true ? 'PROPOSE' : 'NOT_LOGIN_PAGE';
};

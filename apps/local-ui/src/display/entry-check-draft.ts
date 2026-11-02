/**
 * 入口の確かめの案と観察した要求の下書きを、認証の設定の欄に入れる部品（Task 43 の設計書 4.3、4.4。T43c、T43d）。純粋な関数だけ（ブラウザ側とサーバの両方が使う）。
 * - MI-3: 入口の確かめの案と開始の URL の path の案から、新しい認証の設定の値を作る判断（T43c の `entryCheckDraftOf`・`keepsStartUrlSuccessPath`）は、
 *   ジョブの管理と同じ 1 か所（`src/control/auth/auth-setup-proposal.ts` の `proposedAuthSetupBodyOf`）へ移した。
 * - T43d: 観察した要求の下書き（`observedDraftFieldsOf`）と、欄に入れる値の優先の順（ファイルの後半。この 1 か所）。
 */
import { MIN_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE, SCRIPT_REQUEST_TRANSPORT } from '../../../../src/control/auth/auth-setup-contracts.js';
import type { EntryCheckProposal } from '../../../../src/control/entry-check.js';
import type { ObservedAuthSetupDraft, ServiceOriginSources } from '../../../../src/control/login-observation-draft.js';

// ---------------------------------------------------------------------------------------------------------------
// T43d（Task 43 の設計書 4.4）: 観察した要求の下書き（ジョブの詳細の「登録する」「案を認証の設定に入れる」）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 認証の設定の画面の欄に入れる値の、優先の順（この 1 か所で決める。`AuthSetupForm.tsx` の `authSetupFormValuesOf` が、この順で重ねる）:
 * 1. 保存した設定の値。なければ、案の設定（MI-3 の `proposedAuthSetupBodyOf`。入口の確かめの案（T43c）を、開始の URL の path の案（T43b）と今の既定より
 *    優先する）。
 * 2. 観察した要求の下書き（T43d。保存した設定があっても入れる。利用者が URL で持ち込んだ下書きなので、いちばん新しい観察として前の値の上に入れる）。
 *    ログインに伴う送信だけは、今の一覧に「足す」（同じ Origin と path は重ねない。回数の上限は既定の 1）。成功の画面のセレクタは、入口の確かめで読んだ
 *    ログインの画面の欄の CSS と同じなら入れない（ログインの画面にもある要素）。下書きのない欄は、前の値のまま。
 */
export interface ObservedDraftFields {
  readonly loginTransport?: typeof SCRIPT_REQUEST_TRANSPORT;
  readonly scriptOrigin?: string;
  readonly scriptPath?: string;
  readonly requiredQuery?: readonly { readonly name: string; readonly value: string }[];
  readonly sideRequests?: readonly ObservedSideRequestField[];
  readonly storageOrigin?: string;
  readonly storagePrefix?: string;
  readonly storageSuffix?: string;
  readonly successSelector?: string;
}

/** ログインに伴う送信 1 つの欄の値（認証の設定の画面の行と同じ形）。 */
export interface ObservedSideRequestField {
  readonly origin: string;
  readonly path: string;
  readonly maxPerLoginStage: number;
}

/** 入口の確かめの案の、ログインの画面の欄の CSS（成功の画面のセレクタの下書きから外す）。 */
export const entryProposalSelectorsOf = (proposal: EntryCheckProposal | null): readonly string[] =>
  proposal === null ? [] : [proposal.selectors.username, proposal.selectors.password, proposal.selectors.submit].filter((selector) => selector !== null);

/** 下書きから、欄に入れる値（優先の順の 3）。`currentSideRequests` は前の値の一覧、`excludedSelectors` は入れない成功の画面のセレクタ。 */
export const observedDraftFieldsOf = (
  draft: ObservedAuthSetupDraft,
  currentSideRequests: readonly ObservedSideRequestField[],
  excludedSelectors: readonly string[],
): ObservedDraftFields => {
  const { scriptLogin, sideRequests, storageKey, successSelector } = draft;
  const added = (sideRequests ?? []).filter((side, index, all) =>
    !currentSideRequests.some((current) => current.origin === side.origin && current.path === side.path)
    && all.findIndex((other) => other.origin === side.origin && other.path === side.path) === index);
  return {
    ...(scriptLogin === undefined && sideRequests === undefined ? {} : { loginTransport: SCRIPT_REQUEST_TRANSPORT }),
    ...(scriptLogin === undefined ? {} : {
      scriptOrigin: scriptLogin.origin,
      scriptPath: scriptLogin.path,
      requiredQuery: scriptLogin.requiredQuery.map(({ name, value }) => ({ name, value })),
    }),
    ...(sideRequests === undefined ? {} : {
      sideRequests: [
        ...currentSideRequests.map((side) => ({ ...side })),
        ...added.map(({ origin, path }) => ({ origin, path, maxPerLoginStage: MIN_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE })),
      ],
    }),
    ...(storageKey === undefined ? {} : { storageOrigin: storageKey.origin, storagePrefix: storageKey.prefix, storageSuffix: storageKey.suffix }),
    ...(successSelector === undefined || excludedSelectors.includes(successSelector) ? {} : { successSelector }),
  };
};

/**
 * T43R-fix の M-3: 保存の時点の欄の値のうち、承認したサービスの Origin を要しうる Origin（スクリプトの送信のときの token の送信先と、ログインに伴う送信）。
 * 認証の設定の画面は、下書きのある画面の保存のときに、これからプロファイルに足す Origin を決め直す（`approvedServiceOriginsToAdd`）。
 */
export const serviceOriginSourcesOf = (values: {
  readonly loginTransport: string;
  readonly scriptOrigin: string;
  readonly sideRequests: readonly { readonly origin: string }[];
}): ServiceOriginSources => (values.loginTransport === SCRIPT_REQUEST_TRANSPORT
  ? { scriptLogin: { origin: values.scriptOrigin }, sideRequests: values.sideRequests.map(({ origin }) => ({ origin })) }
  : {});

/**
 * 認証の設定の Server Functions（Task 25 の設計書 4.1、4.5、4.6。T25e）。
 * - 読むだけのもの（設定の画面の値）は GET。保存は POST だけ。入力は、サーバで `schemas/control/` のスキーマ（`ui-profile-key`、
 *   `ui-auth-setup-save`、MI-F3 の `ui-auth-setup-excluded-paths-save`）で確かめてから使う（`requestOf`）。設定の文書そのものは、保存の部品（`saveAuthSetup`）が、保存してあるプロファイルを
 *   今のターゲット設定で検証し直してから、`validateAuthSetup` で検証する（画面の確かめは補助だけ）。
 * - ターゲット設定は、保存してあるプロファイルが指すパスだけを、`isAcceptedTargetConfigPath` を通してから読む（`loadTargetContext`）。
 * - 返す値は、表示に要るものだけ。検証の誤りは、コードと項目と行だけ（英語の詳細を返さない。`authSetupErrorViewsOf`）。
 * - 認証の設定は秘密を含まない文書（設計書 3 章）。この画面には、秘密（パスワード、Cookie の値）を受ける入力も、返す値もない。
 */
import { createServerFn } from '@tanstack/react-start';
import { startUrlPathOf } from '../../../../src/config/target-config-draft.js';
import type { AuthSetup } from '../../../../src/control/auth/auth-setup-contracts.js';
import { authSetupProposalProfileOf, proposedAuthSetupOf } from '../../../../src/control/auth/auth-setup-proposal.js';
import type { AuditMode, AuthStrategy, SiteProfile } from '../../../../src/control/contracts.js';
import type { ControlDatabase } from '../../../../src/control/store/control-database.js';
import { isRecord } from '../../../../src/core/guards.js';
import { newOriginsOf, type ProfileSaveGuardRejection } from '../../../../src/control/auth/credential-destination.js';
import { approvedServiceOriginsToAdd, type ServiceOriginSources } from '../../../../src/control/login-observation-draft.js';
import {
  loginStageRowRegistrationOf,
  observedServiceOriginsOfRow,
  type LoginStageRowRegistrationRejection,
} from '../../../../src/control/manual-login-registration.js';
import {
  AUTH_SETUP_STORE_REJECTION_REASONS,
  getAuthSetup,
  saveAuthSetup,
  type AuthSetupFreshness,
  type AuthSetupStoreRejectionReason,
  type StoredAuthSetup,
} from '../../../../src/control/store/auth-setup-store.js';
import { saveProfileAndAuthSetup } from '../../../../src/control/store/profile-auth-setup-store.js';
import type { ProfileStatus } from '../../../../src/control/store/profile-records.js';
import { getProfile, type ProfileStoreRejectionReason } from '../../../../src/control/store/profile-store.js';
import { usesAuthSetup } from '../display/labels';
import { authSetupErrorViewsOf, type AuthSetupErrorView } from './auth-setup-errors';
import { localUiStore } from './control-store';
import { latestEntryCheckProposalOf } from './entry-check-functions';
import { authSetupErrorViewsOfProfileAndAuthSetupSaveRejection } from './profile-auth-setup-save-rejection';
import {
  loginStageRowContextOf,
  type LoginStageRowContext,
  type LoginStageRowKeyRequest,
  type LoginStageRowRequestRejection,
} from './login-stage-registration-functions';
import { requestOf } from './request-validation';
import { loadTargetContext } from './target-config';
import { isoTimestampOf } from './timestamps';

// ---------------------------------------------------------------------------------------------------------------
// 画面に返す値
// ---------------------------------------------------------------------------------------------------------------

/** 認証の設定の画面の、プロファイルの要点。 */
export interface AuthSetupProfileView {
  readonly profileId: string;
  readonly revision: number;
  readonly mode: AuditMode;
  readonly auth: AuthStrategy;
  readonly status: ProfileStatus;
  readonly approvedTestOrigins: readonly string[];
  /** T34d: 承認したサービスの Origin（項目のないプロファイルは空）。 */
  readonly approvedServiceOrigins: readonly string[];
}

/** 保存してある認証の設定。 */
export interface StoredAuthSetupView {
  readonly setup: AuthSetup;
  /** 今のプロファイルの改訂に結びつくか（`CURRENT`）、古いか（`STALE`）。 */
  readonly freshness: AuthSetupFreshness;
  /** 最後に保存した日時（ISO 8601。表示は `formatDateTime`）。 */
  readonly updatedAt: string;
}

/** 認証の設定の画面の値。 */
export interface AuthSetupPageView {
  readonly profile: AuthSetupProfileView;
  /**
   * このプロファイルで認証の設定を使うか（認証の設定が要るモードで、今実行できる認証の方式。`execution-policy.ts` の判定）。偽なら、画面は
   * フォームを出さない。
   */
  readonly eligible: boolean;
  readonly stored: StoredAuthSetupView | null;
  /**
   * T43b（Task 43 の設計書 4.2）: プロファイルが指す対象の設定の開始の URL の path（新しい認証の設定の案に使う）。保存した設定があるときと、
   * 対象の設定を読めないときは `null`。
   */
  readonly startUrlPath: string | null;
}

/** 保存の結果。拒否のときは、理由と、検証の誤り（ないときは空）。 */
/**
 * MI-C 項目 12: 認証の設定の画面の保存が拒む理由（保存の部品の理由と、自動ログインのプロファイルに新しいサービスの Origin を足そうとしたときの、MI-G と
 * 同じ理由 `NEW_TARGET_FROM_AUTOMATED_LOGIN`）。文言は `AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS`（網羅は `catalog-coverage.ts`）。
 */
export type AuthSetupSaveRejectionReason =
  | AuthSetupStoreRejectionReason
  | Extract<LoginStageRowRegistrationRejection, 'NEW_TARGET_FROM_AUTOMATED_LOGIN'>
  // MI-F1（設計書 4.7.1 の 1）: 下書きからの保存で、ジョブの行の観察にない承認したサービスの Origin を足そうとした（プロファイルの作成・編集の口と同じ名前）。
  | Extract<ProfileSaveGuardRejection, 'SERVICE_ORIGIN_ADD_NOT_OBSERVED'>
  // MI-F3（設計書 4.3）: 監査の開始の画面の読まないパスの保存で、替える元の認証の設定が保存されていない（表の行の「登録する」と同じ名前）。
  | Extract<LoginStageRowRequestRejection, 'AUTH_SETUP_NOT_FOUND'>;

/** MI-F1: 観察からでない Origin の追加の理由の値。 */
const SERVICE_ORIGIN_ADD_NOT_OBSERVED = 'SERVICE_ORIGIN_ADD_NOT_OBSERVED' satisfies ProfileSaveGuardRejection;

export type AuthSetupSaveView =
  | { readonly ok: true; readonly stored: StoredAuthSetupView }
  | { readonly ok: false; readonly reason: AuthSetupSaveRejectionReason; readonly errors: readonly AuthSetupErrorView[] };

const storedViewOf = (stored: StoredAuthSetup): StoredAuthSetupView => ({
  setup: structuredClone(stored.setup),
  freshness: stored.freshness,
  updatedAt: isoTimestampOf(stored.updatedAt),
});

// ---------------------------------------------------------------------------------------------------------------
// 入力（形は `requestOf` でスキーマを使って確かめる）
// ---------------------------------------------------------------------------------------------------------------

interface ProfileKeyRequest {
  readonly profileId: string;
}
interface AuthSetupSaveRequest {
  readonly setup: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------------------------------------------
// Server Functions
// ---------------------------------------------------------------------------------------------------------------

/** 認証の設定の画面の値（プロファイルの要点と、保存してある設定）。プロファイルがなければ `null`。 */
export const getAuthSetupFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(async ({ data }): Promise<AuthSetupPageView | null> => {
    const database = localUiStore();
    const stored = getProfile(database, data.profileId);
    if (stored === null) {
      return null;
    }
    const { profile } = stored;
    const setup = getAuthSetup(database, profile.profileId);
    // T43b: 新しい認証の設定のときだけ、プロファイルが指す対象の設定（今の `loadTargetContext`）から開始の URL の path を読む。
    const startUrl = setup === null ? (await loadTargetContext(profile.targetConfigPath)).context?.targetConfig.site.startUrl : undefined;
    return {
      profile: {
        profileId: profile.profileId,
        revision: profile.revision,
        mode: profile.mode,
        auth: profile.auth,
        status: stored.status,
        approvedTestOrigins: [...profile.approvedTestOrigins],
        approvedServiceOrigins: [...(profile.approvedServiceOrigins ?? [])],
      },
      eligible: usesAuthSetup(profile.mode, profile.auth),
      stored: setup === null ? null : storedViewOf(setup),
      startUrlPath: startUrl === undefined ? null : (startUrlPathOf(startUrl) ?? null),
    };
  });

interface AuthSetupProfileSaveRequest {
  readonly setup: Readonly<Record<string, unknown>>;
  readonly expectedRevision: number;
  /** MI-F1: 下書きを作ったジョブの記録の行（足す Origin は、サーバがこの行から組み立て直す）。 */
  readonly row: LoginStageRowKeyRequest;
}

/**
 * MI-F1: 保存する設定（入力のまま）の、承認したサービスの Origin を要る送信先（token の送信先とログインに伴う送信の Origin。形の誤りは保存の部品の検証に
 * 任せるので、文字列の Origin だけを数える）。
 */
const serviceOriginSourcesOfDocument = (setup: Readonly<Record<string, unknown>>): ServiceOriginSources => {
  const originOf = (value: unknown): { readonly origin: string } | undefined =>
    isRecord(value) && typeof value['origin'] === 'string' ? { origin: value['origin'] } : undefined;
  const sides = setup['loginSideRequests'];
  return {
    scriptLogin: originOf(setup['scriptLogin']),
    sideRequests: Array.isArray(sides) ? sides.flatMap((side) => originOf(side) ?? []) : [],
  };
};

/**
 * T43d: プロファイルの保存の部品の理由を、認証の設定の画面の拒否の理由（閉じた一覧）に写す。同じ名前の理由はそのまま、ほか（改訂が進まない、保存して
 * あるプロファイルが壊れているなど）はプロファイルを通せない（`PROFILE_INVALID`）。
 */
const authSetupReasonOfProfile = (reason: ProfileStoreRejectionReason): AuthSetupStoreRejectionReason =>
  (AUTH_SETUP_STORE_REJECTION_REASONS as readonly string[]).includes(reason) ? reason as AuthSetupStoreRejectionReason : 'PROFILE_INVALID';

/**
 * MI-F5（設計書 4.7.1 の 6）: 行から開いた下書きの保存で受ける送信先の案（今保存してある設定に、行の観察を足した設定）。足し方は、表の行の「登録する」と同じ部品
 * （`loginStageRowRegistrationOf`。token の送信先は行の Origin・path・必須の query のまま、ログインに伴う送信は行の Origin・path・method）。保存の部品が、書き込みの
 * トランザクションの中で読んだプロファイルと今の設定で呼ぶ（行の出どころの方式も、そのプロファイルの方式）。設定がないとき、行を足せないとき（自動ログインの
 * 文脈、読まないパス、登録済みなど）は、案なし（今の設定の送信先だけを受ける）。
 */
const rowBaselinesOf = (rowContext: Extract<LoginStageRowContext, { ok: true }>, profile: SiteProfile, stored: AuthSetup | null): readonly AuthSetup[] => {
  if (stored === null) {
    return [];
  }
  const registration = loginStageRowRegistrationOf({
    setup: stored,
    profile: { approvedTestOrigins: profile.approvedTestOrigins, approvedServiceOrigins: profile.approvedServiceOrigins ?? [] },
    row: rowContext.row,
    observation: rowContext.observation,
    nextProfileRevision: profile.revision + 1,
    source: { ...rowContext.source, profileAuth: profile.auth },
  });
  return registration.ok ? [registration.setup] : [];
};

/**
 * T43d（Task 43 の設計書 4.4）: 認証の設定と、プロファイルの承認したサービスの Origin に足す Origin を、1 回で保存する（管理データの 1 つの
 * トランザクション。`saveProfileAndAuthSetup`）。プロファイルの次の改訂は、保存してあるプロファイルに Origin を足したもの（画面が読んだ改訂
 * `expectedRevision` の照合を保つ）。認証の設定は、その次の改訂に結びつけて送る。
 * MI-F1（安全。設計書 4.7.1 の 1。MI-C 項目 12 の守りを置き換えた）: ブラウザが送る Origin を信用しない。足す Origin は、保存する設定が要る送信先のうち
 * プロファイルにまだないもの（`approvedServiceOriginsToAdd`）で、そのすべてが、下書きを作ったジョブの記録の行から組み立て直した Origin
 * （`observedServiceOriginsOfRow`。表の行の「登録する」と同じ部品で行を読む `loginStageRowContextOf`）の中にあるときだけ足す。行が自動ログインの文脈
 * （自動ログインのプロファイルを含む）なら `NEW_TARGET_FROM_AUTOMATED_LOGIN`、行がない・別のプロファイルのジョブ・行の観察にない Origin を足すなら
 * `SERVICE_ORIGIN_ADD_NOT_OBSERVED` で、何も保存せずに拒む（URL を手で作った下書きから足さない）。
 * MI-F5（安全。設計書 4.7.1 の 6・7。再レビュー MI-R2 の Critical C-A の 3c・Minor M-1）:
 * - 画面が読んだ改訂（`expectedRevision`）と今の改訂を先に照らし、違えば `PROFILE_REVISION_CONFLICT`（読んだ値から組み立てた次の改訂で、別の保存を黙って戻さない）。
 *   保存の部品も、書き込みのトランザクションの中で同じ改訂を照らす。
 * - 送信先は、Origin だけでなく path と必須の query も、行の観察と照らす: 保存の部品が、書き込みのトランザクションの中で、今保存してある設定か、それに行の観察を
 *   足した設定（`rowBaselinesOf`）と同じ送信先だけを受ける（違えば `CREDENTIAL_DESTINATION_OBSERVED_ONLY`。方式によらない）。
 * - 足す Origin がない（行の Origin が承認済み）ときは、プロファイルを変えず、認証の設定だけを今の改訂で保存する（改訂を進めない）。設定の結びつく改訂は、サーバが
 *   決める（足すときは次の改訂、足さないときは今の改訂）。
 */
export const saveAuthSetupWithServiceOriginsFn = createServerFn({ method: 'POST' })
  .validator(requestOf<AuthSetupProfileSaveRequest>('ui-auth-setup-profile-save'))
  .handler(async ({ data }): Promise<AuthSetupSaveView> => {
    const database = localUiStore();
    const profileId = data.setup['profileId'];
    const current = typeof profileId === 'string' ? getProfile(database, profileId) : null;
    if (current === null) {
      return { ok: false, reason: 'PROFILE_NOT_FOUND', errors: [] };
    }
    if (current.profile.revision !== data.expectedRevision) {
      return { ok: false, reason: 'PROFILE_REVISION_CONFLICT', errors: [] };
    }
    const services = [...(current.profile.approvedServiceOrigins ?? [])];
    const profile = { approvedTestOrigins: current.profile.approvedTestOrigins, approvedServiceOrigins: services };
    const rowContext = loginStageRowContextOf(database, data.row);
    if (!rowContext.ok || rowContext.profile.profile.profileId !== current.profile.profileId) {
      return { ok: false, reason: SERVICE_ORIGIN_ADD_NOT_OBSERVED, errors: [] };
    }
    const observed = observedServiceOriginsOfRow({ row: rowContext.row, source: rowContext.source, profile });
    if (!observed.ok) {
      return { ok: false, reason: observed.reason, errors: [] };
    }
    const added = approvedServiceOriginsToAdd(serviceOriginSourcesOfDocument(data.setup), profile);
    if (newOriginsOf(observed.origins, added).length > 0) {
      return { ok: false, reason: SERVICE_ORIGIN_ADD_NOT_OBSERVED, errors: [] };
    }
    const targetConfigPath = current.profile.targetConfigPath;
    const { context } = await loadTargetContext(targetConfigPath);
    const resolveContext = (path: string) => (path === targetConfigPath ? context : undefined);
    const observedDestinationsOnly = { baselinesOf: (profile: SiteProfile, stored: AuthSetup | null) => rowBaselinesOf(rowContext, profile, stored) };
    if (added.length === 0) {
      return saveSetupResultOf(saveAuthSetup(database, { ...data.setup, profileRevision: data.expectedRevision }, { resolveContext, observedDestinationsOnly }));
    }
    const next = { ...current.profile, revision: data.expectedRevision + 1, approvedServiceOrigins: [...services, ...added] };
    const result = saveProfileAndAuthSetup(database, {
      profile: next, expectedRevision: data.expectedRevision, setup: { ...data.setup, profileRevision: data.expectedRevision + 1 },
    }, { resolveContext, observedDestinationsOnly });
    if (result.ok) {
      return { ok: true, stored: storedViewOf(result.stored) };
    }
    return {
      ok: false,
      reason: result.part === 'AUTH_SETUP' ? result.reason : authSetupReasonOfProfile(result.reason),
      errors: authSetupErrorViewsOfProfileAndAuthSetupSaveRejection(result),
    };
  });

/** 認証の設定の保存の部品の結果を、画面の結果に写す。 */
const saveSetupResultOf = (result: ReturnType<typeof saveAuthSetup>): AuthSetupSaveView => (result.ok
  ? { ok: true, stored: storedViewOf(result.stored) }
  : { ok: false, reason: result.reason, errors: authSetupErrorViewsOf(result.errors) });

/**
 * 認証の設定の文書を、今の保存の部品（`saveAuthSetup`。検証 `validateAuthSetup` と改訂の照合）で保存し、画面の結果に写す（`saveAuthSetupFn` と
 * `saveExcludedPathsFn` が共用する）。保存の部品は、保存してあるプロファイルの指すパスを `isAcceptedTargetConfigPath` で確かめてから、`resolveContext` を
 * 呼ぶ。ここでは、そのパス（`targetConfigPath`）だけを先に読む（読めなければ文脈なし）。
 * MI-F5（設計書 4.7.1 の 6）: 画面の保存の口なので、いつも保存の部品に送信先の選択肢（`observedDestinationsOnly`）を渡す（方式によらず、今保存してある設定から
 * 送信先を変える保存を拒む）。設定がまだないときの最初の保存は、`firstSaveBaselines`（そのプロファイルの最後の入口の確かめの案）か、送信先のない形と同じときだけ
 * 受ける。
 */
const saveSetupDocument = async (
  database: ControlDatabase,
  setup: unknown,
  targetConfigPath: string | undefined,
  firstSaveBaselines: readonly AuthSetup[],
): Promise<AuthSetupSaveView> => {
  const { context } = await loadTargetContext(targetConfigPath);
  return saveSetupResultOf(saveAuthSetup(database, setup, {
    resolveContext: (path) => (path === targetConfigPath ? context : undefined),
    observedDestinationsOnly: { baselinesOf: (_profile, stored) => (stored === null ? firstSaveBaselines : []) },
  }));
};

/**
 * MI-F5（設計書 4.7.1 の 6）: 認証の設定がまだないときの最初の保存で受ける送信先の案（そのプロファイルの最後の成功した入口の確かめの案から、ジョブの管理が案で
 * 保存するときと同じ部品 `proposedAuthSetupOf` で作った設定。案がなければ空）。比べるのは送信先の項目だけなので、開始の URL の path は使わない。
 */
const firstSaveBaselinesOf = async (profile: SiteProfile): Promise<readonly AuthSetup[]> => {
  const entryProposal = await latestEntryCheckProposalOf(profile.profileId);
  if (entryProposal === null) {
    return [];
  }
  const { automated } = authSetupProposalProfileOf(profile.mode, profile.auth);
  return [proposedAuthSetupOf({ profileId: profile.profileId, profileRevision: profile.revision, automated, startUrlPath: null, entryProposal })];
};

/**
 * 認証の設定を保存する（プロファイルごとに 1 つ。あれば置き換える）。MI-F5（安全。設計書 4.7.1 の 6）: ログインの送信先は、入口の確かめと手動のログインの観察から
 * だけ入る。方式によらず、認証の設定があるときは送信先の項目を変える保存を拒み、ないときは入口の確かめの案と同じ送信先（か送信先のない形）だけを受ける
 * （`CREDENTIAL_DESTINATION_OBSERVED_ONLY`。判定は保存の部品のトランザクションの中。送信先でない欄は今どおり）。
 */
export const saveAuthSetupFn = createServerFn({ method: 'POST' })
  .validator(requestOf<AuthSetupSaveRequest>('ui-auth-setup-save'))
  .handler(async ({ data }): Promise<AuthSetupSaveView> => {
    const database = localUiStore();
    const profileId = data.setup['profileId'];
    const current = typeof profileId === 'string' ? getProfile(database, profileId) : null;
    // 設定がすでにあれば、最初の保存の案は要らない（認証の設定を消す操作はないので、トランザクションの中でなくなることはない。なくなっても、送信先のない形だけを
    // 受ける）。
    const firstSaveBaselines = current === null || getAuthSetup(database, current.profile.profileId) !== null ? [] : await firstSaveBaselinesOf(current.profile);
    return saveSetupDocument(database, data.setup, current?.profile.targetConfigPath, firstSaveBaselines);
  });

interface ExcludedPathsSaveRequest {
  readonly profileId: string;
  /** 画面が読んだプロファイルの改訂。 */
  readonly expectedRevision: number;
  readonly excludedPaths: readonly string[];
}

/**
 * MI-F3（独立レビュー MI-R の Minor 5。設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.3）: 監査の開始の画面の「読まないパス」を保存する。
 * 画面が読んだ時の認証の設定の全体を受けない（別のタブで保存した変更を、黙って古い値に戻さない）。サーバが今保存してある認証の設定を読み、読まないパスだけを
 * 替えて、今の保存の部品で保存する（`saveSetupDocument`。検証と改訂の照合は認証の設定の画面の保存と同じ）。画面が読んだ改訂（`expectedRevision`）が今の
 * プロファイルの改訂と違えば `PROFILE_REVISION_CONFLICT`、プロファイルがなければ `PROFILE_NOT_FOUND`、認証の設定がなければ `AUTH_SETUP_NOT_FOUND` で、何も
 * 保存しない。保存してある設定の改訂（`profileRevision`）は替えない（古い改訂の設定は、今どおり保存の検証が拒む）。
 */
export const saveExcludedPathsFn = createServerFn({ method: 'POST' })
  .validator(requestOf<ExcludedPathsSaveRequest>('ui-auth-setup-excluded-paths-save'))
  .handler(async ({ data }): Promise<AuthSetupSaveView> => {
    const database = localUiStore();
    const current = getProfile(database, data.profileId);
    if (current === null) {
      return { ok: false, reason: 'PROFILE_NOT_FOUND', errors: [] };
    }
    if (current.profile.revision !== data.expectedRevision) {
      return { ok: false, reason: 'PROFILE_REVISION_CONFLICT', errors: [] };
    }
    const stored = getAuthSetup(database, data.profileId);
    if (stored === null) {
      return { ok: false, reason: 'AUTH_SETUP_NOT_FOUND', errors: [] };
    }
    return saveSetupDocument(database, { ...stored.setup, excludedPaths: [...data.excludedPaths] }, current.profile.targetConfigPath, []);
  });

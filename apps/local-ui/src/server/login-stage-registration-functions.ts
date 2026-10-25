/**
 * FM-1（設計書 `doc/design/2026-10-19-beaksight-fewer-manual-steps-design.md` の 2.1）: ジョブの詳細のログインの段の表（止めた送信・手動のログインの間に
 * 通した送信）の「登録する」を、確認のダイアログの後に、その場で保存する Server Function。画面は移らない。
 * - 案（`loginStageRowProposalFn`。GET）: ジョブの記録の行と、ジョブのログインの観察（成功の鍵の案）と、今のプロファイルと認証の設定から、自動の登録と
 *   同じ部品（`loginStageRowRegistrationOf`）で、足すもの（token の送信先か、ログインに伴う送信と回数）と、足す承認したサービスの Origin と、保存する
 *   プロファイルの改訂を返す。足せない行は、理由を返す。
 * - 保存（`registerLoginStageRowFn`。POST。CSRF は画面のサーバの middleware）: ダイアログが出した改訂（`expectedProfileRevision`）で、サーバの側で
 *   組み立て直し、プロファイル（承認したサービスの Origin を足し、改訂を進める）と認証の設定を 1 回で保存する（`saveProfileAndAuthSetup`。検証は保存の部品）。
 * 値（パスワード、token、query の値）は返さない（token の送信先の query は名前だけ）。
 */
import { createServerFn } from '@tanstack/react-start';
import { readJob } from '../../../../src/control/job/job-store.js';
import {
  loginStageRowRegistrationOf,
  type LoginStageRowAddition,
  type LoginStageRowRegistration,
  type LoginStageRowRegistrationRejection,
} from '../../../../src/control/manual-login-registration.js';
import { getAuthSetup } from '../../../../src/control/store/auth-setup-store.js';
import { saveProfileAndAuthSetup } from '../../../../src/control/store/profile-auth-setup-store.js';
import { getProfile, type StoredProfile } from '../../../../src/control/store/profile-store.js';
import { localUiStore } from './control-store';
import { requestOf } from './request-validation';
import { loadTargetContext } from './target-config';

/** 表の 1 行の指定（`passed` は、手動のログインの間に通した送信の表か、止めた送信の表か）。 */
interface LoginStageRowKeyRequest {
  readonly jobId: string;
  readonly passed: boolean;
  readonly index: number;
}

interface LoginStageRowRegisterRequest extends LoginStageRowKeyRequest {
  readonly expectedProfileRevision: number;
}

/**
 * 画面のサーバの理由（閉じた一覧）。
 * - `JOB_NOT_FOUND`: ジョブがない。`ROW_NOT_FOUND`: 表にその行がない。
 * - `PROFILE_NOT_FOUND`: プロファイルがない。`AUTH_SETUP_NOT_FOUND`: 認証の設定がない。
 * - `PROFILE_CHANGED`: ダイアログを出した後に、プロファイルが変わった（読み直して、もう一度押す）。
 * - `SAVE_REJECTED`: 保存の部品（プロファイルと認証の設定の検証）が拒んだ（理由のコードを添える）。
 */
export const LOGIN_STAGE_ROW_REQUEST_REJECTIONS = Object.freeze([
  'JOB_NOT_FOUND',
  'ROW_NOT_FOUND',
  'PROFILE_NOT_FOUND',
  'AUTH_SETUP_NOT_FOUND',
  'PROFILE_CHANGED',
  'SAVE_REJECTED',
] as const);
export type LoginStageRowRequestRejection = (typeof LOGIN_STAGE_ROW_REQUEST_REJECTIONS)[number];

/** 拒んだ理由（組み立ての理由と、画面のサーバの理由）。 */
export type LoginStageRowRejectionReason = LoginStageRowRegistrationRejection | LoginStageRowRequestRejection;

/** 案（確認のダイアログに出す）。 */
export type LoginStageRowProposalView =
  | {
    readonly ok: true;
    readonly profileId: string;
    /** 今のプロファイルの改訂（保存のときに渡す）。 */
    readonly profileRevision: number;
    readonly added: LoginStageRowAddition;
    readonly addServiceOrigins: readonly string[];
  }
  | { readonly ok: false; readonly reason: LoginStageRowRejectionReason };

/** 保存の結果。 */
export type LoginStageRowRegisterView =
  | { readonly ok: true; readonly profileRevision: number; readonly added: LoginStageRowAddition; readonly addServiceOrigins: readonly string[] }
  | { readonly ok: false; readonly reason: LoginStageRowRejectionReason; readonly codes: readonly string[] };

/** 組み立ての材料と結果（今のプロファイルと、そのときの組み立て）。 */
type Built =
  | { readonly ok: true; readonly profile: StoredProfile; readonly registration: LoginStageRowRegistration }
  | { readonly ok: false; readonly reason: LoginStageRowRequestRejection };

/** ジョブの記録の行と観察、今のプロファイルと認証の設定から組み立てる。 */
const buildOf = (request: LoginStageRowKeyRequest): Built => {
  const database = localUiStore();
  const job = readJob(database, request.jobId);
  if (job === null) {
    return { ok: false, reason: 'JOB_NOT_FOUND' };
  }
  const list = request.passed ? job.loginStage?.passedRequests : job.loginStage?.blockedRequests ?? undefined;
  const row = list?.requests[request.index];
  if (row === undefined) {
    return { ok: false, reason: 'ROW_NOT_FOUND' };
  }
  const profile = getProfile(database, job.profileId);
  if (profile === null) {
    return { ok: false, reason: 'PROFILE_NOT_FOUND' };
  }
  const stored = getAuthSetup(database, job.profileId);
  if (stored === null) {
    return { ok: false, reason: 'AUTH_SETUP_NOT_FOUND' };
  }
  const registration = loginStageRowRegistrationOf({
    setup: stored.setup,
    profile: { approvedTestOrigins: profile.profile.approvedTestOrigins, approvedServiceOrigins: profile.profile.approvedServiceOrigins ?? [] },
    row,
    observation: job.loginStage?.observation,
    nextProfileRevision: profile.profile.revision + 1,
  });
  return { ok: true, profile, registration };
};

/** 表の 1 行の「登録する」の案（確認のダイアログに出す。保存しない）。 */
export const loginStageRowProposalFn = createServerFn({ method: 'GET' })
  .validator(requestOf<LoginStageRowKeyRequest>('ui-login-stage-row-key'))
  .handler(({ data }): LoginStageRowProposalView => {
    const built = buildOf(data);
    if (!built.ok) {
      return built;
    }
    const { profile, registration } = built;
    return registration.ok
      ? { ok: true, profileId: profile.profile.profileId, profileRevision: profile.profile.revision, added: registration.added, addServiceOrigins: registration.addServiceOrigins }
      : { ok: false, reason: registration.reason };
  });

/** 表の 1 行の「登録する」（確認のダイアログの後。その場で保存する）。 */
export const registerLoginStageRowFn = createServerFn({ method: 'POST' })
  .validator(requestOf<LoginStageRowRegisterRequest>('ui-login-stage-row-register'))
  .handler(async ({ data }): Promise<LoginStageRowRegisterView> => {
    const built = buildOf(data);
    if (!built.ok) {
      return { ...built, codes: [] };
    }
    const { profile, registration } = built;
    if (profile.profile.revision !== data.expectedProfileRevision) {
      return { ok: false, reason: 'PROFILE_CHANGED', codes: [] };
    }
    if (!registration.ok) {
      return { ok: false, reason: registration.reason, codes: [] };
    }
    const { targetConfigPath } = profile.profile;
    const { context } = await loadTargetContext(targetConfigPath);
    const services = [...(profile.profile.approvedServiceOrigins ?? [])];
    const result = saveProfileAndAuthSetup(localUiStore(), {
      profile: { ...profile.profile, revision: data.expectedProfileRevision + 1, approvedServiceOrigins: [...services, ...registration.addServiceOrigins] },
      expectedRevision: data.expectedProfileRevision,
      setup: registration.setup,
    }, {
      resolveContext: (path) => (path === targetConfigPath ? context : undefined),
    });
    if (result.ok) {
      return { ok: true, profileRevision: result.profile.profile.revision, added: registration.added, addServiceOrigins: registration.addServiceOrigins };
    }
    if (result.part === 'PROFILE' && result.reason === 'PROFILE_REVISION_CONFLICT') {
      return { ok: false, reason: 'PROFILE_CHANGED', codes: [] };
    }
    return { ok: false, reason: 'SAVE_REJECTED', codes: [result.reason, ...result.errors.map(({ code }) => code)] };
  });

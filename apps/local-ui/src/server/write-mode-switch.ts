/**
 * MI-5（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 3 章のユーザーの判断 1、4.5、5 章）: 「書き込みにも使う」の画面のサーバの処理。
 * 認証つきの読み取りの監査（`TEST_AUTH_PASSIVE`）で、認証の設定がある有効なプロファイルを、監査モードを書き込みのモード（`WRITE_AUDIT_MODE`）にした次の改訂と
 * して保存する（確認のダイアログの後）。サーバだけで使う。OP-3: 呼ぶのは、一覧のチェックの保存（`write-screen-functions.ts`）と、段の事実（`profile-onboarding-functions.ts`）だけ（前の 2 つの Server Function は消した）。
 * - 案（`writeModeSwitchProposalOf`）: 確認のダイアログに出す値（今と次の改訂、隔離が未確認か（`isolation-evidence-ref.ts`）と参照、承認が外れるシナリオの数
 *   （FM2e と同じ部品 `approvedScenarioCountOf`））。対象でないプロファイルは `null`。
 * - 保存（`switchToWriteMode`）: プロファイルの次の改訂（モードだけを変える）と、その改訂に結びつけ直した認証の設定（中身は変えない）を、今の保存の部品
 *   （`saveProfileAndAuthSetup`。`validateSiteProfile`・`validateAuthSetup`・改訂の照合を 1 つのトランザクションで）で書く。プロファイルの改訂だけを進めると
 *   認証の設定が古い（`STALE`）になるため。資格情報（同じプロファイルの資格情報のファイル）・承認したサービスの Origin・設定のファイル・環境の証跡の参照は
 *   変えない（同じプロファイルのまま）。表示の設定（ジョブのブラウザ、監査の段の送信の扱い）は改訂の外なので、そのまま。
 * - 対象（`offersWriteMode`）: 有効で、書き込みのモードでなく、認証の設定を使い（`usesAuthSetup`）、書き込みのモードで同じ方式のシナリオを使える
 *   （`usesScenarios`）プロファイル。判定は `execution-policy.ts` の行（`labels.ts` の部品）だけで、モードの値の文字列を比べない。公開のプロファイル、
 *   すでに書き込みのモードのプロファイル、取り消したプロファイルは `NOT_OFFERED`。認証の設定がない・古いプロファイルは `AUTH_SETUP_NOT_CURRENT`。
 * - 書き込みのモードから戻す操作は作らない（詳しい設定の編集で戻せる。設計書 4.5）。
 */
import { MAX_ENVIRONMENT_EVIDENCE_REF_LENGTH, WRITE_AUDIT_MODE } from '../../../../src/control/contracts.js';
import { isSecretLikeText } from '../../../../src/core/secret-like-text.js';
import type { ProfileContextResolver } from '../../../../src/control/store/profile-store.js';
import { CURRENT_AUTH_SETUP_FRESHNESS, getAuthSetup } from '../../../../src/control/store/auth-setup-store.js';
import type { ControlDatabase } from '../../../../src/control/store/control-database.js';
import { saveProfileAndAuthSetup, type ProfileAndAuthSetupSaveResult } from '../../../../src/control/store/profile-auth-setup-store.js';
import { ACTIVE_PROFILE_STATUS } from '../../../../src/control/store/profile-records.js';
import { getProfile, type StoredProfile } from '../../../../src/control/store/profile-store.js';
import { usesAuthSetup, usesScenarios } from '../display/labels';
import { localUiStore } from './control-store';
import { approvedScenarioCountOf } from './scenario-facts';
import type { AuthSetupErrorView } from './auth-setup-errors';
import { authSetupErrorViewsOfProfileAndAuthSetupSaveRejection, reasonOfProfileAndAuthSetupSaveRejection } from './profile-auth-setup-save-rejection';
import { isIsolationUnverifiedEvidenceRef, isolationUnverifiedEvidenceRefOf } from './isolation-evidence-ref';

/** 処理が使う部品（本番は `profile-functions.ts` が渡す）。 */
export interface WriteModeSwitchDependencies {
  readonly database: ControlDatabase;
  readonly now: () => Date;
  /** 今承認が有効なシナリオの数（本番は `scenario-facts.ts` の `approvedScenarioCountOf`。FM2e の確認のダイアログと同じ部品）。 */
  readonly approvedScenarioCount: (stored: StoredProfile) => Promise<number>;
}

/**
 * MI-5・CC-118（PL-TD）: 本番の部品（画面のサーバの管理データ、今の時刻、承認が外れるシナリオの数。FM2e の確認のダイアログと同じ部品
 * `approvedScenarioCountOf`）の組み立ての 1 か所。「書き込みにも使う」の Server Function（`profile-functions.ts`）と、サイトの画面の要点
 * （`profile-onboarding-functions.ts`）が使う。Server Function のファイルから公開すると、ブラウザの束にサーバの部品が入るので、ここに置く。
 */
export const localUiWriteModeSwitchDependencies = (): WriteModeSwitchDependencies => ({
  database: localUiStore(),
  now: () => new Date(),
  approvedScenarioCount: approvedScenarioCountOf,
});

/** 確認のダイアログに出す値（対象のプロファイルだけ）。 */
export interface WriteModeSwitchProposalView {
  /** 今の改訂。 */
  readonly profileRevision: number;
  /** 保存の後の改訂。 */
  readonly nextProfileRevision: number;
  /** 認証の設定が今の改訂に結びつくか（偽なら保存できない。画面はボタンを出さずに理由を出す）。 */
  readonly authSetupCurrent: boolean;
  /** 環境の証跡の参照（秘密でない。そのまま出す）。 */
  readonly environmentEvidenceRef: string | null;
  /** 参照が、隔離が未確認であることを示す形か（`isolation-unverified-` で始まる）。 */
  readonly isolationUnverified: boolean;
  /** 保存で承認が外れる、今承認が有効なシナリオの数。 */
  readonly approvedScenarioCount: number;
}

/**
 * 保存の要求（画面が読んだ今の改訂）。PL-5（設計書 `2026-10-26-beaksight-plain-ui-design.md` 6 章の 6、PL-1 の判断 3）: 隔離の扱いは確認のダイアログの 2 択。
 * 「確かめた記録がある」を選んだときだけ、その参照（`isolationEvidenceRef`。前後の空白は除く）を送る。省けば「本番から切り離されているか、まだ確かめていない」
 * （既定）で、保存の日の未確認の参照（`isolationUnverifiedEvidenceRefOf`）を作る。どちらも、今の参照（作成の時の未確認の参照など）を置き換える。
 */
export interface WriteModeSwitchRequest {
  readonly profileId: string;
  readonly expectedRevision: number;
  readonly isolationEvidenceRef?: string;
}

/**
 * 保存を拒む理由（閉じた一覧）。OP-3: 画面に出すのは、チェックの保存（`write-screen-functions.ts`）の 1 行（`MODE_SWITCH_FAILED`）だけで、理由ごとの文言は
 * 持たない（確認のダイアログをなくしたため）。
 */
export const WRITE_MODE_SWITCH_REJECTION_REASONS = Object.freeze([
  'PROFILE_NOT_FOUND',
  'NOT_OFFERED',
  'PROFILE_REVISION_CONFLICT',
  'AUTH_SETUP_NOT_CURRENT',
  'TARGET_CONFIG_UNAVAILABLE',
  // PL-5: 「確かめた記録がある」の参照が空か、長すぎる（プロファイルの参照の上限）。
  'ISOLATION_REFERENCE_INVALID',
  // PL-F 修正の 1 回目（PL-REV の Minor 2）: 参照が秘密に見える（判定は `isSecretLikeText`。詳しい内容の編集の検証と同じコード）。
  'ISOLATION_REFERENCE_SECRET_LIKE',
  'PROFILE_INVALID',
  'AUTH_SETUP_INVALID',
  'SAVE_FAILED',
] as const);
export type WriteModeSwitchRejectionReason = (typeof WRITE_MODE_SWITCH_REJECTION_REASONS)[number];

/** 保存の結果。 */
export type WriteModeSwitchResultView =
  | { readonly ok: true; readonly profileRevision: number }
  | { readonly ok: false; readonly reason: WriteModeSwitchRejectionReason; readonly authSetupErrors: readonly AuthSetupErrorView[] };

/** 保存の選択肢（プロファイルの指す対象の設定の文脈。呼び出し側が先に読む）。 */
export interface WriteModeSwitchOptions {
  readonly resolveContext: ProfileContextResolver;
}

const NO_AUTH_SETUP_ERRORS: readonly AuthSetupErrorView[] = Object.freeze([]);

const rejection = (reason: WriteModeSwitchRejectionReason, authSetupErrors: readonly AuthSetupErrorView[] = NO_AUTH_SETUP_ERRORS): WriteModeSwitchResultView =>
  Object.freeze({ ok: false, reason, authSetupErrors });

/** 「書き込みにも使う」を出すプロファイルか（判定はファイルの先頭）。 */
const offersWriteMode = (stored: StoredProfile): boolean => {
  const { mode, auth } = stored.profile;
  return stored.status === ACTIVE_PROFILE_STATUS && mode !== WRITE_AUDIT_MODE && usesAuthSetup(mode, auth) && usesScenarios(WRITE_AUDIT_MODE, auth);
};

/** 確認のダイアログに出す値（対象でない、プロファイルがない、認証の設定がないなら `null`）。 */
export const writeModeSwitchProposalOf = async (
  deps: WriteModeSwitchDependencies,
  profileId: string,
): Promise<WriteModeSwitchProposalView | null> => {
  const stored = getProfile(deps.database, profileId);
  if (stored === null || !offersWriteMode(stored)) {
    return null;
  }
  const setup = getAuthSetup(deps.database, profileId);
  if (setup === null) {
    return null;
  }
  const { revision, environmentEvidenceRef } = stored.profile;
  return Object.freeze({
    profileRevision: revision,
    nextProfileRevision: revision + 1,
    authSetupCurrent: setup.freshness === CURRENT_AUTH_SETUP_FRESHNESS,
    environmentEvidenceRef,
    isolationUnverified: isIsolationUnverifiedEvidenceRef(environmentEvidenceRef),
    approvedScenarioCount: await deps.approvedScenarioCount(stored),
  });
};

/**
 * PL-5: 保存する環境の証跡の参照（要求に参照がなければ、保存の日の未確認の参照。あれば前後の空白を除いた参照。空か上限を超えれば null。書けない文字は、
 * 保存の部品のプロファイルの確かめ（`validateSiteProfile`）が `PROFILE_INVALID` で拒む）。
 */
const environmentEvidenceRefOf = (request: WriteModeSwitchRequest, now: Date): string | null => {
  if (request.isolationEvidenceRef === undefined) {
    return isolationUnverifiedEvidenceRefOf(now);
  }
  const reference = request.isolationEvidenceRef.trim();
  return reference.length === 0 || reference.length > MAX_ENVIRONMENT_EVIDENCE_REF_LENGTH ? null : reference;
};

// MI-C（CC-115）: 保存の部品の拒否を、この操作の理由に写す変換は `profile-auth-setup-save-rejection.ts`（「次から自動でログインする」と共用）。

/**
 * 監査モードを書き込みのモードにした次の改訂を保存する（確認のダイアログの後）。順: プロファイル → 対象か → 改訂の照合 → 認証の設定が今の改訂に結びつくか →
 * 対象の設定の文脈 → 保存の部品（検証と改訂の照合を、もう一度トランザクションの中で）。どれかが通らなければ、何も書かない。
 */
export const switchToWriteMode = (
  deps: WriteModeSwitchDependencies,
  request: WriteModeSwitchRequest,
  options: WriteModeSwitchOptions,
): WriteModeSwitchResultView => {
  const stored = getProfile(deps.database, request.profileId);
  if (stored === null) {
    return rejection('PROFILE_NOT_FOUND');
  }
  if (!offersWriteMode(stored)) {
    return rejection('NOT_OFFERED');
  }
  const { profile } = stored;
  if (profile.revision !== request.expectedRevision) {
    return rejection('PROFILE_REVISION_CONFLICT');
  }
  const current = getAuthSetup(deps.database, profile.profileId);
  if (current === null || current.freshness !== CURRENT_AUTH_SETUP_FRESHNESS) {
    return rejection('AUTH_SETUP_NOT_CURRENT');
  }
  if (options.resolveContext(profile.targetConfigPath) === undefined) {
    return rejection('TARGET_CONFIG_UNAVAILABLE');
  }
  const environmentEvidenceRef = environmentEvidenceRefOf(request, deps.now());
  if (environmentEvidenceRef === null) {
    return rejection('ISOLATION_REFERENCE_INVALID');
  }
  if (isSecretLikeText(environmentEvidenceRef)) {
    return rejection('ISOLATION_REFERENCE_SECRET_LIKE');
  }
  const nextRevision = profile.revision + 1;
  let saved: ProfileAndAuthSetupSaveResult;
  try {
    saved = saveProfileAndAuthSetup(deps.database, {
      profile: { ...profile, revision: nextRevision, mode: WRITE_AUDIT_MODE, environmentEvidenceRef },
      expectedRevision: profile.revision,
      setup: { ...current.setup, profileRevision: nextRevision },
    }, { resolveContext: options.resolveContext, now: deps.now });
  } catch {
    return rejection('SAVE_FAILED');
  }
  if (!saved.ok) {
    return rejection(reasonOfProfileAndAuthSetupSaveRejection(saved), authSetupErrorViewsOfProfileAndAuthSetupSaveRejection(saved));
  }
  return Object.freeze({ ok: true, profileRevision: saved.profile.profile.revision });
};

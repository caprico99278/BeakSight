// スクリプトで送るログインの監査の段の口を、`START` の認証の指定から作る（T35a。Task 35 の設計書 3.2 の受け渡し）。
// - スクリプトで送るログイン（`SCRIPT_REQUEST`）の設定だけが口を持つ。フォームの送信のログイン（版 2 と、版 3 の `FORM_NAVIGATION`）は口を持たない
//   （今の振る舞いのまま）。
// - 値は、親が開始の直前に検証し、ワーカーが SHA-256 を確かめた認証の設定（版 3）と、プロファイルの承認したサービスの Origin（`START` の
//   `approvedServiceOrigins`）の写し。読み取りの手続きの呼び出しがなければ空。
// - LZ-3c: 要求の上限（前は設定の `serviceRequestLimits` か、ページの上限に比べた既定の値）は口に写さない（L11 で使わなくなった値。前に保存した設定の項目は
//   受けて使わない）。
// - Guard の判定（T35b）と Run の流れ（T35c）は、ここでは作らない。
import type { AuditStageServiceRequests, AuthenticatedStorageState } from '../browser/context-factory.js';
import { SCRIPT_REQUEST_TRANSPORT } from '../control/auth/auth-setup-contracts.js';
import type { WorkerStartAuthentication } from '../control/worker-protocol.js';
import { deepFreeze } from '../core/immutable.js';
import type { RunAuthentication } from '../orchestration/authenticated-run.js';
import { hasSuccessStorageKey, isSuccessStorageKeyName } from './login-stage-checks.js';

/** `START` の認証の指定から、監査の段の口を作る（スクリプトで送るログインの設定でなければ `undefined`）。結果は凍結した写し。 */
export const auditStageOf = (authentication: WorkerStartAuthentication): AuditStageServiceRequests | undefined => {
  const { setup } = authentication;
  // NL-2: ログインなし（`setup` が null）は、口を持たない（フォームの送信のログインと同じ）。
  if (setup === null || setup.loginTransport !== SCRIPT_REQUEST_TRANSPORT || setup.scriptLogin === null) {
    return undefined;
  }
  return deepFreeze({
    approvedServiceOrigins: [...(authentication.approvedServiceOrigins ?? [])],
    auditReadRequests: (setup.auditReadRequests ?? []).map((read) => ({ ...read })),
    scriptLogin: {
      origin: setup.scriptLogin.origin,
      path: setup.scriptLogin.path,
      requiredQuery: setup.scriptLogin.requiredQuery.map((query) => ({ ...query })),
    },
  });
};

/**
 * `RunAuthentication` に足す項目（口があれば `{ auditStage }`、なければ空）。T35c（Task 35 の設計書 3.5）: 口があり、認証の設定に成功の鍵の形があれば、
 * ログインの状態の鍵があるかの判定（`sessionKeyPresent`。ログインの段の成功の確かめと同じ `hasSuccessStorageKey`。値は読まない）も足す。
 */
export const auditStageItemOf = (
  authentication: WorkerStartAuthentication,
): Pick<RunAuthentication, 'auditStage' | 'sessionKeyPresent' | 'sessionKeyName'> => {
  const auditStage = auditStageOf(authentication);
  if (auditStage === undefined) {
    return {};
  }
  // 口があるのは認証の設定があるときだけ（`auditStageOf`）。
  const key = authentication.setup?.successStorageKey ?? null;
  return key === null
    ? { auditStage }
    : {
      auditStage,
      sessionKeyPresent: (state: AuthenticatedStorageState): boolean => hasSuccessStorageKey(state, key),
      // DEF-233: 次の画面へ渡す状態に重ねる、成功の鍵の名前の判定（同じ決まり `isSuccessStorageKeyName`）。
      sessionKeyName: (origin: string, name: string): boolean => isSuccessStorageKeyName(origin, name, key),
    };
};

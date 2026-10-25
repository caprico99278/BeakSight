// スクリプトで送るログインの監査の段の口を、`START` の認証の指定から作る（T35a。Task 35 の設計書 3.2 の受け渡し）。
// - スクリプトで送るログイン（`SCRIPT_REQUEST`）の設定だけが口を持つ。フォームの送信のログイン（版 2 と、版 3 の `FORM_NAVIGATION`）は口を持たない
//   （今の振る舞いのまま）。
// - 値は、親が開始の直前に検証し、ワーカーが SHA-256 を確かめた認証の設定（版 3）と、プロファイルの承認したサービスの Origin（`START` の
//   `approvedServiceOrigins`）の写し。読み取りの手続きの呼び出しがなければ空、要求の上限がなければ上限の値（T44f: ページの上限に比べた値
//   `defaultServiceRequestLimitsFor`。設定のページの上限 `crawl.maxPages` を渡す）。
// - Guard の判定（T35b）と Run の流れ（T35c）は、ここでは作らない。
import type { AuditStageServiceRequests, AuthenticatedStorageState } from '../browser/context-factory.js';
import {
  SCRIPT_REQUEST_TRANSPORT,
  defaultServiceRequestLimitsFor,
} from '../control/auth/auth-setup-contracts.js';
import type { WorkerStartAuthentication } from '../control/worker-protocol.js';
import { deepFreeze } from '../core/immutable.js';
import type { RunAuthentication } from '../orchestration/authenticated-run.js';
import { hasSuccessStorageKey } from './login-stage-checks.js';

/**
 * `START` の認証の指定から、監査の段の口を作る（スクリプトで送るログインの設定でなければ `undefined`）。結果は凍結した写し。`maxPages` は設定のページの上限
 * （要求の上限がない設定の、1 回の Run あたりの上限の既定に使う。T44f）。
 */
export const auditStageOf = (authentication: WorkerStartAuthentication, maxPages: number): AuditStageServiceRequests | undefined => {
  const { setup } = authentication;
  if (setup.loginTransport !== SCRIPT_REQUEST_TRANSPORT || setup.scriptLogin === null) {
    return undefined;
  }
  const limits = setup.serviceRequestLimits ?? defaultServiceRequestLimitsFor(maxPages);
  return deepFreeze({
    approvedServiceOrigins: [...(authentication.approvedServiceOrigins ?? [])],
    auditReadRequests: (setup.auditReadRequests ?? []).map((read) => ({ ...read })),
    scriptLogin: {
      origin: setup.scriptLogin.origin,
      path: setup.scriptLogin.path,
      requiredQuery: setup.scriptLogin.requiredQuery.map((query) => ({ ...query })),
    },
    serviceRequestLimits: { perMinute: limits.perMinute, perRun: limits.perRun },
  });
};

/**
 * `RunAuthentication` に足す項目（口があれば `{ auditStage }`、なければ空）。T35c（Task 35 の設計書 3.5）: 口があり、認証の設定に成功の鍵の形があれば、
 * ログインの状態の鍵があるかの判定（`sessionKeyPresent`。ログインの段の成功の確かめと同じ `hasSuccessStorageKey`。値は読まない）も足す。`maxPages` は
 * 設定のページの上限（T44f）。
 */
export const auditStageItemOf = (
  authentication: WorkerStartAuthentication,
  maxPages: number,
): Pick<RunAuthentication, 'auditStage' | 'sessionKeyPresent'> => {
  const auditStage = auditStageOf(authentication, maxPages);
  if (auditStage === undefined) {
    return {};
  }
  const { setup } = authentication;
  const key = setup.successStorageKey;
  return key === null
    ? { auditStage }
    : { auditStage, sessionKeyPresent: (state: AuthenticatedStorageState): boolean => hasSuccessStorageKey(state, key) };
};

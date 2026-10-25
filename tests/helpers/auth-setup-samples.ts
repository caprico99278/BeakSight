// LG-3b（2026-10-24 のテストの組の設計 3.7.2）: 認証の設定の見本の共通の項目。認証の設定は版 3（`beaksight-auth-setup/3`）だけを受けるので、
// フォームの送信のログインの見本は、版 2 の項目にこの項目を足して作る（版 3 の項目の既定: 送り方は `FORM_NAVIGATION`、スクリプトの送信先と成功の
// ローカル ストレージの鍵はなし、ログインに伴う送信は空）。値の一覧と型の owner は `src/control/auth/auth-setup-contracts.ts`。
import { AUTH_SETUP_SCHEMA_VERSION_3, FORM_NAVIGATION_TRANSPORT } from '../../src/control/auth/auth-setup-contracts.js';

/** フォームの送信のログインの、版 3 の印と版 3 の項目（凍結）。見本の文書に `...FORM_NAVIGATION_SETUP_ITEMS` で足す。 */
export const FORM_NAVIGATION_SETUP_ITEMS = Object.freeze({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  loginTransport: FORM_NAVIGATION_TRANSPORT,
  scriptLogin: null,
  loginSideRequests: Object.freeze([]),
  successStorageKey: null,
} as const);

/** 版 3 だけの項目の名前（前の版の文書を作るときに除く。LG-3b: 前の版の行が誤りになることの確かめにだけ使う）。 */
export const VERSION_3_ONLY_SETUP_KEYS = Object.freeze(['loginTransport', 'scriptLogin', 'loginSideRequests', 'successStorageKey'] as const);

/** 捨てた前の版（版 1・版 2）の文書を、版 3 の見本から作る（版 1 は `automatedLogin` も持たない）。前の版の行が誤りになることの確かめにだけ使う。 */
export const previousVersionSetupDocumentOf = (setup: object, version: 1 | 2): Record<string, unknown> => {
  const document: Record<string, unknown> = { ...setup, schemaVersion: `beaksight-auth-setup/${version}` };
  for (const key of [...VERSION_3_ONLY_SETUP_KEYS, 'auditReadRequests', 'serviceRequestLimits', ...(version === 1 ? ['automatedLogin'] : [])]) {
    delete document[key];
  }
  return document;
};

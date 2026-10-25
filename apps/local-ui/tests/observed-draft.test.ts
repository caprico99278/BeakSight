/**
 * T43d（Task 43 の設計書 4.4、5 章の 4）: ジョブの詳細の「登録する」「案を認証の設定に入れる」の下書きを、認証の設定の画面の欄に入れる純粋な部品
 * （`display/entry-check-draft.ts` の `observedDraftFieldsOf` と、`AuthSetupForm.tsx` の `authSetupFormValuesOf`）。
 * - 優先の順（1 か所）: 保存した設定の値 < 入口の確かめの案（保存した設定がないときだけ）< 観察した要求の下書き（保存した設定があっても入れる）。
 * - token の送信先は、送り方を「スクリプトで送る」にして、送信先と必須の query を入れる。ログインに伴う送信は、今の一覧に足す（同じ Origin と path は
 *   重ねない。回数の上限は既定の 1）。成功の鍵の名前は接頭辞に入れる。成功の画面のセレクタは、入口の確かめで読んだログインの画面の CSS と同じなら入れない。
 */
import { describe, expect, it } from 'vitest';
import { AUTH_SETUP_SCHEMA_VERSION_3, type AuthSetupV3 } from '../../../src/control/auth/auth-setup-contracts.js';
import type { EntryCheckProposal } from '../../../src/control/entry-check.js';
import type { ObservedAuthSetupDraft } from '../../../src/control/login-observation-draft.js';
import { authSetupFormValuesOf } from '../src/components/AuthSetupForm';
import { entryProposalSelectorsOf, observedDraftFieldsOf, serviceOriginSourcesOf } from '../src/display/entry-check-draft';
import { approvedServiceOriginsToAdd } from '../../../src/control/login-observation-draft.js';

const APP = 'http://127.0.0.1:4173';
const SERVICE = 'http://127.0.0.1:5173';

const SAVED: AuthSetupV3 = {
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  profileId: 'example',
  profileRevision: 1,
  loginStartUrl: `${APP}/auth`,
  loginPostEndpoints: [],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: '/auth' },
  excludedPaths: [],
  auditPathPrefixes: [],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
  loginTransport: 'SCRIPT_REQUEST',
  scriptLogin: { origin: SERVICE, path: '/old/token', requiredQuery: [] },
  loginSideRequests: [{ origin: SERVICE, path: '/rest/v1/rpc/log_login', method: 'POST', maxPerLoginStage: 2 }],
  successStorageKey: { origin: APP, prefix: 'old-', suffix: '' },
};

const DRAFT: ObservedAuthSetupDraft = {
  scriptLogin: { origin: SERVICE, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
  sideRequests: [
    { origin: SERVICE, path: '/rest/v1/rpc/log_login', method: 'POST' },
    { origin: SERVICE, path: '/rest/v1/rpc/resolve_tenant', method: 'POST' },
  ],
  // T43R-fix の C-1 (a)（意図して直した期待）: 鍵の名前の案は接頭辞と接尾辞の組。
  storageKey: { origin: APP, prefix: 'session.', suffix: '-token' },
  successSelector: '#logout',
};

const PROPOSAL: EntryCheckProposal = {
  loginStartUrl: `${APP}/auth`,
  sessionLostPathPrefix: '/auth',
  loginTransport: 'SCRIPT_REQUEST',
  loginPostEndpoint: null,
  selectors: { username: '#email', password: '#password', submit: '#login' },
};

describe('T43d: putting the observed draft into the auth setup fields', () => {
  it('gives the fields of the draft: the script transport, the token target, the added side requests, the key prefix and the selector', () => {
    expect(observedDraftFieldsOf(DRAFT, [{ origin: SERVICE, path: '/rest/v1/rpc/log_login', maxPerLoginStage: 2 }], [])).toEqual({
      loginTransport: 'SCRIPT_REQUEST',
      scriptOrigin: SERVICE,
      scriptPath: '/auth/v1/token',
      requiredQuery: [{ name: 'grant_type', value: 'password' }],
      sideRequests: [
        { origin: SERVICE, path: '/rest/v1/rpc/log_login', maxPerLoginStage: 2 },
        { origin: SERVICE, path: '/rest/v1/rpc/resolve_tenant', maxPerLoginStage: 1 },
      ],
      storageOrigin: APP,
      storagePrefix: 'session.',
      storageSuffix: '-token',
      successSelector: '#logout',
    });
    expect(observedDraftFieldsOf({ successSelector: '#login' }, [], entryProposalSelectorsOf(PROPOSAL))).toEqual({});
    expect(entryProposalSelectorsOf(PROPOSAL)).toEqual(['#email', '#password', '#login']);
  });

  it('puts the draft over the saved setup (the saved values stay in the other fields)', () => {
    const values = authSetupFormValuesOf(SAVED, false, null, null, DRAFT);
    expect(values).toMatchObject({
      loginStartUrl: `${APP}/auth`,
      loginTransport: 'SCRIPT_REQUEST',
      scriptOrigin: SERVICE,
      scriptPath: '/auth/v1/token',
      requiredQuery: [{ name: 'grant_type', value: 'password' }],
      storagePrefix: 'session.',
      successSelector: '#logout',
      successPathPrefix: '/admin',
    });
    expect(values.sideRequests).toEqual([
      { origin: SERVICE, path: '/rest/v1/rpc/log_login', maxPerLoginStage: 2 },
      { origin: SERVICE, path: '/rest/v1/rpc/resolve_tenant', maxPerLoginStage: 1 },
    ]);
  });

  it('puts the draft over the proposal of the entry check for a new setup, and keeps the values without a draft as they were', () => {
    const values = authSetupFormValuesOf(null, true, '/admin', PROPOSAL, { storageKey: { origin: APP, prefix: 'example-', suffix: '-token' } });
    expect(values).toMatchObject({
      usernameSelector: '#email', loginTransport: 'SCRIPT_REQUEST', storageOrigin: APP, storagePrefix: 'example-', storageSuffix: '-token',
    });
    expect(authSetupFormValuesOf(SAVED, false, null, null, null)).toEqual(authSetupFormValuesOf(SAVED));
  });

  // T43R-fix の M-3: まとめて保存で足すサービスの Origin は、保存の時点の欄の値から決め直す（下書きの Origin を利用者が変えたら、変えた後の Origin）。
  it('gives the origins to add from the fields at the time of the save', () => {
    const values = authSetupFormValuesOf(SAVED, false, null, null, DRAFT);
    const profile = { approvedTestOrigins: [APP], approvedServiceOrigins: [] };
    expect(approvedServiceOriginsToAdd(serviceOriginSourcesOf(values), profile)).toEqual([SERVICE]);
    const changed = { ...values, scriptOrigin: 'http://127.0.0.1:6173', sideRequests: [{ origin: APP, path: '/x', maxPerLoginStage: 1 }] };
    expect(approvedServiceOriginsToAdd(serviceOriginSourcesOf(changed), profile)).toEqual(['http://127.0.0.1:6173']);
    // フォームの送信に戻したら、スクリプトの送信の欄の Origin は足さない。
    expect(approvedServiceOriginsToAdd(serviceOriginSourcesOf({ ...values, loginTransport: 'FORM_NAVIGATION' }), profile)).toEqual([]);
  });
});

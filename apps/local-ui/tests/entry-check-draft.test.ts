/**
 * T43c（Task 43 の設計書 4.3）: 入口の確かめの案を、認証の設定の画面の欄に埋める純粋な部品（`display/entry-check-draft.ts` と
 * `AuthSetupForm.tsx` の `authSetupFormValuesOf`）。
 * - 保存した設定がないときだけ、案を埋める（案のない欄は埋めない）。開始の URL の path の案（T43b）より優先し、ログインの画面の path に当たる成功の
 *   画面の path の案は空にする。保存した設定があれば、案は使わない。
 */
import { describe, expect, it } from 'vitest';
import type { AuthSetup } from '../../../src/control/auth/auth-setup-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import type { EntryCheckProposal } from '../../../src/control/entry-check.js';
import { authSetupFormValuesOf } from '../src/components/AuthSetupForm';
import { entryCheckDraftOf, keepsStartUrlSuccessPath } from '../src/display/entry-check-draft';

const ORIGIN = 'http://127.0.0.1:4173';
const PROPOSAL: EntryCheckProposal = {
  loginStartUrl: `${ORIGIN}/login`,
  sessionLostPathPrefix: '/login',
  loginTransport: 'FORM_NAVIGATION',
  loginPostEndpoint: { origin: ORIGIN, path: '/session' },
  selectors: { username: '#user', password: '#pass', submit: null },
};

describe('T43c: filling the auth setup with the proposal of the entry check', () => {
  it('makes the draft of the fields that have a proposal only', () => {
    expect(entryCheckDraftOf(PROPOSAL)).toEqual({
      loginStartUrl: `${ORIGIN}/login`,
      sessionLostPathPrefix: '/login',
      loginTransport: 'FORM_NAVIGATION',
      loginPostEndpoints: `${ORIGIN}/session`,
      usernameSelector: '#user',
      passwordSelector: '#pass',
    });
    expect(entryCheckDraftOf({ ...PROPOSAL, loginStartUrl: null, sessionLostPathPrefix: null, loginTransport: null, loginPostEndpoint: null,
      selectors: { username: null, password: null, submit: null } })).toEqual({});
  });

  it('fills a new setup with the proposal over the draft of the start URL path, dropping a success path that hits the login page', () => {
    const values = authSetupFormValuesOf(null, true, '/login', PROPOSAL);
    expect(values).toMatchObject({
      loginStartUrl: `${ORIGIN}/login`,
      sessionLostPathPrefix: '/login',
      loginTransport: 'FORM_NAVIGATION',
      loginPostEndpoints: `${ORIGIN}/session`,
      usernameSelector: '#user',
      passwordSelector: '#pass',
      submitSelector: '',
      successPathPrefix: '',
      auditPathPrefixes: '/login',
    });
    // 開始の URL の path がログインの画面の path に当たらなければ、成功の画面の path の案は残す。
    expect(authSetupFormValuesOf(null, false, '/admin', PROPOSAL).successPathPrefix).toBe('/admin');
    expect(keepsStartUrlSuccessPath('/admin', entryCheckDraftOf(PROPOSAL))).toBe(true);
    expect(keepsStartUrlSuccessPath('/', entryCheckDraftOf(PROPOSAL))).toBe(false);
  });

  it('does not use the proposal when a setup is saved', () => {
    const saved = {
      ...FORM_NAVIGATION_SETUP_ITEMS,
      profileId: 'example',
      profileRevision: 1,
      loginStartUrl: `${ORIGIN}/saved`,
      loginPostEndpoints: [{ origin: ORIGIN, path: '/saved-session' }],
      successCondition: { pathPrefix: '/home', selector: null },
      sessionLostCondition: { pathPrefix: null },
      excludedPaths: [],
      auditPathPrefixes: ['/home'],
      maxLoginAttempts: 1,
      allowedIdpOrigins: [],
      automatedLogin: null,
    } as const satisfies AuthSetup;
    expect(authSetupFormValuesOf(saved, false, '/login', PROPOSAL)).toMatchObject({
      loginStartUrl: `${ORIGIN}/saved`,
      loginPostEndpoints: `${ORIGIN}/saved-session`,
      sessionLostPathPrefix: '',
      successPathPrefix: '/home',
    });
  });
});

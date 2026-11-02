// MI-3（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.3）: 認証の設定の案を組み立てる純粋な関数（`src/control/auth/auth-setup-proposal.ts`）。
// - 入口の確かめの案と開始の URL の path から、今の認証の設定の画面の案と同じ版 3 の設定を作る（読まないパスは空）。手動のログインのプロファイルの案は、
//   そのまま保存の検証（`validateAuthSetup`）を通る（スクリプトで送るログインの送信先と鍵は、手動のログインの後の自動の登録が足す）。
// - 案で保存するかの判定（`entryCheckAuthSetupDecisionOf`）は、使わない・すでにある・確かめていない・読んでいない・ログインの画面でない、の順。
// 例の値は匿名の値（`example.invalid`）だけ。
import { describe, expect, it } from 'vitest';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  MIN_LOGIN_ATTEMPTS,
} from '../../src/control/auth/auth-setup-contracts.js';
import {
  ENTRY_CHECK_AUTH_SETUP_STATES,
  authSetupDraftOf,
  authSetupProposalProfileOf,
  entryCheckAuthSetupDecisionOf,
  proposedAuthSetupBodyOf,
  proposedAuthSetupOf,
} from '../../src/control/auth/auth-setup-proposal.js';
import { validateAuthSetup } from '../../src/control/auth/auth-setup-policy.js';
import { authSetupCredentialDestinationChangesOf } from '../../src/control/auth/credential-destination.js';
import { SITE_PROFILE_SCHEMA_VERSION, type SiteProfile } from '../../src/control/contracts.js';
import type { EntryCheckDocument, EntryCheckProposal } from '../../src/control/entry-check.js';
import { validateSiteProfile, type ProfileValidationContext } from '../../src/control/profile-policy.js';
import { createTestConfig } from '../helpers/test-config.js';

const ORIGIN = 'https://app.example.invalid';
const FORM_PROPOSAL: EntryCheckProposal = {
  loginStartUrl: `${ORIGIN}/login`,
  sessionLostPathPrefix: '/login',
  loginTransport: 'FORM_NAVIGATION',
  loginPostEndpoint: { origin: ORIGIN, path: '/session' },
  selectors: { username: '#user', password: '#pass', submit: null },
};
const SCRIPT_PROPOSAL: EntryCheckProposal = {
  ...FORM_PROPOSAL,
  loginTransport: 'SCRIPT_REQUEST',
  loginPostEndpoint: null,
  selectors: { username: '#user', password: '#pass', submit: '#go' },
};
const EMPTY_PROPOSAL: EntryCheckProposal = {
  loginStartUrl: null,
  sessionLostPathPrefix: null,
  loginTransport: null,
  loginPostEndpoint: null,
  selectors: { username: null, password: null, submit: null },
};

const context: ProfileValidationContext = { targetConfig: createTestConfig(ORIGIN, '/admin') };
const manualProfile: SiteProfile = {
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId: 'example-test',
  revision: 1,
  targetConfigPath: 'local/targets/example-test.json',
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [ORIGIN],
  environmentEvidenceRef: 'evidence/example-test-env/isolation-check-1',
};

const readEntryCheck = (loginPage: boolean): Pick<EntryCheckDocument, 'endReason' | 'facts'> => ({
  endReason: 'READ',
  facts: {
    loginPage,
    fields: {
      username: { candidates: 1, selector: '#user' },
      password: { candidates: 1, selector: '#pass' },
      submit: { candidates: 1, selector: '#go' },
    },
    form: { placement: 'NONE', action: null, method: null },
  },
});

describe('MI-3: the auth setup proposal (the same draft as the auth setup page)', () => {
  it('fills the audit path and the success path with the path of the start URL (T43b)', () => {
    expect(authSetupDraftOf('/admin/')).toEqual({ auditPathPrefixes: ['/admin/'], successPathPrefix: '/admin/' });
    expect(authSetupDraftOf('/')).toEqual({ auditPathPrefixes: ['/'], successPathPrefix: '/' });
    expect(authSetupDraftOf(null)).toEqual({ auditPathPrefixes: [], successPathPrefix: '' });
  });

  it('fills the fields that have a proposal of the entry check only (T43c), and leaves the excluded paths empty', () => {
    expect(proposedAuthSetupBodyOf({ automated: true, startUrlPath: '/admin', entryProposal: FORM_PROPOSAL })).toEqual({
      loginStartUrl: `${ORIGIN}/login`,
      loginPostEndpoints: [{ origin: ORIGIN, path: '/session' }],
      successCondition: { pathPrefix: '/admin', selector: null },
      sessionLostCondition: { pathPrefix: '/login' },
      excludedPaths: [],
      auditPathPrefixes: ['/admin'],
      maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
      allowedIdpOrigins: [],
      automatedLogin: {
        usernameSelector: '#user',
        passwordSelector: '#pass',
        submitSelector: '',
        failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
      },
      loginTransport: 'FORM_NAVIGATION',
      scriptLogin: null,
      loginSideRequests: [],
      successStorageKey: null,
    });
    expect(proposedAuthSetupBodyOf({ automated: false, startUrlPath: null, entryProposal: EMPTY_PROPOSAL })).toMatchObject({
      loginStartUrl: '',
      loginPostEndpoints: [],
      successCondition: { pathPrefix: '' },
      sessionLostCondition: { pathPrefix: null },
      auditPathPrefixes: [],
      maxLoginAttempts: MIN_LOGIN_ATTEMPTS,
      automatedLogin: null,
      // PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 10 章の PL-S、MI 4.7.1 の 6 の持ち越し）: 送り方の案がないときは、送信先のない形（スクリプトの送信）。
      loginTransport: 'SCRIPT_REQUEST',
      scriptLogin: null,
    });
  });

  it('drops a success path of the start URL that hits the login page, and keeps one that does not', () => {
    expect(proposedAuthSetupBodyOf({ automated: false, startUrlPath: '/', entryProposal: FORM_PROPOSAL }).successCondition.pathPrefix).toBe('');
    expect(proposedAuthSetupBodyOf({ automated: false, startUrlPath: '/admin', entryProposal: FORM_PROPOSAL }).successCondition.pathPrefix).toBe('/admin');
    // 入口の確かめの案がなければ、開始の URL の path の案のまま。
    expect(proposedAuthSetupBodyOf({ automated: false, startUrlPath: '/', entryProposal: null }).successCondition.pathPrefix).toBe('/');
  });

  it('makes a script login proposal without the targets, which passes validateAuthSetup for a manual login profile', () => {
    const setup = proposedAuthSetupOf({ profileId: 'example-test', profileRevision: 1, automated: false, startUrlPath: '/admin', entryProposal: SCRIPT_PROPOSAL });
    expect(setup).toMatchObject({ schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3, profileId: 'example-test', profileRevision: 1, loginPostEndpoints: [] });
    const profile = validateSiteProfile(manualProfile, context);
    expect(profile.ok).toBe(true);
    if (profile.ok) {
      expect(validateAuthSetup(setup, profile.profile, context).ok).toBe(true);
      // ログインの画面の URL の案がなければ、検証を通らない（保存しない）。
      const empty = proposedAuthSetupOf({ profileId: 'example-test', profileRevision: 1, automated: false, startUrlPath: '/admin', entryProposal: EMPTY_PROPOSAL });
      expect(validateAuthSetup(empty, profile.profile, context).ok).toBe(false);
    }
  });
});

describe('PL-S: the proposal without a login transport (MI 4.7.1 の 6 の持ち越し)', () => {
  it('defaults to the form without a destination, which passes the first save (the validation and the observed-destinations-only check)', () => {
    const noTransport: EntryCheckProposal = { ...FORM_PROPOSAL, loginTransport: null, loginPostEndpoint: null };
    const setup = proposedAuthSetupOf({ profileId: 'example-test', profileRevision: 1, automated: false, startUrlPath: '/admin', entryProposal: noTransport });
    expect(setup).toMatchObject({ loginTransport: 'SCRIPT_REQUEST', scriptLogin: null, loginPostEndpoints: [], loginSideRequests: [], automatedLogin: null });
    const profile = validateSiteProfile(manualProfile, context);
    expect(profile.ok).toBe(true);
    if (profile.ok) {
      expect(validateAuthSetup(setup, profile.profile, context).ok).toBe(true);
    }
    // 最初の保存の比べ（入口の確かめの案と、送信先のない形）で、送信先の項目が変わらない。
    expect(authSetupCredentialDestinationChangesOf({
      beforeAuth: 'MANUAL_SESSION', afterAuth: 'MANUAL_SESSION', before: null, after: setup, observedOnly: { baselines: [setup] },
    })).toEqual([]);
    // 案のフォームの送信先があるときは、今どおりフォームの送信。
    expect(proposedAuthSetupBodyOf({ automated: false, startUrlPath: null, entryProposal: { ...FORM_PROPOSAL, loginTransport: null } }).loginTransport)
      .toBe('FORM_NAVIGATION');
  });
});

describe('MI-3: whether the job manager saves the proposal after an entry check', () => {
  it('decides in the order of the closed list', () => {
    const uses = { usesAuthSetup: true, hasAuthSetup: false };
    expect(entryCheckAuthSetupDecisionOf({ ...uses, usesAuthSetup: false, entryCheck: readEntryCheck(true) })).toBe('NOT_USED');
    expect(entryCheckAuthSetupDecisionOf({ ...uses, hasAuthSetup: true, entryCheck: readEntryCheck(true) })).toBe('PRESENT');
    expect(entryCheckAuthSetupDecisionOf({ ...uses, entryCheck: null })).toBe('NOT_CHECKED');
    expect(entryCheckAuthSetupDecisionOf({ ...uses, entryCheck: { endReason: 'NAVIGATION_FAILED', facts: null } })).toBe('NOT_READ');
    expect(entryCheckAuthSetupDecisionOf({ ...uses, entryCheck: { endReason: 'LEFT_ALLOWED_ORIGINS', facts: null } })).toBe('NOT_READ');
    expect(entryCheckAuthSetupDecisionOf({ ...uses, entryCheck: readEntryCheck(false) })).toBe('NOT_LOGIN_PAGE');
    expect(entryCheckAuthSetupDecisionOf({ ...uses, entryCheck: readEntryCheck(true) })).toBe('PROPOSE');
    expect(ENTRY_CHECK_AUTH_SETUP_STATES).toEqual(['NOT_USED', 'PRESENT', 'NOT_CHECKED', 'NOT_READ', 'NOT_LOGIN_PAGE', 'PROPOSAL_INVALID', 'NOT_SAVED']);
  });

  it('reads whether the profile uses an auth setup and an automated login from the operation policy', () => {
    expect(authSetupProposalProfileOf('TEST_AUTH_PASSIVE', 'MANUAL_SESSION')).toEqual({ usesAuthSetup: true, automated: false });
    expect(authSetupProposalProfileOf('TEST_AUTH_PASSIVE', 'AUTOMATED_LOGIN')).toEqual({ usesAuthSetup: true, automated: true });
    expect(authSetupProposalProfileOf('PUBLIC_PASSIVE', 'NONE')).toEqual({ usesAuthSetup: false, automated: false });
  });
});

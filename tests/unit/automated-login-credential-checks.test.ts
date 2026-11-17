// T26d-1（SLIM L-3 で `tests/integration/automated-login.test.ts` から移した）: 自動ログインの段（`runAutomatedLoginStage`）は、資格情報のファイルの秘密でない
// 項目（改訂の番号とログインの Origin）を、ログイン用の Browser を起動する前に確かめる。違えば `CREDENTIAL_CHANGED`、ファイルがない（読めない）なら
// `CREDENTIAL_UNAVAILABLE`。どれも起動せず、復号もしない（値に触れない）。偽の読み取りの口だけで確かめる（Browser は使わない）。
// 復号の後に決まる 2 つ（復号の間に改訂が変わる・復号できない）は、ログインの画面を開いて確かめた後に決まるので、結合 `automated-login.test.ts` に残す。
import { describe, expect, it } from 'vitest';
import { AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import type { AutomatedLoginCredentialMetadata, AutomatedLoginStageResult } from '../../src/worker/automated-login.js';
import { runAutomatedLoginStage } from '../../src/worker/automated-login.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { createTestConfig } from '../helpers/test-config.js';

const ORIGIN = 'http://127.0.0.1:4173';
const OTHER_ORIGIN = 'http://127.0.0.1:4174';
const EXPECTED_REVISION = 1;

const SETUP: AuthSetup = {
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-credential-checks',
  profileRevision: 1,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/home', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [],
  auditPathPrefixes: [],
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  allowedIdpOrigins: [],
  automatedLogin: {
    usernameSelector: '#user',
    passwordSelector: '#pass',
    submitSelector: '#go',
    failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
  },
};

/** 起動と復号を数える偽の口で、段を 1 回動かす。 */
const runWith = async (
  readCredentialMetadata: () => Promise<AutomatedLoginCredentialMetadata | null>,
  expectedCredentialRevision = EXPECTED_REVISION,
): Promise<{ readonly result: AutomatedLoginStageResult; readonly launches: number; readonly decryptions: number }> => {
  let launches = 0;
  let decryptions = 0;
  const result = await runAutomatedLoginStage({
    config: createTestConfig(ORIGIN, '/'),
    setup: SETUP,
    approvedTestOrigins: [ORIGIN],
    expectedCredentialRevision,
    readCredentialMetadata,
    readCredential: async () => {
      decryptions += 1;
      throw new Error('the credential must not be decrypted before the checks pass');
    },
    signal: new AbortController().signal,
  }, {
    launchAutomatedLoginBrowser: async () => {
      launches += 1;
      throw new Error('the login Browser must not be launched before the checks pass');
    },
  });
  return { result, launches, decryptions };
};

describe('T26d-1: the credential checks of the automated login stage before launching', () => {
  it.each<readonly [string, () => Promise<AutomatedLoginCredentialMetadata | null>, number, string]>([
    ['the revision differs from the expected one', async () => ({ credentialRevision: EXPECTED_REVISION, loginOrigin: ORIGIN }), EXPECTED_REVISION + 1, 'CREDENTIAL_CHANGED'],
    ['the login Origin of the file differs', async () => ({ credentialRevision: EXPECTED_REVISION, loginOrigin: OTHER_ORIGIN }), EXPECTED_REVISION, 'CREDENTIAL_CHANGED'],
    ['there is no credential file', async () => null, EXPECTED_REVISION, 'CREDENTIAL_UNAVAILABLE'],
    ['the credential file cannot be read', async () => { throw new Error('unreadable'); }, EXPECTED_REVISION, 'CREDENTIAL_UNAVAILABLE'],
  ])('returns the result without launching or decrypting when %s', async (_case, readMetadata, expectedRevision, kind) => {
    const run = await runWith(readMetadata, expectedRevision);
    expect(run.result).toEqual({ kind, submitted: 'NO', retryAfterUntil: null });
    expect(run.launches).toBe(0);
    expect(run.decryptions).toBe(0);
  });
});

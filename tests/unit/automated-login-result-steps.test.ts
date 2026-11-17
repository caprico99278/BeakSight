// RB-12（再構築の設計書 3 章。plan の 2 章の 13）: 自動ログインの結果の輪の次の一手（`loginResultStepOf`）を、観察の記録だけで確かめる。ブラウザを使わない。
// 守りの順: 止める印 → 窓の中で止めた要求（スクリプトは資格情報を含む要求）→ 閉じ → 試しの超過（送信を観測した後だけ）→ 応答の状態 → 画面の条件 → 期限。
import { describe, expect, it } from 'vitest';
import { loginResultStepOf, resultConditionsOf, type LoginResultObservation } from '../../src/worker/automated-login.js';

describe('RB-12: the result of each failure condition', () => {
  const at = (pathPrefix: string): { readonly pathPrefix: string; readonly selector: null } => ({ pathPrefix, selector: null });
  const conditions = resultConditionsOf({ successCondition: at('/home') }, {
    failureConditions: { invalidCredentials: null, accountLocked: at('/locked'), mfaRequired: at('/mfa'), credentialExpired: at('/expired') },
  });

  it.each([
    ['/locked', 'ACCOUNT_LOCKED'],
    ['/mfa', 'MFA_REQUIRED'],
    ['/expired', 'CREDENTIAL_EXPIRED'],
  ] as const)('maps the condition %s to %s', (pathPrefix, result) => {
    expect(conditions.find(([, condition]) => condition.pathPrefix === pathPrefix)?.[0]).toBe(result);
  });
});

const FORM = { nowMs: 0, deadlineMs: 1, script: false } as const;
const SCRIPT = { ...FORM, script: true } as const;
const LATE = { nowMs: 1, deadlineMs: 1 } as const;

/** 送信を観測し、新しい文書を開いた後の、何もまだ決まらない観察。 */
const base: LoginResultObservation = {
  stopped: false,
  closed: false,
  unexpectedRequestCount: 0,
  credentialRequestsBlocked: 0,
  tokenRequestsBlockedOverLimit: 0,
  tokenResponse: undefined,
  loginPostObserved: true,
  attemptsExceeded: false,
  documentCommittedAfterPost: true,
  documentStatus: 200,
};
const of = (extra: Partial<LoginResultObservation>): LoginResultObservation => ({ ...base, ...extra });
const unknown = { kind: 'FAILED', result: 'AUTH_RESULT_UNKNOWN', retryAfter: null };

describe('RB-12: the result loop of the form login', () => {
  it.each([
    ['the stop signal before everything', of({ stopped: true, unexpectedRequestCount: 1, page: ['SUCCEEDED'] }), { kind: 'STOPPED' }],
    ['a request stopped in the window before a success', of({ unexpectedRequestCount: 1, closed: true, page: ['SUCCEEDED'] }),
      { kind: 'FAILED', result: 'UNEXPECTED_LOGIN_REQUEST', retryAfter: null }],
    ['a closed page', of({ closed: true, page: ['SUCCEEDED'] }), unknown],
    ['a second login POST after the observed one', of({ attemptsExceeded: true, page: ['SUCCEEDED'] }), unknown],
    ['a 5xx document', of({ documentStatus: 500 }), unknown],
    ['a 429 document whose Retry-After is not read yet', of({ documentStatus: 429 }), { kind: 'READ_RETRY_AFTER' }],
    ['a 429 document', of({ documentStatus: 429, documentRetryAfter: '30' }), { kind: 'FAILED', result: 'RATE_LIMITED', retryAfter: '30' }],
    ['a page not read yet', base, { kind: 'READ_PAGE' }],
    ['the success condition only', of({ page: ['SUCCEEDED'] }), { kind: 'SUCCEEDED' }],
    ['one failure condition only', of({ page: ['ACCOUNT_LOCKED'] }), { kind: 'FAILED', result: 'ACCOUNT_LOCKED', retryAfter: null }],
    ['two conditions', of({ page: ['SUCCEEDED', 'ACCOUNT_LOCKED'] }), { kind: 'WAIT' }],
    ['no condition', of({ page: [] }), { kind: 'WAIT' }],
    ['a document not parsed yet', of({ page: null }), { kind: 'WAIT' }],
  ] as const)('decides %s', (_name, observation, expected) => {
    expect(loginResultStepOf(observation, FORM)).toEqual(expected);
  });

  it('counts the blocked login POSTs and reads the page only after it observed the login POST', () => {
    const notObserved = of({ loginPostObserved: false, attemptsExceeded: true, documentCommittedAfterPost: false });
    expect(loginResultStepOf(notObserved, FORM)).toEqual({ kind: 'WAIT' });
    expect(loginResultStepOf(of({ documentCommittedAfterPost: false }), FORM)).toEqual({ kind: 'WAIT' });
  });

  it('ends as unknown at the deadline when nothing decided', () => {
    expect(loginResultStepOf(of({ page: [] }), { ...FORM, ...LATE })).toEqual(unknown);
  });
});

describe('RB-12: the result loop of the script login', () => {
  const responded = (status: number, retryAfter: string | null = null): Partial<LoginResultObservation> =>
    ({ tokenResponse: { state: 'RESPONDED', status, retryAfter } });
  const accepted = { accepted: true, carriesCredential: false, credentialRequestsBlocked: 0 } as const;

  it.each([
    ['the stop signal before everything', of({ stopped: true, credentialRequestsBlocked: 1 }), { kind: 'STOPPED' }],
    ['a blocked request with the credentials before a success', of({ credentialRequestsBlocked: 1, ...responded(200), page: ['SUCCEEDED'], state: accepted }), unknown],
    ['a token request over the limit', of({ tokenRequestsBlockedOverLimit: 1, ...responded(200) }), unknown],
    ['no token response yet', base, { kind: 'WAIT' }],
    ['a token request that failed', of({ tokenResponse: { state: 'FAILED', status: null, retryAfter: null } }), unknown],
    ['a 400 token response', of(responded(400)), { kind: 'FAILED', result: 'INVALID_CREDENTIALS', retryAfter: null }],
    ['a 429 token response', of(responded(429, '30')), { kind: 'FAILED', result: 'RATE_LIMITED', retryAfter: '30' }],
    ['a 2xx token response, page not read yet', of(responded(200)), { kind: 'READ_PAGE' }],
    ['one failure condition', of({ ...responded(200), page: ['MFA_REQUIRED'] }), { kind: 'FAILED', result: 'MFA_REQUIRED', retryAfter: null }],
    ['the success condition, state not read yet', of({ ...responded(200), page: ['SUCCEEDED'] }), { kind: 'READ_STATE' }],
    ['a state that does not meet the success', of({ ...responded(200), page: ['SUCCEEDED'], state: { ...accepted, accepted: false } }), { kind: 'WAIT' }],
    ['a state that carries the password', of({ ...responded(200), page: ['SUCCEEDED'], state: { ...accepted, carriesCredential: true } }), unknown],
    ['a request with the credentials blocked while the state was read', of({ ...responded(200), page: ['SUCCEEDED'], state: { ...accepted, credentialRequestsBlocked: 1 } }), unknown],
    ['an accepted state', of({ ...responded(200), page: ['SUCCEEDED'], state: accepted }), { kind: 'SUCCEEDED' }],
  ] as const)('decides %s', (_name, observation, expected) => {
    expect(loginResultStepOf(observation, SCRIPT)).toEqual(expected);
  });

  it('ends as unknown at the deadline when nothing decided', () => {
    expect(loginResultStepOf(base, { ...SCRIPT, ...LATE })).toEqual(unknown);
  });
});

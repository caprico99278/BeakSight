// T43d（Task 43 の設計書 3 章、4.4、5 章の 4）: 観察した要求の「登録する」の振り分けと、認証の設定の画面へ渡す下書き（`src/control/login-observation-draft.ts`）。
// - 振り分け: `grant_type` の値を記録した token の送信の形の行 → token の送信先（Origin、path、必須の query）。ほかの、まだ登録していない読み取りでない
//   要求 → ログインに伴う送信（Origin、path、POST、回数の上限は既定 1）。伏せた path の区切りがある行と、登録済みの送信の上限・送り方の行は、ボタンを
//   出さず手で入れる。
// - 下書きは保存しない形（URL の search）で、値は Origin・path・method・query の名前と `grant_type` の値（と、観察の鍵の名前と CSS）だけ。読み直すときは
//   閉じた形と値の形を確かめ、合わなければ下書きなしにする。
// - プロファイルの承認したサービスの Origin に足すべき Origin（token の送信先はサービスの Origin、ログインに伴う送信はテストかサービスの Origin）。
// 例の値は匿名の値だけ。
import { describe, expect, it } from 'vitest';
import {
  approvedServiceOriginsToAdd,
  loginStageRegistrationOf,
  observedDraftOfObservation,
  observedDraftOfRegistration,
  parseObservedAuthSetupDraft,
} from '../../src/control/login-observation-draft.js';
import type { WorkerLoginStageBlockedRequest } from '../../src/control/worker-protocol.js';
import { REDACTED_PATH_SEGMENT } from '../../src/core/url-path-redaction.js';

const APP = 'http://127.0.0.1:4173';
const SERVICE = 'http://127.0.0.1:5173';
const JWT_LIKE = 'eyJtYXJrZXIiOiJ0NDNkIn0.eyJzdWIiOiJleGFtcGxlIn0.bWFya2VyLXNpZ25hdHVyZQ';

const row = (change: Partial<WorkerLoginStageBlockedRequest>): WorkerLoginStageBlockedRequest =>
  ({ origin: SERVICE, path: '/rest/v1/rpc/resolve_tenant', resourceType: 'fetch', reason: 'UNREGISTERED_NON_READ', count: 1, ...change });
const TOKEN_QUERY = { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type' as const, value: 'password' }] };

describe('T43d: the destination of a blocked request row', () => {
  it('sends a token request with the recorded grant_type to the token target', () => {
    for (const reason of ['NON_READ_METHOD', 'UNREGISTERED_NON_READ'] as const) {
      expect(loginStageRegistrationOf(row({ path: '/auth/v1/token', reason, query: TOKEN_QUERY }))).toEqual({
        kind: 'TOKEN_TARGET', origin: SERVICE, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }],
      });
    }
  });

  it('sends another unregistered non-read request to the login side requests (POST, once per login stage)', () => {
    expect(loginStageRegistrationOf(row({}))).toEqual({ kind: 'SIDE_REQUEST', origin: SERVICE, path: '/rest/v1/rpc/resolve_tenant', method: 'POST', maxPerLoginStage: 1 });
    expect(loginStageRegistrationOf(row({ origin: APP, path: '/cdn-cgi/rum', reason: 'NON_READ_METHOD', resourceType: 'ping', query: { names: ['x'], omitted: 0, values: [] } })))
      .toEqual({ kind: 'SIDE_REQUEST', origin: APP, path: '/cdn-cgi/rum', method: 'POST', maxPerLoginStage: 1 });
  });

  it('gives no button for a hidden path segment and for an already registered request', () => {
    expect(loginStageRegistrationOf(row({ path: `/session/${REDACTED_PATH_SEGMENT}`, query: TOKEN_QUERY }))).toEqual({ kind: 'MANUAL', reason: 'REDACTED_PATH' });
    for (const reason of ['TOKEN_REQUEST_OVER_LIMIT', 'TOKEN_REQUEST_NOT_SCRIPT', 'SIDE_REQUEST_OVER_LIMIT', 'SIDE_REQUEST_NOT_SCRIPT'] as const) {
      expect(loginStageRegistrationOf(row({ reason }))).toEqual({ kind: 'MANUAL', reason: 'ALREADY_REGISTERED' });
    }
    // T43R-fix の M-2（意図して直した期待）: 登録した token の送信先の必須の query が違った行は、`grant_type` の値があっても「登録する」を出さず、手で
    // 直す（登録した token の送り方を置き換えない。I17）。
    expect(loginStageRegistrationOf(row({ path: '/auth/v1/token', reason: 'TOKEN_REQUEST_QUERY_MISMATCH' }))).toEqual({ kind: 'MANUAL', reason: 'ALREADY_REGISTERED' });
    expect(loginStageRegistrationOf(row({ path: '/auth/v1/token', reason: 'TOKEN_REQUEST_QUERY_MISMATCH', query: TOKEN_QUERY })))
      .toEqual({ kind: 'MANUAL', reason: 'ALREADY_REGISTERED' });
  });
});

describe('T43d: the draft of the auth setup screen (never saved by itself)', () => {
  it('makes the draft of a registration with the origin, the path, the method and the grant_type value only', () => {
    const token = observedDraftOfRegistration(loginStageRegistrationOf(row({ path: '/auth/v1/token', reason: 'NON_READ_METHOD', query: TOKEN_QUERY })));
    expect(token).toEqual({ scriptLogin: { origin: SERVICE, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] } });
    const side = observedDraftOfRegistration(loginStageRegistrationOf(row({})));
    expect(side).toEqual({ sideRequests: [{ origin: SERVICE, path: '/rest/v1/rpc/resolve_tenant', method: 'POST' }] });
    expect(observedDraftOfRegistration({ kind: 'MANUAL', reason: 'REDACTED_PATH' })).toBeNull();
  });

  // T43R-fix の C-1（意図して直した期待）: 鍵の名前の案は接頭辞と接尾辞の組だけで、下書きにも名前の全体は入らない。
  it('makes the draft of an observation: the first prefix and suffix and the selector', () => {
    const draft = observedDraftOfObservation({
      storageKeys: { origin: APP, shapes: [{ prefix: '', suffix: '.idToken' }, { prefix: '', suffix: '-token' }], omitted: 0 },
      successSelector: { selector: '#logout', kind: 'LOGOUT_CONTROL', logoutWord: 'logout' },
    });
    expect(draft).toEqual({ storageKey: { origin: APP, prefix: '', suffix: '.idToken' }, successSelector: '#logout' });
    expect(observedDraftOfObservation({ credentialDiscarded: 1 })).toBeNull();
  });

  it('reads back only a closed draft with the right shapes', () => {
    const draft = {
      scriptLogin: { origin: SERVICE, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      sideRequests: [{ origin: SERVICE, path: '/rest/v1/rpc/resolve_tenant', method: 'POST' }],
      storageKey: { origin: APP, prefix: 'session.', suffix: '-token' },
      successSelector: '#logout',
    };
    expect(parseObservedAuthSetupDraft(draft)).toEqual(draft);
    for (const broken of [
      null, 'x', [], {},
      { ...draft, extra: 1 },
      { scriptLogin: { ...draft.scriptLogin, origin: `${SERVICE}/` } },
      { scriptLogin: { ...draft.scriptLogin, path: '/auth/v1/token?grant_type=password' } },
      { scriptLogin: { ...draft.scriptLogin, path: `/s/${JWT_LIKE}` } },
      { scriptLogin: { ...draft.scriptLogin, requiredQuery: [{ name: 'code', value: 'password' }] } },
      { scriptLogin: { ...draft.scriptLogin, requiredQuery: [{ name: 'grant_type', value: JWT_LIKE }] } },
      { sideRequests: [{ origin: SERVICE, path: '/x', method: 'PUT' }] },
      { sideRequests: [] },
      // T43R-fix の M-1: path の形は保存の側の owner（`isAcceptedPath`）で確かめる（`//`、`..`、符号化した `.`、使えない文字）。
      { scriptLogin: { ...draft.scriptLogin, path: '//evil.example/x' } },
      { scriptLogin: { ...draft.scriptLogin, path: '/../x' } },
      { scriptLogin: { ...draft.scriptLogin, path: '/x%2E%2E/y' } },
      { scriptLogin: { ...draft.scriptLogin, path: '/x y' } },
      { scriptLogin: { ...draft.scriptLogin, path: `/${'p'.repeat(1_024)}` } },
      { sideRequests: [{ origin: SERVICE, path: '/../x', method: 'POST' }] },
      // T43R-fix の C-1: 鍵の名前の全体と、利用者の名前が入る CSS は受けない。
      { storageKey: { origin: APP, name: 'example-auth-token' } },
      { storageKey: { origin: APP, prefix: 'LibAuth.entry-user.', suffix: '.idToken' } },
      // T43R2-fix: 一般の語でない端の部分（利用者の名前）は受けない。
      { storageKey: { origin: APP, prefix: 'entryuser.', suffix: '' } },
      { storageKey: { origin: APP, prefix: '', suffix: ':alice' } },
      { storageKey: { origin: APP, prefix: '', suffix: '' } },
      { storageKey: { origin: APP, prefix: `${JWT_LIKE}.`, suffix: '-token' } },
      { successSelector: 'text=ログアウト' },
      { successSelector: '#profile-entry-user' },
      { successSelector: 'a[href="/users/entry-user"]' },
      { successSelector: { selector: '#logout' } },
    ]) {
      expect(parseObservedAuthSetupDraft(broken), JSON.stringify(broken)).toBeNull();
    }
  });

  it('gives the origins to add to the approved service origins of the profile', () => {
    const draft = {
      scriptLogin: { origin: SERVICE, path: '/auth/v1/token', requiredQuery: [] },
      sideRequests: [{ origin: APP, path: '/cdn-cgi/rum', method: 'POST' as const }, { origin: 'http://127.0.0.1:6173', path: '/x', method: 'POST' as const }],
    };
    expect(approvedServiceOriginsToAdd(draft, { approvedTestOrigins: [APP], approvedServiceOrigins: [] })).toEqual([SERVICE, 'http://127.0.0.1:6173']);
    expect(approvedServiceOriginsToAdd(draft, { approvedTestOrigins: [APP], approvedServiceOrigins: [SERVICE, 'http://127.0.0.1:6173'] })).toEqual([]);
    expect(approvedServiceOriginsToAdd({}, { approvedTestOrigins: [APP], approvedServiceOrigins: [] })).toEqual([]);
    // T43R-fix の M-3: 保存の時点の欄の値（空の欄を含む）から決め直す。Origin の正規の直列化でない値は足さない。
    expect(approvedServiceOriginsToAdd({ scriptLogin: { origin: '' }, sideRequests: [{ origin: 'not an origin' }] }, { approvedTestOrigins: [APP], approvedServiceOrigins: [] }))
      .toEqual([]);
  });
});

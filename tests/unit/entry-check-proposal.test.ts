// T43c（Task 43 の設計書 4.3）: 入口の確かめの、読んだ事実と案の純粋な部品（`src/control/entry-check.ts`）の単体テスト。
// - 移った先（許可 Origin の中なら値に見える区切りを伏せた path、外なら Origin だけ）。
// - 案への写し: form の送信（form があり、action が許可 Origin の中で POST）、スクリプトで送る（form がない・action がない・GET）、混ざった形と
//   外部の Origin の action（送り方の案を出さない）、ログインの画面に見えない・外へ移った（案を出さない）、伏せた path（開始の URL を出さない）。
// - 終わり方と Run Status の対応、件数の要約、セレクタの受け入れ（認証の設定の検証と同じ形）。
// - 成果物のスキーマ（`schemas/entry-check.schema.json`）に通る。欄の値は、文書の形にない。
import { describe, expect, it } from 'vitest';
import { REDACTED_PATH_SEGMENT } from '../../src/core/url-path-redaction.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import {
  ENTRY_CHECK_ARTIFACT_SCHEMA_VERSION,
  ENTRY_CHECK_END_REASONS,
  entryCheckLocationOf,
  entryCheckProposalOf,
  entryCheckRunStatusOf,
  entryCheckSummaryOf,
  isAcceptedEntrySelector,
  type EntryCheckDocument,
  type EntryCheckFacts,
  type EntryCheckLocation,
} from '../../src/control/entry-check.js';

const ORIGIN = 'http://127.0.0.1:5173';
const OTHER_ORIGIN = 'http://localhost:5174';
const ALLOWED = [ORIGIN];

const landing: EntryCheckLocation = { origin: ORIGIN, path: '/auth', inAllowedOrigins: true };

const factsOf = (overrides: Partial<EntryCheckFacts['form']> = {}, loginPage = true): EntryCheckFacts => ({
  loginPage,
  fields: {
    username: { candidates: 1, selector: '#email' },
    password: { candidates: 1, selector: '#password' },
    submit: { candidates: 1, selector: '#login' },
  },
  form: { placement: 'SAME', action: { origin: ORIGIN, path: '/session', inAllowedOrigins: true }, method: 'POST', ...overrides },
});

describe('T43c: the landing location', () => {
  it('keeps the path inside the allowed origins, without the query, and hides a value-like segment', () => {
    expect(entryCheckLocationOf(`${ORIGIN}/auth?next=/admin#x`, ALLOWED)).toEqual({ origin: ORIGIN, path: '/auth', inAllowedOrigins: true });
    expect(entryCheckLocationOf(`${ORIGIN}/invite/0123456789abcdef0123456789abcdef/login`, ALLOWED))
      .toEqual({ origin: ORIGIN, path: `/invite/${REDACTED_PATH_SEGMENT}/login`, inAllowedOrigins: true });
  });

  it('keeps only the origin outside the allowed origins', () => {
    expect(entryCheckLocationOf(`${OTHER_ORIGIN}/sso/login?client=abc`, ALLOWED)).toEqual({ origin: OTHER_ORIGIN, path: null, inAllowedOrigins: false });
  });

  it('gives null for a value that is not an http(s) URL', () => {
    expect(entryCheckLocationOf('about:blank', ALLOWED)).toBeNull();
    expect(entryCheckLocationOf('chrome-error://chromewebdata/', ALLOWED)).toBeNull();
    expect(entryCheckLocationOf('not a url', ALLOWED)).toBeNull();
  });
});

describe('T43c: mapping the facts to the proposal of the auth setup', () => {
  it('proposes the form submission with its endpoint (a form whose action is in the allowed origins, POST)', () => {
    expect(entryCheckProposalOf(landing, factsOf())).toEqual({
      loginStartUrl: `${ORIGIN}/auth`,
      sessionLostPathPrefix: '/auth',
      loginTransport: 'FORM_NAVIGATION',
      loginPostEndpoint: { origin: ORIGIN, path: '/session' },
      selectors: { username: '#email', password: '#password', submit: '#login' },
    });
  });

  it('proposes the script request for no form, a form without an action, and a GET form', () => {
    for (const form of [
      { placement: 'NONE' as const, action: null, method: null },
      { placement: 'SAME' as const, action: null, method: 'POST' as const },
      { placement: 'SAME' as const, method: 'GET' as const },
    ]) {
      const proposal = entryCheckProposalOf(landing, factsOf(form));
      expect(proposal?.loginTransport).toBe('SCRIPT_REQUEST');
      expect(proposal?.loginPostEndpoint).toBeNull();
      expect(proposal?.selectors).toEqual({ username: '#email', password: '#password', submit: '#login' });
    }
  });

  it('proposes no transport for the mixed placement, an action outside the allowed origins, or an action with a hidden segment', () => {
    for (const form of [
      { placement: 'MIXED' as const },
      { placement: null },
      { action: { origin: OTHER_ORIGIN, path: null, inAllowedOrigins: false } },
      { action: { origin: ORIGIN, path: `/session/${REDACTED_PATH_SEGMENT}`, inAllowedOrigins: true } },
      { method: 'DIALOG' as const },
    ]) {
      const proposal = entryCheckProposalOf(landing, factsOf(form));
      expect(proposal?.loginTransport).toBeNull();
      expect(proposal?.loginPostEndpoint).toBeNull();
      expect(proposal?.loginStartUrl).toBe(`${ORIGIN}/auth`);
    }
  });

  it('keeps only the selectors of the fields with exactly one candidate', () => {
    const facts = factsOf({ placement: null });
    const proposal = entryCheckProposalOf(landing, {
      ...facts,
      fields: { ...facts.fields, username: { candidates: 2, selector: null }, submit: { candidates: 0, selector: null } },
    });
    expect(proposal?.selectors).toEqual({ username: null, password: '#password', submit: null });
  });

  it('proposes nothing for a page that does not look like a login page, or a landing outside the allowed origins', () => {
    expect(entryCheckProposalOf(landing, factsOf({}, false))).toBeNull();
    expect(entryCheckProposalOf({ origin: OTHER_ORIGIN, path: null, inAllowedOrigins: false }, factsOf())).toBeNull();
  });

  it('does not propose the login start URL or the session lost path for a landing path with a hidden segment', () => {
    const proposal = entryCheckProposalOf({ origin: ORIGIN, path: `/invite/${REDACTED_PATH_SEGMENT}`, inAllowedOrigins: true }, factsOf());
    expect(proposal?.loginStartUrl).toBeNull();
    expect(proposal?.sessionLostPathPrefix).toBeNull();
    expect(proposal?.loginTransport).toBe('FORM_NAVIGATION');
  });
});

describe('T43c: the end reasons, the run status and the summary', () => {
  // Run Status は唯一の判定 `deriveRunStatus` に任せる（読み込みの失敗は、PREFLIGHT の失敗でないので `PARTIAL`）。
  it('maps each end reason to a run status through deriveRunStatus', () => {
    expect(Object.fromEntries(ENTRY_CHECK_END_REASONS.map((reason) => [reason, entryCheckRunStatusOf(reason)]))).toEqual({
      READ: 'COMPLETE',
      LEFT_ALLOWED_ORIGINS: 'COMPLETE',
      READ_FAILED: 'PARTIAL',
      STOPPED: 'PARTIAL',
      NAVIGATION_FAILED: 'PARTIAL',
      PREFLIGHT_FAILED: 'FAILED',
      SAFETY_VIOLATION: 'ABORTED_BY_SAFETY',
    });
  });

  it('accepts only the selectors that the auth setup accepts (standard CSS, no control character, within the length)', () => {
    expect(isAcceptedEntrySelector('#email')).toBe(true);
    expect(isAcceptedEntrySelector('input[name="a>>b"]')).toBe(false);
    expect(isAcceptedEntrySelector('#a\u0001')).toBe(false);
    expect(isAcceptedEntrySelector(`#${'a'.repeat(300)}`)).toBe(false);
    expect(isAcceptedEntrySelector('   ')).toBe(false);
  });

  it('summarizes the end reason, whether it looks like a login page, and the number of proposed selectors; and passes the schema', async () => {
    const facts = factsOf();
    const document: EntryCheckDocument = {
      schemaVersion: ENTRY_CHECK_ARTIFACT_SCHEMA_VERSION,
      jobId: 'job-entry-1',
      runId: 'RUN-20261017000000',
      startedAt: '20261017000000',
      finishedAt: '20261017000001',
      runStatus: 'COMPLETE',
      endReason: 'READ',
      landing,
      facts,
      proposal: entryCheckProposalOf(landing, facts),
      blockedRequests: 0,
    };
    expect(entryCheckSummaryOf(document)).toEqual({ endReason: 'READ', loginPage: true, proposedSelectors: 3 });
    expect(await validateArtifact('entry-check', document)).toEqual({ ok: true });
    expect(await validateArtifact('entry-check', { ...document, fields: { username: { value: 'x' } } })).toMatchObject({ ok: false });
    const unread: EntryCheckDocument = { ...document, runStatus: 'PARTIAL', endReason: 'NAVIGATION_FAILED', landing: null, facts: null, proposal: null };
    expect(entryCheckSummaryOf(unread)).toEqual({ endReason: 'NAVIGATION_FAILED', loginPage: null, proposedSelectors: 0 });
    expect(await validateArtifact('entry-check', unread)).toEqual({ ok: true });
  });
});

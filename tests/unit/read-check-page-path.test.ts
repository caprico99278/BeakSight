// T40b-2（Task 40 の設計書 3.3、7 章の「T40b-2 の設計（照合の READ の確かめ直し）」）: 画面の path の確かめの唯一の owner（`src/control/read-check-page-path.ts`
// の `readCheckPagePathRejectionsOf`）と、ワーカーの照合の READ の `{id}` の画面の読む URL の決め方（`src/worker/read-check-run.ts` の
// `recordPageReadTargetOf`）。
// - owner: 正規の形、開始の URL、開始の URL の Origin と許可 Origin・承認したテストの Origin、読まないパス・読む範囲・ログインの画面、危険な語。保存の確かめ
//   （`validateReadCheckDefinition` の画面の path の定義）は、この owner を呼ぶだけ（理由の値と順が同じ）。
// - ワーカー: `{id}` に使える ID だけを入れ、組み立てた具体的な path に owner の判定と `isReadUrlAllowed` をかける。当たれば `REQUEST_POLICY`、組み立て
//   られない（型でない定義、使えない ID、親が入れた対象の画面と違う）なら `URL_NOT_BUILT`。
// - form の書き込みの照合の READ（`verifyReadCheck`）は、画面の path の定義を今のまま読まずに止める（`REQUEST_POLICY`）。
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { readCheckPagePathRejectionsOf, type ReadCheckPageContext } from '../../src/control/read-check-page-path.js';
import { validateReadCheckDefinition } from '../../src/control/read-check-policy.js';
import type { WorkerStartReadCheck } from '../../src/control/worker-protocol.js';
import { checkedReadCheckPagePathOf } from '../../src/discovery/read-check-contracts.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { recordPageReadTargetOf, verifyReadCheck } from '../../src/worker/read-check-run.js';
import { createTestConfig } from '../helpers/test-config.js';

const ORIGIN = 'http://127.0.0.1:4173';
const OTHER_ORIGIN = 'http://127.0.0.1:4174';
const TEMPLATE = '/admin/members/{id}';
const CONTEXT: ReadCheckPageContext = Object.freeze({
  startUrl: `${ORIGIN}/admin`,
  allowedOrigins: [ORIGIN],
  approvedTestOrigins: [ORIGIN],
  excludedPathPrefixes: ['/admin/members/x-hidden'],
  auditPathPrefixes: ['/admin'],
  sessionLostPathPrefix: '/admin/members/login',
});

describe('T40b-2: the owner of the page path check (readCheckPagePathRejectionsOf)', () => {
  it.each([
    ['a path inside the audit paths', '/admin/members/7', []],
    ['a path that is not canonical', '/admin/../members/7', ['READ_PAGE_PATH_INVALID']],
    ['a path with a query', '/admin/members/7?x=1', ['READ_PAGE_PATH_INVALID']],
    ['a path under an excluded path (the id joins the rest of the template)', '/admin/members/x-hidden-1', ['READ_PAGE_PATH_EXCLUDED']],
    ['a path outside the audit paths', '/members/7', ['READ_PAGE_PATH_EXCLUDED']],
    ['the login screen', '/admin/members/login-1', ['READ_PAGE_PATH_EXCLUDED']],
    ['a path with a dangerous word', '/admin/members/delete-1', ['READ_PAGE_PATH_DANGEROUS_WORD']],
    ['an excluded path with a dangerous word', '/admin/members/x-hidden-delete', ['READ_PAGE_PATH_EXCLUDED', 'READ_PAGE_PATH_DANGEROUS_WORD']],
  ] as const)('judges %s', (_name, path, expected) => {
    expect(readCheckPagePathRejectionsOf(path, CONTEXT)).toEqual(expected);
  });

  it('rejects an unknown start URL and an origin outside the allowed origins of the profile', () => {
    expect(readCheckPagePathRejectionsOf('/admin/members/7', null)).toEqual(['READ_PAGE_START_URL_UNKNOWN']);
    expect(readCheckPagePathRejectionsOf('/admin/members/7', { ...CONTEXT, startUrl: 'not a url' })).toEqual(['READ_PAGE_START_URL_UNKNOWN']);
    expect(readCheckPagePathRejectionsOf('/admin/members/7', { ...CONTEXT, approvedTestOrigins: [OTHER_ORIGIN] })).toEqual(['READ_PAGE_ORIGIN_NOT_ALLOWED']);
    expect(readCheckPagePathRejectionsOf('/admin/members/7', { ...CONTEXT, allowedOrigins: [OTHER_ORIGIN] })).toEqual(['READ_PAGE_ORIGIN_NOT_ALLOWED']);
  });

  it('gives the same reasons in the same order as the validation of a stored page path definition', () => {
    const contexts: readonly (ReadCheckPageContext | null)[] = [CONTEXT, null, { ...CONTEXT, approvedTestOrigins: [OTHER_ORIGIN] }];
    const paths = ['/admin/members/7', TEMPLATE, '/admin/members/x-hidden-{id}', '/admin/members/{id}/delete', '/admin/../x', '/admin/{id', '/members/{id}'];
    for (const context of contexts) {
      for (const targetPagePath of paths) {
        const validated = validateReadCheckDefinition({ targetPagePath, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] }, null, context);
        const checked = checkedReadCheckPagePathOf(targetPagePath);
        const expected = checked === null ? ['READ_PAGE_PATH_INVALID'] : readCheckPagePathRejectionsOf(checked, context);
        expect(validated.ok ? [] : validated.errors.map(({ code }) => code), `${targetPagePath} ${JSON.stringify(context)}`).toEqual(expected);
      }
    }
  });
});

describe('T40b-2: the URL of the {id} page of the verification READ of an API write (recordPageReadTargetOf)', () => {
  const config = createTestConfig(ORIGIN, '/admin');
  const authentication: RunAuthentication = {
    initialState: { cookies: [], origins: [] },
    approvedTestOrigins: [ORIGIN],
    auditExclusions: { excludedPathPrefixes: ['/admin/members/x-hidden'], auditPathPrefixes: ['/admin'], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
    sessionLostPathPrefix: '/admin/members/login',
    filterState: filterAuthenticatedState,
  };
  const pageReadCheck = (overrides: Partial<WorkerStartReadCheck> = {}): WorkerStartReadCheck => ({
    readCheckId: 'rc-api',
    readCheckRevision: 1,
    targetPage: { origin: ORIGIN, path: TEMPLATE },
    definition: { targetPagePath: TEMPLATE, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] },
    ...overrides,
  });

  it('builds the URL of the start origin and the path with a usable record id', () => {
    expect(recordPageReadTargetOf(pageReadCheck(), '7', config, authentication)).toEqual({ ok: true, url: `${ORIGIN}/admin/members/7` });
    expect(recordPageReadTargetOf(pageReadCheck(), 'abc_D-9', config, authentication)).toEqual({ ok: true, url: `${ORIGIN}/admin/members/abc_D-9` });
  });

  it.each([
    ['an excluded path (the id joins the rest of the template)', 'x-hidden-1'],
    ['a dangerous word', 'delete-1'],
    ['the login screen', 'login-1'],
  ])('blocks the path that falls under %s by the policy, with the URL', (_name, recordId) => {
    expect(recordPageReadTargetOf(pageReadCheck(), recordId, config, authentication))
      .toEqual({ ok: false, detail: 'REQUEST_POLICY', url: `${ORIGIN}/admin/members/${recordId}` });
  });

  it('blocks a path outside the audit paths by the policy', () => {
    const outside = { ...authentication, auditExclusions: { ...authentication.auditExclusions, auditPathPrefixes: ['/other'] } };
    expect(recordPageReadTargetOf(pageReadCheck(), '7', config, outside)).toMatchObject({ ok: false, detail: 'REQUEST_POLICY' });
  });

  it.each(['', '..', 'a/b', 'a.b', '%2e', 'a b', '会員', 'x'.repeat(65)])('does not build the URL for the unusable record id %j', (recordId) => {
    expect(recordPageReadTargetOf(pageReadCheck(), recordId, config, authentication)).toEqual({ ok: false, detail: 'URL_NOT_BUILT', url: null });
  });

  it('does not build the URL for a definition that is not a template, nor for a target page that differs from the template', () => {
    const candidate = pageReadCheck({ definition: { targetIdentityDigest: `sha256:${'a'.repeat(64)}`, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] } });
    const plainPage = pageReadCheck({ definition: { targetPagePath: '/admin/members', parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] } });
    for (const readCheck of [
      candidate,
      plainPage,
      pageReadCheck({ targetPage: null }),
      pageReadCheck({ targetPage: { origin: OTHER_ORIGIN, path: TEMPLATE } }),
      pageReadCheck({ targetPage: { origin: ORIGIN, path: '/admin/members/7' } }),
    ]) {
      expect(recordPageReadTargetOf(readCheck, '7', config, authentication), JSON.stringify(readCheck)).toEqual({ ok: false, detail: 'URL_NOT_BUILT', url: null });
    }
  });

  it('keeps rejecting a page path definition in the verification READ of a form write (T37d, the decision 5), without reading', async () => {
    const checked = await verifyReadCheck(null as never, null as never, pageReadCheck(), {
      config, allowedQueryParameters: new Set(), authentication,
    });
    expect(checked).toMatchObject({ evidence: { state: 'EXECUTED', result: 'READ_BLOCKED_BY_POLICY', detail: 'REQUEST_POLICY', url: null }, violation: false });
  });
});

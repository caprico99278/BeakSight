// T38c（Task 38 の設計書 3.4、7 章の履歴のユーザーの判断 (3)、T38c の Blocker の判断（案 A））: `{id}` つきの画面の path の READ の定義。
// - READ の契約: 画面の path の型は、path の区切りのちょうど 1 つの全体が `{id}`（`isReadCheckPageTemplatePath`）。読む URL は、台帳の ID（安全な形の判定は
//   呼び出し側の唯一の判定 `isUsableRecordId` を受ける）を入れて組み立てる（`readCheckPageTemplateUrlOf`。ほかの形・安全でない ID は null）。
// - 保存の確かめ（`read-check-policy.ts`）: 型の `{id}` に代わりの値を入れて、今の画面の READ の確かめ（正規の形・読まないパス・危険な語）を通す。
// - 書き込みの開始（`write-job-start.ts`）: 照合の READ の画面の path の定義は、送り方が API で `{id}` の型のときだけ通す（今は到達しない準備の口）。
import { describe, expect, it } from 'vitest';
import { isUsableRecordId } from '../../src/control/actions/action-outcome.js';
import { WRITE_READ_VERIFICATION_PAGE_TARGET, readVerificationTargetRejectionOf } from '../../src/control/job/write-job-start.js';
import {
  assertStorableReadCheckDefinition,
  validateReadCheckDefinition,
  type ReadCheckPageContext,
} from '../../src/control/read-check-policy.js';
import {
  READ_CHECK_PAGE_TEMPLATE_SAMPLE_ID,
  isReadCheckPageTemplatePath,
  readCheckPageTemplateUrlOf,
  type ReadCheckDefinition,
} from '../../src/discovery/read-check-contracts.js';
import { PATH_TEMPLATE_ID_SEGMENT } from '../../src/discovery/fingerprint.js';

const ORIGIN = 'http://127.0.0.1:4173';
const TEMPLATE = '/admin/members/{id}';

describe('T38c: the page path template of a READ check definition (the contract)', () => {
  it('is a path whose exactly one segment is {id} as a whole', () => {
    expect(PATH_TEMPLATE_ID_SEGMENT).toBe('{id}');
    expect(isReadCheckPageTemplatePath(TEMPLATE)).toBe(true);
    expect(isReadCheckPageTemplatePath('/admin/members/{id}/detail')).toBe(true);
    for (const path of ['/admin/members', '/admin/{id}/members/{id}', '/admin/members/{id}x', '/admin/members/x{id}', '/admin/{ID}', '/admin/{id', '{id}']) {
      expect(isReadCheckPageTemplatePath(path), path).toBe(false);
    }
  });

  it('builds the URL with a safe record id of the ledger only', () => {
    expect(readCheckPageTemplateUrlOf(ORIGIN, TEMPLATE, '12', isUsableRecordId)).toBe(`${ORIGIN}/admin/members/12`);
    expect(readCheckPageTemplateUrlOf(ORIGIN, TEMPLATE, 'abc_D-9', isUsableRecordId)).toBe(`${ORIGIN}/admin/members/abc_D-9`);
    expect(READ_CHECK_PAGE_TEMPLATE_SAMPLE_ID).toBe('1');
    expect(isUsableRecordId(READ_CHECK_PAGE_TEMPLATE_SAMPLE_ID)).toBe(true);
    for (const recordId of ['', '..', 'a/b', '%2e', 'a b', 'a?b', 'a#b', '会員', 'x'.repeat(65)]) {
      expect(readCheckPageTemplateUrlOf(ORIGIN, TEMPLATE, recordId, isUsableRecordId), recordId).toBeNull();
    }
    // 型でない path、2 つの `{id}`、正規の形でない path は組み立てない。
    expect(readCheckPageTemplateUrlOf(ORIGIN, '/admin/members/1', '1', isUsableRecordId)).toBeNull();
    expect(readCheckPageTemplateUrlOf(ORIGIN, '/admin/{id}/x/{id}', '1', isUsableRecordId)).toBeNull();
    expect(readCheckPageTemplateUrlOf(ORIGIN, '/admin/../{id}', '1', isUsableRecordId)).toBeNull();
    // 安全な形の判定は呼び出し側から受ける（受けた判定が拒めば組み立てない）。
    expect(readCheckPageTemplateUrlOf(ORIGIN, TEMPLATE, '12', () => false)).toBeNull();
  });
});

describe('T38c: the validation of a page path template definition (read-check-policy)', () => {
  const CONTEXT: ReadCheckPageContext = Object.freeze({
    startUrl: `${ORIGIN}/admin`,
    allowedOrigins: [ORIGIN],
    approvedTestOrigins: [ORIGIN],
    excludedPathPrefixes: ['/admin/secret'],
    auditPathPrefixes: [],
    sessionLostPathPrefix: '/auth',
  });
  const pageDefinition = (path: string): Record<string, unknown> => ({ targetPagePath: path, parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] });

  it('accepts a template with the checks of a page path (the {id} replaced by a sample id)', () => {
    const input = pageDefinition(TEMPLATE);
    expect(validateReadCheckDefinition(input, null, CONTEXT)).toEqual({ ok: true, definition: input });
    expect(assertStorableReadCheckDefinition(input as unknown as ReadCheckDefinition)).toEqual(input);
  });

  it.each([
    ['two {id} segments', '/admin/{id}/members/{id}', 'READ_PAGE_PATH_INVALID'],
    ['a brace that is not a whole {id} segment', '/admin/members/{id}x', 'READ_PAGE_PATH_INVALID'],
    ['an excluded path', '/admin/secret/{id}', 'READ_PAGE_PATH_EXCLUDED'],
    ['a dangerous word', '/admin/members/{id}/delete', 'READ_PAGE_PATH_DANGEROUS_WORD'],
  ])('rejects %s', (_label, path, code) => {
    const result = validateReadCheckDefinition(pageDefinition(path), null, CONTEXT);
    expect(result.ok ? [] : result.errors.map((error) => error.code)).toEqual([code]);
  });

  it('does not store a template that is not canonical', () => {
    expect(() => assertStorableReadCheckDefinition(pageDefinition('/admin/{id}/x/{id}') as unknown as ReadCheckDefinition)).toThrow(RangeError);
  });
});

describe('T38c: the verification READ of a page path template at the write start (write-job-start)', () => {
  const page = (path: string) => ({ definition: { targetPagePath: path, parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST' as const, count: 1 }] } });
  const candidate = { definition: { targetIdentityDigest: `sha256:${'a'.repeat(64)}`, parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST' as const, count: 1 }] } };

  it('passes a template page READ only for an API scenario, and rejects every other page READ as before', () => {
    expect(readVerificationTargetRejectionOf(page(TEMPLATE), 'API')).toBeNull();
    expect(readVerificationTargetRejectionOf(page(TEMPLATE), 'FORM')).toBe(WRITE_READ_VERIFICATION_PAGE_TARGET);
    expect(readVerificationTargetRejectionOf(page('/admin/members/1'), 'API')).toBe(WRITE_READ_VERIFICATION_PAGE_TARGET);
    expect(readVerificationTargetRejectionOf(page('/admin/members/1'), 'FORM')).toBe(WRITE_READ_VERIFICATION_PAGE_TARGET);
    expect(readVerificationTargetRejectionOf(candidate, 'FORM')).toBeNull();
    expect(readVerificationTargetRejectionOf(candidate, 'API')).toBeNull();
  });
});

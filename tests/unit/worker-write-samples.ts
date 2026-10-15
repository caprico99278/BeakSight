// T30e: 書き込みのジョブ（`WRITE_CREATE`）の `START` の書き込みの指定の例（テストのファイルではない。`worker-protocol-write.test.ts` と
// `audit-worker-session-unsupported-job-kind.test.ts` が使う）。値は匿名の合成のテストデータだけ（`127.0.0.1`、`example.invalid`）。
// T31f: 更新の書き込みのジョブ（`WRITE_UPDATE`）の例（`sampleStartUpdateWrite`）も置く。
// T32d: 承認の要約（`approvalFacts`。シナリオ・版・許可・プロファイル・種類を書き込みの指定に合わせる）も持つ。
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';

const DIGEST = `sha256:${'b'.repeat(64)}`;
const RULE_DIGEST = `sha256:${'c'.repeat(64)}`;

/** 候補の欄 1 件（名前・型・状態だけ）。 */
export const sampleWriteField = (
  name: string,
  type = 'text',
  flags: Partial<Record<'readonly' | 'hidden' | 'disabled', boolean>> = {},
): Record<string, unknown> => ({ name, type, readonly: false, hidden: type === 'hidden', disabled: false, ...flags });

/** 書き込みの指定（受ける形。`origin` の画面の登録の form）。 */
export const sampleStartWrite = (origin: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  scenarioId: 'scenario-1',
  scenarioRevision: 3,
  grantId: 'grant-1',
  // T30f（Blocker 1 の案 A）: プロファイルと、生成の seed の記録（親が送る前の記録に書いたもの）。
  profileId: 'profile-1',
  seedRecord: {
    seed: 'd'.repeat(64),
    seedInput: { profileId: 'profile-1', scenarioId: 'scenario-1', scenarioRevision: 3, ruleSetDigest: RULE_DIGEST, executionGrantId: 'grant-1' },
    baseDate: '2026-10-13',
    attempt: 0,
  },
  request: { formMethod: 'POST', methodOverride: null, origin, path: '/members', enctype: 'application/x-www-form-urlencoded' },
  formPage: { origin, path: '/members/new' },
  candidate: { identityDigest: DIGEST, ruleDigest: RULE_DIGEST },
  candidateFields: [sampleWriteField('name'), sampleWriteField('email', 'email'), sampleWriteField('newsletter', 'checkbox'),
    sampleWriteField('authenticity_token', 'hidden'), sampleWriteField('kept', 'text', { readonly: true }), sampleWriteField('attachment', 'file'),
    sampleWriteField('_method', 'hidden')],
  values: { name: 'サンプル 太郎', email: 'sample0001@example.invalid', newsletter: null },
  verification: {
    successCondition: { pathPrefix: '/members/', selector: '.registered' },
    inputErrorCondition: { pathPrefix: '/members/new', selector: '.error' },
    recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/members/{id}' },
  },
  readVerification: {
    readCheckId: 'rc-verify',
    readCheckRevision: 1,
    targetPage: { origin, path: '/members' },
    definition: { targetIdentityDigest: DIGEST, parameters: { q: 'サンプル 太郎' }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] },
  },
  approvalFacts: sampleApprovalFacts({ kind: 'CREATE', profileId: 'profile-1', scenarioId: 'scenario-1', scenarioRevision: 3, grantId: 'grant-1' }),
  ...overrides,
});

/** T31f: 更新の対象のレコードの ID の例（親が実行の許可から写す）。 */
export const SAMPLE_UPDATE_TARGET_RECORD_ID = '42';

/** T31f: 候補の型にした識別の digest の例。 */
export const SAMPLE_TEMPLATED_IDENTITY_DIGEST = `sha256:${'e'.repeat(64)}`;

/**
 * T31f: 更新の書き込みの指定（受ける形。`origin` の画面の更新の form）。画面の path と送信先の path は、型（`/members/{id}/edit`・`/members/{id}`）に
 * 対象の ID を入れた具体的な path。送る値は変える欄の新しい値だけで、保つ欄の値と前の値は持たない。
 */
export const sampleStartUpdateWrite = (origin: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const base = sampleStartWrite(origin);
  return {
    ...base,
    request: { formMethod: 'POST', methodOverride: 'PATCH', origin, path: `/members/${SAMPLE_UPDATE_TARGET_RECORD_ID}`,
      enctype: 'application/x-www-form-urlencoded' },
    formPage: { origin, path: `/members/${SAMPLE_UPDATE_TARGET_RECORD_ID}/edit` },
    values: { name: 'サンプル 次郎', email: 'sample0002@example.invalid' },
    readVerification: {
      ...(base['readVerification'] as Record<string, unknown>),
      definition: { targetIdentityDigest: DIGEST, parameters: { q: 'サンプル 次郎' }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] },
    },
    update: {
      targetRecordId: SAMPLE_UPDATE_TARGET_RECORD_ID,
      templatedIdentityDigest: SAMPLE_TEMPLATED_IDENTITY_DIGEST,
      changedFieldNames: ['email', 'name'],
      keptFieldNames: ['newsletter'],
    },
    approvalFacts: sampleApprovalFacts({ kind: 'UPDATE', profileId: 'profile-1', scenarioId: 'scenario-1', scenarioRevision: 3, grantId: 'grant-1' }),
    ...overrides,
  };
};

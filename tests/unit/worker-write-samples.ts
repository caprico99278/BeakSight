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

/** T40a: API の Origin の例（承認したサービスの Origin。`START` の認証の指定の `approvedServiceOrigins` に入れる）。 */
export const SAMPLE_API_ORIGIN = 'http://127.0.0.2:4174';

/** T40a: 照合の READ の `{id}` の型の画面の path の例。 */
export const SAMPLE_API_READ_TEMPLATE_PATH = '/admin/members/{id}/edit';

/**
 * T40a: 送り方 API の登録の書き込みの指定（受ける形。`origin` の form のない登録の画面と、`apiOrigin` の API）。API の指定はシナリオの API の指定の
 * 形のまま（鍵と欄の対応、ページが決める鍵、許すヘッダの名前、ID の取り方）。値は欄に対応する鍵ごとの生成した値だけ（ページが決める鍵の値は
 * 持たない）。照合の READ は `{id}` の型の画面の READ（送る値なし）。
 */
export const sampleStartApiWrite = (origin: string, overrides: Record<string, unknown> = {}, apiOrigin = SAMPLE_API_ORIGIN): Record<string, unknown> => ({
  transport: 'API',
  scenarioId: 'scenario-1',
  scenarioRevision: 3,
  grantId: 'grant-1',
  profileId: 'profile-1',
  seedRecord: {
    seed: 'd'.repeat(64),
    seedInput: { profileId: 'profile-1', scenarioId: 'scenario-1', scenarioRevision: 3, ruleSetDigest: RULE_DIGEST, executionGrantId: 'grant-1' },
    baseDate: '2026-10-13',
    attempt: 0,
  },
  formPage: { origin, path: '/admin/members/new' },
  candidate: { identityDigest: DIGEST, ruleDigest: RULE_DIGEST },
  submitterIdentityDigest: DIGEST,
  api: {
    shapeDigest: `sha256:${'f'.repeat(64)}`,
    request: {
      method: 'POST', origin: apiOrigin, pathShape: '/rest/v1/members', queryNames: ['select'], contentType: 'application/json',
      prefer: ['return=representation'],
    },
    // T38R2-fix: 鍵と欄の対応は、目印を入れた欄の型（`fieldType`）も持つ。
    keyFields: [
      { key: 'email', type: 'string', field: { kind: 'NAME', name: 'email' }, fieldType: 'email' },
      { key: 'name', type: 'string', field: { kind: 'NAME', name: 'name' }, fieldType: 'text' },
      { key: 'score', type: 'number', field: { kind: 'SELECTOR', selector: '#score' }, fieldType: 'number' },
    ],
    pageKeys: [{ key: 'tenant_id', type: 'string' }],
    headerNames: ['authorization', 'content-type', 'prefer'],
    filterName: null,
    recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' },
    ledger: null,
  },
  values: { email: 'sample0001@example.invalid', name: 'サンプル 太郎', score: '7' },
  // T40a-fix: API の書き込みの指定は、成否の条件と入力の誤りの条件を持たない（null）。ID の取り方は検証の指定の `recordId`（API の `recordId` が
  // あれば null でもよい）。
  verification: {
    successCondition: null,
    inputErrorCondition: null,
    recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/admin/members/{id}/edit' },
  },
  readVerification: {
    readCheckId: 'rc-api-verify',
    readCheckRevision: 1,
    targetPage: { origin, path: SAMPLE_API_READ_TEMPLATE_PATH },
    definition: { targetPagePath: SAMPLE_API_READ_TEMPLATE_PATH, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'sample0001@example.invalid' }] },
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

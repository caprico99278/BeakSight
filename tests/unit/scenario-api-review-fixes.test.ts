// T38R-fix（Task 38 の設計書 7 章の最後の行。独立レビュー T38R の C-1・C-2・I-1・I-2・M-1・M-2）: API のシナリオの承認の結び付けの穴を塞ぐ。
// - C-1: 索引の型の digest は、結果が `API_CREATE`・`API_UPDATE` の probe の型だけ（2 つの要求になった probe の型は入れない）。下書きは probe の
//   読み取りでない要求の数で分類し直し、記録できなかった型がある probe を拒む。
// - C-2: 承認と有効性の API の分岐は、シナリオの Origin が今のプロファイルの承認したサービスの Origin の一覧の、型の番号と同じ位置にあることと、索引を
//   書いた最新の発見のジョブの改訂が今の改訂と同じことを求める。
// - I-1: 鍵と欄の対応（欄の識別）が変われば、再承認（`CANDIDATE_FIELDS_CHANGED`。索引の鍵と欄の digest と、有効性で照らす）。
// - I-2: ページが決める鍵と登録の ID の鍵の秘密に見える名前は部分一致の fail-closed の方針で拒む。ページが決める鍵の JSON の型は scalar だけ。
// - M-1: `{id}` の型は、前に固定の区切りを 1 つ以上求める。M-2: probe の結果と kind の対応、ページが付けるヘッダの名前の正規化は、契約の 1 か所。
// T38R2-fix（再レビュー T38R2 の I-1・M-1・M-2。M-3 の管理データの版 13 の列の確かめは、LG-2 で版 1〜16 の段と一緒に捨てた）:
// - R2-I-1: 同じ識別で、書き込みでない probe に出た型の digest は、書き込みの probe にあっても使えない（まとめの部品が、その型の行を書き込みでない行に
//   する。索引・型で引く口・画面の行は、まとめた後の行を使う）。probe の並びの順に依らない。
// - R2-M-1: 方針 6 の比べ方は NFKC で畳み、欄の名前の語の単位（数字と頭字語の境で分ける）で比べる。語を足した。
// - R2-M-2: 鍵と欄の対応の digest に、欄の型を入れる（シナリオの鍵と欄の対応が欄の型を持つ）。
import { describe, expect, it } from 'vitest';
import { computeApprovalDigest } from '../../src/control/approval/approval-digest.js';
import {
  APPROVAL_INVALIDITY_REASONS,
  evaluateApprovalValidity,
  type ApprovalCurrentFacts,
} from '../../src/control/approval/approval-validity.js';
import { apiKeyFieldsDigestOf, type ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import {
  SCENARIO_DRAFT_REJECTION_REASONS,
  validateScenarioDraft,
  type ScenarioDraftContext,
  type ScenarioDraftValidationResult,
} from '../../src/control/approval/scenario-policy.js';
import { candidateOfDiscoveryDocumentByShape } from '../../src/control/discovery-candidate-lookup.js';
import { discoveryIndexEntryOf } from '../../src/control/job/discovery-index-store.js';
import { apiRequestShapeOf, pageHeaderNamesOf, type ApiRequestShape } from '../../src/core/api-request-shape.js';
import { apiShapeDigestOf } from '../../src/discovery/api-shape-classification.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { isApiWriteKeyNameSecretLike } from '../../src/discovery/classify.js';
import { mergeDiscoveryCandidates, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { isReadCheckPageTemplatePath } from '../../src/discovery/read-check-contracts.js';
import {
  SUBMISSION_PROBE_WRITE_RESULTS,
  observedSubmissionProbeOf,
  submissionProbeWriteOf,
  type SubmissionProbeInputField,
  type SubmissionProbeRecord,
} from '../../src/discovery/submission-probe-contracts.js';
import {
  ALL_CONFIRMED,
  AUTH_SETUP_DIGEST,
  INPUT_RULES,
  PROFILE_ID,
  READ_CHECK_FACTS,
  TARGET_CONFIG_DIGEST,
  candidateOf,
  sampleApproval,
  sampleScenario,
} from './approval-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const API = 'https://api.example.invalid';
const OTHER_API = 'https://other.example.invalid';
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid', '123456789'];
const NEW_PATH = '/admin/members/new';
const INPUT_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
  { name: null, selector: '#note', type: 'number', marker: 2 },
];
const BASE_BODY = { name: MARKERS[0], email: MARKERS[1], note: Number(MARKERS[2]), tenant_id: 'tenant-1' };

const shapeOf = (body: unknown = BASE_BODY, url = `${API}/rest/v1/members?select=*`): ApiRequestShape => apiRequestShapeOf({
  method: 'POST',
  resourceType: 'fetch',
  url,
  origin: { kind: 'APPROVED_API', index: 0 },
  headers: { 'content-type': 'application/json', prefer: 'return=representation' },
  body: { kind: 'TEXT', text: JSON.stringify(body) },
}, { pagePath: NEW_PATH, markers: MARKERS });

const probeOf = (shapes: readonly ApiRequestShape[], nonRead = shapes.length, inputFields = INPUT_FIELDS, unrecorded = 0): SubmissionProbeRecord =>
  observedSubmissionProbeOf({ shapes, nonReadRequestCount: nonRead, readRequestCount: 0, unrecordedShapeCount: unrecorded },
    { filledFieldCount: 3, skippedFieldCount: 0 }, inputFields);
const forged = (shape: ApiRequestShape, extra: Partial<SubmissionProbeRecord> = {}): SubmissionProbeRecord =>
  ({ ...probeOf([shape]), result: 'API_CREATE', reason: null, shape, shapeDigest: apiShapeDigestOf(shape), ...extra });
const buttonOf = (probe: SubmissionProbeRecord): DiscoveryCandidate => ({
  ...candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: NEW_PATH }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: probe,
});
const CONTEXT: ScenarioDraftContext = {
  scenarioId: null, scenarios: [], approvedServiceOrigins: [API], profileRevisions: { discoveryJob: 2, current: 2 },
};
const draftOf = (candidate: DiscoveryCandidate, api: Record<string, unknown> = {}, fieldNames = ['name', 'email', 'note']): Record<string, unknown> => ({
  profileId: PROFILE_ID,
  candidateIdentityDigest: candidate.identityDigest,
  transport: 'API',
  fieldNames,
  readChecks: [],
  sideEffectConfirmations: ALL_CONFIRMED,
  limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
  approvalTtlDays: 30,
  api: { shapeDigest: candidate.submissionProbe?.shapeDigest, pageKeys: ['tenant_id'], filterName: null, recordId: null, ledger: null, ...api },
});
const codesOf = (result: ScenarioDraftValidationResult): readonly string[] => (result.ok ? [] : result.errors.map(({ code }) => code));
const validate = (candidate: DiscoveryCandidate, api: Record<string, unknown> = {}): readonly string[] =>
  codesOf(validateScenarioDraft(draftOf(candidate, api), candidate, [], CONTEXT));

describe('T38R-fix C-1: the index and the draft follow the number of the requests of the probe', () => {
  const SHAPE = shapeOf();
  it('puts the shape digest of an API_CREATE or API_UPDATE probe only into the index (not of a probe of two requests)', () => {
    expect(discoveryIndexEntryOf(buttonOf(probeOf([SHAPE]))).shapeDigests).toEqual([apiShapeDigestOf(SHAPE)]);
    const twice = probeOf([SHAPE, shapeOf(BASE_BODY, `${API}/rest/v1/audit_log?select=*`)]);
    expect([twice.result, twice.reason]).toEqual(['NOT_EXECUTABLE', 'MULTIPLE_REQUESTS']);
    expect(twice.shapeDigest).not.toBeNull();
    expect(discoveryIndexEntryOf(buttonOf(twice)).shapeDigests).toEqual([]);
    expect(discoveryIndexEntryOf(buttonOf(twice)).keyFieldDigests).toEqual([]);
  });

  it('rejects a probe forged as API_CREATE whose requests were two, and a probe with an unrecorded shape', () => {
    expect(validate(buttonOf(forged(SHAPE, { nonReadRequestCount: 2 })))).toEqual(['SCENARIO_API_SHAPE_NOT_EXECUTABLE']);
    expect(validate(buttonOf(forged(SHAPE, { unrecordedShapeCount: 1 })))).toEqual(['SCENARIO_API_SHAPE_NOT_EXECUTABLE']);
    expect(validate(buttonOf(probeOf([SHAPE])))).toEqual([]);
  });
});

describe('T38R-fix M-2: the probe results of a write and the page header names in one place each', () => {
  it('maps API_CREATE to CREATE and POST, API_UPDATE to UPDATE and PATCH, and nothing else', () => {
    expect(SUBMISSION_PROBE_WRITE_RESULTS).toEqual({ API_CREATE: { kind: 'CREATE', method: 'POST' }, API_UPDATE: { kind: 'UPDATE', method: 'PATCH' } });
    expect(submissionProbeWriteOf('API_UPDATE')).toEqual({ kind: 'UPDATE', method: 'PATCH' });
    expect(submissionProbeWriteOf('NOT_EXECUTABLE')).toBeNull();
    expect(Object.isFrozen(SUBMISSION_PROBE_WRITE_RESULTS)).toBe(true);
  });

  it('normalizes the page header names (lower case, without the browser names, distinct, sorted)', () => {
    expect(pageHeaderNamesOf(['Prefer', 'content-type', 'Sec-Fetch-Mode', 'accept', 'X-Client', 'prefer'])).toEqual(['content-type', 'prefer', 'x-client']);
  });
});

describe('T38R-fix I-2: secret-like names of the page keys and the record id key, and scalar page keys', () => {
  /** レビューの 14 件と `access_token`（部分一致の fail-closed の方針で拒む）。 */
  const SECRET_LIKE = [
    'access_token', 'user_password', 'new_password', 'password_confirmation', 'apiToken', 'secret_key', 'private_key', 'bearer', 'bearer_token',
    'session_key', 'auth_header', 'x_api_token', 'client_token', 'otp_code', 'pin',
  ];
  const withPageKey = (key: string, value: unknown = 'v'): DiscoveryCandidate =>
    buttonOf(forged(shapeOf({ name: MARKERS[0], email: MARKERS[1], note: Number(MARKERS[2]), [key]: value })));

  it.each(SECRET_LIKE)('treats %s as secret-like, and rejects it as a page key and as the record id key', (key) => {
    expect(isApiWriteKeyNameSecretLike(key)).toBe(true);
    expect(validate(withPageKey(key), { pageKeys: [key] })).toEqual(['SCENARIO_API_PAGE_KEY_SECRET_LIKE']);
    expect(validate(buttonOf(probeOf([shapeOf()])), { recordId: { source: 'RESPONSE_BODY_KEY', key } })).toEqual(['SCENARIO_API_RECORD_ID_KEY_SECRET_LIKE']);
  });

  it.each(['tenant_id', 'org_id', 'shipping_address', 'mapping', 'zip_code', 'id', 'source'])('accepts the ordinary key %s', (key) => {
    expect(isApiWriteKeyNameSecretLike(key)).toBe(false);
  });

  it('rejects a page key of a JSON object or an array (only scalar page keys)', () => {
    expect(validate(withPageKey('meta', { note: 'x' }), { pageKeys: ['meta'] })).toEqual(['SCENARIO_API_PAGE_KEY_NOT_SCALAR']);
    expect(validate(withPageKey('items', [{ id: 1 }]), { pageKeys: ['items'] })).toEqual(['SCENARIO_API_PAGE_KEY_NOT_SCALAR']);
    expect(validate(withPageKey('source', 1), { pageKeys: ['source'] })).toEqual([]);
    // T40R-fix-B: 一覧の最後に、照合の READ の理由を足した（この 3 つの後ろ）。T40R2-fix: ID の型の理由は注意に下げて外した。T41a: その後ろに 2 つを
    // 足した（`scenario-api-update-contract.test.ts`）。
    expect(SCENARIO_DRAFT_REJECTION_REASONS.slice(-6, -2)).toEqual([
      'SCENARIO_API_DISCOVERY_PROFILE_STALE', 'SCENARIO_API_PAGE_KEY_NOT_SCALAR', 'SCENARIO_API_RECORD_ID_KEY_SECRET_LIKE',
      'SCENARIO_API_READ_VERIFICATION_NOT_BOUND',
    ]);
  });
});

describe('T38R2-fix R2-M-1: policy 6 folds NFKC, compares by the words of the name, and has the added words', () => {
  /**
   * 再レビュー（T38R2）の取りこぼしの名前: 語の後の数字、頭字語の境、足した語（`csrf`・`xsrf`・`passcode`・`passphrase`・`pincode`・`cvv`・`cvc`・
   * `signing_key`・`verification_code`）、NFKC で畳める全角・`ſ`・ケルビン記号・半角カナ、日本語の語（`パスワード`・`トークン`・`暗証番号`）。
   * 限界（当たらない。設計書に書く）: キリル文字などの形の似た文字（`tоken` の `о` は U+043E）と、数字で書き換えた語（`p4ssword`）。
   */
  const MISSED = [
    'pin1', 'pin2', 'pass1', 'pass_1', 'pwd2', 'sid1', 'mfa2fa', 'PINCode', 'PINNumber', 'SIDValue', 'MFAToken', 'PWDHash',
    'passcode', 'passphrase', 'pincode', 'csrf', 'x_csrf', 'xsrf_value', 'csrf_nonce', 'verification_code', 'signing_key', 'cvv', 'cvc',
    'ｔｏｋｅｎ', 'ＴＯＫＥＮ', 'ｐａｓｓｗｏｒｄ', 'ｐｉｎ', 'ſecret', 'apiKey', 'ﾊﾟｽﾜｰﾄﾞ', 'パスワード', 'トークン', '暗証番号', 'user_パスワード',
  ];

  it.each(MISSED)('treats %s as secret-like', (key) => {
    expect(isApiWriteKeyNameSecretLike(key)).toBe(true);
  });

  it.each(['tenant_id', 'org_id', 'name', 'email', 'shipping', 'inside', 'pinned', 'passenger', 'compass', 'spinner', 'codec', 'keyword', 'spin2', '会社名'])(
    'does not treat the ordinary key %s as secret-like',
    (key) => {
      expect(isApiWriteKeyNameSecretLike(key)).toBe(false);
    },
  );

  it('rejects the missed names as a page key', () => {
    const key = 'PINCode';
    const candidate = buttonOf(forged(shapeOf({ name: MARKERS[0], email: MARKERS[1], note: Number(MARKERS[2]), [key]: 'v' })));
    expect(validate(candidate, { pageKeys: [key] })).toEqual(['SCENARIO_API_PAGE_KEY_SECRET_LIKE']);
  });
});

describe('T38R-fix M-1: a page path template needs a fixed segment before {id}', () => {
  it.each(['/admin/members/{id}', '/a/{id}/b'])('accepts %s', (path) => {
    expect(isReadCheckPageTemplatePath(path)).toBe(true);
  });
  it.each(['/{id}', '/{id}/edit', '/admin/{id}/{id}'])('rejects %s', (path) => {
    expect(isReadCheckPageTemplatePath(path)).toBe(false);
  });
});

describe('T38R-fix C-2 and I-1: the approval validity of an API scenario', () => {
  const SHAPE = shapeOf();
  const approvedCandidate = buttonOf(probeOf([SHAPE]));
  const content = validateScenarioDraft(draftOf(approvedCandidate), approvedCandidate, [], CONTEXT);
  const scenario = (): ScenarioRevision => {
    if (!content.ok) throw new Error(codesOf(content).join(','));
    return { ...sampleScenario(), ...content.content, inputRuleReference: INPUT_RULES } as ScenarioRevision;
  };
  /**
   * 今の事実。最新の発見の候補（1 件か、同じ識別の数件）を、ジョブの管理と同じくまとめ（`mergeDiscoveryCandidates`）、索引と同じく同じ識別の行の
   * 型と鍵と欄の digest を合わせる（`recordDiscoveryCandidates` の `withJoinedShapes`）。
   */
  const factsOf = (latest: DiscoveryCandidate | readonly DiscoveryCandidate[], change: Partial<ApprovalCurrentFacts> = {}): ApprovalCurrentFacts => {
    const entries = mergeDiscoveryCandidates(Array.isArray(latest) ? latest : [latest]).map(discoveryIndexEntryOf);
    const [entry] = entries;
    if (entry === undefined) throw new Error('no index entry');
    const joined = (digests: readonly (readonly string[])[]): readonly string[] => [...new Set(digests.flat())].sort();
    return {
      profile: { profileId: PROFILE_ID, revision: 4, status: 'ACTIVE', mode: 'TEST_APPROVED_WRITE', approvedServiceOrigins: [API] },
      authSetupDigest: AUTH_SETUP_DIGEST,
      targetConfigDigest: TARGET_CONFIG_DIGEST,
      candidate: { identityDigest: entry.identityDigest, ruleDigest: entry.ruleDigest, classification: entry.classification, drift: 'UNCHANGED' },
      candidateShapeDigests: joined(entries.map(({ shapeDigests }) => shapeDigests)),
      candidateKeyFieldDigests: joined(entries.map(({ keyFieldDigests }) => keyFieldDigests)),
      apiShapeOriginIndex: 0,
      latestDiscoveryProfileRevision: 4,
      templatedCandidates: null,
      inputRuleReference: INPUT_RULES,
      readChecks: READ_CHECK_FACTS,
      ...change,
    };
  };
  const reasonsWith = (latest: DiscoveryCandidate | readonly DiscoveryCandidate[], change: Partial<ApprovalCurrentFacts> = {}): readonly string[] => {
    const current = scenario();
    const facts = factsOf(latest, change);
    const digest = computeApprovalDigest(current, { profileRevision: 4, authSetupDigest: AUTH_SETUP_DIGEST, targetConfigDigest: TARGET_CONFIG_DIGEST });
    const validity = evaluateApprovalValidity({
      scenario: current,
      facts,
      lastApproval: sampleApproval(digest, {
        bound: { ...sampleApproval('x').bound, candidateIdentityDigest: current.candidate.identityDigest, candidateRuleDigest: current.candidate.ruleDigest },
      }),
      lastRevocation: null,
      now: new Date(Date.parse('2026-10-13T02:00:00Z')),
    });
    return validity.approved ? [] : validity.reasons;
  };

  it('has the three reasons after the reasons of the shapes in the closed list', () => {
    const index = APPROVAL_INVALIDITY_REASONS.indexOf('CANDIDATE_SHAPES_UNAVAILABLE');
    expect(APPROVAL_INVALIDITY_REASONS.slice(index + 1, index + 4)).toEqual(['CANDIDATE_FIELDS_CHANGED', 'API_ORIGIN_NOT_APPROVED', 'API_DISCOVERY_PROFILE_STALE']);
  });

  it('is approved on the same probe (the key fields digest is the one of the scenario)', () => {
    expect(discoveryIndexEntryOf(approvedCandidate).keyFieldDigests).toEqual([apiKeyFieldsDigestOf(apiShapeDigestOf(SHAPE), scenario().api?.keyFields ?? [])]);
    expect(reasonsWith(approvedCandidate)).toEqual([]);
  });

  it('needs a new approval when the field behind a key changed (I-1)', () => {
    const renamed: SubmissionProbeInputField[] = [
      { name: 'title', selector: '#title', type: 'text', marker: 0 },
      { name: 'contact', selector: '#contact', type: 'email', marker: 1 },
      { name: null, selector: '#memo', type: 'number', marker: 2 },
    ];
    const latest = buttonOf(probeOf([SHAPE], 1, renamed));
    expect(latest.submissionProbe?.shapeDigest).toBe(approvedCandidate.submissionProbe?.shapeDigest);
    expect(reasonsWith(latest)).toEqual(['CANDIDATE_FIELDS_CHANGED']);
    expect(reasonsWith(approvedCandidate, { candidateKeyFieldDigests: null })).toEqual(['CANDIDATE_SHAPES_UNAVAILABLE']);
  });

  it('needs a new approval when the probe became two requests (C-1)', () => {
    expect(reasonsWith(buttonOf(probeOf([SHAPE, shapeOf(BASE_BODY, `${API}/rest/v1/audit_log?select=*`)])))).toEqual(['CANDIDATE_SHAPE_CHANGED']);
  });

  it('needs a new approval when the origin is no longer at the number of the shape in the approved service origins (C-2)', () => {
    const profile = factsOf(approvedCandidate).profile;
    expect(reasonsWith(approvedCandidate, { profile: { ...profile, approvedServiceOrigins: [OTHER_API] } })).toEqual(['API_ORIGIN_NOT_APPROVED']);
    expect(reasonsWith(approvedCandidate, { profile: { ...profile, approvedServiceOrigins: [OTHER_API, API] } })).toEqual(['API_ORIGIN_NOT_APPROVED']);
    expect(reasonsWith(approvedCandidate, { apiShapeOriginIndex: null })).toEqual(['API_ORIGIN_NOT_APPROVED']);
  });

  it('needs a new discovery when the latest discovery job ran with another revision of the profile (C-2)', () => {
    expect(reasonsWith(approvedCandidate, { latestDiscoveryProfileRevision: 3 })).toEqual(['API_DISCOVERY_PROFILE_STALE']);
    expect(reasonsWith(approvedCandidate, { latestDiscoveryProfileRevision: null })).toEqual(['API_DISCOVERY_PROFILE_STALE']);
  });

  /** 発見の成果物の文書（候補を 1 画面に並べた形。型で引く口に渡す）。 */
  const documentOf = (candidates: readonly DiscoveryCandidate[]): Pick<DiscoveryDocument, 'pages'> => ({
    pages: [{ url: `${SAMPLE_ORIGIN}${NEW_PATH}`, state: 'READ', record: { location: approvedCandidate.page, incompleteReasons: [], candidates }, blockedRequests: 0 }],
  });
  /** 同じ識別のボタンの、2 つの要求を送った probe（最初の型はシナリオの型と同じ。`MULTIPLE_REQUESTS`）。 */
  const twice = buttonOf(probeOf([SHAPE, shapeOf(BASE_BODY, `${API}/rest/v1/audit_log?select=*`)]));

  it.each([
    ['API_CREATE first', [approvedCandidate, twice]],
    ['MULTIPLE_REQUESTS first', [twice, approvedCandidate]],
  ] as const)('T38R2-fix R2-I-1: does not use a shape that a non-write probe of the same identity also had (%s)', (_label, latest) => {
    expect(twice.identityDigest).toBe(approvedCandidate.identityDigest);
    expect([twice.submissionProbe?.reason, twice.submissionProbe?.shapeDigest]).toEqual(['MULTIPLE_REQUESTS', apiShapeDigestOf(SHAPE)]);
    // まとめた後の行は、書き込みでない probe の行（型の鍵ごとに 1 行。並びの順に依らない）。
    expect(mergeDiscoveryCandidates(latest).map((row) => row.submissionProbe?.result)).toEqual(['NOT_EXECUTABLE']);
    // 索引に型も鍵と欄の digest も入らず、承認は再承認（`CANDIDATE_SHAPE_CHANGED`）。
    expect(factsOf(latest).candidateShapeDigests).toEqual([]);
    expect(factsOf(latest).candidateKeyFieldDigests).toEqual([]);
    expect(reasonsWith(latest)).toEqual(['CANDIDATE_SHAPE_CHANGED']);
    // 型で引く口は書き込みでない行を返し、下書きはその行を拒む（API の書き込みの候補でない）。
    const row = candidateOfDiscoveryDocumentByShape(documentOf(latest), approvedCandidate.identityDigest, apiShapeDigestOf(SHAPE));
    expect(row?.submissionProbe?.result).toBe('NOT_EXECUTABLE');
    expect(row === null ? [] : validate(row)).toEqual(['SCENARIO_API_CANDIDATE_NOT_API']);
  });

  it('T38R2-fix R2-I-1: keeps the write row of another shape of the same identity', () => {
    const otherFirst = buttonOf(probeOf([shapeOf(BASE_BODY, `${API}/rest/v1/audit_log?select=*`), SHAPE]));
    expect(otherFirst.submissionProbe?.shapeDigest).not.toBe(apiShapeDigestOf(SHAPE));
    for (const latest of [[approvedCandidate, otherFirst], [otherFirst, approvedCandidate]]) {
      expect(mergeDiscoveryCandidates(latest)).toHaveLength(2);
      expect(reasonsWith(latest)).toEqual([]);
    }
    // 同じ型の書き込みの probe が 2 つなら、最初の行（今の形）。
    const again = buttonOf(probeOf([SHAPE]));
    expect(mergeDiscoveryCandidates([approvedCandidate, again])).toEqual([approvedCandidate]);
  });

  it('T38R2-fix R2-M-2: puts the input types of the fields into the key field digest (text and number swapped)', () => {
    expect(scenario().api?.keyFields.map(({ key, fieldType }) => [key, fieldType])).toEqual([['email', 'email'], ['name', 'text'], ['note', 'number']]);
    const swapped: SubmissionProbeInputField[] = [
      { ...INPUT_FIELDS[0] as SubmissionProbeInputField, type: 'number' },
      INPUT_FIELDS[1] as SubmissionProbeInputField,
      { ...INPUT_FIELDS[2] as SubmissionProbeInputField, type: 'text' },
    ];
    const latest = buttonOf(probeOf([SHAPE], 1, swapped));
    expect(latest.submissionProbe?.shapeDigest).toBe(approvedCandidate.submissionProbe?.shapeDigest);
    expect(reasonsWith(latest)).toEqual(['CANDIDATE_FIELDS_CHANGED']);
    // 承認の digest も欄の型で変わる。
    const current = scenario();
    const api = current.api;
    if (api === undefined) throw new Error('no api');
    const external = { profileRevision: 4, authSetupDigest: AUTH_SETUP_DIGEST, targetConfigDigest: TARGET_CONFIG_DIGEST };
    const retyped: ScenarioRevision = { ...current, api: { ...api, keyFields: api.keyFields.map((item) => (item.key === 'name' ? { ...item, fieldType: 'search' } : item)) } };
    expect(computeApprovalDigest(retyped, external)).not.toBe(computeApprovalDigest(current, external));
  });
});

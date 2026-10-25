// T22a（Task 22 の設計書 4.1、4.4、6、7）: 監査プロファイルの契約（`src/control/contracts.ts`）と、その JSON Schema
// （`schemas/control/profile.schema.json`）と、Control のスキーマの検証の部品（`src/control/control-schema-validator.ts`）の検査。
// 組み合わせの規則（設計書 4.3 の表）はスキーマに入れない（判定は T22b の `profile-policy.ts` の 1 か所）ので、ここではスキーマが
// 形だけを判定することを確かめる。例の値は、匿名の値（`example.com`、`example.invalid`、`127.0.0.1`）だけを使う。
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_MODES,
  AUTH_STRATEGIES,
  ENVIRONMENT_KINDS,
  MAX_APPROVED_SERVICE_ORIGINS,
  MAX_ENVIRONMENT_EVIDENCE_REF_LENGTH,
  MIN_PROFILE_REVISION,
  PROFILE_ID_PATTERN,
  PROFILE_VALIDATION_ERROR_CODES,
  SITE_PROFILE_SCHEMA_VERSION,
  WRITE_AUDIT_MODE,
  type SiteProfile,
} from '../../src/control/contracts.js';
import { WRITE_AUDIT_MODE as SCENARIO_CONTRACTS_WRITE_AUDIT_MODE } from '../../src/control/approval/scenario-contracts.js';
import { CONTROL_SCHEMA_NAMES, validateControlDocument } from '../../src/control/control-schema-validator.js';
import { buildIntoTemporaryDirectory, snapshotDirectory } from '../helpers/temporary-build.js';

const PROFILE_SCHEMA_PATH = resolve(process.cwd(), 'schemas', 'control', 'profile.schema.json');
const PROFILE_SCHEMA_ID = 'urn:beaksight:schema:control:profile:1';

const readProfileSchema = (): Record<string, unknown> =>
  JSON.parse(readFileSync(PROFILE_SCHEMA_PATH, 'utf8')) as Record<string, unknown>;

const propertyOf = (schema: Record<string, unknown>, key: string): Record<string, unknown> =>
  (schema.properties as Record<string, Record<string, unknown>>)[key] ?? {};

/** 公開サイトの例（旧ターゲット JSON と同じ権限）。 */
const publicProfile = {
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId: 'example-public',
  revision: 1,
  targetConfigPath: 'config/targets/example.json',
  environment: 'PUBLIC',
  mode: 'PUBLIC_PASSIVE',
  auth: 'NONE',
  approvedTestOrigins: [],
  environmentEvidenceRef: null,
} satisfies SiteProfile;

/** テスト環境の例（認証つきの読み取りの監査）。 */
const testProfile = {
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId: 'example-test-env',
  revision: 3,
  targetConfigPath: 'local/targets/example-test.json',
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: ['https://app.example.invalid', 'http://127.0.0.1:4173'],
  environmentEvidenceRef: 'evidence/example-test-env/isolation-check-1',
} satisfies SiteProfile;

const PROFILE_KEYS = Object.freeze(Object.keys(publicProfile));

const expectRejected = (value: unknown): void => {
  const result = validateControlDocument('profile', value);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors.length).toBeGreaterThan(0);
    for (const error of result.errors) {
      expect(typeof error).toBe('string');
    }
  }
};

describe('T22a: the closed lists of src/control/contracts.ts', () => {
  it.each([
    ['AUDIT_MODES', AUDIT_MODES, ['PUBLIC_PASSIVE', 'TEST_AUTH_PASSIVE', 'TEST_APPROVED_WRITE']],
    ['ENVIRONMENT_KINDS', ENVIRONMENT_KINDS, ['PUBLIC', 'TEST']],
    ['AUTH_STRATEGIES', AUTH_STRATEGIES, ['NONE', 'MANUAL_SESSION', 'AUTOMATED_LOGIN']],
    [
      'PROFILE_VALIDATION_ERROR_CODES',
      PROFILE_VALIDATION_ERROR_CODES,
      [
        'PROFILE_SCHEMA_INVALID',
        'PROFILE_ID_INVALID',
        'PROFILE_TARGET_PATH_INVALID',
        'PROFILE_MODE_ENVIRONMENT_MISMATCH',
        'PROFILE_AUTH_MISMATCH',
        'PROFILE_TEST_ORIGINS_REQUIRED',
        'PROFILE_TEST_ORIGIN_INVALID',
        'PROFILE_TEST_ORIGIN_OUTSIDE_TARGET',
        'PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED',
        'PROFILE_REVISION_NOT_ADVANCED',
        // T34a（Task 34 の設計書 3.1）: 承認したサービスの Origin の形とモード、設定の許可 Origin との重なり。
        'PROFILE_SERVICE_ORIGIN_INVALID',
        'PROFILE_SERVICE_ORIGIN_INSIDE_TARGET',
      ],
    ],
  ] as const)('defines %s as a frozen list of the designed values without duplicates', (_name, values, expected) => {
    expect(values).toEqual(expected);
    expect(Object.isFrozen(values)).toBe(true);
    expect(new Set(values).size).toBe(values.length);
  });

  // CCX-29（CC-080 の (c)）: 書き込みを許すモードは、import を持たない契約のファイルに置き、承認の契約は同じ値を公開し直す（2 つ目の定義を作らない）。
  it('defines the write audit mode as a member of AUDIT_MODES, and the scenario contracts re-export the same value', () => {
    expect(WRITE_AUDIT_MODE).toBe('TEST_APPROVED_WRITE');
    expect(AUDIT_MODES).toContain(WRITE_AUDIT_MODE);
    expect(SCENARIO_CONTRACTS_WRITE_AUDIT_MODE).toBe(WRITE_AUDIT_MODE);
  });

  it('fixes the profile schema version and the named limits', () => {
    expect(SITE_PROFILE_SCHEMA_VERSION).toBe('beaksight-profile/1');
    expect(MIN_PROFILE_REVISION).toBe(1);
    expect(MAX_ENVIRONMENT_EVIDENCE_REF_LENGTH).toBe(200);
    expect(PROFILE_ID_PATTERN.source).toBe('^[a-z0-9][a-z0-9-]{0,62}$');
  });

  it('keeps the SiteProfile shape of the roadmap (no added or renamed field)', () => {
    expect(PROFILE_KEYS).toEqual([
      'schemaVersion',
      'profileId',
      'revision',
      'targetConfigPath',
      'environment',
      'mode',
      'auth',
      'approvedTestOrigins',
      'environmentEvidenceRef',
    ]);
  });
});

describe('T22a: schemas/control/profile.schema.json and the contracts', () => {
  const schema = readProfileSchema();

  it('has the control profile $id, closes the object, and requires every SiteProfile field', () => {
    expect(schema.$id).toBe(PROFILE_SCHEMA_ID);
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(PROFILE_KEYS);
    // T34a（Task 34 の設計書 3.1）: 任意の項目 `approvedServiceOrigins` を、版を上げずに足した（必須の項目は変えない）。
    expect(Object.keys(schema.properties as object)).toEqual([...PROFILE_KEYS, 'approvedServiceOrigins']);
    expect(propertyOf(schema, 'approvedServiceOrigins').maxItems).toBe(MAX_APPROVED_SERVICE_ORIGINS);
    expect(propertyOf(schema, 'approvedServiceOrigins').uniqueItems).toBe(true);
  });

  it('matches the enums and the constants of src/control/contracts.ts', () => {
    expect(propertyOf(schema, 'schemaVersion').const).toBe(SITE_PROFILE_SCHEMA_VERSION);
    expect(propertyOf(schema, 'environment').enum).toEqual([...ENVIRONMENT_KINDS]);
    expect(propertyOf(schema, 'mode').enum).toEqual([...AUDIT_MODES]);
    expect(propertyOf(schema, 'auth').enum).toEqual([...AUTH_STRATEGIES]);
    expect(propertyOf(schema, 'profileId').pattern).toBe(PROFILE_ID_PATTERN.source);
    expect(propertyOf(schema, 'revision').minimum).toBe(MIN_PROFILE_REVISION);
    expect(propertyOf(schema, 'environmentEvidenceRef').maxLength).toBe(MAX_ENVIRONMENT_EVIDENCE_REF_LENGTH);
  });

  it('does not put the combination rules of the design 4.3 into the schema (only the shape)', () => {
    expect(Object.keys(schema).sort()).toEqual(['$id', 'additionalProperties', 'properties', 'required', 'type']);
    const serialized = JSON.stringify(schema);
    for (const keyword of ['"allOf"', '"anyOf"', '"oneOf"', '"if"', '"then"', '"dependentRequired"', '"dependentSchemas"']) {
      expect(serialized).not.toContain(keyword);
    }
  });
});

describe('T22a: validateControlDocument with the profile schema', () => {
  // T23f: ローカルの管理画面の Server Function の入力のスキーマを足した（`ui-` の名前。プロファイルの文書のスキーマは `profile` だけ）。
  it('lists the profile schema and the local UI request schemas as the control schema names', () => {
    expect(CONTROL_SCHEMA_NAMES).toEqual([
      'profile',
      'ui-profile-key',
      'ui-profile-create',
      'ui-profile-update',
      'ui-profile-retire',
      'ui-target-config',
      // T24d: 画面のサーバと監査のワーカーの IPC のメッセージ（Task 24 の設計書 4.3）。
      'worker-message',
      // T24f: 画面の監査のジョブの Server Function の入力（Task 24 の設計書 4.8）。
      'ui-audit-job-start',
      'ui-audit-job-stop',
      'ui-audit-job-key',
      // T34a: 認証の設定の版 3（Task 34 の設計書 3.2。LG-3b: 版 1 の `auth-setup` と版 2 の `auth-setup-v2` は捨てた）。
      'auth-setup-v3',
      // T25e: 画面の認証の設定の保存の Server Function の入力（Task 25 の設計書 4.5）。
      'ui-auth-setup-save',
      // T43d: 画面の認証の設定とプロファイルのまとめて保存の Server Function の入力（Task 43 の設計書 4.4）。
      'ui-auth-setup-profile-save',
      // T26a: 資格情報のファイル（Task 26 の設計書 4.1）。
      'credential-file',
      // T26e: 画面の資格情報の登録・変更・入れ直しと、ログインの検証の開始の Server Function の入力（Task 26 の設計書 4.2、4.6）。
      'ui-credential-register',
      'ui-credential-change',
      'ui-credential-replace',
      'ui-login-check-start',
      // T27a: 発見の候補（成果物 `discovery.json` の候補の形。Task 27 の設計書 4.1）。
      'candidate',
      // T27c: READ の確かめの定義の中身（Task 27 の設計書 4.5）。
      'read-check-definition',
      // T27f: 画面の操作の候補の発見と READ の確かめの Server Function の入力（Task 27 の設計書 4.7）。
      'ui-discovery-start',
      'ui-read-check-start',
      'ui-read-check-create',
      'ui-read-check-update',
      'ui-read-check-cancel',
      // T28a: シナリオの版と、承認・撤回の記録（Task 28 の設計書 4.1）。
      'scenario',
      'approval-receipt',
      // T28e: 画面のシナリオの Server Function の入力（Task 28 の設計書 4.6）。
      'ui-scenario-key',
      'ui-scenario-form',
      'ui-scenario-create',
      'ui-scenario-update',
      'ui-scenario-approve',
      'ui-scenario-revoke',
      // FM2b: 画面のシナリオの下書きをボタン 1 回で作る Server Function の入力（手を減らす段 2 の設計書 3A.2）。
      'ui-scenario-auto-draft',
      'ui-scenario-auto-rules',
      // T29a・FM2c: 入力の規則の集まりの版 2（手動の操作を減らす設計書 3A.3。LG-3: 版 1 の `data-rule` は捨てた）。
      'data-rule-v2',
      // T29e: 画面の入力の規則の保存の Server Function の入力（Task 29 の設計書 4.4）。
      'ui-data-rule-save',
      // T30g fix round 1: 画面の書き込みの開始の Server Function の入力（Task 30 の設計書 3 章、10 章）。
      'ui-write-start',
      // T31h-2: 画面の更新の書き込みの開始の Server Function の入力（Task 31 の設計書 3 章、10 章）。
      'ui-write-update-start',
      // T41g-3: 画面の「登録してから更新する」の Server Function の入力（Task 41 の設計書 3.5.1）。
      'ui-write-chain-start',
      // T43c: 画面の入口の確かめの開始の Server Function の入力（Task 43 の設計書 4.3）。
      'ui-entry-check-start',
      // FM-1: 画面のログインの段の表の 1 行の「登録する」の Server Function の入力（手動の操作を減らす設計書 2.1）。
      'ui-login-stage-row-key',
      'ui-login-stage-row-register',
      // FM-1: 画面のプロファイルの表示の設定の保存の Server Function の入力（手動の操作を減らす設計書 2.2）。
      'ui-profile-display-settings',
      // T44d: 画面のプロファイルの負荷の値の確かめと保存の Server Function の入力（Task 44 の設計書 P2-1）。
      'ui-target-crawl-limits',
      // FM2e: 画面の 1 回の操作で自動ログインの設定を終える Server Function の入力（手を減らす段 2 の設計書 3A.4）。
      'ui-automated-login-setup',
    ]);
    expect(Object.isFrozen(CONTROL_SCHEMA_NAMES)).toBe(true);
  });

  it.each([
    ['a PUBLIC profile', publicProfile],
    ['a TEST profile', testProfile],
    ['a TEST approved-write profile', { ...testProfile, mode: 'TEST_APPROVED_WRITE', auth: 'AUTOMATED_LOGIN' }],
    ['a TEST public-passive profile with an evidence reference', { ...testProfile, mode: 'PUBLIC_PASSIVE', auth: 'NONE', approvedTestOrigins: [] }],
    ['the longest profile id', { ...publicProfile, profileId: `a${'-'.repeat(62)}` }],
    ['the longest evidence reference', { ...testProfile, environmentEvidenceRef: 'e'.repeat(MAX_ENVIRONMENT_EVIDENCE_REF_LENGTH) }],
    ['a large revision', { ...publicProfile, revision: 1_000_000 }],
  ] as const)('accepts %s', (_name, profile) => {
    expect(validateControlDocument('profile', profile)).toEqual({ ok: true });
  });

  // 組み合わせの規則はスキーマにない。表にない組み合わせ（RF1 の PUBLIC と書き込み）も、形が正しければスキーマは受ける。
  // 拒否は T22b の `profile-policy.ts` が行う。
  it('accepts a combination outside the design table, because the combination rules are not in the schema', () => {
    expect(validateControlDocument('profile', { ...publicProfile, mode: 'TEST_APPROVED_WRITE', auth: 'AUTOMATED_LOGIN' }))
      .toEqual({ ok: true });
  });

  it('rejects an unknown key with the additional-properties error', () => {
    const result = validateControlDocument('profile', { ...publicProfile, extra: true });
    expect(result).toEqual({
      ok: false,
      errors: ['/ must NOT have additional properties'],
      // CCX-24（CC-086）: 誤りの位置も構造で返す（文は変えない）。
      issues: [{ message: '/ must NOT have additional properties', instancePath: '', missingProperty: null }],
    });
  });

  it.each(PROFILE_KEYS)('rejects a profile without %s', (key) => {
    const copy: Record<string, unknown> = { ...publicProfile };
    delete copy[key];
    expect(validateControlDocument('profile', copy)).toEqual({
      ok: false,
      errors: [`/ must include ${key}`],
      issues: [{ message: `/ must include ${key}`, instancePath: '', missingProperty: key }],
    });
  });

  it.each([
    ['an unknown mode', { mode: 'TEST_WRITE' }],
    ['a lowercase mode', { mode: 'public_passive' }],
    ['an unknown environment', { environment: 'STAGING' }],
    ['an unknown auth strategy', { auth: 'PASSWORD' }],
    ['another schemaVersion', { schemaVersion: 'beaksight-profile/2' }],
    ['revision 0', { revision: 0 }],
    ['a negative revision', { revision: -1 }],
    ['a fractional revision', { revision: 1.5 }],
    ['a string revision', { revision: '1' }],
    ['an empty profile id', { profileId: '' }],
    ['an uppercase profile id', { profileId: 'Example' }],
    ['a profile id starting with a hyphen', { profileId: '-example' }],
    ['a profile id with an underscore', { profileId: 'example_public' }],
    ['a profile id of 64 characters', { profileId: `a${'-'.repeat(63)}` }],
    ['a non-string target config path', { targetConfigPath: 1 }],
    ['an empty evidence reference', { environmentEvidenceRef: '' }],
    ['a too long evidence reference', { environmentEvidenceRef: 'e'.repeat(MAX_ENVIRONMENT_EVIDENCE_REF_LENGTH + 1) }],
    ['duplicate test origins', { approvedTestOrigins: ['https://app.example.invalid', 'https://app.example.invalid'] }],
    ['a non-string test origin', { approvedTestOrigins: [1] }],
    ['test origins that are not an array', { approvedTestOrigins: 'https://app.example.invalid' }],
  ] as const)('rejects %s', (_name, override) => {
    expectRejected({ ...testProfile, ...override });
  });

  it.each([
    ['null', null],
    ['an array', [publicProfile]],
    ['a string', 'profile'],
  ] as const)('rejects %s instead of a profile object', (_name, value) => {
    expectRejected(value);
  });

  // DEF-002 と同じ扱い: 検証関数の表で継承したプロパティ名や、成果物のスキーマの名前を引くと、無関係な関数で検証を素通りする。
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'run', 'audit', 'approval'])(
    'rejects %s as a control schema name with a RangeError',
    (schemaName) => {
      expect(() => validateControlDocument(schemaName as never, publicProfile)).toThrow(RangeError);
      expect(() => validateControlDocument(schemaName as never, publicProfile)).toThrow('unsupported control schema name');
    },
  );

  it('validates through the distribution module after the schemas are copied, without touching dist/', async () => {
    const repositoryDistDirectory = resolve(process.cwd(), 'dist');
    const distBefore = await snapshotDirectory(repositoryDistDirectory);
    const build = await buildIntoTemporaryDirectory();
    try {
      expect(build.distDirectory.startsWith(repositoryDistDirectory)).toBe(false);
      expect(existsSync(join(build.distDirectory, 'schemas', 'control', 'profile.schema.json'))).toBe(true);
      const moduleUrl = pathToFileURL(join(build.distDirectory, 'control', 'control-schema-validator.js')).href;
      const compiled = await import(moduleUrl) as typeof import('../../src/control/control-schema-validator.js');
      expect(compiled.validateControlDocument('profile', testProfile)).toEqual({ ok: true });
      expect(compiled.validateControlDocument('profile', { ...testProfile, revision: 0 })).toMatchObject({ ok: false });
    } finally {
      await build.remove();
    }

    expect(existsSync(build.rootDirectory)).toBe(false);
    expect(await snapshotDirectory(repositoryDistDirectory)).toEqual(distBefore);
  });
});

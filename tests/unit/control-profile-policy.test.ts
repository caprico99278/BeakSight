// T22b（Task 22 の設計書 4.2、4.3、4.4、7）: 監査プロファイルの判定の唯一の owner（`src/control/profile-policy.ts`）の検査。
// - 組み合わせの表（環境 × モード × 認証の 18 通り）: 受ける 4 行（6 通り）は受け、表にない 12 通りはすべて拒否する（fail-closed）。
// - 境界の値: `targetConfigPath` の各違反、テスト環境の Origin の各違反、`revision` の安全な整数の境界、`environmentEvidenceRef` の空・長さ・制御文字。
// - 改訂の単調増加（`assertProfileRevisionAdvance`）。T22d（T22R の I1）: 改訂の番号は安全な整数どうしだけを比べ、`next` は
//   `validateSiteProfile` が受けた値（実行時の印）だけを受け、`previous` は形を確かめる。Proxy・写せない値で例外を投げない。
// - T22d（T22R の M1、M4）: `environmentEvidenceRef` の UTF-16 の長さ・見えない文字・向きを変える文字・対になっていないサロゲート、
//   `targetConfigPath` の ASCII の文字の一覧。
// 例の値は、匿名の値（`example.com`、`example.invalid`、`127.0.0.1`）だけを使う。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import {
  AUDIT_MODES,
  AUTH_STRATEGIES,
  ENVIRONMENT_KINDS,
  MAX_ENVIRONMENT_EVIDENCE_REF_LENGTH,
  MIN_PROFILE_REVISION,
  PROFILE_VALIDATION_ERROR_CODES,
  SITE_PROFILE_SCHEMA_VERSION,
  type AuditMode,
  type AuthStrategy,
  type EnvironmentKind,
  type ProfileValidationErrorCode,
  type ProfileValidationResult,
  type SiteProfile,
  type ValidatedSiteProfile,
} from '../../src/control/contracts.js';
import {
  assertProfileRevisionAdvance,
  isAcceptedTargetConfigPath,
  retiredRevisionOf,
  validateSiteProfile,
  type ProfileValidationContext,
} from '../../src/control/profile-policy.js';
import { createTestConfig } from '../helpers/test-config.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const LOOPBACK_TEST_ORIGIN = 'http://127.0.0.1:4173';
/** 基本多言語面の外の文字（UTF-16 では 2 つのコード単位。サロゲートの対）。 */
const ASTRAL_CHARACTER = '\u{1f600}';

/** 参照するターゲット JSON を読み込んだ結果（呼び出し側が渡す `AuditConfig`）。HTTP の非 loopback の Origin も、範囲の中に置く。 */
const targetConfig: AuditConfig = {
  ...createTestConfig(TEST_ORIGIN),
  site: {
    startUrl: `${TEST_ORIGIN}/`,
    allowedOrigins: [
      TEST_ORIGIN,
      LOOPBACK_TEST_ORIGIN,
      'http://localhost:4173',
      'http://[::1]:4173',
      'http://example.invalid',
      'http://127.0.0.2:4173',
    ],
  },
};
const context: ProfileValidationContext = { targetConfig };

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

const testAuthProfile = {
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId: 'example-test-env',
  revision: 3,
  targetConfigPath: 'local/targets/example-test.json',
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [TEST_ORIGIN],
  environmentEvidenceRef: 'evidence/example-test-env/isolation-check-1',
} satisfies SiteProfile;

/** 拒否のコード（重複を除き、並べた値）。 */
const codesOf = (result: ProfileValidationResult): readonly ProfileValidationErrorCode[] =>
  result.ok ? [] : [...new Set(result.errors.map((error) => error.code))].sort();

const expectAccepted = (input: unknown): SiteProfile => {
  const result = validateSiteProfile(input, context);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  if (!result.ok) {
    throw new Error('unreachable');
  }
  return result.profile;
};

const expectRejectedWith = (input: unknown, expected: readonly ProfileValidationErrorCode[]): void => {
  const result = validateSiteProfile(input, context);
  expect(result.ok).toBe(false);
  expect(codesOf(result)).toEqual([...expected].sort());
  if (!result.ok) {
    expect(result.errors.length).toBeGreaterThan(0);
    expect(Object.isFrozen(result.errors)).toBe(true);
    for (const error of result.errors) {
      expect(PROFILE_VALIDATION_ERROR_CODES).toContain(error.code);
      expect(typeof error.detail).toBe('string');
      expect(error.detail.length).toBeGreaterThan(0);
    }
  }
};

/** 組み合わせの検査で、モードごとに、組み合わせ以外の値を正しくした例。 */
const profileFor = (environment: EnvironmentKind, mode: AuditMode, auth: AuthStrategy): SiteProfile => {
  const isTestMode = mode !== 'PUBLIC_PASSIVE';
  return {
    ...publicProfile,
    environment,
    mode,
    auth,
    approvedTestOrigins: isTestMode ? [TEST_ORIGIN] : [],
    environmentEvidenceRef: isTestMode ? testAuthProfile.environmentEvidenceRef : null,
  };
};

/**
 * 設計書 4.3 の組み合わせの表（環境 × モード × 認証の 18 通り）と、拒否のコードの対応。空の一覧は「受ける」。
 * - 環境とモードの誤り（RF1: `PUBLIC` と認証・書き込みのモード）は `PROFILE_MODE_ENVIRONMENT_MISMATCH`。
 * - モードと認証の誤り（`PUBLIC_PASSIVE` に認証、認証・書き込みのモードに `NONE`）は `PROFILE_AUTH_MISMATCH`。
 * - 両方に当たるものは、両方のコード。
 */
const COMBINATION_TABLE: readonly (readonly [EnvironmentKind, AuditMode, AuthStrategy, readonly ProfileValidationErrorCode[]])[] = [
  ['PUBLIC', 'PUBLIC_PASSIVE', 'NONE', []],
  ['PUBLIC', 'PUBLIC_PASSIVE', 'MANUAL_SESSION', ['PROFILE_AUTH_MISMATCH']],
  ['PUBLIC', 'PUBLIC_PASSIVE', 'AUTOMATED_LOGIN', ['PROFILE_AUTH_MISMATCH']],
  ['PUBLIC', 'TEST_AUTH_PASSIVE', 'NONE', ['PROFILE_AUTH_MISMATCH', 'PROFILE_MODE_ENVIRONMENT_MISMATCH']],
  ['PUBLIC', 'TEST_AUTH_PASSIVE', 'MANUAL_SESSION', ['PROFILE_MODE_ENVIRONMENT_MISMATCH']],
  ['PUBLIC', 'TEST_AUTH_PASSIVE', 'AUTOMATED_LOGIN', ['PROFILE_MODE_ENVIRONMENT_MISMATCH']],
  ['PUBLIC', 'TEST_APPROVED_WRITE', 'NONE', ['PROFILE_AUTH_MISMATCH', 'PROFILE_MODE_ENVIRONMENT_MISMATCH']],
  ['PUBLIC', 'TEST_APPROVED_WRITE', 'MANUAL_SESSION', ['PROFILE_MODE_ENVIRONMENT_MISMATCH']],
  ['PUBLIC', 'TEST_APPROVED_WRITE', 'AUTOMATED_LOGIN', ['PROFILE_MODE_ENVIRONMENT_MISMATCH']],
  ['TEST', 'PUBLIC_PASSIVE', 'NONE', []],
  ['TEST', 'PUBLIC_PASSIVE', 'MANUAL_SESSION', ['PROFILE_AUTH_MISMATCH']],
  ['TEST', 'PUBLIC_PASSIVE', 'AUTOMATED_LOGIN', ['PROFILE_AUTH_MISMATCH']],
  ['TEST', 'TEST_AUTH_PASSIVE', 'NONE', ['PROFILE_AUTH_MISMATCH']],
  ['TEST', 'TEST_AUTH_PASSIVE', 'MANUAL_SESSION', []],
  ['TEST', 'TEST_AUTH_PASSIVE', 'AUTOMATED_LOGIN', []],
  ['TEST', 'TEST_APPROVED_WRITE', 'NONE', ['PROFILE_AUTH_MISMATCH']],
  ['TEST', 'TEST_APPROVED_WRITE', 'MANUAL_SESSION', []],
  ['TEST', 'TEST_APPROVED_WRITE', 'AUTOMATED_LOGIN', []],
];

describe('T22b: validateSiteProfile and the combination table of the design 4.3', () => {
  it('covers every environment × mode × auth combination exactly once', () => {
    const keys = COMBINATION_TABLE.map(([environment, mode, auth]) => `${environment}/${mode}/${auth}`);
    const product = ENVIRONMENT_KINDS.flatMap((environment) =>
      AUDIT_MODES.flatMap((mode) => AUTH_STRATEGIES.map((auth) => `${environment}/${mode}/${auth}`)));
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...product].sort());
    expect(COMBINATION_TABLE.filter(([, , , codes]) => codes.length === 0)).toHaveLength(6);
  });

  it.each(COMBINATION_TABLE.filter(([, , , codes]) => codes.length === 0).map(([environment, mode, auth]) => [environment, mode, auth] as const))(
    'accepts %s + %s + %s',
    (environment, mode, auth) => {
      expectAccepted(profileFor(environment, mode, auth));
    },
  );

  it.each(COMBINATION_TABLE.filter(([, , , codes]) => codes.length > 0))(
    'rejects %s + %s + %s with %j',
    (environment, mode, auth, codes) => {
      expectRejectedWith(profileFor(environment, mode, auth), codes);
    },
  );
});

describe('T22b: validateSiteProfile accepts the rows of the table and their variants', () => {
  it('returns a frozen copy equal to the input', () => {
    const input = structuredClone(testAuthProfile);
    const profile = expectAccepted(input);
    expect(profile).toEqual(testAuthProfile);
    expect(profile).not.toBe(input);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.approvedTestOrigins)).toBe(true);
    input.approvedTestOrigins.push('https://other.example.invalid');
    expect(profile.approvedTestOrigins).toEqual([TEST_ORIGIN]);
  });

  it.each([
    ['a TEST public-passive profile without evidence', { ...publicProfile, environment: 'TEST' }],
    ['a TEST public-passive profile with evidence', { ...publicProfile, environment: 'TEST', environmentEvidenceRef: 'evidence/ref' }],
    ['an http loopback origin 127.0.0.1', { ...testAuthProfile, approvedTestOrigins: [LOOPBACK_TEST_ORIGIN] }],
    ['an http loopback origin localhost', { ...testAuthProfile, approvedTestOrigins: ['http://localhost:4173'] }],
    ['an http loopback origin [::1]', { ...testAuthProfile, approvedTestOrigins: ['http://[::1]:4173'] }],
    ['several approved origins', { ...testAuthProfile, approvedTestOrigins: [TEST_ORIGIN, LOOPBACK_TEST_ORIGIN] }],
    ['approved write with automated login', { ...testAuthProfile, mode: 'TEST_APPROVED_WRITE', auth: 'AUTOMATED_LOGIN' }],
    ['the longest evidence reference', { ...testAuthProfile, environmentEvidenceRef: 'e'.repeat(MAX_ENVIRONMENT_EVIDENCE_REF_LENGTH) }],
    ['an evidence reference of one character', { ...testAuthProfile, environmentEvidenceRef: 'e' }],
    ['an evidence reference with inner spaces', { ...testAuthProfile, environmentEvidenceRef: 'isolation check 1' }],
    ['the largest safe revision', { ...publicProfile, revision: Number.MAX_SAFE_INTEGER }],
    ['the smallest revision', { ...publicProfile, revision: MIN_PROFILE_REVISION }],
    ['a nested target path under config/targets/', { ...publicProfile, targetConfigPath: 'config/targets/nested/example.json' }],
    ['a target path under local/targets/', { ...publicProfile, targetConfigPath: 'local/targets/a/b/example.json' }],
  ] as const)('accepts %s', (_name, input) => {
    expectAccepted(input);
  });
});

describe('T22b: validateSiteProfile rejects a profile of the wrong shape with PROFILE_SCHEMA_INVALID', () => {
  it.each([
    ['an unknown key', { ...publicProfile, extra: true }],
    ['a missing key', (({ auth: _auth, ...rest }) => rest)(publicProfile)],
    ['an unknown mode', { ...publicProfile, mode: 'TEST_WRITE' }],
    ['an unknown environment', { ...publicProfile, environment: 'STAGING' }],
    ['an unknown auth strategy', { ...publicProfile, auth: 'PASSWORD' }],
    ['another schemaVersion', { ...publicProfile, schemaVersion: 'beaksight-profile/2' }],
    ['revision 0', { ...publicProfile, revision: 0 }],
    ['a negative revision', { ...publicProfile, revision: -1 }],
    ['a fractional revision', { ...publicProfile, revision: 1.5 }],
    ['a string revision', { ...publicProfile, revision: '1' }],
    ['a revision above the safe integers', { ...publicProfile, revision: Number.MAX_SAFE_INTEGER + 1 }],
    ['an uppercase profile id', { ...publicProfile, profileId: 'Example' }],
    ['a profile id starting with a hyphen', { ...publicProfile, profileId: '-example' }],
    ['a profile id of 64 characters', { ...publicProfile, profileId: `a${'-'.repeat(63)}` }],
    ['an empty evidence reference', { ...testAuthProfile, environmentEvidenceRef: '' }],
    ['a too long evidence reference', { ...testAuthProfile, environmentEvidenceRef: 'e'.repeat(MAX_ENVIRONMENT_EVIDENCE_REF_LENGTH + 1) }],
    ['duplicate approved origins', { ...testAuthProfile, approvedTestOrigins: [TEST_ORIGIN, TEST_ORIGIN] }],
    ['null', null],
    ['an array', [publicProfile]],
    ['a string', 'profile'],
    ['a value that cannot be copied', new Proxy({ ...publicProfile }, {})],
  ] as const)('rejects %s', (_name, input) => {
    expectRejectedWith(input, ['PROFILE_SCHEMA_INVALID']);
  });

  it('does not run the rules of the design 4.3 when the shape is wrong (only PROFILE_SCHEMA_INVALID)', () => {
    expectRejectedWith(
      { ...profileFor('PUBLIC', 'TEST_APPROVED_WRITE', 'NONE'), targetConfigPath: '../outside.json', extra: true },
      ['PROFILE_SCHEMA_INVALID'],
    );
  });
});

describe('T22b: validateSiteProfile checks the target config path', () => {
  it.each([
    ['a parent segment at the start', '../config/targets/example.json'],
    ['a parent segment inside', 'config/targets/../example.json'],
    ['a double dot inside a name', 'config/targets/example..json'],
    ['an absolute POSIX path', '/config/targets/example.json'],
    ['a UNC-like path', '//server/share/config/targets/example.json'],
    ['a drive letter with a slash', 'C:/config/targets/example.json'],
    ['a drive-relative path', 'C:config/targets/example.json'],
    ['a colon (alternate data stream)', 'config/targets/example.json:stream'],
    ['backslash separators', 'config\\targets\\example.json'],
    ['a mixed backslash separator', 'config/targets\\example.json'],
    ['an empty segment', 'config//targets/example.json'],
    ['an empty segment before the file', 'config/targets//example.json'],
    ['a trailing separator', 'config/targets/example.json/'],
    ['a dot segment', 'config/targets/./example.json'],
    ['a leading dot segment', './config/targets/example.json'],
    ['the directory only', 'config/targets/'],
    ['no extension', 'config/targets/example'],
    ['an uppercase extension', 'config/targets/example.JSON'],
    ['another extension after .json', 'config/targets/example.json.bak'],
    ['only the extension as the file name', 'config/targets/.json'],
    ['outside the target directories (config/)', 'config/example.json'],
    ['outside the target directories (targets/)', 'targets/example.json'],
    ['outside the target directories (local/)', 'local/example.json'],
    ['outside the target directories (artifacts/)', 'artifacts/targets/example.json'],
    ['other letter case of the directories', 'Config/Targets/example.json'],
    ['an empty path', ''],
    ['a control character', 'config/targets/exa\u0000mple.json'],
    ['a line break', 'config/targets/exa\nmple.json'],
  ])('rejects %s', (_name, targetConfigPath) => {
    expectRejectedWith({ ...publicProfile, targetConfigPath }, ['PROFILE_TARGET_PATH_INVALID']);
  });

  // T22d（T22R の M4）: 使える文字は ASCII の `[A-Za-z0-9._/-]` だけ。
  it.each([
    ['a percent-encoded letter', 'config/targets/ex%41mple.json'],
    ['a percent-encoded parent segment', 'config/targets/%2e%2e/example.json'],
    ['a space', 'config/targets/ex ample.json'],
    ['a leading space in a name', 'config/targets/ example.json'],
    ['a no-break space', 'config/targets/ex\u00a0ample.json'],
    ['full-width letters', 'config/targets/\uff45\uff58\uff41\uff4d\uff50\uff4c\uff45.json'],
    ['full-width dots', 'config/targets/\uff0e\uff0e/example.json'],
    ['a two dot leader', 'config/targets/\u2025/example.json'],
    ['a non-ASCII letter', 'config/targets/\u00e9xample.json'],
    ['a right-to-left override', 'config/targets/example\u202e.json'],
    ['a left-to-right mark', 'config/targets/\u200eexample.json'],
    ['a zero width space', 'config/targets/exam\u200bple.json'],
    ['a tilde', 'config/targets/example~1.json'],
    ['a plus sign', 'config/targets/example+1.json'],
    ['an at sign', 'config/targets/example@1.json'],
    ['a C1 control character', 'config/targets/exa\u0085mple.json'],
  ])('rejects a target path with %s (only ASCII letters, digits, ".", "_", "/" and "-")', (_name, targetConfigPath) => {
    expectRejectedWith({ ...publicProfile, targetConfigPath }, ['PROFILE_TARGET_PATH_INVALID']);
  });

  it('accepts a target path with every allowed character', () => {
    expectAccepted({ ...publicProfile, targetConfigPath: 'config/targets/Example_Site-1.0/AZaz09._-.json' });
  });
});

describe('T22b: validateSiteProfile checks the approved test origins', () => {
  it('requires at least one approved origin for the authenticated and the write modes', () => {
    expectRejectedWith({ ...testAuthProfile, approvedTestOrigins: [] }, ['PROFILE_TEST_ORIGINS_REQUIRED']);
    expectRejectedWith({ ...testAuthProfile, mode: 'TEST_APPROVED_WRITE', approvedTestOrigins: [] }, ['PROFILE_TEST_ORIGINS_REQUIRED']);
  });

  it.each([
    ['a trailing slash', 'https://app.example.invalid/'],
    ['a path', 'https://app.example.invalid/path'],
    ['an uppercase origin', 'HTTPS://APP.EXAMPLE.INVALID'],
    ['the default port', 'https://app.example.invalid:443'],
    ['credentials', 'https://user@app.example.invalid'],
    ['http on a host that is not loopback', 'http://example.invalid'],
    ['http on an address that is not loopback', 'http://127.0.0.2:4173'],
    ['a non-HTTP scheme', 'ftp://app.example.invalid'],
    ['an unparsable value', 'not a url'],
    ['an empty string', ''],
  ])('rejects an approved origin with %s', (_name, origin) => {
    expectRejectedWith({ ...testAuthProfile, approvedTestOrigins: [origin] }, ['PROFILE_TEST_ORIGIN_INVALID']);
  });

  it('reports only the invalid one of several approved origins', () => {
    const result = validateSiteProfile({ ...testAuthProfile, approvedTestOrigins: [TEST_ORIGIN, `${TEST_ORIGIN}/`] }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.code)).toEqual(['PROFILE_TEST_ORIGIN_INVALID']);
    }
  });

  it.each([
    ['another https host', 'https://other.example.invalid'],
    ['a subdomain of the allowed origin', 'https://sub.app.example.invalid'],
    ['another port on loopback', 'http://127.0.0.1:4174'],
    ['https instead of the allowed http on loopback', 'https://127.0.0.1:4173'],
  ])('rejects an approved origin outside the target allowed origins: %s', (_name, origin) => {
    expectRejectedWith({ ...testAuthProfile, approvedTestOrigins: [origin] }, ['PROFILE_TEST_ORIGIN_OUTSIDE_TARGET']);
  });

  it.each([
    ['PUBLIC', publicProfile],
    ['TEST', { ...publicProfile, environment: 'TEST' }],
  ] as const)('rejects approved origins on a %s public-passive profile', (_environment, profile) => {
    expectRejectedWith({ ...profile, approvedTestOrigins: [TEST_ORIGIN] }, ['PROFILE_TEST_ORIGIN_INVALID']);
  });
});

describe('T22b: validateSiteProfile checks the environment evidence reference', () => {
  it.each(['TEST_AUTH_PASSIVE', 'TEST_APPROVED_WRITE'] as const)('requires an evidence reference for %s', (mode) => {
    expectRejectedWith({ ...testAuthProfile, mode, environmentEvidenceRef: null }, ['PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED']);
  });

  it.each([
    ['only spaces', '   '],
    ['a line feed', 'evidence\nref'],
    ['a carriage return', 'evidence\rref'],
    ['a tab', 'evidence\tref'],
    ['a NUL', 'evidence\u0000ref'],
    ['a DEL', 'evidence\u007fref'],
    ['a C1 control (NEL)', 'evidence\u0085ref'],
    ['a line separator', 'evidence\u2028ref'],
    ['a paragraph separator', 'evidence\u2029ref'],
  ])('rejects an evidence reference with %s', (_name, environmentEvidenceRef) => {
    expectRejectedWith({ ...testAuthProfile, environmentEvidenceRef }, ['PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED']);
    expectRejectedWith(
      { ...publicProfile, environment: 'TEST', environmentEvidenceRef },
      ['PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED'],
    );
  });

  // T22d（T22R の M1）: 空白とゼロ幅の文字だけの値、向きを変える文字、対になっていないサロゲート、UTF-16 のコード単位で長すぎる値。
  it.each([
    ['only zero width spaces', '\u200b\u200c\u200d'],
    ['only a word joiner', '\u2060'],
    ['only a byte order mark', '\ufeff'],
    ['spaces and zero width characters', ' \u200b \u2060 \ufeff '],
    ['an ideographic space and a zero width joiner', '\u3000\u200d'],
    ['a left-to-right embedding', 'evidence\u202aref'],
    ['a right-to-left embedding', 'evidence\u202bref'],
    ['a pop directional formatting', 'evidence\u202cref'],
    ['a left-to-right override', 'evidence\u202dref'],
    ['a right-to-left override', 'evidence\u202eref'],
    ['a left-to-right isolate', 'evidence\u2066ref'],
    ['a right-to-left isolate', 'evidence\u2067ref'],
    ['a first strong isolate', 'evidence\u2068ref'],
    ['a pop directional isolate', 'evidence\u2069ref'],
    ['a left-to-right mark', 'evidence\u200eref'],
    ['a right-to-left mark', 'evidence\u200fref'],
    ['a lone high surrogate', 'evidence\ud800ref'],
    ['a lone low surrogate', 'evidence\udc00ref'],
    ['a high surrogate at the end', 'evidence\ud83d'],
    ['a low surrogate at the start', '\ude00evidence'],
    [
      'more UTF-16 code units than the maximum (astral characters)',
      ASTRAL_CHARACTER.repeat(MAX_ENVIRONMENT_EVIDENCE_REF_LENGTH / ASTRAL_CHARACTER.length + 1),
    ],
  ])('rejects an evidence reference with %s', (_name, environmentEvidenceRef) => {
    expectRejectedWith({ ...testAuthProfile, environmentEvidenceRef }, ['PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED']);
    expectRejectedWith(
      { ...publicProfile, environment: 'TEST', environmentEvidenceRef },
      ['PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED'],
    );
  });

  it.each([
    [
      'astral characters up to the maximum UTF-16 code units',
      ASTRAL_CHARACTER.repeat(MAX_ENVIRONMENT_EVIDENCE_REF_LENGTH / ASTRAL_CHARACTER.length),
    ],
    ['a surrogate pair inside', `evidence-${ASTRAL_CHARACTER}-ref`],
    ['non-ASCII letters', '\u691c\u8a3c-1'],
  ])('accepts an evidence reference with %s', (_name, environmentEvidenceRef) => {
    expectAccepted({ ...testAuthProfile, environmentEvidenceRef });
  });

  it('rejects an evidence reference on a PUBLIC profile (the PUBLIC environment has no evidence)', () => {
    expectRejectedWith({ ...publicProfile, environmentEvidenceRef: 'evidence/ref' }, ['PROFILE_MODE_ENVIRONMENT_MISMATCH']);
  });
});

describe('T22b: validateSiteProfile reports every rule that fails', () => {
  it('collects the errors of all the failed rules', () => {
    expectRejectedWith(
      {
        ...profileFor('PUBLIC', 'TEST_APPROVED_WRITE', 'NONE'),
        targetConfigPath: '../outside.json',
        approvedTestOrigins: [],
        environmentEvidenceRef: null,
      },
      [
        'PROFILE_AUTH_MISMATCH',
        'PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED',
        'PROFILE_MODE_ENVIRONMENT_MISMATCH',
        'PROFILE_TARGET_PATH_INVALID',
        'PROFILE_TEST_ORIGINS_REQUIRED',
      ],
    );
  });
});

describe('T22b: validateSiteProfile keeps its own checks when the schema would accept a value', () => {
  afterEach(() => {
    vi.doUnmock('../../src/control/control-schema-validator.js');
    vi.resetModules();
  });

  it('reports PROFILE_ID_INVALID and an unsafe revision even if the shape check let them through', async () => {
    vi.resetModules();
    vi.doMock('../../src/control/control-schema-validator.js', () => ({ validateControlDocument: () => ({ ok: true }) }));
    const policy = await import('../../src/control/profile-policy.js');

    const badId = policy.validateSiteProfile({ ...publicProfile, profileId: 'Example_Site' }, context);
    expect(codesOf(badId)).toEqual(['PROFILE_ID_INVALID']);
    const badRevision = policy.validateSiteProfile({ ...publicProfile, revision: 0 }, context);
    expect(codesOf(badRevision)).toEqual(['PROFILE_SCHEMA_INVALID']);
  });
});

describe('T22b: assertProfileRevisionAdvance', () => {
  /** 前の改訂（保存してあった値。形だけを確かめる）。 */
  const revisionOf = (revision: number, profileId = testAuthProfile.profileId): SiteProfile => ({ ...testAuthProfile, profileId, revision });
  /** 次の改訂（`validateSiteProfile` が受けた値。T22d の I1）。 */
  const validatedRevisionOf = (revision: number, profileId = testAuthProfile.profileId): ValidatedSiteProfile => {
    const result = validateSiteProfile(revisionOf(revision, profileId), context);
    if (!result.ok) {
      throw new Error(`the test profile must be valid: ${JSON.stringify(result.errors)}`);
    }
    return result.profile;
  };

  it('accepts the first revision when there is no previous profile', () => {
    const next = validatedRevisionOf(MIN_PROFILE_REVISION);
    const result = assertProfileRevisionAdvance(null, next);
    expect(result).toEqual({ ok: true, profile: next });
    if (result.ok) {
      expect(Object.isFrozen(result.profile)).toBe(true);
    }
  });

  it.each([
    [1, 2],
    [1, 5],
    [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER],
  ])('accepts revision %i → %i', (previous, next) => {
    expect(assertProfileRevisionAdvance(revisionOf(previous), validatedRevisionOf(next))).toMatchObject({ ok: true });
  });

  it('accepts a previous profile that was validated too', () => {
    expect(assertProfileRevisionAdvance(validatedRevisionOf(1), validatedRevisionOf(2))).toMatchObject({ ok: true });
  });

  it.each([
    [3, 3],
    [3, 2],
    [Number.MAX_SAFE_INTEGER, 1],
  ])('rejects revision %i → %i with PROFILE_REVISION_NOT_ADVANCED', (previous, next) => {
    const result = assertProfileRevisionAdvance(revisionOf(previous), validatedRevisionOf(next));
    expect(codesOf(result)).toEqual(['PROFILE_REVISION_NOT_ADVANCED']);
  });

  it('rejects a revision of another profile id with PROFILE_REVISION_NOT_ADVANCED', () => {
    const result = assertProfileRevisionAdvance(revisionOf(1, 'example-a'), validatedRevisionOf(2, 'example-b'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.code)).toEqual(['PROFILE_REVISION_NOT_ADVANCED']);
      expect(result.errors[0]?.detail).toContain('profileId');
    }
  });
});

// T22d（T22R の I1）: 改訂の番号は、どちらも `MIN_PROFILE_REVISION` 以上の安全な整数で、次が前より大きいときだけ受ける。
// `previous` は形（スキーマ）を、`next` は `validateSiteProfile` が受けた値か（実行時の印）を確かめる。拒否は結果で返し、例外を投げない。
describe('T22d: assertProfileRevisionAdvance compares only safe integer revisions and accepts only validated profiles', () => {
  const validated = (profile: SiteProfile): ValidatedSiteProfile => {
    const result = validateSiteProfile(profile, context);
    if (!result.ok) {
      throw new Error(`the test profile must be valid: ${JSON.stringify(result.errors)}`);
    }
    return result.profile;
  };
  const NEXT_REVISION = 5;
  const PREVIOUS_REVISION = 1;
  const validNext = (): ValidatedSiteProfile => validated({ ...testAuthProfile, revision: NEXT_REVISION });
  const validPrevious = (): SiteProfile => ({ ...testAuthProfile, revision: PREVIOUS_REVISION });

  /** 安全な整数でない、または `MIN_PROFILE_REVISION` より小さい改訂の番号と、`previous` 側に置いたときの拒否のコード。 */
  const UNCOMPARABLE_REVISIONS: readonly (readonly [string, unknown, readonly ProfileValidationErrorCode[]])[] = [
    ['NaN', Number.NaN, ['PROFILE_REVISION_NOT_ADVANCED', 'PROFILE_SCHEMA_INVALID']],
    ['Infinity', Number.POSITIVE_INFINITY, ['PROFILE_REVISION_NOT_ADVANCED', 'PROFILE_SCHEMA_INVALID']],
    ['-Infinity', Number.NEGATIVE_INFINITY, ['PROFILE_REVISION_NOT_ADVANCED', 'PROFILE_SCHEMA_INVALID']],
    ['null', null, ['PROFILE_REVISION_NOT_ADVANCED', 'PROFILE_SCHEMA_INVALID']],
    ['the string "10"', '10', ['PROFILE_REVISION_NOT_ADVANCED', 'PROFILE_SCHEMA_INVALID']],
    ['a fraction', PREVIOUS_REVISION + 0.5, ['PROFILE_REVISION_NOT_ADVANCED', 'PROFILE_SCHEMA_INVALID']],
    ['a negative number', -NEXT_REVISION, ['PROFILE_REVISION_NOT_ADVANCED', 'PROFILE_SCHEMA_INVALID']],
    ['zero', MIN_PROFILE_REVISION - 1, ['PROFILE_REVISION_NOT_ADVANCED', 'PROFILE_SCHEMA_INVALID']],
    // スキーマの `integer` は受ける（Ajv は安全な整数の範囲を確かめない）ので、改訂の確かめだけで拒否する。
    ['MAX_SAFE_INTEGER + 1', Number.MAX_SAFE_INTEGER + 1, ['PROFILE_REVISION_NOT_ADVANCED']],
  ];

  it.each(UNCOMPARABLE_REVISIONS)('rejects a previous revision of %s', (_name, revision, expected) => {
    const result = assertProfileRevisionAdvance({ ...validPrevious(), revision } as unknown as SiteProfile, validNext());
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toEqual([...expected].sort());
  });

  it.each(UNCOMPARABLE_REVISIONS)('rejects a next revision of %s (it cannot be a validated profile either)', (_name, revision) => {
    const next = { ...validNext(), revision } as unknown as ValidatedSiteProfile;
    for (const previous of [validPrevious(), null]) {
      const result = assertProfileRevisionAdvance(previous, next);
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toEqual(['PROFILE_REVISION_NOT_ADVANCED', 'PROFILE_SCHEMA_INVALID']);
    }
  });

  it.each([
    ['PUBLIC + TEST_APPROVED_WRITE', profileFor('PUBLIC', 'TEST_APPROVED_WRITE', 'MANUAL_SESSION')],
    ['PUBLIC + TEST_AUTH_PASSIVE with an origin outside the target', {
      ...profileFor('PUBLIC', 'TEST_AUTH_PASSIVE', 'AUTOMATED_LOGIN'),
      approvedTestOrigins: ['http://evil.example.invalid'],
    }],
    ['TEST + TEST_APPROVED_WRITE without evidence', { ...profileFor('TEST', 'TEST_APPROVED_WRITE', 'MANUAL_SESSION'), environmentEvidenceRef: null }],
  ] as const)('rejects an escalating profile that validateSiteProfile did not accept: %s', (_name, profile) => {
    const next = { ...profile, revision: NEXT_REVISION } as unknown as ValidatedSiteProfile;
    for (const previous of [null, { ...profile, revision: PREVIOUS_REVISION }, validPrevious()]) {
      const result = assertProfileRevisionAdvance(previous, next);
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain('PROFILE_SCHEMA_INVALID');
    }
  });

  it('rejects a valid profile that did not come from validateSiteProfile (a copy has no mark)', () => {
    const accepted = validNext();
    for (const copy of [{ ...accepted }, structuredClone(accepted), JSON.parse(JSON.stringify(accepted)) as unknown]) {
      const result = assertProfileRevisionAdvance(validPrevious(), copy as ValidatedSiteProfile);
      expect(codesOf(result)).toEqual(['PROFILE_SCHEMA_INVALID']);
    }
  });

  it('rejects a previous profile of the wrong shape with PROFILE_SCHEMA_INVALID', () => {
    for (const previous of [
      { ...validPrevious(), extra: true },
      { ...validPrevious(), mode: 'TEST_WRITE' },
      'profile',
      [validPrevious()],
    ]) {
      const result = assertProfileRevisionAdvance(previous as unknown as SiteProfile, validNext());
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain('PROFILE_SCHEMA_INVALID');
    }
  });

  it('returns a rejection instead of throwing for a Proxy, a revoked Proxy, or a value that cannot be copied', () => {
    const revocable = Proxy.revocable({ ...validPrevious() }, {});
    revocable.revoke();
    const throwingTraps = new Proxy({ ...validPrevious() }, {
      get: () => {
        throw new Error('get trap');
      },
      ownKeys: () => {
        throw new Error('ownKeys trap');
      },
      getOwnPropertyDescriptor: () => {
        throw new Error('getOwnPropertyDescriptor trap');
      },
    });
    const uncopyable: readonly unknown[] = [
      new Proxy(validNext(), {}),
      revocable.proxy,
      throwingTraps,
      { ...validPrevious(), extra: () => PREVIOUS_REVISION },
      { ...validPrevious(), revision: Symbol('revision') },
    ];
    for (const value of uncopyable) {
      expect(() => assertProfileRevisionAdvance(value as SiteProfile, validNext())).not.toThrow();
      const asPrevious = assertProfileRevisionAdvance(value as SiteProfile, validNext());
      expect(asPrevious.ok).toBe(false);
      expect(codesOf(asPrevious)).toContain('PROFILE_SCHEMA_INVALID');

      expect(() => assertProfileRevisionAdvance(validPrevious(), value as ValidatedSiteProfile)).not.toThrow();
      const asNext = assertProfileRevisionAdvance(validPrevious(), value as ValidatedSiteProfile);
      expect(asNext.ok).toBe(false);
      expect(codesOf(asNext)).toContain('PROFILE_SCHEMA_INVALID');

      expect(() => assertProfileRevisionAdvance(null, value as ValidatedSiteProfile)).not.toThrow();
      expect(assertProfileRevisionAdvance(null, value as ValidatedSiteProfile).ok).toBe(false);
    }
  });

  it('reads the previous revision once (a getter cannot answer differently to the check and to the comparison)', () => {
    let reads = 0;
    const previous = { ...validPrevious() };
    Object.defineProperty(previous, 'revision', {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? NEXT_REVISION : PREVIOUS_REVISION;
      },
    });
    const result = assertProfileRevisionAdvance(previous, validNext());
    expect(codesOf(result)).toEqual(['PROFILE_REVISION_NOT_ADVANCED']);
    expect(reads).toBe(1);
  });

  it('returns the validated next profile itself (frozen) when it advances', () => {
    const next = validNext();
    const result = assertProfileRevisionAdvance(validPrevious(), next);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile).toBe(next);
      expect(Object.isFrozen(result.profile)).toBe(true);
    }
  });
});

// T23c round 1（Task 23 の設計書 11 章の T23c の報告の行）: パスの形の確かめの公開と、取り消しの次の改訂の写し。
describe('T23c: isAcceptedTargetConfigPath is the single owner of the target path check', () => {
  it('agrees with validateSiteProfile on accepted and rejected paths', () => {
    for (const targetConfigPath of [
      'config/targets/example.json',
      'local/targets/a/b/example.json',
      '../outside.json',
      '/config/targets/example.json',
      'C:/config/targets/example.json',
      'other/targets/example.json',
      'config/targets/../targets/example.json',
      'config/targets/example.txt',
    ]) {
      const viaPolicy = codesOf(validateSiteProfile({ ...publicProfile, targetConfigPath }, context)).includes('PROFILE_TARGET_PATH_INVALID');
      expect(isAcceptedTargetConfigPath(targetConfigPath), targetConfigPath).toBe(!viaPolicy);
    }
  });
});

describe('T23c: retiredRevisionOf', () => {
  /** 改訂の番号の最大（安全な整数の上限）。これを 1 つ進めると安全な整数を超える。 */
  const LAST_SAFE_REVISION = Number.MAX_SAFE_INTEGER;

  it('returns a frozen copy whose revision is advanced by one, and leaves the input as it is', () => {
    const previous = { ...testAuthProfile };
    const result = retiredRevisionOf(previous);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile).toEqual({ ...testAuthProfile, revision: testAuthProfile.revision + 1 });
      expect(result.profile).not.toBe(previous);
      expect(Object.isFrozen(result.profile)).toBe(true);
      expect(Object.isFrozen(result.profile.approvedTestOrigins)).toBe(true);
    }
    expect(previous).toEqual(testAuthProfile);
  });

  it('does not check the combination rules of the stored value (only its shape)', () => {
    // 形は正しいが、組み合わせの規則に反する（保存してあった値は、今の規則や設定で検証し直さない。Task 22 の設計書 4.2 の 3）。
    const stored = { ...publicProfile, mode: 'TEST_APPROVED_WRITE' } as SiteProfile;
    expect(retiredRevisionOf(stored).ok).toBe(true);
  });

  it('rejects a value of the wrong shape with PROFILE_SCHEMA_INVALID', () => {
    for (const value of [null, 'profile', {}, { ...publicProfile, extra: true }, { ...publicProfile, revision: '2' }]) {
      const result = retiredRevisionOf(value as SiteProfile);
      expect(codesOf(result), JSON.stringify(value)).toEqual(['PROFILE_SCHEMA_INVALID']);
    }
  });

  it('rejects values that cannot be copied without throwing', () => {
    const proxy = new Proxy({ ...publicProfile }, {});
    expect(() => retiredRevisionOf(proxy)).not.toThrow();
    expect(codesOf(retiredRevisionOf(proxy))).toEqual(['PROFILE_SCHEMA_INVALID']);
  });

  it('rejects a broken revision number and the upper bound with PROFILE_REVISION_NOT_ADVANCED', () => {
    for (const revision of [LAST_SAFE_REVISION, LAST_SAFE_REVISION + 1, Number.MAX_VALUE]) {
      const result = retiredRevisionOf({ ...publicProfile, revision });
      expect(result.ok, String(revision)).toBe(false);
      expect(codesOf(result), String(revision)).toContain('PROFILE_REVISION_NOT_ADVANCED');
    }
    for (const revision of [0, -1, 1.5, Number.NaN]) {
      expect(retiredRevisionOf({ ...publicProfile, revision }).ok, String(revision)).toBe(false);
    }
  });

  it('is not a validated profile: assertProfileRevisionAdvance rejects it as next', () => {
    const result = retiredRevisionOf(publicProfile);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const advance = assertProfileRevisionAdvance(publicProfile, result.profile as ValidatedSiteProfile);
      expect(advance.ok).toBe(false);
      expect(codesOf(advance)).toContain('PROFILE_SCHEMA_INVALID');
    }
  });
});

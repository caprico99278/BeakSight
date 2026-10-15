// T22b（Task 22 の設計書 4.2、4.5 の I01、7）: プロファイルのない旧ターゲット JSON が、つねに `PUBLIC_PASSIVE`・`NONE`・空の Origin に
// 解決されること（`resolveLegacyTargetProfile`）と、ターゲット JSON にモードの情報を書けないこと（`loadConfig` が拒む）の検査。
// 一時のターゲット JSON は、テストの一時ディレクトリに作る（`config/targets/` には置かない）。
// 例の値は、匿名の値（`example.com`、`example.invalid`、`127.0.0.1`）だけを使う。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/config-error.js';
import { loadConfig } from '../../src/config/load-config.js';
import type { AuditConfig } from '../../src/config/types.js';
import {
  MIN_PROFILE_REVISION,
  PROFILE_ID_PATTERN,
  SITE_PROFILE_SCHEMA_VERSION,
  type SiteProfile,
} from '../../src/control/contracts.js';
import { resolveLegacyTargetProfile, validateSiteProfile } from '../../src/control/profile-policy.js';
import { createTestConfig } from '../helpers/test-config.js';

const EXAMPLE_TARGET_PATH = 'config/targets/example.json';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'beaksight-legacy-profile-'));
  temporaryDirectories.push(directory);
  return directory;
};

/** `target.id` だけを変えた `AuditConfig`。 */
const configWithTargetId = (id: string, origin = 'https://example.com'): AuditConfig => ({
  ...createTestConfig(origin),
  target: { id },
});

/** 旧ターゲット JSON の解決で、`profileId` と `targetConfigPath` 以外に期待する値（権限を増やさない値）。 */
const LEGACY_PERMISSIONS = {
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  revision: MIN_PROFILE_REVISION,
  environment: 'PUBLIC',
  mode: 'PUBLIC_PASSIVE',
  auth: 'NONE',
  approvedTestOrigins: [],
  environmentEvidenceRef: null,
} as const;

const expectLegacyProfile = (profile: SiteProfile, profileId: string, targetConfigPath: string): void => {
  expect(profile).toEqual({ ...LEGACY_PERMISSIONS, profileId, targetConfigPath });
  expect(Object.keys(profile).sort()).toEqual(Object.keys({ ...LEGACY_PERMISSIONS, profileId, targetConfigPath }).sort());
  expect(Object.isFrozen(profile)).toBe(true);
  expect(Object.isFrozen(profile.approvedTestOrigins)).toBe(true);
};

describe('T22b: resolveLegacyTargetProfile (I01)', () => {
  it('resolves config/targets/example.json to a PUBLIC_PASSIVE profile that validateSiteProfile accepts', async () => {
    const config = await loadConfig(EXAMPLE_TARGET_PATH);
    const profile = resolveLegacyTargetProfile(config, EXAMPLE_TARGET_PATH);

    expectLegacyProfile(profile, 'example', EXAMPLE_TARGET_PATH);
    expect(validateSiteProfile(profile, { targetConfig: config })).toEqual({ ok: true, profile });
  });

  /**
   * `profileId` の作り方の規則: 小文字にする → `[a-z0-9-]` 以外の文字を `-` にする → 続く `-` を 1 つにまとめる →
   * 先頭の `-` を除く → 63 文字までに切る。結果が空か `PROFILE_ID_PATTERN` に合わなければ `legacy-target`。
   */
  it.each([
    ['example', 'example'],
    ['Example-Site', 'example-site'],
    ['example_site.v2', 'example-site-v2'],
    ['example.com', 'example-com'],
    ['example  site', 'example-site'],
    ['--example', 'example'],
    ['_example_', 'example-'],
    ['123', '123'],
    ['a'.repeat(100), 'a'.repeat(63)],
    [`a${'-'.repeat(100)}b`, 'a-b'],
    [`${'-'.repeat(10)}${'b'.repeat(70)}`, 'b'.repeat(63)],
    ['K', 'k'],
    ['サイト', 'legacy-target'],
    ['Ａ', 'legacy-target'],
    ['---', 'legacy-target'],
    ['', 'legacy-target'],
  ])('derives the profile id of target.id %j as %j', (targetId, expectedProfileId) => {
    const config = configWithTargetId(targetId);
    const profile = resolveLegacyTargetProfile(config, EXAMPLE_TARGET_PATH);

    expectLegacyProfile(profile, expectedProfileId, EXAMPLE_TARGET_PATH);
    expect(PROFILE_ID_PATTERN.test(profile.profileId)).toBe(true);
    expect(validateSiteProfile(profile, { targetConfig: config })).toEqual({ ok: true, profile });
  });

  it.each([
    ['a loopback http target', configWithTargetId('loopback-target', 'http://127.0.0.1:4173')],
    ['a target with several allowed origins', {
      ...configWithTargetId('several-origins'),
      site: { startUrl: 'https://example.com/', allowedOrigins: ['https://example.com', 'https://app.example.invalid'] },
    }],
    ['a target with interactions enabled', {
      ...configWithTargetId('interactions'),
      audit: { ...createTestConfig('https://example.com').audit, interactions: true },
    }],
  ] as const)('always resolves %s to PUBLIC_PASSIVE, NONE and no origin', (_name, config) => {
    const profile = resolveLegacyTargetProfile(config, 'local/targets/example-test.json');
    expectLegacyProfile(profile, config.target.id, 'local/targets/example-test.json');
  });

  it('keeps the target config path as given, and validateSiteProfile judges its shape', () => {
    const config = configWithTargetId('example');
    const profile = resolveLegacyTargetProfile(config, '../outside.json');

    expectLegacyProfile(profile, 'example', '../outside.json');
    const result = validateSiteProfile(profile, { targetConfig: config });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.code)).toEqual(['PROFILE_TARGET_PATH_INVALID']);
    }
  });

  it('takes no input that could raise the permission (only the config and the path)', () => {
    expect(resolveLegacyTargetProfile.length).toBe(2);
  });
});

describe('T22b: a target JSON cannot carry the audit mode (I01)', () => {
  const writeTarget = async (extra: Record<string, unknown>, targetExtra: Record<string, unknown> = {}, siteExtra: Record<string, unknown> = {}): Promise<string> => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, 'target.json');
    await writeFile(path, JSON.stringify({
      target: { id: 'mode-key', ...targetExtra },
      site: { startUrl: 'https://example.com/', allowedOrigins: ['https://example.com'], ...siteExtra },
      ...extra,
    }), 'utf8');
    return path;
  };

  const loadError = async (path: string): Promise<ConfigError> => {
    try {
      await loadConfig(path);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return error as ConfigError;
    }
    throw new Error('loadConfig accepted the target JSON');
  };

  it('loads the same target JSON without the mode keys', async () => {
    const config = await loadConfig(await writeTarget({}));
    expect(config.target.id).toBe('mode-key');
  });

  it.each([
    ['mode', 'TEST_APPROVED_WRITE'],
    ['environment', 'TEST'],
    ['auth', 'AUTOMATED_LOGIN'],
    ['profile', { mode: 'TEST_APPROVED_WRITE', environment: 'TEST', auth: 'AUTOMATED_LOGIN' }],
  ])('rejects a top-level %s key with CONFIG_INVALID (unknown configuration key)', async (key, value) => {
    const error = await loadError(await writeTarget({ [key]: value }));
    expect(error.kind).toBe('CONFIG_INVALID');
    expect(error.details).toContain(`unknown configuration key: ${key}`);
  });

  it.each(['mode', 'environment', 'auth', 'profile'])('rejects a %s key inside target or site with CONFIG_INVALID', async (key) => {
    const inTarget = await loadError(await writeTarget({}, { [key]: 'TEST' }));
    expect(inTarget.kind).toBe('CONFIG_INVALID');
    expect(inTarget.details).toContain('target must be an object with only id');

    const inSite = await loadError(await writeTarget({}, {}, { [key]: 'TEST' }));
    expect(inSite.kind).toBe('CONFIG_INVALID');
    expect(inSite.details).toContain('site must be an object with startUrl and allowedOrigins');
  });
});

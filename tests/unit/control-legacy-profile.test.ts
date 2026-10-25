// T22b（Task 22 の設計書 4.5 の I01、7）: ターゲット JSON にモードの情報を書けないこと（`loadConfig` が拒む）の検査。
// 旧ターゲット JSON をプロファイルに解決する部品（呼ぶ所がなかった）は LG-3 で捨てた（2026-10-24 の設計 3.7.2）。
// 一時のターゲット JSON は、テストの一時ディレクトリに作る（`config/targets/` には置かない）。
// 例の値は、匿名の値（`example.com`）だけを使う。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/config-error.js';
import { loadConfig } from '../../src/config/load-config.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'beaksight-legacy-profile-'));
  temporaryDirectories.push(directory);
  return directory;
};

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

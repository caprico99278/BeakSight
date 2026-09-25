import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { ConfigError } from '../../src/config/config-error.js';
import { loadConfig } from '../../src/config/load-config.js';
import { validateConfig } from '../../src/config/validate-config.js';
import {
  INTERACTION_PERSISTENCE_WINDOW_MS,
  INTERACTION_STABILITY_WINDOW_MS,
  INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE,
  MAX_URL_LENGTH,
  MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS,
} from '../../src/core/limits.js';
import { createTestConfig } from '../helpers/test-config.js';

const temporaryDirectories: string[] = [];
const initialWorkingDirectory = process.cwd();

const validConfig = () => createTestConfig('https://example.test');

const writeTargetConfig = async (path: string, id: string, extra: Record<string, unknown> = {}): Promise<void> => {
  await writeFile(path, JSON.stringify({
    target: { id },
    site: { startUrl: 'https://example.test/', allowedOrigins: ['https://example.test'] },
    ...extra,
  }), 'utf8');
};

const createTemporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  process.chdir(initialWorkingDirectory);
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('configuration', () => {
  it('uses the approved browser, viewport, and generic policy defaults', () => {
    expect(DEFAULT_CONFIG.browser.locale).toBe('ja-JP');
    expect(DEFAULT_CONFIG.browser.timezone).toBe('Asia/Tokyo');
    expect(DEFAULT_CONFIG.viewports.primaryDesktop).toEqual({ width: 1440, height: 900 });
    expect(DEFAULT_CONFIG.viewports.primaryMobile).toEqual({ width: 390, height: 844 });
    expect(DEFAULT_CONFIG.crawl.maxPages).toBe(500);
    expect(DEFAULT_CONFIG.crawl.maxRuntimeMs).toBe(3_600_000);
    expect(DEFAULT_CONFIG.site).toEqual({ startUrl: '', allowedOrigins: [] });
  });

  it('accepts a complete configuration that includes the target id', () => {
    const config = validConfig();

    expect(validateConfig(config)).toEqual({ ok: true, value: config });
  });

  it('rejects an empty allowedOrigins list', () => {
    const result = validateConfig({
      ...validConfig(),
      site: { startUrl: 'https://example.test/', allowedOrigins: [] },
    });

    expect(result.ok).toBe(false);
  });

  it('rejects non-array allowedOrigins without coercion', () => {
    const result = validateConfig({
      ...validConfig(),
      site: { startUrl: 'https://example.test/', allowedOrigins: 'https://example.test' },
    });

    expect(result.ok).toBe(false);
  });

  it('rejects a configuration without a valid target section', () => {
    const { target: _target, ...withoutTarget } = validConfig();

    expect(validateConfig(withoutTarget)).toMatchObject({ ok: false, errors: [expect.stringContaining('target')] });
    expect(validateConfig({ ...validConfig(), target: { id: '' } })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('target.id')],
    });
    expect(validateConfig({ ...validConfig(), target: { id: 42 } })).toMatchObject({ ok: false });
    expect(validateConfig({ ...validConfig(), target: { id: 'fixture', name: 'extra' } })).toMatchObject({ ok: false });
  });

  it.each([
    ['allowedOrigins with a username and password', 'https://example.test/', ['https://user:secret@example.test']],
    ['allowedOrigins with only a username', 'https://example.test/', ['https://user@example.test']],
    ['allowedOrigins with only a password', 'https://example.test/', ['https://:secret@example.test']],
    ['a startUrl with credentials', 'https://user:secret@example.test/', ['https://example.test']],
  ])('rejects %s', (_label, startUrl, allowedOrigins) => {
    const result = validateConfig({ ...validConfig(), site: { startUrl, allowedOrigins } });

    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining('credentials')] });
  });

  it.each([
    ['maxPages', 1.5],
    ['maxPages', 0],
    ['maxPages', Number.MAX_SAFE_INTEGER + 1],
    ['maxDepth', 2.5],
    ['maxDepth', -1],
    ['maxDepth', Number.POSITIVE_INFINITY],
  ])('rejects crawl.%s = %s because counts must be positive integers', (key, value) => {
    const config = validConfig();
    const result = validateConfig({ ...config, crawl: { ...config.crawl, [key]: value } });

    expect(result).toMatchObject({ ok: false, errors: [`crawl.${key} must be a positive integer`] });
  });

  // P14a（Task 14〜17 の設計書 4.5.7）: 時間の設定は、正の整数に限る。`auditInteraction` などが正の整数を要求するため。
  it.each([
    ['maxRuntimeMs', 3_600_000.5],
    ['maxRuntimeMs', 0.5],
    ['navigationTimeoutMs', 30_000.5],
    ['navigationTimeoutMs', Number.MAX_SAFE_INTEGER + 1],
    ['overallPageTimeoutMs', 60_000.25],
    ['overallPageTimeoutMs', 0],
    ['resourceSettlingTimeoutMs', 5_000.5],
    ['resourceSettlingTimeoutMs', -1],
  ])('rejects crawl.%s = %s because durations must be positive integers', (key, value) => {
    const config = validConfig();
    const result = validateConfig({ ...config, crawl: { ...config.crawl, [key]: value } });

    expect(result).toMatchObject({ ok: false, errors: [`crawl.${key} must be a positive integer`] });
  });

  // 時間の設定の正の整数の下限（1）を確かめる。`overallPageTimeoutMs` と Interaction の見積もりの関係（P14e、R14 の m2）に
  // かからないように、Interaction を無効にする。
  it.each(['maxRuntimeMs', 'navigationTimeoutMs', 'overallPageTimeoutMs', 'resourceSettlingTimeoutMs'])(
    'accepts crawl.%s = 1',
    (key) => {
      const config = validConfig();

      expect(validateConfig({
        ...config,
        crawl: { ...config.crawl, [key]: 1 },
        audit: { ...config.audit, interactions: false },
      })).toMatchObject({ ok: true });
    },
  );

  // P14e（R14 の m2、Task 14〜17 の設計書 4.5.7）: Interaction が有効なら、ページの期限は、候補1つの見積もり
  // （読み込みの期限 + 倍数 × Interaction の期限）以上でなければならない。満たさない設定では、候補を1つも監査できない。
  describe('overallPageTimeoutMs and the Interaction candidate budget (R14 m2)', () => {
    const overallPageTimeoutError = (requiredMs: number): string =>
      `crawl.overallPageTimeoutMs must be at least crawl.navigationTimeoutMs + ${INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE} `
        + `x crawl.interactionTimeoutMs (${requiredMs} ms) when audit.interactions is enabled`;
    const candidateBudgetMs = (crawl: { navigationTimeoutMs: number; interactionTimeoutMs: number }): number =>
      crawl.navigationTimeoutMs + INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE * crawl.interactionTimeoutMs;

    it('accepts the default configuration, whose page deadline covers one Interaction candidate', () => {
      expect(DEFAULT_CONFIG.audit.interactions).toBe(true);
      expect(candidateBudgetMs(DEFAULT_CONFIG.crawl)).toBeLessThanOrEqual(DEFAULT_CONFIG.crawl.overallPageTimeoutMs);
      expect(validateConfig(validConfig())).toMatchObject({ ok: true });
    });

    it('accepts a page deadline equal to the budget of one Interaction candidate', () => {
      const config = validConfig();
      const overallPageTimeoutMs = candidateBudgetMs(config.crawl);

      expect(validateConfig({ ...config, crawl: { ...config.crawl, overallPageTimeoutMs } })).toMatchObject({ ok: true });
    });

    it('rejects a page deadline shorter than the budget of one Interaction candidate', () => {
      const config = validConfig();
      const requiredMs = candidateBudgetMs(config.crawl);
      const result = validateConfig({ ...config, crawl: { ...config.crawl, overallPageTimeoutMs: requiredMs - 1 } });

      expect(result).toMatchObject({ ok: false, errors: [overallPageTimeoutError(requiredMs)] });
    });

    it('rejects a long Interaction timeout that makes the budget exceed the default page deadline', () => {
      const config = validConfig();
      const crawl = { ...config.crawl, navigationTimeoutMs: 30_000, interactionTimeoutMs: 20_000 };
      const result = validateConfig({ ...config, crawl });

      expect(result).toMatchObject({ ok: false, errors: [overallPageTimeoutError(candidateBudgetMs(crawl))] });
    });

    it('accepts a short page deadline when audit.interactions is disabled', () => {
      const config = validConfig();

      expect(validateConfig({
        ...config,
        crawl: { ...config.crawl, overallPageTimeoutMs: candidateBudgetMs(config.crawl) - 1 },
        audit: { ...config.audit, interactions: false },
      })).toMatchObject({ ok: true });
    });
  });

  it.each([
    ['primaryDesktop', { width: 1440.5, height: 900 }],
    ['primaryDesktop', { width: 1440, height: 900.25 }],
    ['primaryMobile', { width: 390.5, height: 844 }],
    ['primaryMobile', { width: 390, height: Number.MAX_SAFE_INTEGER + 1 }],
  ] as const)('rejects viewports.%s = %j because the width and height must be positive integers', (key, viewport) => {
    const config = validConfig();
    const result = validateConfig({ ...config, viewports: { ...config.viewports, [key]: viewport } });

    expect(result).toMatchObject({ ok: false, errors: [`viewports.${key} width and height must be positive integers`] });
  });

  it.each([
    [[320, 390.5]],
    [[0.5]],
    [[320, Number.MAX_SAFE_INTEGER + 1]],
  ])('rejects viewports.stressWidths = %j because every width must be a positive integer', (stressWidths) => {
    const config = validConfig();
    const result = validateConfig({ ...config, viewports: { ...config.viewports, stressWidths } });

    expect(result).toMatchObject({ ok: false, errors: ['viewports.stressWidths must be an array of positive integers'] });
  });

  it.each([2_500.5, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects crawl.interactionTimeoutMs = %s because it must be a positive integer',
    (interactionTimeoutMs) => {
      const config = validConfig();
      const result = validateConfig({ ...config, crawl: { ...config.crawl, interactionTimeoutMs } });

      expect(result).toMatchObject({ ok: false, errors: ['crawl.interactionTimeoutMs must be a positive integer'] });
    },
  );

  // F17（F16 の発見事項5）: 安定性の確認と持続の確認の時間を行えない、短すぎる Interaction の期限は、設定のエラーにする。
  it('derives the lower bound of crawl.interactionTimeoutMs from the stability and persistence windows', () => {
    expect(MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS).toBe(INTERACTION_STABILITY_WINDOW_MS + INTERACTION_PERSISTENCE_WINDOW_MS);
    expect(INTERACTION_STABILITY_WINDOW_MS).toBe(500);
    expect(INTERACTION_PERSISTENCE_WINDOW_MS).toBe(500);
  });

  it.each([1, 500, MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS - 1, MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS])(
    'rejects crawl.interactionTimeoutMs = %s because it cannot cover the stability and persistence checks (F17)',
    (interactionTimeoutMs) => {
      const config = validConfig();
      const result = validateConfig({ ...config, crawl: { ...config.crawl, interactionTimeoutMs } });

      expect(result).toMatchObject({
        ok: false,
        errors: [
          `crawl.interactionTimeoutMs must be greater than ${MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS} ms `
            + '(the pre-freeze stability check and the post-condition persistence check)',
        ],
      });
    },
  );

  it.each([DEFAULT_CONFIG.crawl.interactionTimeoutMs, MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS + 1])(
    'accepts crawl.interactionTimeoutMs = %s (F17)',
    (interactionTimeoutMs) => {
      const config = validConfig();

      expect(validateConfig({ ...config, crawl: { ...config.crawl, interactionTimeoutMs } })).toMatchObject({ ok: true });
    },
  );

  it('keeps the default crawl.interactionTimeoutMs at 3,000 ms (F17)', () => {
    expect(DEFAULT_CONFIG.crawl.interactionTimeoutMs).toBe(3_000);
  });

  it('rejects malformed, non-HTTP, and origin-mismatched site URLs', () => {
    expect(validateConfig({ ...validConfig(), site: { startUrl: 'not a URL', allowedOrigins: ['https://example.test'] } }).ok).toBe(false);
    expect(validateConfig({ ...validConfig(), site: { startUrl: 'file:///tmp/audit', allowedOrigins: ['https://example.test'] } }).ok).toBe(false);
    expect(validateConfig({ ...validConfig(), site: { startUrl: 'https://example.test/', allowedOrigins: ['https://other.test'] } }).ok).toBe(false);
  });

  it('rejects a startUrl that URL normalization rejects, such as a normalized URL longer than MAX_URL_LENGTH (R\'2 m5)', () => {
    const origin = 'https://example.test';
    const tooLong = `${origin}/${'a'.repeat(MAX_URL_LENGTH)}`;
    const result = validateConfig({ ...validConfig(), site: { startUrl: tooLong, allowedOrigins: [origin] } });

    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining('URL_TOO_LONG')] });
    expect(result.ok ? [] : result.errors).toEqual([expect.stringContaining('site.startUrl')]);
  });

  it('judges the length of the startUrl after normalization, with the configured query parameters (R\'2 m5)', () => {
    const origin = 'https://example.test';
    const config = validConfig();
    // 追跡用の引数は正規化で除かれるので、生の値が長くても受け入れる。
    const trackingOnly = `${origin}/?utm_source=${'x'.repeat(MAX_URL_LENGTH)}`;
    expect(validateConfig({ ...config, site: { startUrl: trackingOnly, allowedOrigins: [origin] } }).ok).toBe(true);
    // 許可した引数は正規化の後も残るので、長すぎれば拒否する。
    const keptParameter = `${origin}/?page=${'1'.repeat(MAX_URL_LENGTH)}`;
    expect(validateConfig({
      ...config,
      site: { startUrl: keptParameter, allowedOrigins: [origin] },
      crawl: { ...config.crawl, allowedQueryParameters: ['page'] },
    })).toMatchObject({ ok: false, errors: [expect.stringContaining('URL_TOO_LONG')] });
  });

  it.each(['', 'not a locale!', 'ja_JP_', 'x'])('rejects the browser locale %j that Intl.DateTimeFormat does not accept (R\'2 m5)', (locale) => {
    const config = validConfig();
    const result = validateConfig({ ...config, browser: { ...config.browser, locale } });

    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining('browser.locale')] });
  });

  it.each(['', 'Mars/Olympus_Mons', 'Asia/Tokyo/Extra', 'UTC+99'])('rejects the browser timezone %j that Intl.DateTimeFormat does not accept (R\'2 m5)', (timezone) => {
    const config = validConfig();
    const result = validateConfig({ ...config, browser: { ...config.browser, timezone } });

    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining('browser.timezone')] });
  });

  it.each([
    ['en-US', 'America/New_York'],
    ['ja-JP', 'Asia/Tokyo'],
    ['de', 'UTC'],
  ])('accepts the browser locale %j and timezone %j that Intl.DateTimeFormat accepts (R\'2 m5)', (locale, timezone) => {
    const config = validConfig();

    expect(validateConfig({ ...config, browser: { ...config.browser, locale, timezone } }).ok).toBe(true);
  });

  // R''2 の I-1: Node の Intl.DateTimeFormat は受け付けるが、Chromium（Playwright）が拒否する値。
  it.each(['+09:00', '-0530', 'asia/tokyo'])('rejects the browser timezone %j that Chromium rejects (R\'\'2 I-1)', (timezone) => {
    const config = validConfig();
    const result = validateConfig({ ...config, browser: { ...config.browser, timezone } });

    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining('browser.timezone')] });
  });

  // F13b: IANA の名前の書き方だが、Intl.DateTimeFormat が受け付けない値。
  it.each(['Not/AZone'])('rejects the browser timezone %j that has the IANA name form but that Intl.DateTimeFormat does not accept (F13b)', (timezone) => {
    const config = validConfig();
    const result = validateConfig({ ...config, browser: { ...config.browser, timezone } });

    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining('browser.timezone')] });
  });

  // F13c: Intl が解決した名前と大文字・小文字だけが違う名前は、書き方の誤りなので拒否する（Chromium は `Invalid timezone ID` で拒否する）。
  it.each(['ASIA/TOKYO', 'Asia/TOKYO'])('rejects the browser timezone %j that differs from the Intl-resolved name only in letter case (F13c)', (timezone) => {
    const config = validConfig();
    const result = validateConfig({ ...config, browser: { ...config.browser, timezone } });

    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining('browser.timezone')] });
  });

  // F13b: Node の ICU が別の表記に解決する名前（例: Asia/Kolkata → Asia/Calcutta）も、正式な IANA の名前として受け付ける。
  it.each(['Asia/Kolkata', 'Etc/UTC', 'GMT', 'US/Pacific', 'Asia/Tokyo', 'UTC', 'Pacific/Auckland'])(
    'accepts the IANA browser timezone %j even when Intl resolves it to another spelling (F13b)',
    (timezone) => {
      const config = validConfig();

      expect(validateConfig({ ...config, browser: { ...config.browser, timezone } })).toMatchObject({ ok: true });
    },
  );

  it.each(['und', 'und-JP'])('rejects the browser locale %j that has no language and that Chromium rejects (R\'\'2 I-1)', (locale) => {
    const config = validConfig();
    const result = validateConfig({ ...config, browser: { ...config.browser, locale } });

    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining('browser.locale')] });
  });

  it.each([
    [DEFAULT_CONFIG.browser.locale, DEFAULT_CONFIG.browser.timezone],
    ['en-US', 'Pacific/Auckland'],
    ['de-CH', 'UTC'],
  ])('accepts the default and representative browser locale %j and timezone %j (R\'\'2 I-1)', (locale, timezone) => {
    const config = validConfig();

    expect(validateConfig({ ...config, browser: { ...config.browser, locale, timezone } })).toMatchObject({ ok: true });
  });

  it('rejects non-finite and non-positive runtime budgets', () => {
    expect(validateConfig({ ...validConfig(), crawl: { ...DEFAULT_CONFIG.crawl, maxRuntimeMs: Number.POSITIVE_INFINITY } }).ok).toBe(false);
    expect(validateConfig({ ...validConfig(), crawl: { ...DEFAULT_CONFIG.crawl, interactionTimeoutMs: 0 } }).ok).toBe(false);
  });

  it('rejects audit sections missing required fields', () => {
    expect(validateConfig({ ...validConfig(), audit: {} }).ok).toBe(false);
    expect(validateConfig({ ...validConfig(), audit: { performance: true } }).ok).toBe(false);
  });

  it('rejects ordinary unknown configuration keys', () => {
    expect(validateConfig({ ...validConfig(), unsupported: true }).ok).toBe(false);
  });

  it('loads the initial target with no overrides', async () => {
    const config = await loadConfig();

    expect(config.site.startUrl).toBe('https://example.com/');
    expect(config.crawl.maxPages).toBe(500);
  });

  it('loads an explicitly selected target with no overrides', async () => {
    const config = await loadConfig('config/targets/example.json');

    expect(config.site.allowedOrigins).toEqual(['https://example.com']);
  });

  it('resolves a target config, applies overrides, and returns an immutable audit config', async () => {
    const config = await loadConfig(undefined, {
      browser: { headed: true },
      output: { directory: 'artifacts/test-run' },
    });

    expect(config.site).toEqual({
      startUrl: 'https://example.com/',
      allowedOrigins: ['https://example.com'],
    });
    expect(config.browser.headed).toBe(true);
    expect(config.output.directory).toBe('artifacts/test-run');
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.site)).toBe(true);
    expect(Object.isFrozen(config.crawl)).toBe(true);
    expect(Object.isFrozen(config.viewports.stressWidths)).toBe(true);
  });

  it('lets CLI overrides take precedence over target policy and defaults', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'beaksight-config-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'target.json');
    await writeFile(path, JSON.stringify({
      target: { id: 'merge-precedence' },
      site: { startUrl: 'https://example.test/', allowedOrigins: ['https://example.test'] },
      crawl: { maxPages: 11 },
    }), 'utf8');

    const config = await loadConfig(path, { crawl: { maxPages: 17 } });

    expect(config.crawl.maxPages).toBe(17);
    expect(config.crawl.maxDepth).toBe(20);
  });

  it('rejects a selected target with a missing or invalid target.id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'beaksight-config-'));
    temporaryDirectories.push(directory);
    const missingIdPath = join(directory, 'missing-id.json');
    const invalidIdPath = join(directory, 'invalid-id.json');
    const site = { startUrl: 'https://example.test/', allowedOrigins: ['https://example.test'] };
    await writeFile(missingIdPath, JSON.stringify({ site }), 'utf8');
    await writeFile(invalidIdPath, JSON.stringify({ target: { id: '' }, site }), 'utf8');

    await expect(loadConfig(missingIdPath)).rejects.toThrow('target.id');
    await expect(loadConfig(invalidIdPath)).rejects.toThrow('target.id');
  });

  it('keeps the target id in the immutable resolved configuration', async () => {
    const config = await loadConfig();

    expect(config.target).toEqual({ id: 'example' });
    expect(Object.isFrozen(config.target)).toBe(true);
  });

  it('keeps the target id of an explicitly selected target outside config/targets', async () => {
    const directory = await createTemporaryDirectory('beaksight-config-');
    const path = join(directory, 'target.json');
    await writeTargetConfig(path, 'outside-target');

    const config = await loadConfig(path);

    expect(config.target).toEqual({ id: 'outside-target' });
    expect(Object.isFrozen(config.target)).toBe(true);
  });

  it('does not freeze or share the defaults and overrides it merged', async () => {
    const stressWidths = [320, 640];

    const config = await loadConfig(undefined, { viewports: { stressWidths } });

    expect(config.viewports.stressWidths).toEqual([320, 640]);
    expect(Object.isFrozen(config.viewports.stressWidths)).toBe(true);
    expect(Object.isFrozen(stressWidths)).toBe(false);
    expect(Object.isFrozen(DEFAULT_CONFIG.crawl.allowedQueryParameters)).toBe(false);
    expect(config.crawl.allowedQueryParameters).not.toBe(DEFAULT_CONFIG.crawl.allowedQueryParameters);
  });

  it('reads only the selected file when --config points outside config/targets', async () => {
    // レビューの実測: `schemas/` のように、ほかの JSON が並ぶディレクトリの設定を指定すると失敗していた。
    const directory = await createTemporaryDirectory('beaksight-config-');
    const path = join(directory, 'fixture-audit.json');
    await writeTargetConfig(path, 'schemas-sibling');
    await copyFile(resolve(initialWorkingDirectory, 'schemas', 'audit.schema.json'), join(directory, 'audit.schema.json'));
    await writeFile(join(directory, 'run-output.json'), '{"not":"a target"', 'utf8');
    await mkdir(join(directory, 'nested'));
    await writeFile(join(directory, 'nested', 'broken.json'), 'not json', 'utf8');

    const config = await loadConfig(path);

    expect(config.target).toEqual({ id: 'schemas-sibling' });
  });

  it('does not treat another file beside a selected target outside config/targets as a duplicate', async () => {
    const directory = await createTemporaryDirectory('beaksight-config-');
    const firstPath = join(directory, 'first.json');
    await writeTargetConfig(firstPath, 'duplicate-target');
    await writeTargetConfig(join(directory, 'second.json'), 'duplicate-target');

    await expect(loadConfig(firstPath)).resolves.toMatchObject({ target: { id: 'duplicate-target' } });
  });

  it('accepts a selected target outside config/targets whose id is also used inside config/targets', async () => {
    const directory = await createTemporaryDirectory('beaksight-config-');
    const path = join(directory, 'local-example.json');
    await writeTargetConfig(path, 'example');

    await expect(loadConfig(path)).resolves.toMatchObject({ target: { id: 'example' } });
  });

  it('still rejects duplicate target ids in config/targets when --config selects a file inside it', async () => {
    const directory = await createTemporaryDirectory('beaksight-project-');
    const targetDirectory = join(directory, 'config', 'targets');
    await mkdir(join(targetDirectory, 'nested'), { recursive: true });
    const selectedPath = join(targetDirectory, 'selected.json');
    await writeTargetConfig(selectedPath, 'canonical-duplicate');
    await writeTargetConfig(join(targetDirectory, 'nested', 'other.json'), 'canonical-duplicate');
    process.chdir(directory);

    await expect(loadConfig(selectedPath)).rejects.toThrow('duplicate target.id');
  });

  it('rejects credential-bearing allowed origins and fractional page limits from a target file', async () => {
    const directory = await createTemporaryDirectory('beaksight-config-');
    const credentialPath = join(directory, 'credentials.json');
    const fractionalPath = join(directory, 'fractional.json');
    await writeFile(credentialPath, JSON.stringify({
      target: { id: 'credentials' },
      site: { startUrl: 'https://example.test/', allowedOrigins: ['https://u:p@example.test'] },
    }), 'utf8');
    await writeTargetConfig(fractionalPath, 'fractional', { crawl: { maxPages: 1.5 } });

    await expect(loadConfig(credentialPath)).rejects.toThrow('credentials');
    await expect(loadConfig(fractionalPath)).rejects.toThrow('crawl.maxPages must be a positive integer');
  });

  it('rejects duplicate target ids recursively across the canonical target directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'beaksight-project-'));
    temporaryDirectories.push(directory);
    const targetDirectory = join(directory, 'config', 'targets');
    const nestedDirectory = join(targetDirectory, 'nested');
    await mkdir(nestedDirectory, { recursive: true });
    const target = {
      target: { id: 'recursive-duplicate' },
      site: { startUrl: 'https://example.test/', allowedOrigins: ['https://example.test'] },
    };
    await writeFile(join(targetDirectory, 'root.json'), JSON.stringify(target), 'utf8');
    await writeFile(join(nestedDirectory, 'nested.json'), JSON.stringify(target), 'utf8');
    process.chdir(directory);

    await expect(loadConfig()).rejects.toThrow('duplicate target.id');
  });

  it('rejects a __proto__ key from a selected target config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'beaksight-config-'));
    temporaryDirectories.push(directory);
    const path = resolve(directory, 'prototype.json');
    await writeFile(path, '{"target":{"id":"prototype-key"},"site":{"startUrl":"https://example.test/","allowedOrigins":["https://example.test"]},"__proto__":{"polluted":true}}', 'utf8');

    await expect(loadConfig(path)).rejects.toThrow('unknown configuration key: __proto__');
  });
});

// U17a（Task 14〜17 の設計書 6.1.5）: 設定の誤りは、種類のコードと詳細の一覧を持つ `ConfigError` で投げる。
describe('configuration errors are ConfigError (U17a)', () => {
  const rejection = async (promise: Promise<unknown>): Promise<ConfigError> => {
    const error = await promise.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  };

  it('reports a missing selected file as CONFIG_FILE_NOT_FOUND, with the path in the details', async () => {
    const directory = await createTemporaryDirectory('beaksight-config-');
    const path = join(directory, 'missing.json');

    const error = await rejection(loadConfig(path));

    expect(error.kind).toBe('CONFIG_FILE_NOT_FOUND');
    expect(error.details.join('\n')).toContain(path);
  });

  it('reports a selected directory as CONFIG_FILE_UNREADABLE', async () => {
    const directory = await createTemporaryDirectory('beaksight-config-');

    const error = await rejection(loadConfig(directory));

    expect(error.kind).toBe('CONFIG_FILE_UNREADABLE');
    expect(error.details.join('\n')).toContain(directory);
  });

  it('reports a file that is not JSON as CONFIG_JSON_INVALID', async () => {
    const directory = await createTemporaryDirectory('beaksight-config-');
    const path = join(directory, 'broken.json');
    await writeFile(path, '{"target":', 'utf8');

    const error = await rejection(loadConfig(path));

    expect(error.kind).toBe('CONFIG_JSON_INVALID');
    expect(error.message).toContain('not valid JSON');
    expect(error.details.join('\n')).toContain(path);
  });

  it('reports a missing target.id as TARGET_ID_MISSING', async () => {
    const directory = await createTemporaryDirectory('beaksight-config-');
    const path = join(directory, 'no-id.json');
    await writeFile(path, JSON.stringify({ site: { startUrl: 'https://example.test/', allowedOrigins: ['https://example.test'] } }), 'utf8');

    const error = await rejection(loadConfig(path));

    expect(error.kind).toBe('TARGET_ID_MISSING');
    expect(error.message).toContain('target.id');
  });

  it('reports duplicate target ids in config/targets as TARGET_ID_DUPLICATED', async () => {
    const directory = await createTemporaryDirectory('beaksight-project-');
    const targetDirectory = join(directory, 'config', 'targets');
    await mkdir(targetDirectory, { recursive: true });
    await writeTargetConfig(join(targetDirectory, 'a.json'), 'same-id');
    await writeTargetConfig(join(targetDirectory, 'b.json'), 'same-id');
    process.chdir(directory);

    const error = await rejection(loadConfig());

    expect(error.kind).toBe('TARGET_ID_DUPLICATED');
    expect(error.message).toContain('duplicate target.id');
    expect(error.details.join('\n')).toContain('same-id');
  });

  it('reports zero or several target files in config/targets without --config as TARGET_NOT_SELECTED', async () => {
    const directory = await createTemporaryDirectory('beaksight-project-');
    const targetDirectory = join(directory, 'config', 'targets');
    await mkdir(targetDirectory, { recursive: true });
    process.chdir(directory);

    expect((await rejection(loadConfig())).kind).toBe('TARGET_NOT_SELECTED');

    await writeTargetConfig(join(targetDirectory, 'a.json'), 'first');
    await writeTargetConfig(join(targetDirectory, 'b.json'), 'second');

    expect((await rejection(loadConfig())).kind).toBe('TARGET_NOT_SELECTED');
  });

  it('reports a missing config/targets directory without --config as CONFIG_FILE_NOT_FOUND', async () => {
    const directory = await createTemporaryDirectory('beaksight-project-');
    process.chdir(directory);

    expect((await rejection(loadConfig())).kind).toBe('CONFIG_FILE_NOT_FOUND');
  });

  it('reports validation errors as CONFIG_INVALID, with every English validation error as a detail', async () => {
    const directory = await createTemporaryDirectory('beaksight-config-');
    const path = join(directory, 'invalid.json');
    await writeTargetConfig(path, 'invalid', { crawl: { maxPages: 1.5, maxDepth: 0 } });

    const error = await rejection(loadConfig(path));

    expect(error.kind).toBe('CONFIG_INVALID');
    expect(error.details).toEqual(expect.arrayContaining([
      'crawl.maxPages must be a positive integer',
      'crawl.maxDepth must be a positive integer',
    ]));
    expect(error.message).toContain('crawl.maxPages must be a positive integer');
  });

  it('reports invalid CLI overrides as CONFIG_INVALID', async () => {
    const directory = await createTemporaryDirectory('beaksight-config-');
    const path = join(directory, 'target.json');
    await writeTargetConfig(path, 'override');

    const error = await rejection(loadConfig(path, { output: { directory: '' } }));

    expect(error.kind).toBe('CONFIG_INVALID');
    expect(error.details.length).toBeGreaterThan(0);
  });
});

// R17f（Task 14〜17 の設計書 第7章、R17 の指摘4）: 設定のファイルの先頭の UTF-8 の BOM を1つだけ取り除いてから、JSON として読む。
// Windows PowerShell 5.1 は、既定で BOM を付けて書くためである。
describe('configuration files with a UTF-8 BOM (R17 finding 4)', () => {
  const BYTE_ORDER_MARK = '\uFEFF';
  const targetJson = (id: string): string => JSON.stringify({
    target: { id },
    site: { startUrl: 'https://example.test/', allowedOrigins: ['https://example.test'] },
  });

  it('reads a selected file that starts with a UTF-8 BOM', async () => {
    const directory = await createTemporaryDirectory('beaksight-config-');
    const path = join(directory, 'with-bom.json');
    await writeFile(path, `${BYTE_ORDER_MARK}${targetJson('with-bom')}`, 'utf8');

    const config = await loadConfig(path);

    expect(config.target.id).toBe('with-bom');
    expect(config.site.startUrl).toBe('https://example.test/');
  });

  it('reads the files in config/targets that start with a UTF-8 BOM', async () => {
    const directory = await createTemporaryDirectory('beaksight-project-');
    const targetDirectory = join(directory, 'config', 'targets');
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(join(targetDirectory, 'only.json'), `${BYTE_ORDER_MARK}${targetJson('canonical-with-bom')}`, 'utf8');
    process.chdir(directory);

    expect((await loadConfig()).target.id).toBe('canonical-with-bom');
  });

  it('removes only one BOM: a file that starts with two BOMs is still not valid JSON', async () => {
    const directory = await createTemporaryDirectory('beaksight-config-');
    const path = join(directory, 'two-boms.json');
    await writeFile(path, `${BYTE_ORDER_MARK}${BYTE_ORDER_MARK}${targetJson('two-boms')}`, 'utf8');

    await expect(loadConfig(path)).rejects.toMatchObject({ kind: 'CONFIG_JSON_INVALID' });
  });

  it('keeps a BOM that is not at the start (inside a string value)', async () => {
    const directory = await createTemporaryDirectory('beaksight-config-');
    const path = join(directory, 'inner-bom.json');
    await writeFile(path, targetJson(`inner${BYTE_ORDER_MARK}bom`), 'utf8');

    expect((await loadConfig(path)).target.id).toBe(`inner${BYTE_ORDER_MARK}bom`);
  });
});

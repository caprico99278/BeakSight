import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { ConfigError } from '../../src/config/config-error.js';
import { OLD_HIDDEN_CRAWL_DEFAULTS, loadConfig } from '../../src/config/load-config.js';
import { validateConfig } from '../../src/config/validate-config.js';
import { createTestConfig } from '../helpers/test-config.js';

const temporaryDirectories: string[] = [];
const initialWorkingDirectory = process.cwd();

// ループバックでない Origin なので、ページの読み込みの間隔は、`createTestConfig` の 0 ではなく既定値にする（L1。設計書 4.2 の下限）。
const validConfig = () => createTestConfig('https://example.test', '/', {
  crawl: { minNavigationIntervalMs: DEFAULT_CONFIG.crawl.minNavigationIntervalMs },
});
const validBaseConfig = validConfig;

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

  // LZ-3a: ページの上限の上限（前は 100,000）は撤廃した。利用者が指定した正の整数をそのまま受ける。
  it('accepts any positive integer for crawl.maxPages (LZ-3a)', () => {
    const config = validConfig();
    for (const maxPages of [100_001, Number.MAX_SAFE_INTEGER]) {
      expect(validateConfig({ ...config, crawl: { ...config.crawl, maxPages } }).ok).toBe(true);
    }
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

  // SPEC-5（設計書 2026-11-14 5.1）: 安定と持続の窓をやめたので、窓の和から導いた下限（前は 1,000ms を超えること。F17）もやめた。正の整数なら受ける。
  it.each([1, 500, 1_000, OLD_HIDDEN_CRAWL_DEFAULTS.interactionTimeoutMs])(
    'accepts crawl.interactionTimeoutMs = %s',
    (interactionTimeoutMs) => {
      const config = validConfig();

      expect(validateConfig({ ...config, crawl: { ...config.crawl, interactionTimeoutMs } })).toMatchObject({ ok: true });
    },
  );

  // L1（サイトへの負荷の制御の設計書 3.2、4.2）: ページの読み込みの最小の間隔と、1ページの Interaction の候補の上限。
  // 間隔は、許可 Origin にループバックでないものが1つでもあれば 1000 ms 以上、ループバックのアドレスだけなら 0 以上。
  describe('crawl.minNavigationIntervalMs and crawl.maxInteractionsPerPage (L1)', () => {
    const LOOPBACK_ORIGINS = ['http://127.0.0.1:8123', 'http://localhost:8123', 'http://[::1]:8123'] as const;
    const NON_LOOPBACK_ORIGIN = 'https://example.com';
    const INTERVAL_LOWER_BOUND_ERROR = 'crawl.minNavigationIntervalMs must be at least 1000 ms when site.allowedOrigins '
      + 'includes an origin that is not a loopback address (127.0.0.1, [::1], localhost)';
    const INTERVAL_INTEGER_ERROR = 'crawl.minNavigationIntervalMs must be a non-negative integer';
    const INTERACTION_LIMIT_INTEGER_ERROR = 'crawl.maxInteractionsPerPage must be a positive integer';

    /** `allowedOrigins` だけを許可し、その1つ目から始める設定に、`crawl` の項目を重ねる。 */
    const configWith = (allowedOrigins: readonly string[], crawl: Record<string, unknown>): Record<string, unknown> => {
      const config = validConfig();
      return {
        ...config,
        site: { startUrl: `${allowedOrigins[0] ?? ''}/`, allowedOrigins },
        crawl: { ...config.crawl, ...crawl },
      };
    };

    // サイトへの負荷の決まり: 既定の読み込みの間隔（候補の上限の既定がないことは hidden-defaults-removed が確かめる）。
    it('uses 5,000 ms as the default interval', () => {
      expect(DEFAULT_CONFIG.crawl.minNavigationIntervalMs).toBe(5_000);
    });

    it('accepts the defaults and a chosen candidate limit for a non-loopback origin', () => {
      expect(validateConfig(configWith([NON_LOOPBACK_ORIGIN], {
        minNavigationIntervalMs: DEFAULT_CONFIG.crawl.minNavigationIntervalMs,
      }))).toMatchObject({ ok: true });
      expect(validateConfig(configWith([NON_LOOPBACK_ORIGIN], {
        minNavigationIntervalMs: DEFAULT_CONFIG.crawl.minNavigationIntervalMs,
        maxInteractionsPerPage: 7,
      }))).toMatchObject({ ok: true });
    });

    it('loads a target file without the settings with the defaults, for a non-loopback origin', async () => {
      const directory = await createTemporaryDirectory('beaksight-config-load-control-');
      const path = join(directory, 'target.json');
      await writeTargetConfig(path, 'load-control-defaults');

      const config = await loadConfig(path);

      expect(Object.keys(config.crawl)).toEqual(expect.arrayContaining(['minNavigationIntervalMs']));
      expect(config.crawl.minNavigationIntervalMs).toBe(DEFAULT_CONFIG.crawl.minNavigationIntervalMs);
      // L14: 指定していない上限は持たない。
      expect(config.crawl.maxInteractionsPerPage).toBeUndefined();
    });

    it.each(LOOPBACK_ORIGINS)('accepts crawl.minNavigationIntervalMs = 0 when the only allowed origin is the loopback origin %s', (origin) => {
      expect(validateConfig(configWith([origin], { minNavigationIntervalMs: 0 }))).toMatchObject({ ok: true });
    });

    it('accepts crawl.minNavigationIntervalMs = 0 when every allowed origin is a loopback origin', () => {
      expect(validateConfig(configWith(LOOPBACK_ORIGINS, { minNavigationIntervalMs: 0 }))).toMatchObject({ ok: true });
    });

    it.each([
      [[NON_LOOPBACK_ORIGIN], 0],
      [[NON_LOOPBACK_ORIGIN], 999],
      [['http://127.0.0.1:8123', NON_LOOPBACK_ORIGIN], 999],
      [[NON_LOOPBACK_ORIGIN, 'http://localhost:8123'], 0],
    ])('rejects crawl.minNavigationIntervalMs below 1000 ms when the allowed origins %j include a non-loopback origin (%s ms)', (allowedOrigins, minNavigationIntervalMs) => {
      expect(validateConfig(configWith(allowedOrigins, { minNavigationIntervalMs }))).toMatchObject({
        ok: false,
        errors: [INTERVAL_LOWER_BOUND_ERROR],
      });
    });

    it.each([
      [[NON_LOOPBACK_ORIGIN]],
      [['http://127.0.0.1:8123', NON_LOOPBACK_ORIGIN]],
    ])('accepts crawl.minNavigationIntervalMs = 1000 when the allowed origins %j include a non-loopback origin', (allowedOrigins) => {
      expect(validateConfig(configWith(allowedOrigins, { minNavigationIntervalMs: 1_000 }))).toMatchObject({ ok: true });
    });

    it.each([
      [LOOPBACK_ORIGINS[0], -1],
      [LOOPBACK_ORIGINS[0], 1_000.5],
      [LOOPBACK_ORIGINS[0], '5000'],
      [LOOPBACK_ORIGINS[0], Number.MAX_SAFE_INTEGER + 1],
      [NON_LOOPBACK_ORIGIN, -1],
      [NON_LOOPBACK_ORIGIN, 0.5],
      [NON_LOOPBACK_ORIGIN, '5000'],
    ])('rejects crawl.minNavigationIntervalMs for the origin %s = %j because it must be a non-negative integer', (origin, minNavigationIntervalMs) => {
      expect(validateConfig(configWith([origin], { minNavigationIntervalMs }))).toMatchObject({
        ok: false,
        errors: [INTERVAL_INTEGER_ERROR],
      });
    });

    it.each([0, 1.5, -1, '20'])('rejects crawl.maxInteractionsPerPage = %j because it must be a positive integer', (maxInteractionsPerPage) => {
      expect(validateConfig(configWith([NON_LOOPBACK_ORIGIN], { minNavigationIntervalMs: 1_000, maxInteractionsPerPage }))).toMatchObject({
        ok: false,
        errors: [INTERACTION_LIMIT_INTEGER_ERROR],
      });
    });

    // L10（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4）: 前の候補の数の上限（100）を超える指定（101）も受ける。
    it.each([1, 101])('accepts crawl.maxInteractionsPerPage = %s', (maxInteractionsPerPage) => {
      expect(validateConfig(configWith([NON_LOOPBACK_ORIGIN], { minNavigationIntervalMs: 1_000, maxInteractionsPerPage })))
        .toMatchObject({ ok: true });
    });

    it('accepts both settings in the crawl section, which rejects unknown and missing settings', () => {
      const config = configWith([NON_LOOPBACK_ORIGIN], { minNavigationIntervalMs: 1_000, maxInteractionsPerPage: 20 });
      const crawl = config.crawl as Record<string, unknown>;
      const { minNavigationIntervalMs: _interval, ...withoutInterval } = crawl;
      const { maxInteractionsPerPage: _limit, ...withoutLimit } = crawl;
      const unsupportedSettingsError = 'crawl must be an object with only supported settings';

      expect(validateConfig(config)).toEqual({ ok: true, value: config });
      expect(validateConfig({ ...config, crawl: { ...crawl, unsupportedSetting: 1 } })).toMatchObject({
        ok: false,
        errors: [unsupportedSettingsError],
      });
      expect(validateConfig({ ...config, crawl: withoutInterval })).toMatchObject({ ok: false, errors: [unsupportedSettingsError] });
      // L14: 1 ページの候補の上限は、指定したときだけ持つ（ない設定も受け入れる）。
      expect(validateConfig({ ...config, crawl: withoutLimit })).toEqual({ ok: true, value: { ...config, crawl: withoutLimit } });
    });
  });

  it('rejects malformed, non-HTTP, and origin-mismatched site URLs', () => {
    expect(validateConfig({ ...validConfig(), site: { startUrl: 'not a URL', allowedOrigins: ['https://example.test'] } }).ok).toBe(false);
    expect(validateConfig({ ...validConfig(), site: { startUrl: 'file:///tmp/audit', allowedOrigins: ['https://example.test'] } }).ok).toBe(false);
    expect(validateConfig({ ...validConfig(), site: { startUrl: 'https://example.test/', allowedOrigins: ['https://other.test'] } }).ok).toBe(false);
  });

  // L14（INV-LIMITS の表 A の N23）: 正規化は長さで拒まないので、長い開始 URL も受け入れる（前は `URL_TOO_LONG` で拒んだ。R'2 m5）。
  it('accepts a startUrl longer than the former limit (2,048), with or without the kept query parameters (L14 N23)', () => {
    const origin = 'https://example.test';
    const config = validConfig();
    const tooLong = `${origin}/${'a'.repeat(2_048)}`;
    expect(validateConfig({ ...config, site: { startUrl: tooLong, allowedOrigins: [origin] } }).ok).toBe(true);
    const keptParameter = `${origin}/?page=${'1'.repeat(2_048)}`;
    expect(validateConfig({
      ...config,
      site: { startUrl: keptParameter, allowedOrigins: [origin] },
      crawl: { ...config.crawl, allowedQueryParameters: ['page'] },
    }).ok).toBe(true);
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
    // L14: ページの上限は既定を持たない。
    expect(config.crawl.maxPages).toBeUndefined();
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
    // L14: 深さと時間の上限は既定を持たない（指定したときだけ）。
    expect(config.crawl.maxDepth).toBeUndefined();
    expect(config.crawl.maxRuntimeMs).toBeUndefined();
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

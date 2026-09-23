import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { loadConfig } from '../../src/config/load-config.js';
import { validateConfig } from '../../src/config/validate-config.js';

const temporaryDirectories: string[] = [];
const initialWorkingDirectory = process.cwd();

const validConfig = () => ({
  ...DEFAULT_CONFIG,
  site: { startUrl: 'https://example.test/', allowedOrigins: ['https://example.test'] },
});

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

  it('rejects an empty allowedOrigins list', () => {
    const result = validateConfig({
      ...DEFAULT_CONFIG,
      site: { startUrl: 'https://example.test/', allowedOrigins: [] },
    });

    expect(result.ok).toBe(false);
  });

  it('rejects non-array allowedOrigins without coercion', () => {
    const result = validateConfig({
      ...DEFAULT_CONFIG,
      site: { startUrl: 'https://example.test/', allowedOrigins: 'https://example.test' },
    });

    expect(result.ok).toBe(false);
  });

  it('rejects malformed, non-HTTP, and origin-mismatched site URLs', () => {
    expect(validateConfig({ ...validConfig(), site: { startUrl: 'not a URL', allowedOrigins: ['https://example.test'] } }).ok).toBe(false);
    expect(validateConfig({ ...validConfig(), site: { startUrl: 'file:///tmp/audit', allowedOrigins: ['https://example.test'] } }).ok).toBe(false);
    expect(validateConfig({ ...validConfig(), site: { startUrl: 'https://example.test/', allowedOrigins: ['https://other.test'] } }).ok).toBe(false);
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

  it('rejects duplicate target ids found beside the selected target config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'beaksight-config-'));
    temporaryDirectories.push(directory);
    const target = {
      target: { id: 'duplicate-target' },
      site: { startUrl: 'https://example.test/', allowedOrigins: ['https://example.test'] },
    };

    const firstPath = join(directory, 'first.json');
    await writeFile(firstPath, JSON.stringify(target), 'utf8');
    await writeFile(join(directory, 'second.json'), JSON.stringify(target), 'utf8');

    await expect(loadConfig(firstPath)).rejects.toThrow('duplicate target.id');
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

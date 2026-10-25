/**
 * T44d（Task 44 の設計書 P2-1。設計の変更の履歴の T44d の行の案 (a)）: プロファイルの画面から、ページの上限・時間の上限・読み込みの間隔を、
 * プロファイルが指す設定のファイルに書く部品（`src/server/target-config-writer.ts`）。root は一時のフォルダ（実際の `local/` に書かない）。
 * - 読む: 今の値（既定値を合わせた値）と、読み込みの間隔の下限（許可 Origin にループバックでないものがあれば 1 秒、なければ 0）。
 * - 組み立て: 3 つの値だけを変え、ほかの項目は変えない。値の範囲は、設定の検証（`validateConfig`）と同じ（受ける・拒む値が検証と一致する）。
 *   間隔は、今の下限より短くできない。値が同じなら、書かない（`CRAWL_LIMITS_UNCHANGED`。書けば digest が変わり、承認が外れるため）。
 * - 置き換え: `local/targets/<id>.json` の形のパスだけ。読んだ中身が、画面が見た中身と違えば書かない（`TARGET_CONFIG_CHANGED`）。一時のファイルに
 *   書いてから名前を変えるので、途中で壊れた本体を残さない。一時のファイルは残らない。置き場所がリンクなら書かない。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { loadConfig, targetConfigWithDefaultsOf } from '../../../src/config/load-config.js';
import { validateConfig } from '../../../src/config/validate-config.js';
import { MAX_CRAWL_MAX_PAGES } from '../../../src/core/limits.js';
import {
  isEditableTargetConfigPath,
  prepareTargetCrawlLimitsChange,
  readTargetCrawlLimits,
  replaceTargetConfig,
} from '../src/server/target-config-writer';

const roots: string[] = [];
const junctions: string[] = [];

const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'beaksight-t44d-limits-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const linkPath of junctions.splice(0)) {
    unlinkSync(linkPath);
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const PATH = 'local/targets/limits-test.json';
const PUBLIC_ORIGIN = 'https://example.test';
const LOOPBACK_ORIGIN = 'http://127.0.0.1:9';
const LIMITS = Object.freeze({ maxPages: 3, maxRuntimeMs: 3_600_000, minNavigationIntervalMs: 10_000 });

/** 設定のファイルの中身（ほかの項目も持つ。変えないことを確かめる）。 */
const contentOf = (origin: string, crawl: Readonly<Record<string, unknown>> = LIMITS): string => `${JSON.stringify({
  target: { id: 'limits-test' },
  site: { startUrl: `${origin}/admin/`, allowedOrigins: [origin] },
  crawl: { ...crawl, maxDepth: 4, allowedQueryParameters: ['page'] },
  audit: { performance: false, accessibility: true, interactions: false, screenshots: false },
  output: { directory: 'artifacts/limits-test' },
}, null, 2)}\n`;

const temporaryFilesIn = (directory: string): readonly string[] =>
  existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('.tmp')) : [];

describe('T44d: reading the limits of the target configuration', () => {
  it('reads the current values and the floor of the navigation interval (1 s with a non-loopback origin, 0 with loopback only)', () => {
    expect(readTargetCrawlLimits(contentOf(PUBLIC_ORIGIN))).toMatchObject({ ok: true, limits: LIMITS, minNavigationIntervalFloorMs: 1_000 });
    expect(readTargetCrawlLimits(contentOf(LOOPBACK_ORIGIN))).toMatchObject({ ok: true, limits: LIMITS, minNavigationIntervalFloorMs: 0 });
  });

  it('reads the default values for a file without the crawl values (the same merge as loadConfig)', () => {
    const content = `${JSON.stringify({ target: { id: 'limits-test' }, site: { startUrl: `${PUBLIC_ORIGIN}/`, allowedOrigins: [PUBLIC_ORIGIN] } })}\n`;
    expect(readTargetCrawlLimits(content)).toMatchObject({
      ok: true,
      limits: {
        maxPages: DEFAULT_CONFIG.crawl.maxPages,
        maxRuntimeMs: DEFAULT_CONFIG.crawl.maxRuntimeMs,
        minNavigationIntervalMs: DEFAULT_CONFIG.crawl.minNavigationIntervalMs,
      },
    });
  });

  it('does not read a file that is not valid JSON or does not pass validateConfig', () => {
    expect(readTargetCrawlLimits('{ not json')).toEqual({ ok: false });
    expect(readTargetCrawlLimits(contentOf(PUBLIC_ORIGIN, { ...LIMITS, maxPages: 0 }))).toEqual({ ok: false });
    // BOM（Windows PowerShell 5.1 が付ける）は、loadConfig と同じく 1 つだけ取り除いて読む。
    expect(readTargetCrawlLimits(`﻿${contentOf(PUBLIC_ORIGIN)}`)).toMatchObject({ ok: true, limits: LIMITS });
  });
});

describe('T44d: preparing the change of the limits', () => {
  it('changes only the three values, keeps the other items, and the result is read by loadConfig', async () => {
    const before = contentOf(PUBLIC_ORIGIN);
    const after = { maxPages: 50, maxRuntimeMs: 1_800_000, minNavigationIntervalMs: 2_000 };
    const prepared = prepareTargetCrawlLimitsChange(before, after);
    expect(prepared).toMatchObject({ ok: true, before: LIMITS, after });
    if (!prepared.ok) {
      return;
    }
    const expected = JSON.parse(before) as Record<string, Record<string, unknown>>;
    expect(JSON.parse(prepared.content)).toEqual({ ...expected, crawl: { ...expected['crawl'], ...after } });
    expect(prepared.content.endsWith('}\n')).toBe(true);
    const root = temporaryRoot();
    mkdirSync(join(root, 'local/targets'), { recursive: true });
    writeFileSync(join(root, PATH), prepared.content, 'utf8');
    expect((await loadConfig(join(root, PATH))).crawl).toMatchObject(after);
  });

  it('rejects the values outside the range of validateConfig, by field', () => {
    const content = contentOf(PUBLIC_ORIGIN);
    expect(prepareTargetCrawlLimitsChange(content, { maxPages: 0, maxRuntimeMs: 1.5, minNavigationIntervalMs: -1 })).toEqual({
      ok: false,
      reason: 'CRAWL_LIMITS_INVALID',
      problems: [
        { field: 'maxPages', code: 'NOT_POSITIVE_INTEGER' },
        { field: 'maxRuntimeMs', code: 'NOT_POSITIVE_INTEGER' },
        { field: 'minNavigationIntervalMs', code: 'NOT_NON_NEGATIVE_INTEGER' },
      ],
    });
    expect(prepareTargetCrawlLimitsChange(content, { ...LIMITS, maxPages: Number.MAX_SAFE_INTEGER + 1 })).toMatchObject({
      ok: false,
      problems: [{ field: 'maxPages', code: 'NOT_POSITIVE_INTEGER' }],
    });
    // T44R（Task 44 のレビューの M-3）: ページの上限は、`validateConfig` と同じ上限（`MAX_CRAWL_MAX_PAGES`）を超えられない。上限そのものは受ける。
    expect(prepareTargetCrawlLimitsChange(content, { ...LIMITS, maxPages: MAX_CRAWL_MAX_PAGES + 1 })).toEqual({
      ok: false,
      reason: 'CRAWL_LIMITS_INVALID',
      problems: [{ field: 'maxPages', code: 'ABOVE_MAX_PAGES' }],
    });
    expect(prepareTargetCrawlLimitsChange(content, { ...LIMITS, maxPages: MAX_CRAWL_MAX_PAGES }).ok).toBe(true);
  });

  it('does not make the navigation interval shorter than the current floor (1 s for a non-loopback origin)', () => {
    expect(prepareTargetCrawlLimitsChange(contentOf(PUBLIC_ORIGIN), { ...LIMITS, minNavigationIntervalMs: 999 })).toEqual({
      ok: false,
      reason: 'CRAWL_LIMITS_INVALID',
      problems: [{ field: 'minNavigationIntervalMs', code: 'BELOW_NAVIGATION_INTERVAL_FLOOR' }],
    });
    expect(prepareTargetCrawlLimitsChange(contentOf(PUBLIC_ORIGIN), { ...LIMITS, minNavigationIntervalMs: 1_000 })).toMatchObject({ ok: true });
    // ループバックだけの設定（テスト用のサイト）は、今の検証と同じく 0 を受ける。
    expect(prepareTargetCrawlLimitsChange(contentOf(LOOPBACK_ORIGIN), { ...LIMITS, minNavigationIntervalMs: 0 })).toMatchObject({ ok: true });
  });

  it('accepts and rejects the same values as validateConfig', () => {
    const values = [-1, 0, 1, 2.5, 999, 1_000, 1_001, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1];
    for (const origin of [PUBLIC_ORIGIN, LOOPBACK_ORIGIN]) {
      const content = contentOf(origin);
      for (const field of ['maxPages', 'maxRuntimeMs', 'minNavigationIntervalMs'] as const) {
        for (const value of values) {
          const limits = { ...LIMITS, [field]: value };
          const document = JSON.parse(content) as Record<string, Record<string, unknown>>;
          const byValidator = validateConfig(targetConfigWithDefaultsOf({ ...document, crawl: { ...document['crawl'], ...limits } })).ok;
          const prepared = prepareTargetCrawlLimitsChange(content, limits);
          const accepted = prepared.ok || prepared.reason === 'CRAWL_LIMITS_UNCHANGED';
          expect(accepted, `${origin} ${field} ${value}`).toBe(byValidator);
        }
      }
    }
  });

  it('writes nothing when the values do not change, and rejects a file that does not pass validateConfig', () => {
    expect(prepareTargetCrawlLimitsChange(contentOf(PUBLIC_ORIGIN), LIMITS)).toEqual({ ok: false, reason: 'CRAWL_LIMITS_UNCHANGED', problems: [] });
    expect(prepareTargetCrawlLimitsChange('{ not json', LIMITS)).toEqual({ ok: false, reason: 'TARGET_CONFIG_INVALID', problems: [] });
    // 欄の確かめを通っても、最後の validateConfig が拒めば書かない（テストの口）。
    expect(prepareTargetCrawlLimitsChange(contentOf(PUBLIC_ORIGIN), { ...LIMITS, maxPages: 9 }, (input) =>
      (JSON.stringify(input).includes('"maxPages":9') ? { ok: false, errors: ['rejected'] } : validateConfig(input))))
      .toEqual({ ok: false, reason: 'TARGET_CONFIG_INVALID', problems: [] });
  });
});

describe('T44d: replacing the target configuration', () => {
  const writeCurrent = (root: string, content: string): void => {
    mkdirSync(join(root, 'local/targets'), { recursive: true });
    writeFileSync(join(root, PATH), content, 'utf8');
  };

  it('replaces the file that has the content the screen read, without leaving a temporary file', async () => {
    const root = temporaryRoot();
    const before = contentOf(PUBLIC_ORIGIN);
    writeCurrent(root, before);
    expect(await replaceTargetConfig(root, PATH, before, 'replaced\n')).toEqual({ ok: true });
    expect(readFileSync(join(root, PATH), 'utf8')).toBe('replaced\n');
    expect(temporaryFilesIn(join(root, 'local/targets'))).toEqual([]);
  });

  it('does not replace a file that was changed after the screen read it, or that is gone', async () => {
    const root = temporaryRoot();
    writeCurrent(root, 'changed by someone\n');
    expect(await replaceTargetConfig(root, PATH, contentOf(PUBLIC_ORIGIN), 'replaced\n')).toEqual({ ok: false, reason: 'TARGET_CONFIG_CHANGED' });
    expect(readFileSync(join(root, PATH), 'utf8')).toBe('changed by someone\n');
    unlinkSync(join(root, PATH));
    expect(await replaceTargetConfig(root, PATH, contentOf(PUBLIC_ORIGIN), 'replaced\n')).toEqual({ ok: false, reason: 'TARGET_CONFIG_CHANGED' });
    expect(existsSync(join(root, PATH))).toBe(false);
  });

  it('writes only to local/targets/<id>.json (not to config/targets or any other path)', async () => {
    const root = temporaryRoot();
    for (const path of ['config/targets/example.json', 'local/other/x.json', 'local/targets/../x.json', 'local/targets/a/b.json']) {
      expect(isEditableTargetConfigPath(path), path).toBe(false);
      expect(await replaceTargetConfig(root, path, '', 'replaced\n'), path).toEqual({ ok: false, reason: 'TARGET_CONFIG_NOT_EDITABLE' });
    }
    expect(isEditableTargetConfigPath(PATH)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  it('stops without writing when local/targets is a junction', async () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    writeFileSync(join(outside, 'limits-test.json'), 'outside\n', 'utf8');
    mkdirSync(dirname(join(root, 'local/targets')), { recursive: true });
    symlinkSync(outside, join(root, 'local/targets'), 'junction');
    junctions.push(join(root, 'local/targets'));
    expect(await replaceTargetConfig(root, PATH, 'outside\n', 'replaced\n')).toEqual({ ok: false, reason: 'TARGET_CONFIG_LOCATION_UNSAFE' });
    expect(readFileSync(join(outside, 'limits-test.json'), 'utf8')).toBe('outside\n');
  });

  it('keeps the file and leaves no temporary file when the rename fails (through the test seam)', async () => {
    const root = temporaryRoot();
    const before = contentOf(PUBLIC_ORIGIN);
    writeCurrent(root, before);
    const failing = async (): Promise<void> => {
      throw Object.assign(new Error('rename failed'), { code: 'EPERM' });
    };
    expect(await replaceTargetConfig(root, PATH, before, 'replaced\n', failing)).toEqual({ ok: false, reason: 'TARGET_CONFIG_WRITE_FAILED' });
    expect(readFileSync(join(root, PATH), 'utf8')).toBe(before);
    expect(temporaryFilesIn(join(root, 'local/targets'))).toEqual([]);
  });
});

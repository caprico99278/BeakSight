/**
 * T43b（Task 43 の設計書 4.2）: 開始の URL から作る対象の設定のファイルの案（`src/config/target-config-draft.ts`）。
 * - 開始の URL の誤り（http・https だけ、userinfo なし、fragment なし、長さ）、許可 Origin の案と誤り、作るファイルを置くフォルダ（パスの組み立ては
 *   画面の `display/start-url-draft.ts`。`apps/local-ui/tests/start-url-draft.test.ts` が確かめる）。
 * - 作るファイルの中身は、`target.id`・`site`・負荷（`crawl`）・出力（`output`）。負荷と出力は既定値の部品（`DEFAULT_CONFIG`）から組み立て、
 *   `validateConfig` を通る。CLI の `loadConfig` で読むと、同じ値になる。
 * - 作成の入力のスキーマ（`ui-profile-create`）の上限と、この部品の上限が一致する。
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { loadConfig } from '../../src/config/load-config.js';
import {
  GENERATED_TARGET_CRAWL_LIMITS,
  MAX_GENERATED_ALLOWED_ORIGINS,
  TARGET_CONFIG_CREATION_FAILURES,
  TARGET_SITE_PROBLEMS,
  allowedOriginsProblemOf,
  effectiveConfigInputOf,
  isReservedTargetConfigName,
  isTargetConfigCreationFailure,
  startUrlOriginOf,
  startUrlPathOf,
  startUrlProblemOf,
  targetConfigDocumentOf,
  targetSiteProblemsOf,
} from '../../src/config/target-config-draft.js';
import { validateConfig } from '../../src/config/validate-config.js';
import { MAX_URL_LENGTH } from '../../src/core/limits.js';
import { isAcceptedTargetConfigPath } from '../../src/control/profile-policy.js';
import { validateControlDocument } from '../../src/control/control-schema-validator.js';
import { LOCAL_TARGET_CONFIG_DIRECTORY, TARGET_CONFIG_EXTENSION } from '../../src/control/target-config-locations.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('T43b: the start URL', () => {
  it('accepts an http(s) URL without userinfo and without a fragment', () => {
    expect(startUrlProblemOf('https://example.test/')).toBeNull();
    expect(startUrlProblemOf('http://127.0.0.1:8080/admin/?page=1')).toBeNull();
    // 前後の空白は除いて判定する（貼り付けの空白）。
    expect(startUrlProblemOf('  https://example.test/start  ')).toBeNull();
  });

  it('rejects an empty value, a value that is not an http(s) URL, userinfo, a fragment and a too long URL', () => {
    expect(startUrlProblemOf('')).toBe('START_URL_REQUIRED');
    expect(startUrlProblemOf('   ')).toBe('START_URL_REQUIRED');
    expect(startUrlProblemOf('example.test')).toBe('START_URL_INVALID');
    expect(startUrlProblemOf('ftp://example.test/')).toBe('START_URL_INVALID');
    expect(startUrlProblemOf('javascript:alert(1)')).toBe('START_URL_INVALID');
    expect(startUrlProblemOf('https://user:secret@example.test/')).toBe('START_URL_HAS_CREDENTIALS');
    expect(startUrlProblemOf('https://user@example.test/')).toBe('START_URL_HAS_CREDENTIALS');
    expect(startUrlProblemOf('https://example.test/#top')).toBe('START_URL_HAS_FRAGMENT');
    expect(startUrlProblemOf('https://example.test/#')).toBe('START_URL_HAS_FRAGMENT');
    expect(startUrlProblemOf(`https://example.test/${'a'.repeat(MAX_URL_LENGTH)}`)).toBe('START_URL_TOO_LONG');
  });

  it('gives the origin and the path of the start URL (nothing for a rejected URL)', () => {
    expect(startUrlOriginOf('https://Example.TEST:443/admin/list?x=1')).toBe('https://example.test');
    expect(startUrlOriginOf('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080');
    expect(startUrlOriginOf('ftp://example.test/')).toBeUndefined();
    expect(startUrlOriginOf('https://example.test/#x')).toBeUndefined();
    expect(startUrlPathOf('https://example.test/admin/list?x=1')).toBe('/admin/list');
    expect(startUrlPathOf('https://example.test')).toBe('/');
    expect(startUrlPathOf('not a url')).toBeUndefined();
  });
});

describe('T43b: the allowed origins', () => {
  it('accepts canonical http(s) origins that include the origin of the start URL', () => {
    expect(allowedOriginsProblemOf(['https://example.test'], 'https://example.test/admin/')).toBeNull();
    expect(allowedOriginsProblemOf(['https://cdn.example.test', 'https://example.test'], 'https://example.test/')).toBeNull();
  });

  it('rejects an empty list, a value that is not a canonical origin, too many origins and a list without the start origin', () => {
    expect(allowedOriginsProblemOf([], 'https://example.test/')).toBe('ALLOWED_ORIGINS_REQUIRED');
    expect(allowedOriginsProblemOf(['https://example.test/'], 'https://example.test/')).toBe('ALLOWED_ORIGIN_INVALID');
    expect(allowedOriginsProblemOf(['https://example.test/path'], 'https://example.test/')).toBe('ALLOWED_ORIGIN_INVALID');
    expect(allowedOriginsProblemOf(['ftp://example.test'], 'https://example.test/')).toBe('ALLOWED_ORIGIN_INVALID');
    expect(allowedOriginsProblemOf(['https://user@example.test'], 'https://example.test/')).toBe('ALLOWED_ORIGIN_INVALID');
    const tooMany = Array.from({ length: MAX_GENERATED_ALLOWED_ORIGINS + 1 }, (_, index) => `https://site${index}.example.test`);
    expect(allowedOriginsProblemOf(tooMany, 'https://site0.example.test/')).toBe('ALLOWED_ORIGINS_TOO_MANY');
    expect(allowedOriginsProblemOf(['https://other.example.test'], 'https://example.test/')).toBe('ALLOWED_ORIGINS_MISSING_START');
  });

  it('lists the problems of both fields (the start URL first), and nothing for a good pair', () => {
    expect(targetSiteProblemsOf({ startUrl: 'https://example.test/', allowedOrigins: ['https://example.test'] })).toEqual([]);
    expect(targetSiteProblemsOf({ startUrl: 'https://example.test/#x', allowedOrigins: [] }))
      .toEqual(['START_URL_HAS_FRAGMENT', 'ALLOWED_ORIGINS_REQUIRED']);
    expect(TARGET_SITE_PROBLEMS).toEqual(expect.arrayContaining(['START_URL_REQUIRED', 'ALLOWED_ORIGINS_MISSING_START']));
  });
});

describe('T43b: the generated target configuration file', () => {
  // T43b fix round 1: 置き場所の定数は `src/control/target-config-locations.ts` に 1 つにした（`target-config-locations.test.ts`）。
  it('is placed in local/targets/ as a .json file, a place accepted by the profile path rule', () => {
    expect(LOCAL_TARGET_CONFIG_DIRECTORY).toBe('local/targets/');
    expect(TARGET_CONFIG_EXTENSION).toBe('.json');
    expect(isAcceptedTargetConfigPath(`${LOCAL_TARGET_CONFIG_DIRECTORY}example-test${TARGET_CONFIG_EXTENSION}`)).toBe(true);
  });

  // T43b fix round 2（設計書 7 章の最後の行。設計者の既定）: 最初の読み込みのための控えめな負荷（最大 3 ページ、間隔 10 秒）。CLI の既定値は変えない。
  it('uses the modest first-load limits (3 pages, 10 seconds) and keeps the CLI defaults unchanged', () => {
    expect(GENERATED_TARGET_CRAWL_LIMITS).toEqual({ maxPages: 3, minNavigationIntervalMs: 10_000 });
    expect(Object.isFrozen(GENERATED_TARGET_CRAWL_LIMITS)).toBe(true);
    expect([DEFAULT_CONFIG.crawl.maxPages, DEFAULT_CONFIG.crawl.minNavigationIntervalMs]).toEqual([500, 5_000]);
  });

  it('holds the target id, the site, the first-load limits and the other load and output settings from the defaults, and passes validateConfig', () => {
    const document = targetConfigDocumentOf({
      targetId: 'example-test',
      startUrl: ' https://Example.test/admin/ ',
      allowedOrigins: ['https://example.test'],
    });
    expect(document).toEqual({
      target: { id: 'example-test' },
      site: { startUrl: 'https://example.test/admin/', allowedOrigins: ['https://example.test'] },
      crawl: { ...DEFAULT_CONFIG.crawl, maxPages: 3, minNavigationIntervalMs: 10_000 },
      output: DEFAULT_CONFIG.output,
    });
    // 既定値の部品と参照を共有しない（書き出す値を変えても、既定値は変わらない）。
    expect(document.crawl).not.toBe(DEFAULT_CONFIG.crawl);
    expect(document.output).not.toBe(DEFAULT_CONFIG.output);
    const validation = validateConfig(effectiveConfigInputOf(document));
    expect(validation.ok).toBe(true);
  });

  it('is read by the CLI loadConfig with the same values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'beaksight-t43b-'));
    temporaryDirectories.push(directory);
    const document = targetConfigDocumentOf({
      targetId: 'example-test',
      startUrl: 'https://example.test/',
      allowedOrigins: ['https://example.test', 'https://cdn.example.test'],
    });
    const path = join(directory, 'example-test.json');
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    const loaded = await loadConfig(path);
    const validation = validateConfig(effectiveConfigInputOf(document));
    expect(validation.ok && validation.value).toEqual(loaded);
    expect(loaded.target.id).toBe('example-test');
    expect(loaded.crawl).toEqual({ ...DEFAULT_CONFIG.crawl, ...GENERATED_TARGET_CRAWL_LIMITS });
    expect(loaded.output).toEqual(DEFAULT_CONFIG.output);
  });

  it('keeps the closed list of creation failures', () => {
    // T43R-fix-D（M-6）: Windows の予約名と、置き場所がリンク（reparse point）であることの理由を足した。
    expect(TARGET_CONFIG_CREATION_FAILURES).toEqual([
      'TARGET_SITE_INVALID',
      'TARGET_CONFIG_INVALID',
      'TARGET_CONFIG_NAME_RESERVED',
      'TARGET_CONFIG_EXISTS',
      'TARGET_CONFIG_LOCATION_UNSAFE',
      'TARGET_CONFIG_WRITE_FAILED',
    ]);
    expect(isTargetConfigCreationFailure('TARGET_CONFIG_EXISTS')).toBe(true);
    expect(isTargetConfigCreationFailure('PROFILE_INVALID')).toBe(false);
  });

  // CC-101（T43R-fix-D2）: 予約名の判定を、ブラウザも読むこの部品に置いた（一覧は `src/core/windows-reserved-names.ts`）。
  it('finds the Windows reserved names whatever the letter case', () => {
    for (const name of ['con', 'nul', 'aux', 'prn', 'com1', 'com9', 'lpt1', 'lpt9', 'CON', 'Nul', 'LpT3']) {
      expect(isReservedTargetConfigName(name), name).toBe(true);
    }
    for (const name of ['console', 'con1', 'com10', 'lpt', 'example-test', 'nul-site', 'a']) {
      expect(isReservedTargetConfigName(name), name).toBe(false);
    }
  });
});

describe('T43b: the create input schema', () => {
  const schema = JSON.parse(readFileSync('schemas/control/ui-profile-create.schema.json', 'utf8')) as {
    properties: { newTargetSite: { properties: { startUrl: { maxLength: number }; allowedOrigins: { maxItems: number; items: { maxLength: number } } } } };
  };

  it('has the same limits as the draft module', () => {
    const site = schema.properties.newTargetSite.properties;
    expect(site.startUrl.maxLength).toBe(MAX_URL_LENGTH);
    expect(site.allowedOrigins.maxItems).toBe(MAX_GENERATED_ALLOWED_ORIGINS);
    expect(site.allowedOrigins.items.maxLength).toBe(MAX_URL_LENGTH);
  });

  it('accepts the profile alone (the existing file) and the profile with a new target site, and nothing else', () => {
    const profile = { profileId: 'example-test' };
    expect(validateControlDocument('ui-profile-create', { profile }).ok).toBe(true);
    expect(validateControlDocument('ui-profile-create', {
      profile,
      newTargetSite: { startUrl: 'https://example.test/', allowedOrigins: ['https://example.test'] },
    }).ok).toBe(true);
    expect(validateControlDocument('ui-profile-create', { profile, newTargetSite: { startUrl: 'https://example.test/' } }).ok).toBe(false);
    expect(validateControlDocument('ui-profile-create', {
      profile,
      newTargetSite: { startUrl: 'https://example.test/', allowedOrigins: [], extra: true },
    }).ok).toBe(false);
    expect(validateControlDocument('ui-profile-create', { profile, other: 1 }).ok).toBe(false);
  });
});

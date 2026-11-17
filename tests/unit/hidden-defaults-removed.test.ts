// L14（設計書 `doc/design/2026-11-09-beaksight-remove-limits-design.md` 5 の 2・3、6 の L14）: 隠れた既定の値と設定の整理。
// - CLI（設定ファイル）の送信の扱いの既定は `PASS_EXCEPT_DELETE`。項目のない記録の読み方は `READ_ONLY` のまま。
// - query は、既定（残す名前を選んでいない）では残す。追跡用の名前・秘密に見える名前・fragment は捨てる。
// - 幅の走査の幅に、CSS の media query の境目の両側の幅を足す（境目の読み取りの純粋な部分）。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { loadConfig } from '../../src/config/load-config.js';
import { AUDIT_SEND_PASS_EXCEPT_DELETE, AUDIT_SEND_READ_ONLY, auditSendPolicyOf } from '../../src/core/audit-send-policy.js';
import { effectiveConfigInputOf, startUrlProblemOf, targetConfigDocumentOf } from '../../src/config/target-config-draft.js';
import { validateConfig } from '../../src/config/validate-config.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { breakpointSideWidthsOf } from '../../src/evidence/media-query-widths.js';
import { CrawlFrontier } from '../../src/orchestration/crawl-frontier.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { createRunCheckpoint, type RunCheckpoint } from '../../src/orchestration/run-checkpoint.js';
import { sampleRunCheckpoint } from '../helpers/run-checkpoint-samples.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

const writeTargetConfig = async (contents: unknown): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'beaksight-l14-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'target.json');
  await writeFile(path, JSON.stringify(contents), 'utf8');
  return path;
};

const MINIMAL_TARGET = {
  target: { id: 'l14-target' },
  site: { startUrl: 'http://127.0.0.1:4173/', allowedOrigins: ['http://127.0.0.1:4173'] },
};

describe('L14: the send policy of the configuration file (CLI)', () => {
  it('defaults to PASS_EXCEPT_DELETE', async () => {
    expect(DEFAULT_CONFIG.audit.sendPolicy).toBe(AUDIT_SEND_PASS_EXCEPT_DELETE);
    const config = await loadConfig(await writeTargetConfig(MINIMAL_TARGET));
    expect(config.audit.sendPolicy).toBe(AUDIT_SEND_PASS_EXCEPT_DELETE);
  });

  it('keeps READ_ONLY when the file chooses it, and still reads a record without the item as READ_ONLY', async () => {
    const config = await loadConfig(await writeTargetConfig({
      ...MINIMAL_TARGET,
      audit: { performance: true, accessibility: true, interactions: true, screenshots: true, sendPolicy: AUDIT_SEND_READ_ONLY },
    }));
    expect(config.audit.sendPolicy).toBe(AUDIT_SEND_READ_ONLY);
    expect(auditSendPolicyOf({ audit: {} })).toBe(AUDIT_SEND_READ_ONLY);
  });
});

describe('L14: the query of a URL when no names are chosen', () => {
  const NONE: ReadonlySet<string> = new Set<string>();

  it('keeps every query name in code-unit order, and drops tracking names and the fragment', () => {
    expect(normalizeUrl('/list?z=9&utm_source=x&a=1&fbclid=f&a=2&gclid=g&page=3#top', 'https://example.test/', NONE)).toEqual({
      ok: true,
      url: 'https://example.test/list?a=1&a=2&page=3&z=9',
    });
  });

  it('drops secret-like names, so a token in a link is not written to the records', () => {
    expect(normalizeUrl('/next?token=abc&page=2&session=s', 'https://example.test/', NONE)).toEqual({
      ok: true,
      url: 'https://example.test/next?page=2',
    });
  });

  it('reads an empty list in the file (the old default) the same as no list, so the query is kept', async () => {
    const withEmpty = await loadConfig(await writeTargetConfig({ ...MINIMAL_TARGET, crawl: { allowedQueryParameters: [] } }));
    const withoutList = await loadConfig(await writeTargetConfig(MINIMAL_TARGET));
    expect(withEmpty.crawl).toEqual(withoutList.crawl);
    expect(normalizeUrl('/list?page=2', 'https://example.test/', new Set(withEmpty.crawl.allowedQueryParameters))).toEqual({
      ok: true,
      url: 'https://example.test/list?page=2',
    });
  });

  it('keeps only the chosen names when the user chose some', () => {
    expect(normalizeUrl('/list?z=9&a=1&page=3', 'https://example.test/', new Set(['page']))).toEqual({
      ok: true,
      url: 'https://example.test/list?page=3',
    });
  });
});

/** L14: 隠れた既定の値（型で任意にし、`DEFAULT_CONFIG` から外したもの。前の段の 6 つと、後の段のページ数・Run の時間）。 */
const HIDDEN_CRAWL_KEYS = [
  'maxPages',
  'maxRuntimeMs',
  'navigationTimeoutMs',
  'overallPageTimeoutMs',
  'resourceSettlingTimeoutMs',
  'interactionTimeoutMs',
  'maxDepth',
  'maxInteractionsPerPage',
] as const;

/** 画面で作った前のプロファイルのファイルの `crawl`（`DEFAULT_CONFIG.crawl` を丸ごと書き、ページの上限 3・間隔 10 秒を重ねたもの）。 */
const OLD_GENERATED_CRAWL = {
  maxPages: 3,
  maxDepth: 20,
  maxRuntimeMs: 3_600_000,
  navigationTimeoutMs: 30_000,
  overallPageTimeoutMs: 60_000,
  resourceSettlingTimeoutMs: 5_000,
  interactionTimeoutMs: 3_000,
  minNavigationIntervalMs: 10_000,
  maxInteractionsPerPage: 20,
  allowedQueryParameters: [],
};

describe('L14: no hidden limit or time limit in the default configuration', () => {
  it('does not have the hidden limits and time limits', () => {
    for (const key of HIDDEN_CRAWL_KEYS) {
      expect(Object.hasOwn(DEFAULT_CONFIG.crawl, key), key).toBe(false);
    }
  });

  it('reads an old profile whose values equal the old defaults as no limit, and keeps the navigation interval', async () => {
    const config = await loadConfig(await writeTargetConfig({ ...MINIMAL_TARGET, crawl: OLD_GENERATED_CRAWL }));
    for (const key of HIDDEN_CRAWL_KEYS) {
      expect(config.crawl[key], key).toBeUndefined();
    }
    expect(config.crawl.minNavigationIntervalMs).toBe(10_000);
    expect(config.crawl.allowedQueryParameters).toEqual([]);
  });

  it('reads the old default of the configuration file (500 pages, 1 hour) as no limit', async () => {
    const config = await loadConfig(await writeTargetConfig({ ...MINIMAL_TARGET, crawl: { maxPages: 500, maxRuntimeMs: 3_600_000 } }));
    expect(config.crawl.maxPages).toBeUndefined();
    expect(config.crawl.maxRuntimeMs).toBeUndefined();
  });

  it('applies the values that the user chose', async () => {
    const config = await loadConfig(await writeTargetConfig({
      ...MINIMAL_TARGET,
      crawl: {
        ...OLD_GENERATED_CRAWL,
        maxPages: 12,
        maxRuntimeMs: 600_000,
        maxDepth: 7,
        navigationTimeoutMs: 45_000,
        maxInteractionsPerPage: 5,
        interactionTimeoutMs: 4_000,
      },
    }));
    expect(config.crawl.maxPages).toBe(12);
    expect(config.crawl.maxRuntimeMs).toBe(600_000);
    expect(config.crawl.maxDepth).toBe(7);
    expect(config.crawl.navigationTimeoutMs).toBe(45_000);
    expect(config.crawl.maxInteractionsPerPage).toBe(5);
    expect(config.crawl.interactionTimeoutMs).toBe(4_000);
    expect(config.crawl.overallPageTimeoutMs).toBeUndefined();
  });

  it('does not write the hidden defaults into a profile made on the screen', () => {
    const document = targetConfigDocumentOf({
      targetId: 'made-on-screen',
      startUrl: 'https://example.test/',
      allowedOrigins: ['https://example.test'],
    });
    for (const key of [...HIDDEN_CRAWL_KEYS, 'allowedQueryParameters']) {
      expect(Object.hasOwn(document.crawl, key), key).toBe(false);
    }
    expect(validateConfig(effectiveConfigInputOf(document)).ok).toBe(true);
  });

  it('keeps a run record without the hidden values valid', async () => {
    const checkpoint = sampleRunCheckpoint();
    const crawl: Record<string, unknown> = { ...checkpoint.effectiveConfig.crawl };
    for (const key of HIDDEN_CRAWL_KEYS) {
      delete crawl[key];
    }
    const effectiveConfig = { ...checkpoint.effectiveConfig, crawl } as unknown as RunCheckpoint['effectiveConfig'];
    expect(await validateArtifact('checkpoint', createRunCheckpoint({ ...checkpoint, effectiveConfig }))).toEqual({ ok: true });
  });

  it('does not skip a deep page when the depth is not chosen', () => {
    const frontier = new CrawlFrontier(undefined, new IdAllocator());
    expect(frontier.discover('https://example.test/deep' as NormalizedHttpUrlEvidence, 1_000)).toBe('QUEUED');
  });
});

describe('L14: N23 the length of a URL', () => {
  it('accepts a URL longer than the old limit of 2,048', () => {
    const long = `https://example.test/${'a'.repeat(3_000)}`;
    expect(normalizeUrl(long, long, new Set())).toEqual({ ok: true, url: long });
    expect(startUrlProblemOf(long)).toBeNull();
  });
});

describe('L14: the widths on both sides of a media query boundary', () => {
  it('reads min-width and max-width in px, em and rem, and the range syntax', () => {
    expect(breakpointSideWidthsOf([
      'screen and (min-width: 600px)',
      '(max-width: 767.98px)',
      '(min-width: 40em) and (max-width: 60rem)',
      '(width >= 1200px)',
      '(400px < width)',
    ])).toEqual([400, 401, 599, 600, 639, 640, 767, 768, 960, 961, 1199, 1200]);
  });

  it('ignores conditions that do not depend on the width, and values it cannot read', () => {
    expect(breakpointSideWidthsOf(['print', '(orientation: landscape)', '(min-height: 500px)', '(min-width: 30vw)', '(min-width: 0px)', 'not a query'])).toEqual([]);
  });
});

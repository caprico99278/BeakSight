// 環境の確かめ（Task 23 の設計書 4.5、7 章の「環境の確かめ」。T23a）。
// - Node の版の比較は、版の文字列を関数に渡して確かめる（古い Node を入れない）。
// - `node:sqlite` がない状態は、`tests/integration/control-environment-no-sqlite.test.ts` で子 process を使って確かめる。
// - 下限の版は `package.json` の `engines` と一致する（二重定義の検出。`package.json` は読むだけ）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_ENVIRONMENT_FAILURE_REASONS,
  MIN_CONTROL_NODE_VERSION,
  checkControlEnvironment,
  evaluateControlEnvironment,
  isNodeVersionAtLeast,
} from '../../src/control/environment/control-environment.js';

const PACKAGE_JSON_URL = new URL('../../package.json', import.meta.url);

/** `engines.node` の下限（`>=X.Y.Z` の `X.Y.Z`）。 */
const ENGINES_LOWER_BOUND_PATTERN = /(?:^|\s)>=\s*v?(\d+(?:\.\d+){0,2})(?=\s|$)/u;

describe('Control environment: Node version comparison', () => {
  it('accepts the lower bound and newer versions, with or without the leading v', () => {
    for (const version of ['24.15.0', 'v24.15.0', '24.15.1', '24.21.0', '24.100.0']) {
      expect(isNodeVersionAtLeast(version, MIN_CONTROL_NODE_VERSION), version).toBe(true);
    }
  });

  it('rejects older versions', () => {
    for (const version of ['24.14.1', '24.0.0', 'v22.22.0', '20.19.5', '24.9.9']) {
      expect(isNodeVersionAtLeast(version, MIN_CONTROL_NODE_VERSION), version).toBe(false);
    }
  });

  it('rejects version strings that are not X.Y.Z (fail-closed)', () => {
    for (const version of ['', '24', '24.15', 'abc', '24.15.x', ' 24.15.0', '24.15.0.1']) {
      expect(isNodeVersionAtLeast(version, MIN_CONTROL_NODE_VERSION), JSON.stringify(version)).toBe(false);
    }
  });

  it('compares each part as a number, not as text', () => {
    expect(isNodeVersionAtLeast('24.100.0', '24.15.0')).toBe(true);
    expect(isNodeVersionAtLeast('24.2.0', '24.15.0')).toBe(false);
  });
});

describe('Control environment: evaluation', () => {
  it('has a closed, frozen list of failure reasons', () => {
    expect(CONTROL_ENVIRONMENT_FAILURE_REASONS).toEqual(['NODE_VERSION_UNSUPPORTED', 'NODE_SQLITE_UNAVAILABLE']);
    expect(Object.isFrozen(CONTROL_ENVIRONMENT_FAILURE_REASONS)).toBe(true);
  });

  it('passes when the version is supported and node:sqlite is available', () => {
    expect(evaluateControlEnvironment({ nodeVersion: '24.15.0', sqliteAvailable: true })).toEqual({ ok: true, nodeVersion: '24.15.0' });
  });

  it('stops with NODE_VERSION_UNSUPPORTED when Node is older than the lower bound', () => {
    expect(evaluateControlEnvironment({ nodeVersion: '24.14.1', sqliteAvailable: true })).toEqual({
      ok: false,
      nodeVersion: '24.14.1',
      reason: 'NODE_VERSION_UNSUPPORTED',
    });
    // 版が足りないときは、SQLite の有無より先に版を伝える（Node を更新すれば両方が直る）。
    expect(evaluateControlEnvironment({ nodeVersion: '22.22.0', sqliteAvailable: false })).toEqual({
      ok: false,
      nodeVersion: '22.22.0',
      reason: 'NODE_VERSION_UNSUPPORTED',
    });
  });

  it('stops with NODE_SQLITE_UNAVAILABLE when node:sqlite cannot be loaded', () => {
    expect(evaluateControlEnvironment({ nodeVersion: '24.15.0', sqliteAvailable: false })).toEqual({
      ok: false,
      nodeVersion: '24.15.0',
      reason: 'NODE_SQLITE_UNAVAILABLE',
    });
  });

  it('passes in the current Node process (24.15.0 or later, with node:sqlite)', () => {
    expect(checkControlEnvironment()).toEqual({ ok: true, nodeVersion: process.versions.node });
  });

  it('returns a frozen result', () => {
    expect(Object.isFrozen(checkControlEnvironment())).toBe(true);
    expect(Object.isFrozen(evaluateControlEnvironment({ nodeVersion: '1.0.0', sqliteAvailable: false }))).toBe(true);
  });
});

describe('Control environment: the lower bound is defined once', () => {
  // T23b が `engines` を `>=24.15.0 <25` に変える。それより前は、この確かめが失敗する（二重定義の不一致の検出）。
  it('MIN_CONTROL_NODE_VERSION equals the lower bound of package.json engines.node', () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON_URL, 'utf8')) as { engines?: { node?: unknown } };
    const range = manifest.engines?.node;
    expect(typeof range).toBe('string');
    const lowerBound = ENGINES_LOWER_BOUND_PATTERN.exec(String(range))?.[1];
    expect(lowerBound).toBe(MIN_CONTROL_NODE_VERSION);
  });
});

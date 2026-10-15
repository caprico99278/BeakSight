// CCX-11（CC-063、CC-059、CC-062、CC-058）: core などの 1 か所にまとめた小さな部品の結果を固定する。まとめる前の部品（`auto-login-limits.ts`
// の読み戻し、`worker-protocol.ts` の SHA-256、`artifact-writer.ts` と `credential-store.ts` の rename のやり直しの定数、`--headless` と
// ワーカーの上書き）で同じ表を PASS させてから、まとめた後の部品に切り替えた（値は 1 つも変えていない）。
// - 14 桁の UTC の時刻の読み戻し（厳しい読み戻し。形が 14 桁の数字でない値と、ありえない日時は読み戻さない）。
// - ファイルの内容の SHA-256（ターゲット JSON と、認証の設定の要約）。
// - rename のやり直しの決まり（失敗のコード、回数、待ち）と、誤りのコードの取り出し。
// - `--headless` に当たる設定の上書き。
import { describe, expect, it } from 'vitest';
import { parseCliArguments } from '../../src/cli/arguments.js';
import { HEADLESS_CONFIG_OVERRIDES } from '../../src/config/config-overrides.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { dateOfCompactUtcTimestamp as dateOfCompactUtcTimestampForAutoLogin } from '../../src/control/job/auto-login-limits.js';
import { targetConfigDigestOf, workerAuthenticationDigestOf } from '../../src/control/worker-protocol.js';
import { errorCodeOf } from '../../src/core/errors.js';
import { createSha256Fingerprint, createSha256FingerprintOfBytes, sha256HexOfBytes, sha256HexOfText } from '../../src/core/ids.js';
import { RENAME_MAX_ATTEMPTS, RENAME_RETRY_DELAY_MS, RENAME_RETRY_ERROR_CODES, renameWithRetry } from '../../src/core/rename-retry.js';
import { dateOfCompactUtcTimestamp, formatCompactUtcTimestamp, parseCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { WORKER_CONFIG_OVERRIDES } from '../../src/worker/audit-worker-session.js';

/** 読み戻せる 14 桁と、その時刻（ISO 8601）。 */
const READABLE_TIMESTAMPS: readonly (readonly [string, string])[] = [
  ['20261010120000', '2026-10-10T12:00:00.000Z'],
  ['10000101000000', '1000-01-01T00:00:00.000Z'],
  ['99991231235959', '9999-12-31T23:59:59.000Z'],
  ['20240229235959', '2024-02-29T23:59:59.000Z'],
  ['20261231000000', '2026-12-31T00:00:00.000Z'],
];

/** 読み戻さない値（形が違う、またはありえない日時）。 */
const UNREADABLE_TIMESTAMPS: readonly string[] = [
  '',
  '2026101012000',
  '202610101200000',
  '2026a010120000',
  '２０２６１０１０１２００００',
  ' 20261010120000',
  '2026-10-10T12:00:00Z',
  '20260230120000',
  '20250229000000',
  '20260431000000',
  '20261301000000',
  '20261000000000',
  '20261010250000',
  '20261010240000',
  '20261010126000',
  '20261010120060',
  '09991231235959',
  '00000101000000',
  '00500101000000',
];

describe('CC-063: reading a compact UTC timestamp back', () => {
  it.each(READABLE_TIMESTAMPS)('reads %s back as %s', (compact, iso) => {
    expect(dateOfCompactUtcTimestamp(compact).toISOString()).toBe(iso);
    expect(parseCompactUtcTimestamp(compact)?.toISOString()).toBe(iso);
    expect(formatCompactUtcTimestamp(dateOfCompactUtcTimestamp(compact), 'test')).toBe(compact);
  });

  it.each(UNREADABLE_TIMESTAMPS)('rejects %j with a RangeError, or null', (value) => {
    expect(() => dateOfCompactUtcTimestamp(value)).toThrow(RangeError);
    expect(parseCompactUtcTimestamp(value)).toBeNull();
  });

  it('returns null for values that are not strings', () => {
    for (const value of [null, undefined, 20261010120000, new Date(0), ['20261010120000']]) {
      expect(parseCompactUtcTimestamp(value)).toBeNull();
    }
  });

  it('keeps the RangeError messages for a wrong shape and an impossible date', () => {
    expect(() => dateOfCompactUtcTimestamp('2026-10-10')).toThrow(new RangeError('the timestamp must be 14 ASCII digits of a UTC time'));
    expect(() => dateOfCompactUtcTimestamp('20260230120000')).toThrow(new RangeError('the timestamp is not a real UTC time'));
  });

  it('is the same function that the auto login limits publish (the managed data reads it from there)', () => {
    expect(dateOfCompactUtcTimestampForAutoLogin).toBe(dateOfCompactUtcTimestamp);
  });
});

describe('CC-059: SHA-256 of the target JSON and of the authentication settings', () => {
  it('keeps the lowercase hex SHA-256 of the bytes', () => {
    expect(targetConfigDigestOf(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(targetConfigDigestOf(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // view の範囲だけを使う（下にある ArrayBuffer の全体ではない）。
    const backing = new TextEncoder().encode('xabcx');
    expect(targetConfigDigestOf(backing.subarray(1, 4))).toBe(targetConfigDigestOf(new TextEncoder().encode('abc')));
    expect(sha256HexOfBytes(backing.subarray(1, 4))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('keeps the SHA-256 of the authentication settings (sorted keys, UTF-8)', () => {
    const setup = { version: 1, b: 'ü', a: [2, 1] } as unknown as AuthSetup;
    expect(workerAuthenticationDigestOf(setup, ['https://a.test'], { jobKind: 'AUDIT', automatedLogin: null }))
      .toBe('59efec58872371dda12add4f2113c04de10d97cf76a7025ee6d7831bd49f67d4');
    expect(sha256HexOfText('ü')).toBe(sha256HexOfBytes(new TextEncoder().encode('ü')));
  });

  it('keeps the sha256: fingerprints', () => {
    expect(createSha256Fingerprint('')).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(createSha256Fingerprint('ü')).toBe(createSha256FingerprintOfBytes(new TextEncoder().encode('ü')));
    expect(createSha256FingerprintOfBytes(new TextEncoder().encode('abc')))
      .toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

/** `codes` の順に失敗し、その後は成功する rename と、待ちの記録。 */
const flakyRename = (codes: readonly (string | null)[]): {
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly wait: (delayMs: number) => Promise<void>;
  readonly attempts: () => number;
  readonly waits: readonly number[];
} => {
  let attempts = 0;
  const waits: number[] = [];
  return {
    rename: async () => {
      const code = codes[attempts];
      attempts += 1;
      if (code !== undefined) {
        throw code === null ? new Error('no code') : Object.assign(new Error(code), { code });
      }
    },
    wait: async (delayMs) => {
      waits.push(delayMs);
    },
    attempts: () => attempts,
    waits,
  };
};

describe('CC-062: the rename retry rule and the error code', () => {
  it('keeps the same codes, attempts and wait for the artifacts and the credentials', () => {
    expect([...RENAME_RETRY_ERROR_CODES]).toEqual(['EPERM', 'EBUSY', 'EACCES']);
    expect(Object.isFrozen(RENAME_RETRY_ERROR_CODES)).toBe(true);
    expect(RENAME_MAX_ATTEMPTS).toBe(5);
    expect(RENAME_RETRY_DELAY_MS).toBe(100);
  });

  it.each([...RENAME_RETRY_ERROR_CODES])('retries %s, waiting before each retry, and succeeds on the last attempt', async (code) => {
    const flaky = flakyRename(Array.from({ length: RENAME_MAX_ATTEMPTS - 1 }, () => code));
    await expect(renameWithRetry(flaky.rename, flaky.wait, 'a.tmp', 'a')).resolves.toBeUndefined();
    expect(flaky.attempts()).toBe(RENAME_MAX_ATTEMPTS);
    expect(flaky.waits).toEqual([100, 100, 100, 100]);
  });

  it('throws the last error after RENAME_MAX_ATTEMPTS failures', async () => {
    const flaky = flakyRename(['EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EACCES', 'EPERM']);
    await expect(renameWithRetry(flaky.rename, flaky.wait, 'a.tmp', 'a')).rejects.toMatchObject({ code: 'EACCES' });
    expect(flaky.attempts()).toBe(5);
    expect(flaky.waits).toEqual([100, 100, 100, 100]);
  });

  it.each([['ENOENT'], ['EEXIST'], [null]])('does not retry another failure (%s)', async (code) => {
    const flaky = flakyRename([code]);
    await expect(renameWithRetry(flaky.rename, flaky.wait, 'a.tmp', 'a')).rejects.toThrow();
    expect(flaky.attempts()).toBe(1);
    expect(flaky.waits).toEqual([]);
  });

  it('does not wait or retry when the first rename succeeds', async () => {
    const flaky = flakyRename([]);
    await renameWithRetry(flaky.rename, flaky.wait, 'a.tmp', 'a');
    expect(flaky.attempts()).toBe(1);
    expect(flaky.waits).toEqual([]);
  });

  it.each([
    ['an Error with a string code', Object.assign(new Error('x'), { code: 'ENOENT' }), 'ENOENT'],
    ['a plain object with a string code', { code: 'EBUSY' }, 'EBUSY'],
    ['an empty string code', { code: '' }, ''],
    ['a numeric code', { code: 13 }, null],
    ['an Error without a code', new Error('x'), null],
    ['null', null, null],
    ['undefined', undefined, null],
    ['a string', 'ENOENT', null],
    ['a number', 13, null],
    ['an array with a code (as the isRecord-based readers did)', Object.assign([], { code: 'ENOENT' }), null],
  ] as const)('reads the code of %s', (_name, error, expected) => {
    expect(errorCodeOf(error)).toBe(expected);
  });
});

describe('CC-058: the override that matches --headless', () => {
  it('keeps the CLI --headless override and the worker override the same value', () => {
    const invocation = parseCliArguments(['run', '--headless']);
    expect(invocation.kind === 'command' ? invocation.overrides : null).toEqual({ browser: { headed: false } });
    expect(WORKER_CONFIG_OVERRIDES).toEqual({ browser: { headed: false } });
    expect(Object.isFrozen(WORKER_CONFIG_OVERRIDES)).toBe(true);
  });

  it('uses the one constant of the config owner on both sides', () => {
    expect(HEADLESS_CONFIG_OVERRIDES).toEqual({ browser: { headed: false } });
    expect(WORKER_CONFIG_OVERRIDES).toBe(HEADLESS_CONFIG_OVERRIDES);
    const invocation = parseCliArguments(['run', '--headless']);
    expect(invocation.kind === 'command' ? invocation.overrides.browser : null).toBe(HEADLESS_CONFIG_OVERRIDES.browser);
    expect(Object.isFrozen(HEADLESS_CONFIG_OVERRIDES.browser)).toBe(true);
  });
});

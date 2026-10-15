// T32f（Task 32 の設計書 4.1 の「決定論の ZIP」、6 章の共通部品）: 決定論の ZIP の共通の部品（`src/core/deterministic-zip.ts`。T32R2 M-2 で `src/report/` から移した）。監査のバンドル
// （`chatgpt-bundle.ts`）と書き込みのバンドル（`action-bundle.ts`）が使う。
// - 項目は渡した順に並べ、各項目の時刻を固定の値にする（時計と時間帯によらず、同じ入力から同じバイト列）。
// - 目録の 1 件（パス、バイト数、sha256）は、項目の中身から求める。
// - 同じパスを 2 回渡すと `RangeError`（後の項目で前の項目を黙って置き換えない）。
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deterministicZipOf, zipFileRecordsOf, type ZipEntry } from '../../src/core/deterministic-zip.js';

const encoder = new TextEncoder();
const entries: readonly ZipEntry[] = [
  { path: 'manifest.json', bytes: encoder.encode('{"a":1}\n') },
  { path: 'b/second.txt', bytes: encoder.encode('二番目') },
  { path: 'a-first.json', bytes: encoder.encode('{}') },
];

afterEach(() => {
  vi.useRealTimers();
});

describe('deterministic ZIP (T32f)', () => {
  it('keeps the given order of the entries and their bytes', () => {
    const unzipped = unzipSync(deterministicZipOf(entries));
    expect(Object.keys(unzipped)).toEqual(['manifest.json', 'b/second.txt', 'a-first.json']);
    for (const entry of entries) {
      expect(unzipped[entry.path]).toEqual(entry.bytes);
    }
  });

  it('makes the same bytes from the same input, whatever the clock and the time zone are', () => {
    const originalTimeZone = process.env.TZ;
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      process.env.TZ = 'UTC';
      vi.setSystemTime(new Date('2031-05-06T07:08:10.000Z'));
      const first = deterministicZipOf(entries);
      process.env.TZ = 'Asia/Tokyo';
      vi.setSystemTime(new Date('2044-11-12T13:14:16.000Z'));
      expect(deterministicZipOf(entries)).toEqual(first);
    } finally {
      if (originalTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTimeZone;
      }
    }
  });

  it('lists each entry with its byte length and SHA-256 in the given order', () => {
    expect(zipFileRecordsOf(entries)).toEqual(entries.map(({ path, bytes }) => ({
      path,
      byteLength: bytes.byteLength,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    })));
  });

  it('rejects a path given twice instead of replacing the earlier entry', () => {
    expect(() => deterministicZipOf([...entries, { path: 'manifest.json', bytes: encoder.encode('x') }])).toThrow(RangeError);
  });
});

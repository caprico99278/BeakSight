// AUD-1d（設計者の判断 2026-11-09 の案 3。ユーザーの方針「BeakSight の都合で落とせないファイルを作らない」）: ChatGPT 用バンドルの部は、画面のサーバが
// 大きさの上限を当てずに、読みながら送る（`streamContainedArtifactFile`）。確かめ（root の中・リンクでない・ファイル・開いたものが同じ）は、上限つきの読み取りと同じ。
// 大きいファイルは、ディスクに作らず、テストの中のファイルシステムの代わりが、読まれたぶんだけ作る（メモリに全部載せないことを、読みの回数で確かめる）。
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTAINED_ARTIFACT_FILE_MAX_BYTES,
  readContainedArtifactFile,
  streamContainedArtifactFile,
  type ContainedArtifactFileSystem,
} from '../../src/core/contained-artifact-file.js';

const ROOT = resolve(tmpdir(), 'beaksight-fake-run-directory');
const BUNDLE = 'beaksight-audit-bundle_20261109010203_part2.zip';
/** 画面の読み取りの上限（256MiB）を超える大きさ。 */
const HUGE_SIZE = DEFAULT_CONTAINED_ARTIFACT_FILE_MAX_BYTES + 44 * 1024 * 1024;
/** 1 回に読む量の上限（部品の `READ_CHUNK_BYTES` と同じ 64KiB）。 */
const CHUNK = 64 * 1024;

type Kind = 'dir' | 'file' | 'link';
const statsOf = (kind: Kind, size: number, ino: bigint): BigIntStats =>
  ({
    isSymbolicLink: () => kind === 'link',
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
    size: BigInt(size),
    dev: 1n,
    ino,
  }) as unknown as BigIntStats;

/** Run のディレクトリと 1 つの大きいファイルを持つ、ファイルシステムの代わり。中身は読まれたぶんだけ作る。 */
function fakeFileSystem(options: { readonly kind?: Kind; readonly size?: number } = {}) {
  const kind = options.kind ?? 'file';
  const size = options.size ?? HUGE_SIZE;
  const filePath = join(ROOT, BUNDLE);
  const state = { reads: 0, maxReadLength: 0, delivered: 0, closed: false };
  let position = 0;
  const handle = {
    stat: async () => statsOf('file', size, 2n),
    read: async (buffer: Buffer, offset: number, length: number) => {
      state.reads += 1;
      state.maxReadLength = Math.max(state.maxReadLength, length);
      const count = Math.min(length, size - position);
      buffer.fill(7, offset, offset + count);
      position += count;
      return { bytesRead: count, buffer };
    },
    close: async () => {
      state.closed = true;
    },
  } as unknown as FileHandle;
  const fileSystem: ContainedArtifactFileSystem = {
    lstat: async (path) => (path === filePath ? statsOf(kind, size, 2n) : statsOf('dir', 0, 1n)),
    stat: async (path) => (path === filePath ? statsOf(kind, size, 2n) : statsOf('dir', 0, 1n)),
    realpath: async (path) => path,
    open: async () => handle,
  };
  return { fileSystem, state };
}

describe('AUD-1d: sending a bundle part over the reading limit, without holding it in memory', () => {
  it('streams a part larger than 256 MiB in chunks of 64 KiB, pulled one by one, and closes the file at the end', async () => {
    const { fileSystem, state } = fakeFileSystem();
    // 上限つきの読み取り（ほかの成果物）は、今のまま TOO_LARGE。
    await expect(readContainedArtifactFile(ROOT, BUNDLE, { fileSystem })).resolves.toEqual({ ok: false, reason: 'TOO_LARGE' });

    const streaming = await streamContainedArtifactFile(ROOT, BUNDLE, { fileSystem });
    expect(streaming.ok).toBe(true);
    if (!streaming.ok) {
      return;
    }
    expect(streaming.size).toBe(HUGE_SIZE);
    // 画面のサーバと同じく、応答の本文にして読む。
    const reader = new Response(streaming.stream).body?.getReader();
    expect(reader).toBeDefined();
    let received = 0;
    let chunks = 0;
    for (;;) {
      const { done, value } = await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
      if (done) {
        break;
      }
      received += value.byteLength;
      chunks += 1;
      // 読み手が取ったぶんしか先に読まない（全部をメモリに載せない）。先に読んでよいのは、流れの待ちの数のぶんだけ。
      expect(state.reads - chunks, `after chunk ${chunks}`).toBeLessThanOrEqual(2);
    }
    expect(received).toBe(HUGE_SIZE);
    expect(state.maxReadLength).toBeLessThanOrEqual(CHUNK);
    expect(state.closed).toBe(true);
  });

  it('closes the file when the receiver stops in the middle', async () => {
    const { fileSystem, state } = fakeFileSystem();
    const streaming = await streamContainedArtifactFile(ROOT, BUNDLE, { fileSystem });
    if (!streaming.ok) {
      throw new Error('not streamed');
    }
    const reader = streaming.stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(state.closed).toBe(true);
    expect(state.reads).toBeLessThan(10);
  });

  it('keeps the same checks: a link is refused before opening', async () => {
    const { fileSystem } = fakeFileSystem({ kind: 'link' });
    await expect(streamContainedArtifactFile(ROOT, BUNDLE, { fileSystem })).resolves.toEqual({ ok: false, reason: 'LINK' });
    await expect(streamContainedArtifactFile(ROOT, '../outside.zip', { fileSystem })).resolves.toEqual({ ok: false, reason: 'UNSAFE_PATH' });
  });
});

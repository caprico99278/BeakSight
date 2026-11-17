// MEM-4（DEF-266。設計書 `2026-11-13-beaksight-run-memory-scaling-design.md` 3 章の MEM-4）: 画面のサーバが配ってよいページの成果物は、`audit.json` を丸ごと
// 読まずに、そのページの `page.json` から見分ける（`audit.json` が読み取りの上限より大きい Run でも、ページのファイルとスクリーンショットを配れる）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isRunPageArtifactReference } from '../../src/core/run-page-artifact-references.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const PAGE = 'PAGE-000001';
const SHOT = `pages/${PAGE}/desktop/viewport.png`;

/** 合成の小さな Run のディレクトリ（ページ 1 つ。`audit` は audit.json の中身で、`null` は置かない）。 */
function runDirectoryWith(audit: string | null): string {
  const runDirectory = mkdtempSync(join(tmpdir(), 'beaksight-run-page-references-'));
  directories.push(runDirectory);
  if (audit !== null) {
    writeFileSync(join(runDirectory, 'audit.json'), audit);
  }
  mkdirSync(join(runDirectory, 'pages', PAGE), { recursive: true });
  const page = { pageId: PAGE, evidence: [{ type: 'screenshot', payload: { relativePath: SHOT } }, { type: 'dom', payload: { relativePath: 'checkpoint/x.png' } }] };
  writeFileSync(join(runDirectory, 'pages', PAGE, 'page.json'), JSON.stringify(page));
  return runDirectory;
}

describe('MEM-4: the page artifacts the UI server may serve are found from page.json, not from the whole audit.json', () => {
  it('finds the page files and the screenshots without reading audit.json (one that cannot be read as a whole)', async () => {
    // 読み取りの上限を超える audit.json の代わりに、JSON として読めない audit.json を置く（読まなければ、参照を集められる）。
    const runDirectory = runDirectoryWith('{"pages": [ not read as a whole');

    expect(await isRunPageArtifactReference(runDirectory, `pages/${PAGE}/page.json`)).toBe(true);
    expect(await isRunPageArtifactReference(runDirectory, `pages/${PAGE}/visible-text.txt`)).toBe(true);
    expect(await isRunPageArtifactReference(runDirectory, SHOT)).toBe(true);
    // 参照のないもの・ほかのページ・ほかの場所は、今どおり配らない。
    expect(await isRunPageArtifactReference(runDirectory, `pages/${PAGE}/desktop/full-page.png`)).toBe(false);
    expect(await isRunPageArtifactReference(runDirectory, 'pages/PAGE-000002/page.json')).toBe(false);
    expect(await isRunPageArtifactReference(runDirectory, 'checkpoint/x.png')).toBe(false);
  });

  it('serves no page artifact of a Run without audit.json, as before', async () => {
    const runDirectory = runDirectoryWith(null);

    expect(await isRunPageArtifactReference(runDirectory, `pages/${PAGE}/page.json`)).toBe(false);
    expect(await isRunPageArtifactReference(runDirectory, SHOT)).toBe(false);
  });
});

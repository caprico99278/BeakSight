// 画面のサーバが配ってよい、Run のページの成果物のファイル（`page.json`・`visible-text.txt`・Evidence のスクリーンショット）の見分け（唯一の部品）。
// 画面のサーバ（`apps/local-ui/src/server/artifact-files.ts`）の許可の一覧が使う。
// - MEM-4（DEF-266）: `audit.json` を丸ごと読まない（大きな Run の `audit.json` は、1 つのファイルの読み取りの上限を超える）。求められたパスの
//   `pages/<pageId>/` のページの `page.json` だけを、リンクをたどらない部品で読んで見分ける。`audit.json` は、あること（リンクでないファイル）だけを確かめる
//   （`audit.json` のない Run は、今どおり何も配らない）。
// - 見分け方は今どおり: そのページの `page.json`・`visible-text.txt` と、`page.json` の screenshot の Evidence の相対パスのうち、そのページの
//   `pages/<pageId>/` の下のスクリーンショットのファイルの名前（`SCREENSHOT_FILE_NAMES`）のもの。`page.json` の `pageId` が、パスのページと違えば配らない。
// - 読めない・形の違うファイルは、配らない（例外を投げない）。
import { PAGES_ARTIFACT_DIRECTORY, RUN_ARTIFACT_FILE_NAMES, SCREENSHOT_FILE_NAMES, isPortableRelativeArtifactPath, pageArtifactRelativePath } from './artifact-layout.js';
import { inspectRealArtifactEntry, readContainedArtifactFile } from './contained-artifact-file.js';
import type { PageId } from './contracts.js';
import { isRecord } from './guards.js';
import { isPageId } from './ids.js';

/** スクリーンショットのファイルの名前（撮り方ごと）。 */
const SCREENSHOT_NAMES: ReadonlySet<string> = new Set(Object.values(SCREENSHOT_FILE_NAMES));

/** スクリーンショットの相対パスとして受けるか（そのページの `pages/<pageId>/` の下の、スクリーンショットのファイルの名前のもの）。 */
const isScreenshotPathOfPage = (relativePath: unknown, pageId: string): relativePath is string =>
  isPortableRelativeArtifactPath(relativePath)
  && relativePath.startsWith(`${PAGES_ARTIFACT_DIRECTORY}/${pageId}/`)
  && SCREENSHOT_NAMES.has(relativePath.slice(relativePath.lastIndexOf('/') + 1));

/** 相対パスが、リンクでないファイルとしてあるか（調べられないときは、ないとみなす）。 */
const isRealFile = async (runDirectory: string, relativePath: string): Promise<boolean> => {
  try {
    return (await inspectRealArtifactEntry(runDirectory, relativePath)).kind === 'FILE';
  } catch {
    return false;
  }
};

/** ページの `page.json` が参照する相対パス（読めない、形が違う、ページの ID が違う場合は空）。 */
const referencedPathsOfPage = async (runDirectory: string, pageId: PageId): Promise<ReadonlySet<string>> => {
  let page: unknown;
  try {
    // 大きさの上限は、読み取りの部品の既定（`page.json` を配るときと同じ）。
    const reading = await readContainedArtifactFile(runDirectory, pageArtifactRelativePath(pageId, 'page'));
    if (!reading.ok) {
      return new Set();
    }
    page = JSON.parse(reading.bytes.toString('utf8')) as unknown;
  } catch {
    return new Set();
  }
  if (!isRecord(page) || page['pageId'] !== pageId) {
    return new Set();
  }
  const paths = new Set<string>([pageArtifactRelativePath(pageId, 'page'), pageArtifactRelativePath(pageId, 'visibleText')]);
  const evidence = Array.isArray(page['evidence']) ? (page['evidence'] as unknown[]) : [];
  for (const record of evidence) {
    const payload = isRecord(record) && record['type'] === 'screenshot' && isRecord(record['payload']) ? record['payload'] : null;
    if (payload !== null && isScreenshotPathOfPage(payload['relativePath'], pageId)) {
      paths.add(payload['relativePath']);
    }
  }
  return paths;
};

/** Run のディレクトリ（絶対パス）の `relativePath` が、Run のページの成果物の参照か（ファイルの先頭の説明）。 */
export async function isRunPageArtifactReference(runDirectory: string, relativePath: string): Promise<boolean> {
  const [directory, pageId] = relativePath.split('/');
  if (directory !== PAGES_ARTIFACT_DIRECTORY || !isPageId(pageId) || !(await isRealFile(runDirectory, RUN_ARTIFACT_FILE_NAMES.audit))) {
    return false;
  }
  return (await referencedPathsOfPage(runDirectory, pageId)).has(relativePath);
}

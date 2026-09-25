import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { scrollDocumentToOrigin } from '../browser/controlled-scroll.js';
import { isPortableRelativeArtifactPath } from '../core/artifact-layout.js';
import { VIEWPORT_PROFILES, type PageId, type ViewportProfile } from '../core/contracts.js';
import type { ScreenshotEvidence } from '../core/evidence-types.js';

export interface ScreenshotCapturePath {
  readonly outputPath: string;
  readonly relativeArtifactPath: string;
}

export interface ScreenshotCapturePaths {
  readonly pageId: PageId;
  /** 撮影したビューポート（`VIEWPORT_PROFILES` のどれか）。 */
  readonly viewport: ViewportProfile;
  readonly viewportCapture: ScreenshotCapturePath;
  readonly fullPageCapture: ScreenshotCapturePath;
}

/**
 * 記録する相対パスを確かめて、そのまま返す。規則は `isPortableRelativeArtifactPath`（CC-027）に従う。その規則に合うパスは、
 * `posix.normalize` で変わらない（正規形である）。不正なら `Error` を投げる。
 */
function portableRelativeArtifactPath(path: string): string {
  if (!isPortableRelativeArtifactPath(path)) {
    throw new Error('Screenshot artifact metadata path must be a canonical portable relative path');
  }
  return path;
}

function outputPathIdentity(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * 要求された2枚のPNGキャプチャを書き出し、Task 14での組み立て用に生のメタデータを返す。
 * どちらも、文書のスクロール位置を先頭（0, 0）へ戻してから撮る（viewport のキャプチャは initial viewport になる）。
 */
export async function captureScreenshots(
  page: Page,
  paths: ScreenshotCapturePaths,
): Promise<readonly ScreenshotEvidence[]> {
  const pageId = paths.pageId;
  const viewport = paths.viewport;
  if (!(VIEWPORT_PROFILES as readonly string[]).includes(viewport)) {
    throw new Error('Screenshot viewport must be one of the viewport profiles');
  }
  const viewportOutputPath = paths.viewportCapture.outputPath;
  const viewportRelativePath = paths.viewportCapture.relativeArtifactPath;
  const fullPageOutputPath = paths.fullPageCapture.outputPath;
  const fullPageRelativePath = paths.fullPageCapture.relativeArtifactPath;

  const viewportMetadataIdentity = portableRelativeArtifactPath(viewportRelativePath);
  const fullPageMetadataIdentity = portableRelativeArtifactPath(fullPageRelativePath);
  if (viewportMetadataIdentity === fullPageMetadataIdentity) {
    throw new Error('Viewport and full-page artifact metadata paths must be distinct');
  }
  if (outputPathIdentity(viewportOutputPath) === outputPathIdentity(fullPageOutputPath)) {
    throw new Error('Viewport and full-page screenshot output paths must be distinct');
  }

  const viewportScrollPosition = await scrollDocumentToOrigin(page);
  await page.screenshot({ path: viewportOutputPath, type: 'png', fullPage: false });
  const fullPageScrollPosition = await scrollDocumentToOrigin(page);
  await page.screenshot({ path: fullPageOutputPath, type: 'png', fullPage: true });

  return Object.freeze([
    Object.freeze({
      pageId,
      viewport,
      relativePath: viewportRelativePath,
      captureType: 'VIEWPORT' as const,
      scrollPosition: viewportScrollPosition,
    }),
    Object.freeze({
      pageId,
      viewport,
      relativePath: fullPageRelativePath,
      captureType: 'FULL_PAGE' as const,
      scrollPosition: fullPageScrollPosition,
    }),
  ]);
}

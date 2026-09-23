import { posix, resolve, win32 } from 'node:path';
import type { Page } from 'playwright';
import type { PageId } from '../core/contracts.js';

export interface ScreenshotCapturePath {
  readonly outputPath: string;
  readonly relativeArtifactPath: string;
}

export interface ScreenshotCapturePaths {
  readonly pageId: PageId;
  readonly viewport: string;
  readonly viewportCapture: ScreenshotCapturePath;
  readonly fullPageCapture: ScreenshotCapturePath;
}

export interface ScreenshotEvidence {
  readonly pageId: PageId;
  readonly viewport: string;
  readonly relativePath: string;
  readonly captureType: 'VIEWPORT' | 'FULL_PAGE';
}

function portableRelativeArtifactPath(path: string): string {
  const segments = path.split('/');
  if (
    path.length === 0
    || path.includes('\0')
    || path.includes('\\')
    || posix.isAbsolute(path)
    || win32.isAbsolute(path)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error('Screenshot artifact metadata path must be a canonical portable relative path');
  }
  const normalized = posix.normalize(path);
  if (normalized !== path) {
    throw new Error('Screenshot artifact metadata path must be a canonical portable relative path');
  }
  return normalized;
}

function outputPathIdentity(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 要求された2枚のPNGキャプチャを書き出し、Task 14での組み立て用に生のメタデータを返す。 */
export async function captureScreenshots(
  page: Page,
  paths: ScreenshotCapturePaths,
): Promise<readonly ScreenshotEvidence[]> {
  const pageId = paths.pageId;
  const viewport = paths.viewport;
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

  await page.screenshot({ path: viewportOutputPath, type: 'png', fullPage: false });
  await page.screenshot({ path: fullPageOutputPath, type: 'png', fullPage: true });

  return Object.freeze([
    Object.freeze({
      pageId,
      viewport,
      relativePath: viewportRelativePath,
      captureType: 'VIEWPORT' as const,
    }),
    Object.freeze({
      pageId,
      viewport,
      relativePath: fullPageRelativePath,
      captureType: 'FULL_PAGE' as const,
    }),
  ]);
}

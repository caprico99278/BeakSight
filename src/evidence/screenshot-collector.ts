import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { readDocumentScrollPosition, scrollDocumentToOrigin } from '../browser/controlled-scroll.js';
import { isPortableRelativeArtifactPath } from '../core/artifact-layout.js';
import { VIEWPORT_PROFILES, type PageId, type ViewportProfile } from '../core/contracts.js';
import type { EvidenceStateMark, RevealCaptureEvidence, ScreenshotEvidence } from '../core/evidence-types.js';
import { readStateMark } from './state-mark.js';
import { watchCollection, type CollectorWatchEnd, type CollectorWatchOptions } from '../browser/collector-watch.js';

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

/** L2: `captureScreenshots` の指定。 */
export interface ScreenshotCaptureOptions {
  /** 進みの見張りの指定（反応なしの長さ・呼ぶ側の見張りの口）。 */
  readonly watch?: CollectorWatchOptions | undefined;
  /**
   * AUD-2c（整理の文書 `2026-11-09-beaksight-audit-precision-triage.md` の AUD-2c）: 撮る画像。`VIEWPORT` は viewport の画像だけ、`FULL_PAGE` は全体の画像だけ、
   * 省略（`BOTH`）は今までどおり両方（viewport → 全体の順）。Page Auditor は、viewport の画像を DOM・layout の直後に、全体の画像を後で撮るために分けて呼ぶ。
   */
  readonly parts?: ScreenshotCaptureParts | undefined;
  /** AUD-4: 直前の layout の対象の selector（`stateMarkTargetSelectorsOf`）。渡すと、viewport の画像の状態の印に、対象の矩形を読み直して記録する。 */
  readonly markTargets?: readonly string[] | undefined;
}

/** AUD-2c: 撮る画像の指定の閉じた一覧。 */
export const SCREENSHOT_CAPTURE_PARTS = Object.freeze(['VIEWPORT', 'FULL_PAGE', 'BOTH'] as const);
export type ScreenshotCaptureParts = (typeof SCREENSHOT_CAPTURE_PARTS)[number];

/**
 * L2（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 撮影の途中で、進みの見張りが撮影を終えた（全く反応がない・静まらない）ことを表す。
 * `captured` は、それまでに撮り終えたキャプチャの Evidence（ファイルは書いてある）。呼ぶ側は、理由（`end`）を記録し、撮り終えた分を残せる。
 */
export class ScreenshotWatchEndedError extends Error {
  readonly end: CollectorWatchEnd;
  readonly captured: readonly ScreenshotEvidence[];

  constructor(end: CollectorWatchEnd, captured: readonly ScreenshotEvidence[]) {
    super(`the screenshot capture ended by the progress watch: ${end}`);
    this.name = 'ScreenshotWatchEndedError';
    this.end = end;
    this.captured = Object.freeze([...captured]);
  }
}

/**
 * Playwright の撮影の期限（ms）。L2: 0 は期限なし（Playwright の既定の 30 秒を使わない）。撮影を終えるのは、進みの見張りだけ。
 */
const NO_SCREENSHOT_TIMEOUT_MS = 0;

/**
 * 要求された2枚のPNGキャプチャを書き出し、Task 14での組み立て用に生のメタデータを返す。
 * どちらも、文書のスクロール位置を先頭（0, 0）へ戻してから撮る（viewport のキャプチャは initial viewport になる）。
 * L2: 撮影の期限は置かず（Playwright の既定の 30 秒も使わない）、進みの見張り（`watchCollection`）で待つ。ブラウザの呼び出しが返るたびに進みの印を
 * 付ける。全く反応がない・静まらないときだけ、撮り終えた分を持った `ScreenshotWatchEndedError` を投げる。
 */
export async function captureScreenshots(
  page: Page,
  paths: ScreenshotCapturePaths,
  options: ScreenshotCaptureOptions = {},
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

  // 撮り終えたキャプチャ（見張りが終えても、ここまでを残す）。
  const captured: ScreenshotEvidence[] = [];
  const parts = options.parts ?? 'BOTH';
  const outcome = await watchCollection(page, async (signals) => {
    if (parts !== 'FULL_PAGE') {
      const viewportScrollPosition = await signals.track(scrollDocumentToOrigin(page));
      const stateMark = await signals.track(stateMarkOrNull(page, options.markTargets));
      await signals.track(page.screenshot({ path: viewportOutputPath, type: 'png', fullPage: false, timeout: NO_SCREENSHOT_TIMEOUT_MS }));
      captured.push(Object.freeze({
        pageId,
        viewport,
        relativePath: viewportRelativePath,
        captureType: 'VIEWPORT' as const,
        scrollPosition: viewportScrollPosition,
        ...(stateMark === null ? {} : { stateMark }),
      }));
    }
    if (parts === 'VIEWPORT') {
      return Object.freeze([...captured]);
    }
    const fullPageScrollPosition = await signals.track(scrollDocumentToOrigin(page));
    await signals.track(page.screenshot({ path: fullPageOutputPath, type: 'png', fullPage: true, timeout: NO_SCREENSHOT_TIMEOUT_MS }));
    captured.push(Object.freeze({
      pageId,
      viewport,
      relativePath: fullPageRelativePath,
      captureType: 'FULL_PAGE' as const,
      scrollPosition: fullPageScrollPosition,
    }));
    return Object.freeze([...captured]);
  }, options.watch ?? {});
  switch (outcome.status) {
    case 'FULFILLED':
      return outcome.value;
    case 'REJECTED':
      throw outcome.reason;
    case 'ENDED':
      throw new ScreenshotWatchEndedError(outcome.end, captured);
  }
}

/**
 * AUD-3d（整理の文書 `2026-11-09-beaksight-audit-precision-triage.md` の AUD-3d）: 1 枚の viewport の画像を撮る（layout を読んだ直後に、その page で撮る）。
 * 幅の走査の幅（`stressWidth` あり。ビューポートは `desktop`）と、落ち着いた後の確かめ直しの段（`stressWidth` なし）が使う。主の viewport の画像と同じく、
 * 文書の先頭へ戻してから撮る。ページの中を読むだけで、サイトへの要求と読み込みは足さない。見張りは呼ぶ側が持つ。
 * EV-2: 対象まで動かして撮る部品（`revealAndCapture`）とフォーカスの確かめは、測り直しの記録（`reveal`）を渡し、先頭へ戻さずに今の位置で撮る。
 */
export async function captureViewportScreenshot(
  page: Page,
  path: ScreenshotCapturePath,
  target: {
    readonly pageId: PageId;
    readonly viewport: ViewportProfile;
    readonly stressWidth: number | null;
    /** EV-2: 対象まで動かした後の画像なら、測り直しの記録（先頭へ戻さずに、今の位置のまま撮る）。 */
    readonly reveal?: RevealCaptureEvidence | undefined;
    /** AUD-4: 状態の画像なら、直前の layout の対象の selector（状態の印に、対象の矩形を読み直して記録する）。 */
    readonly markTargets?: readonly string[] | undefined;
  },
): Promise<ScreenshotEvidence> {
  const relativePath = portableRelativeArtifactPath(path.relativeArtifactPath);
  const scrollPosition = target.reveal === undefined ? await scrollDocumentToOrigin(page) : await readDocumentScrollPosition(page);
  // AUD-4: 状態の画像（先頭へ戻して撮る画像）だけ、撮る直前に状態の印を読む。
  const stateMark = target.reveal === undefined ? await stateMarkOrNull(page, target.markTargets) : null;
  await page.screenshot({ path: path.outputPath, type: 'png', fullPage: false, timeout: NO_SCREENSHOT_TIMEOUT_MS });
  return Object.freeze({
    pageId: target.pageId,
    viewport: target.viewport,
    relativePath,
    captureType: 'VIEWPORT' as const,
    scrollPosition,
    ...(target.stressWidth === null ? {} : { stressWidth: target.stressWidth }),
    ...(target.reveal === undefined ? {} : { reveal: target.reveal }),
    ...(stateMark === null ? {} : { stateMark }),
  });
}

/**
 * AUD-4（設計書 `2026-11-19-beaksight-audit-result-review-fixes-design.md` 7.2 の 1）: 状態の画像の状態の印（読めなければ `null`。撮影は続ける）。対象を渡したら、
 * 対象の矩形を読み直す。
 */
async function stateMarkOrNull(page: Page, markTargets: readonly string[] | undefined): Promise<EvidenceStateMark | null> {
  try {
    return await readStateMark(page, markTargets === undefined ? null : { selectors: markTargets, read: 'RECTS' });
  } catch {
    return null;
  }
}

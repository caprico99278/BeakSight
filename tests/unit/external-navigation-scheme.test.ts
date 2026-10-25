// EL-F（EL-R の I2）・EL-F2（EL-R2 の N2）: Chromium に組み込みの PDF の表示の拡張の頁（閉じた一覧の ID）の見分け。外部スキームの判定
// （`externalNavigationScheme`）そのものは、`chrome-extension:` を今どおり外部スキームとし、Guard は `Page.frameStartedNavigating` の sub frame のときだけ
// この見分け（`isChromiumPdfViewerFrameUrl`）で外す（`window.open` などは今どおり外部スキーム。結合のテストは `external-launch-block.test.ts`）。
import { describe, expect, it } from 'vitest';
import { CHROMIUM_PDF_VIEWER_EXTENSION_ID, NON_EXTERNAL_CHROMIUM_EXTENSION_IDS } from '../../src/core/evidence-types.js';
import { externalNavigationScheme, isChromiumPdfViewerFrameUrl } from '../../src/safety/passive-request-guard.js';

const PDF_VIEWER_URL = `chrome-extension://${CHROMIUM_PDF_VIEWER_EXTENSION_ID}/index.html`;

describe('EL-F2: the PDF viewer extension of Chromium is told apart, and the scheme check itself does not change', () => {
  it('names one extension ID only', () => {
    expect(NON_EXTERNAL_CHROMIUM_EXTENSION_IDS).toEqual([CHROMIUM_PDF_VIEWER_EXTENSION_ID]);
    expect(CHROMIUM_PDF_VIEWER_EXTENSION_ID).toBe('mhjfbmdgcfjbbpaeojofohoefgiehjai');
  });

  it('tells the PDF viewer frame apart, and keeps every chrome-extension: URL an external scheme in the scheme check', () => {
    expect(isChromiumPdfViewerFrameUrl(PDF_VIEWER_URL)).toBe(true);
    expect(isChromiumPdfViewerFrameUrl('chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/index.html')).toBe(false);
    expect(isChromiumPdfViewerFrameUrl(`chrome-extension://${CHROMIUM_PDF_VIEWER_EXTENSION_ID}x/index.html`)).toBe(false);
    expect(isChromiumPdfViewerFrameUrl('http://[')).toBe(false);
    expect(externalNavigationScheme(PDF_VIEWER_URL)).toBe('chrome-extension');
    expect(externalNavigationScheme('mailto:nobody@example.invalid')).toBe('mailto');
    expect(externalNavigationScheme('https://example.test/')).toBeNull();
  });
});

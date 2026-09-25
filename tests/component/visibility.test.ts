import type { Browser, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { VISIBILITY_CHECK_OPTIONS } from '../../src/core/visibility.js';
import { useHeadlessChromium } from '../helpers/chromium.js';

let browser: Browser;

useHeadlessChromium((launched) => {
  browser = launched;
});

async function visibilityById(page: Page, ids: readonly string[]): Promise<Record<string, boolean>> {
  return page.evaluate(({ options, elementIds }) => {
    const result: Record<string, boolean> = {};
    for (const id of elementIds) {
      const element = document.getElementById(id);
      if (element === null) throw new Error(`missing fixture element ${id}`);
      result[id] = element.checkVisibility(options);
    }
    return result;
  }, { options: VISIBILITY_CHECK_OPTIONS, elementIds: ids });
}

describe('VISIBILITY_CHECK_OPTIONS', () => {
  it('defines the shared checkVisibility options as one frozen value', () => {
    expect(VISIBILITY_CHECK_OPTIONS).toEqual({
      opacityProperty: true,
      visibilityProperty: true,
      contentVisibilityAuto: false,
    });
    expect(Object.isFrozen(VISIBILITY_CHECK_OPTIONS)).toBe(true);
  });

  it('treats a child of a transparent body as not visible', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <!doctype html>
        <html><head><style>body { opacity: 0; }</style></head>
        <body><p id="transparent-child">Hidden by an ancestor opacity</p></body></html>
      `);

      await expect(visibilityById(page, ['transparent-child'])).resolves.toEqual({ 'transparent-child': false });
    } finally {
      await page.close();
    }
  });

  it('treats a visibility:visible child of a visibility:hidden ancestor as visible, and the ancestor as not visible', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <!doctype html>
        <html><body>
          <div id="hidden-parent" style="visibility: hidden">
            <span id="hidden-text">Inherited hidden</span>
            <p id="visible-child" style="visibility: visible">Overrides the inherited visibility</p>
          </div>
        </body></html>
      `);

      await expect(visibilityById(page, ['hidden-parent', 'hidden-text', 'visible-child'])).resolves.toEqual({
        'hidden-parent': false,
        'hidden-text': false,
        'visible-child': true,
      });
    } finally {
      await page.close();
    }
  });

  it('treats content inside an off-viewport content-visibility:auto section as visible', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await page.setContent(`
        <!doctype html>
        <html><body style="margin: 0">
          <div style="height: 5000px">Tall leading content</div>
          <section id="auto-section" style="content-visibility: auto; contain-intrinsic-size: auto 400px">
            <p id="skipped-child">Rendering is skipped until scrolled into view</p>
          </section>
        </body></html>
      `);

      const skipped = await page.evaluate(() => {
        const child = document.getElementById('skipped-child');
        if (child === null) throw new Error('missing fixture element skipped-child');
        return !child.checkVisibility({ contentVisibilityAuto: true });
      });
      expect(skipped, 'the fixture must place the child in a content-visibility:auto skipped subtree').toBe(true);
      await expect(visibilityById(page, ['auto-section', 'skipped-child'])).resolves.toEqual({
        'auto-section': true,
        'skipped-child': true,
      });
    } finally {
      await page.close();
    }
  });

  it('treats a child of a display:none ancestor as not visible', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <!doctype html>
        <html><body>
          <section style="display: none"><div><p id="undisplayed-child">Never rendered</p></div></section>
          <p id="plain">Rendered text</p>
        </body></html>
      `);

      await expect(visibilityById(page, ['undisplayed-child', 'plain'])).resolves.toEqual({
        'undisplayed-child': false,
        plain: true,
      });
    } finally {
      await page.close();
    }
  });
});

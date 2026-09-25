import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { createPageId } from '../../src/core/ids.js';
import { captureScreenshots } from '../../src/evidence/screenshot-collector.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { withGuardedPassivePage } from '../helpers/gate-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

let browser: Browser;
let temporaryDirectory: string | undefined;

function pngDimensions(contents: Buffer): { readonly width: number; readonly height: number } {
  expect(contents.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { width: contents.readUInt32BE(16), height: contents.readUInt32BE(20) };
}

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  temporaryDirectory = undefined;
});

/** Guard の付いた Passive の page に fixture の内容を置いて `run` に渡す。終わったら（失敗しても）page と Context を閉じる。 */
async function withFixturePage(run: (page: Page) => Promise<void>): Promise<void> {
  const factory = new BrowserContextFactory(browser, createTestConfig('https://example.test'), () => new SafetyLedger());
  await withGuardedPassivePage(factory, { width: 320, height: 240 }, async (page) => {
    await page.setContent('<style>html,body{margin:0}main{height:700px;background:#123456}</style><main>Screenshot fixture</main>');
    await run(page);
  });
}

describe('captureScreenshots', () => {
  it('writes requested viewport and full-page PNGs and returns immutable relative-path evidence', async () => {
    await withFixturePage(async (fixturePage) => {
      temporaryDirectory = await mkdtemp(resolve(process.cwd(), '.task8-screenshot-'));
      const viewportOutputPath = resolve(temporaryDirectory, 'viewport.png');
      const fullPageOutputPath = resolve(temporaryDirectory, 'full.png');
      const pageId = createPageId(10);

      const evidence = await captureScreenshots(fixturePage, {
        pageId,
        viewport: 'desktop',
        viewportCapture: {
          outputPath: viewportOutputPath,
          relativeArtifactPath: 'screenshots/PAGE-000010/desktop/viewport.png',
        },
        fullPageCapture: {
          outputPath: fullPageOutputPath,
          relativeArtifactPath: 'screenshots/PAGE-000010/desktop/full.png',
        },
      });

      const viewportPng = await readFile(viewportOutputPath);
      const fullPagePng = await readFile(fullPageOutputPath);
      expect(pngDimensions(viewportPng)).toEqual({ width: 320, height: 240 });
      expect(pngDimensions(fullPagePng)).toEqual({ width: 320, height: 700 });
      expect(evidence).toEqual([
        {
          pageId,
          viewport: 'desktop',
          relativePath: 'screenshots/PAGE-000010/desktop/viewport.png',
          captureType: 'VIEWPORT',
          scrollPosition: { scrollX: 0, scrollY: 0 },
        },
        {
          pageId,
          viewport: 'desktop',
          relativePath: 'screenshots/PAGE-000010/desktop/full.png',
          captureType: 'FULL_PAGE',
          scrollPosition: { scrollX: 0, scrollY: 0 },
        },
      ]);
      expect(JSON.stringify(evidence)).not.toContain(temporaryDirectory);
      expect(Object.isFrozen(evidence)).toBe(true);
      expect(Object.isFrozen(evidence[0])).toBe(true);
    });
  });

  it('captures the initial viewport at the document origin and records the capture scroll position', async () => {
    await withFixturePage(async (fixturePage) => {
      await fixturePage.setContent([
        '<style>html,body{margin:0}#top{height:240px;background:#ff0000}#rest{height:1000px;background:#0000ff}</style>',
        '<div id="top">Initial viewport</div><div id="rest">Lower content</div>',
      ].join(''));
      await fixturePage.evaluate(() => window.scrollTo(0, 600));
      const scrolledCapture = await fixturePage.screenshot({ type: 'png', fullPage: false });
      temporaryDirectory = await mkdtemp(resolve(process.cwd(), '.task8-screenshot-'));
      const viewportOutputPath = resolve(temporaryDirectory, 'viewport.png');

      const evidence = await captureScreenshots(fixturePage, {
        pageId: createPageId(13),
        viewport: 'desktop',
        viewportCapture: {
          outputPath: viewportOutputPath,
          relativeArtifactPath: 'screenshots/PAGE-000013/desktop/viewport.png',
        },
        fullPageCapture: {
          outputPath: resolve(temporaryDirectory, 'full.png'),
          relativeArtifactPath: 'screenshots/PAGE-000013/desktop/full.png',
        },
      });
      const viewportPng = await readFile(viewportOutputPath);
      await fixturePage.evaluate(() => window.scrollTo(0, 0));
      const originCapture = await fixturePage.screenshot({ type: 'png', fullPage: false });

      expect(viewportPng.equals(originCapture)).toBe(true);
      expect(viewportPng.equals(scrolledCapture)).toBe(false);
      expect(evidence[0]).toMatchObject({ captureType: 'VIEWPORT', scrollPosition: { scrollX: 0, scrollY: 0 } });
      expect(Object.isFrozen(evidence[0]?.scrollPosition)).toBe(true);
    });
  });

  it('rejects visibly when a requested capture path cannot be written', async () => {
    await withFixturePage(async (fixturePage) => {
      temporaryDirectory = await mkdtemp(resolve(process.cwd(), '.task8-screenshot-'));
      const invalidOutputPath = resolve(temporaryDirectory, 'directory-not-file');
      await mkdir(invalidOutputPath);

      await expect(captureScreenshots(fixturePage, {
        pageId: createPageId(11),
        viewport: 'mobile',
        viewportCapture: {
          outputPath: invalidOutputPath,
          relativeArtifactPath: 'screenshots/PAGE-000011/mobile/viewport.png',
        },
        fullPageCapture: {
          outputPath: resolve(temporaryDirectory, 'full.png'),
          relativeArtifactPath: 'screenshots/PAGE-000011/mobile/full.png',
        },
      })).rejects.toThrow();
    });
  });

  it('rejects absolute artifact metadata before claiming or writing screenshot evidence', async () => {
    await withFixturePage(async (fixturePage) => {
      temporaryDirectory = await mkdtemp(resolve(process.cwd(), '.task8-screenshot-'));
      const viewportOutputPath = resolve(temporaryDirectory, 'viewport.png');

      await expect(captureScreenshots(fixturePage, {
        pageId: createPageId(12),
        viewport: 'desktop',
        viewportCapture: {
          outputPath: viewportOutputPath,
          relativeArtifactPath: resolve(temporaryDirectory, 'absolute-metadata.png'),
        },
        fullPageCapture: {
          outputPath: resolve(temporaryDirectory, 'full.png'),
          relativeArtifactPath: 'screenshots/PAGE-000012/desktop/full.png',
        },
      })).rejects.toThrow('relative');
      await expect(readFile(viewportOutputPath)).rejects.toThrow();
    });
  });

  it('rejects non-portable or non-canonical relative artifact metadata before writing', async () => {
    await withFixturePage(async (fixturePage) => {
      temporaryDirectory = await mkdtemp(resolve(process.cwd(), '.task8-screenshot-'));
      const invalidPaths = [
        '',
        '.',
        '..',
        'screenshots/../viewport.png',
        'screenshots//viewport.png',
        'screenshots\\viewport.png',
        'screenshots/\0viewport.png',
        'file:screenshots/viewport.png',
        'C:screenshots/viewport.png',
      ];

      for (const [index, invalidPath] of invalidPaths.entries()) {
        const viewportOutputPath = resolve(temporaryDirectory, `invalid-${index}.png`);
        await expect(captureScreenshots(fixturePage, {
          pageId: createPageId(20 + index),
          viewport: 'desktop',
          viewportCapture: {
            outputPath: viewportOutputPath,
            relativeArtifactPath: invalidPath,
          },
          fullPageCapture: {
            outputPath: resolve(temporaryDirectory, `full-${index}.png`),
            relativeArtifactPath: `screenshots/full-${index}.png`,
          },
        })).rejects.toThrow('relative');
        await expect(readFile(viewportOutputPath)).rejects.toThrow();
      }
    });
  });

  it('rejects a viewport outside the viewport profiles before the first screenshot write (F07 finding 4)', async () => {
    await withFixturePage(async (fixturePage) => {
      temporaryDirectory = await mkdtemp(resolve(process.cwd(), '.task8-screenshot-'));
      const viewportOutputPath = resolve(temporaryDirectory, 'viewport.png');

      await expect(captureScreenshots(fixturePage, {
        pageId: createPageId(32),
        viewport: 'tablet' as never,
        viewportCapture: {
          outputPath: viewportOutputPath,
          relativeArtifactPath: 'screenshots/PAGE-000032/tablet/viewport.png',
        },
        fullPageCapture: {
          outputPath: resolve(temporaryDirectory, 'full.png'),
          relativeArtifactPath: 'screenshots/PAGE-000032/tablet/full.png',
        },
      })).rejects.toThrow(/viewport profile/iu);
      await expect(readFile(viewportOutputPath)).rejects.toThrow();
    });
  });

  it('rejects aliased metadata or output targets before the first screenshot write', async () => {
    await withFixturePage(async (fixturePage) => {
      temporaryDirectory = await mkdtemp(resolve(process.cwd(), '.task8-screenshot-'));
      const metadataAliasOutput = resolve(temporaryDirectory, 'metadata-alias-viewport.png');

      await expect(captureScreenshots(fixturePage, {
        pageId: createPageId(30),
        viewport: 'desktop',
        viewportCapture: {
          outputPath: metadataAliasOutput,
          relativeArtifactPath: 'screenshots/shared.png',
        },
        fullPageCapture: {
          outputPath: resolve(temporaryDirectory, 'metadata-alias-full.png'),
          relativeArtifactPath: 'screenshots/shared.png',
        },
      })).rejects.toThrow('distinct');
      await expect(readFile(metadataAliasOutput)).rejects.toThrow();

      const sharedOutput = resolve(temporaryDirectory, 'shared-output.png');
      await expect(captureScreenshots(fixturePage, {
        pageId: createPageId(31),
        viewport: 'desktop',
        viewportCapture: {
          outputPath: sharedOutput,
          relativeArtifactPath: 'screenshots/viewport.png',
        },
        fullPageCapture: {
          outputPath: sharedOutput,
          relativeArtifactPath: 'screenshots/full.png',
        },
      })).rejects.toThrow('distinct');
      await expect(readFile(sharedOutput)).rejects.toThrow();
    });
  });
});

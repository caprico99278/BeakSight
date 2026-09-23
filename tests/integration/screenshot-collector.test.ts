import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { AuditConfig } from '../../src/config/types.js';
import { createPageId } from '../../src/core/ids.js';
import { captureScreenshots } from '../../src/evidence/screenshot-collector.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';

let browser: Browser;
let context: BrowserContext | undefined;
let factory: BrowserContextFactory | undefined;
let page: Page | undefined;
let temporaryDirectory: string | undefined;

function fixtureConfig(): AuditConfig {
  return {
    ...DEFAULT_CONFIG,
    site: { startUrl: 'https://example.test/', allowedOrigins: ['https://example.test'] },
    browser: { ...DEFAULT_CONFIG.browser, headed: false },
    viewports: {
      primaryDesktop: { ...DEFAULT_CONFIG.viewports.primaryDesktop },
      primaryMobile: { ...DEFAULT_CONFIG.viewports.primaryMobile },
      stressWidths: [...DEFAULT_CONFIG.viewports.stressWidths],
    },
  };
}

function pngDimensions(contents: Buffer): { readonly width: number; readonly height: number } {
  expect(contents.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { width: contents.readUInt32BE(16), height: contents.readUInt32BE(20) };
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterEach(async () => {
  if (page !== undefined && !page.isClosed() && factory !== undefined) {
    await factory.closePassivePage(page).catch(() => undefined);
  }
  if (context !== undefined && context.browser() !== null && factory !== undefined) {
    await factory.closePassiveContext(context).catch(() => undefined);
  }
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  page = undefined;
  context = undefined;
  factory = undefined;
  temporaryDirectory = undefined;
});

afterAll(async () => {
  await browser.close();
});

async function createFixturePage(): Promise<Page> {
  factory = new BrowserContextFactory(browser, fixtureConfig(), () => new SafetyLedger());
  context = await factory.createPassiveContext({ width: 320, height: 240 });
  page = await factory.createPassivePage(context);
  await page.setContent('<style>html,body{margin:0}main{height:700px;background:#123456}</style><main>Screenshot fixture</main>');
  return page;
}

describe('captureScreenshots', () => {
  it('writes requested viewport and full-page PNGs and returns immutable relative-path evidence', async () => {
    const fixturePage = await createFixturePage();
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
      },
      {
        pageId,
        viewport: 'desktop',
        relativePath: 'screenshots/PAGE-000010/desktop/full.png',
        captureType: 'FULL_PAGE',
      },
    ]);
    expect(JSON.stringify(evidence)).not.toContain(temporaryDirectory);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence[0])).toBe(true);
  });

  it('rejects visibly when a requested capture path cannot be written', async () => {
    const fixturePage = await createFixturePage();
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

  it('rejects absolute artifact metadata before claiming or writing screenshot evidence', async () => {
    const fixturePage = await createFixturePage();
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

  it('rejects non-portable or non-canonical relative artifact metadata before writing', async () => {
    const fixturePage = await createFixturePage();
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

  it('rejects aliased metadata or output targets before the first screenshot write', async () => {
    const fixturePage = await createFixturePage();
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

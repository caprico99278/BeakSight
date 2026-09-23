import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPageId } from '../../src/core/ids.js';
import { discoverLinks } from '../../src/crawl/discover-links.js';
import { collectDomEvidence } from '../../src/evidence/dom-collector.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

describe('collectDomEvidence', () => {
  it('collects normalized non-link document facts in one read-only evaluation and reuses canonical links', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <!doctype html>
      <html lang=" ja-JP ">
        <head>
          <title>  Fixture   audit  </title>
          <meta name="description" content="  Evidence   first  ">
          <link rel="canonical" href=" /canonical-page ">
          <base href="https://example.test/">
        </head>
        <body>
          <header> Header   text </header>
          <nav> Primary\n navigation </nav>
          <main>
            <h1> Main   heading </h1>
            <h3>Nested\nheading</h3>
            <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2' height='3'/%3E" alt="  tiny   image ">
            <form method="post" action="/submit">
              <label for="email"> Email   address </label>
              <input id="email" type="email" name="contact" required>
              <label> Accept <input type="checkbox" name="terms"></label>
              <button type="submit" name="intent" value="send"> Send   now </button>
              <input type="submit" name="alternate" value=" Send alternate ">
            </form>
          </main>
          <aside> Side   note </aside>
          <footer> Footer text </footer>
          <a href="/pricing?utm_source=ignored&page=2"> Pricing   plans </a>
          <a href="https://external.test/contact">External contact</a>
          <a href="mailto:help@example.test">Email us</a>
        </body>
      </html>
    `);
    await page.locator('img').evaluate((image: HTMLImageElement) => image.decode());
    const pageId = createPageId(8);
    const canonicalLinks = await discoverLinks(page, pageId, {
      allowedOrigins: new Set(['https://example.test']),
      allowedQueryParameters: new Set(['page']),
    });
    const evaluate = vi.spyOn(page, 'evaluate');
    const beforeUrl = page.url();

    const evidence = await collectDomEvidence(page, pageId, canonicalLinks);

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(page.url()).toBe(beforeUrl);
    expect(evidence).toMatchObject({
      pageId,
      title: 'Fixture audit',
      metaDescription: 'Evidence first',
      canonicalUrl: '/canonical-page',
      lang: 'ja-JP',
      headings: [
        { level: 1, text: 'Main heading' },
        { level: 3, text: 'Nested heading' },
      ],
      visibleText: {
        source: 'SEMANTIC_LANDMARKS',
        text: expect.stringContaining('Header text'),
        regions: expect.arrayContaining([
          { kind: 'header', text: 'Header text' },
          { kind: 'navigation', text: 'Primary navigation' },
          { kind: 'aside', text: 'Side note' },
          { kind: 'footer', text: 'Footer text' },
        ]),
      },
      images: [{
        src: expect.stringContaining('data:image/svg+xml'),
        alt: 'tiny image',
        complete: true,
        naturalWidth: 2,
        naturalHeight: 3,
      }],
      forms: [{
        method: 'post',
        action: '/submit',
        fields: [
          { type: 'email', name: 'contact', required: true, labels: ['Email address'] },
          { type: 'checkbox', name: 'terms', required: false, labels: ['Accept'] },
        ],
        submitControls: [
          { type: 'submit', name: 'intent', value: 'send', text: 'Send now' },
          { type: 'submit', name: 'alternate', value: 'Send alternate', text: 'Send alternate' },
        ],
      }],
    });
    expect(evidence.links).toEqual(canonicalLinks);
    expect(evidence.links.map((link) => link.admission.kind)).toEqual([
      'INTERNAL_NAVIGABLE',
      'EXTERNAL_RECORD_ONLY',
      'SPECIAL_SCHEME_RECORD_ONLY',
    ]);
    expect(evidence.links[0]).not.toBe(canonicalLinks[0]);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.headings)).toBe(true);
    expect(Object.isFrozen(evidence.visibleText.regions)).toBe(true);
    expect(Object.isFrozen(evidence.links[0]?.normalized)).toBe(true);
    expect(Object.isFrozen(evidence.links[0]?.admission)).toBe(true);
    expect(Object.isFrozen(evidence.images[0])).toBe(true);
    expect(Object.isFrozen(evidence.forms[0]?.fields[0]?.labels)).toBe(true);
    const mutableOriginal = canonicalLinks[0] as { anchorText: string; normalized: { url?: string } } | undefined;
    if (mutableOriginal !== undefined) {
      mutableOriginal.anchorText = 'mutated after snapshot';
      mutableOriginal.normalized.url = 'https://mutated.invalid/';
    }
    expect(evidence.links[0]).toMatchObject({
      anchorText: 'Pricing plans',
      normalized: { ok: true, url: 'https://example.test/pricing?page=2' },
    });
    await page.close();
  });

  it('falls back to normalized body text only when semantic regions have no useful text', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <html><body>
        <header>   </header>
        <main hidden> Hidden semantic text </main>
        <div> Body\n fallback   text </div>
      </body></html>
    `);

    const evidence = await collectDomEvidence(page, createPageId(9), []);

    expect(evidence.visibleText).toEqual({
      source: 'BODY_FALLBACK',
      text: 'Body fallback text',
      regions: [],
    });
    await page.close();
  });

  it('preserves missing null separately from present-empty document and image attributes', async () => {
    const page = await browser.newPage();
    await page.setContent('<html><head></head><body><img></body></html>');

    const missing = await collectDomEvidence(page, createPageId(13), []);

    expect(missing).toMatchObject({
      title: null,
      metaDescription: null,
      canonicalUrl: null,
      lang: null,
      images: [{ src: null, alt: null }],
    });

    await page.setContent(`
      <html lang=" ">
        <head>
          <title> </title>
          <meta name="description" content=" ">
          <link rel="canonical" href=" ">
        </head>
        <body><img src="" alt=""></body>
      </html>
    `);

    const presentEmpty = await collectDomEvidence(page, createPageId(14), []);

    expect(presentEmpty).toMatchObject({
      title: '',
      metaDescription: '',
      canonicalUrl: '',
      lang: '',
      images: [{ src: '', alt: '' }],
    });
    await page.close();
  });

  it('uses browser form ownership for submitters and reports the effective method', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <form id="primary" method="not-a-method">
        <input name="inside">
        <button type="submit" name="owned">Owned</button>
        <button type="submit" name="borrowed" form="secondary">Borrowed</button>
      </form>
      <form id="secondary"></form>
      <button type="submit" name="external" form="primary">External</button>
    `);

    const evidence = await collectDomEvidence(page, createPageId(15), []);

    expect(evidence.forms).toEqual([
      {
        method: 'get',
        action: '',
        fields: [{ type: 'text', name: 'inside', required: false, labels: [] }],
        submitControls: [
          { type: 'submit', name: 'owned', value: '', text: 'Owned' },
          { type: 'submit', name: 'external', value: '', text: 'External' },
        ],
      },
      {
        method: 'get',
        action: '',
        fields: [],
        submitControls: [{ type: 'submit', name: 'borrowed', value: '', text: 'Borrowed' }],
      },
    ]);
    await page.close();
  });

  it('collects internal and external image submitters by browser ownership in document order', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <input type="image" name="external-before" value="before" form="primary">
      <form id="primary">
        <button type="submit" name="owned-button" value="button">Owned button</button>
        <input type="image" name="internal-image" value="internal">
        <input type="image" name="other-form-image" value="other" form="secondary">
      </form>
      <input type="image" name="external-after" value="after" form="primary">
      <form id="secondary"></form>
    `);

    const evidence = await collectDomEvidence(page, createPageId(17), []);

    expect(evidence.forms[0]?.submitControls).toEqual([
      { type: 'image', name: 'external-before', value: 'before', text: 'before' },
      { type: 'submit', name: 'owned-button', value: 'button', text: 'Owned button' },
      { type: 'image', name: 'internal-image', value: 'internal', text: 'internal' },
      { type: 'image', name: 'external-after', value: 'after', text: 'after' },
    ]);
    expect(evidence.forms[1]?.submitControls).toEqual([
      { type: 'image', name: 'other-form-image', value: 'other', text: 'other' },
    ]);
    await page.close();
  });

  it('retains nested region records but combines text from outermost observed landmarks once', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <header>Site header</header>
      <main>Outer start <form>Nested form</form> Outer end</main>
    `);

    const evidence = await collectDomEvidence(page, createPageId(16), []);

    expect(evidence.visibleText).toEqual({
      source: 'SEMANTIC_LANDMARKS',
      text: 'Site header Outer start Nested form Outer end',
      regions: [
        { kind: 'header', text: 'Site header' },
        { kind: 'main', text: 'Outer start Nested form Outer end' },
        { kind: 'form', text: 'Nested form' },
      ],
    });
    expect(evidence.visibleText.text.match(/Nested form/gu)).toHaveLength(1);
    await page.close();
  });
});

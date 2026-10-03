import type { Browser, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { createPageId } from '../../src/core/ids.js';
import { DOM_LIMITS, collectDomEvidence } from '../../src/evidence/dom-collector.js';
import { useHeadlessChromium } from '../helpers/chromium.js';

let browser: Browser;

useHeadlessChromium((launched) => {
  browser = launched;
});

describe('collectDomEvidence', () => {
  it('collects normalized non-link document facts in one read-only evaluation without copying links', async () => {
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
    const evaluate = vi.spyOn(page, 'evaluate');
    const beforeUrl = page.url();

    const evidence = await collectDomEvidence(page, pageId);

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
          { kind: 'header', text: 'Header text', ariaHidden: false, truncated: false },
          { kind: 'navigation', text: 'Primary navigation', ariaHidden: false, truncated: false },
          { kind: 'aside', text: 'Side note', ariaHidden: false, truncated: false },
          { kind: 'footer', text: 'Footer text', ariaHidden: false, truncated: false },
          { kind: 'other', text: 'Pricing plans External contact Email us', ariaHidden: false, truncated: false },
        ]),
      },
      images: [{
        src: expect.stringContaining('data:image/svg+xml'),
        resolvedUrl: expect.stringContaining('data:image/svg+xml'),
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
    // R'2 の m3: Link は link の Evidence の1か所だけに置き、DOM の Evidence には複製しない。
    expect(Object.keys(evidence)).not.toContain('links');
    expect(Object.keys(evidence.truncation)).not.toContain('omittedLinkCount');
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.headings)).toBe(true);
    expect(Object.isFrozen(evidence.visibleText.regions)).toBe(true);
    expect(Object.isFrozen(evidence.images[0])).toBe(true);
    expect(Object.isFrozen(evidence.forms[0]?.fields[0]?.labels)).toBe(true);
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

    const evidence = await collectDomEvidence(page, createPageId(9));

    expect(evidence.visibleText).toEqual({
      source: 'BODY_FALLBACK',
      text: 'Body fallback text',
      truncated: false,
      nodeLimitReached: false,
      ariaHiddenText: '',
      regions: [],
      omittedRegionCount: 0,
    });
    await page.close();
  });

  it('preserves missing null separately from present-empty document and image attributes', async () => {
    const page = await browser.newPage();
    await page.setContent('<html><head></head><body><img></body></html>');

    const missing = await collectDomEvidence(page, createPageId(13));

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

    const presentEmpty = await collectDomEvidence(page, createPageId(14));

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

    const evidence = await collectDomEvidence(page, createPageId(15));

    expect(evidence.forms).toEqual([
      {
        method: 'get',
        action: '',
        fields: [{
          type: 'text',
          name: 'inside',
          required: false,
          visible: true,
          labels: [],
          hasAriaLabel: false,
          hasAriaLabelledby: false,
          hasTitle: false,
          truncated: false,
        }],
        submitControls: [
          { type: 'submit', name: 'owned', value: '', text: 'Owned', truncated: false },
          { type: 'submit', name: 'external', value: '', text: 'External', truncated: false },
        ],
        omittedFieldCount: 0,
        omittedSubmitControlCount: 0,
        truncated: false,
      },
      {
        method: 'get',
        action: '',
        fields: [],
        submitControls: [{ type: 'submit', name: 'borrowed', value: '', text: 'Borrowed', truncated: false }],
        omittedFieldCount: 0,
        omittedSubmitControlCount: 0,
        truncated: false,
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

    const evidence = await collectDomEvidence(page, createPageId(17));

    expect(evidence.forms[0]?.submitControls).toEqual([
      { type: 'image', name: 'external-before', value: 'before', text: 'before', truncated: false },
      { type: 'submit', name: 'owned-button', value: 'button', text: 'Owned button', truncated: false },
      { type: 'image', name: 'internal-image', value: 'internal', text: 'internal', truncated: false },
      { type: 'image', name: 'external-after', value: 'after', text: 'after', truncated: false },
    ]);
    expect(evidence.forms[1]?.submitControls).toEqual([
      { type: 'image', name: 'other-form-image', value: 'other', text: 'other', truncated: false },
    ]);
    await page.close();
  });

  it('retains nested region records but combines text from outermost observed landmarks once', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <header>Site header</header>
      <main>Outer start <form>Nested form</form> Outer end</main>
    `);

    const evidence = await collectDomEvidence(page, createPageId(16));

    expect(evidence.visibleText).toEqual({
      source: 'SEMANTIC_LANDMARKS',
      text: 'Site header Outer start Nested form Outer end',
      truncated: false,
      nodeLimitReached: false,
      ariaHiddenText: '',
      regions: [
        { kind: 'header', text: 'Site header', ariaHidden: false, truncated: false },
        { kind: 'main', text: 'Outer start Nested form Outer end', ariaHidden: false, truncated: false },
        { kind: 'form', text: 'Nested form', ariaHidden: false, truncated: false },
      ],
      omittedRegionCount: 0,
    });
    expect(evidence.visibleText.text.match(/Nested form/gu)).toHaveLength(1);
    await page.close();
  });
});

describe('collectDomEvidence visibility (V7)', () => {
  it('does not report text of a transparent body as visible text', async () => {
    // レビュー V7 (A) の再現条件: body{opacity:0} で、DOM が本文を可視テキストとして返していた。
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <html><head><style>body { opacity: 0; }</style></head>
        <body><header>Site Header</header><main><p>Transparent body text</p></main></body></html>
      `);

      const evidence = await collectDomEvidence(page, createPageId(30));

      expect(evidence.visibleText.text).toBe('');
      expect(evidence.visibleText.regions).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('excludes transparent descendants and keeps a visibility:visible child of a visibility:hidden ancestor', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <html><body><main>
          <p>Shown text</p>
          <p style="opacity: 0">Transparent text</p>
          <div style="visibility: hidden">Inherited hidden <span style="visibility: visible">Overridden visible</span></div>
        </main></body></html>
      `);

      const evidence = await collectDomEvidence(page, createPageId(31));

      expect(evidence.visibleText.text).toBe('Shown text Overridden visible');
      expect(evidence.visibleText.regions).toEqual([
        { kind: 'main', text: 'Shown text Overridden visible', ariaHidden: false, truncated: false },
      ]);
    } finally {
      await page.close();
    }
  });

  it('keeps visible text of an aria-hidden landmark and records the aria-hidden fact separately', async () => {
    // レビュー V7 (C) の再現条件: <main aria-hidden="true"> を、DOM は除外し、配色は含めていた。
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <html><body>
          <header>Site Header</header>
          <main aria-hidden="true"><p>Decorative main text</p></main>
          <footer>Footer text <span aria-hidden="true">Icon</span></footer>
        </body></html>
      `);

      const evidence = await collectDomEvidence(page, createPageId(32));

      expect(evidence.visibleText).toMatchObject({
        source: 'SEMANTIC_LANDMARKS',
        text: 'Site Header Decorative main text Footer text Icon',
        ariaHiddenText: 'Decorative main text Icon',
        truncated: false,
        regions: [
          { kind: 'header', text: 'Site Header', ariaHidden: false, truncated: false },
          { kind: 'main', text: 'Decorative main text', ariaHidden: true, truncated: false },
          { kind: 'footer', text: 'Footer text Icon', ariaHidden: false, truncated: false },
        ],
      });
    } finally {
      await page.close();
    }
  });
});

describe('collectDomEvidence display:contents and heading visibility (C5b)', () => {
  it('keeps text directly under display:contents elements and judges it by the nearest boxed ancestor', async () => {
    // C5 の報告の発見事項1: display:contents の要素は箱を持たず checkVisibility が false を返すため、直下のテキストが落ちていた。
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <html><body><main>
          <p>Before</p>
          <div style="display:contents">見える文</div>
          <section style="display:contents"><span style="display:contents">Nested contents text</span></section>
          <div style="opacity: 0"><div style="display:contents">Transparent contents text</div></div>
          <div style="display: none"><div style="display:contents">Undisplayed contents text</div></div>
          <p>After</p>
        </main></body></html>
      `);

      const evidence = await collectDomEvidence(page, createPageId(42));

      expect(evidence.visibleText.text).toBe('Before 見える文 Nested contents text After');
      expect(evidence.visibleText.regions).toEqual([
        { kind: 'main', text: 'Before 見える文 Nested contents text After', ariaHidden: false, truncated: false },
      ]);
    } finally {
      await page.close();
    }
  });

  it('applies the inherited visibility of a display:contents parent to its text', async () => {
    // visibility は継承され、display:contents の要素の値がその直下のテキストに効く。箱を持つ祖先の visibility では決まらない。
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <html><body><main>
          <p>Before</p>
          <div style="display:contents; visibility: hidden">Hidden contents text</div>
          <div style="visibility: hidden"><div style="display:contents; visibility: visible">Overridden contents text</div></div>
          <p>After</p>
        </main></body></html>
      `);

      const evidence = await collectDomEvidence(page, createPageId(44));

      expect(evidence.visibleText.text).toBe('Before Overridden contents text After');
    } finally {
      await page.close();
    }
  });

  it('collects only visible headings with the same visibility judgment and traversal as visible text', async () => {
    // C5 の報告の発見事項3: 見出しは innerText で集めており、可視判定をしていなかった。
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <html><body>
          <h1>Visible heading</h1>
          <h2 style="visibility: hidden">Hidden heading</h2>
          <div style="display: none"><h2>Heading in undisplayed ancestor</h2></div>
          <h3 style="opacity: 0">Transparent heading</h3>
          <h2 style="visibility: hidden">Hidden part <span style="visibility: visible">Overridden heading</span></h2>
          <h4 style="display: contents">Contents heading</h4>
          <h5>Shown <span style="display: none">undisplayed</span> title</h5>
        </body></html>
      `);

      const evidence = await collectDomEvidence(page, createPageId(43));

      expect(evidence.headings).toEqual([
        { level: 1, text: 'Visible heading', truncated: false },
        { level: 2, text: 'Overridden heading', truncated: false },
        { level: 4, text: 'Contents heading', truncated: false },
        { level: 5, text: 'Shown title', truncated: false },
      ]);
      expect(evidence.truncation.omittedHeadingCount).toBe(0);
    } finally {
      await page.close();
    }
  });
});

describe('collectDomEvidence visible text outside landmarks (V4)', () => {
  it('keeps body text outside every landmark as the other region when the page has no main', async () => {
    // レビュー V4 の再現条件: header と footer はあるが本文が <div> のページで、結果が "Site Header Footer text" だけになっていた。
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <html><body>
          <header>Site Header</header>
          <div class="content"><h1>Article title</h1><p>Body paragraph text</p></div>
          <footer>Footer text</footer>
        </body></html>
      `);

      const evidence = await collectDomEvidence(page, createPageId(33));

      expect(evidence.visibleText).toEqual({
        source: 'SEMANTIC_LANDMARKS',
        text: 'Site Header Article title Body paragraph text Footer text',
        truncated: false,
        nodeLimitReached: false,
        ariaHiddenText: '',
        omittedRegionCount: 0,
        regions: [
          { kind: 'header', text: 'Site Header', ariaHidden: false, truncated: false },
          { kind: 'footer', text: 'Footer text', ariaHidden: false, truncated: false },
          { kind: 'other', text: 'Article title Body paragraph text', ariaHidden: false, truncated: false },
        ],
      });
    } finally {
      await page.close();
    }
  });
});

describe('collectDomEvidence facts for Task 12 rules (V5)', () => {
  it('records duplicated id values with their counts in document order', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <html><body>
          <div id="dup">One</div><span id="unique">Two</span><p id="dup">Three</p>
          <section id="twice"></section><section id="twice"></section><em id="dup"></em><i id=""></i><b id=""></b>
        </body></html>
      `);

      const evidence = await collectDomEvidence(page, createPageId(34));

      expect(evidence.duplicateIds).toEqual([
        { id: 'dup', count: 3, truncated: false },
        { id: 'twice', count: 2, truncated: false },
      ]);
      expect(evidence.truncation.omittedDuplicateIdCount).toBe(0);
      expect(Object.isFrozen(evidence.duplicateIds)).toBe(true);
      expect(Object.isFrozen(evidence.duplicateIds[0])).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('records whether each field has labels, aria-label, aria-labelledby, and title without deciding its name', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <html><body>
          <span id="external-name">External name</span>
          <form>
            <label for="labelled">Labelled</label><input id="labelled" name="labelled" required>
            <input name="aria-label" aria-label="Search terms" required>
            <input name="aria-labelledby" aria-labelledby="external-name" required>
            <input name="title" title="Postal code" required>
            <input name="blank-attributes" aria-label="  " aria-labelledby="" title=" " required>
            <input name="none" required>
          </form>
        </body></html>
      `);

      const evidence = await collectDomEvidence(page, createPageId(35));
      const facts = evidence.forms[0]?.fields.map((field) => ({
        name: field.name,
        labels: field.labels,
        hasAriaLabel: field.hasAriaLabel,
        hasAriaLabelledby: field.hasAriaLabelledby,
        hasTitle: field.hasTitle,
      }));

      expect(facts).toEqual([
        { name: 'labelled', labels: ['Labelled'], hasAriaLabel: false, hasAriaLabelledby: false, hasTitle: false },
        { name: 'aria-label', labels: [], hasAriaLabel: true, hasAriaLabelledby: false, hasTitle: false },
        { name: 'aria-labelledby', labels: [], hasAriaLabel: false, hasAriaLabelledby: true, hasTitle: false },
        { name: 'title', labels: [], hasAriaLabel: false, hasAriaLabelledby: false, hasTitle: true },
        { name: 'blank-attributes', labels: [], hasAriaLabel: false, hasAriaLabelledby: false, hasTitle: false },
        { name: 'none', labels: [], hasAriaLabel: false, hasAriaLabelledby: false, hasTitle: false },
      ]);
    } finally {
      await page.close();
    }
  });
});

describe('collectDomEvidence resolved image URLs (V14)', () => {
  it('records the resolved URL of each image in addition to the attribute value', async () => {
    const page = await browser.newPage();
    try {
      // 外部へ出ないよう、文書と画像のリクエストはすべてテスト内で応答する。
      const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
      await page.route('**/*', async (route) => {
        if (route.request().resourceType() === 'document') {
          await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `
              <html><body>
                <img id="relative" src="images/a.gif" alt="Relative">
                <img id="parent" src="../b.gif" alt="Parent">
                <img id="srcset" src="images/fallback.gif" srcset="images/chosen.gif 1x" alt="Srcset">
                <img id="missing" alt="Missing">
              </body></html>
            `,
          });
          return;
        }
        await route.fulfill({ status: 200, contentType: 'image/gif', body: pixel });
      });
      await page.goto('http://fixture.invalid/pages/article.html', { waitUntil: 'load' });

      const evidence = await collectDomEvidence(page, createPageId(36));

      expect(evidence.images.map((image) => ({ src: image.src, resolvedUrl: image.resolvedUrl }))).toEqual([
        { src: 'images/a.gif', resolvedUrl: 'http://fixture.invalid/pages/images/a.gif' },
        { src: '../b.gif', resolvedUrl: 'http://fixture.invalid/b.gif' },
        { src: 'images/fallback.gif', resolvedUrl: 'http://fixture.invalid/pages/images/chosen.gif' },
        { src: null, resolvedUrl: null },
      ]);
    } finally {
      await page.close();
    }
  });
});

describe('collectDomEvidence limits and truncation records (V9)', () => {
  it('bounds headings, images, forms, fields, submit controls, and duplicate ids and records omitted counts', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<html><head><title>Limits</title></head><body></body></html>');
      await page.evaluate((limits) => {
        const append = (html: string, count: number): void => {
          const container = document.createElement('div');
          container.innerHTML = Array.from({ length: count }, (_, index) => html.replaceAll('{i}', String(index))).join('');
          document.body.append(container);
        };
        const fields = Array.from({ length: limits.maxFieldsPerForm + 5 }, (_, index) => `<input name="f${index}">`).join('');
        const submits = Array.from(
          { length: limits.maxSubmitControlsPerForm + 6 },
          (_, index) => `<button type="submit" name="s${index}">Send</button>`,
        ).join('');
        append(`<form>${fields}${submits}</form>`, 1);
        append('<form><input name="small"></form>', limits.maxForms);
        append('<h2>Heading {i}</h2>', limits.maxHeadings + 3);
        append('<img alt="Image {i}">', limits.maxImages + 2);
        append('<span id="dup-{i}"></span><span id="dup-{i}"></span>', limits.maxDuplicateIds + 4);
      }, DOM_LIMITS);

      const evidence = await collectDomEvidence(page, createPageId(37));

      expect(evidence.headings).toHaveLength(DOM_LIMITS.maxHeadings);
      expect(evidence.images).toHaveLength(DOM_LIMITS.maxImages);
      expect(evidence.duplicateIds).toHaveLength(DOM_LIMITS.maxDuplicateIds);
      expect(evidence.forms).toHaveLength(DOM_LIMITS.maxForms);
      expect(evidence.forms[0]?.fields).toHaveLength(DOM_LIMITS.maxFieldsPerForm);
      expect(evidence.forms[0]?.submitControls).toHaveLength(DOM_LIMITS.maxSubmitControlsPerForm);
      expect(evidence.forms[0]).toMatchObject({ omittedFieldCount: 5, omittedSubmitControlCount: 6 });
      expect(evidence.forms[1]).toMatchObject({ omittedFieldCount: 0, omittedSubmitControlCount: 0 });
      expect(evidence.truncation).toEqual({
        documentFields: { title: false, metaDescription: false, canonicalUrl: false, lang: false },
        omittedHeadingCount: 3,
        omittedImageCount: 2,
        omittedFormCount: 1,
        omittedUnassociatedFieldCount: 0,
        omittedDuplicateIdCount: 4,
      });
      expect(Object.isFrozen(evidence.truncation)).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('truncates long document fields, headings, labels, attributes, and ids and marks them', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<html><head></head><body></body></html>');
      await page.evaluate((limits) => {
        const long = (length: number): string => 'x'.repeat(length + 10);
        document.title = long(limits.maxDocumentTextLength);
        const heading = document.createElement('h1');
        heading.textContent = long(limits.maxHeadingTextLength);
        const image = document.createElement('img');
        image.alt = long(limits.maxAltLength);
        const form = document.createElement('form');
        form.innerHTML = '<label for="long-field"></label><input id="long-field">';
        (form.querySelector('label') as HTMLLabelElement).textContent = long(limits.maxLabelTextLength);
        (form.querySelector('input') as HTMLInputElement).name = long(limits.maxAttributeLength);
        const first = document.createElement('span');
        first.id = long(limits.maxIdLength);
        const second = document.createElement('span');
        second.id = first.id;
        document.body.append(heading, image, form, first, second);
      }, DOM_LIMITS);

      const evidence = await collectDomEvidence(page, createPageId(38));

      expect(evidence.title).toHaveLength(DOM_LIMITS.maxDocumentTextLength);
      expect(evidence.truncation.documentFields).toEqual({ title: true, metaDescription: false, canonicalUrl: false, lang: false });
      expect(evidence.headings[0]).toMatchObject({ truncated: true });
      expect(evidence.headings[0]?.text).toHaveLength(DOM_LIMITS.maxHeadingTextLength);
      expect(evidence.images[0]).toMatchObject({ truncated: true });
      expect(evidence.images[0]?.alt).toHaveLength(DOM_LIMITS.maxAltLength);
      expect(evidence.forms[0]?.fields[0]).toMatchObject({ truncated: true });
      expect(evidence.forms[0]?.fields[0]?.name).toHaveLength(DOM_LIMITS.maxAttributeLength);
      expect(evidence.forms[0]?.fields[0]?.labels[0]).toHaveLength(DOM_LIMITS.maxLabelTextLength);
      expect(evidence.duplicateIds[0]).toMatchObject({ count: 2, truncated: true });
      expect(evidence.duplicateIds[0]?.id).toHaveLength(DOM_LIMITS.maxIdLength);
    } finally {
      await page.close();
    }
  });

  it('marks the truncation of a canonical URL longer than the URL limit on the canonical field only (R\'\'2 m4)', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<html lang="ja"><head><title>Short</title><meta name="description" content="Short"></head><body></body></html>');
      await page.evaluate((maxUrlLength) => {
        const canonical = document.createElement('link');
        canonical.rel = 'canonical';
        canonical.href = `https://canonical.test/${'c'.repeat(maxUrlLength)}`;
        document.head.append(canonical);
      }, DOM_LIMITS.maxUrlLength);

      const evidence = await collectDomEvidence(page, createPageId(39));

      expect(evidence.canonicalUrl).toHaveLength(DOM_LIMITS.maxUrlLength);
      expect(evidence.truncation.documentFields).toEqual({
        title: false,
        metaDescription: false,
        canonicalUrl: true,
        lang: false,
      });
      expect(Object.isFrozen(evidence.truncation.documentFields)).toBe(true);
    } finally {
      await page.close();
    }
  });

  it.each([
    ['title', 'maxDocumentTextLength'],
    ['metaDescription', 'maxDocumentTextLength'],
    ['canonicalUrl', 'maxUrlLength'],
    ['lang', 'maxDocumentTextLength'],
  ] as const)('marks the truncation of %s separately from the other document fields (R\'\'2 m4)', async (field, limitName) => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <html lang="ja">
          <head><title>Short</title><meta name="description" content="Short"><link rel="canonical" href="/short"></head>
          <body></body>
        </html>
      `);
      await page.evaluate(({ field: target, length }) => {
        const value = 'v'.repeat(length + 10);
        if (target === 'title') {
          document.title = value;
        } else if (target === 'metaDescription') {
          document.querySelector('meta[name="description"]')?.setAttribute('content', value);
        } else if (target === 'canonicalUrl') {
          document.querySelector('link[rel="canonical"]')?.setAttribute('href', value);
        } else {
          document.documentElement.setAttribute('lang', value);
        }
      }, { field, length: DOM_LIMITS[limitName] });

      const evidence = await collectDomEvidence(page, createPageId(40));

      expect(evidence[field]).toHaveLength(DOM_LIMITS[limitName]);
      expect(evidence.truncation.documentFields).toEqual({
        title: field === 'title',
        metaDescription: field === 'metaDescription',
        canonicalUrl: field === 'canonicalUrl',
        lang: field === 'lang',
      });
    } finally {
      await page.close();
    }
  });

  it('bounds visible text and region text and marks the truncation', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<html><body><header></header><div id="body-text"></div></body></html>');
      await page.evaluate((limits) => {
        (document.querySelector('header') as HTMLElement).textContent = 'h'.repeat(limits.maxRegionTextLength + 10);
        (document.querySelector('#body-text') as HTMLElement).textContent = 'b'.repeat(limits.maxVisibleTextLength);
      }, DOM_LIMITS);

      const evidence = await collectDomEvidence(page, createPageId(39));

      expect(evidence.visibleText.truncated).toBe(true);
      expect(evidence.visibleText.nodeLimitReached).toBe(false);
      expect(evidence.visibleText.text.length).toBeLessThanOrEqual(DOM_LIMITS.maxVisibleTextLength);
      expect(evidence.visibleText.regions[0]).toMatchObject({ kind: 'header', truncated: true });
      expect(evidence.visibleText.regions[0]?.text).toHaveLength(DOM_LIMITS.maxRegionTextLength);
    } finally {
      await page.close();
    }
  });

  it('stops walking at the node budget and marks the visible text as truncated', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<html><body><main id="root"></main><footer>Late footer text</footer></body></html>');
      await page.evaluate((limits) => {
        const root = document.querySelector('#root') as HTMLElement;
        const fragment = document.createDocumentFragment();
        for (let index = 0; index < limits.maxTextWalkNodes; index += 1) {
          fragment.append(document.createElement('span'));
        }
        root.append(fragment);
      }, DOM_LIMITS);

      const evidence = await collectDomEvidence(page, createPageId(40));

      // R4 の M2: ノード数の上限に達したことは、文字数による切り詰め（`truncated`）とは別の印で記録する。
      expect(evidence.visibleText.nodeLimitReached).toBe(true);
      expect(evidence.visibleText.truncated).toBe(false);
      expect(evidence.visibleText.text).not.toContain('Late footer text');
    } finally {
      await page.close();
    }
  });

  it('bounds the number of landmark regions and records the omitted count', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<html><body></body></html>');
      await page.evaluate((limits) => {
        document.body.innerHTML = Array.from(
          { length: limits.maxRegions + 7 },
          (_, index) => `<aside>Aside ${index}</aside>`,
        ).join('');
      }, DOM_LIMITS);

      const evidence = await collectDomEvidence(page, createPageId(41));

      expect(evidence.visibleText.regions).toHaveLength(DOM_LIMITS.maxRegions);
      expect(evidence.visibleText.omittedRegionCount).toBe(7);
    } finally {
      await page.close();
    }
  });
});

describe('collectDomEvidence fields outside forms (R4 N2)', () => {
  it('records input fields that do not belong to any form, with the visibility of each field', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <html><body>
          <div><input required type=email></div>
          <label for="country">Country</label><select id="country" name="country"></select>
          <textarea name="note" style="display:none"></textarea>
          <input type="button" value="Not a field">
          <form><input name="in-form"><input name="hidden-in-form" style="visibility:hidden"></form>
          <input name="owned-by-form" form="owner"><form id="owner"></form>
        </body></html>
      `);

      const evidence = await collectDomEvidence(page, createPageId(50));

      expect(evidence.unassociatedFields).toEqual([
        {
          type: 'email',
          name: '',
          required: true,
          visible: true,
          labels: [],
          hasAriaLabel: false,
          hasAriaLabelledby: false,
          hasTitle: false,
          truncated: false,
        },
        {
          type: 'select-one',
          name: 'country',
          required: false,
          visible: true,
          labels: ['Country'],
          hasAriaLabel: false,
          hasAriaLabelledby: false,
          hasTitle: false,
          truncated: false,
        },
        {
          type: 'textarea',
          name: 'note',
          required: false,
          visible: false,
          labels: [],
          hasAriaLabel: false,
          hasAriaLabelledby: false,
          hasTitle: false,
          truncated: false,
        },
      ]);
      expect(evidence.truncation.omittedUnassociatedFieldCount).toBe(0);
      expect(evidence.forms[0]?.fields.map((field) => ({ name: field.name, visible: field.visible }))).toEqual([
        { name: 'in-form', visible: true },
        { name: 'hidden-in-form', visible: false },
      ]);
      expect(evidence.forms[1]?.fields.map((field) => field.name)).toEqual(['owned-by-form']);
      expect(Object.isFrozen(evidence.unassociatedFields)).toBe(true);
      expect(Object.isFrozen(evidence.unassociatedFields[0])).toBe(true);
      expect(Object.isFrozen(evidence.unassociatedFields[1]?.labels)).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('bounds the fields outside forms and records the omitted count', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<html><body></body></html>');
      await page.evaluate((limits) => {
        document.body.innerHTML = Array.from(
          { length: limits.maxUnassociatedFields + 3 },
          (_, index) => `<input name="loose-${index}">`,
        ).join('');
      }, DOM_LIMITS);

      const evidence = await collectDomEvidence(page, createPageId(51));

      expect(evidence.unassociatedFields).toHaveLength(DOM_LIMITS.maxUnassociatedFields);
      expect(evidence.unassociatedFields[0]?.name).toBe('loose-0');
      expect(evidence.truncation.omittedUnassociatedFieldCount).toBe(3);
    } finally {
      await page.close();
    }
  });
});

describe('collectDomEvidence without a copy of Link (R\'2 m3)', () => {
  it('takes only the page and the page id, and leaves the links and their omitted count to link Evidence', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<html><body><a href="/one">One</a> <a href="/two">Two</a></body></html>');

      const evidence = await collectDomEvidence(page, createPageId(53));

      expect(collectDomEvidence).toHaveLength(2);
      expect(evidence).not.toHaveProperty('links');
      expect(evidence.truncation).not.toHaveProperty('omittedLinkCount');
      // リンクのテキストは、DOM の事実（可視テキスト）としては記録する。
      expect(evidence.visibleText.text).toBe('One Two');
    } finally {
      await page.close();
    }
  });
});

describe('collectDomEvidence fields in open shadow roots (R\'2 m4)', () => {
  it('records the fields inside open shadow roots as fields outside forms, in document order', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <html><body>
          <input name="before-host">
          <div id="host"></div>
          <input name="after-host">
          <div id="closed-host"></div>
        </body></html>
      `);
      await page.evaluate(() => {
        const root = (document.querySelector('#host') as HTMLElement).attachShadow({ mode: 'open' });
        root.innerHTML = '<label for="inner-email">Email</label><input id="inner-email" type="email" name="inner-email" required>'
          + '<div id="nested-host"></div>'
          + '<form><textarea name="inner-form-note"></textarea></form>';
        const nested = (root.querySelector('#nested-host') as HTMLElement).attachShadow({ mode: 'open' });
        nested.innerHTML = '<select name="nested-select" aria-label="Nested"></select>';
        const closed = (document.querySelector('#closed-host') as HTMLElement).attachShadow({ mode: 'closed' });
        closed.innerHTML = '<input name="closed-field">';
      });

      const evidence = await collectDomEvidence(page, createPageId(55));

      expect(evidence.unassociatedFields.map((field) => field.name)).toEqual([
        'before-host',
        'inner-email',
        'nested-select',
        'inner-form-note',
        'after-host',
      ]);
      expect(evidence.unassociatedFields[1]).toMatchObject({
        type: 'email',
        required: true,
        visible: true,
        labels: ['Email'],
      });
      expect(evidence.unassociatedFields[2]).toMatchObject({ type: 'select-one', hasAriaLabel: true });
      expect(evidence.forms).toEqual([]);
      expect(evidence.truncation.omittedUnassociatedFieldCount).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('bounds the fields inside open shadow roots together with the other fields outside forms', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<html><body><input name="light-0"><div id="host"></div></body></html>');
      await page.evaluate((limits) => {
        const root = (document.querySelector('#host') as HTMLElement).attachShadow({ mode: 'open' });
        root.innerHTML = Array.from(
          { length: limits.maxUnassociatedFields + 2 },
          (_, index) => `<input name="shadow-${index}">`,
        ).join('');
      }, DOM_LIMITS);

      const evidence = await collectDomEvidence(page, createPageId(56));

      expect(evidence.unassociatedFields).toHaveLength(DOM_LIMITS.maxUnassociatedFields);
      expect(evidence.unassociatedFields[0]?.name).toBe('light-0');
      expect(evidence.unassociatedFields[1]?.name).toBe('shadow-0');
      expect(evidence.truncation.omittedUnassociatedFieldCount).toBe(3);
    } finally {
      await page.close();
    }
  });
});

describe('collectDomEvidence scroll position (R4 M1)', () => {
  it('records the document scroll position at the time of collection', async () => {
    const page = await browser.newPage();
    try {
      await page.setViewportSize({ width: 400, height: 300 });
      await page.setContent('<html><body style="margin:0"><div style="height:3000px">Tall</div></body></html>');
      await page.evaluate(() => window.scrollTo(0, 700));

      const evidence = await collectDomEvidence(page, createPageId(52));

      expect(evidence.scrollPosition).toEqual({ scrollX: 0, scrollY: 700 });
      expect(Object.isFrozen(evidence.scrollPosition)).toBe(true);
    } finally {
      await page.close();
    }
  });
});

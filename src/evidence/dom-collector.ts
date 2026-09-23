import type { Page } from 'playwright';
import type { PageId } from '../core/contracts.js';
import type { LinkEvidence } from '../crawl/discover-links.js';

export interface HeadingEvidence {
  readonly level: number;
  readonly text: string;
}

export type SemanticRegionKind = 'header' | 'navigation' | 'main' | 'aside' | 'footer' | 'form';

export interface SemanticRegionEvidence {
  readonly kind: SemanticRegionKind;
  readonly text: string;
}

export interface VisibleTextEvidence {
  readonly source: 'SEMANTIC_LANDMARKS' | 'BODY_FALLBACK';
  readonly text: string;
  readonly regions: readonly SemanticRegionEvidence[];
}

export interface ImageDomEvidence {
  readonly src: string | null;
  readonly alt: string | null;
  readonly complete: boolean;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

export interface FormFieldEvidence {
  readonly type: string;
  readonly name: string;
  readonly required: boolean;
  readonly labels: readonly string[];
}

export interface SubmitControlEvidence {
  readonly type: 'submit' | 'image';
  readonly name: string;
  readonly value: string;
  readonly text: string;
}

export interface FormDomEvidence {
  readonly method: string;
  readonly action: string;
  readonly fields: readonly FormFieldEvidence[];
  readonly submitControls: readonly SubmitControlEvidence[];
}

export interface DomEvidence {
  readonly pageId: PageId;
  readonly title: string | null;
  readonly metaDescription: string | null;
  readonly canonicalUrl: string | null;
  readonly lang: string | null;
  readonly headings: readonly HeadingEvidence[];
  readonly visibleText: VisibleTextEvidence;
  readonly links: readonly LinkEvidence[];
  readonly images: readonly ImageDomEvidence[];
  readonly forms: readonly FormDomEvidence[];
}

interface RawDomEvidence {
  readonly title: string | null;
  readonly metaDescription: string | null;
  readonly canonicalUrl: string | null;
  readonly lang: string | null;
  readonly headings: readonly HeadingEvidence[];
  readonly visibleText: VisibleTextEvidence;
  readonly images: readonly ImageDomEvidence[];
  readonly forms: readonly FormDomEvidence[];
}

function copyLinks(links: readonly LinkEvidence[]): readonly LinkEvidence[] {
  return Object.freeze(links.map((link) => Object.freeze({
    ...link,
    normalized: Object.freeze({ ...link.normalized }),
    admission: Object.freeze({ ...link.admission }),
  })));
}

function freezeDomEvidence(raw: RawDomEvidence, pageId: PageId, links: readonly LinkEvidence[]): DomEvidence {
  const headings = Object.freeze(raw.headings.map((heading) => Object.freeze({ ...heading })));
  const regions = Object.freeze(raw.visibleText.regions.map((region) => Object.freeze({ ...region })));
  const images = Object.freeze(raw.images.map((image) => Object.freeze({ ...image })));
  const forms = Object.freeze(raw.forms.map((form) => Object.freeze({
    ...form,
    fields: Object.freeze(form.fields.map((field) => Object.freeze({
      ...field,
      labels: Object.freeze([...field.labels]),
    }))),
    submitControls: Object.freeze(form.submitControls.map((control) => Object.freeze({ ...control }))),
  })));

  return Object.freeze({
    pageId,
    title: raw.title,
    metaDescription: raw.metaDescription,
    canonicalUrl: raw.canonicalUrl,
    lang: raw.lang,
    headings,
    visibleText: Object.freeze({ ...raw.visibleText, regions }),
    links: copyLinks(links),
    images,
    forms,
  });
}

/** Task 3の正規リンク証跡を再利用しつつ、読み取り専用のドキュメント観測結果を収集する。 */
export async function collectDomEvidence(
  page: Page,
  pageId: PageId,
  links: readonly LinkEvidence[],
): Promise<DomEvidence> {
  const raw = await page.evaluate((): RawDomEvidence => {
    const normalizeWhitespace = (value: string | null): string => value?.replace(/\s+/gu, ' ').trim() ?? '';
    const normalizeNullable = (value: string | null): string | null => (
      value === null ? null : normalizeWhitespace(value)
    );
    const isVisible = (element: HTMLElement): boolean => {
      const style = window.getComputedStyle(element);
      return !element.hidden
        && element.getAttribute('aria-hidden') !== 'true'
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.visibility !== 'collapse'
        && element.getClientRects().length > 0;
    };
    const visibleText = (element: HTMLElement): string => (
      isVisible(element) ? normalizeWhitespace(element.innerText) : ''
    );
    const labelsFor = (field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): readonly string[] => (
      [...(field.labels ?? [])]
        .map((label) => visibleText(label))
        .filter((label) => label.length > 0)
    );

    const titleElement = document.querySelector('title');
    const metaDescription = document.querySelector('meta[name="description" i]');
    const canonical = document.querySelector('link[rel~="canonical" i]');
    const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((element) => ({
      level: Number.parseInt(element.tagName.slice(1), 10),
      text: normalizeWhitespace((element as HTMLElement).innerText),
    }));
    const regionKinds: Readonly<Record<string, SemanticRegionKind>> = {
      HEADER: 'header',
      NAV: 'navigation',
      MAIN: 'main',
      ASIDE: 'aside',
      FOOTER: 'footer',
      FORM: 'form',
    };
    const observedRegions: Array<{
      readonly element: Element;
      readonly evidence: SemanticRegionEvidence;
    }> = [];
    for (const element of document.querySelectorAll('header, nav, main, aside, footer, form')) {
      const text = visibleText(element as HTMLElement);
      const kind = regionKinds[element.tagName];
      if (text.length > 0 && kind !== undefined) {
        observedRegions.push({ element, evidence: { kind, text } });
      }
    }
    const regions = observedRegions.map((region) => region.evidence);
    const outermostRegions = observedRegions.filter((candidate) => !observedRegions.some((other) => (
      other.element !== candidate.element && other.element.contains(candidate.element)
    )));
    const combinedSemanticText = normalizeWhitespace(outermostRegions.map((region) => region.evidence.text).join(' '));
    const bodyText = normalizeWhitespace(document.body?.innerText ?? '');
    const images = [...document.images].map((image): ImageDomEvidence => ({
      src: normalizeNullable(image.getAttribute('src')),
      alt: normalizeNullable(image.getAttribute('alt')),
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    }));
    const submitControlCandidates = [...document.querySelectorAll('button, input')]
      .filter((control): control is HTMLButtonElement | HTMLInputElement => (
        control instanceof HTMLButtonElement || control instanceof HTMLInputElement
      ))
      .filter((control) => control.type === 'submit' || control.type === 'image');
    const forms = [...document.forms].map((form): FormDomEvidence => {
      const fields = [...form.elements]
        .filter((element): element is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement => (
          element instanceof HTMLInputElement
          || element instanceof HTMLSelectElement
          || element instanceof HTMLTextAreaElement
        ))
        .filter((field) => !(field instanceof HTMLInputElement && ['submit', 'image', 'button', 'reset'].includes(field.type)))
        .map((field): FormFieldEvidence => ({
          type: field instanceof HTMLTextAreaElement ? 'textarea' : field.type,
          name: normalizeWhitespace(field.getAttribute('name')),
          required: field.required,
          labels: labelsFor(field),
        }));
      const submitControls = submitControlCandidates
        .filter((control) => control.form === form)
        .map((control): SubmitControlEvidence => {
          const text = control instanceof HTMLButtonElement ? control.innerText : control.value;
          return {
            type: control.type === 'image' ? 'image' : 'submit',
            name: normalizeWhitespace(control.getAttribute('name')),
            value: normalizeWhitespace(control.value),
            text: normalizeWhitespace(text),
          };
        });
      return {
        method: normalizeWhitespace(form.method).toLowerCase(),
        action: normalizeWhitespace(form.getAttribute('action')),
        fields,
        submitControls,
      };
    });

    return {
      title: titleElement === null ? null : normalizeWhitespace(document.title),
      metaDescription: metaDescription === null ? null : normalizeNullable(metaDescription.getAttribute('content')),
      canonicalUrl: canonical === null ? null : normalizeNullable(canonical.getAttribute('href')),
      lang: normalizeNullable(document.documentElement.getAttribute('lang')),
      headings,
      visibleText: combinedSemanticText.length > 0
        ? { source: 'SEMANTIC_LANDMARKS', text: combinedSemanticText, regions }
        : { source: 'BODY_FALLBACK', text: bodyText, regions: [] },
      images,
      forms,
    };
  });

  return freezeDomEvidence(raw, pageId, links);
}

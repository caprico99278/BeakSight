import type { Page } from 'playwright';
import type { Viewport } from '../config/types.js';

export const LAYOUT_THRESHOLDS = Object.freeze({
  stressViewportHeight: 900,
  minOcclusionAreaPx2: 1,
  maxZeroSizeDimensionPx: 0,
  geometryEpsilonPx: 0.5,
  maxOutsideViewportCandidates: 100,
  maxZeroSizeInteractiveCandidates: 100,
  maxClippedTextCandidates: 100,
  maxFixedHeadingOverlapCandidates: 100,
  maxClippedTextLength: 256,
  maxSelectorLength: 512,
  maxSelectorDepth: 8,
  viewportMatchTolerancePx: 0,
  minViewportIntersectionDimensionPx: 0,
});

export const STRESS_VIEWPORT_HEIGHT = LAYOUT_THRESHOLDS.stressViewportHeight;

export interface RectangleEvidence {
  readonly x: number;
  readonly y: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface VisibilityEvidence {
  readonly visible: boolean;
  readonly display: string;
  readonly visibility: string;
  readonly opacity: number;
  readonly hiddenAttribute: boolean;
  readonly ariaHidden: boolean;
  readonly clientRectCount: number;
}

export interface LayoutDocumentEvidence {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly documentElementClientWidth: number;
  readonly documentElementClientHeight: number;
  readonly documentElementScrollWidth: number;
  readonly documentElementScrollHeight: number;
  readonly bodyScrollWidth: number;
  readonly bodyScrollHeight: number;
  readonly bodyClientWidth: number;
  readonly bodyClientHeight: number;
  readonly horizontalOverflowPx: number;
}

export interface OutsideViewportEvidence {
  readonly selector: string;
  readonly rect: RectangleEvidence;
  readonly visibility: VisibilityEvidence;
  readonly position: string;
  readonly zIndex: string;
  readonly overflowX: string;
  readonly overflowY: string;
  readonly outside: {
    readonly left: boolean;
    readonly right: boolean;
    readonly top: boolean;
    readonly bottom: boolean;
  };
}

export interface ZeroSizeInteractiveEvidence {
  readonly selector: string;
  readonly tagName: string;
  readonly role: string | null;
  readonly rect: RectangleEvidence;
  readonly visibility: VisibilityEvidence;
  readonly position: string;
  readonly zIndex: string;
  readonly overflowX: string;
  readonly overflowY: string;
}

export interface ClippedTextEvidence {
  readonly selector: string;
  readonly text: string;
  readonly rect: RectangleEvidence;
  readonly visibility: VisibilityEvidence;
  readonly overflowX: string;
  readonly overflowY: string;
  readonly position: string;
  readonly zIndex: string;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly widthClipped: boolean;
  readonly heightClipped: boolean;
}

export interface FixedHeadingOverlapEvidence {
  readonly overlaySelector: string;
  readonly headingSelector: string;
  readonly overlayRect: RectangleEvidence;
  readonly headingRect: RectangleEvidence;
  readonly overlayVisibility: VisibilityEvidence;
  readonly headingVisibility: VisibilityEvidence;
  readonly overlayPosition: 'fixed' | 'sticky';
  readonly overlayZIndex: string;
  readonly overlayOverflowX: string;
  readonly overlayOverflowY: string;
  readonly headingPosition: string;
  readonly headingZIndex: string;
  readonly headingOverflowX: string;
  readonly headingOverflowY: string;
  readonly intersection: RectangleEvidence & { readonly area: number };
}

export interface LayoutEvidence {
  readonly document: LayoutDocumentEvidence;
  readonly boxesOutsideViewport: readonly OutsideViewportEvidence[];
  readonly zeroSizeInteractive: readonly ZeroSizeInteractiveEvidence[];
  readonly clippedText: readonly ClippedTextEvidence[];
  readonly fixedHeadingOverlaps: readonly FixedHeadingOverlapEvidence[];
}

interface RawLayoutEvidence extends LayoutEvidence {}

export interface PassiveStressSession {
  readonly page: Page;
  close(): Promise<void>;
}

export type PassiveStressSessionFactory = (viewport: Viewport) => Promise<PassiveStressSession>;

export interface StressLayoutEvidence {
  readonly width: number;
  readonly height: number;
  readonly layout: LayoutEvidence;
}

function positiveFiniteDimension(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid non-finite browser geometry: ${name}`);
  }
}

function nonnegative(value: number, name: string): void {
  finite(value, name);
  if (value < 0) {
    throw new Error(`Invalid negative browser geometry: ${name}`);
  }
}

function freezeRect(rect: RectangleEvidence, name: string): RectangleEvidence {
  finite(rect.x, `${name}.x`);
  finite(rect.y, `${name}.y`);
  finite(rect.top, `${name}.top`);
  finite(rect.right, `${name}.right`);
  finite(rect.bottom, `${name}.bottom`);
  finite(rect.left, `${name}.left`);
  nonnegative(rect.width, `${name}.width`);
  nonnegative(rect.height, `${name}.height`);
  return Object.freeze({ ...rect });
}

function freezeVisibility(visibility: VisibilityEvidence, name: string): VisibilityEvidence {
  finite(visibility.opacity, `${name}.opacity`);
  nonnegative(visibility.clientRectCount, `${name}.clientRectCount`);
  return Object.freeze({ ...visibility });
}

function validateSelector(selector: string, name: string): string {
  if (selector.length === 0 || selector.length > LAYOUT_THRESHOLDS.maxSelectorLength) {
    throw new Error(`Invalid or unbounded browser selector: ${name}`);
  }
  return selector;
}

function freezeLayout(raw: RawLayoutEvidence): LayoutEvidence {
  for (const [name, value] of Object.entries(raw.document)) {
    if (name === 'horizontalOverflowPx') {
      finite(value, `document.${name}`);
    } else {
      nonnegative(value, `document.${name}`);
    }
  }
  const horizontalOverflowPx = Math.max(
    0,
    raw.document.documentElementScrollWidth,
    raw.document.bodyScrollWidth,
  ) - raw.document.viewportWidth;
  const documentEvidence = Object.freeze({
    ...raw.document,
    horizontalOverflowPx: Math.max(0, horizontalOverflowPx),
  });
  const boxesOutsideViewport = Object.freeze(raw.boxesOutsideViewport
    .slice(0, LAYOUT_THRESHOLDS.maxOutsideViewportCandidates)
    .map((candidate, index) => Object.freeze({
      ...candidate,
      selector: validateSelector(candidate.selector, `boxesOutsideViewport[${index}]`),
      rect: freezeRect(candidate.rect, `boxesOutsideViewport[${index}].rect`),
      visibility: freezeVisibility(candidate.visibility, `boxesOutsideViewport[${index}].visibility`),
      outside: Object.freeze({ ...candidate.outside }),
    })));
  const zeroSizeInteractive = Object.freeze(raw.zeroSizeInteractive
    .slice(0, LAYOUT_THRESHOLDS.maxZeroSizeInteractiveCandidates)
    .map((candidate, index) => Object.freeze({
      ...candidate,
      selector: validateSelector(candidate.selector, `zeroSizeInteractive[${index}]`),
      rect: freezeRect(candidate.rect, `zeroSizeInteractive[${index}].rect`),
      visibility: freezeVisibility(candidate.visibility, `zeroSizeInteractive[${index}].visibility`),
    })));
  const clippedText = Object.freeze(raw.clippedText
    .slice(0, LAYOUT_THRESHOLDS.maxClippedTextCandidates)
    .map((candidate, index) => {
      nonnegative(candidate.clientWidth, `clippedText[${index}].clientWidth`);
      nonnegative(candidate.clientHeight, `clippedText[${index}].clientHeight`);
      nonnegative(candidate.scrollWidth, `clippedText[${index}].scrollWidth`);
      nonnegative(candidate.scrollHeight, `clippedText[${index}].scrollHeight`);
      return Object.freeze({
        ...candidate,
        selector: validateSelector(candidate.selector, `clippedText[${index}]`),
        text: candidate.text.slice(0, LAYOUT_THRESHOLDS.maxClippedTextLength),
        rect: freezeRect(candidate.rect, `clippedText[${index}].rect`),
        visibility: freezeVisibility(candidate.visibility, `clippedText[${index}].visibility`),
      });
    }));
  const fixedHeadingOverlaps = Object.freeze(raw.fixedHeadingOverlaps
    .slice(0, LAYOUT_THRESHOLDS.maxFixedHeadingOverlapCandidates)
    .map((candidate, index) => {
      nonnegative(candidate.intersection.area, `fixedHeadingOverlaps[${index}].intersection.area`);
      return Object.freeze({
        ...candidate,
        overlaySelector: validateSelector(candidate.overlaySelector, `fixedHeadingOverlaps[${index}].overlay`),
        headingSelector: validateSelector(candidate.headingSelector, `fixedHeadingOverlaps[${index}].heading`),
        overlayRect: freezeRect(candidate.overlayRect, `fixedHeadingOverlaps[${index}].overlayRect`),
        headingRect: freezeRect(candidate.headingRect, `fixedHeadingOverlaps[${index}].headingRect`),
        overlayVisibility: freezeVisibility(
          candidate.overlayVisibility,
          `fixedHeadingOverlaps[${index}].overlayVisibility`,
        ),
        headingVisibility: freezeVisibility(
          candidate.headingVisibility,
          `fixedHeadingOverlaps[${index}].headingVisibility`,
        ),
        intersection: Object.freeze({
          ...freezeRect(candidate.intersection, `fixedHeadingOverlaps[${index}].intersection`),
          area: candidate.intersection.area,
        }),
      });
    }));

  return Object.freeze({
    document: documentEvidence,
    boxesOutsideViewport,
    zeroSizeInteractive,
    clippedText,
    fixedHeadingOverlaps,
  });
}

/** 上限付き・読み取り専用のジオメトリ観測結果を、単一のブラウザevaluationで収集する。 */
export async function collectLayoutEvidence(page: Page, viewport: Viewport): Promise<LayoutEvidence> {
  positiveFiniteDimension(viewport.width, 'Layout viewport width');
  positiveFiniteDimension(viewport.height, 'Layout viewport height');
  const viewportSnapshot = Object.freeze({ width: viewport.width, height: viewport.height });
  const raw = await page.evaluate((thresholds): RawLayoutEvidence => {
    const actualViewport = { width: window.innerWidth, height: window.innerHeight };
    const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();
    const selectorFor = (element: Element): string => {
      if (element.id.length > 0) {
        return `#${CSS.escape(element.id)}`.slice(0, thresholds.maxSelectorLength);
      }
      const segments: string[] = [];
      let current: Element | null = element;
      while (
        current !== null
        && current !== document.documentElement
        && segments.length < thresholds.maxSelectorDepth
      ) {
        const tag = current.tagName.toLowerCase();
        let index = 1;
        let sibling = current.previousElementSibling;
        while (sibling !== null) {
          if (sibling.tagName === current.tagName) {
            index += 1;
          }
          sibling = sibling.previousElementSibling;
        }
        segments.unshift(`${tag}:nth-of-type(${index})`);
        current = current.parentElement;
      }
      return segments.join(' > ').slice(0, thresholds.maxSelectorLength);
    };
    const rectFor = (element: Element): RectangleEvidence => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
    };
    const visibilityFor = (element: Element): VisibilityEvidence => {
      const style = window.getComputedStyle(element);
      const hiddenAttribute = element instanceof HTMLElement ? element.hidden !== false : false;
      const ariaHidden = element.getAttribute('aria-hidden') === 'true';
      const clientRectCount = element.getClientRects().length;
      const opacity = Number.parseFloat(style.opacity);
      let visuallySuppressed = false;
      let current: Element | null = element;
      while (current !== null) {
        const currentStyle = window.getComputedStyle(current);
        const currentOpacity = Number.parseFloat(currentStyle.opacity);
        if (
          (current instanceof HTMLElement && current.hidden !== false)
          || currentStyle.display === 'none'
          || currentStyle.visibility === 'hidden'
          || currentStyle.visibility === 'collapse'
          || !Number.isFinite(currentOpacity)
          || currentOpacity <= 0
        ) {
          visuallySuppressed = true;
          break;
        }
        current = current.parentElement;
      }
      return {
        visible: !visuallySuppressed && clientRectCount > 0,
        display: style.display,
        visibility: style.visibility,
        opacity,
        hiddenAttribute,
        ariaHidden,
        clientRectCount,
      };
    };
    const allElements = [...(document.body?.querySelectorAll('*') ?? [])];
    const priorityOutsideViewport: OutsideViewportEvidence[] = [];
    const ordinaryOutsideViewport: OutsideViewportEvidence[] = [];
    const zeroSizeInteractive: ZeroSizeInteractiveEvidence[] = [];
    const clippedText: ClippedTextEvidence[] = [];

    for (const element of allElements) {
      const rect = rectFor(element);
      const visibility = visibilityFor(element);
      const computed = window.getComputedStyle(element);
      if (!visibility.visible) {
        continue;
      }
      const outside = {
        left: rect.left < -thresholds.geometryEpsilonPx,
        right: rect.right > actualViewport.width + thresholds.geometryEpsilonPx,
        top: rect.top < -thresholds.geometryEpsilonPx,
        bottom: rect.bottom > actualViewport.height + thresholds.geometryEpsilonPx,
      };
      if (
        outside.left || outside.right || outside.top || outside.bottom
      ) {
        const candidate = {
          selector: selectorFor(element),
          rect,
          visibility,
          position: computed.position,
          zIndex: computed.zIndex,
          overflowX: computed.overflowX,
          overflowY: computed.overflowY,
          outside,
        };
        const prioritized = outside.left
          || outside.right
          || computed.position === 'fixed'
          || computed.position === 'sticky';
        const retained = prioritized ? priorityOutsideViewport : ordinaryOutsideViewport;
        if (retained.length < thresholds.maxOutsideViewportCandidates) {
          retained.push(candidate);
        }
      }

      if (
        zeroSizeInteractive.length < thresholds.maxZeroSizeInteractiveCandidates
        && element.matches('a[href], button, input, select, textarea, [role="button"], [role="link"]')
        && (rect.width <= thresholds.maxZeroSizeDimensionPx || rect.height <= thresholds.maxZeroSizeDimensionPx)
      ) {
        zeroSizeInteractive.push({
          selector: selectorFor(element),
          tagName: element.tagName.toLowerCase(),
          role: element.getAttribute('role'),
          rect,
          visibility,
          position: computed.position,
          zIndex: computed.zIndex,
          overflowX: computed.overflowX,
          overflowY: computed.overflowY,
        });
      }

      if (clippedText.length < thresholds.maxClippedTextCandidates && element instanceof HTMLElement) {
        const text = normalize(element.innerText);
        const style = computed;
        const widthClipped = element.scrollWidth > element.clientWidth + thresholds.geometryEpsilonPx
          && ['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowX);
        const heightClipped = element.scrollHeight > element.clientHeight + thresholds.geometryEpsilonPx
          && ['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowY);
        if (text.length > 0 && (widthClipped || heightClipped)) {
          clippedText.push({
            selector: selectorFor(element),
            text: text.slice(0, thresholds.maxClippedTextLength),
            rect,
            visibility,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            position: style.position,
            zIndex: style.zIndex,
            clientWidth: element.clientWidth,
            clientHeight: element.clientHeight,
            scrollWidth: element.scrollWidth,
            scrollHeight: element.scrollHeight,
            widthClipped,
            heightClipped,
          });
        }
      }
    }

    const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .map((element) => ({ element, rect: rectFor(element), visibility: visibilityFor(element) }))
      .filter((item) => item.visibility.visible);
    const fixedCandidates = allElements
      .map((element) => ({
        element,
        rect: rectFor(element),
        visibility: visibilityFor(element),
        style: window.getComputedStyle(element),
      }))
      .filter((item) => item.visibility.visible && (item.style.position === 'fixed' || item.style.position === 'sticky'));
    const fixedHeadingOverlaps: FixedHeadingOverlapEvidence[] = [];
    const intersectsViewport = (rect: RectangleEvidence): boolean => (
      Math.min(rect.right, actualViewport.width) - Math.max(rect.left, 0)
        > thresholds.minViewportIntersectionDimensionPx
      && Math.min(rect.bottom, actualViewport.height) - Math.max(rect.top, 0)
        > thresholds.minViewportIntersectionDimensionPx
    );
    for (const overlay of fixedCandidates) {
      for (const heading of headings) {
        if (fixedHeadingOverlaps.length >= thresholds.maxFixedHeadingOverlapCandidates) {
          break;
        }
        if (
          overlay.element === heading.element
          || overlay.element.contains(heading.element)
          || heading.element.contains(overlay.element)
          || !intersectsViewport(overlay.rect)
          || !intersectsViewport(heading.rect)
        ) {
          continue;
        }
        const left = Math.max(overlay.rect.left, heading.rect.left);
        const top = Math.max(overlay.rect.top, heading.rect.top);
        const right = Math.min(overlay.rect.right, heading.rect.right);
        const bottom = Math.min(overlay.rect.bottom, heading.rect.bottom);
        const width = Math.max(0, right - left);
        const height = Math.max(0, bottom - top);
        const area = width * height;
        if (area >= thresholds.minOcclusionAreaPx2) {
          fixedHeadingOverlaps.push({
            overlaySelector: selectorFor(overlay.element),
            headingSelector: selectorFor(heading.element),
            overlayRect: overlay.rect,
            headingRect: heading.rect,
            overlayVisibility: overlay.visibility,
            headingVisibility: heading.visibility,
            overlayPosition: overlay.style.position as 'fixed' | 'sticky',
            overlayZIndex: overlay.style.zIndex,
            overlayOverflowX: overlay.style.overflowX,
            overlayOverflowY: overlay.style.overflowY,
            headingPosition: window.getComputedStyle(heading.element).position,
            headingZIndex: window.getComputedStyle(heading.element).zIndex,
            headingOverflowX: window.getComputedStyle(heading.element).overflowX,
            headingOverflowY: window.getComputedStyle(heading.element).overflowY,
            intersection: {
              x: left,
              y: top,
              top,
              right,
              bottom,
              left,
              width,
              height,
              area,
            },
          });
        }
      }
    }

    const root = document.documentElement;
    const body = document.body;
    const documentElementScrollWidth = root?.scrollWidth ?? 0;
    const bodyScrollWidth = body?.scrollWidth ?? 0;
    return {
      document: {
        viewportWidth: actualViewport.width,
        viewportHeight: actualViewport.height,
        documentElementClientWidth: root?.clientWidth ?? 0,
        documentElementClientHeight: root?.clientHeight ?? 0,
        documentElementScrollWidth,
        documentElementScrollHeight: root?.scrollHeight ?? 0,
        bodyScrollWidth,
        bodyScrollHeight: body?.scrollHeight ?? 0,
        bodyClientWidth: body?.clientWidth ?? 0,
        bodyClientHeight: body?.clientHeight ?? 0,
        horizontalOverflowPx: Math.max(
          0,
          Math.max(documentElementScrollWidth, bodyScrollWidth) - actualViewport.width,
        ),
      },
      boxesOutsideViewport: [...priorityOutsideViewport, ...ordinaryOutsideViewport]
        .slice(0, thresholds.maxOutsideViewportCandidates),
      zeroSizeInteractive,
      clippedText,
      fixedHeadingOverlaps,
    };
  }, LAYOUT_THRESHOLDS);

  const evidence = freezeLayout(raw);
  if (
    Math.abs(evidence.document.viewportWidth - viewportSnapshot.width) > LAYOUT_THRESHOLDS.viewportMatchTolerancePx
    || Math.abs(evidence.document.viewportHeight - viewportSnapshot.height) > LAYOUT_THRESHOLDS.viewportMatchTolerancePx
  ) {
    throw new Error(
      `Caller viewport ${viewportSnapshot.width}x${viewportSnapshot.height} does not match actual browser viewport `
      + `${evidence.document.viewportWidth}x${evidence.document.viewportHeight}`,
    );
  }
  return evidence;
}

/** レスポンシブの各幅を、その都度新規に保護されたowner管理下のセッションでサンプリングする。 */
export async function collectStressLayout(
  pageFactory: PassiveStressSessionFactory,
  url: string,
  widths: readonly number[],
): Promise<readonly StressLayoutEvidence[]> {
  if (typeof pageFactory !== 'function') {
    throw new Error('A passive stress session factory is required');
  }
  if (widths.some((width) => !Number.isFinite(width) || !Number.isInteger(width) || width <= 0)) {
    throw new Error('Responsive stress widths must be positive finite integers');
  }

  const results: StressLayoutEvidence[] = [];
  for (const width of widths) {
    const viewport = Object.freeze({ width, height: STRESS_VIEWPORT_HEIGHT });
    const session = await pageFactory(viewport);
    let workError: unknown;
    let closeError: unknown;
    let result: StressLayoutEvidence | undefined;
    try {
      await session.page.goto(url, { waitUntil: 'load' });
      const layout = await collectLayoutEvidence(session.page, viewport);
      result = Object.freeze({ width, height: STRESS_VIEWPORT_HEIGHT, layout });
    } catch (error) {
      workError = error;
    } finally {
      try {
        await session.close();
      } catch (error) {
        closeError = error;
      }
    }

    if (workError !== undefined && closeError !== undefined) {
      throw new AggregateError([workError, closeError], 'Responsive stress work and owner close both failed');
    }
    if (workError !== undefined) {
      throw workError;
    }
    if (closeError !== undefined) {
      throw closeError;
    }
    if (result === undefined) {
      throw new Error('Responsive stress collection produced no result');
    }
    results.push(result);
  }
  return Object.freeze(results);
}

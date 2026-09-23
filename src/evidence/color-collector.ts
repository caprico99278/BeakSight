import type { Page } from 'playwright';

export const COLOR_LIMITS = Object.freeze({
  maxTextSamples: 100,
  maxDistributionEntries: 32,
  maxTextLength: 256,
  maxSelectorLength: 512,
  maxSelectorDepth: 8,
  maxColorSerializationLength: 256,
});

export interface CssColorEvidence {
  readonly css: string;
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

export type ColorUnavailableReason =
  | 'BACKGROUND_IMAGE'
  | 'TRANSPARENT_CHAIN'
  | 'INVALID_COLOR'
  | 'PARTIAL_OPACITY';

export type BackgroundColorEvidence =
  | { readonly status: 'OBSERVED'; readonly color: CssColorEvidence }
  | { readonly status: 'UNAVAILABLE'; readonly reason: ColorUnavailableReason };

export type ContrastPairEvidence =
  | {
      readonly status: 'OBSERVED';
      readonly ratio: number;
      readonly effectiveForeground: CssColorEvidence;
    }
  | { readonly status: 'UNAVAILABLE'; readonly reason: ColorUnavailableReason };

export type ForegroundColorEvidence =
  | { readonly status: 'OBSERVED'; readonly color: CssColorEvidence }
  | { readonly status: 'UNAVAILABLE'; readonly reason: 'INVALID_COLOR'; readonly serialized: string };

export interface TextColorSampleEvidence {
  readonly selector: string;
  readonly text: string;
  readonly foreground: ForegroundColorEvidence;
  readonly background: BackgroundColorEvidence;
  readonly contrast: ContrastPairEvidence;
  readonly boundingArea: number;
  readonly visibleArea: number;
}

export interface ForegroundDistributionEvidence {
  readonly color: CssColorEvidence;
  readonly area: number;
  readonly proportion: number;
  readonly sampleCount: number;
}

export interface ColorEvidence {
  readonly textSamples: readonly TextColorSampleEvidence[];
  readonly foregroundDistribution: readonly ForegroundDistributionEvidence[];
  readonly observedArea: number;
}

interface RawColorEvidence extends ColorEvidence {}

function finiteRange(value: number, min: number, max: number, name: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid browser color value: ${name}`);
  }
}

function freezeColor(color: CssColorEvidence, name: string): CssColorEvidence {
  finiteRange(color.red, 0, 255, `${name}.red`);
  finiteRange(color.green, 0, 255, `${name}.green`);
  finiteRange(color.blue, 0, 255, `${name}.blue`);
  finiteRange(color.alpha, 0, 1, `${name}.alpha`);
  const expectedCss = `rgba(${color.red}, ${color.green}, ${color.blue}, ${color.alpha})`;
  if (color.css !== expectedCss) {
    throw new Error(`Invalid non-canonical browser color: ${name}`);
  }
  return Object.freeze({ ...color });
}

function freezeColorEvidence(raw: RawColorEvidence): ColorEvidence {
  if (!Number.isFinite(raw.observedArea) || raw.observedArea < 0) {
    throw new Error('Invalid browser color observed area');
  }
  const textSamples = Object.freeze(raw.textSamples.slice(0, COLOR_LIMITS.maxTextSamples).map((sample, index) => {
    if (
      sample.selector.length === 0
      || sample.selector.length > COLOR_LIMITS.maxSelectorLength
      || sample.text.length > COLOR_LIMITS.maxTextLength
      || !Number.isFinite(sample.boundingArea)
      || sample.boundingArea < 0
      || !Number.isFinite(sample.visibleArea)
      || sample.visibleArea < 0
      || sample.visibleArea > sample.boundingArea
    ) {
      throw new Error(`Invalid or unbounded browser color sample: ${index}`);
    }
    const foreground = sample.foreground.status === 'OBSERVED'
      ? Object.freeze({
          status: 'OBSERVED' as const,
          color: freezeColor(sample.foreground.color, `textSamples[${index}].foreground`),
        })
      : (() => {
          if (sample.foreground.serialized.length > COLOR_LIMITS.maxColorSerializationLength) {
            throw new Error(`Unbounded browser foreground serialization: ${index}`);
          }
          return Object.freeze({ ...sample.foreground });
        })();
    const background = sample.background.status === 'OBSERVED'
      ? Object.freeze({
          status: 'OBSERVED' as const,
          color: freezeColor(sample.background.color, `textSamples[${index}].background`),
        })
      : Object.freeze({ ...sample.background });
    const contrast = sample.contrast.status === 'OBSERVED'
      ? (() => {
          if (!Number.isFinite(sample.contrast.ratio) || sample.contrast.ratio < 1) {
            throw new Error(`Invalid browser contrast ratio: ${index}`);
          }
          return Object.freeze({
            status: 'OBSERVED' as const,
            ratio: sample.contrast.ratio,
            effectiveForeground: freezeColor(
              sample.contrast.effectiveForeground,
              `textSamples[${index}].effectiveForeground`,
            ),
          });
        })()
      : Object.freeze({ ...sample.contrast });
    return Object.freeze({ ...sample, foreground, background, contrast });
  }));
  const foregroundDistribution = Object.freeze(raw.foregroundDistribution
    .slice(0, COLOR_LIMITS.maxDistributionEntries)
    .map((entry, index) => {
      if (
        !Number.isFinite(entry.area)
        || entry.area < 0
        || !Number.isFinite(entry.proportion)
        || entry.proportion < 0
        || entry.proportion > 1
        || !Number.isInteger(entry.sampleCount)
        || entry.sampleCount < 0
      ) {
        throw new Error(`Invalid browser color distribution: ${index}`);
      }
      return Object.freeze({
        ...entry,
        color: freezeColor(entry.color, `foregroundDistribution[${index}].color`),
      });
    }));
  return Object.freeze({ textSamples, foregroundDistribution, observedArea: raw.observedArea });
}

/** CSSのテキスト色と計算済み背景色の候補を、上限付き・読み取り専用の単一evaluationで収集する。 */
export async function collectColorEvidence(page: Page): Promise<ColorEvidence> {
  const raw = await page.evaluate((limits): RawColorEvidence => {
    interface MutableColor {
      readonly css: string;
      readonly red: number;
      readonly green: number;
      readonly blue: number;
      readonly alpha: number;
    }
    const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();
    const color = (red: number, green: number, blue: number, alpha: number): MutableColor => ({
      css: `rgba(${red}, ${green}, ${blue}, ${alpha})`,
      red,
      green,
      blue,
      alpha,
    });
    const parseColor = (value: string): MutableColor | null => {
      const match = value.match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/u);
      if (match === null) {
        return null;
      }
      const red = Number(match[1]);
      const green = Number(match[2]);
      const blue = Number(match[3]);
      const alpha = match[4] === undefined ? 1 : Number(match[4]);
      if (
        !Number.isFinite(red) || red < 0 || red > 255
        || !Number.isFinite(green) || green < 0 || green > 255
        || !Number.isFinite(blue) || blue < 0 || blue > 255
        || !Number.isFinite(alpha) || alpha < 0 || alpha > 1
      ) {
        return null;
      }
      return color(red, green, blue, alpha);
    };
    const over = (front: MutableColor, back: MutableColor): MutableColor => {
      const alpha = front.alpha + back.alpha * (1 - front.alpha);
      if (alpha === 0) {
        return color(0, 0, 0, 0);
      }
      return color(
        Math.round((front.red * front.alpha + back.red * back.alpha * (1 - front.alpha)) / alpha),
        Math.round((front.green * front.alpha + back.green * back.alpha * (1 - front.alpha)) / alpha),
        Math.round((front.blue * front.alpha + back.blue * back.alpha * (1 - front.alpha)) / alpha),
        alpha,
      );
    };
    const luminance = (candidate: MutableColor): number => {
      const linear = (channel: number): number => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * linear(candidate.red) + 0.7152 * linear(candidate.green) + 0.0722 * linear(candidate.blue);
    };
    const ratio = (first: MutableColor, second: MutableColor): number => {
      const firstLuminance = luminance(first);
      const secondLuminance = luminance(second);
      return (Math.max(firstLuminance, secondLuminance) + 0.05)
        / (Math.min(firstLuminance, secondLuminance) + 0.05);
    };
    const selectorFor = (element: Element): string => {
      if (element.id.length > 0) {
        return `#${CSS.escape(element.id)}`.slice(0, limits.maxSelectorLength);
      }
      const parts: string[] = [];
      let current: Element | null = element;
      while (current !== null && current !== document.documentElement && parts.length < limits.maxSelectorDepth) {
        const tag = current.tagName.toLowerCase();
        let index = 1;
        let sibling = current.previousElementSibling;
        while (sibling !== null) {
          if (sibling.tagName === current.tagName) {
            index += 1;
          }
          sibling = sibling.previousElementSibling;
        }
        parts.unshift(`${tag}:nth-of-type(${index})`);
        current = current.parentElement;
      }
      return parts.join(' > ').slice(0, limits.maxSelectorLength);
    };
    const backgroundFor = (element: Element): BackgroundColorEvidence => {
      const layers: MutableColor[] = [];
      let current: Element | null = element;
      while (current !== null) {
        const style = window.getComputedStyle(current);
        if (style.backgroundImage !== 'none') {
          return { status: 'UNAVAILABLE', reason: 'BACKGROUND_IMAGE' };
        }
        const parsed = parseColor(style.backgroundColor);
        if (parsed === null) {
          return { status: 'UNAVAILABLE', reason: 'INVALID_COLOR' };
        }
        if (parsed.alpha > 0) {
          layers.push(parsed);
          if (parsed.alpha === 1) {
            let effective = layers[layers.length - 1] as MutableColor;
            for (let index = layers.length - 2; index >= 0; index -= 1) {
              effective = over(layers[index] as MutableColor, effective);
            }
            return { status: 'OBSERVED', color: effective };
          }
        }
        current = current.parentElement;
      }
      return { status: 'UNAVAILABLE', reason: 'TRANSPARENT_CHAIN' };
    };
    const visualState = (element: HTMLElement, rect: DOMRect): {
      readonly visible: boolean;
      readonly partialOpacity: boolean;
    } => {
      if (
        !Number.isFinite(rect.width)
        || !Number.isFinite(rect.height)
        || rect.width <= 0
        || rect.height <= 0
        || rect.right <= 0
        || rect.bottom <= 0
        || rect.left >= window.innerWidth
        || rect.top >= window.innerHeight
        || element.getClientRects().length === 0
      ) {
        return { visible: false, partialOpacity: false };
      }
      let partialOpacity = false;
      let current: Element | null = element;
      while (current !== null) {
        const style = window.getComputedStyle(current);
        const opacity = Number.parseFloat(style.opacity);
        if (
          (current instanceof HTMLElement && current.hidden !== false)
          || style.display === 'none'
          || style.visibility === 'hidden'
          || style.visibility === 'collapse'
          || !Number.isFinite(opacity)
          || opacity <= 0
        ) {
          return { visible: false, partialOpacity: false };
        }
        if (opacity < 1) {
          partialOpacity = true;
        }
        current = current.parentElement;
      }
      return { visible: true, partialOpacity };
    };
    const visibleAreaFor = (element: HTMLElement, rect: DOMRect): number => {
      let left = Math.max(rect.left, 0);
      let right = Math.min(rect.right, window.innerWidth);
      let top = Math.max(rect.top, 0);
      let bottom = Math.min(rect.bottom, window.innerHeight);
      let ancestor = element.parentElement;
      while (ancestor !== null && right > left && bottom > top) {
        const style = window.getComputedStyle(ancestor);
        const ancestorRect = ancestor.getBoundingClientRect();
        if (['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowX)) {
          left = Math.max(left, ancestorRect.left);
          right = Math.min(right, ancestorRect.right);
        }
        if (['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowY)) {
          top = Math.max(top, ancestorRect.top);
          bottom = Math.min(bottom, ancestorRect.bottom);
        }
        ancestor = ancestor.parentElement;
      }
      return Math.max(0, right - left) * Math.max(0, bottom - top);
    };
    const elements = [...(document.body?.querySelectorAll('*') ?? [])];
    const textSamples: TextColorSampleEvidence[] = [];
    for (const element of elements) {
      if (textSamples.length >= limits.maxTextSamples || !(element instanceof HTMLElement)) {
        continue;
      }
      const text = normalize([...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join(' '));
      if (text.length === 0) {
        continue;
      }
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const state = visualState(element, rect);
      if (!state.visible) {
        continue;
      }
      const visibleArea = visibleAreaFor(element, rect);
      if (visibleArea <= 0) {
        continue;
      }
      const parsedForeground = parseColor(style.color);
      const foreground: ForegroundColorEvidence = parsedForeground === null
        ? {
            status: 'UNAVAILABLE',
            reason: 'INVALID_COLOR',
            serialized: style.color.slice(0, limits.maxColorSerializationLength),
          }
        : { status: 'OBSERVED', color: parsedForeground };
      const background = backgroundFor(element);
      let contrast: ContrastPairEvidence;
      if (foreground.status === 'UNAVAILABLE') {
        contrast = { status: 'UNAVAILABLE', reason: 'INVALID_COLOR' };
      } else if (state.partialOpacity) {
        contrast = { status: 'UNAVAILABLE', reason: 'PARTIAL_OPACITY' };
      } else if (background.status === 'UNAVAILABLE') {
        contrast = { ...background };
      } else {
        const effectiveForeground = over(foreground.color, background.color);
        contrast = {
          status: 'OBSERVED',
          ratio: ratio(effectiveForeground, background.color),
          effectiveForeground,
        };
      }
      textSamples.push({
        selector: selectorFor(element),
        text: text.slice(0, limits.maxTextLength),
        foreground,
        background,
        contrast,
        boundingArea: rect.width * rect.height,
        visibleArea,
      });
    }

    const distribution = new Map<string, {
      color: CssColorEvidence;
      area: number;
      sampleCount: number;
    }>();
    let observedArea = 0;
    for (const sample of textSamples) {
      if (sample.foreground.status === 'UNAVAILABLE') {
        continue;
      }
      observedArea += sample.visibleArea;
      const existing = distribution.get(sample.foreground.color.css);
      if (existing === undefined) {
        distribution.set(sample.foreground.color.css, {
          color: sample.foreground.color,
          area: sample.visibleArea,
          sampleCount: 1,
        });
      } else {
        existing.area += sample.visibleArea;
        existing.sampleCount += 1;
      }
    }
    const foregroundDistribution = [...distribution.values()]
      .sort((left, right) => right.area - left.area || left.color.css.localeCompare(right.color.css))
      .slice(0, limits.maxDistributionEntries)
      .map((entry) => ({
        ...entry,
        proportion: observedArea === 0 ? 0 : entry.area / observedArea,
      }));
    return { textSamples, foregroundDistribution, observedArea };
  }, COLOR_LIMITS);

  return freezeColorEvidence(raw);
}

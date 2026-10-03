import type { Page } from 'playwright';
import type {
  BackgroundColorEvidence,
  ColorEvidence,
  ContrastPairEvidence,
  CssColorEvidence,
  ForegroundColorEvidence,
  TextColorSampleEvidence,
} from '../core/evidence-types.js';
import { isNonNegativeFiniteNumber } from '../core/guards.js';
import { MAX_SELECTOR_DEPTH, MAX_SELECTOR_LENGTH } from '../core/limits.js';
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';

export const COLOR_LIMITS = Object.freeze({
  maxTextSamples: 100,
  maxDistributionEntries: 32,
  maxTextLength: 256,
  maxSelectorLength: MAX_SELECTOR_LENGTH,
  maxSelectorDepth: MAX_SELECTOR_DEPTH,
  maxColorSerializationLength: 256,
});

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
  if (!isNonNegativeFiniteNumber(raw.observedArea)) {
    throw new Error('Invalid browser color observed area');
  }
  if (!Number.isFinite(raw.scrollPosition.scrollX) || !Number.isFinite(raw.scrollPosition.scrollY)) {
    throw new Error('Invalid browser color scroll position');
  }
  const scrollPosition = Object.freeze({
    scrollX: raw.scrollPosition.scrollX,
    scrollY: raw.scrollPosition.scrollY,
  });
  if (
    typeof raw.textSamplesTruncated !== 'boolean'
    || !Number.isSafeInteger(raw.omittedDistributionEntryCount)
    || raw.omittedDistributionEntryCount < 0
  ) {
    throw new Error('Invalid browser color truncation record');
  }
  const textSamplesTruncated = raw.textSamplesTruncated || raw.textSamples.length > COLOR_LIMITS.maxTextSamples;
  const omittedDistributionEntryCount = raw.omittedDistributionEntryCount
    + Math.max(0, raw.foregroundDistribution.length - COLOR_LIMITS.maxDistributionEntries);
  const textSamples = Object.freeze(raw.textSamples.slice(0, COLOR_LIMITS.maxTextSamples).map((sample, index) => {
    if (
      typeof sample.truncated !== 'boolean'
      || sample.selector.length === 0
      || sample.selector.length > COLOR_LIMITS.maxSelectorLength
      || sample.text.length > COLOR_LIMITS.maxTextLength
      || !isNonNegativeFiniteNumber(sample.boundingArea)
      || !isNonNegativeFiniteNumber(sample.visibleArea)
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
        !isNonNegativeFiniteNumber(entry.area)
        || !isNonNegativeFiniteNumber(entry.proportion)
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
  return Object.freeze({
    scrollPosition,
    textSamples,
    textSamplesTruncated,
    foregroundDistribution,
    omittedDistributionEntryCount,
    observedArea: raw.observedArea,
  });
}

/** CSSのテキスト色と計算済み背景色の候補を、上限付き・読み取り専用の単一evaluationで収集する。 */
export async function collectColorEvidence(page: Page): Promise<ColorEvidence> {
  const raw = await page.evaluate(({ limits, visibilityOptions }): RawColorEvidence => {
    interface MutableColor {
      readonly css: string;
      readonly red: number;
      readonly green: number;
      readonly blue: number;
      readonly alpha: number;
    }
    // 文書のスクロール位置（`ScrollPosition` の定義）。`scrollingElement` ではない body のスクロール量を含める。
    const scrollingRoot = document.scrollingElement ?? document.documentElement;
    const separateScrollBody = document.body !== null && document.body !== scrollingRoot ? document.body : null;
    const scrollPosition = {
      scrollX: window.scrollX + (separateScrollBody?.scrollLeft ?? 0),
      scrollY: window.scrollY + (separateScrollBody?.scrollTop ?? 0),
    };
    interface Bounds {
      readonly left: number;
      readonly top: number;
      readonly right: number;
      readonly bottom: number;
    }
    const viewportBounds: Bounds = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    // 文書のスクロール領域（ビューポート座標）。body が独自にスクロールする場合は、body のスクロール領域。
    const documentBounds: Bounds = (() => {
      if (
        separateScrollBody !== null
        && !['visible', 'clip'].includes(window.getComputedStyle(separateScrollBody).overflowY)
      ) {
        const bodyRect = separateScrollBody.getBoundingClientRect();
        const left = bodyRect.left + separateScrollBody.clientLeft - separateScrollBody.scrollLeft;
        const top = bodyRect.top + separateScrollBody.clientTop - separateScrollBody.scrollTop;
        return {
          left,
          top,
          right: left + separateScrollBody.scrollWidth,
          bottom: top + separateScrollBody.scrollHeight,
        };
      }
      const left = -window.scrollX;
      const top = -window.scrollY;
      return { left, top, right: left + scrollingRoot.scrollWidth, bottom: top + scrollingRoot.scrollHeight };
    })();
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
    // 上限で切り詰める前の selector。呼び出し側で切り詰め、切り詰めたかを記録する。
    const selectorFor = (element: Element): string => {
      if (element.id.length > 0) {
        return `#${CSS.escape(element.id)}`;
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
      return parts.join(' > ');
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
    // 大きさが0の要素は、可視判定とは別の事実として扱う（面積がないので標本にしない）。
    const hasArea = (rect: DOMRect): boolean => (
      Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0
    );
    // 可視の要素について、要素か祖先の opacity が1未満かどうか（コントラストを求められない理由）。可視判定には使わない。
    const hasPartialOpacity = (element: Element): boolean => {
      let current: Element | null = element;
      while (current !== null) {
        if (Number.parseFloat(window.getComputedStyle(current).opacity) < 1) {
          return true;
        }
        current = current.parentElement;
      }
      return false;
    };
    const visibleAreaFor = (element: HTMLElement, rect: DOMRect): number => {
      let left = rect.left;
      let right = rect.right;
      let top = rect.top;
      let bottom = rect.bottom;
      let fixed = window.getComputedStyle(element).position === 'fixed';
      let ancestor = element.parentElement;
      while (ancestor !== null && right > left && bottom > top) {
        // html と body の切り取りは、文書のスクロール領域（documentBounds）で扱う。
        if (ancestor === document.documentElement || ancestor === document.body) {
          ancestor = ancestor.parentElement;
          continue;
        }
        const style = window.getComputedStyle(ancestor);
        if (style.position === 'fixed') {
          fixed = true;
        }
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
      const bounds = fixed ? viewportBounds : documentBounds;
      left = Math.max(left, bounds.left);
      right = Math.min(right, bounds.right);
      top = Math.max(top, bounds.top);
      bottom = Math.min(bottom, bounds.bottom);
      return Math.max(0, right - left) * Math.max(0, bottom - top);
    };
    const elements = [...(document.body?.querySelectorAll('*') ?? [])];
    const textSamples: TextColorSampleEvidence[] = [];
    let textSamplesTruncated = false;
    for (const element of elements) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }
      const text = normalize([...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join(' '));
      if (text.length === 0) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (!element.checkVisibility(visibilityOptions) || !hasArea(rect)) {
        continue;
      }
      const visibleArea = visibleAreaFor(element, rect);
      if (visibleArea <= 0) {
        continue;
      }
      if (textSamples.length >= limits.maxTextSamples) {
        // 上限を超える標本があることだけを記録し、それ以上は調べない。
        textSamplesTruncated = true;
        break;
      }
      const style = window.getComputedStyle(element);
      const partialOpacity = hasPartialOpacity(element);
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
      } else if (partialOpacity) {
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
      const selector = selectorFor(element);
      textSamples.push({
        selector: selector.slice(0, limits.maxSelectorLength),
        text: text.slice(0, limits.maxTextLength),
        foreground,
        background,
        contrast,
        boundingArea: rect.width * rect.height,
        visibleArea,
        truncated: selector.length > limits.maxSelectorLength
          || text.length > limits.maxTextLength
          || (parsedForeground === null && style.color.length > limits.maxColorSerializationLength),
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
    return {
      scrollPosition,
      textSamples,
      textSamplesTruncated,
      foregroundDistribution,
      omittedDistributionEntryCount: distribution.size - foregroundDistribution.length,
      observedArea,
    };
  }, { limits: COLOR_LIMITS, visibilityOptions: VISIBILITY_CHECK_OPTIONS });

  return freezeColorEvidence(raw);
}

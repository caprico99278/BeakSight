import { describe, expect, it } from 'vitest';
import { DISPLAY_TONES } from '../../src/presentation/catalog.js';
import {
  COLOR_SCHEMES,
  REPORT_CLASS_NAMES,
  REPORT_COLOR_TOKENS,
  REPORT_STYLESHEET,
  toneClassName,
} from '../../src/report/html-tokens.js';

/** WCAG 2.x の相対輝度（`#rrggbb` だけを扱う）。 */
const relativeLuminance = (hex: string): number => {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex);
  if (match === null) {
    throw new RangeError(`not a #rrggbb colour: ${hex}`);
  }
  const [red, green, blue] = [match[1], match[2], match[3]].map((channel) => {
    const value = Number.parseInt(channel ?? '', 16) / 255;
    return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
};

const contrastRatio = (foreground: string, background: string): number => {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
};

/** WCAG 2.x AA の、通常の文字の最低のコントラスト比。 */
const MIN_TEXT_CONTRAST = 4.5;

describe('report colour tokens', () => {
  it('defines light and dark values for every tone', () => {
    expect(COLOR_SCHEMES).toEqual(['light', 'dark']);
    expect(Object.keys(REPORT_COLOR_TOKENS.tones).sort()).toEqual([...DISPLAY_TONES].sort());
  });

  it.each(COLOR_SCHEMES)('keeps text readable in the %s scheme (WCAG AA 4.5:1)', (scheme) => {
    const base = REPORT_COLOR_TOKENS.base[scheme];
    expect(contrastRatio(base.text, base.background)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(contrastRatio(base.text, base.surface)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(contrastRatio(base.mutedText, base.background)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(contrastRatio(base.mutedText, base.surface)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(contrastRatio(base.link, base.background)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(contrastRatio(base.link, base.surface)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    for (const tone of DISPLAY_TONES) {
      const colors = REPORT_COLOR_TOKENS.tones[tone][scheme];
      expect(contrastRatio(colors.foreground, colors.background), tone).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(REPORT_COLOR_TOKENS)).toBe(true);
    expect(Object.isFrozen(REPORT_COLOR_TOKENS.tones.critical.light)).toBe(true);
    expect(Object.isFrozen(REPORT_CLASS_NAMES)).toBe(true);
  });
});

describe('report stylesheet', () => {
  it('defines the colours as custom properties for both schemes', () => {
    expect(REPORT_STYLESHEET).toContain('color-scheme: light dark');
    expect(REPORT_STYLESHEET).toContain('@media (prefers-color-scheme: dark)');
    expect(REPORT_STYLESHEET).toMatch(/--bs-color-text:\s*#[0-9a-f]{6};/u);
  });

  it('has a rule for every tone class and uses only custom properties for the tone colours', () => {
    for (const tone of DISPLAY_TONES) {
      const className = toneClassName(tone);
      expect(className).toMatch(/^[a-z][a-z0-9-]*$/u);
      expect(REPORT_STYLESHEET).toContain(`.${className} {`);
      expect(REPORT_STYLESHEET).toContain(`var(--bs-tone-${tone}-fg)`);
    }
  });

  it('cannot close the style element it is embedded in', () => {
    expect(REPORT_STYLESHEET).not.toMatch(/<\/?style/iu);
    expect(REPORT_STYLESHEET).not.toContain('<');
  });

  it('shows a visible focus indicator', () => {
    expect(REPORT_STYLESHEET).toContain(':focus-visible');
  });
});

/**
 * 表示トークンとスタイルシートの唯一の owner（UI追補設計書 第4章）。
 * - 色の値は、このファイルにだけ書く（GATE-UI02）。部品は、クラスの名前（`REPORT_CLASS_NAMES`、`toneClassName`）だけを使う。
 * - レポートのスタイルシートは `REPORT_STYLESHEET` の1つだけ。部品は `style=""` の属性を使わない。
 * - 色は、ライトとダークの両方を持ち、文字と背景のコントラスト比を WCAG 2.x AA（4.5:1）以上にする
 *   （`tests/unit/report-html-tokens.test.ts` で確かめる）。
 * - HTML のタグを含む文字列を書かない（GATE-UI03）。
 */
import { deepFreeze } from '../core/immutable.js';
import { DISPLAY_TONES, type DisplayTone } from '../presentation/catalog.js';

/** 色の組の閉じた一覧（`prefers-color-scheme`）。 */
export const COLOR_SCHEMES = Object.freeze(['light', 'dark'] as const);
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/** 文書の全体の色。 */
export interface BaseColorTokens {
  readonly text: string;
  readonly mutedText: string;
  readonly background: string;
  readonly surface: string;
  readonly border: string;
  readonly link: string;
  readonly focus: string;
}

/** 1つの色のトークン（`DisplayTone`）の色。`foreground` と `background` のコントラスト比は 4.5:1 以上。 */
export interface ToneColorTokens {
  readonly foreground: string;
  readonly background: string;
  readonly border: string;
}

/** 色の値の唯一の定義。 */
export const REPORT_COLOR_TOKENS = deepFreeze({
  base: {
    light: {
      text: '#1f2328',
      mutedText: '#57606a',
      background: '#ffffff',
      surface: '#f6f8fa',
      border: '#d0d7de',
      link: '#0550ae',
      focus: '#0969da',
    },
    dark: {
      text: '#e6edf3',
      mutedText: '#9198a1',
      background: '#0d1117',
      surface: '#161b22',
      border: '#30363d',
      link: '#58a6ff',
      focus: '#1f6feb',
    },
  },
  tones: {
    critical: {
      light: { foreground: '#82071e', background: '#ffebe9', border: '#cf222e' },
      dark: { foreground: '#ffdcd7', background: '#490202', border: '#f85149' },
    },
    caution: {
      light: { foreground: '#633c01', background: '#fff8c5', border: '#bf8700' },
      dark: { foreground: '#f8e3a1', background: '#3b2300', border: '#d29922' },
    },
    notice: {
      light: { foreground: '#0a3069', background: '#ddf4ff', border: '#0969da' },
      dark: { foreground: '#cae8ff', background: '#0c2d6b', border: '#388bfd' },
    },
    shield: {
      light: { foreground: '#512a97', background: '#fbefff', border: '#8250df' },
      dark: { foreground: '#ecd8ff', background: '#2e1461', border: '#a371f7' },
    },
    positive: {
      light: { foreground: '#116329', background: '#dafbe1', border: '#1a7f37' },
      dark: { foreground: '#aff5b4', background: '#04260f', border: '#3fb950' },
    },
    neutral: {
      light: { foreground: '#24292f', background: '#eaeef2', border: '#afb8c1' },
      dark: { foreground: '#e6edf3', background: '#21262d', border: '#6e7681' },
    },
  },
} as const satisfies {
  readonly base: Readonly<Record<ColorScheme, BaseColorTokens>>;
  readonly tones: Readonly<Record<DisplayTone, Readonly<Record<ColorScheme, ToneColorTokens>>>>;
});

/** 部品とスタイルシートが共有する、クラスの名前。部品は、ここにある名前だけを使う。 */
export const REPORT_CLASS_NAMES = deepFreeze({
  badge: 'badge',
  table: 'data-table',
  tableWrapper: 'table-scroll',
  findingRow: 'finding-row',
  findingMessage: 'finding-message',
  url: 'url',
  urlText: 'url-text',
  externalUrl: 'url-external',
  evidenceRef: 'evidence-ref',
  screenshotRef: 'screenshot-ref',
  referenceList: 'reference-list',
  identifier: 'identifier',
  keyValueList: 'key-value-list',
  section: 'report-section',
  muted: 'muted',
} as const);

/** 色のトークンのクラスの名前（例: `tone-critical`）。 */
export const toneClassName = (tone: DisplayTone): string => `tone-${tone}`;

/** 余白の段階（rem）。 */
const SPACING_SCALE = Object.freeze([0.25, 0.5, 1, 1.5, 2] as const);

/** 色の CSS カスタムプロパティの宣言（`--bs-color-*` と `--bs-tone-*-{fg,bg,border}`）。 */
const colorCustomProperties = (scheme: ColorScheme): string => {
  const base = REPORT_COLOR_TOKENS.base[scheme];
  const lines = [
    `--bs-color-text: ${base.text};`,
    `--bs-color-muted: ${base.mutedText};`,
    `--bs-color-background: ${base.background};`,
    `--bs-color-surface: ${base.surface};`,
    `--bs-color-border: ${base.border};`,
    `--bs-color-link: ${base.link};`,
    `--bs-color-focus: ${base.focus};`,
  ];
  for (const tone of DISPLAY_TONES) {
    const colors = REPORT_COLOR_TOKENS.tones[tone][scheme];
    lines.push(
      `--bs-tone-${tone}-fg: ${colors.foreground};`,
      `--bs-tone-${tone}-bg: ${colors.background};`,
      `--bs-tone-${tone}-border: ${colors.border};`,
    );
  }
  return lines.map((line) => `  ${line}`).join('\n');
};

const spacingCustomProperties = (): string =>
  SPACING_SCALE.map((value, index) => `  --bs-space-${index + 1}: ${value}rem;`).join('\n');

const toneRules = (): string =>
  DISPLAY_TONES.map(
    (tone) =>
      `.${toneClassName(tone)} {\n  color: var(--bs-tone-${tone}-fg);\n  background: var(--bs-tone-${tone}-bg);\n  border-color: var(--bs-tone-${tone}-border);\n}`,
  ).join('\n');

const names = REPORT_CLASS_NAMES;

/** レポートの唯一のスタイルシート。`<style>` の中に、そのまま入れる。 */
export const REPORT_STYLESHEET: string = [
  `:root {\n  color-scheme: light dark;\n${colorCustomProperties('light')}\n${spacingCustomProperties()}\n  --bs-font-size-base: 1rem;\n  --bs-font-size-small: 0.875rem;\n  --bs-radius: 0.375rem;\n  --bs-line-height: 1.6;\n}`,
  `@media (prefers-color-scheme: dark) {\n:root {\n${colorCustomProperties('dark')}\n}\n}`,
  `body {\n  margin: 0;\n  color: var(--bs-color-text);\n  background: var(--bs-color-background);\n  font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", Meiryo, sans-serif;\n  font-size: var(--bs-font-size-base);\n  line-height: var(--bs-line-height);\n}`,
  `main {\n  max-width: 80rem;\n  margin: 0 auto;\n  padding: var(--bs-space-4) var(--bs-space-3);\n}`,
  `h1, h2, h3, h4 {\n  line-height: 1.3;\n  margin: var(--bs-space-5) 0 var(--bs-space-3);\n}`,
  `a {\n  color: var(--bs-color-link);\n}`,
  `a:focus-visible {\n  outline: 3px solid var(--bs-color-focus);\n  outline-offset: 2px;\n}`,
  `code, .${names.identifier} {\n  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;\n  font-size: var(--bs-font-size-small);\n  overflow-wrap: anywhere;\n}`,
  `.${names.section} {\n  margin-bottom: var(--bs-space-5);\n}`,
  `.${names.tableWrapper} {\n  overflow-x: auto;\n}`,
  `.${names.table} {\n  width: 100%;\n  border-collapse: collapse;\n  font-size: var(--bs-font-size-small);\n}`,
  `.${names.table} caption {\n  text-align: left;\n  font-weight: 600;\n  padding: var(--bs-space-2) 0;\n}`,
  `.${names.table} th, .${names.table} td {\n  border: 1px solid var(--bs-color-border);\n  padding: var(--bs-space-2);\n  text-align: left;\n  vertical-align: top;\n}`,
  `.${names.table} thead th {\n  background: var(--bs-color-surface);\n}`,
  `.${names.findingMessage} {\n  overflow-wrap: anywhere;\n}`,
  `.${names.url}, .${names.urlText} {\n  overflow-wrap: anywhere;\n}`,
  `.${names.referenceList} {\n  margin: 0;\n  padding-left: var(--bs-space-3);\n}`,
  `.${names.keyValueList} {\n  display: grid;\n  grid-template-columns: max-content 1fr;\n  gap: var(--bs-space-1) var(--bs-space-3);\n}`,
  `.${names.keyValueList} dt {\n  font-weight: 600;\n}`,
  `.${names.keyValueList} dd {\n  margin: 0;\n}`,
  `.${names.muted} {\n  color: var(--bs-color-muted);\n}`,
  `.${names.badge} {\n  display: inline-block;\n  padding: 0 var(--bs-space-2);\n  border: 1px solid;\n  border-radius: var(--bs-radius);\n  font-size: var(--bs-font-size-small);\n  font-weight: 600;\n  white-space: nowrap;\n}`,
  toneRules(),
].join('\n');

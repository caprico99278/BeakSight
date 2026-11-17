import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from 'playwright';
import { readDocumentScrollPosition } from '../browser/controlled-scroll.js';
import {
  ACCESSIBILITY_CHECK_GROUPS,
  type AccessibilityIncompleteReason,
  type AccessibilityCheckDataValue,
  type AccessibilityCheckEvidence,
  type AccessibilityCheckGroup,
  type AccessibilityCheckResult,
  type AccessibilityDisabledFactsEvidence,
  type AccessibilityDisabledPlace,
  type AccessibilityEvidence,
  type AccessibilityNodeEvidence,
  type AccessibilityRuleEvidence,
  type AccessibilityNameContextEvidence,
  type AccessibilityTargetRegionEvidence,
  type AccessibilityTargetSelector,
  type RectangleEvidence,
  type ScrollPosition,
} from '../core/evidence-types.js';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';
import type { ProgressSignals } from '../core/progress-watch.js';
import { watchCollection, type CollectorWatchOptions } from '../browser/collector-watch.js';
import { readAccessibilityAxFacts } from './accessibility-ax.js';

// L2（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 期限を指定されなかったときの axe の実行の期限（前は 30 秒）は撤廃した（期限を
// 受けないときは、進みの見張り `watchCollection` で待つ）。LZ-2: 文の長さの上限（前の `ACCESSIBILITY_LIMITS` の `maxHtmlSnippetLength`・
// `maxFailureSummaryLength`・`maxCheckDataValueLength`・`maxStyleValueLength` と、axe の対象の selector の `MAX_SELECTOR_LENGTH`）も撤廃した。
// 切り詰めない（要素の Evidence の `truncated` は偽、`truncations` は空。前の記録の形のために残す）。

export interface AccessibilityCollectionOptions {
  /**
   * L2: 進みの見張りの指定（全く反応がない・静まらないときだけ、それまでの記録で `PARTIAL`）。RB-9: 呼ぶ側の渡さなくなった期限（`deadlineAtMs`）の
   * 口は消した。
   */
  readonly watch?: CollectorWatchOptions | undefined;
  // AUD-2e: 落ち着いた後の確かめ直しも全部のルールで流すので、ルールを絞る指定（AUD-2d の `runOnly`）は LZ-1 で消した。
}

/** axe を流す部品（全部のルール）。 */
const axeBuilderFor = (page: Page): AxeBuilder => new AxeBuilder({ page }).setLegacyMode(true);

/**
 * 検査の範囲。レガシーの方式の axe は対象の page の中だけで実行するので、同じOriginの文書だけを検査する。
 * COMPLETE と PARTIAL のどちらの証跡にも、この値を記録する（DEF-001b）。
 */
const FRAME_SCOPE: AccessibilityEvidence['frameScope'] = 'SAME_ORIGIN_ONLY';

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
type AxeRule = AxeResults['violations'][number];
type AxeNode = AxeRule['nodes'][number];

/** axe の対象の selector の並び（凍結した写し。LZ-2: 切り詰めない）。 */
const targetSelectorsOf = (target: readonly (string | readonly string[])[]): readonly AccessibilityTargetSelector[] =>
  Object.freeze(target.map((selector) => (typeof selector === 'string' ? selector : Object.freeze([...selector]))));

/**
 * AUD-8: 確かめの data のうち、Evidence に残す欄（axe の Rule の ID ごとの許可の一覧。唯一の置き場所）。一覧にない Rule の確かめは、data を残さない
 * （確かめの ID・一覧・結果・`messageKey` だけ）。値は文字列・数・真偽・null だけを残す（LZ-2: 文字列は切り詰めない）。
 * - 色差: `fgColor`・`bgColor`（axe が透明度を合成した実効の値）、`contrastRatio`・`expectedContrastRatio`、`fontSize`・`fontWeight`、`shadowColor`。
 * - 名前の不一致（`label-content-name-mismatch`）: 受け皿だけ（欄は AUD-4b で決める）。
 */
const CONTRAST_CHECK_DATA_FIELDS = Object.freeze([
  'fgColor',
  'bgColor',
  'contrastRatio',
  'expectedContrastRatio',
  'fontSize',
  'fontWeight',
  'shadowColor',
] as const);
export const ACCESSIBILITY_CHECK_DATA_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'color-contrast': CONTRAST_CHECK_DATA_FIELDS,
  'color-contrast-enhanced': CONTRAST_CHECK_DATA_FIELDS,
  'label-content-name-mismatch': Object.freeze([]),
});

/** AUD-8（4-3）: 無効の事実を読む、色差の axe の Rule の ID。 */
const CONTRAST_AXE_RULE_IDS: ReadonlySet<string> = new Set(['color-contrast', 'color-contrast-enhanced']);

const CHECK_GROUPS: readonly AccessibilityCheckGroup[] = ACCESSIBILITY_CHECK_GROUPS;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 確かめ 1 つ（許可した data の欄だけ）。 */
function checkEvidence(
  check: unknown,
  group: AccessibilityCheckGroup,
  result: AccessibilityCheckResult,
  allowed: readonly string[],
): AccessibilityCheckEvidence | null {
  if (!isPlainRecord(check) || typeof check['id'] !== 'string') {
    return null;
  }
  const rawData = check['data'];
  const rawMessageKey = isPlainRecord(rawData) ? rawData['messageKey'] : undefined;
  const messageKey = typeof rawMessageKey === 'string' ? rawMessageKey : null;
  const data: Record<string, AccessibilityCheckDataValue> = {};
  if (isPlainRecord(rawData)) {
    for (const field of allowed) {
      const value = rawData[field];
      if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' || value === null) {
        data[field] = value;
      }
    }
  }
  return Object.freeze({
    id: check['id'],
    group,
    result,
    messageKey,
    data: Object.freeze(data),
  });
}

/** EV-1: 不透明な sRGB の色（16 進の 3 桁・6 桁・不透明の 8 桁と、関数の形の rgb・透明度 1 の rgba）の 0〜255 の成分。読めない色・透明度のある色は `null`。 */
function opaqueRgbOf(color: string): readonly [number, number, number] | null {
  const value = color.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{6}ff)$/u.exec(value)?.[1];
  if (hex !== undefined) {
    const digits = hex.length === 3 ? [...hex].map((digit) => digit + digit) : [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)];
    return [Number.parseInt(digits[0] ?? '', 16), Number.parseInt(digits[1] ?? '', 16), Number.parseInt(digits[2] ?? '', 16)];
  }
  const functional = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/u.exec(value);
  if (functional === null) {
    return null;
  }
  const alpha = functional[4];
  if (alpha !== undefined && !(alpha === '1' || alpha === '100%' || Number(alpha) === 1)) {
    return null;
  }
  return [Number(functional[1]), Number(functional[2]), Number(functional[3])];
}

/**
 * EV-1（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.1）: 前景と背景の色から、WCAG 2 の相対輝度の式で計算した、丸める前のコントラスト比。
 * axe は比を小数 2 桁に丸めて渡すので、境目に近い値（4.4999 など）を基準に届いたと読まないよう、色から計算し直して残す。読めない色は `null`。
 */
export function contrastRatioOfColors(foreground: string, background: string): number | null {
  const luminanceOf = (rgb: readonly [number, number, number]): number => {
    const [red, green, blue] = rgb.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const fg = opaqueRgbOf(foreground);
  const bg = opaqueRgbOf(background);
  if (fg === null || bg === null || [...fg, ...bg].some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) {
    return null;
  }
  const [lighter, darker] = [luminanceOf(fg), luminanceOf(bg)].sort((first, second) => second - first) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

/** EV-1: 色差の要素の確かめの data（`fgColor`・`bgColor`）から計算した比（読めなければ、項目なし）。 */
const computedContrastFieldOf = (checks: readonly AccessibilityCheckEvidence[]): { readonly computedContrastRatio?: number } => {
  for (const check of checks) {
    const { fgColor, bgColor } = check.data;
    if (typeof fgColor === 'string' && typeof bgColor === 'string') {
      const ratio = contrastRatioOfColors(fgColor, bgColor);
      if (ratio !== null) {
        return { computedContrastRatio: ratio };
      }
    }
  }
  return {};
};

function nodeEvidence(node: AxeNode, ruleId: string, result: AccessibilityCheckResult): AccessibilityNodeEvidence {
  const failureSummary = node.failureSummary ?? null;
  const allowed = ACCESSIBILITY_CHECK_DATA_ALLOWLIST[ruleId] ?? [];
  const checks: AccessibilityCheckEvidence[] = [];
  for (const group of CHECK_GROUPS) {
    const list: unknown = (node as unknown as Record<string, unknown>)[group];
    for (const check of Array.isArray(list) ? list : []) {
      const evidence = checkEvidence(check, group, result, allowed);
      if (evidence !== null) {
        checks.push(evidence);
      }
    }
  }
  return Object.freeze({
    impact: node.impact ?? null,
    targetSelectors: targetSelectorsOf(node.target),
    failureSummary,
    htmlSnippet: node.html,
    truncated: false,
    checks: Object.freeze(checks),
    truncations: Object.freeze([]),
    disabledFacts: null,
    countExclusion: null,
    ...(CONTRAST_AXE_RULE_IDS.has(ruleId) ? computedContrastFieldOf(checks) : {}),
  });
}

/**
 * COV-6: ルールのすべての要素を記録する（axe の結果は 1 回の実行ですでに全部そろっているので、分けて集め直す必要はない）。`omittedNodeCount` は、
 * 古い版の記録を読むためだけに残す項目で、常に 0。
 */
function ruleEvidence(rule: AxeRule, result: AccessibilityCheckResult): AccessibilityRuleEvidence {
  return Object.freeze({
    ruleId: rule.id,
    impact: rule.impact ?? null,
    help: rule.help,
    helpUrl: rule.helpUrl,
    tags: Object.freeze([...rule.tags]),
    nodes: Object.freeze(rule.nodes.map((node) => nodeEvidence(node, rule.id, result))),
    omittedNodeCount: 0,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// AUD-8（4-3）: 色差の対象の無効の事実
// ---------------------------------------------------------------------------------------------------------------

/** ページの中で読んだ、1 つの要素の無効の手がかり（判定の前の値）。 */
interface RawDisabledFacts {
  readonly matchesDisabled: boolean;
  readonly disabledAttribute: AccessibilityDisabledPlace | null;
  readonly ariaDisabled: AccessibilityDisabledPlace | null;
  readonly inert: AccessibilityDisabledPlace | null;
  readonly pointerEvents: string;
  readonly cursor: string;
  readonly tabIndexNegative: boolean;
}

const isPlace = (value: unknown): value is AccessibilityDisabledPlace | null => value === null || value === 'SELF' || value === 'ANCESTOR';

const isRawDisabledFacts = (value: unknown): value is RawDisabledFacts =>
  isPlainRecord(value)
  && typeof value['matchesDisabled'] === 'boolean'
  && isPlace(value['disabledAttribute'])
  && isPlace(value['ariaDisabled'])
  && isPlace(value['inert'])
  && typeof value['pointerEvents'] === 'string'
  && typeof value['cursor'] === 'string'
  && typeof value['tabIndexNegative'] === 'boolean';

/** 見た目だけ無効の手がかり（押せない形）。 */
const VISUALLY_DISABLED_POINTER_EVENTS = 'none';
const VISUALLY_DISABLED_CURSOR = 'not-allowed';

/**
 * ページの中で読んだ値（要素が見つからなければ `null`）から、無効の事実の Evidence を作る（純粋。判定の唯一の置き場所）。
 * - 支援技術に無効と伝わる: `:disabled` に当たる、`aria-disabled="true"`（祖先を含む）、`inert`（祖先を含む）、AUD-4b: AX（ブラウザのアクセシビリティの木）が
 *   無効とする（`axDisabled` が真）。
 * - 見た目だけ無効: `pointer-events: none` か `cursor: not-allowed` で、支援技術に無効と伝わらない。薄い見た目（色）だけでは、どちらにもしない。
 * 形の違う値は `NOT_READ`。`axDisabled` は、AX を読めなかったら `null`（DOM の事実だけで決める）。
 */
export function disabledFactsEvidenceOf(raw: unknown, axDisabled: boolean | null = null): AccessibilityDisabledFactsEvidence {
  if (raw === null) {
    return Object.freeze({ status: 'NOT_FOUND' });
  }
  if (!isRawDisabledFacts(raw)) {
    return Object.freeze({ status: 'NOT_READ' });
  }
  const disabledForAssistiveTech = raw.matchesDisabled || raw.ariaDisabled !== null || raw.inert !== null || axDisabled === true;
  const visuallyDisabled = raw.pointerEvents === VISUALLY_DISABLED_POINTER_EVENTS || raw.cursor === VISUALLY_DISABLED_CURSOR;
  return Object.freeze({
    status: 'READ',
    matchesDisabled: raw.matchesDisabled,
    disabledAttribute: raw.disabledAttribute,
    ariaDisabled: raw.ariaDisabled,
    inert: raw.inert,
    axDisabled,
    pointerEvents: raw.pointerEvents,
    cursor: raw.cursor,
    tabIndexNegative: raw.tabIndexNegative,
    disabledForAssistiveTech,
    disabledStateNotExposed: visuallyDisabled && !disabledForAssistiveTech,
  });
}

/** `readDisabledFactsReader` の入力（axe の対象の selector。切る前の値）。 */
interface DisabledFactsArgument {
  readonly targets: readonly (readonly (string | readonly string[])[])[];
}

/** AUD-3d の続き: ページの中で読む axe の対象の 1 つ（target と、読むもの）。 */
interface AxeTargetRequest {
  readonly target: readonly (string | readonly string[])[];
  /** 無効の手がかりを読むか（色差の Rule の要素）。 */
  readonly disabled: boolean;
  /** 矩形を読むか（違反の要素）。 */
  readonly region: boolean;
}

/** AUD-3d の続き: ページの中で読んだ矩形（ビューポートの座標）か、読めなかった理由（`IN_FRAME`・`NOT_FOUND`・`NO_BOX`）。 */
type RawTargetRegion =
  | { readonly rect: RectangleEvidence }
  | { readonly reason: 'NOT_FOUND' | 'IN_FRAME' | 'NO_BOX' };

/** AUD-3d の続き: ページの中で読んだ、axe の対象の事実（読まなかったものは `undefined`）と、矩形を読んだときのスクロール位置。 */
interface RawAxeTargetFacts {
  readonly scrollPosition: { readonly scrollX: number; readonly scrollY: number };
  readonly items: readonly { readonly disabled?: RawDisabledFacts | null; readonly region?: RawTargetRegion }[];
}

/**
 * ページの中で、axe の対象ごとに、無効の手がかりを読む（見つからなければ `null`）。axe の target は、frame ごとの段の並び（段は selector か、shadow root を
 * たどる selector の並び）。次の段へは、同じ Origin の iframe の文書に入る。部品（`R`）を `composeInPage` で組み込んで `page.evaluate` に渡すため、この関数の
 * 外にあるものを参照しない。祖先（`disabled`・`aria-disabled`・`inert` の `ANCESTOR`）は、shadow root の境を越えて host から外へたどる。
 * 公開するのは、shadow root の境を越えるたどり方を、偽の DOM で確かめる単体のテストのため（本番は `readAxeTargetsInPage` だけを使う）。
 */
export function readDisabledFactsReader(R: StandardReaders, { targets }: DisabledFactsArgument): (RawDisabledFacts | null)[] {
  return readAxeTargetsReader(R, { targets: targets.map((target) => ({ target, disabled: true, region: false })) })
    .items.map((item) => item.disabled ?? null);
}

/**
 * AUD-3d の続き: ページの中で、axe の対象ごとに、無効の手がかり（`disabled` が真のもの）と、矩形（`region` が真のもの。ビューポートの座標）を読む。
 * 対象の見つけ方は 1 つ（frame ごとの段の並び。shadow root をたどる）。iframe の中の要素の矩形は、ビューポートの座標に直せないので読まない（`IN_FRAME`）。
 * 部品（`R`）を `composeInPage` で組み込んで `page.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
export function readAxeTargetsReader(
  R: StandardReaders,
  { targets }: { readonly targets: readonly AxeTargetRequest[] },
): RawAxeTargetFacts {
  // open な shadow root は、部品の `openRoots`（文書の中のすべての open な shadow root）から、host で引く（自分で木をたどらない。CC-099）。
  const openShadowRoots = R.openRoots().filter((root): root is ShadowRoot => root instanceof ShadowRoot);
  const shadowRootOf = (element: Element): ShadowRoot | null => openShadowRoots.find((root) => root.host === element) ?? null;
  const parentElementOf = R.standardGetter<Element | null>(Node.prototype, 'parentElement');
  const parentNodeOf = R.standardGetter<Node | null>(Node.prototype, 'parentNode');
  const hostOf = R.standardGetter<Element>(ShadowRoot.prototype, 'host');
  // 描画の木の親（親の要素。open・閉じたを問わず、shadow root の直下ならその host）。`aria-disabled`・`inert` は host を経て外の祖先からも効くので、
  // shadow root の境を越えてたどる。
  const flatTreeParentOf = (element: Element): Element | null => {
    const parentElement = parentElementOf(element);
    if (parentElement !== null) {
      return parentElement;
    }
    const parentNode = parentNodeOf(element);
    return parentNode instanceof ShadowRoot ? hostOf(parentNode) : null;
  };
  const query = (root: Document | ShadowRoot | Element, selector: string): Element | null => {
    try {
      return root instanceof Document
        ? Document.prototype.querySelector.call(root, selector)
        : root instanceof ShadowRoot
          ? DocumentFragment.prototype.querySelector.call(root, selector)
          : Element.prototype.querySelector.call(root, selector);
    } catch {
      return null;
    }
  };
  const locate = (target: readonly (string | readonly string[])[]): Element | null => {
    let root: Document | null = document;
    let element: Element | null = null;
    for (const step of target) {
      if (root === null) {
        return null;
      }
      const path = typeof step === 'string' ? [step] : step;
      let scope: Document | ShadowRoot = root;
      element = null;
      for (const selector of path) {
        element = query(scope, selector);
        if (element === null) {
          return null;
        }
        const shadowRoot = shadowRootOf(element);
        if (shadowRoot !== null) {
          scope = shadowRoot;
        }
      }
      root = element instanceof HTMLIFrameElement ? element.contentDocument : null;
    }
    return element;
  };
  const placeOf = (element: Element, has: (candidate: Element) => boolean): 'SELF' | 'ANCESTOR' | null => {
    if (has(element)) {
      return 'SELF';
    }
    for (let ancestor = flatTreeParentOf(element); ancestor !== null; ancestor = flatTreeParentOf(ancestor)) {
      if (has(ancestor)) {
        return 'ANCESTOR';
      }
    }
    return null;
  };
  const attributeOf = (element: Element, name: string): string | null => Element.prototype.getAttribute.call(element, name);
  const disabledFactsOf = (element: Element): RawDisabledFacts => {
    const style = window.getComputedStyle(element);
    const tabIndex = attributeOf(element, 'tabindex');
    return {
      matchesDisabled: Element.prototype.matches.call(element, ':disabled'),
      disabledAttribute: placeOf(element, (candidate) => attributeOf(candidate, 'disabled') !== null),
      ariaDisabled: placeOf(element, (candidate) => attributeOf(candidate, 'aria-disabled')?.trim().toLowerCase() === 'true'),
      inert: placeOf(element, (candidate) => attributeOf(candidate, 'inert') !== null),
      pointerEvents: style.pointerEvents,
      cursor: style.cursor,
      tabIndexNegative: tabIndex !== null && Number.parseInt(tabIndex, 10) < 0,
    };
  };
  const regionOf = (target: readonly (string | readonly string[])[], element: Element | null): RawTargetRegion => {
    if (target.length > 1) {
      return { reason: 'IN_FRAME' };
    }
    if (element === null) {
      return { reason: 'NOT_FOUND' };
    }
    const box = Element.prototype.getBoundingClientRect.call(element);
    if (!(box.width > 0) || !(box.height > 0)) {
      return { reason: 'NO_BOX' };
    }
    return {
      rect: { x: box.x, y: box.y, top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height },
    };
  };
  return {
    scrollPosition: { scrollX: window.scrollX, scrollY: window.scrollY },
    items: targets.map(({ target, disabled, region }) => {
      const element = locate(target);
      return {
        ...(disabled ? { disabled: element === null ? null : disabledFactsOf(element) } : {}),
        ...(region ? { region: regionOf(target, element) } : {}),
      };
    }),
  };
}
const readAxeTargetsInPage = composeInPage(readAxeTargetsReader);

/** 違反と要確認の Rule の Evidence（AUD-3d の続き: 違反の要素の矩形を読んだときのスクロール位置。読まなかったら持たない）。 */
interface RuleEvidenceLists {
  readonly violations: readonly AccessibilityRuleEvidence[];
  readonly incomplete: readonly AccessibilityRuleEvidence[];
  readonly regionScrollPosition?: ScrollPosition | null;
  /** EV-1: 判定した axe の版（axe の結果の `testEngine.version`）。 */
  readonly axeVersion?: string;
}

/**
 * AUD-3d の続き: ページの中で読む axe の対象（違反の全部の要素（矩形。色差の Rule の要素は無効の手がかりも）、要確認の色差の Rule の要素（無効の手がかり）の順）。
 */
const axeTargetRequestsOf = (analyzed: AxeResults): AxeTargetRequest[] => [
  ...analyzed.violations.flatMap((rule) => rule.nodes.map((node): AxeTargetRequest => ({
    target: node.target as AxeTargetRequest['target'],
    disabled: CONTRAST_AXE_RULE_IDS.has(rule.id),
    region: true,
  }))),
  ...analyzed.incomplete.filter((rule) => CONTRAST_AXE_RULE_IDS.has(rule.id)).flatMap((rule) => rule.nodes.map((node): AxeTargetRequest => ({
    target: node.target as AxeTargetRequest['target'],
    disabled: true,
    region: false,
  }))),
];

/** AUD-3d の続き: ページの中で読んだ矩形の形を確かめて、Evidence にする（形が違えば `NOT_READ`）。 */
const targetRegionEvidenceOf = (raw: unknown): AccessibilityTargetRegionEvidence => {
  if (typeof raw === 'object' && raw !== null) {
    const { rect, reason } = raw as { readonly rect?: unknown; readonly reason?: unknown };
    if (typeof rect === 'object' && rect !== null) {
      const values = rect as Record<string, unknown>;
      const keys = ['x', 'y', 'top', 'right', 'bottom', 'left', 'width', 'height'] as const;
      if (keys.every((key) => typeof values[key] === 'number' && Number.isFinite(values[key]))) {
        return Object.freeze({
          status: 'READ',
          rect: Object.freeze(Object.fromEntries(keys.map((key) => [key, values[key] as number])) as unknown as RectangleEvidence),
        });
      }
    }
    if (reason === 'NOT_FOUND' || reason === 'IN_FRAME' || reason === 'NO_BOX') {
      return Object.freeze({ status: 'UNREADABLE', reason });
    }
  }
  return Object.freeze({ status: 'UNREADABLE', reason: 'NOT_READ' });
};

/**
 * AUD-3d の続き: ページの中で読んだ事実（`read`。使えなければ `null`）を付ける。無効の手がかりは色差の Rule の要素に（`attachDisabledFacts`）、矩形は違反の
 * 要素に付け、矩形を読んだときのスクロール位置を残す。`read` の形が違えば、無効の事実は `NOT_READ`、矩形は理由 `NOT_READ`。
 */
function attachTargetFacts(
  lists: RuleEvidenceLists,
  analyzed: AxeResults,
  requests: readonly AxeTargetRequest[],
  read: unknown,
  ax: AxFactsOfAnalyzed = NO_AX_FACTS,
): RuleEvidenceLists {
  const facts = typeof read === 'object' && read !== null ? read as Partial<RawAxeTargetFacts> : null;
  const items: readonly unknown[] | null = facts !== null && Array.isArray(facts.items) && facts.items.length === requests.length ? facts.items : null;
  const disabledRead = items === null
    ? null
    : items.filter((_item, index) => requests[index]?.disabled === true).map((item) => (item as { readonly disabled?: unknown }).disabled);
  const withDisabled = attachDisabledFacts(lists.violations, lists.incomplete, contrastTargetsOf(analyzed), disabledRead, ax.contrastAxDisabled);
  let index = 0;
  let mismatchIndex = 0;
  const violations = Object.freeze(withDisabled.violations.map((rule) => Object.freeze({
    ...rule,
    nodes: Object.freeze(rule.nodes.map((node) => {
      const item = items?.[index];
      index += 1;
      const region = targetRegionEvidenceOf(item === undefined ? null : (item as { readonly region?: unknown }).region);
      if (rule.ruleId !== LABEL_IN_NAME_AXE_RULE_ID) {
        return Object.freeze({ ...node, region });
      }
      // AUD-4b: 名前の不一致の要素には、AX の名前の文脈を付ける（読まなかったときは `NOT_READ`）。
      const nameContext = ax.nameContexts[mismatchIndex] ?? NOT_READ_NAME_CONTEXT;
      mismatchIndex += 1;
      return Object.freeze({ ...node, region, nameContext });
    })),
  })));
  const scroll = facts?.scrollPosition;
  const regionScrollPosition = items !== null && typeof scroll?.scrollX === 'number' && typeof scroll.scrollY === 'number'
    ? Object.freeze({ scrollX: scroll.scrollX, scrollY: scroll.scrollY })
    : null;
  return { violations, incomplete: withDisabled.incomplete, regionScrollPosition, ...axeVersionFieldOf(lists) };
}

/** EV-1: axe の版の項目（読めなかったら、項目なし）。 */
const axeVersionFieldOf = (lists: Pick<RuleEvidenceLists, 'axeVersion'>): { readonly axeVersion?: string } =>
  (lists.axeVersion === undefined ? {} : { axeVersion: lists.axeVersion });

/** AUD-4b: 名前の不一致の axe の Rule の ID。 */
const LABEL_IN_NAME_AXE_RULE_ID = 'label-content-name-mismatch';

/** AUD-4b: AX を読めなかった名前の文脈。 */
const NOT_READ_NAME_CONTEXT: AccessibilityNameContextEvidence = Object.freeze({ status: 'UNREADABLE', reason: 'NOT_READ' });

/** AUD-4b: axe の結果の要素の AX の事実（色差の要素の無効の状態は `contrastTargetsOf` の順、名前の不一致の違反の要素の文脈は違反の順）。 */
interface AxFactsOfAnalyzed {
  readonly contrastAxDisabled: readonly (boolean | null)[];
  readonly nameContexts: readonly AccessibilityNameContextEvidence[];
}

const NO_AX_FACTS: AxFactsOfAnalyzed = Object.freeze({ contrastAxDisabled: [], nameContexts: [] });

/** AUD-4b: 名前の不一致の違反の要素の axe の target（違反の順）。 */
const labelInNameTargetsOf = (analyzed: AxeResults): AxeNode['target'][] =>
  analyzed.violations.filter((rule) => rule.id === LABEL_IN_NAME_AXE_RULE_ID).flatMap((rule) => rule.nodes.map((node) => node.target));

/**
 * AUD-4b: 色差の要素と名前の不一致の違反の要素の AX の事実を、CDP の Accessibility から 1 回の session で読む（`readAccessibilityAxFacts`。ページの main world で
 * JS を動かさない）。読めなかった要素は、無効の状態が `null`、名前の文脈が理由つき。
 */
async function readAxFactsOf(
  page: Page,
  analyzed: AxeResults,
  track?: <T>(work: Promise<T>) => Promise<T>,
): Promise<AxFactsOfAnalyzed> {
  const contrast = contrastTargetsOf(analyzed);
  const mismatch = labelInNameTargetsOf(analyzed);
  if (contrast.length === 0 && mismatch.length === 0) {
    return NO_AX_FACTS;
  }
  const facts = await readAccessibilityAxFacts(page, [...contrast, ...mismatch] as unknown as readonly (readonly AccessibilityTargetSelector[])[], track);
  return {
    contrastAxDisabled: facts.slice(0, contrast.length).map((fact) => (fact.status === 'READ' ? fact.axDisabled : null)),
    nameContexts: facts.slice(contrast.length),
  };
}

/** 色差の Rule の要素の axe の target（違反、要確認の順）。 */
const contrastTargetsOf = (analyzed: AxeResults): AxeNode['target'][] =>
  [...analyzed.violations, ...analyzed.incomplete]
    .filter((rule) => CONTRAST_AXE_RULE_IDS.has(rule.id))
    .flatMap((rule) => rule.nodes.map((node) => node.target));

/** axe の結果を Evidence にする（違反は `FAILED`、要確認は `UNDETERMINED`）。 */
const ruleEvidenceListsOf = (analyzed: AxeResults): RuleEvidenceLists => ({
  violations: analyzed.violations.map((rule) => ruleEvidence(rule, 'FAILED')),
  incomplete: analyzed.incomplete.map((rule) => ruleEvidence(rule, 'UNDETERMINED')),
  // EV-1: 判定した axe の版を残す（形が違えば残さない）。
  ...(typeof analyzed.testEngine?.version === 'string' ? { axeVersion: analyzed.testEngine.version } : {}),
});

/**
 * 色差の Rule の要素に、読んだ無効の手がかり（`read`。使えなければ `null`）から、無効の事実と主の件数から外す印を付ける。`read` の形が違えば、
 * どの要素も `NOT_READ`。
 */
function attachDisabledFacts(
  violations: readonly AccessibilityRuleEvidence[],
  incomplete: readonly AccessibilityRuleEvidence[],
  targets: readonly unknown[],
  read: unknown,
  axDisabled: readonly (boolean | null)[] = [],
): RuleEvidenceLists {
  const rawFacts: readonly unknown[] = Array.isArray(read) && read.length === targets.length
    ? read
    : targets.map(() => ({ unreadable: true }));
  let index = 0;
  const attach = (rules: readonly AccessibilityRuleEvidence[]): readonly AccessibilityRuleEvidence[] => Object.freeze(rules.map((rule) => {
    if (!CONTRAST_AXE_RULE_IDS.has(rule.ruleId)) {
      return rule;
    }
    return Object.freeze({
      ...rule,
      nodes: Object.freeze(rule.nodes.map((node) => {
        // AUD-4b: AX の無効の状態も、同じ 1 か所（`disabledFactsEvidenceOf`）で判定に入れる。
        const disabledFacts = disabledFactsEvidenceOf(rawFacts[index], axDisabled[index] ?? null);
        index += 1;
        const excluded = disabledFacts.status === 'READ' && disabledFacts.disabledForAssistiveTech;
        return Object.freeze({ ...node, disabledFacts, countExclusion: excluded ? 'DISABLED_FOR_ASSISTIVE_TECH' as const : null });
      })),
    });
  }));
  return { violations: attach(violations), incomplete: attach(incomplete) };
}

function partial(
  reason: AccessibilityIncompleteReason,
  scrollPosition: Readonly<ScrollPosition> | null,
  collected: RuleEvidenceLists = { violations: [], incomplete: [] },
): AccessibilityEvidence {
  return Object.freeze({
    status: 'PARTIAL',
    reason,
    scrollPosition,
    frameScope: FRAME_SCOPE,
    violations: Object.freeze([...collected.violations]),
    incomplete: Object.freeze([...collected.incomplete]),
    ...(collected.regionScrollPosition === undefined ? {} : { regionScrollPosition: collected.regionScrollPosition }),
    ...axeVersionFieldOf(collected),
  });
}

/** 集めた Evidence（COMPLETE）。 */
const complete = (scrollPosition: Readonly<ScrollPosition>, collected: RuleEvidenceLists): AccessibilityEvidence => Object.freeze({
  status: 'COMPLETE',
  scrollPosition,
  frameScope: FRAME_SCOPE,
  violations: Object.freeze([...collected.violations]),
  incomplete: Object.freeze([...collected.incomplete]),
  ...(collected.regionScrollPosition === undefined ? {} : { regionScrollPosition: collected.regionScrollPosition }),
  ...axeVersionFieldOf(collected),
});

/** L2: 見張った収集の途中の記録（見張りが終えても、ここまでを残す）。 */
interface WatchedAccessibilityProgress {
  scrollPosition: Readonly<ScrollPosition> | null;
  /** axe の結果の Evidence（無効の事実はまだ `null`）と、axe の結果・読む対象（AUD-3d の続き）。 */
  analyzed: (RuleEvidenceLists & { readonly results: AxeResults; readonly requests: readonly AxeTargetRequest[] }) | null;
}

/**
 * L2（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 期限を置かずに、進みの見張り（`watchCollection`）で集める。ブラウザの呼び出し
 * （スクロール位置・axe・無効の事実）は、返るたびに中身の進みの印を付ける。axe の 1 回の呼び出しは長くなりうるが、L0 の反応なしの長さで受ける。
 * 見張りが終えたら（全く反応がない・静まらない）、理由つきの `PARTIAL` で、それまでの記録（スクロール位置、axe の結果。無効の事実は `NOT_READ`）を残す。
 */
async function collectWatched(page: Page, options: CollectorWatchOptions): Promise<AccessibilityEvidence> {
  const progress: WatchedAccessibilityProgress = { scrollPosition: null, analyzed: null };
  const outcome = await watchCollection(page, (signals) => collectAccessibilityWith(axePortOf(page), signals, progress), options);
  switch (outcome.status) {
    case 'FULFILLED':
      return outcome.value;
    case 'REJECTED':
      return partial('EVALUATION_FAILED', progress.scrollPosition);
    case 'ENDED': {
      const analyzed = progress.analyzed;
      return analyzed === null
        ? partial(outcome.end, progress.scrollPosition)
        : partial(outcome.end, progress.scrollPosition, attachTargetFacts(analyzed, analyzed.results, analyzed.requests, null));
    }
  }
}

/**
 * RB-10: axe の読みが頼むページの 4 操作（本物は `axePortOf(page)`、テストは偽の口）。手順と判定は `collectAccessibilityWith` だけが持つ。
 */
export interface AccessibilityAxePort {
  readScrollPosition(): Promise<Readonly<ScrollPosition>>;
  analyze(): Promise<AxeResults>;
  /** 違反の要素の矩形と、色差の要素の無効の手がかり（生の答え。形は呼ぶ側が確かめる）。 */
  readTargets(requests: readonly AxeTargetRequest[]): Promise<unknown>;
  readAxFacts(analyzed: AxeResults, track: <T>(work: Promise<T>) => Promise<T>): Promise<AxFactsOfAnalyzed>;
}

/** 本物の口（Playwright の page。axe はレガシーの方式で、対象の page の中だけで流す。DEF-001）。 */
const axePortOf = (page: Page): AccessibilityAxePort => Object.freeze({
  readScrollPosition: () => readDocumentScrollPosition(page),
  analyze: () => axeBuilderFor(page).analyze(),
  readTargets: (requests: readonly AxeTargetRequest[]) => page.evaluate(readAxeTargetsInPage, { targets: requests }),
  readAxFacts: (analyzed: AxeResults, track: <T>(work: Promise<T>) => Promise<T>) => readAxFactsOf(page, analyzed, track),
});

/** 見張りの中の手順（スクロール位置 → axe → 無効の事実）。途中の記録は `progress` に入れる。 */
export async function collectAccessibilityWith(
  port: AccessibilityAxePort,
  signals: ProgressSignals,
  progress: WatchedAccessibilityProgress = { scrollPosition: null, analyzed: null },
): Promise<AccessibilityEvidence> {
  let scrollPosition: Readonly<ScrollPosition>;
  try {
    scrollPosition = await signals.track(port.readScrollPosition());
  } catch {
    return partial('EVALUATION_FAILED', null);
  }
  progress.scrollPosition = scrollPosition;
  let analyzed: AxeResults;
  try {
    analyzed = await signals.track(port.analyze());
  } catch {
    return partial('EVALUATION_FAILED', scrollPosition);
  }
  const lists = ruleEvidenceListsOf(analyzed);
  // AUD-3d の続き: 違反の要素の矩形と、色差の要素の無効の手がかりを、1 回のページの中の読み取りで読む。
  const requests = axeTargetRequestsOf(analyzed);
  progress.analyzed = { ...lists, results: analyzed, requests };
  if (requests.length === 0) {
    return complete(scrollPosition, lists);
  }
  let read: unknown = null;
  try {
    read = await signals.track(port.readTargets(requests));
  } catch {
    // 読み取りの失敗は、どの要素も `NOT_READ`（axe の結果は残す）。
  }
  // AUD-4b: AX の事実（CDP の Accessibility。命令が返るたびに進みの印を付ける）。
  const ax = await port.readAxFacts(analyzed, (work) => signals.track(work));
  return complete(scrollPosition, attachTargetFacts(lists, analyzed, requests, read, ax));
}

/**
 * フィルタなしで axe を実行し、違反（`violations`）と要確認（`incomplete`）を別々に、イミュータブルな証跡に変換する。実行の失敗は、理由付きの
 * `PARTIAL` で返す。
 *
 * axe はレガシーの方式（`setLegacyMode(true)`）で、対象の page の中だけで実行する。既定の方式は、
 * 結果をまとめるために同じ Context に別の page を開いて閉じるため、Passive Request Guard が
 * その page の CDP セッションの切り離しを不変条件の違反として記録し、Context を閉じてしまう（DEF-001）。
 * この方式では、axe は同じOriginの文書だけを検査し、別Originの iframe の中は検査しない
 * （別Originの iframe は Passive Context の許可Originの外なので、もともと監査の対象外である）。
 * この制約は、証跡の `frameScope` に記録する。
 *
 * axe を実行する直前に、文書のスクロール位置を読み、`scrollPosition` に記録する（R4 の M1）。位置を読めなかった場合は、axe を実行せずに
 * `scrollPosition: null` の `PARTIAL` を返す。
 *
 * L2: 期限を置かずに、進みの見張りで待つ（`collectWatched`）。RB-9: 呼ばれていなかった期限つきの枝は消した。
 */
export async function collectAccessibilityEvidence(
  page: Page,
  options: AccessibilityCollectionOptions = {},
): Promise<AccessibilityEvidence> {
  return collectWatched(page, options.watch ?? {});
}

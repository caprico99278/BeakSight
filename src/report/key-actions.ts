/**
 * BS-2（設計書 `doc/design/2026-11-20-beaksight-key-action-positions-design.md` 2.2〜2.4）: 主要な行動の候補の位置の事実の集計（数えるのは、ここだけ。呼ぶのは
 * 表示用モデルの組み立て `src/report/view-model.ts` だけ）。HTML と ChatGPT 用バンドルは、表示用モデルの `summary.keyActions` を描くだけで、数え直さない。
 * - 元: 各ページの最終の試行の、ビューポートごとの最初の layout の Evidence（読み込みの段。確かめ直し・開いた状態の段は数えない）の主の layout の
 *   `keyActionElements`（記録のない前の版の layout は、読んでいないページとして数えない）と、同じビューポートの scroll の Evidence（ページの高さ）。
 * - 種類は `src/core/key-actions.ts` の `keyActionKindOf` だけで決める。名前は電話番号とメールアドレスに見える文字を伏せ、長さの上限で切る。
 * - 固定の表示の覆いの指摘との結び付け（2.3）: 覆う側・覆われる側の候補の種類と、押せないかを確かめた証拠（動かして測り直した記録で「押せません」と言える）の
 *   有無。証拠がなければ `NOT_CHECKED`（操作の支障は確かめていない）。
 * - Finding は作らない（Run の事実の集計）。どれが大事か・見つけやすいか・押せるかは判定しない。
 * - AUDR2: 文書がスクロールしない画面は、ページの高さを内側のスクロールの入れ物の高さにする（`pageHeightFactsOf`）。共通の枠の候補の印（`sharedFrame`）と、
 *   本文と共通の枠に分けた数も、ここで数える。
 */
import {
  FIXED_OCCLUSION_RULE_ID,
  OVERSIZED_FIXED_ELEMENT_RULE_ID,
  classifiedOcclusionPairsOf,
  isFindingFixedOverlapClass,
  occlusionRevealOf,
} from '../audit/fixed-overlap-classes.js';
import { roundedSelectorOf } from '../audit/finding-grouping-keys.js';
import { VIEWPORT_PROFILES, type EvidenceId, type EvidencePayloadByType, type PageAuditResult, type PageId, type ViewportProfile } from '../core/contracts.js';
import type { KeyActionElementEvidence, LayoutEvidence, RectangleEvidence, RevealedTargetEvidence } from '../core/evidence-types.js';
import {
  KEY_ACTION_ELEMENT_SELECTOR,
  KEY_ACTION_HREF_SCHEME_KINDS,
  KEY_ACTION_KINDS,
  KEY_ACTION_MESSAGE_HOSTS,
  KEY_ACTION_NAME_MAX_LENGTH,
  KEY_ACTION_WORDS,
  keyActionKindOf,
  maskContactValues,
  type KeyActionKind,
} from '../core/key-actions.js';
import { truncateText } from '../core/text.js';
import { dataFreePathOfUrl } from '../discovery/fingerprint.js';
import type { EvidenceLocationView } from './view-model.js';

/** 押せないかを確かめた証拠の有無（`PRESS_BLOCKED_OBSERVED`: 動かして測り直し、末尾でも押下を覆いが受けると分かった。`NOT_CHECKED`: 確かめていない）。 */
export const KEY_ACTION_PRESS_CHECKS = Object.freeze(['PRESS_BLOCKED_OBSERVED', 'NOT_CHECKED'] as const);
export type KeyActionPressCheck = (typeof KEY_ACTION_PRESS_CHECKS)[number];

/** 位置の割合の小数の桁。 */
const RATIO_DIGITS = 3;

/** 候補 1 つの位置の事実。 */
export interface KeyActionView {
  readonly kind: KeyActionKind;
  /** 見える文字（なければ `aria-label`・`title`）。電話番号とメールアドレスに見える文字は伏せ、長さの上限で切る。 */
  readonly name: string;
  /** 文書の中の位置（ページの先頭からの y。固定の表示は、先頭の位置で見えている y）と高さ（px）。 */
  readonly top: number;
  readonly height: number;
  /** 最初の画面（先頭の位置のビューポートの高さ）に入るか。 */
  readonly inFirstView: boolean;
  /** 固定の表示（`position: fixed | sticky` の要素の中）か。 */
  readonly fixed: boolean;
  readonly visible: boolean;
  /**
   * ページの高さに対する位置の割合（0〜1。固定の表示と、高さが分からないときは `null`）。AUDR2: ページの高さが内側の入れ物の高さなら、その入れ物の中の候補
   * だけ、入れ物の中の位置の割合（入れ物の外の候補は `null`）。
   */
  readonly positionRatio: number | null;
  /** AUDR2: 内側のスクロールの入れ物の中の候補か（真なら `top` は入れ物の中の位置）。 */
  readonly inScrollContainer: boolean;
  /**
   * AUDR2: 共通の枠の候補か（データを除いた path の違う 2 つ以上のページに、同じ要素（番号と描画の順の id を丸めた selector・名前・種類が同じ）として、同じ
   * ビューポートで出る）。
   */
  readonly sharedFrame: boolean;
}

/**
 * AUDR2: ページの高さの元（`DOCUMENT`: 文書。`INNER_SCROLL_CONTAINER`: 文書がスクロールしないので、scroll の記録のいちばん大きな内側のスクロールの入れ物。
 * `UNKNOWN`: 文書がスクロールせず、内側の入れ物の記録もないので分からない）。
 */
export const KEY_ACTION_PAGE_HEIGHT_BASES = Object.freeze(['DOCUMENT', 'INNER_SCROLL_CONTAINER', 'UNKNOWN'] as const);
export type KeyActionPageHeightBasis = (typeof KEY_ACTION_PAGE_HEIGHT_BASES)[number];

/** ページ × ビューポートの一覧の 1 行（候補がなければ `actions` は空。「ない」とは限らない）。 */
export interface KeyActionPageView {
  readonly pageId: PageId;
  readonly viewport: ViewportProfile;
  readonly viewportHeight: number;
  /**
   * ページの高さ（scroll の記録の最大の `scrollHeight`。なければ layout の文書の高さ）。AUDR2: 文書がスクロールしなければ、内側の入れ物の高さ（記録がなければ
   * `null`）。
   */
  readonly pageHeight: number | null;
  /** AUDR2: ページの高さの元。 */
  readonly pageHeightBasis: KeyActionPageHeightBasis;
  readonly actions: readonly KeyActionView[];
  /** 根拠の layout の Evidence の場所（分からなければ `null`）。 */
  readonly evidence: { readonly evidenceId: EvidenceId; readonly path: string; readonly pointer: string } | null;
}

/** ページの高さの分布（ビューポートごと。読んだページがなければ `null`）。 */
export interface KeyActionPageHeightView {
  readonly pageCount: number;
  readonly minPx: number;
  readonly medianPx: number;
  readonly maxPx: number;
}

/** サイト全体の要約。 */
export interface KeyActionSummaryView {
  /** 候補を読んだページの数（どれかのビューポートで記録があるページ）。 */
  readonly pageCount: number;
  /** 種類ごとの、候補を持つページの数。 */
  readonly pagesWithKind: Readonly<Record<KeyActionKind, number>>;
  /** AUDR2: 種類ごとの、本文（共通の枠でない）に候補を持つページの数と、共通の枠に候補を持つページの数。 */
  readonly pagesWithKindInBody: Readonly<Record<KeyActionKind, number>>;
  readonly pagesWithKindInSharedFrame: Readonly<Record<KeyActionKind, number>>;
  /** 固定の表示の中に候補があるページの数。 */
  readonly pagesWithFixedCandidate: number;
  /** ビューポートごとの、最初の画面に見える候補がないページの数。 */
  readonly pagesWithoutFirstViewCandidate: Readonly<Record<ViewportProfile, number>>;
  readonly pageHeights: Readonly<Record<ViewportProfile, KeyActionPageHeightView | null>>;
}

/** 検出の範囲（どの要素の種類と語で探したか。一覧の写し）。 */
export interface KeyActionScopeView {
  readonly elementSelector: string;
  readonly hrefSchemeKinds: Readonly<Record<string, KeyActionKind>>;
  readonly messageHosts: readonly string[];
  readonly words: Readonly<Record<string, readonly string[]>>;
}

/** 主要な行動の候補の位置の事実（`summary.keyActions`）。 */
export interface KeyActionsView {
  readonly summary: KeyActionSummaryView;
  readonly pages: readonly KeyActionPageView[];
  readonly scope: KeyActionScopeView;
}

/** 固定の表示の覆いの指摘に付ける、候補の種類と、押せないかを確かめた証拠の有無（`verification.keyActions`）。 */
export interface FixedOverlapKeyActionView {
  readonly overlayKinds: readonly KeyActionKind[];
  readonly coveredKinds: readonly KeyActionKind[];
  readonly pressCheck: KeyActionPressCheck;
}

/** AUDR2: 共通の枠の候補とする、データを除いた path の違うページの数の下限（DEF-208-4 の共通の枠のボタンの「2 ページ以上」と同じ）。 */
const SHARED_FRAME_MIN_PATHS = 2;

/** 読み込みの段の layout の Evidence か（確かめ直し・開いた状態の段は除く）。 */
const LAYOUT_PHASE = 'layout';

const kindsOf = (elements: readonly KeyActionElementEvidence[]): readonly KeyActionKind[] => {
  const kinds = new Set(elements.flatMap((element) => {
    const kind = keyActionKindOf(element);
    return kind === null ? [] : [kind];
  }));
  return KEY_ACTION_KINDS.filter((kind) => kinds.has(kind));
};

const nameOf = (element: KeyActionElementEvidence): string => {
  const name = [element.text, element.ariaLabel ?? '', element.title ?? ''].find((value) => value.length > 0) ?? '';
  const truncated = truncateText(maskContactValues(name), KEY_ACTION_NAME_MAX_LENGTH);
  return truncated.truncated ? `${truncated.text}…` : truncated.text;
};

const round = (value: number): number => Number(value.toFixed(RATIO_DIGITS));

/** AUDR2: 内側の入れ物の、layout を読んだときの見える範囲（viewport の座標）と位置（layout の状態の印の箱。分からなければ `null`）。 */
interface ScrollContainerPlacement {
  readonly clientRect: RectangleEvidence;
  readonly scrollTop: number;
}

/** AUDR2: ページの高さの事実。 */
interface PageHeightFacts {
  readonly pageHeight: number | null;
  readonly basis: KeyActionPageHeightBasis;
  readonly container: ScrollContainerPlacement | null;
}

/** AUDR2: 候補が内側の入れ物の中か（横の中心が入れ物の見える範囲の中で、上端が入れ物の上端より下。入れ物の下へ隠れた候補も中とする）。 */
const insideContainer = (rect: RectangleEvidence, box: RectangleEvidence): boolean => {
  const center = rect.left + rect.width / 2;
  return center >= box.left && center <= box.right && rect.top >= box.top;
};

/** 集計の前の候補（AUDR2: 共通の枠の判定の鍵つき）。 */
type CollectedKeyAction = Omit<KeyActionView, 'sharedFrame'> & { readonly identity: string };

/**
 * 1 つの layout の候補の位置の事実（文書のスクロール位置を足して、文書の中の位置にする）。AUDR2: ページの高さが内側の入れ物の高さなら、入れ物の中の候補は
 * 入れ物の中の位置にし、割合はその候補だけに出す。共通の枠の判定の鍵は、ビューポート・丸めた selector（`roundedSelectorOf`）・名前・種類。
 */
const actionsOf = (layout: LayoutEvidence, viewport: ViewportProfile, height: PageHeightFacts): readonly CollectedKeyAction[] =>
  (layout.keyActionElements ?? []).flatMap((element) => {
    const kind = keyActionKindOf(element);
    if (kind === null) {
      return [];
    }
    const fixed = element.fixedContainerSelector !== null;
    const documentTop = fixed ? element.rect.top : element.rect.top + layout.scrollPosition.scrollY;
    const { container, pageHeight } = height;
    const inScrollContainer = !fixed && height.basis === 'INNER_SCROLL_CONTAINER' && container !== null && insideContainer(element.rect, container.clientRect);
    const top = inScrollContainer ? element.rect.top - container.clientRect.top + container.scrollTop : documentTop;
    const ratioKnown = !fixed && pageHeight !== null && pageHeight > 0 && (height.basis === 'DOCUMENT' || inScrollContainer);
    const name = nameOf(element);
    return [{
      kind,
      name,
      top,
      height: element.rect.height,
      inFirstView: element.visible && documentTop < layout.document.viewportHeight && documentTop + element.rect.height > 0,
      fixed,
      visible: element.visible,
      positionRatio: ratioKnown ? round(Math.min(1, Math.max(0, top / pageHeight))) : null,
      inScrollContainer,
      identity: JSON.stringify([viewport, roundedSelectorOf(element.selector), name, kind]),
    }];
  });

const scrollHeightsOf = (payload: EvidencePayloadByType['scroll']): readonly number[] => [
  ...payload.observations.map(({ scrollHeight }) => scrollHeight),
  ...(payload.finalSnapshot === null ? [] : [payload.finalSnapshot.scrollHeight]),
];

/**
 * AUDR2: ページの高さ。文書がスクロールすれば文書の高さ。しなければ、scroll の記録のいちばん大きな内側のスクロールの入れ物の高さ（その入れ物の layout の
 * 状態の印の箱があれば、候補の位置をその中の位置にする）。内側の入れ物がないと確かめた（探した数が 0 で、上限に達していない）なら文書の高さ。どれでもなければ
 * 分からない（`null`。割合を出さない）。
 */
const pageHeightFactsOf = (layout: LayoutEvidence, scrolls: readonly EvidencePayloadByType['scroll'][]): PageHeightFacts => {
  const scrolled = scrolls.flatMap(scrollHeightsOf);
  const documentHeight = Math.max(layout.document.documentElementScrollHeight, layout.document.bodyScrollHeight);
  const documentPageHeight = scrolled.length > 0 ? Math.max(...scrolled) : documentHeight > 0 ? documentHeight : null;
  if (documentPageHeight === null) {
    return { pageHeight: null, basis: 'UNKNOWN', container: null };
  }
  if (documentPageHeight > layout.document.viewportHeight) {
    return { pageHeight: documentPageHeight, basis: 'DOCUMENT', container: null };
  }
  const containers = scrolls.flatMap((payload) => (payload.innerScrollContainers ?? []).flatMap(({ selector, finalScrollHeight, initialScrollHeight }) => {
    const scrollHeight = finalScrollHeight ?? initialScrollHeight;
    return scrollHeight === null ? [] : [{ selector, scrollHeight }];
  }));
  const largest = containers.reduce<(typeof containers)[number] | null>((found, next) => (found === null || next.scrollHeight > found.scrollHeight ? next : found), null);
  if (largest !== null) {
    const box = largest.selector === null ? undefined : layout.stateMark?.scrollBoxes.find(({ selector }) => selector === largest.selector);
    return {
      pageHeight: largest.scrollHeight,
      basis: 'INNER_SCROLL_CONTAINER',
      container: box === undefined ? null : { clientRect: box.clientRect, scrollTop: box.scrollTop },
    };
  }
  const representatives = scrolls.flatMap(({ innerScrollScan }) => (innerScrollScan?.representative == null ? [] : [innerScrollScan.representative.scrollHeight]));
  if (representatives.length > 0) {
    return { pageHeight: Math.max(...representatives), basis: 'INNER_SCROLL_CONTAINER', container: null };
  }
  const noContainer = scrolls.some(({ innerScrollScan }) => innerScrollScan !== null && innerScrollScan.containerCount === 0 && !innerScrollScan.scanLimitReached);
  return noContainer ? { pageHeight: documentPageHeight, basis: 'DOCUMENT', container: null } : { pageHeight: null, basis: 'UNKNOWN', container: null };
};

const medianOf = (sorted: readonly number[]): number => {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] ?? 0 : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/** 主要な行動の候補の位置を、ページを 1 つずつ足して集める（`earlier` は、そのページの再試行の前の試行の Evidence の ID）。 */
export function createKeyActionCollector(): {
  readonly addPage: (page: PageAuditResult, earlier: ReadonlySet<EvidenceId>) => void;
  readonly result: (locationOf: (evidenceId: EvidenceId) => EvidenceLocationView | null) => KeyActionsView;
} {
  const collected: (Omit<KeyActionPageView, 'evidence' | 'actions'> & {
    readonly evidenceId: EvidenceId;
    readonly dataFreePath: string;
    readonly actions: readonly CollectedKeyAction[];
  })[] = [];
  return {
    addPage: (page, earlier) => {
      const records = page.evidence.filter((record) => !earlier.has(record.evidenceId));
      for (const viewport of VIEWPORT_PROFILES) {
        const layoutRecord = records.find((record) => record.type === 'layout' && record.viewport === viewport
          && (record.capture === undefined || record.capture.phase === LAYOUT_PHASE));
        const layout = layoutRecord?.type === 'layout' ? layoutRecord.payload.primary.layout : null;
        if (layoutRecord === undefined || layout === null || layout.keyActionElements === undefined) {
          continue;
        }
        const height = pageHeightFactsOf(layout, records.flatMap((record) => (record.type === 'scroll' && record.viewport === viewport ? [record.payload] : [])));
        collected.push({
          pageId: page.pageId,
          viewport,
          viewportHeight: layout.document.viewportHeight,
          pageHeight: height.pageHeight,
          pageHeightBasis: height.basis,
          actions: actionsOf(layout, viewport, height),
          evidenceId: layoutRecord.evidenceId,
          dataFreePath: dataFreePathOfUrl(page.pageUrl) ?? page.pageUrl,
        });
      }
    },
    result: (locationOf) => {
      // AUDR2: 共通の枠の候補（データを除いた path の違う 2 つ以上のページに、同じ要素として出る。DEF-208-4 の「2 ページ以上」の決まりを、同じ画面の別の
      // データのページを数えない形にしたもの）。
      const pathsByIdentity = new Map<string, Set<string>>();
      for (const row of collected) {
        for (const { identity } of row.actions) {
          pathsByIdentity.set(identity, (pathsByIdentity.get(identity) ?? new Set<string>()).add(row.dataFreePath));
        }
      }
      const rows = collected.map(({ dataFreePath: _dataFreePath, actions, ...row }) => ({
        ...row,
        actions: actions.map(({ identity, ...action }): KeyActionView => ({ ...action, sharedFrame: (pathsByIdentity.get(identity)?.size ?? 0) >= SHARED_FRAME_MIN_PATHS })),
      }));
      const pageIds = [...new Set(rows.map(({ pageId }) => pageId))];
      const pagesWhere = (test: (row: (typeof rows)[number]) => boolean): number => new Set(rows.filter(test).map(({ pageId }) => pageId)).size;
      const pagesWithKindWhere = (test: (action: KeyActionView) => boolean): Record<KeyActionKind, number> =>
        Object.fromEntries(KEY_ACTION_KINDS.map((kind) => [kind, pagesWhere((row) => row.actions.some((item) => item.kind === kind && test(item)))])) as Record<
          KeyActionKind,
          number
        >;
      const pageHeightOf = (viewport: ViewportProfile): KeyActionPageHeightView | null => {
        const heights = rows.filter((row) => row.viewport === viewport).flatMap(({ pageHeight }) => (pageHeight === null ? [] : [pageHeight])).sort((a, b) => a - b);
        return heights.length === 0
          ? null
          : { pageCount: heights.length, minPx: heights[0] ?? 0, medianPx: medianOf(heights), maxPx: heights[heights.length - 1] ?? 0 };
      };
      return {
        summary: {
          pageCount: pageIds.length,
          pagesWithKind: pagesWithKindWhere(() => true),
          pagesWithKindInBody: pagesWithKindWhere(({ sharedFrame }) => !sharedFrame),
          pagesWithKindInSharedFrame: pagesWithKindWhere(({ sharedFrame }) => sharedFrame),
          pagesWithFixedCandidate: pagesWhere((row) => row.actions.some(({ fixed }) => fixed)),
          pagesWithoutFirstViewCandidate: Object.fromEntries(VIEWPORT_PROFILES.map((viewport) => [
            viewport,
            pagesWhere((row) => row.viewport === viewport && !row.actions.some(({ inFirstView }) => inFirstView)),
          ])) as Record<ViewportProfile, number>,
          pageHeights: Object.fromEntries(VIEWPORT_PROFILES.map((viewport) => [viewport, pageHeightOf(viewport)])) as Record<ViewportProfile, KeyActionPageHeightView | null>,
        },
        pages: rows.map(({ evidenceId, ...row }) => {
          const location = locationOf(evidenceId);
          return { ...row, evidence: location === null ? null : { evidenceId, path: location.path, pointer: location.pointer } };
        }),
        scope: { elementSelector: KEY_ACTION_ELEMENT_SELECTOR, hrefSchemeKinds: KEY_ACTION_HREF_SCHEME_KINDS, messageHosts: KEY_ACTION_MESSAGE_HOSTS, words: KEY_ACTION_WORDS },
      };
    },
  };
}

/** 指摘の目印の値。 */
const keyValueOf = (keys: readonly { readonly name: string; readonly value: string }[], name: string): string | undefined =>
  keys.find((key) => key.name === name)?.value;

/**
 * 固定の表示の覆いの指摘（覆いの Rule と大きすぎる固定要素の Rule）に付ける、覆う側・覆われる側の候補の種類と、押せないかを確かめた証拠の有無（2.3）。指摘が参照する
 * layout の主の layout（幅の目印があればその幅の結果）に候補の記録がなければ `null`。覆う側は、覆う固定の要素の中の候補。覆われる側は、指摘の組の覆われる要素の
 * 候補（覆いの Rule だけ）。押せないかは、覆いの Rule と同じ測り直しの判定（`occlusionRevealOf` の「押せません」と言えるか）。
 */
export function fixedOverlapKeyActionsOf(
  finding: { readonly ruleId: string; readonly keys: readonly { readonly name: string; readonly value: string }[] },
  payload: EvidencePayloadByType['layout'],
  revealsAt: (stressWidth: number | null) => readonly RevealedTargetEvidence[],
): FixedOverlapKeyActionView | null {
  const widthText = keyValueOf(finding.keys, 'stressWidth');
  const layout = widthText === undefined
    ? payload.primary.layout
    : payload.stressSweep?.find((result) => String(result.width) === widthText)?.layout ?? null;
  const elements = layout?.keyActionElements;
  if (layout === null || layout === undefined || elements === undefined) {
    return null;
  }
  const overlaySelector = finding.ruleId === FIXED_OCCLUSION_RULE_ID
    ? keyValueOf(finding.keys, 'overlaySelector')
    : finding.ruleId === OVERSIZED_FIXED_ELEMENT_RULE_ID ? keyValueOf(finding.keys, 'selector') : undefined;
  if (overlaySelector === undefined) {
    return null;
  }
  const pairs = finding.ruleId === FIXED_OCCLUSION_RULE_ID
    ? classifiedOcclusionPairsOf(layout).filter((pair) => pair.facts.overlaySelector === overlaySelector && isFindingFixedOverlapClass(pair.overlapClass))
    : [];
  const covered = new Set(pairs.map(({ facts }) => facts.coveredSelector));
  const { pressBlocked } = occlusionRevealOf(pairs, revealsAt(widthText === undefined ? null : Number(widthText)));
  return {
    overlayKinds: kindsOf(elements.filter((element) => element.fixedContainerSelector === overlaySelector || element.selector === overlaySelector)),
    coveredKinds: kindsOf(elements.filter((element) => covered.has(element.selector))),
    pressCheck: pressBlocked ? 'PRESS_BLOCKED_OBSERVED' : 'NOT_CHECKED',
  };
}

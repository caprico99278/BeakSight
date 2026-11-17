/**
 * AUD-3d（設計書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-3d）: 指摘の画像の参照と、対象の領域の矩形の唯一の owner。表示用モデルが
 * 指摘ごとに 1 回だけ作る（`FindingView.imageRegion`）。HTML とバンドルは、これを写すだけで、作り直さない。切り出した画像のファイルは作らない（画像と矩形で示す）。
 * - 参照する画像は、指摘が参照する Evidence と同じ状態 ID（`capture.stateId`）の viewport の画像。幅の走査の指摘（目印 `stressWidth`）は、その幅の画像
 *   （`ScreenshotEvidence.stressWidth`）。確かめ直しの段（`recheck`）の Evidence の指摘は、確かめ直しの段の画像。同じ状態の画像がないときは、参照なしの理由
 *   （`FINDING_IMAGE_UNAVAILABLE_REASONS`）を出す。
 * - 矩形は、layout の Evidence の指摘だけ。指摘の目印（`groupingKeys` の selector の類）で、その layout の事実から要素の矩形を引く。覆いの指摘は、覆う要素と、
 *   覆われる要素の全部（数で切らない）。座標は、layout を読んだ位置と画像を撮った位置の差だけ動かし、画像の座標にそろえる。
 * - EV-2（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.2）: 重なりの指摘は、対象まで動かして測り直して撮った画像（`reveal`）と、その測りの矩形。
 *   重なり・覆い・フォーカスの指摘は、画像の範囲に対象が入ったか（`targetInImage`）と、入らなかったときの保留の理由（`FINDING_HOLD_REASONS`）を持つ。
 * - EV-4（同じ設計書 3.4）: 文字の見切れと横にスクロールする領域の指摘も、重なりと同じく、測り直して撮った画像（なければ状態の画像）と、入ったか・保留の理由を持つ。
 * - EV-5（同じ設計書 3.5。設計者の判断 2026-11-16）: 保留の理由の決め方は、表示用モデル（`src/report/view-model.ts`）と再開の列の決まり
 *   （`src/orchestration/resume-revisit.ts`）の両方が使うので、core に置く（前は `src/report/finding-image-regions.ts`）。
 */
import type { AuditRunResult, EvidenceId, EvidenceRecord, Finding, PageAuditResult } from './contracts.js';
import {
  ACCESSIBILITY_TARGET_REGION_REASONS,
  type LayoutEvidence,
  type RectangleEvidence,
  type RevealedTargetEvidence,
  type ScrollPosition,
  type TargetImageInclusion,
} from './evidence-types.js';
import { PAGE_READINESS_RULE_IDS, stateReadyOf } from './page-readiness.js';
import { combinedInclusion, inclusionInImage } from './target-image-inclusion.js';

/** 矩形の役目（指摘の要素・覆う要素・覆われる要素）。 */
export const FINDING_IMAGE_REGION_ROLES = Object.freeze(['TARGET', 'OVERLAY', 'COVERED'] as const);
export type FindingImageRegionRole = (typeof FINDING_IMAGE_REGION_ROLES)[number];

/**
 * 画像の参照がない理由。
 * - `EVIDENCE_WITHOUT_STATE`: 指摘の Evidence に、集めた状態（`capture`）がない（AUD-2a より前の記録など）。
 * - `NO_SCREENSHOT_OF_STATE`: 同じ状態（幅の走査の指摘は、同じ幅）の viewport の画像がない（画像を撮らない設定・撮れなかった・前の版の記録など）。
 */
export const FINDING_IMAGE_UNAVAILABLE_REASONS = Object.freeze(['EVIDENCE_WITHOUT_STATE', 'NO_SCREENSHOT_OF_STATE'] as const);
export type FindingImageUnavailableReason = (typeof FINDING_IMAGE_UNAVAILABLE_REASONS)[number];

/** 画像の座標の矩形（px。左上が原点）。 */
export interface FindingImageRectView {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 対象の領域の 1 つ。 */
export interface FindingImageRegionEntryView {
  readonly role: FindingImageRegionRole;
  readonly selector: string;
  readonly rect: FindingImageRectView;
}

/** 指摘の画像の参照と、対象の領域。 */
export interface FindingImageRegionView {
  /** 参照する画像の Evidence の ID と、Run のディレクトリからの相対パス（参照がなければ `null`）。 */
  readonly screenshotEvidenceId: EvidenceId | null;
  readonly relativePath: string | null;
  /** 幅の走査の幅の画像なら、その幅（px）。主の画像と参照なしは `null`。 */
  readonly stressWidth: number | null;
  /** 画像を撮ったときの文書のスクロール位置（参照がなければ `null`）。 */
  readonly imageScrollPosition: ScrollPosition | null;
  /** 矩形を読んだときの文書のスクロール位置（layout の Evidence は layout の位置、axe の Evidence は矩形を読んだ位置。どちらでもなければ `null`）。 */
  readonly regionScrollPosition: ScrollPosition | null;
  /** 画像の座標にそろえた矩形（layout・axe の Evidence でない指摘・参照がない指摘・矩形を読めなかった要素は空）。 */
  readonly regions: readonly FindingImageRegionEntryView[];
  readonly reason: FindingImageUnavailableReason | null;
  /** axe の指摘で、要素の矩形がない理由（`FINDING_REGION_UNAVAILABLE_REASONS`）。矩形がある指摘と、axe でない指摘は `null`。 */
  readonly regionUnavailableReason: FindingRegionUnavailableReason | null;
  /**
   * EV-2: 対象まで動かして撮る指摘（`REVEAL_RULE_IDS`）で、参照する画像の範囲に対象が入ったか（機械で決める。重なりは 2 つの要素の交わり、覆いは覆う要素と
   * 覆われる要素の交わり、フォーカスは要素）。ほかの指摘と、画像の参照がない指摘は `null`。
   */
  readonly targetInImage: TargetImageInclusion | null;
  /**
   * EV-2: 対象まで動かして撮る指摘で、対象が写った画像がない理由（`FINDING_HOLD_REASONS`）。対象が全部入った指摘と、ほかの指摘は `null`。フォーカスの指摘は、
   * 画像の外でも保留にせず、撮れなかった・引き直せなかったときだけ。
   */
  readonly holdReason: FindingHoldReason | null;
  /** EV-2: その指摘の対象を測り直して撮った画像の Evidence の ID（撮った順。覆いは、動かした位置と末尾の位置の画像）。なければ空。 */
  readonly revealScreenshotEvidenceIds: readonly EvidenceId[];
}

/**
 * EV-2（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.2）: 指摘の保留の理由の閉じた一覧。
 * - `TARGET_NOT_IN_IMAGE`: 画像はあるが、対象が画像の範囲に全部は入らなかった。
 * - `PAGE_NOT_READY`: 画面の準備が終わらないまま集めた（EV-3。内容の規則の指摘だけ。`src/core/page-readiness.ts`）。
 * - `NOT_OPERATED`: 対象まで動かして撮れなかった（画像を撮らない設定・撮れなかった・前の版の記録など。参照する画像がない）。
 */
export const FINDING_HOLD_REASONS = Object.freeze(['TARGET_NOT_IN_IMAGE', 'PAGE_NOT_READY', 'NOT_OPERATED'] as const);
export type FindingHoldReason = (typeof FINDING_HOLD_REASONS)[number];

/** EV-4: 横にスクロールする領域の指摘（axe の `scrollable-region-focusable`）の Rule の ID。 */
const SCROLLABLE_REGION_RULE_ID = 'A11Y_SCROLLABLE_REGION_FOCUSABLE';

/** EV-2: 対象まで動かして撮る指摘の Rule（重なり・固定の枠の覆い・フォーカス）。EV-4: 文字の見切れと、横にスクロールする領域を足した。 */
const REVEAL_RULE_IDS: ReadonlySet<string> = new Set([
  'ELEMENT_OVERLAP', 'CONTENT_COLLISION', 'FIXED_ELEMENT_OCCLUSION', 'FOCUSED_CONTROL_HIDDEN', 'TEXT_CLIPPING', SCROLLABLE_REGION_RULE_ID,
]);
const OVERLAP_RULE_IDS: ReadonlySet<string> = new Set(['ELEMENT_OVERLAP', 'CONTENT_COLLISION']);
/** EV-2・EV-4: 測り直して撮った画像があれば、その画像と測りの矩形を参照する指摘の Rule（重なり・見切れ・領域）。 */
const REVEAL_VIEW_RULE_IDS: ReadonlySet<string> = new Set([...OVERLAP_RULE_IDS, 'TEXT_CLIPPING', SCROLLABLE_REGION_RULE_ID]);

/** 2 つの矩形の交わり（なければ `null`）。 */
const intersectionOf = (first: FindingImageRectView, second: FindingImageRectView): FindingImageRectView | null => {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  return right >= x && bottom >= y ? { x, y, width: right - x, height: bottom - y } : null;
};

/** 指摘の対象の部分（重なりは 2 つの要素の交わり、覆いは覆う要素と覆われる要素の交わり、ほかは指摘の要素）。 */
const targetPartsOf = (regions: readonly FindingImageRegionEntryView[]): readonly FindingImageRectView[] => {
  const overlays = regions.filter(({ role }) => role === 'OVERLAY').map(({ rect }) => rect);
  if (overlays.length > 0) {
    return regions.filter(({ role }) => role === 'COVERED')
      .flatMap(({ rect }) => overlays.map((overlay) => intersectionOf(overlay, rect)))
      .filter((rect): rect is FindingImageRectView => rect !== null);
  }
  const targets = regions.filter(({ role }) => role === 'TARGET').map(({ rect }) => rect);
  const [first, ...rest] = targets;
  if (first === undefined || rest.length === 0) {
    return targets;
  }
  const overlap = rest.reduce<FindingImageRectView | null>((current, rect) => (current === null ? null : intersectionOf(current, rect)), first);
  return overlap === null ? [] : [overlap];
};

const holdReasonOf = (targetInImage: TargetImageInclusion | null): FindingHoldReason | null =>
  (targetInImage === null || targetInImage === 'INSIDE' ? null : 'TARGET_NOT_IN_IMAGE');

/**
 * AUD-3d の続き: axe の指摘の要素の矩形がない理由。collector の理由（`ACCESSIBILITY_TARGET_REGION_REASONS`）に、次の 2 つを足す。
 * - `NOT_RECORDED`: 矩形を記録する前の版の記録。
 * - `TARGET_NOT_IN_EVIDENCE`: 指摘の目印（`target`）の要素が、Evidence の違反の要素にない（目印を残さない selector など）。
 */
export const FINDING_REGION_UNAVAILABLE_REASONS = Object.freeze([
  ...ACCESSIBILITY_TARGET_REGION_REASONS,
  'NOT_RECORDED',
  'TARGET_NOT_IN_EVIDENCE',
] as const);
export type FindingRegionUnavailableReason = (typeof FINDING_REGION_UNAVAILABLE_REASONS)[number];

const keyValueOf = (finding: Finding, name: string): string | undefined =>
  finding.groupingKeys?.find((key) => key.name === name)?.value;

/** 指摘の layout（幅の目印があれば、その幅の結果）。 */
const layoutOfFinding = (record: EvidenceRecord, stressWidth: number | null): LayoutEvidence | null => {
  if (record.type !== 'layout') {
    return null;
  }
  return stressWidth === null
    ? record.payload.primary.layout
    : record.payload.stressSweep?.find((result) => result.width === stressWidth)?.layout ?? null;
};

/** layout の事実の中の、selector の要素の矩形（最初に見つけたもの）。 */
const rectBySelectorOf = (layout: LayoutEvidence): ReadonlyMap<string, RectangleEvidence> => {
  const rects = new Map<string, RectangleEvidence>();
  const add = (selector: string, rect: RectangleEvidence): void => {
    if (!rects.has(selector)) {
      rects.set(selector, rect);
    }
  };
  for (const item of layout.boxesOutsideViewport) add(item.selector, item.rect);
  for (const item of layout.zeroSizeInteractive) add(item.selector, item.rect);
  for (const item of layout.clippedText) add(item.selector, item.rect);
  for (const item of layout.fixedElements) add(item.selector, item.rect);
  for (const item of layout.fixedHeadingOverlaps) {
    add(item.overlaySelector, item.overlayRect);
    add(item.headingSelector, item.headingRect);
  }
  for (const { first, second } of layout.elementOverlaps) {
    add(first.selector, first.rect);
    add(second.selector, second.rect);
  }
  return rects;
};

/** 覆う要素に覆われる要素の selector（見出しの重なりと、主要要素の重なり。現れた順、重なりなし）。 */
const coveredSelectorsOf = (layout: LayoutEvidence, overlaySelector: string): readonly string[] => {
  const covered = new Set<string>();
  for (const item of layout.fixedHeadingOverlaps) {
    if (item.overlaySelector === overlaySelector) covered.add(item.headingSelector);
  }
  for (const { first, second } of layout.elementOverlaps) {
    if (first.selector === overlaySelector) covered.add(second.selector);
    if (second.selector === overlaySelector) covered.add(first.selector);
  }
  return [...covered];
};

/** 指摘の目印から、layout の上の対象の領域（layout の座標のまま）。 */
const layoutRegionsOf = (finding: Finding, layout: LayoutEvidence): readonly { readonly role: FindingImageRegionRole; readonly selector: string; readonly rect: RectangleEvidence }[] => {
  const rects = rectBySelectorOf(layout);
  const regions: { role: FindingImageRegionRole; selector: string; rect: RectangleEvidence }[] = [];
  const add = (role: FindingImageRegionRole, selector: string | undefined): void => {
    const rect = selector === undefined ? undefined : rects.get(selector);
    if (selector !== undefined && rect !== undefined) {
      regions.push({ role, selector, rect });
    }
  };
  add('TARGET', keyValueOf(finding, 'selector'));
  add('TARGET', keyValueOf(finding, 'firstSelector'));
  add('TARGET', keyValueOf(finding, 'secondSelector'));
  const overlaySelector = keyValueOf(finding, 'overlaySelector');
  if (overlaySelector !== undefined) {
    add('OVERLAY', overlaySelector);
    for (const selector of coveredSelectorsOf(layout, overlaySelector)) {
      add('COVERED', selector);
    }
  }
  return regions;
};

/** viewport の画像の Evidence か（状態と幅で引くため）。 */
const isViewportScreenshot = (record: EvidenceRecord): record is Extract<EvidenceRecord, { type: 'screenshot' }> =>
  record.type === 'screenshot' && record.payload.captureType === 'VIEWPORT';

/**
 * 指摘の画像の参照と対象の領域を引く関数を作る（Run から 1 回だけ）。ページかビューポートによらない指摘と、参照する Evidence がどのページにもない指摘は `null`。
 */
export function findingImageRegionIndexOf(result: Pick<AuditRunResult, 'pages'>): (finding: Finding) => FindingImageRegionView | null {
  const pages = new Map<string, PageAuditResult>(result.pages.map((page) => [page.pageId, page]));
  return (finding) => {
    const page = finding.pageId === null ? undefined : pages.get(finding.pageId);
    return page === undefined ? null : regionOfFindingOnPage(page, finding);
  };
}

/**
 * MEM-4（DEF-266）: 指摘の画像の参照と対象の領域を、ページを 1 つずつ足して引く（ページを持たない。`findingImageRegionIndexOf` と同じ値）。`findings` の指摘の
 * うち、足したページ（同じ ID のページが 2 つある不正な Run では、後のもの）のものだけを、そのページで引いて持つ。`regionOf` は、`findings` の添字で引く。
 */
export function createFindingImageRegionCollector(findings: readonly Finding[]): {
  readonly addPage: (page: PageAuditResult) => void;
  readonly regionOf: (findingIndex: number) => FindingImageRegionView | null;
} {
  const indexesByPage = new Map<string, number[]>();
  findings.forEach((finding, index) => {
    if (finding.pageId !== null) {
      indexesByPage.set(finding.pageId, [...(indexesByPage.get(finding.pageId) ?? []), index]);
    }
  });
  const regions = new Map<number, FindingImageRegionView | null>();
  return {
    addPage: (page) => {
      for (const index of indexesByPage.get(page.pageId) ?? []) {
        regions.set(index, regionOfFindingOnPage(page, findings[index] as Finding));
      }
    },
    regionOf: (findingIndex) => regions.get(findingIndex) ?? null,
  };
}

/**
 * EV-5: そのページの指摘（`page.findings`）の保留の理由（指摘の順。保留のない指摘は `null`）。表示用モデルと同じ決め方（`regionOfFindingOnPage`）。再開の列の先に置く
 * 画面を決めるとき（`src/orchestration/resume-revisit.ts`）に使う。
 */
export function findingHoldReasonsOnPage(page: PageAuditResult): readonly (FindingHoldReason | null)[] {
  return page.findings.map((finding) => regionOfFindingOnPage(page, finding)?.holdReason ?? null);
}

/**
 * そのページ（指摘のページ）の上の、指摘の画像の参照と対象の領域。ビューポートによらない指摘と、参照する Evidence がそのページにない指摘は `null`。
 * EV-3: 内容の規則（`PAGE_READINESS_RULE_IDS`）の指摘は、その状態の準備が終わらないまま集めたなら、保留の理由 `PAGE_NOT_READY`（`pageNotReadyOf`）。
 */
function regionOfFindingOnPage(page: PageAuditResult, finding: Finding): FindingImageRegionView | null {
  if (finding.viewport === null) {
    return null;
  }
  const record = finding.evidenceRefs
    .map((evidenceId) => page.evidence.find((candidate) => candidate.evidenceId === evidenceId))
    .find((candidate): candidate is EvidenceRecord => candidate !== undefined);
  if (record === undefined) {
    return null;
  }
  const view = imageRegionOfRecord(page, finding, record);
  return PAGE_READINESS_RULE_IDS.has(finding.ruleId) && pageNotReadyOf(page, finding, record) ? { ...view, holdReason: 'PAGE_NOT_READY' } : view;
}

/**
 * EV-3: 指摘の Evidence の状態の画面の準備が終わっていなかったか。後から出た指摘（`LATE`）は確かめ直しの値、ずっとある指摘（`PERSISTENT`）は 1 回目と
 * 確かめ直しの両方で終わっていないとき、確かめ直しの表に印のない指摘は 1 回目の状態の値。`INITIAL_ONLY` は保留にしない。記録がなければ、終わったものとする。
 */
function pageNotReadyOf(page: PageAuditResult, finding: Finding, record: EvidenceRecord): boolean {
  if (finding.viewport === null) {
    return false;
  }
  const stateId = record.capture?.stateId;
  const viewport = page.viewports[finding.viewport];
  const recheck = viewport.recheck?.status === 'RECHECKED' && viewport.recheck.stateId === stateId ? viewport.recheck : undefined;
  // REV-EV3 の I-1: 確かめ直しの値は、確かめ直しの印のある指摘だけに使う（確かめ直しで流し直さない規則の指摘は、印がない）。
  const mark = recheck?.findings.find((entry) => entry.fingerprint === finding.fingerprint)?.state;
  const notReadyAtRecheck = recheck?.pageReady === false;
  if (mark === 'LATE') {
    return notReadyAtRecheck;
  }
  // 設計者の判断（2026-11-16）: 確かめ直しで消えた指摘（`INITIAL_ONLY`、「初めだけ」）は、保留にしない。
  if (mark === 'INITIAL_ONLY') {
    return false;
  }
  // REV-EV3 の M-2: 1 回目の状態の準備は、主の状態の落ち着きの待ちの終わり方と、その状態の DOM の表示の数で決める（`stateReadyOf`）。主でない状態は、
  // 表示を待たないので、終わったものとする。
  const dom = page.evidence.find((candidate) => candidate.type === 'dom' && candidate.viewport === finding.viewport && candidate.capture?.stateId === stateId);
  const notReadyAtFirst = stateId !== undefined && viewport.stateId === stateId
    && !stateReadyOf(viewport.settling?.reason, dom?.type === 'dom' ? dom.payload.loadingIndicators : undefined);
  // 1 回目に準備ができていた指摘には、確かめ直しの値で保留を付けない。ずっとある指摘は、確かめ直しでも終わっていないときだけ。
  return mark === 'PERSISTENT' ? notReadyAtFirst && notReadyAtRecheck : notReadyAtFirst;
}

/** 指摘の Evidence（`record`）から、画像の参照と対象の領域を作る。 */
function imageRegionOfRecord(page: PageAuditResult, finding: Finding, record: EvidenceRecord): FindingImageRegionView {
  // EV-1: フォーカスの確かめの指摘の幅は、その Evidence の幅（前は layout だけを読み、フォーカスの指摘の画像の幅が空になっていた）。
  const widthText = record.type === 'layout' ? keyValueOf(finding, 'stressWidth') : undefined;
  const stressWidth = record.type === 'focus' ? record.payload.stressWidth ?? null : widthText === undefined ? null : Number(widthText);
  const found = sourceRegionsOf(finding, record, stressWidth);
  const regionScrollPosition = found.scrollPosition;
  // EV-2: 対象まで動かして撮る指摘か（重なり・覆い・フォーカス）。そうなら、画像の範囲に対象が入ったかと、保留の理由を出す。
  const revealRule = REVEAL_RULE_IDS.has(finding.ruleId);
  const unavailable = (reason: FindingImageUnavailableReason): FindingImageRegionView => ({
    screenshotEvidenceId: null,
    relativePath: null,
    stressWidth: null,
    imageScrollPosition: null,
    regionScrollPosition,
    regions: [],
    reason,
    regionUnavailableReason: found.unavailableReason,
    targetInImage: null,
    holdReason: revealRule ? 'NOT_OPERATED' : null,
    revealScreenshotEvidenceIds: [],
  });
  const stateId = record.capture?.stateId;
  if (stateId === undefined) {
    return unavailable('EVIDENCE_WITHOUT_STATE');
  }
  // 確かめ直しの段（`recheck`）の Evidence は、確かめ直しの段の画像を参照する（後から出た問題が写る）。ほかの段は、確かめ直しの画像を参照しない。
  // AUD-4d: フォーカスの確かめの指摘は、その要素にフォーカスを当てたまま撮った画像を参照する。フォーカスの確かめの画像（段 `focus-check`）は、ほかの指摘は参照しない。
  const recheck = record.capture?.phase === 'recheck';
  const viewportShots = page.evidence.filter(isViewportScreenshot);
  const sameState = (candidate: ViewportScreenshotRecord): boolean =>
    candidate.viewport === finding.viewport
    && candidate.capture?.stateId === stateId
    && (candidate.capture.phase === 'recheck') === recheck
    && (candidate.payload.stressWidth ?? null) === stressWidth;
  // EV-2: 同じ状態・同じ幅で、この指摘の対象を測り直して撮った画像（重なりは、その画像を参照する）。
  const revealed = revealRule ? revealedOfFinding(finding, viewportShots.filter(sameState)) : [];
  if (REVEAL_VIEW_RULE_IDS.has(finding.ruleId) && revealed.length > 0) {
    return revealViewOf(revealed, stressWidth);
  }
  // EV-2: 対象まで動かして撮った画像は、状態の画像として引かない（位置が違う）。
  const screenshot = found.screenshotEvidenceId !== undefined
    ? viewportShots.find((candidate) => candidate.evidenceId === found.screenshotEvidenceId)
    : viewportShots.find((candidate) => sameState(candidate) && candidate.capture?.phase !== 'focus-check' && candidate.payload.reveal === undefined);
  if (screenshot === undefined) {
    return unavailable('NO_SCREENSHOT_OF_STATE');
  }
  const image = screenshot.payload.scrollPosition;
  // 矩形を読んだ位置と画像を撮った位置の差だけ動かす（画像の座標 = 要素の座標 + 矩形を読んだ位置 - 画像の位置）。
  const dx = (regionScrollPosition?.scrollX ?? 0) - image.scrollX;
  const dy = (regionScrollPosition?.scrollY ?? 0) - image.scrollY;
  const regions = found.regions.map(({ role, selector, rect }) => ({
    role,
    selector,
    rect: { x: rect.left + dx, y: rect.top + dy, width: rect.width, height: rect.height },
  }));
  // EV-2: 画像の範囲に対象が入ったか。動かさずに測って撮った画像（フォーカス）は、その測り。ほかは、画像の大きさ（その Evidence の viewport）と矩形から決める。
  const imageSize = imageSizeOf(page, record, stressWidth);
  const asIs = screenshot.payload.reveal?.targets[0];
  const targetInImage = !revealRule
    ? null
    : asIs?.inclusion ?? (imageSize === null ? null : inclusionInImage(targetPartsOf(regions), imageSize.width, imageSize.height));
  // 設計者の判断（2026-11-16）: フォーカスの指摘は、フォーカスしても画面に出ないこと自体が指摘の中身で、フォーカスの後の位置のまま撮った画像と前と後の位置・
  // 矩形が証拠なので、画像の外でも保留にしない（`targetInImage` は記録する）。保留は、引き直せなかったとき（`NOT_OPERATED`）だけ。
  const holdReason = record.type === 'focus'
    ? (asIs?.found === false ? 'NOT_OPERATED' : null)
    : holdReasonOf(targetInImage);
  return {
    screenshotEvidenceId: screenshot.evidenceId,
    relativePath: screenshot.payload.relativePath,
    stressWidth,
    imageScrollPosition: image,
    regionScrollPosition,
    regions,
    reason: null,
    regionUnavailableReason: found.unavailableReason,
    targetInImage,
    holdReason,
    revealScreenshotEvidenceIds: [...new Set([...revealed.map(({ shot }) => shot.evidenceId), ...(screenshot.payload.reveal === undefined ? [] : [screenshot.evidenceId])])],
  };
}

type ViewportScreenshotRecord = Extract<EvidenceRecord, { type: 'screenshot' }>;

/** EV-2: 測り直して撮った画像と、その中の、指摘の対象の記録。 */
interface RevealedOfFinding {
  readonly shot: ViewportScreenshotRecord;
  readonly entry: RevealedTargetEvidence;
}

/**
 * EV-2: 指摘の対象を測り直して撮った画像（重なりは 2 つの要素の selector、覆いは覆う要素の selector で照らす）。撮った順。EV-4: 見切れは要素の selector、
 * 横にスクロールする領域は axe の目印 `target`（文書の selector 1 つ）で照らす。
 */
const revealedOfFinding = (finding: Finding, shots: readonly ViewportScreenshotRecord[]): readonly RevealedOfFinding[] => {
  const pair = [keyValueOf(finding, 'firstSelector'), keyValueOf(finding, 'secondSelector')];
  const overlaySelector = keyValueOf(finding, 'overlaySelector');
  const selector = keyValueOf(finding, 'selector');
  const target = keyValueOf(finding, 'target');
  const matches = (entry: RevealedTargetEvidence): boolean => {
    switch (entry.purpose) {
      case 'ELEMENT_OVERLAP':
        return OVERLAP_RULE_IDS.has(finding.ruleId) && entry.selectors.length === 2 && entry.selectors.every((value, index) => value === pair[index]);
      case 'FIXED_ELEMENT_OCCLUSION':
        return finding.ruleId === 'FIXED_ELEMENT_OCCLUSION' && entry.overlaySelector === overlaySelector;
      case 'TEXT_CLIPPING':
        return finding.ruleId === 'TEXT_CLIPPING' && entry.selectors[0] === selector;
      case 'SCROLLABLE_REGION':
        return finding.ruleId === SCROLLABLE_REGION_RULE_ID && JSON.stringify(entry.selectors) === target;
      default:
        return false;
    }
  };
  return shots.flatMap((shot) => (shot.payload.reveal?.targets ?? []).filter(matches).map((entry) => ({ shot, entry })));
};

/** EV-2: 重なり（EV-4: 見切れ・領域）の指摘の、測り直して撮った画像の参照（分けて撮ったときは最初の部分の画像。入ったかは、全部の部分で決める）。 */
const revealViewOf = (revealed: readonly RevealedOfFinding[], stressWidth: number | null): FindingImageRegionView => {
  const first = revealed.find(({ entry }) => (entry.segment?.index ?? 0) === 0) ?? (revealed[0] as RevealedOfFinding);
  const targetInImage = combinedInclusion(revealed.map(({ entry }) => entry.inclusion));
  const position = first.shot.payload.scrollPosition;
  // REV-EV12 の M-5: 分けて撮った部分の画像では、矩形を、その画像に写った部分に切る（画像の外を指さない）。
  const image = first.shot.payload.reveal;
  const cut = (rect: RectangleEvidence): FindingImageRectView => {
    if (first.entry.segment === undefined || image === undefined) {
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    }
    const x = Math.max(rect.left, 0);
    const y = Math.max(rect.top, 0);
    return { x, y, width: Math.max(0, Math.min(rect.right, image.viewportWidth) - x), height: Math.max(0, Math.min(rect.bottom, image.viewportHeight) - y) };
  };
  return {
    screenshotEvidenceId: first.shot.evidenceId,
    relativePath: first.shot.payload.relativePath,
    stressWidth,
    imageScrollPosition: position,
    regionScrollPosition: position,
    regions: first.entry.selectors.flatMap((selector, index) => {
      const rect = first.entry.elementRects[index] ?? null;
      return rect === null ? [] : [{ role: 'TARGET' as const, selector, rect: cut(rect) }];
    }),
    reason: null,
    regionUnavailableReason: null,
    targetInImage,
    holdReason: holdReasonOf(targetInImage),
    revealScreenshotEvidenceIds: [...new Set(revealed.map(({ shot }) => shot.evidenceId))],
  };
};

/**
 * EV-2: 指摘の Evidence を読んだ viewport の大きさ（画像の大きさ。layout は、その幅の layout。読めなければ `null`）。EV-4: axe の Evidence は、同じ状態・同じ段
 * （確かめ直しかどうか）の layout の大きさ。
 */
const imageSizeOf = (page: PageAuditResult, record: EvidenceRecord, stressWidth: number | null): { readonly width: number; readonly height: number } | null => {
  if (record.type === 'focus') {
    return { width: record.payload.viewportWidth, height: record.payload.viewportHeight };
  }
  const recheck = record.capture?.phase === 'recheck';
  const source = record.type === 'accessibility'
    ? page.evidence.find((candidate) => candidate.type === 'layout' && candidate.viewport === record.viewport
      && candidate.capture?.stateId === record.capture?.stateId && (candidate.capture?.phase === 'recheck') === recheck)
    : record;
  const layout = source === undefined ? null : layoutOfFinding(source, stressWidth);
  return layout === null ? null : { width: layout.document.viewportWidth, height: layout.document.viewportHeight };
};

/** 指摘の Evidence の上の対象の領域（Evidence の座標のまま）と、矩形を読んだ位置と、axe の要素の矩形がない理由。 */
interface SourceRegions {
  readonly regions: readonly { readonly role: FindingImageRegionRole; readonly selector: string; readonly rect: RectangleEvidence }[];
  readonly scrollPosition: ScrollPosition | null;
  readonly unavailableReason: FindingRegionUnavailableReason | null;
  /** AUD-4d: 参照する画像を Evidence が決める指摘（フォーカスの確かめ）は、その画像の ID（撮らなかったら `null`）。ほかの指摘は持たない（状態で引く）。 */
  readonly screenshotEvidenceId?: EvidenceId | null;
}

/**
 * 指摘の Evidence から、対象の領域を引く。layout の Evidence は目印の selector の要素（`layoutRegionsOf`）。AUD-3d の続き: axe の Evidence は、目印 `target` と
 * 同じ selector の並びの違反の要素の矩形（読めなかった要素・見つからない要素は、空と理由）。ほかの Evidence は空。
 */
const sourceRegionsOf = (finding: Finding, record: EvidenceRecord, stressWidth: number | null): SourceRegions => {
  if (record.type === 'layout') {
    const layout = layoutOfFinding(record, stressWidth);
    return { regions: layout === null ? [] : layoutRegionsOf(finding, layout), scrollPosition: layout?.scrollPosition ?? null, unavailableReason: null };
  }
  if (record.type === 'focus') {
    // AUD-4d: フォーカスを当てた後の矩形と、フォーカスを当てたまま撮った画像。EV-1: 矩形を読んだ位置は、フォーカスのスクロールの後の文書の位置（前の版の記録は、
    // 確かめを読んだ位置）。
    const selector = keyValueOf(finding, 'selector');
    const item = record.payload.items.find((candidate) => candidate.selector === selector);
    return {
      regions: item?.afterRect === null || item === undefined ? [] : [{ role: 'TARGET', selector: item.selector, rect: item.afterRect }],
      scrollPosition: item?.scroll?.document.after ?? record.payload.scrollPosition,
      unavailableReason: null,
      screenshotEvidenceId: item?.screenshotEvidenceId ?? null,
    };
  }
  if (record.type !== 'accessibility') {
    return { regions: [], scrollPosition: null, unavailableReason: null };
  }
  const scrollPosition = record.payload.regionScrollPosition ?? null;
  const target = keyValueOf(finding, 'target');
  const node = target === undefined
    ? undefined
    : record.payload.violations.flatMap((rule) => rule.nodes).find((candidate) => JSON.stringify(candidate.targetSelectors) === target);
  if (node === undefined) {
    return { regions: [], scrollPosition, unavailableReason: 'TARGET_NOT_IN_EVIDENCE' };
  }
  if (node.region === undefined) {
    return { regions: [], scrollPosition, unavailableReason: 'NOT_RECORDED' };
  }
  if (node.region.status === 'UNREADABLE') {
    return { regions: [], scrollPosition, unavailableReason: node.region.reason };
  }
  const selector = node.targetSelectors.map((step) => (typeof step === 'string' ? step : step.join(' >> '))).join(' | ');
  return { regions: [{ role: 'TARGET', selector, rect: node.region.rect }], scrollPosition, unavailableReason: null };
};

// 通知の枠の見分け方（設計書 `doc/design/2026-11-06-beaksight-notification-overlay-design.md` 3.1。NO-1）。
// - ページの中では、通知の枠の候補（3.1 の 1）と、その中の押せる要素と、描く面の事実を読むだけにする（`readNotificationFramesInPage`。isolated world で
//   動かす。ページに何も書かない）。見分け（3.1 の 2〜4、入れ子のいちばん内側）は、Node の側の純粋な関数（`classifyNotificationFrames`）が決める。
// - 閉じるボタンの語は、発見の分類の語の閉じた一覧（`src/discovery/classification-words.ts` の `NOTIFICATION_CLOSE_WORDS`・`NOTIFICATION_CLOSE_SYMBOLS`）
//   だけを使う。サイトの文言は持たない。
// - 枠の識別の digest（`notificationFrameDigestOf`）は、枠と祖先の目印の形と、閉じるボタンの名前から作り、画面の path と値は入れない。
// - この段では枠を閉じない（見分けて返すだけ。閉じるのは NO-2）。
// - 置き場所: 見分けた結果は、見るだけの点検と操作さがしの両方で、閉じるボタンを押す前の読み取りに使う（押す部品と同じ層）。ページを読む部品は、
//   操作さがしの押す部品（`src/interaction/submission-probe.ts`）と同じく、isolated world の読み取りの部品（`src/discovery/isolated-read.ts`）だけで読む。
import type { Page } from 'playwright';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';
import { deadlineWithinTimeoutAtMs } from '../core/deadline.js';
import { DISCOVERY_SETTLE_POLICY, waitForDiscoverySettled, type DiscoverySettlePolicy, type QuietSource } from '../discovery/settle.js';
import { SYSTEM_CLOCK, type Clock } from '../core/clock.js';
import { isRecord } from '../core/guards.js';
import { PRODUCTION_OBSERVATION_WINDOWS, observationWindowsOrProduction, type ObservationWindows } from '../core/observation-windows.js';
import type {
  NotificationFrameEvidence,
  NotificationFrameHiddenReason,
  NotificationFrameStatus,
  NotificationOverlayEvidence,
} from '../core/evidence-types.js';
import { elementPathSelectorOf } from '../browser/element-path-engine.js';
import { createSha256Fingerprint } from '../core/ids.js';
import { paintsOwnSurfaceOf, type OwnSurfaceFacts } from '../core/own-surface.js';
import { foldNfkcCase } from '../core/text.js';
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';
import { fieldNameWordsOf, isAsciiWord } from '../discovery/classify.js';
import {
  destructiveActionFactsFrom,
  destructiveActionFactsOfNames,
  isDestructiveAction,
  isFrameClosingCancel,
  type DestructiveActionFacts,
} from '../discovery/destructive-action.js';
import {
  NOTIFICATION_CLOSE_DESTRUCTIVE_OBJECT_WORDS,
  NOTIFICATION_CLOSE_HONORIFIC_PREFIXES,
  NOTIFICATION_CLOSE_OBJECT_PARTICLES,
  NOTIFICATION_CLOSE_OBJECT_WORDS,
  NOTIFICATION_CLOSE_SYMBOLS,
  NOTIFICATION_CLOSE_WORDS,
} from '../discovery/classification-words.js';
import { beginNotificationPress, notificationPressNavigationsOf, pointsToExternalScheme } from '../safety/passive-request-guard.js';
import type { NotificationPressMode } from '../safety/request-policy.js';
import { isPageInAuditScope } from '../orchestration/audit-scope-watch.js';
import {
  readElementInIsolatedWorld,
  readElementsInIsolatedWorld,
  withSignaledElements,
  type InPageElementsResult,
  type IsolatedElementReference,
} from '../discovery/isolated-read.js';

/** 通知の枠の見分けの閾値と、読み取りの上限（設計書 3.1）。 */
export const NOTIFICATION_OVERLAY_LIMITS = Object.freeze({
  /**
   * 3.1 の 4: 描く面がビューポートに占める面積の割合の閾値（この値を含む）。超える枠は全面のモーダル（`TOO_LARGE`）と見分ける。NO-2 fix round 1（設計書 3.1 の 4 の
   * 改訂）: 全面のモーダルも閉じるボタンを押す。閾値は、閉じるボタンのない枠を閉じられない枠に数えるかの判断だけに使う。
   */
  maxViewportAreaRatio: 0.6,
  /** 1 ページで読む枠の候補の最大数（文書の順。超えた分は読まず、その事実を返す）。 */
  maxCandidates: 30,
  /** 枠の候補 1 つあたり、読む押せる要素の最大数（文書の順）。 */
  maxButtonsPerCandidate: 10,
  /** 走査する要素の最大数（超えたら走査を止め、その事実を返す）。 */
  maxScannedElements: 50_000,
  // DEF-260（LZ-3b）: 押せる要素の名前と枠の名前は、ページの中で切らずに全部を読む（前は `maxNameLength` 64 で切り、64 文字目より後ろの削除の語を
  // 見逃しえた）。digest に入れる名前だけを `NOTIFICATION_FRAME_DIGEST_NAME_LENGTH` で切る。
  /** 押せる要素から枠の候補までの、描く面を調べる祖先の最大数（枠の候補を含む）。 */
  maxSurfaceChainDepth: 16,
  /** 自分の文字があるかを調べる、子のノードの最大数（超えたら、文字があるものとして扱う）。 */
  maxOwnTextNodeScan: 256,
});

/** 枠の識別の digest の形の名前。 */
export const NOTIFICATION_FRAME_DIGEST_FORMAT = 'beaksight-notification-frame-identity/1';

/**
 * DEF-260: 枠の識別の digest に入れる、閉じるボタンの名前の長さ（UTF-16 のコード単位）。前にページの中で名前を切っていた長さ（64）と同じにして、
 * digest を変えない。判定（閉じる語・削除の語）には、切らない全部の名前を使う。
 */
export const NOTIFICATION_FRAME_DIGEST_NAME_LENGTH = 64;

/** 3.1 の 1: 固定の位置の値。 */
const FRAME_POSITIONS = Object.freeze(['fixed', 'sticky'] as const);
/** 3.1 の 1: 位置によらず枠の候補にする要素の selector（表示中のダイアログと popover）。 */
const FRAME_DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]';
const FRAME_POPOVER_SELECTOR = ':popover-open';
/**
 * 3.1 の 2: 枠の候補にしない、ヘッダ・ナビ・フッタの landmark（要素の名前と role）。NO-2（ARIA の決まり。HTML-AAM）: 明示の `role` がある要素は、その
 * `role` だけで決める。`header`・`footer` は、区分の要素（`SECTIONING_SCOPE_SELECTOR`）の中にないときだけ landmark（`banner`・`contentinfo`）にする
 * （`section` の中の `header` は、ヘッダの landmark ではない）。`nav` は、いつも landmark。
 */
const EXCLUDED_LANDMARK_NAMES = Object.freeze(['header', 'nav', 'footer'] as const);
const EXCLUDED_LANDMARK_ROLES = Object.freeze(['banner', 'navigation', 'contentinfo'] as const);
/** 区分の中では landmark にならない要素の名前（ARIA の決まり）。 */
export const SCOPED_LANDMARK_NAMES = Object.freeze(['header', 'footer'] as const);
/** `header`・`footer` を landmark にしない、区分の要素と role（ARIA の決まり）。 */
export const SECTIONING_SCOPE_SELECTOR = [
  'article', 'aside', 'main', 'nav', 'section',
  '[role="article"]', '[role="complementary"]', '[role="main"]', '[role="navigation"]', '[role="region"]',
].join(', ');
/** NO-2: 見えていても、利用者から隠された要素（自分か祖先）。枠の候補にしない。 */
const CONCEALED_SELECTOR = '[inert], [aria-hidden="true"]';
/** 識別に使う、祖先の目印（要素の名前と role）。操作さがしの共通の枠の目印（`submission-probe.ts` の `LAYOUT_LANDMARK_INPUT`）と同じ形（`name[role]`）で読む。 */
const IDENTITY_LANDMARK_NAMES = Object.freeze(['nav', 'aside', 'header', 'footer', 'main', 'dialog', 'form'] as const);
const IDENTITY_LANDMARK_ROLES = Object.freeze(['navigation', 'banner', 'complementary', 'contentinfo', 'main', 'dialog', 'alertdialog'] as const);
/** 3.1 の 3: 押せる要素。 */
const PRESSABLE_SELECTOR = 'button, [role="button"], a';
/** NO-2: form の送信ボタン（form の中か `form` の属性を持つ、型のない button・submit・image）。閉じるボタンにしない。 */
const FORM_SUBMITTER_SELECTOR = [
  'form button:not([type])', 'form button[type="submit"]', 'form input[type="submit"]', 'form input[type="image"]',
  'button[form]:not([type])', 'button[form][type="submit"]', 'input[form][type="submit"]', 'input[form][type="image"]',
].join(', ');
/** fix round 3（設計書 3.2.2 の 6）: ネットワークへ送らない form の method（`<form method="dialog">`）。 */
const DIALOG_FORM_METHOD = 'dialog';
/** fix round 2: 枠の中の最初の見出し（枠そのものの名前の 1 つ）。 */
const FRAME_HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
/** DEF-204 と同じ扱い: 要素そのものが中身を描く種類の selector（画像・埋め込み・入力の欄）。 */
const REPLACED_CONTENT_SELECTOR = 'img, svg, [role="img"], iframe, video, embed, object, canvas, input, select, textarea';

// ---------------------------------------------------------------------------------------------------------------
// ページの中の読み取り
// ---------------------------------------------------------------------------------------------------------------

/** ページの中の読み取りの入力（ページの中では import できないので、すべて入力で渡す）。 */
interface NotificationFrameReadInput {
  readonly limits: typeof NOTIFICATION_OVERLAY_LIMITS;
  readonly positions: readonly string[];
  readonly dialogSelector: string;
  readonly popoverSelector: string;
  readonly excludedNames: readonly string[];
  readonly excludedRoles: readonly string[];
  readonly scopedNames: readonly string[];
  readonly sectioningScopeSelector: string;
  readonly concealedSelector: string;
  readonly identityNames: readonly string[];
  readonly identityRoles: readonly string[];
  readonly pressableSelector: string;
  readonly formSubmitterSelector: string;
  readonly replacedContentSelector: string;
  readonly headingSelector: string;
  readonly dialogFormMethod: string;
  readonly visibilityOptions: typeof VISIBILITY_CHECK_OPTIONS;
}

const NOTIFICATION_FRAME_READ_INPUT: NotificationFrameReadInput = Object.freeze({
  limits: NOTIFICATION_OVERLAY_LIMITS,
  positions: FRAME_POSITIONS,
  dialogSelector: FRAME_DIALOG_SELECTOR,
  popoverSelector: FRAME_POPOVER_SELECTOR,
  excludedNames: EXCLUDED_LANDMARK_NAMES,
  excludedRoles: EXCLUDED_LANDMARK_ROLES,
  scopedNames: SCOPED_LANDMARK_NAMES,
  sectioningScopeSelector: SECTIONING_SCOPE_SELECTOR,
  concealedSelector: CONCEALED_SELECTOR,
  identityNames: IDENTITY_LANDMARK_NAMES,
  identityRoles: IDENTITY_LANDMARK_ROLES,
  pressableSelector: PRESSABLE_SELECTOR,
  formSubmitterSelector: FORM_SUBMITTER_SELECTOR,
  headingSelector: FRAME_HEADING_SELECTOR,
  dialogFormMethod: DIALOG_FORM_METHOD,
  replacedContentSelector: REPLACED_CONTENT_SELECTOR,
  visibilityOptions: VISIBILITY_CHECK_OPTIONS,
});

/** ビューポートの座標の矩形（読んだ値）。 */
export interface NotificationRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** 描く面を調べた要素（枠の候補と、その中の押せる要素の祖先）。 */
export interface NotificationSurfaceRead {
  readonly rect: NotificationRect;
  readonly surface: OwnSurfaceFacts;
}

/** 読んだ枠の候補（3.1 の 1 に当たる、見えている要素）。 */
export interface NotificationCandidateRead {
  /** 要素の名前と role の形（`name[role]`）。 */
  readonly shape: string;
  /** `position` の計算値。 */
  readonly position: string;
  /** `role="dialog"`・`role="alertdialog"`・`aria-modal="true"`・`<dialog open>` か。 */
  readonly dialog: boolean;
  /** 表示中の popover か。 */
  readonly popover: boolean;
  /** 自分か祖先が、ヘッダ・ナビ・フッタの landmark か（3.1 の 2）。 */
  readonly inExcludedLandmark: boolean;
  /** 祖先の目印（内から外の順。`name[role]`）。 */
  readonly landmarks: readonly string[];
  /** いちばん近い祖先の枠の候補の番号（ないときは -1）。 */
  readonly parent: number;
  /** 自分の描く面（`surfaces` の番号）。 */
  readonly surface: number;
  /** 参照を返す要素の番号（読み取りの要素の並びの中の位置）。 */
  readonly element: number;
  /**
   * fix round 2（設計書 3.2.1 の 5）: 枠そのものの名前（`aria-label`・`aria-labelledby` の要素の文字・枠の中の最初の見出しの文字。空白をまとめ、長さでは切らない。DEF-260）。
   * この項目より前の読み取りの値にはない（ないときは名前なし）。
   */
  readonly names?: readonly string[];
}

/** 読んだ押せる要素（いちばん近い祖先の枠の候補に属する）。 */
export interface NotificationButtonRead {
  /** 属する枠の候補の番号。 */
  readonly candidate: number;
  /** 見える文字・`aria-label`・`title`（空白をまとめ、長さでは切らない。DEF-260。ないときは空）。 */
  readonly text: string;
  readonly ariaLabel: string;
  readonly title: string;
  /** 押せない（`:disabled` か `aria-disabled="true"`）か。 */
  readonly disabled: boolean;
  /**
   * NO-2: form の送信ボタン（押すと form を送る）か。閉じるボタンにしない（閉じる押下で form を送らない）。この項目より前の読み取りの値にはない（ないときは false）。
   */
  readonly formSubmitter?: boolean;
  /**
   * fix round 2（設計書 3.2.1 の 5）: リンク（`a`）の、移りうる先の事実。`href` は書かれたままの値（ないときは null）。`download` の属性があるか、`target` の値。
   * `formAction` は `formaction` の書かれたままの値（ないときは null）。この項目より前の読み取りの値にはない。
   */
  readonly link?: {
    readonly isAnchor: boolean;
    readonly href: string | null;
    readonly download: boolean;
    readonly target: string;
    readonly formAction: string | null;
  };
  /**
   * SD-1（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.2）: 操作の前の判定の事実（`R.destructiveActionFactsOf`）。この項目より前の読み取りの値には
   * ない（ないときは名前だけで判定する）。
   */
  readonly destructive?: DestructiveActionFacts;
  /** 枠の候補から、この要素の親までの、描く面を調べた要素（`surfaces` の番号。外から内の順。先頭は枠の候補）。 */
  readonly chain: readonly number[];
  /** 自分の矩形。 */
  readonly rect: NotificationRect;
  /** 参照を返す要素の番号。 */
  readonly element: number;
}

/** ページの中の読み取りの結果。 */
export interface NotificationFramesRead {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly candidates: readonly NotificationCandidateRead[];
  readonly buttons: readonly NotificationButtonRead[];
  readonly surfaces: readonly NotificationSurfaceRead[];
  /** 上限で止めたか（走査する要素、枠の候補、押せる要素のどれか）。 */
  readonly truncated: boolean;
  /** fix round 2: 画面の URL（リンクの先を解く基準。外部スキームの判定に使う）。この項目より前の読み取りの値にはない。 */
  readonly baseUrl?: string;
}

/**
 * ページの中で、通知の枠の候補と、その中の押せる要素と、描く面の事実を読む（標準の getter とメソッドで読み、ページに何も書かない）。
 * 要素の並びは、枠の候補（読んだ順）の後に、押せる要素（読んだ順）を置く。
 */
const readNotificationFramesInPage = composeInPage((R: StandardReaders, input: NotificationFrameReadInput): InPageElementsResult => {
  const { standardGetter } = R;
  const { limits } = input;
  const parentOf = standardGetter<Element | null>(Node.prototype, 'parentElement');
  const localNameOf = standardGetter<string>(Element.prototype, 'localName');
  const nodeListLengthOf = standardGetter<number>(NodeList.prototype, 'length');
  const innerTextOf = standardGetter<string>(HTMLElement.prototype, 'innerText');
  const clientWidthOf = standardGetter<number>(Element.prototype, 'clientWidth');
  const clientHeightOf = standardGetter<number>(Element.prototype, 'clientHeight');
  const documentElement = standardGetter<Element>(Document.prototype, 'documentElement')(document);
  // fix round 7（F5-I1）: form の method は、属性の文字ではなく、ブラウザが決めた値（prototype の getter。空白や不正な値は dialog にならない）で比べる。
  const buttonFormMethodOf = standardGetter<string>(HTMLButtonElement.prototype, 'formMethod');
  const formMethodOf = standardGetter<string>(HTMLFormElement.prototype, 'method');
  const attributeOf = (element: Element, name: string): string => {
    const value: unknown = Element.prototype.getAttribute.call(element, name);
    return typeof value === 'string' ? value : '';
  };
  const matchesOf = (element: Element, selector: string): boolean => {
    try {
      return Element.prototype.matches.call(element, selector);
    } catch {
      return false;
    }
  };
  const roleOf = (element: Element): string => attributeOf(element, 'role').trim().toLowerCase();
  const rectOf = (element: Element): { left: number; top: number; width: number; height: number } => {
    const rect = Element.prototype.getBoundingClientRect.call(element);
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };
  const visible = (element: Element): boolean => {
    if (!Element.prototype.checkVisibility.call(element, input.visibilityOptions)) return false;
    const rect = rectOf(element);
    return rect.width > 0 && rect.height > 0;
  };
  // DEF-260: 空白をまとめるだけで、長さでは切らない（digest 用の切り方は Node の側の `notificationFrameDigestOf`）。
  const squeezed = (value: string): string => value.replace(/\s+/gu, ' ').trim();
  const surfaces: { rect: { left: number; top: number; width: number; height: number }; surface: OwnSurfaceFacts }[] = [];
  const surfaceIndexes = new Map<Element, number>();
  const surfaceOf = (element: Element): number => {
    const known = surfaceIndexes.get(element);
    if (known !== undefined) return known;
    const style = window.getComputedStyle(element);
    surfaces.push({
      rect: rectOf(element),
      // CC-129: 描く面の事実は部品（`R.ownSurfaceFactsOf`）で読む。置き換えの要素かは、この読み取りが selector で足す。
      surface: { ...R.ownSurfaceFactsOf(element, style, limits.maxOwnTextNodeScan), replacedContent: matchesOf(element, input.replacedContentSelector) },
    });
    surfaceIndexes.set(element, surfaces.length - 1);
    return surfaces.length - 1;
  };

  let truncated = false;
  const candidateElements: Element[] = [];
  const candidateIndexes = new Map<Element, number>();
  const candidates: {
    shape: string; position: string; dialog: boolean; popover: boolean; inExcludedLandmark: boolean; landmarks: string[];
    parent: number; surface: number; element: number; names: string[];
  }[] = [];
  // fix round 2: 枠そのものの名前（`aria-label`・`aria-labelledby` の要素の文字・枠の中の最初の見出しの文字）。
  const namesOf = (element: Element): string[] => {
    const names: string[] = [];
    const label = squeezed(attributeOf(element, 'aria-label'));
    if (label !== '') names.push(label);
    for (const id of attributeOf(element, 'aria-labelledby').split(/\s+/u).filter((value) => value !== '').slice(0, 4)) {
      const labelled = Document.prototype.getElementById.call(document, id);
      const labelledText = labelled instanceof HTMLElement ? squeezed(innerTextOf(labelled)) : '';
      if (labelledText !== '') names.push(labelledText);
    }
    const heading = Element.prototype.querySelector.call(element, input.headingSelector);
    const headingText = heading instanceof HTMLElement ? squeezed(innerTextOf(heading)) : '';
    if (headingText !== '') names.push(headingText);
    return names;
  };
  const all = Document.prototype.querySelectorAll.call(document, '*');
  const total = nodeListLengthOf(all);
  if (total > limits.maxScannedElements) truncated = true;
  for (let index = 0; index < Math.min(total, limits.maxScannedElements); index += 1) {
    const element = NodeList.prototype.item.call(all, index) as Element | null;
    if (element === null) continue;
    const position = window.getComputedStyle(element).position;
    const dialog = matchesOf(element, input.dialogSelector);
    const popover = matchesOf(element, input.popoverSelector);
    if (!input.positions.includes(position) && !dialog && !popover) continue;
    if (!visible(element)) continue;
    // NO-2: 見えていても、利用者から隠された枠（自分か祖先が `inert`・`aria-hidden="true"`）は、候補にしない。
    if (Element.prototype.closest.call(element, input.concealedSelector) !== null) continue;
    if (candidates.length >= limits.maxCandidates) {
      truncated = true;
      break;
    }
    const name = localNameOf(element);
    const role = roleOf(element);
    // ヘッダ・ナビ・フッタの landmark か（ARIA の決まり。明示の role を先に見て、header・footer は区分の中では landmark にしない）。
    // CC-128: 判定は部品（`R.isLayoutLandmark`）。祖先のたどり方は、この読み取りが持つ。
    const isExcludedLandmark = (node: Element): boolean =>
      R.isLayoutLandmark(node, input.excludedNames, input.excludedRoles, input.scopedNames, input.sectioningScopeSelector);
    let inExcludedLandmark = isExcludedLandmark(element);
    const landmarks: string[] = [];
    let parent = -1;
    for (let node = parentOf(element); node !== null && node !== documentElement; node = parentOf(node)) {
      const nodeName = localNameOf(node);
      const nodeRole = roleOf(node);
      if (isExcludedLandmark(node)) inExcludedLandmark = true;
      if (input.identityNames.includes(nodeName) || input.identityRoles.includes(nodeRole)) landmarks.push(nodeName + '[' + nodeRole + ']');
      if (parent === -1) parent = candidateIndexes.get(node) ?? -1;
    }
    candidateIndexes.set(element, candidates.length);
    candidateElements.push(element);
    candidates.push({
      shape: name + '[' + role + ']', position, dialog, popover, inExcludedLandmark, landmarks, parent,
      surface: surfaceOf(element), element: candidateElements.length - 1, names: namesOf(element),
    });
  }

  const buttonElements: Element[] = [];
  const buttons: {
    candidate: number; text: string; ariaLabel: string; title: string; disabled: boolean; formSubmitter: boolean; chain: number[];
    rect: { left: number; top: number; width: number; height: number }; element: number;
    link: { isAnchor: boolean; href: string | null; download: boolean; target: string; formAction: string | null };
    destructive: DestructiveActionFacts;
  }[] = [];
  const rawAttributeOf = (element: Element, name: string): string | null => {
    const value: unknown = Element.prototype.getAttribute.call(element, name);
    // URL-LEN: リンクの移りうる先は切り詰めない（前は 2,048 まで読んだ）。
    return typeof value === 'string' ? value : null;
  };
  const perCandidate = new Map<number, number>();
  const pressables = Document.prototype.querySelectorAll.call(document, input.pressableSelector);
  const pressableCount = nodeListLengthOf(pressables);
  for (let index = 0; index < pressableCount && candidates.length > 0; index += 1) {
    const element = NodeList.prototype.item.call(pressables, index) as Element | null;
    if (element === null) continue;
    // いちばん近い祖先の枠の候補と、そこまでの祖先（外から内の順にする）。
    const ancestors: Element[] = [];
    let candidate = -1;
    for (let node = parentOf(element); node !== null && node !== documentElement; node = parentOf(node)) {
      const found = candidateIndexes.get(node);
      if (found !== undefined) {
        candidate = found;
        break;
      }
      ancestors.push(node);
    }
    if (candidate === -1 || !visible(element)) continue;
    const used = perCandidate.get(candidate) ?? 0;
    if (used >= limits.maxButtonsPerCandidate) {
      truncated = true;
      continue;
    }
    perCandidate.set(candidate, used + 1);
    const candidateSurface = candidates[candidate]?.surface ?? -1;
    const chain = [candidateSurface];
    const inner = ancestors.reverse().slice(0, Math.max(0, limits.maxSurfaceChainDepth - 1));
    for (const node of inner) chain.push(surfaceOf(node));
    const disabled = matchesOf(element, ':disabled') || attributeOf(element, 'aria-disabled').trim().toLowerCase() === 'true';
    // fix round 3（設計書 3.2.2 の 6）: `<form method="dialog">` の中のボタンは、ネットワークへ送らないので、送信ボタンにしない。
    const ownerForm = Element.prototype.closest.call(element, 'form');
    // fix round 5（設計書 3.2.4 の 1）: `formmethod` が dialog でないボタン、`formaction` のあるボタン、`form` 属性のあるボタンは、dialog の form の中でも送るので、
    // 送信ボタンのまま扱う。
    // fix round 7（F5-I1）: `formmethod` のあるボタンは、ブラウザが決めた `formMethod` が dialog のときだけ、ないボタンは form の `method` だけで決める。
    const buttonMethodIsDialog = !Element.prototype.hasAttribute.call(element, 'formmethod')
      || (element instanceof HTMLButtonElement && buttonFormMethodOf(element) === input.dialogFormMethod);
    const inDialogForm = ownerForm instanceof HTMLFormElement && !Element.prototype.hasAttribute.call(element, 'form')
      && !Element.prototype.hasAttribute.call(element, 'formaction')
      && buttonMethodIsDialog
      && formMethodOf(ownerForm) === input.dialogFormMethod;
    const formSubmitter = matchesOf(element, input.formSubmitterSelector) && !inDialogForm;
    const text = element instanceof HTMLElement ? innerTextOf(element) : '';
    buttonElements.push(element);
    buttons.push({
      candidate, text: squeezed(typeof text === 'string' ? text : ''), ariaLabel: squeezed(attributeOf(element, 'aria-label')),
      title: squeezed(attributeOf(element, 'title')), disabled, formSubmitter, chain, rect: rectOf(element),
      element: candidateElements.length + buttonElements.length - 1,
      link: {
        isAnchor: localNameOf(element) === 'a',
        href: rawAttributeOf(element, 'href'),
        download: Element.prototype.hasAttribute.call(element, 'download'),
        target: (rawAttributeOf(element, 'target') ?? '').trim().toLowerCase(),
        formAction: rawAttributeOf(element, 'formaction'),
      },
      // SD-1: 操作の前の判定の事実（判定は Node の側の `isDestructiveAction`）。
      destructive: R.destructiveActionFactsOf(element),
    });
  }
  return {
    value: {
      viewport: { width: clientWidthOf(documentElement), height: clientHeightOf(documentElement) },
      candidates, buttons, surfaces, truncated, baseUrl: R.documentProperty<string>('URL'),
    },
    elements: [...candidateElements, ...buttonElements],
  };
});

// ---------------------------------------------------------------------------------------------------------------
// Node の側の見分け（純粋）
// ---------------------------------------------------------------------------------------------------------------

/** 名前の終わりの、文字と数字でない部分（句読点・記号・空白）。 */
const TRAILING_NON_WORD = /[^\p{L}\p{N}]+$/u;
/** 英語の語の区切り（文字・数字・ハイフンのほか）。ハイフンでつないだ語（`close-up`）は、1 つの複合の語として扱う。 */
const ASCII_SEGMENT_SEPARATOR = /[^\p{L}\p{N}-]+/u;

/**
 * 押せる要素の名前（1 つ）が、閉じる語か閉じる記号に当たるか（設計書 3.1 の 3）。
 * - 名前が、空白を除いて閉じる記号（`NOTIFICATION_CLOSE_SYMBOLS`）だけからなるとき。
 * - 英語の語は、語の境界で比べる（区切りで分けた語を、欄の名前の語の分け方 `fieldNameWordsOf` でさらに分けた語か、その語に `s` を付けた形と一致する）。
 *   NO-2: ハイフンでつないだ複合の語（`Close-up`・`close-knit`）の中の語は、当てない（閉じるの意味でないことが多い。`close-dialog` のような書き方も
 *   当たらなくなるのは、受け入れる）。
 * - 日本語の語は、名前の終わり（句読点・記号・空白を除いた終わり）にあるときだけ当てる（NO-2。日本語は語の境界がないので、「〈名詞〉を閉じる」に当て、
 *   「閉じる前に保存」「閉じたタブを開く」「〜を最小化」には当てない）。
 * 比べる前に、Unicode の正規化と大文字小文字の畳み込み（`foldNfkcCase`）をかける。
 */
export const isNotificationCloseName = (name: string, frameNames: readonly string[] = []): boolean => {
  const object = closeObjectOf(name);
  return object !== null && (object === '' || isCloseObject(object, frameNames));
};

/**
 * 名前が閉じる語の形（閉じる記号だけ、閉じる語だけ、「〈目的語〉を閉じる」、「Close 〈目的語〉」）なら、その目的語（目的語がなければ空の文字列）。閉じる語の形で
 * なければ null（fix round 3。目的語を見分けて、壊す操作の目的語の名前を閉じるボタンにしないためにも使う）。
 */
const closeObjectOf = (name: string): string | null => {
  const folded = foldNfkcCase(name).trim();
  if (folded.length === 0) return null;
  const compact = [...folded.replace(/\s+/gu, '')];
  if (compact.length > 0 && compact.every((character) => (NOTIFICATION_CLOSE_SYMBOLS as readonly string[]).includes(character))) {
    return '';
  }
  const ending = folded.replace(TRAILING_NON_WORD, '');
  // 日本語の閉じる語: 名前が閉じる語だけか、「〈目的語〉を閉じる」（fix round 2。設計書 3.2.1 の 5）。
  for (const word of NOTIFICATION_CLOSE_WORDS.filter((candidate) => !isAsciiWord(candidate))) {
    if (ending === word) return '';
    if (ending.endsWith(word)) return withoutObjectParticle(ending.slice(0, -word.length));
  }
  // 英語の閉じる語: 名前が閉じる語だけか、「Close 〈目的語〉」。ハイフンでつないだ複合の語は、語として扱わない。
  // camelCase の境を残すため、大文字小文字を畳む前の形で分ける（語は `fieldNameWordsOf` が畳む）。
  const segments = name.trim().replace(TRAILING_NON_WORD, '').split(ASCII_SEGMENT_SEPARATOR).filter((segment) => segment.length > 0);
  const [first, ...restSegments] = segments;
  const rest = restSegments.map(foldNfkcCase);
  if (first === undefined || first.includes('-')) return null;
  const firstWords = fieldNameWordsOf(first);
  const [head, ...camelRest] = firstWords;
  if (head === undefined || !NOTIFICATION_CLOSE_WORDS.filter(isAsciiWord).includes(head as never)) return null;
  const objectWords = [...camelRest, ...rest].filter((word, index) => !(index === 0 && ENGLISH_OBJECT_ARTICLES.has(word)));
  return objectWords.join(' ');
};

/** fix round 3（設計書 3.2.2 の 3）: 名前が「〈壊す操作の目的語〉を閉じる」「Close 〈壊す操作の目的語〉」の形か（閉じる記号の見える文字があっても、押さない）。 */
const closesDestructiveObject = (name: string): boolean => {
  const object = closeObjectOf(name);
  return object !== null && object !== '' && isDestructiveCloseObject(comparableName(object));
};

/** 日本語の「〈目的語〉を閉じる」の、目的語の後の空白と助詞（`NOTIFICATION_CLOSE_OBJECT_PARTICLES`）を除く。 */
const withoutObjectParticle = (value: string): string => {
  let current = value.trimEnd();
  for (const particle of NOTIFICATION_CLOSE_OBJECT_PARTICLES) {
    if (current.endsWith(particle)) current = current.slice(0, -particle.length).trimEnd();
  }
  return current;
};
/** 英語の「Close the 〈目的語〉」の、目的語の前の冠詞（除いて比べる）。 */
const ENGLISH_OBJECT_ARTICLES: ReadonlySet<string> = new Set(['the', 'this']);

/** 名前の比べる形（畳み込み、空白をつめる）。 */
const comparableName = (value: string): string => foldNfkcCase(value).replace(/\s+/gu, ' ').trim();

/**
 * fix round 2（設計書 3.2.1 の 5）: 閉じる語の目的語が、汎用の目的語の閉じた一覧（`NOTIFICATION_CLOSE_OBJECT_WORDS`。日本語は語そのものか、丁寧の接頭語を除いた形。
 * 英語は語か複数形）か、枠そのものの名前と一致するか。
 */
const isCloseObject = (object: string, frameNames: readonly string[]): boolean => {
  const value = comparableName(object);
  if (value === '') return false;
  const plain = NOTIFICATION_CLOSE_HONORIFIC_PREFIXES.reduce((current, prefix) => (current.startsWith(prefix) && current.length > prefix.length
    && (NOTIFICATION_CLOSE_OBJECT_WORDS as readonly string[]).includes(current.slice(prefix.length)) ? current.slice(prefix.length) : current), value);
  const generic = (NOTIFICATION_CLOSE_OBJECT_WORDS as readonly string[]).some((word) => (isAsciiWord(word)
    ? plain === word || plain === `${word}s`
    : plain === word));
  // fix round 3（設計書 3.2.2 の 3）: 枠の名前と一致する目的語は、壊す操作の目的語（`NOTIFICATION_CLOSE_DESTRUCTIVE_OBJECT_WORDS`）に当たらないときだけ当てる。
  return generic || (!isDestructiveCloseObject(value) && frameNames.some((frameName) => comparableName(frameName) === value));
};

/** fix round 3（設計書 3.2.2 の 3）: 目的語が、壊す操作の目的語の閉じた一覧に当たるか（英語は語か複数形、日本語は部分一致）。 */
const isDestructiveCloseObject = (object: string): boolean => {
  const words = new Set(fieldNameWordsOf(object));
  return NOTIFICATION_CLOSE_DESTRUCTIVE_OBJECT_WORDS.some((word) => (isAsciiWord(word)
    ? words.has(word) || words.has(`${word}s`)
    : object.includes(word)));
};

/** fix round 3（設計書 3.2.2 の 3）: 押せる要素の見える文字が、ない（アイコンだけ）か、閉じる記号だけか。 */
const hasNoVisibleWords = (text: string): boolean => {
  const compact = [...foldNfkcCase(text).replace(/\s+/gu, '')];
  return compact.every((character) => (NOTIFICATION_CLOSE_SYMBOLS as readonly string[]).includes(character));
};

/**
 * 押せる要素が閉じるボタンか（見える文字・`aria-label`・`title` のどれかが閉じる語に当たる）。NO-2: form の送信ボタンは、閉じるボタンにしない（閉じる押下で、
 * 送信をしない）。SD-1（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.2・2.3）: 削除に関する操作（操作の前の判定 `isDestructiveAction`。
 * 名前の削除の語・行の ×・削除の確かめの枠の中など）は閉じるボタンにしない。枠を閉じる「キャンセル」（`isFrameClosingCancel`）は閉じるボタンにする。事実のない
 * 前の読み取りは、名前だけで判定する。
 */
const isCloseButton = (
  button: Pick<NotificationButtonRead, 'text' | 'ariaLabel' | 'title' | 'formSubmitter' | 'link' | 'destructive'>,
  frameNames: readonly string[] = [],
  baseUrl = '',
): boolean => {
  const names = [button.text, button.ariaLabel, button.title];
  const facts = button.destructive ?? destructiveActionFactsOfNames(names);
  return button.formSubmitter !== true && !movesWhenPressed(button.link, baseUrl)
    // fix round 3（設計書 3.2.2 の 3）: 枠の名前を目的語として当てるのは、見える文字がない（アイコンか閉じる記号だけの）ボタンだけ。
    && (names.some((name) => isNotificationCloseName(name, hasNoVisibleWords(button.text) ? frameNames : [])) || isFrameClosingCancel(facts))
    && !names.some(closesDestructiveObject)
    && !isDestructiveAction(facts);
};

/**
 * fix round 2（設計書 3.2.1 の 5）: 押すと文書が移りうる要素か（閉じるボタンにしない）。リンク（`a`）は、`href` がない・空・`#` で始まるもののほか（文書の移動、
 * 外部スキーム、資格情報つきの URL）と、`download` の属性があるもの、`target` が `_self` 以外のもの。どの要素も、移りうる先（`href`・`formaction`）が外部
 * スキーム（`pointsToExternalScheme`）を指すもの。事実のない前の読み取りは、移らないものとして扱う。
 */
const movesWhenPressed = (link: NotificationButtonRead['link'], baseUrl: string): boolean => {
  if (link === undefined) return false;
  const targets = [link.href, link.formAction].filter((value): value is string => value !== null);
  if (baseUrl !== '' && pointsToExternalScheme(targets, baseUrl)) return true;
  if (!link.isAnchor) return false;
  const href = (link.href ?? '').trim();
  const stays = href === '' || href.startsWith(HASH_ONLY_PREFIX);
  return !stays || link.download || (link.target !== '' && link.target !== SAME_BROWSING_CONTEXT_TARGET);
};

/** リンクの `href` の、文書を移らない始まり（`#` だけか、`#` で始まる）。 */
const HASH_ONLY_PREFIX = '#';
/** 同じ画面で開く `target` の値。 */
const SAME_BROWSING_CONTEXT_TARGET = '_self';

/** 枠の識別の事実（値と画面の path を持たない）。 */
export interface NotificationFrameIdentityFacts {
  /** 枠の要素の形（`name[role]`）と、位置・ダイアログ・popover の印。 */
  readonly shape: string;
  readonly position: string;
  readonly dialog: boolean;
  readonly popover: boolean;
  /** 祖先の目印（内から外の順。`name[role]`）。 */
  readonly landmarks: readonly string[];
  /** 閉じるボタンの名前（見える文字・`aria-label`・`title`。畳み込んだ形）。閉じるボタンがないときは null。 */
  readonly closeButtonNames: readonly string[] | null;
}

/** 枠の識別の digest（純粋。設計書 3.3）。祖先の目印の形と、閉じるボタンの名前から作り、画面の path と値は入れない。 */
export const notificationFrameDigestOf = (facts: NotificationFrameIdentityFacts): string =>
  createSha256Fingerprint(JSON.stringify([
    NOTIFICATION_FRAME_DIGEST_FORMAT,
    facts.shape,
    facts.position,
    facts.dialog,
    facts.popover,
    facts.landmarks,
    // DEF-260: 前にページの中で切っていた長さで切ってから畳み込む（前の digest と同じ値にする）。
    facts.closeButtonNames === null
      ? null
      : facts.closeButtonNames.map((name) => foldNfkcCase(name.slice(0, NOTIFICATION_FRAME_DIGEST_NAME_LENGTH)).replace(/\s+/gu, ' ').trim()),
  ]));

/** 見分けた枠の状態の閉じた一覧（定義は Evidence の型 `src/core/evidence-types.ts` の `NOTIFICATION_FRAME_STATUSES`）。 */
export { NOTIFICATION_FRAME_STATUSES, type NotificationFrameStatus } from '../core/evidence-types.js';

/** 見分けから外した理由（3.1 の 2 と、入れ子の外側）。 */
export const NOTIFICATION_FRAME_EXCLUSIONS = Object.freeze(['IN_LAYOUT_LANDMARK', 'CONTAINS_FRAME'] as const);
export type NotificationFrameExclusion = (typeof NOTIFICATION_FRAME_EXCLUSIONS)[number];

/** 見分けた枠。 */
export interface NotificationFrame {
  /** 枠の候補の番号（読み取りの `candidates` の位置）。 */
  readonly candidate: number;
  readonly status: NotificationFrameStatus;
  /** 押す閉じるボタンの番号（読み取りの `buttons` の位置。押せる閉じるボタンがないときは null）。 */
  readonly closeButton: number | null;
  /**
   * 描く面がビューポートに占める面積の割合。閉じるボタンがあるときは、枠の候補からボタンまでの祖先のうち、いちばん外の描く面のある要素（ないときは
   * ボタン）の矩形で計る（透明な入れ物の中の小さな枠は、小さな枠の面積になる）。閉じるボタンがないときは、枠の候補が描く面を持てば、その矩形で
   * 計り、持たなければ null。
   */
  readonly surfaceAreaRatio: number | null;
  readonly digest: string;
}

/** 見分けの結果。 */
export interface NotificationFrameClassification {
  readonly frames: readonly NotificationFrame[];
  readonly excluded: readonly { readonly candidate: number; readonly reason: NotificationFrameExclusion }[];
  /** 読み取りを上限で止めたか。 */
  readonly truncated: boolean;
}

/** 矩形が、ビューポートに占める面積の割合。 */
const viewportAreaRatioOf = (rect: NotificationRect, viewport: NotificationFramesRead['viewport']): number => {
  const area = viewport.width * viewport.height;
  if (!(area > 0)) return 0;
  const width = Math.max(0, Math.min(rect.left + rect.width, viewport.width) - Math.max(rect.left, 0));
  const height = Math.max(0, Math.min(rect.top + rect.height, viewport.height) - Math.max(rect.top, 0));
  return (width * height) / area;
};

/** 閉じるボタンの描く面の矩形（枠の候補から外の順に見て、最初の描く面のある要素。ないときはボタン）。 */
const closeSurfaceRectOf = (read: NotificationFramesRead, button: NotificationButtonRead): NotificationRect => {
  for (const index of button.chain) {
    const surface = read.surfaces[index];
    if (surface !== undefined && paintsOwnSurfaceOf(surface.surface)) return surface.rect;
  }
  return button.rect;
};

/**
 * 読んだ候補から、通知の枠を見分ける（純粋。設計書 3.1 の 2〜4）。
 * - 自分か祖先がヘッダ・ナビ・フッタの landmark の候補は外す（`IN_LAYOUT_LANDMARK`）。
 * - 閉じるボタン（`isNotificationCloseName`）を自分の中に持つ（いちばん近い祖先の枠の候補が自分である）候補を、枠とする。入れ子の場合は、閉じるボタンを
 *   持ついちばん内側を枠とし、その祖先の候補は外す（`CONTAINS_FRAME`）。
 * - 押す閉じるボタンは、押せる閉じるボタンのうち文書の順で最初のもの。
 */
export const classifyNotificationFrames = (read: NotificationFramesRead): NotificationFrameClassification => {
  const excluded: { candidate: number; reason: NotificationFrameExclusion }[] = [];
  const closeButtonsOf = new Map<number, number[]>();
  for (const [index, button] of read.buttons.entries()) {
    if (!isCloseButton(button, read.candidates[button.candidate]?.names ?? [], read.baseUrl ?? '')) continue;
    const list = closeButtonsOf.get(button.candidate) ?? [];
    list.push(index);
    closeButtonsOf.set(button.candidate, list);
  }
  // 閉じるボタンを持つ候補の祖先（入れ子の外側）。
  const containers = new Set<number>();
  for (const candidate of closeButtonsOf.keys()) {
    if (read.candidates[candidate]?.inExcludedLandmark === true) continue;
    for (let parent = read.candidates[candidate]?.parent ?? -1; parent >= 0; parent = read.candidates[parent]?.parent ?? -1) {
      containers.add(parent);
    }
  }
  const frames: NotificationFrame[] = [];
  for (const [index, candidate] of read.candidates.entries()) {
    if (candidate.inExcludedLandmark) {
      excluded.push({ candidate: index, reason: 'IN_LAYOUT_LANDMARK' });
      continue;
    }
    if (containers.has(index)) {
      excluded.push({ candidate: index, reason: 'CONTAINS_FRAME' });
      continue;
    }
    const closeButtons = closeButtonsOf.get(index) ?? [];
    const pressable = closeButtons.find((button) => read.buttons[button]?.disabled === false);
    const named = pressable ?? closeButtons[0];
    const namedButton = named === undefined ? undefined : read.buttons[named];
    const ownSurface = read.surfaces[candidate.surface];
    const surfaceAreaRatio = namedButton !== undefined
      ? viewportAreaRatioOf(closeSurfaceRectOf(read, namedButton), read.viewport)
      : (ownSurface !== undefined && paintsOwnSurfaceOf(ownSurface.surface) ? viewportAreaRatioOf(ownSurface.rect, read.viewport) : null);
    let status: NotificationFrameStatus;
    if (namedButton === undefined) {
      status = 'NO_CLOSE_BUTTON';
    } else if (pressable === undefined) {
      status = 'CLOSE_BUTTON_DISABLED';
    } else if (surfaceAreaRatio !== null && surfaceAreaRatio > NOTIFICATION_OVERLAY_LIMITS.maxViewportAreaRatio) {
      status = 'TOO_LARGE';
    } else {
      status = 'DISMISSIBLE';
    }
    frames.push({
      candidate: index,
      status,
      closeButton: status === 'DISMISSIBLE' || status === 'TOO_LARGE' ? (pressable ?? null) : null,
      surfaceAreaRatio,
      digest: notificationFrameDigestOf({
        shape: candidate.shape,
        position: candidate.position,
        dialog: candidate.dialog,
        popover: candidate.popover,
        landmarks: candidate.landmarks,
        closeButtonNames: namedButton === undefined ? null : [namedButton.text, namedButton.ariaLabel, namedButton.title],
      }),
    });
  }
  return { frames, excluded, truncated: read.truncated };
};

// ---------------------------------------------------------------------------------------------------------------
// 読み取りの入口
// ---------------------------------------------------------------------------------------------------------------

/** 読んだ値の形を確かめる（形が違えば null。読めなかったものとして扱う）。 */
const notificationFramesReadOf = (value: unknown): NotificationFramesRead | null => {
  if (!isRecord(value) || !isRecord(value['viewport']) || !Array.isArray(value['candidates']) || !Array.isArray(value['buttons'])
    || !Array.isArray(value['surfaces']) || typeof value['truncated'] !== 'boolean') {
    return null;
  }
  const { width, height } = value['viewport'];
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  const candidates = value['candidates'] as unknown[];
  const buttons = value['buttons'] as unknown[];
  const surfaces = value['surfaces'] as unknown[];
  const validIndex = (index: unknown, length: number): boolean => Number.isSafeInteger(index) && (index as number) >= 0 && (index as number) < length;
  if (!surfaces.every((surface) => isRecord(surface) && isRecord(surface['rect']) && isRecord(surface['surface']))) return null;
  if (!candidates.every((candidate) => isRecord(candidate) && typeof candidate['shape'] === 'string'
    && typeof candidate['position'] === 'string' && typeof candidate['inExcludedLandmark'] === 'boolean'
    && Array.isArray(candidate['landmarks']) && Number.isSafeInteger(candidate['parent'])
    && validIndex(candidate['surface'], surfaces.length))) {
    return null;
  }
  if (!buttons.every((button) => isRecord(button) && validIndex(button['candidate'], candidates.length)
    && typeof button['text'] === 'string' && typeof button['ariaLabel'] === 'string' && typeof button['title'] === 'string'
    && typeof button['disabled'] === 'boolean' && Array.isArray(button['chain'])
    && (button['chain'] as unknown[]).every((index) => validIndex(index, surfaces.length)) && isRecord(button['rect'])
    // SD-1: 操作の前の判定の事実は、あれば形を確かめる（読めない形は読めなかったものとして扱う）。
    && (button['destructive'] === undefined || destructiveActionFactsFrom(button['destructive']) !== null))) {
    return null;
  }
  return value as unknown as NotificationFramesRead;
};

/** 見分けた枠と、その要素の参照（NO-2 で、閉じるボタンを押し、閉じられない枠を隠すために使う）。 */
export interface NotificationFrameWithElements extends NotificationFrame {
  readonly frameElement: IsolatedElementReference;
  readonly closeButtonElement: IsolatedElementReference | null;
}

/** ページの通知の枠の読み取りの結果。 */
export type NotificationFramesOutcome =
  | {
    readonly status: 'READ';
    readonly frames: readonly NotificationFrameWithElements[];
    readonly excluded: NotificationFrameClassification['excluded'];
    readonly truncated: boolean;
  }
  | { readonly status: 'FAILED' };

/**
 * ページの通知の枠を読み、見分ける（isolated world で読む。ページに何も書かず、枠を閉じない）。`deadlineAtMs` までに読めなければ `FAILED`。
 * 参照を返す要素は、見分けた枠の要素と、押す閉じるボタンだけにする。
 */
export async function readNotificationFrames(page: Page, deadlineAtMs: number): Promise<NotificationFramesOutcome> {
  // 読んだ値と見分けた結果（`choose` の中で 1 回だけ作り、参照を返した後に使う）。
  const captured: { read: NotificationFramesRead | null; classification: NotificationFrameClassification | null; chosen: number[] } = {
    read: null, classification: null, chosen: [],
  };
  const outcome = await readElementsInIsolatedWorld(page, readNotificationFramesInPage, NOTIFICATION_FRAME_READ_INPUT, deadlineAtMs, {
    choose: (value) => {
      const current = notificationFramesReadOf(value);
      if (current === null) return null;
      const classification = classifyNotificationFrames(current);
      captured.read = current;
      captured.classification = classification;
      const chosen = classification.frames.flatMap((frame) => {
        const frameElement = current.candidates[frame.candidate]?.element;
        const buttonElement = frame.closeButton === null ? undefined : current.buttons[frame.closeButton]?.element;
        return buttonElement === undefined ? [frameElement ?? -1] : [frameElement ?? -1, buttonElement];
      });
      captured.chosen = chosen;
      return chosen.every((index) => index >= 0) ? chosen : null;
    },
  });
  const { read: finalRead, classification: finalClassification, chosen } = captured;
  if (outcome.status !== 'READ' || finalRead === null || finalClassification === null || outcome.elements.length !== chosen.length) {
    return { status: 'FAILED' };
  }
  const references = new Map<number, IsolatedElementReference>();
  for (const [at, index] of chosen.entries()) {
    const reference = outcome.elements[at];
    if (reference !== undefined) references.set(index, reference);
  }
  const frames: NotificationFrameWithElements[] = [];
  for (const frame of finalClassification.frames) {
    const frameElement = references.get(finalRead.candidates[frame.candidate]?.element ?? -1);
    if (frameElement === undefined) return { status: 'FAILED' };
    const buttonIndex = frame.closeButton === null ? undefined : finalRead.buttons[frame.closeButton]?.element;
    const closeButtonElement = buttonIndex === undefined ? null : (references.get(buttonIndex) ?? null);
    frames.push(Object.freeze({ ...frame, frameElement, closeButtonElement }));
  }
  return Object.freeze({
    status: 'READ',
    frames: Object.freeze(frames),
    excluded: finalClassification.excluded,
    truncated: finalClassification.truncated,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// 閉じる・隠す（NO-2。設計書 3.2・3.4）
// ---------------------------------------------------------------------------------------------------------------

/** 閉じる押下の決まり（設計書 3.2）。 */
export const NOTIFICATION_DISMISSAL_LIMITS = Object.freeze({
  /** 1 回の読み込み（ページ・ビューポート・幅）で押す閉じるボタンの最大数（枠ごとに 1 回）。操作さがしの押す数とは別に数える。 */
  maxPressesPerPage: 3,
  // RB-9: 押した後に枠（閉じるボタン）が消えるのを待つ最大の時間と、消えたかを確かめる間隔は、観察の窓の一式の `notification`（差し込みは `observationWindows`）。
  /** 1 回の押下（click）の期限（ms）。 */
  pressTimeoutMs: 2_000,
  /** 枠の読み取り・隠す処理の期限（ms）。 */
  readTimeoutMs: 5_000,
});

/** 押下の後、要素がまだ見えるか（isolated world で読む。文書から外れたときと、見えないときは false）。 */
const isStillVisibleInPage = (element: Element, options: CheckVisibilityOptions): boolean => {
  if (!Node.prototype.contains.call(document, element)) return false;
  if (!Element.prototype.checkVisibility.call(element, options)) return false;
  const rect = Element.prototype.getBoundingClientRect.call(element);
  return rect.width > 0 && rect.height > 0;
};

/** 閉じられない枠を CSS で隠す（設計書 3.4。`visibility: hidden` と `pointer-events: none` を、その要素の style に付ける）。 */
const hideFrameInPage = composeInPage((R: StandardReaders, element: Element): boolean => {
  if (!(element instanceof HTMLElement)) return false;
  const style: unknown = R.standardGetter<CSSStyleDeclaration>(HTMLElement.prototype, 'style')(element);
  if (!(style instanceof CSSStyleDeclaration)) return false;
  CSSStyleDeclaration.prototype.setProperty.call(style, 'visibility', 'hidden', 'important');
  CSSStyleDeclaration.prototype.setProperty.call(style, 'pointer-events', 'none', 'important');
  return true;
});

/** 閉じる処理の途中の結果を受け取る入れ物（fix round 2。外側の期限で打ち切ったときも、押した数と押した枠を残すため）。 */
export interface NotificationDismissalProgress {
  current: NotificationOverlayEvidence | null;
}

/** 閉じる処理の指定。 */
export interface NotificationDismissalOptions {
  /** 処理の期限（`Date.now()` の絶対時刻）。過ぎたら、残りの枠を押さず、隠さない。 */
  readonly deadlineAtMs: number;
  /**
   * fix round 2（設計書 3.2.1 の 1〜3）・fix round 3（3.2.2 の 1・2）: 押す期間の扱い（Guard に伝える）。どちらも、最初に押すか隠す直前に始める。`AUDIT` は
   * Context を閉じるまで、`DISCOVERY` は凍結（`activateInteractionFreeze`）まで続く。Guard の付いていない page では押さず、隠さない。
   */
  readonly pressMode: NotificationPressMode;
  /**
   * この Run（このビューポートの種類）で、もう見た枠の digest（設計書 3.3。`firstSeen` を決める）。渡すと、見た枠の digest を足す。省略すると、
   * どの枠も初めてとして扱う。
   */
  readonly seenDigests?: Set<string>;
  /** 閉じる（隠す）前に、押すか隠す枠のうち初めての枠があるときだけ呼ぶ（設計書 3.3。閉じる前の layout を測るため）。 */
  readonly beforeFirstDismissal?: () => Promise<void>;
  /** fix round 2（設計書 3.2.1 の 6）: 途中の結果を、押すたびと隠すたびに書く入れ物。 */
  readonly progress?: NotificationDismissalProgress;
  /** RB-9: 観察の窓の一式（テストだけが差し込む。省略は本番の値）。 */
  readonly observationWindows?: ObservationWindows | undefined;
  /**
   * REV-SD の I-1: 押す・隠す直前に、画面がまだ点検の範囲の中かを見る口（偽なら、残りの枠を押さず、隠さない）。省略は見ない。
   */
  readonly inAuditScope?: (() => boolean) | undefined;
}

/** 押す前に決まる、隠す理由（純粋。設計書 3.4）。`CLOSE_BUTTON_DISABLED` と、閉じるボタンがなく描く面が閾値を超える枠。 */
export const hiddenReasonBeforePressOf = (frame: Pick<NotificationFrame, 'status' | 'surfaceAreaRatio'>): NotificationFrameHiddenReason | null => {
  if (frame.status === 'CLOSE_BUTTON_DISABLED') return 'CLOSE_BUTTON_DISABLED';
  if (frame.status === 'NO_CLOSE_BUTTON' && frame.surfaceAreaRatio !== null
    && frame.surfaceAreaRatio > NOTIFICATION_OVERLAY_LIMITS.maxViewportAreaRatio) {
    return 'NO_CLOSE_BUTTON';
  }
  return null;
};

/**
 * 閉じるボタンを押す枠の状態（設計書 3.1 の 4 の改訂。NO-2 fix round 1）: 押せる閉じるボタンのある枠は、全面のモーダル（`TOO_LARGE`）も押す。面積の閾値は、
 * 閉じるボタンのない枠を閉じられない枠に数えるか（`hiddenReasonBeforePressOf`）の判断だけに使う。
 */
const PRESSED_STATUSES: ReadonlySet<NotificationFrameStatus> = new Set<NotificationFrameStatus>(['DISMISSIBLE', 'TOO_LARGE']);
const isPressedStatus = (status: NotificationFrameStatus): boolean => PRESSED_STATUSES.has(status);

/** 読めなかったときの Evidence。 */
const UNREADABLE_OVERLAY: NotificationOverlayEvidence = Object.freeze({
  readStatus: 'FAILED', frames: Object.freeze([]), pressCount: 0, navigated: false, truncated: false,
});

// ---------------------------------------------------------------------------------------------------------------
// RB-9（再構築の設計書 3 章。案 2 章の 7）: 閉じる輪の純粋な手伝い（枠を覚える・押す枠を選ぶ）と、口と時計を差し込める輪（`dismissNotificationFramesWith`）。
// ---------------------------------------------------------------------------------------------------------------

/** 1 つの枠の、閉じる処理の途中の事実（枠の要素の番号 `id` ごと）。 */
interface DismissalFrame {
  readonly id: number;
  readonly digest: string;
  readonly status: NotificationFrameStatus;
  readonly firstSeen: boolean;
  readonly pressed: boolean;
  readonly dismissed: boolean;
  readonly hidden: boolean;
  readonly hiddenReason: NotificationFrameHiddenReason | null;
  readonly frameElement: IsolatedElementReference;
}

type ReadFrames = Extract<NotificationFramesOutcome, { readonly status: 'READ' }>;

/** 押すか隠す枠か（押す前に決まる）。 */
const isActedFrame = (frame: Pick<NotificationFrame, 'status' | 'surfaceAreaRatio'>): boolean =>
  isPressedStatus(frame.status) || hiddenReasonBeforePressOf(frame) !== null;

/** 読んだ枠を覚える（読み直しで初めて見えた枠は、押すか隠す枠だけを足す。閉じた枠の外側に残った、閉じるボタンのない透明な入れ物などは足さない）。 */
const rememberFrames = (
  known: readonly DismissalFrame[],
  outcome: ReadFrames,
  initial: boolean,
  seenBefore: ReadonlySet<string>,
): DismissalFrame[] => {
  const frames = [...known];
  for (const frame of outcome.frames) {
    const id = frame.frameElement.backendNodeId;
    const at = frames.findIndex((known) => known.id === id);
    const known = frames[at];
    if (known !== undefined) {
      frames[at] = Object.freeze({ ...known, frameElement: frame.frameElement });
      continue;
    }
    if (!initial && !isActedFrame(frame)) continue;
    frames.push(Object.freeze({
      id, digest: frame.digest, status: frame.status, firstSeen: !seenBefore.has(frame.digest),
      pressed: false, dismissed: false, hidden: false, hiddenReason: hiddenReasonBeforePressOf(frame), frameElement: frame.frameElement,
    }));
  }
  return frames;
};

/**
 * 次に押す枠（純粋）。押せる状態で閉じるボタンがあり、覚えた枠のうち、まだ押していない枠。fix round 6: 押せなかった（試した）枠は、もう選ばない（期限まで
 * 押し直さない）。
 */
const nextPressTargetOf = (
  known: readonly DismissalFrame[],
  current: ReadFrames,
  attempted: ReadonlySet<number>,
): Readonly<{ frameId: number; closeButton: IsolatedElementReference }> | null => {
  const target = current.frames.find((frame) => isPressedStatus(frame.status) && frame.closeButtonElement !== null
    && known.find((candidate) => candidate.id === frame.frameElement.backendNodeId)?.pressed !== true
    && !attempted.has(frame.frameElement.backendNodeId));
  const closeButton = target?.closeButtonElement ?? null;
  if (target === undefined || closeButton === null || !known.some((candidate) => candidate.id === target.frameElement.backendNodeId)) return null;
  return { frameId: target.frameElement.backendNodeId, closeButton };
};

/**
 * 閉じる輪が頼むページの操作（RB-9。本物は `notificationDismissalPortOf(page)`、テストは偽の口）。どれも例外を投げない。期限は絶対時刻。
 */
export interface NotificationDismissalPort {
  /** 枠を読み、見分ける（読めなければ `FAILED`）。 */
  readFrames(deadlineAtMs: number): Promise<NotificationFramesOutcome>;
  /** 押す期間を始める（Guard の付いていない page では始められない）。 */
  beginPressPeriod(mode: NotificationPressMode): boolean;
  /** 押す期間に Guard が見た main frame の移動とポップアップの数（同じ文書の中の移動は数えない）。 */
  blockedNavigations(): number;
  /** 閉じるボタンを押す。押せたか。 */
  pressCloseButton(closeButton: IsolatedElementReference, deadlineAtMs: number): Promise<boolean>;
  /** 閉じるボタンが見えなくなったか（読めなければ偽）。 */
  isGone(backendNodeId: number, deadlineAtMs: number): Promise<boolean>;
  /** 枠を CSS で隠す。隠せたか。 */
  hideFrame(backendNodeId: number, deadlineAtMs: number): Promise<boolean>;
}

/** 本物の口（Playwright の page。押す期間と移動の数は、その Context の Guard に頼む）。 */
export const notificationDismissalPortOf = (page: Page): NotificationDismissalPort => Object.freeze({
  readFrames: async (deadlineAtMs: number) => {
    try {
      return await readNotificationFrames(page, deadlineAtMs);
    } catch {
      return { status: 'FAILED' } as const;
    }
  },
  beginPressPeriod: (mode: NotificationPressMode) => beginNotificationPress(page, mode),
  blockedNavigations: () => notificationPressNavigationsOf(page),
  pressCloseButton: (closeButton: IsolatedElementReference, deadlineAtMs: number) => pressCloseButton(page, closeButton, deadlineAtMs),
  isGone: async (backendNodeId: number, deadlineAtMs: number) => {
    const visible = await readElementInIsolatedWorld(page, backendNodeId, isStillVisibleInPage, VISIBILITY_CHECK_OPTIONS, deadlineAtMs);
    return visible.status === 'READ' && visible.value === false;
  },
  hideFrame: (backendNodeId: number, deadlineAtMs: number) => hideFrame(page, backendNodeId, deadlineAtMs),
});

/**
 * 通知の枠を見分け、閉じるボタンを押して閉じ、閉じられない枠を CSS で隠す（設計書 3.2・3.2.1・3.4）。例外を投げない。
 * - 押すのは `DISMISSIBLE` と `TOO_LARGE`（閉じるボタンのある全面のモーダル。fix round 1）の枠の閉じるボタンで、枠ごとに 1 回、全部で `maxPressesPerPage` 回まで。
 *   fix round 2（3.2.1 の 6）: 押すたびに枠を読み直し、まだ押していない枠（枠の要素の番号で見分ける）を押す。
 * - 押す期間（押す直前から、消えるのを待つ時間 `dismissWaitMs` の終わりまで）は、Guard に伝える（3.2.1 の 1〜3。`pressMode`）。Guard の付いていない page では押さない。
 *   消えるのを待つ時間の終わりまで、押す期間を続ける（遅れて動く送信と移動も、その間なら押す期間の決まりで扱う。M-2）。
 * - 押した後、待つ時間の後に閉じるボタンが残っていれば `NOT_DISMISSED` として隠す。`CLOSE_BUTTON_DISABLED` の枠と、閉じるボタンがなく描く面がビューポートの閾値を
 *   超える枠は、押さずに隠す。
 * - 押す期間に main frame の移動を試みたら（Guard が数える。見るだけの点検では止めない）、`navigated` を真にし、残りの枠を押さず、隠さない。
 * 値・URL・画面の path は記録しない（枠の識別は digest だけ）。
 */
export function dismissNotificationFrames(page: Page, options: NotificationDismissalOptions): Promise<NotificationOverlayEvidence> {
  // REV-SD の I-1: 口を渡さなければ、その page の範囲の見張り（`watchAuditScope`。操作さがし・READ の確かめの 1 画面）を見る。
  const inAuditScope = options.inAuditScope ?? (() => isPageInAuditScope(page));
  return dismissNotificationFramesWith(notificationDismissalPortOf(page), { ...options, inAuditScope }, SYSTEM_CLOCK);
}

/**
 * 閉じる輪（RB-9。口と時計を差し込める）。途中の結果は `progress` に書き、見た枠の digest を `seenDigests` に足す。例外を投げない（閉じる前の測りの失敗も、
 * 呼ぶ側が記録する）。
 * - fix round 3（設計書 3.2.2 の 1・2）: 押す期間は、最初に押すか隠す直前に始める。見るだけの点検は Context を閉じるまで、操作さがしは凍結まで続ける（終えない）。
 * - fix round 3（3.2.2 の 4・5）: 移動を試みたかは、押す期間に Guard が見た main frame の移動とポップアップの数で見る（同じ文書の中の移動は数えない）。
 */
export async function dismissNotificationFramesWith(
  port: NotificationDismissalPort,
  options: NotificationDismissalOptions,
  clock: Pick<Clock, 'now' | 'sleep'>,
): Promise<NotificationOverlayEvidence> {
  const { deadlineAtMs } = options;
  const limits = NOTIFICATION_DISMISSAL_LIMITS;
  const windows = observationWindowsOrProduction(options.observationWindows).notification;
  const within = (timeoutMs: number): number => Math.min(deadlineAtMs, clock.now() + timeoutMs);
  const first = await port.readFrames(within(limits.readTimeoutMs));
  if (first.status !== 'READ') {
    return UNREADABLE_OVERLAY;
  }
  const seenBefore = new Set(options.seenDigests ?? []);
  // 閉じる（隠す）前に、押すか隠す枠のうち初めての枠があるときだけ測る（設計書 3.3。閉じる前の layout）。
  if (options.beforeFirstDismissal !== undefined && first.frames.some((frame) => isActedFrame(frame) && !seenBefore.has(frame.digest))) {
    try {
      await options.beforeFirstDismissal();
    } catch {
      // 閉じる前の測りに失敗しても、閉じる処理は続ける（測りの失敗は呼ぶ側が記録する）。
    }
  }

  let frames = rememberFrames([], first, true, seenBefore);
  let pressCount = 0;
  let truncated = first.truncated;
  let moved = false;
  let pressPeriodStarted = false;
  const attempted = new Set<number>();
  const update = (id: number, change: Partial<DismissalFrame>): void => {
    frames = frames.map((frame) => (frame.id === id ? Object.freeze({ ...frame, ...change }) : frame));
  };
  const evidence = (): NotificationOverlayEvidence => Object.freeze({
    readStatus: 'READ',
    frames: Object.freeze(frames.map(({ digest, status, pressed, dismissed, hidden, hiddenReason, firstSeen }) =>
      Object.freeze({ digest, status, pressed, dismissed, hidden, hiddenReason, firstSeen }))),
    pressCount,
    navigated: moved,
    truncated,
  });
  const publish = (): NotificationOverlayEvidence => {
    for (const frame of frames) options.seenDigests?.add(frame.digest);
    const current = evidence();
    if (options.progress !== undefined) options.progress.current = current;
    return current;
  };
  publish();
  const navigationsBefore = port.blockedNavigations();
  const refreshMoved = (): boolean => (moved ||= port.blockedNavigations() > navigationsBefore);
  const startPressPeriod = (): boolean => (pressPeriodStarted ||= port.beginPressPeriod(options.pressMode));
  /** 押した後、閉じるボタンが消えるのを待つ時間の終わりまで見る（消えた後も終わりまで待ち、遅れて動く移動を見分ける）。移動を試みたら、消えなかったとする。 */
  const watchPressed = async (buttonId: number, windowEndsAtMs: number): Promise<boolean> => {
    let gone = false;
    while (!refreshMoved()) {
      gone = await port.isGone(buttonId, Math.max(clock.now() + 1, windowEndsAtMs));
      if (gone || refreshMoved() || clock.now() + windows.dismissPollIntervalMs > windowEndsAtMs) break;
      await clock.sleep(windows.dismissPollIntervalMs);
    }
    if (refreshMoved()) return false;
    await clock.sleep(Math.max(0, windowEndsAtMs - clock.now()));
    return gone;
  };

  let current: NotificationFramesOutcome = first;
  while (pressCount < limits.maxPressesPerPage && !moved && clock.now() < deadlineAtMs && current.status === 'READ') {
    const target = nextPressTargetOf(frames, current, attempted);
    // 押す期間を始めてから押す（Guard がなければ押さない）。REV-SD の I-1: 範囲の外へ移った画面では押さない。
    if (target === null || options.inAuditScope?.() === false || !startPressPeriod()) break;
    const windowEndsAtMs = within(windows.dismissWaitMs);
    const pressed = await port.pressCloseButton(target.closeButton, within(limits.pressTimeoutMs));
    attempted.add(target.frameId);
    let dismissed = false;
    if (pressed) {
      pressCount += 1;
      update(target.frameId, { pressed: true });
      publish();
      dismissed = await watchPressed(target.closeButton.backendNodeId, windowEndsAtMs);
      update(target.frameId, { dismissed });
    }
    // fix round 6: 押せなかった枠と、待つ時間の後も残った枠は、閉じられない枠（`NOT_DISMISSED`）として隠す対象にする（押した数には、押せた枠だけを数える）。
    if (!dismissed && !refreshMoved()) update(target.frameId, { hiddenReason: 'NOT_DISMISSED' });
    publish();
    // 移動を試みたら、残りの枠を押さず、隠さない。
    if (refreshMoved()) break;
    current = await port.readFrames(within(limits.readTimeoutMs));
    if (current.status === 'READ') {
      frames = rememberFrames(frames, current, false, seenBefore);
      truncated ||= current.truncated;
    }
    publish();
  }
  // 閉じられない枠を隠す（移動を試みた後は、隠さない）。読み直した後の、同じ要素の参照を使う。隠す処理も、押す期間の中で行う（3.2.2 の 2。始められなければ隠さない）。
  if (!refreshMoved()) {
    for (const frame of frames) {
      if (frame.hiddenReason === null || clock.now() >= deadlineAtMs || options.inAuditScope?.() === false || !startPressPeriod()) continue;
      update(frame.id, { hidden: await port.hideFrame(frame.frameElement.backendNodeId, within(limits.readTimeoutMs)) });
      publish();
    }
  }
  refreshMoved();
  return publish();
}

/** 閉じるボタンを押す（合図つきの位置の Locator で、確かめた要素だけを押す。押した後の読み込みを待たない）。押せたか。例外を投げない。 */
async function pressCloseButton(page: Page, reference: IsolatedElementReference, deadlineAtMs: number): Promise<boolean> {
  const path = reference.path;
  if (path === null) return false;
  try {
    const outcome = await withSignaledElements(page, [reference.backendNodeId], deadlineAtMs, async ([signal]) => {
      if (signal === undefined) return false;
      await page.locator(elementPathSelectorOf(path, signal)).click({
        timeout: Math.max(1, deadlineAtMs - Date.now()),
        noWaitAfter: true,
      });
      return true;
    });
    return outcome.status === 'DONE' && outcome.value;
  } catch {
    return false;
  }
}

/** 枠を CSS で隠す。隠せたか。 */
async function hideFrame(page: Page, backendNodeId: number, deadlineAtMs: number): Promise<boolean> {
  const outcome = await readElementInIsolatedWorld(page, backendNodeId, hideFrameInPage, null, deadlineAtMs);
  return outcome.status === 'READ' && outcome.value === true;
}

/** 操作さがしの、通知の枠の処理（落ち着きの待ちと、閉じる・隠す）に使う時間の上限（ms。RB-2: 観察の窓の一式の `notification`）。 */
export const DISCOVERY_NOTIFICATION_BUDGET_MS = PRODUCTION_OBSERVATION_WINDOWS.notification.discoveryBudgetMs;

/**
 * DEF-210（設計書 3.2）: 操作さがしの画面で、発見の読み取り（凍結）の前に、落ち着くのを待ってから（通知の枠の集合が 2 回続けて同じになるまで。発見の落ち着きの
 * 待ちと同じ部品 `waitForDiscoverySettled`）、通知の枠を閉じる（閉じられない枠は隠す）。閉じる押下は、操作さがしの押す数とは別に数える（ここでは数えない）。
 * 押した後のサイトの送信は、その Context の Guard が、今の段の判定で扱う。例外を投げない。
 */
export async function settleAndDismissNotificationFrames(
  page: Page,
  options: { readonly requestCounter: QuietSource; readonly settlePolicy?: DiscoverySettlePolicy | undefined },
): Promise<NotificationOverlayEvidence> {
  const deadlineAtMs = deadlineWithinTimeoutAtMs(undefined, DISCOVERY_NOTIFICATION_BUDGET_MS);
  try {
    await waitForDiscoverySettled(options.requestCounter, async (readDeadlineAtMs) => {
      const outcome = await readNotificationFrames(page, readDeadlineAtMs);
      return outcome.status === 'READ' ? outcome.frames.map((frame) => `${frame.digest}:${frame.status}`) : null;
    }, options.settlePolicy ?? DISCOVERY_SETTLE_POLICY);
  } catch {
    // 落ち着きを待てなくても、閉じる処理は試す（読めなければ何もしない）。
  }
  return dismissNotificationFrames(page, { deadlineAtMs, pressMode: 'DISCOVERY' });
}

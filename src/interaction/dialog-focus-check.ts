// FRET（設計書 `doc/design/2026-11-24-beaksight-dialog-focus-return-design.md` 1 章）: 点検の段で、窓を開くボタンを押して窓を閉じた後のフォーカスの戻り先を
// 確かめる部品。Page Auditor が、主の読み込みの各ビューポートの点検の最後に呼ぶ（画像・axe・フォーカスの確かめなどの後）。
// - 押す物（1.1）: 見えていてフォーカスできる要素のうち、`aria-haspopup="dialog"` のもの、または `aria-controls` の参照先が前面の窓（判定の 1 か所
//   `R.frontWindows`）か `role="dialog"`・`role="alertdialog"`・`dialog` のもの。押さない物: 送信の要素（`type="submit"` と、form の送信ボタン。判定は
//   `R.discoveryCandidateElementOf`）、別の場所へ移るリンク、無効の物、値を入れる要素。2026-11-25: 削除に関する操作（SD-1 の操作の前の判定 `isDestructiveAction`。
//   `R.destructiveActionFactsOf` の事実を全部渡す）と AI の操作（`isAiAction`）も押さない（事実を読めない物も押さない）。数で打ち切らない。
// - 同じ物は Run で 1 回（呼ぶ側の口 `accept`。フォーカスが当たったのを確かめた後に受け付ける）: 共通の枠の中の物は枠の鍵（`layoutFrameStructureKeyOf`。読み取りは
//   `readLayoutFramesInPage`）、ほかは data を除いた path の鍵（`dataFreePathKeyOf`）と識別の鍵。ISKIP・PSKIP と同じ部品を使う（写しを作らない）。
// - 確かめ（1.2）: 押す物にフォーカスを当て、Enter で押し、落ち着きを待つ（今の落ち着きの待ち `settledReading`。新しい秒の値は足さない）。窓が出たら、フォーカスが
//   窓の中へ移ったかを読み、Esc で閉じる。閉じなければ窓の中の閉じるボタン（通知の枠の閉じるボタンの判定 `isCloseButton` の 1 か所。送信ボタン・押すと移る物・
//   削除の物を閉じる物・削除の確かめの窓の中のボタンは選ばない）を Enter で押す。それでも閉じなければ記録し、その画面の残りは確かめない。閉じたら、フォーカスの先を
//   読む。画面が移った（path か文書が変わった）ら、記録して、その画面の確かめを終える。
// - 守り（1.3。2026-11-25）: サイトへの読み込みを足さない。キーを押す期間は Guard の口（`scrollKeyPressGuardOf`）で、ページが始めた画面の移動とポップアップを
//   止める。押す期間（Enter を押してから、窓を閉じて落ち着くまで）は、Guard の口の `pressPeriod` で、読み取りでない要求も main frame と子の frame の両方で止めて
//   記録する。1 つでも押したら、その止めを page を閉じるまで（BeakSight 自身の次の読み込みの前まで）続ける（`holdPressStop`。FRET はビューポートの点検の最後の
//   段）。押す期間の後に遅れて出て止めた読み取りでない要求は、確かめの終わりまでの数を記録に残す（その後の分は Ledger）。例外は投げない（読めなくなったら、
//   それまでの記録で `PARTIAL`）。
import {
  composeInPage, DISCOVERY_CANDIDATE_ELEMENT_CRITERIA, FRONT_WINDOW_MIN_VIEWPORT_RATIO, type PressableButtonFacts, type PressableButtonFactsCriteria,
  type StandardReaders,
} from '../browser/in-page-readers.js';
import type { EvidenceId } from '../core/contracts.js';
import type { DialogFocusEvidence, DialogFocusItemEvidence, DialogFocusReturn, DialogFocusStatus } from '../core/evidence-types.js';
import { createSha256Fingerprint } from '../core/ids.js';
import { MAX_SELECTOR_DEPTH } from '../core/limits.js';
import { observationWindowsOrProduction } from '../core/observation-windows.js';
import { foldNfkcCase } from '../core/text.js';
import { destructiveActionFactsFrom, isAiAction, isDestructiveAction } from '../discovery/destructive-action.js';
import { readElementsInIsolatedWorld, type InPageElementsResult } from '../discovery/isolated-read.js';
import { dataFreePathKeyOf, layoutFrameStructureKeyOf } from '../discovery/submission-probe-contracts.js';
import { settledReading } from '../evidence/focus-check-collector.js';
import { EDITABLE_SELECTOR, pressDialogCheckKey, type ScrollKeyPressGuard } from '../evidence/reveal-and-capture.js';
import { openReadDeadline } from '../orchestration/stage-deadline.js';
import { LAYOUT_FRAME_INPUT, readLayoutFramesInPage } from './layout-frame-read.js';
import { CLOSE_BUTTON_FACTS_CRITERIA, CLOSE_BUTTON_PRESSABLE_SELECTOR, isCloseButton } from './notification-overlay.js';

/**
 * FRET（2026-11-25）: キーの押下の期間の Guard の口に、窓を開くボタンの押す期間を入れ外しする口を足したもの（`scrollKeyPressGuardOf` が返す形。押す期間は、
 * 読み取りでない要求も止める）。
 */
export interface DialogPressGuard extends ScrollKeyPressGuard {
  readonly pressPeriod: (on: boolean) => void;
  /**
   * 2026-11-25 fix round 1 の判断: 押す期間の止めを、BeakSight 自身の次の読み込み（か凍結・Context を閉じる）まで続ける（1 つでも押したら呼ぶ。FRET はビューポートの
   * 点検の最後の段なので、その後の点検の証拠には混ざらない）。
   */
  readonly holdPressStop: () => void;
  /** fix round 4: 押す期間に、押す前から開いていた WebSocket の接続が送った frame の数（止めない）。 */
  readonly webSocketFramesSent: () => number;
  /** fix round 5: 押した後の止めの続き（hold）の間に、前から開いていた接続が送った frame の数（止めない）。 */
  readonly webSocketFramesSentAfterPress: () => number;
}

/** 確かめる page（isolated world の読み取りの部品が受ける page。Playwright の page がそのまま当てはまる）。 */
type DialogCheckPage = Parameters<typeof readElementsInIsolatedWorld>[0];

/** フォーカスできる要素の selector（リンクは `:any-link`。行き先は読み取りの中で同じ文書かだけを見る）。 */
const FOCUSABLE_SELECTOR = ':any-link, button, input:not([type="hidden" i]), select, textarea, summary, [tabindex]';
/** `aria-controls` の参照先が窓かを見る selector（前面の窓の判定に当たらない、閉じた窓）。 */
const DIALOG_SELECTOR = '[role="dialog" i], [role="alertdialog" i], dialog';
/** 確かめの間だけページに置く物の名前（window の、列挙されないプロパティ。確かめた後に消す）。 */
const STATE_KEY = '__beaksightDialogFocus';
/** 同じ物の鍵の形の印（版つき）。 */
const DIALOG_FOCUS_KEY_FORMAT = 'beaksight-audit-dialog-focus/1';
const DIALOG_FOCUS_LAYOUT_FORMAT = 'beaksight-audit-dialog-focus-layout/1';
const DIALOG_FOCUS_PATH_FORMAT = 'beaksight-audit-dialog-focus-data-free-path/1';
/** 読み取りでない送信の method（これのほか）。 */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

interface ListInput {
  readonly focusableSelector: string;
  readonly dialogSelector: string;
  readonly editableSelector: string;
  readonly frontWindowRatio: number;
  readonly maxSelectorDepth: number;
  readonly candidateCriteria: typeof DISCOVERY_CANDIDATE_ELEMENT_CRITERIA;
}

interface RawPressable {
  readonly selector: string;
  /** SD-1 の操作の前の判定の事実（`R.destructiveActionFactsOf`）。 */
  readonly facts: unknown;
  readonly tag: string;
  readonly role: string;
  readonly popup: string;
}

/** 押す物を読む（isolated world。読むだけ）。値は押す物の事実、要素は押す物（同じ順）。 */
const listPressablesInPage = composeInPage((R: StandardReaders, input: ListInput): InPageElementsResult => {
  const attributeOf = (element: Element, name: string): string => {
    const value: unknown = Element.prototype.getAttribute.call(element, name);
    return typeof value === 'string' ? value.trim() : '';
  };
  const windows = R.frontWindows(input.frontWindowRatio);
  const isDialog = (id: string): boolean => {
    const target = Document.prototype.getElementById.call(document, id);
    return target !== null && (windows.indexOf(target) >= 0 || Element.prototype.matches.call(target, input.dialogSelector));
  };
  // 同じ文書の中の印（`#` で始まる値）へのリンクだけは、別の場所へ移らない（URL は組み立てない。比べ方の owner は Link の部品）。
  const sameDocument = (href: string): boolean => href.startsWith('#');
  const values: RawPressable[] = [];
  const elements: Element[] = [];
  for (const node of R.queryAllInRoots([document], '[aria-haspopup], [aria-controls]')) {
    if (!(node instanceof HTMLElement)) continue;
    const popup = attributeOf(node, 'aria-haspopup').toLowerCase();
    const controls = attributeOf(node, 'aria-controls').split(/\s+/u).filter((id) => id !== '');
    // `aria-haspopup` が dialog のほか（menu・listbox など）は押さない。印のないものは、参照先が窓のときだけ押す。
    const opensWindow = popup === 'dialog' || ((popup === '' || popup === 'false') && controls.some(isDialog));
    const tabIndex = attributeOf(node, 'tabindex');
    if (!opensWindow || !R.isVisible(node) || !Element.prototype.matches.call(node, input.focusableSelector)
      || (tabIndex !== '' && Number.parseInt(tabIndex, 10) < 0)
      || Element.prototype.matches.call(node, ':disabled') || attributeOf(node, 'aria-disabled').toLowerCase() === 'true'
      || attributeOf(node, 'type').toLowerCase() === 'submit' || R.discoveryCandidateElementOf(node, input.candidateCriteria)?.kind === 'SUBMITTER'
      || (Element.prototype.matches.call(node, ':any-link') && !sameDocument(attributeOf(node, 'href'))) || R.hasLinkAncestor(node)
      || R.isValueEntryFocus(node, input.editableSelector)) {
      continue;
    }
    values.push({
      selector: R.selectorOf(node, input.maxSelectorDepth),
      facts: R.destructiveActionFactsOf(node),
      tag: R.standardGetter<string>(Element.prototype, 'localName')(node),
      role: attributeOf(node, 'role').toLowerCase(),
      popup,
    });
    elements.push(node);
  }
  return { value: values, elements };
});

/** 渡した要素の、今の位置を返す（isolated world。文書から外れていれば要素を返さない）。 */
const currentPathInPage = composeInPage((R: StandardReaders, _input: null, given?: readonly Element[]): InPageElementsResult => {
  const element = given?.[0];
  return { value: null, elements: element !== undefined && R.standardGetter<boolean>(Node.prototype, 'isConnected')(element) ? [element] : [] };
});

/** 押す物にフォーカスを当て、確かめの間の状態（押す物と、今の前面の窓）をページに置く。フォーカスが当たったかを返す。 */
const armInPage = composeInPage((R: StandardReaders, { path, stateKey, frontWindowRatio }: {
  readonly path: readonly number[];
  readonly stateKey: string;
  readonly frontWindowRatio: number;
}): boolean => {
  const element = R.elementAtPath(path);
  if (!(element instanceof HTMLElement)) return false;
  Object.defineProperty(window, stateKey, { value: { trigger: element, before: R.frontWindows(frontWindowRatio) }, configurable: true, enumerable: false });
  HTMLElement.prototype.focus.call(element);
  return R.documentProperty<Element | null>('activeElement') === element;
});

/** 確かめの間の状態の読み（`present` が偽なら、置いた状態がない＝文書が変わった）。 */
interface RawDialogState {
  readonly present: boolean;
  readonly opened: boolean;
  readonly activeInWindow: boolean;
  readonly active: 'TRIGGER' | 'BODY' | 'OTHER';
  readonly activeSelector: string | null;
  readonly triggerConnected: boolean;
  /** 最後に出た新しい前面の窓の位置（閉じるボタンを読むため。なければ `null`）。 */
  readonly windowPath: readonly number[] | null;
}

interface StateInput {
  readonly stateKey: string;
  readonly frontWindowRatio: number;
  readonly maxSelectorDepth: number;
}

/** 新しく出た前面の窓（押す前になかったもの）と、フォーカスの先を読む（読むだけ）。 */
const readStateInPage = composeInPage((R: StandardReaders, { stateKey, frontWindowRatio, maxSelectorDepth }: StateInput): RawDialogState => {
  const state = (window as unknown as Record<string, { readonly trigger: Element; readonly before: readonly Element[] } | undefined>)[stateKey];
  if (state === undefined) {
    return { present: false, opened: false, activeInWindow: false, active: 'BODY', activeSelector: null, triggerConnected: false, windowPath: null };
  }
  const windows = R.frontWindows(frontWindowRatio).filter((front) => state.before.indexOf(front) < 0);
  const active = R.documentProperty<Element | null>('activeElement');
  const onBody = active === null || active === R.documentProperty<Element | null>('body') || active === R.documentProperty<Element | null>('documentElement');
  const kind = active === state.trigger ? 'TRIGGER' : onBody ? 'BODY' : 'OTHER';
  return {
    present: true,
    opened: windows.length > 0,
    activeInWindow: active !== null && !onBody && windows.some((front) => front === active || Node.prototype.contains.call(front, active)),
    active: kind,
    activeSelector: kind === 'OTHER' && active !== null ? R.selectorOf(active, maxSelectorDepth) : null,
    triggerConnected: R.standardGetter<boolean>(Node.prototype, 'isConnected')(state.trigger),
    windowPath: windows.length === 0 ? null : R.elementPathOf(windows[windows.length - 1] as Element),
  };
});

/**
 * 窓（位置の要素）の中の、見える押せる要素の、閉じるボタンの判定の事実（部品 `R.pressableButtonFactsOf`。通知の枠の見分けと同じ読み方）を読む（isolated world。
 * 読むだけ）。値は事実、要素は押せる要素（同じ順）。
 */
const closeButtonsInPage = composeInPage((R: StandardReaders, { path, selector, criteria }: {
  readonly path: readonly number[];
  readonly selector: string;
  readonly criteria: PressableButtonFactsCriteria;
}): InPageElementsResult => {
  const frame = R.elementAtPath(path);
  const facts: unknown[] = [];
  const elements: Element[] = [];
  if (frame !== null) {
    const list = Element.prototype.querySelectorAll.call(frame, selector);
    for (let index = 0; index < R.standardGetter<number>(NodeList.prototype, 'length')(list); index += 1) {
      const item = NodeList.prototype.item.call(list, index);
      if (item instanceof Element && R.isVisible(item)) {
        facts.push(R.pressableButtonFactsOf(item, criteria));
        elements.push(item);
      }
    }
  }
  return { value: { facts, baseUrl: R.documentProperty<string>('URL') }, elements };
});

/** 渡した要素にフォーカスを当て、当たったかを返す（isolated world）。 */
const focusGivenInPage = composeInPage((R: StandardReaders, _input: null, given?: readonly Element[]): InPageElementsResult => {
  const element = given?.[0];
  if (element instanceof HTMLElement) HTMLElement.prototype.focus.call(element);
  return { value: element !== undefined && R.documentProperty<Element | null>('activeElement') === element, elements: [] };
});

/** 置いた状態を消す。 */
const releaseInPage = composeInPage((_R: StandardReaders, { stateKey }: { readonly stateKey: string }): void => {
  Reflect.deleteProperty(window, stateKey);
});

/** `checkDialogFocus` の指定。 */
export interface DialogFocusCheckOptions {
  /** 同じ物の鍵に入れる範囲（ビューポートの名前。ビューポートごとに 1 回）。 */
  readonly keyScope: string;
  /** 同じ物を Run で 1 回にする口（鍵の digest を初めて受けたら真）。フォーカスが当たったのを確かめた後に呼ぶ。 */
  readonly accept: (keyDigest: string) => boolean;
  /** キーの押下の期間と押す期間の Guard の口（なければ、始められなければ押さない）。 */
  readonly keyPressGuard?: DialogPressGuard | undefined;
  /** 落ち着きを読む間隔（ms。フォーカスの確かめと同じ値。省略すると本番の値）。 */
  readonly settleIntervalMs?: number | undefined;
  /** 押す前と閉じた後の viewport の画像を撮る口（撮らない設定は省く）。 */
  readonly capture?: (() => Promise<EvidenceId | null>) | undefined;
  readonly track?: (<T>(work: Promise<T>) => Promise<T>) | undefined;
  /** 段の期限（見張りが段を終えたら abort）。 */
  readonly signal?: AbortSignal | undefined;
}

/** 読んだ押す物（鍵と、要素の番号つき）。 */
interface Pressable {
  readonly selector: string;
  readonly name: string;
  readonly keyDigest: string;
  readonly backendNodeId: number;
}

const pathOf = (url: string): string | null => {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
};

/**
 * 押す物を読み、削除に関する操作と AI の操作（SD-1 の `isDestructiveAction`・AIW の `isAiAction` の 1 か所。事実を読めない物も）を除き、同じ物の鍵を付ける
 * （読めなければ `null`）。
 */
async function pressablesOf(page: DialogCheckPage, options: DialogFocusCheckOptions): Promise<readonly Pressable[] | null> {
  const listed = await readElementsInIsolatedWorld(page, listPressablesInPage, {
    focusableSelector: FOCUSABLE_SELECTOR, dialogSelector: DIALOG_SELECTOR, editableSelector: EDITABLE_SELECTOR, frontWindowRatio: FRONT_WINDOW_MIN_VIEWPORT_RATIO,
    maxSelectorDepth: MAX_SELECTOR_DEPTH, candidateCriteria: DISCOVERY_CANDIDATE_ELEMENT_CRITERIA,
  } satisfies ListInput, openReadDeadline());
  if (listed.status !== 'READ' || !Array.isArray(listed.value) || listed.value.length !== listed.elements.length) return null;
  const raws = listed.value as readonly RawPressable[];
  const kept = raws.flatMap((raw, index) => {
    const element = listed.elements[index];
    const facts = destructiveActionFactsFrom(raw.facts);
    return element === undefined || facts === null || isDestructiveAction(facts) || isAiAction(facts)
      ? [] : [{ raw, name: facts.names[0] ?? '', backendNodeId: element.backendNodeId }];
  });
  // ISKIP と同じ作り: 共通の枠の中の物は、画面の path を入れない枠の鍵。ほかは data を除いた path の鍵（読めなければ、枠の外とする）。
  const frames = kept.length === 0 ? null : await readElementsInIsolatedWorld(page, readLayoutFramesInPage, LAYOUT_FRAME_INPUT, openReadDeadline(),
    { argumentElements: kept.map(({ backendNodeId }) => backendNodeId) });
  const frameValue = frames?.status === 'READ' && typeof frames.value === 'object' && frames.value !== null ? frames.value as Record<string, unknown> : null;
  const items: unknown = frameValue?.['items'];
  const frameFacts: unknown = frameValue?.['frames'];
  let location: { readonly origin: string; readonly path: string } | null = null;
  try {
    const url = new URL(page.url());
    location = { origin: url.origin, path: url.pathname };
  } catch {
    location = null;
  }
  const placeKey = location === null ? null
    : dataFreePathKeyOf(DIALOG_FOCUS_PATH_FORMAT, location) ?? createSha256Fingerprint(JSON.stringify([DIALOG_FOCUS_PATH_FORMAT, location.origin, location.path]));
  const ordinals = new Map<string, number>();
  return kept.map(({ raw, name, backendNodeId }, at) => {
    const item: unknown = Array.isArray(items) && items.length === kept.length ? items[at] : null;
    const landmarks: unknown = typeof item === 'object' && item !== null ? (item as Record<string, unknown>)['landmarks'] : null;
    const frame: unknown = typeof item === 'object' && item !== null ? (item as Record<string, unknown>)['frame'] : null;
    const layoutKey = Array.isArray(frameFacts) && Array.isArray(landmarks) && landmarks.length > 0 && landmarks.every((landmark) => typeof landmark === 'string')
      && typeof frame === 'number' && Number.isSafeInteger(frame) && frame >= 0
      ? createSha256Fingerprint(JSON.stringify([DIALOG_FOCUS_LAYOUT_FORMAT, layoutFrameStructureKeyOf(frameFacts[frame], null, null), landmarks]))
      : null;
    const identity = [raw.tag, raw.role, raw.popup, foldNfkcCase(name)];
    const scope = layoutKey ?? placeKey;
    const ordinalKey = JSON.stringify([scope, identity]);
    const ordinal = ordinals.get(ordinalKey) ?? 0;
    ordinals.set(ordinalKey, ordinal + 1);
    return { selector: raw.selector, name, backendNodeId, keyDigest: createSha256Fingerprint(JSON.stringify([DIALOG_FOCUS_KEY_FORMAT, options.keyScope, scope, identity, ordinal])) };
  });
}

/**
 * FRET: 主の読み込みの画面の、窓を開くボタンを押して、窓を閉じた後のフォーカスの戻り先を確かめる（例外を投げない）。押す物がなければ、`pressableCount` が 0 の
 * 記録（「押す物なし」）を返す。
 */
export async function checkDialogFocus(page: DialogCheckPage, options: DialogFocusCheckOptions): Promise<DialogFocusEvidence> {
  const track = options.track ?? (<T>(work: Promise<T>): Promise<T> => work);
  const { signal } = options;
  const settleIntervalMs = options.settleIntervalMs ?? observationWindowsOrProduction(undefined).scroll.stepWaitMs;
  const items: DialogFocusItemEvidence[] = [];
  let pressableCount = 0;
  let alreadyCheckedCount = 0;
  let status: DialogFocusStatus = 'COMPLETE';
  let late = 0;
  let lateFrames = 0;
  const evidence = (): DialogFocusEvidence => Object.freeze({
    status, pressableCount, alreadyCheckedCount, items: Object.freeze([...items]), ...(late > 0 ? { lateNonReadRequestCount: late } : {}),
    ...(lateFrames > 0 ? { lateWebSocketFrameSentCount: lateFrames } : {}),
  });
  const pressables = await track(pressablesOf(page, options)).catch(() => null);
  if (pressables === null) {
    status = 'PARTIAL';
    return evidence();
  }
  pressableCount = pressables.length;
  if (pressables.length === 0) return evidence();
  const guard = options.keyPressGuard;
  if (guard === undefined || !guard.begin()) {
    status = 'KEY_GUARD_UNAVAILABLE';
    return evidence();
  }
  // fix round 5: 押した後の止めの続きの間に、前から開いていた接続が送った frame の数（確かめの終わりまで。止めない）。
  const lateFramesBefore = guard.webSocketFramesSentAfterPress();
  // 押す期間の読み取りでない要求と、押す期間の後に遅れて出た読み取りでない要求（どちらも Guard が止める）を数える。
  let nonReadRequests = 0;
  let lateNonReadRequests = 0;
  let inPress = false;
  let pressedOnce = false;
  const onRequest = (request: { method(): string }): void => {
    if (READ_METHODS.has(request.method().toUpperCase())) return;
    if (inPress) nonReadRequests += 1;
    else if (pressedOnce) lateNonReadRequests += 1;
  };
  const pressPeriod = (on: boolean): void => {
    inPress = on;
    pressedOnce ||= on;
    guard.pressPeriod(on);
    // 1 つでも押したら、押す期間の止めを page を閉じるまで続ける（押す物の間と、確かめの後に遅れて出た要求も止める）。
    if (on) guard.holdPressStop();
  };
  page.on('request', onRequest);
  const stateInput: StateInput = { stateKey: STATE_KEY, frontWindowRatio: FRONT_WINDOW_MIN_VIEWPORT_RATIO, maxSelectorDepth: MAX_SELECTOR_DEPTH };
  // 落ち着きの待ち（続けて 2 回同じ読み）。期限が来たら、確かめを終える。
  const settled = async (): Promise<RawDialogState> => {
    const reading = await settledReading(() => page.evaluate(readStateInPage, stateInput), settleIntervalMs, signal);
    if (!reading.settled) throw new Error('the dialog check did not settle before the end of the stage');
    return reading.value;
  };
  const shot = async (): Promise<EvidenceId | null> => (options.capture === undefined ? null : options.capture().catch(() => null));
  try {
    for (const pressable of pressables) {
      if (signal?.aborted === true) {
        status = 'PARTIAL';
        break;
      }
      const startPath = pathOf(page.url());
      const requestsBefore = nonReadRequests;
      const blockedBefore = guard.blocked();
      const framesBefore = guard.webSocketFramesSent();
      const located = await track(readElementsInIsolatedWorld(page, currentPathInPage, null, openReadDeadline(), { argumentElements: [pressable.backendNodeId] }));
      const path = located.status === 'READ' ? located.elements[0]?.path ?? null : null;
      const focused = path !== null && await track(page.evaluate(armInPage, { path: [...path], stateKey: STATE_KEY, frontWindowRatio: FRONT_WINDOW_MIN_VIEWPORT_RATIO }));
      const base = { selector: pressable.selector, name: pressable.name, keyDigest: pressable.keyDigest };
      const record = (
        rest: Omit<DialogFocusItemEvidence, 'selector' | 'name' | 'keyDigest' | 'nonReadRequestCount' | 'guardBlockedCount' | 'webSocketFrameSentCount'>,
      ): void => {
        const sent = nonReadRequests - requestsBefore;
        const blocked = guard.blocked() - blockedBefore;
        const frames = guard.webSocketFramesSent() - framesBefore;
        items.push(Object.freeze({
          ...base, ...rest, ...(sent > 0 ? { nonReadRequestCount: sent } : {}), ...(blocked > 0 ? { guardBlockedCount: blocked } : {}),
          ...(frames > 0 ? { webSocketFrameSentCount: frames } : {}),
        }));
      };
      const none = { focusMovedIntoWindow: null, closedBy: null, focusAfterClose: null, focusAfterCloseSelector: null } as const;
      if (!focused) {
        record({ outcome: 'NOT_FOCUSED', ...none, beforeScreenshotEvidenceId: null, afterScreenshotEvidenceId: null });
        await page.evaluate(releaseInPage, { stateKey: STATE_KEY }).catch(() => undefined);
        continue;
      }
      // 同じ物は Run で 1 回（フォーカスが当たったのを確かめた後に受け付ける。押せなかった物は受け付けない）。
      if (!options.accept(pressable.keyDigest)) {
        alreadyCheckedCount += 1;
        await page.evaluate(releaseInPage, { stateKey: STATE_KEY }).catch(() => undefined);
        continue;
      }
      const beforeShot = await shot();
      const moved = (state: RawDialogState): boolean => !state.present || pathOf(page.url()) !== startPath;
      // 押す期間（Enter を押してから、窓を閉じて落ち着くまで）は、読み取りでない要求も止める。
      pressPeriod(true);
      await track(pressDialogCheckKey(page, 'Enter'));
      const opened = await settled();
      if (moved(opened)) {
        pressPeriod(false);
        record({ outcome: 'NAVIGATED', ...none, beforeScreenshotEvidenceId: beforeShot, afterScreenshotEvidenceId: await shot() });
        status = 'NAVIGATED';
        break;
      }
      if (!opened.opened) {
        pressPeriod(false);
        record({ outcome: 'NO_WINDOW', ...none, beforeScreenshotEvidenceId: beforeShot, afterScreenshotEvidenceId: null });
        await page.evaluate(releaseInPage, { stateKey: STATE_KEY }).catch(() => undefined);
        continue;
      }
      await track(pressDialogCheckKey(page, 'Escape'));
      let closed = await settled();
      let closedBy: DialogFocusItemEvidence['closedBy'] = 'ESCAPE';
      if (!moved(closed) && closed.opened) {
        closedBy = 'NOT_CLOSABLE';
        const button = closed.windowPath === null ? null : await track(closeButtonOf(page, closed.windowPath));
        const focusedButton = button !== null && await track(readElementsInIsolatedWorld(page, focusGivenInPage, null, openReadDeadline(),
          { argumentElements: [button] })).then((outcome) => outcome.status === 'READ' && outcome.value === true);
        if (focusedButton) {
          await track(pressDialogCheckKey(page, 'Enter'));
          closed = await settled();
          if (!closed.opened) closedBy = 'CLOSE_BUTTON';
        }
      }
      pressPeriod(false);
      if (moved(closed)) {
        record({ outcome: 'NAVIGATED', ...none, beforeScreenshotEvidenceId: beforeShot, afterScreenshotEvidenceId: await shot() });
        status = 'NAVIGATED';
        break;
      }
      const focusAfterClose: DialogFocusReturn | null = closedBy === 'NOT_CLOSABLE' ? null
        : closed.active === 'TRIGGER' ? 'TRIGGER' : !closed.triggerConnected ? 'TRIGGER_GONE' : closed.active;
      record({
        outcome: 'CHECKED',
        focusMovedIntoWindow: opened.activeInWindow,
        closedBy,
        focusAfterClose,
        focusAfterCloseSelector: focusAfterClose === 'OTHER' ? closed.activeSelector : null,
        beforeScreenshotEvidenceId: beforeShot,
        afterScreenshotEvidenceId: await shot(),
      });
      await page.evaluate(releaseInPage, { stateKey: STATE_KEY }).catch(() => undefined);
      if (closedBy === 'NOT_CLOSABLE') {
        // 閉じられない窓が開いたままなので、その画面の残りは確かめない。
        status = 'NOT_CLOSABLE';
        break;
      }
    }
  } catch {
    status = 'PARTIAL';
  } finally {
    // 押す期間を外してから、キーの押下の期間を閉じる（`end` も押す期間を外す）。
    pressPeriod(false);
    await page.evaluate(releaseInPage, { stateKey: STATE_KEY }).catch(() => undefined);
    guard.end();
    page.off('request', onRequest);
  }
  late = lateNonReadRequests;
  lateFrames = guard.webSocketFramesSentAfterPress() - lateFramesBefore;
  return evidence();
}

/**
 * 窓（位置）の中の閉じるボタンを、通知の枠の閉じるボタンの判定（`isCloseButton` の 1 か所）で選ぶ（なければ `null`）。送信ボタン・押すと移る物・削除の物を閉じる物・
 * 削除に関する操作（削除の確かめの窓の中のボタンを含む）は選ばない。
 */
async function closeButtonOf(page: DialogCheckPage, windowPath: readonly number[]): Promise<number | null> {
  const read = await readElementsInIsolatedWorld(page, closeButtonsInPage, {
    path: windowPath, selector: CLOSE_BUTTON_PRESSABLE_SELECTOR, criteria: CLOSE_BUTTON_FACTS_CRITERIA,
  }, openReadDeadline());
  const value = read.status === 'READ' && typeof read.value === 'object' && read.value !== null ? read.value as Record<string, unknown> : null;
  const facts = Array.isArray(value?.['facts']) ? value['facts'] as readonly PressableButtonFacts[] : [];
  const baseUrl = typeof value?.['baseUrl'] === 'string' ? value['baseUrl'] : '';
  if (read.status !== 'READ' || facts.length !== read.elements.length) return null;
  const index = facts.findIndex((button) => !button.disabled && destructiveActionFactsFrom(button.destructive) !== null && isCloseButton(button, [], baseUrl));
  return index < 0 ? null : read.elements[index]?.backendNodeId ?? null;
}

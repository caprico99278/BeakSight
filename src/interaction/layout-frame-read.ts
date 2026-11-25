// 共通の枠の部分の読み取りの 1 か所（FRET の設計書 `doc/design/2026-11-24-beaksight-dialog-focus-return-design.md` の設計変更履歴の 2 行目）。
// - 操作さがしの probe（`src/interaction/submission-probe.ts`。送信ボタンの共通の枠の鍵（SLK-1）と、入力の確かめの欄の枠の鍵（ISKIP））と、点検の段の窓を開く
//   ボタンの確かめ（`src/interaction/dialog-focus-check.ts`。FRET）が、同じ読み取りと同じ基準を使う（写しを作らない）。
// - 読み取りは isolated world の要素の橋渡し（`readElementsInIsolatedWorld` の `argumentElements`）で渡した要素について行う（ページに何も書かない。文字の値は
//   読まない）。鍵の組み立て（純粋）は `src/discovery/submission-probe-contracts.ts` の `layoutFrameStructureKeyOf`。
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';
import { composeInPage, type LayoutLandmarkCriteria, type StandardReaders, type StateFieldCriteria } from '../browser/in-page-readers.js';
import { CANDIDATE_FIELD_TYPES } from '../discovery/candidate-contracts.js';
import type { InPageElementsResult } from '../discovery/isolated-read.js';
import { SCOPED_LANDMARK_NAMES, SECTIONING_SCOPE_SELECTOR } from './notification-overlay.js';

/** COV-1: 状態の構造の鍵と、枠の部分の事実で読む欄の selector。 */
export const FIELD_SELECTOR = 'input, textarea, select';

/**
 * DEF-208-4（A）: 枠の目印にする要素の名前と role、本文の印（その中のボタンは枠のボタンにしない）にする要素の名前と role。NO-2（ARIA の決まり）: 区分の中では
 * landmark にならない要素の名前と、その区分の selector（通知の枠の見分け方と同じ定義）。
 */
export const LAYOUT_LANDMARK_INPUT: LayoutLandmarkCriteria = Object.freeze({
  layoutNames: Object.freeze(['nav', 'aside', 'header', 'footer']),
  layoutRoles: Object.freeze(['navigation', 'banner', 'complementary', 'contentinfo']),
  bodyNames: Object.freeze(['main', 'dialog', 'form']),
  bodyRoles: Object.freeze(['main', 'dialog', 'alertdialog']),
  scopedNames: SCOPED_LANDMARK_NAMES,
  sectioningScopeSelector: SECTIONING_SCOPE_SELECTOR,
});

/** SLK-1: 共通の枠の部分の事実の読み取りの入力（枠の目印の基準と、見える欄の基準）。 */
export interface LayoutFrameInput {
  readonly layout: LayoutLandmarkCriteria;
  readonly fields: StateFieldCriteria;
}

export const LAYOUT_FRAME_INPUT: LayoutFrameInput = Object.freeze({
  layout: LAYOUT_LANDMARK_INPUT,
  fields: Object.freeze({ visibilityOptions: VISIBILITY_CHECK_OPTIONS, fieldSelector: FIELD_SELECTOR, fieldTypes: CANDIDATE_FIELD_TYPES }),
});

/**
 * DEF-208-4（A）・SLK-1（網羅の設計書 6 章の 2026-11-16）: 渡した要素ごとの、祖先の枠の目印（部品 `R.layoutLandmarksOf`）と、共通の枠の部分（目印の最も外の
 * 要素）の番号（なければ -1）、枠の部分ごとの見える欄と見出しの段・リンクの移る先の path・開閉の印を読む（ページの中で動く。標準の getter とメソッドで読み、
 * ページに何も書かない。文字の値は読まない）。
 */
export const readLayoutFramesInPage = composeInPage((R: StandardReaders, input: LayoutFrameInput, given?: readonly Element[]): InPageElementsResult => {
  const isConnected = R.standardGetter<boolean>(Node.prototype, 'isConnected');
  const frames: Element[] = [];
  const items = (given ?? []).map((element) => {
    if (!(element instanceof Element) || !isConnected(element)) return { landmarks: [], frame: -1 };
    const { landmarks, frame } = R.layoutLandmarksOf(element, input.layout);
    if (frame === null) return { landmarks, frame: -1 };
    let at = frames.indexOf(frame);
    if (at === -1) at = frames.push(frame) - 1;
    return { landmarks, frame: at };
  });
  // REV-SD の M-4: 枠の中のリンクの移る先の path（文字の値は読まない。受け入れの判定はしない）と、開閉の印（`aria-expanded`）のある要素があるか。
  const baseUrl = R.documentProperty<string>('URL');
  const linkPathsOf = (frame: Element): string[] => {
    const paths: string[] = [];
    const anchors = Element.prototype.querySelectorAll.call(frame, 'a[href]');
    const length = R.standardGetter<number>(NodeList.prototype, 'length')(anchors);
    for (let index = 0; index < length; index += 1) {
      const anchor = NodeList.prototype.item.call(anchors, index) as Element | null;
      const href: unknown = anchor === null ? null : Element.prototype.getAttribute.call(anchor, 'href');
      if (typeof href !== 'string') continue;
      try {
        paths.push(new URL(href, baseUrl).pathname);
      } catch {
        // 解けない移る先は入れない。
      }
    }
    return paths;
  };
  return {
    value: {
      items,
      frames: frames.map((frame) => ({
        fields: R.visibleStateFieldsIn(frame, input.fields), headings: R.visibleHeadingLevelsIn(frame, input.fields.visibilityOptions),
        linkPaths: linkPathsOf(frame), expandToggle: Element.prototype.querySelector.call(frame, '[aria-expanded]') !== null,
      })),
    },
    elements: [],
  };
});
